import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DockParticipant, easeOnCurve} from '../notchDock.js';
import {DESIGN} from '../designTokens.js';
import {isActorWithin} from '../dockModel.js';
import {metadataToState, positionAt, artVariantUrl, accentFromPixels, formatTime} from './spotifyModel.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const BUS = 'org.mpris.MediaPlayer2.spotify';
const PATH = '/org/mpris/MediaPlayer2';
const IFACE = 'org.mpris.MediaPlayer2.Player';
// Position is deliberately not declared: Spotify never notifies it, so a cached copy would go stale.
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`<node><interface name="${IFACE}">
    <method name="PlayPause"/><method name="Next"/><method name="Previous"/>
    <signal name="Seeked"><arg type="x" name="Position"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
</interface></node>`);
const APP_IDS = ['spotify.desktop', 'com.spotify.Client.desktop', 'spotify_spotify.desktop'];
const BAR_PERIODS = [420, 560, 380, 500];
const BAR_PAUSED = [0.4, 0.75, 1.0, 0.6];
// ~15 fps (boring.notch's visualizer rate). See _updateBars for why this is a timer, not a transition.
const BAR_FRAME_MS = 66;
const ICON_SKIP = 20;
const ICON_PLAY = 16;
const ICON_FALLBACK = 16;
const ART_SIZE = 8;
const SEEK_DEBOUNCE_MS = 300;
const IDLE_MS = 8000;
const POSITION_REREAD_TICKS = 5;
const ACCENT_CACHE_MAX = 32;
const TIMERS = ['_tick', '_peekTimer', '_seekTimer', '_closingTimer', '_barTimer'];

export class SpotifyModule {
    constructor({settings, uuid, cacheDir}) {
        this._settings = settings;
        this._artPath = GLib.build_filenamev([cacheDir, 'art.jpg']);
        this._signals = [];
        this._shellEnding = false;
        this._running = false;
        this._expanded = false;
        this._renderedExpanded = false;
        this._track = metadataToState(null);
        this._status = 'Stopped';
        this._canNext = this._canPrev = false;
        this._position = {positionUs: 0, atUs: 0};
        this._artFile = null;
        this._accent = null;
        this._accentCache = new Map();
        this._ticks = 0;
        this._peekUntil = this._peekLeft = 0;
        this._ui = {};
        this._cancellable = new Gio.Cancellable();
        this._artCancellable = null;
        this._soup = new Soup.Session({timeout: 10});
        // The root takes no focus or events itself: St marks that :insensitive and keys die there.
        this.root = new St.BoxLayout({vertical: true, style_class: 'notci-module notci-spotify',
            reactive: false, can_focus: false, clip_to_allocation: true, accessible_name: 'Spotify 재생 정보'});
        global.focus_manager.add_group(this.root);
        this._dock = new DockParticipant({id: `${uuid}/spotify`, content: this.root, order: 2,
            monitor: () => Main.layoutManager.primaryMonitor, triggerActor: () => null,
            onOutside: () => this.collapse(), onYield: () => this.collapse(),
            onShellShutdown: () => this._beginShellShutdown()});
        this._connect(this.root, 'notify::mapped', () => this._updateBars());
        this._connect(Main.layoutManager, 'monitors-changed', () => { this._updateBars(); this._visibility(); });
        this._connect(global.display, 'in-fullscreen-changed', () => { this._updateBars(); this._visibility(); });
        this._connect(St.Settings.get(), 'notify::enable-animations', () => this._updateBars());
        this._connect(Main.sessionMode, 'updated', () => { this._updateBars(); this._visibility(); });
        this._connect(Main.overview, 'showing', () => { this.collapse(); this._visibility(); });
        this._connect(Main.overview, 'hidden', () => this._visibility());
        settings.connectObject('changed::spotify-enabled', () => this._onEnabledChanged(),
            'changed::spotify-accent', () => this._redraw(), this);
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, BUS, Gio.BusNameWatcherFlags.NONE,
            () => this._onAppeared(), () => this._onVanished());
    }

    // Public: manual expand (idle-collapses after IDLE_MS, like a long-pressed Live Activity),
    // track-change peek, collapse. The compact pill toggles.
    expand() {
        if (!this._visible() || !this._dock?.claim(100)) return;
        this._clearPeek();
        if (!this._expanded) {
            this._expanded = true;
            this._render();
            this._readPosition();
        }
        this._armPeek(IDLE_MS);
    }

    toggle() {
        if (this._expanded) this.collapse(); else this.expand();
    }

    peek() {
        if (this._expanded || !this._visible() || !this._dock?.claim(40)) return;
        this._expanded = true;
        this._render();
        this._readPosition();
        this._armPeek(this._settings.get_int('spotify-peek-seconds') * 1000);
    }

    collapse() {
        this._clearPeek();
        if (!this._expanded) return;
        this._expanded = false;
        this._render();
    }

    // Capture hook: state without D-Bus. artFile is an absolute path of an already-saved image.
    applyDebugState({title = '', artists = [], album = '', lengthUs = 0, positionUs = 0, playing = false, artFile = null}) {
        this._running = true;
        this._track = {trackId: 'debug', title, artists, album, lengthUs, artUrl: ''};
        this._status = playing ? 'Playing' : 'Paused';
        this._canNext = this._canPrev = true;
        this._position = {positionUs, atUs: GLib.get_monotonic_time()};
        if (artFile) {
            this._artFile = artFile;
            const [ok, bytes] = GLib.file_get_contents(artFile);
            if (ok) this._accentFor(artFile, GLib.Bytes.new(bytes)).then(accent => { this._accent = accent; this._redraw(); });
        }
        this._render();
        this._syncTick();
    }

    destroy() {
        if (this._watchId) Gio.bus_unwatch_name(this._watchId);
        this._watchId = 0;
        this._cancellable.cancel();
        this._artCancellable?.cancel();
        this._dropProxy();
        for (const name of TIMERS) this._clearTimer(name);
        this._settings?.disconnectObject(this);
        for (const [object, id] of this._signals) {
            try { object.disconnect(id); } catch (_error) { /* disposed during Shell shutdown */ }
        }
        this._signals = [];
        this._dock?.destroy();
        this._dock = null;
        try { global.focus_manager.remove_group(this.root); } catch (_error) {}
        if (!this._shellEnding && this.root) {
            try { this.root.destroy(); } catch (_error) {}
        }
        this.root = this._settings = this._soup = this._ui = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _clearTimer(name) {
        if (this[name]) GLib.source_remove(this[name]);
        this[name] = 0;
    }

    _beginShellShutdown() {
        this._shellEnding = true;
        for (const name of TIMERS) this._clearTimer(name);
    }

    _visible() {
        return this._running && !this._shellEnding && Boolean(this._settings?.get_boolean('spotify-enabled'));
    }

    // ---- D-Bus ----

    _onAppeared() {
        if (this._proxy || this._shellEnding) return;
        new PlayerProxy(Gio.DBus.session, BUS, PATH, (proxy, error) => {
            if (error) {
                if (!this._cancellable.is_cancelled()) console.warn(`[notci] Spotify proxy failed: ${error.message}`);
                return;
            }
            if (this._shellEnding || !this.root) return;
            this._proxy = proxy;
            this._running = true;
            proxy.connectObject('g-properties-changed', (_proxy, changed) => this._onProperties(changed.recursiveUnpack()), this);
            this._seekedId = proxy.connectSignal('Seeked', () => this._onSeeked());
            const cached = name => proxy.get_cached_property(name)?.recursiveUnpack();
            this._onProperties({PlaybackStatus: cached('PlaybackStatus') ?? 'Stopped', Metadata: cached('Metadata') ?? {},
                CanGoNext: Boolean(cached('CanGoNext')), CanGoPrevious: Boolean(cached('CanGoPrevious'))}, true);
        }, this._cancellable, Gio.DBusProxyFlags.NONE);
    }

    _onVanished() {
        this._dropProxy();
        this._artCancellable?.cancel();
        this._running = false;
        this._track = metadataToState(null);
        this._status = 'Stopped';
        this._artFile = this._accent = null;
        this._clearTimer('_seekTimer');
        this.collapse();
        this._syncTick();
        this._updateBars();
        this._visibility();
    }

    _dropProxy() {
        if (!this._proxy) return;
        try {
            this._proxy.disconnectObject(this);
            if (this._seekedId) this._proxy.disconnectSignal(this._seekedId);
        } catch (_error) {}
        this._seekedId = 0;
        this._proxy = null;
    }

    _onProperties(props, initial = false) {
        const previous = this._track;
        if ('Metadata' in props) this._track = metadataToState(props.Metadata);
        if ('PlaybackStatus' in props) this._status = String(props.PlaybackStatus);
        if ('CanGoNext' in props) this._canNext = Boolean(props.CanGoNext);
        if ('CanGoPrevious' in props) this._canPrev = Boolean(props.CanGoPrevious);
        const trackChanged = this._track.trackId !== previous.trackId;
        if (trackChanged) this._position = {positionUs: 0, atUs: GLib.get_monotonic_time()};
        if (trackChanged || this._track.artUrl !== previous.artUrl) this._fetchArt();
        if (trackChanged || 'PlaybackStatus' in props) this._readPosition();
        if (initial || !this.root?.get_n_children()) this._render(); else this._redraw();
        this._syncTick();
        this._updateBars();
        if (trackChanged && !initial && !this._expanded && this._status === 'Playing') this.peek();
    }

    _onSeeked() {
        this._clearTimer('_seekTimer');
        this._seekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEEK_DEBOUNCE_MS, () => {
            this._seekTimer = 0;
            this._readPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _readPosition() {
        if (!this._proxy) return;
        try {
            const result = await Gio.DBus.session.call(BUS, PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [IFACE, 'Position']), new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE, 1000, this._cancellable);
            const [positionUs] = result.recursiveUnpack();
            this._position = {positionUs: Number(positionUs) || 0, atUs: GLib.get_monotonic_time()};
            this._redrawProgress();
        } catch (error) {
            if (!this._cancellable.is_cancelled() && this._proxy) console.warn(`[notci] Spotify position read failed: ${error.message}`);
        }
    }

    // 1 Hz redraw only while the card is open and playing; every 5th tick re-reads the real position.
    _syncTick() {
        const wanted = this._expanded && this._status === 'Playing' && this._visible();
        if (wanted === Boolean(this._tick)) return;
        if (!wanted) { this._clearTimer('_tick'); return; }
        this._ticks = 0;
        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (++this._ticks % POSITION_REREAD_TICKS === 0) this._readPosition();
            this._redrawProgress();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---- Album art and accent ----

    _fetchArt() {
        this._artCancellable?.cancel();
        const cancellable = this._artCancellable = new Gio.Cancellable();
        const url = this._track.artUrl;
        if (!url) { this._artFile = null; this._accent = null; this._redraw(); return; }
        this._downloadArt(url, cancellable).catch(error => {
            if (!cancellable.is_cancelled()) console.warn(`[notci] Spotify art failed for ${this._track.trackId}: ${error.message}`);
        });
    }

    async _downloadArt(url, cancellable) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const variant = artVariantUrl(url, scale);
        let bytes = await this._get(variant, cancellable);
        if (!bytes && variant !== url) bytes = await this._get(url, cancellable);
        if (!bytes) throw new Error('album art unavailable');
        await Gio.File.new_for_path(this._artPath).replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, cancellable);
        const accent = await this._accentFor(url, bytes);
        if (cancellable.is_cancelled() || !this.root) return;
        this._accent = accent;
        this._artFile = this._artPath;
        this._redraw();
    }

    async _get(url, cancellable) {
        const message = Soup.Message.new('GET', url);
        if (!message) return null;
        const bytes = await this._soup.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        return message.get_status() === Soup.Status.OK ? bytes : null;
    }

    // Decoded at 8×8 only; the full image never lives in JS.
    async _accentFor(url, bytes) {
        if (this._accentCache.has(url)) return this._accentCache.get(url);
        let accent = DESIGN.color.brandSpotify;
        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
            const pixbuf = await new Promise((resolve, reject) =>
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, ART_SIZE, ART_SIZE, false, null, (_source, result) => {
                    try { resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result)); } catch (error) { reject(error); }
                }));
            accent = accentFromPixels(pixbuf.get_pixels(), pixbuf.get_width(), pixbuf.get_height(),
                pixbuf.get_rowstride(), pixbuf.get_n_channels(), DESIGN.color.brandSpotify);
        } catch (error) {
            console.warn(`[notci] Spotify accent decode failed: ${error.message}`);
        }
        if (this._accentCache.size >= ACCENT_CACHE_MAX) this._accentCache.delete(this._accentCache.keys().next().value);
        this._accentCache.set(url, accent);
        return accent;
    }

    _accentColor() {
        return (this._settings?.get_boolean('spotify-accent') && this._accent) || DESIGN.color.brandSpotify;
    }

    // ---- Peek timer (paused while the card is hovered) ----

    _armPeek(ms) {
        this._clearTimer('_peekTimer');
        this._peekLeft = 0;
        this._peekUntil = GLib.get_monotonic_time() + ms * 1000;
        this._peekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._peekTimer = 0;
            this.collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearPeek() {
        this._clearTimer('_peekTimer');
        this._peekUntil = this._peekLeft = 0;
    }

    _onCardHover(hovered) {
        if (!this._peekUntil) return;
        if (hovered) {
            this._peekLeft ||= Math.max(1, Math.round((this._peekUntil - GLib.get_monotonic_time()) / 1000));
            this._clearTimer('_peekTimer');
        } else if (this._peekLeft && !this._peekTimer) {
            this._peekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DESIGN.motion.hoverResume, () => {
                this._peekTimer = 0;
                this._armPeek(this._peekLeft);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // ---- Rendering ----

    _onEnabledChanged() {
        if (!this._visible()) this.collapse();
        this._syncTick();
        this._visibility();
    }

    _visibility() {
        if (this._shellEnding || !this._dock) return;
        const expanded = this._expanded;
        const visible = this._visible() && !Main.overview.visible && !Main.sessionMode.isLocked &&
            !Main.layoutManager.primaryMonitor?.inFullscreen;
        this._dock.update({width: expanded ? DESIGN.geometry.expandedWide : DESIGN.geometry.spotifyCompact,
            height: expanded ? this._expandedHeight ?? DESIGN.geometry.spotifyExpandedHeight :
                this._compactHeight ?? DESIGN.control.compactHeight,
            visible, expanded});
    }

    _render(afterCollapse = false) {
        if (this._shellEnding || !this.root) return;
        const expanded = this._expanded;
        if (this._closingTimer) {
            if (!expanded) { this._visibility(); return; }
            this._clearTimer('_closingTimer');
            this._renderedExpanded = false;
        }
        const opening = expanded && !this._renderedExpanded;
        const closing = !expanded && this._renderedExpanded;
        const focusWasInside = isActorWithin(global.stage.get_key_focus(), this.root);
        if (closing && focusWasInside) global.stage.set_key_focus(null);
        if (closing && !afterCollapse && St.Settings.get().enable_animations) {
            // Expanded content fades as one piece while the slab retracts and clips it.
            for (const child of this.root.get_children()) {
                const descendants = [child];
                while (descendants.length) {
                    const actor = descendants.pop();
                    actor.reactive = false;
                    actor.can_focus = false;
                    descendants.push(...actor.get_children());
                }
                easeOnCurve(child, {opacity: 0, duration: DESIGN.motion.micro});
            }
            this._visibility();
            const rebuildAfter = this._dock.state.visible ? DESIGN.motion.micro : DESIGN.motion.collapse;
            this._closingTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, rebuildAfter, () => {
                this._closingTimer = 0;
                this._render(true);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this._ui = {};
        for (const child of this.root.get_children()) child.destroy();
        const child = expanded ? this._buildCard() : this._buildCompact();
        this._redraw();
        // The first show attaches the tree to the island; only then can St style it. An unmapped
        // tree measures without its CSS until styled, and the dock fixes the root's own size,
        // so the child is styled and measured, and the slab re-fitted when the design height is off.
        this._visibility();
        if (this.root.get_stage()) {
            const ensureStyle = actor => {
                actor.ensure_style?.();
                actor.get_children().forEach(ensureStyle);
            };
            ensureStyle(this.root);
            const width = expanded ? DESIGN.geometry.expandedWide : DESIGN.geometry.spotifyCompact;
            const [, natural] = child.get_preferred_height(width);
            if (expanded) {
                this._expandedHeight = Math.ceil(natural);
                this._ui.trackWidth = width - this._ui.card.get_theme_node().get_horizontal_padding();
                this._redrawProgress();
            } else {
                this._compactHeight = Math.max(DESIGN.control.compactHeight, Math.ceil(natural));
            }
            this._visibility();
        }
        // Entrances start only now that the slab shows the attached tree.
        if (St.Settings.get().enable_animations) {
            const drop = {opacity: 0, translation_y: -DESIGN.motion.contentShift};
            const settled = {opacity: 255, translation_y: 0};
            const entrances = [];
            if (opening) {
                entrances.push([this._ui.header, {...settled, duration: DESIGN.motion.primaryDuration, delay: DESIGN.motion.primaryDelay}]);
                entrances.push([this._ui.body, {...settled, duration: DESIGN.motion.secondaryDuration, delay: DESIGN.motion.secondaryDelay}]);
            } else if (closing && this._dock.state.visible) {
                entrances.push([child, {...settled, duration: DESIGN.motion.primaryDuration}]);
            }
            for (const [actor, to] of entrances) {
                Object.assign(actor, drop);
                easeOnCurve(actor, to);
            }
        }
        this._renderedExpanded = expanded;
        this._updateBars();
        if (expanded && focusWasInside) (this._ui.play ?? this._ui.button)?.grab_key_focus();
    }

    _buildCompact() {
        const button = new St.Button({style_class: 'notci-compact-module', can_focus: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const row = new St.BoxLayout({style_class: 'notci-spotify-compact', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._artBox('notci-art-compact'));
        row.add_child(this._bars());
        button.set_child(row);
        button.connect('clicked', () => this.toggle());
        this.root.add_child(button);
        this._ui.button = button;
        return button;
    }

    _buildCard() {
        const card = new St.BoxLayout({vertical: true, style_class: 'notci-card', reactive: true, track_hover: true,
            x_expand: true});
        card.connect('notify::hover', () => this._onCardHover(card.hover));
        // The card itself is the island: a click on its empty area folds it back, buttons act first.
        card.connect('button-release-event', (_actor, event) => {
            // GNOME 50: event.get_source() is always null; the stage knows the actor under the event.
            let source = null;
            try { source = global.stage.get_event_actor(event); } catch (_error) {}
            if (source !== card && source !== header && source !== column && source !== this._ui.body &&
                source !== this._ui.title && source !== this._ui.artist && source !== this._ui.album)
                return Clutter.EVENT_PROPAGATE;
            this.collapse();
            return Clutter.EVENT_STOP;
        });
        const header = new St.BoxLayout({style_class: 'notci-card-row', x_expand: true});
        const art = this._artBox('notci-art', true);
        art.connect('clicked', () => APP_IDS.map(id => Shell.AppSystem.get_default().lookup_app(id)).find(Boolean)?.activate());
        header.add_child(art);
        const column = new St.BoxLayout({vertical: true, style_class: 'notci-card-column', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._ui.title = this._label('notci-title');
        this._ui.artist = this._label('notci-accent-text');
        this._ui.album = this._label('notci-caption');
        for (const label of [this._ui.title, this._ui.artist, this._ui.album]) column.add_child(label);
        header.add_child(column);
        header.add_child(this._bars());
        card.add_child(header);
        const body = new St.BoxLayout({vertical: true, style_class: 'notci-card-column', x_expand: true});
        const track = new St.Widget({style_class: 'notci-progress-track', x_expand: true});
        this._ui.fill = new St.Widget({style_class: 'notci-progress-fill'});
        track.add_child(this._ui.fill);
        body.add_child(track);
        const times = new St.BoxLayout({x_expand: true});
        this._ui.elapsed = this._label('notci-caption notci-tnum', true);
        this._ui.remaining = this._label('notci-caption notci-tnum');
        times.add_child(this._ui.elapsed);
        times.add_child(this._ui.remaining);
        body.add_child(times);
        const controls = new St.BoxLayout({style_class: 'notci-controls', x_align: Clutter.ActorAlign.CENTER});
        this._ui.prev = this._control('media-skip-backward-symbolic', ICON_SKIP, '이전 곡', () => this._proxy?.PreviousAsync());
        this._ui.playIcon = new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: ICON_PLAY});
        this._ui.play = this._control(new St.Bin({style_class: 'notci-spotify-play', child: this._ui.playIcon,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}), 0, '재생/일시정지',
        () => this._proxy?.PlayPauseAsync());
        this._ui.next = this._control('media-skip-forward-symbolic', ICON_SKIP, '다음 곡', () => this._proxy?.NextAsync());
        for (const control of [this._ui.prev, this._ui.play, this._ui.next]) controls.add_child(control);
        body.add_child(controls);
        card.add_child(body);
        this.root.add_child(card);
        Object.assign(this._ui, {card, header, body, track});
        return card;
    }

    _label(styleClass, expand = false) {
        const label = new St.Label({style_class: styleClass, x_align: Clutter.ActorAlign.START, x_expand: expand,
            y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        return label;
    }

    _control(iconOrChild, iconSize, accessibleName, action) {
        const child = typeof iconOrChild === 'string' ? new St.Icon({icon_name: iconOrChild, icon_size: iconSize}) : iconOrChild;
        const button = new St.Button({style_class: 'notci-control', can_focus: true, accessible_name: accessibleName, child});
        button.connect('clicked', () => Promise.resolve(action()).catch(error =>
            console.warn(`[notci] Spotify control failed: ${error.message}`)));
        return button;
    }

    // Art box: background-image set by style once a download succeeded; a generic icon until then.
    _artBox(styleClass, clickable = false) {
        const box = clickable ? new St.Button({style_class: styleClass, can_focus: true, accessible_name: 'Spotify 열기'}) :
            new St.Bin({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        (this._ui.arts ??= []).push(box);
        return box;
    }

    _bars() {
        const box = new St.BoxLayout({style_class: 'notci-bars', y_align: Clutter.ActorAlign.CENTER});
        this._ui.bars = BAR_PERIODS.map(() => {
            const bar = new St.Widget({style_class: 'notci-bar'});
            bar.set_pivot_point(0.5, 1);
            box.add_child(bar);
            return bar;
        });
        return box;
    }

    // Updates the live bits in place; the tree is rebuilt only on expand/collapse.
    _redraw() {
        const ui = this._ui;
        if (!ui || !this.root || this._shellEnding) return;
        const {title, artists, album} = this._track;
        const artist = artists.join(', ');
        const accent = this._accentColor();
        const playing = this._status === 'Playing';
        for (const box of ui.arts ?? []) {
            box.style = this._artFile ? `background-image: url("file://${this._artFile}");` : '';
            if (this._artFile) {
                box.set_child(null);
            } else if (!box.get_child()) {
                box.set_child(new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: ICON_FALLBACK,
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
            }
        }
        for (const bar of ui.bars ?? []) bar.set_style(`background-color: ${accent};`);
        if (ui.button) ui.button.accessible_name = [title, artist].filter(Boolean).join(' · ') || 'Spotify';
        if (!ui.card) return;
        ui.title.text = title || '제목 없음';
        ui.artist.text = artist;
        ui.artist.set_style(`color: ${accent};`);
        ui.album.text = album;
        ui.fill.set_style(`background-color: ${accent};`);
        this._redrawProgress();
        ui.playIcon.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        ui.prev.reactive = ui.prev.can_focus = this._canPrev;
        ui.next.reactive = ui.next.can_focus = this._canNext;
    }

    _redrawProgress() {
        const ui = this._ui;
        if (!ui?.card || this._shellEnding) return;
        const {lengthUs} = this._track;
        const position = positionAt({...this._position, playing: this._status === 'Playing', lengthUs}, GLib.get_monotonic_time());
        const trackWidth = ui.track.width || ui.trackWidth || 0;
        ui.fill.set_width(lengthUs > 0 ? Math.round(trackWidth * position / lengthUs) : 0);
        ui.elapsed.text = formatTime(position);
        ui.remaining.text = lengthUs > 0 ? `-${formatTime(lengthUs - position)}` : '';
    }

    // Bars animate only while playing, mapped, animations on, not fullscreen, not locked.
    // A ~15 fps timer sets scale-y directly. An infinite Clutter.PropertyTransition repaints the stage on
    // every vsync (120 Hz on this panel): measured 2026-10-23, notci took ~12% of a core in the real
    // session and 6% in the 60 Hz harness while music played; 15 fps cuts the frames 8x. Same motion:
    // EASE_IN_OUT_SINE between 0.3 and 1.0, auto-reversing every BAR_PERIODS[i] ms.
    _updateBars() {
        const bars = this._ui?.bars ?? [];
        let run = false;
        try {
            run = bars.length > 0 && this._status === 'Playing' && this.root.mapped && St.Settings.get().enable_animations &&
                !Main.layoutManager.primaryMonitor?.inFullscreen && !Main.sessionMode.isLocked;
        } catch (_error) {}
        if (!run) {
            this._clearTimer('_barTimer');
            bars.forEach((bar, i) => { bar.scale_y = BAR_PAUSED[i]; });
            return;
        }
        if (this._barTimer) return;
        const start = GLib.get_monotonic_time();
        const step = () => {
            const elapsed = (GLib.get_monotonic_time() - start) / 1000;
            (this._ui?.bars ?? []).forEach((bar, i) => {
                const phase = (elapsed / BAR_PERIODS[i]) % 2;
                const progress = phase < 1 ? phase : 2 - phase;
                bar.scale_y = 0.3 + 0.7 * (1 - Math.cos(Math.PI * progress)) / 2;
            });
        };
        step();
        this._barTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BAR_FRAME_MS, () => {
            step();
            return GLib.SOURCE_CONTINUE;
        });
    }
}

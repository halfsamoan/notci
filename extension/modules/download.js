import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DockParticipant} from '../notchDock.js';
import {DESIGN} from '../designTokens.js';
import {createRing, setRing} from './ring.js';
import {isTempDownload, isFirefoxTemp, firefoxProfileDirs, firefoxTotal, pickDownload, pillView} from './downloadModel.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');

const ICON = 16;
const DONE_MS = 2000;
// Firefox writes downloads.json ~1.5 s after a download starts and not again until it stops.
const FIREFOX_READ_TICKS = 3;
const FIREFOX_INIS = ['snap/firefox/common/.mozilla/firefox', '.mozilla/firefox', '.config/mozilla/firefox']
    .map(dir => GLib.build_filenamev([GLib.get_home_dir(), dir]));
// Widest text of each pill mode, measured once so the island never re-snaps while bytes arrive.
const WIDEST = {ring: '100%', bytes: '00.00 GB'};
const TONES = {stalled: 'notci-download-stalled', done: 'notci-download-done'};

function ensureStyle(actor) {
    actor.ensure_style?.();
    actor.get_children().forEach(ensureStyle);
}

// Downloads of 0.7 GB or more as a compact pill: icon + ring + percent (size known) or GB so far.
// Watches the download folder's .part/.crdownload files; a 1 s tick runs only while one exists.
export class DownloadModule {
    constructor({settings, uuid}) {
        this._settings = settings;
        this._entries = new Map();   // temp path -> {path, received, total, lastGrowth, firefox}
        this._shellEnding = false;
        this._tick = this._doneTimer = 0;
        this._ticks = 0;
        this._done = false;
        this._widths = {};
        this._view = null;
        this._dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
        this._cancellable = new Gio.Cancellable();
        this.root = new St.BoxLayout({style_class: 'notci-module notci-download', reactive: false, can_focus: false,
            clip_to_allocation: true, accessible_name: '다운로드 진행'});
        global.focus_manager.add_group(this.root);
        this._dock = new DockParticipant({id: `${uuid}/download`, content: this.root, order: 6,
            monitor: () => Main.layoutManager.primaryMonitor, triggerActor: () => null,
            onShellShutdown: () => this._beginShellShutdown()});
        this._build();
        global.display.connectObject('in-fullscreen-changed', () => this._sync(), this);
        Main.overview.connectObject('showing', () => this._sync(), 'hidden', () => this._sync(), this);
        Main.sessionMode.connectObject('updated', () => this._sync(), this);
        settings.connectObject('changed::download-enabled', () => this._applyEnabled(), this);
        this._applyEnabled();
    }

    collapse() {}

    // Capture hook: one synthetic download, no file behind it.
    applyDebugState({received = 0, total = 0, stalled = false} = {}) {
        const now = GLib.get_monotonic_time() / 1000;
        this._entries.set('/debug', {path: '/debug', received, total, firefox: false,
            lastGrowth: stalled ? now - 60000 : now});
        this._render();
    }

    destroy() {
        this._stopWatching();
        this._cancellable.cancel();
        for (const object of [global.display, Main.overview, Main.sessionMode, this._settings]) {
            try { object?.disconnectObject(this); } catch (_error) {}
        }
        this._dock?.destroy();
        this._dock = null;
        try { global.focus_manager.remove_group(this.root); } catch (_error) {}
        if (!this._shellEnding) {
            try { this.root?.destroy(); } catch (_error) {}
        }
        this.root = this._ui = this._settings = null;
    }

    _beginShellShutdown() {
        this._shellEnding = true;
        this._clearTimers();
    }

    _clearTimers() {
        for (const name of ['_tick', '_doneTimer']) {
            if (this[name]) GLib.source_remove(this[name]);
            this[name] = 0;
        }
    }

    _applyEnabled() {
        this._stopWatching();
        if (this._settings.get_boolean('download-enabled')) this._startWatching();
        this._render();
    }

    // ---- Folder watch ----

    _startWatching() {
        const dir = Gio.File.new_for_path(this._dir);
        try {
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch (error) {
            console.warn(`[notci] download folder watch failed: ${error.message}`);
            return;
        }
        this._monitor.connect('changed', (_monitor, file, other, event) => this._onChanged(file, other, event));
        // Downloads already running when the extension starts.
        try {
            const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let info; (info = children.next_file(null));)
                if (isTempDownload(info.get_name())) this._track(GLib.build_filenamev([this._dir, info.get_name()]));
            children.close(null);
        } catch (_error) {}
    }

    _stopWatching() {
        this._monitor?.cancel();
        this._monitor = null;
        this._entries.clear();
        this._clearTimers();
        this._done = false;
    }

    _onChanged(file, other, event) {
        const path = file.get_path();
        const E = Gio.FileMonitorEvent;
        if (event === E.CREATED || event === E.MOVED_IN) {
            if (isTempDownload(file.get_basename())) this._track(path);
        } else if (event === E.RENAMED) {
            const target = other?.get_path();
            const entry = this._entries.get(path);
            if (!entry) {
                if (target && isTempDownload(other.get_basename())) this._track(target);
                return;
            }
            const shown = pickDownload([...this._entries.values()]);
            this._entries.delete(path);
            if (target && isTempDownload(other.get_basename())) {
                // Chrome "Unconfirmed 123.crdownload" → "name.crdownload", Firefox random → final stem.
                this._entries.set(target, {...entry, path: target, firefox: isFirefoxTemp(other.get_basename())});
            } else if (target && entry === shown) {
                this._complete();
            }
            this._render();
        } else if (event === E.DELETED || event === E.MOVED_OUT) {
            // Cancelled: the temp file went without becoming the download. Said nothing about.
            if (this._entries.delete(path)) this._render();
        }
    }

    _track(path) {
        if (this._entries.has(path)) return;
        this._entries.set(path, {path, received: 0, total: 0, firefox: isFirefoxTemp(GLib.path_get_basename(path)),
            lastGrowth: GLib.get_monotonic_time() / 1000});
        this._ticks = 0;
        if (!this._tick) {
            this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                // Only the tick stops itself: clearing every timer here also killed the 2 s "done"
                // timer, and the green 완료 pill stayed until the next login (v10, 2026-10-24).
                if (!this._entries.size) {
                    this._tick = 0;
                    this._render();
                    return GLib.SOURCE_REMOVE;
                }
                this._poll().catch(error => console.warn(`[notci] download poll failed: ${error.message}`));
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    async _poll() {
        const now = GLib.get_monotonic_time() / 1000;
        const needTotals = ++this._ticks % FIREFOX_READ_TICKS === 0 &&
            [...this._entries.values()].some(entry => entry.firefox && !entry.total);
        const lists = needTotals ? await this._firefoxLists() : [];
        for (const entry of [...this._entries.values()]) {
            try {
                const info = await Gio.File.new_for_path(entry.path).query_info_async('standard::size',
                    Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable);
                const size = info.get_size();
                if (size > entry.received) entry.lastGrowth = now;
                entry.received = size;
            } catch (_error) { /* renamed or removed between events */ }
            if (entry.firefox && !entry.total)
                entry.total = lists.reduce((found, text) => found || firefoxTotal(text, entry.path), 0);
        }
        this._render();
    }

    async _firefoxLists() {
        const lists = [];
        for (const base of FIREFOX_INIS) {
            const ini = await this._read(GLib.build_filenamev([base, 'profiles.ini']));
            for (const dir of firefoxProfileDirs(ini, base)) {
                const text = await this._read(GLib.build_filenamev([dir, 'downloads.json']));
                if (text) lists.push(text);
            }
        }
        return lists;
    }

    async _read(path) {
        try {
            const [bytes] = await Gio.File.new_for_path(path).load_contents_async(this._cancellable);
            return new TextDecoder().decode(bytes);
        } catch (_error) {
            return null;
        }
    }

    // The shown download finished: the ring fills green for a moment, then the pill goes.
    _complete() {
        this._done = true;
        if (this._doneTimer) GLib.source_remove(this._doneTimer);
        this._doneTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DONE_MS, () => {
            this._doneTimer = 0;
            this._done = false;
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- View ----

    _build() {
        const button = new St.Button({style_class: 'notci-compact-module', can_focus: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const row = new St.BoxLayout({style_class: 'notci-download-compact', y_align: Clutter.ActorAlign.CENTER});
        const icon = new St.Icon({icon_name: 'folder-download-symbolic', icon_size: ICON, y_align: Clutter.ActorAlign.CENTER});
        const ring = createRing('notci-download-ring', 'notci-ring-compact');
        const label = new St.Label({style_class: 'notci-download-label notci-tnum', y_align: Clutter.ActorAlign.CENTER});
        for (const child of [icon, ring.area, label]) row.add_child(child);
        button.set_child(row);
        button.connect('clicked', () => {
            try { Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(this._dir).get_uri(), null); } catch (error) {
                console.warn(`[notci] opening the download folder failed: ${error.message}`);
            }
        });
        this.root.add_child(button);
        this._ui = {button, icon, ring, label};
    }

    _render() {
        if (this._shellEnding || !this._ui) return;
        const view = this._done ? {fraction: 1, text: '완료', tone: 'done'} :
            pillView(pickDownload([...this._entries.values()]), GLib.get_monotonic_time() / 1000);
        this._view = view;
        if (view) {
            const {ring, label, icon, button} = this._ui;
            const tone = view.tone ? TONES[view.tone] : null;
            setRing(ring, view.fraction, tone, false);
            icon.style_class = tone ?? '';
            if (label.text !== view.text) label.text = view.text;
            button.accessible_name = view.fraction === null ? `다운로드 중, ${view.text} 받음` : `다운로드 ${view.text}`;
        }
        this._sync();
    }

    _width(mode) {
        if (this._widths[mode] || !this.root.get_stage()) return this._widths[mode] ?? 0;
        const {ring, label, button} = this._ui;
        const [visible, text] = [ring.area.visible, label.text];
        ring.area.visible = mode === 'ring';
        label.text = WIDEST[mode];
        ensureStyle(this.root);
        this._widths[mode] = Math.ceil(button.get_preferred_width(-1)[1]);
        ring.area.visible = visible;
        label.text = text;
        return this._widths[mode];
    }

    _sync() {
        if (this._shellEnding || !this._dock) return;
        const visible = Boolean(this._view) && Boolean(this._settings?.get_boolean('download-enabled')) &&
            !Main.overview.visible && !Main.sessionMode.isLocked && !Main.layoutManager.primaryMonitor?.inFullscreen;
        const mode = this._view?.fraction === null ? 'bytes' : 'ring';
        this._dock.update({width: (visible && this._width(mode)) || DESIGN.geometry.spotifyCompact,
            height: DESIGN.control.compactHeight, visible, expanded: false});
    }
}

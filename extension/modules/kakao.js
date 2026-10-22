import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {DockParticipant, easeOnCurve} from '../notchDock.js';
import {DESIGN} from '../designTokens.js';
import {classifyNotification, parseGsconnectBody, parseFdoMessage, parseAttentionBody, messageEvent,
    mergeEvents, takeEvent, displayText} from './kakaoModel.js';
import {NotifyWatch} from './notifyWatch.js';

const APP_ID = 'wine-Programs-카카오톡.desktop';
const PRIORITY = 60;
const RETRY_MS = 2000;
const BODY_LINES = 2;
// K2: KakaoTalk's own popup window mirrored into the island. Probed 2026-10-22 on Wine 10 /
// XWayland: an untitled NORMAL window, _NET_WM_STATE_ABOVE + SKIP_TASKBAR, no decorations,
// 310×130, sliding in over ~300 ms (height 8 → 130) and drawn above the screen top where the
// user never sees it. null would keep the watcher inactive.
const POPUP_FINGERPRINT = {minWidth: 290, maxWidth: 330, minHeight: 90, maxHeight: 170};
const POPUP_SETTLE_MS = 400;

function kakaoApp() {
    return Shell.AppSystem.get_default().lookup_app(APP_ID);
}

// The chat window for `room`, else the main window, else relaunch (KakaoTalk hidden in the tray).
function raiseKakao(room) {
    const app = kakaoApp();
    if (!app) return;
    const windows = app.get_windows();
    const window = windows.find(w => w.get_title() === room) ?? windows.find(w => w.get_title() === '카카오톡') ??
        windows[0];
    if (window) Main.activateWindow(window); else app.activate();
}

function label(text, styleClass) {
    const actor = new St.Label({text, style_class: styleClass, x_align: Clutter.ActorAlign.START});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

// Unmapped St widgets measure without their CSS until styled.
function ensureStyle(actor) {
    actor.ensure_style?.();
    actor.get_children().forEach(ensureStyle);
}

export class KakaoModule {
    constructor({settings, uuid}) {
        this._settings = settings;
        this._queue = [];
        this._active = null;
        this._shellEnding = false;
        this._remainingMs = 0;
        this._deadline = 0;
        this._dismissTimer = this._hoverTimer = this._retryTimer = this._gapTimer = 0;
        this._card = this._body = null;
        this._hiddenPopups = new Set();
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.root = new St.BoxLayout({vertical: true, style_class: 'notci-module notci-kakao',
            reactive: false, can_focus: false, clip_to_allocation: true, accessible_name: '카카오톡 알림'});
        global.focus_manager.add_group(this.root);
        this._dock = new DockParticipant({id: `${uuid}/kakao`, content: this.root, order: 3,
            monitor: () => Main.layoutManager.primaryMonitor, triggerActor: () => null,
            onOutside: () => this.dismiss(), onYield: () => this._requeueActive(),
            onShellShutdown: () => { this._shellEnding = true; }});
        this._watch = new NotifyWatch({
            match: (source, n) => Boolean(this._classify(source, n)),
            onAdded: ({source, notification}) => this._onNotification(source, notification),
            // An in-place update is the next message of that chat.
            onUpdated: ({source, notification}) => this._onNotification(source, notification),
            onRemoved: (n, reason) => this._onNotificationRemoved(n, reason),
        });
        this._settings.connectObject('changed::kakao-enabled', () => this._applyEnabled(), this);
        this._applyEnabled();
        global.display.connectObject('window-created', (_display, window) => this._onWindowCreated(window), this);
    }

    _applyEnabled() {
        this._watch.stop();
        if (this._settings.get_boolean('kakao-enabled')) {
            this._watch.start();
            return;
        }
        this._queue = [];
        this.collapse();
    }

    _showBody() {
        return this._settings.get_boolean('kakao-show-body');
    }

    _classify(source, n) {
        const kind = classifyNotification({sourceTitle: source.title, appId: source.app?.get_id?.() ?? null,
            id: n.id, title: n.title, forFeedback: n.forFeedback});
        const wanted = this._settings.get_string('kakao-source');
        if (!kind || wanted !== 'both' && (wanted === 'phone') !== (kind.source === 'phone')) return null;
        return kind;
    }

    _onNotification(source, n) {
        const kind = this._classify(source, n);
        if (!kind) return;
        // A property bump on the card being shown is not a new message.
        if (this._active?.notification === n && this._active.rawBody === (n.body ?? '')) return;
        // Shell's banner gate skips acknowledged notifications: the island is the only banner.
        n.acknowledged = true;
        const parsed = kind.source === 'phone' ? parseGsconnectBody(n.body) :
            kind.source === 'pc' ? parseFdoMessage(n.title, n.body) : {room: parseAttentionBody(n.body)};
        const event = messageEvent({source: kind.source, ...parsed, hasIcon: Boolean(n.gicon),
            canReply: Boolean(n.requestReplyId)});
        // Copied now: a notify-send source closes before the card shows.
        event.gicon = n.gicon ?? null;
        event.rawBody = n.body ?? '';
        event.notification = n;
        event.activate = () => n.activate();
        if (kind.source === 'phone') event.dismiss = () => n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
        console.debug(`[notci] kakao ${kind.source}: text ${event.text.length} chars, icon ${event.hasIcon}`);
        mergeEvents(this._queue, event);
        this._showNext();
    }

    _onNotificationRemoved(n, reason) {
        // SOURCE_CLOSED is notify-send exiting, not the user; only DISMISSED drops the message.
        const dismissed = reason === MessageTray.NotificationDestroyedReason.DISMISSED;
        const activeHit = this._active?.notification === n;
        if (dismissed) this._queue = this._queue.filter(event => event.notification !== n);
        for (const event of [this._active, ...this._queue]) {
            if (event?.notification === n) event.notification = event.activate = event.dismiss = null;
        }
        if (dismissed && activeHit) this.collapse();
    }

    _showNext() {
        if (this._active || this._gapTimer || this._shellEnding || !this._dock) return;
        const blocked = Main.overview.visible || Main.sessionMode.isLocked ||
            Boolean(Main.layoutManager.primaryMonitor?.inFullscreen);
        const event = takeEvent(this._queue, () => !blocked && this._dock.claim(PRIORITY));
        if (event) this._present(event);
        else if (this._queue.length) this._scheduleRetry();
    }

    _scheduleRetry() {
        if (this._retryTimer) return;
        this._retryTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, () => {
            this._retryTimer = 0;
            this._showNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    _present(event) {
        this._active = event;
        this._render(event);
        const height = this._measure();
        this._dock.update({width: DESIGN.geometry.expandedWide, height, visible: true, expanded: true});
        // Entrance only after the dock shows the attached tree: an actor eased before that never plays.
        if (this._interface.get_boolean('enable-animations')) {
            Object.assign(this._card, {opacity: 0, translation_y: -DESIGN.motion.contentShift});
            easeOnCurve(this._card, {opacity: 255, translation_y: 0, duration: DESIGN.motion.primaryDuration,
                delay: DESIGN.motion.primaryDelay});
        }
        this._startDismissTimer(this._settings.get_int('kakao-seconds') * 1000);
        const {primary, secondary} = displayText(event, this._showBody());
        const text = this._showBody() ? `카카오톡, ${primary}: ${secondary}` : `카카오톡, ${primary}`;
        try { this.root.get_accessible()?.emit('notification', text, Atk.Live.POLITE); } catch (_error) {}
        console.debug(`[notci] kakao card shown: ${event.source}, height ${height}`);
    }

    _render(event) {
        this.root.destroy_all_children();
        const {primary, secondary, caption} = displayText(event, this._showBody());
        // The card is the reactive surface (hover, click, Enter); the root stays inert for the dock.
        const card = new St.Button({style_class: 'notci-card', reactive: true, can_focus: true, track_hover: true,
            x_expand: true, accessible_name: `${caption}, ${primary}: ${secondary}`});
        const row = new St.BoxLayout({style_class: 'notci-card-row', x_expand: true});
        card.set_child(row);
        row.add_child(this._avatar(event));
        this._body = null;
        if (event.popupActor) {
            row.add_child(new Clutter.Clone({source: event.popupActor, y_align: Clutter.ActorAlign.CENTER}));
        } else {
            const column = new St.BoxLayout({style_class: 'notci-card-column', vertical: true, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER});
            column.add_child(label(`${caption} · 방금`, 'notci-caption'));
            column.add_child(label(primary, 'notci-kakao-sender'));
            this._body = label(secondary, 'notci-body-2');
            this._body.clutter_text.line_wrap = true;
            this._body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            column.add_child(this._body);
            row.add_child(column);
        }
        card.connect('clicked', () => this._activate());
        card.connect('key-press-event', (_actor, keyEvent) => {
            if (keyEvent.get_key_symbol() !== Clutter.KEY_Escape) return Clutter.EVENT_PROPAGATE;
            this.dismiss();
            return Clutter.EVENT_STOP;
        });
        card.connect('enter-event', () => this._pauseDismiss());
        card.connect('leave-event', () => this._resumeDismiss());
        this.root.add_child(card);
        this._card = card;
    }

    _avatar(event) {
        const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        const icon = new St.Icon({icon_size: 44});
        const gicon = event.gicon ?? kakaoApp()?.get_icon() ?? null;
        if (gicon) icon.gicon = gicon; else icon.icon_name = 'user-info-symbolic';
        const avatar = new St.Bin({style_class: 'notci-avatar'});
        avatar.set_child(icon);
        const badge = new St.Bin({style_class: 'notci-avatar-badge', x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END});
        badge.set_child(new St.Icon({icon_name: 'user-available-symbolic', icon_size: 10}));
        holder.add_child(avatar);
        holder.add_child(badge);
        return holder;
    }

    // Measures the real card height (96 two-line / 80 one-line at normal text) instead of assuming it.
    _measure() {
        ensureStyle(this.root);
        const width = DESIGN.geometry.expandedWide;
        const row = this._card.get_child();
        const contentWidth = width - this._card.get_theme_node().get_horizontal_padding() -
            row.get_theme_node().get_length('spacing') - row.get_first_child().get_preferred_width(-1)[1];
        if (this._body) {
            const text = this._body.clutter_text;
            const layout = text.get_layout();
            const lineHeight = Math.ceil(layout.get_pixel_size()[1] / Math.max(1, layout.get_line_count()));
            // With ellipsize END the natural height is one line; count the wrapped lines without it.
            text.ellipsize = Pango.EllipsizeMode.NONE;
            const [, full] = text.get_preferred_height(contentWidth);
            text.ellipsize = Pango.EllipsizeMode.END;
            const lines = Math.min(BODY_LINES, Math.max(1, Math.round(full / lineHeight)));
            this._body.set_height(lines * lineHeight);
        } else {
            const clone = row.get_last_child();
            const scale = Math.min(1, contentWidth / Math.max(1, clone.source.width));
            clone.set_size(Math.round(clone.source.width * scale), Math.round(clone.source.height * scale));
        }
        const [, natural] = this.root.get_preferred_height(width);
        return Math.ceil(natural);
    }

    _clearTimers(...names) {
        for (const name of names) {
            if (this[name]) GLib.source_remove(this[name]);
            this[name] = 0;
        }
    }

    _startDismissTimer(ms) {
        this._clearTimers('_dismissTimer');
        this._deadline = GLib.get_monotonic_time() / 1000 + ms;
        this._dismissTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(ms)), () => {
            this._dismissTimer = 0;
            this.collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _pauseDismiss() {
        this._clearTimers('_hoverTimer');
        if (!this._dismissTimer) return;
        this._remainingMs = Math.max(0, this._deadline - GLib.get_monotonic_time() / 1000);
        this._clearTimers('_dismissTimer');
    }

    _resumeDismiss() {
        if (!this._active || this._dismissTimer || this._hoverTimer) return;
        this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DESIGN.motion.hoverResume, () => {
            this._hoverTimer = 0;
            if (this._active) this._startDismissTimer(Math.max(this._remainingMs, DESIGN.motion.micro));
            return GLib.SOURCE_REMOVE;
        });
    }

    _activate() {
        const event = this._active;
        if (!event) return;
        try { event.activate?.(); } catch (_error) { /* the notification is already gone */ }
        raiseKakao(event.room);
        this.collapse();
    }

    // Outside click or Esc: a user dismissal, so the phone copy goes too.
    dismiss() {
        const event = this._active;
        this.collapse();
        try { event?.dismiss?.(); } catch (_error) {}
    }

    collapse() {
        this._clearTimers('_dismissTimer', '_hoverTimer');
        if (!this._active) return;
        this._active = null;
        this._card = this._body = null;
        // The dock fades the content over `micro` while the slab retracts; the tree is cleared after the gap.
        this._dock?.update({visible: false, expanded: false});
        if (this._shellEnding) return;
        this._gapTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DESIGN.motion.alertGap, () => {
            this._gapTimer = 0;
            this.root?.destroy_all_children();
            this._showNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    // A higher-priority alert took the island: keep the message for when it is free again.
    _requeueActive() {
        const event = this._active;
        this._clearTimers('_dismissTimer', '_hoverTimer');
        if (!event) return;
        this._active = null;
        this._card = this._body = null;
        this._queue.unshift(event);
        this._dock?.update({visible: false, expanded: false});
        this._scheduleRetry();
    }

    // Scene hook for captures: a synthetic message shown exactly as a real one.
    applyDebugMessage({sender, room = null, text, source = 'pc', iconPath = null}) {
        const event = messageEvent({source, sender, room, text, hasIcon: Boolean(iconPath)});
        if (iconPath) event.gicon = new Gio.FileIcon({file: Gio.File.new_for_path(iconPath)});
        mergeEvents(this._queue, event);
        this._showNext();
    }

    // ---- K2: KakaoTalk's own popup mirrored into the island. Inactive while POPUP_FINGERPRINT is null;
    // delete this block once the text bridge makes it redundant. ----
    _onWindowCreated(window) {
        if (!POPUP_FINGERPRINT || !this._showBody() || this._settings.get_string('kakao-source') === 'phone') return;
        if (window.get_wm_class() !== 'kakaotalk.exe' || window.get_window_type() !== Meta.WindowType.NORMAL ||
            window.get_title() !== '' || !window.is_above() || !window.is_skip_taskbar()) return;
        // The popup slides in; measure after it has settled, not at the first map.
        window.connectObject('shown', () => GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPUP_SETTLE_MS, () => {
            if (!this._dock || !window.get_compositor_private()) return GLib.SOURCE_REMOVE;
            const {width, height} = window.get_frame_rect();
            const f = POPUP_FINGERPRINT;
            const actor = window.get_compositor_private();
            if (!actor || width < f.minWidth || width > f.maxWidth || height < f.minHeight || height > f.maxHeight)
                return GLib.SOURCE_REMOVE;
            actor.opacity = 0;
            this._hiddenPopups.add(actor);
            const event = messageEvent({source: 'pc'});
            event.popupActor = actor;
            // The dismiss timer (kakao-seconds, at most 15 s) caps the mirror; the popup closing ends it early.
            window.connectObject('unmanaged', () => {
                this._hiddenPopups.delete(actor);
                this._queue = this._queue.filter(item => item !== event);
                if (this._active === event) this.collapse();
                // The clone must go before its source actor does.
                this.root?.destroy_all_children();
            }, this);
            this._queue.push(event);
            this._showNext();
            return GLib.SOURCE_REMOVE;
        }), this);
    }

    destroy() {
        this._clearTimers('_dismissTimer', '_hoverTimer', '_retryTimer', '_gapTimer');
        this._watch?.stop();
        this._watch = null;
        try { global.display.disconnectObject(this); } catch (_error) {}
        try { this._settings?.disconnectObject(this); } catch (_error) {}
        for (const actor of this._hiddenPopups) {
            try { actor.opacity = 255; } catch (_error) {}
        }
        this._hiddenPopups.clear();
        this._queue = [];
        this._active = null;
        this._dock?.destroy();
        this._dock = null;
        try { global.focus_manager.remove_group(this.root); } catch (_error) {}
        if (!this._shellEnding) {
            try { this.root?.destroy(); } catch (_error) {}
        }
        this.root = this._card = this._body = this._settings = this._interface = null;
    }
}

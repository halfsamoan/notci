import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DockParticipant} from '../notchDock.js';
import {DESIGN} from '../designTokens.js';
import {NotifyWatch} from './notifyWatch.js';
import {AGENT_APPS, AGENT_LABELS, CELL, GRID_H, PALETTES, CALM_MAX_MS, LOOK, agentSourceFor, composePose,
    arriveFrames, excitedFrames, calmCycle, leaveFrames} from './agentModel.js';

// The pet's drawing box: the compact row's 28 px content height, sprite on its bottom edge.
const AREA_H = 28;
// The window-attention notification Shell makes from the same flash arrives right after the flash.
const DEDUPE_MS = 3000;
const PHASES = {arrive: arriveFrames, excited: excitedFrames, calm: calmCycle, leave: leaveFrames};
// A window this close to the monitor centre (a maximised one) gives no side: the pet looks around.
const LOOK_DEAD_ZONE = 0.08;

function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function ensureStyle(actor) {
    actor.ensure_style?.();
    actor.get_children().forEach(ensureStyle);
}

// Claude / ChatGPT desktop finished a reply (or needs you) while you were elsewhere: a pixel pet
// pops out of the compact island and stays until you go back to that app. Signals: the app's own
// window flash (Electron flashFrame → Mutter demands-attention) and its desktop notification.
export class AgentModule {
    constructor({settings, uuid}) {
        this._settings = settings;
        this._pending = new Map();   // source -> {window, at}
        this._current = null;
        this._shellEnding = false;
        this._phase = null;
        this._frames = [];
        this._index = 0;
        this._phaseStart = 0;
        this._frameTimer = 0;
        this._frame = {pose: 'happy', y: 0, flame: null};
        this._drawn = '';
        this._paintCache = new Map();   // source|pose|flame -> [{rgb, runs: [[x, y, w]]}]
        this._lookTurn = false;
        this._compactWidth = 0;
        this.root = new St.BoxLayout({style_class: 'notci-module notci-agent', reactive: false, can_focus: false,
            clip_to_allocation: true, accessible_name: 'AI 답변 알림'});
        global.focus_manager.add_group(this.root);
        this._dock = new DockParticipant({id: `${uuid}/agent`, content: this.root, order: 5,
            monitor: () => Main.layoutManager.primaryMonitor, triggerActor: () => null,
            onShellShutdown: () => this._beginShellShutdown()});
        this._build();
        this._watch = new NotifyWatch({
            match: source => Boolean(this._notificationSource(source)),
            onAdded: ({source}) => this._onSignal(this._notificationSource(source), null),
        });
        global.display.connectObject('window-demands-attention', (_display, window) => this._onAttention(window),
            'window-marked-urgent', (_display, window) => this._onAttention(window),
            'notify::focus-window', () => this._onFocus(),
            'in-fullscreen-changed', () => this._sync(), this);
        Main.overview.connectObject('showing', () => this._sync(), 'hidden', () => this._sync(), this);
        Main.sessionMode.connectObject('updated', () => this._sync(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._sync(), this);
        St.Settings.get().connectObject('notify::enable-animations', () => this._sync(), this);
        this.root.connect('notify::mapped', () => this._sync());
        settings.connectObject('changed::agent-enabled', () => this._applyEnabled(), this);
        this._applyEnabled();
    }

    // The pet has no card: Esc and outside clicks have nothing to fold.
    collapse() {}

    // Capture hook: a signal without the app, optionally frozen on one frame.
    applyDebugState({source = 'claude', frame = null} = {}) {
        this._onSignal(source, null, true);
        if (!frame) return;
        this._stopTimer();
        this._phase = 'frozen';
        this._draw({pose: 'happy', y: 0, flame: null, ...frame});
    }

    destroy() {
        this._stopTimer();
        this._watch?.stop();
        this._watch = null;
        for (const object of [global.display, Main.overview, Main.sessionMode, Main.layoutManager, St.Settings.get(), this._settings]) {
            try { object?.disconnectObject(this); } catch (_error) {}
        }
        this._pending.clear();
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
        this._stopTimer();
    }

    _applyEnabled() {
        this._watch.stop();
        if (this._settings.get_boolean('agent-enabled')) {
            this._watch.start();
            return;
        }
        this._pending.clear();
        this._current = null;
        this._stopTimer();
        this._phase = null;
        this._sync();
    }

    // ---- Signals ----

    _notificationSource(source) {
        return agentSourceFor({appId: source.app?.get_id?.() ?? null, title: source.title ?? null});
    }

    _windowSource(window) {
        if (!window) return null;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        return agentSourceFor({appId: app?.get_id?.() ?? null, wmClass: window.get_wm_class?.() ?? null});
    }

    _onAttention(window) {
        const source = this._windowSource(window);
        if (source) this._onSignal(source, window);
    }

    _onSignal(source, window, force = false) {
        if (!source || this._shellEnding || !this._settings?.get_boolean('agent-enabled')) return;
        // You are already looking at it.
        if (!force && this._windowSource(global.display.focus_window) === source) return;
        const now = GLib.get_monotonic_time() / 1000;
        const known = this._pending.get(source);
        if (known && now - known.at < DEDUPE_MS) {
            known.window ??= window;
            return;
        }
        const wasEmpty = this._pending.size === 0;
        this._pending.delete(source);   // re-insert: Map order makes it the newest
        this._pending.set(source, {window: window ?? known?.window ?? null, at: now});
        this._current = source;
        this._redraw();
        // A new reply while calm (or resting) gets the energetic hops again.
        this._stopTimer();
        this._phase = wasEmpty || this._phase === 'leave' ? 'arrive' : 'excited';
        this._phaseStart = now;
        this._sync();
    }

    _onFocus() {
        const source = this._windowSource(global.display.focus_window);
        if (source && this._pending.has(source)) this._acknowledge(source);
    }

    _acknowledge(source) {
        this._pending.delete(source);
        if (this._pending.size) {
            this._current = [...this._pending.keys()].pop();
            this._redraw();
            return;
        }
        if (this.root?.mapped && St.Settings.get().enable_animations && this._phase !== 'frozen') {
            this._play('leave');
            return;
        }
        this._finish();
    }

    _finish() {
        this._stopTimer();
        this._phase = null;
        this._current = null;
        this._sync();
    }

    // Brings the app that finished to the front; focusing it acknowledges the pet.
    _activate() {
        const source = this._current;
        const entry = source ? this._pending.get(source) : null;
        if (!entry) return;
        const window = entry.window?.get_compositor_private?.() ? entry.window : null;
        if (window) {
            Main.activateWindow(window);
        } else {
            const appId = Object.keys(AGENT_APPS).find(id => AGENT_APPS[id] === source);
            Shell.AppSystem.get_default().lookup_app(appId)?.activate();
        }
        this._acknowledge(source);
    }

    // ---- View ----

    _build() {
        const button = new St.Button({style_class: 'notci-compact-module', can_focus: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const row = new St.BoxLayout({style_class: 'notci-agent-compact', y_align: Clutter.ActorAlign.CENTER});
        const pet = new St.DrawingArea({style_class: 'notci-agent-pet', y_align: Clutter.ActorAlign.CENTER});
        pet.set_content_scaling_filters(Clutter.ScalingFilter.NEAREST, Clutter.ScalingFilter.NEAREST);
        pet.connect('repaint', () => this._paint(pet));
        const label = new St.Label({style_class: 'notci-agent-label', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(pet);
        row.add_child(label);
        button.set_child(row);
        button.connect('clicked', () => this._activate());
        this.root.add_child(button);
        this._ui = {button, pet, label};
    }

    _redraw() {
        const ui = this._ui;
        if (!ui || !this._current) return;
        const name = AGENT_LABELS[this._current];
        if (ui.label.text !== name) {
            ui.label.text = name;
            this._compactWidth = 0;
        }
        ui.button.accessible_name = `${name} 답변 완료, 누르면 창 열기`;
        ui.pet.queue_repaint();
    }

    // Horizontal runs grouped by colour, built once per source/pose/flame (at most 2×7×4): a paint is
    // ~10 fills instead of one per cell.
    _groups(source, pose, flame) {
        const key = `${source}|${pose}|${flame}`;
        let groups = this._paintCache.get(key);
        if (groups) return groups;
        const byColour = new Map();
        composePose(pose, flame).forEach((row, y) => {
            for (let x = 0; x < row.length;) {
                const cell = row[x];
                let end = x + 1;
                while (end < row.length && row[end] === cell) end++;
                if (cell !== '.') {
                    if (!byColour.has(cell)) byColour.set(cell, []);
                    byColour.get(cell).push([x, y, end - x]);
                }
                x = end;
            }
        });
        groups = [...byColour].map(([cell, runs]) => ({rgb: rgb(PALETTES[source][cell]), runs}));
        this._paintCache.set(key, groups);
        return groups;
    }

    _paint(area) {
        const cr = area.get_context();
        try {
            const {pose, y, flame} = this._frame;
            const top = AREA_H - GRID_H * CELL + y;
            cr.setAntialias(Cairo.Antialias.NONE);
            for (const {rgb: colour, runs} of this._groups(this._current ?? 'claude', pose, flame)) {
                cr.setSourceRGB(...colour);
                for (const [x, row, width] of runs) cr.rectangle(x * CELL, top + row * CELL, width * CELL, CELL);
                cr.fill();
            }
        } finally {
            cr.$dispose();
        }
    }

    // Repaints only when the picture changes (cycle seams and long holds repeat the same frame).
    _draw(frame) {
        const pose = frame.pose === LOOK ? this._lookPose() : frame.pose;
        const drawn = `${this._current}|${pose}|${frame.y}|${frame.flame}`;
        if (drawn === this._drawn) return;
        this._drawn = drawn;
        this._frame = {...frame, pose};
        this._ui?.pet.queue_repaint();
    }

    // Toward the finished app's window; a centred (maximised) one gets a look-around instead.
    _lookPose() {
        const entry = this._current ? this._pending.get(this._current) : null;
        let window = entry?.window?.get_compositor_private?.() ? entry.window : null;
        if (!window && this._current) {
            const appId = Object.keys(AGENT_APPS).find(id => AGENT_APPS[id] === this._current);
            window = Shell.AppSystem.get_default().lookup_app(appId)?.get_windows().find(w => !w.minimized) ?? null;
        }
        const monitor = Main.layoutManager.primaryMonitor;
        if (!window || !monitor) return 'base';
        const rect = window.get_frame_rect();
        const offset = rect.x + rect.width / 2 - (monitor.x + monitor.width / 2);
        if (Math.abs(offset) >= monitor.width * LOOK_DEAD_ZONE) return offset < 0 ? 'lookL' : 'lookR';
        this._lookTurn = !this._lookTurn;
        return this._lookTurn ? 'lookL' : 'lookR';
    }

    _visible() {
        return this._pending.size > 0 || this._phase === 'leave';
    }

    _sync() {
        if (this._shellEnding || !this._dock) return;
        const visible = this._visible() && !Main.overview.visible && !Main.sessionMode.isLocked &&
            !Main.layoutManager.primaryMonitor?.inFullscreen;
        if (visible && this.root.get_stage() && !this._compactWidth) {
            ensureStyle(this.root);
            this._compactWidth = Math.ceil(this._ui.button.get_preferred_width(-1)[1]);
        }
        this._dock.update({width: this._compactWidth || DESIGN.geometry.spotifyCompact,
            height: DESIGN.control.compactHeight, visible, expanded: false});
        this._animate();
    }

    // Plays only while the pet is on screen; anything that hides it parks the timer.
    _animate() {
        let run = false;
        try {
            run = Boolean(this._phase) && this._phase !== 'frozen' && this._phase !== 'rest' && this.root.mapped &&
                St.Settings.get().enable_animations && !Main.layoutManager.primaryMonitor?.inFullscreen &&
                !Main.sessionMode.isLocked;
        } catch (_error) {}
        if (!run) {
            this._stopTimer();
            if (this._phase === 'leave') { this._finish(); return; }
            if (this._phase !== 'frozen') this._draw({pose: 'happy', y: 0, flame: null});
            return;
        }
        if (this._frameTimer) return;
        // Resume the phase from its first frame: an arrival seen half-way is no arrival.
        this._play(this._phase, false);
    }

    _play(phase, restartClock = true) {
        this._stopTimer();
        this._phase = phase;
        const now = GLib.get_monotonic_time() / 1000;
        if (restartClock || !this._phaseStart) this._phaseStart = now;
        this._frames = PHASES[phase](now - this._phaseStart);
        this._index = 0;
        this._step();
    }

    _step() {
        const frame = this._frames[this._index];
        this._draw(frame);
        this._frameTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, frame.ms, () => {
            this._frameTimer = 0;
            if (++this._index < this._frames.length) {
                this._step();
                return GLib.SOURCE_REMOVE;
            }
            this._next();
            return GLib.SOURCE_REMOVE;
        });
    }

    // arrive → excited (two bursts) → calm (sparser over CALM_MAX_MS) → rest (still, no timer); leave → gone.
    _next() {
        const elapsed = GLib.get_monotonic_time() / 1000 - this._phaseStart;
        if (this._phase === 'leave') { this._finish(); return; }
        if (this._phase === 'arrive') { this._play('excited'); return; }
        if (this._phase === 'excited') { this._play('calm'); return; }
        if (elapsed < CALM_MAX_MS) { this._play('calm', false); return; }
        this._phase = 'rest';
        this._draw({pose: 'happy', y: 0, flame: null});
    }

    _stopTimer() {
        if (this._frameTimer) GLib.source_remove(this._frameTimer);
        this._frameTimer = 0;
    }
}

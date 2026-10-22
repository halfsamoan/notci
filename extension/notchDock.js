import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DOCK_PROTOCOL, buttonNumber, layoutIsland, canClaim, isActorWithin, isPointWithinActor, pointInNotchShape,
    isPointWithinNotch, classifyOutsideSurface, shouldDismissOutside, dispatchOutsideDismiss, notchGeometry} from './dockModel.js';
import {DESIGN} from './designTokens.js';
import {createNotchSurface} from './notchSurface.js';

// One registry, one island per monitor and one capture-phase listener, shared by every
// independently installed extension that ships this file (Archsport, matci, notci).
const KEY = `_notchIslandDock_v${DOCK_PROTOCOL}`;
const OPEN_MS = DESIGN.motion.expand;
const CLOSE_MS = DESIGN.motion.collapse;
const MICRO_MS = DESIGN.motion.micro;
const [CURVE_X1, CURVE_Y1, CURVE_X2, CURVE_Y2] = DESIGN.motion.curve;

function layoutSourceHash() {
    let hash = 2166136261;
    // Geometry values are part of the contract: two builds that draw or hit-test
    // different slabs must not share one dock silently.
    const contract = [`protocol=${DOCK_PROTOCOL}`, `open=${OPEN_MS}`, `close=${CLOSE_MS}`, `micro=${MICRO_MS}`,
        `curve=${DESIGN.motion.curve}`, JSON.stringify(DESIGN.geometry), JSON.stringify(DESIGN.radius),
        JSON.stringify(DESIGN.material), JSON.stringify(DESIGN.spacing),
        disconnectCapture, layoutIsland, canClaim, isActorWithin, isPointWithinActor,
        pointInNotchShape, isPointWithinNotch, notchGeometry, createNotchSurface,
        classifyOutsideSurface, shouldDismissOutside, dispatchOutsideDismiss,
        eventCoordinates, buttonNumber, animationsEnabled, clearMorph, allocationFor, easeOnCurve, morph,
        hideSlab, showSlab, slabFor, destroySlabs, attach, detach, placeContent, monitorKey, keepOnStage,
        dismissOnFocusChange, insideActiveSurface, getDock, DockParticipant]
        .map(fn => typeof fn === 'string' ? fn : fn.toString()).join('|');
    for (const char of `${contract}|capture-dismiss-v7|island-v1`) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function disconnectCapture(dock) {
    if (!dock.captureStage) return;
    try {
        if (dock.captureId) dock.captureStage.disconnect(dock.captureId);
        if (dock.stageDestroyId) dock.captureStage.disconnect(dock.stageDestroyId);
    } catch (_error) { /* stage is already being destroyed */ }
    try {
        if (dock.focusId) global.display.disconnect(dock.focusId);
    } catch (_error) {}
    dock.captureStage = null;
    dock.captureId = 0;
    dock.stageDestroyId = 0;
    dock.focusId = 0;
}

// Giving an app window focus (click, Alt+Tab, launch) counts as tapping outside the island.
// Focus moving to nothing is ignored: that is the island itself taking the keyboard.
function dismissOnFocusChange(dock) {
    if (dock.shuttingDown) return;
    let window = null;
    try { window = global.display.focus_window; } catch (_error) {}
    if (!window || window === dock.focusWindow) {
        if (window) dock.focusWindow = window;
        return;
    }
    dock.focusWindow = window;
    const owner = dock.active && dock.participants.get(dock.active.id);
    if (!owner || !owner.state.visible || !owner.state.expanded) return;
    try { owner.onOutside?.(); } catch (error) {
        console.warn(`[notchDock] focus-change dismissal failed: ${error.message}`);
    }
}

function eventCoordinates(event) {
    try {
        const [x, y] = event.get_coords();
        return {x, y};
    } catch (_error) {
        return {x: NaN, y: NaN};
    }
}

function animationsEnabled(dock) {
    try {
        return dock.animations.get_boolean('enable-animations');
    } catch (_error) {
        return false;
    }
}

function clearMorph(slab) {
    slab.surface?.remove_all_transitions();
}

// Placements describe the body; the slab adds its ears on both sides.
function allocationFor(island) {
    const {ear} = notchGeometry(island.height, island.width);
    return {x: island.x - ear, y: island.y, width: island.width + 2 * ear, height: island.height};
}

const EASE_OPTIONS = new Set(['duration', 'delay', 'mode', 'onComplete', 'onStopped', 'repeatCount', 'autoReverse']);

// The slab and its content share one curve so they read as one motion.
export function easeOnCurve(actor, params) {
    actor.ease({mode: Clutter.AnimationMode.EASE_OUT_QUART, ...params});
    const first = new Graphene.Point({x: CURVE_X1, y: CURVE_Y1});
    const second = new Graphene.Point({x: CURVE_X2, y: CURVE_Y2});
    // Transitions are keyed by the canonical property name (translation-y, scale-x).
    for (const property of Object.keys(params).filter(key => !EASE_OPTIONS.has(key)))
        actor.get_transition(property.replaceAll('_', '-'))?.set_cubic_bezier_progress(first, second);
}

// One transform from the current geometry, so a re-click turns back mid-flight.
function morph(actor, target, duration, onComplete) {
    easeOnCurve(actor, {...target, duration, onComplete});
}

function hideSlab(dock, slab, animate = true) {
    const actor = slab.surface;
    if (!actor || dock.shuttingDown) return;
    if (slab.closing && animate) return;
    clearMorph(slab);
    slab.transitionId++;
    slab.closing = false;
    slab.targetGeometry = null;
    const transitionId = slab.transitionId;
    const duration = animate && animationsEnabled(dock) ? CLOSE_MS : 0;
    if (!actor.visible || !duration) {
        try {
            actor.visible = false;
            actor.opacity = 255;
        } catch (_error) { /* Shell owns final actor disposal */ }
        return;
    }
    slab.closing = true;
    try {
        // Back into the panel edge: the slab retracts to the seed sliver it grew from.
        const center = actor.x + actor.width / 2;
        morph(actor, {x: center - DESIGN.geometry.neckWidth / 2, width: DESIGN.geometry.neckWidth,
            height: DESIGN.geometry.seedHeight}, duration, () => {
            if (dock.shuttingDown || slab.transitionId !== transitionId) return;
            slab.closing = false;
            if (!slab.island) {
                try { actor.visible = false; } catch (_error) { return; }
            }
            try { actor.opacity = 255; } catch (_error) {}
        });
    } catch (_error) {
        slab.closing = false;
        try { actor.visible = false; } catch (_ignored) {}
    }
}

function showSlab(dock, slab, island) {
    const actor = slab.surface;
    if (!actor || dock.shuttingDown) return;
    const wasHidden = !actor.visible;
    const allocation = allocationFor(island);
    const target = `${allocation.x}:${allocation.y}:${allocation.width}:${allocation.height}`;
    if (!wasHidden && !slab.closing && slab.targetGeometry === target) return;
    clearMorph(slab);
    slab.transitionId++;
    slab.closing = false;
    slab.targetGeometry = target;
    try {
        const duration = animationsEnabled(dock) ? OPEN_MS : 0;
        if (wasHidden) {
            const center = allocation.x + allocation.width / 2;
            actor.set_position(center - DESIGN.geometry.neckWidth / 2, allocation.y);
            actor.set_size(DESIGN.geometry.neckWidth, DESIGN.geometry.seedHeight);
            actor.visible = true;
        }
        actor.opacity = 255;
        if (!duration) {
            actor.set_position(allocation.x, allocation.y);
            actor.set_size(allocation.width, allocation.height);
            return;
        }
        const shrinking = !wasHidden && (allocation.height < actor.height || allocation.width < actor.width);
        morph(actor, allocation, shrinking ? CLOSE_MS : duration);
    } catch (_error) {
        // A stale actor is left to Shell teardown; do not retry UI work during shutdown.
    }
}

function slabFor(dock, key) {
    let slab = dock.slabs.get(key);
    if (slab) return slab;
    try {
        const surface = createNotchSurface();
        Main.layoutManager.addChrome(surface, {affectsStruts: false, trackFullscreen: false});
        slab = {key, surface, holder: surface._holder, island: null, targetGeometry: null, transitionId: 0, closing: false};
        dock.slabs.set(key, slab);
        return slab;
    } catch (_error) {
        return null;
    }
}

function monitorKey(monitor) {
    return `${monitor.x}:${monitor.y}:${monitor.width}`;
}

// Content lives inside the (hidden) slab from the start, so a module can measure its
// tree with real CSS before it asks to be shown.
function keepOnStage(dock, participant) {
    let monitor = null;
    try { monitor = participant.monitor(); } catch (_error) {}
    if (!monitor || dock.shuttingDown) return;
    const slab = slabFor(dock, monitorKey(monitor));
    if (!slab) return;
    attach(slab, participant);
    participant.slabKey = slab.key;
}

function destroySlabs(dock) {
    for (const slab of dock.slabs.values()) {
        try { Main.layoutManager.removeChrome(slab.surface); } catch (_error) {}
        try { slab.surface.destroy(); } catch (_error) {}
    }
    dock.slabs.clear();
}

// A module's content is reparented into the island; the dock never destroys it.
function attach(slab, participant) {
    const content = participant.content;
    if (!content || !slab) return;
    try {
        if (content.get_parent() === slab.holder) return;
        content.get_parent()?.remove_child(content);
        if (!content._notchAlign) {
            content._notchAlign = new Clutter.AlignConstraint({align_axis: Clutter.AlignAxis.X_AXIS, factor: 0.5});
            content.add_constraint(content._notchAlign);
        }
        content._notchAlign.source = slab.holder;
        content.visible = false;
        content.opacity = 255;
        slab.holder.add_child(content);
        participant.shown = false;
    } catch (_error) { /* Shell is tearing the actor down */ }
}

function detach(participant) {
    const content = participant.content;
    if (!content) return;
    try {
        content.remove_all_transitions();
        if (content._notchAlign) content.remove_constraint(content._notchAlign);
        content._notchAlign = null;
        content.get_parent()?.remove_child(content);
        content.translation_x = 0;
        content.visible = true;
        content.opacity = 255;
    } catch (_error) {}
    participant.shown = false;
}

// Content is placed at its slot and crossfaded when a module enters or leaves an island
// that is already showing; the growing slab reveals a module when the island itself appears.
function placeContent(dock, slab, participant, slot, island) {
    const content = participant.content;
    if (!content || participant.disposed) return;
    const show = Boolean(slot?.shown && island && slab);
    const slabVisible = Boolean(slab?.surface?.visible && !slab.closing);
    const animate = animationsEnabled(dock);
    if (participant.fitSource) GLib.source_remove(participant.fitSource);
    participant.fitSource = 0;
    participant.fadeId = (participant.fadeId ?? 0) + 1;
    const fadeId = participant.fadeId;
    try {
        if (show) {
            content.translation_x = slot.x + slot.width / 2 - island.width / 2;
            const fit = () => content.set_size(slot.width, island.height);
            // Only a collapse keeps the old size until the expanded content has faded, so it is not reflowed.
            const collapsing = participant.shown && participant.wasExpanded && !island.expanded && slabVisible && animate;
            if (collapsing) {
                participant.fitSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MICRO_MS, () => {
                    participant.fitSource = 0;
                    if (!participant.disposed && participant.fadeId === fadeId) fit();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                fit();
            }
            if (!participant.shown) {
                content.remove_transition('opacity');
                content.visible = true;
                if (slabVisible && animate) {
                    content.opacity = 0;
                    easeOnCurve(content, {opacity: 255, duration: MICRO_MS, delay: MICRO_MS});
                } else {
                    content.opacity = 255;
                }
            }
            participant.wasExpanded = island.expanded;
        } else if (participant.shown) {
            content.remove_transition('opacity');
            if (slabVisible && animate) {
                easeOnCurve(content, {opacity: 0, duration: MICRO_MS, onComplete: () => {
                    if (participant.disposed || participant.fadeId !== fadeId) return;
                    try {
                        content.visible = false;
                        content.opacity = 255;
                    } catch (_error) {}
                }});
            } else {
                content.visible = false;
                content.opacity = 255;
            }
            participant.wasExpanded = false;
        } else {
            content.visible = false;
        }
        participant.shown = show;
    } catch (_error) {
        // A stale actor is left to Shell teardown.
    }
}

function insideActiveSurface(dock, participant, event) {
    const {x, y} = eventCoordinates(event);
    // GNOME 50: event.get_source() is always null; ask the stage for the actor under the event.
    let source = null;
    try { source = global.stage.get_event_actor(event); } catch (_error) {}
    // Preserve only the active module's own opener; another app's panel button is outside.
    let trigger = null;
    try { trigger = participant.triggerActor?.(); } catch (_error) {}
    return classifyOutsideSurface({dockActor: dock.slabs.get(participant.slabKey)?.surface ?? null,
        ownerTrigger: trigger, eventSource: source, x, y});
}

function getDock() {
    if (Main.layoutManager[KEY]) return Main.layoutManager[KEY];
    const dock = {
        protocol: DOCK_PROTOCOL,
        owner: GLib.uuid_string_random(),
        sourceHash: layoutSourceHash(),
        participants: new Map(), active: null,
        slabs: new Map(),
        animations: new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}),
        shuttingDown: false,
        captureStage: global.stage,
        captureId: 0,
        shutdown() {
            if (this.shuttingDown) return;
            this.shuttingDown = true;
            disconnectCapture(this);
            for (const participant of [...this.participants.values()]) {
                try { participant.onShellShutdown?.(); } catch (_error) {}
            }
        },
        reflow() {
            if (this.shuttingDown) return;
            const groups = new Map();
            for (const participant of this.participants.values()) {
                let monitor = null;
                try { monitor = participant.monitor(); } catch (_error) {}
                participant.lastFallback = false;
                if (!monitor || !participant.state.visible) {
                    keepOnStage(this, participant);
                    placeContent(this, null, participant, null, null);
                    continue;
                }
                const key = monitorKey(monitor);
                if (!groups.has(key)) groups.set(key, {monitor, entries: []});
                groups.get(key).entries.push({id: participant.id, ...participant.state,
                    order: participant.order, active: this.active?.id === participant.id});
                participant.slabKey = key;
            }
            for (const [key, {monitor, entries}] of groups) {
                let panelHeight = 0;
                try {
                    if (monitor === Main.layoutManager.primaryMonitor) panelHeight = Main.panel.height;
                } catch (_error) {
                    if (this.shuttingDown) return;
                }
                const {island, slots} = layoutIsland(entries, {...monitor, panelHeight});
                const slab = slabFor(this, key);
                if (!slab) continue;
                slab.island = island;
                for (const entry of entries) {
                    const participant = this.participants.get(entry.id);
                    const slot = slots.get(entry.id);
                    if (!participant || participant.disposed || !slot) continue;
                    // Hidden by a too-narrow monitor, not by another module's expansion.
                    participant.lastFallback = Boolean(island && !island.expanded && !slot.shown);
                    attach(slab, participant);
                    placeContent(this, slab, participant, slot, island);
                    try {
                        participant.onPlacement?.(island ? {x: island.x + slot.x, y: island.y, width: slot.width,
                            height: island.height, expanded: island.expanded, shown: slot.shown} : null);
                    } catch (_error) {}
                }
                if (island) showSlab(this, slab, island); else hideSlab(this, slab, true);
            }
            for (const [key, slab] of this.slabs) {
                if (groups.has(key)) continue;
                slab.island = null;
                hideSlab(this, slab, true);
            }
        },
    };
    dock.captureId = dock.captureStage.connect('captured-event', (_stage, event) => {
        if (dock.shuttingDown) return Clutter.EVENT_PROPAGATE;
        if (event.type() !== Clutter.EventType.BUTTON_PRESS) return Clutter.EVENT_PROPAGATE;
        const owner = dock.active && dock.participants.get(dock.active.id);
        const inside = owner ? insideActiveSurface(dock, owner, event) : null;
        if (owner) {
            try {
                const dismissed = dispatchOutsideDismiss({eventType: event.type(),
                    buttonPressType: Clutter.EventType.BUTTON_PRESS, active: Boolean(dock.active),
                    button: buttonNumber(event.get_button()), expanded: owner.state.visible && owner.state.expanded},
                () => owner.onOutside?.(), inside ?? {});
                // One line per press while a card is open: enough to read a real-session failure from the journal.
                const {x, y} = eventCoordinates(event);
                console.log(`[notchDock] press ${Math.round(x)},${Math.round(y)} button=${buttonNumber(event.get_button())} owner=${owner.id} ` +
                    `expanded=${owner.state.visible && owner.state.expanded} inside=${JSON.stringify(inside)} dismissed=${dismissed}`);
            } catch (error) {
                console.warn(`[notchDock] outside dismissal failed: ${error.message}`);
            }
        }
        // The clicked app, panel, or context menu must still receive the pointer event.
        return Clutter.EVENT_PROPAGATE;
    });
    dock.stageDestroyId = dock.captureStage.connect('destroy', () => dock.shutdown());
    try { dock.focusWindow = global.display.focus_window; } catch (_error) { dock.focusWindow = null; }
    dock.focusId = global.display.connect('notify::focus-window', () => dismissOnFocusChange(dock));
    Main.layoutManager[KEY] = dock;
    return dock;
}

export class DockParticipant {
    constructor({id, content, monitor, order = 0, onYield, onOutside, onPlacement,
        onShellShutdown, triggerActor}) {
        this.id = id;
        this.content = content;
        this.monitor = monitor;
        this.order = order;
        this.onYield = onYield;
        this.onOutside = onOutside;
        this.onPlacement = onPlacement;
        this.onShellShutdown = onShellShutdown;
        this.triggerActor = triggerActor;
        this.lastFallback = false;
        this.fitSource = 0;
        this.fadeId = 0;
        this.shown = false;
        this.wasExpanded = false;
        this.slabKey = null;
        this.disposed = false;
        this.state = {width: 360, height: 46, visible: false, expanded: false};
        this.dock = getDock();
        if (this.dock.sourceHash !== layoutSourceHash() && !this.dock.sourceMismatchLogged) {
            this.dock.sourceMismatchLogged = true;
            console.warn(`[notchDock] shared layout source differs; owner=${this.dock.owner}, protocol=${this.dock.protocol}`);
        }
        this.dock.participants.set(id, this);
        keepOnStage(this.dock, this);
    }

    claim(priority = 100) {
        if (this.disposed || this.dock.shuttingDown || !canClaim(this.dock.active, this.id, priority)) return false;
        const previous = this.dock.active;
        this.dock.active = {id: this.id, priority};
        if (previous && previous.id !== this.id)
            this.dock.participants.get(previous.id)?.onYield?.();
        return true;
    }

    update(state) {
        if (this.disposed || this.dock.shuttingDown) return;
        const changed = Object.entries(state).some(([key, value]) => this.state[key] !== value);
        Object.assign(this.state, state);
        if ((state.expanded === false || state.visible === false) && this.dock.active?.id === this.id)
            this.dock.active = null;
        const monitor = this.monitor();
        let panelHeight = 0;
        try {
            if (monitor === Main.layoutManager.primaryMonitor) panelHeight = Main.panel.height;
        } catch (_error) {
            if (this.dock.shuttingDown) return;
        }
        const geometry = monitor ? `${monitor.x}:${monitor.y}:${monitor.width}:${panelHeight}` : '';
        if (changed || geometry !== this.geometry) {
            this.geometry = geometry;
            this.dock.reflow();
        }
    }

    destroy() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.fitSource) GLib.source_remove(this.fitSource);
        this.fitSource = 0;
        const dock = this.dock;
        if (!dock) return;
        dock.participants.delete(this.id);
        if (dock.active?.id === this.id) dock.active = null;
        if (!dock.shuttingDown) detach(this);
        if (!dock.participants.size) {
            disconnectCapture(dock);
            if (!dock.shuttingDown) destroySlabs(dock);
            try {
                if (Main.layoutManager[KEY] === dock) delete Main.layoutManager[KEY];
            } catch (_error) {}
        } else if (!dock.shuttingDown) {
            dock.reflow();
        }
        this.dock = this.content = this.triggerActor = null;
    }
}

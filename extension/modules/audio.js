import Clutter from 'gi://Clutter';
import GUdev from 'gi://GUdev';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {DockParticipant, easeOnCurve} from '../notchDock.js';
import {DESIGN} from '../designTokens.js';
import {isActorWithin} from '../dockModel.js';
import {createRing, setRing, RING_FILL_DELAY} from './ring.js';
import {EASYEFFECTS_NODES, UPOWER_AUDIO_KINDS, UPOWER_INPUT_KINDS, batteryFor, normalizeDevice, pickPrimary, diffDevices,
    usbAccept, presetNames, parseEasyeffectsrc, withProcessAllOutputs, outputChips, codecFromProfile, macFromSinkName, compactView,
    lowStage, lowAlertStep, toastText, cardHeader, presetChips} from './audioModel.js';

// Ladder: manual 100 > goal 80 > KakaoTalk 60 > audio toast 50 > Spotify peek 40 > matci 30.
const PRIORITY_TOAST = 50;
const IDLE_MS = 8000;
const SYNC_DEBOUNCE_MS = 300;
const EE_APP = 'com.github.wwmm.easyeffects';
const EE_HOME = GLib.build_filenamev([GLib.get_home_dir(), '.var/app', EE_APP]);
const EE_PRESET_DIR = GLib.build_filenamev([EE_HOME, 'data/easyeffects/output']);
const EE_RC = GLib.build_filenamev([EE_HOME, 'config/easyeffects/db/easyeffectsrc']);
// Probed 2026-10-23: `--service-mode --hide-window` creates no toplevel; a second `flatpak run … -l`
// reaches the running instance over the shared /tmp QLocalServer and exits; `-a output` reads back.
const EE_START = ['flatpak', 'run', EE_APP, '--service-mode', '--hide-window'];
const EE_START_WAIT_MS = 8000;
const EE_STOP_WAIT_MS = 6000;
const EE_CMD_TIMEOUT_MS = 6000;
const ICON_COMPACT = 16;
const ICON_HEADER = 28;
const ICON_CHIP = 14;
const CHIP_GAP = 6;
const BATTERY_POLL_MS = 60000;
const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const UPOWER_DEVICE = 'org.freedesktop.UPower.Device';
// Battery ring fill on connect: iOS Dynamic Island headphone toast, timing from DynamicNotchKit's
// progress ring (cubic-bezier(0, .55, .45, 1), 0.8 s after 0.1 s). Level changes slide in 300 ms.
const POP_FROM = 0.8;
const POP_MS = 350;
// Low-battery pulse on the compact ring (Atoll / DynamicNotch low-battery HUD: opacity 0.3 <-> 1.0,
// symmetric ease-in-out). Two dips in 2 s (1 Hz, Apple's 2 s Dynamic Island cap, WCAG 2.3.1 safe).
// GNOME ease() repeatCount counts extra legs: 3 -> 4 legs, an even count, so it ends at 255.
const LOW_PULSE = {opacity: 77, duration: 500, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: 3, autoReverse: true};
const TIMERS = ['_syncTimer', '_holdTimer', '_closingTimer', '_eeWaitTimer', '_eeRefreshTimer', '_batteryTimer'];

// Kept at module scope: notci is disabled on every screen lock (session-modes ["user"]) and a new
// AudioModule is built on unlock. These must survive that, or every unlock re-alerts a low headset
// and resets "connected n min ago".
const LOW_STAGE = new Map();      // device id -> last low-battery stage alerted (1: <20, 2: <=10)
const LOW_PENDING = new Set();    // device ids whose compact ring pulses at their next showing
const CONNECTED_AT = new Map();   // device id -> first seen (ms)

function ensureStyle(actor) {
    actor.ensure_style?.();
    actor.get_children().forEach(ensureStyle);
}

export class AudioModule {
    constructor({settings, uuid}) {
        this._settings = settings;
        this._signals = [];
        this._shellEnding = false;
        this._debug = false;
        this._initialised = false;
        this._devices = [];
        this._sinks = [];
        this._defaultSink = '';
        this._primary = null;
        this._usb = new Map();
        this._ee = {running: false, presets: [], active: '', outputDevice: '', processAll: false, applying: false, error: false, native: false};
        this._expanded = null;          // null | 'toast' | 'card'
        this._renderedExpanded = false;
        this._toast = null;
        this._compactWidth = 0;
        this._holdUntil = this._holdLeft = 0;
        this._ui = {};
        this._celebrate = null;          // device id whose next drawing fills the ring from empty
        this._cancellable = new Gio.Cancellable();
        // The root takes no focus or events itself: St marks that :insensitive and keys die there.
        this.root = new St.BoxLayout({vertical: true, style_class: 'notci-module notci-audio',
            reactive: false, can_focus: false, clip_to_allocation: true, accessible_name: '오디오 기기'});
        global.focus_manager.add_group(this.root);
        this._dock = new DockParticipant({id: `${uuid}/audio`, content: this.root, order: 4,
            monitor: () => Main.layoutManager.primaryMonitor, triggerActor: () => null,
            onOutside: () => this.collapse(), onYield: () => this.collapse(),
            onShellShutdown: () => this._beginShellShutdown()});
        this._connect(this.root, 'notify::mapped', () => this._maybePulseLow());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._visibility());
        this._connect(global.display, 'in-fullscreen-changed', () => this._visibility());
        this._connect(Main.sessionMode, 'updated', () => this._visibility());
        this._connect(Main.overview, 'showing', () => { this.collapse(); this._visibility(); });
        this._connect(Main.overview, 'hidden', () => this._visibility());
        settings.connectObject('changed::audio-enabled', () => this._onEnabledChanged(),
            'changed::audio-usb', () => this._scheduleSync(),
            'changed::audio-easyeffects', () => this._redraw(),
            'changed::audio-easyeffects-autostart', () => this._redraw(), this);
        this._startMixer();
        this._startPower();
        this._startUdev();
        this._startEasyEffects();
    }

    // Public: the compact pill toggles; outside click, Esc, overview and yields collapse.
    expand() {
        if (!this._visible() || !this._dock?.claim(100)) return;
        this._clearHold();
        this._toast = null;
        if (this._expanded !== 'card') {
            this._expanded = 'card';
            this._render();
        }
        this._armHold(IDLE_MS);
        if (this._ee.running) this._queryActivePreset();
    }

    toggle() {
        if (this._expanded === 'card') this.collapse(); else this.expand();
    }

    collapse() {
        this._clearHold();
        if (!this._expanded) return;
        this._expanded = null;
        this._toast = null;
        this._celebrate = null;
        this._render();
    }

    // Probe hook (ux-tools/probe_lowbattery.js): the module-scope low-battery records.
    _debugLow() {
        return {pending: [...LOW_PENDING], stages: Object.fromEntries(LOW_STAGE)};
    }

    // Capture hook: state without Gvc/UPower/udev. Live events stay blocked while _debug is on.
    applyDebugState({devices = [], defaultSink = '', presets = [], activePreset = '', eeRunning = false,
        toast = null, expand = false}) {
        this._debug = true;
        this._initialised = true;
        // Each scene starts folded: a toast or card left by the previous scene must not leak into this one.
        this._clearHold();
        this._expanded = null;
        this._toast = null;
        this._sinks = devices.filter(d => d.isAudio !== false).map(d => ({id: d.id, name: d.name, description: d.description,
            formFactor: d.formFactor ?? '', codec: d.codec ?? '', uiDevice: null}));
        this._defaultSink = defaultSink;
        this._devices = devices.map(d => normalizeDevice({...d, connectedAt: d.connectedAt ?? Date.now()}));
        this._trackLow(this._devices);
        this._primary = pickPrimary(this._devices, defaultSink);
        this._ee = {...this._ee, running: eeRunning, presets, active: activePreset, applying: false, error: false};
        if (toast) {
            this._showToast(normalizeDevice({...toast.device, connectedAt: Date.now()}), toast.connected !== false);
        } else {
            this._render();
        }
        if (expand) this.expand();
    }

    destroy() {
        this._cancellable.cancel();
        for (const name of TIMERS) this._clearTimer(name);
        try { this._mixer?.disconnectObject(this); } catch (_error) {}
        if (this._upowerSignal) Gio.DBus.system.signal_unsubscribe(this._upowerSignal);
        this._upowerSignal = 0;
        try { this._udev?.disconnectObject(this); } catch (_error) {}
        // connectObject keeps a strong map entry per emitter: without disconnectObject every lock
        // (disable/enable) leaked this whole module through the two monitors.
        for (const monitor of [this._presetMonitor, this._rcMonitor]) {
            try { monitor?.disconnectObject(this); } catch (_error) {}
            try { monitor?.cancel(); } catch (_error) {}
        }
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
        this._mixer = this._udev = this._presetMonitor = this._rcMonitor = null;
        this.root = this._settings = this._ui = null;
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

    _enabled() {
        return !this._shellEnding && Boolean(this._settings?.get_boolean('audio-enabled'));
    }

    _visible() {
        return this._enabled() && (this._expanded !== null || this._primary !== null);
    }

    _onEnabledChanged() {
        if (!this._enabled()) this.collapse();
        this._visibility();
    }

    // ---- Shared Gvc mixer: outputs, default sink, codec via card profile ----

    _startMixer() {
        try {
            this._mixer = Volume.getMixerControl();
        } catch (error) {
            console.warn(`[notci] audio mixer unavailable: ${error.message}`);
            return;
        }
        this._mixer.connectObject('state-changed', () => this._scheduleSync(),
            'output-added', () => this._scheduleSync(), 'output-removed', () => this._scheduleSync(),
            'active-output-update', () => this._scheduleSync(), 'default-sink-changed', () => this._scheduleSync(),
            'stream-added', () => this._scheduleSync(), 'stream-removed', () => this._scheduleSync(),
            'card-added', () => this._scheduleSync(), 'card-removed', () => this._scheduleSync(), this);
        this._scheduleSync();
    }

    // Several Gvc signals fire per hotplug; one resync per burst.
    _scheduleSync() {
        if (this._shellEnding || this._debug) return;
        this._clearTimer('_syncTimer');
        this._syncTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_DEBOUNCE_MS, () => {
            this._syncTimer = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        if (this._shellEnding || this._debug || !this.root) return;
        const mixer = this._mixer;
        if (!mixer || mixer.get_state() !== Gvc.MixerControlState.READY) return;
        const cards = mixer.get_cards();
        this._defaultSink = mixer.get_default_sink()?.get_name() ?? '';
        this._sinks = mixer.get_sinks().map(sink => {
            const uiDevice = mixer.lookup_device_from_stream(sink);
            const card = cards.find(candidate => candidate.index === sink.card_index);
            return {id: sink.get_id(), name: sink.get_name(), description: uiDevice?.description || sink.get_description(),
                formFactor: sink.get_form_factor() ?? '', codec: codecFromProfile(card?.human_profile), uiDevice};
        });
        const running = this._sinks.some(sink => EASYEFFECTS_NODES.has(sink.name));
        if (running !== this._ee.running) {
            this._ee.running = running;
            // A different instance appearing or leaving makes old "native"/"error" notes meaningless.
            this._ee.native = this._ee.error = false;
            if (running) this._queryActivePreset(); else this._readRc();
        }
        const now = Date.now();
        const audio = this._sinks.filter(sink => !EASYEFFECTS_NODES.has(sink.name)).map(sink => {
            const id = `sink:${sink.name}`;
            return normalizeDevice({id, name: sink.name, description: sink.description, formFactor: sink.formFactor,
                codec: sink.codec, battery: this._batteryFor(macFromSinkName(sink.name), sink.description),
                connectedAt: CONNECTED_AT.get(id) ?? now});
        });
        const usb = this._settings.get_boolean('audio-usb') ? [...this._usb.values()] : [];
        this._applyDevices([...audio, ...usb], now);
    }

    // One record per device; a device that leaves forgets its stage, so a reconnect while low alerts again.
    _trackLow(devices) {
        const ids = new Set(devices.map(device => device.id));
        for (const id of [...LOW_STAGE.keys()]) {
            if (!ids.has(id)) LOW_STAGE.delete(id);
        }
        for (const id of [...LOW_PENDING]) {
            if (!ids.has(id)) LOW_PENDING.delete(id);
        }
        for (const device of devices) {
            // A null battery (UPower not read yet after unlock) keeps the recorded stage.
            const {stage, fire} = lowAlertStep(LOW_STAGE.get(device.id), device.battery);
            if (stage) LOW_STAGE.set(device.id, stage); else LOW_STAGE.delete(device.id);
            if (fire) LOW_PENDING.add(device.id);
            else if (!stage) LOW_PENDING.delete(device.id);
        }
    }

    _applyDevices(next, now) {
        const {added, removed} = diffDevices(this._devices, next);
        if (!this._initialised) {
            // First sync of this instance: everything looks "added"; keep times from before a lock.
            const ids = new Set(next.map(device => device.id));
            for (const id of [...CONNECTED_AT.keys()]) {
                if (!ids.has(id)) CONNECTED_AT.delete(id);
            }
        }
        for (const device of added) {
            if (this._initialised || !CONNECTED_AT.has(device.id)) CONNECTED_AT.set(device.id, now);
        }
        for (const device of removed) CONNECTED_AT.delete(device.id);
        this._devices = next;
        this._trackLow(next);
        this._primary = pickPrimary(next, this._defaultSink);
        const announce = this._initialised && this._enabled();
        this._initialised = true;
        // Internal cards come and go with profiles, not with the user plugging something in.
        const external = device => device.kind !== 'internal' || !device.isAudio;
        const events = [...added.filter(external).map(device => [device, true]),
            ...removed.filter(external).map(device => [device, false])];
        if (announce && events.length) {
            const [device, connected] = events[events.length - 1];
            this._showToast(device, connected);
        } else if (!this._ui.button && !this._ui.card && !this._closingTimer) {
            // Already connected when the module starts: build the pill, there is no toast to fold into it.
            this._render();
        } else {
            this._redraw();
            this._visibility();
        }
    }

    // ---- UPower: battery for headsets, headphones, mice, keyboards ----
    // Read over D-Bus into a plain cache, never through UPowerGlib: its UpDevice objects came back
    // already finalized from get_devices2() in the real session (every sync threw, so no battery ring),
    // and a held one crashed teardown. Device add/remove signals plus a 60 s poll keep the cache fresh.

    _startPower() {
        this._batteries = [];
        this._upowerSignal = Gio.DBus.system.signal_subscribe(UPOWER_BUS, UPOWER_BUS, null, UPOWER_PATH, null,
            Gio.DBusSignalFlags.NONE, () => this._refreshBatteries());
        this._batteryTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BATTERY_POLL_MS, () => {
            if (this._devices.some(device => device.kind !== 'internal')) this._refreshBatteries();
            return GLib.SOURCE_CONTINUE;
        });
        this._refreshBatteries();
    }

    _dbus(path, iface, method, params, replyType) {
        return new Promise((resolve, reject) => {
            Gio.DBus.system.call(UPOWER_BUS, path, iface, method, params, new GLib.VariantType(replyType),
                Gio.DBusCallFlags.NONE, EE_CMD_TIMEOUT_MS, this._cancellable, (connection, result) => {
                    try { resolve(connection.call_finish(result)); } catch (error) { reject(error); }
                });
        });
    }

    async _refreshBatteries() {
        if (this._batteryBusy) { this._batteryAgain = true; return; }
        this._batteryBusy = true;
        try {
            const [paths] = (await this._dbus(UPOWER_PATH, UPOWER_BUS, 'EnumerateDevices', null, '(ao)')).deepUnpack();
            const next = [];
            for (const path of paths) {
                const [props] = (await this._dbus(path, 'org.freedesktop.DBus.Properties', 'GetAll',
                    new GLib.Variant('(s)', [UPOWER_DEVICE]), '(a{sv})')).recursiveUnpack();
                if (!UPOWER_AUDIO_KINDS.has(props.Type) && !UPOWER_INPUT_KINDS.has(props.Type)) continue;
                next.push({kind: props.Type, serial: props.Serial ?? '', model: props.Model ?? '', percentage: props.Percentage ?? 0});
            }
            if (this._shellEnding || !this.root) return;
            const changed = JSON.stringify(next) !== JSON.stringify(this._batteries);
            this._batteries = next;
            if (changed) this._scheduleSync();
        } catch (error) {
            if (!this._cancellable.is_cancelled()) console.warn(`[notci] audio UPower read failed: ${error.message}`);
        } finally {
            this._batteryBusy = false;
            if (this._batteryAgain && !this._cancellable.is_cancelled()) {
                this._batteryAgain = false;
                this._refreshBatteries();
            }
        }
    }

    _batteryFor(mac, label) {
        return batteryFor(this._batteries, mac, label);
    }

    // ---- GUdev: pluggable USB input devices (USB audio arrives through Gvc instead) ----

    _startUdev() {
        try {
            this._udev = new GUdev.Client({subsystems: ['usb/usb_device']});
        } catch (error) {
            console.warn(`[notci] audio udev unavailable: ${error.message}`);
            return;
        }
        this._udev.connectObject('uevent', (_client, action, device) => this._onUsbEvent(action, device), this);
        for (const device of this._udev.query_by_subsystem('usb')) {
            if (device.get_devtype() === 'usb_device') this._addUsb(device);
        }
    }

    _usbKey(device) {
        return device.get_sysfs_path() || `${device.get_property('ID_VENDOR_ID')}:${device.get_property('ID_MODEL_ID')}`;
    }

    _onUsbEvent(action, device) {
        if (this._shellEnding || this._debug) return;
        if (action === 'add') this._addUsb(device);
        else if (action === 'remove' && this._usb.delete(this._usbKey(device))) this._scheduleSync();
    }

    _addUsb(device) {
        const {accept, usbClass, label} = usbAccept({removable: device.get_sysfs_attr('removable'),
            interfaces: device.get_property('ID_USB_INTERFACES'),
            model: device.get_property('ID_MODEL_FROM_DATABASE') || device.get_property('ID_MODEL')});
        if (!accept || usbClass !== 'input') return;
        const key = this._usbKey(device);
        if (this._usb.has(key)) return;
        this._usb.set(key, normalizeDevice({id: `usb:${key}`, model: label, kind: 'usb', isAudio: false, usbClass,
            battery: this._batteryFor('', label), connectedAt: Date.now()}));
        this._scheduleSync();
    }

    // ---- EasyEffects (Flatpak): presets dir, easyeffectsrc, CLI handoff ----

    _startEasyEffects() {
        try {
            const dir = Gio.File.new_for_path(EE_PRESET_DIR);
            this._presetMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, this._cancellable);
            this._presetMonitor.connectObject('changed', () => this._scheduleEeRefresh(), this);
            const rc = Gio.File.new_for_path(EE_RC);
            this._rcMonitor = rc.monitor_file(Gio.FileMonitorFlags.NONE, this._cancellable);
            this._rcMonitor.connectObject('changed', () => this._scheduleEeRefresh(), this);
        } catch (error) {
            console.warn(`[notci] audio EasyEffects monitor failed: ${error.message}`);
        }
        this._refreshPresets();
        this._readRc();
    }

    _scheduleEeRefresh() {
        if (this._shellEnding) return;
        this._clearTimer('_eeRefreshTimer');
        this._eeRefreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_DEBOUNCE_MS, () => {
            this._eeRefreshTimer = 0;
            this._refreshPresets();
            this._readRc();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refreshPresets() {
        const dir = Gio.File.new_for_path(EE_PRESET_DIR);
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable,
            (_source, result) => {
                let names = [];
                try {
                    const enumerator = dir.enumerate_children_finish(result);
                    let info;
                    while ((info = enumerator.next_file(null))) names.push(info.get_name());
                    enumerator.close(null);
                } catch (error) {
                    if (!this._cancellable.is_cancelled() && !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                        console.warn(`[notci] audio preset list failed: ${error.message}`);
                    names = [];
                }
                if (this._shellEnding || !this.root || this._debug) return;
                this._ee.presets = presetNames(names);
                this._redraw();
            });
    }

    // KConfig is flushed on quit, not on every load: the file is the truth only while EasyEffects is off.
    _readRc() {
        Gio.File.new_for_path(EE_RC).load_contents_async(this._cancellable, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                if (this._shellEnding || !this.root || this._debug) return;
                const parsed = parseEasyeffectsrc(new TextDecoder().decode(bytes));
                this._ee.outputDevice = parsed.outputDevice;
                this._ee.processAll = parsed.processAllOutputs;
                if (!this._ee.running) this._ee.active = parsed.lastLoadedOutputPreset;
                this._redraw();
            } catch (error) {
                if (!this._cancellable.is_cancelled() && !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    console.warn(`[notci] audio easyeffectsrc read failed: ${error.message}`);
            }
        });
    }

    _eeState() {
        if (!this._settings?.get_boolean('audio-easyeffects')) return 'hidden';
        if (this._ee.stopping) return 'stopping';
        if (this._ee.applying) return 'applying';
        if (this._ee.error) return 'error';
        if (this._ee.native) return 'native';
        if (this._ee.running) return 'running';
        return this._settings.get_boolean('audio-easyeffects-autostart') ? 'off-autostart' : 'off';
    }

    _spawn(argv, timeoutMs = EE_CMD_TIMEOUT_MS) {
        return new Promise(resolve => {
            let proc;
            try {
                proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            } catch (error) {
                resolve({ok: false, stdout: '', error: error.message});
                return;
            }
            let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timer = 0;
                try { proc.force_exit(); } catch (_error) {}
                return GLib.SOURCE_REMOVE;
            });
            proc.communicate_utf8_async(null, this._cancellable, (_proc, result) => {
                if (timer) GLib.source_remove(timer);
                timer = 0;
                try {
                    const [, stdout] = proc.communicate_utf8_finish(result);
                    resolve({ok: proc.get_successful(), stdout: stdout ?? '', error: ''});
                } catch (error) {
                    resolve({ok: false, stdout: '', error: error.message});
                }
            });
        });
    }

    async _queryActivePreset() {
        if (this._debug || !this._ee.running) return;
        const {ok, stdout} = await this._spawn(['flatpak', 'run', EE_APP, '-a', 'output']);
        if (!ok || this._shellEnding || !this.root || this._debug) return;
        const name = stdout.trim().split('\n')[0] ?? '';
        if (name && name !== this._ee.active) {
            this._ee.active = name;
            this._redraw();
        }
    }

    // The running EasyEffects must be the Flatpak one: a `flatpak run -l` next to the deb build would
    // start a second primary instance (with a window) instead of handing the preset over.
    // null when `flatpak ps` itself failed: that is a retryable error, not proof of the deb build.
    async _flatpakRunning() {
        const {ok, stdout} = await this._spawn(['flatpak', 'ps', '--columns=application']);
        if (!ok) return null;
        return stdout.split('\n').some(line => line.trim() === EE_APP);
    }

    async _assertFlatpak() {
        const flatpak = await this._flatpakRunning();
        if (flatpak === null) throw new Error('flatpak ps failed');
        if (!flatpak) {
            this._ee.native = true;
            throw new Error('running EasyEffects is not the Flatpak build');
        }
    }

    // Polls the shared mixer until the EasyEffects sink is present (or absent), bounded by waitMs.
    _waitForSink(present = true, waitMs = EE_START_WAIT_MS) {
        return new Promise(resolve => {
            const deadline = GLib.get_monotonic_time() + waitMs * 1000;
            this._clearTimer('_eeWaitTimer');
            this._eeWaitTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                if (this._shellEnding || !this._mixer) { this._eeWaitTimer = 0; resolve(false); return GLib.SOURCE_REMOVE; }
                const running = this._mixer.get_sinks().some(sink => EASYEFFECTS_NODES.has(sink.get_name()));
                if (running === present || GLib.get_monotonic_time() > deadline) {
                    this._eeWaitTimer = 0;
                    resolve(running === present);
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        });
    }

    // EasyEffects only processes streams aimed at its own sink unless processAllOutputs is on; with it off a
    // preset loads silently. The key is read at startup, so it is written to easyeffectsrc while EasyEffects
    // is down (a running instance that still has it off is quit and relaunched hidden).
    async _ensureProcessAll() {
        const file = Gio.File.new_for_path(EE_RC);
        let text = '';
        try {
            const [, bytes] = await new Promise((resolve, reject) => file.load_contents_async(this._cancellable,
                (source, result) => { try { resolve(source.load_contents_finish(result)); } catch (error) { reject(error); } }));
            text = new TextDecoder().decode(bytes);
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error;
        }
        const fixed = withProcessAllOutputs(text);
        if (fixed === null) { this._ee.processAll = true; return; }
        if (this._ee.running) {
            await this._spawn(['flatpak', 'run', EE_APP, '-q']);
            if (!await this._waitForSink(false, EE_STOP_WAIT_MS)) throw new Error('EasyEffects did not stop');
            this._ee.running = false;
        }
        GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700);
        await new Promise((resolve, reject) => file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(fixed)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable,
            (source, result) => { try { source.replace_contents_finish(result); resolve(); } catch (error) { reject(error); } }));
        this._ee.processAll = true;
    }

    async _applyPreset(name) {
        if (this._ee.applying || this._debug) return;
        const previous = this._ee.active;
        this._ee.applying = true;
        this._ee.error = this._ee.native = false;
        this._ee.active = name;
        this._pauseHold();
        this._redraw();
        try {
            if (this._ee.running) await this._assertFlatpak();
            await this._ensureProcessAll();
            if (!this._ee.running) {
                if (!this._settings.get_boolean('audio-easyeffects-autostart')) throw new Error('EasyEffects is off');
                // Detached launch: the service outlives the Shell and never becomes its child.
                const app = Gio.AppInfo.create_from_commandline(EE_START.join(' '), 'EasyEffects', Gio.AppInfoCreateFlags.NONE);
                app.launch([], global.create_app_launch_context(0, -1));
                if (!await this._waitForSink()) throw new Error('EasyEffects did not start');
                this._ee.running = true;
            }
            const {ok, error} = await this._spawn(['flatpak', 'run', EE_APP, '-l', name]);
            if (!ok) throw new Error(error || 'load_preset failed');
        } catch (error) {
            console.warn(`[notci] audio preset apply failed: ${error.message}`);
            this._ee.active = previous;
            this._ee.error = !this._ee.native;
        } finally {
            this._ee.applying = false;
            if (!this._shellEnding && this.root) {
                this._redraw();
                this._resumeHold();
                if (!this._ee.error && !this._ee.native) this._queryActivePreset();
            }
        }
    }

    // Quits the hidden service; tapping a preset starts it again (hidden, like before).
    async _stopEasyEffects() {
        if (this._ee.applying || this._ee.stopping || this._debug || !this._ee.running) return;
        this._ee.stopping = true;
        this._ee.error = false;
        this._pauseHold();
        this._redraw();
        try {
            await this._assertFlatpak();
            await this._spawn(['flatpak', 'run', EE_APP, '-q']);
            if (!await this._waitForSink(false, EE_STOP_WAIT_MS)) throw new Error('EasyEffects did not stop');
            this._ee.running = false;
        } catch (error) {
            console.warn(`[notci] audio EasyEffects stop failed: ${error.message}`);
        } finally {
            this._ee.stopping = false;
            if (!this._shellEnding && this.root) {
                this._redraw();
                this._resumeHold();
            }
        }
    }

    _changeOutput(sinkId) {
        const sink = this._sinks.find(candidate => candidate.id === sinkId);
        if (!sink?.uiDevice || !this._mixer) return;
        try { this._mixer.change_output(sink.uiDevice); } catch (error) {
            console.warn(`[notci] audio output change failed: ${error.message}`);
        }
        this._armHold(IDLE_MS);
    }

    // ---- Toast and hold timers (paused while hovered, like the Spotify card) ----

    _showToast(device, connected) {
        if (!this._enabled() || this._shellEnding) { this._redraw(); this._visibility(); return; }
        if (this._expanded === 'card') { this._redraw(); this._visibility(); return; }
        const text = toastText(device, connected);
        if (this._expanded === 'toast') {
            // Same card, new words: no second morph.
            this._celebrate = connected ? device.id : null;
            this._toast = {...text, device, connected};
            this._redraw();
            this._visibility();
            this._armHold(this._settings.get_int('audio-toast-seconds') * 1000);
            return;
        }
        if (!this._dock?.claim(PRIORITY_TOAST)) { this._redraw(); this._visibility(); return; }
        this._celebrate = connected ? device.id : null;
        this._toast = {...text, device, connected};
        this._expanded = 'toast';
        this._render();
        this._armHold(this._settings.get_int('audio-toast-seconds') * 1000);
    }

    _armHold(ms) {
        this._clearTimer('_holdTimer');
        this._holdUntil = GLib.get_monotonic_time() + ms * 1000;
        // Pointer still on the card (chip tap, preset result, toast update): stay paused; leaving resumes.
        this._holdLeft = this._ui?.card?.hover ? ms : 0;
        if (this._holdLeft) return;
        this._holdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._holdTimer = 0;
            this.collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearHold() {
        this._clearTimer('_holdTimer');
        this._holdUntil = this._holdLeft = 0;
    }

    _pauseHold() {
        if (!this._holdUntil) return;
        this._holdLeft ||= Math.max(1, Math.round((this._holdUntil - GLib.get_monotonic_time()) / 1000));
        this._clearTimer('_holdTimer');
    }

    _resumeHold() {
        if (this._holdLeft && !this._holdTimer && !this._ee.applying && !this._ee.stopping) {
            this._holdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DESIGN.motion.hoverResume, () => {
                this._holdTimer = 0;
                this._armHold(this._holdLeft);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _onCardHover(hovered) {
        if (hovered) this._pauseHold(); else this._resumeHold();
    }

    // ---- Rendering (same shape as the Spotify module) ----

    _visibility() {
        if (this._shellEnding || !this._dock) return;
        const expanded = this._expanded !== null;
        const visible = this._visible() && !Main.overview.visible && !Main.sessionMode.isLocked &&
            !Main.layoutManager.primaryMonitor?.inFullscreen;
        this._dock.update({width: expanded ? DESIGN.geometry.expandedWide : this._compactWidth || DESIGN.geometry.spotifyCompact,
            height: expanded ? this._expandedHeight ?? DESIGN.geometry.spotifyExpandedHeight : DESIGN.control.compactHeight,
            visible, expanded});
        this._maybePulseLow();
    }

    // The only entry point: plays once, on the compact pill, when it is actually on screen.
    _maybePulseLow() {
        const ring = this._ui?.button ? this._ui.ring : null;
        const area = ring?.area;
        const device = this._shownDevice();
        if (!device || !LOW_PENDING.has(device.id) || this._expanded !== null || !area?.mapped || !lowStage(device.battery))
            return;
        if (!this._visible() || Main.overview.visible || Main.sessionMode.isLocked ||
            Main.layoutManager.primaryMonitor?.inFullscreen) return;
        LOW_PENDING.delete(device.id);
        if (!St.Settings.get().enable_animations) return;
        // Start after the ring has stopped moving (connect fill or level slide), then the usual alert gap.
        const timeline = ring.timeline;
        const busy = timeline ? timeline.get_delay() + timeline.get_duration() - timeline.get_elapsed_time() : 0;
        area.remove_transition('opacity');
        area.opacity = 255;
        area.ease({...LOW_PULSE, delay: DESIGN.motion.alertGap + Math.max(0, busy)});
    }

    _render(afterCollapse = false) {
        if (this._shellEnding || !this.root) return;
        const expanded = this._expanded !== null;
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
        const child = expanded ? this._buildCard(this._expanded === 'toast') : this._buildCompact();
        this._rendering = true;
        try { this._redraw(); } finally { this._rendering = false; }
        if (this.root.get_stage()) {
            ensureStyle(this.root);
            if (expanded) {
                this._measureCard();
            } else if (!this._compactWidth) {
                // Measured once with the ring shown, so the row never re-snaps between devices.
                this._ui.ring.area.visible = true;
                const [, natural] = child.get_preferred_width(-1);
                this._compactWidth = Math.ceil(natural);
                this._redraw();
            }
        }
        this._visibility();
        if (St.Settings.get().enable_animations) {
            const drop = {opacity: 0, translation_y: -DESIGN.motion.contentShift};
            const settled = {opacity: 255, translation_y: 0};
            const entrances = [];
            if (opening) {
                entrances.push([this._ui.header, {...settled, duration: DESIGN.motion.primaryDuration, delay: DESIGN.motion.primaryDelay}]);
                if (this._ui.body)
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
        if (expanded && focusWasInside) (this._ui.firstChip ?? this._ui.button)?.grab_key_focus();
    }

    _buildCompact() {
        const button = new St.Button({style_class: 'notci-compact-module', can_focus: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const row = new St.BoxLayout({style_class: 'notci-audio-compact', y_align: Clutter.ActorAlign.CENTER});
        this._ui.icon = new St.Icon({icon_size: ICON_COMPACT, y_align: Clutter.ActorAlign.CENTER});
        this._ui.ring = createRing('notci-audio-ring', 'notci-ring-compact');
        row.add_child(this._ui.icon);
        row.add_child(this._ui.ring.area);
        button.set_child(row);
        button.connect('clicked', () => this.toggle());
        this.root.add_child(button);
        this._ui.button = button;
        return button;
    }

    _buildCard(toast) {
        const card = new St.BoxLayout({vertical: true, style_class: 'notci-card', reactive: true, track_hover: true, x_expand: true});
        card.connect('notify::hover', () => this._onCardHover(card.hover));
        // Empty-area click folds the card; buttons act first (GNOME 50: get_event_actor, not get_source).
        card.connect('button-release-event', (_actor, event) => {
            let source = null;
            try { source = global.stage.get_event_actor(event); } catch (_error) {}
            const passive = [card, header, column, this._ui.body, this._ui.title, this._ui.subtitle, this._ui.caption,
                this._ui.ringBox, this._ui.ring?.area, this._ui.ringText,
                this._ui.outputs, this._ui.presets, this._ui.note, this._ui.outputsLabel, this._ui.presetsLabel,
                ...(this._ui.outputs?.get_children() ?? []), ...(this._ui.presets?.get_children() ?? [])];
            if (!passive.includes(source)) return Clutter.EVENT_PROPAGATE;
            this.collapse();
            return Clutter.EVENT_STOP;
        });
        const header = new St.BoxLayout({style_class: 'notci-card-row', x_expand: true});
        const art = new St.Bin({style_class: 'notci-device-art', y_align: Clutter.ActorAlign.CENTER});
        this._ui.icon = new St.Icon({icon_size: ICON_HEADER, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        art.set_child(this._ui.icon);
        header.add_child(art);
        const column = new St.BoxLayout({vertical: true, style_class: 'notci-card-column', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._ui.title = this._label('notci-title');
        this._ui.subtitle = this._label('notci-accent-text');
        this._ui.caption = this._label('notci-caption');
        for (const label of [this._ui.title, this._ui.subtitle, this._ui.caption]) column.add_child(label);
        header.add_child(column);
        // Ring with the percentage inside: same right-hand cluster as the pill, scaled up.
        this._ui.ring = createRing('notci-audio-ring', 'notci-ring-card');
        this._ui.ringBox = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._ui.ringText = new St.Label({style_class: 'notci-caption notci-tnum notci-ring-text',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._ui.ringBox.add_child(this._ui.ring.area);
        this._ui.ringBox.add_child(this._ui.ringText);
        header.add_child(this._ui.ringBox);
        card.add_child(header);
        Object.assign(this._ui, {card, header});
        if (!toast) {
            const body = new St.BoxLayout({vertical: true, style_class: 'notci-card-column notci-audio-body', x_expand: true});
            this._ui.outputsLabel = this._label('notci-caption');
            this._ui.outputsLabel.text = '출력';
            body.add_child(this._ui.outputsLabel);
            this._ui.outputs = this._chipRow();
            body.add_child(this._ui.outputs);
            if (this._eeState() !== 'hidden') {
                this._ui.presetsLabel = this._label('notci-caption');
                this._ui.presetsLabel.text = 'EasyEffects 프리셋';
                body.add_child(this._ui.presetsLabel);
                this._ui.presets = this._chipRow();
                body.add_child(this._ui.presets);
                this._ui.note = this._label('notci-caption');
                body.add_child(this._ui.note);
            }
            card.add_child(body);
            this._ui.body = body;
        }
        this.root.add_child(card);
        return card;
    }

    // Connect moment: the device icon springs in while the ring fills.
    _pop(icon) {
        if (!icon || !St.Settings.get().enable_animations) return;
        icon.set_pivot_point(0.5, 0.5);
        icon.remove_transition('scale-x');
        icon.remove_transition('scale-y');
        icon.scale_x = icon.scale_y = POP_FROM;
        icon.ease({scale_x: 1, scale_y: 1, duration: POP_MS, delay: RING_FILL_DELAY, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    // The device the visible tree is about: the toast's device while a toast shows, else the primary.
    _shownDevice() {
        return this._expanded === 'toast' && this._toast ? this._toast.device : this._primary;
    }

    // Ring and the connect pop for whichever tree is built.
    _drawDevice(device, connected = true) {
        const ui = this._ui;
        const view = connected ? compactView(device) : null;
        // The connect fill waits for a known battery (it may arrive after the toast opens).
        const fill = Boolean(device && connected && this._celebrate === device.id && view?.fraction !== null &&
            view?.fraction !== undefined);
        if (fill) this._celebrate = null;
        setRing(ui.ring, view?.fraction ?? null, view?.tone ? `notci-battery-${view.tone}` : null, fill);
        if (ui.ring && view?.tone !== 'critical') {
            // Charged or switched device mid-pulse: back to solid at once.
            ui.ring.area.remove_transition('opacity');
            ui.ring.area.opacity = 255;
        }
        if (ui.ringBox) ui.ringBox.visible = view?.fraction !== null && view?.fraction !== undefined;
        if (ui.ringText) ui.ringText.text = view?.batteryText ?? '';
        if (fill) this._pop(ui.icon);
    }

    _chipRow() {
        return new St.BoxLayout({vertical: true, style_class: 'notci-chip-rows', x_expand: true});
    }

    // Chips wrap into rows by their measured width: deterministic height for the slab, no FlowLayout.
    _fillChips(container, buttons) {
        container.destroy_all_children();
        const available = DESIGN.geometry.expandedWide - (this._ui.card?.get_theme_node().get_horizontal_padding() ?? 32);
        let row = null;
        let used = 0;
        for (const button of buttons) {
            container.add_child(button);          // on stage via the container: style resolves, width measures
            ensureStyle(button);
            const [, width] = button.get_preferred_width(-1);
            container.remove_child(button);
            if (!row || used + CHIP_GAP + width > available) {
                row = new St.BoxLayout({style_class: 'notci-chip-row'});
                container.add_child(row);
                used = 0;
            }
            row.add_child(button);
            used += (used ? CHIP_GAP : 0) + width;
        }
    }

    _chip({label, icon = null, active = false, accessibleName = label}, onClick) {
        const button = new St.Button({style_class: active ? 'notci-chip notci-chip-active' : 'notci-chip', can_focus: true,
            accessible_name: accessibleName});
        const row = new St.BoxLayout({style_class: 'notci-chip-inner', y_align: Clutter.ActorAlign.CENTER});
        if (icon) row.add_child(new St.Icon({icon_name: icon, icon_size: ICON_CHIP, y_align: Clutter.ActorAlign.CENTER}));
        const text = new St.Label({text: label, style_class: 'notci-chip-label', y_align: Clutter.ActorAlign.CENTER});
        text.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        row.add_child(text);
        button.set_child(row);
        button.connect('clicked', onClick);
        return button;
    }

    _label(styleClass) {
        const label = new St.Label({style_class: styleClass, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        return label;
    }

    // Measured from the styled tree; true when the island has to be resized.
    _measureCard() {
        const card = this._ui?.card;
        if (!card || this._expanded === null || this._closingTimer || !this.root?.get_stage()) return false;
        ensureStyle(this.root);
        const [, natural] = card.get_preferred_height(DESIGN.geometry.expandedWide);
        const height = Math.ceil(natural);
        if (height === this._expandedHeight) return false;
        this._expandedHeight = height;
        return true;
    }

    // Updates the live bits in place; the tree is rebuilt only on expand/collapse.
    _redraw() {
        const ui = this._ui;
        if (!ui || !this.root || this._shellEnding) return;
        const compact = compactView(this._primary);
        if (ui.button) {
            ui.icon.icon_name = compact?.icon ?? 'audio-card-symbolic';
            ui.button.accessible_name = compact?.accessibleName ?? '오디오';
            this._drawDevice(this._primary);
            return;
        }
        if (!ui.card) return;
        // The toast keeps its words, but battery/codec come from the live device (UPower may answer late).
        const toastDevice = this._expanded === 'toast' && this._toast ?
            this._devices.find(device => device.id === this._toast.device.id) ?? this._toast.device : null;
        const header = toastDevice ?
            {title: this._toast.title, subtitle: this._toast.subtitle, caption: '', icon: compactView(toastDevice)?.icon} :
            cardHeader(this._primary, Date.now());
        ui.icon.icon_name = header.icon ?? 'audio-card-symbolic';
        ui.title.text = header.title;
        ui.subtitle.text = header.subtitle;
        ui.subtitle.visible = Boolean(header.subtitle);
        ui.caption.text = header.caption;
        ui.caption.visible = Boolean(header.caption);
        if (toastDevice)
            this._drawDevice(toastDevice, this._toast.connected);
        else
            this._drawDevice(this._primary);
        if (ui.body) this._redrawBody(ui);
        // "적용 중…", "적용 실패" or a new output chip row change the height of an open card.
        if (!this._rendering && this._measureCard()) this._visibility();
    }

    _redrawBody(ui) {
        const outputs = outputChips(this._sinks, this._defaultSink, this._ee.outputDevice).map(chip =>
            this._chip({label: chip.label, icon: chip.icon, active: chip.active,
                accessibleName: `${chip.label}${chip.active ? ', 현재 출력' : ''}`}, () => this._changeOutput(chip.id)));
        this._fillChips(ui.outputs, outputs);
        ui.firstChip = outputs[0] ?? null;
        if (!ui.presets) return;
        const state = this._eeState();
        const {chips, note, enabled, offChip} = presetChips(this._ee.presets, this._ee.active, state);
        const buttons = chips.map(chip => {
            const button = this._chip({label: chip.name, active: chip.active,
                accessibleName: `프리셋 ${chip.name}${chip.active ? ', 적용됨' : ''}`}, () => this._applyPreset(chip.name));
            button.reactive = button.can_focus = enabled && !this._ee.applying;
            return button;
        });
        if (offChip && chips.length) {
            buttons.push(this._chip({label: '끄기', icon: 'system-shutdown-symbolic',
                accessibleName: 'EasyEffects 끄기, 효과와 메모리를 내려놓음'}, () => this._stopEasyEffects()));
        }
        this._fillChips(ui.presets, buttons);
        ui.note.text = chips.length ? note : '저장된 프리셋 없음';
        ui.note.visible = Boolean(ui.note.text);
    }
}

// Pure helpers for the audio/peripheral module. No GI imports: node:test runs them as-is.

// UPower DeviceKind values (UPowerGlib 1.0, verified 2026-10-23): MOUSE 5, KEYBOARD 6,
// HEADSET 17, SPEAKERS 18, HEADPHONES 19, OTHER_AUDIO 21.
export const UPOWER_AUDIO_KINDS = new Set([17, 18, 19, 21]);
export const UPOWER_INPUT_KINDS = new Set([5, 6]);
// EasyEffects' own virtual nodes are never an output the user picks.
export const EASYEFFECTS_NODES = new Set(['easyeffects_sink', 'easyeffects_source']);

const CODEC_LABELS = {ldac: 'LDAC', aac: 'AAC', sbc: 'SBC', sbc_xq: 'SBC-XQ', aptx: 'aptX', aptx_hd: 'aptX HD',
    aptx_ll: 'aptX LL', lc3: 'LC3', lc3_swb: 'LC3-SWB', opus: 'Opus', opus_g: 'Opus', msbc: 'mSBC', cvsd: 'CVSD',
    faststream: 'FastStream'};

const str = value => typeof value === 'string' ? value : '';

export function codecLabel(raw) {
    const key = str(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!key) return '';
    return CODEC_LABELS[key] ?? str(raw).trim().toUpperCase();
}

// Gvc exposes the codec only inside the card's human profile:
// "High Fidelity Playback (A2DP Sink, codec LDAC)" → "LDAC". Profile ids like a2dp-sink-ldac also work.
export function codecFromProfile(humanProfile) {
    const text = str(humanProfile);
    const match = /codec ([^)]+)\)/i.exec(text) ?? /^a2dp-(?:sink|source|duplex)-([a-z0-9_]+)$/i.exec(text);
    return match ? codecLabel(match[1]) : '';
}

// bluez_output.AA_BB_CC_DD_EE_FF.1 or bluez_card.AA:BB:CC:DD:EE:FF → AA:BB:CC:DD:EE:FF
export function macFromSinkName(name) {
    const match = /([0-9A-F]{2}[:_]){5}[0-9A-F]{2}/i.exec(str(name));
    return match ? match[0].replaceAll('_', ':').toUpperCase() : '';
}

export function batteryTone(percent) {
    if (!Number.isFinite(percent) || percent < 0) return null;
    if (percent < 20) return 'critical';
    if (percent < 50) return 'low';
    return 'ok';
}

// Sink name → kind. PipeWire names: bluez_output.*, alsa_output.usb-*, alsa_output.pci-*.
export function sinkKind(name) {
    const text = str(name);
    if (text.startsWith('bluez_')) return 'bluetooth';
    if (/\.usb-/i.test(text)) return 'usb';
    return 'internal';
}

export function deviceIcon({kind, formFactor, usbClass} = {}) {
    if (usbClass === 'input') return 'input-mouse-symbolic';
    const factor = str(formFactor);
    if (factor === 'headset' || factor === 'headphone' || factor === 'headphones') return 'audio-headphones-symbolic';
    if (factor === 'speaker') return 'audio-speakers-symbolic';
    return kind === 'bluetooth' ? 'audio-headphones-symbolic' : 'audio-card-symbolic';
}

// Shell-side raw sink → plain device. `isPill` says whether it earns the always-on compact pill:
// external audio outputs do, the laptop's own card never does.
export function normalizeDevice(raw) {
    const name = str(raw?.name);
    const kind = str(raw?.kind) || sinkKind(name);
    const battery = Number.isFinite(raw?.battery) ? Math.round(raw.battery) : null;
    const isAudio = raw?.isAudio !== false;
    return {
        id: str(raw?.id) || name,
        name,
        label: str(raw?.description) || str(raw?.model) || name || '알 수 없는 기기',
        kind,
        isAudio,
        usbClass: str(raw?.usbClass) || (isAudio ? 'audio' : ''),
        mac: str(raw?.mac) || macFromSinkName(name),
        codec: codecLabel(raw?.codec),
        formFactor: str(raw?.formFactor),
        battery,
        isPill: isAudio ? kind !== 'internal' : battery !== null,
        connectedAt: Number.isFinite(raw?.connectedAt) ? raw.connectedAt : 0,
    };
}

// Which device the compact pill shows: external audio (the default output first), then anything
// that reports a battery, newest connection breaking ties. null → no pill.
export function pickPrimary(devices, defaultSinkName = '') {
    const candidates = (devices ?? []).filter(device => device.isPill);
    if (!candidates.length) return null;
    const score = device => (device.isAudio ? 4 : 0) + (device.name === defaultSinkName ? 2 : 0) +
        (device.battery !== null ? 1 : 0);
    return [...candidates].sort((a, b) => score(b) - score(a) || b.connectedAt - a.connectedAt)[0];
}

// Address-set difference: a device already known is never announced again.
export function diffDevices(previous, next) {
    const before = new Map((previous ?? []).map(device => [device.id, device]));
    const after = new Map((next ?? []).map(device => [device.id, device]));
    return {
        added: [...after.values()].filter(device => !before.has(device.id)),
        removed: [...before.values()].filter(device => !after.has(device.id)),
    };
}

// GUdev usb_device → accept only pluggable audio or HID (boot mouse/keyboard) devices.
// ID_USB_INTERFACES is ":ccsspp:" per interface: audio control 0101, audio streaming 0102
// (0103 is MIDI), HID boot interface 0301. Built-in webcam/fingerprint/BT report removable=fixed.
export function usbAccept({removable, interfaces, model} = {}) {
    if (str(removable) !== 'removable') return {accept: false, usbClass: null, label: ''};
    const tokens = str(interfaces).split(':').filter(Boolean);
    const audio = tokens.some(token => /^010[12]/.test(token));
    const input = tokens.some(token => /^0301/.test(token));
    // ponytail: HID without a boot interface (:030000:) is skipped — it also matches UPS/YubiKey;
    // widen with ID_INPUT_* from the child input device if a real mouse ever falls through.
    const usbClass = audio ? 'audio' : input ? 'input' : null;
    return {accept: usbClass !== null, usbClass, label: usbClass ? str(model).replaceAll('_', ' ').trim() : ''};
}

// Preset files → names: Latin/digit names first, then Korean, each in locale order (stable across ICU builds).
export function presetNames(fileNames) {
    const bucket = name => /^[A-Za-z0-9]/.test(name) ? 0 : 1;
    return (fileNames ?? []).filter(name => typeof name === 'string' && name.endsWith('.json'))
        .map(name => name.slice(0, -5)).filter(Boolean)
        .sort((a, b) => bucket(a) - bucket(b) || a.localeCompare(b, 'ko'));
}

// KConfig INI: "[Presets]\nlastLoadedOutputPreset=Name", "[StreamOutputs]\noutputDevice=sink" and
// "[EffectsPipelines]\nprocessAllOutputs=true|false" (absent = false: EasyEffects 8.3 writes it explicitly).
export function parseEasyeffectsrc(text) {
    const result = {lastLoadedOutputPreset: '', outputDevice: '', processAllOutputs: false};
    let group = '';
    for (const rawLine of str(text).split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('[')) {
            group = line.slice(1, line.indexOf(']') > 0 ? line.indexOf(']') : undefined);
            continue;
        }
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).replace(/\[.*\]$/, '').trim();
        const value = line.slice(eq + 1).trim();
        if (group === 'Presets' && key === 'lastLoadedOutputPreset') result.lastLoadedOutputPreset = value;
        if (group === 'StreamOutputs' && key === 'outputDevice') result.outputDevice = value;
        if (group === 'EffectsPipelines' && key === 'processAllOutputs') result.processAllOutputs = value === 'true';
    }
    return result;
}

// With processAllOutputs=false EasyEffects only touches streams aimed at its own sink, so a preset
// loads but nothing is heard (probed 2026-10-23: Spotify stayed linked to the headset). Returns the
// file text with the key forced on, or null when it already is.
export function withProcessAllOutputs(text) {
    const source = str(text);
    if (parseEasyeffectsrc(source).processAllOutputs) return null;
    if (/^processAllOutputs=.*$/m.test(source)) return source.replace(/^processAllOutputs=.*$/m, 'processAllOutputs=true');
    if (/^\[EffectsPipelines\]\s*$/m.test(source))
        return source.replace(/^\[EffectsPipelines\]\s*$/m, '[EffectsPipelines]\nprocessAllOutputs=true');
    return `${source}${source.endsWith('\n') || !source ? '' : '\n'}[EffectsPipelines]\nprocessAllOutputs=true\n`;
}

// Output chips: every real sink, EasyEffects' virtual nodes dropped. When the default output is
// the EasyEffects sink, the chip that lights up is the device EasyEffects itself writes to.
export function outputChips(sinks, defaultSinkName, eeOutputDevice = '') {
    const activeName = EASYEFFECTS_NODES.has(str(defaultSinkName)) ? str(eeOutputDevice) : str(defaultSinkName);
    return (sinks ?? []).filter(sink => sink && !EASYEFFECTS_NODES.has(str(sink.name))).map(sink => ({
        id: sink.id,
        name: str(sink.name),
        label: shortLabel(sink.description),
        icon: deviceIcon({kind: sinkKind(sink.name), formFactor: sink.formFactor}),
        active: str(sink.name) === activeName,
    }));
}

// "Ryzen HD Audio Controller 아날로그 스테레오" → "Ryzen HD Audio Controller"; keeps short names whole.
export function shortLabel(description, max = 28) {
    const text = str(description).replace(/\s+(아날로그|디지털|Analog|Digital)\s.*$/i, '').trim();
    if (!text) return '출력';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function connectedFor(connectedAtMs, nowMs) {
    const minutes = Math.floor(Math.max(0, nowMs - connectedAtMs) / 60000);
    if (minutes < 1) return '방금 연결';
    if (minutes < 60) return `${minutes}분 전 연결`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}시간 전 연결` : `${Math.floor(hours / 24)}일 전 연결`;
}

export function batteryText(battery) {
    return battery === null || battery === undefined ? '' : `${battery}%`;
}

// Compact pill: icon + battery ring (no name). Returns null when nothing earns a pill.
export function compactView(primary) {
    if (!primary) return null;
    const battery = batteryText(primary.battery);
    return {
        icon: deviceIcon(primary),
        batteryText: battery,
        tone: batteryTone(primary.battery),
        // Battery ring fill 0..1, null when the device reports none (no ring is drawn).
        fraction: primary.battery === null ? null : Math.min(1, Math.max(0, primary.battery / 100)),
        accessibleName: [primary.label, battery, batteryTone(primary.battery) === 'critical' ? '배터리 부족' : '']
            .filter(Boolean).join(' · '),
    };
}

// Battery for a sink or USB device from the cached UPower list ({kind, serial, model, percentage}):
// MAC == UPower serial first, then a model/label match. 0% means "not reported" for Bluetooth headsets.
export function batteryFor(batteries, mac, label) {
    const text = str(label).toLowerCase();
    for (const device of batteries ?? []) {
        if (!UPOWER_AUDIO_KINDS.has(device.kind) && !UPOWER_INPUT_KINDS.has(device.kind)) continue;
        const serial = str(device.serial).toUpperCase();
        const model = str(device.model).toLowerCase();
        const match = (mac && serial === mac) || (model && text && (model === text || text.includes(model) || model.includes(text)));
        if (match && Number.isFinite(device.percentage) && device.percentage > 0) return device.percentage;
    }
    return null;
}

// Low-battery alert, AOSP PowerUI style: fire once on each downward step into <20 and <=10, re-arm at 25.
// The step boundary is the red tone (batteryTone 'critical'), so the pulse always comes with the red ring.
export function lowStage(battery) {
    if (!Number.isFinite(battery)) return 0;
    return battery <= 10 ? 2 : battery < 20 ? 1 : 0;
}

export function lowAlertStep(recorded = 0, battery) {
    if (!Number.isFinite(battery)) return {stage: recorded, fire: false};
    if (battery >= 25) return {stage: 0, fire: false};
    const stage = lowStage(battery);
    return stage > recorded ? {stage, fire: true} : {stage: recorded, fire: false};
}

// Toast copy for connect/disconnect.
export function toastText(device, connected) {
    // Battery is in the ring next to the text, not repeated here.
    return {
        title: `${device.label} ${connected ? '연결됨' : '연결 해제'}`,
        subtitle: connected ? device.codec || (device.usbClass === 'input' ? 'USB 입력기기' : '오디오 출력') : '',
    };
}

// Card header lines for the primary device (or the current output when nothing external is on).
export function cardHeader(primary, nowMs = 0) {
    if (!primary) return {title: '오디오', subtitle: '연결된 기기 없음', caption: '', icon: 'audio-card-symbolic'};
    const subtitle = [primary.codec, primary.kind === 'bluetooth' ? '블루투스' : primary.kind === 'usb' ? 'USB' : '']
        .filter(Boolean).join(' · ');
    const caption = primary.connectedAt ? connectedFor(primary.connectedAt, nowMs) : '';
    return {title: primary.label, subtitle, caption, icon: deviceIcon(primary)};
}

// Preset chips: names with the active one marked; `eeState` drives the note under the row.
export function presetChips(names, activePreset, eeState = 'off') {
    const chips = (names ?? []).map(name => ({name, active: name === activePreset}));
    const note = eeState === 'applying' ? '적용 중…' : eeState === 'stopping' ? '끄는 중…' : eeState === 'off' ? 'EasyEffects 꺼짐' :
        eeState === 'error' ? '적용 실패' : eeState === 'native' ? '다른 EasyEffects가 켜져 있음' : '';
    // offChip: the hidden service is ours and idle, so it can be quit (~200 MB and its DSP CPU back).
    // 'error' stays tappable: a retry clears it (_applyPreset resets the flags first).
    return {chips, note, enabled: ['running', 'off-autostart', 'error'].includes(eeState), offChip: eeState === 'running'};
}

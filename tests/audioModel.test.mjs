import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codecLabel, codecFromProfile, macFromSinkName, batteryTone, sinkKind, deviceIcon, normalizeDevice,
    pickPrimary, diffDevices, usbAccept, presetNames, parseEasyeffectsrc, withProcessAllOutputs, outputChips, shortLabel,
    connectedFor, compactView, batteryFor, lowStage, lowAlertStep, toastText, cardHeader, presetChips} from '../extension/modules/audioModel.js';

test('codec comes out of the Gvc card profile text or the a2dp profile id', () => {
    assert.equal(codecFromProfile('High Fidelity Playback (A2DP Sink, codec LDAC)'), 'LDAC');
    assert.equal(codecFromProfile('High Fidelity Duplex (A2DP Source/Sink, codec aptX HD)'), 'aptX HD');
    assert.equal(codecFromProfile('a2dp-sink-sbc_xq'), 'SBC-XQ');
    assert.equal(codecFromProfile('Analog Stereo Output'), '');
    assert.equal(codecFromProfile(undefined), '');
    assert.equal(codecLabel('ldac'), 'LDAC');
    assert.equal(codecLabel('weird'), 'WEIRD');
});

test('MAC is lifted out of bluez sink and card names', () => {
    assert.equal(macFromSinkName('bluez_output.AA_BB_CC_DD_EE_FF.1'), 'AA:BB:CC:DD:EE:FF');
    assert.equal(macFromSinkName('bluez_card.aa:bb:cc:dd:ee:ff'), 'AA:BB:CC:DD:EE:FF');
    assert.equal(macFromSinkName('alsa_output.pci-0000_04_00.6.analog-stereo'), '');
    assert.equal(sinkKind('bluez_output.AA_BB_CC_DD_EE_FF.1'), 'bluetooth');
    assert.equal(sinkKind('alsa_output.usb-Sony_WH-1000XM5-00.analog-stereo'), 'usb');
    assert.equal(sinkKind('alsa_output.pci-0000_04_00.6.analog-stereo'), 'internal');
});

test('battery tone follows the 50/20 rule and tolerates unknown values', () => {
    assert.equal(batteryTone(87), 'ok');
    assert.equal(batteryTone(50), 'ok');
    assert.equal(batteryTone(49), 'low');
    assert.equal(batteryTone(19), 'critical');
    assert.equal(batteryTone(null), null);
    assert.equal(batteryTone(-1), null);
});

test('usbAccept keeps pluggable audio and boot HID, drops the laptop internals (2026-10-23 probe)', () => {
    const reject = {accept: false, usbClass: null, label: ''};
    assert.deepEqual(usbAccept({removable: 'fixed', interfaces: ':0e0100:0e0200:', model: 'USB2.0_FHD_UVC_WebCam'}), reject);
    assert.deepEqual(usbAccept({removable: 'fixed', interfaces: ':ffffff:', model: 'FocalTech_Fingerprint_Device'}), reject);
    assert.deepEqual(usbAccept({removable: 'fixed', interfaces: ':e00101:', model: 'Wireless_Device'}), reject);
    assert.deepEqual(usbAccept({removable: 'unknown', interfaces: ':090000:', model: '2.0 root hub'}), reject);
    assert.deepEqual(usbAccept({removable: 'removable', interfaces: ':030102:030000:', model: 'USB_Optical_Mouse'}),
        {accept: true, usbClass: 'input', label: 'USB Optical Mouse'});
    assert.deepEqual(usbAccept({removable: 'removable', interfaces: ':010100:010200:030000:', model: 'USB_Headset'}),
        {accept: true, usbClass: 'audio', label: 'USB Headset'});
    assert.deepEqual(usbAccept({removable: 'removable', interfaces: ':010300:', model: 'MIDI_Keys'}), reject);
    assert.deepEqual(usbAccept({removable: 'removable', interfaces: ':080650:', model: 'Flash_Drive'}), reject);
    assert.deepEqual(usbAccept({}), reject);
});

test('normalizeDevice derives kind, mac, codec label and the pill rule', () => {
    const xm5 = normalizeDevice({id: 's1', name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', description: 'WH-1000XM5',
        codec: 'ldac', formFactor: 'headset', battery: 87.4, connectedAt: 1000});
    assert.equal(xm5.kind, 'bluetooth');
    assert.equal(xm5.mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(xm5.codec, 'LDAC');
    assert.equal(xm5.battery, 87);
    assert.equal(xm5.isPill, true);
    const internal = normalizeDevice({id: 's0', name: 'alsa_output.pci-0000_04_00.6.analog-stereo', description: 'Ryzen HD Audio'});
    assert.equal(internal.isPill, false);
    assert.equal(internal.battery, null);
    const mouse = normalizeDevice({id: 'usb:046d:c52b', name: '', model: 'Logitech USB Receiver', kind: 'usb', isAudio: false, usbClass: 'input'});
    assert.equal(mouse.isPill, false);
    assert.equal(mouse.label, 'Logitech USB Receiver');
    const mouseWithBattery = normalizeDevice({...mouse, battery: 60});
    assert.equal(mouseWithBattery.isPill, true);
});

test('pickPrimary prefers external audio on the default output, then battery devices, else none', () => {
    const internal = normalizeDevice({id: 'a', name: 'alsa_output.pci-x.analog-stereo', description: 'Ryzen'});
    const usbDac = normalizeDevice({id: 'b', name: 'alsa_output.usb-DAC.analog-stereo', description: 'DAC', connectedAt: 5});
    const xm5 = normalizeDevice({id: 'c', name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', description: 'XM5', battery: 80, connectedAt: 1});
    const mouse = normalizeDevice({id: 'd', name: '', model: 'Mouse', kind: 'usb', isAudio: false, usbClass: 'input', battery: 40});
    assert.equal(pickPrimary([internal]), null);
    assert.equal(pickPrimary([internal, mouse]).id, 'd');
    assert.equal(pickPrimary([internal, usbDac, xm5], 'alsa_output.usb-DAC.analog-stereo').id, 'b');
    assert.equal(pickPrimary([internal, usbDac, xm5], 'alsa_output.pci-x.analog-stereo').id, 'c');
    assert.equal(pickPrimary([], ''), null);
});

test('diffDevices announces only newcomers and departures', () => {
    const a = {id: 'a'}, b = {id: 'b'}, c = {id: 'c'};
    assert.deepEqual(diffDevices([a, b], [b, c]), {added: [c], removed: [a]});
    assert.deepEqual(diffDevices(null, [a]), {added: [a], removed: []});
    assert.deepEqual(diffDevices([a], [a]), {added: [], removed: []});
});

test('preset names come from json files only, in Korean collation', () => {
    assert.deepEqual(presetNames(['Shoegaze_XM4_Immersive.json', 'notes.txt', 'BassDrop_Metal_FullChain.json', '일반 이퀄.json', '.json']),
        ['BassDrop_Metal_FullChain', 'Shoegaze_XM4_Immersive', '일반 이퀄']);
    assert.deepEqual(presetNames(undefined), []);
});

test('parseEasyeffectsrc reads the KConfig groups EasyEffects 8 writes', () => {
    const text = '[General]\nx=1\n\n[Presets]\nlastLoadedInputPreset=\nlastLoadedOutputPreset=Shoegaze_XM4_Immersive\n' +
        '[StreamOutputs]\noutputDevice=bluez_output.AA_BB_CC_DD_EE_FF.1\nprocessAllOutputs=false\n';
    assert.deepEqual(parseEasyeffectsrc(text), {lastLoadedOutputPreset: 'Shoegaze_XM4_Immersive',
        outputDevice: 'bluez_output.AA_BB_CC_DD_EE_FF.1', processAllOutputs: false});
    assert.deepEqual(parseEasyeffectsrc(''), {lastLoadedOutputPreset: '', outputDevice: '', processAllOutputs: false});
    assert.equal(parseEasyeffectsrc('[EffectsPipelines]\nprocessAllOutputs=true\n').processAllOutputs, true);
    assert.equal(parseEasyeffectsrc('[Presets]\nlastLoadedOutputPreset[$e]=A B\n').lastLoadedOutputPreset, 'A B');
});

test('withProcessAllOutputs forces the key on in place, adds it, or leaves a correct file alone', () => {
    assert.equal(withProcessAllOutputs('[EffectsPipelines]\nprocessAllOutputs=true\n[Presets]\n'), null);
    assert.equal(withProcessAllOutputs('[EffectsPipelines]\nprocessAllOutputs=false\n\n[Presets]\nx=1\n'),
        '[EffectsPipelines]\nprocessAllOutputs=true\n\n[Presets]\nx=1\n');
    assert.equal(withProcessAllOutputs('[EffectsPipelines]\nother=1\n'), '[EffectsPipelines]\nprocessAllOutputs=true\nother=1\n');
    assert.equal(withProcessAllOutputs('[Presets]\nx=1\n'), '[Presets]\nx=1\n[EffectsPipelines]\nprocessAllOutputs=true\n');
    assert.equal(withProcessAllOutputs(''), '[EffectsPipelines]\nprocessAllOutputs=true\n');
});

test('outputChips drops EasyEffects nodes and lights the device EasyEffects routes to', () => {
    const sinks = [
        {id: 58, name: 'alsa_output.pci-0000_04_00.6.analog-stereo', description: 'Ryzen HD Audio Controller 아날로그 스테레오'},
        {id: 75, name: 'easyeffects_sink', description: 'Easy Effects Sink'},
        {id: 90, name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', description: 'WH-1000XM5', formFactor: 'headset'},
    ];
    const chips = outputChips(sinks, 'bluez_output.AA_BB_CC_DD_EE_FF.1');
    assert.deepEqual(chips.map(c => [c.id, c.label, c.icon, c.active]), [
        [58, 'Ryzen HD Audio Controller', 'audio-card-symbolic', false],
        [90, 'WH-1000XM5', 'audio-headphones-symbolic', true]]);
    const viaEe = outputChips(sinks, 'easyeffects_sink', 'alsa_output.pci-0000_04_00.6.analog-stereo');
    assert.deepEqual(viaEe.map(c => c.active), [true, false]);
    assert.equal(shortLabel('A very long device description that keeps going'), 'A very long device descript…');
    assert.equal(shortLabel(''), '출력');
});

test('view helpers produce the compact pill, toast and header copy', () => {
    const xm5 = normalizeDevice({id: 'c', name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', description: 'WH-1000XM5',
        codec: 'ldac', formFactor: 'headset', battery: 87, connectedAt: 60_000});
    assert.deepEqual(compactView(xm5), {icon: 'audio-headphones-symbolic', batteryText: '87%', tone: 'ok',
        fraction: 0.87, accessibleName: 'WH-1000XM5 · 87%'});
    assert.equal(compactView(null), null);
    assert.deepEqual(toastText(xm5, true), {title: 'WH-1000XM5 연결됨', subtitle: 'LDAC'});
    assert.deepEqual(toastText(xm5, false), {title: 'WH-1000XM5 연결 해제', subtitle: ''});
    const mouse = normalizeDevice({id: 'd', model: 'USB Optical Mouse', kind: 'usb', isAudio: false, usbClass: 'input'});
    assert.deepEqual(toastText(mouse, true), {title: 'USB Optical Mouse 연결됨', subtitle: 'USB 입력기기'});
    assert.equal(deviceIcon(mouse), 'input-mouse-symbolic');
    assert.deepEqual(cardHeader(xm5, 60_000 + 5 * 60_000), {title: 'WH-1000XM5', subtitle: 'LDAC · 블루투스',
        caption: '5분 전 연결', icon: 'audio-headphones-symbolic'});
    assert.equal(cardHeader(null).subtitle, '연결된 기기 없음');
    const dac = normalizeDevice({id: 'e', name: 'alsa_output.usb-dac', description: 'USB DAC', kind: 'usb'});
    assert.equal(compactView(dac).fraction, null);
    assert.equal(compactView({...mouse, battery: 140}).fraction, 1);
    assert.equal(connectedFor(0, 30_000), '방금 연결');
    assert.equal(connectedFor(0, 3 * 3_600_000), '3시간 전 연결');
});

test('presetChips marks the active preset and explains the EasyEffects state', () => {
    const running = presetChips(['A', 'B'], 'B', 'running');
    assert.deepEqual(running, {chips: [{name: 'A', active: false}, {name: 'B', active: true}], note: '', enabled: true, offChip: true});
    assert.equal(presetChips(['A'], '', 'off').note, 'EasyEffects 꺼짐');
    assert.equal(presetChips(['A'], '', 'off').enabled, false);
    assert.equal(presetChips(['A'], 'A', 'off-autostart').enabled, true);
    assert.equal(presetChips(['A'], 'A', 'applying').note, '적용 중…');
    assert.equal(presetChips(['A'], 'A', 'error').note, '적용 실패');
    assert.equal(presetChips(['A'], 'A', 'error').enabled, true);      // retry is possible
    assert.equal(presetChips(['A'], 'A', 'native').enabled, false);
});

test('low-battery pulse fires once per downward step into red, with a 25% re-arm', () => {
    const fires = levels => {
        let stage = 0;
        const out = [];
        for (const level of levels) {
            const step = lowAlertStep(stage, level);
            stage = step.stage;
            if (step.fire) out.push(level);
        }
        return out;
    };
    // XM5 reports in 10% steps: 20 is still orange, so the first red reading (10) fires once.
    assert.deepEqual(fires([100, 80, 50, 30, 20, 10, 10, 10]), [10]);
    assert.deepEqual(fires([21, 19, 15, 10, 9]), [19, 10]);
    assert.deepEqual(fires([19, 22, 19]), [19]);             // 20-24 is hysteresis, no second alert
    assert.deepEqual(fires([19, 25, 19]), [19, 19]);         // charged to 25 re-arms
    assert.deepEqual(fires([10]), [10]);                     // connecting (or Shell restart) already low
    assert.deepEqual(lowAlertStep(2, null), {stage: 2, fire: false});
    assert.equal(lowStage(20), 0);
    assert.equal(lowStage(10), 2);
    const low = normalizeDevice({id: 'c', name: 'bluez_output.AA_BB_CC_DD_EE_FF.1', description: 'WH-1000XM5', battery: 10});
    assert.equal(compactView(low).accessibleName, 'WH-1000XM5 · 10% · 배터리 부족');
});

test('battery comes from the cached UPower list by MAC first, then by model name', () => {
    const list = [{kind: 2, serial: '', model: 'BAT0', percentage: 80},
        {kind: 17, serial: '11:22:33:44:55:66', model: 'WH-1000XM5', percentage: 100},
        {kind: 5, serial: '', model: 'MX Anywhere 3', percentage: 40},
        {kind: 17, serial: 'AA:BB:CC:DD:EE:FF', model: 'Buds', percentage: 0}];
    assert.equal(batteryFor(list, '11:22:33:44:55:66', 'anything'), 100);
    assert.equal(batteryFor(list, '', 'MX Anywhere 3'), 40);
    assert.equal(batteryFor(list, '', 'BAT0'), null);                  // the laptop battery is never a device battery
    assert.equal(batteryFor(list, 'AA:BB:CC:DD:EE:FF', 'Buds'), null);  // 0% = not reported
    assert.equal(batteryFor([], '11:22:33:44:55:66', 'WH-1000XM5'), null);
});

test('the EasyEffects off chip shows only while our hidden service runs', () => {
    assert.equal(presetChips(['A'], 'A', 'running').offChip, true);
    for (const state of ['off', 'off-autostart', 'applying', 'stopping', 'error', 'native', 'hidden'])
        assert.equal(presetChips(['A'], 'A', state).offChip, false, state);
    assert.deepEqual(presetChips(['A'], 'A', 'stopping'), {chips: [{name: 'A', active: true}], note: '끄는 중…', enabled: false, offChip: false});
});

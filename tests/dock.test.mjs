import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DOCK_PROTOCOL, SNAP, GRAB_PRIORITY, layoutIsland, canClaim, needsGrab} from '../extension/dockModel.js';

test('notci modules join the shared island row behind the football score', () => {
    assert.equal(DOCK_PROTOCOL, 7);
    assert.equal(SNAP, 8);
    const {island, slots} = layoutIsland([
        {id: 'archsport@local', width: 200, height: 36, order: 0},
        {id: 'notci@local/spotify', width: 56, height: 36, order: 2},
    ], {x: 0, y: 0, width: 1728, panelHeight: 32});
    assert.deepEqual(island, {x: 730, y: 32, width: 268, height: 36, expanded: false, ownerId: null});
    assert.deepEqual(slots.get('notci@local/spotify'), {x: 212, width: 56, shown: true});
});

test('alert ladder: goal 80 > KakaoTalk 60 > audio toast 50 > Spotify peek 40 > matci suggestion 30', () => {
    assert.equal(canClaim({id: 'archsport@local', priority: 80}, 'notci@local/kakao', 60), false);
    assert.equal(canClaim({id: 'notci@local/kakao', priority: 60}, 'notci@local/spotify', 40), false);
    assert.equal(canClaim({id: 'matci@local', priority: 30}, 'notci@local/spotify', 40), true);
    assert.equal(canClaim(null, 'notci@local/kakao', 60), true);
    assert.equal(canClaim({id: 'notci@local/spotify', priority: 40}, 'notci@local/audio', 50), true);
    assert.equal(canClaim({id: 'notci@local/audio', priority: 50}, 'notci@local/spotify', 40), false);
    assert.equal(canClaim({id: 'notci@local/kakao', priority: 60}, 'notci@local/audio', 50), false);
});

test('manual Spotify and audio cards hold the stage grab; Kakao and audio toasts never do', () => {
    const open = {visible: true, expanded: true};
    assert.equal(GRAB_PRIORITY, 100);
    assert.equal(needsGrab({id: 'notci@local/audio', priority: 100}, open), true);
    assert.equal(needsGrab({id: 'notci@local/spotify', priority: 100}, open), true);
    for (const priority of [60, 50, 40]) assert.equal(needsGrab({id: 'notci@local/kakao', priority}, open), false);
    assert.equal(needsGrab({id: 'notci@local/audio', priority: 100}, {visible: true, expanded: false}), false);
    assert.equal(needsGrab(null, open), false);
});

test('the host owns no surface; modules hand their content trees to the island', () => {
    const host = readFileSync(new URL('../extension/extension.js', import.meta.url), 'utf8');
    assert.doesNotMatch(host, /createNotchSurface|addChrome\(/);
    for (const name of ['spotify', 'kakao', 'audio']) {
        const source = readFileSync(new URL(`../extension/modules/${name}.js`, import.meta.url), 'utf8');
        assert.match(source, /new DockParticipant\(\{id: `\$\{uuid\}\/[a-z]+`, content: this\.root,/);
        assert.doesNotMatch(source, /createNotchSurface|addChrome\(/);
    }
});

test('hit regions are placed by the slab layout, never from notify or style handlers', () => {
    const source = readFileSync(new URL('../extension/notchSurface.js', import.meta.url), 'utf8');
    // Setting child geometry from notify::width ran inside allocation and re-queued a relayout every morph frame.
    assert.match(source, /vfunc_allocate\(container, box\)/);
    assert.doesNotMatch(source, /updateHitRegions|margin_(left|right|top|bottom)/);
});

test('slab morphs ride a spring: growing overshoots ~2 % and settles, shrinking never overshoots', async () => {
    const {SPRING_OPEN, SPRING_CLOSE, springAt, springDuration} = await import('../extension/dockModel.js');
    const peak = spring => Math.max(...Array.from({length: 241}, (_, i) => springAt(i / 240, spring)));
    assert.equal(springAt(0, SPRING_OPEN), 0);
    assert.ok(peak(SPRING_OPEN) > 1.01 && peak(SPRING_OPEN) < 1.04, `open peak ${peak(SPRING_OPEN)}`);
    assert.ok(peak(SPRING_CLOSE) <= 1, `close peak ${peak(SPRING_CLOSE)}`);
    const open = springDuration(SPRING_OPEN);
    const close = springDuration(SPRING_CLOSE);
    assert.ok(open > 300 && open < 600, `open ${open} ms`);
    assert.ok(close > 200 && close < 450, `close ${close} ms`);
    // The shipped cubic-bezier must track the spring (Clutter progress functions do not work from GJS).
    const bezier = ([x1, y1, x2, y2], x) => {
        let t = x;
        for (let i = 0; i < 12; i++) {
            const dx = 3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
            t = Math.min(1, Math.max(0, t - (3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3 - x) / dx));
        }
        return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
    };
    for (const spring of [SPRING_OPEN, SPRING_CLOSE]) {
        const duration = springDuration(spring) / 1000;
        for (let i = 1; i < 50; i++)
            assert.ok(Math.abs(bezier(spring.curve, i / 50) - springAt(i / 50 * duration, spring)) < 0.025, `${spring.response} at ${i}`);
    }
    assert.ok(SPRING_CLOSE.curve[1] <= 1 && SPRING_CLOSE.curve[3] <= 1, 'a shrink never passes its target');
    // Measured in the harness: the first fit overshot 3.7% (16 px on a 492 px card); the curve now caps it.
    const curvePeak = Math.max(...Array.from({length: 101}, (_, i) => bezier(SPRING_OPEN.curve, i / 100)));
    assert.ok(curvePeak > 1.01 && curvePeak <= 1.025, `open curve peak ${curvePeak}`);
});

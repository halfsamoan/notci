import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DOCK_PROTOCOL, SNAP, layoutIsland, canClaim} from '../extension/dockModel.js';

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

test('alert ladder: goal 80 > KakaoTalk 60 > Spotify peek 40 > matci suggestion 30', () => {
    assert.equal(canClaim({id: 'archsport@local', priority: 80}, 'notci@local/kakao', 60), false);
    assert.equal(canClaim({id: 'notci@local/kakao', priority: 60}, 'notci@local/spotify', 40), false);
    assert.equal(canClaim({id: 'matci@local', priority: 30}, 'notci@local/spotify', 40), true);
    assert.equal(canClaim(null, 'notci@local/kakao', 60), true);
});

test('the host owns no surface; modules hand their content trees to the island', () => {
    const host = readFileSync(new URL('../extension/extension.js', import.meta.url), 'utf8');
    assert.doesNotMatch(host, /createNotchSurface|addChrome\(/);
    for (const name of ['spotify', 'kakao']) {
        const source = readFileSync(new URL(`../extension/modules/${name}.js`, import.meta.url), 'utf8');
        assert.match(source, /new DockParticipant\(\{id: `\$\{uuid\}\/[a-z]+`, content: this\.root,/);
        assert.doesNotMatch(source, /createNotchSurface|addChrome\(/);
    }
});

test('hit-region margins survive St style resets', () => {
    const source = readFileSync(new URL('../extension/notchSurface.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /margin_(left|right|top|bottom)\s*:/);
    assert.match(source, /connect\('style-changed', updateHitRegions\)/);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_APPS, CELL, GRID_W, GRID_H, POSES, FLAMES, PALETTES, TICK_MS, LOOK, CALM_SLOW_AFTER_MS, CALM_NO_HOP_AFTER_MS,
    agentSourceFor, composePose, arriveFrames, excitedFrames, calmCycle, leaveFrames} from '../extension/modules/agentModel.js';

const AREA_H = 28;   // agent.js draws the sprite on the bottom edge of this box

test('the pet is one 12×12 sprite whose every cell has a colour in both palettes', () => {
    for (const [name, rows] of Object.entries(POSES)) {
        assert.equal(rows.length, GRID_H, name);
        for (const row of rows) assert.equal(row.length, GRID_W, name);
    }
    const keys = new Set([...Object.values(POSES), ...FLAMES].flat().join('').replace(/\./g, ''));
    for (const palette of Object.values(PALETTES)) for (const key of keys) assert.match(palette[key], /^#[0-9a-f]{6}$/, key);
});

test('Claude and ChatGPT map to the pet by desktop id, else by WM class or source title', () => {
    assert.deepEqual(Object.values(AGENT_APPS).sort(), ['chatgpt', 'claude']);
    assert.equal(agentSourceFor({appId: 'com.anthropic.Claude.desktop'}), 'claude');
    assert.equal(agentSourceFor({appId: 'chatgpt.desktop'}), 'chatgpt');
    assert.equal(agentSourceFor({wmClass: 'ChatGPT'}), 'chatgpt');
    assert.equal(agentSourceFor({title: 'Claude Code'}), 'claude');
    assert.equal(agentSourceFor({appId: 'firefox_firefox.desktop', title: 'Firefox'}), null);
    assert.equal(agentSourceFor({title: 'Claudette'}), null);
});

test('the excited flame replaces the calm tuft and sits on the body top', () => {
    for (const name of Object.keys(POSES)) {
        for (let flame = 0; flame < FLAMES.length; flame++) {
            const rows = composePose(name, flame);
            assert.equal(rows.join('').includes('T'), false, name);
            const bodyTop = rows.findIndex(row => row.includes('B'));
            assert.match(rows[bodyTop - 1], /[yor]/, `${name} ${flame}`);
        }
    }
    assert.deepEqual(composePose('base'), POSES.base);
});

test('motion runs at 15 fps or slower, on whole cells, and enters and leaves through the island edge', () => {
    const calm = [calmCycle(0), calmCycle(CALM_SLOW_AFTER_MS), calmCycle(CALM_NO_HOP_AFTER_MS)];
    for (const frames of [arriveFrames(), excitedFrames(), ...calm, leaveFrames()]) {
        for (const frame of frames) {
            assert.ok(frame.ms >= TICK_MS);
            assert.ok(frame.y % CELL === 0, `y ${frame.y}`);
            assert.ok(POSES[frame.pose] || frame.pose === LOOK, frame.pose);
        }
        // One entry is one wake: identical consecutive ticks must be merged into one longer entry.
        frames.slice(1).forEach((frame, i) => assert.notDeepEqual({...frame, ms: 0}, {...frames[i], ms: 0}));
    }
    const hidden = AREA_H - (AREA_H - GRID_H * CELL);   // sprite top below the drawing box
    assert.ok(arriveFrames()[0].y >= hidden);
    assert.ok(leaveFrames().at(-1).y >= hidden);
});

test('attention: two short bursts with still beats, then re-alerts that thin out', () => {
    const wakes = frames => frames.length / (frames.reduce((sum, frame) => sum + frame.ms, 0) / 1000);
    const excited = excitedFrames();
    const seconds = excited.reduce((sum, frame) => sum + frame.ms, 0) / 1000;
    assert.ok(seconds > 4.5 && seconds < 6, `bursts last ${seconds}s`);
    assert.ok(wakes(excited) < 7.5, `excited ${wakes(excited)} wakes/s`);
    // Each burst ends on a fully still beat: no flame, no height, long hold.
    const beats = excited.filter(frame => frame.ms >= 10 * TICK_MS);
    assert.equal(beats.length, 2);
    for (const beat of beats) assert.deepEqual([beat.flame, beat.y], [null, 0]);
    assert.ok(excited.some(frame => frame.flame !== null));
    assert.ok(wakes(calmCycle(0)) < 1.1, `calm ${wakes(calmCycle(0))}`);
    assert.ok(wakes(calmCycle(CALM_SLOW_AFTER_MS)) < 0.5);
    assert.ok(wakes(calmCycle(CALM_NO_HOP_AFTER_MS)) < 0.35);
    assert.equal(calmCycle(CALM_NO_HOP_AFTER_MS).some(frame => frame.y < 0), false);
    for (const t of [0, CALM_SLOW_AFTER_MS, CALM_NO_HOP_AFTER_MS]) assert.equal(calmCycle(t).filter(frame => frame.pose === LOOK).length, 1);
});

test('looking sideways moves both eyes and their catchlights by one cell, nothing else', () => {
    const cells = pose => POSES[pose].join('');
    for (const side of ['lookL', 'lookR']) {
        for (const key of 'EW') assert.equal(cells(side).split(key).length, cells('base').split(key).length, `${side} ${key}`);
        POSES[side].forEach((row, y) => { if (!/[EW]/.test(POSES.base[y])) assert.equal(row, POSES.base[y]); });
    }
    assert.equal(POSES.lookR[7].indexOf('E'), POSES.base[7].indexOf('E') + 1);
    assert.equal(POSES.lookL[7].indexOf('E'), POSES.base[7].indexOf('E') - 1);
});

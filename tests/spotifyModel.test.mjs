import {test} from 'node:test';
import assert from 'node:assert/strict';
import {metadataToState, positionAt, artVariantUrl, accentFromPixels, formatTime} from '../extension/modules/spotifyModel.js';

const FALLBACK = '#1db954';
// Real shape: prefix + 24 hex (live MPRIS artUrl, 2026-10-23).
const ART = 'https://i.scdn.co/image/ab67616d0000b2738c4ad3af2e4d5ead81934709';

test('metadataToState normalises MPRIS keys and defaults missing or wrongly typed values', () => {
    assert.deepEqual(metadataToState({'mpris:trackid': '/com/spotify/track/abc', 'xesam:title': 'Song',
        'xesam:artist': ['A', 'B'], 'xesam:album': 'Album', 'mpris:length': 180000000n, 'mpris:artUrl': ART}),
    {trackId: '/com/spotify/track/abc', title: 'Song', artists: ['A', 'B'], album: 'Album', lengthUs: 180000000, artUrl: ART});
    assert.deepEqual(metadataToState(null), {trackId: '', title: '', artists: [], album: '', lengthUs: 0, artUrl: ''});
    assert.deepEqual(metadataToState({'mpris:trackid': 7, 'xesam:title': ['x'], 'xesam:artist': 'solo',
        'mpris:length': '180', 'mpris:artUrl': {}}), {trackId: '', title: '', artists: [], album: '', lengthUs: 0, artUrl: ''});
    assert.deepEqual(metadataToState({'xesam:artist': ['A', 3, ''], 'mpris:length': -5}).artists, ['A']);
});

test('positionAt extrapolates while playing, holds while paused and clamps to the length', () => {
    const base = {positionUs: 10_000_000, atUs: 1_000_000, lengthUs: 20_000_000};
    assert.equal(positionAt({...base, playing: true}, 4_000_000), 13_000_000);
    assert.equal(positionAt({...base, playing: false}, 4_000_000), 10_000_000);
    assert.equal(positionAt({...base, playing: true}, 50_000_000), 20_000_000);
    assert.equal(positionAt({...base, lengthUs: 0, playing: true}, 50_000_000), 59_000_000);
    assert.equal(positionAt({positionUs: 5, atUs: 10, playing: true}, 3), 5);
});

test('artVariantUrl always picks the 300 px CDN variant and leaves other urls alone', () => {
    const id = '8c4ad3af2e4d5ead81934709';
    assert.equal(artVariantUrl(ART, 1), `https://i.scdn.co/image/ab67616d00001e02${id}`);
    assert.equal(artVariantUrl(ART, 2), `https://i.scdn.co/image/ab67616d00001e02${id}`);
    assert.equal(artVariantUrl(`https://open.spotify.com/image/ab67616d0000b273${id}`, 1),
        `https://i.scdn.co/image/ab67616d00001e02${id}`);
    assert.equal(artVariantUrl('https://example.com/cover.jpg', 2), 'https://example.com/cover.jpg');
    assert.equal(artVariantUrl('https://i.scdn.co/image/ab67616d0000b273short', 1), 'https://i.scdn.co/image/ab67616d0000b273short');
    assert.equal(artVariantUrl(undefined, 1), '');
});

const contrastOnBlack = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05) / 0.05;
};
const image = rows => {
    const width = rows[0].length;
    const pixels = new Uint8Array(rows.length * width * 4 + 4);
    rows.flat().forEach(([r, g, b], i) => pixels.set([r, g, b, 255], i * 4));
    return [pixels, width, rows.length, width * 4, 4];
};

test('accentFromPixels picks the vivid pixel and lifts it to 4.5:1 on black', () => {
    const vivid = accentFromPixels(...image([[[40, 40, 40], [120, 10, 10]], [[200, 200, 200], [10, 20, 90]]]), FALLBACK);
    assert.match(vivid, /^#[0-9a-f]{6}$/);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(vivid.slice(i, i + 2), 16));
    assert.ok(r > g && r > b, `red should dominate: ${vivid}`);
    assert.ok(contrastOnBlack(vivid) >= 4.5, `contrast ${contrastOnBlack(vivid)}`);
    assert.ok(contrastOnBlack(accentFromPixels(...image([[[0, 0, 200]]]), FALLBACK)) >= 4.5);
    assert.equal(accentFromPixels(...image([[[250, 60, 60]]]), FALLBACK), '#fa3c3c');
});

test('accentFromPixels falls back for grey or empty images', () => {
    assert.equal(accentFromPixels(...image([[[40, 40, 40], [200, 205, 210]]]), FALLBACK), FALLBACK);
    assert.equal(accentFromPixels(new Uint8Array(0), 0, 0, 0, 4, FALLBACK), FALLBACK);
});

test('formatTime renders m:ss', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(65_000_000), '1:05');
    assert.equal(formatTime(754_900_000), '12:34');
    assert.equal(formatTime(-3), '0:00');
    assert.equal(formatTime(undefined), '0:00');
});

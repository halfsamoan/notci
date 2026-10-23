import {test} from 'node:test';
import assert from 'node:assert/strict';
import {THRESHOLD, isTempDownload, firefoxProfileDirs, firefoxTotal, formatGB, pickDownload, pillView}
    from '../extension/modules/downloadModel.js';

test('only browser temp files count as downloads in progress', () => {
    assert.equal(isTempDownload('ubuntu-26.xY3a.04.iso.part'), true);
    assert.equal(isTempDownload('Unconfirmed 123456.crdownload'), true);
    assert.equal(isTempDownload('ubuntu-26.04.iso'), false);
    assert.equal(isTempDownload('.goutputstream-ABC.part'), false);
});

test('Firefox totals come from downloads.json of every profile in profiles.ini', () => {
    const ini = '[Install4F96]\nDefault=nc6.default\n\n[Profile0]\nName=default\nIsRelative=1\nPath=nc6.default\nDefault=1\n\n[Profile1]\nIsRelative=0\nPath=/data/ff\n';
    assert.deepEqual(firefoxProfileDirs(ini, '/home/user/ff'), ['/home/user/ff/nc6.default', '/data/ff']);
    const json = JSON.stringify({list: [{target: {path: '/d/a.iso', partFilePath: '/d/a.x1.iso.part'}, totalBytes: 1.4e9}]});
    assert.equal(firefoxTotal(json, '/d/a.x1.iso.part'), 1.4e9);
    assert.equal(firefoxTotal(json, '/d/other.part'), 0);
    assert.equal(firefoxTotal('{broken', '/d/a.x1.iso.part'), 0);
});

test('the pill shows the biggest download of 0.7 GB or more, known by total or by bytes so far', () => {
    const now = 100000;
    const small = {received: 5e8, total: 6e8, lastGrowth: now};
    const big = {received: 0.812e9, total: 1.4e9, lastGrowth: now};
    const chrome = {received: 0.92e9, total: 0, lastGrowth: now};
    assert.equal(pickDownload([small]), null);
    assert.equal(pickDownload([small, big, chrome]), big);
    assert.equal(pickDownload([{received: 0.69e9, total: 0, lastGrowth: now}]), null);
    assert.equal(THRESHOLD, 0.7e9);
    assert.deepEqual(pillView(big, now), {fraction: 0.58, text: '58%', tone: null});
    assert.deepEqual(pillView(chrome, now), {fraction: null, text: '0.92 GB', tone: null});
    assert.equal(pillView({...big, lastGrowth: now - 10000}, now).tone, 'stalled');
    assert.equal(formatGB(12.34e9), '12.3 GB');
    assert.equal(pillView(null, now), null);
});

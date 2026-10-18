// src/worker/engines/yaya.js pure helpers (no engine build needed): the SAORI bridge seen from the ghost root, the other
// ghosts' descript.txt, log fragments into lines, what a scan reports (bytes / tombstone / forget), the dictionary stamp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rootBridge, sspDescript, LogLines, diffScan, dicStamp } from '../../src/worker/engines/yaya.js';
import { pathFromDll } from '../../src/worker/saori/standins.js';

test('rootBridge: MEMFS paths under the ghost root reach the stand-ins as Satori\'s do (/ghost/master/...); others pass', () => {
  const calls = [];
  const bridge = {
    load(p, d) { calls.push(['load', p, d, this === bridge]); return 7; },
    request(h, b) { calls.push(['request', h, b, this === bridge]); return 'SAORI/1.0 204 No Content\r\n\r\n'; },
    unload(h) { calls.push(['unload', h, this === bridge]); },
  };
  const b = rootBridge(bridge, '/ssp/ghost/emily4/');
  assert.equal(b.load('/ssp/ghost/emily4/ghost/master/saori/foo.dll', '/ssp/ghost/emily4/ghost/master/saori/'), 7);
  const bytes = new Uint8Array([1, 2]);
  assert.equal(b.request(7, bytes), 'SAORI/1.0 204 No Content\r\n\r\n');
  b.unload(7);
  b.load('/SSP/Ghost/Emily4/ghost/master/x.dll', '/ssp/ghost/emily4');
  b.load('/ssp/ghost/other/ghost/master/y.dll', '/tmp/');
  assert.deepEqual(calls, [
    ['load', '/ghost/master/saori/foo.dll', '/ghost/master/saori/', true],
    ['request', 7, bytes, true],
    ['unload', 7, true],
    ['load', '/ghost/master/x.dll', '/', true],
    ['load', '/ssp/ghost/other/ghost/master/y.dll', '/tmp/', true],
  ]);
  // the page resolves a SAORI's relative paths against that folder, as for Satori
  assert.equal(pathFromDll(calls[0][2], '../sound/a.mid'), 'ghost/master/sound/a.mid');
  assert.equal(rootBridge(undefined, '/ssp/ghost/x/'), undefined, 'no bridge: none');
});

test('sspDescript: what a template reads of another installed ghost (charset, name, sakura.name, kero.name), one line each', () => {
  assert.equal(sspDescript({ id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', craftman: 'Macaroni', shiori: 'satori.dll' }),
    'charset,UTF-8\r\ntype,ghost\r\nname,Hayama-san Next Door\r\nsakura.name,Tsubasa\r\nkero.name,\r\ncraftman,Macaroni\r\nshiori,satori.dll\r\n');
  assert.equal(sspDescript({ name: 'a\r\nkero.name,b', sakuraName: 'さくら' }),
    'charset,UTF-8\r\ntype,ghost\r\nname,akero.name,b\r\nsakura.name,さくら\r\nkero.name,\r\ncraftman,\r\nshiori,\r\n');
});

test('LogLines: fragments become whole lines with their first fragment\'s mode; blank lines dropped; flush ends an open one', () => {
  const l = new LogLines();
  assert.deepEqual(l.push('// ', 0), []);
  assert.deepEqual(l.push('- /ssp/ghost/g/ghost/master/yaya.txt\n', 2), [{ mode: 0, text: '// - /ssp/ghost/g/ghost/master/yaya.txt' }]);
  assert.deepEqual(l.push('\r\n// load banner\r\nerror E0032 : no load\n', 2), [
    { mode: 2, text: '// load banner' }, { mode: 2, text: 'error E0032 : no load' },
  ]);
  assert.deepEqual(l.push('warning W0001 : ', 3), []);
  assert.deepEqual(l.push('half', 1), []);
  assert.deepEqual(l.flush(), [{ mode: 3, text: 'warning W0001 : half' }]);
  assert.deepEqual(l.flush(), []);
  assert.deepEqual(l.push('', 2), []);
  assert.deepEqual(l.push('   \n', 2), [], 'a blank line');
  assert.deepEqual(l.push('next\n', 4), [{ mode: 4, text: 'next' }]);
});

test('diffScan: new or rewritten files are changed; a site file gone is a tombstone (null), the ghost\'s own forgotten (false); *.log never', () => {
  const baseline = new Map([
    ['ghost/master/yaya_variable.cfg', 1], ['ghost/master/Dic/A.dic', 1], ['ghost/master/var/own.txt', 1],
    ['shell/master/surface0.png', 1], ['ghost/master/x.log', 1], ['ghost/master/same.txt', 5], ['ghost/master/rewritten.txt', 5],
  ]);
  const now = new Map([
    ['ghost/master/yaya_variable.cfg', 2], ['ghost/master/same.txt', 5], ['ghost/master/rewritten.txt', 6],
    ['notelog/n.txt', 3], ['ghost/master/y.log', 3],
  ]);
  const inputs = new Set(['ghost/master/dic/a.dic', 'shell/master/surface0.png', 'ghost/master/same.txt', 'ghost/master/rewritten.txt']);
  assert.deepEqual(diffScan(baseline, now, inputs), {
    changed: ['ghost/master/yaya_variable.cfg', 'ghost/master/rewritten.txt', 'notelog/n.txt'],
    gone: { 'ghost/master/Dic/A.dic': null, 'ghost/master/var/own.txt': false, 'shell/master/surface0.png': null },
  });
  assert.deepEqual(diffScan(now, now, inputs), { changed: [], gone: {} });
});

test('dicStamp: FNV-1a over ghost/master in NTFS order; one byte there changes it, files elsewhere do not', () => {
  const te = new TextEncoder();
  const f = (path, text) => ({ path, data: te.encode(text).buffer });
  const files = [f('ghost/master/yaya.txt', 'dic, a.dic'), f('ghost/master/a.dic', 'load\r\n{\r\n}\r\n'),
    f('shell/master/descript.txt', 'name,x'), f('readme.txt', 'hi')];
  const s = dicStamp(files);
  assert.match(s, /^[0-9a-f]{8}$/);
  assert.equal(dicStamp([...files].reverse()), s, 'any order in, NTFS order inside');
  assert.equal(dicStamp(files.map(x => ({ path: x.path, data: new Uint8Array(x.data.slice(0)) }))), s, 'same bytes, Uint8Array too');
  assert.notEqual(dicStamp([files[0], f('ghost/master/a.dic', 'load\r\n{\r\n}\r\n.'), files[2], files[3]]), s, 'one byte more');
  assert.notEqual(dicStamp([files[0], f('ghost/master/a.dic', 'load\r\n{\r\n}\r\r'), files[2], files[3]]), s, 'one byte changed');
  assert.notEqual(dicStamp([files[0], f('ghost/master/b.dic', 'load\r\n{\r\n}\r\n'), files[2], files[3]]), s, 'renamed');
  assert.equal(dicStamp([files[0], files[1], f('shell/master/descript.txt', 'name,y'), f('readme.txt', 'changed')]), s, 'outside ghost/master');
  assert.notEqual(dicStamp([f('ghost/master/a', 'bc')]), dicStamp([f('ghost/master/ab', 'c')]), 'paths and lengths are delimited');
  assert.equal(dicStamp([]), '811c9dc5', 'FNV-1a offset basis');
});

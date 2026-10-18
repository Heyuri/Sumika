// The worker's Kawari adapter and the SSP-shaped root it shares with YAYA, without an engine build: the stamped snapshot
// (kawari-wasm.md §8), D6's close requests, the kind of a Kawari log line, the other ghosts' descript.txt in a named
// charset, the stack guard around a call into the engine (D8), and the move of YAYA's root into ./ssproot.js (yaya.js
// re-exports the same helpers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RESUME_KEY, stampSnapshot, snapshotStamp, kawariLogMode, KawariEngine, D6_FINISHED, END_SESSION_REFS, endSessionRequest }
  from '../../src/worker/engines/kawari.js';
import * as root from '../../src/worker/engines/ssproot.js';
import * as yaya from '../../src/worker/engines/yaya.js';
import { EmscriptenShiori } from '../../src/worker/engines/emscripten.js';
import { BASE_HEADERS, ShioriClient } from '../../src/core/shiori.js';

const te = new TextEncoder();

test('the snapshot key: one name no Windows file can have, outside every ghost folder', () => {
  assert.equal(RESUME_KEY, '?kawari/resume.kis');
  assert.ok(/[?]/.test(RESUME_KEY), '`?` is not allowed in a Windows file name');
});

test('stampSnapshot / snapshotStamp: the first line names the dictionaries (a comment for Kawari); none -> null', () => {
  const body = te.encode('#\n# Sumika resume snapshot\n#\n# clear a\na : "1"\n');
  const s = stampSnapshot('0123abcd', body);
  assert.equal(new TextDecoder().decode(s), '# dicStamp 0123abcd\n#\n# Sumika resume snapshot\n#\n# clear a\na : "1"\n');
  assert.equal(snapshotStamp(s), '0123abcd');
  assert.equal(snapshotStamp(s.buffer), '0123abcd', 'an ArrayBuffer as stored');
  assert.equal(snapshotStamp(te.encode('# dicStamp 89abcdef\r\nx : "1"\r\n')), '89abcdef');
  assert.equal(snapshotStamp(new ArrayBuffer(0)), null, 'the empty marker');
  assert.equal(snapshotStamp(body), null, 'no stamp line');
  assert.equal(snapshotStamp(te.encode('# dicStamp 0123ABCD\n')), null, 'dicStamp is lower-case hex');
  assert.equal(snapshotStamp(te.encode('x\n# dicStamp 0123abcd\n')), null, 'only the first line');
});

test('D6\'s close (shiori-events.md §2.3.1): ssp.exe\'s end-of-session References, the page\'s base headers, the info line', () => {
  assert.deepEqual(BASE_HEADERS, new ShioriClient('x').baseHeaders, 'the page sends the same headers');
  assert.ok(Object.isFrozen(BASE_HEADERS));
  assert.ok(Object.isFrozen(END_SESSION_REFS));
  assert.deepEqual([...END_SESSION_REFS], ['system', '0', '0'], 'ForceQuitApplication(L"system", 0, 0) [disasm 0x46dd66]');
  assert.equal(endSessionRequest('OnCloseAll', END_SESSION_REFS, { BaseID: 'OnClose' }),
    'GET SHIORI/3.0\r\nCharset: UTF-8\r\nSender: SSP\r\nSenderType: internal\r\nSecurityLevel: local\r\nBaseID: OnClose\r\n'
    + 'ID: OnCloseAll\r\nReference0: system\r\nReference1: 0\r\nReference2: 0\r\n\r\n');
  assert.equal(endSessionRequest('OnClose'),
    'GET SHIORI/3.0\r\nCharset: UTF-8\r\nSender: SSP\r\nSenderType: internal\r\nSecurityLevel: local\r\n'
    + 'ID: OnClose\r\nReference0: system\r\nReference1: 0\r\nReference2: 0\r\n\r\n');
  assert.equal(D6_FINISHED, 'the last session ended without Close: it was closed from its snapshot (OnClose "system", OnUnload) before this boot');
});

test('kawariLogMode: the lexer\'s error and warning lines; any other line has no marker', () => {
  assert.equal(kawariLogMode('/ssp/ghost/g/ghost/master/dict.kis 94: error: \':\' not found.'), 'error');
  assert.equal(kawariLogMode('/ssp/ghost/g/ghost/master/dict.kis 7: warning: blank definition.'), 'warning');
  assert.equal(kawariLogMode('load : load failed nothere.kis'), 'log');
  assert.equal(kawariLogMode('an error message without the marker'), 'log');
});

test('sspDescript: UTF-8 by default (YAYA, unchanged); a named charset on the first line (Kawari writes Shift_JIS)', () => {
  const g = { name: 'Other', sakuraName: 'おと', keroName: '', craftman: 'x', shiori: 'satori.dll' };
  assert.equal(root.sspDescript(g), 'charset,UTF-8\r\ntype,ghost\r\nname,Other\r\nsakura.name,おと\r\nkero.name,\r\ncraftman,x\r\nshiori,satori.dll\r\n');
  assert.equal(root.sspDescript(g, 'Shift_JIS').split('\r\n')[0], 'charset,Shift_JIS');
  assert.equal(root.sspDescript(g, 'Shift_JIS').slice('charset,Shift_JIS'.length), root.sspDescript(g).slice('charset,UTF-8'.length));
});

test('the stack guard: a throw out of the engine puts the stack pointer back first, when the module exports stackSave/stackRestore', () => {
  const calls = [];
  const e = new EmscriptenShiori({ engineUrl: 'x' });
  e.M = { stackSave: () => { calls.push('save'); return 4096; }, stackRestore: sp => calls.push(`restore ${sp}`) };
  assert.equal(e._stackGuard(() => 7), 7);
  assert.deepEqual(calls.splice(0), ['save']);
  const err = new RangeError('Maximum call stack size exceeded');
  assert.throws(() => e._stackGuard(() => { calls.push('call'); throw err; }), err);
  assert.deepEqual(calls.splice(0), ['save', 'call', 'restore 4096']);
  // Satori and YAYA builds export neither (yet): nothing changes for them
  e.M = {};
  assert.throws(() => e._stackGuard(() => { throw err; }), err);
  assert.equal(e._stackGuard(() => 'ok'), 'ok');
});

test('the move: YAYA and Kawari share SspRootShiori; yaya.js re-exports the very same helpers', () => {
  for (const name of ['rootBridge', 'sspDescript', 'LogLines', 'diffScan', 'dicStamp']) {
    assert.equal(typeof yaya[name], 'function', name);
    assert.equal(yaya[name], root[name], name);
  }
  assert.ok(yaya.YayaEngine.prototype instanceof root.SspRootShiori);
  assert.ok(KawariEngine.prototype instanceof root.SspRootShiori);
  assert.ok(root.SspRootShiori.prototype instanceof EmscriptenShiori);
  for (const m of ['_mount', '_sspView', 'scan', '_hot', '_diff', 'changedFiles', 'writeFile', 'getVolatileState']) {
    assert.ok(Object.prototype.hasOwnProperty.call(root.SspRootShiori.prototype, m), m);
    assert.ok(!Object.prototype.hasOwnProperty.call(yaya.YayaEngine.prototype, m), `YAYA inherits ${m}`);
  }
  // the root of a site id, the same for both engines
  const opts = { ghostId: 'a/b', placeholders: [], site: {} };
  const y = new yaya.YayaEngine({ engineUrl: 'x', opts });
  const k = new KawariEngine({ engineUrl: 'x', opts });
  assert.equal(y.ghostRoot, '/ssp/ghost/a_b/');
  assert.equal(k.ghostDir, '/ssp/ghost/a_b/ghost/master/');
  assert.equal(y.module, 'yaya');
});

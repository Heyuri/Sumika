// src/worker/worker.js: which requests save the engine's data right away (pointer moves arrive once per frame and a
// save costs ~15 requests, so only real user actions are urgent), how an engine's report updates the stored files
// (YAYA's tombstones), what the engine's init gets, how a failure that is no Error is logged, the file messages of
// \![execute,http-*] (--param-input-file never reads a personal file or one the visitor's run wrote), and a request's
// FMO text (Satori P8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from '../../src/core/state.js';
import { Store } from '../../src/core/storage.js';

globalThis.self = globalThis.self || { postMessage() {} };
const { IMPORTANT, writeSave, mergeFiles, hasSave, errorText, engineRequest, keyPrefix, readForUpload } = await import('../../src/worker/worker.js');
const { ENGINES } = await import('../../src/worker/engines/index.js');

test('a save the browser refused (storage full, e.g. by dropped files) is reported once; memory-only storage is not', async () => {
  const warned = [];
  const warn = t => warned.push(t);
  const memory = { kind: 'memory', set: async () => false };
  assert.equal(await writeSave(memory, 'k', {}, warn), false);
  assert.deepEqual(warned, [], 'no IndexedDB or localStorage at all: nothing to report');
  const full = { kind: 'indexeddb', set: async () => false };
  assert.equal(await writeSave(full, 'k', {}, warn), false);
  await writeSave(full, 'k', {}, warn);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /did not store the save data/);
  assert.equal(await writeSave({ kind: 'indexeddb', set: async () => true }, 'k', {}, warn), true);
});

test('urgent saves: clicks, choices, input, keys, file drops and close; not moves, hovers, enter/leave or the wheel', () => {
  for (const id of ['OnChoiceSelect', 'OnChoiceSelectEx', 'OnAnchorSelectEx', 'OnUserInput', 'OnCommunicate',
    'OnMouseDown', 'OnMouseUp', 'OnMouseClick', 'OnMouseDoubleClick', 'OnMouseDragEnd', 'OnMouseClickEx',
    'OnMouseUpEx', 'OnKeyPress', 'OnFileDrop2', 'OnClose', 'OnCloseAll']) {
    assert.ok(IMPORTANT.test(id), id);
  }
  for (const id of ['OnMouseMove', 'OnMouseEnter', 'OnMouseLeave', 'OnMouseEnterAll', 'OnMouseLeaveAll', 'OnMouseHover',
    'OnMouseWheel', 'OnMouseDragStart', 'OnSecondChange', 'OnSurfaceChange', 'OnTranslate',
    'OnChoiceEnter', 'OnChoiceHover', 'OnAnchorEnter', 'OnAnchorHover', 'balloon_tooltip', 'tooltip']) {
    assert.ok(!IMPORTANT.test(id), id);
  }
});

test('stored files: bytes and null (a shipped file the ghost deleted) are kept, false forgets the key; tombstones alone are no save', () => {
  const a = new ArrayBuffer(1);
  const b = new ArrayBuffer(2);
  const prev = { 'ghost/master/yaya_variable.cfg': a, 'ghost/master/var/own.txt': a, 'shell/master/x.txt': null };
  const out = mergeFiles(prev, {
    'ghost/master/yaya_variable.cfg': b, 'ghost/master/var/own.txt': false, 'ghost/master/dic/a.dic': null, 'never.txt': false,
  });
  assert.deepEqual(Object.keys(out).sort(), ['ghost/master/dic/a.dic', 'ghost/master/yaya_variable.cfg', 'shell/master/x.txt']);
  assert.equal(out['ghost/master/yaya_variable.cfg'], b);
  assert.equal(out['ghost/master/dic/a.dic'], null);
  assert.equal(out['shell/master/x.txt'], null);
  assert.equal(prev['ghost/master/var/own.txt'], a, 'the previous map is left as it was');
  assert.deepEqual(mergeFiles({ 'satori_savedata.txt': a }, { 'satori_savedata.txt': b }), { 'satori_savedata.txt': b }, 'Satori: bytes only');
  assert.equal(hasSave({}), false);
  assert.equal(hasSave({ 'ghost/master/dic/a.dic': null }), false);
  assert.equal(hasSave({ 'ghost/master/dic/a.dic': null, 'ghost/master/yaya_variable.cfg': new ArrayBuffer(0) }), true);
});

test('worker init: the engine gets the page\'s engineOpts, the stored engine state on a resume only (null on a cold start), and the page\'s sessionEndMs (0 when none)', async () => {
  const seen = [];
  ENGINES.fakevolatile = class {
    constructor(o) { this.o = o; }
    async boot() {}
    init(files, persisted, opts) { seen.push({ engineOpts: this.o.opts, persisted, opts }); return true; }
    changedFiles() { return {}; }
    setVolatileState() {}
    getVolatileState() { return null; }
  };
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => replies.push(m);
  const ls = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const key = 'ghost:g:files';
    const store = await Store.open('workertest');        // localStorage here: the worker reads the same one
    const base = { t: 'init', engine: 'fakevolatile', engineUrl: 'x', files: [], storeNamespace: 'workertest', storeKey: key, bootEpochMs: 5 };
    const init = async m => { await self.onmessage({ data: m }); return replies.filter(r => r.t === 'loaded').pop(); };
    const vol = { dicStamp: '0123abcd' };

    await store.set(key, { 'ghost/master/dic/a.dic': null });            // only a tombstone stored
    let r = await init({ ...base, id: 1, resume: true, volatile: vol, engineOpts: { module: 'aya5' } });
    assert.deepEqual([r.ok, r.hadSave], [true, false]);
    assert.deepEqual(seen[0].engineOpts, { module: 'aya5' });
    assert.deepEqual(seen[0].persisted, { 'ghost/master/dic/a.dic': null }, 'the tombstone still reaches the engine');
    assert.deepEqual(seen[0].opts, { resume: false, bootEpochMs: 5, volatile: vol, sessionEndMs: 0 }, 'no save: a cold engine load');

    await store.set(key, { 'ghost/master/dic/a.dic': null, 'ghost/master/yaya_variable.cfg': new Uint8Array([65]).buffer });
    r = await init({ ...base, id: 2, resume: true, volatile: vol });
    assert.equal(r.hadSave, true);
    assert.equal(seen[1].engineOpts, null, 'Satori\'s start sends none');
    assert.deepEqual(seen[1].opts, { resume: true, bootEpochMs: 5, volatile: vol, sessionEndMs: 0 });
    assert.deepEqual([...new Uint8Array(seen[1].persisted['ghost/master/yaya_variable.cfg'])], [65]);

    r = await init({ ...base, id: 3, resume: false, volatile: vol });
    assert.deepEqual(seen[2].opts, { resume: false, bootEpochMs: 5, volatile: null, sessionEndMs: 0 }, 'a cold start never gets the old state');
    // the page's end of the ghost's last session (its state's savedAt), for Kawari's D6 (kawari-wasm.md §8)
    r = await init({ ...base, id: 4, resume: false, sessionEndMs: 1234 });
    assert.deepEqual(seen[3].opts, { resume: false, bootEpochMs: 5, volatile: null, sessionEndMs: 1234 });
  } finally {
    delete ENGINES.fakevolatile;
    self.postMessage = post;
    if (ls === undefined) delete globalThis.localStorage; else globalThis.localStorage = ls;
  }
});

test('a failure that is no Error (Emscripten\'s FS.ErrnoError) is logged by its name and errno, not [object Object]', async () => {
  const errno = { name: 'ErrnoError', errno: 44 };             // FS.ErrnoError: no message, no stack
  assert.equal(errorText(errno), 'ErrnoError (errno 44)');
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.match(errorText(new Error('boom'), true), /^Error: boom\n\s+at /);
  assert.equal(errorText('plain'), 'plain');
  ENGINES.fakethrows = class {
    constructor() {}
    async boot() {}
    init() { return true; }
    request() { return 'SHIORI/3.0 204 No Content\r\n\r\n'; }
    changedFiles() { if (this.inited) throw errno; this.inited = true; return {}; }
    getVolatileState() { return null; }
    setVolatileState() {}
  };
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => replies.push(m);
  try {
    await self.onmessage({ data: { t: 'init', id: 1, engine: 'fakethrows', engineUrl: 'x', files: [] } });
    await self.onmessage({ data: { t: 'req', id: 2, text: 'NOTIFY SHIORI/3.0\r\nID: OnSecondChange\r\n\r\n' } });
    assert.deepEqual(replies.filter(r => r.t === 'log').map(r => [r.level, r.text]), [['error', 'ErrnoError (errno 44)']]);
    assert.deepEqual(replies.filter(r => r.t === 'error').map(r => r.error), ['ErrnoError (errno 44)']);
  } finally {
    delete ENGINES.fakethrows;
    self.postMessage = post;
  }
});

test('a request\'s time (`ms`) holds the scan for changed files after it, which runs before the reply; what it found is stored after', async () => {
  const order = [];
  ENGINES.fakescan = class {
    constructor() {}
    async boot() {}
    init() { return true; }
    request() { order.push('request'); return 'SHIORI/3.0 204 No Content\r\n\r\n'; }
    changedFiles() {
      if (!this.inited) { this.inited = true; return {}; }
      order.push('scan');
      const t = performance.now();
      while (performance.now() - t < 30) { /* a large ghost root */ }
      return { 'ghost/master/save.txt': new ArrayBuffer(1) };
    }
    save() { return false; }
    unload() { return {}; }
    getVolatileState() { return null; }
    setVolatileState() {}
  };
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => { replies.push(m); if (m.t === 'res' || m.t === 'saved') order.push(m.t); };
  try {
    await self.onmessage({ data: { t: 'init', id: 1, engine: 'fakescan', engineUrl: 'x', files: [] } });
    await self.onmessage({ data: { t: 'req', id: 2, text: 'GET SHIORI/3.0\r\nID: OnMouseMove\r\n\r\n' } });
    const res = replies.find(r => r.t === 'res');
    assert.ok(res.ms >= 25, `ms ${res.ms}`);
    assert.deepEqual(order, ['request', 'scan', 'res', 'saved']);
  } finally {
    await self.onmessage({ data: { t: 'unload', id: 3 } });      // the scheduled save's timer goes with the engine
    delete ENGINES.fakescan;
    self.postMessage = post;
  }
});

test('worker write / read (\\![execute,http-*], EV §4.15): the file goes in before the reply and is stored at once; init names ghostDir', async () => {
  const fsys = new Map();
  ENGINES.fakefiles = class {
    constructor() { this.ghostRoot = '/ssp/ghost/g/'; this.ghostDir = '/ssp/ghost/g/ghost/master/'; this.dirty = {}; }
    async boot() {}
    init() { return true; }
    writeMasterFile(rel, data) { fsys.set(rel, data); this.dirty[`ghost/master/${rel}`] = data; return this.ghostDir + rel; }
    readMasterFile(rel) { return fsys.has(rel) ? fsys.get(rel).slice(0) : null; }
    changedFiles() { const d = this.dirty; this.dirty = {}; return d; }
    getVolatileState() { return null; }
    setVolatileState() {}
  };
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => replies.push(m);
  try {
    await self.onmessage({ data: { t: 'init', id: 1, engine: 'fakefiles', engineUrl: 'x', files: [] } });
    assert.equal(replies.find(r => r.t === 'loaded').ghostDir, '/ssp/ghost/g/ghost/master/');
    const data = new Uint8Array([49, 48, 56]).buffer;
    await self.onmessage({ data: { t: 'write', id: 2, path: 'var/bonsyou_now.txt', data } });
    const written = replies.find(r => r.t === 'written');
    assert.deepEqual([written.id, written.path], [2, '/ssp/ghost/g/ghost/master/var/bonsyou_now.txt']);
    assert.ok(replies.indexOf(written) < replies.findIndex(r => r.t === 'saved' && r.files.includes('ghost/master/var/bonsyou_now.txt')),
      'answered first, then stored like any file the ghost writes');
    fsys.set('data/post.txt', new Uint8Array([49, 48, 56]).buffer);      // a shipped file, never written by the run
    await self.onmessage({ data: { t: 'read', id: 3, path: 'data/post.txt' } });
    await self.onmessage({ data: { t: 'read', id: 4, path: 'var/none.txt' } });
    // the download is a file the visitor's run wrote: never sent out (kawari-wasm.md §12 [decision])
    await self.onmessage({ data: { t: 'read', id: 9, path: 'var/bonsyou_now.txt' } });
    const reads = replies.filter(r => r.t === 'read');
    assert.deepEqual([...new Uint8Array(reads[0].data)], [49, 48, 56]);
    assert.equal(reads[1].data, null);
    assert.equal(reads[2].data, null);
    // --param-input-file never reads a personal file, however the path spells it (the engine resolves it the same way)
    for (const [id, path] of [[5, 'yaya_variable.cfg/.'], [6, 'x/../profile/ghost.dat'], [7, '..\\outside.txt'], [8, './/']]) {
      fsys.set(path, new Uint8Array([1]).buffer);               // the fake engine would hand it over as asked
      await self.onmessage({ data: { t: 'read', id, path } });
      assert.equal(replies.find(r => r.t === 'read' && r.id === id).data, null, path);
    }
  } finally {
    delete ENGINES.fakefiles;
    self.postMessage = post;
  }
});

test('--param-input-file never sends a file the visitor\'s run wrote (kawari-wasm.md §12 [decision]): a Kawari save of any name, a rewritten shipped file; Satori\'s keys too', async () => {
  const b = n => new Uint8Array([n]).buffer;
  // a root engine (YAYA, Kawari): ghost-root-relative keys
  const fsys = new Map([['dict-keeps-savedata.txt', b(1)], ['brain/memories2.txt', b(2)], ['dict-keeps.kis', b(3)], ['savefile1.txt', b(4)]]);
  const rootEng = {
    ghostRoot: '/ssp/ghost/k/', ghostDir: '/ssp/ghost/k/ghost/master/',
    readMasterFile: rel => { const k = [...fsys.keys()].find(p => p.toLowerCase() === String(rel).replace(/\\/g, '/').toLowerCase()); return k ? fsys.get(k).slice(0) : null; },
  };
  assert.equal(keyPrefix(rootEng), 'ghost/master/');
  const stored = {
    'ghost/master/dict-keeps-savedata.txt': b(1), 'ghost/master/brain/memories2.txt': b(2), 'ghost/master/dic/gone.kis': null,
    '?kawari/resume.kis': b(9),
  };
  for (const p of ['dict-keeps-savedata.txt', 'DICT-KEEPS-SAVEDATA.TXT', 'x/../dict-keeps-savedata.txt', 'brain\\memories2.txt']) {
    assert.equal(readForUpload(rootEng, stored, p), null, p);
  }
  assert.deepEqual([...new Uint8Array(readForUpload(rootEng, stored, 'dict-keeps.kis'))], [3], 'a shipped dictionary the run never wrote');
  assert.deepEqual([...new Uint8Array(readForUpload(rootEng, stored, 'savefile1.txt'))], [4], 'a file not stored yet');
  assert.equal(readForUpload(rootEng, stored, 'yaya_variable.cfg'), null, 'personal files stay refused');
  assert.equal(readForUpload(null, stored, 'dict-keeps.kis'), null, 'no engine');
  assert.equal(readForUpload({ ghostDir: '/x/' }, stored, 'dict-keeps.kis'), null, 'an engine that cannot read');
  // Satori: ghost/master-relative keys
  const satori = { ghostDir: '/ghost/master/', readMasterFile: () => b(5) };
  assert.equal(keyPrefix(satori), '');
  assert.equal(readForUpload(satori, { 'var/own.txt': b(1) }, 'var/own.txt'), null);
  assert.deepEqual([...new Uint8Array(readForUpload(satori, { 'var/own.txt': b(1) }, 'dic01.txt'))], [5]);
  assert.equal(keyPrefix({ ghostRoot: '/a/', ghostDir: '/b/ghost/master/' }), '', 'a ghostDir outside its root');

  // through the worker: what the run writes in a request is refused at once, before any debounced save
  ENGINES.fakeroot = class {
    constructor() { Object.assign(this, rootEng); this.dirty = {}; }
    async boot() {}
    init() { return true; }
    request() { fsys.set('savefile1.txt', b(7)); this.dirty['ghost/master/savefile1.txt'] = b(7); return 'SHIORI/3.0 204 No Content\r\n\r\n'; }
    save() { return false; }
    changedFiles() { const d = this.dirty; this.dirty = {}; return d; }
    getVolatileState() { return null; }
    setVolatileState() {}
  };
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => replies.push(m);
  try {
    await self.onmessage({ data: { t: 'init', id: 1, engine: 'fakeroot', engineUrl: 'x', files: [] } });
    await self.onmessage({ data: { t: 'read', id: 2, path: 'savefile1.txt' } });
    await self.onmessage({ data: { t: 'req', id: 3, text: 'NOTIFY SHIORI/3.0\r\nID: OnTest\r\n\r\n' } });      // schedules no save
    await self.onmessage({ data: { t: 'read', id: 4, path: 'savefile1.txt' } });
    const reads = replies.filter(r => r.t === 'read');
    assert.deepEqual([...new Uint8Array(reads[0].data)], [4], 'before the ghost wrote it');
    assert.equal(reads[1].data, null, 'after');
  } finally {
    delete ENGINES.fakeroot;
    self.postMessage = post;
  }
});

test('worker req with fmo (Satori P8): setFmo before the request; no call without it; an engine without setFmo (YAYA) is fine', async () => {
  const calls = [];
  const fake = (withFmo) => class {
    constructor() { if (withFmo) this.setFmo = t => calls.push(['setFmo', t]); }
    async boot() {}
    init() { return true; }
    request(text) { calls.push(['request', /ID: (\w+)/.exec(text)[1]]); return 'SHIORI/3.0 204 No Content\r\n\r\n'; }
    changedFiles() { return {}; }
    getVolatileState() { return null; }
    setVolatileState() {}
  };
  ENGINES.fakefmo = fake(true);
  ENGINES.fakenofmo = fake(false);
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => replies.push(m);
  const req = (id, ev, fmo) => self.onmessage({ data: { t: 'req', id, text: `NOTIFY SHIORI/3.0\r\nID: ${ev}\r\n\r\n`, ...(fmo === undefined ? {} : { fmo }) } });
  try {
    await self.onmessage({ data: { t: 'init', id: 1, engine: 'fakefmo', engineUrl: 'x', files: [] } });
    await req(2, 'OnA', 'T1');
    await req(3, 'OnB');
    await req(4, 'OnC', '');
    assert.deepEqual(calls, [['setFmo', 'T1'], ['request', 'OnA'], ['request', 'OnB'], ['setFmo', ''], ['request', 'OnC']]);
    calls.length = 0;
    await self.onmessage({ data: { t: 'init', id: 5, engine: 'fakenofmo', engineUrl: 'x', files: [] } });
    await req(6, 'OnD', 'T2');
    assert.deepEqual(calls, [['request', 'OnD']]);
    assert.deepEqual(replies.filter(r => r.t === 'res').map(r => r.id), [2, 3, 4, 6]);
    assert.deepEqual(replies.filter(r => r.t === 'error'), []);
    assert.equal(engineRequest({ request: t => `got ${t}` }, { text: 'x', fmo: 'T' }), 'got x', 'the step itself');
    // the call's kind and self (Kawari 7's SHIORI/2.x bridge), '' when the page sent none
    const meta = m => engineRequest({ request: (t, o) => o }, m);
    assert.deepEqual(meta({ text: 'x', kind: 'communicate', self: 'なな' }), { kind: 'communicate', self: 'なな' });
    assert.deepEqual(meta({ text: 'x' }), { kind: '', self: '' });
  } finally {
    delete ENGINES.fakefmo;
    delete ENGINES.fakenofmo;
    self.postMessage = post;
  }
});

// The build's table of hashed runtime files on the page and in the worker (safe updates): src/core/build.js's helpers
// with and without a table, the Runtime's worker URL and engine start options from its Site's `runtimeFiles` (no table:
// the plain names, no wasmUrl key), ShioriClient's init message, the worker's init and the Emscripten engines'
// locateFile, which hands a hashed `<e>.<h>.js` its hashed .wasm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILD, FILES, workerPath, enginePaths } from '../../src/core/build.js';
import { Site } from '../../src/core/site.js';
import { Runtime } from '../../src/core/runtime.js';
import { ShioriClient } from '../../src/core/shiori.js';
import { EmscriptenShiori } from '../../src/worker/engines/emscripten.js';
import { YayaEngine } from '../../src/worker/engines/yaya.js';
import { KawariEngine } from '../../src/worker/engines/kawari.js';
import { Kawari7Engine } from '../../src/worker/engines/kawari7.js';
import { SatoriEngine } from '../../src/worker/engines/satori.js';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('silent');
globalThis.self = globalThis.self || { postMessage() {} };
await import('../../src/worker/worker.js');
const { ENGINES } = await import('../../src/worker/engines/index.js');

const TABLE = {
  worker: 'engines/worker.0123456789.js',
  engines: {
    satori: { js: 'engines/satori.1111111111.js', wasm: 'engines/satori.2222222222.wasm' },
    yaya: { js: 'engines/yaya.3333333333.js', wasm: 'engines/yaya.4444444444.wasm' },
  },
};
const RUNTIME_URL = 'http://s/sumika/sumika.js';

test('unbundled (tests, site/dev): BUILD is dev and FILES null, so the helpers give the plain names', () => {
  assert.equal(BUILD, 'dev');
  assert.equal(FILES, null);
  assert.equal(workerPath(), 'engines/worker.js');
  assert.deepEqual(enginePaths('yaya'), { js: 'engines/yaya.js', wasm: null });
  assert.equal(workerPath(null), 'engines/worker.js');
  assert.deepEqual(enginePaths('kawari7', null), { js: 'engines/kawari7.js', wasm: null });
});

test('with a table: the hashed worker and engine pair; an engine the table lacks keeps its plain .js and no wasm', () => {
  assert.equal(workerPath(TABLE), 'engines/worker.0123456789.js');
  assert.deepEqual(enginePaths('satori', TABLE), { js: 'engines/satori.1111111111.js', wasm: 'engines/satori.2222222222.wasm' });
  assert.deepEqual(enginePaths('kawari', TABLE), { js: 'engines/kawari.js', wasm: null });
  assert.deepEqual(enginePaths('toString', TABLE), { js: 'engines/toString.js', wasm: null }, 'own keys only');
  assert.equal(workerPath({ engines: {} }), 'engines/worker.js', 'a table without a worker');
});

/** A Runtime on a Site with `runtimeFiles`, its ghost and state set as a boot would. */
function runtimeOn(runtimeFiles, ghost) {
  const rt = new Runtime({ base: 'http://s/', runtimeUrl: RUNTIME_URL, Channel: null, runtimeFiles });
  rt.index = { ghosts: [ghost], balloons: [] };
  rt.ghost = ghost;
  rt.state = { data: { engine: null } };
  return rt;
}
const SATORI = { id: 't', name: 'T', sakuraName: 'Ts', keroName: '', shiori: 'satori.dll', engine: 'satori', shells: [] };
const files = { list: () => [], bytes: async () => new ArrayBuffer(0) };

test('Runtime: the worker URL and the engine start options come from the Site\'s table; without one they are the plain ones, with no wasmUrl key', async () => {
  const rt = runtimeOn(TABLE, SATORI);
  assert.equal(rt.site.runtimeFiles, TABLE, 'the implicit Site takes the Runtime\'s runtimeFiles');
  assert.equal(rt._client().workerUrl, 'http://s/sumika/engines/worker.0123456789.js');
  const o = await rt._engineStartOptions(files, { resume: false, bootEpochMs: 1 });
  assert.equal(o.engineUrl, 'http://s/sumika/engines/satori.1111111111.js');
  assert.equal(o.wasmUrl, 'http://s/sumika/engines/satori.2222222222.wasm');

  // an engine the table lacks: its plain .js, no wasmUrl
  const k = runtimeOn(TABLE, { ...SATORI, id: 'k', engine: 'kawari7' });
  k._rootFiles = async () => ({ files: [], engineOpts: {} });
  const ko = await k._engineStartOptions(files, { resume: false, bootEpochMs: 1 });
  assert.equal(ko.engineUrl, 'http://s/sumika/engines/kawari7.js');
  assert.equal('wasmUrl' in ko, false);

  const plain = runtimeOn(null, SATORI);
  assert.equal(plain.site.runtimeFiles, null);
  assert.equal(plain._client().workerUrl, 'http://s/sumika/engines/worker.js');
  const po = await plain._engineStartOptions(files, { resume: false, bootEpochMs: 1 });
  assert.equal(po.engineUrl, 'http://s/sumika/engines/satori.js');
  assert.equal('wasmUrl' in po, false, 'no key at all: runtime.test.mjs\'s deepEqual of the start options stays');

  // unbundled by default (FILES null)
  const dflt = new Runtime({ base: 'http://s/', runtimeUrl: RUNTIME_URL, Channel: null });
  assert.equal(dflt.site.runtimeFiles, null);
  assert.equal(dflt._client().workerUrl, 'http://s/sumika/engines/worker.js');
});

test('a lead Site\'s slots: runtimeFiles goes along to every Runtime it makes, which reads the Site\'s', () => {
  const made = [];
  const site = new Site({ base: 'http://s/', runtimeUrl: RUNTIME_URL, Channel: null, runtimeFiles: TABLE,
    createRuntime: o => { made.push(o); return new Runtime(o); } });
  assert.equal(made[0].runtimeFiles, TABLE);
  assert.equal(made[0].site, site);
  assert.equal(site.slots[0].site.runtimeFiles, TABLE);
  assert.equal(site.slots[0]._client().workerUrl, 'http://s/sumika/engines/worker.0123456789.js');
});

/** Worker stand-in that records its init message and answers it. */
function recordingWorker(sent) {
  return class {
    constructor(url) { this.url = url; }
    postMessage(m) {
      sent.push(m);
      queueMicrotask(() => this.onmessage && this.onmessage({ data: { id: m.id, t: 'loaded', ok: true, hadSave: false } }));
    }
    terminate() {}
  };
}

test('ShioriClient.start: the init message carries wasmUrl, null when the page gives none', async () => {
  const sent = [];
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, Worker: globalThis.Worker };
  URL.createObjectURL = () => 'blob:http://s/0';
  URL.revokeObjectURL = () => {};
  globalThis.Worker = recordingWorker(sent);
  const start = { engine: 'satori', engineUrl: 'http://s/sumika/engines/satori.1111111111.js', files: [], storeNamespace: 'sumika', storeKey: 'ghost:t:files' };
  try {
    await new ShioriClient('http://s/sumika/engines/worker.0123456789.js').start({ ...start, wasmUrl: 'http://s/sumika/engines/satori.2222222222.wasm' });
    await new ShioriClient('http://s/sumika/engines/worker.js').start(start);
    assert.equal(sent[0].t, 'init');
    assert.equal(sent[0].wasmUrl, 'http://s/sumika/engines/satori.2222222222.wasm');
    assert.equal(sent[1].wasmUrl, null);
  } finally {
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    if (saved.Worker === undefined) delete globalThis.Worker; else globalThis.Worker = saved.Worker;
  }
});

test('worker init: createEngine gets the message\'s wasmUrl (null without one)', async () => {
  const made = [];
  ENGINES.fakewasm = class {
    constructor(o) { made.push(o); }
    async boot() {}
    init() { return true; }
    changedFiles() { return {}; }
    setVolatileState() {}
    getVolatileState() { return null; }
  };
  const post = self.postMessage;
  const replies = [];
  self.postMessage = m => replies.push(m);
  try {
    await self.onmessage({ data: { t: 'init', id: 1, engine: 'fakewasm', engineUrl: 'http://s/e/x.1111111111.js', wasmUrl: 'http://s/e/x.2222222222.wasm', files: [] } });
    await self.onmessage({ data: { t: 'init', id: 2, engine: 'fakewasm', engineUrl: 'http://s/e/x.js', files: [] } });
    assert.deepEqual(replies.filter(r => r.t === 'loaded').map(r => r.ok), [true, true]);
    assert.equal(made[0].engineUrl, 'http://s/e/x.1111111111.js');
    assert.equal(made[0].wasmUrl, 'http://s/e/x.2222222222.wasm');
    assert.equal(made[1].wasmUrl, null);
  } finally {
    delete ENGINES.fakewasm;
    self.postMessage = post;
  }
});

/** An Emscripten engine whose factory records the module options it is given (no wasm is loaded). */
class Probe extends EmscriptenShiori {
  async factory() { return async mod => { this.mod = mod; return { FS: {} }; }; }
}

test('Emscripten engines: locateFile gives the page\'s hashed .wasm for a .wasm, the engine\'s folder for anything else; without wasmUrl the plain mapping', async () => {
  const hashed = new Probe({ engineUrl: 'http://s/sumika/engines/yaya.3333333333.js', wasmUrl: 'http://s/sumika/engines/yaya.4444444444.wasm' });
  await hashed.boot();
  assert.equal(hashed.mod.locateFile('yaya.wasm'), 'http://s/sumika/engines/yaya.4444444444.wasm');
  assert.equal(hashed.mod.locateFile('YAYA.WASM'), 'http://s/sumika/engines/yaya.4444444444.wasm');
  assert.equal(hashed.mod.locateFile('yaya.data'), 'http://s/sumika/engines/yaya.data');

  const plain = new Probe({ engineUrl: 'http://s/sumika/engines/yaya.js' });
  await plain.boot();
  assert.equal(plain.wasmUrl, null);
  assert.equal(plain.mod.locateFile('yaya.wasm'), 'http://s/sumika/engines/yaya.wasm');
  const win = new Probe({ engineUrl: 'C:\\site\\engines\\satori.js' });
  await win.boot();
  assert.equal(win.mod.locateFile('satori.wasm'), 'C:\\site\\engines\\satori.wasm', 'a Windows path (the sweep)');

  // every engine class takes it: Satori inherits the constructor, the root engines pass it through SspRootShiori
  const opts = { ghostId: 'g', placeholders: [], site: { ghosts: [], balloons: [] } };
  const w = 'http://s/sumika/engines/e.5555555555.wasm';
  for (const E of [SatoriEngine, YayaEngine, KawariEngine, Kawari7Engine]) {
    assert.equal(new E({ engineUrl: 'http://s/sumika/engines/e.js', wasmUrl: w, opts }).wasmUrl, w, E.name);
    assert.equal(new E({ engineUrl: 'http://s/sumika/engines/e.js', opts }).wasmUrl, null, E.name);
  }
});

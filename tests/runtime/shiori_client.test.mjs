// ShioriClient's worker start (src/core/shiori.js): every engine start (each ghost change, a crash restart) makes a
// blob: URL for the worker bootstrap; it must not outlive the start. The init message carries the engine's options.
// A request's FMO text (Satori P8) is read when the request leaves the queue and posted only when it changed. A SHIORI
// reload (\![reload,shiori], EV §2.10) unloads and loads again inside the queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShioriClient, parseResponse } from '../../src/core/shiori.js';

/** Worker stand-in: answers the init message with `reply`. */
function fakeWorker(reply) {
  return class {
    constructor(url) { this.url = url; this.terminated = false; }
    postMessage(m) { queueMicrotask(() => this.onmessage && this.onmessage({ data: { id: m.id, ...reply } })); }
    terminate() { this.terminated = true; }
  };
}

test('engine start: the worker bootstrap blob URL is revoked once the engine answered, failed or stopped', async () => {
  const made = [];
  const revoked = [];
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, Worker: globalThis.Worker };
  URL.createObjectURL = () => { const u = `blob:http://s/${made.length}`; made.push(u); return u; };
  URL.revokeObjectURL = u => { revoked.push(u); };
  const opts = { engine: 'satori', engineUrl: 'http://s/sumika/engines/satori.js', files: [], storeNamespace: 'n', storeKey: 'ghost:x:files' };
  try {
    globalThis.Worker = fakeWorker({ t: 'init', ok: true, hadSave: false });
    const ok = new ShioriClient('http://s/sumika/engines/worker.js');
    await ok.start(opts);
    assert.equal(ok.worker.url, made[0]);
    assert.deepEqual(revoked, [made[0]], 'revoked as soon as the engine is up');
    ok.terminate();
    assert.deepEqual(revoked, [made[0]], 'only once');

    globalThis.Worker = fakeWorker({ t: 'init', ok: false, error: 'no dictionary' });
    await assert.rejects(new ShioriClient('http://s/sumika/engines/worker.js').start(opts), /no dictionary/);
    assert.deepEqual(revoked, made.slice(0, 2), 'and when it failed to load');

    globalThis.Worker = class { postMessage() {} terminate() {} };        // never answers
    const hung = new ShioriClient('http://s/sumika/engines/worker.js');
    const p = hung.start(opts);
    hung.terminate();                                                     // the runtime gives up on it
    await assert.rejects(p, /engine stopped/);
    assert.deepEqual(revoked, made, 'and when it was stopped first');
  } finally {
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    if (saved.Worker === undefined) delete globalThis.Worker; else globalThis.Worker = saved.Worker;
  }
});

test('engine start: engineOpts reaches the worker\'s init message (null when the page gives none), and sessionEndMs (0); the files are transferred', async () => {
  const sent = [];
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, Worker: globalThis.Worker };
  URL.createObjectURL = () => 'blob:http://s/0';
  URL.revokeObjectURL = () => {};
  globalThis.Worker = class {
    postMessage(m, transfer) {
      sent.push({ m, transfer });
      queueMicrotask(() => this.onmessage && this.onmessage({ data: { id: m.id, t: 'loaded', ok: true, hadSave: false } }));
    }
    terminate() {}
  };
  try {
    const data = new ArrayBuffer(3);
    const engineOpts = { module: 'aya5', ghostId: 'nodepsimoon', placeholders: ['shell/master/surface0.png'], site: { ghosts: [], balloons: ['sumika'] } };
    const c = new ShioriClient('http://s/sumika/engines/worker.js');
    await c.start({ engine: 'yaya', engineUrl: 'http://s/sumika/engines/yaya.js', files: [{ path: 'ghost/master/aya5.txt', data }],
      storeNamespace: 'sumika', storeKey: 'ghost:nodepsimoon:files', engineOpts });
    assert.deepEqual(sent[0].m.engineOpts, engineOpts);
    assert.equal(sent[0].m.engine, 'yaya');
    assert.deepEqual(sent[0].transfer, [data]);
    assert.equal(sent[0].m.sessionEndMs, 0, 'no end of a last session given');
    c.terminate();
    const s = new ShioriClient('http://s/sumika/engines/worker.js');
    await s.start({ engine: 'satori', engineUrl: 'http://s/sumika/engines/satori.js', files: [], storeNamespace: 'sumika', storeKey: 'ghost:t:files' });
    assert.equal(sent[1].m.engineOpts, null);
    s.terminate();
    // a cold boot's end of the ghost's last session (Kawari's D6, kawari-wasm.md §8) goes as it is
    const k = new ShioriClient('http://s/sumika/engines/worker.js');
    await k.start({ engine: 'kawari', engineUrl: 'http://s/sumika/engines/kawari.js', files: [], storeNamespace: 'sumika', storeKey: 'ghost:k:files',
      bootEpochMs: 20, sessionEndMs: 10 });
    assert.deepEqual([sent[2].m.resume, sent[2].m.bootEpochMs, sent[2].m.sessionEndMs], [false, 20, 10]);
    k.terminate();
  } finally {
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    if (saved.Worker === undefined) delete globalThis.Worker; else globalThis.Worker = saved.Worker;
  }
});

/**
 * Worker stand-in that records what it is sent; 'req' answers 204, at once or (hold: any message but init) when the
 * test releases it. fail[t] (RecWorker.fail for the workers made from now on): that message fails with this error.
 */
class RecWorker {
  constructor(url) {
    this.url = url; this.sent = []; this.hold = false; this.held = []; this.terminated = false; this.fail = { ...RecWorker.fail };
    RecWorker.made.push(this);
  }
  postMessage(m) {
    this.sent.push(m);
    const err = this.fail[m.t];
    const data = m.t === 'init' ? { id: m.id, t: 'loaded', ok: !err, hadSave: false, ...(err ? { error: err } : {}) }
      : err ? { id: m.id, t: 'error', error: err }
        : { id: m.id, t: 'res', text: 'SHIORI/3.0 204 No Content\r\n\r\n', ms: 0, vol: null };
    const answer = () => this.onmessage && this.onmessage({ data });
    if (m.t !== 'init' && this.hold) this.held.push(answer);
    else queueMicrotask(answer);
  }
  terminate() { this.terminated = true; }
  get reqs() { return this.sent.filter(m => m.t === 'req'); }
}
RecWorker.made = [];
RecWorker.fail = {};

async function withRecWorker(fn) {
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, Worker: globalThis.Worker };
  URL.createObjectURL = () => 'blob:http://s/0';
  URL.revokeObjectURL = () => {};
  globalThis.Worker = RecWorker;
  RecWorker.made = [];
  RecWorker.fail = {};
  try {
    await fn();
  } finally {
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    if (saved.Worker === undefined) delete globalThis.Worker; else globalThis.Worker = saved.Worker;
  }
}

const START = { engine: 'satori', engineUrl: 'http://s/sumika/engines/satori.js', files: [], storeNamespace: 'sumika', storeKey: 'ghost:x:files' };
const flush = () => new Promise(r => setImmediate(r));

test('request FMO text: read when the request leaves the queue, posted only when it changed, none without r.fmo', () => withRecWorker(async () => {
  const c = new ShioriClient('http://s/sumika/engines/worker.js');
  await c.start(START);
  const w = RecWorker.made[0];
  let text = 'A';
  const reads = [];
  const fmo = () => { reads.push(text); return text; };
  w.hold = true;
  const slow = c.request({ id: 'OnSlow', fmo });
  const next = c.request({ id: 'OnNext', fmo });          // waits behind the slow one
  await flush();
  assert.deepEqual(reads, ['A'], 'only the request that left the queue read it');
  text = 'B';
  w.hold = false;
  w.held.shift()();
  await slow;
  await next;
  assert.deepEqual(reads, ['A', 'B'], 'the queued request read the text of its own time');
  await c.request({ id: 'OnSame', fmo });                  // still 'B'
  await c.request({ id: 'OnNone' });                       // a request without r.fmo (YAYA's, a resource)
  await c.request({ id: 'OnNull', fmo: () => null });
  text = 'C';
  await c.request({ id: 'OnChanged', fmo });
  assert.deepEqual(w.reqs.map(m => [/ID: (\w+)/.exec(m.text)[1], 'fmo' in m ? m.fmo : '-']),
    [['OnSlow', 'A'], ['OnNext', 'B'], ['OnSame', '-'], ['OnNone', '-'], ['OnNull', '-'], ['OnChanged', 'C']]);
  c.terminate();
}));

test('request FMO text: a new engine (start, or terminate + start) gets the text again', () => withRecWorker(async () => {
  const c = new ShioriClient('http://s/sumika/engines/worker.js');
  const fmo = () => 'A';
  await c.start(START);
  await c.request({ id: 'OnA', fmo });
  await c.request({ id: 'OnA', fmo });
  await c.start(START);                                    // a restart without terminate
  await c.request({ id: 'OnA', fmo });
  await c.request({ id: 'OnA', fmo });
  c.terminate();
  await c.start(START);
  await c.request({ id: 'OnA', fmo });
  assert.deepEqual(RecWorker.made.map(w => w.reqs.map(m => m.fmo)), [['A', undefined], ['A', undefined], ['A']]);
  c.terminate();
}));

test('request FMO text: a throwing r.fmo is logged once and the request still goes, without text', () => withRecWorker(async () => {
  const logs = [];
  const c = new ShioriClient('http://s/sumika/engines/worker.js', { onLog: (level, text) => logs.push([level, text]) });
  await c.start(START);
  const bad = () => { throw new Error('no peers'); };
  const a = await c.request({ id: 'OnA', fmo: bad });
  const b = await c.request({ id: 'OnB', fmo: bad });
  await c.request({ id: 'OnC', fmo: () => 'T' });
  assert.deepEqual([a.status, b.status], [204, 204]);
  assert.deepEqual(RecWorker.made[0].reqs.map(m => m.fmo), [undefined, undefined, 'T']);
  const fmoLogs = logs.filter(([, t]) => /no peers/.test(t));
  assert.equal(fmoLogs.length, 1, JSON.stringify(logs));
  c.terminate();
}));

test('request FMO text: a request still queued when the engine stops never reads it (its ghost may be torn down)', () => withRecWorker(async () => {
  const c = new ShioriClient('http://s/sumika/engines/worker.js');
  await c.start(START);
  const w = RecWorker.made[0];
  const reads = [];
  const fmo = () => { reads.push('read'); return 'A'; };
  w.hold = true;
  const busy = c.request({ id: 'OnMouseMove', fmo });     // in flight
  const queued = c.request({ id: 'OnSecondChange', fmo }); // behind it
  await flush();
  assert.equal(reads.length, 1);
  c.terminate();                                           // a teardown, a page restart
  await assert.rejects(busy, /engine stopped/);
  await assert.rejects(queued, /engine (stopped|not running)/);
  assert.equal(reads.length, 1, 'the queued request read no FMO');
}));

test('engine start: a worker error before init is answered (its script did not load) fails the start; later errors only log', async () => {
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, Worker: globalThis.Worker };
  const revoked = [];
  URL.createObjectURL = () => 'blob:http://s/0';
  URL.revokeObjectURL = u => { revoked.push(u); };
  const logs = [];
  try {
    // a browser's failed importScripts: an 'error' event, and the init message is never answered
    globalThis.Worker = class { postMessage() { queueMicrotask(() => this.onerror && this.onerror({ message: 'NetworkError: importScripts failed' })); } terminate() {} };
    const c = new ShioriClient('http://cdn/engines/worker.js', { onLog: (level, text) => logs.push([level, text]) });
    await assert.rejects(c.start(START), /importScripts failed/);
    assert.deepEqual(logs, [['error', 'worker: NetworkError: importScripts failed']]);
    assert.deepEqual(revoked, ['blob:http://s/0']);
    assert.equal(c.pending.size, 0);

    let worker = null;
    globalThis.Worker = class {
      constructor() { worker = this; }
      postMessage(m) { queueMicrotask(() => this.onmessage && this.onmessage({ data: { id: m.id, t: 'loaded', ok: true, hadSave: false } })); }
      terminate() {}
    };
    const ok = new ShioriClient('http://s/sumika/engines/worker.js', { onLog: (level, text) => logs.push([level, text]) });
    await ok.start(START);
    worker.onerror({ message: 'late' });                   // after the start: logged, nothing else
    assert.deepEqual(logs.at(-1), ['error', 'worker: late']);
    assert.equal(ok.running, true);
    ok.terminate();
  } finally {
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    if (saved.Worker === undefined) delete globalThis.Worker; else globalThis.Worker = saved.Worker;
  }
});

test('request kind / self: posted beside the text for a SHIORI/2.x engine\'s bridge, only when given; parseResponse reads the protocol', () => withRecWorker(async () => {
  const c = new ShioriClient('http://s/sumika/engines/worker.js');
  await c.start(START);
  const w = RecWorker.made[0];
  await c.request({ id: 'homeurl', kind: 'resource' });
  await c.request({ id: 'OnCommunicate', refs: ['Other', 'hi'], kind: 'communicate', self: 'Me' });
  await c.request({ id: 'OnBoot' });
  assert.deepEqual(w.reqs.map(m => [m.kind ?? '-', m.self ?? '-']), [['resource', '-'], ['communicate', 'Me'], ['-', '-']]);
  assert.ok(!/kind|self/i.test(w.reqs[1].text), 'not in the request text');
  c.terminate();
  assert.equal(parseResponse('SHIORI/2.6 200 OK\r\nValue: x\r\n\r\n').protocol, 2.6);
  assert.equal(parseResponse('SHIORI/3.0 204 No Content\r\n\r\n').protocol, 3);
  assert.equal(parseResponse('garbage').protocol, 3);
}));

test('reload (\\![reload,shiori], EV §2.10): in the queue, the old worker unloads and goes, a new one loads from opts(); a request asked meanwhile reaches the new engine, with the FMO text again', () => withRecWorker(async () => {
  const c = new ShioriClient('http://s/sumika/engines/worker.js');
  await c.start({ ...START, resume: true, volatile: { talk: 3 }, bootEpochMs: 7 });
  const old = RecWorker.made[0];
  const fmo = () => 'A';
  await c.request({ id: 'OnA', fmo });
  old.hold = true;
  const before = c.request({ id: 'OnBefore', fmo });        // in flight when the reload is asked
  let asked = 0;
  const reloaded = c.reload(async () => { asked++; return { ...START, resume: false, bootEpochMs: 7 }; });
  const after = c.request({ id: 'OnAfter', fmo });           // asked during the reload
  await flush();
  assert.equal(asked, 0, 'the reload waits for the request asked before it');
  old.hold = false;
  old.held.shift()();
  await before;
  const r = await reloaded;
  assert.equal(r.ok, true);
  await after;
  assert.equal(asked, 1, 'the options are built once the unload is done');
  assert.deepEqual(old.sent.map(m => m.t), ['init', 'req', 'req', 'unload'], 'the old engine unloads (the worker stores its files)');
  assert.equal(old.terminated, true);
  assert.equal(RecWorker.made.length, 2);
  const w = RecWorker.made[1];
  assert.deepEqual([w.sent[0].t, w.sent[0].resume, w.sent[0].volatile, w.sent[0].bootEpochMs], ['init', false, null, 7], 'a cold load');
  assert.deepEqual(w.reqs.map(m => [/ID: (\w+)/.exec(m.text)[1], m.fmo]), [['OnAfter', 'A']], 'the new engine gets the FMO text again');
  assert.equal(c.running, true);
  c.terminate();
}));

test('reload: an unload that fails is logged and the load goes on; a load that fails rejects and leaves the client stopped; no engine, or a teardown meanwhile, starts nothing (`stopped`)', () => withRecWorker(async () => {
  const logs = [];
  const c = new ShioriClient('http://s/sumika/engines/worker.js', { onLog: (level, text) => logs.push([level, text]) });
  await c.start(START);
  RecWorker.made[0].fail = { unload: 'unload threw' };
  RecWorker.fail = { init: 'no dictionary' };
  const failed = await c.reload(() => START).catch(e => e);
  assert.match(String(failed && failed.message), /no dictionary/);
  assert.notEqual(failed.stopped, true, 'a load that failed: the runtime restarts the engine as a crash');
  assert.ok(logs.some(([l, t]) => l === 'warn' && /unload threw/.test(t)), JSON.stringify(logs));
  assert.equal(RecWorker.made.length, 2);
  assert.equal(RecWorker.made[1].terminated, true);
  assert.equal(c.running, false);
  await assert.rejects(c.request({ id: 'OnLater' }), /engine not running/);
  RecWorker.fail = {};
  const none = await c.reload(() => START).catch(e => e);
  assert.equal(none.stopped, true, 'no engine at its turn');
  assert.equal(RecWorker.made.length, 2);

  // a teardown while the old engine unloads
  await c.start(START);
  const w = RecWorker.made[2];
  w.hold = true;
  let asked = 0;
  const r = c.reload(() => { asked++; return START; });
  await flush();
  assert.deepEqual(w.sent.map(m => m.t), ['init', 'unload']);
  c.terminate();
  const e = await r.catch(x => x);
  assert.equal(e.stopped, true);
  assert.equal(asked, 0);
  assert.equal(RecWorker.made.length, 3);
  assert.equal(c.running, false);

  // a teardown while the options are built
  await c.start(START);
  let release = null;
  const r2 = c.reload(() => new Promise(res => { release = () => res(START); }));
  for (let i = 0; i < 5 && !release; i++) await flush();
  assert.ok(release, 'the old engine unloaded');
  c.terminate();
  release();
  assert.equal((await r2.catch(x => x)).stopped, true);
  assert.equal(RecWorker.made.length, 4, 'no new worker');
  assert.equal(c.running, false);
}));

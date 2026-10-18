// The storage hub's IndexedDB over store ports (core/portstore.js): PortStore's
// Store interface against a store server written from the protocol (read / get / set / delete / keys, Blobs and
// ArrayBuffer maps), a hub that does not answer (each op's timeout; an open that times out is lost: reads reject, so
// the worker runs memory-only and writes nothing), a hub that says 'memory', close(), a port the hub retired (a lost
// store, quietly) and hold(); a real MessageChannel; the worker's store choice (init.storePort: its save files read,
// stored after a request and at unload, forgotten through the port); ShioriClient.start transferring the port; Runtime's
// start options with and without the hub, an engine start's port marked `retire` and openStore's not.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PortStore, STORE_OP_MS } from '../../src/core/portstore.js';
import { HubClient } from '../../src/core/hub.js';
import { platform, storePort } from '../../src/core/platform.js';
import { ShioriClient } from '../../src/core/shiori.js';
import { Runtime } from '../../src/core/runtime.js';
import { memoryStorage } from '../../src/core/state.js';
import { FakeClock, settle } from './fakes.mjs';
import { FakeChannel, FakeHubSite, FakeHubDoc, fakePage, hubOpts, HUB_URL } from './hub_fakes.mjs';

globalThis.self = globalThis.self || { postMessage() {} };
const { ENGINES } = await import('../../src/worker/engines/index.js');
await import('../../src/worker/worker.js');

afterEach(() => platform.clear());

/** a store port served by a fake hub document on `site` (its IndexedDB stand-in) */
function served(site = new FakeHubSite()) {
  const ch = new FakeChannel();
  new FakeHubDoc(site, site.tab()).serveStore(ch.port2);
  return { port: ch.port1, site };
}

test('PortStore: the Store interface over the hub\'s IndexedDB (read, get, set, delete, keys; ArrayBuffer maps and Blobs as they are)', async () => {
  const { port, site } = served();
  const s = await PortStore.open(port);
  assert.equal(s.kind, 'indexeddb');
  assert.equal(await s.read('none'), undefined);
  const files = { 'ghost/master/a.txt': new Uint8Array([1, 2]).buffer, 'ghost/master/gone.txt': null };
  assert.equal(await s.set('ghost:g:files', files), true);
  const back = await s.read('ghost:g:files');
  assert.deepEqual([...new Uint8Array(back['ghost/master/a.txt'])], [1, 2]);
  assert.equal(back['ghost/master/gone.txt'], null);
  assert.ok(site.idb.get('ghost:g:files')['ghost/master/a.txt'] instanceof ArrayBuffer);
  await s.set('drop:x', { blob: new Blob(['abc']) });
  assert.equal((await s.get('drop:x')).blob.size, 3);
  assert.deepEqual((await s.keys('drop:')).sort(), ['drop:x']);
  assert.equal(await s.delete('drop:x'), true);
  assert.deepEqual(await s.keys('drop:'), []);
  site.storeFails = true;
  await assert.rejects(s.read('ghost:g:files'), /NotReadableError/, 'a failed read is no "nothing stored"');
  assert.equal((await s.get('ghost:g:files'))['ghost/master/gone.txt'], null, 'get answers from this page\'s memory');
  assert.equal(await s.set('k', 1), false);
  assert.equal(await s.delete('k'), false);
  await assert.rejects(s.keys(''), /NotReadableError/);
});

test('PortStore: a hub that stops answering: each op times out (read and keys reject, set and delete false); close() answers waiting ops at once', async () => {
  const clock = new FakeClock();
  const site = new FakeHubSite();
  const ch = new FakeChannel();
  new FakeHubDoc(site, site.tab()).serveStore(ch.port2);
  const s = await PortStore.open(ch.port1, { clock });
  site.storeSilent = true;
  const r = s.read('k');
  const w = s.set('k', 1);
  const d = s.delete('k');
  const k = s.keys('');
  const rr = r.then(() => null, e => e);
  const kk = k.then(() => null, e => e);
  let settledYet = false;
  rr.finally(() => { settledYet = true; });
  await clock.advance(STORE_OP_MS - 1);
  assert.equal(settledYet, false);
  await clock.advance(1);
  assert.match(String(await rr), /did not answer/);
  assert.equal(await w, false);
  assert.equal(await d, false);
  assert.match(String(await kk), /did not answer/);
  const late = s.read('k');
  s.close();
  await assert.rejects(late, /closed/);
  assert.equal(s.closed, true);
  await assert.rejects(s.read('k'), /closed/, 'and every later op');
  assert.equal(await s.set('k', 2), false);
  assert.equal(await s.get('k'), 2, 'the memory map stays');
});

test('PortStore: a write answered `retired` (an engine start\'s port, retired at the hub\'s pagehide into the back/forward cache): false, then a lost store, quietly (kind memory, closed: later ops answered at once, nothing sent); hold(): writes kept in memory and answered false, nothing sent, reads still go', async () => {
  const site = new FakeHubSite();
  const doc = new FakeHubDoc(site, site.tab());
  const ch = new FakeChannel();
  doc.serveStore(ch.port2, true);
  const s = await PortStore.open(ch.port1);
  assert.equal(await s.set('ghost:g:files', 1), true);
  doc.pagehide(true);
  assert.equal(await s.read('ghost:g:files'), 1, 'reads are still answered');
  site.log.length = 0;
  assert.equal(await s.set('ghost:g:files', 2), false);
  assert.deepEqual([s.kind, s.closed], ['memory', true], 'lost: the worker warns nothing and writes nothing more');
  assert.equal(site.idb.get('ghost:g:files'), 1);
  assert.equal(await s.delete('ghost:g:files'), false);
  await assert.rejects(s.read('ghost:g:files'), /closed/);
  assert.deepEqual(site.log.map(m => m.store), ['set'], 'only the refused write went out');
  // hold (a page in the back/forward cache: HubClient)
  const h = await PortStore.open(served(site).port);
  assert.equal(h.held, false);
  h.hold(true);
  site.log.length = 0;
  assert.equal(await h.set('drop:a', 1), false);
  assert.equal(await h.delete('ghost:g:files'), false);
  assert.equal(await h.read('ghost:g:files'), 1, 'reads go');
  assert.deepEqual(site.log.map(m => m.store), ['read']);
  assert.equal(site.idb.has('drop:a'), false);
  h.hold(false);
  assert.equal(await h.set('drop:a', 2), true);
  assert.equal(site.idb.get('drop:a'), 2);
});

test('PortStore.open: no first message within the timeout: lost (kind memory, reads reject: the worker then writes nothing); the hub\'s memory: its ops answered there; the page\'s own `local` answer and no port: this page\'s memory', async () => {
  const clock = new FakeClock();
  const ch = new FakeChannel();
  const p = PortStore.open(ch.port1, { clock });
  await clock.advance(STORE_OP_MS);
  const lost = await p;
  assert.deepEqual([lost.kind, lost.closed], ['memory', true]);
  await assert.rejects(lost.read('k'));
  assert.equal(await lost.set('k', 1), false);
  const site = new FakeHubSite();
  site.caps = { ...site.caps, store: 'memory' };
  const mem = await PortStore.open(served(site).port);
  assert.equal(mem.kind, 'memory');
  assert.equal(await mem.set('k', 1), false, 'memory is no storage (Store\'s answer)');
  assert.equal(await mem.read('k'), 1, 'the hub document kept it');
  assert.deepEqual(site.log.filter(m => m.store).map(m => m.store), ['set', 'read'], 'sent to the hub');
  const own = new FakeChannel();
  own.port2.postMessage({ t: 'store', kind: 'memory', local: true });
  const local = await PortStore.open(own.port1);
  assert.deepEqual([local.kind, local.closed], ['memory', true]);
  assert.equal(await local.read('k'), undefined);
  assert.equal(await local.set('k', 1), false, 'kept in this page\'s memory only');
  assert.equal(await local.read('k'), 1);
  assert.deepEqual(await local.keys(''), ['k']);
  assert.equal(await local.delete('k'), true);
  const none = await PortStore.open(null);
  assert.equal(none.kind, 'memory');
});

test('PortStore over a real MessageChannel (structured clone, the port started by onmessage)', async () => {
  const ch = new MessageChannel();
  const server = new FakeHubDoc(new FakeHubSite(), memoryStorage());
  server.serveStore(ch.port2);
  try {
    const s = await PortStore.open(ch.port1);
    assert.equal(await s.set('a', { x: new Uint8Array([7]).buffer }), true);
    assert.deepEqual([...new Uint8Array((await s.read('a')).x)], [7]);
    s.close();
  } finally {
    ch.port1.close();
    ch.port2.close();
  }
});

test('worker init with storePort: the save files are read and stored through the port, at once after a request and before unload answers; forget deletes them', async () => {
  const site = new FakeHubSite();
  site.idb.set('ghost:g:files', { 'save.txt': new Uint8Array([9]).buffer });
  let n = 0;
  const seen = [];
  ENGINES.fakehub = class {
    constructor() {}
    async boot() {}
    init(files, persisted, opts) { seen.push({ persisted, opts }); return true; }
    request() { return 'SHIORI/3.0 204 No Content\r\n\r\n'; }
    changedFiles() { n++; return n === 2 ? { 'save.txt': new Uint8Array([1, n]).buffer } : {}; }
    unload() { return { 'save.txt': new Uint8Array([2]).buffer }; }
    save() {}
    getVolatileState() { return null; }
  };
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => replies.push(m);
  const ls = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const { port } = served(site);
    const base = { engine: 'fakehub', engineUrl: 'x', files: [], storeNamespace: 'sumika', storeKey: 'ghost:g:files', resume: true };
    await self.onmessage({ data: { t: 'init', id: 1, ...base, storePort: port } });
    const loaded = replies.find(r => r.t === 'loaded');
    assert.deepEqual([loaded.ok, loaded.hadSave], [true, true]);
    assert.deepEqual([...new Uint8Array(seen[0].persisted['save.txt'])], [9], 'read through the port');
    await self.onmessage({ data: { t: 'req', id: 2, text: 'NOTIFY SHIORI/3.0\r\nID: OnSecondChange\r\n\r\n' } });
    assert.deepEqual([...new Uint8Array(site.idb.get('ghost:g:files')['save.txt'])], [1, 2], 'stored after the request');
    await self.onmessage({ data: { t: 'unload', id: 3 } });
    assert.deepEqual([...new Uint8Array(site.idb.get('ghost:g:files')['save.txt'])], [2], 'stored before unload answered');
    assert.ok(replies.some(r => r.t === 'unloaded'));
    await self.onmessage({ data: { t: 'forget', id: 4 } });
    assert.equal(site.idb.has('ghost:g:files'), false);
    assert.equal(globalThis.localStorage.length, 0, 'nothing in the page origin\'s storage');
    // a hub whose read fails: memory-only, nothing written over the record
    site.idb.set('ghost:g:files', { 'save.txt': new Uint8Array([5]).buffer });
    site.storeFails = true;
    replies.length = 0;
    await self.onmessage({ data: { t: 'init', id: 5, ...base, storePort: served(site).port } });
    assert.equal(replies.find(r => r.t === 'loaded').hadSave, false);
    assert.ok(replies.some(r => r.t === 'log' && /could not be read/.test(r.text)));
    site.storeFails = false;
    site.log.length = 0;
    await self.onmessage({ data: { t: 'unload', id: 6 } });
    assert.deepEqual([...new Uint8Array(site.idb.get('ghost:g:files')['save.txt'])], [5], 'the record untouched');
    assert.equal(site.log.filter(m => m.store === 'set').length, 0);
  } finally {
    delete ENGINES.fakehub;
    self.postMessage = post;
    if (ls === undefined) delete globalThis.localStorage; else globalThis.localStorage = ls;
  }
});

test('ShioriClient.start: storePort goes in init and in its transfer list; without it the init message has no storePort', async () => {
  const posted = [];
  const saved = { Worker: globalThis.Worker, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => {};
  globalThis.Worker = class {
    postMessage(m, transfer) { posted.push({ m, transfer }); queueMicrotask(() => this.onmessage({ data: { id: m.id, t: 'loaded', ok: true } })); }
    terminate() {}
  };
  try {
    const opts = { engine: 'satori', engineUrl: 'http://s/e.js', files: [{ path: 'a', data: new ArrayBuffer(1) }], storeNamespace: 'sumika', storeKey: 'k' };
    const port = new FakeChannel().port1;
    await new ShioriClient('http://s/w.js').start({ ...opts, storePort: port });
    assert.equal(posted[0].m.storePort, port);
    assert.ok(posted[0].transfer.includes(port));
    assert.ok(posted[0].transfer.includes(opts.files[0].data));
    await new ShioriClient('http://s/w.js').start({ ...opts, files: [] });
    assert.equal('storePort' in posted[1].m, false);
    assert.deepEqual(posted[1].transfer, []);
  } finally {
    globalThis.Worker = saved.Worker;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
});

test('Runtime\'s start options: a fresh store port per engine start with a live hub; none without the hub; a gone hub\'s port answers memory at once', async () => {
  const rt = new Runtime({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js' });
  assert.deepEqual(rt._storePortOpt(), {}, 'no hub: the worker opens IndexedDB itself');
  const site = new FakeHubSite();
  const page = fakePage(site);
  const hub = new HubClient(HUB_URL, hubOpts(page, new FakeClock()));
  platform.install(hub);
  await hub.ready();
  const a = rt._storePortOpt().storePort;
  const b = rt._storePortOpt().storePort;
  assert.ok(a && b && a !== b, 'one per start');
  const sa = await PortStore.open(a);
  assert.equal(sa.kind, 'indexeddb');
  page.hubDocs[0].pagehide(false);
  await settle();
  assert.equal(hub.state, 'gone');
  const g = await PortStore.open(storePort());
  assert.equal(g.kind, 'memory', 'never another store, never a 15 s wait');
});

test('the store ports a page asks for: an engine start\'s is marked `retire` (the hub retires it at its pagehide into the back/forward cache: the restart starts the engine with a new one), openStore\'s is not (the dropped files work after the restore)', async () => {
  const site = new FakeHubSite();
  const page = fakePage(site);
  const hub = new HubClient(HUB_URL, hubOpts(page, new FakeClock()));
  platform.install(hub);
  await hub.ready();
  const rt = new Runtime({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js' });
  const engine = await PortStore.open(rt._storePortOpt().storePort);
  const drops = await hub.openStore('sumika');
  assert.deepEqual(site.log.filter(m => m.op === 'store').map(m => m.retire === true), [true, false]);
  page.hubDocs[0].pagehide(true);
  assert.equal(await engine.set('ghost:g:files', 1), false, 'retired');
  assert.equal(engine.kind, 'memory');
  assert.equal(await drops.set('drop:a', 1), true, 'kept');
  const next = await PortStore.open(rt._storePortOpt().storePort);
  assert.equal(await next.set('ghost:g:files', 2), true, 'a port asked for after the pagehide stores');
  assert.deepEqual([site.idb.get('ghost:g:files'), site.idb.get('drop:a')], [2, 1]);
});

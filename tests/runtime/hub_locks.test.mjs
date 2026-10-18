// The storage hub's locks, channels and wills (core/hub.js): GhostLock over hub.locks
// (one engine per ghost across the origins of one site), a lock that is not granted, a hub that goes while a request
// waits (GhostLock's three-argument call: not acquired, never "run anyway"; DropStore's two-argument call: rejected,
// so its read-modify-write never runs without the lock), the grant's delta applied before the callback (what
// state.reload() reads), hub.Channel carrying takeovers and set messages with their delta, and StateStore's will (once
// per tenure, never read-only or newer) that the hub commits before it lets the lock go.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HubClient } from '../../src/core/hub.js';
import { platform } from '../../src/core/platform.js';
import { GhostLock, StateStore, memoryStorage, stateKey, runtimePrefs } from '../../src/core/state.js';
import { DropStore } from '../../src/core/drops.js';
import { FakeClock, settle } from './fakes.mjs';
import { FakeHubSite, fakePage, hubOpts, HUB_URL } from './hub_fakes.mjs';

const realWarn = console.warn;
beforeEach(() => {
  console.warn = () => {};
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
});
afterEach(() => { console.warn = realWarn; platform.clear(); });

/** a live HubClient (a tab of some origin) over the fake hub site */
async function tab(site) {
  const page = fakePage(site);
  const hub = new HubClient(HUB_URL, hubOpts(page, new FakeClock()));
  assert.equal(await hub.ready(), 'live');
  return { hub, doc: page.hubDocs[0] };
}

const ghostLock = (hub, id) => new GhostLock(id, { locks: hub.locks, Channel: hub.Channel });

test('GhostLock over hub.locks: one tab of any origin holds a ghost; ifAvailable answers at once; a release hands it to the waiting tab', async () => {
  const site = new FakeHubSite();
  const a = await tab(site);
  const b = await tab(site);
  const la = ghostLock(a.hub, 'x');
  const lb = ghostLock(b.hub, 'x');
  assert.equal(la.mechanism, 'locks');
  assert.equal(await la.acquire(), true);
  assert.equal(await lb.acquire(), false, 'held by the other origin\'s tab');
  const wait = lb.acquire({ wait: true });
  await settle();
  la.release();
  assert.equal(await wait, true);
  assert.equal(lb.held, true);
  assert.ok(site.locks.held.has('sumika:x'));
  lb.release();
  await settle();
  assert.equal(site.locks.held.has('sumika:x'), false, 'the release reached the hub (unlock)');
});

test('a grant for a GhostLock disposed meanwhile is let go at once (state.js), and the hub hears the unlock', async () => {
  const site = new FakeHubSite();
  const a = await tab(site);
  const b = await tab(site);
  const la = ghostLock(a.hub, 'x');
  await la.acquire();
  const lb = ghostLock(b.hub, 'x');
  const wait = lb.acquire({ wait: true });
  await settle();
  lb.dispose();
  la.release();
  assert.equal(await wait, false);
  await settle();
  assert.equal(site.locks.held.has('sumika:x'), false);
  assert.ok(site.log.some(m => m.op === 'unlock'));
});

test('the hub goes while a GhostLock waits: not acquired (never "run anyway"); a later request: not acquired at once', async () => {
  const site = new FakeHubSite();
  const a = await tab(site);
  const b = await tab(site);
  await ghostLock(a.hub, 'x').acquire();
  const lb = ghostLock(b.hub, 'x');
  const wait = lb.acquire({ wait: true });
  await settle();
  b.doc.pagehide(false);
  assert.equal(await wait, false);
  assert.equal(lb.held, false);
  assert.equal(b.hub.state, 'gone');
  assert.equal(await ghostLock(b.hub, 'y').acquire({ wait: true }), false, 'a lock asked after the hub went');
});

test('the two-argument call (DropStore): runs under the lock; rejects when the hub goes, the callback never run without it; options it does not offer throw', async () => {
  const site = new FakeHubSite();
  const a = await tab(site);
  const b = await tab(site);
  const order = [];
  await a.hub.locks.request('sumika/drops', async lock => { order.push(['a', lock && lock.name]); });
  assert.deepEqual(order, [['a', 'sumika/drops']]);
  let release;
  const held = a.hub.locks.request('sumika/drops', () => new Promise(r => { release = r; }));
  await settle();
  const ran = [];
  const waiting = b.hub.locks.request('sumika/drops', lock => { ran.push(lock); });
  await settle();
  b.doc.pagehide(false);
  await assert.rejects(waiting, /sumika\/drops/);
  assert.deepEqual(ran, [], 'never called, not even with null');
  release();
  await held;
  await assert.rejects(b.hub.locks.request('sumika/drops', () => {}), /gone/);
  for (const o of [{ steal: true }, { mode: 'shared' }, { signal: {} }]) {
    await assert.rejects(a.hub.locks.request('sumika/x', o, () => {}), TypeError, JSON.stringify(o));
  }
  await assert.rejects(a.hub.locks.request('other', () => {}), TypeError, 'only sumika names');
  assert.equal(await a.hub.locks.request('sumika/x', { mode: 'exclusive', ifAvailable: true }, l => l && l.mode), 'exclusive');
});

test('DropStore over the hub (2-arg locks): a file dropped on one origin is stored in the hub\'s IndexedDB, under its lock', async () => {
  const site = new FakeHubSite();
  const a = await tab(site);
  const drops = new DropStore({ backend: () => a.hub.openStore('sumika'), locks: a.hub.locks, estimate: a.hub.estimator(), storable: () => true });
  const [e] = drops.add([new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: 'audio/mpeg' })]);
  await drops.whenIdle();
  const lower = e.path.toLowerCase();
  assert.ok(site.idb.has(`drop:${lower}`), 'the file record');
  assert.ok(site.idb.get('drop:index').files[lower]);
  assert.ok(site.log.some(m => m.op === 'lock' && m.name === 'sumika/drops'));
  assert.ok(site.log.some(m => m.op === 'estimate'));
  const b = await tab(site);
  const other = new DropStore({ backend: () => b.hub.openStore('sumika'), locks: b.hub.locks, estimate: null });
  const blob = await other.blob(e.path);
  assert.equal(blob && blob.size, 3, 'another origin plays it');
});

test('a grant applies the hub\'s delta before the callback: another origin\'s last write is what state.reload() reads', async () => {
  const site = new FakeHubSite();
  const a = await tab(site);
  const b = await tab(site);
  const la = ghostLock(a.hub, 'x');
  await la.acquire();
  const sa = new StateStore('x', { storage: a.hub.local });
  sa.data.shell = 'winter';
  sa.saveNow();
  const sb = new StateStore('x', { storage: b.hub.local });
  sb.readOnly = true;
  const lb = ghostLock(b.hub, 'x');
  const got = lb.acquire({ wait: true }).then(ok => { sb.reload(); return [ok, sb.data.shell]; });
  await settle();
  la.release();
  assert.deepEqual(await got, [true, 'winter']);
});

test('hub.Channel: a GhostLock takeover crosses origins; a set message arrives after its delta (the stored set read in onmessage is the new one)', async () => {
  const site = new FakeHubSite();
  const a = await tab(site);
  const b = await tab(site);
  const la = ghostLock(a.hub, 'x');
  await la.acquire();
  const asked = [];
  la.on('takeover-request', () => asked.push('a'));
  const lb = ghostLock(b.hub, 'x');
  lb.requestTakeover();
  await settle();
  assert.deepEqual(asked, ['a']);
  const ca = new a.hub.Channel('sumika/runtime');
  const cb = new b.hub.Channel('sumika/runtime');
  const seen = [];
  cb.onmessage = ev => seen.push([ev.data.t, runtimePrefs.get(b.hub.local).ghosts]);
  runtimePrefs.set({ ghosts: ['x', 'y'], rev: 4 }, a.hub.local);
  ca.postMessage({ t: 'set', ghosts: ['x', 'y'], rev: 4 });
  await settle();
  assert.deepEqual(seen, [['set', ['x', 'y']]]);
  assert.throws(() => ca.postMessage({ f() {} }), e => e.name === 'DataCloneError', 'not cloneable, as a BroadcastChannel');
  ca.close();
  assert.throws(() => ca.postMessage({}), /closed/);
  assert.throws(() => new a.hub.Channel('other'), TypeError);
  cb.close();
});

test('StateStore\'s will: posted after a write once per tenure, only while the ghost\'s lock is held here; the hub stamps savedAt before the lock goes', async () => {
  const site = new FakeHubSite();
  const a = await tab(site);
  platform.install(a.hub);
  const st = new StateStore('x');           // the Runtime's case: no storage given, the platform's will
  assert.equal(st.storage, a.hub.local);
  st.saveNow();
  await settle();
  assert.equal(site.log.filter(m => m.op === 'will').length, 0, 'not held: no will');
  const lock = new GhostLock('x');          // the platform's locks
  await lock.acquire();
  st.saveNow();
  st.saveNow();
  await settle();
  const wills = site.log.filter(m => m.op === 'will');
  assert.deepEqual(wills.map(m => [m.name, m.key, m.stamp]), [['sumika:x', stateKey('x'), 'savedAt']], 'once per tenure');
  const before = JSON.parse(site.local.getItem(stateKey('x'))).savedAt;
  site.now = before + 3600000;
  lock.release();
  await settle();
  assert.equal(JSON.parse(site.local.getItem(stateKey('x'))).savedAt, before + 3600000, 'stamped at the release');
  await lock.acquire();
  st.saveNow();
  await settle();
  assert.equal(site.log.filter(m => m.op === 'will').length, 2, 'a new tenure: posted again');
  const ro = new StateStore('x');
  ro.readOnly = true;
  ro.saveNow();
  const newer = new StateStore('x');
  newer.newer = true;
  newer.saveNow();
  await settle();
  assert.equal(site.log.filter(m => m.op === 'will').length, 2, 'never read-only or newer');
  lock.release();
});

test('the hub\'s pagehide commits the wills, then lets every lock go: the next tab is granted the ghost with savedAt stamped', async () => {
  const site = new FakeHubSite();
  const a = await tab(site);
  platform.install(a.hub);
  const lock = new GhostLock('x');
  await lock.acquire();
  const st = new StateStore('x');
  st.saveNow();
  await settle();
  platform.clear();
  const b = await tab(site);
  const lb = ghostLock(b.hub, 'x');
  const wait = lb.acquire({ wait: true });
  await settle();
  site.now = 9e12;
  a.doc.pagehide(false);      // the tab closed: its last posts were lost, the hub's own pagehide runs
  assert.equal(await wait, true);
  assert.equal(JSON.parse(b.hub.local.getItem(stateKey('x'))).savedAt, 9e12, 'the grant\'s delta carries the stamp');
});

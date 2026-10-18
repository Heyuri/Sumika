// The storage hub, page side (core/hub.js; CONTRACTS "Hub protocol"): hubAddress (what a script tag's data-hub
// asks for), the handshake against a fake hub written from the protocol (planting, hello, ack, welcome or refusal),
// what counts as usable, the fallback to the page's own storage (exactly a hub-less page's path: platform cleared,
// writes made while pending replayed there, one log line at the right level), the ack timer's extra task, a hello per
// document the frame loads, and the messages a page accepts from a hub (only `sumika:` / `sumika.` keys, caps checked).
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HubClient, hubAddress, HUB_ACK_MS, HUB_WAIT_MS } from '../../src/core/hub.js';
import { platform, localStore, tabSession, lockManager, channelClass } from '../../src/core/platform.js';
import { StateStore, memoryStorage, runtimePrefs, stateKey } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { STORE_OP_MS } from '../../src/core/portstore.js';
import { FakeClock, settle } from './fakes.mjs';
import { FakeHubSite, fakePage, hubOpts, HUB_URL, HUB_ORIGIN } from './hub_fakes.mjs';

let logs;
const realConsole = { warn: console.warn, info: console.info, debug: console.debug };
beforeEach(() => {
  logs = [];
  console.warn = (...a) => logs.push(['warn', a.map(String).join(' ')]);
  console.info = (...a) => logs.push(['info', a.map(String).join(' ')]);
  console.debug = (...a) => logs.push(['debug', a.map(String).join(' ')]);
  setLogLevel('debug');
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
});
afterEach(() => {
  Object.assign(console, realConsole);
  setLogLevel('warn');
  platform.clear();
});

/** a HubClient over a fake page and hub, installed as the page's */
function client(site = new FakeHubSite(), o = {}) {
  const clock = new FakeClock();
  const page = fakePage(site, o);
  const hub = new HubClient(HUB_URL, hubOpts(page, clock, o.hub || {}));
  platform.install(hub);
  return { hub, page, site, clock };
}

const warns = () => logs.filter(l => l[0] === 'warn').map(l => l[1]);

// ---------------------------------------------------------------- hubAddress

test('hubAddress: absent → null; bare → hub.html next to sumika.js; a URL keeps its query and gains ?sumika-hub=1; anything else → null with one warn; the page\'s own origin → null', () => {
  const loc = { origin: 'https://a.example.com' };
  const rt = 'https://sumika.example.com/sumika/sumika.js';
  assert.equal(hubAddress({}, rt, loc), null);
  assert.equal(hubAddress(null, rt, loc), null);
  assert.equal(hubAddress({ hub: '' }, rt, loc), 'https://sumika.example.com/sumika/hub.html?sumika-hub=1');
  assert.equal(hubAddress({ hub: '  ' }, `${rt}?v=3`, loc), 'https://sumika.example.com/sumika/hub.html?sumika-hub=1', 'sumika.js\'s own query is not the hub\'s');
  assert.equal(hubAddress({ hub: 'https://h.example.com/x/hub.html?site=1#f' }, rt, loc), 'https://h.example.com/x/hub.html?site=1&sumika-hub=1');
  assert.equal(hubAddress({ hub: 'HTTP://h.example.com/hub.html' }, rt, loc), 'http://h.example.com/hub.html?sumika-hub=1');
  assert.deepEqual(warns(), []);
  for (const bad of ['hub.html', '/sumika/hub.html', '//h.example.com/hub.html', 'javascript:alert(1)', 'data:text/html,x', 'ftp://h/hub.html', 'https://']) {
    logs = [];
    assert.equal(hubAddress({ hub: bad }, rt, loc), null, bad);
    assert.equal(warns().length, 1, bad);
    assert.match(warns()[0], /data-hub must be empty or an absolute http\(s\) URL of a hub page/);
  }
  logs = [];
  assert.equal(hubAddress({ hub: '' }, 'https://a.example.com/sumika/sumika.js', loc), null, 'the hub on the page\'s own origin: its storage is the page\'s');
  assert.equal(hubAddress({ hub: 'https://a.example.com/other/hub.html' }, rt, loc), null);
  assert.deepEqual(warns(), [], 'logged at debug only');
  assert.ok(logs.some(l => l[0] === 'debug' && /own origin/.test(l[1])));
});

// ---------------------------------------------------------------- live

test('a hub that welcomes the page: live; the mirrors hold its snapshot (only sumika: / sumika. keys), the caps, and every default reads the hub', async () => {
  const site = new FakeHubSite();
  site.local.setItem('sumika:runtime', '{"lang":"ja"}');
  site.local.setItem('other:key', 'not ours');
  const { hub, page, clock } = client(site, { hubSession: (() => { const s = site.tab(); s.setItem('sumika.session', '{"x":1}'); s.setItem('foreign', '1'); return s; })() });
  assert.equal(hub.state, 'pending');
  assert.equal(page.frames.length, 0, 'nothing planted before ready()');
  assert.equal(localStore(), hub.local, 'pending: the empty view');
  assert.equal(hub.local.getItem('sumika:runtime'), null);
  assert.equal(lockManager(), null, 'no locks while pending');
  assert.equal(channelClass(), null, 'no channels while pending');
  const p = hub.ready();
  assert.equal(hub.ready(), p, 'the same promise');
  assert.equal(await p, 'live');
  assert.equal(page.frames.length, 1, 'planted once');
  const f = page.frames[0];
  assert.equal(f.src, HUB_URL);
  assert.equal(f.hidden, true);
  assert.deepEqual(f.style.props.display, ['none', 'important']);
  assert.equal(f.tabIndex, -1);
  assert.equal(f.attrs['aria-hidden'], 'true');
  assert.equal(hub.state, 'live');
  assert.equal(hub.local.getItem('sumika:runtime'), '{"lang":"ja"}');
  assert.equal(hub.local.getItem('other:key'), null);
  assert.equal(hub.local.length, 1);
  assert.equal(hub.session.get('sumika.session'), '{"x":1}');
  assert.equal(hub.session.get('foreign'), null);
  assert.deepEqual(hub.caps, { locks: true, channels: true, store: 'indexeddb', estimate: true });
  assert.equal(runtimePrefs.get().lang, 'ja', 'the prefs come from the hub');
  assert.equal(tabSession.get('sumika.session'), '{"x":1}');
  assert.ok(lockManager() && typeof lockManager().request === 'function');
  assert.equal(typeof channelClass(), 'function');
  assert.equal(globalThis.localStorage.length, 0, 'nothing on the page\'s own origin');
  await clock.advance(HUB_WAIT_MS * 2);
  assert.equal(hub.state, 'live', 'no timer left to fall back');
  assert.deepEqual(warns(), []);
});

test('writes while pending: an empty view, kept in order and posted to the hub on welcome, over its snapshot', async () => {
  const site = new FakeHubSite();
  site.local.setItem('sumika:a', 'hub');
  site.local.setItem('sumika:b', 'hub');
  const { hub } = client(site);
  hub.local.setItem('sumika:a', 'page');
  hub.local.removeItem('sumika:b');
  hub.session.set('sumika.x', '1');
  assert.equal(hub.local.getItem('sumika:a'), 'page');
  assert.equal(await hub.ready(), 'live');
  assert.equal(hub.local.getItem('sumika:a'), 'page', 'the page\'s write over the snapshot');
  assert.equal(hub.local.getItem('sumika:b'), null);
  await settle();
  assert.equal(site.local.getItem('sumika:a'), 'page');
  assert.equal(site.local.getItem('sumika:b'), null);
  assert.deepEqual(site.log.map(m => m.op), ['ls.set', 'ls.remove', 'ss.set']);
});

// ---------------------------------------------------------------- fallback

test('each refusal: fallback to the page\'s own storage (platform cleared, the frame removed, writes made while pending replayed there), logged once at its level', async () => {
  const levels = { origin: 'warn', allowlist: 'warn', version: 'warn', busy: 'warn', site: 'info', storage: 'info' };
  for (const [reason, level] of Object.entries(levels)) {
    logs = [];
    globalThis.localStorage = memoryStorage();
    globalThis.sessionStorage = memoryStorage();
    const site = new FakeHubSite();
    site.refuse = reason;
    const { hub, page } = client(site);
    hub.local.setItem('sumika:pending', 'w');
    hub.session.set('sumika.pending', 's');
    assert.equal(await hub.ready(), 'fallback', reason);
    assert.equal(hub.state, 'fallback');
    assert.equal(hub.reason, reason);
    assert.equal(platform.hub, null, `${reason}: the browser's own globals again`);
    assert.equal(page.frames[0].isConnected, false, 'the frame is removed');
    assert.equal(globalThis.localStorage.getItem('sumika:pending'), 'w', 'replayed on the page\'s own origin');
    assert.equal(globalThis.sessionStorage.getItem('sumika.pending'), 's');
    const st = new StateStore('g');
    st.saveNow();
    assert.ok(globalThis.localStorage.getItem(stateKey('g')), `${reason}: a StateStore writes globalThis.localStorage`);
    const mine = logs.filter(l => /storage hub/.test(l[1]));
    assert.equal(mine.length, 1, `${reason}: one line`);
    assert.equal(mine[0][0], level, reason);
    if (reason === 'allowlist') assert.match(mine[0][1], /hub\.json is missing or unreadable/);
    else if (reason === 'version') assert.match(mine[0][1], /speaks protocol 1, this page 1/);
    else assert.match(mine[0][1], new RegExp(`${HUB_ORIGIN.replace(/\./g, '\\.')} is not usable \\(${reason}\\)`));
    // a stale reference to the client after the fallback reads and writes the page's own storage
    hub.local.setItem('sumika:late', '1');
    assert.equal(globalThis.localStorage.getItem('sumika:late'), '1');
    assert.equal(hub.session.get('sumika.pending'), 's');
    platform.clear();
  }
});

test('a hub without IndexedDB (store \'memory\') is still used: the page\'s own worker would keep its save files in memory too; a welcome of another protocol falls back (\'version\')', async () => {
  const site = new FakeHubSite();
  site.caps = { ...site.caps, store: 'memory' };
  const a = client(site);
  assert.equal(await a.hub.ready(), 'live');
  assert.equal(a.hub.caps.store, 'memory');
  const st = await a.hub.openStore('sumika');
  assert.equal(st.kind, 'memory');
  assert.equal(await st.set('k', 1), false, 'the hub\'s memory: no storage, as Store\'s memory kind');
  assert.equal(await st.read('k'), 1, 'but kept in the hub document for this page\'s other users');
  platform.clear();
  const b = client(new FakeHubSite());
  const real = b.hub._welcome.bind(b.hub);
  b.hub._welcome = m => real({ ...m, v: 2 });
  assert.equal(await b.hub.ready(), 'fallback');
  assert.equal(b.hub.reason, 'version');
  assert.ok(warns().some(w => /speaks protocol 2, this page 1/.test(w)));
});

test('no ack within HUB_ACK_MS of the frame\'s load: one more task, then the fallback \'timeout\' with the hint; a late welcome is ignored', async () => {
  const site = new FakeHubSite();
  site.noAck = true;
  let open;
  site.holdWelcome = new Promise(r => { open = r; });
  const { hub, page, clock } = client(site);
  const p = hub.ready();
  await settle();
  assert.equal(page.frames.length, 1);
  await clock.advance(HUB_ACK_MS - 1);
  assert.equal(hub.state, 'pending');
  await clock.advance(1);
  assert.equal(hub.state, 'fallback', 'the extra task ran too (FakeClock: 0 ms)');
  assert.equal(await p, 'fallback');
  assert.equal(hub.reason, 'timeout');
  assert.match(warns().join('\n'), /not usable \(timeout\).*frame-src/);
  open();
  await settle();
  assert.equal(hub.state, 'fallback', 'a welcome after the decision changes nothing');
  assert.equal(page.frames[0].isConnected, false);
});

test('the ack timer and a late ack: an ack that arrives in the task after the timer\'s still counts', async () => {
  const site = new FakeHubSite();
  site.noAck = true;
  let open;
  site.holdWelcome = new Promise(r => { open = r; });
  const { hub, page, clock } = client(site);
  hub.ready();
  await settle();
  // the timer runs out while the hub's ack waits behind it in the queue: it lands before the extra task
  const real = clock.setTimeout.bind(clock);
  clock.setTimeout = (fn, ms) => real(ms === 0 ? () => { page.hubDocs[0].post({ t: 'ack' }); queueMicrotask(fn); } : fn, ms);
  await clock.advance(HUB_ACK_MS);
  clock.setTimeout = real;
  assert.equal(hub.state, 'pending', 'not a fallback');
  open();
  assert.equal(await hub.ready(), 'live');
});

test('no welcome within HUB_WAIT_MS of planting (acked, hub.json slow): fallback \'timeout\'; a dead host whose frame never loads: the same', async () => {
  const site = new FakeHubSite();
  site.holdWelcome = new Promise(() => {});
  const a = client(site);
  a.hub.ready();
  await a.clock.advance(HUB_WAIT_MS - 1);
  assert.equal(a.hub.state, 'pending', 'acked: the ack timer is off');
  await a.clock.advance(1);
  assert.equal(a.hub.state, 'fallback');
  assert.equal(a.hub.reason, 'timeout');
  platform.clear();
  const b = client(new FakeHubSite(), { loads: [] });
  b.hub.ready();
  await b.clock.advance(HUB_WAIT_MS);
  assert.equal(b.hub.state, 'fallback');
  assert.equal(b.hub.reason, 'timeout');
});

test('an error page first (Chromium fires load for it), then the hub: a hello per load until one is acked; the first page\'s port is let go', async () => {
  const site = new FakeHubSite();
  const { hub, page, clock } = client(site, { loads: ['error', 'hub'] });
  assert.equal(await hub.ready(), 'live');
  assert.equal(page.hubDocs.length, 1);
  assert.equal(page.hubDocs[0].hellos, 1);
  await clock.advance(HUB_WAIT_MS);
  assert.equal(hub.state, 'live');
});

test('no MessageChannel or no document: fallback \'unsupported\' at once, nothing planted', async () => {
  const site = new FakeHubSite();
  const page = fakePage(site);
  const hub = new HubClient(HUB_URL, { ...hubOpts(page, new FakeClock()), MessageChannel: null });
  platform.install(hub);
  assert.equal(await hub.ready(), 'fallback');
  assert.equal(hub.reason, 'unsupported');
  assert.equal(page.frames.length, 0);
  assert.equal(platform.hub, null);
});

// ---------------------------------------------------------------- what a page accepts from a hub

test('messages from the hub are checked: other ports, non-objects, unknown kinds and foreign keys in a snapshot or delta are dropped', async () => {
  const site = new FakeHubSite();
  const { hub } = client(site);
  await hub.ready();
  const fire = [];
  hub.events.addEventListener('storage', ev => fire.push([ev.key, ev.oldValue, ev.newValue]));
  hub._onPortMessage({}, { t: 'storage', snap: { 'sumika:x': 'from another port' } });
  hub._onPortMessage(hub._port, null);
  hub._onPortMessage(hub._port, 'text');
  hub._onPortMessage(hub._port, { t: 'nonsense' });
  hub._onPortMessage(hub._port, { t: 'storage', snap: { 'sumika:a': '1', 'other': '2', 'sumika:b': 3, 'sumika:c': { o: 1 } } });
  hub._onPortMessage(hub._port, { t: 'storage', snap: ['sumika:z'] });
  assert.deepEqual(fire, [['sumika:a', null, '1']]);
  assert.equal(hub.local.getItem('sumika:x'), null);
  assert.equal(hub.local.length, 1);
  hub._onPortMessage(hub._port, { t: 'welcome', v: 1, local: { 'sumika:a': 'again' }, caps: {} });
  assert.equal(hub.local.getItem('sumika:a'), '1', 'a second welcome is ignored');
});

test('a delta the hub counts as told is applied even when nothing waits for its message: a channel this page closed while the delivery was on its way, a reply that came after its request timed out', async () => {
  const { hub, page, clock } = client();
  await hub.ready();
  const ch = new hub.Channel('sumika:x');
  const heard = [];
  ch.onmessage = ev => heard.push(ev.data);
  const cid = ch._cid;
  ch.close();
  hub._onPortMessage(hub._port, { t: 'bc', cid, data: { t: 'takeover' }, snap: { 'sumika:runtime': '{"ghosts":["x","y"]}' }, seq: 0 });
  assert.equal(hub.local.getItem('sumika:runtime'), '{"ghosts":["x","y"]}');
  assert.deepEqual(heard, [], 'not delivered to the closed channel');
  const doc = page.hubDocs[0];
  const op = doc.op.bind(doc);
  doc.op = m => { if (m.op !== 'sync') op(m); };      // a hub too busy to answer in time
  const late = assert.rejects(hub.sync(), /did not answer sync/);
  const rid = hub._rid;
  await settle();
  await clock.advance(STORE_OP_MS);
  await late;
  hub._onPortMessage(hub._port, { t: 'reply', rid, ok: true, value: { snap: { 'sumika:late': 'v' }, session: {}, seq: 0 } });
  assert.equal(hub.local.getItem('sumika:late'), 'v');
});

test('the hub going away: its `gone` (not persisted) or the frame removed from the page (devtools, a host page\'s script) → gone once, onGone called; a persisted `gone` (both in the back/forward cache) changes nothing', async () => {
  for (const how of ['pagehide', 'removed']) {
    const { hub, page } = client();
    await hub.ready();
    const gone = [];
    hub.onGone(() => gone.push(how));
    page.hubDocs[0].pagehide(true);
    await settle();
    assert.equal(hub.state, 'live', 'persisted: ignored');
    if (how === 'pagehide') page.hubDocs[0].pagehide(false);
    else page.frames[0].remove();
    await settle();
    assert.equal(hub.state, 'gone', how);
    assert.deepEqual(gone, [how]);
    hub.local.setItem('sumika:after', '1');
    assert.equal(hub.local.getItem('sumika:after'), '1', 'this page still reads its own writes');
    await settle();
    assert.equal(page.site.local.getItem('sumika:after'), null, 'nothing reaches a hub that is gone');
    platform.clear();
  }
});

test('close() (main.js: the visitor\'s Off read through the hub): live -> gone, the frame removed, no onGone listener told, nothing posted after; a fallback\'s close removes nothing more', async () => {
  const { hub, page, site } = client();
  site.local.setItem('sumika:choice', '{"choice":"off","v":1}');
  await hub.ready();
  assert.equal(hub.local.getItem('sumika:choice'), '{"choice":"off","v":1}', 'the choice is in the welcome\'s snapshot');
  const gone = [];
  hub.onGone(() => gone.push('told'));
  const before = site.log.length;
  hub.close();
  await settle();
  assert.equal(hub.state, 'gone');
  assert.deepEqual([page.frames.length, page.removed.length, page.observers.length], [1, 1, 0], 'removed, its watch let go');
  assert.deepEqual(gone, [], 'no listener told: nothing of Sumika ran on it');
  hub.local.setItem('sumika:after', '1');
  await settle();
  assert.equal(site.log.length, before, 'nothing posted');
  assert.equal(site.local.getItem('sumika:after'), null);
  platform.clear();

  const refused = client(Object.assign(new FakeHubSite(), { refuse: 'allowlist' }));
  assert.equal(await refused.hub.ready(), 'fallback');
  assert.equal(refused.page.removed.length, 1, 'the fallback removed its frame');
  refused.hub.close();
  assert.deepEqual([refused.hub.state, refused.page.removed.length], ['fallback', 1]);
});

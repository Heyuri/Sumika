// The storage hub's mirrors (core/hub.js MirrorStorage, SessionMirror): a synchronous Storage
// look-alike over the hub's `sumika:` localStorage (reads from the snapshot, writes posted in order, foreign keys
// refused), the quota estimate that throws QuotaExceededError so StateStore's slim retry runs as over a full
// localStorage, a write the hub could not store logged once, other tabs' writes arriving as deltas (one storage event
// per changed key, none for the page's own writes) that UiLanguage and UserProfile follow, and the session mirror with
// confirm (true only once the hub holds the value). The back/forward cache: from the window's pagehide with persisted
// to its pageshow the client posts no write (the mirrors take them, pageshow takes them back, the sync brings the other
// pages' writes); a pagehide not persisted, a pending client's queue and a fallback page as usual.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HubClient, QUOTA_UNITS } from '../../src/core/hub.js';
import { platform, tabSession } from '../../src/core/platform.js';
import { StateStore, memoryStorage, stateKey, RUNTIME_KEY } from '../../src/core/state.js';
import { UiLanguage } from '../../src/core/language.js';
import { UserProfile } from '../../src/core/user.js';
import { FakeClock, settle } from './fakes.mjs';
import { FakeHubSite, fakePage, hubOpts, HUB_URL } from './hub_fakes.mjs';
import { fakeTarget } from './multi_world.mjs';

let warned;
const realWarn = console.warn;
beforeEach(() => {
  warned = [];
  console.warn = (...a) => warned.push(a.map(String).join(' '));
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
});
afterEach(() => { console.warn = realWarn; platform.clear(); });

/** a live HubClient over a fake hub site (a tab on some origin); o.win: the page's window it listens to */
async function live(site = new FakeHubSite(), o = {}) {
  const clock = new FakeClock();
  const page = fakePage(site, o);
  const hub = new HubClient(HUB_URL, hubOpts(page, clock, o.win ? { window: o.win } : {}));
  platform.install(hub);
  assert.equal(await hub.ready(), 'live');
  return { hub, page, site, clock, doc: page.hubDocs[0] };
}

test('MirrorStorage: reads the snapshot, posts writes in order, refuses keys outside sumika:, key() and length over its keys', async () => {
  const site = new FakeHubSite();
  site.local.setItem('sumika:a', '1');
  const { hub } = await live(site);
  const m = hub.local;
  assert.equal(m.getItem('sumika:a'), '1');
  m.setItem('sumika:b', 2);
  m.setItem('sumika:a', 'x');
  m.removeItem('sumika:b');
  m.setItem('sumika:c', '3');
  assert.throws(() => m.setItem('other', '1'), TypeError);
  assert.equal(m.getItem('other'), null);
  m.removeItem('other');
  assert.deepEqual([m.length, m.key(0), m.key(1), m.key(2)], [2, 'sumika:a', 'sumika:c', null]);
  await settle();
  assert.deepEqual(site.log.map(x => [x.op, x.key, x.value]), [
    ['ls.set', 'sumika:b', '2'], ['ls.set', 'sumika:a', 'x'], ['ls.remove', 'sumika:b', undefined], ['ls.set', 'sumika:c', '3'],
  ]);
  assert.deepEqual([site.local.getItem('sumika:a'), site.local.getItem('sumika:b'), site.local.getItem('sumika:c')], ['x', null, '3']);
  assert.equal(globalThis.localStorage.length, 0);
});

test('the quota estimate: a write past QUOTA_UNITS (the hub\'s other keys counted) throws QuotaExceededError at once; StateStore then stores its slim copy as over a full localStorage', async () => {
  const site = new FakeHubSite();
  site.otherUnits = QUOTA_UNITS - 2000;
  const { hub } = await live(site);
  assert.throws(() => hub.local.setItem('sumika:big', 'x'.repeat(3000)), e => e.name === 'QuotaExceededError');
  assert.equal(hub.local.getItem('sumika:big'), null, 'nothing kept');
  hub.local.setItem('sumika:small', 'x'.repeat(100));
  const st = new StateStore('g', { storage: hub.local });
  st.data.run = { src: 'y'.repeat(4000), pos: 1 };
  st.data.balloons = { big: 'z'.repeat(100) };
  assert.equal(st.saveNow(), true, 'the slim copy fits');
  const stored = JSON.parse(hub.local.getItem(stateKey('g')));
  assert.equal(stored.run, null);
  assert.equal(stored.balloons, null);
  assert.ok(warned.some(w => /storage is nearly full/.test(w)));
  // a write that shrinks a key is never refused, even over the estimate
  hub.local._units = QUOTA_UNITS + 10;
  hub.local.setItem('sumika:small', 'x');
  assert.equal(hub.local.getItem('sumika:small'), 'x');
});

test('a write the hub could not store (its quota, other data): logged once per key; the mirror keeps the value for this page; flush reports it', async () => {
  const site = new FakeHubSite();
  site.failKeys.add('sumika:full');
  const { hub } = await live(site);
  hub.local.setItem('sumika:full', '1');
  hub.local.setItem('sumika:full', '2');
  await settle();
  assert.equal(hub.local.getItem('sumika:full'), '2');
  assert.equal(site.local.getItem('sumika:full'), null);
  assert.equal(warned.filter(w => /did not store sumika:full/.test(w)).length, 1);
  const r = await hub.flush();
  assert.deepEqual(r.failed, ['sumika:full', 'sumika:full']);
  assert.equal(warned.filter(w => /did not store sumika:full/.test(w)).length, 1, 'still once');
});

test('another tab\'s writes: the delta updates the mirror and fires one storage event per changed key; the page\'s own writes fire none', async () => {
  const site = new FakeHubSite();
  const a = await live(site);
  const b = await live(site);     // a second tab of another origin on the same hub site
  const seen = [];
  a.hub.events.addEventListener('storage', ev => seen.push([ev.key, ev.oldValue, ev.newValue]));
  a.hub.local.setItem('sumika:mine', '1');
  await settle();
  assert.deepEqual(seen, [], 'own write');
  b.hub.local.setItem('sumika:x', 'b1');
  b.hub.local.setItem('sumika:mine', '2');
  b.hub.local.removeItem('sumika:mine');
  await settle();
  assert.equal(a.hub.local.getItem('sumika:x'), 'b1');
  assert.equal(a.hub.local.getItem('sumika:mine'), null);
  assert.deepEqual(seen, [['sumika:x', null, 'b1'], ['sumika:mine', '1', '2'], ['sumika:mine', '2', null]]);
  await a.hub.sync();
  assert.equal(seen.length, 3, 'a sync with nothing new fires nothing');
});

test('UiLanguage and UserProfile bound to a page with the hub follow another tab\'s Language ▸ pick and Preferences box (storageSource)', async () => {
  const site = new FakeHubSite();
  const a = await live(site);
  const b = await live(site);
  platform.install(a.hub);        // this page is a's
  const win = fakeTarget();
  const lang = new UiLanguage({ navigator: { languages: ['en-US'] } });
  const user = new UserProfile();
  lang.bindWindow(win);
  user.bindWindow(win);
  assert.equal(win.count('storage'), 0, 'the window\'s storage event is not the hub\'s');
  assert.equal(win.count('languagechange'), 1, 'the browser\'s languages still from the window');
  const changes = [];
  lang.on('change', e => changes.push(['lang', e.lang]));
  user.on('change', e => changes.push(['user', e.data.name]));
  // b writes the prefs as another tab would (its own mirror)
  b.hub.local.setItem(RUNTIME_KEY, JSON.stringify({ lang: 'ja', user: { name: 'Hana' }, v: 1 }));
  await settle();
  assert.deepEqual(changes, [['lang', 'ja'], ['user', 'Hana']]);
  lang.dispose();
  user.dispose();
  b.hub.local.setItem(RUNTIME_KEY, JSON.stringify({ lang: 'en', v: 1 }));
  await settle();
  assert.equal(changes.length, 2, 'unbound from the hub\'s events');
});

test('the session mirror: get/set/remove over the hub\'s sumika. keys only; confirm true only when the hub holds the value', async () => {
  const site = new FakeHubSite();
  const { hub, doc } = await live(site);
  tabSession.set('sumika.reloadedFrom', 'abc');
  tabSession.set('foreign', '1');
  assert.equal(tabSession.get('sumika.reloadedFrom'), 'abc');
  assert.equal(tabSession.get('foreign'), null);
  assert.equal(await tabSession.confirm('sumika.reloadedFrom', 'abc'), true);
  assert.equal(doc.session.getItem('sumika.reloadedFrom'), 'abc');
  assert.equal(await tabSession.confirm('sumika.reloadedFrom', 'other'), false);
  site.failKeys.add('sumika.blocked');
  tabSession.set('sumika.blocked', '1');
  assert.equal(tabSession.get('sumika.blocked'), '1', 'this page still reads it');
  assert.equal(await tabSession.confirm('sumika.blocked', '1'), false, 'the hub did not store it');
  tabSession.remove('sumika.reloadedFrom');
  assert.equal(await tabSession.confirm('sumika.reloadedFrom', 'abc'), false);
  assert.equal(globalThis.sessionStorage.length, 0, 'nothing on the page\'s own origin');
  // without the hub: the read-back
  platform.clear();
  tabSession.set('sumika.x', '1');
  assert.equal(await tabSession.confirm('sumika.x', '1'), true);
  assert.equal(globalThis.sessionStorage.getItem('sumika.x'), '1');
  assert.equal(hub.state, 'live');
});

test('confirm while pending waits for the decision (the pending write posted first); with the hub gone it is false', async () => {
  const site = new FakeHubSite();
  const clock = new FakeClock();
  const page = fakePage(site);
  const hub = new HubClient(HUB_URL, hubOpts(page, clock));
  platform.install(hub);
  hub.session.set('sumika.k', 'v');
  const p = hub.session.confirm('sumika.k', 'v');
  assert.equal(await p, true, 'planted, welcomed, the pending write posted, then flushed');
  page.hubDocs[0].pagehide(false);
  await settle();
  assert.equal(hub.state, 'gone');
  assert.equal(await hub.session.confirm('sumika.k', 'v'), false);
});

test('sync (a page back from the back/forward cache): the session mirror becomes this tab\'s session keys at the hub, which another page of the tab changed meanwhile; a key this page writes while the sync is on its way stays its own', async () => {
  const site = new FakeHubSite();
  const hubSession = site.tab();
  const a = await live(site, { hubSession });
  a.hub.session.set('sumika.session', 'A');
  a.hub.session.set('sumika.reloadedFrom', 'r');
  await a.hub.flush();
  // a link: another page of the same tab (another origin) changes the tab's keys
  const b = await live(site, { hubSession });
  assert.equal(b.hub.session.get('sumika.session'), 'A');
  b.hub.session.set('sumika.session', 'B');
  b.hub.session.remove('sumika.reloadedFrom');
  b.hub.session.set('sumika.hostRewrites', '1');
  await b.hub.flush();
  // Back to a: its mirror is what it was
  assert.equal(a.hub.session.get('sumika.session'), 'A');
  const p = a.hub.sync();
  a.hub.session.set('sumika.lastInputMs', '42');        // written while the sync is on its way
  await p;
  assert.equal(a.hub.session.get('sumika.session'), 'B');
  assert.equal(a.hub.session.get('sumika.reloadedFrom'), null);
  assert.equal(a.hub.session.get('sumika.hostRewrites'), '1');
  assert.equal(a.hub.session.get('sumika.lastInputMs'), '42', 'this page\'s own later write is not taken back');
  await settle();
  assert.equal(hubSession.getItem('sumika.lastInputMs'), '42');
  // an older hub answers the delta only: the session mirror stays
  a.hub.session.set('sumika.session', 'A2');
  a.page.hubDocs[0].sessionMap = () => undefined;
  await a.hub.sync();
  assert.equal(a.hub.session.get('sumika.session'), 'A2');
});

test('a page\'s own write crossing another tab\'s delta for the same key: the hub\'s echo shows it had not handled the write yet, so the entry is skipped and mirror and hub both end with the page\'s write; an older hub (no echo) is applied as before', async () => {
  const site = new FakeHubSite();
  site.local.setItem('sumika:runtime', 'b1');
  const a = await live(site);
  const seen = [];
  a.hub.events.addEventListener('storage', ev => seen.push(ev.newValue));
  a.hub.local.setItem('sumika:runtime', 'b2');          // posted, on its way
  site.local.setItem('sumika:runtime', 'other tab');     // another tab's write, whose storage event reaches a's hub first
  a.doc.storageEvent();
  await settle();
  assert.equal(site.local.getItem('sumika:runtime'), 'b2', 'the page\'s write landed last at the hub');
  assert.equal(a.hub.local.getItem('sumika:runtime'), 'b2', 'and the mirror agrees');
  assert.deepEqual(seen, [], 'no storage event for a skipped entry');
  site.local.setItem('sumika:runtime', 'c');             // a later write of the other tab still arrives
  a.doc.storageEvent();
  await settle();
  assert.equal(a.hub.local.getItem('sumika:runtime'), 'c');
  assert.deepEqual(seen, ['c']);
  a.hub.local.setItem('sumika:runtime', 'd');
  a.hub._onPortMessage(a.hub._port, { t: 'storage', snap: { 'sumika:runtime': 'from an older hub' } });
  assert.equal(a.hub.local.getItem('sumika:runtime'), 'from an older hub');
});

// ---------------------------------------------------------------- the back/forward cache

/** the page's window (fakeTarget), each listener's type and options recorded in order */
function pageWindow() {
  const win = fakeTarget();
  const add = win.addEventListener;
  win.added = [];
  win.addEventListener = (t, f, o) => { win.added.push([t, o]); add(t, f); };
  return win;
}

/** the writes in a fake hub site's log: page-port ls.* / ss.* / will, store-port set / delete */
const writesIn = log => log.filter(m => /^(ls|ss)\.|^will$/.test(m.op || '') || m.store === 'set' || m.store === 'delete');

test('a pagehide into the back/forward cache (persisted): until the pageshow no write is posted (ls.*, ss.*, a will, the page\'s PortStores\'); the mirrors read them meanwhile, the pageshow takes them back, the sync brings what another page wrote; the client listens first (made with it, capture)', async () => {
  const site = new FakeHubSite();
  site.local.setItem('sumika:k', 'v0');
  site.local.setItem('sumika:gone', 'g');
  const win = pageWindow();
  const a = await live(site, { win });
  assert.deepEqual(win.added, [['pagehide', { capture: true }], ['pageshow', { capture: true }]], 'its two listeners, made with the client');
  const hub = a.hub;
  hub.session.set('sumika.s', 's0');
  hub.session.set('sumika.r', 'r0');
  let release;
  const held = hub.locks.request('sumika:x', {}, () => new Promise(r => { release = r; }));
  const drops = await hub.openStore('sumika');
  await settle();
  site.log.length = 0;
  win.fire('pagehide', { persisted: true });
  assert.equal(hub.hidden, true);
  hub.local.setItem('sumika:k', 'v1');
  hub.local.setItem('sumika:k', 'v2');
  hub.local.setItem('sumika:new', 'n');
  hub.local.removeItem('sumika:gone');
  hub.session.set('sumika.s', 's1');
  hub.session.set('sumika.t', 't1');
  hub.session.remove('sumika.r');
  hub.will('sumika:x', 'sumika:k', 'savedAt');
  assert.equal(await drops.set('drop:a', 1), false, 'held: kept in its memory, not sent');
  assert.equal(await drops.delete('drop:b'), false);
  const later = await hub.openStore('sumika');
  assert.equal(await later.set('drop:c', 1), false, 'a PortStore made while hidden holds too');
  await settle();
  assert.deepEqual(writesIn(site.log), [], 'nothing written reached the hub');
  assert.equal(hub.local.getItem('sumika:k'), 'v2', 'the mirror reads the page\'s writes meanwhile');
  assert.equal(hub.local.getItem('sumika:gone'), null);
  assert.equal(hub.session.get('sumika.s'), 's1');
  assert.equal(hub.session.get('sumika.r'), null);
  assert.equal(site.local.getItem('sumika:k'), 'v0');
  // another page writes at the hub while this one sits in the cache (no storage event reaches it)
  site.local.setItem('sumika:k', 'other page');
  a.doc.session.setItem('sumika.s', 'other page');
  win.fire('pageshow', { persisted: true });
  assert.equal(hub.hidden, false);
  assert.deepEqual([hub.local.getItem('sumika:k'), hub.local.getItem('sumika:new'), hub.local.getItem('sumika:gone')], ['v0', null, 'g'],
    'taken back: what the hub had from this page');
  assert.deepEqual([hub.session.get('sumika.s'), hub.session.get('sumika.t'), hub.session.get('sumika.r')], ['s0', null, 'r0']);
  await hub.sync();
  assert.equal(hub.local.getItem('sumika:k'), 'other page', 'the sync brings the other page\'s write');
  assert.equal(hub.session.get('sumika.s'), 'other page');
  // posting goes on
  hub.local.setItem('sumika:after', '1');
  assert.equal(await drops.set('drop:d', 1), true);
  await settle();
  assert.equal(site.local.getItem('sumika:after'), '1');
  assert.deepEqual([...site.idb.keys()], ['drop:d'], 'what the PortStores held was never sent');
  release();
  await held;
});

test('the back/forward cache, other orders: a delta that reaches the hidden page replaces its held write (pageshow keeps it); a pagehide not persisted posts as usual; a pending client queues nothing for the welcome while hidden; a fallback page is as without the hub', async () => {
  // a delta while hidden (another tab's write relayed by the hub): the mirror is the hub's from then on
  {
    const site = new FakeHubSite();
    site.local.setItem('sumika:k', 'v0');
    const win = pageWindow();
    const a = await live(site, { win });
    win.fire('pagehide', { persisted: true });
    a.hub.local.setItem('sumika:k', 'mine');
    site.local.setItem('sumika:k', 'other');
    a.doc.storageEvent();
    await settle();
    assert.equal(a.hub.local.getItem('sumika:k'), 'other');
    win.fire('pageshow', { persisted: true });
    assert.equal(a.hub.local.getItem('sumika:k'), 'other', 'not taken back to what the hub no longer holds');
    await a.hub.sync();
    assert.deepEqual([a.hub.local.getItem('sumika:k'), site.local.getItem('sumika:k')], ['other', 'other']);
    platform.clear();
  }
  // not persisted: posted as usual (they never reach a hub that goes [measured, Chromium])
  {
    const site = new FakeHubSite();
    const win = pageWindow();
    const a = await live(site, { win });
    win.fire('pagehide', { persisted: false });
    assert.equal(a.hub.hidden, false);
    a.hub.local.setItem('sumika:k', 'v');
    a.hub.session.set('sumika.s', 'v');
    await settle();
    assert.deepEqual([site.local.getItem('sumika:k'), a.doc.session.getItem('sumika.s')], ['v', 'v']);
    platform.clear();
  }
  // pending at the pagehide: a write before it goes with the welcome, one while hidden never
  {
    const site = new FakeHubSite();
    let open;
    site.holdWelcome = new Promise(r => { open = r; });
    const win = pageWindow();
    const page = fakePage(site);
    const hub = new HubClient(HUB_URL, hubOpts(page, new FakeClock(), { window: win }));
    platform.install(hub);
    const ready = hub.ready();
    hub.local.setItem('sumika:before', '1');
    win.fire('pagehide', { persisted: true });
    hub.local.setItem('sumika:during', '1');
    hub.session.set('sumika.during', '1');
    win.fire('pageshow', { persisted: true });
    assert.equal(hub.local.getItem('sumika:during'), null, 'taken back');
    open();
    assert.equal(await ready, 'live');
    await settle();
    assert.equal(site.local.getItem('sumika:before'), '1');
    assert.equal(site.local.getItem('sumika:during'), null);
    assert.equal(page.hubDocs[0].session.getItem('sumika.during'), null);
    platform.clear();
  }
  // a fallback: the page's own storage, as without data-hub
  {
    const site = new FakeHubSite();
    site.refuse = 'origin';
    const win = pageWindow();
    const page = fakePage(site);
    const hub = new HubClient(HUB_URL, hubOpts(page, new FakeClock(), { window: win }));
    platform.install(hub);
    assert.equal(await hub.ready(), 'fallback');
    win.fire('pagehide', { persisted: true });
    assert.equal(hub.hidden, false);
    hub.local.setItem('sumika:k', 'own');
    win.fire('pageshow', { persisted: true });
    assert.equal(globalThis.localStorage.getItem('sumika:k'), 'own');
  }
});

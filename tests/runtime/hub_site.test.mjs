// The Site with the storage hub (core/site.js): its first start
// waits for the hub's decision (the index loading meanwhile), then reads the language and the user information again;
// the set runs on the hub's storage, locks and channels (nothing on the page's own origin); the leave-flush hooks exist
// only with a live hub (without one the window and document get exactly a hub-less page's listeners), a link click
// flushes what pagehide writes but releases nothing and turns write-through on until the page is shown again;
// staleCheck reloads only once the hub holds its guard; a hub that goes away stops the ghosts; a pagehide into the
// back/forward cache posts nothing but the releases and asks no engine for its files (not persisted, or without the
// hub: the usual pagehide); a page restored from the cache first takes a full delta; a dropped-file store closed at
// pagehide is opened again. navigatingClick: which clicks navigate this document.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HubClient } from '../../src/core/hub.js';
import { platform } from '../../src/core/platform.js';
import { Site, navigatingClick, LEAVE_DEDUPE_MS, LEAVE_THROUGH_MS, RELOADED_KEY } from '../../src/core/site.js';
import { GhostLock, memoryStorage, runtimePrefs, stateKey, sessionMarker } from '../../src/core/state.js';
import { UiLanguage } from '../../src/core/language.js';
import { UserProfile } from '../../src/core/user.js';
import { DropStore } from '../../src/core/drops.js';
import { LEAD_ID } from '../../src/core/ghostset.js';
import { FakeClock, settle } from './fakes.mjs';
import { world, TestRuntime, fakeTarget, eng, loopOf } from './multi_world.mjs';
import { FakeHubSite, fakePage, hubOpts, HUB_URL } from './hub_fakes.mjs';

let warned;
const realWarn = console.warn;
beforeEach(() => { warned = []; console.warn = (...a) => warned.push(a.map(String).join(' ')); });
afterEach(() => { console.warn = realWarn; platform.clear(); for (const s of SITES.splice(0)) s.done(); });

const SITES = [];

/** a slot whose locks and channels are the platform's (the hub's), as in a page */
class HubRuntime extends TestRuntime {
  _newLock(id) { return new GhostLock(id); }
}

/**
 * main.js's Site on a fake tab: its hooks installed by start() (as in a page), the platform's lead lock and channel;
 * `win`: the page's window (pageWindow(), the HubClient's too, as in main.js)
 */
class HubSite extends Site {
  constructor(w, { win = null, ...o } = {}) {
    super({
      base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', defaultGhost: 'x', lead: true,
      language: new UiLanguage({ navigator: { languages: ['en-US'] } }), user: new UserProfile(),
      createRuntime: opts => new HubRuntime(w, opts), ...o,
    });
    this.w = w;
    this.doc = fakeTarget({ hidden: false });
    this.win = win || pageWindow();
    this.win.top = this.win;
    this.index = w.index;
    this.hold = {};
    SITES.push(this);
  }
  _doc() { return this.doc; }
  _installPageHooks(win = this.win) { return super._installPageHooks(win); }
  _newLeadLock() { return new GhostLock(LEAD_ID); }
  done() {
    for (const rt of [...this.slots]) rt.done();
    if (this.lead) this.lead.dispose();
    if (this._channel) this._channel.close();
  }
}

/** a tab's window at https://a.example/page */
const pageWindow = () => fakeTarget({ location: { href: 'https://a.example/page' } });

/** a pending HubClient over a fake hub site, installed as the page's; o.win: the page's window it listens to */
function hubOf(site = new FakeHubSite(), o = {}) {
  const page = fakePage(site, o);
  const hub = new HubClient(HUB_URL, hubOpts(page, new FakeClock(), o.win ? { window: o.win } : {}));
  platform.install(hub);
  return { hub, page, site };
}

/** a link element and a click on it */
const link = (href, attrs = {}) => ({
  href, matches: s => s === 'a[href], area[href]', hasAttribute: n => n in attrs, getAttribute: n => (n in attrs ? attrs[n] : null),
});
const click = (el, o = {}) => ({ type: 'click', button: 0, defaultPrevented: false, target: el, composedPath: () => [el, { matches: () => false }], ...o });

test('start waits for the hub\'s decision, then reads the language and the user information again; the set runs on the hub (its storage, locks, session), nothing on the page\'s origin', async () => {
  const w = world();
  const hs = new FakeHubSite();
  hs.local.setItem('sumika:runtime', JSON.stringify({ lang: 'ja', user: { name: 'Hana' }, v: 1 }));
  const { page } = hubOf(hs);
  const site = new HubSite(w);
  assert.equal(site.language.pref, 'system', 'made while pending: the empty view');
  assert.equal(site.user.isSet(), false);
  const order = [];
  site.language.on('change', e => order.push(`lang ${e.pref}`));
  const out = site.start();
  assert.equal(page.frames.length, 1, 'planted at the first start');
  assert.equal(site.slots[0].parts, null, 'nothing started before the decision');
  assert.equal(await out, 'booted');
  assert.deepEqual(order, ['lang ja']);
  assert.equal(site.user.data.name, 'Hana');
  const prefs = JSON.parse(hs.local.getItem('sumika:runtime'));
  assert.deepEqual(prefs.ghosts, ['x'], 'the stored set is the hub\'s');
  assert.equal(prefs.lang, 'ja', 'the other prefs kept');
  site.slots[0].state.saveNow();
  await settle();
  assert.ok(hs.local.getItem(stateKey('x')), 'the ghost state at the hub');
  assert.ok(page.hubDocs[0].session.getItem('sumika.session'), 'the tab marker in the hub\'s sessionStorage');
  assert.ok(hs.locks.held.has('sumika/lead') && hs.locks.held.has('sumika:x'), 'the lead and the ghost lock are the hub\'s');
  assert.equal(globalThis.localStorage.length, 0, 'nothing in the page\'s own localStorage');
  assert.equal(globalThis.sessionStorage.length, 0);
  assert.deepEqual(w.locks.held, new Set(), 'never the page\'s locks');
});

test('a start waiting for the hub loads the site index meanwhile, once', async () => {
  const w = world();
  const hs = new FakeHubSite();
  let open;
  hs.holdWelcome = new Promise(r => { open = r; });
  hubOf(hs);
  const site = new HubSite(w);
  site.index = null;
  let loads = 0;
  site._fetchIndex = function () { loads++; return this._indexLoad || (this._indexLoad = Promise.resolve(w.index)); };
  const out = site.start();
  await settle();
  assert.equal(loads, 1, 'asked before the welcome');
  open();
  assert.equal(await out, 'booted');
  assert.equal(site.index, w.index);
});

test('storageReady (main.js, before it reads the visitor\'s choice through the hub): plants the hub once, {index: false} loads no index meanwhile; the decision taken in (language read again); a start after it plants nothing more and does not decide again; a fallback\'s too', async () => {
  for (const refuse of [null, 'allowlist']) {
    const w = world();
    const hs = new FakeHubSite();
    hs.refuse = refuse;
    hs.local.setItem('sumika:runtime', JSON.stringify({ lang: 'ja', v: 1 }));
    globalThis.localStorage.setItem('sumika:runtime', JSON.stringify({ lang: 'ja', v: 1 }));   // the fallback's own
    const { page } = hubOf(hs);
    const site = new HubSite(w);
    site.index = null;
    let loads = 0;
    site._fetchIndex = function () { loads++; return this._indexLoad || (this._indexLoad = Promise.resolve(w.index)); };
    assert.equal(site.language.pref, 'system', 'made while pending');
    const p = site.storageReady({ index: false });
    assert.equal(site.storageReady(), p, 'one wait for every caller');
    await p;
    assert.deepEqual([page.frames.length, loads], [1, 0], `${refuse}: planted, no index`);
    assert.equal(site.language.pref, 'ja', `${refuse}: the decided storage read`);
    assert.equal(await site.start(), 'booted', String(refuse));
    assert.deepEqual([page.frames.length, loads], [1, 1], 'the start loads the index then, plants nothing');
    platform.clear();
    globalThis.localStorage.removeItem('sumika:runtime');
  }
  // no hub: at once, nothing planted or loaded
  const plain = new HubSite(world());
  let loads = 0;
  plain.index = null;
  plain._fetchIndex = function () { loads++; return Promise.resolve(null); };
  await plain.storageReady();
  assert.equal(loads, 0);
});

test('the leave-flush hooks exist only with a live hub; without one the window and document get a hub-less page\'s listeners', async () => {
  const w = world();
  const plain = new HubSite(w);
  await plain.start();
  const today = ['pagehide', 'pageshow', 'storage', 'languagechange', 'click', 'submit', 'beforeunload'].map(t => [t, plain.win.count(t)]);
  assert.deepEqual(today, [['pagehide', 1], ['pageshow', 1], ['storage', 2], ['languagechange', 1], ['click', 0], ['submit', 0], ['beforeunload', 0]]);
  assert.equal(plain.doc.count('visibilitychange'), 1, 'the Site\'s');
  plain.done();
  SITES.length = 0;
  const w2 = world();
  hubOf();
  const site = new HubSite(w2);
  await site.start();
  const hub = ['pagehide', 'pageshow', 'storage', 'languagechange', 'click', 'submit', 'beforeunload'].map(t => [t, site.win.count(t)]);
  assert.deepEqual(hub, [['pagehide', 1], ['pageshow', 1], ['storage', 0], ['languagechange', 1], ['click', 1], ['submit', 1], ['beforeunload', 1]]);
});

test('a link click: the leave-flush saves the state, the idle clock and the engine\'s files, releases nothing, and writes through until the page is shown again', async () => {
  const w = world();
  const { hub, site: hs } = hubOf();
  const site = new HubSite(w);
  site.clock = new FakeClock();
  await site.start();
  await settle();
  const rt = site.slots[0];
  const e = eng(w, 'x');
  const persisted = e.persisted;
  site.clock.t += 5000;
  site.input.ms = site.clock.now();
  site.win.fire('click', click(link('https://b.example/next')));
  await settle();
  assert.equal(e.persisted, persisted + 1, 'the engine\'s files');
  assert.equal(hub.session.get('sumika.lastInputMs'), String(site.input.ms), 'the idle clock');
  assert.ok(site.lead.held && rt.lock.held, 'no lock released');
  assert.equal(hs.locks.held.has('sumika:x'), true);
  // write-through: a change is written in the same task, not 250 ms later
  rt.state.data.shell = 'through';
  rt.state.change();
  await Promise.resolve();
  assert.equal(JSON.parse(hub.local.getItem(stateKey('x'))).shell, 'through');
  // a beforeunload right after the click is the same flush
  site.win.fire('beforeunload', {});
  await settle();
  assert.equal(e.persisted, persisted + 1, `flushes within ${LEAVE_DEDUPE_MS} ms are one`);
  // the page stayed: shown again (pageshow), debounced as usual
  site.win.fire('pageshow', { persisted: false });
  rt.state.data.shell = 'debounced';
  rt.state.change();
  await Promise.resolve();
  assert.equal(JSON.parse(hub.local.getItem(stateKey('x'))).shell, 'through');
  assert.equal(rt.state.dirty, true);
  rt.state.saveNow();
  // a click that does not navigate this document flushes nothing
  site.clock.t += LEAVE_DEDUPE_MS;
  for (const ev of [click(link('https://b.example/x'), { button: 1 }), click(link('https://b.example/x'), { ctrlKey: true }),
    click(link('https://b.example/x'), { defaultPrevented: true }), click(link('https://b.example/x', { target: '_blank' })),
    click(link('https://b.example/x', { download: '' })), click(link('https://a.example/page#top'))]) site.win.fire('click', ev);
  await settle();
  assert.equal(e.persisted, persisted + 1);
  // the flush's write-through ends by itself when the page stays
  site.win.fire('submit', { target: { getAttribute: () => '' } });
  assert.equal(rt.state._through, true);
  await site.clock.advance(LEAVE_THROUGH_MS);
  assert.equal(rt.state._through, false);
  assert.equal(e.persisted, persisted + 2, 'a form sent to this document');
});

test('a ghost change carried by a click\'s flush, then completed on the same page: the same stored set, marker and slots as without the flush', async () => {
  const runChange = async flush => {
    const w = world();
    w.saves.set('y', {});
    platform.clear();
    const { hub } = hubOf();
    const site = new HubSite(w);
    site.clock = new FakeClock();
    await site.start();
    await settle();
    const rt = site.slots[0];
    if (rt.player && rt.player.busy) rt.player.finish();
    await settle();
    const p = site.changeGhost('y');
    await settle();
    if (flush) {
      site.win.fire('click', click(link('https://b.example/next')));
      await settle();
    }
    for (let i = 0; i < 20; i++) { for (const s of site.slots) if (s.player && s.player.busy) s.player.finish(); await settle(); }
    await p;
    const prefs = runtimePrefs.get(hub.local);
    const marker = sessionMarker.read(hub.session);
    const out = { ghosts: prefs.ghosts, ghost: prefs.ghost, slots: site.slots.map(s => s.ghost && s.ghost.id), marker: marker && marker.ghosts, carry: marker && marker.carry };
    site.done();
    SITES.length = 0;
    return out;
  };
  const without = await runChange(false);
  const withFlush = await runChange(true);
  assert.deepEqual(without.slots, ['y']);
  assert.deepEqual(withFlush, without);
});

test('staleCheck with the hub: no reload until the hub holds the guard (confirm); then one reload', async () => {
  for (const blocked of [true, false]) {
    platform.clear();
    globalThis.localStorage = memoryStorage();
    globalThis.sessionStorage = memoryStorage();
    const hs = new FakeHubSite();
    if (blocked) hs.failKeys.add(RELOADED_KEY);
    const { hub } = hubOf(hs);
    await hub.ready();
    let reloads = 0;
    const fetchFn = async (u, o) => (/build\.json/.test(u)
      ? { ok: true, json: async () => ({ build: 'B' }) }
      : { ok: true, text: async () => 'bundle of build B' });
    const site = new Site({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', runtimeFiles: { worker: 'w' }, build: 'A',
      fetch: fetchFn, reload: () => { reloads++; }, lead: false, maxGhosts: 1, Channel: null, language: new UiLanguage({ navigator: { languages: ['en'] } }) });
    assert.equal(await site.staleCheck('engine'), !blocked, blocked ? 'the hub refused the guard' : 'held');
    assert.equal(reloads, blocked ? 0 : 1);
    assert.equal(globalThis.sessionStorage.length, 0, 'the guard is the hub\'s');
  }
});

test('the hub goes away mid-page: one warn, every ghost stops here (frozen, locks let go), nothing switches stores', async () => {
  const w = world();
  const { hub, page, site: hs } = hubOf();
  const site = new HubSite(w);
  await site.start();
  await settle();
  const rt = site.slots[0];
  assert.ok(loopOf(rt));
  page.hubDocs[0].pagehide(false);
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(hub.state, 'gone');
  assert.equal(warned.filter(x => /storage hub went away/.test(x)).length, 1);
  assert.equal(rt.parts, null, 'stopped');
  assert.equal(rt.state.readOnly, true, 'frozen');
  assert.equal(site.lead.held, false);
  assert.equal(hs.locks.held.size, 0);
  assert.equal(globalThis.localStorage.length, 0, 'nothing written on the page\'s own origin');
  // turning to the tab does not start her again: the gone hub grants no lock
  site.doc.fire('visibilitychange');
  await settle();
  assert.equal(rt.parts, null);
});

test('back/forward cache: the hub takes back a lock request still waiting; pageshow persisted takes a full delta first, then restarts; the dropped-file store keeps working', async () => {
  const w = world();
  const win = pageWindow();
  const { hub, page, site: hs } = hubOf(new FakeHubSite(), { win });
  const site = new HubSite(w, { win });
  await site.start();
  await settle();
  const drops = new DropStore({ backend: () => hub.openStore('sumika').then(s => (s.kind === 'indexeddb' ? s : null)), locks: hub.locks, estimate: null, storable: () => true });
  drops.add([new File([new Uint8Array(2)], 'a.mp3', { type: 'audio/mpeg' })]);
  await drops.whenIdle();
  const first = drops._beStore;
  assert.ok(first && !first.closed);
  // another tab waits for a ghost this one holds: a wait the cached hub takes back answers "not acquired"
  const other = new GhostLock('x', { locks: hub.locks, Channel: hub.Channel });
  const wait = other.acquire({ wait: true });
  await settle();
  // the page goes into the cache: its pagehide, then the hub's (persisted)
  site.win.fire('pagehide', { persisted: true });
  page.hubDocs[0].pagehide(true);
  await settle();
  assert.equal(await wait, false, 'aborted at the hub\'s pagehide: never held by a cached page');
  assert.equal(hub.state, 'live', 'a cached hub is not gone');
  assert.equal(hs.locks.held.size, 0, 'every lock let go while cached');
  hs.local.setItem('sumika:other', 'written while cached');      // another tab, no storage event reached the cache
  hs.log.length = 0;
  site.win.fire('pageshow', { persisted: true });
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(hs.log[0].op, 'sync', 'the delta first');
  assert.equal(hub.local.getItem('sumika:other'), 'written while cached');
  assert.ok(hs.log.findIndex(m => m.op === 'lock') > 0, 'then the restart takes the locks again');
  assert.ok(hs.locks.held.has('sumika:x'));
  drops.add([new File([new Uint8Array(3)], 'b.mp3', { type: 'audio/mpeg' })]);
  await drops.whenIdle();
  assert.equal(drops._beStore, first, 'the same store port: the cached hub kept it');
  assert.ok([...hs.idb.keys()].some(k => /b\.mp3$/.test(k)));
  other.dispose();
});

test('a pagehide into the back/forward cache with the hub: nothing is posted but the releases (the saves stay in the mirrors until the pageshow takes them back), the engine is not asked for its files; not persisted, and without the hub, as before', async () => {
  // into the cache, with the hub (the HubClient hears the page's window first, as in main.js)
  {
    const w = world();
    const win = pageWindow();
    const { hub, site: hs } = hubOf(new FakeHubSite(), { win });
    const site = new HubSite(w, { win });
    assert.equal(await site.start(), 'booted');
    await settle();
    const e = eng(w, 'x');
    const files = e.persisted;
    hs.log.length = 0;
    site.win.fire('pagehide', { persisted: true });
    for (let i = 0; i < 4; i++) await settle();
    assert.equal(hub.hidden, true);
    assert.equal(e.persisted, files, 'the engine was not asked for its files');
    const ops = hs.log.map(m => m.op);
    assert.deepEqual(ops.filter(op => /^(ls|ss)\.|^will$/.test(op)), [], JSON.stringify(ops));
    assert.ok(ops.includes('unlock'), 'its locks let go');
    assert.equal(hs.locks.held.size, 0);
    site.win.fire('pageshow', { persisted: true });
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(hub.hidden, false);
    assert.ok(hs.locks.held.has('sumika:x'), 'restarted');
    site.done();
    SITES.length = 0;
    platform.clear();
  }
  // not persisted, with the hub: the usual pagehide
  {
    const w = world();
    const win = pageWindow();
    const { hub, site: hs } = hubOf(new FakeHubSite(), { win });
    const site = new HubSite(w, { win });
    assert.equal(await site.start(), 'booted');
    await settle();
    const e = eng(w, 'x');
    const files = e.persisted;
    hs.log.length = 0;
    site.win.fire('pagehide', { persisted: false });
    for (let i = 0; i < 4; i++) await settle();
    assert.equal(hub.hidden, false);
    assert.equal(e.persisted, files + 1, 'the engine asked for its files');
    const ops = hs.log.map(m => m.op);
    assert.ok(ops.includes('ls.set') && ops.includes('ss.set') && ops.includes('unlock'), JSON.stringify(ops));
    site.done();
    SITES.length = 0;
    platform.clear();
  }
  // without the hub (no data-hub): into the cache as usual, on the page's own storage
  {
    const w = world();
    const site = new HubSite(w);
    assert.equal(await site.start(), 'booted');
    await settle();
    const e = eng(w, 'x');
    const files = e.persisted;
    globalThis.localStorage.removeItem(stateKey('x'));
    globalThis.sessionStorage.removeItem('sumika.lastInputMs');
    site.win.fire('pagehide', { persisted: true });
    await settle();
    assert.equal(e.persisted, files + 1, 'the engine asked for its files');
    assert.ok(globalThis.localStorage.getItem(stateKey('x')), 'the state written on the page\'s own origin');
    assert.ok(globalThis.sessionStorage.getItem('sumika.lastInputMs'), 'the idle clock');
  }
});

test('a dropped-file store whose hub went away is let go and opened again: this page\'s memory, nothing waits 15 s', async () => {
  const w = world();
  const { hub, page, site: hs } = hubOf();
  await hub.ready();
  const drops = new DropStore({ backend: () => hub.openStore('sumika').then(s => (s.kind === 'indexeddb' ? s : null)), locks: null, estimate: null, storable: () => true });
  drops.add([new File([new Uint8Array(2)], 'a.mp3', { type: 'audio/mpeg' })]);
  await drops.whenIdle();
  const first = drops._beStore;
  page.hubDocs[0].pagehide(false);
  await settle();
  assert.equal(hub.state, 'gone');
  assert.equal(first.closed, true);
  const [e] = drops.add([new File([new Uint8Array(3)], 'b.mp3', { type: 'audio/mpeg' })]);
  await drops.whenIdle();
  assert.equal(drops._beStore, null, 'opened again: a memory store, so this page only');
  assert.ok(await drops.blob(e.path), 'it still plays here');
  assert.equal([...hs.idb.keys()].some(k => /b\.mp3$/.test(k)), false);
  assert.equal(w.saves.size, 0);
});

test('navigatingClick: button 0, no modifier, not prevented, an <a>/<area> href (in a shadow root too), no download, this document\'s target, http(s), not a fragment of this page', () => {
  const win = { location: { href: 'https://a.example/page?q=1' } };
  win.top = win;
  assert.equal(navigatingClick(click(link('https://b.example/')), win), true);
  assert.equal(navigatingClick(click(link('/other')), win), true, 'relative');
  assert.equal(navigatingClick(click(link('https://a.example/page?q=1')), win), true, 'the same URL: a navigation');
  assert.equal(navigatingClick(click(link('https://a.example/page?q=2#x')), win), true, 'another query and a fragment');
  for (const [el, o, why] of [
    [link('#top'), {}, 'a fragment of this page'], [link('https://a.example/page?q=1#'), {}, 'an empty fragment'],
    [link('mailto:x@example.com'), {}, 'not http(s)'], [link('javascript:void 0'), {}, 'javascript:'],
    [link('https://b.example/', { download: '' }), {}, 'download'], [link('https://b.example/', { target: '_blank' }), {}, '_blank'],
    [link('https://b.example/', { target: 'frame1' }), {}, 'a named target'],
    [link('https://b.example/'), { button: 2 }, 'not button 0'], [link('https://b.example/'), { shiftKey: true }, 'shift'],
    [link('https://b.example/'), { metaKey: true }, 'meta'], [link('https://b.example/'), { altKey: true }, 'alt'],
    [link('https://b.example/'), { defaultPrevented: true }, 'prevented'],
  ]) assert.equal(navigatingClick(click(el, o), win), false, why);
  for (const t of ['', '_self', '_top', '_parent', ' _SELF ']) assert.equal(navigatingClick(click(link('https://b.example/', { target: t })), win), true, t);
  const framed = { location: win.location, top: {} };
  assert.equal(navigatingClick(click(link('https://b.example/', { target: '_top' })), framed), false, '_top from a frame navigates another document');
  assert.equal(navigatingClick(click({ matches: () => false }), win), false, 'not a link');
  assert.equal(navigatingClick(null, win), false);
});

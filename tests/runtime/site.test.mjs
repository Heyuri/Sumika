// src/core/site.js (CONTRACTS "Site"): the page's singletons (index, language, tab id, idle clock, site channel, page
// hooks, tab marker and stored set) live on a Site; each ghost is a Runtime in its slots. A Runtime made without a site
// gets an implicit one-ghost Site with the single-ghost behaviour (switch.test.mjs and the other runtime suites are the
// oracle for that); these tests pin the split itself, the one-ghost Site's v1 + v2 records, and the stored set's
// wiring in main.js's lead Site (multi.test.mjs drives several ghosts).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Site, chooseGhost as siteChooseGhost, SITE_CHANNEL as SITE_CHANNEL_SITE } from '../../src/core/site.js';
import { Runtime, chooseGhost, SITE_CHANNEL } from '../../src/core/runtime.js';
import { SiteIndex } from '../../src/core/loader.js';
import { UiLanguage } from '../../src/core/language.js';
import { GhostLock, InputClock, memoryStorage, runtimePrefs, sessionMarker, SESSION_KEY, stateKey } from '../../src/core/state.js';
import { LEAD_ID, MAX_GHOSTS, ALL_GHOSTS } from '../../src/core/ghostset.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle, deferred } from './fakes.mjs';

setLogLevel('silent');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/ghosts.json'), 'utf8'));

function siteIndex(ghosts = SITE.ghosts) {
  return { base: 'http://s/', ghosts, balloons: [], ghost: id => ghosts.find(g => g.id === id) || null, balloon: () => null };
}

// ---------------------------------------------------------------- the browser around the page (copied from switch.test.mjs)

class FakeLocks {
  constructor() { this.held = new Set(); this.queue = new Map(); }
  request(name, opts, cb) {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.held.add(name);
        Promise.resolve(cb({ name })).then(v => { this.held.delete(name); resolve(v); this._next(name); }, reject);
      };
      if (!this.held.has(name)) grant();
      else if (opts && opts.ifAvailable) Promise.resolve(cb(null)).then(resolve, reject);
      else { if (!this.queue.has(name)) this.queue.set(name, []); this.queue.get(name).push(grant); }
    });
  }
  _next(name) { const q = this.queue.get(name); if (q && q.length && !this.held.has(name)) q.shift()(); }
}

/** BroadcastChannel stand-in: every channel of the same name on one bus hears the others. */
function busChannel() {
  const all = new Set();
  return class {
    constructor(name) { this.name = name; this.onmessage = null; all.add(this); }
    postMessage(data) {
      const msg = structuredClone(data);
      for (const c of all) if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage && c.onmessage({ data: msg }));
    }
    close() { all.delete(this); }
  };
}

function world({ ghosts = SITE.ghosts } = {}) {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  return { index: siteIndex(ghosts), locks: new FakeLocks(), Channel: busChannel(), saves: new Map(), engines: [] };
}

function answer(id, r) {
  switch (r.id) {
    case 'OnBoot': return `\\0${id}: boot\\e`;
    case 'OnFirstBoot': return `\\0${id}: first\\e`;
    case 'OnGhostChanging': return `\\0${id}: bye, ${r.refs[0]}\\e`;
    case 'OnGhostChanged': return `\\0${id}: from ${r.refs[0]}\\e`;
    default: return null;
  }
}

const LIVE = new Set();
afterEach(() => { for (const x of LIVE) x.done(); });

/** A Runtime with fake engine and views; `o` are the options a Site's createRuntime passes (site included). */
class TestRuntime extends Runtime {
  constructor(w, o = {}) {
    super({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', defaultGhost: 'tsubasa', Channel: w.Channel, ...o });
    this.w = w;
    this.players = [];
    LIVE.add(this);
  }
  _newLock(id) { return new GhostLock(id, { locks: this.w.locks, Channel: null }); }
  async _ghostCommon() {
    const g = this.ghost;
    const files = { url: p => `http://s/ghost/${g.id}/${p}`, has: () => false, list: () => [] };
    return { files, ghostDescript: new Map([['name', g.name], ['sakura.name', g.sakuraName]]), shellId: 'master' };
  }
  async _startEngine() {
    const g = this.ghost;
    if (this.w.hold && this.w.hold[g.id]) await this.w.hold[g.id];
    const hadSave = this.w.saves.has(g.id);
    const sh = new FakeShiori(r => answer(g.id, r));
    sh.ghost = g.id;
    sh.terminate = () => { sh.terminated = true; };
    sh.unload = async () => { sh.unloaded = true; this.w.saves.set(g.id, {}); return []; };
    sh.persist = async () => { sh.persisted++; this.w.saves.set(g.id, {}); return []; };
    this.w.engines.push(sh);
    return { client: sh, r: { hadSave } };
  }
  async _createStage() { const s = new FakeStage(); s.destroy = () => {}; s.defaultSurface = x => (x === 0 ? 0 : 10); return s; }
  async _loadSkin() { return { skin: { balloon: () => null }, name: '', path: '' }; }
  async _createBalloons() { const b = new FakeBalloons(); b.destroy = () => {}; return b; }
  _createDialogs() { return new FakeDialogs(); }
  _createPlayer() { const p = new FakePlayer(); this.players.push(p); return p; }
  get loop() { return this.parts && this.parts.loop; }
  get player() { return this.players[this.players.length - 1]; }
  done() {
    LIVE.delete(this);
    this._teardown();
    this._clearFrozen();
    if (this.lock) this.lock.dispose();
    if (this._channel) this._channel.close();
  }
}

/** A one-ghost Site (no lead lock: the single-ghost configuration), with TestRuntime slots and the world's index. */
class TestSite extends Site {
  constructor(w, o = {}) {
    super({
      base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', defaultGhost: 'tsubasa', Channel: w.Channel,
      language: new UiLanguage({ navigator: { languages: ['en-US'] } }), lead: false, maxGhosts: 1,
      createRuntime: opts => new TestRuntime(w, opts), ...o,
    });
    this.index = w.index;
  }
}

/** A window or document stand-in that records listeners and fires them. */
function fakeTarget(extra = {}) {
  const l = new Map();
  return {
    ...extra,
    addEventListener(t, f) { if (!l.has(t)) l.set(t, new Set()); l.get(t).add(f); },
    removeEventListener(t, f) { const s = l.get(t); if (s) s.delete(f); },
    fire(t, ev) { for (const f of [...(l.get(t) || [])]) f(ev); },
    count(t) { return (l.get(t) || new Set()).size; },
  };
}

const rawMarker = () => JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
const bootIds = sh => sh.ids().filter(x => /On(GhostChanged|GhostChanging|Boot|FirstBoot|Close|Destroy)$/.test(x));

// ---------------------------------------------------------------- the implicit Site

test('implicit Site: a Runtime made without one adopts itself as the only slot; index and language are the Site\'s', () => {
  const rt = new Runtime({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', Channel: null });
  assert.ok(rt.site instanceof Site);
  assert.deepEqual(rt.site.slots, [rt]);
  assert.equal(rt.site.maxGhosts, 1);
  assert.equal(rt.site.multi, false);
  assert.equal(rt.site.lead, null, 'no lead lock: the ghost lock is the only one');
  assert.equal(rt.site.layers, null, 'no layers');
  assert.equal(rt.site.peersFor(rt), null, 'its loop is alone');
  assert.equal(rt.site.callList(rt), null, 'no Call ghost ▸');
  assert.equal(rt.layer, null);

  const index = siteIndex();
  rt.index = index;                                       // what the old tests and callers do
  assert.equal(rt.site.index, index);
  assert.equal(rt.index, index);
  const lang = new UiLanguage({ navigator: { languages: ['ja-JP'] } });
  rt.language = lang;
  assert.equal(rt.site.language, lang);
  assert.equal(rt.tabId, rt.site.tabId);
  assert.equal(rt.input, null, 'the idle clock is made at the first boot');
  const input = rt.site._ensureInput();
  assert.ok(input instanceof InputClock);
  assert.equal(rt.input, input);
  assert.equal(rt.site._ensureInput(), input, 'one per page');
  assert.equal(rt._channel, undefined, 'the site channel is made on the first start');
  assert.equal(rt.site._siteChannel(), null, 'Channel: null -> none');
  assert.equal(rt._channel, null);
  assert.deepEqual(rt.ghostList(), rt.site.ghostList(rt));
  assert.deepEqual(rt.ghostList().map(g => [g.id, g.current, g.needs]), [['testghost', false, null], ['tsubasa', false, null], ['misakaghost', false, 'Misaka']]);

  // another Runtime without a site is another page: its own Site, tab id and sid
  const other = new Runtime({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', Channel: null });
  assert.notEqual(other.site, rt.site);
  assert.notEqual(other.tabId, rt.tabId);
  assert.notEqual(other.sid, rt.sid);
  assert.equal(other.index, null);
  assert.deepEqual(other.site.slots, [other]);

  // the helpers that moved are still imported from runtime.js
  assert.equal(chooseGhost, siteChooseGhost);
  assert.equal(SITE_CHANNEL, SITE_CHANNEL_SITE);
  assert.equal(SITE_CHANNEL, 'sumika/runtime');
});

// ---------------------------------------------------------------- main.js's Site

test('a Site with createRuntime has slot 0 before start; start() boots it and resolves with its outcome', async () => {
  const w = world();
  const site = new TestSite(w);
  assert.equal(site.slots.length, 1, 'window.sumika.runtime is never null');
  const rt = site.slots[0];
  assert.ok(rt instanceof TestRuntime);
  assert.equal(rt.site, site);
  assert.equal(rt.ghost, null, 'no ghost before start()');
  site._adopt(rt);
  assert.equal(site.slots.length, 1, 'adopted once');

  assert.equal(await site.start(), 'booted');
  assert.equal(rt.ghost.id, 'tsubasa');
  assert.deepEqual(bootIds(w.engines[0]), ['GET OnFirstBoot']);
  const m = rawMarker();
  // byte for byte: the v1 fields first, then v2's ghosts (no carry: nothing owed), then the version mark
  assert.equal(JSON.stringify(m), JSON.stringify({ booted: true, ghost: 'tsubasa', sessionEpochMs: m.sessionEpochMs, ghosts: ['tsubasa'], v: 2 }));
  assert.ok(m.sessionEpochMs > 0);
  assert.deepEqual(runtimePrefs.get(), { ghost: 'tsubasa', ghosts: ['tsubasa'], rev: 1 }, 'the stored choice, as a set of one');
  assert.equal(site.sessionEpochMs, m.sessionEpochMs);
  assert.equal(rt.loop.sessionEpochMs, m.sessionEpochMs);
  assert.ok(site.input instanceof InputClock);
  assert.equal(rt.loop.input, site.input);
  assert.equal(rt.loop.language, site.language);
  assert.equal(site.find('tsubasa'), rt);
  assert.equal(site.find('testghost'), null);
  assert.equal(site.ghostList().find(g => g.current).id, 'tsubasa', 'Change ghost ▸ of slot 0 by default');
  rt.player.finish();

  // the next page of the tab (a new Site, the same storages) resumes her; its epoch is the tab's first page
  site._onPageHide();
  rt.done();
  await settle();
  const next = new TestSite(w);
  assert.equal(await next.start(), 'booted');
  assert.equal(w.engines.at(-1).find('OnBoot').length + w.engines.at(-1).find('OnFirstBoot').length, 0, 'a resume');
  assert.equal(next.sessionEpochMs, m.sessionEpochMs);
  next.slots[0].done();

  // nothing to run: 'none'; a Site without createRuntime has no slot to start
  const empty = new TestSite(world({ ghosts: [] }));
  assert.equal(await empty.start(), 'none');
  empty.slots[0].done();
  assert.equal(await new Site({ Channel: null }).start(), 'none');
});

test('the one-ghost Site writes the tab marker (v1 + ghosts, carry) and the stored set of one, and reads them back', () => {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  const posted = [];
  const site = new Site({ Channel: class { constructor() { this.onmessage = null; } postMessage(m) { posted.push(m); } }, lead: false, maxGhosts: 1 });
  assert.equal(site.multi, false);
  const launchers = [];
  const rt = { ghost: { id: 'b' }, _showLauncher: mode => launchers.push(mode) };
  const change = { sakuraName: 'A', name: 'Ghost A', path: '/ghost/a/', script: '\\0bye\\e' };

  assert.equal(site._inMarker('b'), false);
  assert.equal(site._carried('b'), null);
  site._onBooting(rt, { change, now: 1000 });            // a change's boot: pending until OnGhostChanged is sent
  assert.deepEqual(rawMarker(), { booted: true, ghost: 'b', sessionEpochMs: 1000, pending: true, change, ghosts: ['b'], carry: { b: { kind: 'change', change } }, v: 2 });
  assert.deepEqual(runtimePrefs.get(), { ghost: 'b', ghosts: ['b'], rev: 1 });
  assert.equal(site.sessionEpochMs, 1000);
  assert.equal(site._inMarker('b'), true);
  assert.equal(site._inMarker('a'), false);
  assert.deepEqual(site._carried('b'), { kind: 'change', change });
  assert.equal(site._carried('a'), null);

  site._onBooted(rt, { resume: false, run: null, change });
  assert.deepEqual(rawMarker(), { booted: true, ghost: 'b', sessionEpochMs: 1000, ghosts: ['b'], v: 2 }, 'no longer pending');
  assert.equal(site._carried('b'), null);
  site._onBooted(rt, { resume: true, run: null, change: null });
  assert.deepEqual(rawMarker(), { booted: true, ghost: 'b', sessionEpochMs: 1000, ghosts: ['b'], v: 2 });

  site._onBooting({ ghost: { id: 'a' } }, { now: 5000 });
  assert.equal(site.sessionEpochMs, 1000, 'the tab\'s first page stays OnSecondChange R0');
  assert.deepEqual(rawMarker(), { booted: true, ghost: 'a', sessionEpochMs: 1000, ghosts: ['a'], v: 2 });
  assert.deepEqual(runtimePrefs.get(), { ghost: 'a', ghosts: ['a'], rev: 2 });

  // a page left during a change to c: the next page cold-boots c with OnGhostChanged
  site._carry(rt, { id: 'c', kind: 'change', change: null });
  assert.deepEqual(rawMarker(), { booted: true, ghost: 'c', sessionEpochMs: 1000, pending: true, change: null, ghosts: ['c'], carry: { c: { kind: 'change', change: null } }, v: 2 });
  assert.deepEqual(runtimePrefs.get(), { ghost: 'c', ghosts: ['c'], rev: 3 });
  assert.deepEqual(site._carried('c'), { kind: 'change', change: null });

  // a v1 marker (a tab open across the deploy) still carries its change on
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ booted: true, ghost: 'e', sessionEpochMs: 7, pending: true, change }));
  assert.deepEqual(site._carried('e'), { kind: 'change', change });
  assert.equal(site._inMarker('e'), true);

  // a change in the slot: stored and posted to the other tabs as a set message
  site._replaceInSet(rt, 'c', 'd');
  assert.deepEqual(runtimePrefs.get(), { ghost: 'd', ghosts: ['d'], rev: 4 });
  assert.deepEqual(posted, [{ t: 'set', ghosts: ['d'], rev: 4, cause: { kind: 'change', from: 'c', to: 'd' }, from: site.tabId }]);

  // closed: the marker goes, the launcher calls it back
  site._onClosed(rt, { script: '\\0bye\\-' });
  assert.equal(rawMarker(), null);
  assert.equal(sessionMarker.read(), null);
  assert.deepEqual(launchers, ['closed']);
  assert.deepEqual(runtimePrefs.get(), { ghost: 'd', ghosts: ['d'], rev: 4 }, 'the choice stays');

  const calls = [];
  const slot = { restart: o => { calls.push(['restart', o]); return 'r'; }, _tryTakeover: () => { calls.push(['take']); return 't'; } };
  assert.equal(site._relaunch(slot), 'r');
  assert.equal(site._wake(slot), 't');
  assert.deepEqual(calls, [['restart', { cold: true }], ['take']]);
});

// ---------------------------------------------------------------- page hooks

test('page hooks: pagehide saves every slot once, then the idle clock; pageshow from the bfcache restarts; hidden: a slot asked for yields', () => {
  const doc = fakeTarget({ hidden: false });
  class HookSite extends Site { _doc() { return doc; } }
  const bound = [];
  const language = { bindWindow: w => bound.push(w), refresh() {} };
  const site = new HookSite({ Channel: null, language, lead: false, maxGhosts: 1 });
  const order = [];
  const slot = name => ({
    _yieldWhenHidden: false,
    _onPageHide() { order.push(`${name}:hide`); },
    _yield() { order.push(`${name}:yield`); },
    restart() { order.push(`${name}:restart`); return Promise.resolve('booted'); },
  });
  const a = slot('a');
  const b = slot('b');
  site._adopt(a);
  site._adopt(b);
  site._adopt(a);
  assert.equal(site.slots.length, 2);
  site.input = { flush() { order.push('flush'); } };
  const win = fakeTarget();
  site._installPageHooks(win);
  site._installPageHooks(win);                           // every start asks; installed once
  assert.deepEqual(bound, [win], 'the language listens to the window once');
  assert.equal(win.count('pagehide'), 1);
  assert.equal(doc.count('visibilitychange'), 1);

  win.fire('pagehide', {});
  assert.deepEqual(order, ['a:hide', 'b:hide', 'flush']);

  order.length = 0;
  win.fire('pageshow', { persisted: false });
  assert.deepEqual(order, []);
  win.fire('pageshow', { persisted: true });
  assert.deepEqual(order, ['a:restart'], 'one ghost: the slot restarts as the Runtime did');

  order.length = 0;
  doc.fire('visibilitychange');
  b._yieldWhenHidden = true;
  doc.fire('visibilitychange');
  assert.deepEqual(order, [], 'visible: nobody yields');
  doc.hidden = true;
  doc.fire('visibilitychange');
  assert.deepEqual(order, ['b:yield'], 'only the slot another tab asked for');

  // a slot that fails to save does not keep the others or the idle clock from it
  order.length = 0;
  a._onPageHide = () => { throw new Error('boom'); };
  win.fire('pagehide', {});
  assert.deepEqual(order, ['b:hide', 'flush']);

  // no window (Node, a worker): nothing is installed
  const bare = new Site({ Channel: null, language, lead: false, maxGhosts: 1 });
  bare._installPageHooks(null);
  assert.equal(bare._pageHooks, false);
});

// ---------------------------------------------------------------- the other tabs

test('site channel (one ghost): a set message changing the ghost, or an old tab\'s {t:\'ghost\'}, reaches _follow; {t:\'view\'} the slot showing that ghost', async () => {
  const w = world();
  const tab1 = new Site({ Channel: w.Channel, lead: false, maxGhosts: 1 });
  const tab2 = new Site({ Channel: w.Channel, lead: false, maxGhosts: 1 });
  const got = [];
  tab2._adopt({ ghost: { id: 'tsubasa' }, _follow: async id => got.push(['follow', id]), _followView: async () => got.push(['view']) });
  tab1._siteChannel();
  tab2._siteChannel();
  tab1._announce('testghost');
  await settle();
  assert.deepEqual(got, [], 'no index yet: nothing to follow');
  tab2.index = w.index;
  tab1._post({ t: 'set', ghosts: ['testghost'], rev: 2, cause: { kind: 'change', from: 'tsubasa', to: 'testghost' } });
  tab1._post({ t: 'ghost', id: 'misakaghost' });         // a tab on an older one-ghost runtime
  tab1._post({ t: 'set', ghosts: ['tsubasa', 'testghost'], rev: 9, cause: { kind: 'call', id: 'testghost' } });   // one ghost: not followed
  tab1._post({ t: 'view', id: 'tsubasa' });
  tab1._post({ t: 'view', id: 'testghost' });           // a ghost no slot shows here
  tab1._post({ t: 'other', id: 'tsubasa' });
  tab2._announce('testghost');                           // its own message never comes back to it
  await settle();
  assert.deepEqual(got, [['follow', 'testghost'], ['follow', 'misakaghost'], ['view']]);
  tab1._channel.close();
  tab2._channel.close();
});

test('two tabs of a one-ghost Site: the second shows the ghost frozen; a change in the first is followed there', async () => {
  const w = world();
  const tab1 = new TestSite(w);
  const tab2 = new TestSite(w);
  assert.equal(await tab1.start(), 'booted');
  const rt1 = tab1.slots[0];
  rt1.player.finish();
  assert.equal(await tab2.start(), 'frozen');
  const rt2 = tab2.slots[0];
  assert.ok(rt2.frozen && !rt2.parts);
  const p = rt1.changeGhost('testghost');
  for (let i = 0; i < 20 && !(rt1.loop && rt1.loop.current && rt1.loop.current.event === 'OnGhostChanging'); i++) await settle();
  rt1.player.finish();
  assert.equal(await p, true);
  await settle(20);
  assert.equal(rt1.ghost.id, 'testghost');
  assert.equal(rt2.ghost.id, 'testghost', 'the other tab followed');
  assert.equal(rt2.parts, null);
  assert.deepEqual(w.engines.map(e => e.ghost), ['tsubasa', 'testghost'], 'never a second engine');
  assert.deepEqual(runtimePrefs.get(), { ghost: 'testghost', ghosts: ['testghost'], rev: 2 });
  rt1.done();
  rt2.done();
});

test('a one-ghost Site: a page left during the farewell carries the change on through the Site\'s pagehide', async () => {
  const w = world();
  w.saves.set('tsubasa', {});
  w.saves.set('testghost', {});                          // met before: not her first boot
  const site = new TestSite(w);
  await site.start();
  const rt = site.slots[0];
  rt.player.finish();
  rt.changeGhost('testghost');                           // never settles: the page goes first
  for (let i = 0; i < 20 && !(rt.loop.current && rt.loop.current.event === 'OnGhostChanging'); i++) await settle();
  site._onPageHide();                                    // what the window's pagehide runs
  rt.done();
  await settle();
  assert.equal(runtimePrefs.get().ghost, 'testghost');
  assert.equal(rawMarker().pending, true);

  const next = new TestSite(w);
  assert.equal(await next.start(), 'booted');
  const b = w.engines.at(-1);
  assert.equal(b.ghost, 'testghost');
  assert.deepEqual(bootIds(b), ['GET OnGhostChanged']);
  assert.equal(b.find('OnGhostChanged')[0].refs[1], '\\0tsubasa: bye, Testy\\e');
  assert.deepEqual(Object.keys(rawMarker()).sort(), ['booted', 'ghost', 'ghosts', 'sessionEpochMs', 'v'], 'no longer pending');
  next.slots[0].done();
});

// ---------------------------------------------------------------- main.js's lead Site: the stored set

/** main.js's Site: the lead lock, several ghosts (maxGhosts), TestRuntime slots. */
class LeadSite extends TestSite {
  constructor(w, o = {}) { super(w, { lead: true, maxGhosts: MAX_GHOSTS, ...o }); this.w = w; }
  _newLeadLock() { return new GhostLock(LEAD_ID, { locks: this.w.locks, Channel: null }); }
}

test('main.js\'s Site: the stored set in order (lost and unrunnable ghosts dropped, at most maxGhosts), the lead held while it runs, let go on pagehide', async () => {
  const w = world();
  runtimePrefs.set({ ghost: 'gone', ghosts: ['gone', 'tsubasa', 'misakaghost', 'tsubasa', 'testghost'], rev: 5, lang: 'ja' });
  const site = new LeadSite(w);
  assert.equal(site.multi, true);
  assert.equal(await site.start(), 'booted');
  assert.deepEqual(site.slots.map(rt => rt.ghost.id), ['tsubasa', 'testghost']);
  assert.ok(site.slots.every(rt => rt.loop && rt.loop.booted));
  assert.deepEqual(runtimePrefs.get(), { ghost: 'tsubasa', ghosts: ['tsubasa', 'testghost'], rev: 6, lang: 'ja' }, 'the set as it runs, stored again');
  assert.equal(site.lead.name, 'sumika/lead');
  assert.ok(w.locks.held.has('sumika/lead') && w.locks.held.has('sumika:tsubasa') && w.locks.held.has('sumika:testghost'));
  assert.deepEqual(rawMarker().ghosts, ['tsubasa', 'testghost']);
  assert.equal(rawMarker().ghost, 'tsubasa', 'the v1 mirror');
  assert.equal(site.layers.order().length, 2, 'a layer per ghost');
  assert.deepEqual(site.running().map(r => r.id), ['tsubasa', 'testghost']);
  assert.deepEqual(site.siteGhosts().map(g => [g.id, g.current, g.running, g.needs]), [['testghost', false, true, null], ['tsubasa', true, true, null], ['misakaghost', false, false, 'Misaka']]);
  for (const rt of site.slots) rt.player.finish();
  site._onPageHide();
  await settle();
  assert.ok(!site.lead.held && !w.locks.held.has('sumika/lead'), 'pagehide lets the lead go');
  for (const rt of site.slots) rt.done();

  // the cap; a stale `ghost` written by a tab on the one-ghost runtime takes slot 0 (ghostset.js chooseSet)
  globalThis.sessionStorage = memoryStorage();
  runtimePrefs.set({ ghost: 'testghost', ghosts: ['tsubasa', 'testghost'], rev: 6 });
  const one = new LeadSite(w, { maxGhosts: 1 });
  assert.equal(await one.start(), 'booted');
  assert.deepEqual(one.slots.map(rt => rt.ghost.id), ['testghost']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['testghost']);
  assert.equal(one.callList(), null, 'one ghost at a time: no Call ghost ▸');
  for (const rt of one.slots) rt.done();
});

test('the site\'s ghosts in ssp.exe\'s Change ghost ▸ order, an index in folder order too (SiteIndex.load); a page without data-default-ghost boots the first one that can run', async () => {
  // 23 ghosts as ssp.exe lists them (from a screenshot), and an index an older tool wrote
  const shot = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/ssp-ghost-order.json'), 'utf8')).ghosts;
  const ids = shot.map(g => g.id);
  // the first two by name need AYA (not here): a boot takes emily4, where the first folder that can run is Hanaichi
  const needsAya = new Set(['BTHver.5', 'DSLGS']);
  const folders = shot.map(g => ({ ...g, sakuraName: g.name, ...(needsAya.has(g.id) ? { engine: 'aya' } : {}) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.notDeepEqual(folders.map(g => g.id), ids);
  const real = globalThis.fetch;
  globalThis.fetch = async url => (String(url) === 'http://s/sumika/index/ghosts.json'
    ? new Response(JSON.stringify({ format: 2, ghosts: folders, balloons: [] })) : new Response('', { status: 404 }));
  let index;
  try {
    index = await SiteIndex.load('http://s/');
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(index.ghosts.map(g => g.id), ids);
  assert.equal(index.ghost('pit').name, '奈落の王');

  assert.equal(chooseGhost(index, {}).id, 'BTHver.5', 'no stored ghost, no default: the first by name');
  assert.equal(chooseGhost(index, { supported: g => !needsAya.has(g.id) }).id, 'emily4', 'the first that can run');
  assert.equal(chooseGhost(index, { defaultGhost: 'pit' }).id, 'pit', 'data-default-ghost still wins');

  const w = world();
  w.index = index;
  const site = new LeadSite(w, { defaultGhost: null });
  assert.equal(await site.start(), 'booted');
  const [rt] = site.slots;
  assert.equal(rt.ghost.id, 'emily4', 'the first by name the runtime can run (by folder: Hanaichi)');
  assert.equal(folders.find(g => !needsAya.has(g.id)).id, 'Hanaichi');
  assert.deepEqual(site.ghostList(rt).map(g => g.id), ids, 'Change ghost ▸');
  assert.deepEqual(site.callList(rt).map(g => g.id), ids, 'Call ghost ▸');
  assert.deepEqual(site.siteGhosts().map(g => g.id), ids, 'the page API\'s ghosts()');
  assert.deepEqual(site.propsFor(rt).ghosts().map(g => g.name), shot.map(g => g.name), 'ghostlist');
  rt.player.finish();
  site._onPageHide();
  rt.done();
});

test('the queue of set changes: an idle queue runs a job at once, others wait their turn (FIFO); busy() while any runs or waits', async () => {
  const site = new Site({ Channel: null });
  const peers = site.peersFor({});
  const order = [];
  const gate = deferred();
  const a = site._mutate('call', () => { order.push('a start'); return gate.promise.then(() => { order.push('a end'); return 'A'; }); });
  assert.deepEqual(order, ['a start'], 'idle: at once, in the same task');
  const b = site._mutate('change', () => { order.push('b start'); return 'B'; });
  const c = site._mutate('call', () => { order.push('c start'); throw new Error('boom'); });
  assert.equal(peers.busy(), true);
  await settle();
  assert.deepEqual(order, ['a start']);
  gate.resolve();
  assert.equal(await a, 'A');
  assert.equal(await b, 'B');
  await assert.rejects(c, /boom/);
  assert.deepEqual(order, ['a start', 'a end', 'b start', 'c start']);
  await settle();
  assert.equal(peers.busy(), false);
  site._mutate('change', () => order.push('d'));
  assert.equal(order.at(-1), 'd', 'idle again: at once');
});

test('a frozen slot\'s drop wakes it through the Site, which takes the ghost over (implicit Site: the per-ghost lock)', async () => {
  const w = world();
  w.saves.set('tsubasa', {});
  const tab1 = new TestSite(w);
  assert.equal(await tab1.start(), 'booted');
  tab1.slots[0].player.finish();
  const wakes = [];
  class WakeSite extends TestSite { _wake(rt) { wakes.push(rt); return super._wake(rt); } }
  const tab2 = new WakeSite(w);
  const rt2 = tab2.slots[0];
  assert.equal(await tab2.start(), 'frozen');
  const gate = deferred();
  rt2._tryTakeover = async function () { await gate.promise; return Runtime.prototype._tryTakeover.call(this); };
  rt2.frozen.emit('drop', { scope: 0, files: [], x: 1, y: 1 });
  assert.deepEqual(wakes, [rt2]);
  tab1.slots[0]._onPageHide();                           // tab 1 goes: its lock is free
  tab1.slots[0].done();
  gate.resolve();
  for (let i = 0; i < 20 && !(rt2.loop && rt2.loop.booted); i++) await settle();
  assert.ok(rt2.loop && rt2.loop.booted, 'tab 2 runs her now');
  assert.equal(w.engines.at(-1).find('OnBoot').length, 0, 'taken over: a resume');
  rt2.done();
});

// ---------------------------------------------------------------- ghost-to-ghost talk and raised events (EV §2.7.7, §2.7.9)

/**
 * A slot whose loop stands in for events.js's side of the talk and raise routing (communicated, raisedByOther,
 * notifyEvent, lockReason, peerInfo; interact_loop.test.mjs tests those): every call goes to `log` as
 * [ghost id, method, …]. o.answer(id, refs, opts) -> raisedByOther's result (default {ok: true, status: 200}); o.loop:
 * fields over the loop's.
 */
function stubSlot(log, info, o = {}) {
  const loop = {
    booted: true, closed: false, closing: false, changing: false, frozen: false, lockReason: '',
    peerInfo: () => ({ id: info.id, name: info.name, sakuraName: info.sakuraName, keroName: info.keroName || '', surfaces: [0, 10], shell: 'master' }),
    async communicated(c) { log.push([info.id, 'communicated', c]); return o.comm ? o.comm(c) : { status: 200, played: true }; },
    async raisedByOther(id, refs, opts) { log.push([info.id, 'raisedByOther', id, refs, opts]); return o.answer ? o.answer(id, refs, opts) : { ok: true, status: 200 }; },
    async notifyEvent(id, refs, opts) { log.push([info.id, 'notifyEvent', id, refs, opts]); return { status: 200, played: true }; },
    ...(o.loop || {}),
  };
  return { ghost: { ...info }, _up: true, frozen: null, _starting: null, parts: { loop } };
}

const X = { id: 'x', name: 'Ghost X', sakuraName: 'Ex', keroName: 'Kx' };
const Y = { id: 'y', name: 'Ghost Y', sakuraName: 'なと', keroName: 'ごはん' };
const Z = { id: 'z', name: 'Ghost Z', sakuraName: 'Zed', keroName: 'Kz' };
const W = { id: 'w', name: 'Ghost W', sakuraName: 'Dub', keroName: '' };
const FAIL = { senderType: 'internal,raise' };

test('implicit Site, \\![raiseother] alone: an unknown ghost -> OnRaiseOtherFailure [notfound, the argument, event, refs]; its own names, ALL, random -> nothing', async () => {
  const site = new Site({ Channel: null, lead: false, maxGhosts: 1 });
  const log = [];
  const x = site._adopt(stubSlot(log, X));
  assert.equal(site.peersFor(x), null, 'nobody to talk to');
  await site._onRaiseOther(x, { ghost: 'nobody', id: 'OnTea', refs: ['紅茶', 'クッキー'] });
  assert.deepEqual(log, [['x', 'notifyEvent', 'OnRaiseOtherFailure', ['notfound', 'nobody', 'OnTea', '紅茶', 'クッキー'], FAIL]]);
  log.length = 0;
  await site._onRaiseOther(x, { ghost: 'nobody', id: 'OnTea', refs: [], notify: true });
  assert.deepEqual(log, [['x', 'notifyEvent', 'OnNotifyOtherFailure', ['notfound', 'nobody', 'OnTea'], FAIL]], 'notifyother');
  log.length = 0;
  site._random = () => 0;
  for (const ghost of ['Ex', 'ex', 'E x', 'Ghost X', ALL_GHOSTS, '__system_all_ghost__', 'random', 'Ex\x01Ghost X']) {
    await site._onRaiseOther(x, { ghost, id: 'OnTea', refs: ['a'] });
  }
  assert.deepEqual(log, [], 'the raiser is skipped silently: no event, no failure');
  // arguments (C2): \![raiseother] alone; an empty event
  await site._onRaiseOther(x, { ghost: undefined, id: '', refs: [] });
  await site._onRaiseOther(x, {});
  await site._onRaiseOther(x, { ghost: 'nobody', id: '', refs: ['a'] });
  await site._onRaiseOther(x, { ghost: 'Ex', id: '' });
  await site._onRaiseOther(x, { ghost: 'random', id: '' });
  await site._onRaiseOther(x, { ghost: 'LastInstall', id: '' });
  await site._onRaiseOther(x, { ghost: 'lastinstall', id: 'OnTea', refs: ['a'] });
  assert.deepEqual(log.map(e => e.slice(2, 4)), [
    ['OnRaiseOtherFailure', ['invalid']],
    ['OnRaiseOtherFailure', ['invalid']],
    ['OnRaiseOtherFailure', ['notfound', 'nobody']],
    ['OnRaiseOtherFailure', ['invalid', 'Ex']],
    ['OnRaiseOtherFailure', ['invalid', 'random']],
    ['OnRaiseOtherFailure', ['invalid', 'LastInstall']],
    ['OnRaiseOtherFailure', ['notfound', 'lastinstall', 'OnTea', 'a']],
  ]);
  // a talk to another ghost goes nowhere
  log.length = 0;
  await site._onCommunicate(x, { communicate: { ids: ['x', 'y'], sender: 'Ex', sentence: 'hi', refs: [], age: '0', surface: '0\x0110', marker: '' } });
  assert.deepEqual(log, []);
});

test('peersFor(rt).match: the sakura names of the other ghosts a talk can reach (_liveSlot: up, booted, not frozen, closed or changing; closing counts)', () => {
  const site = new Site({ Channel: null });
  const log = [];
  const x = site._adopt(stubSlot(log, X));
  site._adopt(stubSlot(log, Y));
  const z = site._adopt(stubSlot(log, Z, { loop: { closing: 'one' } }));
  const frozen = site._adopt(stubSlot(log, { id: 'f', name: 'F', sakuraName: 'Frozen' }));
  frozen.frozen = {};
  site._adopt(stubSlot(log, { id: 'c', name: 'C', sakuraName: 'Changing' }, { loop: { changing: true } }));
  site._adopt(stubSlot(log, { id: 'd', name: 'D', sakuraName: 'Closed' }, { loop: { closed: true } }));
  site._adopt(stubSlot(log, { id: 'b', name: 'B', sakuraName: 'Booting' }, { loop: { booted: false } }));
  site._adopt(stubSlot(log, { id: 't', name: 'T', sakuraName: 'TornDown' }, { loop: { frozen: true } }));
  const down = site._adopt(stubSlot(log, { id: 'u', name: 'U', sakuraName: 'NotUp' }));
  down._up = false;
  site._adopt({ ghost: { id: 'n', name: 'N', sakuraName: 'NoLoop' }, _up: true, frozen: null, parts: null });
  const peers = site.peersFor(x);
  assert.deepEqual(peers.match(ALL_GHOSTS), ['y', 'z'], 'every other ghost a talk can reach, in set order');
  assert.deepEqual(peers.match('Zed\x01なと\x01Ex'), ['z', 'y'], 'never the sender');
  for (const t of ['Frozen', 'Changing', 'Closed', 'Booting', 'TornDown', 'NotUp', 'NoLoop', 'Ghost Y', 'ごはん']) {
    assert.deepEqual(peers.match(t), [], t);
  }
  assert.deepEqual(site.peersFor(z).match(ALL_GHOSTS), ['x', 'y'], 'a closing ghost talks too');
  assert.ok(site._liveSlot(z) && !site._liveSlot(frozen) && !site._liveSlot(down) && !site._liveSlot(null));
  // others() (otherghostname, the FMO, EV §2.7.8): every other slot up, a frozen one (its ghost runs in another tab)
  // and one not up yet left out [decision]
  const others = peers.others().map(p => p.id);
  assert.ok(['y', 'z', 'b', 'c'].every(id => others.includes(id)), others.join());
  assert.ok(!others.includes('f') && !others.includes('u') && !others.includes('x'), others.join());
});

test('_onCommunicate: once the ghosts up have started, each target in order and one at a time; the sender and ghosts not reachable are skipped, duplicates sent twice', async () => {
  const site = new Site({ Channel: null });
  const log = [];
  const gate = deferred();
  let first = true;
  const x = site._adopt(stubSlot(log, X));
  site._adopt(stubSlot(log, Y, { comm: () => { if (!first) return { status: 200, played: true }; first = false; return gate.promise; } }));
  const z = site._adopt(stubSlot(log, Z));
  site._adopt(stubSlot(log, W, { loop: { changing: true } }));
  const c = { ids: ['y', 'x', 'w', 'gone', 'z', 'y'], sender: 'Ex', sentence: '\\0hi\\e', refs: ['a'], age: '0', surface: '0\x0110', marker: '' };
  const starting = deferred();
  z._starting = starting.promise;                        // a ghost up and still starting (a resumed page): the talk waits for it
  const p = site._onCommunicate(x, { communicate: c, run: {} });
  await settle();
  assert.deepEqual(log, [], 'nothing before the ghosts up have started');
  z._starting = null;
  starting.resolve('booted');
  await settle();
  assert.deepEqual(log.map(e => e.slice(0, 2)), [['y', 'communicated']], 'one at a time: z waits for y\'s answer');
  assert.equal(log[0][2], c, 'the record as the loop made it');
  gate.resolve({ status: 200, played: true });
  await p;
  assert.deepEqual(log.map(e => e[0]), ['y', 'z', 'y'], 'x (the sender), w (changing ghosts) and an id not on screen skipped');
  // a ghost not up yet (a callee loading its engine) and the set's own start are not waited for (_upSettled): a start
  // that never ends must not hold the talks between the ghosts up
  log.length = 0;
  const callee = site._adopt(stubSlot(log, { id: 'v', name: 'Ghost V', sakuraName: 'Vee' }));
  callee._up = false;
  callee._starting = new Promise(() => {});
  site._starting = new Promise(() => {});
  const q = site._onCommunicate(x, { communicate: { ...c, ids: ['y', 'v'] } });
  await settle();
  assert.deepEqual(log.map(e => e.slice(0, 2)), [['y', 'communicated']], 'y at once; v is no target yet');
  await q;
  site._starting = null;
  // nothing to send
  log.length = 0;
  for (const ev of [{}, { communicate: null }, { communicate: { ids: [] } }, { communicate: { ids: 'y' } }]) await site._onCommunicate(x, ev);
  assert.deepEqual(log, []);
});

test('_onRaiseOther (several ghosts): GET or NOTIFY to each target with Sender = the raiser\'s sakura name; refusals and empty answers come back as one failure', async () => {
  const site = new Site({ Channel: null });
  const log = [];
  const x = site._adopt(stubSlot(log, X));
  site._adopt(stubSlot(log, Y));
  site._adopt(stubSlot(log, Z, { loop: { lockReason: 'passivemode' } }));
  site._adopt(stubSlot(log, W, { answer: (id, refs, o) => (o.notify ? { ok: true, status: 204 } : { ok: false, status: 204 }) }));
  site._adopt(stubSlot(log, { id: 'c', name: 'Ghost C', sakuraName: 'Cee' }, { loop: { changing: true } }));
  await site._onRaiseOther(x, { ghost: ALL_GHOSTS, id: 'OnTea', refs: ['紅茶', 'クッキー'] });
  assert.deepEqual(log, [
    ['y', 'raisedByOther', 'OnTea', ['紅茶', 'クッキー'], { notify: false, sender: 'Ex' }],
    ['w', 'raisedByOther', 'OnTea', ['紅茶', 'クッキー'], { notify: false, sender: 'Ex' }],
    ['x', 'notifyEvent', 'OnRaiseOtherFailure', ['passivemode\x01204', 'Zed\x01Dub', 'OnTea', '紅茶', 'クッキー'], FAIL],
  ], 'x skipped, z refused before any request, w\'s empty answer; c (changing ghosts) is no candidate');
  log.length = 0;
  await site._onRaiseOther(x, { ghost: ALL_GHOSTS, id: 'OnTea', refs: [], notify: true });
  assert.deepEqual(log.map(e => e.slice(0, 3)), [['y', 'raisedByOther', 'OnTea'], ['w', 'raisedByOther', 'OnTea'], ['x', 'notifyEvent', 'OnNotifyOtherFailure']]);
  assert.deepEqual(log[2][3], ['passivemode', 'Zed', 'OnTea'], 'notifyother: a refusal fails, an answer never');
  assert.equal(log[0][4].notify, true);
  // names: descript before sakura, never the kero name; a list keeps its order; only the failed ones are named
  log.length = 0;
  await site._onRaiseOther(x, { ghost: 'Ghost W\x01なと\x01ごはん\x01Cee', id: 'OnHi', refs: ['1', null, 2] });
  assert.deepEqual(log, [
    ['w', 'raisedByOther', 'OnHi', ['1', '', '2'], { notify: false, sender: 'Ex' }],
    ['y', 'raisedByOther', 'OnHi', ['1', '', '2'], { notify: false, sender: 'Ex' }],
    ['x', 'notifyEvent', 'OnRaiseOtherFailure', ['204', 'Dub', 'OnHi', '1', '', '2'], FAIL],
  ]);
  log.length = 0;
  await site._onRaiseOther(x, { ghost: 'ごはん\x01Cee', id: 'OnHi', refs: [] });
  assert.deepEqual(log, [['x', 'notifyEvent', 'OnRaiseOtherFailure', ['notfound', 'ごはん\x01Cee', 'OnHi'], FAIL]],
    'nobody found: the argument as given');
  log.length = 0;
  await site._onRaiseOther(x, { ghost: 'なと', id: 'OnHi', refs: [] });
  assert.deepEqual(log.map(e => e.slice(0, 2)), [['y', 'raisedByOther']], 'all went well: no failure event');
  // an empty event: invalid when the argument names a ghost (the raiser too), else notfound
  log.length = 0;
  await site._onRaiseOther(x, { ghost: 'なと', id: '' });
  await site._onRaiseOther(x, { ghost: 'Cee', id: '' });
  assert.deepEqual(log.map(e => e[3]), [['invalid', 'なと'], ['notfound', 'Cee']]);
  // random: the raiser (skipped) or another ghost, in set order
  log.length = 0;
  site._random = () => 0;
  await site._onRaiseOther(x, { ghost: 'random', id: 'OnHi' });
  assert.deepEqual(log, [], 'the raiser picked: nothing');
  site._random = () => 0.3;
  await site._onRaiseOther(x, { ghost: 'Random', id: 'OnHi' });
  assert.deepEqual(log.map(e => e.slice(0, 2)), [['y', 'raisedByOther']]);
});

test('_onRaiseOther: one page-wide FIFO once the ghosts up have started; a raiser closed or changed meanwhile still raises, its failure goes to the loop that asked', async () => {
  const site = new Site({ Channel: null });
  const log = [];
  const gate = deferred();
  const x = site._adopt(stubSlot(log, X));
  const y = site._adopt(stubSlot(log, Y, { answer: id => (id === 'OnSlow' ? gate.promise : { ok: true, status: 200 }) }));
  site._adopt(stubSlot(log, Z));
  // a resumed ghost (up from before its start) still starting: the raises wait for it (_upSettled)
  const resuming = site._adopt(stubSlot(log, { id: 'r', name: 'Ghost R', sakuraName: 'Arr' }));
  const starting = deferred();
  resuming._starting = starting.promise;
  const a = site._onRaiseOther(x, { ghost: 'なと', id: 'OnSlow' });
  const b = site._onRaiseOther(y, { ghost: 'Zed', id: 'OnNext' });
  const c = site._onRaiseOther(x, { ghost: 'Zed', id: 'OnLast' });
  await settle();
  assert.deepEqual(log, [], 'the starts of the ghosts up first');
  resuming._starting = null;
  starting.resolve('booted');
  await settle();
  assert.deepEqual(log.map(e => e.slice(0, 3)), [['y', 'raisedByOther', 'OnSlow']], 'the next raise waits for this one');
  gate.resolve({ ok: false, status: 204 });
  await Promise.all([a, b, c]);
  assert.deepEqual(log.map(e => e.slice(0, 3)), [
    ['y', 'raisedByOther', 'OnSlow'], ['x', 'notifyEvent', 'OnRaiseOtherFailure'],
    ['z', 'raisedByOther', 'OnNext'], ['z', 'raisedByOther', 'OnLast'],
  ], 'in the order asked, each with its failure event');
  assert.equal(log[2][4].sender, 'なと');

  // \![raiseother,…]\-: x closes and leaves the set before its raise runs; the raise still goes out
  log.length = 0;
  const xl = x.parts.loop;
  const hold = deferred();
  resuming._starting = hold.promise;
  const d1 = site._onRaiseOther(x, { ghost: 'Zed', id: 'OnBye' });
  const d2 = site._onRaiseOther(x, { ghost: 'nobody', id: 'OnBye2' });
  xl.closed = true;
  site.slots.splice(site.slots.indexOf(x), 1);
  resuming._starting = null;
  hold.resolve('booted');
  await Promise.all([d1, d2]);
  assert.deepEqual(log.map(e => e.slice(0, 3)), [['z', 'raisedByOther', 'OnBye'], ['x', 'notifyEvent', 'OnRaiseOtherFailure']],
    'the failure event goes to the closed loop (events.js notifyEvent drops it there)');
  assert.equal(log[0][4].sender, 'Ex', 'its sakura name from the loop that asked');
  // a ghost change in the raiser's slot after the tag: the new ghost never hears the old one's failure
  log.length = 0;
  const slot = site._adopt(stubSlot(log, W));
  const hold2 = deferred();
  resuming._starting = hold2.promise;
  const e = site._onRaiseOther(slot, { ghost: 'nobody', id: 'OnX' });
  slot.parts = stubSlot(log, { id: 'v', name: 'Ghost V', sakuraName: 'Vee' }).parts;
  slot.ghost = { id: 'v' };
  resuming._starting = null;
  hold2.resolve('booted');
  await e;
  assert.deepEqual(log, [['w', 'notifyEvent', 'OnRaiseOtherFailure', ['notfound', 'nobody', 'OnX'], FAIL]]);
  // the raiser's slot restarted (a new loop of the same ghost) after the tag: still the raiser, never raised
  log.length = 0;
  const hold3 = deferred();
  resuming._starting = hold3.promise;
  const r1 = site._onRaiseOther(y, { ghost: 'なと\x01Zed', id: 'OnSelf' });
  y.parts = stubSlot(log, Y).parts;
  resuming._starting = null;
  hold3.resolve('booted');
  await r1;
  assert.deepEqual(log.map(e => e.slice(0, 3)), [['z', 'raisedByOther', 'OnSelf']]);
  // a target that went while an earlier one answered is skipped
  log.length = 0;
  const gate2 = deferred();
  site.slots.length = 0;
  const p = site._adopt(stubSlot(log, X));
  site._adopt(stubSlot(log, Y, { answer: () => gate2.promise }));
  const q = site._adopt(stubSlot(log, Z));
  const f = site._onRaiseOther(p, { ghost: ALL_GHOSTS, id: 'OnAll' });
  await settle();
  q.parts.loop.closed = true;
  gate2.resolve({ ok: true, status: 200 });
  await f;
  assert.deepEqual(log.map(e => e.slice(0, 3)), [['y', 'raisedByOther', 'OnAll']], 'z closed meanwhile: skipped, no failure');
  // a ghost not up yet (a callee loading its engine) and the set's own start are not waited for: a start that never
  // ends must not hold every raise of the page
  log.length = 0;
  const callee = site._adopt(stubSlot(log, W));
  callee._up = false;
  callee._starting = new Promise(() => {});
  site._starting = new Promise(() => {});
  await site._onRaiseOther(p, { ghost: 'なと', id: 'OnNow' });
  await site._onRaiseOther(p, { ghost: 'Dub', id: 'OnNow' });
  assert.deepEqual(log.map(e => e.slice(0, 4)), [
    ['y', 'raisedByOther', 'OnNow', []], ['x', 'notifyEvent', 'OnRaiseOtherFailure', ['notfound', 'Dub', 'OnNow']],
  ], 'Dub is no candidate yet');
  site._starting = null;
  // a takeover's slot still waiting for its ghost lock (_runSet's _resuming, no _starting yet) is waited for
  log.length = 0;
  const taking = deferred();
  Object.assign(callee, { _up: true, _starting: null, _resuming: taking.promise });
  const t1 = site._onRaiseOther(p, { ghost: 'なと', id: 'OnLater' });
  await settle();
  assert.deepEqual(log, [], 'it waits for the takeover');
  callee._resuming = null;
  taking.resolve('booted');
  await t1;
  assert.deepEqual(log.map(e => e.slice(0, 3)), [['y', 'raisedByOther', 'OnLater']]);
});

test('_onRaiseOther: a repeating timer\'s fire is dropped when live() says its timer went; done() once the raise is over or dropped', async () => {
  const site = new Site({ Channel: null });
  const log = [];
  const x = site._adopt(stubSlot(log, X));
  site._adopt(stubSlot(log, Y));
  const done = [];
  let alive = true;
  await site._onRaiseOther(x, { ghost: 'なと', id: 'OnTick', refs: [], live: () => alive, done: () => done.push('a') });
  alive = false;
  await site._onRaiseOther(x, { ghost: 'なと', id: 'OnTick', refs: [], live: () => alive, done: () => done.push('b') });
  assert.deepEqual(log.map(e => e.slice(0, 3)), [['y', 'raisedByOther', 'OnTick']], 'the second is dropped');
  assert.deepEqual(done, ['a', 'b']);
  // a raise that throws still calls done()
  await site._onRaiseOther(x, { ghost: 'なと', id: 'OnTick', refs: [], live: () => { throw new Error('x'); }, done: () => done.push('c') });
  assert.deepEqual(done, ['a', 'b', 'c']);
});

test('_peerOf: a slot without a loop shows its stored names in effect, else its index entry\'s names, the kero name too', () => {
  const site = new Site({ Channel: null });
  const rt = { ghost: { id: 'k', name: 'Katari', sakuraName: 'カタリ', keroName: '謎の装置' }, state: { data: { stage: { scopes: { 0: { surface: 3 } } } } } };
  assert.deepEqual(site._peerOf(rt), { id: 'k', name: 'Katari', sakuraName: 'カタリ', keroName: '謎の装置', surfaces: [3, -1], shell: '' });
  assert.equal(site._peerOf({ ghost: { id: 'r' } }).keroName, '', 'the ghost names no kero');
  // the names its loop had when its state was stored (a shell's sakura.name / kero.name, `none` too: EV §2.7.5)
  rt.state.data.names = { sakura: 'none', kero: '' };
  assert.deepEqual([site._peerOf(rt).sakuraName, site._peerOf(rt).keroName], ['none', '']);
});

test('Runtime wiring: its loop\'s \'communicate\' and \'raiseother\' reach the Site while that loop is the running one', async () => {
  const w = world();
  const got = [];
  class WireSite extends TestSite {
    _onCommunicate(rt, ev) { got.push(['communicate', rt, ev]); return Promise.resolve(); }
    _onRaiseOther(rt, ev) { got.push(['raiseother', rt, ev]); return Promise.resolve(); }
  }
  const site = new WireSite(w);
  assert.equal(await site.start(), 'booted');
  const rt = site.slots[0];
  rt.player.finish();
  const comm = { communicate: { ids: ['y'], sender: 'Tsubasa', sentence: 'hi', refs: [], age: '0', surface: '0\x0110', marker: '' }, run: {} };
  const raise = { ghost: 'Ex', id: 'OnTea', refs: ['a'], notify: false };
  rt.loop.emit('communicate', comm);
  rt.loop.emit('raiseother', raise);
  rt.loop.emit('raiseother');
  assert.deepEqual(got, [['communicate', rt, comm], ['raiseother', rt, raise], ['raiseother', rt, {}]]);
  const old = rt.loop;
  rt._teardown();
  old.emit('raiseother', raise);
  old.emit('communicate', comm);
  assert.equal(got.length, 3, 'a torn-down loop is heard no more');
  rt.done();
});

test('Runtime wiring: a %ms-style word the ghost does not answer comes from the Site\'s word list (compatibleWords, properties.md §2.4)', async () => {
  const w = world();
  let asked = 0;
  class WordSite extends TestSite {
    compatibleWords() { asked++; return Promise.resolve([{ name: 'ms', words: ['鈴木'] }]); }
  }
  const site = new WordSite(w);
  assert.equal(await site.start(), 'booted');
  const rt = site.slots[0];
  rt.player.finish();
  assert.equal(await rt.loop.expand('%ms/%mz'), '鈴木/%mz');
  assert.deepEqual(w.engines[0].ids().filter(x => /\\m/.test(x)), ['GET \\ms', 'GET \\mz', 'GET \\mz'], 'the ghost first (204)');
  assert.equal(asked, 3, 'the loop asks the Site each time; the Site keeps what it read (compatibleWords)');
  rt.done();
});

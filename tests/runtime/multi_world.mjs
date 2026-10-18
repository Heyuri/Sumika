// The synthetic site of several ghosts that multi.test.mjs and interact.test.mjs run on: the lead
// Site main.js builds, with fake engines and views (real headless Stages on synthetic shells for the ghosts in
// w.shells). Four Satori ghosts (x, y, z, w) and a Misaka one (mm, whose engine is missing); every request of every
// engine goes into one order log; invariants() checks the set after every step. A ghost's `descript`
// ([[key, value], …]) adds to its descript.txt.
import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../../src/core/site.js';
import { Runtime } from '../../src/core/runtime.js';
import { UiLanguage } from '../../src/core/language.js';
import { GhostLock, memoryStorage, runtimePrefs, sessionMarker } from '../../src/core/state.js';
import { LEAD_ID, MAX_GHOSTS, markerGhosts } from '../../src/core/ghostset.js';
import { FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';
import { sizedStage } from '../shell/helpers.mjs';

export const ghost = (id, o = {}) => ({
  id, name: `Ghost ${id.toUpperCase()}`, sakuraName: `${id.toUpperCase()}s`, keroName: '', shiori: 'satori.dll', engine: 'satori',
  thumbnails: [], shells: [{ id: 'master', name: `${id}-shell` }], defaultShell: 'master', bundledBalloons: [], balloon: null, ...o,
});
export const GHOSTS = [ghost('x'), ghost('y'), ghost('z'), ghost('w'), ghost('mm', { name: 'Misaka', shiori: 'misaka.dll', engine: 'misaka' })];

export function siteIndex(ghosts = GHOSTS) {
  return { base: 'http://s/', ghosts, balloons: [], ghost: id => ghosts.find(g => g.id === id) || null, balloon: () => null };
}

// ---------------------------------------------------------------- the browser around the pages (copied from switch.test.mjs)

export class FakeLocks {
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
export function busChannel(log = null) {
  const all = new Set();
  return class {
    constructor(name) { this.name = name; this.onmessage = null; all.add(this); }
    postMessage(data) {
      const msg = structuredClone(data);
      if (log) log.push(msg);
      for (const c of all) if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage && c.onmessage({ data: msg }));
    }
    close() { all.delete(this); }
  };
}

/** A document or window stand-in: listeners per type, fire(type). */
export function fakeTarget(extra = {}) {
  const l = new Map();
  return {
    ...extra,
    addEventListener(t, f) { if (!l.has(t)) l.set(t, new Set()); l.get(t).add(f); },
    removeEventListener(t, f) { const s = l.get(t); if (s) s.delete(f); },
    fire(t, ev) { for (const f of [...(l.get(t) || [])]) f(ev); },
    count(t) { return (l.get(t) || new Set()).size; },
  };
}

export function defaultAnswer(id, r, mem) {
  switch (r.id) {
    case 'OnBoot': return `\\0${id}: boot\\e`;
    case 'OnFirstBoot': return `\\0${id}: first\\e`;
    case 'OnGhostCalling': return `\\0${id}: calling ${r.refs[0]}\\e`;
    case 'OnGhostCalled': return `\\0${id}: called by ${r.refs[0]}\\e`;
    case 'OnGhostChanging': return `\\0${id}: bye, ${r.refs[0]}\\e`;
    case 'OnGhostChanged': return `\\0${id}: from ${r.refs[0]}\\e`;
    case 'OnClose': return `\\0${id}: bye\\-`;
    default: return null;
  }
}

/**
 * The browser: localStorage shared by the tabs, sessionStorage per tab (here per world unless a test makes a new one),
 * Web Locks, the lock and site channels, the engines' saves; `order`: every request of every engine, in order.
 */
export function world({ ghosts = GHOSTS, answer = defaultAnswer, failEngine = () => false } = {}) {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  const posts = [];
  return {
    index: siteIndex(ghosts), locks: new FakeLocks(), Channel: busChannel(posts), LockBus: busChannel(), posts,
    saves: new Map(), engines: [], order: [], answer, failEngine, hold: {}, stages: [],
  };
}

export class GhostShiori extends FakeShiori {
  constructor(w, id, handler) { super(handler); this.w = w; this.ghost = id; }
  request(r) { this.w.order.push(`${this.ghost} ${r.method || 'GET'} ${r.id}`); return super.request(r); }
}

const LIVE = new Set();
afterEach(() => { for (const x of [...LIVE]) x.done(); });

export class TestRuntime extends Runtime {
  constructor(w, o = {}) {
    super({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', defaultGhost: 'x', Channel: w.Channel, ...o });
    this.w = w;
    this.players = [];
  }
  _doc() { return this.site._doc(); }
  _newLock(id) { return new GhostLock(id, { locks: this.w.locks, Channel: this.w.LockBus }); }
  async _ghostCommon() {
    const g = this.ghost;
    if (this.site.hold && this.site.hold[g.id]) await this.site.hold[g.id];      // this tab is slow to load g's files
    const files = { url: p => `http://s/ghost/${g.id}/${p}`, has: () => false, list: () => [] };
    const ghostDescript = new Map([['name', g.name], ['sakura.name', g.sakuraName], ...(g.descript || [])]);
    return { files, ghostDescript, shellId: 'master' };
  }
  async _startEngine(files, { resume, bootEpochMs, sessionEndMs = 0 }) {
    const g = this.ghost;
    if (this.w.hold[g.id]) await this.w.hold[g.id];
    if (this.w.failEngine(g.id)) throw new Error(`no engine for ${g.id}`);
    const hadSave = this.w.saves.has(g.id);
    const mem = { ...(this.w.saves.get(g.id) || {}) };
    const sh = new GhostShiori(this.w, g.id, r => this.w.answer(g.id, r, mem));
    Object.assign(sh, { resume, bootEpochMs, sessionEndMs, hadSave });
    sh.terminate = () => { sh.terminated = true; };
    sh.unload = async () => { sh.unloaded = true; this.w.saves.set(g.id, { ...mem }); return []; };
    sh.persist = async () => { if (this.w.persistGate && g.id === this.w.persistGate.id) await this.w.persistGate.promise; sh.persisted++; this.w.saves.set(g.id, { ...mem }); return []; };
    this.w.engines.push(sh);
    return { client: sh, r: { hadSave } };
  }
  async _createStage(opts) {
    const sizes = this.w.shells && this.w.shells[this.ghost.id];
    if (sizes) {      // a real headless Stage on a synthetic shell of these surface sizes (placement)
      const s = await sizedStage({ sizes, state: opts.state, ghostDescript: opts.ghostDescript, desk: this.w.desk });
      this.w.stages.push({ rt: this, s });
      return s;
    }
    const s = new FakeStage();
    s.destroy = () => { s.destroyed = true; };
    s.defaultSurface = x => (x === 0 ? 0 : 10);
    this.w.stages.push({ rt: this, s });
    return s;
  }
  async _loadSkin() { return { skin: { balloon: () => null }, name: '', path: '' }; }
  async _createBalloons() { return new FakeBalloons(); }
  _createDialogs() { return new FakeDialogs(); }
  _createPlayer() { const p = new FakePlayer(); this.players.push(p); return p; }
  get loop() { return this.parts && this.parts.loop; }
  get player() { return this.players[this.players.length - 1]; }
  done() {
    this._teardown();
    this._clearFrozen();
    if (this.lock) this.lock.dispose();
  }
}

/**
 * main.js's Site (lead lock, several ghosts) with TestRuntime slots, a tab's document and window. phone / tucked: a
 * phone page's (core/phone.js; UI §9.11); Runtime: the slots' class (a TestRuntime subclass).
 */
export class TestSite extends Site {
  constructor(w, { hidden = false, maxGhosts = MAX_GHOSTS, phone = null, tucked = false, Runtime: R = TestRuntime } = {}) {
    super({
      base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', defaultGhost: 'x', Channel: w.Channel,
      language: new UiLanguage({ navigator: { languages: ['en-US'] } }), lead: true, maxGhosts, phone, tucked,
      createRuntime: o => new R(w, o),
    });
    this.w = w;
    this.doc = fakeTarget({ hidden });
    this.win = fakeTarget();
    this.hold = {};             // ghost id -> a promise this tab's _ghostCommon waits for (its files load slowly)
    this.index = w.index;
    this._installPageHooks(this.win);
    LIVE.add(this);
  }
  _doc() { return this.doc; }
  _newLeadLock() { return new GhostLock(LEAD_ID, { locks: this.w.locks, Channel: this.w.LockBus }); }
  /** the visitor turns to (true) or away from (false) this tab */
  show(on) { this.doc.hidden = !on; this.doc.fire('visibilitychange'); }
  done() {
    LIVE.delete(this);
    for (const rt of [...this.slots]) rt.done();
    if (this.lead) this.lead.dispose();
    if (this._channel) this._channel.close();
  }
}

export const loopOf = rt => rt && rt.parts && rt.parts.loop;
export const eng = (w, id) => w.engines.filter(e => e.ghost === id).at(-1);
export const live = w => w.engines.filter(e => !e.terminated && !e.unloaded).map(e => e.ghost).sort();
export const ids = site => site.slots.map(rt => rt.ghost && rt.ghost.id);
export const events = (sh, re) => sh.ids().filter(x => re.test(x));

/** The set's changes (calls, ghost changes) have all run. */
export async function idle(site) {
  for (let i = 0; i < 50 && (site._tail || site._starting); i++) { await (site._tail || site._starting); await settle(); }
  await settle();
}

/** Until f() or 60 rounds. */
export async function until(f) { for (let i = 0; i < 60 && !f(); i++) await settle(); return !!f(); }

/** \- reached in rt's playing script (what ScriptPlayer reports). */
export function quitRun(rt) { rt.player.busy = false; rt.player.cur.resolve({ reason: 'quit', hasChoices: false }); }

/** A tab of the site, started and quiet (every boot run finished). */
export async function up(w, o = {}, expect = 'booted') {
  const site = new TestSite(w, o);
  assert.equal(await site.start(), expect);
  await settle();
  for (const rt of site.slots) if (rt.player && rt.player.busy) rt.player.finish();
  await settle();
  return site;
}

/** Call ghost ▸ id from rt's menu, every OnGhostCalling talk played to its end once the callee booted. */
export async function menuCall(site, rt, id) {
  rt.parts.menu._run({ type: 'callghost', id }, 0);
  await idle(site);
}

/**
 * After every step: the lead ⇔ a ghost lock; every running slot holds its ghost lock; the stored set is the
 * slots' (not during Quit or after the site closed); the marker lists every booted slot; one layer per slot; at most
 * one ghost with the keys; at most maxGhosts slots.
 */
export function invariants(site, w) {
  const running = site.slots.filter(rt => loopOf(rt) && !loopOf(rt).closed);
  for (const rt of running) assert.ok(w.locks.held.has(`sumika:${rt.ghost.id}`), `${rt.ghost.id} runs and holds its lock`);
  const leadHeld = !!(site.lead && site.lead.held);
  assert.equal(leadHeld, site.slots.some(rt => rt.lock && rt.lock.held), 'the lead is held exactly when a ghost lock is');
  if (running.length && !site.quitting) {
    assert.deepEqual(runtimePrefs.get().ghosts, ids(site), 'the stored set is the slots\'');
    assert.equal(runtimePrefs.get().ghost, ids(site)[0]);
  }
  const marked = markerGhosts(sessionMarker.read());
  for (const rt of running) if (loopOf(rt).booted) assert.ok(marked.includes(rt.ghost.id), `the marker lists ${rt.ghost.id}`);
  assert.deepEqual(site.layers.order().slice().sort(), site.slots.filter(rt => rt.ghost).map(rt => rt.sid).sort(), 'one layer per slot');
  assert.ok(site.slots.filter(rt => loopOf(rt) && loopOf(rt).active).length <= 1, 'one ghost with the keys');
  assert.ok(site.slots.length <= site.maxGhosts);
}

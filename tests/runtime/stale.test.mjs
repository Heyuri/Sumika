// Site.staleCheck (safe updates; CONTRACTS "Site"): a page older than the published build reloads into it, at
// most once per tab per build, and only once the new bundle is in hand. Its steps on a plain Site with a fake host
// (sumika/build.json and the bundle), session storage, clock and reload; then its triggers on main.js's lead Site
// (multi_world.mjs, the slots' engines through the real Runtime._startEngine): an engine start that fails, an index
// newer than the runtime, a newer stored state or runtime prefs, a prefs write refused while the page runs. A true
// answer never lets the failed start go on, so the stored set, the tab marker and its carries stay for the next page,
// which resumes (or finishes the call or change) from them. No real network: every fetch is the test's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Site, RELOADED_KEY, STALE_RECHECK_MS } from '../../src/core/site.js';
import { Runtime } from '../../src/core/runtime.js';
import { runtimePrefs, sessionMarker, SESSION_KEY, RUNTIME_KEY, stateKey } from '../../src/core/state.js';
import { markerCarry, markerGhosts } from '../../src/core/ghostset.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeClock, settle } from './fakes.mjs';
import { world, TestSite, TestRuntime, GhostShiori, loopOf, eng, ids, events, until, up } from './multi_world.mjs';

setLogLevel('silent');

const TABLE = {
  worker: 'engines/worker.0123456789.js',
  engines: { satori: { js: 'engines/satori.1111111111.js', wasm: 'engines/satori.2222222222.wasm' } },
};
const OLD = '0123456789ab';         // the build this page runs
const NEW = 'ba9876543210';         // the build the site publishes
const BUILD_JSON = 'http://s/sumika/build.json';
const BUNDLE = 'http://s/sumika/sumika.js';
const BOOT = /On(Boot|FirstBoot|GhostCalled|GhostChanged)$/;
const OTHER = /On(GhostCallComplete|OtherGhost\w+)$/;

/**
 * The host as staleCheck's fetch sees it: build.json names `build` (or `buildJson()` answers), the bundle holds the
 * published build (or `bundle()` answers). Every fetch is recorded as [url, cache].
 */
function host({ build = NEW } = {}) {
  const h = { calls: [], build, buildJson: null, bundle: null };
  h.fetch = async (url, init = {}) => {
    const u = String(url);
    h.calls.push([u, init.cache]);
    if (u === BUILD_JSON) return h.buildJson ? h.buildJson() : new Response(JSON.stringify({ format: 1, build: h.build }), { status: 200 });
    if (u === BUNDLE) return h.bundle ? h.bundle() : new Response(`(()=>{"use strict";var BUILD="${h.build}";})();`, { status: 200 });
    return new Response('', { status: 404 });
  };
  return h;
}

/** sessionStorage as storage.js `session` gives it; `drop`: site data blocked (writes vanish). */
function sessionStore({ drop = false } = {}) {
  const m = new Map();
  return { m, get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { if (!drop) m.set(k, String(v)); }, remove: k => { m.delete(k); } };
}

/** A Site with the build's table and staleCheck's options (no ghost: staleCheck needs none). */
function plainSite(h, { session = sessionStore(), clock = new FakeClock(), build = OLD, runtimeFiles = TABLE } = {}) {
  const reloads = [];
  const site = new Site({
    base: 'http://s/', runtimeUrl: BUNDLE, Channel: null, lead: false, maxGhosts: 1,
    runtimeFiles, build, fetch: h.fetch, reload: () => reloads.push(build), session, clock,
  });
  return Object.assign(site, { reloads, session, clock });
}

// ---------------------------------------------------------------- the steps

test('a page on an older build: build.json (no-cache), then the bundle again (reload) holding the published build, then reload() once; the guard holds this build', async () => {
  const h = host();
  const site = plainSite(h);
  assert.equal(await site.staleCheck('engine'), true);
  assert.deepEqual(h.calls, [[BUILD_JSON, 'no-cache'], [BUNDLE, 'reload']]);
  assert.deepEqual(site.reloads, [OLD]);
  assert.equal(site.session.get(RELOADED_KEY), OLD);

  // a true answer stands for the page: no fetch, no second reload
  assert.equal(await site.staleCheck('state'), true);
  assert.equal(h.calls.length, 2);
  assert.equal(site.reloads.length, 1);

  // the next page of the tab still runs the old build (the script came from a cache that kept it): no second reload
  const again = plainSite(h, { session: site.session });
  assert.equal(await again.staleCheck('engine'), false);
  assert.deepEqual(again.reloads, []);
  assert.deepEqual(h.calls.slice(2), [[BUILD_JSON, 'no-cache']], 'no bundle fetched');

  // that tab, once on the new build, recovers from a later one once more
  h.build = 'c0ffee000000';
  const later = plainSite(h, { session: site.session, build: NEW });
  assert.equal(await later.staleCheck('engine'), true);
  assert.deepEqual(later.reloads, [NEW]);
  assert.equal(later.session.get(RELOADED_KEY), NEW);
});

test('no reload, the answer false: build.json names this build; it is missing, HTML, unreachable or names none; the guard does not read back; the bundle fetched again fails, is not ok or still the old one; reload() throws', async () => {
  const cases = {
    'the same build': h => { h.build = OLD; },
    'build.json 404': h => { h.buildJson = () => new Response('not found', { status: 404 }); },
    'an HTML page (a host\'s fallback)': h => { h.buildJson = () => new Response('<!doctype html><title>x</title>', { status: 200 }); },
    'the network failed': h => { h.buildJson = () => { throw new TypeError('Failed to fetch'); }; },
    'no build in it': h => { h.buildJson = () => new Response(JSON.stringify({ format: 1 }), { status: 200 }); },
    'a build that is no string': h => { h.buildJson = () => new Response(JSON.stringify({ build: 12 }), { status: 200 }); },
    'the bundle fetch rejects': h => { h.bundle = () => { throw new TypeError('Failed to fetch'); }; },
    'the bundle answers 503': h => { h.bundle = () => new Response(`var BUILD="${NEW}";`, { status: 503 }); },
    'the host still serves the old bundle': h => { h.bundle = () => new Response(`var BUILD="${OLD}";`, { status: 200 }); },
  };
  for (const [what, set] of Object.entries(cases)) {
    const h = host();
    set(h);
    const site = plainSite(h);
    assert.equal(await site.staleCheck('engine'), false, what);
    assert.deepEqual(site.reloads, [], what);
    assert.equal(site.session.get(RELOADED_KEY), null, `${what}: no guard left (nothing was reloaded)`);
    const bundleAsked = h.calls.some(([u]) => u === BUNDLE);
    assert.equal(bundleAsked, /bundle|old bundle/.test(what), `${what}: the bundle is fetched only once build.json names another build`);
  }

  // site data blocked: the guard cannot be read back, so a reload could repeat: none, and no bundle download
  const blocked = host();
  const b = plainSite(blocked, { session: sessionStore({ drop: true }) });
  assert.equal(await b.staleCheck('engine'), false);
  assert.deepEqual(b.reloads, []);
  assert.deepEqual(blocked.calls, [[BUILD_JSON, 'no-cache']]);

  // a guard from an earlier build stays as it was when the bundle cannot be had
  const h2 = host();
  h2.bundle = () => new Response('', { status: 500 });
  const s2 = plainSite(h2);
  s2.session.set(RELOADED_KEY, 'aaaaaaaaaaaa');
  assert.equal(await s2.staleCheck('engine'), false);
  assert.equal(s2.session.get(RELOADED_KEY), 'aaaaaaaaaaaa');

  // reload() throws: false
  const h3 = host();
  const s3 = new Site({ base: 'http://s/', runtimeUrl: BUNDLE, Channel: null, lead: false, maxGhosts: 1, runtimeFiles: TABLE, build: OLD,
    fetch: h3.fetch, reload: () => { throw new Error('blocked'); }, session: sessionStore(), clock: new FakeClock() });
  assert.equal(await s3.staleCheck('engine'), false);

  // no table (unbundled: tests, site/dev): never, and nothing fetched
  const h4 = host();
  const s4 = plainSite(h4, { runtimeFiles: null });
  assert.equal(await s4.staleCheck('engine'), false);
  assert.deepEqual(h4.calls, []);
  const dflt = new Site({ base: 'http://s/', runtimeUrl: BUNDLE, Channel: null, lead: false, maxGhosts: 1, fetch: h4.fetch });
  assert.equal(dflt.runtimeFiles, null, 'FILES is null unbundled');
  assert.equal(await dflt.staleCheck('engine'), false);
  assert.deepEqual(h4.calls, []);
});

test('one answer for a burst: concurrent checks fetch build.json once; a false answer stands for STALE_RECHECK_MS, then a check asks again (a later update recovers)', async () => {
  const h = host({ build: OLD });
  const site = plainSite(h);
  const answers = await Promise.all([site.staleCheck('engine'), site.staleCheck('engine'), site.staleCheck('index-newer')]);
  assert.deepEqual(answers, [false, false, false]);
  assert.deepEqual(h.calls, [[BUILD_JSON, 'no-cache']]);

  h.build = NEW;                                       // the site is updated meanwhile
  site.clock.t += STALE_RECHECK_MS - 1;
  assert.equal(await site.staleCheck('engine'), false, 'within 5 minutes: the kept answer');
  assert.equal(h.calls.length, 1);
  site.clock.t += 1;
  assert.equal(await site.staleCheck('engine'), true, 'then asked again');
  assert.deepEqual(h.calls.slice(1), [[BUILD_JSON, 'no-cache'], [BUNDLE, 'reload']]);
  assert.deepEqual(site.reloads, [OLD]);
  assert.equal(STALE_RECHECK_MS, 5 * 60 * 1000);
});

test('a newer stored record while build.json names this very build: a rollback across a stored-data version, logged once; an engine failure is not', async () => {
  const warned = [];
  const saved = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  setLogLevel('warn');
  try {
    const site = plainSite(host({ build: OLD }));
    assert.equal(await site.staleCheck('engine'), false);
    assert.equal(warned.filter(t => /newer than the published Sumika/.test(t)).length, 0);
    assert.equal(await site.staleCheck('state'), false);
    assert.equal(await site.staleCheck('prefs'), false);
    assert.equal(warned.filter(t => /newer than the published Sumika/.test(t)).length, 1);
  } finally {
    console.warn = saved;
    setLogLevel('silent');
  }
});

// ---------------------------------------------------------------- the triggers, on the lead Site

/**
 * A slot whose engine comes through the real Runtime._startEngine (its catch asks staleCheck): _client() is the
 * world's engine, whose start() fails while w.failEngine says so.
 */
class StaleRuntime extends TestRuntime {
  _startEngine(files, o) { return Runtime.prototype._startEngine.call(this, files, o); }
  async _engineStartOptions(files, o) { return { engine: this.ghost.engine || 'satori', ...o }; }
  _client() {
    const w = this.w;
    const g = this.ghost;
    const mem = { ...(w.saves.get(g.id) || {}) };
    const sh = new GhostShiori(w, g.id, r => w.answer(g.id, r, mem));
    sh.terminate = () => { sh.terminated = true; };
    sh.unload = async () => { sh.unloaded = true; w.saves.set(g.id, { ...mem }); return []; };
    sh.persist = async () => { sh.persisted++; w.saves.set(g.id, { ...mem }); return []; };
    sh.start = async () => {
      if (w.failEngine(g.id)) throw new Error(`worker: ${g.id}'s engine file is gone`);
      const hadSave = w.saves.has(g.id);
      w.engines.push(sh);
      return { ok: true, hadSave, ms: 1 };
    };
    return sh;
  }
}

/** main.js's Site running build OLD with the table, against host h (staleCheck's fetch and reload). */
class StaleSite extends TestSite {
  constructor(w, h, o = {}) {
    super(w, { Runtime: StaleRuntime, ...o });
    // the Site options TestSite does not pass on (sessionStorage is the world's, as storage.js reads it)
    Object.assign(this, { runtimeFiles: TABLE, build: OLD, _fetch: h.fetch, _reload: () => { this.reloads++; } });
    this.reloads = 0;
  }
}

/** A slot whose ghosts in w.viaIndex load their files through the real Runtime._ghostCommon (the index's ghostFiles). */
class IndexRuntime extends StaleRuntime {
  _ghostCommon() {
    return this.w.viaIndex && this.w.viaIndex.has(this.ghost.id) ? Runtime.prototype._ghostCommon.call(this) : super._ghostCommon();
  }
}

/** A StaleSite started and quiet (every boot run finished). */
async function upStale(w, h, o = {}) {
  const site = new StaleSite(w, h, o);
  assert.equal(await site.start(), 'booted');
  await settle();
  for (const rt of site.slots) if (rt.player && rt.player.busy) rt.player.finish();
  await settle();
  return site;
}

/** p's outcome so far: 'pending' until it settles. */
function watch(p) {
  const s = { out: 'pending' };
  p.then(v => { s.out = v; }, e => { s.out = e; });
  return s;
}

/** A ghost change in rt's slot, its farewell played to its end (as multi.test.mjs). */
async function changeIn(rt, id) {
  const leaving = rt.loop;
  const p = rt.changeGhost(id);
  await until(() => leaving.current && leaving.current.event === 'OnGhostChanging');
  if (rt.player.busy) rt.player.finish();
  return p;
}

/** The last page goes (pagehide) and is gone. */
async function leave(site) {
  site._onPageHide();
  site.done();
  await settle();
}

test('a resumed set {x, y} whose y engine fails on an older build: one reload; the start never settles, so the set, the marker and x\'s view of the others stay; the next page resumes both', async () => {
  const w = world();
  for (const id of ['x', 'y']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  await leave(await up(w));
  const prefs = localStorage.getItem(RUNTIME_KEY);
  const marker = sessionMarker.read();
  assert.deepEqual(markerGhosts(marker), ['x', 'y']);

  w.failEngine = id => id === 'y';
  const h = host();
  const site = new StaleSite(w, h);
  const started = watch(site.start());
  await until(() => site.reloads === 1);
  await settle();
  assert.equal(site.reloads, 1);
  assert.deepEqual(h.calls, [[BUILD_JSON, 'no-cache'], [BUNDLE, 'reload']], 'build.json, then the bundle, then the reload');
  assert.equal(sessionStorage.getItem(RELOADED_KEY), OLD);
  assert.equal(started.out, 'pending', 'the failed start never goes on');
  assert.deepEqual(ids(site), ['x', 'y'], 'y keeps its slot (no _afterStart removal)');
  assert.equal(localStorage.getItem(RUNTIME_KEY), prefs, 'the stored set as it was');
  assert.deepEqual(sessionMarker.read(), marker, 'the tab marker as it was');
  const ex = eng(w, 'x');
  assert.ok(loopOf(site.slots[0]) && loopOf(site.slots[0]).booted, 'x runs');
  assert.deepEqual(events(ex, OTHER), [], 'x hears of no ghost gone');
  assert.ok(ex.find('otherghostname').every(r => r.refs.length && r.refs[0].startsWith('Ys\x01')), 'x is never told y went');

  // a second failure in the same build (x's engine crashes, its restart fails too): no second reload
  w.failEngine = () => true;
  const crash = watch(site.slots[0]._onCrash());
  await settle();
  assert.equal(site.reloads, 1);
  assert.equal(crash.out, 'pending');
  assert.equal(h.calls.length, 2, 'the true answer stands: nothing fetched again');

  // the reloaded page (the published build: here an unbundled TestSite) resumes the same set
  await leave(site);
  w.failEngine = () => false;
  const next = await up(w);
  assert.deepEqual(ids(next), ['x', 'y']);
  assert.deepEqual(next.slots.map(rt => events(eng(w, rt.ghost.id), BOOT)), [[], []], 'both resumed, no boot event');
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y']);
});

test('the same failure when build.json names this build: no reload, and the ghost fails (it leaves the set)', async () => {
  const w = world();
  for (const id of ['x', 'y']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  await leave(await up(w));
  w.failEngine = id => id === 'y';
  const h = host({ build: OLD });
  const site = await upStale(w, h);
  assert.equal(site.reloads, 0);
  assert.deepEqual(h.calls, [[BUILD_JSON, 'no-cache']]);
  assert.deepEqual(ids(site), ['x']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x']);
  assert.equal(sessionStorage.getItem(RELOADED_KEY), null);
});

test('a call whose callee fails on an older build: one reload; the call\'s carry stays in the marker and the set keeps the callee; the next page boots it with OnGhostCalled', async () => {
  const w = world();
  w.saves.set('y', {});
  const h = host();
  const site = await upStale(w, h);
  const x = site.slots[0];
  w.failEngine = id => id === 'y';
  const posts = w.posts.length;
  const call = watch(site.callGhost('y'));
  await until(() => site.reloads === 1);
  await settle();
  assert.equal(call.out, 'pending');
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y'], 'stored with the callee, as before its start');
  const carry = markerCarry(sessionMarker.read()).y;
  assert.equal(carry && carry.kind, 'call', 'the marker carries the call');
  assert.deepEqual(w.posts.slice(posts).map(m => m.cause && m.cause.kind), ['call'], 'no sync without the callee');
  assert.deepEqual(ids(site), ['x', 'y'], 'the callee\'s slot stays');
  assert.ok(loopOf(x) && loopOf(x).booted && !loopOf(x).closed);

  await leave(site);
  w.failEngine = () => false;
  const next = await up(w);
  assert.deepEqual(ids(next), ['x', 'y']);
  assert.deepEqual(events(eng(w, 'y'), BOOT), ['GET OnGhostCalled'], 'the next page finishes the call');
});

test('a ghost change whose new ghost fails on an older build: one reload; the old ghost is not brought back; the next page boots the new one with OnGhostChanged', async () => {
  const w = world();
  w.saves.set('z', {});
  const h = host();
  const site = await upStale(w, h);
  const x = site.slots[0];
  w.failEngine = id => id === 'z';
  const changed = watch(changeIn(x, 'z'));
  await until(() => site.reloads === 1);
  await settle();
  assert.equal(changed.out, 'pending', 'the change never ends');
  assert.equal(w.engines.filter(e => e.ghost === 'x').length, 1, 'x was unloaded and is not started again');
  assert.deepEqual(runtimePrefs.get().ghosts, ['z'], 'the stored set names the new ghost');
  const carry = markerCarry(sessionMarker.read()).z;
  assert.equal(carry && carry.kind, 'change', 'the marker carries the change');

  await leave(site);
  w.failEngine = () => false;
  const next = await up(w);
  assert.deepEqual(ids(next), ['z']);
  assert.deepEqual(events(eng(w, 'z'), BOOT), ['GET OnGhostChanged']);
  assert.equal(eng(w, 'z').find('OnGhostChanged')[0].refs[0], 'Xs', 'from x');
});

test('an index newer than this runtime (index-newer): one reload, and no ghost starts; with a false answer the start fails', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), 'http://s/sumika/index/ghosts.json');
    return new Response(JSON.stringify({ format: 3, ghosts: [], balloons: [] }), { status: 200 });
  };
  try {
    const w = world();
    const h = host();
    const site = new StaleSite(w, h);
    site.index = null;                                     // read from the host
    const started = watch(site.start());
    await until(() => site.reloads === 1);
    await settle();
    assert.equal(started.out, 'pending');
    assert.equal(w.engines.length, 0);
    assert.equal(site.index, null);

    const w2 = world();
    const h2 = host({ build: OLD });
    const s2 = new StaleSite(w2, h2);
    s2.index = null;
    assert.equal(await s2.start(), 'failed');
    assert.equal(s2.reloads, 0);
    assert.equal(w2.engines.length, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test('a callee whose manifest is gone and whose index read again is newer than this runtime: one reload, the call never settles and its carry stays; with a false answer the call fails', async () => {
  for (const build of [NEW, OLD]) {
    const w = world();
    w.saves.set('y', {});
    w.viaIndex = new Set(['y']);
    const asked = [];
    w.index.ghostFiles = async id => {        // loader.js _files: the manifest gone, the re-read index format 3
      asked.push(id);
      throw Object.assign(new Error('sumika: the site index is format 3; this runtime reads up to 2'), { code: 'index-newer' });
    };
    const h = host({ build });
    const site = await upStale(w, h, { Runtime: IndexRuntime });
    const call = watch(site.callGhost('y'));
    await until(() => site.reloads === 1 || call.out !== 'pending');
    await settle();
    assert.deepEqual(asked, ['y']);
    assert.equal(w.engines.filter(e => e.ghost === 'y').length, 0, `${build}: no engine for y`);
    if (build === NEW) {
      assert.equal(site.reloads, 1);
      assert.deepEqual(h.calls, [[BUILD_JSON, 'no-cache'], [BUNDLE, 'reload']]);
      assert.equal(call.out, 'pending', 'the call never goes on');
      assert.equal(markerCarry(sessionMarker.read()).y?.kind, 'call', 'the marker carries the call');
      assert.deepEqual(ids(site), ['x', 'y'], 'the callee\'s slot stays');
    } else {
      assert.equal(site.reloads, 0);
      assert.deepEqual(h.calls, [[BUILD_JSON, 'no-cache']]);
      assert.notEqual(call.out, 'pending');
      assert.deepEqual(ids(site), ['x'], 'the call failed');
      assert.deepEqual(runtimePrefs.get().ghosts, ['x']);
    }
    site.done();
  }
});

test('a newer stored state (Runtime._start, before anything is shown): one reload, nothing started or written; with a false answer the ghost runs and its state is never written', async () => {
  const w = world();
  w.saves.set('x', {});
  const newer = JSON.stringify({ v: 2, shell: 'master', future: { a: 1 } });
  localStorage.setItem(stateKey('x'), newer);
  const site = new StaleSite(w, host());
  const started = watch(site.start());
  await until(() => site.reloads === 1);
  await settle();
  assert.equal(started.out, 'pending');
  assert.equal(w.engines.length, 0, 'no engine');
  assert.equal(sessionMarker.read(), null, 'no marker written');
  assert.equal(localStorage.getItem(stateKey('x')), newer);

  const w2 = world();
  w2.saves.set('x', {});
  localStorage.setItem(stateKey('x'), newer);
  const s2 = await upStale(w2, host({ build: OLD }));
  assert.equal(s2.reloads, 0);
  assert.ok(loopOf(s2.slots[0]) && loopOf(s2.slots[0]).booted, 'the ghost runs');
  s2._onPageHide();
  assert.equal(localStorage.getItem(stateKey('x')), newer, 'read for what fits, never written');
});

test('newer runtime prefs at Site.start: one reload, nothing started; with a false answer the set starts and the prefs stay as stored', async () => {
  const w = world();
  const newer = JSON.stringify({ v: 2, ghost: 'x', ghosts: ['x', 'y'], rev: 3, future: true });
  localStorage.setItem(RUNTIME_KEY, newer);
  const site = new StaleSite(w, host());
  const started = watch(site.start());
  await until(() => site.reloads === 1);
  await settle();
  assert.equal(started.out, 'pending');
  assert.equal(w.engines.length, 0);
  assert.equal(site.lead, null, 'not even the lead lock');

  const w2 = world();
  localStorage.setItem(RUNTIME_KEY, newer);
  const s2 = await upStale(w2, host({ build: OLD }));
  assert.equal(s2.reloads, 0);
  assert.deepEqual(ids(s2), ['x', 'y'], 'the stored set, read for what fits');
  assert.equal(localStorage.getItem(RUNTIME_KEY), newer);
});

test('_writeSet with prefs a newer Sumika wrote meanwhile: nothing stored, no set message, the rev stays, staleCheck runs', async () => {
  const w = world();
  w.saves.set('y', {});
  const h = host({ build: OLD });
  const site = await upStale(w, h);
  const newer = JSON.stringify({ v: 2, ghost: 'x', ghosts: ['x'], rev: 7 });
  localStorage.setItem(RUNTIME_KEY, newer);              // another tab, on a newer build, wrote them
  const posts = w.posts.length;
  const rev = site.rev;
  site._writeSet({ kind: 'sync' });
  await until(() => h.calls.length === 1);
  assert.deepEqual(h.calls, [[BUILD_JSON, 'no-cache']], 'staleCheck asked');
  assert.equal(w.posts.length, posts, 'no set message');
  assert.equal(site.rev, rev);
  assert.equal(localStorage.getItem(RUNTIME_KEY), newer);
  assert.equal(site.reloads, 0, 'build.json names this build: no reload');
});

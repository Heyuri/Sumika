// src/core/state.js: schema, write policy, session marker, idle clock, engine lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StateStore, defaultState, normalizeState, normShells, memoryStorage, stateKey, sessionMarker, InputClock, GhostLock,
  runtimePrefs, MAX_RUN_CHARS, SESSION_KEY, LAST_INPUT_KEY,
} from '../../src/core/state.js';
// the several-ghosts additions through the namespace, so each of their tests fails alone on a state.js without them
import * as stateModule from '../../src/core/state.js';
import { FakeClock, settle } from './fakes.mjs';

const sessionStore = () => {
  const m = new Map();
  return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: k => m.delete(k), m };
};

test('schema: defaults and normalization never throw on bad data', () => {
  const d = defaultState();
  assert.equal(d.v, 1);
  assert.deepEqual(Object.keys(d).sort(), ['balloon', 'balloons', 'bootEpochMs', 'boxes', 'clock', 'closed', 'engine', 'ghostLife', 'minimized',
    'music', 'names', 'run', 'savedAt', 'scaling', 'shell', 'shellChosen', 'shellSwap', 'shells', 'stage', 'surfaceRestoreAt',
    'timers', 'trayIcon', 'v', 'vanished'].sort());
  // the tray icon (UI §2.6): a script's \![set,trayicon] file (ghost-root-relative), alone or shown while minimized
  assert.equal(d.trayIcon, null);
  assert.equal(normalizeState({ trayIcon: 'ghost/master/x.ico' }).trayIcon, 'ghost/master/x.ico');
  for (const bad of ['', 5, null, {}]) assert.equal(normalizeState({ trayIcon: bad }).trayIcon, null);
  assert.deepEqual(normalizeState({ minimized: { reason: 'user', scopes: [0], icon: 'ghost/master/x.ico' } }).minimized,
    { reason: 'user', scopes: [0], icon: 'ghost/master/x.ico' });
  assert.equal('icon' in normalizeState({ minimized: { reason: 'user', scopes: [0], icon: 3 } }).minimized, false);
  // a pending OnSurfaceRestore's stamp (EV §3.4): epoch ms; anything else is 0 (none)
  assert.equal(d.surfaceRestoreAt, 0);
  assert.equal(normalizeState({ surfaceRestoreAt: 1791000000000 }).surfaceRestoreAt, 1791000000000);
  for (const bad of [-5, '1791000000000', null, NaN, Infinity]) assert.equal(normalizeState({ surfaceRestoreAt: bad }).surfaceRestoreAt, 0);
  // the sakura and kero names in effect (EV §2.7.5): two strings, else none
  assert.equal(d.names, null);
  assert.deepEqual(normalizeState({ names: { sakura: 'none', kero: '', x: 1 } }).names, { sakura: 'none', kero: '' });
  for (const bad of [undefined, null, 'x', [], { sakura: 5, kero: '' }, { sakura: 'a' }]) assert.equal(normalizeState({ names: bad }).names, null);
  assert.deepEqual([d.shell, d.shellChosen, d.shells, d.shellSwap], [null, false, {}, null]);
  // Shell / Balloon scaling ▸ (core/scaling.js): whole percentages 10..500, else null (follow the display)
  assert.deepEqual(d.scaling, { shell: null, balloon: null });
  assert.deepEqual(normalizeState({ scaling: { shell: 150, balloon: '75' } }).scaling, { shell: 150, balloon: 75 });
  assert.deepEqual(normalizeState({ scaling: { shell: 9000, balloon: 'x' } }).scaling, { shell: null, balloon: null });
  assert.deepEqual(normalizeState({ scaling: 'big' }).scaling, { shell: null, balloon: null });
  for (const bad of [null, 42, 'x', [], { timers: 'no', run: 5, minimized: 'yes' }]) assert.deepEqual(normalizeState(bad).timers, []);
  const n = normalizeState({
    v: 1, closed: true, minimized: { reason: 'script', scopes: [0, '1', 'x'] },
    timers: [{ ev: 'a', intervalMs: 10, dueAt: 5, repeat: 1, refs: [1, 'b'] }, { ev: '', intervalMs: 10, dueAt: 1 }, { ev: 'z', intervalMs: 0, dueAt: 1 }],
    run: { src: '\\0hi\\e', ip: 2 }, clock: { lastMinute: '2026-10-06T21:13' }, vanished: 2,
  });
  assert.equal(n.closed, true);
  assert.deepEqual(n.minimized, { reason: 'script', scopes: [0, 1] });
  assert.deepEqual(n.timers, [{ ev: 'a', refs: ['1', 'b'], repeat: true, intervalMs: 10, dueAt: 5, kind: 'raise' }]);
  assert.equal(n.run.src, '\\0hi\\e');
  assert.equal(n.clock.lastMinute, '2026-10-06T21:13');
  assert.equal(n.vanished, 2);
  // P7: the ghost's last cold boot (epoch ms); anything else is 0 (none)
  assert.equal(d.bootEpochMs, 0);
  assert.equal(normalizeState({ bootEpochMs: 1791000000000 }).bootEpochMs, 1791000000000);
  for (const bad of [-5, '1791000000000', null, NaN]) assert.equal(normalizeState({ bootEpochMs: bad }).bootEpochMs, 0);
  // the music box (TS §3.4): a path is required; the rest is clamped
  assert.equal(n.music, null);
  assert.equal(normalizeState({ music: { path: '' } }).music, null);
  assert.deepEqual(normalizeState({ music: { path: 'C:\\sumika\\drop\\0a1b2c3d\\a.mp3', currentTime: '12.5', loop: true, volume: 3, playing: 1 } }).music,
    { path: 'C:\\sumika\\drop\\0a1b2c3d\\a.mp3', currentTime: 12.5, loop: true, volume: 1, playing: false });
});

test('schema: a \\![timer*other] keeps its ghost argument (`to`, a string); a run keeps its COMMUNICATE (EV §2.7.9)', () => {
  const n = normalizeState({
    timers: [
      { ev: 'OnT', intervalMs: 2000, dueAt: 5, repeat: false, refs: ['a'], kind: 'notify', to: 'Ys' },
      { ev: 'OnE', intervalMs: 50, dueAt: 5, to: '' },
      { ev: 'OnN', intervalMs: 50, dueAt: 5, to: 7 },
    ],
    run: { src: '\\0hi\\e', ip: 2, communicate: { ids: ['y'], sender: 'Xs' } },
  });
  assert.deepEqual(n.timers, [
    { ev: 'OnT', refs: ['a'], repeat: false, intervalMs: 2000, dueAt: 5, kind: 'notify', to: 'Ys' },
    { ev: 'OnE', refs: [], repeat: false, intervalMs: 50, dueAt: 5, kind: 'raise', to: '' },
    { ev: 'OnN', refs: [], repeat: false, intervalMs: 50, dueAt: 5, kind: 'raise' },
  ], 'an empty ghost is still a target (notfound when it fires); a number is not');
  assert.deepEqual(n.run.communicate, { ids: ['y'], sender: 'Xs' }, 'the run as saved: the loop checks the record');
});

test('schema: shellChosen and the per-shell memory (EV §2.6) keep good data and drop malformed parts', () => {
  const n = normalizeState({
    shell: 'alt', shellChosen: true, balloon: 'LightBlue',
    shells: {
      alt: { binds: { 0: [1, '2', 2.5, -1, 'x'], 1: [], x: [3], 2: 'no' }, balloon: 'sumika', extra: 1 },
      master: { binds: {} },
      '': { balloon: 'b' },
      gone: null,
      onlyBalloon: { balloon: 'LightBlue' },
      noBalloon: { balloon: '' },
    },
  });
  assert.deepEqual([n.shell, n.shellChosen, n.balloon], ['alt', true, 'LightBlue']);
  assert.deepEqual(n.shells, { alt: { binds: { 0: [1, 2], 1: [] }, balloon: 'sumika' }, onlyBalloon: { balloon: 'LightBlue' } });
  assert.equal(normalizeState({ shell: 'alt', shellChosen: 1 }).shellChosen, false, 'only true counts');
  assert.equal(normalizeState({ shellChosen: true }).shellChosen, false, 'nothing chosen without a shell');
  for (const bad of [null, 'x', [], 5]) assert.deepEqual(normalizeState({ shells: bad }).shells, {});
  assert.deepEqual(normShells({ a: { binds: [1, 2] } }), {}, 'binds are per scope');
  // a shell swap not settled yet (runtime settleSwapSurfaces): whole scopes and surface ids only
  assert.deepEqual(normalizeState({ shellSwap: { surfaces: { 0: 5, 1: '10', 2: -1, x: 3, 3: 1.5 } } }).shellSwap, { surfaces: { 0: 5, 1: 10 } });
  assert.deepEqual(normalizeState({ shellSwap: {} }).shellSwap, { surfaces: {} });
  for (const bad of [undefined, null, 'x', [], 5]) assert.equal(normalizeState({ shellSwap: bad }).shellSwap, null);
});

test('round trip through storage; collectors run before each write; isNew', () => {
  const storage = memoryStorage();
  const clock = new FakeClock();
  const a = new StateStore('tsubasa', { storage, clock });
  assert.equal(a.isNew, true);
  assert.equal(a.key, 'sumika:ghost:tsubasa:state');
  assert.equal(stateKey('x'), 'sumika:ghost:x:state');
  let calls = 0;
  a.addCollector(d => { calls++; d.stage = { v: 1, scopes: { 0: { surface: 3 } } }; d.timers = [{ ev: 'T', refs: [], repeat: false, intervalMs: 5, dueAt: 9, kind: 'raise' }]; });
  assert.equal(a.saveNow(), true);
  assert.equal(calls, 1);
  const b = new StateStore('tsubasa', { storage, clock });
  assert.equal(b.isNew, false);
  assert.deepEqual(b.data.stage, { v: 1, scopes: { 0: { surface: 3 } } });
  assert.equal(b.data.timers[0].ev, 'T');
  assert.equal(b.data.savedAt, clock.now());
  storage.setItem(a.key, '{broken');
  assert.equal(new StateStore('tsubasa', { storage, clock }).isNew, true);
});

test('writes are debounced (250 ms, at most 2 s late) and skipped when read-only', async () => {
  const storage = memoryStorage();
  const clock = new FakeClock();
  const s = new StateStore('g', { storage, clock });
  s.change();
  await clock.advance(200);
  assert.equal(storage.getItem(s.key), null);
  await clock.advance(60);
  assert.ok(storage.getItem(s.key));
  storage.clear();
  for (let i = 0; i < 20; i++) { s.change(); await clock.advance(200); }   // continuous changes
  assert.ok(storage.getItem(s.key), 'maxWait forces a write');
  storage.clear();
  s.readOnly = true;
  s.change();
  assert.equal(s.saveNow(), false);
  await clock.advance(3000);
  assert.equal(storage.getItem(s.key), null);
});

test('a huge run is not persisted; a full storage keeps the essentials', () => {
  const clock = new FakeClock();
  const storage = memoryStorage();
  const s = new StateStore('g', { storage, clock });
  s.data.run = { src: 'x'.repeat(MAX_RUN_CHARS + 1), ip: 0 };
  s.saveNow();
  assert.equal(JSON.parse(storage.getItem(s.key)).run, null);
  const full = memoryStorage();
  full.setItem = (k, v) => { if (v.length > 2000) throw new Error('QuotaExceededError'); };
  const t = new StateStore('g', { storage: full, clock });
  t.data.run = { src: 'y'.repeat(5000), ip: 0 };
  assert.equal(t.saveNow(), true);
});

test('session marker and runtime prefs', () => {
  const ss = sessionStore();
  assert.equal(sessionMarker.read(ss), null);
  sessionMarker.write({ ghost: 'tsubasa', sessionEpochMs: 123 }, ss);
  assert.deepEqual(JSON.parse(ss.m.get(SESSION_KEY)), { booted: true, ghost: 'tsubasa', sessionEpochMs: 123, v: 2 });
  assert.deepEqual(sessionMarker.read(ss), { booted: true, ghost: 'tsubasa', sessionEpochMs: 123 });
  ss.set(SESSION_KEY, 'garbage');
  assert.equal(sessionMarker.read(ss), null);
  sessionMarker.clear(ss);
  assert.equal(ss.m.has(SESSION_KEY), false);
  const ls = memoryStorage();
  assert.deepEqual(runtimePrefs.get(ls), {});
  runtimePrefs.set({ ghost: 'tsubasa' }, ls);
  runtimePrefs.set({ other: 1 }, ls);
  assert.deepEqual(runtimePrefs.get(ls), { ghost: 'tsubasa', other: 1 });
});

test('storedClosed: the stored state\'s closed flag, read without a StateStore; absent or unreadable -> false', () => {
  const { storedClosed } = stateModule;
  const ls = memoryStorage();
  const put = (id, v) => ls.setItem(stateKey(id), typeof v === 'string' ? v : JSON.stringify(v));
  put('shut', { v: 1, closed: true });
  put('open', { v: 1, closed: false });
  put('old', { v: 0, closed: true });                 // no valid mark: version 1 (schema.js versionOf), like normalizeState
  put('truthy', { v: 1, closed: 'yes' });
  put('broken', '{broken');
  put('list', [true]);
  put('nul', 'null');
  assert.equal(storedClosed('shut', ls), true);
  assert.equal(storedClosed('old', ls), true);
  for (const id of ['open', 'truthy', 'broken', 'list', 'nul', 'never']) assert.equal(storedClosed(id, ls), false, id);
  const throwing = { getItem: () => { throw new Error('SecurityError'); } };
  assert.equal(storedClosed('shut', throwing), false, 'blocked storage');
  // the same answer as a StateStore opened on it, without opening one
  const s = new StateStore('shut', { storage: ls, clock: new FakeClock() });
  assert.equal(s.data.closed, storedClosed('shut', ls));
});

test('input clock: idle seconds survive navigation through sessionStorage (written at most once a second)', () => {
  const ss = sessionStore();
  const clock = new FakeClock();
  const a = new InputClock({ store: ss, clock });
  assert.equal(a.idleSeconds(), 0);
  clock.t += 4500;
  assert.equal(a.idleSeconds(), 4);
  a.touch();
  assert.equal(ss.m.get(LAST_INPUT_KEY), String(clock.t));
  clock.t += 300;
  a.touch();
  assert.equal(ss.m.get(LAST_INPUT_KEY), String(clock.t - 300), 'throttled');
  a.flush();
  clock.t += 10000;
  const b = new InputClock({ store: ss, clock });
  assert.equal(b.idleSeconds(), 10);
});

/** A tiny Web Locks double (exclusive, FIFO waiters). */
class FakeLocks {
  constructor() { this.held = new Map(); this.waiters = new Map(); }
  request(name, opts, cb) {
    const run = () => {
      this.held.set(name, true);
      return Promise.resolve(cb({ name })).finally(() => {
        this.held.delete(name);
        const q = this.waiters.get(name) || [];
        const next = q.shift();
        if (next) next();
      });
    };
    if (!this.held.get(name)) return run();
    if (opts.ifAvailable) return Promise.resolve(cb(null));
    return new Promise(resolve => {
      if (!this.waiters.has(name)) this.waiters.set(name, []);
      this.waiters.get(name).push(() => resolve(run()));
    });
  }
}

/** BroadcastChannel double shared between "tabs". */
function channelBus() {
  const all = new Set();
  return class {
    constructor(name) { this.name = name; this.onmessage = null; all.add(this); }
    postMessage(data) { for (const c of all) if (c !== this && c.name === this.name && c.onmessage) setImmediate(() => c.onmessage({ data })); }
    close() { all.delete(this); }
  };
}

test('engine lock: one tab holds the ghost; another asks for a takeover and gets it after release', async () => {
  const locks = new FakeLocks();
  const Channel = channelBus();
  const a = new GhostLock('tsubasa', { locks, Channel });
  const b = new GhostLock('tsubasa', { locks, Channel });
  assert.equal(a.mechanism, 'locks');
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  let asked = 0;
  a.on('takeover-request', () => { asked++; a.release(); });
  const waiting = b.acquire({ wait: true });
  b.requestTakeover();
  await settle();
  assert.equal(asked, 1);
  assert.equal(await waiting, true);
  assert.equal(b.held, true);
  assert.equal(a.held, false);
  a.dispose();
  b.dispose();
});

test('lock names: an id starting with "/" is sumika/<rest> (the lead lock), a folder id sumika:<id>; they never share a lock', async () => {
  const locks = new FakeLocks();
  const Channel = channelBus();
  const lead = new GhostLock('/lead', { locks, Channel });
  const ghost = new GhostLock('x', { locks, Channel });
  const folderLead = new GhostLock('lead', { locks, Channel });
  assert.equal(lead.name, 'sumika/lead');
  assert.equal(ghost.name, 'sumika:x');
  assert.equal(folderLead.name, 'sumika:lead', 'a ghost whose folder is "lead" keeps its own lock');
  assert.equal(lead.channel.name, 'sumika/lead', 'the handshake channel too');
  assert.equal(await lead.acquire(), true);
  assert.equal(await ghost.acquire(), true, 'the lead and a ghost lock are held together (lead first, then each ghost)');
  assert.equal(await folderLead.acquire(), true);
  const other = new GhostLock('/lead', { locks, Channel });
  assert.equal(await other.acquire(), false, 'one lead per browser');
  let asked = 0;
  lead.on('takeover-request', () => { asked++; lead.release(); });
  ghost.on('takeover-request', () => assert.fail('a lead request never reaches a ghost lock'));
  const waiting = other.acquire({ wait: true });
  other.requestTakeover();
  await settle();
  assert.equal(asked, 1);
  assert.equal(await waiting, true);
  assert.equal(ghost.held, true);
  for (const l of [lead, ghost, folderLead, other]) l.dispose();
});

test('engine lock fallbacks: BroadcastChannel handshake; nothing at all -> always acquire', async () => {
  const Channel = channelBus();
  const a = new GhostLock('g', { locks: null, Channel, probeMs: 20 });
  const b = new GhostLock('g', { locks: null, Channel, probeMs: 20 });
  assert.equal(a.mechanism, 'broadcast');
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  a.release();
  assert.equal(await b.acquire(), true);
  const c = new GhostLock('g', { locks: null, Channel: null });
  assert.equal(c.mechanism, 'none');
  assert.equal(await c.acquire(), true);
  a.dispose(); b.dispose(); c.dispose();
});

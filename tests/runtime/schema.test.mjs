// src/core/schema.js and the read hooks of what a visitor's browser keeps (safe updates): the
// version mark per record kind, upgrade() (unmarked = 1, steps in order, a newer record left as it is), and per kind
// what a newer record does: the ghost state and the runtime prefs are read for what fits and never written (unknown
// fields kept by every write), the tab marker resumes (v1 brought up to v2), the worker runs memory-only when the save
// files cannot be read, and the dropped files' store is read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCHEMA, STEPS, upgrade, versionOf, markerV1toV2 } from '../../src/core/schema.js';
import {
  StateStore, memoryStorage, stateKey, storedClosed, runtimePrefs, RUNTIME_KEY, sessionMarker, SESSION_KEY, STATE_VERSION,
  upgradeState,
} from '../../src/core/state.js';
import { UserProfile, USER_KEY } from '../../src/core/user.js';
import { DropStore, DROP_INDEX_KEY, DROP_KEY_PREFIX } from '../../src/core/drops.js';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('silent');
globalThis.self = globalThis.self || { postMessage() {} };
const { readFiles } = await import('../../src/worker/worker.js');
const { ENGINES } = await import('../../src/worker/engines/index.js');

const clock = { now: () => 5000, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h) };
const sessionStore = () => {
  const m = new Map();
  return { m, get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: k => m.delete(k) };
};

test('the marks: state 1, prefs 1, marker 2, files 1, drops 1, choice 1; only the marker has a step (1 -> 2)', () => {
  assert.deepEqual(SCHEMA, { state: 1, prefs: 1, marker: 2, files: 1, drops: 1, choice: 1 });
  assert.equal(STATE_VERSION, SCHEMA.state);
  assert.deepEqual(Object.keys(STEPS).sort(), Object.keys(SCHEMA).sort(), 'one steps table per kind');
  assert.deepEqual(Object.keys(STEPS.marker), ['1']);
  for (const k of ['state', 'prefs', 'files', 'drops', 'choice']) assert.deepEqual(STEPS[k], {}, k);
});

test('upgrade: the current version passes through; unmarked (or 0, text) counts as 1; a newer one is `newer`, as it is; steps run in order', () => {
  const rec = { a: 1 };
  assert.deepEqual(upgrade('state', rec, 1), { rec, v: 1, newer: false });
  assert.equal(upgrade('state', rec, 1).rec, rec, 'the same object');
  for (const v of [undefined, null, 0, -1, 1.5, '1', 'x']) assert.equal(versionOf(v), 1, String(v));
  assert.deepEqual(upgrade('prefs', rec, undefined), { rec, v: 1, newer: false });
  assert.deepEqual(upgrade('state', rec, 2), { rec, v: 2, newer: true });
  const order = [];
  const steps = { 1: r => { order.push(1); return { ...r, b: 2 }; }, 2: r => { order.push(2); return { ...r, c: 3 }; } };
  const up = upgrade('state', rec, 1, steps, 3);
  assert.deepEqual(up, { rec: { a: 1, b: 2, c: 3, v: 3 }, v: 3, newer: false }, 'moved up: marked with the version reached');
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(upgrade('state', up.rec, up.rec.v, steps, 3), up, 'a second pass runs no step again');
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(upgrade('state', rec, 2, steps, 3).rec, { a: 1, c: 3, v: 3 }, 'from 2: the second step only');
  assert.deepEqual(rec, { a: 1 }, 'the stored record itself is left as it was');
  assert.deepEqual(upgrade('state', 'x', 1, { 1: r => `${r}!` }, 2), { rec: 'x!', v: 2, newer: false }, 'no object: no mark');
  assert.deepEqual(upgradeState(null), { rec: null, v: 1, newer: false });
});

test('a ghost state step runs once on the read path: StateStore.open upgrades, normalizeState does not run it again (a copy of src/ whose schema has state 2)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-schema-'));
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type": "module"}\n');
    const file = path.join(dir, 'src', 'core', 'schema.js');
    let text = fs.readFileSync(file, 'utf8');
    const swap = (a, b) => { assert.equal(text.split(a).length, 2, `schema.js has ${a} once`); text = text.replace(a, b); };
    swap('SCHEMA = Object.freeze({ state: 1,', 'SCHEMA = Object.freeze({ state: 2,');
    swap('STEPS = Object.freeze({ state: {},', 'STEPS = Object.freeze({ state: { 1: r => ({ ...r, vanished: (r.vanished | 0) + 1 }) },');
    fs.writeFileSync(file, text);
    const s2 = await import(pathToFileURL(path.join(dir, 'src', 'core', 'state.js')).href);
    (await import(pathToFileURL(path.join(dir, 'src', 'core', 'log.js')).href)).setLogLevel('silent');
    const storage = s2.memoryStorage();
    const key = s2.stateKey('g');
    storage.setItem(key, JSON.stringify({ v: 1, vanished: 5, later: 'x' }));
    const st = s2.StateStore.open('g', { storage, clock });
    assert.equal(st.newer, false);
    assert.equal(st.data.vanished, 6, 'the step ran once');
    assert.equal(s2.normalizeState({ v: 1, vanished: 5 }).vanished, 6);
    assert.equal(st.saveNow(), true);
    const saved = JSON.parse(storage.getItem(key));
    assert.deepEqual([saved.v, saved.vanished, saved.later], [2, 6, 'x'], 'the next write stores the current shape');
    assert.equal(s2.StateStore.open('g', { storage, clock }).data.vanished, 6, 'a stored v2 state: no step');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ghost state: a newer one is read for what fits, never written or cleared; storedClosed reads through the hook', () => {
  const storage = memoryStorage();
  const key = stateKey('g');
  const stored = JSON.stringify({ v: 2, closed: true, shell: 'alt', future: { x: 1 } });
  storage.setItem(key, stored);
  const s = new StateStore('g', { storage, clock });
  assert.equal(s.newer, true);
  assert.equal(s.isNew, false);
  assert.equal(s.data.shell, 'alt', 'read what fits');
  assert.equal(s.data.closed, true);
  s.data.shell = 'master';
  s.change();
  assert.equal(s.dirty, false, 'no write scheduled');
  assert.equal(s.saveNow(), false);
  assert.equal(storage.getItem(key), stored, 'storage unchanged');
  s.clear();
  assert.equal(storage.getItem(key), stored, 'clear() leaves it');
  assert.equal(s.data.shell, null, 'this page forgets it');
  assert.equal(s.saveNow(), false, 'still newer after clear()');
  assert.equal(storedClosed('g', storage), true);
  // the current version and an unmarked one are no newer
  storage.setItem(key, JSON.stringify({ closed: true }));
  assert.equal(new StateStore('g', { storage, clock }).newer, false);
  assert.equal(storedClosed('g', storage), true);
});

test('ghost state: fields this runtime does not know survive every write, the quota retry too', () => {
  const storage = memoryStorage();
  const key = stateKey('g');
  storage.setItem(key, JSON.stringify({ v: 1, shell: 'master', later: [1, 2], also: 'x' }));
  const s = new StateStore('g', { storage, clock });
  assert.equal(s.newer, false);
  assert.equal('later' in s.data, false, 'not in the live state');
  assert.equal(s.saveNow(), true);
  let w = JSON.parse(storage.getItem(key));
  assert.deepEqual([w.later, w.also, w.v, w.shell], [[1, 2], 'x', 1, 'master']);
  // full storage: the retry without run and balloons keeps them too
  const full = memoryStorage();
  full.setItem(key, JSON.stringify({ v: 1, later: 'kept' }));
  const set = full.setItem;
  full.setItem = (k, v) => { if (v.length > 2000) throw new Error('QuotaExceededError'); set(k, v); };
  const t = new StateStore('g', { storage: full, clock });
  t.data.run = { src: 'y'.repeat(5000), ip: 0 };
  assert.equal(t.saveNow(), true);
  w = JSON.parse(full.getItem(key));
  assert.equal(w.run, null);
  assert.equal(w.later, 'kept');
  // a state the runtime itself writes again wins over a stored field of the same name
  const u = new StateStore('g', { storage, clock });
  u.data.shell = 'alt';
  u.saveNow();
  assert.equal(JSON.parse(storage.getItem(key)).shell, 'alt');
});

test('runtime prefs: the stored JSON gets v: 1 and get() hides it; a newer record is read for what fits, set() refuses; `user` keeps keys it does not know', () => {
  const ls = memoryStorage();
  assert.equal(runtimePrefs.set({ ghost: 'a', ghosts: ['a'], rev: 1 }, ls), true);
  assert.deepEqual(JSON.parse(ls.getItem(RUNTIME_KEY)), { ghost: 'a', ghosts: ['a'], rev: 1, v: 1 });
  assert.deepEqual(runtimePrefs.get(ls), { ghost: 'a', ghosts: ['a'], rev: 1 });
  assert.equal(runtimePrefs.newer(ls), false);
  const newer = JSON.stringify({ v: 2, ghost: 'b', ghosts: ['b'], rev: 7, lang: 'ja', shape: 'new' });
  ls.setItem(RUNTIME_KEY, newer);
  assert.equal(runtimePrefs.newer(ls), true);
  assert.deepEqual(runtimePrefs.get(ls), { ghost: 'b', ghosts: ['b'], rev: 7, lang: 'ja', shape: 'new' }, 'read what fits');
  assert.equal(runtimePrefs.set({ ghost: 'c', ghosts: ['c'], rev: 8 }, ls), false);
  assert.equal(ls.getItem(RUNTIME_KEY), newer, 'nothing written');
  // unreadable or absent: {}, and writable
  ls.setItem(RUNTIME_KEY, '{broken');
  assert.deepEqual(runtimePrefs.get(ls), {});
  assert.equal(runtimePrefs.newer(ls), false);
  // the visitor's user information: a newer runtime's own sub-keys stay as stored
  const us = memoryStorage();
  us.setItem(RUNTIME_KEY, JSON.stringify({ v: 1, [USER_KEY]: { name: 'A', pronouns: 'they', sex: 'male' } }));
  const u = new UserProfile({ storage: us });
  assert.deepEqual(u.data, { name: 'A', sex: 'male' });
  assert.equal(u.set({ nickname: 'B' }), true);
  assert.deepEqual(JSON.parse(us.getItem(RUNTIME_KEY))[USER_KEY], { pronouns: 'they', name: 'A', sex: 'male', nickname: 'B' });
});

test('tab marker: written with v: 2, read() hides it; unmarked with `ghosts` is v2; a v1 marker is brought up (ghosts, carry); v: 3 still resumes', () => {
  const ss = sessionStore();
  sessionMarker.write({ ghost: 'x', sessionEpochMs: 1, ghosts: ['x'] }, ss);
  assert.deepEqual(JSON.parse(ss.m.get(SESSION_KEY)), { booted: true, ghost: 'x', sessionEpochMs: 1, ghosts: ['x'], v: 2 });
  assert.deepEqual(sessionMarker.read(ss), { booted: true, ghost: 'x', sessionEpochMs: 1, ghosts: ['x'] });
  // unmarked with a ghosts array: v2 as written before the mark (no carry built from its v1 mirror)
  const v2 = { booted: true, ghost: 'x', sessionEpochMs: 1, pending: true, change: null, ghosts: ['x', 'y'] };
  ss.set(SESSION_KEY, JSON.stringify(v2));
  assert.deepEqual(sessionMarker.read(ss), v2);
  // v1 (one ghost, a change pending): ghosts and carry from markerGhosts / markerCarry, the v1 fields kept
  const change = { sakuraName: 'A', name: 'Ghost A', path: '/ghost/a/', script: '\\0bye\\e' };
  ss.set(SESSION_KEY, JSON.stringify({ booted: true, ghost: 'e', sessionEpochMs: 7, pending: true, change }));
  assert.deepEqual(sessionMarker.read(ss), { booted: true, ghost: 'e', sessionEpochMs: 7, pending: true, change, ghosts: ['e'],
    carry: { e: { kind: 'change', change } } });
  ss.set(SESSION_KEY, JSON.stringify({ booted: true, ghost: 'e', sessionEpochMs: 7 }));
  assert.deepEqual(sessionMarker.read(ss), { booted: true, ghost: 'e', sessionEpochMs: 7, ghosts: ['e'] }, 'nothing owed: no carry');
  assert.deepEqual(markerV1toV2(null), null);
  // a newer page's marker: read what fits, a resume
  ss.set(SESSION_KEY, JSON.stringify({ v: 3, booted: true, ghost: 'z', sessionEpochMs: 9, ghosts: ['z'], more: 1 }));
  assert.deepEqual(sessionMarker.read(ss), { booted: true, ghost: 'z', sessionEpochMs: 9, ghosts: ['z'], more: 1 });
  ss.set(SESSION_KEY, JSON.stringify({ v: 2, booted: true }));
  assert.equal(sessionMarker.read(ss), null, 'no ghost: no marker');
});

test('save files: readFiles answers a map of ArrayBuffer / null; a read that fails or another shape is not "no save"', async () => {
  const st = v => ({ read: async () => v });
  const ab = new ArrayBuffer(2);
  assert.deepEqual(await readFiles(st(undefined), 'k'), { files: {}, ok: true });
  assert.deepEqual(await readFiles(st(null), 'k'), { files: {}, ok: true });
  assert.deepEqual(await readFiles(st({ a: ab, b: null }), 'k'), { files: { a: ab, b: null }, ok: true });
  for (const bad of ['text', [ab], { a: 'text' }, { a: new Uint8Array(2) }, { a: 5 }]) {
    assert.deepEqual(await readFiles(st(bad), 'k'), { files: {}, ok: false }, JSON.stringify(bad));
  }
  assert.deepEqual(await readFiles({ read: async () => { throw new Error('NotReadableError'); } }, 'k'), { files: {}, ok: false });
});

test('save files: when the stored record cannot be read the worker runs memory-only, and later engine reports leave the record untouched', async () => {
  const reported = [];
  ENGINES.fakeschema = class {
    constructor() {}
    async boot() {}
    init(files, persisted, opts) { reported.push({ persisted, opts }); return true; }
    changedFiles() { return { 'ghost/master/save.txt': new Uint8Array([1, 2]).buffer }; }
    save() { return true; }
    setVolatileState() {}
    getVolatileState() { return null; }
  };
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => replies.push(m);
  const ls = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const key = 'ghost:g:files';
    const raw = `schematest:${key}`;
    for (const stored of ['{not json', JSON.stringify({ 'ghost/master/save.txt': 'text' })]) {
      localStorage.setItem(raw, stored);
      await self.onmessage({ data: { t: 'init', id: 1, engine: 'fakeschema', engineUrl: 'x', files: [], storeNamespace: 'schematest', storeKey: key, resume: true } });
      const loaded = replies.filter(r => r.t === 'loaded').pop();
      assert.deepEqual([loaded.ok, loaded.hadSave], [true, false], 'the ghost starts without the save');
      assert.deepEqual(reported.pop().persisted, {});
      assert.ok(replies.some(r => r.t === 'log' && r.level === 'warn' && /could not be read/.test(r.text)));
      await self.onmessage({ data: { t: 'persist', id: 2 } });
      assert.ok(replies.some(r => r.t === 'persisted' && r.files.includes('ghost/master/save.txt')), 'the engine reported');
      assert.equal(localStorage.getItem(raw), stored, 'the stored record is never written over');
    }
    // a readable record: stored as usual
    localStorage.removeItem(raw);
    await self.onmessage({ data: { t: 'init', id: 3, engine: 'fakeschema', engineUrl: 'x', files: [], storeNamespace: 'schematest', storeKey: key } });
    assert.match(localStorage.getItem(raw), /save\.txt/);
  } finally {
    delete ENGINES.fakeschema;
    self.postMessage = post;
    if (ls === undefined) delete globalThis.localStorage; else globalThis.localStorage = ls;
  }
});

/** Map-backed stand-in for core/storage.js Store that records every write and delete. */
class Backend {
  constructor(entries) { this.m = new Map(entries); this.log = []; }
  async get(k) { return this.m.get(k); }
  async set(k, v) { this.log.push(['set', k]); this.m.set(k, v); return true; }
  async delete(k) { this.log.push(['delete', k]); this.m.delete(k); return true; }
  keys(prefix = '') { return [...this.m.keys()].filter(k => k.startsWith(prefix)).sort(); }
}

test('dropped files: an index a newer runtime wrote makes the store read-only (no reconcile, no delete, no index write, nothing cleared); files dropped here play from memory', async () => {
  const index = { v: 2, files: { 'c:\\sumika\\drop\\00000000\\old.mp3': { size: 3, usedAt: 1 } }, shape: 'new' };
  const be = new Backend([[DROP_INDEX_KEY, index], [DROP_KEY_PREFIX + 'stray', { not: 'a file record' }]]);
  const drops = new DropStore({ backend: be, storable: () => true, locks: null, estimate: null, now: () => 1000 });
  const [e] = drops.add([new File([new Uint8Array(4)], 'a.mp3', { type: 'audio/mpeg' })]);
  await drops.whenIdle();
  assert.equal(drops.newer, true);
  assert.deepEqual(be.log, [], 'nothing written or deleted');
  assert.ok(await drops.blob(e.path), 'plays on this page');
  await drops.whenIdle();
  assert.equal(await drops.clear(), false);
  assert.deepEqual(be.log, []);
  assert.equal(be.m.get(DROP_INDEX_KEY), index);
});

test('dropped files: the index keeps top-level keys it does not know (v 1)', async () => {
  const be = new Backend([[DROP_INDEX_KEY, { v: 1, files: {}, later: { x: 1 } }]]);
  const drops = new DropStore({ backend: be, storable: () => true, locks: null, estimate: null, now: () => 1000 });
  drops.add([new File([new Uint8Array(4)], 'a.mp3', { type: 'audio/mpeg' })]);
  await drops.whenIdle();
  assert.equal(drops.newer, false);
  const idx = be.m.get(DROP_INDEX_KEY);
  assert.deepEqual(idx.later, { x: 1 });
  assert.equal(idx.v, 1);
  assert.equal(Object.keys(idx.files).length, 1);
});

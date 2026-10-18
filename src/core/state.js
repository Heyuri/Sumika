// Ghost state that must survive page navigation (SUMMARY §2.5): one JSON object per ghost in localStorage,
// written debounced and synchronously when the page is hidden; the tab-session marker (resume vs cold boot); the
// user's idle clock; and the cross-tab locks: one engine per ghost per browser, and the lead lock of the tab that runs
// the set of ghosts on screen (core/ghostset.js).
// Engine save data is not here: the worker writes it to IndexedDB itself (core/shiori.js, worker.js).
// Every default storage, lock manager and channel comes from core/platform.js, resolved when used: the browser's own
// globals, or the storage hub's (data-hub, core/hub.js).
import { tabSession, localStore, lockManager, channelClass, stateWill } from './platform.js';
import { Emitter } from './emitter.js';
import { log } from './log.js';
import { normScaling } from './scaling.js';
import { SCHEMA, upgrade } from './schema.js';

export const NS = 'sumika';
/** The ghost state's version (schema.js SCHEMA.state; `stage.v`, nested and never read, stays as written). */
export const STATE_VERSION = SCHEMA.state;
export const SESSION_KEY = 'sumika.session';
export const LAST_INPUT_KEY = 'sumika.lastInputMs';
/** A run whose script is longer than this is not persisted (puyo frames); it is lost on navigation. */
export const MAX_RUN_CHARS = 512 * 1024;

const realClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: h => clearTimeout(h),
};

export const stateKey = ghostId => `${NS}:ghost:${ghostId}:state`;
export const RUNTIME_KEY = `${NS}:runtime`;

/** A fresh state object (schema v1). `stage`, `balloons` hold whatever Stage/Balloons.saveState() return. */
export function defaultState() {
  return {
    v: STATE_VERSION,
    savedAt: 0,
    shell: null,            // the shell folder in use (written at every boot and shell change)
    shellChosen: false,     // the visitor picked `shell` (SSP shell.ischanged.2); false: boot the default shell (EV §2.6)
    balloon: null,          // the balloon's folder id (older states: its descript name; both resolve, BA §1.6)
    shells: {},             // per-shell memory (SSP shell.dat): {[shellId]: {binds?: {[scope]: ids}, balloon?: id}}
    shellSwap: null,        // a shell swap OnShellChanged has not decided yet (EV §2.6): {surfaces: {[scope]: id}}, the
                            // surfaces shown before it; a resume or a frozen tab shows them (runtime settleSwapSurfaces)
    closed: false,          // after \- : the next load shows the launcher, then a cold boot
    minimized: null,        // or {reason:'user'|'script', scopes:[visible scopes before minimizing], icon?: the
                            // \![set,trayicon] icon shown while minimized (ghost-root-relative; UI §2.6)}
    trayIcon: null,         // a script's \![set,trayicon] icon for the next minimize (ghost-root-relative path; UI §2.6)
    stage: null,           // Stage.saveState(): per scope surface, position ratios, binds, visibility ...
    names: null,            // {sakura, kero}: the names in effect (a shell's override applied), what the others see of
                            // the ghost on the next page until its loop is up (Site._peerOf, EV §2.7.5)
    balloons: null,         // Balloons.saveState()
    ghostLife: { passive: false, induction: false },
    timers: [],             // [{ev, refs, repeat, intervalMs, dueAt, kind, to?}] (to: \![timer*other]'s ghost)
    run: null,              // ScriptPlayer.runState() + {origin, refs, timeoutRemainingMs, communicate?}
    boxes: [],              // [{kind, id, args, dueAt, words?}] input/communicate/teach boxes open at unload (words:
                            // the teach box's 311/312 round so far, UI §6.3)
    engine: null,           // P6 talk countdown {talkCount, sinceLastTalk, at}
    bootEpochMs: 0,         // P7: epoch ms of this ghost's last cold boot, where Satori's uptime clock starts (0 = none)
    music: null,            // dsaudio/MCI track {path, currentTime, loop, volume 0..1, playing, owner?, given?}, resumed
                            // only (TS §3.4)
    clock: { lastMinute: null },
    surfaceRestoreAt: 0,    // epoch ms a pending OnSurfaceRestore counts from (EV §3.4), 0 = none; resumed only
    vanished: 0,            // OnFirstBoot R0
    scaling: { shell: null, balloon: null },   // the user's Shell / Balloon scaling ▸ choice in %, null = the display's (core/scaling.js)
  };
}

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * The ghost state's hook (schema.js upgrade), before any field of a stored state is read (normalizeState,
 * storedClosed): an older state is brought up in memory; a newer one is read as it is, `newer`.
 * @returns {{rec: *, v: number, newer: boolean}}
 */
export function upgradeState(raw) {
  if (!isObj(raw)) return { rec: raw, v: STATE_VERSION, newer: false };
  return upgrade('state', raw, raw.v);
}

const KNOWN_STATE = new Set(Object.keys(defaultState()));

/** A stored state's top-level fields this runtime does not know (a newer one's additive fields): kept at every write. */
function unknownFields(raw) {
  const out = {};
  if (isObj(raw)) for (const [k, v] of Object.entries(raw)) if (!KNOWN_STATE.has(k)) out[k] = v;
  return out;
}

function normTimer(t) {
  if (!isObj(t) || typeof t.ev !== 'string' || !t.ev) return null;
  const intervalMs = Number(t.intervalMs);
  const dueAt = Number(t.dueAt);
  if (!(intervalMs > 0) || !Number.isFinite(dueAt)) return null;
  return {
    ev: t.ev,
    refs: Array.isArray(t.refs) ? t.refs.map(String) : [],
    repeat: !!t.repeat,
    intervalMs,
    dueAt,
    kind: t.kind === 'notify' ? 'notify' : 'raise',
    ...(typeof t.to === 'string' ? { to: t.to } : {}),     // \![timer*other]: the ghost argument (EV §2.7.9)
  };
}

/**
 * The per-shell memory (EV §2.6): {[shellId]: {binds?: {[scope]: number[]}, balloon?: string}}. Bind lists keep whole
 * non-negative ids under whole non-negative scopes; anything else, and entries left empty, are dropped.
 */
export function normShells(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!id || !isObj(v)) continue;
    const e = {};
    if (isObj(v.binds)) {
      const binds = {};
      for (const [k, list] of Object.entries(v.binds)) {
        if (!/^\d+$/.test(k) || !Array.isArray(list)) continue;
        binds[k] = list.map(Number).filter(n => Number.isInteger(n) && n >= 0);
      }
      if (Object.keys(binds).length) e.binds = binds;
    }
    if (typeof v.balloon === 'string' && v.balloon) e.balloon = v.balloon;
    if (Object.keys(e).length) out[id] = e;
  }
  return out;
}

/** state.shellSwap (EV §2.6): {surfaces: {[scope]: id}} with whole non-negative scopes and ids, else null. */
export function normShellSwap(raw) {
  if (!isObj(raw)) return null;
  const surfaces = {};
  if (isObj(raw.surfaces)) {
    for (const [k, v] of Object.entries(raw.surfaces)) {
      const id = typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN;
      if (/^\d+$/.test(k) && Number.isInteger(id) && id >= 0) surfaces[k] = id;
    }
  }
  return { surfaces };
}

/**
 * Fill in defaults and drop malformed parts of a stored state; never throws. The record goes through upgradeState
 * first (unmarked = version 1); a newer one is read for what fits (StateStore.newer says so).
 */
export function normalizeState(stored) {
  const s = defaultState();
  const raw = upgradeState(stored).rec;
  if (!isObj(raw)) return s;
  if (typeof raw.savedAt === 'number') s.savedAt = raw.savedAt;
  if (typeof raw.shell === 'string') s.shell = raw.shell;
  s.shellChosen = raw.shellChosen === true && !!s.shell;
  if (typeof raw.balloon === 'string') s.balloon = raw.balloon;
  s.shells = normShells(raw.shells);
  s.shellSwap = normShellSwap(raw.shellSwap);
  s.closed = raw.closed === true;
  if (isObj(raw.minimized)) {
    s.minimized = {
      reason: raw.minimized.reason === 'script' ? 'script' : 'user',
      scopes: Array.isArray(raw.minimized.scopes) ? raw.minimized.scopes.map(Number).filter(Number.isInteger) : [0],
    };
    if (typeof raw.minimized.icon === 'string' && raw.minimized.icon) s.minimized.icon = raw.minimized.icon;
  }
  if (typeof raw.trayIcon === 'string' && raw.trayIcon) s.trayIcon = raw.trayIcon;
  if (raw.stage !== undefined) s.stage = raw.stage;
  const n = raw.names;
  if (isObj(n) && typeof n.sakura === 'string' && typeof n.kero === 'string') {
    s.names = { sakura: n.sakura, kero: n.kero };
  }
  if (raw.balloons !== undefined) s.balloons = raw.balloons;
  if (isObj(raw.ghostLife)) s.ghostLife = { ...s.ghostLife, ...raw.ghostLife };
  if (Array.isArray(raw.timers)) s.timers = raw.timers.map(normTimer).filter(Boolean);
  if (isObj(raw.run) && typeof raw.run.src === 'string') s.run = raw.run;
  if (Array.isArray(raw.boxes)) s.boxes = raw.boxes.filter(b => isObj(b) && typeof b.kind === 'string');
  if (isObj(raw.engine)) s.engine = raw.engine;
  if (Number.isFinite(raw.bootEpochMs) && raw.bootEpochMs > 0) s.bootEpochMs = raw.bootEpochMs;
  if (isObj(raw.music) && typeof raw.music.path === 'string' && raw.music.path) {
    const t = Number(raw.music.currentTime);
    const v = Number(raw.music.volume);
    s.music = {
      path: raw.music.path,
      currentTime: Number.isFinite(t) && t > 0 ? t : 0,
      loop: raw.music.loop === true,
      volume: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1,
      playing: raw.music.playing === true,
    };
    // the DLL that loaded it, when not dsaudio (an MCI player: no OnDSAPlayFinish)
    if (typeof raw.music.owner === 'string' && raw.music.owner && raw.music.owner !== 'dsaudio') s.music.owner = raw.music.owner;
    // its load argument as the ghost gave it (mciaudior's OnMAAPlay* Reference0, page-saori.js)
    if (typeof raw.music.given === 'string') s.music.given = raw.music.given;
  }
  if (isObj(raw.clock) && typeof raw.clock.lastMinute === 'string') s.clock.lastMinute = raw.clock.lastMinute;
  if (Number.isFinite(raw.surfaceRestoreAt) && raw.surfaceRestoreAt > 0) s.surfaceRestoreAt = raw.surfaceRestoreAt;
  if (Number.isInteger(raw.vanished) && raw.vanished >= 0) s.vanished = raw.vanished;
  s.scaling = normScaling(raw.scaling);
  return s;
}

/**
 * The stored state says the ghost was closed (`closed`, written at \-), read without opening a StateStore (the Site's
 * "site closed" test over the stored set, ghostset.js siteClosed). false when nothing is stored or it is unreadable.
 * @param {string} ghostId
 * @param {Storage} [storage]
 */
export function storedClosed(ghostId, storage) {
  try {
    const raw = upgradeState(JSON.parse((storage || defaultStorage()).getItem(stateKey(ghostId)) || 'null')).rec;
    return isObj(raw) && raw.closed === true;
  } catch (e) {
    return false;
  }
}

/** In-memory Storage look-alike (private windows, tests). */
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/** localStorage if usable, else null. */
export function pageStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const k = `${NS}:__probe`;
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch (e) {
    return null;
  }
}

let sharedMemory = null;
/** The storage hub's mirror (core/platform.js localStore), else localStorage if usable, else this page's memory. */
function defaultStorage() {
  return localStore() || pageStorage() || (sharedMemory = sharedMemory || memoryStorage());
}

/**
 * One ghost's persisted state. Other modules contribute their part through collectors, which run right before
 * every write, so the stored JSON always reflects the live objects at that moment.
 */
export class StateStore extends Emitter {
  /**
   * @param {string} ghostId
   * @param {{storage?: Storage, clock?: object, debounceMs?: number, maxWaitMs?: number, will?: Function|null}} o
   *   will(lockName, key): called after each write; with the storage hub (data-hub) the hub then stamps `savedAt` when
   *   this ghost's engine lock goes, so a last write lost at a tab close still ends the session at the right time.
   *   Default without `storage`: core/platform.js stateWill() (null without the hub)
   */
  constructor(ghostId, { storage, clock, debounceMs = 250, maxWaitMs = 2000, will } = {}) {
    super();
    this.ghostId = ghostId;
    this.key = stateKey(ghostId);
    this.storage = storage || defaultStorage();
    this.clock = clock || realClock;
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.collectors = new Set();
    this.readOnly = false;   // a tab without the engine lock must never overwrite the holder's state
    /** the stored state is newer than this runtime (schema.js): read for what fits, never written or cleared */
    this.newer = false;
    this.isNew = true;
    this.data = defaultState();
    this._unknown = {};      // the stored state's fields this runtime does not know, kept at every write
    this._timer = null;
    this._firstDirty = 0;
    this._unbind = null;
    this._will = will !== undefined ? will : (storage ? null : stateWill());
    this._through = false;   // writeThrough(): each change written in the same task, not debounced
    this._throughQueued = false;
    this.reload();
  }

  static open(ghostId, opts) { return new StateStore(ghostId, opts); }

  /** Re-read from storage (e.g. after another tab handed the engine over). */
  reload() {
    this.isNew = true;
    this.newer = false;
    this.data = defaultState();
    this._unknown = {};
    let text = null;
    try { text = this.storage.getItem(this.key); } catch (e) { text = null; }
    if (!text) return this;
    try {
      const up = upgradeState(JSON.parse(text));
      this.data = normalizeState(up.rec);
      this._unknown = unknownFields(up.rec);
      this.newer = up.newer;
      this.isNew = false;
      if (up.newer) log.once('state-newer', `stored ghost state has version ${up.v}, newer than this page's ${STATE_VERSION}: reading what fits, writing nothing`);
    } catch (e) {
      log.once('state-corrupt', 'stored ghost state is unreadable; starting fresh', e);
    }
    return this;
  }

  /** fn(data) runs before each write and may fill in its part of the state. Returns an unsubscribe function. */
  addCollector(fn) {
    this.collectors.add(fn);
    return () => this.collectors.delete(fn);
  }

  /**
   * Something changed: write within debounceMs (at most maxWaitMs after the first unsaved change); in write-through,
   * at the end of this task (the changes of one task written once).
   */
  change() {
    if (this.readOnly || this.newer) return;
    if (this._through) {
      if (this._timer) { this.clock.clearTimeout(this._timer); this._timer = null; }
      if (!this._throughQueued) {
        this._throughQueued = true;
        queueMicrotask(() => { if (this._throughQueued) this.saveNow(); });
      }
      return;
    }
    const now = this.clock.now();
    if (!this._timer) this._firstDirty = now;
    else this.clock.clearTimeout(this._timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this._firstDirty + this.maxWaitMs - now));
    this._timer = this.clock.setTimeout(() => { this._timer = null; this.saveNow(); }, wait);
  }

  get dirty() { return !!this._timer || this._throughQueued; }

  /**
   * Write-through on or off: a page that may be leaving (the storage hub's leave-flush: a link
   * clicked, a form sent, beforeunload) writes every change at once, since its pagehide posts never reach the hub; the
   * Site turns it off when the page is shown again or stays.
   */
  writeThrough(on) {
    this._through = !!on;
  }

  /**
   * Collect and write synchronously, the stored state's unknown fields kept. Returns true when the state reached
   * storage; false and nothing written when read-only or the stored state is newer.
   */
  saveNow() {
    if (this._timer) { this.clock.clearTimeout(this._timer); this._timer = null; }
    this._throughQueued = false;
    if (this.readOnly) return false;
    if (this.newer) {
      log.once('state-newer-write', 'the stored ghost state is newer than this page: not written');
      return false;
    }
    for (const fn of this.collectors) {
      try { fn(this.data); } catch (e) { log.once('state-collector', 'a state collector failed', e); }
    }
    const d = this.data;
    d.v = STATE_VERSION;
    d.savedAt = this.clock.now();
    if (d.run && typeof d.run.src === 'string' && d.run.src.length > MAX_RUN_CHARS) d.run = null;
    let text;
    try {
      text = JSON.stringify({ ...this._unknown, ...d });
    } catch (e) {
      log.once('state-json', 'ghost state could not be serialized', e);
      return false;
    }
    if (this._write(text)) { this.isNew = false; this._willed(); this.emit('saved', d); return true; }
    // quota: try again without the largest optional parts
    const slim = { ...this._unknown, ...d, run: null, balloons: null };
    if (this._write(JSON.stringify(slim))) {
      log.once('state-quota', 'storage is nearly full: the current script and balloons were not saved');
      this._willed();
      return true;
    }
    log.once('state-write', 'ghost state could not be saved (storage blocked or full)');
    return false;
  }

  /** After a write: the will on this ghost's engine lock (`sumika:<id>`, GhostLock's name). */
  _willed() {
    if (!this._will) return;
    try { this._will(`${NS}:${this.ghostId}`, this.key); } catch (e) { /* the hub's stamp is a bonus */ }
  }

  _write(text) {
    try {
      this.storage.setItem(this.key, text);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Forget everything stored for this ghost (keeps listeners and collectors); a newer stored state stays stored. */
  clear() {
    if (this._timer) { this.clock.clearTimeout(this._timer); this._timer = null; }
    if (this.newer) log.once('state-newer-clear', 'the stored ghost state is newer than this page: not cleared');
    else { try { this.storage.removeItem(this.key); } catch (e) { /* ignore */ } }
    this.data = defaultState();
    this._unknown = {};
    this.isNew = true;
  }

  /** Write synchronously whenever the page may go away (pagehide, tab hidden). */
  bindPage(win = globalThis.window, doc = globalThis.document) {
    if (this._unbind || !win || !win.addEventListener) return;
    const flush = () => { if (this._timer || this.collectors.size) this.saveNow(); };
    const vis = () => { if (doc && doc.visibilityState === 'hidden') flush(); };
    win.addEventListener('pagehide', flush);
    if (doc) doc.addEventListener('visibilitychange', vis);
    this._unbind = () => {
      win.removeEventListener('pagehide', flush);
      if (doc) doc.removeEventListener('visibilitychange', vis);
    };
  }

  dispose() {
    if (this._timer) { this.clock.clearTimeout(this._timer); this._timer = null; }
    this._throughQueued = false;
    if (this._unbind) this._unbind();
    this._unbind = null;
    this.collectors.clear();
  }
}

/**
 * sessionStorage marker: present = this tab already booted the ghost, so a page load resumes silently. Several ghosts
 * (v2, ghostset.js markerRecord / markerGhosts / markerCarry) add `ghosts` and `carry`, which pass through here; the
 * v1 mirror `ghost` (= ghosts[0]) stays required. Its version `v` (schema.js SCHEMA.marker) is written with `booted`
 * and hidden by read(); an unmarked one is 2 with a `ghosts` array, else 1, which read() brings up (markerV1toV2). A
 * newer one is read for what fits (a resume, never a cold boot); each page writes its own version, since the marker is
 * a message to the next page.
 */
export const sessionMarker = {
  /**
   * @returns {{booted:boolean, ghost:string, sessionEpochMs:number, pending?:true, change?:object|null,
   *            ghosts?:string[], carry?:object}|null}
   */
  read(store = tabSession) {
    try {
      const s = store.get(SESSION_KEY);
      const raw = s ? JSON.parse(s) : null;
      if (!isObj(raw)) return null;
      const mark = 'v' in raw ? raw.v : Array.isArray(raw.ghosts) ? 2 : 1;
      const { rec } = upgrade('marker', raw, mark);
      if (!isObj(rec)) return null;
      const { v, ...m } = rec;
      return m.booted && typeof m.ghost === 'string' ? m : null;
    } catch (e) {
      return null;
    }
  },
  write(info, store = tabSession) {
    try { store.set(SESSION_KEY, JSON.stringify({ booted: true, ...info, v: SCHEMA.marker })); } catch (e) { /* ignore */ }
  },
  clear(store = tabSession) {
    try { store.remove(SESSION_KEY); } catch (e) { /* ignore */ }
  },
};

/** Time of the user's last input on any page of this tab (OnSecondChange R4 = idle seconds). */
export class InputClock {
  constructor({ store = tabSession, clock = realClock, flushMs = 1000 } = {}) {
    this.store = store;
    this.clock = clock;
    this.flushMs = flushMs;
    const saved = Number(store.get(LAST_INPUT_KEY));
    this.ms = Number.isFinite(saved) && saved > 0 ? saved : clock.now();
    this._written = this.ms;
    this._off = null;
  }

  touch() {
    this.ms = this.clock.now();
    if (this.ms - this._written >= this.flushMs) this.flush();
  }

  flush() {
    this._written = this.ms;
    this.store.set(LAST_INPUT_KEY, String(this.ms));
  }

  idleSeconds(now = this.clock.now()) {
    return Math.max(0, Math.floor((now - this.ms) / 1000));
  }

  /** Track pointer, key, wheel and touch input on the page. */
  bindPage(win = globalThis.window) {
    if (this._off || !win || !win.addEventListener) return;
    const f = () => this.touch();
    const opts = { capture: true, passive: true };
    const types = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    for (const t of types) win.addEventListener(t, f, opts);
    const hide = () => this.flush();
    win.addEventListener('pagehide', hide);
    this._off = () => {
      for (const t of types) win.removeEventListener(t, f, opts);
      win.removeEventListener('pagehide', hide);
    };
  }

  dispose() { if (this._off) this._off(); this._off = null; }
}

/**
 * Site-wide runtime preferences, kept next to the ghost states: `ghosts` (the ghosts on screen, set order; absent =
 * [ghost]: ghostset.js chooseSet), `ghost` (= ghosts[0]: older code reads it), `rev` (+1 on every set write; the
 * site's set messages carry it), `lang` ('ja' | 'en' | 'system', UI §2.10), `user` (the visitor's user information
 * from the Preferences box: core/user.js, UI §2.13; absent until the box was saved). set() merges a patch: a write of
 * some keys keeps the others. The record's version `v` (schema.js SCHEMA.prefs) lives in storage only: set() writes
 * it, get() leaves it out. A record a newer runtime wrote is read for what fits and never written (newer(); set()
 * answers false).
 */
export const runtimePrefs = {
  /** the stored prefs (without `v`); {} when none or unreadable */
  get(storage = defaultStorage()) {
    return readPrefs(storage).rec;
  },
  /** the stored prefs are newer than this runtime: set() writes nothing (Site.start / _writeSet: staleCheck) */
  newer(storage = defaultStorage()) {
    return readPrefs(storage).newer;
  },
  /** Merge a patch into the stored prefs: false (nothing written, logged once) when they are newer, else true (best effort). */
  set(patch, storage = defaultStorage()) {
    const cur = readPrefs(storage);
    if (cur.newer) {
      log.once('prefs-newer', `the stored runtime prefs have version ${cur.v}, newer than this page's ${SCHEMA.prefs}: not written`);
      return false;
    }
    try { storage.setItem(RUNTIME_KEY, JSON.stringify({ ...cur.rec, ...patch, v: SCHEMA.prefs })); } catch (e) { /* ignore */ }
    return true;
  },
};

/** The runtime prefs' hook (schema.js upgrade): {rec (without `v`), v, newer}. */
function readPrefs(storage) {
  let raw;
  try {
    raw = JSON.parse(storage.getItem(RUNTIME_KEY) || 'null');
  } catch (e) {
    raw = null;
  }
  if (!isObj(raw)) return { rec: {}, v: SCHEMA.prefs, newer: false };
  const up = upgrade('prefs', raw, raw.v);
  const { v, ...rec } = isObj(up.rec) ? up.rec : {};
  return { rec, v: up.v, newer: up.newer };
}

/**
 * One engine per ghost per browser (SUMMARY §2.5, R8). Web Locks when available; otherwise a BroadcastChannel
 * handshake; otherwise every tab runs (nothing better is possible).
 * The holder emits 'takeover-request' when another tab asks for the ghost; it decides when to release().
 * The same lock serves locks that are no ghost's: an id starting with '/' (no folder id does) is named
 * `sumika/<rest>` like the drop index lock `sumika/drops`, so the lead lock ghostset.js LEAD_ID '/lead' (the tab that
 * runs the set) is `sumika/lead`, apart from every ghost's `sumika:<id>`.
 */
export class GhostLock extends Emitter {
  /**
   * @param {string} ghostId a ghost's folder id, or '/<name>'
   * @param {{locks?: LockManager|null, Channel?: typeof BroadcastChannel|null, probeMs?: number}} o
   */
  constructor(ghostId, { locks, Channel, probeMs = 250 } = {}) {
    super();
    const id = String(ghostId);
    this.name = id.startsWith('/') ? `${NS}${id}` : `${NS}:${id}`;
    // core/platform.js: navigator.locks and BroadcastChannel, or the storage hub's (made after the hub decided)
    this.locks = locks !== undefined ? locks : lockManager();
    const C = Channel !== undefined ? Channel : channelClass();
    this.probeMs = probeMs;
    this.held = false;
    this.disposed = false;    // a wait still queued then lets go at once (a ghost change, a tab following one)
    this.tabId = Math.random().toString(36).slice(2);
    this._release = null;
    this._waiting = null;
    this.channel = null;
    if (C) {
      try {
        this.channel = new C(this.name);
        this.channel.onmessage = ev => this._onMessage(ev.data || {});
      } catch (e) {
        this.channel = null;
      }
    }
  }

  get mechanism() { return this.locks ? 'locks' : this.channel ? 'broadcast' : 'none'; }

  _post(msg) {
    if (!this.channel) return;
    try { this.channel.postMessage({ ...msg, from: this.tabId }); } catch (e) { /* closed */ }
  }

  _onMessage(m) {
    if (m.from === this.tabId) return;
    if (m.t === 'takeover' && this.held) this.emit('takeover-request');
    else if (m.t === 'who' && this.held && !this.locks) this._post({ t: 'held' });
    else if (m.t === 'held' && this._probe) this._probe.answered = true;
    else if (m.t === 'released' && this._waiting && !this.locks) this._waiting();
  }

  /**
   * @param {{wait?: boolean}} o wait=false: answer immediately; wait=true: resolve once the holder releases.
   * @returns {Promise<boolean>} true when this tab now holds the ghost
   */
  async acquire({ wait = false } = {}) {
    if (this.held) return true;
    if (this.disposed) return false;
    if (this.locks) return this._acquireLocks(wait);
    if (!this.channel) return (this.held = true);
    for (;;) {
      const probe = { answered: false };
      this._probe = probe;
      this._post({ t: 'who' });
      await new Promise(r => setTimeout(r, this.probeMs));
      if (this._probe === probe) this._probe = null;
      if (this.disposed) return false;
      if (!probe.answered) return (this.held = true);
      if (!wait) return false;
      await new Promise(r => { this._waiting = r; setTimeout(r, 5000); });
      this._waiting = null;
    }
  }

  _acquireLocks(wait) {
    return new Promise(resolve => {
      let settled = false;
      const p = this.locks.request(this.name, wait ? {} : { ifAvailable: true }, lock => {
        if (!lock || this.disposed) { settled = true; resolve(false); return undefined; }
        this.held = true;
        settled = true;
        resolve(true);
        return new Promise(r => { this._release = r; });
      });
      Promise.resolve(p).catch(e => {
        log.once('lock-failed', 'engine lock unavailable; running without it', e);
        if (!settled) { this.held = true; resolve(true); }
      });
    });
  }

  /** Ask the tab holding the ghost to hand it over (it releases when it is hidden). */
  requestTakeover() { this._post({ t: 'takeover' }); }

  release() {
    if (!this.held) return;
    this.held = false;
    if (this._release) { this._release(); this._release = null; }
    if (!this.locks) this._post({ t: 'released' });
  }

  dispose() {
    this.disposed = true;
    this.release();
    if (this._waiting) this._waiting();
    if (this.channel) { try { this.channel.close(); } catch (e) { /* ignore */ } }
    this.channel = null;
  }
}

// KAWARI (華和梨) Phase 8.2.8, compiled from vendor/kawari-8.2.8 by engines/kawari/build.py
// (docs/research/kawari-wasm.md §1, §2). The ghost runs in YAYA's SSP-like MEMFS (./ssproot.js):
// /ssp/ghost/<id>/ghost/master/ is its data path, the site's other ghosts are beside it and every file it writes under
// its root persists. Kawari is Shift_JIS inside: the build converts at the SHIORI and SAORI edges and for file names
// (patches K4-K6), so requests and replies here are UTF-8 as for the other engines; the other ghosts' descript.txt are
// written in code page 932, as Kawari ghosts textload them.
// Kawari has no state but its dictionary and no save of its own (the ghost saves what it wants, often only in
// System.Callback.OnUnload), and a page change never unloads. So save() takes a snapshot of the entries this session
// changed and of those its load made (patch K12: kawari-wasm.md §8), stored under one reserved key next to the ghost's
// files, and the next page's load restores it (kawari-wasm.md §8: the resume, D6, D7). A cold boot that finds the
// snapshot of a session that never unloaded (a tab closed) closes that session first, as ssp.exe closes ghosts when
// Windows ends the session: restore, the close events and OnUnload at the time that session ended, then the cold load
// (D6, kawari-wasm.md §8).
import { SspRootShiori, rootBridge, sspDescript, dicStamp, clock, ms, toU8 } from './ssproot.js';
import { buildRequest, parseResponse, BASE_HEADERS } from '../../core/shiori.js';

const enc = new TextEncoder();
const latin1 = new TextDecoder('latin1');

/**
 * The snapshot's key in the ghost's stored files (`?` never occurs in a Windows file name, so no ghost file has it).
 * Three states: absent (never met), an empty buffer (met, nothing to restore: the session ended with an unload, D7, or
 * its last save found nothing changed [decision: a ghost that booted is met, even when its tab was closed]), bytes
 * (the entries the last session changed, from stampSnapshot).
 */
export const RESUME_KEY = '?kawari/resume.kis';
/** The snapshot in MEMFS: outside /ssp/, so the ghost never sees it and scan() never reports it. */
const SNAPSHOT_DIR = '/sumika';
const SNAPSHOT = `${SNAPSHOT_DIR}/resume.kis`;
const STAMP_LINE = /^# dicStamp ([0-9a-f]{8})\r?\n/;
const NO_KAWARIRC = 'no kawarirc.kis: nothing to load';
const SSP_GHOSTS_LEN = '/ssp/ghost/'.length;

/** D6's info line (kawari-wasm.md §8). */
export const D6_FINISHED = 'the last session ended without Close: it was closed from its snapshot (OnClose "system", OnUnload) before this boot';
/**
 * The References ssp.exe 2.9.10 closes every ghost with when Windows ends the session (shutdown, logoff): OnEndSession
 * 0x46dd50 -> ForceQuitApplication(L"system", 0, 0) -> GhostExitProc -> CloseGhostProc(…, true, 0, 0) ->
 * SPShiori::OnGhostClose 0x7106e0: R0 the reason, R1 and R2 as %d [disasm] (shiori-events.md §2.3.1).
 */
export const END_SESSION_REFS = Object.freeze(['system', '0', '0']);

/** One of D6's close requests as SHIORI/3.0 text with the page's base headers (Kawari 7's request() bridges it). */
export function endSessionRequest(id, refs = END_SESSION_REFS, headers = {}) {
  return buildRequest({ id, refs, headers }, BASE_HEADERS);
}

/** A reply's script as the page reads one (events.js valueOf): a 2xx with a non-empty Value; else null. */
const scriptOf = text => {
  const r = parseResponse(text);
  return r.status >= 200 && r.status < 300 && r.value ? r.value : null;
};

/**
 * Whether `text` comes back unchanged from code page 932: `encode` = the build's encoder (ssp.exe's best fit), the
 * way back = MultiByteToWideChar(932), which the Encoding Standard's shift_jis decoder matches for every byte pair the
 * encoder writes. No encoder (an old build): true.
 * @param {string} text  @param {(t: string) => Uint8Array|null} encode
 */
export function cp932Writable(text, encode) {
  const bytes = encode(text);
  if (!bytes) return true;
  return new TextDecoder('shift_jis').decode(bytes) === text;
}

/**
 * fn() with Date.now running on from `startMs` (epoch ms), then the clock it had again, even when fn throws (D6,
 * kawari-wasm.md §8): Kawari's time() (emscripten_date_now, the only clock import of both Kawari builds), MEMFS's
 * mtimes and the SAORI stand-ins follow it; performance.now and `new Date()` do not. Whatever Date.now is now (a test's
 * fake, the sweep's clock) is what runs on and what comes back. A start that is not before now (0: unknown, NaN, the
 * future) leaves the clock alone.
 * @param {number} startMs  @param {() => void} fn
 * @returns {number} the start used; 0 when fn ran on the clock as it was
 */
export function runAt(startMs, fn) {
  const now = Date.now;
  const t0 = now();
  if (!(Number.isFinite(startMs) && startMs > 0 && startMs < t0)) { fn(); return 0; }
  Date.now = () => startMs + (now() - t0);
  try { fn(); } finally { Date.now = now; }
  return startMs;
}

/**
 * A snapshot as it is stored: its first line names the dictionaries it was taken against (a comment for Kawari's
 * loader), so a boot can tell a snapshot of other dictionaries even when the page sent no engine state (a cold boot:
 * the worker passes `volatile` only on a resume) [decision].
 * @param {string} stamp dicStamp  @param {Uint8Array} body _kawari_snapshot's file (code page 932) @returns {Uint8Array}
 */
export function stampSnapshot(stamp, body) {
  const head = enc.encode(`# dicStamp ${stamp}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** The dicStamp a stored snapshot names; null when it is empty or names none. */
export function snapshotStamp(bytes) {
  const u8 = toU8(bytes);
  const m = STAMP_LINE.exec(latin1.decode(u8.subarray(0, 40)));
  return m ? m[1] : null;
}

/**
 * The kind of one of Kawari's log lines, for onEngineLog: the lexer marks its own ('<file> <line>: error: …',
 * '…: warning: …'); every other line the logger lets through (at the default level error|warning: a KIS command's
 * error, such as 'load : load failed x') carries no marker [infer: src libkawari/kawari_lexer.h:213-221].
 */
export function kawariLogMode(text) {
  const s = String(text);
  if (/: error: /.test(s)) return 'error';
  if (/: warning: /.test(s)) return 'warning';
  return 'log';
}

const sameBytes = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const copyBuffer = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

export class KawariEngine extends SspRootShiori {
  /**
   * @param {{engineUrl: string, ghostDir?: string, log?: Function, saori?: object, opts?: object|null,
   *   onEngineLog?: Function|null}} o opts: the worker's engineOpts ({ghostId, placeholders, site: {ghosts,
   *   balloons}}); onEngineLog({mode, text}): Kawari's own log lines (kawariLogMode) for in-process users (the sweep,
   *   tests). ghostDir is not used: the ghost lives at /ssp/ghost/<id>/ghost/master/
   */
  constructor(o) {
    super(o);
    this.entries = 0;        // _kawari_baseline() after the last load
    this.resumed = '';       // what init did with a stored snapshot: '' | 'restored' | 'finished' | 'dropped'
    this.d6Close = null;     // closeFromOutside()'s result in D6 (tests, the sweep); null when D6 sent no close
    this.d6At = 0;           // the clock D6's close and unload ran on: the session's end (epoch ms); 0 = the real clock
    this._snapKnown = null;  // the snapshot key's value as the store has it after our reports (Uint8Array; null: absent)
    this._snapOut = null;    // its next value, not reported yet
  }

  async factory() {
    if (typeof self.createKawari !== 'function') importScripts(this.engineUrl);
    return self.createKawari;
  }

  async boot() {
    const t0 = clock();
    await super.boot({
      saoriBridge: rootBridge(this.saori, this.ghostRoot),
      kawariLog: text => this._kawariLog(text),      // patches K8/K9: one call per line, UTF-8, error|warning
    });
    this.timing.module = clock() - t0;
  }

  /**
   * @param {{path: string, data: ArrayBuffer}[]} files the site's files with bytes, ghost-root-relative
   * @param {Record<string, ArrayBuffer|null>} persisted the visitor's files, ghost-root-relative (null: deleted), and
   *   the snapshot key
   * @param {{resume?: boolean, volatile?: object|null, sessionEndMs?: number}} o volatile: the page's stored engine
   *   state on a resume ({dicStamp} of the last boot); the worker's bootEpochMs is not used (Kawari's clock is the
   *   date); sessionEndMs: on a cold boot, the page's last write of the ghost state (its savedAt, flushed at pagehide):
   *   D6 runs the last session's close and unload on a clock from there (runAt), then the real clock again; 0 = unknown
   * A stored snapshot is dropped (a site update), restored (a resume) or, on a cold boot, finished (D6): restore, the
   * close from outside (closeFromOutside), OnUnload, then the cold load.
   */
  init(files, persisted = {}, { resume = false, volatile = null, sessionEndMs = 0 } = {}) {
    const M = this.M;
    const t0 = clock();
    this.dicStamp = dicStamp(files);
    const stampMs = clock() - t0;
    // a resume after a site update loads cold, and the snapshot (of the old dictionaries) is dropped: D6 does not run
    const stale = this._stampChanged(resume, volatile);
    if (stale) resume = false;
    const own = { ...(persisted || {}) };
    const key = this.resumeKey;
    const stored = Object.prototype.hasOwnProperty.call(own, key) ? own[key] : undefined;
    delete own[key];
    this._snapKnown = stored ? toU8(stored).slice() : stored === undefined ? null : new Uint8Array(0);
    this._snapOut = null;
    this.resumed = '';
    this.d6Close = null;
    this.d6At = 0;
    const placeholders = this._mount(files, own);
    this.mkdirs(SNAPSHOT_DIR);
    const pre = this.scan();
    const preHot = this._hot(pre);
    // the first report is what load (and D6's close and unload) wrote, which the worker stores at once (as YAYA's)
    const report = ok => {
      this.baseline = pre;
      this.hot = preHot;
      return ok;
    };
    // K4 hands Kawari its folder in code page 932 (best fit) and K6 turns each path back: a site id 932 lacks a
    // character of (café -> cafe, 〜 -> ?) would load nothing from another folder, a silent ghost (kawari-wasm.md §9)
    const folder = this.ghostRoot.slice(SSP_GHOSTS_LEN, -1);
    if (!cp932Writable(folder, t => this._cp932(t))) {
      this.log('warn', `site id "${folder}" is not writable in code page 932: Kawari would not find its files`);
      return report(false);
    }
    if (!M.FS.analyzePath(this.ghostDir + this.rcFile).exists) {      // any case: CASE_INSENSITIVE_FS
      // Kawari's load never fails: without its rc file (kawarirc.kis; Phase 7's kawari.ini) it would answer 204 to
      // everything (kawari-wasm.md §9)
      this.log('warn', this.rcFile === 'kawarirc.kis' ? NO_KAWARIRC : `no ${this.rcFile}: nothing to load`);
      return report(false);
    }
    const t1 = clock();
    let ok = this._load();
    this.timing.load = clock() - t1;
    const snap = this._snapKnown && this._snapKnown.length ? this._snapKnown : null;
    if (ok && snap) {
      if (stale || snapshotStamp(snap) !== this.dicStamp) {
        if (!stale) this.log('info', 'the snapshot of the last session is of other dictionaries: dropped');
        this._forget();
        this.resumed = 'dropped';
      } else if (resume) {
        // a page change: the entries the session changed and those the first load made come back over what this load
        // set (no OnBoot, as every engine)
        if (this._restore(snap)) this.resumed = 'restored';
      } else {
        // D6 [decision: kawari-wasm.md §16]: the last session ended without an unload (a tab closed, a crash), so it is
        // closed first as ssp.exe closes a session Windows ends (closeFromOutside): its snapshot restored, the close
        // events (replies dropped), OnUnload (the ghost's own saves; the first report stores all of it), then the cold
        // boot. A snapshot that did not load gets no close: there is no session to close, only the unload.
        this.log('info', D6_FINISHED);
        const restored = this._restore(snap);
        // at the session's end, as ssp.exe runs them inside WM_ENDSESSION's handler, which waits for the quit
        // (WaitForApplicationQuit -> WaitPump(-1) 0x46dda8 [disasm]; shiori-events.md §2.3.1): the close and the unload
        // on a clock from sessionEndMs (a ghost stamps its OnClose / OnUnload with that time, as in SSP), the cold load
        // and everything after on the real clock
        this.d6At = runAt(sessionEndMs, () => {
          if (restored) this.d6Close = this.closeFromOutside();
          try { this._stackGuard(() => M._unload()); } catch (e) { this.log('error', `unload: ${e}`); }
        });
        if (this.d6At) {
          this.log('debug', `${this.name}: closed at the session's end, ${Math.round((Date.now() - this.d6At) / 60000)} min before this boot`);
        }
        ok = this._load();
        this._forget();
        this.resumed = 'finished';
      }
    }
    const bytes = (files || []).reduce((n, f) => n + toU8(f.data).length, 0);
    this.log('debug', `${this.name}: module ${ms(this.timing.module)} ms, load ${ms(this.timing.load)} ms, stamp ${ms(stampMs)} ms, ` +
      `heap ${(M.HEAPU8.length / 1048576).toFixed(0)} MB, ${(files || []).length} files ${(bytes / 1024).toFixed(0)} KB, ` +
      `${placeholders} placeholders, ${this.entries} entries${this.resumed ? `, snapshot ${this.resumed}` : ''}`);
    return report(ok);
  }

  /** the snapshot's key in the stored files (RESUME_KEY; another one per engine) */
  get resumeKey() { return RESUME_KEY; }
  /** the file whose absence means nothing to load */
  get rcFile() { return 'kawarirc.kis'; }
  /** the engine's name in the debug log */
  get name() { return 'kawari'; }

  /** _load, then the baseline the snapshots are taken against (patch K12). */
  _load() {
    const ok = this.callLoad(this.ghostDir, false);
    this.entries = ok && typeof this.M._kawari_baseline === 'function' ? this._stackGuard(() => this.M._kawari_baseline()) : 0;
    return ok;
  }

  /** A stored snapshot into the running engine (after its load and baseline); false (logged) when it did not load. */
  _restore(snap) {
    const M = this.M;
    let r = 0;
    try {
      M.FS.writeFile(SNAPSHOT, snap);
      r = this._withPath(SNAPSHOT, p => this._restoreCall(p));
    } catch (e) {
      this.log('error', `kawari_restore: ${e}`);
    }
    if (r !== 1) this.log('warn', 'the resume snapshot did not load: this page goes on from the ghost\'s own save');
    return r === 1;
  }

  /** the engine's restore export on a MEMFS path (a pointer): 1 when it loaded */
  _restoreCall(p) { return this.M._kawari_restore(p); }
  /** the engine's snapshot export: its size, 0 = nothing, -1 = failed */
  _snapshotCall(p) { return this.M._kawari_snapshot(p, 0); }
  /** whether the build has the snapshot exports */
  _canSnapshot() { return typeof this.M._kawari_snapshot === 'function'; }

  /** The stored snapshot is done with: the key becomes the empty marker (met, nothing to restore) at the next report. */
  _forget() {
    const empty = new Uint8Array(0);
    if (!sameBytes(this._snapKnown, empty)) this._snapOut = empty;
    this._snapKnown = empty;
  }

  /** fn(pointer to `path` as a NUL-terminated UTF-8 string), freed after; under the stack guard. */
  _withPath(path, fn) {
    const b = enc.encode(path);
    const p = this._toHeap(b);
    try {
      return this._stackGuard(() => fn(p));
    } finally {
      this.M._free(p);
    }
  }

  /**
   * The worker's save (debounced, urgent after choices, at page hide): a snapshot of the entries that differ from this
   * load's baseline and of those the load made (K12: left by load with other words than its definitions, changed or
   * not; kawari-wasm.md §8), reported under RESUME_KEY by the next changedFiles() when its bytes changed. Nothing to
   * carry = the empty marker. Entries restored from the last page differ from this one's baseline too, so they stay in
   * it.
   * @returns {boolean} a snapshot was taken
   */
  save() {
    const M = this.M;
    if (!M || !this._canSnapshot()) return false;
    let n = -1;
    const dirty = this.dirty;          // /sumika/ is outside the ghost root: writing the snapshot changes no ghost file
    try {
      this.mkdirs(SNAPSHOT_DIR);
      n = this._withPath(SNAPSHOT, p => this._snapshotCall(p));
    } catch (e) {
      this.log('error', `kawari_snapshot: ${e}`);
      return false;
    } finally {
      this.dirty = dirty;
    }
    if (n < 0) return false;
    const bytes = n > 0 ? stampSnapshot(this.dicStamp, M.FS.readFile(SNAPSHOT)) : new Uint8Array(0);
    if (!sameBytes(bytes, this._snapKnown)) {
      this._snapOut = bytes;
      this._snapKnown = bytes;
    }
    return true;
  }

  /** The ghost's files changed since the last report (SspRootShiori), and the snapshot key when it changed. */
  changedFiles() {
    const out = super.changedFiles();
    if (this._snapOut) {
      out[this.resumeKey] = copyBuffer(this._snapOut);
      this._snapOut = null;
    }
    return out;
  }

  /**
   * The close ssp.exe 2.9.10 sends each ghost when the session ends from outside (Windows' WM_ENDSESSION; the model of a
   * tab closed without Close, shiori-events.md §2.3.1): GET OnCloseAll [system, 0, 0] BaseID OnClose; when its reply
   * has no script, GET OnClose with the same References; the ghost's script through GET OnTranslate [R0 as returned,
   * R1 '', R2 the event that answered, R3 system] (with the force flag TranslateScript runs before ModuleUnload) [disasm
   * CloseGhostProc 0x4967a2-0x49694a, OnGhostClose 0x7106e0, Translate 0x7135f0]. Every reply is dropped: no page plays
   * it (ssp.exe plays it after the unload while Windows waits). A request that throws answers 500 (the stack restored)
   * and the close goes on. Kawari 7's request() bridges each one to SHIORI/2.x. D6 runs it before the unload; the sweep
   * on a resumed engine.
   * @returns {{steps: {id: string, status: number}[], ms: number}}
   */
  closeFromOutside() {
    const t0 = clock();
    const steps = [];
    const ask = (id, refs, headers = {}, kind = '') => {
      let reply = '';
      try {
        reply = this.request(endSessionRequest(id, refs, headers), kind ? { kind } : {});
      } catch (e) {
        this.log('error', `${id}: ${e}`);
      }
      steps.push({ id, status: parseResponse(reply).status });
      return scriptOf(reply);
    };
    let id = 'OnCloseAll';
    let script = ask(id, END_SESSION_REFS, { BaseID: 'OnClose' });
    if (!script) {
      id = 'OnClose';
      script = ask(id, END_SESSION_REFS);
    }
    // a ghost that answered neither gets ssp.exe's own #terminate script, which Sumika does not have (as at Quit)
    if (script) ask('OnTranslate', [script, '', id, END_SESSION_REFS[0]], {}, 'translate');
    const t = clock() - t0;
    const list = steps.map(s => `${s.id} ${s.status}`).join(', ');
    this.log('debug', `${this.name}: closed from outside: ${list} (${ms(t)} ms)`);
    return { steps, ms: t };
  }

  /**
   * Close, a ghost change, Quit: _unload runs System.Callback.OnUnload (the ghost saves itself), then the snapshot key
   * becomes the empty marker (D7: met, nothing to restore). After an unload that threw, the last snapshot stays.
   */
  unload() {
    let ok = true;
    try { this._stackGuard(() => this.M._unload()); } catch (e) { ok = false; this.log('error', `unload: ${e}`); }
    if (ok) this._forget();
    return this.changedFiles();
  }

  /** Another site ghost's descript.txt in code page 932 saying charset,Shift_JIS (kawari-wasm.md §6; UTF-8 without the export). */
  _descript(g) {
    const cp932 = this._cp932(sspDescript(g, 'Shift_JIS'));
    return cp932 || enc.encode(sspDescript(g));
  }

  /** UTF-8 text -> code page 932 bytes with the build's encoder (ssp.exe's best fit; '?' for what 932 lacks). */
  _cp932(text) {
    const M = this.M;
    const conv = M[this.cp932Export];
    if (typeof conv !== 'function') return null;
    const b = enc.encode(text);
    const p = this._toHeap(b);
    const lenp = M._malloc(4);
    try {
      const r = conv(p, b.length, lenp);
      if (!r) return null;
      const out = M.HEAPU8.slice(r, r + M.HEAP32[lenp >> 2]);
      M._free(r);
      return out;
    } finally {
      M._free(lenp);
      M._free(p);
    }
  }

  /** the build's UTF-8 -> code page 932 export */
  get cp932Export() { return '_kawari_utf8_to_cp932'; }

  /** Kawari's log: the page console at debug (?sumika-debug), and onEngineLog. */
  _kawariLog(text) {
    const line = String(text == null ? '' : text);
    if (!line.trim()) return;
    this.log('debug', `${this.name}: ${line}`);
    this._engineLog({ mode: kawariLogMode(line), text: line });
  }
}

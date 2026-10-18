// The SSP-shaped MEMFS that YAYA and Kawari ghosts run in (yaya-wasm.md, MEMFS and persistence; kawari-wasm.md §6, §7),
// moved out of yaya.js unchanged: /ssp/ghost/<id>/ is the ghost's root and the persistence root, /ssp/ghost/ lists the
// site's ghosts (each other one with a ghost/master/descript.txt) and /ssp/balloon/ its balloons, so
// ../../updates2.dau, ../../shell/<x>/, ../../notelog/ and FENUM('..\..\..') / readdir ../../.. behave as in an SSP
// install. What the visitor's run changes under the root is kept (persistence): bytes for new and rewritten files (a
// rewritten shipped file shadows the site's copy), null for a shipped file the ghost deleted, false for a file of its
// own it deleted. The root is scanned only after a write (watchWrites), by a walk over MEMFS's nodes
// (kawari review: bthver.5's 1,507 files cost 16 ms a request by path).
import { EmscriptenShiori, ntfsOrder } from './emscripten.js';

const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);     // a placeholder's bytes (identity counts the placeholders written)
const LOG_FILE = /\.log$/i;          // a log file never persists (yaya-wasm.md, persistence)
const GHOST_MASTER = 'ghost/master/';
const SSP_GHOSTS = '/ssp/ghost/';
/**
 * The FS calls that can change a file's bytes, stamp or name (every syscall reaches MEMFS through these properties of
 * the one FS object, as FS.writeFile and the page's own writes do). `open` only with write access, O_CREAT or O_TRUNC.
 */
const WRITE_OPS = ['write', 'truncate', 'ftruncate', 'allocate', 'msync', 'unlink', 'rmdir', 'rename', 'mknod', 'mkdir',
  'symlink', 'utime'];
const O_WRITE = 1 | 2 | 64 | 512 | 1024;      // O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND (Emscripten's values)
/** FS.open's string flags that only read (any other string counts as a write) */
const READ_ONLY = new Set(['r', 'rs']);

/**
 * Sets `owner.dirty` whenever the engine's FS may have changed a file: the worker scans the ghost root after a request
 * only then (a request that wrote nothing costs no scan). Installed once per module.
 */
export function watchWrites(FS, owner) {
  if (!FS || FS.__sumikaWatch) {
    if (FS) FS.__sumikaWatch.owner = owner;
    return;
  }
  const w = { owner };
  Object.defineProperty(FS, '__sumikaWatch', { value: w });
  const mark = () => { if (w.owner) w.owner.dirty = true; };
  for (const name of WRITE_OPS) {
    const fn = FS[name];
    if (typeof fn !== 'function') continue;
    FS[name] = function (...args) { mark(); return fn.apply(this, args); };
  }
  const open = FS.open;
  if (typeof open === 'function') {
    FS.open = function (path, flags, ...rest) {
      if (typeof flags === 'string' ? !READ_ONLY.has(flags) : (flags | 0) & O_WRITE) mark();
      return open.call(this, path, flags, ...rest);
    };
  }
}

/** The info line of a resume whose dictionaries changed since the last boot (the sweep and the tests match it). */
export const STAMP_CHANGED = 'dictionaries changed since the last boot: loading as after an update';

export const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
export const ms = t => (t || 0).toFixed(0);
export const toU8 = d => (d instanceof Uint8Array ? d : d ? new Uint8Array(d) : EMPTY);
/** 32-bit FNV-1a over bytes, going on from h */
const fnv1a = (u8, h = 0x811c9dc5) => {
  for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193);
  return h;
};

/** A site id as one folder name. */
const safe = id => {
  const s = String(id == null ? '' : id).replace(/[\\/]/g, '_');
  return s && s !== '.' && s !== '..' ? s : '_';
};

/**
 * The SAORI bridge (src/worker/saori) as Satori's ghosts use it: YAYA and Kawari pass full MEMFS paths
 * (/ssp/ghost/<id>/ghost/master/saori/x.dll), the stand-ins and the page (pathFromDll) expect ghost-root ones
 * (/ghost/master/saori/x.dll). Paths outside the root pass unchanged.
 */
export function rootBridge(bridge, root) {
  if (!bridge) return bridge;
  const pre = String(root);
  const lower = pre.toLowerCase();
  const strip = p => {
    const s = String(p == null ? '' : p);
    if (s.length >= pre.length && s.slice(0, pre.length).toLowerCase() === lower) return '/' + s.slice(pre.length);
    return (s + '/').toLowerCase() === lower ? '/' : s;
  };
  return {
    load: (path, dir) => bridge.load(strip(path), strip(dir)),
    request: (handle, bytes) => bridge.request(handle, bytes),
    unload: handle => bridge.unload(handle),
  };
}

/**
 * descript.txt of another site ghost: what YAYA templates read of the installed ghosts (name, sakura.name, kero.name;
 * emily4's StructInstalledGhostList) and KEEPS' installed-ghost scan textloads, from the index entry, one line per
 * value. `charset` names the encoding the caller writes it in (Kawari: Shift_JIS, kawari-wasm.md §6).
 */
export function sspDescript(g, charset = 'UTF-8') {
  const v = x => String(x == null ? '' : x).replace(/[\r\n]/g, '');
  const o = g || {};
  return [`charset,${charset}`, 'type,ghost', `name,${v(o.name)}`, `sakura.name,${v(o.sakuraName)}`, `kero.name,${v(o.keroName)}`,
    `craftman,${v(o.craftman)}`, `shiori,${v(o.shiori)}`, ''].join('\r\n');
}

/** YAYA's log comes in fragments ('// ', then '- /path\n'): whole lines come out, with their first fragment's mode. */
export class LogLines {
  constructor() {
    this.buf = '';
    this.mode = 0;
    this.open = false;
  }

  /** @returns {{mode: number, text: string}[]} the lines this fragment completed (blank ones dropped) */
  push(text, mode) {
    const out = [];
    let s = String(text == null ? '' : text);
    while (s) {
      if (!this.open) { this.open = true; this.mode = mode; }
      const i = s.indexOf('\n');
      if (i < 0) { this.buf += s; break; }
      this.buf += s.slice(0, i);
      s = s.slice(i + 1);
      this._end(out);
    }
    return out;
  }

  /** The line still open (none: []). */
  flush() {
    const out = [];
    if (this.open) this._end(out);
    return out;
  }

  _end(out) {
    const text = this.buf.replace(/\r/g, '').trimEnd();
    if (text.trim()) out.push({ mode: this.mode, text });
    this.buf = '';
    this.open = false;
  }
}

const goneValue = (p, inputs) => (inputs && inputs.has(p.toLowerCase()) ? null : false);

/**
 * What changed under the ghost root since the last report: new or rewritten files (`changed`), and files gone: null =
 * a shipped file (or placeholder) the ghost deleted, a tombstone so it stays deleted; false = a file of its own it
 * deleted (forget the key). *.log never counts.
 * @param {Map<string, string|number>} baseline path -> its stamp at the last report (scan)
 * @param {Map<string, string|number>} now  @param {Set<string>} inputs lower-cased paths that came from the site
 * @returns {{changed: string[], gone: Record<string, null|false>}}
 */
export function diffScan(baseline, now, inputs) {
  const changed = [];
  const gone = {};
  for (const [p, mt] of now) if (!LOG_FILE.test(p) && baseline.get(p) !== mt) changed.push(p);
  for (const p of baseline.keys()) if (!now.has(p) && !LOG_FILE.test(p)) gone[p] = goneValue(p, inputs);
  return { changed, gone };
}

/**
 * 32-bit FNV-1a (8 hex digits) over path, length and bytes of every shipped file under ghost/master/, in NTFS order.
 * A resume whose stamp differs from the last boot's loads as after an update (yaya-wasm.md, resume).
 * @param {{path: string, data: ArrayBuffer|Uint8Array}[]} files ghost-root-relative
 */
export function dicStamp(files) {
  let h = 0x811c9dc5;
  for (const f of ntfsOrder(files || [])) {
    if (!String(f.path).toLowerCase().startsWith(GHOST_MASTER)) continue;
    const data = toU8(f.data);
    h = fnv1a(data, fnv1a(enc.encode(`${f.path}\0${data.length}\0`), h));
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export class SspRootShiori extends EmscriptenShiori {
  /**
   * @param {{engineUrl: string, wasmUrl?: string|null, ghostDir?: string, log?: Function, saori?: object,
   *   opts?: object|null, onEngineLog?: Function|null}} o wasmUrl: the page's hashed .wasm (EmscriptenShiori); opts:
   *   the worker's engineOpts, plain JSON from the page ({ghostId, placeholders, site: {ghosts, balloons}} and the
   *   engine's own, such as YAYA's module); onEngineLog({mode, text}): the engine's own log lines for in-process users
   *   (the sweep, tests). ghostDir is not used: the ghost lives at /ssp/ghost/<id>/ghost/master/
   */
  constructor({ engineUrl, wasmUrl = null, ghostDir, log, saori, opts = null, onEngineLog = null }) {
    super({ engineUrl, wasmUrl, ghostDir, log, saori });
    this.opts = opts || {};
    this.onEngineLog = onEngineLog;
    this.ghostRoot = SSP_GHOSTS + safe(this.opts.ghostId || 'ghost') + '/';
    this.ghostDir = this.ghostRoot + GHOST_MASTER;
    this.timing = {};         // ms: module (fetch, compile, instantiate), load
    this.dicStamp = null;
    this.inputs = new Set();
    this.hot = new Map();     // path -> FNV-1a of the files written in the millisecond of the last report (_hot)
    this.dirty = true;        // a file may have changed since the last report (watchWrites); changedFiles() scans only then
    this.scans = 0;           // scan() calls (tests)
  }

  async boot(extra) {
    await super.boot(extra);
    watchWrites(this.M.FS, this);
  }

  /**
   * A resume whose stored dictionary stamp differs from this boot's (this.dicStamp, set first): the site was updated,
   * so it loads as after an update; logged at info. @returns {boolean} true when the resume must load cold
   */
  _stampChanged(resume, volatile) {
    if (!(resume && volatile && volatile.dicStamp && volatile.dicStamp !== this.dicStamp)) return false;
    this.log('info', STAMP_CHANGED);
    return true;
  }

  /**
   * The ghost's MEMFS before its load: the SSP view, then the site's files (a shipped file beats a placeholder) and the
   * visitor's (a tombstone removes, a copy shadows), written in NTFS order (FENUM and readdir list a folder in that
   * order, as on Windows). Sets `inputs`, the lower-cased paths that came from the site.
   * @param {{path: string, data: ArrayBuffer}[]} files  @param {Record<string, ArrayBuffer|null>} persisted
   * @returns {number} the placeholders written
   */
  _mount(files, persisted) {
    this._sspView();
    const entries = new Map();       // lower-cased path -> {path, data}
    const put = (path, data) => entries.set(String(path).toLowerCase(), { path, data });
    for (const p of this.opts.placeholders || []) put(p, EMPTY);
    for (const f of files || []) put(f.path, f.data);
    this.inputs = new Set(entries.keys());
    const own = Object.entries(persisted || {});
    for (const [p, data] of own) if (!data) entries.delete(p.toLowerCase());
    for (const [p, data] of own) if (data) put(p, data);
    let placeholders = 0;
    for (const f of ntfsOrder([...entries.values()])) {      // FENUM lists a folder in NTFS order, as on Windows
      if (f.data === EMPTY) placeholders++;
      this.writeFile(f.path, f.data);
    }
    return placeholders;
  }

  /** /ssp/: the site as an SSP install shows it (FENUM('..\..\..'), other ghosts' descript.txt, balloon folders). */
  _sspView() {
    const site = this.opts.site || {};
    this.mkdirs('/ssp/balloon');
    const balloons = ntfsOrder((site.balloons || []).map(id => ({ path: safe(id) })));
    for (const b of balloons) this.mkdirs(`/ssp/balloon/${b.path}`);
    const own = this.ghostRoot.slice(SSP_GHOSTS.length, -1);
    const ghosts = new Map([[own.toLowerCase(), { path: own, g: null }]]);
    for (const g of site.ghosts || []) {
      const path = g && g.id ? safe(g.id) : null;
      if (path && !ghosts.has(path.toLowerCase())) ghosts.set(path.toLowerCase(), { path, g });
    }
    for (const { path, g } of ntfsOrder([...ghosts.values()])) {
      const dir = `${SSP_GHOSTS}${path}/`;
      this.mkdirs(dir);
      if (!g) continue;
      this.mkdirs(dir + 'ghost/master');
      this.M.FS.writeFile(`${dir}${GHOST_MASTER}descript.txt`, this._descript(g));
    }
  }

  /** Another site ghost's descript.txt as the engine reads it (YAYA: UTF-8). */
  _descript(g) { return enc.encode(sspDescript(g)); }

  writeFile(rel, data) {
    const full = this.ghostRoot + String(rel).replace(/^\/+/, '');
    this.mkdirs(full.slice(0, full.lastIndexOf('/')));
    this.M.FS.writeFile(full, toU8(data));
  }

  /**
   * All regular files under the ghost root: Map(ghost-root-relative path -> stamp `mtime:size:inode`), so a file
   * renamed over another, or deleted and written again, counts even where the mtime stayed (_hot covers a rewrite in
   * place). A name its folder lists for a node MEMFS no longer has (an unlink in another case before build.py's J1)
   * is dropped from the folder: the file is gone. It walks MEMFS's nodes (a folder's `contents` is the name list
   * readdir gives, in the same order) instead of resolving each path: bthver.5's 1,507 files cost about 16 ms by path
   * and about 1 ms this way [measured].
   */
  scan() {
    const FS = this.M.FS;
    const out = new Map();
    this.scans++;
    const listed = this._listedCheck(FS);
    const walk = (parent, rel) => {
      const contents = parent.contents;
      for (const name of Object.keys(contents)) {
        const node = contents[name];
        if (!listed(parent, name, node)) {
          delete contents[name];
          continue;
        }
        if (FS.isDir(node.mode)) walk(node, rel + name + '/');
        else if (FS.isFile(node.mode)) out.set(rel + name, `${+node.mtime}:${node.usedBytes}:${node.id}`);
        else {      // a link or device (none is ever made here): as FS.stat sees it
          const st = FS.stat(this.ghostRoot + rel + name);
          if (FS.isDir(st.mode)) walk(FS.lookupPath(this.ghostRoot + rel + name).node, rel + name + '/');
          else out.set(rel + name, `${+st.mtime}:${st.size}:${st.ino}`);
        }
      }
    };
    walk(FS.lookupPath(this.ghostRoot).node, '');
    return out;
  }

  /**
   * (parent, name, node) -> whether MEMFS's name table still holds `node` under that name (a stale name: false). The
   * table's own hash chain when the build exposes it, else FS.lookupNode as FS.readdir's callers see it.
   */
  _listedCheck(FS) {
    if (Array.isArray(FS.nameTable) && typeof FS.hashName === 'function') {
      return (parent, name, node) => {
        for (let n = FS.nameTable[FS.hashName(parent.id, name)]; n; n = n.name_next) if (n === node) return true;
        return false;
      };
    }
    return (parent, name, node) => {
      try { return FS.lookupNode(parent, name) === node; } catch (e) { return false; }
    };
  }

  /**
   * FNV-1a of every file a scan stamped in the millisecond it ran: MEMFS stamps mtimes with Date.now(), so a rewrite
   * later in that millisecond (or while a coarse or frozen clock stays on it: Firefox's resistFingerprinting, the
   * sweep's followClock) keeps the stamp, and only the bytes tell.
   * @param {Map<string, string>} now a scan, just taken
   */
  _hot(now) {
    const at = Date.now();
    const hot = new Map();
    for (const [p, stamp] of now) if (parseInt(stamp, 10) >= at) hot.set(p, this._digest(p));    // stamp: mtime first
    return hot;
  }

  _digest(p) { return fnv1a(this.M.FS.readFile(this.ghostRoot + p)); }

  /** diffScan, plus the files of `hot` whose stamp stayed while their bytes changed. */
  _diff(base, hot, now) {
    const d = diffScan(base, now, this.inputs);
    for (const [p, h] of hot) {
      if (now.get(p) === base.get(p) && !LOG_FILE.test(p) && this._digest(p) !== h) d.changed.push(p);
    }
    return d;
  }

  /**
   * Files changed since the last report, the first time since the scan before load: {path: ArrayBuffer | null |
   * false} (diffScan and _hot). No scan when nothing could have changed: no FS write since the last report
   * (watchWrites) and no file stamped in its millisecond (`hot`).
   */
  changedFiles() {
    if (!this.dirty && !this.hot.size) return {};
    const now = this.scan();
    this.dirty = false;
    const { changed, gone } = this._diff(this.baseline, this.hot, now);
    const out = {};
    for (const p of changed) {
      const u8 = this.M.FS.readFile(this.ghostRoot + p);
      out[p] = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    }
    Object.assign(out, gone);
    this.baseline = now;
    this.hot = this._hot(now);
    return out;
  }

  /** One of the engine's own log lines to onEngineLog (the host's failure there is its own). */
  _engineLog(line) {
    if (!this.onEngineLog) return;
    try { this.onEngineLog(line); } catch (e) { /* the host's own failure */ }
  }

  /**
   * Only the dictionary stamp: YAYA's talk timer is in the ghost's own variables (absolute GETSECCOUNT), Kawari's
   * state in its dictionary (the snapshot key), so time away counts as idle, as with Satori's P6. Read back in init;
   * setVolatileState stays a no-op.
   */
  getVolatileState() { return this.dicStamp ? { dicStamp: this.dicStamp } : null; }
}

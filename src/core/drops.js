// Files dropped on a character (EV §4.14 OnFileDrop2, TS §3.4): Windows-style pseudo-paths for the ghost, and a store
// that keeps the files in the visitor's browser, so paths a ghost saved (Tsubasa's playlist) still play after reloads
// and on later visits. Global, not per ghost: a path is valid for every ghost, as on Windows. Nothing is uploaded.
//
// Path: C:\sumika\drop\<8 hex: FNV-1a of name, size, lastModified>\<sanitized file name>. Backslashes and the
// original extension stay: ghosts split paths at "\" and read the extension (TS §3.4).
// Storage: IndexedDB `sumika` / store `kv` (core/storage.js, version 1, shared with the worker):
//   `drop:<lower-cased path>` = {blob, path, name, type, size, lastModified}
//   `drop:index`              = {v:1, files: {<lower-cased path>: {size, usedAt}}}   size accounting, LRU
// Only files the page can play are stored (audio, and MIDI files where the MIDI player runs; privacy: images and
// documents have no consumer yet). Files over MAX_FILE_BYTES, files that would leave the origin's quota tight (the
// engine's save data shares it), and every file when IndexedDB is missing or full, are kept for this page only. The
// index entry is written before the file and
// evictions come after it, so a failure only over-counts; one tab at a time updates the index (Web Locks), and the
// first update of a page reconciles the index with the stored keys. clear() forgets everything.
// The index's `v` is the store's shape (schema.js SCHEMA.drops): an index a newer runtime wrote makes the store read-only
// for this page (no reconcile, no delete, no index write, nothing cleared); files dropped here play from memory.
import { log } from './log.js';
import { openStore, lockManager, storageEstimate } from './platform.js';
import { SCHEMA, upgrade } from './schema.js';
import { isMidiPath, midiSupported } from './midi.js';

export const DROP_ROOT = 'C:\\sumika\\drop\\';
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const DROP_KEY_PREFIX = 'drop:';
export const DROP_INDEX_KEY = 'drop:index';
export const DROP_LOCK = 'sumika/drops';           // not a GhostLock name: '/' cannot be in a ghost id
const QUOTA_MARGIN_BYTES = 32 * 1024 * 1024;       // left free: max(32 MB, 10 % of the quota)

const ROOT_LOWER = DROP_ROOT.toLowerCase();
// not allowed in Windows file names, plus control characters (\x01 separates OnFileDrop2 paths, \x02 is Satori's
// argument separator in Tsubasa's drop handler)
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const MAX_NAME = 200;

/** MIME types by extension, for files the browser gives no type (R2; SSP takes them from Windows) [guess]. */
const MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', mid: 'audio/midi', midi: 'audio/midi', wma: 'audio/x-ms-wma',
  au: 'audio/basic', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', txt: 'text/plain',
};

/** A file name that is legal on Windows and safe inside OnFileDrop2 R0; the extension is kept. */
export function sanitizeFileName(name) {
  let s = String(name == null ? '' : name);
  try { s = s.normalize('NFC'); } catch (e) { /* keep */ }
  s = s.replace(ILLEGAL, '').replace(/^\s+/, '').replace(/[.\s]+$/, '');   // Windows drops trailing dots and spaces
  if (!s) s = 'file';
  if (RESERVED.test(s)) s = '_' + s;
  const chars = [...s];
  if (chars.length > MAX_NAME) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? [...s.slice(dot)] : [];
    s = chars.slice(0, MAX_NAME - ext.length).join('') + ext.join('');
  }
  return s;
}

/** 32-bit FNV-1a over UTF-16 code units, as 8 lower-case hex digits. */
export function hash8(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The stable pseudo-path of a dropped File (same name, size and date -> same path). */
export function dropPath(file) {
  const f = file || {};
  const name = String(f.name == null ? '' : f.name);
  const id = hash8(`${name}\u0000${Number(f.size) || 0}\u0000${Number(f.lastModified) || 0}`);
  return `${DROP_ROOT}${id}\\${sanitizeFileName(name)}`;
}

/** OnFileDrop2 R2 entry: the browser's type, else by extension, else '' (unknown). */
export function mimeOf(file) {
  const t = file && typeof file.type === 'string' ? file.type.trim() : '';
  if (t) return t;
  const m = /\.([a-z0-9]+)$/i.exec(String((file && file.name) || ''));
  return (m && MIME[m[1].toLowerCase()]) || '';
}

/** Lower-cased lookup form of a pseudo-path ('/' or '\', quotes, case), or null for any other path. */
export function dropLower(path) {
  if (path == null) return null;
  const p = String(path).trim().replace(/^"(.*)"$/, '$1').replace(/\//g, '\\').toLowerCase();
  return p.startsWith(ROOT_LOWER) && p.length > ROOT_LOWER.length ? p : null;
}

export const isDropPath = path => dropLower(path) !== null;

/** What logs show for a pseudo-path: `dropped file <8 hex> (.ext)`, never the visitor's file name; null otherwise. */
export function dropLabel(path) {
  const lower = dropLower(path);
  if (!lower) return null;
  const rest = lower.slice(ROOT_LOWER.length);
  const ext = /\.([a-z0-9]{1,8})$/.exec(rest);
  return `dropped file ${rest.split('\\')[0]}${ext ? ` (.${ext[1]})` : ''}`;
}

/**
 * Worth storing for later visits: audio this browser can play (dsaudio, \_v, \![sound]), and MIDI files by their name
 * where the MIDI player runs (core/midi.js; the browser's type for MIDI varies, audio/mid, audio/midi or none, and
 * canPlayType says no to it everywhere).
 * @param {string} type  @param {string} [name] the file's name
 */
export function playable(type, name = null) {
  if (name != null && isMidiPath(name)) return midiSupported();
  const t = String(type || '');
  if (!/^audio\//i.test(t)) return false;
  try {
    const A = globalThis.Audio;
    if (typeof A === 'function') return new A().canPlayType(t) !== '';
  } catch (e) { /* no media support: decide by type */ }
  return true;
}

const isBlob = b => !!b && typeof b === 'object' && typeof b.size === 'number' && typeof b.slice === 'function';
const trySet = async (be, k, v) => { try { return (await be.set(k, v)) !== false; } catch (e) { return false; } };
const tryDelete = async (be, k) => { try { return (await be.delete(k)) !== false; } catch (e) { return false; } };
const totalOf = idx => Object.values(idx.files).reduce((n, e) => n + e.size, 0);


/** drop:index cleaned: {v, files: {<lower-cased path>: {size, usedAt}}}, its other top-level keys kept as they are */
function normIndex(v) {
  const files = {};
  const rest = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) if (k !== 'v' && k !== 'files') rest[k] = x;
  }
  if (v && typeof v === 'object' && v.files && typeof v.files === 'object') {
    for (const [k, e] of Object.entries(v.files)) {
      if (!e || typeof e !== 'object') continue;
      const size = Number(e.size);
      if (Number.isFinite(size) && size >= 0) files[k] = { size, usedAt: Number(e.usedAt) || 0 };
    }
  }
  return { ...rest, v: SCHEMA.drops, files };
}

/** drop:index through its hook (schema.js upgrade): {raw, newer} */
function indexVersion(raw) {
  const up = upgrade('drops', raw, raw && typeof raw === 'object' ? raw.v : undefined);
  return { raw: up.rec, v: up.v, newer: up.newer };
}

let shared = null;

export class DropStore {
  /**
   * @param {object} [o]
   * @param {object|Function|null} [o.backend] {get(key), set(key, value) -> true when stored, delete(key) -> false when
   *   refused, keys?(prefix)} (a Store), or a function returning it (or a Promise of it); null = this page only
   * @param {number} [o.maxFileBytes]
   * @param {number} [o.maxTotalBytes]
   * @param {() => number} [o.now]
   * @param {{createObjectURL: Function, revokeObjectURL: Function}} [o.URL]
   * @param {(type: string, name: string) => boolean} [o.storable] which files to keep for later visits (default:
   *   playable: audio this browser plays, MIDI where the MIDI player runs)
   * @param {{request: Function}|null} [o.locks] navigator.locks (index updates, one tab at a time)
   * @param {(() => Promise<{usage?: number, quota?: number}>)|null} [o.estimate] navigator.storage.estimate
   */
  constructor({
    backend = null, maxFileBytes = MAX_FILE_BYTES, maxTotalBytes = MAX_TOTAL_BYTES, now = () => Date.now(), URL = globalThis.URL,
    storable = playable, locks = lockManager(), estimate = storageEstimate(),
  } = {}) {
    this._open = backend;
    this._be = null;
    this._beStore = null;          // the backend _be resolved to (a PortStore the hub closed is opened again)
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.now = now;
    this.URL = URL;
    this.storable = storable;
    this.locks = locks && typeof locks.request === 'function' ? locks : null;
    this.estimate = typeof estimate === 'function' ? estimate : null;
    this.session = new Map();      // lower-cased path -> Blob/File, for this page
    this._chain = Promise.resolve();
    this._reconciled = false;
    /** the stored index is a newer runtime's: the store is read-only for this page */
    this.newer = false;
  }

  /**
   * The page's store (IndexedDB through core/storage.js when available, else this page only; with the storage hub its
   * IndexedDB, Web Locks and estimate: core/platform.js).
   */
  static shared(namespace = 'sumika') {
    if (!shared) {
      shared = new DropStore({ backend: () => openStore(namespace).then(s => (s && s.kind === 'indexeddb' ? s : null)) });
    }
    return shared;
  }

  _backend() {
    // the storage hub's store port is closed when the hub goes away (HubClient._closeStores): the next use opens a new
    // one (this page's memory then) instead of waiting on the old
    if (this._be && this._beStore && this._beStore.closed === true && typeof this._open === 'function') {
      this._be = null;
      this._beStore = null;
    }
    if (!this._be) {
      const o = this._open;
      this._be = Promise.resolve()
        .then(() => (typeof o === 'function' ? o() : o))
        .then(b => { this._beStore = b || null; return b || null; }, e => { log.once('drops-open', 'dropped files are kept for this page only', e); return null; });
    }
    return this._be;
  }

  /**
   * Run storage work one job after another, and one tab at a time where Web Locks exist (the index is a
   * read-modify-write shared by every ghost's tab); failures are logged, never thrown (the event path must not break).
   */
  _queue(fn) {
    const run = () => (this.locks ? this.locks.request(DROP_LOCK, () => fn()) : fn());
    const p = this._chain.then(run).catch(e => { log.once('drops-store', 'storing a dropped file failed', e); return false; });
    this._chain = p;
    return p;
  }

  /** Resolves when every queued storage job has finished. */
  whenIdle() { return this._chain.then(() => {}); }

  /**
   * Register dropped files: their paths are usable at once (this page); storing the playable ones for later visits
   * runs in the background. Folders and anything without a name are skipped.
   * @param {Iterable<File>} files
   * @returns {{path:string, type:string, name:string, size:number}[]}
   */
  add(files) {
    const out = [];
    for (const f of files || []) {
      if (!isBlob(f) || typeof f.name !== 'string') continue;
      const path = dropPath(f);
      const lower = path.toLowerCase();
      const type = mimeOf(f);
      this.session.set(lower, f);
      out.push({ path, type, name: f.name, size: f.size });
      let keep = false;
      try { keep = !!this.storable(type, f.name); } catch (e) { keep = false; }
      if (keep) this._queue(() => this._persist(lower, path, f, type));
    }
    return out;
  }

  /**
   * drop:index, reconciled with the stored `drop:` keys on the page's first use (interrupted writes, other tabs); null
   * when a newer runtime wrote it (the store is read-only for this page: nothing reconciled, deleted or written).
   */
  async _index(be) {
    const got = indexVersion(await be.get(DROP_INDEX_KEY));     // unreadable: the job fails, nothing is written
    if (got.newer) {
      this.newer = true;
      log.once('drops-newer', `the dropped files' index has version ${got.v}, newer than this page's ${SCHEMA.drops}: files dropped here play on this page only`);
      return null;
    }
    const idx = normIndex(got.raw);
    if (this._reconciled || typeof be.keys !== 'function') return idx;
    this._reconciled = true;
    let stored;
    try {
      stored = new Set((await be.keys(DROP_KEY_PREFIX)).filter(k => k !== DROP_INDEX_KEY).map(k => k.slice(DROP_KEY_PREFIX.length)));
    } catch (e) {
      return idx;                            // cannot list: leave the index as it is
    }
    let changed = false;
    for (const k of stored) {                // a file the index does not know: counted again, oldest first
      if (idx.files[k]) continue;
      let rec;
      try { rec = await be.get(DROP_KEY_PREFIX + k); } catch (e) { continue; }    // unreadable now: left alone
      if (rec && isBlob(rec.blob)) idx.files[k] = { size: rec.blob.size, usedAt: 0 };
      else await tryDelete(be, DROP_KEY_PREFIX + k);                            // not a dropped file record
      changed = true;
    }
    for (const k of Object.keys(idx.files)) if (!stored.has(k)) { delete idx.files[k]; changed = true; }
    if (changed) await trySet(be, DROP_INDEX_KEY, idx);
    return idx;
  }

  /** Room in the origin's quota for size more bytes, keeping a margin for the save data; true when unknown. */
  async _room(size) {
    if (!this.estimate) return true;
    let est = null;
    try { est = await this.estimate(); } catch (e) { return true; }
    const quota = Number(est && est.quota);
    if (!Number.isFinite(quota) || quota <= 0) return true;
    return (Number(est.usage) || 0) + size + Math.max(QUOTA_MARGIN_BYTES, quota * 0.1) <= quota;
  }

  async _persist(lower, path, file, type) {
    const be = await this._backend();
    if (!be) return false;
    const size = Math.max(0, Number(file.size) || 0);
    if (size > this.maxFileBytes) {
      log.once(`drops-big:${lower}`, `a dropped file is larger than ${this.maxFileBytes / 1048576} MB: it plays on this page only`);
      return false;
    }
    const idx = await this._index(be);
    if (!idx) return false;                  // a newer runtime's store: this page only
    const now = this.now();
    const key = DROP_KEY_PREFIX + lower;
    const cur = idx.files[lower];
    let have = null;
    if (cur && cur.size === size) { try { have = await be.get(key); } catch (e) { have = null; } }
    if (have && isBlob(have.blob)) {         // the same file again: already stored
      cur.usedAt = now;
      await trySet(be, DROP_INDEX_KEY, idx);
      return true;
    }
    const refused = () => {
      log.once('drops-quota', 'the browser did not store a dropped file (storage full or blocked): it plays on this page only');
      return false;
    };
    if (!(await this._room(size))) return refused();
    // the entry first: if the file write fails or the page goes, the index over-counts instead of missing a file
    idx.files[lower] = { size, usedAt: now };
    if (!(await trySet(be, DROP_INDEX_KEY, idx))) return refused();
    if (!(await trySet(be, key, { blob: file, path, name: file.name, type, size, lastModified: Number(file.lastModified) || 0 }))) {
      delete idx.files[lower];
      await trySet(be, DROP_INDEX_KEY, idx);
      return refused();
    }
    // then the least recently used others go beyond the total (a refused write above evicted nothing)
    let total = totalOf(idx), evicted = false;
    const lru = Object.entries(idx.files).filter(([k]) => k !== lower).sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (total > this.maxTotalBytes && lru.length) {
      const [k, e] = lru.shift();
      if (!(await tryDelete(be, DROP_KEY_PREFIX + k))) continue;     // still stored: still counted
      delete idx.files[k];
      total -= e.size;
      evicted = true;
    }
    if (evicted) await trySet(be, DROP_INDEX_KEY, idx);
    return true;
  }

  async _touch(lower) {
    const be = await this._backend();
    if (!be) return;
    const idx = await this._index(be);
    if (!idx || !idx.files[lower]) return;
    idx.files[lower].usedAt = this.now();
    await trySet(be, DROP_INDEX_KEY, idx);
  }

  /** True when the path is a pseudo-path dropped on this page (stored ones need blob()). */
  has(path) { const l = dropLower(path); return !!l && this.session.has(l); }

  /**
   * The dropped file behind a pseudo-path: this page's, else the stored one; null when gone (storage cleared). A
   * stored one is read at once: this page writes only files dropped on it, and those are in the session map.
   */
  async blob(path) {
    const lower = dropLower(path);
    if (!lower) return null;
    let b = this.session.get(lower) || null;
    if (!b) {
      const be = await this._backend();
      if (be) {
        let rec = null;
        try { rec = await be.get(DROP_KEY_PREFIX + lower); } catch (e) { rec = null; }
        if (rec && isBlob(rec.blob)) { b = rec.blob; this.session.set(lower, b); }
      }
    }
    if (b) this._queue(() => this._touch(lower));
    return b;
  }

  /**
   * Forget every dropped file, this page's and the stored ones (for a reset flow). Object URLs already handed out
   * stay valid until released. Resolves false when the browser refused a delete.
   */
  clear() {
    this.session.clear();
    return this._queue(async () => {
      const be = await this._backend();
      if (!be) return true;
      let keys, index;
      try { index = indexVersion(await be.get(DROP_INDEX_KEY)); } catch (e) { index = null; }
      if (index && index.newer) {
        this.newer = true;
        log.once('drops-newer-clear', 'the dropped files\' index is newer than this page: nothing cleared');
        return false;
      }
      try {
        keys = typeof be.keys === 'function' ? await be.keys(DROP_KEY_PREFIX)
          : Object.keys(normIndex(index && index.raw).files).map(k => DROP_KEY_PREFIX + k);
      } catch (e) {
        keys = [];
      }
      let ok = true;
      for (const k of new Set([...keys, DROP_INDEX_KEY])) if (!(await tryDelete(be, k))) ok = false;
      return ok;
    });
  }

  /**
   * An object URL for a pseudo-path, or null. Call release() when the URL is no longer used (revokes it). `blob` is
   * the file itself, for a reader that takes it directly (the MIDI player: no fetch() of a blob: URL, which a CSP's
   * connect-src may refuse).
   * @returns {Promise<{url:string, release:()=>void, blob:Blob}|null>}
   */
  async open(path) {
    const b = await this.blob(path);
    if (!b) return null;
    let url;
    try { url = this.URL.createObjectURL(b); } catch (e) { log.once('drops-url', 'cannot play a dropped file', e); return null; }
    let live = true;
    return {
      url,
      blob: b,
      release: () => {
        if (!live) return;
        live = false;
        try { this.URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      },
    };
  }
}

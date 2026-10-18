// Shared plumbing for Emscripten-built SHIORIs (POSIX SHIORI ABI, see index.js):
// virtual filesystem setup, ABI calls with malloc'd buffers, and tracking of files the engine writes.
import { masterRel } from '../../core/engine-files.js';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

/** Windows (NTFS) lists a folder in case-insensitive name order; dictionaries load in that order. */
export function ntfsOrder(files) {
  const key = p => p.split('/').map(s => s.toUpperCase());
  return [...files].sort((a, b) => {
    const ka = key(a.path), kb = key(b.path);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return ka.length - kb.length;
  });
}

export class EmscriptenShiori {
  /**
   * @param {{engineUrl: string, wasmUrl?: string|null, ghostDir?: string, log?: Function, saori?: object}} o wasmUrl:
   *   the page's hashed .wasm (safe updates: a hashed `<e>.<h>.js` still asks locateFile for `<e>.wasm`); none:
   *   the .wasm next to engineUrl
   */
  constructor({ engineUrl, wasmUrl = null, ghostDir = '/ghost/master/', log, saori }) {
    this.engineUrl = engineUrl;
    this.wasmUrl = wasmUrl || null;
    this.ghostDir = ghostDir.endsWith('/') ? ghostDir : ghostDir + '/';
    this.log = log || (() => {});
    this.saori = saori;
    this.M = null;
    this.baseline = new Map(); // relative path -> mtime at the last report
  }

  /** Subclasses: return the Emscripten factory (e.g. self.createSatori after importScripts). */
  async factory() { throw new Error('not implemented'); }

  async boot(extra = {}) {
    const create = await this.factory();
    const cut = Math.max(this.engineUrl.lastIndexOf('/'), this.engineUrl.lastIndexOf('\\'));
    const base = this.engineUrl.slice(0, cut + 1);
    this.M = await create({
      // in a worker Emscripten would resolve files against the worker's URL; point it at the engine's folder, and the
      // .wasm at the page's hashed one when it gave one
      locateFile: f => (this.wasmUrl && /\.wasm$/i.test(f) ? this.wasmUrl : base + f),
      print: t => this.log('debug', t),
      printErr: t => this.log('debug', t),
      saoriBridge: this.saori,
      ...extra,
    });
  }

  mkdirs(path) {
    try { this.M.FS.mkdirTree(path); } catch (e) { /* exists */ }
  }

  writeFile(rel, data) {
    const full = this.ghostDir + rel.replace(/^\/+/, '');
    this.mkdirs(full.slice(0, full.lastIndexOf('/')));
    this.M.FS.writeFile(full, data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  /** `rel` inside ghost/master as a full path (`\` as `/`, `.` and `..` resolved); null when it leaves the folder. */
  masterPath(rel) {
    const p = masterRel(rel);
    return p == null ? null : this.ghostDir + p;
  }

  /**
   * \![execute,http-*]'s download (EV §4.15): `rel` under ghost/master/ (its folders made), as the engine's own writes
   * are, so changedFiles() reports it. Throws when `rel` leaves the folder.
   * @returns {string} its full path
   */
  writeMasterFile(rel, data) {
    const full = this.masterPath(rel);
    if (!full) throw new Error(`not a file of the ghost: ${rel}`);
    this.mkdirs(full.slice(0, full.lastIndexOf('/')));
    this.M.FS.writeFile(full, data instanceof Uint8Array ? data : new Uint8Array(data || 0));
    return full;
  }

  /** A file under ghost/master/ (--param-input-file, EV §4.15) as an ArrayBuffer; null when missing or outside it. */
  readMasterFile(rel) {
    const full = this.masterPath(rel);
    if (!full) return null;
    try {
      const u8 = this.M.FS.readFile(full);
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    } catch (e) {
      return null;
    }
  }

  /** All regular files under ghostDir: Map(relative path -> mtime ms) */
  scan() {
    const FS = this.M.FS;
    const out = new Map();
    const walk = dir => {
      for (const name of FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const p = dir + name;
        const st = FS.stat(p);
        if (FS.isDir(st.mode)) walk(p + '/');
        else out.set(p.slice(this.ghostDir.length), +st.mtime);
      }
    };
    walk(this.ghostDir);
    return out;
  }

  /**
   * @param {{path:string, data:ArrayBuffer}[]} files ghost text files
   * @param {Record<string, ArrayBuffer>} persisted files the engine wrote in earlier sessions (save data)
   * @param {{resume?: boolean, bootEpochMs?: number}} opts resume: a page navigation, not a ghost start; bootEpochMs:
   *   the ghost's last cold boot (engine-specific use: Satori's P7 clock)
   */
  init(files, persisted, { resume = false } = {}) {
    this.mkdirs(this.ghostDir);
    const lower = new Set(Object.keys(persisted).map(p => p.toLowerCase()));
    for (const f of ntfsOrder(files)) if (!lower.has(f.path.toLowerCase())) this.writeFile(f.path, f.data);
    for (const [p, data] of Object.entries(persisted)) this.writeFile(p, data);
    this.inputs = new Set(files.map(f => f.path));
    this.baseline = this.scan();
    const ok = this.callLoad(this.ghostDir, resume);
    if (!ok) this.log('warn', 'load() returned false');
    this.baseline = this.scan(); // files written by load() itself are not "changes"
    return ok;
  }

  _toHeap(bytes) {
    const M = this.M;
    const p = M._malloc(bytes.length + 1);
    M.HEAPU8.set(bytes, p);
    M.HEAPU8[p + bytes.length] = 0;
    return p;
  }

  /**
   * fn() into the engine. A throw out of the wasm (a runaway recursion's RangeError) skips the epilogues that move the
   * stack pointer back up: it is put back before anything else runs, when the module exports stackSave/stackRestore
   * (Kawari; not Satori and YAYA). Without it the next calls run on a lower stack, and an -O2 engine whose stack
   * sits above its static data is corrupted after about 12 such throws (kawari-wasm.md D8, §4).
   */
  _stackGuard(fn) {
    const M = this.M;
    const sp = typeof M.stackSave === 'function' && typeof M.stackRestore === 'function' ? M.stackSave() : null;
    try {
      return fn();
    } catch (e) {
      if (sp !== null) M.stackRestore(sp);
      throw e;
    }
  }

  callLoad(dir, resume) {
    const b = enc.encode(dir);
    const fn = resume && this.M._satori_load_resume ? this.M._satori_load_resume : this.M._load;
    try {
      return this._stackGuard(() => fn(this._toHeap(b), b.length)) !== 0;
    } catch (e) {
      this.log('error', `load: ${e}`);
      return false;
    }
  }

  /** One SHIORI request. The engine frees the request buffer; we free the response. */
  request(text) {
    const M = this.M;
    const b = enc.encode(text);
    const p = this._toHeap(b);
    const lenp = M._malloc(4);
    M.HEAP32[lenp >> 2] = b.length;
    let r = 0;
    try {
      r = this._stackGuard(() => M._request(p, lenp));
    } catch (e) {
      M._free(lenp);
      this.log('error', `request: ${e}`);
      return 'SHIORI/3.0 500 Internal Server Error\r\n\r\n';
    }
    const n = M.HEAP32[lenp >> 2]; // memory may have grown: read the views again
    M._free(lenp);
    if (!r) return '';
    const out = dec.decode(M.HEAPU8.subarray(r, r + n));
    M._free(r);
    return out;
  }

  /** Files written since the last report (save data etc.), as {path: ArrayBuffer}. */
  changedFiles() {
    const now = this.scan();
    const out = {};
    for (const [p, mt] of now) {
      if (this.baseline.get(p) === mt) continue;
      if (this.inputs && this.inputs.has(p) && !/save|\.sat$/i.test(p)) continue; // never re-persist dictionaries
      const u8 = this.M.FS.readFile(this.ghostDir + p);
      out[p] = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    }
    this.baseline = now;
    return out;
  }

  /** Engine-specific "write your save data now"; returns true if it did. */
  save() { return false; }

  unload() {
    try { this._stackGuard(() => this.M._unload()); } catch (e) { this.log('error', `unload: ${e}`); }
    return this.changedFiles();
  }

  /** Engine-specific in-memory state worth carrying across page loads (null = none). */
  getVolatileState() { return null; }
  setVolatileState() {}
}

// KAWARI (華和梨) Phase 7.5.0, compiled from vendor/kawari-7.5.0 by engines/kawari7/build.py (docs/research/
// kawari7-wasm.md). A Phase 7 ghost (ghost/master/kawari.ini) runs as a Phase 8 one does (./kawari.js: YAYA's SSP-like
// MEMFS, the resume snapshot under its own key, D6's close and finish of an unclosed session), with two differences:
// Kawari 7 speaks only SHIORI/2.x, so every request goes through the bridge of ./shiori2.js (what ssp.exe 2.9.10 sends
// a SHIORI/2.x DLL after its `GET Version SHIORI/2.6` handshake, and how it reads the reply: kawari7-wasm.md §6); and the
// build passes the bytes unchanged (patch C8), so the requests are encoded here in the charset the handshake reply named
// (Shift_JIS: code page 932 with the build's converters, ssp.exe's best fit) and the replies decoded back.
import { KawariEngine } from './kawari.js';
import { toShiori2, fromShiori2, readVersionReply, Shiori2Session, VERSION_REQUEST, VERSION_PROBE_30, NOTHING } from './shiori2.js';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

/** The snapshot's key in the ghost's stored files (another than Phase 8's: its format differs, kawari7-wasm.md §8). */
export const RESUME_KEY7 = '?kawari7/resume.k7';

const isUtf8 = cs => /^utf-?8$/i.test(String(cs || '').trim());

export class Kawari7Engine extends KawariEngine {
  constructor(o) {
    super(o);
    this.session = new Shiori2Session();
  }

  async factory() {
    if (typeof self.createKawari7 !== 'function') importScripts(this.engineUrl);
    return self.createKawari7;
  }

  get resumeKey() { return RESUME_KEY7; }
  get rcFile() { return 'kawari.ini'; }
  get name() { return 'kawari7'; }
  get cp932Export() { return '_kawari7_utf8_to_cp932'; }

  /**
   * load(), then ssp.exe's handshake [disasm GetVersionRequestImpl 0x7130a0]: `GET Version SHIORI/2.6` (ASCII); its
   * status line gives the protocol and its Charset the charset of every later request; only a 4xx or a 3.0 answer
   * would bring the 3.0 probe. The snapshot's baseline is taken inside the build (before system.OnLoad, patch C7).
   */
  _load() {
    this.session = new Shiori2Session();
    const ok = this.callLoad(this.ghostDir, false);
    this.entries = ok && typeof this.M._kawari7_entries === 'function' ? this.M._kawari7_entries() : 0;
    if (ok) {
      const first = readVersionReply(this._exchange(VERSION_REQUEST, 'ascii') || '', this.session);
      if (first.probe30) readVersionReply(this._exchange(VERSION_PROBE_30, 'ascii') || '', this.session);
      this.log('debug', `kawari7: ${this.session.name || '?'} SHIORI/${(this.session.version / 10).toFixed(1)}, ${this.session.charset}`);
    }
    return ok;
  }

  _restoreCall(p) { return this.M._kawari7_restore(p); }
  _snapshotCall(p) { return this.M._kawari7_snapshot(p); }
  _canSnapshot() { return typeof this.M._kawari7_snapshot === 'function'; }

  /** code page 932 bytes -> text with the build's decoder (MultiByteToWideChar(932, 0)) */
  _fromCp932(bytes) {
    const M = this.M;
    const p = this._toHeap(bytes);
    const lenp = M._malloc(4);
    try {
      const r = M._kawari7_cp932_to_utf8(p, bytes.length, lenp);
      if (!r) return '';
      const out = dec.decode(M.HEAPU8.subarray(r, r + M.HEAP32[lenp >> 2]));
      M._free(r);
      return out;
    } finally {
      M._free(lenp);
      M._free(p);
    }
  }

  /**
   * One raw exchange: `text` encoded as `charset` (default: the session's) into the engine, its reply decoded the same
   * way; null when the engine threw (a runaway recursion: the stack guard puts the stack pointer back).
   */
  _exchange(text, charset = this.session.charset) {
    const M = this.M;
    const utf8 = charset === 'ascii' || isUtf8(charset);
    const b = utf8 ? enc.encode(text) : this._cp932(text) || enc.encode(text);
    const p = this._toHeap(b);
    const lenp = M._malloc(4);
    M.HEAP32[lenp >> 2] = b.length;
    let r = 0;
    try {
      r = this._stackGuard(() => M._request(p, lenp));
    } catch (e) {
      M._free(lenp);
      this.log('error', `request: ${e}`);
      return null;
    }
    const n = M.HEAP32[lenp >> 2];
    M._free(lenp);
    if (!r) return null;
    const bytes = M.HEAPU8.slice(r, r + n);
    M._free(r);
    // the reply in its own charset: Kawari 7 says Shift_JIS on every reply (ASCII for the handshake's is the same bytes)
    return isUtf8(this.session.charset) && charset !== 'ascii' ? dec.decode(bytes) : this._fromCp932(bytes);
  }

  /**
   * The page's SHIORI/3.0 request -> the SHIORI/2.x request ssp.exe would send for it (shiori2.js toShiori2; none for
   * what it never sends a 2.x SHIORI: 204) -> the page's reply (fromShiori2).
   * @param {string} text  @param {{kind?: string, self?: string}} [meta] the page's call (shiori2.js)
   */
  request(text, meta = {}) {
    const plan = toShiori2(text, this.session, meta || {});
    if (!plan.length) return NOTHING;
    const step = plan[0];
    return fromShiori2(this._exchange(step.text), step.kind);
  }
}

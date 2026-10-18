// The MIDI player's Worker role (midi.md §5.3): the sound bank's download (gzip, inflated and checked here), and
// per song the bank trimmed to what the song plays, its samples decoded to PCM and written as SF2 for the worklet. The
// SF3's Vorbis is never decoded on the audio thread.
import { SoundBankLoader, BasicSoundBank, SpessaSynthCoreUtils, SpessaLog } from 'spessasynth_core';
import { songOf, toArrayBuffer } from './song.js';

/** A bank download that gets no new byte for this long fails [decision: a slow link goes on while bytes arrive]. */
export const BANK_STALL_MS = 30000;

/** The most a DEFLATE stream can expand (258 bytes from a 2-bit code, RFC 1951): a gzip's ISIZE above it lies. */
const DEFLATE_MAX_RATIO = 1032;

const tag = (u8, at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);
const u32 = (u8, at) => (u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16) | (u8[at + 3] << 24)) >>> 0;

let crcTable = null;

/** CRC-32 (ISO 3309, gzip's). */
export function crc32(u8) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * The SF3 from the bank's bytes as fetched: a gzip member (`1f 8b 08`; its FEXTRA, FNAME, FCOMMENT and FHCRC fields
 * skipped), inflated with core's fflate and checked against its ISIZE and CRC-32; or bytes that already are the bank
 * (a host that sent `Content-Encoding: gzip`). Either way it must be a `RIFF` `sfbk` whose RIFF size is its length.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Uint8Array} the SF3
 * @throws {Error} 'not the sound bank (…)'
 */
export function bankBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(toArrayBuffer(bytes));
  let sf3 = u8;
  if (u8.length >= 3 && u8[0] === 0x1f && u8[1] === 0x8b && u8[2] === 8) {
    const bad = why => new Error(`not the sound bank (${why})`);
    const flg = u8[3];
    if (u8.length < 18 || flg & 0xe0) throw bad('gzip header');
    let p = 10;
    if (flg & 4) p += 2 + (u8[p] | (u8[p + 1] << 8));
    if (flg & 8) { while (p < u8.length && u8[p] !== 0) p++; p++; }
    if (flg & 16) { while (p < u8.length && u8[p] !== 0) p++; p++; }
    if (flg & 2) p += 2;
    const end = u8.length - 8;
    if (p > end) throw bad('gzip header');
    const isize = u32(u8, end + 4);
    if (isize > (end - p) * DEFLATE_MAX_RATIO) throw bad('gzip length');
    try {
      sf3 = SpessaSynthCoreUtils.inflateSync(u8.subarray(p, end), { out: new Uint8Array(isize) });
    } catch (e) {
      throw bad(`inflate: ${e && e.message}`);
    }
    if (sf3.length !== isize) throw bad('gzip length');
    if (crc32(sf3) !== u32(u8, end)) throw bad('gzip CRC-32');
  }
  if (sf3.length < 12 || tag(sf3, 0) !== 'RIFF' || tag(sf3, 8) !== 'sfbk' || u32(sf3, 4) + 8 !== sf3.length) {
    throw new Error('not the sound bank');
  }
  return sf3;
}

/** Every velocity: the zone a note plays is picked by its velocity after velocity sense and key modifiers. */
const ALL_VELOCITIES = new Set(Array.from({ length: 128 }, (_, v) => v));
const ALL_KEYS = Array.from({ length: 128 }, (_, k) => k);

/** Whether the song retunes keys (MIDI Tuning Standard: bulk dump, single note), which moves the key a zone is
 *  picked by (core's `tunings`). */
function retunes(song) {
  for (const t of song.tracks) {
    for (const e of t.events) {
      const d = e.statusByte === 0xf0 ? e.data : null;
      if (d && d.length > 3 && (d[0] === 0x7e || d[0] === 0x7f) && d[2] === 8 && (d[3] === 1 || d[3] === 2 || d[3] === 7)) return true;
    }
  }
  return false;
}

/**
 * What the trim keeps (midi.md §5.3): for each preset the song plays, every velocity of each key it plays
 * (core's own list records the raw velocity: a file that sets velocity sense would lose layers), and every key when
 * the song retunes keys. A song with no note keeps the bank's first preset, so the trimmed bank stays valid.
 * @returns {Map<object, Map<number, Set<number>>>} BasicPreset → key → velocities, as `BasicSoundBank.trim` takes
 */
export function usedKeys(song, bank) {
  const used = song.getUsedProgramsAndKeys(bank);
  const every = retunes(song);
  const out = new Map();
  for (const [preset, keys] of used) {
    const m = new Map();
    for (const k of every ? ALL_KEYS : keys.keys()) m.set(k, ALL_VELOCITIES);
    out.set(preset, m);
  }
  if (!out.size && bank.presets.length) out.set(bank.presets[0], new Map([[60, ALL_VELOCITIES]]));
  return out;
}

/**
 * The SF2 one song needs: a fresh parse of the SF3 (`trim` works in place; the SF3's bytes are not changed), trimmed
 * to `usedKeys`, its samples decoded to 16-bit PCM, written as SF2.
 * @param {object} song from songOf
 * @param {Uint8Array|ArrayBuffer} sf3
 * @returns {Promise<{sf2: ArrayBuffer, presets: number, samples: number}>}
 */
export async function prepareSong(song, sf3) {
  const bank = SoundBankLoader.fromArrayBuffer(toArrayBuffer(sf3));
  bank.trim(usedKeys(song, bank));
  await bank.setSampleFormat({ format: 'pcm' });
  const sf2 = toArrayBuffer(bank.writeSF2());
  return { sf2, presets: bank.presets.length, samples: bank.samples.length };
}

/**
 * The Worker's state and protocol (midi.md §5.5): one bank per Worker, downloaded at `bank`, forgotten after a failure
 * (the next prepare downloads again: one new attempt per MIDI play, no retry loop).
 */
export class BankWorker {
  /**
   * @param {{fetch: Function, post: (m: object, transfer?: Transferable[]) => void, setTimeout: Function,
   *   clearTimeout: Function, AbortController?: Function}} o
   */
  constructor({ fetch, post, setTimeout, clearTimeout, AbortController = null }) {
    this.fetch = fetch;
    this.post = post;
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.Abort = AbortController;
    /** The bank's absolute URL, from `bank`. */
    this.url = '';
    /** @type {Promise<Uint8Array>|null} the SF3, while it loads or once it has */
    this.bank = null;
  }

  message(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'bank') {
      this.url = String(m.url || '');
      this.load().catch(() => {}); // the download starts at once; a failure waits for the next prepare
    } else if (m.t === 'prepare') {
      this.prepare(m.id, m.midi);
    }
  }

  /** The SF3, downloading it when no download holds or is under way. */
  load() {
    if (!this.bank) {
      const p = this.download();
      this.bank = p;
      p.catch(() => { if (this.bank === p) this.bank = null; });
    }
    return this.bank;
  }

  /** `force-cache`, then once `reload` when the answer is no 2xx or not the bank (as loader.js fetchNamed). */
  async download() {
    const url = this.url;
    if (!url) throw new Error('no sound bank URL');
    let why = '';
    for (const cache of ['force-cache', 'reload']) {
      const got = await this.fetchBytes(url, cache);
      if (typeof got === 'number') { why = `HTTP ${got}`; continue; }
      try {
        return bankBytes(got);
      } catch (e) {
        why = e.message;
      }
    }
    throw new Error(`${why} fetching ${url}`);
  }

  /**
   * The body's bytes, or the HTTP status when it is no 2xx. A network error rejects; so does a wait of
   * BANK_STALL_MS for the answer or for the next chunk (the fetch is aborted).
   */
  async fetchBytes(url, cache) {
    const ctl = this.Abort ? new this.Abort() : null;
    let timer = null;
    let stall = null;
    const stalled = new Promise((_, reject) => { stall = reject; });
    stalled.catch(() => {});
    const arm = () => {
      this.clearTimeout(timer);
      timer = this.setTimeout(() => {
        stall(new Error(`the sound bank stalled (no data for ${BANK_STALL_MS / 1000} s)`));
        if (ctl) ctl.abort();
      }, BANK_STALL_MS);
    };
    const step = p => Promise.race([p, stalled]);
    arm();
    try {
      const r = await step(this.fetch(url, ctl ? { cache, signal: ctl.signal } : { cache }));
      if (!r.ok) {
        try { if (r.body && r.body.cancel) r.body.cancel().catch(() => {}); } catch (e) { /* gone already */ }
        return r.status;
      }
      if (!r.body || typeof r.body.getReader !== 'function') return new Uint8Array(await step(r.arrayBuffer()));
      const reader = r.body.getReader();
      const chunks = [];
      let n = 0;
      arm();
      for (;;) {
        const { done, value } = await step(reader.read());
        if (done) break;
        chunks.push(value);
        n += value.length;
        arm();
      }
      const out = new Uint8Array(n);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      return out;
    } finally {
      this.clearTimeout(timer);
    }
  }

  async prepare(id, midi) {
    let song;
    try {
      song = songOf(midi);
    } catch (e) {
      this.failed(id, 'midi', e);
      return;
    }
    let sf3;
    try {
      sf3 = await this.load();
      await BasicSoundBank.isSF3DecoderReady;
    } catch (e) {
      this.failed(id, 'bank', e);
      return;
    }
    let out;
    try {
      out = await prepareSong(song, sf3);
    } catch (e) {
      this.failed(id, 'midi', e);
      return;
    }
    const bytes = toArrayBuffer(midi);
    this.post({ t: 'prepared', id, sf2: out.sf2, midi: bytes, duration: song.duration }, [out.sf2, bytes]);
  }

  failed(id, kind, e) {
    this.post({ t: 'failed', id, kind, message: String((e && e.message) || e) });
  }
}

/**
 * The Worker role on a classic Worker's global scope: `{t:'up'}` first, then the protocol of midi.md §5.5.
 * @param {object} scope the WorkerGlobalScope (`self`)
 */
export function installWorker(scope) {
  SpessaLog.setLogLevel(false, false, false);
  BasicSoundBank.isSF3DecoderReady.catch(() => {}); // no WebAssembly: each prepare fails with kind 'bank'
  const w = new BankWorker({
    fetch: (url, o) => scope.fetch(url, o),
    post: (m, transfer) => scope.postMessage(m, transfer || []),
    setTimeout: (f, ms) => scope.setTimeout(f, ms),
    clearTimeout: t => scope.clearTimeout(t),
    AbortController: scope.AbortController || null,
  });
  scope.onmessage = e => w.message(e.data);
  scope.postMessage({ t: 'up' });
  return w;
}

// MIDI files (docs/research/midi.md §6 "The player: page side"): ssp.exe plays .mid / .midi / .smf
// through DirectShow's MIDI Renderer [disasm]; Sumika plays them with spessasynth_core from the build's one MIDI bundle
// (`midi.<h>.js`, the table's `midi.js`): in a Worker it downloads and inflates the sound bank and trims it per song
// to an SF2, and in an AudioWorklet ('sumika-midi') one synth and sequencer per playing file render it. Nothing loads
// before a ghost plays a MIDI file; then the bundle and the bank (`midi.bank`) come once, under hashed names.
// MidiEngine is the page's (Site.midi): the AudioContext, the Worker and the worklet module, shared by every ghost.
// MidiPlayer stands in for an <audio> element in page-saori.js: the members it uses, element-like (CONTRACTS midi.js).
// No module-level side effects and no static class fields: drops.js imports this module and the worker bundle imports
// drops.js, so esbuild must be able to leave the classes out of it. For the same reason it does not import build.js
// (its FILES line would stay in the worker): midiPaths takes the table (Site passes runtimeFiles, = FILES).
import { log } from './log.js';

/** A MIDI file by its name as the ghost gave it (ssp.exe's MIDI flag: mid, midi, smf [disasm 0xd3f6a4]; plus rmi). */
export const MIDI_PATH = /\.(mid|midi|smf|rmi)$/i;
/** How long a play waits for the context to run before it counts as refused (NotAllowedError) [decision: generous,
 *  so a resume inside a gesture on a slow phone is not taken for a refusal]. */
export const RESUME_WAIT_MS = 1000;
/** With no player holding the context for this long, it is suspended and the audio session given back [decision]. */
export const IDLE_MS = 10000;
/** A released node is disconnected at its `closed`, or this long after the close at the latest. */
export const CLOSE_WAIT_MS = 3000;
/** No position at or past duration - END_EPS (s) reaches the sequencer: spessasynth_core 4.3.22 throws on a seek to
 *  the song's end [measured]; a play from the end starts at 0, a seek there while playing ends it. */
export const END_EPS = 0.001;
const PROCESSOR = 'sumika-midi';

/** The file is a MIDI file: its path as the ghost gave it (a drop's pseudo-path keeps the name), never its URL. */
export function isMidiPath(path) {
  if (path == null) return false;
  return MIDI_PATH.test(String(path).trim().replace(/^"(.*)"$/, '$1').trim());
}

/** The browser can run the player: a secure context with AudioContext, AudioWorkletNode and Worker. */
export function midiSupported(g = globalThis) {
  try {
    return !!g && g.isSecureContext === true && typeof g.AudioContext === 'function' &&
      typeof g.AudioWorkletNode === 'function' && typeof g.Worker === 'function';
  } catch (e) {
    return false;
  }
}

/**
 * The build table's MIDI files, relative to runtimeUrl: {js, bank}, or null (no table: unbundled; or a build without
 * them).
 * @param {{midi?: {js?: string, bank?: string}}|null} files core/build.js FILES (Site.runtimeFiles)
 */
export function midiPaths(files) {
  const m = files && typeof files === 'object' ? files.midi : null;
  return m && typeof m.js === 'string' && m.js && typeof m.bank === 'string' && m.bank ? { js: m.js, bank: m.bank } : null;
}

/** A DOMException where there is one (what an element's play() rejects with), else an Error of that name. */
function domError(name, message) {
  try {
    if (typeof DOMException === 'function') return new DOMException(message, name);
  } catch (e) { /* an engine without the constructor */ }
  return Object.assign(new Error(message), { name });
}

const text = e => (e && e.message) || String(e || 'error');
const clampTime = (t, d) => Math.max(0, Number.isFinite(d) ? Math.min(t, d) : t);
const realClock = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h) };

export class MidiEngine {
  /**
   * Making it does nothing: the context, the Worker and the module come at the first play.
   * @param {object} o
   * @param {string} o.runtimeUrl sumika.js's URL (the table's paths are relative to it)
   * @param {{js: string, bank: string}} o.paths midiPaths()
   * The rest are the browser's, injectable for tests: AudioContext, AudioWorkletNode, Worker, fetch, navigator
   * (userActivation, audioSession), clock {setTimeout, clearTimeout}, Blob and urls {createObjectURL, revokeObjectURL}
   * (the Worker's bootstrap).
   */
  constructor({
    runtimeUrl, paths, AudioContext = globalThis.AudioContext, AudioWorkletNode = globalThis.AudioWorkletNode,
    Worker = globalThis.Worker, fetch = typeof globalThis.fetch === 'function' ? (...a) => globalThis.fetch(...a) : null,
    navigator = globalThis.navigator, clock = null, Blob = globalThis.Blob, urls = globalThis.URL,
  } = {}) {
    this.jsUrl = new URL(paths.js, runtimeUrl).href;
    this.bankUrl = new URL(paths.bank, runtimeUrl).href;
    this._AC = AudioContext;
    this._AWN = AudioWorkletNode;
    this._Worker = Worker;
    this._fetch = typeof fetch === 'function' ? fetch : null;
    this._nav = navigator || null;
    this.clock = clock || realClock;
    this._Blob = typeof Blob === 'function' ? Blob : null;
    this._urls = urls && typeof urls.createObjectURL === 'function' ? urls : null;
    this.ctx = null;            // the AudioContext, made at the first play that may make it (wake)
    this._ctxWait = [];         // module()s waiting for it
    this._worker = null;
    this._jobs = new Map();     // prepare id -> {resolve, reject}
    this._jobId = 0;
    this._module = null;        // addModule's promise (forgotten when it rejects)
    this._holders = new Set();  // players from play() until a pause, their end, a failure or a release
    this._idle = null;          // the idle timer
    this._suspending = null;    // the idle suspend in flight
    this._session = null;       // {old}: the audio session type before the player set 'playback'
  }

  /** A player for one file: a ghost file's plain URL, or a dropped file's Blob (read as it is: no fetch of a blob: URL). */
  player({ url = '', blob = null } = {}) {
    return new MidiPlayer(this, { url, blob });
  }

  /** The context's clock (s): what the worklet's `at` is measured in. */
  now() {
    return this.ctx ? Number(this.ctx.currentTime) || 0 : 0;
  }

  /**
   * Called synchronously from a play(), so a play inside a gesture resumes inside it. Makes the context at its first
   * use, sets the audio session to 'playback' where there is one (Safari 16.4+: MIDI ignores the silent switch as the
   * <audio> sounds do; the old type comes back at the idle suspend), and resumes it. Resolves true once it runs; false
   * when it was refused: no user activation yet (navigator.userActivation, where it exists, says none has happened:
   * no context is made then, which Chrome would warn about), a resume that rejects (WebKit), or not running within
   * RESUME_WAIT_MS. Rejects when the context cannot be made at all.
   * @returns {Promise<boolean>}
   */
  wake() {
    if (!this.ctx) {
      const ua = this._nav && this._nav.userActivation;
      if (ua && ua.hasBeenActive === false) return Promise.resolve(false);
      try {
        // the default sample rate (WebKit bug 274507), a larger buffer for music
        this.ctx = new this._AC({ latencyHint: 'playback' });
      } catch (e) {
        log.once('midi-context', 'MIDI: no audio context', e);
        return Promise.reject(e);
      }
      for (const f of this._ctxWait.splice(0)) f(this.ctx);
    }
    this._sessionOn();
    const ctx = this.ctx;
    // a suspend in flight still reads 'running': resume after it (the context runs them in order)
    if (ctx.state === 'running' && !this._suspending) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        this.clock.clearTimeout(timer);
        resolve(ok);
      };
      const timer = this.clock.setTimeout(() => finish(ctx.state === 'running'), RESUME_WAIT_MS);
      let p;
      try { p = ctx.resume(); } catch (e) { finish(false); return; }
      Promise.resolve(p).then(() => finish(ctx.state === 'running'), () => finish(false));
    });
  }

  /** The context, once it exists (the module waits for the first play allowed to make it). */
  context() {
    if (this.ctx) return Promise.resolve(this.ctx);
    return new Promise(resolve => this._ctxWait.push(resolve));
  }

  _sessionOn() {
    const s = this._nav && this._nav.audioSession;
    if (!s || this._session) return;
    try {
      const old = s.type;
      if (old !== 'playback') s.type = 'playback';
      this._session = { old };
    } catch (e) { /* not settable */ }
  }

  _sessionOff() {
    const s = this._nav && this._nav.audioSession, k = this._session;
    this._session = null;
    if (!s || !k || k.old === 'playback') return;
    try { if (s.type === 'playback') s.type = k.old; } catch (e) { /* not settable */ }
  }

  /**
   * A player holds the context from its play() until a pause, its end, a failure or its release; each player
   * changes this only when its own flag flips. Nothing held for IDLE_MS: the context is suspended (no audio thread
   * while nothing plays) and the audio session given back; a later play resumes it (no gesture needed once it ran in
   * Chrome and Firefox [infer: sticky activation]; WebKit [verify]; a refusal is the NotAllowedError path).
   */
  hold(player, on) {
    if (on) {
      this._holders.add(player);
      if (this._idle !== null) { this.clock.clearTimeout(this._idle); this._idle = null; }
      return;
    }
    if (!this._holders.delete(player) || this._holders.size) return;
    if (this._idle !== null) this.clock.clearTimeout(this._idle);
    this._idle = this.clock.setTimeout(() => this._idleNow(), IDLE_MS);
  }

  _idleNow() {
    this._idle = null;
    if (this._holders.size) return;
    this._sessionOff();
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    let p;
    try { p = ctx.suspend(); } catch (e) { return; }
    const s = Promise.resolve(p).catch(() => {}).then(() => { if (this._suspending === s) this._suspending = null; });
    this._suspending = s;
  }

  /** The bytes of a ghost's MIDI file (its plain URL, as an element would load it). */
  async fetchBytes(url) {
    if (!this._fetch) throw new Error('no fetch');
    const r = await this._fetch(url);
    if (!r || !r.ok) throw new Error(`HTTP ${r ? r.status : 'error'}`);
    return r.arrayBuffer();
  }

  /**
   * The Worker, made at the first prepare. A worker script must be same-origin with the page, so it starts from a
   * blob: bootstrap that imports the bundle, as the SHIORI worker does (core/shiori.js): the runtime may live on another
   * origin (`worker-src blob:` is already required). Its first message is the bank's absolute URL: the download starts
   * at once.
   */
  _workerNow() {
    if (this._worker) return this._worker;
    let boot = null;
    let w;
    try {
      if (this._Blob && this._urls) {
        boot = this._urls.createObjectURL(new this._Blob([`importScripts(${JSON.stringify(this.jsUrl)});`], { type: 'text/javascript' }));
      }
      w = new this._Worker(boot || this.jsUrl);
    } catch (e) {
      if (boot) { try { this._urls.revokeObjectURL(boot); } catch (e2) { /* ignore */ } }
      throw e;
    }
    const revoke = () => {
      if (boot) { try { this._urls.revokeObjectURL(boot); } catch (e) { /* ignore */ } }
      boot = null;
    };
    this._worker = w;
    w.onmessage = ev => this._onWorker(w, (ev && ev.data) || {}, revoke);
    w.onerror = ev => {
      revoke();
      this._workerFailed(w, `MIDI worker: ${(ev && ev.message) || 'error'}`);
    };
    w.postMessage({ t: 'bank', url: this.bankUrl });
    return w;
  }

  _onWorker(w, m, revoke) {
    if (w !== this._worker) return;
    if (m.t === 'up') {
      revoke();
      // the worklet loads the same URL, now in the HTTP cache [infer]; it still waits for the context
      this.module().catch(() => {});
      return;
    }
    const job = this._jobs.get(m.id);
    if (!job) return;
    this._jobs.delete(m.id);
    if (m.t === 'prepared') job.resolve({ sf2: m.sf2, midi: m.midi, duration: Number(m.duration) });
    else {
      if (m.kind === 'bank') log.once('midi-bank', 'MIDI: the sound bank could not be loaded', m.message || '');
      job.reject(Object.assign(new Error(`MIDI: ${m.message || 'cannot prepare the song'}`), { kind: m.kind || 'midi' }));
    }
  }

  /** The Worker's error event (its script did not load, a crash): every prepare fails; the next one makes a new one. */
  _workerFailed(w, message) {
    if (w !== this._worker) return;
    this._worker = null;
    try { w.terminate(); } catch (e) { /* ignore */ }
    log.once('midi-worker', message);
    const jobs = [...this._jobs.values()];
    this._jobs.clear();
    for (const j of jobs) j.reject(Object.assign(new Error(message), { kind: 'worker' }));
  }

  /**
   * A song for the worklet: the MIDI bytes (transferred) -> {sf2, midi, duration}, the bank trimmed to what it uses.
   * @param {ArrayBuffer} bytes
   */
  prepare(bytes) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = this._workerNow(); } catch (e) { reject(e); return; }
      const id = ++this._jobId;
      this._jobs.set(id, { resolve, reject });
      const buf = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes || 0).slice().buffer;
      try {
        w.postMessage({ t: 'prepare', id, midi: buf }, [buf]);
      } catch (e) {
        this._jobs.delete(id);
        reject(e);
      }
    });
  }

  /** The worklet module, once per page; a rejection is forgotten (the next play tries again). */
  module() {
    if (!this._module) {
      const m = this.context().then(ctx => ctx.audioWorklet.addModule(this.jsUrl));
      this._module = m;
      m.catch(e => {
        if (this._module === m) this._module = null;
        log.once('midi-module', 'MIDI: the player module did not load', e);
      });
    }
    return this._module;
  }

  /** A node for one song, through its own GainNode (the volume) to the speakers. */
  connect() {
    const ctx = this.ctx;
    const node = new this._AWN(ctx, PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const gain = ctx.createGain();
    node.connect(gain);
    gain.connect(ctx.destination);
    return { node, gain };
  }
}

/**
 * One MIDI file, element-like for page-saori.js (CONTRACTS midi.js): src, preload (ignored: nothing loads before the
 * first play), paused, ended, duration (NaN until ready), currentTime, loop, volume, error ({code: 4, message} once
 * failed), onended / onerror and listeners (loadedmetadata, ended, error), play(), pause(), and removeAttribute('src')
 * then load() to release it. Events are dispatched as microtasks and never after a release.
 * Every command to the node carries a number `n`; the node echoes the number of the last command it handled in each
 * `state` and `ended`, so a reply older than the last play, pause or seek is dropped (a restart right at the end must
 * not end the new play; currentTime must not jump back). A reply without `n` is taken as current.
 */
export class MidiPlayer {
  constructor(engine, { url = '', blob = null } = {}) {
    this.engine = engine;
    this.src = String(url || '');
    this.blob = blob || null;
    this.preload = '';
    this.paused = true;
    this.ended = false;
    this.duration = NaN;
    this.error = null;
    this.onended = null;
    this.onerror = null;
    this._loop = false;
    this._volume = 1;
    this._pos = 0;            // song time (s): where it stands, or where it stood at context time _at while it plays
    this._at = null;          // context time of _pos while the node plays; null while it does not
    this._keep = null;        // a position set before `ready`, sent then
    this._listeners = [];     // {type, fn, once}
    this._plays = [];         // play() promises waiting: {resolve, reject}
    this._loading = false;
    this._prep = null;        // the prepared song while it waits for the context and module
    this._prepDuration = NaN; // the Worker's duration (the node's `ready` gives it again)
    this._ready = false;
    this._node = null;
    this._gain = null;
    this._closing = false;
    this._closeTimer = null;
    this._n = 0;              // the last command number sent
    this._posN = 0;           // the number of the last play, pause or seek
    this._sentPlay = false;   // the last play/pause sent was play
    this._confirmed = false;  // a current `state` said playing (nothing moved the song since)
    this._holding = false;
    this._wakeSeq = 0;
    this._woke = false;       // the latest wake found the context running
    this._released = false;
  }

  get currentTime() {
    let t = this._pos;
    if (this._at !== null) t += Math.max(0, this.engine.now() - this._at);
    return clampTime(t, this.duration);
  }

  set currentTime(v) {
    const t = Number(v);
    if (!Number.isFinite(t) || this._released) return;
    this._seek(Math.max(0, t));
  }

  get loop() { return this._loop; }

  set loop(v) {
    const on = !!v;
    if (on === this._loop) return;
    this._loop = on;
    if (this._ready) this._send({ t: 'loop', on });
  }

  get volume() { return this._volume; }

  /** 0..1, clamped (the music box's 0..10000 / 10000, linear as an element's); the GainNode's value. */
  set volume(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    this._volume = Math.max(0, Math.min(1, n));
    if (this._gain) { try { this._gain.gain.value = this._volume; } catch (e) { /* ignore */ } }
  }

  addEventListener(type, fn, opts) {
    if (typeof fn !== 'function') return;
    const t = String(type);
    if (this._listeners.some(l => l.type === t && l.fn === fn)) return;
    this._listeners.push({ type: t, fn, once: !!(opts && typeof opts === 'object' && opts.once) });
  }

  removeEventListener(type, fn) {
    this._listeners = this._listeners.filter(l => !(l.type === String(type) && l.fn === fn));
  }

  removeAttribute(name) {
    if (String(name).toLowerCase() === 'src') this.src = '';
  }

  /** With no src (after removeAttribute('src')): the release. A load() with a src does nothing (loads start at play). */
  load() {
    if (this.src === '') this._release();
  }

  /**
   * As an element's play(): resolves once the song plays. Rejects NotAllowedError when the context was refused (paused
   * again; the load goes on, and page-saori's afterGesture plays it inside the next gesture), NotSupportedError once it
   * failed or was released, AbortError when a pause or a release came first. A play from the end starts at 0.
   */
  play() {
    if (this._released) return Promise.reject(domError('NotSupportedError', 'the MIDI player was released'));
    if (this.error) return Promise.reject(domError('NotSupportedError', this.error.message));
    if (this._ready && this.paused && (this.ended || this.currentTime >= this.duration - END_EPS)) this._seek(0);
    const p = new Promise((resolve, reject) => this._plays.push({ resolve, reject }));
    this.paused = false;
    this._hold(true);
    const seq = ++this._wakeSeq;
    this._woke = false;
    let woke;
    try { woke = this.engine.wake(); } catch (e) { woke = Promise.reject(e); }
    this._startLoad();
    Promise.resolve(woke).then(ok => this._wakeDone(seq, ok), e => this._fail(`MIDI: no audio context (${text(e)})`));
    return p;
  }

  pause() {
    if (this._released) return;
    this.paused = true;
    this._rejectPlays('AbortError', 'paused');
    this._halt();
    this._hold(false);
  }

  // ---------------------------------------------------------------- internals

  _hold(on) {
    if (on === this._holding) return;
    this._holding = on;
    this.engine.hold(this, on);
  }

  _wakeDone(seq, ok) {
    if (this._released) return;
    if (ok) {
      this._woke = true;
      this._kick();
      return;
    }
    if (seq !== this._wakeSeq || this.paused) return;      // a newer play decides; a pause rejected the plays already
    this.paused = true;
    this._halt();
    this._hold(false);
    this._rejectPlays('NotAllowedError', 'the audio context did not start (no user activation yet)');
  }

  /** Send play once the song is ready and the context runs; a play() while it plays resolves with the next state. */
  _kick() {
    if (this._released || this.paused || !this._ready || !this._woke) return;
    if (!this._sentPlay) {
      this._sentPlay = true;
      this._send({ t: 'play' }, true);
    } else if (this._confirmed) {
      this._settle();
    }
  }

  /** The node stops if it plays; the position is frozen where it is. */
  _halt() {
    this._pos = this.currentTime;
    this._at = null;
    if (this._sentPlay) {
      this._sentPlay = false;
      this._send({ t: 'pause' }, true);
    }
  }

  _seek(t) {
    this.ended = false;
    if (!this._ready) {
      this._keep = t;
      this._pos = t;
      this._at = null;
      return;
    }
    const d = this.duration;
    if (t >= d - END_EPS) {
      if (!this._loop) {
        // as an element sought to its end: a playing song ends there, a paused one stays at its end
        this._at = null;
        if (this.paused) {
          this._pos = d;
          this.ended = true;
        } else {
          this._halt();
          this._finish();
        }
        return;
      }
      t = 0;                                               // looping: the end is the start
    }
    this._pos = t;
    if (this._at !== null) this._at = this.engine.now();  // a playing song goes on from t, now
    this._send({ t: 'seek', time: t }, true);
  }

  /** The song's end (the node's `ended`, or a seek to the end while it played). */
  _finish() {
    this.ended = true;
    this.paused = true;
    this._pos = Number.isFinite(this.duration) ? this.duration : this._pos;
    this._at = null;
    this._sentPlay = false;
    this._confirmed = false;
    this._settle();                                       // a play still waiting did play: to its end
    this._hold(false);
    this._fire('ended');
  }

  _send(m, moves = false, transfer = undefined) {
    if (!this._node || this._closing) return;
    const n = ++this._n;
    if (moves) {
      this._posN = n;
      this._confirmed = false;
    }
    try {
      this._node.port.postMessage({ ...m, n }, transfer || []);
    } catch (e) {
      this._fail(`MIDI: ${text(e)}`);
    }
  }

  /** A reply the page still waits for: none older than the last play, pause or seek (no `n`: taken as current). */
  _current(m) {
    return typeof m.n !== 'number' || m.n >= this._posN;
  }

  _startLoad() {
    if (this._loading || this._released) return;
    this._loading = true;
    this._prepare().catch(e => this._fail(text(e)));
  }

  async _prepare() {
    const e = this.engine;
    const t0 = Date.now();
    const bytes = this.blob ? await this.blob.arrayBuffer() : await e.fetchBytes(this.src);
    if (this._released) return;
    const prep = await e.prepare(bytes);
    if (this._released) return;
    log.debug(`MIDI: a song prepared in ${Date.now() - t0} ms (${Number(prep.duration).toFixed(1)} s)`);
    this._prep = prep;
    // the context may not exist yet (no activation): only `this` waits with it, the release drops the song
    e.module().then(() => this._attach(), err => this._fail(`MIDI: the player module did not load (${text(err)})`));
  }

  _attach() {
    const prep = this._prep;
    this._prep = null;
    if (this._released || this.error || !prep) return;
    let nodes;
    try { nodes = this.engine.connect(); } catch (e) { this._fail(`MIDI: ${text(e)}`); return; }
    this._node = nodes.node;
    this._gain = nodes.gain;
    try { this._gain.gain.value = this._volume; } catch (e) { /* ignore */ }
    this._prepDuration = Number(prep.duration);
    this._node.port.onmessage = ev => this._onNode((ev && ev.data) || {});
    this._node.onprocessorerror = () => this._fail('MIDI: the player stopped');
    const transfer = [prep.sf2, prep.midi].filter(b => b instanceof ArrayBuffer);
    this._send({ t: 'load', sf2: prep.sf2, midi: prep.midi }, false, transfer);
  }

  _onNode(m) {
    if (m.t === 'closed') { this._disconnect(); return; }
    if (this._released || this.error) return;
    switch (m.t) {
      case 'ready': this._onReady(m); break;
      case 'state': this._onState(m); break;
      case 'ended': this._onEnded(m); break;
      case 'error': this._fail(`MIDI: ${m.message || 'error'}`); break;
      default: break;
    }
  }

  _onReady(m) {
    if (this._ready) return;
    let d = Number(m.duration);
    if (!(Number.isFinite(d) && d >= 0)) d = Number.isFinite(this._prepDuration) && this._prepDuration >= 0 ? this._prepDuration : 0;
    this.duration = d;
    this._ready = true;
    this._fire('loadedmetadata');                         // dispatched after the kept position below is in place
    if (this._loop) this._send({ t: 'loop', on: true });
    const keep = this._keep;
    this._keep = null;
    if (keep !== null && keep > 0) this._seek(keep);
    this._kick();
  }

  _onState(m) {
    if (!this._current(m)) return;
    const pos = Number(m.pos), at = Number(m.at);
    if (Number.isFinite(pos)) this._pos = clampTime(pos, this.duration);
    const playing = !!m.playing && !this.paused;
    this._at = playing && Number.isFinite(at) ? at : null;
    this._confirmed = playing;
    if (playing) this._settle();
    else if (this._sentPlay && !this.paused && !m.playing) {
      // the node stopped by itself (its end, whose `ended` was older than the seek or play that followed): again
      this._sentPlay = false;
      this._kick();
    }
  }

  _onEnded(m) {
    if (!this._current(m) || !this._sentPlay) return;     // a pause or a seek came after it: stale
    this._sentPlay = false;
    if (this._loop) {                                     // looped meanwhile: start over as the element's loop does
      this._pos = 0;
      this._at = null;
      this._send({ t: 'seek', time: 0 }, true);
      this._sentPlay = true;
      this._send({ t: 'play' }, true);
      return;
    }
    this._finish();
  }

  /** The player cannot play (fetch, prepare, module, node, the processor): once; its node goes at once. */
  _fail(message) {
    if (this._released || this.error) return;
    this.error = { code: 4, message: String(message || 'MIDI error') };   // MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
    this._prep = null;
    this.paused = true;
    this._at = null;
    this._sentPlay = false;
    this._confirmed = false;
    this._hold(false);
    this._rejectPlays('NotSupportedError', this.error.message);
    this._close();
    this._fire('error');
  }

  _release() {
    if (this._released) return;
    this._released = true;
    this.paused = true;
    this._prep = null;
    this._keep = null;
    this._at = null;
    this._sentPlay = false;
    this._hold(false);
    this._rejectPlays('AbortError', 'the MIDI player was released');
    this._close();
  }

  /** close: the node lets its notes ring out and answers `closed`; it is disconnected then, or CLOSE_WAIT_MS later. */
  _close() {
    if (!this._node || this._closing) return;
    this._closing = true;
    try { this._node.port.postMessage({ t: 'close', n: ++this._n }); } catch (e) { /* gone already */ }
    this._closeTimer = this.engine.clock.setTimeout(() => this._disconnect(), CLOSE_WAIT_MS);
  }

  _disconnect() {
    if (this._closeTimer !== null) { this.engine.clock.clearTimeout(this._closeTimer); this._closeTimer = null; }
    const node = this._node, gain = this._gain;
    this._node = null;
    this._gain = null;
    if (node) {
      try { node.port.onmessage = null; } catch (e) { /* ignore */ }
      node.onprocessorerror = null;
      try { node.disconnect(); } catch (e) { /* ignore */ }
    }
    if (gain) { try { gain.disconnect(); } catch (e) { /* ignore */ } }
  }

  _settle() {
    const list = this._plays;
    this._plays = [];
    for (const p of list) p.resolve();
  }

  _rejectPlays(name, message) {
    const list = this._plays;
    this._plays = [];
    for (const p of list) p.reject(domError(name, message));
  }

  _fire(type) {
    queueMicrotask(() => {
      if (this._released) return;
      const ev = { type, target: this };
      const own = this[`on${type}`];
      if (typeof own === 'function') { try { own.call(this, ev); } catch (e) { log.once(`midi-handler:${type}`, `MIDI: a ${type} handler failed`, e); } }
      for (const l of this._listeners.filter(x => x.type === type)) {
        if (l.once) this._listeners = this._listeners.filter(x => x !== l);
        try { l.fn.call(this, ev); } catch (e) { log.once(`midi-handler:${type}`, `MIDI: a ${type} handler failed`, e); }
      }
    });
  }
}

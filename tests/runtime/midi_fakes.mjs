// Fakes for the MIDI player's browser parts (src/core/midi.js): an AudioContext, AudioWorkletNode, Worker, Blob and
// object URLs, a navigator and a fetch, with a MidiEngine made on them. The node models the worklet's protocol
// (midi.md §5.5): `load` -> `ready`, each play / pause / seek / loop -> `state` echoing the command's `n`, `close` ->
// `closed`; end() is the song reaching its end. The Worker is answered by hand (prepared()). Not a test file.
import { MidiEngine } from '../../src/core/midi.js';
import { FakeClock, settle } from './fakes.mjs';

export const RUNTIME_URL = 'http://site/sumika/sumika.js';
export const PATHS = { js: 'engines/midi.0123456789.js', bank: 'engines/generaluser_gs.abcdef0123.sf3.gz' };
export const JS_URL = 'http://site/sumika/engines/midi.0123456789.js';
export const BANK_URL = 'http://site/sumika/engines/generaluser_gs.abcdef0123.sf3.gz';

const later = f => Promise.resolve().then(f);

/**
 * @param {object} [o]
 * @param {'run'|'hang'|'reject'} [o.resume] what ctx.resume() does: run (resolves, running), hang (never settles),
 *   reject (WebKit's refusal)
 * @param {boolean} [o.activated] navigator.userActivation.hasBeenActive (undefined: no userActivation at all)
 * @param {boolean} [o.auto] the node answers by itself (else the test replies by hand)
 * @param {boolean} [o.echo] the node echoes `n` in its replies
 * @param {number} [o.duration] the song's length the node reports at `ready`
 */
export function midiRig({ resume = 'run', activated = true, auto = true, echo = true, duration = 60, session = true } = {}) {
  const r = {
    resume, auto, echo, duration, moduleFail: false,
    contexts: [], nodes: [], workers: [], fetched: [], blobs: new Map(), revoked: [], clock: new FakeClock(),
    fetchStatus: 200,
  };
  r.nav = {};
  if (activated !== undefined) r.nav.userActivation = { hasBeenActive: activated };
  if (session) r.nav.audioSession = { type: 'auto' };

  class Ctx {
    constructor(opts) {
      this.opts = opts;
      this.state = 'suspended';
      this.currentTime = 0;
      this.resumes = 0;
      this.suspends = 0;
      this.modules = [];
      this.gains = [];
      this.destination = { destination: true };
      this.audioWorklet = {
        addModule: url => {
          this.modules.push(url);
          return r.moduleFail ? Promise.reject(new Error('module refused')) : Promise.resolve();
        },
      };
      r.contexts.push(this);
    }
    resume() {
      this.resumes++;
      if (r.resume === 'run') { this.state = 'running'; return Promise.resolve(); }
      if (r.resume === 'reject') return Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
      return new Promise(() => {});
    }
    suspend() {
      this.suspends++;
      this.state = 'suspended';
      return Promise.resolve();
    }
    createGain() {
      const g = { gain: { value: 1 }, connected: [], disconnected: false, connect(x) { this.connected.push(x); }, disconnect() { this.disconnected = true; } };
      this.gains.push(g);
      return g;
    }
  }

  class Node {
    constructor(ctx, name, opts) {
      this.ctx = ctx;
      this.name = name;
      this.opts = opts;
      this.sent = [];
      this.transfers = [];
      this.connected = [];
      this.disconnected = false;
      this.onprocessorerror = null;
      this.playing = false;
      this.pos = 0;
      this.since = 0;
      this.loop = false;
      this.lastN = 0;
      const node = this;
      this.port = {
        onmessage: null,
        postMessage(m, transfer) { node.sent.push(m); node.transfers.push(transfer || []); node._handle(m); },
      };
      r.nodes.push(this);
    }
    connect(x) { this.connected.push(x); }
    disconnect() { this.disconnected = true; }
    reply(m) { if (this.port.onmessage) this.port.onmessage({ data: m }); }
    types() { return this.sent.map(m => m.t); }
    last(t) { return this.sent.filter(m => m.t === t).at(-1); }
    _n(m) { return r.echo ? { ...m, n: this.lastN } : m; }
    /** the song's position now: it advances with the context's clock while it plays */
    _pos() { return this.playing ? this.pos + (this.ctx.currentTime - this.since) : this.pos; }
    _state() {
      const m = this._n({ t: 'state', playing: this.playing, pos: this._pos(), at: this.ctx.currentTime });
      later(() => this.reply(m));
    }
    _handle(m) {
      if (typeof m.n === 'number') this.lastN = m.n;
      if (!r.auto) return;
      switch (m.t) {
        case 'load': later(() => this.reply({ t: 'ready', duration: r.duration })); break;
        case 'play': if (!this.playing) { this.playing = true; this.since = this.ctx.currentTime; } this._state(); break;
        case 'pause': this.pos = this._pos(); this.playing = false; this._state(); break;
        case 'seek': this.pos = m.time; this.since = this.ctx.currentTime; this._state(); break;
        case 'loop': this.loop = !!m.on; this._state(); break;
        case 'close': this.pos = this._pos(); this.playing = false; later(() => this.reply({ t: 'closed' })); break;
        default: break;
      }
    }
    /** The song reaches its end: a loop starts over (state, no end), else `ended`. */
    end() {
      if (this.loop) {
        this.pos = 0;
        this.since = this.ctx.currentTime;
        this.reply(this._n({ t: 'state', playing: true, pos: 0, at: this.ctx.currentTime }));
        return;
      }
      this.playing = false;
      this.pos = r.duration;
      this.reply(this._n({ t: 'ended', pos: r.duration }));
    }
  }

  class W {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      r.workers.push(this);
    }
    postMessage(m) { this.sent.push(m); }
    terminate() { this.terminated = true; }
    reply(m) { if (this.onmessage) this.onmessage({ data: m }); }
    fail(message) { if (this.onerror) this.onerror({ message }); }
    jobs() { return this.sent.filter(m => m.t === 'prepare'); }
  }

  class FakeBlob {
    constructor(parts, o = {}) { this.parts = parts; this.type = o.type || ''; }
  }

  r.urls = {
    n: 0,
    createObjectURL(b) { const u = `blob:fake/${++this.n}`; r.blobs.set(u, b); return u; },
    revokeObjectURL(u) { r.revoked.push(u); },
  };
  r.blobText = u => { const b = r.blobs.get(u); return b ? b.parts.join('') : null; };
  r.fetch = async url => {
    r.fetched.push(url);
    const ok = r.fetchStatus >= 200 && r.fetchStatus < 300;
    return { ok, status: r.fetchStatus, arrayBuffer: async () => new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]).buffer };
  };
  r.Ctx = Ctx;
  r.Node = Node;
  r.Worker = W;
  r.engine = new MidiEngine({
    runtimeUrl: RUNTIME_URL, paths: PATHS, AudioContext: Ctx, AudioWorkletNode: Node, Worker: W, fetch: r.fetch,
    navigator: r.nav, clock: r.clock, Blob: FakeBlob, urls: r.urls,
  });
  r.ctx = () => r.contexts.at(-1) || null;
  r.node = () => r.nodes.at(-1) || null;
  r.worker = () => r.workers.at(-1) || null;

  /** Answer the Worker: `up` once, then every prepare not answered yet (or fail them: {kind, message}). */
  r.prepared = async ({ duration = r.duration, fail = null } = {}) => {
    await settle();
    const w = r.worker();
    if (!w) throw new Error('no worker');
    if (!w._up) { w._up = true; w.reply({ t: 'up' }); }
    for (const job of w.jobs()) {
      if (job.answered) continue;
      job.answered = true;
      if (fail) w.reply({ t: 'failed', id: job.id, kind: fail.kind || 'midi', message: fail.message || 'not a MIDI file' });
      else w.reply({ t: 'prepared', id: job.id, sf2: new ArrayBuffer(16), midi: new ArrayBuffer(8), duration });
    }
    await settle();
  };
  return r;
}

/** Every seek any node got, as times. */
export const seeks = r => r.nodes.flatMap(n => n.sent.filter(m => m.t === 'seek').map(m => m.time));

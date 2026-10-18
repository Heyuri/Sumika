// Fakes for the runtime tests: a manual clock, a scripted SHIORI client, a player, a stage, balloons and dialogs.
import { Emitter } from '../../src/core/emitter.js';

export const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/** Manual clock: timers run only inside advance(). */
export class FakeClock {
  constructor(t = new Date(2026, 9, 6, 21, 13, 20, 0).getTime()) { this.t = t; this.q = []; this.seq = 0; }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = ++this.seq; this.q.push({ id, at: this.t + Math.max(0, Number(ms) || 0), fn }); return id; }
  clearTimeout(id) { this.q = this.q.filter(x => x.id !== id); }
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await settle();
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const n = this.q[0];
      if (!n || n.at > end) break;
      this.q.shift();
      this.t = n.at;
      n.fn();
    }
    this.t = end;
    await settle();
  }
}

/**
 * SHIORI client double. handler(req) -> string (200 Value), null (204), {status, value, headers?: {Name: value}} (any
 * status, any response headers), or a Promise of one. The response's headers are a Map with lower-cased names, the
 * Value among them, as parseResponse makes it. Every request is logged as {method, id, refs, headers}, plus `fmo`: the
 * text the request's fmo() gave (a Satori loop's, EV §2.7.8), read when it is logged.
 */
export class FakeShiori {
  constructor(handler = () => null) {
    this.handler = handler;
    this.log = [];
    this.unloaded = false;
    this.persisted = 0;
  }
  async request(r) {
    const entry = { method: r.method || 'GET', id: r.id, refs: r.refs || [], headers: r.headers || {} };
    if (r.kind) entry.kind = r.kind;          // the call for a SHIORI/2.x engine (shiori2.js), as the client posts it
    if (typeof r.fmo === 'function') { try { entry.fmo = r.fmo(); } catch (e) { entry.fmo = undefined; } }
    this.log.push(entry);
    const v = await this.handler(entry);
    const res = (status, value, more) => {
      const headers = new Map();
      for (const [k, x] of Object.entries(more || {})) if (!headers.has(k.toLowerCase())) headers.set(k.toLowerCase(), String(x));
      if (typeof value === 'string' && !headers.has('value')) headers.set('value', value);
      return { status, headers, value: headers.has('value') ? headers.get('value') : null };
    };
    if (v && typeof v === 'object') return res(v.status, v.value ?? null, v.headers);
    return v == null || v === '' ? res(204, null) : res(200, v);
  }
  async unload() { this.unloaded = true; return []; }
  async persist() { this.persisted++; return []; }
  ids() { return this.log.map(r => `${r.method} ${r.id}`); }
  find(id, method) { return this.log.filter(r => r.id === id && (!method || r.method === method)); }
}

export class FakePlayer extends Emitter {
  constructor() {
    super();
    this.plays = [];
    this.replays = [];
    this.busy = false;
    this.choosing = false;
    this.timeCritical = false;
    this.noUserBreak = false;  // ScriptPlayer.noUserBreak (Status nouserbreak)
    this.cur = null;
    this.interrupts = 0;
    this.pos = 0;              // character offset of the current token (ScriptPlayer.position)
    this.shown = true;         // PlayResult.shown of a run cut short (a break, a newer run): it had shown something
    this.instant = false;      // play() ends the run at once, as ScriptPlayer does with a script that has no wait
  }
  get position() { return this.pos; }
  setStage(stage) { this.stage = stage; }          // ScriptPlayer.setStage (a shell swap)
  _start(entry) {
    if (this.cur && this.busy) this.cur.resolve({ reason: 'replaced', hasChoices: false, shown: this.shown });
    const d = deferred();
    Object.assign(entry, d);
    this.cur = entry;
    this.busy = !this.instant;
    if (this.instant) d.resolve({ reason: 'end', hasChoices: false, noChoiceTimeout: false, shown: true });
    return d.promise;
  }
  play(script, meta) {
    const e = { script, meta };
    this.plays.push(e);
    const p = this._start(e);
    this.emit('start', { event: (meta && meta.event) || '', refs: (meta && meta.refs) || [], replay: false });   // like ScriptPlayer._begin
    return p;
  }
  replay(run) {
    const e = { script: run.src, meta: { event: run.origin }, run };
    this.replays.push(e);
    const p = this._start(e);
    this.emit('start', { event: run.origin || '', refs: [], replay: true });
    return p;
  }
  finish(result = {}) {
    this.busy = false;
    this.cur.resolve({ reason: 'end', hasChoices: false, noChoiceTimeout: false, shown: true, ...result });
  }
  interrupt() {
    this.interrupts++;
    if (!this.busy) return;
    this.busy = false;
    this.cur.resolve({ reason: 'interrupted', hasChoices: false, shown: this.shown });
  }
  runState() {
    return this.cur ? { src: this.cur.script, ip: 3, state: this.busy ? 'running' : 'finished', hasChoices: false } : null;
  }
  get last() { return this.plays[this.plays.length - 1]; }
}

export class FakeChar {
  constructor(scope, surfaceId) {
    this.scope = scope;
    this.surfaceId = surfaceId;
    this.shown = true;
    this.rect = { x: 900, y: 300, width: 200, height: 400 };
    this.surfaces = [];          // every setSurface() id
  }
  get visible() { return this.shown && this.surfaceId >= 0; }
  hide() { this.shown = false; }
  show() { this.shown = true; }
  setSurface(id) { this.surfaces.push(id); this.surfaceId = id; return true; }
}

/**
 * Stage double: scopes 0 (surface 0) and 1 (surface 10), shell `master` with an empty descript and surface ids 0 and
 * 10, setBind / dressupMenu that record their calls, destroy / setVeiled.
 */
export class FakeStage extends Emitter {
  constructor() {
    super();
    this.chars = new Map([[0, new FakeChar(0, 0)], [1, new FakeChar(1, 10)]]);
    this.chars.get(1).rect = { x: 600, y: 696, width: 4, height: 4 };
    this.info = ['0\x01髪\x01ポニーテール\x01\x011\x01', '0\x01足\x01ニーソピンク\x01\x011\x01'];
    this.resets = 0;
    this.shellId = 'master';
    this.shell = { descript: new Map(), surfaceIds: () => [0, 10] };
    this.binds = [];             // setBind() calls: [scope, id, on, opts]
    this.destroyed = false;
    this.veiled = false;
  }
  char(s) {
    if (!this.chars.has(s)) this.chars.set(s, new FakeChar(s, -1));
    return this.chars.get(s);
  }
  get scopes() { return [...this.chars.keys()].sort((a, b) => a - b); }
  dressupInfo() { return this.info.join('\r\n'); }
  saveState() { return { v: 1, scopes: { 0: { surface: this.chars.get(0).surfaceId } } }; }
  resetPositions() { this.resets++; }
  setBind(scope, id, on, opts = {}) { this.binds.push([scope, id, on, opts]); return []; }
  dressupMenu() { return { mode: 'manual', enabled: false, entries: [] }; }
  setVeiled(on) { this.veiled = !!on; }
  destroy() { this.destroyed = true; }
}

/** The text-area numbers FakeBalloons.metrics() answers (BalloonModel#metrics, balloon-image px). */
export const FAKE_METRICS = Object.freeze({
  validWidth: 240, validWidthInitial: 250, validHeight: 120, validHeightInitial: 110, lines: 9, linesInitial: 8,
  basePos: Object.freeze({ x: 12, y: 14 }), charWidth: 6, vertical: 0,
});

export class FakeBalloons extends Emitter {
  constructor() {
    super();
    this.hidden = 0; this.hovered = false; this.skins = []; this.stages = []; this.destroyed = false; this.views = new Map();
    this.choosing = false;     // Balloons#choosing: a \q / \__q item while a balloon is up (Status choosing)
  }
  /** a BalloonView stand-in per scope: kind (\b) and rect (desk CSS px) for the property system */
  get(scope) {
    if (!this.views.has(scope)) {
      const rect = { x: 700 - 200 * scope, y: 200, width: 300, height: 150 };
      this.views.set(scope, { scope, kind: 0, rect, setKind(k) { this.kind = k; } });
    }
    return this.views.get(scope);
  }
  metrics() { return { ...FAKE_METRICS, basePos: { ...FAKE_METRICS.basePos } }; }
  defaultKind() { return 0; }
  hideAll() { this.hidden++; }
  saveState() { return { v: 1 }; }
  visibleKinds() { return []; }
  setSkin(skin) { this.skins.push(skin); this.skin = skin; }
  setStage(stage) { this.stages.push(stage); this.stage = stage; }
  destroy() { this.destroyed = true; }
}

export class FakeDialogs {
  constructor() { this.boxes = []; this.closed = []; this.skins = []; this.stages = []; }
  setSkin(skin) { this.skins.push(skin); }
  setStage(stage) { this.stages.push(stage); }
  destroy() { this.destroyed = true; }
  inputBox(o) {
    const d = deferred();
    this.boxes.push({ kind: 'input', o, ...d });
    return d.promise;
  }
  communicateBox(o) {
    const d = deferred();
    this.boxes.push({ kind: 'communicate', o, ...d });
    return d.promise;
  }
  teachBox(o) {
    const d = deferred();
    this.boxes.push({ kind: 'teach', o, ...d });
    return d.promise;
  }
  close(id) {
    this.closed.push(id);
    for (const b of this.boxes) {
      if (b.kind === 'input' && b.o.id === id) b.resolve({ text: null, timedOut: false });
      if (b.kind === 'teach' && id === 'teachbox') b.resolve({ text: null, timedOut: false, reason: 'closed' });
    }
  }
  get anyOpen() { return false; }
}

/** Minimal window: capture listeners per type, dispatch(type, event). */
export class FakeWindow {
  constructor() { this.l = new Map(); this.opened = []; }
  addEventListener(t, f) { if (!this.l.has(t)) this.l.set(t, new Set()); this.l.get(t).add(f); }
  removeEventListener(t, f) { const s = this.l.get(t); if (s) s.delete(f); }
  dispatch(t, ev) { for (const f of this.l.get(t) || []) f(ev); }
  open(url) { this.opened.push(url); }
}

export function keyEvent(code, key, o = {}) {
  const ev = {
    code, key, keyCode: o.keyCode || 0, repeat: !!o.repeat, shiftKey: !!o.shift, ctrlKey: !!o.ctrl, altKey: !!o.alt,
    metaKey: false, isComposing: false, defaultPrevented: false, prevented: false, stopped: false,
    target: o.target || { nodeType: 1, tagName: 'BODY' },
    composedPath() { return [this.target]; },
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  return ev;
}

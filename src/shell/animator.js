// SERIKO/MAYUNA animation scheduler for one character (SH §6.2, §6.4). Pure: time is passed in explicitly
// (ms, any monotonic clock), randomness is injectable, nothing touches the DOM.
//
// Trigger hooks the rest of the runtime calls (through CharacterView):
//   setSurface(surf, now)      \s[id]: stops everything, starts runonce/always, arms random/periodic
//   talk(now, n)               n characters were shown in this scope's balloon ('talk[,N]' intervals)
//   talkState(now, on)         the scope started/stopped talking ('starttalk' / 'endtalk')
//   scriptEnd(now)             \e reached ('yen-e')
//   bindChanged(id, on, now)   dress-up group id turned on/off ('bind+X' start/stop, pure binds redraw)
//   start/stop(id)             \i[ID], \![anim,start|stop|clear,ID], pattern start/stop methods
import { log } from '../core/log.js';

export const AUTO = 0;
export const EXPLICIT = 1;

const MAX_DEPTH = 32;     // nested start chains inside one step (guards start-cycles)
const MIN_CYCLE = 16;     // ms; an 'always' animation whose cycle takes no time restarts at most this often
const STALL = 1000;       // ms; loops and start chains further behind than this restart at `now`

/**
 * @typedef {Object} AnimRuntime
 * @property {import('./surfaces.js').AnimDef} def
 * @property {boolean} running
 * @property {boolean} paused
 * @property {number} next       index of the next pattern
 * @property {number} dueAt      when patterns[next] fires
 * @property {{surface:number, x:number, y:number, method:string, alpha:number|undefined}|null} frame
 * @property {number|null} baseOverride
 * @property {{x:number,y:number}|null} move
 * @property {number} baseSeq
 * @property {number} moveSeq
 */

export class Animator {
  /**
   * @param {{bindOn?: (id:number)=>boolean, random?: ()=>number}} [opts]
   */
  constructor({ bindOn = () => false, random = Math.random } = {}) {
    this.bindOn = bindOn;
    this.random = random;
    this.surface = null;
    /** @type {Map<number, AnimRuntime>} */
    this.runtimes = new Map();
    this.offsets = new Map();        // \![anim,offset]: id -> {x,y}, until the next \s
    this.exclusive = null;           // {owner, ids: Set|null}
    this.nextRandom = Infinity;
    this.periodic = new Map();       // id -> due
    this.talkCount = 0;
    this.dirty = false;              // composition changed
    this.moved = false;              // a 'move' offset changed
    this._seq = 0;
    this._depth = 0;
    this._waiters = new Map();       // id -> [resolve]
    this._randomIds = [];
  }

  /** @param {import('./surfaces.js').SurfaceDef|null} surf */
  setSurface(surf, now) {
    this.stopAll();
    this.surface = surf;
    this.runtimes = new Map();
    this.offsets = new Map();
    this.periodic = new Map();
    this._randomIds = [];
    this.exclusive = null;
    this.dirty = true;
    if (!surf) { this.nextRandom = Infinity; return; }
    for (const id of [...surf.anims.keys()].sort((a, b) => a - b)) {
      const def = surf.anims.get(id);
      if (def.isPureBind) continue;
      const rt = { def, running: false, paused: false, pausedAt: 0, next: 0, dueAt: 0, frame: null, baseOverride: null,
        move: null, baseSeq: 0, moveSeq: 0, startedAt: 0, gen: 0 };
      this.runtimes.set(id, rt);
      const a = def.atoms;
      if (a.has('sometimes') || a.has('rarely') || a.has('random')) this._randomIds.push(id);
      if (a.has('periodic') && def.param > 0) this.periodic.set(id, now + def.param * 1000);
    }
    this.nextRandom = now + 1000;
    for (const rt of this.runtimes.values()) {
      const a = rt.def.atoms;
      if (a.has('runonce') || a.has('always')) this._start(rt, now, AUTO, now);
    }
  }

  eligible(rt) { return !rt.def.isBind || this.bindOn(rt.def.id); }

  /** Start animation `id` on the current surface. @returns {boolean} started */
  start(id, now, cause = EXPLICIT) {
    const rt = this.runtimes.get(id);
    if (!rt) return false;
    return this._start(rt, now, cause, now);
  }

  stop(id) {
    const rt = this.runtimes.get(id);
    if (rt) this._stop(rt);
  }

  stopAll() {
    for (const rt of this.runtimes.values()) this._stop(rt);
    this.exclusive = null;
  }

  isAnimating(id) {
    const rt = this.runtimes.get(id);
    return !!(rt && rt.running);
  }

  /** Resolves when animation `id` finishes or is stopped (immediately if it is not running). */
  wait(id) {
    if (!this.isAnimating(id)) return Promise.resolve();
    return new Promise(res => {
      let l = this._waiters.get(id);
      if (!l) this._waiters.set(id, l = []);
      l.push(res);
    });
  }

  pause(id, now) {
    const rt = this.runtimes.get(id);
    if (rt && rt.running && !rt.paused) { rt.paused = true; rt.pausedAt = now; }
  }

  resume(id, now) {
    const rt = this.runtimes.get(id);
    if (rt && rt.paused) { rt.paused = false; rt.dueAt += now - rt.pausedAt; }
  }

  /** \![anim,offset,ID,x,y] (works for binds too) */
  setOffset(id, x, y) { this.offsets.set(id, { x: x | 0, y: y | 0 }); this.dirty = true; }
  offset(id) { return this.offsets.get(id) || null; }

  /** 'talk' intervals: `n` characters were shown in this scope's balloon. */
  talk(now, n = 1) {
    if (!this.surface || n <= 0) return;
    const before = this.talkCount;
    this.talkCount += n;
    for (const rt of this.runtimes.values()) {
      if (!rt.def.atoms.has('talk')) continue;
      const N = rt.def.param > 0 ? rt.def.param : 1;
      if (Math.floor(this.talkCount / N) > Math.floor(before / N)) this._start(rt, now, AUTO, now);
    }
  }

  /** 'starttalk' / 'endtalk' (P2) */
  talkState(now, talking) {
    const atom = talking ? 'starttalk' : 'endtalk';
    for (const rt of this.runtimes.values()) if (rt.def.atoms.has(atom)) this._start(rt, now, AUTO, now);
  }

  /** 'yen-e': \e was reached */
  scriptEnd(now) {
    for (const rt of this.runtimes.values()) if (rt.def.atoms.has('yen-e')) this._start(rt, now, AUTO, now);
  }

  /** A bind group changed. Pure binds only need a redraw; bind+X animations start (AUTO) or stop. */
  bindChanged(id, on, now) {
    this.dirty = true;
    const rt = this.runtimes.get(id);
    if (!rt || !rt.def.isBind) return;
    if (!on) { this._stop(rt); return; }
    const a = rt.def.atoms;
    if (a.has('runonce') || a.has('always')) this._start(rt, now, AUTO, now);
  }

  /** Advance to `now`. @returns {boolean} whether the composition (or the move offset) changed */
  tick(now) {
    if (this.surface) {
      if (this._randomIds.length) {
        if (now - this.nextRandom > 5000) this.nextRandom = now;
        while (now >= this.nextRandom) {
          for (const id of this._randomIds) {
            const rt = this.runtimes.get(id);
            if (rt.running || !this.eligible(rt)) continue;
            const a = rt.def.atoms;
            const N = a.has('sometimes') ? 2 : a.has('rarely') ? 4 : rt.def.param;
            if (N > 0 && this.random() * N < 1) this._start(rt, this.nextRandom, AUTO, now);
          }
          this.nextRandom += 1000;
        }
      }
      for (const [id, due0] of this.periodic) {
        const rt = this.runtimes.get(id);
        const period = rt.def.param * 1000;
        let due = due0;
        if (now - due > 5 * period) due = now;
        while (now >= due) { if (this.eligible(rt)) this._start(rt, due, AUTO, now); due += period; }
        this.periodic.set(id, due);
      }
      for (const rt of this.runtimes.values()) {
        if (!rt.running || rt.paused || now < rt.dueAt) continue;
        this._step(rt, now);
      }
    }
    const changed = this.dirty || this.moved;
    this.dirty = false;
    return changed;
  }

  /** Earliest time something is due (ms), Infinity when idle. */
  nextDue() {
    let t = Infinity;
    if (this._randomIds.length) t = this.nextRandom;
    for (const due of this.periodic.values()) if (due < t) t = due;
    for (const rt of this.runtimes.values()) if (rt.running && !rt.paused && rt.dueAt < t) t = rt.dueAt;
    return t;
  }

  /** Surface id that currently replaces the base (most recent 'base' frame still in effect), or null. */
  baseOverride() {
    let best = null, seq = -1;
    for (const rt of this.runtimes.values()) {
      if (rt.baseOverride !== null && rt.baseSeq > seq && this.eligible(rt)) { best = rt.baseOverride; seq = rt.baseSeq; }
    }
    return best;
  }

  /** Window offset of the most recent 'move' still in effect, or null. */
  moveOffset() {
    let best = null, seq = -1;
    for (const rt of this.runtimes.values()) {
      if (rt.move && rt.moveSeq > seq) { best = rt.move; seq = rt.moveSeq; }
    }
    return best;
  }

  /** The current frame of animation `id` (persisting after a natural end), or null. */
  frame(id) {
    const rt = this.runtimes.get(id);
    return rt && this.eligible(rt) ? rt.frame : null;
  }

  /** Animation `id` counts as active for its collisions (running, or showing a persisting frame). */
  active(id) {
    const rt = this.runtimes.get(id);
    if (!rt) return this.surface && this.surface.anims.get(id) && this.surface.anims.get(id).isPureBind ? this.bindOn(id) : false;
    return this.eligible(rt) && (rt.running || rt.frame !== null || rt.baseOverride !== null);
  }

  // ---------------------------------------------------------------- internals

  /** Start rt at logical time `t`, then run its patterns that are due by `now`. */
  _start(rt, t, cause, now = t) {
    if (!this._begin(rt, t, cause)) return false;
    if (this._depth >= MAX_DEPTH) {
      log.once('shell:animdepth:' + rt.def.id, 'shell: animation start chain too deep', rt.def.id);
      return true;
    }
    this._depth++;
    try { this._step(rt, now); } finally { this._depth--; }
    return true;
  }

  _begin(rt, t, cause, loop = false) {
    if (!this.eligible(rt)) return false;
    const id = rt.def.id;
    const ex = this.exclusive;
    if (ex && ex.owner !== id && (!ex.ids || ex.ids.has(id))) return false;
    if (rt.running && cause === AUTO) return false;
    if (rt.def.exclusive) {
      const list = rt.def.exclusive;
      for (const other of this.runtimes.values()) {
        if (other !== rt && other.running && (list === true || list.includes(other.def.id))) this._stop(other);
      }
      this.exclusive = { owner: id, ids: list === true ? null : new Set(list) };
    }
    rt.running = true;
    rt.paused = false;
    rt.next = 0;
    rt.gen++;
    if (!loop) {
      // a fresh start clears the previous run's frame; an 'always' loop keeps it until the next frame replaces it
      if (rt.frame || rt.baseOverride !== null) this.dirty = true;
      if (rt.move) this.moved = true;
      rt.frame = null;
      rt.baseOverride = null;
      rt.move = null;
    }
    rt.startedAt = t;
    const pats = rt.def.patterns;
    rt.dueAt = t + (pats.length ? this._delay(pats[0]) : 0);
    return true;
  }

  _stop(rt) {
    if (rt.frame || rt.baseOverride !== null) this.dirty = true;
    if (rt.move) this.moved = true;
    const was = rt.running;
    rt.running = false;
    rt.paused = false;
    rt.frame = null;
    rt.baseOverride = null;
    rt.move = null;
    if (this.exclusive && this.exclusive.owner === rt.def.id) this.exclusive = null;
    if (was) this._resolve(rt.def.id);
  }

  _resolve(id) {
    const l = this._waiters.get(id);
    if (!l) return;
    this._waiters.delete(id);
    for (const f of l) f();
  }

  _delay(p) {
    if (p.ids) return 0;   // control methods fire right after the previous pattern
    return p.wmin === p.wmax ? p.wmin : p.wmin + Math.floor(this.random() * (p.wmax - p.wmin + 1));
  }

  /** Apply the patterns of rt that are due by `now`; handle the natural end and 'always' restarts (iteratively). */
  _step(rt, now) {
    const pats = rt.def.patterns;
    for (;;) {
      while (rt.running && !rt.paused && rt.next < pats.length && now >= rt.dueAt) {
        const p = pats[rt.next++];
        const gen = rt.gen;
        this._apply(rt, p, now);
        if (!rt.running || rt.gen !== gen) return;   // stopped, or restarted (and stepped) by a nested start
        if (rt.next < pats.length) rt.dueAt += this._delay(pats[rt.next]);
      }
      if (!rt.running || rt.paused || rt.next < pats.length) return;
      // natural end: the last frame, base and move persist (SH §6.4)
      const tEnd = rt.dueAt;
      rt.running = false;
      if (this.exclusive && this.exclusive.owner === rt.def.id) this.exclusive = null;
      this._resolve(rt.def.id);
      if (!rt.def.atoms.has('always') || !this.eligible(rt)) return;
      let t = Math.max(tEnd, rt.startedAt + MIN_CYCLE);
      if (now - t > STALL) t = now;   // after a long stall (hidden tab) loops resume now instead of replaying
      if (!this._begin(rt, t, AUTO, true)) return;
    }
  }

  _pick(ids) {
    const ok = ids.filter(i => this.runtimes.has(i));
    return ok.length ? ok[Math.min(ok.length - 1, Math.floor(this.random() * ok.length))] : null;
  }

  _apply(rt, p, now) {
    const t = now - rt.dueAt > STALL ? now : rt.dueAt;   // when this pattern fired (chains resume now after a stall)
    const go = id => { const o = this.runtimes.get(id); if (o) this._start(o, t, EXPLICIT, now); };
    switch (p.method) {
      case 'start': if (p.ids.length) go(p.ids[0]); return;
      case 'alternativestart': { const id = this._pick(p.ids); if (id !== null) go(id); return; }
      case 'parallelstart': for (const id of p.ids) go(id); return;
      case 'stop': if (p.ids.length) this.stop(p.ids[0]); return;
      case 'alternativestop': { const id = this._pick(p.ids); if (id !== null) this.stop(id); return; }
      case 'parallelstop': for (const id of p.ids) this.stop(id); return;
      case 'insert': return;   // only meaningful inside bind groups
      case 'move':
        if (p.surface === -1) { if (rt.move) { rt.move = null; this.moved = true; } return; }
        rt.move = { x: p.x, y: p.y };
        rt.moveSeq = ++this._seq;
        this.moved = true;
        return;
      default:
        break;
    }
    if (p.surface === -1) {
      // back to the pre-animation state; the sequence continues (SH §0 item 7)
      if (rt.move) this.moved = true;
      rt.frame = null; rt.baseOverride = null; rt.move = null;
    } else if (p.surface === -2) {
      for (const other of this.runtimes.values()) if (other !== rt && other.running) this._stop(other);
      if (rt.move) this.moved = true;
      rt.frame = null; rt.baseOverride = null; rt.move = null;
    } else if (p.method === 'base') {
      rt.baseOverride = p.surface;
      rt.baseSeq = ++this._seq;
    } else {
      rt.frame = { surface: p.surface, x: p.x, y: p.y, method: p.method, alpha: p.alpha };
    }
    this.dirty = true;
  }
}

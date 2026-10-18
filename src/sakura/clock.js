// Time sources for the script player. The player only uses now(), setTimer() and clearTimer(), so tests can drive it
// with ManualClock and run instantly.

/** @typedef {{now(): number, setTimer(fn: Function, ms: number): any, clearTimer(handle: any): void}} Clock */

/** @type {Clock} */
export const realClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimer: (fn, ms) => setTimeout(fn, Math.max(0, ms || 0)),
  clearTimer: h => clearTimeout(h),
};

/** Let pending promise callbacks run (a few microtask hops). */
async function settle(hops = 12) {
  for (let i = 0; i < hops; i++) await null;
}

/**
 * Deterministic clock for tests: time moves only through advance().
 * @implements {Clock}
 */
export class ManualClock {
  constructor(t = 0) {
    this.t = t;
    this._timers = [];
    this._seq = 0;
  }

  now() { return this.t; }

  setTimer(fn, ms) {
    const h = { fn, due: this.t + Math.max(0, ms || 0), seq: ++this._seq };
    this._timers.push(h);
    return h;
  }

  clearTimer(h) {
    const i = this._timers.indexOf(h);
    if (i >= 0) this._timers.splice(i, 1);
  }

  get pending() { return this._timers.length; }

  _next(limit) {
    let best = null;
    for (const h of this._timers) {
      if (h.due <= limit && (!best || h.due < best.due || (h.due === best.due && h.seq < best.seq))) best = h;
    }
    return best;
  }

  /**
   * Move time forward by ms, firing due timers in order (time jumps to each timer's due time first) and letting
   * promise callbacks settle between them.
   */
  async advance(ms = 0) {
    const target = this.t + Math.max(0, ms);
    for (;;) {
      await settle();
      const h = this._next(target);
      if (!h) break;
      this.clearTimer(h);
      if (h.due > this.t) this.t = h.due;
      h.fn();
    }
    this.t = target;
    await settle();
  }

  /** Run until no timer is left (or maxMs of virtual time passed). */
  async runAll(maxMs = 1e9) {
    const end = this.t + maxMs;
    for (;;) {
      await settle();
      const h = this._next(end);
      if (!h) break;
      this.clearTimer(h);
      if (h.due > this.t) this.t = h.due;
      h.fn();
    }
    await settle();
  }
}

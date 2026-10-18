// The ghost sweep's clock (tools/sweep/ghost.mjs, docs/research/ghost-sweep.md "The clock"): what time the ghosts see.
// A sweep tool only: nothing here runs on the site, where ghosts keep the real date and time.
//
// --clock fixed (the default): one local date and time for the whole run, page side and engines alike, from the
//   engine's boot on, advanced only by the sweep's clock (SweepClock), so two runs compare without time-of-day noise;
// --clock YYYY-MM-DDTHH:MM[:SS]: the same from another local start (an hour's time signal: 19:55);
// --clock real: the earlier sweep's clocks: the page side on the fixed date, Satori on the real clock, YAYA and Kawari
//   from the real time of the shell stage on, advanced with the page side's clock (ghost.mjs followClock).

/** The page side's start: Wednesday 2026-10-07 20:00:00, local time. */
export const DEFAULT_START = '2026-10-07T20:00:00';

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** `YYYY-MM-DD[THH:MM[:SS]]` as local epoch ms; null when it is no such date (2026-02-30, 24:00). */
export function localMs(spec) {
  const m = LOCAL.exec(String(spec).trim());
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1).map(x => (x === undefined ? undefined : Number(x)));
  const t = new Date(y, mo - 1, d, h, mi, s);
  const same = t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d && t.getHours() === h
    && t.getMinutes() === mi && t.getSeconds() === s;
  return same ? t.getTime() : null;
}

/** Epoch ms as `YYYY-MM-DDTHH:MM:SS`, local time. */
export function localText(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * --clock as {fixed, start, label}: `start` = the epoch ms the sweep's clock (SweepClock) starts at, in every mode;
 * `fixed` = the whole process follows that clock (fixProcessClock). Throws on any other value.
 */
export function parseClock(value) {
  const v = value == null || value === '' ? 'fixed' : String(value).trim();
  if (v.toLowerCase() === 'real') return { fixed: false, start: localMs(DEFAULT_START), label: 'real' };
  const start = localMs(v.toLowerCase() === 'fixed' ? DEFAULT_START : v);
  if (start === null) throw new Error(`--clock: fixed, real or a local date and time YYYY-MM-DDTHH:MM[:SS], not "${v}"`);
  return { fixed: true, start, label: `fixed ${localText(start)}` };
}

/**
 * Every clock of this process follows `clock` ({now(): epoch ms}, the sweep's SweepClock) from here on: `Date.now()`,
 * `new Date()` and `Date()` read clock.now() in whole ms, `performance.now()` reads `perfBase` + how far the clock moved
 * since. The engines read the time only through these (Emscripten: time(), gettimeofday and CLOCK_REALTIME through
 * Date.now, CLOCK_MONOTONIC through performance.now, localtime through new Date(ms); MEMFS stamps with Date.now), so
 * they load at the fixed time, stand still between the clock's steps, and a seed they take from the clock (Satori's
 * and YAYA's MT19937, Kawari's SRandom(time)) repeats from run to run. Date's statics (UTC, parse) and `instanceof`
 * stay. The caller keeps the real clock for its own timings: bind Date.now / performance.now before this. Returns a
 * function that puts the real clocks back (tests).
 */
export function fixProcessClock(clock, { perfBase = 1000 } = {}) {
  const RealDate = globalThis.Date;
  const ownPerf = Object.prototype.hasOwnProperty.call(performance, 'now');
  const realPerf = performance.now;
  const t0 = clock.now();
  const now = () => Math.floor(clock.now());
  function FixedDate(...a) {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, a.length ? a : [now()], new.target);
  }
  Object.setPrototypeOf(FixedDate, RealDate);
  FixedDate.prototype = RealDate.prototype;
  FixedDate.now = now;
  globalThis.Date = FixedDate;
  performance.now = () => perfBase + (clock.now() - t0);
  return () => {
    globalThis.Date = RealDate;
    if (ownPerf) performance.now = realPerf;
    else delete performance.now;
  };
}

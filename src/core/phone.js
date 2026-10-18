// Phones (UI §9.11, Sumika's own: SSP has no phone, so every rule here is a [decision]): the one predicate, read once
// per page by main.js before the Site is built (never again: no rotation, resize, browser bar or keyboard flips it
// mid-page), and the script tag's phone options. A phone is a coarse primary pointer on a screen whose short side is
// under 600 CSS px; a mouse or a touchpad (every desktop window, at any size, devicePixelRatio or zoom) never is. The
// result is a plain object the components take as their `phone` option ({short, long, mobileView}); without it every
// one of them is its desktop self. main.js and core/support.js (whose unsupported-browser stub extends offApi) import
// it; the components never do.
import { log } from './log.js';

/** CSS px: a screen whose short side is this or more is no phone (Android's tablet line, sw600dp) [decision]. */
export const PHONE_SHORT_MAX = 600;

const NO = new Set(['false', '0', 'no', 'off']);

/**
 * The dev aid next to ?sumika-debug: `?sumika-phone` forces the phone path (true), `?sumika-phone=0` (or false, no,
 * off) forces it off (false); null when the page URL does not ask.
 * @param {string} [search] location.search
 * @returns {boolean|null}
 */
export function phoneOverride(search) {
  try {
    const q = new URLSearchParams(String(search || ''));
    if (!q.has('sumika-phone')) return null;
    return !NO.has(String(q.get('sumika-phone')).trim().toLowerCase());
  } catch (e) {
    return null;
  }
}

/**
 * The phone this page runs on, or null (UI §9.11 Detection): `(pointer: coarse)` matches and the screen's short side
 * is under PHONE_SHORT_MAX. short / long: the screen's sides in CSS px, whatever the orientation (iOS reports portrait
 * always, Android swaps them). mobileView: the page lays out at the screen's width in the orientation it was loaded in
 * (a width=device-width viewport meta; a page without one lays out at about 980 px and the browser already shrinks it,
 * so the fits leave it alone); 2 px of slack for a scrollbar. On a desktop the pointer test fails first, so nothing
 * else is read. Forced by ?sumika-phone, the window stands for the screen (a desktop monitor's screen would give no
 * fit) and counts as a mobile view. Anything missing or throwing: null.
 * @param {Window} win
 * @returns {{short: number, long: number, mobileView: boolean}|null}
 */
export function phoneInfo(win) {
  try {
    if (!win) return null;
    const forced = phoneOverride(win.location && win.location.search);
    if (forced === false) return null;
    let w, h;
    if (forced) {
      w = Number(win.innerWidth);
      h = Number(win.innerHeight);
    } else {
      if (typeof win.matchMedia !== 'function') return null;
      const mq = win.matchMedia('(pointer: coarse)');
      if (!mq || mq.matches !== true) return null;
      const s = win.screen;
      w = Number(s && s.width);
      h = Number(s && s.height);
    }
    if (!(w > 0) || !(h > 0)) return null;
    const short = Math.min(w, h);
    const long = Math.max(w, h);
    if (!forced && !(short < PHONE_SHORT_MAX)) return null;
    const de = win.document && win.document.documentElement;
    const cw = Number(de && de.clientWidth) || Number(win.innerWidth) || 0;
    const ch = Number(de && de.clientHeight) || Number(win.innerHeight) || 0;
    const across = forced ? Number(win.innerWidth) : cw > ch ? long : short;
    return { short, long, mobileView: cw > 0 && cw <= across + 2 };
  } catch (e) {
    return null;
  }
}

/**
 * What the script tag asks for on a phone (UI §9.11 The script tag): 'on' (items 1–3), 'tucked' (data-phone="tucked":
 * she starts as her corner button) or 'off' (data-phone="off": Sumika does nothing: a switch for sites that do not want Sumika on phones).
 * Values in any case, trimmed; any other value counts as absent, with one warn. main.js reads it only on a phone: a
 * desktop page never warns about it.
 * @param {{phone?: string}} dataset the script tag's
 * @param {(msg: string) => void} [warn]
 * @returns {'on'|'tucked'|'off'}
 */
export function phoneMode(dataset, warn = m => log.warn(m)) {
  const d = dataset || {};
  if (d.phone === undefined || d.phone === null) return 'on';
  const v = String(d.phone).trim().toLowerCase();
  if (v === 'tucked' || v === 'off') return v;
  if (v !== 'on' && v !== '') warn(`data-phone="${d.phone}" is not tucked, on or off; ignored`);
  return 'on';
}

/**
 * window.sumika when Sumika does nothing on this page: nothing of the Site is made, and page code calling the page API
 * never throws. site and runtime are null, the one exception to "window.sumika.runtime is never null" (CONTRACTS
 * "Site"); state 'off', and reason says why: 'phone' (data-phone="off" on a phone, UI §9.11 Off: the default, with
 * phone 'off'), 'unsupported' (support.js unsupportedApi), 'visitor' (the visitor's Off, core/choice.js) or 'site'
 * (data-default-state="off" and no choice). phone: main.js's mode (null: no phone).
 * @param {string} version
 * @param {{phone?: null|'on'|'tucked'|'off', reason?: 'phone'|'unsupported'|'visitor'|'site'}} [o]
 */
export function offApi(version, { phone = 'off', reason = 'phone' } = {}) {
  return Object.freeze({
    version, phone, state: 'off', reason, site: null, runtime: null,
    start: () => Promise.resolve('none'),
    ghosts: () => [], running: () => [], shells: () => [], balloons: () => ({ top: [], all: [] }),
    callGhost: () => Promise.resolve(false), closeGhost: () => Promise.resolve(false), quit: () => Promise.resolve(false),
    changeGhost: () => Promise.resolve(false), changeShell: () => Promise.resolve(false),
    changeBalloon: () => Promise.resolve(false),
  });
}

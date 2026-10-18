// The user's shell and balloon scaling: SSP's right-click Shell scaling ▸ and Balloon scaling ▸ (UI §2.1 #8/#9, §9.9).
// SSP's percentages are screen (device) pixels: 100 % = one image pixel per device pixel. The browser already scales
// CSS px by devicePixelRatio, so p % is a CSS scale of (p/100)/dpr. No choice (null) follows the display: CSS scale 1,
// which is round(dpr × 100) % in SSP's terms (the item the menu marks "display"). An explicit percentage keeps its size
// in device pixels when the page zoom or the monitor changes; the default zooms with the page.
// The choice is per ghost, in its state (state.data.scaling {shell, balloon}), applied on boot, resume and ghost
// changes; a change from the menu sends OnShellScaling / OnBalloonScaling [U-ev: R0 new x %, R1 old x %, R2 new y %,
// R3 old y %].
// Phones only (UI §9.11, Sumika's own) [decision]: no choice is the phone default instead of the display, the fit the
// Stage and the Balloons computed for the shell and balloon in use (their fitScale, a CSS factor), and the menu's
// Default reads "fit to screen". The fit is never stored, and a shell or balloon change can change it (and so the
// percentage in effect) without OnShellScaling / OnBalloonScaling, as a devicePixelRatio change already does above.
import { log } from './log.js';
import { t } from './i18n.js';

/** SSP 2.9's list, top to bottom [observed] */
export const SCALE_STEPS = Object.freeze([300, 275, 250, 225, 200, 175, 166, 150, 133, 125, 100, 80, 75, 66, 50, 33, 25, 20]);
/** what Other percentage… accepts [guess: SSP's own limits are unknown] */
export const SCALE_MIN = 10;
export const SCALE_MAX = 500;
export const SCALE_TARGETS = Object.freeze(['shell', 'balloon']);
export const SCALE_EVENTS = Object.freeze({ shell: 'OnShellScaling', balloon: 'OnBalloonScaling' });
/** input box id of Other percentage… (never a ghost's own) */
export const OTHER_BOX_ID = '__sumika_scaling__';

/** window.devicePixelRatio (1 outside a browser) */
export function currentDpr() {
  return typeof devicePixelRatio === 'number' && devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
}

/** The display's own percentage: what following the display (no choice) is in SSP's terms. */
export function displayPercent(dpr = currentDpr()) {
  return Math.round((dpr > 0 && Number.isFinite(dpr) ? dpr : 1) * 100);
}

/** A number as stored or typed ('150', '150%', '１５０', 150), rounded to a whole number, any size; null when it is none. */
export function parsePercent(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  let n;
  if (typeof v === 'number') n = v;
  else {
    const s = String(v).replace(/[０-９．％]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
    const m = /^(\d+(?:\.\d*)?|\.\d+)\s*%?$/.exec(s);
    n = m ? parseFloat(m[1]) : NaN;
  }
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** parsePercent within SCALE_MIN..SCALE_MAX: null outside it. */
export function normPercent(v) {
  const r = parsePercent(v);
  return r !== null && r >= SCALE_MIN && r <= SCALE_MAX ? r : null;
}

/** CSS px per image px for a choice (null = follow the display: 1). */
export function cssScale(percent, dpr = currentDpr()) {
  const p = normPercent(percent);
  return p === null ? 1 : p / 100 / (dpr > 0 && Number.isFinite(dpr) ? dpr : 1);
}

/** The percentage in effect, in SSP's terms (the menu's bullet, the scaling events' references). */
export function effectivePercent(percent, dpr = currentDpr()) {
  const p = normPercent(percent);
  return p === null ? displayPercent(dpr) : p;
}

/** state.data.scaling cleaned: {shell, balloon}, each a percentage or null (follow the display). */
export function normScaling(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { shell: normPercent(o.shell), balloon: normPercent(o.balloon) };
}

/** CSS scales of a ghost's stored choice: {shell, balloon} (Stage / Balloons `scale`). */
export function cssScales(scaling, dpr = currentDpr()) {
  const s = normScaling(scaling);
  return { shell: cssScale(s.shell, dpr), balloon: cssScale(s.balloon, dpr) };
}

/**
 * The running ghost's scaling: what the menu shows (info), what it picks (set, askOther), applied to the stage and
 * the balloons, again whenever devicePixelRatio changes (page zoom, another monitor).
 */
export class UserScaling {
  /**
   * @param {object} o
   * @param {{data: object, change?: Function}} o.state   the ghost's StateStore (data.scaling)
   * @param {object} [o.stage]     Stage (setScale)
   * @param {object} [o.balloons]  Balloons (setScale)
   * @param {object} [o.dialogs]   Dialogs (inputBox) for Other percentage…
   * @param {object} [o.host]      EventLoop (send) for OnShellScaling / OnBalloonScaling
   * @param {() => number} [o.dpr]
   * @param {object} [o.language]  core/language.js UiLanguage: the language Other percentage…'s box asks in (none:
   *   English)
   * @param {object} [o.phone]     given on phones only (core/phone.js, UI §9.11): no choice is the stage's and the
   *   balloons' fitScale; none: the display's
   */
  constructor({ state, stage = null, balloons = null, dialogs = null, host = null, dpr = currentDpr, language = null, phone = null } = {}) {
    this.state = state;
    this.stage = stage;
    this.balloons = balloons;
    this.dialogs = dialogs;
    this.host = host;
    this.dpr = dpr;
    this.language = language;
    this.phone = phone || null;
    this.dead = false;
    this._off = null;
  }

  /** the phone default of 'shell' | 'balloon' as a CSS factor (Stage / Balloons fitScale), or null: none, or no phone */
  _fit(target) {
    if (!this.phone) return null;
    const t = target === 'shell' ? this.stage : this.balloons;
    const f = t ? Number(t.fitScale) : NaN;
    return f > 0 && Number.isFinite(f) ? f : null;
  }

  /** SSP's percentage in effect for a choice `p` (effectivePercent, or on a phone with no choice the fit's) */
  _effective(target, p, dpr = this.dpr()) {
    const n = normPercent(p);
    if (n !== null) return n;
    const f = this._fit(target);
    return f !== null ? Math.round(f * dpr * 100) : displayPercent(dpr);
  }

  /** the stored choice, cleaned (writes the cleaned object back) */
  _data() {
    const d = this.state && this.state.data;
    if (!d) return { shell: null, balloon: null };
    d.scaling = normScaling(d.scaling);
    return d.scaling;
  }

  /** percentage chosen for 'shell' | 'balloon', or null (follow the display) */
  get(target) { return this._data()[target] ?? null; }

  /**
   * What the menu needs: {shell, balloon, dpr}; on phones also `fit` {shell, balloon}: the fit's percentage (the
   * menu's bullet with no choice, and its Default reads "fit to screen": scaleItems), null where there is none.
   */
  info() {
    const d = this._data();
    const dpr = this.dpr();
    const out = { shell: d.shell, balloon: d.balloon, dpr };
    if (this.phone) {
      const pct = target => (this._fit(target) !== null ? this._effective(target, null, dpr) : null);
      out.fit = { shell: pct('shell'), balloon: pct('balloon') };
    }
    return out;
  }

  /** CSS scales now in effect: {shell, balloon}; on phones a target with no choice takes its fit. */
  scales() {
    const d = this._data();
    const s = cssScales(d, this.dpr());
    if (this.phone) {
      for (const target of SCALE_TARGETS) {
        const f = d[target] === null ? this._fit(target) : null;
        if (f !== null) s[target] = f;
      }
    }
    return s;
  }

  /**
   * Phones: the shell or balloon in use was replaced and computed its own fit (a balloon change, the balloon a shell
   * swap brings): apply it again. A choice still wins; nothing is sent. Elsewhere nothing.
   */
  refit() { if (this.phone) this.apply(); }

  /** Give the stage and the balloons their scales. */
  apply() {
    if (this.dead) return;
    const s = this.scales();
    try { if (this.stage && typeof this.stage.setScale === 'function') this.stage.setScale(s.shell); } catch (e) { log.error('shell scaling failed', e); }
    try { if (this.balloons && typeof this.balloons.setScale === 'function') this.balloons.setScale(s.balloon); } catch (e) { log.error('balloon scaling failed', e); }
  }

  /**
   * Menu pick: a percentage, or null for the default (follow the display; on phones the fit). Stored in the ghost's
   * state, applied, and when the size in effect changed, OnShellScaling / OnBalloonScaling [new, old, new, old] (one
   * percentage for both axes; on phones the fit's for no choice). Returns false for an unknown target or a percentage
   * outside SCALE_MIN..SCALE_MAX.
   */
  set(target, percent) {
    if (this.dead || !SCALE_EVENTS[target]) return false;
    const p = percent === null || percent === undefined ? null : normPercent(percent);
    if (p === null && percent !== null && percent !== undefined) {
      log.info(`${target} scaling: "${percent}" is not a percentage from ${SCALE_MIN} to ${SCALE_MAX}`);
      return false;
    }
    const d = this._data();
    const dpr = this.dpr();
    const before = this._effective(target, d[target], dpr);
    if (d[target] === p) return true;
    d[target] = p;
    if (this.state && typeof this.state.change === 'function') this.state.change();
    this.apply();
    const after = this._effective(target, p, dpr);
    if (after !== before && this.host && typeof this.host.send === 'function') {
      Promise.resolve()
        .then(() => this.host.send(SCALE_EVENTS[target], [after, before, after, before]))
        .catch(e => log.once(`scaling-event:${target}`, `${SCALE_EVENTS[target]} failed`, e));
    }
    return true;
  }

  /**
   * Other percentage…: the input box (balloonc3) with the percentage in effect. A number is rounded, kept within
   * SCALE_MIN..SCALE_MAX (600 → 500) and applied; text that is no number brings the box back with it, pulsing, its
   * placeholder showing the range, until a number or a cancel (never a silent no-op). Resolves true when a percentage
   * was set.
   */
  async askOther(target, scope = 0) {
    if (this.dead || !SCALE_EVENTS[target] || !this.dialogs || typeof this.dialogs.inputBox !== 'function') return false;
    // the box's words in a UI language (UI §2.10); the dialogs re-word an open box when the language changes
    const range = { min: SCALE_MIN, max: SCALE_MAX };
    const texts = lang => {
      const title = t(`scale.box.${target}`, lang);             // SSP's dialog title (DIALOG 140)
      return { title, hint: t('scale.hint', lang, { name: title, ...range }), placeholder: t('scale.range', lang, range) };
    };
    let text = String(this._effective(target, this.get(target)));
    for (let again = false; ; again = true) {
      const now = texts(this.language ? this.language.lang : 'en');
      let r;
      try {
        r = await this.dialogs.inputBox({
          id: OTHER_BOX_ID, scope, kind: 'text', defaultText: text, inputMode: 'decimal', limit: 8, ...now, texts, pulse: again,
        });
      } catch (e) {
        return false;
      }
      const typed = r && typeof r === 'object' ? r.text : r;
      if (typed === null || typed === undefined || this.dead) return false;
      const n = parsePercent(typed);
      if (n !== null) return this.set(target, Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)));
      log.info(`${target} scaling: "${typed}" is not a number; asking again`);
      text = String(typed);
    }
  }

  /**
   * Re-apply when devicePixelRatio changes: page zoom (resize) or another monitor (resolution media query). The CSS
   * scale of a default (null) choice stays 1, so the stage and the balloons are also told to redraw at the new
   * resolution (refreshResolution: balloon backing stores, the characters' image-rendering).
   */
  bindWindow(win = typeof window !== 'undefined' ? window : null) {
    if (this._off || !win || typeof win.addEventListener !== 'function') return;
    let last = this.dpr();
    let mq = null;
    const check = () => {
      const d = this.dpr();
      if (d === last) return;
      last = d;
      this.apply();
      for (const [what, t] of [['shell', this.stage], ['balloon', this.balloons]]) {
        try { if (t && typeof t.refreshResolution === 'function') t.refreshResolution(); } catch (e) { log.error(`${what} redraw failed`, e); }
      }
    };
    const onMq = () => { check(); arm(); };
    const arm = () => {
      if (mq) mq.removeEventListener('change', onMq);
      mq = null;
      try {
        if (typeof win.matchMedia === 'function') {
          mq = win.matchMedia(`(resolution: ${this.dpr()}dppx)`);
          if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', onMq);
          else mq = null;
        }
      } catch (e) { mq = null; }
    };
    win.addEventListener('resize', check);
    arm();
    this._off = () => {
      win.removeEventListener('resize', check);
      if (mq) mq.removeEventListener('change', onMq);
      mq = null;
    };
  }

  destroy() {
    this.dead = true;
    if (this._off) this._off();
    this._off = null;
    if (this.dialogs && typeof this.dialogs.close === 'function') {
      try { this.dialogs.close(OTHER_BOX_ID); } catch (e) { /* ignore */ }
    }
  }
}

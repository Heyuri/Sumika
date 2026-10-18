// Tooltips (UI §4.8): SSP's balloon and shell tips are Win32 tooltip windows that ask for their text once the pointer
// has rested [disasm CMessageWnd / CCharWndCode::ToolTipDispInfo]. One box per page, at root level of the runtime's
// shadow root: position:fixed, TIP_Z (above every ghost layer and the launcher dock, below the menus), pointer-events
// none (SSP's TTF_TRANSPARENT: it never takes the pointer, so it cannot cause a leave under it). Whoever shows it owns
// it (a BalloonView or a CharacterView); hide(owner) hides only that owner's tip, so with several ghosts the tip is
// the one of the ghost under the pointer. The views decide when (rest timers, caches, staleness); this module draws,
// places and auto-pops, and holds SSP's pure rules: the text (tipText), the balloon tip's colours (dominantGrid,
// gridColor, tipColors) and the place (placeTip). Without a DOM (Node tests) the box keeps its state and timers alike.
import { addStyle, getRoot, Z_BASE } from './root.js';
import { currentDpr } from '../core/scaling.js';

export const TIP_Z = Z_BASE + 199;     // layers ≤ Z_BASE + 189, the dock + 190, menus and the info window + 200
export const TIP_DELAY_MS = 500;       // initial delay: the double-click time, 500 ms by default [win32]
export const TIP_AUTOPOP_MS = 20000;   // TTM_SETDELAYTIME(TTDT_AUTOPOP, 20000) [disasm CMessageWnd::OnCreate]
// TTM_SETMAXTIPWIDTH 500 [disasm CToolTipCustom::Create 0x4b4009, a constant]: longer lines wrap. In device px:
// ssp.exe is DPI-aware (UI §9.9), its tooltip font grows with the display, this limit does not (tipMaxWidth)
export const TIP_MAX_WIDTH = 500;
export const TIP_BELOW = 20;           // top edge this far below the pointer, under the cursor image [win32; infer]
const EDGE = 2;                        // kept this far inside the viewport [infer: comctl32's work-area rule]
export const TIP_ID = 'smk-tip';       // the box's id: the owner's aria-describedby while it shows

const realClock = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: h => clearTimeout(h),
};

/**
 * The text SSP shows for a tip (UI §4.8): every two-character `\n` becomes a line break (JWString::Replace, a plain
 * substring replace, so `\\n` gives `\` + break) [disasm 0x47227E]; nothing else (other tags stay literal, no
 * trimming). A SHIORI reply's `\&[name]` entities were decoded before, by the loop's GetStringShiori read
 * (events.js resourceOf, EV §5.5); a shell's own `<scope>.tooltips` text never is [disasm SPSerikoToolTipsEntry::Set].
 * @param {string} raw
 */
export function tipText(raw) {
  return (raw == null ? '' : String(raw)).split('\\n').join('\n');
}

/**
 * Where the box goes (viewport px): its top-left at the pointer's x and TIP_BELOW under it; above the pointer when it
 * would leave the bottom, moved left at the right edge, never past the top-left [win32; infer: non-tracking tool].
 * @param {{x:number, y:number}} at   pointer, client px
 * @param {{w:number, h:number}} size the box
 * @param {{width:number, height:number}} vp
 */
export function placeTip(at, size, vp) {
  const w = Math.max(0, +size.w || 0), h = Math.max(0, +size.h || 0);
  const x = Math.round(+at.x || 0), y = Math.round(+at.y || 0);
  let top = y + TIP_BELOW;
  if (top + h > vp.height - EDGE) top = y - EDGE - h;
  const left = Math.min(x, vp.width - EDGE - w);
  return { left: Math.max(EDGE, left), top: Math.max(EDGE, top) };
}

/**
 * The box's wrap width in CSS px: TIP_MAX_WIDTH device px, with devicePixelRatio as the display's scale (as
 * core/scaling.js reads it): 400 on a 125 % display, where the 12 px font is SSP's 15 device px. Page zoom also
 * divides it [decision: the browser cannot tell zoom from the display].
 */
export function tipMaxWidth(dpr = currentDpr()) {
  return TIP_MAX_WIDTH / (dpr > 0 && Number.isFinite(dpr) ? dpr : 1);
}

/** SPColor::Luminance [disasm 0x5e9ba0]: (299 R + 587 G + 114 B) / 1000, truncated. */
export function luminance(c) {
  return Math.trunc((299 * c[0] + 587 * c[1] + 114 * c[2]) / 1000);
}

/**
 * SPColor::FitLuminance(target, black) [disasm 0x5e9c70]: c moved toward white (target at or above its luminance) or
 * black by t = (target − L) × 256 / (L(ref) − L), at most 256, per channel c + trunc((ref − c) × t / 256).
 */
export function fitLuminance(c, target) {
  const l = luminance(c);
  const ref = target >= l ? [255, 255, 255] : [0, 0, 0];
  const d = luminance(ref) - l;
  if (!d) return c.slice();
  const t = Math.min(256, Math.trunc(((target - l) * 256) / d));
  if (t <= 0) return c.slice();
  return c.map((v, i) => v + Math.trunc(((ref[i] - v) * t) / 256));
}

/**
 * CToolTipCustom::SetColors [disasm 0x4b4110]: a text colour within 90 of the background's luminance is refitted to
 * L(bg) − 130 (min 0) on a light background (L ≥ 128), else L(bg) + 130 (max 255).
 * @returns {{bg: number[], fg: number[]}}
 */
export function tipColors(bg, fg) {
  const lb = luminance(bg);
  if (Math.abs(luminance(fg) - lb) >= 90) return { bg, fg };
  return { bg, fg: fitLuminance(fg, lb >= 128 ? Math.max(0, lb - 130) : Math.min(255, lb + 130)) };
}

let BINS = null;
/** the 4096 colour bins (count and channel sums), cleared; shared by every call */
function bins() {
  if (!BINS) BINS = { n: new Uint32Array(4096), sr: new Float64Array(4096), sg: new Float64Array(4096), sb: new Float64Array(4096) };
  else for (const a of Object.values(BINS)) a.fill(0);
  return BINS;
}

/**
 * SPSurface::GetDominantColor32 [disasm 0x754400]: over [x0, x1) × [y0, y1) of RGBA pixels, those with alpha ≥ 128
 * binned by the top 4 bits of R, G and B; the average colour of the fullest bin (the lowest bin on a tie). Black
 * when no pixel counts.
 */
export function dominantColor(data, w, x0, y0, x1, y1) {
  const { n, sr, sg, sb } = bins();
  for (let y = y0; y < y1; y++) {
    for (let x = x0, i = (y * w + x0) * 4; x < x1; x++, i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      n[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
    }
  }
  let best = -1, max = 0;
  for (let k = 0; k < 4096; k++) if (n[k] > max) { max = n[k]; best = k; }
  return best < 0 ? [0, 0, 0] : [Math.trunc(sr[best] / max), Math.trunc(sg[best] / max), Math.trunc(sb[best] / max)];
}

/**
 * The balloon image's tip backgrounds, SPBalloonDesc::LoadFinish [disasm 0x5c1d60]: the dominant colour of each cell
 * of a grid of 6 columns × 8 rows over the image's validrect (desc +0x4F8 [disasm LoadDescript 0x5c0fb6]; cell edges
 * left + trunc(col × w / 6), top + trunc(row × h / 8)), and of the whole image (a cell or rect without area).
 * @param {Uint8ClampedArray|Uint8Array} data RGBA, w × h
 * @param {{left:number, top:number, right:number, bottom:number}} rect resolved validrect (image px)
 */
export function dominantGrid(data, w, h, rect) {
  const l = Math.max(0, rect.left | 0), t = Math.max(0, rect.top | 0);
  const r = Math.min(w, rect.right | 0), b = Math.min(h, rect.bottom | 0);
  const cw = r - l, ch = b - t;
  const whole = dominantColor(data, w, 0, 0, w, h);
  const cells = [];
  for (let row = 0; row < 8; row++) {
    const y0 = t + Math.trunc((row * ch) / 8), y1 = t + Math.trunc(((row + 1) * ch) / 8);
    for (let col = 0; col < 6; col++) {
      const x0 = l + Math.trunc((col * cw) / 6), x1 = l + Math.trunc(((col + 1) * cw) / 6);
      cells.push(cw > 0 && ch > 0 && x1 > x0 && y1 > y0 ? dominantColor(data, w, x0, y0, x1, y1) : whole);
    }
  }
  return { rect: { left: l, top: t, right: r, bottom: b }, cells, whole };
}

/** SPBalloonDesc::LookupDominantGrid(x, y, 1, 1) [disasm 0x5c1c40]: the cell under an image point (clamped). */
export function gridColor(grid, x, y) {
  const { left, top, right, bottom } = grid.rect;
  const cw = right - left, ch = bottom - top;
  if (cw <= 0 || ch <= 0) return grid.whole;
  const col = Math.min(5, Math.max(0, Math.trunc(((Math.trunc(x) - left) * 6) / cw)));
  const row = Math.min(7, Math.max(0, Math.trunc(((Math.trunc(y) - top) * 8) / ch)));
  return grid.cells[row * 6 + col];
}

const rgb = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

// The system look (shell tips; SSP gives them no colours of its own [disasm CCWC_Initialize]): a Windows 10/11 light
// tooltip [guess: compared on Tsubasa's \p[99] panel]. The system tooltip font, 9 pt (UI §9.8) [infer].
const CSS = `
.smk-tip{position:fixed;left:0;top:0;z-index:${TIP_Z};box-sizing:content-box;margin:0;padding:1px 3px;
  max-width:min(${TIP_MAX_WIDTH}px,calc(100vw - 14px));border:1px solid #767676;background:#fff;color:#575757;
  font:12px/1.34 "Segoe UI","Yu Gothic UI","Meiryo UI",system-ui,sans-serif;font-weight:normal;font-style:normal;
  letter-spacing:normal;word-spacing:normal;text-transform:none;text-indent:0;text-align:left;direction:ltr;
  writing-mode:horizontal-tb;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:8;
  box-shadow:1px 2px 4px rgba(0,0,0,.25);pointer-events:none;user-select:none;-webkit-user-select:none;}
.smk-tip[hidden]{display:none!important}
`;

/**
 * The page's tooltip box.
 * look: 'system' (default) or {bg, fg: [r,g,b]} (a balloon tip: background, 1 px border and text, UI §4.8).
 */
export class TipBox {
  /**
   * @param {{root?: ShadowRoot|Element|null, clock?: {setTimeout:Function, clearTimeout:Function}}} [o]
   *   root: default getRoot() at the first show when a document exists; null: headless
   */
  constructor({ root, clock } = {}) {
    this._root = root;
    this.clock = clock || realClock;
    this.el = null;
    /** the view whose tip shows, else null */
    this.owner = null;
    this.text = '';
    this.look = null;
    this.at = null;          // {x, y}: the pointer it was shown at
    this.pos = null;         // {left, top}: where it went
    this._timer = null;
    this._target = null;     // the owner's element that carries aria-describedby
  }

  _container() {
    if (this._root === undefined) this._root = typeof document !== 'undefined' ? getRoot() : null;
    return this._root || null;
  }

  _build() {
    if (this.el) return this.el;
    const root = this._container();
    if (!root) return null;
    addStyle('tooltip', CSS);
    const el = document.createElement('div');
    el.className = 'smk-tip';
    el.id = TIP_ID;
    el.setAttribute('role', 'tooltip');
    el.setAttribute('lang', '');       // the ghost's text, language unknown (UI §2.10)
    el.hidden = true;
    root.appendChild(el);
    this.el = el;
    return el;
  }

  /**
   * Show `text` for `owner` at the pointer (client px); replaces any tip. Auto-pops after TIP_AUTOPOP_MS.
   * @param {object} owner
   * @param {string} text
   * @param {{x:number, y:number, look?: 'system'|{bg:number[], fg:number[]}, target?: Element|null}} o target: the
   *   owner's element, described by the box while it shows
   */
  show(owner, text, { x = 0, y = 0, look = 'system', target = null } = {}) {
    if (!owner || !text) return;
    this.hide();
    this.owner = owner;
    this.text = String(text);
    this.look = look || 'system';
    this.at = { x, y };
    const el = this._build();
    if (el) {
      el.textContent = this.text;
      const s = el.style, c = typeof look === 'object' && look && look.bg ? look : null;
      s.background = c ? rgb(c.bg) : '';
      s.color = c ? rgb(c.fg) : '';
      s.borderColor = c ? rgb(c.fg) : '';
      s.maxWidth = `min(${+tipMaxWidth().toFixed(2)}px,calc(100vw - 14px))`;   // the display may have changed
      s.left = '0px';
      s.top = '0px';
      el.hidden = false;
      const r = el.getBoundingClientRect();
      this.pos = placeTip({ x, y }, { w: r.width, h: r.height }, viewport());
      s.left = this.pos.left + 'px';
      s.top = this.pos.top + 'px';
      if (target && typeof target.setAttribute === 'function') {
        target.setAttribute('aria-describedby', TIP_ID);
        this._target = target;
      }
    } else this.pos = placeTip({ x, y }, { w: 0, h: 0 }, viewport());
    this._arm();
  }

  /** The owner's pointer moved inside its item: a shown tip stays where it is and its auto-pop restarts [win32]. */
  touch(owner) {
    if (owner && owner === this.owner) this._arm();
  }

  /** Hide the tip (only `owner`'s when one is given). */
  hide(owner) {
    if (owner !== undefined && owner !== this.owner) return;
    if (this._timer !== null) { this.clock.clearTimeout(this._timer); this._timer = null; }
    if (this.owner === null) return;
    this.owner = null;
    this.text = '';
    this.look = null;
    this.at = null;
    this.pos = null;
    if (this.el) this.el.hidden = true;
    const t = this._target;
    this._target = null;
    if (t && typeof t.removeAttribute === 'function' && t.getAttribute && t.getAttribute('aria-describedby') === TIP_ID) {
      t.removeAttribute('aria-describedby');
    }
  }

  _arm() {
    if (this._timer !== null) this.clock.clearTimeout(this._timer);
    this._timer = this.clock.setTimeout(() => { this._timer = null; this.hide(); }, TIP_AUTOPOP_MS);
  }

  destroy() {
    this.hide();
    if (this.el) this.el.remove();
    this.el = null;
  }
}

function viewport() {
  if (typeof document === 'undefined') return { width: 1280, height: 720 };
  const de = document.documentElement;
  const w = typeof window !== 'undefined' ? window.innerWidth : 0, h = typeof window !== 'undefined' ? window.innerHeight : 0;
  return { width: (de && de.clientWidth) || w || 1280, height: (de && de.clientHeight) || h || 720 };
}

let shared = null;
/** The page's one box (balloons and characters of every ghost share it). */
export function tipBox() {
  if (!shared) shared = new TipBox();
  return shared;
}

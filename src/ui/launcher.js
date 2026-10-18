// A small fixed button in the bottom-right corner, shown while the ghost is minimized (click: restore) or closed
// (click: call her again with a fresh boot) (ssp-ui.md §2.6). Its label is in the visitor's UI language (UI §2.10).
// With several ghosts each minimized one has its own button (SSP: its own tray icon) and the site's dock stacks them
// upward by `slot` (UI §2.6) [decision]. Its image is the ghost's tray icon, which the runtime picks as ssp.exe does
// (core/trayicon.js launcherIconPath) and sets with setIcon: an `<img>` (browsers decode .ico, and a BMP named .ico),
// drawn at trayIconDevicePx; none, or one that does not load: her initial letter, Sumika's stand-in for SSP's own
// icon [decision].
// Phones (UI §9.11) [decision]: a data-phone="tucked" page starts with her button ('tucked': click: bring her out),
// busy (dimmed, clicks ignored) from the tap until her boot hides it, and so does a data-default-state="tucked" page on
// any device (core/choice.js); with the `phone` option the button keeps clear of the safe-area insets (the iPhone's
// home indicator and corner on a viewport-fit=cover page). Desktop: no option.
import { getRoot, addStyle, Z_BASE } from './root.js';
import { t } from '../core/i18n.js';
import { currentDpr } from '../core/scaling.js';

/** The button's label (aria-label and tooltip): 'Call Tsubasa' / 'Show Tsubasa', 'つばさを呼ぶ' / 'つばさを表示'. */
export function launcherLabel(mode, name, lang = 'en') {
  const who = String(name || '').trim() || t('launcher.someone', lang);
  return t(mode === 'closed' ? 'launcher.call' : 'launcher.show', lang, { name: who });
}

export const LAUNCHER_BOTTOM = 16;
export const LAUNCHER_STEP = 56;          // a 48 px button and 8 px between two
/** The dock's place for slot i (0 = the corner, the one-ghost place): CSS px from the viewport's bottom. */
export function launcherBottom(slot) {
  const i = Number.isFinite(Number(slot)) ? Math.max(0, Math.floor(Number(slot))) : 0;
  return LAUNCHER_BOTTOM + LAUNCHER_STEP * i;
}

const ratio = dpr => (Number(dpr) > 0 && Number.isFinite(Number(dpr)) ? Number(dpr) : 1);

/**
 * The tray icon's drawn size in device px [decision]: SSP draws a 16-px small icon at the notification area's size
 * (LoadTrayIcon loads it at 16 × 16 [disasm 0x49e70e]); here 16 × ⌊2 × dpr⌋, at least 16: 32 device px at 100–149 %,
 * 48 at 150–199 %, 64 at 200 %, so a 16-px icon is a whole multiple, at most 32 CSS px inside the 48-px button.
 */
export function trayIconDevicePx(dpr = currentDpr()) {
  return 16 * Math.max(1, Math.floor(2 * ratio(dpr)));
}

/**
 * An icon image's box in CSS px [decision]: its natural size fitted into trayIconDevicePx(dpr) device px (aspect
 * kept, up or down), `pixelated` when that scale is a whole number of at least 2 (pixel art stays sharp); null
 * without a natural size.
 * @returns {{width: number, height: number, pixelated: boolean}|null}
 */
export function launcherIconBox(nw, nh, dpr = currentDpr()) {
  const w = Number(nw);
  const h = Number(nh);
  if (!(w > 0) || !(h > 0)) return null;
  const r = ratio(dpr);
  const side = trayIconDevicePx(r);
  const k = Math.min(side / w, side / h);
  return { width: (w * k) / r, height: (h * k) / r, pixelated: k >= 2 && Number.isInteger(k) };
}

const CSS = `
.smk-launcher { position: fixed; right: 16px; bottom: ${LAUNCHER_BOTTOM}px; z-index: ${Z_BASE + 190}; width: 48px; height: 48px;
  padding: 0; margin: 0; border: 1px solid rgba(0,0,0,.18); border-radius: 50%; background: #fff; cursor: pointer;
  box-shadow: 0 3px 12px rgba(0,0,0,.25); display: flex; align-items: center; justify-content: center;
  overflow: hidden; pointer-events: auto; font: 600 18px/1 system-ui, sans-serif; color: #444;
  -webkit-tap-highlight-color: transparent; }
.smk-launcher[hidden] { display: none; }
.smk-launcher img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; pointer-events: none; }
.smk-launcher img.smk-px { image-rendering: pixelated; }
.smk-launcher:hover { box-shadow: 0 4px 16px rgba(0,0,0,.32); }
.smk-launcher:focus-visible { outline: 3px solid #2f6fd0; outline-offset: 2px; }
.smk-launcher.smk-closed img { filter: grayscale(.6); opacity: .85; }
.smk-launcher.smk-busy { opacity: .55; cursor: progress; }
@media (prefers-reduced-motion: no-preference) {
  .smk-launcher { transition: transform 120ms ease-out, box-shadow 120ms ease-out; }
  .smk-launcher:hover { transform: translateY(-1px); }
  .smk-launcher.smk-enter { animation: smk-launcher-in 160ms ease-out; }
}
@keyframes smk-launcher-in { from { opacity: 0; transform: scale(.8); } to { opacity: 1; transform: none; } }
`;

export class Launcher {
  /**
   * @param {object} o
   * @param {string} [o.name]     ghost name for the label
   * @param {string|null} [o.iconUrl] the tray icon's URL (setIcon later); none: the initial letter
   * @param {(mode:'minimized'|'closed'|'tucked') => void} o.onActivate
   * @param {object} [o.language] core/language.js UiLanguage (the label follows its changes); none: English
   * @param {number} [o.slot]     its place in the dock (launcherBottom); 0: the corner
   * @param {boolean} [o.phone]   on a phone (core/phone.js): bottom and right add the safe-area insets (UI §9.11)
   */
  constructor({ name = '', iconUrl = null, onActivate, language = null, slot = 0, phone = false } = {}) {
    this.name = name || '';
    this.iconUrl = iconUrl || null;
    this.onActivate = onActivate || (() => {});
    this.language = language || null;
    this.phone = !!phone;
    this.mode = null;
    this.busy = false;           // setBusy: a click does nothing
    this.el = null;
    this._img = null;            // the icon's <img> while it shows (not after it failed to load)
    this._slot = 0;
    this.setSlot(slot);
    this._offLang = this.language && typeof this.language.on === 'function'
      ? this.language.on('change', () => { if (this.el && this.mode) this._label(); })
      : null;
  }

  get lang() { return this.language ? this.language.lang : 'en'; }

  /** its place in the dock: 0 the corner, i stacked i buttons above it */
  get slot() { return this._slot; }

  /** Move to dock place `i` (bottom 16 + 56 i px); kept for a button not built yet. */
  setSlot(i) {
    const n = Number(i);
    this._slot = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    if (this.el) this.el.style.bottom = this._bottom();
  }

  /** The inline `bottom`: the dock's place, plus the safe-area inset on a phone (0 without viewport-fit=cover). */
  _bottom() {
    const px = launcherBottom(this._slot);
    return this.phone ? `calc(${px}px + env(safe-area-inset-bottom, 0px))` : `${px}px`;
  }

  _initial() { return (this.name.trim()[0] || '?').toUpperCase(); }

  /**
   * The image: the tray icon's URL (UI §2.6), or null for the initial letter (SSP's own icon when no icon loads).
   * Kept for a button not built yet; a built one is painted again only when the URL changed.
   */
  setIcon(url) {
    const u = url || null;
    if (u === this.iconUrl) return;
    this.iconUrl = u;
    if (this.el) this._paint();
  }

  /** The button's content: the icon's <img> (sized once loaded, _fit), else (or when it fails) the initial. */
  _paint() {
    const b = this.el;
    if (this._img) {
      this._img.onload = null;
      this._img.onerror = null;
      this._img.remove();
      this._img = null;
    }
    b.textContent = '';
    if (!this.iconUrl) { b.textContent = this._initial(); return; }
    const img = document.createElement('img');
    img.alt = '';
    img.onload = () => { if (this._img === img) this._fit(); };
    img.onerror = () => {
      if (this._img !== img) return;
      img.remove();
      this._img = null;
      b.textContent = this._initial();
    };
    img.src = this.iconUrl;
    this._img = img;
    b.appendChild(img);
  }

  /** Size the loaded icon for the display (launcherIconBox); again at every show (the page zoom may have changed). */
  _fit() {
    const img = this._img;
    const box = img ? launcherIconBox(img.naturalWidth, img.naturalHeight) : null;
    if (!box) return;
    img.style.width = `${box.width}px`;
    img.style.height = `${box.height}px`;
    img.classList.toggle('smk-px', box.pixelated);
  }

  _label() {
    const lang = this.lang;
    const label = launcherLabel(this.mode, this.name, lang);
    this.el.setAttribute('aria-label', label);
    this.el.setAttribute('lang', lang);
    this.el.title = label;
  }

  _build() {
    addStyle('launcher', CSS);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'smk-launcher';
    b.hidden = true;
    b.style.bottom = this._bottom();
    if (this.phone) b.style.right = 'calc(16px + env(safe-area-inset-right, 0px))';
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      const mode = this.mode;
      if (!mode || this.busy) return;
      this.hide();
      this.onActivate(mode);
    });
    b.addEventListener('contextmenu', ev => ev.preventDefault());
    getRoot().appendChild(b);
    this.el = b;
    this._paint();
  }

  /** @param {'minimized'|'closed'|'tucked'} mode  (not busy any more) */
  show(mode) {
    if (typeof document === 'undefined') return;
    if (!this.el) this._build();
    if (this.busy) this.setBusy(false);
    this.mode = mode;
    this._label();
    this._fit();
    this.el.classList.toggle('smk-closed', mode === 'closed');
    if (this.el.hidden) {
      this.el.hidden = false;
      this.el.classList.remove('smk-enter');
      void this.el.offsetWidth;
      this.el.classList.add('smk-enter');
    }
  }

  hide() {
    this.mode = null;
    if (this.busy) this.setBusy(false);
    if (this.el) this.el.hidden = true;
  }

  /**
   * Busy (UI §9.11): the tucked button after its tap, while her engine loads (seconds on a phone): dimmed, aria-busy,
   * a click does nothing. show() and hide() clear it.
   */
  setBusy(on) {
    this.busy = !!on;
    if (!this.el) return;
    this.el.classList.toggle('smk-busy', this.busy);
    if (this.busy) this.el.setAttribute('aria-busy', 'true');
    else this.el.removeAttribute('aria-busy');
  }

  get visible() { return !!(this.el && !this.el.hidden); }

  destroy() {
    if (this.el) this.el.remove();
    if (this._img) { this._img.onload = null; this._img.onerror = null; }
    this.el = null;
    this._img = null;
    this.mode = null;
    if (this._offLang) this._offLang();
    this._offLang = null;
  }
}

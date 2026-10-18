// The menu's thumbnail window (UI §2.14): ssp.exe's preview of what a menu row names — a ghost of Change ghost ▸ or
// Call ghost ▸, a shell of Shell ▸, a balloon of Balloon ▸, a dress-up part, a Recommendations ▸ / Portal site ▸
// banner [disasm 2.9.10 CCharWndCode::OnCWMenuSelect 0x41b740, OnCWTimer 0x41b8b0, ProcessThumbnail 0x41c250,
// CHelperMainWnd::ShowThumbnailWindow 0x459f90, CThumbnailWnd::CreateMe 0x4b13f0]. The menu reports each change of
// its selected row (Win32's WM_MENUSELECT: a row hovered or reached by the keys, the parent row when the pointer
// leaves a submenu, nothing when the menu closes): an enabled thumbnail row starts a 350 ms timer, anything else
// (another row, a greyed one, a submenu's row, a separator, nothing) hides the window at once. When the timer fires on
// a row other than the one shown last, one of its thumbnails, picked at random, replaces the shown one (a row without
// one hides it). It sits at the bottom of the work area (the viewport), 10 px in, on the left unless the pointer is in
// the left half, at most half the work area each way. One window per page (SSP's single SSPThumbnailWindow), above
// the menus (topmost, shown last), never taking the pointer (WS_EX_TRANSPARENT). Also here: SSP's any-extension
// lookup (findLoadable) for dress-up parts and banners (bannerUrls). Without a DOM (Node tests) the state, the timer
// and the placement work alike; nothing is drawn.
import { addStyle, getRoot, Z_BASE } from './root.js';
import { currentDpr } from '../core/scaling.js';
import { log } from '../core/log.js';
import { normPath, fetchVersioned } from '../core/loader.js';
import { releaseCanvas } from '../core/canvas.js';
import { imageExt, pickLoadable } from '../core/loadable.js';

export { imageExt };

export const THUMB_DELAY_MS = 350;     // SetTimer(…, 0x15, 350) [disasm 0x41b839]
export const THUMB_MARGIN = 10;        // from the work area's edges [disasm 0x4b163e, 0x4b1664]
export const THUMB_Z = Z_BASE + 201;   // menus and the info window + 200

/**
 * An image named without its extension, or with any [disasm SPUtils::RemoveExtensionFromFileName 0x7892b0,
 * SPSurface::FindLoadableExtension 0x756b50]: the extension after the last '.' of the last segment goes; the first
 * file of `<rest>.*` in NTFS order whose extension is an image's is it (core/loadable.js). A dress-up part's
 * thumbnail (`thumbnail/surface500`) and a banner name are looked up this way.
 * @param {{list: (prefix:string, o?:{recursive?:boolean}) => string[]}} files a folder's GhostFiles
 * @param {string} path inside that folder
 * @returns {string|null} the file's real path
 */
export function findLoadable(files, path) {
  if (!files || typeof files.list !== 'function') return null;
  const p = normPath(path);
  const cut = p.lastIndexOf('/');
  return pickLoadable(files.list(cut >= 0 ? p.slice(0, cut) : '', { recursive: false }), p);
}

/**
 * A Recommendations ▸ / Portal site ▸ row's banner [disasm SPRecommendProp::GetThumbnail 0x61a970]: of an http,
 * https or file URL the part after its last '/', else the whole value, looked up (findLoadable) in the ghost's
 * `ghost/master/banner/` [disasm SPGhost::LoadGhost 0x61fbbf: the ghost's master folder]; not there, an http(s) URL is
 * loaded from the web, as ssp.exe downloads it when its network setting allows [disasm CHelperMainWnd::OnSSPSysMsg
 * 0x459859] (Sumika's ghosts may fetch, EV §4.15). Anything else shows nothing.
 * A local banner's URL is the one loadThumbnail fetches (versionedUrl: `?v=` when the manifest versions it).
 * @param {{list: Function, url: (p:string) => string, versionedUrl?: (p:string) => string}|null} files the ghost's
 *   GhostFiles
 * @param {string} banner
 * @returns {string[]} URLs (none or one)
 */
export function bannerUrls(files, banner) {
  const b = String(banner ?? '');
  if (!b.trim()) return [];
  const isUrl = /^(https?|file):\/\//i.test(b);
  const name = isUrl ? b.slice(b.lastIndexOf('/') + 1) : b;
  const local = name ? findLoadable(files, `ghost/master/banner/${name}`) : null;
  if (local) return [typeof files.versionedUrl === 'function' ? files.versionedUrl(local) : files.url(local)];
  return /^https?:\/\//i.test(b) ? [b] : [];
}

const realClock = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: h => clearTimeout(h),
};

/**
 * Where the window goes and its size, all in device px, as CThumbnailWnd::CreateMe places a menu's thumbnail (not
 * its pointer-following kind) [disasm 0x4b1491–0x4b166a]: above 96 dpi the image grows by dpi/96 (integer, toward
 * zero); one wider or taller than half the work area shrinks by the smaller of the two ratios (doubles, truncated);
 * then x = the work area's left + 10, or its right − w − 10 when the pointer is left of its middle, and y = its
 * bottom − h − 10. null for an empty image.
 * @param {{width:number, height:number}} size the image, px
 * @param {{x:number, y:number}} cursor the pointer
 * @param {{left:number, top:number, right:number, bottom:number}} work the work area of the pointer's monitor
 * @param {number} [dpi] that monitor's
 * @returns {{x:number, y:number, w:number, h:number}|null}
 */
export function placeThumbnail(size, cursor, work, dpi = 96) {
  let w = Math.trunc(Number(size && size.width) || 0);
  let h = Math.trunc(Number(size && size.height) || 0);
  if (w <= 0 || h <= 0) return null;
  if (dpi > 96) { w = Math.trunc(w * dpi / 96); h = Math.trunc(h * dpi / 96); }
  const ww = work.right - work.left;
  const maxW = Math.trunc(ww / 2), maxH = Math.trunc((work.bottom - work.top) / 2);
  if (w > maxW || h > maxH) {
    const s = Math.min(maxW / w, maxH / h);
    w = Math.trunc(w * s);
    h = Math.trunc(h * s);
  }
  const x = cursor.x < work.left + Math.trunc(ww / 2) ? work.right - w - THUMB_MARGIN : work.left + THUMB_MARGIN;
  return { x, y: work.bottom - h - THUMB_MARGIN, w, h };
}

/**
 * A thumbnail's pixels as SSP shows them [disasm SPSurface::CreateSurfaceForThumbnail 0x757630]: the image's own
 * alpha, except for a file whose name ends in `r` (`.pnr`): when it is fully opaque, the top-left pixel's colour is
 * transparent and every other pixel opaque [disasm 0x7578ef]; one with its own transparency stays as it is [infer:
 * SSP keeps a separate alpha it found]. A `.pna` beside it is not read: none of the thumbnails examined has one
 * [decision]. Changes `data` (RGBA, straight alpha) in place.
 * @param {{width:number, height:number, data:Uint8ClampedArray|Uint8Array}} img
 * @param {string} name the file's name or URL
 */
export function thumbnailAlpha(img, name) {
  if (!/r$/i.test(String(name || '').replace(/[?#].*$/, ''))) return img;
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return img;
  if (d.length < 4) return img;
  const r = d[0], g = d[1], b = d[2];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === r && d[i + 1] === g && d[i + 2] === b) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
  }
  return img;
}

/**
 * Browser loader: the file's first frame (createImageBitmap, no colour management), with thumbnailAlpha. Any format
 * the browser decodes; one it cannot (a .tga, a .psd) fails, and SSP's window then hides as it does for a file it
 * cannot read [disasm 0x4b1475].
 * A banner on another site (bannerUrls) comes as an image element, unread (another site's pixels cannot be read
 * without its consent), with no referrer and no colour key [decision].
 * A site file comes through fetchVersioned: a `?v=` URL (siteUrls with the index's versions, versionedUrl) from any
 * stored copy, once more with 'reload' when that is not ok; a plain one with the browser's default caching.
 * @param {string} url
 * @returns {Promise<{width:number, height:number, data?:Uint8ClampedArray, source?:CanvasImageSource}>}
 */
export async function loadThumbnail(url) {
  if (otherSite(url)) return loadElement(url);
  const blob = await fetchVersioned(url, { as: 'blob' });
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  let c = null;
  try {
    c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return thumbnailAlpha({ width: id.width, height: id.height, data: id.data }, url);
  } finally {
    if (bmp.close) bmp.close();
    releaseCanvas(c);     // a temporary canvas: its memory back at once (core/canvas.js; WebKit's canvas memory cap)
  }
}

/**
 * The site's origin (Site.base's: where ghosts.json and the ghosts' files are), when it is not the page's: a page on
 * another origin that loads the runtime from the site's host (CORS: CLAUDE.md "Pages on other origins") fetches the
 * site's thumbnails as site files. One per page; set by the Site.
 */
let siteOrigin = null;
export function setSiteBase(base) {
  try { siteOrigin = new URL(base).origin; } catch (e) { siteOrigin = null; }
}

/** whether `url` is on another site: an origin that is neither the page's nor the site's (setSiteBase) */
export function otherSite(url, loc = typeof location !== 'undefined' ? location : null) {
  if (!loc) return false;
  try {
    const o = new URL(url, loc.href).origin;
    return o !== loc.origin && o !== siteOrigin;
  } catch (e) {
    return false;
  }
}

/** an image element loaded from `url` (its first frame is what a canvas draws) */
function loadElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, source: img });
    img.onerror = () => reject(new Error(`${url} did not load`));
    img.src = url;
  });
}

const CSS = `
.smk-thumb { position: fixed; left: 0; top: 0; z-index: ${THUMB_Z}; pointer-events: none; display: none; margin: 0; }
`;

/** The viewport as the work area, the pointer and the dpi, in device px (placeThumbnail's terms). */
function screenNow(cursor) {
  const dpr = currentDpr();
  const de = typeof document !== 'undefined' ? document.documentElement : null;
  const vw = (de && de.clientWidth) || (typeof innerWidth === 'number' ? innerWidth : 1280);
  const vh = (de && de.clientHeight) || (typeof innerHeight === 'number' ? innerHeight : 720);
  return {
    dpr,
    dpi: Math.round(dpr * 96),
    work: { left: 0, top: 0, right: Math.round(vw * dpr), bottom: Math.round(vh * dpr) },
    cursor: { x: Math.round((cursor ? cursor.x : 0) * dpr), y: Math.round((cursor ? cursor.y : 0) * dpr) },
  };
}

export class MenuThumbnail {
  /**
   * @param {object} [o]
   * @param {{setTimeout, clearTimeout}} [o.clock]
   * @param {() => number} [o.random] SSP's genrand: which of several thumbnails
   * @param {(url: string) => Promise<{width, height, data}>} [o.load] the image's pixels (loadThumbnail)
   * @param {boolean} [o.draw] put it on the page (default: when a document exists)
   */
  constructor({ clock = realClock, random = Math.random, load = loadThumbnail, draw = typeof document !== 'undefined' } = {}) {
    this.clock = clock;
    this.random = random;
    this.load = load;
    this.draw = draw;
    this._timer = null;
    this._sel = null;          // the selected ghost row {key, urls, cursor} (SSP's +0x124), null: none
    this._done = null;         // the key last processed (+0x128)
    this._token = 0;           // a newer select or hide drops a load still running
    this._el = null;
    /** what shows: {key, url, x, y, w, h} (device px), or null */
    this.shown = null;
  }

  /**
   * The menu's selected row changed (WM_MENUSELECT). key: an enabled thumbnail row's (Menu item `thumbKey`: 'ghost:<id>',
   * 'shell:<id>', …), null for anything else; urls: its thumbnails, or a function that finds them when the timer fires
   * (SSP looks them up then [disasm ProcessThumbnail]); cursor: () => the pointer, client px, read when it shows.
   * @param {string|null} key
   * @param {string[]|(() => string[])} [urls]
   * @param {() => {x:number, y:number}} [cursor]
   */
  select(key, urls = [], cursor = null) {
    if (this._timer !== null) { this.clock.clearTimeout(this._timer); this._timer = null; }
    if (key == null) {
      if (this._sel) { this._sel = null; this._done = null; this.hide(); }
      return;
    }
    this._sel = { key: String(key), urls, cursor };
    this._timer = this.clock.setTimeout(() => {
      this._timer = null;
      if (this._sel && this._sel.key !== this._done) this._process(this._sel);
    }, THUMB_DELAY_MS);
  }

  /** The timer fired on a new row [disasm ProcessThumbnail]: a thumbnail at random, or none (hide). */
  _process(sel) {
    this._done = sel.key;
    let urls = sel.urls;
    try { if (typeof urls === 'function') urls = urls(); } catch (e) { log.once('thumb-find', 'thumbnail: the lookup failed', e); urls = []; }
    urls = Array.isArray(urls) ? urls.filter(Boolean).map(String) : [];
    if (!urls.length) { this.hide(); return; }
    const url = urls[Math.min(urls.length - 1, Math.floor(this.random() * urls.length))];
    const token = ++this._token;
    Promise.resolve().then(() => this.load(url)).then(img => {
      if (token !== this._token) return;
      const at = screenNow(typeof sel.cursor === 'function' ? sel.cursor() : null);
      const p = placeThumbnail(img, at.cursor, at.work, at.dpi);
      if (!p) { this.hide(); return; }
      this.shown = { key: sel.key, url, ...p };
      this._paint(img, p, at.dpr);
    }, e => {
      if (token !== this._token) return;
      log.once(`thumb-${url}`, `thumbnail: ${url} could not be shown`, e);
      this.hide();
    });
  }

  _paint(img, p, dpr) {
    if (!this.draw) return;
    addStyle('thumb', CSS);
    if (!this._el) {
      this._el = document.createElement('canvas');
      this._el.className = 'smk-thumb';
      this._el.setAttribute('aria-hidden', 'true');
      getRoot().appendChild(this._el);
    }
    const c = this._el;
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    if (img.source) ctx.drawImage(img.source, 0, 0);
    else ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const s = c.style;
    s.left = `${p.x / dpr}px`;
    s.top = `${p.y / dpr}px`;
    s.width = `${p.w / dpr}px`;
    s.height = `${p.h / dpr}px`;
    s.display = 'block';
  }

  /** Hide it now (a load still running is dropped). */
  hide() {
    this._token++;
    this.shown = null;
    if (this._el) this._el.style.display = 'none';
  }

  destroy() {
    this.select(null);
    this.hide();
    if (this._el) this._el.remove();
    this._el = null;
  }
}

let shared = null;

/** The page's one thumbnail window (SSP has one for every character window's menu). */
export function sharedThumbnail() {
  if (!shared) shared = new MenuThumbnail();
  return shared;
}

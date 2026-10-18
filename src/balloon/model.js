// One scope's balloon without any DOM: balloon kind and side, visibility rule, the layout engine, \_b argument
// parsing, links and pointer logic. BalloonView (view.js) adds the DOM and painting on top of it.
// Choice hover (UI §4.8, EV §4.7), as SSP's balloon window does it [disasm CMessageWnd]: a mouse or pen move updates
// the selected item (`selected`, emitted as 'select'; it stays when the pointer leaves the window or goes above or
// below the validrect, where each move emits a let-go of its own) and the tooltip's
// rest timer; at rest the item's text is asked once per entry through `tipSource` and cached until the pointer rests
// on empty space or leaves the window.
import { Emitter } from '../core/emitter.js';
import { log } from '../core/log.js';
import { LayoutEngine } from './layout.js';
import { advance, lineHeight } from './metrics.js';
import { tipBox, TIP_DELAY_MS } from '../ui/tooltip.js';

const realClock = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: h => clearTimeout(h),
};
const NO_TIP = Object.freeze({ index: -1, text: null, wait: null });

/** Parse \_b options (positional `opaque`, --option=, --clipping=, ...). SS §5.3.2, BA §3.6. */
export function parseImageOptions(list) {
  const o = { mode: 'key', fg: false, fixed: false, clip: null };
  for (const raw of list) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const low = s.toLowerCase();
    let m;
    if (low === 'opaque') o.mode = 'opaque';
    else if (low === 'use_self_alpha') o.mode = 'self';
    else if ((m = /^--option=(.*)$/.exec(low))) {
      for (const v of m[1].split(/[\s+|]+/)) {
        if (v === 'opaque') o.mode = 'opaque';
        else if (v === 'use_self_alpha') o.mode = 'self';
        else if (v === 'foreground') o.fg = true;
        else if (v === 'background') o.fg = false;
        else if (v === 'fixed') o.fixed = true;
        else if (v) log.once('balloon:bopt:' + v, 'balloon: \\_b option ignored:', v);
      }
    } else if ((m = /^--clipping=(.*)$/.exec(low))) {
      const n = m[1].trim().split(/[\s,]+/).map(x => parseInt(x, 10));
      if (n.length === 4 && n.every(Number.isFinite) && n[2] > n[0] && n[3] > n[1]) o.clip = n;
      else log.once('balloon:clip:' + s, 'balloon: bad --clipping ignored:', s);
    } else log.once('balloon:bopt:' + low.split('=')[0], 'balloon: \\_b option ignored:', s);
  }
  return o;
}

export class BalloonModel extends Emitter {
  /**
   * @param {object} o
   * @param {number} o.scope
   * @param {import('./skin.js').BalloonSkin} o.skin
   * @param {import('./images.js').ImageStore} [o.images]  for \_b (relative to ghost/master)
   * @param {number} [o.defaultKind]   descript default \b id (SUM C15)
   * @param {boolean} [o.wordWrap]
   * @param {(ch:string, font:object)=>number} [o.measure]
   * @param {{setTimeout:Function, clearTimeout:Function}} [o.clock]  the tooltip's rest timer
   * @param {import('../ui/tooltip.js').TipBox} [o.tips]  default: the page's box (tipBox())
   */
  constructor(o) {
    super();
    this.scope = o.scope;
    this.skin = o.skin;
    this.images = o.images || null;
    this.defaultKind = o.defaultKind ?? 0;
    this.side = 'left';
    this.kind = this.defaultKind;
    this.visible = false;
    this.clickWait = false;
    this.hoverLink = -1;
    this.hovered = false;
    /** SSP's selected item (+0xA84): set by mouse and pen moves, kept when the pointer leaves the window, -1 none */
    this.selected = -1;
    /** (item) => Promise<string|null|undefined>: its tip text (null: none; undefined: not asked). Set by the manager */
    this.tipSource = null;
    this.tips = o.tips || tipBox();
    this.clock = o.clock || realClock;
    this._tip = NO_TIP;      // SSP's cache: the item asked last, its text, the request on its way
    this._rest = null;       // {bx, by, x, y}: the pointer's last mouse / pen position (balloon px, client px)
    this._restTimer = null;
    this._restGen = 0;       // bumped by every move, pop and leave: a tip shows only for the rest that asked
    this.img = this.skin.balloon(this.scope, this.kind, this.side) || this.skin.balloon(this.scope, 0, this.side);
    if (!this.img) this.kind = 0;
    const img = this.img || { geo: fallbackGeo(), font: this.skin.font };
    this.engine = new LayoutEngine({
      geometry: img.geo, font: img.font, wordWrap: o.wordWrap, measure: o.measure,
      imageInfo: ref => (!ref || ref.missing ? false : this.images ? this.images.info(ref) : false),
    });
    this._offImages = this.images ? this.images.on('load', key => this._imageLoaded(key)) : null;
  }

  // ---- kind, side, visibility ---------------------------------------------------------------------------------

  /** \b[n]; -1 hides (later content shows it again with the last valid id). */
  setKind(id) {
    id = Math.trunc(+id);
    if (!Number.isFinite(id)) return;
    if (id < 0) { this.hide(); return; }
    const img = this.skin.balloon(this.scope, id, this.side);
    if (!img) {
      log.once(`balloon:kind:${this.scope}:${id}`, `balloon: no balloon image for \\b[${id}] on scope ${this.scope}, keeping \\b[${this.kind}]`);
      return;
    }
    this.kind = id - (id % 2);
    this._setImage(img);
  }

  /** Back to the descript default kind (script start, SUM C15). */
  resetKind() { this.setKind(this.defaultKind); }

  /** 'left' | 'right' of the character (chosen by placement); selects the even/odd image. */
  setSide(side) {
    if (side !== 'left' && side !== 'right') side = 'left';
    if (side === this.side) return;
    this.side = side;
    const img = this.skin.balloon(this.scope, this.kind, side);
    if (img) this._setImage(img);
  }

  _setImage(img) {
    if (img === this.img) return;
    const prev = this.img;
    this.img = img;
    this.engine.defaultFont = img.font;
    if (!prev || !sameGeo(prev.geo, img.geo)) this.engine.setGeometry(img.geo);
    this.emit('image', img);
    this._changed(true);
  }

  /**
   * Balloon change (BA §12.2): SSP re-skins the open window in place. Back to the scope's default kind (else 0) on the
   * kept side [infer: SetBalloon(new, GetDefaultBalloonIndexSetting(scope), -1)]; the content is kept and laid out
   * again on the new image [guess]: \b changes recorded for the old images are dropped (the balloon is on its default
   * kind now), \![*] markers take the new marker's size, and font settings the script never changed follow the new
   * skin's default font. A balloon the visitor scrolled up keeps the line at its top in view (BA §12.2 #5); one at
   * the bottom stays at the bottom. Emits 'image'.
   * @param {import('./skin.js').BalloonSkin} skin
   */
  setSkin(skin) {
    if (!skin) return;
    const e = this.engine, oldFont = e.defaultFont;
    const scrolled = scrollAnchor(e);
    this.skin = skin;
    let kind = this.defaultKind - (this.defaultKind % 2);
    let img = skin.balloon(this.scope, kind, this.side);
    if (!img) { kind = 0; img = skin.balloon(this.scope, 0, this.side); }
    this.kind = kind;
    this.img = img || null;
    const geo = img ? img.geo : fallbackGeo(), font = img ? img.font : skin.font;
    e.defaultFont = font;
    const s = e.snapshot();
    const marker = skin.marker(this.scope);
    const ops = s.ops.filter(op => op[0] !== 'G')
      .map(op => (op[0] === 'm' && op[1] && op[1].key === 'part:marker' ? ['m', op[1], marker ? marker.w : 8, marker ? marker.h : 8] : op));
    e.restore({ ...s, base: { ...s.base, geo, font: rebaseFont(s.base.font, oldFont, font) }, ops });
    if (scrolled) e.scrollY = scrollBack(e, scrolled);   // autoscroll untouched: new text still follows the end
    this.hoverLink = -1;
    this._tipPop();          // the same items (selection and tip cache kept), new colours
    this.emit('image', img);
    this._changed(true);
  }

  get width() { return this.img ? this.img.w : 0; }
  get height() { return this.img ? this.img.h : 0; }

  /**
   * The text area's numbers for currentghost.balloon.scope(N).* (properties.md §5.7), of the image in use (\b kind and
   * side), in balloon-image px; also before the balloon was ever shown [decision]. null: no image.
   * @returns {import('../core/properties.js').BalloonMetrics|null}
   */
  metrics() {
    return this.img ? balloonMetrics(this.img.geo, this.img.font, this.engine.measure) : null;
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.emit('visibility', true);
    this._changed(true);
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.hoverLink = -1;
    this._forget();
    this.emit('visibility', false);
  }

  // ---- content ------------------------------------------------------------------------------------------------

  clear() {
    this.engine.clear();
    this.hoverLink = -1;
    this._forget();
    this._changed(true);
  }

  write(text) { this.engine.write(text); this._content(); }
  newline(ratio = 1) { this.engine.newline(ratio); this._changed(); }
  locate(x, y) { this.engine.locate(x, y); this._changed(); }
  setFont(key, value) { this.engine.setFont(key, value); }
  resetFont() { this.engine.resetFont(); }
  setNoWrap(on) { this.engine.setNoWrap(on); }
  toggleNoWrap() { this.engine.setNoWrap(!this.engine.noWrap); }
  clearChars(n, start) { this.engine.clearChars(n, start); this._changed(true); }
  clearLines(n, start) { this.engine.clearLines(n, start); this._changed(true); }
  setAutoscroll(on) { this.engine.setAutoscroll(on); this._changed(true); }

  /**
   * \_b[path,x,y,opts...] (positioned) or \_b[path,inline,opts...]. Path relative to ghost/master; files that are
   * not in the manifest are never fetched and draw nothing.
   */
  image(path, x, y, opts = []) {
    const inline = String(x ?? '').trim().toLowerCase() === 'inline';
    const o = parseImageOptions(inline ? [y, ...opts] : opts);
    const ref = this.images ? this.images.ref(path, o.mode) : null;
    if (inline) {
      this.engine.inlineImage(ref || { key: 'missing:' + path, missing: true }, { clip: o.clip });
    } else {
      if (!ref) return;
      const px = parseInt(String(x ?? '').trim(), 10), py = parseInt(String(y ?? '').trim(), 10);
      if (!Number.isFinite(px) || !Number.isFinite(py)) log.once('balloon:bxy:' + x + ',' + y, 'balloon: bad \\_b position', x, y);
      this.engine.positionedImage(ref, px || 0, py || 0, { fg: o.fg, fixed: o.fixed, clip: o.clip });
    }
    this._content();
  }

  /** \![*]: the balloon marker image inline. */
  marker() {
    const p = this.skin.marker(this.scope);
    this.engine.marker({ key: 'part:marker' }, p ? p.w : 8, p ? p.h : 8);
    this._content();
  }

  beginLink(info) { this.engine.beginLink(normLink(info)); }
  endLink() { this.engine.endLink(); }

  /** \q[label,id,...] */
  addChoice(label, info) {
    this.engine.choice(label, normLink({ kind: 'choice', ...info, label }));
    this._content();
  }

  get hasLinks() { return this.engine.hasLinks; }
  /** A \q or \__q item (not a \_a anchor) in this balloon, shown or not (Status `choosing`, EV §1.6). */
  get hasChoices() { return this.engine.hasChoices; }

  /** \x marker on/off. */
  showClickWait(on) {
    on = !!on;
    if (on === this.clickWait) return;
    this.clickWait = on;
    this._changed(true);
  }

  scrollBy(dy) {
    if (this.engine.scrollBy(dy)) { this.hoverLink = -1; this._tipPop(); this._changed(true); }
  }

  /** Serialisable content (BA §7). */
  snapshot() {
    return { kind: this.kind, side: this.side, visible: this.visible, layout: this.engine.snapshot() };
  }

  restore(s) {
    if (!s) return;
    if (s.side) this.setSide(s.side);
    if (Number.isFinite(s.kind)) this.setKind(s.kind);
    this._forget();
    this.engine.restore(s.layout);
    if (s.visible && this.engine.hasContent) this.show();
    this._changed(true);
  }

  // ---- pointer (balloon-space coordinates) ----------------------------------------------------------------------

  /** Update the hovered link; returns true when it changed. */
  pointerMove(bx, by) {
    const l = this.engine.linkAt(bx, by);
    if (l === this.hoverLink) return false;
    this.hoverLink = l;
    this._hoverChanged();
    return true;
  }

  /** The pointer left the balloon (or a drag started): no highlight, no tip, the tip cache reset (WM_MOUSELEAVE); the
   *  selection stays and no event goes out [disasm CMessageWnd::WindowProc 0x47143F]. */
  pointerLeave() {
    this._tipLeave();
    if (this.hoverLink < 0) return;
    this.hoverLink = -1;
    this._hoverChanged();
  }

  /** A button pressed on the balloon: the tip goes (the tooltip control hides on a relayed press) [win32]. */
  pointerDown() { this._tipPop(); }

  /**
   * A mouse or pen move at a balloon point (x, y: client px): the highlight, SSP's selection (UpdateSelection
   * [disasm 0x470350]: a changed item pops the tip and emits 'select') and, with `rest`, the tip: a shown one stays and
   * its auto-pop restarts; otherwise the rest timer starts over. Touch never comes here: it has no hover [decision].
   * Above validrect.top or below validrect.bottom (engine.inBand) SSP's hit test answers "none" without storing it
   * [disasm SelectLineInternal 0x5cf7a4 / 0x5cf7c6], so there every new position lets the selected item go again
   * (the tip pops, 'select' index -1: GET OnChoiceEnter without References) and the item stays selected: coming back
   * onto it sends nothing.
   */
  hoverAt(bx, by, x, y, rest = true) {
    const last = this._rest;
    this.pointerMove(bx, by);
    if (this.engine.inBand(by)) this._select(this.hoverLink, 'move');
    else if (this.selected >= 0 && !(last && last.x === x && last.y === y)) this._letGo();
    this._rest = { bx, by, x, y };
    if (!rest) this._tipPop();
    else if (this.tips.owner === this) this.tips.touch(this);
    else this._armRest();
  }

  /**
   * An item's References for OnChoiceEnter / OnChoiceHover / balloon_tooltip (SelectEvent [disasm 0x5cf260]): label =
   * R0, the text the item shows (a \q title as given, padding kept; else its glyphs joined, untrimmed; '' for an
   * image-only item), id = R1 as parsed (Satori's id\x01label\x01N included), refs = R2… the tag's further arguments.
   * @returns {{kind:'choice'|'anchor', id:string, refs:string[], label:string}|null}
   */
  hoverInfo(index) {
    const l = this.engine.links[index];
    if (!l) return null;
    const i = l.info || {};
    return { kind: i.kind === 'anchor' ? 'anchor' : 'choice', id: String(i.id ?? ''), refs: (i.refs || []).map(String),
      label: i.label !== undefined ? String(i.label) : this.engine.linkText(index) };
  }

  /** A choice timeout lets a selected item go first ('select' with cause 'timeout': SPBalloonWnd::DoWaiting [disasm]). */
  endSelection(cause = 'timeout') {
    if (this.selected >= 0) this._select(-1, cause);
  }

  /** Emits 'select' {index, prev, cause: 'move'|'timeout', info: hoverInfo(index)|null} when the item changes. */
  _select(index, cause) {
    if (index === this.selected) return;
    const prev = this.selected;
    this.selected = index;
    this._tipPop();
    this.emit('select', { index, prev, cause, info: index >= 0 ? this.hoverInfo(index) : null });
  }

  /** A move outside the hit band: 'select' index -1 for the selected item, which stays selected (hoverAt). */
  _letGo() {
    this._tipPop();
    this.emit('select', { index: -1, prev: this.selected, cause: 'move', info: null });
  }

  /** The content went (clear, hide, restore): selection and tip cache dropped without an event [guess]. */
  _forget() {
    this.selected = -1;
    this._tipLeave();
  }

  // ---- tooltip (UI §4.8; CMessageWnd::ToolTipDispInfo [disasm 0x472060]) -----------------------------------------

  _armRest() {
    this._clearRest();
    const gen = this._restGen;
    this._restTimer = this.clock.setTimeout(() => { this._restTimer = null; if (gen === this._restGen) this._tipDue(); }, TIP_DELAY_MS);
  }

  _clearRest() {
    if (this._restTimer !== null) { this.clock.clearTimeout(this._restTimer); this._restTimer = null; }
    this._restGen++;
  }

  /** TTM_POP: the tip goes and the rest starts over with the next move. */
  _tipPop() {
    this._clearRest();
    this.tips.hide(this);
  }

  /** WM_MOUSELEAVE: also the cache (index and text) and the last position. */
  _tipLeave() {
    this._tipPop();
    this._tip = NO_TIP;
    this._rest = null;
  }

  /**
   * The pointer rested (TTN_GETDISPINFO): over empty space the cache resets; on the item asked last its text shows
   * (when its request is still on its way, as it arrives); on another item tipSource is asked once. A text shows only
   * while the pointer still rests where it asked (no move, leave, press, scroll or new content since): a late reply is
   * kept for the item and shown at the next rest, or dropped with the cache. 204 or empty: no tip.
   */
  _tipDue() {
    const r = this._rest, gen = this._restGen;
    if (!r || !this.visible) return;
    const index = this.engine.linkAt(r.bx, r.by);
    if (index < 0) { this._tip = NO_TIP; return; }
    if (index !== this._tip.index) {
      const tip = { index, text: null, wait: null };
      this._tip = tip;
      const item = this.hoverInfo(index);
      const src = this.tipSource;
      tip.wait = (async () => (typeof src === 'function' ? src(item) : undefined))().then(text => {
        if (this._tip !== tip) return;
        tip.wait = null;
        if (text === undefined) this._tip = NO_TIP;        // not asked (the ghost is not live): ask again next time
        else tip.text = text ? String(text) : null;
      }, () => { if (this._tip === tip) this._tip = NO_TIP; });
    }
    const tip = this._tip;
    const show = () => {
      if (this._tip === tip && tip.text && gen === this._restGen && this.visible) this._tipShow(tip.text, r);
    };
    if (tip.wait) tip.wait.then(show); else show();
  }

  _tipShow(text, r) {
    this.tips.show(this, text, { x: r.x, y: r.y, look: this._tipLook(r.bx, r.by), target: this._tipTarget() });
  }

  /** The tip's colours at a balloon point (the view: the balloon's, UI §4.8); null: the system look. */
  _tipLook(bx, by) { return null; }

  /** The element the tip describes while it shows (the view: its canvas). */
  _tipTarget() { return null; }

  /** Which scroll arrow (0 up, 1 down) is at a point, or -1. */
  arrowAt(bx, by) {
    const e = this.engine;
    for (const i of [0, 1]) {
      if (i === 0 ? e.scrollY <= 0 : e.scrollY >= e.maxScroll) continue;
      const p = this.skin.arrow(i, this.scope);
      const pos = this.img.geo['arrow' + i];
      const w = p ? p.w : 8, h = p ? p.h : 8;
      if (bx >= pos.x - 2 && bx < pos.x + w + 2 && by >= pos.y - 2 && by < pos.y + h + 2) return i;
    }
    return -1;
  }

  /** A click inside the balloon: choice/anchor -> 'link', arrow -> scroll, anything else -> 'click'. */
  click(bx, by, button = 0) {
    if (button === 0) {
      const l = this.engine.linkAt(bx, by);
      if (l >= 0) {
        const link = this.engine.links[l];
        const info = this.engine.linkInfo(l);
        if (info.kind === 'anchor' && !link.visited) { link.visited = true; this._changed(true); }
        this.emit('link', info);
        return;
      }
      const a = this.arrowAt(bx, by);
      if (a >= 0) { this.scrollBy(a === 0 ? -14 : 14); return; }
    }
    this.emit('click', { button });
  }

  // ---- hooks ----------------------------------------------------------------------------------------------------

  _content() {
    if (this.engine.hasContent && !this.visible) this.show();
    this._changed();
  }

  /** Content changed; full = not a pure append (the view repaints everything). Overridden by the view. */
  _changed(full) {}

  _hoverChanged() {}

  _imageLoaded(key) {
    if (this.engine.pendingKeys.has(key)) {
      this.engine.relayout();
      this._changed(true);
    } else if (this.visible) this._changed(true);
  }

  destroy() {
    this._tipLeave();
    if (this._offImages) this._offImages();
    this._offImages = null;
  }
}

/**
 * SPBalloonWnd's text-area fields [disasm VarGet 0x5CA080; CreateBackBuffer 0x5C9FEB–0x5CA00F; SetBalloon
 * 0x5CA939–0x5CAB1C: the origin clamped into the valid rect, its left raised to the origin; field meanings infer]:
 * x0 = max(origin.x, left), y0 = max(origin.y, top); validWidth = min(wordwrappoint.x, right) − x0; validWidthInitial
 * = right − x0; validHeight = bottom − top; validHeightInitial = bottom − y0; lines = (validHeight + 2) / line height
 * (and the initial one), integer; basePos = (x0, y0). SSP's line height is untraced: the layout's stands in [infer].
 * charWidth (GetCalcFontWidth; UKADOC: the mean width of A–Z) = the layout's mean advance of A–Z, which draws them at
 * MS Gothic's half width with or without a canvas: height ÷ 2 for the usual even heights [decision].
 * @param {import('./geometry.js').Geometry} geo
 * @param {import('./geometry.js').FontState} font  the image's default font
 * @param {((ch:string, font:object) => number)|null} [measure]  the layout's measure of characters outside CP932
 */
export function balloonMetrics(geo, font, measure = null) {
  const vr = geo.validRect;
  const x0 = Math.max(geo.originX, vr.left), y0 = Math.max(geo.originY, vr.top);
  const validWidth = Math.min(geo.originX + geo.lineLimit, vr.right) - x0;
  const validHeight = vr.bottom - vr.top, validHeightInitial = vr.bottom - y0;
  const lh = lineHeight(font.height);
  let sum = 0;
  for (let cp = 65; cp <= 90; cp++) sum += advance(cp, font.height, measure ? ch => measure(ch, font) : null);
  return {
    validWidth, validWidthInitial: vr.right - x0, validHeight, validHeightInitial,
    lines: Math.trunc((validHeight + 2) / lh), linesInitial: Math.trunc((validHeightInitial + 2) / lh),
    basePos: { x: x0, y: y0 }, charWidth: Math.round(sum / 26), vertical: 0,
  };
}

function normLink(info) {
  const i = info || {};
  return { kind: i.kind === 'anchor' ? 'anchor' : 'choice', id: String(i.id ?? ''), refs: Array.isArray(i.refs) ? i.refs.map(String) : [],
    ...(i.label !== undefined ? { label: String(i.label) } : {}), ...(i.script !== undefined ? { script: i.script } : {}) };
}

/** A carried font (\c keeps \f changes) moved onto a new default font: what still equals the old default follows the new. */
function rebaseFont(cur, oldDef, newDef) {
  if (!cur || cur === oldDef || !oldDef) return newDef;
  const out = { ...newDef };
  for (const k of Object.keys(cur)) {
    if (JSON.stringify(cur[k]) !== JSON.stringify(oldDef[k])) out[k] = cur[k];
  }
  return out;
}

/**
 * Where the visitor scrolled a balloon to, so a relayout can find it again (setSkin): the topmost element in view and
 * how far the view starts below its top; null at the bottom (the engine keeps that: autoscroll follows the end).
 */
function scrollAnchor(e) {
  const y = e.scrollY, max = e.maxScroll;
  if (!(y < max)) return null;
  let at = -1, top = Infinity;
  e.elements.forEach((el, i) => {
    if (el.t === 'p' || el.missing) return;
    const t = el.y + el.dy;
    if (t + el.h > y && t < top) { at = i; top = t; }
  });
  return { at, count: e.elements.length, off: at >= 0 ? y - top : 0, fromBottom: max - y };
}

/**
 * scrollY that shows scrollAnchor()'s element at the same place: the replay makes the same elements in the same order;
 * when it did not (\c[line] counts lines, which wrap differently), the same distance from the bottom.
 */
function scrollBack(e, a) {
  const max = e.maxScroll;
  const el = a.at >= 0 && e.elements.length === a.count ? e.elements[a.at] : null;
  const y = el && el.t !== 'p' ? el.y + el.dy + a.off : max - a.fromBottom;
  return Math.max(0, Math.min(max, y));
}

function sameGeo(a, b) {
  return a.originX === b.originX && a.originY === b.originY && a.lineLimit === b.lineLimit &&
    a.width === b.width && a.height === b.height && a.validRect.left === b.validRect.left &&
    a.validRect.top === b.validRect.top && a.validRect.right === b.validRect.right && a.validRect.bottom === b.validRect.bottom;
}

function fallbackGeo() {
  return { width: 340, height: 170, originX: 23, originY: 13, lineLimit: 287, validRect: { left: 0, top: 0, right: 340, bottom: 158 },
    arrow0: { x: 314, y: 8 }, arrow1: { x: 314, y: 154 }, clickwait: { x: 314, y: 154 }, windowPosition: { x: 0, y: 0, limit: true }, box: null };
}

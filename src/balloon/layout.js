// Balloon layout engine (pure, no DOM): script operations in, a display list with integer coordinates out.
// Model and golden tests: BA §3.3–§3.10. Text space = pixels from the balloon's text origin; balloon space = pixels
// of the balloon image. Every operation since the last \c is recorded so the whole content can be laid out again
// when an image size becomes known (images load asynchronously) or for a snapshot/restore.
import { advance, isBlank, isWordChar, lineHeight, KINSOKU_START, KINSOKU_END } from './metrics.js';
import { parseColor } from './color.js';
import { fontFamily } from './geometry.js';
import { blendMethod } from './rop.js';
import { log } from '../core/log.js';

/**
 * @typedef {import('./geometry.js').Geometry} Geometry
 * @typedef {import('./geometry.js').FontState} FontState
 * @typedef {{key:string, [k:string]:any}} ImageRef   opaque to the engine; `key` identifies the bitmap
 * @typedef {{w:number,h:number}|null|false} ImageInfo  size | null = still loading | false = missing
 *
 * @typedef {object} Element
 * @property {'g'|'i'|'m'|'p'} t  glyph | inline image | marker | positioned image
 * @property {number} x  text space (g/i/m) or balloon space (p)
 * @property {number} y  top of the element's line (g/i/m) or balloon space (p)
 * @property {number} w
 * @property {number} h  g: font height (the cell without the line gap)
 * @property {number} dy vertical offset inside the line (markers)
 * @property {string} [ch]
 * @property {FontState} [font]
 * @property {ImageRef} [img]
 * @property {number[]|null} [clip]  source rectangle [l, t, r, b]
 * @property {boolean} [fg]     positioned image above the text
 * @property {boolean} [fixed]  positioned image that does not scroll
 * @property {boolean} [missing]
 * @property {number} link  index into `links`, -1 = none
 * @property {number} line  logical line (for \c[line,...])
 *
 * @typedef {{info:object, font:FontState, visited:boolean}} Link
 */

const GROUPS = { cursor: 'cursor', cursornotselect: 'cursorNS', anchor: 'anchor', anchornotselect: 'anchorNS', anchorvisited: 'anchorVisited' };
const CURSOR_SHAPES = ['square', 'underline', 'square+underline', 'none'];
const isChar = e => e.t === 'g' || e.t === 'i' || e.t === 'm';

/**
 * Parse one \_l coordinate.
 * @returns {{v:number, rel:boolean}|null} null = leave the axis unchanged
 */
export function parseLocation(s, axis, fontH, geo) {
  let str = String(s ?? '').trim();
  if (!str) return null;
  let rel = false;
  if (str[0] === '@') { rel = true; str = str.slice(1).trim(); }
  const low = str.toLowerCase();
  if (low === 'centerx' || low === 'centery') {
    const v = low === 'centerx' ? Math.round(geo.width / 2) - geo.originX : Math.round(geo.height / 2) - geo.originY;
    return { v, rel };
  }
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(em|lh|%|px)?$/i.exec(str);
  if (!m) {
    log.once('balloon:loc:' + s, 'balloon: unparsable \\_l coordinate, axis unchanged:', s);
    return null;
  }
  let n = +m[1];
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'em') n *= fontH;
  else if (unit === 'lh') n *= lineHeight(fontH);
  else if (unit === '%') n = (n / 100) * fontH;
  return { v: Math.round(n), rel };
}

function parseBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false' || s === 'disable') return false;
  return null; // 'default' or invalid
}

export class LayoutEngine {
  /**
   * @param {object} o
   * @param {Geometry} o.geometry
   * @param {FontState} o.font            balloon default font (\f[default])
   * @param {(ref:ImageRef)=>ImageInfo} [o.imageInfo]
   * @param {(ch:string, font:FontState)=>number} [o.measure]  real width of characters outside CP932
   * @param {boolean} [o.wordWrap]        keep Latin words together (BA §3.5; default on as in SSP, false = break
   *                                      everything per character)
   */
  constructor(o) {
    this.defaultFont = o.font;
    this.imageInfo = o.imageInfo || (() => false);
    this.measure = o.measure || null;
    this.wordWrap = o.wordWrap !== false;
    this.autoscroll = true;
    this.version = 0;
    this._replaying = false;
    /** @type {any[][]} */
    this.ops = [];
    this.base = { geo: o.geometry, font: o.font, noWrap: false, align: 'left', valign: 'top' };
    this._reset(this.base);
  }

  _reset(c) {
    this.geo = c.geo;
    this.font = c.font;
    this.noWrap = c.noWrap;
    this.align = c.align || 'left';
    this.valign = c.valign || 'top';
    /** @type {Element[]} */
    this.elements = [];
    /** @type {Link[]} */
    this.links = [];
    this.penX = 0;
    this.penY = 0;
    this.segMaxH = 0;
    this.pendingFeed = false;
    this.openLink = -1;
    this.lineNo = 0;
    this.lineHasContent = false;
    this.lineStart = 0;
    this.lineX0 = 0;
    this.alignShift = 0;
    this.wordStart = -1;
    this.hasContent = false;
    // SSP's "current string": none until a glyph, inline image, marker, choice, \_l or \f since \c; until then a
    // relative \_l is measured from the origin, not from the pen (BA §3.3)
    this.hasString = false;
    this.contentBottom = 0;
    this.scrollY = 0;
    this.pendingKeys = new Set();
    this.version++;
  }

  _carry() {
    return { geo: this.geo, font: this.font, noWrap: this.noWrap, align: 'left', valign: this.valign };
  }

  _rec(op) {
    if (!this._replaying) this.ops.push(op);
  }

  _exec(op) {
    switch (op[0]) {
      case 'w': return this._write(op[1]);
      case 'n': return this._newline(op[1]);
      case 'l': return this._locate(op[1], op[2]);
      case 'i': return this._inline(op[1], op[2]);
      case 'p': return this._positioned(op[1], op[2], op[3], op[4]);
      case 'm': return this._marker(op[1], op[2], op[3]);
      case 'f': return this._setFont(op[1], op[2]);
      case 'F': return this._resetFont();
      case 'N': this.noWrap = op[1]; return;
      case 'b': return this._beginLink(op[1]);
      case 'e': this.openLink = -1; return;
      case 'q': return this._choice(op[1], op[2]);
      case 'cc': return this._clearChars(op[1], op[2]);
      case 'cl': return this._clearLines(op[1], op[2]);
      case 'G': return this._setGeometry(op[1]);
    }
  }

  // ---- public operations ------------------------------------------------------------------------------------

  /** \c: clear content and scroll, pen to (0,0). Font and \_n state are kept. */
  clear() {
    this.base = this._carry();
    this.ops = [];
    this._reset(this.base);
  }

  /** Text at the cursor (any number of characters). */
  write(text) { this._rec(['w', text]); this._write(text); this._scroll(); }

  /** \n (1), \n[half] (0.5), \n[percent] (p/100). */
  newline(ratio = 1) {
    const r = Number.isFinite(+ratio) ? +ratio : 1;
    this._rec(['n', r]); this._newline(r); this._scroll();
  }

  /** \_l[x,y] */
  locate(xs, ys) { this._rec(['l', xs, ys]); this._locate(xs, ys); this._scroll(); }

  /** \_b[file,inline,...]; opts.clip = [l,t,r,b] */
  inlineImage(ref, opts = {}) { this._rec(['i', ref, opts]); this._inline(ref, opts); this._scroll(); }

  /** \_b[file,x,y,...] in balloon space; opts: {fg, fixed, clip} */
  positionedImage(ref, x, y, opts = {}) { this._rec(['p', ref, x, y, opts]); this._positioned(ref, x, y, opts); this._scroll(); }

  /** \![*]: an inline marker image of the given size. */
  marker(ref, w, h) { this._rec(['m', ref, w, h]); this._marker(ref, w, h); this._scroll(); }

  /** \f[key,value] (value = the remaining arguments joined with ','). */
  setFont(key, value) { this._rec(['f', key, value]); this._setFont(key, value); }

  /** Back to the balloon default font (script start, after \x). */
  resetFont() { this._rec(['F']); this._resetFont(); }

  /** \_n */
  setNoWrap(on) { this._rec(['N', !!on]); this.noWrap = !!on; }

  /** Start a clickable range (\__q[...], \_a[...]); a new range closes the open one. */
  beginLink(info) { this._rec(['b', info]); this._beginLink(info); }

  endLink() { this._rec(['e']); this.openLink = -1; }

  /** \q[title,...]: the title is placed as one unit that does not break inside. */
  choice(label, info) { this._rec(['q', label, info]); this._choice(label, info); this._scroll(); }

  /** \c[char,n] / \c[char,n,start] */
  clearChars(n, start) { this._rec(['cc', n, start]); this._clearChars(n, start); this._rescan(); }

  /** \c[line,n] / \c[line,n,start] */
  clearLines(n, start) { this._rec(['cl', n, start]); this._clearLines(n, start); this._rescan(); }

  /** \b[n] changed the balloon image: following content uses the new metrics, placed content keeps its place. */
  setGeometry(geo) { this._rec(['G', geo]); this._setGeometry(geo); this._scroll(); }

  /** Lay the recorded operations out again (an image size became known). */
  relayout() {
    const scroll = this.scrollY;
    this._replaying = true;
    try {
      this._reset(this.base);
      for (const op of this.ops) this._exec(op);
    } finally {
      this._replaying = false;
    }
    if (this.autoscroll) this.scrollY = this.maxScroll;
    else this.scrollY = Math.min(scroll, this.maxScroll);
  }

  /** JSON-serialisable content (for persisting an open balloon). */
  snapshot() {
    return { base: this.base, ops: this.ops, autoscroll: this.autoscroll, scrollY: this.scrollY };
  }

  restore(s) {
    if (!s || !s.base || !Array.isArray(s.ops)) return;
    this.base = s.base;
    this.ops = s.ops.slice();
    this.autoscroll = s.autoscroll !== false;
    this.relayout();
    if (!this.autoscroll) this.scrollY = Math.min(s.scrollY || 0, this.maxScroll);
  }

  // ---- scrolling ----------------------------------------------------------------------------------------------

  /** Bottom of the visible text area, in text space. */
  get visibleBottom() { return this.geo.validRect.bottom - this.geo.originY; }

  get maxScroll() { return Math.max(0, this.contentBottom - this.visibleBottom); }

  setAutoscroll(on) { this.autoscroll = !!on; if (on) this.scrollY = this.maxScroll; }

  /** User scrolling (wheel, arrows). */
  scrollBy(dy) {
    const y = Math.max(0, Math.min(this.maxScroll, this.scrollY + dy));
    if (y !== this.scrollY) { this.scrollY = y; return true; }
    return false;
  }

  _scroll() {
    const max = this.maxScroll;
    if (this.autoscroll) this.scrollY = max;
    else if (this.scrollY > max) this.scrollY = max;
  }

  _rescan() {
    let b = 0;
    for (const e of this.elements) if (e.t !== 'p' && !e.missing) b = Math.max(b, e.y + e.dy + e.h);
    this.contentBottom = b;
    this.version++;
    this._scroll();
  }

  // ---- implementation -----------------------------------------------------------------------------------------

  _lineAdvance() { return Math.max(lineHeight(this.font.height), this.segMaxH); }

  _newSegment(y) {
    this.penY = y;
    this.segMaxH = 0;
    this.wordStart = -1;
  }

  /** A new visual line starts at the current pen (wrap, \n, \_l). */
  _startLine() {
    this.lineStart = this.elements.length;
    this.lineX0 = this.penX;
    this.alignShift = 0;
  }

  /** A deliberate break (\n, \_l): new logical line, alignment back to left. */
  _breakLine() {
    if (this.lineHasContent) { this.lineNo++; this.lineHasContent = false; }
    this.align = 'left';
  }

  _commitFeed() {
    this.pendingFeed = false;
    const adv = this._lineAdvance();
    this.penX = 0;
    this._newSegment(this.penY + adv);
    this._startLine();
  }

  _push(e) {
    if (this.alignShift && e.t !== 'p') e.x += this.alignShift;
    e.link = this.openLink;
    e.line = this.lineNo;
    if (e.dy === undefined) e.dy = 0;
    this.elements.push(e);
    if (e.t !== 'p') this.hasString = true;
    if (e.t !== 'p' && !e.missing) {
      this.lineHasContent = true;
      const b = e.y + e.dy + e.h;
      if (b > this.contentBottom) this.contentBottom = b;
    }
  }

  /** What an element adds to segMaxH: glyphs their line height, images and markers their pixel height. */
  _rowHeight(e) {
    if (e.t === 'g') return lineHeight(e.h);
    return e.t === 'p' || e.missing ? 0 : e.h;
  }

  _afterPlace() {
    if (this.align !== 'left') this._applyAlign();
    if (!this.noWrap && this.penX > this.geo.lineLimit) this.pendingFeed = true;
  }

  _applyAlign() {
    let target = 0;
    if (this.align !== 'left') {
      const room = this.geo.lineLimit - this.penX;
      target = Math.max(0, this.align === 'center' ? Math.floor(room / 2) : room);
    }
    const d = target - this.alignShift;
    if (!d) return;
    for (let i = this.lineStart; i < this.elements.length; i++) {
      const e = this.elements[i];
      if (e.t !== 'p') e.x += d;
    }
    this.alignShift = target;
    this.version++;
  }

  _write(text) {
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
      let cp = s.charCodeAt(i);
      if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < s.length) {
        const lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo < 0xe000) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i++; }
      }
      this._glyph(cp);
    }
  }

  _glyph(cp) {
    if ((cp < 0x20 && cp !== 0x09) || cp === 0x7f) return; // control characters (U+0001 in Satori IDs) draw nothing
    const f = this.font;
    const ch = cp === 0x09 ? ' ' : String.fromCodePoint(cp);
    const w = advance(cp === 0x09 ? 0x20 : cp, f.height, this.measure ? c => this.measure(c, f) : null);
    const word = this.wordWrap && isWordChar(cp);
    if (this.pendingFeed) {
      if (!this.noWrap && (KINSOKU_START.has(cp) || (this.wordWrap && (cp === 0x20 || cp === 0x09) && this._afterWord()))) {
        // hanging punctuation (and, with word wrap, the spaces after a word) stays on the full line
      } else if (word && this.wordStart >= 0) {
        this._wrapWord();
      } else {
        this._commitFeed();
      }
    } else if (!this.noWrap && KINSOKU_END.has(cp) && this.penX > this.lineX0 && this.penX + w > this.geo.lineLimit) {
      if (word && this.wordStart >= 0) this._wrapWord();
      else this._commitFeed();
    }
    if (!word) this.wordStart = -1;
    else if (this.wordStart < 0) this.wordStart = this.elements.length;
    this._push({ t: 'g', x: this.penX, y: this.penY, w, h: f.height, ch, font: f });
    if (!isBlank(cp)) this.hasContent = true;
    this.penX += w;
    const lh = lineHeight(f.height);
    if (lh > this.segMaxH) this.segMaxH = lh;
    this._afterPlace();
  }

  /** Is the last element a word character or a space (one that may hang)? Not after images or CJK text. */
  _afterWord() {
    const e = this.elements[this.elements.length - 1];
    return !!e && e.t === 'g' && (e.ch === ' ' || isWordChar(e.ch.codePointAt(0)));
  }

  /**
   * Word wrap (BA §3.5): the word being written crossed the wrap point and goes on, so the line breaks before the
   * word and the part already placed moves to the next line. A word that starts its line cannot move: it breaks
   * by character here. The line keeps the height of what stays on it.
   */
  _wrapWord() {
    const els = this.elements;
    const first = els[this.wordStart];
    if (!first || first.x - this.alignShift <= this.lineX0) { this._commitFeed(); return; }
    const tail = els.splice(this.wordStart);
    this.penX = first.x - this.alignShift; // the line now ends where the word began
    if (this.align !== 'left') this._applyAlign();
    let adv = lineHeight(first.t === 'g' ? first.h : this.font.height); // the font in use where the line breaks
    for (let i = this.lineStart; i < els.length; i++) adv = Math.max(adv, this._rowHeight(els[i]));
    for (const e of tail) if (e.t === 'p') els.push(e); // positioned images are in balloon space: they stay
    this.pendingFeed = false;
    this.penX = 0;
    this._newSegment(this.penY + adv);
    this._startLine();
    this.wordStart = els.length;
    for (const e of tail) {
      if (e.t === 'p') continue;
      e.x = this.penX;
      e.y = this.penY;
      els.push(e);
      this.penX += e.w;
      const h = this._rowHeight(e);
      if (h > this.segMaxH) this.segMaxH = h;
      if (!e.missing && e.y + e.dy + e.h > this.contentBottom) this.contentBottom = e.y + e.dy + e.h;
    }
    if (this.align !== 'left') this._applyAlign();
    this.version++;
  }

  _inline(ref, opts) {
    const info = this.imageInfo(ref);
    const clip = opts && opts.clip ? opts.clip : null;
    if (info === false) {
      // a missing file is a zero-size character (it still counts for \c[char,n])
      this._push({ t: 'i', x: this.penX, y: this.penY, w: 0, h: 0, img: ref, clip: null, missing: true });
      return;
    }
    if (this.pendingFeed) this._commitFeed();
    this.wordStart = -1;
    let w = 0, h = 0;
    if (clip) { w = Math.max(0, clip[2] - clip[0]); h = Math.max(0, clip[3] - clip[1]); }
    else if (info) { w = info.w; h = info.h; }
    if (info === null) this.pendingKeys.add(ref.key);
    this._push({ t: 'i', x: this.penX, y: this.penY, w, h, img: ref, clip, pending: info === null });
    this.hasContent = true;
    this.penX += w;
    if (h > this.segMaxH) this.segMaxH = h;
    this._afterPlace();
  }

  _positioned(ref, x, y, opts) {
    const info = this.imageInfo(ref);
    if (info === false) return; // missing files draw nothing (SS §5.3.2)
    const clip = opts && opts.clip ? opts.clip : null;
    let w = 0, h = 0;
    if (clip) { w = Math.max(0, clip[2] - clip[0]); h = Math.max(0, clip[3] - clip[1]); }
    else if (info) { w = info.w; h = info.h; }
    if (info === null) this.pendingKeys.add(ref.key);
    this._push({ t: 'p', x: Math.round(+x || 0), y: Math.round(+y || 0), w, h, img: ref, clip, fg: !!(opts && opts.fg),
      fixed: !!(opts && opts.fixed), pending: info === null });
    this.hasContent = true;
  }

  _marker(ref, w, h) {
    if (this.pendingFeed) this._commitFeed();
    this.wordStart = -1;
    const fh = this.font.height;
    const dy = h < fh ? Math.floor((fh - h) / 2) : 0;
    this._push({ t: 'm', x: this.penX, y: this.penY, w, h, dy, img: ref });
    this.hasContent = true;
    this.penX += w;
    if (h > this.segMaxH) this.segMaxH = h;
    this._afterPlace();
  }

  _newline(ratio) {
    // a \n before the first string still moves the pen (BA §3.3), but keeps a \f[align] given before it for that
    // string
    if (!this.hasString) {
      this.penX = 0;
      this._newSegment(this.penY + Math.round(this._lineAdvance() * ratio));
      this._startLine();
      return;
    }
    if (this.pendingFeed) {
      // a \n right after an automatic wrap point uses the pending feed up instead of adding a second one
      this.pendingFeed = false;
      this.penX = 0;
      this._newSegment(this.penY + this._lineAdvance());
      this._breakLine();
      this._startLine();
      if (ratio === 1) return;
    }
    const adv = Math.round(this._lineAdvance() * ratio);
    this.penX = 0;
    this._newSegment(this.penY + adv);
    this._breakLine();
    this._startLine();
  }

  _locate(xs, ys) {
    const x = parseLocation(xs, 'x', this.font.height, this.geo);
    const y = parseLocation(ys, 'y', this.font.height, this.geo);
    // relative to the current string, or to the origin before the first one: \c\n\_l[@-2,@0] starts at y 0
    const had = this.hasString;
    this.hasString = true;
    if (!x && !y && String(xs ?? '').trim() === '' && String(ys ?? '').trim() === '') return;
    if (this.pendingFeed) this._commitFeed();
    if (x) this.penX = x.rel ? (had ? this.penX : 0) + x.v : x.v;
    const ny = y ? (y.rel ? (had ? this.penY : 0) + y.v : y.v) : this.penY;
    this._newSegment(ny);
    this._breakLine();
    this._startLine();
  }

  _choice(label, info) {
    // The title is one unit: it starts on a new line only when a wrap is already pending, and never breaks inside
    // (a long title runs past the wrap point; BA §3.8). Breaking before titles that would overflow pushes
    // Tsubasa's translated word lists into the buttons below them.
    this._beginLink({ ...info, label });
    if (this.pendingFeed) this._commitFeed();
    const nw = this.noWrap;
    this.noWrap = true;
    this.wordStart = -1;
    this._write(label);
    this.noWrap = nw;
    this.wordStart = -1; // nothing that follows can pull the title's last word to the next line
    if (!nw && this.penX > this.geo.lineLimit) this.pendingFeed = true;
    this.hasContent = true;
    this.openLink = -1;
  }

  _beginLink(info) {
    this.hasString = true;
    this.links.push({ info: info || {}, font: this.font, visited: false });
    this.openLink = this.links.length - 1;
  }

  _clearChars(n, start) {
    const els = this.elements;
    const idx = [];
    for (let i = 0; i < els.length; i++) if (isChar(els[i])) idx.push(i);
    n = Math.max(0, Math.floor(+n || 0));
    if (!n || !idx.length) return;
    let from, to;
    if (start === undefined || start === null || start === '') { from = Math.max(0, idx.length - n); to = idx.length; }
    else { from = Math.max(0, Math.floor(+start || 0)); to = Math.min(idx.length, from + n); }
    if (from >= to) return;
    const firstEl = els[idx[from]];
    const kill = new Set(idx.slice(from, to));
    this.elements = els.filter((_, i) => !kill.has(i));
    if (this.wordStart >= idx[from]) this.wordStart = -1; // indices after the removed ones moved
    if (to === idx.length) {
      this.penX = firstEl.x - (idx[from] >= this.lineStart && this.align !== 'left' ? this.alignShift : 0);
      this.penY = firstEl.y;
      this.pendingFeed = false;
      this.lineStart = Math.min(this.lineStart, this.elements.length);
    }
  }

  _clearLines(n, start) {
    n = Math.max(0, Math.floor(+n || 0));
    if (!n) return;
    const lines = [...new Set(this.elements.filter(e => e.t !== 'p' && !e.missing).map(e => e.line))];
    let from, to;
    if (start === undefined || start === null || start === '') { from = Math.max(0, lines.length - n); to = lines.length; }
    else { from = Math.max(0, Math.floor(+start || 0)); to = Math.min(lines.length, from + n); }
    if (from >= to) return;
    const kill = new Set(lines.slice(from, to));
    const first = this.elements.find(e => e.t !== 'p' && kill.has(e.line));
    this.elements = this.elements.filter(e => e.t === 'p' || !kill.has(e.line));
    this.wordStart = -1;
    if (to === lines.length && first) {
      this.penX = first.x;
      this.penY = first.y;
      this.pendingFeed = false;
      this.lineStart = this.elements.length;
    }
  }

  _setGeometry(geo) {
    if (geo) this.geo = geo;
  }

  _resetFont() {
    this.font = this.defaultFont;
    this.align = 'left';
    this.valign = 'top';
  }

  _setFont(key, value) {
    const k = String(key ?? '').trim().toLowerCase();
    const v = String(value ?? '').trim();
    const lv = v.toLowerCase();
    const d = this.defaultFont;
    if (k === 'default') { this._resetFont(); return; }
    // ParseFontCommand opens a new string for every key but align and valign [disasm 0x5d3886]
    if (k !== 'align' && k !== 'valign') this.hasString = true;
    if (k === 'disable') { log.once('balloon:f:disable', 'balloon: \\f[disable] is not supported'); return; }
    const f = { ...this.font };
    const color = (cur, def) => {
      const c = parseColor(v);
      if (Array.isArray(c)) return c;
      if (c === 'default' || c === 'disable') return def;
      if (c === 'default.plain') return this.font.color;
      if (c === 'default.anchor') return this.font.anchorColor;
      if (c && c.startsWith('default.')) return def;
      log.once('balloon:color:' + v, 'balloon: invalid colour ignored:', v);
      return cur;
    };
    switch (k) {
      case 'color': f.color = color(f.color, d.color); break;
      case 'shadowcolor': f.shadow = lv === 'none' ? null : color(f.shadow, d.shadow); break;
      case 'shadowstyle': f.shadowStyle = lv === 'outline' ? 'outline' : lv === 'offset' ? 'offset' : d.shadowStyle; break;
      case 'anchor.font.color': f.anchorColor = color(f.anchorColor, d.anchorColor); break;
      case 'bold': case 'italic': case 'underline': case 'strike': case 'outline': case 'sub': case 'sup': {
        // `toggle` flips it: ParseFontCommand's seven compares with "toggle" [disasm 0x5d4164…0x5d47ed]; \B, \U use it
        const b = lv === 'toggle' ? !f[k] : parseBool(v);
        f[k] = b === null ? d[k] : b;
        if ((k === 'sub' || k === 'sup') && f[k]) f[k === 'sub' ? 'sup' : 'sub'] = false;
        break;
      }
      case 'height': {
        let h = null;
        let m;
        if (lv === 'default' || lv === '') h = d.height;
        else if ((m = /^([+-])\s*(\d+(?:\.\d+)?)$/.exec(lv))) h = f.height + (m[1] === '-' ? -1 : 1) * +m[2];
        else if ((m = /^(\d+(?:\.\d+)?)\s*%$/.exec(lv))) h = (d.height * +m[1]) / 100;
        else if ((m = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(lv))) h = +m[1];
        if (h === null) { log.once('balloon:height:' + v, 'balloon: invalid \\f[height] ignored:', v); return; }
        f.height = Math.max(1, Math.min(512, Math.round(h)));
        break;
      }
      case 'name': f.name = lv === 'default' || lv === 'disable' || !v ? d.name : fontFamily(v); break;
      case 'align':
        this.align = lv === 'center' || lv === 'right' ? lv : 'left';
        this._applyAlign();
        return;
      case 'valign':
        this.valign = lv === 'center' || lv === 'bottom' ? lv : 'top';
        return;
      default: {
        const m = /^(cursornotselect|cursor|anchornotselect|anchorvisited|anchor)(style|color|brushcolor|pencolor|fontcolor|method)$/.exec(k);
        if (!m) { log.once('balloon:f:' + k, 'balloon: unknown \\f[' + k + '] ignored'); return; }
        const g = GROUPS[m[1]];
        const cur = { ...f[g] };
        const def = d[g];
        switch (m[2]) {
          case 'style': cur.style = CURSOR_SHAPES.includes(lv) ? lv : def.style; break;
          case 'color': case 'brushcolor': cur.brush = color(cur.brush, def.brush); break;
          case 'pencolor': cur.pen = color(cur.pen, def.pen); break;
          case 'fontcolor':
            if (lv === 'default.cursor') cur.font = d.cursor.font;
            else if (lv === 'default.cursornotselect') cur.font = d.cursorNS.font;
            else cur.font = color(cur.font, def.font);
            break;
          case 'method': cur.method = (lv !== 'default' && blendMethod(lv)) || def.method; break;
        }
        f[g] = cur;
      }
    }
    this.font = f;
  }

  // ---- queries ------------------------------------------------------------------------------------------------

  /**
   * SSP's hit band (UI §4.8): a point above validRect.top or below validRect.bottom hits no item, whatever is drawn
   * there [disasm SPBalloonWnd::SelectLineInternal 0x5cf7a4 / 0x5cf7c6: y only, the bottom row still counts].
   */
  inBand(by) {
    const vr = this.geo.validRect;
    return by >= vr.top && by <= vr.bottom;
  }

  /** Link index at a balloon-space point (current scroll), or -1. Outside inBand() none, \_b images included. */
  linkAt(bx, by) {
    if (!this.inBand(by)) return -1;
    const g = this.geo, vr = g.validRect;
    const tx = bx - g.originX, ty = by - g.originY + this.scrollY;
    const inText = bx >= vr.left && bx < vr.right && by >= vr.top && by < vr.bottom;
    const els = this.elements;
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.link < 0 || e.missing || !e.w || !e.h) continue;
      if (e.t === 'p') {
        const py = e.fixed ? by : by + this.scrollY;
        if (bx >= e.x && bx < e.x + e.w && py >= e.y && py < e.y + e.h) return e.link;
      } else if (inText) {
        const ey = e.y + e.dy;
        if (tx >= e.x && tx < e.x + e.w && ty >= ey && ty < ey + e.h) return e.link;
      }
    }
    return -1;
  }

  /** Highlight rectangles of a link in balloon space: one per row of adjacent elements, clipped to validRect. */
  linkRects(index) {
    const g = this.geo, vr = g.validRect;
    const out = [];
    let last = null;
    for (const e of this.elements) {
      if (e.link !== index || e.missing || !e.w || !e.h) continue;
      let r;
      if (e.t === 'p') r = { x: e.x, y: e.y - (e.fixed ? 0 : this.scrollY), w: e.w, h: e.h };
      else {
        const x0 = Math.max(vr.left, g.originX + e.x), y0 = Math.max(vr.top, g.originY + e.y + e.dy - this.scrollY);
        const x1 = Math.min(vr.right, g.originX + e.x + e.w), y1 = Math.min(vr.bottom, g.originY + e.y + e.dy + e.h - this.scrollY);
        if (x1 <= x0 || y1 <= y0) continue;
        r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      if (last && e.t !== 'p' && last.y === r.y && r.x <= last.x + last.w + 1 && r.x + r.w >= last.x) {
        const x0 = Math.min(last.x, r.x), x1 = Math.max(last.x + last.w, r.x + r.w);
        last.x = x0; last.w = x1 - x0; last.h = Math.max(last.h, r.h);
      } else {
        out.push(r);
        last = e.t === 'p' ? null : r;
      }
    }
    return out;
  }

  /** Text of a link's glyphs (the label sent with OnChoiceSelectEx for \__q ranges; images contribute nothing). */
  linkText(index) {
    let s = '';
    for (const e of this.elements) if (e.link === index && e.t === 'g') s += e.ch;
    return s;
  }

  /** The LinkInfo to report for a click. */
  linkInfo(index) {
    const l = this.links[index];
    if (!l) return null;
    const info = { ...l.info };
    if (!info.label) info.label = this.linkText(index).replace(/\s+/g, ' ').trim();
    return info;
  }

  get hasLinks() { return this.links.length > 0; }

  /** A choice (\q, \__q) among the links; \_a anchors do not count (Status `choosing`, EV §1.6). */
  get hasChoices() { return this.links.some(l => l.info && l.info.kind === 'choice'); }
}

// BalloonView: one scope's balloon window inside the runtime's Shadow DOM root.
// The model (model.js) does layout and state; this class adds the canvases of a balloon: content (clipped to the
// balloon's shape by a clip-path from its alpha, which is also the hit area: SUM C12), foreground \_b images and scroll
// arrows (not clipped, BA §3.6), highlight overlay and click-wait marker. It also does paint scheduling:
// at most one paint per animation frame, append-only paints while text is typed, full paints otherwise.
// A left-button (or touch) press that travels a few pixels drags the balloon instead of clicking: the view only reports
// 'drag' {kind:'start'|'move'|'end', dx, dy}; the manager moves it and keeps the offset (UI §4.6).
// Balloon scaling (UI §2.1 #9, §9.9): `scale` CSS px per image px. The element keeps its image-px size and gets a CSS
// scale(), so the clip-path, the canvases' CSS sizes and every position inside stay in image px (the pointer maps back
// through getBoundingClientRect); each canvas's backing store is image px × devicePixelRatio × scale, drawn
// nearest-neighbour, so text and images stay crisp at any scale.
// Choice hover and tooltips (UI §4.8): mouse and pen moves go to the model's hoverAt (touch has no hover); the tip
// takes the balloon's colours: the dominant colour of the image cell under the pointer, the border and text in the
// balloon's font.color (UI §4.8).
// Without a DOM (Node tests) it behaves exactly like the model.
import { addStyle, Z_BASE } from '../ui/root.js';
import { BalloonModel } from './model.js';
import { Painter, linkStyle } from './paint.js';
import { drawFallbackPart } from './fallback.js';
import { dominantGrid, gridColor, tipColors } from '../ui/tooltip.js';
import { backingLost } from '../core/canvas.js';

const CSS = `
.smk-balloon{position:absolute;left:0;top:0;pointer-events:none;user-select:none;-webkit-user-select:none;
  -webkit-touch-callout:none;contain:layout style;}
.smk-balloon[hidden],.smk-balloon>[hidden]{display:none!important}
.smk-balloon>canvas{position:absolute;left:0;top:0;display:block;}
.smk-balloon>.smk-b-main{pointer-events:auto;touch-action:none;}
.smk-balloon>.smk-b-main.smk-fixed{touch-action:manipulation;}
.smk-balloon>.smk-b-main.smk-link{cursor:pointer}
.smk-balloon>.smk-b-fg,.smk-balloon>.smk-b-hover,.smk-balloon>.smk-b-wait{pointer-events:none}
.smk-balloon>.smk-b-wait{animation:smk-b-blink 1s steps(1,end) infinite}
@keyframes smk-b-blink{50%{visibility:hidden}}
`;

const hasDom = () => typeof document !== 'undefined' && typeof requestAnimationFrame === 'function';
/** devicePixelRatio as the canvases use it (1..3) */
const deviceRatio = () => Math.min(3, Math.max(1, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1));
/** the real devicePixelRatio (any positive value) */
const rawRatio = () => (typeof devicePixelRatio === 'number' && devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1);
const PENDING_WAIT_MS = 250; // hold the paint this long while inline images are still loading (no layout jump)
const DRAG_PX = { mouse: 4, touch: 10 }; // pointer travel that turns a press into a drag (as for characters, shell/mouse.js)

/** Per skin image: its tip-colour grid (dominantGrid over the validrect), null when its pixels cannot be read. */
const GRIDS = new WeakMap();
function gridOf(skin, img) {
  if (GRIDS.has(img)) return GRIDS.get(img);
  let grid = null;
  try {
    const src = skin.sourceOf(img);
    const ctx = src && typeof src.getContext === 'function' ? src.getContext('2d') : null;
    if (ctx && img.w > 0 && img.h > 0) grid = dominantGrid(ctx.getImageData(0, 0, img.w, img.h).data, img.w, img.h, img.geo.validRect);
  } catch (e) { grid = null; }
  GRIDS.set(img, grid);
  return grid;
}

export class BalloonView extends BalloonModel {
  /**
   * @param {object} o  BalloonModel options, plus:
   * @param {ShadowRoot|HTMLElement|null} [o.root]  parent node; null = headless
   * @param {boolean} [o.draggable]  the user may drag it (default true)
   * @param {number} [o.scale]  CSS px per image px (balloon scaling; default 1)
   * @param {Function} [o.onCanvasLost]  ('balloon'): a canvas of it got no 2D context or no backing store
   *   (core/canvas.js); the balloon then stays headless
   */
  constructor(o) {
    super(o);
    this.painter = new Painter(this);
    this.dom = null;
    this._onCanvasLost = typeof o.onCanvasLost === 'function' ? o.onCanvasLost : null;
    this._lost = false;
    this.x = 0;
    this.y = 0;
    this.dpr = 1;
    this.scale = o.scale > 0 && Number.isFinite(o.scale) ? o.scale : 1;
    this.cdpr = this.scale;  // canvas pixels per image pixel (dpr × scale), set by _resize()
    this._raf = 0;
    this._timer = 0;
    this._full = true;
    this._hoverDirty = false;
    this._pendingSince = 0;
    this._wheel = 0;
    this.draggable = o.draggable !== false;
    this._press = null;      // {id, x0, y0, touch, dragging, dx, dy}: the left button / finger is down on the balloon
    this._dragged = false;   // the last press was a drag: its click (and double click) are not clicks
    if (o.root && hasDom()) this._build(o.root);
  }

  _build(root) {
    addStyle('balloon', CSS);
    const el = document.createElement('div');
    el.className = 'smk-balloon';
    el.dataset.scope = String(this.scope);
    el.hidden = true;
    el.style.zIndex = String(Z_BASE + 100);
    const main = document.createElement('canvas');
    main.className = 'smk-b-main';
    main.setAttribute('role', 'log');
    if (!this.draggable) main.classList.add('smk-fixed');
    const fg = document.createElement('canvas');
    fg.className = 'smk-b-fg';
    const hover = document.createElement('canvas');
    hover.className = 'smk-b-hover';
    const wait = document.createElement('canvas');
    wait.className = 'smk-b-wait';
    wait.hidden = true;
    el.append(main, fg, hover, wait);
    // the contexts, then the first backing stores read back once each (core/canvas.js backingLost), before anything
    // joins the page: a canvas that cannot draw leaves no element (this.dom stays null: headless) and
    // is reported (onCanvasLost('balloon'); the runtime ends the ghost)
    const mctx = main.getContext('2d'), fctx = fg.getContext('2d'), hctx = hover.getContext('2d');
    if (!mctx || !fctx || !hctx || !wait.getContext('2d')) { this._lose(); return; }
    this.dom = { el, main, fg, hover, wait, mctx, fctx, hctx };
    this._resize();
    if (backingLost(mctx) || backingLost(fctx) || backingLost(hctx)) { this.dom = null; this._lose(); return; }
    root.appendChild(el);
    this._listen(main);
  }

  /** A canvas of this balloon cannot draw (_build): reported once through onCanvasLost('balloon'). */
  _lose() {
    if (this._lost) return;
    this._lost = true;
    if (this._onCanvasLost) { try { this._onCanvasLost('balloon'); } catch (e) { /* ignore */ } }
  }

  _listen(main) {
    const local = ev => {
      const r = main.getBoundingClientRect();
      const sx = r.width ? this.width / r.width : 1, sy = r.height ? this.height / r.height : 1;
      return [(ev.clientX - r.left) * sx, (ev.clientY - r.top) * sy];
    };
    const stop = ev => ev.stopPropagation();
    main.addEventListener('pointermove', ev => {
      const p = this._press;
      if (p && ev.pointerId === p.id) {
        p.dx = ev.clientX - p.x0;
        p.dy = ev.clientY - p.y0;
        if (!p.dragging && Math.max(Math.abs(p.dx), Math.abs(p.dy)) >= (p.touch ? DRAG_PX.touch : DRAG_PX.mouse)) {
          p.dragging = true;
          this.pointerLeave();
          main.classList.remove('smk-link');
          this.emit('drag', { kind: 'start', dx: 0, dy: 0 });
        }
        if (p.dragging) { this.emit('drag', { kind: 'move', dx: p.dx, dy: p.dy }); return; }
      }
      const [x, y] = local(ev);
      // touch has no hover: the highlight only, no selection events, no tip [decision]; a held button: no tip
      if (ev.pointerType === 'touch') this.pointerMove(x, y);
      else this.hoverAt(x, y, ev.clientX, ev.clientY, !p);
      main.classList.toggle('smk-link', this.hoverLink >= 0 || this.arrowAt(x, y) >= 0);
    });
    main.addEventListener('pointerenter', () => { this.hovered = true; this.emit('hover', true); });
    main.addEventListener('pointerleave', () => {
      this.hovered = false;
      this.pointerLeave();
      main.classList.remove('smk-link');
      this.emit('hover', false);
    });
    // release (with its final position) or cancel (where it last was): a drag ends there and its click is swallowed
    const release = (ev, final) => {
      const p = this._press;
      if (!p || ev.pointerId !== p.id) return;
      this._press = null;
      if (final) { p.dx = ev.clientX - p.x0; p.dy = ev.clientY - p.y0; }
      try { main.releasePointerCapture(p.id); } catch (e) { /* ignore */ }
      if (!p.dragging) return;
      this._dragged = true;
      this.emit('drag', { kind: 'end', dx: p.dx, dy: p.dy });
    };
    main.addEventListener('pointerdown', ev => {
      stop(ev);
      this.pointerDown();
      if (this._press && ev.isPrimary !== false && ev.button === 0) release({ pointerId: this._press.id }, false); // its release never came
      this._dragged = false;
      this.emit('raise');
      if (ev.button !== 0 || ev.isPrimary === false || !this.draggable) return;
      this._press = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, touch: ev.pointerType === 'touch', dragging: false, dx: 0, dy: 0 };
      try { main.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    main.addEventListener('pointerup', ev => { stop(ev); release(ev, true); });
    main.addEventListener('pointercancel', ev => release(ev, false));
    main.addEventListener('lostpointercapture', ev => release(ev, false));
    main.addEventListener('click', ev => {
      stop(ev);
      if (this._dragged) return;
      const [x, y] = local(ev);
      this.click(x, y, 0);
    });
    main.addEventListener('dblclick', ev => { stop(ev); ev.preventDefault(); if (!this._dragged) this.emit('dblclick'); });
    main.addEventListener('auxclick', ev => { if (ev.button === 1) { stop(ev); ev.preventDefault(); this.emit('click', { button: 1 }); } });
    main.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      stop(ev);
      this.emit('toggleside');
      this.emit('click', { button: 2 });
    });
    main.addEventListener('wheel', ev => {
      if (this.engine.maxScroll <= 0) return;
      ev.preventDefault();
      stop(ev);
      // one wheel notch (100 px, 3 lines) scrolls one 14 px text line; trackpads accumulate smoothly
      const px = ev.deltaMode === 1 ? ev.deltaY * 33.3 : ev.deltaMode === 2 ? ev.deltaY * this.height : ev.deltaY;
      this._wheel += px * 0.14;
      const n = Math.trunc(this._wheel);
      if (n) { this._wheel -= n; this.scrollBy(n); }
    }, { passive: false });
  }

  /**
   * devicePixelRatio for the backing stores. Under balloon scaling the real one, so an explicit percentage gets exactly
   * one canvas pixel per device pixel at any page zoom (k = dpr × (p/100)/dpr = p/100, at most 5); else 1..3.
   */
  _ratio() { return this.scale !== 1 ? rawRatio() : deviceRatio(); }

  /** devicePixelRatio changed (page zoom, another monitor): redraw at the new resolution now, not on the next paint. */
  refreshResolution() {
    if (this.dom && this._ratio() !== this.dpr) { this._resize(); this._schedule(); }
  }

  _resize() {
    const d = this.dom;
    if (!d) return;
    const dpr = this._ratio();
    const k = dpr * this.scale;     // backing pixels per image pixel
    const w = this.width, h = this.height;
    this.dpr = dpr;
    this.cdpr = k;
    d.el.style.width = w + 'px';
    d.el.style.height = h + 'px';
    d.el.style.transform = this.scale !== 1 ? `scale(${this.scale})` : '';
    d.el.style.transformOrigin = this.scale !== 1 ? '0 0' : '';
    for (const c of [d.main, d.fg, d.hover]) {
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.skin.sourceOf(this.img);
    d.main.style.clipPath = (this.img && this.img.hit) || ''; // clips the content too; foreground lives on d.fg
    this._placeWait();
    this._full = true;
  }

  /** The click-wait marker: a canvas like the others (backing × dpr × scale, CSS size in image px, nearest-neighbour). */
  _placeWait() {
    const d = this.dom;
    if (!d || !this.img) return;
    const part = this.skin.clickwait(this.scope) || this.skin.arrow(1, this.scope);
    const src = part ? this.skin.sourceOf(part) : drawFallbackPart('arrow1');
    const w = part ? part.w : 8, h = part ? part.h : 8;
    const k = this.cdpr;
    d.wait.width = Math.max(1, Math.round(w * k));
    d.wait.height = Math.max(1, Math.round(h * k));
    d.wait.style.width = w + 'px';
    d.wait.style.height = h + 'px';
    d.wait.style.left = this.img.geo.clickwait.x + 'px';
    d.wait.style.top = this.img.geo.clickwait.y + 'px';
    const ctx = d.wait.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, d.wait.width, d.wait.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (src) ctx.drawImage(src, 0, 0);
    d.wait.hidden = !this.clickWait;
  }

  /** Balloon scaling: CSS px per image px (the manager sets it for every balloon). */
  setScale(s) {
    s = Number(s);
    if (!(s > 0) || !Number.isFinite(s) || s === this.scale) return;
    this.scale = s;
    if (this.dom) { this._resize(); this._schedule(); }
  }

  /** Viewport position of the balloon's top-left corner (set by the manager's placement). */
  moveTo(x, y) {
    this.x = Math.round(x);
    this.y = Math.round(y);
    if (this.dom) {
      this.dom.el.style.left = this.x + 'px';
      this.dom.el.style.top = this.y + 'px';
    }
  }

  /** Stacking order among balloons (0..99). */
  setZ(z) {
    if (this.dom) this.dom.el.style.zIndex = String(Z_BASE + 100 + Math.max(0, Math.min(99, z)));
  }

  /** Viewport rectangle of the balloon (scaled; width/height are image px). */
  get rect() { return { x: this.x, y: this.y, width: this.width * this.scale, height: this.height * this.scale }; }

  show() {
    const was = this.visible;
    super.show();
    if (!was && this.dom) { this.dom.el.hidden = false; this._schedule(); }
  }

  hide() {
    super.hide();
    if (this.dom) {
      this.dom.el.hidden = true;
      this.dom.main.classList.remove('smk-link');
    }
    if (this.hovered) { this.hovered = false; this.emit('hover', false); }
  }

  showClickWait(on) {
    super.showClickWait(on);
    if (this.dom) this.dom.wait.hidden = !this.clickWait;
  }

  _setImage(img) {
    super._setImage(img);
    if (this.dom) this._resize();
  }

  /** Balloon change (BA §12.2): the model's re-skin, then canvases resized, hit area and click-wait part redrawn. */
  setSkin(skin) {
    super.setSkin(skin);
    if (this.dom) { this.dom.main.classList.remove('smk-link'); this._resize(); this._schedule(); }
  }

  _changed(full) {
    if (full) this._full = true;
    this._schedule();
  }

  _hoverChanged() {
    this._hoverDirty = true;
    const e = this.engine;
    const l = this.hoverLink >= 0 ? e.links[this.hoverLink] : null;
    if ((l && linkStyle(l, true).method === 'none') || this._noneHover) this._full = true;
    this._noneHover = !!(l && linkStyle(l, true).method === 'none');
    this._schedule();
  }

  _schedule() {
    if (!this.dom || this._raf || this._timer) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._paint(); });
  }

  _waitingForImages() {
    const e = this.engine;
    if (!this.images || !e.pendingKeys.size) { this._pendingSince = 0; return false; }
    const now = Date.now();
    if (!this._pendingSince) this._pendingSince = now;
    return now - this._pendingSince < PENDING_WAIT_MS;
  }

  /** Paint now (normally called from requestAnimationFrame). */
  _paint() {
    const d = this.dom;
    if (!d || !this.visible) return;
    if (this._waitingForImages()) {
      this._timer = setTimeout(() => { this._timer = 0; this._schedule(); }, 30);
      return;
    }
    if (this._ratio() !== this.dpr) this._resize();
    const k = this.cdpr;
    const p = this.painter;
    const full = this._full || !p.canAppend();
    if (full || this.engine.elements.length !== p.count) {
      d.mctx.setTransform(k, 0, 0, k, 0, 0);
      d.fctx.setTransform(k, 0, 0, k, 0, 0);
      p.paint(d.mctx, full, d.fctx);
      this._full = false;
      if (full) d.main.setAttribute('aria-label', this.text());
    }
    if (full || this._hoverDirty) {
      p.paintHover(d.hctx, d.mctx, k, d.fctx);
      this._hoverDirty = false;
    }
  }

  /**
   * The tip's colours at a balloon point (CMessageWnd::ToolTipDispInfo → SetColors [disasm 0x472388]): background =
   * the grid cell's dominant colour (LookupDominantGridFromClient), border and text = the image's font.color, moved for
   * contrast (tipColors). null without readable pixels: the system look.
   */
  _tipLook(bx, by) {
    const img = this.img;
    const grid = img ? gridOf(this.skin, img) : null;
    if (!grid) return null;
    return tipColors(gridColor(grid, bx, by), (img.font && img.font.color) || [0, 0, 0]);
  }

  _tipTarget() { return this.dom ? this.dom.main : null; }

  /** Plain text of the balloon (accessibility). */
  text() {
    let s = '', y = null;
    for (const e of this.engine.elements) {
      if (e.t !== 'g') continue;
      if (y !== null && e.y !== y) s += '\n';
      y = e.y;
      s += e.ch;
    }
    return s.replace(/[ 　]+/g, ' ').trim();
  }

  destroy() {
    super.destroy();
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._timer) clearTimeout(this._timer);
    this._raf = this._timer = 0;
    if (this.dom) this.dom.el.remove();
    this.dom = null;
  }
}

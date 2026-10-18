// CharacterView: one character window (scope) on the page (CONTRACTS "Shell", SH §6, UI §3, EV §4.1–4.5).
// The pure parts live in animator.js, render.js, hittest.js, mouse.js and layout.js; this file is the glue plus
// the DOM. Without a DOM (Node tests, stage.dom === false) the view still animates and composes, it just has no
// element.
//
// Hooks for the SakuraScript player (all optional to call; also listed in docs/CONTRACTS.md "Shell"):
//   view.onTalk(n = 1)       n visible characters were added to this scope's balloon ('talk' animations);
//                            view.talk(n) is the same
//   view.talkState(on)       this scope started / stopped talking ('starttalk' / 'endtalk', P2)
//   view.onScriptEnd()       \e reached ('yen-e'); stage.scriptEnd() does it for every view
//   view.waitAnimation(id)   Promise for \i[ID,wait] and \__w[animation,ID]
//   view.anim(id, cmd, ...a) \![anim,start|stop|clear|pause|resume|offset,ID,...]; also pauseAnimation(id),
//                            resumeAnimation(id), offsetAnimation(id, x, y)
//   view.geometryPending     true while the current surface's size is unknown (its images are still loading):
//                            rect/basePoint still describe the previous surface. view.geometryReady() resolves
//                            once they are current; \![move] should await it. A move made while pending is
//                            corrected when the size arrives (the window is kept inside the desk).
//   view.lastRect            rect, or while hidden by \s[-1] the rect with the size it was last shown with (\4 / \5)
//
// Collision tooltips (UI §4.8) [disasm CCharWndCode::ToolTipDispInfo 0x41FA90]: the tracker's 'hover' (a rest on a
// named collision) asks stage.tipSource once per collision change (`fresh`: OnMouseHover and the text; otherwise this
// view's cached text) and shows it in the page's tip box while the pointer still rests there. A shown tip stays where
// it appeared; a move inside the collision restarts its auto-pop [win32]. A collision change, leaving, a press or a
// drag, a surface change or hiding takes it away. 'hover' is not re-emitted as 'mouse'.
import { log } from '../core/log.js';
import { Emitter } from '../core/emitter.js';
import { Animator, EXPLICIT } from './animator.js';
import { SurfaceRenderer } from './render.js';
import { alphaAt, opaqueRects } from './compositor.js';
import { orderedCollisions, collisionAt } from './hittest.js';
import { MouseTracker } from './mouse.js';
import { basePoint, snap, toRatio, fromRatio, clampIntoView, clampInside, rectAt, resolveAlignment, ALIGNMENTS } from './layout.js';
import { surfaceBalloonOffset } from './surfaces.js';
import { currentDpr } from '../core/scaling.js';
import { backingLost } from '../core/canvas.js';

/**
 * image-rendering of a character drawn at kx × ky CSS px per image px: nearest-neighbour when each image pixel covers
 * a whole number of device pixels (Shell scaling 100 / 200 / 300 %, UI §9.9), so it stays pixel-exact at a fractional
 * device position; the browser's smoothing otherwise (no choice on a 125 % display, \![set,scaling,50]).
 */
export function surfaceRendering(kx, ky, dpr = currentDpr()) {
  const whole = k => { const n = Math.abs(k) * dpr; return n > 0.999999 && Math.abs(n - Math.round(n)) < 1e-6; };
  return whole(kx) && whole(ky) ? 'pixelated' : '';
}

/** MouseInfo types that take a shown collision tip away (a collision change, leaving, a press, a drag) [disasm; win32] */
const TIP_HIDE = new Set(['enter', 'leave', 'leaveall', 'down', 'dblclick', 'dragstart']);

/** A drag that carries files from the desktop (DataTransfer.types has 'Files'; names are hidden until the drop). */
export function carriesFiles(dt) {
  const t = dt && dt.types;
  if (!t) return false;
  if (typeof t.includes === 'function') return t.includes('Files');
  if (typeof t.contains === 'function') return t.contains('Files');
  return Array.from(t).includes('Files');
}

/** The Files of a drop, without folders (they arrive as unreadable Files; only webkitGetAsEntry tells them apart). */
export function droppedFiles(dt) {
  const files = Array.from((dt && dt.files) || []);
  const items = Array.from((dt && dt.items) || []).filter(i => i && i.kind === 'file');
  if (items.length !== files.length) return files;
  return files.filter((f, i) => {
    try {
      const entry = typeof items[i].webkitGetAsEntry === 'function' ? items[i].webkitGetAsEntry() : null;
      return !(entry && entry.isDirectory);
    } catch (e) {
      return true;
    }
  });
}

export class CharacterView extends Emitter {
  /**
   * @param {import('./stage.js').Stage} stage
   * @param {number} scope
   */
  constructor(stage, scope) {
    super();
    this.stage = stage;
    this.scope = scope;
    this.shell = stage.shell;
    this.binds = stage.bindState(scope);
    this.animator = new Animator({ bindOn: id => this.binds.isOn(id), random: stage.random });
    this.renderer = new SurfaceRenderer(this.shell, stage.images);
    this.surfaceId = -1;
    this._surf = null;
    this._shown = true;          // show()/hide(); \s[-1] is separate (surfaceId -1)
    this._anchor = null;         // requested base-point position (viewport px), null = not placed yet
    this._ratio = null;          // persisted position {rx, ry}
    this._alignOverride = null;
    this._scaling = [100, 100];
    this._alpha = 100;
    this._geom = null;           // {rect, bp, sx, sy} for the current surface
    this._lastGeom = null;       // _geom when \s[-1] hid it (lastRect, _layoutGeom; saved as `last`)
    this._geomId = -1;
    this._geomWait = -1;
    this._collWait = -1;         // surface whose collision-box images collisionRect asked for
    this._geomWaiters = [];
    this._staleMove = null;      // {w, h} of the geometry a moveTo() used while the current one was loading
    this._image = null;
    this._paintedId = -1;
    this._dirty = false;
    this._autoShow = false;      // an extra scope waiting for its first script \s (SUM §2.6)
    this._implicit = false;
    this._surfaceEvent = false;  // a 'surface' event is owed once the geometry is known
    this._lastRect = null;
    this._ready = [];
    this._dragFrom = null;
    this._clip = null;
    this._cursor = '';
    this._rendering = null;   // the canvas's image-rendering (surfaceRendering)
    this._fileUrl = f => stage.fileUrl(f);
    this._waiting = false;
    this._tip = null;            // {collision, text, wait}: the collision tip asked last (SSP's per-window cache)
    this._tipEpoch = 0;          // bumped by hideTip(): a late reply shows only if nothing took the tip away since
    this._lost = false;          // the canvas cannot draw (_lose; core/canvas.js)
    this._probed = false;        // its first backing store was read back (_paint)
    this.mouse = new MouseTracker({
      scope,
      emit: info => this._mouseInfo(info),
      onDrag: (kind, dx, dy) => this._drag(kind, dx, dy),
      clock: stage.clock,
    });
    this.element = null;
    if (stage.dom) this._initDom();
  }

  // ---------------------------------------------------------------- surface

  /**
   * \s[id]: aliases resolved; -1 hides; an unknown id keeps the current surface (logged once) and returns false.
   * Setting the surface that is already shown does not restart its animations.
   */
  setSurface(id) {
    const rid = this.shell.alias(this.scope, id, this.stage.random);
    if (rid === -1) {
      if (this.surfaceId === -1) return true;
      this.hideTip();
      this.surfaceId = -1;
      this._surf = null;
      this.animator.setSurface(null, this.stage.now());
      if (this._geom) this._lastGeom = this._geom;
      this._geom = null;
      this._geomId = -1;
      this._staleMove = null;
      this._image = null;
      this._paintedId = -1;
      this._surfaceEvent = false;
      this._updateDom();
      this._geometryKnown();
      this.emit('surface', { scope: this.scope, id: -1, width: 0, height: 0 });
      this._emitMove('surface');
      this.stage._flushPlacement();     // a hidden character no longer holds back the default places above it
      return true;
    }
    if (!Number.isFinite(rid) || !this.shell.hasSurface(rid)) {
      log.once(`shell:nosurface:${this.scope}:${id}`, `shell: scope ${this.scope} has no surface ${id}`);
      return false;
    }
    if (this._autoShow && !this._implicit) { this._autoShow = false; this._shown = true; this._surfaceEvent = this.surfaceId >= 0; }
    if (rid === this.surfaceId) {
      if (this._surfaceEvent && this._geom) this._updateGeometry();
      this._updateDom();
      this.invalidate();
      return true;
    }
    this.hideTip();              // a surface change pops the tip; the collision memory stays [disasm CCWC_WindowProc]
    this.surfaceId = rid;
    this._surf = this.shell.surface(rid);
    this.animator.setSurface(this._surf, this.stage.now());
    this._surfaceEvent = !this._autoShow;
    this._dirty = true;
    this.stage.images.load(this.renderer.prefetchFiles(this._surf, id2 => this.binds.isOn(id2))).then(() => this.invalidate());
    this._updateGeometry();
    this.invalidate();
    return true;
  }

  get surface() { return this.surfaceId; }

  /** the resolved surface definition currently shown (null when hidden) */
  get surfaceDef() { return this._surf; }

  /** Promise resolved once the current surface has been composed (immediately when hidden). */
  whenReady() {
    if (this.surfaceId < 0 || this._paintedId === this.surfaceId) return Promise.resolve();
    return new Promise(r => this._ready.push(r));
  }

  /** true while the current surface's size is unknown: rect / basePoint still describe the previous surface */
  get geometryPending() { return this.surfaceId >= 0 && this._geomId !== this.surfaceId; }

  /**
   * Promise resolved once rect / basePoint describe the current surface (at once when they already do or when
   * hidden by \s[-1]). Unlike whenReady() it does not wait for a paint, so it also resolves for hidden views.
   */
  geometryReady() {
    if (!this.geometryPending) return Promise.resolve();
    return new Promise(r => this._geomWaiters.push(r));
  }

  _geometryKnown() {
    if (this.geometryPending || !this._geomWaiters.length) return;
    const w = this._geomWaiters;
    this._geomWaiters = [];
    for (const f of w) f();
  }

  // ---------------------------------------------------------------- animations

  startAnimation(id) { const ok = this.animator.start(+id, this.stage.now(), EXPLICIT); this.invalidate(); return ok; }
  stopAnimation(id) { this.animator.stop(+id); this.invalidate(); }
  isAnimating(id) { return this.animator.isAnimating(+id); }
  stopAllAnimations() { this.animator.stopAll(); this.invalidate(); }
  waitAnimation(id) { return this.animator.wait(+id); }

  /** \![anim,cmd,ID,...] — cmd: start | stop | clear | pause | resume | offset (x, y) */
  anim(id, cmd, ...args) {
    const now = this.stage.now();
    switch (String(cmd).toLowerCase()) {
      case 'start': return this.startAnimation(id);
      case 'stop': case 'clear': return this.stopAnimation(id);
      case 'pause': this.animator.pause(+id, now); break;
      case 'resume': this.animator.resume(+id, now); break;
      case 'offset': this.animator.setOffset(+id, +args[0] || 0, +args[1] || 0); break;
      default: log.once('shell:animcmd:' + cmd, 'shell: unsupported \\![anim] command', cmd);
    }
    this.invalidate();
  }

  pauseAnimation(id) { return this.anim(id, 'pause'); }
  resumeAnimation(id) { return this.anim(id, 'resume'); }
  offsetAnimation(id, x, y) { return this.anim(id, 'offset', x, y); }

  onTalk(n = 1) { this.animator.talk(this.stage.now(), n); this.invalidate(); }
  /** same as onTalk (the name the SakuraScript player probes first in older builds) */
  talk(n = 1) { this.onTalk(n); }
  talkState(on) { this.animator.talkState(this.stage.now(), !!on); this.invalidate(); }
  onScriptEnd() { this.animator.scriptEnd(this.stage.now()); this.invalidate(); }

  // ---------------------------------------------------------------- dress-up

  /**
   * \![bind,category,part,value]: '1' on, '0' off, ''/undefined toggle (SUM C24). Applied immediately.
   * opts.noEvent (\![bind-noevent]) marks the 'bind' events so that no OnDressupChanged is sent.
   */
  bind(category, part, value, opts = {}) {
    const changes = this.binds.apply(category, part, value);
    this.stage._bindChanged(this.scope, changes, opts);
    return changes;
  }

  /** ON bind-group ids, ascending */
  getBinds() { return this.binds.onIds(); }

  _bindsChanged(changes) {
    const now = this.stage.now();
    for (const c of changes) this.animator.bindChanged(c.id, c.on, now);
    if (this._surf && changes.some(c => c.on)) {
      this.stage.images.load(this.renderer.prefetchFiles(this._surf, id => this.binds.isOn(id))).then(() => this.invalidate());
    }
    this._dirty = true;
    this.invalidate();
  }

  // ---------------------------------------------------------------- geometry and placement

  get alignment() {
    return resolveAlignment(this.scope, this._alignOverride, this.shell.descript, this.stage.ghostDescript);
  }

  /** \![set,alignmenttodesktop,mode]: bottom | top | left | right | free | default */
  setAlignment(mode) {
    const m = String(mode || '').trim().toLowerCase();
    if (m === 'default' || m === '') this._alignOverride = null;
    else if (ALIGNMENTS.includes(m)) this._alignOverride = m;
    else { log.once('shell:align:' + m, 'shell: unknown alignment', mode); return; }
    if (this._anchor && this._geom) {
      this._anchor = this._eff();
      this._ratio = toRatio(this._anchor, this.stage.desk());
    }
    this._place();
    this._emitMove('align');
  }

  /** \![set,scaling,x,y] in percent; negative mirrors that axis about the base point */
  setScaling(sx, sy = sx) {
    sx = Number(sx); sy = Number(sy);
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx === 0 || sy === 0) return;
    this._scaling = [sx, sy];
    // the base rect and point do not depend on scaling: keep the geometry (even while a new surface loads)
    if (this._geom) {
      const { kx, ky } = this._k();
      this._geom = { ...this._geom, sx: Math.abs(kx), sy: Math.abs(ky) };
    }
    this._place();
    this._emitMove('scaling');
  }

  get scaling() { return this._scaling.slice(); }

  /**
   * The stage's scale changed (Stage.setScale): new geometry factors, then about the base point, docked, against the
   * desk edge it stood against (fit.left / fit.right), and kept on the desk (wholly when fit.inside, else a corner of
   * it, UI §3.3).
   * @param {{left?:boolean, right?:boolean, inside?:boolean}} fit where the base rect was before
   */
  _rescale(fit = {}, desk = this.stage.desk()) {
    if (this._geom) {
      const { kx, ky } = this._k();
      this._geom = { ...this._geom, sx: Math.abs(kx), sy: Math.abs(ky) };
      if (this._anchor) {
        let a = this._eff();
        const r = rectAt(a, this._geom);
        if (fit.right) a = { x: a.x + desk.w - (r.x + r.width), y: a.y };
        else if (fit.left) a = { x: a.x - r.x, y: a.y };
        this._anchor = fit.inside ? clampInside(a, this._geom, desk) : clampIntoView(a, this._geom, desk);
        this._ratio = toRatio(this._anchor, desk);
      }
    }
    this._place();
    this._emitMove('scale');
  }

  /** \![set,alpha,percent] */
  setAlpha(p) {
    p = Math.max(0, Math.min(100, Number(p)));
    if (!Number.isFinite(p)) return;
    this._alpha = p;
    if (this.element) this.element.style.opacity = String(p / 100);
  }

  _k() {
    const s = this.stage.scale;
    return { kx: s * this._scaling[0] / 100, ky: s * this._scaling[1] / 100 };
  }

  /**
   * The geometry placement uses: the current surface's; while hidden by \s[-1], the one it was last shown with, at
   * the current scale (SSP keeps a hidden window's size, UI §3.2, §3.8). null: loading, or hidden and never sized.
   */
  _layoutGeom() {
    if (this._geom) return this._geom;
    if (this.surfaceId >= 0 || !this._lastGeom) return null;
    const { kx, ky } = this._k();
    return { ...this._lastGeom, sx: Math.abs(kx), sy: Math.abs(ky) };
  }

  _updateGeometry() {
    if (this.surfaceId < 0) return;
    const r = this.renderer.baseRect(this.surfaceId);
    if (!r) {
      // base still loading
      const id = this.surfaceId;
      if (this._geomWait !== id) {
        this._geomWait = id;
        this.stage.images.load(this.renderer.baseFiles(id)).then(() => {
          if (this._geomWait === id) this._geomWait = -1;
          if (this.surfaceId === id) { this._updateGeometry(); this.invalidate(); }
        });
      }
      return;
    }
    const { kx, ky } = this._k();
    const name = this.scope === 0 ? 'sakura' : this.scope === 1 ? 'kero' : 'char' + this.scope;
    const dv = k => this.shell.descript.get(`${name}.${k}`) ?? (this.stage.ghostDescript && this.stage.ghostDescript.get(`${name}.${k}`));
    const bp = basePoint(r, { defaultX: dv('defaultx'), defaultY: dv('defaulty'), basepos: this._surf && this._surf.basepos });
    this._geom = { rect: r, bp, sx: Math.abs(kx), sy: Math.abs(ky) };
    this._geomId = this.surfaceId;
    if (!this._anchor && !this._autoShow) this.stage._placeNew(this);   // a hidden \p[n] is placed on its first real \s
    const sm = this._staleMove;
    this._staleMove = null;
    if (sm && this._anchor && (sm.w !== r.w || sm.h !== r.h)) {
      // a script moved the window using the previous surface's size: its target was relative to the wrong
      // rectangle (e.g. \s[951]\![move,...,right.top,right.top] in one go). Keep the real window on the desk.
      const desk = this.stage.desk();
      this._anchor = clampInside(this._eff(), this._geom, desk);
      this._ratio = toRatio(this._anchor, desk);
    }
    this._place();
    if (this._surfaceEvent) {
      this._surfaceEvent = false;
      this.emit('surface', { scope: this.scope, id: this.surfaceId, width: r.w, height: r.h });
    }
    this._emitMove('surface');
    this._geometryKnown();
    this.stage._flushPlacement();
  }

  /** effective (docked) anchor */
  _eff() {
    if (!this._anchor) return (this._geom && this.stage._defaultAnchor(this)) || { x: 0, y: 0 };
    if (!this._geom) return this._anchor;
    return snap(this._anchor, this._geom, this.alignment, this.stage.desk());
  }

  _moveOffset() {
    const m = this.animator.moveOffset();
    const s = this.stage.scale;
    return m ? { x: m.x * s, y: m.y * s } : { x: 0, y: 0 };
  }

  /** viewport rect of the base surface (not the grown canvas), including animation 'move' offsets; OnSecondChange's
   * R1/R2 use collisionRect instead (SUM C17) */
  get rect() {
    if (!this._geom || this.surfaceId < 0) {
      const a = this._eff();
      return { x: a.x, y: a.y, width: 0, height: 0 };
    }
    return this._viewRect(this._eff(), this._geom);
  }

  /**
   * ssp.exe's collision rect on the viewport (OnSecondChange R1 / R2, SUM C17, EV §3.2.1): the surface's collision box
   * (SurfaceRenderer.collisionBox, surface px) placed as GetCollisionRectVirtual places it [disasm 0x6faa90]: its
   * offset in the window scaled by |scaling| with truncation and never mirrored (ScaleRectNoMirror 0x6dcdd0), plus the
   * window's position. The base rect (rect) stands in for SSP's window [infer]. null: hidden, no surface, or an empty
   * box, which never counts (a blank surface; IsEmpty 0x420a9d); undefined: the geometry or the box's images are still
   * loading (asked for once per surface).
   * @returns {{x:number, y:number, width:number, height:number}|null|undefined}
   */
  get collisionRect() {
    if (!this.visible) return null;
    if (!this._geom || this.geometryPending) return undefined;
    const id = this.surfaceId;
    const missing = [];
    const b = this.renderer.collisionBox(id, missing);
    if (b === undefined) {
      if (missing.length && this._collWait !== id) {
        this._collWait = id;
        this.stage.images.load(missing).then(() => { if (this._collWait === id) this._collWait = -1; });
      }
      return undefined;
    }
    if (!b || b.r <= b.l || b.b <= b.t) return null;
    const g = this._geom, v = this._viewRect(this._eff(), g), { kx, ky } = this._k();
    const ax = Math.abs(kx), ay = Math.abs(ky);
    const x0 = Math.trunc((b.l - g.rect.x) * ax), x1 = Math.trunc((b.r - g.rect.x) * ax);
    const y0 = Math.trunc((b.t - g.rect.y) * ay), y1 = Math.trunc((b.b - g.rect.y) * ay);
    return { x: v.x + x0, y: v.y + y0, width: x1 - x0, height: y1 - y0 };
  }

  /**
   * rect; while hidden by \s[-1] (rect is 0×0 at the base point), the rect it would have there with the size it was
   * last shown with, as SSP keeps a hidden window's size: \4 / \5 move it with that (UI §3.8). null: never sized.
   */
  get lastRect() {
    if (this._geom && this.surfaceId >= 0) return this.rect;
    if (!this._lastGeom || !this._anchor) return null;
    const { kx, ky } = this._k();
    const g = { ...this._lastGeom, sx: Math.abs(kx), sy: Math.abs(ky) };
    return this._viewRect(snap(this._anchor, g, this.alignment, this.stage.desk()), g);
  }

  /** viewport rect of geometry g's base rect with the base point at anchor a, plus animation 'move' offsets */
  _viewRect(a, g) {
    const m = this._moveOffset(), { kx, ky } = this._k();
    const xa = a.x + m.x + (g.rect.x - g.bp.x) * kx, xb = a.x + m.x + (g.rect.x + g.rect.w - g.bp.x) * kx;
    const ya = a.y + m.y + (g.rect.y - g.bp.y) * ky, yb = a.y + m.y + (g.rect.y + g.rect.h - g.bp.y) * ky;
    return { x: Math.min(xa, xb), y: Math.min(ya, yb), width: Math.abs(xb - xa), height: Math.abs(yb - ya) };
  }

  /** viewport position of the base point (SUM C28) */
  get basePoint() {
    const a = this._eff(), m = this._moveOffset();
    return { x: a.x + m.x, y: a.y + m.y };
  }

  get position() { return this.basePoint; }

  /** balloon offset for the current surface (per-surface keys override descript.txt) */
  get balloonOffset() { return surfaceBalloonOffset(this.shell, this._surf, this.scope); }

  /** Move so that the base point is at viewport (x, y) (\![move], scripts). Docking still applies. */
  moveTo(x, y) {
    const m = this._moveOffset();
    const g = this._geom;
    this._staleMove = this.geometryPending ? { w: g ? g.rect.w : 0, h: g ? g.rect.h : 0 } : null;
    this._anchor = { x: x - m.x, y: y - m.y };
    if (this._geom) this._anchor = this._eff();
    this._ratio = toRatio(this._anchor, this.stage.desk());
    this._place();
    this._emitMove('script');
  }

  /** Move so that the base rect's top-left corner is at viewport (left, top). */
  moveRectTo(left, top) {
    if (!this._geom) { this.moveTo(left, top); return; }
    const r = this.rect, b = this.basePoint;
    this.moveTo(left + (b.x - r.x), top + (b.y - r.y));
  }

  /**
   * restore a saved ratio position ({rx, ry}); applied when the geometry is known (hidden by \s[-1]: with the size it
   * was last shown with, _layoutGeom)
   */
  setRatio(p) {
    if (!p || !Number.isFinite(+p.rx)) return;
    this._ratio = { rx: +p.rx, ry: +p.ry || 0 };
    this._anchor = null;
    const g = this._layoutGeom();
    if (g) { this._anchor = this._fromRatio(g); this._place(); this._emitMove('restore'); }
  }

  _fromRatio(g = this._geom) {
    const desk = this.stage.desk();
    const a = fromRatio(this._ratio, desk);
    return g ? clampIntoView(snap(a, g, this.alignment, desk), g, desk) : a;
  }

  /**
   * viewport resized: recompute from the stored ratio, dock and keep on screen. A character hidden by \s[-1] follows
   * too, with the size it was last shown with; one without a size (never sized, or loading) is placed from its ratio
   * once its size is known (Stage._placeNew), never at a place an older desk gave it.
   */
  _relayout() {
    if (!this._ratio) { this._place(); return; }
    const g = this._layoutGeom();
    this._anchor = g ? this._fromRatio(g) : null;
    this._place();
    if (this._anchor) this._emitMove('resize');
  }

  /** place at a computed default anchor (layout) */
  _placeAt(a) {
    this._anchor = a;
    this._ratio = toRatio(this._eff(), this.stage.desk());
    this._place();
    this._emitMove('layout');
  }

  _emitMove(reason) {
    if (!this._anchor && !this._autoShow && this.surfaceId >= 0) return;   // not placed yet (Stage._placeNew)
    const r = this.rect;
    const last = this._lastRect;
    if (last && last.x === r.x && last.y === r.y && last.width === r.width && last.height === r.height && reason !== 'dragend') return;
    this._lastRect = r;
    this.emit('move', { scope: this.scope, reason });
  }

  // ---------------------------------------------------------------- visibility

  show() { this._shown = true; this._updateDom(); this.invalidate(); }
  hide() { this._shown = false; this.hideTip(); this._updateDom(); }
  get visible() { return this._shown && this.surfaceId >= 0; }

  // ---------------------------------------------------------------- hit testing

  /** client point -> surface coordinates (undoes placement, move offsets and scaling/mirroring) */
  toSurface(clientX, clientY) {
    const g = this._geom;
    if (!g) return { x: NaN, y: NaN };
    const a = this._eff(), m = this._moveOffset(), { kx, ky } = this._k();
    return { x: g.bp.x + (clientX - a.x - m.x) / kx, y: g.bp.y + (clientY - a.y - m.y) / ky };
  }

  /** collision id at a client point: '' = on the character but no collision; null = transparent / not shown */
  hitTest(clientX, clientY) {
    if (!this.visible || !this._image) return null;
    const p = this.toSurface(clientX, clientY);
    return this.hitTestSurface(p.x, p.y);
  }

  /** same as hitTest, in surface coordinates */
  hitTestSurface(sx, sy) {
    if (!this._image || this.surfaceId < 0 || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
    if (alphaAt(this._image, sx, sy) === 0) return null;
    return collisionAt(orderedCollisions(this.shell, this._surf, this.animator), Math.floor(sx), Math.floor(sy));
  }

  /**
   * The collision at a surface point by its shape only, '' for none or no surface: SSP's GetCollisionNameChar tests no
   * alpha (SPSerikoAnimation::GetCollisionName 0x6fffc0) [disasm]; OnMouseGesture's R2 / R4 (EV §4.5.1), where the
   * captured pointer may be off the opaque pixels.
   */
  collisionAtSurface(sx, sy) {
    if (!this._surf || this.surfaceId < 0 || !Number.isFinite(sx) || !Number.isFinite(sy)) return '';
    return collisionAt(orderedCollisions(this.shell, this._surf, this.animator), Math.floor(sx), Math.floor(sy));
  }

  // ---------------------------------------------------------------- frame loop (called by the stage)

  invalidate() { this.stage._requestFrame(); }

  /** @returns {number} next time (ms) this view needs a frame, Infinity if idle */
  _frame(now) {
    if (this.surfaceId < 0 || !this._shown) return Infinity;
    if (this.animator.tick(now)) this._dirty = true;
    if (this.animator.moved) {
      this.animator.moved = false;
      this._place();
      this._emitMove('animation');
    }
    if (this._geomId !== this.surfaceId) this._updateGeometry();
    if (this._dirty && !this._waiting) {
      const { image, missing } = this.renderer.compose(this._surf, { bindOn: id => this.binds.isOn(id), anim: this.animator });
      if (image) {
        this._dirty = false;
        this._image = image;
        this._paintedId = this.surfaceId;
        this._paint();
        const r = this._ready;
        this._ready = [];
        for (const f of r) f();
      } else {
        this._waiting = true;
        this.stage.images.load(missing).then(() => { this._waiting = false; this.invalidate(); });
      }
    }
    return this.animator.nextDue();
  }

  /** the last composed image (surface-coordinate origin in img.ox/oy) */
  get image() { return this._image; }

  // ---------------------------------------------------------------- DOM

  _initDom() {
    // the context before anything is made (core/canvas.js): none -> no element, canvas or listener (the
    // view stays as a headless one) and the stage reports the lost canvas, which ends the ghost
    const cv = document.createElement('canvas');
    cv.className = 'smk-surface';
    cv.width = 0; cv.height = 0;
    const ctx = cv.getContext('2d');
    if (!ctx) { this._lose(); return; }
    const el = document.createElement('div');
    el.className = 'smk-char';
    el.dataset.scope = String(this.scope);
    el.style.display = 'none';
    el.appendChild(cv);
    this.element = el;
    this.canvas = cv;
    this.ctx = ctx;
    this.stage._mount(this);
    // wx / wy: the point in the window, which the base rect stands in for (as for the collision rect) [infer], in CSS
    // px, the desk's unit [decision]; col: the collision by shape (OnMouseGesture, EV §4.5.1)
    const rec = e => {
      const p = this.toSurface(e.clientX, e.clientY);
      const device = e.pointerType === 'pen' && (e.buttons & 32) ? 'eraser' : (e.pointerType || 'mouse');
      const hit = this.hitTestSurface(p.x, p.y), vr = this.rect;
      return { x: e.clientX, y: e.clientY, sx: p.x, sy: p.y, hit, button: e.button,
        buttons: e.buttons, device, alt: e.altKey, time: this.stage.now(),
        wx: e.clientX - vr.x, wy: e.clientY - vr.y, col: hit !== null ? hit : this.collisionAtSurface(p.x, p.y) };
    };
    // while Stage.carry() moves a character, the pointer belongs to it: no mouse events for the ghost [guess]
    const carrying = () => !!this.stage.carrying;
    // F1 (ssp-ui.md §9.11): while a press is held, another pointer (a second finger) is not the ghost's, so it cannot
    // take the first one's drag or end its press; with no press held every pointer is taken (a stale _pid never
    // blocks). A mouse has one pointerId; events without one are always taken. SSP drags the window with two
    // fingers (OnCWTouch): not done [decision]
    this._pid = null;             // pointerId of the press held (set at every accepted pointerdown)
    const other = e => !!this.mouse.press && typeof e.pointerId === 'number' && typeof this._pid === 'number' &&
      e.pointerId !== this._pid;
    cv.addEventListener('pointerdown', e => {
      if (carrying()) return;
      const r = rec(e);
      if (r.hit === null) return;
      e.stopPropagation();
      if (other(e)) return;
      if (e.pointerType === 'mouse') e.preventDefault();
      this.stage.raise(this.scope);
      if (this.mouse.down(r)) {
        this._pid = e.pointerId;
        try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      }
      this._setCursor(this._cursorFor(r.button === 2 ? 'mouserightdown' : 'mousedown', r.hit));
    });
    cv.addEventListener('pointermove', e => {
      if (carrying() || other(e)) return;
      // a gesture takes every coalesced sample: SSP steps on each WM_MOUSEMOVE, a frame's single event would miss
      // short flicks (EV §4.5.1)
      const p = this.mouse.press;
      const list = p && p.g && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      if (list && list.length) { for (const c of list) this.mouse.move(rec(c)); return; }
      const r = rec(e);
      this.mouse.move(r);
      if (!this.mouse.press) this._setCursor(this._cursorFor('mouseup', r.hit));
    });
    cv.addEventListener('pointerup', e => {
      if (!this.mouse.press) return;
      e.stopPropagation();
      if (other(e)) return;
      const r = rec(e);
      this.mouse.up(r);
      try { cv.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this._setCursor(this._cursorFor('mouseup', r.hit));
    });
    cv.addEventListener('pointercancel', e => { if (!other(e)) this.mouse.cancel(rec(e)); });
    cv.addEventListener('lostpointercapture', e => { if (this.mouse.press && !other(e)) this.mouse.cancel(rec(e)); });
    cv.addEventListener('pointerleave', e => { if (!this.mouse.press && !carrying()) this.mouse.leave(rec(e)); });
    cv.addEventListener('wheel', e => {
      if (carrying()) return;
      const r = rec(e);
      if (r.hit === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.mouse.wheel({ ...r, deltaY: e.deltaY, deltaMode: e.deltaMode });
    }, { passive: false });
    cv.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
    cv.addEventListener('dblclick', e => e.preventDefault());
    cv.addEventListener('dragstart', e => e.preventDefault());
    // files dragged onto the character (EV §4.14 OnFileDrop2). Only drags that carry files and are over an opaque
    // pixel are taken, and only while something receives them (stage.acceptsDrops); text, links, and drops elsewhere
    // keep the browser's and the host page's own handling. A drop after an accepted dragover is ours even if the
    // surface changed under it meanwhile (else the browser would open the file in place of the page). The file
    // names are unknown until the drop, so there is no OnFileDropping.
    let accepted = false;
    const filesHere = e => !!this.stage.acceptsDrops && carriesFiles(e.dataTransfer) && this.hitTest(e.clientX, e.clientY) !== null;
    const over = e => {
      accepted = filesHere(e);
      if (!accepted) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (_) { /* read-only in some browsers */ }
    };
    cv.addEventListener('dragenter', over);
    cv.addEventListener('dragover', over);
    cv.addEventListener('dragleave', () => { accepted = false; });
    cv.addEventListener('drop', e => {
      const ours = carriesFiles(e.dataTransfer) && (accepted || filesHere(e));
      accepted = false;
      if (!ours) return;
      e.preventDefault();
      e.stopPropagation();
      const files = droppedFiles(e.dataTransfer);
      if (!files.length) return;
      this.stage.raise(this.scope);
      const p = this.toSurface(e.clientX, e.clientY);
      this.emit('drop', { scope: this.scope, files, x: Math.floor(p.x), y: Math.floor(p.y) });
    });
  }

  // ---------------------------------------------------------------- collision tooltips (UI §4.8)

  _mouseInfo(info) {
    if (info.type === 'hover') { this._tipRest(info); return; }
    if (TIP_HIDE.has(info.type)) this.hideTip();
    else if (info.type === 'move' && this._tipShown()) this.stage.tips.touch(this);   // stays put, auto-pop restarts
    this.emit('mouse', info);
  }

  _tipShown() { return !!this.stage.tips && this.stage.tips.owner === this; }

  /**
   * A rest on a named collision: a `fresh` one (or one this view has no answer for: it never asked it, or the answer
   * was undefined) asks stage.tipSource({scope, collision, x, y, fresh, device}) -> text | null (no tip) | undefined
   * (not asked: ask again, fresh, next time); the same collision again shows the cached text. It shows only while the
   * pointer still rests where it asked and nothing took tips away since (hideTip: a surface change, a press, …); a tip
   * already showing stays where it is (no TTN_GETDISPINFO while the tip is up [win32]).
   */
  _tipRest(info) {
    const src = this.stage.tipSource;
    if (typeof src !== 'function' || this._tipShown()) return;
    const collision = String(info.collision);
    const epoch = this._tipEpoch;
    let tip = this._tip;
    const fresh = !!info.fresh || !tip || tip.collision.toLowerCase() !== collision.toLowerCase();
    if (fresh) {
      const t = { collision, text: null, wait: null };
      this._tip = tip = t;
      const req = { scope: this.scope, collision, x: info.x, y: info.y, fresh, device: info.device };
      t.wait = (async () => src(req))().then(text => {
        if (this._tip !== t) return;
        t.wait = null;
        if (text === undefined) this._tip = null;
        else t.text = text ? String(text) : null;
      }, () => { if (this._tip === t) this._tip = null; });
    }
    const show = () => {
      const m = this.mouse;
      if (this._tip !== tip || !tip.text || m.rest !== info.rest || !m.inside || m.press || !this.visible ||
        this._tipEpoch !== epoch || this.stage.carrying || this.stage.veiled) return;
      this.stage.tips.show(this, tip.text, { x: info.clientX, y: info.clientY, look: 'system', target: this.canvas });
    };
    if (tip.wait) tip.wait.then(show); else show();
  }

  /** Take this character's tip away (its cached text stays; a reply still on its way for an earlier rest won't show). */
  hideTip() {
    this._tipEpoch++;
    if (this.stage.tips) this.stage.tips.hide(this);
  }

  /** CSS cursor for a pointer state; cursor files resolve against the shell folder (SH §2.16) */
  _cursorFor(event, hit) {
    return this.shell.cursorFor(this.scope, event, hit, this._fileUrl);
  }

  _setCursor(c) {
    if (this.canvas && c !== this._cursor) { this._cursor = c; this.canvas.style.cursor = c; }
  }

  _updateDom() {
    if (!this.element) return;
    this.element.style.display = this.visible && !this.stage.veiled && this._image && this._anchor && !this._lost ? '' : 'none';
  }

  /**
   * This character's canvas cannot draw (no 2D context, or no backing store: core/canvas.js): nothing of it shows or
   * takes a tap from now on, and the stage reports it once (Stage.canvasLost; the runtime ends the ghost).
   */
  _lose() {
    if (this._lost) return;
    this._lost = true;
    this.hideTip();
    if (this.element) this.element.style.display = 'none';
    this.stage.canvasLost('character');
  }

  _paint() {
    this._updateDom();
    if (!this.canvas || this._lost) return;
    const img = this._image, cv = this.canvas;
    const resized = cv.width !== img.width || cv.height !== img.height;
    if (cv.width !== img.width) cv.width = img.width;
    if (cv.height !== img.height) cv.height = img.height;
    if (img.width && img.height) {
      // the canvas's first backing store, read back once (WebKit's canvas memory cap draws nothing and throws nothing;
      // Chromium warns at a second read: core/canvas.js backingLost). A refusal at a later resize is not seen (a known
      // limit, ssp-ui.md §9.11 S5): the put draws nothing and the clip below still takes taps
      if (resized && !this._probed) {
        this._probed = true;
        if (backingLost(this.ctx)) { this._lose(); return; }
      }
      this.ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    }
    // pointer events only on opaque pixels (SUM C12)
    let clip = '';
    const r = opaqueRects(img);
    for (let i = 0; i < r.length; i += 4) clip += `M${r[i]} ${r[i + 1]}h${r[i + 2]}v${r[i + 3]}h${-r[i + 2]}z`;
    if (clip !== this._clip) {
      this._clip = clip;
      cv.style.clipPath = clip ? `path('${clip}')` : '';
      cv.style.pointerEvents = clip ? 'auto' : 'none';
    }
    this._place();
  }

  _place() {
    this._updateDom();
    if (!this.element || !this._geom || !this._image) return;
    const a = this._eff(), m = this._moveOffset(), g = this._geom, img = this._image, { kx, ky } = this._k();
    this.element.style.transform = `translate(${a.x + m.x}px,${a.y + m.y}px)`;
    this.canvas.style.transform = `matrix(${kx},0,0,${ky},${(img.ox - g.bp.x) * kx},${(img.oy - g.bp.y) * ky})`;
    const ir = surfaceRendering(kx, ky);
    if (ir !== this._rendering) { this._rendering = ir; this.canvas.style.imageRendering = ir; }
  }

  _drag(kind, dx, dy) {
    if (kind === 'start') {
      this._dragFrom = this._eff();
      this.stage.raise(this.scope);
      return;
    }
    if (!this._dragFrom) return;
    const desk = this.stage.desk();
    const a = { x: this._dragFrom.x + dx, y: this._dragFrom.y + dy };
    this._anchor = this._geom ? snap(a, this._geom, this.alignment, desk) : a;
    this._place();
    if (kind === 'end') {
      this._dragFrom = null;
      this._ratio = toRatio(this._anchor, desk);
      this._emitMove('dragend');
    } else this._emitMove('drag');
  }

  /**
   * `last`: while hidden by \s[-1], the base rect and base point (surface px) it was last shown with, so after a page
   * change it still counts for the default places above it, at its size (UI §3.2) and \4 / \5 still know it
   */
  saveState() {
    const st = {
      surface: this._autoShow ? -1 : this.surfaceId,
      pos: this._ratio ? { rx: this._ratio.rx, ry: this._ratio.ry } : null,
      binds: this.getBinds(),
      visible: this._shown || this._autoShow,
      align: this._alignOverride,
      scaling: this._scaling.slice(),
      alpha: this._alpha,
    };
    const g = this.surfaceId < 0 && !this._autoShow ? this._lastGeom : null;
    if (g) st.last = { x: g.rect.x, y: g.rect.y, w: g.rect.w, h: g.rect.h, bx: g.bp.x, by: g.bp.y };
    return st;
  }

  /** a saved `last` (saveState) for a view hidden by \s[-1]; a malformed one is ignored */
  _restoreLast(o) {
    if (!o || typeof o !== 'object' || this.surfaceId >= 0) return;
    const [x, y, w, h, bx, by] = ['x', 'y', 'w', 'h', 'bx', 'by'].map(k => Number(o[k]));
    if (![x, y, w, h, bx, by].every(Number.isFinite) || w < 0 || h < 0) return;
    this._lastGeom = { rect: { x, y, w, h }, bp: { x: bx, y: by }, sx: 1, sy: 1 };
  }

  destroy() {
    this.hideTip();
    this._tip = null;
    this.mouse.destroy();
    this.animator.stopAll();
    if (this.element && this.element.parentNode) this.element.parentNode.removeChild(this.element);
    this.element = null;
  }
}

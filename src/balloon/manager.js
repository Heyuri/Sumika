// Balloons: one BalloonView per scope, placed next to stage.char(scope), following its moves.
// Also owns the per-ghost balloon settings that outlive a script (side chosen by right click, offset dragged by the
// user, \![set,balloonoffset], \![set,balloonalign]) and persists them (BA §4, §7, SUM §2.5, UI §4.6).
// A balloon change re-skins every balloon in place (setSkin) and a shell change makes them follow the new Stage
// (setStage); neither touches those settings (BA §12).
// On a phone (option `phone`, ssp-ui.md §9.11) a balloon with no room beside her goes above her head, the default
// scale is the balloon fit (fitScale) and the viewport is the stage's desk(); without the option, none of it.
import { Emitter } from '../core/emitter.js';
import { getRoot } from '../ui/root.js';
import { log } from '../core/log.js';
import { BalloonSkin } from './skin.js';
import { BalloonView } from './view.js';
import { ImageStore, scanImagePaths } from './images.js';
import { placeBalloon, balloonFit } from './placement.js';

const hasDom = () => typeof document !== 'undefined';

function viewport() {
  if (!hasDom()) return { width: 1280, height: 720 };
  const de = document.documentElement;
  return { width: de.clientWidth || window.innerWidth || 1280, height: de.clientHeight || window.innerHeight || 720 };
}

const truthy = v => /^\s*(1|true|on|yes)\s*$/i.test(String(v ?? ''));

function charName(scope) {
  return scope === 0 ? 'sakura' : scope === 1 ? 'kero' : 'char' + scope;
}

let measureCtx;
/** Width of a character outside CP932 in the real font (for the advance rule's fallback). */
function measure(ch, font) {
  if (measureCtx === undefined) {
    measureCtx = null;
    try {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : hasDom() ? document.createElement('canvas') : null;
      measureCtx = c ? c.getContext('2d') : null;
    } catch (e) { measureCtx = null; }
  }
  if (!measureCtx) return 0;
  measureCtx.font = `${font.bold ? 'bold ' : ''}${font.height}px ${font.name}`;
  return measureCtx.measureText(ch).width;
}

export class Balloons extends Emitter {
  /**
   * @param {object} o
   * @param {BalloonSkin} [o.skin]
   * @param {object} [o.stage]          Stage (CONTRACTS): char(scope).rect/.balloonOffset, shell.descript, 'move' events
   * @param {object} [o.ghostFiles]     GhostFiles of the ghost root (\_b images)
   * @param {Map<string,string>} [o.ghostDescript]
   * @param {object} [o.state]          saveState() output (or a SUM §2.5 state with scopes[n].balloon)
   * @param {ShadowRoot|HTMLElement|null} [o.root]  default: the runtime's shadow root; null = headless
   * @param {{wordWrap?:boolean}} [o.options]
   * @param {number} [o.scale]          balloon scaling: CSS px per balloon image px (default 1, on a phone fitScale;
   *                                    setScale())
   * @param {object} [o.clock]          the views' tooltip rest timers (tests); default: real timers
   * @param {object} [o.tips]           TipBox (ui/tooltip.js); default: the page's
   * @param {{short:number, long:number, mobileView:boolean}} [o.phone]  phones only (core/phone.js); desktop: none
   * @param {Function} [o.onCanvasLost]  (kind): a canvas cannot draw (core/canvas.js): 'balloon' (a
   *   view's, BalloonView._build) or 'balloon image' (a \_b image's decode canvas); the runtime ends the ghost
   */
  static async create(o = {}) {
    return new Balloons(o);
  }

  constructor(o = {}) {
    super();
    this.skin = o.skin || BalloonSkin.fallback();
    this.stage = o.stage || null;
    this.descript = o.ghostDescript instanceof Map ? o.ghostDescript : new Map(Object.entries(o.ghostDescript || {}));
    this.onCanvasLost = typeof o.onCanvasLost === 'function' ? o.onCanvasLost : null;
    this._lost = null;
    this._destroyed = false;
    this.images =o.ghostFiles ? new ImageStore(o.ghostFiles, this.onCanvasLost ? { onCanvasLost: () => this._canvasLost('balloon image') } : {}) : null;
    this.root = o.root !== undefined ? o.root : hasDom() ? getRoot() : null;
    this.options = { wordWrap: true, ...(o.options || {}) };
    /** the user's balloon scaling (UI §2.1 #9): CSS px per image px of every balloon */
    this.scale = o.scale > 0 && Number.isFinite(o.scale) ? o.scale : 1;
    this.phone = o.phone || null;
    /** the phone default (balloonFit), CSS px per image px; null: none (desktop). A pick (o.scale) wins */
    this.fitScale = this.phone ? balloonFit(this.skin, this.phone) : null;
    if (this.fitScale !== null && !(o.scale > 0 && Number.isFinite(o.scale))) this.scale = this.fitScale;
    /** the user may drag balloons (ghost descript balloon.dontmove turns it off, UI §4.6) */
    this.movable = !truthy(this.descript.get('balloon.dontmove'));
    /** @type {Map<number, BalloonView>} */
    this.views = new Map();
    /** per-scope settings: {prefer, userOffset, align, offset} */
    this.prefs = new Map();
    this.order = [];
    this.clock = o.clock || null;
    this.tips = o.tips || null;
    /**
     * Tooltip texts (UI §4.8), set by the event loop: ({scope, kind, id, refs, label}) => Promise<string|null|undefined>
     * (null: no tip; undefined: not asked). None: no tips (a frozen tab).
     */
    this.tipSource = null;
    this._offs = [];
    this._stageOffs = [];     // the followed stage's 'move' / 'surface' listeners (setStage swaps them)
    this._skinEpoch = 0;      // setSkin() calls so far: a saved snapshot restored later is laid out again
    this._loadState(o.state);
    this._follow(this.stage);
    if (hasDom() && typeof window !== 'undefined') {
      const onResize = () => this.placeAll();
      window.addEventListener('resize', onResize);
      this._offs.push(() => window.removeEventListener('resize', onResize));
    }
  }

  /** Descript default \b id for a scope (SUM C15). */
  defaultKind(scope) {
    const v = this.descript.get(charName(scope) + '.balloon.defaultsurface') ?? this.descript.get('balloon.defaultsurface');
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** The balloon of a scope (created on first use). */
  get(scope) {
    scope = Math.max(0, Math.trunc(+scope) || 0);
    let v = this.views.get(scope);
    if (v) return v;
    v = new BalloonView({ scope, skin: this.skin, images: this.images, root: this.root, defaultKind: this.defaultKind(scope),
      wordWrap: this.options.wordWrap, measure, draggable: this.movable, scale: this.scale,
      ...(this.clock ? { clock: this.clock } : {}), ...(this.tips ? { tips: this.tips } : {}),
      ...(this.onCanvasLost ? { onCanvasLost: kind => this._canvasLost(kind) } : {}) });
    this.views.set(scope, v);
    this.order.push(scope);
    v.tipSource = item => (typeof this.tipSource === 'function' ? this.tipSource({ ...item, scope }) : undefined);
    v.on('link', info => this.emit('link', { ...info, scope }));
    v.on('select', ev => this.emit('select', { ...ev, scope }));
    v.on('click', ev => this.emit('click', { scope, button: ev ? ev.button : 0 }));
    v.on('dblclick', () => this.emit('dblclick', { scope }));
    v.on('hover', () => this.emit('hover', this.hovered));
    v.on('toggleside', () => this.toggleSide(scope));
    v.on('raise', () => this.raise(scope));
    v.on('drag', ev => this._drag(scope, ev && ev.kind, ev && ev.dx, ev && ev.dy));
    v.on('visibility', on => { if (on) { this.raise(scope); this.place(scope); } });
    v.on('image', () => { if (v.visible && !this._placing) this.place(scope); });
    const saved = this._saved && this._saved[scope];
    if (saved && saved.snapshot) {
      v.restore(saved.snapshot);
      if (this._skinEpoch) v.setSkin(this.skin);    // saved on the skin before a balloon change
    }
    return v;
  }

  /**
   * Balloon change (BA §12.2): every balloon is re-skinned in place (open ones stay open with their text and choices,
   * back on their default kind); sides, drag offsets and \![set,balloonoffset|balloonalign] are kept; all are placed
   * again. Balloon scaling is per ghost and stays (UI §2.9). On a phone fitScale is computed again for the new skin;
   * the caller applies it when the visitor picked no scaling (UserScaling.refit, ssp-ui.md §9.11).
   * @param {BalloonSkin} skin
   */
  setSkin(skin) {
    if (!skin) return;
    this.skin = skin;
    if (this.phone) this.fitScale = balloonFit(skin, this.phone);
    this._skinEpoch++;
    this._placing = true;     // one placement per balloon, after all are re-skinned
    try {
      for (const v of this.views.values()) {
        try { v.setSkin(skin); } catch (e) { log.error('balloon: re-skin failed', e); }
      }
    } finally {
      this._placing = false;
    }
    this.placeAll();
  }

  /**
   * Shell change (BA §12.3): follow another Stage's characters ('move' / 'surface'); the old one is no longer
   * listened to. Visible balloons are placed again.
   * @param {object|null} stage
   */
  setStage(stage) {
    this._follow(stage || null);
    this.placeAll();
  }

  _follow(stage) {
    for (const off of this._stageOffs) { try { off(); } catch (e) { /* ignore */ } }
    this._stageOffs = [];
    this.stage = stage;
    if (stage && typeof stage.on === 'function') {
      this._stageOffs.push(stage.on('move', ev => this.place(ev && ev.scope)));
      this._stageOffs.push(stage.on('surface', ev => this.place(ev && ev.scope)));
    }
  }

  /** Scopes that have a balloon object. */
  get scopes() { return [...this.views.keys()]; }

  /**
   * A scope's text-area numbers (BalloonModel#metrics; currentghost.balloon.scope(N).*, properties.md §5.7), its
   * balloon made on first use like any \p[N]. The caller keeps to the ghost's scopes.
   * @returns {import('../core/properties.js').BalloonMetrics|null}
   */
  metrics(scope) { return this.get(scope).metrics(); }

  /**
   * Script start (SS §4.3): reset script-lifetime state of every balloon; unless appending (\C), also clear, hide
   * and reset the balloon kind.
   */
  beginScript(append = false) {
    for (const v of this.views.values()) {
      v.resetFont();
      v.setNoWrap(false);
      v.setAutoscroll(true);
      v.showClickWait(false);
      if (!append) {
        v.clear();
        v.hide();
        v.resetKind();
      }
    }
  }

  /** Clear every balloon's content (after \x), keeping them visible. */
  clearAll() {
    for (const v of this.views.values()) { v.clear(); v.resetFont(); }
  }

  hideAll() {
    for (const v of this.views.values()) v.hide();
  }

  /** A canvas cannot draw (a view's or a \_b decode's; core/canvas.js): onCanvasLost(kind), once; none after destroy(). */
  _canvasLost(kind) {
    if (this._lost || this._destroyed || !this.onCanvasLost) return;
    this._lost = kind;
    try { this.onCanvasLost(kind); } catch (e) { log.error('balloon: canvas loss handler failed', e); }
  }

  /** A choice timeout: every balloon lets its selected item go first ('select' cause 'timeout', EV §4.7). */
  endSelections(cause = 'timeout') {
    for (const v of this.views.values()) v.endSelection(cause);
  }

  /** Pointer over any balloon (timeouts pause, SUM §2.4). */
  get hovered() {
    for (const v of this.views.values()) if (v.visible && v.hovered) return true;
    return false;
  }

  get anyVisible() {
    for (const v of this.views.values()) if (v.visible) return true;
    return false;
  }

  /**
   * Status `choosing` (EV §1.6) [disasm AddStatusText 0x639ad8–0x639b09]: some balloon, shown or not, holds a choice
   * item (GetSelectModeAll 0x649540 ORs every balloon's content flags; bit 0x10000 from AddSelectableString 0x5cdc0e
   * (\q) and AddAnchorOrSelectable 0x5ce044 (\__q); \_a sets 0x20000), and some balloon is up (IsBalloonVisible
   * 0x63e240).
   */
  get choosing() {
    let items = false;
    for (const v of this.views.values()) if (v.hasChoices) { items = true; break; }
    return items && this.anyVisible;
  }

  /** [scope, kind] of each visible balloon (for the Status header's balloon(...) part). */
  visibleKinds() {
    return [...this.views.values()].filter(v => v.visible).map(v => [v.scope, v.kind]);
  }

  /** Start loading the \_b images of a script before it plays (optional; avoids layout jumps). */
  prefetch(script) {
    return this.images ? this.images.prefetch(scanImagePaths(script)) : Promise.resolve();
  }

  _pref(scope) {
    let p = this.prefs.get(scope);
    if (!p) { p = { prefer: null, userOffset: null, align: null, offset: null }; this.prefs.set(scope, p); }
    return p;
  }

  /** Right click: switch this balloon to the other side of its character. */
  toggleSide(scope) {
    const v = this.views.get(scope);
    if (!v) return;
    const p = this._pref(scope);
    p.prefer = v.side === 'left' ? 'right' : 'left';
    this.place(scope);
    this.emit('state');
  }

  /** \![set,balloonoffset,x,y] ('@' = relative to the shell value). Empty arguments reset. */
  setOffset(scope, xs, ys) {
    const parse = s => {
      const t = String(s ?? '').trim();
      if (!t) return null;
      const rel = t[0] === '@';
      const n = parseInt(rel ? t.slice(1) : t, 10);
      return Number.isFinite(n) ? { rel, v: n } : null;
    };
    const x = parse(xs), y = parse(ys);
    this._pref(scope).offset = x || y ? { x, y } : null;
    this.place(scope);
    this.emit('state');
  }

  /** \![set,balloonalign,mode]: left | right | center | top | bottom | none. */
  setAlign(scope, mode) {
    const m = String(mode ?? '').trim().toLowerCase();
    this._pref(scope).align = ['left', 'right', 'center', 'top', 'bottom'].includes(m) ? m : null;
    this.place(scope);
    this.emit('state');
  }

  /**
   * Balloon scaling (menu Balloon scaling ▸, UI §2.1 #9): every balloon (text, choices, \_b images, arrows, click-wait)
   * is drawn at `s` CSS px per image px, crisp (view.js), and placed again. Input and communicate boxes keep their size.
   */
  setScale(s) {
    s = Number(s);
    if (!(s > 0) || !Number.isFinite(s) || s === this.scale) return;
    this.scale = s;
    for (const v of this.views.values()) v.setScale(s);
    this.placeAll();
  }

  /**
   * devicePixelRatio changed while the CSS scale did not (no choice, or a monitor change): every balloon redraws its
   * canvases at the new resolution now, so one left waiting (a choice menu, a click-wait) does not stay blurry.
   */
  refreshResolution() {
    for (const v of this.views.values()) if (typeof v.refreshResolution === 'function') v.refreshResolution();
  }

  raise(scope) {
    const i = this.order.indexOf(scope);
    if (i >= 0 && i === this.order.length - 1) return;
    if (i >= 0) this.order.splice(i, 1);
    this.order.push(scope);
    this.order.forEach((s, z) => { const v = this.views.get(s); if (v) v.setZ(z); });
  }

  /** Recompute where a scope's balloon goes (character moved, surface or balloon size changed, viewport resized). */
  place(scope) {
    if (scope === undefined || scope === null) { this.placeAll(); return; }
    const v = this.views.get(scope);
    if (!v || !v.visible) return;
    const input = this._placement(scope, v);
    if (!input) return;
    const res = placeBalloon(input);
    const side = res.side === 'right' ? 'right' : 'left';
    if (side !== v.side && !this._placing) {
      const w = v.width, h = v.height;
      this._placing = true;
      try {
        v.setSide(side);
        if (v.width !== w || v.height !== h) { this.place(scope); return; } // the other image has another size
      } finally {
        this._placing = false;
      }
    }
    v.moveTo(res.x, res.y);
    v.placed = true;
    // an automatic switch sticks like a right click (SSP keeps one isleft per character): a balloon moved to the right
    // goes back left only once the right side cuts it off [observed]. Only against the character's real rect: one made
    // against a 0×0 stand-in (size not known yet, hidden and never placed) would overwrite the saved side (UI §4.1).
    const p = this._pref(scope), fixed = String(input.align || '').trim().toLowerCase();
    const real = input.char.width > 0 || input.char.height > 0;
    if (real && fixed !== 'left' && fixed !== 'right' && (res.side === 'left' || res.side === 'right') && p.prefer !== v.side) {
      p.prefer = v.side;
      this.emit('state');
    }
  }

  /**
   * The viewport balloons are placed in: the layout viewport; on a phone the stage's desk(), the fixed containing
   * block the characters stand in, which follows the browser's bars (ssp-ui.md §9.11) [decision].
   */
  _viewport() {
    if (this.phone && this.stage && typeof this.stage.desk === 'function') {
      const d = this.stage.desk();
      if (d && d.w > 0 && d.h > 0) return { width: d.w, height: d.h };
    }
    return viewport();
  }

  /** placeBalloon() input for a scope's balloon, or null when it stays where it is (hidden character, SS §5.2). */
  _placement(scope, v) {
    const vp = this._viewport();
    let rect = null, offset = { x: 0, y: 0 }, shellAlign = null;
    try {
      const ch = this.stage && this.stage.char ? this.stage.char(scope) : null;
      if (ch) {
        rect = ch.rect || null;
        offset = ch.balloonOffset || offset;
      }
      const d = this.stage && this.stage.shell && this.stage.shell.descript;
      if (d && d.get) shellAlign = d.get(charName(scope) + '.balloon.alignment') ?? (scope >= 2 ? d.get('kero.balloon.alignment') : null);
    } catch (e) {
      log.once('balloon:place:' + scope, 'balloon: cannot read the character position', e);
    }
    if (!rect || (!rect.width && !rect.height)) {
      // hidden character (\s[-1]) or one without a surface yet: the balloon stays where it was (SS §5.2);
      // a balloon never placed goes against the character's position point
      if (v.placed) return null;
      if (!rect || (!rect.x && !rect.y)) rect = { x: vp.width - 200, y: vp.height - 300, width: 0, height: 0 };
    }
    const p = this._pref(scope);
    if (p.offset) {
      const ax = p.offset.x, ay = p.offset.y;
      offset = { x: ax ? (ax.rel ? offset.x + ax.v : ax.v) : offset.x, y: ay ? (ay.rel ? offset.y + ay.v : ay.v) : offset.y };
    }
    // the offset is in shell px: it grows with the shell scaling; windowposition is in balloon px [guess]
    const ks = this.stage && this.stage.scale > 0 && Number.isFinite(this.stage.scale) ? this.stage.scale : 1;
    if (ks !== 1) offset = { x: offset.x * ks, y: offset.y * ks };
    const geo = v.img ? v.img.geo : null;
    let wp = geo ? geo.windowPosition : undefined;
    if (wp && v.scale !== 1) wp = { ...wp, x: typeof wp.x === 'number' ? wp.x * v.scale : wp.x, y: (wp.y || 0) * v.scale };
    const r = v.rect;
    return {
      char: rect, size: { w: r.width, h: r.height }, offset, align: p.align || shellAlign || 'none', prefer: p.prefer,
      windowPosition: wp, userOffset: p.userOffset, viewport: vp, ...(this.phone ? { overhead: true } : {}),
    };
  }

  /**
   * The user drags a balloon (view 'drag' events; dx/dy = pointer travel since the press, viewport px). The balloon
   * follows the pointer, clamped to the viewport, and the result is kept as the scope's user offset from its computed
   * place (BA §4 userDragOffset), so it keeps following its character, survives side flips and \b[n] changes, and is
   * saved with the balloon state.
   */
  _drag(scope, kind, dx = 0, dy = 0) {
    const v = this.views.get(scope);
    if (!v) return;
    if (kind === 'start') {
      this._dragFrom = { scope, x: v.x, y: v.y };
      this.raise(scope);
      return;
    }
    const f = this._dragFrom;
    if (!f || f.scope !== scope) return;
    const vp = this._viewport();
    const size = v.rect;
    const x = Math.round(Math.max(0, Math.min(f.x + (+dx || 0), vp.width - size.width)));
    const y = Math.round(Math.max(0, Math.min(f.y + (+dy || 0), vp.height - size.height)));
    const input = v.visible ? this._placement(scope, v) : null;
    if (input) {
      // the place without any user offset and without the viewport clamp: offset = where it is now - that place
      const base = placeBalloon({ ...input, userOffset: null, windowPosition: { ...(input.windowPosition || {}), limit: false } });
      this._pref(scope).userOffset = x === base.x && y === base.y ? null : { x: x - base.x, y: y - base.y };
    }
    v.moveTo(x, y);
    v.placed = true;
    if (kind === 'end') {
      this._dragFrom = null;
      this.emit('state');
    }
  }

  /** Forget every balloon's drag offset (menu "Reset position"): they go back next to their characters. */
  resetOffsets() {
    let changed = false;
    for (const p of this.prefs.values()) {
      if (p.userOffset) { p.userOffset = null; changed = true; }
    }
    this._dragFrom = null;
    this.placeAll();
    if (changed) this.emit('state');
  }

  placeAll() {
    for (const s of this.views.keys()) this.place(s);
  }

  /**
   * Per-scope balloon state for persistence: {kind, side, userOffset, alignOverride, offsetOverride} (SUM §2.5);
   * with {content:true} also a snapshot of each visible balloon's content.
   */
  saveState({ content = false } = {}) {
    const out = {};
    const scopes = new Set([...this.views.keys(), ...this.prefs.keys()]);
    for (const s of scopes) {
      const v = this.views.get(s), p = this._pref(s);
      out[s] = {
        kind: v ? v.kind : this.defaultKind(s), side: p.prefer, userOffset: p.userOffset ? [p.userOffset.x, p.userOffset.y] : [0, 0],
        alignOverride: p.align, offsetOverride: p.offset,
      };
      if (content && v && v.visible) out[s].snapshot = v.snapshot();
    }
    return out;
  }

  _loadState(state) {
    if (!state || typeof state !== 'object') return;
    const per = state.scopes ? Object.fromEntries(Object.entries(state.scopes).map(([k, v]) => [k, v && v.balloon])) : state;
    this._saved = {};
    for (const [k, b] of Object.entries(per)) {
      const s = parseInt(k, 10);
      if (!Number.isFinite(s) || !b || typeof b !== 'object') continue;
      const p = this._pref(s);
      if (b.side === 'left' || b.side === 'right') p.prefer = b.side;
      if (Array.isArray(b.userOffset) && (b.userOffset[0] || b.userOffset[1])) p.userOffset = { x: +b.userOffset[0] || 0, y: +b.userOffset[1] || 0 };
      if (typeof b.alignOverride === 'string') p.align = b.alignOverride;
      if (b.offsetOverride && typeof b.offsetOverride === 'object') p.offset = b.offsetOverride;
      this._saved[s] = b;
    }
  }

  destroy() {
    this._destroyed = true;
    for (const off of [...this._offs, ...this._stageOffs]) { try { off(); } catch (e) { /* ignore */ } }
    this._offs = [];
    this._stageOffs = [];
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
  }
}

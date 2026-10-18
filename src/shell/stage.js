// Stage: the shell of one ghost on the page — per-scope CharacterViews, dress-up state, persistence, the frame loop
// (CONTRACTS "Shell"). Emits 'mouse' (MouseInfo), 'surface' {scope,id,width,height},
// 'bind' {scope,id,category,part,on,noEvent,origin?} (noEvent: \![bind-noevent], no OnDressupChanged; origin
// 'user' | 'script' only when the caller gave one, e.g. a dress-up menu pick),
// 'move' {scope, reason} whenever a character's on-screen rect changes,
// 'drop' {scope, files: File[], x, y (surface coords)} when files are dropped on a character (EV §4.14); characters
// take file drags only while stage.acceptsDrops is true (set by whoever receives 'drop').
// Menu seams: dressupMenu(scope) (Clothes/Dressup ▸, SH §4.3.1), setBind(scope, id, on, {origin}), carry(scope)
// ("Move character window", SH §6.7) and `carrying` while one is open.
// Collision tooltips (UI §4.8): `tipSource` (set by the event loop) gives a rest's text; `tips` is the box they show in.
import { log } from '../core/log.js';
import { Emitter } from '../core/emitter.js';
import { getRoot, addStyle, Z_BASE } from '../ui/root.js';
import { tipBox } from '../ui/tooltip.js';
import { parseShell, sortSurfaceFiles, scopeName } from './surfaces.js';
import { ImageCache } from './images.js';
import { BindState } from './dressup.js';
import { CharacterView } from './character.js';
import { SurfaceRenderer } from './render.js';
import { defaultPlace, toRatio, rectAt, snap, phoneFit } from './layout.js';
import { currentDpr } from '../core/scaling.js';

// -webkit-touch-callout: no iOS callout on a long press (the menu's gesture; UI §9.11 F6)
const CSS = `
.smk-char{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;}
.smk-surface{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:auto;touch-action:none;
  user-select:none;-webkit-user-select:none;-webkit-user-drag:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;outline:none;}
`;

// Phones only (UI §9.11) [decision]: documentElement.clientHeight keeps the browser bar's height when the bar hides on
// scroll, while fixed content (the host the characters are placed in, root.js) follows the visible bottom [verify].
// A phone stage's desk is the fixed containing block instead, measured by one hidden fixed probe per page in the
// shadow root, made on first use.
let probe = null;
function fixedDesk() {
  if (!probe || !probe.isConnected) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;visibility:hidden;pointer-events:none;';
    getRoot().appendChild(probe);
  }
  const w = probe.clientWidth, h = probe.clientHeight;
  return w > 0 && h > 0 ? { w, h } : null;
}

/** real name of the folder `shell/<id>/` (case-insensitive), or null when it holds no file */
function shellDir(files, id) {
  const first = files.list(`shell/${id}`)[0];
  return first ? first.split('/')[1] : null;
}

/** the first folder (ordinal, case-insensitive) with a `shell/<dir>/descript.txt`, or null */
function firstShellDir(files) {
  const dirs = [];
  for (const p of files.list('shell')) {
    const m = /^shell\/([^/]+)\/descript\.txt$/i.exec(p);
    if (m) dirs.push(m[1]);
  }
  dirs.sort((a, b) => { const A = a.toLowerCase(), B = b.toLowerCase(); return A < B ? -1 : A > B ? 1 : 0; });
  return dirs[0] || null;
}

function browserClock() {
  return {
    now: () => performance.now(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: id => clearTimeout(id),
    requestFrame: f => requestAnimationFrame(f),
  };
}

/**
 * @typedef {{v:number, shell:string, scopes: Object<string, {surface:number, pos:{rx:number,ry:number}|null,
 *   binds:number[], visible:boolean, align:string|null, scaling:number[], alpha:number}>}} StageState
 */

/** a bind group's thumbnail field as a dress-up menu entry's `thumbnail`, when it has one */
const thumbOf = g => (g && g.thumbnail ? { thumbnail: String(g.thumbnail) } : {});

export class Stage extends Emitter {
  /**
   * @param {{files: import('../core/loader.js').GhostFiles, shellId?: string, ghostDescript?: Map<string,string>,
   *          state?: StageState, dom?: boolean, decode?: Function, clock?: object, random?: () => number,
   *          desk?: {w:number,h:number}, scale?: number, root?: Element|null}} opts
   *   dom: false runs headless (no elements, frames only through stage.tick(now)); default: true when a document exists.
   *   decode: image decoder override (tests).
   *   root: where the characters' elements go (the ghost's layer, ui/layers.js, with several ghosts; UI §9.1); none:
   *   the runtime's shadow root (getRoot()).
   *   The stage's shellId is the folder actually loaded (its real case): the requested one, else `master`, else the
   *   first `shell/<dir>/descript.txt` in folder order; the requested id only when the ghost has no shell at all.
   */
  static async create(opts) {
    const { files } = opts;
    let shellId = opts.shellId || 'master';
    let dir = shellDir(files, shellId);
    if (!dir) {
      dir = shellDir(files, 'master') || firstShellDir(files);
      log.once('shell:noshell:' + shellId, `shell: no shell folder "shell/${shellId}"; ${dir ? `loading shell/${dir}` : 'the ghost has no shell'}`);
    }
    if (dir) shellId = dir;
    const shellFiles = dir ? files.sub(`shell/${dir}`) : null;
    let descript = '', surfaces = [], names = [];
    if (shellFiles) {
      names = shellFiles.list('');
      const top = names.filter(n => !n.includes('/'));
      const surfNames = sortSurfaceFiles(top.filter(n => /^surfaces.*\.txt$/i.test(n)));
      const alias = top.filter(n => /^alias\.txt$/i.test(n));
      const texts = await Promise.all([
        shellFiles.textOrNull('descript.txt'),
        ...[...surfNames, ...alias].map(n => shellFiles.text(n).catch(e => { log.once('shell:read:' + n, 'shell: cannot read', n, e && e.message); return ''; })),
      ]);
      descript = texts[0] || '';
      surfaces = [...surfNames, ...alias].map((name, i) => ({ name, text: texts[i + 1] }));
    }
    const t0 = Date.now();
    const shell = parseShell({ descript, surfaces, files: names });
    log.debug(`shell: parsed ${surfaces.length} files, ${shell.stats.blocks} blocks in ${Date.now() - t0} ms`);
    return new Stage({ ...opts, shell, shellFiles, shellId });
  }

  /**
   * Prefer Stage.create(). The constructor takes an already parsed shell.
   * @param {{shell: import('./surfaces.js').Shell, shellFiles: object, shellId?: string, ghostDescript?: Map<string,string>,
   *          state?: StageState, dom?: boolean, decode?: Function, clock?: object, random?: () => number,
   *          desk?: {w:number,h:number}, scale?: number, images?: ImageCache, root?: Element|null,
   *          tips?: import('../ui/tooltip.js').TipBox, phone?: {short:number, long:number, mobileView:boolean}}} o
   *   tips: default the page's box (tipBox()).
   *   phone: given on phones only (core/phone.js; UI §9.11): the default scale is the shell's fit (fitScale) unless
   *   `scale` (a visitor's pick) is given, and the desk is the fixed containing block (fixedDesk). Without it the
   *   stage is a desktop one.
   */
  constructor(o) {
    super();
    /**
     * Called once, (kind, stage), when a canvas of this stage cannot draw (core/canvas.js): 'character'
     * (a character canvas got no 2D context or no backing store) or 'shell image' (a decode canvas got none). The
     * runtime ends the ghost. None (the default): it is only recorded in `lost`.
     */
    this.onCanvasLost = typeof o.onCanvasLost === 'function' ? o.onCanvasLost : null;
    /** the first canvasLost kind, or null */
    this.lost = null;
    /** the box collision tips show in */
    this.tips = o.tips || tipBox();
    /**
     * Collision tooltip texts (UI §4.8), set by the event loop: ({scope, collision, x, y (surface px), fresh,
     * device}) => Promise<string|null|undefined> (null: no tip; undefined: not asked). None: no tips (a frozen tab).
     */
    this.tipSource = null;
    this.shell = o.shell;
    this.shellId = o.shellId || 'master';
    this.shellFiles = o.shellFiles || null;
    this.ghostDescript = o.ghostDescript || new Map();
    this.dom = o.dom !== undefined ? !!o.dom : typeof document !== 'undefined';
    /** the element the characters are mounted in (the ghost's layer); null: getRoot() */
    this.root = o.root || null;
    this.clock = o.clock || (this.dom ? browserClock() : { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: id => clearTimeout(id) });
    this.random = o.random || Math.random;
    this.scale = o.scale > 0 && Number.isFinite(o.scale) ? o.scale : 1;   // CSS px per image px: the user's shell scaling (setScale)
    this._desk = o.desk || { w: 1280, h: 720 };
    const d = this.shell.descript;
    const paint = d.get('seriko.paint_transparent_region_black');
    this.images = o.images || new ImageCache({
      files: o.shellFiles || { has: () => false, resolve: () => null, bytes: () => Promise.reject(new Error('no shell')) },
      decode: o.decode,
      alpha: { useSelfAlpha: d.get('seriko.use_self_alpha'), paintBlack: paint === undefined ? null : paint.trim() === '1' || /^true$/i.test(paint.trim()) },
      onCanvasLost: () => this.canvasLost('shell image'),
    });
    /** {short, long, mobileView} on phones (UI §9.11); null: a desktop stage */
    this.phone = o.phone || null;
    /**
     * The phone default of Shell scaling (layout.js phoneFit) for this shell, CSS px per image px; null: none (always
     * off a phone). Computed once, here, where the sizes are known and nothing is placed yet; never stored.
     */
    this.fitScale = null;
    if (this.phone) {
      const f = phoneFit(this._fitSizes(), this.phone, currentDpr());
      if (f) this.fitScale = f.scale;
      if (this.fitScale !== null && !(o.scale > 0 && Number.isFinite(o.scale))) this.scale = this.fitScale;
    }
    /** @type {Map<number, CharacterView>} */
    this._views = new Map();
    this._binds = new Map();
    this._z = [];
    this._rafPending = false;
    this._timer = null;
    this._destroyed = false;
    this._dressCache = null;
    this._urls = new Map();
    this._carry = null;           // the open carry() ("Move character window"), if any
    /** stored places {rx, ry} of \p[n] windows not made yet (UI §3.3): char() applies one when it makes the window */
    this._places = new Map();
    /** someone receives 'drop' (the booted event loop, the runtime while booting or frozen): file drags are taken */
    this.acceptsDrops = false;
    /** setVeiled(): nothing is drawn, whatever each character's show/hide state (a cold boot before its script) */
    this.veiled = false;
    if (this.dom) {
      addStyle('shell', CSS);
      this._onResize = () => { for (const v of this._views.values()) v._relayout(); };
      this._onVisible = () => { if (!document.hidden) this._requestFrame(); };
      window.addEventListener('resize', this._onResize);
      document.addEventListener('visibilitychange', this._onVisible);
    }
    if (o.state && o.state.scopes) this._restore(o.state);
    for (const s of [0, 1]) if (!this._views.has(s)) this.char(s).setSurface(this.defaultSurface(s));
  }

  /** seriko.defaultsurface for a scope (descript_ghost defaults: sakura 0, others 10) */
  defaultSurface(scope) {
    const k = scopeName(scope) + '.seriko.defaultsurface';
    const v = this.shell.descript.get(k) ?? this.ghostDescript.get(k);
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : scope === 0 ? 0 : 10;
  }

  now() { return this.clock.now(); }

  /**
   * phoneFit's sizes: the base rects of \0's and \1's default surfaces (image px; never the stored or current ones,
   * which change from page to page), known before decoding from the manifest's PNG sizes. null while \0's is unknown
   * (no fit); \1 missing or unsized counts 0 (UI §9.11).
   */
  _fitSizes() {
    const r = new SurfaceRenderer(this.shell, this.images);
    const r0 = r.baseRect(this.defaultSurface(0)), r1 = r.baseRect(this.defaultSurface(1));
    if (!r0 || !(r0.w > 0) || !(r0.h > 0)) return null;
    return { w0: r0.w, h0: r0.h, w1: r1 ? r1.w : 0, h1: r1 ? r1.h : 0 };
  }

  /** the "desktop": the layout viewport without scrollbars; on phones the fixed containing block (fixedDesk) */
  desk() {
    if (this.dom) {
      if (this.phone) { const f = fixedDesk(); if (f) return f; }
      const de = document.documentElement;
      return { w: de.clientWidth || window.innerWidth, h: de.clientHeight || window.innerHeight };
    }
    return this._desk;
  }

  /** headless: change the desk size and re-layout (the DOM path listens to window resize) */
  setDesk(w, h) { this._desk = { w, h }; for (const v of this._views.values()) v._relayout(); }

  /** CharacterView for a scope, created on first use (scope 0 sakura, 1 kero, 2+ \p[n]); hidden until a surface is set. */
  char(scope) {
    scope = scope | 0;
    let v = this._views.get(scope);
    if (v) return v;
    v = new CharacterView(this, scope);
    this._views.set(scope, v);
    this._z.push(scope);
    this._applyZ();
    v.on('mouse', info => this.emit('mouse', info));
    v.on('surface', e => this.emit('surface', e));
    v.on('move', e => this.emit('move', e));
    v.on('drop', e => this.emit('drop', e));
    if (scope >= 2) {
      // \p[n] windows exist at their default surface and position, hidden until a script sets a surface (SUM §2.6);
      // a place stored for the scope wins over the default once it is shown (SSP's Char<n>.ratio, UI §3.3)
      const p = this._places.get(scope);
      if (p) { this._places.delete(scope); v.setRatio(p); }
      v._autoShow = true;
      v._shown = false;
      v._implicit = true;
      v.setSurface(this.defaultSurface(scope));
      v._implicit = false;
    }
    return v;
  }

  /**
   * Keep every character out of sight without changing its state: placed, on its surface, `visible` and saved as
   * shown, but not drawn and not hit. A cold boot veils its characters until the boot script starts (EV §2.1 #24).
   */
  setVeiled(on) {
    on = !!on;
    if (on === this.veiled || (!on && this.lost)) return;     // a stage that lost a canvas stays veiled (canvasLost)
    this.veiled = on;
    if (on) for (const v of this._views.values()) v.hideTip();
    for (const v of this._views.values()) { v._updateDom(); if (!on) v.invalidate(); }
  }

  /** existing views' scopes, ascending */
  get scopes() { return [...this._views.keys()].sort((a, b) => a - b); }

  has(scope) { return this._views.has(scope); }

  /**
   * dress-up state of a scope (exists even without a view); groups in definition order (the category rules), the
   * menu's order for the part a \![bind] by name reaches
   */
  bindState(scope) {
    let b = this._binds.get(scope);
    if (!b) {
      b = new BindState(this.shell.bindGroupsInFileOrder(scope), this.shell.bindOptions(scope), this.shell.dressupMenu(scope));
      this._binds.set(scope, b);
    }
    return b;
  }

  /**
   * @param {{noEvent?: boolean, origin?: 'user'|'script'}} [opts] noEvent: \![bind-noevent] (listeners send no
   *   OnDressupChanged); origin: OnDressupChanged R4, carried on the 'bind' events when given
   */
  _bindChanged(scope, changes, opts = {}) {
    if (!changes.length) return;
    this._dressCache = null;
    const v = this._views.get(scope);
    if (v) v._bindsChanged(this.bindState(scope).drawChanges);
    const noEvent = !!(opts && opts.noEvent);
    const origin = opts && opts.origin;
    for (const c of changes) {
      const e = { scope, id: c.id, category: c.category, part: c.part, on: c.on, noEvent };
      if (origin) e.origin = origin;
      this.emit('bind', e);
    }
  }

  /**
   * Switch one bind group (the Clothes/Dressup ▸ menu: on undefined toggles, origin 'user'). The category rules apply
   * (SH §4.3); the changes come back and go out as 'bind' events, off first.
   * @param {{noEvent?: boolean, origin?: 'user'|'script'}} [opts]
   * @returns {import('./dressup.js').BindChange[]}
   */
  setBind(scope, id, on, opts = {}) {
    const changes = this.bindState(scope).set(id, on);
    this._bindChanged(scope, changes, opts);
    return changes;
  }

  /**
   * What Clothes/Dressup ▸ shows for a scope (SH §4.3.1; SSP UpdateBindMenu / GetBindPropCharEnable [disasm]).
   * enabled is false without bind groups, in hidden mode, and in manual mode without any menuitem line.
   * Manual entries follow the menuitem records: {type:'part', id, category, part, on} | {type:'sep'} |
   * {type:'menu', name, entries}. Auto entries are categories in bindCategoryOrder: {type:'category', category, on,
   * parts: [{id, part, on}]}, the category's `on` meaning one of its parts is worn (the menu puts the categories with
   * 2+ parts first, as submenus). `on` is the part's own flag (worn), not addid drawing. A part whose bind group names
   * a thumbnail carries it as `thumbnail` (as written: the menu looks it up, UI §2.14).
   * @returns {{mode:'manual'|'auto'|'hidden', enabled:boolean, entries:object[]}}
   */
  dressupMenu(scope) {
    scope = scope | 0;
    const sh = this.shell, mode = sh.dressupMode(scope);
    if (!sh.bindGroups(scope).length || mode === 'hidden') return { mode, enabled: false, entries: [] };
    const b = this.bindState(scope);
    if (mode === 'auto') {
      const entries = [];
      for (const category of sh.bindCategoryOrder(scope)) {
        const parts = (b.byCategory.get(category) || []).map(g => ({ id: g.id, part: g.part, on: b.isWorn(g.id), ...thumbOf(g) }));
        if (parts.length) entries.push({ type: 'category', category, on: parts.some(p => p.on), parts });
      }
      return { mode, enabled: true, entries };
    }
    const conv = list => list.map(x => {
      if (x === '-') return { type: 'sep' };
      if (typeof x === 'object') return { type: 'menu', name: x.menu, entries: conv(x.items) };
      const g = b.byId.get(x);
      return { type: 'part', id: x, category: g.category, part: g.part, on: b.isWorn(x), ...thumbOf(g) };
    });
    return { mode, enabled: sh.hasMenuItems(scope), entries: conv(sh.dressupMenu(scope)) };
  }

  /** absolute URL of a file in the shell folder (cursor files, SH §2.16); null when there is no such file */
  fileUrl(path) {
    let u = this._urls.get(path);
    if (u !== undefined) return u;
    const f = this.shell.resolveFile(path);
    const files = this.shellFiles;
    u = f && files && typeof files.url === 'function' && files.has(f) ? files.url(f) : null;
    if (!u) log.once('shell:nofile:' + path, 'shell: missing file', path);
    this._urls.set(path, u);
    return u;
  }

  /**
   * OnNotifyDressupInfo references (EV §4.11, SH §4.3.2): scope-major, then categories in Shell.bindCategoryOrder,
   * then parts in definition order: `scope\x01category\x01part\x01options\x01on\x01thumbnail` (options from
   * `default`, `mustselect`, `multiple`; the thumbnail only when the shell has that file). Cached per bind state.
   * @returns {string[]}
   */
  dressupRefs() {
    const scopes = this.shell.bindScopes();
    const key = scopes.map(s => this.bindState(s).version).join(',');
    if (this._dressCache && this._dressCache.key === key) return this._dressCache.refs;
    const refs = [];
    const files = this.shellFiles;
    const hasFile = name => !!(files && typeof files.has === 'function' && files.has(name));
    for (const s of scopes) for (const r of this.bindState(s).info(s, { order: this.shell.bindCategoryOrder(s), hasFile })) refs.push(r);
    this._dressCache = { key, refs, text: null };
    return refs;
  }

  /** The same references as one string, one Reference per line (CRLF-separated); split it to get the list. */
  dressupInfo() {
    const refs = this.dressupRefs();
    if (this._dressCache.text === null) this._dressCache.text = refs.join('\r\n');
    return this._dressCache.text;
  }

  /** \e reached: 'yen-e' animations of every view */
  scriptEnd() { for (const v of this._views.values()) v.onScriptEnd(); }

  // ---------------------------------------------------------------- layout

  /**
   * First placement of a view whose geometry just became known: its stored place, else its default place (UI §3.2,
   * layout.js defaultPlace). The default stands against the nearest lower scope that has a window, so while that
   * one's size is still loading the view stays unplaced (and not shown); _flushPlacement() places it once the size
   * arrives.
   */
  _placeNew(view) {
    if (view._ratio) { view._anchor = view._fromRatio(); return; }
    const a = this._defaultAnchor(view);
    if (a) {
      view._anchor = a;
      view._ratio = toRatio(view._eff(), this.desk());
    }
  }

  /** place the views whose first placement waited for a lower scope's size, lowest scope first */
  _flushPlacement() {
    for (const s of this.scopes) {
      const v = this._views.get(s);
      if (v._anchor || !v._geom || v._autoShow || v.surfaceId < 0) continue;
      this._placeNew(v);
      if (v._anchor) { v._place(); v._emitMove('layout'); }
    }
  }

  /**
   * Where a view's default place is now (not applied; layout.js defaultPlace): against the nearest lower scope that
   * has a window, by scope index [disasm GetDefaultWndPosX/Y]. Hidden by \s[-1]: with the size it was last shown with.
   * null while its own size or that scope's is loading, or when it was never sized.
   */
  _defaultAnchor(view) {
    const g = view._layoutGeom();
    if (!g) return null;
    let below = null;
    for (const j of this.scopes.filter(k => k < view.scope).reverse()) {
      const st = this._standing(j);
      if (st === null) return null;
      if (st) { below = st; break; }
    }
    return defaultPlace(this._placeItem(view, g), below, this.desk());
  }

  /** a view with geometry g as defaultPlace takes it: alignment, defaultleft / defaulttop (shell, then ghost) */
  _placeItem(v, g) {
    const s = v.scope;
    const num = k => parseInt(v.shell.scopeValue(s, k) ?? this.ghostDescript.get(`${scopeName(s)}.${k}`), 10);
    return { scope: s, g, align: v.alignment, defaultLeft: num('defaultleft'), defaultTop: num('defaulttop') };
  }

  /**
   * Scope j as a higher scope's default place reads it [disasm GetDefaultWndPosXFromCharIndex 0x41DB30, …Y… 0x41DCE0]:
   * {left: its defaultleft, else its window's left now; baseY: its defaulttop's base point, else its base point now}.
   * Its window is where it stands (docked, without animation offsets), or where its own default puts it while it was
   * never placed (a \p[n] not shown yet). Hidden by \s[-1], it is still a window [disasm GetExtentCharVirtual 0x6E9DB0
   * succeeds for any scope that has an animation], with the size it was last shown with: where it stands, else at its
   * stored ratio, else at its default place.
   * undefined: no window to stand against (no view, or never sized); null: its size is still loading.
   */
  _standing(j) {
    const v = this._views.get(j);
    if (!v) return undefined;
    const g = v._layoutGeom();
    if (!g) return v.surfaceId >= 0 && !v._autoShow ? null : undefined;
    const it = this._placeItem(v, g);
    const a = v._anchor ? snap(v._anchor, g, it.align, this.desk()) : v._ratio ? v._fromRatio(g) : this._defaultAnchor(v);
    if (!a) return null;
    return {
      left: Number.isFinite(it.defaultLeft) ? it.defaultLeft : rectAt(a, g).x,
      baseY: Number.isFinite(it.defaultTop) ? it.defaultTop + (g.bp.y - g.rect.y) * g.sy : a.y,
    };
  }

  /**
   * Reset shell position (UI §3.2; SSP OnMenuResetpos → UpdateAllWndPos(0x23) [disasm]): each character goes to its
   * default place, lowest scope first, so each stands against the new place of the one below it. One hidden by \s[-1]
   * moves too, with the size it was last shown with (UpdateAllWndPos checks no visibility); one still loading is placed
   * once its size arrives, one never sized when it is shown. The stored places forgotten are those up to the highest
   * scope that has a window: a \p[n] above it keeps its place for when it is made [disasm OnMenuResetpos 0x49B57F
   * deletes Char0 … Char<n> of the highest \p[n] window made, CreateCharacter 0x49C3AF].
   */
  resetPositions() {
    const top = Math.max(...this.scopes);
    for (const s of [...this._places.keys()]) if (s <= top) this._places.delete(s);
    for (const s of this.scopes) {
      const v = this._views.get(s);
      v._anchor = null;
      v._ratio = null;
      const a = this._defaultAnchor(v);
      if (a) v._placeAt(a);
    }
  }

  /**
   * The user's shell scaling (menu Shell scaling ▸, UI §2.1 #8): `s` CSS px per image px for every character;
   * \![set,scaling] multiplies on top (CharacterView._k). Each character grows or shrinks about its base point and
   * stays docked; one standing against the desk's left or right edge stays against it (the first-boot corner); one
   * that was wholly on the desk is kept wholly on it, any other keeps a corner in view (UI §3.3) [infer].
   */
  setScale(s) {
    s = Number(s);
    if (!(s > 0) || !Number.isFinite(s) || s === this.scale) return;
    const desk = this.desk();
    const e = 2;     // docking, the first-boot layout and ratios restored at another width land on the edges, roughly
    const fits = new Map();
    for (const [scope, v] of this._views) {
      if (!v._geom || !v._anchor) continue;
      const r = rectAt(v._eff(), v._geom);
      const left = Math.abs(r.x) <= e, right = Math.abs(r.x + r.width - desk.w) <= e;
      fits.set(scope, { left, right, inside: r.x >= -e && r.y >= -e && r.x + r.width <= desk.w + e && r.y + r.height <= desk.h + e });
    }
    this.scale = s;
    for (const [scope, v] of this._views) v._rescale(fits.get(scope) || {}, desk);
  }

  /** devicePixelRatio changed while the scale did not: the characters pick their image-rendering again (surfaceRendering) */
  refreshResolution() {
    for (const v of this._views.values()) v._place();
  }

  /**
   * "Move character window" (SSP 5106, DragStartNoMouseDown [disasm]; UI §2.11): pick a character up. Its base rect's
   * centre follows move(x, y) (viewport px; docking still applies, as in a drag) until drop() places it: the 'move'
   * reasons are 'drag', then 'dragend', and the position ratio is saved as after a drag. cancel() puts it back
   * ('move' reason 'restore'). done resolves true on drop, false on cancel. A new carry cancels the open one.
   * DOM mode drives it itself [decision]: window pointermove moves, the next pointerdown (a click, or a tap on touch)
   * drops and is swallowed with its pointerup / click / contextmenu, Escape cancels; the characters ignore the
   * pointer meanwhile, so no mouse event reaches the ghost [guess]. Headless: the caller drives it.
   * A character that is not shown and placed cannot be carried: the handle does nothing and done resolves false.
   * @returns {{move:(x:number, y:number)=>void, drop:()=>void, cancel:()=>void, done:Promise<boolean>}}
   */
  carry(scope) {
    if (this._carry) this._carry.cancel();
    const v = this._views.get(scope | 0);
    if (this._destroyed || !v || !v.visible || !v._geom || !v._anchor) {
      return { move() {}, drop() {}, cancel() {}, done: Promise.resolve(false) };
    }
    const from = { anchor: v._anchor, ratio: v._ratio };
    const r = v.rect;
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    let dx = 0, dy = 0, open = true, settle, undo = null;
    const done = new Promise(res => { settle = res; });
    const finish = ok => {
      open = false;
      if (this._carry === handle) this._carry = null;
      if (undo) undo();
      settle(ok);
    };
    const handle = {
      move: (x, y) => {
        if (!open || !Number.isFinite(x) || !Number.isFinite(y)) return;
        dx = x - cx; dy = y - cy;
        v._drag('move', dx, dy);
      },
      drop: () => {
        if (!open) return;
        v._drag('end', dx, dy);
        finish(true);
      },
      cancel: () => {
        if (!open) return;
        v._dragFrom = null;
        v._anchor = from.anchor;
        v._ratio = from.ratio;
        v._place();
        v._emitMove('restore');
        finish(false);
      },
      done,
    };
    this._carry = handle;
    v._drag('start');
    if (this.dom) undo = this._carryDom(handle);
    return handle;
  }

  /**
   * A carry() is open: the carried character owns the pointer and the keys (Escape cancels it), so the characters
   * report no mouse events and the event loop sends no OnKeyPress meanwhile (UI §2.11).
   */
  get carrying() { return !!this._carry; }

  /** window listeners of a DOM carry; returns their remover */
  _carryDom(handle) {
    const opts = { capture: true };
    const eat = e => { e.preventDefault(); e.stopPropagation(); };
    // the rest of the dropping click: removed when it arrives, or after a second
    const swallow = type => {
      const f = e => { eat(e); off(); };
      const t = setTimeout(() => off(), 1000);
      const off = () => { clearTimeout(t); window.removeEventListener(type, f, opts); };
      window.addEventListener(type, f, opts);
    };
    const onMove = e => handle.move(e.clientX, e.clientY);
    const onDown = e => {
      eat(e);
      handle.move(e.clientX, e.clientY);
      handle.drop();
      for (const t of ['pointerup', 'mouseup', 'click']) swallow(t);
      if (e.button === 2) swallow('contextmenu');
    };
    const onKey = e => { if (e.key === 'Escape' || e.key === 'Esc') { eat(e); handle.cancel(); } };
    window.addEventListener('pointermove', onMove, opts);
    window.addEventListener('pointerdown', onDown, opts);
    window.addEventListener('keydown', onKey, opts);
    return () => {
      window.removeEventListener('pointermove', onMove, opts);
      window.removeEventListener('pointerdown', onDown, opts);
      window.removeEventListener('keydown', onKey, opts);
    };
  }

  // ---------------------------------------------------------------- z-order

  /** bring a scope's character to the front (most recently operated in front, UI §3.5) */
  raise(scope) {
    const i = this._z.indexOf(scope);
    if (i < 0 || i === this._z.length - 1) return;
    this._z.splice(i, 1);
    this._z.push(scope);
    this._applyZ();
  }

  _applyZ() {
    if (!this.dom) return;
    this._z.forEach((s, i) => {
      const v = this._views.get(s);
      if (v && v.element) v.element.style.zIndex = String(Z_BASE + Math.min(99, i));
    });
  }

  /** a character's element joins the ghost's layer (its z-indexes are local to it, UI §3.5), else the shadow root */
  _mount(view) {
    (this.root || getRoot()).appendChild(view.element);
  }

  /**
   * A canvas of this stage cannot draw (CharacterView._lose, the image cache's decode): recorded once in `lost`, every
   * character veiled for good at once (no half-drawn ghost while the runtime ends it), and passed to
   * onCanvasLost(kind, stage); nothing after destroy().
   * @param {'character'|'shell image'} kind
   */
  canvasLost(kind) {
    if (this._destroyed || this.lost) return;
    this.lost = kind;
    this.setVeiled(true);
    if (this.onCanvasLost) {
      try { this.onCanvasLost(kind, this); } catch (e) { log.error('shell: canvas loss handler failed', e); }
    }
  }

  // ---------------------------------------------------------------- frames

  _requestFrame() {
    if (this._destroyed || this._rafPending || !this.clock.requestFrame) return;
    this._rafPending = true;
    this.clock.requestFrame(() => {
      this._rafPending = false;
      this.tick(this.now());
    });
  }

  /** Run one frame for every view (the DOM path calls this from requestAnimationFrame; headless callers directly). */
  tick(now = this.now()) {
    let next = Infinity;
    for (const v of this._views.values()) {
      try { next = Math.min(next, v._frame(now)); } catch (e) { log.error('shell: frame failed', e); }
    }
    if (this._timer !== null) { this.clock.clearTimeout(this._timer); this._timer = null; }
    if (next < Infinity && this.clock.requestFrame && !this._destroyed) {
      this._timer = this.clock.setTimeout(() => { this._timer = null; this._requestFrame(); }, Math.max(0, next - this.now()));
    }
    return next;
  }

  // ---------------------------------------------------------------- persistence

  /**
   * JSON-able state: per scope surface, position ratio, binds, visibility, alignment override, scaling, alpha, and
   * while hidden by \s[-1] the size it was last shown with (`last`, CharacterView.saveState); a \p[n] window not made
   * yet keeps its stored place ({pos} without a surface, UI §3.3)
   */
  saveState() {
    const scopes = {};
    for (const [s, v] of this._views) scopes[s] = v.saveState();
    for (const [s, b] of this._binds) {
      if (!scopes[s]) scopes[s] = { binds: b.onIds() };
    }
    for (const [s, p] of this._places) if (!this._views.has(s)) scopes[s] = { ...(scopes[s] || {}), pos: { rx: p.rx, ry: p.ry } };
    return { v: 1, shell: this.shellId, scopes };
  }

  /**
   * Bind-group ids are local to a shell: binds saved for another shell (`state.shell`, compared without case) are
   * ignored and the scopes keep this shell's defaults; positions, surfaces and the rest still apply (B2). A \p[n] entry
   * with a place but no surface (a cold boot's, coldStageState) makes no window: its place waits for char().
   */
  _restore(state) {
    const entries = Object.entries(state.scopes).map(([k, v]) => [parseInt(k, 10), v || {}]).filter(([k]) => Number.isFinite(k))
      .sort((a, b) => a[0] - b[0]);
    const sameShell = typeof state.shell !== 'string' || state.shell.toLowerCase() === String(this.shellId).toLowerCase();
    if (!sameShell) log.debug(`shell: saved dress-up belongs to shell "${state.shell}", not "${this.shellId}"; using the defaults`);
    if (sameShell) for (const [s, st] of entries) if (Array.isArray(st.binds)) this.bindState(s).restore(st.binds);
    for (const [s, st] of entries) {
      if (st.surface === undefined && !st.pos) continue;
      if (s >= 2 && st.surface === undefined) {
        if (Number.isFinite(+st.pos.rx)) this._places.set(s, { rx: +st.pos.rx, ry: +st.pos.ry || 0 });
        continue;
      }
      const v = this.char(s);
      if (st.align) v._alignOverride = st.align;
      if (Array.isArray(st.scaling) && st.scaling.length === 2) v._scaling = [+st.scaling[0] || 100, +st.scaling[1] || 100];
      if (Number.isFinite(st.alpha)) v.setAlpha(st.alpha);
      if (!(st.surface >= 0)) v._restoreLast(st.last);
      if (st.pos) v.setRatio(st.pos);
      if (Number.isFinite(st.surface) && st.surface >= 0) v.setSurface(st.surface);
      if (st.visible === false) v.hide();
    }
  }

  destroy() {
    if (this._carry) this._carry.cancel();
    this._destroyed = true;
    if (this._timer !== null) this.clock.clearTimeout(this._timer);
    if (this.dom) {
      window.removeEventListener('resize', this._onResize);
      document.removeEventListener('visibilitychange', this._onVisible);
    }
    for (const v of this._views.values()) v.destroy();
    this._views.clear();
  }
}

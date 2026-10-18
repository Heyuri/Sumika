# Module contracts (main thread) — v2

These are the seams between modules. Each module may organize its internals freely, but the names, argument shapes
and behaviors below are what other modules rely on. Behavior details live in the research specs
(`docs/research/*.md`); where they disagree, `docs/research/SUMMARY.md` is normative (its §0 and §1 decisions).

Spec short names: SS = sakurascript.md, EV = shiori-events.md, SH = shell-format.md, BA = balloon-format.md,
UI = ssp-ui.md, TS = tsubasa-needs.md, WASM = satori-wasm.md, SUM = SUMMARY.md.

Safe updates (how each published file is versioned, fetch modes, the build id, staleCheck, stored data) are in this
file (loader.js, build.js, schema.js, state.js, Site, Runtime, the worker protocol) and in CLAUDE.md "What gets
published"; the storage hub is in this file (core/platform.js, core/hub.js, core/portstore.js and "Hub protocol") and
in CLAUDE.md "The storage hub".

## Conventions
* Plain ES2020 modules with JSDoc types, no npm dependencies, browser APIs only (tests run in Node with `node --test`;
  keep pure logic — parsers, layout math, tokenizers — free of DOM access so it can be unit-tested).
* Nothing throws on bad ghost data: `log.once(key, msg)` (src/core/log.js) and carry on.
* Everything is drawn inside one Shadow DOM root: `getRoot()` / `addStyle(id, css)` from src/ui/root.js.
  Layers (z-index): characters `Z_BASE` (+ per-scope order), balloons `Z_BASE+100`, dialogs/menus `Z_BASE+200`.
  Several ghosts (UI §3.5, §9.1): one `.smk-ghost` layer per ghost (src/ui/layers.js) at `Z_BASE + rank` (rank
  by activation, 0 = bottom) holding its characters (`Z_BASE` + scope order), balloons (`+100`) and boxes (`+200`), all
  local to the layer (a positioned element with a z-index is a stacking context); at root level the launcher dock
  (`+190`), the tooltip box (`+199`, one for every ghost: src/ui/tooltip.js), menus and the info window (`+200`), the
  `fill_desktop` flash (`Z_BASE − 1`, below every layer). One ghost (the implicit Site) has no layer: its views go
  straight to the root.
* Coordinates: "viewport" = CSS px relative to the browser viewport (position:fixed). "surface" = pixels of the
  surface image. Surfaces are drawn at `stage.scale` CSS px per image px (1 unless the user picked Shell scaling ▸;
  `\![set,scaling]` multiplies on top), balloons at `balloons.scale` (Balloon scaling ▸); keep each factor in one place
  per module. The user's percentages are device pixels: p % = CSS `(p/100)/devicePixelRatio`, no choice = 1
  (src/core/scaling.js, UI §2.9), except on a phone, where no choice is the fit (`stage.fitScale`,
  `balloons.fitScale`; UI §9.11).
* Phones (UI §9.11): one `phone` = `{short, long, mobileView}` (src/core/phone.js `phoneInfo`, read once per page)
  passed as an option to the components that change on a phone (Stage, Balloons, Dialogs, UserScaling,
  SettingsWindow, Launcher, Site). Made without it, each is exactly its desktop self: no listener, style or element
  is added, no key is read.
* Events use `Emitter` (src/core/emitter.js): `on(type, fn) -> off`, `emit(type, ...args)`.
* Files: `GhostFiles` (src/core/loader.js) — `resolve/has/url/versionedUrl/text/bytes/list/sub`, case-insensitive,
  `\` = `/`. `url(p)` is the plain URL, for what an element loads (`<img>`, CSS `url()`, `<audio>`, a cursor);
  `fetch()` of a ghost file goes through `versionedUrl(p)` and `fetchVersioned` (safe updates: loader.js below).
  Text decoding: `decodeText(buf)` (BOM, `charset,` line, else Shift_JIS).
* Existing modules you can use: core/loader.js, core/storage.js (`Store`, `session`), core/shiori.js
  (`ShioriClient`, `buildRequest`, `parseResponse`, `BASE_HEADERS`), core/log.js, core/emitter.js, ui/root.js.
* Storage, locks and channels (the storage hub: core/platform.js below): page code takes every default
  localStorage, sessionStorage, IndexedDB store, Web Locks manager, BroadcastChannel and `storage` event source from
  core/platform.js, resolved when used (never captured at import or construction: tests swap the globals), never from
  the globals directly. Without `data-hub` each one is exactly the global it replaces.

## Shell — src/shell/

```js
// src/shell/surfaces.js — pure parsing (no DOM)
export function parseShell({ descript: string, surfaces: string[] /* surfaces*.txt texts in load order */ }): Shell
// Shell: { descript: Map<string,string> /* first value of each key */, descriptLines: Array<[key, value]> /* every
//            line in file order, repeats included (SH §4.2) */, surface(id): SurfaceDef|null (lazy merge of blocks),
//          hasSurface(id), surfaceIds(): number[], alias(scope, id): number /* resolved id, random pick if several */,
//          bindGroups(scope): BindGroup[] /* ascending id */, bindGroupsInFileOrder(scope): BindGroup[] /* definition
//            order: SSP's entry order */, bindScopes(): number[],
//          bindOptions(scope): Map<category,{mustSelect:boolean, multiple:boolean}> /* every bindoption line,
//            numbered or not, repeated or not; a later line for a category replaces its options [guess] */,
//          dressupMode(scope): 'manual'|'auto'|'hidden'   /* <scope>.menu: contains auto / hid (SH §4.3.1) */,
//          dressupMenu(scope): Array<number|'-'|{menu:string, items:Array<number|'-'>}>  /* menuitem / menuitemex in
//            descript FILE order, a repeated N overwrites in place; ids of missing groups and empty submenus dropped */,
//          hasMenuItems(scope): boolean /* any menuitem/menuitemex line */, bindCategoryOrder(scope): string[] /* SH
//            §4.3.2: categories by the menu position of their first listed part, unlisted ones after */,
//          balloonOffset(scope): {x,y}, menuInfo: {...}  /* whatever ui/menu needs from descript: fonts, colors, images */,
//          tooltip(scope, collision): string|null  /* <scope>.tooltips (any block name starting with `tooltip`): names
//            without case, a later line wins, an empty text deletes, an empty name never matches; text as written */ }
// BindGroup: { id:number, category:string, part:string, thumbnail:string, default:boolean }
export function descriptLines(text): Array<[key, value]>   // descript lines in file order (keys lower-cased)

// src/shell/dressup.js — one scope's dress-up (SH §4.3; SSP's block model [disasm])
export class BindState {
  constructor(groups /* definition order */, options /* bindOptions(scope) */, menu /* Shell.dressupMenu(scope),
              optional: SSP's entry order for apply() */)
  set(id, on /* true|false|undefined = toggle */): BindChange[]   // one block: applied, every touched category
  apply(category, part, value): BindChange[]                      // validated (without `multiple` only its first part
                                                                  // stays on; `mustselect`: an emptied category gets
                                                                  // its default parts back), net changes, off first.
                                                                  // A non-empty part reaches ONE group when several
                                                                  // share category and part (DSLGS マフラー/黄色 = 205,
                                                                  // 207): the lowest menu position (menuitem / menuitemex
                                                                  // walk order), unlisted ones after in definition
                                                                  // order; no menu: definition order [disasm SPBindProp
                                                                  // lookup 0x5d8c00: first match in the entry list]
  isWorn(id): boolean                        // the part's flag (events, saves, menu checks)
  isOn(id): boolean                          // drawn: its flag, or switched on by another part's addid
  drawChanges: BindChange[]                  // drawn-state changes of the last block (the views redraw them)
  onIds(): number[]; restore(ids); reset(); version
  info(scope, {order, hasFile}): string[]    // OnNotifyDressupInfo refs: scope\1category\1part\1options\1on\1thumbnail;
                                             // options of default,mustselect,multiple; categories in `order`; the
                                             // thumbnail only when hasFile(name)
}
// BindChange: {id, category, part, on}

// src/shell/stage.js
export class Stage extends Emitter {
  static async create({ files /* GhostFiles of the ghost root */, shellId = 'master', ghostDescript /* Map */,
                        state /* StageState|undefined */, scale, root /* Element|null */,
                        phone /* {short, long, mobileView}: phones only (UI §9.11) */ }): Promise<Stage>
                                             // root: where the characters' elements go (_mount appends to root ||
                                             // getRoot()): the ghost's layer with several ghosts (UI §9.1); passed
                                             // through by create
                                             // B1: stage.shellId is the folder actually loaded (its real case): the
                                             // requested one, else `master`, else the first shell/<dir>/descript.txt;
                                             // the requested id only when the ghost has no shell at all
  readonly shell: Shell
  readonly shellId: string; readonly shellFiles: GhostFiles   // files.sub('shell/<shellId>')
  // state.shell (any case) ≠ shellId: that state's `binds` are ignored (bind ids are local to a shell; B2, SH §4.3.3);
  // positions and the rest still apply. A state without `shell` counts as this shell's (older states)
  bindState(scope): BindState                // built with shell.dressupMenu(scope) (its \![bind] entry order)
  setBind(scope, id, on /* undefined = toggle */, {origin?: 'user'|'script', noEvent?}): BindChange[]
                                             // the Clothes/Dressup ▸ pick ('bind' events carry `origin` when given)
  dressupMenu(scope): {mode: 'manual'|'auto'|'hidden', enabled: boolean, entries: Entry[]}   // SH §4.3.1
                                             // manual: {type:'part', id, category, part, on} | {type:'sep'} |
                                             //   {type:'menu', name, entries} in menuitem order; auto: {type:'category',
                                             //   category, on /* any part worn */, parts: [{id, part, on}]} in
                                             //   bindCategoryOrder (the menu puts 2+-part categories first); enabled
                                             //   false: no bind groups, hidden mode, or manual without any menuitem line
  dressupRefs(): string[]                    // OnNotifyDressupInfo references (cached per bind-state version)
  carry(scope): {move(x, y), drop(), cancel(), done: Promise<boolean>}
                                             // "Move character window" (SH §6.7): the base rect's centre follows
                                             // move() (viewport px, docking as in a drag); drop() = a drag's end
                                             // ('move' reason 'dragend', ratio saved; done true); cancel() puts it back
                                             // ('move' reason 'restore'; done false). DOM mode drives itself: window
                                             // pointermove moves, the next pointerdown drops (its pointerup/mouseup/
                                             // click, contextmenu after a right click, are swallowed for up to 1 s),
                                             // Escape cancels; the characters get no mouse events meanwhile, and the
                                             // EventLoop sends no OnKeyPress (UI §2.11). A new carry cancels the open
                                             // one; a scope not shown and placed gets an inert handle
  readonly carrying: boolean                 // a carry() handle is open: false after its drop or cancel, a replacing
                                             // carry or destroy(); an inert handle never sets it
  char(scope: number): CharacterView        // created on first use (scope 0 sakura, 1 kero, 2+ extra \p[n])
  get scopes(): number[]
  resetPositions()                           // Reset shell position (UI §3.2): the stored places up to the highest
                                             // scope that has a view forgotten (a \p[n] above it keeps its place),
                                             // each scope at its default place, lowest first, one hidden by \s[-1]
                                             // too (with the size it was last shown with): \0 bottom-right, the next
                                             // flush against the nearest lower window, base points level,
                                             // char<n>.defaultleft/top first, then layout.js bringBack (SSP's
                                             // ClampToWorkRect) and docking (layout.js defaultPlace, as ssp.exe; no
                                             // room for balloons, nothing of another ghost read). A first placement
                                             // without a stored place uses the same rule
  scale: number                              // CSS px per image px for every character (create option `scale`; on a
                                             // phone without it: fitScale)
  phone: {short, long, mobileView}|null      // create option `phone` (UI §9.11); null: desktop, the plain Stage
  fitScale: number|null                      // the phone default: layout.js phoneFit of the base rects of the shell's
                                             // default surfaces of \0 and \1 (not the stored or current ones),
                                             // computed once at creation; null: no phone, no mobile view, or an
                                             // image size not known synchronously
  desk(): {w, h}                             // the "desktop" characters are laid out on: the layout viewport
                                             // (documentElement clientWidth/Height); on a phone the fixed containing
                                             // block (a position:fixed inset:0 probe in the shadow root), which
                                             // follows the browser's bars [decision]; headless: the `desk` option
  setScale(s: number)                        // the user's shell scaling: each character grows about its base point,
                                             // stays docked, stays against the desk edge it stood against, kept on the
                                             // desk; emits 'move' {scope, reason:'scale'}; hit tests, mouse refs
                                             // (surface px), drags and the default places follow
  refreshResolution()                        // devicePixelRatio changed: each character re-picks its canvas
                                             // image-rendering (surfaceRendering(kx, ky, dpr) in character.js:
                                             // 'pixelated' when every image px covers whole device px, else smoothed)
  saveState(): StageState                    // JSON {v, shell: shellId, scopes: {[scope]: {surface, pos:{rx,ry},
                                             // binds:[groupIds], visible, align, scaling, alpha, last?}}}; last: while
                                             // hidden by \s[-1], {x, y, w, h, bx, by} (surface px: the base rect and
                                             // base point it was last shown with), so it still counts for the default
                                             // places above it after a page change (UI §3.2; runtime.js
                                             // stageStateForShell drops it for another shell). A \p[n] whose window
                                             // is not made yet: {pos} (and binds) without a surface. Such an entry in
                                             // `state` makes no window: char(n) applies the place when it makes it
                                             // (UI §3.3)
  dressupInfo(): string                      // OnNotifyDressupInfo payload (EV §4.11 format)
  acceptsDrops: boolean                      // default false; whoever receives 'drop' sets it (EventLoop once booted,
                                             // the runtime while the engine loads or the tab is frozen); characters take
                                             // file drags only while it is true
  veiled: boolean; setVeiled(on: boolean)    // nothing drawn or hit, every view's state (visible, saveState) unchanged;
                                             // a cold boot veils until its boot script starts (EV §2.1 #24)
  onCanvasLost: ((kind, stage) => void)|null // create option (core/canvas.js): a canvas of the stage
                                             // cannot draw: 'character' (CharacterView: getContext null at _initDom,
                                             // which then makes no element, canvas or listener; or its first backing
                                             // store reads back empty, probed once per canvas before the first put:
                                             // the view hides and draws nothing more) or 'shell image' (the
                                             // ImageCache's decode got no context: ImageCache({onCanvasLost}), the image
                                             // counts as missing, no "cannot load" warn). Called once; none: recorded only
  lost: string|null; canvasLost(kind)        // the first kind; canvasLost records it, veils the stage for good
                                             // (setVeiled(false) does nothing afterwards: a boot's unveil) and calls
                                             // onCanvasLost; nothing after destroy(). Every canvas granted: never fires
  tips: TipBox                               // the box collision tips show in (create option `tips`; default tipBox())
  tipSource: ((req) => Promise<string|null|undefined>) | null
                                             // collision tooltip texts (UI §4.8), set by the EventLoop: req {scope,
                                             // collision, x, y (surface px), fresh, device}; null: no tip; undefined:
                                             // not asked (ask again next time). null (a frozen tab): no tips
  destroy()
  // emits: 'mouse' (MouseInfo), 'surface' ({scope, id, width, height}), 'bind' ({scope, id, category, part, on,
  //        noEvent /* true for \![bind-noevent]: send no OnDressupChanged */, origin? /* only when the caller gave
  //        one */}) per net flag change of a block, off first (addid-drawn parts send none),
  //        'move' ({scope}) whenever a character's on-screen rect changes (balloons follow),
  //        'drop' ({scope, files: File[], x, y /* surface coords */}) files dropped on a character (EV §4.14)
}
// Optional: a GhostFiles with imageSize(path) -> {width, height}|null (e.g. PNG IHDR sizes in the manifest) makes
// every surface's rect known synchronously (no geometryPending at all).

// src/shell/layout.js — pure placement math (defaultPlace, bringBack, snap, toRatio …) and the phone fit (UI §9.11):
export const FIT = { margin: 8, tallLong: 0.4, bars: 112, min: 0.4 }
export function phoneFit(sizes /* {w0, h0, w1, h1}: image px */, phone /* {short, long, mobileView} */, dpr)
  : {scale /* CSS px per image px */, percent /* SSP's device-px % */} | null
                                             // null: no sizes, no phone or no mobile view; k = min(1, kW, max(FIT.min,
                                             // kH)), the floor on the height only; percent rounded down

// src/shell/character.js
export class CharacterView extends Emitter {
  readonly scope: number
  readonly surfaceId: number                 // -1 = hidden
  setSurface(id: number): boolean            // aliases resolved; -1 hides; unknown id -> keep current, log.once, false
  startAnimation(id: number); stopAnimation(id: number); isAnimating(id: number): boolean; stopAllAnimations()
  bind(category: string, part: string, value: '0'|'1'|''|undefined, opts?: {noEvent?: boolean})
                                             // '' / undefined = toggle (SUM C24); applied immediately (bind+X animations
                                             // restart, SUM §2.3), recompose batched per frame; noEvent = \![bind-noevent]
  // SakuraScript player hooks (exact names; the player duck-types them):
  onTalk(n = 1)                              // n visible characters written to this scope's balloon ('talk' anims);
                                             // talk(n) is an alias
  anim(id, cmd: 'start'|'stop'|'clear'|'pause'|'resume'|'offset', ...args)   // \![anim,...]; also
  pauseAnimation(id); resumeAnimation(id); offsetAnimation(id, x, y)
  talkState(on: boolean); onScriptEnd()      // 'starttalk'/'endtalk' (P2); \e -> 'yen-e' (stage.scriptEnd() for all)
  waitAnimation(id): Promise<void>           // \i[ID,wait], \__w[animation,ID]
  get geometryPending(): boolean             // the current surface's size is still loading: rect/basePoint describe
                                             // the previous surface
  geometryReady(): Promise<void>             // resolves when rect/basePoint are current (also for hidden views);
                                             // \![move]/\![moveasync] should await it when geometryPending
  getBinds(): number[]                       // ON bind-group ids
  get rect(): {x, y, width, height}          // viewport rect of the *base* surface (not the grown canvas)
  get collisionRect(): {x,y,width,height}|null|undefined
                                             // ssp.exe's collision rect on the viewport (OnSecondChange R1/R2,
                                             // SUM C17, EV §3.2.1, SH §6.9); null: hidden, no surface or an empty
                                             // box; undefined: geometry or images loading (the getter asks the
                                             // stage's ImageCache for them, once per surface)
  get balloonOffset(): {x, y}                // shell px (descript); placement multiplies it by stage.scale
  get basePoint(): {x, y}                    // viewport position of the anchor point (SUM C28)
  get lastRect(): {x,y,width,height}|null    // rect; while hidden by \s[-1] the rect with the size it was last shown
                                             // with (\4/\5, UI §3.8); null = never sized. Optional: the player duck-types it
  moveTo(x: number, y: number)               // move so that the base point is at viewport (x,y)  (\![move], drag)
  setAlignment(mode: 'bottom'|'top'|'free')  // \![set,alignmentondesktop,...]
  show(); hide(); get visible
  setScaling(sx: number, sy: number)         // \![set,scaling] (P1)
  hitTest(clientX, clientY): string|null     // collision id ('' = on the character but no collision; null = transparent)
  collisionAtSurface(sx, sy): string         // the collision at a surface point by shape only ('' = none or no surface;
                                             // no alpha test, as SSP's GetCollisionNameChar: OnMouseGesture, EV §4.5.1)
  hideTip()                                  // takes this character's tooltip away (its cached text stays)
  readonly element: HTMLElement
  // emits 'mouse' MouseInfo (exact sequences per EV §4.2–4.5.1, SUM C10/C11/C31):
  //   {type:'down'|'up'|'click'|'dblclick'|'move'|'wheel'|'enter'|'enterall'|'leave'|'leaveall'|'dragstart'|'dragend'
  //         |'gesture'|'gesturestep',
  //    scope, x, y /* surface coords */, button: 0 left|1 right|2 middle, wheel /* ±120 per notch */,
  //    collision: string, device: 'mouse'|'touch'|'pen'}
  //   A right drag (src/shell/mouse.js; a touch long press on a spot with no named collision then a 10-px move too
  //   [decision]): 'gesture' {name: GESTURE_DIRS[dir] | 'circle.cw' | 'circle.ccw' | 'end', deg /* the step's angle,
  //   0 for end */, dir /* 0–7, -1 for end */, run /* bumped by each new run */, wx, wy /* the point in the window: client
  //   minus the base rect, CSS px */, wx0, wy0, collision0 /* the press's */, sx0, sy0 /* the press, surface px */},
  //   collision = the collision by shape at the point; between 'down' (button 1) and 'up' {button 1, click:false},
  //   'end' after that 'up'; no 'move' while it lasts. 'gesturestep' (same fields, name null): touch only, each
  //   repeated up / down step. The pointer records carry wx, wy and col (the collision by shape: collisionAtSurface).
  //   EventLoop: 'gesture' -> GET OnMouseGesture [gestureRefs: scope, "wx\x01wy", collision, "wx0\x01wy0",
  //   collision0, name, trunc(deg) | 0] in the button chain, its reply plays; a touch up / down gesture without a
  //   Value -> 3 × OnMouseWheel [sx0, sy0, ±120, scope, collision0, 0, device], then one per 'gesturestep' of that run
  //   (EV §4.5.1)
  // Collision tooltips (UI §4.8): the MouseTracker's 'hover' {fresh, clientX, clientY, rest} (a 500 ms rest on a named
  //   collision only; fresh when it differs, any case, from the one asked last; forgotten by a rest off any collision
  //   and on leaving) is not emitted: a fresh one, or one without a cached text (asked as fresh), asks stage.tipSource
  //   (which sends OnMouseHover); the text shows in stage.tips (system look, aria-describedby on the canvas) while the
  //   pointer still rests there and nothing took a tip away since the rest. A shown tip stays where it is: a move inside
  //   the collision restarts its auto-pop (tips.touch), a rest does not show it again. enter / leave / leaveall / down /
  //   dblclick / dragstart, a surface change, hide(), the veil and destroy() take it away
  // emits 'drop' {scope, files: File[] /* folders left out */, x, y} for a drag carrying files ('Files' in
  //   dataTransfer.types) over an opaque pixel while stage.acceptsDrops; only such drags are taken (preventDefault),
  //   all others pass through. A drop right after an accepted dragover is taken even over a now-transparent pixel.
}
```
Pointer events pass through transparent pixels (clip-path from the alpha mask, SUM C12). Dragging (left button,
≥4 px) moves the character; positions persist as viewport ratios. While a press is held, another pointerId's events
(down, move, up, cancel, lost capture) are not the ghost's: a second finger never takes the first one's press over
(UI §9.11 F1); with no press held every pointer is taken, and events without a numeric pointerId always are.

## Balloon — src/balloon/

```js
// src/balloon/skin.js
export class BalloonSkin {
  static async load(files /* GhostFiles of the balloon folder */, {decode?, onCanvasLost?}): Promise<BalloonSkin>
                                              // onCanvasLost('balloon image'), once: an image's decode canvas got no
                                              // 2D context (images.js decodeImage throws canvasLostError):
                                              // that image is left out as an unreadable one (no warn)
  static fallback(): BalloonSkin              // CSS-drawn balloon when the ghost has none (BA §4 / SUM)
}
// src/balloon/images.js: decodeImage gives the .pna's temporary canvas back (0×0, core/canvas.js releaseCanvas) and
// keeps the drawing source; a canvas without a context throws canvasLostError. ImageStore(files, {onCanvasLost?}):
// a \_b image's lost decode canvas fails that image and calls onCanvasLost()

// src/balloon/manager.js
export class Balloons extends Emitter {
  static async create({ skin: BalloonSkin, stage: Stage, ghostFiles /* GhostFiles of the ghost root, for \_b */ ,
                        ghostDescript /* Map */, state, scale,
                        phone /* {short, long, mobileView}: phones only (UI §9.11) */,
                        onCanvasLost /* (kind) => void: core/canvas.js */ }): Promise<Balloons>
                                               // onCanvasLost, once per Balloons, none after destroy(): 'balloon' (a
                                               // view's canvas got no 2D context, or its main / fg / hover backing
                                               // store reads back empty, probed once per canvas in BalloonView._build
                                               // before anything joins the page: the view then has no element, dom
                                               // null, headless) or 'balloon image' (a \_b decode, ImageStore). Without
                                               // the option: no view or store gets one
  get(scope: number): BalloonView              // one balloon per scope, placed next to stage.char(scope)
  hideAll()
  get choosing(): boolean                      // Status `choosing` (EV §1.6): some view hasChoices (shown or not) and
                                               // some view is visible [disasm AddStatusText 0x639ad8]
  get hovered(): boolean                       // pointer over any balloon (timeouts pause, SUM §2.4)
  resetOffsets()                               // forget the user's drag offsets (menu "Reset position")
  scale: number; setScale(s: number)           // the user's balloon scaling (create option `scale`): every view gets
                                               // it and is placed again; input/communicate boxes keep their size.
                                               // On a phone without `scale`: fitScale
  phone: {short, long, mobileView}|null        // create option `phone`; null: desktop, the plain Balloons
  fitScale: number|null                        // the phone default, placement.js balloonFit(skin, phone), computed at
                                               // creation and again in setSkin (the caller applies a new one when the
                                               // visitor picked nothing: UserScaling.refit()); null on desktop
  // On a phone (UI §9.11): the placement input gets `overhead: true` (above her head when neither side fits; `top`
  // is drawn with the left image and never stored as the side), and balloons are placed and dragged within
  // stage.desk() (the fixed containing block) instead of the layout viewport. Desktop: no `overhead` key, the
  // layout viewport
  refreshResolution()                          // devicePixelRatio changed: every view redraws at the new resolution
                                               // now (BalloonView.refreshResolution), even when `scale` did not change
  saveState(); destroy()                       // saveState(): {[scope]: {kind, side, userOffset:[x,y], ...}}
  setSkin(skin: BalloonSkin)                   // balloon change (BA §12.2): every view re-skinned in place (open ones
                                               // stay open with their text, choices and scroll position, laid out again
                                               // for the new geometry, back on their scope's default kind); sides, drag offsets and
                                               // \![set,balloon…] kept (saveState unchanged); all placed again. A content
                                               // snapshot restored later (get()) is laid out again on the current skin
  setStage(stage)                              // shell change (BA §12.3): follow the new Stage's 'move'/'surface'
                                               // only; placeAll()
  // create options clock (the views' tooltip rest timers) and tips (TipBox; default tipBox())
  tipSource: ((item) => Promise<string|null|undefined>) | null
                                               // balloon tooltip texts (UI §4.8), set by the EventLoop: item {scope,
                                               // kind, id, refs, label} (BalloonView.hoverInfo); null: no tip;
                                               // undefined: not asked. null (a frozen tab): no tips
  endSelections(cause = 'timeout')             // every view's endSelection (a choice timeout, EV §4.7)
  metrics(scope): BalloonMetrics | null        // get(scope).metrics() (the scope's balloon made on first use, like
                                               // \p[N]): currentghost.balloon.scope(N).* (properties.md §5.7)
  defaultKind(scope): number                   // the descript's default \b id of a scope (SUM C15)
  // re-emits from views: 'link' (LinkInfo & {scope}), 'click' ({scope, button}), 'dblclick' ({scope}), 'select'
  // ({scope, index, prev, cause, info});
  // emits 'state' when a persisted setting changed (side, drag offset, \![set,balloon...])
  // Dragging (UI §4.6): a left-button / touch press that travels 4 px (touch 10 px) moves the balloon instead of
  // clicking; the result is the scope's userOffset from its computed place (follows the character, kept across side
  // flips and \b changes, clamped to the viewport, persisted). Ghost descript balloon.dontmove,true turns it off.
}

// src/balloon/view.js — a cursor-based layout area (BA §3)
export class BalloonView extends Emitter {
  readonly scope: number
  setKind(id: number)                          // \b[n]; -1 hides
  resetKind()                                  // back to the descript default (SUM C15)
  show(); hide(); get visible
  clear()                                      // \c
  clearChars(n), clearLines(n)                 // \c[char,n], \c[line,n] (P1)
  write(text: string)                          // glyphs at the cursor; wraps; scrolls; opens the balloon only for
                                               // non-blank content (SUM C14)
  newline(ratio = 1)                           // \n, \n[half] (0.5), \n[percent] (n/100)
  locate(x: string, y: string)                 // \_l[x,y]: all forms in BA §3 (absolute px, @relative, em...)
  image(path: string, x: string, y: string, opts: string[])   // \_b (inline / positioned / opaque / --clipping ...);
                                               // path relative to the ghost folder; missing files never fetched
  setFont(key: string, value: string)          // \f[...]; key 'default' resets
  beginLink(info: LinkInfo); endLink()         // content written in between is clickable
  addChoice(label: string, info: LinkInfo)     // \q convenience
  get hasLinks(): boolean
  get hasChoices(): boolean                    // a link of kind 'choice' (\q, \__q; not \_a); clear() drops them
  showClickWait(on: boolean)                   // \x marker
  readonly width, height                       // image px of the current balloon image
  readonly kind: number                        // the \b id in use (even; the side picks the image)
  metrics(): BalloonMetrics | null             // BalloonModel#metrics (properties.md §5.7): {validWidth,
                                               // validWidthInitial, validHeight, validHeightInitial, lines,
                                               // linesInitial, basePos: {x, y}, charWidth, vertical: 0} of the image
                                               // in use, balloon-image px; also before the first show; null: no image.
                                               // model.js balloonMetrics(geo, font, measure) is the pure part
  scale: number; setScale(s: number)           // CSS scale() on the element (positions inside stay image px); every
                                               // canvas (click-wait marker too) backed at image px × dpr × scale,
                                               // nearest-neighbour; the pointer maps back through the element's box.
                                               // dpr: the real devicePixelRatio while scale ≠ 1, else clamped to 1..3
  refreshResolution()                          // redraw now if devicePixelRatio changed since the last resize
  get rect(): {x, y, width, height}            // viewport rect, scaled (placement, drags, box placement use it)
  setSkin(skin)                                // BalloonModel.setSkin (new images; the scope's default kind, else 0,
                                               // on the side it had; the LayoutEngine snapshot replayed on the new
                                               // geometry: \b geometry ops dropped, \![*] markers resized, a font the
                                               // script never changed follows the new default; emits 'image'), then
                                               // canvases resized, hit area and click-wait part redrawn, full repaint.
                                               // Scroll kept: a balloon scrolled up (scrollY < maxScroll) keeps the
                                               // line at its top (the topmost element in view, found again by its
                                               // order in the replayed layout, same pixel offset; a replay with another
                                               // element count, \c[line], keeps the distance from the bottom), clamped
                                               // to 0..maxScroll; one at the bottom stays there; autoscroll unchanged
  // emits 'link' LinkInfo, 'click' {button}, 'dblclick', 'drag' {kind:'start'|'move'|'end', dx, dy} (to the manager)
  // Choice hover (UI §4.8, EV §4.7; BalloonModel, DOM-free):
  readonly selected: number                    // SSP's selected item (-1 none): set by mouse / pen moves, kept when the
                                               // pointer leaves the window or goes above validrect.top / below
                                               // validrect.bottom (no item is hit there: LayoutEngine.inBand);
                                               // clear / hide / restore drop it silently
  hoverAt(bx, by, clientX, clientY, rest = true)   // a mouse / pen move (the view's pointermove; touch only moves the
                                               // highlight): highlight, selection, and with `rest` the tooltip's rest
                                               // timer (500 ms; a shown tip stays, its auto-pop restarts); rest false
                                               // (a held button): the tip goes
  pointerLeave()                               // the window left (also a drag start): highlight and tip off, the tip
                                               // cache reset; the selection stays, no event
  pointerDown()                                // a press: the tip goes
  hoverInfo(index): {kind, id, refs, label}|null   // the item's References: label = R0 (a \q title as given, else the
                                               // glyphs joined, untrimmed; '' for an image-only item), id = R1 as parsed
  endSelection(cause = 'timeout')              // a selected item is let go ('select' with that cause)
  // emits 'select' {index, prev, cause: 'move'|'timeout', info: hoverInfo(index)|null} when the selection changes, and
  //   {index: -1, prev: selected, cause: 'move'} at every new position outside the hit band while an item is selected
  //   (it stays selected: SSP's SelectLineInternal [disasm]); at a
  //   rest asks tipSource (set by the manager) once per item entry, cached per item until a rest on empty space, a
  //   leave or new content; a reply shows only if the pointer still rests where it asked (late: kept for the next
  //   rest; content changed: dropped). The tip: the view's colours (the image's 6×8 dominant-colour grid cell under the
  //   pointer, font.color border and text with the contrast fix), aria-describedby on the canvas
}
// LinkInfo = {kind:'choice'|'anchor', id: string, refs: string[], label: string, script?: string}

// src/balloon/placement.js — pure (BA §4, §5)
export function placeBalloon({ char, size, offset?, align?, prefer?, windowPosition?, userOffset?, viewport,
                               overhead? }): {x, y, side: 'left'|'right'|'top'|'bottom'}
                                               // overhead (phones only, UI §9.11): in the automatic rule, cut off on
                                               // both sides -> 'top', centred over the character without the shell's
                                               // offsets (windowposition and userOffset still add, then the clamp);
                                               // without it: the desktop rule (the side kept, clamped)
export function placeBox({ size, at?, balloon?, char?, index?, viewport }): {x, y}
export const READABLE_PX = 11                  // CSS px: the balloon fit's text floor
export function balloonFit(skin, phone): number   // the phone default of Balloon scaling: min(1, short / w, max((short
                                               // − 16) / w, READABLE_PX / font.height)), w = the widest balloons* /
                                               // balloonk* / balloonp* image (not balloonc*); 1 without images, phone
                                               // or mobile view (UI §9.11)

// src/balloon/dialogs.js — input box (balloonc3), communicate box (balloonc1), teach box (balloonc2) (BA §5, UI §6)
export class Dialogs {
  constructor({ skin, stage, root, language? /* UiLanguage: the runtime's labels' language; none: English */,
                phone? /* {short, long, mobileView}: phones only, UI §9.11: a balloonc* wider than the phone shrinks
                          (mobile view), 16-px fields scaled back to the balloon font, the focused box shifted
                          vertically above the on-screen keyboard (src/ui/viewport.js), nothing while pinch-zoomed;
                          without it no listener, no inline style */ })
  inputBox({ id, scope = 0, title, defaultText, timeoutMs, kind /* 'text'|'password'|'date'|... */, inputMode?, hint?, placeholder?, pulse?, texts? }): Promise<{text: string|null, timedOut: boolean}>
                                               // inputMode / hint / placeholder: the field's inputmode, tooltip and
                                               // placeholder; pulse: the box pulses (a retry). The runtime's own boxes,
                                               // e.g. Other percentage… with id '__sumika_scaling__'; texts(lang)
                                               // -> {title, hint, placeholder}: their words in a UI language, applied
                                               // again when the language changes while the box is open
  labels(box): {lang, box, field, hint, placeholder, send, close}
                                               // aria-labels and tooltips (UI §2.10): a ghost's title names the box and
                                               // the field as given; Sumika's ('Input', 'Communicate', 'Say something',
                                               // 'Send', 'Close') come from core/i18n.js; open boxes re-label on change
  communicateBox({ scope = 0, defaultText, detailed?, onSend? }): Promise<string|null>
                                               // with onSend(text) (SSP): Enter / OK call it, clear the field and
                                               // keep the box open; the promise resolves when the box closes: null
                                               // (detailed: {text:null, reason:'cancel'|'closed'}). × / Esc = 'cancel'
                                               // (-> OnCommunicateInputCancel), close() = 'closed' (no event).
                                               // Without onSend: one-shot, resolves with the first text. Empty text
                                               // is never sent. Look: [field][OK][×] inside communicatebox.*.
  teachBox({ scope = 0, defaultText, title?, balloon? = 2 }): Promise<{text: string|null, timedOut: false, reason}>
                                               // UI §6.3: the communicate box's look, one word per box (Enter / OK:
                                               // reason 'ok'; × / Esc: 'cancel'; close('teachbox') or a newer teach
                                               // box: 'closed'). Empty text is never sent. Labels: 'Teach' (i18n)
  close(id?)                                   // \![close,inputbox,id]; 'communicatebox' / 'teachbox' (any case) close
                                               // those; '__SYSTEM_ALL_INPUT__' only the input boxes
  get anyOpen(): boolean
  saveState(); restoreState(s)                 // open boxes survive navigation (P1)
  setSkin(skin)                                // balloon change: every open box rebuilt from the new balloonc* images,
                                               // keeping its typed text, caret, focus and top-left corner [infer];
                                               // nothing closes, promises and timers untouched
  setStage(stage)                              // shell change (BA §12.3): each open box the visitor did not drag
                                               // [decision] is placed again at once when its scope's new character has a
                                               // size (rect width and height > 0); else it stays exactly where it is and
                                               // is placed (under the scope's visible balloon, else centred above the
                                               // character) on that stage's first 'move' for the scope with a size. One
                                               // 'move' listener while boxes wait; it goes when none waits (a box dragged
                                               // or closed meanwhile no longer waits), on the next setStage, on destroy();
                                               // a stage without on(): the boxes stay
}
```

```js
// src/core/shells.js — pure (no DOM): SSP's shell and balloon lists (EV §2.6, BA §12); tools/index_site.py sorts alike
compareNames(a, b): number                     // SSP wcsicmpex [disasm]: UTF-16 units, case-insensitive (SSP's fold:
                                               // Unicode simple lower case except U+00C0–00DE), full-width ASCII =
                                               // ASCII, katakana = hiragana, digit runs (ASCII or full-width) compared
                                               // as signed 32-bit numbers (a run's first digit is not width-normalised)
compareFolders(a, b); sameName(a, b)           // SSP wcsicmp_custom: folder tie-breaks and every name lookup
compareEntries(x, y)                           // by name, ties by folder (SPProp::operator<)
sortShells(list); visibleShells(ghost)         // Shell ▸ order; without `hidden` ones
shellName(ghost, id)                           // descript name (what SSP sends as "shell name"), else the id
defaultShellId(ghost, ghostDescript)           // seriko.defaultsurfacedirectoryname (folder, any case; a path by its
                                               // last folder [infer]) → master → surface → first by name; no shells
                                               // listed: ghost.defaultShell, else 'master'
resolveShellTarget(shells /* sorted, hidden included */, currentId, target, {byId=false, random})
                                               // -> entry|null. byId: a folder id. Else 'random' / 'sequential' (both
                                               // need ≥ 2 other shells [disasm 0x627702]: a two-shell ghost ignores
                                               // both; sequential = next in menu order,
                                               // wrapping [guess]), 'lastinstall…' = null, else the descript name (any
                                               // case, first in menu order; folder ids never match; the current one's
                                               // name = a reload)
installedBalloons(index, ghost) -> [{id, name, ghost?}]   // index.balloons (site + hoisted) ∪ the ghost's own bundled,
                                               // one per folder id (any case; the ghost's own wins [decision]), sorted;
                                               // `ghost`: the ghost whose folder holds it
findBalloon(list, key)                         // folder id (exact, any case), then descript name (exact, any case)
ghostBalloonKeys(ghostDescript) -> [{path}|{name}]   // recommended.balloon.path, recommended.balloon,
                                               // default.balloon.path, balloon (GetDefaultBalloon order)
resolveBalloonKey(list, {path}|{name}|{key})   // one key against the list
balloonMenu(list, keys, currentId) -> {top, all}     // rows {id, name, current}; `current` on the first row of the
                                               // balloon in use only; names uncut (the menu cuts them)
resolveBalloonTarget(list, currentId, target, {byId=false, random}) -> entry|null   // like shells; random = any other
                                               // balloon; sequential = next, wrapping [guess]
bootBalloonKeys({shellBalloon, choice, ghostDescript, ghost}) -> keys tagged from: 'shell'|'choice'|'descript'|'install'
bootBalloon(list, keys) -> {entry, from}|null  // the first key that names an installed balloon
```

## SakuraScript — src/sakura/

```js
// src/sakura/tokenizer.js — pure
export function tokenize(script: string): Token[]   // SS §3 grammar and test vectors; an `env` token only for `%*` (the
                                                    // marker): the other %-variables are expanded before play (below)

// src/sakura/expand.js — pure (properties.md §2): ssp.exe's TranslateParam / TranslateParamReal
export const EXPAND_NAMES: string[]                 // the %-variables expanded, longest first (`property` …, no `*`)
export function expandScript(script, resolve: (name, arg?) => string|null|PromiseLike, {maxPasses = 5} = {})
        // -> string | Promise<string> (a Promise only when a resolve call returned a thenable). Never inside a tag's
        // bracket; %property[NAME] raw, null removes it; username / selfname / selfname2 / keroname / lastobjectname /
        // lastghostname double their backslashes; another null leaves the variable as written; passes repeat while
        // the text changes (5); 10,000 substitutions or 1 MB of growth stop it (log once) [decision]

// src/sakura/entity.js — pure (EV §5.5): ssp.exe's character references
export const CHARCODE_REFERENCES: Map<string, string>  // SPGetCharcodeReference's 252 names (HTML 4) -> one character
export function charcodeReference(name): string     // case-sensitive; unknown (and every #N form) -> ' '; also the
        // player's \&[name] on the bracket's one string, untrimmed (SS §5.3)
export function decodeEntity(s): string             // SPGhost::DecodeEntity on a GetStringShiori value: `\\` pairs
        // skipped; \&[name] up to the first ] (or the end) with a 1–19-unit name -> charcodeReference(name)

// src/core/properties.js — pure (properties.md §5, §6): ssp.exe's property system over a `world` (PropertyWorld:
//   now, locale, idleSec, sessionSec, cursor, viewport, dark, online, baseware {name, version, platform}, self(),
//   ghosts(), active(), balloons(); every member optional, a missing one makes its names fail). GhostRec = ItemRec
//   {id, name, path, craftman?, craftmanurl?, homeurl?, icon?, thumbnails?: string[] (one at random), times?: {lastboot?}} & {sakuraName,
//   keroName, live: LiveGhost | null}; LiveGhost {username(), ext(key), setExt(key, value), status(), selfname2(),
//   scopeCount(), scope(n), shells(), currentShell(), balloon(), balloonScope(n), setSurface(n, v), setBalloon(n, id)}
//   (typedefs in the file). getProperty(world, name) -> string | null (failed) | Promise of either (username, ext.);
//   setProperty(world, name, value) -> boolean | Promise<boolean>; parseCharIndex(s); pickFromList(items, s, o)

// src/sakura/player.js
export class ScriptPlayer extends Emitter {
  constructor({ stage: Stage, balloons: Balloons, dialogs: Dialogs, host: PlayerHost, speedMs = 50 })
  play(script: string, meta: {event: string, refs?: string[]}): Promise<PlayResult>
        // replaces any current run (interrupt). PlayResult = {reason:'end'|'interrupted'|'quit'|'replaced',
        //   hasChoices: boolean, noChoiceTimeout: boolean /* \* seen */, event: string,
        //   shown: boolean /* something reached the screen: text, a marker, a choice or anchor, an image, \s, \i, or a
        //   shell tag SSP plays like one on an existing window: \![bind], \4, \5, \![move], \![moveasync],
        //   \![set,alignmenttodesktop|alpha|scaling|balloonoffset|balloonalign], \![lock|unlock,repaint|balloonmove],
        //   \![enter|leave,selectmode], any \![anim] (SSP's "showed something" flag; a run cut short arms
        //   OnSurfaceRestore only with it, EV §3.4) */}
  interrupt()
  get busy(): boolean                        // running or blocked (not counting a finished balloon with choices)
  get choosing(): boolean                    // finished, choices live
  get timeCritical(): boolean                // \t active
  get noUserBreak(): boolean                 // \![enter,nouserbreakmode] of the last run until its leave or the next
                                             // run, ended or not (Status nouserbreak, EV §1.6)
  runState(): RunState|null                  // for persistence (SUM §2.5 "run")
  replay(run: RunState): Promise<PlayResult> // fast-forward to the saved point (SS §7), then continue normally
  setStage(stage)                            // a shell swap: later \s, \i, \![move] … go to the new stage; async
                                             // moves end, and a run waiting on a blocking \![move] or \i[ID,wait] /
                                             // \__w[animation] of the old stage goes on
  hold(); release()                          // a shell swap (EV §2.6): the current run pauses (still busy; a reply or
                                             // click it waited for unblocks it, but nothing executes) until release(),
                                             // which goes on with its waits (due, \__w base) shifted by the time held. A
                                             // newer run is not held. No active run: no-op. Optional for the loop
  // emits 'start' ({event}), 'end' (PlayResult), 'link' (LinkInfo & {scope})  (choices/anchors clicked)
}

export interface PlayerHost {               // implemented by src/core/events.js
  raise(id: string, refs: string[], opts: {notify?: boolean, embed?: boolean, waitReply: boolean}): Promise<string|null>
        // \![raise], \![notify], \![embed]; OnDirectSaoriCall: waitReply=false (SUM C25); a non-empty reply to a
        // waited raise replaces the current run (the host plays it); embed resolves with the text to splice (the reply
        // expanded and through OnTranslate, EV §4.10)
  timerRaise(ms: number, repeat: boolean, id: string, refs: string[], opts?: {notify?: boolean, to?: string})
        // \![timerraise|timernotify] and, with `to` (the ghost argument), \![timerraiseother|timernotifyother] (SUM C3
        // as amended, EV §2.7.9): repeat = parseBool(arg) !== 1 (commands.js parseBool = SSP's ParseBool: 1 | 0 | -1);
        // the *other forms need ms, repeat, ghost and an event (else ignored)
  raiseOther(ghost: string|undefined, id: string, refs: string[], opts: {notify?: boolean}): undefined
        // \![raiseother|notifyother,ghost,event,r…] (EV §2.7.9): the run never waits; ghost undefined = the tag had
        // no argument. A host without it gets the tag through unknownTag. A replay skips all four (side effects)
  openUrl(url: string)
  sound(cmd: string, args: string[])        // \_v, \8, \![sound,...]
  setOption(name: string, args: string[])   // \![set,...] the runtime owns (choicetimeout, balloontimeout, autoscroll...;
                                             // trayi… / tasktrayi…: EventLoop.setTrayIcon, UI §2.6)
  openBox(kind: 'inputbox'|'communicatebox'|'teachbox'|..., args: string[]); closeBox(kind, args)
                                             // \__c = openBox('communicatebox', []), \__t = openBox('teachbox', []);
                                             // the event loop sends the box events (EV §4.8, UI §6.3)
  windowState(state: 'minimize'|'restore')
  change(kind: 'ghost'|'shell'|'balloon', args: string[]): Promise|undefined
                                             // \![change,…]; \+ = change('ghost', ['random']), \_+ = change('ghost',
                                             // ['sequential']) (EV §2.5, §2.6). A thenable blocks the run at that tag
                                             // until it settles (not during a fast-forward replay): a shell change
                                             // without raise-event and every balloon change return one
  call(kind: 'ghost', args: string[]): undefined
                                             // \![call,ghost,<target>(,--option=raise-event)] (SS §5.7, EV §2.7.1): the
                                             // first non-option token is the target, raise-event in any --option= token
                                             // (any case); returns nothing: the run never waits at the tag (no
                                             // BreakScript [disasm]); a replay never repeats it; \![call,<other>] is
                                             // ignored and reported (unknownTag-like, log once)
  reload(kind: 'shiori'|'shell'|'balloon'|'ghost'): Promise|undefined
                                             // \![reload,X] (the whole word `reload`, not SSP's `rel…` prefix; any
                                             // case, X too) and \![reloadsurface]
                                             // (= 'shell') (EV §2.10); makoto / descript / aigraph and a host without it:
                                             // unknownTag. A thenable (shiori, shell, balloon) blocks the run at the tag
                                             // until it settles, then its \__w base is now (ResetWait); ghost returns
                                             // nothing; without a wait (ghost, the no-ops) the base is reset at once.
                                             // A replay never repeats it
  httpExecute(sub: string, args: string[]): Promise|false|undefined
                                             // \![execute,htt…,…] (EV §4.15): false = not HTTP (the player reports the
                                             // tag); a thenable = no --async: the run waits at the tag until the event's
                                             // reply has started, then its \__w base is now; undefined = nothing waits.
                                             // rss / ical / websocket never reach it. A replay never repeats it
  httpCancel(sub: string, args: string[])   // \![cancel,htt…|rss…|ica…|web…,URL] (EV §4.15)
  quit()                                     // \-
  vanish()                                   // \![vanishbymyself]
  raiseProperty(id: string, names: string[]): Promise<string|null>
                                             // \![get,property,id,name…] with ≥ 1 name and a non-empty id (else the
                                             // player sends nothing): every name read now (a failed one ''), GET id,
                                             // SenderType internal,property; the run waits as for \![raise] and a
                                             // non-empty reply replaces it (the host plays it). Without it: unknownTag
  setProperty(name: string, value: string): boolean|Promise<boolean>
                                             // \![set,property,name,value] (needs both; later arguments dropped); a
                                             // thenable holds the run at the tag until it settles (an .ext. write)
  openWindow(kind: 'configurationdialog', args: string[]): boolean
                                             // \![open,con…(,page…)] (con + any letters, any case; \![open,co] is
                                             // another command); args untrimmed; the script goes on; the result is
                                             // not reported. Without it: unknownTag
  unknownTag(raw: string)
  // The player expands no %-variable: the host expands a script before it plays it (EventLoop
  // expand()); %* stays the marker
}
```

## Events and runtime — src/core/ + src/ui/

```js
// src/core/events.js — the PlayerHost; the only module that sends SHIORI requests
export class EventLoop extends Emitter {
  constructor({ shiori: ShioriClient, player, stage, balloons, dialogs, ghost /* index entry */, state: StateStore, menu,
                audio /* PageSaori */, drops /* DropStore */, balloonName /* the balloon in use, OnNotifySelfInfo */,
                shell /* {id, name}: the shell in use */, paths /* {shell, balloon}: site-absolute folders, '/'-ended */,
                language /* UiLanguage */ })
                                             // shell names (descript `name`) go out wherever SSP sends a "shell name":
                                             // OnBoot R0, OnFirstBoot R7 (8 refs, R1–R6 omitted), OnGhostChanged R7,
                                             // OnNotifySelfInfo R3, installedshellname (index order); a shell
                                             // descript's sakura.name/sakuraname, kero.name/keroname (any value, `none`
                                             // too) override R1/R2 and %selfname/%keroname; the ghost descript's
                                             // name.allowoverride does not stop them (ssp.exe 2.9.9 [disasm])
                                             // NOTIFY OnLanguageChange [name, id, '', ''] in the boot batch (English
                                             // without a language); GET OnLanguageChange when language.lang changes
                                             // while booted (EV §4.13); destroy() stops listening
                                             // stage 'drop' -> drops.add(files) -> GET OnFileDrop2 [paths \x01, scope,
                                             // MIME types \x01] (EV §4.14); stage.acceptsDrops true from boot until
                                             // close/suspend/destroy; state.music = audio.musicState(), handed
                                             // back to audio.resumeMusic(s) on a resume only (TS §3.4)
                                             // fetch (option; default the env window's, none without one): what
                                             // \![execute,http-*] sends with; `http` = its HttpRequests (EV §4.15):
                                             // requests while booted and not closed or frozen, the download through
                                             // shiori.writeFile before GET <event> (origin user, SenderType internal),
                                             // no event while locked; _quit / leave / suspend / destroy invalidate()
                                             // paths also take `site` (the site's path, '/'-ended) and `ghost` (this
                                             // ghost's folder): the property records' paths (EV §2.1 "Paths")
                                             // user (option; core/user.js UserProfile | null, EV §4.16): NOTIFY
                                             // OnNotifyUserInfo user.refs() in the batch right before otherghostname
                                             // while user.isSet() (on every engine load: boot, resume,
                                             // afterEngineRestart); %username's fallback user.nickname()
                                             // props (option; Site.propsFor | null, properties.md §1): {ghosts(),
                                             // active(), balloons(), openSettings(page)}; a member missing: this ghost
                                             // and its site index only (`site`, installedBalloons)
                                             // wordList (option; () => Promise<WordSection[]|null>, the runtime's:
                                             // Site.compatibleWords; none: no list) and random (option; default
                                             // Math.random): word()'s fallback, properties.md §2.4; random also
                                             // draws %et and %wronghour (ssp.exe's genrand, §2.3)
  async boot({ resume, firstBoot, changed, called, silent }): Promise<{run: Run|null}>
                                             // silent (\![reload,ghost], EV §2.10): a cold boot without any boot event
                                             // (AddGhost flag 2), run null, nothing of the last session replayed.
                                             // _notifyBatch({initialize = ''}): OnInitialize's R0 (`reload` at
                                             // reloadShiori, below).
                                             // EV §2.1 / SUM §2.5 resume order. Until it has applied the stored
                                             // state (a cold boot: cleared it), saves keep the loop's part (run,
                                             // timers, boxes, music, window state, clock) as stored; stage and
                                             // balloons are always collected, and `names` {sakura, kero}: the names in
                                             // effect (EV §2.7.5). Emits 'notified' {resume} right after the
                                             // NOTIFY batch (cold and resume), before any boot GET; then, not frozen,
                                             // awaits menu.loadShioriLook() when the menu has one (its menu.* GETs:
                                             // UI §2.3), before the surfaces and the boot event. called ({sakuraName,
                                             // name, path, script} of the caller, EV §2.7.1): GET OnGhostCalled [caller
                                             // sakura, its script, its name, its path, u, u, u, own shell] BaseID
                                             // 'OnGhostChanged,OnBoot', 204 -> OnBoot (OnGhostChanged not tried);
                                             // firstBoot wins over called and changed. Returns the run the boot event
                                             // started (OnBoot's too); null when nothing played and on a resume
  async send(id, refs = [], { method = 'GET', play = true } = {}): Promise<ShioriResponse>
  async resource(id): Promise<string|null>    // a GetStringShiori read (EV §5.5), as every one of the loop
                                             // (resources(), %username, balloon_tooltip, tooltip, ….ext. get/set):
                                             // _getString(id, refs) = _request with {comm: false (no COMMUNICATE),
                                             // kind: 'resource' (GET String SHIORI/2.5 for a 2.x engine), SenderType
                                             // internal}; resourceOf reads 200/311/312 only, Value else String else
                                             // Sentence (not empty), SSP's \&[name] entities decoded (sakura/entity.js
                                             // decodeEntity); null otherwise. property.set: any 2xx is success.
                                             // Event, OnTranslate and \![embed] replies are not decoded (valueOf: 2xx)
  playScript(script, {event, refs, origin}): Run | Promise<Run>
                                             // expanded first; a Promise only when the expansion asked an engine
  // %-variables and properties (properties.md §2–§6): no GET username at boot. Every script is expanded once
  //   before it plays: _translate expands, sends OnTranslate [R0 the expanded script], and expands a reply that
  //   changed it again; a script: choice, playScript and a swap-held or queued reply without OnTranslate expand only;
  //   an \![embed] reply is expanded, then sent to OnTranslate [R0 it, R1 '', R2 the event, R3 its refs] and a changed
  //   reply is spliced as returned (no second expansion; EV §4.10); _replay plays the stored script as it is.
  //   _fire's and _raiseWait's stage after the reply (expand, OnTranslate, play) runs through _inOrder: in the order
  //   the replies arrived, so a %username read queued behind a newer event never lets the older reply play last
  expand(script): string | Promise<string>   // expandScript with %property -> _property(arg, '%'), %username ->
                                             // _username() (GET username each time, else user.nickname(), else
                                             // 'user'), the word variables (WORD_NAMES) -> word('\\' + name), the
                                             // rest -> envVar(name) (raw: the expander doubles)
  word(type): Promise<string|null>           // properties.md §2.4: _request(type, [], {comm: false, kind: 'word'})
                                             // (200/311/312, Value else Word, not empty); '\m?' unanswered asks '\m';
                                             // then pickWord(await wordList(), type, random); null: left as written
  envVar(name): string|null                  // %selfname, %month, %et, %wronghour … (not a PlayerHost member);
                                             // 'username' gives the fallback only
  _property(name, how: '%'|'get')            // getProperty(_world(), name): the sweep counts names through it
  raiseProperty(id, names) / setProperty(name, value) / openWindow(kind, args)
                                             // PlayerHost (above). raiseProperty reads with _property(n, 'get') and
                                             // raises as \![raise] (_raiseWait, gen of the raising run) with SenderType
                                             // internal,property. openWindow('configurationdialog', [page]) ->
                                             // props.openSettings(page) (no props: false, log once)
  notifyUserInfo(): Promise                  // NOTIFY OnNotifyUserInfo user.refs() (comm false); nothing before boot,
                                             // closed or frozen (EV §4.16)
  propRecord(): GhostRec                     // this ghost for the property system: descript-level names, path, the
                                             // item names (icon: ghosts.json `icon`, site-absolute; none without
                                             // one), times.lastboot (bootEpochMs), live (made once: GET username
                                             // / property.get / property.set to this engine, failing once closed or
                                             // frozen; status, scopes (count: ≥ 2, charN. descript keys, views),
                                             // scope(n) without making a view, shells with paths, balloon in use,
                                             // balloonScope(n) = balloons.metrics(n) + {num: kind, rect}, setSurface
                                             // as \s, setBalloon as \b)
  // _world(): the PropertyWorld: the loop's clock, navigator.language, InputClock idle, session seconds, lastPointer,
  //   the viewport (+ devicePixelRatio, colorDepth), prefers-color-scheme, navigator.onLine, baseware {name 'SSP',
  //   version basewareVersion(), platform 'ssp.exe'}, self = propRecord(), props' lists
  start(); stop()                            // OnSecondChange/OnMinuteChange clock, cantalk (SUM C6)
  // OnSurfaceRestore (EV §3.4) [disasm DecodeProc, TimerExec]: _onRunEnd stamps it (_restoreAt = now) for a run that
  //   ended (`end`, not failed) or stopped early with PlayResult.shown, never for a fromSurfaceRestore run or a replay
  //   of a run that had already ended; _quit (\-, Close, Quit) and leave() clear it; a cold boot starts with none. Each tick, after
  //   OnSecondChange / OnMinuteChange (unless one of their replies played), _surfaceRestore sends GET OnSurfaceRestore
  //   [_shownSurfaceOf(0), _shownSurfaceOf(1)] (-1 when not shown or no window; makes no view) when now − stamp >
  //   opts.balloonTimeoutMs + opts.surfaceRestoreMs, the tick's local second is 10–50 and nothing holds it
  //   (_restoreHeld: talking, \t, choices or a picked choice's reply, swapping, changing, closing, minimized or
  //   minimizing, passive, induction, the last script's \![set,balloontimeout,0]: _play resets scriptOpts for every
  //   script but one whose first two characters are \C, as SSP's play flag 0x20); the stamp is cleared before the
  //   request; the reply plays with origin 'restore' and fromSurfaceRestore. Balloon and choice timeouts are the only
  //   `post` timers; nothing about the balloon, boxes, a hidden tab or cantalk touches the restore. The ghost state
  //   keeps the stamp as `surfaceRestoreAt` (resume only). A finished run is saved for replay while a post timer
  //   runs, choices are live or the script set \![set,balloontimeout,0]
  // hover and tooltips (UI §4.8, EV §4.3, §4.7): balloons 'select' -> GET OnChoiceEnter / OnAnchorEnter [hoverRefs] on
  //   entering an item; OnChoiceEnter without References on leaving it: NOTIFY (sent first) to another item and at a
  //   choice timeout (Balloons.endSelections before the hide and OnChoiceTimeout), GET to empty space. Every click on
  //   an item (_onLink) sends NOTIFY OnChoiceEnter before the selection event. The loop sets balloons.tipSource (GET
  //   OnChoiceHover / OnAnchorHover, then GET balloon_tooltip, same References -> tipText(the decoded Value)) and, in
  //   _wireStage, stage.tipSource (fresh and not \t: GET OnMouseHover with the mouse References; then
  //   stage.shell.tooltip(scope, collision) -> tipText(text), not decoded; else GET tooltip [x, y, 0, scope,
  //   collision, 0] -> tipText(the decoded Value)). Decoded = resourceOf (EV §5.5).
  //   The GET events' replies play (origin user: they replace a menu, as in SSP [decision]). Nothing is sent, and the
  //   hooks answer undefined, while not booted, closed, frozen, swapping, minimized, or while a picked choice's reply
  //   is on its way. A 'hover' MouseInfo is no event of its own. _unwireStage (detachStage, destroy) and
  //   destroy() clear the hooks they set
  async close(scope = 0, { all, window = scope } = {})
                                             // Close / Quit (EV §2.3, §2.7.3). all (default: no peers, or
                                             // peers.count() <= 1): GET OnCloseAll ['user', scope, window] (R1 the
                                             // menu's character, R2 the clicked one: they differ in a menu
                                             // popupmenu.type redirected, UI §2.1 Notes) BaseID
                                             // OnClose, 204 -> GET OnClose, 204 -> closes at once; a reply plays and the
                                             // ghost closes when the newest run (the close run or one that replaced it)
                                             // ends, \- or not (amends SUM C22) [disasm; guess for replaced runs].
                                             // Otherwise (Close while others stay): GET OnClose only, no BaseID; 204
                                             // -> at once; else at \- (a reply without \- leaves it standing, C22).
                                             // Minimized, minimizing or lockReason (\t, passive, induction), Quit or
                                             // Close of one: the same requests (via _request: no OnTranslate), the
                                             // reply dropped, then _quit({lastRun: true}) at once, \- or not [disasm
                                             // CloseGhostProc 0x4969ef]. close(s, {all: true})
                                             // during a 'one' close upgrades it without a new event [decision].
                                             // `closing` is false | 'one' | 'all' (truthy while closing). Nothing while
                                             // not booted, closed, `changing`, frozen, or peers.busy(); minimize /
                                             // restore do nothing while `changing` or frozen; restore also nothing
                                             // while closing
  quitAll(scope = 0, window = scope)         // the menu's Quit: emits 'quitall' {scope, window} for the Site; no
                                             // listener -> close(scope, {all: true, window}); nothing while not booted,
                                             // closed, changing, frozen or peers.busy()
  resumeClose()                              // a Quit the Site's tab marker carried to this page (markerQuit, EV
                                             // §2.7.3): closing = 'all' on the resumed loop, no event; it closes when
                                             // the current run (or the newest one that replaced it) ends, \- or not;
                                             // nothing playing: at once (_quit). Nothing before boot, once closing or
                                             // closed, changing (leaving) or frozen
  // several ghosts (EV §2.7; the loop never sees the Site, only `peers` and its `layer`). Constructor options
  //   peers ({others(): Peer[], count(): number, busy(): boolean, match(to): string[]} | null = alone:
  //   Site.peersFor) and layer (its `.smk-ghost` element | null). _notifyBatch sends otherghostname =
  //   peers.others().map(otherGhostRef) ([] alone)
  callGhost(target, {byId = false, raiseEvent = true, reason = 'manual', scope = 0, fromScript = false}): boolean
                                             // emits 'call' {target, byId, raiseEvent, reason, scope, fromScript,
                                             // script: fromScript ? lastScript : ''}; false when not booted, closed,
                                             // closing, changing, frozen, or (a pick, fromScript false) inside \t
  call(kind, args)                           // PlayerHost (above): -> callGhost(target, {reason: 'automatic',
                                             // raiseEvent, fromScript: true}); other kinds logged once
  async ghostCalling(callee {sakuraName, name, path}, {reason = 'manual'}): {script}
                                             // GET OnGhostCalling [callee sakura, manual|automatic, name, path] BaseID
                                             // OnGhostChanging, SenderType internal; its reply plays (origin user);
                                             // resolves once it started (after OnTranslate) with that script, '' on 204
  notifyOthers(): Promise                    // NOTIFY otherghostname again (closed / frozen: nothing)
  peerInfo(): {id, name, sakuraName /* in effect: _charName(0) */, keroName /* _charName(1) */, surfaces: [s0, s1],
               shell /* name */}         // makes no character view: a scope the stage lacks (a torn-down stage) is -1
  readonly peerLive: boolean                 // booted && !closed && !closing && !changing && !frozen && !minimized &&
                                             // !passive && !induction && !\t [disasm IsLocked; guess]
  async otherEvent(id, refs): {played}       // GET, SenderType internal, origin user (its reply cuts the talk
                                             // [infer]); nothing unless peerLive
  readonly lastScript: string                // the current (last) run's script, '' when none
  deactivate()                               // active = false (another ghost took the keys)
  readonly otherGhostTalk: {before, after}   // \![set,otherghosttalk,true|false|before|after] (setOption):
                                             // ghostLife.otherGhostTalk '' | 'before' | 'after' | 'before,after',
                                             // saved with ghostLife (a page change keeps it; a cold boot drops it);
                                             // absent until the first \![set,otherghosttalk]
  setTrayIcon(args)                          // \![set,trayicon|tasktrayicon,…] (setOption: trayicon.js isTrayIconTag,
                                             // UI §2.6) [disasm SetTrayIconName 0x61f160]: args[0] through
                                             // findIcon(files, …) (root, then ghost/master/); missing: nothing (log
                                             // once); found while minimized: minimized.icon = it, emits 'trayicon'
                                             // {icon}; else trayIcon = it. No or an empty path: trayIcon = null, except
                                             // while minimized or minimizing (the icon shown stays). Tooltip,
                                             // --duration, --runcount unused [decision]
  trayIcon: string|null                      // a script's icon (ghost-root-relative) for the next minimize; minimize()
                                             // moves it into `minimized.icon` ({reason, scopes, icon?}) and clears it
                                             // (ReloadTrayIcon(NULL)); restore() drops both. Saved as state `trayIcon`;
                                             // a resume keeps it, a cold boot clears it (state too)
  // ghosts interacting (EV §2.7.7–§2.7.9). Communicate (typedef) = {ids: string[] (target ghost ids, duplicates
  //   kept), sender (own sakura name in effect), sentence (the raw response Value, before OnTranslate), refs: string[]
  //   (response Reference1… when the target came from Reference0, else Reference0…, up to the highest, a gap ''),
  //   age (response Age, else '0'),
  //   surface (`${s0}\x01${s1}`, -1 for none), marker (response MarkerSend, else '')}: plain JSON, fixed when the
  //   response came. Run gains communicate (Communicate|null) and ghostChange (it asked \![change,ghost]).
  // COMMUNICATE, sender: _request(id, refs, {method, headers, comm = true}) looks at every response (comm false:
  //   resource(), resources(), the NOTIFY batch, notifyOthers()); communicateOf(res) finds a target; peers.match(to)
  //   resolves it to ids (none, or no peers: nothing); the record goes into the one pending slot `_comm`
  //   (overwritten by the next response with a target, never cleared by one without; {hwnd: true} empties it
  //   [decision]; emptied by _quit, leave and afterEngineRestart). _takeComm() (null while minimized: the slot stays)
  //   is called by the next script queued: _fire right after the response once its reply will play (before
  //   OnTranslate), raise(), _deferReply and a swap-held item when queued, _play with communicate undefined
  //   (playScript, a choice's script:); _playQueued and _replay pass their own record or null. _onRunEnd, right after
  //   the 'talk' after event: when the run ended `end`, not failed, without ghostChange, the loop neither closed nor
  //   frozen -> emits 'communicate' {communicate, run}; the record is taken off the run either way (at most once).
  //   ghostChange is set by changeGhost from a script only when ghostFinder(target) finds a ghost (below).
  //   _collect saves the running run's record as d.run.communicate; _replay passes a well-formed one back
  communicated(c: Communicate): Promise<{status, played}>
                                             // GET OnCommunicate [c.sender, c.sentence, ...c.refs], SenderType
                                             // external,sstp,communicate, headers Age (or '0'), Surface, Marker (when
                                             // given); the reply plays as notifyEvent's. The descript's
                                             // sstp.allowcommunicate present and parseBool !== 1 -> {status: 420,
                                             // played: false}, nothing sent
  raisedByOther(id, refs, {notify = false, sender = ''}): Promise<{ok, status}>
                                             // GET (reply plays as notifyEvent's) or NOTIFY id, SenderType internal,
                                             // Sender: sender when non-empty (else the base Sender: SSP). ok = sent
                                             // and (NOTIFY or a non-empty Value); status = the response's ({ok: false,
                                             // status: 0} when not sent)
  notifyEvent(id, refs, {method = 'GET', senderType = 'internal', headers = {}}): Promise<{status, played}>
                                             // SSP's SPGhost::OnNotifyEvent: _fire with origin 'other' (a GET reply
                                             // cuts whatever plays, a \t script, a menu or a goodbye too [observed]; not
                                             // while minimized; not dropped by a swap). {status: 0, played: false}
                                             // before boot, once closed, while changing or frozen. Also carries the
                                             // PageSaori's sound events (OnSoundStop / OnSoundLoop / OnSoundError,
                                             // EV §4.17)
  readonly lockReason: string                // '' | 'timecritical' | 'inductionmode' | 'passivemode' | 'minimized'
                                             // (that order) [disasm IsLocked 0x642660]
  raiseOther(ghost, id, refs, {notify, live, done})   // PlayerHost: emits 'raiseother' {ghost, id, refs (strings),
                                             // notify}, plus live / done when given; no listener: one debug log, done()
  timerRaise(ms, repeat, id, refs, {notify, to})   // PlayerHost: one map for all four timer tags, keyed by the event
                                             // folded as SSP (A–Z and the simple lower case above U+00FF, not À–Þ);
                                             // the same event replaces; ms 0 cancels; 1–49 -> 50; repeat true or a
                                             // string whose parseBool !== 1 = every ms. Stored timer {ev, refs,
                                             // repeat, intervalMs, dueAt, kind: 'raise'|'notify', to?}; with `to` a
                                             // fire emits 'raiseother' {ghost: to, id: ev, refs, notify} instead of
                                             // raising here; a repeating one adds live() (false once that timer was
                                             // cancelled or replaced, or the loop closed or frozen) and done() (the
                                             // Site's job is over), and skips its fires while one is in flight (EV
                                             // §2.7.9). Restored timers are floored to 50 ms too
  // FMO (EV §2.7.8): a Satori ghost's every _request, and _flushSurfaces' direct OnSurfaceChange NOTIFY, carry `fmo`:
  //   one function per loop (_fmoSource) = fmoText(peerInfo(), peers.others() read then; a throwing others(): self
  //   only, logged once); null once the loop is closed or frozen (torn down). Not on OnDestroy; YAYA and the other
  //   engines get none
  // events: 'activate' {scope} on every _activate (press, balloon click, link, choice, drop); 'closed' {script} (the
  //   script it closed with; '' when it closed without one of its own: a 204 [decision]; a minimized or locked close:
  //   its last script, SPGhost+0x1884 [disasm]);
  //   'talk' {phase: 'before'|'after', run, flags} (EV §2.7.4) for every run but a replay, 'before' not for a reply to
  //   OnOtherGhostTalk: before '' or 'communicate' (the run carries a Communicate); after '', 'communicate',
  //   'communicate,break' or 'break' (a run that did not reach its end or \-, or asked \![change,ghost]);
  //   'communicate', 'raiseother' (above); 'call', 'quitall', 'notified' (above). The window
  //   pointerdown also clears `active` inside a `.smk-ghost` element that is not this loop's layer (a root-level menu
  //   keeps it). Internal: _fire's onPlay(run) option; _fire returns {res, value, played, run}
  // ghost change (EV §2.5); boot({resume, firstBoot, changed}) sends OnGhostChanged (204 -> OnBoot) when `changed`
  //   ({sakuraName, name, path, script} of the previous ghost) is given and it is not a first boot
  changeGhost(target, {reason='manual', raiseEvent=true, scope=0, fromScript=false, byId=false}): boolean
                                             // emits 'change' {kind:'ghost', target, reason, raiseEvent, scope,
                                             // fromScript, byId}; the runtime decides (menu: byId + raiseEvent). From
                                             // a script it marks the run ghostChange (broken) only when
                                             // ghostFinder(target, {byId}) is true (none set: true) [disasm 0x62AEEA]
  ghostFinder: (target, {byId}) => boolean   // set by the runtime (Runtime._changeFinds): the target resolves as
                                             // _change would (this ghost, or one not on screen; random / sequential
                                             // while one is left) = SSP's GetGhostIDFromTag not -1
  async farewell(next {sakuraName, name, path}, {reason, raiseEvent, scope, fromScript}): {ok, script}
                                             // OnGhostChanging (-> OnClose) and its script to the end, then until the
                                             // ghost is quiet (a click's reply plays too; 30 s cap); ok false when a
                                             // balloon break cancelled it or destroy() ended it. `changing` (cantalk
                                             // 0, no menu, no run saved; no Status flag: EV §1.6) from here; an open
                                             // menu closes
  changeScript(): string                     // during farewell: the script OnGhostChanged's R1 gets so far
  async leave()                              // NOTIFY OnDestroy, shiori.unload(), state saved without run/timers/boxes
  // reloads (EV §2.10); reload(kind) is the PlayerHost's (above): shiori -> reloadShiori(), shell / balloon ->
  //   _requestView({kind, target: '', reload: true, fromScript: true, raiseEvent: false}), ghost -> reloadGhost()
  reloadShiori(): Promise<boolean>|false     // NOTIFY OnDestroy ['reload'], shioriReloader(), then GET version, the
                                             // NOTIFY batch with OnInitialize ['reload'] and OnSurfaceChange per shown
                                             // character, all queued synchronously (so _request must reach
                                             // shiori.request before any await); no boot event; _comm emptied. false
                                             // when refused: not booted, closed, changing, frozen, no shiori or no
                                             // reloader (nothing sent); the promise: the reloader's answer (a throw or
                                             // rejection: false)
  shioriReloader: () => Promise<boolean>     // set by the runtime (Runtime._reloadShiori); none: no SHIORI reload
  reloadGhost(): boolean                     // the pending dress-up report goes out, then emits 'change' {kind:'ghost',
                                             // target: own id, byId: true, reload: true, reason: 'automatic',
                                             // raiseEvent: false, scope: 0, fromScript: true} (no ghostChange mark);
                                             // false when not booted, closed, changing or frozen
  // shell and balloon changes (EV §2.6); the runtime does the swap, the loop the events
  viewSwitcher: (req) => Promise<boolean>    // set by the runtime; req = {kind:'shell'|'balloon', target, byId,
                                             // raiseEvent, fromScript, scope, reload?}; reload: true (\![reload,…],
                                             // EV §2.10): target '', the shell or balloon in use, no event
  changeShell(target, {byId=false, raiseEvent=true, scope=0, fromScript=false}): Promise<boolean>|false
  changeBalloon(target, {byId=false, scope=0, fromScript=false}): Promise<boolean>|false
                                             // false when refused: not booted, closed, a ghost change, frozen, no
                                             // switcher, no target; a menu / page request (fromScript false) also while
                                             // minimized, in passive or induction mode or inside \t [disasm]. Never
                                             // the 'change' event (that one is the ghost change's). change('shell'|
                                             // 'balloon', args): --option= tokens are options (raise-event anywhere in
                                             // one), the last other token is the target
  toggleDressup(scope, id): boolean          // Clothes/Dressup ▸: first the playing script's binds so far (NOTIFY
                                             // OnDressupChanged per change, R4 script, then NOTIFY OnNotifyDressupInfo
                                             // as before the pick), then stage.setBind(scope, id, undefined, {origin:
                                             // 'user'}): the last OnDressupChanged as GET, then GET OnNotifyDressupInfo;
                                             // a pick that changes no flag (a worn mustselect default unticked comes
                                             // back) still sends GET OnNotifyDressupInfo; an id naming no bind group
                                             // sends nothing. Refused (false, nothing sent) while minimized, passive,
                                             // induction, \t or `swapping` (EV §4.11)
  enableLevel: 0|2|3                         // the menu's: 3 passive mode, 2 induction mode or minimized, else 0
  async shellChanging(next {name, path}, {scope}): {ok}
                                             // GET OnShellChanging [next name, current name (= R0 on a re-pick), next
                                             // path]; its reply plays (origin user); ok when that run ENDS (or 204);
                                             // not ok after a balloon break, a run that replaces it [infer], close,
                                             // destroy/suspend/leave, or changeWaitMs (30 s) [decision]; while it waits
                                             // the state saves run: null (a page left drops the change). The runtime
                                             // never suspends meanwhile: a takeover waits for the change's end, a ghost
                                             // change asked meanwhile is refused (EV §2.6). Status `changing` from
                                             // OnShellChanging's response on (204 too; not on OnShellChanging itself),
                                             // cleared when not ok [decision: SSP keeps it] (EV §1.6)
  readonly swapping: boolean                 // a shell swap is on: from detachStage() until shellChanged() has played,
                                             // deferred or skipped OnShellChanged's reply; attachStage() of the very
                                             // stage that was detached (a failed swap) ends it too (attaching a new one
                                             // does not); destroy, leave, close and suspend end it and drop what it
                                             // held. Meanwhile cantalk is 0 (counted as closing: ticks go as NOTIFY
                                             // with R3 0; a pending OnSurfaceRestore waits); requests still go out but no reply
                                             // plays: replies of origin tick, restore, timeout, dressup or async are
                                             // dropped, every other (keys, mouse, boxes, timerraise, \![raise],
                                             // OnLanguageChange, choices, send()) is held and counts as played (no
                                             // fallback event after it); a held \![raise] reply carries its raising
                                             // gen and is dropped once a run started after that one (_staleRaise, at
                                             // the swap's end and in the reply queue, as raise() drops it outside a
                                             // swap); the reply queue plays nothing; the run playing when the swap
                                             // started is held (player.hold()) until it ends (EV §2.6). The end of a
                                             // swap (_endSwap: a failed one, destroy, leave, close, suspend) also
                                             // clears Status `changing` (EV §1.6)
  detachStage(): Map<scope, surfaceId>       // swap #1–#3: starts `swapping`, player.hold(); remembers each shown
                                             // scope's surface, flushes pending surfaces, cancels the balloon / choice
                                             // timeout (a pending OnSurfaceRestore stays), hides
                                             // balloons, reports pending binds (script and user, NOTIFY), then sets
                                             // Status `changing` (a script's \![change,shell] gets it here, EV §1.6),
                                             // stops taking drops, stops listening to the stage
  attachStage(stage, {id, name, path})       // listens to the new stage, player.setStage(stage), takes drops; `shell`
                                             // and paths.shell describe it. The detached stage itself: the swap ends
                                             // here (its held replies play at once when nothing talks)
  async shellChanged({surfaces, event=true, defer=false}) -> {restored}   // restored: no event or a 204 put the remembered surfaces back
                                             // NOTIFY OnNotifySelfInfo, OnNotifyShellInfo [name, path, surface ids
                                             // comma-joined], OnNotifyDressupInfo, installedshellname; then with
                                             // `event` GET OnShellChanged [shell name, ghost descript name, path]: its
                                             // reply plays now, or with `defer` when the running script ends (resolves
                                             // once queued); 204 or no event: `surfaces` come back (char.setSurface).
                                             // Status `changing` (EV §1.6) is on for the NOTIFYs and OnShellChanged and
                                             // cleared at its response, before the reply's OnTranslate and a 204's
                                             // restored surfaces (no event: before the restore).
                                             // Then (finally, on every path) the swap ends: the held replies join the
                                             // reply queue behind OnShellChanged's, oldest first, and player.release()
                                             // lets the held run go on (after a 204's restored surfaces)
  setBalloonInfo({name, path})               // OnNotifySelfInfo R5/R6 from here on
  async balloonChanged({event=true, defer=false})   // NOTIFY OnNotifySelfInfo, then GET OnBalloonChange [name, path]
                                             // (reply now, or when the running script ends with `defer`)
  // replies queued with defer, and the ones a swap held, play at the newest run's end (before the dress-up GET), at
  // once when nothing plays (never while `swapping`); from the menu OnShellChanged's reply plays at once and the held
  // ones after its script; with defer they follow the calling script, then the deferred reply. A close, leave, suspend
  // or destroy drops them. Dress-up: 'bind' events with origin 'user' are reported at once (also while a script
  // plays, R4 'user', after that script's binds so far as NOTIFY); every flush reports each part's net change, offs
  // before ons (dressupChanges), and none at all from 100 changes on (EV §4.11). OnKeyPress is not sent, and the key
  // not prevented, while stage.carrying (UI §2.11). Internal: _fire's option `swap` (only OnShellChanged) lets its
  // reply play during the swap
}
export function dressupChanges(list): list   // one flush's reports: net change per part, all offs, then all ons
export const BASEWARE, VERSION                // basewareversion's refs; Sumika's version (runtime.js re-exports it)
export function basewareVersion(v = VERSION)  // 'SSP/2.9.08 (sumika-<v>; Web)' (baseware.version, properties.md §5.5)
export const CONFIG_PAGES                     // SSP's 17 settings page types (setup … developer, ipmessenger)
export function settingsPage(page): boolean   // \![open,con…,page] opens the box: none, setup (any case, untrimmed) or
                                              // a word that is no page type; the other types: false (UI §2.13)
export function indexGhostRecord(g, base = '/'), balloonRecord(b, base = '/')
                                              // a site index ghost (live null; `icon` and `thumbnails` from
                                              // ghosts.json, site-absolute) / an installedBalloons entry as a
                                              // property record with its site path
export function hoverRefs(item): string[]    // [label, id, ...refs]: a balloon item's References (EV §4.7)
export function communicateOf(res)           // EV §2.7.7 A2–A5, pure: null (status 204 or >= 400, no target, no
                                             // Value/Sentence header) | {hwnd: true} (HWnd / TargetHWnd with a Value)
                                             // | {to, shifted, sentence, refs, age, marker}: To, else Reference0 when
                                             // To is missing or equal (shifted: refs from Reference1); refs = every
                                             // `reference<n>` header at strtoul's n (<= 100000) up to the highest, a
                                             // gap '' (SSP's GetValueReference [disasm 0x6AEC60]); res.headers
                                             // lower-cased (parseResponse); a SHIORI/2.x reply (res.protocol < 3:
                                             // Kawari 7's bridge) takes To only, never shifted [disasm 0x711878]
// src/core/fmo.js — pure (EV §2.7.8): FMO_PATH = '/ssp/'; fmoText(self, others = []) -> the "SakuraUnicode" text Satori
//   reads (P8): lines `ssp_fmo_header_00000000_<n as 8 hex>.<key>\x01<value>\r\n`, n 0 = self, 1… = others in the
//   order given (slot order); keys path (FMO_PATH), name (sakuraName), keroname, sakura.surface, kero.surface (-1 for
//   none), ghostpath ('/' for self, `/ssp/ghost/<id>/` for the others), fullname (name), modulestate
//   (`shiori:running`); no hwnd, kerohwnd, hwndlist [decision]; CR, LF and \x01 in a value become a space; a line
//   whose value is empty is left out
// src/ui/tooltip.js — tooltips (UI §4.8): TipBox({root, clock}) (root default getRoot() at the first show, null:
//   headless; one per page: tipBox()): show(owner, text, {x, y /* client px */, look: 'system' | {bg, fg: [r,g,b]},
//   target /* gets aria-describedby while shown */}) replaces any tip, auto-pops after TIP_AUTOPOP_MS (20 s);
//   touch(owner) restarts that; hide(owner?) (only that owner's); owner, text, look, at, pos; destroy(). The element:
//   <div class="smk-tip" id=TIP_ID role="tooltip" lang=""> at root level, position fixed, z-index TIP_Z (Z_BASE + 199),
//   pointer-events none, white-space pre-wrap, max-width tipMaxWidth() set at each show (TIP_MAX_WIDTH 500 device px
//   = 500 / devicePixelRatio CSS px; and the viewport). Pure: tipText(raw) (every literal \n a line break; a
//   SHIORI reply comes in with its \&[…] decoded by the loop, EV §5.5), placeTip(at, {w, h}, viewport) (x at the pointer, TIP_BELOW 20 px under it, above
//   it at the bottom, 2 px inside), luminance(c), fitLuminance(c, target), tipColors(bg, fg) (SSP's contrast fix),
//   dominantColor(rgba, w, x0, y0, x1, y1), dominantGrid(rgba, w, h, validRect) (6 × 8 cells + whole),
//   gridColor(grid, x, y), tipMaxWidth(dpr = devicePixelRatio). TIP_DELAY_MS 500 (the views' rest), TIP_MAX_WIDTH 500
// src/core/state.js — the SUM §2.5 JSON schema in localStorage (sync on pagehide), timers, session marker
//   Defaults through core/platform.js (the storage hub): defaultStorage() = localStore() (the hub's mirror) ||
//   pageStorage() || this page's memory; sessionMarker and InputClock default to tabSession; GhostLock's `locks` /
//   `Channel` left undefined resolve to lockManager() / channelClass() in its constructor (made only after the hub
//   decided). StateStore({storage?, clock?, debounceMs?, maxWaitMs?, will?}): `will(lockName, key)` runs after each
//   successful write (the slim retry too); default without `storage` = stateWill() (null without the hub;
//   the hub stamps `savedAt` when the ghost's lock `sumika:<id>` goes). writeThrough(on): while on, change() writes at
//   the end of the task (a microtask, the changes of one task written once) instead of debouncing; `dirty` covers it
//   (the hub's leave-flush, Site._leaveFlush). A mirror that refuses a write with QuotaExceededError runs the
//   slim retry as a full localStorage does.
//   runtimePrefs (localStorage RUNTIME_KEY 'sumika:runtime': {ghost, ghosts, rev, lang}; get(storage?), set(patch,
//   storage?) merges the patch): `ghosts` the set on screen in set order (absent = [ghost]: ghostset.js chooseSet),
//   `ghost` = ghosts[0] (always written with it: a different stored `ghost` takes slot 0, chooseSet [decision]), `rev`
//   +1 on every set write (the set messages carry it), `lang` UI §2.10, `user` (core/user.js: {name?, nickname?,
//   birthday?: 'YYYY-MM-DD' | '', sex?}, UI §2.13). Written by the Site only (`user` by its UserProfile). Its
//   version `v` (schema.js SCHEMA.prefs) lives in storage only: set() writes it, get() leaves it out (readPrefs is the
//   hook); prefs a newer runtime wrote are read for what fits: newer(storage?) -> true, and set() writes nothing and
//   returns false (logged once), else true (best effort). UserProfile.set keeps the stored `user`
//   sub-keys it does not know.
//   sessionMarker (sessionStorage 'sumika.session'; read() requires a string `ghost`) v1 ({booted, ghost,
//   sessionEpochMs, pending?, change?}: pending = a ghost change of `ghost` to finish on the next page, change =
//   OnGhostChanged's previous ghost or null) plus v2 (ghostset.js markerRecord): `ghosts` (this tab's booted ghosts, set
//   order) and `carry` {[id]: {kind:'change', change} | {kind:'call', call: {sakuraName, name, path, script}, caller} |
//   {kind:'after', of:'call', caller} | {kind:'after', of:'change', prev: {sakuraName, name, shell, script}}}: what the
//   next page finishes (EV §2.7); `quit: true` while a Quit says goodbye (written when it starts, gone with the marker
//   when the site closes; the next page goes on with it, EV §2.7.3); the v1 `pending`/`change` mirror a change carry of
//   ghosts[0]. Its version `v` (SCHEMA.marker, 2) is added by write() as `booted` is and hidden by read(); an
//   unmarked marker is 2 with a `ghosts` array, else 1, which read() brings up (schema.js markerV1toV2); a newer one
//   is read for what fits (a resume, never a cold boot), and each page writes its own version.
//   Ghost state: `v` = STATE_VERSION (= SCHEMA.state, 1; `stage.v`, nested and never read, stays as written).
//   upgradeState(raw) -> {rec, v, newer} is the hook before any field is read (normalizeState, storedClosed,
//   StateStore). StateStore.newer: the stored state is newer than this runtime: read for what fits; saveNow() returns
//   false and writes nothing, the debounced and pagehide writes and clear() leave it (logged once). Every write keeps
//   the stored state's top-level fields this runtime does not know (`{...unknown, ...data}`, in the quota retry too).
//   An unreadable state is a fresh start (logged once), replaced at the next write.
//   GhostLock(id, o): name `sumika:<id>`, or `sumika/<rest>` for an id starting with '/' (the lead lock LEAD_ID '/lead'
//   = 'sumika/lead', the tab that runs the set; its handshake channel gets the same name); dispose() also drops a wait
//   still queued (the lock is let go at once when it is granted). storedClosed(id, storage?) -> the stored state's
//   `closed === true` without opening a StateStore (false when absent, unreadable or blocked).
//   Ghost state `ghostLife.otherGhostTalk` (EV §2.7.4) passes through normalizeState's ghostLife spread (no default).
//   Ghost state `trayIcon` (UI §2.6): a script's \![set,trayicon] file (ghost-root-relative) or null (default);
//   `minimized.icon` the one shown while minimized; normalizeState keeps each only as a non-empty string.
//   Ghost state `names` {sakura, kero} | null (default null): the names in effect the loop collects at each save
//   (EventLoop._collect), what Site._peerOf shows of a slot without a loop (EV §2.7.5); normalizeState keeps it only
//   with both strings.
//   Ghost state `timers` (SUM C4): normTimer keeps a string `to` (a \![timer*other]'s target, EV §2.7.9); `run` may
//   hold `communicate` (a Communicate, EV §2.7.7; the loop checks its shape when it replays the run).
//   Ghost state `scaling: {shell, balloon}`: the user's percentage or null (follow the
//   display), cleaned by normalizeState (whole numbers 10..500). Ghost state `bootEpochMs` (P7, SUM §2.1): epoch ms
//   of its last cold boot, 0 = none; the runtime sets it on each cold boot (storing the reset state at once when one
//   was stored before) and passes it to ShioriClient.start. Ghost state `surfaceRestoreAt` (EV §3.4): epoch ms a
//   pending OnSurfaceRestore counts from, 0 = none (normalizeState: a finite number > 0, else 0); the loop writes it
//   in _collect, reads it on a resume and clears it on a cold boot; the runtime zeroes it in the reset state it stores
//   at a cold boot's start.
//   Shells and balloons (EV §2.6, BA §1.6): `shell` the folder in use; `shellChosen` true once the visitor picked a
//   shell (SSP shell.ischanged.2; false: the ghost boots its default shell); `balloon` the chosen balloon's folder id
//   (older states: its descript name; both resolve); `shells` the per-shell memory {[shellId]: {binds?: {[scope]:
//   number[]}, balloon?: id}} (SSP shell.dat), cleaned by normShells(raw); `shellSwap` {surfaces: {[scope]: id}}|null
//   (default null): a shell swap whose surfaces OnShellChanged has not decided yet, the surfaces shown before it;
//   normShellSwap(raw) keeps whole non-negative scope keys and ids, else null (EV §2.6)
// src/core/schema.js — the version of each kind of record a visitor's browser keeps (safe updates; imported by the
//   page and the worker): SCHEMA (frozen) {state: 1, prefs: 1, marker: 2, files: 1, drops: 1, choice: 1} (choice:
//   localStorage `sumika:choice`, core/choice.js; a new kind reads as a bump to older tools, which
//   take a kind they lack as 0); STEPS[kind][n] takes a
//   record from version n to n + 1 (only marker {1: markerV1toV2}); versionOf(v) (a whole number >= 1, anything else
//   1); upgrade(kind, rec, v, steps?, to?) -> {rec, v, newer}: older -> the steps in order, in memory (the next write
//   stores the current shape), and an object record that moved up gets `v` = the version reached, so a second pass
//   (StateStore.reload, then normalizeState) runs no step again; newer -> left as it is, newer: true; the stored record
//   itself is never changed. Rules: one mark per record kind and one hook on its
//   single read path, run before any field is read; an unmarked record is version 1; bump a kind only for a change an
//   older reader would misread or an older writer would damage (an additive field needs none: every writer keeps the
//   fields it does not know); a key's encoding never changes (JSON in localStorage, structured clone in IndexedDB), so
//   a new encoding, or a shape old code would damage, takes a new key, and an unreadable value is corrupt. A newer
//   record is read for what fits and, per kind, never written or cleared (state, prefs, drops; the marker is a message
//   to the next page, so each page writes its own). `files` is versioned by its key: schema 1 is `ghost:<id>:files`,
//   a future shape takes `ghost:<id>:files.v2` (a mark inside the record would be mounted as a file by older workers).
//   Not versioned: `sumika.lastInputMs` (a bare number), `sumika.reloadedFrom` (Site.staleCheck's guard),
//   `sumika.hostRewrites` (loader.js fetchVersioned's flag), the cross-tab messages and lock names (additive fields only; an incompatible message takes a new `t`, which older tabs ignore),
//   the IndexedDB version (storage.js DB_VERSION, frozen at 1). Two further rules: `stage.v` in the ghost state stays
//   as written (STATE_VERSION covers it); a change to the SakuraScript tokenizer's token numbering invalidates a stored
//   `run.ip` / `run.sub`, so it must bump the state version with a step that drops `run`.
//   A schema bump is one-way: once a build with a higher version of a kind is published, visitors hold records only it
//   and later builds can write, and a host that serves an older build again (a one-click rollback, a git revert)
//   leaves them read-only for good. So a rollback across a bump is published as a new build that keeps the newer
//   readers (revert the feature, not schema.js); tools/build.mjs records SCHEMA in sumika/build.json and refuses to
//   build one lower for any kind than the previous build.json's; Site.staleCheck logs it once when a newer record
//   meets a build.json that names this very build. No kind has been bumped yet.
// src/core/build.js — the build's own table (safe updates): BUILD (`__SUMIKA_BUILD__`, defined by tools/build.mjs: 12
//   hex of the SHA-1 of the page bundle built with an empty id, so the bundle holds it as a string literal exactly
//   once; 'dev' unbundled), FILES (`__SUMIKA_FILES__`, JSON parsed at load: {worker: 'engines/worker.<h>.js', engines:
//   {<e>: {js: 'engines/<e>.<h>.js', wasm: 'engines/<e>.<h>.wasm'}}}, relative to runtimeUrl, the same table as
//   sumika/build.json; null unbundled: tests, site/dev, the sweep; the MIDI player adds `midi: {js:
//   'engines/midi.<h>.js', bank: 'engines/generaluser_gs.<h>.sf3.gz'}`, read by core/midi.js midiPaths(files), which
//   Site.midi calls with runtimeFiles). workerPath(files = FILES) -> the table's worker,
//   else 'engines/worker.js'; enginePaths(engine, files = FILES) -> {js, wasm} from the table, else {js:
//   'engines/<e>.js', wasm: null} (also for an engine the table lacks; the worker refuses unknown engines anyway).
//   BUILD is not VERSION (events.js: '1.0.0', ghost-visible through baseware.version).
// src/core/scaling.js — the user's Shell / Balloon scaling ▸ (UI §2.9): SCALE_STEPS, displayPercent(dpr),
//   parsePercent(v) (any whole number), normPercent(v) (10..500 or null), cssScale(p, dpr) = p === null ? 1 :
//   (p/100)/dpr, effectivePercent(p, dpr), cssScales(stateScaling).
//   UserScaling({state, stage, balloons, dialogs, host, dpr?}): info() -> {shell, balloon, dpr} (the menu), set(target
//   'shell'|'balloon', percent|null) -> stores in state.data.scaling, state.change(), stage/balloons.setScale(), and
//   when the size in effect changed host.send('OnShellScaling'|'OnBalloonScaling', [new, old, new, old]);
//   askOther(target, scope) (input box id OTHER_BOX_ID; a number is clamped to 10..500, other text asks again with
//   pulse; its title (SSP's dialog name, 'scale.box.<target>'), hint and placeholder in the UI language of the
//   `language` option, with texts(lang) for the dialogs);
//   apply(); bindWindow(win) re-applies on devicePixelRatio changes and then calls stage/balloons
//   .refreshResolution(); destroy(). Option `phone` (phones only, UI §9.11): with no pick the percentage in effect is
//   the fit (stage.fitScale / balloons.fitScale × dpr × 100): scales() uses it, info() adds `fit: {shell, balloon}`
//   (percentages or null; desktop: no `fit` key), set() and askOther() start from it; refit() re-applies after a
//   balloon change (a shell swap's new stage carries its own fit). The fit is never stored and sends no
//   OnShellScaling / OnBalloonScaling; a stored pick always wins. Without `phone`, refit() does nothing
// src/core/i18n.js — pure (UI §2.10): STRINGS {en, ja} (the runtime's visitor-visible text; every key in both),
//   t(key, lang = 'en', params) ('{name}' filled in; unknown language -> English, unknown key -> the key), LANGUAGES
//   {ja: {name: 'Japanese', id: 1041}, en: {name: 'English', id: 1033}} (Language ▸ order), normLangPref(v) -> 'ja' |
//   'en' | 'system', systemLanguage(navigator) (first ja/en of navigator.languages, else 'en'), resolveLanguage(pref,
//   navigator), languageRefs(lang) -> OnLanguageChange [name, id, '', '']. SSP_KEYS / SAME_IN_JA mark the sources.
// src/core/user.js — the visitor's user information (UI §2.13, EV §4.16): UserProfile({storage?}) extends Emitter
//   (storage null: this page only, in memory): data (a copy), isSet() (any of the four stored), refs() ->
//   OnNotifyUserInfo [R0 nickname || name || '', R1 name, R2 birthdayRef(birthday) 'YYYY,MM,DD' | '', R3 sex ||
//   'undef'], nickname() (%username's fallback: nickname, else name, else null), set(patch) -> true and 'change'
//   {data, prev} when it changed (stored at once), refresh() (another tab), bindWindow(win) ('storage' on
//   core/platform.js storageSource(win): the window, or the storage hub's events), dispose().
//   sharedUser(): the page's one (the Site's default); normUser(v), birthdayRef(s), SEXES, USER_KEY 'user'. Never
//   logged. src/ui/settings.js — settingsView(data, lang) (the box's words and values, headless) and
//   SettingsWindow({user, language, onClose}): open() (a second one brings it to the front; the focus goes to Name
//   unless the visitor types in a page field (input, textarea, select, contenteditable): then none, a pulse instead,
//   and close() restores none), edit(key, value) (the
//   DOM's input path: stored at once, touched), close() -> onClose({touched}) once, isOpen, view(), destroy() (no
//   onClose). Headless without a document. Option `phone` (Site.openSettings passes the Site's; UI §9.11): 16-px
//   inputs, and while open its inline top / max-height follow the visible viewport (above the keyboard; nothing while
//   pinch-zoomed; `left` stays the CSS 50 %); without it, no inline top / max-height and no listener
// src/core/language.js — UiLanguage({storage?, navigator?}) extends Emitter: pref ('ja'|'en'|'system', from
//   runtimePrefs `lang`), lang (in effect), set(pref) -> true when lang changed (stored at once), refresh(),
//   bindWindow(win) ('storage' for RUNTIME_KEY on storageSource(win): the window or the storage hub's events;
//   'languagechange' on the window), dispose(); emits 'change' {lang, prev, pref,
//   prevPref} whenever pref or lang changes. sharedLanguage(): the page's one instance (the Runtime's default).
//   Components given no UiLanguage use English (tests stay independent of the machine's locale).
// src/core/ghostset.js — pure set helpers (no DOM; the one import is shells.js sameName, which imports nothing;
//   EV §2.7, UI §9.5). Ghosts interacting (EV §2.7.7, §2.7.9): ALL_GHOSTS = '__SYSTEM_ALL_GHOST__'; sspNameEqual(a, b)
//   (SSP's wcsicmp_printchar [disasm 0x5ADF90]: every char <= U+0020 and U+3000 skipped in both, the rest compared
//   with sameName; no width or kana folding); communicateTargets(peers [{id, sakuraName}], to) -> ids: ALL_GHOSTS as
//   the whole value (sameName) = every peer; else each \x01 token (empty ones dropped) -> the first peer whose
//   sakuraName is sspNameEqual (never the descript or kero name), duplicates kept; isLastInstall(t) (/^lastinstall/i);
//   raiseTargets(cands [{id, name, sakuraName}], arg, {random = Math.random}) -> ids: 'random' (whole, any case) = one
//   candidate (the raiser possible); lastinstall… = []; ALL_GHOSTS = every candidate, the raiser included; else per
//   token the first descript-name match (sspNameEqual), else the first exact case-folded sakura match (IsMatch 103),
//   else the first sakura match with spaces skipped (101) [disasm 0x7314F8–0x731533]; never the kero name. MAX_GHOSTS =
//   Infinity (no cap, as SSP), LEAD_ID = '/lead'. chooseSet(index, {stored /* runtimePrefs.get() */, supported,
//   max, fallback}) -> entries: the stored `ghosts` in order minus ids the index lacks or cannot run, de-duplicated, at
//   most max (not a number >= 1: MAX_GHOSTS); a stored `ghost` other than ghosts[0] takes slot 0 (written by code that
//   knows one ghost [decision]); nothing left or no `ghosts`: [fallback()] ([] when null). siteClosed(ids, closedOf) = ids non-empty and every one
//   closed. resolveCallTarget(ghosts, callerId, target, {byId, onScreen /* Set or array */, supported, random}) ->
//   entry|null: byId exact; 'random' / 'sequential' (after the caller, wrapping) over ghosts not on screen, not the
//   caller, runnable; 'lastinstall…' (any case) null; a name: the caller's own descript name, any descript name, the
//   caller's sakura name, any sakura name [disasm GetGhostIDFromTag], the folder id, the name / id in any case; a ghost
//   on screen (the caller too), unknown or not runnable: null (one log line for all three). otherGhostRef({sakuraName,
//   surfaces}) = `${sakuraName}\x01${s0}\x01${s1}` (a surface that is not a whole id >= 0: -1 [infer]);
//   afterBootRefs(info) / otherClosedRefs(info) -> [sakuraName, script, name, u, u, u, u, shell] (u = undefined: not
//   sent); otherChangedRefs(a, b) -> 16: [a.sakura, b.sakura, a.script, b.script, a.name, b.name, u ×8, a.shell,
//   b.shell]; otherTalkRefs(talker {name, sakuraName}, run {event, script, refs}, flags) -> [name, sakura, flags,
//   event, script, refs joined by \x01] (missing strings ''). diffSets(prev, next) -> {gone, added, replaced: [old,
//   new][]} (the same place, neither id in the other list: replaced). markerGhosts(m) (v2 ghosts, else [ghost]),
//   markerCarry(m) (v2 carry, malformed entries dropped, else v1 pending -> {[ghost]: {kind:'change', change}}),
//   markerRecord({ghosts, sessionEpochMs, carry, quit = false}) -> {booted, ghost: ghosts[0], sessionEpochMs, pending?,
//   change?, ghosts, carry?, quit?} (the v1 mirror only for a change carry of ghosts[0]; carries of ids outside the set
//   dropped; carry left out when empty; quit: true only when quit, else left out). markerQuit(m) -> m.quit === true
//   (a Quit was saying goodbye when the page went).
// src/core/site.js — the page's Site (SSP's SPScriptPlayer with one SPGhost per ghost [disasm]). Site({base,
//   defaultGhost = null, defaultBalloon = null, runtimeUrl, Channel?, language?, user?, lead = true, maxGhosts =
//   MAX_GHOSTS, createRuntime?, phone = null, tucked = false, runtimeFiles = FILES, build = BUILD, fetch?, reload?,
//   session?, clock?}) (phone: {short, long, mobileView} on a phone, passed to every slot's components; tucked: the
//   set starts as her button, UI §9.11, main.js's decision (core/choice.js startState: data-phone="tucked" on a phone,
//   or data-default-state="tucked" with no visitor choice on any device; with the storage hub main.js sets `tucked`
//   once the choice is read, before the first start); main.js passes neither key on a desktop page without
//   data-default-state="tucked"; runtimeFiles, build, fetch,
//   reload, session: safe updates, "A page older than the published build" below; clock: _upSettled's and
//   staleCheck's) extends Emitter holds what exists once per page: index (SiteIndex, loaded once: _loadIndex()),
//   language (default sharedLanguage()), user (core/user.js UserProfile, default sharedUser(); bound
//   to the window with the page hooks), tabId, input (the InputClock, made at the first boot: _ensureInput()),
//   sessionEpochMs (the tab marker's: OnSecondChange R0), the site channel (Channel: the BroadcastChannel constructor,
//   null = none; _siteChannel(), _post(msg) adds `from: tabId`), the page hooks, the tab marker and the stored set.
//   slots: Runtime[] (set order = call order); with createRuntime(opts) the constructor makes slot 0 at once (no ghost
//   yet; _createRuntime(opts) passes `site: this`), so window.sumika.runtime is never null (except the off stubs,
//   main.js: phone off, unsupported browser, the visitor's or the site's off, where no Site is made or, with the hub,
//   none is started). maxGhosts: >= 1
//   (Infinity: no cap). Two configurations: `multi` = lead || maxGhosts > 1 (main.js: lead true,
//   data-max-ghosts) has the lead lock (`lead`, GhostLock(LEAD_ID) made at the first start: _newLeadLock()), `layers`
//   (GhostLayers), peers and set messages; the implicit one-ghost Site (lead: false, maxGhosts: 1, made by a Runtime
//   without a site) has none of them: no lead lock, no layers, peersFor() null, callList() null, call() refused; its
//   marker is v1 plus `ghosts` (and `carry` for a change), its prefs {ghost, ghosts: [ghost], rev} (rev +1 when the ghost changes).
//   active (the Runtime that took the keys last), rev (the last set revision written or applied), quitting (Quit is
//   closing every ghost; never sticky: set by quit() and by _runSet from markerQuit; cleared by _closeSite, by quit()
//   when every loop refused, by restart() after its teardown and at the start of _runSet).
//   The storage hub (core/hub.js): the Site is made while a HubClient main.js installed is
//   pending, so its constructor reads the empty view (language, user) and its Channel default stays undefined
//   (resolved by _siteChannel: core/platform.js channelClass()); start() with a pending hub waits for storageReady()
//   and starts again: the page hooks bind to the decided storage. storageReady({index = true}) -> Promise<void> (never
//   rejects; one promise for every caller; at once without a hub or once it decided): plants the pending hub
//   (hub.ready()), meanwhile loads the site index unless `index` is false (_fetchIndex: one SiteIndex.load in
//   flight), then _hubDecided(hub) (language.refresh(), user.refresh(); a live hub's onGone -> _hubGone); main.js
//   calls it first, before it reads the visitor's choice through the hub (index false when the site's default is off). _installPageHooks with a live hub adds _leaveHooks(win): `click` (navigatingClick(ev, win): button
//   0, no modifier, not prevented, an <a>/<area> href in the composed path, no `download`, target ''/_self (or
//   _top/_parent at the top), an http(s) URL other than this one but its fragment), `submit` to this document, and
//   `beforeunload` (no returnValue) run _leaveFlush(): each slot's Runtime._onLeave (a change under way carried on,
//   state.saveNow() then writeThrough(true), client.persist(); no lock released), then input.flush(); flushes within
//   LEAVE_DEDUPE_MS (1 s) are one; _endThrough() at pageshow or LEAVE_THROUGH_MS (10 s) later. pageshow persisted with
//   a live hub: hub.sync() first, then restart(). _hubGone(): one warn, every slot stops as for a takeover
//   (Runtime._yield, after a change under way), the lead released; nothing switches stores. setSiteBase(base)
//   (ui/thumbnail.js) at construction. Without a hub none of this runs: only the page hooks below.
//   start({cold}) -> slot 0's outcome ('booted' when any ghost booted): implicit: slot 0's start(); multi: 'none'
//   during Quit (its end shows the launcher); 'booted' at once, doing nothing, while the set already runs here (lead
//   held, a loop not closed); else _startSet: the lead (acquire, no wait) -> _runSet: quitting cleared; chooseSet over
//   runtimePrefs (fallback chooseGhost, engineSupported, maxGhosts); closed(id) = storedClosed(id) unless the id has a
//   change or call carry (it boots cold); not cold and siteClosed(ids, closed) -> _showClosed(first) ('launcher');
//   not cold, not a takeover and markerQuit(marker) -> quitting again: the set kept whole, a closed member keeps its
//   slot and does not boot, only resumed ghosts not stored closed start (_onBooted makes them resumeClose()); else
//   (not cold) closed members of an open set dropped [decision]; slots aligned to the set (_alignSlots: a slot showing
//   the ghost, or an empty one, is kept; the rest removed); the set stored again when it differs ({t:'set', cause:
//   sync}); resumed ghosts (in the marker, no change or call carry; or a takeover) start at once in parallel, counting
//   as up from the start; cold ones one at a time in set order, the next one's pack prefetched [decision]. _afterStart:
//   during a carried Quit with no slot running or holding parts -> _closeSite ('launcher'); else a ghost that failed
//   ('failed' | 'none') leaves the set (unless every slot failed; {t:'set', cause: sync}) and, when it had counted as
//   up, every ghost still up re-NOTIFYs otherghostname (_renotify; no event); nothing running: the lead goes. That
//   rule (not during a Quit) is _dropFailed(failed, why = 'did not start'), which Runtime._canvasLost also calls for a
//   ghost that cannot draw after its boot ('cannot draw'; during a Quit it only closes the site when
//   nobody is left on screen). Without the lead every ghost of the stored set starts frozen (rt.start({ghost, frozenOnly: true})); a slot already frozen
//   stays as it is -> 'frozen'. _showClosed(id): one slot, its frozen stage cleared, rt.start({ghost: id}) (the closed
//   launcher), then _idleLead() (a ghost that booted after all keeps the lead).
//   Tucked (phones, UI §9.11; any device with data-default-state="tucked", the same path): start({cold, untuck})
//   passes `untuck` to _startSet({cold, untuck}), which after the
//   index loads and before the site channel and the lead: not cold, not untuck and _tuckedStart() ->
//   _showTucked(stored ids) ('launcher'). _tuckedStart(): `tucked`, no marker ghosts, quit or carry (nothing out in
//   this tab), a stored set that is not siteClosed. _showTucked(ids): _alignSlots([ids[0]]), the frozen stage cleared,
//   tookOver false, _tab emptied, the site channel closed (undefined again: a failed call, change or tap had opened
//   it; the next tap's start opens it again), rt._showLauncher('tucked'), then _idleLead(); writes and starts nothing.
//   _untuck(rt) (the tap): start({untuck: true, cold: the stored set closed meanwhile}); a slot shown frozen here
//   (another tab runs the set): the tucked button hidden; nothing running and no closed launcher: the marker and
//   _carries the failed boots wrote cleared (so the tab's next page is tucked again), then _showTucked. _keptSet(id)
//   -> the stored `ghosts` copied, else [id] (_call's closedSet; Runtime._change's tuckedSet). _runSet unchanged.
//   restart() (bfcache): implicit: slot 0's; multi: one at a time (_restarting); waits for the set's start, each slot's
//   start and each ghost change past A's farewell (rt._committed), then every slot torn down (teardown, frozen stage
//   cleared, not up), quitting cleared, then start(). A _wake meanwhile is ignored. find(id); preferred() (the slot
//   whose loop has the keys, else slots[0]: SSP's GetPreferredActiveGhost); onScreen(except) -> Set of ids (not a slot
//   that only shows the closed launcher: _shut);
//   ghostList(rt) -> [{id, name, current, note, needs, elsewhere?: true}] (Change ghost ▸, the index's order;
//   elsewhere: on screen in another slot); callList(rt) -> the same rows with full: maxGhosts on each while a site cap is reached, or null
//   (one at a time); siteGhosts() -> [{id, name, current (the preferred slot's), running (shown here: running or frozen), active,
//   note, needs}]; running() -> [{id, name, active}] (set order, shown ones); peersFor(rt) -> {others(): every other slot
//   that counts as up (from its 'notified', a resumed one from the start, closing ones included; loop.peerInfo(), else
//   the state's `names` {sakura, kero} (the names in effect its loop stored; else the index's) and the stored
//   surfaces, -1 when none: _peerOf, EV §2.7.5), count(): slots booting or booted
//   and not closed, rt included, busy(): a call or change runs or waits, match(to): communicateTargets over the other
//   slots that are _liveSlot (EV §2.7.7)} | null. _liveSlot(rt): rt._up, not frozen, its loop booted and not closed,
//   changing or frozen (a closing one counts) [decision for changing and frozen slots]: who another ghost's talk or
//   raise can reach.
//   propsFor(rt) -> the loop's `props` (both configurations; properties.md §5.2): ghosts() = index.ghosts in index
//   order, a ghost up here (a slot whose loop is neither closed nor frozen and that is rt or _up) as its loop's
//   propRecord(), the others indexGhostRecord(g, _basePath()); active() = those slots in set order, rt included;
//   balloons() = installedBalloons(index, rt.ghost) as balloonRecord(b, _basePath()); openSettings(page) =
//   openSettings(page). _basePath(): the base URL's path, '/'-ended ('/' without one).
//   compatibleWords() -> Promise<WordSection[]|null> (properties.md §2.4; the runtime hands it to every loop as
//   `wordList`): words.js loadWordList(base, the window's fetch) of `sumika/word_compatible.txt`, made at the first
//   call and kept for the page (a missing file too); null without a window (Node). WordSection = {name, words[]}.
//   midi (a getter) -> the page's one MidiEngine (core/midi.js; one AudioContext, Worker and worklet
//   module for every ghost), made at the first ask from runtimeUrl and midiPaths(runtimeFiles); making it loads
//   nothing; null without the table's `midi` (unbundled) or where midiSupported() is false: MIDI files then go to
//   <audio>. Runtime._start builds `new PageSaori({files, drops, midi: site.midi})`.
//   openSettings(page = '') -> boolean (UI §2.13): settingsPage(page) false -> nothing, log once per page; else the
//   one SettingsWindow({user, language, onClose, phone}) (phone: the Site's, UI §9.11; made at the first open, kept as
//   _settings) open() (a second open
//   brings it to the front); onClose({touched}) touched -> notifyUserInfo(). notifyUserInfo(): every slot whose loop
//   is booted and neither closed nor frozen gets loop.notifyUserInfo() (EV §4.16). pagehide destroys the box (no
//   onClose, nothing sent; _settings null).
//   call(from, req) -> Promise<boolean> (queued, _mutate): after a set start; false during Quit; the caller still
//   booted and not closing (from null: the page API with no ghost up); then, before any slot or write, only in the tab
//   that runs the set (_leading() || await _ownSet(); else false, nothing written or posted [decision]);
//   resolveCallTarget(index.ghosts, caller, target, {byId, onScreen: onScreen(), supported}); a site cap (_count() >=
//   maxGhosts: refused, logged); raiseEvent -> the caller's loop.ghostCalling(callee info, {reason}) (its reply =
//   OnGhostCalled R1; else req.script for a script's call); a slot made on top, carry {kind: 'call', call, caller},
//   the set written ({t:'set', cause: {kind: 'call', id}}); rt.start({ghost, cold: true, call}) (no position: the
//   callee stands at its own stored places, else its own default place, UI §3.5); not booted: the slot
//   goes, the set written (sync), false; 'frozen' (a one-ghost-runtime tab holds it): it stays frozen, false; booted:
//   the callee takes the keys only when the caller had them [decision]. from null with only the closed launcher here
//   (_shut(slots[0])): the launcher's slot removed, the set written as [callee] ({t:'set', cause: call}), a plain
//   cold boot (OnBoot, OnFirstBoot if never met; no OnGhostCalled, no caller) -> true when it booted; not booted:
//   _reclose(the old stored set) (the closed launcher back, that set stored again, the lead let go). Every refusal or
//   failure after the lead was taken ends with _idleLead().
//   quit(scope, window = scope) -> Promise<boolean> (window: R2, the clicked character's; UI §2.1 Notes): implicit:
//   slot 0's loop.close(scope, {all: true, window}); multi: false while a job runs
//   or waits, the set starts, a wake runs (_waking), any slot starts (rt._starting) or a Quit is under way (that ghost
//   would never close; SSP beeps); no booted loop: false; else quitting, the tab marker written with quit: true
//   (_markTab), every booted loop's close(scope, {all: true, window}) in parallel; every loop refused: quitting cleared
//   again.
//   During Quit: start() and _relaunch 'none', call false, Runtime._change refused, _busyHere() true (a lead request
//   is answered at the site's close; a Quit is not split while this page lives). Page API: callGhost(id, {from?, ...o})
//   (from: a ghost id, default preferred(); a from not on screen here -> false, as changeGhost), closeGhost(id?, scope)
//   (that loop's close(scope): the last one's is Quit), changeGhost(id, {from?, ...o}), shells({ghost?}),
//   balloons({ghost?}), changeShell(target, {ghost?, ...o}), changeBalloon(target, {ghost?, ...o}).
//   Called by Runtime: _adopt(rt) (its constructor; once); _labelSlot(rt) (at each _start: the slot's layer made on
//   top, or relabelled; multi only; never for a removed slot); _chooseFor(rt) (implicit: chooseSet(…, max 1)[0];
//   multi: rt's own ghost, else its place in the stored set); _inMarker(id) (markerGhosts of the marker);
//   _carried(id) (implicit: markerCarry of the marker; multi: the carries loaded at the set's start); _frozenOnly(rt)
//   (a multi Site without the lead: frozen, no ghost lock); _onBooting(rt, {change, call, now, resume}) (after the resume decision: sessionEpochMs = the
//   marker's or now; the ghost joins the marker, a change or call stays carried until its boot event is sent; a
//   resumed ghost keeps an 'after' carry); _onNotified(rt) (rt counts as up: _markUp, rt._upSince);
//   _onShellChanged(rt) (Runtime._swapShell after shellChanged; multi: _renotify, every ghost up, rt too, as
//   ChangeOrReloadShellInternal [disasm 0x62177D]); _onBooted(rt, {resume, run, change, call, reload}) (not a resume, multi:
//   _renotify, every ghost up re-NOTIFYs otherghostname, rt too, after rt's boot GET as SSP's AddGhost posts it
//   [disasm 0x733045, 0x465CA3]; the carry becomes what is still owed: after a call OnGhostCallComplete to the caller
//   and OnOtherGhostBooted to the others (afterBootRefs), after a change with others on screen OnOtherGhostChanged (otherChangedRefs; prev from the change's {sakuraName, name,
//   shell, script}); sent through _owe when `run` (a resume: the replayed loop.current) ends and the set has settled
//   (_settled: the set's and every slot's start resolved), each to a peerLive loop (otherEvent); a called,
//   changed-to or reloaded (`reload`: \![reload,ghost], nothing owed, EV §2.10) ghost comes on top; a resumed ghost while quitting (a Quit the marker carried): loop.resumeClose() a
//   microtask later); _onActivate(rt) (active = rt; every other loop deactivate(); its layer raised);
//   _onTalk(rt, {phase, run, flags}) (OnOtherGhostTalk to every other loop whose otherGhostTalk[phase],
//   otherTalkRefs(talker.peerInfo(), run, flags)); _onCommunicate(rt, {communicate}) -> Promise (EV §2.7.7; multi
//   only: after _upSettled(), each id in order, awaited one at a time: the slot showing that ghost, when it is not rt
//   and _liveSlot, gets loop.communicated(c); ids no longer on screen skipped; errors logged once; no page-wide queue);
//   _upSettled() waits for the starts of the slots that are _up (a resumed page's, its takeover's lock wait included:
//   rt._resuming, set by _runSet; a ghost past its NOTIFY batch), each for at most site.upWaitMs (default 30000) on
//   site.clock ({now, setTimeout, clearTimeout}; tests: a FakeClock) from when it counted as up (rt._upSince: _runSet
//   for a resumed page, else _markUp at its 'notified') [decision], never for one still loading its engine nor the
//   set's start (no start that never ends holds the raises and talks for good);
//   _onRaiseOther(rt, {ghost, id, refs, notify, live?, done?}) -> Promise, never rejects (EV §2.7.9): the raiser's
//   loop captured at the emit, the job chained on _raiseTail (one FIFO per page, tag order), done() called when it is
//   over; _raiseOther(rt, raiser, ev) after _upSettled(), dropped when live() is false (a repeating timer cancelled or
//   replaced meanwhile): candidates in set order = the raiser (its loop, or a slot showing its ghost id again after a
//   restart) and every other _liveSlot (multi only); ghost undefined -> failure ['invalid']; an empty event ->
//   [invalid when the argument names a candidate or is random / lastinstall…, else notfound; the argument];
//   raiseTargets; none ->
//   ['notfound', argument, event, ...refs]; per target in order: the raiser and a target no longer _liveSlot skipped
//   silently, lockReason -> that reason, else raisedByOther(event, refs, {notify, sender: the raiser's sakura name}),
//   !ok -> String(status); any failure -> one notifyEvent(OnRaiseOtherFailure | OnNotifyOtherFailure, [reasons \x01,
//   sakura names \x01, event, ...refs], {senderType: 'internal,raise'}) on the captured raiser loop (refused there once
//   it closed or changed), awaited inside the job. References become strings ('' for null). Test seam: _random();
//   _onClosed(rt, {script, peer}) (implicit: the marker cleared, the
//   closed launcher; multi: rt's launcher hidden first (rt._hideLauncher(): a 'minimized' button goes with its ghost);
//   another slot counts as on screen while _running(s) or it still has parts (a ghost inside its own close, unloading,
//   its 'closed' not handled yet: Runtime._onClosed tears down before calling the Site), so only the last 'closed'
//   closes the site and no ghost is torn down mid-unload; during Quit: nothing until none is left, then _closeSite;
//   none left: _closeSite (quitting cleared, slots after the first removed, the marker cleared, {t:'set', cause: quit}
//   posted, the lead let go, the first slot's closed launcher; prefs kept whole); else Close of one: the slot removed
//   (_removeSlot), the set written ({t:'set', cause: {kind: 'close', id}}), then every loop left gets
//   otherEvent('OnOtherGhostClosed', otherClosedRefs({...peer, script})) and notifyOthers(), in that order in its
//   queue (a loop that is itself closing is not peerLive: no event)); _replaceInSet(rt, fromId, toId) (prefs with
//   toId in rt's place, the layer relabelled, {t:'set', cause: {kind: 'change', from, to}});
//   _carry(rt, {id, kind: 'change', change}) (pagehide mid-change: prefs and marker with id in rt's place and a change
//   carry; not posted); _relaunch(rt) (implicit: rt.restart({cold: true}); multi: 'none' during Quit, else
//   start({cold: true}): the whole stored set, one at a time); _wake(rt) (implicit: rt._tryTakeover(); multi:
//   _takeOverSet, one at a time, not while hidden, yielding or restarting: the lead requested and awaited, then
//   _runSet({takeover: true}) (the stored set re-read, slots reconciled, every frozen slot's _takeOver() in parallel);
//   with the lead held only frozen slots ask for their own ghost (a one-ghost-runtime tab's)); _leading()
//   (sync: not multi, or the lead held and nothing yielding, restarting or waking); _ownSet() -> Promise<boolean>
//   (the page API's set changes, Runtime._change and _call; implicit: true; after the set's start; false while
//   yielding or restarting; lead held: a wake under way ends first, then true unless yielding; no lead: false while
//   waking or while a slot shows frozen, else lead.acquire() with no wait: false when another tab holds it; this is
//   how a tab whose site closed here (only the closed launcher) takes the lead [decision; SSP is one process]. Known
//   gap: a wake that waits for a ghost lock an old-code tab holds keeps calls and changes waiting, and
//   quit() refusing, until that tab is hidden or closed); _idleLead() (multi, nothing _running: the lead let go;
//   after a refused or failed call or change from the closed launcher, and in _showClosed); _slotIdle(rt) (a
//   takeover asked meanwhile is answered); _mutate(kind, job) (FIFO of calls and ghost changes; an idle queue runs
//   the job at once); _announce(id) (a carried change reached its ghost: {t:'set', cause: change} posted);
//   _layoutDock() / _dockSlot(rt) (each visible launcher's place, set order: Launcher.setSlot); _raise(rt).
//   Internal (multi): _shut(rt) (no parts, not starting, _launcherMode 'closed', or 'tucked' with nothing of the slot
//   shown frozen here (not frozen, no read-only state): only the closed or tucked launcher; onScreen()
//   and _count() leave it out, so Call ghost ▸ rows no longer mark its ghost elsewhere and a call may name it);
//   _count() (slots with a ghost, not _shut: the cap); _renotify() (every slot up re-NOTIFYs otherghostname);
//   _reclose(ids, mode = 'closed') (a call from the closed or tucked launcher did not boot: ids stored again ({t:'set',
//   cause: sync}), the marker cleared, _showClosed(ids[0]), or _showTucked(ids) for mode 'tucked': _call reads the
//   shut slot's mode before removing it; Runtime._change's failed change from the tucked button ends here too);
//   _removeSlot(rt) also sets rt._removed (a start of it still under way stops, a
//   frozen start builds nothing); _releaseLead() also clears _leadAsked and _yieldWhenHidden (releasing answers any
//   request made meanwhile).
//   Lead requests (_onLeadRequest: 'takeover-request' on the lead, or on a ghost lock in a multi Site): _busyHere() (a
//   start, job, wake, slot start or change, or a Quit under way) -> answered after it (_leadAsked; a Quit's at the
//   site's close: the lead goes and the asking tab finds the closed launcher); nothing running -> the lead goes;
//   visible -> _yieldWhenHidden; hidden -> _yieldAll(): every slot's _yield() (suspend, teardown, its lock let go,
//   frozen), then the lead. A _wake while yielding is ignored (no split). Known gap: the quitting page's pagehide lets
//   the lead go, and a takeover then (_runSet({takeover: true}) ignores markerQuit) resumes the ghosts still saying
//   goodbye standing.
//   Site messages: own ones (`from`) and any before the index is loaded are ignored. {t:'view', id} ->
//   find(id)._followView(). {t:'set', ghosts, rev, cause: {kind: 'call', id} | {kind: 'close', id} | {kind: 'change',
//   from, to} | {kind: 'quit'} | {kind: 'sync'}} and the legacy {t:'ghost', id} (= a change to id): implicit -> slot
//   0's _follow(to) for a change; multi -> ignored when rev <= the last applied; quit not followed; else _reconcile:
//   diffSets: replaced -> rt._follow(new), and without the lead gone -> the slot removed (never the last), added -> a
//   frozen slot; slots sorted to the set's order.
//   A page older than the published build (safe updates): runtimeFiles (core/build.js FILES; null unbundled) goes to
//   every slot (_runtimeOpts() -> {base, defaultGhost, defaultBalloon, runtimeUrl, runtimeFiles}); build = the build
//   this page runs (BUILD). staleCheck(reason = '') -> Promise<boolean>, never rejects (reason 'engine' |
//   'index-newer' | 'state' | 'prefs'): (1) no runtimeFiles -> false; (2) fetch(new URL('build.json', runtimeUrl),
//   {cache: 'no-cache'}) not ok, unreadable or with no `build` string -> false; (3) it names this build -> false (the
//   failure is genuine; for 'state' or 'prefs' a rollback across a schema bump, logged once: schema.js); (4)
//   sessionStorage RELOADED_KEY 'sumika.reloadedFrom' holds this build already -> false, logged once (a reload did not
//   bring the published build); (5) the guard is written (= this build); it is not confirmed (the session's
//   confirm(k, v) when it has one: core/platform.js tabSession, the storage hub's flush; else the read-back, storage.js
//   session: site data blocked) -> false, since a reload could repeat; (6) fetch(runtimeUrl, {cache: 'reload'}) not ok,
//   rejected, or its text without the published build -> false, and the guard put back as it was (nothing was
//   reloaded); (7) reload() (location.reload()) -> true, logged at info (it throws -> false). Answers are shared: one
//   check in flight serves every trigger, a true answer stands for the page, a false one for STALE_RECHECK_MS (5 min
//   on site.clock), after which a trigger checks again (a long-open tab whose first check came before an update).
//   Triggers: Runtime._startEngine's failure ('engine'); _loadIndex when SiteIndex.load rejects with code
//   'index-newer' (true -> never settles; false -> rethrows, so no ghost starts); Runtime._indexFiles when a gone
//   manifest's re-read index is newer (loader.js _files: 'index-newer'; true -> never settles; false -> rethrows, the
//   start fails); Runtime._start right after StateStore.open when state.newer ('state'); start() when
//   runtimePrefs.newer() ('prefs', before _begin(o), the
//   start proper: true -> never settles, false -> the start as ever, the prefs read for what fits; prefs not newer:
//   start() stays synchronous up to _begin); _writeSet when runtimePrefs.set refuses ('prefs', not awaited).
//   Whoever awaited a true answer never continues (a promise that never settles), so while the page reloads nothing
//   writes: a failed start reaches neither _afterStart (the slot removed, the set rewritten, the NOTIFYs) nor _call's
//   failure branch, and a ghost change does not bring the old ghost back; the stored set, the marker and its carries
//   stay for the next page, which resumes them. _writeSet(cause, {post, ids}) when runtimePrefs.set refuses (prefs a
//   newer Sumika wrote): rev not raised, the tab marker still written, no set message posted (a rev never stored would
//   break "the stored set = the slots" in the other tabs), staleCheck('prefs'). start() logs `sumika <VERSION> build
//   <build>` at debug, once per page. Test seams: the fetch, reload and session options (fields _fetch, _reload,
//   _session).
//   Page hooks (_installPageHooks(win = window), once, none without a window): language.bindWindow(win); pagehide ->
//   every slot's _onPageHide() (one that throws is logged, the others go on; its state saved, the engine's files asked
//   for, but not with the storage hub when the page goes into the back/forward cache: platform.hub.hidden, "Hub
//   protocol"; its lock let go), then input.flush(), then the lead let go;
//   pageshow persisted -> restart(); the document (_doc()) hidden -> _yieldAll() when asked meanwhile, and _yield() of
//   every slot with _yieldWhenHidden (implicit). chooseGhost(index, {stored, defaultGhost, supported}) and SITE_CHANNEL
//   ('sumika/runtime') are defined here and re-exported by runtime.js. Test seams: _createRuntime(opts),
//   _newLeadLock(), _doc().
// src/core/runtime.js — Runtime({site?, base, defaultGhost, defaultBalloon, runtimeUrl, Channel?, language?,
//                       runtimeFiles?}).start({cold, change, call, ghost, frozenOnly}) ->
//                       'booted'|'frozen'|'launcher'|'failed'|'aborted'|'none': loader -> worker -> stage ->
//                       balloons -> player -> event loop. Holds the last file drop made before the loop booted (engine loading; a frozen tab, where a drop also takes the ghost (with
//                       several ghosts: the set) over) and emits it on the stage after boot (at most HELD_DROP_MS = 30 s).
//   One ghost, per ghost under a Site (above): without `site` it makes an implicit one-ghost Site from the other
//   options (lead: false, maxGhosts: 1; runtimeFiles too, default core/build.js FILES) and is its slot 0, so it
//   runs one ghost alone (tests, callers without a Site); with one, Channel, language and runtimeFiles are the Site's.
//   _client() starts the worker from new URL(workerPath(site.runtimeFiles), runtimeUrl) (unbundled:
//   engines/worker.js). _start asks site.staleCheck('state') right after StateStore.open when state.newer, before
//   anything is shown (true: never settles). rt.site; rt.sid (page-unique number, never reused); rt.layer (its
//   `.smk-ghost` element in a multi Site, made by site._labelSlot at its first _start; null otherwise or headless);
//   get/set rt.index and rt.language and get rt.tabId, rt.input, rt._channel are the Site's. _start({ghost}) runs that
//   ghost (the Site's set, a change, a call), else site._chooseFor; a carry from site._carried makes it cold: 'change'
//   with OnGhostChanged, 'call' with OnGhostCalled; frozenOnly or site._frozenOnly(rt) (a multi Site without the lead)
//   -> straight to the frozen stage, no ghost lock; a frozen stage shown so far is cleared before a boot or the
//   closed launcher. rt._removed (set by site._removeSlot): _start (after the index loads and after the ghost lock)
//   and _boot return 'aborted' and build nothing. One frozen stage per slot: _startFrozen first clears any earlier
//   one (_clearFrozen: stage, visibility / focus / drop listeners) and keeps the token rt._frozenGen (+1 at each
//   _clearFrozen); after each await, a moved token or a removed slot destroys what it built and installs no listener
//   (_redrawFrozen checks the same). _boot({cold, change, call, silent}) asks site._inMarker, site._onBooting
//   (with resume), site._ensureInput, site._onBooted({resume, run, change, call, reload: silent}) (a reload comes on
//   top as a change does, EV §2.10); start / _start pass `silent` (\![reload,ghost]: loop.boot({silent})); the tab
//   marker, the stored set and
//   the site channel are written only by the Site. Views get `root: rt.layer` (_createStage, _createBalloons,
//   _createDialogs, the frozen and swapped stages) only when a layer exists (_rootOpt); _createDialogs passes root ||
//   getRoot(). The EventLoop gets peers = site.peersFor(rt), layer = rt.layer, user = site.user, props =
//   site.propsFor(rt) and paths {site: site._basePath(), ghost: _ghostInfo(ghost).path, shell, balloon}; the Menu
//   gets preferences: () => site.openSettings() (Options ▸ Preferences…, UI §2.13); loop.boot({resume, firstBoot,
//   changed: change, called: call, silent}) -> {run}; 'booted' {ghost, resume, run}. loop.shioriReloader =
//   _reloadShiori(parts) while that loop runs (else false). The running loop's 'call' ->
//   site.call(rt, req), 'quitall' -> site.quit(scope, window), 'activate' -> site._onActivate(rt), 'notified' ->
//   site._onNotified(rt, ev), 'talk' -> site._onTalk(rt, ev), 'communicate' -> site._onCommunicate(rt, ev),
//   'raiseother' -> site._onRaiseOther(rt, ev), 'restored' -> the launcher hidden and site._raise(rt), 'trayicon' ->
//   _showLauncher('minimized') again while that button shows (the new icon, UI §2.6).
//   loop.ghostFinder = _changeFinds(target, {byId}) while that loop runs: resolveGhostTarget(index.ghosts, own id,
//   target, {byId, exclude: site.onScreen(rt)}) found a ghost (SSP's GetGhostIDFromTag [disasm 0x62A890]).
//   Menu gets calls: () => site.callList(rt). _takeOver(): a slot that runs already -> 'booted' (no second engine); a
//   frozen slot of a multi Site runs again (its ghost lock made if none, requestTakeover (a one-ghost-runtime tab),
//   acquire with wait, the frozen stage cleared, the state reloaded, tookOver, start({ghost})). A 'takeover-request'
//   on its ghost lock goes to site._onLeadRequest() in a multi Site (the set goes all or nothing), else to
//   _onTakeoverRequest. _showLauncher(mode) sets rt._launcherMode, places the Launcher at site._dockSlot(rt), sets its
//   image to launcherIconPath(ghost, mode, _minimizedState()) as a URL (siteUrls without versions: an <img>, so the
//   plain URL; null: the initial letter; never the
//   thumbnail, UI §2.6) and calls site._layoutDock(); _minimizedState() = the running loop's `minimized`, else the
//   stored state's (a frozen slot), else null; _hideLauncher(); _launch(mode) clears the mode: 'minimized' with a loop -> loop.restore();
//   'minimized' with no loop in a multi Site: a frozen slot shows its button again and asks for the set
//   (site._wake(rt)), else nothing (never a cold relaunch); 'closed' (and 'minimized' with no loop, implicit) ->
//   site._relaunch(rt). _slotFreed ends with site._slotIdle(rt).
//   Phones (UI §9.11): _launcherMode 'minimized' | 'closed' | 'tucked' | null. _showLauncher('tucked') shows Iconify's
//   icon (launcherIconPath(ghost, 'minimized', null): iconMinimize, else icon), and on a phone every launcher is
//   new Launcher({..., phone: true}) (the safe-area insets; desktop: no `phone` key). _launch('tucked'): the button
//   shown again and setBusy(true), then site._untuck(rt) (_boot hides it right before OnBoot). _change records after
//   the lead check (once a set's start a tap began has ended), for a slot with no parts showing the tucked button,
//   tuckedSet = site._keptSet(prev.id); a change that then fails tears down, puts this.ghost back to prev and ends in
//   site._reclose(tuckedSet, 'tucked') (the tucked button back, never a cold boot of prev).
//   Ghost change (EV §2.5, §2.7.2): changeGhost(id) / the loop's 'change' -> through site._mutate('change', …) (the
//   Site's queue; idle: at once) -> refused during Quit (site.quitting: 'Quit is under way; no ghost change') ->
//   resolveGhostTarget(ghosts, currentId, target, {byId, exclude: site.onScreen(rt)}) (exclude: random / sequential
//   skip ghosts on screen in another slot, a named or byId one is null) -> refuse a missing engine (engineNote) ->
//   site._leading() (sync: the first steps stay synchronous in the lead tab and the implicit Site) || await
//   site._ownSet(), else false ('the ghosts run in another tab; no change here': no farewell, no lock, nothing written
//   or posted; window.sumika.runtime.changeGhost too) -> loop.farewell -> rt._committed = true (cleared when the change
//   job ends; site.restart() waits for such a change) -> take B's GhostLock -> site._replaceInSet(rt, A, B) (the
//   stored set with B in A's place, {t:'set', cause: {kind: 'change', from: A, to: B}} on BroadcastChannel
//   SITE_CHANNEL 'sumika/runtime') -> loop.leave -> the slot removed meanwhile (_removed): B's lock disposed, false ->
//   teardown -> start({cold: true, change, ghost: B}) in the same Runtime (same slot, layer and dock place); B not
//   booted -> site._replaceInSet(rt, B, A) and A cold-boots back; nothing came up -> site._idleLead(). From the closed
//   launcher (no A running) B cold-boots with OnBoot in the launcher's slot. Emits 'changed' {from, to}. In a multi
//   Site the change's previous-ghost object also carries `shell` (peerInfo().shell: OnOtherGhostChanged R14).
//   req.reload (the loop's reloadGhost, \![reload,ghost], EV §2.10): _change({…, reload}) takes only the running ghost
//   itself (another target or none running: false), skips the farewell and _pending (nothing carried: a page left
//   meanwhile resumes it [decision]), keeps the lock, then leave -> teardown -> start({cold: true, change: null, ghost:
//   A, silent: true}) (the fallback boot too): OnDestroy [''], a cold boot without a boot event.
//   _boot keeps the change carried in the tab marker (site._onBooting) until OnGhostChanged is sent
//   (site._onBooted); _onPageHide() during the farewell or unload writes it (_carryChange -> site._carry, also the
//   stored set with B); _start then cold-boots that ghost with the change (site._carried) and announces it.
//   Takeover requests and _yield() during a change wait for its end (and for the script changes queued behind it,
//   below). Only the running loop's 'closed' (with its info, to _onClosed(info): its peerInfo() taken, teardown
//   keeping the state, the lock released, then site._onClosed(rt, {script, peer})), 'minimized', 'restored', 'change'
//   and the events above reach the runtime. ghostList() = site.ghostList(rt). _follow(id): another tab changed this
//   slot's ghost (suspend, teardown, start({ghost: id}); a shell or balloon change and the script changes queued behind
//   it end first; its own ghost or one the index lacks: nothing).
//   _followView(): {t:'view'} for this ghost (_redrawFrozen, or _viewMissed while the frozen stage is built).
//   _tryTakeover(): (implicit Site) a frozen ghost asks for its lock (visible tab only, one request per lock), then
//   clears the frozen stage, reloads the state and starts with tookOver; _startFrozen's listeners and held drops reach
//   site._wake(rt). _launch('closed') -> site._relaunch(rt). `language` (the Site's; bound to the window with the page
//   hooks) goes to the dialogs, the event loop, UserScaling, the Menu and the Launcher; every _start calls
//   language.refresh() first (a bfcache restore missed 'storage' events), before the boot's NOTIFY OnLanguageChange.
//   chooseGhost(index, {stored, defaultGhost, supported}) passes over ghosts whose engine is missing.
//   Which shell and balloon boot (EV §2.6, BA §1.6): bootShellId(ghost, ghostDescript, stateData) = the stored shell
//   when shellChosen and the index still lists it, else defaultShellId; _boot uses stage.shellId (the folder Stage
//   loaded) from there on (state.shell, paths.shell, the loop's `shell` {id, name}, the menu's shellDir); a picked
//   shell the site lost clears shellChosen [decision]. chooseBalloon(index, ghost, {shellBalloon, choice,
//   ghostDescript, pageDefault}) -> {entry, from, isDefault?}|null: the first installed balloon (shells.js
//   installedBalloons) named by the shell's remembered balloon, the stored choice, the descript keys, install.txt
//   (the index's `balloon`), else the site default (data-default-balloon when installed, else index.defaultBalloon;
//   isDefault), else null = the built-in one. _loadSkin(files, {shellId, ghostDescript}) -> {skin, id (folder),
//   name (descript name), path ('/'-ended), files (the balloon's GhostFiles), from, isDefault?}; _loadBalloon(entry,
//   files) loads the running ghost's own balloon through files.sub(id) (its share of the ghost pack), any other through
//   _indexFiles('balloon', id) (index.balloonFiles: a site or hoisted manifest; _ghostCommon's ghostFiles goes through
//   it too: an 'index-newer' rejection asks site.staleCheck('index-newer'), and true never settles, as _startEngine's
//   failure). At boot state.balloon = the booted balloon's folder id only
//   when it came from 'choice' (rule 2; an older descript name becomes the id), or from 'descript' / 'install' (rules
//   3–4) while state.balloon is empty; never from 'shell' (1), the site default (5) or the built-in one (6), so a stored
//   choice the site lost is kept and comes back when re-added (BA §1.6, D5) [decision]. Balloon ▸ / \![change,
//   balloon] store the pick (default included) as the ghost's and the shell's; a silent per-shell swap stores nothing.
//   The EventLoop gets the name as `balloonName` (OnNotifySelfInfo R5; '' = built-in).
//   Per-shell dress-up (EV §2.6): stageStateForShell(saved, shellId, shells) gives a stage state stored for another
//   shell (state.stage.shell ≠ shellId) that shell's memory's binds instead of its own and no `last` sizes, with
//   `shell: shellId` (Stage's B2 guard); withShellBinds(shells, shellId, stageState) records a stage's ON ids as that
//   shell's (a copy); shellMemory(shells, id) (any case); swapStageState(oldState, shellId, shells, shown) = the swap's new stage state
//   (scopes 0, 1 and the shown ones keep pos and alpha, surface -1, a hidden \0/\1 stays hidden; every other \p[n]
//   keeps only {pos}; no align, no scaling; the shell's remembered binds). coldStageState(saved) = a cold boot's
//   (\0/\1: pos, binds, align, scaling, alpha, visible; every \p[n]: binds and pos only, so no window until a script
//   shows it, then at its stored place; UI §3.3). Places are per ghost: a call, a change or a set's start boots each
//   ghost from its own state, and nothing passes a place between ghosts (UI §3.5).
//   Shell ▸ / Balloon ▸ (UI §2.11): shellList() -> [{id, name, current}] (visible shells, SSP's name order);
//   balloonList() -> {top, all} (shells.js balloonMenu over installedBalloons and the ghost descript's keys).
//   changeShell(target, opts) / changeBalloon(target, opts) -> Promise<boolean> (page API; through the loop's
//   changeShell/changeBalloon with {byId: true, raiseEvent: true, scope: 0, ...opts}, so its refusals apply).
//   loop.viewSwitcher = _requestView(req, queued?): one change slot (_changing) shared with ghost changes
//   (_requestChange(req, queued?)). While it is held a menu or page request (fromScript false) is refused; a script's
//   (\![change,shell|balloon|ghost], \+, \_+) goes through _chainChange(again, queued): it waits for the slot and
//   then runs as one more request, only while the same parts (ghost and loop) still run (else false), before a
//   takeover asked meanwhile. It is refused while _waitingTalk (a raise-event shell change waits for OnShellChanging's
//   talk; a ghost change from its start, also a queued one and one waiting for a page load's boot, until its farewell
//   is over: queuing would hold that talk) and, in the loop, during a ghost change's farewell. Exported
//   MAX_CHAINED_CHANGES = 4 queued in a row [decision]; the 5th is refused (warning); the count resets when the slot
//   frees with nothing queued, and a request made while the slot is free is a new one (one per script, as SSP).
//   _slotFreed() (both slot holders call it): queued script changes first, then a takeover asked meanwhile. A shell
//   change without raise-event and every balloon change hold the script at its tag until the queued change ran.
//   Shell: resolveShellTarget over every shell of the index entry -> with raiseEvent loop.shellChanging (_waitingTalk
//   meanwhile; not ok: nothing changes) -> _swapShell(entry, {event: true, defer: fromScript && !raiseEvent}):
//   loop.detachStage(); the old stage's binds into state.shells; state.shell / shellChosen and state.shellSwap =
//   {surfaces} (the detached surfaces over an earlier swap's still undecided ones) stored at once (saveNow);
//   _createStage({files, shellId, ghostDescript, state: swapStageState(...), scale: the old stage's}) (on a phone:
//   `phone`, and `scale` only for a stored pick, so the new shell fits itself; UI §9.11) (a failure
//   re-attaches the old stage and restores shell / shellChosen / shellSwap); balloons.setStage, dialogs.setStage,
//   loop.attachStage, scaling.stage, menu.setShell({stage, shellDir}); the old stage destroyed; the balloon the new
//   shell boots with (_shellBalloon: chooseBalloon with the shell's memory, the choice, the descript, the page default)
//   silently when it differs (_swapBalloon silent: no events, nothing stored; none picked: the current one stays);
//   await menu.odmReady (the SHIORI's menu look that menu.setShell asked, UI §2.3; torn down meanwhile: done);
//   loop.shellChanged({surfaces, event, defer}); _settleSwap clears shellSwap at once (no defer, a 204 restore (shellChanged {restored}, also when it left
//   every scope hidden), or a surface is already set), else when the loop's next 'play' of an OnShellChanged run starts; with no defer, no
//   surface and a shell change queued behind the slot (_chainShells: 333-4.05's reply) it keeps it as _chainMark for
//   that swap to carry on (`undecided`), and _slotFreed drops it when the chain ends and no swap took it over; saved;
//   {t:'view', id, from} posted; site._onShellChanged(rt) (otherghostname to every ghost). req.reload
//   (\![reload,shell], \![reloadsurface]; EV §2.10): _changeShell swaps to the shell in use (_currentShellId; its index
//   entry, else {id}) with _swapShell(entry, {event: false, reload: true}): no OnShellChanging, no OnShellChanged
//   (the surfaces restored), and shellChosen left as it was [decision].
//   Balloon: resolveBalloonTarget over installedBalloons -> _swapBalloon(entry, {event, defer:
//   fromScript, silent}): load (a failure or a skin without descript changes nothing), balloons.setSkin,
//   dialogs.setSkin, state.balloon and state.shells[current].balloon (not when silent), loop.setBalloonInfo,
//   loop.balloonChanged (not when silent). req.reload (\![reload,balloon]): the balloon in use (parts.balloon.id among
//   installedBalloons; none: false) with _swapBalloon(entry, {event: false}): stored, OnNotifySelfInfo only.
//   settleSwapSurfaces(stage, swap) (exported): each scope that showed a surface before the swap and has none as stored
//   gets that id back (PopSurfaceStatus); \0 / \1 whose id the new shell lacks get their default surface; scopes hidden
//   before stay hidden. _boot calls it on a resume (also a takeover) while state.shellSwap is set, then clears the
//   marker (cold boots too); _frozenStage applies it without clearing. No OnShellChanged on the next page [decision].
//   Other tabs: {t:'view', id} makes a frozen tab of that ghost rebuild its stage from the stored state (_redrawFrozen;
//   \0/\1 without a surface get their default ones) [decision]; one that arrives while this tab's frozen stage is
//   still being built (state read, nothing running here) sets _viewMissed (reset at StateStore.open), and
//   _startFrozen redraws once the stage exists. A {t:'ghost'} message waits for a shell or balloon change and the
//   script changes queued behind it. VERSION ('1.0.0', defined in events.js, re-exported): window.sumika.version
//   and About.
//   _infoData(parts) -> {sources: [{kind:'ghost'|'shell'|'balloon', name, files, descript}], version}: the Menu's
//   `info` provider (ghost root + ghost/master/descript.txt, stage.shellFiles + shell descript, balloon files + skin
//   descript).
//   _boot passes the ghost's stored scales to _createStage({..., scale}) and _createBalloons({..., scale}) (frozen
//   stages too) and gives the Menu a UserScaling (parts.scaling). On a phone (site.phone; UI §9.11) the stage
//   (boot, frozen, swap), the balloons, the dialogs and UserScaling also get `phone`, and the stage and balloons get
//   `scale` only for a stored pick (none: they start at their fit); after a balloon change's setSkin, scaling.refit().
//   Desktop: no `phone` key anywhere. parts holds files, ghostDescript, stage, skin,
//   balloon {id, name, path, files}, balloons, dialogs, client, loop, player, menu, scaling. menu.prefetch(0) and
//   prefetch(1) after boot (each: that scope's gate, menuGateIds, then its own menu's ids).
//   Test seams: _newLock(id), _createStage, _createBalloons, _createDialogs, _createPlayer, _startEngine,
//   _engineStartOptions, _ghostCommon, _doc() (the document a tab's visibility is read from), _onPageHide() (a change
//   under way carried on, state.saveNow(), client.persist() unless platform.hub.hidden, the lock let go), _onLeave()
//   (the storage hub's leave-flush, Site._leaveFlush: _onPageHide's writes without the lock release, then
//   state.writeThrough(true)),
//   _loadSkin(files, {shellId, ghostDescript, onCanvasLost}), _loadBalloon(entry, files, {onCanvasLost}),
//   _balloonSkin(files, o) (BalloonSkin.load(files, o)).
//   A canvas that cannot draw (core/canvas.js): every stage (boot, swap; frozen below), the balloons
//   and every skin load get `onCanvasLost` (on every browser and screen: stage and balloons options gain that key
//   only), which calls _canvasLost(kind, parts): once per parts (parts.lost = kind). While _boot builds (parts.booted
//   is set right after loop.boot) it only marks; _boot's lostCheck throws Error("<id> cannot be drawn: the browser
//   gave its <kind> canvas no drawing memory …") after the stage and skin, after the dialogs, after the engine is up
//   and after loop.boot, so start()'s catch logs it once ('failed to start'), tears down (the engine stopped), lets
//   the lock go and resolves 'failed' (Site._afterStart drops her if others run). Later (booted): one log.error,
//   parts.stage.setVeiled(true), balloons.hideAll() and, unless the loop is frozen or closed already, loop.suspend()
//   begun (parts.stopped), all at once: saved and persisted as for a takeover, no OnClose, no talk, timer or event of
//   hers from then on, so a change under way ends early (OnShellChanging's wait and a farewell: not ok, cancelled; a
//   swap: shellChanged / balloonChanged send nothing, _settleSwap keeps state.shellSwap while parts.lost and nothing
//   was shown). Then _endLost: parts.stopped awaited, then the start and every change under way (_starting,
//   _changing); if the parts are still hers, loop.suspend() when none was begun, setVeiled(true) and hideAll() again
//   (what the change put up), state.saveNow() when the change left it dirty, _teardown(), the lock let go,
//   site._dropFailed([rt], 'cannot draw'). A frozen stage gets onCanvasLost (kind, stage) => _frozenLost: one lost
//   while _frozenStage builds it is destroyed and not shown (one error, null); one shown: one error, frozen = null and
//   that stage destroyed, the takeover listeners kept (state.readOnly still marks the slot frozen).
//   _startEngine(files, {resume, bootEpochMs, sessionEndMs = 0}) -> {client, r}: a new client, ShioriClient.start with
//   _engineStartOptions(files, {resume, bootEpochMs, sessionEndMs}) = {engine: ghost.engine || 'satori', engineUrl:
//   new URL(enginePaths(engine, site.runtimeFiles).js, runtimeUrl) (the build's engines/<engine>.<h>.js; unbundled
//   engines/<engine>.js), wasmUrl (the table's engines/<engine>.<h>.wasm; the key only with a table: unbundled, no
//   wasmUrl key), files, resume, volatile = state.data.engine on a resume, bootEpochMs,
//   sessionEndMs as given, storeNamespace, storeKey, engineOpts, and with the storage hub storePort (_storePortOpt():
//   core/platform.js storePort(), a fresh MessagePort per start; without the hub the key is absent)}. A start that fails (the client terminated) awaits
//   site.staleCheck('engine') before it rethrows; true: it returns a promise that never settles (a page whose own
//   worker or engine files are gone; this covers boot, call, change, a crash restart and a failed SHIORI reload,
//   which restarts through _onCrash). _reloadShiori(parts) (\![reload,shiori], EV §2.10; the loop's
//   shioriReloader): parts.client.reload(() => _engineStartOptions(parts.files, {resume: false, bootEpochMs:
//   parts.bootEpochMs})) -> true while the same parts run; false when torn down, the client has no reload, or the engine
//   was stopped meanwhile (error.stopped); a load that failed: false and _onCrash() (a restart from the store) [decision].
//   _boot passes sessionEndMs = state.data.savedAt on a cold boot of a stored state (!resume && !state.isNew; else 0),
//   read before its own state write (the time the ghost's last session ended, for Kawari's D6: kawari-wasm.md §8); a
//   crash restart is a resume (0). Satori: _engineFiles (ghost/master's text
//   files, ENGINE_TEXT / ENGINE_SKIP, ghost/master-relative), engineOpts null. A root engine (rootEngine(engine) in
//   engine-files.js: YAYA, Kawari): _rootFiles(files, engine) -> rootFilePlan over the ghost root by the engine's
//   patterns, every buffer a copy (GhostFiles hands each caller the same ArrayBuffer and start() transfers it: the
//   readme window and a crash restart keep theirs); a file that cannot be read joins the placeholders (warn);
//   engineOpts {ghostId, placeholders, site: siteView(index)}, YAYA's with `module: yayaModule(ghost)` too (yaya-wasm.md,
//   MEMFS); Kawari's has no module. Then log.debug(`engine <engine> loaded in <ms> ms`).
// src/core/engine-files.js — page-safe (no engine imports): the files a root engine's worker gets (Satori's list
//   stays engineFileList in runtime.js). YAYA_TEXT (txt dic ayc aym ini csv dau json xml yaml yml toml htm html m3u),
//   YAYA_SKIP (profile/, *_variable.*, *.log, *.dll, *.exe: never sent), YAYA_MAX_BYTES (4 MiB = index_site.py
//   PACK_MAX); KAWARI_TEXT (YAYA_TEXT plus kis kaw = index_site.py KAWARI_PACK_EXT), KAWARI7_TEXT (KAWARI_TEXT plus
//   kdf dat = index_site.py KAWARI7_PACK_EXT), KAWARI_SKIP (YAYA_SKIP plus satori_save*); ROOT_ENGINES (frozen, =
//   index_site.py ROOT_PACK_EXT's keys) {yaya: {text: YAYA_TEXT, skip: YAYA_SKIP}, kawari: {text: KAWARI_TEXT, skip:
//   KAWARI_SKIP}, kawari7: {text: KAWARI7_TEXT, skip: KAWARI_SKIP}}; rootEngine(engine) -> that entry (any case) | null
//   (Satori, every other name); rootFilePlan(files /* the ghost root's GhostFiles: its manifest */, {text,
//   skip, max = YAYA_MAX_BYTES}) -> {bytes, placeholders} (ghost-root-relative, manifest order: `skip` left out, `text`
//   within the cap with bytes, every other file an empty placeholder); yayaFilePlan(files) = rootFilePlan(files,
//   ROOT_ENGINES.yaya); yayaModule(ghost) (the index's `module`, else the stem of `shiori`, else 'yaya');
//   siteView(index) (yayaSite: the same function) -> {ghosts: [{id, name, sakuraName, keroName, craftman, shiori}],
//   balloons: [id]} (CR/LF stripped; engineOpts.site); masterRel(rel) -> the path inside ghost/master as
//   EmscriptenShiori.masterPath resolves it (`\` as `/`, empty and `.` segments dropped, `..` resolved) or null when it
//   leaves the folder; personalFile(rel) -> true for a resolved personal file (profile/, *_variable.*, satori_save*,
//   *.log) or null (--param-input-file, EV §4.15); visitorFile(stored, rel, prefix = '') -> true when `rel` resolved is
//   a stored key with bytes, any case (prefix + path: 'ghost/master/' for a root engine's ghost-root-relative keys, ''
//   for Satori's), or resolves to nothing: a file the visitor's own run wrote (--param-input-file) [decision].
// src/core/loader.js — SiteIndex: ghosts (ghosts.json's, sorted at load into ssp.exe's Change ghost ▸ order:
//   shells.js compareEntries, by descript name, ties by folder [observed]; so an index an older tool
//   wrote in folder order lists the same; every list of the site's ghosts and chooseGhost's "first" follow it),
//   balloons, defaultBalloon (ghosts.json `defaultBalloon`, else null);
//   ghostFiles(id), balloonFiles(id) (the balloon's manifest: a site balloon, or a ghost's bundled one hoisted by the
//   indexer, root ghost/<gid>/<id>/ with its own pack).
//   Safe updates (every fetch below is the window's fetch with these `cache` modes):
//   - SiteIndex.load(base): ghosts.json with {cache: 'no-cache'} on every page (a 304 when unchanged); when that
//     rejects with a TypeError (the network failed, not an HTTP status) once more with 'force-cache', so a page shown
//     offline still has its stored copy; an HTTP error is not retried. INDEX_FORMAT = 2 (= index_site.py FORMAT, kept
//     equal by tests/runtime/index_versions.test.mjs): any format up to it is read (1: the fixed manifest names); a
//     newer one rejects with code 'index-newer' (this runtime is older than the site: Site._loadIndex asks staleCheck).
//     The index holds `format`, `manifests` ({ghost: {id: path}, balloon: {id: path}}, empty for format 1) and
//     `versions` ({site path: hash}, {} without).
//   - _files(kind, id) opens the manifest `manifests` names (hashed), else `sumika/index/<kind>.<id>.json` (format 1,
//     a plain fetch). A hashed manifest and every pack go through fetchNamed: 'force-cache', and once more with
//     'reload' when the response is not ok or does not parse (a manifest: JSON with a `root` string and a `files`
//     array; a pack: gzip `1f 8b`, or `SMKP` when the host already decoded it, Content-Encoding: gzip); still bad ->
//     code 'gone'. A 'gone' manifest (pruned under a long-open tab, or named by a stale ghosts.json) re-reads
//     ghosts.json once per page (_reindex, no-cache), which replaces only `manifests` and `versions` (the page keeps
//     its ghost and balloon entries), and is asked for once more under its new name; a second failure rejects. Never
//     reloads the page. A re-read index newer than this runtime makes the rejection its 'index-newer' (for every gone
//     manifest of the page; Runtime._indexFiles asks staleCheck). A pack still bad after its retry: each file
//     fetched on its own.
//   - GhostFiles.open(base, manifestPath, {hashed = false}); new GhostFiles(rootUrl, files, pack, packPrefix,
//     versions): `versions` is the manifest's array parallel to `files` (8 hex each), kept per file (`f.v`); the
//     [path, size, w?, h?] tuple is unchanged; sub() keeps each file's version. url(p) -> the plain URL (no query:
//     for elements). versionedUrl(p) -> url(p) + `?v=<hash>` when the manifest gave the file one, else
//     url(p). bytes(p): the pack, else fetchVersioned(versionedUrl(p), {size: size(p)}).
//   - fetchVersioned(url, {size = -1, as = 'bytes' | 'blob'}) -> ArrayBuffer | Blob: a `?v=` URL with
//     'force-cache' (its bytes are named, so any stored copy is right; no recheck, also in Firefox on a host that sends
//     no expiry); a response not ok, or not `size` bytes when given, once more with 'reload'; a size that still
//     differs is used as it came, logged once (a CDN that rewrites images must not break the shell), and sets
//     sessionStorage REWRITES_KEY 'sumika.hostRewrites' = '1' (storage.js session): from then on that tab takes a
//     stored copy of another size as it is (only one that is not ok is fetched again), so such a host costs one
//     download per tab, not every image on every page; not ok after the retry rejects. A URL without `?v=` is fetched
//     with the browser's default caching. Its callers: GhostFiles.bytes, shell/images.js `_bytes` (surfaces, PNAs,
//     balloon images: versionedUrl when the folder has it) and ui/thumbnail.js loadThumbnail (same-origin thumbnails,
//     the menu's dress-up part thumbnails and banners: Menu._thumbFinders and bannerUrls give versionedUrl).
//   - Element loads keep the plain URL and the browser's default caching (`?v=` on them would cost Firefox a
//     revalidation per page on a host with no expiry): menu skin images (the `<img>` probe, CSS backgrounds), shell
//     cursors (CSS `cursor`), the launcher icon `<img>`, sounds (`new Audio`), page-saori's file URLs (a MIDI file's
//     bytes too: the MIDI player fetches that plain URL with the browser's default caching), `file:///` opens.
//   - The manifest (index_site.py, format 2): {format: 2, id, root, files: [[path, size, w?, h?]], versions: [8 hex,
//     parallel to files], pack?: path}, written as `<kind>.<id>.<10 hex of its bytes' SHA-1>.json`; its pack as
//     `<kind>.<id>.<10 hex of the SHA-1 of the pack before gzip>.pack.gz` (the gzip bytes differ by
//     zlib; a file that holds the same content is kept, whichever tool wrote it; nothing reads a pack's size or gzip
//     hash: TextPack gunzips it, prune compares names).
// ghosts.json (tools/index_site.py): `ghosts` in ssp.exe's Change ghost ▸ order (menu_order = shells.js
//   compareEntries: by descript `name`, ties by folder; older indexers wrote folder order; `manifests` stay keyed in
//   folder order, and a bundled balloon's folder id goes to the first ghost by id); per ghost `shells` [{id, name,
//   hidden?: true}] in SSP's name order (name 'default' without a descript name; master/ or surface/ without a
//   descript as 'Default'; hidden: its descript `menu` contains 'hid'), `defaultShell`
//   (seriko.defaultsurfacedirectoryname, master, surface, the first);
//   `balloons` [{id, name, ghost?}] in name order (site balloons and every bundled balloon hoisted with `ghost`; a site
//   balloon of the same id wins, then the first ghost by id); `defaultBalloon` chosen among site/balloon/ only;
//   per ghost `engine` (index_site.py detect_engine = tools/sweep/views.mjs detectEngine: the lower-cased stem of
//   descript's `shiori` DLL, 'shiori' without one; the AYA family by ghost/master/<stem>.txt's dictionaries: `request`
//   -> 'yaya', only `OnRequest` -> 'aya'; then Kawari, for the stems shiori, kawari, kawari8 and kawarirc (kawari_phase
//   = kawariPhase): ghost/master/kawarirc.kis in any case -> 'kawari' (Phase 8), else ghost/master/kawari.ini or a
//   kawari* stem -> 'kawari7' (Phase 7, SHIORI/2.x), else the stem stays) and, only on 'yaya' entries, `module`
//   (that stem, case kept: YAYA's <module>.txt and <module>_variable.cfg); Kawari entries have none; per ghost
//   `thumbnails` [site path] (ghost_thumbnails, UI §2.14: the ghost folder's `thumbnail*.*` files whose extension is in
//   SSP's image table (THUMB_EXT, thumbnail_ext_ok), else ghost/master/'s, NTFS name order; [] without one). It
//   replaced `thumbnail` (the root thumbnail.png or null); `thumbnails` also on a `shells` entry, a
//   `bundledBalloons` entry and a `balloons` entry (thumbnail_names of the item's own folder, no fallback) when there
//   are any; per ghost, after `thumbnails`, the tray icons (UI §2.6; index_site.py ghost_icons = trayicon.js
//   ghostIcons): `icon` [site path] (descript icon / iconfilename, the last line, else icon.ico; the
//   ghost root, then ghost/master/, any case, the real spelling) and `iconMinimize` [site path] (descript
//   icon.minimize, same places), each only when its file exists (absent like `module`). Top level (format 2, safe
//   updates): `format` 2; `manifests` {ghost: {id: 'sumika/index/ghost.<id>.<h>.json'}, balloon:
//   {id: 'sumika/index/balloon.<id>.<h>.json'}} (h: 10 hex of the manifest's SHA-1); `versions` {site path: 8 hex of
//   the file's SHA-1} for exactly the paths ghosts.json names (ghost, shell, bundled-balloon and balloon `thumbnails`,
//   `icon`, `iconMinimize`). The ghost and balloon entries keep their shape (no hash in any string a ghost can see).
//   Written last by the indexer, which deletes nothing in sumika/index/ (older manifests and packs are
//   tools/prune.mjs's). tests/fixtures/ghosts.json stays format 1.
// src/core/trayicon.js — pure (UI §2.6): iconRel(name, base = '') (a ghost-root-relative path; null above the root or
//   with ':'); findIcon(files, name) -> real path | null (root + name, then ghost/master/ + name; files.resolve, else
//   files.list('') in any case; numbered frames not followed); descriptIcons(text) -> {icon (default 'icon.ico'),
//   iconMinimize ('' = none)} (keys in any case, the last line wins); ghostIcons(files, descriptText, gid) -> {icon?,
//   iconMinimize?} (site paths); isTrayIconTag(name) (/^(trayi|tasktrayi)/ on the lower-cased name);
//   launcherIconPath(g, mode, minimized) -> site path | null ('minimized': g.iconMinimize, else
//   `ghost/<id>/${minimized.icon}`, else g.icon; 'closed': g.icon)
// src/worker/engines/supported.js — SUPPORTED_ENGINES (= keys of ENGINES in index.js: ['satori', 'yaya', 'kawari',
//   'kawari7']), engineSupported(g), engineNeeds(g) (a display name: 'AYA', 'Misaka', … | null; else the descript's
//   `shiori` or '<engine>.dll'), engineNote(g) ('needs AYA'); the page reads it without importing the engines
// src/ui/menu.js — right-click menu (UI §2, SUM C26/C27/C29); Menu({host, stage, files, shellDir, ghosts, scaling,
//   language}) where language (a UiLanguage) sets the captions' language and adds Language ▸ (UI §2.10:
//   buildMenuModel(scope, res, {..., lang, languagePref}); languageItems(lang, pref): the names with a bullet (radio) on
//   the language in effect, Use System Lang. a check (toggle, menuitemcheckbox); a pick calls language.set(pref)); an
//   open menu is drawn again in place on its 'change'. Items carry `lang` when their text is not in the UI language
//   ('' = the ghost's: SHIORI captions, site titles, ghost names; 'en' = Language ▸); ghostItems(ghosts, lang) words
//   `needs` as the note, which (with its tooltip) carries the menu's lang on such a row. Sumika's captions:
//   t('menu.*', lang) (Close: 'menu.close' in scope 0, 'menu.closeSub' in the abbreviated menu); the ghost's are never
//   translated.
//   ghosts() lists Change ghost ▸ (buildMenuModel(scope, res, {ghosts, scaling}); items {checked, radio, disabled,
//   note, title}, label = the name only, the note drawn in its own .smk-note column; a pick calls
//   host.changeGhost(id, {byId: true, raiseEvent: true, reason: 'manual', scope})); scaling (a UserScaling) adds Shell
//   scaling ▸ / Balloon scaling ▸ before Utilities (scaleItems(target, percent, dpr, {other, otherLang, otherVisible,
//   lang}); other: the ghost's caption or null for Sumika's): Default
//   (match display), Other percentage… (greyed by *scaleotherbutton.visible 0), separator, percentages with a bullet
//   (radio) on the one in effect and the note 'display'; picks call scaling.set / scaling.askOther). On a phone
//   scaleItems also takes `fit` (the phone default's percentage, scaling.info().fit[target]; UI §9.11): with no pick
//   the bullet is on the fit's row and Default reads t('menu.scale.defaultPhone') ("Default (fit to screen)"); without
//   `fit` its output is the desktop one. Home / End go to
//   the first / last enabled row. src/ui/launcher.js — Launcher({name, iconUrl, onActivate, language, slot = 0,
//   phone?}) (onActivate(mode): mode 'minimized' | 'closed' | 'tucked'); its
//   label launcherLabel(mode, name, lang) ('Call X' / 'Show X', 'Xを呼ぶ' / 'Xを表示') follows language changes;
//   setSlot(i) / slot: its place in the dock, bottom = launcherBottom(i) = LAUNCHER_BOTTOM 16 + LAUNCHER_STEP 56 × i px
//   (set inline; kept for a button not built yet; slot 0 = the one-ghost place) (UI §2.6) [decision];
//   setIcon(url | null) (the tray icon's URL, kept for a button not built yet, repainted only when it changed: an <img>
//   sized on load and at every show by launcherIconBox(naturalWidth, naturalHeight, dpr) -> {width, height (CSS px),
//   pixelated} | null (fitted into trayIconDevicePx(dpr) = 16 × max(1, ⌊2 × dpr⌋) device px; `smk-px` =
//   image-rendering: pixelated at a whole scale ≥ 2); none, or an image that fails: the name's initial) [decision];
//   setBusy(on) (class smk-busy: dimmed, cursor progress; aria-busy; a click while busy does nothing; show() and
//   hide() clear it: the tucked button between the tap and the boot, UI §9.11); option `phone` (phones only): bottom
//   calc(<launcherBottom(i)>px + env(safe-area-inset-bottom, 0px)) and right calc(16px +
//   env(safe-area-inset-right, 0px)); without it the plain inline bottom (16px at slot 0) and the CSS right 16px
//   Several ghosts (UI §2.12, EV §2.7): Menu also takes calls (() => rows | null: Call ghost ▸; none or null: no submenu):
//   menuResourceIds(0) asks callghostrootbutton.caption / .visible right after ghostrootbutton.* (scope 0 only);
//   buildMenuModel(…, {calls}) puts Call ghost ▸ (caption: the ghost's, else t('menu.callGhost'): SSP's 'Call ghost
//   (&Z)' / '他のゴーストを呼ぶ（&Z)' with the full-width '（') right after Change ghost ▸ at scope 0 only, whenever
//   calls is an array (empty: greyed and empty); only callghostrootbutton.visible 0 greys it, never the enable level
//   [disasm, tentative]. callItems(rows, lang): own ghost ✓ and greyed; `elsewhere` greyed without ✓; needs / note
//   greyed with the reason; `full` (true or the cap n) greys the rest with t('menu.callLimit', {n}) ('up to {n} at
//   once' / '同時に{n}体まで', Sumika's); action {type: 'callghost', id} -> host.callGhost(id, {byId: true, raiseEvent:
//   true, reason: 'manual', scope}) (a host without callGhost: logged once). ghostItems greys `elsewhere` rows (no ✓,
//   no note). quit -> host.quitAll(scope), host.close(scope) for a host without quitAll (a redirected menu: below).
//   Which menu a right-click opens (UI §2.1 Notes, ssp.exe 2.9.10 OnCWContextMenuSSP):
//   menuGateIds(clicked) -> [`${p}.popupmenu.visible`, `${p}.popupmenu.type`]; sspWtoul(s) (wtoul_impl: ' ' U+3000 tab
//   skipped, 0x/0X hex, wcstoul's sign and overflow, ASCII digits); popupTypeScope(v) -> null (no answer: null or '')
//   | 0 ('sakura', any case) | 1 ('kero') | sspWtoul(the rest after 'char') | sspWtoul(v); menuTarget(clicked, res,
//   has = s => s === 0 || s === 1) -> {visible: parseBool(visible) !== 0, target: the type's scope when has(it), else
//   clicked}; applyBindId(s); bindScopeOf(clicked, target, res) -> target when equal, else parseBool(the clicked one's
//   applybindtoself) === 0 ? target : clicked; askMenu(ask, clicked, {has, ids = menuResourceIds, live}) ->
//   Promise<{target, bindScope, res, gate} | null>: ask(gate), null when !visible or !live(); then one ask of
//   [applyBindId(clicked) when target !== clicked, ...ids(target)]; a throwing ask counts as an empty Map.
//   Menu.open({scope}) (scope = the clicked character): askMenu over host.resources with has = _hasScope (0, else
//   stage.has(s), a stage without has: 1) and ids = _resourceIds, live = the open's token; _options(target,
//   bindScope); buildMenuModel(target, res, opts); then this.scope = target (the menu's character) and this.clicked =
//   the clicked one (_at keeps the clicked one: a language re-open asks the gate again). _options(scope, bindScope =
//   scope): dressup = stage.dressupMenu(scope), and for another bindScope {...stage.dressupMenu(bindScope) (failing:
//   {mode: 'hidden', entries: []}), enabled: the owner's}; dressupScope: bindScope. _run(action, scope, clicked =
//   scope) (_activate passes this.scope, this.clicked): close -> host.close(scope) when the two match, else
//   host.close(scope, {window: clicked}); quit -> quitAll(scope) / quitAll(scope, clicked) (a host without quitAll:
//   close as above); site R4, carry, scale-other, ghost / call / shell / balloon: the menu's scope; dressup: the
//   action's scope (the bind scope). prefetch(scope) asks [...menuGateIds(scope), ..._resourceIds(scope)].
//   Thumbnails (UI §2.14): rows (Site.ghostList / callList) carry `thumbnails` (URLs, Site._thumbUrls: ghosts.json
//   paths against the site's base, each segment encoded, `?v=` from index.versions) when the ghost has any;
//   ghostItems / callItems put them on the item as `thumbs`. Menu({thumbnail}) (default sharedThumbnail() when a document exists; null: none) hears every
//   change of the selected row (_syncThumb: the hot row of the deepest open menu that has one, Win32's WM_MENUSELECT
//   item): an enabled row with a thumbKey(action) ('ghost:<id>', 'callghost:<id>', 'shell:<id>', 'balloon:<id>',
//   'dressup:<scope>:<id>', '<recommend|portal>:<index>') -> thumbnail.select(key, item.thumbs || [], () => the
//   pointer), any other row or none -> select(null); close() -> select(null). The pointer: the open point, then window
//   pointermove. shellItems / balloonItems put a row's `thumbnails` (URLs: Runtime.shellList / balloonList from the
//   index's site paths, siteUrls with index.versions) on it as `thumbs`; dressupItems(data, scope, thumbs) and the
//   site rows get a `thumbs` function from buildMenuModel's `thumbs` option {part(thumbnail), banner(banner)} -> URLs (Menu._thumbFinders: the
//   part in the current shell folder, the banner in ghost/master/banner/ or its http(s) URL; findLoadable, bannerUrls).
//   Stage.dressupMenu's part entries carry their bind group's `thumbnail` when it has one. Change ghost ▸'s own row is
//   checked and enabled (Runtime._change reloads the ghost, keeping its lock; EV §2.5).
// src/ui/menu.js probeImage(url, bottomAligned = false, cors = the URL's origin is not the page's) -> {url, width,
//   height, edge} | null: the menu skin image's size and edge pixel (SetValues); `cors`: img.crossOrigin =
//   'anonymous' (another origin's pixels are readable only with the runtime host's Access-Control-Allow-Origin), and
//   on its error once more without (the size, edge null). The same origin: no crossOrigin.
// src/ui/thumbnail.js — the menu's thumbnail window (UI §2.14): THUMB_DELAY_MS 350, THUMB_MARGIN 10, THUMB_Z
//   Z_BASE + 201; placeThumbnail({width, height}, cursor, work, dpi = 96) -> {x, y, w, h} | null (device px:
//   CThumbnailWnd::CreateMe); thumbnailAlpha(img, name) (a fully opaque `…r` file keys out its top-left colour, in
//   place); loadThumbnail(url) (the site's: fetchVersioned(url, {as: 'blob'}), first frame, thumbnailAlpha; another
//   site's: an <img>, no referrer, {width, height, source}); otherSite(url, loc?) -> the URL's origin is neither the
//   page's nor the site's (setSiteBase(base), called by the Site: a page on another origin than the runtime host
//   fetches the site's thumbnails as site files, with CORS); MenuThumbnail({clock, random, load, draw}): select(key | null, urls | () => urls, cursor)
//   (a key starts the 350 ms timer, then the urls (a function is called then) give one at random unless that key was
//   the last processed; null hides at once when a key was selected since the last clear), hide(), destroy(), shown
//   ({key, url, x, y, w, h} | null); sharedThumbnail() the page's one; imageExt(ext) (JLibGra's table, low bytes, ASCII
//   lower-case); findLoadable(files, path) -> real path | null (SSP's any-extension lookup: the written extension goes,
//   the first image of `<name>.*` in NTFS order); bannerUrls(files, banner) -> [url] | [] (ghost/master/banner/ first,
//   a URL by its last segment, else an http(s) URL itself)
// src/core/loader.js — siteUrls(base, paths, versions = null) -> URLs (each segment encoded; none without a URL base;
//   a path `versions` lists gets `?v=<hash>`: only for URLs fetch() loads, the thumbnails; the launcher icon is
//   built without versions, as an <img> keeps its plain URL)
//   src/ui/layers.js — GhostLayers({root}) (default: getRoot() at the first create when a document exists; null:
//   headless, keys and order only): create(key, {ghost}) -> Element|null (<div class="smk-ghost" data-ghost>,
//   position:fixed, left/top 0, 0×0, overflow:visible, z-index Z_BASE + rank; on top; an existing key keeps its
//   element and comes on top silently); a capture pointerdown on it raises it; raise(key) -> boolean (onRaise(key)
//   after every raise of a known key, never re-entrant); remove(key); setGhost(key, ghost) (the label only);
//   order() (bottom -> top); top; has(key); element(key); ghostOf(key); zOf(key) (Z_BASE + rank, rank capped at 189:
//   below the dock); destroy(); onRaise (the Site sets none: a press only restacks; the Site hears of activation
//   through the loop's 'activate', UI §9.1, §9.7). LAYER_CLASS = 'smk-ghost'. The Site keys layers by Runtime.sid.
//   Shell ▸, Balloon ▸ and Information ▸ (UI §2.11): Menu also takes shells (() => [{id, name, current}]), balloons (() => {top, all}), info (() =>
//   {sources, version?, engines?}) and devFunctions (default: ?sumika-debug in the page URL); providers are called
//   through _ask (a failing one is logged once and counts as absent); setShell({stage, shellDir}) after a shell swap
//   (closes an open menu, loads the new shell's menu.* look, starts loadShioriLook(): odmReady, the promise of its
//   requests, which Runtime._swapShell awaits before OnShellChanged). menuResourceIds(scope, {devFunctions, preferences}) is
//   one batch for the menu `scope` owns (no popupmenu.* id: the clicked character's gate is askMenu's round before
//   it): legacy caption names before the new ones, the abbreviated menu's recommend ids prefixed (kero. /
//   char<N>.), dress-up / explorer / move / close / quit ids unprefixed, leavepassivebutton.* only with devFunctions,
//   configurationrootbutton.* and configurationbutton.* (visible before caption, after Utilities ▸'s) only with
//   preferences, no update* or vanish* ids (no Network update or Uninstall [decision]).
//   Menu option preferences (() => void; UI §2.13): present -> Options ▸ Preferences… right after Utilities ▸ in the
//   main menu (buildMenuModel(…, {preferences: true}); not greyed by the enable levels; a ghost caption replaces Sumika's,
//   visible 0 greys it), its action {type: 'preferences'} calls it; absent -> no Options ▸ and no ids asked.
//   buildMenuModel(scope, res, {ghosts, scaling, lang, languagePref, shells, balloons, dressup /* stage.dressupMenu
//   (scope) */, dressupScope /* whose parts: the part actions' scope, default scope */, info /* {readme, terms} */,
//   enableLevel, devFunctions, carry /* stage.carry exists */, preferences}) -> items (never null:
//   askMenu decides whether a menu opens and whose; scope = the menu's owner): the full
//   orders of UI §2.11 (no Network update or Uninstall, Quit in both menus, Move
//   character window with a separator on each side when `carry`); `*.visible` 0 greys an item in place (scaleItems'
//   Other percentage… too; the gate's popupmenu.visible 0 still means no menu); an empty site list greys Recommendations / Portal;
//   enable level ≥ 2 greys Recommendations, Portal, both scalings, Change ghost, Shell, Clothes/Dressup and Balloon,
//   level 3 also Iconify. Item builders: shellItems (✓ on the current one, which stays enabled), balloonItems (top
//   group, separator, all; ✓ on the first copy; cutName to BALLOON_NAME_MAX = 25 + '...', full name as tooltip),
//   dressupItems (Dressup explorer greyed, separator; manual 'category - part' check rows and menuitemex submenus;
//   auto: 2+-part categories first as submenus, then flat singles; hidden: none; '&' doubled), infoItems. Picks:
//   shell -> host.changeShell(id, {byId: true, raiseEvent: true, scope}); balloon -> host.changeBalloon(id, {byId:
//   true, scope}); dressup -> host.toggleDressup(scope, id); about / readme / terms -> the info window; quit ->
//   host.quitAll(scope) (above; a redirected menu: quitAll(scope, clicked)); leavepassive -> host.setOption('leave', ['passivemode']) and ['inductionmode']; carry ->
//   stage.carry(scope). Submenus nest: a stack of open levels, each with its own timer and menu-aim; ArrowRight opens
//   a child from any level (never a greyed one), ArrowLeft / Escape close the focused level.
//   The look (UI §2.3, ssp.exe's metrics): Menu also takes ghostDescript (the ghost's descript Map; runtime.js passes
//   it). menuLook(shellDescript, ghostDescript?, odm?): every menu.* key of the ghost's, the shell's on top key by key,
//   then the SHIORI's answers (odm: a Map id -> value, odmPass's keys; never the image names); adds
//   backgroundColor, foregroundColor, sidebarColor, frame ('rgb(…)' | null), fontName (≤ 31 chars | null), fontHeight
//   (|atol| device px | null); backgroundAlign / foregroundAlign ('left top' … 'right bottom', alignFlag(value): SSP's
//   GetAlignFlag substrings; no key: 'left top'), sidebarAlign ('top' | 'bottom'; no key: 'bottom') and sidebarTopEdge
//   (the sidebar's fill is its top pixel: only with a key that says bottom). menuAccepted(look, {bg, fg, side}): SSP
//   takes the look (both images loaded, or both fill colours whose images did not load, or sidebarColor whose image
//   did not load; UI §2.3). SSP_LOOK ({bg, fg, side: null, ssp: true}): the images of a rejected look; open() draws
//   with it. menuColors(look, images, {accepted, loadDefaults}?) -> {ssp, text, hotText, disabled, separator, bg,
//   hotBg, frame}: ssp true (SSP_DEFAULT_ODM's colours, the shell's images unused) for images.ssp or, without
//   `accepted`, a look menuAccepted refuses; the defaults of UI §2.3 (greyed = (2 × fill + text) / 3), or
//   loadDefaults {disabled, separator} (LoadSurface's at the shell's load) when given and the look sets neither.
//   The SHIORI's look (UI §2.3 "SHIORI resources", ssp.exe 2.9.10 GetODMFromShiori 0x623730): ODM_NAME_IDS (background,
//   foreground bitmap.filename), ODM_SIDEBAR_ID, ODM_FILL_IDS (background / foreground .color r g b), ODM_REST_IDS (the
//   other 26 in SSP's order), ODM_DEFAULT_NAMES (InitMenuProp's), ODM_LOAD_MS 5000 (each load batch's cap
//   [decision]); odmStem(v) (trailing U+0020 cut, then a 4- or 5-character extension when the string is ≥ 5 long);
//   descriptStem(name) (RemoveExtensionFromFileName); odmImagePaths(stem, shellDir) -> [shellDir + stem + '.png',
//   'ghost/master/' + stem + '.png'] ([] for '' or a '!' stem); colorChannel(v) -> 0–255 | null (SPColor's reading:
//   blanks, sign, digits, '%'; ≥ 0; low byte); odmState(descriptLook?) -> {keys: Map, names: {bg, fg, side} (the
//   descripts' stems, else InitMenuProp's), paths: {bg, fg, side} (null: the descripts' image), loaded, complete};
//   odmPass(ask(ids) -> Promise<Map id -> value|null>, st, {force, colourSet(which) -> boolean|Promise}) ->
//   {complete, reload: Set<'bg'|'fg'|'side'>, asked}: batch 1 the names, batch 2 the sidebar's (both names answered)
//   and the fills, batch 3 the rest only when complete (both names, or both fill flags: answered now or colourSet);
//   an empty / null answer (or an invalid channel) keeps st's value; a name's stem replaces st.names[slot] and is
//   reloaded with force or when it differs (not when empty); a failing ask is no answer. Menu.loadShioriLook() (no
//   host.resources: nothing) -> Promise<void> (never rejects; the requests only, not the images): a fresh odmState,
//   one forced pass with host.resources(ids, {timeoutMs: ODM_LOAD_MS}), loaded = true and complete = its result;
//   EventLoop.boot awaits it. open(): after the caption batch and the model (none: no pass), _odmAtOpen (a pass
//   without force through host.resources(ids) while loaded && complete; nothing otherwise), then _popupImages: loaded
//   -> SSP_LOOK unless menuAccepted(the descripts' look, the descripts' images) or complete, else the current images
//   (a SHIORI-named slot its own, null included) + {accepted: true, defaults}; never loaded -> menuAccepted(look,
//   the descripts' images). Passes run one at a time (_odmQueue), each on the state current when it starts;
//   probes are per url and edge (the edge from the alignment in effect). menuTextHeight(dpr, fontHeight?) (device px: fontHeight, else
//   round(12 × dpr)); menuSpacing(dpr, th, touch) (MENU_SPACING 2; touch: the least that makes a row MENU_TOUCH_ROW
//   24 CSS px); menuExtraWidth(dpr) (Windows' allowance after the caption: 2 × Segoe UI's average character width at
//   round(12 × dpr) px, 14 / 16 / 20 / 24 / 26 at 100–200 %); menuInternalLeading(th, family) (the primary font's
//   rounded ascent + descent − th, from a canvas, else Segoe UI's; remembered); menuMetrics(dpr, {fontHeight, leading,
//   spacing}) -> {dpr, th, spacing, row, separator, separatorLine, inset, accelGap, cy, extra, textShift (1 when
//   `leading` is odd), arrow: {a, w, right, pixels}, tick, dot} in device px (MENU_INSET 16, MENU_ACCEL_GAP 8);
//   menuVars(metrics, {side, bg, fg}) -> the --smk-* custom properties of a menu element (n device px = n / dpr CSS px;
//   images 1:1 in device px; --smk-extra, --smk-text-lh = row − textShift, --smk-text-pt = textShift); devicePx(n,
//   dpr); pixelShadow(pixels, dpr) (a box-shadow list in currentColor); menuFontFamily(name, lang) (that face, then
//   MENU_FONTS ("Segoe UI", "Meiryo UI", "Yu Gothic UI", …) / MENU_FONTS_JA; null without a name). Items: a checked
//   row's mark is SSP's dot with `radio` (scaling, languages, Change / Call ghost, Shell, Balloon) or `dot` (dress-up
//   parts, still toggles), else the tick (UI §2.3). parseCaption(…).accel: the text after the last '\t' (null without
//   one), drawn right-aligned; none of the runtime's captions has one (UI §2.11). open({scope, x, y, device?}):
//   scope is the clicked character (the menu shown: askMenu, above; two request rounds, then the look's);
//   device 'touch' (EventLoop._openMenu's req carries it for a long press) gives touch rows. A menu opens with no hot
//   row (Down: the first enabled row, Up: the last); a greyed row under the pointer is hot too (its text stays
//   greyed); a separator under the pointer or a pointer leaving the menu leaves no row hot, except the row of an open
//   submenu (_hoverSep, _leave); the background and foreground images align in the area right of the sidebar
//   (_imageAt); a devicePixelRatio change while open re-applies the metrics in place (a resolution media query;
//   resize still closes it). No open animation.
// src/ui/info.js — Information ▸'s window (UI §2.11): README_NAMES, TERMS_NAMES, findReadme(files, descript, {ghost})
//   (the descript `readme` key, then SSP's list; ghost/master/* only for a ghost), findTerms(files), rtfToText(s),
//   readmeText(files, path, descript) (readme.charset UTF-8 / Shift_JIS, else decodeText; RTF as text), readmeSources
//   (sources), infoFlags(data) -> {readme, terms}, readmeContent(sources), termsContent(sources), aboutContent({version,
//   engines, midi}) (after the SHIORI lines `info.midi` and `info.bank`: midi = {synth, bank} as engineLabel takes
//   them, default the MIDI bundle's (SpessaSynth core 4.3.22 with fflate, stb_vorbis, the Dattorro reverb) and
//   GeneralUser GS 2.0.3, as in midi.LICENSES.txt; null leaves both out), engineLabel(e), infoView(content, lang,
//   selected, loaded) (the window's words without a DOM).
//   InfoWindow({language}).open(content) / close() / view() / destroy(): Shadow DOM at Z_BASE + 200, role=dialog, one
//   at a time, Esc / OK / × close and return focus, a Ghost / Shell / Balloon switcher when several sources have a
//   readme (each fetched once), re-labels on a language change. content: {title, author?, url?, text?, load?,
//   uiText?, sources?}; title and text may be functions of the UI language.
// src/core/i18n.js also exports PROPER_NOUNS (['Sumika', 'SSP', 'SHIORI', 'URL', 'AI', 'MIDI']): words the no-English check of
//   the Japanese strings strips first.
// src/main.js — new Site({...script tag options, lead: true, maxGhosts, createRuntime: o => new Runtime(o)});
//   window.sumika: {version, site, runtime (a getter: site.slots[0]), start() (site.start()), ghosts()
//   (site.siteGhosts(): [{id, name, current, running, active, note, needs}]), running() ([{id, name, active}], set
//   order), callGhost(id, {from?}) (like Call ghost ▸ of `from`, default the preferred ghost; true when it booted;
//   a from not on screen: false), closeGhost(id?) (like that ghost's Close, default the preferred one), quit() (like
//   Quit), changeGhost(id, {from?}) (changeGhost(id) alone works too); callGhost and changeGhost resolve false in a tab
//   that does not run the set, and after Quit or the last Close boot `id` alone, cold, in the launcher's place (EV
//   §2.7.1, §2.7.2), shells({ghost?}), balloons({ghost?}), changeShell(target, {ghost?, ...opts}),
//   changeBalloon(target, {ghost?, ...opts}) (the preferred ghost's when none is named)}; script tag
//   data-default-ghost, data-default-balloon, data-max-ghosts (>= 1, default MAX_GHOSTS: no cap; 1: one ghost at a
//   time, no Call ghost ▸), data-base, data-autostart, and on phones only (UI §9.11) data-phone ('tucked', 'off').
//   phoneInfo(window) runs once at the top: desktop (null) builds the
//   Site with exactly the options above and never reads data-phone*; a phone adds {phone, tucked}. window.sumika gets
//   `phone`: null (no phone), 'on', 'tucked' or 'off'; still one object literal with the runtime getter. Off: no Site
//   at all, window.sumika = offApi(version) (frozen; site and runtime null, start() -> 'none', lists empty, every
//   change false). The order: script tag and options -> phoneInfo / phoneMode -> 'off': offApi, the
//   browser check never runs -> missingFeatures(window) (support.js) non-empty: window.sumika =
//   unsupportedApi(VERSION, mode, missing) and one log.warn ("this browser cannot run Sumika: it lacks <describeMissing>;
//   nothing is shown"), nothing else (no Site, element, fetch, storage, lock, worker, channel or listener; a tucked
//   phone shows no button) -> otherwise the normal start. Only the unsupported stub has `supported` (false) and `missing`;
//   the live api and offApi have neither. Page code tests `window.sumika && window.sumika.site` (below the parse
//   floor, ES2020, window.sumika stays undefined). data-hub (the storage hub): read only on the last path
//   (supported, not off), before the Site is made: hubAddress(script.dataset, runtimeUrl, location) -> a URL ->
//   platform.install(new HubClient(url, {window, debug: ?sumika-debug})) (its pagehide and pageshow listeners the first
//   of Sumika's: "Hub protocol", the back/forward cache); null (absent, a bad value: one warn, the page's own
//   origin) -> nothing. Nothing is planted, fetched or read from the page origin's storages before the first start();
//   window.sumika keeps exactly its members.
//   On or off (core/choice.js): on the last path, data-default-state is read first
//   (defaultState: an unknown value warns once; never read on the two stub paths above), then the order goes on ->
//   the visitor's choice -> data-default-state (startState(choice, siteDefault, mode)). Without a hub the choice is
//   read at once (readChoice of localStore() || window.localStorage: one getItem, no probe write); 'off' -> no Site at
//   all, window.sumika = offApi(VERSION, {phone: mode, reason: 'visitor' | 'site'}) and one log.info, nothing else
//   (no fetch, storage write, element, listener, worker, channel or lock). Else the Site gets {phone, tucked} on a
//   phone (tucked: startState 'tucked', which includes data-phone="tucked"), {tucked: true} on a desktop with
//   data-default-state="tucked" (the phone's tucked path, the desktop's layout), and none of them otherwise (no
//   attribute and no choice: the plain options). With a hub the live api is made at once with `state` null; the
//   first call of start() (autostart's too), callGhost, closeGhost, quit, changeGhost, changeShell or changeBalloon
//   decides once: site.storageReady({index: siteDefault !== 'off'}) (the hub planted; the index meanwhile unless the
//   default is off), then readChoice through the mirror (after a fallback: the page origin's localStorage) ->
//   startState; 'off' -> hub.close() (the frame removed, no onGone listener told) and window.sumika = the off stub
//   (the earlier object answers as it from then on: state 'off', site and runtime null, lists empty, calls resolve
//   'none' / false); else site.tucked = (state 'tucked') and the call goes on. ghosts(), running(), shells() and
//   balloons() never decide (the Site's answers while undecided). The live api: {version, phone, state (getter:
//   'enabled' | 'tucked', null while the hub decides), site (getter; null once off), runtime (getter), start(),
//   ghosts(), running(), callGhost, closeGhost, quit, changeGhost, shells, balloons, changeShell, changeBalloon};
//   only the stubs have `reason`. A choice applies to pages opened or reloaded after it: nothing re-reads it later
// src/core/choice.js — whether Sumika runs on a page: the site's default and the visitor's choice; pure (no DOM, no
//   global storage: the caller passes the Storage), imported by main.js and the control page (src/control/), so both
//   agree. CHOICE_KEY 'sumika:choice' (a `sumika:` key: the storage hub mirrors it), CHOICES ['on', 'off'] (no record
//   = "Site default"), DEFAULT_STATES ['enabled', 'tucked', 'off']. defaultState(dataset, warn) -> 'enabled' |
//   'tucked' | 'off' (data-default-state: any case, trimmed; absent or empty: 'enabled'; another value: 'enabled' and
//   one warn). parseChoice(text) -> {choice, newer, rec} (schema.js upgrade('choice') before any field; no JSON, no
//   object, no or another choice: null; a newer record read for what fits). readChoice(storage) -> {choice, newer,
//   blocked} (no storage or a throwing getItem: blocked, choice null; reads one key, writes nothing).
//   saveChoice(storage, choice) -> 'saved' | 'newer' | 'failed' ('on' / 'off' written as {...the record's fields,
//   choice, v: SCHEMA.choice}; null removes the record; a newer record is never written or cleared; a throwing storage:
//   'failed'; another choice throws TypeError). startState(choice, siteDefault, phoneMode = null) -> {state: 'enabled'
//   | 'tucked' | 'off', reason: 'visitor' | 'site'}: Off -> off; On -> enabled whatever the default; none -> the
//   default (an unknown one: enabled); 'tucked' also when phoneMode is 'tucked' and the state is not off
// src/control/ — the control page (sumika/index.html, served as https://<host>/sumika/; tools/build.mjs builds
//   src/control/main.js as engines/control.<h>.js, which controlHtml's page names, deferred). main.js: mount(document,
//   {storage: window.localStorage (null when it throws), nav: navigator, host: location.host, win: window}).
//   control.js: STRINGS {en, ja} (its own table: title, intro, legend, choice.site|on|off and their .hint, where
//   {host}, status.saved {choice} | failed | blocked | newer), OPTIONS ['site', 'on', 'off'], pageLanguage(nav) (i18n.js
//   systemLanguage's rule, written here to keep the runtime's table out of the bundle), text(key, lang, params),
//   optionOf(choice) / choiceOf(option), viewOf(readChoice's answer) -> {option, disabled, status} (blocked: 'site',
//   disabled, status.blocked; newer: its option, disabled, status.newer), pick(storage, option, lang) -> {outcome,
//   option, status} (saveChoice; not saved: the stored option again, status.failed or status.newer), mount(doc,
//   {storage, nav, host, win?}) -> {lang, inputs, status}: html lang and title set, doc.body gets <main> with h1, the
//   intro, a fieldset (legend) of three labels each holding a radio (name sumika-choice, value the option,
//   aria-labelledby its name span, aria-describedby its hint span; the stored choice checked; all disabled per
//   viewOf), a status <p role="status" aria-live="polite">, the where line; a radio's change saves at once (pick) and
//   writes the status; win's `storage` event for the key (or null) applies viewOf again (the selection, disabled, and
//   the status line: none, or status.newer; this page's earlier "Saved" line goes), writing nothing. Nothing is
//   written before a pick; nothing else is loaded (no loader, Site, worker, engine, hub)
// src/core/support.js — the browser check; main.js alone imports it, and it imports phone.js (offApi):
//   PROBE (Uint8Array, 116 bytes: every instruction family beyond the MVP the four engines use (wasm-dis):
//   legacy EH try / catch / catch_all / delegate / rethrow / throw and a tag section, memory.copy / fill and DataCount,
//   i32.extend8_s / 16_s, i64.extend32_s, i32.trunc_sat_f64_s; validated and compiled, never instantiated);
//   FEATURES = ['wasm', 'wasm-features', 'wasm-compile', 'BigInt64Array', 'createImageBitmap']; missingFeatures(win) -> the ids lacking,
//   in that order (wasm: WebAssembly not an object with validate and Module, then the next two are not tested;
//   wasm-features: validate(PROBE) not true, then no compile; wasm-compile: new WebAssembly.Module(PROBE) throws, a
//   CSP without 'wasm-unsafe-eval' [not verified on WebKit: whether a page's CSP reaches a blob worker]); reads only the
//   globals WebAssembly, BigInt64Array, createImageBitmap, each test in its own try (a throwing getter = missing);
//   describeMissing(ids) -> words for the console, '; '-joined; unsupportedApi(version, phone, missing) ->
//   Object.freeze({...offApi(version, {phone, reason: 'unsupported'}), supported: false, missing: frozen copy})
// src/core/canvas.js — canvases that cannot draw: canvasLostError(what) (an Error named 'CanvasLost'),
//   isCanvasLost(e), backingLost(ctx) -> true when one opaque pixel drawn at the top left of a freshly sized canvas
//   reads back with alpha 0 (cleared again, state saved and restored; no size, no getImageData or a throw: false;
//   once per canvas: Chromium warns at its second getImageData [measured] and moves it to software [infer]; a refusal
//   at a later resize is therefore not detected), releaseCanvas(c) (0×0,
//   for a temporary canvas once read: shell/images.js decodeImageBrowser, balloon/images.js's .pna canvas,
//   ui/thumbnail.js loadThumbnail)
// src/core/phone.js — the phone predicate and the script tag (UI §9.11); main.js and support.js import it: PHONE_SHORT_MAX =
//   600; phoneOverride(search) -> true ('?sumika-phone') | false ('=0') | null; phoneInfo(win) -> {short, long,
//   mobileView} | null ((pointer: coarse) && min(screen sides) < 600, read once; forced: the window's sides at load and
//   mobileView true); phoneMode(dataset, warn) -> 'on' | 'tucked' | 'off' (an unknown value: one warn);
//   offApi(version, {phone = 'off', reason = 'phone'} = {}) -> the frozen stub for a page where Sumika does nothing:
//   {version, phone, state: 'off', reason ('phone' | 'unsupported' | 'visitor' | 'site'), site: null, runtime: null,
//   start() -> 'none', ghosts / running / shells -> [], balloons -> {top: [], all: []}, every change -> false}
// src/ui/viewport.js — the visible part of the layout viewport (UI §9.11), used by Dialogs and SettingsWindow on
//   phones: visibleRect(win) -> {x, y, width, height, scale} (visualViewport's offsets, size and scale; without it the
//   layout viewport, scale 1), zoomed(vis) (scale off 1 by more than 0.01: no box moves), keepVisible(box {y, h},
//   vis, margin = 8) -> dy (vertical only; the top edge wins), watchVisible(win, fn) -> off (visualViewport resize /
//   scroll and window resize, once per frame)
// src/core/page-saori.js — page side of SAORI stand-ins (dsaudio / MCI playback, fill_desktop overlay); \_v / \![sound].
//   PageSaori({files, host, drops, midi = null, openTimeoutMs = 10000}): handle({name, cmd, args}); sound(cmd, args); musicState():
//   {path, currentTime, loop, volume 0..1, playing, owner?, given?}|null (while a dropped file opens: as the queued
//   commands will leave it); resumeMusic(s). Dropped-file paths open asynchronously (null after openTimeoutMs); later
//   dsaudio commands queue. A new load pauses and unloads the previous element. handle() names dsaudio and the MCI
//   players (mciaudior, mciaudio; numbered copies such as mciaudior2 have no stand-in, SW) drive the same music box;
//   `owner` (absent = dsaudio) is the DLL that loaded the track, `given` the load's second argument (the file as the
//   ghost gave it; the MCI stand-in sends [ghost-root path, given]). At a track's end host.send (GET, the reply plays):
//   dsaudio's OnDSAPlayFinish []; mciaudior's OnMAAPlayFinish [given ?? path, '0' [guess]], and OnMAAPlayLoop with
//   the same References each time a looping mciaudior track starts over (its element does not loop; the end restarts
//   it); mciaudio's nothing. sound(): \_v / \8 / \![sound,play|loop|stop|pause|resume,file] (EV §4.17, SS §5.8): one
//   element per file name, names compared in any case (stop / pause / resume by name, or all without one); a play or
//   loop of a name still there starts that element over with the new tag's loop flag (no event). Through
//   host.notifyEvent (host.send for a host without it): OnSoundStop [the file as given, 'end'] at a natural end,
//   OnSoundLoop [file] at each start-over of a loop (the element's own loop is off), OnSoundError ['play', '2' | '14020',
//   file, text [guess]] for a file the site lacks or an element that fails before it played (after: OnSoundStop
//   'end'). A stop, destroy() or a page change sends nothing; without an Audio constructor nothing is sent.
//   A play the browser blocks (NotAllowedError) is retried by afterGesture(fn): once, on the window's (capture,
//   passive) pointerdown, pointerup, touchend or keydown that activates(e) (TS §3.4; the HTML spec's
//   activation events: a pointerdown only for a mouse or without a pointerType, a pointerup only for anything else,
//   touchend and keydown always); every listener goes after that one run. activates is exported.
//   MIDI: `midi` is the page's MidiEngine (Site.midi; Runtime passes it). One factory makes every
//   player, `_media(path, url, blob)`: a MIDI file by the name the ghost gave (core/midi.js isMidiPath: the music box's
//   `path`, the sound's `file`; a drop's pseudo-path keeps its extension, its blob: URL has none) -> midi.player({url,
//   blob}) marked `__midi`; anything else `new Audio(url)`. The Audio gate stays in front of both (no Audio constructor:
//   nothing plays). openDropped(path) -> Promise<{url, release, blob}|null>; a drop's Blob goes to the
//   factory (a MIDI player reads it without fetching its blob: URL). The music box's MIDI error path [decision]: the
//   player's `error`, or a play() rejection other than NotAllowedError and AbortError, -> failed(a): ignored unless `a`
//   is the current element; wantPlay false (state() saves `playing: false`, so the next page does not try it again);
//   logged once; no OnDSAPlayFinish / OnMAAPlayFinish. An <audio> track that fails is logged and still wanted.
//   release() clears onerror too. _dropSound(a) releases a MIDI player (pause, removeAttribute('src'), load()) as the
//   music box releases its track; an <audio> sound is not unloaded.
// src/core/midi.js — the MIDI player's page side (docs/research/midi.md §6). No module-level side
//   effects or static fields (drops.js imports it, and the worker bundle drops.js) and no import of build.js.
//   MIDI_PATH = /\.(mid|midi|smf|rmi)$/i; isMidiPath(path) (trimmed, quotes dropped); midiSupported(g = globalThis)
//   (isSecureContext === true and AudioContext, AudioWorkletNode, Worker functions); midiPaths(files) -> the table's
//   {js, bank} (both non-empty strings) | null; RESUME_WAIT_MS 1000, IDLE_MS 10000, CLOSE_WAIT_MS 3000, END_EPS 0.001.
//   MidiEngine({runtimeUrl, paths, AudioContext?, AudioWorkletNode?, Worker?, fetch?, navigator?, clock?, Blob?, urls?})
//   (the rest: the browser's, injectable): jsUrl, bankUrl (absolute); making it does nothing. player({url, blob}) ->
//   MidiPlayer. wake() (called synchronously by play(), so a play inside a gesture resumes inside it) -> Promise<bool>:
//   makes the context at its first use (`{latencyHint: 'playback'}`, the default rate) unless
//   navigator.userActivation.hasBeenActive === false (then false at once: no context before an activation), throws ->
//   rejects; sets navigator.audioSession.type 'playback' where it exists (the old type kept); resumes it: true once
//   running, false at a resume() that rejects or after RESUME_WAIT_MS (a suspend in flight still reading 'running' is
//   resumed after). context() -> Promise of the context once made. hold(player, on): the players that want to play;
//   none for IDLE_MS -> ctx.suspend() and the audio session type given back. fetchBytes(url) (a ghost file's plain URL,
//   default caching; not ok -> throws `HTTP <status>`). prepare(bytes) -> Promise<{sf2, midi, duration}> through the
//   Worker (made at the first prepare from a blob: bootstrap `importScripts(<jsUrl>)`, as ShioriClient's, then `{t:'bank',
//   url: bankUrl}`; its URL revoked at `up`); `failed` rejects (kind 'bank' logged once); a Worker error event rejects
//   every prepare, terminates it and the next prepare makes a new one. module() -> addModule(jsUrl) once the context
//   exists, started at the Worker's `up`; a rejection is forgotten. connect() -> {node, gain}: AudioWorkletNode(ctx,
//   'sumika-midi', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]}) -> GainNode -> destination.
//   MidiPlayer (element-like; what page-saori uses): src ('' after removeAttribute('src')), preload (ignored), paused,
//   ended, duration (NaN until ready), error ({code: 4, message} once failed), currentTime (get: pos + (ctx time - at)
//   from the last current `state` while it plays, clamped to [0, duration]; set: at once locally, kept before ready and
//   sent then, else a `seek`; never a time at or past duration - END_EPS: looping -> 0, playing -> the song ends there
//   (`pause` sent, `ended`), paused -> it stands at its end, ended), loop (sent; before ready: at ready), volume (0..1
//   clamped, the GainNode), onended / onerror and add/removeEventListener (loadedmetadata at ready, ended, error;
//   {once}); events are microtasks, none after a release. play() -> Promise: rejects NotSupportedError once released or
//   failed; paused at its end or ended -> a seek to 0 first; paused false, held, wake(), the load started (Blob or
//   fetchBytes -> prepare -> module -> connect -> `load`); a refused wake (the latest one) -> paused, NotAllowedError
//   (the load goes on); once ready and running `play` is sent and the promise resolves at a current `state` with
//   playing (a play() while it plays and is confirmed resolves at once). pause() -> AbortError for waiting plays,
//   `pause` sent when it played. Failure (fetch, prepare, module, node, the node's `error`, processorerror): error set,
//   paused, plays reject NotSupportedError, its node closed, `error` once. `ended` (current, while it played): ended,
//   paused, pos = duration, `ended` (with loop set meanwhile: seek 0 + play, no event). removeAttribute('src') then
//   load() releases it: plays reject AbortError, `close` sent, disconnected at `closed` or CLOSE_WAIT_MS later; a load
//   still running connects nothing. Each player holds the engine (hold) only when its own flag flips. Every
//   page -> node command carries `n` (1, 2, …); a `state` or `ended` whose echoed `n` is lower than the last play, pause
//   or seek is dropped; one without `n` counts; a current `state` saying not playing while play was sent
//   (the node stopped at its end before that command) sends `play` again.
// src/core/drops.js — dropped files (TS §3.4): dropPath(file) = C:\sumika\drop\<8 hex>\<sanitized name>;
//   dropLabel(path) (logs: id and extension only); playable(type, name?) (audio this browser can play; a MIDI name,
//   core/midi.js isMidiPath -> midiSupported(): the browser's type for MIDI varies and canPlayType refuses it).
//   DropStore.shared(ns): add(files) -> [{path, type, name, size}] (usable at once; storable(type, name) files, default
//   playable, stored in the background), open(path) -> Promise<{url, release(), blob}|null>, clear() ->
//   Promise<boolean>. IndexedDB `kv` keys
//   `drop:<lower path>`, `drop:index`; global; index updates under Web Lock `sumika/drops`. The index's `v`
//   (SCHEMA.drops, 1) is the store's shape, read through upgrade('drops', …); normIndex keeps unknown top-level keys.
//   An index a newer runtime wrote makes the store read-only for the page (DropStore.newer, logged once): no
//   reconcile, no deleting of non-Blob records, no index write, nothing cleared; files dropped here play from memory.
//   DropStore.shared: backend core/platform.js openStore(ns) (kind 'indexeddb' only), locks lockManager() and estimate
//   storageEstimate() as defaults (the storage hub's when the page has one: its lock request is the two-argument call,
//   which rejects when the hub is gone). A backend whose `closed` is true (a PortStore let go when the hub went away)
//   is opened again at the next use: this page's memory then, nothing waits 15 s.
// src/core/storage.js — Store: get(key); set(key, v) -> true when stored; delete(key) -> false when refused;
//   keys(prefix) -> string[] (rejects when the storage cannot be listed); read(key) -> get() for a reader that must
//   not take a failed read for "nothing stored" (the worker's save files): rejects when IndexedDB or localStorage
//   cannot be read or the value cannot be decoded, undefined when nothing is stored. DB_VERSION is frozen at 1 (an
//   upgrade would be blocked by open tabs of older code, which then get a VersionError and run memory-only without a
//   word); versions live in the records and their keys (schema.js). Unchanged by the storage hub: page code reaches
//   `session` through core/platform.js tabSession and `Store.open` through openStore; the worker imports Store itself.
// src/core/platform.js — the one seam for storage, locks and channels (the storage hub; no side effects,
//   imports storage.js only; the worker bundle takes it through drops.js): platform {hub (getter), install(h),
//   clear()}; localStore() (hub.local or null); tabSession {get, set, remove, confirm(k, v) -> Promise<boolean>} (the
//   hub's session mirror, else storage.js session with confirm = the read-back); channelClass() (hub.Channel, else
//   BroadcastChannel or null); lockManager() (hub.locks, else navigator.locks or null); openStore(ns) (hub.openStore,
//   else Store.open); storageEstimate() (hub.estimator(), else navigator.storage.estimate bound, or null);
//   storageSource(win) (hub.events once decided, else win); storePort() (hub.storePort(), else null); stateWill()
//   ((name, key) => hub.will(name, key, 'savedAt'), else null). Each resolves when called.
// src/core/hub.js — the storage hub, page side ("Hub protocol" below). hubAddress(dataset,
//   runtimeUrl, loc) -> URL | null (data-hub absent: null; bare: hub.html next to sumika.js; an absolute http(s) URL,
//   its query kept; both get ?sumika-hub=<HUB_PROTOCOL>; anything else: one warn, null; the page's own origin: null,
//   debug). HubClient(url, {document?, window?, clock?, MessageChannel?, MutationObserver?, debug?}): state 'pending' |
//   'live' | 'fallback' | 'gone'; reason (a refusal's, 'timeout', 'unsupported'); caps; ready() -> Promise<'live' |
//   'fallback'> (plants a hidden iframe at its first call: hidden, display none !important, tabIndex -1, aria-hidden,
//   title, into body or documentElement; never rejects); local (MirrorStorage), session (SessionMirror), events
//   ({add,remove}EventListener('storage', f): f({key, oldValue, newValue, storageArea})), Channel / locks (null while
//   pending or without the cap; refusing everything once gone; the page's after a fallback), openStore(ns),
//   storePort({retire = true}) (an engine start's port, marked `retire`; openStore's is not), will(name, key, stamp),
//   estimator(), flush({session}) -> {failed, session}, sync() (a page back from the back/forward cache: the full
//   delta, and the session mirror replaced by the hub's `sumika.` keys but those the page wrote after sending it),
//   onGone(fn), hidden, close() (after the decision, main.js when the visitor's choice read through the hub is Off:
//   the onGone fns dropped untold, a live client gone (port closed, requests failed, stores closed), timers cleared,
//   the frame removed; a fallback's frame is gone already; nothing posted after).
//   The back/forward cache [decision]: with `window` (main.js passes the page's) the client
//   listens to its pagehide and pageshow at construction (before the Site exists, `capture: true`: it runs first of
//   Sumika's listeners). From a pagehide with `persisted` true, while live or pending, to the pageshow (`hidden`): no
//   write is posted or queued (ls.*, ss.*, will): the mirrors take them, noting each key's value before its first
//   held write, and the PortStores openStore made (also one made meanwhile) hold theirs (PortStore.hold); everything
//   else (unlock, bc.*, lock, flush, sync, store) is still posted. The pageshow takes the held writes back (the mirrors
//   as the hub last had them from this page; a delta that arrived meanwhile wins over a held write of its key) and
//   posting resumes, so the Site's sync brings what other pages wrote. A cached page's posts would wait at its cached
//   hub frame and be applied after Back over another page's newer writes (Firefox); the leave-flush wrote everything
//   before the navigation began. A pagehide not persisted, a fallback, a gone hub and a client without `window`: none
//   of this.
//   HUB_ACK_MS 2500 (an ack after the frame's `load`; a hello per load until acked; at the timer one more task before
//   the fallback), HUB_WAIT_MS 10000 (welcome or refusal after planting), QUOTA_UNITS 5000000. Live: a
//   welcome with v = HUB_PROTOCOL (else fallback 'version'; caps.store 'memory' is used, not refused: see "Hub protocol"); only
//   `sumika:` / `sumika.` string entries are taken from any hub message. Fallback: the frame removed, the
//   port closed, platform.clear(), the writes made while pending replayed on the page's own storages, one line (warn:
//   origin, allowlist, version, busy, timeout, unsupported; info: site, storage); a stale reference to the client then
//   reads and writes the page's own storages. Gone (the hub's `gone` not persisted, or the frame removed:
//   MutationObserver): waiting lock requests refused (three-argument: cb(null); two-argument: rejected),
//   requests rejected, the PortStores openStore made closed (DropStore opens another: this page's memory), writes
//   dropped, onGone fns called; storePort() then answers `local` memory itself. MirrorStorage: getItem / setItem / removeItem / key / length / clear over `sumika:` keys
//   (setItem of another key throws TypeError), writes posted at once; setItem throws QuotaExceededError when
//   otherUnits + every key's and value's length would pass QUOTA_UNITS and grow. SessionMirror: get / set / remove over
//   `sumika.` keys, confirm(k, v) (pending: after the decision; live: a flush; fallback: the read-back; gone: false).
//   Locks: request(name, cb) or (name, {ifAvailable?, mode: 'exclusive'?}, cb); other options throw TypeError; a grant
//   applies its delta first and calls cb({name, mode: 'exclusive'}); the unlock is posted when cb's promise settles.
//   Wills: posted once per (name, key) per tenure, only while `name` is held here.
// src/core/portstore.js — PortStore (imports only hubproto.js's constants, in the worker bundle too): open(port,
//   {timeoutMs = STORE_OP_MS 15000, clock?}) -> Promise<PortStore> once {t:'store', kind} arrived; no port, or the
//   page's own `local: true` answer: this page's memory only (nothing sent; set false, delete true, as Store's memory
//   kind); the hub's kind 'memory': ops sent, answered from its memory; no first message in time: lost (kind 'memory', closed: read and keys reject, set and delete false, get from memory). kind, read(key)
//   (rejects when it cannot be read), get(key) (read, else this page's memory), set(key, v) -> true when stored at the
//   hub, delete(key) -> false when refused, keys(prefix) (rejects when it cannot be listed), close() (waiting ops
//   answered as failed at once, later ops too; `closed` true). Every op times out after timeoutMs. A reply `ok: false`
//   with error RETIRED (a port the hub retired: "Hub protocol"): that op fails as usual and the store is lost from then
//   on (kind 'memory', closed), so the worker writes nothing more and warns nothing. hold(on) / held (HubClient, a page
//   in the back/forward cache): while held, set and delete change the memory map only and answer false, nothing sent;
//   reads still go.
// src/core/hubproto.js — the constants both sides share ("Hub protocol" below); written once, edited by neither side
//   alone.
// src/core/http.js — \![execute,http-*] (EV §4.15). Pure: httpCommand(sub) -> {kind, method}|null,
//   parseHttpOptions(rest), buildHttpRequest(o, method, {random, inputFile}) -> {method, url, headers, body, simple},
//   makeParam(items, {form, multipart, boundary}), percentEncode / isPercentEncoded, encodeText(text, charset)
//   (UTF-8, CP932 as Windows, EUC-JP), cleanupFilename, urlFileName, httpEventNames(id), nofileText, headerText,
//   httpStatus(status, method, {file, location}) -> {ok, read, reason} (RealRead's verdict: success, whether the body
//   is read: a success's, or a failure's page that a threaded request with a Content-Length above 0 reads).
//   HttpRequests({host, fetch, clock, requests?, random?, pageProtocol?}): execute(sub, args) -> false|undefined|
//   Promise, cancel(sub, args), invalidate(). host = {canSend(), live(), locked(), ghostDir(), writeFile(rel, bytes),
//   readFile(rel), event(id, refs)} (the EventLoop's _httpHost()). The page's threaded requests are one Set (the
//   duplicate check and cancel, as SSP's one SPHttpManager).
```

## Worker protocol (implemented: src/worker/worker.js, src/core/shiori.js)
`ShioriClient.start({engine, engineUrl, wasmUrl, files, resume, volatile, bootEpochMs, sessionEndMs, storeNamespace,
storeKey, engineOpts, storePort?})` (`wasmUrl`: the build's hashed `.wasm` of that engine, init message `wasmUrl: o.wasmUrl ||
null`; null: the `.wasm` next to `engineUrl`, as the tests' and the sweep's plain names) loads persisted engine files
from IndexedDB inside the worker (`storeKey` = `ghost:<id>:files`; with `storePort`, the storage hub's store: the init
message gains `storePort`, transferred, and the worker's store is `PortStore.open(storePort)` instead of
`Store.open(storeNamespace)`, everything after it unchanged ("Hub protocol" below); without it the message has no
`storePort`), starts
the engine's uptime clock at `bootEpochMs` (P7, SUMMARY §2.1: the ghost's last cold boot, from its state), resumes
(Satori `satori_load_resume`, YAYA `yaya_load_resume`, Kawari `load` and its entry snapshot restored) when `resume` and
a save exists, and restores the random-talk countdown (`volatile`). `sessionEndMs` (default 0 = unknown; init message
`sessionEndMs: o.sessionEndMs || 0`): on a cold boot, when the ghost's last session ended (its state's `savedAt`),
the clock Kawari's D6 closes that session on (kawari-wasm.md §8); Satori and YAYA ignore it. `engineOpts` (default
null) is plain JSON for the engine's constructor (YAYA's and Kawari's below). `request(r)`
resolves with the parsed response; the worker saves (debounced/urgent per WASM §7.3) and stores changed files itself.
`r.fmo` (optional, `() => string | null`; EV §2.7.8, WASM §8 P8) is read inside the queued step, right before the
request is posted, and goes along as `{t:'req', id, text, fmo}` only when it is a string different from the last text
this engine got (`_fmoSent`, reset by `start()` and `terminate()`; never with init); a null or non-string result sends
none; a throwing `r.fmo` logs one `error` per client ('FMO text for <id>: …') and the request goes without it.
`r.kind` / `r.self` (optional strings) go along as `kind` / `self` beside the text, never in it: which of ssp.exe's
calls this is, for a SHIORI/2.x engine's bridge (`resource`, `translate`, `teach`, `communicate-user`, `communicate`
with `self` = the ghost's scope-0 name in effect; none: an event; kawari7-wasm.md §6.1). `parseResponse(text)` also
gives `protocol`, the status line's version (3 for SHIORI/3.0 and by default; 2.6 for a bridged 2.x reply).
`BASE_HEADERS` (exported, frozen: `{Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel:
'local'}`) are the headers of every request (`ShioriClient.baseHeaders` is a copy); Kawari's D6 close in the worker
builds its requests with them too.
Hooks: `onVolatile(vol)` after every request (persist it in the state JSON: `state.data.engine`), `onSaori({name, cmd,
args})`, `onSaved(names)`, `onLog(level, text)`, `onCrash(id)`. `ghostDir` (from init's reply): the engine's
`ghost/master/` in its file system. `writeFile(path, data) -> Promise<full path>` / `readFile(path) -> Promise<Uint8Array
| null>` (paths relative to `ghost/master/`; \![execute,http-*]'s download and `--param-input-file`, EV §4.15) go
through the request queue, so a request sent after a write sees the file; the worker answers `read` with null for a
personal file (`personalFile`, engine-files.js) and for a file the visitor's own run wrote (`visitorFile`: a save of
any name, a rewritten shipped file, a download) [decision]. `reload(opts) ->
Promise<start()'s result>` (\![reload,shiori], EV §2.10) is one step of the same queue: `unload` (the worker stores the
files before it answers; a failed unload is logged as `warn` and the load goes on), terminate, then `start(await
opts())` on a new worker, so requests asked before it go to the old engine and those asked after it to the new one;
it rejects with `error.stopped = true`, starting nothing, when no worker runs at its turn or `terminate()` was called
meanwhile (a teardown, a request's kill timer); a load that fails rejects (no `stopped`) and leaves the client
stopped. The worker is started
from a `blob:` bootstrap
(`importScripts(workerUrl)`); its URL is revoked once the init message is answered or the client is terminated, so
ghost changes and crash restarts do not pile them up. A worker `error` event before init is answered (the script did
not load, the engine threw while loading) rejects `start()` with `worker: <message>` (logged too); later ones only log.
A request still queued when the engine stopped never reads its `r.fmo`.

Worker side (src/worker/worker.js):
* The stored files are `{path: ArrayBuffer | null}`; an engine reports changes as `{path: ArrayBuffer | null | false}`.
  `mergeFiles(prev, files)` (exported, pure) merges them: bytes and `null` (a tombstone: a shipped file the ghost
  deleted, kept so it stays deleted) are set, `false` deletes the key (a file of its own the ghost deleted). Satori
  reports bytes only. `hasSave(files)` (exported): some value is bytes, so tombstones alone are no save; an empty
  `ArrayBuffer` counts (Kawari's snapshot marker: a ghost that writes no file is still met, kawari-wasm.md D7).
* init: the stored files through `readFiles(store, storeKey)` (exported) -> `{files, ok}`: `{}` and ok when nothing
  is stored; a read that rejects (`Store.read`) or a value that is not a plain map of `ArrayBuffer` / `null` -> ok
  false, and the worker runs memory-only for this page (`store` null: the record it could not read is never written
  over; one `warn`). Then `createEngine(engine, {engineUrl, wasmUrl: m.wasmUrl || null, ghostDir, log, saori, opts:
  engineOpts})`, then `engine.init(files, persisted, {resume: resume && hasSave(persisted), bootEpochMs, volatile,
  sessionEndMs: m.sessionEndMs || 0})`, where `volatile` is the page's stored engine state on a resume and null on a
  cold start; on a resume `setVolatileState(volatile)` after it (Satori's P6;
  YAYA reads its stamp in init instead); then the engine's first report is stored at once (`{t:'saved'}` names every
  changed key, deletions included): YAYA's holds what load wrote or deleted (on a resume where load wrote anything,
  with the save written again from the restored variables first); Satori's base takes its baseline after load, so what
  Satori's load wrote is stored only once something rewrites it (a request, the scheduled save, unload).
* `{t:'req', id, text, fmo?, kind?, self?}`: `engineRequest(engine, m)` (exported): `engine.setFmo(m.fmo)` when
  `m.fmo` is a string ('' included) and the engine has `setFmo`, then `engine.request(m.text, {kind, self})` (both ''
  when absent; only Kawari 7 reads them); then `engine.changedFiles()` before the
  reply, so the reply's `ms` holds that check too (a root engine scans only after a request that wrote), and the files
  it found are stored after the reply (a throw there is thrown after the reply).
  `SatoriEngine.setFmo(text)`: a string sets `Module.fmoText` (P8 reads it at every （FMOn…）, （Xの存在）, （Xのサーフェス）);
  anything else deletes it, and Satori keeps the list it read last (as when SSP's FMO cannot be opened). YAYA has no
  `setFmo`.
* `errorText(e, stack?)` (exported, pure): what failed as text. Emscripten's `FS.ErrnoError` is no Error (no message,
  no stack): `ErrnoError (errno 44)`, not `[object Object]`. Used for the worker's error log and `{t:'error'}` replies.
* init's reply carries `ghostDir` (the engine's). `{t:'write', path, data}` (EV §4.15): `engine.writeMasterFile(path,
  data)` before the handler's first `await`, reply `{t:'written', path: <full path>}`, then the engine's report is
  stored at once. `{t:'read', path}`: reply `{t:'read', data: ArrayBuffer | null}` from `readForUpload(engine,
  stored, path)` (exported): null without an engine or its `readMasterFile`, for `personalFile(path)` and for
  `visitorFile(stored, path, keyPrefix(engine))`, else `engine.readMasterFile(path)`. `keyPrefix(engine)` (exported):
  what the engine's stored keys put before a ghost/master path, `ghostDir` minus `ghostRoot` ('ghost/master/' for a
  root engine; '' without a `ghostRoot`: Satori). The worker's stored files take each report before it awaits the
  store, so a `read` after a request already sees the files that request wrote.

Engines (src/worker/engines/; `ENGINES` in index.js, = `SUPPORTED_ENGINES`): one class per engine, constructed with
`{engineUrl, wasmUrl, ghostDir, log, saori, opts}` (`EmscriptenShiori` keeps `wasmUrl`, and its `boot()` gives
Emscripten `locateFile: f => wasmUrl && /\.wasm$/i.test(f) ? wasmUrl : base + f`, base = `engineUrl`'s folder: a
`.wasm` from the page's table, anything else, and every file without `wasmUrl`, next to the `.js`;
`SspRootShiori` passes it through, and the Satori, YAYA and Kawari classes hand their options on): `boot()`;
`init(files, persisted, {resume, bootEpochMs, volatile, sessionEndMs})` -> ok (only Kawari reads `sessionEndMs`);
`request(text)` -> the response text ('' when the engine gave none, a 500 response when it threw); `save()` -> true
when it wrote its save now; `changedFiles()` -> what changed since the last report; `unload()` -> the same after the
engine's unload; `getVolatileState()` (sent with every response) / `setVolatileState(v)`. `EmscriptenShiori`
(emscripten.js) is the base for Emscripten builds of the POSIX SHIORI ABI (index.js: `load(dir, len)` frees `dir`;
`request(req, &len)` frees `req` and returns a malloc'd reply without a NUL that the caller frees; `unload()`);
`ntfsOrder(files)` is exported (folders list and dictionaries load in NTFS order, as on Windows). Its `masterPath(rel)`
resolves a path inside `ghostDir` (`\` as `/`, `.` and `..`; null when it leaves the folder); `writeMasterFile(rel,
data)` writes there (folders made; throws outside it) and returns the full path, which `changedFiles()` then reports
like the engine's own writes; `readMasterFile(rel)` -> ArrayBuffer | null. `_stackGuard(fn)` runs `fn()` and, when the
module exports `stackSave` and `stackRestore`, puts the stack pointer back first after a throw (a runaway recursion's
RangeError skips the epilogues that would): `request`, `callLoad` and `unload` go through it. Kawari exports both;
the Satori and YAYA builds do not, so nothing changes for them (kawari-wasm.md D8).

`SspRootShiori` (src/worker/engines/ssproot.js): the base of the root engines (YAYA, Kawari; `ROOT_ENGINES` in
engine-files.js; yaya-wasm.md MEMFS and persistence):
* `opts` = engineOpts `{ghostId, placeholders: [ghost-root-relative path], site: {ghosts: [{id, name, sakuraName,
  keroName, craftman, shiori}], balloons: [id]}}` plus the engine's own (YAYA's `module`, `lang?`); an in-process host
  (the sweep, tests) may also pass `onEngineLog({mode, text})`.
* The ghost root `ghostRoot` is `/ssp/ghost/<ghostId>/` (`/`, `\`, '', `.` and `..` made `_`), the persistence root;
  `ghostDir` = root + `ghost/master/` (the worker's ghostDir is ignored). `files[].path` and the persisted keys are
  ghost-root-relative. `_mount(files, persisted)` first writes the SSP view (`_sspView`): `/ssp/ghost/` lists the
  site's ghosts, each other one with a `ghost/master/descript.txt` from the `_descript(g)` hook (YAYA: `sspDescript(g)`
  in UTF-8); `/ssp/balloon/<id>/` are empty folders. Then the placeholders (empty), the site's files (a shipped file
  beats a placeholder), tombstoned paths dropped and the visitor's copies over the rest, in one NTFS-ordered pass; it
  returns the number of placeholders and sets `inputs` (the lower-cased paths that came from the site).
* `dicStamp` (set first in `init`): `_stampChanged(resume, volatile)` is true for a resume whose `volatile.dicStamp`
  differs, which then loads cold (`STAMP_CHANGED` = 'dictionaries changed since the last boot: loading as after an
  update', info; no stamp: the resume stays). `timing` {module, load} in ms.
* `changedFiles()`: new or rewritten files -> bytes (a rewritten shipped file shadows the site's copy from then on);
  gone -> `null` when the path came from the site (shipped or placeholder), else `false`; the first call reports
  against the scan before load, so it holds what load wrote or deleted; `*.log` never; folders never (an empty one is
  not kept). `scan()` stamps each file `mtime:size:inode`, walking MEMFS's nodes from the root (a folder's `contents`,
  readdir's order; `scans` counts the calls); a file stamped in the millisecond of the last report also counts by its
  bytes (FNV-1a, `_hot`), as MEMFS's mtime is `Date.now()`'s and a rewrite in that millisecond keeps it. A name a
  folder lists without its MEMFS node (not in MEMFS's name table: an unlink in another case before J1) is dropped as
  gone. `boot()` installs `watchWrites(M.FS, this)` (exported): the FS calls that can change a file (`open` with write
  access, O_CREAT or O_TRUNC; `write`, `truncate`, `ftruncate`, `allocate`, `msync`, `unlink`, `rmdir`, `rename`,
  `mknod`, `mkdir`, `symlink`, `utime`) set `dirty`; `changedFiles()` returns `{}` without a scan while `dirty` is
  false and `hot` is empty, and clears `dirty` after a scan. Code that changes MEMFS around those calls must set
  `dirty` itself.
  `getVolatileState()` -> `{dicStamp}`; `setVolatileState` does nothing.
* Exported: `rootBridge(bridge, root)` (the SAORI bridge, with `/ssp/ghost/<id>/x` passed as `/x`, the paths Satori's
  ghosts give), `sspDescript(g, charset = 'UTF-8')` (the text; its first line says `charset,<charset>`), `LogLines`,
  `diffScan(baseline, now, inputs)` (maps path -> stamp; a stamp that differs is a change), `dicStamp(files)` (32-bit
  FNV-1a, 8 hex digits, over path, length and bytes of every shipped file under `ghost/master/`, in NTFS order),
  `STAMP_CHANGED`, `clock`, `ms`, `toU8`. yaya.js re-exports `rootBridge`, `sspDescript`, `LogLines`, `diffScan` and
  `dicStamp`.

`YayaEngine extends SspRootShiori` (src/worker/engines/yaya.js; docs/research/yaya-wasm.md):
* `opts.module` (default 'yaya'), `opts.lang`.
* `init`: the base's mount and stamp, then `yaya_set_module_name(module)` and `_load`, or `_yaya_load_resume` on a
  resume; `status` = `yaya_load_status()`: 0 normal and 1 emergency boot (true; 1 warns), 2 suppressed, 3 shell mode
  and -1 fail (false, each with its warn line). One debug line `yaya <module>: <status>, module N ms, load N ms, stamp
  N ms, heap N MB, N files N KB, N placeholders`. On a resume, when load wrote anything, `init` calls `save()` first:
  the first report then holds the restored variables, not load's.
* `save()` = `_yaya_save() === 1` (the variables file now, when the config's `save.auto` is on).
* YAYA's log: `Module.yayaLog(text, mode)` fragments become whole lines (`LogLines`); fatal / error / warning / note go
  to `log('debug', 'yaya <mode>: <line>')` and `onEngineLog`, info and other to `onEngineLog` only (mode 'info'), the
  rest is dropped.
* The wasm (engines/yaya/build.py, patches.py; yaya-wasm.md §4): `load`, `request`, `unload` (upstream; `request`
  frees its input, Y2); `yaya_set_module_name(utf8, len)` before load (`<module>.txt`, `<module>_emerg.txt`,
  `<module>_variable.cfg`); `yaya_save()` -> 1 written; `yaya_load_resume(dir, len)` (load, then the saved variables
  restored again from the save as it was before the dictionary's load ran: N3/N4; 0 when loading threw);
  `yaya_load_status()` (-1 no VM, 0 normal, 1 emergency, 2 suppressed, 3 shell mode); `CI_check_failed` (upstream, for
  parity tools); `malloc`, `free`. Module hooks: `saoriBridge` {load(path, dir) -> handle | 0, request(handle,
  Uint8Array) -> string | Uint8Array, unload(handle)} (Satori's interface), `yayaLog(text, mode)`, `bootEpochMs`
  (GETTICKCOUNT's zero). Runtime methods `FS`, `HEAPU8`, `HEAP32`, `UTF8ToString`, `stringToUTF8`,
  `lengthBytesUTF8`, `ENV` (preRun sets `ENV.TZ` to the browser's zone and `ENV.LANG` from `opts.lang`). The linked
  yaya.js is patched too (`JS_PATCHES`, J1): MEMFS's unlink, rmdir and rename-over remove a name in the case it was
  made in, so `FDEL('VAR/NOTE.TXT')` of `var/Note.txt` leaves nothing listed.

`KawariEngine extends SspRootShiori` (src/worker/engines/kawari.js; KAWARI Phase 8.2.8, engines/kawari/build.py;
docs/research/kawari-wasm.md):
* `opts` = the base's `{ghostId, placeholders, site}`; no module (Kawari reads `ghost/master/kawarirc.kis`). An
  in-process host may pass `onEngineLog({mode: 'error' | 'warning' | 'log', text})` (`kawariLogMode(text)`: the
  lexer's `: error: ` / `: warning: ` marker, else 'log').
* `boot()`: `factory()` = `importScripts` + `self.createKawari`; Module hooks `saoriBridge` = `rootBridge(saori,
  ghostRoot)` and `kawariLog(line)` (UTF-8, one line per call; `Module.kawariLogLevel`, a number, default 3 =
  error|warning). Every line goes to `log('debug', 'kawari: <line>')` (the console only with `?sumika-debug`) and to
  `onEngineLog`. A ghost's `logfile` never writes a file (patch K9).
* `request(text)` is the base's: Kawari is Shift_JIS inside, and the build converts at its edges (patch K4: a request
  saying `Charset: UTF-8` reaches the ghost in code page 932 saying `Shift_JIS`, the reply comes back in UTF-8 saying
  `UTF-8`; encoded as ssp.exe does, `WideCharToMultiByte(932, 0)` with best fit, research R1). No `setFmo`.
* `_descript(g)`: another site ghost's descript.txt in code page 932 saying `charset,Shift_JIS`
  (`_kawari_utf8_to_cp932`, best fit, `?` for what 932 lacks; UTF-8 without the export), as KEEPS ghosts textload it.
* The resume: Kawari's only state is its dictionary and it has no save of its own (the ghost saves
  what it wants, often only in `System.Callback.OnUnload`), so the worker's `save()` stores a snapshot of the entries
  this session changed, and of those its load made (load-made: left by load with other words than the definitions it
  read, changed or not; kawari-wasm.md §8), under `RESUME_KEY` = `?kawari/resume.kis` (exported; `?` never occurs in a
  Windows file name) in the ghost's stored files, `/sumika/resume.kis` in MEMFS (outside `/ssp/`: the ghost never sees
  it; `save()` leaves `dirty` as it found it). Its three states: absent (never met); an empty buffer (met, nothing to
  restore: written at a clean unload, D7, by the first `save()` that finds nothing to carry, and when a snapshot is
  dropped); bytes = `'# dicStamp <8 hex>\n'` +
  `_kawari_snapshot`'s file (code page 932, LF; `stampSnapshot(stamp, body)`, `snapshotStamp(bytes)` -> the stamp |
  null, both exported). `hasSave` counts the empty buffer, so `firstBoot` stays false for a ghost that writes no file.
* `init(files, persisted, {resume, volatile, sessionEndMs = 0})`: the stamp; the snapshot key taken out of
  `persisted`; the base's mount; a site id that does not come back unchanged from code page 932 (`cp932Writable(text, encode)`, exported: the
  build's encoder, then the `shift_jis` decoder) warns 'site id "<id>" is not writable in code page 932: Kawari would
  not find its files' and gives false; without `ghost/master/kawarirc.kis` (any case: the build's FS is
  case-insensitive) warn 'no kawarirc.kis: nothing to load' and false (Kawari's load never fails, it would answer 204
  to everything). Then `_load` and
  `_kawari_baseline()` (`entries`). With a stored snapshot (`resumed`): a resume whose `volatile.dicStamp` changed, or
  a snapshot of another stamp, drops it ('dropped'; the latter logs 'the snapshot of the last session is of other
  dictionaries: dropped' at info); a resume restores it ('restored'; no OnBoot, as for every engine; a failed restore
  warns 'the resume snapshot did not load: this page goes on from the ghost's own save'); a cold boot finishes the
  last session first, which ended without an unload (D6 [decision]: restore, then `closeFromOutside()`
  when the snapshot loaded, then `_unload` (OnUnload), both inside `runAt(sessionEndMs, fn)`, then `_load` and the
  baseline again on the real clock; 'finished', info `D6_FINISHED` = 'the last session ended without Close: it was
  closed from its snapshot (OnClose "system", OnUnload) before this boot'; `d6Close` = the close's result, null when
  none was sent; `d6At` = the end the close and unload ran at, 0 on the real clock (then also debug `<name>: closed at
  the session's end, N min before this boot`); the snapshot is dropped). The first report holds what load, D6's close
  and its unload wrote (their past mtimes still differ from the scan before load). One debug line `kawari: module N
  ms, load N ms, stamp N ms, heap N MB, N files N KB, N placeholders, N entries[, snapshot
  restored|finished|dropped]`. `bootEpochMs` is not used (Kawari's clock is the date).
* `closeFromOutside()` -> `{steps: [{id, status}], ms}`: the close ssp.exe 2.9.10 sends each ghost when Windows ends
  the session (shiori-events.md §2.3.1), through `this.request` (Kawari 7's bridges it): GET OnCloseAll with
  `END_SESSION_REFS` = `['system', '0', '0']` (exported, frozen) and BaseID OnClose; GET OnClose with the same
  References when that reply has no script (a 2xx with a non-empty Value, as the page's `valueOf`); GET OnTranslate
  [the script, '', the event that answered, 'system'] (kind `translate`) when one has a script. Every reply is
  dropped; a throw is logged at error and the close goes on. Debug line `<name>: closed from outside: OnCloseAll 204,
  OnClose 200, OnTranslate 204 (N ms)`. `endSessionRequest(id, refs = END_SESSION_REFS, headers = {})` (exported) =
  `buildRequest({id, refs, headers}, BASE_HEADERS)`. The sweep's D6 check calls it on a resumed engine.
* `runAt(startMs, fn)` (exported) -> the start used | 0: `fn()` with `Date.now` going on from `startMs` (start + the
  time since), then whatever `Date.now` was put back in a `finally` (a throw included). Only a finite `startMs` with 0 <
  startMs < `Date.now()` moves the clock; else `fn()` runs on the clock as it is and the result is 0. Both Kawari builds
  read the time only through `Date.now` (`emscripten_date_now`): `time()`, `date`, MEMFS mtimes; `new Date()` and
  `performance.now` do not move (kawari-wasm.md §8).
* `save()` -> true when a snapshot was taken (`_kawari_snapshot(path, 0)`); `changedFiles()` = the base's, plus
  `RESUME_KEY` when its bytes changed since the last report. `unload()`: `_unload` (OnUnload), then the empty marker;
  after an `_unload` that threw the last snapshot stays, so the next cold boot can still finish that session.
* The wasm (engines/kawari/build.py, patches.py K1-K12, em_kawari.cpp): `load`, `request`, `unload` (Satori's ABI);
  `kawari_baseline()` -> the number of entries | -1 without an engine (it also marks the load-made entries, from K12's
  definition hooks); `kawari_snapshot(path, all)` -> bytes written, 0 = nothing to carry (the file is always
  rewritten), -1 = no engine or unwritable (`all` = 0: the entries that differ from the baseline, the load-made ones
  and a `# clear` for each defined entry load emptied; `all` = 1: every entry, for the sweep); it leaves out
  `System.Request*`, `System.Response*`, write-protected entries and names with CR, LF or NUL;
  `kawari_restore(path)` -> 1 | 0; `kawari_utf8_to_cp932(s, len, &outlen)` -> a malloc'd buffer the caller frees;
  `malloc`, `free`. Runtime methods `FS`, `HEAPU8`, `HEAP32`, `UTF8ToString`, `stringToUTF8`, `lengthBytesUTF8`,
  `stackSave`, `stackRestore`.
* Hooks for a subclass (Kawari 7): `resumeKey` (`RESUME_KEY`), `rcFile` ('kawarirc.kis': the file whose absence fails
  init with `no <rcFile>: nothing to load`), `name` ('kawari': the debug line's prefix), `cp932Export`
  ('_kawari_utf8_to_cp932'), `_load()`, `_restoreCall(p)`, `_snapshotCall(p)`, `_canSnapshot()`.

`Kawari7Engine extends KawariEngine` (src/worker/engines/kawari7.js; KAWARI Phase 7.5.0, engines/kawari7/build.py;
docs/research/kawari7-wasm.md): a Phase 7 ghost (`ghost/master/kawari.ini`) as a Phase 8 one, with these differences.
* `factory()` = `self.createKawari7`; `resumeKey` = `RESUME_KEY7` = `?kawari7/resume.k7` (exported; the `K7SNAP 1`
  format of kawari7-wasm.md §8, stamped as Phase 8's); `rcFile` 'kawari.ini'; `name` 'kawari7'; `entries` from
  `_kawari7_entries()` (the entries after the last load's `system.OnLoad`).
* `_load()`: `load`, then ssp.exe's handshake (`shiori2.js` `VERSION_REQUEST` in ASCII; the 3.0 probe only when
  `readVersionReply` says so) into `session` (a `Shiori2Session` {version ×10, charset, name, craftman}); after every
  load, D6's second one included. Debug line `kawari7: <name> SHIORI/<version>, <charset>`.
* `request(text, {kind, self} = {})`: `toShiori2(text, session, {kind, self})`; none planned (what ssp.exe never sends
  a 2.x SHIORI) -> `NOTHING` (`SHIORI/2.6 204`); else the one 2.x request, encoded in the session's charset (code page
  932 with the build's best-fit encoder for Shift_JIS, UTF-8 for UTF-8, ASCII for the handshake), its reply decoded
  the same way (`_kawari7_cp932_to_utf8`), then `fromShiori2(reply, kind)`. A throw (a runaway recursion) is a 500
  after the stack guard, as Phase 8.
* The wasm (patches C1–C9, em_kawari7.cpp): `load(dir, len)`, `request(req, &len)` (bytes unchanged), `unload()` (a
  second one answers 0, a request after it the build's 500: C9); `kawari7_snapshot(path)`, `kawari7_restore(path)`
  (leading `#` lines skipped), `kawari7_entries()`, `kawari7_dump(path)` (every entry, the sweep's),
  `kawari7_utf8_to_cp932`, `kawari7_cp932_to_utf8`, `malloc`, `free`.

`src/worker/engines/shiori2.js` (pure; kawari7-wasm.md §6): `VERSION_REQUEST`, `VERSION_PROBE_30`, `NOTHING`;
`Shiori2Session`; `parseMessage(text)` -> {start, list, map, refs, get(name)} (the first header of a name wins, any
case); `readVersionReply(reply, session)` -> {version, status, probe30} (sets the session: version from the status
line ×10, ID and Craftman from a 2xx, Charset); `toShiori2(text, session, {kind, self})` -> [{kind, text}] (0 or 1
requests; kinds 'event', 'notify', 'string', 'translate', 'teach', 'word', 'sentence'), byte-exact as ssp.exe 2.9.10
builds them (the page's kind 'word' -> `GET Word SHIORI/2.0`, Charset, Sender, `Type: <ID>`); `fromShiori2(reply,
kind)` -> the page's reply text: the 2.x status line kept, `Charset: UTF-8`, the reply's headers but Charset and Value,
`Value` = Value / Sentence (String first for 'string'; Value / Word for 'word') for 200, 311 and 312; no reply:
`SHIORI/2.6 500`.

## MIDI protocol (page: src/core/midi.js; the bundle: src/midi/)
One bundle, `sumika/engines/midi.<h>.js` (the table's `midi.js`, an IIFE), is loaded twice by the page: as a classic
Worker (bank.js) and as an AudioWorklet module (processor.js); it picks its role by its global scope. The bank is the
table's `midi.bank` (`generaluser_gs.<h>.sf3.gz`, `h` = the name hash of the inflated SF3). Both are fetched only when
a ghost first plays a MIDI file.

Worker (MidiEngine; started from a `blob:` bootstrap `importScripts(<absolute js URL>)`, as ShioriClient's, so the
runtime may live on another origin):
* worker -> page `{t:'up'}` first (the page revokes the bootstrap URL and starts `addModule` once a context exists).
* page -> worker `{t:'bank', url}` right after `new Worker` (the absolute bank URL; the download starts at once).
* page -> worker `{t:'prepare', id, midi}` (`midi`: an ArrayBuffer, transferred); worker -> page `{t:'prepared', id,
  sf2, midi, duration}` (both transferred; `duration`: seconds from tick 0 to the file's end) or `{t:'failed', id,
  kind: 'bank' | 'midi', message}`. A bank failure fails the waiting prepares and the next prepare downloads again.
* The Worker's `error` event fails every waiting prepare; the page terminates it and makes a new one at the next.

Worklet node (`new AudioWorkletNode(ctx, 'sumika-midi', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount:
[2]})`, through its own GainNode, the volume, to the destination; one node per playing file):
* page -> node `{t:'load', sf2, midi}` first (transferred), then `{t:'play'}`, `{t:'pause'}`, `{t:'seek', time}`,
  `{t:'loop', on}`, `{t:'close'}`, in order; every command carries `n` (the page's running number).
* node -> page `{t:'ready', duration}` or `{t:'error', message}` after `load`: at once when no other node of the
  context sounds, else after the load's slices from process() (midi.md §5.4; a command sent before `ready` is applied
  after it, in order; `close` drops the load); `{t:'state', playing, pos, at, n}` after
  each play / pause / seek / loop and at each start-over of a loop (`at`: the worklet's `currentTime` when `pos`
  held); `{t:'ended', pos, n}` at the song's end without loop; `{t:'closed'}` after `close` (the release tails rung
  out, at most 2 s). `n` is the number of the last command the node applied: the page drops a `state` or `ended` older
  than its last play, pause or seek. `processorerror` counts as `error`; any command that throws in the
  processor answers `error`.
* The page never sends a seek at or past duration − 0.001 s (core 4.3.22 throws there); the processor guards
  the same (END_GUARD_S): a seek there while playing ends the song (or starts it over with loop), while paused the
  position is the end and `play` starts at 0.

The bundle's modules (docs/research/midi.md §5; tools/build.mjs `midiOptions` aliases `spessasynth_core`,
`stb-vorbis` → src/midi/vorbis.js and `stb-vorbis-impl` to the folders engines/midi/pins.json pins):
* src/midi/engine.js — the entry: `registerProcessor` a function → installWorklet(globalThis); `importScripts` a
  function → installWorker(globalThis); else nothing runs. Exports the pieces for tests/midi_engine.test.mjs (built as
  ESM with the same options): songOf, songSteps, toArrayBuffer, SONG_STEP_EVENTS 256 (song.js); bankBytes, crc32,
  usedKeys, prepareSong, BankWorker, installWorker, BANK_STALL_MS 30000 (bank.js); SongPlayer, installWorklet, TAIL_S
  2, CLOSE_TAIL_S 2, END_GUARD_S 0.001, LOAD_SLICE_MS 1 (processor.js).
* src/midi/song.js — songOf(bytes) -> core's BasicMIDI: `MThd`, or `RIFF` … `RMID` (its embedded bank dropped), else
  throws 'not a MIDI file'; its end moved to the file's last event when later than core's lastVoiceEventTick;
  `duration` in seconds from tick 0. songSteps(bytes): a generator that yields every SONG_STEP_EVENTS events of an SMF
  (core's own reads, into core's classes, then core's flush) and once before the flush, and returns songOf's song (an
  RMID: songOf in one step); errors as songOf's.
* src/midi/bank.js — bankBytes(bytes) -> the SF3 (a gzip member inflated and checked against ISIZE and CRC-32, or the
  SF3 itself; `RIFF` `sfbk` of its own length; else throws 'not the sound bank'); usedKeys(song, bank) (every velocity
  of each key played, every key when the song retunes); prepareSong(song, sf3) -> {sf2, presets, samples};
  BankWorker({fetch, post, setTimeout, clearTimeout, AbortController?}).message(m): the Worker protocol above.
* src/midi/processor.js — SongPlayer({sampleRate, post, now, busy?, clock?}): message(m), render(L, R) -> false only
  after `closed` or a failure; quiet(); the worklet protocol above. busy() (default false): another song sounds, so a
  load runs in steps from render, LOAD_SLICE_MS of clock() (default Date.now) per call, at least one step; with busy()
  false it runs in one go inside message(). installWorklet's busy: another player of the scope is not quiet().
* src/midi/vorbis.js — what core imports as `stb-vorbis`: the package evaluated lazily, never in a worklet scope
  (there `ready` is resolved and `decode` throws).

## Hub protocol (page: src/core/hub.js, src/core/portstore.js, the worker; hub: src/hub/; constants: src/core/hubproto.js)
With `data-hub` on the script tag (main.js) a page keeps every visitor record at the runtime host's origin, in a
hidden iframe of `sumika/hub.html` (the storage hub), so pages on several origins of one site share one
visitor. The protocol, not the build, is the contract between a page and a hub: a hub answers every version in
`[HUB_MIN, HUB_MAX]`; within a version changes are additive only (an older peer ignores a new optional field; a new op
an older hub does not know is answered `unknown op`); anything an older peer would misread takes a new version, and a
hub keeps answering the old one while builds speaking it may still be cached (prune's 14 days plus the hosts' cache).
`src/core/hubproto.js` holds the shared constants: HUB_PROTOCOL 1 (the page's), HUB_MIN = HUB_MAX = 1 (the hub's),
HUB_PARAM 'sumika-hub' (the page plants `<hub url>?sumika-hub=<HUB_PROTOCOL>`, the URL's own query kept), HELLO
'sumikaHubHello', LOCAL_PREFIX 'sumika:', SESSION_PREFIX 'sumika.', STORE_DB 'sumika', NAME_PREFIX 'sumika',
PROBE_COOKIE 'sumika-hub-probe', REASONS ['origin', 'allowlist', 'version', 'site', 'storage', 'busy'], STAMP
/^[A-Za-z_]\w*$/, RETIRED 'retired' (a retired store port's answer to a write), isLocalKey, isSessionKey, isName.
Neither side edits it without the other. The visitor's choice `sumika:choice` (core/choice.js) is one more
`sumika:` key: it reaches a page in the welcome's `local`, with no protocol change (the control page writes it at the
hub's origin directly, as a page of that host).

Opening:

| Direction | Message |
|---|---|
| page → hub window | `iframe.contentWindow.postMessage({sumikaHubHello: 1, v: HUB_PROTOCOL, debug: bool}, hubOrigin, [port2])`, after each `load` of the frame until one hello is acked (an error page may load first) |
| hub → page port | `{t:'ack'}`, at once, before any check |
| hub → page port | `{t:'welcome', v, local: {key: value}, session: {key: value}, otherUnits: number, caps: {locks, channels, store: 'indexeddb'\|'memory', estimate}}` |
| hub → page port | `{t:'refused', reason: one of REASONS, v: [HUB_MIN, HUB_MAX]}`, then the hub closes the port |

- The hub ignores window messages without `sumikaHubHello === 1`, without a port, or not from `window.parent`, and
  answers only an allowlisted origin (its `sumika/hub.json`); a second hello to the same hub document is refused with
  `busy`. Every answer goes on the page's private port; the hub never posts to the window.
- The page counts the hub usable when the ack comes within HUB_ACK_MS (2.5 s) of a `load` (the timer is checked once
  more one task later: the timer and the ack share one event loop), the welcome within HUB_WAIT_MS (10 s) of
  planting, and its `v` is HUB_PROTOCOL. Anything else: the fallback (CONTRACTS core/hub.js). `caps.store` 'memory'
  (no IndexedDB at the hub: Firefox's private windows before 115) is no reason to fall back: the page's own engine
  worker would keep its save files in memory there too (a worker has no localStorage).
- The page takes from any hub message only `sumika:` keys (local, a delta) and `sumika.` keys (session) with string
  values (null in a delta: removed); other entries are dropped.

Page → hub ops, on the private port: every message is `{op, ...}`. Ops with a `rid` get exactly one `{t:'reply', rid,
ok: true, value}` or `{t:'reply', rid, ok: false, error}`; ops without one get no reply, their failures come as
`{t:'failed', op, key, error}`. Ops apply in arrival order. `rid`s are unique for the page.

| op | fields | hub does | reply value |
|---|---|---|---|
| `ls.set` | `key, value, seq?` | `isLocalKey`; `localStorage.setItem(key, String(value))`; `known.set(key, value)`; an integer `seq` above the connection's becomes its `seq` (stored or failed) | — (`failed` on error) |
| `ls.remove` | `key, seq?` | removeItem; `known.delete(key)`; `seq` as for `ls.set` | — |
| `ss.set` / `ss.remove` | `key[, value]` | `isSessionKey`; sessionStorage | — |
| `flush` | `rid, session?: [keys]` | nothing more (FIFO: every earlier op applied) | `{failed: [keys failed since the last flush], session: {k: current value or null}}` |
| `sync` | `rid` | full delta against `known`; every `sumika.` key of the hub's sessionStorage (this tab's) | `{snap, session: {key: value}, seq}` |
| `lock` | `rid, name, ifAvailable` | `isName`; `navigator.locks.request(name, {ifAvailable}, l => ...)`; a grant holds until `unlock` or pagehide | `{granted: bool, snap, seq}` (snap and seq only when granted); `ok: false` with error `name`, `no locks`, `rid in use` or `aborted` (taken back: `unlock` before the grant, the hub's pagehide) |
| `unlock` | `rid` | held: commit the wills of that lock's name, then release; still waiting: taken back, its `lock` answered `aborted` (so every `rid` gets exactly one reply); an unknown or released `rid` is a no-op | — |
| `will` | `name, key, stamp` | recorded for this connection's held lock `name` (ignored when not held, or key or stamp invalid) | — |
| `bc.open` | `cid, name` | `isName`; `new BroadcastChannel(name)`; its messages → `{t:'bc', cid, data, snap, seq}` | — |
| `bc.post` | `cid, data` | that channel's `postMessage(data)` | — |
| `bc.close` | `cid` | close it | — |
| `store` | `pid`, transferred `port`, `retire?` | bind a store server to the port; first message on it `{t:'store', kind}`; `retire: true` (an engine start's port): retired at the hub's pagehide with `persisted` (below) | — |
| `estimate` | `rid` | `navigator.storage.estimate()` | `{usage, quota}` |
| any other | | | `ok: false, error: 'unknown op'` (with rid) or `failed` |

Hub → page, unsolicited: `{t:'storage', snap, seq}` (the hub's window `storage` event for a `sumika:` key or a clear:
the full delta against `known`, sent when it is not empty) and `{t:'gone', persisted}` (the hub's pagehide; the page
ignores `persisted: true`: both sit in the back/forward cache, the hub's channels and store ports kept for the
restore). A `failed` names in `key` what failed: the storage key for `ls.*` / `ss.*`, the channel name for `bc.open`,
the `cid` for `bc.post`, the `pid` for `store`. A failed `ls.set` / `ls.remove` leaves `known` as the hub's storage
holds it, so no later delta takes the page's copy away. `busy` is decided when a hello's checks end: of two hellos
checked at once, the first to finish is served.

Page semantics of the answers (core/hub.js): a lock reply `{granted: false}`, an `ok: false` reply or the hub's
going answers GhostLock's three-argument request with `cb(null)` (not acquired, never "run anyway") and rejects the
two-argument request (DropStore's), so its read-modify-write never runs without the lock; a grant's `snap` and a
channel delivery's `snap` are applied to the mirror (one `storage` event per key that changed) before the callback or
`onmessage` runs. Requests with a `rid` other than `lock` time out after 15 s. Every `snap` the hub sends is applied,
also one whose message nothing waits for (a channel the page closed while the delivery was on its way, a reply after
its request timed out): the hub counts it told (`known`), so a dropped delta would leave the mirror wrong for good.
Crossings: the page numbers its `ls.*` writes (`seq`, increasing; also while pending), and every message carrying a
`snap` echoes `seq`, the last of them the hub had handled when it took the delta; an entry for a key the page wrote
with a higher `seq` is skipped (that write lands at the hub next and wins there, as the page's later write would in
its own localStorage), and no `storage` event fires for it. A `snap` without `seq` (an older hub) applies every entry.
`sync` (Site's pageshow after the back/forward cache): every `ls.*` write posted before it is handled by then (one
FIFO port; a page's posts in a pagehide not persisted never reach the hub [measured, Chromium], and a pagehide into
the cache posts no write: below), so its `snap` applies in full but for later writes; its `session` replaces the session mirror (another page of the tab may have changed the tab marker, `sumika.lastInputMs`,
`sumika.reloadedFrom`, `sumika.hostRewrites`), except the keys the page wrote after sending it; a reply without
`session` (an older hub) leaves the session mirror as it is.

Hub state per connection: `known: Map<key, value>` (what the page's mirror holds: the welcome snapshot, then updated
by `ls.*`, `snap` and `storage`), `seq` (0 until the page numbers a write), held locks by rid, wills by name (`Map<key, stamp>`), channels by cid, store ports,
failed keys. The delta (`snap`): every `sumika:` key whose value differs from `known` → `{key: value}`, every `known`
key now absent → `{key: null}`; `known` updated; computed when a grant, a channel message or a `sync` reply is sent.
Commit of the wills of `name`: for each `key → stamp`, the JSON object at `key` with a numeric `stamp` field gets
`stamp` = the hub's `Date.now()`, written back (errors ignored, `known` not updated); then that name's wills are
cleared. The hub's pagehide (either `persisted`): every lock request not granted yet is answered `ok: false`
('aborted') and taken back (a grant must never reach a cached hub); each held lock's wills committed, then it is
released; held cleared; `{t:'gone', persisted}` posted. A document kept in the back/forward cache keeps its channels
and store ports (dropped files work after the restore); one that goes closes its channels, and its store
ports go with it (never closed early: a write on its way would be lost). With `persisted` the hub first retires every
store port the page marked `retire` (its engine starts'; the store host's `retire()`, which the store worker hears
after every port handed to it before): from then on each `set` and `delete` on it is answered `{rid, ok: false, error:
RETIRED}` and writes nothing; its reads are still answered; ports bound later are not retired.

The back/forward cache [decision]: a page and its hub frame go into the cache together, and what the page
posts from its pagehide on would wait at the cached frame and be applied after Back, over what another page (another
origin, through its own hub frame) wrote meanwhile (Firefox keeps both in the cache; the page's pageshow then syncs
and restarts). So from a pagehide with `persisted` to its pageshow the page posts no write (core/hub.js `hidden`: the
mirrors take them and the pageshow takes them back; the PortStores hold theirs), Runtime._onPageHide asks no engine
for its files, and the engine workers' store ports are retired at the hub (above), so a save an old worker posts
later (its save timer on the thaw after Back, before the restart replaces it) never lands. Lock releases and channel
posts still go (a late `unlock` is a no-op). The leave-flush (core/site.js) wrote everything before the navigation
began. Without `data-hub`, and at a pagehide not persisted, nothing changes. Known residue: a write the page posted
just before its pagehide that the frozen frame had not handled yet is applied after Back.

Store ports (one per user: a worker's engine start, marked `retire`; the page's dropped-file store):

| Direction | Message |
|---|---|
| hub → client, first | `{t:'store', kind: 'indexeddb'\|'memory'}` |
| client → hub | `{rid, op: 'read'\|'get'\|'set'\|'delete'\|'keys', key?, value?, prefix?}` (`key` / `prefix` strings) |
| hub → client | `{rid, ok: true, value}` or `{rid, ok: false, error}` |

Semantics are `Store`'s (core/storage.js), but on a retired port (above), where `set` and `delete` are answered `ok:
false` with error RETIRED: `read` the value or `undefined`, `ok: false` when it cannot be read; `get`
the value, or `undefined` when the read failed; `set` true when stored; `delete` false when refused; `keys(prefix)`
string keys in `IDBKeyRange.bound(p, p + '￿')`, `ok: false` when it cannot be listed. The hub's IndexedDB is database
STORE_DB, version 1, store `kv` (= storage.js DB_VERSION / STORE); writes `tx.commit()` where it exists. It runs in a
dedicated worker of the hub's origin (the hub script again; the frame itself when no worker can be made), so the
engine worker's save maps never cross the host page's thread. The client (core/portstore.js PortStore) treats every
op that gets no reply within 15 s as failed. Kind 'memory' from the hub: its ops are still sent (the hub document's memory map, set
answering false as Store's memory kind); a HubClient whose hub is not live answers a new store port itself with
`{t:'store', kind: 'memory', local: true}` (page-internal, never from a hub): this page's memory, nothing sent.

The worker's `init` gains `storePort` (a transferred MessagePort, or absent): with it the worker's store is
`PortStore.open(storePort)`, without it `Store.open(storeNamespace)`. Nothing else changes in the Worker
protocol.

## Admin core — admin/core/ (the JS twin of tools/index_site.py and tools/add_ghost.py; CLAUDE.md "The admin tool")
`admin/core/api.mjs` exports what the admin program (admin/server/) and `admin/cli.mjs` call. ES modules on `node:`
built-ins, no I/O beyond the folders given (never the project's `site/` unless named), nothing printed: `log(line)`
gets the Python tools' lines, `onProgress({phase, done, total, item})` the steps (phases `inspect`, `extract`,
`compare`, `copy`, `remove`, `index`; `total` null when unknown; the first and last step of a phase always, else at most
every 100 ms). Results are plain JSON values. Same outputs as the Python tools, byte for byte (a pack: the same name and
gunzipped content), kept so by `tests/admin/` and `npm run parity`; a change is made in both.

| Export | Signature → result |
|---|---|
| `inspectSource` | `(source, {site?, id?, archive?, keep?, leaveOut?, tempDir?, onProgress?})` → `Promise<Item[]>`: one Item per ghost of a ghost folder, a folder of ghosts (every sub-folder with `ghost/master/descript.txt`, linked ones excepted, and every `.nar` / `.zip` in it) or a `.nar` / `.zip` (extracted into a temp folder under `tempDir` or the OS's, deleted before it returns). `id`, `archive`, `keep`, `leaveOut` apply to a single ghost. Throws AdminRefusal `source.missing` / `source.notSource`; anything else a ghost's add would refuse is its Item's `refusal`. Nothing written. |
| `addGhost` | `(plan, site, {id?, archive?, keep?, leaveOut?, replace?, index? = true, log?, onProgress?, tempDir?, onStep?, io?})` → `Promise<{id, path, copied, balloon: null \| {dir, from, copied}, notes, excluded, index: IndexResult \| null}>`. `plan`: an Item (its `source`, `id`) or a path (a folder: id = its name as add_ghost.py; an archive: `proposeId`). add_ghost.py's checks in its order, then the copy (every folder, data only) and the balloon SSP moved into a staging folder `SITE/.sumika-admin-work/new-<6 hex>-<id>/`, renamed into `ghost/<id>` when complete (a replace renames the old folder aside first, `old-…`, and deletes it after: staging.mjs), then `indexSite` (unless `index: false`). An archive source is compared with itself unless `archive` names another. A Kawari ghost's save-header files: from an archive source kept (`note.kawariKept`) and recorded (the Kawari record, below; every add sets its ghost's entries, none dropping them); from a folder refused (`kawari.saveHeader`). A Kawari record that does not read refuses every add (`kawari.record`, right after the source check, where add_ghost.py reads it too; an inspect Item gets it as its `refusal` when `site` is given). A site folder of that id: refused (`site.exists`) unless `replace`; removed without following a link. Throws AdminRefusal before writing (or `site.personal` from the index after the copy, as add_ghost.py); a rename Windows keeps refusing (retried about 3 s) refuses with the site as it was (`work.rename` {path, error}), or `work.undo` {path, kept, error} when the old folder could not go back either (it stays as `kept`; `recoverWork` puts it back). `onStep(step, id)`, before each: `'copy'` (nothing visible changed yet), `'swap'` (the renames), `'placed'` (`ghost/<id>` is final), `'index'`. `io`: tests' stand-ins (`{rename?, retryMs?}`). |
| `removeGhost` | `(site, id, {log?, onProgress?, index? = true, onStep?, io?})` → `Promise<{id, path, link, index}>`: renames `site/ghost/<id>` into the work folder (`del-<6 hex>-<id>`), deletes it there (a link or junction, or one inside it, as a link: what it points to stays; what a held file keeps is left for `recoverWork`), drops its entries of the Kawari record once the folder is out of `ghost/` (a write of it Windows refuses leaves them, as a cut-off removal does, and the removal goes on: they accept only files an archive held as they are), and re-indexes; the index's older files stay for prune. Refused before deleting: `id.bad`, `ghost.missing`, `kawari.record` (the Kawari record does not read), `site.personal` (another ghost's personal files would stop the index), `work.rename`. `onStep` as addGhost's (`'swap'`, `'placed'`: the folder is out of `ghost/`, `'index'`). |
| `recoverWork` | `(site, {io?})` → `Promise<{entries: [{name, kind: 'new'\|'old'\|'del'\|'temp'\|null, id, action: 'deleted'\|'restored'\|'kept', error?}], clean}>`: settles what a cut-off add or removal left in `SITE/.sumika-admin-work/`: `new-` and `del-` entries deleted, an `old-` one renamed back into `ghost/<id>` while that is missing, else deleted; a name the core never makes deleted too (kind null; a link as a link: the folder is the program's own scratch); a link or junction in the work folder's own place is one entry (name '', kind null) deleted as a link, never followed; then each temporary file of the Kawari record a write cut off before its rename left (`sumika/kawari-shipped.json.tmp-<8 hex>`, a file or a link: kind `'temp'`, id null, `name` site-relative); `kept`: still there (in use, or an `old-` one that could not go back); the folder deleted when empty (`clean`). `workLeftovers(site)` → `[{name, path, kind, id}]` (nothing changed); `WORK_DIR` = `'.sumika-admin-work'`. |
| `indexSite` | `(site, {log?, onProgress?})` → `Promise<IndexResult {ghosts, sharedBalloons, bundledBalloons, defaultBalloon, written: [name], kept: [name], ids}>` (`ids`: the ghosts in ghosts.json's order, Change ghost ▸'s): index_site.py main (refuses with `kawari.record` or `site.personal`, nothing written; deletes nothing). |
| `indexState` | `(site, {onProgress?})` → `{upToDate, stale: [{path, code: 'index.missing' \| 'index.differs', why}], personal: [Personal], record: null \| Finding}`: what an index run would write, nothing written; `record`: the Kawari record does not read (`kawari.record`; then `personal` is empty and `stale` too: no index run passes). |
| `checkSite` | `(site, {onProgress?})` → `{site, ok, record: null \| Finding, personal: [Personal], index: null \| {upToDate, stale}, hub: {present, problems: [Finding]}, links: [{path, code: 'site.link', why}], work: [{path: '.sumika-admin-work/<name>', code: 'work.leftover', why}]}`; `record` as indexState's; `index` null while the record or personal files would stop the index; `ok` false while `work` names anything. `siteLinks(site)` → `links` alone (the links and junctions under `ghost/` and `balloon/`, none entered). |
| `hubFindings` / `hubJsonProblems` | `(site)` → `[Finding]` (`hub.unreadable`, `hub.unusable`, `hub.loopback`, `hub.ignored`) / their English lines: the publish gate on `sumika/hub.json` (`tests/build_output.test.mjs` imports it). |
| `personalFiles` | `(site)` → `Promise<[Personal]>`: index_site.py personal_files, in its order (a Kawari ghost's save-header file counts unless `KAWARI_SHIPPED_SAVES` or the Kawari record lists it for that ghost with its current CRC-32); reads the record first and throws its `kawari.record` (index_site.py: KawariRecordError). |
| `idProblem` / `proposeId` | `(id)` → a `name.*` code or null (one folder name Windows writes as it is) / `(root, {archive?})` → install.txt `directory` for an archive, else the folder's name, lower-cased. |
| `CODES`, `CODE_LIST`, `message` | every code → its English text; `message(code, params?, files?)`. |
| `AdminRefusal`, `refusalOf` | `Error` with `code`, `params`, `files: [{path, code, params?, line?, why}]`, `message`; `toJSON()` / `refusalOf(e)` → `{code, params, message, files}`. |
| `FORMAT` | index_site.py FORMAT (= loader.js INDEX_FORMAT). |

- **Item** = `{source: {kind: 'folder' \| 'archive', path, root?}, id, name, engine, module?, runs: {ok, code: null \|
  'engine.needs', params: null \| {engine}, note: null \| 'needs X'}, sizeBytes, fileCount, excluded: [{path, code,
  params?, why}] (a folder path ends with '/'), refusal: null \| Refusal (the first one, in add_ghost.py's order), notes:
  [Finding] (what add_ghost.py prints before the copy: `note.compared`, `note.undeleteMask`, `note.kawariHeader`,
  `note.kawariKept` {paths} (an archive source's Kawari save-header files, kept and recorded), `note.leftOut`; none
  after a refusal), terms: null \| {file, kind: 'terms' \| 'readme', excerpt, truncated} (the
  terms file SSP shows, else the readme's lines on terms; only a file the copy would take), balloons: [{dir, name,
  from: 'ghost' \| 'ssp', path?}], conflict: null \| {path, lostBalloons: [{dir, name}]}, archive, updateList}`.
  `Finding` = `{code, params?, message}`; `Personal` = `{path, code: 'personal.*', params?, why}`.
- **Codes** (`codes.mjs`): refusals `source.missing`, `source.notSource`, `source.notGhost`, `id.bad` {id, problem},
  `archive.unreadable`, `archive.noGhost`, `archive.unsafe` (files: `name.*`, `member.*`), `archive.damaged`,
  `compare.unreadable`, `compare.unlisted` (files `compare.notListed` / `compare.differs`), `kawari.saveHeader` (a
  folder source; files `kawari.runSave` / `kawari.shippedDefault` with `line`, the KAWARI_SHIPPED_SAVES line, which
  the page does not show), `kawari.record` {problem: `record.open` \| `record.json` \| `record.format` \|
  `record.entries`, a code of its own; index_site.py KAWARI_RECORD_PROBLEMS, the same texts}, `balloon.wouldLose` (files
  `balloon.lost` {name}), `site.exists`, `site.personal` (files `personal.*`), `ghost.missing`, `work.rename` {path, error}, `work.undo` {path, kept, error}; left out
  `personal.profile`, `personal.satoriSave`, `personal.satoriBackup`, `personal.variable`, `personal.log`,
  `personal.path` {pattern}, `program.dll`, `program.exe`, `windows.thumbsDb`, `windows.desktopIni`, `link.file`,
  `link.folder`, `archive.link`, `admin.leaveOut`; `personal.kawariSave` (the index's); names `name.empty`,
  `name.dots`, `name.separator`, `name.badChar`, `name.trailingDotSpace`, `name.device`; `engine.needs`,
  `index.missing`, `index.differs`, `hub.*`, `site.link`, `work.leftover`. A code is never renamed; a new one is added with its text.
- **The Kawari record** `SITE/sumika/kawari-shipped.json` (`admin/core/shipped.mjs`; `rules.mjs` `KAWARI_RECORD` =
  index_site.py's; such files are taken only from a ghost's `.nar` / `.zip` [decision]): `{"format": 1, "ghosts": {"<site
  id>": [["<ghost-root-relative path>", <CRC-32>], …]}}`, the Kawari save-header files each ghost's own `.nar` /
  `.zip` brought. Bytes: ids, then each one's entries, sorted as Python sorts (code points; path, then CRC-32),
  ghosts without entries left out, `json.dumps(…, ensure_ascii=False, indent=1)` + LF (`shippedBytes` =
  `kawari_record_bytes`); written only when they change, through `<file>.tmp-<8 hex>` (`SUMIKA_TEMP`) and a rename,
  the temporary file deleted when the write or the rename fails (try/finally in both); deleted when no ghost has
  entries (`setShipped(site, id, entries)` → the old entries = `set_kawari_record`). Read as `readShipped(site)` →
  `Map(id → [[path, crc]])` (= `read_kawari_record`), empty when the file is missing; one that exists reads whole or
  throws AdminRefusal `kawari.record` {problem} (= `KawariRecordError`, its `problem` and text) [decision]:
  `record.open` (it cannot be opened), `record.json` (strict UTF-8 after one BOM, an editor's, read past as Python's
  utf-8-sig; then JSON, json.loads' NaN and Infinity refused as JSON.parse refuses them, and an int longer than
  Python's int() takes read as JSON.parse's float), `record.format` (not an object with `format` 1, `1.0` too, and a
  `ghosts` object, or an id with an escaped lone surrogate, which neither tool could write again; ids are checked
  before entries; other keys ignored), `record.entries` (a ghost's value not a list of `[string, 0..0xFFFFFFFF]`, the
  string without a lone surrogate: a CRC-32 written as `3.0` or `1e2`, json.loads' floats, is none). Never
  read as empty: `setShipped` throws it too, nothing written, so every add, a removal and both index tools stop
  before anything changes until it is repaired, or deleted and those ghosts added again. `dropWriteTemps(site)`
  (`recoverWork`'s last step) deletes the temporary files a cut-off write of the record or of hub.json left. Ids match
  exactly, paths in any case. While a replace swaps its folders the ghost's entries are the old and the new ones
  together, so whichever `ghost/<id>` a cut-off swap leaves passes the index.
- **Never in a result:** a file's contents, but a readme's or terms file's excerpt (and only one the copy would take).
- **CLI** (`admin/cli.mjs`; also `run(argv, {out, err})` → status, in-process): `index [SITE]`, `add <src> [--id ID]
  [--site SITE] [--archive A] [--keep P]… [--skip P]…`, `remove <id> [--site SITE]`, `check [SITE]`, `inspect <src>
  …` (JSON); argparse's forms (`--opt=value`, unique prefixes); status 0, 1 (a refusal: its message on stderr) or 2
  (usage). `add` always replaces, as add_ghost.py. add_ghost.py's `--from-archive` (with `--archive <.nar|.zip>`, else
  status 2) is the CLI's `add <archive>`: the folder given is that archive's extraction.

## Admin API (program: admin/server/; its client: admin/page/; sumika-admin, CLAUDE.md "The admin tool")
The admin program (`node admin/server/main.mjs`; compiled, `sumika-admin[.exe]`) serves one page and this JSON API on
`http://127.0.0.1:<port>/` only: a random free port per start, IPv4 loopback, nothing else. The page is its only
client. Paths travel in JSON bodies or a header, never in a URL. The core's codes and shapes (inspect items, refusals,
left-out files) are the port's (`admin/core/codes.mjs` CODE_LIST, `admin/core/api.mjs`, "Admin core"): the program
passes them through unchanged and adds its own codes (`admin/server/codes.mjs` CODE_LIST). Both lists are what the
page translates (`code.<code>`, admin/page/strings.js; a code it lacks shows the English `message`).

**Opening.** The console prints `http://127.0.0.1:<port>/?key=<64 hex>` (32 random bytes, new at each start) and opens
it in the default browser. The page moves the key into `sessionStorage['sumika-admin-key']`, calls
`history.replaceState(null, '', '/')`, and sends it as `X-Sumika-Admin-Key` on every `/api/` call.

**No answer** (the page's side, admin/page/api.js `createApi`; CLAUDE.md "No answer is no stopped program"): a fetch
that fails, or a GET /api/status or /api/hello unanswered for `STATUS_MS` (10 s), is no stopped program yet. The
client asks GET /api/status (each unanswered for `PROBE_MS` 5 s counts as none; `BACKOFF_MS` 0.5, 1, 2 s apart),
`onState('waiting')` once the first such call gets nothing, `onState('stopped')` after `WAIT_MS` (20 s; then every
`RETRY_MS`, 3 s, for as long as the page is open), `onState('ok')` when it answers 200; a 403 there ends it
(`onAuthLost`). Then every call that lost its answer goes on: sent again, except a job start (inspect, add, remove,
index, check, prepare, a drop's done), which is the status's job when one of its kind started since it was sent
(`startedAt` >= the send's time − `START_SLACK_MS`, 1 s: one computer's clock), 409 `job-replaced` when another kind
started since (never sent again), and sent again only when no job started since; a preview start whose status shows
a preview answers that preview. Sent again: a PUT answered 409 `drop-exists` and a drop's cancel answered 404
`drop-missing` mean the first arrived (`{ok: true}`); a pick answered 409 `picker-open` {id} is the dialog the first
opened (`{open: true, id}`). A call that failed `MAX_SENDS` (3) times while the program answered between them fails
with the page's own code `not-sent` {error} (status 0); after `api.end()` (Quit, a 403) a lost answer fails at once
with `offline`. The page's own codes: `offline`, `not-sent`, `job-replaced`.

**Guards**, in this order, on every request (the page's too):
1. `Host` exactly `127.0.0.1:<port>`, else 403 `bad-host` (DNS rebinding).
2. `Origin`, when present, exactly `http://127.0.0.1:<port>`, else 403 `bad-origin`.
3. An unknown path: 404 `not-found`. Methods: `GET` for `/`, `/api/hello`, `/api/status`; `PUT` for
   `/api/drop/<drop>/<n>`; `POST` for every other route; anything else (`OPTIONS` included) 405 `method`. No response
   ever carries `Access-Control-*`.
4. `/api/*`: `X-Sumika-Admin-Key` absent: 403 `no-key`; wrong: 403 `bad-key` (compared in constant time; the page says
   the tab belongs to an earlier start). Never a cookie.
5. `POST`: `Content-Type: application/json` (parameters allowed) else 415 `not-json`; at most 1 MiB else 413
   `too-large`; a JSON object else 400 `bad-request`.

Every response has `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; the
page also `X-Frame-Options: DENY` and `Content-Security-Policy: default-src 'none'; script-src 'sha256-…'; style-src
'sha256-…'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` (the
hashes of its one inline script and its one inline style). A refused or failed call answers `{error: {code, params?,
message}}` (`message` in English: logs, and the fallback) with 400, 403, 404, 405, 409, 413, 415, 500 or 501
(`no-picker` only); a 500 `internal` (a fault, no refusal) is written with its stack to the program's
`sumika-admin.log`, never into the answer.

Shapes:
- `Finding` `{code, params?, message, files?: [{path, code?, params?, why?, line?}]}`: a problem, a refusal or a note.
- `Settings` `{file, where: 'beside'|'appdata'|'given', problem: Finding|null, language: 'ja'|'en'|null, site:
  string|null, recent: [string]}`. `where` 'given': started with `--settings FILE` (dev runs and tests only).
  `problem` `settings-unreadable` / `settings-bad`: the file is kept as it is (never overwritten), defaults in memory;
  `settings-write`: the last save failed. `language` null: follow the browser. `recent` (newest first, at most 10, no
  duplicates): the site folders chosen and the folders sources were picked in. Not shown to the page, kept in the
  file: `lastFolders` `{files?, folders?, site?, compare?}`, the folder each file dialog last picked in (full paths;
  written once a dialog picked something).
- `SiteInfo` `{path (its real path), runtime: {build, hub: bool, control: bool}|null, front: bool, ghosts: number
  (ghosts.json's entries), readOnly: 'index-format'|'schema'|null, readOnlyInfo: Finding|null}`. `control`: the
  runtime has the control page, where visitors turn Sumika on or off (`sumika/index.html` is a file; the Sharing
  screen says so when not, the Preview links it when so); `front`: the site has a page at its top (`index.html` is a
  file; the Preview's "Open the site" only then). A read-only site (another Sumika version's index or runtime)
  answers add, remove, index, prepare and hub/save with 409 `read-only`.
- `Job` `{id, kind: 'inspect'|'add'|'remove'|'index'|'check'|'prepare', state: 'running'|'done'|'failed', phase:
  string|null, done: number, total: number|null, item: string|null, label: string, startedAt, endedAt: number|null,
  result?, error?: Finding}` (a refusal of the core or the program as it is; `job-failed` {error}: a fault in the job,
  its stack in the log; `check-failed` adds `problems` beside its code; `job-crashed` has `{error}`, or `{exit}` when
  its worker ended without an answer: the page says the code, the log names the worker). Phases: the core's
  `inspect`, `extract`, `compare`, `copy`, `remove`, `index`, and the program's `add` (ghost i of n), `check`, `prune`,
  `list`, `settle` (asked for while the start still settles what an earlier one left, below: it begins after, and
  writes its journal then). One job at a time for the whole program (every tab): another start answers 409 `busy`
  (a job waiting in `settle` too). The last job, running or finished, is in every status answer until the next one
  starts.
- `Preview` `{site: 'http://127.0.0.1:<S>/', pages: ['http://127.0.0.1:<A>/', 'http://127.0.0.1:<B>/']}`.
- `Interrupted` `{kind: Job kind|null, label, startedAt, step: 'copy'|'swap'|'index'|null, outcome:
  'unchanged'|'index'|'prepare'|'unknown', ghosts: [{id, name, placed: bool}]}`: a job an earlier start never finished
  (a closed console window, a crash), as the start found it after settling the site's work folder (core
  `recoverWork`; `admin/server/outcome.mjs` `interruptedOf`). `step`: the last one the job's journal recorded (null:
  none yet; also null for a journal of an older version, which wrote none: then an add or removal is `unknown`).
  `outcome`: `unchanged` (inspect or check, or an add or removal cut off before anything visible changed),
  `index` (ghost folders are final, the index was not rewritten: the index job finishes it; also a cut-off index
  job), `prepare` (Prepare upload cut off), `unknown` (no step, no journal that reads, a site that cannot be read now,
  an old folder that could not be put back). `ghosts`: an add's or removal's ghosts by name, `placed` when its
  `ghost/<id>` became final (added, or removed). Kept until a job settles it (`settles`): any job for `unchanged`,
  else a finished index job or an add / removal that indexed (`index`), Prepare upload (`prepare`), Check or Prepare
  upload (`unknown`); a job asked for while the start settled (phase `settle`) settles it as it would have at its start.
- **The start** (admin/server/main.mjs): it serves, writes `instance.json` and prints its lines first, then tidies up
  in the job worker (the run folders of dead starts; core `recoverWork` on the work folder of the journal's site and of
  the chosen site), so the page loads and a second start finds this one while a big leftover is deleted. Meanwhile
  hello and status answer `starting: true` and hello's `interrupted` is null; jobs wait (phase `settle`); the
  journal read at the start is deleted once settled (a start closed meanwhile settles no further site and leaves it
  for the next). The page shows a line until status says `starting: false`, then
  asks hello again for `interrupted`.

| Method | Path | Body → answer |
|---|---|---|
| GET | `/` | the page (no key) |
| GET | `/api/hello` | → `{app: 'sumika-admin', version, os: 'windows'\|'macos'\|'linux', settings: Settings, site: SiteInfo\|null, siteError: Finding\|null (the settings name a folder that is no usable site now), interrupted: Interrupted\|null (a job of an earlier start that never finished, below; null while `starting`), starting: bool (the start still settles what an earlier one left: The start, above), job: Job\|null, preview: Preview\|null, picker: bool (the system's file dialogs; false: the page's file browser), pick: {id, purpose}\|null (the dialog open now, whichever tab opened it: the page waits on it at once)}` |
| GET | `/api/status` | → `{job: Job\|null, preview: Preview\|null, pick: {id, purpose}\|null, starting: bool}` (as hello's) |
| POST | `/api/quit` | `{}` → `{ok: true}`, then the program stops (409 `busy` while a job runs) |
| POST | `/api/settings` | `{language: 'ja'\|'en'\|null}` → Settings |
| POST | `/api/site` | `{path}` → SiteInfo, saved in the settings and added to `recent` (400 `path-not-absolute`, `path-missing`, `path-not-folder`, `path-no-access`, `not-a-site`: no `sumika/sumika.js` and `sumika/build.json`; `project-site` in dev runs; 409 `busy`) |
| POST | `/api/fs/roots` | `{}` → `{drives: ['C:\\', …] \| ['/'], unavailable: [drives that gave no answer within 2 s], places: [{kind: 'home'\|'desktop'\|'downloads'\|'volumes'\|'program'\|'recent', path}]}` |
| POST | `/api/fs/list` | `{path}` (absolute; UNC too) → `{path (real), parent: string\|null, entries: [{name, kind: 'dir'\|'file'\|'link', size?, target?: 'dir'\|'file'\|null (a link's), ghost?: {name}, archive?: true, list?: true}]}`: folders and links to folders first, then the rest, each in `Intl.Collator(undefined, {numeric: true})` order; a link is never followed in a listing, listing one lists its target (`path` then is the real one) |
| POST | `/api/inspect` | `{sources: [{path, archive?}]}` → Job; result `{items}` (below) |
| POST | `/api/drop` | `{}` → `{drop}` |
| PUT | `/api/drop/<drop>/<n>` | the file's bytes; `X-Sumika-Path`: its '/'-separated path, the dropped root's name first, percent-encoded (each segment's `encodeURIComponent` joined with '/'; decoded whole) → `{ok: true}` (400 `drop-bad-path`, 404 `drop-missing`, 409 `drop-exists` / `drop-closed`, 500 `drop-write`: the drop is deleted) |
| POST | `/api/drop/<drop>/done` | `{roots: [{n, name, kind: 'dir'\|'file'}]}` → Job (an inspect of each root; 400 `drop-bad-root`) |
| POST | `/api/drop/<drop>/cancel` | `{}` → `{ok: true}` (its files deleted) |
| POST | `/api/ghosts` | `{}` → `{ghosts: [{id, name, engine, needs: string\|null, balloons: [{id, name}], indexed: bool, folder: bool}], problems: [Finding]}`: Change ghost ▸'s order (src/core/shells.js `compareEntries`: by descript name, ties by folder), indexed rows and folders the index lacks (`indexed: false`, named by their descript) alike, whatever order ghosts.json has; the page shows them as they come; `problems`: `no-index`, `bad-index` {error} (ghosts.json unreadable, or with no `ghosts` list) |
| POST | `/api/add` | `{plan: [{token, replace?, keep?: [path], leaveOut?: [path]}]}` → Job; result below (400 `token-unknown`) |
| POST | `/api/remove` | `{id}` → Job; result `{id, path, link, deleteOnHost: 'ghost/<id>/', index}` |
| POST | `/api/index` | `{}` → Job; result the core's `indexSite` answer |
| POST | `/api/check` | `{}` → Job; result `{ok, problems: [Finding]}` |
| POST | `/api/prepare` | `{first?: true, retireAll?: true, newRecord?: true}` (at most one; else 400 `bad-request`) → Job; 409 `needs-first` (no ledger, no flag) or `ledger-exists` (a ledger and `first` or `retireAll`). `newRecord`: Start a new record, the one button of `ledger-unreadable` (results, below) |
| POST | `/api/hub` | `{}` → `{exists, origins: [the file's entries as they are], problems: [Finding], runtimeHasHub}` |
| POST | `/api/hub/save` | `{origins: [string]}` → `{ok, problems: [Finding]}`; ok: written as `{"format": 1, "origins": […]}` (1-space indent), or the file deleted for an empty list |
| POST | `/api/preview/start` | `{lang: 'ja'\|'en'}` → Preview (new ports at each start; a running preview is stopped first; 500 `preview-failed` {error}) |
| POST | `/api/preview/stop` | `{}` → `{ok: true}` |
| POST | `/api/pick` | `{purpose: 'files'\|'folders'\|'site'\|'compare', lang: 'ja'\|'en', near?: string}` → `{paths: [string]}` \| `{canceled: true}` \| `{open: true, id}` (File dialogs, below; 400 `bad-request` for another purpose, 409 `picker-open` {purpose, id}, 501 `no-picker` {error?} or {exit}) |
| POST | `/api/pick/wait` | `{id}` → the same answers for the dialog `id`, its answer to every wait until the next pick (`{canceled: true}` for one this start no longer knows) |
| POST | `/api/pick/cancel` | `{}` → `{ok: true, open: bool}` (an open dialog closed, whichever tab opened it) |

Every route but hello, status, quit, settings, site, fs/*, inspect, pick and pick/*, preview/stop and the drop routes
needs a chosen site (409 `no-site`); every route that starts a job (inspect, drop done, add, remove, index, check,
prepare), and site and quit, answer 409 `busy` while a job runs.

**File dialogs** (admin/server/picker.mjs, pickwin.mjs): the program opens the system's own dialog (it needs full paths, which a page's `<input type=file>` never
gives); one at a time for the whole program. Purposes: `files` (several `.nar` / `.zip`: sources), `folders` (several
folders: ghost folders and folders of ghosts), `site` (one folder), `compare` (one `.nar`, `.zip`, `updates2.dau` or
`updates.txt`). The title and the file kinds' names are in `lang` (`pick.title.*`, `pick.filter.*`). It opens in: for
`site`, the folder holding the current site; else the folder this purpose last picked in (Settings' `lastFolders`); else
`near` (absolute; the page's guess: a compared ghost folder's parent); else the dialog's own memory. Picked paths
(absolute only) answer `{paths}` and set `lastFolders[purpose]` to the first one's folder; Cancel, or nothing picked,
answers `{canceled: true}`. An answer is held at most 25 s (`PICK_WAIT_MS`: a browser gives up on a pending answer
after some minutes); a dialog still open answers `{open: true, id}`, and the page asks `/api/pick/wait {id}` again
until it closes; an answer is kept until the next pick, for every wait on its id. 409 `picker-open` {purpose, id}:
another dialog is open (another tab, or this page before a reload): the page waits on `id` with `/api/pick/wait` to
learn when it closes (the answer stays the opener's), and `/api/pick/cancel` closes it; hello's and status's `pick`
name it too, so a reloaded page waits on it before any button is pressed. The open mark always goes with the dialog
(a fault after it answers 500 `internal`; a failure to remember `lastFolders` is logged and the paths still answer).
501 `no-picker` {error?} or {exit} (the code the Windows dialog's worker ended with; the log has the technical
line): this program has no dialog (a Node run without `--fake-picker`; macOS without `osascript`, Linux without
`zenity` or `kdialog`) or it could not be shown; the picker is then off for the rest of the run (hello's `picker`
false) and the page uses its file browser (fs/*). A cancel holds for the whole pick (Linux: one between zenity found
missing and kdialog keeps kdialog from opening). Quit closes an open dialog and does not wait for it. Where:
Windows (Deno) IFileOpenDialog through FFI in a worker of its own, made with `env: {}` (pickwin.mjs: a hidden topmost
owner centred on the browser's window, so the dialog is in front of the browser and gets the keyboard; a client GUID
per purpose); macOS (Deno) `osascript` (choose file / choose folder; error -128 is a cancel); Linux (Deno) `zenity`,
else `kdialog` (exit 1 is a cancel); a Node run (tests, dev): `--fake-picker FILE` (a JSON object: per purpose a list
of paths, `"canceled"`, `"open"` until cancelled, or `"no-picker"`; `"delayMs"`), refused by the compiled program.

The page also relies on these: hello's `siteError` and `interrupted` as Interrupted; Settings' `where` 'given';
SiteInfo's `readOnlyInfo`, `runtime.control` and `front`; Job's `label`, `startedAt`, `endedAt`;
fs/roots' `unavailable`; a link entry's `target`; /api/ghosts rows' `folder`; inspect items' `token` and `dropped`;
the add, remove, check and prepare results below; an entry finding's `params.reason` in hub's and Check's problems;
prepare's 409 `ledger-exists`, its `newRecord`, `ledger-unreadable` and `ledger-reads`; the file dialogs (hello's `picker` and `pick`, status's `pick`, `/api/pick`,
`/api/pick/wait`, `/api/pick/cancel`, the settings file's `lastFolders`); hello's and status's `starting`; the
program's codes (`admin/server/codes.mjs` CODE_LIST) and text keys (`admin/server/say.mjs` STRING_KEYS), both read by
the page's strings test, so kept stable.

Results:
- **inspect** `{items}`: one per ghost found, the core's `inspectSource` items (`source`, `id`, `name`, `engine`,
  `runs`, `sizeBytes`, `fileCount`, `excluded`, `refusal`, `notes`, `terms`, `balloons`, `conflict`, `archive`,
  `updateList`, …) each with `token` (null when the item can never be added); a source that is missing or holds no
  ghost gives one item with its `refusal` and `token: null`; a dropped one has `dropped: {name}` (the dropped root's
  name). A token stands for its item in `/api/add` for the rest of the run (an add extracts an archive again); a
  drop's tokens end when the drop is cancelled or an add used it.
- **add** `{items: [{token, id, name, ok: true, copied, balloon, notes, excluded} | {token, id, name, ok: false,
  refusal: Finding}], index: <indexSite answer>|null, indexRefusal: Finding|null}`: the plan's ghosts in order, each
  added or refused (a refusal leaves nothing of that ghost), then one index run when any was added. Per entry:
  `replace` deletes the site's folder of that id first (without it an existing id is refused, `site.exists`); `keep`
  publishes archive-comparison files as they are (`--keep`); `leaveOut` leaves files out of the copy (`--skip`).
- **remove**: `deleteOnHost`: after the next upload, a host that takes files one by one still has that folder.
- **check** problems, in this order: the core's `kawari.record` {problem} (the site's Kawari record does not read:
  one problem, and then no `site.personal` nor `index-stale`, which no index run could pass), `site.personal` (its
  `files`), `index-stale` (`files`: what an index run would
  write; the fix is the index job), the runtime set as tools/prune.mjs reads it (`runtime-missing` {file},
  `bundle-stale` {file?}, `hub-html`, `control-html` (`sumika/index.html`, the control page, does not name build.json's
  `control`), `bad-json` {file}, `no-index` and `index-old` (ghosts.json names no manifests:
  prune's refusal `no-manifests`, whose line names the Python indexer; the fix is the index job) unless `index-stale`
  says it, `runtime-problem` {detail: prune's English} for a line no rule knows), `no-404`, the
  hub.json gate (`hub.unreadable`, `hub.unusable`, `hub.loopback`, `hub.ignored`; an entry's finding also has
  `params.reason`, its entry code below), then `site.link` {path} for each link or junction anywhere in the site
  (`dev/` and the work folder aside), then the core's `work.leftover` {path: `.sumika-admin-work/<name>`} for what a
  cut-off add or removal left (the fix is the index job: every write job settles the work folder first).
- **The write jobs** (add, remove, index, prepare) first settle the site's work folder (core `recoverWork`), and the
  start of the program settles that of the journal's site and of the chosen site (after it serves: The start, above).
  The remove job's `label` is the
  ghost's name (its descript.txt `name`, else the id); an add's the ghosts' names.
- **prepare** (the prune before an upload, and the list to upload): Check first (any problem: the job fails with
  `check-failed` and its `problems`), then tools/prune.mjs on the site (a ledger that exists and does not read,
  prune's `bad-ledger`: `ledger-unreadable` {ledger, days: prune's RETAIN_DAYS}, nothing changed; its other
  refusals: `prune-refused`, `params.message` in English), answering `{first, retireAll, newRecord, setAside,
  deleted, retired, kept, ledger, files: [{path, size, optional?: 'map'|'plain-engine'}], count, bytes, last:
  ['sumika/index.html', 'sumika/hub.html', 'sumika/sumika.js', 'sumika/index/ghosts.json'] (upload.mjs LAST),
  deleteOnHost}`. `files` is the upload in its
  order: everything else, then those of `last` that exist, in that order; never `dev/`, `.sumika-admin-work/`, the
  temporary files of the Kawari record and hub.json (`sumika/kawari-shipped.json.tmp-<8 hex>`, `sumika/hub.json.tmp-<8 hex>`), `Thumbs.db`, `desktop.ini`, `.DS_Store`;
  `deleteOnHost` = prune's `deleted`. The ledger `<site>.published.json` sits beside the site folder, never in
  `files`. `newRecord` [decision]: after Check, a ledger that does not read is renamed aside,
  `<ledger>.broken-<YYYY-MM-DD>`, else `-2`, `-3` … (never over a file; `setAside`: that path, else null), then prune
  runs as `retireAll` (nothing deleted now, every non-current versioned file kept RETAIN_DAYS more days; `retireAll`
  true in the answer); one that reads by then (repaired, or another tab's Start a new record came first) fails
  `ledger-reads` {ledger} and is left as it is; none at all is `retireAll` as it is; prune refusing after the rename
  puts the file back.

hub.json entries: `admin/server/hubentry.mjs` `entryProblem(entry)` → null or one of `not-string`, `wildcard`,
`not-absolute`, `not-http`, `userinfo`, `query-or-fragment`, `has-path`, `loopback`. Pure, no `node:` import: the
page may import it to mark a row as the admin types. An entry has one exactly when the publish gate (`hubFindings`)
reports it (`tests/admin/server.test.mjs` compares the two on a table), and for an object or list entry, which no hub
keeps but the gate does not report (it pairs its two parses' ignored entries by identity); save writes nothing while
any entry has one.

The program's own text (`admin/server/say.mjs` `STRING_KEYS`, for the strings test; looked up with
admin/page/strings.js `t(key, lang, params)` (its PARAMS fill `{app}`), the program's own English and Japanese when
the table lacks a key): the console lines, each printed in English then Japanese, `console.version` {version},
`console.open` {url}, `console.stop`, `console.already`, `console.failed` {error}, `console.enter`, `console.stopped`,
`console.idle` {minutes}; the preview page, in the start's `lang`, `preview.page.title` {origin},
`preview.page.intro` {origin, site}, `preview.page.link` {other}; the file dialogs, in the pick's `lang`,
`pick.title.files` {exts}, `pick.title.folders`, `pick.title.site` {sumikaDir}, `pick.title.compare`,
`pick.filter.archives` {patterns}, `pick.filter.compare` {patterns}.

The page build (`admin/build.mjs --page`; dev starts run it in-process, in memory): esbuild bundles
`admin/page/main.js` (IIFE, ES2020) and `admin/page/style.css`; `admin/page/index.html` holds
`<style>/*@@SUMIKA_ADMIN_STYLE@@*/</style>` and `<script>/*@@SUMIKA_ADMIN_SCRIPT@@*/</script>` (also understood:
`<!--sumika-admin:style-->` / `…:script-->`, or the tags loading `style.css` and `main.js`), each tag replaced whole by
the inline `<style>` / `<script>` whose SHA-256 goes into the CSP (the text LF-only, as the HTML parser hashes it);
`admin/build/page.gen.mjs` exports `PAGE` and `CSP`. The page sets styles through CSSOM only (the CSP refuses
`style=""`) and loads nothing from elsewhere.

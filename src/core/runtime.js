// Runtime: one ghost of the page, in a slot of its Site (site.js), which holds what exists once per page and what spans
// ghosts (the set, the lead lock, layers, the events between ghosts, EV §2.7). Picks the ghost, starts the engine
// worker and the stage in parallel, wires the script player, balloons, dialogs, menu and launcher to the event loop,
// then boots or resumes (SUMMARY §2.5). It also owns the ghost's lifecycle: one engine per ghost across tabs, crash
// restarts, close/minimize launcher, and ghost changes (EV §2.5): the old ghost says goodbye and unloads, the new one
// boots with OnGhostChanged in the same slot. With several ghosts its views go into its own layer (UI §3.5).
// Shell and balloon changes (EV §2.6, BA §12) keep the engine running: the stage is swapped under the event loop, the
// balloons are re-skinned in place. All three share one change slot (_changing); a script's change asked while it is
// held waits for it (_chainChange).
// Nothing here may break the host page: every failure is logged and the ghost simply does not appear.
import { log } from './log.js';
import { Emitter } from './emitter.js';
import { parseDescript, siteUrls } from './loader.js';
import { ShioriClient } from './shiori.js';
import { StateStore, GhostLock } from './state.js';
import { platform, storePort } from './platform.js';
import { EventLoop, VERSION } from './events.js';
import { PageSaori } from './page-saori.js';
import { DropStore } from './drops.js';
import { UserScaling, cssScales, normScaling } from './scaling.js';
import { Site, chooseGhost, SITE_CHANNEL } from './site.js';
import {
  sameName, sortShells, visibleShells, shellName, defaultShellId, resolveShellTarget, installedBalloons, findBalloon,
  ghostBalloonKeys, balloonMenu, resolveBalloonTarget, bootBalloonKeys, bootBalloon,
} from './shells.js';
import { Stage } from '../shell/stage.js';
import { BalloonSkin } from '../balloon/skin.js';
import { Balloons } from '../balloon/manager.js';
import { Dialogs } from '../balloon/dialogs.js';
import { ScriptPlayer } from '../sakura/player.js';
import { Menu } from '../ui/menu.js';
import { Launcher } from '../ui/launcher.js';
import { launcherIconPath } from './trayicon.js';
import { getRoot } from '../ui/root.js';
import { engineSupported, engineNote } from '../worker/engines/supported.js';
import { rootEngine, rootFilePlan, yayaModule, siteView } from './engine-files.js';
import { workerPath, enginePaths } from './build.js';

// chooseGhost and the site channel's name live in site.js; re-exported here for the modules that import them from here
export { chooseGhost, SITE_CHANNEL };
// window.sumika.version, About Sumika (UI §2.11); kept in events.js, which also tells the ghosts (baseware.version)
export { VERSION };
export const STORE_NAMESPACE = 'sumika';
const GHOST_DIR = 'ghost/master/';
const ENGINE_TEXT = /\.(txt|dic|sat|ini|csv|aym)$/i;
// network-update lists and save files (the worker restores saves itself) never go into the engine's file system
const ENGINE_SKIP = /(^|\/)(updates\d*\.txt|satori_save[^/]*|satori_savebackup[^/]*)$/i;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_CRASHES = 3;
// script changes queued behind the change slot in a row (_chainChange): a reply that always asks for another change
// stops here [decision; 333-4.05 needs one]
export const MAX_CHAINED_CHANGES = 4;
export const HELD_DROP_MS = 30000;   // a file drop held while the ghost boots or takes over is stale after this [guess]

/** Ghost-relative text files the engine reads (SUMMARY §2.8): ghost/master/**, minus images, DLLs and saves. */
export function engineFileList(files, dir = GHOST_DIR) {
  const pre = dir.toLowerCase();
  return files.list(dir)
    .filter(p => p.toLowerCase().startsWith(pre))
    .map(p => p.slice(pre.length))
    .filter(p => ENGINE_TEXT.test(p) && !ENGINE_SKIP.test(p));
}

/**
 * The ghost a change asks for (EV §2.5; [U-ss] \![change,ghost,…], \+, \_+): byId = a folder id (menu, page API);
 * 'random' = any other ghost; 'sequential' = the next one in the site's list, wrapping; otherwise the descript name,
 * then the sakura name, then the folder id [infer]. Ghosts the runtime cannot run are never picked at random or in
 * sequence; one named outright is returned, and the change refuses it. null = nothing to change to (SSP ignores it).
 * `exclude`: ghosts on screen in another slot (EV §2.7.2) — random and sequential skip them, one named (or byId) is
 * null [disasm GetGhostIDFromTag].
 */
export function resolveGhostTarget(ghosts, currentId, target, { byId = false, supported = engineSupported, random = Math.random, exclude = new Set() } = {}) {
  const list = ghosts || [];
  const out = exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []);
  const keep = g => (g && !out.has(g.id) ? g : null);
  const t = String(target ?? '').trim();
  if (byId) return keep(list.find(g => g.id === t));
  const key = t.toLowerCase();
  if (key === 'random') {
    const c = list.filter(g => g.id !== currentId && !out.has(g.id) && supported(g));
    return c.length ? c[Math.min(c.length - 1, Math.floor(random() * c.length))] : null;
  }
  if (key === 'sequential') {
    const i = list.findIndex(g => g.id === currentId);
    for (let n = 1; n <= list.length; n++) {
      const g = list[(i + n + list.length) % list.length];
      if (g.id !== currentId && !out.has(g.id) && supported(g)) return g;
    }
    return null;
  }
  if (!t || key === 'lastinstalled') return null;     // nothing is ever installed in a browser
  return keep(list.find(g => g.name === t) || list.find(g => g.sakuraName === t) || list.find(g => g.id === t)
    || list.find(g => String(g.name || '').toLowerCase() === key || String(g.id).toLowerCase() === key) || null);
}

/**
 * The balloon a ghost boots with (BA §1.6) [disasm GetBalloonIDFromSetting]: the first installed balloon (shells.js
 * installedBalloons: the site's, the bundled ones the indexer hoisted, the ghost's own) named by (1) the shell's
 * remembered balloon, (2) the ghost's stored choice (a folder id; older states a descript name), (3) the ghost
 * descript's balloon keys, (4) install.txt `balloon.directory` (the index's `balloon`); else (5) the site default (the
 * page's data-default-balloon when installed, else ghosts.json `defaultBalloon`), which is no choice of the ghost's
 * (isDefault); null: the built-in balloon (6).
 * @returns {{entry: {id:string, name:string, ghost?:string}, from: string, isDefault?: boolean}|null}
 */
export function chooseBalloon(index, ghost, { shellBalloon = null, choice = null, ghostDescript = null, pageDefault = null } = {}) {
  const list = installedBalloons(index, ghost);
  const hit = bootBalloon(list, bootBalloonKeys({ shellBalloon, choice, ghostDescript, ghost }));
  if (hit) return hit;
  const def = findBalloon(list, pageDefault) || findBalloon(list, index && index.defaultBalloon);
  return def ? { entry: def, from: 'default', isDefault: true } : null;
}

/** The per-shell memory key for a shell id (any case: the folder may be spelt differently), else the id itself. */
function memoryKey(shells, id) {
  if (!shells || typeof shells !== 'object' || id === null || id === undefined) return id;
  return Object.prototype.hasOwnProperty.call(shells, id) ? id : Object.keys(shells).find(k => sameName(k, id)) ?? id;
}

/** A shell's entry in the per-shell memory (state.shells, EV §2.6), or null. */
export function shellMemory(shells, id) {
  const k = memoryKey(shells, id);
  const e = shells && typeof shells === 'object' && k !== undefined && k !== null ? shells[k] : null;
  return e && typeof e === 'object' ? e : null;
}

/**
 * The shell a ghost boots (EV §2.6) [disasm GetShellIDFromSetting, GetDefaultShellID]: the stored `shell` when the
 * visitor picked it (`shellChosen`, SSP's shell.ischanged.2) and the index still lists it, else the default shell.
 * @param {object} ghost  ghosts.json entry
 * @param {Map<string,string>} ghostDescript
 * @param {{shell?: string|null, shellChosen?: boolean}} data  the ghost's state
 */
export function bootShellId(ghost, ghostDescript, data) {
  const d = data || {};
  if (d.shellChosen && d.shell) {
    const s = ((ghost && ghost.shells) || []).find(x => x && sameName(x.id, d.shell));
    if (s) return s.id;
  }
  return defaultShellId(ghost, ghostDescript);
}

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * The per-shell memory with `stageState`'s dress-up recorded as `shellId`'s (EV §2.6 "The swap" #4): every scope's ON
 * bind-group ids. A copy; unchanged when the state holds no bind lists.
 */
export function withShellBinds(shells, shellId, stageState) {
  const out = { ...(isObj(shells) ? shells : {}) };
  if (!shellId || !stageState || !isObj(stageState.scopes)) return out;
  const binds = {};
  for (const [k, st] of Object.entries(stageState.scopes)) if (/^\d+$/.test(k) && st && Array.isArray(st.binds)) binds[k] = st.binds.slice();
  if (!Object.keys(binds).length) return out;
  const key = memoryKey(out, shellId);
  out[key] = { ...(isObj(out[key]) ? out[key] : {}), binds };
  return out;
}

/**
 * The stored stage state for `shellId` (EV §2.6, SH §4.3.3): bind-group ids are local to a shell, so a state saved
 * for another shell keeps its places and surfaces but loses its dress-up and the sizes its hidden scopes were last
 * shown with (`last`), and the shell's own dress-up from the per-shell memory goes in (else Stage uses its defaults).
 * A state of the same shell (or one without `shell`) is returned as is.
 * @param {object|undefined} saved  Stage.saveState() output (or coldStageState's)
 * @param {string} shellId
 * @param {object} shells  state.shells
 */
export function stageStateForShell(saved, shellId, shells) {
  if (isObj(saved) && (typeof saved.shell !== 'string' || sameName(saved.shell, shellId))) return saved;
  const mem = shellMemory(shells, shellId);
  const binds = mem && isObj(mem.binds) ? mem.binds : null;
  const scopes = {};
  if (isObj(saved) && isObj(saved.scopes)) {
    for (const [k, st] of Object.entries(saved.scopes)) {
      if (!isObj(st)) continue;
      const { binds: _drop, last: _size, ...rest } = st;
      scopes[k] = rest;
    }
  } else if (!binds) {
    return saved || undefined;
  }
  for (const [k, list] of Object.entries(binds || {})) scopes[k] = { ...(scopes[k] || {}), binds: list.slice() };
  return { ...(isObj(saved) ? saved : { v: 1 }), shell: shellId, scopes };
}

/**
 * The new stage's state in a shell swap (EV §2.6 "The swap" #5): scopes 0, 1 and every scope that showed a surface
 * keep their place (and alpha [guess]) but start without a surface, hidden until OnShellChanged (or its absence) sets
 * one; a hidden \0 / \1 stays hidden (a script's change while minimized). Every other \p[n] keeps only its place, for
 * when a script shows it (UI §3.3; SSP's ghost.dat holds every scope's). Alignment overrides and \![set,scaling] are
 * dropped [disasm SetAlignAll; guess for scaling]. The dress-up is the new shell's from the per-shell memory, else its
 * bindgroup defaults.
 * @param {object|null} old  the old Stage.saveState()
 * @param {string} shellId
 * @param {object} shells  state.shells
 * @param {Map<number, number>} [shown]  EventLoop.detachStage(): scope -> surface id
 */
export function swapStageState(old, shellId, shells, shown = new Map()) {
  const prev = old && isObj(old.scopes) ? old.scopes : {};
  const keep = new Set([0, 1, ...(shown instanceof Map ? [...shown.keys()] : [])].map(Number).filter(Number.isInteger));
  const scopes = {};
  for (const s of [...keep].sort((a, b) => a - b)) {
    const st = isObj(prev[s]) ? prev[s] : {};
    const o = { surface: -1 };
    if (st.pos) o.pos = st.pos;
    if (Number.isFinite(st.alpha)) o.alpha = st.alpha;
    if (s <= 1 && st.visible === false) o.visible = false;
    scopes[s] = o;
  }
  for (const [k, st] of Object.entries(prev)) {
    const s = Number(k);
    if (Number.isInteger(s) && s >= 2 && !keep.has(s) && isObj(st) && st.pos) scopes[s] = { pos: st.pos };
  }
  const mem = shellMemory(shells, shellId);
  for (const [k, list] of Object.entries((mem && isObj(mem.binds) && mem.binds) || {})) scopes[k] = { ...(scopes[k] || {}), binds: list.slice() };
  return { v: 1, shell: shellId, scopes };
}

/**
 * Stage state for a cold boot (EV §2.1 #24: the characters appear with their default surfaces). Positions, dress-up,
 * alignment, scaling and alpha of scopes 0 and 1 survive; extra scopes keep only their dress-up and their place
 * (SSP keeps every scope's, `Char<n>.ratio` [disasm ResetAllPositions]; UI §3.3), so no \p[n] window comes back before
 * a script shows it, and then it stands where it stood. Surfaces and visibility are dropped: Close and Iconify saved
 * them hidden.
 * @param {object|null|undefined} saved Stage.saveState() output
 */
export function coldStageState(saved) {
  if (!saved || typeof saved !== 'object' || !saved.scopes || typeof saved.scopes !== 'object') return undefined;
  const scopes = {};
  for (const [k, st] of Object.entries(saved.scopes)) {
    const s = parseInt(k, 10);
    if (!Number.isFinite(s) || !st || typeof st !== 'object') continue;
    const binds = Array.isArray(st.binds) ? st.binds : undefined;
    if (s === 0 || s === 1) {
      const o = { visible: true };
      if (st.pos) o.pos = st.pos;
      if (binds) o.binds = binds;
      if (st.align) o.align = st.align;
      if (Array.isArray(st.scaling)) o.scaling = st.scaling;
      if (Number.isFinite(st.alpha) && st.alpha > 0) o.alpha = st.alpha;    // never boot fully transparent
      scopes[k] = o;
    } else {
      const o = {};
      if (binds && binds.length) o.binds = binds;
      if (st.pos) o.pos = st.pos;
      if (o.binds || o.pos) scopes[k] = o;
    }
  }
  return { ...saved, scopes };
}

/**
 * A shell swap whose surfaces OnShellChanged had not decided yet (state.shellSwap, EV §2.6): the page went between the
 * new stage's attach and the reply's start (or its 204 restore), so the stored stage has no surfaces. Each scope that
 * showed a surface before the swap and has none now shows that id again (PopSurfaceStatus, as on a 204); \0 / \1 whose
 * id the new shell lacks show their default surface instead, so a resumed or frozen ghost never comes back invisible
 * [decision]. A scope hidden before the swap stays hidden, and a \s[-1] of the reply is never touched (the marker goes
 * once the reply starts).
 * @param {object} stage
 * @param {{surfaces?: Object<string, number>}} swap
 */
export function settleSwapSurfaces(stage, swap) {
  if (!stage || !isObj(swap)) return;
  let saved = {};
  try { saved = stage.saveState().scopes || {}; } catch (e) { saved = {}; }
  const unset = s => !(isObj(saved[s]) && saved[s].surface >= 0);       // as stored: an unshown \p[n] window has none
  const remembered = Object.entries(isObj(swap.surfaces) ? swap.surfaces : {})
    .map(([s, id]) => [Number(s), Number(id)]).filter(([s, id]) => Number.isInteger(s) && s >= 0 && Number.isInteger(id) && id >= 0)
    .sort((a, b) => a[0] - b[0]);
  for (const [s, id] of remembered) {
    if (!unset(s)) continue;
    quiet('swap surface', () => {
      const c = stage.char(s);
      c.setSurface(id);
      if (s <= 1 && c.surfaceId < 0) c.setSurface(stage.defaultSurface(s));
    });
  }
}

/** After a cold boot's Stage.create: scopes 0 and 1 on their default surfaces, shown. */
export function showDefaultCharacters(stage) {
  for (const s of [0, 1]) {
    try {
      const c = stage.char(s);
      const id = stage.defaultSurface(s);
      if (c.surfaceId !== id) c.setSurface(id);
      c.show();
    } catch (e) {
      log.once(`cold-show:${s}`, `could not show scope ${s}`, e);
    }
  }
}

/** Path part of a URL, for OnNotifySelfInfo (EV §2.1 "Paths"). */
function urlPath(u) {
  try { return new URL(u).pathname; } catch (e) { return ''; }
}

/** A folder's site-absolute path, ending in '/' (EV §2.1 "Paths"; GhostFiles.url drops a trailing slash). */
function dirPath(files, dir) {
  let p = '';
  try { p = urlPath(files.url(dir)); } catch (e) { p = ''; }
  return p && !p.endsWith('/') ? `${p}/` : p;
}

/** Run f; a failure is logged once per `what` (a view that cannot follow a shell or balloon change keeps the old). */
const quiet = (what, f) => { try { f(); } catch (e) { log.once(`runtime:${what}`, `${what} failed`, e); } };
/** The error of a ghost whose canvas cannot draw (Runtime._canvasLost, _boot's lostCheck). */
function lostText(ghost, kind) {
  return `${(ghost && ghost.id) || 'the ghost'} cannot be drawn: the browser gave its ${kind} canvas no drawing memory (no 2D context or backing store; too many canvases?)`;
}

/** What a start awaits once Site.staleCheck answered true: the page reloads, and nothing of the start goes on. */
const never = () => new Promise(() => {});

let lastSid = 0;              // Runtime.sid: page-unique, never reused

export class Runtime extends Emitter {
  /**
   * @param {{site?:Site, base:string, defaultGhost?:string|null, defaultBalloon?:string|null, runtimeUrl:string,
   *   Channel?:Function|null, language?:object}} o site: the page's Site (site.js); without one the Runtime makes an
   *   implicit one-ghost Site from the other options (the single-ghost behaviour: tests, old callers). defaultBalloon:
   *   the page's choice of the site balloon for ghosts without one (else the index's); Channel: the BroadcastChannel
   *   constructor for the site channel (tests; null = tabs do not follow ghost changes); language: the UI language
   *   (core/language.js UiLanguage; default the page's shared one) for the menu, the launcher, the boxes and
   *   OnLanguageChange; runtimeFiles: the table of hashed runtime files (Site; core/build.js FILES by default).
   *   Channel, language and runtimeFiles go to the implicit Site; a given Site has its own
   */
  constructor({ site = null, base, defaultGhost = null, defaultBalloon = null, runtimeUrl, Channel, language, runtimeFiles }) {
    super();
    this.base = base;
    this.defaultGhost = defaultGhost;
    this.defaultBalloon = defaultBalloon;
    this.runtimeUrl = runtimeUrl;
    this.site = site || new Site({ base, defaultGhost, defaultBalloon, runtimeUrl, Channel, language, runtimeFiles, lead: false, maxGhosts: 1 });
    this.sid = ++lastSid;
    this.layer = null;        // this ghost's layer element (ui/layers.js, several ghosts; none: the shared root)
    this._up = false;         // counts as up for the other ghosts' otherghostname (Site, EV §2.7)
    this._launcherMode = null; // the launcher shown: 'minimized' | 'closed' | 'tucked' | null (the Site's dock)
    this._changing = null;    // the change slot: a ghost, shell or balloon change under way (EV §2.5, §2.6)
    this._chained = 0;        // script changes queued behind the slot in a row (_chainChange)
    this._chainWaiting = 0;   // of those, the ones still waiting for it
    this._chainShells = 0;    // of those, the shell changes
    // the slot's change waits for a talk to end (OnShellChanging's, or a ghost change's farewell): nothing queues behind it
    this._waitingTalk = false;
    this._chainMark = null;   // {p, mark}: a swap's shellSwap kept for the change its reply queued (_settleSwap)
    this._pending = null;     // {to, from, script}: that change from its commit until B's boot owns it (_onPageHide)
    this._committed = false;  // a ghost change past A's farewell (B's lock taken, A unloading, B booting): Site.restart waits
    this._takeoverAsked = false;  // another tab asked for the ghost during the change: answered after it
    this._takingOver = null;  // the lock a frozen tab is waiting on
    this._yieldWhenHidden = false;
    this.ghost = null;
    this.state = null;
    this.lock = null;
    this.parts = null;        // everything of the running ghost (torn down together)
    this.frozen = null;       // a stage shown without an engine (another tab holds the ghost)
    this._frozenGen = 0;      // +1 at each _clearFrozen: a frozen start or redraw begun before it drops what it builds
    this._removed = false;    // the Site removed this slot (Site._removeSlot): a start still under way stops
    this._viewMissed = false; // a shell change of the tab running the ghost came before this tab's frozen stage
    this.launcher = null;
    this.crashes = [];
    this.tookOver = false;
    this._starting = null;
    this._heldDrop = null;    // {info, at}: files dropped before the event loop could take them
    this.site._adopt(this);
  }

  // the page's own, kept on the Site (one per page); a setter where tests and old callers assign them
  get index() { return this.site.index; }
  set index(v) { this.site.index = v; }
  get language() { return this.site.language; }
  set language(v) { this.site.language = v; }
  get tabId() { return this.site.tabId; }
  get input() { return this.site.input; }
  get _channel() { return this.site._channel; }

  /**
   * Start (or call back) the ghost. Resolves when booted, frozen or waiting behind the launcher; never rejects.
   * @returns {Promise<'booted'|'frozen'|'launcher'|'failed'|'aborted'|'none'>}
   */
  start(opts = {}) {
    if (this._starting) return this._starting;
    this._starting = this._start(opts)
      .catch(e => {
        log.error('failed to start', e);
        this._teardown();
        // nothing runs here now: let another tab have the ghost (a no-op when this tab never held it)
        if (this.lock) this.lock.release();
        return 'failed';
      })
      .finally(() => { this._starting = null; });
    return this._starting;
  }

  /** Tear everything down and start again (bfcache restore, debugging). */
  async restart(opts = {}) {
    if (this._starting) await this._starting;
    this._teardown();
    this._clearFrozen();
    return this.start(opts);
  }

  /**
   * @param {{cold?: boolean, change?: object|null, call?: object|null, ghost?: string, frozenOnly?: boolean}} o
   *   ghost: this id (a ghost change, a call, the Site's set), not the choice; call: OnGhostCalled's caller
   *   ({sakuraName, name, path, script}, EV §2.7); frozenOnly: straight to the frozen stage, no lock (a tab without
   *   the set's lead); silent: a cold boot without a boot event (\![reload,ghost], EV §2.10; EventLoop.boot)
   */
  async _start({ cold = false, change = null, call = null, ghost: only = null, frozenOnly = false, silent = false } = {}) {
    const site = this.site;
    site._installPageHooks();
    // the stored Language ▸ choice again (UI §2.10): a page back from the bfcache missed other pages' picks (no
    // 'storage' event reaches it there), and the boot's OnLanguageChange must tell the ghost the language in effect
    if (this.language && typeof this.language.refresh === 'function') this.language.refresh();
    if (!site.index) await site._loadIndex();
    if (this._removed) return 'aborted';      // its slot went meanwhile (Site._removeSlot): nothing of it is built
    site._siteChannel();
    const ghost = (only && this.index.ghost(only)) || site._chooseFor(this);
    if (!ghost) { log.warn('this site has no ghosts (sumika/index/ghosts.json is empty)'); return 'none'; }
    // the last page left during a ghost change or a call (_onPageHide, Site._carry): carry it on, B cold-boots with
    // OnGhostChanged / the callee with OnGhostCalled (EV §2.5, §2.7)
    const carry = this.tookOver ? null : site._carried(ghost.id);
    const carried = !!carry && carry.kind === 'change';
    if (carried) { cold = true; change = change || carry.change || null; }
    if (carry && carry.kind === 'call') { cold = true; call = call || carry.call || null; }
    if (this.ghost && this.ghost.id !== ghost.id && this.lock) { this.lock.dispose(); this.lock = null; }
    this.ghost = ghost;
    site._labelSlot(this);
    if (this.state) this.state.dispose();
    this.state = StateStore.open(ghost.id);
    // a state a newer Sumika wrote (schema.js): the published build may be newer than this page (staleCheck 'state'),
    // checked before anything is shown; a true answer reloads the page and this start never goes on
    if (this.state.newer && await site.staleCheck('state')) return never();
    this._viewMissed = false;       // a {t:'view'} from here on, before a frozen stage exists, is redrawn after (_startFrozen)
    // a frozen stage shown so far goes once the ghost runs here or shows its launcher (a set started again, UI §9.5)
    if (this.state.data.closed && !cold) { this._clearFrozen(); this._showLauncher('closed'); return 'launcher'; }
    if (frozenOnly || site._frozenOnly(this)) {
      log.info(`${ghost.id} runs in another tab with the other ghosts; showing it here frozen`);
      await this._startFrozen();
      return 'frozen';
    }
    if (!this.lock) {
      this.lock = this._newLock(ghost.id);
      this.lock.on('takeover-request', () => this._onTakeoverRequest());
    }
    if (!(await this.lock.acquire())) {
      log.info(`${ghost.id} is running in another tab; showing it here frozen`);
      await this._startFrozen();
      return 'frozen';
    }
    if (this._removed) { if (this.lock) this.lock.dispose(); this.lock = null; return 'aborted'; }
    this._clearFrozen();
    if (carried) site._announce(ghost.id);      // the other tabs had not heard of it: they follow now (UI §9.5)
    return this._boot({ cold, change, call, silent });
  }

  /** `root` for the views of a ghost with its own layer (several ghosts, UI §9.1); none: the shared root. */
  _rootOpt() { return this.layer ? { root: this.layer } : {}; }

  /** Phones (UI §9.11): {phone} for the boxes and the scaling (Dialogs, UserScaling); desktop: {}, no key at all. */
  _phoneOpt() { return this.site.phone ? { phone: this.site.phone } : {}; }

  /**
   * The size options of a Stage ('shell') or Balloons ('balloon'): desktop {scale} as ever; on phones `phone`, plus the
   * scale only for a stored Shell / Balloon scaling ▸ choice, so with none they stand at their own fit (fitScale; a
   * passed scale of 1 would beat it).
   * @param {'shell'|'balloon'} target
   * @param {object} scaling  the ghost's stored choice (state.data.scaling)
   * @param {number} scale    the CSS scale the desktop path passes
   */
  _scaleOpts(target, scaling, scale) {
    const phone = this.site.phone;
    if (!phone) return { scale };
    return normScaling(scaling)[target] !== null ? { phone, scale } : { phone };
  }

  /** The cross-tab lock of a ghost (a method so tests can stand in for it). */
  _newLock(id) { return new GhostLock(id); }

  /**
   * A folder's files through the site index (ghostFiles / balloonFiles). A manifest that is gone whose re-read found
   * an index newer than this runtime (loader.js 'index-newer') asks Site.staleCheck('index-newer'): a true
   * answer reloads the page and this never settles, so no start goes on to write the set or the marker.
   * @param {'ghost'|'balloon'} kind
   */
  async _indexFiles(kind, id) {
    try {
      return await (kind === 'balloon' ? this.index.balloonFiles(id) : this.index.ghostFiles(id));
    } catch (e) {
      if (e && e.code === 'index-newer' && await this.site.staleCheck('index-newer')) return never();
      throw e;
    }
  }

  async _ghostCommon() {
    const ghost = this.ghost;
    const files = await this._indexFiles('ghost', ghost.id);
    files.prefetch();             // one download holds the dictionaries, surfaces*.txt and balloon descripts
    const descriptText = await files.textOrNull(`${GHOST_DIR}descript.txt`).catch(() => null);
    const ghostDescript = descriptText ? parseDescript(descriptText) : new Map();
    return { files, ghostDescript, shellId: bootShellId(ghost, ghostDescript, this.state.data) };
  }

  /**
   * The ghost's balloon (chooseBalloon, BA §1.6). isDefault: the site's default balloon, which is not stored as the
   * ghost's choice (a ghost without a balloon follows the site default, as SSP's follow the user's default balloon).
   * `from` says which rule picked it ('shell', 'choice', 'descript', 'install', 'default').
   * @param {object} files GhostFiles of the ghost root
   * @param {{shellId?: string, ghostDescript?: Map<string,string>}} [o] shellId: the shell whose remembered balloon
   *   comes first
   * @returns {Promise<{skin: BalloonSkin, id: string|null, name: string, path: string, files: object|null,
   *   from?: string, isDefault?: boolean}>}
   */
  async _loadSkin(files, { shellId = null, ghostDescript = null, onCanvasLost = null } = {}) {
    const d = this.state.data;
    const mem = shellId ? shellMemory(d.shells, shellId) : null;
    try {
      const pick = chooseBalloon(this.index, this.ghost, { shellBalloon: mem && mem.balloon, choice: d.balloon, ghostDescript, pageDefault: this.defaultBalloon });
      if (pick) {
        const b = await this._loadBalloon(pick.entry, files, onCanvasLost ? { onCanvasLost } : {});
        return { ...b, from: pick.from, ...(pick.isDefault ? { isDefault: true } : {}) };
      }
    } catch (e) {
      log.warn('balloon failed to load; using the built-in one', e);
    }
    return { skin: BalloonSkin.fallback(), id: null, name: '', path: '', files: null };
  }

  /**
   * Load an installed balloon (BA §1.6): the running ghost's own through its files (its share of the ghost's pack),
   * any other (a site balloon, one the indexer hoisted from another ghost) through its own manifest.
   * @param {{id:string, name?:string, ghost?:string}} entry  installedBalloons() entry
   * @param {{onCanvasLost?: Function}} [o]  BalloonSkin.load's: an image's decode canvas got no 2D context (_canvasLost)
   * @returns {Promise<{skin: BalloonSkin, id: string, name: string, path: string, files: object}>}
   */
  async _loadBalloon(entry, files, o = {}) {
    const own = !!(entry.ghost && this.ghost && entry.ghost === this.ghost.id && files && typeof files.sub === 'function');
    const bf = own ? files.sub(entry.id) : await this._indexFiles('balloon', entry.id);
    const skin = await this._balloonSkin(bf, o);
    const path = own ? dirPath(files, `${entry.id}/`) : urlPath(bf.root || '');
    return { skin, id: entry.id, name: entry.name || (skin && skin.name) || entry.id, path: path && !path.endsWith('/') ? `${path}/` : path, files: bf };
  }

  /** BalloonSkin.load (a method so tests can stand in for the balloon images). */
  _balloonSkin(files, o = {}) { return BalloonSkin.load(files, o); }

  _client(hooks = {}) {
    // the build's hashed worker (core/build.js; unbundled: engines/worker.js)
    const workerUrl = new URL(workerPath(this.site.runtimeFiles), this.runtimeUrl).href;
    const state = this.state;
    return new ShioriClient(workerUrl, {
      onVolatile: v => { if (state && !state.readOnly) state.data.engine = v; },
      onSaori: m => { if (this.parts && this.parts.pageSaori) this.parts.pageSaori.handle(m); },
      onLog: (level, text) => (log[level] || log.info)(`engine: ${text}`),
      onCrash: () => this._onCrash(),
      ...hooks,
    });
  }

  async _engineFiles(files) {
    const list = engineFileList(files);
    // copies: the buffers are transferred to the worker, and GhostFiles keeps its own for a restart
    return Promise.all(list.map(async p => ({ path: p, data: (await files.bytes(GHOST_DIR + p)).slice(0) })));
  }

  /**
   * A root engine's files (YAYA, Kawari: yaya-wasm.md MEMFS, kawari-wasm.md §6): the whole ghost root,
   * ghost-root-relative, text with its bytes and the rest as placeholders (engine-files.js rootFilePlan by the
   * engine's patterns), plus the engineOpts the worker passes to the engine: {ghostId, placeholders, site}, and YAYA's
   * module (Kawari has none).
   * @param {string} engine a ROOT_ENGINES name
   */
  async _rootFiles(files, engine) {
    const ghost = this.ghost;
    const name = String(engine).toLowerCase();
    const plan = rootFilePlan(files, rootEngine(name));
    const placeholders = plan.placeholders.slice();
    // copies, as above: GhostFiles hands every caller the same buffer (the readme window, a crash restart)
    const got = await Promise.all(plan.bytes.map(async p => {
      try {
        return { path: p, data: (await files.bytes(p)).slice(0) };
      } catch (e) {
        log.warn(`engine: ${p} could not be read; the ghost sees it empty`, e);
        placeholders.push(p);
        return null;
      }
    }));
    const engineOpts = name === 'yaya' ? { module: yayaModule(ghost) } : {};
    Object.assign(engineOpts, { ghostId: ghost.id, placeholders, site: siteView(this.index) });
    return { files: got.filter(Boolean), engineOpts };
  }

  /**
   * The engine of a boot or a crash restart (\![reload,shiori]'s failure restarts through it too). A start that fails
   * asks Site.staleCheck('engine') first (a page whose own worker or engine files are gone): when it answers true
   * the page reloads and this never settles, so no caller goes on to write the set, the marker or a fallback ghost.
   * @param {{resume: boolean, bootEpochMs: number, sessionEndMs?: number}} o bootEpochMs: the ghost's last cold boot
   *   (P7, SUMMARY §2.1); sessionEndMs: on a cold boot, when its last session ended (the state's savedAt before this
   *   boot wrote it; 0 = unknown), for Kawari's D6 (kawari-wasm.md §8)
   */
  async _startEngine(files, { resume, bootEpochMs, sessionEndMs = 0 }) {
    const client = this._client();
    try {
      const o = await this._engineStartOptions(files, { resume, bootEpochMs, sessionEndMs });
      const r = await client.start(o);
      log.debug(`engine ${o.engine} loaded in ${r.ms} ms`);
      return { client, r };
    } catch (e) {
      try { client.terminate(); } catch (e2) { /* ignore */ }
      if (await this.site.staleCheck('engine')) return never();
      throw e;
    }
  }

  /**
   * ShioriClient.start's options for the running ghost (_startEngine; a SHIORI reload, _reloadShiori): its engine
   * files (fresh copies) and the store key. The engine's .js is the build's hashed copy and `wasmUrl` its hashed .wasm
   * (core/build.js); with no table (unbundled) the plain .js and no wasmUrl key. A method so tests can
   * stand in for it.
   * @param {{resume: boolean, bootEpochMs: number, sessionEndMs?: number}} o as _startEngine
   */
  async _engineStartOptions(files, { resume, bootEpochMs, sessionEndMs = 0 }) {
    const ghost = this.ghost;
    const engine = ghost.engine || 'satori';
    // a root engine (YAYA, Kawari) mounts the whole ghost root and takes engineOpts; Satori gets ghost/master's text
    // files
    const plan = rootEngine(engine) ? await this._rootFiles(files, engine)
      : { files: await this._engineFiles(files), engineOpts: null };
    const paths = enginePaths(engine, this.site.runtimeFiles);
    return {
      engine,
      engineUrl: new URL(paths.js, this.runtimeUrl).href,
      ...(paths.wasm ? { wasmUrl: new URL(paths.wasm, this.runtimeUrl).href } : {}),
      files: plan.files,
      resume,
      volatile: resume ? this.state.data.engine : null,
      bootEpochMs,
      sessionEndMs,
      storeNamespace: STORE_NAMESPACE,
      storeKey: `ghost:${ghost.id}:files`,
      engineOpts: plan.engineOpts,
      ...this._storePortOpt(),
    };
  }

  /**
   * With the storage hub (data-hub, core/hub.js): {storePort}, a fresh port to the hub's IndexedDB for this engine
   * start, which the worker's save files go through; without it nothing, and the worker opens IndexedDB.
   */
  _storePortOpt() {
    const port = storePort();
    return port ? { storePort: port } : {};
  }

  /**
   * \![reload,shiori] (EV §2.10), the loop's shioriReloader: the running client unloads its engine (the worker stores
   * the files first) and starts a new one from the store, inside its request queue (ShioriClient.reload), so the
   * NOTIFYs the loop queued behind it reach the new engine. A cold load, as ssp.exe's LoadShiori: no volatile state,
   * Kawari's snapshot is the unload's empty marker (D7); bootEpochMs stays the ghost's (Satori's since-load starts at
   * this load, as a cold load does). A load that fails restarts the engine from the store as a crash does
   * [decision]; an engine stopped meanwhile (a teardown: a takeover, a ghost change; a request's kill timer, whose
   * crash restart is under way) restarts nothing here.
   * @returns {Promise<boolean>}
   */
  async _reloadShiori(p) {
    if (this.parts !== p || !p.client || typeof p.client.reload !== 'function') return false;
    try {
      await p.client.reload(() => this._engineStartOptions(p.files, { resume: false, bootEpochMs: p.bootEpochMs }));
      return this.parts === p;
    } catch (e) {
      if (this.parts !== p || (e && e.stopped)) return false;
      log.error('the SHIORI reload failed; restarting the engine from its save data', e);
      this._onCrash();
      return false;
    }
  }

  /** Stage.create (a method so tests can stand in for the shell). */
  _createStage(opts) { return Stage.create(opts); }

  /** Balloons, dialogs and the script player (methods so tests can stand in for the DOM parts). */
  _createBalloons(opts) { return Balloons.create(opts); }
  _createDialogs(opts) { return new Dialogs({ ...opts, root: opts.root || getRoot() }); }
  _createPlayer(opts) { return new ScriptPlayer(opts); }

  /**
   * @param {{cold?: boolean, change?: object|null, call?: object|null, silent?: boolean}} o change: OnGhostChanged's
   *   previous ghost; call: OnGhostCalled's caller; silent: no boot event (EventLoop.boot)
   */
  async _boot({ cold = false, change = null, call = null, silent = false } = {}) {
    const ghost = this.ghost;
    const state = this.state;
    const site = this.site;
    state.readOnly = false;
    const resume = !cold && !state.isNew && !state.data.closed && (this.tookOver || site._inMarker(ghost.id));
    this.tookOver = false;
    const now = Date.now();
    // D6 (kawari-wasm.md §8): when her last session ended without an unload (a tab closed), Kawari closes it at the time
    // it ended: the state's last write (flushed at pagehide), read before this cold boot's own write below
    const sessionEndMs = !resume && !state.isNew ? state.data.savedAt : 0;
    // the tab marker names her and the choice is stored; a change or a call stays pending in the marker until
    // OnGhostChanged / OnGhostCalled is sent: a page left first carries it on (_start)
    site._onBooting(this, { change, call, now, resume });
    const epoch = site.sessionEpochMs;      // the tab's first page: OnSecondChange R0
    if (!resume) {
      const d = state.data;
      // no OnSurfaceRestore pending until the boot script ends (EV §3.4) [disasm SPGhost ctor 0x61cb1a]
      d.run = null; d.timers = []; d.boxes = []; d.engine = null; d.music = null; d.surfaceRestoreAt = 0;
      d.trayIcon = null;                    // a script's \![set,trayicon] lasts one boot (UI §2.6)
      // P7 (SUMMARY §2.1): her uptime clock starts with each cold boot (a new tab, a ghost change, a relaunch), as in SSP
      d.bootEpochMs = now;
      // stored at once: a page left while the engine loads must not resume the previous boot's run, timers, clock or
      // OnSurfaceRestore stamp. closed / minimized are stored as they were until she boots (EventLoop.boot clears them
      // too): such a page, or an engine that fails, brings back the launcher, not a resume of the stage Close or Iconify
      // saved hidden
      if (!state.isNew) state.saveNow();
      d.closed = false; d.minimized = null;
    } else if (!(state.data.bootEpochMs > 0)) {
      state.data.bootEpochMs = now;     // a state stored before P7: the clock starts here
    }
    // a resume (also a takeover from another tab) keeps the ghost's clock; the tab's epoch stays OnSecondChange's
    const bootEpochMs = state.data.bootEpochMs;

    const { files, ghostDescript, shellId } = await this._ghostCommon();
    if (this._removed) return 'aborted';      // its slot went meanwhile (Site._removeSlot)
    const parts = { files, ghostDescript, bootEpochMs };
    this.parts = parts;
    // a canvas of this boot that cannot draw (core/canvas.js): marked by _canvasLost while the boot
    // builds; lostCheck fails the start at the next step (start()'s catch: one error, teardown, the lock let go)
    const onCanvasLost = kind => this._canvasLost(kind, parts);
    const lostCheck = () => { if (parts.lost) throw new Error(lostText(ghost, parts.lost)); };
    const engineP = this._startEngine(files, { resume, bootEpochMs, sessionEndMs });
    engineP.catch(() => {});      // awaited below; avoid an unhandled rejection while the stage loads
    let stage, balloon, balloons, dialogs;
    // the ghost's Shell / Balloon scaling ▸ choice (core/scaling.js); on phones only a choice is passed (_scaleOpts)
    const scales = cssScales(state.data.scaling);
    // a resume restores everything; a cold boot only positions and dress-up (SSP keeps them per ghost). Bind ids are
    // local to a shell (EV §2.6): a stage stored for another shell keeps its dress-up in that shell's memory, and this
    // shell's own comes from the per-shell memory
    const stored = state.data.stage;
    if (isObj(stored) && typeof stored.shell === 'string' && !sameName(stored.shell, shellId)) {
      state.data.shells = withShellBinds(state.data.shells, stored.shell, stored);
    }
    const stageState = stageStateForShell(resume ? stored || undefined : coldStageState(stored), shellId, state.data.shells);
    // SSP shows them right before OnBoot, once the engine is up (EV §2.1 #24); here the shell is ready long before the
    // engine, so a cold boot's characters stay veiled until the boot script starts: one that opens with \s[-1] (Tsubasa
    // hides to put on her mask) must not show the default surface for the engine's load time first [observed]. Veiled as
    // the stage exists, in the same microtask: without a stored stage it composes its default surfaces at once, and the
    // balloon (more PNGs) may load after the frames that would draw them
    const veil = s => { if (!resume && s && typeof s.setVeiled === 'function') s.setVeiled(true); return s; };
    const root = this._rootOpt();       // several ghosts: everything of this ghost stacks in its layer (UI §3.5)
    try {
      [stage, balloon] = await Promise.all([
        Promise.resolve(this._createStage({ files, shellId, ghostDescript, state: stageState, ...this._scaleOpts('shell', state.data.scaling, scales.shell), ...root, onCanvasLost })).then(veil),
        this._loadSkin(files, { shellId, ghostDescript, onCanvasLost }),
      ]);
      parts.stage = stage;
      parts.skin = balloon.skin;
      parts.balloon = { id: balloon.id ?? null, name: balloon.name || '', path: balloon.path || '', files: balloon.files || null };
      lostCheck();
      this._holdDrops(stage);          // the engine is still loading: a drop waits for the boot
      if (!resume) {
        showDefaultCharacters(stage);     // under the veil (above)
      } else {
        // the last page went in the middle of a shell swap, before OnShellChanged decided the surfaces (EV §2.6)
        if (state.data.shellSwap) settleSwapSurfaces(stage, state.data.shellSwap);
        if (state.data.minimized) for (const s of stage.scopes) { try { stage.char(s).hide(); } catch (e) { /* ignore */ } }
      }
      state.data.shellSwap = null;
      balloons = await this._createBalloons({ skin: balloon.skin, stage, ghostFiles: files, ghostDescript, state: state.data.balloons || undefined, ...this._scaleOpts('balloon', state.data.scaling, scales.balloon), ...root, onCanvasLost });
      parts.balloons = balloons;
      dialogs = this._createDialogs({ skin: balloon.skin, stage, balloons, language: this.language, ...this._phoneOpt(), ...root });
      parts.dialogs = dialogs;
      lostCheck();
    } catch (e) {
      // the engine is still loading (megabytes of dictionaries): stop it once it is up; start() releases the lock
      engineP.then(x => x.client.terminate(), () => {});
      throw e;
    }

    let engine;
    try {
      engine = await engineP;
    } catch (e) {
      log.error(`the ${ghost.engine || 'satori'} engine failed to start`, e);
      this._teardown();
      if (this.lock) this.lock.release();
      return 'failed';
    }
    if (this.parts !== parts) { engine.client.terminate(); return 'aborted'; }    // torn down while the engine loaded
    parts.client = engine.client;
    lostCheck();                    // a first paint while the engine loaded (start()'s teardown stops the engine)
    // the folder actually loaded (Stage.create falls back when the asked one is gone, SH §6.8); a picked shell the site
    // no longer has is no longer a choice: the ghost follows its default again [decision]
    const sid = stage.shellId || shellId;
    if (state.data.shellChosen && !sameName(state.data.shell, sid)) state.data.shellChosen = false;
    state.data.shell = sid;
    // BA §1.6 "What is stored": the stored choice that resolved (rule 2: an old descript name becomes the folder id), or
    // the descript's / install.txt's (rules 3, 4) while nothing is stored. Never the shell's own (rule 1) or the site
    // default (5); a stored choice the site lost is kept, so it comes back when re-added (BA D5) [decision]
    if (balloon.id && (balloon.from === 'choice' || ((balloon.from === 'descript' || balloon.from === 'install') && !state.data.balloon))) {
      state.data.balloon = balloon.id;
    }

    const drops = DropStore.shared(STORE_NAMESPACE);     // dropped files, for every ghost of the site (TS §3.4)
    // MIDI files play on the page's MIDI engine (Site.midi; null: <audio>)
    const pageSaori = new PageSaori({ files, drops, midi: site.midi });
    parts.pageSaori = pageSaori;
    const input = site._ensureInput();
    const loop = new EventLoop({
      shiori: engine.client, stage, balloons, dialogs, ghost, state, files, ghostDescript, site: this.index,
      input, audio: pageSaori, drops, sessionEpochMs: epoch, balloonName: balloon.name,
      shell: { id: sid, name: shellName(ghost, sid) },
      paths: {
        site: site._basePath(), ghost: this._ghostInfo(ghost).path, shell: dirPath(files, `shell/${sid}/`),
        balloon: balloon.path,
      },
      language: this.language,
      peers: site.peersFor(this), layer: this.layer,       // the other ghosts (EV §2.7); null: alone
      // the visitor's user information (EV §4.16) and the property system's lists and box (properties.md)
      user: site.user, props: site.propsFor(this),
      wordList: () => site.compatibleWords(),             // SSP's word list for %ms-style words (properties.md §2.4)
    });
    parts.loop = loop;
    pageSaori.host = loop;
    const player = this._createPlayer({ stage, balloons, dialogs, host: loop });
    parts.player = player;
    loop.setPlayer(player);
    // the veil lifts as the boot script starts: the player runs its leading tags before the browser paints
    let offVeil = null;
    const unveil = () => {
      if (offVeil) { offVeil(); offVeil = null; }
      if (typeof stage.setVeiled === 'function') stage.setVeiled(false);
    };
    if (!resume) offVeil = player.on('start', unveil);
    // Shell / Balloon scaling ▸ (UI §2.1 #8, #9): the stage and balloons already have the stored scales (on phones
    // their fit where nothing is stored, UI §9.11)
    const scaling = new UserScaling({ state, stage, balloons, dialogs, host: loop, language: this.language, ...this._phoneOpt() });
    parts.scaling = scaling;
    scaling.bindWindow();
    const menu = new Menu({
      host: loop, stage, files, shellDir: `shell/${sid}/`, ghosts: () => this.ghostList(), scaling, language: this.language,
      shells: () => this.shellList(), balloons: () => this.balloonList(), info: () => this._infoData(parts),
      calls: () => site.callList(this),        // Call ghost ▸ (UI §2.12); null with one ghost at a time
      ghostDescript,                           // its menu.* keys under the shell's (menu.font.name / .height, UI §2.3)
      preferences: () => site.openSettings(),  // Options ▸ Preferences…: the Site's Preferences box (UI §2.13)
    });
    parts.menu = menu;
    loop.menu = menu;
    // only while this loop is the running one: a leaving or torn-down loop never closes or minimizes its successor
    const live = f => (...a) => { if (this.parts === parts) f(...a); };
    loop.on('minimized', live(() => this._showLauncher('minimized')));
    loop.on('restored', live(() => { this._hideLauncher(); site._raise(this); }));
    // a script's \![set,trayicon] while she is minimized: her button takes the new icon (UI §2.6)
    loop.on('trayicon', live(() => { if (this._launcherMode === 'minimized') this._showLauncher('minimized'); }));
    loop.on('closed', live(info => this._onClosed(info || {})));
    loop.on('change', live(req => this._requestChange(req)));
    // several ghosts (EV §2.7): calls, Quit, the keyboard owner, otherghostname, OnOtherGhostTalk
    loop.on('call', live(req => { site.call(this, req || {}); }));
    // R1 the menu's character, R2 the clicked one (a menu popupmenu.type redirected, UI §2.1 notes)
    loop.on('quitall', live(ev => { site.quit((ev && ev.scope) | 0, ev && Number.isInteger(ev.window) ? ev.window : undefined); }));
    loop.on('activate', live(() => site._onActivate(this)));
    loop.on('notified', live(ev => site._onNotified(this, ev || {})));
    loop.on('talk', live(ev => site._onTalk(this, ev || {})));
    loop.on('communicate', live(ev => site._onCommunicate(this, ev || {})));    // EV §2.7.7
    loop.on('raiseother', live(ev => site._onRaiseOther(this, ev || {})));      // EV §2.7.9
    // Shell ▸ / Balloon ▸ / \![change,shell|balloon] (EV §2.6)
    loop.viewSwitcher = req => (this.parts === parts ? this._requestView(req) : Promise.resolve(false));
    // a script's \![change,ghost]: whether it finds a ghost, so the script breaks (EV §2.7.7)
    loop.ghostFinder = (target, o) => this.parts === parts && this._changeFinds(target, o);
    // \![reload,shiori] (EV §2.10): the engine unloads and loads again in its request queue
    loop.shioriReloader = () => (this.parts === parts ? this._reloadShiori(parts) : Promise.resolve(false));
    state.bindPage();

    this._hideLauncher();
    const hadSave = engine.r && typeof engine.r.hadSave === 'boolean' ? engine.r.hadSave : !state.isNew;
    let booted = null;
    try {
      booted = await loop.boot({ resume, firstBoot: !hadSave, changed: change, called: call, silent });
    } finally {
      unveil();     // no boot script played
    }
    // a canvas lost during the boot (its talk's balloon): the start fails as above; from here on _canvasLost ends her
    if (this.parts === parts) lostCheck();
    parts.booted = true;
    const run = (booted && booted.run) || null;     // the boot event's run (EV §2.7: the after-boot events wait for it)
    // a change or call no longer pending; a reload comes on top as a change does (AddGhost activates it [disasm 0x466dc7])
    if (this.parts === parts) site._onBooted(this, { resume, run, change, call, reload: silent });
    if (this.parts === parts) this._deliverHeldDrop(stage);
    if (loop.minimized) this._showLauncher('minimized');
    menu.prefetch(0);
    menu.prefetch(1);
    this.emit('booted', { ghost: ghost.id, resume, run });
    return 'booted';
  }

  // ---------------------------------------------------------------- other tabs (SUMMARY §2.5, UI §9.5)

  /**
   * The stage a frozen tab shows: the stored shell, places, surfaces and dress-up (EV §2.6 per-shell memory); a swap
   * the other tab has not settled yet shows the remembered surfaces (settleSwapSurfaces).
   */
  async _frozenStage({ files, ghostDescript, shellId }) {
    const st = this.state.data;
    if (st.minimized) return null;
    const stage = await this._createStage({ files, shellId, ghostDescript, state: stageStateForShell(st.stage || undefined, shellId, st.shells), ...this._scaleOpts('shell', st.scaling, cssScales(st.scaling).shell), ...this._rootOpt(), onCanvasLost: (kind, s) => this._frozenLost(kind, s) });
    // a canvas lost while it was built (core/canvas.js): nothing of it is shown
    if (stage && stage.lost) {
      log.error(lostText(this.ghost, stage.lost));
      quiet('frozen stage', () => stage.destroy());
      return null;
    }
    if (stage && st.shellSwap) settleSwapSurfaces(stage, st.shellSwap);
    return stage;
  }

  /**
   * A canvas of the frozen stage shown cannot draw (core/canvas.js): one error, and the frozen view goes. Only the
   * view: the takeover listeners of _startFrozen stay (state.readOnly still marks the slot frozen), so turning to this
   * tab still brings the ghost here, as for a stage lost while _frozenStage built it.
   */
  _frozenLost(kind, stage) {
    if (!stage || this.frozen !== stage) return;      // still being built: _frozenStage drops it
    log.error(lostText(this.ghost, kind));
    this.frozen = null;
    quiet('frozen stage', () => stage.destroy());
  }

  async _startFrozen() {
    // a frozen stage shown already goes first (the set started again here, a stale launcher; UI §9.5); one cleared or
    // the slot removed while this one loads (_clearFrozen moves _frozenGen on) drops what it builds: no stage, no
    // listener is left behind for a slot that is not on screen any more
    this._clearFrozen();
    const gen = this._frozenGen;
    const stale = () => gen !== this._frozenGen || this._removed;
    this.state.readOnly = true;
    const common = await this._ghostCommon();
    if (stale()) return;
    let stage = null;
    try {
      stage = await this._frozenStage(common);
    } catch (e) {
      log.warn('could not show the frozen ghost', e);
    }
    if (stale()) { if (stage) quiet('frozen stage', () => stage.destroy()); return; }
    this.frozen = stage;
    // a shell change in the other tab after this tab read the state: its {t:'view'} found no frozen stage here yet
    if (this.frozen && this._viewMissed) { this._viewMissed = false; this._redrawFrozen(); }
    const doc = this._doc();
    const win = typeof window !== 'undefined' ? window : null;
    const tryTakeover = this._frozenTakeover = () => this.site._wake(this);
    // files dropped on the frozen ghost: she wakes up here and gets them (a desktop drag does not focus the window)
    if (this.frozen) this._holdDrops(this.frozen, tryTakeover);
    if (doc) {
      const vis = () => { if (!doc.hidden) tryTakeover(); };
      doc.addEventListener('visibilitychange', vis);
      if (win) win.addEventListener('focus', vis);
      this._frozenOff = () => { doc.removeEventListener('visibilitychange', vis); if (win) win.removeEventListener('focus', vis); };
      if (!doc.hidden) tryTakeover();
    }
  }

  /**
   * The frozen ghost asks the tab running it to let go (UI §9.5): only while frozen and this tab is visible, one
   * request per lock; once the lock is granted the stage is cleared, the stored state read again and the ghost resumes
   * here (tookOver). The Site's _wake calls it.
   */
  async _tryTakeover() {
    if (!this.frozen && !this.state.readOnly) return;
    const doc = this._doc();
    if (doc && doc.hidden) return;
    // one request per lock: a wait on a lock let go meanwhile (this tab followed a ghost change) blocks nothing
    const lock = this.lock;
    if (!lock || this._takingOver === lock) return;
    this._takingOver = lock;
    try {
      lock.requestTakeover();
      if (!(await lock.acquire({ wait: true })) || lock !== this.lock) return;
      this._clearFrozen();
      this.state.reload();
      this.tookOver = true;
      await this.start();
    } finally {
      if (this._takingOver === lock) this._takingOver = null;
    }
  }

  /**
   * A frozen slot of a multi Site runs again (UI §9.5): the Site holds the set's lead by now (Site._wake). Its ghost
   * lock is asked for (a tab on the one-ghost runtime still holding it gets its per-ghost request) and awaited;
   * then the frozen stage goes, the stored state is read again and the ghost resumes here (tookOver).
   * @returns {Promise<string>} start()'s outcome; 'frozen' when it is not taken over
   */
  async _takeOver() {
    const g = this.ghost;
    if (g && this.parts) return 'booted';     // it runs here already: never a second engine for it
    if (!g || (!this.frozen && !(this.state && this.state.readOnly))) return 'none';
    if (!this.lock) {
      this.lock = this._newLock(g.id);
      this.lock.on('takeover-request', () => this._onTakeoverRequest());
    }
    const lock = this.lock;
    if (this._takingOver === lock) return 'frozen';
    this._takingOver = lock;
    try {
      lock.requestTakeover();
      if (!(await lock.acquire({ wait: true })) || lock !== this.lock) return 'frozen';
      this._clearFrozen();
      if (this.state) this.state.reload();
      this.tookOver = true;
      return await this.start({ ghost: g.id });
    } finally {
      if (this._takingOver === lock) this._takingOver = null;
    }
  }

  /**
   * The tab that runs this ghost changed its shell (EV §2.6, message {t:'view'}): the frozen stage is built again from
   * the stored state, so this tab shows the new shell's character art [decision: a frozen tab follows no surface or
   * dress-up change, but a whole other look is too jarring]. \0 and \1 still without a surface there (OnShellChanged's
   * reply had not set one when the state was stored) show their default surfaces. Redraws run one at a time.
   */
  _redrawFrozen() {
    const run = async () => {
      if (!this.frozen || !this.state || !this.state.readOnly) return;
      const gen = this._frozenGen;
      this.state.reload();
      let stage = null;
      try {
        stage = await this._frozenStage(await this._ghostCommon());
      } catch (e) {
        log.warn('could not redraw the frozen ghost', e);
        return;
      }
      if (!stage) return;
      // taken over, cleared or removed meanwhile
      if (gen !== this._frozenGen || this._removed || !this.frozen || !this.state.readOnly) { quiet('frozen stage', () => stage.destroy()); return; }
      for (const s of [0, 1]) {
        quiet('frozen surface', () => { const c = stage.char(s); if (c.surfaceId < 0) c.setSurface(stage.defaultSurface(s)); });
      }
      const old = this.frozen;
      this.frozen = stage;
      if (this._frozenTakeover) this._holdDrops(stage, this._frozenTakeover);
      quiet('frozen stage', () => old.destroy());
    };
    this._redrawing = (this._redrawing || Promise.resolve()).then(run, run);
    return this._redrawing;
  }

  /** The page's document; null outside a browser (a method so tests can give each tab its own). */
  _doc() { return typeof document !== 'undefined' ? document : null; }

  /**
   * Take file drops on a stage before an event loop has booted on it (engine loading, a frozen tab): the last drop
   * is kept for _deliverHeldDrop, so it neither vanishes nor makes the browser open the file (EV §4.14).
   * @param {Function} [then] called after each held drop (a frozen tab takes the ghost over)
   */
  _holdDrops(stage, then = null) {
    stage.acceptsDrops = true;
    stage.on('drop', info => {
      const loop = this.parts && this.parts.stage === stage ? this.parts.loop : null;
      if (loop && loop.booted) return;                      // the event loop has it
      this._heldDrop = { info, at: Date.now() };
      if (then) then();
    });
  }

  /** Hand a held drop to the booted ghost's stage (its event loop sends OnFileDrop2); stale ones are dropped. */
  _deliverHeldDrop(stage) {
    const h = this._heldDrop;
    this._heldDrop = null;
    if (h && Date.now() - h.at <= HELD_DROP_MS) stage.emit('drop', h.info);
  }

  _clearFrozen() {
    this._frozenGen++;                  // a frozen start or redraw still loading drops what it builds
    if (this._frozenOff) this._frozenOff();
    this._frozenOff = null;
    this._frozenTakeover = null;
    if (this.frozen) { try { this.frozen.destroy(); } catch (e) { /* ignore */ } }
    this.frozen = null;
  }

  _onTakeoverRequest() {
    // several ghosts: the set goes all or nothing (a request on a ghost lock comes from a tab on the one-ghost runtime)
    if (this.site.multi) { this.site._onLeadRequest(); return; }
    if (this._changing) { this._takeoverAsked = true; return; }   // answered once the change is over (_requestChange)
    if (!this.parts || !this.parts.loop) {
      // closed or between states: nothing runs here, let the other tab have the ghost
      if (!this._starting && this.lock && !this.frozen) this.lock.release();
      return;
    }
    const doc = this._doc();
    if (doc && !doc.hidden) { this._yieldWhenHidden = true; return; }
    this._yield();
  }

  async _yield() {
    if (this._changing) { this._takeoverAsked = true; return; }   // never halfway through a change: after it
    this._yieldWhenHidden = false;
    const p = this.parts;
    if (!p || !p.loop) return;
    try { await p.loop.suspend(); } catch (e) { /* best effort */ }
    this._teardown();
    if (this.lock) this.lock.release();
    await this._startFrozen();
  }

  // ---------------------------------------------------------------- failures, close, minimize

  /**
   * A canvas of the running ghost cannot draw (core/canvas.js: no 2D context, or no backing store under
   * WebKit's canvas memory cap; the onCanvasLost of its Stage, Balloons and BalloonSkin.load): the ghost ends as a
   * failed start ends, so no half-drawn ghost stays. Once per parts. While _boot builds (not `booted` yet) the parts
   * are only marked: _boot's lostCheck fails the start (one error, the existing path; a balloon its boot talk makes
   * before loop.boot returns counts). Later (a balloon or \p[n] made after that, a shell or balloon swap, an image
   * decoded late): one error, her characters veiled and balloons hidden, and she stops, all at once: saved as for a
   * takeover (loop.suspend, no OnClose), so no talk, timer or event of hers runs from here on and nothing shows a
   * balloon again. A change under way ends early (OnShellChanging's wait and a goodbye: cancelled; a swap: no
   * OnShellChanged or OnBalloonChange, its surfaces left to the next page through state.shellSwap, _settleSwap). Once
   * a start or change under way settled: veiled and hidden again (what the change put up), what it left unsaved
   * stored, torn down, her lock let go, and Site._dropFailed: she leaves the set while others run; alone, the set stays
   * and the lead goes, so the next page tries her again.
   * @param {string} kind 'character' | 'shell image' | 'balloon' | 'balloon image'
   * @param {object} p the parts the canvas belongs to
   */
  _canvasLost(kind, p) {
    if (!p || p.lost) return;
    p.lost = kind;
    if (this.parts !== p || !p.booted) return;
    log.error(lostText(this.ghost, kind));
    this._hideLost(p);
    // a loop closed or left already (Close's unload, a ghost change's leave) is not stopped twice: _endLost decides
    const loop = p.loop;
    if (loop && !loop.frozen && !loop.closed) p.stopped = loop.suspend().catch(() => {});
    this._endLost(p).catch(e => log.warn('could not take the ghost off the page', e));
  }

  /** _canvasLost: her characters veiled and her balloons hidden. */
  _hideLost(p) {
    if (p.stage && typeof p.stage.setVeiled === 'function') quiet('veil', () => p.stage.setVeiled(true));
    if (p.balloons && typeof p.balloons.hideAll === 'function') quiet('balloons', () => p.balloons.hideAll());
  }

  async _endLost(p) {
    // the stop begun at the loss first (saved, persisted); a change whose own step lost the canvas holds the slot by then
    if (p.stopped) await p.stopped;
    while (this._starting || this._changing) await (this._starting || this._changing).catch(() => {});
    if (this.parts !== p) return;       // gone meanwhile (a ghost change, a takeover, a close)
    if (!p.stopped && p.loop) { try { await p.loop.suspend(); } catch (e) { /* best effort */ } }
    if (this.parts !== p) return;
    this._hideLost(p);                  // what a change put up meanwhile (a swap's new stage)
    // what a change that settled after she stopped left unsaved (a balloon swap's choice: state.change)
    if (this.state && this.state.dirty) this.state.saveNow();
    this._teardown();
    if (this.lock) this.lock.release();
    this.site._dropFailed([this], 'cannot draw');
  }

  async _onCrash() {
    const p = this.parts;
    if (!p || !p.loop || !p.files) return;
    const now = Date.now();
    this.crashes = this.crashes.filter(t => now - t < CRASH_WINDOW_MS);
    this.crashes.push(now);
    if (this.crashes.length > MAX_CRASHES) { log.error('the engine keeps failing; giving up until the next page'); return; }
    log.warn('restarting the engine from its save data');
    try {
      // her clock goes on (P7): since-load from the same cold boot, the total from the last save
      const { client } = await this._startEngine(p.files, { resume: true, bootEpochMs: p.bootEpochMs });
      if (this.parts !== p) { client.terminate(); return; }
      p.client = client;
      p.loop.setShiori(client);
      await p.loop.afterEngineRestart();
    } catch (e) {
      log.error('engine restart failed', e);
    }
  }

  /**
   * The ghost closed (the loop's 'closed' {script}; it saved itself): teardown, the lock let go, then the Site's part
   * with what the others are told (its last script and its peerInfo() as it closed: OnOtherGhostClosed, EV §2.7).
   */
  _onClosed(info = {}) {
    const loop = this.parts && this.parts.loop;
    let peer = null;
    try { peer = loop && typeof loop.peerInfo === 'function' ? loop.peerInfo() : null; } catch (e) { peer = null; }
    this._teardown({ keepState: true });
    if (this.lock) this.lock.release();
    this.site._onClosed(this, { ...info, peer });       // the tab marker, the set, the others; the closed launcher
  }

  /**
   * The launcher (minimized: restore; closed: call back; tucked: bring her out, UI §9.11), in its place in the Site's
   * dock (UI §2.6).
   */
  _showLauncher(mode) {
    this._launcherMode = mode;
    if (typeof document === 'undefined') { this.site._layoutDock(); return; }
    const g = this.ghost || {};
    if (!this.launcher) {
      this.launcher = new Launcher({
        name: g.sakuraName || g.name || g.id,
        onActivate: m => this._launch(m),
        language: this.language,
        slot: this.site._dockSlot(this),
        ...(this.site.phone ? { phone: true } : {}),      // phones: clear of the safe-area insets (UI §9.11)
      });
    }
    // her tray icon as ssp.exe picks it (UI §2.6): icon.minimize, the icon shown before (a script's), her icon; none:
    // the initial letter (SSP's own icon). Never the thumbnail: SSP's tray never shows it. Tucked: Iconify's icon,
    // no script's (she has not run yet) [decision]. An <img>, so the plain URL, no `?v=`
    const tucked = mode === 'tucked';
    const p = launcherIconPath(g, tucked ? 'minimized' : mode, tucked ? null : this._minimizedState());
    this.launcher.setIcon(p ? siteUrls(this.base, [p])[0] || null : null);
    this.launcher.show(mode);
    this.site._layoutDock();
  }

  /** The ghost's `minimized` record: her running loop's, else the stored state's (a frozen tab), else null. */
  _minimizedState() {
    const loop = this.parts && this.parts.loop;
    if (loop) return loop.minimized || null;
    const d = this.state && this.state.data;
    return (d && d.minimized) || null;
  }

  _hideLauncher() {
    const was = this._launcherMode;
    this._launcherMode = null;
    if (this.launcher) this.launcher.hide();
    if (was) this.site._layoutDock();
  }

  _launch(mode) {
    this._launcherMode = null;          // the button hid itself
    this.site._layoutDock();
    if (mode === 'tucked') {
      // a tucked page's button (UI §9.11; a phone's, or any device's with data-default-state="tucked"): it stays,
      // dimmed, until her boot starts (_boot hides it) or the set shows frozen behind another tab (Site._untuck)
      this._showLauncher('tucked');
      if (this.launcher) this.launcher.setBusy(true);
      this.site._untuck(this).catch(e => log.warn('could not bring the ghost out', e));
      return;
    }
    if (mode === 'minimized' && this.parts && this.parts.loop) { this.parts.loop.restore(); return; }
    if (mode === 'minimized' && this.site.multi) {
      // the restore button of a ghost minimized in the tab that runs the set (shown frozen here): it stays, and this
      // tab asks for the set (UI §9.5); a ghost that is gone (closed during Quit) is never called back by it
      if (this.frozen || (this.state && this.state.readOnly)) { this._showLauncher('minimized'); this.site._wake(this); }
      return;
    }
    // closed: call her (several ghosts: the stored set) again with a fresh boot (OnBoot)
    this.site._relaunch(this);
  }

  // ---------------------------------------------------------------- ghost change (EV §2.5, UI §2.1 #12)

  /** The site's ghosts for this ghost's Change ghost ▸ (Site.ghostList): [{id, name, current, note, needs}]. */
  ghostList() {
    return this.site.ghostList(this);
  }

  /**
   * Change the running ghost (page API: window.sumika.changeGhost). The menu and scripts ask through the event
   * loop's 'change' event. Resolves true when the ghost changed; never rejects.
   * @param {string} target a ghost id (or with {byId:false}: a name, 'random', 'sequential')
   */
  changeGhost(target, opts = {}) {
    return this._requestChange({ target, byId: true, reason: 'manual', raiseEvent: true, scope: 0, ...opts });
  }

  /** @param {object} req  the loop's 'change' event; @param {boolean} [queued] a request _chainChange let through */
  _requestChange(req, queued = false) {
    if (this._changing) {
      if (req && req.fromScript) return this._chainChange(() => this._requestChange(req, true), queued);
      log.info('a ghost, shell or balloon change is already under way');
      return Promise.resolve(false);
    }
    // in the Site's queue of set changes (calls and ghost changes go one at a time; an idle queue starts it at once)
    this._changing = this.site._mutate('change', () => this._change(req || {}))
      .catch(e => { log.error('ghost change failed', e); return false; })
      .finally(() => {
        this._pending = null;
        this._committed = false;
        this._slotFreed();
      });
    return this._changing;
  }

  /**
   * A script's change (\![change,ghost|shell|balloon]) asked while the slot is held (EV §2.5, §2.6): it waits for the
   * slot instead of being refused, as SSP runs it after the change in progress: 333-4.05 changes back inside its
   * OnShellChanged reply, a boot script picks a shell after Change ghost ▸, an OnBalloonChange reply changes again. It
   * runs only while the same ghost runs here (a takeover, a ghost change or a teardown in between: false). Refused
   * (false) while the slot's change waits for a talk to end (_waitingTalk: OnShellChanging's talk, or a ghost change
   * until its farewell is over, also one that was queued here itself): a change held at its tag would hold that talk.
   * At most MAX_CHAINED_CHANGES in a row.
   * @param {Function} again  the request once the slot is free (re-queued when another took it first)
   * @param {boolean} queued  already counted (a request let through and queued again)
   * @param {boolean} [shell]  a shell change (_chainShells: it takes over a swap's undecided marker, _settleSwap)
   * @returns {Promise<boolean>}
   */
  _chainChange(again, queued, shell = false) {
    if (this._waitingTalk) { log.info('a change waits for the ghost\'s talk; no change from its script'); return Promise.resolve(false); }
    if (!queued) {
      if (this._chained >= MAX_CHAINED_CHANGES) {
        log.warn(`the ghost asked for ${MAX_CHAINED_CHANGES + 1} changes in a row; no more`);
        return Promise.resolve(false);
      }
      this._chained++;
    }
    this._chainWaiting++;
    if (shell) this._chainShells++;
    const p = this.parts;
    const go = () => {
      this._chainWaiting--;
      if (shell) this._chainShells--;
      const r = this.parts === p ? again() : Promise.resolve(false);
      if (!this._changing) this._slotFreed();     // nothing took the slot: what waits behind it goes now
      return r;
    };
    return this._changing.then(go, go);
  }

  /**
   * The change slot is free: script changes queued behind it go first (_chainChange); then a shellSwap marker kept for
   * them that no queued swap took over goes (_settleSwap), and a takeover asked meanwhile (another tab, or this one
   * hidden with one due) is answered, for the ghost running then.
   */
  _slotFreed() {
    this._changing = null;
    if (this._chainWaiting) return;
    this._chained = 0;
    const k = this._chainMark;
    this._chainMark = null;
    if (k && this.parts === k.p && this.state && this.state.data.shellSwap === k.mark) { this.state.data.shellSwap = null; this.state.change(); }
    if (this._takeoverAsked) { this._takeoverAsked = false; this._onTakeoverRequest(); }
    this.site._slotIdle(this);        // a takeover of the whole set asked meanwhile (several ghosts)
  }

  // ---------------------------------------------------------------- shell and balloon changes (EV §2.6, BA §12)

  /** The running shell's folder: the stage's (the folder actually loaded), else the stored one. */
  _currentShellId() {
    const p = this.parts;
    return (p && p.stage && p.stage.shellId) || (this.state && this.state.data.shell) || null;
  }

  /** {id, name, path} of a shell of the running ghost: its descript name and site-absolute folder path. */
  _shellRef(files, id) {
    return { id, name: shellName(this.ghost, id), path: dirPath(files, `shell/${id}/`) };
  }

  /** Shell ▸ (UI §2.11): the visible shells in SSP's name order, the one in use `current`: [{id, name, current}]. */
  shellList() {
    const g = this.ghost;
    if (!g) return [];
    const cur = this._currentShellId();
    const versions = this.index && this.index.versions;
    return visibleShells(g).map(s => {
      // its thumbnail*.* (UI §2.14), each with the index's `?v=` (fetched by loadThumbnail)
      const thumbnails = siteUrls(this.base, s.thumbnails, versions);
      return { id: s.id, name: s.name || s.id, current: sameName(s.id, cur), ...(thumbnails.length ? { thumbnails } : {}) };
    });
  }

  /**
   * Balloon ▸ (UI §2.11, BA §12.1): {top: the ghost descript's own balloons, all: every installed balloon}, rows
   * {id, name, current}; `current` on the first row of the balloon in use only.
   */
  balloonList() {
    const g = this.ghost;
    if (!g || !this.index) return { top: [], all: [] };
    const p = this.parts;
    const m = balloonMenu(installedBalloons(this.index, g), ghostBalloonKeys(p && p.ghostDescript), p && p.balloon ? p.balloon.id : null);
    // their thumbnail*.* as URLs (UI §2.14), each with the index's `?v=` (fetched by loadThumbnail)
    const versions = this.index.versions;
    const urls = r => { const t = siteUrls(this.base, r.thumbnails, versions); const { thumbnails, ...rest } = r; return t.length ? { ...rest, thumbnails: t } : rest; };
    return { top: m.top.map(urls), all: m.all.map(urls) };
  }

  /**
   * Change the running ghost's shell (page API window.sumika.changeShell; Shell ▸ and scripts ask through the event
   * loop). Like a Shell ▸ pick: refused while minimized, in passive or induction mode or inside \t; OnShellChanging
   * first. Resolves true when the shell changed; never rejects.
   * @param {string} target  a shell folder id (with {byId:false}: a descript name, 'random', 'sequential')
   */
  changeShell(target, opts = {}) {
    const loop = this.parts && this.parts.loop;
    const r = loop ? loop.changeShell(target, { byId: true, raiseEvent: true, scope: 0, ...opts }) : false;
    return r || Promise.resolve(false);
  }

  /** Change the running ghost's balloon (page API window.sumika.changeBalloon), like a Balloon ▸ pick. */
  changeBalloon(target, opts = {}) {
    const loop = this.parts && this.parts.loop;
    const r = loop ? loop.changeBalloon(target, { byId: true, scope: 0, ...opts }) : false;
    return r || Promise.resolve(false);
  }

  /**
   * The event loop's viewSwitcher (EV §2.6): a shell or balloon change in the runtime's one change slot, so it never
   * overlaps a ghost change or another view change. While the slot is held a menu or page-API request is refused
   * (false) and a script's waits for it (_chainChange); a takeover asked meanwhile is answered after it.
   * @param {{kind:'shell'|'balloon', target:string, byId?:boolean, raiseEvent?:boolean, fromScript?:boolean, scope?:number}} req
   * @param {boolean} [queued] a request _chainChange let through
   * @returns {Promise<boolean>}
   */
  _requestView(req, queued = false) {
    if (this._changing) {
      if (req && req.fromScript) return this._chainChange(() => this._requestView(req, true), queued, req.kind === 'shell');
      log.info(`a change is already under way; no ${req && req.kind} change`);
      return Promise.resolve(false);
    }
    const p = this.parts;
    if (!p || !p.loop || !req) return Promise.resolve(false);
    const work = req.kind === 'balloon' ? this._changeBalloon(req, p) : this._changeShell(req, p);
    this._viewChanging = true;
    this._changing = work
      .catch(e => { log.error(`${req.kind} change failed`, e); return false; })
      .finally(() => {
        this._viewChanging = false;
        this._waitingTalk = false;
        this._slotFreed();
      });
    return this._changing;
  }

  /**
   * A shell change (EV §2.6): the target among every shell of the ghost (hidden ones too) in menu order; with
   * raise-event (menu, page API, a script's --option=raise-event) OnShellChanging first, and the swap waits for its
   * talk to end (a balloon break or a reply that replaces it cancels); then the swap. A script's own change (no
   * raise-event) swaps at once, and OnShellChanged's reply waits for that script's end (defer) [guess]. A reload
   * (\![reload,shell], \![reloadsurface]; EV §2.10) swaps to the shell in use, without OnShellChanging or OnShellChanged
   * (ChangeOrReloadShellInternal(-1, event false) [disasm 0x6230d1, 0x62335c]).
   */
  async _changeShell({ target, byId = false, raiseEvent = true, fromScript = false, scope = 0, reload = false }, p) {
    const shells = sortShells((this.ghost && this.ghost.shells) || []);
    if (reload) {
      const cur = this._currentShellId();
      const entry = shells.find(s => sameName(s.id, cur)) || (cur ? { id: cur } : null);
      return entry ? this._swapShell(entry, { event: false, reload: true }) : false;
    }
    const next = resolveShellTarget(shells, this._currentShellId(), target, { byId });
    if (!next) { log.info(`no shell "${target}" to change to`); return false; }
    if (raiseEvent) {
      this._waitingTalk = true;       // a change its talk asks for is refused, not queued (_chainChange)
      let r;
      try {
        r = await p.loop.shellChanging(this._shellRef(p.files, next.id), { scope });
      } finally {
        this._waitingTalk = false;
      }
      if (!r || !r.ok || this.parts !== p) { log.info('shell change cancelled'); return false; }
    }
    return this._swapShell(next, { event: true, defer: !!fromScript && !raiseEvent });
  }

  /**
   * The shell swap (EV §2.6 "The swap"; SSP ChangeOrReloadShellInternal): the engine keeps running. The event loop
   * remembers the shown surfaces, closes the balloons and stops listening (detachStage); the old shell's dress-up goes
   * into the per-shell memory and the choice is stored at once (a page left mid-swap boots the new shell); the new
   * stage is built with the old places and the new shell's own dress-up, every character without a surface; balloons,
   * boxes, the player (attachStage), the user's scaling and the menu follow it; the old stage goes; the shell's own
   * balloon (the one it boots with) comes back silently; then the NOTIFYs and OnShellChanged (shellChanged). A stage
   * that fails to load changes nothing (the old one is attached again). The other tabs showing this ghost frozen redraw
   * ({t:'view'}). Until OnShellChanged's reply starts (or its 204 restores the surfaces) state.shellSwap holds the
   * remembered surfaces: a page left meanwhile resumes with them (settleSwapSurfaces).
   * @param {{id:string}} entry  the shell (ghosts.json `shells` entry)
   * @param {{event?: boolean, defer?: boolean, reload?: boolean}} [o] event: OnShellChanged (every pick and
   *   \![change,shell]); defer: its reply plays when the running script ends; reload: the shell in use again
   *   (\![reload,shell]), which is no pick: shellChosen stays as it was [decision]
   */
  async _swapShell(entry, { event = true, defer = false, reload = false } = {}) {
    const p = this.parts;
    if (!p || !p.loop || !p.stage) return false;
    const loop = p.loop;
    const state = this.state;
    const d = state.data;
    const old = p.stage;
    const oldId = old.shellId || d.shell;
    const before = { shell: d.shell, shellChosen: d.shellChosen, shellSwap: d.shellSwap };
    const surfaces = loop.detachStage();
    let oldState = null;
    try { oldState = typeof old.saveState === 'function' ? old.saveState() : null; } catch (e) { oldState = null; }
    if (oldId) d.shells = withShellBinds(d.shells, oldId, oldState);
    d.shell = entry.id;
    if (!reload) d.shellChosen = true;
    // an earlier swap still undecided (two script changes before its reply) left nothing shown: its surfaces carry on
    const undecided = isObj(d.shellSwap) && isObj(d.shellSwap.surfaces) ? d.shellSwap.surfaces : {};
    const mark = { surfaces: { ...undecided, ...Object.fromEntries(surfaces) } };
    d.shellSwap = mark;
    state.saveNow();
    let stage;
    try {
      // phones with no choice: no scale, the new shell fits itself (UI §9.11) [decision]
      const scale = Number(old.scale) > 0 ? Number(old.scale) : cssScales(d.scaling).shell;
      stage = await this._createStage({ files: p.files, shellId: entry.id, ghostDescript: p.ghostDescript, state: swapStageState(oldState, entry.id, d.shells, surfaces), ...this._scaleOpts('shell', d.scaling, scale), ...this._rootOpt(), onCanvasLost: kind => this._canvasLost(kind, p) });
    } catch (e) {
      log.error(`shell "${entry.id}" failed to load; keeping the current one`, e);
      if (this.parts === p) {
        d.shell = before.shell;
        d.shellChosen = before.shellChosen;
        d.shellSwap = before.shellSwap;
        loop.attachStage(old, this._shellRef(p.files, oldId));
        state.saveNow();
      }
      return false;
    }
    if (this.parts !== p) { quiet('stage destroy', () => stage.destroy()); return false; }   // torn down meanwhile
    const sid = stage.shellId || entry.id;
    p.stage = stage;
    if (p.balloons && typeof p.balloons.setStage === 'function') quiet('balloons.setStage', () => p.balloons.setStage(stage));
    if (p.dialogs && typeof p.dialogs.setStage === 'function') quiet('dialogs.setStage', () => p.dialogs.setStage(stage));
    loop.attachStage(stage, this._shellRef(p.files, sid));
    if (p.scaling) p.scaling.stage = stage;
    if (p.menu && typeof p.menu.setShell === 'function') quiet('menu.setShell', () => p.menu.setShell({ stage, shellDir: `shell/${sid}/` }));
    quiet('stage destroy', () => old.destroy());
    d.shell = sid;
    // the balloon this shell boots with, silently (no OnBalloonChange, nothing stored) [disasm LoadShell ->
    // GetBalloonIDFromSetting]: its remembered one, else the ghost's choice, its descript's, install.txt's, the site
    // default (chooseBalloon, BA §1.6), so a reload shows the same balloon
    const pick = this._shellBalloon(p, sid);
    if (pick && !(p.balloon && sameName(p.balloon.id, pick.entry.id))) {
      await this._swapBalloon(pick.entry, { event: false, silent: true });
      if (this.parts !== p) return true;
    }
    // the shell load asks the SHIORI for the menu's look before OnShellChanged (LoadShell → LoadGhostCore(0) →
    // GetODMFromShiori(1) [disasm 2.9.10 0x6231e3, 0x62161e]; UI §2.3): menu.setShell sent it, odmReady is its answer
    if (p.menu && p.menu.odmReady) {
      await p.menu.odmReady;
      if (this.parts !== p) return true;
    }
    const changed = await loop.shellChanged({ surfaces, event, defer });
    if (this.parts === p) {
      this._settleSwap(p, mark, defer, !!(changed && changed.restored));
      state.saveNow();
      this._post({ t: 'view', id: this.ghost.id });
      this.site._onShellChanged(this);      // otherghostname again, to every ghost (EV §2.7.5)
    }
    return true;
  }

  /** chooseBalloon (BA §1.6) for shell `sid` of the running ghost; null: none (or the built-in one). */
  _shellBalloon(p, sid) {
    const d = this.state.data;
    const mem = shellMemory(d.shells, sid);
    try {
      return chooseBalloon(this.index, this.ghost, { shellBalloon: mem && mem.balloon, choice: d.balloon, ghostDescript: p.ghostDescript, pageDefault: this.defaultBalloon });
    } catch (e) {
      log.once('runtime:shell balloon', 'could not pick the shell\'s balloon', e);
      return null;
    }
  }

  /**
   * After shellChanged (EV §2.6): the swap's marker (state.shellSwap, settleSwapSurfaces) goes once OnShellChanged
   * decided the surfaces: its reply played (a menu pick) or a 204 restored them. A reply waiting for the calling
   * script's end (defer) keeps it until that reply starts. A reply that played at once but showed nothing and queued a
   * shell change behind the slot (333-4.05's `\1\![change,shell,master]`) keeps it too: the queued swap carries its
   * surfaces on (_swapShell's `undecided`), so a page left or a takeover during that swap resumes the ghost visible; if
   * no queued swap took it over (refused, failed), it goes when the slot frees with nothing queued (_slotFreed).
   */
  _settleSwap(p, mark, defer, restored = false) {
    const d = this.state.data;
    if (d.shellSwap !== mark) return;
    // a surface as stored (an unshown \p[n] window counts as none)
    const shown = () => {
      try { return Object.values(p.stage.saveState().scopes || {}).some(st => st && st.surface >= 0); } catch (e) { return true; }
    };
    if (p.swapOff) { p.swapOff(); p.swapOff = null; }
    // a 204 (or no event) put the remembered surfaces back: decided, even when that left every scope hidden (EV §2.6 #4)
    if (restored || shown()) { d.shellSwap = null; return; }
    // a ghost that cannot draw (core/canvas.js) was stopped before OnShellChanged decided them (_canvasLost): the
    // marker stays, so the next page resumes her with the remembered surfaces, as after a page left mid-swap
    if (p.lost) return;
    if (!defer && !this._chainShells) { d.shellSwap = null; return; }
    if (!defer) { this._chainMark = { p, mark }; return; }
    const off = p.loop.on('play', run => {
      if (!run || run.event !== 'OnShellChanged') return;
      off();
      if (p.swapOff === off) p.swapOff = null;
      if (this.parts === p && this.state && this.state.data.shellSwap === mark) { this.state.data.shellSwap = null; this.state.change(); }
    });
    p.swapOff = off;
  }

  /**
   * A balloon change (BA §12.2): the target among the installed balloons in Balloon ▸ order, then the re-skin. A reload
   * (\![reload,balloon], EV §2.10) re-skins with the balloon in use, without OnBalloonChange; none (the built-in one):
   * false, as ChangeOrReloadBalloonInternal(-1, event false) [disasm 0x622dca–0x622ddb, 0x622f0d].
   */
  async _changeBalloon({ target, byId = false, fromScript = false, reload = false }, p) {
    const list = installedBalloons(this.index, this.ghost);
    if (reload) {
      const entry = p.balloon && p.balloon.id ? list.find(b => sameName(b.id, p.balloon.id)) : null;
      return entry ? this._swapBalloon(entry, { event: false }) : false;
    }
    const next = resolveBalloonTarget(list, p.balloon ? p.balloon.id : null, target, { byId });
    if (!next) { log.info(`no balloon "${target}" to change to`); return false; }
    return this._swapBalloon(next, { event: true, defer: !!fromScript });
  }

  /**
   * The balloon swap (BA §12.2; SSP ChangeOrReloadBalloonInternal): load the skin (a failure changes nothing), re-skin
   * every balloon and box in place, store the choice for the ghost and for the current shell (SSP writes both), then
   * NOTIFY OnNotifySelfInfo and GET OnBalloonChange (balloonChanged). A re-pick of the balloon in use does it all again.
   * @param {{id:string, name?:string, ghost?:string}} entry  installedBalloons() entry
   * @param {{event?: boolean, defer?: boolean, silent?: boolean}} [o] silent: a shell's own balloon during a shell swap
   *   (no events, nothing stored: OnNotifySelfInfo goes out with the shell's NOTIFYs)
   */
  async _swapBalloon(entry, { event = true, defer = false, silent = false } = {}) {
    const p = this.parts;
    if (!p || !p.loop) return false;
    let b;
    try {
      b = await this._loadBalloon(entry, p.files, { onCanvasLost: kind => this._canvasLost(kind, p) });
    } catch (e) {
      log.warn(`balloon "${entry.id}" failed to load; nothing changes`, e);
      return false;
    }
    if (this.parts !== p) return false;
    if (!b || !b.skin || b.skin.isFallback) { log.warn(`balloon "${entry.id}" has no descript.txt; nothing changes`); return false; }
    if (p.balloons && typeof p.balloons.setSkin === 'function') quiet('balloons.setSkin', () => p.balloons.setSkin(b.skin));
    if (p.dialogs && typeof p.dialogs.setSkin === 'function') quiet('dialogs.setSkin', () => p.dialogs.setSkin(b.skin));
    // phones: the new skin's fit (Balloons.fitScale) applies while no Balloon scaling ▸ choice is stored (UI §9.11)
    if (this.site.phone && p.scaling) quiet('scaling.refit', () => p.scaling.refit());
    p.skin = b.skin;
    p.balloon = { id: b.id, name: b.name, path: b.path, files: b.files };
    const d = this.state.data;
    if (!silent) {
      d.balloon = b.id;
      const sid = this._currentShellId();
      if (sid) {
        const key = memoryKey(d.shells, sid);
        d.shells = { ...d.shells, [key]: { ...(shellMemory(d.shells, sid) || {}), balloon: b.id } };
      }
    }
    p.loop.setBalloonInfo({ name: b.name, path: b.path });
    if (!silent) await p.loop.balloonChanged({ event, defer });
    if (this.parts === p) this.state.change();
    return true;
  }

  /** Post on the site channel (Site._post: the other tabs, a shell change). */
  _post(msg) { this.site._post(msg); }

  /**
   * What Information ▸ shows (UI §2.11, ui/info.js): the ghost (its root and ghost/master/descript.txt), the current
   * shell (its folder and descript) and the current balloon (its folder and descript), and Sumika's version.
   */
  _infoData(p) {
    const g = this.ghost || {};
    const sources = [{ kind: 'ghost', name: (p.ghostDescript && p.ghostDescript.get('name')) || g.name || g.id, files: p.files, descript: p.ghostDescript }];
    const st = p.stage;
    const sid = this._currentShellId();
    let shellFiles = st && st.shellFiles;
    if (!shellFiles && sid && p.files && typeof p.files.sub === 'function') shellFiles = p.files.sub(`shell/${sid}`);
    if (shellFiles) sources.push({ kind: 'shell', name: shellName(g, sid), files: shellFiles, descript: st && st.shell ? st.shell.descript : null });
    if (p.balloon && p.balloon.files) sources.push({ kind: 'balloon', name: p.balloon.name, files: p.balloon.files, descript: p.skin ? p.skin.descript : null });
    return { sources, version: VERSION };
  }

  /**
   * What OnGhostChanging / OnGhostChanged / OnGhostCalling say about a ghost: sakura name, name, folder path (EV §2.1
   * "Paths").
   */
  _ghostInfo(g, descript = null) {
    const d = descript instanceof Map ? descript : new Map();
    let path = '';
    try { path = urlPath(new URL(`ghost/${encodeURIComponent(g.id)}/`, this.base).href); } catch (e) { path = ''; }
    return { id: g.id, sakuraName: d.get('sakura.name') || g.sakuraName || '', name: d.get('name') || g.name || g.id, path };
  }

  /**
   * SSP's GetGhostIDFromTag for a script's \![change,ghost] [disasm 0x62A890]: whether `target` names a ghost the
   * change may go to, as _change resolves it: this ghost itself, or one not on screen in another slot (a ghost running
   * elsewhere and an unknown name are -1 [disasm 0x62A99E, 0x62A9C0]); `random` / `sequential` while one is left
   * (SSP's pick is among the ghosts not running [disasm GetGhostIDFromTagStatic 0x62A9F0]). Only then does SSP break
   * the script [disasm ExecuteChangeFromTag 0x62AEEA, BreakScript 0x62AF92] (EV §2.7.7).
   */
  _changeFinds(target, { byId = false } = {}) {
    if (!this.index) return false;
    const exclude = this.site.onScreen(this);
    return !!resolveGhostTarget(this.index.ghosts, this.ghost && this.ghost.id, target, { byId, exclude });
  }

  /**
   * A -> B (EV §2.5): B is checked first (an engine this runtime lacks: refused, A keeps running). A says goodbye
   * (EventLoop.farewell; a balloon break cancels), B's lock is taken, the choice is stored and announced to the other
   * tabs, A unloads (OnDestroy, engine save, state), then B cold-boots with OnGhostChanged. If B does not come up, A
   * comes back with a cold boot. From the farewell on, a page left meanwhile carries the change on (_onPageHide).
   * Until A's farewell is over (also while a page-load boot ends first), a change A's script asks for is refused, not
   * queued (_waitingTalk, _chainChange): the farewell waits for that script's end, which a shell or balloon change held
   * at its tag behind this one would never reach (EV §2.6 "Changes in a row"); the tags run in script order, and the
   * ghost change, asked first, ends A's changes as the loop's `changing` does when nothing was queued.
   * Several ghosts: refused during Quit and in a tab without the set's lead (Site._ownSet; from the closed launcher
   * or the tucked button the tab takes the lead and B boots cold; B failing there brings back the closed launcher's
   * A cold, or the tucked button with nothing booted, UI §9.11); past A's farewell (_committed) a bfcache restart
   * waits for its end.
   * A reload (\![reload,ghost], EV §2.10; the loop's reloadGhost) is a change to the ghost itself without its goodbye
   * and with a silent boot: ReloadGhost posts mode 6, which bypasses OnChangeMessage (no OnGhostChanging, no OnClose)
   * and whose bit 2 makes AddGhost skip the boot talk (no OnBoot, OnFirstBoot or OnGhostChanged) [disasm 0x6209e0,
   * 0x46c6e9–0x46c704, 0x466d08]. A page left meanwhile carries nothing: the next page resumes the ghost [decision].
   */
  async _change({ target, byId = false, reason = 'manual', raiseEvent = true, scope = 0, fromScript = false, reload = false }) {
    let prev, next, p, change = null, same = false, tuckedSet = null;
    this._waitingTalk = true;
    try {
      if (this._starting) await this._starting;
      if (!this.index) return false;
      // Quit closes every ghost (EV §2.3): no ghost boots in its slots meanwhile (one closed in it has no loop left)
      if (this.site.quitting) { log.info('Quit is under way; no ghost change'); return false; }
      prev = this.ghost;
      // a ghost on screen in another slot is never changed to (greyed in the menu, ignored by scripts; EV §2.7.2)
      next = resolveGhostTarget(this.index.ghosts, prev && prev.id, target, { byId, exclude: this.site.onScreen(this) });
      if (!next) { log.info(`no ghost "${target}" to change to`); return false; }
      // a change to this ghost itself goes through like any other: its goodbye, unload, a cold boot of the same ghost
      // and OnGhostChanged naming itself (ssp.exe 2.9.10: Change ghost ▸ keeps its own row enabled, OnChangeMessage
      // and GetGhostIDFromTag let the own id through, OnSSPSysMsgGhostChange unloads and loads it again [disasm
      // 0x49b9b7, 0x49720e, 0x62c738, 0x46bf60])
      same = !!prev && next.id === prev.id;
      if (reload && !same) return false;      // a reload names the ghost itself only
      const note = engineNote(next);
      if (note) { log.warn(`not changing to ${next.name || next.id}: it ${note}`); return false; }
      // several ghosts: the set changes only in the tab that runs it (UI §9.5). A tab without the lead (its ghosts
      // frozen) refuses and takes no lock [decision]; with no tab running the set (the site closed here) it takes the
      // lead and B boots cold
      if (!this.site._leading() && !(await this.site._ownSet())) { log.info('the ghosts run in another tab; no change here'); return false; }
      p = this.parts;
      // from the tucked button (UI §9.11; read after the set's start a tap began has ended): a failure brings that
      // button back with the stored set, never prev booted
      tuckedSet = prev && !p && this._launcherMode === 'tucked' ? this.site._keptSet(prev.id) : null;
      const running = !!(prev && p && p.loop && p.loop.booted && !p.loop.closed);
      // its shell name too: OnOtherGhostChanged R14 for the ghosts that stay (EV §2.7.2)
      const from = running ? { ...this._ghostInfo(prev, p.loop.descript), ...(this.site.multi ? { shell: this._shellNameOf(p.loop) } : {}) } : null;
      const pending = { to: next.id, from, script: null };
      if (reload && !running) return false;
      if (!reload) this._pending = pending;
      if (running && !reload) {
        const bye = await p.loop.farewell(this._ghostInfo(next), { reason, raiseEvent, scope, fromScript });
        if (!bye.ok) { this._pending = null; log.info('ghost change cancelled'); return false; }
        if (this.parts !== p) { this._pending = null; return false; }      // torn down meanwhile (bfcache restart)
        pending.script = bye.script;
        change = { ...pending.from, script: bye.script };
      }
    } finally {
      this._waitingTalk = false;      // B's boot script may queue its changes behind this one (EV §2.6)
    }
    // from here the change runs to its end in this slot (a bfcache restart waits for it: Site.restart)
    this._committed = true;
    // B's lock before A lets go of its own: no other tab boots B while A unloads (UI §9.5). A change to this ghost
    // itself keeps the lock it holds (a second request for the same name would wait on the first)
    const keep = same && this.lock ? this.lock : null;
    const lock = keep || this._newLock(next.id);
    if (!keep) {
      lock.on('takeover-request', () => this._onTakeoverRequest());
      await lock.acquire();
    }
    this.site._replaceInSet(this, prev ? prev.id : null, next.id);      // stored, and the other tabs follow
    if (p && p.loop) await p.loop.leave();
    // the slot was removed meanwhile: B's lock goes and nothing boots outside the slots
    if (this._removed) { lock.dispose(); if (keep) this.lock = null; return false; }
    this._teardown();
    this._clearFrozen();
    if (this.lock && this.lock !== lock) this.lock.dispose();
    this.lock = lock;
    this.ghost = next;
    if (this.launcher) { this.launcher.destroy(); this.launcher = null; }
    this.crashes = [];
    this._pending = null;           // B's _boot keeps it in the tab marker from here (no task runs in between)
    const outcome = await this.start({ cold: true, change, ghost: next.id, silent: reload });
    if (outcome === 'booted' || outcome === 'frozen') {
      this.emit('changed', { from: prev ? prev.id : null, to: next.id });
      return true;
    }
    log.error(`${next.name || next.id} did not start${prev && !tuckedSet ? `; ${prev.name || prev.id} comes back` : ''}`);
    if (tuckedSet) {
      // the tucked button again, the old set stored again, the marker cleared (B's failed boot may have named B), the
      // lead gone (Site._reclose): nothing of prev boots [decision]
      this._teardown();
      this._clearFrozen();
      if (this.lock) { this.lock.dispose(); this.lock = null; }
      this.ghost = prev;                  // _alignSlots keeps this slot for prev
      await this.site._reclose(tuckedSet, 'tucked');
      return false;
    }
    if (prev) {
      this.site._replaceInSet(this, next.id, prev.id);
      this._teardown();
      this._clearFrozen();
      if (this.lock) { this.lock.dispose(); this.lock = null; }
      await this.start({ cold: true, ghost: prev.id, silent: reload });
    }
    this.site._idleLead();            // nothing came up (a change from the closed launcher): the lead goes
    return false;
  }

  /**
   * Another tab changed this slot's ghost to `id` ({t:'ghost'} on the site channel, Site._onSiteMessage): follow it,
   * as SSP runs one ghost per site here (UI §9.5). A ghost running here is saved and unloaded like a takeover (no
   * OnClose); the new one is then shown frozen behind the tab that runs it. A change of this tab's own ghost is not
   * followed; a shell or balloon change under way here is finished first.
   */
  async _follow(id) {
    if (!this.index) return;
    // a shell or balloon change, and the script changes queued behind it (_chainChange), end first
    while ((this._changing && this._viewChanging) || (!this._changing && this._chainWaiting)) {
      await (this._changing || Promise.resolve()).catch(() => {});
    }
    if (this._changing) return;
    if (this._starting) await this._starting;
    if (this._changing || (this.ghost && this.ghost.id === id) || !this.index.ghost(id)) return;
    const p = this.parts;
    if (p && p.loop) { try { await p.loop.suspend(); } catch (e) { /* best effort */ } }
    this._teardown();
    this._clearFrozen();
    if (this.lock) { this.lock.dispose(); this.lock = null; }
    if (this.launcher) { this.launcher.destroy(); this.launcher = null; }
    this._launcherMode = null;
    await this.start({ ghost: id });
  }

  /** The shell name a loop reports (peerInfo; EV §2.7), '' when it cannot tell. */
  _shellNameOf(loop) {
    try { return (loop && typeof loop.peerInfo === 'function' && loop.peerInfo().shell) || ''; } catch (e) { return ''; }
  }

  /**
   * The tab running this ghost changed its shell ({t:'view'}, Site._onSiteMessage): a frozen stage here is drawn
   * again (_redrawFrozen); one still being built (_startFrozen) is redrawn once it exists (_viewMissed).
   */
  async _followView() {
    if (this.frozen) await this._redrawFrozen();
    else if (!this.parts) this._viewMissed = true;
  }

  _teardown({ keepState = false } = {}) {
    const p = this.parts;
    this.parts = null;
    if (!p) return;
    const quiet = (f) => { try { f(); } catch (e) { /* ignore */ } };
    if (p.loop) quiet(() => p.loop.destroy());
    if (p.player && p.player.destroy) quiet(() => p.player.destroy());
    if (p.menu) quiet(() => p.menu.destroy());
    if (p.scaling) quiet(() => p.scaling.destroy());
    if (p.dialogs && p.dialogs.destroy) quiet(() => p.dialogs.destroy());
    if (p.balloons) quiet(() => p.balloons.destroy());
    if (p.stage) quiet(() => p.stage.destroy());
    if (p.pageSaori) quiet(() => p.pageSaori.destroy());
    if (p.client) quiet(() => p.client.terminate());
    if (this.state && !keepState) quiet(() => this.state.dispose());
  }

  // ---------------------------------------------------------------- page lifecycle

  /**
   * pagehide (the Site calls each slot's): save the state and the engine's files, let the lock go; a change under way
   * is carried on (EV §2.5). The Site stores the idle clock after. With the storage hub and the page going into the
   * back/forward cache (platform.hub.hidden: core/hub.js _pageHide) the engine is not asked for its files: the save
   * would reach the hub after Back, over what another page stored meanwhile (the leave-flush stored them already).
   */
  _onPageHide() {
    const p = this.parts;
    if (this._pending) this._carryChange(this._pending, p);
    if (this.state && p && p.loop) this.state.saveNow();
    const hub = platform.hub;
    if (p && p.client && !(hub && hub.hidden)) p.client.persist().catch(() => {});
    // a page kept in the back/forward cache must not keep the ghost from the next page
    if (this.lock) this.lock.release();
  }

  /**
   * The page may be leaving (Site._leaveFlush, storage hub only: a link clicked, a form sent, beforeunload):
   * what _onPageHide writes, now, while the page's posts still reach the hub, and the lock kept; the state then writes
   * every change at once until the Site turns that off.
   */
  _onLeave() {
    const p = this.parts;
    if (this._pending) this._carryChange(this._pending, p);
    if (this.state && p && p.loop) { this.state.saveNow(); this.state.writeThrough(true); }
    if (p && p.client) p.client.persist().catch(() => {});
  }

  /**
   * The page goes during a change (A's farewell or unload): the change stands. The Site stores B as the choice and the
   * tab marker makes the next page cold-boot B with OnGhostChanged (R1: A's farewell so far), then tell the other tabs
   * (_start). A's state is saved without the farewell, so A never replays it.
   */
  _carryChange(ch, p) {
    const script = ch.script != null ? ch.script : (p && p.loop && typeof p.loop.changeScript === 'function' ? p.loop.changeScript() : '');
    this.site._carry(this, { id: ch.to, kind: 'change', change: ch.from ? { ...ch.from, script } : null });
  }
}

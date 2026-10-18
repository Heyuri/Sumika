// Site: what exists once per page, around the ghosts on screen (CONTRACTS "Site"; SSP's SPScriptPlayer, one SPGhost
// per ghost [disasm]): the site index, the UI language, the tab id, the idle clock, the site channel to the other
// tabs (UI §9.5), the page hooks, the tab marker and the stored set (SUM §2.5), the lead lock, the ghosts' layers and
// the keyboard owner, the launcher dock, the queue of set changes, the events between ghosts (EV §2.7), the visitor's
// user information and the Preferences box (UI §2.13, EV §4.16), the ghost lists of the property system
// (propsFor, properties.md) and the page API. Each ghost is a Runtime (runtime.js) in `slots`, which keeps everything
// it does by itself (engine, stage, lock, changes, frozen stage).
// Two configurations of the one class (CLAUDE.md "Code"): main.js builds a lead Site (several ghosts: `multi`); a
// Runtime made without a site gets an implicit one-ghost Site (lead: false, maxGhosts: 1) with the single-ghost
// behaviour (no lead lock, no layers, no peers; the marker and prefs gain only the v2 fields).
// Safe updates (CLAUDE.md "What gets published"): the Site holds the build's table of hashed runtime files
// (`runtimeFiles`, core/build.js) and staleCheck, the one way a page older than the published build recovers (a reload
// into it, at most once per tab per build).
// No import of runtime.js (no cycle): the page's Runtimes come from `createRuntime`.
import { log } from './log.js';
import { Emitter } from './emitter.js';
import { SiteIndex, siteUrls } from './loader.js';
import { loadWordList } from './words.js';
import { sessionMarker, InputClock, runtimePrefs, GhostLock, storedClosed } from './state.js';
import { platform, tabSession, channelClass } from './platform.js';
import { BUILD, FILES } from './build.js';
import { MidiEngine, midiPaths, midiSupported } from './midi.js';
import { sharedLanguage } from './language.js';
import {
  MAX_GHOSTS, LEAD_ID, chooseSet, siteClosed, resolveCallTarget, afterBootRefs, otherClosedRefs, otherChangedRefs,
  otherTalkRefs, diffSets, markerGhosts, markerCarry, markerRecord, markerQuit, communicateTargets, raiseTargets,
  isLastInstall,
} from './ghostset.js';
import { GhostLayers } from '../ui/layers.js';
import { SettingsWindow } from '../ui/settings.js';
import { setSiteBase } from '../ui/thumbnail.js';
import { sharedUser } from './user.js';
import { installedBalloons } from './shells.js';
import { indexGhostRecord, balloonRecord, settingsPage, VERSION } from './events.js';
import { engineSupported, engineNote, engineNeeds } from '../worker/engines/supported.js';

export const SITE_CHANNEL = 'sumika/runtime';   // BroadcastChannel: the other tabs follow the set and shell changes
/** sessionStorage: the build this tab reloaded away from (staleCheck's guard: one reload per tab per build) */
export const RELOADED_KEY = 'sumika.reloadedFrom';
/** How long a false staleCheck answer stands: a burst of failures asks once, a long-open tab asks again later. */
export const STALE_RECHECK_MS = 5 * 60 * 1000;
/** staleCheck's reasons that are a stored record newer than this page: the same build means a rollback (schema.js). */
const RECORD_REASONS = new Set(['state', 'prefs']);
/**
 * The storage hub's leave-flush: flushes closer together than this are one (a click and its beforeunload);
 * write-through ends this long after the last one when the page stayed, or at once when it is shown again (pageshow).
 */
export const LEAVE_DEDUPE_MS = 1000;
export const LEAVE_THROUGH_MS = 10000;

/**
 * The ghost to run: the one used last on this site, else the page's default, else the first one. With `supported`,
 * ghosts whose engine the runtime lacks are passed over while another one can run. "First" is the index's order, which
 * SiteIndex.load makes Change ghost ▸'s (SSP's name order): a page without data-default-ghost starts with the first
 * ghost by descript name, not the first folder.
 */
export function chooseGhost(index, { stored = null, defaultGhost = null, supported = () => true } = {}) {
  const ok = id => { const g = id ? index.ghost(id) : null; return g && supported(g) ? g : null; };
  return ok(stored) || ok(defaultGhost) || index.ghosts.find(g => supported(g)) || index.ghosts[0] || null;
}

const loopOf = rt => (rt && rt.parts && rt.parts.loop) || null;
const idOf = rt => (rt && rt.ghost && rt.ghost.id) || null;
const settled = p => Promise.resolve(p).then(() => {}, () => {});
const quiet = (what, f) => { try { return f(); } catch (e) { log.once(`site:${what}`, `${what} failed`, e); return undefined; } };
/** An async request to another ghost's loop: never rejects, never blocks the caller. */
const fireAndForget = (what, f) => { try { Promise.resolve(f()).catch(e => log.once(`site:${what}`, `${what} failed`, e)); } catch (e) { log.once(`site:${what}`, `${what} failed`, e); } };
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
const realClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h) };
/** What a start awaits once staleCheck answered true: the page reloads, and nothing of this start goes on. */
const never = () => new Promise(() => {});
/** `k` is stored as `v` in the tab's session: its confirm (core/platform.js tabSession: the hub's flush), else read back. */
const confirmed = async (ss, k, v) => {
  try { return typeof ss.confirm === 'function' ? (await ss.confirm(k, v)) === true : ss.get(k) === v; } catch (e) { return false; }
};
/**
 * A click that makes this document navigate: button 0 without a modifier, not prevented, on an <a href> or
 * <area href> (inside Sumika's shadow root too) with no `download`, targeting this document (empty, _self; _top or
 * _parent when it is the top), to an http(s) URL other than this one but its fragment.
 */
export function navigatingClick(ev, win) {
  if (!ev || ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return false;
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
  const a = path.find(n => n && typeof n.matches === 'function' && n.matches('a[href], area[href]'));
  if (!a || a.hasAttribute('download')) return false;
  const top = !!win && win.top === win;
  const t = String(a.getAttribute('target') || '').trim().toLowerCase();
  if (!(t === '' || t === '_self' || (top && (t === '_top' || t === '_parent')))) return false;
  let to, here;
  try {
    here = new URL(win.location.href);
    to = new URL(a.href, here);
  } catch (e) {
    return false;
  }
  if (to.protocol !== 'http:' && to.protocol !== 'https:') return false;
  // a fragment (even an empty one, href="#") to this very document scrolls, it does not navigate
  const bare = u => u.href.split('#')[0];
  return !(to.href.includes('#') && bare(to) === bare(here));
}
/**
 * How long the page's raises and talks wait for the start of a ghost up (Site.upWaitMs, _upSettled), from when it
 * counted as up: a resumed ghost whose load stalls with no error is then no target until it is up [decision: SSP has
 * no page change to wait for; 30 s, as a SHIORI request that takes longer counts as hung (shiori.js KILL_MS)].
 */
const UP_WAIT_MS = 30000;

export class Site extends Emitter {
  /**
   * @param {{base?:string, defaultGhost?:string|null, defaultBalloon?:string|null, runtimeUrl?:string,
   *   Channel?:Function|null, language?:object, lead?:boolean, maxGhosts?:number, createRuntime?:Function}} o
   *   Channel: the BroadcastChannel constructor for the site channel (tests; null = tabs do not follow changes);
   *   language: the UI language (core/language.js UiLanguage; default the page's shared one); lead: the tab that runs
   *   the set holds the lead lock 'sumika/lead' (UI §9.5; false with maxGhosts 1: the implicit one-ghost Site);
   *   maxGhosts: ghosts on screen at once (data-max-ghosts; default none, as SSP [observed]); createRuntime(opts): a
   *   Runtime for a slot; user: the visitor's user information (core/user.js UserProfile; default the page's shared
   *   one); phone: the page runs on a phone (core/phone.js phoneInfo: {short, long, mobileView}; absent on desktop:
   *   the desktop's layout); tucked: a start that would cold-boot the stored set in this tab shows her button instead
   *   (_tuckedStart, UI §9.11): main.js's decision (core/choice.js startState: data-phone="tucked" on a phone, or
   *   data-default-state="tucked" with no visitor choice, on any device, the desktop's layout there); with the storage
   *   hub main.js sets it once the visitor's choice is read, before the first start.
   *   With it the constructor makes slot 0 (no ghost yet, like a Runtime before start()), so window.sumika.runtime is
   *   never null.
   *   Safe updates: runtimeFiles: the table of hashed runtime files the Runtimes load (core/build.js FILES;
   *   null unbundled: the plain names, and staleCheck never reloads); build: the build this page runs (BUILD); fetch,
   *   reload, session, clock: staleCheck's fetch(), location.reload(), the tab's sessionStorage (core/platform.js
   *   tabSession: storage.js session, or the storage hub's) and the clock of its shared answer (also _upSettled's)
   *   (tests). The Channel default is resolved at the site channel's first use (core/platform.js channelClass: the
   *   storage hub's when the page has one), since this Site is made before the hub decides
   */
  constructor({ base, defaultGhost = null, defaultBalloon = null, runtimeUrl, Channel, language, user,
    lead = true, maxGhosts = MAX_GHOSTS, createRuntime = null, phone = null, tucked = false,
    runtimeFiles = FILES, build = BUILD, fetch: fetchFn = null, reload = null, session = null, clock = null } = {}) {
    super();
    this.base = base;
    this.defaultGhost = defaultGhost;
    this.defaultBalloon = defaultBalloon;
    this.runtimeUrl = runtimeUrl;
    this.runtimeFiles = runtimeFiles || null;
    this.build = build;
    this._fetch = typeof fetchFn === 'function' ? fetchFn : null;
    this._reload = typeof reload === 'function' ? reload : null;
    this._session = session || tabSession;
    this._stale = null;         // staleCheck's shared answer: {promise, at, answer}
    this._announced = false;    // the debug line naming the build, once per page (start)
    this.phone = phone || null;
    this.tucked = !!tucked;
    this.language = language || sharedLanguage();
    this.user = user || sharedUser();
    this._settings = null;      // the Preferences box (ui/settings.js), made at its first open (UI §2.13)
    this._wordList = null;      // SSP's word list, read at the first word no SHIORI answered (compatibleWords)
    this._midi = undefined;     // the page's MIDI engine, made at the first ask (midi)
    this.Channel = Channel;     // undefined: core/platform.js channelClass() at the site channel's first use
    this.tabId = Math.random().toString(36).slice(2);
    this.index = null;
    this.input = null;          // the idle clock (InputClock), made at the first boot: idle time is the visitor's
    this.sessionEpochMs = 0;    // the tab's first page (OnSecondChange R0), as the last boot wrote it in the marker
    this.slots = [];            // Runtime[], set order
    this.active = null;         // the ghost that took the keys last (EV §2.7; its loop may have let them go since)
    this.maxGhosts = Math.max(1, Math.floor(Number(maxGhosts)) || 1);   // Infinity: no cap
    // several ghosts (the lead Site main.js builds): layers, peers, the set; else the implicit one-ghost Site
    this.multi = !!lead || this.maxGhosts > 1;
    this.lead = null;           // GhostLock(LEAD_ID), made at the first start (multi)
    this.layers = this.multi ? new GhostLayers() : null;
    this.rev = 0;               // the last set revision written or applied here (prefs `rev`, set messages)
    this.quitting = false;      // Quit is closing every ghost (EV §2.3, §2.7)
    this._wantsLead = !!lead;
    this._channel = undefined;  // the site channel, made on first start
    this._pageHooks = false;
    this._starting = null;      // the set's start (multi)
    this._jobs = 0;             // set changes running or waiting (_mutate): calls and ghost changes
    this._tail = null;
    this._carries = {};         // ghost id -> what the next page must finish (marker v2 `carry`, EV §2.7)
    this._tab = new Set();      // ids this tab booted (the marker's `ghosts`: the next page resumes them)
    this._subst = new Map();    // slot -> the ghost a page left mid-change carries it to (_carry)
    this._leadAsked = false;    // another tab asked for the set while a change or start ran: answered after it
    this._yieldWhenHidden = false;
    this._yielding = null;
    this._waking = null;
    this._restarting = null;    // restart(): its teardown, then start()
    this._reconciling = null;
    this._raiseTail = null;     // \![raiseother] / \![notifyother] waiting their turn, one at a time (EV §2.7.9)
    this.clock = clock || realClock;    // what _upSettled waits on, and staleCheck's memo (tests: a FakeClock)
    this.upWaitMs = UP_WAIT_MS; // the longest a raise or talk waits for the start of a ghost up (_upSettled)
    this._indexLoad = null;     // SiteIndex.load in flight (_fetchIndex)
    this._hubSeen = false;      // the storage hub's decision was taken in (_hubDecided)
    this._storage = null;       // storageReady()'s wait for the storage hub's decision
    this._hubLost = false;      // the storage hub went away mid-page (_hubGone)
    this._leftAt = -Infinity;   // the last leave-flush (_leaveFlush)
    this._through = null;       // its write-through's end timer
    if (base) setSiteBase(base);      // site thumbnails on a page of another origin (ui/thumbnail.js)
    this._makeRuntime = typeof createRuntime === 'function' ? createRuntime : null;
    if (this._makeRuntime) this._adopt(this._createRuntime(this._runtimeOpts()));
  }

  /**
   * Start the page's ghosts. The implicit Site starts its one slot. A multi Site takes the lead lock and runs
   * the stored set (UI §9.5): resumed ghosts at once in parallel, cold ones one at a time in set order; without the
   * lead every ghost of the set shows frozen. Resolves with slot 0's outcome ('booted' when any ghost booted; at once
   * while the set already runs here; 'none' during Quit, whose end shows the launcher); never rejects. A tucked page
   * shows her button instead of a cold start of the set in this tab ('launcher'); untuck: its tap (_untuck), which
   * starts it. Runtime prefs a newer Sumika wrote ask staleCheck('prefs') first: a true answer reloads the page and
   * starts nothing (never settles); a false one starts as ever, the prefs read for what fits and never written.
   * With the storage hub (data-hub, core/hub.js) the first start waits for storageReady(): no read that
   * matters runs before its snapshot, and the page hooks bind to the decided storage.
   * @returns {Promise<'booted'|'frozen'|'launcher'|'failed'|'aborted'|'none'>}
   */
  start(o = {}) {
    const hub = platform.hub;
    if (hub && hub.state === 'pending') return this.storageReady().then(() => this.start(o));
    this._installPageHooks();
    if (!this._announced) { this._announced = true; log.debug(`sumika ${VERSION} build ${this.build}`); }
    if (runtimePrefs.newer()) return this.staleCheck('prefs').then(stale => (stale ? never() : this._begin(o)));
    return this._begin(o);
  }

  /** start() once the stored prefs are checked. */
  _begin({ cold = false, untuck = false } = {}) {
    if (!this.multi || (!this.slots.length && !this._makeRuntime)) {
      const rt = this.slots[0];
      return rt ? rt.start({ cold }) : Promise.resolve('none');
    }
    if (this._starting) return this._starting;
    if (this.quitting) { log.info('Quit is under way; its end shows the launcher'); return Promise.resolve('none'); }
    // the set runs here already (window.sumika.start() called again): nothing to start
    if (this.lead && this.lead.held && this.slots.some(rt => loopOf(rt) && !loopOf(rt).closed)) return Promise.resolve('booted');
    this._starting = this._startSet({ cold, untuck })
      .catch(e => { log.error('failed to start', e); return 'failed'; })
      .finally(() => { this._starting = null; this._answerLead(); });
    return this._starting;
  }

  /**
   * Tear every ghost down and start again (bfcache restore, debugging). Starts, and ghost changes past their farewell
   * (B's lock held, A unloading: Runtime._committed), end first in their own slots, so the set's start finds B there
   * (resumed, or cold with its carried change) instead of a second Runtime beside a frozen one (EV §2.5). A frozen
   * slot's wake meanwhile is ignored (_wake): the start takes the lead itself.
   */
  restart() {
    if (!this.multi) {
      const rt = this.slots[0];
      return rt ? rt.restart() : this.start();
    }
    if (this._restarting) return this._restarting;
    const down = (async () => {
      if (this._starting) await settled(this._starting);
      for (const rt of [...this.slots]) {
        if (rt._starting) await settled(rt._starting);
        if (rt._changing && rt._committed) await settled(rt._changing);
      }
      for (const rt of [...this.slots]) {
        rt._teardown();
        rt._clearFrozen();
        rt._up = false;
      }
      // a Quit under way went with its ghosts; the tab marker still says so, and the start goes on with it (_runSet)
      this.quitting = false;
    })();
    this._restarting = down.catch(e => log.warn('tearing the ghosts down failed', e))
      .finally(() => { this._restarting = null; })
      .then(() => this.start());
    return this._restarting;
  }

  /** The slot showing ghost `id`, or null. */
  find(id) {
    return this.slots.find(rt => idOf(rt) === id) || null;
  }

  /** The ghost the page API acts on when none is named: the one with the keys, else the first (SSP's GetPreferredActiveGhost [disasm]). */
  preferred() {
    return this.slots.find(rt => { const l = loopOf(rt); return l && l.active; }) || this.slots[0] || null;
  }

  /** The ids of the ghosts on screen in this page (frozen ones too, not the closed launcher's), but `except`'s. */
  onScreen(except = null) {
    return new Set(this.slots.filter(rt => rt !== except && !this._shut(rt)).map(idOf).filter(Boolean));
  }

  /**
   * The site's ghosts for Change ghost ▸ of rt's menu, in the index's order (SiteIndex.load: SSP's name order, ties by
   * folder): {id, name, current, note, needs, elsewhere?, thumbnails?} (note: why it cannot run here, else null;
   * needs: the engine it lacks, which the menu words in the UI language; elsewhere: on screen in another slot, greyed
   * [disasm]; thumbnails: its thumbnail URLs, when it has any).
   */
  ghostList(rt = this.slots[0] || null) {
    const cur = idOf(rt);
    const others = this.onScreen(rt);
    return ((this.index && this.index.ghosts) || []).map(g => {
      const thumbs = this._thumbUrls(g);
      return {
        id: g.id, name: g.name || g.id, current: g.id === cur, note: engineNote(g), needs: engineNeeds(g),
        ...(others.has(g.id) ? { elsewhere: true } : {}),
        ...(thumbs.length ? { thumbnails: thumbs } : {}),
      };
    });
  }

  /**
   * A ghost's thumbnails (ghosts.json `thumbnails`, site paths) as URLs, for the menu's thumbnail window (UI §2.14):
   * each with the index's `?v=` (loadThumbnail fetches them).
   */
  _thumbUrls(g) {
    return siteUrls(this.base, g && g.thumbnails, this.index && this.index.versions);
  }

  /**
   * Call ghost ▸ of rt's menu (UI §2.12): ghostList's rows, and while a site cap is reached `full` = maxGhosts on each
   * (the menu greys the rest with "up to {n} at once"; no cap by default). null when one ghost at a time: no submenu.
   */
  callList(rt = this.slots[0] || null) {
    if (!this.multi || this.maxGhosts <= 1) return null;
    const full = this._count() >= this.maxGhosts;
    return this.ghostList(rt).map(r => (full ? { ...r, full: this.maxGhosts } : r));
  }

  /** The page API's ghosts(): every site ghost with current (the preferred slot's), running (on screen here) and active. */
  siteGhosts() {
    const cur = idOf(this.preferred());
    return ((this.index && this.index.ghosts) || []).map(g => {
      const rt = this.find(g.id);
      const l = loopOf(rt);
      return { id: g.id, name: g.name || g.id, current: g.id === cur, running: this._shown(rt), active: !!(l && l.active), note: engineNote(g), needs: engineNeeds(g) };
    });
  }

  /** The ghosts on screen (running, or frozen behind another tab; not a closed one's launcher), set order: [{id, name, active}]. */
  running() {
    return this.slots.filter(rt => this._shown(rt)).map(rt => {
      const l = loopOf(rt);
      return { id: rt.ghost.id, name: rt.ghost.name || rt.ghost.id, active: !!(l && l.active) };
    });
  }

  /**
   * The event loop's handle on the other ghosts (EV §2.7): others() = every other slot that counts as up (from its
   * NOTIFY batch, a resumed one from the start, a closing one included) as peerInfo() objects; count() = ghosts on
   * screen in this tab, rt included, booting or booted and not closed (Close vs Quit); busy() = a call or a ghost change
   * runs or waits; match(to) = the ids a response's `To` / `Reference0` names among the other ghosts a talk can reach
   * (_liveSlot; ghostset.js communicateTargets, EV §2.7.7). null for the implicit Site: the loop is alone.
   */
  peersFor(rt) {
    if (!this.multi) return null;
    return {
      others: () => this.slots.filter(s => s !== rt && s._up && s.ghost && !s.frozen).map(s => this._peerOf(s)),
      count: () => this.slots.filter(s => this._running(s)).length,
      busy: () => this._jobs > 0,
      match: to => {
        const live = this.slots.filter(s => s !== rt && this._liveSlot(s));
        return communicateTargets(live.map(s => this._peerOf(s)), to);
      },
    };
  }

  /**
   * The event loop's handle for the property system (properties.md §1, §5.2), in both configurations: ghosts() =
   * ghostlist, the site index's ghosts in its order (Change ghost ▸'s), a ghost up in this tab as its loop's
   * propRecord() (with `live`), the others from the index (indexGhostRecord); active() = activeghostlist, the slots up
   * here in set order (rt itself, and every other slot that counts as up: its loop neither closed nor frozen), each its
   * loop's propRecord(); balloons() = balloonlist, rt's installed balloons (shells.js installedBalloons, Balloon ▸'s
   * list) with their site paths; openSettings(page) = \![open,con…] (openSettings).
   */
  propsFor(rt) {
    const up = s => {
      const l = loopOf(s);
      return l && !l.closed && !l.frozen && (s === rt || s._up) ? l : null;
    };
    const rec = l => quiet('propRecord', () => l.propRecord()) || null;
    return {
      ghosts: () => ((this.index && this.index.ghosts) || []).map(g => {
        const s = this.slots.find(x => idOf(x) === g.id && up(x));
        return (s && rec(loopOf(s))) || indexGhostRecord(g, this._basePath());
      }),
      active: () => this.slots.map(up).filter(Boolean).map(rec).filter(Boolean),
      balloons: () => installedBalloons(this.index, rt.ghost).map(b => balloonRecord(b, this._basePath())),
      openSettings: page => this.openSettings(page),
    };
  }

  /**
   * SSP's word list for the word variables no SHIORI answers (core/words.js, properties.md §2.4): the site's
   * `sumika/word_compatible.txt`, read at the first ask and kept for the page, as ssp.exe reads its data file once
   * (one that is missing stays missing for the page, where ssp.exe would look again [decision]). Read only through the
   * page window's fetch: none in Node (tests, the sweep), so null there.
   * @returns {Promise<{name: string, words: string[]}[]|null>}
   */
  compatibleWords() {
    if (!this._wordList) {
      const win = typeof window !== 'undefined' ? window : null;
      this._wordList = loadWordList(this.base, win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
    }
    return this._wordList;
  }

  /**
   * The page's MIDI engine (core/midi.js; CLAUDE.md "MIDI"), one for every ghost of the page (one AudioContext, Worker
   * and worklet module), made at the first ask; making it loads nothing. null without the build's MIDI files
   * (runtimeFiles `midi`: unbundled tests, site/dev, the sweep) or where the player cannot run (midiSupported: no
   * AudioWorklet, not a secure context): MIDI files then go to <audio> (OnSoundError 14020, a silent box).
   * @returns {MidiEngine|null}
   */
  get midi() {
    if (this._midi === undefined) {
      this._midi = null;
      const paths = midiPaths(this.runtimeFiles);
      if (paths && midiSupported()) {
        try {
          this._midi = new MidiEngine({ runtimeUrl: this.runtimeUrl, paths });
        } catch (e) {
          log.once('midi-engine', 'MIDI: cannot set up the player', e);
        }
      }
    }
    return this._midi;
  }

  /** The site's path, '/'-ended: the base URL's path (EV §2.1 "Paths"); '/' without one. */
  _basePath() {
    try {
      const p = new URL(this.base).pathname;
      return p.endsWith('/') ? p : `${p}/`;
    } catch (e) {
      return '/';
    }
  }

  /**
   * The Preferences box (UI §2.13): \![open,con…,page] and Options ▸ Preferences…. No page, `setup` or a word that is no
   * page type open it (settingsPage; Sumika's last page is always General); SSP's other page types open nothing and
   * are logged once [decision]. One box per page, made at the first open; a second open brings it to the front.
   * Closing it after an edit sends OnNotifyUserInfo to every ghost up (notifyUserInfo). Returns whether it opened.
   * @param {string} [page]
   */
  openSettings(page = '') {
    const p = page == null ? '' : String(page);
    if (!settingsPage(p)) {
      log.once(`settings-page:${p.toLowerCase()}`, `\\![open,configurationdialog,${p}]: Sumika has no box for this page`);
      return false;
    }
    if (!this._settings) {
      this._settings = new SettingsWindow({
        user: this.user, language: this.language,
        onClose: ({ touched } = {}) => { if (touched) this.notifyUserInfo(); },
        ...(this.phone ? { phone: this.phone } : {}),      // phones: above the on-screen keyboard (UI §9.11)
      });
    }
    this._settings.open();
    return true;
  }

  /**
   * NOTIFY OnNotifyUserInfo to every ghost of this page that is booted and neither closed nor frozen (EV §4.16), as
   * ssp.exe tells every running ghost when its General page closes after an edit [disasm 0x46b478].
   */
  notifyUserInfo() {
    for (const rt of this.slots) {
      const l = loopOf(rt);
      if (l && l.booted && !l.closed && !l.frozen) fireAndForget('notifyUserInfo', () => l.notifyUserInfo());
    }
  }

  /**
   * A call (Call ghost ▸, \![call,ghost], the page API; EV §2.7): queued behind other set changes. The
   * target is resolved when its turn comes (resolveCallTarget: a ghost on screen, unknown or not runnable is ignored),
   * a site cap holds. With raiseEvent the caller gets OnGhostCalling first (its reply is OnGhostCalled's R1);
   * then the set is stored with the callee, its slot made on top, and it cold-boots with OnGhostCalled (OnFirstBoot
   * for a ghost never met). The after-boot events follow its boot script (_onBooted). Resolves true when it booted.
   * Only in the tab that runs the set (_ownSet): a tab without the lead writes nothing (false); with the site closed
   * here it takes the lead, and the callee replaces the closed launcher, alone (a failure brings the launcher back).
   * @param {object|null} from the calling Runtime (null: the page API with no ghost up: a plain cold boot, OnBoot)
   * @param {{target:string, byId?:boolean, raiseEvent?:boolean, reason?:string, scope?:number, fromScript?:boolean,
   *   script?:string}} req the loop's 'call' event
   * @returns {Promise<boolean>}
   */
  call(from, req = {}) {
    if (!this.multi || this.maxGhosts <= 1) {
      log.info('this page runs one ghost at a time; no call');
      return Promise.resolve(false);
    }
    return this._mutate('call', () => this._call(from, req)).catch(e => { log.error('the call failed', e); return false; });
  }

  /**
   * Quit (EV §2.3, §2.7): every ghost says goodbye at once (OnCloseAll -> OnClose, each closing at its own
   * script's end), no OnOtherGhostClosed, the stored set is kept and the closed launcher calls it back. false while a
   * call or ghost change runs or waits, or a ghost still boots (SSP beeps [disasm OnMenuExit]). The tab marker says so
   * until the site closes (a page left meanwhile goes on with it, _runSet); a takeover waits for its end (_busyHere).
   * Every ghost gets R1 `scope` (the menu's character) and R2 `window` (the clicked one, default the same) [disasm
   * 2.9.10 CCWC_OnCommand 0x41d4ca; UI §2.1 notes].
   */
  async quit(scope = 0, window = scope) {
    if (!this.multi) {
      const l = loopOf(this.slots[0]);
      if (!l) return false;
      await l.close(scope, { all: true, window });
      return true;
    }
    // a ghost still booting (a takeover) would never close: refused like a call or change under way (SSP beeps)
    if (this._jobs || this.quitting || this._starting || this._waking || this.slots.some(rt => rt._starting)) return false;
    const live = this.slots.filter(rt => { const l = loopOf(rt); return l && l.booted && !l.closed; });
    if (!live.length) return false;
    this.quitting = true;
    this._markTab();          // a page left during the goodbyes goes on with this Quit (_runSet, markerQuit)
    await Promise.all(live.map(rt => settled(loopOf(rt).close(scope, { all: true, window }))));
    // every loop refused (nothing is closing): no Quit under way
    if (this.quitting && !this.slots.some(rt => { const l = loopOf(rt); return l && (l.closing || l.closed); }) && this.slots.some(rt => loopOf(rt))) {
      this.quitting = false;
      this._markTab();
      this._answerLead();
    }
    return true;
  }

  // ---------------------------------------------------------------- page API (window.sumika, main.js)

  /**
   * Like Call ghost ▸ from `from` (default: the preferred ghost). Resolves true when the callee booted. A `from` not
   * on screen here: false (as changeGhost). No booted caller (the site closed here): a plain cold boot (call(null)).
   */
  callGhost(id, { from = null, ...o } = {}) {
    const caller = from ? this.find(from) : this.preferred();
    if (from && !caller) { log.info(`no ghost "${from}" on screen to call from`); return Promise.resolve(false); }
    const l = loopOf(caller);
    if (l && (!l.booted || l.closed || l.closing || l.changing || l.frozen)) return Promise.resolve(false);
    return this.call(l ? caller : null, { target: id, byId: true, raiseEvent: true, reason: 'manual', scope: 0, ...o, fromScript: false });
  }

  /** Like that ghost's Close (default: the preferred one); the last ghost's Close is Quit. True when it is closing. */
  async closeGhost(id = null, scope = 0) {
    const l = loopOf(id ? this.find(id) : this.preferred());
    if (!l || !l.booted || l.closed || l.closing) return false;
    await l.close(scope);
    return !!(l.closing || l.closed);
  }

  /** Like Change ghost ▸ of `from` (default: the preferred ghost). Resolves true when it changed. */
  changeGhost(id, { from = null, ...o } = {}) {
    const rt = from ? this.find(from) : this.preferred();
    return rt ? rt.changeGhost(id, o) : Promise.resolve(false);
  }

  shells({ ghost = null } = {}) { const rt = ghost ? this.find(ghost) : this.preferred(); return rt ? rt.shellList() : []; }
  balloons({ ghost = null } = {}) { const rt = ghost ? this.find(ghost) : this.preferred(); return rt ? rt.balloonList() : { top: [], all: [] }; }
  changeShell(target, { ghost = null, ...o } = {}) { const rt = ghost ? this.find(ghost) : this.preferred(); return rt ? rt.changeShell(target, o) : Promise.resolve(false); }
  changeBalloon(target, { ghost = null, ...o } = {}) { const rt = ghost ? this.find(ghost) : this.preferred(); return rt ? rt.changeBalloon(target, o) : Promise.resolve(false); }

  // ---------------------------------------------------------------- called by Runtime

  /** A Runtime joins the page (once; its constructor calls this). */
  _adopt(rt) {
    if (rt && !this.slots.includes(rt)) this.slots.push(rt);
    return rt;
  }

  /**
   * The site index, loaded once (SUM §2.8). An index newer than this runtime (loader.js 'index-newer') asks
   * staleCheck first: a true answer reloads the page and never settles; a false one rejects, so no ghost starts.
   */
  async _loadIndex() {
    if (!this.index) {
      try {
        this.index = await this._fetchIndex();
      } catch (e) {
        this._indexLoad = null;
        if (e && e.code === 'index-newer' && await this.staleCheck('index-newer')) return never();
        throw e;
      }
    }
    return this.index;
  }

  /** SiteIndex.load, one in flight (a start waiting for the storage hub loads it meanwhile). */
  _fetchIndex() {
    if (!this._indexLoad) this._indexLoad = SiteIndex.load(this.base);
    return this._indexLoad;
  }

  /** The idle clock, made once (EV OnSecondChange idle time is the visitor's, not a ghost's). */
  _ensureInput() {
    if (!this.input) { this.input = new InputClock(); this.input.bindPage(); }
    return this.input;
  }

  /**
   * The ghost rt runs when nothing names one (implicit: the stored set's first ghost, else the page's default; a
   * multi slot: its own ghost, else its place in the stored set).
   */
  _chooseFor(rt) {
    const own = this.multi && rt && rt.ghost ? this.index.ghost(rt.ghost.id) : null;
    if (own) return own;
    const set = this._storedSet(runtimePrefs.get(), this.multi ? this.maxGhosts : 1);
    const i = this.multi ? Math.max(0, this.slots.indexOf(rt)) : 0;
    return set[i] || set[0] || null;
  }

  /** The tab marker names ghost `id` (this tab ran it: the next page resumes it, SUM §2.5). */
  _inMarker(id) {
    return markerGhosts(sessionMarker.read()).includes(id);
  }

  /**
   * What the last page left unfinished for ghost `id` (EV §2.5, §2.7; the marker's `carry`, v1 `pending`):
   * {kind: 'change', change} (B has not sent OnGhostChanged), {kind: 'call', call, caller} (the callee has not sent
   * OnGhostCalled), {kind: 'after', …} (an after-boot event still owed), else null.
   */
  _carried(id) {
    if (!this.multi) return markerCarry(sessionMarker.read())[id] || null;
    return this._carries[id] || null;
  }

  /** A multi Site that does not hold the lead never takes a ghost lock: its slots show frozen (UI §9.5). */
  _frozenOnly(rt) {
    return this.multi && !(this.lead && this.lead.held);
  }

  /** rt's slot shows `rt.ghost` now: its layer (made at its first start, on top) is labelled with it (never a removed slot's). */
  _labelSlot(rt) {
    if (!this.layers || !rt || !rt.ghost || rt._removed) return;
    if (!this.layers.has(rt.sid)) rt.layer = this.layers.create(rt.sid, { ghost: rt.ghost.id });
    else this.layers.setGhost(rt.sid, rt.ghost.id);
  }

  /**
   * rt's boot starts (after its resume decision): the tab marker names its ghost, keeping a change or a call pending
   * until OnGhostChanged / OnGhostCalled is sent (a page left first carries it on). sessionEpochMs: the marker's, else
   * `now` (the tab's first page). The implicit Site also stores the choice ({ghost, ghosts: [ghost], rev}).
   * @param {{change?: object|null, call?: object|null, now?: number, resume?: boolean}} o
   */
  _onBooting(rt, { change = null, call = null, now = Date.now(), resume = false } = {}) {
    const m = sessionMarker.read();
    this.sessionEpochMs = (m && m.sessionEpochMs) || now;
    const id = rt.ghost.id;
    if (!this.multi) {
      sessionMarker.write(markerRecord({ ghosts: [id], sessionEpochMs: this.sessionEpochMs, carry: change ? { [id]: { kind: 'change', change } } : {} }));
      this._storeOne(id);
      return;
    }
    this._tab.add(id);
    this._subst.delete(rt);
    const c = this._carries[id];
    if (change) this._carries[id] = { kind: 'change', change };
    else if (call) this._carries[id] = { kind: 'call', call, caller: c && c.kind === 'call' ? c.caller : null };
    else if (c && !(resume && c.kind === 'after')) delete this._carries[id];
    this._markTab();
  }

  /** The implicit Site's stored choice: {ghost, ghosts: [ghost], rev} (rev + 1 when it changes). */
  _storeOne(id) {
    const p = runtimePrefs.get();
    if (p.ghost === id && sameList(p.ghosts, [id]) && Number.isInteger(p.rev)) return;
    this.rev = Math.max(this.rev, Number(p.rev) | 0) + 1;
    runtimePrefs.set({ ghost: id, ghosts: [id], rev: this.rev });
  }

  /**
   * rt's NOTIFY batch went out (its 'notified'): it counts as up from now (otherghostname and the FMO list it, and the
   * raises and talks wait for its start: _upSettled). The others hear of a cold-booting one after its boot GET
   * (_onBooted).
   */
  _onNotified(rt) {
    this._markUp(rt);
  }

  /** rt counts as up (EV §2.7.5); `_upSince`: since when, for _upSettled's bound. */
  _markUp(rt) {
    if (!rt._up) rt._upSince = this.clock.now();
    rt._up = true;
  }

  /**
   * rt's shell changed (Runtime._swapShell, after OnShellChanged): every ghost up here, rt included, NOTIFYs
   * otherghostname again, as ChangeOrReloadShellInternal posts UpdateSakuraFileMapping with flag 8 at its end [disasm
   * 0x62177D–0x62178D], so the names in effect (a shell's `sakura.name`) and the surfaces follow (EV §2.7.5).
   */
  _onShellChanged(rt) {
    if (!this.multi || !rt) return;
    this._renotify();
  }

  /**
   * rt's ghost booted (its boot events sent; EV §2.7): a change or call is no longer pending in the marker. A cold boot
   * (a call and a change too, not a resume) makes every ghost up re-NOTIFY otherghostname (EV §2.7.5), rt included:
   * SSP's AddGhost posts it (UpdateSakuraFileMapping with flag 8 and no ghost to leave out [disasm 0x465C40–0x465C4F,
   * 0x733024–0x733051]), then asks the boot event (TalkBootMessage, synchronous [disasm 0x465CA3, 0x640C1C]) before
   * SSP reads its messages, so each NOTIFY comes after the boot GET (EV §2.7.5). A called ghost owes
   * OnGhostCallComplete (to the caller) / OnOtherGhostBooted (to the others), a changed-to ghost with others on screen
   * OnOtherGhostChanged: sent when its boot run ends and the set has settled (_owe); a resumed ghost finishes what the
   * last page owed. A ghost just called, changed to or reloaded (\![reload,ghost], EV §2.10: AddGhost activates its
   * windows [disasm 0x466dc7]; it owes no OnOther* event [disasm 0x49a7b8]) comes above the others.
   * @param {{resume?: boolean, run?: object|null, change?: object|null, call?: object|null, reload?: boolean}} o run:
   *   the boot run
   */
  _onBooted(rt, { resume = false, run = null, change = null, call = null, reload = false } = {}) {
    const id = rt.ghost.id;
    if (!this.multi) {
      if (change) sessionMarker.write(markerRecord({ ghosts: [id], sessionEpochMs: this.sessionEpochMs }));
      return;
    }
    if (!resume) this._renotify();
    const c = this._carries[id];
    let owed = null;
    if (resume) owed = c && c.kind === 'after' ? c : null;
    else if (call || (c && c.kind === 'call')) owed = { kind: 'after', of: 'call', caller: (c && c.caller) || null };
    else if (change && this.slots.some(s => s !== rt && loopOf(s))) {
      owed = { kind: 'after', of: 'change', prev: { sakuraName: change.sakuraName || '', name: change.name || '', shell: change.shell || '', script: change.script || '' } };
    }
    if (owed) this._carries[id] = owed;
    else delete this._carries[id];
    this._markTab();
    if (change || call || reload) this._raise(rt);
    if (owed) this._owe(rt, owed, resume ? (loopOf(rt) && loopOf(rt).current) || null : run);
    // a Quit went on from the last page (_runSet): the replayed goodbye closes it at its end, nothing replayed at once
    // (after its boot has wired the views: a microtask later)
    const l = loopOf(rt);
    if (resume && this.quitting && l && typeof l.resumeClose === 'function') {
      Promise.resolve().then(() => { if (loopOf(rt) === l) return l.resumeClose(); return undefined; })
        .catch(e => log.once('site:resumeClose', 'resumeClose failed', e));
    }
  }

  /** The keys went to rt's ghost (its loop's 'activate'): every other ghost lets them go, and rt comes on top (UI §3.5). */
  _onActivate(rt) {
    this.active = rt;
    if (!this.multi) return;
    for (const s of this.slots) {
      const l = loopOf(s);
      if (s !== rt && l && l.active) l.deactivate();
    }
    this._raise(rt);
  }

  /**
   * OnOtherGhostTalk (EV §2.7.4): rt's loop starts ('before') or ended ('after') a run; every other ghost that asked
   * with \![set,otherghosttalk] for that phase hears it (otherEvent: only while it is peerLive). The loop leaves out
   * replays, and 'before' for a reply to OnOtherGhostTalk itself (SSP's only guard [disasm 0x6397A2]).
   */
  _onTalk(rt, { phase, run, flags = '' } = {}) {
    if (!this.multi || !run) return;
    const talker = loopOf(rt);
    if (!talker) return;
    let refs = null;
    for (const s of this.slots) {
      const l = loopOf(s);
      if (s === rt || !l || !l.otherGhostTalk || !l.otherGhostTalk[phase]) continue;
      refs = refs || otherTalkRefs(talker.peerInfo(), run, flags);
      fireAndForget('OnOtherGhostTalk', () => l.otherEvent('OnOtherGhostTalk', refs));
    }
  }

  /**
   * COMMUNICATE (EV §2.7.7): rt's run that carried a talk to other ghosts ended un-broken (its loop's 'communicate').
   * Once the ghosts up have started (_upSettled), each target id in order, one at a time (SSP's
   * SPCommunicateData::Send [disasm 0x5EA920]: synchronous, results ignored, no failure event): the slot showing that
   * ghost gets OnCommunicate (its loop's communicated()) while it is _liveSlot; an id no longer on screen, or the
   * sender, is skipped. Duplicates are sent twice. The implicit Site has no other ghost.
   * @param {{communicate?: {ids: string[]}}} ev c: events.js Communicate
   */
  async _onCommunicate(rt, { communicate: c = null } = {}) {
    if (!this.multi || !c || !Array.isArray(c.ids) || !c.ids.length) return;
    await this._upSettled();
    for (const id of c.ids) {
      const s = typeof id === 'string' ? this.find(id) : null;
      const l = loopOf(s);
      if (!s || s === rt || !this._liveSlot(s) || typeof l.communicated !== 'function') continue;
      try { await l.communicated(c); } catch (e) { log.once('site:OnCommunicate', 'OnCommunicate failed', e); }
    }
  }

  /**
   * \![raiseother] / \![notifyother] and their timer forms (EV §2.7.9): rt's loop asked ('raiseother'). The raiser's
   * script does not wait; the raises of the page run one at a time in the order asked (SSP posts each to its main
   * thread [disasm 0x6333F5; FIFO infer]). Resolves when this one is done; never rejects.
   * @param {{ghost?: string, id?: string, refs?: string[], notify?: boolean, live?: () => boolean,
   *   done?: () => void}} ev ghost: undefined for a bare \![raiseother] (C2); live / done: a repeating timer's fire
   *   (EventLoop.raiseOther)
   */
  _onRaiseOther(rt, ev = {}) {
    const raiser = loopOf(rt);            // now: a ghost change in rt's slot later must not hear this one's failure
    const e = ev || {};
    const job = () => this._raiseOther(rt, raiser, e);
    const p = (this._raiseTail || Promise.resolve()).then(job)
      .catch(err => log.once('site:raiseother', 'raiseother failed', err))
      .finally(() => { if (typeof e.done === 'function') quiet('raiseother done', () => e.done()); });
    this._raiseTail = p;
    return p;
  }

  /**
   * One raise (EV §2.7.9) [disasm ExecuteRaiseReal 0x633430], once the ghosts up have started (_upSettled); a
   * repeating timer's fire whose timer went meanwhile (`live` false) is dropped. Candidates: the raiser and
   * every other _liveSlot (the implicit Site: the raiser alone), in set order; the raiser's own state is not checked
   * (SSP's is not), so a raiser that closed right after its tag still raises. Arguments (C2): no ghost → failure
   * [`invalid`]; an empty event → failure [`invalid` when the ghost argument names a candidate (or is `random` /
   * `lastinstall…`), else `notfound`; the ghost argument] [disasm 0x634153–0x6342C7]. Targets (C3, ghostset.js
   * raiseTargets); none → failure [`notfound`, the ghost argument, …]. Per target in order (C4): the raiser is skipped
   * silently; a locked one (its loop's lockReason: `timecritical`, `inductionmode`, `passivemode`, `minimized`) fails
   * with that reason; else GET (raise; its reply plays there) or NOTIFY (notify) with `Sender: <raiser's sakura
   * name>` (raisedByOther), and a GET without a script fails with that response's status (`204` …). Any failure: one
   * GET OnRaiseOtherFailure / OnNotifyOtherFailure to the raiser (C7) [the reasons, the failed ghosts' sakura names
   * (both \x01-joined), the event, its References], SenderType `internal,raise`; its reply plays on the raiser
   * (notifyEvent refuses a raiser closed or changed meanwhile [decision]).
   */
  async _raiseOther(rt, raiser, { ghost, id = '', refs = [], notify = false, live = null } = {}) {
    await this._upSettled();
    if (typeof live === 'function' && !quiet('raiseother live', () => live())) return;
    const ev = String(id ?? '');
    const list = Array.isArray(refs) ? refs.map(r => (r == null ? '' : String(r))) : [];
    // the raiser's own loop names it, torn down meanwhile too (its peerInfo() makes no view on a dead stage); rt's slot
    // may show another ghost by now
    const info = raiser && typeof raiser.peerInfo === 'function' ? quiet('peerInfo', () => raiser.peerInfo()) : null;
    const me = info || this._peerOf(rt);
    // the raiser in its place (a slot showing its ghost again since, after a restart, is the raiser), the others it can
    // reach before and after it (set order)
    const cands = [];
    for (const s of this.slots) {
      if (raiser ? loopOf(s) === raiser || (!!me.id && idOf(s) === me.id) : s === rt) cands.push({ ...me, self: true });
      else if (this.multi && this._liveSlot(s)) cands.push({ ...this._peerOf(s), slot: s });
    }
    if (!cands.some(c => c.self)) cands.unshift({ ...me, self: true });
    const random = () => this._random();
    let out = null;                                  // the failure event's References; null: none
    if (ghost === undefined || ghost === null) out = ['invalid'];
    else if (!ev) {
      const g = String(ghost);
      out = [isLastInstall(g) || raiseTargets(cands, g, { random }).length ? 'invalid' : 'notfound', g];
    } else {
      const g = String(ghost);
      const byId = new Map(cands.map(c => [c.id, c]));
      const targets = raiseTargets(cands, g, { random }).map(t => byId.get(t)).filter(Boolean);
      const failed = targets.length ? [] : [['notfound', g]];
      for (const c of targets) {
        // the raiser; a ghost gone or changed while an earlier target answered [decision: SSP keeps its ghost list
        // locked through the loop]
        if (c.self || !this._liveSlot(c.slot)) continue;
        const l = loopOf(c.slot);
        let why = l.lockReason || '';
        if (!why) {
          let r;
          try {
            r = await l.raisedByOther(ev, list, { notify: !!notify, sender: me.sakuraName || '' });
          } catch (e) {
            log.once('site:raisedByOther', 'raisedByOther failed', e);
            continue;
          }
          if (!r || !r.ok) why = String((r && r.status) ?? 0);
        }
        if (why) failed.push([String(why), this._peerOf(c.slot).sakuraName || '']);
      }
      if (failed.length) out = [failed.map(f => f[0]).join('\x01'), failed.map(f => f[1]).join('\x01'), ev, ...list];
    }
    if (!out || !raiser || typeof raiser.notifyEvent !== 'function') return;
    const fail = notify ? 'OnNotifyOtherFailure' : 'OnRaiseOtherFailure';
    await settled(raiser.notifyEvent(fail, out, { senderType: 'internal,raise' }));
  }

  /**
   * rt's slot now runs `toId` instead of `fromId` (a ghost change, or its failure): stored in rt's place and told to
   * the other tabs ({t:'set', cause: change}).
   */
  _replaceInSet(rt, fromId, toId) {
    if (!this.multi) {
      this.rev = Math.max(this.rev, Number(runtimePrefs.get().rev) | 0) + 1;
      runtimePrefs.set({ ghost: toId, ghosts: [toId], rev: this.rev });
      this._post({ t: 'set', ghosts: [toId], rev: this.rev, cause: { kind: 'change', from: fromId, to: toId } });
      return;
    }
    if (fromId && fromId !== toId) { this._tab.delete(fromId); delete this._carries[fromId]; }
    this._subst.delete(rt);
    if (this.layers && this.layers.has(rt.sid)) this.layers.setGhost(rt.sid, toId);
    const ids = this.slots.map(s => (s === rt ? toId : this._slotId(s))).filter(Boolean);
    this._writeSet({ kind: 'change', from: fromId, to: toId }, { ids });
  }

  /**
   * The page goes during rt's change (Runtime._onPageHide, EV §2.5): entry {id, kind: 'change', change} = the ghost
   * changed to and OnGhostChanged's previous ghost (or null). The stored set has `id` in rt's place and the marker makes
   * the next page cold-boot it with OnGhostChanged.
   */
  _carry(rt, { id, kind = 'change', change = null } = {}) {
    if (kind !== 'change' || !id) return;
    if (!this.multi) {
      this.rev = Math.max(this.rev, Number(runtimePrefs.get().rev) | 0) + 1;
      runtimePrefs.set({ ghost: id, ghosts: [id], rev: this.rev });
      const m = sessionMarker.read();
      sessionMarker.write(markerRecord({ ghosts: [id], sessionEpochMs: (m && m.sessionEpochMs) || Date.now(), carry: { [id]: { kind: 'change', change } } }));
      return;
    }
    const from = idOf(rt);
    if (from && from !== id) this._tab.delete(from);
    this._subst.set(rt, id);
    this._carries[id] = { kind: 'change', change };
    if (!this.sessionEpochMs) { const m = sessionMarker.read(); this.sessionEpochMs = (m && m.sessionEpochMs) || Date.now(); }
    this._writeSet({ kind: 'change', from, to: id }, { post: false });
  }

  /**
   * rt's ghost closed (it saved and let its lock go; EV §2.3, §2.7). Implicit: the tab marker goes and the closed
   * launcher calls it back. Several: its dock button goes; a ghost still unloading after its own goodbye
   * (its 'closed' not here yet) counts as on screen. During Quit, nothing until the last one; the last ghost on screen:
   * the site closes (marker cleared, lead released, the closed launcher calls the stored set back); otherwise (Close of
   * one, or \-) it leaves the set, and every ghost left gets OnOtherGhostClosed, then NOTIFY otherghostname (EV
   * §2.7.5).
   * @param {{script?: string, peer?: object|null}} o script: the one it closed with; peer: its peerInfo() at the end
   */
  _onClosed(rt, { script = '', peer = null } = {}) {
    if (!this.multi) {
      sessionMarker.clear();
      rt._showLauncher('closed');
      return;
    }
    // its dock button goes with it: a restore button of a ghost minimized at Quit must not call it back mid-Quit
    rt._hideLauncher();
    // a ghost still inside its own close (its loop `closed`, unloading: its 'closed' has not come yet) counts as on
    // screen, so the last 'closed' to come closes the site and nobody is torn down mid-unload (EV §2.3)
    const left = this.slots.some(s => s !== rt && (this._running(s) || !!s.parts));
    if (this.quitting) {
      if (!left) this._closeSite();
      return;
    }
    if (!left) { this._closeSite(); return; }
    const id = idOf(rt);
    const info = { ...(peer || this._peerOf(rt)), script };
    this._removeSlot(rt);
    this._writeSet({ kind: 'close', id });
    const refs = otherClosedRefs(info);
    for (const s of this.slots) {
      const l = loopOf(s);
      if (!l) continue;
      fireAndForget('OnOtherGhostClosed', () => l.otherEvent('OnOtherGhostClosed', refs));
      fireAndForget('otherghostname', () => l.notifyOthers());       // after it in the same queue: its handler still counts the closer
    }
  }

  /**
   * The closed launcher was clicked: the ghost (implicit) or the whole stored set (cold, one at a time) boots again;
   * nothing during a Quit (its end shows the launcher).
   */
  _relaunch(rt) {
    if (!this.multi) return rt.restart({ cold: true });
    if (this.quitting) return Promise.resolve('none');
    return this.start({ cold: true });
  }

  /**
   * The tucked button was tapped (UI §9.11; its Runtime keeps it there, busy, until a boot hides it): the set starts
   * exactly as on a first visit (the marker decides cold or resumed; OnFirstBoot for a ghost never met), its stored
   * set read fresh (a tucked tab hears no set message). A set closed meanwhile in another tab (Quit, the last Close)
   * is called back cold, as the closed launcher's tap would: one tap, never "Show X" turning into "Call X" [decision].
   * Another tab running the set: it shows frozen here and is taken over (UI §9.5), the busy button gone. Nothing came
   * up (every boot failed): the button again, not busy, the lead gone, and the marker the failed boots wrote cleared,
   * so the next page of the tab is tucked again.
   */
  async _untuck(rt) {
    const ids = this._storedSet(runtimePrefs.get()).map(g => g.id);
    const cold = ids.length > 0 && siteClosed(ids, storedClosed);
    const out = await this.start({ untuck: true, cold });
    const first = this.slots[0];
    if (!first) return out;
    if (this.slots.some(s => s.frozen || (s.state && s.state.readOnly))) {
      // the frozen start never hides a launcher (only a boot does)
      if (first._launcherMode === 'tucked') first._hideLauncher();
    } else if (!this.slots.some(s => this._running(s)) && first._launcherMode !== 'closed') {
      sessionMarker.clear();
      this._carries = {};
      await this._showTucked(this._setIds().length ? this._setIds() : ids);
    }
    return out;
  }

  /**
   * A frozen rt saw the tab become visible or focused, or a drop (UI §9.5). Implicit: it asks the other tab for its
   * ghost. Several: all or nothing — the tab asks for the lead, re-reads the stored set and takes every ghost over.
   */
  _wake(rt) {
    if (!this.multi) return rt._tryTakeover();
    if (this._waking) return this._waking;
    if (this._yielding || this._restarting) return Promise.resolve();     // restarting: its start takes the lead
    const doc = this._doc();
    if (doc && doc.hidden) return Promise.resolve();
    this._waking = (async () => {
      if (this._starting) await settled(this._starting);
      await this._takeOverSet();
    })().catch(e => log.warn('could not take the ghosts over', e))
      .finally(() => { this._waking = null; this._answerLead(); });
    return this._waking;
  }

  /** rt's change slot is free again (Runtime._slotFreed): a takeover asked meanwhile is answered now. */
  _slotIdle(rt) { this._answerLead(); }

  /** The dock (UI §2.6): the visible launchers stack upward in set order (bottom 16 + 56 i px) [decision]. */
  _layoutDock() {
    let i = 0;
    for (const rt of this.slots) {
      if (!rt._launcherMode) continue;
      if (rt.launcher && typeof rt.launcher.setSlot === 'function') rt.launcher.setSlot(i);
      i++;
    }
  }

  /** rt's place in the dock (the visible launchers before it in set order). */
  _dockSlot(rt) {
    let i = 0;
    for (const s of this.slots) { if (s === rt) break; if (s._launcherMode) i++; }
    return i;
  }

  /** Bring rt's ghost (characters, balloons, boxes) above the others (UI §3.5). */
  _raise(rt) {
    if (this.layers && rt && this.layers.has(rt.sid)) this.layers.raise(rt.sid);
  }

  /**
   * The FIFO of set changes (calls, ghost changes): one at a time. An idle queue runs the job at once (a ghost
   * change's first steps stay synchronous). Close and Quit are refused while it is busy.
   */
  _mutate(kind, job) {
    const go = () => { try { return Promise.resolve(job()); } catch (e) { return Promise.reject(e); } };
    const p = this._jobs > 0 && this._tail ? this._tail.then(go) : go();
    this._jobs++;
    // counted down as the job settles, before anything its caller chained on it runs (a script change queued behind a
    // ghost change starts at once)
    const done = () => {
      this._jobs--;
      if (this._jobs) return;
      this._tail = null;
      this._answerLead();
    };
    this._tail = p.then(done, done);
    return p;
  }

  /** Post on the site channel (the other tabs: the set, a shell change). */
  _post(msg) {
    const c = this._siteChannel();
    if (c) { try { c.postMessage({ ...msg, from: this.tabId }); } catch (e) { /* closed */ } }
  }

  /** A change carried over from the last page reached its ghost (Runtime._start): the other tabs hear of it now. */
  _announce(id) {
    this.rev = Math.max(this.rev, Number(runtimePrefs.get().rev) | 0);
    const ghosts = this.multi ? this._setIds() : [id];
    this._post({ t: 'set', ghosts, rev: this.rev, cause: { kind: 'change', to: id } });
  }

  // ---------------------------------------------------------------- the set (multi)

  _runtimeOpts() {
    return {
      base: this.base, defaultGhost: this.defaultGhost, defaultBalloon: this.defaultBalloon, runtimeUrl: this.runtimeUrl,
      runtimeFiles: this.runtimeFiles,
    };
  }

  /** The stored set as index entries (ghostset.js chooseSet over the runtime prefs; fallback chooseGhost). */
  _storedSet(stored = runtimePrefs.get(), max = this.maxGhosts) {
    const index = this.index;
    if (!index) return [];
    return chooseSet(index, {
      stored, supported: engineSupported, max,
      fallback: () => chooseGhost(index, { stored: stored && stored.ghost, defaultGhost: this.defaultGhost, supported: engineSupported }),
    });
  }

  _leadLock() {
    if (!this.lead) {
      this.lead = this._newLeadLock();
      this.lead.on('takeover-request', () => this._onLeadRequest());
    }
    return this.lead;
  }

  _releaseLead() {
    if (this.lead) this.lead.release();
    // a takeover asked meanwhile is answered by this: never a yield later for a request already met
    this._leadAsked = false;
    this._yieldWhenHidden = false;
  }

  /** This tab runs the set now (the lead held, nothing handing it over or taking it): the page API may change it at once. */
  _leading() {
    return !this.multi || (!!this.lead && this.lead.held && !this._yielding && !this._restarting && !this._waking);
  }

  /**
   * The set changes only in the tab that runs it (UI §9.5; the page API's calls and ghost changes): true when this tab
   * holds the lead (a takeover under way here ends first), or takes it now without waiting because no tab holds it and
   * nothing shows frozen here (the site closed here, its launcher's slot only). False while another tab runs the set
   * (this one shows it frozen or waits for it) or this one hands it over: refused, nothing written [decision; SSP is one
   * process]. The implicit Site has no lead: true.
   */
  async _ownSet() {
    if (!this.multi) return true;
    if (this._starting) await settled(this._starting);
    if (this._yielding || this._restarting) return false;
    if (this._waking && this.lead && this.lead.held) await settled(this._waking);
    if (this.lead && this.lead.held) return !this._yielding;
    if (this._waking || this.slots.some(rt => rt.frozen || (rt.state && rt.state.readOnly))) return false;
    return this._leadLock().acquire();
  }

  /** Nothing runs here (a call or change from the closed launcher refused or failed): the lead goes. */
  _idleLead() {
    if (this.multi && !this.slots.some(rt => this._running(rt))) this._releaseLead();
  }

  /** The id rt stands for in the set: its ghost, or the one a page left mid-change carries it to. */
  _slotId(rt) { return this._subst.get(rt) || idOf(rt); }

  _setIds() { return this.slots.map(rt => this._slotId(rt)).filter(Boolean); }

  /** Booting or booted and not closed (on screen for Close vs Quit and a site cap). */
  _running(rt) {
    const l = loopOf(rt);
    return !!(rt && rt.parts && !(l && l.closed)) || !!(rt && rt._starting && !rt.frozen);
  }

  /** Ghosts on screen in this page (a site cap counts them, frozen ones too; not the closed launcher's). */
  _count() { return this.slots.filter(rt => rt.ghost && !this._shut(rt)).length; }

  /**
   * rt only shows the closed launcher (the site closed here), or the tucked button with nothing of it frozen here (UI
   * §9.11): no ghost of it is on screen.
   */
  _shut(rt) {
    return !!rt && !rt.parts && !rt._starting && (rt._launcherMode === 'closed'
      || (rt._launcherMode === 'tucked' && !rt.frozen && !(rt.state && rt.state.readOnly)));
  }

  /** The stored set to bring back when a call or change from a shut slot fails: the stored `ghosts`, else [id]. */
  _keptSet(id) {
    const kept = runtimePrefs.get().ghosts;
    return Array.isArray(kept) && kept.length ? kept.slice() : [id];
  }

  /** rt shows a ghost here: running or booting, or frozen (another tab runs it). */
  _shown(rt) { return !!(rt && rt.ghost && (this._running(rt) || rt.frozen || (rt.state && rt.state.readOnly))); }

  /**
   * Another ghost's talk or raised event can reach rt's ghost (EV §2.7.7, §2.7.9): up here (not frozen behind another
   * tab), its loop booted, neither closed nor in a ghost change (nor torn down); a closing one counts (SSP checks
   * nothing there [disasm]) [decision for the change and the frozen slot].
   */
  _liveSlot(rt) {
    const l = loopOf(rt);
    return !!(rt && rt._up && !rt.frozen && l && l.booted && !l.closed && !l.changing && !l.frozen);
  }

  /**
   * A ghost as the others see it (EV §2.7): its loop's peerInfo(), else its stored state: the sakura and kero names in
   * effect its loop had (`names`, a shell's override applied, EV §2.7.5; else the index entry's) and the surfaces (−1
   * when none).
   */
  _peerOf(rt) {
    const l = loopOf(rt);
    if (l && typeof l.peerInfo === 'function') { try { return l.peerInfo(); } catch (e) { /* stored below */ } }
    const g = rt.ghost || {};
    const d = (rt.state && rt.state.data) || {};
    const sc = (d.stage && d.stage.scopes) || {};
    const surf = k => (sc[k] && Number.isInteger(sc[k].surface) ? sc[k].surface : -1);
    const n = d.names && typeof d.names.sakura === 'string' && typeof d.names.kero === 'string' ? d.names : null;
    return {
      id: g.id || '', name: g.name || g.id || '', sakuraName: n ? n.sakura : g.sakuraName || '',
      keroName: n ? n.kero : g.keroName || '', surfaces: [surf(0), surf(1)], shell: '',
    };
  }

  /**
   * The stored set and the tab marker (UI §9.5), once per set change: prefs {ghost: ghosts[0], ghosts, rev + 1},
   * the marker, and a set message to the other tabs (post). Prefs a newer Sumika wrote refuse the write: then no
   * set message goes out (a `rev` never stored would break "the stored set = the slots" in the other tabs) and
   * staleCheck('prefs') runs, so a tab meets a newer record while it runs, not only at start.
   */
  _writeSet(cause, { post = true, ids = this._setIds() } = {}) {
    if (!ids.length) return;
    const rev = Math.max(this.rev, Number(runtimePrefs.get().rev) | 0) + 1;
    const stored = runtimePrefs.set({ ghost: ids[0], ghosts: ids, rev });
    if (stored) this.rev = rev;
    this._markTab();
    if (!stored) { this.staleCheck('prefs'); return; }
    if (post) this._post({ t: 'set', ghosts: ids, rev: this.rev, cause });
  }

  /** The tab marker v2 (ghostset.js markerRecord): the ghosts this tab booted, set order, the carries, a Quit under way. */
  _markTab() {
    if (!this.sessionEpochMs) { const m = sessionMarker.read(); this.sessionEpochMs = (m && m.sessionEpochMs) || 0; }
    const ids = this._setIds().filter(id => this._tab.has(id) || this._carries[id]);
    if (!ids.length || !this.sessionEpochMs) return;
    sessionMarker.write(markerRecord({ ghosts: ids, sessionEpochMs: this.sessionEpochMs, carry: this._carries, quit: this.quitting }));
  }

  /** A new slot (on top), showing `entry` once it starts. */
  _newSlot(entry = null) {
    const rt = this._createRuntime(this._runtimeOpts());
    if (entry) { rt.ghost = entry; this._labelSlot(rt); }
    return rt;
  }

  /** The slots made to show `ids` in that order: a slot showing the ghost (or an empty one) is kept, the rest go. */
  _alignSlots(ids) {
    const pool = [...this.slots];
    const next = [];
    for (const id of ids) {
      let rt = pool.find(s => idOf(s) === id) || pool.find(s => !s.ghost) || null;
      if (rt) pool.splice(pool.indexOf(rt), 1);
      else rt = this._createRuntime(this._runtimeOpts());
      if (!rt.ghost) rt.ghost = this.index.ghost(id);
      this._labelSlot(rt);
      next.push(rt);
    }
    for (const rt of pool) this._removeSlot(rt);
    this.slots = next;
    this._layoutDock();
  }

  /** A slot goes: its views, engine, frozen stage, lock, launcher and layer. */
  _removeSlot(rt) {
    const i = this.slots.indexOf(rt);
    if (i >= 0) this.slots.splice(i, 1);
    rt._removed = true;       // a start of it still under way stops, a frozen one drops its stage (Runtime._startFrozen)
    rt._up = false;
    quiet('slot teardown', () => { rt._teardown(); rt._clearFrozen(); });
    if (rt.state) quiet('slot state', () => rt.state.dispose());
    if (rt.lock) { quiet('slot lock', () => rt.lock.dispose()); rt.lock = null; }
    if (rt.launcher) { quiet('slot launcher', () => rt.launcher.destroy()); rt.launcher = null; }
    rt._launcherMode = null;
    if (this.layers) this.layers.remove(rt.sid);
    rt.layer = null;
    if (this.active === rt) this.active = null;
    const id = idOf(rt);
    if (id) { delete this._carries[id]; this._tab.delete(id); }
    this._subst.delete(rt);
    this._layoutDock();
  }

  /**
   * The set's start (UI §9.5): with the lead the set runs here, else it shows frozen. A tucked page (phone or desktop)
   * decides first, before the site channel and the lead lock, so its button opens no channel, takes no lock and races
   * no tab (UI §9.11).
   */
  async _startSet({ cold = false, untuck = false } = {}) {
    if (!this.index) await this._loadIndex();
    if (!cold && !untuck && this._tuckedStart()) return this._showTucked(this._storedSet(runtimePrefs.get()).map(g => g.id));
    this._siteChannel();
    if (await this._leadLock().acquire()) return this._runSet({ cold });
    // another tab runs the set: every ghost of it shows here frozen until this tab takes it over (UI §9.5); a slot
    // frozen already stays as it is (started again: a stale launcher, window.sumika.start())
    const stored = runtimePrefs.get();
    this.rev = Math.max(this.rev, Number(stored.rev) | 0);
    const ids = this._storedSet(stored).map(g => g.id);
    if (!ids.length) { log.warn('this site has no ghosts (sumika/index/ghosts.json is empty)'); return 'none'; }
    log.info('the ghosts are running in another tab; showing them here frozen');
    this._alignSlots(ids);
    const frozen = rt => !rt.parts && (rt.frozen || (rt.state && rt.state.readOnly));
    const outs = await Promise.all(this.slots.map(rt => (frozen(rt) ? 'frozen' : rt.start({ ghost: rt.ghost.id, frozenOnly: true }))));
    return outs[0] || 'frozen';
  }

  /**
   * The stored set runs here (the lead is held): closed members are dropped, a closed set shows the closed launcher (a
   * ghost a change or call was carried to counts as not closed: it boots); resumed ghosts (the marker's, or a
   * takeover's) start at once in parallel, cold ones one at a time in set order with the next one's pack prefetched
   * [decision]; a ghost that fails to start leaves the set (unless it is the only one). A Quit the tab marker carries
   * goes on (quitting again, the set whole, only the ghosts still saying goodbye resumed).
   */
  async _runSet({ cold = false, takeover = false } = {}) {
    this.quitting = false;
    const stored = runtimePrefs.get();
    this.rev = Math.max(this.rev, Number(stored.rev) | 0);
    let ids = this._storedSet(stored).map(g => g.id);
    if (!ids.length) { log.warn('this site has no ghosts (sumika/index/ghosts.json is empty)'); this._releaseLead(); return 'none'; }
    for (const rt of this.slots) if (rt._starting) await settled(rt._starting);    // a frozen start still drawing
    const m = sessionMarker.read();
    const carries = cold || takeover ? {} : { ...markerCarry(m) };
    this._carries = carries;
    // a ghost a change or call was carried to boots, cold, whatever its stored `closed` says (Runtime._start)
    const closed = id => storedClosed(id) && !(carries[id] && (carries[id].kind === 'change' || carries[id].kind === 'call'));
    if (!cold && siteClosed(ids, closed)) return this._showClosed(ids[0]);
    // this tab's last page went during Quit's goodbyes (EV §2.7.3): the Quit goes on — the set stays whole, a ghost
    // still saying goodbye resumes and closes at the end of it (_onBooted), a closed one is not booted again
    const quit = !cold && !takeover && markerQuit(m);
    // a ghost closed while others stayed, whose page went before the set was stored without it: dropped [decision]
    if (!cold && !quit) ids = ids.filter(id => !closed(id));
    this._tab = new Set(takeover ? [] : markerGhosts(m));
    this._subst.clear();
    this.quitting = quit;
    this._alignSlots(ids);
    if (!sameList(stored.ghosts, ids) || stored.ghost !== ids[0]) this._writeSet({ kind: 'sync' });
    const resumed = [];
    const fresh = [];
    for (const rt of this.slots) {
      const l = loopOf(rt);
      if (l && !l.closed && !rt.frozen) continue;                        // already running here
      const c = this._carries[idOf(rt)];
      const resume = takeover || (!cold && this._tab.has(idOf(rt)) && !(c && (c.kind === 'change' || c.kind === 'call')));
      if (quit && (!resume || closed(idOf(rt)))) continue;               // closed in that Quit: its slot waits for the launcher
      if (resume) resumed.push(rt);
      else fresh.push(rt);
    }
    // every resumed batch lists the whole set; the raises wait for their starts from now (_upSettled)
    const upSince = this.clock.now();
    for (const rt of resumed) { rt._up = true; rt._upSince = upSince; }
    const outs = new Map();
    // _resuming: a takeover's slot waits for its ghost lock before its start; the raises wait for it all (_upSettled)
    await Promise.all(resumed.map(async rt => {
      const p = takeover ? this._takeOverSlot(rt) : rt.start({ ghost: idOf(rt) });
      rt._resuming = p;
      try { outs.set(rt, await p); } finally { if (rt._resuming === p) rt._resuming = null; }
    }));
    for (let i = 0; i < fresh.length; i++) {
      const rt = fresh[i];
      if (!this.slots.includes(rt)) continue;
      if (fresh[i + 1]) this._prefetch(idOf(fresh[i + 1]));
      outs.set(rt, await rt.start({ ghost: idOf(rt), cold }));
    }
    return this._afterStart(outs);
  }

  /** A frozen slot runs again (its own takeover); one added meanwhile resumes as a takeover too. */
  _takeOverSlot(rt) {
    if (rt.frozen || (rt.state && rt.state.readOnly)) return rt._takeOver();
    rt.tookOver = true;
    return rt.start({ ghost: idOf(rt) });
  }

  /**
   * Slots that did not start leave the set (one stays: window.sumika.runtime); a ghost the others had been told is up
   * (a resumed batch lists the whole set) is NOTIFYed away again (otherghostname, as after a Close). A Quit gone
   * on from the last page keeps its set whole and, with nobody left saying goodbye, closes the site. Nothing running:
   * the lead goes.
   */
  _afterStart(outs) {
    const out = [...outs.values()];
    const failed = [...outs].filter(([, o]) => o === 'failed' || o === 'none').map(([rt]) => rt);
    if (this.quitting) {
      if (!this.slots.some(rt => this._running(rt) || rt.parts)) { this._closeSite(); return 'launcher'; }
      if (!this.slots.some(rt => this._running(rt))) this._releaseLead();
    } else this._dropFailed(failed);
    if (out.includes('booted')) return 'booted';
    return outs.get(this.slots[0]) || out[0] || 'failed';
  }

  /**
   * Slots whose ghost failed (_afterStart's rule, also for a ghost that cannot draw later: Runtime._canvasLost,
   * core/canvas.js): they leave the set unless every slot failed ({t:'set', cause: sync}; one stays: window.sumika.runtime),
   * and when one had counted as up the others re-NOTIFY otherghostname; nothing running: the lead goes, so the next page
   * tries a lone ghost again. During a Quit the set stays whole: with nobody left on screen the site closes.
   * @param {Runtime[]} failed
   * @param {string} [why] for the warn line
   */
  _dropFailed(failed, why = 'did not start') {
    if (this.quitting) {
      if (!this.slots.some(rt => this._running(rt) || rt.parts)) { this._closeSite(); return; }
    } else if (failed.length && failed.length < this.slots.length) {
      const told = failed.some(rt => rt._up);
      for (const rt of failed) { log.warn(`${idOf(rt)} ${why}; it leaves the set`); this._removeSlot(rt); }
      this._writeSet({ kind: 'sync' });
      if (told) this._renotify();
    }
    if (!this.slots.some(rt => this._running(rt))) this._releaseLead();
  }

  /** Every ghost up here NOTIFYs otherghostname again (a ghost it was told of is gone; EV §2.7, §3.13). */
  _renotify() {
    for (const s of this.slots) {
      const l = loopOf(s);
      if (s._up && l) fireAndForget('otherghostname', () => l.notifyOthers());
    }
  }

  /**
   * A call from the closed launcher did not boot: the site stays closed, its launcher calling `ids` (stored again) back.
   * mode 'tucked': a call or ghost change from the tucked button (UI §9.11): that button again, the lead gone.
   */
  async _reclose(ids, mode = 'closed') {
    this._writeSet({ kind: 'sync' }, { ids });
    sessionMarker.clear();
    this._tab = new Set();
    this._carries = {};
    return mode === 'tucked' ? this._showTucked(ids) : this._showClosed(ids[0]);
  }

  /**
   * A tucked page (UI §9.11: data-phone="tucked" on a phone, or data-default-state="tucked" with no visitor choice on
   * any device): this start would cold-boot the stored set in this tab, so her button shows instead. Not when the tab
   * marker says she is out here already (a resume, a carried change or call, a Quit under way), nor when the stored
   * set is closed (the closed launcher).
   */
  _tuckedStart() {
    if (!this.tucked) return false;
    const m = sessionMarker.read();
    if (markerGhosts(m).length || markerQuit(m) || Object.keys(markerCarry(m) || {}).length) return false;
    const ids = this._storedSet(runtimePrefs.get()).map(g => g.id);
    return ids.length > 0 && !siteClosed(ids, storedClosed);
  }

  /**
   * The tucked button for the set's first ghost (as _showClosed, but nothing is written or started: no engine, lock,
   * channel, state or marker); its tap is _untuck. A call, change or tap from it that failed took the lead (_ownSet)
   * and opened the site channel: both go (_reclose has posted its sync), so the tab hears no set message again until
   * the next tap (UI §9.11).
   */
  async _showTucked(ids) {
    this._alignSlots([ids[0]]);
    const rt = this.slots[0];
    rt._clearFrozen();
    rt.tookOver = false;
    this._tab = new Set();
    if (this._channel) quiet('site channel', () => this._channel.close());
    this._channel = undefined;
    rt._showLauncher('tucked');
    this._idleLead();
    return 'launcher';
  }

  /** The stored set is closed: one closed launcher for its first ghost; the lead goes (nothing runs here). */
  async _showClosed(id) {
    this._alignSlots([id]);
    const rt = this.slots[0];
    rt._clearFrozen();
    rt.tookOver = false;
    const out = await rt.start({ ghost: id });
    this._idleLead();               // (a ghost that booted after all keeps it: the lead goes only with nothing running)
    return out;
  }

  /** Start downloading a ghost's text pack while the one before it boots [decision]. */
  _prefetch(id) {
    const index = this.index;
    if (!index || typeof index.ghostFiles !== 'function') return;
    quiet('prefetch', () => Promise.resolve(index.ghostFiles(id)).then(f => f && typeof f.prefetch === 'function' && f.prefetch()).catch(() => {}));
  }

  /** Every slot's start has resolved, and the set's (after-boot events wait for it: a resuming caller is up first). */
  async _settled() {
    for (let i = 0; i < 8; i++) {
      const ps = [this._starting, ...this.slots.map(s => s._starting)].filter(Boolean);
      if (!ps.length) return;
      await Promise.all(ps.map(settled));
    }
  }

  /**
   * What a raise or a COMMUNICATE waits for (EV §2.7.7, §2.7.9): the starts of the slots that count as up, so the
   * targets of a resumed page (up from before their start; a takeover's wait for its ghost lock too:
   * `_resuming`) or a ghost past its NOTIFY batch are running first; each for at most `upWaitMs` from when it counted
   * as up (`_upSince`) [decision]: a resumed ghost whose load stalls with no error is then no target until it is up.
   * A ghost still loading its engine (a call's callee, a cold start) is no target yet and is not waited for: SSP
   * raises at once [disasm 0x6333F5]. So no start that never ends holds the page's raises and talks for good.
   */
  async _upSettled() {
    for (let i = 0; i < 8; i++) {
      const now = this.clock.now();
      const waits = [];
      for (const s of this.slots) {
        const p = s._up ? s._resuming || s._starting : null;
        const left = p ? (Number.isFinite(s._upSince) ? s._upSince : now) + this.upWaitMs - now : 0;
        if (left > 0) waits.push(this._within(p, left));
      }
      if (!waits.length) return;
      await Promise.all(waits);
    }
  }

  /** Resolves once p settles or `ms` went by on the Site's clock, whichever comes first (the timer cleared). */
  _within(p, ms) {
    const c = this.clock;
    return new Promise(resolve => {
      const h = c.setTimeout(resolve, ms);
      settled(p).then(() => { c.clearTimeout(h); resolve(); });
    });
  }

  /** The events a ghost owes (`owed`, a marker 'after' carry) go out once `run` ended and the set has settled. */
  _owe(rt, owed, run) {
    const p = rt.parts;
    const end = run && run.finished ? settled(run.finished) : Promise.resolve();
    Promise.all([end, this._settled()]).then(() => {
      const id = idOf(rt);
      if (rt.parts !== p || !id || this._carries[id] !== owed) return;     // gone, changed or closed meanwhile
      delete this._carries[id];
      this._markTab();
      this._tellAfter(rt, owed, run);
    }).catch(e => log.warn('the after-boot events failed', e));
  }

  /**
   * OnGhostCallComplete to the caller, OnOtherGhostBooted to the others [doc; disasm msg 0x3D], or OnOtherGhostChanged
   * to every other ghost [doc; disasm msg 0x3E]; each only while that ghost is peerLive (otherEvent).
   */
  _tellAfter(rt, owed, run) {
    const loop = loopOf(rt);
    if (!loop) return;
    const info = { ...this._peerOf(rt), script: run && typeof run.script === 'string' ? run.script : '' };
    const refs = owed.of === 'change' ? otherChangedRefs(owed.prev || {}, info) : afterBootRefs(info);
    for (const s of this.slots) {
      const l = loopOf(s);
      if (s === rt || !l) continue;
      const ev = owed.of === 'change' ? 'OnOtherGhostChanged' : idOf(s) === owed.caller ? 'OnGhostCallComplete' : 'OnOtherGhostBooted';
      fireAndForget(ev, () => l.otherEvent(ev, refs));
    }
  }

  async _call(from, { target, byId = false, raiseEvent = true, reason = 'manual', script = '', fromScript = false } = {}) {
    if (this._starting) await settled(this._starting);
    if (!this.index || this.quitting) return false;
    const caller = from && this.slots.includes(from) ? from : null;
    const cl = loopOf(caller);
    if (from && (!cl || !cl.booted || cl.closed || cl.closing)) { log.info('the calling ghost is gone; no call'); return false; }
    // the set changes only in the tab that runs it (UI §9.5): a tab without the lead writes nothing; with the site
    // closed here (nobody runs the set) it takes the lead
    if (!this._leading() && !(await this._ownSet())) { log.info('the ghosts run in another tab; no call here'); return false; }
    if (this.quitting) { this._idleLead(); return false; }
    // no caller and only the closed launcher (or the tucked button, UI §9.11) here: the callee comes back alone, a
    // plain cold boot (its launcher's set is no longer the set; the stored set is the slots again) [decision]
    const shut = !caller && this.slots.length === 1 && this._shut(this.slots[0]) ? this.slots[0] : null;
    const shutMode = shut ? shut._launcherMode : null;        // read before _removeSlot clears it
    const closedSet = shut ? this._keptSet(idOf(shut)) : null;
    const entry = resolveCallTarget(this.index.ghosts, idOf(caller), target, { byId, onScreen: this.onScreen(), supported: engineSupported });
    if (!entry) { log.info(`no ghost "${target}" to call (unknown, on screen already, or not runnable here)`); this._idleLead(); return false; }
    if (this._count() >= this.maxGhosts) { log.info(`at most ${this.maxGhosts} ghosts at once: ${entry.id} is not called`); this._idleLead(); return false; }
    let said = fromScript ? String(script || '') : '';
    if (raiseEvent && cl) {
      // OnGhostCalling [callee sakura, manual|automatic, name, path]; the call goes on once its reply started [disasm]
      const r = await cl.ghostCalling(caller._ghostInfo(entry), { reason });
      said = (r && r.script) || '';
    }
    const call = caller ? { ...this._callerInfo(caller), script: said } : null;
    if (shut) this._removeSlot(shut);
    const rt = this._newSlot(entry);
    if (call) this._carries[entry.id] = { kind: 'call', call, caller: idOf(caller) };
    this._writeSet({ kind: 'call', id: entry.id });
    const out = await rt.start({ ghost: entry.id, cold: true, call });
    // a tab on the one-ghost runtime holds it: frozen here; from the closed launcher nothing runs: the lead goes
    if (out === 'frozen') { this._idleLead(); return false; }
    if (out !== 'booted') {
      log.error(`${entry.name || entry.id} did not start; the call is dropped`);
      if (this.slots.includes(rt)) this._removeSlot(rt);
      if (shut && !this.slots.length) { await this._reclose(closedSet, shutMode); return false; }
      this._writeSet({ kind: 'sync' });
      this._idleLead();
      return false;
    }
    // the callee takes the keys only from a caller that had them [decision: SSP activates it always, ActivateAllWindow]
    const l = loopOf(rt);
    if (cl && cl.active && !cl.closed && l) { l.active = true; this._onActivate(rt); }
    return true;
  }

  /** OnGhostCalled's caller fields [sakura name in effect, descript name, path] (EV §2.7.1). */
  _callerInfo(rt) {
    const l = loopOf(rt);
    const peer = l ? this._peerOf(rt) : {};
    const gi = typeof rt._ghostInfo === 'function' ? rt._ghostInfo(rt.ghost, l && l.descript) : {};
    return { sakuraName: peer.sakuraName || gi.sakuraName || '', name: peer.name || gi.name || '', path: gi.path || '' };
  }

  /** The last ghost on screen closed, or Quit's last one (EV §2.7.3): the closed launcher calls the stored set back. */
  _closeSite() {
    this.quitting = false;
    const first = this.slots[0];
    for (const rt of [...this.slots]) if (rt !== first) this._removeSlot(rt);
    sessionMarker.clear();
    this._carries = {};
    this._tab = new Set();
    this._subst.clear();
    this.active = null;
    const p = runtimePrefs.get();
    this._post({ t: 'set', ghosts: Array.isArray(p.ghosts) ? p.ghosts : [], rev: this.rev, cause: { kind: 'quit' } });
    this._releaseLead();
    if (first) first._showLauncher('closed');
  }

  // ---------------------------------------------------------------- the other tabs (UI §9.5)

  /** The site channel (made once); null without BroadcastChannel. */
  _siteChannel() {
    if (this._channel !== undefined) return this._channel;
    this._channel = null;
    const C = this.Channel !== undefined ? this.Channel : channelClass();
    if (!C) return null;
    try {
      this._channel = new C(SITE_CHANNEL);
      this._channel.onmessage = ev => { this._onSiteMessage((ev && ev.data) || {}); };
    } catch (e) {
      this._channel = null;
    }
    return this._channel;
  }

  /**
   * Another tab's message. {t:'view', id}: it changed that ghost's shell; the slot showing it draws its frozen stage
   * again (Runtime._followView). {t:'set', ghosts, rev, cause}: its set changed; the implicit Site follows a change
   * in place (Runtime._follow), a multi Site reconciles its frozen slots (a rev at or below the last one applied is
   * stale). {t:'ghost', id}: a tab on the one-ghost runtime changed ghosts (read as a change to `id`).
   */
  async _onSiteMessage(m) {
    if (!m || m.from === this.tabId || !this.index) return;
    if (m.t === 'view') {
      const rt = this.find(m.id);
      if (rt) await rt._followView();
      return;
    }
    let ghosts;
    let cause;
    if (m.t === 'set' && Array.isArray(m.ghosts)) { ghosts = m.ghosts; cause = (m.cause && typeof m.cause === 'object') ? m.cause : { kind: 'sync' }; }
    else if (m.t === 'ghost' && m.id) { ghosts = [m.id]; cause = { kind: 'change', to: m.id }; }
    else return;
    if (!this.multi) {
      const rt = this.slots[0];
      if (rt && cause.kind === 'change' && cause.to) await rt._follow(cause.to);
      return;
    }
    if (m.t === 'set' && Number.isFinite(m.rev)) {
      if (m.rev <= this.rev) return;
      this.rev = m.rev;
    }
    if (cause.kind === 'quit') return;        // a site close is not followed at once: the next takeover finds the launcher
    const run = () => this._reconcile(ghosts.filter(id => typeof id === 'string' && this.index.ghost(id)));
    this._reconciling = (this._reconciling || Promise.resolve()).then(run, run).catch(e => log.warn('could not follow the other tab', e));
    return this._reconciling;
  }

  /**
   * The frozen slots follow the other tab's set (diffSets): a ghost changed in place follows (Runtime._follow), one gone
   * leaves, one added shows frozen; then the set order. A tab holding the lead only follows changes in place (a lost
   * race without Web Locks, as the one-ghost runtime did).
   */
  async _reconcile(ids) {
    if (!ids.length) return;
    const d = diffSets(this.slots.map(idOf).filter(Boolean), ids);
    for (const [from, to] of d.replaced) { const rt = this.find(from); if (rt) await rt._follow(to); }
    if (this.lead && this.lead.held) return;
    for (const id of d.gone) { const rt = this.find(id); if (rt && this.slots.length > 1) this._removeSlot(rt); }
    for (const id of d.added) {
      if (this.find(id)) continue;
      const rt = this._newSlot(this.index.ghost(id));
      rt.start({ ghost: id, frozenOnly: true });
    }
    const pos = rt => { const i = ids.indexOf(idOf(rt)); return i < 0 ? ids.length : i; };
    this.slots.sort((a, b) => pos(a) - pos(b));
    this._layoutDock();
  }

  /**
   * The lead holder is asked for the set (another tab's 'takeover-request' on the lead, or on a ghost lock from a tab
   * on the one-ghost runtime): never halfway through a start, call or change (answered after it); nothing running:
   * the lead goes; visible: when the tab is hidden; hidden: every ghost yields, then the lead (_yieldAll).
   */
  _onLeadRequest() {
    if (!this.lead || !this.lead.held) return;
    if (this._busyHere()) { this._leadAsked = true; return; }
    if (!this.slots.some(rt => loopOf(rt))) { this._releaseLead(); return; }
    const doc = this._doc();
    if (doc && !doc.hidden) { this._yieldWhenHidden = true; return; }
    this._yieldAll();
  }

  /** A start, job, wake, slot change or Quit runs here: a takeover waits for it (a Quit is never split across tabs). */
  _busyHere() {
    return this._jobs > 0 || !!this._starting || !!this._waking || this.quitting || this.slots.some(rt => rt._changing || rt._starting);
  }

  _answerLead() {
    if (!this._leadAsked || this._busyHere()) return;
    this._leadAsked = false;
    this._onLeadRequest();
  }

  /** Every ghost yields (Runtime._yield: suspend, teardown, its lock let go, frozen), then the lead (UI §9.5). */
  _yieldAll() {
    if (this._yielding) return this._yielding;
    if (this._busyHere()) { this._leadAsked = true; return Promise.resolve(); }
    this._yieldWhenHidden = false;
    this._yielding = (async () => {
      for (const rt of this.slots) rt._up = false;
      await Promise.all(this.slots.map(rt => settled(rt._yield())));
      this._releaseLead();
    })().finally(() => { this._yielding = null; });
    return this._yielding;
  }

  /** The lead, then every ghost of the stored set: re-read and reconciled, then taken over in parallel (UI §9.5). */
  async _takeOverSet() {
    if (!this.index) await this._loadIndex();
    const lead = this._leadLock();
    if (lead.held) {
      // the set runs here: a slot still frozen is a ghost a tab on the one-ghost runtime holds; it asks for it alone
      // with that tab's per-ghost request [decision; transient]
      await Promise.all(this.slots.filter(rt => rt.frozen || (rt.state && rt.state.readOnly)).map(rt => settled(rt._takeOver())));
      return;
    }
    lead.requestTakeover();
    if (!(await lead.acquire({ wait: true })) || lead !== this.lead) return;
    await this._runSet({ takeover: true });
  }

  // ---------------------------------------------------------------- a page older than the published build

  /**
   * Whether this page runs an older build than the site publishes, and if so reload into it, once. Asked when an
   * engine start fails (Runtime._startEngine: a worker or engine file of this build gone), the index is newer than
   * this runtime (_loadIndex), or a stored record is newer (Runtime._start's state, start()'s prefs, a prefs write
   * _writeSet saw refused). Answers false, with nothing done, when:
   * - there is no table (unbundled: tests, site/dev);
   * - sumika/build.json ('no-cache') is unreadable, not ok or names no build;
   * - it names this build: the failure is genuine (for a newer stored record a rollback across a schema bump,
   *   logged once);
   * - this tab reloaded away from this build already (logged once);
   * - the guard cannot be stored and read back (site data blocked: a reload could repeat);
   * - the bundle fetched again ('reload') is not ok or does not hold the published build (offline, or a host or proxy
   *   still serving the old one); the guard is then put back as it was, since nothing was reloaded.
   * Otherwise it calls reload() and answers true: whoever awaited that never goes on, so nothing is written meanwhile
   * (the set, the marker and its carries stay for the next page). One check in flight is shared by every trigger; a
   * true answer stands for the page, a false one for STALE_RECHECK_MS. Never rejects.
   * @param {string} [reason] 'engine' | 'index-newer' | 'state' | 'prefs'
   * @returns {Promise<boolean>}
   */
  staleCheck(reason = '') {
    if (!this.runtimeFiles) return Promise.resolve(false);
    const s = this._stale;
    const fresh = s && (!s.done || s.answer || this.clock.now() - s.at < STALE_RECHECK_MS);
    const memo = fresh ? s : this._askStale();
    return memo.promise.then(a => {
      if (a.same && RECORD_REASONS.has(reason)) {
        log.once('stale:rollback', `the stored data is newer than the published Sumika (build ${this.build}): the site went back across a stored-data version; it is read for what fits and not written`);
      }
      return a.reload;
    });
  }

  /** One check (staleCheck's steps), kept as the shared answer: {promise → {reload, same}, done, answer, at}. */
  _askStale() {
    const s = { promise: null, done: false, answer: false, at: 0 };
    s.promise = this._staleSteps().catch(e => {
      log.warn('could not check for a newer Sumika', e);
      return { reload: false, same: false };
    }).then(a => {
      Object.assign(s, { done: true, answer: a.reload, at: this.clock.now() });
      return a;
    });
    this._stale = s;
    return s;
  }

  /** staleCheck's steps 2–7 (CONTRACTS "Site"): {reload, same} (same: build.json names this very build). */
  async _staleSteps() {
    const no = { reload: false, same: false };
    const f = this._fetch || (typeof fetch === 'function' ? (u, o) => fetch(u, o) : null);
    if (!f) return no;
    let published = null;
    try {
      const r = await f(new URL('build.json', this.runtimeUrl).href, { cache: 'no-cache' });
      if (r && r.ok) published = await r.json();
    } catch (e) {
      published = null;
    }
    const build = published && typeof published.build === 'string' ? published.build : '';
    if (!build) return no;
    if (build === this.build) return { reload: false, same: true };
    const ss = this._session;
    if (ss.get(RELOADED_KEY) === this.build) {
      log.once('stale:again', `this page runs Sumika build ${this.build}, the site has ${build}, and a reload did not bring ${build}`);
      return no;
    }
    const before = ss.get(RELOADED_KEY);
    ss.set(RELOADED_KEY, this.build);
    // site data blocked: no guard, no reload (the storage hub's guard: once the hub holds it, core/platform.js confirm)
    if (!(await confirmed(ss, RELOADED_KEY, this.build))) return no;
    let fetched = false;
    try {
      const r = await f(this.runtimeUrl, { cache: 'reload' });
      fetched = !!(r && r.ok) && String(await r.text()).includes(build);
    } catch (e) {
      fetched = false;
    }
    if (!fetched) {
      // nothing was reloaded: the guard goes back, so a later check (the network back, the host serving the new bundle)
      // may still reload once
      if (before != null) ss.set(RELOADED_KEY, before);
      else if (typeof ss.remove === 'function') ss.remove(RELOADED_KEY);
      return no;
    }
    log.info(`this page runs Sumika build ${this.build}; the site publishes ${build}: reloading once`);
    try {
      if (this._reload) this._reload();
      else location.reload();
    } catch (e) {
      log.warn('could not reload the page', e);
      return no;
    }
    return { reload: true, same: false };
  }

  // ---------------------------------------------------------------- page lifecycle

  /** The page's document; null outside a browser (a method so tests can give each tab its own). */
  _doc() { return typeof document !== 'undefined' ? document : null; }

  /**
   * pagehide: every slot saves and lets its lock go, then the idle clock is stored and the lead goes; pageshow from
   * the bfcache: start again; hidden: a set (or one-ghost slot) another tab asked for while this one was visible yields
   * it now. Also the language's own listeners (another tab's Language ▸ pick, the browser's settings; UI §2.10).
   * @param {object} [win] the window (tests pass a stand-in)
   */
  _installPageHooks(win = typeof window !== 'undefined' ? window : null) {
    if (this._pageHooks || !win) return;
    this._pageHooks = true;
    if (this.language && typeof this.language.bindWindow === 'function') this.language.bindWindow(win);
    if (this.user && typeof this.user.bindWindow === 'function') this.user.bindWindow(win);
    win.addEventListener('pagehide', () => this._onPageHide());
    win.addEventListener('pageshow', ev => {
      this._endThrough();
      if (!ev || !ev.persisted) return;
      // the storage hub's storage events never reached the cached page: a full delta first
      const hub = platform.hub;
      if (hub && hub.state === 'live') settled(hub.sync()).then(() => this.restart());
      else this.restart();
    });
    const doc = this._doc();
    if (doc) {
      doc.addEventListener('visibilitychange', () => {
        if (!doc.hidden) return;
        if (this._yieldWhenHidden) this._yieldAll();
        for (const rt of [...this.slots]) if (rt._yieldWhenHidden) rt._yield();
      });
    }
    const hub = platform.hub;
    if (hub && hub.state === 'live') this._leaveHooks(win);
  }

  /**
   * The storage hub only: a page's posts in its own pagehide never reach the hub [measured, Chromium], so
   * what pagehide writes is written earlier, at the events that start a navigation of this document: a link clicked
   * (navigatingClick), a form sent to this document, beforeunload (its returnValue never set: no prompt).
   */
  _leaveHooks(win) {
    win.addEventListener('click', ev => { if (navigatingClick(ev, win)) this._leaveFlush(); });
    win.addEventListener('submit', ev => {
      if (!ev || ev.defaultPrevented) return;
      const f = ev.target;
      const t = f && typeof f.getAttribute === 'function' ? String(f.getAttribute('target') || '').trim().toLowerCase() : '';
      if (t === '' || t === '_self') this._leaveFlush();
    });
    win.addEventListener('beforeunload', () => this._leaveFlush());
  }

  /**
   * The leave-flush: what _onPageHide writes but the lock releases and the Preferences box teardown (each
   * slot's Runtime._onLeave: a change under way carried on, the state, the engine's files; then the idle clock), the
   * states writing through from here on until the page is shown again or LEAVE_THROUGH_MS passed (it
   * stayed). Flushes within LEAVE_DEDUPE_MS of the last are one; pagehide still runs everything afterwards.
   */
  _leaveFlush() {
    const now = this.clock.now();
    if (now - this._leftAt < LEAVE_DEDUPE_MS) return;
    this._leftAt = now;
    for (const rt of [...this.slots]) {
      try { rt._onLeave(); } catch (e) { log.warn('saving a ghost before leaving the page failed', e); }
    }
    if (this.input) this.input.flush();
    if (this._through !== null) this.clock.clearTimeout(this._through);
    this._through = this.clock.setTimeout(() => this._endThrough(), LEAVE_THROUGH_MS);
  }

  /** The leave-flush's write-through ends (the page is shown again, or it stayed). */
  _endThrough() {
    if (this._through !== null) { this.clock.clearTimeout(this._through); this._through = null; }
    for (const rt of this.slots) if (rt.state && typeof rt.state.writeThrough === 'function') rt.state.writeThrough(false);
  }

  /**
   * The page's storage decided: with a pending storage hub (data-hub) its frame planted (hub.ready()), the
   * site index loading meanwhile unless `index` is false (it needs no stored data), then _hubDecided; the
   * same promise for every caller. At once without a hub or once it decided. start() waits for it first; main.js waits
   * for it before it reads the visitor's choice through the hub (core/choice.js), with `index` false when the site's
   * default is off (most visitors then get nothing: not even the index is fetched for them). Never rejects.
   * @param {{index?: boolean}} [o]
   * @returns {Promise<void>}
   */
  storageReady({ index = true } = {}) {
    if (this._storage) return this._storage;
    const hub = platform.hub;
    if (!hub || hub.state !== 'pending') return Promise.resolve();
    if (index && !this.index) this._fetchIndex().catch(() => {});
    this._storage = hub.ready().then(() => { this._hubDecided(hub); });
    return this._storage;
  }

  /**
   * The storage hub's decision is in (storageReady): the language and the user information, read from the empty
   * view while it decided, are read again (no subscriber that matters exists yet); a live hub that goes away later
   * stops the ghosts (_hubGone).
   */
  _hubDecided(hub) {
    if (this._hubSeen) return;
    this._hubSeen = true;
    if (this.language && typeof this.language.refresh === 'function') quiet('language', () => this.language.refresh());
    if (this.user && typeof this.user.refresh === 'function') quiet('user information', () => this.user.refresh());
    if (hub && hub.state === 'gone') this._hubGone();
    else if (hub && hub.state === 'live') hub.onGone(() => this._hubGone());
  }

  /**
   * The storage hub went away mid-page (its pagehide, the frame removed): one warn, and every ghost stops here
   * as after a takeover (frozen, its lock let go; a change under way first ends). Nothing plants a new hub or switches
   * to this origin's storage: two stores mixed would be worse. Its writes from here on go nowhere.
   */
  _hubGone() {
    if (this._hubLost) return;
    this._hubLost = true;
    log.warn('the storage hub went away: the ghosts stop on this page');
    for (const rt of [...this.slots]) {
      rt._up = false;
      const stop = () => settled(rt._yield());
      if (rt._changing) settled(rt._changing).then(stop);
      else stop();
    }
    this._releaseLead();
  }

  _onPageHide() {
    for (const rt of [...this.slots]) {
      try { rt._onPageHide(); } catch (e) { log.warn('saving a ghost on pagehide failed', e); }
    }
    if (this.input) this.input.flush();
    // the Preferences box goes with the page, sending nothing: its edits are stored, and the next page's boot batch
    // tells every ghost (UI §2.13)
    if (this._settings) { quiet('settings', () => this._settings.destroy()); this._settings = null; }
    this._releaseLead();
  }

  // ---------------------------------------------------------------- test seams

  /** A Runtime for a new slot, on this site. */
  _createRuntime(opts) { return this._makeRuntime({ ...opts, site: this }); }

  /** \![raiseother,random,…]'s pick (ghostset.js raiseTargets). */
  _random() { return Math.random(); }

  /** The lead lock (UI §9.5): 'sumika/lead'. A multi Site without `lead` runs the set in every tab (a lock always held). */
  _newLeadLock() { return this._wantsLead ? new GhostLock(LEAD_ID) : new GhostLock(LEAD_ID, { locks: null, Channel: null }); }
}

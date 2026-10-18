// The storage hub, page side (CONTRACTS core/hub.js and "Hub protocol"; CLAUDE.md "The storage hub"). With `data-hub`
// on the script tag (main.js) the page plants a hidden iframe of the runtime host's hub page (src/hub/,
// sumika/hub.html) at the Site's first start and keeps every visitor record there instead of on its own origin:
// localStorage `sumika:` keys (a synchronous mirror, MirrorStorage), sessionStorage `sumika.` keys (the session
// mirror), IndexedDB (store ports: core/portstore.js), Web Locks and BroadcastChannels (real ones inside the hub), all
// over one private MessagePort. So pages of several origins of one site (a.example.com, b.example.com) share one
// visitor: a link between them resumes the ghosts, and their tabs coordinate as on one origin. core/platform.js is the
// one seam the rest of the page reads. From a pagehide into the back/forward cache to the pageshow nothing it writes is
// posted (`hidden`): the cached hub frame would apply it after Back, over what another page wrote meanwhile.
// Until the hub decides, reads see an empty view and writes wait in a queue; a hub that is not usable (no answer, a
// refusal: not allowlisted, cross-site, a protocol mismatch, its storage) makes the page fall back to its own origin's
// storage for the rest of the page, exactly the path of a page without the hub, logged once.
import { log } from './log.js';
import { platform, openStore as platformStore } from './platform.js';
import { session as pageSession, Store } from './storage.js';
import { PortStore, STORE_OP_MS } from './portstore.js';
import {
  HUB_PROTOCOL, HUB_PARAM, HELLO, REASONS, STORE_DB, STAMP, LOCAL_PREFIX, isLocalKey, isSessionKey, isName,
} from './hubproto.js';

/**
 * How long after the frame's `load` the hub's `ack` may take (a dead host, X-Frame-Options / frame-ancestors, a page
 * CSP without frame-src: Chromium fires `load` for the error page). 2.5 s, not 1 s: the timer and the ack share the
 * page's event loop, and after a long task of the host page either may run first.
 */
export const HUB_ACK_MS = 2500;
/** How long after planting the hub's welcome or refusal may take (its hub.json is revalidated: a slow connection). */
export const HUB_WAIT_MS = 10000;
/** The mirror's localStorage quota estimate, UTF-16 units (under Chromium's and Safari's 5 MiB per origin). */
export const QUOTA_UNITS = 5000000;

const BAD_VALUE = 'data-hub must be empty or an absolute http(s) URL of a hub page; this page keeps its data on its own origin';
/** refusals that are the publisher's to fix: warn; the visitor's browser or settings ('site', 'storage'): info */
const INFO_REASONS = new Set(['site', 'storage']);
const realClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h) };
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
/** the ops a page in the back/forward cache never posts (HubClient.hidden) */
const WRITES = new Set(['ls.set', 'ls.remove', 'ss.set', 'ss.remove', 'will']);

/**
 * The hub URL a script tag asks for, or null: no hub. `data-hub` absent: null. Bare (empty): `hub.html` next
 * to sumika.js. A value: an absolute http(s) URL of a hub page. Anything else logs one warn and is null. A hub on the
 * page's own origin is null too (its storage is the page's: logged at debug). The URL gets `?sumika-hub=<protocol>`,
 * its own query kept: a page of a newer protocol plants a URL no cache has seen.
 * @param {{hub?: string}|null} dataset the script tag's  @param {string} runtimeUrl sumika.js's URL
 * @param {{origin: string}} [loc] the page's location
 * @returns {string|null}
 */
export function hubAddress(dataset, runtimeUrl, loc = globalThis.location) {
  const v = dataset ? dataset.hub : undefined;
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  let url = null;
  try {
    if (!s) url = new URL('hub.html', runtimeUrl);
    else if (/^https?:\/\//i.test(s)) url = new URL(s);
  } catch (e) {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) { log.warn(BAD_VALUE); return null; }
  let own = null;
  try { own = loc ? loc.origin : null; } catch (e) { own = null; }
  if (own && url.origin === own) {
    log.debug(`the storage hub ${url.origin} is this page's own origin: its storage is used directly`);
    return null;
  }
  url.hash = '';
  url.searchParams.set(HUB_PARAM, String(HUB_PROTOCOL));
  return url.href;
}

function quotaError() {
  const msg = 'the storage hub\'s localStorage is full';
  try { return new DOMException(msg, 'QuotaExceededError'); } catch (e) { return Object.assign(new Error(msg), { name: 'QuotaExceededError' }); }
}

/** this page's own localStorage (a fallback's), or null */
function ownLocal() {
  try { return globalThis.localStorage || null; } catch (e) { return null; }
}

/** {key: string} of an object from the hub, only keys `ok` accepts and string values */
function cleanMap(raw, ok) {
  const out = new Map();
  if (isObj(raw)) for (const [k, v] of Object.entries(raw)) if (ok(k) && typeof v === 'string') out.set(k, v);
  return out;
}

/**
 * The hub's `sumika:` localStorage as a Storage look-alike (getItem, setItem, removeItem, key, length, clear): reads
 * from a map filled by the welcome snapshot and kept fresh by the hub's deltas; writes update the map and are posted,
 * never awaited. Keys outside `sumika:` are refused (setItem throws a TypeError, getItem answers null). setItem throws
 * QuotaExceededError when the estimate would pass QUOTA_UNITS, so StateStore's slim retry runs as over a full
 * localStorage. After a fallback it is this page's own localStorage.
 */
export class MirrorStorage {
  constructor(hub) {
    this._hub = hub;
    this._m = new Map();
    this._units = 0;          // otherUnits + every key's and value's length
  }

  _reset(map, otherUnits = 0) {
    this._m = map;
    this._units = otherUnits;
    for (const [k, v] of map) this._units += k.length + v.length;
  }

  _set(k, s) {
    const old = this._m.get(k);
    this._units += k.length + s.length - (old !== undefined ? k.length + old.length : 0);
    this._m.set(k, s);
  }

  _delete(k) {
    const old = this._m.get(k);
    if (old === undefined) return;
    this._units -= k.length + old.length;
    this._m.delete(k);
  }

  /** A change from the hub: the old value (null: absent) when it changed the map, else undefined. */
  _apply(k, v) {
    const old = this._m.has(k) ? this._m.get(k) : null;
    if (old === v) return undefined;
    if (v === null) this._delete(k);
    else this._set(k, v);
    return old;
  }

  getItem(k) {
    if (this._hub.state === 'fallback') { const s = ownLocal(); return s ? s.getItem(k) : null; }
    return isLocalKey(k) && this._m.has(k) ? this._m.get(k) : null;
  }

  setItem(k, v) {
    if (this._hub.state === 'fallback') { const s = ownLocal(); if (!s) throw quotaError(); s.setItem(k, v); return; }
    if (!isLocalKey(k)) throw new TypeError(`the storage hub keeps only ${LOCAL_PREFIX} keys`);
    const s = String(v);
    const old = this._m.get(k);
    const next = this._units + k.length + s.length - (old !== undefined ? k.length + old.length : 0);
    if (next > QUOTA_UNITS && next > this._units) throw quotaError();
    this._set(k, s);
    if (this._hub._withhold('local', k, old)) return;
    this._hub._send({ op: 'ls.set', key: k, value: s, seq: this._hub._numbered(k) });
  }

  removeItem(k) {
    if (this._hub.state === 'fallback') { const s = ownLocal(); if (s) s.removeItem(k); return; }
    if (!isLocalKey(k)) return;
    const old = this._m.get(k);
    this._delete(k);
    if (this._hub._withhold('local', k, old)) return;
    this._hub._send({ op: 'ls.remove', key: k, seq: this._hub._numbered(k) });
  }

  key(i) {
    if (this._hub.state === 'fallback') { const s = ownLocal(); return s ? s.key(i) : null; }
    const ks = [...this._m.keys()];
    return i >= 0 && i < ks.length ? ks[i] : null;
  }

  get length() {
    if (this._hub.state === 'fallback') { const s = ownLocal(); return s ? s.length : 0; }
    return this._m.size;
  }

  clear() { for (const k of [...this._m.keys()]) this.removeItem(k); }
}

/** The hub's `sumika.` sessionStorage: storage.js session's shape plus confirm(k, v). */
export class SessionMirror {
  constructor(hub) {
    this._hub = hub;
    this._m = new Map();
  }

  _reset(map) { this._m = map; }

  get(k) {
    if (this._hub.state === 'fallback') return pageSession.get(k);
    return isSessionKey(k) && this._m.has(k) ? this._m.get(k) : null;
  }

  set(k, v) {
    if (this._hub.state === 'fallback') { pageSession.set(k, v); return; }
    if (!isSessionKey(k)) return;
    const s = String(v);
    const old = this._m.get(k);
    this._m.set(k, s);
    if (this._hub._withhold('session', k, old)) return;
    this._hub._sessionWrote(k);
    this._hub._send({ op: 'ss.set', key: k, value: s });
  }

  remove(k) {
    if (this._hub.state === 'fallback') { pageSession.remove(k); return; }
    if (!isSessionKey(k)) return;
    const old = this._m.get(k);
    this._m.delete(k);
    if (this._hub._withhold('session', k, old)) return;
    this._hub._sessionWrote(k);
    this._hub._send({ op: 'ss.remove', key: k });
  }

  /**
   * True when the hub holds `k` = `v` once every earlier write reached it (a flush: Site.staleCheck's guard); false
   * when it failed there, differs, the hub is gone or does not answer.
   */
  confirm(k, v) {
    const hub = this._hub;
    if (hub.state === 'pending') return hub.ready().then(() => this.confirm(k, v));
    if (hub.state === 'fallback') return Promise.resolve(pageSession.get(k) === v);
    if (hub.state !== 'live') return Promise.resolve(false);
    return hub.flush({ session: [k] }).then(r => !r.failed.includes(k) && r.session[k] === v, () => false);
  }
}

/** `storage` events of the hub's localStorage: another tab's writes, as they reach the mirror. */
class HubEvents {
  constructor() { this._l = new Set(); }
  addEventListener(t, f) { if (t === 'storage' && typeof f === 'function') this._l.add(f); }
  removeEventListener(t, f) { if (t === 'storage') this._l.delete(f); }
  _fire(ev) {
    for (const f of [...this._l]) {
      try { f(ev); } catch (e) { log.warn('a storage listener failed', e); }
    }
  }
}

export class HubClient {
  /**
   * @param {string} url the hub page, hubAddress's
   * @param {{document?: Document, window?: Window|null, clock?: object, MessageChannel?: Function, debug?: boolean,
   *   MutationObserver?: Function|null}} [o] all injectable for tests; debug: the hub logs its ops (?sumika-debug);
   *   window: the page's (main.js), whose pagehide and pageshow the client hears first of Sumika's listeners (made
   *   before the Site, capture): from a pagehide with persisted to the pageshow nothing it writes is posted (_pageHide)
   */
  constructor(url, { document: doc, window: win = null, clock = realClock, MessageChannel: MC, debug = false, MutationObserver: MO } = {}) {
    this.url = url;
    this.origin = new URL(url).origin;
    /** 'pending' | 'live' | 'fallback' | 'gone' */
    this.state = 'pending';
    /** why it fell back: a refusal's reason, 'timeout' or 'unsupported'; null otherwise */
    this.reason = null;
    /** the welcome's caps {locks, channels, store, estimate}, null before it */
    this.caps = null;
    this.local = new MirrorStorage(this);
    this.session = new SessionMirror(this);
    this.events = new HubEvents();
    this._doc = doc;
    this.clock = clock;
    this._MC = MC;
    this._MO = MO;
    this._debug = !!debug;
    this._ready = null;
    this._settle = null;
    this._frame = null;
    this._port = null;
    this._acked = false;
    this._ackTimer = null;
    this._waitTimer = null;
    this._observer = null;
    this._queue = [];           // writes made while pending, in order
    this._seq = 0;              // the number of this page's last ls.* write (its `seq`)
    this._wrote = new Map();    // `sumika:` key -> seq of this page's last write of it, until a hub echo covers it
    this._syncs = new Set();    // per sync on its way: the session keys this page wrote since it was sent
    this._rid = 0;              // request ids, unique for the page (an unlock after a bfcache restore is a no-op)
    this._requests = new Map(); // rid -> {done(value), fail(error), timer}
    this._cid = 0;
    this._channels = new Map(); // cid -> HubChannel
    this._held = new Map();     // lock name -> grants held (wills are posted only for a held name)
    this._willed = new Set();   // `${name}\n${key}` posted in the current tenure
    this._stores = new Set();   // PortStores openStore made (closed when the hub goes)
    this._goneFns = [];
    this._failedSeen = new Set();
    this._locks = { request: (name, a, b) => this._lockRequest(name, a, b) };
    this._Channel = hubChannelClass(this);
    /** true from a pagehide with persisted (into the back/forward cache) to the pageshow: no write is posted (_pageHide) */
    this.hidden = false;
    this._withheld = null;      // while hidden: {local, session}: key -> its value before the first held write (null: absent)
    if (win && typeof win.addEventListener === 'function') {
      // registered before any other Sumika listener exists (main.js makes the client before the Site), and capture: at
      // the window's pagehide this one runs first, so the saves of the Site's and the states' listeners see `hidden`
      win.addEventListener('pagehide', ev => this._pageHide(ev), { capture: true });
      win.addEventListener('pageshow', () => this._pageShow(), { capture: true });
    }
  }

  /**
   * The decision, planting the frame at the first call: 'live' or 'fallback' (never rejects). The same promise after.
   * @returns {Promise<'live'|'fallback'>}
   */
  ready() {
    if (!this._ready) {
      this._ready = new Promise(resolve => { this._settle = resolve; });
      this._plant();
    }
    return this._ready;
  }

  /** the Web Locks subset of the hub (null while pending, or where the hub has none); after a fallback the page's */
  get locks() {
    if (this.state === 'fallback') return (globalThis.navigator && globalThis.navigator.locks) || null;
    if (this.state === 'pending') return null;
    if (this.state === 'live' && !(this.caps && this.caps.locks)) return null;
    return this._locks;
  }

  /** a BroadcastChannel look-alike class (null while pending, or where the hub has none); after a fallback the page's */
  get Channel() {
    if (this.state === 'fallback') return typeof BroadcastChannel === 'function' ? BroadcastChannel : null;
    if (this.state === 'pending') return null;
    if (this.state === 'live' && !(this.caps && this.caps.channels)) return null;
    return this._Channel;
  }

  /** fn() when the hub goes away mid-page (its pagehide, the frame removed) */
  onGone(fn) { if (typeof fn === 'function') this._goneFns.push(fn); }

  /**
   * Let the hub go for the rest of the page once it decided, telling no onGone listener (main.js: the visitor's choice
   * read through it turned Sumika off here, so nothing of Sumika runs on it): live, it is gone (port closed, requests
   * failed, stores closed); the frame is removed (a fallback's is gone already). Nothing is posted from here on.
   */
  close() {
    this._goneFns = [];
    if (this.state === 'live') this._gone();
    this._clearTimers();
    this._closePort();
    if (this._frame) { try { this._frame.remove(); } catch (e) { /* ignore */ } this._frame = null; }
  }

  // ---------------------------------------------------------------- the back/forward cache

  /**
   * The page goes into the back/forward cache (pagehide, persisted): its hub frame goes with it, and what the page posts
   * from here would wait at the cached frame and be applied after Back, over what another page (another origin, through
   * its own hub frame) wrote meanwhile (Firefox). The leave-flush wrote everything before the navigation began, so until
   * the pageshow nothing is posted: the mirrors take the writes (the pagehide saves, the idle clock; not a will), the
   * page's PortStores hold theirs, and Runtime._onPageHide asks no engine for its files (the engines' own store ports
   * are the hub's to retire: server.js pageHide). Lock releases and channel posts still go (late ones are no-ops).
   * Not persisted: nothing changes (the page's pagehide posts never reach the hub [measured, Chromium]). Only a live
   * or pending client.
   */
  _pageHide(ev) {
    if (!ev || ev.persisted !== true || this.hidden) return;
    if (this.state !== 'live' && this.state !== 'pending') return;
    this.hidden = true;
    this._withheld = { local: new Map(), session: new Map() };
    for (const s of this._stores) s.hold(true);
  }

  /**
   * Shown again after a pagehide into the cache (before the Site's pageshow, which syncs and restarts): the writes held
   * meanwhile are taken back, so the mirrors hold what the hub last had from this page and the sync's delta brings what
   * other pages wrote since; posting resumes.
   */
  _pageShow() {
    if (!this.hidden) return;
    this.hidden = false;
    const w = this._withheld;
    this._withheld = null;
    for (const [k, v] of w.local) this.local._apply(k, v);
    for (const [k, v] of w.session) { if (v === null) this.session._m.delete(k); else this.session._m.set(k, v); }
    for (const s of this._stores) s.hold(false);
  }

  /**
   * A mirror's write while hidden: true (not posted), with the value `k` had before the first such write (`old`;
   * null: absent) noted for _pageShow. False when not hidden: post it.
   */
  _withhold(area, k, old) {
    if (!this.hidden) return false;
    const m = this._withheld[area];
    if (!m.has(k)) m.set(k, old === undefined ? null : old);
    return true;
  }

  // ---------------------------------------------------------------- the handshake (CONTRACTS "Hub protocol")

  _plant() {
    const doc = this._doc !== undefined ? this._doc : globalThis.document;
    const MC = this._MC !== undefined ? this._MC : globalThis.MessageChannel;
    if (!doc || typeof doc.createElement !== 'function' || typeof MC !== 'function') { this._fallback('unsupported'); return; }
    let f;
    try {
      f = doc.createElement('iframe');
      f.hidden = true;
      if (f.style && typeof f.style.setProperty === 'function') f.style.setProperty('display', 'none', 'important');
      f.tabIndex = -1;
      f.setAttribute('aria-hidden', 'true');
      f.title = 'Sumika storage';
      f.addEventListener('load', () => this._onFrameLoad());
      f.src = this.url;
      this._frame = f;
      (doc.body || doc.documentElement).appendChild(f);
    } catch (e) {
      log.warn('could not plant the storage hub', e);
      this._fallback('unsupported');
      return;
    }
    this._waitTimer = this.clock.setTimeout(() => this._late(), HUB_WAIT_MS);
  }

  /** Each document the frame loads gets a hello until one is acked (an error page first, then the hub). */
  _onFrameLoad() {
    if (this.state !== 'pending' || this._acked) return;
    this._hello();
    if (this._ackTimer === null) this._ackTimer = this.clock.setTimeout(() => this._late(true), HUB_ACK_MS);
  }

  _hello() {
    const MC = this._MC !== undefined ? this._MC : globalThis.MessageChannel;
    if (this._port) this._closePort();
    let ch;
    try {
      ch = new MC();
      const port = ch.port1;
      port.onmessage = ev => this._onPortMessage(port, ev && ev.data);
      if (typeof port.start === 'function') port.start();
      this._port = port;
      const w = this._frame && this._frame.contentWindow;
      if (!w) return;
      // targetOrigin: only a document of the hub's origin receives it (an error page or another site gets nothing)
      w.postMessage({ [HELLO]: 1, v: HUB_PROTOCOL, debug: this._debug }, this.origin, [ch.port2]);
    } catch (e) {
      log.debug('the storage hub hello was not sent', e);
    }
  }

  /**
   * A timer ran out (ack: true for the ack's). The timer and the hub's answer run on one event loop and their order
   * after a long task is not specified, so one more task first; then still no answer: the fallback.
   */
  _late(ack = false) {
    this.clock.setTimeout(() => {
      if (this.state !== 'pending') return;
      if (ack && this._acked) return;
      this._fallback('timeout');
    }, 0);
  }

  _onPortMessage(port, m) {
    if (port !== this._port || !isObj(m) || typeof m.t !== 'string') return;
    if (this.state === 'pending') {
      if (m.t === 'ack') {
        this._acked = true;
        if (this._ackTimer !== null) { this.clock.clearTimeout(this._ackTimer); this._ackTimer = null; }
      } else if (m.t === 'welcome') {
        this._welcome(m);
      } else if (m.t === 'refused') {
        const v = Array.isArray(m.v) && m.v.length === 2 && m.v.every(Number.isInteger) ? m.v : null;
        this._fallback(REASONS.includes(m.reason) ? m.reason : 'refused', v);
      }
      return;
    }
    if (this.state !== 'live') return;
    switch (m.t) {
      case 'reply': this._onReply(m); break;
      case 'failed': this._onFailed(m); break;
      case 'bc': this._onChannel(m); break;
      case 'storage': this._applySnap(m.snap, m.seq); break;
      case 'gone': if (m.persisted !== true) this._gone(); break;
      default: break;
    }
  }

  _welcome(m) {
    if (m.v !== HUB_PROTOCOL) { this._fallback('version', Number.isInteger(m.v) ? [m.v, m.v] : null); return; }
    const c = isObj(m.caps) ? m.caps : {};
    // store 'memory' (a hub without IndexedDB: Firefox's private windows before 115) is no reason to fall back: this
    // page's own engine worker would keep its save files in memory there too (a worker has no localStorage), and the
    // dropped files take only an IndexedDB store; the hub still shares the visitor's localStorage and sessionStorage
    this.caps = {
      locks: c.locks === true, channels: c.channels === true, store: c.store === 'indexeddb' ? 'indexeddb' : 'memory',
      estimate: c.estimate === true,
    };
    const other = Number(m.otherUnits);
    this.local._reset(cleanMap(m.local, isLocalKey), Number.isFinite(other) && other > 0 ? other : 0);
    this.session._reset(cleanMap(m.session, isSessionKey));
    this.state = 'live';
    this._clearTimers();
    // the writes made while pending, on top of the snapshot, in order
    const q = this._queue;
    this._queue = [];
    for (const op of q) {
      if (op.op === 'ls.set') this.local._set(op.key, op.value);
      else if (op.op === 'ls.remove') this.local._delete(op.key);
      else if (op.op === 'ss.set') this.session._m.set(op.key, op.value);
      else if (op.op === 'ss.remove') this.session._m.delete(op.key);
      this._send(op);
    }
    this._watch();
    log.debug(`the storage hub ${this.origin} keeps this page's data`);
    this._settle('live');
  }

  /** The hub is not usable: this page keeps its data on its own origin for good. */
  _fallback(reason, v = null) {
    if (this.state !== 'pending') return;
    this.state = 'fallback';
    this.reason = reason;
    this._clearTimers();
    this._closePort();
    if (this._frame) { try { this._frame.remove(); } catch (e) { /* ignore */ } this._frame = null; }
    if (platform.hub === this) platform.clear();
    // writes made while pending go where a page without the hub writes them
    const q = this._queue;
    this._queue = [];
    for (const op of q) this._today(op);
    const page = (() => { try { return globalThis.location.origin; } catch (e) { return 'this page'; } })();
    let text;
    if (reason === 'version' && v) text = `the storage hub speaks protocol ${v[0] === v[1] ? v[0] : `${v[0]}–${v[1]}`}, this page ${HUB_PROTOCOL}: this page keeps its data on its own origin`;
    else if (reason === 'allowlist') text = 'the storage hub\'s sumika/hub.json is missing or unreadable, so it answers no page: this page keeps its data on its own origin';
    else {
      text = `the storage hub ${this.origin} is not usable (${reason}): this page keeps the visitor's data for ${page}`;
      if (reason === 'timeout') text += ' (check that hub.html is reachable, may be framed: no X-Frame-Options, frame-ancestors, and that the page\'s CSP allows frame-src)';
    }
    if (INFO_REASONS.has(reason)) log.info(text);
    else log.warn(text);
    if (this._settle) this._settle('fallback');
  }

  _today(op) {
    if (op.op === 'ls.set' || op.op === 'ls.remove') {
      const s = ownLocal();
      try { if (s) { if (op.op === 'ls.set') s.setItem(op.key, op.value); else s.removeItem(op.key); } } catch (e) { /* storage full or blocked */ }
    } else if (op.op === 'ss.set') pageSession.set(op.key, op.value);
    else if (op.op === 'ss.remove') pageSession.remove(op.key);
  }

  _clearTimers() {
    if (this._ackTimer !== null) { this.clock.clearTimeout(this._ackTimer); this._ackTimer = null; }
    if (this._waitTimer !== null) { this.clock.clearTimeout(this._waitTimer); this._waitTimer = null; }
  }

  _closePort() {
    if (!this._port) return;
    try { this._port.onmessage = null; this._port.close(); } catch (e) { /* ignore */ }
    this._port = null;
  }

  /** Live: the frame removed from the page (devtools, a host page's script) counts as the hub's going. */
  _watch() {
    const MO = this._MO !== undefined ? this._MO : globalThis.MutationObserver;
    const f = this._frame;
    if (typeof MO !== 'function' || !f || !f.parentNode) return;
    try {
      this._observer = new MO(() => { if (this._frame && !this._frame.isConnected) this._gone(); });
      this._observer.observe(f.parentNode, { childList: true });
    } catch (e) {
      this._observer = null;
    }
  }

  // ---------------------------------------------------------------- the ops (CONTRACTS "Hub protocol")

  /**
   * Post an op: queued while pending, the page's own storage after a fallback, dropped once the hub is gone. A write
   * while hidden (the mirrors and will() hold theirs before this) is never posted.
   */
  _send(msg, transfer = null, rethrow = false) {
    if (this.hidden && WRITES.has(msg.op) && this.state !== 'fallback') return;
    if (this.state === 'pending') { this._queue.push(msg); return; }
    if (this.state === 'fallback') { this._today(msg); return; }
    if (this.state !== 'live' || !this._port) return;
    try {
      this._port.postMessage(msg, transfer || []);
    } catch (e) {
      if (rethrow) throw e;
      log.once(`hub-post:${msg.op}`, `a ${msg.op} message to the storage hub could not be sent`, e);
    }
  }

  /** An op with a reply: its value, or a rejection (the hub's error, gone, or no answer within STORE_OP_MS). */
  _ask(op, fields = {}) {
    if (this.state !== 'live') return Promise.reject(new Error('the storage hub is not live'));
    return new Promise((resolve, reject) => {
      const rid = ++this._rid;
      const timer = this.clock.setTimeout(() => {
        if (this._requests.delete(rid)) reject(new Error(`the storage hub did not answer ${op}`));
      }, STORE_OP_MS);
      this._requests.set(rid, {
        done: v => { this.clock.clearTimeout(timer); resolve(v); },
        fail: e => { this.clock.clearTimeout(timer); reject(new Error(e)); },
      });
      this._send({ ...fields, op, rid });
    });
  }

  _onReply(m) {
    const r = typeof m.rid === 'number' ? this._requests.get(m.rid) : null;
    if (!r) {
      // a reply this page stopped waiting for (a sync past STORE_OP_MS): the hub counts its delta as told, so it is
      // applied all the same, or the mirror would miss those writes for good
      if (m.ok === true && isObj(m.value)) this._applySnap(m.value.snap, m.value.seq);
      return;
    }
    this._requests.delete(m.rid);
    if (m.ok === true) r.done(m.value);
    else r.fail(String(m.error || 'failed'));
  }

  /** A write the hub could not do (its quota, other data, blocked storage), or another op it refused: logged once each. */
  _onFailed(m) {
    const key = typeof m.key === 'string' ? m.key : '';
    const write = !m.op || /^(ls|ss)\./.test(String(m.op));
    const id = write ? key : `op:${m.op}`;
    if (this._failedSeen.has(id)) return;
    this._failedSeen.add(id);
    if (write) log.warn(`the storage hub did not store ${key || 'a write'} (storage full or blocked)`);
    else log.warn(`the storage hub refused ${m.op}: ${String(m.error || 'failed')}`);
  }

  /**
   * Every earlier op applied at the hub (FIFO): {failed: keys whose write failed there since the last flush, session:
   * {key: its value at the hub or null}} for the session keys asked.
   */
  flush({ session: keys = [] } = {}) {
    const ask = Array.isArray(keys) ? keys.filter(isSessionKey) : [];
    return this._ask('flush', { session: ask }).then(v => {
      const failed = isObj(v) && Array.isArray(v.failed) ? v.failed.filter(k => typeof k === 'string') : [];
      const session = {};
      const got = isObj(v) && isObj(v.session) ? v.session : {};
      for (const k of ask) session[k] = typeof got[k] === 'string' ? got[k] : null;
      for (const k of failed) this._onFailed({ key: k });
      return { failed, session };
    });
  }

  /**
   * A page restored from the back/forward cache (Site's pageshow): it missed the storage events, and another page of
   * this tab may have changed the hub's session keys meanwhile (the tab marker: a ghost called or changed there). So a
   * full delta, and the session mirror replaced by the hub's `sumika.` keys, but for the keys this page wrote after the
   * sync was sent. Every ls.* write this page posted before is applied at the hub by now (one FIFO port), so none is
   * still crossing a delta; what its pagehide into the cache wrote was never posted, and _pageShow took it back.
   */
  sync() {
    this._wrote.clear();
    const after = new Set();
    this._syncs.add(after);
    return this._ask('sync').then(v => {
      this._syncs.delete(after);
      if (!isObj(v)) return;
      this._applySnap(v.snap, v.seq);
      if (!isObj(v.session)) return;          // an older hub: the delta only
      const m = cleanMap(v.session, isSessionKey);
      for (const k of after) {
        if (this.session._m.has(k)) m.set(k, this.session._m.get(k));
        else m.delete(k);
      }
      this.session._reset(m);
    }, e => {
      this._syncs.delete(after);
      throw e;
    });
  }

  /** The `seq` of a new ls.* write of `k` (numbered while pending too: the queue is posted in order). */
  _numbered(k) {
    const n = ++this._seq;
    this._wrote.set(k, n);
    return n;
  }

  /** A session write: noted for every sync on its way, whose reply must not take it back. */
  _sessionWrote(k) {
    for (const s of this._syncs) s.add(k);
  }

  /** () => Promise<{usage, quota}> of the hub's storage, or null where it has none (DropStore's room check). */
  estimator() {
    if (this.state === 'fallback') {
      const s = globalThis.navigator && globalThis.navigator.storage;
      return s && typeof s.estimate === 'function' ? () => s.estimate() : null;
    }
    if (this.state !== 'live' || !(this.caps && this.caps.estimate)) return null;
    return () => this._ask('estimate').then(v => ({
      usage: isObj(v) && Number.isFinite(v.usage) ? v.usage : 0,
      quota: isObj(v) && Number.isFinite(v.quota) ? v.quota : 0,
    }));
  }

  /**
   * One fresh MessagePort to the hub's IndexedDB for one user (an engine start: the worker's PortStore; openStore). A hub
   * not live: a port that answers at once with this page's memory (`local`, PortStore: nothing sent), so nothing
   * reaches another store and nothing waits. `retire` (an engine start's, the default; not openStore's): the hub takes
   * no write on the port once its document went into the back/forward cache (the restart after Back starts every engine
   * again with a new port, so a save the old worker posts late never lands over another page's).
   * @param {{retire?: boolean}} [o]
   */
  storePort({ retire = true } = {}) {
    const MC = this._MC !== undefined ? this._MC : globalThis.MessageChannel;
    const ch = new MC();
    if (this.state !== 'live') {
      ch.port2.postMessage({ t: 'store', kind: 'memory', local: true });
      return ch.port1;
    }
    this._send({ op: 'store', pid: ++this._rid, port: ch.port2, ...(retire ? { retire: true } : {}) }, [ch.port2]);
    return ch.port1;
  }

  /**
   * The page's IndexedDB store (core/storage.js Store's interface: drops.js): a PortStore on the hub's database. Only
   * the database the hub serves (`sumika`); while pending, once decided; after a fallback, the page's own.
   */
  openStore(namespace = STORE_DB) {
    if (this.state === 'pending') return this.ready().then(() => platformStore(namespace));
    if (this.state === 'fallback') return Store.open(namespace);
    if (namespace !== STORE_DB) return PortStore.open(null);
    return PortStore.open(this.storePort({ retire: false }), { clock: this.clock }).then(s => {
      if (s.closed) return s;
      this._stores.add(s);
      if (this.hidden) s.hold(true);
      return s;
    });
  }

  /** The hub is gone: the PortStores openStore made are let go (DropStore opens another, this page's memory). */
  _closeStores() {
    for (const s of this._stores) s.close();
    this._stores.clear();
  }

  /**
   * A will: when this page's lock `name` goes (unlock, or the hub's pagehide), the hub sets `stamp` in the
   * JSON object at `key` to its own clock. Posted once per name and key per tenure, only while the name is held here.
   */
  will(name, key, stamp) {
    if (this.state !== 'live' || this.hidden || !isName(name) || !isLocalKey(key) || !STAMP.test(String(stamp))) return;
    if (!this._held.get(name)) return;
    const id = `${name}\n${key}`;
    if (this._willed.has(id)) return;
    this._willed.add(id);
    this._send({ op: 'will', name, key, stamp });
  }

  /**
   * The delta of the hub's `sumika:` keys: applied to the mirror, one `storage` event per key it changed. `seq`, the
   * hub's echo, is the last of this page's ls.* writes the hub had handled when it took the delta: an entry for a key
   * this page wrote after that is skipped, since that write lands at the hub next and wins there, as this page's
   * later write would in its own localStorage. Without an echo (an older hub) every entry applies. An entry for a key
   * written while hidden (never posted) replaces that write, which _pageShow then leaves as it is: the mirror holds
   * what the hub told.
   */
  _applySnap(snap, seq) {
    const at = Number.isSafeInteger(seq) ? seq : null;
    if (isObj(snap)) {
      for (const [k, v] of Object.entries(snap)) {
        if (!isLocalKey(k) || !(v === null || typeof v === 'string')) continue;
        if (at !== null && (this._wrote.get(k) || 0) > at) continue;
        if (this._withheld) this._withheld.local.delete(k);
        const old = this.local._apply(k, v);
        if (old !== undefined) this.events._fire({ key: k, oldValue: old, newValue: v, storageArea: this.local });
      }
    }
    if (at !== null) for (const [k, n] of [...this._wrote]) if (n <= at) this._wrote.delete(k);
  }

  // ---------------------------------------------------------------- locks and channels

  /**
   * navigator.locks.request's subset: (name, cb) or (name, {ifAvailable}, cb); exclusive only. Not granted (ifAvailable)
   * → cb(null). The hub gone or failing: the three-argument call (GhostLock) gets cb(null), never "run anyway"; the
   * two-argument call (DropStore's read-modify-write) rejects, so it never runs without the lock.
   */
  _lockRequest(name, a, b) {
    const two = typeof a === 'function' && b === undefined;
    const opts = two ? {} : a;
    const cb = two ? a : b;
    if (typeof cb !== 'function') return Promise.reject(new TypeError('a lock request needs a callback'));
    if (!isName(name)) return Promise.reject(new TypeError(`the storage hub's lock names start with sumika: ${name}`));
    if (opts != null && !isObj(opts)) return Promise.reject(new TypeError('lock options must be an object'));
    for (const k of Object.keys(opts || {})) {
      if (k === 'ifAvailable' || (k === 'mode' && opts.mode === 'exclusive')) continue;
      return Promise.reject(new TypeError(`the storage hub's locks do not offer ${k}${k === 'mode' ? ` ${opts.mode}` : ''}`));
    }
    const ifAvailable = !!(opts && opts.ifAvailable);
    return new Promise((resolve, reject) => {
      // not granted (ifAvailable, or a wait the hub let go of), or the hub gone or failing
      const refuse = why => {
        if (two) { reject(new Error(`the storage hub's lock ${name}: ${why}`)); return; }
        Promise.resolve().then(() => cb(null)).then(resolve, reject);
      };
      if (this.state !== 'live') { refuse('gone'); return; }
      const rid = ++this._rid;
      this._requests.set(rid, {
        lock: true,
        done: v => {
          if (!isObj(v) || v.granted !== true) { refuse('not granted'); return; }
          this._applySnap(v.snap, v.seq);
          this._held.set(name, (this._held.get(name) || 0) + 1);
          for (const id of [...this._willed]) if (id.startsWith(`${name}\n`)) this._willed.delete(id);
          const release = () => {
            const n = (this._held.get(name) || 1) - 1;
            if (n > 0) this._held.set(name, n); else this._held.delete(name);
            this._send({ op: 'unlock', rid });
          };
          let out;
          try { out = cb({ name, mode: 'exclusive' }); } catch (e) { release(); reject(e); return; }
          Promise.resolve(out).then(x => { release(); resolve(x); }, e => { release(); reject(e); });
        },
        fail: () => refuse('gone'),
      });
      this._send({ op: 'lock', rid, name, ifAvailable });
    });
  }

  /** A channel delivery: its delta first (also for a channel this page closed meanwhile: the hub counts it told). */
  _onChannel(m) {
    this._applySnap(m.snap, m.seq);
    const ch = typeof m.cid === 'number' ? this._channels.get(m.cid) : null;
    if (ch) ch._deliver(m.data);
  }

  // ---------------------------------------------------------------- the hub going away

  _gone() {
    if (this.state !== 'live') return;
    this.state = 'gone';
    if (this._observer) { try { this._observer.disconnect(); } catch (e) { /* ignore */ } this._observer = null; }
    this._closePort();
    const reqs = [...this._requests.values()];
    this._requests.clear();
    for (const r of reqs) { try { r.fail('gone'); } catch (e) { /* ignore */ } }
    this._held.clear();
    this._closeStores();
    for (const fn of this._goneFns) { try { fn(); } catch (e) { log.warn('a storage hub listener failed', e); } }
  }
}

/** The hub's BroadcastChannel look-alike for one client: one real channel in the hub per object. */
function hubChannelClass(hub) {
  return class HubChannel {
    constructor(name) {
      const n = String(name);
      if (!isName(n)) throw new TypeError(`the storage hub's channel names start with sumika: ${n}`);
      this.name = n;
      this.onmessage = null;
      this._l = new Set();
      this._closed = false;
      this._cid = ++hub._cid;
      hub._channels.set(this._cid, this);
      hub._send({ op: 'bc.open', cid: this._cid, name: n });
    }

    postMessage(data) {
      if (this._closed) throw new Error('the channel is closed');
      hub._send({ op: 'bc.post', cid: this._cid, data }, null, true);
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      hub._channels.delete(this._cid);
      hub._send({ op: 'bc.close', cid: this._cid });
    }

    addEventListener(t, f) { if (t === 'message' && typeof f === 'function') this._l.add(f); }
    removeEventListener(t, f) { if (t === 'message') this._l.delete(f); }

    _deliver(data) {
      if (this._closed) return;
      const ev = { data };
      if (typeof this.onmessage === 'function') { try { this.onmessage(ev); } catch (e) { log.warn('a channel listener failed', e); } }
      for (const f of [...this._l]) { try { f(ev); } catch (e) { log.warn('a channel listener failed', e); } }
    }
  };
}

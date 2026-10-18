// Fakes for the storage hub's page side (CONTRACTS "Hub protocol"), no test file: MessagePort pairs that
// deliver in microtasks (deterministic under FakeClock), a hub written from the protocol (not src/hub/: the page side is
// tested against the protocol, the join's e2e test runs both halves), and the frame and document HubClient plants into.
// One FakeHubSite is the hub origin's storage (its localStorage, IndexedDB, Web Locks, channels) shared by every hub
// document (one per planted frame: a tab of some origin); a tab's sessionStorage at the hub origin is per tab.
import { memoryStorage } from '../../src/core/state.js';
import { FakeLocks, busChannel } from './multi_world.mjs';

export const HUB_ORIGIN = 'https://sumika.example';
export const HUB_URL = `${HUB_ORIGIN}/sumika/hub.html?sumika-hub=1`;

// ---------------------------------------------------------------- ports

export class FakePort {
  constructor() {
    this.other = null;
    this.closed = false;
    this._on = null;
    this._q = [];
  }
  get onmessage() { return this._on; }
  set onmessage(f) {
    this._on = f;
    if (typeof f === 'function') { const q = this._q; this._q = []; for (const m of q) f({ data: m }); }
  }
  start() {}
  postMessage(msg, transfer = []) {
    if (this.closed) return;
    const copy = cloneMsg(msg, transfer);
    const to = this.other;
    queueMicrotask(() => { if (to && !to.closed) to._deliver(copy); });
  }
  _deliver(m) {
    if (typeof this._on === 'function') this._on({ data: m });
    else this._q.push(m);
  }
  close() {
    this.closed = true;
    if (this.other) this.other.other = null;
    this.other = null;
  }
}

/** A MessageChannel stand-in: two entangled FakePorts. */
export class FakeChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

/** Structured clone, ports passed through when they are in `transfer` (DataCloneError otherwise, as in browsers). */
function cloneMsg(msg, transfer) {
  const ports = new Set((transfer || []).filter(x => x instanceof FakePort));
  const clone = x => {
    if (x instanceof FakePort) {
      if (!ports.has(x)) throw new DOMException('a port must be transferred', 'DataCloneError');
      return x;
    }
    if (Array.isArray(x)) return x.map(clone);
    if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      const o = {};
      for (const [k, v] of Object.entries(x)) o[k] = clone(v);
      return o;
    }
    return structuredClone(x);
  };
  return clone(msg);
}

// ---------------------------------------------------------------- the hub

const isLocal = k => typeof k === 'string' && k.startsWith('sumika:');
const isSession = k => typeof k === 'string' && k.startsWith('sumika.');
const isName = n => typeof n === 'string' && n.startsWith('sumika');

/**
 * The hub origin's storage. Knobs: refuse (a reason: every hello refused), noAck, holdWelcome (a promise the welcome
 * waits for), caps, otherUnits, failKeys (ls.set / ss.set of these keys fail: quota), log (every op received).
 */
export class FakeHubSite {
  constructor() {
    this.local = memoryStorage();
    this.idb = new Map();
    this.locks = new FakeLocks();
    this.Bus = busChannel();
    this.docs = new Set();
    this.log = [];
    this.refuse = null;
    this.noAck = false;
    this.holdWelcome = null;
    this.caps = { locks: true, channels: true, store: 'indexeddb', estimate: true };
    this.otherUnits = 0;
    this.failKeys = new Set();
    this.now = 5000;
  }
  /** this tab's sessionStorage at the hub's origin (one per browser tab) */
  tab() { return memoryStorage(); }
}

/** One hub document (a planted frame's), serving one page over its port. */
export class FakeHubDoc {
  constructor(site, session) {
    this.site = site;
    this.session = session;
    this.port = null;
    this.known = new Map();
    this.held = new Map();       // rid -> {name, release}
    this.wills = new Map();      // name -> Map(key -> stamp)
    this.channels = new Map();
    this.storePorts = new Set();
    this.retiring = new Set();   // gates of the store ports marked `retire`, not retired yet
    this.waiting = new Map();    // rid -> {answered}: lock requests not granted yet
    this.failed = [];
    this.gone = false;
    this.seq = 0;                // the page's last ls.* seq handled, echoed with every delta
    site.docs.add(this);
  }

  /** this tab's `sumika.` session keys (the welcome's, a sync reply's) */
  sessionMap() {
    const session = {};
    for (let i = 0; i < this.session.length; i++) { const k = this.session.key(i); if (isSession(k)) session[k] = this.session.getItem(k); }
    return session;
  }

  hello(msg, port) {
    if (!msg || msg.sumikaHubHello !== 1 || !port) return;
    if (this.port) { port.postMessage({ t: 'refused', reason: 'busy', v: [1, 1] }); port.close(); return; }
    this.port = port;
    this.hellos = (this.hellos || 0) + 1;
    port.onmessage = ev => this.op(ev.data);
    if (!this.site.noAck) port.postMessage({ t: 'ack' });
    const go = () => {
      if (this.gone || !this.port) return;
      if (this.site.refuse) {
        port.postMessage({ t: 'refused', reason: this.site.refuse, v: [1, 1] });
        port.close();
        this.port = null;
        return;
      }
      const local = {};
      for (let i = 0; i < this.site.local.length; i++) {
        const k = this.site.local.key(i);
        if (isLocal(k)) { local[k] = this.site.local.getItem(k); this.known.set(k, local[k]); }
      }
      port.postMessage({ t: 'welcome', v: 1, local, session: this.sessionMap(), otherUnits: this.site.otherUnits, caps: { ...this.site.caps } });
    };
    if (this.site.holdWelcome) this.site.holdWelcome.then(go);
    else queueMicrotask(go);
  }

  post(m) { if (this.port) this.port.postMessage(m); }
  reply(rid, value) { this.post({ t: 'reply', rid, ok: true, value }); }

  /** the delta against `known` */
  delta() {
    const snap = {};
    const ls = this.site.local;
    const seen = new Set();
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!isLocal(k)) continue;
      seen.add(k);
      const v = ls.getItem(k);
      if (this.known.get(k) !== v) { snap[k] = v; this.known.set(k, v); }
    }
    for (const k of [...this.known.keys()]) if (!seen.has(k)) { snap[k] = null; this.known.delete(k); }
    return snap;
  }

  /** another document of the origin wrote localStorage: the browser's storage event here (`storage`) */
  storageEvent() { if (this.port && !this.gone) this.post({ t: 'storage', snap: this.delta(), seq: this.seq }); }

  op(m) {
    this.site.log.push(m);
    const s = this.site;
    if ((m.op === 'ls.set' || m.op === 'ls.remove') && Number.isSafeInteger(m.seq) && m.seq > this.seq) this.seq = m.seq;
    switch (m.op) {
      case 'ls.set': {
        if (!isLocal(m.key)) return;
        if (s.failKeys.has(m.key)) { this.failed.push(m.key); this.post({ t: 'failed', op: m.op, key: m.key, error: 'QuotaExceededError' }); return; }
        s.local.setItem(m.key, String(m.value));
        this.known.set(m.key, String(m.value));
        for (const d of s.docs) if (d !== this) d.storageEvent();
        return;
      }
      case 'ls.remove': {
        if (!isLocal(m.key)) return;
        s.local.removeItem(m.key);
        this.known.delete(m.key);
        for (const d of s.docs) if (d !== this) d.storageEvent();
        return;
      }
      case 'ss.set':
        if (!isSession(m.key)) return;
        if (s.failKeys.has(m.key)) { this.failed.push(m.key); return; }
        this.session.setItem(m.key, String(m.value));
        return;
      case 'ss.remove': if (isSession(m.key)) this.session.removeItem(m.key); return;
      case 'flush': {
        const session = {};
        for (const k of m.session || []) session[k] = this.session.getItem(k);
        this.reply(m.rid, { failed: this.failed.splice(0), session });
        return;
      }
      case 'sync': this.reply(m.rid, { snap: this.delta(), session: this.sessionMap(), seq: this.seq }); return;
      case 'estimate': this.reply(m.rid, { usage: 1000, quota: 1e9 }); return;
      case 'lock': {
        if (!isName(m.name)) { this.post({ t: 'reply', rid: m.rid, ok: false, error: 'name' }); return; }
        const entry = { answered: false };
        this.waiting.set(m.rid, entry);
        s.locks.request(m.name, m.ifAvailable ? { ifAvailable: true } : {}, lock => {
          this.waiting.delete(m.rid);
          if (this.gone || entry.answered) return undefined;      // taken back at the hub's pagehide: let go at once
          entry.answered = true;
          if (!lock) { this.reply(m.rid, { granted: false }); return undefined; }
          return new Promise(release => {
            this.held.set(m.rid, { name: m.name, release });
            this.reply(m.rid, { granted: true, snap: this.delta(), seq: this.seq });
          });
        });
        return;
      }
      case 'unlock': {
        const h = this.held.get(m.rid);
        if (!h) return;
        this.held.delete(m.rid);
        this.commitWills(h.name);
        h.release();
        return;
      }
      case 'will': {
        if (![...this.held.values()].some(h => h.name === m.name)) return;
        if (!this.wills.has(m.name)) this.wills.set(m.name, new Map());
        this.wills.get(m.name).set(m.key, m.stamp);
        return;
      }
      case 'bc.open': {
        if (!isName(m.name)) return;
        const c = new s.Bus(m.name);
        c.onmessage = ev => this.post({ t: 'bc', cid: m.cid, data: ev.data, snap: this.delta(), seq: this.seq });
        this.channels.set(m.cid, c);
        return;
      }
      case 'bc.post': { const c = this.channels.get(m.cid); if (c) c.postMessage(m.data); return; }
      case 'bc.close': { const c = this.channels.get(m.cid); if (c) { c.close(); this.channels.delete(m.cid); } return; }
      case 'store': this.serveStore(m.port, m.retire === true); return;
      default:
        if (typeof m.rid === 'number') this.post({ t: 'reply', rid: m.rid, ok: false, error: 'unknown op' });
    }
  }

  commitWills(name) {
    const w = this.wills.get(name);
    if (!w) return;
    for (const [key, stamp] of w) {
      const v = this.site.local.getItem(key);
      if (v == null) continue;
      try {
        const o = JSON.parse(v);
        if (o && typeof o === 'object' && typeof o[stamp] === 'number') {
          o[stamp] = this.site.now;
          this.site.local.setItem(key, JSON.stringify(o));
        }
      } catch (e) { /* skipped */ }
    }
    this.wills.delete(name);
  }

  /**
   * a store port on the site's IndexedDB stand-in; `retire` (the page's mark on an engine start's port):
   * once this document's pagehide with persisted ran, its set and delete are answered 'retired' and store nothing
   */
  serveStore(port, retire = false) {
    if (!port) return;
    this.storePorts.add(port);
    const s = this.site;
    const gate = retire ? { retired: false } : null;
    if (gate) this.retiring.add(gate);
    port.onmessage = ev => {
      const m = ev.data;
      s.log.push({ store: m.op, key: m.key });
      const ok = value => port.postMessage({ rid: m.rid, ok: true, value });
      if (gate && gate.retired && (m.op === 'set' || m.op === 'delete')) { port.postMessage({ rid: m.rid, ok: false, error: 'retired' }); return; }
      if (s.storeFails) { port.postMessage({ rid: m.rid, ok: false, error: 'NotReadableError' }); return; }
      if (s.storeSilent) return;
      switch (m.op) {
        case 'read': case 'get': ok(s.idb.has(m.key) ? structuredClone(s.idb.get(m.key)) : undefined); return;
        case 'set': s.idb.set(m.key, structuredClone(m.value)); ok(s.caps.store === 'indexeddb'); return;   // memory is no storage
        case 'delete': s.idb.delete(m.key); ok(true); return;
        case 'keys': ok([...s.idb.keys()].filter(k => k.startsWith(m.prefix || ''))); return;
        default: port.postMessage({ rid: m.rid, ok: false, error: 'unknown op' });
      }
    };
    port.postMessage({ t: 'store', kind: s.caps.store });
  }

  /**
   * the hub's pagehide (as src/hub/ does it): every lock request not granted yet answered 'aborted' and taken back,
   * wills committed, held locks let go, `gone` posted; a document that goes (not persisted) closes its channels and,
   * with it, its store ports; one kept in the back/forward cache keeps both, and retires the ports marked `retire`
   */
  pagehide(persisted = false) {
    if (persisted) { for (const g of this.retiring) g.retired = true; this.retiring.clear(); }
    for (const [rid, e] of [...this.waiting]) {
      if (!e.answered) { e.answered = true; this.post({ t: 'reply', rid, ok: false, error: 'aborted' }); }
      this.waiting.delete(rid);
    }
    for (const [rid, h] of [...this.held]) { this.commitWills(h.name); h.release(); this.held.delete(rid); }
    this.post({ t: 'gone', persisted });
    if (!persisted) {
      this.gone = true;
      for (const c of this.channels.values()) c.close();
      for (const p of this.storePorts) p.close();
      this.storePorts.clear();
      this.site.docs.delete(this);
    }
  }
}

// ---------------------------------------------------------------- the page's document and the planted frame

class FakeFrame {
  constructor(page) {
    this.page = page;
    this.style = { props: {}, setProperty(k, v, p) { this.props[k] = [v, p]; } };
    this.attrs = {};
    this.listeners = new Map();
    this.isConnected = false;
    this.parentNode = null;
    this.contentWindow = null;
    this.src = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, f) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(f); }
  fire(t) { for (const f of this.listeners.get(t) || []) f({ type: t }); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(c => c !== this);
    this.parentNode = null;
    this.isConnected = false;
    this.page.removed.push(this);
    for (const o of this.page.observers) o.cb([]);
  }
  /** a document loads in the frame: the hub (its doc answers hellos from its own origin) or an error page */
  load(kind = 'hub') {
    if (kind === 'hub') {
      const doc = new FakeHubDoc(this.page.site, this.page.hubSession);
      this.hubDoc = doc;
      this.page.hubDocs.push(doc);
      this.contentWindow = { postMessage: (msg, origin, transfer = []) => { if (origin === HUB_ORIGIN) doc.hello(msg, transfer[0]); } };
    } else {
      this.contentWindow = { postMessage: () => {} };      // chrome-error://: a message for the hub's origin is dropped
    }
    this.fire('load');
  }
}

/**
 * The page HubClient plants into: {document, MutationObserver, frames, removed, hubDocs}. loads: what the frame loads
 * in turn, a microtask after planting ('hub', 'error', or [] for nothing: a dead host that never fires load).
 */
export function fakePage(site, { loads = ['hub'], hubSession = site.tab() } = {}) {
  const page = { site, hubSession, frames: [], removed: [], hubDocs: [], observers: [] };
  const body = { children: [], appendChild(f) { this.children.push(f); f.parentNode = this; f.isConnected = true; page.frames.push(f); queueMicrotask(() => { for (const k of loads) f.load(k); }); } };
  page.document = { body, documentElement: body, createElement: tag => { assert(tag === 'iframe'); return new FakeFrame(page); } };
  page.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() { page.observers.push(this); }
    disconnect() { page.observers = page.observers.filter(o => o !== this); }
  };
  return page;
}

function assert(ok) { if (!ok) throw new Error('fakePage: only iframes'); }

/** A HubClient's options for a fake page (clock, MessageChannel, document, MutationObserver). */
export function hubOpts(page, clock, extra = {}) {
  return { document: page.document, clock, MessageChannel: FakeChannel, MutationObserver: page.MutationObserver, ...extra };
}

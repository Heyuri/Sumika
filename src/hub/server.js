// The hub's side of the hub protocol (CONTRACTS "Hub protocol"): a hello's checks, then one
// Connection per hub document, which serves the page over its private port: the hub's localStorage (`sumika:` keys) and
// sessionStorage (`sumika.` keys) for the page's mirrors, Web Locks and BroadcastChannels named `sumika…`, the wills,
// store ports and estimates. Everything it touches is injected (hub.js passes the hub frame's globals), so
// tests/runtime/hub_server.test.mjs runs it on fakes.
//
// Order of the checks: origin in the allowlist ('allowlist' when hub.json is unusable, else 'origin'), protocol version
// ('version'), the same-site rule ('site'), a localStorage write ('storage'), one connection per hub document ('busy').
// Nothing of the hub's storage is touched before the origin passed: the cookie probe, the store worker's IndexedDB and
// the welcome's snapshot come after it. The `ack` goes out at once, before any check: it tells a page only that a hub
// exists. Every answer goes to the page's port, never to a window.
import { HUB_MIN, HUB_MAX, STAMP, isLocalKey, isSessionKey, isName } from '../core/hubproto.js';
import { allowed } from './allowlist.js';
import { storageWorks } from './probe.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const errText = e => String((e && e.message) || e);

/** A plain JSON object (a stored record), not an array or null. */
const isRecord = o => !!o && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;

export class Hub {
  /**
   * @param {object} env
   * @param {Promise<object>|object} env.allowlist parseAllowlist's result (or a promise of it: hub.json is fetched)
   * @param {Storage|null} env.localStorage the hub frame's
   * @param {Storage|null} env.sessionStorage
   * @param {{request: Function}|null} env.locks navigator.locks
   * @param {Function|null} env.Channel BroadcastChannel
   * @param {{open(): Promise<string>, attach(port, o?: {retire?: boolean}): void, retire?(): void}} env.store store.js
   *   storeHost
   * @param {(() => Promise<{usage: number, quota: number}>)|null} env.estimate navigator.storage.estimate, bound
   * @param {() => Promise<boolean>} env.probe the same-site rule (probe.js sameSite)
   * @param {() => number} [env.now]
   * @param {{warn: Function, info: Function, debug: Function}} [env.log]
   */
  constructor(env) {
    this.env = { now: () => Date.now(), log: { warn() {}, info() {}, debug() {} }, ...env };
    this.conn = null;
    this.hidden = false;     // between a pagehide that kept the document (back/forward cache) and its pageshow
  }

  /**
   * A hello from the hub's parent window (hub.js checked `event.source === window.parent` and the HELLO mark).
   * @param {string} origin event.origin
   * @param {{v: number, debug?: boolean}} data
   * @param {MessagePort} port the page's private channel
   * @returns {Promise<string>} 'live', or the reason it was refused
   */
  async hello(origin, data, port) {
    const env = this.env;
    const post = m => { try { port.postMessage(m); } catch (e) { /* closed */ } };
    const debug = !!(data && data.debug);
    post({ t: 'ack' });
    const refuse = reason => {
      post({ t: 'refused', reason, v: [HUB_MIN, HUB_MAX] });
      try { port.close(); } catch (e) { /* closed */ }
      if (debug) env.log.debug(`refused ${origin}: ${reason}`);
      return reason;
    };
    let list = null;
    try { list = await env.allowlist; } catch (e) { list = null; }
    if (!list || !list.ok) return refuse('allowlist');
    if (!allowed(list, origin)) return refuse('origin');
    const v = data && data.v;
    if (!Number.isInteger(v) || v < HUB_MIN || v > HUB_MAX) return refuse('version');
    let site = false;
    try { site = (await env.probe()) === true; } catch (e) { site = false; }
    if (!site) return refuse('site');
    if (!env.localStorage || !storageWorks(env.localStorage)) return refuse('storage');
    let kind = 'memory';
    try { kind = (await env.store.open()) === 'indexeddb' ? 'indexeddb' : 'memory'; } catch (e) { kind = 'memory'; }
    if (this.conn) return refuse('busy');
    this.conn = new Connection(this, port, { debug });
    this.conn.start(v, kind);
    if (debug) env.log.debug(`serving ${origin} (protocol ${v}, store ${kind})`);
    return 'live';
  }

  /** The hub window's `storage` event (another document of the hub's origin changed its localStorage). */
  storage(key) {
    const c = this.conn;
    if (!c || c.closed || !(key == null || isLocalKey(key))) return;
    const snap = c.delta();
    if (Object.keys(snap).length) c.post({ t: 'storage', snap, seq: c.seq });
  }

  /**
   * The hub's pagehide: wills committed and locks released (persisted or not), then {t:'gone', persisted}. Persisted
   * (the page and this hub go into the back/forward cache): the store ports the page marked `retire` (its engine
   * starts') refuse writes from now on (store.js retire): the page starts its engines again after the restore with new
   * ports, and a save an old engine posts late must not land over what another page stored meanwhile.
   */
  pageHide(persisted) {
    this.hidden = !!persisted;
    const store = this.env.store;
    if (persisted && store && typeof store.retire === 'function') {
      try { store.retire(); } catch (e) { /* the store went with its ports */ }
    }
    if (this.conn) this.conn.leave(!!persisted);
  }

  /** The hub's pageshow after the back/forward cache: lock requests are taken again. */
  pageShow() {
    this.hidden = false;
  }
}

export class Connection {
  constructor(hub, port, { debug = false } = {}) {
    this.hub = hub;
    this.env = hub.env;
    this.port = port;
    this.debug = debug;
    this.closed = false;
    /** What the page's mirror holds: the welcome's snapshot, then every ls.* applied and every snap sent. */
    this.known = new Map();
    /** rid → {name, release}: locks granted and not let go. */
    this.held = new Map();
    /** rid → {name, answered, ac}: lock requests not granted yet. */
    this.pending = new Map();
    /** lock name → Map(key → stamp). */
    this.wills = new Map();
    /** cid → BroadcastChannel. */
    this.channels = new Map();
    /** ls.* / ss.* keys whose write failed since the last flush. */
    this.failed = new Set();
    /**
     * The `seq` of the page's last ls.* op handled (0: none numbered yet), echoed with every delta: the page skips an
     * entry for a key it wrote later, since that write lands after the delta was taken (a crossing).
     */
    this.seq = 0;
  }

  post(m) {
    if (this.closed && m.t !== 'gone') return;
    try { this.port.postMessage(m); } catch (e) { /* closed */ }
  }

  reply(rid, ok, x) {
    this.post(ok ? { t: 'reply', rid, ok: true, value: x } : { t: 'reply', rid, ok: false, error: x });
  }

  fail(op, key, error) {
    this.post({ t: 'failed', op, key, error });
  }

  /** The welcome (its snapshot fills `known`), then the page's ops start (the port queued any sent before). */
  start(v, kind) {
    const ls = this.env.localStorage;
    const local = {};
    let otherUnits = 0;
    try {
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k == null) continue;
        const val = ls.getItem(k);
        if (val == null) continue;
        if (isLocalKey(k)) { local[k] = val; this.known.set(k, val); } else otherUnits += k.length + val.length;
      }
    } catch (e) { /* what was read stands */ }
    const session = this.sessionMap();
    const caps = {
      locks: !!(this.env.locks && typeof this.env.locks.request === 'function'),
      channels: typeof this.env.Channel === 'function',
      store: kind,
      estimate: typeof this.env.estimate === 'function',
    };
    this.post({ t: 'welcome', v, local, session, otherUnits, caps });
    this.port.onmessage = ev => this.onMessage(ev);
    if (typeof this.port.start === 'function') this.port.start();
  }

  /** Every `sumika.` key of the hub's sessionStorage (this tab's): the welcome's and a `sync` reply's. */
  sessionMap() {
    const ss = this.env.sessionStorage;
    const session = {};
    try {
      if (ss) {
        for (let i = 0; i < ss.length; i++) {
          const k = ss.key(i);
          if (isSessionKey(k)) { const val = ss.getItem(k); if (val != null) session[k] = val; }
        }
      }
    } catch (e) { /* what was read stands */ }
    return session;
  }

  /**
   * The `sumika:` keys whose value in the hub's localStorage differs from what the page was last told ({key: value}, or
   * {key: null} for a key now gone); `known` follows.
   */
  delta() {
    const snap = {};
    const ls = this.env.localStorage;
    const seen = new Set();
    try {
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (!isLocalKey(k)) continue;
        const val = ls.getItem(k);
        if (val == null) continue;
        seen.add(k);
        if (this.known.get(k) !== val) { snap[k] = val; this.known.set(k, val); }
      }
    } catch (e) {
      return snap;       // unreadable now: nothing is said, so nothing is taken away from the page
    }
    for (const k of [...this.known.keys()]) {
      if (!seen.has(k)) { snap[k] = null; this.known.delete(k); }
    }
    return snap;
  }

  onMessage(ev) {
    const m = ev.data;
    if (this.closed || !m || typeof m !== 'object' || typeof m.op !== 'string') return;
    if (this.debug) this.env.log.debug(`op ${m.op}`, m.key || m.name || '');
    if ((m.op === 'ls.set' || m.op === 'ls.remove') && Number.isSafeInteger(m.seq) && m.seq > this.seq) this.seq = m.seq;
    switch (m.op) {
      case 'ls.set': return this.lsSet(m);
      case 'ls.remove': return this.lsRemove(m);
      case 'ss.set': return this.ssWrite(m, true);
      case 'ss.remove': return this.ssWrite(m, false);
      case 'flush': return this.flush(m);
      // a page restored from the back/forward cache: the delta, and this tab's session keys (another page of the tab
      // may have written them meanwhile)
      case 'sync': return this.reply(m.rid, true, { snap: this.delta(), session: this.sessionMap(), seq: this.seq });
      case 'lock': return this.lock(m);
      case 'unlock': return this.unlock(m.rid);
      case 'will': return this.will(m);
      case 'bc.open': return this.bcOpen(m);
      case 'bc.post': return this.bcPost(m);
      case 'bc.close': return this.bcClose(m.cid);
      case 'store': return this.store(m, ev);
      case 'estimate': return this.estimate(m.rid);
      default:
        if (has(m, 'rid')) this.reply(m.rid, false, 'unknown op');
        else this.fail(m.op, m.key, 'unknown op');
        return undefined;
    }
  }

  lsSet({ key, value }) {
    if (!isLocalKey(key)) { this.failed.add(String(key)); this.fail('ls.set', key, 'key'); return; }
    const s = String(value);
    try {
      this.env.localStorage.setItem(key, s);
      this.known.set(key, s);
    } catch (e) {
      // not stored (quota, other data): `known` keeps what storage holds, so no snap takes the page's copy away
      this.failed.add(key);
      this.fail('ls.set', key, (e && e.name) || errText(e));
    }
  }

  lsRemove({ key }) {
    if (!isLocalKey(key)) { this.failed.add(String(key)); this.fail('ls.remove', key, 'key'); return; }
    try {
      this.env.localStorage.removeItem(key);
      this.known.delete(key);
    } catch (e) {
      this.failed.add(key);
      this.fail('ls.remove', key, (e && e.name) || errText(e));
    }
  }

  ssWrite({ key, value }, set) {
    const op = set ? 'ss.set' : 'ss.remove';
    if (!isSessionKey(key)) { this.failed.add(String(key)); this.fail(op, key, 'key'); return; }
    try {
      if (set) this.env.sessionStorage.setItem(key, String(value));
      else this.env.sessionStorage.removeItem(key);
    } catch (e) {
      this.failed.add(key);
      this.fail(op, key, (e && e.name) || errText(e));
    }
  }

  /** Every earlier op is applied (one FIFO port): the failures since the last flush, and the session keys asked. */
  flush({ rid, session }) {
    const out = {};
    if (Array.isArray(session)) {
      for (const k of session) {
        if (!isSessionKey(k)) continue;
        let v = null;
        try { v = this.env.sessionStorage.getItem(k); } catch (e) { v = null; }
        out[k] = v;
      }
    }
    const failed = [...this.failed];
    this.failed.clear();
    this.reply(rid, true, { failed, session: out });
  }

  /**
   * A Web Lock for the page. A grant holds until `unlock` or the hub's pagehide; it carries the delta, which the page
   * applies before its callback runs. A wait (not ifAvailable) is abortable, so the hub's pagehide takes back every
   * request not granted yet (a grant reaching a hub in the back/forward cache would hold the lock there).
   */
  lock(m) {
    const { rid, name } = m;
    if (!isName(name)) { this.reply(rid, false, 'name'); return; }
    const locks = this.env.locks;
    if (!locks || typeof locks.request !== 'function') { this.reply(rid, false, 'no locks'); return; }
    if (this.held.has(rid) || this.pending.has(rid)) { this.reply(rid, false, 'rid in use'); return; }
    if (this.hub.hidden) { this.reply(rid, false, 'aborted'); return; }
    const ifAvailable = !!m.ifAvailable;
    const entry = { name, answered: false, ac: null };
    const opts = { ifAvailable };
    // the Web Locks API refuses a signal together with ifAvailable (which answers at once anyway)
    if (!ifAvailable && typeof AbortController === 'function') { entry.ac = new AbortController(); opts.signal = entry.ac.signal; }
    this.pending.set(rid, entry);
    let p;
    try {
      p = locks.request(name, opts, lock => {
        if (this.pending.get(rid) === entry) this.pending.delete(rid);
        if (entry.answered || this.closed) return undefined;     // taken back meanwhile: let it go at once
        entry.answered = true;
        if (!lock) { this.reply(rid, true, { granted: false }); return undefined; }
        return new Promise(release => {
          this.held.set(rid, { name, release });
          this.reply(rid, true, { granted: true, snap: this.delta(), seq: this.seq });
        });
      });
    } catch (e) {
      p = Promise.reject(e);
    }
    Promise.resolve(p).catch(e => {
      if (this.pending.get(rid) === entry) this.pending.delete(rid);
      if (entry.answered) return;
      entry.answered = true;
      this.reply(rid, false, e && e.name === 'AbortError' ? 'aborted' : errText(e));
    });
  }

  /** The page let a lock go: its wills are committed first, then it is released. A wait not granted yet is taken back. */
  unlock(rid) {
    const h = this.held.get(rid);
    if (h) {
      this.held.delete(rid);
      this.commitWills(h.name);
      h.release();
      return;
    }
    const p = this.pending.get(rid);
    if (p) {
      this.pending.delete(rid);
      if (!p.answered) { p.answered = true; this.reply(rid, false, 'aborted'); }
      if (p.ac) { try { p.ac.abort(); } catch (e) { /* done */ } }
    }
  }

  /** Recorded only while this page holds the lock `name`. */
  will({ name, key, stamp }) {
    if (!isLocalKey(key) || typeof stamp !== 'string' || !STAMP.test(stamp)) return;
    let holds = false;
    for (const h of this.held.values()) if (h.name === name) { holds = true; break; }
    if (!holds) return;
    if (!this.wills.has(name)) this.wills.set(name, new Map());
    this.wills.get(name).set(key, stamp);
  }

  /**
   * The wills of lock `name`: each key's record, when it is a JSON object whose `stamp` field is a number, gets the
   * hub's Date.now() there, so `savedAt` is the end of the session even when the page's last write was lost (Kawari's
   * D6 reads it). Errors are ignored and `known` is left as it is (the stamped record reaches the page as a delta).
   */
  commitWills(name) {
    const w = this.wills.get(name);
    if (!w) return;
    this.wills.delete(name);
    const ls = this.env.localStorage;
    for (const [key, stamp] of w) {
      try {
        const text = ls.getItem(key);
        if (text == null) continue;
        const o = JSON.parse(text);
        if (!isRecord(o) || typeof o[stamp] !== 'number') continue;
        o[stamp] = this.env.now();
        ls.setItem(key, JSON.stringify(o));
      } catch (e) { /* unreadable or full: the last write stands */ }
    }
  }

  bcOpen({ cid, name }) {
    if (!isName(name)) { this.fail('bc.open', name, 'name'); return; }
    const C = this.env.Channel;
    if (typeof C !== 'function') { this.fail('bc.open', name, 'no channels'); return; }
    this.bcClose(cid);
    let c;
    try {
      c = new C(name);
    } catch (e) {
      this.fail('bc.open', name, errText(e));
      return;
    }
    c.onmessage = ev => {
      if (this.closed || this.channels.get(cid) !== c) return;
      this.post({ t: 'bc', cid, data: ev.data, snap: this.delta(), seq: this.seq });
    };
    this.channels.set(cid, c);
  }

  bcPost({ cid, data }) {
    const c = this.channels.get(cid);
    if (!c) { this.fail('bc.post', cid, 'no channel'); return; }
    try { c.postMessage(data); } catch (e) { this.fail('bc.post', cid, errText(e)); }
  }

  bcClose(cid) {
    const c = this.channels.get(cid);
    if (!c) return;
    this.channels.delete(cid);
    try { c.close(); } catch (e) { /* closed */ }
  }

  store(m, ev) {
    const port = m.port || (ev && ev.ports && ev.ports[0]) || null;
    if (!port || typeof port.postMessage !== 'function') { this.fail('store', m.pid, 'no port'); return; }
    try { this.env.store.attach(port, { retire: m.retire === true }); } catch (e) { this.fail('store', m.pid, errText(e)); }
  }

  estimate(rid) {
    const est = this.env.estimate;
    if (typeof est !== 'function') { this.reply(rid, false, 'no estimate'); return; }
    Promise.resolve().then(() => est()).then(
      e => this.reply(rid, true, { usage: Number(e && e.usage) || 0, quota: Number(e && e.quota) || 0 }),
      e => this.reply(rid, false, errText(e)));
  }

  /**
   * The hub's pagehide: every lock request not granted is answered 'aborted' and taken back; every held lock's wills
   * are committed, then it is released (the next page's hub is granted it only after that); then {t:'gone',
   * persisted}. A document kept in the back/forward cache keeps its channels and store ports (dropped files must work
   * after a restore, and its page channels outlive the cache); one that goes closes its channels. Store ports are never
   * closed here: a write still on its way would be lost, and the document's end closes them anyway.
   */
  leave(persisted) {
    for (const [rid, p] of this.pending) {
      if (!p.answered) { p.answered = true; this.reply(rid, false, 'aborted'); }
      if (p.ac) { try { p.ac.abort(); } catch (e) { /* done */ } }
    }
    this.pending.clear();
    for (const h of this.held.values()) {
      this.commitWills(h.name);
      h.release();
    }
    this.held.clear();
    if (!persisted) {
      for (const cid of [...this.channels.keys()]) this.bcClose(cid);
      this.closed = true;
    }
    this.post({ t: 'gone', persisted });
  }
}

(() => {
  // src/core/hubproto.js
  var HUB_MIN = 1;
  var HUB_MAX = 1;
  var HELLO = "sumikaHubHello";
  var LOCAL_PREFIX = "sumika:";
  var SESSION_PREFIX = "sumika.";
  var STORE_DB = "sumika";
  var NAME_PREFIX = "sumika";
  var PROBE_COOKIE = "sumika-hub-probe";
  var REASONS = Object.freeze(["origin", "allowlist", "version", "site", "storage", "busy"]);
  var STAMP = /^[A-Za-z_]\w*$/;
  var RETIRED = "retired";
  var isLocalKey = (k) => typeof k === "string" && k.startsWith(LOCAL_PREFIX);
  var isSessionKey = (k) => typeof k === "string" && k.startsWith(SESSION_PREFIX);
  var isName = (n) => typeof n === "string" && n.startsWith(NAME_PREFIX);

  // src/hub/allowlist.js
  var ALLOW_FORMAT = 1;
  function isLoopback(hostname) {
    const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
    if (h === "[::1]" || h === "[0:0:0:0:0:0:0:1]") return true;
    return /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h);
  }
  function judge(entry, hub) {
    if (entry === null || entry === "null") return { origin: null, why: "null is no origin a page can be listed by" };
    if (typeof entry !== "string") return { origin: null, why: "not a string" };
    if (entry.includes("*")) return { origin: null, why: "no wildcards: list each address" };
    let u;
    try {
      u = new URL(entry);
    } catch (e) {
      return { origin: null, why: "not an absolute URL" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { origin: null, why: `not http(s) (${u.protocol})` };
    if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(entry)) return { origin: null, why: "has a user name or password" };
    if (u.search || u.hash || /[?#]/.test(entry)) return { origin: null, why: "has a query or fragment" };
    if (u.pathname !== "/") return { origin: null, why: `has a path (${u.pathname}): list the origin only` };
    if (u.protocol !== hub.protocol) {
      return { origin: null, why: `its scheme ${u.protocol} differs from the hub's ${hub.protocol} (such a page is another site)` };
    }
    if (isLoopback(u.hostname) && !isLoopback(hub.hostname)) {
      return { origin: null, why: "a loopback address, and this hub is not on one (a test entry left in a published hub.json)" };
    }
    return { origin: u.origin, why: null };
  }
  function parseAllowlist(text, hubUrl) {
    const out = { ok: false, origins: /* @__PURE__ */ new Set(), ignored: [], error: null };
    if (text == null) {
      out.error = "missing or unreadable";
      return out;
    }
    let j;
    try {
      j = JSON.parse(String(text));
    } catch (e) {
      out.error = "no JSON";
      return out;
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      out.error = "no JSON object";
      return out;
    }
    if (typeof j.format === "number" && j.format > ALLOW_FORMAT) {
      out.error = `format ${j.format} is newer than this hub reads (${ALLOW_FORMAT}): publish the current runtime`;
      return out;
    }
    if (j.format !== ALLOW_FORMAT) {
      out.error = `format ${JSON.stringify(j.format)} is not ${ALLOW_FORMAT}`;
      return out;
    }
    if (!Array.isArray(j.origins)) {
      out.error = 'no "origins" array';
      return out;
    }
    let hub;
    try {
      hub = new URL(String(hubUrl));
    } catch (e) {
      out.error = "the hub has no URL";
      return out;
    }
    for (const entry of j.origins) {
      const { origin, why } = judge(entry, hub);
      if (origin) out.origins.add(origin);
      else out.ignored.push({ entry, why });
    }
    out.ok = true;
    return out;
  }
  function allowed(list, origin) {
    return !!(list && list.ok && typeof origin === "string" && list.origins.has(origin));
  }

  // src/hub/probe.js
  async function sameSite({ document, navigator, location, random = Math.random }) {
    try {
      if (navigator && navigator.cookieEnabled === false) return false;
      const nonce = Math.floor(random() * 4294967296).toString(36) + Date.now().toString(36);
      const name = `${PROBE_COOKIE}-${nonce}`;
      const path = /^\/[^;,\s]*$/.test(location.pathname) ? location.pathname : "/";
      const attrs = `; Path=${path}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
      document.cookie = `${name}=1; Max-Age=10${attrs}`;
      const back = String(document.cookie).split(/;\s*/).includes(`${name}=1`);
      document.cookie = `${name}=; Max-Age=0${attrs}`;
      if (!back) return false;
    } catch (e) {
      return false;
    }
    if (document && typeof document.hasStorageAccess === "function") {
      try {
        if (await document.hasStorageAccess() === false) return false;
      } catch (e) {
      }
    }
    return true;
  }
  var PROBE_KEY = "sumika-hub:probe";
  function storageWorks(ls) {
    try {
      ls.setItem(PROBE_KEY, "1");
      ls.removeItem(PROBE_KEY);
      return true;
    } catch (e) {
      return false;
    }
  }

  // src/hub/server.js
  var has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  var errText = (e) => String(e && e.message || e);
  var isRecord = (o) => !!o && typeof o === "object" && Object.getPrototypeOf(o) === Object.prototype;
  var Hub = class {
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
      this.env = { now: () => Date.now(), log: { warn() {
      }, info() {
      }, debug() {
      } }, ...env };
      this.conn = null;
      this.hidden = false;
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
      const post = (m) => {
        try {
          port.postMessage(m);
        } catch (e) {
        }
      };
      const debug = !!(data && data.debug);
      post({ t: "ack" });
      const refuse = (reason) => {
        post({ t: "refused", reason, v: [HUB_MIN, HUB_MAX] });
        try {
          port.close();
        } catch (e) {
        }
        if (debug) env.log.debug(`refused ${origin}: ${reason}`);
        return reason;
      };
      let list = null;
      try {
        list = await env.allowlist;
      } catch (e) {
        list = null;
      }
      if (!list || !list.ok) return refuse("allowlist");
      if (!allowed(list, origin)) return refuse("origin");
      const v = data && data.v;
      if (!Number.isInteger(v) || v < HUB_MIN || v > HUB_MAX) return refuse("version");
      let site = false;
      try {
        site = await env.probe() === true;
      } catch (e) {
        site = false;
      }
      if (!site) return refuse("site");
      if (!env.localStorage || !storageWorks(env.localStorage)) return refuse("storage");
      let kind = "memory";
      try {
        kind = await env.store.open() === "indexeddb" ? "indexeddb" : "memory";
      } catch (e) {
        kind = "memory";
      }
      if (this.conn) return refuse("busy");
      this.conn = new Connection(this, port, { debug });
      this.conn.start(v, kind);
      if (debug) env.log.debug(`serving ${origin} (protocol ${v}, store ${kind})`);
      return "live";
    }
    /** The hub window's `storage` event (another document of the hub's origin changed its localStorage). */
    storage(key) {
      const c = this.conn;
      if (!c || c.closed || !(key == null || isLocalKey(key))) return;
      const snap = c.delta();
      if (Object.keys(snap).length) c.post({ t: "storage", snap, seq: c.seq });
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
      if (persisted && store && typeof store.retire === "function") {
        try {
          store.retire();
        } catch (e) {
        }
      }
      if (this.conn) this.conn.leave(!!persisted);
    }
    /** The hub's pageshow after the back/forward cache: lock requests are taken again. */
    pageShow() {
      this.hidden = false;
    }
  };
  var Connection = class {
    constructor(hub, port, { debug = false } = {}) {
      this.hub = hub;
      this.env = hub.env;
      this.port = port;
      this.debug = debug;
      this.closed = false;
      this.known = /* @__PURE__ */ new Map();
      this.held = /* @__PURE__ */ new Map();
      this.pending = /* @__PURE__ */ new Map();
      this.wills = /* @__PURE__ */ new Map();
      this.channels = /* @__PURE__ */ new Map();
      this.failed = /* @__PURE__ */ new Set();
      this.seq = 0;
    }
    post(m) {
      if (this.closed && m.t !== "gone") return;
      try {
        this.port.postMessage(m);
      } catch (e) {
      }
    }
    reply(rid, ok, x) {
      this.post(ok ? { t: "reply", rid, ok: true, value: x } : { t: "reply", rid, ok: false, error: x });
    }
    fail(op, key, error) {
      this.post({ t: "failed", op, key, error });
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
          if (isLocalKey(k)) {
            local[k] = val;
            this.known.set(k, val);
          } else otherUnits += k.length + val.length;
        }
      } catch (e) {
      }
      const session = this.sessionMap();
      const caps = {
        locks: !!(this.env.locks && typeof this.env.locks.request === "function"),
        channels: typeof this.env.Channel === "function",
        store: kind,
        estimate: typeof this.env.estimate === "function"
      };
      this.post({ t: "welcome", v, local, session, otherUnits, caps });
      this.port.onmessage = (ev) => this.onMessage(ev);
      if (typeof this.port.start === "function") this.port.start();
    }
    /** Every `sumika.` key of the hub's sessionStorage (this tab's): the welcome's and a `sync` reply's. */
    sessionMap() {
      const ss = this.env.sessionStorage;
      const session = {};
      try {
        if (ss) {
          for (let i = 0; i < ss.length; i++) {
            const k = ss.key(i);
            if (isSessionKey(k)) {
              const val = ss.getItem(k);
              if (val != null) session[k] = val;
            }
          }
        }
      } catch (e) {
      }
      return session;
    }
    /**
     * The `sumika:` keys whose value in the hub's localStorage differs from what the page was last told ({key: value}, or
     * {key: null} for a key now gone); `known` follows.
     */
    delta() {
      const snap = {};
      const ls = this.env.localStorage;
      const seen = /* @__PURE__ */ new Set();
      try {
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (!isLocalKey(k)) continue;
          const val = ls.getItem(k);
          if (val == null) continue;
          seen.add(k);
          if (this.known.get(k) !== val) {
            snap[k] = val;
            this.known.set(k, val);
          }
        }
      } catch (e) {
        return snap;
      }
      for (const k of [...this.known.keys()]) {
        if (!seen.has(k)) {
          snap[k] = null;
          this.known.delete(k);
        }
      }
      return snap;
    }
    onMessage(ev) {
      const m = ev.data;
      if (this.closed || !m || typeof m !== "object" || typeof m.op !== "string") return;
      if (this.debug) this.env.log.debug(`op ${m.op}`, m.key || m.name || "");
      if ((m.op === "ls.set" || m.op === "ls.remove") && Number.isSafeInteger(m.seq) && m.seq > this.seq) this.seq = m.seq;
      switch (m.op) {
        case "ls.set":
          return this.lsSet(m);
        case "ls.remove":
          return this.lsRemove(m);
        case "ss.set":
          return this.ssWrite(m, true);
        case "ss.remove":
          return this.ssWrite(m, false);
        case "flush":
          return this.flush(m);
        // a page restored from the back/forward cache: the delta, and this tab's session keys (another page of the tab
        // may have written them meanwhile)
        case "sync":
          return this.reply(m.rid, true, { snap: this.delta(), session: this.sessionMap(), seq: this.seq });
        case "lock":
          return this.lock(m);
        case "unlock":
          return this.unlock(m.rid);
        case "will":
          return this.will(m);
        case "bc.open":
          return this.bcOpen(m);
        case "bc.post":
          return this.bcPost(m);
        case "bc.close":
          return this.bcClose(m.cid);
        case "store":
          return this.store(m, ev);
        case "estimate":
          return this.estimate(m.rid);
        default:
          if (has(m, "rid")) this.reply(m.rid, false, "unknown op");
          else this.fail(m.op, m.key, "unknown op");
          return void 0;
      }
    }
    lsSet({ key, value }) {
      if (!isLocalKey(key)) {
        this.failed.add(String(key));
        this.fail("ls.set", key, "key");
        return;
      }
      const s = String(value);
      try {
        this.env.localStorage.setItem(key, s);
        this.known.set(key, s);
      } catch (e) {
        this.failed.add(key);
        this.fail("ls.set", key, e && e.name || errText(e));
      }
    }
    lsRemove({ key }) {
      if (!isLocalKey(key)) {
        this.failed.add(String(key));
        this.fail("ls.remove", key, "key");
        return;
      }
      try {
        this.env.localStorage.removeItem(key);
        this.known.delete(key);
      } catch (e) {
        this.failed.add(key);
        this.fail("ls.remove", key, e && e.name || errText(e));
      }
    }
    ssWrite({ key, value }, set) {
      const op = set ? "ss.set" : "ss.remove";
      if (!isSessionKey(key)) {
        this.failed.add(String(key));
        this.fail(op, key, "key");
        return;
      }
      try {
        if (set) this.env.sessionStorage.setItem(key, String(value));
        else this.env.sessionStorage.removeItem(key);
      } catch (e) {
        this.failed.add(key);
        this.fail(op, key, e && e.name || errText(e));
      }
    }
    /** Every earlier op is applied (one FIFO port): the failures since the last flush, and the session keys asked. */
    flush({ rid, session }) {
      const out = {};
      if (Array.isArray(session)) {
        for (const k of session) {
          if (!isSessionKey(k)) continue;
          let v = null;
          try {
            v = this.env.sessionStorage.getItem(k);
          } catch (e) {
            v = null;
          }
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
      if (!isName(name)) {
        this.reply(rid, false, "name");
        return;
      }
      const locks = this.env.locks;
      if (!locks || typeof locks.request !== "function") {
        this.reply(rid, false, "no locks");
        return;
      }
      if (this.held.has(rid) || this.pending.has(rid)) {
        this.reply(rid, false, "rid in use");
        return;
      }
      if (this.hub.hidden) {
        this.reply(rid, false, "aborted");
        return;
      }
      const ifAvailable = !!m.ifAvailable;
      const entry = { name, answered: false, ac: null };
      const opts = { ifAvailable };
      if (!ifAvailable && typeof AbortController === "function") {
        entry.ac = new AbortController();
        opts.signal = entry.ac.signal;
      }
      this.pending.set(rid, entry);
      let p;
      try {
        p = locks.request(name, opts, (lock) => {
          if (this.pending.get(rid) === entry) this.pending.delete(rid);
          if (entry.answered || this.closed) return void 0;
          entry.answered = true;
          if (!lock) {
            this.reply(rid, true, { granted: false });
            return void 0;
          }
          return new Promise((release) => {
            this.held.set(rid, { name, release });
            this.reply(rid, true, { granted: true, snap: this.delta(), seq: this.seq });
          });
        });
      } catch (e) {
        p = Promise.reject(e);
      }
      Promise.resolve(p).catch((e) => {
        if (this.pending.get(rid) === entry) this.pending.delete(rid);
        if (entry.answered) return;
        entry.answered = true;
        this.reply(rid, false, e && e.name === "AbortError" ? "aborted" : errText(e));
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
        if (!p.answered) {
          p.answered = true;
          this.reply(rid, false, "aborted");
        }
        if (p.ac) {
          try {
            p.ac.abort();
          } catch (e) {
          }
        }
      }
    }
    /** Recorded only while this page holds the lock `name`. */
    will({ name, key, stamp }) {
      if (!isLocalKey(key) || typeof stamp !== "string" || !STAMP.test(stamp)) return;
      let holds = false;
      for (const h of this.held.values()) if (h.name === name) {
        holds = true;
        break;
      }
      if (!holds) return;
      if (!this.wills.has(name)) this.wills.set(name, /* @__PURE__ */ new Map());
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
          if (!isRecord(o) || typeof o[stamp] !== "number") continue;
          o[stamp] = this.env.now();
          ls.setItem(key, JSON.stringify(o));
        } catch (e) {
        }
      }
    }
    bcOpen({ cid, name }) {
      if (!isName(name)) {
        this.fail("bc.open", name, "name");
        return;
      }
      const C = this.env.Channel;
      if (typeof C !== "function") {
        this.fail("bc.open", name, "no channels");
        return;
      }
      this.bcClose(cid);
      let c;
      try {
        c = new C(name);
      } catch (e) {
        this.fail("bc.open", name, errText(e));
        return;
      }
      c.onmessage = (ev) => {
        if (this.closed || this.channels.get(cid) !== c) return;
        this.post({ t: "bc", cid, data: ev.data, snap: this.delta(), seq: this.seq });
      };
      this.channels.set(cid, c);
    }
    bcPost({ cid, data }) {
      const c = this.channels.get(cid);
      if (!c) {
        this.fail("bc.post", cid, "no channel");
        return;
      }
      try {
        c.postMessage(data);
      } catch (e) {
        this.fail("bc.post", cid, errText(e));
      }
    }
    bcClose(cid) {
      const c = this.channels.get(cid);
      if (!c) return;
      this.channels.delete(cid);
      try {
        c.close();
      } catch (e) {
      }
    }
    store(m, ev) {
      const port = m.port || ev && ev.ports && ev.ports[0] || null;
      if (!port || typeof port.postMessage !== "function") {
        this.fail("store", m.pid, "no port");
        return;
      }
      try {
        this.env.store.attach(port, { retire: m.retire === true });
      } catch (e) {
        this.fail("store", m.pid, errText(e));
      }
    }
    estimate(rid) {
      const est = this.env.estimate;
      if (typeof est !== "function") {
        this.reply(rid, false, "no estimate");
        return;
      }
      Promise.resolve().then(() => est()).then(
        (e) => this.reply(rid, true, { usage: Number(e && e.usage) || 0, quota: Number(e && e.quota) || 0 }),
        (e) => this.reply(rid, false, errText(e))
      );
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
        if (!p.answered) {
          p.answered = true;
          this.reply(rid, false, "aborted");
        }
        if (p.ac) {
          try {
            p.ac.abort();
          } catch (e) {
          }
        }
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
      this.post({ t: "gone", persisted });
    }
  };

  // src/hub/store.js
  var DB_VERSION = 1;
  var STORE = "kv";
  function idbOpen(idb) {
    return new Promise((resolve, reject) => {
      const req = idb.open(STORE_DB, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    });
  }
  function idbCall(db, mode, fn) {
    return new Promise((resolve, reject) => {
      let tx, req;
      try {
        tx = db.transaction(STORE, mode);
        req = fn(tx.objectStore(STORE));
      } catch (e) {
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve(req ? req.result : void 0);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
      if (mode === "readwrite" && typeof tx.commit === "function") {
        try {
          tx.commit();
        } catch (e) {
        }
      }
    });
  }
  var HubStore = class _HubStore {
    /** @param {IDBFactory|null|undefined} idb */
    static async open(idb) {
      const s = new _HubStore();
      if (idb) {
        try {
          const db = await idbOpen(idb);
          db.onversionchange = () => {
            try {
              db.close();
            } catch (e) {
            }
            s.lost = true;
          };
          db.onclose = () => {
            s.lost = true;
          };
          s.db = db;
        } catch (e) {
          s.db = null;
        }
      }
      return s;
    }
    constructor() {
      this.db = null;
      this.lost = false;
      this.mem = /* @__PURE__ */ new Map();
    }
    get kind() {
      return this.db ? "indexeddb" : "memory";
    }
    /** The value or undefined; rejects when it cannot be read. */
    async read(key) {
      if (this.lost) throw new Error("the database was closed");
      if (this.db) return idbCall(this.db, "readonly", (st) => st.get(key));
      return this.mem.get(key);
    }
    /** The value, or undefined when the read failed. */
    async get(key) {
      try {
        return await this.read(key);
      } catch (e) {
        return void 0;
      }
    }
    /** True when stored in IndexedDB (memory is no storage: false, as Store's). */
    async set(key, value) {
      if (!this.db) {
        this.mem.set(key, value);
        return false;
      }
      if (this.lost) return false;
      try {
        await idbCall(this.db, "readwrite", (st) => st.put(value, key));
        return true;
      } catch (e) {
        return false;
      }
    }
    /** False when the browser refused the delete. */
    async delete(key) {
      if (!this.db) {
        this.mem.delete(key);
        return true;
      }
      if (this.lost) return false;
      try {
        await idbCall(this.db, "readwrite", (st) => st.delete(key));
        return true;
      } catch (e) {
        return false;
      }
    }
    /** String keys that start with prefix; rejects when they cannot be listed. */
    async keys(prefix = "") {
      const p = String(prefix);
      if (this.lost) throw new Error("the database was closed");
      if (this.db) {
        const ks = await idbCall(this.db, "readonly", (st) => st.getAllKeys(IDBKeyRange.bound(p, p + "\uFFFF")));
        return ks.filter((k) => typeof k === "string");
      }
      return [...this.mem.keys()].filter((k) => typeof k === "string" && k.startsWith(p));
    }
  };
  function buffersOf(v) {
    const out = /* @__PURE__ */ new Set();
    const add = (x) => {
      if (x instanceof ArrayBuffer) {
        if (x.byteLength) out.add(x);
      } else if (ArrayBuffer.isView(x) && x.buffer instanceof ArrayBuffer && x.buffer.byteLength) out.add(x.buffer);
    };
    add(v);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) for (const x of Object.values(v)) add(x);
    return [...out];
  }
  var isKey = (k) => typeof k === "string";
  function serveStorePort(port, store, gate = null) {
    const answer = (m, transfer) => {
      try {
        port.postMessage(m, transfer || []);
      } catch (e) {
        try {
          port.postMessage(m);
        } catch (e2) {
        }
      }
    };
    const ops = {
      read: async (m) => {
        const value = await store.read(m.key);
        return { value, transfer: store.db ? buffersOf(value) : [] };
      },
      get: async (m) => {
        const value = await store.get(m.key);
        return { value, transfer: store.db ? buffersOf(value) : [] };
      },
      set: async (m) => ({ value: await store.set(m.key, m.value) }),
      delete: async (m) => ({ value: await store.delete(m.key) }),
      keys: async (m) => ({ value: await store.keys(m.prefix == null ? "" : m.prefix) })
    };
    port.onmessage = (ev) => {
      const m = ev.data;
      if (!m || typeof m !== "object") return;
      const rid = m.rid;
      const op = Object.prototype.hasOwnProperty.call(ops, m.op) ? ops[m.op] : null;
      if (!op) {
        answer({ rid, ok: false, error: "unknown op" });
        return;
      }
      if (gate && gate.retired && (m.op === "set" || m.op === "delete")) {
        answer({ rid, ok: false, error: RETIRED });
        return;
      }
      if (m.op === "keys" ? !(m.prefix == null || isKey(m.prefix)) : !isKey(m.key)) {
        answer({ rid, ok: false, error: "bad key" });
        return;
      }
      op(m).then(
        (r) => answer({ rid, ok: true, value: r.value }, r.transfer),
        (e) => answer({ rid, ok: false, error: String(e && e.message || e) })
      );
    };
    if (typeof port.start === "function") port.start();
    answer({ t: "store", kind: store.kind });
  }
  function retirement() {
    const gates = /* @__PURE__ */ new Set();
    return {
      gate(retire) {
        if (!retire) return null;
        const g2 = { retired: false };
        gates.add(g2);
        return g2;
      },
      retire() {
        for (const g2 of gates) g2.retired = true;
        gates.clear();
      }
    };
  }
  function storeHost({ scriptUrl = null, Worker = null, idb = null } = {}) {
    let worker = null, local = null, opened = null;
    const here = () => local || (local = HubStore.open(idb));
    const frame = retirement();
    if (scriptUrl && typeof Worker === "function") {
      try {
        worker = new Worker(scriptUrl, { name: "sumika-hub-store" });
      } catch (e) {
        worker = null;
      }
    }
    return {
      get inWorker() {
        return !!worker;
      },
      open() {
        if (opened) return opened;
        opened = new Promise((resolve) => {
          if (!worker) {
            here().then((s) => resolve(s.kind));
            return;
          }
          const w = worker;
          let done = false;
          w.onmessage = (ev) => {
            if (done || !ev.data || ev.data.t !== "opened") return;
            done = true;
            resolve(ev.data.kind === "indexeddb" ? "indexeddb" : "memory");
          };
          w.onerror = (ev) => {
            if (done) return;
            done = true;
            if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
            if (worker === w) worker = null;
            here().then((s) => resolve(s.kind));
          };
          try {
            w.postMessage({ t: "open" });
          } catch (e) {
            done = true;
            worker = null;
            here().then((s) => resolve(s.kind));
          }
        });
        return opened;
      },
      attach(port, { retire = false } = {}) {
        if (worker) {
          try {
            worker.postMessage({ t: "port", retire: retire === true }, [port]);
            return;
          } catch (e) {
            worker = null;
          }
        }
        const gate = frame.gate(retire === true);
        here().then((s) => serveStorePort(port, s, gate));
      },
      retire() {
        frame.retire();
        if (worker) {
          try {
            worker.postMessage({ t: "retire" });
          } catch (e) {
          }
        }
      }
    };
  }
  function storeWorker(scope, idb) {
    if (idb === void 0) {
      try {
        idb = scope.indexedDB || null;
      } catch (e) {
        idb = null;
      }
    }
    let store = null;
    const get = () => store || (store = HubStore.open(idb));
    const here = retirement();
    scope.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.t === "open") get().then((s) => scope.postMessage({ t: "opened", kind: s.kind }));
      else if (m.t === "port" && ev.ports && ev.ports[0]) {
        const port = ev.ports[0];
        const gate = here.gate(m.retire === true);
        get().then((s) => serveStorePort(port, s, gate));
      } else if (m.t === "retire") here.retire();
    };
  }

  // src/hub/hub.js
  var ALLOW_FILE = "hub.json";
  var ALLOW_CACHE_KEY = "sumika-hub:allow";
  var ALLOW_TTL_MS = 5 * 60 * 1e3;
  var PREFIX = "[sumika hub]";
  function hubLog(c = globalThis.console) {
    return {
      warn: (...a) => c.warn(PREFIX, ...a),
      info: (...a) => c.info(PREFIX, ...a),
      debug: (...a) => c.debug(PREFIX, ...a)
    };
  }
  async function loadAllowlist({ url, fetch, sessionStorage = null, now = () => Date.now(), log = hubLog() }) {
    const from = new URL(ALLOW_FILE, url).href;
    let text = null, cached = false;
    try {
      const c = JSON.parse(sessionStorage.getItem(ALLOW_CACHE_KEY));
      const age = now() - (c && c.at);
      if (c && c.from === from && typeof c.text === "string" && age >= 0 && age < ALLOW_TTL_MS) {
        text = c.text;
        cached = true;
      }
    } catch (e) {
    }
    if (!cached) {
      try {
        const r = await fetch(from, { cache: "no-cache", credentials: "omit" });
        text = r && r.ok ? await r.text() : null;
      } catch (e) {
        text = null;
      }
    }
    const list = parseAllowlist(text, url);
    for (const { entry, why } of list.ignored) log.warn(`sumika/hub.json: ${JSON.stringify(entry)} is ignored: ${why}`);
    try {
      if (!list.ok) sessionStorage.removeItem(ALLOW_CACHE_KEY);
      else if (!cached) sessionStorage.setItem(ALLOW_CACHE_KEY, JSON.stringify({ at: now(), from, text }));
    } catch (e) {
    }
    if (!list.ok) log.warn(`sumika/hub.json: ${list.error}; this hub answers no page`);
    return list;
  }
  var tryGet = (f) => {
    try {
      return f();
    } catch (e) {
      return null;
    }
  };
  function hubMain(win) {
    if (win.parent === win) return null;
    const doc = win.document;
    const log = hubLog(win.console);
    const ls = tryGet(() => win.localStorage);
    const ss = tryGet(() => win.sessionStorage);
    const nav = win.navigator || {};
    const allowlist = loadAllowlist({ url: win.location.href, fetch: (...a) => win.fetch(...a), sessionStorage: ss, log });
    const store = storeHost({
      scriptUrl: doc.currentScript && doc.currentScript.src,
      Worker: typeof win.Worker === "function" ? win.Worker : null,
      idb: tryGet(() => win.indexedDB)
    });
    const est = nav.storage && typeof nav.storage.estimate === "function" ? () => nav.storage.estimate() : null;
    const hub = new Hub({
      allowlist,
      localStorage: ls,
      sessionStorage: ss,
      locks: nav.locks && typeof nav.locks.request === "function" ? nav.locks : null,
      Channel: typeof win.BroadcastChannel === "function" ? win.BroadcastChannel : null,
      store,
      estimate: est,
      probe: () => sameSite({ document: doc, navigator: nav, location: win.location }),
      log
    });
    win.addEventListener("message", (ev) => {
      if (ev.source !== win.parent) return;
      const d = ev.data;
      if (!d || typeof d !== "object" || d[HELLO] !== 1) return;
      const port = ev.ports && ev.ports[0];
      if (!port) return;
      hub.hello(ev.origin, d, port).catch((e) => log.warn("hello failed", e));
    });
    win.addEventListener("storage", (ev) => {
      if (ls && ev.storageArea === ls) hub.storage(ev.key);
    });
    win.addEventListener("pagehide", (ev) => hub.pageHide(!!ev.persisted));
    win.addEventListener("pageshow", (ev) => {
      if (ev.persisted) hub.pageShow();
    });
    return hub;
  }
  var g = globalThis;
  if (typeof g.importScripts === "function" && typeof g.WorkerGlobalScope === "function" && typeof g.document === "undefined") {
    storeWorker(g);
  } else if (typeof g.window === "object" && g.window === g && g.document) {
    hubMain(g);
  }
})();
//# sourceMappingURL=hub.0a850d4744.js.map

// The hub's IndexedDB and its store ports (CONTRACTS "Hub protocol"). The database is
// core/storage.js's (STORE_DB, version 1, store `kv`: tests/runtime/hub_server.test.mjs reads storage.js's constants),
// so a top-level page on the hub's origin and the hub see the same records. Every write calls `tx.commit()` where it
// exists, so a put already handed to the browser is committed when the frame or worker is torn down.
// Without IndexedDB (Firefox's private windows before 115) the kind is `memory`: one Map per hub document, shared by
// its ports, gone with the page, which is what a page's own engine worker keeps save files in without IndexedDB
// (a worker has no localStorage), so the hub does not refuse the page for it.
// In a browser the store lives in a dedicated worker of the hub's origin (the same storage key as the hub frame;
// `storeWorker`): a same-site hub frame runs on the host page's event loop, and the engine worker's save maps (MBs for a
// YAYA or Kawari ghost, after every important event) would otherwise be decoded and written on the page's thread. The
// page's engine worker and the hub's store worker then talk directly over the port. The hub frame keeps the store
// itself only when no worker can be made (`storeHost`).
// The ports of the page's engine starts (marked `retire`) take no write once the hub's document went into the
// back/forward cache (its pagehide, persisted: `retire()`): the page starts its engines again after the restore with
// new ports, and a save the old engine posts meanwhile (a timer's, on its thaw after Back) would land over what another
// page stored while this one sat in the cache.
import { STORE_DB, RETIRED } from '../core/hubproto.js';

export const DB_VERSION = 1;
export const STORE = 'kv';

function idbOpen(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(STORE_DB, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
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
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    if (mode === 'readwrite' && typeof tx.commit === 'function') {
      try { tx.commit(); } catch (e) { /* already finishing */ }
    }
  });
}

/** The hub's store: Store's semantics (core/storage.js) over IndexedDB, or memory. */
export class HubStore {
  /** @param {IDBFactory|null|undefined} idb */
  static async open(idb) {
    const s = new HubStore();
    if (idb) {
      try {
        const db = await idbOpen(idb);
        db.onversionchange = () => { try { db.close(); } catch (e) { /* closed */ } s.lost = true; };
        db.onclose = () => { s.lost = true; };    // closed by the browser (site data cleared)
        s.db = db;
      } catch (e) {
        s.db = null;
      }
    }
    return s;
  }

  constructor() {
    this.db = null;
    this.lost = false;        // the database went away after it opened: reads fail, never answer "nothing stored"
    this.mem = new Map();
  }

  get kind() { return this.db ? 'indexeddb' : 'memory'; }

  /** The value or undefined; rejects when it cannot be read. */
  async read(key) {
    if (this.lost) throw new Error('the database was closed');
    if (this.db) return idbCall(this.db, 'readonly', st => st.get(key));
    return this.mem.get(key);
  }

  /** The value, or undefined when the read failed. */
  async get(key) {
    try { return await this.read(key); } catch (e) { return undefined; }
  }

  /** True when stored in IndexedDB (memory is no storage: false, as Store's). */
  async set(key, value) {
    if (!this.db) { this.mem.set(key, value); return false; }
    if (this.lost) return false;
    try {
      await idbCall(this.db, 'readwrite', st => st.put(value, key));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** False when the browser refused the delete. */
  async delete(key) {
    if (!this.db) { this.mem.delete(key); return true; }
    if (this.lost) return false;
    try {
      await idbCall(this.db, 'readwrite', st => st.delete(key));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** String keys that start with prefix; rejects when they cannot be listed. */
  async keys(prefix = '') {
    const p = String(prefix);
    if (this.lost) throw new Error('the database was closed');
    if (this.db) {
      const ks = await idbCall(this.db, 'readonly', st => st.getAllKeys(IDBKeyRange.bound(p, p + '￿')));
      return ks.filter(k => typeof k === 'string');
    }
    return [...this.mem.keys()].filter(k => typeof k === 'string' && k.startsWith(p));
  }
}

/** The ArrayBuffers of a value read from IndexedDB (itself, or a plain object's values: a save-file map), to transfer. */
export function buffersOf(v) {
  const out = new Set();
  const add = x => {
    if (x instanceof ArrayBuffer) { if (x.byteLength) out.add(x); } else if (ArrayBuffer.isView(x) && x.buffer instanceof ArrayBuffer && x.buffer.byteLength) out.add(x.buffer);
  };
  add(v);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) for (const x of Object.values(v)) add(x);
  return [...out];
}

const isKey = k => typeof k === 'string';

/**
 * Serve the store-port protocol (CONTRACTS "Hub protocol") on one port: first {t:'store', kind}, then one reply per op
 * {rid, ok: true, value} | {rid, ok: false, error}, in the order the ops arrive (each op's transaction is made when its
 * message is handled, and IndexedDB runs overlapping transactions in that order). `gate` (a port the page marked
 * `retire`): once `gate.retired` (the hub's pagehide with persisted: storeHost.retire), every `set` and `delete` is
 * answered {ok: false, error: RETIRED} and nothing is written; reads are still answered (an engine start that was under
 * way when the page went into the back/forward cache finishes its load quietly, then the restart replaces it).
 * @param {MessagePort} port
 * @param {HubStore} store
 * @param {{retired: boolean}|null} [gate]
 */
export function serveStorePort(port, store, gate = null) {
  const answer = (m, transfer) => {
    try {
      port.postMessage(m, transfer || []);
    } catch (e) {
      try { port.postMessage(m); } catch (e2) { /* closed */ }
    }
  };
  const ops = {
    read: async m => {
      const value = await store.read(m.key);
      return { value, transfer: store.db ? buffersOf(value) : [] };     // a memory value is the kept copy: no transfer
    },
    get: async m => {
      const value = await store.get(m.key);
      return { value, transfer: store.db ? buffersOf(value) : [] };
    },
    set: async m => ({ value: await store.set(m.key, m.value) }),
    delete: async m => ({ value: await store.delete(m.key) }),
    keys: async m => ({ value: await store.keys(m.prefix == null ? '' : m.prefix) }),
  };
  port.onmessage = ev => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    const rid = m.rid;
    const op = Object.prototype.hasOwnProperty.call(ops, m.op) ? ops[m.op] : null;
    if (!op) { answer({ rid, ok: false, error: 'unknown op' }); return; }
    if (gate && gate.retired && (m.op === 'set' || m.op === 'delete')) { answer({ rid, ok: false, error: RETIRED }); return; }
    if (m.op === 'keys' ? !(m.prefix == null || isKey(m.prefix)) : !isKey(m.key)) { answer({ rid, ok: false, error: 'bad key' }); return; }
    op(m).then(r => answer({ rid, ok: true, value: r.value }, r.transfer),
      e => answer({ rid, ok: false, error: String((e && e.message) || e) }));
  };
  if (typeof port.start === 'function') port.start();
  answer({ t: 'store', kind: store.kind });
}

/**
 * The gates of the ports attached with `retire` since the last retire(), and retire(): every one of them retired
 * (serveStorePort's `gate`). One per place a store is served: the frame, the store worker.
 */
function retirement() {
  const gates = new Set();
  return {
    gate(retire) {
      if (!retire) return null;
      const g = { retired: false };
      gates.add(g);
      return g;
    },
    retire() {
      for (const g of gates) g.retired = true;
      gates.clear();
    },
  };
}

/**
 * The hub frame's side of its store: a dedicated worker running this same script (`storeWorker`), or, when no worker
 * can be made or it fails to start, the store in the frame itself. attach(port, {retire}): `retire`, the page's mark
 * on an engine start's port (core/hub.js storePort); retire() (the hub's pagehide with persisted, server.js): every
 * port attached with it so far refuses writes from then on (the worker hears it after every port handed to it before,
 * in order), so a save an engine of the cached page posts after it never lands.
 * @param {{scriptUrl?: string|null, Worker?: Function|null, idb?: IDBFactory|null}} o
 * @returns {{open(): Promise<'indexeddb'|'memory'>, attach(port: MessagePort, o?: {retire?: boolean}): void,
 *   retire(): void, inWorker: boolean}}
 */
export function storeHost({ scriptUrl = null, Worker = null, idb = null } = {}) {
  let worker = null, local = null, opened = null;
  const here = () => local || (local = HubStore.open(idb));
  const frame = retirement();
  if (scriptUrl && typeof Worker === 'function') {
    try { worker = new Worker(scriptUrl, { name: 'sumika-hub-store' }); } catch (e) { worker = null; }
  }
  return {
    get inWorker() { return !!worker; },
    open() {
      if (opened) return opened;
      opened = new Promise(resolve => {
        if (!worker) { here().then(s => resolve(s.kind)); return; }
        const w = worker;
        let done = false;
        w.onmessage = ev => {
          if (done || !ev.data || ev.data.t !== 'opened') return;
          done = true;
          resolve(ev.data.kind === 'indexeddb' ? 'indexeddb' : 'memory');
        };
        w.onerror = ev => {    // the script failed to start in a worker (a worker-src policy, a network error)
          if (done) return;     // later errors: the ports it serves stay with it
          done = true;
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          if (worker === w) worker = null;
          here().then(s => resolve(s.kind));
        };
        try {
          w.postMessage({ t: 'open' });
        } catch (e) {
          done = true;
          worker = null;
          here().then(s => resolve(s.kind));
        }
      });
      return opened;
    },
    attach(port, { retire = false } = {}) {
      if (worker) {
        try { worker.postMessage({ t: 'port', retire: retire === true }, [port]); return; } catch (e) { worker = null; }
      }
      const gate = frame.gate(retire === true);
      here().then(s => serveStorePort(port, s, gate));
    },
    retire() {
      frame.retire();
      if (worker) { try { worker.postMessage({ t: 'retire' }); } catch (e) { /* gone, and its ports with it */ } }
    },
  };
}

/**
 * The store worker (the hub script run in a dedicated worker): {t:'open'} → {t:'opened', kind}; {t:'port', retire?} + a
 * port; {t:'retire'}: the ports handed over with `retire` before it refuse writes from then on.
 */
export function storeWorker(scope, idb) {
  if (idb === undefined) { try { idb = scope.indexedDB || null; } catch (e) { idb = null; } }
  let store = null;
  const get = () => store || (store = HubStore.open(idb));
  const here = retirement();
  scope.onmessage = ev => {
    const m = ev.data || {};
    if (m.t === 'open') get().then(s => scope.postMessage({ t: 'opened', kind: s.kind }));
    else if (m.t === 'port' && ev.ports && ev.ports[0]) {
      const port = ev.ports[0];
      const gate = here.gate(m.retire === true);
      get().then(s => serveStorePort(port, s, gate));
    } else if (m.t === 'retire') here.retire();
  };
}

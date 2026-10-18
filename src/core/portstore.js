// The hub's IndexedDB store over a MessagePort (CONTRACTS core/portstore.js, "Hub protocol" store ports): the interface
// of core/storage.js Store (kind, read, get, set, delete, keys) for a page whose records live at the storage hub. One
// client for both users: the page's dropped files (core/drops.js, through HubClient.openStore) and the engine worker's
// save files (worker.js init `storePort`). Like Store it keeps a memory map, so get() answers from this page's memory
// when the hub cannot read. Every op has a timeout: a hub that went away never hangs a boot (read and keys reject, set
// and delete answer false, so the worker takes its "could not be read: memory-only" path). A port the hub retired (an
// engine start's, once the page went into the back/forward cache: its write answered RETIRED) is a lost store from then
// on, quietly: kind 'memory', closed. Imports only hubproto.js's constants: the worker bundle takes it as it is.
import { RETIRED } from './hubproto.js';

/** How long the first message and each op may take before the hub counts as gone. */
export const STORE_OP_MS = 15000;
const KINDS = new Set(['indexeddb', 'memory']);

const realClock = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h) };

export class PortStore {
  /**
   * The store on `port` once the hub's first message {t:'store', kind} arrived. Kind 'memory' from the hub (no
   * IndexedDB there) is the hub document's memory, its ops answered as Store's memory kind answers them. With `local`
   * (a HubClient whose hub is not live: the message comes from the page itself), or no port, it is this page's memory
   * only, nothing sent. When nothing comes within timeoutMs the store is lost: kind 'memory', and every op answers as a
   * store that failed (read and keys reject: the worker then runs memory-only and writes nothing over the record the
   * hub may still hold).
   * @param {MessagePort|null} port  @param {{timeoutMs?: number, clock?: object}} [o]
   * @returns {Promise<PortStore>}
   */
  static open(port, { timeoutMs = STORE_OP_MS, clock = realClock } = {}) {
    const s = new PortStore(port, { timeoutMs, clock });
    if (!port) return Promise.resolve(s);
    return new Promise(resolve => {
      const t = clock.setTimeout(() => {
        if (s._opened) return;
        s._opened = true;
        s.close();
        resolve(s);
      }, timeoutMs);
      s._onOpen = () => { clock.clearTimeout(t); resolve(s); };
    });
  }

  constructor(port, { timeoutMs = STORE_OP_MS, clock = realClock } = {}) {
    this.port = port || null;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.mem = new Map();
    /** true once the port is let go (close(), an open that timed out): every op answers as a store that failed */
    this.closed = !port;
    this._local = !port;            // this page's memory only (no port, or the page's own `local` answer): nothing sent
    this._kind = 'memory';
    this._opened = !port;
    this._onOpen = null;
    this._rid = 0;
    this._pending = new Map();      // rid -> {resolve, reject, timer, fail}
    /** hold(true): writes stay in the memory map and are not sent (HubClient, a page going into the back/forward cache) */
    this.held = false;
    if (port) {
      port.onmessage = ev => this._onMessage(ev && ev.data);
      if (typeof port.start === 'function') { try { port.start(); } catch (e) { /* started by onmessage */ } }
    }
  }

  /** 'indexeddb' (the hub's), or 'memory' (the hub's memory, this page's, or lost) */
  get kind() { return this._kind; }

  _onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (!this._opened) {
      if (m.t !== 'store') return;
      this._opened = true;
      this._kind = KINDS.has(m.kind) ? m.kind : 'memory';
      if (m.local === true) { this._kind = 'memory'; this._local = true; this.close(); }
      if (this._onOpen) this._onOpen();
      return;
    }
    const p = typeof m.rid === 'number' ? this._pending.get(m.rid) : null;
    if (!p) return;
    this._pending.delete(m.rid);
    this.clock.clearTimeout(p.timer);
    if (m.ok === true) { p.resolve(m.value); return; }
    // retired by the hub (the page went into the back/forward cache; its restart starts the engine with a new port):
    // lost, as an open that timed out, so the worker writes nothing more and warns nothing (kind 'memory')
    if (m.error === RETIRED) { this._kind = 'memory'; this.close(); }
    p.fail(String(m.error || 'failed'));
  }

  /**
   * Writes held (HubClient, from a pagehide with persisted to its pageshow: nothing this page posts then may reach the
   * hub after Back): set and delete change the memory map only and answer false; reads still go.
   */
  hold(on) { this.held = !!on; }

  /** One op on the port; resolves with the reply's value; `fail(error)` decides a failure's answer (reject or a value). */
  _call(msg, fail) {
    return new Promise((resolve, reject) => {
      const answer = why => { try { resolve(fail(why)); } catch (e) { reject(e); } };
      if (this.closed) { answer('store closed'); return; }
      const rid = ++this._rid;
      const timer = this.clock.setTimeout(() => {
        if (!this._pending.delete(rid)) return;
        answer('the storage hub did not answer');
      }, this.timeoutMs);
      this._pending.set(rid, { resolve, reject, timer, fail: answer });
      try {
        this.port.postMessage({ ...msg, rid });
      } catch (e) {
        this._pending.delete(rid);
        this.clock.clearTimeout(timer);
        answer(e && e.message ? e.message : 'not sent');
      }
    });
  }

  /** The stored value or undefined; rejects when it cannot be read (Store.read). */
  async read(key) {
    if (this._local) return this.mem.get(key);
    return this._call({ op: 'read', key: String(key) }, why => { throw new Error(why); });
  }

  /** read(), or this page's memory when that fails (Store.get). */
  async get(key) {
    try {
      return await this.read(key);
    } catch (e) { /* fall through to memory */ }
    return this.mem.get(key);
  }

  /** @returns {Promise<boolean>} true when the value reached the hub's IndexedDB (not just memory) */
  async set(key, value) {
    this.mem.set(key, value);
    if (this._local || this.held) return false;
    return (await this._call({ op: 'set', key: String(key), value }, () => false)) === true;
  }

  /** @returns {Promise<boolean>} false when the delete was refused (or held) */
  async delete(key) {
    this.mem.delete(key);
    if (this._local) return true;
    if (this.held) return false;
    return (await this._call({ op: 'delete', key: String(key) }, () => false)) !== false;
  }

  /** String keys that start with prefix; rejects when the store cannot be listed (Store.keys). */
  async keys(prefix = '') {
    const p = String(prefix);
    if (this._local) return [...this.mem.keys()].filter(k => typeof k === 'string' && k.startsWith(p));
    const ks = await this._call({ op: 'keys', prefix: p }, why => { throw new Error(why); });
    if (!Array.isArray(ks)) throw new Error('not a key list');
    return ks.filter(k => typeof k === 'string' && k.startsWith(p));
  }

  /**
   * Let the port go (HubClient when the hub went away; an open that timed out). The hub never closes a store port at
   * its pagehide (a cached hub keeps it for the restore; a hub that goes takes it along). Ops waiting answer as failed
   * at once, and every later op too; the memory map stays.
   */
  close() {
    this.closed = true;
    for (const [rid, p] of this._pending) { this.clock.clearTimeout(p.timer); p.fail('store closed'); this._pending.delete(rid); }
    if (this.port) {
      try { this.port.onmessage = null; this.port.close(); } catch (e) { /* ignore */ }
      this.port = null;
    }
  }
}

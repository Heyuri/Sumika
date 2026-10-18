// Persistent key/value storage for save data and runtime state.
// IndexedDB when available; otherwise localStorage (values JSON-encoded, ArrayBuffers base64'd); otherwise memory.
// Every access is wrapped: private windows and blocked storage must never break the ghost.

// Frozen [decision, safe updates]: an upgrade is blocked by open tabs of older code, which then get a VersionError
// and run memory-only without a word. Versions live in the records and their keys (core/schema.js).
const DB_VERSION = 1;
const STORE = 'kv';

function idbOpen(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}

function idbCall(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function toB64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}
function encodeLS(v) {
  return JSON.stringify(v, (k, x) => (x instanceof ArrayBuffer ? { __ab: toB64(x) } : ArrayBuffer.isView(x) ? { __ab: toB64(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength)) } : x));
}
function decodeLS(s) {
  return JSON.parse(s, (k, x) => (x && typeof x === 'object' && typeof x.__ab === 'string' ? fromB64(x.__ab) : x));
}

export class Store {
  /** @param {string} namespace e.g. 'sumika' */
  static async open(namespace) {
    const s = new Store(namespace);
    try {
      if (typeof indexedDB !== 'undefined') s.db = await idbOpen(namespace);
    } catch (e) {
      s.db = null;
    }
    if (!s.db) {
      try {
        const k = `${namespace}:__probe`;
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        s.ls = true;
      } catch (e) {
        s.ls = false;
      }
    }
    return s;
  }

  constructor(namespace) {
    this.ns = namespace;
    this.db = null;
    this.ls = false;
    this.mem = new Map();
  }

  get kind() { return this.db ? 'indexeddb' : this.ls ? 'localstorage' : 'memory'; }

  async get(key) {
    try {
      return await this.read(key);
    } catch (e) { /* fall through to memory */ }
    return this.mem.get(key);
  }

  /**
   * get() for a reader that must not take a failed read for "nothing stored" (the worker's save files: schema.js
   * `files`): rejects when IndexedDB or localStorage cannot be read or the value cannot be decoded, where get() answers
   * from this page's memory. undefined when nothing is stored.
   */
  async read(key) {
    if (this.db) return idbCall(this.db, 'readonly', st => st.get(key));
    if (this.ls) {
      const s = localStorage.getItem(`${this.ns}:${key}`);
      return s == null ? undefined : decodeLS(s);
    }
    return this.mem.get(key);
  }

  /** @returns {Promise<boolean>} true when the value reached IndexedDB or localStorage (not just memory) */
  async set(key, value) {
    this.mem.set(key, value);
    try {
      if (this.db) { await idbCall(this.db, 'readwrite', st => st.put(value, key)); return true; }
      if (this.ls) { localStorage.setItem(`${this.ns}:${key}`, encodeLS(value)); return true; }
    } catch (e) { /* storage full or blocked: keep the in-memory copy */ }
    return false;
  }

  /** @returns {Promise<boolean>} false when the browser refused the delete */
  async delete(key) {
    this.mem.delete(key);
    try {
      if (this.db) await idbCall(this.db, 'readwrite', st => st.delete(key));
      else if (this.ls) localStorage.removeItem(`${this.ns}:${key}`);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** String keys that start with prefix. Rejects when the storage cannot be listed (callers must not guess). */
  async keys(prefix = '') {
    const p = String(prefix);
    if (this.db) {
      const ks = await idbCall(this.db, 'readonly', st => st.getAllKeys(IDBKeyRange.bound(p, p + '￿')));
      return ks.filter(k => typeof k === 'string');
    }
    if (this.ls) {
      const out = [], ns = `${this.ns}:`;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(ns + p)) out.push(k.slice(ns.length));
      }
      return out;
    }
    return [...this.mem.keys()].filter(k => typeof k === 'string' && k.startsWith(p));
  }
}

/** Tab-session flag: survives link clicks in the same tab, cleared when the tab closes. */
export const session = {
  get(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  },
  set(key, value) {
    try { sessionStorage.setItem(key, value); } catch (e) { /* ignore */ }
  },
  remove(key) {
    try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ }
  },
};

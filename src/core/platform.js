// Where the page's storage, locks and channels come from (CONTRACTS core/platform.js): the browser's own globals
// (localStorage, sessionStorage through storage.js `session`, IndexedDB through `Store`, navigator.locks,
// BroadcastChannel, the window's `storage` events), or the storage hub main.js installs with `data-hub` (core/hub.js:
// every record kept at the runtime host's origin, reached over postMessage). Every default is resolved when it is used,
// never captured at import or construction (tests swap globalThis.localStorage and friends), and with no hub each one
// is exactly what the code read before. No side effects: the worker bundle imports it through drops.js.
import { Store, session } from './storage.js';

let hub = null;

/** The HubClient main.js installed (pending, live or gone), or null: the browser's globals. A fallback clears it. */
export const platform = {
  get hub() { return hub; },
  install(h) { hub = h || null; },
  clear() { hub = null; },
};

/** The hub's synchronous localStorage mirror, or null (state.js defaultStorage: then pageStorage(), else memory). */
export function localStore() {
  return hub ? hub.local : null;
}

/**
 * The tab's sessionStorage (storage.js `session`'s shape, plus confirm): the hub's session mirror, else storage.js
 * `session`. confirm(k, v) resolves true when `k` is stored as `v` where it lives (the hub: after every earlier write
 * reached it; without the hub: the read-back).
 */
export const tabSession = {
  get(key) { return hub ? hub.session.get(key) : session.get(key); },
  set(key, value) { if (hub) hub.session.set(key, value); else session.set(key, value); },
  remove(key) { if (hub) hub.session.remove(key); else session.remove(key); },
  confirm(key, value) { return hub ? hub.session.confirm(key, value) : Promise.resolve(session.get(key) === value); },
};

/** The BroadcastChannel constructor: the hub's (null while it decides, or where it has none), else the page's or null. */
export function channelClass() {
  if (hub) return hub.Channel;
  return typeof BroadcastChannel === 'function' ? BroadcastChannel : null;
}

/** The Web Locks manager: the hub's (null while it decides, or where it has none), else navigator.locks or null. */
export function lockManager() {
  if (hub) return hub.locks;
  return (globalThis.navigator && globalThis.navigator.locks) || null;
}

/** An IndexedDB store (core/storage.js Store's interface): the hub's (core/portstore.js PortStore), else Store.open. */
export function openStore(namespace) {
  return hub ? hub.openStore(namespace) : Store.open(namespace);
}

/** () => Promise<{usage, quota}> of the storage that holds the records, or null when unknown. */
export function storageEstimate() {
  if (hub) return hub.estimator();
  const s = globalThis.navigator && globalThis.navigator.storage;
  return s && typeof s.estimate === 'function' ? () => s.estimate() : null;
}

/**
 * What `storage` listeners bind to: the hub's events once it decided (another tab's writes reach the mirror), else the
 * window (no hub; while it decides: the Site binds its listeners only after, Site.start).
 */
export function storageSource(win) {
  return hub && hub.state !== 'pending' ? hub.events : win;
}

/** A fresh MessagePort to the hub's store for one engine start (the worker's PortStore), or null: Store.open. */
export function storePort() {
  return hub ? hub.storePort() : null;
}

/** (lockName, key) => void: the hub stamps `savedAt` in `key` when that lock goes (a will); null without. */
export function stateWill() {
  if (!hub) return null;
  const h = hub;
  return (name, key) => h.will(name, key, 'savedAt');
}

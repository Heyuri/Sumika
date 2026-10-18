// The storage hub (CONTRACTS "Hub protocol"; CLAUDE.md "The storage hub"): the script of `sumika/hub.html`, which pages
// with `data-hub` on their script tag plant as a hidden iframe, so that the visitor's data of every allowlisted origin
// of one site lives in one place, the hub's origin. Built by tools/build.mjs into `sumika/engines/hub.<h>.js`
// (build.json `hub`; the fixed hub.html names it). The same file runs twice: in the hub frame (`hubMain`: the
// allowlist, the hello listener, server.js, pagehide / pageshow / storage), and as the frame's dedicated store worker
// (store.js `storeWorker`: the IndexedDB of the store ports). Opened top-level it does nothing.
import { HELLO } from '../core/hubproto.js';
import { parseAllowlist } from './allowlist.js';
import { sameSite } from './probe.js';
import { Hub } from './server.js';
import { storeHost, storeWorker } from './store.js';

/** The allowlist, next to hub.html. */
export const ALLOW_FILE = 'hub.json';
/** The hub's sessionStorage key for the allowlist it last fetched (outside `sumika.`, so no page reads or writes it). */
export const ALLOW_CACHE_KEY = 'sumika-hub:allow';
/**
 * How long a tab's hubs answer from the allowlist fetched by an earlier hub of that tab, instead of fetching hub.json
 * again before the first answer (one round trip less on every page of a visit). So an origin removed from hub.json is
 * refused within this time in a tab already open, at the next page in a new one.
 */
export const ALLOW_TTL_MS = 5 * 60 * 1000;

const PREFIX = '[sumika hub]';

/** The hub's console lines: warn and info always (the publisher's problems), debug when a page asked (?sumika-debug). */
export function hubLog(c = globalThis.console) {
  return {
    warn: (...a) => c.warn(PREFIX, ...a),
    info: (...a) => c.info(PREFIX, ...a),
    debug: (...a) => c.debug(PREFIX, ...a),
  };
}

/**
 * The allowlist: from this tab's hub cache when fetched less than ALLOW_TTL_MS ago, else hub.json fetched (no-cache,
 * no credentials). A missing, unreadable or unusable file answers no page; only a usable one is cached. Its ignored
 * entries and errors are warned in the hub's console.
 * @param {{url: string, fetch: Function, sessionStorage?: Storage|null, now?: () => number, log?: object}} o
 * @returns {Promise<ReturnType<typeof parseAllowlist>>}
 */
export async function loadAllowlist({ url, fetch, sessionStorage = null, now = () => Date.now(), log = hubLog() }) {
  const from = new URL(ALLOW_FILE, url).href;
  let text = null, cached = false;
  try {
    const c = JSON.parse(sessionStorage.getItem(ALLOW_CACHE_KEY));
    const age = now() - (c && c.at);
    if (c && c.from === from && typeof c.text === 'string' && age >= 0 && age < ALLOW_TTL_MS) { text = c.text; cached = true; }
  } catch (e) { /* none */ }
  if (!cached) {
    try {
      const r = await fetch(from, { cache: 'no-cache', credentials: 'omit' });
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
  } catch (e) { /* no session storage: fetched every time */ }
  if (!list.ok) log.warn(`sumika/hub.json: ${list.error}; this hub answers no page`);
  return list;
}

const tryGet = f => { try { return f(); } catch (e) { return null; } };

/**
 * The hub frame: nothing when opened top-level; otherwise the allowlist fetch starts at once, the store worker is
 * made, and the hello listener is installed before hub.html's `load` (this script is classic and blocking).
 * @param {Window} win
 * @returns {Hub|null}
 */
export function hubMain(win) {
  if (win.parent === win) return null;
  const doc = win.document;
  const log = hubLog(win.console);
  const ls = tryGet(() => win.localStorage);
  const ss = tryGet(() => win.sessionStorage);
  const nav = win.navigator || {};
  const allowlist = loadAllowlist({ url: win.location.href, fetch: (...a) => win.fetch(...a), sessionStorage: ss, log });
  const store = storeHost({
    scriptUrl: doc.currentScript && doc.currentScript.src,
    Worker: typeof win.Worker === 'function' ? win.Worker : null,
    idb: tryGet(() => win.indexedDB),
  });
  const est = nav.storage && typeof nav.storage.estimate === 'function' ? () => nav.storage.estimate() : null;
  const hub = new Hub({
    allowlist,
    localStorage: ls,
    sessionStorage: ss,
    locks: nav.locks && typeof nav.locks.request === 'function' ? nav.locks : null,
    Channel: typeof win.BroadcastChannel === 'function' ? win.BroadcastChannel : null,
    store,
    estimate: est,
    probe: () => sameSite({ document: doc, navigator: nav, location: win.location }),
    log,
  });
  win.addEventListener('message', ev => {
    if (ev.source !== win.parent) return;      // only the page this hub is planted in (not a window that holds it)
    const d = ev.data;
    if (!d || typeof d !== 'object' || d[HELLO] !== 1) return;
    const port = ev.ports && ev.ports[0];
    if (!port) return;
    hub.hello(ev.origin, d, port).catch(e => log.warn('hello failed', e));
  });
  win.addEventListener('storage', ev => { if (ls && ev.storageArea === ls) hub.storage(ev.key); });
  win.addEventListener('pagehide', ev => hub.pageHide(!!ev.persisted));
  win.addEventListener('pageshow', ev => { if (ev.persisted) hub.pageShow(); });
  return hub;
}

// which role: a dedicated worker (the store), or the hub frame
const g = globalThis;
if (typeof g.importScripts === 'function' && typeof g.WorkerGlobalScope === 'function' && typeof g.document === 'undefined') {
  storeWorker(g);
} else if (typeof g.window === 'object' && g.window === g && g.document) {
  hubMain(g);
}

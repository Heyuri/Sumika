// The page bundle (src/main.js bundled as tools/build.mjs bundles it) run in a vm context whose fetch, storages,
// IndexedDB, caches, Worker, BroadcastChannel, Web Locks, listeners and element creation are tripwires: for
// tests/runtime/support.test.mjs (the browser check) and default_state.test.mjs (data-default-state and the visitor's
// choice). Optionally the page origin's localStorage holds records (`local`: still every member access recorded), and
// the storage hub answers from a FakeHubSite (`hub`: tests/runtime/hub_fakes.mjs, the frame planted into a fake body).
// Not a test file itself.
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { common } from '../../tools/build.mjs';
import { memoryStorage } from '../../src/core/state.js';
import { fakePage, FakeChannel } from './hub_fakes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let bundled = null;
/** src/main.js bundled as tools/build.mjs bundles it (no map), in memory. */
export async function bundle() {
  if (!bundled) {
    const r = await esbuild.build({ ...common(false), sourcemap: false, entryPoints: [path.join(root, 'src/main.js')], outfile: path.join(root, 'site/sumika/sumika.js') });
    bundled = Buffer.from(r.outputFiles.find(f => f.path.endsWith('.js')).contents).toString('utf8');
  }
  return bundled;
}

/** A Storage over `store` whose every member access is recorded as `<name>.<member>` in hits (as the tripwire's). */
function recorded(name, store, hits) {
  return new Proxy(store, {
    get(t, k) {
      hits.push(`${name}.${String(k)}`);
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/**
 * Run the bundle as a page would: a document whose currentScript has `dataset`, location ?search, a desktop window
 * (a mouse, 1920×1080), and `hits`: every tripwire touched (a call of fetch, listeners or createElement, a member of
 * localStorage / sessionStorage / indexedDB / caches / navigator.locks, a Worker or BroadcastChannel made, body read).
 * wasm / bigint / bitmap false: that global is absent. `reads.WebAssembly` counts reads of WebAssembly. `listeners`:
 * [type, options] of each window.addEventListener, in order. `local`: entries of the page origin's localStorage (a
 * memory Storage, returned as `local`; its member accesses still recorded). `hub`: a FakeHubSite that answers the hub
 * frame: an iframe made is a FakeFrame of fakePage (recorded as `document.createElement:iframe`), appended to its body;
 * MessageChannel and MutationObserver are the fakes'; `loads`: what the frame loads (fakePage's). `api` is a getter:
 * window.sumika as it is now (main.js may replace it once the hub decided).
 */
export async function page({ wasm = true, bigint = true, bitmap = true, search = '', dataset = {}, src = 'http://site.test/sumika/sumika.js',
  local = null, hub = null, loads = ['hub'] } = {}) {
  const code = await bundle();
  const hits = [], warns = [], errors = [], infos = [], reads = { WebAssembly: 0 }, listeners = [];
  const rec = name => () => { hits.push(name); };
  const trap = name => new Proxy({}, { get(t, k) { hits.push(`${name}.${String(k)}`); return () => null; } });
  const script = { dataset: { ...dataset }, src };
  const hubPage = hub ? fakePage(hub, { loads }) : null;
  const document = {
    currentScript: script, readyState: 'complete', hidden: false, visibilityState: 'visible',
    querySelectorAll: () => [script],
    addEventListener: rec('document.addEventListener'), removeEventListener: rec('document.removeEventListener'),
    createElement: tag => {
      if (hubPage && tag === 'iframe') { hits.push('document.createElement:iframe'); return hubPage.document.createElement(tag); }
      hits.push('document.createElement');
      return undefined;
    },
    get body() { hits.push('document.body'); return hubPage ? hubPage.document.body : null; },
    documentElement: { clientWidth: 1280, clientHeight: 720 },
  };
  const store = local ? memoryStorage() : null;
  if (store) for (const [k, v] of Object.entries(local)) store.setItem(k, v);
  const sb = {
    document,
    location: { href: `http://site.test/${search}`, search, origin: 'http://site.test', protocol: 'http:', host: 'site.test' },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'test', locks: trap('navigator.locks') },
    console: {
      log() {}, info: (...a) => infos.push(a.map(String).join(' ')), debug() {},
      warn: (...a) => warns.push(a.map(String).join(' ')), error: (...a) => errors.push(a.map(String).join(' ')),
    },
    URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask,
    fetch: rec('fetch'), localStorage: store ? recorded('localStorage', store, hits) : trap('localStorage'),
    sessionStorage: trap('sessionStorage'), indexedDB: trap('indexedDB'), caches: trap('caches'),
    Worker: class { constructor() { hits.push('Worker'); } },
    BroadcastChannel: class { constructor() { hits.push('BroadcastChannel'); } postMessage() {} close() {} },
    addEventListener: (type, f, o) => { hits.push('window.addEventListener'); listeners.push([type, o]); },
    removeEventListener: rec('window.removeEventListener'),
    matchMedia: q => ({ media: q, matches: false }), screen: { width: 1920, height: 1080 }, innerWidth: 1280, innerHeight: 720,
    devicePixelRatio: 1,
  };
  if (hubPage) {
    sb.MessageChannel = FakeChannel;
    sb.MutationObserver = hubPage.MutationObserver;
  }
  Object.defineProperty(sb, 'WebAssembly', { get() { reads.WebAssembly++; return wasm ? WebAssembly : undefined; }, enumerable: true, configurable: true });
  if (!bigint) sb.BigInt64Array = undefined;      // shadows the context's own
  if (bitmap) sb.createImageBitmap = () => Promise.reject(new Error('not here'));
  sb.window = sb;
  sb.self = sb;
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'sumika.js' });
  return { get api() { return sb.sumika; }, sb, hits, warns, errors, infos, reads, listeners, local: store, hubPage };
}

/** Lets the page's promises and timers of a few ms run (the hub's handshake, a start). */
export const settled = (ms = 20) => new Promise(r => setTimeout(r, ms));

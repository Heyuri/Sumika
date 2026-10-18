// The storage hub end to end (CLAUDE.md "The storage hub"): both halves for real in one process, the page side
// (core/hub.js HubClient, core/portstore.js PortStore, core/platform.js, the Site, the worker's store choice) against the
// hub side (src/hub/hub.js hubMain: the allowlist fetched, the cookie probe, server.js, the store worker of store.js),
// over Node's MessageChannel. Only the browser around them is a stand-in: the hub origin's storage (localStorage, whose
// writes fire `storage` in the other hub windows; sessionStorage per tab; IndexedDB; Web Locks; BroadcastChannel;
// cookies), unpartitioned under a same-site top page and one partition per other top site, as Chromium measured
// (localhost ports are one site, 127.0.0.1 another). A navigation runs the page's pagehide, then the hub
// frame's, so the page's pagehide posts are lost as measured (0 of 20: CLAUDE.md "Visitor state"). Covered: a link from
// one origin to another resumes the ghost (her run replayed, no OnBoot); a tab closed while she idles gets savedAt from
// the hub's will and a new tab cold-boots her with it; two tabs of two origins coordinate (one engine, a takeover, a
// grant's delta, the set message, storage events); save files and a dropped file through the hub's store worker; the
// fallbacks (a cross-site page, an unlisted origin, a protocol mismatch) leave the page on its own origin and the hub's
// storage untouched. The back/forward cache as Firefox keeps it (the page and its hub frame frozen, what the page posts
// waiting at the frame until Back): a page's pagehide into the cache posts no write, and its engine worker's late save
// is refused at the hub, so what another origin wrote meanwhile stays and the page resumes from it; a pagehide not
// persisted as usual.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HubClient, hubAddress } from '../../src/core/hub.js';
import { platform } from '../../src/core/platform.js';
import { hubMain } from '../../src/hub/hub.js';
import { storeWorker, DB_VERSION, STORE } from '../../src/hub/store.js';
import { HUB_PARAM, HUB_PROTOCOL, STORE_DB } from '../../src/core/hubproto.js';
import { Site } from '../../src/core/site.js';
import { GhostLock, StateStore, memoryStorage, runtimePrefs, stateKey, sessionMarker } from '../../src/core/state.js';
import { UiLanguage } from '../../src/core/language.js';
import { UserProfile } from '../../src/core/user.js';
import { DropStore } from '../../src/core/drops.js';
import { PortStore } from '../../src/core/portstore.js';
import { LEAD_ID, markerGhosts } from '../../src/core/ghostset.js';
import { world, TestRuntime, fakeTarget, eng, loopOf, FakeLocks, busChannel } from './multi_world.mjs';

globalThis.self = globalThis.self || { postMessage() {} };
if (typeof globalThis.IDBKeyRange === 'undefined') globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
const { ENGINES } = await import('../../src/worker/engines/index.js');
const { writeSave } = await import('../../src/worker/worker.js');

const HUB_ORIGIN = 'http://localhost:8643';
const RUNTIME = `${HUB_ORIGIN}/sumika/sumika.js`;
const HUB_SCRIPT = `${HUB_ORIGIN}/sumika/engines/hub.0123456789.js`;
const A = 'http://localhost:8644';
const B = 'http://localhost:8645';
const CROSS = 'http://127.0.0.1:8644';
const T0 = new Date(2026, 9, 16, 9, 0, 0).getTime();

const quiet = { warn() {}, info() {}, debug() {} };
let warned;
const realWarn = console.warn, realInfo = console.info;
const CHANNELS = [];
const SITES = [];
beforeEach(() => {
  warned = [];
  console.warn = (...a) => warned.push(a.map(String).join(' '));
  console.info = () => {};
});
afterEach(() => {
  console.warn = realWarn;
  console.info = realInfo;
  for (const s of SITES.splice(0)) s.done();
  platform.clear();
  for (const c of CHANNELS.splice(0)) for (const p of [c.port1, c.port2]) { try { p.close(); } catch (e) { /* transferred */ } }
});

/** Node's MessageChannel, every one closed after the test (an open port keeps the process alive). */
class TrackedChannel extends MessageChannel {
  constructor() { super(); CHANNELS.push(this); }
}

/**
 * A MessageChannel whose messages can be held at the receiving port (`hold`) and let through later (`release()`), so a
 * test delivers them in an order a browser may: two messages crossing on the private port.
 */
class HoldableChannel {
  constructor() {
    const end = () => ({
      peer: null, onmessage: null, closed: false, hold: false, held: [],
      start() {},
      close() { this.closed = true; },
      postMessage(m) {
        const to = this.peer;
        if (this.closed || !to) return;
        const data = structuredClone(m);
        if (to.hold) to.held.push(data);
        else setImmediate(() => to._deliver(data));
      },
      _deliver(data) { if (!this.closed && typeof this.onmessage === 'function') this.onmessage({ data, ports: [] }); },
      /** what waits for this end, delivered now in order; later messages flow again */
      release() { this.hold = false; for (const d of this.held.splice(0)) this._deliver(d); },
    });
    this.port1 = end();
    this.port2 = end();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

/** Until f() (real time; Date.now may be a test's), at most `ms`. */
async function until(f, ms = 3000) {
  const end = performance.now() + ms;
  while (!f()) {
    if (performance.now() > end) return false;
    await new Promise(r => setTimeout(r, 2));
  }
  return true;
}
const pause = (n = 10) => until(() => false, n);

// ---------------------------------------------------------------- the browser

/** Map-backed Storage; `onWrite(key)` after each change. */
function mapStorage(m = new Map(), onWrite = () => {}) {
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { m.set(String(k), String(v)); onWrite(String(k)); },
    removeItem(k) { const had = m.delete(String(k)); if (had) onWrite(String(k)); },
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/** An IndexedDB stand-in: values cloned in and out, transactions complete in a later task. */
function fakeIdb() {
  const dbs = new Map();
  return {
    dbs,
    open(name, version) {
      const req = {};
      setTimeout(() => {
        const fresh = !dbs.has(name);
        const db = {
          onversionchange: null, onclose: null,
          createObjectStore() { dbs.set(name, { version, data: new Map() }); },
          transaction(store, mode) {
            const data = dbs.get(name) && dbs.get(name).data;
            if (store !== STORE || !data) throw new DOMException('no store', 'NotFoundError');
            const reqs = [];
            const op = fn => { const r = {}; reqs.push([r, fn]); return r; };
            const tx = {
              oncomplete: null, onerror: null, onabort: null, error: null, mode,
              commit() {},
              objectStore: () => ({
                get: k => op(() => structuredClone(data.get(k))),
                put: (v, k) => op(() => { data.set(k, structuredClone(v)); }),
                delete: k => op(() => { data.delete(k); }),
                getAllKeys: r => op(() => [...data.keys()].filter(k => typeof k !== 'string' || (k >= r.lower && k <= r.upper)).sort()),
              }),
            };
            setTimeout(() => {
              for (const [r, fn] of reqs) r.result = fn();
              if (tx.oncomplete) tx.oncomplete();
            });
            return tx;
          },
          close() {},
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

/** The site of an origin for this browser: localhost (every port, *.localhost) or the IP address. */
const siteOf = origin => (/^127\./.test(new URL(origin).hostname) ? new URL(origin).hostname : 'localhost');

class Browser {
  constructor() {
    this.parts = new Map();
    this.allow = [A, B];
    this.tabs = 0;
  }

  /** The hub origin's storage under a top page of `site`: first-party for its own site, else a partition. */
  part(site) {
    const key = site === siteOf(HUB_ORIGIN) ? 'first-party' : `partition:${site}`;
    if (!this.parts.has(key)) {
      this.parts.set(key, {
        local: new Map(), idb: fakeIdb(), locks: new FakeLocks(), Bus: busChannel(), cookies: new Map(),
        sessions: new Map(), wins: new Set(),
      });
    }
    return this.parts.get(key);
  }

  get first() { return this.part(siteOf(HUB_ORIGIN)); }

  tab() { return ++this.tabs; }

  /** The hub page's window in a frame of a page of `pageOrigin` in tab `tab` (what hub.html's script runs in). */
  hubWindow(tab, pageOrigin, parent) {
    const site = siteOf(pageOrigin);
    const part = this.part(site);
    const sameSite = site === siteOf(HUB_ORIGIN);
    if (!part.sessions.has(tab)) part.sessions.set(tab, mapStorage());
    const l = new Map();
    const win = {
      console: quiet,
      location: new URL(`${HUB_ORIGIN}/sumika/hub.html?${HUB_PARAM}=${HUB_PROTOCOL}`),
      sessionStorage: part.sessions.get(tab),
      navigator: { locks: part.locks, cookieEnabled: true, storage: { estimate: async () => ({ usage: 1, quota: 1e9 }) } },
      fetch: async url => (String(url) === `${HUB_ORIGIN}/sumika/hub.json`
        ? { ok: true, text: async () => JSON.stringify({ format: 1, origins: this.allow }) }
        : { ok: false, text: async () => '' }),
      BroadcastChannel: part.Bus,
      indexedDB: part.idb,
      Worker: class {                  // the store worker: hub.js again, in a worker of the hub's origin
        constructor(url) {
          assert.equal(url, HUB_SCRIPT);
          this.onmessage = null;
          this.onerror = null;
          this.scope = { postMessage: m => queueMicrotask(() => this.onmessage && this.onmessage({ data: m })), onmessage: null };
          storeWorker(this.scope, part.idb);
        }
        postMessage(m, transfer) { queueMicrotask(() => this.scope.onmessage({ data: m, ports: transfer || [] })); }
      },
      addEventListener(t, f) { if (!l.has(t)) l.set(t, []); l.get(t).push(f); },
      fire(t, ev) { for (const f of l.get(t) || []) f(ev); },
      parent,
    };
    win.window = win;
    // this window's localStorage: another window's write fires `storage` here, in a later task, as browsers do
    win.localStorage = mapStorage(part.local, key => {
      for (const o of part.wins) if (o !== win) setImmediate(() => o.fire('storage', { key, storageArea: o.localStorage }));
    });
    part.wins.add(win);
    // cookies: a script-set SameSite=Lax cookie is kept only when the frame is same-site with its top
    // (src/hub/probe.js)
    const doc = { currentScript: { src: HUB_SCRIPT } };
    Object.defineProperty(doc, 'cookie', {
      get: () => [...part.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      set: s => {
        const [pair, ...attrs] = s.split(/;\s*/);
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq);
        const age = attrs.find(x => /^max-age=/i.test(x));
        if (!sameSite && attrs.some(x => /^samesite=(lax|strict)$/i.test(x))) return;
        if (age && Number(age.split('=')[1]) <= 0) part.cookies.delete(name);
        else part.cookies.set(name, pair.slice(eq + 1));
      },
    });
    win.document = doc;
    win.gone = () => part.wins.delete(win);
    return win;
  }
}

/**
 * A page of `origin` in tab `tab` with `data-hub` (bare): main.js's HubClient, planting into a document whose frame
 * loads the hub page (hubMain, the real hub), and listening to the page's window (`win`, the HubSite's) first, as
 * main.js makes it before the Site. `hello` rewrites the hello in transit (a page of another protocol); `MC` is the
 * page's MessageChannel (HoldableChannel: the test orders the private port's messages).
 */
function page(br, tab, origin, { hello = d => d, MC = TrackedChannel } = {}) {
  const parent = { origin };
  const pg = { origin, frames: [], hubWins: [] };
  pg.win = fakeTarget({ location: { href: `${origin}/` } });
  pg.win.top = pg.win;
  const body = {
    appendChild(f) { f.parentNode = body; f.isConnected = true; pg.frames.push(f); setImmediate(() => f.load()); },
  };
  pg.document = {
    body, documentElement: body,
    createElement(tag) {
      assert.equal(tag, 'iframe');
      const loads = [];
      const f = {
        style: { setProperty() {} }, attrs: {}, contentWindow: null, isConnected: false, parentNode: null,
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener(t, fn) { if (t === 'load') loads.push(fn); },
        remove() {
          if (!f.parentNode) return;
          f.parentNode = null;
          f.isConnected = false;
          if (f.hubWin) { f.hubWin.fire('pagehide', { persisted: false }); f.hubWin.gone(); }
        },
        load() {
          if (!f.isConnected) return;
          const win = br.hubWindow(tab, origin, parent);
          f.hubWin = win;
          pg.hubWins.push(win);
          assert.ok(hubMain(win), 'framed: the hub runs');
          f.contentWindow = {
            postMessage(msg, targetOrigin, transfer = []) {
              if (targetOrigin !== HUB_ORIGIN) return;
              const data = hello(structuredClone(msg));
              setImmediate(() => win.fire('message', { source: parent, origin, data, ports: transfer }));
            },
          };
          for (const fn of loads) fn({ type: 'load' });
        },
      };
      return f;
    },
  };
  const url = hubAddress({ hub: '' }, RUNTIME, { origin });
  pg.hub = new HubClient(url, { document: pg.document, window: pg.win, MessageChannel: MC, MutationObserver: null });
  /** The page goes (a navigation or the tab closing): its pagehide, then the hub frame's; the page's posts are lost. */
  pg.leave = site => {
    if (site) site._onPageHide();
    for (const w of pg.hubWins) { w.fire('pagehide', { persisted: false }); w.gone(); }
  };
  return pg;
}

/** A page whose hub is live. */
async function livePage(br, tab, origin, o = {}) {
  const pg = page(br, tab, origin, o);
  assert.equal(await pg.hub.ready(), 'live');
  return pg;
}

// ---------------------------------------------------------------- the Site of a page

class HubRuntime extends TestRuntime {
  _newLock(id) { return new GhostLock(id); }          // the platform's (the hub's) locks and channels, as in a page
}

class HubSite extends Site {
  /** win: the page's window, the HubClient's (page()'s `win`); else one of its own at `href` */
  constructor(w, href, win = null) {
    super({
      base: 'http://s/', runtimeUrl: RUNTIME, defaultGhost: 'x', lead: true,
      language: new UiLanguage({ navigator: { languages: ['en-US'] } }), user: new UserProfile(),
      createRuntime: opts => new HubRuntime(w, opts),
    });
    this.w = w;
    this.doc = fakeTarget({ hidden: false });
    this.win = win || fakeTarget({ location: { href } });
    this.win.top = this.win;
    this.index = w.index;
    SITES.push(this);
  }
  _doc() { return this.doc; }
  _installPageHooks(win = this.win) { return super._installPageHooks(win); }
  _newLeadLock() { return new GhostLock(LEAD_ID); }
  done() {
    this._endThrough();                 // the leave-flush's write-through timer
    for (const rt of [...this.slots]) rt.done();
    if (this.lead) this.lead.dispose();
    if (this._channel) this._channel.close();
  }
}

const link = href => ({ href, matches: s => s === 'a[href], area[href]', hasAttribute: () => false, getAttribute: () => null });
const click = el => ({ type: 'click', button: 0, defaultPrevented: false, target: el, composedPath: () => [el] });
const hubState = (br, id) => JSON.parse(br.first.local.get(stateKey(id)) || 'null');

// ---------------------------------------------------------------- the tests

test('a link from one origin to another resumes the ghost: the run replayed, no OnBoot, the tab marker and the set from the hub; nothing on either page origin', async () => {
  const br = new Browser();
  const tab = br.tab();
  const w = world();
  const p1 = page(br, tab, A);
  platform.install(p1.hub);
  const s1 = new HubSite(w, `${A}/dev/elsewhere.html`);
  assert.equal(await s1.start(), 'booted');
  assert.equal(p1.hub.state, 'live');
  const x = s1.slots[0];
  assert.equal(eng(w, 'x').resume, false);
  assert.ok(x.player.busy, 'her boot talk plays');
  assert.deepEqual([...br.first.locks.held].sort(), ['sumika/lead', 'sumika:x'], 'the hub\'s Web Locks (the lead and her ghost lock)');
  // the visitor follows a link mid-talk: the leave-flush posts in the click's task, which reach the hub
  s1.win.fire('click', click(link(`${B}/dev/elsewhere.html`)));
  assert.ok(await until(() => hubState(br, 'x') && hubState(br, 'x').run), 'the state with her run, at the hub');
  assert.equal(hubState(br, 'x').run.src, '\\0x: first\\e', 'her first boot talk, under way');
  p1.leave(s1);
  await pause();
  assert.equal(br.first.locks.held.size, 0, 'the hub\'s pagehide let every lock go');
  s1.done();
  platform.clear();

  const p2 = page(br, tab, B);
  platform.install(p2.hub);
  const s2 = new HubSite(w, `${B}/dev/elsewhere.html`);
  assert.equal(await s2.start(), 'booted');
  const e = eng(w, 'x');
  assert.equal(e.resume, true, 'resumed on the other origin');
  assert.deepEqual(e.ids().filter(id => /OnBoot|OnFirstBoot/.test(id)), [], 'no greeting');
  const y = s2.find('x');
  assert.equal(y.player.replays.length, 1, 'her run replays');
  assert.equal(y.player.replays[0].run.src, '\\0x: first\\e');
  assert.deepEqual(markerGhosts(sessionMarker.read(p2.hub.session)), ['x'], 'the tab marker is the hub\'s (the same tab)');
  assert.deepEqual(runtimePrefs.get(p2.hub.local).ghosts, ['x']);
  assert.equal(globalThis.localStorage.length, 0, 'nothing in the pages\' own localStorage');
  assert.equal(globalThis.sessionStorage.length, 0);
  assert.equal(br.parts.size, 1, 'no partition: both origins are one site');
});

test('a tab closed while she idles: the page\'s last writes are lost, the hub\'s will stamps savedAt; a new tab on the other origin cold-boots her with that end', async () => {
  const real = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const br = new Browser();
    const w = world();
    const p1 = page(br, br.tab(), A);
    platform.install(p1.hub);
    const s1 = new HubSite(w, `${A}/`);
    assert.equal(await s1.start(), 'booted');
    s1.slots[0].player.finish();
    now = T0 + 60e3;
    s1.slots[0].state.saveNow();
    assert.ok(await until(() => hubState(br, 'x') && hubState(br, 'x').savedAt === T0 + 60e3), 'written through');
    await pause();
    now = T0 + 3600e3;                    // an hour idle: nothing written since; then the tab closes
    s1._onPageHide();                     // its saveNow (savedAt T0 + 1 h) is posted and lost
    now += 7;
    p1.leave();                           // the hub frame's pagehide
    assert.equal(hubState(br, 'x').savedAt, T0 + 3600e3 + 7, 'stamped by the hub at its pagehide, before the lock went');
    await pause();
    s1.done();
    platform.clear();

    now = T0 + 86400e3;                   // the next day, a new tab on the other origin
    const p2 = page(br, br.tab(), B);
    platform.install(p2.hub);
    const s2 = new HubSite(w, `${B}/`);
    assert.equal(await s2.start(), 'booted');
    assert.deepEqual([eng(w, 'x').resume, eng(w, 'x').sessionEndMs], [false, T0 + 3600e3 + 7], 'a cold boot told when the session ended (the will\'s stamp)');
  } finally {
    Date.now = real;
  }
});

test('two tabs on two origins coordinate as on one origin: one engine per ghost, a takeover request, a grant carrying the other\'s write, the set message after its delta, storage events', async () => {
  const br = new Browser();
  const a = await livePage(br, br.tab(), A);
  const b = await livePage(br, br.tab(), B);
  const la = new GhostLock('x', { locks: a.hub.locks, Channel: a.hub.Channel });
  const lb = new GhostLock('x', { locks: b.hub.locks, Channel: b.hub.Channel });
  assert.equal(la.mechanism, 'locks');
  assert.equal(await la.acquire(), true);
  assert.equal(await lb.acquire(), false, 'held by the other origin\'s tab');
  const asked = [];
  la.on('takeover-request', () => asked.push('a'));
  lb.requestTakeover();
  assert.ok(await until(() => asked.length === 1), 'the takeover request crossed origins');
  // A writes her state and lets her go; B, waiting, reads A's write when granted
  const sa = new StateStore('x', { storage: a.hub.local });
  sa.data.shell = 'winter';
  sa.saveNow();
  const sb = new StateStore('x', { storage: b.hub.local });
  sb.readOnly = true;
  const got = lb.acquire({ wait: true }).then(ok => { sb.reload(); return [ok, sb.data.shell]; });
  await pause();
  la.release();
  assert.deepEqual(await got, [true, 'winter']);
  assert.ok(br.first.locks.held.has('sumika:x'));
  // the set: B's channel message arrives after the stored set it announces
  const ca = new a.hub.Channel('sumika/runtime');
  const cb = new b.hub.Channel('sumika/runtime');
  const seen = [];
  cb.onmessage = ev => seen.push([ev.data.t, runtimePrefs.get(b.hub.local).ghosts]);
  await pause();
  runtimePrefs.set({ ghosts: ['x', 'y'], rev: 4 }, a.hub.local);
  ca.postMessage({ t: 'set', ghosts: ['x', 'y'], rev: 4 });
  assert.ok(await until(() => seen.length === 1));
  assert.deepEqual(seen, [['set', ['x', 'y']]]);
  // another tab's write reaches this tab's mirror with one storage event (Language ▸, the user information)
  const events = [];
  b.hub.events.addEventListener('storage', ev => events.push([ev.key, ev.newValue]));
  a.hub.local.setItem('sumika:e2e', 'ja');
  assert.ok(await until(() => b.hub.local.getItem('sumika:e2e') === 'ja'));
  assert.deepEqual(events, [['sumika:e2e', 'ja']]);
  lb.release();
  await pause();
  assert.equal(br.first.locks.held.size, 0);
  ca.close();
  cb.close();
  la.dispose();
  lb.dispose();
});

test('Back to a page from the back/forward cache after a ghost was called on the other origin: she resumes there too (the tab marker the other page wrote, read from the hub at pageshow), no greeting', async () => {
  const br = new Browser();
  const tab = br.tab();
  const w = world();
  const p1 = page(br, tab, A);
  platform.install(p1.hub);
  const s1 = new HubSite(w, `${A}/`, p1.win);
  assert.equal(await s1.start(), 'booted');
  s1.slots[0].player.finish();
  // a link to B (its leave-flush), then A goes into the back/forward cache (the page's pagehide, then its hub frame's)
  s1.win.fire('click', click(link(`${B}/`)));
  await pause(10);
  s1.win.fire('pagehide', { persisted: true });
  for (const hw of p1.hubWins) hw.fire('pagehide', { persisted: true });
  await pause(30);
  platform.clear();

  const p2 = page(br, tab, B);
  platform.install(p2.hub);
  const s2 = new HubSite(w, `${B}/`, p2.win);
  assert.equal(await s2.start(), 'booted');
  assert.equal(eng(w, 'x').resume, true);
  assert.equal(await s2.callGhost('y'), true, 'y called on B');
  for (const rt of s2.slots) if (rt.player && rt.player.finish) rt.player.finish();
  assert.deepEqual(markerGhosts(sessionMarker.read(p2.hub.session)), ['x', 'y']);
  assert.ok(await until(() => !!br.first.local.get(stateKey('y')) && markerGhosts(JSON.parse(br.first.sessions.get(tab).getItem('sumika.session') || 'null') || {}).includes('y')),
    'y\'s state and the tab marker naming her, at the hub');
  s2.win.fire('pagehide', { persisted: false });
  p2.leave();
  await pause(30);
  s2.done();
  platform.clear();

  // Back to A: its hub frame's pageshow, then the page's: the sync, then the restart
  assert.deepEqual(markerGhosts(sessionMarker.read(p1.hub.session)), ['x'], 'the cached mirror is A\'s old one');
  platform.install(p1.hub);
  for (const hw of p1.hubWins) hw.fire('pageshow', { persisted: true });
  const before = w.engines.length;
  s1.win.fire('pageshow', { persisted: true });
  assert.ok(await until(() => w.engines.length >= before + 2), 'x and y start again on A');
  await pause(20);
  const started = w.engines.slice(before);
  assert.deepEqual(started.map(e => [e.ghost, e.resume]).sort(), [['x', true], ['y', true]], 'both resumed');
  for (const e of started) assert.deepEqual(e.ids().filter(id => /^On(Boot|FirstBoot)$/.test(id.replace(/^\w+ /, ''))), [], `${e.ghost}: no greeting`);
  assert.deepEqual(markerGhosts(sessionMarker.read(p1.hub.session)), ['x', 'y'], 'A\'s mirror holds the hub\'s marker');
});

test('Back to a page from the back/forward cache, as Firefox does it (what the page posts from its pagehide on waits at its frozen hub frame and runs after Back): its pagehide posts no write and asks no engine for its files, so what the other origin wrote meanwhile stays; the page resumes from it', async () => {
  const br = new Browser();
  const tab = br.tab();
  const w = world();
  const p1 = page(br, tab, A, { MC: HoldableChannel });
  platform.install(p1.hub);
  const s1 = new HubSite(w, `${A}/`, p1.win);
  assert.equal(await s1.start(), 'booted');
  const e1 = eng(w, 'x');
  const pagePort = p1.hub._port;          // A's end of its private port
  const hubPort = pagePort.peer;          // its hub frame's end
  // a link to B mid-talk: the leave-flush, in the click's task, reaches the hub
  s1.input.ms = T0 + 1000;
  s1.win.fire('click', click(link(`${B}/`)));
  assert.ok(await until(() => hubState(br, 'x') && hubState(br, 'x').run), 'the leave-flush landed');
  const files = e1.persisted;
  // the navigation commits: A and its hub frame go into the cache, their task queues frozen from here (what each posts
  // to the other waits)
  hubPort.hold = true;
  pagePort.hold = true;
  s1.input.ms = T0 + 1500;
  s1.win.fire('pagehide', { persisted: true });
  for (const hw of p1.hubWins) hw.fire('pagehide', { persisted: true });
  assert.equal(p1.hub.hidden, true);
  await pause(30);
  const waiting = hubPort.held.map(m => m.op);
  assert.deepEqual(waiting.filter(op => /^(ls|ss)\.|^will$/.test(op)), [], 'no write waits at the frozen frame');
  assert.ok(waiting.includes('unlock'), 'the lock releases are still posted (late, they are no-ops)');
  assert.equal(e1.persisted, files, 'the engine was not asked for its files (the leave-flush stored them)');
  assert.equal(p1.hub.session.get('sumika.lastInputMs'), String(T0 + 1500), 'the mirror took the pagehide\'s writes');
  assert.equal(br.first.locks.held.size, 0, 'the cached hub let every lock go');
  platform.clear();

  // B: she resumes there and moves on (a tray icon set, the idle clock); B then goes (its pagehide's posts lost)
  const p2 = page(br, tab, B);
  platform.install(p2.hub);
  const s2 = new HubSite(w, `${B}/`, p2.win);
  assert.equal(await s2.start(), 'booted');
  assert.equal(eng(w, 'x').resume, true);
  const x2 = s2.find('x');
  loopOf(x2).trayIcon = 'b.ico';
  x2.state.saveNow();
  s2.input.ms = T0 + 9000;
  s2.input.flush();
  assert.ok(await until(() => hubState(br, 'x').trayIcon === 'b.ico' && br.first.sessions.get(tab).getItem('sumika.lastInputMs') === String(T0 + 9000)));
  s2.win.fire('beforeunload', {});
  await pause(10);
  p2.leave(s2);
  await pause(30);
  s2.done();
  platform.clear();
  const bState = br.first.local.get(stateKey('x'));
  assert.equal(JSON.parse(bState).trayIcon, 'b.ico');

  // Back to A: the pageshows (A's posts its sync), then each document runs what waited for it, in order
  platform.install(p1.hub);
  for (const hw of p1.hubWins) hw.fire('pageshow', { persisted: true });
  const before = w.engines.length;
  s1.win.fire('pageshow', { persisted: true });
  assert.equal(p1.hub.hidden, false);
  assert.ok(hubPort.held.some(m => m.op === 'sync'), 'the sync waits behind the pagehide\'s posts');
  hubPort.release();
  assert.equal(br.first.local.get(stateKey('x')), bState, 'B\'s state stands: nothing of A\'s pagehide landed over it');
  assert.equal(br.first.sessions.get(tab).getItem('sumika.lastInputMs'), String(T0 + 9000), 'B\'s idle clock too');
  pagePort.release();
  assert.ok(await until(() => w.engines.length > before), 'A starts her again');
  await pause(20);
  assert.equal(w.engines[w.engines.length - 1].resume, true);
  assert.equal(loopOf(s1.find('x')).trayIcon, 'b.ico', 'resumed from what B stored');
  assert.equal(p1.hub.session.get('sumika.lastInputMs'), String(T0 + 9000), 'A\'s mirror holds B\'s idle clock');
  // posting goes on as usual
  p1.hub.local.setItem('sumika:after', '1');
  assert.ok(await until(() => br.first.local.get('sumika:after') === '1'));
});

test('a page\'s pagehide that is not persisted with the hub: the save, the idle clock and the engine\'s files are posted as usual', async () => {
  const br = new Browser();
  const tab = br.tab();
  const w = world();
  const p1 = page(br, tab, A, { MC: HoldableChannel });
  platform.install(p1.hub);
  const s1 = new HubSite(w, `${A}/`, p1.win);
  assert.equal(await s1.start(), 'booted');
  const e1 = eng(w, 'x');
  await pause(10);
  const hubPort = p1.hub._port.peer;
  const files = e1.persisted;
  hubPort.hold = true;
  s1.win.fire('pagehide', { persisted: false });
  assert.equal(p1.hub.hidden, false);
  await pause(10);
  const posted = hubPort.held.map(m => m.op);
  assert.ok(posted.includes('ls.set') && posted.includes('ss.set') && posted.includes('unlock'), JSON.stringify(posted));
  assert.equal(e1.persisted, files + 1, 'the engine asked for its files');
  hubPort.release();
});

test('the engine worker\'s store port and the back/forward cache: retired at the hub\'s pagehide (persisted), so a save the worker posts after it (its timer\'s, after Back) is refused there and the other origin\'s newer save stays, quietly; the restart\'s new port stores; the dropped-file store keeps its port, holding its writes while cached', async () => {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  writeSave.warned = false;
  const br = new Browser();
  const tab = br.tab();
  const a = await livePage(br, tab, A);
  let next = null;                        // the save file the engine reports at its next save
  ENGINES.e2e = class {
    async boot() {}
    init(files, persisted) { this.loaded = persisted; return true; }
    request() { return 'SHIORI/3.0 204 No Content\r\n\r\n'; }
    save() {}
    changedFiles() { const n = next; next = null; return n === null ? {} : { 'save.txt': new Uint8Array([n]).buffer }; }
    unload() { return {}; }
    getVolatileState() { return null; }
  };
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => replies.push(m);
  const KEY = 'ghost:g:files';
  const stored = () => { const v = br.first.idb.dbs.get(STORE_DB).data.get(KEY); return v ? [...new Uint8Array(v['save.txt'])] : null; };
  try {
    const base = { engine: 'e2e', engineUrl: 'x', files: [], storeNamespace: STORE_DB, storeKey: KEY };
    await self.onmessage({ data: { t: 'init', id: 1, ...base, resume: false, storePort: a.hub.storePort() } });
    next = 1;
    await self.onmessage({ data: { t: 'persist', id: 2 } });
    assert.deepEqual(stored(), [1]);
    const drops = await a.hub.openStore(STORE_DB);
    assert.equal(await drops.set('drop:a', 'a'), true);
    // A goes into the cache: its pagehide (the HubClient first), then its hub frame's
    a.win.fire('pagehide', { persisted: true });
    for (const hw of a.hubWins) hw.fire('pagehide', { persisted: true });
    await pause(10);
    assert.equal(await drops.set('drop:b', 'b'), false, 'held while cached: not sent');
    // B stores a newer save meanwhile
    const b = await livePage(br, tab, B);
    const sb = await PortStore.open(b.hub.storePort());
    assert.equal(await sb.set(KEY, { 'save.txt': new Uint8Array([2]).buffer }), true);
    // A's worker saves late (its save timer on its thaw after Back, before the restart replaces it)
    next = 3;
    await self.onmessage({ data: { t: 'persist', id: 3 } });
    await pause(10);
    assert.deepEqual(stored(), [2], 'refused at the hub: B\'s save stays');
    assert.deepEqual(replies.filter(r => r.t === 'log' && r.level === 'warn'), [], 'no "did not store" warning: a retired port is a lost store');
    // Back: the pageshows; the restart starts the engine again with a new port, which reads B's save and stores
    for (const hw of a.hubWins) hw.fire('pageshow', { persisted: true });
    a.win.fire('pageshow', { persisted: true });
    await self.onmessage({ data: { t: 'init', id: 4, ...base, resume: true, storePort: a.hub.storePort() } });
    assert.equal(replies.find(r => r.t === 'loaded' && r.id === 4).hadSave, true);
    next = 4;
    await self.onmessage({ data: { t: 'persist', id: 5 } });
    assert.deepEqual(stored(), [4], 'the new port stores');
    assert.equal(await drops.set('drop:c', 'c'), true, 'the dropped-file store kept its port (never retired)');
    const keys = [...br.first.idb.dbs.get(STORE_DB).data.keys()].filter(k => k.startsWith('drop:')).sort();
    assert.deepEqual(keys, ['drop:a', 'drop:c'], 'what it held while cached was never sent');
    await self.onmessage({ data: { t: 'unload', id: 6 } });
    sb.close();
  } finally {
    delete ENGINES.e2e;
    self.postMessage = post;
  }
});

test('messages crossing on the private port (delivered by hand in orders a browser may): a page\'s write and another tab\'s delta for the same key; a channel delivery for a channel the page closed meanwhile; the mirror ends as the hub\'s storage and later deltas still come', async () => {
  const br = new Browser();
  const a = await livePage(br, br.tab(), A, { MC: HoldableChannel });
  const b = await livePage(br, br.tab(), B);
  const pagePort = a.hub._port;          // the page's end of its private port
  const hubPort = pagePort.peer;         // the hub frame's end
  const K = 'sumika:runtime';
  const hubValue = () => br.first.local.get(K);
  a.hub.local.setItem(K, 'b1');
  assert.ok(await until(() => hubValue() === 'b1' && b.hub.local.getItem(K) === 'b1'));
  // 1. A's write is on its way while B's write reaches A's hub frame (its storage event): their messages cross
  hubPort.hold = true;
  pagePort.hold = true;
  a.hub.local.setItem(K, 'b2');
  b.hub.local.setItem(K, 'other tab');
  assert.ok(await until(() => pagePort.held.length === 1), 'A\'s hub sent the delta');
  assert.deepEqual(pagePort.held[0].snap, { [K]: 'other tab' });
  hubPort.release();                     // A's write lands at the hub after the delta was taken
  pagePort.release();                    // then the delta reaches the page
  await pause(20);
  assert.equal(hubValue(), 'b2', 'the hub holds A\'s later write');
  assert.equal(a.hub.local.getItem(K), 'b2', 'and A\'s mirror agrees');
  assert.ok(await until(() => b.hub.local.getItem(K) === 'b2'), 'B hears A\'s write');
  b.hub.local.setItem(K, 'c');
  assert.ok(await until(() => a.hub.local.getItem(K) === 'c'), 'a later write of B still reaches A');
  // 2. B writes and posts on a channel; A's hub relays the post with the delta while A closes that channel
  const ca = new a.hub.Channel('sumika:x');
  const cb = new b.hub.Channel('sumika:x');
  const heard = [];
  ca.onmessage = ev => heard.push(ev.data);
  await pause(20);
  pagePort.hold = true;
  hubPort.hold = true;
  b.hub.local.setItem(K, '{"ghosts":["x","y"]}');
  cb.postMessage({ t: 'takeover' });
  assert.ok(await until(() => pagePort.held.some(m => m.t === 'bc')), 'A\'s hub relayed the post');
  assert.deepEqual(pagePort.held.find(m => m.t === 'bc').snap, { [K]: '{"ghosts":["x","y"]}' }, 'with the delta');
  ca.close();                             // GhostLock.dispose: the bc.close is on its way
  pagePort.release();
  hubPort.release();
  await pause(20);
  assert.deepEqual(heard, [], 'nothing delivered to the closed channel');
  assert.equal(a.hub.local.getItem(K), '{"ghosts":["x","y"]}', 'but its delta reached the mirror');
  await a.hub.sync();
  assert.equal(a.hub.local.getItem(K), hubValue(), 'nothing left between mirror and hub');
  cb.close();
});

test('the engine worker\'s save files and a dropped file go through the hub\'s store worker: written on one origin, read on the other', async () => {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  const br = new Browser();
  const a = await livePage(br, br.tab(), A);
  assert.equal(a.hub.caps.store, 'indexeddb');
  const seen = [];
  let n = 0;
  ENGINES.e2e = class {
    async boot() {}
    init(files, persisted, opts) { seen.push({ persisted, opts }); return true; }
    request() { return 'SHIORI/3.0 204 No Content\r\n\r\n'; }
    changedFiles() { n++; return n === 2 ? { 'save.txt': new Uint8Array([4, 2]).buffer } : {}; }
    unload() { return { 'save.txt': new Uint8Array([4, 2, 1]).buffer }; }
    save() {}
    getVolatileState() { return null; }
  };
  const replies = [];
  const post = self.postMessage;
  self.postMessage = m => replies.push(m);
  try {
    const base = { engine: 'e2e', engineUrl: 'x', files: [], storeNamespace: STORE_DB, storeKey: 'ghost:g:files' };
    await self.onmessage({ data: { t: 'init', id: 1, ...base, resume: false, storePort: a.hub.storePort() } });
    assert.deepEqual(replies.find(r => r.t === 'loaded' && r.id === 1).hadSave, false);
    await self.onmessage({ data: { t: 'req', id: 2, text: 'NOTIFY SHIORI/3.0\r\nID: OnSecondChange\r\n\r\n' } });
    await self.onmessage({ data: { t: 'unload', id: 3 } });
    const db = br.first.idb.dbs.get(STORE_DB);
    assert.equal(db.version, DB_VERSION);
    assert.deepEqual([...new Uint8Array(db.data.get('ghost:g:files')['save.txt'])], [4, 2, 1], 'in the hub\'s IndexedDB before unload answered');

    const b = await livePage(br, br.tab(), B);
    await self.onmessage({ data: { t: 'init', id: 4, ...base, resume: true, storePort: b.hub.storePort() } });
    assert.equal(replies.find(r => r.t === 'loaded' && r.id === 4).hadSave, true);
    assert.deepEqual([...new Uint8Array(seen[1].persisted['save.txt'])], [4, 2, 1], 'read back on the other origin');
    await self.onmessage({ data: { t: 'unload', id: 5 } });
  } finally {
    delete ENGINES.e2e;
    self.postMessage = post;
  }
  // a sound file dropped on A plays on B (a Blob through the hub)
  const b2 = await livePage(br, br.tab(), B);
  const da = new DropStore({ backend: () => a.hub.openStore(STORE_DB).then(s => (s.kind === 'indexeddb' ? s : null)), locks: a.hub.locks, estimate: a.hub.estimator(), storable: () => true });
  const [e] = da.add([new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: 'audio/mpeg' })]);
  await da.whenIdle();
  const db2 = new DropStore({ backend: () => b2.hub.openStore(STORE_DB).then(s => (s.kind === 'indexeddb' ? s : null)), locks: b2.hub.locks, estimate: null });
  const blob = await db2.blob(e.path);
  assert.ok(blob, 'found on the other origin');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
  assert.equal(globalThis.localStorage.length + globalThis.sessionStorage.length, 0, 'nothing on the pages\' own origins');
});

test('fallbacks: a cross-site page (127.0.0.1 against localhost), an unlisted origin and a protocol mismatch keep the page\'s data on its own origin; the hub\'s first-party storage is untouched', async () => {
  const cases = [
    ['cross-site (listed, as the join\'s serve.py --hub-allow lists it)', CROSS, {}, 'site'],
    ['an origin not in hub.json', 'http://localhost:8646', {}, 'origin'],
    ['a page of protocol 2 (the hello rewritten in transit)', A, { hello: d => ({ ...d, v: 2 }) }, 'version'],
  ];
  for (const [what, origin, o, reason] of cases) {
    const br = new Browser();
    br.allow = [A, B, CROSS];
    br.first.local.set('sumika:runtime', JSON.stringify({ ghosts: ['y'], v: 1 }));     // a visitor of the hub's pages
    globalThis.localStorage = memoryStorage();
    globalThis.sessionStorage = memoryStorage();
    warned.length = 0;
    const pg = page(br, br.tab(), origin, o);
    platform.install(pg.hub);
    assert.equal(await pg.hub.ready(), 'fallback', what);
    assert.equal(pg.hub.reason, reason, what);
    assert.equal(platform.hub, null, `${what}: the browser's own globals`);
    assert.equal(pg.frames[0].isConnected, false, `${what}: the frame removed`);
    if (reason === 'version') assert.ok(warned.some(x => /speaks protocol 1, this page 1/.test(x)), what);
    else if (reason === 'origin') assert.ok(warned.some(x => /not usable \(origin\)/.test(x)), what);
    const st = new StateStore('x');
    st.data.shell = 'own';
    st.saveNow();
    assert.equal(JSON.parse(globalThis.localStorage.getItem(stateKey('x'))).shell, 'own', `${what}: written on the page's origin`);
    assert.deepEqual(runtimePrefs.get().ghosts || [], [], `${what}: the hub's set is not this page's`);
    assert.deepEqual([...br.first.local.keys()], ['sumika:runtime'], `${what}: nothing written at the hub`);
    assert.equal(br.first.cookies.size, 0, `${what}: no cookie left`);
    if (reason === 'site') {
      const part = br.part('127.0.0.1');
      assert.equal(part.local.size, 0, 'the partitioned hub was never written');
      assert.equal(part.cookies.size, 0);
    }
    platform.clear();
  }
});

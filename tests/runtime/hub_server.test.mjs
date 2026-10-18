// The storage hub's side of the hub protocol (src/hub/server.js, probe.js, store.js, hub.js) on
// fakes: memory storages, a cookie jar, Node's real Web Locks and MessageChannel, a channel bus, an IndexedDB stand-in.
// A hello is acked before any check, then refused in check order (allowlist, origin, version, site, storage, busy) with
// nothing of the hub's storage touched before the origin passed, or welcomed with a snapshot of the `sumika:` /
// `sumika.` keys only. Ops apply in order; keys outside the prefixes are refused; a failed write is reported (and kept
// out of the deltas). Lock grants carry the delta; `unlock` and the hub's pagehide commit the wills before the release,
// so another tab is granted the lock only after the stamped write; the pagehide takes back the requests not granted,
// keeps channels and store ports for the back/forward cache, and there retires the store ports the page marked
// `retire` (their writes answered 'retired'). Channels and the storage event relay with deltas. Store ports serve
// Store's semantics over IndexedDB (writes committed) or memory, from a worker or the frame. The cookie probe and the
// hub's database constants (core/storage.js's).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../../src/hub/server.js';
import { parseAllowlist } from '../../src/hub/allowlist.js';
import { sameSite, storageWorks, PROBE_KEY } from '../../src/hub/probe.js';
import { HubStore, serveStorePort, storeHost, storeWorker, buffersOf, DB_VERSION, STORE } from '../../src/hub/store.js';
import { hubMain } from '../../src/hub/hub.js';
import { HELLO, HUB_MIN, HUB_MAX, PROBE_COOKIE, STORE_DB, REASONS } from '../../src/core/hubproto.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HUB = 'https://sumika.example.com/sumika/hub.html?sumika-hub=1';
const A = 'https://a.example.com';
const B = 'https://b.example.com';
const quiet = { warn() {}, info() {}, debug() {} };
const tick = () => new Promise(r => setImmediate(r));
let flushRid = 1000;
/** Every op posted on this page's port so far is applied (a flush round trip), and the locks it let go are free. */
async function settle(p) {
  const rid = ++flushRid;
  p.post({ op: 'flush', rid });
  await p.reply(rid);
  await tick(); await tick();
}
let nameSeq = 0;
/** A lock name no other test uses (Node's Web Locks are shared by the process). */
const lockName = () => `sumika:t${++nameSeq}`;

if (typeof globalThis.IDBKeyRange === 'undefined') globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };

/** A Storage: Map-backed; `quota` in UTF-16 units throws QuotaExceededError; `reads` counts every access. */
function memStorage({ quota = Infinity, broken = false } = {}) {
  const m = new Map();
  const s = {
    m,
    reads: 0,
    get length() { s.reads++; return m.size; },
    key(i) { s.reads++; return [...m.keys()][i] ?? null; },
    getItem(k) { s.reads++; return m.has(k) ? m.get(k) : null; },
    setItem(k, v) {
      if (broken) throw new DOMException('blocked', 'SecurityError');
      const val = String(v);
      let used = 0;
      for (const [kk, vv] of m) if (kk !== k) used += kk.length + vv.length;
      if (used + k.length + val.length > quota) throw new DOMException('full', 'QuotaExceededError');
      m.set(k, val);
    },
    removeItem(k) { if (broken) throw new DOMException('blocked', 'SecurityError'); m.delete(k); },
  };
  return s;
}

/** A document's cookie jar: 'same-site' keeps Lax cookies, 'cross-site' drops them, 'throw' refuses every write. */
function cookieDoc({ mode = 'same-site', hasAccess } = {}) {
  const jar = new Map();
  const doc = {
    jar,
    sets: [],
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(s) {
      if (mode === 'throw') throw new DOMException('blocked', 'SecurityError');
      doc.sets.push(s);
      const [pair, ...attrs] = s.split(/;\s*/);
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq), value = pair.slice(eq + 1);
      const a = Object.fromEntries(attrs.map(x => { const i = x.indexOf('='); return i < 0 ? [x.toLowerCase(), true] : [x.slice(0, i).toLowerCase(), x.slice(i + 1)]; }));
      if (mode === 'cross-site' && String(a.samesite).toLowerCase() !== 'none') return;
      if (Number(a['max-age']) <= 0) jar.delete(name); else jar.set(name, value);
    },
  };
  if (hasAccess !== undefined) doc.hasStorageAccess = typeof hasAccess === 'function' ? hasAccess : async () => hasAccess;
  return doc;
}

/** BroadcastChannel stand-in: every channel of one name on the bus hears the others (not itself). */
function bus() {
  const all = new Set();
  return class {
    constructor(name) { this.name = name; this.onmessage = null; this.closed = false; all.add(this); }
    postMessage(data) {
      if (this.closed) throw new DOMException('closed', 'InvalidStateError');
      const msg = structuredClone(data);
      for (const c of all) if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage && c.onmessage({ data: msg }));
    }
    close() { this.closed = true; all.delete(this); }
  };
}

/** A store host that records what it is asked. */
function fakeStore(kind = 'indexeddb') {
  return { opens: 0, attached: [], async open() { this.opens++; return kind; }, attach(p) { this.attached.push(p); } };
}

/** A rejected promise that is handled (awaited later). */
const rejected = () => { const p = Promise.reject(new Error('x')); p.catch(() => {}); return p; };

const LIST = parseAllowlist(JSON.stringify({ format: 1, origins: [A, B] }), HUB);

/** A hub document's environment; `shared` (localStorage, locks, Channel) stands for one browser's hub origin. */
function env(o = {}, shared = {}) {
  const doc = o.doc || cookieDoc();
  return {
    doc,
    allowlist: LIST,
    localStorage: shared.localStorage || memStorage(),
    sessionStorage: memStorage(),
    locks: globalThis.navigator.locks,
    Channel: shared.Channel || bus(),
    store: fakeStore(),
    estimate: async () => ({ usage: 10, quota: 100 }),
    probe: () => sameSite({ document: doc, navigator: { cookieEnabled: true }, location: new URL(HUB) }),
    now: () => 1234,
    log: quiet,
    ...o,
  };
}

/** The page's private channel: `hub` goes to Hub.hello, `page` collects what the hub says. */
function pagePort() {
  const { port1, port2 } = new MessageChannel();
  const msgs = [];
  let taken = 0;
  let wake = null;
  port2.onmessage = e => { msgs.push(e.data); if (wake) { const w = wake; wake = null; w(); } };
  const p = {
    hub: port1,
    page: port2,
    msgs,
    closed: false,
    post: (m, t) => port2.postMessage(m, t || []),
    /** The next message (after those taken) that matches. */
    async next(pred = () => true, ms = 2000) {
      const until = Date.now() + ms;
      for (;;) {
        for (let i = taken; i < msgs.length; i++) {
          if (pred(msgs[i])) { const m = msgs[i]; msgs.splice(i, 1); return m; }
        }
        if (Date.now() > until) throw new Error(`no message: ${JSON.stringify(msgs)}`);
        await new Promise(r => { wake = r; setTimeout(r, 20); });
      }
    },
    reply: rid => p.next(m => m.t === 'reply' && m.rid === rid),
    close() { port1.close(); port2.close(); },
  };
  port2.on('close', () => { p.closed = true; });
  return p;
}

/** A hub with a live connection for a page of origin A. */
async function live(o = {}, shared = {}) {
  const e = env(o, shared);
  const hub = new Hub(e);
  const port = pagePort();
  const r = await hub.hello(o.origin || A, { [HELLO]: 1, v: 1 }, port.hub);
  assert.equal(r, 'live');
  assert.equal((await port.next()).t, 'ack');
  const welcome = await port.next(m => m.t === 'welcome');
  return { e, hub, port, welcome, conn: hub.conn };
}

test('a hello is acked at once, before any check (the allowlist still loading), then welcomed', async () => {
  let resolve;
  const e = env({ allowlist: new Promise(r => { resolve = r; }) });
  const hub = new Hub(e);
  const port = pagePort();
  try {
    const done = hub.hello(A, { [HELLO]: 1, v: 1 }, port.hub);
    assert.deepEqual(await port.next(), { t: 'ack' });
    await tick();
    assert.equal(e.doc.sets.length, 0, 'no cookie before the allowlist answered');
    assert.equal(e.store.opens, 0);
    resolve(LIST);
    assert.equal(await done, 'live');
    const w = await port.next();
    assert.equal(w.t, 'welcome');
    assert.equal(w.v, 1);
  } finally { port.close(); }
});

test('every refusal, in check order: allowlist, origin, version, site, storage, busy; refused then the port closes', async () => {
  assert.deepEqual([...REASONS], ['origin', 'allowlist', 'version', 'site', 'storage', 'busy']);
  const cross = () => cookieDoc({ mode: 'cross-site' });
  const cases = [
    // [what, origin, hello, env overrides, reason]
    ['hub.json unusable (even for a listed origin, a bad version, cross-site)', A, { v: 9 },
      { allowlist: parseAllowlist(null, HUB), doc: cross() }, 'allowlist'],
    ['the allowlist promise rejected', A, { v: 1 }, { allowlist: rejected() }, 'allowlist'],
    ['an origin not listed (even with a bad version, cross-site)', 'https://evil.test', { v: 9 }, { doc: cross() }, 'origin'],
    ['a listed origin with another port', 'https://a.example.com:8443', { v: 1 }, {}, 'origin'],
    ['version 2 (even cross-site)', A, { v: 2 }, { doc: cross() }, 'version'],
    ['version 0', A, { v: 0 }, {}, 'version'],
    ['version "1"', A, { v: '1' }, {}, 'version'],
    ['no version', A, {}, {}, 'version'],
    ['cross-site: the Lax cookie does not read back (even with storage broken)', A, { v: 1 },
      { doc: cross(), localStorage: memStorage({ broken: true }) }, 'site'],
    ['a cookie setter that throws', A, { v: 1 }, { doc: cookieDoc({ mode: 'throw' }) }, 'site'],
    ['hasStorageAccess() false', A, { v: 1 }, { doc: cookieDoc({ hasAccess: false }) }, 'site'],
    ['a probe that throws', A, { v: 1 }, { probe: async () => { throw new Error('x'); } }, 'site'],
    ['localStorage refuses a write', A, { v: 1 }, { localStorage: memStorage({ broken: true }) }, 'storage'],
    ['no localStorage', A, { v: 1 }, { localStorage: null }, 'storage'],
  ];
  for (const [what, origin, hello, o, reason] of cases) {
    const e = env(o);
    const port = pagePort();
    try {
      const r = await new Hub(e).hello(origin, { [HELLO]: 1, ...hello }, port.hub);
      assert.equal(r, reason, what);
      assert.deepEqual(await port.next(), { t: 'ack' }, what);
      assert.deepEqual(await port.next(), { t: 'refused', reason, v: [HUB_MIN, HUB_MAX] }, what);
      if (['allowlist', 'origin', 'version'].includes(reason)) {
        assert.equal(e.doc.sets.length, 0, `${what}: no cookie set`);
        assert.equal(e.store.opens, 0, `${what}: the store not opened`);
        if (e.localStorage) assert.equal(e.localStorage.reads, 0, `${what}: localStorage not read`);
      }
      assert.equal(e.store.opens, 0, `${what}: no IndexedDB opened for a refused page`);
      for (let i = 0; i < 20 && !port.closed; i++) await tick();
      assert.ok(port.closed, `${what}: the port is closed`);
    } finally { port.close(); }
  }
  // busy: a second hello to the same hub document, also one still in its checks when the first is welcomed
  const e = env();
  const hub = new Hub(e);
  const p1 = pagePort(), p2 = pagePort(), p3 = pagePort();
  try {
    const [r1, r2] = await Promise.all([hub.hello(A, { [HELLO]: 1, v: 1 }, p1.hub), hub.hello(A, { [HELLO]: 1, v: 1 }, p2.hub)]);
    assert.deepEqual([r1, r2], ['live', 'busy']);
    assert.equal(await hub.hello(A, { [HELLO]: 1, v: 1 }, p3.hub), 'busy');
    assert.equal((await p3.next(m => m.t === 'refused')).reason, 'busy');
  } finally { p1.close(); p2.close(); p3.close(); }
});

test('the welcome: every sumika: localStorage key and sumika. session key, nothing else; otherUnits; caps', async () => {
  const ls = memStorage();
  ls.setItem('sumika:runtime', '{"ghosts":["a"]}');
  ls.setItem('sumika:ghost:a:state', '{"savedAt":5}');
  ls.setItem('other', 'xyz');               // the hub origin's own data: counted, never served
  ls.setItem('sumika-hub:allow', '12');
  ls.setItem('sumikax', '1');
  const ss = memStorage();
  ss.setItem('sumika.session', '{"ghosts":["a"]}');
  ss.setItem('sumika:notsession', '1');
  ss.setItem('sumika-hub:allow', '{}');
  const { port, welcome } = await live({ localStorage: ls, sessionStorage: ss });
  try {
    assert.deepEqual(welcome, {
      t: 'welcome', v: 1,
      local: { 'sumika:runtime': '{"ghosts":["a"]}', 'sumika:ghost:a:state': '{"savedAt":5}' },
      session: { 'sumika.session': '{"ghosts":["a"]}' },
      otherUnits: 'other'.length + 3 + 'sumika-hub:allow'.length + 2 + 'sumikax'.length + 1,
      caps: { locks: true, channels: true, store: 'indexeddb', estimate: true },
    });
    assert.equal(ls.m.has(PROBE_KEY), false, 'the storage probe left nothing');
  } finally { port.close(); }
  const r = await live({ locks: null, Channel: null, estimate: null, store: fakeStore('memory') });
  try {
    assert.deepEqual(r.welcome.caps, { locks: false, channels: false, store: 'memory', estimate: false });
  } finally { r.port.close(); }
});

test('ops apply in order; keys outside sumika: / sumika. are refused; a failed write is reported once in flush and kept out of deltas', async () => {
  const ls = memStorage({ quota: 200 });
  const { port, conn } = await live({ localStorage: ls });
  try {
    port.post({ op: 'ls.set', key: 'sumika:a', value: '1' });
    port.post({ op: 'ls.set', key: 'sumika:a', value: '2' });
    port.post({ op: 'ls.set', key: 'sumika:n', value: 7 });
    port.post({ op: 'ls.set', key: 'other', value: 'x' });
    port.post({ op: 'ls.set', key: 'sumika:big', value: 'x'.repeat(500) });
    port.post({ op: 'ls.remove', key: 'sumika:n' });
    port.post({ op: 'ss.set', key: 'sumika.session', value: 'm' });
    port.post({ op: 'ss.set', key: 'sumika:wrong', value: 'm' });
    port.post({ op: 'ss.remove', key: 'sumika.gone' });
    port.post({ op: 'flush', rid: 1, session: ['sumika.session', 'sumika.gone', 'other'] });
    const f = await port.reply(1);
    assert.deepEqual(f.value, { failed: ['other', 'sumika:big', 'sumika:wrong'], session: { 'sumika.session': 'm', 'sumika.gone': null } });
    assert.equal(ls.getItem('sumika:a'), '2');
    assert.equal(ls.getItem('sumika:n'), null);
    assert.equal(ls.getItem('other'), null);
    assert.equal(ls.getItem('sumika:big'), null);
    assert.deepEqual(conn.env.sessionStorage.m.get('sumika.session'), 'm');
    const failed = port.msgs.filter(m => m.t === 'failed');
    assert.deepEqual(failed.map(m => [m.op, m.key, m.error]), [['ls.set', 'other', 'key'], ['ls.set', 'sumika:big', 'QuotaExceededError'],
      ['ss.set', 'sumika:wrong', 'key']]);
    port.post({ op: 'flush', rid: 2 });
    assert.deepEqual((await port.reply(2)).value, { failed: [], session: {} }, 'reported once');
    port.post({ op: 'sync', rid: 3 });
    assert.deepEqual((await port.reply(3)).value, { snap: {}, session: { 'sumika.session': 'm' }, seq: 0 },
      'the page\'s own writes and its failed one are no delta; this tab\'s session keys; no write numbered yet');
    ls.setItem('sumika:a', 'other tab');
    ls.removeItem('sumika:a');
    ls.setItem('sumika:c', 'new');
    conn.env.sessionStorage.setItem('sumika.session', 'another page of the tab');
    conn.env.sessionStorage.setItem('sumika.lastInputMs', '5');
    conn.env.sessionStorage.setItem('other', 'x');
    port.post({ op: 'sync', rid: 4 });
    assert.deepEqual((await port.reply(4)).value, {
      snap: { 'sumika:a': null, 'sumika:c': 'new' },
      session: { 'sumika.session': 'another page of the tab', 'sumika.lastInputMs': '5' },
      seq: 0,
    });
    // numbered writes: the hub echoes the last one it handled (a failed one too) with every delta
    port.post({ op: 'ls.set', key: 'sumika:d', value: '1', seq: 7 });
    port.post({ op: 'ls.set', key: 'sumika:big', value: 'x'.repeat(500), seq: 8 });
    port.post({ op: 'ss.set', key: 'sumika.session', value: 'n', seq: 99 });
    port.post({ op: 'ls.remove', key: 'sumika:d', seq: 'x' });
    port.post({ op: 'sync', rid: 7 });
    assert.deepEqual((await port.reply(7)).value.seq, 8, 'only an ls.* integer seq counts');
    assert.equal(conn.seq, 8);
    port.post({ op: 'nope', rid: 5 });
    assert.deepEqual(await port.reply(5), { t: 'reply', rid: 5, ok: false, error: 'unknown op' });
    port.post({ op: 'nope2', key: 'k' });
    assert.deepEqual(await port.next(m => m.t === 'failed' && m.op === 'nope2'), { t: 'failed', op: 'nope2', key: 'k', error: 'unknown op' });
    port.post({ op: 'estimate', rid: 6 });
    assert.deepEqual((await port.reply(6)).value, { usage: 10, quota: 100 });
  } finally { port.close(); }
});

test('locks: a grant carries the delta; ifAvailable answers at once; a name outside sumika is refused', async () => {
  const shared = { localStorage: memStorage() };
  const a = await live({}, shared);
  const b = await live({ origin: B }, shared);
  const name = lockName();
  try {
    a.port.post({ op: 'lock', rid: 1, name, ifAvailable: true });
    const g = await a.port.reply(1);
    assert.deepEqual(g.value, { granted: true, snap: {}, seq: 0 });
    shared.localStorage.setItem('sumika:x', '1');            // another tab's write meanwhile
    b.port.post({ op: 'lock', rid: 1, name, ifAvailable: true });
    assert.deepEqual((await b.port.reply(1)).value, { granted: false });
    b.port.post({ op: 'lock', rid: 2, name });               // a wait
    await tick(); await tick();
    assert.equal(b.port.msgs.some(m => m.rid === 2), false, 'still waiting');
    a.port.post({ op: 'unlock', rid: 1 });
    assert.deepEqual((await b.port.reply(2)).value, { granted: true, snap: { 'sumika:x': '1' }, seq: 0 });
    b.port.post({ op: 'lock', rid: 3, name: 'other' });
    assert.deepEqual(await b.port.reply(3), { t: 'reply', rid: 3, ok: false, error: 'name' });
    b.port.post({ op: 'lock', rid: 2, name });
    assert.equal((await b.port.reply(2)).error, 'rid in use');
    a.port.post({ op: 'unlock', rid: 99 });                  // unknown: nothing
    b.port.post({ op: 'unlock', rid: 2 });
    await settle(b.port);
    a.port.post({ op: 'lock', rid: 4, name, ifAvailable: true });
    assert.equal((await a.port.reply(4)).value.granted, true, 'released by b');
    a.port.post({ op: 'unlock', rid: 4 });
  } finally { a.port.close(); b.port.close(); }
  const n = await live({ locks: null });
  try {
    n.port.post({ op: 'lock', rid: 1, name: lockName() });
    assert.deepEqual(await n.port.reply(1), { t: 'reply', rid: 1, ok: false, error: 'no locks' });
  } finally { n.port.close(); }
});

test('wills: unlock stamps savedAt before the release, so the next holder\'s grant already carries it; skipped when not held or not a stamped record', async () => {
  const shared = { localStorage: memStorage() };
  const ls = shared.localStorage;
  let t = 1000;
  const a = await live({ now: () => t }, shared);
  const b = await live({ origin: B, now: () => t }, shared);
  const name = lockName();
  const key = `sumika:ghost:${name.slice(7)}:state`;
  try {
    ls.setItem(key, JSON.stringify({ v: 1, run: null, savedAt: 5, text: 'あ' }));
    ls.setItem('sumika:noobj', '[1,2]');
    ls.setItem('sumika:nostamp', '{"x":1}');
    ls.setItem('sumika:strstamp', '{"savedAt":"5"}');
    ls.setItem('sumika:broken', '{');
    a.port.post({ op: 'will', name, key, stamp: 'savedAt' });          // not held yet: ignored
    a.port.post({ op: 'lock', rid: 1, name });
    await a.port.reply(1);
    for (const k of ['sumika:noobj', 'sumika:nostamp', 'sumika:strstamp', 'sumika:broken', 'sumika:absent']) {
      a.port.post({ op: 'will', name, key: k, stamp: 'savedAt' });
    }
    a.port.post({ op: 'will', name, key: 'other', stamp: 'savedAt' });   // not a sumika: key
    a.port.post({ op: 'will', name, key, stamp: 'saved-at' });           // no stamp name
    a.port.post({ op: 'will', name: 'sumika:notheld', key, stamp: 'savedAt' });
    a.port.post({ op: 'flush', rid: 2 });
    await a.port.reply(2);
    assert.deepEqual(a.conn.wills.get(name) && [...a.conn.wills.get(name).keys()],
      ['sumika:noobj', 'sumika:nostamp', 'sumika:strstamp', 'sumika:broken', 'sumika:absent']);
    a.port.post({ op: 'will', name, key, stamp: 'savedAt' });
    b.port.post({ op: 'lock', rid: 1, name });
    t = 99999;
    a.port.post({ op: 'unlock', rid: 1 });
    const g = await b.port.reply(1);
    assert.equal(JSON.parse(g.value.snap[key]).savedAt, 99999, 'b\'s grant carries the stamped record');
    assert.deepEqual(JSON.parse(ls.getItem(key)), { v: 1, run: null, savedAt: 99999, text: 'あ' }, 'only the stamp changed');
    assert.equal(ls.getItem('sumika:noobj'), '[1,2]');
    assert.equal(ls.getItem('sumika:nostamp'), '{"x":1}');
    assert.equal(ls.getItem('sumika:strstamp'), '{"savedAt":"5"}');
    assert.equal(ls.getItem('sumika:broken'), '{');
    assert.equal(ls.getItem('sumika:absent'), null);
    assert.equal(a.conn.wills.size, 0, 'the wills go with the lock');
    // a will of b's tenure, then b unlocks with no will: a's old will is not committed again
    t = 5;
    b.port.post({ op: 'unlock', rid: 1 });
    await settle(b.port);
    a.port.post({ op: 'lock', rid: 3, name, ifAvailable: true });
    assert.equal((await a.port.reply(3)).value.granted, true);
    assert.equal(JSON.parse(ls.getItem(key)).savedAt, 99999);
    a.port.post({ op: 'unlock', rid: 3 });
  } finally { a.port.close(); b.port.close(); }
});

test('pagehide: wills committed and every lock released before {t:"gone"}; requests not granted are answered aborted and never held; channels closed', async () => {
  const shared = { localStorage: memStorage(), Channel: bus() };
  const ls = shared.localStorage;
  const a = await live({ now: () => 777 }, shared);
  const b = await live({ origin: B }, shared);
  const x = lockName(), y = lockName();
  const key = `sumika:ghost:${x.slice(7)}:state`;
  try {
    ls.setItem(key, '{"savedAt":1}');
    a.port.post({ op: 'lock', rid: 1, name: x });
    await a.port.reply(1);
    a.port.post({ op: 'will', name: x, key, stamp: 'savedAt' });
    b.port.post({ op: 'lock', rid: 1, name: y });
    await b.port.reply(1);
    a.port.post({ op: 'lock', rid: 2, name: y });            // waits for b
    a.port.post({ op: 'bc.open', cid: 1, name: 'sumika/runtime' });
    b.port.post({ op: 'lock', rid: 2, name: x });            // waits for a
    await settle(b.port);
    await settle(a.port);
    a.hub.pageHide(false);
    assert.deepEqual(await a.port.reply(2), { t: 'reply', rid: 2, ok: false, error: 'aborted' });
    assert.deepEqual(await a.port.next(m => m.t === 'gone'), { t: 'gone', persisted: false });
    const g = await b.port.reply(2);
    assert.equal(JSON.parse(g.value.snap[key]).savedAt, 777, 'stamped before the release');
    b.port.post({ op: 'unlock', rid: 1 });                    // y free: a's aborted wait must not take it
    await tick(); await tick();
    b.port.post({ op: 'lock', rid: 3, name: y, ifAvailable: true });
    assert.equal((await b.port.reply(3)).value.granted, true, 'nobody holds y');
    assert.equal(a.conn.held.size, 0);
    assert.equal(a.conn.channels.size, 0, 'channels closed when the document goes');
    a.port.post({ op: 'ls.set', key: 'sumika:late', value: '1' });
    await tick(); await tick();
    assert.equal(ls.getItem('sumika:late'), null, 'nothing after the document went');
    b.port.post({ op: 'unlock', rid: 2 });
    b.port.post({ op: 'unlock', rid: 3 });
  } finally { a.port.close(); b.port.close(); }
});

test('back/forward cache: pagehide(persisted) releases and stamps, keeps channels and store ports; lock requests while hidden are aborted, after pageshow served', async () => {
  const shared = { localStorage: memStorage(), Channel: bus() };
  const a = await live({}, shared);
  const b = await live({ origin: B }, shared);
  const x = lockName();
  try {
    a.port.post({ op: 'lock', rid: 1, name: x });
    await a.port.reply(1);
    a.port.post({ op: 'bc.open', cid: 1, name: 'sumika/runtime' });
    const { port1 } = new MessageChannel();
    a.port.post({ op: 'store', pid: 1, port: port1 }, [port1]);
    a.port.post({ op: 'flush', rid: 9 });
    await a.port.reply(9);
    assert.equal(a.e.store.attached.length, 1, 'the store port went to the store host');
    a.hub.pageHide(true);
    assert.deepEqual(await a.port.next(m => m.t === 'gone'), { t: 'gone', persisted: true });
    await tick(); await tick();
    b.port.post({ op: 'lock', rid: 1, name: x, ifAvailable: true });
    assert.equal((await b.port.reply(1)).value.granted, true, 'released into the cache');
    a.port.post({ op: 'lock', rid: 2, name: lockName() });
    assert.equal((await a.port.reply(2)).error, 'aborted', 'no grant reaches a cached hub');
    a.hub.pageShow();
    b.port.post({ op: 'bc.open', cid: 7, name: 'sumika/runtime' });
    b.port.post({ op: 'bc.post', cid: 7, data: { t: 'set', rev: 3 } });
    assert.deepEqual((await a.port.next(m => m.t === 'bc')).data, { t: 'set', rev: 3 }, 'its channel outlived the cache');
    a.port.post({ op: 'lock', rid: 3, name: lockName(), ifAvailable: true });
    assert.equal((await a.port.reply(3)).value.granted, true);
    a.port.post({ op: 'unlock', rid: 3 });
    b.port.post({ op: 'unlock', rid: 1 });
  } finally { a.port.close(); b.port.close(); }
});

test('a wait taken back by unlock is answered aborted once; a grant that comes anyway is let go at once', async () => {
  const shared = { localStorage: memStorage() };
  const a = await live({}, shared);
  const b = await live({ origin: B }, shared);
  const x = lockName();
  try {
    a.port.post({ op: 'lock', rid: 1, name: x });
    await a.port.reply(1);
    b.port.post({ op: 'lock', rid: 1, name: x });
    await tick();
    b.port.post({ op: 'unlock', rid: 1 });
    assert.deepEqual(await b.port.reply(1), { t: 'reply', rid: 1, ok: false, error: 'aborted' });
    a.port.post({ op: 'unlock', rid: 1 });
    await tick(); await tick();
    a.port.post({ op: 'lock', rid: 2, name: x, ifAvailable: true });
    assert.equal((await a.port.reply(2)).value.granted, true, 'b never took it');
    assert.equal(b.port.msgs.filter(m => m.rid === 1).length, 0, 'one answer only');
    a.port.post({ op: 'unlock', rid: 2 });
  } finally { a.port.close(); b.port.close(); }
});

test('channels relay both ways with the delta; the storage event relays a delta; bc.close; a name outside sumika is refused', async () => {
  const shared = { localStorage: memStorage(), Channel: bus() };
  const ls = shared.localStorage;
  const a = await live({}, shared);
  const b = await live({ origin: B }, shared);
  try {
    a.port.post({ op: 'bc.open', cid: 1, name: 'sumika/runtime' });
    a.port.post({ op: 'bc.open', cid: 2, name: 'sumika/runtime' });   // a second object of the page hears the first
    b.port.post({ op: 'bc.open', cid: 5, name: 'sumika/runtime' });
    await settle(a.port);
    await settle(b.port);
    b.port.post({ op: 'ls.set', key: 'sumika:runtime', value: '{"rev":2}' });
    b.port.post({ op: 'bc.post', cid: 5, data: { t: 'set', rev: 2 } });
    const m1 = await a.port.next(m => m.t === 'bc' && m.cid === 1);
    assert.deepEqual(m1, { t: 'bc', cid: 1, data: { t: 'set', rev: 2 }, snap: { 'sumika:runtime': '{"rev":2}' }, seq: 0 });
    const m2 = await a.port.next(m => m.t === 'bc' && m.cid === 2);
    assert.deepEqual(m2.snap, {}, 'the delta goes once');
    a.port.post({ op: 'bc.post', cid: 1, data: { t: 'view', id: 'x' } });
    assert.deepEqual((await a.port.next(m => m.t === 'bc' && m.cid === 2)).data, { t: 'view', id: 'x' });
    assert.deepEqual((await b.port.next(m => m.t === 'bc' && m.cid === 5)).data, { t: 'view', id: 'x' });
    await tick();
    assert.equal(a.port.msgs.some(m => m.t === 'bc' && m.cid === 1), false, 'not to itself');
    // the window's storage event: another document of the hub origin wrote; the echo is a's last numbered write
    a.port.post({ op: 'ls.set', key: 'sumika:mine', value: '1', seq: 3 });
    await settle(a.port);
    ls.setItem('sumika:lang', 'ja');
    a.hub.storage('sumika:lang');
    assert.deepEqual(await a.port.next(m => m.t === 'storage'), { t: 'storage', snap: { 'sumika:lang': 'ja' }, seq: 3 });
    a.hub.storage('other');
    a.hub.storage('sumika:lang');           // nothing changed since: nothing sent
    ls.m.clear();
    a.hub.storage(null);                    // clear(): the full delta
    const cleared = await a.port.next(m => m.t === 'storage');
    assert.deepEqual(cleared.snap, { 'sumika:runtime': null, 'sumika:mine': null, 'sumika:lang': null });
    a.port.post({ op: 'bc.close', cid: 2 });
    a.port.post({ op: 'bc.open', cid: 3, name: 'other' });
    assert.deepEqual(await a.port.next(m => m.t === 'failed'), { t: 'failed', op: 'bc.open', key: 'other', error: 'name' });
    await settle(a.port);
    b.port.post({ op: 'bc.post', cid: 5, data: 1 });
    await a.port.next(m => m.t === 'bc' && m.cid === 1);
    await tick(); await tick();
    assert.equal(a.port.msgs.some(m => m.t === 'bc' && m.cid === 2), false, 'closed');
  } finally { a.port.close(); b.port.close(); }
});

test('the store op hands the page\'s port to the store host (in the data or the transfer list)', async () => {
  const r = await live();
  try {
    const c1 = new MessageChannel(), c2 = new MessageChannel();
    r.port.post({ op: 'store', pid: 1, port: c1.port2 }, [c1.port2]);
    r.port.post({ op: 'store', pid: 2 }, [c2.port2]);
    r.port.post({ op: 'store', pid: 3 });
    assert.deepEqual(await r.port.next(m => m.t === 'failed'), { t: 'failed', op: 'store', key: 3, error: 'no port' });
    assert.equal(r.e.store.attached.length, 2);
    c1.port1.close(); c2.port1.close();
  } finally { r.port.close(); }
});

// ---- the cookie probe ----

test('the same-site probe: a Lax cookie with a nonce in its name and the hub page\'s Path, Secure on https, deleted at once', async () => {
  const doc = cookieDoc();
  const loc = new URL(HUB);
  assert.equal(await sameSite({ document: doc, navigator: { cookieEnabled: true }, location: loc }), true);
  assert.equal(doc.sets.length, 2);
  const m = /^(sumika-hub-probe-[0-9a-z]+)=1; Max-Age=10; Path=\/sumika\/hub\.html; SameSite=Lax; Secure$/.exec(doc.sets[0]);
  assert.ok(m, doc.sets[0]);
  assert.ok(m[1].startsWith(`${PROBE_COOKIE}-`));
  assert.equal(doc.sets[1], `${m[1]}=; Max-Age=0; Path=/sumika/hub.html; SameSite=Lax; Secure`);
  assert.equal(doc.jar.size, 0, 'nothing stays');
  const http = cookieDoc();
  assert.equal(await sameSite({ document: http, navigator: {}, location: new URL('http://localhost:8643/sumika/hub.html') }), true);
  assert.ok(!http.sets[0].includes('Secure'), 'no Secure on http (local tests)');
  // two probes at once (two tabs): each reads its own
  const shared = cookieDoc();
  const [p, q] = await Promise.all([1, 2].map(() => sameSite({ document: shared, navigator: {}, location: loc })));
  assert.deepEqual([p, q], [true, true]);
  assert.notEqual(shared.sets[0].split('=')[0], shared.sets[2].split('=')[0]);
  // refusals
  assert.equal(await sameSite({ document: cookieDoc({ mode: 'cross-site' }), navigator: {}, location: loc }), false);
  assert.equal(await sameSite({ document: cookieDoc({ mode: 'throw' }), navigator: {}, location: loc }), false);
  assert.equal(await sameSite({ document: cookieDoc(), navigator: { cookieEnabled: false }, location: loc }), false);
  assert.equal(await sameSite({ document: cookieDoc({ hasAccess: false }), navigator: {}, location: loc }), false, 'a veto');
  assert.equal(await sameSite({ document: cookieDoc({ hasAccess: true }), navigator: {}, location: loc }), true);
  assert.equal(await sameSite({ document: cookieDoc({ hasAccess: async () => { throw new Error('x'); } }), navigator: {}, location: loc }), true,
    'no answer is no veto');
  assert.equal(await sameSite({ document: cookieDoc({ mode: 'cross-site', hasAccess: true }), navigator: {}, location: loc }), false,
    'true can never make a cross-site frame usable (Chromium answers true while partitioned)');
  const odd = cookieDoc();
  await sameSite({ document: odd, navigator: {}, location: { pathname: '/a;b/hub.html', protocol: 'https:' } });
  assert.match(odd.sets[0], /; Path=\/; /, 'a path that cannot be a cookie Path: /');
  assert.equal(storageWorks(memStorage()), true);
  assert.equal(storageWorks(memStorage({ broken: true })), false);
  assert.equal(storageWorks(null), false);
});

// ---- the store ----

/** An IndexedDB stand-in: values cloned in and out, transactions complete in a later task, `fail` ops fail. */
function fakeIdb({ fail = new Set() } = {}) {
  const dbs = new Map();
  const f = {
    opens: [], commits: 0, created: [], fail, dbs,
    open(name, version) {
      f.opens.push([name, version]);
      const req = {};
      setTimeout(() => {
        if (fail.has('open')) { req.error = new Error('open failed'); if (req.onerror) req.onerror(); return; }
        const fresh = !dbs.has(name);
        const db = {
          onversionchange: null, onclose: null,
          createObjectStore(s) { f.created.push([name, version, s]); dbs.set(name, new Map()); },
          transaction(store, mode) {
            const data = dbs.get(name);
            if (store !== STORE || !data) throw new DOMException('no store', 'NotFoundError');
            const reqs = [];
            const op = fn => { const r = {}; reqs.push([r, fn]); return r; };
            const tx = {
              oncomplete: null, onerror: null, onabort: null, error: null,
              commit() { f.commits++; },
              objectStore: () => ({
                get: k => op(() => structuredClone(data.get(k))),
                put: (v, k) => op(() => { if (fail.has('put')) throw new DOMException('full', 'QuotaExceededError'); data.set(k, structuredClone(v)); }),
                delete: k => op(() => { if (fail.has('delete')) throw new DOMException('no', 'UnknownError'); data.delete(k); }),
                getAllKeys: r => op(() => [...data.keys()].filter(k => typeof k !== 'string' || (k >= r.lower && k <= r.upper)).sort()),
              }),
            };
            setTimeout(() => {
              try {
                if (fail.has(mode)) throw new DOMException('failed', 'UnknownError');
                for (const [r, fn] of reqs) r.result = fn();
                if (tx.oncomplete) tx.oncomplete();
              } catch (e) {
                tx.error = e;
                if (tx.onerror) tx.onerror();
              }
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
  return f;
}

/** A client for one store port: call(op, fields) → the reply. */
function storeClient(port) {
  let rid = 0;
  const waiting = new Map();
  const first = new Promise(r => { waiting.set('first', r); });
  port.onmessage = e => {
    const m = e.data;
    if (m.t === 'store') { waiting.get('first')(m); return; }
    const w = waiting.get(m.rid);
    if (w) { waiting.delete(m.rid); w(m); }
  };
  return {
    first,
    call(op, fields = {}) {
      const id = ++rid;
      return new Promise(r => { waiting.set(id, r); port.postMessage({ rid: id, op, ...fields }); });
    },
  };
}

test('the hub\'s database is core/storage.js\'s: STORE_DB = the runtime\'s namespace, DB_VERSION and STORE read from storage.js\'s source', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'core', 'storage.js'), 'utf8');
  assert.equal(Number(/const DB_VERSION = (\d+);/.exec(src)[1]), DB_VERSION);
  assert.equal(/const STORE = '([^']+)';/.exec(src)[1], STORE);
  const rt = fs.readFileSync(path.join(root, 'src', 'core', 'runtime.js'), 'utf8');
  assert.equal(/export const STORE_NAMESPACE = '([^']+)';/.exec(rt)[1], STORE_DB, 'the namespace pages open Store with');
});

test('store ports over IndexedDB: {t:"store"} first, then Store\'s semantics; writes committed; values cloned (ArrayBuffer maps, Blobs); keys by prefix', async () => {
  const idb = fakeIdb();
  const store = await HubStore.open(idb);
  assert.deepEqual(idb.opens, [[STORE_DB, DB_VERSION]]);
  assert.deepEqual(idb.created, [[STORE_DB, DB_VERSION, STORE]]);
  const { port1, port2 } = new MessageChannel();
  serveStorePort(port1, store);
  const c = storeClient(port2);
  try {
    assert.deepEqual(await c.first, { t: 'store', kind: 'indexeddb' });
    const files = { 'ghost/master/save.txt': new Uint8Array([1, 2, 3]).buffer, 'gone.txt': null };
    assert.deepEqual(await c.call('set', { key: 'ghost:a:files', value: files }), { rid: 1, ok: true, value: true });
    assert.equal(idb.commits, 1, 'commit() on every write');
    const r = await c.call('read', { key: 'ghost:a:files' });
    assert.equal(r.ok, true);
    assert.deepEqual([...new Uint8Array(r.value['ghost/master/save.txt'])], [1, 2, 3]);
    assert.equal(r.value['gone.txt'], null);
    assert.deepEqual(await c.call('read', { key: 'none' }), { rid: 3, ok: true, value: undefined });
    const blob = new Blob(['music'], { type: 'audio/ogg' });
    assert.equal((await c.call('set', { key: 'drop:a.ogg', value: { name: 'a.ogg', blob } })).value, true);
    const got = await c.call('get', { key: 'drop:a.ogg' });
    assert.equal(await got.value.blob.text(), 'music');
    await c.call('set', { key: 'drop:index', value: { v: 1 } });
    assert.deepEqual((await c.call('keys', { prefix: 'drop:' })).value, ['drop:a.ogg', 'drop:index']);
    assert.deepEqual((await c.call('keys', {})).value, ['drop:a.ogg', 'drop:index', 'ghost:a:files']);
    assert.deepEqual(await c.call('delete', { key: 'drop:a.ogg' }), { rid: 9, ok: true, value: true });
    assert.deepEqual((await c.call('keys', { prefix: 'drop:' })).value, ['drop:index']);
    assert.deepEqual(await c.call('drop', { key: 'x' }), { rid: 11, ok: false, error: 'unknown op' });
    assert.deepEqual(await c.call('read', { key: 5 }), { rid: 12, ok: false, error: 'bad key' });
    assert.deepEqual(await c.call('keys', { prefix: 5 }), { rid: 13, ok: false, error: 'bad key' });
    // failures: a read that fails is ok:false (never "nothing stored"); get answers undefined; set and delete false
    idb.fail.add('readonly');
    assert.equal((await c.call('read', { key: 'ghost:a:files' })).ok, false);
    assert.deepEqual(await c.call('get', { key: 'ghost:a:files' }), { rid: 15, ok: true, value: undefined });
    assert.equal((await c.call('keys', { prefix: '' })).ok, false);
    idb.fail.delete('readonly');
    idb.fail.add('put');
    assert.deepEqual(await c.call('set', { key: 'k', value: 1 }), { rid: 17, ok: true, value: false });
    idb.fail.delete('put');
    idb.fail.add('delete');
    assert.equal((await c.call('delete', { key: 'drop:index' })).value, false);
    idb.fail.delete('delete');
    assert.equal(await store.set('f', () => 1), false, 'an uncloneable value is not stored');
    // the database closed by the browser: reads fail from then on
    store.db.onclose();
    assert.equal((await c.call('read', { key: 'drop:index' })).ok, false);
    assert.equal((await c.call('set', { key: 'drop:index', value: 2 })).value, false);
  } finally { port1.close(); port2.close(); }
});

test('the memory store (no IndexedDB, or it fails to open): one Map shared by the ports, set answers false (not stored), nothing transferred', async () => {
  for (const idb of [null, fakeIdb({ fail: new Set(['open']) })]) {
    const store = await HubStore.open(idb);
    assert.equal(store.kind, 'memory');
    const ch1 = new MessageChannel(), ch2 = new MessageChannel();
    serveStorePort(ch1.port1, store);
    serveStorePort(ch2.port1, store);
    const c1 = storeClient(ch1.port2), c2 = storeClient(ch2.port2);
    try {
      assert.deepEqual(await c1.first, { t: 'store', kind: 'memory' });
      await c2.first;
      const buf = new Uint8Array([9]).buffer;
      assert.equal((await c1.call('set', { key: 'ghost:a:files', value: { f: buf } })).value, false);
      const r = await c2.call('read', { key: 'ghost:a:files' });
      assert.deepEqual([...new Uint8Array(r.value.f)], [9], 'the other port reads it');
      const again = await c1.call('read', { key: 'ghost:a:files' });
      assert.equal(again.value.f.byteLength, 1, 'the kept copy was not transferred away');
      assert.deepEqual((await c2.call('keys', { prefix: 'ghost:' })).value, ['ghost:a:files']);
      assert.equal((await c2.call('delete', { key: 'ghost:a:files' })).value, true);
    } finally { ch1.port1.close(); ch1.port2.close(); ch2.port1.close(); ch2.port2.close(); }
  }
});

test('buffersOf: what a read transfers (a buffer, a view\'s buffer, a save map\'s buffers), never twice', () => {
  const a = new ArrayBuffer(4), b = new ArrayBuffer(2);
  assert.deepEqual(buffersOf(a), [a]);
  assert.deepEqual(buffersOf(new Uint8Array(b)), [b]);
  assert.deepEqual(buffersOf({ x: a, y: null, z: new Uint8Array(a), w: b, s: 'text' }), [a, b]);
  assert.deepEqual(buffersOf(new ArrayBuffer(0)), [], 'nothing to gain');
  assert.deepEqual(buffersOf(null), []);
  assert.deepEqual(buffersOf({ nested: { a } }), [], 'only a map\'s own values');
  assert.deepEqual(buffersOf([a]), []);
});

test('the store host: a dedicated worker of the hub script when one can be made, else the frame; a worker that fails to start falls back', async () => {
  // no Worker: the frame serves
  let h = storeHost({ scriptUrl: 'https://s/sumika/engines/hub.x.js', Worker: null, idb: fakeIdb() });
  assert.equal(h.inWorker, false);
  assert.equal(await h.open(), 'indexeddb');
  let ch = new MessageChannel();
  h.attach(ch.port1);
  assert.deepEqual(await storeClient(ch.port2).first, { t: 'store', kind: 'indexeddb' });
  ch.port1.close(); ch.port2.close();

  // a worker: the hub script again, told to open, then handed the ports; storeWorker on the other side
  const made = [];
  class FakeWorker {
    constructor(url, opts) {
      made.push([url, opts]);
      this.onmessage = null; this.onerror = null;
      const scope = { indexedDB: fakeIdb(), postMessage: m => queueMicrotask(() => this.onmessage && this.onmessage({ data: m })), onmessage: null };
      storeWorker(scope);
      this.scope = scope;
    }
    postMessage(m, transfer) { queueMicrotask(() => this.scope.onmessage({ data: m, ports: transfer || [] })); }
  }
  h = storeHost({ scriptUrl: 'https://s/sumika/engines/hub.x.js', Worker: FakeWorker, idb: null });
  assert.equal(h.inWorker, true);
  assert.deepEqual(made, [['https://s/sumika/engines/hub.x.js', { name: 'sumika-hub-store' }]]);
  assert.equal(await h.open(), 'indexeddb', 'the worker\'s IndexedDB');
  assert.equal(h.open(), h.open(), 'opened once');
  ch = new MessageChannel();
  h.attach(ch.port1);
  const c = storeClient(ch.port2);
  assert.deepEqual(await c.first, { t: 'store', kind: 'indexeddb' });
  assert.equal((await c.call('set', { key: 'k', value: 1 })).value, true);
  ch.port1.close(); ch.port2.close();

  // a worker that fails to start (a worker-src policy, a network error): the frame serves
  class BadWorker {
    constructor() { this.onerror = null; }
    postMessage() { setTimeout(() => this.onerror && this.onerror({ preventDefault() {} })); }
  }
  h = storeHost({ scriptUrl: 'x.js', Worker: BadWorker, idb: null });
  assert.equal(await h.open(), 'memory');
  assert.equal(h.inWorker, false);
  ch = new MessageChannel();
  h.attach(ch.port1);
  assert.deepEqual(await storeClient(ch.port2).first, { t: 'store', kind: 'memory' });
  ch.port1.close(); ch.port2.close();
  // a constructor that throws
  h = storeHost({ scriptUrl: 'x.js', Worker: class { constructor() { throw new Error('blocked'); } }, idb: null });
  assert.equal(h.inWorker, false);
  assert.equal(await h.open(), 'memory');
});

test('retired store ports (marked `retire` by the page: an engine start\'s): after storeHost.retire() (the hub\'s pagehide into the back/forward cache) their set and delete are answered `retired` and store nothing, their reads still answered; unmarked ports and ports attached after it as before; in the frame and in the store worker', async () => {
  for (const inWorker of [false, true]) {
    const idb = fakeIdb();
    class FakeWorker {
      constructor() {
        this.onmessage = null; this.onerror = null;
        const scope = { postMessage: m => queueMicrotask(() => this.onmessage && this.onmessage({ data: m })), onmessage: null };
        storeWorker(scope, idb);
        this.scope = scope;
      }
      postMessage(m, transfer) { queueMicrotask(() => this.scope.onmessage({ data: m, ports: transfer || [] })); }
    }
    const h = storeHost({ scriptUrl: 'https://s/sumika/engines/hub.x.js', Worker: inWorker ? FakeWorker : null, idb: inWorker ? null : idb });
    assert.equal(h.inWorker, inWorker);
    assert.equal(await h.open(), 'indexeddb');
    const chans = [];
    const attach = o => { const ch = new MessageChannel(); chans.push(ch); h.attach(ch.port1, o); return storeClient(ch.port2); };
    const what = inWorker ? 'the store worker' : 'the frame';
    try {
      const engine = attach({ retire: true });
      const drops = attach();
      await engine.first;
      await drops.first;
      assert.equal((await engine.call('set', { key: 'ghost:g:files', value: 1 })).value, true, `${what}: before, as before`);
      h.retire();
      const late = attach({ retire: true });           // a new engine start's, after the restore
      await late.first;
      assert.deepEqual(await engine.call('set', { key: 'ghost:g:files', value: 2 }), { rid: 2, ok: false, error: 'retired' }, what);
      assert.deepEqual(await engine.call('delete', { key: 'ghost:g:files' }), { rid: 3, ok: false, error: 'retired' }, what);
      assert.equal((await engine.call('read', { key: 'ghost:g:files' })).value, 1, `${what}: reads answered, nothing written`);
      assert.equal((await drops.call('set', { key: 'drop:a', value: 1 })).value, true, `${what}: an unmarked port (the dropped files')`);
      assert.equal((await late.call('set', { key: 'ghost:g:files', value: 3 })).value, true, `${what}: a port attached after`);
      assert.equal((await late.call('read', { key: 'ghost:g:files' })).value, 3);
    } finally {
      for (const ch of chans) { ch.port1.close(); ch.port2.close(); }
    }
  }
});

test('the hub\'s pagehide into the back/forward cache retires the store ports the page marked; one not persisted retires nothing (its ports go with it); the store op hands the page\'s mark to the store host', async () => {
  const base = fakeStore();
  const store = { ...base, marks: [], retires: 0, attach(p, o) { this.attached.push(p); this.marks.push(o); }, retire() { this.retires++; } };
  const r = await live({ store });
  const c1 = new MessageChannel(), c2 = new MessageChannel();
  try {
    r.port.post({ op: 'store', pid: 1, port: c1.port2, retire: true }, [c1.port2]);
    r.port.post({ op: 'store', pid: 2, port: c2.port2 }, [c2.port2]);
    await settle(r.port);
    assert.deepEqual(store.marks, [{ retire: true }, { retire: false }]);
    r.hub.pageHide(true);
    assert.equal(store.retires, 1);
    assert.deepEqual(await r.port.next(m => m.t === 'gone'), { t: 'gone', persisted: true });
    r.hub.pageShow();
    r.hub.pageHide(false);
    assert.equal(store.retires, 1, 'not persisted: nothing retired');
    // a store host without retire (an older one in a test): the pagehide goes on
    const r2 = await live();
    r2.hub.pageHide(true);
    assert.deepEqual(await r2.port.next(m => m.t === 'gone'), { t: 'gone', persisted: true });
    r2.port.close();
  } finally { r.port.close(); c1.port1.close(); c2.port1.close(); }
});

// ---- the frame ----

/** A hub frame's window: listeners per type, `fire`. */
function fakeWindow({ top = false, fetchBody = JSON.stringify({ format: 1, origins: [A] }) } = {}) {
  const l = new Map();
  const parent = {};
  const win = {
    console: { warn() {}, info() {}, debug() {} },
    document: { ...cookieDoc(), currentScript: { src: 'https://sumika.example.com/sumika/engines/hub.0123456789.js' } },
    location: new URL(HUB),
    localStorage: memStorage(),
    sessionStorage: memStorage(),
    navigator: { locks: globalThis.navigator.locks, cookieEnabled: true },
    fetch: async () => ({ ok: true, text: async () => fetchBody }),
    BroadcastChannel: bus(),
    addEventListener(t, f) { if (!l.has(t)) l.set(t, []); l.get(t).push(f); },
    fire(t, ev) { for (const f of l.get(t) || []) f(ev); },
    count: t => (l.get(t) || []).length,
  };
  // the cookie accessors must stay accessors on the document
  const jar = cookieDoc();
  Object.defineProperty(win.document, 'cookie', { get: () => jar.cookie, set: v => { jar.cookie = v; } });
  win.parent = top ? win : parent;
  win.window = win;
  return win;
}

test('hubMain: nothing when opened top-level; framed, only a hello from the parent with the mark and a port is taken', async () => {
  const topWin = fakeWindow({ top: true });
  assert.equal(hubMain(topWin), null);
  assert.equal(topWin.count('message'), 0);
  const win = fakeWindow();
  const hub = hubMain(win);
  assert.ok(hub);
  assert.deepEqual(['message', 'storage', 'pagehide', 'pageshow'].map(t => win.count(t)), [1, 1, 1, 1]);
  const ports = [];
  const send = (source, data, withPort = true) => {
    const p = pagePort();
    ports.push(p);
    win.fire('message', { source, origin: A, data, ports: withPort ? [p.hub] : [] });
    return p;
  };
  try {
    const stranger = send({}, { [HELLO]: 1, v: 1 });         // another window (a popup's opener posting into the frame)
    const unmarked = send(win.parent, { v: 1 });
    const portless = send(win.parent, { [HELLO]: 1, v: 1 }, false);
    const string = send(win.parent, 'sumikaHubHello');
    const ok = send(win.parent, { [HELLO]: 1, v: 1 });
    assert.equal((await ok.next()).t, 'ack');
    assert.equal((await ok.next()).t, 'welcome');
    for (const p of [stranger, unmarked, portless, string]) assert.deepEqual(p.msgs, []);
    // storage events of the hub's localStorage only; pagehide / pageshow
    win.localStorage.setItem('sumika:x', '1');
    win.fire('storage', { key: 'sumika:x', storageArea: win.sessionStorage });
    win.fire('storage', { key: 'sumika:x', storageArea: win.localStorage });
    assert.deepEqual((await ok.next(m => m.t === 'storage')).snap, { 'sumika:x': '1' });
    win.fire('pagehide', { persisted: true });
    assert.equal(hub.hidden, true);
    assert.deepEqual(await ok.next(m => m.t === 'gone'), { t: 'gone', persisted: true });
    win.fire('pageshow', { persisted: true });
    assert.equal(hub.hidden, false);
  } finally { for (const p of ports) p.close(); }
});

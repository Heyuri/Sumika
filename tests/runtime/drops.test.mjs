// src/core/drops.js: pseudo-paths of dropped files (TS §3.4), name sanitizing, and the store: this page at once,
// IndexedDB later (an injected backend here: Node has no IndexedDB), per-file cap, LRU beyond the total, quota errors,
// index integrity (entry first, evictions after, reconcile, Web Locks), playable audio only, clear().
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DropStore, dropPath, dropLower, dropLabel, isDropPath, playable, sanitizeFileName, mimeOf, hash8, DROP_INDEX_KEY,
  DROP_KEY_PREFIX, DROP_LOCK,
} from '../../src/core/drops.js';
import { Store } from '../../src/core/storage.js';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('silent');

const file = (name, size = 4, o = {}) => new File([new Uint8Array(size)], name, { type: o.type ?? '', lastModified: o.lastModified ?? 1700000000000 });
const keyOf = e => DROP_KEY_PREFIX + e.path.toLowerCase();

/** Map-backed stand-in for core/storage.js Store (set -> true when stored, delete -> false when refused). */
class MemBackend {
  constructor({ refuse = () => false, refuseDelete = () => false } = {}) {
    this.m = new Map(); this.refuse = refuse; this.refuseDelete = refuseDelete; this.writes = 0;
  }
  async get(k) { return this.m.get(k); }
  async set(k, v) { this.writes++; if (this.refuse(k, v)) return false; this.m.set(k, v); return true; }
  async delete(k) { if (this.refuseDelete(k)) return false; this.m.delete(k); return true; }
  keys(prefix = '') { return [...this.m.keys()].filter(k => k.startsWith(prefix)).sort(); }
}

const fakeUrl = () => {
  const u = { made: [], revoked: [], createObjectURL(b) { const s = `blob:test/${u.made.length}`; u.made.push([s, b]); return s; }, revokeObjectURL(s) { u.revoked.push(s); } };
  return u;
};

test('file names: Windows-illegal and control characters (\\x01 separates paths) go, the extension stays', () => {
  assert.equal(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j.mp3'), 'abcdefghij.mp3');
  assert.equal(sanitizeFileName('x\x01y\x02z\tw\x7f.ogg'), 'xyzw.ogg');
  assert.equal(sanitizeFileName('  name. . '), 'name');
  assert.equal(sanitizeFileName('Song A (live).MP3'), 'Song A (live).MP3');
  assert.equal(sanitizeFileName('con.mp3'), '_con.mp3');
  assert.equal(sanitizeFileName('LPT1'), '_LPT1');
  assert.equal(sanitizeFileName(''), 'file');
  assert.equal(sanitizeFileName('???'), 'file');
  assert.equal(sanitizeFileName('ﾃｽﾄ曲.wav'), 'ﾃｽﾄ曲.wav');
  assert.equal(sanitizeFileName('ka\u3099.mp3'), 'ka\u3099.mp3'.normalize('NFC'));
  const long = sanitizeFileName('x'.repeat(300) + '.flac');
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.flac'));
});

test('pseudo-paths: C:\\sumika\\drop\\<8 hex>\\<name>, stable per name+size+date, lookups ignore case and /', () => {
  const p = dropPath(file('Song A.MP3', 10));
  assert.match(p, /^C:\\sumika\\drop\\[0-9a-f]{8}\\Song A\.MP3$/);
  assert.equal(dropPath(file('Song A.MP3', 10)), p, 'the same file gets the same path');
  assert.notEqual(dropPath(file('Song A.MP3', 11)), p);
  assert.notEqual(dropPath(file('Song A.MP3', 10, { lastModified: 1 })), p);
  assert.notEqual(dropPath(file('song a.mp3', 10)), p);
  assert.equal(p.split('\\').pop().split('.').pop(), 'MP3', 'her extension test reads the tail of R0');
  assert.ok(!p.includes('\x01'));
  assert.equal(hash8(''), '811c9dc5');
  assert.equal(dropLower(`"${p.replace(/\\/g, '/').toUpperCase()}"`), p.toLowerCase());
  assert.equal(isDropPath(p), true);
  assert.equal(isDropPath('C:\\sumika\\drop\\'), false);
  assert.equal(isDropPath('C:\\Users\\me\\Music\\a.mp3'), false);
  assert.equal(isDropPath('music\\a.mp3'), false);
  assert.equal(isDropPath(null), false);
});

test('MIME types (R2): the browser type, else by extension, else empty', () => {
  assert.equal(mimeOf(file('a.bin', 1, { type: 'audio/x-custom' })), 'audio/x-custom');
  assert.equal(mimeOf(file('a.MP3')), 'audio/mpeg');
  assert.equal(mimeOf(file('a.mid')), 'audio/midi');
  assert.equal(mimeOf(file('a.jpeg')), 'image/jpeg');
  assert.equal(mimeOf(file('a.xyz')), '');
  assert.equal(mimeOf(file('noext')), '');
});

test('store: usable at once on this page, stored for later visits, object URLs released', async () => {
  const be = new MemBackend();
  const URL = fakeUrl();
  const a = new DropStore({ backend: be, URL, now: () => 1000 });
  const f = file('Song A.mp3', 8, { type: 'audio/mpeg' });
  const [e, ...rest] = a.add([f, { name: 'not a file' }, null]);
  assert.equal(rest.length, 0, 'only Files');
  assert.deepEqual({ ...e, path: undefined }, { path: undefined, type: 'audio/mpeg', name: 'Song A.mp3', size: 8 });
  assert.equal(a.has(e.path), true);
  assert.equal(await a.blob(e.path.toLowerCase()), f, 'this page: the File itself, before any storage');
  await a.whenIdle();
  const key = DROP_KEY_PREFIX + e.path.toLowerCase();
  assert.deepEqual(be.keys(), [key, DROP_INDEX_KEY].sort());
  const rec = be.m.get(key);
  assert.equal(rec.blob, f);
  assert.deepEqual({ ...rec, blob: null }, { blob: null, path: e.path, name: 'Song A.mp3', type: 'audio/mpeg', size: 8, lastModified: 1700000000000 });
  assert.deepEqual(be.m.get(DROP_INDEX_KEY), { v: 1, files: { [e.path.toLowerCase()]: { size: 8, usedAt: 1000 } } });

  // a later visit: a new page, the same browser storage
  const b = new DropStore({ backend: async () => be, URL, now: () => 5000 });
  assert.equal(b.has(e.path), false);
  const h = await b.open(e.path.replace(/\\/g, '/'));
  assert.equal(h.url, 'blob:test/0');
  assert.equal(URL.made[0][1], f);
  assert.equal(h.blob, f, 'the file itself too (the MIDI player reads it without a fetch)');
  h.release();
  h.release();
  assert.deepEqual(URL.revoked, ['blob:test/0'], 'revoked once');
  await b.whenIdle();
  assert.equal(be.m.get(DROP_INDEX_KEY).files[e.path.toLowerCase()].usedAt, 5000, 'opening counts as a use (LRU)');
  assert.equal(await b.open('C:\\sumika\\drop\\00000000\\gone.mp3'), null, 'storage cleared: nothing');
  assert.equal(await b.open('music\\a.mp3'), null, 'not a dropped file');
});

test('store caps: big files stay on this page only; least recently used files go beyond the total', async () => {
  const be = new MemBackend();
  let t = 0;
  const s = new DropStore({ backend: be, URL: fakeUrl(), maxFileBytes: 10, maxTotalBytes: 12, now: () => ++t });
  const [big] = s.add([file('big.wav', 11)]);
  await s.whenIdle();
  assert.equal(be.m.has(DROP_KEY_PREFIX + big.path.toLowerCase()), false, 'over the per-file cap: not stored');
  assert.ok(await s.blob(big.path), 'but it plays on this page');

  const [a] = s.add([file('a.mp3', 4)]);
  const [b] = s.add([file('b.mp3', 4)]);
  await s.whenIdle();
  await s.blob(a.path);                       // a used after b
  await s.whenIdle();
  const [c] = s.add([file('c.mp3', 6)]);      // 4 + 4 + 6 > 12: b (least recently used) goes
  await s.whenIdle();
  const idx = be.m.get(DROP_INDEX_KEY).files;
  assert.deepEqual(Object.keys(idx).sort(), [a.path, c.path].map(p => p.toLowerCase()).sort());
  assert.equal(be.m.has(DROP_KEY_PREFIX + b.path.toLowerCase()), false);
  assert.ok(await s.blob(b.path), 'evicted from storage, still here for this page');
  assert.equal(await new DropStore({ backend: be }).blob(b.path), null, 'gone on a later visit');

  // the same file dropped again: no second copy, no eviction
  const before = be.writes;
  s.add([file('c.mp3', 6)]);
  await s.whenIdle();
  assert.equal(be.writes, before + 1, 'only the index is written');
});

test('store failures never reach the drop: quota refusals, throwing backends, no IndexedDB', async () => {
  const quota = new MemBackend({ refuse: k => k !== DROP_INDEX_KEY });
  const q = new DropStore({ backend: quota, URL: fakeUrl() });
  const [e] = q.add([file('a.mp3', 4)]);
  await q.whenIdle();
  assert.deepEqual(quota.m.get(DROP_INDEX_KEY).files, {}, 'not counted when the browser refused it');
  assert.ok(await q.blob(e.path));

  const broken = { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('quota'); }, delete: async () => {} };
  const b = new DropStore({ backend: broken, URL: fakeUrl() });
  const [f] = b.add([file('b.mp3', 4)]);
  await b.whenIdle();
  assert.ok(await b.blob(f.path));

  const failing = new DropStore({ backend: () => Promise.reject(new Error('blocked')), URL: fakeUrl() });
  const [g] = failing.add([file('c.mp3', 4)]);
  await failing.whenIdle();
  assert.ok(await failing.blob(g.path));

  const mem = new DropStore({ backend: null, URL: fakeUrl() });
  const [m] = mem.add([file('d.mp3', 4)]);
  assert.ok((await mem.open(m.path)).url.startsWith('blob:test/'));
  assert.equal(await new DropStore({ backend: null }).blob(m.path), null, 'memory only: this page');
});

test('logs name a dropped file by id and extension only', () => {
  assert.equal(dropLabel('C:\\sumika\\drop\\219fbf87\\Private voice memo.MID'), 'dropped file 219fbf87 (.mid)');
  assert.equal(dropLabel('C:/sumika/drop/0000abcd/noext'), 'dropped file 0000abcd');
  assert.equal(dropLabel('music\\a.mp3'), null);
});

/** Run fn with the globals a page has where the MIDI player runs (core/midi.js midiSupported), then put them back. */
async function withMidi(fn) {
  const keys = ['isSecureContext', 'AudioContext', 'AudioWorkletNode', 'Worker'];
  const saved = keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const F = function () {};
  for (const k of keys) Object.defineProperty(globalThis, k, { value: k === 'isSecureContext' ? true : F, configurable: true, writable: true });
  try { return await fn(); } finally {
    for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
}

test('only playable audio is kept for later visits; images and documents stay on this page only; MIDI by its name where the MIDI player runs', async () => {
  assert.equal(playable('audio/mpeg'), true);
  assert.equal(playable('image/png'), false);
  assert.equal(playable(''), false);
  const had = 'Audio' in globalThis, saved = globalThis.Audio;
  globalThis.Audio = class { canPlayType(t) { return /midi|wma/.test(t) ? '' : 'maybe'; } };
  try {
    assert.equal(playable('audio/midi'), false, 'the browser cannot play it: nothing would use the copy');
    assert.equal(playable('audio/x-ms-wma'), false);
    assert.equal(playable('audio/ogg'), true);
    assert.equal(playable('audio/midi', 'song.mid'), false, 'no MIDI player here (Node: no AudioWorklet)');
    await withMidi(() => {
      for (const [type, name] of [['', 'Song.MID'], ['audio/mid', 'x.smf'], ['audio/midi', 'a.midi'], ['', 'b.rmi']]) {
        assert.equal(playable(type, name), true, `${name}: by its name, whatever the browser calls it`);
      }
      assert.equal(playable('audio/midi'), false, 'no name: by its type');
      assert.equal(playable('audio/ogg', 'x.mid.ogg'), true);
      assert.equal(playable('', 'x.mid.txt'), false);
    });
  } finally {
    if (had) globalThis.Audio = saved; else delete globalThis.Audio;
  }
  // MIDI files are kept for later visits only where the MIDI player runs
  await withMidi(async () => {
    const mb = new MemBackend();
    const ms = new DropStore({ backend: mb, URL: fakeUrl(), locks: null });
    const [m1, m2] = ms.add([file('song.mid', 3), file('tune.smf', 3, { type: 'audio/mid' })]);
    await ms.whenIdle();
    assert.deepEqual(mb.keys(), [DROP_INDEX_KEY, keyOf(m1), keyOf(m2)].sort());
  });
  const nb = new MemBackend();
  const ns = new DropStore({ backend: nb, URL: fakeUrl(), locks: null });
  const [n1] = ns.add([file('song.mid', 3)]);
  await ns.whenIdle();
  assert.deepEqual(nb.keys(), [], 'no MIDI player: this page only');
  assert.ok(await ns.blob(n1.path));
  const be = new MemBackend();
  const s = new DropStore({ backend: be, URL: fakeUrl(), locks: null });
  const [pic, pdf, song] = s.add([file('photo.jpg', 3), file('notes.pdf', 3, { type: 'application/pdf' }), file('song.ogg', 3)]);
  await s.whenIdle();
  assert.deepEqual(be.keys(), [DROP_INDEX_KEY, keyOf(song)].sort());
  assert.ok(await s.blob(pic.path) && await s.blob(pdf.path), 'still there for this page');
  const custom = new DropStore({ backend: new MemBackend(), URL: fakeUrl(), locks: null, storable: t => t.startsWith('image/') });
  custom.add([file('wall.png', 3)]);
  await custom.whenIdle();
  assert.equal((await custom._backend()).keys(DROP_KEY_PREFIX).length, 2, 'a host may widen it (wallpaper)');
});

test('index integrity: the entry before the file, evictions after it; refused writes and deletes leave nothing uncounted', async () => {
  let refuseFile = false, refuseDelete = false;
  const be = new MemBackend({ refuse: k => refuseFile && k !== DROP_INDEX_KEY, refuseDelete: () => refuseDelete });
  let t = 0;
  const s = new DropStore({ backend: be, URL: fakeUrl(), maxTotalBytes: 10, now: () => ++t, locks: null });
  const [a] = s.add([file('a.mp3', 6)]);
  await s.whenIdle();
  refuseFile = true;
  s.add([file('b.mp3', 6)]);                 // 6 + 6 > 10, but b is refused: a must not have been evicted for it
  await s.whenIdle();
  assert.deepEqual(be.keys(DROP_KEY_PREFIX), [DROP_INDEX_KEY, keyOf(a)].sort());
  assert.deepEqual(Object.keys(be.m.get(DROP_INDEX_KEY).files), [a.path.toLowerCase()]);

  // a delete the browser refuses: the file is still stored, so it stays counted (over the cap until it can go)
  refuseFile = false;
  refuseDelete = true;
  const [c] = s.add([file('c.mp3', 6)]);
  await s.whenIdle();
  assert.deepEqual(Object.keys(be.m.get(DROP_INDEX_KEY).files).sort(), [a, c].map(e => e.path.toLowerCase()).sort());
  refuseDelete = false;
  const [d] = s.add([file('d.mp3', 2)]);     // 6 + 6 + 2 > 10: a (least recently used) goes now
  await s.whenIdle();
  assert.deepEqual(be.keys(DROP_KEY_PREFIX), [DROP_INDEX_KEY, keyOf(c), keyOf(d)].sort());
  assert.deepEqual(Object.keys(be.m.get(DROP_INDEX_KEY).files).sort(), [c, d].map(e => e.path.toLowerCase()).sort());

  // the index cannot be written: the file is not written either (it would escape the caps)
  const be2 = new MemBackend({ refuse: k => k === DROP_INDEX_KEY });
  const s2 = new DropStore({ backend: be2, URL: fakeUrl(), locks: null });
  const [e] = s2.add([file('e.mp3', 4)]);
  await s2.whenIdle();
  assert.deepEqual(be2.keys(), []);
  assert.ok(await s2.blob(e.path), 'it plays on this page');
});

test('the first update of a page reconciles the index with the stored files (interrupted writes, other tabs)', async () => {
  const be = new MemBackend();
  const orphan = file('orphan.mp3', 5);
  const op = dropPath(orphan);
  be.m.set(DROP_KEY_PREFIX + op.toLowerCase(), { blob: orphan, path: op, name: 'orphan.mp3', type: 'audio/mpeg', size: 5, lastModified: 1 });
  be.m.set(`${DROP_KEY_PREFIX}c:\\sumika\\drop\\00000000\\junk.mp3`, { not: 'a dropped file' });
  be.m.set(DROP_INDEX_KEY, { v: 1, files: { 'c:\\sumika\\drop\\11111111\\gone.mp3': { size: 7, usedAt: 50 } } });
  let t = 100;
  const s = new DropStore({ backend: be, URL: fakeUrl(), maxTotalBytes: 8, now: () => ++t, locks: null });
  const [n] = s.add([file('new.mp3', 4)]);   // the orphan is counted again (oldest): 5 + 4 > 8, so it goes first
  await s.whenIdle();
  assert.deepEqual(be.keys(), [DROP_INDEX_KEY, keyOf(n)].sort());
  assert.deepEqual(be.m.get(DROP_INDEX_KEY).files, { [n.path.toLowerCase()]: { size: 4, usedAt: 101 } });
});

test('one tab at a time: every index update runs under the drop lock (Web Locks)', async () => {
  const names = [];
  const locks = { request: (name, fn) => { names.push(name); return Promise.resolve().then(fn); } };
  const s = new DropStore({ backend: new MemBackend(), URL: fakeUrl(), locks });
  const [a] = s.add([file('a.mp3')]);
  await s.blob(a.path);                      // a use (LRU) updates the index too
  await s.whenIdle();
  assert.deepEqual(names, [DROP_LOCK, DROP_LOCK]);
  assert.ok(!/^sumika:/.test(DROP_LOCK), 'not a ghost lock name');
});

test('the save data keeps room: no file is stored when the origin quota would get tight', async () => {
  const MB = 1024 * 1024;
  const tight = new MemBackend();
  const a = new DropStore({ backend: tight, URL: fakeUrl(), locks: null, estimate: async () => ({ usage: 60 * MB, quota: 100 * MB }) });
  const [e] = a.add([file('a.mp3', 10 * MB)]);   // 60 + 10 + max(32, 10) > 100
  await a.whenIdle();
  assert.deepEqual(tight.keys(), []);
  assert.ok(await a.blob(e.path), 'it plays on this page');
  const roomy = new MemBackend();
  const b = new DropStore({ backend: roomy, URL: fakeUrl(), locks: null, estimate: async () => ({ usage: 60 * MB, quota: 1000 * MB }) });
  b.add([file('a.mp3', 10 * MB)]);
  await b.whenIdle();
  assert.equal(roomy.keys(DROP_KEY_PREFIX).length, 2);
  const unknown = new MemBackend();
  const c = new DropStore({ backend: unknown, URL: fakeUrl(), locks: null, estimate: async () => { throw new Error('no'); } });
  c.add([file('a.mp3', 4)]);
  await c.whenIdle();
  assert.equal(unknown.keys(DROP_KEY_PREFIX).length, 2, 'no estimate: the caps alone decide');
});

test('clear() forgets every dropped file, stored or not; other keys stay', async () => {
  const be = new MemBackend();
  be.m.set('ghost:tsubasa:files', { 'satori_savedata.txt': 1 });
  const s = new DropStore({ backend: be, URL: fakeUrl(), locks: null });
  const [a] = s.add([file('a.mp3'), file('b.wav')]);
  await s.whenIdle();
  be.m.set(`${DROP_KEY_PREFIX}c:\\sumika\\drop\\00000000\\orphan.mp3`, { blob: file('orphan.mp3') });
  assert.equal(await s.clear(), true);
  assert.deepEqual(be.keys(), ['ghost:tsubasa:files']);
  assert.equal(s.has(a.path), false);
  assert.equal(await s.blob(a.path), null);

  // a backend that cannot list keys: the index says what to delete
  const plain = { m: new Map(), async get(k) { return this.m.get(k); }, async set(k, v) { this.m.set(k, v); return true; }, async delete(k) { this.m.delete(k); return true; } };
  const p = new DropStore({ backend: plain, URL: fakeUrl(), locks: null });
  p.add([file('a.mp3')]);
  await p.whenIdle();
  assert.equal(plain.m.size, 2);
  await p.clear();
  assert.equal(plain.m.size, 0);
});

test('Store (core/storage.js): keys(prefix) and delete() report what the storage did; memory here (no IndexedDB in Node)', async () => {
  const st = await Store.open('drops-test');
  assert.equal(st.kind, 'memory');
  await st.set('drop:a', 1);
  await st.set('drop:b', 2);
  await st.set('ghost:x:files', 3);
  assert.deepEqual((await st.keys('drop:')).sort(), ['drop:a', 'drop:b']);
  assert.equal(await st.delete('drop:a'), true);
  assert.deepEqual(await st.keys('drop:'), ['drop:b']);
});

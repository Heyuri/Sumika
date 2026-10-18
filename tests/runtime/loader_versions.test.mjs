// src/core/loader.js under safe updates, on a fake fetch that
// records each URL and init: ghosts.json 'no-cache' with the browser's copy when the network fails, index formats,
// hashed manifests and packs from any stored copy with one 'reload' when the copy is not what the name promises (an
// HTML fallback page too), a manifest gone under a long-open tab (ghosts.json read again once), packs a host already
// decoded, fetchVersioned and the fetch() paths that use it (GhostFiles.bytes, shell/images.js, ui/thumbnail.js), the
// versioned URLs for fetch() and the plain ones for elements, siteUrls with the index's versions.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { SiteIndex, GhostFiles, INDEX_FORMAT, REWRITES_KEY, fetchVersioned, siteUrls } from '../../src/core/loader.js';
import { ImageCache } from '../../src/shell/images.js';
import { loadThumbnail, bannerUrls } from '../../src/ui/thumbnail.js';
import { Menu } from '../../src/ui/menu.js';
import { PageSaori } from '../../src/core/page-saori.js';

const BASE = 'http://s/';
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const html = (status = 200) => new Response('<!doctype html><title>Not found</title>', { status, headers: { 'content-type': 'text/html' } });
const bytes = (n, type = 'application/octet-stream') => new Response(new Uint8Array(n).fill(7), { headers: { 'content-type': type } });

/**
 * globalThis.fetch as a table of routes: url -> a Response, an Error to reject with, or a list of those (one per call,
 * the last one repeated). calls: every {url, init, args} in order. Restored by the returned function.
 */
function fakeFetch(routes) {
  const calls = [];
  const seen = new Map();
  const real = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const url = String(args[0]);
    calls.push({ url, init: args[1], args });
    const r = routes[url];
    if (r === undefined) return new Response('', { status: 404 });
    const n = seen.get(url) || 0;
    seen.set(url, n + 1);
    const one = Array.isArray(r) ? r[Math.min(n, r.length - 1)] : r;
    const v = typeof one === 'function' ? one() : one;
    if (v instanceof Error) throw v;
    return v.clone();           // the route's own copy stays unread: every call gets the same body
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const cacheOf = calls => calls.map(c => (c.init && c.init.cache) || 'default');
const INDEX = 'http://s/sumika/index/ghosts.json';
const MAN_A = 'sumika/index/ghost.a.0123456789.json';
const PACK_A = 'sumika/index/ghost.a.abcdef0123.pack.gz';
const index2 = (o = {}) => ({
  format: 2, ghosts: [{ id: 'a', name: 'A' }], balloons: [{ id: 'b', name: 'B' }], defaultBalloon: 'b',
  manifests: { ghost: { a: MAN_A }, balloon: { b: 'sumika/index/balloon.b.9999999999.json' } },
  versions: { 'ghost/a/thumbnail.png': '0badf00d' }, ...o,
});

/** A pack (index_site.py write_pack): "SMKP" | uint32 LE header length | header JSON | file bytes. */
function pack(files) {
  const entries = [];
  const blobs = [];
  let off = 0;
  for (const [p, text] of Object.entries(files)) {
    const b = Buffer.from(text, 'utf8');
    entries.push([p, off, b.length]);
    blobs.push(b);
    off += b.length;
  }
  const header = Buffer.from(JSON.stringify({ files: entries }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  return Buffer.concat([Buffer.from('SMKP'), len, header, ...blobs]);
}
const manifestA = (o = {}) => ({
  format: 2, id: 'a', root: 'ghost/a/', pack: PACK_A,
  files: [['ghost/master/descript.txt', 9], ['shell/master/surface0.png', 3, 1, 1], ['thumbnail.png', 2, 1, 1]],
  versions: ['11111111', '22222222', '0badf00d'], ...o,
});

test('INDEX_FORMAT is 2', () => {
  assert.equal(INDEX_FORMAT, 2);
});

test('SiteIndex.load: ghosts.json with no-cache; a network failure (TypeError) once more from the browser\'s copy; an HTTP error is not retried', async () => {
  let f = fakeFetch({ [INDEX]: json(index2()) });
  try {
    const idx = await SiteIndex.load(BASE);
    assert.deepEqual(f.calls.map(c => [c.url, c.init]), [[INDEX, { cache: 'no-cache' }]]);
    assert.equal(idx.format, 2);
    assert.deepEqual(idx.ghosts, [{ id: 'a', name: 'A' }]);
    assert.equal(idx.defaultBalloon, 'b');
    assert.deepEqual(idx.versions, { 'ghost/a/thumbnail.png': '0badf00d' });
    assert.equal(idx.manifests.ghost.a, MAN_A);
  } finally { f.restore(); }

  f = fakeFetch({ [INDEX]: [new TypeError('Failed to fetch'), json(index2())] });
  try {
    const idx = await SiteIndex.load(BASE);
    assert.deepEqual(cacheOf(f.calls), ['no-cache', 'force-cache'], 'offline: the stored copy');
    assert.equal(idx.ghosts.length, 1);
  } finally { f.restore(); }

  f = fakeFetch({ [INDEX]: [json({}, 500), json(index2())] });
  try {
    await assert.rejects(SiteIndex.load(BASE), /500/);
    assert.equal(f.calls.length, 1, 'the network answered: no retry');
  } finally { f.restore(); }
});

test('SiteIndex.load: format 1 and 2 load (no format = 1); a newer format rejects with code index-newer', async () => {
  for (const [data, format] of [[{ format: 1, ghosts: [], balloons: [] }, 1], [index2(), 2], [{ ghosts: [] }, 1]]) {
    const f = fakeFetch({ [INDEX]: json(data) });
    try {
      assert.equal((await SiteIndex.load(BASE)).format, format);
    } finally { f.restore(); }
  }
  const f = fakeFetch({ [INDEX]: json({ ...index2(), format: 3 }) });
  try {
    await assert.rejects(SiteIndex.load(BASE), e => e.code === 'index-newer' && /format 3/.test(e.message));
  } finally { f.restore(); }
});

test('ghostFiles / balloonFiles: the manifest ghosts.json names and its pack from any stored copy (force-cache); format 1: the fixed name, a plain fetch', async () => {
  const gz = zlib.gzipSync(pack({ 'ghost/master/descript.txt': 'name,A\r\n' }));
  let f = fakeFetch({
    [INDEX]: json(index2()), [BASE + MAN_A]: json(manifestA()), [BASE + PACK_A]: new Response(gz),
    'http://s/sumika/index/balloon.b.9999999999.json': json({ format: 2, id: 'b', root: 'balloon/b/', files: [['descript.txt', 4]], versions: ['33333333'] }),
  });
  try {
    const idx = await SiteIndex.load(BASE);
    const files = await idx.ghostFiles('a');
    assert.deepEqual(f.calls.slice(1).map(c => [c.url, c.init]), [[BASE + MAN_A, { cache: 'force-cache' }]]);
    assert.equal(await files.text('ghost/master/descript.txt'), 'name,A\r\n');
    assert.deepEqual(f.calls.slice(2).map(c => [c.url, c.init]), [[BASE + PACK_A, { cache: 'force-cache' }]], 'the text from the pack');
    const bf = await idx.balloonFiles('b');
    assert.equal(bf.versionedUrl('descript.txt'), 'http://s/balloon/b/descript.txt?v=33333333');
    assert.deepEqual(f.calls.at(-1).init, { cache: 'force-cache' });
  } finally { f.restore(); }

  f = fakeFetch({
    [INDEX]: json({ format: 1, ghosts: [{ id: 'a b' }], balloons: [] }),
    'http://s/sumika/index/ghost.a%20b.json': json({ format: 1, id: 'a b', root: 'ghost/a%20b/', files: [['x.png', 3]] }),
  });
  try {
    const idx = await SiteIndex.load(BASE);
    const files = await idx.ghostFiles('a b');
    assert.equal(f.calls[1].url, 'http://s/sumika/index/ghost.a%20b.json');
    assert.equal(f.calls[1].args.length, 1, 'a fixed name: the browser\'s default');
    assert.equal(files.versionedUrl('x.png'), 'http://s/ghost/a%20b/x.png', 'no versions: no query');
  } finally { f.restore(); }
});

test('a hashed manifest or pack that is not ok, or a host\'s HTML page in its place (Cloudflare Pages without 404.html), is fetched once more with reload', async () => {
  const gz = zlib.gzipSync(pack({ 'ghost/master/descript.txt': 'name,A\r\n' }));
  for (const bad of [() => html(), () => new Response('', { status: 404 }), () => json({ not: 'a manifest' })]) {
    const f = fakeFetch({ [INDEX]: json(index2()), [BASE + MAN_A]: [bad, json(manifestA())], [BASE + PACK_A]: [() => html(), () => new Response(gz)] });
    try {
      const idx = await SiteIndex.load(BASE);
      const files = await idx.ghostFiles('a');
      assert.deepEqual(cacheOf(f.calls.filter(c => c.url === BASE + MAN_A)), ['force-cache', 'reload']);
      assert.equal(await files.text('ghost/master/descript.txt'), 'name,A\r\n');
      assert.deepEqual(cacheOf(f.calls.filter(c => c.url === BASE + PACK_A)), ['force-cache', 'reload'], 'the pack too');
      assert.equal(f.calls.filter(c => c.url.includes('descript.txt')).length, 0, 'no file one by one');
    } finally { f.restore(); }
  }
  // a pack still bad after its retry: the files one by one (a warning)
  const warn = console.warn;
  console.warn = () => {};
  const f = fakeFetch({
    [INDEX]: json(index2()), [BASE + MAN_A]: json(manifestA()), [BASE + PACK_A]: () => html(),
    'http://s/ghost/a/ghost/master/descript.txt?v=11111111': new Response('name,B\r\n'),
  });
  try {
    const files = await (await SiteIndex.load(BASE)).ghostFiles('a');
    assert.equal(await files.text('ghost/master/descript.txt'), 'name,B\r\n');
    assert.deepEqual(cacheOf(f.calls.filter(c => c.url.includes('descript.txt'))), ['force-cache', 'reload'], 'size 9 asked, 8 came: once more, then used');
  } finally { f.restore(); console.warn = warn; }
});

test('a manifest that is gone (pruned under a long-open tab): ghosts.json read again once (no-cache), only its manifests and versions taken, the manifest asked for under its new name; a second failure rejects', async () => {
  const MAN_A2 = 'sumika/index/ghost.a.aaaaaaaaaa.json';
  const fresh = index2({ ghosts: [{ id: 'a', name: 'A2' }], manifests: { ghost: { a: MAN_A2 }, balloon: index2().manifests.balloon },
    versions: { 'ghost/a/thumbnail.png': 'feedf00d' } });
  let f = fakeFetch({ [INDEX]: [json(index2()), json(fresh)], [BASE + MAN_A]: () => html(404), [BASE + MAN_A2]: json(manifestA({ pack: undefined })) });
  try {
    const idx = await SiteIndex.load(BASE);
    const files = await idx.ghostFiles('a');
    assert.deepEqual(f.calls.map(c => [c.url.slice(BASE.length), cacheOf([c])[0]]), [
      ['sumika/index/ghosts.json', 'no-cache'], [MAN_A, 'force-cache'], [MAN_A, 'reload'],
      ['sumika/index/ghosts.json', 'no-cache'], [MAN_A2, 'force-cache']]);
    assert.equal(files.versionedUrl('thumbnail.png'), 'http://s/ghost/a/thumbnail.png?v=0badf00d');
    assert.equal(idx.manifests.ghost.a, MAN_A2);
    assert.deepEqual(idx.versions, { 'ghost/a/thumbnail.png': 'feedf00d' });
    assert.deepEqual(idx.ghosts, [{ id: 'a', name: 'A' }], 'the page keeps its own entries');
    // once per page: another gone manifest is not looked up again
    await assert.rejects(idx.balloonFiles('b'), e => e.code === 'gone');
    assert.equal(f.calls.filter(c => c.url === INDEX).length, 2);
  } finally { f.restore(); }

  f = fakeFetch({ [INDEX]: json(index2()), [BASE + MAN_A]: () => new Response('', { status: 404 }) });
  try {
    const idx = await SiteIndex.load(BASE);
    await assert.rejects(idx.ghostFiles('a'), e => e.code === 'gone' && /404/.test(e.message), 'the same name again: rejects');
    assert.equal(f.calls.filter(c => c.url === INDEX).length, 2, 'read again, naming the same manifest');
    assert.equal(f.calls.filter(c => c.url === BASE + MAN_A).length, 2, 'not asked a third time');
  } finally { f.restore(); }

  f = fakeFetch({ [INDEX]: json(index2()), [BASE + MAN_A]: new TypeError('Failed to fetch') });
  try {
    const idx = await SiteIndex.load(BASE);
    await assert.rejects(idx.ghostFiles('a'), TypeError);
    assert.equal(f.calls.filter(c => c.url === INDEX).length, 1, 'a network failure is no gone manifest: no re-read');
  } finally { f.restore(); }

  // the index read again is newer than this runtime (a format bump under a long-open tab): the rejection is its
  // index-newer, which the Runtime takes to Site.staleCheck, not the gone manifest's
  const warn = console.warn;
  console.warn = () => {};
  f = fakeFetch({ [INDEX]: [json(index2()), json(index2({ format: 3, manifests: { ghost: { a: MAN_A2 }, balloon: {} } }))],
    [BASE + MAN_A]: () => new Response('', { status: 404 }) });
  try {
    const idx = await SiteIndex.load(BASE);
    await assert.rejects(idx.ghostFiles('a'), e => e.code === 'index-newer' && /format 3/.test(e.message));
    assert.equal(idx.manifests.ghost.a, MAN_A, 'nothing taken from it');
    await assert.rejects(idx.balloonFiles('b'), e => e.code === 'index-newer', 'the same answer for the page');
    assert.equal(f.calls.filter(c => c.url === INDEX).length, 2, 'read again once');
    assert.equal(f.calls.some(c => c.url === BASE + MAN_A2), false);
  } finally { f.restore(); console.warn = warn; }
});

test('a pack the host already decoded (Content-Encoding: gzip, SMKP first) is used as it is; a gzip one is decompressed', async () => {
  const raw = pack({ 'ghost/master/descript.txt': 'name,A\r\n' });
  for (const body of [raw, zlib.gzipSync(raw)]) {
    const f = fakeFetch({ [INDEX]: json(index2()), [BASE + MAN_A]: json(manifestA()), [BASE + PACK_A]: () => new Response(body) });
    try {
      const files = await (await SiteIndex.load(BASE)).ghostFiles('a');
      assert.equal(await files.text('ghost/master/descript.txt'), 'name,A\r\n');
      assert.equal(f.calls.filter(c => c.url === BASE + PACK_A).length, 1);
    } finally { f.restore(); }
  }
});

test('fetchVersioned: a ?v= URL from any stored copy; not ok or not the manifest\'s size: once more with reload; a size still different is used, logged once, and remembered for the tab; a plain URL as before', async () => {
  const U = 'http://s/ghost/a/x.png?v=0badf00d';
  let f = fakeFetch({ [U]: () => bytes(3) });
  try {
    assert.equal((await fetchVersioned(U, { size: 3 })).byteLength, 3);
    assert.deepEqual(f.calls.map(c => c.init), [{ cache: 'force-cache' }]);
    await fetchVersioned(U);
    assert.deepEqual(f.calls.at(-1).init, { cache: 'force-cache' }, 'no size given: any ok copy');
  } finally { f.restore(); }

  f = fakeFetch({ [U]: [() => new Response('', { status: 404 }), () => bytes(3)] });
  try {
    assert.equal((await fetchVersioned(U, { size: 3 })).byteLength, 3);
    assert.deepEqual(cacheOf(f.calls), ['force-cache', 'reload'], 'a stored error');
  } finally { f.restore(); }

  f = fakeFetch({ [U]: [() => bytes(2), () => bytes(3)] });
  try {
    assert.equal((await fetchVersioned(U, { size: 3 })).byteLength, 3);
    assert.deepEqual(cacheOf(f.calls), ['force-cache', 'reload'], 'a stored copy of other bytes');
  } finally { f.restore(); }

  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  f = fakeFetch({ [U]: () => bytes(2) });
  try {
    assert.equal((await fetchVersioned(U, { size: 3 })).byteLength, 2, 'a CDN that rewrites images must not break the shell');
    assert.equal((await fetchVersioned(U, { size: 3 })).byteLength, 2);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /x\.png\?v=0badf00d: 2 bytes where the index says 3/);
    assert.deepEqual(cacheOf(f.calls), ['force-cache', 'reload', 'force-cache', 'reload'], 'no sessionStorage: nothing remembered');
  } finally { f.restore(); console.warn = warn; }

  // the tab remembers a host that rewrites files (REWRITES_KEY): later fetches take a stored copy of another size as
  // it is, so the next pages do not download every image again; a stored copy that is not ok is still fetched again
  const tab = new Map();
  globalThis.sessionStorage = { getItem: k => (tab.has(k) ? tab.get(k) : null), setItem: (k, v) => tab.set(k, String(v)), removeItem: k => tab.delete(k) };
  console.warn = () => {};
  const V = 'http://s/ghost/a/y.png?v=12345678';
  f = fakeFetch({ [U]: () => bytes(2), [V]: [() => new Response('', { status: 404 }), () => bytes(5)] });
  try {
    assert.equal((await fetchVersioned(U, { size: 3 })).byteLength, 2);
    assert.equal(tab.get(REWRITES_KEY), '1');
    assert.equal((await fetchVersioned(U, { size: 3 })).byteLength, 2);
    assert.equal((await fetchVersioned(V, { size: 4 })).byteLength, 5);
    assert.deepEqual(f.calls.map(c => [c.url === U ? 'U' : c.url === V ? 'V' : c.url, cacheOf([c])[0]]),
      [['U', 'force-cache'], ['U', 'reload'], ['U', 'force-cache'], ['V', 'force-cache'], ['V', 'reload']]);
  } finally { f.restore(); console.warn = warn; delete globalThis.sessionStorage; }

  f = fakeFetch({ [U]: [() => new Response('', { status: 404 })] });
  try {
    await assert.rejects(fetchVersioned(U), /404/);
    assert.deepEqual(cacheOf(f.calls), ['force-cache', 'reload']);
  } finally { f.restore(); }

  f = fakeFetch({ 'http://s/ghost/a/x.png': () => bytes(5, 'image/png') });
  try {
    const b = await fetchVersioned('http://s/ghost/a/x.png', { size: 3, as: 'blob' });
    assert.equal(b.size, 5, 'no ?v=: no size check');
    assert.equal(b.type, 'image/png');
    assert.deepEqual(f.calls.map(c => c.args.length), [1], 'a plain fetch(url)');
  } finally { f.restore(); }
});

test('GhostFiles: url() is the plain URL elements load (<img>, CSS, <audio>, cursors); versionedUrl() adds the manifest\'s ?v=; sub() keeps the versions; tuple-built ones give the plain URLs', () => {
  const files = new GhostFiles('http://s/ghost/a%231/', [['shell/master/surface0.png', 3, 1, 1], ['Bal/thumbnail.png', 2], ['x y.txt', 1]], null, '',
    ['aaaaaaaa', 'bbbbbbbb', null]);
  assert.equal(files.url('shell/master/surface0.png'), 'http://s/ghost/a%231/shell/master/surface0.png', 'no query for an element');
  assert.equal(files.url('SHELL\\master\\surface0.png'), 'http://s/ghost/a%231/shell/master/surface0.png');
  assert.equal(files.versionedUrl('SHELL\\master\\surface0.png'), 'http://s/ghost/a%231/shell/master/surface0.png?v=aaaaaaaa');
  assert.equal(files.versionedUrl('x y.txt'), 'http://s/ghost/a%231/x%20y.txt', 'no version: no query');
  assert.equal(files.versionedUrl('missing.png'), 'http://s/ghost/a%231/missing.png', 'a path the manifest does not list');
  const sub = files.sub('bal');
  assert.equal(sub.url('thumbnail.png'), 'http://s/ghost/a%231/Bal/thumbnail.png');
  assert.equal(sub.versionedUrl('thumbnail.png'), 'http://s/ghost/a%231/Bal/thumbnail.png?v=bbbbbbbb');
  // an element's load keeps the plain URL: a sound (`new Audio(url)`, page-saori.js urlFor)
  const sounds = new GhostFiles('http://s/ghost/a/', [['ghost/master/se.wav', 9]], null, '', ['cccccccc']);
  assert.equal(new PageSaori({ files: sounds, Audio: class {}, win: null }).urlFor('ghost/master/se.wav'), 'http://s/ghost/a/ghost/master/se.wav');
  // tuple-built (tests, the sweep): exactly the plain URLs and records
  const plain = new GhostFiles('http://s/ghost/a/', [['shell/master/surface0.png', 3, 1, 1], ['x.txt', 1]]);
  for (const p of ['shell/master/surface0.png', 'x.txt', 'missing']) assert.equal(plain.versionedUrl(p), plain.url(p));
  assert.deepEqual(plain.files, [{ path: 'shell/master/surface0.png', size: 3, w: 1, h: 1 }, { path: 'x.txt', size: 1, w: undefined, h: undefined }]);
});

test('the fetch() paths go through fetchVersioned: GhostFiles.bytes one by one, shell/images.js _bytes, loadThumbnail and a local banner', async () => {
  const files = new GhostFiles('http://s/ghost/a/', [['ghost/master/dic.txt', 4], ['shell/master/surface0.png', 3, 1, 1],
    ['ghost/master/banner/b.png', 2, 1, 1]], null, '', ['dddddddd', 'aaaaaaaa', 'bbbbbbbb']);
  const f = fakeFetch({
    'http://s/ghost/a/ghost/master/dic.txt?v=dddddddd': () => bytes(4),
    'http://s/ghost/a/shell/master/surface0.png?v=aaaaaaaa': () => bytes(3, 'image/png'),
    'http://s/ghost/a/ghost/master/banner/b.png?v=bbbbbbbb': () => bytes(2, 'image/png'),
  });
  const cib = globalThis.createImageBitmap;
  const blobs = [];
  globalThis.createImageBitmap = async b => { blobs.push(b); throw new Error('no decoder here'); };
  try {
    assert.equal((await files.bytes('ghost/master/dic.txt')).byteLength, 4);
    assert.equal((await new ImageCache({ files })._bytes('shell/master/surface0.png')).byteLength, 3);
    const [banner] = bannerUrls(files, 'b');
    assert.equal(banner, 'http://s/ghost/a/ghost/master/banner/b.png?v=bbbbbbbb');
    await assert.rejects(loadThumbnail(banner), /no decoder here/);
    assert.deepEqual(f.calls.map(c => [c.url.slice('http://s/ghost/a/'.length), c.init]), [
      ['ghost/master/dic.txt?v=dddddddd', { cache: 'force-cache' }],
      ['shell/master/surface0.png?v=aaaaaaaa', { cache: 'force-cache' }],
      ['ghost/master/banner/b.png?v=bbbbbbbb', { cache: 'force-cache' }]]);
    assert.equal(blobs[0].type, 'image/png', 'the response\'s type reaches the decoder');
    assert.equal(blobs[0].size, 2);
  } finally {
    f.restore();
    if (cib === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = cib;
  }
});

test('the menu\'s dress-up part and banner thumbnails are the ?v= URLs loadThumbnail fetches; tuple-built files give the plain URLs', () => {
  const list = [['shell/master/thumbnail/surface500.png', 2, 1, 1], ['ghost/master/banner/b.png', 2, 1, 1]];
  const files = new GhostFiles('http://s/ghost/a/', list, null, '', ['eeeeeeee', 'bbbbbbbb']);
  const f = new Menu({ files, shellDir: 'shell/master/', thumbnail: null })._thumbFinders();
  assert.deepEqual(f.part('thumbnail\\surface500'), ['http://s/ghost/a/shell/master/thumbnail/surface500.png?v=eeeeeeee']);
  assert.deepEqual(f.banner('b'), ['http://s/ghost/a/ghost/master/banner/b.png?v=bbbbbbbb']);
  const plain = new Menu({ files: new GhostFiles('http://s/ghost/a/', list), shellDir: 'shell/master/', thumbnail: null })._thumbFinders();
  assert.deepEqual(plain.part('thumbnail/surface500'), ['http://s/ghost/a/shell/master/thumbnail/surface500.png']);
});

test('siteUrls: with the index\'s versions a path it lists gets ?v= (thumbnails fetch() loads); without them, the plain URLs', () => {
  const paths = ['ghost/a#1/thumbnail.png', 'ghost/b/thumbnail.png', ''];
  assert.deepEqual(siteUrls(BASE, paths), ['http://s/ghost/a%231/thumbnail.png', 'http://s/ghost/b/thumbnail.png']);
  assert.deepEqual(siteUrls(BASE, paths, { 'ghost/a#1/thumbnail.png': '0badf00d' }),
    ['http://s/ghost/a%231/thumbnail.png?v=0badf00d', 'http://s/ghost/b/thumbnail.png']);
  assert.deepEqual(siteUrls(BASE, ['constructor'], {}), ['http://s/constructor'], 'only its own keys');
  assert.deepEqual(siteUrls('not a url', paths, {}), []);
});

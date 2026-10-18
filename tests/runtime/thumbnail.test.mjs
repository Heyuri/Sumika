// The menu's thumbnail window (UI §2.14): ssp.exe's placement (CThumbnailWnd::CreateMe), its 350 ms timer and
// selection rules (CCharWndCode::OnCWMenuSelect / OnCWTimer / ProcessThumbnail), the `.pnr` colour key, the menu's
// WM_MENUSELECT stand-in (Menu._syncThumb), the ghost rows' thumbnails, and index_site.py's lookup
// (SPGhostProp::GetThumbnail: `thumbnail*.*` images in the ghost folder, else ghost/master/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { placeThumbnail, thumbnailAlpha, MenuThumbnail, THUMB_DELAY_MS, THUMB_MARGIN, findLoadable, imageExt, bannerUrls } from '../../src/ui/thumbnail.js';
import { Menu, ghostItems, callItems, shellItems, balloonItems, dressupItems, buildMenuModel, thumbKey } from '../../src/ui/menu.js';
import { Site } from '../../src/core/site.js';
import { installedBalloons, balloonMenu } from '../../src/core/shells.js';
import { siteUrls } from '../../src/core/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.env.PYTHON || 'python';
const WORK = { left: 0, top: 0, right: 1920, bottom: 1040 };

test('placeThumbnail: bottom-left, or bottom-right while the pointer is in the left half; 10 px in [disasm 0x4b1639]', () => {
  const img = { width: 120, height: 200 };
  assert.deepEqual(placeThumbnail(img, { x: 1500, y: 900 }, WORK), { x: THUMB_MARGIN, y: 1040 - 200 - 10, w: 120, h: 200 });
  assert.deepEqual(placeThumbnail(img, { x: 300, y: 900 }, WORK), { x: 1920 - 120 - 10, y: 830, w: 120, h: 200 });
  // the middle itself is the right half (cmp, jge)
  assert.equal(placeThumbnail(img, { x: 960, y: 0 }, WORK).x, 10);
  assert.equal(placeThumbnail(img, { x: 959, y: 0 }, WORK).x, 1790);
  // a work area that does not start at 0 (another monitor, a taskbar on the left)
  const off = { left: 100, top: 50, right: 1100, bottom: 850 };
  assert.deepEqual(placeThumbnail(img, { x: 700, y: 0 }, off), { x: 110, y: 640, w: 120, h: 200 });
  assert.deepEqual(placeThumbnail(img, { x: 500, y: 0 }, off), { x: 970, y: 640, w: 120, h: 200 });
});

test('placeThumbnail: grows by dpi/96 above 96 dpi (integer), never below; shrinks to half the work area by the smaller ratio', () => {
  assert.deepEqual(placeThumbnail({ width: 121, height: 99 }, { x: 0, y: 0 }, WORK, 120), { x: 1920 - 151 - 10, y: 1040 - 123 - 10, w: 151, h: 123 });
  assert.deepEqual(placeThumbnail({ width: 121, height: 99 }, { x: 0, y: 0 }, WORK, 72).w, 121);
  // 1000×400 in a 1000×1000 area: half is 500×500, ratio 0.5 by width
  assert.deepEqual(placeThumbnail({ width: 1000, height: 400 }, { x: 900, y: 0 }, { left: 0, top: 0, right: 1000, bottom: 1000 }),
    { x: 10, y: 1000 - 200 - 10, w: 500, h: 200 });
  // 300×999 in 1000×1000: by height (500/999), truncated
  const p = placeThumbnail({ width: 300, height: 999 }, { x: 900, y: 0 }, { left: 0, top: 0, right: 1000, bottom: 1000 });
  assert.deepEqual([p.w, p.h], [Math.trunc(300 * (500 / 999)), Math.trunc(999 * (500 / 999))]);
  assert.equal(placeThumbnail({ width: 0, height: 10 }, { x: 0, y: 0 }, WORK), null);
});

test('thumbnailAlpha: a fully opaque `.pnr` keys out its top-left colour; a `.png`, or a `.pnr` with its own alpha, stays', () => {
  const px = (...a) => ({ width: a.length / 4, height: 1, data: Uint8ClampedArray.from(a) });
  const key = px(0, 255, 0, 255, 9, 9, 9, 255, 0, 255, 0, 255);
  thumbnailAlpha(key, 'http://s/ghost/b/thumbnail.pnr');
  assert.deepEqual([...key.data], [0, 0, 0, 0, 9, 9, 9, 255, 0, 0, 0, 0]);
  const upper = px(1, 2, 3, 255, 1, 2, 3, 255);
  thumbnailAlpha(upper, 'THUMBNAIL.PNR?x=1');
  assert.deepEqual([...upper.data], [0, 0, 0, 0, 0, 0, 0, 0]);
  const png = px(0, 255, 0, 255, 9, 9, 9, 255);
  thumbnailAlpha(png, 'thumbnail.png');
  assert.deepEqual([...png.data], [0, 255, 0, 255, 9, 9, 9, 255]);
  const own = px(0, 255, 0, 255, 9, 9, 9, 128);
  thumbnailAlpha(own, 'thumbnail.pnr');
  assert.deepEqual([...own.data], [0, 255, 0, 255, 9, 9, 9, 128]);
  // SSP tests the path's last character: a full-width ｒ is not 'r'
  const wide = px(0, 255, 0, 255);
  thumbnailAlpha(wide, 'thumbnail.pn%EF%BD%92');
  assert.deepEqual([...wide.data], [0, 255, 0, 255]);
});

/** a manual clock and a loader that resolves at once (or fails for 'bad' URLs) */
function rig({ random = () => 0 } = {}) {
  let now = 0;
  const timers = new Map();
  let next = 1;
  const clock = {
    setTimeout: (f, ms) => { const id = next++; timers.set(id, { at: now + ms, f }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const advance = async ms => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.f(); }
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const loads = [];
  const load = async url => {
    loads.push(url);
    if (url.includes('bad')) throw new Error('cannot decode');
    return { width: 100, height: 50, data: new Uint8ClampedArray(100 * 50 * 4) };
  };
  const th = new MenuThumbnail({ clock, random, load, draw: false });
  return { th, advance, loads, timers };
}

test('MenuThumbnail: 350 ms after a ghost row is selected its thumbnail shows; another kind of row hides it at once', async () => {
  const { th, advance, loads } = rig();
  th.select('ghost:a', ['u/a.png'], () => ({ x: 1000, y: 10 }));
  await advance(THUMB_DELAY_MS - 1);
  assert.equal(th.shown, null, 'not before the timer');
  await advance(1);
  assert.equal(th.shown.url, 'u/a.png');
  assert.equal(th.shown.key, 'ghost:a');
  assert.deepEqual(loads, ['u/a.png']);
  th.select(null);
  assert.equal(th.shown, null, 'hidden at once');
  // back on the same row after that: shown again (the last-shown key was cleared)
  th.select('ghost:a', ['u/a.png']);
  await advance(THUMB_DELAY_MS);
  assert.equal(th.shown.url, 'u/a.png');
});

test('MenuThumbnail: moving between ghost rows keeps the shown one until the new row\'s timer; a ghost without one hides it', async () => {
  const { th, advance } = rig();
  th.select('ghost:a', ['u/a.png']);
  await advance(THUMB_DELAY_MS);
  th.select('ghost:b', ['u/b.png']);
  await advance(THUMB_DELAY_MS - 1);
  assert.equal(th.shown.url, 'u/a.png', 'a stays while b waits');
  await advance(1);
  assert.equal(th.shown.url, 'u/b.png');
  th.select('ghost:c', []);
  await advance(THUMB_DELAY_MS);
  assert.equal(th.shown, null, 'c has none: hidden');
  // passing quickly over a row starts nothing: only the last selection's timer runs
  th.select('ghost:a', ['u/a.png']);
  await advance(100);
  th.select('callghost:b', ['u/b.png']);
  await advance(THUMB_DELAY_MS);
  assert.equal(th.shown.key, 'callghost:b');
});

test('MenuThumbnail: a row already processed is not done again until something else is selected; a failed image hides', async () => {
  const { th, advance, loads } = rig();
  th.select('ghost:a', ['u/a.png']);
  await advance(THUMB_DELAY_MS);
  th.select('ghost:a', ['u/a.png']);
  await advance(THUMB_DELAY_MS);
  assert.deepEqual(loads, ['u/a.png'], 'the same key: no second load (ProcessThumbnail runs on a changed id only)');
  th.select('ghost:bad', ['u/bad.tga']);
  await advance(THUMB_DELAY_MS);
  assert.equal(th.shown, null);
});

test('MenuThumbnail: one of several thumbnails at random each time; a hide drops a load still running', async () => {
  const seq = [0.1, 0.9];
  const { th, advance } = rig({ random: () => seq.shift() ?? 0 });
  th.select('ghost:a', ['u/1.png', 'u/2.png']);
  await advance(THUMB_DELAY_MS);
  assert.equal(th.shown.url, 'u/1.png');
  th.select(null);
  th.select('ghost:a', ['u/1.png', 'u/2.png']);
  await advance(THUMB_DELAY_MS);
  assert.equal(th.shown.url, 'u/2.png');

  let release;
  const slow = new MenuThumbnail({
    clock: { setTimeout: (f) => { f(); return 1; }, clearTimeout: () => {} },
    load: () => new Promise(r => { release = r; }), draw: false,
  });
  slow.select('ghost:a', ['u/a.png']);
  await Promise.resolve(); await Promise.resolve();
  slow.select(null);
  release({ width: 10, height: 10, data: new Uint8ClampedArray(400) });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(slow.shown, null, 'the menu closed while it loaded');
});

/** fake menu elements: rows with __item, a hot set and aria-disabled */
function fakeMenu(items, hot) {
  const rows = items.map(item => ({
    __item: item,
    classList: { contains: c => c === 'smk-hot' && hot.has(item) },
    getAttribute: n => (n === 'aria-disabled' && item.disabled ? 'true' : null),
  }));
  return { rows, el: { querySelectorAll: () => rows, remove: () => {} } };
}

test('Menu._syncThumb: the deepest hot row is the selection; an enabled ghost row sends its key and thumbnails, the rest none', () => {
  const calls = [];
  const thumb = { select: (k, urls, cur) => calls.push(k === null ? null : [k, urls, typeof cur]) };
  const m = new Menu({ thumbnail: thumb });
  const hot = new Set();
  const ghosts = ghostItems([
    { id: 'a', name: 'A', thumbnails: ['http://s/ghost/a/thumbnail.png'] },
    { id: 'me', name: 'Me', current: true, thumbnails: ['http://s/ghost/me/thumbnail.png'] },
    { id: 'el', name: 'Elsewhere', elsewhere: true, thumbnails: ['http://s/ghost/el/thumbnail.png'] },
    { id: 'mi', name: 'M', needs: 'Misaka' },
    { id: 'b', name: 'B' },
  ]);
  const parentItem = { kind: 'sub', label: 'Change ghost', items: ghosts };
  const main = fakeMenu([parentItem, { kind: 'item', label: 'Close', action: { type: 'close' } }], hot);
  const sub = fakeMenu(ghosts, hot);
  m.el = main.el;
  m.subs = [sub.el];
  const step = (add, del) => { if (del) hot.delete(del); if (add) hot.add(add); m._syncThumb(); };
  step(parentItem);                       // Change ghost ▸'s own row (a submenu's): none
  step(ghosts[0]);                        // the pointer reached A in the submenu (the parent row stays hot)
  step();                                 // nothing changed: nothing sent
  step(ghosts[1], ghosts[0]);             // the running ghost: its row is enabled (a pick reloads it), so it shows
  step(ghosts[2], ghosts[1]);             // on screen in another slot: greyed
  step(ghosts[3], ghosts[2]);             // needs Misaka: greyed
  step(ghosts[4], ghosts[3]);             // B: a ghost row without thumbnails still counts (it hides the window)
  step(null, ghosts[4]);                  // the pointer left the submenu: its parent row is selected
  step(ghosts[0]);
  m.close({ restoreFocus: false });       // WM_MENUSELECT 0xFFFF
  assert.deepEqual(calls, [
    null,
    ['ghost:a', ['http://s/ghost/a/thumbnail.png'], 'function'],
    ['ghost:me', ['http://s/ghost/me/thumbnail.png'], 'function'],
    null,
    null,
    ['ghost:b', [], 'function'],
    null,
    ['ghost:a', ['http://s/ghost/a/thumbnail.png'], 'function'],
    null,
  ]);
});

test('ghostItems / callItems carry a ghost\'s thumbnails as `thumbs`; Site._thumbUrls makes them URLs, each folder name encoded', () => {
  const g = { id: 'a', name: 'A', thumbnails: ['http://s/a.png'] };
  assert.deepEqual(ghostItems([g])[0].thumbs, ['http://s/a.png']);
  assert.deepEqual(callItems([g])[0].thumbs, ['http://s/a.png']);
  assert.equal('thumbs' in ghostItems([{ id: 'b', name: 'B' }])[0], false);
  const urls = Site.prototype._thumbUrls.call({ base: 'http://s/site/' }, { thumbnails: ['ghost/a b#1/ghost/master/thumbnail.png'] });
  assert.deepEqual(urls, ['http://s/site/ghost/a%20b%231/ghost/master/thumbnail.png']);
  assert.deepEqual(Site.prototype._thumbUrls.call({ base: 'http://s/' }, {}), []);
});

test('index_site.py: thumbnails are the ghost folder\'s `thumbnail*.*` images (SSP\'s extension table, any case), else ghost/master/\'s', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-thumb-'));
  try {
    const site = path.join(tmp, 'site');
    const ghost = (id, files) => {
      fs.mkdirSync(path.join(site, 'ghost', id, 'ghost', 'master'), { recursive: true });
      fs.writeFileSync(path.join(site, 'ghost', id, 'ghost', 'master', 'descript.txt'), `charset,UTF-8\r\nname,${id}\r\nshiori,satori.dll\r\n`);
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(site, 'ghost', id, f)), { recursive: true });
        fs.writeFileSync(path.join(site, 'ghost', id, f), 'x');
      }
    };
    ghost('many', ['Thumbnail2.PNG', 'thumbnail.pnｒ', 'thumbnail.tiff', 'thumbnail.exe', 'thumbnail.txt', 'thumbnailx',
      'thumbnail.pna', 'thumbnail.png.bak', 'thumb.png', 'ghost/master/thumbnail.png']);
    fs.mkdirSync(path.join(site, 'ghost', 'many', 'thumbnail.gif'));            // a folder is not a file
    ghost('master', ['ghost/master/thumbnail.jpg', 'shell/master/thumbnail.png', 'shell/master/thumbnail2.webp',
      'shell/plain/descript.txt', 'shell/plain/surface0.png',
      'bal/descript.txt', 'bal/balloons0.png', 'bal/thumbnail1.gif']);
    ghost('none', ['shell/master/thumbnail.png']);
    fs.mkdirSync(path.join(site, 'balloon', 'sb'), { recursive: true });
    fs.writeFileSync(path.join(site, 'balloon', 'sb', 'descript.txt'), 'charset,UTF-8\r\nname,SB\r\ntype,balloon\r\n');
    fs.writeFileSync(path.join(site, 'balloon', 'sb', 'thumbnail.pnr'), 'x');
    const r = spawnSync(PY, ['-I', '-B', path.join(root, 'tools', 'index_site.py'), site], { encoding: 'utf8' });
    if (r.error) throw new Error(`this test runs Python (${PY}; set PYTHON to another): ${r.error.message}`);
    assert.equal(r.status, 0, r.stderr);
    const idx = JSON.parse(fs.readFileSync(path.join(site, 'sumika', 'index', 'ghosts.json'), 'utf8'));
    const g = id => idx.ghosts.find(x => x.id === id);
    const th = id => g(id).thumbnails;
    assert.deepEqual(th('many'), ['ghost/many/thumbnail.pnｒ', 'ghost/many/thumbnail.tiff', 'ghost/many/Thumbnail2.PNG']);
    assert.deepEqual(th('master'), ['ghost/master/ghost/master/thumbnail.jpg']);
    assert.deepEqual(th('none'), []);
    assert.equal('thumbnail' in idx.ghosts[0], false);
    // Shell ▸ and Balloon ▸ (SPProp::GetThumbnail): the item's own folder only, no ghost/master fallback
    assert.deepEqual(g('master').shells.map(s => [s.id, s.thumbnails || null]), [
      ['master', ['ghost/master/shell/master/thumbnail.png', 'ghost/master/shell/master/thumbnail2.webp']], ['plain', null]]);
    assert.deepEqual(g('master').bundledBalloons, [{ dir: 'bal', name: 'bal', thumbnails: ['ghost/master/bal/thumbnail1.gif'] }]);
    assert.deepEqual(idx.balloons.map(b => [b.id, b.thumbnails]), [
      ['bal', ['ghost/master/bal/thumbnail1.gif']], ['sb', ['balloon/sb/thumbnail.pnr']]]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** a GhostFiles stand-in over a list of real paths */
function fakeFiles(paths) {
  return {
    list(prefix = '', { recursive = true } = {}) {
      const pre = prefix ? prefix.toLowerCase().replace(/\/$/, '') + '/' : '';
      return paths.filter(p => p.toLowerCase().startsWith(pre) && (recursive || !p.slice(pre.length).includes('/')));
    },
    url: p => `http://s/ghost/g/${p}`,
  };
}

test('findLoadable: SSP\'s any-extension lookup (the written extension goes; the first image of <name>.* in NTFS order)', () => {
  const files = fakeFiles(['shell/master/thumbnail/surface500.txt', 'shell/master/thumbnail/surface500.png', 'shell/master/thumbnail/surface510.BMP',
    'shell/master/thumbnail/surface510.gif', 'shell/master/thumbnail/s.jpeg', 'shell/master/thumbnail/surface5000.png', 'shell/master/x.exe']);
  assert.equal(findLoadable(files, 'shell/master/thumbnail/surface500'), 'shell/master/thumbnail/surface500.png');
  assert.equal(findLoadable(files, 'shell/master/thumbnail\\surface500.bmp'), 'shell/master/thumbnail/surface500.png', 'the written extension does not count');
  assert.equal(findLoadable(files, 'shell/master/thumbnail/SURFACE510'), 'shell/master/thumbnail/surface510.BMP', 'BMP before GIF, any case');
  assert.equal(findLoadable(files, 'shell/master/thumbnail/s'), 'shell/master/thumbnail/s.jpeg', 'a 4-letter extension');
  assert.equal(findLoadable(files, 'shell/master/x'), null, 'a program is no image');
  assert.equal(findLoadable(files, 'shell/master/thumbnail/nothing'), null);
  assert.equal(findLoadable(null, 'a'), null);
  assert.ok(imageExt('PNG') && imageExt('tiff') && imageExt('pn\uff52') && !imageExt('exe') && !imageExt('pna') && !imageExt(''));
});

test('bannerUrls: ghost/master/banner/<name>.* first (a URL by its last segment), else an http(s) URL itself, else none', () => {
  const files = fakeFiles(['ghost/master/banner/getfirefox.png', 'ghost/master/banner/mozilla.gif']);
  assert.deepEqual(bannerUrls(files, 'getfirefox'), ['http://s/ghost/g/ghost/master/banner/getfirefox.png'], 'firefox.nar writes no extension');
  assert.deepEqual(bannerUrls(files, 'http://example.invalid/b/mozilla.png'), ['http://s/ghost/g/ghost/master/banner/mozilla.gif']);
  assert.deepEqual(bannerUrls(files, 'https://example.invalid/b/other.png'), ['https://example.invalid/b/other.png'], 'loaded from the web, as SSP downloads it');
  assert.deepEqual(bannerUrls(files, 'file:///C:/x/other.png'), []);
  assert.deepEqual(bannerUrls(files, 'other.png'), []);
  assert.deepEqual(bannerUrls(files, ''), []);
  assert.deepEqual(bannerUrls(files, '  '), []);
});

test('thumbKey: SSP\'s thumbnail ranges (shells, both ghost lists, balloons, sites, dress-up parts); any other row none', () => {
  assert.equal(thumbKey({ type: 'ghost', id: 'a' }), 'ghost:a');
  assert.equal(thumbKey({ type: 'callghost', id: 'a' }), 'callghost:a');
  assert.equal(thumbKey({ type: 'shell', id: 'master' }), 'shell:master');
  assert.equal(thumbKey({ type: 'balloon', id: 'b' }), 'balloon:b');
  assert.equal(thumbKey({ type: 'dressup', scope: 1, id: 7 }), 'dressup:1:7');
  assert.equal(thumbKey({ type: 'site', kind: 'recommend', index: 2 }), 'recommend:2');
  assert.equal(thumbKey({ type: 'site', kind: 'portal', index: 0 }), 'portal:0');
  for (const t of ['close', 'quit', 'reset', 'iconify', 'preferences', 'carry', 'lang']) assert.equal(thumbKey({ type: t }), null);
  assert.equal(thumbKey(null), null);
});

test('menu rows carry their thumbnails: shells, balloons (both rows of a top balloon), dress-up parts and sites look theirs up when selected', () => {
  assert.deepEqual(shellItems([{ id: 'master', name: 'M', current: true, thumbnails: ['u/s.png'] }, { id: 'b', name: 'B' }]).map(i => i.thumbs || null), [['u/s.png'], null]);
  const b = balloonItems({ top: [{ id: 'x', name: 'X', thumbnails: ['u/x.png'] }], all: [{ id: 'x', name: 'X', thumbnails: ['u/x.png'] }, { id: 'y', name: 'Y' }] });
  assert.deepEqual(b.map(i => (i.kind === 'sep' ? '-' : i.thumbs || null)), [['u/x.png'], '-', ['u/x.png'], null]);
  const asked = [];
  const thumbs = { part: t => { asked.push(t); return [`u/${t}.png`]; }, banner: x => [`b/${x}`] };
  const manual = dressupItems({ mode: 'manual', enabled: true, entries: [
    { type: 'part', id: 3, category: 'Hat', part: 'Red', on: true, thumbnail: 'thumbnail/surface500' },
    { type: 'part', id: 4, category: 'Hat', part: 'Blue', on: false },
  ] }, 1, thumbs);
  assert.equal(typeof manual[0].thumbs, 'function');
  assert.deepEqual(asked, [], 'nothing is looked up until a row is selected');
  assert.deepEqual(manual[0].thumbs(), ['u/thumbnail/surface500.png']);
  assert.equal(manual[1].thumbs, undefined);
  assert.equal(thumbKey(manual[0].action), 'dressup:1:3');
  const auto = dressupItems({ mode: 'auto', enabled: true, entries: [
    { type: 'category', category: 'Hat', on: true, parts: [{ id: 1, part: 'A', on: true, thumbnail: 't/a' }, { id: 2, part: 'B', on: false }] },
    { type: 'category', category: 'Bag', on: false, parts: [{ id: 5, part: 'C', on: false, thumbnail: 't/c' }] },
  ] }, 0, thumbs);
  assert.equal(auto[0].kind, 'sub', 'a category of 2+ parts is a submenu: its own row has none');
  assert.deepEqual(auto[0].items[0].thumbs(), ['u/t/a.png']);
  assert.deepEqual(auto.at(-1).thumbs(), ['u/t/c.png'], 'a single part row');
  assert.equal(dressupItems({ mode: 'manual', entries: [{ type: 'part', id: 3, category: 'c', part: 'p', thumbnail: 't' }] }, 0)[0].thumbs, undefined, 'no finder: none');
  const res = new Map([['sakura.recommendsites', 'Site\x01http://a.invalid/\x01ban\x02No url\x01\x01ban2\x02Plain\x01http://b.invalid/']]);
  const rec = buildMenuModel(0, res, { thumbs }).find(i => i.label === '&Recommendations');
  assert.deepEqual(rec.items.map(i => [i.disabled || false, typeof i.thumbs === 'function' ? i.thumbs() : null]), [
    [false, ['b/ban']], [true, ['b/ban2']], [false, null]]);
});

test('Menu._thumbFinders: a part in the current shell folder, a banner in ghost/master/banner/ (the ghost\'s files)', () => {
  const files = fakeFiles(['shell/kisekae/thumbnail/surface10000.png', 'ghost/master/banner/nekomusha.png']);
  const m = new Menu({ files, shellDir: 'shell/kisekae/', thumbnail: null });
  const f = m._thumbFinders();
  assert.deepEqual(f.part('thumbnail\\surface10000'), ['http://s/ghost/g/shell/kisekae/thumbnail/surface10000.png']);
  assert.deepEqual(f.part('thumbnail/none'), []);
  assert.deepEqual(f.banner('nekomusha'), ['http://s/ghost/g/ghost/master/banner/nekomusha.png']);
  assert.equal(new Menu({ thumbnail: null })._thumbFinders(), null);
});

test('MenuThumbnail: a row whose thumbnails are a function is looked up when its timer fires', async () => {
  const { th, advance, loads } = rig();
  let calls = 0;
  th.select('dressup:0:3', () => { calls++; return ['u/p.png']; });
  assert.equal(calls, 0);
  await advance(THUMB_DELAY_MS);
  assert.equal(calls, 1);
  assert.deepEqual(loads, ['u/p.png']);
  th.select('dressup:0:4', () => { throw new Error('broken'); });
  await advance(THUMB_DELAY_MS);
  assert.equal(th.shown, null, 'a failing lookup hides it');
});

test('installedBalloons / balloonMenu keep the index\'s balloon thumbnails; siteUrls encodes each folder name', () => {
  const index = { balloons: [{ id: 'sb', name: 'SB', thumbnails: ['balloon/sb/thumbnail.pnr'] }, { id: 'plain', name: 'Plain' }] };
  const ghost = { id: 'g', bundledBalloons: [{ dir: 'own', name: 'Own', thumbnails: ['ghost/g/own/thumbnail.png'] }] };
  const list = installedBalloons(index, ghost);
  assert.deepEqual(list.map(b => [b.id, b.thumbnails || null]), [['own', ['ghost/g/own/thumbnail.png']], ['plain', null], ['sb', ['balloon/sb/thumbnail.pnr']]]);
  assert.deepEqual(balloonMenu(list, [], 'sb').all.map(r => [r.id, r.current, r.thumbnails || null]),
    [['own', false, ['ghost/g/own/thumbnail.png']], ['plain', false, null], ['sb', true, ['balloon/sb/thumbnail.pnr']]]);
  assert.deepEqual(siteUrls('http://s/site/', ['ghost/a b#1/shell/m/thumbnail.png', '', null]), ['http://s/site/ghost/a%20b%231/shell/m/thumbnail.png']);
  assert.deepEqual(siteUrls(undefined, ['x']), []);
});

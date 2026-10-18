// The SHIORI's menu look (src/ui/menu.js Menu.loadShioriLook / open; UI §2.3; ssp.exe 2.9.10 SPGhost::GetODMFromShiori
// 0x623730) on the fake DOM: bthver.5's real files with its answers (a fake SHIORI, then its real Kawari over an
// EventLoop), etherism's answers, a descript-only look, where a SHIORI-named image is looked for, a shell change, and
// one pass at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, tick } from '../balloon/fake_dom.mjs';
import { needs } from '../needs.mjs';

installFakeDom();
globalThis.self = globalThis.self || { postMessage() {} };      // the worker's engine modules touch self at import
const { Menu, ODM_NAME_IDS, ODM_SIDEBAR_ID, ODM_FILL_IDS, ODM_REST_IDS } = await import('../../src/ui/menu.js');
const { GhostFiles, parseDescript, decodeText } = await import('../../src/core/loader.js');
const { EventLoop } = await import('../../src/core/events.js');
const { buildRequest, parseResponse } = await import('../../src/core/shiori.js');
const { KawariEngine } = await import('../../src/worker/engines/kawari.js');
const { loadEngineFactory } = await import('../load_engine.mjs');
const { FakeClock, FakeStage } = await import('./fakes.mjs');
const { setLogLevel } = await import('../../src/core/log.js');

setLogLevel('silent');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BTH = path.join(ROOT, 'site/ghost/bthver.5');
const ENGINE_JS = path.join(ROOT, 'site/sumika/engines/kawari.js');
const BASE = 'https://site.test/ghost/bthver.5/';
const ALL = [...ODM_NAME_IDS, ODM_SIDEBAR_ID, ...ODM_FILL_IDS, ...ODM_REST_IDS];
const FULL_PASS = [ODM_NAME_IDS, [ODM_SIDEBAR_ID, ...ODM_FILL_IDS], ODM_REST_IDS];

const rgbAnswers = (k, r, g, b) => ({ [`menu.${k}.r`]: String(r), [`menu.${k}.g`]: String(g), [`menu.${k}.b`]: String(b) });
/** bthver.5's answers (ghost/master/core/resources.txt lines 404–441; its real Kawari gives the same: last test) */
const BTH_ODM = Object.freeze(Object.entries({
  'menu.background.bitmap.filename': 'menu\\menu_background_1.png',
  'menu.foreground.bitmap.filename': 'menu\\menu_foreground_1.png',
  'menu.sidebar.bitmap.filename': 'menu\\menu_sidebar_1.png',
  ...rgbAnswers('background.font.color', 0, 0, 0), ...rgbAnswers('foreground.font.color', 255, 255, 255),
  'menu.background.alignment': 'leftbottom', 'menu.foreground.alignment': 'leftbottom', 'menu.sidebar.alignment': 'bottom',
  ...rgbAnswers('disable.font.color', 222, 222, 222), ...rgbAnswers('separator.color', 0, 0, 0),
}));
/** etherism's (Satori, ghost/master/dic04_Menu.txt lines 706–739) */
const ETHER_ODM = Object.freeze(Object.entries({
  ...rgbAnswers('background.font.color', 252, 252, 252), ...rgbAnswers('foreground.font.color', 0, 0, 0),
  ...rgbAnswers('disable.font.color', 128, 128, 128), ...rgbAnswers('separator.color', 220, 220, 220),
  'menu.background.alignment': 'bottom', 'menu.foreground.alignment': 'bottom', 'menu.sidebar.alignment': 'bottom',
}));

function walk(dir, pre = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), pre + e.name + '/'));
    else out.push(pre + e.name);
  }
  return out;
}

/** a PNG's size from its IHDR (what the site index records) */
function pngSize(file) {
  const b = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, b, 0, 24, 0); } finally { fs.closeSync(fd); }
  return b.toString('latin1', 12, 16) === 'IHDR' ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
}

/** site/ghost/bthver.5 as the runtime's GhostFiles sees it (no save or profile file is read); `extra` adds entries */
function bthFiles(extra = []) {
  assert.ok(fs.existsSync(path.join(BTH, 'ghost/master/core/resources.txt')), 'site/ghost/bthver.5 is missing');
  const list = walk(BTH).map(p => {
    const s = /\.png$/i.test(p) ? pngSize(path.join(BTH, p)) : null;
    return s ? [p, 1, s.width, s.height] : [p, 1];
  });
  return new GhostFiles(BASE, [...list, ...extra]);
}
const bthDescript = p => parseDescript(decodeText(fs.readFileSync(path.join(BTH, p))));

/** url -> {width, height} of every image the files know */
const sizesOf = files => new Map(files.files.filter(f => f.w).map(f => [files.url(f.path), { width: f.w, height: f.h }]));

/** A fake Image (probeImage): a url of `sizes` loads with that size, any other fails; every load is recorded. */
function fakeImages(sizes) {
  const prev = globalThis.Image;
  const made = [];
  globalThis.Image = class {
    set src(u) {
      this.url = u;
      made.push(u);
      const s = sizes.get(u);
      if (s) Object.assign(this, { naturalWidth: s.width, naturalHeight: s.height });
      setTimeout(() => (s ? this.onload() : this.onerror()), 0);
    }
  };
  return { made, restore: () => { if (prev === undefined) delete globalThis.Image; else globalThis.Image = prev; } };
}

// the probes' 1 × 1 canvases: a background image's top row is (10, 11, 12) and its bottom row (20, 21, 22), a
// foreground's (30, 31, 32) / (40, 41, 42), a sidebar's (50, 51, 52) / (60, 61, 62), anything else white
const EDGE = { background: [[10, 11, 12], [20, 21, 22]], foreground: [[30, 31, 32], [40, 41, 42]], sidebar: [[50, 51, 52], [60, 61, 62]] };
const createElement = globalThis.document.createElement;
globalThis.document.createElement = tag => {
  const el = createElement(tag);
  if (String(tag).toLowerCase() === 'canvas') {
    el.pixels = () => {
      const d = el.getContext('2d').calls.find(c => c[0] === 'drawImage');
      const k = d && Object.keys(EDGE).find(n => String(d[1].url).includes(n));
      return [...(k ? EDGE[k][d[3] === 0 ? 0 : 1] : [255, 255, 255]), 255];
    };
  }
  return el;
};

/** a SHIORI host answering from the Map `answers` (a missing id: 204), its batches recorded */
function odmHost(answers, { delayMs = 0 } = {}) {
  const host = {
    enableLevel: 0, batches: [], answers,
    async resources(ids) {
      host.batches.push([...ids]);
      if (delayMs) await tick(delayMs);
      return new Map(ids.map(id => [id, answers.has(id) ? answers.get(id) : null]));
    },
  };
  return host;
}
/** the menu.* batches (the captions' never start with 'menu.') */
const odmBatches = host => host.batches.filter(b => b.every(id => id.startsWith('menu.')));
const rows = el => el.children.find(c => c.className === 'smk-rows').children.filter(c => c.className === 'smk-row');
const sideOf = el => el.children.find(c => c.className === 'smk-side') || null;
const vars = (el, ...keys) => keys.map(k => el.style[k]);

const bthMenu = (files, host, shell = 'master') => new Menu({
  host, files, shellDir: `shell/${shell}/`, stage: { shell: { descript: bthDescript(`shell/${shell}/descript.txt`) } },
  ghostDescript: bthDescript('ghost/master/descript.txt'), thumbnail: null,
});

test('bthver.5: its SHIORI\'s skin, asked at load and again at every open, from shell/<shell>/menu/ [disasm 0x623730]', needs('site/ghost/bthver.5'), async () => {
  const files = bthFiles([['shell/master/menu/menu_background_2.png', 1, 300, 428]]);
  const img = fakeImages(sizesOf(files));
  try {
    const host = odmHost(new Map(BTH_ODM));
    const m = bthMenu(files, host);
    assert.equal(m.look.background, null, 'neither descript names a menu image');
    await m.loadShioriLook();
    assert.deepEqual(odmBatches(host), FULL_PASS, 'complete through the names: 35 requests');
    host.batches.length = 0;
    await m.open({ scope: 0, x: 10, y: 20 });
    const loads = img.made.length;
    const el = m.el;
    assert.ok(el, 'open');
    assert.deepEqual(odmBatches(host), FULL_PASS, 'every open asks the 35 again (no cache)');
    assert.equal(host.batches.length, 5, 'the gate, the captions, then the look');
    assert.equal(el.style.backgroundImage, `url("${BASE}shell/master/menu/menu_background_1.png")`);
    const side = sideOf(el);
    assert.ok(side, 'its sidebar');
    assert.equal(side.style.backgroundImage, `url("${BASE}shell/master/menu/menu_sidebar_1.png")`);
    assert.deepEqual([el.style['--smk-side-w'], side.style.backgroundPosition, side.style.backgroundColor], ['22px', 'left bottom', 'rgb(50,51,52)']);
    assert.deepEqual(vars(el, '--smk-text', '--smk-hot-text', '--smk-disabled', '--smk-sep'),
      ['rgb(0,0,0)', 'rgb(255,255,255)', 'rgb(222,222,222)', 'rgb(0,0,0)']);
    assert.deepEqual(vars(el, '--smk-bg', '--smk-hot-bg'), ['rgb(10,11,12)', 'rgb(30,31,32)'], 'leftbottom: each fill is its image\'s top pixel');
    assert.deepEqual([m.look.backgroundAlign, m.look.foregroundAlign, m.look.sidebarAlign, m.look.sidebarTopEdge],
      ['left bottom', 'left bottom', 'bottom', true]);
    const row = rows(el)[0];
    row.fire('pointerenter');
    assert.equal(row.style.backgroundImage, `url("${BASE}shell/master/menu/menu_foreground_1.png")`, 'the hot row: the foreground');
    m.close({ restoreFocus: false });
    // a second open: the ghost names another background now, one colour went 204, the separator changed
    host.answers.set('menu.background.bitmap.filename', 'menu\\menu_background_2.png');
    host.answers.delete('menu.disable.font.color.g');
    Object.entries(rgbAnswers('separator.color', 255, 0, 0)).forEach(([k, v]) => host.answers.set(k, v));
    await m.open({ scope: 0, x: 10, y: 20 });
    assert.equal(m.el.style.backgroundImage, `url("${BASE}shell/master/menu/menu_background_2.png")`);
    assert.deepEqual(vars(m.el, '--smk-disabled', '--smk-sep'), ['rgb(222,222,222)', 'rgb(255,0,0)'], 'kept; changed at once');
    assert.deepEqual(img.made.slice(loads), [`${BASE}shell/master/menu/menu_background_2.png`], 'only the new name was loaded');
    m.destroy();
  } finally {
    img.restore();
  }
});

test('etherism: font colours and alignments only: 8 requests at load, none at open, SSP\'s own black-on-white look', async () => {
  const files = new GhostFiles('https://site.test/ghost/etherism/', [['ghost/master/descript.txt', 1], ['shell/master/surface0.png', 1, 100, 100]]);
  const img = fakeImages(sizesOf(files));
  try {
    const host = odmHost(new Map(ETHER_ODM));
    const m = new Menu({ host, files, stage: { shell: { descript: new Map() } }, ghostDescript: new Map(), thumbnail: null });
    await m.loadShioriLook();
    assert.deepEqual(odmBatches(host), [ODM_NAME_IDS, ODM_FILL_IDS], 'incomplete: its font colours are never asked');
    host.batches.length = 0;
    await m.open({ scope: 0, x: 10, y: 20 });
    assert.deepEqual([odmBatches(host), host.batches.length], [[], 2], 'the look\'s gate: only popupmenu.* and the captions');
    assert.deepEqual(vars(m.el, '--smk-text', '--smk-hot-text', '--smk-bg', '--smk-hot-bg', '--smk-sep'),
      ['rgb(0,0,0)', 'rgb(255,255,255)', 'rgb(255,255,255)', 'rgb(0,0,0)', 'rgb(160,160,160)'], 'not 252,252,252 on white');
    assert.equal(m.look.text, null);
    m.destroy();
  } finally {
    img.restore();
  }
});

test('a descript-only look (Tsubasa\'s keys) with a silent SHIORI: 8 requests at load, none at open, drawn from the descripts', async () => {
  const files = new GhostFiles('https://site.test/ghost/x/', [['shell/master/menu_background.png', 1, 300, 600],
    ['shell/master/menu_foreground.png', 1, 300, 600], ['shell/master/menu_sidebar.png', 1, 25, 600]]);
  const descript = new Map(Object.entries({
    'menu.background.bitmap.filename': 'menu_background.png', 'menu.foreground.bitmap.filename': 'menu_foreground.png',
    'menu.sidebar.bitmap.filename': 'menu_sidebar.png', ...rgbAnswers('background.font.color', 15, 0, 0),
    ...rgbAnswers('foreground.font.color', 235, 255, 255), ...rgbAnswers('disable.font.color', 180, 180, 180),
    ...rgbAnswers('separator.color', 244, 73, 71),
  }));
  const img = fakeImages(sizesOf(files));
  const KEYS = ['--smk-text', '--smk-hot-text', '--smk-disabled', '--smk-sep', '--smk-bg', '--smk-hot-bg', '--smk-frame', '--smk-side-w'];
  try {
    const host = odmHost(new Map());
    const m = new Menu({ host, files, stage: { shell: { descript } }, thumbnail: null });
    await m.loadShioriLook();
    assert.deepEqual(odmBatches(host), [ODM_NAME_IDS, ODM_FILL_IDS]);
    host.batches.length = 0;
    await m.open({ scope: 0, x: 10, y: 20 });
    assert.deepEqual(odmBatches(host), []);
    // the same menu without any SHIORI layer (no load pass): what Sumika drew before
    const before = new Menu({ host: odmHost(new Map()), files, stage: { shell: { descript } }, thumbnail: null });
    await before.open({ scope: 0, x: 10, y: 20 });
    assert.deepEqual(vars(m.el, ...KEYS), vars(before.el, ...KEYS));
    assert.deepEqual(vars(m.el, '--smk-text', '--smk-bg'), ['rgb(15,0,0)', 'rgb(20,21,22)'], 'no alignment key: the bottom pixel');
    assert.equal(m.el.style.backgroundImage, 'url("https://site.test/ghost/x/shell/master/menu_background.png")');
    assert.equal(m.el.style.backgroundImage, before.el.style.backgroundImage);
    m.destroy();
    before.destroy();
  } finally {
    img.restore();
  }
});

test('a SHIORI-named image: the shell folder, then ghost/master/, always .png, any case; found nowhere: no image, not SSP\'s look', async () => {
  const BASE3 = 'https://site.test/ghost/y/';
  const files = new GhostFiles(BASE3, [['ghost/master/img/bg.png', 1, 200, 300], ['shell/master/fg.png', 1, 200, 300],
    ['ghost/master/fg.png', 1, 10, 10], ['shell/master/img/bg.bmp', 1]]);
  const img = fakeImages(sizesOf(files));
  try {
    const host = odmHost(new Map([['menu.background.bitmap.filename', 'img\\bg.bmp'], ['menu.foreground.bitmap.filename', 'FG.PNG'],
      ['menu.sidebar.bitmap.filename', 'nothere.png']]));
    const m = new Menu({ host, files, stage: { shell: { descript: new Map() } }, thumbnail: null });
    await m.loadShioriLook();
    await m.open({ scope: 0, x: 10, y: 20 });
    assert.equal(m.el.style.backgroundImage, `url("${BASE3}ghost/master/img/bg.png")`, 'a .bmp name: its .png, in ghost/master');
    rows(m.el)[0].fire('pointerenter');
    assert.equal(rows(m.el)[0].style.backgroundImage, `url("${BASE3}shell/master/fg.png")`, 'the shell folder first');
    assert.equal(sideOf(m.el), null, 'no sidebar image anywhere');
    m.destroy();
    // both names lead nowhere: the pass is complete all the same, so the rows get Windows' colours, not SSP's own look
    const lost = new Menu({ host: odmHost(new Map([['menu.background.bitmap.filename', 'none1.png'], ['menu.foreground.bitmap.filename', '!none2.png']])),
      files, stage: { shell: { descript: new Map() } }, thumbnail: null });
    await lost.loadShioriLook();
    await lost.open({ scope: 0, x: 10, y: 20 });
    assert.ok(!lost.el.style.backgroundImage);
    assert.deepEqual(vars(lost.el, '--smk-bg', '--smk-hot-bg', '--smk-text'), ['rgb(240,240,240)', 'rgb(0,120,215)', 'rgb(0,0,0)']);
    lost.destroy();
  } finally {
    img.restore();
  }
});

test('a shell change asks again (forced, before OnShellChanged: odmReady), looks in the new shell folder, starts the layer over', needs('site/ghost/bthver.5'), async () => {
  const files = bthFiles();
  const img = fakeImages(sizesOf(files));
  try {
    const answers = new Map([...BTH_ODM, ...Object.entries(rgbAnswers('frame.color', 1, 2, 3))]);
    const host = odmHost(answers);
    const m = bthMenu(files, host);
    await m.loadShioriLook();
    await m.open({ scope: 0, x: 10, y: 20 });
    assert.equal(m.el.style['--smk-frame'], 'rgb(1,2,3)');
    for (const c of ['r', 'g', 'b']) answers.delete(`menu.frame.color.${c}`);
    host.batches.length = 0;
    m.setShell({ stage: { shell: { descript: bthDescript('shell/5th-smart/descript.txt') } }, shellDir: 'shell/5th-smart/' });
    assert.equal(m.el, null, 'an open menu closes');
    await m.odmReady;
    assert.deepEqual(odmBatches(host), FULL_PASS);
    await m.open({ scope: 0, x: 10, y: 20 });
    assert.equal(m.el.style.backgroundImage, `url("${BASE}shell/5th-smart/menu/menu_background_1.png")`);
    assert.equal(sideOf(m.el).style.backgroundImage, `url("${BASE}shell/5th-smart/menu/menu_sidebar_1.png")`);
    assert.equal(m.el.style['--smk-frame'], 'rgb(0,0,0)', 'the old shell\'s answer is gone (InitMenuProp)');
    m.destroy();
  } finally {
    img.restore();
  }
});

test('one pass at a time: two opens\' passes and a shell load never interleave their batches', needs('site/ghost/bthver.5'), async () => {
  const files = bthFiles();
  const img = fakeImages(sizesOf(files));
  try {
    const host = odmHost(new Map(BTH_ODM), { delayMs: 2 });
    const m = bthMenu(files, host);
    await m.loadShioriLook();
    host.batches.length = 0;
    await Promise.all([m._odmAtOpen(), m._odmAtOpen()]);
    assert.deepEqual(odmBatches(host), [...FULL_PASS, ...FULL_PASS]);
    // an open right after a shell load waits for the load's pass, then asks on its result
    host.batches.length = 0;
    await Promise.all([m.loadShioriLook(), m._odmAtOpen()]);
    assert.deepEqual(odmBatches(host), [...FULL_PASS, ...FULL_PASS]);
    assert.equal(m._odm.complete, true);
    m.destroy();
  } finally {
    img.restore();
  }
});

test('a menu without a SHIORI host asks nothing and keeps LoadSurface\'s test; a SHIORI that fails counts as no answer', async () => {
  const m = new Menu({ stage: { shell: { descript: new Map() } }, thumbnail: null });
  await m.loadShioriLook();
  assert.equal(m._odm.loaded, false);
  const host = { enableLevel: 0, async resources(ids) { if (ids[0].startsWith('menu.')) throw new Error('gone'); return new Map(); } };
  const f = new Menu({ host, stage: { shell: { descript: new Map() } }, thumbnail: null });
  await f.loadShioriLook();
  await f.open({ scope: 0, x: 10, y: 20 });
  assert.deepEqual([f._odm.complete, f.el.style['--smk-bg']], [false, 'rgb(255,255,255)'], 'SSP\'s own look');
  f.destroy();
});

test('popupmenu.type: a right-click on \\1 asks the gate, then the main menu\'s batch (applybindtoself first); picks carry both scopes [disasm 0x41af93]', needs('site/ghost/bthver.5'), async () => {
  const files = bthFiles();
  const img = fakeImages(sizesOf(files));
  const labelsOf = el => rows(el).map(r => r.__item.label);
  try {
    const host = odmHost(new Map([...BTH_ODM, ['kero.popupmenu.type', '0'], ['utilityrootbutton.caption', '便利機能']]));
    const closes = [];
    host.close = (...a) => closes.push(a);
    const m = bthMenu(files, host);
    await m.loadShioriLook();
    host.batches.length = 0;
    await m.open({ scope: 1, x: 10, y: 20 });
    assert.deepEqual(host.batches[0], ['kero.popupmenu.visible', 'kero.popupmenu.type'], 'the clicked character\'s gate first');
    assert.deepEqual(host.batches[1], ['kero.popupmenu.applybindtoself', ...m._resourceIds(0)], 'then the main menu\'s ids');
    assert.deepEqual(odmBatches(host), FULL_PASS, 'then the look');
    assert.deepEqual([m.scope, m.clicked], [0, 1]);
    assert.ok(labelsOf(m.el).includes('便利機能'), 'the main menu (Utilities ▸)');
    const close = rows(m.el).find(r => r.__item.action && r.__item.action.type === 'close');
    close.fire('click');
    assert.deepEqual(closes, [[0, { window: 1 }]], 'OnClose R1 0, R2 1');
    assert.equal(m.el, null);
    // its own menu (type 1): no applybindtoself, the abbreviated menu's ids
    host.answers.set('kero.popupmenu.type', '1');
    host.batches.length = 0;
    await m.open({ scope: 1, x: 10, y: 20 });
    assert.deepEqual(host.batches.slice(0, 2), [['kero.popupmenu.visible', 'kero.popupmenu.type'], m._resourceIds(1)]);
    assert.deepEqual([m.scope, m.clicked], [1, 1]);
    assert.ok(!labelsOf(m.el).includes('便利機能'));
    m.close({ restoreFocus: false });
    // visible 0: no menu, nothing after the gate
    host.answers.set('kero.popupmenu.visible', '0');
    host.batches.length = 0;
    await m.open({ scope: 1, x: 10, y: 20 });
    assert.deepEqual([m.el, host.batches.length], [null, 1]);
    m.destroy();
  } finally {
    img.restore();
  }
});

// ---------------------------------------------------------------- the real engine [measured]

class NodeKawari extends KawariEngine {
  async factory() { return loadEngineFactory('kawari'); }
}

/** site/ghost/bthver.5 loaded in the real Kawari 8.2.8 build, as the worker would (its text files, the rest placeholders) */
async function bthEngine() {
  assert.ok(fs.existsSync(ENGINE_JS), 'site/sumika/engines/kawari.js is missing: run python engines/kawari/build.py');
  const TEXT = /\.(txt|kis|kaw|dic|ini|csv|dau)$/i;
  const SKIP = /\.(dll|exe|log)$/i;
  const list = walk(BTH);
  const files = list.filter(p => !SKIP.test(p) && TEXT.test(p)).map(p => {
    const b = fs.readFileSync(path.join(BTH, p));
    return { path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  });
  const e = new NodeKawari({
    engineUrl: ENGINE_JS, log: () => {}, onEngineLog: () => {},
    opts: { ghostId: 'bthver.5', placeholders: list.filter(p => !SKIP.test(p) && !TEXT.test(p)),
      site: { ghosts: [{ id: 'bthver.5', name: 'BloodTeaHOUSE ver.5', shiori: 'shiori.dll' }], balloons: [] } },
  });
  await e.boot();
  assert.equal(e.init(files, {}, {}), true, 'bthver.5 loads');
  return e;
}

test('bthver.5 on its real Kawari: the answers ssp.exe gets, and a Menu over an EventLoop draws its skin', needs('site/ghost/bthver.5'), async () => {
  const engine = await bthEngine();
  const sent = [];
  const HEADERS = { Charset: 'UTF-8', Sender: 'SSP', SecurityLevel: 'local' };
  const shiori = { request: async r => { sent.push(r); return parseResponse(engine.request(buildRequest(r, HEADERS))); } };
  const loop = new EventLoop({ shiori, stage: new FakeStage(), clock: new FakeClock(), env: { win: null, doc: null },
    ghost: { id: 'bthver.5', engine: 'kawari' } });
  const res = await loop.resources([...ALL, 'menu.font.name', 'menu.font.height']);
  const want = new Map(BTH_ODM);
  for (const [id, v] of res) assert.equal(v, want.has(id) ? want.get(id) : null, id);
  const files = bthFiles();
  const img = fakeImages(sizesOf(files));
  try {
    const m = bthMenu(files, loop);
    sent.length = 0;
    await m.loadShioriLook();
    assert.deepEqual(sent.map(r => r.id), ALL, '35 requests in SSP\'s order');
    assert.ok(sent.every(r => r.method === 'GET' && r.kind === 'resource' && r.headers.SenderType === 'internal'), 'GetStringShiori\'s');
    sent.length = 0;
    await m.open({ scope: 0, x: 10, y: 20 });
    assert.deepEqual(sent.filter(r => r.id.startsWith('menu.')).map(r => r.id), ALL);
    assert.equal(m.el.style.backgroundImage, `url("${BASE}shell/master/menu/menu_background_1.png")`);
    assert.ok(sideOf(m.el));
    assert.deepEqual(vars(m.el, '--smk-text', '--smk-hot-text', '--smk-disabled', '--smk-sep'),
      ['rgb(0,0,0)', 'rgb(255,255,255)', 'rgb(222,222,222)', 'rgb(0,0,0)']);
    m.destroy();
  } finally {
    img.restore();
  }
});

test('bthver.5 on its real Kawari: \\1 gets its short menu, and the main menu once its Mode is Tea0 (kero.popupmenu.type 1, then 0) [measured]', needs('site/ghost/bthver.5'), async () => {
  const engine = await bthEngine();
  const sent = [];
  const HEADERS = { Charset: 'UTF-8', Sender: 'SSP', SecurityLevel: 'local' };
  const shiori = { request: async r => { sent.push(r); return parseResponse(engine.request(buildRequest(r, HEADERS))); } };
  const loop = new EventLoop({ shiori, stage: new FakeStage(), clock: new FakeClock(), env: { win: null, doc: null },
    ghost: { id: 'bthver.5', engine: 'kawari' } });
  const files = bthFiles();
  const img = fakeImages(sizesOf(files));
  const labelsOf = el => rows(el).map(r => r.__item.label);
  try {
    const m = bthMenu(files, loop);
    await m.loadShioriLook();
    sent.length = 0;
    await m.open({ scope: 1, x: 10, y: 20 });
    assert.deepEqual(sent.slice(0, 3).map(r => r.id), ['kero.popupmenu.visible', 'kero.popupmenu.type', 'kero.recommendrootbutton.visible']);
    assert.deepEqual([m.scope, m.clicked], [1, 1], 'a fresh load answers 1: its own menu');
    assert.ok(labelsOf(m.el).includes('ゴースト終了') && !labelsOf(m.el).includes('便利機能'));
    m.close({ restoreFocus: false });
    // the first boot's door-size answer 通常 sets its Mode to Tea0 (ghost/master/blood/blood_01.txt, 初回引継ぎ分岐)
    const r = await shiori.request({ method: 'GET', id: 'OnChoiceSelect', refs: ['初回導入_通常'] });
    assert.equal(r.status, 200);
    sent.length = 0;
    await m.open({ scope: 1, x: 10, y: 20 });
    assert.deepEqual(sent.slice(0, 5).map(q => q.id), ['kero.popupmenu.visible', 'kero.popupmenu.type',
      'kero.popupmenu.applybindtoself', 'recommendrootbutton.visible', 'sakura.recommendbuttoncaption']);
    assert.deepEqual([m.scope, m.clicked], [0, 1], 'Tea0 answers 0: sakura\'s main menu');
    assert.ok(labelsOf(m.el).includes('便利機能') && labelsOf(m.el).includes('トレイに収める'), 'Utilities ▸ and Iconify: the main menu');
    assert.equal(m.el.style.backgroundImage, `url("${BASE}shell/master/menu/menu_background_1.png")`, 'its skin as before');
    m.destroy();
  } finally {
    img.restore();
  }
});

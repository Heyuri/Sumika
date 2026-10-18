// src/ui/menu.js pure parts: resource IDs, site lists, captions, the menu model (C27, C29; UI §2.1, §2.2, §2.11), the
// shell look, SSP's metrics and colours (UI §2.3), the picks, and the submenu stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  menuResourceIds, parseSiteList, parseCaption, buildMenuModel, menuLook, scopePrefix, Menu, scaleItems,
  shellItems, balloonItems, dressupItems, infoItems, cutName, ghostItems, callItems, menuColors, menuMetrics, menuVars,
  menuTextHeight, devicePx, pixelShadow, menuFontFamily, MENU_FONTS, MENU_FONTS_JA, SSP_DEFAULT_ODM, languageItems,
  alignFlag, menuAccepted, SSP_LOOK, menuExtraWidth, menuInternalLeading, menuSpacing, MENU_TOUCH_ROW,
  ODM_NAME_IDS, ODM_SIDEBAR_ID, ODM_FILL_IDS, ODM_REST_IDS, ODM_DEFAULT_NAMES, odmStem, descriptStem, odmImagePaths,
  colorChannel, odmState, odmPass, menuGateIds, sspWtoul, popupTypeScope, menuTarget, applyBindId, bindScopeOf, askMenu,
} from '../../src/ui/menu.js';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('silent');

const labels = items => items.map(i => (i.kind === 'sep' ? '-' : parseCaption(i.label).text));
const raw = items => items.map(i => (i.kind === 'sep' ? '-' : i.label));
const find = (items, text) => items.find(i => i.kind !== 'sep' && parseCaption(i.label).text === text);

test('resource IDs: legacy and new caption names, per scope prefix', () => {
  const ids = menuResourceIds(0);
  for (const id of ['recommendrootbutton.caption', 'sakura.recommendbuttoncaption', 'sakura.recommendsites',
    'portalrootbutton.caption', 'sakura.portalbuttoncaption', 'sakura.portalsites', 'hidebutton.caption', 'closebutton.visible']) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(menuResourceIds(1).includes('kero.recommendsites'));
  assert.ok(!menuResourceIds(1).includes('sakura.portalsites'));
  assert.equal(scopePrefix(99), 'char99');
  assert.ok(menuResourceIds(99).includes('char99.recommendsites'));
  // the clicked character's popupmenu.* ids are the gate's, asked in a round of their own (menuGateIds, askMenu)
  for (const s of [0, 1, 4]) assert.deepEqual(menuResourceIds(s).filter(id => id.includes('popupmenu')), [], `scope ${s}`);
});

test('resource IDs: every item of SSP\'s menus, legacy names asked first, one batch', () => {
  const ids = menuResourceIds(0);
  for (const id of ['shellrootbutton.caption', 'shellrootbutton.visible', 'dressuprootbutton.caption', 'dressuprootbutton.visible',
    'dressupexplorerbutton.caption', 'balloonrootbutton.caption', 'balloonrootbutton.visible',
    'inforootbutton.caption', 'firststaffbutton.caption', 'readmebuttoncaption', 'readmebutton.caption', 'readmebutton.visible',
    'termsbutton.caption', 'helpbutton.caption', 'aistatebutton.caption', 'rateofusebutton.caption', 'systeminfobutton.caption',
    'charmovebutton.caption', 'charmovebutton.visible', 'quitbutton.caption', 'quitbutton.visible']) {
    assert.ok(ids.includes(id), id);
  }
  const before = (a, b) => assert.ok(ids.indexOf(a) >= 0 && ids.indexOf(a) < ids.indexOf(b), `${a} before ${b}`);
  before('sakura.recommendbuttoncaption', 'recommendrootbutton.caption');
  before('sakura.portalbuttoncaption', 'portalrootbutton.caption');
  before('readmebuttoncaption', 'readmebutton.caption');
  // no Network update or Uninstall item, so their ids are not asked [decision]
  for (const id of ['updatebutton.visible', 'updatebuttoncaption', 'sakura.updatebuttoncaption', 'updatebutton.caption',
    'vanishbuttonvisible', 'vanishbutton.visible', 'vanishbuttoncaption', 'vanishbutton.caption']) assert.ok(!ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length, 'no id twice');
  // Reset passive mode is asked only when the developer functions show it
  assert.ok(!ids.includes('leavepassivebutton.caption'));
  assert.ok(menuResourceIds(0, { devFunctions: true }).includes('leavepassivebutton.caption'));
  // MENU 128: prefixed recommend ids, the table ids unprefixed [disasm]
  const kero = menuResourceIds(1);
  assert.deepEqual(kero.slice(0, 4), ['kero.recommendrootbutton.visible', 'kero.recommendbuttoncaption',
    'kero.recommendrootbutton.caption', 'kero.recommendsites']);
  for (const id of ['dressuprootbutton.caption', 'dressupexplorerbutton.caption', 'charmovebutton.caption', 'closebutton.caption', 'quitbutton.caption']) {
    assert.ok(kero.includes(id), id);
  }
  assert.ok(!kero.includes('recommendrootbutton.caption') && !kero.includes('shellrootbutton.caption') && !kero.includes('inforootbutton.caption'));
  assert.ok(menuResourceIds(7).includes('char7.recommendrootbutton.visible'));
});

test('site lists: \\x02 entries, \\x01 fields, "-" separators, trailing separator', () => {
  const v = 'Home Sweet Home\x01http://macapeng.web.fc2.com\x01http://x/banner.png\x02-\x01\x01\x02Yuuri\x01http://railway.nanika.jp/top.html\x01\x02';
  assert.deepEqual(parseSiteList(v), [
    { title: 'Home Sweet Home', url: 'http://macapeng.web.fc2.com', banner: 'http://x/banner.png', talk: '' },
    { separator: true },
    { title: 'Yuuri', url: 'http://railway.nanika.jp/top.html', banner: '', talk: '' },
  ]);
  assert.deepEqual(parseSiteList(null), []);
  assert.deepEqual(parseSiteList(''), []);
});

test('captions: &X access keys, && literal', () => {
  assert.deepEqual(parseCaption('Hide for a Bit(&R)'), { text: 'Hide for a Bit(R)', key: 'r', parts: [{ text: 'Hide for a Bit(' }, { text: 'R', key: true }, { text: ')' }], accel: null });
  assert.deepEqual(parseCaption('Tom && Jerry'), { text: 'Tom & Jerry', key: null, parts: [{ text: 'Tom & Jerry' }], accel: null });
  assert.equal(parseCaption('&Iconify').key, 'i');
  assert.equal(parseCaption('trailing&').text, 'trailing&');
});

test('captions: the text after the last \\t is the accelerator, drawn apart (SSP\'s "Close (&W)\\tCtrl+W") [disasm]', () => {
  assert.deepEqual(parseCaption('Close (&W)\tCtrl+W'), { text: 'Close (W)', key: 'w', parts: [{ text: 'Close (' }, { text: 'W', key: true }, { text: ')' }], accel: 'Ctrl+W' });
  assert.deepEqual([parseCaption('a\tb\tCtrl+&Q').text, parseCaption('a\tb\tCtrl+&Q').accel, parseCaption('a\tb\tCtrl+&Q').key], ['a\tb', 'Ctrl+&Q', null]);
  assert.equal(parseCaption('Hide\t').accel, '');
});

// ---------------------------------------------------------------- the whole menu

const TSUBASA = new Map(Object.entries({
  'recommendrootbutton.caption': 'Ghost Friends(&P)',
  'sakura.recommendsites': 'A\x01http://a.example/\x01\x02-\x01\x01\x02B\x01http://b.example/\x01\x02',
  'portalrootbutton.caption': 'The Basics(&R)',
  'sakura.portalsites': 'Home\x01http://h.example/\x01\x02',
  'updatebutton.visible': '1', 'updatebutton.caption': 'Do My Homework(&U)',
  'vanishbutton.visible': '1', 'vanishbutton.caption': 'Say Goodbye(&F)',
  'readmebutton.caption': 'About the Current Shell(&R)',
  'dressuprootbutton.visible': '1', 'dressuprootbutton.caption': 'Dress-up(&C)',
  'hidebutton.caption': 'Hide for a Bit(&R)',
}));
const DRESSUP = {
  mode: 'manual', enabled: true, entries: [
    { type: 'part', id: 0, category: '髪', part: 'ポニーテール', on: true },
    { type: 'part', id: 1, category: '髪', part: 'ツインテール', on: false },
    { type: 'sep' },
    { type: 'part', id: 51, category: '服', part: 'R&B', on: false },
    { type: 'menu', name: 'Hats & caps', entries: [{ type: 'part', id: 7, category: '帽子', part: '麦藁帽子', on: false }, { type: 'sep' }] },
  ],
};
const FULL = {
  ghosts: [{ id: 'tsubasa', name: 'Hayama-san Next Door', current: true }, { id: 'testghost', name: 'Test Ghost' }],
  scaling: { shell: null, balloon: null, dpr: 1 },
  languagePref: 'system',
  shells: [{ id: 'master', name: 'master', current: true }],
  balloons: { top: [], all: [{ id: 'LightBlue', name: 'LightBlue', current: true }, { id: 'sumika', name: 'Sumika' }] },
  dressup: DRESSUP,
  info: { readme: true, terms: false },
  carry: true,
};

test('model: the full main menu in SSP\'s order (MENU 102 + Move character window), English and Japanese', () => {
  const en = buildMenuModel(0, TSUBASA, { ...FULL, lang: 'en' });
  assert.deepEqual(labels(en), ['Ghost Friends(P)', 'The Basics(R)', '-',
    'Shell scaling', 'Balloon scaling (D)', 'Utilities (F)', '-',
    'Change ghost', 'Shell', 'Dress-up(C)', 'Balloon', '-',
    'Information', 'Language', 'Hide for a Bit(R)', '-',
    'Move character window', '-',
    'Close (W)', 'Quit (X)']);
  const ja = buildMenuModel(0, TSUBASA, { ...FULL, lang: 'ja' });
  assert.deepEqual(labels(ja), ['Ghost Friends(P)', 'The Basics(R)', '-',
    'シェル倍率(E)', 'バルーン倍率(D)', '機能(F)', '-',
    'ゴースト切り替え(G)', 'シェル(S)', 'Dress-up(C)', 'バルーン(B)', '-',
    '情報(A)', 'Language', 'Hide for a Bit(R)', '-',
    'ゴースト本体移動', '-',
    '終了(W)', '全て終了(X)']);
  // no Network update or Uninstall, even with the ghost's captions [decision]; nothing greyed
  assert.deepEqual(en.filter(i => i.disabled).map(i => parseCaption(i.label).text), []);
  assert.equal(find(en, 'The Basics(R)').lang, '');
  assert.deepEqual(['Move character window', 'Close (W)', 'Quit (X)'].map(l => find(en, l).action.type), ['carry', 'close', 'quit']);
  // our own captions where the ghost gives none
  const plain = buildMenuModel(0, new Map(), { ...FULL, lang: 'en' });
  assert.deepEqual(labels(plain).slice(0, 3), ['Recommendations', 'Portal site', '-']);
  assert.deepEqual(labels(plain).slice(7, 11), ['Change ghost', 'Shell', 'Clothes/Dressup', 'Balloon']);
  assert.equal(find(plain, 'Information').items.length, 8);
});

test('model: none of Sumika\'s own captions has SSP\'s accelerator (Ctrl+I / W / Q …): no Ctrl shortcut is handled (UI §2.11)', () => {
  const walk = items => items.flatMap(i => (i.kind === 'sep' ? [] : [i, ...(i.kind === 'sub' ? walk(i.items) : [])]));
  for (const lang of ['en', 'ja']) {
    const all = [...walk(buildMenuModel(0, new Map(), { ...FULL, lang, devFunctions: true })), ...walk(buildMenuModel(1, new Map(), { ...FULL, lang }))];
    assert.ok(all.length > 30);
    for (const i of all) assert.equal(parseCaption(i.label).accel, null, i.label);
  }
  // a ghost's caption may bring one; it is drawn as SSP draws it, right-aligned (the DOM test in balloon/dom.test.mjs)
  const own = buildMenuModel(0, new Map([['hidebutton.caption', 'Hide(&H)\tAlt+H']]), { ...FULL, lang: 'en' });
  assert.equal(parseCaption(find(own, 'Hide(H)').label).accel, 'Alt+H');
});

test('model: the abbreviated menu (MENU 128): Recommendations ▸ with prefixed ids, Clothes/Dressup ▸, Move, Close, Quit', () => {
  const res = new Map([
    ['kero.recommendrootbutton.caption', 'Kero\'s sites(&K)'], ['kero.recommendsites', 'K\x01http://k/\x01\x02'],
    ['recommendrootbutton.caption', 'the main menu\'s'], ['recommendrootbutton.visible', '0'], ['dressuprootbutton.caption', 'Dress-up(&C)'],
  ]);
  const kero = buildMenuModel(1, res, { dressup: { mode: 'manual', enabled: true, entries: [{ type: 'sep' }] }, carry: true });
  assert.deepEqual(labels(kero), ['Kero\'s sites(K)', 'Dress-up(C)', '-', 'Move character window', '-', 'Close', 'Quit (X)']);
  assert.equal(kero[0].disabled, false, 'the main menu\'s recommendrootbutton.visible is not this one\'s');
  assert.deepEqual(labels(kero[1].items), ['Dressup explorer'], 'a scope with only menuitem0,-: enabled, the greyed Explorer');
  assert.deepEqual([kero[1].disabled, kero[1].items[0].disabled], [false, true]);
  // the legacy name first, then the prefixed new one; the prefixed visible greys
  const legacy = buildMenuModel(1, new Map([['kero.recommendbuttoncaption', 'Old(&O)'], ['kero.recommendrootbutton.caption', 'New(&N)'],
    ['kero.recommendrootbutton.visible', '0'], ['kero.recommendsites', 'K\x01http://k/\x01\x02']]));
  assert.deepEqual([legacy[0].label, legacy[0].disabled], ['Old(&O)', true]);
  // \p[n]: char<n>. prefix; no list: greyed (not left out)
  const c5 = buildMenuModel(5, new Map([['char5.recommendsites', 'X\x01http://x/\x01\x02']]));
  assert.deepEqual([labels(c5), c5[0].disabled], [['Recommendations', '-', 'Close', 'Quit (X)'], false]);
  assert.deepEqual([labels(buildMenuModel(5, new Map())), buildMenuModel(5, new Map())[0].disabled], [['Recommendations', '-', 'Close', 'Quit (X)'], true]);
  assert.equal(menuTarget(1, new Map([['kero.popupmenu.visible', '0']])).visible, false, 'popupmenu.visible 0: no menu at all');
});

test('model: *.visible 0 greys an item in place (Change ghost ▸, Iconify, Close stay, disabled); the gate\'s popupmenu.visible 0 hides the menu', () => {
  const res = new Map(Object.entries({
    'recommendrootbutton.visible': '0', 'sakura.recommendsites': 'A\x01http://a/\x01\x02',
    'ghostrootbutton.visible': '0', 'hidebutton.visible': '0', 'closebutton.visible': '0', 'quitbutton.visible': ' 0 ',
    'utilityrootbutton.visible': '0', 'charmovebutton.visible': '0', 'shellrootbutton.visible': '0', 'balloonrootbutton.visible': '0',
    'inforootbutton.visible': '0', 'dressuprootbutton.visible': '0',
  }));
  const m = buildMenuModel(0, res, FULL);
  assert.deepEqual(labels(m), labels(buildMenuModel(0, new Map(), FULL)), 'the same items in the same places');
  for (const l of ['Recommendations', 'Change ghost', 'Iconify', 'Close (W)', 'Quit (X)', 'Utilities (F)', 'Move character window',
    'Shell', 'Balloon', 'Information', 'Clothes/Dressup']) {
    assert.equal(find(m, l).disabled, true, l);
  }
  assert.equal(find(m, 'Portal site').disabled, true, 'no portal list: greyed');
  assert.equal(menuTarget(0, new Map([['sakura.popupmenu.visible', '0']])).visible, false);
  // a visible of 1 or no answer keeps it enabled
  const on = buildMenuModel(0, new Map([['hidebutton.visible', '1'], ['sakura.recommendsites', 'A\x01http://a/\x01\x02']]));
  assert.deepEqual([find(on, 'Iconify').disabled, find(on, 'Recommendations').disabled], [false, false]);
  const amp = buildMenuModel(0, new Map([['sakura.recommendsites', 'Tom & Jerry\x01http://t/\x01\x02']]));
  assert.equal(parseCaption(amp[0].items[0].label).text, 'Tom & Jerry');
});

// ---------------------------------------------------------------- which menu a click opens (UI §2.1 notes)

test('gate: the clicked character\'s popupmenu.visible, then .type, every open [disasm 2.9.10 OnCWContextMenuSSP 0x41af2c..0x41b014]', () => {
  assert.deepEqual(menuGateIds(0), ['sakura.popupmenu.visible', 'sakura.popupmenu.type']);
  assert.deepEqual(menuGateIds(1), ['kero.popupmenu.visible', 'kero.popupmenu.type']);
  assert.deepEqual(menuGateIds(4), ['char4.popupmenu.visible', 'char4.popupmenu.type']);
  assert.deepEqual([applyBindId(0), applyBindId(1), applyBindId(3)],
    ['sakura.popupmenu.applybindtoself', 'kero.popupmenu.applybindtoself', 'char3.popupmenu.applybindtoself']);
});

test('popupmenu.type read as ssp.exe reads it: sakura / kero words, char<n>, else wtoul (any other word: 0) [disasm 0x41b019..0x41b06e, 0x5ae280]', () => {
  const cases = [
    [null, null], [undefined, null], ['', null],
    ['sakura', 0], ['SAKURA', 0], ['kero', 1], ['Kero', 1],
    ['char2', 2], ['CHAR10', 10], ['char', 0], ['charkero', 0], ['char 3', 3],
    ['0', 0], ['1', 1], [' 1', 1], ['\u30001', 1], ['\t2', 2], ['\n2', 2],
    ['0x1', 1], ['0X2', 2], ['0x0x3', 3], ['0x', 0], ['+1', 1], ['1abc', 1], ['007', 7],
    ['abc', 0], ['full', 0], ['kero ', 0], [' kero', 0], [' ', 0],
    ['-1', 4294967295], ['-0', 0], ['4294967295', 4294967295], ['99999999999', 4294967295],
  ];
  for (const [v, want] of cases) assert.equal(popupTypeScope(v), want, JSON.stringify(v));
  assert.equal(sspWtoul('  \u3000\t0x1F'), 31);
  assert.equal(sspWtoul('-0x10'), 0, 'the sign comes after wtoul_impl\'s 0x test: base 10 reads "-0"');
  assert.equal(sspWtoul('0x-10'), 4294967280);
});

test('menuTarget: ParseBool visible (default shown); type names whose menu, when that window exists, else the clicked one\'s [disasm 0x41b082..0x41b098]', () => {
  const g = (clicked, visible, type) => {
    const p = scopePrefix(clicked);
    return new Map([[`${p}.popupmenu.visible`, visible], [`${p}.popupmenu.type`, type]]);
  };
  assert.deepEqual(menuTarget(1, g(1, null, '0')), { visible: true, target: 0 });
  assert.deepEqual(menuTarget(1, g(1, null, 'sakura')), { visible: true, target: 0 });
  assert.deepEqual(menuTarget(1, g(1, null, '1')), { visible: true, target: 1 });
  assert.deepEqual(menuTarget(1, g(1, null, null)), { visible: true, target: 1 });
  assert.deepEqual(menuTarget(0, g(0, null, '1')), { visible: true, target: 1 }, 'sakura can get the kero window\'s menu');
  assert.deepEqual(menuTarget(0, new Map()), { visible: true, target: 0 });
  // \p[n]: only a window that exists (GetCharWnd); out of range or never made: the clicked one's own
  assert.deepEqual(menuTarget(1, g(1, null, '2')), { visible: true, target: 1 });
  assert.deepEqual(menuTarget(1, g(1, null, '2'), s => s <= 2), { visible: true, target: 2 });
  assert.deepEqual(menuTarget(1, g(1, null, 'char2'), s => s <= 2), { visible: true, target: 2 });
  assert.deepEqual(menuTarget(1, g(1, null, '5')), { visible: true, target: 1 });
  assert.deepEqual(menuTarget(1, g(1, null, '-1')), { visible: true, target: 1 });
  assert.deepEqual(menuTarget(3, g(3, null, 'full'), s => s <= 3), { visible: true, target: 0 }, 'any other word: 0, the main menu');
  for (const v of ['0', 'false', 'off', ' 0 ', 'none', 'NO', 'disabled', '00']) assert.equal(menuTarget(1, g(1, v, null)).visible, false, v);
  for (const v of ['abc', '1', null, '', 'true', '2']) assert.equal(menuTarget(1, g(1, v, null)).visible, true, String(v));
  assert.deepEqual(menuTarget(1, g(1, '0', '0')), { visible: false, target: 0 }, 'type is read whatever visible says');
  // a plain object answers too
  assert.deepEqual(menuTarget(1, { 'kero.popupmenu.type': 'sakura' }), { visible: true, target: 0 });
});

test('bindScopeOf: the menu\'s own character asks nothing; another\'s: ParseBool of the clicked one\'s applybindtoself, default 1 [disasm 0x41cca0]', () => {
  assert.equal(bindScopeOf(0, 0, new Map([['sakura.popupmenu.applybindtoself', '0']])), 0);
  assert.equal(bindScopeOf(1, 1, new Map([['kero.popupmenu.applybindtoself', '0']])), 1);
  const ab = v => new Map([['kero.popupmenu.applybindtoself', v]]);
  assert.equal(bindScopeOf(1, 0, new Map()), 1, 'no answer: the clicked character\'s parts');
  assert.equal(bindScopeOf(1, 0, ab('0')), 0);
  assert.equal(bindScopeOf(1, 0, ab('false')), 0);
  assert.equal(bindScopeOf(1, 0, ab('1')), 1);
  assert.equal(bindScopeOf(1, 0, ab('abc')), 1, 'unparsable: the default');
  assert.equal(bindScopeOf(0, 1, new Map([['sakura.popupmenu.applybindtoself', 'off']])), 1);
});

test('askMenu: the gate round, then the owner\'s batch (the clicked one\'s applybindtoself first when redirected); none: no menu', async () => {
  const run = async (answers, clicked, o = {}) => {
    const batches = [];
    const ask = async ids => { batches.push([...ids]); return new Map(ids.map(id => [id, answers[id] ?? null])); };
    return { r: await askMenu(ask, clicked, o), batches };
  };
  let { r, batches } = await run({ 'kero.popupmenu.type': '0' }, 1);
  assert.deepEqual(batches, [menuGateIds(1), ['kero.popupmenu.applybindtoself', ...menuResourceIds(0)]]);
  assert.deepEqual([r.target, r.bindScope], [0, 1]);
  assert.equal(r.gate.get('kero.popupmenu.type'), '0');
  ({ r, batches } = await run({ 'kero.popupmenu.type': '1' }, 1));
  assert.deepEqual(batches, [menuGateIds(1), menuResourceIds(1)], 'its own menu: nothing more');
  assert.deepEqual([r.target, r.bindScope], [1, 1]);
  ({ r, batches } = await run({ 'kero.popupmenu.type': '0', 'kero.popupmenu.applybindtoself': '0' }, 1));
  assert.equal(r.bindScope, 0);
  ({ r, batches } = await run({ 'sakura.popupmenu.visible': '0', 'sakura.popupmenu.type': '1' }, 0));
  assert.equal(r, null);
  assert.deepEqual(batches, [menuGateIds(0)], 'no menu: nothing after the gate');
  // ids: the Menu's own lists; has: its windows
  ({ r, batches } = await run({ 'kero.popupmenu.type': 'char2' }, 1, { has: s => s === 2, ids: s => [`ids-of-${s}`] }));
  assert.deepEqual(batches[1], ['kero.popupmenu.applybindtoself', 'ids-of-2']);
  // a newer open between the rounds: dropped
  let live = true;
  const late = askMenu(async ids => { live = false; return new Map(ids.map(id => [id, null])); }, 0, { live: () => live });
  assert.equal(await late, null);
  // a failing SHIORI: no answers (its own menu, shown)
  const failing = await askMenu(async () => { throw new Error('gone'); }, 1);
  assert.deepEqual([failing.target, failing.bindScope, failing.res.size], [1, 1, 0]);
});

test('model: dressupScope puts another character\'s parts in Clothes/Dressup ▸; the root follows `enabled`; no null for popupmenu.visible', () => {
  const walk = items => items.flatMap(i => (i.kind === 'sub' ? walk(i.items) : [i]));
  const m = buildMenuModel(0, new Map(), { ...FULL, dressupScope: 1 });
  const d = find(m, 'Clothes/Dressup');
  const parts = walk(d.items).filter(i => i.action && i.action.type === 'dressup');
  assert.deepEqual(parts.map(i => [i.action.scope, i.action.id]), [[1, 0], [1, 1], [1, 51], [1, 7]]);
  assert.equal(d.disabled, false);
  assert.equal(find(buildMenuModel(0, new Map(), { ...FULL, dressup: { ...DRESSUP, enabled: false }, dressupScope: 1 }), 'Clothes/Dressup').disabled, true);
  assert.deepEqual(walk(find(buildMenuModel(0, new Map(), FULL), 'Clothes/Dressup').items).filter(i => i.action).map(i => i.action.scope),
    [0, 0, 0, 0], 'default: the menu\'s own scope');
  assert.ok(Array.isArray(buildMenuModel(1, new Map([['kero.popupmenu.visible', '0']]))), 'the gate decided before: always a menu');
});

test('model: legacy caption names win (SSP asks them first) [disasm]', () => {
  const res = new Map(Object.entries({
    'recommendrootbutton.caption': 'New rec(&N)', 'sakura.recommendbuttoncaption': 'Old rec(&O)',
    'sakura.recommendsites': 'A\x01http://a.example/\x01\x02-\x01\x01\x02B\x01http://b.example/\x01\x02',
    'portalrootbutton.caption': 'New portal', 'sakura.portalbuttoncaption': 'Old portal', 'sakura.portalsites': 'H\x01http://h/\x01\x02',
    'readmebutton.caption': 'r2', 'readmebuttoncaption': 'r1',
  }));
  const m = buildMenuModel(0, res, { info: { readme: true } });
  assert.deepEqual(raw(m).slice(0, 3), ['Old rec(&O)', 'Old portal', '-']);
  assert.equal(find(m, 'Information').items[1].label, 'r1');
  const rec = m[0];
  assert.deepEqual(labels(rec.items), ['A', '-', 'B']);
  assert.deepEqual(rec.items[2].action, { type: 'site', kind: 'recommend', title: 'B', url: 'http://b.example/', banner: '', index: 2 });
  assert.equal(m[1].items[0].action.kind, 'portal');
  // the next name when the first is empty
  const next = buildMenuModel(0, new Map([['readmebuttoncaption', ' '], ['readmebutton.caption', 'r2']]), { info: { readme: true } });
  assert.equal(find(next, 'Information').items[1].label, 'r2');
  assert.ok(!labels(m).some(l => /talk/i.test(l)), 'no Talk item');
});

test('model: enable levels: 2 (minimized, induction) and 3 (passive) grey SSP\'s set; Information, Language, Utilities, Close and Quit stay', () => {
  const res = new Map([['sakura.recommendsites', 'A\x01http://a/\x01\x02'], ['sakura.portalsites', 'B\x01http://b/\x01\x02']]);
  const greyed = m => m.filter(i => i.kind !== 'sep' && i.disabled).map(i => parseCaption(i.label).text);
  assert.deepEqual(greyed(buildMenuModel(0, res, { ...FULL, enableLevel: 0 })), []);
  const two = ['Recommendations', 'Portal site', 'Shell scaling', 'Balloon scaling (D)',
    'Change ghost', 'Shell', 'Clothes/Dressup', 'Balloon'];
  assert.deepEqual(greyed(buildMenuModel(0, res, { ...FULL, enableLevel: 2 })), two);
  assert.deepEqual(greyed(buildMenuModel(0, res, { ...FULL, enableLevel: 3 })), [...two, 'Iconify']);
  const kero = buildMenuModel(1, new Map([['kero.recommendsites', 'K\x01http://k/\x01\x02']]), { dressup: DRESSUP, carry: true, enableLevel: 3 });
  assert.deepEqual(greyed(kero), ['Recommendations', 'Clothes/Dressup']);
});

test('Shell ▸: one row per shell by name, checked on the current one, which stays enabled; ghost names never translated', () => {
  const items = shellItems([{ id: 'master', name: 'master', current: true }, { id: 'loligatari', name: '少女語り' }, { id: 'x', name: 'A&B' }]);
  assert.deepEqual(items.map(i => [i.label, i.checked, !!i.disabled, i.lang]), [['master', true, false, ''], ['少女語り', false, false, ''], ['A&&B', false, false, '']]);
  assert.ok(items.every(i => i.radio && !i.toggle), 'SSP\'s dot (ids 6500 + i); one of a set (menuitemradio)');
  assert.deepEqual(items[1].action, { type: 'shell', id: 'loligatari' });
  const m = buildMenuModel(0, new Map([['shellrootbutton.caption', 'これしか持ってません']]), { shells: [{ id: 'master', name: 'master', current: true }] });
  const shell = m.find(i => i.label === 'これしか持ってません');
  assert.deepEqual([shell.lang, shell.disabled, labels(shell.items)], ['', false, ['master']], 'one shell: its one checked item');
  assert.ok(!buildMenuModel(0, new Map()).some(i => i.label === '&Shell'), 'no shell list: no Shell ▸ (older callers)');
  assert.ok(!buildMenuModel(1, new Map(), { shells: FULL.shells }).some(i => i.label === '&Shell'), 'not in the abbreviated menu');
});

test('Balloon ▸: the descript\'s balloons, a separator, every balloon; ✓ on the first copy only; names cut to 25 + "..."', () => {
  const long = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';                       // 26 characters
  const items = balloonItems({
    top: [{ id: 'angel_ladder', name: '天使の梯子', current: true }],
    all: [{ id: 'LightBlue', name: 'LightBlue' }, { id: 'long', name: long }, { id: 'angel_ladder', name: '天使の梯子', current: true }],
  });
  assert.deepEqual(raw(items), ['天使の梯子', '-', 'LightBlue', 'ABCDEFGHIJKLMNOPQRSTUVWXY...', '天使の梯子']);
  assert.deepEqual(items.filter(i => i.kind !== 'sep').map(i => i.checked), [true, false, false, false]);
  assert.ok(items.every(i => i.kind === 'sep' || (!i.disabled && i.lang === '')), 'every row enabled, the current one included');
  assert.equal(items[3].title, long, 'the whole name as the tooltip');
  assert.deepEqual(items[4].action, { type: 'balloon', id: 'angel_ladder' });
  assert.equal(cutName('x'.repeat(25)), 'x'.repeat(25));
  assert.equal(cutName('x'.repeat(24) + '😀'), 'x'.repeat(24) + '...', 'never half a surrogate pair');
  // Tsubasa: no descript keys → no top group
  assert.deepEqual(raw(balloonItems({ top: [], all: [{ id: 'LightBlue', name: 'LightBlue', current: true }, { id: 'sumika', name: 'Sumika' }] })), ['LightBlue', 'Sumika']);
  const m = buildMenuModel(0, new Map(), { balloons: { top: [], all: [] }, lang: 'ja' });
  assert.equal(m.find(i => i.label === 'バルーン(&B)').items.length, 0, 'an empty list draws greyed');
});

test('Clothes/Dressup ▸ manual: Explorer greyed, separator, "category - part" in menuitem order, ✓ toggles, menuitemex submenus', () => {
  const m = buildMenuModel(0, TSUBASA, { dressup: DRESSUP, lang: 'en' });
  const d = m.find(i => i.label === 'Dress-up(&C)');
  assert.deepEqual(raw(d.items), ['Dressup &explorer', '-', '髪 - ポニーテール', '髪 - ツインテール', '-', '服 - R&&B', 'Hats && caps']);
  assert.equal(d.items[0].disabled, true);
  assert.equal(d.items[0].action, undefined);
  const part = d.items[2];
  assert.deepEqual([part.checked, part.toggle, part.lang, part.action], [true, true, '', { type: 'dressup', scope: 0, id: 0 }]);
  assert.equal(d.items[3].checked, false);
  assert.equal(parseCaption(d.items[5].label).text, '服 - R&B');
  const ex = d.items[6];
  assert.deepEqual([ex.kind, labels(ex.items)], ['sub', ['帽子 - 麦藁帽子']], 'a menuitemex submenu; its trailing separator tidied');
  assert.equal(buildMenuModel(0, new Map([['dressupexplorerbutton.caption', 'Wardrobe(&W)']]), { dressup: DRESSUP }).find(i => i.kind === 'sub' && i.label === '&Clothes/Dressup').items[0].label,
    'Wardrobe(&W)');
  // the abbreviated menu's dress-up is the clicked scope's
  assert.deepEqual(dressupItems(DRESSUP, 3)[0].action, { type: 'dressup', scope: 3, id: 0 });
});

test('Clothes/Dressup ▸ auto: multi-part categories as submenus first, a separator, then single parts flat; hidden; disabled root', () => {
  const auto = { mode: 'auto', enabled: true, entries: [
    { type: 'category', category: 'Hair', on: true, parts: [{ id: 0, part: 'Pony', on: true }, { id: 1, part: 'Twin', on: false }] },
    { type: 'category', category: 'Hat', on: false, parts: [{ id: 2, part: 'hat', on: false }] },
    { type: 'category', category: 'Ribbon', on: true, parts: [{ id: 3, part: 'Red', on: true }] },
    { type: 'category', category: 'Shoes', on: false, parts: [{ id: 4, part: 'Boots', on: false }, { id: 5, part: 'Sandals', on: false }] },
  ] };
  const items = dressupItems(auto, 0);
  assert.deepEqual(raw(items), ['Hair', 'Shoes', '-', 'hat', 'Ribbon - Red']);
  assert.deepEqual([items[0].kind, items[0].checked, raw(items[0].items), items[0].items.map(i => i.checked)], ['sub', true, ['Pony', 'Twin'], [true, false]]);
  assert.equal(items[1].checked, false);
  assert.deepEqual(items[4].action, { type: 'dressup', scope: 0, id: 3 });
  // one category: all flat
  const one = dressupItems({ mode: 'auto', enabled: true, entries: [auto.entries[0]] });
  assert.deepEqual(raw(one), ['Hair - Pony', 'Hair - Twin']);
  assert.deepEqual(dressupItems({ mode: 'hidden', enabled: false, entries: [] }), []);
  const hidden = buildMenuModel(0, new Map(), { dressup: { mode: 'hidden', enabled: false, entries: [] } });
  const root = hidden.find(i => i.label === '&Clothes/Dressup');
  assert.deepEqual([root.disabled, labels(root.items)], [true, ['Dressup explorer']]);
  const none = buildMenuModel(0, new Map(), { dressup: { mode: 'manual', enabled: false, entries: [] } });
  assert.equal(none.find(i => i.label === '&Clothes/Dressup').disabled, true, 'no bind groups / no menuitem line: greyed');
  assert.ok(!buildMenuModel(0, new Map()).some(i => i.label === '&Clothes/Dressup'), 'no dress-up data: no submenu (older callers)');
});

test('Information ▸: About Sumika, About this ghost (greyed without a readme), Terms (greyed without terms), the rest greyed', () => {
  const items = infoItems({ readme: true, terms: false }, TSUBASA, 'en');
  assert.deepEqual(labels(items), ['About Sumika...', 'About the Current Shell(R)', 'Terms of this ghost...', 'Help', '-',
    'AI graph', 'Ghost usage statistics (R)', 'Output system information']);
  assert.deepEqual(items.filter(i => i.kind !== 'sep').map(i => !!i.disabled), [false, false, true, true, true, true, true]);
  assert.deepEqual(items.filter(i => i.action).map(i => i.action.type), ['about', 'readme', 'terms']);
  assert.equal(items[1].lang, '', 'her caption: the ghost\'s text');
  const ja = infoItems({ readme: false, terms: true }, new Map([['firststaffbutton.caption', 'Credits(&C)']]), 'ja');
  assert.deepEqual(labels(ja), ['Credits(C)', 'キャラクタについて(G)', 'キャラクタの利用条件(T)', '説明書(H)', '-', 'AIグラフ(I)', '使用頻度表示(R)', 'システム情報を書出(S)']);
  assert.deepEqual([ja[1].disabled, ja[2].disabled], [true, false]);
  assert.equal(infoItems({ readme: true }, new Map([['readmebutton.visible', '0']]))[1].disabled, true);
  const m = buildMenuModel(0, new Map(), { info: { readme: true }, enableLevel: 3 });
  assert.equal(m.find(i => i.label === 'Inform&ation').disabled, false, 'Information stays enabled in passive mode');
  assert.ok(!buildMenuModel(0, new Map()).some(i => i.label === 'Inform&ation'), 'no info: no submenu (older callers)');
});

test('Utilities ▸: Reset passive mode (and its separator) only with the developer functions', () => {
  const plain = buildMenuModel(0, new Map());
  assert.deepEqual(labels(plain.find(i => i.label === 'Utilities (&F)').items), ['Reset shell position']);
  const dev = buildMenuModel(0, new Map([['leavepassivebutton.caption', 'Wake up(&W)']]), { devFunctions: true, lang: 'ja' });
  const u = dev.find(i => i.label === '機能(&F)');
  assert.deepEqual(labels(u.items), ['Wake up(W)', '-', 'シェル位置初期化(H)']);
  assert.deepEqual(u.items.filter(i => i.action).map(i => i.action.type), ['leavepassive', 'reset']);
  assert.deepEqual(labels(buildMenuModel(0, new Map(), { devFunctions: true }).find(i => i.label === 'Utilities (&F)').items)[0], 'Reset passive mode');
  assert.equal(find(buildMenuModel(0, new Map([['resettodefaultbutton.visible', '0']])), 'Utilities (F)').items[0].disabled, true);
});

test('Options ▸ Preferences… (UI §2.13): right after Utilities ▸ with the Preferences box, absent without; SSP\'s captions', () => {
  const en = buildMenuModel(0, TSUBASA, { ...FULL, lang: 'en', preferences: true });
  assert.deepEqual(labels(en).slice(3, 8), ['Shell scaling', 'Balloon scaling (D)', 'Utilities (F)', 'Options', '-']);
  const options = find(en, 'Options');
  assert.deepEqual([options.kind, options.label, options.disabled, labels(options.items)], ['sub', '&Options', false, ['Preferences...']]);
  assert.deepEqual([options.items[0].label, options.items[0].disabled, options.items[0].action], ['&Preferences...', false, { type: 'preferences' }]);
  const ja = buildMenuModel(0, TSUBASA, { ...FULL, lang: 'ja', preferences: true });
  assert.deepEqual(labels(ja).slice(5, 7), ['機能(F)', '設定(O)']);
  assert.deepEqual(labels(find(ja, '設定(O)').items), ['本体設定...(P)']);
  // without the box: no Options ▸
  assert.deepEqual(labels(buildMenuModel(0, TSUBASA, { ...FULL, lang: 'en' })).slice(5, 7), ['Utilities (F)', '-']);
  // the abbreviated menu has none (MENU 128)
  assert.ok(!labels(buildMenuModel(1, new Map(), { preferences: true })).includes('Options'));
  // the enable levels leave it enabled (not in GetEnableState's list) [infer]
  assert.equal(find(buildMenuModel(0, new Map(), { preferences: true, enableLevel: 3 }), 'Options').disabled, false);
});

test('Options ▸: the ghost\'s captions (configurationrootbutton / configurationbutton), visible 0 greys in place', () => {
  const own = buildMenuModel(0, new Map([['configurationrootbutton.caption', 'Settings(&S)'], ['configurationbutton.caption', 'Base(&B)']]),
    { preferences: true });
  const root = find(own, 'Settings(S)');
  assert.deepEqual([root.lang, root.items[0].label, root.items[0].lang, root.items[0].action.type], ['', 'Base(&B)', '', 'preferences']);
  const greyRoot = buildMenuModel(0, new Map([['configurationrootbutton.visible', '0']]), { preferences: true });
  assert.deepEqual([find(greyRoot, 'Options').disabled, find(greyRoot, 'Options').items[0].disabled], [true, false]);
  const greyItem = buildMenuModel(0, new Map([['configurationbutton.visible', ' 0 ']]), { preferences: true });
  assert.deepEqual([find(greyItem, 'Options').disabled, find(greyItem, 'Options').items[0].disabled], [false, true]);
  assert.deepEqual(labels(greyItem), labels(buildMenuModel(0, new Map(), { preferences: true })), 'greyed, not gone');
});

test('Options ▸ resource ids: root then item, visible before caption, after Utilities ▸\'s, only with the box [res]', () => {
  const ids = menuResourceIds(0, { preferences: true });
  const cfg = ['configurationrootbutton.visible', 'configurationrootbutton.caption', 'configurationbutton.visible', 'configurationbutton.caption'];
  const at = ids.indexOf(cfg[0]);
  assert.deepEqual(ids.slice(at, at + 4), cfg);
  assert.equal(ids[at - 1], 'resettodefaultbutton.caption');
  assert.equal(ids[at + 4], 'ghostrootbutton.visible');
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!menuResourceIds(0).some(id => id.startsWith('configuration')), 'no box: not asked');
  assert.ok(!menuResourceIds(1, { preferences: true }).some(id => id.startsWith('configuration')), 'not in the abbreviated menu');
});

test('Options ▸ Preferences… in the Menu: the option shows it, asks its ids, and a pick opens the box', async () => {
  let opened = 0;
  const asked = [];
  const host = { resources: ids => { asked.push(ids); return Promise.resolve(new Map()); } };
  const m = new Menu({ host, preferences: () => { opened++; } });
  assert.equal(m._options(0).preferences, true);
  m.prefetch(0);
  assert.ok(asked[0].includes('configurationbutton.caption'));
  m._run({ type: 'preferences' }, 0);
  assert.equal(opened, 1);
  const bare = new Menu({ host });
  assert.equal(bare._options(0).preferences, false);
  bare.prefetch(0);
  assert.ok(!asked[1].includes('configurationbutton.caption'));
  assert.doesNotThrow(() => bare._run({ type: 'preferences' }, 0));
  assert.doesNotThrow(() => new Menu({ host, preferences: () => { throw new Error('x'); } })._run({ type: 'preferences' }, 0));
});

test('look: images, alignments and colours from the shell descript', () => {
  const d = new Map(Object.entries({
    'menu.background.bitmap.filename': 'menu_background.png', 'menu.foreground.bitmap.filename': 'menu_foreground.png',
    'menu.sidebar.bitmap.filename': 'menu_sidebar.png', 'menu.background.font.color.r': '15', 'menu.background.font.color.g': '0',
    'menu.background.font.color.b': '0', 'menu.foreground.font.color.r': '235', 'menu.foreground.font.color.g': '255',
    'menu.foreground.font.color.b': '255', 'menu.separator.color.r': '244', 'menu.separator.color.g': '73', 'menu.separator.color.b': '71',
    'menu.background.alignment': 'righttop',
  }));
  const l = menuLook(d);
  assert.equal(l.background, 'menu_background.png');
  assert.equal(l.backgroundAlign, 'right top');
  assert.equal(l.foregroundAlign, 'left top');
  assert.equal(l.sidebarAlign, 'bottom');
  assert.equal(l.text, 'rgb(15,0,0)');
  assert.equal(l.hoverText, 'rgb(235,255,255)');
  assert.equal(l.separator, 'rgb(244,73,71)');
  assert.equal(l.disabledText, null);
  assert.equal(menuLook(null).background, null);
});

test('look: the ghost descript\'s menu.* keys under the shell\'s, key by key; menu.font.name / .height; frame and fill colours', () => {
  const ghost = new Map(Object.entries({
    'menu.font.name': 'MS UI Gothic', 'menu.font.height': '-14', 'menu.separator.color.r': '1', 'menu.separator.color.g': '2',
    'menu.separator.color.b': '3', 'menu.background.font.color.r': '9', 'menu.background.font.color.g': '9', 'menu.background.font.color.b': '9',
  }));
  const shell = new Map(Object.entries({ 'menu.font.height': '13', 'menu.separator.color.r': '200', 'menu.frame.color.r': '10',
    'menu.frame.color.g': '20', 'menu.frame.color.b': '30', 'menu.background.color.r': '1', 'menu.background.color.g': '1', 'menu.background.color.b': '1' }));
  const l = menuLook(shell, ghost);
  assert.deepEqual([l.fontName, l.fontHeight], ['MS UI Gothic', 13], 'the shell\'s height wins, the ghost\'s face stays');
  assert.equal(l.separator, 'rgb(200,2,3)', 'per key, as SSP reads them (each channel is a key)');
  assert.deepEqual([l.text, l.frame, l.backgroundColor, l.foregroundColor], ['rgb(9,9,9)', 'rgb(10,20,30)', 'rgb(1,1,1)', null]);
  assert.equal(menuLook(null, ghost).fontHeight, 14, 'the sign is ignored: lfHeight = −|v|');
  for (const [v, want] of [['0', null], ['', null], ['abc', null], ['12px', 12], [' 16 ', 16]]) {
    assert.equal(menuLook(new Map([['menu.font.height', v]])).fontHeight, want, `"${v}"`);
  }
  assert.equal(menuLook(new Map([['menu.font.name', 'x'.repeat(40)]])).fontName.length, 31, 'LOGFONTW\'s 32 with its NUL');
  assert.equal(menuLook(new Map([['menu.font.name', '  ']])).fontName, null);
  assert.equal(menuFontFamily(null), null);
  // GDI links Segoe UI to Tahoma (no kana), then Meiryo UI: ssp.exe's kana on an English Windows [win32 registry]
  assert.equal(MENU_FONTS, '"Segoe UI", "Meiryo UI", "Yu Gothic UI", system-ui, sans-serif');
  assert.ok(MENU_FONTS_JA.startsWith('"Yu Gothic UI", "Meiryo UI", "Segoe UI"'), 'a Japanese Windows\' menu font first');
  assert.equal(menuFontFamily('MS UI Gothic', 'en'), `"MS UI Gothic", ${MENU_FONTS}`);
  assert.equal(menuFontFamily('ＭＳ Ｐゴシック', 'ja'), `"ＭＳ Ｐゴシック", ${MENU_FONTS_JA}`);
  assert.equal(menuFontFamily('a"b\\c\nd'), `"a\\"b\\\\cd", ${MENU_FONTS}`, 'a CSS string');
});

test('colours: SSP\'s own look unless the shell has a background and a foreground (images or colours); the defaults [disasm]', () => {
  const emily = menuLook(new Map(Object.entries({
    'menu.background.bitmap.filename': 'menu/background.png', 'menu.foreground.bitmap.filename': 'menu/foreground.png',
    'menu.background.font.color.r': '0', 'menu.background.font.color.g': '0', 'menu.background.font.color.b': '0',
    'menu.foreground.font.color.r': '192', 'menu.foreground.font.color.g': '192', 'menu.foreground.font.color.b': '192',
    'menu.disable.font.color.r': '128', 'menu.disable.font.color.g': '128', 'menu.disable.font.color.b': '128',
    'menu.separator.color.r': '128', 'menu.separator.color.g': '128', 'menu.separator.color.b': '128',
  })));
  const images = { bg: { edge: 'rgb(255,255,255)' }, fg: { edge: 'rgb(20,20,20)' } };
  assert.deepEqual(menuColors(emily, images), { ssp: false, text: 'rgb(0,0,0)', hotText: 'rgb(192,192,192)', disabled: 'rgb(128,128,128)',
    separator: 'rgb(128,128,128)', bg: 'rgb(255,255,255)', hotBg: 'rgb(20,20,20)', frame: 'rgb(0,0,0)' });
  // Hayato: white text, no disabled or separator colour: (2 × fill + text) / 3, the text colour
  const hayato = menuLook(new Map(Object.entries({ 'menu.background.font.color.r': '255', 'menu.background.font.color.g': '255', 'menu.background.font.color.b': '255' })));
  const h = menuColors(hayato, { bg: { edge: 'rgb(30,60,90)' }, fg: { edge: null } });
  assert.deepEqual([h.disabled, h.separator, h.hotBg, h.hotText], ['rgb(105,125,145)', 'rgb(255,255,255)', 'rgb(0,120,215)', 'rgb(255,255,255)']);
  // colours instead of images; nothing else set: COLOR_MENU / COLOR_MENUTEXT
  const colours = menuLook(new Map(Object.entries({ 'menu.background.color.r': '240', 'menu.background.color.g': '240', 'menu.background.color.b': '240',
    'menu.foreground.color.r': '0', 'menu.foreground.color.g': '0', 'menu.foreground.color.b': '128' })));
  assert.deepEqual(menuColors(colours, {}), { ssp: false, text: 'rgb(0,0,0)', hotText: 'rgb(255,255,255)', disabled: 'rgb(160,160,160)',
    separator: 'rgb(0,0,0)', bg: 'rgb(240,240,240)', hotBg: 'rgb(0,0,128)', frame: 'rgb(0,0,0)' });
  // no shell look, a sidebar alone, a foreground that did not load: SSP's default ODM, its colours over the shell's
  const own = { ssp: true, text: 'rgb(0,0,0)', hotText: 'rgb(255,255,255)', disabled: 'rgb(217,217,217)', separator: 'rgb(160,160,160)',
    bg: 'rgb(255,255,255)', hotBg: 'rgb(0,0,0)', frame: 'rgb(0,0,0)' };
  assert.deepEqual(menuColors(menuLook(null), {}), own);
  assert.deepEqual(menuColors(emily, { bg: images.bg, fg: null, side: { edge: null } }), own);
  assert.deepEqual(SSP_DEFAULT_ODM.disabledText, own.disabled);
  const framed = menuLook(new Map(Object.entries({ 'menu.frame.color.r': '255', 'menu.frame.color.g': '0', 'menu.frame.color.b': '0' })));
  assert.equal(menuColors(framed, {}).frame, 'rgb(255,0,0)', 'the frame colour applies to SSP\'s own look too');
});

test('metrics: only the font follows devicePixelRatio; rows, separators, insets and the arrow are SSP\'s device pixels [disasm]', () => {
  // display scale -> [th, row, cy, arrow a, w] (disasm.md §8 table; row 19 and the 5 × 7 arrow measured at 125 %)
  const want = { 1: [12, 16, 9, 4, 5], 1.25: [15, 19, 10, 4, 5], 1.5: [18, 22, 12, 5, 6], 1.75: [21, 25, 13, 6, 7], 2: [24, 28, 15, 7, 8] };
  for (const [dpr, [th, row, cy, a, w]] of Object.entries(want)) {
    const m = menuMetrics(Number(dpr));
    assert.deepEqual([m.th, m.row, m.cy, m.arrow.a, m.arrow.w], [th, row, cy, a, w], `dpr ${dpr}`);
    assert.deepEqual([m.separator, m.separatorLine, m.inset, m.accelGap], [11, 5, 16, 8], `dpr ${dpr}`);
    const v = menuVars(m);
    assert.equal(v['--smk-fs'], '12px', `9 pt = 12 CSS px at dpr ${dpr}`);
    assert.equal(v['--smk-row'], devicePx(row, Number(dpr)));
  }
  const v = menuVars(menuMetrics(1.25), { side: { width: 24, height: 500 }, bg: { width: 300, height: 728 }, fg: null });
  assert.deepEqual([v['--smk-dp'], v['--smk-row'], v['--smk-sep-h'], v['--smk-sep-y'], v['--smk-inset'], v['--smk-gap']],
    ['0.8px', '15.2px', '8.8px', '4px', '12.8px', '6.4px']);
  assert.deepEqual([v['--smk-side-w'], v['--smk-side-size'], v['--smk-bg-size'], v['--smk-fg-size']], ['19.2px', '19.2px 400px', '240px 582.4px', 'auto'],
    'images 1:1 in device px');
  // a zoom between the steps: the em in whole device px, MulDiv(9, dpi, 72)
  assert.deepEqual([menuTextHeight(1.1), menuTextHeight(1.125), menuTextHeight(3)], [13, 14, 36]);
  assert.equal(menuVars(menuMetrics(1.1))['--smk-row'], devicePx(17, 1.1));
  assert.equal(menuMetrics(0).th, 12, 'no devicePixelRatio: 1');
});

test('metrics: menu.font.height is device px, never scaled; the arrow follows it', () => {
  const at125 = menuMetrics(1.25, { fontHeight: 15 });
  assert.deepEqual([at125.th, at125.row], [15, 19]);
  assert.equal(menuVars(at125)['--smk-fs'], '12px');
  const at1 = menuMetrics(1, { fontHeight: 15 });
  assert.deepEqual([at1.th, at1.row, menuVars(at1)['--smk-fs'], menuVars(at1)['--smk-row']], [15, 19, '15px', '19px']);
  const big = menuMetrics(2, { fontHeight: 30 });
  assert.deepEqual([big.th, big.row, big.arrow.a, big.arrow.w, menuVars(big)['--smk-fs']], [30, 34, 9, 10, '15px']);
  assert.equal(menuTextHeight(1.5, -20), 20);
});

test('metrics: SSP\'s arrow, tick and dot as pixels (the arrow 2-3-4-5-4-3-2 at 125 %, 5 px clear of the right edge)', () => {
  const m = menuMetrics(1.25);
  // arrow pixels are from the row's top-right pixel: x 0 is the last column inside the frame
  const rows = new Map();
  for (const [x, y] of m.arrow.pixels) rows.set(y, [...(rows.get(y) || []), x]);
  assert.deepEqual([...rows.keys()], [7, 8, 9, 10, 11, 12, 13], 'rows top + 7 … top + 13 [measured]');
  assert.deepEqual([...rows.values()].map(xs => xs.length), [2, 3, 4, 5, 4, 3, 2]);
  assert.deepEqual([Math.min(...m.arrow.pixels.map(p => p[0])), Math.max(...m.arrow.pixels.map(p => p[0]))], [-9, -5],
    'columns right − 10 … right − 6: 5 px clear');
  for (const list of [m.tick, m.dot, m.arrow.pixels]) assert.ok(!list.some(([x, y]) => x === 0 && y === 0), 'never on the element\'s own pixel');
  // the check column: centre x = 7 from the row's left, y = cy
  const xs = m.dot.map(p => p[0]);
  const ys = m.dot.map(p => p[1]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), m.dot.length], [3, 10, 6, 13, 52]);
  assert.deepEqual([Math.min(...m.tick.map(p => p[0])), Math.max(...m.tick.map(p => p[0]))], [4, 13]);
  assert.equal(pixelShadow([[1, 2], [-3, 0]], 1.25), '0.8px 1.6px currentColor, -2.4px 0px currentColor');
  assert.equal(pixelShadow([], 1), 'none');
});

test('marks: SSP\'s dot for Change / Call ghost, Shell, Balloon and dress-up parts (ids 6000–59999), the tick elsewhere [disasm]', () => {
  const dot = i => !!(i.radio || i.dot);
  assert.ok(ghostItems(CALLS).every(dot) && callItems(CALLS).every(dot), 'ids 35000 + i / 20000 + i');
  assert.ok(shellItems(FULL.shells).every(dot), 'ids 6500 + i');
  assert.ok(balloonItems({ top: [{ id: 'a', name: 'A' }], all: FULL.balloons.all }).every(i => i.kind === 'sep' || dot(i)), 'ids 50000 + i');
  const parts = dressupItems(DRESSUP).filter(i => i.kind === 'item');
  assert.ok(parts.length && parts.every(i => i.dot && i.toggle && !i.radio), 'ids 13000 + i: still check items (menuitemcheckbox)');
  // the tick: Use System Lang. (5056), an auto dress-up category's submenu row (an auto id ≥ 62899)
  assert.deepEqual(languageItems('en', 'system').filter(i => i.kind !== 'sep').map(dot), [true, true, false]);
  const two = c => ({ type: 'category', category: c, on: true, parts: [{ id: 0, part: 'a', on: true }, { id: 1, part: 'b', on: false }] });
  const auto = dressupItems({ mode: 'auto', enabled: true, entries: [two('Hair'), two('Shoes')] });
  assert.deepEqual([auto[0].kind, auto[0].checked, dot(auto[0]), auto[0].items.every(dot)], ['sub', true, false, true]);
});

test('alignments: SSP\'s GetAlignFlag substrings in any case; no sidebar key: drawn at the bottom, filled with its bottom pixel [disasm]', () => {
  for (const [v, want] of [['lefttop', 'left top'], ['righttop', 'right top'], ['CenterBottom', 'center bottom'], ['center', 'center top'],
    ['bottom', 'left bottom'], ['top', 'left top'], ['rightcenterbottom', 'right bottom'], ['', 'left top'], [undefined, 'left top']]) {
    assert.equal(alignFlag(v), want, String(v));
  }
  const look = o => menuLook(new Map(Object.entries(o)));
  assert.deepEqual([look({ 'menu.background.alignment': 'center' }).backgroundAlign, look({ 'menu.foreground.alignment': 'RIGHT' }).foregroundAlign,
    look({}).backgroundAlign], ['center top', 'right top', 'left top']);
  assert.deepEqual([look({}).sidebarAlign, look({}).sidebarTopEdge], ['bottom', false]);
  const side = v => { const l = look({ 'menu.sidebar.alignment': v }); return [l.sidebarAlign, l.sidebarTopEdge]; };
  assert.deepEqual(['lefttop', 'top', '', 'bottom', 'leftbottom', 'Bottom'].map(side),
    [['top', false], ['top', false], ['top', false], ['bottom', true], ['bottom', true], ['bottom', true]]);
});

test('look: the menu images\' fill pixels are read where SSP\'s SetValues reads them (the top one only with the bottom flag)', async () => {
  const prev = { Image: globalThis.Image, document: globalThis.document };
  const sampled = [];
  globalThis.Image = class {
    set src(u) { this.url = u; this.naturalWidth = 24; this.naturalHeight = 500; setTimeout(() => this.onload(), 0); }
  };
  globalThis.document = { createElement: () => ({ getContext: () => ({
    drawImage: (img, sx, sy) => sampled.push([img.url, sy]), getImageData: () => ({ data: [1, 2, 3, 255] }) }) }) };
  try {
    const files = { has: () => true, url: p => p };
    const open = async d => {
      sampled.length = 0;
      const m = new Menu({ host: {}, files, stage: { shell: { descript: new Map(Object.entries({ 'menu.background.bitmap.filename': 'bg.png',
        'menu.foreground.bitmap.filename': 'fg.png', 'menu.sidebar.bitmap.filename': 'side.png', ...d })) } } });
      const images = await m.images;
      assert.equal(images.side.edge, 'rgb(1,2,3)');
      return Object.fromEntries(sampled.map(([u, y]) => [u.replace(/^shell\/master\/|\.png$/g, ''), y]));
    };
    assert.deepEqual(await open({}), { bg: 499, fg: 499, side: 499 }, 'no keys: every flag 0, the bottom pixels');
    assert.deepEqual(await open({ 'menu.background.alignment': 'leftbottom', 'menu.sidebar.alignment': 'bottom' }), { bg: 0, fg: 499, side: 0 });
    assert.deepEqual(await open({ 'menu.sidebar.alignment': 'lefttop' }), { bg: 499, fg: 499, side: 499 });
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});

test('colours: SSP takes a look as LoadSurface does: a colour counts only while its image did not load; menu.sidebar.color too [disasm]', () => {
  const rgb = (k, r, g, b) => ({ [`${k}.r`]: String(r), [`${k}.g`]: String(g), [`${k}.b`]: String(b) });
  const look = o => menuLook(new Map(Object.entries(o)));
  const both = look({ ...rgb('menu.background.color', 250, 250, 250), ...rgb('menu.foreground.color', 0, 0, 128) });
  const bg = { edge: 'rgb(1,2,3)' };
  const fg = { edge: 'rgb(4,5,6)' };
  assert.equal(menuAccepted(both, {}), true, 'both colours, no images');
  assert.equal(menuAccepted(both, { bg, fg: null }), false, 'a background image that loaded clears its colour\'s flag; no foreground image');
  assert.equal(menuColors(both, { bg, fg: null }).ssp, true, 'so SSP\'s own look');
  assert.equal(menuAccepted(look({}), { bg, fg }), true);
  assert.equal(menuAccepted(look({}), { bg, fg: null }), false);
  const sideOnly = look(rgb('menu.sidebar.color', 10, 20, 30));
  assert.equal(sideOnly.sidebarColor, 'rgb(10,20,30)');
  assert.equal(menuAccepted(sideOnly, {}), true, 'menu.sidebar.color alone: taken');
  assert.deepEqual(menuColors(sideOnly, {}), { ssp: false, text: 'rgb(0,0,0)', hotText: 'rgb(255,255,255)', disabled: 'rgb(160,160,160)',
    separator: 'rgb(0,0,0)', bg: 'rgb(240,240,240)', hotBg: 'rgb(0,120,215)', frame: 'rgb(0,0,0)' }, 'Windows\' colours (COLOR_MENU, COLOR_HIGHLIGHT)');
  assert.equal(menuAccepted(sideOnly, { side: { edge: 'rgb(0,0,0)' } }), false, 'its image loaded: its flag is cleared too');
  assert.equal(menuColors(both, SSP_LOOK).ssp, true, 'SSP_LOOK: SSP\'s own look whatever the descript says');
  assert.equal(menuAccepted(both, SSP_LOOK), true, 'SSP_LOOK carries no images');
});

test('metrics: Windows\' allowance after the caption is 2 × Segoe UI\'s average character width at the display\'s em [win32; font]', () => {
  assert.deepEqual([1, 1.25, 1.5, 1.75, 2].map(d => menuExtraWidth(d)), [14, 16, 20, 24, 26], '16 measured at 125 %');
  assert.equal(menuMetrics(1.25).extra, 16);
  assert.equal(menuMetrics(1, { fontHeight: 30 }).extra, 14, 'Windows\' own menu font, never the descript\'s');
  assert.equal(menuVars(menuMetrics(1.25))['--smk-extra'], '12.8px');
  assert.equal(menuVars(menuMetrics(1.5))['--smk-extra'], devicePx(20, 1.5));
});

test('metrics: the text\'s baseline where SSP puts it (row top + 2 − ⌊IL / 2⌋ + ascent), Blink\'s half-leading rule [disasm; infer]', () => {
  // Segoe UI's internal leading without a canvas: ascent + descent − em, each rounded
  assert.deepEqual([12, 15, 18, 21, 24].map(th => menuInternalLeading(th)), [4, 5, 6, 7, 8]);
  for (const touch of [false, true]) {
    for (const dpr of [1, 1.1, 1.25, 1.5, 1.75, 2, 3]) {
      const th = menuTextHeight(dpr);
      const A = Math.round((th * 2210) / 2048);
      const D = Math.round((th * 514) / 2048);
      const IL = A + D - th;
      const s = menuSpacing(dpr, th, touch);
      const m = menuMetrics(dpr, { leading: IL, spacing: s });
      const v = menuVars(m);
      const lh = Math.round(parseFloat(v['--smk-text-lh']) * dpr);
      const pad = Math.round(parseFloat(v['--smk-text-pt']) * dpr);
      assert.equal(pad + lh, m.row, 'the text\'s box is the row');
      // Blink: the line's half-leading ⌊(line-height − A − D) / 2⌋ above the ascent (CalculateLeadingSpace)
      assert.equal(pad + Math.floor((lh - A - D) / 2) + A, s - Math.floor(IL / 2) + A, `dpr ${dpr}${touch ? ' touch' : ''}`);
    }
  }
  assert.deepEqual([1, 1.25, 1.5, 1.75, 2].map(d => menuMetrics(d, { leading: menuInternalLeading(menuTextHeight(d)) }).textShift), [0, 1, 0, 1, 0]);
  assert.deepEqual([menuMetrics(1.25).textShift, menuVars(menuMetrics(1.25))['--smk-text-pt']], [0, '0px'], 'no leading known: the row');
  // with a canvas: the first available font of the family, measured once per size
  const prev = globalThis.document;
  const fonts = [];
  globalThis.document = { createElement: () => ({ getContext: () => ({
    set font(f) { fonts.push(f); }, measureText: () => ({ width: 30, fontBoundingBoxAscent: 15.6, fontBoundingBoxDescent: 3.2 }) }) }) };
  try {
    assert.equal(menuInternalLeading(15, '"Test Face", sans-serif'), 4, '16 + 3 − 15');
    assert.equal(menuInternalLeading(15, '"Test Face", sans-serif'), 4);
    assert.deepEqual(fonts, ['15px "Test Face", sans-serif']);
  } finally {
    if (prev === undefined) delete globalThis.document; else globalThis.document = prev;
  }
});

test('metrics: a menu opened by a touch gets the least spacing that makes its rows 24 CSS px; SSP\'s 2 otherwise [decision]', () => {
  for (const dpr of [1, 1.25, 2, 2.625, 3]) {
    const th = menuTextHeight(dpr);
    const s = menuSpacing(dpr, th, true);
    const row = menuMetrics(dpr, { spacing: s }).row;
    assert.ok(row / dpr >= MENU_TOUCH_ROW && (s === 2 || (row - 2) / dpr < MENU_TOUCH_ROW), `dpr ${dpr}: row ${row}`);
    assert.equal(menuSpacing(dpr, th, false), 2);
  }
  assert.deepEqual([menuSpacing(3, 36, true), menuMetrics(3, { spacing: 18 }).separator], [18, 43], 'SSP\'s 2 × spacing + 7 separator');
  assert.equal(menuVars(menuMetrics(3, { spacing: menuSpacing(3, 36, true) }))['--smk-row'], '24px');
});

// a menu element for _imageAt / _setHot at devicePixelRatio 1.25: frame 1 device px, a sidebar of `side` device px,
// the list `listW` × `listH` device px (any scrollbar is outside it), the menu box `boxW` wide; rects in CSS px
function imageMenu({ side = 0, listW, listH, boxW = listW + side + 2, left = 100, top = 50 }) {
  const d = 1.25;
  const sideEl = side ? { getBoundingClientRect: () => ({ left: left + 1 / d, width: side / d }) } : null;
  const list = { getBoundingClientRect: () => ({ left: left + (1 + side) / d, top: top + 1 / d, width: listW / d, height: listH / d }) };
  return {
    scrollTop: 0, getBoundingClientRect: () => ({ left, top, width: boxW / d, height: 400 }),
    querySelector: sel => (sel === '.smk-side' ? sideEl : sel === '.smk-rows' ? list : null), querySelectorAll: () => [],
  };
}

test('images: aligned in the area right of the sidebar (SSP\'s DrawItem), over the whole list, without the scrollbar [disasm; measured]', () => {
  const prev = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1.25;
  try {
    const m = new Menu({});
    const bg = { width: 300, height: 728 };
    // emily4 in 8.png: sidebar 24, area 206, her 300-px background centred: image left at −23 (best match)
    assert.deepEqual(m._imageAt(imageMenu({ side: 24, listW: 206, listH: 503 }), bg, 'center top'), { x: -23, y: 0 });
    // Tsubasa (no alignment key: left top): the image starts right of her 25-px sidebar
    assert.deepEqual(m._imageAt(imageMenu({ side: 25, listW: 180, listH: 300 }), bg, 'left top'), { x: 25, y: 0 });
    assert.deepEqual(m._imageAt(imageMenu({ side: 24, listW: 206, listH: 503 }), bg, 'right bottom'), { x: 24 + 206 - 300, y: 503 - 728 });
    // a submenu has no sidebar; a list taller than the viewport scrolls: its whole height, its width without a scrollbar
    assert.deepEqual(m._imageAt(imageMenu({ listW: 160, listH: 1900, boxW: 160 + 2 + 17 }), { width: 100, height: 400 }, 'right bottom'),
      { x: 60, y: 1500 });
    assert.deepEqual(m._imageAt(imageMenu({ listW: 161, listH: 100, boxW: 161 + 2 + 17 }), { width: 100, height: 400 }, 'center top').x, 30);
    assert.deepEqual(m._imageAt(imageMenu({ listW: 150, listH: 100 }), { width: 301, height: 10 }, 'center top').x, -75, '⌊−151 / 2⌋ toward zero');
  } finally {
    globalThis.devicePixelRatio = prev;
  }
});

test('hot row: the foreground image at the background\'s place under it, a greyed row too, in device px', () => {
  const prev = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1.25;
  try {
    const m = new Menu({});
    m.look = menuLook(new Map([['menu.foreground.alignment', 'centertop']]));
    const menuEl = imageMenu({ side: 24, listW: 206, listH: 503 });
    const row = fakeRow(0);
    row.setAttribute('aria-disabled', 'true');
    // the fourth row: 1 + 3 × 19 device px from the menu's top, right of the frame and the sidebar
    row.getBoundingClientRect = () => ({ left: 100 + 25 / 1.25, top: 50 + 58 / 1.25, right: 300, bottom: 50 + 77 / 1.25 });
    menuEl.querySelectorAll = () => [row];
    m._setHot(menuEl, row, { fg: { url: 'blob:fg', width: 300, height: 728 } });
    assert.ok(row.classList.contains('smk-hot'));
    assert.equal(row.style.backgroundImage, 'url("blob:fg")');
    // the image's left at −23 inside the frame, the row's at 24; its top at 0, the row's at 57
    assert.equal(row.style.backgroundPosition, `${devicePx(-23 - 24, 1.25)} ${devicePx(-57, 1.25)}`);
    m._setHot(menuEl, null, { fg: null });
    assert.deepEqual([row.classList.contains('smk-hot'), row.style.backgroundImage], [false, '']);
  } finally {
    globalThis.devicePixelRatio = prev;
  }
});

// ---------------------------------------------------------------- several ghosts: Call ghost ▸ (UI §2.1 #13)

// the site's rows as Tsubasa's menu sees them with Hayato also on screen: her own ✓, Hayato elsewhere, a YAYA ghost
const CALLS = [
  { id: 'tsubasa', name: 'Hayama-san Next Door', current: true, note: null, needs: null },
  { id: 'hayato', name: 'ハヤト', current: false, note: null, needs: null, elsewhere: true },
  { id: 'like_a_cat', name: '猫になった日', current: false, note: null, needs: null },
  { id: 'emily', name: 'Emily & Co', current: false, note: 'needs YAYA', needs: 'YAYA' },
];

test('resource IDs: callghostrootbutton.* right after ghostrootbutton.*, main menu only', () => {
  const ids = menuResourceIds(0);
  const at = ids.indexOf('ghostrootbutton.caption');
  assert.deepEqual(ids.slice(at - 1, at + 3), ['ghostrootbutton.visible', 'ghostrootbutton.caption', 'callghostrootbutton.visible', 'callghostrootbutton.caption']);
  assert.equal(new Set(ids).size, ids.length, 'no id twice');
  for (const scope of [1, 2, 99]) assert.ok(!menuResourceIds(scope).some(id => id.includes('callghost')), `scope ${scope}`);
});

test('Call ghost ▸: right after Change ghost ▸, only when the site gives call rows; SSP\'s captions in both languages', () => {
  const opts = { ...FULL, ghosts: CALLS, calls: CALLS };
  const en = buildMenuModel(0, TSUBASA, { ...opts, lang: 'en' });
  assert.deepEqual(labels(en).slice(6, 13), ['-', 'Change ghost', 'Call ghost (Z)', 'Shell', 'Dress-up(C)', 'Balloon', '-']);
  const ja = buildMenuModel(0, TSUBASA, { ...opts, lang: 'ja' });
  assert.deepEqual(labels(ja).slice(7, 9), ['ゴースト切り替え(G)', '他のゴーストを呼ぶ（Z)'], 'SSP\'s full-width "（"');
  const call = find(ja, '他のゴーストを呼ぶ（Z)');
  assert.deepEqual([call.kind, call.label, call.lang, parseCaption(call.label).key, call.disabled], ['sub', '他のゴーストを呼ぶ（&Z)', undefined, 'z', false]);
  // no rows (one ghost at a time, an older caller): no submenu; never in the abbreviated menu
  assert.ok(!labels(buildMenuModel(0, TSUBASA, { ...FULL, ghosts: CALLS })).includes('Call ghost (Z)'));
  assert.ok(!labels(buildMenuModel(0, TSUBASA, { ...FULL, ghosts: CALLS, calls: null })).includes('Call ghost (Z)'));
  assert.ok(!buildMenuModel(1, new Map(), { ...opts, dressup: DRESSUP }).some(i => i.kind === 'sub' && /Call ghost/.test(i.label)));
  // without Change ghost ▸ rows it still follows Utilities ▸'s separator
  assert.deepEqual(labels(buildMenuModel(0, new Map(), { calls: CALLS })).slice(3, 6), ['Utilities (F)', '-', 'Call ghost (Z)']);
});

test('Call ghost ▸ rows: own ✓ greyed, elsewhere greyed without ✓, needs greyed with its reason; a pick is a callghost', () => {
  const sub = buildMenuModel(0, new Map(), { calls: CALLS, lang: 'en' }).find(i => i.label === 'Call ghost (&Z)');
  assert.deepEqual(sub.items.map(i => [i.label, i.checked, i.disabled, i.note, i.lang]), [
    ['Hayama-san Next Door', true, true, null, ''],
    ['ハヤト', false, true, null, ''],
    ['猫になった日', false, false, null, ''],
    ['Emily && Co', false, true, 'needs YAYA', ''],
  ]);
  assert.deepEqual(sub.items.map(i => i.action), CALLS.map(g => ({ type: 'callghost', id: g.id })));
  assert.equal(callItems(CALLS, 'ja')[3].note, 'YAYAが必要');
  assert.deepEqual(callItems([{ id: 'k', name: 'K', note: 'needs Kawari' }])[0].note, 'needs Kawari', 'a note without needs shows as given');
  assert.deepEqual(callItems([]), []);
});

test('Call ghost ▸ rows while the set is full: every other row greyed with "up to n at once" (n from the rows)', () => {
  const full = CALLS.map(g => ({ ...g, full: true }));
  full[2] = { ...full[2], elsewhere: true };               // three on screen: Tsubasa, Hayato, like_a_cat
  full.push({ id: 'katari', name: 'カタリベカタリ', current: false, note: null, needs: null, full: true });
  const en = callItems(full, 'en');
  assert.deepEqual(en.map(i => [i.disabled, i.note]), [[true, null], [true, null], [true, null], [true, 'needs YAYA'], [true, 'up to 3 at once']]);
  assert.equal(en[4].checked, false);
  assert.deepEqual(callItems(full, 'ja').map(i => i.note), [null, null, null, 'YAYAが必要', '同時に3体まで']);
  // a number is the cap itself
  assert.equal(callItems([{ id: 'a', name: 'A', current: true }, { id: 'b', name: 'B', full: 2 }], 'en')[1].note, 'up to 2 at once');
  // the submenu itself stays enabled (its own ✓ row is greyed, the rest too)
  const m = buildMenuModel(0, new Map(), { calls: full, lang: 'ja' });
  assert.equal(m.find(i => i.label === '他のゴーストを呼ぶ（&Z)').disabled, false);
});

test('Call ghost ▸ greys only with callghostrootbutton.visible 0, not at enable levels 2 / 3 (Change ghost ▸ does)', () => {
  const res = new Map([['callghostrootbutton.caption', 'Invite(&I)']]);
  for (const enableLevel of [0, 2, 3]) {
    const m = buildMenuModel(0, res, { ghosts: CALLS, calls: CALLS, enableLevel });
    const call = m.find(i => i.label === 'Invite(&I)');
    assert.deepEqual([call.lang, call.disabled], ['', false], `level ${enableLevel}`);
    assert.equal(find(m, 'Change ghost').disabled, enableLevel >= 2, `level ${enableLevel}`);
  }
  const off = buildMenuModel(0, new Map([['callghostrootbutton.visible', '0']]), { calls: CALLS });
  assert.equal(find(off, 'Call ghost (Z)').disabled, true, 'greyed in place');
  assert.equal(find(buildMenuModel(0, new Map([['callghostrootbutton.visible', '1']]), { calls: CALLS }), 'Call ghost (Z)').disabled, false);
});

test('Change ghost ▸ with several ghosts: a ghost on screen in another slot is greyed without ✓ or note', () => {
  const items = ghostItems(CALLS, 'en');
  assert.deepEqual(items.map(i => [i.checked, i.disabled, i.note]), [[true, false, null], [false, true, null], [false, false, null], [false, true, 'needs YAYA']]);
  assert.deepEqual(items[1].action, { type: 'ghost', id: 'hayato' });
  // without `elsewhere` the rows are the usual ones
  assert.deepEqual(ghostItems([{ id: 'x', name: 'X' }]), [{ kind: 'item', label: 'X', lang: '', checked: false, radio: true, disabled: false, note: null, action: { type: 'ghost', id: 'x' } }]);
});

test('the menu asks its calls provider each time; a failing or null provider: no Call ghost ▸', () => {
  let asked = 0;
  const m = new Menu({ host: {}, calls: () => { asked++; return CALLS; } });
  assert.equal(m._options(0).calls, CALLS);
  assert.equal(m._options(0).calls, CALLS);
  assert.equal(asked, 2);
  assert.equal(new Menu({ host: {}, calls: () => { throw new Error('x'); } })._options(0).calls, null);
  assert.equal(new Menu({ host: {}, calls: () => null })._options(0).calls, null);
  assert.equal(new Menu({ host: {} })._options(0).calls, null);
});

test('picks: Call ghost ▸ asks callGhost with OnGhostCalling (manual); Quit asks quitAll, Close asks close', () => {
  const calls = [];
  const rec = name => (...a) => { calls.push([name, ...a]); };
  const m = new Menu({ host: { callGhost: rec('callGhost'), quitAll: rec('quitAll'), close: rec('close') } });
  m._run({ type: 'callghost', id: 'hayato' }, 0);
  m._run({ type: 'quit' }, 1);
  m._run({ type: 'quit' }, 0);
  m._run({ type: 'close' }, 1);
  assert.deepEqual(calls, [
    ['callGhost', 'hayato', { byId: true, raiseEvent: true, reason: 'manual', scope: 0 }],
    ['quitAll', 1],
    ['quitAll', 0],
    ['close', 1],
  ]);
  // an event loop without quitAll / callGhost: Quit is Close (one ghost), a call does nothing
  const old = [];
  const bare = new Menu({ host: { close: s => old.push(['close', s]) } });
  bare._run({ type: 'quit' }, 2);
  bare._run({ type: 'callghost', id: 'x' }, 0);
  assert.deepEqual(old, [['close', 2]]);
});

// ---------------------------------------------------------------- picks

test('Reset position puts the characters back and forgets the balloon drag offsets', () => {
  const calls = [];
  const stage = { resetPositions: () => calls.push('characters') };
  const host = { balloons: { resetOffsets: () => calls.push('balloons') } };
  new Menu({ host, stage })._run({ type: 'reset' }, 0);
  assert.deepEqual(calls, ['characters', 'balloons']);
  new Menu({ host: {}, stage })._run({ type: 'reset' }, 0);   // runtimes without balloons still reset the characters
  assert.deepEqual(calls, ['characters', 'balloons', 'characters']);
});

test('picks: Shell ▸, Balloon ▸, Clothes/Dressup ▸, Quit, Reset passive mode and Move character window reach the event loop and stage', () => {
  const calls = [];
  const rec = name => (...a) => { calls.push([name, ...a]); return name === 'changeShell' ? Promise.resolve(true) : false; };
  const host = { changeShell: rec('changeShell'), changeBalloon: rec('changeBalloon'), toggleDressup: rec('toggleDressup'),
    close: rec('close'), setOption: rec('setOption') };
  const stage = { carry: rec('carry') };
  const m = new Menu({ host, stage });
  m._run({ type: 'shell', id: 'alt' }, 0);
  m._run({ type: 'balloon', id: 'sumika' }, 0);
  m._run({ type: 'dressup', scope: 3, id: 7 }, 3);
  m._run({ type: 'quit' }, 1);
  m._run({ type: 'close' }, 0);
  m._run({ type: 'leavepassive' }, 0);
  m._run({ type: 'carry' }, 2);
  assert.deepEqual(calls, [
    ['changeShell', 'alt', { byId: true, raiseEvent: true, scope: 0 }],
    ['changeBalloon', 'sumika', { byId: true, scope: 0 }],
    ['toggleDressup', 3, 7],
    ['close', 1],
    ['close', 0],
    ['setOption', 'leave', ['passivemode']],
    ['setOption', 'leave', ['inductionmode']],
    ['carry', 2],
  ]);
  // an event loop without the new methods: nothing happens, nothing throws
  const bare = new Menu({ host: {} });
  for (const type of ['shell', 'balloon', 'dressup', 'leavepassive', 'carry']) bare._run({ type, id: 'x' }, 0);
});

test('the menu hands the model its providers, the enable level, the stage\'s dress-up and carry', () => {
  const asked = [];
  const stage = { shell: { descript: new Map() }, dressupMenu: s => { asked.push(s); return DRESSUP; }, carry() {} };
  const files = { has: p => p === 'readme.txt' || p === 'terms.txt', resolve: p => p };
  const m = new Menu({
    host: { enableLevel: 3 }, stage, ghosts: () => FULL.ghosts, shells: () => FULL.shells, balloons: () => FULL.balloons,
    info: () => ({ sources: [{ kind: 'ghost', name: 'G', files, descript: new Map() }], version: '1.0.0' }), devFunctions: true,
  });
  const o = m._options(2);
  assert.deepEqual(asked, [2], 'the clicked scope\'s dress-up');
  assert.equal(o.dressup, DRESSUP);
  assert.deepEqual([o.enableLevel, o.carry, o.devFunctions, o.info], [3, true, true, { readme: true, terms: true }]);
  assert.deepEqual([o.shells, o.balloons, o.ghosts], [FULL.shells, FULL.balloons, FULL.ghosts]);
  // failing providers are absent, not fatal; no info provider: no Information ▸
  const broken = new Menu({ host: {}, stage: { dressupMenu() { throw new Error('x'); } }, shells: () => { throw new Error('y'); } });
  const b = broken._options(0);
  assert.deepEqual([b.dressup, b.shells, b.info, b.enableLevel, b.carry, b.devFunctions], [null, null, null, 0, false, false]);
});

test('a redirected menu (popupmenu.type): Clothes/Dressup ▸ greyed by the owner\'s bind data, the bind scope\'s parts [disasm 0x41c9f2, 0x41ede8]', () => {
  const asked = [];
  const KERO = { mode: 'manual', enabled: false, entries: [{ type: 'part', id: 3, category: '帽子', part: '麦藁帽子', on: true }] };
  const stage = { dressupMenu: s => { asked.push(s); return s === 0 ? DRESSUP : KERO; } };
  const m = new Menu({ host: {}, stage });
  const o = m._options(0, 1);
  assert.deepEqual(asked, [0, 1], 'the owner\'s, then the bind scope\'s');
  assert.deepEqual([o.dressup.enabled, o.dressup.entries, o.dressupScope], [true, KERO.entries, 1]);
  const d = find(buildMenuModel(0, new Map(), { ...o, dressup: o.dressup }), 'Clothes/Dressup');
  assert.deepEqual([d.disabled, d.items.filter(i => i.action).map(i => [i.action.scope, i.action.id])], [false, [[1, 3]]]);
  // the other way: kero's own data greys the root, sakura's parts stay listed
  asked.length = 0;
  const k = m._options(1, 0);
  assert.deepEqual([asked, k.dressup.enabled, k.dressup.entries, k.dressupScope], [[1, 0], false, DRESSUP.entries, 0]);
  // its own menu: one ask, dressupScope the same
  asked.length = 0;
  assert.equal(m._options(1).dressupScope, 1);
  assert.deepEqual(asked, [1]);
  // the bind scope's provider failing: no parts, the owner's root state kept
  const half = new Menu({ host: {}, stage: { dressupMenu: s => { if (s) throw new Error('x'); return DRESSUP; } } });
  assert.deepEqual([half._options(0, 1).dressup.enabled, half._options(0, 1).dressup.entries], [true, []]);
});

test('_hasScope: ssp.exe\'s GetCharWnd as the stage has it: 0 always, else Stage.has; a stage without has: 0 and 1 [disasm 0x49ec70]', () => {
  const m = new Menu({ host: {}, stage: { has: s => s === 1 || s === 4 } });
  assert.deepEqual([0, 1, 2, 4, 4294967295].map(s => m._hasScope(s)), [true, true, false, true, false]);
  assert.deepEqual([0, 1, 2].map(s => new Menu({ host: {}, stage: {} })._hasScope(s)), [true, true, false]);
  assert.deepEqual([0, 1].map(s => new Menu({ host: {} })._hasScope(s)), [true, true]);
});

test('picks of a redirected menu: Close / Quit R1 the menu\'s character, R2 the clicked one; the rest the menu\'s [disasm 0x41d4ca, 0x41d503, 0x41d535]', () => {
  const calls = [];
  const rec = name => (...a) => { calls.push([name, ...a]); };
  const host = { close: rec('close'), quitAll: rec('quitAll'), toggleDressup: rec('toggleDressup'), send: rec('send') };
  const m = new Menu({ host, stage: { carry: rec('carry') } });
  m._run({ type: 'close' }, 0, 1);
  m._run({ type: 'quit' }, 0, 1);
  m._run({ type: 'carry' }, 0, 1);
  m._run({ type: 'dressup', scope: 1, id: 7 }, 0, 1);
  m._run({ type: 'site', kind: 'recommend', title: 'T', url: 'ftp://x/', index: 2 }, 0, 1);
  m._run({ type: 'close' }, 1, 1);
  m._run({ type: 'quit' }, 1);
  assert.deepEqual(calls, [
    ['close', 0, { window: 1 }],
    ['quitAll', 0, 1],
    ['carry', 0],
    ['toggleDressup', 1, 7],
    ['send', 'OnRecommendsiteChoice', ['T', 'ftp://x/', '', 'recommend', 0, 2]],
    ['close', 1],
    ['quitAll', 1],
  ]);
  // a loop without quitAll: Close with both scopes
  const old = [];
  new Menu({ host: { close: (...a) => old.push(a) } })._run({ type: 'quit' }, 0, 2);
  assert.deepEqual(old, [[0, { window: 2 }]]);
  // _activate passes what open() stored
  const picks = [];
  const a = new Menu({ host: { close: (...x) => picks.push(x) } });
  Object.assign(a, { scope: 0, clicked: 1 });
  a._activate({ getAttribute: () => null, __item: { kind: 'item', action: { type: 'close' } } }, null);
  assert.deepEqual(picks, [[0, { window: 1 }]]);
});

test('setShell: the new shell\'s menu look and stage; an open menu closes', () => {
  const look = r => ({ shell: { descript: new Map([['menu.background.font.color.r', r], ['menu.background.font.color.g', '0'], ['menu.background.font.color.b', '0']]) } });
  const a = look('10');
  const b = { ...look('200'), dressupMenu: () => null };
  const m = new Menu({ host: {}, stage: a });
  assert.equal(m.look.text, 'rgb(10,0,0)');
  let removed = 0;
  m.el = { remove: () => removed++ };
  const token = m.token;
  m.setShell({ stage: b, shellDir: 'shell/alt' });
  assert.deepEqual([m.look.text, m.stage, m.shellDir, m.el, removed], ['rgb(200,0,0)', b, 'shell/alt/', null, 1]);
  assert.ok(m.token > token, 'a menu still asking the ghost is dropped');
});

test('Information ▸ picks open the window: About Sumika, the readme (fetched on open), terms', async () => {
  const bytes = new TextEncoder().encode('Hello from the readme.\r\nSecond line.');
  const files = { has: p => p === 'readme.txt', resolve: p => p, bytes: async () => bytes };
  const descript = new Map([['craftmanw', 'Macaroni'], ['readme.charset', 'UTF-8']]);
  const m = new Menu({ host: {}, info: () => ({ sources: [{ kind: 'ghost', name: 'G', files, descript }], version: '9.9.9' }) });
  m._run({ type: 'readme' }, 0);
  await new Promise(r => setTimeout(r, 0));
  const v = m.infoWindow.view();
  assert.deepEqual([v.title, v.fields.map(f => f.value), v.text], ['About this character', ['Macaroni', '(N/A)'], 'Hello from the readme.\nSecond line.']);
  m._run({ type: 'about' }, 0);
  assert.equal(m.infoWindow.view().title, 'About Sumika');
  assert.match(m.infoWindow.view().text, /Version 9\.9\.9/);
  m._run({ type: 'terms' }, 0);                          // no terms file: nothing changes
  assert.equal(m.infoWindow.view().title, 'About Sumika');
  m.destroy();
  assert.equal(m.infoWindow, null);
});

// ---------------------------------------------------------------- keyboard and pointer

// just enough DOM for the row navigation: rows 24 px high, offsetTop relative to the (fixed, scrolling) menu, no
// padding above the first row or below the last (SSP has none, UI §2.3)
function fakeRow(top, item = { kind: 'item' }) {
  const cls = new Set();
  const attrs = new Map();
  return {
    offsetTop: top, offsetHeight: 24, style: {}, __item: item, focused: 0,
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
    getAttribute: k => (attrs.has(k) ? attrs.get(k) : null), setAttribute: (k, v) => attrs.set(k, v), focus() { this.focused++; },
    getBoundingClientRect: () => ({ left: 0, top, right: 100, bottom: top + 24 }),
  };
}
function fakeMenuEl(n, clientHeight) {
  const rows = Array.from({ length: n }, (_, i) => fakeRow(24 * i));
  const scrollHeight = 24 * n;
  let st = 0;
  const el = {
    rows, clientHeight, scrollHeight, querySelectorAll: () => rows, getBoundingClientRect: () => ({ left: 0, top: 0 }), focus() {},
    removed: 0, remove() { this.removed++; }, getAttribute: k => (k === 'lang' ? 'en' : null),
    querySelector: () => rows.find(r => r.classList.contains('smk-hot')) || null,
    get scrollTop() { return st; },
    set scrollTop(v) { st = Math.max(0, Math.min(v, scrollHeight - clientHeight)); },   // as the browser clamps it
  };
  for (const r of rows) r.__menu = el;
  return el;
}

test('keyboard: a list taller than the viewport scrolls so the highlighted row stays in sight', () => {
  const m = new Menu({});
  const el = fakeMenuEl(48, 681);                        // 48 ghosts, the menu clamped to the viewport
  m._focusRow(el, 0);
  assert.equal(el.scrollTop, 0);
  m._focusRow(el, 32);                                   // ArrowDown x32: row top 768, bottom 792
  assert.equal(el.scrollTop, 792 - 681);
  assert.ok(el.rows[32].classList.contains('smk-hot') && el.rows[32].focused === 1);
  m._focusRow(el, 47);                                   // End: to the very bottom
  assert.equal(el.scrollTop, el.scrollHeight - 681);
  m._focusRow(el, 2);                                    // back up above the visible part
  assert.equal(el.scrollTop, 24 * 2);
  m._focusRow(el, 5);                                    // already visible: no scroll
  assert.equal(el.scrollTop, 48);
  m._focusRow(el, 0);                                    // Home: to the very top
  assert.equal(el.scrollTop, 0);
});

test('keyboard: the menu opens with no hot row (as SSP opened by the pointer); Down takes the first enabled row, Up the last', () => {
  const m = new Menu({});
  const el = fakeMenuEl(5, 400);
  el.rows.forEach((r, i) => { if (i === 0 || i === 4) r.getAttribute = k => (k === 'aria-disabled' ? 'true' : null); });
  const key = k => m._onKey({ key: k, preventDefault() {}, stopPropagation() {} }, el, { fg: null });
  const hot = () => el.rows.findIndex(r => r.classList.contains('smk-hot'));
  m._focusMenu(el);
  assert.equal(hot(), -1);
  key('Enter');                                          // nothing to pick yet
  assert.equal(m.el, null);
  key('ArrowDown');
  assert.equal(hot(), 1, 'the first row is greyed: the next one');
  m._focusMenu(el);
  key('ArrowUp');
  assert.equal(hot(), 3, 'the last row is greyed: the one before it');
});

test('keyboard: Home and End skip greyed rows (Shell scaling ▸ starts with a disabled Default)', () => {
  const m = new Menu({});
  const items = scaleItems('shell', null, 1.25).filter(i => i.kind !== 'sep');
  assert.equal(items[0].disabled, true, 'nothing chosen: Default is greyed out');
  items.push({ kind: 'item', label: 'last, greyed', disabled: true });
  const el = fakeMenuEl(items.length, 2000);
  el.rows.forEach((r, i) => {
    r.__item = items[i];
    r.getAttribute = k => (k === 'aria-disabled' && items[i].disabled ? 'true' : null);
  });
  const key = k => m._onKey({ key: k, preventDefault() {}, stopPropagation() {} }, el, { fg: null });
  const hot = () => el.rows.findIndex(r => r.classList.contains('smk-hot'));
  m._focusRow(el, 5);
  key('Home');
  assert.equal(hot(), 1, 'Other percentage…, the first row that can be picked');
  key('End');
  assert.equal(hot(), items.length - 2, '20 %, not the greyed row after it');
  assert.equal(parseCaption(items[hot()].label).text, '20%');
});

test('keyboard: End without Array.prototype.findLastIndex (Chrome < 97, Firefox < 104, Safari < 15.4): the same row', () => {
  const had = Object.getOwnPropertyDescriptor(Array.prototype, 'findLastIndex');
  delete Array.prototype.findLastIndex;
  try {
    assert.equal([].findLastIndex, undefined);
    const m = new Menu({});
    const el = fakeMenuEl(6, 400);
    const grey = new Set([0, 4, 5]);
    el.rows.forEach((r, i) => { r.getAttribute = k => (k === 'aria-disabled' && grey.has(i) ? 'true' : null); });
    const key = k => m._onKey({ key: k, preventDefault() {}, stopPropagation() {} }, el, { fg: null });
    const hot = () => el.rows.findIndex(r => r.classList.contains('smk-hot'));
    key('End');
    assert.equal(hot(), 3, 'the last row that can be picked');
    key('Home');
    assert.equal(hot(), 1);
    for (let i = 0; i < 6; i++) grey.add(i);
    key('End');
    assert.equal(hot(), 5, 'every row greyed: the last row, as before');
  } finally {
    Object.defineProperty(Array.prototype, 'findLastIndex', had);
  }
});

test('pointer: reaching the open submenu cancels the timers of main-menu rows crossed on the way (menu aim)', async () => {
  const m = new Menu({});
  const main = fakeMenuEl(4, 200);
  const [utilities, , iconify] = main.rows;
  utilities.__item = { kind: 'sub', items: [{ kind: 'item', label: 'Reset' }] };
  const change = main.rows[1];
  change.__item = { kind: 'sub', items: [] };
  const sub = fakeMenuEl(40, 600);
  sub.__parentRow = change;
  m.el = main;
  m.subEl = sub;
  const calls = [];
  m._openSub = row => calls.push(['open', row === utilities ? 'utilities' : '?']);
  m._closeSubs = () => calls.push(['close']);
  const images = { fg: null };
  m._hover(utilities, main, images);                     // diagonal path from Change ghost up to the ghost list
  m._hover(sub.rows[0], sub, images);
  m._hover(iconify, main, images);                       // ... or down across Iconify
  m._hover(sub.rows[1], sub, images);
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(calls, [], 'the ghost list stays open');
  assert.ok(change.classList.contains('smk-hot') && !utilities.classList.contains('smk-hot') && !iconify.classList.contains('smk-hot'));
  assert.ok(sub.rows[1].classList.contains('smk-hot'));
  m._hover(utilities, main, images);                     // resting on a main-menu row still switches submenus
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(calls, [['open', 'utilities']]);
});

test('pointer: on a separator or off the menu no row is hot, except the row of an open submenu (Win32 hot tracking)', async () => {
  const m = new Menu({});
  const main = fakeMenuEl(4, 200);
  m.el = main;
  const images = { fg: null };
  const hot = el => el.rows.findIndex(r => r.classList.contains('smk-hot'));
  const [, change, iconify] = main.rows;
  m._hover(iconify, main, images);
  m._hoverSep(main, images);
  assert.equal(hot(main), -1, 'a separator: none');
  m._hover(iconify, main, images);
  m._leave(main, images);
  assert.equal(hot(main), -1, 'off the menu: none');
  // a submenu row the pointer left for a separator before its submenu opened: it does not open
  const opened = [];
  m._openSub = row => opened.push(row);
  change.__item = { kind: 'sub', items: [{ kind: 'item', label: 'x' }] };
  m._hover(change, main, images);
  m._hoverSep(main, images);
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual([opened.length, hot(main)], [0, -1]);
  // an open submenu: its row stays hot on the way out of the menu and on a separator, until the submenu closes
  const sub = fakeMenuEl(3, 200);
  sub.__parentRow = change;
  m.subEl = sub;
  m._hover(change, main, images);
  m._leave(main, images);
  assert.equal(hot(main), 1, 'on its way into the submenu');
  m._hover(sub.rows[0], sub, images);
  m._leave(sub, images);
  assert.deepEqual([hot(sub), hot(main)], [-1, 1], 'off the submenu: none there, its row stays');
  m._hoverSep(main, images);
  assert.equal(hot(main), 1);
  m._hover(sub.rows[1], sub, images);                    // reaching the submenu after all keeps it open
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual([m.subs.length, hot(main), hot(sub)], [1, 1, 1]);
  m._hoverSep(main, images);
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual([m.subs.length, sub.removed, hot(main)], [0, 1, -1], 'resting on the separator: the submenu closes, nothing hot');
});

test('submenus: the first row level with its parent row (the frame above it), flipped to the parent menu\'s left [win32 infer]', () => {
  const prev = { document: globalThis.document, window: globalThis.window, dpr: globalThis.devicePixelRatio };
  globalThis.document = { documentElement: { clientWidth: 700, clientHeight: 600 } };
  globalThis.window = { innerWidth: 700, innerHeight: 600 };
  globalThis.devicePixelRatio = 2;
  try {
    const m = new Menu({});
    const parent = { getBoundingClientRect: () => ({ left: 300, top: 40, width: 200, height: 300 }) };
    const sub = { style: {}, getBoundingClientRect: () => ({ width: 150, height: 100 }) };
    const row = { __menu: parent, getBoundingClientRect: () => ({ left: 300.5, top: 100, right: 400, bottom: 108 }) };
    m._placeSub(sub, row);
    assert.deepEqual([sub.style.left, sub.style.top], ['398px', '99.5px'], 'right − 2, top − 1 device px');
    row.getBoundingClientRect = () => ({ left: 300.5, top: 100, right: 600, bottom: 108 });
    m._placeSub(sub, row);
    assert.deepEqual([sub.style.left, sub.style.top], [`${300 + 2 - 150}px`, '99.5px'], 'no room on the right: left of the parent menu');
  } finally {
    for (const [k, v] of [['document', prev.document], ['window', prev.window], ['devicePixelRatio', prev.dpr]]) {
      if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
    }
  }
});

test('devicePixelRatio: watched while the menu is open (a resolution query, armed again on a change), unwatched when it closes', () => {
  const prev = { window: globalThis.window, dpr: globalThis.devicePixelRatio };
  const queries = [];
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    matchMedia: q => {
      const mq = { q, on: new Set(), addEventListener: (t, f) => mq.on.add(f), removeEventListener: (t, f) => mq.on.delete(f) };
      queries.push(mq);
      return mq;
    },
  };
  globalThis.devicePixelRatio = 1.25;
  try {
    const m = new Menu({});
    let refits = 0;
    m._refit = () => { refits++; };
    m.el = fakeMenuEl(2, 100);
    m._listen();
    assert.deepEqual(queries.map(q => [q.q, q.on.size]), [['(resolution: 1.25dppx)', 1]]);
    globalThis.devicePixelRatio = 1.5;
    [...queries[0].on][0]();
    assert.equal(refits, 1);
    assert.deepEqual(queries.map(q => [q.q, q.on.size]), [['(resolution: 1.25dppx)', 0], ['(resolution: 1.5dppx)', 1]]);
    m.close({ restoreFocus: false });
    assert.equal(queries[1].on.size, 0, 'closed: no longer watched');
  } finally {
    for (const [k, v] of [['window', prev.window], ['devicePixelRatio', prev.dpr]]) {
      if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
    }
  }
});

// a Menu whose _render makes fake menus (the submenu stack without a DOM)
function stackMenu() {
  const m = new Menu({});
  const made = [];
  m._render = items => {
    const el = fakeMenuEl(items.length, 400);
    el.rows.forEach((r, i) => { r.__item = items[i]; });
    made.push(el);
    return el;
  };
  m._place = () => {};
  const deepItems = [{ kind: 'item', label: 'Straw hat', action: { type: 'dressup', scope: 0, id: 7 } }];
  const level1Items = [{ kind: 'sub', label: 'Hats', items: deepItems }, { kind: 'item', label: 'Pony' }];
  const main = fakeMenuEl(2, 400);
  main.rows[0].__item = { kind: 'sub', label: 'Dress-up', items: level1Items };
  m.el = main;
  return { m, main, made };
}

test('submenu stack: a submenu inside a submenu opens next to it; activating a sub row inside a submenu opens its child', () => {
  const { m, main, made } = stackMenu();
  const images = { fg: null };
  m._openSub(main.rows[0], images, true);
  const level1 = made[0];
  assert.deepEqual(m.subs, [level1]);
  m._openSub(level1.rows[0], images, true);
  const deep = made[1];
  assert.deepEqual(m.subs, [level1, deep], 'the first level stays open');
  assert.equal(level1.removed, 0);
  assert.equal(deep.__parentRow, level1.rows[0]);
  assert.equal(level1.rows[0].getAttribute('aria-expanded'), 'true');
  assert.ok(deep.rows[0].classList.contains('smk-hot') && deep.rows[0].focused === 1, 'opened by key: its first row has the focus');
  // a click on the sub row (inside a submenu) opens its child again instead of closing its own parent
  m._closeSubs(1);
  assert.deepEqual([m.subs.length, deep.removed], [1, 1]);
  m._activate(level1.rows[0], images);
  assert.equal(m.subs.length, 2);
  assert.equal(m.subs[0], level1);
  // re-opening the first level closes everything below it
  m._openSub(main.rows[0], images, false);
  assert.equal(m.subs.length, 1);
  assert.equal(level1.removed, 1);
});

test('submenu stack: ArrowLeft and Escape close one level and go back to its row; ArrowRight opens from any level', () => {
  const { m, main, made } = stackMenu();
  const images = { fg: null };
  const key = (k, el) => m._onKey({ key: k, preventDefault() {}, stopPropagation() {} }, el, images);
  m._focusRow(main, 0);
  key('ArrowRight', main);
  const level1 = made[0];
  key('ArrowRight', level1);                             // its first row, Hats ▸, has the focus
  const deep = made[1];
  assert.deepEqual(m.subs, [level1, deep]);
  key('ArrowLeft', deep);
  assert.deepEqual(m.subs, [level1], 'one level');
  assert.equal(level1.rows[0].focused, 2, 'back on Hats ▸');
  assert.equal(level1.rows[0].getAttribute('aria-expanded'), 'false');
  key('ArrowRight', level1);
  key('Escape', made[2]);
  assert.deepEqual(m.subs, [level1]);
  key('Escape', level1);
  assert.deepEqual(m.subs, []);
  assert.ok(m.el === main, 'the main menu stays open');
});

test('submenu stack: the pointer moving into the deeper level does not close it; resting on a plain row does', async () => {
  const { m, main, made } = stackMenu();
  const images = { fg: null };
  m._openSub(main.rows[0], images, false);
  const level1 = made[0];
  m._openSub(level1.rows[0], images, false);
  const deep = made[1];
  m._hover(level1.rows[1], level1, images);              // crossing Pony on the way into Hats ▸'s list
  m._hover(deep.rows[0], deep, images);
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(m.subs, [level1, deep]);
  assert.ok(level1.rows[0].classList.contains('smk-hot'), 'its parent row stays highlighted');
  assert.ok(main.rows[0].classList.contains('smk-hot'));
  m._hover(level1.rows[1], level1, images);              // resting on Pony
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(m.subs, [level1]);
  // outside-click test: a pointerdown on any level is inside
  const handlers = {};
  const prev = globalThis.window;
  globalThis.window = { addEventListener: (t, f) => { handlers[t] = f; }, removeEventListener() {} };
  try {
    m._listen();
    handlers.pointerdown({ composedPath: () => [level1.rows[0], level1] });
    assert.ok(m.el === main, 'still open');
    handlers.pointerdown({ composedPath: () => [] });
    assert.equal(m.el, null, 'outside: closed');
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
});

// ---------------------------------------------------------------- the SHIORI's menu look (UI §2.3, GetODMFromShiori)

const rgbAnswers = (k, r, g, b) => ({ [`menu.${k}.r`]: String(r), [`menu.${k}.g`]: String(g), [`menu.${k}.b`]: String(b) });
/**
 * What bthver.5 answers on its real Kawari (site/ghost/bthver.5/ghost/master/core/resources.txt lines 404–441, the
 * only menu.* entries in its dictionaries): three names, both font colours, the alignments, disabled and separator;
 * everything else 204 (tests/runtime/menu_odm.test.mjs asks the engine itself)
 */
const BTH_ODM = new Map(Object.entries({
  'menu.background.bitmap.filename': 'menu\\menu_background_1.png',
  'menu.foreground.bitmap.filename': 'menu\\menu_foreground_1.png',
  'menu.sidebar.bitmap.filename': 'menu\\menu_sidebar_1.png',
  ...rgbAnswers('background.font.color', 0, 0, 0), ...rgbAnswers('foreground.font.color', 255, 255, 255),
  'menu.background.alignment': 'leftbottom', 'menu.foreground.alignment': 'leftbottom', 'menu.sidebar.alignment': 'bottom',
  ...rgbAnswers('disable.font.color', 222, 222, 222), ...rgbAnswers('separator.color', 0, 0, 0),
}));
/** etherism's (Satori, dic04_Menu.txt lines 706–739): font, disabled and separator colours and alignments only */
const ETHER_ODM = new Map(Object.entries({
  ...rgbAnswers('background.font.color', 252, 252, 252), ...rgbAnswers('foreground.font.color', 0, 0, 0),
  ...rgbAnswers('disable.font.color', 128, 128, 128), ...rgbAnswers('separator.color', 220, 220, 220),
  'menu.background.alignment': 'bottom', 'menu.foreground.alignment': 'bottom', 'menu.sidebar.alignment': 'bottom',
}));
/** a SHIORI answering from `answers` (a missing id: 204), its batches recorded */
function odmAsker(answers) {
  const batches = [];
  return { batches, ask: async ids => { batches.push([...ids]); return new Map(ids.map(id => [id, answers.has(id) ? answers.get(id) : null])); } };
}

test('SHIORI look: ssp.exe asks exactly these 35 ids, never the font; names, then sidebar and fills, then the rest [disasm 0x623730]', () => {
  const all = [...ODM_NAME_IDS, ODM_SIDEBAR_ID, ...ODM_FILL_IDS, ...ODM_REST_IDS];
  assert.equal(all.length, 35);
  assert.equal(new Set(all).size, 35);
  assert.deepEqual(ODM_REST_IDS.slice(0, 5), ['menu.sidebar.color.r', 'menu.sidebar.color.g', 'menu.sidebar.color.b', 'menu.sidebar.width', 'menu.sidebar.text']);
  assert.deepEqual(ODM_REST_IDS.slice(-3), ['menu.background.alignment', 'menu.foreground.alignment', 'menu.sidebar.alignment']);
  for (const id of ['menu.font.name', 'menu.font.height', 'menu.background.color', 'menu.separator.color']) assert.ok(!all.includes(id), id);
  assert.deepEqual(ODM_DEFAULT_NAMES, { bg: 'menu_background', fg: 'menu_foreground', side: 'menu_sidebar' }, 'InitMenuProp');
});

test('SHIORI look: a name\'s stem as SSP stores it (trailing spaces, a 3- or 4-letter extension); a descript\'s; where it is looked for', () => {
  for (const [v, want] of [['menu\\menu_background_1.png', 'menu\\menu_background_1'], ['bg.png  ', 'bg'], ['bg.jpeg', 'bg'], ['bg', 'bg'],
    ['a.png', 'a'], ['.png', '.png'], ['abc.de', 'abc.de'], ['bg.png\t\t', 'bg.png\t\t'], ['bg.png\t', 'bg'], [' bg.bmp', ' bg'],
    ['x.y.png', 'x.y'], ['', '']]) {
    assert.equal(odmStem(v), want, JSON.stringify(v));
  }
  for (const [v, want] of [['menu_background.png', 'menu_background'], ['menu\\bg.png', 'menu\\bg'], ['dir.x\\bg', 'dir.x\\bg'],
    ['dir.x/bg', 'dir.x/bg'], ['a.b.c', 'a.b'], ['bg', 'bg']]) {
    assert.equal(descriptStem(v), want, v);
  }
  assert.deepEqual(odmImagePaths('menu\\menu_background_1', 'shell/master/'),
    ['shell/master/menu\\menu_background_1.png', 'ghost/master/menu\\menu_background_1.png'], 'the shell folder, then ghost/master; always .png');
  assert.deepEqual(odmImagePaths('bg', 'shell/5th-smart'), ['shell/5th-smart/bg.png', 'ghost/master/bg.png']);
  assert.deepEqual([odmImagePaths('!menu_background'), odmImagePaths('')], [[], []], 'SSP\'s own data folder: none here');
  assert.deepEqual(odmState(menuLook(new Map([['menu.background.bitmap.filename', 'img\\bg.png']]))).names,
    { bg: 'img\\bg', fg: 'menu_foreground', side: 'menu_sidebar' }, 'the descripts\' stems over InitMenuProp\'s');
});

test('SHIORI look: a colour channel as SPColor reads it (digits, sign, \'%\', blanks; ≥ 0; its low byte) [disasm 0x5eba00]', () => {
  for (const [v, want] of [['0', 0], ['255', 255], [' 12', 12], ['\t7\t', 7], ['+5', 5], ['12%', 12], ['300', 44], ['256', 0],
    ['-1', null], ['-0', 0], ['12abc', null], ['abc', null], ['', null], ['1 2', null], [null, null]]) {
    assert.equal(colorChannel(v), want, JSON.stringify(v));
  }
});

test('SHIORI look: bthver.5\'s answers make one complete pass of 35 requests in three batches; its look [disasm 0x623730]', async () => {
  const { ask, batches } = odmAsker(BTH_ODM);
  const st = odmState(menuLook(null));
  const asked = [];
  const r = await odmPass(ask, st, { force: true, colourSet: x => { asked.push(x); return false; } });
  assert.deepEqual(batches, [ODM_NAME_IDS, [ODM_SIDEBAR_ID, ...ODM_FILL_IDS], ODM_REST_IDS]);
  assert.deepEqual(r.asked, batches.flat());
  assert.equal(r.asked.length, 35);
  assert.equal(r.complete, true);
  assert.deepEqual(asked, [], 'both names came back: no colour flag is looked at');
  assert.deepEqual([...r.reload], ['bg', 'fg', 'side']);
  assert.deepEqual(st.names, { bg: 'menu\\menu_background_1', fg: 'menu\\menu_foreground_1', side: 'menu\\menu_sidebar_1' });
  const L = menuLook(new Map(), new Map(), st.keys);
  assert.deepEqual([L.text, L.hoverText, L.disabledText, L.separator], ['rgb(0,0,0)', 'rgb(255,255,255)', 'rgb(222,222,222)', 'rgb(0,0,0)']);
  assert.deepEqual([L.backgroundAlign, L.foregroundAlign, L.sidebarAlign, L.sidebarTopEdge], ['left bottom', 'left bottom', 'bottom', true]);
  assert.deepEqual([L.background, L.backgroundColor, L.frame, L.fontName], [null, null, null, null], 'names stay out of the keys');
});

test('SHIORI look: fills alone complete a pass without a sidebar; etherism\'s answers never get asked; one name is not enough', async () => {
  // (b) both fill colours, no names: complete, the rest asked, no sidebar name
  let a = odmAsker(new Map(Object.entries({ ...rgbAnswers('background.color', 1, 2, 3), ...rgbAnswers('foreground.color', 4, 5, 6) })));
  let st = odmState();
  let r = await odmPass(a.ask, st, { force: true });
  assert.deepEqual(a.batches, [ODM_NAME_IDS, ODM_FILL_IDS, ODM_REST_IDS]);
  assert.equal(r.complete, true);
  assert.deepEqual(menuLook(null, null, st.keys).backgroundColor, 'rgb(1,2,3)');
  // (c) etherism (Satori, no descript menu keys): 8 requests, incomplete, its font colours never asked
  a = odmAsker(ETHER_ODM);
  st = odmState();
  r = await odmPass(a.ask, st, { force: true });
  assert.deepEqual(a.batches, [ODM_NAME_IDS, ODM_FILL_IDS]);
  assert.deepEqual([r.complete, r.asked.length, st.keys.size, r.reload.size], [false, 8, 0, 0]);
  // (d) the background's name alone: no sidebar asked, incomplete, the background reloaded all the same
  a = odmAsker(new Map([['menu.background.bitmap.filename', 'bg.png']]));
  st = odmState();
  r = await odmPass(a.ask, st, { force: true });
  assert.deepEqual(a.batches, [ODM_NAME_IDS, ODM_FILL_IDS]);
  assert.deepEqual([r.complete, [...r.reload], st.names.bg], [false, ['bg'], 'bg']);
  // a colour flag set before the pass (a descript colour whose image did not load) completes it with one answered now
  a = odmAsker(new Map(Object.entries(rgbAnswers('foreground.color', 9, 9, 9))));
  r = await odmPass(a.ask, odmState(), { force: true, colourSet: x => x === 'background' });
  assert.deepEqual([r.complete, a.batches.length], [true, 3]);
  r = await odmPass(odmAsker(new Map()).ask, odmState(), { force: true, colourSet: x => x === 'background' });
  assert.equal(r.complete, false, 'one flag is not enough');
  // a SHIORI that fails counts as no answer
  r = await odmPass(async () => { throw new Error('gone'); }, odmState(), { force: true });
  assert.deepEqual([r.complete, r.asked.length], [false, 8]);
});

test('SHIORI look: at an open (no force) a slot is reloaded only when its stem changed; a 204, an empty or invalid answer keeps the value', async () => {
  const answers = new Map(BTH_ODM);
  const a = odmAsker(answers);
  const st = odmState();
  await odmPass(a.ask, st, { force: true });
  let r = await odmPass(a.ask, st);
  assert.deepEqual([r.complete, r.reload.size, r.asked.length], [true, 0, 35], 'the same names: asked again, nothing reloaded');
  answers.set('menu.background.bitmap.filename', 'menu\\menu_background_2.png ');
  answers.set('menu.sidebar.bitmap.filename', 'menu\\menu_sidebar_1.bmp');
  answers.delete('menu.disable.font.color.r');
  answers.set('menu.separator.color.g', '');
  answers.set('menu.separator.color.b', 'x');
  answers.set('menu.foreground.font.color.r', '128');
  r = await odmPass(a.ask, st);
  assert.deepEqual([...r.reload], ['bg'], 'a new stem; the sidebar\'s .bmp has the stem it had');
  assert.equal(st.names.bg, 'menu\\menu_background_2');
  const L = menuLook(null, null, st.keys);
  assert.deepEqual([L.disabledText, L.separator, L.hoverText], ['rgb(222,222,222)', 'rgb(0,0,0)', 'rgb(128,255,255)'], 'sticky until the next shell load');
  // a forced pass (a shell load) reloads every named slot, the same stems too
  r = await odmPass(a.ask, st, { force: true });
  assert.deepEqual([...r.reload], ['bg', 'fg', 'side']);
  // an empty stem (all blanks) is stored but loads nothing
  answers.set('menu.foreground.bitmap.filename', '   ');
  r = await odmPass(a.ask, st);
  assert.deepEqual([st.names.fg, r.reload.has('fg'), r.complete], ['', false, true]);
});

test('SHIORI look: menuLook\'s third layer wins key by key over both descripts; menuColors with a load-time look and defaults', () => {
  const shell = new Map(Object.entries({ ...rgbAnswers('background.font.color', 1, 1, 1), 'menu.background.alignment': 'righttop',
    'menu.background.bitmap.filename': 'bg.png' }));
  const ghost = new Map(Object.entries(rgbAnswers('separator.color', 7, 7, 7)));
  const odm = new Map([['menu.background.font.color.g', '200'], ['menu.background.alignment', 'leftbottom']]);
  const L = menuLook(shell, ghost, odm);
  assert.deepEqual([L.text, L.separator, L.backgroundAlign, L.background], ['rgb(1,200,1)', 'rgb(7,7,7)', 'left bottom', 'bg.png']);
  assert.deepEqual(menuLook(shell, ghost, null), menuLook(shell, ghost), 'no SHIORI layer: the descripts\' look alone');
  // a look taken at load whose images did not load: drawn, not SSP's own (Windows' colours)
  const plain = menuLook(null);
  assert.equal(menuColors(plain, {}).ssp, true);
  assert.deepEqual(menuColors(plain, {}, { accepted: true }), { ssp: false, text: 'rgb(0,0,0)', hotText: 'rgb(255,255,255)',
    disabled: 'rgb(160,160,160)', separator: 'rgb(0,0,0)', bg: 'rgb(240,240,240)', hotBg: 'rgb(0,120,215)', frame: 'rgb(0,0,0)' });
  // LoadSurface's defaults stand when the look sets neither: a SHIORI text colour moves neither [disasm 0x6970d4, 0x697121]
  const white = menuLook(null, null, new Map(Object.entries(rgbAnswers('background.font.color', 255, 255, 255))));
  const c = menuColors(white, {}, { accepted: true, loadDefaults: { disabled: 'rgb(160,160,160)', separator: 'rgb(0,0,0)' } });
  assert.deepEqual([c.text, c.disabled, c.separator], ['rgb(255,255,255)', 'rgb(160,160,160)', 'rgb(0,0,0)']);
  const own = menuLook(null, null, new Map(Object.entries({ ...rgbAnswers('disable.font.color', 1, 2, 3), ...rgbAnswers('separator.color', 4, 5, 6) })));
  assert.deepEqual(['disabled', 'separator'].map(k => menuColors(own, {}, { accepted: true, loadDefaults: { disabled: 'x', separator: 'y' } })[k]),
    ['rgb(1,2,3)', 'rgb(4,5,6)'], 'the look\'s own win');
  assert.equal(menuColors(own, SSP_LOOK, { accepted: true }).ssp, true, 'SSP_LOOK stays SSP\'s own');
});

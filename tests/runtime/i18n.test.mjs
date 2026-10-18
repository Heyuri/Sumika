// The runtime's UI language (ssp-ui.md §2.10; src/core/i18n.js, src/core/language.js): the en/ja tables, "Use System
// Lang.", the stored choice, the menu in both languages (Language ▸, mnemonics, SSP's full-width "（&Z)" of Call ghost ▸,
// the ghost's captions untouched), OnLanguageChange at boot and on a change, the launcher and Other percentage…'s box.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRINGS, SSP_KEYS, SAME_IN_JA, PROPER_NOUNS, LANGUAGES, UI_LANGS, t, uiLang, normLangPref, systemLanguage, resolveLanguage, languageRefs,
} from '../../src/core/i18n.js';
import { UiLanguage } from '../../src/core/language.js';
import { RUNTIME_KEY, memoryStorage, runtimePrefs, StateStore } from '../../src/core/state.js';
import { buildMenuModel, parseCaption, languageItems, ghostItems, Menu } from '../../src/ui/menu.js';
import { launcherLabel } from '../../src/ui/launcher.js';
import { UserScaling, OTHER_BOX_ID } from '../../src/core/scaling.js';
import { EventLoop } from '../../src/core/events.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, FakeWindow, settle } from './fakes.mjs';
import { checkStringTables } from '../strings_check.mjs';

setLogLevel('silent');

// SSP's Japanese access key: '(&X)', or '（&X)' with a full-width '(' (Call ghost ▸, MENU 102)
const JA_MNEMONIC = /[(（]&[A-Z]\)/g;
const jaKeyShown = key => new RegExp(`[(（]${key.toUpperCase()}\\)`);

const nav = (...languages) => ({ languages, language: languages[0] });
const lang = (pref, n = nav('en-US'), storage = memoryStorage()) => {
  if (pref) runtimePrefs.set({ lang: pref }, storage);
  return new UiLanguage({ storage, navigator: n });
};
const labels = items => items.map(i => (i.kind === 'sep' ? '-' : parseCaption(i.label).text));

// ---------------------------------------------------------------- tables

test('tables: every key in both languages, the same {parameters}, no English left in Japanese', () => {
  // the check the admin page's table shares (tests/strings_check.mjs)
  checkStringTables(STRINGS, { sameInJa: SAME_IN_JA, properNouns: PROPER_NOUNS, mnemonic: JA_MNEMONIC });
  for (const k of SSP_KEYS) assert.ok(k in STRINGS.en, k);
  assert.deepEqual(UI_LANGS, ['ja', 'en'], 'Language ▸ order: Japanese, English (as SSP)');
  assert.deepEqual([LANGUAGES.ja.name, LANGUAGES.ja.id, LANGUAGES.en.name, LANGUAGES.en.id], ['Japanese', 1041, 'English', 1033]);
});

test('tables: SSP\'s mnemonics are the same letter in both languages; Japanese shows it in parentheses', () => {
  for (const k of Object.keys(STRINGS.en).filter(k => k.startsWith('menu.'))) {
    const e = parseCaption(STRINGS.en[k]), j = parseCaption(STRINGS.ja[k]);
    assert.equal(j.key, e.key, `${k}: ${STRINGS.en[k]} / ${STRINGS.ja[k]}`);
    if (j.key && !SAME_IN_JA.includes(k)) assert.match(j.text, jaKeyShown(j.key), `${k}: "(X)"`);
  }
  assert.equal(parseCaption(t('menu.changeGhost', 'ja')).text, 'ゴースト切り替え(G)');
  assert.equal(parseCaption(t('menu.changeGhost', 'en')).text, 'Change ghost');
  assert.deepEqual(parseCaption(t('menu.close', 'ja')).parts, [{ text: '終了(' }, { text: 'W', key: true }, { text: ')' }]);
});

test('tables: SSP\'s own captions for the menu and info window (MENU 102 / 128, message.txt, DIALOG 109); ours for About Sumika', () => {
  const pairs = {
    'menu.shell': ['Shell', 'シェル(S)'], 'menu.dressup': ['Clothes/Dressup', '着せ替え(C)'],
    'menu.dressupExplorer': ['Dressup explorer', '着せ替えエクスプローラ(E)'], 'menu.balloon': ['Balloon', 'バルーン(B)'],
    'menu.info': ['Information', '情報(A)'], 'menu.about': ['About Sumika...', 'Sumikaについて(A)'],
    'menu.readme': ['About this ghost...', 'キャラクタについて(G)'], 'menu.terms': ['Terms of this ghost...', 'キャラクタの利用条件(T)'],
    'menu.help': ['Help', '説明書(H)'], 'menu.aiGraph': ['AI graph', 'AIグラフ(I)'], 'menu.usage': ['Ghost usage statistics (R)', '使用頻度表示(R)'],
    'menu.sysinfo': ['Output system information', 'システム情報を書出(S)'], 'menu.leavePassive': ['Reset passive mode', '制限モード強制解除(P)'],
    'menu.charMove': ['Move character window', 'ゴースト本体移動'], 'menu.quit': ['Quit (X)', '全て終了(X)'],
    'info.readme': ['About this character', 'キャラクタについて'], 'info.author': ['Author:', '作者名：'], 'info.url': ['URL:', 'URL：'],
    'info.none': ['(N/A)', '(N/A)'], 'info.ok': ['OK', 'OK'], 'info.about': ['About Sumika', 'Sumikaについて'],
    'info.source.ghost': ['Ghost', 'ゴースト'], 'info.source.shell': ['Shell', 'シェル'], 'info.source.balloon': ['Balloon', 'バルーン'],
    'info.close': ['Close', '閉じる'],
  };
  for (const [k, [en, ja]] of Object.entries(pairs)) {
    assert.equal(parseCaption(t(k, 'en')).text, en, k);
    assert.equal(parseCaption(t(k, 'ja')).text, ja, k);
  }
  assert.equal(t('info.terms', 'ja', { file: 'terms.txt' }), '利用条件 : terms.txt');
  assert.equal(t('info.engine', 'en', { name: 'Satori' }), 'SHIORI: Satori');
  assert.equal(t('info.version', 'ja', { v: '1.0.0' }), 'バージョン 1.0.0');
  assert.ok(SSP_KEYS.includes('menu.quit') && SSP_KEYS.includes('info.author') && !SSP_KEYS.includes('menu.about'), 'About Sumika is ours');
  assert.ok(SAME_IN_JA.includes('info.ok') && !SAME_IN_JA.includes('menu.about'));
  assert.deepEqual([...PROPER_NOUNS].sort(), ['AI', 'MIDI', 'SHIORI', 'SSP', 'Sumika', 'URL']);
  // About's MIDI lines: ours, with DIALOG 109's full-width colon in Japanese
  assert.deepEqual(['info.midi', 'info.bank'].map(k => [t(k, 'en', { name: 'X' }), t(k, 'ja', { name: 'X' })]),
    [['MIDI: X', 'MIDI：X'], ['Sound bank: X', '音色データ：X']]);
  assert.ok(!SSP_KEYS.includes('info.midi') && !SSP_KEYS.includes('info.bank'));
});

test('tables: Call ghost ▸ is SSP\'s "Call ghost (&Z)" / "他のゴーストを呼ぶ（&Z)" (full-width "（"); the cap note is ours', () => {
  assert.equal(t('menu.callGhost', 'en'), 'Call ghost (&Z)');
  assert.equal(t('menu.callGhost', 'ja'), '他のゴーストを呼ぶ（&Z)');
  assert.deepEqual([parseCaption(t('menu.callGhost', 'en')).key, parseCaption(t('menu.callGhost', 'ja')).key], ['z', 'z']);
  assert.equal(parseCaption(t('menu.callGhost', 'ja')).text, '他のゴーストを呼ぶ（Z)');
  // the widened access-key patterns of the table tests accept SSP's full-width form, and still the half-width one
  assert.equal(t('menu.callGhost', 'ja').replace(JA_MNEMONIC, ''), '他のゴーストを呼ぶ');
  assert.equal(t('menu.changeGhost', 'ja').replace(JA_MNEMONIC, ''), 'ゴースト切り替え');
  assert.match(parseCaption(t('menu.callGhost', 'ja')).text, jaKeyShown('z'));
  assert.ok(SSP_KEYS.includes('menu.callGhost') && !SSP_KEYS.includes('menu.callLimit'));
  assert.equal(t('menu.callLimit', 'en', { n: 3 }), 'up to 3 at once');
  assert.equal(t('menu.callLimit', 'ja', { n: 3 }), '同時に3体まで');
  assert.equal(t('menu.callLimit', 'ja'), '同時に{n}体まで', 'the parameter stays until filled');
  assert.equal(parseCaption(t('menu.callLimit', 'en')).key, null);
});

test('t(): parameters, unknown language and key fall back', () => {
  assert.equal(t('launcher.call', 'ja', { name: 'つばさ' }), 'つばさを呼ぶ');
  assert.equal(t('launcher.call', 'fr', { name: 'Tsubasa' }), 'Call Tsubasa');
  assert.equal(t('no.such.key', 'ja'), 'no.such.key');
  assert.equal(t('menu.needs', 'en', {}), 'needs {engine}', 'a missing parameter stays visible');
  assert.equal(t('scale.range', 'ja', { min: 10, max: 500 }), '10～500 %');
});

// ---------------------------------------------------------------- the choice

test('Use System Lang.: the first Japanese or English language of the browser decides; else English', () => {
  assert.equal(systemLanguage(nav('ja-JP')), 'ja');
  assert.equal(systemLanguage(nav('ja')), 'ja');
  assert.equal(systemLanguage(nav('en-US', 'ja')), 'en');
  assert.equal(systemLanguage(nav('fr-FR', 'ja-JP', 'en')), 'ja');
  assert.equal(systemLanguage(nav('de', 'zh-CN')), 'en');
  assert.equal(systemLanguage({ language: 'ja-JP' }), 'ja', 'navigator.language alone');
  assert.equal(systemLanguage(null), 'en', 'no navigator');
  assert.equal(systemLanguage({ languages: [] }), 'en');
  assert.equal(resolveLanguage('en', nav('ja')), 'en');
  assert.equal(resolveLanguage('system', nav('ja')), 'ja');
  assert.deepEqual(['ja', 'EN', 'system', 'fr', undefined, null].map(normLangPref), ['ja', 'en', 'system', 'system', 'system', 'system']);
  assert.equal(uiLang('jp'), null);
});

test('the choice is stored site-wide in the runtime prefs, next to the ghost; nothing stored follows the system', () => {
  const storage = memoryStorage();
  runtimePrefs.set({ ghost: 'tsubasa' }, storage);
  const l = new UiLanguage({ storage, navigator: nav('ja-JP') });
  assert.deepEqual([l.pref, l.lang], ['system', 'ja']);
  const seen = [];
  l.on('change', e => seen.push(e));
  assert.equal(l.set('en'), true);
  assert.deepEqual(JSON.parse(storage.getItem(RUNTIME_KEY)), { ghost: 'tsubasa', lang: 'en', v: 1 }, 'the ghost choice is kept');
  assert.deepEqual(seen, [{ lang: 'en', prev: 'ja', pref: 'en', prevPref: 'system' }]);
  assert.equal(l.set('en'), false);
  assert.equal(seen.length, 1, 'the same pick again: nothing');
  assert.equal(l.set('system'), true);
  assert.deepEqual(seen[1], { lang: 'ja', prev: 'en', pref: 'system', prevPref: 'en' });
  assert.equal(l.set('ja'), false, 'the language in effect stays Japanese ...');
  assert.deepEqual(seen[2], { lang: 'ja', prev: 'ja', pref: 'ja', prevPref: 'system' }, '... but the choice changed: menus redraw');
  // the next page (another UiLanguage on the same storage) starts in it
  assert.deepEqual([new UiLanguage({ storage, navigator: nav('en') }).pref, new UiLanguage({ storage, navigator: nav('en') }).lang], ['ja', 'ja']);
});

test('another tab\'s pick (storage event) and the browser\'s languages (languagechange) are followed', () => {
  const storage = memoryStorage();
  const n = nav('en-US');
  const l = new UiLanguage({ storage, navigator: n });
  const win = new FakeWindow();
  l.bindWindow(win);
  const seen = [];
  l.on('change', e => seen.push(e.lang));
  runtimePrefs.set({ lang: 'ja' }, storage);             // written by another tab
  win.dispatch('storage', { key: 'unrelated' });
  assert.equal(l.lang, 'en', 'other keys are not ours');
  win.dispatch('storage', { key: RUNTIME_KEY });
  assert.equal(l.lang, 'ja');
  runtimePrefs.set({ lang: 'system' }, storage);
  win.dispatch('storage', { key: null });                // localStorage.clear() elsewhere
  assert.equal(l.lang, 'en');
  n.languages = ['ja-JP'];
  win.dispatch('languagechange', {});
  assert.equal(l.lang, 'ja');
  assert.deepEqual(seen, ['ja', 'en', 'ja']);
  l.dispose();
  n.languages = ['en'];
  win.dispatch('languagechange', {});
  assert.equal(l.lang, 'ja', 'disposed: no longer listening');
});

// ---------------------------------------------------------------- the menu

const TSUBASA = new Map(Object.entries({
  'recommendrootbutton.caption': 'Ghost Friends(&P)',
  'sakura.recommendsites': 'A\x01http://a.example/\x01\x02',
  'portalrootbutton.caption': 'The Basics(&R)',
  'sakura.portalsites': 'Home\x01http://h.example/\x01\x02',
  'hidebutton.caption': 'Hide for a Bit(&R)',
}));
const GHOSTS = [
  { id: 'tsubasa', name: 'Hayama-san Next Door', current: true, note: null, needs: null },
  { id: 'yayaghost', name: 'Emily/Phase4.5', current: false, note: 'needs YAYA', needs: 'YAYA' },
];
const scaling = { shell: null, balloon: null, dpr: 1.25 };

test('menu in Japanese: SSP\'s Japanese captions with "(X)"; the ghost\'s captions as she wrote them; Language stays "Language"', () => {
  const m = buildMenuModel(0, TSUBASA, { ghosts: GHOSTS, scaling, lang: 'ja', languagePref: 'ja' });
  assert.deepEqual(labels(m), ['Ghost Friends(P)', 'The Basics(R)', '-',
    'シェル倍率(E)', 'バルーン倍率(D)', '機能(F)', '-', 'ゴースト切り替え(G)', '-', 'Language', 'Hide for a Bit(R)', '-', '終了(W)', '全て終了(X)']);
  assert.deepEqual(m.filter(i => i.lang === '').map(i => parseCaption(i.label).text), ['Ghost Friends(P)', 'The Basics(R)', 'Hide for a Bit(R)'],
    'the ghost\'s captions are marked as not in the UI language');
  assert.deepEqual(m.filter(i => i.kind !== 'sep').map(i => parseCaption(i.label).key), ['p', 'r', 'e', 'd', 'f', 'g', 'l', 'r', 'w', 'x'],
    'mnemonics work in Japanese');
  const shell = m.find(i => i.label === 'シェル倍率(&E)');
  assert.deepEqual(labels(shell.items).slice(0, 3), ['標準(画面に合わせる) (D)', 'その他の倍率(O)...', '-'],
    'SSP\'s space before "(&D)" after a parenthesis ("詳細設定(ゴーストごとの設定) (&D)...")');
  const display = shell.items.find(i => i.note);
  assert.deepEqual([display.label, display.note, display.checked], ['125%', '画面', true]);
  assert.match(display.title, /^125% がこの画面に合った倍率です/);
  assert.deepEqual(labels(m.find(i => i.label === '機能(&F)').items), ['シェル位置初期化(H)']);
  const change = m.find(i => i.label === 'ゴースト切り替え(&G)');
  assert.deepEqual(change.items.map(i => [i.label, i.note, i.disabled, i.lang]),
    [['Hayama-san Next Door', null, false, ''], ['Emily/Phase4.5', 'YAYAが必要', true, '']]);
  const language = m.find(i => i.label === '&Language');
  assert.equal(language.lang, 'en');
  assert.deepEqual(labels(language.items), ['Japanese', 'English', '-', 'Use System Lang.']);
  assert.deepEqual(language.items.filter(i => i.checked).map(i => i.label), ['Japanese'], 'the bullet on the language in effect');
  assert.equal(language.items[0].radio, true);
  assert.deepEqual(language.items.filter(i => i.action).map(i => i.action), [
    { type: 'language', pref: 'ja' }, { type: 'language', pref: 'en' }, { type: 'language', pref: 'system' }]);
});

test('menu in English: the same items in SSP\'s English; Use System Lang. checked while it is the choice', () => {
  const m = buildMenuModel(0, TSUBASA, { ghosts: GHOSTS, scaling, lang: 'en', languagePref: 'system' });
  assert.deepEqual(labels(m), ['Ghost Friends(P)', 'The Basics(R)', '-',
    'Shell scaling', 'Balloon scaling (D)', 'Utilities (F)', '-', 'Change ghost', '-', 'Language', 'Hide for a Bit(R)', '-', 'Close (W)', 'Quit (X)']);
  const language = m.find(i => i.label === '&Language');
  // ssp.exe inserts its hard-coded "&Use System Lang." in every language (resource.dll's "&Use system lang." never shows)
  assert.deepEqual(labels(language.items), ['Japanese', 'English', '-', 'Use System Lang.']);
  assert.deepEqual(language.items.filter(i => i.checked).map(i => i.label), ['English', '&Use System Lang.']);
  assert.equal(t('menu.language.system', 'en'), t('menu.language.system', 'ja'));
  assert.equal(language.items[3].toggle, true, 'a check, not a bullet');
  assert.equal(m.find(i => i.label === 'Change &ghost').items[1].note, 'needs YAYA');
  // our own captions where the ghost gives none
  const plain = buildMenuModel(0, new Map([['sakura.recommendsites', 'A\x01http://a/\x01\x02'], ['sakura.portalsites', 'B\x01http://b/\x01\x02']]),
    { lang: 'ja', languagePref: 'en' });
  assert.deepEqual(labels(plain), ['おすすめ(R)', 'ポータルサイト(T)', '-', '機能(F)', '-',
    'Language', 'アイコン化(I)', '-', '終了(W)', '全て終了(X)']);
  assert.ok(plain.filter(i => i.kind !== 'sep' && i.label !== '&Language').every(i => i.lang === undefined), 'ours: in the menu\'s language');
  assert.deepEqual(languageItems('ja', 'en').filter(i => i.checked).map(i => i.label), ['Japanese']);
  assert.ok(!buildMenuModel(1, new Map(), { lang: 'ja', languagePref: 'ja' }).some(i => i.label === '&Language'), 'not in the abbreviated menu');
  assert.ok(!buildMenuModel(0, new Map()).some(i => i.label === '&Language'), 'no language object: no Language ▸ (older callers)');
  assert.deepEqual(ghostItems([{ id: 'x', name: 'X', note: 'needs Kawari' }], 'ja')[0].note, 'needs Kawari', 'a note without needs shows as given');
});

test('abbreviated menu (\\1, \\p[n]) in both languages: SSP\'s MENU 128 Close has no access key; Quit and Dress-up as in SSP', () => {
  const kero = new Map([['kero.recommendsites', 'K\x01http://k/\x01\x02']]);
  const dressup = { mode: 'manual', enabled: true, entries: [] };
  assert.deepEqual(labels(buildMenuModel(1, kero, { lang: 'ja', languagePref: 'ja', dressup, carry: true })),
    ['おすすめ(R)', '着せ替え(C)', '-', 'ゴースト本体移動', '-', '終了', '全て終了(X)']);
  assert.deepEqual(labels(buildMenuModel(1, kero, { lang: 'en', languagePref: 'en', dressup, carry: true })),
    ['Recommendations', 'Clothes/Dressup', '-', 'Move character window', '-', 'Close', 'Quit (X)']);
  const close = buildMenuModel(2, new Map(), { lang: 'ja' }).filter(i => i.action);
  assert.deepEqual(close.map(i => [i.label, parseCaption(i.label).key, i.action.type]), [['終了', null, 'close'], ['全て終了(&X)', 'x', 'quit']]);
  // the main menu keeps MENU 102's "終了(&W)"; a ghost's closebutton.caption wins in both
  assert.equal(buildMenuModel(0, new Map(), { lang: 'ja' }).find(i => i.action && i.action.type === 'close').label, '終了(&W)');
  assert.deepEqual(buildMenuModel(1, new Map([['closebutton.caption', 'Bye(&B)']]), { lang: 'ja' }).filter(i => i.action).map(i => [i.label, i.lang]),
    [['Bye(&B)', ''], ['全て終了(&X)', undefined]]);
});

test('Information ▸, Shell ▸, Balloon ▸ and Clothes/Dressup ▸ in Japanese: SSP\'s captions; shell, balloon and part names untouched', () => {
  const m = buildMenuModel(0, new Map(), {
    lang: 'ja', shells: [{ id: 'master', name: 'master', current: true }, { id: 'loligatari', name: '少女語り' }],
    balloons: { top: [], all: [{ id: 'LightBlue', name: 'LightBlue', current: true }] },
    dressup: { mode: 'manual', enabled: true, entries: [{ type: 'part', id: 0, category: 'Hair', part: 'Pony', on: true }] },
    info: { readme: true, terms: false }, devFunctions: true,
  });
  const sub = label => m.find(i => i.kind === 'sub' && i.label === label);
  assert.deepEqual(labels(sub('シェル(&S)').items), ['master', '少女語り']);
  assert.deepEqual(labels(sub('バルーン(&B)').items), ['LightBlue']);
  assert.deepEqual(labels(sub('着せ替え(&C)').items), ['着せ替えエクスプローラ(E)', '-', 'Hair - Pony']);
  assert.ok(sub('着せ替え(&C)').items[2].lang === '' && sub('シェル(&S)').items.every(i => i.lang === ''), 'ghost text: lang=""');
  assert.deepEqual(labels(sub('情報(&A)').items), ['Sumikaについて(A)', 'キャラクタについて(G)', 'キャラクタの利用条件(T)', '説明書(H)', '-',
    'AIグラフ(I)', '使用頻度表示(R)', 'システム情報を書出(S)']);
  assert.deepEqual(labels(sub('機能(&F)').items), ['制限モード強制解除(P)', '-', 'シェル位置初期化(H)']);
});

test('menu: a Language ▸ pick stores the choice; an open menu is drawn again in the new language', async () => {
  const l = lang(null, nav('en'));
  const m = new Menu({ host: {}, language: l });
  assert.equal(m.lang, 'en');
  m._run({ type: 'language', pref: 'ja' }, 0);
  assert.deepEqual([l.pref, l.lang, m.lang], ['ja', 'ja', 'ja']);
  const reopened = [];
  m.open = (at, focusBack) => { reopened.push([at, focusBack]); return Promise.resolve(); };
  m.el = {};                                              // open at (10, 20)
  m._at = { scope: 0, x: 10, y: 20 };
  m.prevFocus = 'page button';
  l.set('en');
  assert.deepEqual(reopened, [[{ scope: 0, x: 10, y: 20 }, 'page button']]);
  m.el = null;
  l.set('ja');
  assert.equal(reopened.length, 1, 'closed: nothing to redraw');
  m.destroy();
  l.set('en');
  assert.equal(reopened.length, 1, 'destroyed: no longer listening');
  assert.equal(new Menu({ host: {} }).lang, 'en', 'no language object: English');
});

// ---------------------------------------------------------------- OnLanguageChange

function loopWith(language) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(r => (r.id === 'OnLanguageChange' && r.method === 'GET' ? '\\0\\s[0]Okay!\\e' : null));
  const player = new FakePlayer();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(),
    ghost: { id: 'g', name: 'G' }, state: new StateStore('g', { storage: memoryStorage(), clock }), menu: { open() {} }, clock,
    env: { win: null, doc: null }, ghostDescript: new Map([['name', 'G']]), site: { ghosts: [], balloons: [] },
    sessionEpochMs: clock.now(), language,
  });
  return { shiori, player, loop };
}

test('OnLanguageChange: NOTIFY at boot with the language in effect; GET when it changes, and its reply plays', async () => {
  const l = lang('ja');
  const { shiori, player, loop } = loopWith(l);
  l.set('en');                                           // before boot: nothing to tell
  l.set('ja');
  assert.equal(shiori.find('OnLanguageChange').length, 0);
  await loop.boot({ resume: false });
  assert.deepEqual(shiori.find('OnLanguageChange').map(r => [r.method, ...r.refs]), [['NOTIFY', 'Japanese', '1041', '', '']]);
  shiori.log.length = 0;
  l.set('en');
  await settle();
  assert.deepEqual(shiori.find('OnLanguageChange').map(r => [r.method, ...r.refs]), [['GET', 'English', '1033', '', '']]);
  assert.equal(player.plays.at(-1).script, '\\0\\s[0]Okay!\\e');
  assert.equal(player.plays.at(-1).meta.event, 'OnLanguageChange');
  shiori.log.length = 0;
  l.set('en');                                           // the same again
  l.set('system');                                       // the system's language is English too: only the choice changed
  await settle();
  assert.equal(shiori.find('OnLanguageChange').length, 0);
  loop.destroy();
  l.set('ja');
  await settle();
  assert.equal(shiori.find('OnLanguageChange').length, 0, 'destroyed: no longer listening');
  assert.deepEqual(languageRefs('xx'), ['English', '1033', '', '']);
});

// ---------------------------------------------------------------- launcher, Other percentage…

test('launcher label in both languages', () => {
  assert.equal(launcherLabel('closed', 'Tsubasa', 'en'), 'Call Tsubasa');
  assert.equal(launcherLabel('minimized', 'Tsubasa', 'en'), 'Show Tsubasa');
  assert.equal(launcherLabel('closed', 'Tsubasa', 'ja'), 'Tsubasaを呼ぶ');
  assert.equal(launcherLabel('minimized', 'つばさ', 'ja'), 'つばさを表示');
  assert.equal(launcherLabel('closed', '', 'en'), 'Call the ghost');
  assert.equal(launcherLabel('closed', ' ', 'ja'), 'ゴーストを呼ぶ');
});

test('Other percentage… asks in the UI language and hands the box its words for a language change', async () => {
  const l = lang('ja');
  const dialogs = new FakeDialogs();
  const s = new UserScaling({ state: new StateStore('g', { storage: memoryStorage() }), dialogs, dpr: () => 1, language: l });
  const p = s.askOther('balloon', 0);
  const box = dialogs.boxes.at(-1);
  assert.equal(box.o.id, OTHER_BOX_ID);
  assert.deepEqual([box.o.title, box.o.hint, box.o.placeholder], ['バルーン倍率', 'バルーン倍率 : 10～500 %', '10～500 %']);
  assert.deepEqual(box.o.texts('en'), { title: 'Balloon scaling', hint: 'Balloon scaling: 10–500 %', placeholder: '10–500 %' });
  // the shell's box is named like SSP's dialog for it (DIALOG 140 "シェル倍率", label "シェル倍率 : ")
  const p2 = s.askOther('shell', 0);
  assert.deepEqual(dialogs.boxes.at(-1).o.texts('ja'), { title: 'シェル倍率', hint: 'シェル倍率 : 10～500 %', placeholder: '10～500 %' });
  assert.equal(dialogs.boxes.at(-1).o.texts('en').title, 'Shell scaling');
  dialogs.boxes.at(-1).resolve({ text: null, reason: 'cancel' });
  assert.equal(await p2, false);
  box.resolve({ text: null, reason: 'cancel' });
  assert.equal(await p, false);
});

// src/ui/settings.js (ssp-ui.md §2.13): the Preferences box, SSP's "User information" group of its General page: the
// words in both UI languages (SSP's own), edits stored at once, onClose({touched}) once per close, Esc, one box per
// page, labels following a language change. Headless first, then on the fake DOM (tests/balloon/fake_dom.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsView, SettingsWindow } from '../../src/ui/settings.js';
import { UserProfile } from '../../src/core/user.js';
import { UiLanguage } from '../../src/core/language.js';
import { t, SSP_KEYS } from '../../src/core/i18n.js';
import { memoryStorage, runtimePrefs } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { installFakeDom } from '../balloon/fake_dom.mjs';

setLogLevel('silent');

const language = pref => {
  const storage = memoryStorage();
  runtimePrefs.set({ lang: pref }, storage);
  return new UiLanguage({ storage, navigator: { languages: ['en'] } });
};
const words = v => [v.title, v.heading, v.group, ...v.rows.map(r => r.label), ...v.rows[3].options.map(o => o.label), v.note, v.close];

test('the words: SSP\'s DIALOG 124 / 105 in English and Japanese; "Preferences" / "設定" without "SSP:"', () => {
  assert.deepEqual(words(settingsView({}, 'en')), ['Preferences', 'General', 'User information', 'Name:', 'Nickname:',
    'Birthday:', 'Sex:', 'Male', 'Female', 'Undefined', 'Unless otherwise noted, changes will take effect immediately', 'Close']);
  assert.deepEqual(words(settingsView({}, 'ja')), ['設定', '一般', 'ユーザ情報', '名前 :', '呼ばれ方 :', '誕生日 :', '性別 :',
    '男', '女', '未設定', '一部の設定を除き、変更はすぐに反映されます。', '閉じる']);
  // Options ▸ Preferences… in SSP's MENU 102 words
  assert.deepEqual([t('menu.options', 'en'), t('menu.preferences', 'en'), t('menu.options', 'ja'), t('menu.preferences', 'ja')],
    ['&Options', '&Preferences...', '設定(&O)', '本体設定...(&P)']);
  for (const k of ['menu.options', 'menu.preferences', 'settings.user', 'settings.name', 'settings.note']) assert.ok(SSP_KEYS.includes(k), k);
  assert.ok(!SSP_KEYS.includes('settings.title'), 'the title is SSP\'s cut down: ours');
});

test('the values: the stored fields in SSP\'s order; Undefined while no sex is stored; nothing stored: empty fields', () => {
  const v = settingsView({ name: 'Taro Yamada', nickname: 'Taro', birthday: '2003-05-05', sex: 'male' }, 'en');
  assert.deepEqual(v.rows.map(r => [r.key, r.kind, r.value]), [['name', 'text', 'Taro Yamada'], ['nickname', 'text', 'Taro'],
    ['birthday', 'date', '2003-05-05'], ['sex', 'radio', 'male']]);
  assert.deepEqual(v.rows[3].options.map(o => o.value), ['male', 'female', 'undef']);
  assert.deepEqual(settingsView(null).rows.map(r => r.value), ['', '', '', 'undef']);
  assert.deepEqual(settingsView({ sex: 'x', name: 3 }).rows.map(r => r.value), ['', '', '', 'undef']);
});

test('headless: open, each edit stored at once, Close tells the owner whether a field was touched, once', () => {
  const user = new UserProfile({ storage: memoryStorage() });
  const closes = [];
  const w = new SettingsWindow({ user, onClose: r => closes.push(r) });
  assert.equal(w.isOpen, false);
  w.edit('name', 'Taro');
  assert.equal(user.isSet(), false, 'a closed box edits nothing');
  w.open();
  assert.equal(w.isOpen, true);
  w.edit('nickname', 'T');
  assert.equal(user.nickname(), 'T', 'stored at the first keystroke');
  w.edit('nickname', 'Ta');
  w.edit('nickname', 'Taro');
  w.edit('sex', 'female');
  w.edit('birthday', '2003-05-05');
  w.edit('lang', 'xx');                                  // not a field
  assert.deepEqual(user.refs(), ['Taro', '', '2003,05,05', 'female']);
  w.close();
  w.close();
  assert.deepEqual(closes, [{ touched: true }]);
  // opened and closed without an edit: untouched
  w.open();
  w.close();
  // changed and changed back: still touched (SSP's flag)
  w.open();
  w.edit('nickname', 'Taroo');
  w.edit('nickname', 'Taro');
  w.close();
  assert.deepEqual(closes, [{ touched: true }, { touched: false }, { touched: true }]);
  // a second open while open keeps the touch; destroy (the page going) closes without onClose
  w.open();
  w.edit('name', 'Taro Yamada');
  w.open();
  assert.equal(w.touched, true);
  w.destroy();
  assert.equal(w.isOpen, false);
  assert.equal(closes.length, 3);
  assert.deepEqual(user.refs(), ['Taro', 'Taro Yamada', '2003,05,05', 'female']);
});

test('headless: a throwing onClose is caught; no profile: the box still opens and closes', () => {
  const w = new SettingsWindow({ user: new UserProfile({ storage: memoryStorage() }), onClose: () => { throw new Error('x'); } });
  w.open();
  w.edit('name', 'Taro');
  assert.doesNotThrow(() => w.close());
  const bare = new SettingsWindow();
  bare.open();
  bare.edit('name', 'Taro');
  bare.close();
  assert.equal(bare.isOpen, false);
});

// ---------------------------------------------------------------- the DOM

function domBox(o = {}) {
  const doc = installFakeDom();
  const user = new UserProfile({ storage: memoryStorage() });
  const closes = [];
  const lang = o.language || language('en');
  const w = new SettingsWindow({ user, language: lang, onClose: r => closes.push(r) });
  return { doc, user, closes, lang, w };
}
const boxes = () => globalThis.document.body.children.flatMap(h => (h.shadowRoot ? h.shadowRoot.querySelectorAll('.smk-settings') : []));
const textOf = (el, cls) => el.querySelectorAll(cls)[0].textContent;

test('DOM: one dialog with SSP\'s words, the stored values, focus in the first field; Close gives the focus back', () => {
  const { doc, user, closes, w } = domBox();
  user.set({ name: 'Taro Yamada', birthday: '2003-05-05' });
  const before = doc.createElement('button');
  before.focus();
  w.open();
  const [el] = boxes();
  assert.equal(boxes().length, 1);
  assert.deepEqual([el.getAttribute('role'), el.getAttribute('aria-modal'), el.getAttribute('lang')], ['dialog', 'false', 'en']);
  assert.deepEqual([textOf(el, '.smk-settings-title'), textOf(el, '.smk-settings-page'), el.querySelectorAll('legend')[0].textContent,
    textOf(el, '.smk-settings-note'), textOf(el, '.smk-settings-close')],
  ['Preferences', 'General', 'User information', 'Unless otherwise noted, changes will take effect immediately', 'Close']);
  assert.deepEqual(el.querySelectorAll('label').slice(0, 3).map(l => l.textContent), ['Name:', 'Nickname:', 'Birthday:']);
  const inputs = el.querySelectorAll('input');
  assert.deepEqual(inputs.map(i => [i.type, i.value]), [['text', 'Taro Yamada'], ['text', ''], ['date', '2003-05-05'],
    ['radio', 'male'], ['radio', 'female'], ['radio', 'undef']]);
  assert.deepEqual(inputs.slice(3).map(i => i.checked), [false, false, true], 'Undefined while no sex is stored');
  assert.ok(inputs.slice(0, 3).every(i => i.getAttribute('autocomplete') === 'off'), 'never the browser\'s saved profile');
  assert.equal(doc.activeElement, inputs[0], 'focus in the first field');
  el.querySelectorAll('.smk-settings-close')[0].fire('click');
  assert.deepEqual([boxes().length, w.isOpen, closes], [0, false, [{ touched: false }]]);
  assert.equal(doc.activeElement, before, 'the focus goes back');
});

test('DOM: typing stores each input at once; the radios and the date too; Close after an edit: onClose({touched: true}) once', () => {
  const { user, closes, w } = domBox();
  w.open();
  const [name, nickname, birthday, male] = boxes()[0].querySelectorAll('input');
  const seen = [];
  user.on('change', e => seen.push(e.data.nickname));
  for (const s of ['T', 'Ta', 'Taro']) { nickname.value = s; nickname.fire('input'); }
  assert.deepEqual(seen, ['T', 'Ta', 'Taro'], 'one write per keystroke');
  name.value = 'Taro Yamada';
  name.fire('input');
  birthday.value = '2003-05-05';
  birthday.fire('change');
  male.checked = true;
  male.fire('change');
  assert.deepEqual(user.refs(), ['Taro', 'Taro Yamada', '2003,05,05', 'male']);
  birthday.value = '';
  birthday.fire('input');
  assert.equal(user.refs()[2], '', 'the birthday can be taken back');
  boxes()[0].querySelectorAll('.smk-settings-x')[0].fire('click');
  w.close();
  assert.deepEqual(closes, [{ touched: true }]);
});

test('DOM: Esc closes (not while the IME composes); a second open keeps one box, brought to the front, still touched', () => {
  const { doc, closes, w } = domBox();
  w.open();
  const el = boxes()[0];
  const [, nickname] = el.querySelectorAll('input');
  nickname.value = 'Taro';
  nickname.fire('input');
  const other = doc.createElement('div');                 // e.g. the Information window opened after it
  el.parent.appendChild(other);
  nickname.focus();
  w.open();
  assert.equal(boxes().length, 1, 'no second box');
  assert.equal(el.parent.children.at(-1), el, 'in front of the runtime\'s other boxes');
  assert.equal(doc.activeElement, nickname, 'the field in use keeps the focus');
  assert.equal(el.fire('keydown', { key: 'Escape', isComposing: true }).defaultPrevented, false);
  assert.equal(w.isOpen, true, 'Esc ends the composition first');
  const ev = el.fire('keydown', { key: 'Escape' });
  assert.deepEqual([ev.defaultPrevented, ev.propagationStopped, w.isOpen, boxes().length], [true, true, false, 0]);
  assert.deepEqual(closes, [{ touched: true }]);
});

test('DOM: a script opens the box while the visitor types in a page field: the field keeps the focus (open and a second open), the box pulses', () => {
  const { doc, user, closes, w } = domBox();
  const field = doc.createElement('input');              // the site's own search or comment field
  doc.body.appendChild(field);
  field.focus();
  w.open();                                              // emily4's \![open,configurationdialog,setup]
  const [el] = boxes();
  assert.equal(doc.activeElement, field, 'open() takes no focus from the page (the keys stay out of Name)');
  assert.ok(el.classList.contains('smk-pulse'), 'it shows itself instead, as the input boxes do');
  w.open();                                              // a second script open: _front()
  assert.equal(doc.activeElement, field, 'nor a second open');
  assert.equal(boxes().length, 1);
  w.close();
  assert.equal(doc.activeElement, field, 'closing it moves no focus either');
  assert.deepEqual(closes, [{ touched: false }]);
  assert.equal(user.isSet(), false, 'nothing stored, nothing sent');
  // a page textarea or select: the same; the runtime's own field (the communicate box, in the shadow root) is no page field
  for (const tag of ['textarea', 'select']) {
    const f = doc.createElement(tag);
    doc.body.appendChild(f);
    f.focus();
    w.open();
    assert.equal(doc.activeElement, f, tag);
    w.close();
  }
  const own = doc.createElement('input');
  doc.body.children.find(h => h.shadowRoot).shadowRoot.appendChild(own);
  own.focus();
  w.open();
  assert.equal(doc.activeElement, boxes()[0].querySelectorAll('input')[0], 'from the runtime\'s own field: focus in Name');
  w.close();
  // opened with nothing typed in (Options ▸ Preferences…), then the visitor goes to a page field: a script's open
  // brings the box to the front and leaves the focus there
  doc.body.focus();
  w.open();
  const name = boxes()[0].querySelectorAll('input')[0];
  assert.equal(doc.activeElement, name);
  field.focus();
  w.open();
  assert.equal(doc.activeElement, field);
  w.close();
});

test('DOM: Tab stays inside (×, the fields, the checked radio, Close); labels follow a language change while open', () => {
  const { doc, user, w, lang } = domBox();
  user.set({ sex: 'female' });
  w.open();
  const el = boxes()[0];
  const x = el.querySelectorAll('.smk-settings-x')[0];
  const close = el.querySelectorAll('.smk-settings-close')[0];
  const inputs = el.querySelectorAll('input');
  const order = [];
  x.focus();
  for (let i = 0; i < 6; i++) { el.fire('keydown', { key: 'Tab' }); order.push(doc.activeElement); }
  assert.deepEqual(order, [inputs[0], inputs[1], inputs[2], inputs[4], close, x]);
  el.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(doc.activeElement, close);
  // Language ▸ 日本語 while the box is open
  lang.set('ja');
  assert.equal(el.getAttribute('lang'), 'ja');
  assert.deepEqual([textOf(el, '.smk-settings-title'), textOf(el, '.smk-settings-page'), el.querySelectorAll('legend')[0].textContent],
    ['設定', '一般', 'ユーザ情報']);
  assert.deepEqual(el.querySelectorAll('label').slice(0, 3).map(l => l.textContent), ['名前 :', '呼ばれ方 :', '誕生日 :']);
  assert.deepEqual(el.querySelectorAll('span').map(s => s.textContent), ['性別 :', '男', '女', '未設定']);
  assert.equal(x.getAttribute('aria-label'), '閉じる');
  assert.deepEqual([textOf(el, '.smk-settings-close'), textOf(el, '.smk-settings-note')], ['閉じる', '一部の設定を除き、変更はすぐに反映されます。']);
  w.destroy();
  lang.set('en');
  assert.equal(boxes().length, 0);
});

test('DOM: another tab\'s edit shows in the open box; the field values change, nothing counts as touched', () => {
  const { user, closes, w } = domBox();
  w.open();
  const inputs = boxes()[0].querySelectorAll('input');
  user.set({ nickname: 'Hanako', sex: 'female' });          // as the storage event's refresh would
  assert.deepEqual([inputs[1].value, inputs[4].checked, inputs[5].checked], ['Hanako', true, false]);
  w.close();
  assert.deepEqual(closes, [{ touched: false }]);
});

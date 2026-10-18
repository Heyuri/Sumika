// The control page (src/control/, sumika/index.html; [decision] On, Off and Site default only): its text in both
// languages in visitor words, the language from the browser's (core/i18n.js systemLanguage's rule), what it shows for
// the stored record (blocked storage, a newer page's record), a pick saved at once through core/choice.js (the very key
// and values main.js reads), the page built on a fake document (a fieldset of three radio buttons, the stored choice
// checked, a status line, nothing written before a pick, another tab's pick followed), and its bundle: nothing but
// choice.js and what it needs (no loader, Site, worker or engine: the page loads no ghost, engine, balloon or index).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { STRINGS, OPTIONS, pageLanguage, text, optionOf, choiceOf, viewOf, pick, mount } from '../../src/control/control.js';
import { CHOICE_KEY, readChoice, startState } from '../../src/core/choice.js';
import { systemLanguage } from '../../src/core/i18n.js';
import { memoryStorage } from '../../src/core/state.js';
import { common } from '../../tools/build.mjs';
import { FakeEl } from '../balloon/fake_dom.mjs';
import { checkStringTables } from '../strings_check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OFF = JSON.stringify({ choice: 'off', v: 1 });

test('the text: every key in English and Japanese, the same {parameters}, Japanese written as Japanese; visitor words (no hub, origin or storage key)', () => {
  checkStringTables(STRINGS, { properNouns: ['Sumika'] });
  assert.match(STRINGS.en.where, /\{host\}/);
  assert.match(STRINGS.en['status.saved'], /\{choice\}/);
  for (const [k, s] of [...Object.entries(STRINGS.en), ...Object.entries(STRINGS.ja)]) {
    assert.doesNotMatch(s, /\bhub\b|\borigin\b|localStorage|storage key|ハブ|オリジン/i, k);
  }
  assert.deepEqual([STRINGS.en['choice.site'], STRINGS.en['choice.on'], STRINGS.en['choice.off']], ['Site default', 'On', 'Off'], 'the three words');
  assert.equal(text('where', 'en', { host: 'sumika.example.com' }).includes('sumika.example.com'), true);
  assert.equal(text('title', 'fr'), STRINGS.en.title, 'another language: English');
});

test('pageLanguage: the runtime\'s "Use System Lang." rule (the first Japanese or English of the browser\'s languages, else English)', () => {
  const navs = [{ languages: ['ja-JP', 'en-US'] }, { languages: ['de-DE', 'en-GB', 'ja'] }, { languages: ['fr'], language: 'ja' }, { languages: [], language: 'ja-JP' },
    { languages: ['zh-CN'] }, {}, null, { languages: ['JA_jp'] }, { languages: ['', null, 'en'] }];
  for (const n of navs) assert.equal(pageLanguage(n), systemLanguage(n), JSON.stringify(n));
  assert.equal(pageLanguage({ languages: ['ja-JP'] }), 'ja');
  assert.equal(pageLanguage({ languages: ['de'] }), 'en');
});

test('viewOf and the option names: Site default is no record; blocked storage disables the choices; a newer page\'s record is shown, disabled, with its line', () => {
  assert.deepEqual([optionOf(null), optionOf('on'), optionOf('off'), choiceOf('site'), choiceOf('on'), choiceOf('off')], ['site', 'on', 'off', null, 'on', 'off']);
  assert.deepEqual(OPTIONS, ['site', 'on', 'off']);
  assert.deepEqual(viewOf({ choice: null, newer: false, blocked: false }), { option: 'site', disabled: false, status: null });
  assert.deepEqual(viewOf({ choice: 'off', newer: false, blocked: false }), { option: 'off', disabled: false, status: null });
  assert.deepEqual(viewOf({ choice: null, newer: false, blocked: true }), { option: 'site', disabled: true, status: 'status.blocked' });
  assert.deepEqual(viewOf({ choice: 'on', newer: true, blocked: false }), { option: 'on', disabled: true, status: 'status.newer' });
});

test('pick: saved at once in the key main.js reads (Off -> the runtime starts nothing; Site default -> no record); a refusing storage keeps the stored choice and says nothing changed', () => {
  const s = memoryStorage();
  const off = pick(s, 'off', 'en');
  assert.deepEqual([off.outcome, off.option], ['saved', 'off']);
  assert.equal(off.status, 'Saved: Off. Pages you open or reload from now on follow it.');
  assert.equal(s.getItem(CHOICE_KEY), OFF);
  assert.deepEqual(startState(readChoice(s).choice, 'enabled'), { state: 'off', reason: 'visitor' }, 'what the runtime then does');
  assert.equal(pick(s, 'on', 'ja').status, '保存しました（オン）。これから開くページや再読み込みしたページから有効になります。');
  assert.equal(readChoice(s).choice, 'on');
  assert.equal(pick(s, 'site', 'en').outcome, 'saved');
  assert.equal(s.getItem(CHOICE_KEY), null, 'Site default: no record');

  const full = { getItem: k => (k === CHOICE_KEY ? OFF : null), setItem() { throw new DOMException('full', 'QuotaExceededError'); }, removeItem() { throw new Error('no'); } };
  const failed = pick(full, 'on', 'en');
  assert.deepEqual([failed.outcome, failed.option, failed.status], ['failed', 'off', STRINGS.en['status.failed']], 'the stored Off shown again');
  assert.deepEqual([pick(null, 'on', 'en').outcome, pick(null, 'on', 'en').option], ['failed', 'site']);
  const newer = memoryStorage();
  newer.setItem(CHOICE_KEY, JSON.stringify({ choice: 'off', v: 2 }));
  const n = pick(newer, 'on', 'en');
  assert.deepEqual([n.outcome, n.option, n.status], ['newer', 'off', STRINGS.en['status.newer']]);
});

// ---------------------------------------------------------------- the page on a fake document

/** A document for mount(): body, documentElement, title, createElement. */
const fakeDoc = () => ({ body: new FakeEl('body'), documentElement: new FakeEl('html'), title: '', createElement: t => new FakeEl(t) });
/** Every element under el with this tag, in document order. */
function all(el, tag) {
  const out = [];
  const walk = e => { for (const c of e.children || []) { if (c.tagName === tag.toUpperCase()) out.push(c); walk(c); } };
  walk(el);
  return out;
}
/** A Storage that records its writes. */
function watched(store, writes) {
  return { getItem: k => store.getItem(k), setItem: (k, v) => { writes.push(k); store.setItem(k, v); }, removeItem: k => { writes.push(k); store.removeItem(k); } };
}
/** A window whose `storage` listeners the test calls. */
const fakeWin = () => ({ fns: [], addEventListener(t, f) { if (t === 'storage') this.fns.push(f); }, fire(ev) { for (const f of this.fns) f(ev); } });

test('mount: title and lang, a heading, one fieldset of three radio buttons (named and described), the stored choice checked, a status line, where it applies; nothing written before a pick', () => {
  const store = memoryStorage();
  store.setItem(CHOICE_KEY, OFF);
  const writes = [];
  const doc = fakeDoc();
  const m = mount(doc, { storage: watched(store, writes), nav: { languages: ['en-US'] }, host: 'sumika.example.com' });
  assert.deepEqual([m.lang, doc.documentElement.getAttribute('lang'), doc.title], ['en', 'en', STRINGS.en.title]);
  const main = doc.body.children[0];
  assert.equal(main.tagName, 'MAIN');
  assert.equal(all(main, 'h1')[0].textContent, STRINGS.en.title);
  const [fs] = all(main, 'fieldset');
  assert.equal(all(fs, 'legend')[0].textContent, STRINGS.en.legend);
  const radios = all(fs, 'input');
  assert.deepEqual(radios.map(r => [r.type, r.name, r.value, r.checked, r.disabled]),
    [['radio', 'sumika-choice', 'site', false, false], ['radio', 'sumika-choice', 'on', false, false], ['radio', 'sumika-choice', 'off', true, false]]);
  for (const r of radios) {
    const name = main.getElementById(r.getAttribute('aria-labelledby'));
    const hint = main.getElementById(r.getAttribute('aria-describedby'));
    assert.equal(name.textContent, STRINGS.en[`choice.${r.value}`]);
    assert.equal(hint.textContent, STRINGS.en[`choice.${r.value}.hint`]);
    assert.equal(r.parent.tagName, 'LABEL', 'the whole row is its label');
  }
  assert.deepEqual([m.status.getAttribute('role'), m.status.getAttribute('aria-live'), m.status.textContent], ['status', 'polite', '']);
  assert.ok(all(main, 'p').some(p => p.textContent === text('where', 'en', { host: 'sumika.example.com' })));
  assert.deepEqual(writes, [], 'nothing written by showing the page');
});

test('mount: a pick saves at once and says so (the others unchecked); Site default removes the record; Japanese from the browser\'s languages; another tab\'s pick moves the selection and takes the status line back', () => {
  const store = memoryStorage();
  const writes = [];
  const win = fakeWin();
  const doc = fakeDoc();
  const m = mount(doc, { storage: watched(store, writes), nav: { languages: ['ja-JP'] }, host: 'h', win });
  assert.deepEqual([m.lang, doc.title], ['ja', STRINGS.ja.title]);
  assert.deepEqual(OPTIONS.map(o => m.inputs[o].checked), [true, false, false], 'no record: Site default');
  m.inputs.off.checked = true;
  m.inputs.off.fire('change');
  assert.equal(store.getItem(CHOICE_KEY), OFF);
  assert.deepEqual(OPTIONS.map(o => m.inputs[o].checked), [false, false, true]);
  assert.equal(m.status.textContent, text('status.saved', 'ja', { choice: STRINGS.ja['choice.off'] }));
  m.inputs.site.checked = true;
  m.inputs.site.fire('change');
  assert.equal(store.getItem(CHOICE_KEY), null);
  assert.deepEqual(writes, [CHOICE_KEY, CHOICE_KEY]);
  // the control page open in another tab saved On: the selection follows, nothing written here, and this page's
  // "Saved" line (Site default) goes with it [review: a real browser showed On checked under "Saved: Off"]
  assert.equal(m.status.textContent, text('status.saved', 'ja', { choice: STRINGS.ja['choice.site'] }));
  store.setItem(CHOICE_KEY, JSON.stringify({ choice: 'on', v: 1 }));
  win.fire({ key: CHOICE_KEY });
  assert.deepEqual(OPTIONS.map(o => m.inputs[o].checked), [false, true, false]);
  assert.equal(m.status.textContent, '');
  m.inputs.off.checked = true;
  m.inputs.off.fire('change');
  assert.equal(m.status.textContent, text('status.saved', 'ja', { choice: STRINGS.ja['choice.off'] }));
  win.fire({ key: 'sumika:runtime' });
  assert.equal(m.status.textContent, text('status.saved', 'ja', { choice: STRINGS.ja['choice.off'] }), 'another key: nothing changes');
  assert.deepEqual(writes, [CHOICE_KEY, CHOICE_KEY, CHOICE_KEY]);
  // a newer page saved in another tab: shown and disabled, with its line, as on load
  store.setItem(CHOICE_KEY, JSON.stringify({ choice: 'on', v: 2 }));
  win.fire({ key: CHOICE_KEY });
  assert.deepEqual(OPTIONS.map(o => [m.inputs[o].checked, m.inputs[o].disabled]), [[false, true], [true, true], [false, true]]);
  assert.equal(m.status.textContent, STRINGS.ja['status.newer']);
  // ... and that tab went back to Site default: usable again, no line
  store.removeItem(CHOICE_KEY);
  win.fire({ key: CHOICE_KEY });
  assert.deepEqual(OPTIONS.map(o => [m.inputs[o].checked, m.inputs[o].disabled]), [[true, false], [false, false], [false, false]]);
  assert.equal(m.status.textContent, '');
  assert.deepEqual(writes, [CHOICE_KEY, CHOICE_KEY, CHOICE_KEY], 'none of it written here');
});

test('mount: storage the browser refuses -> Site default checked, every choice disabled, the line that it cannot be kept; a newer page\'s record -> shown, disabled, reload', () => {
  for (const storage of [null, { getItem() { throw new DOMException('denied', 'SecurityError'); } }]) {
    const m = mount(fakeDoc(), { storage, nav: { languages: ['en'] }, host: 'h' });
    assert.deepEqual(OPTIONS.map(o => [m.inputs[o].checked, m.inputs[o].disabled]), [[true, true], [false, true], [false, true]]);
    assert.equal(m.status.textContent, STRINGS.en['status.blocked']);
  }
  const s = memoryStorage();
  s.setItem(CHOICE_KEY, JSON.stringify({ choice: 'on', v: 2 }));
  const m = mount(fakeDoc(), { storage: s, nav: { languages: ['en'] }, host: 'h' });
  assert.deepEqual(OPTIONS.map(o => [m.inputs[o].checked, m.inputs[o].disabled]), [[false, true], [true, true], [false, true]]);
  assert.equal(m.status.textContent, STRINGS.en['status.newer']);
});

test('the control bundle holds the choice module and nothing of the runtime: no loader, Site, worker, engine, hub or UI', async () => {
  const r = await esbuild.build({ ...common(true), sourcemap: false, metafile: true, entryPoints: [path.join(root, 'src/control/main.js')], outfile: path.join(root, 'out.js') });
  const inputs = Object.keys(r.metafile.outputs[Object.keys(r.metafile.outputs)[0]].inputs).map(p => p.replace(/\\/g, '/')).sort();
  for (const p of inputs) assert.match(p, /^src\/(control\/(main|control)|core\/(choice|schema|ghostset|shells|log))\.js$/, p);
  assert.ok(inputs.includes('src/core/choice.js'), 'the one module main.js reads too');
  const size = r.outputFiles.find(f => f.path.endsWith('.js')).contents.length;
  assert.ok(size < 16000, `small: ${size} bytes minified`);
});

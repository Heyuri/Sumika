// The DOM layer (BalloonView, Dialogs) on a fake DOM: elements, placement, painting per frame, pointer events, keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, tick } from './fake_dom.mjs';
import { fixture } from './setup.mjs';
import { scanImagePaths } from '../../src/balloon/images.js';
import { play } from './script.mjs';
import { computed, sheetsOf } from './css_cascade.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

installFakeDom();
const { Balloons } = await import('../../src/balloon/manager.js');
const { Dialogs } = await import('../../src/balloon/dialogs.js');
const { getRoot } = await import('../../src/ui/root.js');

const stage = {
  on: () => () => {},
  char: () => ({ rect: { x: 900, y: 300, width: 200, height: 400 }, balloonOffset: { x: 2, y: 14 } }),
};

test('balloon element: hidden until content, placed, painted once per frame, clickable choices', real, async () => {
  const { skin, ghost } = await fixture();
  const b = new Balloons({ skin, ghostFiles: ghost, stage });
  const root = getRoot();
  const script = '\\0\\b[2]\\_q\\_l[0,50]\\__q[ok]\\_b["menu\\choice5.png",inline]\\__q\\_l[@0,@-16]　 Sure\\n\\e';
  await b.images.prefetch(scanImagePaths(script));
  const v = b.get(0);
  const el = v.dom.el;
  assert.equal(el.parent, root);
  assert.equal(el.hidden, true);
  // the build's backing-store probes (core/canvas.js): one pixel drawn and cleared per canvas, before
  // any paint; the paints below are counted after them
  const built = { m: v.dom.mctx.calls.length, h: v.dom.hctx.calls.length };
  assert.deepEqual(v.dom.mctx.calls.map(c => c[0]), ['setTransform', 'fillRect', 'clearRect']);
  play(b, script);
  assert.equal(el.hidden, false);
  assert.equal(el.style.left, (900 - 340 + 2) + 'px');
  assert.equal(el.style.top, '314px');
  assert.equal(el.style.width, '340px');
  assert.equal(v.dom.main.width, 340);
  assert.equal(v.dom.main.height, 384);
  await tick(10);
  const calls = v.dom.mctx.calls.slice(built.m);
  assert.ok(calls.some(c => c[0] === 'fillText' && c[1] === 'S'), 'text painted');
  assert.equal(calls.filter(c => c[0] === 'clearRect').length, 1, 'one paint for the whole \\_q section');
  assert.match(v.dom.main.attrs['aria-label'], /Sure/);
  const got = [];
  b.on('link', l => got.push(l));
  // click in the middle of the button: viewport = balloon left/top + balloon coordinates
  const ev = v.dom.main.fire('click', { clientX: 562 + 23 + 100, clientY: 314 + 13 + 55 });
  assert.equal(ev.propagationStopped, true);
  assert.deepEqual(got, [{ kind: 'choice', id: 'ok', refs: [], label: '', scope: 0 }]);
  v.dom.main.fire('pointermove', { clientX: 562 + 23 + 100, clientY: 314 + 13 + 55 });
  assert.equal(v.dom.main.classList.contains('smk-link'), true, 'pointer cursor over a choice');
  await tick(10);
  const hl = v.dom.hctx.calls.slice(built.h);
  assert.equal(hl.filter(c => c[0] === 'fillRect').length, 4, 'highlight drawn: the pen rectangle');
  assert.ok(!hl.some(c => c[0] === 'putImageData'), 'no ROP fill (BA §3.8)');
  const cm = v.dom.main.fire('contextmenu', { button: 2 });
  assert.equal(cm.defaultPrevented, true);
  v.dom.main.fire('pointerenter');
  assert.equal(b.hovered, true);
  v.showClickWait(true);
  assert.equal(v.dom.wait.hidden, false);
  assert.equal(v.dom.wait.style.left, '314px');
  b.beginScript(false);
  assert.equal(el.hidden, true);
  assert.equal(b.hovered, false);
  b.destroy();
  assert.equal(el.parent, null);
});

test('input box: real <input>, IME-safe Enter, Esc, close button, timeout', real, async () => {
  const { skin } = await fixture();
  const balloons = { views: new Map([[0, { visible: true, rect: { x: 100, y: 100, width: 340, height: 170 } }]]) };
  const d = new Dialogs({ skin, stage, balloons });
  const p = d.inputBox({ id: 'ユーザ名', defaultText: 'Nei', title: 'Your name' });
  const box = d.boxes[0];
  assert.equal(box.el.style.left, '100px');
  assert.equal(box.el.style.top, '274px');
  assert.equal(box.input.style.left, '10px', 'communicatebox.x of LightBlue');
  assert.equal(box.input.style.width, '301px');
  assert.equal(box.input.value, 'Nei');
  assert.equal(globalThis.document.activeElement, box.input, 'focused');
  box.input.value = 'ねいばー';
  const composing = box.input.fire('keydown', { key: 'Enter', isComposing: true });
  assert.equal(d.anyOpen, true, 'Enter during IME composition does not submit');
  assert.equal(composing.propagationStopped, true, 'keys never reach the page');
  box.input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(await p, { text: 'ねいばー', timedOut: false, reason: 'ok' });
  assert.equal(box.el.parent, null);
  const q = d.inputBox({ id: 'a' });
  d.boxes[0].input.fire('keydown', { key: 'Escape' });
  assert.equal((await q).reason, 'cancel');
  const r = d.communicateBox();
  d.boxes[0].el.children.find(c => c.className.includes('smk-box-close')).fire('click');
  assert.equal(await r, null);
  const t = d.inputBox({ id: 'タイプ答え', timeoutMs: 20 });
  const t2 = d.inputBox({ id: 'other' });
  assert.equal(d.boxes[1].el.style.top, (274 + 46) + 'px', 'several boxes stack');
  assert.deepEqual(await t, { text: null, timedOut: true, reason: 'timeout' });
  d.close();
  assert.equal((await t2).reason, 'closed');
});

test('input box: the runtime\'s own options (Other percentage…): inputmode, tooltip, placeholder, pulse on a retry', real, async () => {
  const { skin } = await fixture();
  const d = new Dialogs({ skin, stage, balloons: { views: new Map() } });
  globalThis.document.activeElement = globalThis.document.body;   // nobody is typing in a page field
  d.inputBox({ id: 'pct', defaultText: '125', inputMode: 'decimal', hint: 'Shell scaling: percentage (10-500)', placeholder: '10–500 %' });
  const box = d.boxes[0];
  assert.deepEqual([box.input.inputMode, box.input.title, box.input.placeholder], ['decimal', 'Shell scaling: percentage (10-500)', '10–500 %']);
  assert.equal(box.el.classList.contains('smk-pulse'), false);
  d.cancel('pct');
  globalThis.document.activeElement = globalThis.document.body;   // as a browser does when the focused field goes
  d.inputBox({ id: 'pct', defaultText: 'big', placeholder: '10–500 %', pulse: true });
  assert.equal(d.boxes.length, 1);
  assert.equal(d.boxes[0].el.classList.contains('smk-pulse'), true);
  assert.equal(globalThis.document.activeElement, d.boxes[0].input, 'and still takes the focus');
  d.close();
});

test('box labels in the UI language (UI §2.10): ours follow a language change, a ghost\'s title stays as she wrote it', real, async () => {
  const { UiLanguage } = await import('../../src/core/language.js');
  const { memoryStorage } = await import('../../src/core/state.js');
  const { skin } = await fixture();
  const language = new UiLanguage({ storage: memoryStorage(), navigator: { languages: ['ja-JP'] } });
  const d = new Dialogs({ skin, stage, balloons: { views: new Map() }, language });
  d.communicateBox({ onSend() {} });
  const c = d.boxes[0];
  const [ok, x] = ['smk-box-ok', 'smk-box-close'].map(k => c.el.children.find(e => e.className.includes(k)));
  const words = () => [c.el.attrs['aria-label'], c.el.attrs.lang, c.input.attrs['aria-label'], ok.attrs['aria-label'], ok.title, x.attrs['aria-label']];
  assert.deepEqual(words(), ['コミュニケート', 'ja', '話しかける', '送信', '送信', '閉じる']);
  assert.equal(ok.textContent, 'OK', 'SSP\'s OK in both languages');
  d.inputBox({ id: 'ユーザ名', title: 'Your name' });
  const g = d.boxes[1];
  d.inputBox({ id: 'pct', texts: l => ({ title: l === 'ja' ? '倍率' : 'Scale', placeholder: l === 'ja' ? '10～500 %' : '10–500 %' }) });
  const own = d.boxes[2];
  assert.deepEqual([g.el.attrs['aria-label'], g.el.attrs.lang, g.input.attrs['aria-label']], ['Your name', undefined, 'Your name']);
  assert.equal(g.el.children.find(e => e.className === 'smk-box-x').attrs['aria-label'], '閉じる');
  assert.deepEqual([own.el.attrs['aria-label'], own.input.placeholder], ['倍率', '10～500 %']);
  d.teachBox();
  const teach = d.boxes[3];
  const teachWords = () => [teach.el.attrs['aria-label'], teach.el.attrs.lang, teach.input.attrs['aria-label'],
    teach.el.children.find(e => e.className.includes('smk-box-ok')).attrs['aria-label']];
  assert.deepEqual(teachWords(), ['ティーチ', 'ja', 'ティーチ', '送信']);
  language.set('en');
  assert.deepEqual(teachWords(), ['Teach', 'en', 'Teach', 'Send']);
  assert.deepEqual(words(), ['Communicate', 'en', 'Say something', 'Send', 'Send', 'Close']);
  assert.deepEqual([g.el.attrs['aria-label'], g.input.attrs['aria-label']], ['Your name', 'Your name']);
  assert.deepEqual([own.el.attrs['aria-label'], own.input.placeholder], ['Scale', '10–500 %']);
  d.destroy();
  language.set('ja');                                    // destroyed: no longer listening (and no boxes left)
  assert.equal(d.boxes.length, 0);
  const plain = new Dialogs({ skin, stage, balloons: { views: new Map() } });
  plain.inputBox({ id: 'a' });
  assert.deepEqual([plain.boxes[0].el.attrs['aria-label'], plain.boxes[0].el.attrs.lang], ['Input', 'en'], 'no language object: English');
  plain.close();
});

test('menu rows: a ghost\'s name is lang="", our note next to it (and its tooltip) in the menu\'s language (UI §2.10)', async () => {
  const { Menu, ghostItems } = await import('../../src/ui/menu.js');
  const m = new Menu({});
  const items = ghostItems([{ id: 'a', name: 'Ghost A', current: true }, { id: 'b', name: 'Ghost B', needs: 'YAYA' }], 'ja');
  const el = m._render([...items, { kind: 'item', label: '125%', note: '画面', title: '125% がこの画面に合った倍率です' }],
    { bg: null, fg: null, side: null }, true, 'ja');
  const rows = el.children.find(c => c.className === 'smk-rows').children;
  const note = r => r.children.find(c => c.className === 'smk-note');
  assert.equal(el.attrs.lang, 'ja');
  assert.deepEqual([rows[1].attrs.lang, rows[1].title, note(rows[1]).textContent, note(rows[1]).attrs.lang, note(rows[1]).title],
    ['', undefined, '(YAYAが必要)', 'ja', 'YAYAが必要']);
  assert.equal(note(rows[0]), undefined);
  assert.deepEqual([rows[2].attrs.lang, rows[2].title, note(rows[2]).attrs.lang], [undefined, '125% がこの画面に合った倍率です', undefined],
    'a row in the menu\'s language: the note inherits it, the tooltip stays on the row');
  el.remove();
  m.destroy();
});

test('menu element: SSP\'s device-pixel metrics at devicePixelRatio 1.25, pixel-art check and arrow, accelerator, no padding or animation (UI §2.3)', async () => {
  const { Menu, menuLook } = await import('../../src/ui/menu.js');
  const prev = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1.25;
  try {
    const m = new Menu({});
    // a look SSP takes for its two fill colours, with a sidebar image
    m.look = menuLook(new Map(Object.entries({ 'menu.background.color.r': '255', 'menu.background.color.g': '255', 'menu.background.color.b': '255',
      'menu.foreground.color.r': '0', 'menu.foreground.color.g': '0', 'menu.foreground.color.b': '0' })));
    const el = m._render([
      { kind: 'item', label: '125%', checked: true, radio: true },
      { kind: 'sep' },
      { kind: 'sub', label: 'Sh&ell scaling', items: [{ kind: 'item', label: 'x' }] },
      { kind: 'item', label: 'Hide(&H)\tAlt+H', checked: true, toggle: true },
    ], { bg: null, fg: null, side: { url: 'blob:side', width: 24, height: 500, edge: 'rgb(0,0,0)' } }, false, 'en');
    const s = el.style;
    assert.deepEqual([s['--smk-dp'], s['--smk-fs'], s['--smk-row'], s['--smk-sep-h'], s['--smk-inset'], s['--smk-side-w']],
      ['0.8px', '12px', '15.2px', '8.8px', '12.8px', '19.2px'], 'row 19, separator 11, inset 16, sidebar 24 device px');
    assert.deepEqual([s['--smk-extra'], s['--smk-text-lh'], s['--smk-text-pt']], ['12.8px', '14.4px', '0.8px'],
      'Windows\' 16 device px; Segoe UI\'s odd internal leading at 15 px: 18 + a 1-px pad');
    assert.deepEqual([s['--smk-text'], s['--smk-disabled'], s['--smk-hot-bg'], s['--smk-frame']], ['rgb(0,0,0)', 'rgb(170,170,170)', 'rgb(0,0,0)', 'rgb(0,0,0)'],
      'Windows\' text colour, greyed (2 × fill + text) / 3');
    assert.equal(s.fontFamily, '', 'the stylesheet\'s fonts');
    const side = el.children.find(c => c.className === 'smk-side');
    assert.equal(side.style.width, undefined, 'its width comes from --smk-side-w');
    const rowsEl = el.children.find(c => c.className === 'smk-rows');
    const [dot, sep, sub, hide] = rowsEl.children;
    const child = (r, cls) => r.children.find(c => c.className === cls);
    assert.deepEqual([child(dot, 'smk-check smk-bullet').textContent, child(hide, 'smk-check').textContent, child(sub, 'smk-arrow').textContent],
      ['', '', ''], 'pixel art, no glyphs');
    assert.equal(sep.className, 'smk-sep');
    assert.deepEqual([child(hide, 'smk-label').children.map(c => c.textContent).join(''), child(hide, 'smk-accel').textContent], ['Hide(H)', 'Alt+H']);
    assert.match(s['--smk-arrow'], /^-7.2px 5.6px currentColor, -6.4px 5.6px currentColor, /, 'top + 7 at right − 10 (5 px clear)');
    const sheets = sheetsOf(getRoot());
    assert.equal(computed(rowsEl, 'padding', ...sheets), '0', 'nothing above the first row');
    assert.equal(computed(dot, 'height', ...sheets), 'var(--smk-row, 16px)');
    assert.equal(computed(child(dot, 'smk-check smk-bullet'), 'box-shadow', ...sheets), 'var(--smk-dot, none)');
    assert.equal(computed(child(sub, 'smk-arrow'), 'box-shadow', ...sheets), 'var(--smk-arrow, none)');
    assert.equal(computed(sep, 'height', ...sheets), 'var(--smk-sep-h, 11px)');
    assert.equal(computed(el, 'border-radius', ...sheets), '4px');
    assert.ok(!sheets.some(c => /animation|@keyframes|transition/.test(c) && /smk-menu/.test(c)), 'no open animation (SSP turns it off)');
    assert.equal(computed(rowsEl, 'align-self', ...sheets), 'flex-start', 'the list as tall as its rows, also when it scrolls');
    const label = child(hide, 'smk-label');
    assert.deepEqual(['margin-right', 'line-height', 'padding-top'].map(p => computed(label, p, ...sheets)),
      ['var(--smk-extra, 14px)', 'var(--smk-text-lh, var(--smk-row, 16px))', 'var(--smk-text-pt, 0)']);
    assert.deepEqual(['line-height', 'padding-top'].map(p => computed(child(hide, 'smk-accel'), p, ...sheets)),
      ['var(--smk-text-lh, var(--smk-row, 16px))', 'var(--smk-text-pt, 0)'], 'the accelerator on the caption\'s baseline');
    // a Windows contrast theme turns box-shadow off: the marks keep theirs, in the row's forced text colour
    const forced = sheets.find(c => c.includes('@media (forced-colors: active)') && c.includes('.smk-menu')) || '';
    assert.match(forced, /\.smk-menu \.smk-row \.smk-check, \.smk-menu \.smk-row \.smk-arrow \{ forced-color-adjust: none; \}/);
    assert.match(forced, /\.smk-menu \.smk-sep \{ forced-color-adjust: none; --smk-sep: CanvasText; \}/);
    // devicePixelRatio 2: the same lengths again in device px, the font 12 CSS px (24 device px)
    m.el = el;
    globalThis.devicePixelRatio = 2;
    m._refit();
    assert.deepEqual([s['--smk-dp'], s['--smk-fs'], s['--smk-row'], s['--smk-sep-h'], s['--smk-side-w']], ['0.5px', '12px', '14px', '5.5px', '12px']);
    assert.deepEqual([s['--smk-extra'], s['--smk-text-lh'], s['--smk-text-pt']], ['13px', '14px', '0px'], '26 device px; an even leading at 24 px');
    assert.match(s['--smk-arrow'], /^-5.5px 4.5px currentColor, /, 'a 13-row, 8-wide arrow from top + 9, 4 px clear');
    m.el = null;
    el.remove();
    // a descript's menu.font.name / menu.font.height: that face first, the height in device px
    m.look = menuLook(new Map([['menu.font.name', 'MS UI Gothic'], ['menu.font.height', '15']]));
    const ja = m._render([{ kind: 'item', label: 'x' }], null, true, 'ja');
    assert.match(ja.style.fontFamily, /^"MS UI Gothic", "Yu Gothic UI"/);
    assert.deepEqual([ja.style['--smk-fs'], ja.style['--smk-row']], ['7.5px', '9.5px'], '15 + 4 device px at dpr 2');
    assert.deepEqual([ja.style['--smk-text-lh'], ja.style['--smk-extra']], ['9px', '13px'], 'its own leading; Windows\' allowance unchanged');
    ja.remove();
    m.destroy();
  } finally {
    globalThis.devicePixelRatio = prev;
  }
});

/** A fake Image for probeImage: every url loads as `size(url)` ({width, height}), or fails when that is null. */
function fakeImages(size) {
  const prev = globalThis.Image;
  globalThis.Image = class {
    set src(u) {
      const s = size(u);
      if (s) Object.assign(this, { naturalWidth: s.width, naturalHeight: s.height });
      setTimeout(() => (s ? this.onload() : this.onerror()), 0);
    }
  };
  return () => { if (prev === undefined) delete globalThis.Image; else globalThis.Image = prev; };
}

test('menu open(): no hot row, the focus on the menu; a look SSP rejects draws SSP\'s own, without the shell\'s images (UI §2.3)', async () => {
  const { Menu } = await import('../../src/ui/menu.js');
  const restore = fakeImages(u => (/fg\.png$/.test(u) ? null : { width: /side/.test(u) ? 24 : 300, height: 500 }));
  try {
    const host = { resources: async () => new Map([['hidebutton.caption', 'Hide(&H)']]), enableLevel: 0 };
    const files = { has: () => true, url: p => `blob:${p}` };
    const rgb = (k, v) => ({ [`${k}.r`]: v, [`${k}.g`]: v, [`${k}.b`]: v });
    const shell = d => ({ shell: { descript: new Map(Object.entries({ 'menu.background.bitmap.filename': 'bg.png',
      'menu.sidebar.bitmap.filename': 'side.png', ...d })) } });
    const rows = el => el.children.find(c => c.className === 'smk-rows').children.filter(c => c.className === 'smk-row');
    // the background loads, the foreground does not: its colours no longer count (LoadSurface) -> SSP's own look
    const m = new Menu({ host, files, stage: shell({ 'menu.foreground.bitmap.filename': 'fg.png', ...rgb('menu.background.color', '200'),
      ...rgb('menu.foreground.color', '20') }) });
    globalThis.document.activeElement = globalThis.document.body;
    await m.open({ scope: 0, x: 10, y: 20 });
    assert.ok(m.el, 'open');
    assert.deepEqual(rows(m.el).filter(r => r.classList.contains('smk-hot')), [], 'nothing hot at open [measured]');
    assert.equal(globalThis.document.activeElement, m.el, 'the keys go to the menu');
    assert.equal(m.el.children.some(c => c.className === 'smk-side'), false, 'no sidebar');
    assert.ok(!m.el.style.backgroundImage, 'no background image');
    assert.deepEqual([m.el.style['--smk-bg'], m.el.style['--smk-hot-bg']], ['rgb(255,255,255)', 'rgb(0,0,0)'], 'SSP\'s white rows, black hot row');
    assert.equal(rows(m.el).find(r => r.__item.label === 'Hide(&H)').getAttribute('lang'), '', 'the ghost\'s caption, from resources()');
    m.close({ restoreFocus: false });
    m.destroy();
    // both images load: the shell's look, its sidebar and background
    const ok = new Menu({ host, files, stage: shell({ 'menu.foreground.bitmap.filename': 'fg2.png' }) });
    await ok.open({ scope: 0, x: 10, y: 20 });
    assert.equal(ok.el.children.some(c => c.className === 'smk-side'), true);
    assert.equal(ok.el.style.backgroundImage, 'url("blob:shell/master/bg.png")');
    assert.deepEqual(rows(ok.el).filter(r => r.classList.contains('smk-hot')), []);
    assert.equal(ok.el.style['--smk-row'], '16px', 'opened by the mouse: SSP\'s rows');
    ok.close({ restoreFocus: false });
    // opened by a long press: rows of 24 CSS px (UI §9.6)
    await ok.open({ scope: 0, x: 10, y: 20, device: 'touch' });
    assert.deepEqual([ok.el.style['--smk-row'], ok._at.device], ['24px', 'touch']);
    ok.destroy();
  } finally {
    restore();
  }
});

test('menu rows: the dot on Shell / Balloon / Change ghost / dress-up parts, the tick on a category; a separator or leaving clears the hot row', async () => {
  const { Menu, shellItems, dressupItems, ghostItems } = await import('../../src/ui/menu.js');
  const m = new Menu({});
  const two = c => ({ type: 'category', category: c, on: true, parts: [{ id: 0, part: 'a', on: true }, { id: 1, part: 'b', on: false }] });
  const items = [
    ...shellItems([{ id: 'master', name: 'master', current: true }]),
    ...ghostItems([{ id: 'a', name: 'A', current: true }]),
    { kind: 'sep' },
    ...dressupItems({ mode: 'manual', enabled: true, entries: [{ type: 'part', id: 0, category: '髪', part: 'ポニー', on: true }] }),
    ...dressupItems({ mode: 'auto', enabled: true, entries: [two('Hair'), two('Shoes')] }).slice(0, 1),
  ];
  const el = m._render(items, null, false, 'en');
  m.el = el;
  const list = el.children.find(c => c.className === 'smk-rows').children;
  const mark = r => (r.children.find(c => /smk-check/.test(c.className)) || {}).className;
  assert.deepEqual(list.filter(r => r.className === 'smk-row').map(mark), ['smk-check smk-bullet', 'smk-check smk-bullet', 'smk-check smk-bullet', 'smk-check']);
  assert.deepEqual(list.filter(r => r.className === 'smk-row').map(r => r.getAttribute('role')), ['menuitemradio', 'menuitemradio', 'menuitemcheckbox', 'menuitem'],
    'the roles stay');
  const [shellRow, , sep] = list;
  shellRow.fire('pointerenter');
  assert.ok(shellRow.classList.contains('smk-hot'));
  sep.fire('pointerenter');
  assert.ok(!shellRow.classList.contains('smk-hot'), 'on the separator: none');
  shellRow.fire('pointerenter');
  el.fire('pointerleave');
  assert.ok(!shellRow.classList.contains('smk-hot'), 'off the menu: none');
  m.close({ restoreFocus: false });
  m.destroy();
});

test('hidden parts really disappear: the click-wait marker shows only during \\x (CSS cascade, not just the attribute)', real, async () => {
  const { skin, ghost } = await fixture();
  const b = new Balloons({ skin, ghostFiles: ghost, stage });
  const v = b.get(0);
  play(b, '\\0\\b[2]Hello\\e');
  const sheets = sheetsOf(getRoot());
  const { el, wait } = v.dom;
  assert.equal(computed(el, 'display', ...sheets), null, 'visible balloon');
  assert.equal(wait.hidden, true);
  assert.equal(computed(wait, 'display', ...sheets), 'none', 'no click-wait cue while the balloon just shows text');
  v.showClickWait(true);
  assert.equal(computed(wait, 'display', ...sheets), 'block');
  v.showClickWait(false);
  assert.equal(computed(wait, 'display', ...sheets), 'none');
  v.hide();
  assert.equal(computed(el, 'display', ...sheets), 'none');
  b.destroy();
});

test('foreground \\_b images go on their own canvas above the content, outside the balloon-shape clip-path', real, async () => {
  const { skin, ghost } = await fixture();
  const b = new Balloons({ skin, ghostFiles: ghost, stage });
  const script = '\\0\\b[2]\\_q\\_b["card\\1.png",-30,24,--option=foreground]\\_b["menu\\icon\\sky3.png",0,0]Hi\\e';
  await b.images.prefetch(scanImagePaths(script));
  const v = b.get(0);
  v.images.source = ref => ({ key: ref.key });
  play(b, script);
  const img = v.img, hit = img.hit;
  img.hit = 'polygon(0 0,340px 0,340px 384px)'; // the fixture skin is not decoded, so it has no traced shape
  try {
    v._resize();
    await tick(10);
    const { main, fg, hover, wait, mctx, fctx } = v.dom;
    assert.deepEqual(v.dom.el.children, [main, fg, hover, wait], 'stacking: content, foreground, highlight, click-wait');
    assert.equal(main.style.clipPath, img.hit, 'the content canvas keeps the hit-test shape');
    assert.ok(!fg.style.clipPath, 'the foreground canvas is not clipped');
    assert.equal(computed(fg, 'pointer-events', ...sheetsOf(getRoot())), 'none', 'clicks pass through to the content canvas');
    assert.equal(computed(main, 'pointer-events', ...sheetsOf(getRoot())), 'auto');
    assert.equal(fg.width, main.width);
    const keys = ctx => ctx.calls.filter(c => c[0] === 'drawImage' && c[1] && c[1].key).map(c => c[1].key.split('|')[0]);
    assert.deepEqual(keys(fctx), ['ghost/master/card/1.png']);
    assert.deepEqual(keys(mctx), ['ghost/master/menu/icon/sky3.png']);
    assert.ok(fctx.calls.some(c => c[0] === 'clearRect'), 'the foreground canvas is cleared on full paints');
    v.write('!');
    assert.equal(v.painter.canAppend(), true, 'typing next to a foreground image needs no full repaint any more');
  } finally {
    img.hit = hit;
    b.destroy();
  }
});

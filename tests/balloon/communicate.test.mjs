// The communicate box on a fake DOM (UI §6.1, BA §5): SSP's [field][OK][×] layout over balloonc1, and a box that
// stays open after each message until × or Esc closes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake_dom.mjs';
import { fixture } from './setup.mjs';
import { computed, sheetsOf } from './css_cascade.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

installFakeDom();
const { Dialogs } = await import('../../src/balloon/dialogs.js');
const { getRoot } = await import('../../src/ui/root.js');

const stage = { on: () => () => {}, char: () => ({ rect: { x: 900, y: 300, width: 200, height: 400 } }) };
const balloons = { views: new Map([[0, { visible: true, rect: { x: 100, y: 100, width: 340, height: 170 } }]]) };
const part = (box, cls) => box.el.children.find(c => String(c.className).split(/\s+/).includes(cls));

test('communicate box: field, then OK and × buttons as tall as the field, inside the LightBlue image', { ...real, timeout: 5000 }, async () => {
  const { skin } = await fixture();
  const d = new Dialogs({ skin, stage, balloons });
  const p = d.communicateBox({ onSend() {} });
  const box = d.boxes[0];
  const ok = part(box, 'smk-box-ok'), x = part(box, 'smk-box-close');
  assert.equal(skin.box(1).w, 322);
  assert.equal(box.el.style.width, '322px', 'the box is its balloonc1 image');
  // ssp.exe 2.9.08f: [field 262] 1 px [OK 20][× 18] = communicatebox.width 301
  assert.deepEqual([box.input.style.left, box.input.style.top, box.input.style.width, box.input.style.height], ['10px', '18px', '262px', '18px']);
  assert.equal(ok.tagName, 'BUTTON');
  assert.equal(ok.textContent, 'OK');
  assert.deepEqual([ok.style.left, ok.style.top, ok.style.width, ok.style.height], ['273px', '18px', '20px', '18px']);
  assert.equal(x.textContent, '×');
  assert.deepEqual([x.style.left, x.style.top, x.style.width, x.style.height], ['293px', '18px', '18px', '18px']);
  assert.equal(293 + 18, 10 + 301, '× ends where communicatebox.width ends');
  assert.equal(ok.style.color, 'rgb(84,32,27)', 'buttons are drawn in the balloon font colour');
  const glyph = ok.children.find(c => c.tagName === 'CANVAS');
  assert.ok(glyph, 'OK is a bitmap glyph, not browser text');
  assert.deepEqual([glyph.style.left, glyph.style.top, glyph.style.width, glyph.style.height], ['3px', '3px', '10px', '9px']);
  assert.ok(x.children.find(c => c.tagName === 'CANVAS'));
  assert.equal(box.input.style.color, 'rgb(84,32,27)', 'no communicatebox.font.color: the balloon font colour, like SSP');
  assert.equal(box.el.style.transform || '', '', 'without a mouse (or at 100 %) the box keeps CSS pixels');
  assert.equal(part(box, 'smk-box-x'), undefined, 'no small corner × any more');
  const sheets = sheetsOf(getRoot());
  assert.equal(computed(ok, 'position', ...sheets), 'absolute');
  assert.equal(computed(ok, 'right', ...sheets), null, 'the corner close button rule does not apply to the push buttons');
  assert.equal(computed(ok, 'box-sizing', ...sheets), 'border-box', '1 px border inside the 18 px');
  d.close();
  assert.equal(await p, null);

  // with a mouse at 125 % display scaling SSP draws the box at its image's pixel size; so do we
  const saved = [globalThis.matchMedia, globalThis.devicePixelRatio];
  globalThis.matchMedia = q => ({ matches: q === '(pointer: fine)' });
  globalThis.devicePixelRatio = 1.25;
  try {
    d.communicateBox({ onSend() {} });
    const sb = d.boxes[0];
    assert.equal(sb.el.style.transform, 'scale(0.8)');
    assert.equal(sb.el.style.transformOrigin, '0 0');
    const bgc = sb.el.children.find(c => c.tagName === 'CANVAS');
    assert.equal(bgc.width, 322, 'one canvas pixel per image pixel = one screen pixel');
    assert.equal(part(sb, 'smk-box-ok').children.find(c => c.tagName === 'CANVAS').width, 10);
    d.close();
  } finally {
    [globalThis.matchMedia, globalThis.devicePixelRatio] = saved;
  }

  // the input box keeps its look (corner ×, full-width field)
  d.inputBox({ id: 'a' });
  const ib = d.boxes[0];
  assert.equal(ib.input.style.width, '301px');
  assert.ok(part(ib, 'smk-box-x'));
  assert.equal(part(ib, 'smk-box-ok'), undefined);
  d.close();
});

test('communicate box: Enter and OK send, clear the field and keep it open and focused; × / Esc close it', { ...real, timeout: 5000 }, async () => {
  const { skin } = await fixture();
  globalThis.document.activeElement = globalThis.document.body; // the fake DOM keeps removed elements focused
  const d = new Dialogs({ skin, stage, balloons });
  const sent = [];
  const p = d.communicateBox({ detailed: true, onSend: t => sent.push(t) });
  const box = d.boxes[0];
  const { input } = box;
  const ok = part(box, 'smk-box-ok'), x = part(box, 'smk-box-close');
  assert.equal(globalThis.document.activeElement, input);
  input.value = 'hello';
  const enter = input.fire('keydown', { key: 'Enter' });
  assert.equal(enter.propagationStopped, true);
  assert.deepEqual(sent, ['hello']);
  assert.equal(d.anyOpen, true, 'still open after a message');
  assert.notEqual(box.el.parent, null);
  assert.equal(input.value, '', 'field cleared');
  assert.equal(globalThis.document.activeElement, input, 'focus kept for the next message');
  input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(sent, ['hello'], 'an empty field sends nothing');
  input.value = 'こんにちは';
  input.fire('keydown', { key: 'Enter', isComposing: true });
  assert.deepEqual(sent, ['hello'], 'Enter confirming an IME conversion does not send');
  ok.fire('click');
  assert.deepEqual(sent, ['hello', 'こんにちは'], 'OK sends too');
  assert.equal(input.value, '');
  assert.equal(globalThis.document.activeElement, input, 'focus goes back to the field after OK');
  ok.fire('click');
  assert.equal(sent.length, 2);
  d.submit('communicatebox', 'tea');
  assert.deepEqual(sent, ['hello', 'こんにちは', 'tea'], 'submit() works the same way headless');
  const settled = await Promise.race([p, new Promise(r => setTimeout(() => r('open'), 20))]);
  assert.equal(settled, 'open');
  x.fire('click');
  assert.deepEqual(await p, { text: null, reason: 'cancel' });
  assert.equal(box.el.parent, null);
  assert.equal(d.anyOpen, false);

  const q = d.communicateBox({ detailed: true, onSend: t => sent.push(t) });
  d.boxes[0].input.value = 'unsent';
  d.boxes[0].input.fire('keydown', { key: 'Escape' });
  assert.deepEqual(await q, { text: null, reason: 'cancel' });
  const keys = d.communicateBox({ detailed: true, onSend: t => sent.push(t) });
  const esc = d.boxes[0].el.fire('keydown', { key: 'Escape' });
  assert.equal(esc.propagationStopped, true, 'keys on the buttons stay in the box');
  assert.deepEqual(await keys, { text: null, reason: 'cancel' }, 'Esc on a focused button closes it too');
  const r = d.communicateBox({ detailed: true, onSend: t => sent.push(t) });
  d.close('communicatebox');
  assert.deepEqual(await r, { text: null, reason: 'closed' }, '\\![close,communicatebox]: no cancel');
  assert.equal(sent.length, 3);

  // without onSend (older callers) the box is one-shot
  const once = d.communicateBox();
  d.boxes[0].input.value = 'bye';
  d.boxes[0].input.fire('keydown', { key: 'Enter' });
  assert.equal(await once, 'bye');
  assert.equal(d.anyOpen, false);
});

test('teach box (UI §6.3): the communicate box\'s [field][OK][×] over balloonc2, one word per box', { ...real, timeout: 5000 }, async () => {
  const { skin } = await fixture();
  globalThis.document.activeElement = globalThis.document.body;
  const d = new Dialogs({ skin, stage, balloons });
  const p = d.teachBox({ defaultText: 'x' });
  const box = d.boxes[0];
  assert.equal(box.opts.balloon, 2);
  assert.equal(skin.box(2).name, 'balloonc2');
  assert.equal(box.el.attrs.role, 'dialog');
  assert.equal(box.el.attrs['aria-label'], 'Teach');
  assert.ok(String(box.el.className).split(/\s+/).includes('smk-box-communicate'), 'the communicate box\'s field');
  assert.deepEqual([box.input.style.left, box.input.style.width], ['10px', '262px']);
  assert.ok(part(box, 'smk-box-ok') && part(box, 'smk-box-close'), 'OK (UKADOC: "TeachBoxのOKボタン") and ×');
  assert.equal(box.input.value, 'x');
  assert.deepEqual(d.openKinds, ['teach']);
  box.input.value = '';
  box.input.fire('keydown', { key: 'Enter' });
  assert.equal(d.anyOpen, true, 'an empty word is not sent');
  box.input.value = 'ねこ';
  part(box, 'smk-box-ok').fire('click');
  assert.deepEqual(await p, { text: 'ねこ', timedOut: false, reason: 'ok' });
  assert.equal(d.anyOpen, false, 'one word per box');
  assert.equal(box.el.parent, null);

  // × and Esc cancel
  const q = d.teachBox();
  part(d.boxes[0], 'smk-box-close').fire('click');
  assert.deepEqual(await q, { text: null, timedOut: false, reason: 'cancel' });
  const r = d.teachBox();
  d.boxes[0].input.fire('keydown', { key: 'Escape' });
  assert.equal((await r).reason, 'cancel');
  // a new teach box and \![close,teachbox] close it without a cancel; it is not one of the input boxes
  const s1 = d.teachBox();
  const c = d.communicateBox({ onSend() {} });
  const s2 = d.teachBox();
  assert.equal((await s1).reason, 'closed', 'a new teach box replaces the old one');
  assert.deepEqual(d.boxes.map(b => b.type), ['communicate', 'teach'], 'next to the communicate box');
  d.close('__SYSTEM_ALL_INPUT__');
  assert.equal(d.boxes.length, 2);
  d.submit('teachbox', '');
  assert.equal(d.boxes.length, 2, 'submit() with nothing: still open');
  d.close('TeachBox');
  assert.deepEqual(await s2, { text: null, timedOut: false, reason: 'closed' });
  const s3 = d.teachBox();
  d.submit('teachbox', 'いぬ');
  assert.equal((await s3).text, 'いぬ', 'submit() answers it headless');
  d.close();
  assert.equal(await c, null);
});

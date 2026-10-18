// Phones (UI §9.11, §6.4): the input, communicate and teach boxes stay above the on-screen keyboard. src/ui/viewport.js
// reads the visual viewport; Dialogs' `phone` option moves the focused box up or down into it (a `translate`, its
// left/top kept as its home), never sideways and never while the page is zoomed, gives its field a 16-px font scaled
// back to the balloon's (iOS zooms into a smaller one) and shrinks a balloonc* image wider than the phone. Without
// `phone` (every desktop) none of it runs: no listener, no inline style. On the fake DOM, with a fake visualViewport
// set on globalThis.window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, tick } from './fake_dom.mjs';
import { fixture } from './setup.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

installFakeDom();
const { Dialogs } = await import('../../src/balloon/dialogs.js');
const { visibleRect, zoomed, keepVisible, watchVisible } = await import('../../src/ui/viewport.js');

const PHONE = { short: 375, long: 812, mobileView: true };
const stage = { on: () => () => {}, char: () => ({ rect: { x: 200, y: 400, width: 150, height: 260 } }) };
const noBalloons = { views: new Map() };

/** an event target that counts its listeners (the window, its visualViewport) */
function target(props) {
  const l = {};
  return Object.assign({
    addEventListener(t, fn) { (l[t] ||= []).push(fn); },
    removeEventListener(t, fn) { l[t] = (l[t] || []).filter(f => f !== fn); },
    fire(t) { for (const fn of [...(l[t] || [])]) fn({ type: t }); },
    listeners: () => Object.values(l).reduce((n, a) => n + a.length, 0),
  }, props);
}

/**
 * The fake DOM as a page of w×h CSS px whose window has a visualViewport, both counting their listeners; restore()
 * puts the fake DOM's own window, sizes, devicePixelRatio and matchMedia back.
 */
function world(w, h) {
  const doc = globalThis.document, de = doc.documentElement;
  const saved = [globalThis.window, de.clientWidth, de.clientHeight, globalThis.devicePixelRatio, globalThis.matchMedia];
  const vv = target({ width: w, height: h, offsetLeft: 0, offsetTop: 0, scale: 1 });
  const win = target({ innerWidth: w, innerHeight: h, visualViewport: vv, document: doc });
  globalThis.window = win;
  de.clientWidth = w;
  de.clientHeight = h;
  doc.activeElement = doc.body;
  return {
    win, vv,
    restore() { [globalThis.window, de.clientWidth, de.clientHeight, globalThis.devicePixelRatio, globalThis.matchMedia] = saved; },
  };
}

/** the visual viewport changes (the keyboard, a pan, a pinch) and tells it; one frame later */
async function view(vv, o, ev = 'resize') {
  Object.assign(vv, o);
  vv.fire(ev);
  await tick();
}

test('keepVisible: the vertical shift into the visible part, 8 px in; the top edge wins', () => {
  const vis = { x: 0, y: 0, width: 375, height: 400, scale: 1 };
  assert.equal(keepVisible({ y: 600, h: 42 }, vis), 392 - 642, 'below: up until its bottom is 8 px above the keyboard');
  assert.equal(keepVisible({ y: 380, h: 42 }, vis), -30, 'partly below');
  assert.equal(keepVisible({ y: 100, h: 42 }, vis), 0, 'inside: stays');
  assert.equal(keepVisible({ y: 50, h: 42 }, { ...vis, y: 120 }), 78, 'above a panned view: down to 8 px below its top');
  assert.equal(keepVisible({ y: 600, h: 500 }, vis), 8 - 600, 'taller than the visible part: its top shows');
  assert.equal(keepVisible({ y: 600, h: 42 }, vis, 0), 400 - 642, 'the margin');
});

test('visibleRect: the visual viewport in layout px, with its scale; without one the layout viewport; zoomed: scale off 1 by more than 0.01', () => {
  const w = world(375, 812);
  try {
    Object.assign(w.vv, { height: 400, offsetTop: 120 });
    assert.deepEqual(visibleRect(w.win), { x: 0, y: 120, width: 375, height: 400, scale: 1 });
    Object.assign(w.vv, { scale: 2, width: 187.5, height: 200, offsetLeft: 150, offsetTop: 300 });
    assert.deepEqual(visibleRect(w.win), { x: 150, y: 300, width: 187.5, height: 200, scale: 2 });
    w.win.visualViewport = null;                                    // an old browser
    assert.deepEqual(visibleRect(w.win), { x: 0, y: 0, width: 375, height: 812, scale: 1 });
    assert.deepEqual([zoomed({ scale: 1 }), zoomed({ scale: 1.005 }), zoomed({ scale: 2 }), zoomed({ scale: 0.98 }), zoomed({})],
      [false, false, true, true, false]);
  } finally {
    w.restore();
  }
});

test('watchVisible: the visual viewport\'s resize and scroll and the window\'s resize, once per frame; off() removes every listener', async () => {
  const w = world(375, 812);
  try {
    const seen = [];
    const off = watchVisible(w.win, vis => seen.push([vis.y, vis.height]));
    assert.deepEqual([w.vv.listeners(), w.win.listeners()], [2, 1]);
    Object.assign(w.vv, { height: 400, offsetTop: 40 });
    w.vv.fire('resize');
    w.vv.fire('scroll');
    w.win.fire('resize');
    assert.deepEqual(seen, [], 'not before the frame');
    await tick();
    assert.deepEqual(seen, [[40, 400]], 'once per frame');
    w.vv.fire('scroll');
    off();
    await tick();
    assert.deepEqual(seen, [[40, 400]], 'a frame asked for before off() does nothing');
    assert.deepEqual([w.vv.listeners(), w.win.listeners()], [0, 0]);
    // no visualViewport (an old browser, or a keyboard that resizes the layout viewport): the window's resize
    w.win.visualViewport = null;
    const off2 = watchVisible(w.win, vis => seen.push([vis.y, vis.height]));
    assert.equal(w.win.listeners(), 1);
    globalThis.document.documentElement.clientHeight = 500;
    w.win.fire('resize');
    await tick();
    assert.deepEqual(seen.at(-1), [0, 500]);
    off2();
    assert.equal(w.win.listeners(), 0);
  } finally {
    w.restore();
  }
});

test('phone: the focused box moves above the keyboard, 8 px in, its left/top kept; the others stay home; blur takes it back; a pan counts', real, async () => {
  const { skin } = await fixture();
  const w = world(375, 812);
  try {
    const d = new Dialogs({ skin, stage, balloons: noBalloons, phone: PHONE });
    d.inputBox({ id: 'a', at: { x: 10, y: 600 } });
    globalThis.document.activeElement = globalThis.document.body;  // a browser shows the shadow host there, no page field
    d.inputBox({ id: 'b', at: { x: 10, y: 600 } });                 // stacked below it, and focused
    const [a, b] = d.boxes;
    const h = a.size.h;
    assert.deepEqual([a.el.style.left, a.el.style.top, b.el.style.top], ['10px', '600px', `${600 + h + 4}px`], 'placed as on a desktop');
    assert.equal(globalThis.document.activeElement, b.input);
    assert.deepEqual([a.el.style.translate || '', b.el.style.translate || ''], ['', ''], 'no shift while the whole page shows');
    assert.deepEqual([w.vv.listeners(), w.win.listeners()], [2, 1], 'the visual viewport\'s resize and scroll, the window\'s resize');
    // the keyboard comes up: 400 px of the page stay visible
    await view(w.vv, { height: 400 });
    assert.deepEqual([a.el.style.translate, b.el.style.translate], ['', `0px ${392 - (646 + h)}px`], 'only the focused box moves');
    // the visitor taps the first box's field
    a.input.focus();
    b.el.fire('focusout');
    a.el.fire('focusin');
    assert.deepEqual([a.el.style.translate, b.el.style.translate], [`0px ${392 - (600 + h)}px`, '']);
    assert.deepEqual([a.el.style.left, a.el.style.top], ['10px', '600px'], 'left/top stay its home');
    assert.equal(392 - (600 + h) + 600 + h, 392, 'its bottom 8 px above the keyboard');
    // iOS pans the visual viewport toward the field
    await view(w.vv, { offsetTop: 120 }, 'scroll');
    assert.equal(a.el.style.translate, `0px ${512 - (600 + h)}px`, 'offsetTop counted');
    // a balloon change redraws it: the new element is shifted and watched too
    d.setSkin(skin);
    assert.equal(globalThis.document.activeElement, a.input, 'the focus kept');
    assert.equal(a.el.style.translate, `0px ${512 - (600 + h)}px`);
    assert.deepEqual([a.el.listeners.focusin.length, a.el.listeners.focusout.length], [1, 1]);
    // one whose box is 30 px taller: the shift is computed again for the new box, its bottom 8 px above the keyboard
    const tall = { box: n => { const i = skin.box(n); return i && { ...i, h: i.h + 30 }; }, sourceOf: () => null, font: skin.font };
    d.setSkin(tall);
    assert.equal(a.size.h, h + 30);
    assert.equal(a.el.style.translate, `0px ${512 - (600 + h + 30)}px`);
    d.setSkin(skin);
    assert.equal(a.el.style.translate, `0px ${512 - (600 + h)}px`);
    // a shell change places it again (inside the keyboard's smaller viewport, as usual), then shifts it
    Object.assign(w.vv, { offsetTop: 0 });
    d.setStage(stage);
    assert.equal(a.el.style.top, `${400 - h}px`);
    assert.equal(a.el.style.translate, `0px ${392 - 400}px`);
    // blur: back home
    a.input.blur();
    a.el.fire('focusout');
    assert.deepEqual([a.el.style.translate, b.el.style.translate], ['', '']);
    d.destroy();
  } finally {
    w.restore();
  }
});

test('phone: pinch zoom moves no box (its shift kept, never a horizontal one); back at scale 1 the shift is computed again', real, async () => {
  const { skin } = await fixture();
  const w = world(375, 812);
  try {
    const d = new Dialogs({ skin, stage, balloons: noBalloons, phone: PHONE });
    d.communicateBox({ at: { x: 10, y: 600 }, onSend() {} });
    const a = d.boxes[0];
    const h = a.size.h;
    await view(w.vv, { height: 400 });
    const shifted = a.el.style.translate;
    assert.equal(shifted, `0px ${392 - (600 + h)}px`);
    const seen = new Set();
    for (const [o, ev] of [[{ scale: 2, width: 187.5, height: 200, offsetLeft: 150, offsetTop: 300 }, 'resize'],
      [{ offsetLeft: 0, offsetTop: 0 }, 'scroll'], [{ offsetLeft: 187.5, offsetTop: 500 }, 'scroll'], [{ offsetTop: 612 }, 'scroll']]) {
      await view(w.vv, o, ev);
      seen.add(a.el.style.translate);
      a.el.fire('focusin');
      seen.add(a.el.style.translate);
      a.el.fire('focusout');
      seen.add(a.el.style.translate);
    }
    assert.deepEqual([...seen], [shifted], 'each keeps its last shift while zoomed');
    assert.deepEqual([a.el.style.left, a.el.style.top], ['10px', '600px'], 'and its place');
    assert.match(shifted, /^0px -?\d+px$/, 'vertical only');
    // a balloon change while zoomed keeps the shift too
    d.setSkin(skin);
    assert.equal(a.el.style.translate, shifted);
    await view(w.vv, { scale: 1, width: 375, height: 300, offsetLeft: 0, offsetTop: 0 });
    assert.equal(a.el.style.translate, `0px ${292 - (600 + h)}px`, 'back at 1: computed again');
    d.destroy();
  } finally {
    w.restore();
  }
});

test('phone: a drag folds the shift into left/top first, then moves the box as on a desktop', real, async () => {
  const { skin } = await fixture();
  const w = world(375, 812);
  try {
    const d = new Dialogs({ skin, stage, balloons: noBalloons, phone: PHONE });
    d.inputBox({ id: 'a', at: { x: 10, y: 600 } });
    const a = d.boxes[0];
    const h = a.size.h;
    await view(w.vv, { height: 400 });
    const dy = 392 - (600 + h);
    const bg = a.el.children[0];
    assert.equal(bg.tagName, 'CANVAS');
    bg.fire('pointerdown', { button: 0, clientX: 50, clientY: 380, pointerId: 1 });
    assert.deepEqual([a.el.style.left, a.el.style.top, a.el.style.translate], ['10px', `${600 + dy}px`, ''], 'folded where it shows');
    bg.fire('pointermove', { clientX: 60, clientY: 370 });
    bg.fire('pointerup');
    assert.deepEqual([a.el.style.left, a.el.style.top, a.moved], ['20px', `${600 + dy - 10}px`, true]);
    await view(w.vv, { height: 401 });
    assert.equal(a.el.style.translate, '', 'its new place is inside');
    // a right press folds nothing
    await view(w.vv, { height: 300 });
    const shifted = a.el.style.translate;
    assert.notEqual(shifted, '');
    bg.fire('pointerdown', { button: 2, clientX: 50, clientY: 300, pointerId: 1 });
    assert.equal(a.el.style.translate, shifted);
    d.destroy();
  } finally {
    w.restore();
  }
});

test('phone: watched from the first box until the last one closes (close, a timeout, destroy); a box opened without the focus too', real, async () => {
  const { skin } = await fixture();
  const w = world(375, 812);
  try {
    const d = new Dialogs({ skin, stage, balloons: noBalloons, phone: PHONE });
    const count = () => [w.vv.listeners(), w.win.listeners()];
    assert.deepEqual(count(), [0, 0], 'nothing before a box opens');
    d.inputBox({ id: 'a' });
    d.communicateBox({ onSend() {} });
    d.teachBox();
    assert.deepEqual(count(), [2, 1], 'one watcher for every box');
    d.close('a');
    d.close('teachbox');
    assert.deepEqual(count(), [2, 1]);
    d.close();
    assert.deepEqual(count(), [0, 0], 'the last box closed');
    assert.equal(d._offKeys, null);
    d.inputBox({ id: 't', timeoutMs: 10 });
    assert.deepEqual(count(), [2, 1]);
    await tick(30);
    assert.deepEqual(count(), [0, 0], 'timed out');
    // a script's box while the visitor types in a page field: no focus (it pulses), watched all the same, so a tap on
    // its field later brings it above the keyboard
    const field = globalThis.document.createElement('input');
    globalThis.document.body.appendChild(field);
    field.focus();
    d.inputBox({ id: 'p', at: { x: 10, y: 600 } });
    const p = d.boxes[0];
    assert.equal(globalThis.document.activeElement, field);
    assert.ok(p.el.classList.contains('smk-pulse'));
    assert.deepEqual(count(), [2, 1]);
    await view(w.vv, { height: 400 });
    assert.equal(p.el.style.translate || '', '', 'not focused: home');
    p.input.focus();
    p.el.fire('focusin');
    assert.equal(p.el.style.translate, `0px ${392 - (600 + p.size.h)}px`);
    field.remove();
    d.destroy();
    assert.deepEqual(count(), [0, 0], 'destroy');
  } finally {
    w.restore();
  }
});

test('phone: a balloonc* image wider than the phone shrinks to it (mobile view only); the field is 16 px scaled back to the balloon font', real, async () => {
  const { skin } = await fixture();
  const w = world(375, 812);
  try {
    const wide = { box: () => ({ name: 'balloonc1', w: 400, h: 42, geo: null, cfg: new Map() }), sourceOf: () => null, font: skin.font };
    const d = new Dialogs({ skin: wide, stage, balloons: noBalloons, phone: PHONE });
    d.communicateBox({ onSend() {} });
    const b = d.boxes[0];
    assert.equal(b.el.style.width, '400px', 'emily4\'s and wiz\'s 400-px balloonc*');
    assert.deepEqual([b.el.style.transform, b.el.style.transformOrigin], ['scale(0.9175)', '0 0'], '(375 − 8) / 400');
    assert.equal(Math.round(b.size.w), 367, 'OK and × on screen');
    d.close();
    d.destroy();
    // LightBlue's 322-px box fits a 375-px phone: as on a desktop
    const lb = new Dialogs({ skin, stage, balloons: noBalloons, phone: PHONE });
    lb.communicateBox({ onSend() {} });
    assert.equal(lb.boxes[0].el.style.transform, undefined);
    lb.close();
    // a page without a mobile viewport (laid out about 980 px wide and shrunk by the browser): boxScale, as on a
    // desktop
    const nv = new Dialogs({ skin: wide, stage, balloons: noBalloons, phone: { ...PHONE, mobileView: false } });
    nv.communicateBox({ onSend() {} });
    assert.equal(nv.boxes[0].el.style.transform, undefined);
    assert.match(nv.boxes[0].input.style.font, /^16px /, 'the field is 16 px on every phone');
    nv.close();

    // the field: LightBlue's font is 12 px; it computes 16 px and shows 12 (scale 0.75), the same rectangle as on a
    // desktop
    const desk = new Dialogs({ skin, stage, balloons: noBalloons });
    desk.inputBox({ id: 'x' });
    const today = { ...desk.boxes[0].input.style };
    desk.close();
    lb.inputBox({ id: 'x' });
    const s = lb.boxes[0].input.style;
    assert.match(today.font, /^12px /);
    assert.equal(s.font, '16px ' + today.font.slice(5), 'the same family');
    assert.deepEqual([s.transform, s.transformOrigin], ['scale(0.75)', '0 0']);
    assert.deepEqual([s.left, s.top], [today.left, today.top]);
    assert.ok(Math.abs(parseFloat(s.width) * 0.75 - parseFloat(today.width)) < 1e-9, 'width');
    assert.ok(Math.abs(parseFloat(s.height) * 0.75 - parseFloat(today.height)) < 1e-9, 'height');
    assert.ok(Math.abs(parseFloat(s.padding.split(' ')[1]) * 0.75 - 2) < 1e-9, 'the CSS\'s 2-px padding');
    assert.ok(Math.abs(parseFloat(s.borderWidth) * 0.75 - 1) < 1e-9, 'the communicate field\'s 1-px frame');
    lb.destroy();
    // a balloon font of 16 px or more: the field as on a desktop
    const big = { box: n => skin.box(n), sourceOf: img => skin.sourceOf(img), font: { ...skin.font, height: 16 } };
    const bd = new Dialogs({ skin: big, stage, balloons: noBalloons, phone: PHONE });
    bd.inputBox({ id: 'y' });
    assert.match(bd.boxes[0].input.style.font, /^16px /);
    assert.equal(bd.boxes[0].input.style.transform, undefined);
    bd.destroy();
  } finally {
    w.restore();
  }
});

test('desktop unchanged: without phone at 1280×720 and 1920×1080, no listener, no shift, the desktop\'s place, field and box scale', real, async () => {
  const { skin } = await fixture();
  for (const [vw, vh] of [[1280, 720], [1920, 1080]]) {
    for (const opt of [{}, { phone: null }]) {
      const w = world(vw, vh);
      try {
        const balloons = { views: new Map([[0, { visible: true, rect: { x: 100, y: 100, width: 340, height: 170 } }]]) };
        const d = new Dialogs({ skin, stage, balloons, ...opt });
        d.inputBox({ id: 'ユーザ名', defaultText: 'Nei', title: 'Your name' });
        const box = d.boxes[0];
        assert.deepEqual([box.el.style.left, box.el.style.top], ['100px', '274px'], 'as dom.test.mjs');
        assert.equal(globalThis.document.activeElement, box.input);
        d.communicateBox({ onSend() {} });
        d.teachBox();
        assert.deepEqual([w.vv.listeners(), w.win.listeners()], [0, 0], 'no listener on the visual viewport or the window');
        for (const b of d.boxes) {
          assert.deepEqual([b.el.listeners.focusin, b.el.listeners.focusout], [undefined, undefined]);
          assert.equal('translate' in b.el.style, false);
          assert.equal(b.el.style.transform, undefined, 'no mouse: CSS pixels');
          assert.match(b.input.style.font, /^12px /, 'the balloon font\'s 12 px');
          for (const k of ['transform', 'transformOrigin', 'padding', 'borderWidth']) assert.equal(b.input.style[k], undefined, k);
        }
        assert.deepEqual([box.input.style.width, box.input.style.height], ['301px', '18px']);
        // a phone's keyboard events change nothing here
        await view(w.vv, { height: 300 });
        w.win.fire('resize');
        await tick();
        for (const b of d.boxes) assert.equal('translate' in b.el.style, false);
        // a drag moves the box as usual
        const bg = box.el.children[0];
        bg.fire('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
        bg.fire('pointermove', { clientX: 5, clientY: 7 });
        bg.fire('pointerup');
        assert.deepEqual([box.el.style.left, box.el.style.top, 'translate' in box.el.style], ['105px', '281px', false]);
        d.close();
        assert.equal(d._offKeys ?? null, null);
        // with a mouse at 125 % SSP's image-pixel size: scale(0.8), as communicate.test.mjs
        globalThis.matchMedia = q => ({ matches: q === '(pointer: fine)' });
        globalThis.devicePixelRatio = 1.25;
        d.communicateBox({ onSend() {} });
        assert.equal(d.boxes[0].el.style.transform, 'scale(0.8)');
        assert.match(d.boxes[0].input.style.font, /^12px /);
        assert.deepEqual([w.vv.listeners(), w.win.listeners()], [0, 0]);
        d.destroy();
      } finally {
        w.restore();
      }
    }
  }
});

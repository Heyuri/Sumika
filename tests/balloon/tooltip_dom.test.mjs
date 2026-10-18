// Tooltips on the fake DOM (UI §4.8): a BalloonView's pointer events (mouse rests, touch never), the tip box element
// in the shadow root (role, lang, z-index, pointer-events, placement), the balloon's colours (the grid cell under the
// pointer, in balloon px), the wrap width in device px and aria-describedby.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake_dom.mjs';
import { play } from './script.mjs';
import { FakeClock } from '../runtime/fakes.mjs';

installFakeDom();
const { Balloons } = await import('../../src/balloon/manager.js');
const { BalloonSkin } = await import('../../src/balloon/skin.js');
const { getRoot } = await import('../../src/ui/root.js');
const { TipBox, TIP_Z, TIP_ID, placeTip, tipColors } = await import('../../src/ui/tooltip.js');

const stage = {
  on: () => () => {},
  char: () => ({ rect: { x: 900, y: 300, width: 200, height: 400 }, balloonOffset: { x: 2, y: 14 } }),
};

test('a mouse rest on a choice shows the box in the shadow root with the balloon\'s colours; touch never; a press hides it', async () => {
  const clock = new FakeClock();
  const tips = new TipBox({ clock });
  const skin = BalloonSkin.fallback();
  const b = new Balloons({ skin, stage, clock, tips });
  const asked = [], sel = [];
  b.tipSource = item => { asked.push(item.id); return 'Line 1\nLine 2'; };
  b.on('select', ev => sel.push(ev.index));
  play(b, '\\0\\q[Alpha,a]\\n\\n\\n\\n\\q[Beta,b]\\e');
  const v = b.get(0);
  const main = v.dom.main;
  const at = i => { const r = v.engine.linkRects(i)[0]; return [r.x + 3, r.y + 3]; };   // balloon px
  const pt = i => { const [x, y] = at(i); return { clientX: v.x + x, clientY: v.y + y }; };
  // the balloon image: white, except the 6 x 8 grid cell (over the validrect) under Beta's point, which is blue
  const vr = v.img.geo.validRect, cw = vr.right - vr.left, ch = vr.bottom - vr.top;
  const col = Math.trunc(((at(1)[0] - vr.left) * 6) / cw), row = Math.trunc(((at(1)[1] - vr.top) * 8) / ch);
  assert.ok(row > 0, 'Beta is not in the first cell');
  const x0 = vr.left + Math.trunc((col * cw) / 6), x1 = vr.left + Math.trunc(((col + 1) * cw) / 6);
  const y0 = vr.top + Math.trunc((row * ch) / 8), y1 = vr.top + Math.trunc(((row + 1) * ch) / 8);
  const BLUE = [40, 120, 200];
  skin.sourceOf(v.img).pixels = (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? [...BLUE, 255] : [255, 255, 255, 255]);
  main.fire('pointerenter', { pointerType: 'touch' });
  main.fire('pointermove', { ...pt(1), pointerType: 'touch' });
  await clock.advance(1000);
  assert.deepEqual([sel, asked, tips.owner], [[], [], null], 'touch: no selection, no tip');
  assert.equal(v.hoverLink, 1, 'the highlight still follows');
  main.fire('pointermove', { ...pt(0), pointerType: 'mouse' });
  await clock.advance(500);
  assert.deepEqual(sel, [0]);
  assert.deepEqual(asked, ['a']);
  const el = tips.el;
  assert.equal(el.parent, getRoot(), 'at root level, above every ghost layer');
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, 'Line 1\nLine 2');
  assert.equal(el.getAttribute('role'), 'tooltip');
  assert.equal(el.getAttribute('lang'), '', 'the ghost\'s text');
  assert.equal(el.style.background, 'rgb(255,255,255)', 'the dominant colour of the cell under the pointer');
  assert.equal(el.style.color, 'rgb(84,32,27)', 'the balloon\'s font.color');
  assert.equal(el.style.borderColor, 'rgb(84,32,27)');
  assert.equal(el.style.maxWidth, 'min(500px,calc(100vw - 14px))', '500 device px at devicePixelRatio 1');
  const pos = placeTip({ x: pt(0).clientX, y: pt(0).clientY }, { w: 300, h: 150 }, { width: 1280, height: 720 });
  assert.deepEqual([el.style.left, el.style.top], [pos.left + 'px', pos.top + 'px']);
  assert.equal(main.getAttribute('aria-describedby'), TIP_ID, 'the canvas is described by the tip while it shows');
  const css = getRoot().getElementById('style-tooltip').textContent;
  assert.ok(css.includes(`z-index:${TIP_Z}`) && css.includes('pointer-events:none') && css.includes('white-space:pre-wrap'));
  // Beta, in the blue cell (balloon px decide it, not client px or the first cell); a 125 % display
  globalThis.devicePixelRatio = 1.25;
  main.fire('pointermove', { ...pt(1), pointerType: 'mouse' });
  await clock.advance(500);
  globalThis.devicePixelRatio = 1;
  assert.deepEqual([sel.at(-1), asked.at(-1), tips.owner], [1, 'b', v]);
  const blue = tipColors(BLUE, [84, 32, 27]);
  assert.equal(el.style.background, 'rgb(40,120,200)', 'the dominant colour of the cell under the pointer');
  assert.equal(el.style.color, `rgb(${blue.fg.join(',')})`, 'font.color refitted for contrast on blue');
  assert.notEqual(blue.fg.join(','), '84,32,27');
  assert.equal(el.style.maxWidth, 'min(400px,calc(100vw - 14px))', '500 device px on a 125 % display');
  main.fire('pointermove', { ...pt(0), pointerType: 'mouse' });
  await clock.advance(500);
  assert.equal(el.style.background, 'rgb(255,255,255)', 'back on Alpha: white');
  main.fire('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: pt(0).clientX, clientY: pt(0).clientY });
  assert.equal(el.hidden, true, 'a press hides it');
  assert.equal(main.getAttribute('aria-describedby'), null);
  main.fire('pointerup', { button: 0, pointerId: 1, clientX: pt(0).clientX, clientY: pt(0).clientY });
  main.fire('pointerleave', { pointerType: 'mouse' });
  main.fire('pointermove', { ...pt(0), pointerType: 'mouse' });
  await clock.advance(500);
  assert.deepEqual(asked, ['a', 'b', 'a', 'a'], 'leaving the window forgot the text');
  b.destroy();
  assert.equal(tips.owner, null);
  tips.destroy();
});

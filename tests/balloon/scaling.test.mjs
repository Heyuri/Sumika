// Balloon scaling (UI §2.1 #9) and crisp canvases at display scaling (125 %): on a fake DOM whose
// getBoundingClientRect honours the balloon element's CSS scale(). Backing stores, CSS sizes, the click-wait marker,
// placement next to a (shell-scaled) character, choice hit testing, hover and dragging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, tick } from './fake_dom.mjs';
import { fixture } from './setup.mjs';
import { play } from './script.mjs';
import { Emitter } from '../../src/core/emitter.js';
import { cssScale } from '../../src/core/scaling.js';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

installFakeDom();
globalThis.devicePixelRatio = 1.25;          // a common Windows display scaling (125 %)
const { Balloons } = await import('../../src/balloon/manager.js');

/** A character at (900, 100), 200×400 viewport px, balloon offset (2, 14) in shell px; `scale` = shell scaling. */
class MockStage extends Emitter {
  constructor(scale = 1) { super(); this.scale = scale; }
  char() { return { rect: { x: 900, y: 100, width: 200, height: 400 }, balloonOffset: { x: 2, y: 14 } }; }
}

const SCRIPT = '\\0\\b[2]\\_q\\_l[0,50]\\__q[ok]\\_b["menu\\choice5.png",inline]\\__q\\_l[@0,@-16]　 Sure\\n\\e';
const CHOICE = [23 + 100, 13 + 55];          // balloon px of a point on the choice (dom.test.mjs)
const setTransforms = ctx => ctx.calls.filter(c => c[0] === 'setTransform').map(c => c.slice(1));

test('click-wait marker at 125 %: backing store × devicePixelRatio, CSS size in image px, nearest-neighbour', real, async () => {
  const { skin, ghost } = await fixture();
  const b = new Balloons({ skin, ghostFiles: ghost, stage: new MockStage() });
  const v = b.get(0);
  play(b, '\\0\\b[2]Hello\\e');
  v.showClickWait(true);
  const part = skin.clickwait(0) || skin.arrow(1, 0);
  const w = v.dom.wait;
  assert.equal(w.hidden, false);
  assert.equal(w.width, Math.round(part.w * 1.25), 'backing store in device pixels');
  assert.equal(w.height, Math.round(part.h * 1.25));
  assert.equal(w.style.width, part.w + 'px', 'shown at its image size: the browser does not stretch it');
  assert.equal(w.style.height, part.h + 'px');
  const ctx = w.getContext('2d');
  assert.deepEqual(setTransforms(ctx).at(-1), [1.25, 0, 0, 1.25, 0, 0]);
  assert.equal(ctx.imageSmoothingEnabled, false);
  // like the other canvases of the balloon
  assert.equal(v.dom.main.width, Math.round(340 * 1.25));
  assert.equal(v.dom.main.style.width, '340px');
  assert.equal(v.dom.el.style.transform, '', 'no balloon scaling: no transform');
  b.destroy();
});

test('balloon scaling: crisp canvases, placed next to the (shell-scaled) character, choices hit where they are drawn', real, async () => {
  const { skin, ghost } = await fixture();
  const s100 = cssScale(100, 1.25);         // 0.8: one image pixel per device pixel
  const b = new Balloons({ skin, ghostFiles: ghost, stage: new MockStage(2), scale: s100 });
  const v = b.get(0);
  await b.images.prefetch(['menu\\choice5.png']);
  play(b, SCRIPT);
  const el = v.dom.el;
  assert.equal(el.style.transform, 'scale(0.8)');
  assert.equal(el.style.transformOrigin, '0 0');
  assert.equal(el.style.width, '340px', 'the element keeps image px inside (clip-path, positions)');
  assert.equal(v.dom.main.width, 340, 'backing 340 × 1.25 × 0.8: exactly one canvas pixel per device pixel');
  assert.equal(v.dom.main.height, 384);
  const r0 = v.rect;
  assert.deepEqual([r0.x, r0.y, r0.width, Math.round(r0.height * 10) / 10], [900 - 340 * 0.8 + 2 * 2, 100 + 14 * 2, 272, 307.2],
    'left of the character; the shell offset grows with the shell scaling');
  await tick(10);
  assert.deepEqual(setTransforms(v.dom.mctx).at(-1), [1, 0, 0, 1, 0, 0]);
  const got = [];
  b.on('link', l => got.push(l.id));
  const at = s => [v.x + CHOICE[0] * s, v.y + CHOICE[1] * s];
  let [x, y] = at(0.8);
  v.dom.main.fire('click', { clientX: x, clientY: y });
  assert.deepEqual(got, ['ok'], 'a click on the drawn choice selects it');
  v.dom.main.fire('click', { clientX: v.x + CHOICE[0], clientY: v.y + CHOICE[1] + 60 });
  assert.deepEqual(got, ['ok'], 'the unscaled place is not the choice any more');

  // 200 %: twice the image size in device pixels
  const s200 = cssScale(200, 1.25);
  b.setScale(s200);
  assert.equal(v.scale, 1.6);
  assert.equal(el.style.transform, 'scale(1.6)');
  assert.equal(v.dom.main.width, 680, 'backing 340 × 1.25 × 1.6');
  assert.equal(v.dom.main.style.width, '340px');
  const r = v.rect;
  assert.equal(r.width, 544);
  assert.equal(r.x, 900 - 544 + 4);
  assert.equal(r.y, Math.round(720 - 384 * 1.6), 'kept inside the viewport');
  await tick(10);
  assert.deepEqual(setTransforms(v.dom.mctx).at(-1), [2, 0, 0, 2, 0, 0], 'text drawn at the device resolution');
  [x, y] = at(1.6);
  v.dom.main.fire('pointermove', { clientX: x, clientY: y });
  assert.equal(v.dom.main.classList.contains('smk-link'), true, 'hover finds the choice too');
  await tick(10);
  assert.deepEqual(setTransforms(v.dom.hctx).at(-1), [2, 0, 0, 2, 0, 0], 'the highlight as crisp as the text');
  v.dom.main.fire('click', { clientX: x, clientY: y });
  assert.deepEqual(got, ['ok', 'ok']);
  v.showClickWait(true);
  const part = skin.clickwait(0) || skin.arrow(1, 0);
  assert.equal(v.dom.wait.width, Math.round(part.w * 2));
  assert.equal(v.dom.wait.style.width, part.w + 'px');

  // a drag is clamped with the scaled size; a new balloon gets the scale too
  const ptr = (px, py) => ({ clientX: px, clientY: py, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true });
  v.dom.main.fire('pointerdown', ptr(x, y));
  v.dom.main.fire('pointermove', ptr(x + 2000, y));
  v.dom.main.fire('pointerup', ptr(x + 2000, y));
  assert.equal(v.x, 1280 - 544);
  assert.equal(b.get(1).scale, 1.6);
  b.destroy();
});

/** run f with window.devicePixelRatio = dpr, then back to 1.25 */
async function atDpr(dpr, f) {
  globalThis.devicePixelRatio = dpr;
  try { await f(); } finally { globalThis.devicePixelRatio = 1.25; }
}

test('an explicit percentage is exact at any page zoom: 100 % at devicePixelRatio 0.8 (zoomed out) is one canvas pixel per device pixel', real, () => atDpr(0.8, async () => {
  const { skin, ghost } = await fixture();
  const b = new Balloons({ skin, ghostFiles: ghost, stage: new MockStage(), scale: cssScale(100, 0.8) });
  const v = b.get(0);
  play(b, '\\0\\b[2]Hello\\e');
  v.showClickWait(true);
  assert.equal(v.scale, 1.25);
  assert.equal(v.dom.main.width, 340, 'backing 340 = 340 image px × 1.25 CSS × 0.8 device px each: no downsampling');
  const part = skin.clickwait(0) || skin.arrow(1, 0);
  assert.equal(v.dom.wait.width, part.w);
  await tick(10);
  assert.deepEqual(setTransforms(v.dom.mctx).at(-1), [1, 0, 0, 1, 0, 0]);
  b.setScale(cssScale(200, 0.8));
  assert.equal(v.dom.main.width, 680, '200 %: twice the image, whatever the zoom');
  b.destroy();
}));

test('devicePixelRatio changing under the default scale: refreshResolution redraws a waiting balloon at once', real, async () => {
  const { skin, ghost } = await fixture();
  const b = new Balloons({ skin, ghostFiles: ghost, stage: new MockStage() });
  const v = b.get(0);
  play(b, '\\0\\b[2]Hello\\e');
  v.showClickWait(true);
  await tick(10);
  assert.equal(v.dom.main.width, 425);
  await atDpr(2, async () => {
    b.setScale(1);                                       // what UserScaling.apply does for no choice: nothing changes
    assert.equal(v.dom.main.width, 425);
    b.refreshResolution();
    assert.equal(v.dom.main.width, 680, 'backing at the new devicePixelRatio without waiting for a repaint');
    const part = skin.clickwait(0) || skin.arrow(1, 0);
    assert.equal(v.dom.wait.width, part.w * 2, 'the click-wait marker too');
    await tick(10);
    assert.deepEqual(setTransforms(v.dom.mctx).at(-1), [2, 0, 0, 2, 0, 0], 'the text is drawn again');
    const n = v.dom.mctx.calls.length;
    b.refreshResolution();                                // nothing changed since: no work
    await tick(10);
    assert.equal(v.dom.mctx.calls.length, n);
  });
  b.destroy();
});

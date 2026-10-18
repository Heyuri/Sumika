// A balloon's text-area numbers for currentghost.balloon.scope(N).* (BalloonModel#metrics, properties.md §5.7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BalloonSkin } from '../../src/balloon/skin.js';
import { BalloonModel, balloonMetrics } from '../../src/balloon/model.js';
import { Balloons } from '../../src/balloon/manager.js';
import { skinGeometry, skinFont } from '../../src/balloon/geometry.js';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('error');

/** An in-memory skin: balloons0 / balloonk0 with the origin inside the valid rect, balloons2 another image and font. */
function fixtureSkin() {
  const descript = new Map([['font.height', '12'], ['validrect.left', '10'], ['validrect.top', '12'],
    ['validrect.right', '-10'], ['validrect.bottom', '-20'], ['origin.x', '20'], ['origin.y', '30'], ['wordwrappoint.x', '250']]);
  const img = (name, w, h, extra = []) => {
    const cfg = new Map([...descript, ...extra]);
    return [name, { name, w, h, cfg, geo: skinGeometry(cfg, w, h), font: skinFont(cfg), source: null, hit: null, draw: null }];
  };
  const images = new Map([
    img('balloons0', 300, 200),
    img('balloonk0', 200, 100, [['origin.x', '5'], ['origin.y', '5'], ['wordwrappoint.x', '-5']]),
    img('balloons2', 400, 300, [['font.height', '16'], ['validrect.left', '30'], ['origin.x', '24'], ['wordwrappoint.x', '500']]),
  ]);
  return new BalloonSkin({ name: 'fixture', descript, images, parts: new Map() });
}

test('the five formulas: x0/y0 = origin clamped into validrect; widths, heights, lines; basePos (SetBalloon, CreateBackBuffer)', () => {
  const m = new BalloonModel({ scope: 0, skin: fixtureSkin() });
  // validrect 10,12 – 290,180; origin 20,30; wrap 250; font 12 → line height 14
  assert.deepEqual(m.metrics(), {
    validWidth: 250 - 20, validWidthInitial: 290 - 20, validHeight: 180 - 12, validHeightInitial: 180 - 30,
    lines: Math.trunc((168 + 2) / 14), linesInitial: Math.trunc((150 + 2) / 14), basePos: { x: 20, y: 30 }, charWidth: 6,
    vertical: 0,
  });
  // kero: origin left of / above the valid rect is raised into it; wrap 195 (right edge −5) is past right 190
  const k = new BalloonModel({ scope: 1, skin: fixtureSkin() }).metrics();
  assert.deepEqual([k.validWidth, k.validWidthInitial, k.validHeight, k.validHeightInitial, k.basePos],
    [190 - 10, 190 - 10, 80 - 12, 80 - 12, { x: 10, y: 12 }]);
});

test('\\b[2] changes them (the image in use); answered before the balloon was ever shown', () => {
  const m = new BalloonModel({ scope: 0, skin: fixtureSkin() });
  assert.equal(m.visible, false);
  m.setKind(2);
  const b = m.metrics();
  // validrect 30,12 – 390,280; origin.x 24 raised to 30; wrap 500 past right; font 16 → line height 18
  assert.deepEqual([b.validWidth, b.validWidthInitial, b.validHeight, b.validHeightInitial, b.lines, b.basePos.x, b.charWidth],
    [390 - 30, 390 - 30, 280 - 12, 280 - 30, Math.trunc(270 / 18), 30, 8]);
  m.setKind(0);
  assert.equal(m.metrics().validWidth, 230);
});

test('char_width: the layout\'s mean advance of A–Z, height ÷ 2 without a canvas; Balloons#metrics(scope)', () => {
  const geo = skinGeometry(new Map(), 100, 100);
  assert.equal(balloonMetrics(geo, { height: 12 }).charWidth, 6);
  assert.equal(balloonMetrics(geo, { height: 20 }, () => 99).charWidth, 10, 'A–Z keep MS Gothic\'s half width');
  const b = new Balloons({ skin: fixtureSkin(), root: null });
  assert.deepEqual(b.metrics(0), new BalloonModel({ scope: 0, skin: fixtureSkin() }).metrics());
  assert.equal(b.metrics(1).basePos.x, 10);
  const empty = new BalloonSkin({ name: 'empty', descript: new Map(), images: new Map(), parts: new Map() });
  assert.equal(new BalloonModel({ scope: 0, skin: empty }).metrics(), null, 'no image: null');
});

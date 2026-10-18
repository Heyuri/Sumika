// Pure helpers: metrics, colours, ROP2, colour keying on LightBlue's real PNGs, clip paths, placement.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { advance, widthClass, isBlank, lineHeight } from '../../src/balloon/metrics.js';
import { parseColor, cfgColor } from '../../src/balloon/color.js';
import { ROP2, ropMode, applyRop } from '../../src/balloon/rop.js';
import { pngSize, applyColorKey, applyMask, forceOpaque, opaqueRects, rectsToPath } from '../../src/balloon/bitmap.js';
import { placeBalloon, placeBox } from '../../src/balloon/placement.js';
import { scanImagePaths } from '../../src/balloon/images.js';
import { parseImageOptions } from '../../src/balloon/model.js';
import { formatInput, isComposing } from '../../src/balloon/dialogs.js';
import { decodePng, TSUBASA } from './node_helpers.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');
const LB = path.join(TSUBASA, 'LightBlue');

test('CP932 width classes', () => {
  for (const c of 'Az09 ~ｱﾝ') assert.equal(widthClass(c.codePointAt(0)), 1, c);
  for (const c of 'あア漢　←→↓―※…♪×÷°§ΑΩЖ「」＠１') assert.equal(widthClass(c.codePointAt(0)), 2, c);
  assert.equal(widthClass('é'.codePointAt(0)), 0);
  assert.equal(advance('é'.codePointAt(0), 12, () => 7.4), 7, 'not in CP932: measured');
  assert.equal(advance('é'.codePointAt(0), 12, null), 6);
  assert.equal(advance(0x1f600, 12, null), 12);
  assert.ok(isBlank(0x20) && isBlank(0x3000) && !isBlank(0x41));
  assert.equal(lineHeight(12), 14);
});

test('colour grammar', () => {
  assert.deepEqual(parseColor('84,32,27'), [84, 32, 27]);
  assert.deepEqual(parseColor(' 100%, 0%, 50% '), [255, 0, 128]);
  assert.deepEqual(parseColor('#F0a'), [255, 0, 170]);
  assert.deepEqual(parseColor('#123456'), [0x12, 0x34, 0x56]);
  assert.deepEqual(parseColor('cornflowerblue'), [100, 149, 237]);
  assert.equal(parseColor('none'), 'none');
  assert.equal(parseColor('default.anchor'), 'default.anchor');
  assert.equal(parseColor('1,2'), null);
  assert.equal(parseColor('#12'), null);
  const c = parseColor('1,2,3');
  c[0] = 99;
  assert.deepEqual(parseColor('1,2,3'), [1, 2, 3], 'cached results are not shared');
  assert.deepEqual(cfgColor(new Map([['x.r', '1'], ['x.g', '2'], ['x.b', '300']]), 'x', null), [1, 2, 255]);
  assert.equal(cfgColor(new Map(), 'x', 'def'), 'def');
});

test('ROP2: LightBlue notmaskpen highlight values (BA §3.8)', () => {
  const brush = [150, 100, 100];
  const px = rgb => { const d = new Uint8ClampedArray([...rgb, 255]); applyRop(d, 'notmaskpen', brush); return [...d.slice(0, 3)]; };
  assert.deepEqual(px([255, 255, 255]), [105, 155, 155]);
  assert.deepEqual(px([250, 247, 249]), [109, 155, 159]);
  assert.deepEqual(px([84, 32, 27]), [235, 223, 255]);
  assert.deepEqual(px([195, 195, 239]), [125, 191, 155]);
  assert.equal(Object.keys(ROP2).length, 16);
  assert.equal(ropMode('R2_XORPEN'), 'xorpen');
  assert.equal(ropMode('bogus'), null);
  const d = new Uint8ClampedArray([10, 20, 30, 0]);
  applyRop(d, 'not', [0, 0, 0]);
  assert.deepEqual([...d], [245, 235, 225, 0], 'alpha untouched');
});

test('colour key on LightBlue images: green balloons, white arrows', real, () => {
  const b = fs.readFileSync(path.join(LB, 'balloons0.png'));
  assert.deepEqual(pngSize(b), { w: 340, h: 170, alpha: false });
  const img = decodePng(b);
  assert.deepEqual([...img.data.slice(0, 3)], [0, 255, 0]);
  applyColorKey(img.data, img.w, img.h);
  const a = (x, y) => img.data[(y * img.w + x) * 4 + 3];
  assert.equal(a(0, 0), 0);
  assert.equal(a(5, 20), 0, 'left margin transparent');
  assert.equal(a(170, 85), 255, 'body opaque');
  assert.equal(a(339, 66), 255, 'tail tip on the right edge (left-placed image)');
  const rects = opaqueRects(img.data, img.w, img.h);
  assert.ok(rects.length > 3 && rects.length < 200, 'compact clip path: ' + rects.length);
  const area = rects.reduce((s, r) => s + r.w * r.h, 0);
  let opaque = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) opaque++;
  assert.equal(area, opaque, 'rects cover exactly the opaque pixels');
  assert.match(rectsToPath(rects), /^path\("M\d+ \d+h\d+v\d+h-\d+z/);
  const arrow = decodePng(fs.readFileSync(path.join(LB, 'arrow1.png')));
  assert.deepEqual([...arrow.data.slice(0, 3)], [255, 255, 255]);
  applyColorKey(arrow.data, arrow.w, arrow.h);
  assert.ok(arrow.data.some((v, i) => i % 4 === 3 && v === 255));
});

test('RGBA \\_b images are keyed by colour, not by their alpha (choice5.png)', real, () => {
  const file = path.join(TSUBASA, 'ghost/master/menu/choice5.png');
  const s = pngSize(fs.readFileSync(file));
  assert.deepEqual(s, { w: 300, h: 19, alpha: true });
  const img = decodePng(fs.readFileSync(file));
  const key = [...img.data.slice(0, 3)];
  applyColorKey(img.data, img.w, img.h);
  for (let i = 0; i < img.data.length; i += 4) {
    const isKey = img.data[i] === key[0] && img.data[i + 1] === key[1] && img.data[i + 2] === key[2];
    assert.equal(img.data[i + 3], isKey ? 0 : 255);
  }
  const d = new Uint8ClampedArray([1, 2, 3, 7, 1, 2, 3, 9]);
  forceOpaque(d);
  assert.deepEqual([d[3], d[7]], [255, 255]);
  const m = new Uint8ClampedArray([0, 2, 3, 255, 5, 5, 5, 255]);
  applyMask(m, new Uint8ClampedArray([0, 0, 0, 255, 128, 128, 128, 255]), 2, 1, true);
  assert.deepEqual([...m], [0, 0, 0, 0, 5, 5, 5, 128], 'PNA alpha; key-coloured pixels painted black');
});

test('\\_b option parsing and script scanning', () => {
  assert.deepEqual(parseImageOptions(['opaque', '--option=background']), { mode: 'opaque', fg: false, fixed: false, clip: null });
  assert.deepEqual(parseImageOptions(['--option=foreground', '--option=fixed']), { mode: 'key', fg: true, fixed: true, clip: null });
  assert.deepEqual(parseImageOptions(['--clipping=0 74 60 148']).clip, [0, 74, 60, 148]);
  assert.equal(parseImageOptions(['--clipping=5 5 1 1']).clip, null);
  assert.equal(parseImageOptions(['--option=use_self_alpha']).mode, 'self');
  assert.deepEqual(scanImagePaths('\\_b["menu\\choice5.png",inline]\\_b[card\\field.png,inline,--clipping=0 0 60 74]\\_b["a""b.png",0,0]'),
    ['menu\\choice5.png', 'card\\field.png', 'a"b.png']);
});

test('balloon placement (BA §4): sides, offsets, flip, clamp', () => {
  const vp = { width: 1280, height: 720 };
  const char = { x: 900, y: 300, width: 200, height: 400 };
  const size = { w: 340, h: 384 };
  // character on the right half: balloon on the left, top-right corner at the shell's top-left (+2,+14 offsets)
  assert.deepEqual(placeBalloon({ char, size, offset: { x: 2, y: 14 }, viewport: vp }), { x: 900 - 340 + 2, y: 314, side: 'left' });
  // no room on the left: balloon on the right
  const left = { x: 100, y: 300, width: 200, height: 400 };
  assert.deepEqual(placeBalloon({ char: left, size, offset: { x: 2, y: 14 }, viewport: vp }), { x: 298, y: 314, side: 'right' });
  // user toggle, but it would be cut off on the left: flips back
  assert.equal(placeBalloon({ char: left, size, prefer: 'left', viewport: vp }).side, 'right');
  assert.equal(placeBalloon({ char, size, prefer: 'right', viewport: vp }).side, 'left', 'no room on the right');
  const mid = { x: 700, y: 300, width: 200, height: 400 };
  assert.equal(placeBalloon({ char: mid, size, viewport: vp }).side, 'left');
  // the left half of the screen with room on the left: still left; it switches only when cut off [observed]
  for (const x of [400, 341, 340]) assert.equal(placeBalloon({ char: { ...mid, x }, size, viewport: vp }).side, 'left', `x ${x}`);
  assert.equal(placeBalloon({ char: { ...mid, x: 339 }, size, viewport: vp }).side, 'right', 'one pixel cut off');
  assert.equal(placeBalloon({ char: mid, size, prefer: 'right', viewport: vp }).side, 'right', 'right click choice kept while it fits');
  // clamp into the viewport (limit = 1)
  const low = placeBalloon({ char: { x: 900, y: 600, width: 200, height: 100 }, size, viewport: vp });
  assert.equal(low.y, 720 - 384);
  assert.equal(placeBalloon({ char, size, viewport: vp, windowPosition: { x: 'top', y: 0, limit: true } }).side, 'top');
  assert.equal(placeBalloon({ char, size, viewport: vp, align: 'right' }).side, 'right');
  const wp = placeBalloon({ char, size, viewport: vp, windowPosition: { x: 10, y: 5, limit: false } });
  assert.deepEqual([wp.x, wp.y], [900 - 340 + 10, 305]);
});

test('input box placement and value formats', () => {
  const vp = { width: 1000, height: 700 };
  assert.deepEqual(placeBox({ size: { w: 322, h: 42 }, balloon: { x: 100, y: 100, width: 340, height: 170 }, viewport: vp }), { x: 100, y: 274 });
  assert.deepEqual(placeBox({ size: { w: 322, h: 42 }, balloon: { x: 100, y: 100, width: 340, height: 170 }, index: 1, viewport: vp }), { x: 100, y: 320 });
  assert.deepEqual(placeBox({ size: { w: 322, h: 42 }, char: { x: 600, y: 300, width: 200, height: 400 }, viewport: vp }), { x: 539, y: 250 });
  assert.deepEqual(placeBox({ size: { w: 322, h: 42 }, at: { x: 5000, y: -5 }, viewport: vp }), { x: 678, y: 0 });
  assert.equal(formatInput('date', '2026-03-07'), '2026,3,7');
  assert.equal(formatInput('time', '09:05:00'), '9,5,0');
  assert.equal(formatInput('text', 'a,b'), 'a,b');
  assert.equal(isComposing({ isComposing: true }), true);
  assert.equal(isComposing({ keyCode: 229 }), true);
  assert.equal(isComposing({ keyCode: 13 }), false);
});

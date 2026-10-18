// ssp.exe's per-surface collision box (EV §3.2.1, SH §6.9): the real rect of an image, the element box, the < 50 px
// fallback over animation patterns, the 80 % shrink, real shells' values, and CharacterView.collisionRect on the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createImage, realRect } from '../../src/shell/compositor.js';
import { SurfaceRenderer, shrink80, COLL_SKIP, COLL_SKIP_IMAGELESS } from '../../src/shell/render.js';
import { parseShell, sortSurfaceFiles } from '../../src/shell/surfaces.js';
import { decodeText } from '../../src/core/loader.js';
import { ROOT, SHELL_DIR, tsubasaShell, fsImages, sizedStage } from './helpers.mjs';
import { needs } from '../needs.mjs';

const MAYURA = path.join(ROOT, 'site/ghost/mayura/shell/master');

/** a w×h image, alpha `a` inside [x0, y0, x1, y1) (x1 / y1 exclusive), 0 elsewhere */
function boxImg(w, h, box = null, a = 255) {
  const im = createImage(w, h);
  if (box) for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) im.data[(y * w + x) * 4 + 3] = a;
  return im;
}

/** a shell from one surfaces.txt, its images given as file -> Img (a missing key: still loading) */
function synthetic(text, imgs, loading = []) {
  const files = [...Object.keys(imgs), ...loading];
  const shell = parseShell({ descript: '', surfaces: [{ name: 'surfaces.txt', text }], files });
  const images = { get: p => (p in imgs ? imgs[p] : undefined) };
  return new SurfaceRenderer(shell, images);
}

function shellAt(dir) {
  const names = readdirSync(dir);
  const lower = new Map(names.map(n => [n.toLowerCase(), n]));
  const surf = sortSurfaceFiles(names.filter(n => /^surfaces.*\.txt$/i.test(n)));
  return parseShell({
    descript: decodeText(readFileSync(path.join(dir, lower.get('descript.txt')))),
    surfaces: surf.map(n => ({ name: n, text: decodeText(readFileSync(path.join(dir, n))) })),
    files: names,
  });
}

const ltrb = b => b && [b.l, b.t, b.r, b.b];

test('realRect: alpha > 8 counts; r / b are the last column / row; nothing kept gives the zero-size centre', () => {
  const im = boxImg(5, 4);
  im.data[3] = 8;                                        // (0,0) alpha 8: dropped as transparent
  im.data[(1 * 5 + 1) * 4 + 3] = 9;
  im.data[(2 * 5 + 3) * 4 + 3] = 9;
  assert.deepEqual(realRect(im), { l: 1, t: 1, r: 3, b: 2 });
  assert.equal(realRect(im), realRect(im), 'cached per image');
  assert.deepEqual(realRect(boxImg(5, 4)), { l: 2, t: 2, r: 2, b: 2 });
  assert.deepEqual(realRect(boxImg(220, 380, [54, 10, 197, 380])), { l: 54, t: 10, r: 196, b: 379 });
});

test('shrink80: MultiplyRectH/V(0.8), every step truncated toward zero', () => {
  assert.deepEqual(shrink80({ l: -3, t: 0, r: 4, b: 10 }), { l: -2, t: 1, r: 2, b: 9 });
  assert.deepEqual(shrink80({ l: -5, t: -7, r: 0, b: -2 }), { l: -4, t: -6, r: 0, b: -2 }, 'centre -2.5 → -2, -4.5 → -4');
  assert.deepEqual(shrink80({ l: 54, t: 10, r: 196, b: 379 }), { l: 69, t: 47, r: 181, b: 341 });
  assert.deepEqual(shrink80({ l: 0, t: 0, r: 0, b: 0 }), { l: 0, t: 0, r: 0, b: 0 });
});

test('pattern methods the fallback leaves out: base only for a surface with elements', () => {
  for (const m of ['move', 'start', 'stop', 'insert', 'alternativestart', 'alternativestop', 'parallelstart', 'parallelstop', 'import', 'noop', 'scaling']) {
    assert.ok(COLL_SKIP.has(m) && COLL_SKIP_IMAGELESS.has(m), m);
  }
  assert.ok(COLL_SKIP.has('base') && !COLL_SKIP_IMAGELESS.has('base'));
  for (const m of ['overlay', 'add', 'bind', 'overlayfast', 'interpolate', 'reduce', 'replace', 'asis', 'blend-multiply']) {
    assert.ok(!COLL_SKIP.has(m), m);
  }
});

const TEXT = `charset,UTF-8
descript
{
version,1
}
surface10
{
animation0.interval,always
animation0.pattern0,overlay,11,100,100,0
animation0.pattern1,move,-1,100,5,5
animation1.interval,bind
animation1.pattern0,base,12,0,0,-50
}
surface20
{
animation0.interval,always
animation0.pattern0,base,11,100,0,0
}
surface30
{
element1,overlay,e.png,50,50
}
surface31
{
element0,overlay,e.png,0,0
}
`;

function syntheticShell(loading = []) {
  return synthetic(TEXT, {
    'surface0.png': boxImg(200, 300, [20, 10, 180, 300]),
    'surface10.png': boxImg(100, 100, [40, 0, 70, 100]),
    'surface11.png': boxImg(60, 60, [0, 0, 60, 60]),
    'surface12.png': boxImg(20, 20, [0, 0, 20, 20]),
    'surface30.png': boxImg(100, 100, [0, 0, 10, 10]),
    'surface31.png': boxImg(100, 100, [0, 0, 10, 10]),
    'surface40.png': boxImg(80, 80),
    'e.png': boxImg(60, 60, [0, 0, 60, 60]),
  }, loading);
}

test('collisionBox: the element box shrunk to 80 %; under 50 px the animation patterns join it', () => {
  const R = syntheticShell();
  assert.deepEqual(ltrb(R.realBox(0)), [20, 10, 179, 299]);
  assert.deepEqual(ltrb(R.collisionBox(0)), [36, 39, 162, 269]);
  // 29 px wide: overlay 11 at (100,0) joins; move and the bind group's base (the surface has an element) do not
  assert.deepEqual(ltrb(R.realBox(10)), [40, 0, 69, 99]);
  assert.deepEqual(ltrb(R.collisionBox(10)), [52, 10, 146, 88]);
  // no image: 0×0, so it starts from nothing; base counts here
  assert.deepEqual(ltrb(R.realBox(20)), [0, 0, 0, 0]);
  assert.deepEqual(ltrb(R.collisionBox(20)), [6, 6, 52, 52]);
  // surfaceN.png stays the implicit element beside element1; element0 replaces it
  assert.deepEqual(R.sspElements(30).map(e => e.file), ['surface30.png', 'e.png']);
  assert.deepEqual(ltrb(R.collisionBox(30)), [11, 11, 97, 97]);
  assert.deepEqual(R.sspElements(31).map(e => e.file), ['e.png']);
  assert.deepEqual(ltrb(R.collisionBox(31)), [6, 6, 52, 52]);
  // a transparent image: an empty box (never counts)
  assert.deepEqual(ltrb(R.collisionBox(40)), [0, 0, 0, 0]);
  assert.equal(R.collisionBox(99), null, 'no such surface');
  R.clear();
  assert.deepEqual(ltrb(R.collisionBox(10)), [52, 10, 146, 88], 'clear() keeps the boxes');
});

test('collisionBox: undefined while an image loads, its path in `missing`', () => {
  const R = synthetic('descript\n{\nversion,1\n}\nsurface50\n{\nelement0,overlay,late.png,0,0\n}\n', {}, ['late.png']);
  const missing = [];
  assert.equal(R.collisionBox(50, missing), undefined);
  assert.deepEqual(missing, ['late.png']);
  // the fallback waits for the counted pattern surfaces' images too (not the skipped base 12's)
  const S = synthetic(TEXT, { 'surface10.png': boxImg(100, 100, [40, 0, 70, 100]) }, ['surface11.png', 'surface12.png']);
  const miss = [];
  assert.equal(S.collisionBox(10, miss), undefined);
  assert.deepEqual(miss, ['surface11.png']);
});

test('Tsubasa: collision boxes of her surfaces 0, 10, 11, 12', needs('site/ghost/tsubasa'), () => {
  const R = new SurfaceRenderer(tsubasaShell().shell, fsImages(SHELL_DIR));
  assert.deepEqual(ltrb(R.realBox(0)), [54, 10, 196, 379]);
  assert.deepEqual(ltrb(R.collisionBox(0)), [69, 47, 181, 341], '112×294 of her 220×380 image');
  assert.deepEqual(ltrb(R.collisionBox(11)), [8, 14, 74, 126], 'the music box: under 50 px high, the fallback');
  assert.deepEqual(ltrb(R.collisionBox(12)), [12, 18, 74, 126], 'the playing music box has no image');
  assert.deepEqual(ltrb(R.collisionBox(10)), [0, 0, 0, 0], 'her blank 4×4 \\1 never counts');
});

test('mayura: collision boxes of surfaces 0 and 10 (Kawari 7 shell with .pna masks)', needs('site/ghost/mayura'), () => {
  const R = new SurfaceRenderer(shellAt(MAYURA), fsImages(MAYURA));
  assert.deepEqual(ltrb(R.collisionBox(0)), [131, 63, 411, 415], '280×352 of the 471×460 image');
  assert.deepEqual(ltrb(R.collisionBox(10)), [17, 25, 125, 115]);
});

test('CharacterView.collisionRect: the box on the desk, scaled, never mirrored; null when hidden; undefined while loading', async () => {
  const stage = await sizedStage({ sizes: { 0: [220, 380], 5: [100, 100], 10: [4, 4] }, opaque: { 0: [54, 10, 197, 380] } });
  const v = stage.char(0);
  await stage.images.load(['surface0.png']);
  assert.deepEqual(v.rect, { x: 1060, y: 340, width: 220, height: 380 });
  assert.deepEqual(v.collisionRect, { x: 1129, y: 387, width: 112, height: 294 });
  // a blank surface: an empty box
  v.setSurface(5);
  assert.equal(v.collisionRect, undefined, 'its image is still loading');
  await stage.images.load(['surface5.png']);
  assert.equal(v.collisionRect, null);
  v.setSurface(0);
  // \![set,scaling,-100,100]: the window mirrors about the base point, the box keeps its unmirrored offset
  v.setScaling(-100, 100);
  const r = v.rect;
  assert.deepEqual(v.collisionRect, { x: r.x + 69, y: r.y + 47, width: 112, height: 294 });
  v.setScaling(100, 100);
  v.hide();
  assert.equal(v.collisionRect, null);
  v.show();
  // the user's shell scaling: each edge truncated after scaling
  const big = await sizedStage({ sizes: { 0: [220, 380], 10: [4, 4] }, opaque: { 0: [54, 10, 197, 380] }, scale: 1.25 });
  await big.images.load(['surface0.png']);
  const b = big.char(0);
  assert.deepEqual(b.rect, { x: 1005, y: 245, width: 275, height: 475 });
  assert.deepEqual(b.collisionRect, { x: 1005 + 86, y: 245 + 58, width: 226 - 86, height: 426 - 58 });
});

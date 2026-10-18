// Compositing tests: methods on hand-made pixels, SSP transparency rules, canvas growth, and Tsubasa's real images
// against the reference renders in tests/shell/fixtures/renders (made by docs/research/scratch/ref_compose.py; made
// from her shell, so like the ghost they are not in the repository, and the test that reads them skips without them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImage, prepareImage, drawInto, GrowCanvas, composeLayers, alphaAt, opaqueRects, clipPathFor } from '../../src/shell/compositor.js';
import { SurfaceRenderer } from '../../src/shell/render.js';
import { parseShell } from '../../src/shell/surfaces.js';
import { tsubasaShell, fsImages, referenceView, compareWithRender } from './helpers.mjs';
import { needs } from '../needs.mjs';

function img(w, h, px, ox = 0, oy = 0) {
  const im = createImage(w, h, ox, oy);
  for (let i = 0; i < w * h; i++) im.data.set(px(i % w, Math.floor(i / w)), i * 4);
  return im;
}
const at = (im, x, y) => [...im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4)];

test('prepareImage: colour key from the top-left pixel; PNG alpha ignored', () => {
  const png = img(2, 2, (x, y) => (x === 1 && y === 1 ? [10, 20, 30, 128] : [0, 255, 0, 255]));
  const out = prepareImage(png, null);
  assert.deepEqual(at(out, 0, 0), [0, 255, 0, 0]);
  assert.deepEqual(at(out, 1, 1), [10, 20, 30, 255]);
});

test('prepareImage: PNA alpha (gray, RGB-coded, luminance fallback) and black paint of key pixels', () => {
  const png = img(3, 1, x => [[200, 100, 50, 255], [200, 100, 50, 255], [1, 2, 3, 255]][x]);
  const pna = img(3, 1, x => [[0, 0, 0, 255], [128, 128, 128, 255], [255, 0, 0, 255]][x]);
  const out = prepareImage(png, pna);
  assert.deepEqual(at(out, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(out, 1, 0), [0, 0, 0, 128]);           // key colour with PNA > 0 -> black (paint default)
  assert.deepEqual(at(out, 2, 0), [1, 2, 3, 76]);            // non-gray PNA pixel: luminance
  const noPaint = prepareImage(png, pna, { paintBlack: false });
  assert.deepEqual(at(noPaint, 1, 0), [200, 100, 50, 128]);
  // a PNA smaller than its PNG: missing pixels are transparent
  const small = prepareImage(png, img(1, 1, () => [255, 255, 255, 255]));
  assert.equal(at(small, 1, 0)[3], 0);
});

test('prepareImage: use_self_alpha', () => {
  const png = img(2, 1, x => [[9, 9, 9, 255], [50, 60, 70, 100]][x]);
  assert.deepEqual(at(prepareImage(png, null, { useSelfAlpha: '1' }), 1, 0), [50, 60, 70, 100]);
  assert.deepEqual(at(prepareImage(png, null, { useSelfAlpha: '1' }), 0, 0), [9, 9, 9, 255]);
  const opaque = img(2, 1, x => [[9, 9, 9, 255], [50, 60, 70, 255]][x]);
  assert.deepEqual(at(prepareImage(opaque, null, { useSelfAlpha: 'full' }), 0, 0), [9, 9, 9, 255]);
  assert.deepEqual(at(prepareImage(opaque, null, { useSelfAlpha: '1' }), 0, 0), [9, 9, 9, 0]);   // no alpha channel: colour key
});

test('methods: overlay, interpolate, overlayfast, replace, reduce, asis', () => {
  const dst = () => img(3, 1, x => [[100, 0, 0, 255], [100, 0, 0, 0], [100, 0, 0, 128]][x]);
  const src = img(3, 1, () => [0, 0, 200, 128]);
  let d = dst(); drawInto(d, src, 0, 0, 'overlay');
  assert.deepEqual(at(d, 0, 0), [50, 0, 100, 255]);
  assert.deepEqual(at(d, 1, 0), [0, 0, 200, 128]);
  assert.deepEqual(at(d, 2, 0), [33, 0, 134, 192]);
  d = dst(); drawInto(d, src, 0, 0, 'interpolate');
  assert.deepEqual(at(d, 0, 0), [100, 0, 0, 255]);           // opaque dst untouched
  assert.deepEqual(at(d, 1, 0), [0, 0, 200, 128]);
  assert.deepEqual(at(d, 2, 0), [67, 0, 66, 192]);
  d = dst(); drawInto(d, src, 0, 0, 'overlayfast');
  assert.deepEqual(at(d, 0, 0), [50, 0, 100, 255]);
  assert.deepEqual(at(d, 1, 0), [100, 0, 0, 0]);             // dst outline unchanged
  assert.deepEqual(at(d, 2, 0)[3], 128);
  d = dst(); drawInto(d, img(1, 1, () => [1, 2, 3, 0]), 0, 0, 'replace');
  assert.deepEqual(at(d, 0, 0), [1, 2, 3, 0]);
  assert.deepEqual(at(d, 2, 0), [100, 0, 0, 128]);
  d = dst(); drawInto(d, img(2, 1, x => [0, 0, 0, x ? 255 : 128]), 0, 0, 'reduce');
  assert.deepEqual(at(d, 0, 0), [100, 0, 0, 128]);           // alpha multiplied, colour kept
  assert.deepEqual(at(d, 2, 0)[3], 0);                       // outside the mask: transparent
  d = dst(); drawInto(d, img(1, 1, () => [7, 8, 9, 0]), 1, 0, 'asis');
  assert.deepEqual(at(d, 1, 0), [7, 8, 9, 255]);
});

test('GrowCanvas / composeLayers grow in every direction; reduce never grows', () => {
  const base = img(2, 2, () => [255, 0, 0, 255]);
  const part = img(1, 1, () => [0, 255, 0, 255]);
  const c = new GrowCanvas(base);
  c.draw(part, -2, -1, 'overlay');
  assert.deepEqual([c.img.ox, c.img.oy, c.img.width, c.img.height], [-2, -1, 4, 3]);
  assert.deepEqual(at(c.img, 0, 0), [0, 255, 0, 255]);
  assert.deepEqual(at(c.img, 2, 1), [255, 0, 0, 255]);
  c.draw(img(10, 10, () => [0, 0, 0, 255]), 5, 5, 'reduce');
  assert.deepEqual([c.img.width, c.img.height], [4, 3]);
  assert.equal(alphaAt(c.img, 0, 0), 0);
  // composeLayers: part images carry their own origin
  const out = composeLayers([
    { img: base, x: 0, y: 0, method: 'overlay' },
    { img: img(1, 1, () => [0, 0, 255, 255], -1, -1), x: 3, y: 0, method: 'add' },
  ]);
  assert.deepEqual([out.ox, out.oy, out.width, out.height], [0, -1, 3, 3]);
  assert.deepEqual(at(out, 2, 0), [0, 0, 255, 255]);
  assert.equal(alphaAt(out, 2, -1), 255);
});

test('opaque rectangles and clip-path', () => {
  const m = img(4, 3, (x, y) => [0, 0, 0, (x === 1 || x === 2) && y < 2 ? 255 : y === 2 && x === 0 ? 10 : 0]);
  assert.deepEqual(opaqueRects(m), [1, 0, 2, 2, 0, 2, 1, 1]);
  assert.equal(clipPathFor(m), "path('M1 0h2v2h-2zM0 2h1v1h-1z')");
  assert.equal(clipPathFor(createImage(3, 3)), '');
});

const CASES = [
  ['s0_nobind.png', 0, [], {}],
  ['s0_default.png', 0, [0, 51, 30, 49], {}],
  ['s0_veil.png', 0, [17, 0, 51, 30, 49], { 0: 1, 200: 0 }],
  ['s0_witch_maid_apron.png', 0, [12, 173, 183, 0, 30, 49], {}],
  ['s1.png', 1, [0, 51, 30, 49], {}],
  ['s521.png', 521, [], {}],
  ['s521_hair2.png', 521, [2], {}],
  ['s600.png', 600, [], {}],
  ['s9425.png', 9425, [], {}],
];
const RENDERED = needs('site/ghost/tsubasa', 'tests/shell/fixtures/renders');

test('Tsubasa: compositions match the reference renders', RENDERED, () => {
  const { shell } = tsubasaShell();
  const images = fsImages();
  for (const [file, sid, binds, frames] of CASES) {
    const r = new SurfaceRenderer(shell, images);
    const surf = shell.surface(sid);
    const on = new Set(binds);
    const anim = {
      offset: () => null,
      baseOverride: () => null,
      frame: id => {
        const k = frames[id];
        if (k === undefined) return null;
        const p = surf.anims.get(id).patterns.find(q => q.index === k);
        return { surface: p.surface, x: p.x, y: p.y, method: p.method, alpha: p.alpha };
      },
    };
    const { image, missing } = r.compose(surf, { bindOn: id => on.has(id), anim });
    assert.deepEqual(missing, []);
    const b = r.base(sid);
    const res = compareWithRender(referenceView(image, { x: b.ox, y: b.oy, w: b.width, h: b.height }), file, 2);
    assert.ok(res.sameSize, `${file}: size ${JSON.stringify(res)}`);
    assert.equal(res.over, 0, `${file}: ${res.over} pixels differ by more than 2 (max ${res.maxDiff})`);
  }
});

test('Tsubasa: canvas growth and base rect (witch hat above the head, element at -10)', needs('site/ghost/tsubasa'), () => {
  const { shell } = tsubasaShell();
  const images = fsImages();
  const r = new SurfaceRenderer(shell, images);
  const on = new Set([12, 173, 183, 0, 30, 49]);
  const anim = { offset: () => null, baseOverride: () => null, frame: () => null };
  const { image } = r.compose(shell.surface(0), { bindOn: id => on.has(id), anim });
  assert.deepEqual([image.ox, image.oy, image.width, image.height], [0, -50, 240, 430]);
  assert.deepEqual(r.baseRect(0), { x: 0, y: 0, w: 220, h: 380 });
  assert.deepEqual(r.baseRect(600), { x: -10, y: 0, w: 230, h: 380 });
  // image-less surface: as big as its animation frames with the origin. The playing music box 12 (13–15 at 0,0)
  // must stand where 11 stands, or its window drops below the screen edge [observed: the box vanished on play]
  assert.deepEqual(r.baseRect(12), r.baseRect(11));
  assert.deepEqual(r.baseRect(12), { x: 0, y: 0, w: 90, h: 150 });
  assert.equal(r.base(12).width, 0, 'its base image itself stays empty: the animation draws the box');
  assert.deepEqual(r.baseFiles(12).sort(), ['surface0013.png', 'surface0014.png', 'surface0015.png']);
  assert.deepEqual(r.baseRect(10), { x: 0, y: 0, w: 4, h: 4 });
  // surface 10 (\1's default) is a fully transparent 4x4
  assert.equal(opaqueRects(r.base(10)).length, 0);
});

test('Tsubasa: compose cost with cached images (static prefix cache)', needs('site/ghost/tsubasa'), () => {
  const { shell } = tsubasaShell();
  const images = fsImages();
  const r = new SurfaceRenderer(shell, images);
  const surf = shell.surface(0);
  const on = new Set([0, 51, 30, 49, 17]);
  let mouth = null;
  const anim = { offset: () => null, baseOverride: () => null, frame: id => (id === 200 ? mouth : null) };
  r.compose(surf, { bindOn: id => on.has(id), anim });   // warm images
  const N = 40;
  let t0 = performance.now();
  for (let i = 0; i < N; i++) r.compose(surf, { bindOn: id => on.has(id), anim });
  const staticMs = (performance.now() - t0) / N;
  t0 = performance.now();
  for (let i = 0; i < N; i++) {
    mouth = i % 2 ? { surface: 1100, x: 110, y: 100, method: 'overlay' } : null;
    r.compose(surf, { bindOn: id => on.has(id), anim });
  }
  const flapMs = (performance.now() - t0) / N;
  console.log(`  surface 0 + 5 groups: ${staticMs.toFixed(2)} ms/compose static, ${flapMs.toFixed(2)} ms/compose with a mouth flap`);
  assert.ok(staticMs < 50 && flapMs < 50);
});

// ---------------------------------------------------------------- element lists (ssp.exe's rule, render.js elementList)

const RED = [200, 0, 0, 255], BLUE = [0, 0, 200, 255], GREEN = [0, 160, 0, 255], NONE = [0, 0, 0, 0];
const solid = (w, h, px) => img(w, h, () => px);

/** one surfaces.txt over images given as file -> Img: a renderer on decoded images and one on sizes alone */
function elementShell(text, files) {
  const shell = parseShell({ descript: '', surfaces: [{ name: 'surfaces.txt', text }], files: Object.keys(files) });
  const size = p => (p in files ? files[p] && { width: files[p].width, height: files[p].height } : null);
  return { shell, r: new SurfaceRenderer(shell, { get: p => files[p] }), bySize: new SurfaceRenderer(shell, { get: () => undefined, size }) };
}

test('elements draw in the order read, the first one drawn plainly whatever its method (sagiri_tama)', () => {
  const head = img(4, 4, x => (x < 2 ? RED : NONE));               // opaque on the left half only
  const keyed = img(2, 1, x => (x ? BLUE : [9, 9, 9, 0]));          // a key-coloured (transparent) pixel at 0,0
  const { r, bySize } = elementShell([
    // the head in a shared block, the face as element0 later: overlayfast paints the face onto the head only
    'surface2', '{', 'element1,overlay,canvas.png,0,0', 'element2,overlay,head.png,0,0', '}',
    'surface.append2', '{', 'element0,overlayfast,face.png,0,0', '}',
    // a lone element0 overlayfast is the first drawn: it draws
    'surface0', '{', 'element0,overlayfast,head.png,0,0', '}',
    // reduce first: drawn plainly, so it grows the canvas; a later overlayfast lands on it
    'surface3', '{', 'element0,reduce,face.png,0,0', 'element1,overlayfast,dot.png,0,0', '}',
    // asis first is a plain draw too: its key colour stays transparent; a later asis keeps it opaque
    'surface4', '{', 'element0,asis,keyed.png,0,0', '}',
    'surface5', '{', 'element0,overlay,dot.png,0,0', 'element1,asis,keyed.png,0,0', '}',
  ].join('\n'), { 'canvas.png': solid(4, 4, NONE), 'head.png': head, 'face.png': solid(4, 4, BLUE), 'dot.png': solid(1, 1, GREEN), 'keyed.png': keyed });
  const b2 = r.base(2);
  assert.deepEqual([at(b2, 0, 0), at(b2, 1, 3), at(b2, 3, 0)], [BLUE, BLUE, NONE], 'the face on the head, nothing beside it');
  assert.deepEqual(at(r.base(0), 1, 1), RED);
  const b3 = r.base(3);
  assert.deepEqual([b3.width, at(b3, 0, 0), at(b3, 3, 3)], [4, GREEN, BLUE]);
  assert.equal(alphaAt(r.base(4), 0, 0), 0, 'asis drawn first: the key colour stays transparent');
  assert.equal(alphaAt(r.base(5), 0, 0), 255, 'asis drawn later keeps the key colour opaque');
  for (const id of [0, 2, 3, 4, 5]) assert.deepEqual(bySize.baseRect(id), r.baseRect(id), 'size-only rect of ' + id);
});

test('element list: surfaceN.png first unless element0, missing files skipped, repeats (ssp.exe AddSurfaceElement)', () => {
  const half = img(2, 1, x => (x ? [0, 0, 200, 128] : NONE));       // a half-transparent pixel at 1,0
  const { r, bySize } = elementShell([
    // surfaceN.png stays under element1 (Nato 11, kamakiri 0) ...
    'surface10', '{', 'element1,overlay,dot.png,2,0', '}',
    // ... until an element0 line whose file exists removes it
    'surface11', '{', 'element1,overlay,dot.png,2,0', 'element0,overlay,dot.png,0,0', '}',
    'surface12', '{', 'element0,overlay,gone.png,0,0', 'element1,overlay,dot.png,2,0', '}',
    // the first element whose file is missing does not count: the next one is the first drawn
    'surface20', '{', 'element0,overlay,gone.png,0,0', 'element1,overlayfast,dot.png,0,0', '}',
    // an identical repeat is drawn once (in one block or another), a different one too (that_morning: five element0)
    'surface30', '{', 'element0,overlay,half.png,0,0', 'element0,overlay,half.png,0,0', '}',
    'surface.append30', '{', 'element0,base,half.png,0,0', '}',
    'surface31', '{', 'element0,bace,dot.png,0,0', 'element0,bace,half.png,1,1', 'element0,bace,dot.png,2,2', '}',
  ].join('\n'), {
    'surface10.png': solid(1, 1, RED), 'surface11.png': solid(1, 1, RED), 'surface12.png': solid(1, 1, RED),
    'dot.png': solid(1, 1, GREEN), 'half.png': half,
  });
  const b10 = r.base(10);
  assert.deepEqual([b10.width, at(b10, 0, 0), at(b10, 2, 0)], [3, RED, GREEN]);
  assert.deepEqual(r.baseFiles(10), ['surface10.png', 'dot.png']);
  const b11 = r.base(11);
  assert.deepEqual([at(b11, 0, 0), at(b11, 2, 0)], [GREEN, GREEN], 'element0 removed surface11.png');
  assert.deepEqual(r.baseFiles(11), ['dot.png', 'dot.png']);
  assert.deepEqual(at(r.base(12), 0, 0), RED, 'an element0 whose file is missing leaves surface12.png');
  assert.deepEqual(at(r.base(20), 0, 0), GREEN, 'overlayfast drawn first');
  assert.equal(alphaAt(r.base(30), 1, 0), 128, 'drawn once: base reads as overlay, so the append line is a repeat too');
  assert.deepEqual(r.elementList(30).length, 1);
  const b31 = r.base(31);
  assert.deepEqual([at(b31, 0, 0), alphaAt(b31, 2, 1), at(b31, 2, 2)], [GREEN, 128, GREEN], 'all three element0 lines drawn');
  assert.deepEqual(r.sspElements(10).map(e => e.file), ['surface10.png', 'dot.png']);
  for (const id of [10, 11, 12, 20, 30, 31]) assert.deepEqual(bySize.baseRect(id), r.baseRect(id), 'size-only rect of ' + id);
});

test('element list: a repeat is compared with the first earlier element of its number; broken first images; image-less', () => {
  const half = img(2, 1, x => (x ? [0, 0, 200, 128] : NONE));
  const { r, bySize } = elementShell([
    'descript', '{', 'version,1', '}',
    // dot, half, half: the second half differs from the FIRST element1 (dot), so it is drawn again
    'surface40', '{', 'element1,overlay,dot.png,0,0', 'element1,overlay,half.png,0,0', 'element1,overlay,half.png,0,0', '}',
    // the method counts: overlay and overlayfast are two records; add is overlay, so a repeat
    'surface41', '{', 'element1,overlay,half.png,0,0', 'element1,overlayfast,half.png,0,0', '}',
    'surface42', '{', 'element1,overlay,half.png,0,0', 'element1,add,half.png,0,0', '}',
    // surfaceN.png removed by the first element0; the identical second one is a repeat of it
    'surface43', '{', 'element0,overlay,dot.png,0,0', 'element0,overlay,dot.png,0,0', '}',
    // a file that is there but does not decode is not the first drawn: overlayfast after it draws plainly
    'surface44', '{', 'element0,overlay,broken.png,0,0', 'element1,overlayfast,dot.png,0,0', '}',
    // every element file missing and no png: image-less, sized by its animation frames like a text-only surface
    'surface45', '{', 'element0,overlay,gone.png,0,0', 'animation0.interval,always', 'animation0.pattern0,overlay,46,100,5,3', '}',
    'surface46', '{', 'element0,overlay,dot.png,0,0', '}',
    // the same number at another place is a second record: the element box joins both
    'surface47', '{', 'element1,overlay,big.png,0,0', 'element1,overlay,big.png,5,0', '}',
  ].join('\n'), { 'surface43.png': solid(1, 1, RED), 'dot.png': solid(1, 1, GREEN), 'half.png': half, 'broken.png': null, 'big.png': solid(3, 2, GREEN) });
  assert.equal(r.elementList(40).length, 3);
  assert.ok(alphaAt(r.base(40), 1, 0) > 180, 'half drawn twice');
  assert.deepEqual([r.elementList(41).length, r.elementList(42).length], [2, 1]);
  assert.deepEqual(r.elementList(43).map(e => e.file), ['dot.png']);
  assert.deepEqual(at(r.base(43), 0, 0), GREEN);
  assert.deepEqual(at(r.base(44), 0, 0), GREEN);
  assert.deepEqual(r.baseRect(45), { x: 0, y: 0, w: 6, h: 4 });
  assert.deepEqual(r.baseFiles(45), ['dot.png'], 'the frames are fetched');
  const box = r.realBox(47);
  assert.deepEqual([box.l, box.t, box.r, box.b], [0, 0, 7, 1], 'the element box joins every record');
  for (const id of [40, 41, 42, 43, 44, 45, 47]) assert.deepEqual(bySize.baseRect(id), r.baseRect(id), 'size-only rect of ' + id);
});

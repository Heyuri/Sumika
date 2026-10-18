// The canvas painter against a recording 2D context: layer order, clipping, incremental paints, ROP highlight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBalloons } from './setup.mjs';
import { Painter, fontCss, linkStyle, overPixels } from '../../src/balloon/paint.js';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

function recorder(w = 340, h = 384, pixel = [255, 255, 255, 255]) {
  const calls = [];
  const state = { globalCompositeOperation: 'source-over', font: '', fillStyle: '', strokeStyle: '' };
  const stack = [];
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return { width: w, height: h };
      if (k === 'save') return () => { stack.push({ ...state }); calls.push(['save']); };
      if (k === 'restore') return () => { Object.assign(state, stack.pop()); calls.push(['restore']); };
      if (k === 'measureText') return s => ({ width: [...s].length * 6 });
      if (k === 'getImageData') return (x, y, iw, ih) => {
        const data = new Uint8ClampedArray(iw * ih * 4);
        for (let i = 0; i < data.length; i += 4) data.set(pixel, i);
        calls.push(['getImageData', x, y, iw, ih]);
        return { data, width: iw, height: ih };
      };
      return (...a) => calls.push([k, state.globalCompositeOperation, ...a]);
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ctx, calls };
}

/** Wrap a recorder context so fillRect/fillText calls are logged with the fillStyle in effect. */
function styled(base) {
  const fills = [];
  const ctx = new Proxy(base, {
    get: (t, k) => (k === 'fillRect' || k === 'fillText' ? (...a) => { fills.push([k, t.fillStyle, ...a]); t[k](...a); } : t[k]),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { ctx, fills };
}

test('paint: balloon, background images (source-atop), text clipped to validRect, foreground on top', real, async () => {
  const { balloons, run } = await makeBalloons();
  await run('\\0\\b[2]\\_q\\c\\_b["menu\\icon\\sky3.png",0,0]\\_b["card\\1.png",25,24,--option=foreground]\\_l[0,50]' +
    '\\__q[a]\\_b["menu\\choice5.png",inline]\\__q\\_l[@0,@-16]　 Sure\\n\\f[strike,1]\\f[shadowcolor,none]X\\e');
  const v = balloons.get(0);
  const fake = { tag: 'bitmap' };
  v.images.source = ref => ({ ...fake, key: ref.key });
  v.skin.sourceOf = img => (img ? { tag: 'skin', name: img.name } : null);
  const p = new Painter(v);
  const { ctx, calls } = recorder();
  p.paint(ctx, true);
  const draws = calls.filter(c => c[0] === 'drawImage').map(c => [c[1], c[2].name || c[2].key.split('|')[0]]);
  assert.deepEqual(draws, [
    ['source-over', 'balloons2'],
    ['source-atop', 'ghost/master/menu/icon/sky3.png'],
    ['source-atop', 'ghost/master/menu/choice5.png'],
    ['source-over', 'ghost/master/card/1.png'],
  ]);
  const clip = calls.findIndex(c => c[0] === 'clip');
  const rect = calls[clip - 1];
  assert.deepEqual(rect.slice(2), [0, 0, 340, 372], 'text clipped to validRect');
  const texts = calls.filter(c => c[0] === 'fillText').map(c => [c[2], c[3], c[4]]);
  // "Sure" with the LightBlue offset shadow (+1,+1) drawn first; X without shadow
  assert.deepEqual(texts.slice(0, 2), [['S', 23 + 18 + 1, 13 + 53 + 1], ['S', 23 + 18, 13 + 53]]);
  assert.deepEqual(texts.at(-1), ['X', 23, 13 + 67]);
  assert.ok(calls.some(c => c[0] === 'fillRect' && c[3] === 13 + 67 + 7), 'strike line at y + round(h*0.55)');
  assert.equal(p.count, v.engine.elements.length);
  assert.equal(p.canAppend(), false, 'a foreground image forces full paints');
});

test('incremental paint draws only new glyphs', real, async () => {
  const { balloons } = await makeBalloons();
  const v = balloons.get(0);
  v.skin.sourceOf = () => null;
  v.write('ab');
  const p = new Painter(v);
  const first = recorder();
  p.paint(first.ctx, true);
  v.write('c');
  assert.equal(p.canAppend(), true);
  const next = recorder();
  p.paint(next.ctx, false);
  const t = next.calls.filter(c => c[0] === 'fillText').map(c => c[2]);
  assert.deepEqual(t, ['c', 'c'], 'shadow + glyph of the new character only');
  assert.ok(!next.calls.some(c => c[0] === 'clearRect'));
  v.clear();
  assert.equal(p.canAppend(), false);
});

test('hover with a ROP blendmethod: only the pen rectangle, text colour unchanged (SSP 2.9, BA §3.8)', real, async () => {
  const { balloons, run } = await makeBalloons();
  await run('\\0\\b[2]\\_l[0,50]\\f[cursorpencolor,250,250,50]\\__q[a]\\_b["menu\\choice5.png",inline]\\__q\\_l[0,80]\\__q[b]Text\\__q\\e');
  const v = balloons.get(0);
  v.images.source = ref => ({ key: ref.key });
  v.skin.sourceOf = img => (img ? { name: img.name } : null);
  v.pointerMove(23 + 10, 13 + 60);
  assert.equal(v.hoverLink, 0);
  const st = linkStyle(v.engine.links[0], true);
  assert.equal(st.method, 'notmaskpen');
  const p = new Painter(v);
  const main = recorder(340, 384, [255, 255, 255, 255]);
  const over = recorder();
  p.paintHover(over.ctx, main.ctx, 2);
  assert.ok(!main.calls.some(c => c[0] === 'getImageData') && !over.calls.some(c => c[0] === 'putImageData'), 'no brush, no ROP');
  const border = over.calls.filter(c => c[0] === 'fillRect').map(c => c.slice(2));
  assert.deepEqual(border, [[23, 63, 300, 1], [23, 81, 300, 1], [23, 63, 1, 19], [322, 63, 1, 19]], 'the 1 px pen rectangle');
  assert.equal(over.ctx.fillStyle, 'rgb(250,250,50)', '\\f[cursorpencolor] still sets the pen');
  // a hovered text choice keeps its colour and gets no brush under it
  v.pointerMove(23 + 3, 13 + 85);
  assert.equal(v.hoverLink, 1);
  const { ctx, fills } = styled(recorder().ctx);
  p.paint(ctx, true);
  assert.deepEqual(fills.filter(f => f[0] === 'fillText' && f[2] === 'T').map(f => f[1]), ['rgb(195,195,239)', 'rgb(84,32,27)'],
    'shadow, then the text in its own colour');
  assert.ok(!fills.some(f => f[0] === 'fillRect' && f[3] === 13 + 80), 'no brush fill');
  assert.equal(fontCss({ italic: false, bold: true, height: 12, name: 'x' }), 'bold 12px x');
});

test('hover with blendmethod none (and copypen, the same plain paint): brush under the text, cursor font colour', real, async () => {
  for (const method of ['none', 'copypen', 'R2_COPYPEN']) {
    const { balloons, run } = await makeBalloons();
    await run(`\\0\\b[2]\\f[cursormethod,${method}]\\f[cursorbrushcolor,10,20,30]\\f[cursorfontcolor,200,0,0]\\_l[0,80]\\__q[b]Text\\__q\\e`);
    const v = balloons.get(0);
    v.skin.sourceOf = () => null;
    const link = v.engine.links[0];
    assert.equal(link.font.cursor.method, 'none', method);
    v.pointerMove(23 + 3, 13 + 85);
    const p = new Painter(v);
    const main = recorder();
    const { ctx, fills } = styled(main.ctx);
    p.paint(ctx, true);
    const brush = fills.findIndex(f => f[1] === 'rgb(10,20,30)');
    assert.deepEqual(fills[brush], ['fillRect', 'rgb(10,20,30)', 23, 13 + 80, 24, 12], 'brush fill');
    const text = fills.findIndex(f => f[0] === 'fillText' && f[1] === 'rgb(200,0,0)');
    assert.ok(text > brush, 'under the text, which is drawn in the cursor font colour');
    const over = recorder();
    p.paintHover(over.ctx, main.ctx, 1);
    assert.equal(over.calls.filter(c => c[0] === 'fillRect').length, 4, 'pen rectangle on top');
    assert.ok(!over.calls.some(c => c[0] === 'putImageData'));
  }
});

test('anchors and underline cursors with a ROP blendmethod: pen only', real, async () => {
  const { balloons, run } = await makeBalloons();
  await run('\\0\\b[2]\\f[anchormethod,xorpen]\\f[anchorstyle,square+underline]\\f[anchorpencolor,0,0,255]\\_a[url]Link\\_a' +
    '\\n\\f[cursorstyle,underline]\\f[cursormethod,notmaskpen]\\__q[c]Choice\\__q\\e');
  const v = balloons.get(0);
  const p = new Painter(v);
  for (const [li, y, n] of [[0, 13 + 5, 5], [1, 13 + 14 + 5, 1]]) {
    v.pointerMove(23 + 3, y);
    assert.equal(v.hoverLink, li);
    const main = recorder(), over = recorder();
    p.paintHover(over.ctx, main.ctx, 1);
    assert.ok(!main.calls.some(c => c[0] === 'getImageData'), 'no ROP');
    const rects = over.calls.filter(c => c[0] === 'fillRect');
    assert.equal(rects.length, n, li ? 'underline only' : 'rectangle and underline');
    assert.deepEqual(rects.at(-1).slice(2), [23, y - 5 + 11, li ? 36 : 24, 1], 'underline at the bottom of the region');
  }
});

test('ropFill: UKADOC\'s ROP fill on the composited pixels plus a plain pen border', real, async () => {
  const { balloons, run } = await makeBalloons();
  await run('\\0\\b[2]\\_l[0,50]\\f[cursorpencolor,250,250,50]\\__q[a]\\_b["menu\\choice5.png",inline]\\__q\\e');
  const v = balloons.get(0);
  v.pointerMove(23 + 10, 13 + 60);
  const p = new Painter(v);
  p.ropFill = true;
  const main = recorder(340, 384, [255, 255, 255, 255]);
  const over = recorder();
  p.paintHover(over.ctx, main.ctx, 2);
  const get = main.calls.find(c => c[0] === 'getImageData');
  assert.deepEqual(get.slice(1), [23 * 2, (13 + 50) * 2, 600, 38], 'device pixels of the button rect');
  const put = over.calls.find(c => c[0] === 'putImageData');
  assert.deepEqual([...put[2].data.slice(0, 4)], [105, 155, 155, 255]);
  assert.equal(over.calls.filter(c => c[0] === 'fillRect').length, 4);
  assert.equal(over.ctx.fillStyle, 'rgb(250,250,50)');
});

test('split paint: foreground images and arrows on their own (unclipped) canvas; the highlight sees them', real, async () => {
  const { balloons, run } = await makeBalloons();
  await run('\\0\\b[2]\\_q\\_l[0,50]\\__q[a]\\_b["menu\\choice5.png",inline]\\__q\\_b["card\\1.png",-30,24,--option=foreground]' +
    '\\n' + 'line\\n'.repeat(30) + '\\e');
  const v = balloons.get(0);
  const sourceOf = v.skin.sourceOf;
  v.images.source = ref => ({ key: ref.key });
  v.skin.sourceOf = img => (img ? { name: img.name } : null);
  try {
    assert.ok(v.engine.maxScroll > 0);
    v.scrollBy(-v.engine.scrollY); // back to the top: the button is visible, so is the down arrow
    const p = new Painter(v);
    const main = recorder(), fg = recorder(340, 384, [0, 0, 0, 255]);
    p.paint(main.ctx, true, fg.ctx);
    const names = calls => calls.filter(c => c[0] === 'drawImage').map(c => c[2].name || c[2].key.split('|')[0]);
    assert.deepEqual(names(main.calls), ['balloons2', 'ghost/master/menu/choice5.png']);
    assert.deepEqual(names(fg.calls), ['ghost/master/card/1.png', 'arrow1']);
    assert.deepEqual(fg.calls[0], ['clearRect', 'source-over', 0, 0, 340, 384], 'cleared first');
    assert.equal(p.canAppend(), true, 'new text can be appended under a separate foreground layer');
    // with ropFill, the highlight's ROP works on what is on screen: foreground over content
    v.hoverLink = 0;
    p.ropFill = true;
    const over = recorder();
    p.paintHover(over.ctx, main.ctx, 1, fg.ctx);
    assert.ok(fg.calls.some(c => c[0] === 'getImageData'));
    const put = over.calls.find(c => c[0] === 'putImageData');
    assert.deepEqual([...put[2].data.slice(0, 4)], [255, 255, 255, 255], 'notmaskpen of the black foreground pixel');
  } finally {
    v.skin.sourceOf = sourceOf;
  }
});

test('overPixels: source-over on straight-alpha RGBA', () => {
  const base = new Uint8ClampedArray([255, 255, 255, 255, 10, 20, 30, 255, 0, 0, 0, 0, 200, 0, 0, 255]);
  const top = new Uint8ClampedArray([0, 0, 0, 0, 1, 2, 3, 255, 100, 50, 0, 128, 0, 0, 200, 128]);
  assert.deepEqual([...overPixels(base, top)], [255, 255, 255, 255, 1, 2, 3, 255, 100, 50, 0, 128, 100, 0, 100, 255]);
});

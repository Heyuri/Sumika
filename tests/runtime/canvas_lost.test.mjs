// A canvas a ghost draws on that cannot draw (src/core/canvas.js): WebKit's canvas memory cap answers
// getContext with null, or gives a canvas resized after it got its context no backing store (it draws nothing and reads
// back zeros). On the fake DOM (tests/balloon/fake_dom.mjs) with getContext null, or every pixel read back transparent,
// for one canvas class: the character view and the balloon view leave nothing on the page and report once
// (Stage / Balloons onCanvasLost), the stage stays veiled; with every canvas granted nothing changes but one 1-pixel
// probe per canvas, never repeated (Chromium warns at a canvas's second read; so a refusal at a later resize goes
// unnoticed, a known limit: core/canvas.js). The decoders throw
// canvasLostError for a context they did not get and give their temporary canvases back (0×0). Then a boot on a real
// Stage whose character canvas got no context: the start fails, nothing is left on the page, the lock is let go, one
// error.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, FakeEl, tick } from '../balloon/fake_dom.mjs';
import { sizedStage, FakeClock } from '../shell/helpers.mjs';
import { settle, FakeShiori, FakeBalloons, FakeDialogs, FakePlayer } from './fakes.mjs';
import { backingLost, releaseCanvas, canvasLostError, isCanvasLost } from '../../src/core/canvas.js';
import { setLogLevel } from '../../src/core/log.js';

installFakeDom();
const document = globalThis.document;
document.addEventListener ||= () => {};
document.removeEventListener ||= () => {};
globalThis.ImageData ||= class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
const { getRoot } = await import('../../src/ui/root.js');
const { Balloons } = await import('../../src/balloon/manager.js');
const { BalloonSkin } = await import('../../src/balloon/skin.js');
const { ImageStore, decodeImage } = await import('../../src/balloon/images.js');
const { decodeImageBrowser, ImageCache } = await import('../../src/shell/images.js');
const { Runtime } = await import('../../src/core/runtime.js');
const { StateStore, memoryStorage } = await import('../../src/core/state.js');

/**
 * Canvases of a class that cannot draw: `none` gets no context, `blank` a context whose backing store is refused
 * (every pixel reads back 0, 0, 0, 0). reads[class]: getImageData pixel reads of that class's canvases.
 */
const lose = { none: null, blank: null };
const reads = {};
const origGetContext = FakeEl.prototype.getContext;
FakeEl.prototype.getContext = function (...a) {
  const cls = String(this.className || '').split(/\s+/)[0] || '';
  if (lose.none && cls === lose.none) return null;
  if (cls && !this.pixels) {
    this.pixels = () => { reads[cls] = (reads[cls] || 0) + 1; return cls === lose.blank ? [0, 0, 0, 0] : [255, 255, 255, 255]; };
  }
  return origGetContext.apply(this, a);
};
after(() => { FakeEl.prototype.getContext = origGetContext; });
const reset = () => { lose.none = lose.blank = null; for (const k of Object.keys(reads)) delete reads[k]; };

/** every element under el with this class */
const withClass = (el, cls) => {
  const out = [];
  const walk = e => { for (const c of e.children || []) { if (String(c.className || '').split(/\s+/).includes(cls)) out.push(c); walk(c); } };
  walk(el);
  return out;
};

/** console.error lines while f runs */
async function errorsOf(f) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(x => (x instanceof Error ? x.message : String(x))).join(' '));
  try { await f(); } finally { console.error = orig; }
  return lines;
}

const TIPS = { show() {}, hide() {}, touch() {}, owner: null };

// ---------------------------------------------------------------- core/canvas.js

test('backingLost: one opaque pixel drawn, read and cleared on a sized canvas (state kept); alpha 0 = no backing store; no size or a throw = granted', () => {
  const cv = new FakeEl('canvas');
  cv.width = 10; cv.height = 10;
  let alpha = 255;
  cv.pixels = () => [0, 0, 0, alpha];
  const ctx = origGetContext.call(cv);
  ctx.fillStyle = 'red';
  assert.equal(backingLost(ctx), false);
  assert.deepEqual(ctx.calls.map(c => c[0]), ['setTransform', 'fillRect', 'clearRect']);
  assert.deepEqual(ctx.calls[1], ['fillRect', 0, 0, 1, 1]);
  assert.equal(ctx.fillStyle, 'red', 'the context\'s state restored');
  alpha = 0;
  assert.equal(backingLost(ctx), true);
  alpha = 1;
  assert.equal(backingLost(ctx), false, 'any alpha: granted (Safari\'s readback noise moves no 255 to 0)');
  cv.width = 0;
  assert.equal(backingLost(ctx), false, 'a canvas of no size has nothing to lose');
  cv.width = 10;
  cv.pixels = () => { throw new Error('tainted'); };
  assert.equal(backingLost(ctx), false);
  assert.equal(ctx.fillStyle, 'red');
  assert.equal(backingLost(null), false);
  assert.equal(backingLost({ canvas: cv }), false, 'no getImageData');
});

test('releaseCanvas: 0×0, null and a throwing setter are fine; canvasLostError / isCanvasLost', () => {
  const c = { width: 30, height: 20 };
  releaseCanvas(c);
  assert.deepEqual(c, { width: 0, height: 0 });
  releaseCanvas(null);
  releaseCanvas({ set width(v) { throw new Error('x'); } });
  const e = canvasLostError('shell image');
  assert.equal(e.name, 'CanvasLost');
  assert.match(e.message, /^shell image: no 2D context/);
  assert.equal(isCanvasLost(e), true);
  assert.equal(isCanvasLost(new Error('x')), false);
  assert.equal(isCanvasLost(null), false);
});

// ---------------------------------------------------------------- the decoders: temporary canvases released

/** createImageBitmap and OffscreenCanvas stand-ins; made: every OffscreenCanvas; ctx null for the n-th (0-based) one */
function decoders({ nullAt = -1 } = {}) {
  const made = [];
  const prev = { createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  globalThis.createImageBitmap = async () => ({ width: 3, height: 2, close() { this.closed = true; } });
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; this.i = made.length; made.push(this); }
    getContext() {
      if (this.i === nullAt) return null;
      const c = this;
      return {
        canvas: c, drawImage() {}, putImageData() {},
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) }),
      };
    }
  };
  return { made, restore: () => Object.assign(globalThis, prev) };
}

test('decodeImageBrowser (shell): its canvas 0×0 once read; no context: canvasLostError, the canvas released too', async () => {
  let d = decoders();
  try {
    const img = await decodeImageBrowser(new ArrayBuffer(8));
    assert.deepEqual([img.width, img.height, img.data.length], [3, 2, 24]);
    assert.deepEqual(d.made.map(c => [c.width, c.height]), [[0, 0]], 'released after the read');
  } finally { d.restore(); }
  d = decoders({ nullAt: 0 });
  try {
    await assert.rejects(decodeImageBrowser(new ArrayBuffer(8)), e => isCanvasLost(e));
    assert.deepEqual(d.made.map(c => [c.width, c.height]), [[0, 0]]);
  } finally { d.restore(); }
});

test('decodeImage (balloon): the source canvas kept, the .pna\'s released; a context missing for either: canvasLostError', async () => {
  let d = decoders();
  try {
    const r = await decodeImage(new ArrayBuffer(8), { mode: 'key', mask: new ArrayBuffer(8) });
    assert.equal(r.source, d.made[0]);
    assert.deepEqual(d.made.map(c => [c.width, c.height]), [[3, 2], [0, 0]], 'the drawing source stays, the mask canvas goes');
  } finally { d.restore(); }
  for (const nullAt of [0, 1]) {
    d = decoders({ nullAt });
    try {
      await assert.rejects(decodeImage(new ArrayBuffer(8), { mode: 'key', mask: new ArrayBuffer(8) }), e => isCanvasLost(e), `canvas ${nullAt}`);
      assert.ok(d.made.every(c => c.width === 0 && c.height === 0), 'nothing kept');
    } finally { d.restore(); }
  }
});

test('ImageCache (shell) and ImageStore (balloon \\_b): a lost decode canvas calls onCanvasLost, the image fails without the "cannot load" warn', async () => {
  const warns = [];
  const ow = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  setLogLevel('warn');
  try {
    let lost = 0;
    const files = { has: () => true, resolve: p => p, bytes: async () => new ArrayBuffer(8) };
    const cache = new ImageCache({ files, decode: async () => { throw canvasLostError('shell image'); }, onCanvasLost: () => lost++ });
    assert.equal(await cache.load('surface0.png').then(x => x[0]), null);
    assert.equal(lost, 1);
    const plain = new ImageCache({ files, decode: async () => { throw new Error('bad png'); }, onCanvasLost: () => lost++ });
    assert.equal(await plain.load('surface1.png').then(x => x[0]), null);
    assert.equal(lost, 1, 'any other failure is no lost canvas');
    assert.equal(warns.filter(w => /cannot load image/.test(w)).length, 1, 'warned for the bad file only');
    // the balloon's \_b images
    const d = decoders({ nullAt: 0 });
    try {
      const gf = { has: () => true, resolve: p => p, bytes: async () => new ArrayBuffer(8) };
      const store = new ImageStore(gf, { prefix: '', decode: true, onCanvasLost: () => lost++ });
      const ref = store.ref('a.png');
      store.info(ref);
      await settle();
      assert.equal(lost, 2);
      assert.equal(store.info(ref), false, 'the image failed');
    } finally { d.restore(); }
  } finally {
    console.warn = ow;
  }
});

// ---------------------------------------------------------------- the character view (Stage)

/** a Stage on the fake DOM: surfaces 0 (100×200) and 1 (120×220) with an opaque box inside a transparent edge, 10 (50×50) transparent */
async function domStage(o = {}) {
  const got = [];
  const stage = await sizedStage({
    sizes: { 0: [100, 200], 1: [120, 220], 10: [50, 50] }, opaque: { 0: [10, 10, 90, 190], 1: [10, 10, 110, 210] },
    dom: true, tips: TIPS, onCanvasLost: (kind, s) => got.push([kind, s]), ...o,
  });
  const frames = async () => { for (let i = 0; i < 4; i++) { await settle(); stage.tick(); } };
  return { stage, got, frames };
}

test('Stage: a character canvas without a context leaves no element, canvas or listener; reported once; the stage stays veiled', async () => {
  reset();
  lose.none = 'smk-surface';
  const before = withClass(getRoot(), 'smk-char').length;
  const { stage, got, frames } = await domStage();
  await frames();
  assert.deepEqual(got.map(g => g[0]), ['character'], 'two characters, one report');
  assert.equal(got[0][1], stage);
  assert.equal(stage.lost, 'character');
  assert.equal(stage.veiled, true);
  assert.equal(stage.char(0).element, null);
  assert.equal(stage.char(1).element, null);
  assert.equal(withClass(getRoot(), 'smk-char').length, before, 'nothing joined the page');
  assert.ok(stage.char(0).image, 'it still composes, headless');
  stage.setVeiled(false);
  assert.equal(stage.veiled, true, 'never unveiled again (a boot\'s unveil)');
  stage.destroy();
  reset();
});

test('Stage: a character canvas whose backing store is refused: hidden at its first paint, nothing put on it, reported once', async () => {
  reset();
  lose.blank = 'smk-surface';
  const { stage, got, frames } = await domStage();
  await frames();
  assert.deepEqual(got.map(g => g[0]), ['character']);
  const v = stage.char(0);
  assert.equal(v.element.style.display, 'none');
  assert.equal(v.canvas.getContext().calls.filter(c => c[0] === 'putImageData').length, 0, 'nothing drawn on it');
  assert.equal(stage.veiled, true);
  v.setSurface(1);
  await frames();
  assert.equal(v.element.style.display, 'none', 'stays hidden');
  assert.equal(got.length, 1);
  stage.destroy();
  reset();
});

test('Stage, canvases granted (the usual case): drawn as usual, one probe per canvas before its first put, none at a later resize', async () => {
  reset();
  const { stage, got, frames } = await domStage({ onCanvasLost: undefined });
  await frames();
  assert.equal(stage.lost, null);
  assert.equal(stage.veiled, false);
  const v = stage.char(0);
  assert.equal(v.element.style.display, '');
  assert.deepEqual([v.canvas.width, v.canvas.height], [100, 200]);
  const calls = v.canvas.getContext().calls.map(c => c[0]);
  assert.deepEqual(calls.slice(0, 4), ['setTransform', 'fillRect', 'clearRect', 'putImageData'], 'the probe, then the paint');
  assert.ok(v.canvas.style.clipPath.startsWith("path('M"));
  assert.equal(reads['smk-surface'], 2, 'one read for each of the two character canvases');
  v.setSurface(1);
  await frames();
  assert.deepEqual([v.canvas.width, v.canvas.height], [120, 220]);
  assert.equal(reads['smk-surface'], 2, 'a resize reads nothing back (Chromium warns at a second read: core/canvas.js)');
  assert.equal(v.canvas.getContext().calls.filter(c => c[0] === 'putImageData').length, 2);
  assert.deepEqual(got, []);
  stage.destroy();
  reset();
});

test('Stage: a shell image\'s decode canvas without a context: reported as \'shell image\', the stage veiled', async () => {
  reset();
  const { stage, got, frames } = await domStage({ decode: async () => { throw canvasLostError('shell image'); } });
  await frames();
  assert.deepEqual(got.map(g => g[0]), ['shell image']);
  assert.equal(stage.veiled, true);
  stage.destroy();
});

// ---------------------------------------------------------------- the balloon view (Balloons)

const stageStub = { on: () => () => {}, char: () => ({ rect: { x: 900, y: 300, width: 200, height: 400 }, balloonOffset: { x: 2, y: 14 } }) };

test('Balloons: a balloon canvas without a context, or with its backing store refused: no .smk-balloon on the page, headless, reported once', async () => {
  for (const [kind, cls] of [['none', 'smk-b-main'], ['none', 'smk-b-wait'], ['blank', 'smk-b-main'], ['blank', 'smk-b-fg'], ['blank', 'smk-b-hover']]) {
    reset();
    lose[kind] = cls;
    const got = [];
    const before = withClass(getRoot(), 'smk-balloon').length;
    const b = new Balloons({ skin: BalloonSkin.fallback(), stage: stageStub, onCanvasLost: k => got.push(k) });
    const v = b.get(0);
    b.get(1);
    assert.equal(v.dom, null, `${kind} ${cls}: headless`);
    assert.equal(withClass(getRoot(), 'smk-balloon').length, before, `${kind} ${cls}: nothing left on the page`);
    assert.deepEqual(got, ['balloon'], `${kind} ${cls}: one report for two balloons`);
    v.show();
    await tick(5);
    b.destroy();
  }
  reset();
});

test('Balloons, canvases granted: on the page as usual; main, fg and hover read back once each, not at a later resize; no report', async () => {
  reset();
  const got = [];
  const b = new Balloons({ skin: BalloonSkin.fallback(), stage: stageStub, onCanvasLost: k => got.push(k) });
  const v = b.get(0);
  assert.ok(v.dom);
  assert.equal(v.dom.el.parent, getRoot());
  assert.deepEqual([reads['smk-b-main'], reads['smk-b-fg'], reads['smk-b-hover']], [1, 1, 1]);
  assert.equal(reads['smk-b-wait'], undefined, 'the click-wait marker is not read');
  v.setScale(2);
  assert.deepEqual([reads['smk-b-main'], reads['smk-b-fg'], reads['smk-b-hover']], [1, 1, 1], 'a resize reads nothing back');
  assert.deepEqual(got, []);
  b.destroy();
  // made without the option (tests, the sweep): the same, nothing reported anywhere
  const plain = new Balloons({ skin: BalloonSkin.fallback(), stage: stageStub });
  assert.ok(plain.get(0).dom);
  plain.destroy();
  reset();
});

test('BalloonSkin.load: an image whose decode canvas got no context is left out and reported once (\'balloon image\')', async () => {
  const d = decoders({ nullAt: 0 });
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
    const names = ['descript.txt', 'balloons0.png', 'balloons1.png'];
    const files = {
      has: p => names.includes(p), list: () => names, text: async () => 'name,t\r\n', bytes: async () => png.buffer.slice(0),
    };
    const got = [];
    const skin = await BalloonSkin.load(files, { decode: true, onCanvasLost: k => got.push(k) });
    assert.deepEqual(got, ['balloon image']);
    assert.ok(skin.images.has('balloons1'), 'the other image loaded');
    assert.ok(!skin.images.has('balloons0'));
  } finally { d.restore(); }
});

// ---------------------------------------------------------------- a boot on a real Stage

test('a boot whose character canvas got no context: start \'failed\', no .smk-char left, the engine stopped, the lock let go, one error', async () => {
  reset();
  lose.none = 'smk-surface';
  const released = [];
  const client = new FakeShiori(() => null);
  client.terminate = () => { client.terminated = true; };
  let stage = null;
  class T extends Runtime {
    async _start() {
      this.ghost = { id: 'g', engine: 'satori' };
      this.state = new StateStore('g', { storage: memoryStorage() });
      this.lock = { async acquire() { return true; }, release() { released.push('g'); } };
      return this._boot({});
    }
    async _ghostCommon() { return { files: { url: p => `http://s/ghost/g/${p}`, has: () => false, list: () => [] }, ghostDescript: new Map(), shellId: 'master' }; }
    async _startEngine() { return { client, r: { hadSave: false } }; }
    async _createStage(o) {
      stage = await sizedStage({ sizes: { 0: [100, 200], 10: [50, 50] }, dom: true, tips: TIPS, state: o.state, onCanvasLost: o.onCanvasLost, clock: new FakeClock(0) });
      return stage;
    }
    async _loadSkin() { return { skin: { balloon: () => null }, name: '', path: '' }; }
    async _createBalloons() { const b = new FakeBalloons(); b.destroy = () => {}; return b; }
    _createDialogs() { return new FakeDialogs(); }
    _createPlayer() { return new FakePlayer(); }
  }
  const before = withClass(getRoot(), 'smk-char').length;
  const rt = new T({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js' });
  setLogLevel('warn');
  let out;
  const errors = await errorsOf(async () => {
    out = await rt.start();
    await settle();
  });
  assert.equal(out, 'failed');
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /failed to start g cannot be drawn: the browser gave its character canvas no drawing memory/);
  assert.equal(rt.parts, null, 'torn down');
  assert.equal(client.terminated, true, 'the engine stopped once it was up');
  assert.deepEqual(released, ['g']);
  assert.equal(withClass(getRoot(), 'smk-char').length, before, 'no .smk-char');
  assert.equal(stage.lost, 'character');
  reset();
});

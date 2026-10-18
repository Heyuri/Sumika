// Phones (ssp-ui §9.11 Item 1, "The phone desk follows the browser bar", F6): layout.js phoneFit against the
// reviewed table, the Stage's `phone` option (fitScale, a visitor's pick winning, a rotation), the phone desk read from
// a fixed probe, and the surfaces' iOS callout. A Stage made without `phone` (every desktop window, any size and
// devicePixelRatio) must stay exactly a desktop Stage: pinned at 1280×720 and 1920×1080.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as layout from '../../src/shell/layout.js';
import { parseShell } from '../../src/shell/surfaces.js';
import { setLogLevel } from '../../src/core/log.js';
import { sizedStage, FakeClock } from './helpers.mjs';

setLogLevel('silent');

const { rectAt, defaultPlace } = layout;
const phone = (w, h, mobileView = true) => ({ short: Math.min(w, h), long: Math.max(w, h), mobileView });
const PHONE = phone(375, 812);
// \0 220×380, \1 4×4: Tsubasa's default surfaces (stage.test.mjs)
const TSUBASA = { 0: [220, 380], 10: [4, 4] };

/** run with devicePixelRatio set (core/scaling.js currentDpr reads the global), restored after */
async function atDpr(dpr, fn) {
  const had = 'devicePixelRatio' in globalThis, prev = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = dpr;
  try { return await fn(); } finally { if (had) globalThis.devicePixelRatio = prev; else delete globalThis.devicePixelRatio; }
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);
const onDesk = (r, desk) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.width <= desk.w + 1e-9 && r.y + r.height <= desk.h + 1e-9;

// ---------------------------------------------------------------- phoneFit (pure)

// base rects of \0's and \1's default surfaces in image px (headless sizes, the UI §9.11 Item 1 table's)
const SHELLS = {
  tsubasa: { w0: 220, h0: 380, w1: 4, h1: 4 },
  emily4: { w0: 253, h0: 385, w1: 255, h1: 161 },
  'bthver.5 master': { w0: 348, h0: 645, w1: 142, h1: 157 },
  dslgs: { w0: 475, h0: 698, w1: 1, h1: 1 },
  mayura: { w0: 471, h0: 460, w1: 148, h1: 128 },
  'katari loligatari': { w0: 267, h0: 320, w1: 106, h1: 296 },
  nato: { w0: 150, h0: 300, w1: 49, h1: 52 },
  'roommate master': { w0: 270, h0: 380, w1: 1, h1: 1 },
  'roommate masterx1.5': { w0: 405, h0: 570, w1: 1, h1: 1 },
};
const PHONES = [[375, 812, 2], [360, 800, 3], [320, 568, 2], [430, 932, 3]];
// the UI §9.11 Item 1 table: SSP's percentage at each phone
const TABLE = {
  tsubasa: [138, 195, 109, 251],
  emily4: [136, 193, 108, 244],
  'bthver.5 master': [81, 120, 80, 147],
  dslgs: [80, 120, 80, 136],
  mayura: [114, 161, 90, 200],
  'katari loligatari': [164, 232, 130, 298],
  nato: [175, 248, 138, 300],
  'roommate master': [138, 195, 109, 251],
  'roommate masterx1.5': [92, 130, 80, 167],
};

test('phoneFit: the UI §9.11 Item 1 table, rounded down to whole device-px percentages', () => {
  for (const [name, sizes] of Object.entries(SHELLS)) {
    PHONES.forEach(([w, h, dpr], i) => {
      const f = layout.phoneFit(sizes, phone(w, h), dpr);
      assert.equal(f.percent, TABLE[name][i], `${name} at ${w}×${h} dpr ${dpr}`);
      near(f.scale, f.percent / (100 * dpr), `${name} at ${w}×${h}: CSS px per image px`);
    });
  }
  const at = (sizes, w, h, dpr) => layout.phoneFit(sizes, phone(w, h), dpr);
  const t375 = at(SHELLS.tsubasa, 375, 812, 2);
  near(220 * t375.scale, 151.8, 'Tsubasa\'s width at 375');
  near(380 * t375.scale, 262.2, 'Tsubasa\'s height at 375');
  const t360 = at(SHELLS.tsubasa, 360, 800, 3);
  near(380 * t360.scale, 247, 'Tsubasa at 360×800: 247 px tall');
  assert.ok(380 * t360.scale <= 360 - layout.FIT.bars, 'whole in landscape under the bars');
  const e = at(SHELLS.emily4, 375, 812, 2);
  assert.ok((253 + 255) * e.scale <= 375 - 2 * layout.FIT.margin, 'emily4\'s pair across the portrait width');
  assert.deepEqual(layout.FIT, { margin: 8, tallLong: 0.4, bars: 112, min: 0.4 });
  assert.ok(Object.isFrozen(layout.FIT));
});

test('phoneFit: orientation-free (only the screen\'s sides enter), never enlarged, the floor on the height only', () => {
  for (const sizes of Object.values(SHELLS)) {
    for (const [w, h, dpr] of PHONES) assert.deepEqual(layout.phoneFit(sizes, phone(h, w), dpr), layout.phoneFit(sizes, phone(w, h), dpr));
  }
  // k ≥ 1: the display's own size (no fit), in SSP's terms round(dpr × 100)
  assert.deepEqual(layout.phoneFit(SHELLS.nato, phone(430, 932), 3), { scale: 1, percent: 300 });
  assert.deepEqual(layout.phoneFit({ w0: 50, h0: 50 }, PHONE, 2), { scale: 1, percent: 200 });
  assert.deepEqual(layout.phoneFit({ w0: 50, h0: 50 }, PHONE, 2.625), { scale: 1, percent: 263 });
  for (const sizes of Object.values(SHELLS)) for (const [w, h, dpr] of PHONES) assert.ok(layout.phoneFit(sizes, phone(w, h), dpr).scale <= 1);
  // the floor (0.4) never beats the width test: a pair 1000 image px wide stays across the screen
  const wide = layout.phoneFit({ w0: 500, h0: 300, w1: 500, h1: 300 }, PHONE, 2);
  assert.deepEqual(wide, { scale: 0.355, percent: 71 });
  assert.ok(wide.scale < layout.FIT.min, 'below the floor');
  // a tall shell: the floor wins over the landscape height (bthver.5 master, dslgs at 360)
  assert.equal(layout.phoneFit(SHELLS.dslgs, phone(360, 800), 3).scale, layout.FIT.min);
});

test('phoneFit: no sizes, no phone or not a mobile page (a ~980-px layout the browser shrinks): no fit', () => {
  assert.equal(layout.phoneFit(null, PHONE, 2), null);
  assert.equal(layout.phoneFit({ w0: 0, h0: 380 }, PHONE, 2), null);
  assert.equal(layout.phoneFit({ w0: 220, h0: 0 }, PHONE, 2), null);
  assert.equal(layout.phoneFit({ w0: NaN, h0: 380 }, PHONE, 2), null);
  assert.equal(layout.phoneFit(SHELLS.tsubasa, null, 2), null);
  assert.equal(layout.phoneFit(SHELLS.tsubasa, phone(375, 812, false), 2), null);
  // \1 missing or unsized counts 0
  assert.deepEqual(layout.phoneFit({ w0: 220, h0: 380 }, PHONE, 2), layout.phoneFit({ w0: 220, h0: 380, w1: 0, h1: 0 }, PHONE, 2));
});

// ---------------------------------------------------------------- the Stage's phone option

test('a phone Stage takes the fit as its scale; both default rects on the screen; a rotation keeps the scale', () => atDpr(2, async () => {
  const desk = { w: 375, h: 660 };
  const s = await sizedStage({ sizes: TSUBASA, desk, phone: PHONE });
  assert.deepEqual(s.phone, PHONE);
  near(s.fitScale, 0.69, 'fitScale');
  near(s.scale, 0.69, 'scale');
  const r0 = s.char(0).rect, r1 = s.char(1).rect;
  near(r0.x, 223.2, '\\0 x'); near(r0.y, 397.8, '\\0 top'); near(r0.width, 151.8, '\\0 width'); near(r0.height, 262.2, '\\0 height');
  assert.ok(onDesk(r0, desk) && onDesk(r1, desk), 'both inside [0, 375]');
  s.setDesk(812, 340);                                    // turned to landscape: a relayout, never a refit
  near(s.scale, 0.69, 'the scale stays');
  for (const sc of [0, 1]) assert.ok(onDesk(s.char(sc).rect, { w: 812, h: 340 }), `scope ${sc} on the landscape desk`);
  // a visitor's pick (the runtime passes it as `scale`) wins; the fit is still known (the menu's Default row)
  const picked = await sizedStage({ sizes: TSUBASA, desk, phone: PHONE, scale: 0.6 });
  assert.equal(picked.scale, 0.6);
  near(picked.fitScale, 0.69, 'fitScale with a pick');
  // the 1000-px-wide pair: below the floor, both rects inside the screen
  const pair = await sizedStage({ sizes: { 0: [500, 300], 10: [500, 300] }, desk, phone: PHONE });
  assert.equal(pair.scale, 0.355);
  assert.ok(onDesk(pair.char(0).rect, desk) && onDesk(pair.char(1).rect, desk));
}));

test('a phone Stage without a fit: not a mobile page, or a size the files do not know: scale 1', () => atDpr(2, async () => {
  const s = await sizedStage({ sizes: TSUBASA, desk: { w: 375, h: 660 }, phone: phone(375, 812, false) });
  assert.deepEqual([s.fitScale, s.scale], [null, 1]);
  // no imageSize (a headless FsFiles): the size is unknown until decoded
  const { Stage } = await import('../../src/shell/stage.js');
  const shellFiles = { has: p => p === 'surface0.png', resolve: p => (p === 'surface0.png' ? p : null), list: () => ['surface0.png'], bytes: async () => new ArrayBuffer(8) };
  const decode = async () => ({ width: 220, height: 380, data: new Uint8Array(220 * 380 * 4) });
  const u = new Stage({ shell: parseShell({ descript: '', files: ['surface0.png'] }), shellFiles, dom: false, decode, clock: new FakeClock(0),
    desk: { w: 375, h: 660 }, phone: PHONE });
  assert.deepEqual([u.fitScale, u.scale], [null, 1]);
}));

test('desktop unchanged: a Stage without `phone` at 1280×720 and 1920×1080, any devicePixelRatio, is a desktop Stage', async () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    await atDpr(dpr, async () => {
      for (const desk of [{ w: 1280, h: 720 }, { w: 1920, h: 1080 }]) {
        const s = await sizedStage({ sizes: TSUBASA, desk });
        assert.deepEqual([s.phone, s.fitScale, s.scale], [null, null, 1], `${desk.w}×${desk.h} dpr ${dpr}`);
        // the default places at scale 1, as layout.js defaultPlace gives them (stage.test.mjs's first-boot layout)
        const g0 = { rect: { x: 0, y: 0, w: 220, h: 380 }, bp: { x: 110, y: 380 }, sx: 1, sy: 1 };
        const g1 = { rect: { x: 0, y: 0, w: 4, h: 4 }, bp: { x: 2, y: 4 }, sx: 1, sy: 1 };
        const a0 = defaultPlace({ scope: 0, g: g0, align: 'bottom' }, null, desk);
        const r0 = rectAt(a0, g0);
        const a1 = defaultPlace({ scope: 1, g: g1, align: 'bottom' }, { left: r0.x, baseY: a0.y }, desk);
        assert.deepEqual(s.char(0).rect, r0);
        assert.deepEqual(s.char(1).rect, rectAt(a1, g1));
        if (desk.w === 1280) {
          assert.deepEqual(s.char(0).rect, { x: 1060, y: 340, width: 220, height: 380 });
          assert.deepEqual(s.char(1).rect, { x: 1056, y: 716, width: 4, height: 4 });
        }
        const picked = await sizedStage({ sizes: TSUBASA, desk, scale: 0.8 });
        assert.deepEqual([picked.fitScale, picked.scale], [null, 0.8]);
      }
    });
  }
});

// ---------------------------------------------------------------- the phone desk (DOM)

// The DOM glue's fake (tests/shell/dom.test.mjs's El), plus what the probe needs: isConnected, and client sizes for an
// element styled `position:fixed` (the fixed containing block, `fixedBox`); every other element measures 0.
const fixedBox = { w: 375, h: 716 };
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this.parentNode = null;
    this.width = 0;
    this.height = 0;
  }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get isConnected() { return !!this.parentNode; }
  get clientWidth() { return /position:\s*fixed/.test(this.style.cssText || '') ? fixedBox.w : 0; }
  get clientHeight() { return /position:\s*fixed/.test(this.style.cssText || '') ? fixedBox.h : 0; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  attachShadow() {
    const r = new El('#shadow');
    r.getElementById = id => r.children.find(c => c.id === id) || null;
    this.shadowRoot = r;
    return r;
  }
  getContext() { return { putImageData() {} }; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

/** fn() with a fake document whose documentElement is 375×660 (the layout viewport with the bars shown) */
async function withDom(fn) {
  const prev = { document: globalThis.document, window: globalThis.window, ImageData: globalThis.ImageData };
  globalThis.document = {
    createElement: t => new El(t), body: new El('body'), documentElement: { clientWidth: 375, clientHeight: 660 },
    hidden: false, addEventListener() {}, removeEventListener() {},
  };
  globalThis.window = { innerWidth: 375, innerHeight: 660, addEventListener() {}, removeEventListener() {} };
  globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
  }
}

const probes = root => root.children.filter(c => /position:\s*fixed/.test((c.style && c.style.cssText) || ''));

test('the phone desk: the fixed containing block (the browser bar hidden), never documentElement; no probe without `phone`', () => withDom(() => atDpr(2, async () => {
  const { getRoot } = await import('../../src/ui/root.js');
  const desktop = await sizedStage({ sizes: TSUBASA, dom: true });
  assert.deepEqual(desktop.desk(), { w: 375, h: 660 }, 'desktop: documentElement');
  assert.equal(probes(getRoot()).length, 0, 'no probe element is ever made without `phone`');
  const s = await sizedStage({ sizes: TSUBASA, dom: true, phone: PHONE });
  assert.deepEqual(s.desk(), { w: 375, h: 716 });
  assert.equal(probes(getRoot()).length, 1);
  const r0 = s.char(0).rect;
  near(r0.y + r0.height, 716, 'her feet on the visible bottom');
  assert.deepEqual(desktop.desk(), { w: 375, h: 660 }, 'a desktop stage still reads documentElement');
  const s2 = await sizedStage({ sizes: TSUBASA, dom: true, phone: PHONE });
  assert.deepEqual(s2.desk(), { w: 375, h: 716 });
  assert.equal(probes(getRoot()).length, 1, 'one probe per page');
  probes(getRoot())[0].remove();                          // the root was rebuilt: a new probe
  assert.deepEqual(s.desk(), { w: 375, h: 716 });
  assert.equal(probes(getRoot()).length, 1);
  fixedBox.h = 0;                                         // a probe that measures nothing: the desktop's desk
  try { assert.deepEqual(s.desk(), { w: 375, h: 660 }); } finally { fixedBox.h = 716; }
  for (const st of [desktop, s, s2]) st.destroy();
})));

test('F6: the characters\' surfaces take no iOS long-press callout', () => withDom(async () => {
  const { getRoot } = await import('../../src/ui/root.js');
  const s = await sizedStage({ sizes: TSUBASA, dom: true });
  const css = getRoot().getElementById('style-shell').textContent;
  assert.match(css, /\.smk-surface\{[^}]*-webkit-touch-callout:none;/);
  s.destroy();
}));

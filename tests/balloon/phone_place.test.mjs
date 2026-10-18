// Balloons on a phone (ssp-ui.md §9.11): placeBalloon's `overhead` fallback (above her head when neither side fits),
// balloonFit (the phone default of Balloon scaling, never below READABLE_PX unless the screen is narrower), and a
// Balloons built with `phone` (overhead in its placement input, its viewport from the stage's desk(), fitScale).
// Desktop (no `overhead`, no `phone`) must keep exactly the desktop rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake_dom.mjs';
import { Emitter } from '../../src/core/emitter.js';
import { setLogLevel } from '../../src/core/log.js';

installFakeDom();
setLogLevel('error');
const { placeBalloon, balloonFit, READABLE_PX } = await import('../../src/balloon/placement.js');
const { BalloonSkin } = await import('../../src/balloon/skin.js');
const { Balloons } = await import('../../src/balloon/manager.js');

const PHONE = Object.freeze({ short: 375, long: 812, mobileView: true });

/** A PNG header (all BalloonSkin.load reads with decode:false). */
function png(w, h) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b[24] = 8;
  b[25] = 2;
  return b;
}

/** GhostFiles stand-in over an in-memory balloon folder. */
class MemFiles {
  constructor(entries) { this.map = new Map(Object.entries(entries)); }
  has(p) { return this.map.has(p); }
  list() { return [...this.map.keys()]; }
  async bytes(p) {
    const v = this.map.get(p);
    if (v === undefined) throw new Error('no such file ' + p);
    return (typeof v === 'string' ? new TextEncoder().encode(v) : v).buffer;
  }
  async text(p) { return String(this.map.get(p)); }
}

function skinFiles(name, fontHeight, sizes) {
  const files = {
    'descript.txt': [`charset,UTF-8`, `name,${name}`, 'type,balloon', 'validrect.left,10', 'validrect.top,10',
      'validrect.right,-10', 'validrect.bottom,-10', `font.height,${fontHeight}`].join('\r\n'),
  };
  for (const [stem, [w, h]] of Object.entries(sizes)) files[stem + '.png'] = png(w, h);
  return new MemFiles(files);
}

// LightBlue's numbers: 340 px wide, a 12-px font; the input box (balloonc*) is not a balloon and never counts
const WIDE = await BalloonSkin.load(skinFiles('Wide', 12, {
  balloons0: [340, 170], balloons1: [340, 170], balloons2: [340, 384], balloons3: [340, 384], balloonk0: [340, 170],
  balloonk1: [340, 170], balloonc3: [400, 42],
}), { decode: false });
// convulsions' width
const NARROW = await BalloonSkin.load(skinFiles('Narrow', 12, {
  balloons0: [200, 120], balloons1: [200, 120], balloonk0: [200, 100], balloonk1: [200, 100],
}), { decode: false });

/** a Stage stand-in: one character rect per scope, the shell's balloon offset, and desk() */
class PhoneStage extends Emitter {
  constructor({ rect, offset = { x: 2, y: 14 }, desk = { w: 375, h: 660 } } = {}) {
    super();
    this.rects = { 0: { ...rect } };
    this.offset = offset;
    this._desk = desk;
    this.shell = { descript: new Map() };
    this.scale = 1;
  }
  char(scope) { return { rect: this.rects[scope] || { x: 0, y: 0, width: 0, height: 0 }, balloonOffset: this.offset }; }
  desk() { return this._desk; }
  move(scope, x, y) { Object.assign(this.rects[scope], { x, y }); this.emit('move', { scope }); }
}

/** documentElement and window at a given size (the fake DOM's) */
function layout(w, h) {
  Object.assign(document.documentElement, { clientWidth: w, clientHeight: h });
  Object.assign(window, { innerWidth: w, innerHeight: h });
}

// Tsubasa at 138 % on a 375×812 phone (dpr 2): 151.8×262.2, her feet on the bottom of a 375×660 desk (UI §9.11 Item 2)
const TSUBASA = Object.freeze({ x: 223.2, y: 397.8, width: 151.8, height: 262.2 });
const VP = Object.freeze({ width: 375, height: 660 });

test('overhead: neither side fits, so the balloon goes above her head, centred and clamped (UI §9.11 "Above her head when neither side fits")', () => {
  const size = { w: 340, h: 170 };
  assert.deepEqual(placeBalloon({ char: TSUBASA, size, viewport: VP, overhead: true }), { x: 35, y: 228, side: 'top' },
    'centred at 129.1, clamped to 375 − 340; 397.8 − 170 = 227.8');
  // without the option: the desktop rule (stays left, clamped into the viewport, over her)
  assert.deepEqual(placeBalloon({ char: TSUBASA, size, viewport: VP }), { x: 0, y: 398, side: 'left' });
  assert.deepEqual(placeBalloon({ char: TSUBASA, size, viewport: VP, overhead: false }), { x: 0, y: 398, side: 'left' });
  // one side fits: SSP's rule runs unchanged
  const atLeft = { ...TSUBASA, x: 0 };
  assert.equal(placeBalloon({ char: atLeft, size: { w: 200, h: 120 }, viewport: VP, overhead: true }).side, 'right', 'right fits');
  assert.equal(placeBalloon({ char: TSUBASA, size: { w: 200, h: 120 }, viewport: VP, overhead: true }).side, 'left', 'left fits');
  const mid = { x: 120, y: 397.8, width: 100, height: 262.2 };
  assert.equal(placeBalloon({ char: mid, size: { w: 100, h: 80 }, viewport: VP, overhead: true, prefer: 'right' }).side, 'right',
    'the visitor\'s right click is honoured while the right fits');
  assert.equal(placeBalloon({ char: atLeft, size: { w: 200, h: 120 }, viewport: VP, overhead: true, prefer: 'left' }).side, 'right',
    'flipped to the right as on a desktop');
  // a prefer of right with neither side fitting: above her head too
  assert.equal(placeBalloon({ char: TSUBASA, size, viewport: VP, overhead: true, prefer: 'right' }).side, 'top');
});

test('overhead: the shell\'s balloon offsets are ignored; windowposition and the visitor\'s drag offset still add', () => {
  const size = { w: 340, h: 170 };
  const mid = { x: 100, y: 397.8, width: 151.8, height: 262.2 };      // centred x: 100 + 75.9 − 170 = 5.9
  assert.deepEqual(placeBalloon({ char: mid, size, viewport: VP, overhead: true, offset: { x: 2, y: 14 } }), { x: 6, y: 228, side: 'top' });
  assert.deepEqual(placeBalloon({ char: mid, size, viewport: VP, align: 'top', offset: { x: 2, y: 14 } }), { x: 8, y: 242, side: 'top' },
    'a fixed top alignment keeps the offsets (the desktop\'s)');
  assert.deepEqual(placeBalloon({ char: mid, size, viewport: VP, overhead: true, offset: { x: 2, y: 14 },
    windowPosition: { x: 10, y: 5, limit: true } }), { x: 16, y: 233, side: 'top' });
  assert.deepEqual(placeBalloon({ char: mid, size, viewport: VP, overhead: true, offset: { x: 2, y: 14 },
    windowPosition: { x: 10, y: 5, limit: true }, userOffset: { x: -3, y: -4 } }), { x: 13, y: 229, side: 'top' });
  assert.deepEqual(placeBalloon({ char: mid, size, viewport: VP, overhead: true, windowPosition: { x: 0, y: 0, limit: false } }),
    { x: 6, y: 228, side: 'top' });
});

test('overhead: no room above her head (320×568): clamped at y 0, never below her', () => {
  const vp = { width: 320, height: 460 };
  const her = { x: 199.4, y: 252.9, width: 120.6, height: 207.1 };
  const r = placeBalloon({ char: her, size: { w: 340, h: 384 }, viewport: vp, overhead: true });
  assert.equal(r.side, 'top');
  assert.equal(r.y, 0);
  assert.equal(r.x, 0, 'wider than the screen: its left edge at 0');
});

test('overhead: a fixed alignment (shell, \\![set,balloonalign], windowposition top/bottom) is obeyed as written', () => {
  const size = { w: 340, h: 170 };
  assert.deepEqual(placeBalloon({ char: TSUBASA, size, viewport: VP, overhead: true, align: 'left' }), { x: 0, y: 398, side: 'left' });
  assert.deepEqual(placeBalloon({ char: TSUBASA, size, viewport: VP, overhead: true, align: 'right' }), { x: 35, y: 398, side: 'right' });
  assert.equal(placeBalloon({ char: TSUBASA, size, viewport: VP, overhead: true, align: 'bottom' }).side, 'bottom');
  assert.equal(placeBalloon({ char: TSUBASA, size, viewport: VP, overhead: true,
    windowPosition: { x: 'bottom', y: 0, limit: true } }).side, 'bottom');
  // a fixed top keeps the desktop's offsets
  assert.deepEqual(placeBalloon({ char: TSUBASA, size, viewport: VP, overhead: true, align: 'center', offset: { x: 2, y: 14 } }),
    { x: 35, y: 242, side: 'top' });
});

test('desktop unchanged: without overhead, neither side fitting keeps the side and clamps (1280×720, 1920×1080)', () => {
  assert.deepEqual(placeBalloon({ char: { x: 900, y: 300, width: 200, height: 400 }, size: { w: 1300, h: 384 },
    viewport: { width: 1280, height: 720 } }), { x: 0, y: 300, side: 'left' });
  // a character 1000 px wide at x 10: 1000 px of balloon fits on neither side of 1920
  assert.deepEqual(placeBalloon({ char: { x: 10, y: 500, width: 1000, height: 580 }, size: { w: 1000, h: 384 },
    viewport: { width: 1920, height: 1080 } }), { x: 0, y: 500, side: 'left' });
  assert.deepEqual(placeBalloon({ char: { x: 10, y: 500, width: 1000, height: 580 }, size: { w: 1000, h: 384 }, prefer: 'right',
    viewport: { width: 1920, height: 1080 } }), { x: 920, y: 500, side: 'right' });
});

test('desktop unchanged: pure.test.mjs\'s placement cases with overhead: false give the same results', () => {
  const vp = { width: 1280, height: 720 };
  const char = { x: 900, y: 300, width: 200, height: 400 };
  const size = { w: 340, h: 384 };
  const P = o => placeBalloon({ ...o, overhead: false });
  assert.deepEqual(P({ char, size, offset: { x: 2, y: 14 }, viewport: vp }), { x: 900 - 340 + 2, y: 314, side: 'left' });
  const left = { x: 100, y: 300, width: 200, height: 400 };
  assert.deepEqual(P({ char: left, size, offset: { x: 2, y: 14 }, viewport: vp }), { x: 298, y: 314, side: 'right' });
  assert.equal(P({ char: left, size, prefer: 'left', viewport: vp }).side, 'right');
  assert.equal(P({ char, size, prefer: 'right', viewport: vp }).side, 'left');
  const mid = { x: 700, y: 300, width: 200, height: 400 };
  assert.equal(P({ char: mid, size, viewport: vp }).side, 'left');
  for (const x of [400, 341, 340]) assert.equal(P({ char: { ...mid, x }, size, viewport: vp }).side, 'left', `x ${x}`);
  assert.equal(P({ char: { ...mid, x: 339 }, size, viewport: vp }).side, 'right');
  assert.equal(P({ char: mid, size, prefer: 'right', viewport: vp }).side, 'right');
  assert.equal(P({ char: { x: 900, y: 600, width: 200, height: 100 }, size, viewport: vp }).y, 720 - 384);
  assert.equal(P({ char, size, viewport: vp, windowPosition: { x: 'top', y: 0, limit: true } }).side, 'top');
  assert.equal(P({ char, size, viewport: vp, align: 'right' }).side, 'right');
  const wp = P({ char, size, viewport: vp, windowPosition: { x: 10, y: 5, limit: false } });
  assert.deepEqual([wp.x, wp.y], [900 - 340 + 10, 305]);
});

test('balloonFit: the widest balloon within the short side, text not below READABLE_PX unless the screen is narrower (UI §9.11 "The balloon fit")', () => {
  const skin = (w, h = 12, extra = {}) => ({ images: new Map([['balloons0', { w }], ['balloonk0', { w: w - 40 }],
    ...Object.entries(extra)]), font: { height: h } });
  const at = short => ({ short, long: 800, mobileView: true });
  assert.equal(READABLE_PX, 11);
  const lightBlue = skin(340, 12);
  assert.equal(balloonFit(lightBlue, at(375)), 1);
  assert.equal(balloonFit(lightBlue, at(360)), 1);
  assert.equal(balloonFit(lightBlue, at(320)).toFixed(3), '0.917', 'the 11-px floor: 11 / 12');
  assert.equal(balloonFit(lightBlue, at(280)), 280 / 340, 'the screen beats the floor (Galaxy Fold cover screen)');
  assert.equal(balloonFit(skin(389, 14), at(375)).toFixed(3), '0.923', 'angel_ladder: (375 − 16) / 389');
  assert.equal(balloonFit(skin(200), at(375)), 1, 'convulsions: never enlarged');
  assert.equal(balloonFit(skin(200), at(320)), 1);
  // the widest of every \0, \1 and \p[n] balloon; the input box (balloonc*) never counts
  assert.equal(balloonFit(skin(200, 12, { balloonp2def0: { w: 340 } }), at(320)).toFixed(3), '0.917');
  assert.equal(balloonFit(skin(200, 12, { balloonc3: { w: 400 } }), at(320)), 1);
  assert.equal(balloonFit({ images: new Map(), font: { height: 12 } }, at(320)), 1, 'no images');
  assert.equal(balloonFit(null, at(320)), 1);
  assert.equal(balloonFit(lightBlue, { short: 320, long: 568, mobileView: false }), 1, 'a ~980-px page: no fit');
  assert.equal(balloonFit(lightBlue, null), 1);
  assert.equal(balloonFit({ images: lightBlue.images }, at(320)).toFixed(3), '0.917', 'no font: 12 px');
  // a real skin's images (LightBlue's numbers)
  assert.equal(balloonFit(WIDE, at(320)).toFixed(3), '0.917');
  assert.equal(balloonFit(NARROW, at(320)), 1);
});

test('Balloons with phone: fitScale from the skin, the scale it starts at, a pick that wins, setSkin recomputing it', () => {
  layout(320, 460);
  const phone = { short: 320, long: 568, mobileView: true };
  const stage = new PhoneStage({ rect: { x: 199.4, y: 252.9, width: 120.6, height: 207.1 }, desk: { w: 320, h: 460 } });
  const b = new Balloons({ skin: WIDE, root: null, stage, phone });
  assert.equal(b.fitScale.toFixed(3), '0.917');
  assert.equal(b.scale, b.fitScale);
  assert.equal(b.get(0).scale, b.fitScale, 'a balloon made later starts at it');
  b.setSkin(NARROW);
  assert.equal(b.fitScale, 1, 'recomputed for the new skin');
  assert.equal(b.scale.toFixed(3), '0.917', 'applying it is the caller\'s (UserScaling.refit)');
  b.setSkin(WIDE);
  assert.equal(b.fitScale.toFixed(3), '0.917');
  const picked = new Balloons({ skin: WIDE, root: null, stage, phone, scale: 1.5 });
  assert.equal(picked.scale, 1.5, 'the visitor\'s Balloon scaling wins, with no floor');
  assert.equal(picked.fitScale.toFixed(3), '0.917');
  const page980 = new Balloons({ skin: WIDE, root: null, stage, phone: { ...phone, mobileView: false } });
  assert.equal(page980.fitScale, 1);
  assert.equal(page980.scale, 1);
  for (const x of [b, picked, page980]) x.destroy();
});

test('Balloons with phone: above her head, the left image, top never stored as the side; back beside her after a rotation', () => {
  layout(375, 660);
  const stage = new PhoneStage({ rect: TSUBASA, desk: { w: 375, h: 660 } });
  const b = new Balloons({ skin: WIDE, root: null, stage, phone: PHONE, state: { 0: { kind: 0, side: 'right' } } });
  let states = 0;
  b.on('state', () => states++);
  const v = b.get(0);
  v.write('hello');
  assert.equal(b._placement(0, v).overhead, true);
  assert.deepEqual([v.x, v.y], [35, 228], 'centred above her head, the shell\'s offsets left out');
  assert.equal(v.img.name, 'balloons0', 'drawn with the left image');
  assert.equal(b.saveState()[0].side, 'right', 'the saved side survives');
  assert.equal(states, 0);
  // landscape: the left side fits again
  stage._desk = { w: 812, h: 375 };
  layout(812, 375);
  stage.rects[0] = { x: 660.2, y: 112.8, width: 151.8, height: 262.2 };
  stage.emit('move', { scope: 0 });
  assert.deepEqual([v.x, v.y, v.side], [322, 127, 'left'], 'beside her again, with the shell\'s offsets (660.2 − 340 + 2, 112.8 + 14)');
  b.destroy();
});

test('Balloons with phone: a drag offset is stored relative to the overhead place', () => {
  layout(375, 660);
  const stage = new PhoneStage({ rect: TSUBASA, desk: { w: 375, h: 660 } });
  const b = new Balloons({ skin: WIDE, root: null, stage, phone: PHONE });
  const v = b.get(0);
  v.write('hello');
  assert.deepEqual([v.x, v.y], [35, 228]);
  v.emit('drag', { kind: 'start' });
  v.emit('drag', { kind: 'move', dx: -10, dy: -20 });
  v.emit('drag', { kind: 'end', dx: -10, dy: -20 });
  assert.deepEqual([v.x, v.y], [25, 208]);
  // the overhead place before the clamp is (129, 228): the offset is from there, not from the left side's (−115, 412)
  assert.deepEqual(b.saveState()[0].userOffset, [25 - 129, 208 - 228]);
  b.place(0);
  assert.deepEqual([v.x, v.y], [25, 208], 'placed again where it was left');
  b.destroy();
});

test('Balloons with phone: the viewport is the stage\'s desk() (the fixed containing block), not documentElement', () => {
  layout(375, 660);
  const stage = new PhoneStage({ rect: TSUBASA, desk: { w: 375, h: 716 } });
  const b = new Balloons({ skin: WIDE, root: null, stage, phone: PHONE });
  const v = b.get(0);
  v.write('hello');
  assert.deepEqual(b._placement(0, v).viewport, { width: 375, height: 716 });
  v.emit('drag', { kind: 'start' });
  v.emit('drag', { kind: 'end', dx: 0, dy: 1000 });
  assert.equal(v.y, 716 - 170, 'a drag is clamped to the desk');
  b.destroy();
});

test('desktop unchanged: a Balloons without phone has no overhead, no fit, scale 1, and documentElement\'s viewport', () => {
  layout(1280, 720);
  const stage = new PhoneStage({ rect: { x: 900, y: 300, width: 200, height: 400 }, desk: { w: 375, h: 716 } });
  const b = new Balloons({ skin: WIDE, root: null, stage });
  assert.equal(b.fitScale, null);
  assert.equal(b.scale, 1);
  assert.equal(b.phone, null);
  const v = b.get(0);
  v.write('hello');
  const input = b._placement(0, v);
  assert.equal('overhead' in input, false);
  assert.deepEqual(input.viewport, { width: 1280, height: 720 });
  assert.deepEqual([v.x, v.y, v.side], [900 - 340 + 2, 314, 'left']);
  b.setSkin(NARROW);
  assert.equal(b.fitScale, null, 'setSkin computes no fit on desktop');
  assert.equal(b.scale, 1);
  const scaled = new Balloons({ skin: WIDE, root: null, stage, scale: 1.25 });
  assert.equal(scaled.scale, 1.25);
  assert.equal(scaled.fitScale, null);
  // a narrow desktop window: neither side fits, so it stays on its side, clamped (the desktop rule)
  layout(375, 660);
  stage.rects[0] = { ...TSUBASA };
  const n = new Balloons({ skin: WIDE, root: null, stage });
  const w = n.get(0);
  w.write('hello');
  assert.deepEqual([w.x, w.y, w.side], [0, 412, 'left']);
  assert.deepEqual(n._placement(0, w).viewport, { width: 375, height: 660 });
  for (const x of [b, scaled, n]) x.destroy();
});

// Placement math (UI §3.1–3.3, SUM C28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basePoint, resolveAlignment, rectAt, anchorForTopLeft, snap, clampIntoView, clampInside, toRatio, fromRatio, defaultPlace, bringBack } from '../../src/shell/layout.js';

const g = (w, h, x = 0, y = 0, s = 1) => {
  const rect = { x, y, w, h };
  return { rect, bp: basePoint(rect), sx: s, sy: s };
};
const desk = { w: 1000, h: 600 };

test('base point: centre bottom by default; defaultx/y and point.basepos override', () => {
  assert.deepEqual(basePoint({ x: 0, y: 0, w: 220, h: 380 }), { x: 110, y: 380 });
  assert.deepEqual(basePoint({ x: -10, y: 0, w: 230, h: 380 }), { x: 105, y: 380 });
  assert.deepEqual(basePoint({ x: 0, y: 0, w: 220, h: 380 }, { defaultX: '50' }), { x: 50, y: 380 });
  assert.deepEqual(basePoint({ x: 0, y: 0, w: 220, h: 380 }, { defaultX: '50', basepos: { x: 7, y: NaN } }), { x: 7, y: 380 });
});

test('alignment priority: override > shell scope > shell global > ghost scope > ghost global > bottom', () => {
  const shell = new Map([['char99.seriko.alignmenttodesktop', 'free']]);
  const ghost = new Map([['seriko.alignmenttodesktop', 'top'], ['kero.seriko.alignmenttodesktop', 'free']]);
  assert.equal(resolveAlignment(99, null, shell, ghost), 'free');
  assert.equal(resolveAlignment(0, null, shell, ghost), 'top');
  assert.equal(resolveAlignment(1, null, shell, ghost), 'free');
  assert.equal(resolveAlignment(0, 'bottom', shell, ghost), 'bottom');
  assert.equal(resolveAlignment(0, 'bogus', new Map(), new Map()), 'bottom');
});

test('rect, docking, clamping and ratios', () => {
  const G = g(220, 380);
  const a = anchorForTopLeft(100, 50, G);
  assert.deepEqual(a, { x: 210, y: 430 });
  assert.deepEqual(rectAt(a, G), { x: 100, y: 50, width: 220, height: 380 });
  assert.deepEqual(snap(a, G, 'bottom', desk), { x: 210, y: 600 });
  assert.deepEqual(snap(a, G, 'top', desk), { x: 210, y: 380 });
  assert.deepEqual(snap(a, G, 'right', desk), { x: 890, y: 430 });
  assert.deepEqual(snap(a, G, 'left', desk), { x: 110, y: 430 });
  assert.deepEqual(snap(a, G, 'free', desk), a);
  assert.deepEqual(clampIntoView({ x: -500, y: 2000 }, G, desk), { x: -78, y: 948 });
  assert.deepEqual(fromRatio(toRatio({ x: 250, y: 300 }, desk), desk), { x: 250, y: 300 });
  // scaled geometry
  const H = g(100, 100, 0, 0, 2);
  assert.deepEqual(rectAt({ x: 100, y: 200 }, H), { x: 0, y: 0, width: 200, height: 200 });
});

test('default place (ssp.exe, UI §3.2): \\0 bottom-right, the next scope flush against the one below, base points level, defaults', () => {
  const at = (it, below, d = desk) => rectAt(defaultPlace(it, below, d), it.g);
  // \0: right edge on the desk's right edge, base point on its bottom
  const s0 = { scope: 0, g: g(220, 380), align: 'bottom' };
  assert.deepEqual(at(s0, null), { x: 780, y: 220, width: 220, height: 380 });
  assert.deepEqual(defaultPlace(s0, null, desk), { x: 890, y: 600 });
  // \1: its right edge against \0's left edge, no gap for balloons; base point level with \0's
  assert.deepEqual(at({ scope: 1, g: g(4, 4), align: 'bottom' }, { left: 780, baseY: 600 }), { x: 776, y: 596, width: 4, height: 4 });
  // free: the base point level, not the bottom (a base point 30 px above the image bottom: 30 px of it below the desk)
  const raised = { rect: { x: 0, y: 0, w: 100, h: 100 }, bp: { x: 50, y: 70 }, sx: 1, sy: 1 };
  assert.deepEqual(defaultPlace({ scope: 1, g: raised, align: 'free' }, { left: 780, baseY: 600 }, desk), { x: 730, y: 600 });
  // defaultleft / defaulttop win (any alignment; docking still applies)
  assert.deepEqual(at({ scope: 99, g: g(204, 125), align: 'free', defaultLeft: 300 }, { left: 776, baseY: 600 }), { x: 300, y: 475, width: 204, height: 125 });
  assert.deepEqual(at({ scope: 5, g: g(100, 100), align: 'free', defaultLeft: 300, defaultTop: 20 }, { left: 776, baseY: 600 }), { x: 300, y: 20, width: 100, height: 100 });
  assert.deepEqual(at({ scope: 5, g: g(100, 100), align: 'bottom', defaultLeft: 300, defaultTop: 20 }, null), { x: 300, y: 500, width: 100, height: 100 });
  assert.deepEqual(at({ scope: 0, g: g(220, 380), align: 'top' }, null), { x: 780, y: 0, width: 220, height: 380 });
  // nothing below (never in practice: \0 always has a window, hidden by \s[-1] too): left at the desk's middle,
  // bottom on its bottom
  assert.deepEqual(at({ scope: 3, g: g(100, 100), align: 'free' }, null), { x: 500, y: 500, width: 100, height: 100 });
  // scaled geometry
  assert.deepEqual(at({ scope: 0, g: g(100, 100, 0, 0, 2), align: 'bottom' }, null), { x: 800, y: 400, width: 200, height: 200 });
});

test('default place: a window that misses the desk comes back as ssp.exe\'s ClampToWorkRect brings it, a partly visible one stays (bringBack)', () => {
  const at = (it, below, d = desk) => rectAt(defaultPlace(it, below, d), it.g);
  const p7 = { scope: 7, g: g(100, 100), align: 'bottom' };
  assert.equal(at(p7, { left: 50, baseY: 600 }).x, -50, 'partly on the desk: left alone');
  assert.equal(at(p7, { left: -10, baseY: 600 }).x, 0, 'wholly left of it: flush with the left edge');
  // rectangles are half-open: one touching the left edge from outside misses the desk, and only a window wholly left
  // of it goes to the left edge, so this one goes to the right edge
  assert.equal(at(p7, { left: 0, baseY: 600 }).x, 900, 'touching the left edge: the right edge');
  const G = g(100, 100);
  // wholly right: the right edge; y goes to the bottom edge unless the window lies wholly above the desk [infer]
  assert.deepEqual(rectAt(bringBack({ x: 1200, y: 50 }, G, desk), G), { x: 900, y: 500, width: 100, height: 100 });
  // missing only below: x goes to the right edge too
  assert.deepEqual(rectAt(bringBack({ x: 300, y: 900 }, G, desk), G), { x: 900, y: 500, width: 100, height: 100 });
  assert.deepEqual(rectAt(bringBack({ x: 300, y: -10 }, G, desk), G), { x: 900, y: 0, width: 100, height: 100 }, 'wholly above: the top edge');
  assert.deepEqual(rectAt(bringBack({ x: 300, y: 700 }, G, desk), G), { x: 900, y: 500, width: 100, height: 100 }, 'touching the bottom edge from below');
  assert.deepEqual(bringBack({ x: 300, y: 300 }, G, desk), { x: 300, y: 300 });
  assert.deepEqual(bringBack({ x: 1049, y: 300 }, G, desk), { x: 1049, y: 300 }, 'one pixel on the desk: left alone');
  // a free scope with a defaultleft and a defaulttop below the desk: the right edge, not its defaultleft
  assert.deepEqual(at({ scope: 5, g: g(100, 100), align: 'free', defaultLeft: 300, defaultTop: 700 }, null), { x: 900, y: 500, width: 100, height: 100 });
  // docking comes after the clamp: a top-docked scope that misses the desk sideways still stands at the top
  assert.deepEqual(at({ scope: 7, g: g(100, 100), align: 'top' }, { left: 0, baseY: 600 }), { x: 900, y: 0, width: 100, height: 100 });
});

test('default place on a narrow desk (an emily4-like ghost on a 375 px phone): a \\p[n] touching the left edge goes to the right edge, the next one against it', () => {
  const phone = { w: 375, h: 667 };
  const place = (scope, w, below) => {
    const it = { scope, g: g(w, 100), align: 'bottom' };
    const a = defaultPlace(it, below, phone);
    return { left: rectAt(a, it.g).x, baseY: a.y };
  };
  const s0 = place(0, 253, null), s1 = place(1, 255, s0), p2 = place(2, 181, s1), p3 = place(3, 133, p2), p4 = place(4, 97, p3);
  assert.deepEqual([s0, s1, p2, p3, p4].map(p => p.left), [122, -133, 0, 242, 145], 'not three \\p[n] stacked at x 0');
});

test('default place with emily4-after-Tsubasa sizes (1920×1040 desk): the callee stands on the caller, as in ssp.exe', () => {
  const work = { w: 1920, h: 1040 };
  // Tsubasa alone, at her default place
  const tsubasa = rectAt(defaultPlace({ scope: 0, g: g(220, 380), align: 'bottom' }, null, work), g(220, 380));
  assert.deepEqual(tsubasa, { x: 1700, y: 660, width: 220, height: 380 });
  // emily4 called, never met: her own default; nothing of Tsubasa is read (UI §3.5), so Emily covers her
  const emily = { scope: 0, g: g(253, 385), align: 'bottom' };
  const ea = defaultPlace(emily, null, work);
  assert.deepEqual(rectAt(ea, emily.g), { x: 1667, y: 655, width: 253, height: 385 });
  const teddy = { scope: 1, g: g(255, 161), align: 'free' };
  assert.deepEqual(rectAt(defaultPlace(teddy, { left: 1667, baseY: ea.y }, work), teddy.g), { x: 1412, y: 879, width: 255, height: 161 });
});

test('clampInside keeps the whole base rectangle on the desk (moves made against a stale size)', () => {
  const G = g(630, 350);                                   // base point (315, 350)
  // \s[951] + \![move,...,right.top,right.top] computed from a 4x4 placeholder: base point at (1278, 4)
  assert.deepEqual(rectAt(clampInside({ x: 1278, y: 4 }, G, { w: 1280, h: 720 }), G), { x: 650, y: 0, width: 630, height: 350 });
  assert.deepEqual(rectAt(clampInside({ x: 2, y: 4 }, G, { w: 1280, h: 720 }), G), { x: 0, y: 0, width: 630, height: 350 });
  assert.deepEqual(clampInside({ x: 500, y: 400 }, G, { w: 1280, h: 720 }), { x: 500, y: 400 });   // inside: unchanged
  // larger than the desk: the left / top edge wins
  assert.deepEqual(rectAt(clampInside({ x: 0, y: 0 }, G, { w: 400, h: 300 }), G), { x: 0, y: 0, width: 630, height: 350 });
});

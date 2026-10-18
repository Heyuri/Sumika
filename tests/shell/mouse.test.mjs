// Mouse/touch state machine (EV §4.2–4.5.1, SUM C10/C11/C23/C31) with synthetic pointer records and a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MouseTracker, WheelAccumulator, GESTURE_DIRS, gestureDegree, direction8 } from '../../src/shell/mouse.js';
import { FakeClock } from './helpers.mjs';

function setup(scope = 0) {
  const clock = new FakeClock(1000);
  const out = [], drags = [];
  const m = new MouseTracker({ scope, clock, emit: i => out.push(i), onDrag: (k, dx, dy) => drags.push([k, dx, dy]) });
  // the window's origin (the base rect) at client (90, 190); the collision by shape = the hit
  const at = (x, y, extra = {}) => {
    const r = { x, y, sx: x - 100, sy: y - 200, hit: 'Head', device: 'mouse', time: clock.now(), ...extra };
    return { wx: x - 90, wy: y - 190, col: r.hit, ...r };
  };
  const seq = () => out.map(i => (i.type === 'gesture' ? 'gesture:' + i.name : i.type === 'gesturestep' ? 'step' :
    i.type + (i.button ? '/' + i.button : '') + (i.type === 'up' ? (i.click ? '+' : '-') : '')));
  return { clock, out, drags, m, at, seq };
}

test('click: enter, down, up, click with surface coordinates and collision', () => {
  const { m, at, out, seq } = setup(3);
  m.move(at(110, 220));
  assert.ok(m.down({ ...at(110, 220), button: 0 }));
  m.up({ ...at(110, 220), button: 0 });
  assert.deepEqual(seq(), ['enterall', 'enter', 'move', 'down', 'up+', 'click']);
  const click = out.at(-1);
  assert.deepEqual([click.scope, click.x, click.y, click.collision, click.button, click.device], [3, 10, 20, 'Head', 0, 'mouse']);
});

test('double click: the 2nd press is dblclick, its release is up + click (C11)', () => {
  const { m, at, seq, clock } = setup();
  m.down({ ...at(110, 220), button: 0 }); m.up({ ...at(110, 220), button: 0 });
  clock.advance(200);
  m.down({ ...at(112, 221), button: 0 }); m.up({ ...at(112, 221), button: 0 });
  clock.advance(200);
  m.down({ ...at(112, 221), button: 0 }); m.up({ ...at(112, 221), button: 0 });   // 3rd click: a plain click again
  assert.deepEqual(seq(), ['enterall', 'enter', 'down', 'up+', 'click', 'dblclick', 'up+', 'click', 'down', 'up+', 'click']);
});

test('no double click when too slow, too far or another button', () => {
  const { m, at, seq, clock } = setup();
  m.down({ ...at(110, 220), button: 0 }); m.up({ ...at(110, 220), button: 0 });
  clock.advance(600);
  m.down({ ...at(110, 220), button: 0 }); m.up({ ...at(110, 220), button: 0 });
  clock.advance(100);
  m.down({ ...at(120, 220), button: 0 }); m.up({ ...at(120, 220), button: 0 });
  clock.advance(100);
  m.down({ ...at(120, 220), button: 2 }); m.up({ ...at(120, 220), button: 2 });
  assert.equal(seq().filter(t => t === 'dblclick').length, 0);
  assert.deepEqual(seq().slice(-3), ['down/1', 'up/1+', 'click/1']);   // DOM right button -> R5 1
});

test('drag: dragstart after 4 px, character follows, dragend then up, never click (C10)', () => {
  const { m, at, seq, drags } = setup();
  m.down({ ...at(110, 220), button: 0 });
  m.move({ ...at(112, 221), buttons: 1 });                 // < 4 px: still a click candidate (petting move)
  m.move({ ...at(115, 220), buttons: 1 });
  m.move({ ...at(150, 260), buttons: 1 });
  m.up({ ...at(150, 260), button: 0 });
  assert.deepEqual(seq(), ['enterall', 'enter', 'down', 'move', 'dragstart', 'dragend', 'up-']);
  assert.deepEqual(drags, [['start', 0, 0], ['move', 5, 0], ['move', 40, 40], ['end', 40, 40]]);
  // the next press is not a double click
  m.down({ ...at(150, 260), button: 0 });
  assert.equal(seq().at(-1), 'down');
});

test('right and middle buttons; Alt+left = middle; X buttons; right drag does not move', () => {
  const { m, at, seq, drags } = setup();
  m.down({ ...at(110, 220), button: 2 }); m.move({ ...at(140, 220), buttons: 2 }); m.up({ ...at(140, 220), button: 2 });
  // a right drag of a step or more is a gesture: OnMouseUp, then 'end', no click (C31, EV §4.5.1)
  assert.deepEqual(seq(), ['enterall', 'enter', 'down/1', 'up/1-', 'gesture:end']);
  m.down({ ...at(110, 220), button: 2 }); m.up({ ...at(110, 220), button: 2 });
  m.down({ ...at(110, 220), button: 1 }); m.up({ ...at(110, 220), button: 1 });
  m.down({ ...at(110, 220), button: 0, alt: true }); m.up({ ...at(110, 220), button: 0 });
  m.down({ ...at(110, 220), button: 3 }); m.up({ ...at(110, 220), button: 3 });
  assert.deepEqual(seq().filter(t => t.startsWith('click')), ['click/1', 'click/2', 'click/2', 'click/3']);
  assert.equal(drags.length, 0);
});

test('gesture helpers: JPoint::Degree (screen y flipped, exact axes) and DegreeToDirection8\'s sectors', () => {
  assert.deepEqual(GESTURE_DIRS, ['right_up', 'up', 'left_up', 'left', 'left_down', 'down', 'right_down', 'right']);
  assert.deepEqual([[5, 0], [0, -5], [-5, 0], [0, 5], [3, -3], [-3, 3]].map(([x, y]) => gestureDegree(0, 0, x, y)),
    [0, 90, 180, 270, 45, 225]);
  assert.equal(Math.round(gestureDegree(10, 10, 9, 12) * 1000) / 1000, 243.435, 'atan2 / pi, + 2 when negative, x 180');
  assert.deepEqual([22.4999, 22.5, 67.4999, 67.5, 180, 292.5, 337.4999, 337.5, 359.9, 0].map(direction8),
    [7, 0, 0, 1, 3, 6, 6, 7, 7, 7]);
});

test('right drag (mouse): 4-px steps, a direction on the 4th step of a run, end at the release; no move, click or drag', () => {
  const { m, at, seq, out, drags } = setup();
  m.down({ ...at(110, 220), button: 2 });
  for (let i = 1; i <= 6; i++) m.move({ ...at(110 - 5 * i, 220), buttons: 2 });
  for (let i = 1; i <= 5; i++) m.move({ ...at(80 + 5 * i, 220), buttons: 2 });
  m.up({ ...at(105, 220), button: 2 });
  assert.deepEqual(seq(), ['enterall', 'enter', 'down/1', 'gesture:left', 'gesture:right', 'up/1-', 'gesture:end']);
  const [left, right, end] = out.filter(i => i.type === 'gesture');
  // left: on the 4th step (x 90); the window-local points now and at the press, the press's collision
  assert.deepEqual([left.deg, left.dir, left.wx, left.wy, left.wx0, left.wy0, left.collision, left.collision0, left.sx0, left.sy0],
    [180, 3, 0, 30, 20, 30, 'Head', 'Head', 10, 20]);
  assert.deepEqual([right.deg, right.dir, right.wx], [0, 7, 10]);
  assert.notEqual(left.run, right.run, 'each sector change starts a run');
  assert.deepEqual([end.name, end.deg, end.dir, end.wx, end.button, end.device], ['end', 0, -1, 15, 1, 'mouse']);
  assert.equal(drags.length, 0);
  // no click was made: the next right press is no double click
  m.down({ ...at(105, 220), button: 2 });
  assert.equal(seq().at(-1), 'down/1');
});

test('right press: moves under 4 px make no step (the reference stays), 4 px is one; a wiggle keeps the click', () => {
  let { m, at, seq } = setup();
  m.down({ ...at(110, 220), button: 2 });
  m.move({ ...at(112, 220), buttons: 2 });
  m.move({ ...at(111, 221), buttons: 2 });
  m.up({ ...at(111, 221), button: 2 });
  assert.deepEqual(seq(), ['enterall', 'enter', 'down/1', 'up/1+', 'click/1'], 'no OnMouseMove while the right button is held');
  ({ m, at, seq } = setup());
  m.down({ ...at(110, 220), button: 2 });
  m.move({ ...at(113, 220), buttons: 2 });                 // 3 px: none
  m.move({ ...at(114, 220), buttons: 2 });                 // 4 px from the press, not from the last move: a step
  m.up({ ...at(114, 220), button: 2 });
  assert.deepEqual(seq().slice(-2), ['up/1-', 'gesture:end']);
  ({ m, at, seq } = setup());
  m.down({ ...at(110, 220), button: 2 });
  m.move({ ...at(113, 223), buttons: 2 });                 // hypot 4.24: a step (SSP's distance is Euclidean)
  m.up({ ...at(113, 223), button: 2 });
  assert.deepEqual(seq().slice(-2), ['up/1-', 'gesture:end']);
});

test('right drag circles: circle.cw / circle.ccw once all 8 sectors had a repeated step (SSP\'s sequence)', () => {
  const circle = cw => {
    const { m, at, out } = setup();
    const pts = Array.from({ length: 81 }, (_, i) => {
      const a = (cw ? -1 : 1) * 2 * Math.PI * i / 64;
      return at(Math.round(200 + 60 * Math.cos(a)), Math.round(200 - 60 * Math.sin(a)), { hit: 'Face' });
    });
    m.down({ ...pts[0], button: 2 });
    for (const p of pts.slice(1)) m.move({ ...p, buttons: 2 });
    m.up({ ...pts.at(-1), button: 2 });
    return out.filter(i => i.type === 'gesture').map(i => i.name);
  };
  assert.deepEqual(circle(true), ['down', 'left_down', 'left', 'left_up', 'up', 'right_up', 'right', 'circle.cw',
    'right_down', 'down', 'left_down', 'left', 'end']);
  assert.deepEqual(circle(false), ['up', 'left_up', 'left', 'left_down', 'down', 'right_down', 'right', 'circle.ccw',
    'right_up', 'up', 'left_up', 'left', 'end']);
});

test('gestures: a pen\'s barrel button too; 1-px moves step every 4 px; never middle, nor a right double-click\'s 2nd press', () => {
  let { m, at, seq, out, clock } = setup();
  const pen = (x, y) => at(x, y, { device: 'pen' });
  m.down({ ...pen(110, 220), button: 2 });
  for (let i = 1; i <= 4; i++) m.move({ ...pen(110 - 5 * i, 220), buttons: 2 });
  m.up({ ...pen(90, 220), button: 2 });
  assert.deepEqual(seq().slice(2), ['down/1', 'gesture:left', 'up/1-', 'gesture:end']);
  assert.ok(out.slice(2).every(i => i.device === 'pen'));
  ({ m, at, seq } = setup());
  m.down({ ...at(110, 220), button: 2 });
  for (let i = 1; i <= 20; i++) m.move({ ...at(110 - i, 220), buttons: 2 });
  m.up({ ...at(90, 220), button: 2 });
  assert.deepEqual(seq().filter(t => t.startsWith('gesture')), ['gesture:left', 'gesture:end']);
  // the middle button (DOM 1): OnMouseMove as usual, no gesture
  ({ m, at, seq } = setup());
  m.down({ ...at(110, 220), button: 1 });
  for (let i = 1; i <= 6; i++) m.move({ ...at(110 - 5 * i, 220), buttons: 4 });
  m.up({ ...at(80, 220), button: 1 });
  assert.deepEqual(seq(), ['enterall', 'enter', 'down/2', 'move', 'move', 'move', 'move', 'move', 'move', 'up/2+', 'click/2']);
  // a right double-click: its 2nd press takes the OnMouseMove path (WM_RBUTTONDBLCLK)
  ({ m, at, seq, clock } = setup());
  m.down({ ...at(110, 220), button: 2 }); m.up({ ...at(110, 220), button: 2 });
  clock.advance(100);
  m.down({ ...at(110, 220), button: 2 });
  for (let i = 1; i <= 6; i++) m.move({ ...at(110 - 5 * i, 220), buttons: 2 });
  m.up({ ...at(80, 220), button: 2 });
  assert.deepEqual(seq().slice(5), ['dblclick/1', 'move', 'move', 'move', 'move', 'move', 'move', 'up/1+', 'click/1']);
});

test('gesture cancelled (lost capture): up without click, then end at the last point seen', () => {
  const { m, at, seq, out } = setup();
  m.down({ ...at(110, 220), button: 2 });
  m.move({ ...at(100, 220), buttons: 2 });
  m.move({ ...at(98, 220), buttons: 2 });
  m.cancel(at(0, 0));
  assert.deepEqual(seq().slice(-2), ['up/1-', 'gesture:end']);
  assert.equal(out.at(-1).wx, 98 - 90);
});

test('enter / leave per collision and for the whole window; hover after 500 ms', () => {
  const { m, at, seq, clock, out } = setup();
  m.move(at(110, 220, { hit: '' }));
  m.move(at(111, 220, { hit: 'Face' }));
  m.move(at(111, 220, { hit: 'Face' }));                   // same position: no duplicate move
  clock.advance(499);
  assert.ok(!seq().includes('hover'));
  clock.advance(1);
  assert.equal(seq().at(-1), 'hover');
  assert.equal(out.at(-1).collision, 'Face');
  clock.advance(2000);
  assert.equal(seq().filter(t => t === 'hover').length, 1);
  m.move(at(112, 220, { hit: null }));                     // transparent pixel = left the character
  assert.deepEqual(seq(), ['enterall', 'enter', 'move', 'leave', 'enter', 'move', 'hover', 'leave', 'leaveall']);
  assert.equal(out.at(-1).collision, 'Face');
  m.leave(at(0, 0));
  assert.equal(seq().length, 9);
});

test('wheel: 100 px / 3 lines / 1 page per notch, +120 = away from the user (C23)', () => {
  const { m, at, out } = setup();
  m.wheel({ ...at(110, 220), deltaY: -100, deltaMode: 0 });
  m.wheel({ ...at(110, 220), deltaY: 3, deltaMode: 1 });
  m.wheel({ ...at(110, 220), deltaY: 1, deltaMode: 2 });
  m.wheel({ ...at(110, 220), deltaY: -300, deltaMode: 0 });
  assert.deepEqual(out.filter(i => i.type === 'wheel').map(i => i.wheel), [120, -120, -120, 120, 120, 120]);
  const w = new WheelAccumulator();
  assert.equal(w.push(40, 0, 0), 0);
  assert.equal(w.push(40, 0, 10), 0);
  assert.equal(w.push(40, 0, 20), -1);                    // touchpad deltas accumulate
  assert.equal(w.push(-60, 0, 30), 0);                    // direction change resets the remainder
  assert.equal(w.push(-50, 0, 5000), 0);                  // idle resets
});

test('touch: tap, double tap (300 ms / 20 px), stroke on a collision, drag elsewhere', () => {
  const { m, at, seq, clock, drags, out } = setup();
  const t = (x, y, hit = 'Head') => at(x, y, { device: 'touch', hit });
  m.down({ ...t(110, 220), button: 0 }); m.up({ ...t(110, 220), button: 0 });
  clock.advance(250);
  m.down({ ...t(125, 230), button: 0 }); m.up({ ...t(125, 230), button: 0 });
  assert.deepEqual(seq(), ['down', 'up+', 'click', 'dblclick', 'up+', 'click']);
  assert.equal(out[0].device, 'touch');
  out.length = 0;
  clock.advance(1000);
  // stroke: starts on a named collision -> OnMouseMove stream, no drag
  m.down({ ...t(110, 220), button: 0 });
  m.move(t(125, 220)); m.move(t(140, 220));
  m.up({ ...t(140, 220), button: 0 });
  assert.deepEqual(seq(), ['down', 'move', 'move', 'up+', 'click']);
  assert.equal(drags.length, 0);
  out.length = 0;
  clock.advance(1000);
  // drag: starts where there is no named collision
  m.down({ ...t(110, 220, ''), button: 0 });
  m.move(t(130, 220, ''));
  m.up({ ...t(130, 220, ''), button: 0 });
  assert.deepEqual(seq(), ['down', 'dragstart', 'dragend', 'up-']);
});

test('touch long press: on the body = right click (menu); on a named part a hold, then moving drags', () => {
  const { m, at, seq, clock, out, drags } = setup();
  const t = (x, y, hit = '') => at(x, y, { device: 'touch', hit });
  m.down({ ...t(110, 220), button: 0 });
  clock.advance(600);
  m.up({ ...t(110, 220), button: 0 });
  assert.deepEqual(seq(), ['down', 'up-', 'down/1', 'up/1+', 'click/1']);
  out.length = 0;
  // long press on a named part keeps hold semantics (Mclose): a slow click
  m.down({ ...t(110, 220, 'Mclose'), button: 0 });
  clock.advance(1200);
  m.up({ ...t(110, 220, 'Mclose'), button: 0 });
  assert.deepEqual(seq(), ['down', 'up+', 'click']);
  out.length = 0;
  // long press on a named part, then move: drag
  m.down({ ...t(110, 220, 'Head'), button: 0 });
  clock.advance(600);
  m.move(t(140, 220, 'Head'));
  m.up({ ...t(140, 220, 'Head'), button: 0 });
  assert.deepEqual(seq(), ['down', 'dragstart', 'dragend', 'up-']);
  assert.deepEqual(drags.at(-1), ['end', 30, 0]);
});

test('touch long press on the body, then a move of 10 px: a right drag, so gestures [decision]; steps for the wheel', () => {
  let { m, at, seq, clock, out, drags } = setup();
  const t = (x, y, hit = '') => at(x, y, { device: 'touch', hit });
  m.down({ ...t(110, 220), button: 0 });
  clock.advance(600);
  m.move(t(98, 220));                                       // 12 px: the right press, and the first step from the press point
  for (let i = 1; i <= 3; i++) m.move(t(98 - 5 * i, 220));
  assert.deepEqual(seq(), ['down', 'up-', 'down/1', 'gesture:left']);
  m.up({ ...t(83, 220), button: 0 });
  assert.deepEqual(seq().slice(-2), ['up/1-', 'gesture:end']);
  assert.ok(out.every(i => i.device === 'touch'));
  assert.deepEqual([out[2].x, out[2].y, out[3].collision0, out[3].wx0], [10, 20, '', 20], 'the right press at the press point');
  assert.equal(drags.length, 0);
  assert.ok(!seq().includes('step'), 'no wheel steps for left or right');
  // a swipe up: each repeated up step is a 'gesturestep' (before the step's gesture), all of one run
  ({ m, at, seq, clock, out } = setup());
  const u = (x, y) => at(x, y, { device: 'touch', hit: '' });
  m.down({ ...u(110, 220), button: 0 });
  clock.advance(600);
  for (let i = 0; i < 7; i++) m.move(u(110, 208 - 5 * i));
  assert.deepEqual(seq(), ['down', 'up-', 'down/1', 'step', 'step', 'step', 'gesture:up', 'step', 'step', 'step']);
  assert.equal(new Set(out.slice(3).map(i => i.run)).size, 1);
  assert.deepEqual([out.at(-1).dir, out.at(-1).sx0, out.at(-1).sy0], [1, 10, 20]);
  // a mouse swipe up never makes steps for the wheel
  ({ m, at, seq } = setup());
  m.down({ ...at(110, 220), button: 2 });
  for (let i = 1; i <= 7; i++) m.move({ ...at(110, 220 - 5 * i), buttons: 2 });
  assert.deepEqual(seq().slice(2), ['down/1', 'gesture:up']);
  // a body drag without a long press still moves her (the long press alone still opens the menu: the test above)
  ({ m, at, seq, clock, drags } = setup());
  m.down({ ...t(110, 220), button: 0 });
  m.move(t(130, 220));
  m.up({ ...t(130, 220), button: 0 });
  assert.deepEqual(seq(), ['down', 'dragstart', 'dragend', 'up-']);
  assert.equal(drags.length, 3);
});

test('cancel ends a press without click; presses on transparent pixels are ignored', () => {
  const { m, at, seq } = setup();
  assert.equal(m.down({ ...at(110, 220), hit: null, button: 0 }), false);
  m.down({ ...at(110, 220), button: 0 });
  m.move({ ...at(130, 220), buttons: 1 });
  m.cancel(at(130, 220));
  assert.deepEqual(seq(), ['enterall', 'enter', 'down', 'dragstart', 'dragend', 'up-']);
});

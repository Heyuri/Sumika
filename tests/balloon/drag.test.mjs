// Dragging a balloon (UI §4.6, BA §4 userDragOffset) on a fake DOM: the press threshold, clicks vs drags, the offset
// kept relative to the character (follows it, survives side flips and \b changes), viewport clamp, persistence, reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake_dom.mjs';
import { fixture } from './setup.mjs';
import { play } from './script.mjs';
import { Emitter } from '../../src/core/emitter.js';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

installFakeDom();
const { Balloons } = await import('../../src/balloon/manager.js');

class MockStage extends Emitter {
  constructor() {
    super();
    this.rects = { 0: { x: 900, y: 300, width: 200, height: 400 } };
  }
  char(scope) {
    return { rect: this.rects[scope] || { x: 300, y: 600, width: 0, height: 0 }, balloonOffset: scope === 0 ? { x: 2, y: 14 } : { x: 0, y: 0 } };
  }
  move(scope, x, y) { Object.assign(this.rects[scope], { x, y }); this.emit('move', { scope }); }
}

const SCRIPT = '\\0\\b[2]\\_q\\__q[ok]Sure, why not\\__q\\n\\nJust text here.\\e';

async function setup({ descript, state } = {}) {
  const { skin, ghost } = await fixture();
  const stage = new MockStage();
  const b = new Balloons({ skin, ghostFiles: ghost, stage, ghostDescript: descript || new Map(), state });
  const v = b.get(0);
  play(b, SCRIPT);
  const events = [];
  for (const t of ['link', 'click', 'dblclick', 'state']) b.on(t, e => events.push(t === 'link' ? 'link:' + e.id : t));
  return { b, v, stage, events };
}

const pos = v => [parseFloat(v.dom.el.style.left), parseFloat(v.dom.el.style.top)];

/** A viewport point on the choice (balloon-space search of the link area). */
function onChoice(v) {
  for (let by = 0; by < v.height; by += 2) {
    for (let bx = 0; bx < v.width; bx += 2) if (v.engine.linkAt(bx, by) >= 0) return [v.x + bx + 2, v.y + by + 2];
  }
  throw new Error('no choice drawn');
}

const ptr = (x, y, o = {}) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...o });

test('a press that moves less than 4 px is a click (choice selected); 4 px or more is a drag (no click)', { ...real, timeout: 5000 }, async () => {
  const { b, v, events } = await setup();
  const main = v.dom.main;
  assert.deepEqual(pos(v), [562, 314]);
  const [cx, cy] = onChoice(v);
  main.fire('pointerdown', ptr(cx, cy));
  assert.equal(main.captured, 1, 'the pointer is captured so a drag keeps following it outside the balloon');
  main.fire('pointermove', ptr(cx + 3, cy - 3));
  main.fire('pointerup', ptr(cx + 3, cy - 3));
  main.fire('click', ptr(cx + 3, cy - 3));
  assert.deepEqual(pos(v), [562, 314], 'not moved');
  assert.deepEqual(events, ['link:ok']);
  assert.equal(main.captured, undefined, 'released');

  events.length = 0;
  main.fire('pointerdown', ptr(cx, cy));
  main.fire('pointermove', ptr(cx + 2, cy + 1));
  assert.deepEqual(pos(v), [562, 314], 'below the threshold nothing moves');
  main.fire('pointermove', ptr(cx - 40, cy - 30));
  assert.deepEqual(pos(v), [522, 284], 'the balloon follows the pointer');
  assert.equal(main.classList.contains('smk-link'), false, 'no link cursor while dragging');
  assert.equal(v.hoverLink, -1, 'no choice highlight while dragging');
  main.fire('pointerup', ptr(cx - 50, cy - 34));
  main.fire('click', ptr(cx - 50, cy - 34));
  main.fire('dblclick', ptr(cx - 50, cy - 34));
  assert.deepEqual(pos(v), [512, 280]);
  assert.deepEqual(events, ['state'], 'a drag is no click, no choice and no double click; the new offset is saved');
  assert.deepEqual(b.saveState()[0].userOffset, [-50, -34]);

  // the next plain click works again
  events.length = 0;
  const [dx, dy] = onChoice(v);
  main.fire('pointerdown', ptr(dx, dy));
  main.fire('pointerup', ptr(dx, dy));
  main.fire('click', ptr(dx, dy));
  assert.deepEqual(events, ['link:ok']);
  b.destroy();
});

test('the dragged offset follows the character, survives side flips and \\b changes; Reset position clears it', { ...real, timeout: 5000 }, async () => {
  const { b, v, stage, events } = await setup();
  const main = v.dom.main;
  main.fire('pointerdown', ptr(700, 400));
  main.fire('pointermove', ptr(650, 366));
  main.fire('pointerup', ptr(650, 366));
  assert.deepEqual(pos(v), [512, 280]);
  stage.move(0, 600, 250);
  assert.equal(v.side, 'left');
  assert.deepEqual(pos(v), [600 - 340 + 2 - 50, 250 + 14 - 34], 'dragging the character moves its balloon along');
  b.toggleSide(0);
  assert.equal(v.side, 'right');
  assert.deepEqual(pos(v), [600 + 200 - 2 - 50, 250 + 14 - 34], 'right click keeps the user offset');
  v.setKind(0);
  assert.deepEqual(pos(v), [600 + 200 - 2 - 50, 250 + 14 - 34], 'a \\b change keeps it too');
  assert.deepEqual(b.saveState()[0].userOffset, [-50, -34]);
  events.length = 0;
  b.resetOffsets();
  assert.deepEqual(pos(v), [600 + 200 - 2, 250 + 14], 'back next to the character');
  assert.deepEqual(b.saveState()[0].userOffset, [0, 0]);
  assert.deepEqual(events, ['state']);
  b.destroy();
});

test('dragging is clamped to the viewport; the saved offset brings the balloon back after navigation', { ...real, timeout: 5000 }, async () => {
  const { b, v } = await setup();
  const main = v.dom.main;
  main.fire('pointerdown', ptr(700, 400));
  main.fire('pointermove', ptr(-3000, -3000));
  assert.deepEqual(pos(v), [0, 0], 'never off the top-left');
  main.fire('pointermove', ptr(5000, 5000));
  assert.deepEqual(pos(v), [1280 - v.width, 720 - v.height], 'never off the bottom-right');
  main.fire('pointermove', ptr(600, 380));
  main.fire('pointerup', ptr(600, 380));
  assert.deepEqual(pos(v), [462, 294]);
  const saved = JSON.parse(JSON.stringify(b.saveState()));
  assert.deepEqual(saved[0].userOffset, [-100, -20]);
  b.destroy();

  const again = await setup({ state: saved });
  assert.deepEqual(pos(again.v), [462, 294], 'same place on the next page');
  again.b.destroy();
});

test('touch needs 10 px; the right button, secondary touches and balloon.dontmove never drag', { ...real, timeout: 5000 }, async () => {
  const { b, v, events } = await setup();
  const main = v.dom.main;
  const touch = (x, y) => ptr(x, y, { pointerType: 'touch', pointerId: 7 });
  main.fire('pointerdown', touch(700, 400));
  main.fire('pointermove', touch(706, 400));
  assert.deepEqual(pos(v), [562, 314], 'a shaky tap is still a tap');
  main.fire('pointermove', touch(712, 400));
  assert.deepEqual(pos(v), [574, 314]);
  main.fire('pointercancel', touch(0, 0));
  assert.deepEqual(pos(v), [574, 314], 'a cancelled drag stays where it was');
  assert.deepEqual(b.saveState()[0].userOffset, [12, 0]);

  main.fire('pointerdown', ptr(700, 400, { button: 2 }));
  main.fire('pointermove', ptr(760, 400, { button: 2 }));
  main.fire('pointerdown', ptr(700, 400, { pointerId: 8, pointerType: 'touch', isPrimary: false }));
  main.fire('pointermove', ptr(760, 400, { pointerId: 8, pointerType: 'touch', isPrimary: false }));
  assert.deepEqual(pos(v), [574, 314]);
  b.destroy();

  const fixed = await setup({ descript: new Map([['balloon.dontmove', 'true']]) });
  const m = fixed.v.dom.main;
  assert.equal(m.classList.contains('smk-fixed'), true, 'touch-action stays manipulation');
  m.fire('pointerdown', ptr(700, 400));
  m.fire('pointermove', ptr(600, 300));
  m.fire('pointerup', ptr(600, 300));
  m.fire('click', ptr(600, 300));
  assert.deepEqual(pos(fixed.v), [562, 314]);
  assert.deepEqual(fixed.events, ['click'], 'a balloon that cannot move just gets the click');
  fixed.b.destroy();
  assert.deepEqual(events.filter(e => e !== 'state'), []);
});

// F1 (ssp-ui.md §9.11): a second finger on a character never takes over the first finger's press. While a press is
// held, pointer events of another pointerId are not the ghost's (down, move, up, cancel, lost capture); with no press
// held every pointer is taken. A mouse (one pointerId, or events without one) is not affected. The DOM fakes are tests/shell/dom.test.mjs's, copied; the shell is a synthetic one (helpers.mjs sizedStage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizedStage } from './helpers.mjs';

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
    this.puts = 0;
  }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  attachShadow() {
    const r = new El('#shadow');
    r.getElementById = id => r.children.find(c => c.id === id) || null;
    this.shadowRoot = r;
    return r;
  }
  getContext() { return { putImageData: img => { this.lastPut = img; this.puts++; } }; }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture() { this.captured = null; }
  fire(type, e) {
    const ev = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...e };
    for (const f of this.listeners[type] || []) f(ev);
    return ev;
  }
}

function installDom() {
  const body = new El('body');
  globalThis.document = {
    createElement: t => new El(t),
    body,
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
  globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
}

installDom();

/** a DOM Stage on a synthetic shell: \0 220×380 at the desk's bottom right (rect 1060,340), opaque inside 20..200 × 20..380 */
async function charStage() {
  const t = { now: 0 };
  const clock = { now: () => t.now, requestFrame: () => {}, setTimeout: () => 0, clearTimeout: () => {} };
  const stage = await sizedStage({ sizes: { 0: [220, 380], 10: [4, 4] }, opaque: { 0: [20, 20, 200, 380] }, dom: true, clock,
    random: () => 0.99 });
  await stage.images.load(['surface0.png', 'surface10.png']);
  stage.tick(0);
  const v = stage.char(0);
  assert.deepEqual(v.rect, { x: 1060, y: 340, width: 220, height: 380 });
  assert.ok(v.image, 'composed');
  const events = [];
  stage.on('mouse', m => events.push(m));
  return { stage, v, cv: v.canvas, el: v.element, events, t };
}

/** a pointer event at surface (sx, sy) of the character at 1060,340 */
const at = (sx, sy, extra = {}) => ({ clientX: 1060 + sx, clientY: 340 + sy, pointerType: 'touch', pointerId: 5, button: 0, buttons: 1,
  altKey: false, ...extra });

test('two fingers: the second finger\'s down, move, up and lost capture change nothing; the first finger\'s drag ends normally', async () => {
  const { stage, v, cv, el, events } = await charStage();
  assert.equal(el.style.transform, 'translate(1170px,720px)');
  const A = (sx, sy, e = {}) => at(sx, sy, { pointerId: 5, ...e });
  const B = (sx, sy, e = {}) => at(sx, sy, { pointerId: 6, ...e });
  cv.fire('pointerdown', A(100, 100));
  assert.equal(cv.captured, 5);
  cv.fire('pointermove', A(80, 100));                      // 20 px: a drag (touch needs 10)
  assert.equal(el.style.transform, 'translate(1150px,720px)');
  const down2 = cv.fire('pointerdown', B(40, 160));
  assert.ok(down2.stopped, 'still a press on her: the page does not get it');
  cv.fire('pointermove', B(180, 160));
  assert.equal(el.style.transform, 'translate(1150px,720px)', 'the second finger does not move her');
  cv.fire('pointerup', B(180, 160, { buttons: 0 }));
  cv.fire('lostpointercapture', B(180, 160, { buttons: 0 }));
  assert.ok(v.mouse.press, 'the first finger still holds her');
  assert.equal(cv.captured, 5, 'the first finger keeps its capture');
  cv.fire('pointermove', A(60, 100));
  assert.equal(el.style.transform, 'translate(1130px,720px)', 'the first finger still drags');
  cv.fire('pointerup', A(60, 100, { buttons: 0 }));
  assert.equal(v.mouse.press, null);
  assert.equal(cv.captured, null);
  assert.deepEqual(events.map(e => e.type), ['down', 'dragstart', 'dragend', 'up']);
  assert.ok(events.every(e => e.device === 'touch'));
  stage.destroy();
});

test('two fingers: the second finger\'s cancel or lost capture (no up) does not end the first finger\'s press', async () => {
  const { stage, v, cv, events } = await charStage();
  cv.fire('pointerdown', at(100, 100, { pointerId: 5 }));
  cv.fire('pointerdown', at(40, 160, { pointerId: 9 }));
  cv.fire('pointercancel', at(40, 160, { pointerId: 9 }));
  assert.ok(v.mouse.press, 'a cancel of the other finger');
  cv.fire('lostpointercapture', at(40, 160, { pointerId: 9 }));
  assert.ok(v.mouse.press, 'its lost capture');
  cv.fire('pointerup', at(100, 100, { pointerId: 5, buttons: 0 }));
  assert.deepEqual(events.map(e => e.type), ['down', 'up', 'click'], 'a tap of the first finger');
  // the first finger's own cancel ends it, as usual (elsewhere: the same spot at once would be a double tap)
  events.length = 0;
  cv.fire('pointerdown', at(150, 250, { pointerId: 5 }));
  cv.fire('pointercancel', at(150, 250, { pointerId: 5 }));
  assert.equal(v.mouse.press, null);
  assert.deepEqual(events.map(e => [e.type, e.click]), [['down', undefined], ['up', false]]);
  stage.destroy();
});

test('a press that ended without an up never blocks the next touch, whatever its pointerId', async () => {
  const { stage, v, cv, events } = await charStage();
  cv.fire('pointerdown', at(100, 100, { pointerId: 5 }));
  cv.fire('pointercancel', at(100, 100, { pointerId: 5 }));
  events.length = 0;
  cv.fire('pointerdown', at(100, 100, { pointerId: 6 }));
  assert.equal(cv.captured, 6);
  cv.fire('pointerup', at(100, 100, { pointerId: 6, buttons: 0 }));
  assert.deepEqual(events.map(e => e.type), ['down', 'up', 'click']);
  // a press ended by the tracker itself, with no pointer event at all (no up, no cancel)
  events.length = 0;
  cv.fire('pointerdown', at(150, 200, { pointerId: 7 }));
  v.mouse.cancel(null);
  cv.fire('pointerdown', at(150, 200, { pointerId: 8 }));
  cv.fire('pointerup', at(150, 200, { pointerId: 8, buttons: 0 }));
  assert.deepEqual(events.map(e => e.type), ['down', 'up', 'down', 'up', 'click']);
  stage.destroy();
});

/** the MouseInfo stream of one mouse sequence: hover, a drag, a click, a right drag with coalesced samples */
async function mouseRun(withId) {
  const { stage, cv, el, events } = await charStage();
  const m = (sx, sy, e = {}) => {
    const o = at(sx, sy, { pointerType: 'mouse', buttons: 0, ...e });
    if (!withId) delete o.pointerId; else o.pointerId = 1;
    return o;
  };
  cv.fire('pointermove', m(100, 30));
  cv.fire('pointerdown', m(100, 30, { buttons: 1 }));
  cv.fire('pointermove', m(60, 30, { buttons: 1 }));
  cv.fire('pointerup', m(60, 30));
  cv.fire('lostpointercapture', m(60, 30));
  const moved = el.style.transform;
  cv.fire('pointerdown', m(100, 50, { buttons: 1 }));
  cv.fire('pointerup', m(100, 50));
  cv.fire('pointerdown', m(100, 50, { button: 2, buttons: 2 }));
  const samples = [1, 2, 3, 4].map(i => m(100 - 5 * i, 50, { buttons: 2 }));
  cv.fire('pointermove', { ...samples[3], getCoalescedEvents: () => samples });
  cv.fire('pointerup', m(80, 50, { button: 2 }));
  cv.fire('pointermove', m(1, 1));                         // a transparent corner: she is left
  stage.destroy();
  const out = events.map(e => [e.type, e.x, e.y, e.button, e.collision, e.device, ...(e.name ? [e.name] : [])].join(' '));
  return { moved, out };
}

test('desktop unchanged: a mouse sequence gives the desktop\'s MouseInfo stream, with a pointerId and without one', async () => {
  // recorded from character.js before F1
  const today = [
    'enterall 100 30 0  mouse', 'enter 100 30 0  mouse', 'move 100 30 0  mouse', 'down 100 30 0  mouse',
    'dragstart 100 30 0  mouse', 'dragend 100 30 0  mouse', 'up 100 30 0  mouse',
    'down 140 50 0  mouse', 'up 140 50 0  mouse', 'click 140 50 0  mouse',
    'down 140 50 1  mouse', 'gesture 120 50 1  mouse left', 'up 120 50 1  mouse', 'gesture 120 50 1  mouse end',
    'leave 100 30 0  mouse', 'leaveall 100 30 0  mouse',
  ];
  for (const withId of [true, false]) {
    const { moved, out } = await mouseRun(withId);
    assert.equal(moved, 'translate(1130px,720px)', withId ? 'pointerId 1' : 'no pointerId');
    assert.deepEqual(out, today, withId ? 'pointerId 1' : 'no pointerId');
  }
});

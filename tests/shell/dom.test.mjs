// The DOM glue of CharacterView/Stage against a minimal fake DOM: element tree in the shadow root, canvas size and
// pixels, clip-path, transforms, pointer/wheel/contextmenu handlers, z-order, frame scheduling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsFiles, GHOST, nodeDecode } from './helpers.mjs';
import { needs } from '../needs.mjs';

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
  const winListeners = {};
  globalThis.document = {
    createElement: t => new El(t),
    body,
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = {
    innerWidth: 1280, innerHeight: 720,
    addEventListener: (t, f) => { (winListeners[t] ||= []).push(f); },
    removeEventListener() {},
  };
  globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
  return { body, winListeners };
}

test('surfaceRendering: nearest-neighbour only for whole device pixels per image pixel', async () => {
  const { surfaceRendering } = await import('../../src/shell/character.js');
  for (const [kx, ky, dpr, want] of [[1, 1, 1, 'pixelated'], [1, 1, 1.25, ''], [0.8, 0.8, 1.25, 'pixelated'], [1.6, 1.6, 1.25, 'pixelated'],
    [2.4, 2.4, 1.25, 'pixelated'], [100 / 100 / 1.1, 100 / 100 / 1.1, 1.1, 'pixelated'], [0.5, 0.5, 1, ''], [-1, 1, 2, 'pixelated'],
    [1, 1.5, 1, ''], [1, 1, 2, 'pixelated'], [0.4, 0.4, 1.25, '']]) {
    assert.equal(surfaceRendering(kx, ky, dpr), want, `${kx}×${ky} at ${dpr}`);
  }
});

test('DOM: elements, painting, clip-path, transforms, pointer handlers, z-order', needs('site/ghost/tsubasa'), async () => {
  const { body, winListeners } = installDom();
  const { Stage } = await import('../../src/shell/stage.js');
  let t = 0;
  const frames = [];
  const timers = [];
  const clock = {
    now: () => t,
    requestFrame: f => frames.push(f),
    setTimeout: (f, ms) => { timers.push({ f, at: t + ms }); return timers.length; },
    clearTimeout: () => {},
  };
  const stage = await Stage.create({ files: new FsFiles(GHOST), decode: nodeDecode, clock, random: () => 0.99 });
  assert.equal(stage.dom, true);
  const flush = async () => {
    for (let i = 0; i < 30; i++) {
      const fs = frames.splice(0);
      for (const f of fs) f(t);
      await new Promise(r => setImmediate(r));
    }
  };
  await flush();
  const host = body.children.find(c => c.tagName === 'SUMIKA-ROOT');
  assert.ok(host && host.shadowRoot);
  const chars = host.shadowRoot.children.filter(c => c.className === 'smk-char');
  assert.equal(chars.length, 2);
  assert.ok(host.shadowRoot.children.some(c => c.tagName === 'STYLE' && c.id === 'style-shell'));
  const v = stage.char(0);
  const el = v.element, cv = el.children[0];
  assert.equal(el.style.display, '');
  // veiled (a cold boot before its script, EV §2.1 #24): not drawn, yet shown as far as its state and the save go
  stage.setVeiled(true);
  assert.equal(el.style.display, 'none');
  assert.equal(v.visible, true);
  assert.equal(stage.saveState().scopes[0].visible, true);
  await flush();
  assert.equal(el.style.display, 'none', 'frames keep it hidden');
  stage.setVeiled(false);
  assert.equal(el.style.display, '');
  assert.equal(el.style.transform, 'translate(1170px,720px)');
  assert.equal(cv.style.transform, 'matrix(1,0,0,1,-110,-380)');
  assert.deepEqual([cv.width, cv.height], [220, 380]);
  assert.ok(cv.puts >= 1 && cv.lastPut.width === 220);
  assert.ok(cv.style.clipPath.startsWith("path('M"));
  assert.equal(cv.style.pointerEvents, 'auto');
  // \1 shows a fully transparent 4x4: no pointer events at all
  const c1 = stage.char(1).element.children[0];
  assert.equal(c1.style.pointerEvents, 'none');
  // pointer handlers
  const events = [];
  stage.on('mouse', m => events.push(m));
  const at = (x, y, extra = {}) => ({ clientX: 1060 + x, clientY: 340 + y, pointerType: 'mouse', pointerId: 1, buttons: 0, button: 0, altKey: false, ...extra });
  cv.fire('pointermove', at(100, 30));
  assert.equal(cv.style.cursor, 'pointer');
  const down = cv.fire('pointerdown', at(100, 30, { buttons: 1 }));
  assert.ok(down.stopped && down.prevented);
  assert.equal(cv.captured, 1);
  cv.fire('pointerup', at(100, 30));
  assert.equal(cv.captured, null);
  assert.deepEqual(events.map(e => e.type), ['enterall', 'enter', 'move', 'down', 'up', 'click']);
  assert.equal(events[3].collision, 'Head');
  // transparent corner: ignored, not captured
  events.length = 0;
  const miss = cv.fire('pointerdown', at(1, 1));
  assert.ok(!miss.stopped);
  assert.equal(events.length, 0);
  // wheel and context menu
  const w = cv.fire('wheel', at(100, 30, { deltaY: -100, deltaMode: 0 }));
  assert.ok(w.prevented);
  assert.deepEqual(events.filter(e => e.type === 'wheel').map(e => e.wheel), [120]);
  assert.ok(cv.fire('contextmenu', at(100, 30)).prevented);
  // drag moves the element
  t += 1000;
  cv.fire('pointerdown', at(100, 30, { buttons: 1 }));
  cv.fire('pointermove', at(60, 30, { buttons: 1 }));
  cv.fire('pointerup', at(60, 30));
  assert.equal(el.style.transform, 'translate(1130px,720px)');
  // a right drag is a gesture (EV §4.5.1): every coalesced sample a step, the point in the window (the base rect), the
  // collision by shape; she does not move
  events.length = 0;
  const vr = v.rect;
  cv.fire('pointerdown', at(60, 30, { button: 2, buttons: 2 }));
  const samples = [1, 2, 3, 4].map(i => at(60 - 5 * i, 30, { buttons: 2 }));
  cv.fire('pointermove', { ...samples[3], getCoalescedEvents: () => samples });
  cv.fire('pointerup', at(40, 30, { button: 2 }));
  assert.deepEqual(events.filter(e => !/^(enter|leave)/.test(e.type)).map(e => e.type + (e.name ? ':' + e.name : '')),
    ['down', 'gesture:left', 'up', 'gesture:end']);
  const gl = events.find(e => e.name === 'left');
  assert.deepEqual([gl.wx, gl.wy, gl.wx0, gl.wy0, gl.collision0], [1060 + 40 - vr.x, 340 + 30 - vr.y, 1060 + 60 - vr.x, 340 + 30 - vr.y, 'Head']);
  assert.equal(el.style.transform, 'translate(1130px,720px)');
  // the collision by shape: surface pixel (75,8) is transparent yet inside Head; the captured pointer ending there names
  // Head (SSP's GetCollisionNameChar tests no alpha), where a hit test finds nothing
  assert.equal(v.hitTestSurface(75, 8), null);
  assert.equal(v.collisionAtSurface(75, 8), 'Head');
  events.length = 0;
  cv.fire('pointerdown', at(60, 30, { button: 2, buttons: 2 }));            // surface (100,30): opaque Head
  const toCorner = [1, 2, 3, 4].map(i => at(60 - 6.25 * i, 30 - 5.5 * i, { buttons: 2 }));   // to surface (75,8)
  cv.fire('pointermove', { ...toCorner[3], getCoalescedEvents: () => toCorner });
  cv.fire('pointerup', at(35, 8, { button: 2 }));
  const end = events.find(e => e.name === 'end');
  assert.ok(end, 'a gesture');
  assert.deepEqual([end.collision, end.collision0], ['Head', 'Head']);
  // z-order: the scope operated last is in front
  assert.ok(+stage.char(0).element.style.zIndex > +stage.char(1).element.style.zIndex);
  // a talk animation schedules frames; resize re-lays out from ratios
  v.onTalk(1);
  assert.ok(frames.length > 0);
  document.documentElement.clientWidth = 640;
  for (const f of winListeners.resize || []) f();
  assert.equal(el.style.transform, `translate(${(1130 / 1280) * 640}px,720px)`);
  // hide / show / destroy
  v.hide();
  assert.equal(el.style.display, 'none');
  v.show();
  assert.equal(el.style.display, '');
  // image-rendering (UI §9.9): nearest-neighbour when every image pixel covers whole device pixels, so a character at a
  // fractional device position stays pixel-exact; smoothed otherwise
  assert.equal(cv.style.imageRendering, 'pixelated', 'devicePixelRatio 1, no scaling: 1 device px per image px');
  globalThis.devicePixelRatio = 1.25;
  try {
    stage.refreshResolution();
    assert.equal(cv.style.imageRendering, '', 'no choice on a 125 % display: 1.25 device px per image px');
    stage.setScale(0.8);                                 // Shell scaling 100 %
    assert.equal(cv.style.imageRendering, 'pixelated');
    stage.setScale(1.6);                                 // 200 %
    assert.equal(cv.style.imageRendering, 'pixelated');
    v.setScaling(75);                                    // \![set,scaling,75] on top: 1.5 device px per image px
    assert.equal(cv.style.imageRendering, '');
    v.setScaling(-50, 50);                               // mirrored, 1 device px per image px
    assert.equal(cv.style.imageRendering, 'pixelated');
    v.setScaling(100);
    stage.setScale(1);
    assert.equal(cv.style.imageRendering, '');
  } finally {
    delete globalThis.devicePixelRatio;
  }
  stage.destroy();
  assert.ok(!host.shadowRoot.children.includes(el));
});

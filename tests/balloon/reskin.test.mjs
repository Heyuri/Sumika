// Balloon change and shell change on the balloon side (BA §12): BalloonModel/BalloonView/Balloons/Dialogs.setSkin
// re-skin in place, Balloons/Dialogs.setStage follow another Stage. Two small synthetic skins, loaded like real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, tick } from './fake_dom.mjs';
import { Emitter } from '../../src/core/emitter.js';
import { setLogLevel } from '../../src/core/log.js';

installFakeDom();
setLogLevel('error');
const { BalloonSkin } = await import('../../src/balloon/skin.js');
const { Balloons } = await import('../../src/balloon/manager.js');
const { Dialogs } = await import('../../src/balloon/dialogs.js');
const { getRoot } = await import('../../src/ui/root.js');

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

function skinFiles(name, margin, sizes) {
  const files = {
    'descript.txt': [`charset,UTF-8`, `name,${name}`, 'type,balloon', `validrect.left,${margin}`, `validrect.top,${margin}`,
      `validrect.right,-${margin}`, `validrect.bottom,-${margin}`, `wordwrappoint.x,-${margin}`, 'font.height,12',
      'communicatebox.x,8', 'communicatebox.y,18', 'communicatebox.width,180', 'communicatebox.height,18'].join('\r\n'),
  };
  for (const [stem, [w, h]] of Object.entries(sizes)) files[stem + '.png'] = png(w, h);
  return new MemFiles(files);
}

// Alpha: 200 px wide, text 180 px (30 half-width characters); has \b[2]. Beta: 300 px wide, text 260 px (44); no \b[2].
const A = await BalloonSkin.load(skinFiles('Alpha', 10, {
  balloons0: [200, 100], balloons1: [200, 100], balloons2: [200, 300], balloons3: [200, 300], balloonk0: [200, 80], balloonk1: [200, 80],
  balloonc1: [240, 42], balloonc3: [240, 42], arrow0: [8, 8], arrow1: [8, 8], marker: [6, 6],
}), { decode: false });
const B = await BalloonSkin.load(skinFiles('Beta', 20, {
  balloons0: [300, 150], balloons1: [300, 150], balloonk0: [300, 100], balloonk1: [300, 100],
  balloonc1: [280, 44], balloonc3: [280, 44], arrow0: [8, 8], arrow1: [8, 8], clickwait: [12, 12], marker: [10, 10],
}), { decode: false });

class MockStage extends Emitter {
  constructor(x = 900) {
    super();
    this.rects = { 0: { x, y: 300, width: 200, height: 400 }, 1: { x: x - 400, y: 500, width: 100, height: 200 } };
    this.shell = { descript: new Map() };
  }
  char(scope) { return { rect: this.rects[scope] || { x: 0, y: 0, width: 0, height: 0 }, balloonOffset: { x: 0, y: 0 } }; }
  move(scope, x, y) { Object.assign(this.rects[scope], { x, y }); this.emit('move', { scope }); }
}

const rows = v => new Set(v.engine.elements.filter(e => e.t === 'g').map(e => e.y)).size;

test('Balloons.setSkin: the text stays and is laid out again on the new image; image emitted', () => {
  // the skins are what the tests assume
  assert.deepEqual([A.name, B.name], ['Alpha', 'Beta']);
  assert.deepEqual([A.images.get('balloons0').geo.lineLimit, B.images.get('balloons0').geo.lineLimit], [180, 260]);
  assert.deepEqual([A.hasKind(0, 2), B.hasKind(0, 2)], [true, false]);
  const b = new Balloons({ skin: A, root: null, stage: new MockStage(), ghostDescript: new Map() });
  const v = b.get(0);
  v.write('x'.repeat(60));
  v.marker();
  assert.equal(v.visible, true);
  assert.equal(rows(v), 2, 'Alpha: 30 + 30 characters');
  const before = v.text();
  const ops = JSON.stringify(v.snapshot().layout.ops);
  const seen = [];
  v.on('image', img => seen.push(img && img.name));
  b.setSkin(B);
  assert.equal(b.skin, B);
  assert.equal(v.skin, B);
  assert.equal(v.visible, true, 'an open balloon stays open');
  assert.equal(v.engine.geo, B.images.get('balloons0').geo);
  assert.equal(v.width, 300);
  assert.equal(v.text().replace(/\n/g, ''), before.replace(/\n/g, ''), 'same text');
  assert.equal(rows(v), 2, 'Beta: 44 + 16 characters');
  assert.equal(v.engine.elements.filter(e => e.t === 'g' && e.y === v.engine.elements[0].y).length, 44,
    'wrapped at the new limit (the character that crosses it stays, BA §3.5)');
  const snap = v.snapshot().layout;
  assert.match(JSON.stringify(snap.ops), /x{60}/, 'the script content is still in the snapshot');
  assert.equal(JSON.stringify(snap.ops.filter(o => o[0] !== 'm')), JSON.stringify(JSON.parse(ops).filter(o => o[0] !== 'm')));
  const m = v.engine.elements.find(e => e.img && e.img.key === 'part:marker');
  assert.deepEqual([m.w, m.h], [10, 10], 'the \\![*] marker takes the new marker size');
  assert.deepEqual(seen, ['balloons0']);
  b.destroy();
});

test('Balloons.setSkin: every balloon goes back to its scope\'s default kind; \\b changes are not replayed', () => {
  const b = new Balloons({ skin: A, root: null, ghostDescript: new Map([['kero.balloon.defaultsurface', '2']]) });
  const s = b.get(0), k = b.get(1);
  s.setKind(2);
  s.write('menu');
  k.write('kero');
  k.setKind(0);
  k.write('more');
  assert.deepEqual([s.kind, s.height, k.kind], [2, 300, 0]);
  b.setSkin(B);
  assert.deepEqual([s.kind, s.height], [0, 150], 'scope 0: its default kind 0');
  assert.equal(k.kind, 0, 'Beta has no \\b[2]: kind 0');
  assert.ok(!k.snapshot().layout.ops.some(o => o[0] === 'G'), 'the old images\' geometry is not replayed');
  b.setSkin(A);
  assert.deepEqual([k.kind, k.height], [2, 300], 'scope 1: its default kind 2 again');
  assert.match(k.text(), /keromore/);
  b.destroy();
});

test('Balloons.setSkin: side, drag offset and \\![set,balloon…] are kept; saveState has the same shape', () => {
  const stage = new MockStage(500);     // room on both sides of the character
  const b = new Balloons({ skin: A, root: null, stage, ghostDescript: new Map() });
  const v = b.get(0);
  v.write('hello');
  b.toggleSide(0);
  b._drag(0, 'start');
  b._drag(0, 'end', -30, 20);
  b.setOffset(0, '@5', '');
  const before = b.saveState();
  assert.equal(before[0].side, 'right');
  assert.deepEqual(before[0].userOffset, [-30, 20]);
  const at = [v.x, v.y];
  b.setSkin(B);
  assert.deepEqual(b.saveState(), before);
  assert.equal(v.side, 'right');
  assert.equal(v.img.name, 'balloons1', 'the right-side image of the new skin');
  assert.deepEqual([v.x, v.y], at, 'right of the character, dragged as before');
  b.setAlign(0, 'top');
  const aligned = b.saveState();
  assert.equal(aligned[0].alignOverride, 'top');
  b.setSkin(A);
  assert.deepEqual(b.saveState(), aligned);
  b.destroy();
});

test('Balloons.setSkin: a saved snapshot restored after the change is laid out on the new skin', () => {
  const a = new Balloons({ skin: A, root: null, ghostDescript: new Map() });
  a.get(0).write('y'.repeat(40));
  const saved = a.saveState({ content: true });
  a.destroy();
  const b = new Balloons({ skin: A, root: null, ghostDescript: new Map(), state: saved });
  b.setSkin(B);
  const v = b.get(0);
  assert.equal(v.engine.geo, B.images.get('balloons0').geo);
  assert.equal(rows(v), 1, '40 characters fit Beta\'s line');
  b.destroy();
});

/** The text of the line at the top of a balloon's view (the topmost element the view shows any of). */
function topLine(v) {
  const e = v.engine;
  let top = Infinity, line = -1;
  e.elements.forEach(el => {
    const t = el.y + el.dy;
    if (el.t !== 'p' && t + el.h > e.scrollY && t < top) { top = t; line = el.line; }
  });
  return { text: e.elements.filter(el => el.line === line && el.t === 'g').map(el => el.ch).join(''), off: e.scrollY - top };
}

test('Balloons.setSkin: a balloon the visitor scrolled up keeps the line it shows at the top (BA §12.2 #5)', () => {
  const b = new Balloons({ skin: A, root: null, ghostDescript: new Map() });
  const v = b.get(0);
  for (let i = 0; i < 30; i++) { v.write('line ' + i); v.newline(); }
  v.addChoice('Pick me', { id: 'x' });
  const e = v.engine;
  assert.ok(e.maxScroll > 100, 'the text overflows Alpha');
  v.scrollBy(-100);
  const at = topLine(v);
  assert.match(at.text, /^line \d+$/);
  b.setSkin(A);
  assert.equal(e.scrollY, e.maxScroll - 100, 'the same skin again: the same place');
  b.setSkin(B);
  assert.ok(e.scrollY < e.maxScroll, 'not sent back to the bottom');
  assert.deepEqual(topLine(v), at, 'Beta (wider and taller) shows the same line at the top');
  assert.equal(e.autoscroll, true, 'autoscroll untouched');
  v.write('more');
  assert.equal(e.scrollY, e.maxScroll, 'new text still follows the end');
  b.setSkin(A);
  assert.equal(e.scrollY, e.maxScroll, 'a balloon at the bottom stays at the bottom');
  b.destroy();
});

test('Balloons.setStage: placed against the new stage; the old stage\'s moves are ignored', () => {
  const s1 = new MockStage(900), s2 = new MockStage(700);
  const b = new Balloons({ skin: A, root: null, stage: s1, ghostDescript: new Map() });
  const v = b.get(0);
  v.write('hi');
  const x1 = v.x;
  b.setStage(s2);
  assert.equal(b.stage, s2);
  assert.equal(v.x, x1 - 200, 'placed again next to the new character');
  s1.move(0, 300, 300);
  assert.equal(v.x, x1 - 200, 'the old stage is not followed');
  assert.equal(s1._handlers.get('move').size, 0);
  s2.move(0, 800, 300);
  assert.equal(v.x, x1 - 100, 'the new one is');
  b.destroy();
  assert.equal(s2._handlers.get('move').size, 0);
});

test('BalloonView.setSkin (DOM): canvases resized, click-wait part and hit area refreshed, repainted', async () => {
  const b = new Balloons({ skin: A, stage: new MockStage(), ghostDescript: new Map() });
  const v = b.get(0);
  assert.ok(v.dom, 'drawn into the fake DOM');
  v.write('abc');
  v.showClickWait(true);
  await tick(10);
  assert.equal(v.dom.el.style.width, '200px');
  const paints = v.dom.mctx.calls.filter(c => c[0] === 'clearRect').length;
  b.setSkin(B);
  assert.equal(v.dom.el.style.width, '300px');
  assert.equal(v.dom.el.style.height, '150px');
  assert.equal(v.dom.main.width, 300);
  assert.equal(v.dom.wait.style.width, '12px', 'Beta\'s clickwait.png');
  assert.equal(v.dom.wait.hidden, false, 'still waiting');
  await tick(10);
  assert.ok(v.dom.mctx.calls.filter(c => c[0] === 'clearRect').length > paints, 'a full repaint');
  b.destroy();
});

test('Dialogs.setSkin: open boxes stay open with their text (headless and drawn), new look, same place, focus kept', async () => {
  const headless = new Dialogs({ skin: A, root: null });
  const p = headless.inputBox({ id: 'a', defaultText: 'hello' });
  headless.setSkin(B);
  assert.equal(headless.skin, B);
  assert.deepEqual(headless.saveState().map(s => [s.kind, s.id, s.text]), [['input', 'a', 'hello']]);
  headless.submit('a');
  assert.equal((await p).text, 'hello');

  const stage = new MockStage();
  const d = new Dialogs({ skin: A, stage, balloons: { views: new Map() } });
  const done = d.inputBox({ id: 'b' });
  const comm = d.communicateBox({ onSend() {} });
  const [box, cbox] = d.boxes;
  assert.equal(box.el.style.width, '240px');
  box.input.value = 'typed';
  box.input.focus();
  box.el.style.left = '123px';      // the visitor dragged it there
  const old = box.el;
  d.setSkin(B);
  assert.equal(d.boxes.length, 2, 'nothing closed');
  assert.notEqual(box.el, old, 'drawn again');
  assert.equal(old.parent, null, 'the old element is gone');
  assert.equal(box.el.parent, getRoot());
  assert.equal(box.el.style.width, '280px', 'Beta\'s balloonc3');
  assert.equal(box.input.value, 'typed');
  assert.equal(box.el.style.left, '123px', 'same place');
  assert.equal(globalThis.document.activeElement, box.input, 'the focus stays in the field');
  assert.equal(cbox.el.style.width, '280px', 'the communicate box too');
  assert.ok(cbox.buttons.length === 2, 'with its OK and × again');
  assert.deepEqual(d.saveState().map(s => s.text), ['typed', '']);
  d.submit('b');
  assert.equal((await done).text, 'typed');
  d.close();
  assert.equal(await comm, null);
});

test('Dialogs.setStage: open boxes are placed again near the new characters, unless dragged', () => {
  const s1 = new MockStage(900), s2 = new MockStage(300);
  const d = new Dialogs({ skin: A, stage: s1, balloons: { views: new Map() } });
  d.inputBox({ id: 'a' });
  d.inputBox({ id: 'b', scope: 1 });
  const [a, b] = d.boxes;
  const ax = a.el.style.left;
  const bg = b.el.children.find(c => c.tagName === 'CANVAS');
  bg.fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  bg.fire('pointermove', { clientX: 20, clientY: 15, pointerId: 1 });
  bg.fire('pointerup', { pointerId: 1 });
  const bx = b.el.style.left;
  d.setStage(s2);
  assert.equal(d.stage, s2);
  assert.notEqual(a.el.style.left, ax, 'moved next to the new character');
  assert.equal(b.el.style.left, bx, 'the dragged box stays where the visitor put it');
  d.close();
});

test('Dialogs.setStage: a box whose character has no size yet stays put until the character has one', () => {
  const none = () => ({ x: 0, y: 0, width: 0, height: 0 });
  const s1 = new MockStage(900), s2 = new MockStage(300);
  s2.rects = { 0: none(), 1: none() };       // the runtime's swap: every character of the new stage without a surface
  const d = new Dialogs({ skin: A, stage: s1, balloons: { views: new Map() } });
  d.communicateBox({});
  d.inputBox({ id: 'b', scope: 1 });
  const [c, b] = d.boxes;
  const at = box => [box.el.style.left, box.el.style.top];
  const c0 = at(c), b0 = at(b);
  d.setStage(s2);
  assert.deepEqual([at(c), at(b)], [c0, b0], 'both stay where they were (not the top-left corner)');
  const moves = () => (s2._handlers.get('move') || new Set()).size;
  assert.equal(moves(), 1, 'waiting for the characters');
  s2.move(0, 10, 10);                        // still no size: nothing yet
  assert.deepEqual(at(c), c0);
  s2.rects[0] = { x: 300, y: 300, width: 200, height: 400 };
  s2.move(0, 300, 300);                      // OnShellChanged's surface: placed above the new character
  assert.deepEqual(at(c), [Math.round(400 - c.size.w / 2) + 'px', Math.round(300 - c.size.h - 8) + 'px']);
  assert.deepEqual(at(b), b0, 'scope 1 still has no size');
  const bg = b.el.children.find(x => x.tagName === 'CANVAS');
  bg.fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  bg.fire('pointermove', { clientX: 20, clientY: 15, pointerId: 1 });
  bg.fire('pointerup', { pointerId: 1 });
  const dragged = at(b);
  s2.rects[1] = { x: 100, y: 500, width: 100, height: 200 };
  s2.move(1, 100, 500);
  assert.deepEqual(at(b), dragged, 'dragged meanwhile: the visitor\'s place');
  assert.equal(moves(), 0, 'nothing left to wait for');
  s2.rects = { 0: none(), 1: none() };
  d.setStage(s2);
  const s3 = new MockStage(500);
  d.setStage(s3);
  assert.equal(moves(), 0, 'the next stage replaces the wait');
  s3.rects = { 0: none(), 1: none() };
  d.setStage(s3);
  assert.equal(s3._handlers.get('move').size, 1);
  d.destroy();
  assert.equal(s3._handlers.get('move').size, 0, 'destroy stops waiting');
});

test('Dialogs.setStage on a real Stage swapped the runtime\'s way: the box stays, then follows the character', async () => {
  const path = await import('node:path');
  const { Stage } = await import('../../src/shell/stage.js');
  const { FsFiles, nodeDecode, FakeClock, ROOT } = await import('../shell/helpers.mjs');
  const files = new FsFiles(path.join(ROOT, 'tests/fixtures/ghost/testghost'));
  const make = (shellId, state) => Stage.create({ files, shellId, ghostDescript: new Map(), state, dom: false, decode: nodeDecode,
    clock: new FakeClock(0), desk: { w: 1280, h: 720 } });
  const old = await make('master');
  old.char(0).setSurface(0);
  await tick(20);
  const r0 = old.char(0).rect;
  assert.ok(r0.width > 0 && r0.height > 0);
  const d = new Dialogs({ skin: A, stage: old, root: getRoot() });
  d.communicateBox({});
  const [c] = d.boxes;
  const before = [c.el.style.left, c.el.style.top];
  // runtime._swapShell: the new stage keeps the places, every character without a surface (swapStageState); here
  // \0 stands further left, as a new shell's wider or narrower surface would
  const pos = old.saveState().scopes[0].pos;
  assert.ok(pos && Number.isFinite(pos.rx));
  const neu = await make('alt', { v: 1, shell: 'alt', scopes: { 0: { surface: -1, pos: { ...pos, rx: pos.rx / 2 } }, 1: { surface: -1 } } });
  assert.equal(neu.char(0).rect.width, 0, 'no size at setStage time');
  d.setStage(neu);
  old.destroy();
  assert.deepEqual([c.el.style.left, c.el.style.top], before, 'not moved to the top-left corner');
  neu.char(0).setSurface(0);                 // OnShellChanged brings the surface back
  await tick(20);
  const r = neu.char(0).rect;
  assert.ok(r.width > 0 && r.x < r0.x);
  assert.notEqual(c.el.style.left, before[0]);
  assert.equal(c.el.style.left, Math.round(r.x + r.width / 2 - c.size.w / 2) + 'px', 'placed again above the new character');
  assert.equal(c.el.style.top, Math.round(r.y - c.size.h - 8) + 'px');
  assert.equal(d._wait, null, 'no longer listening');
  d.destroy();
  neu.destroy();
});

// Balloons/BalloonView behaviour without a DOM: visibility, kinds, placement against a mock Stage, events, state;
// Dialogs promise logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../../src/core/emitter.js';
import { Balloons } from '../../src/balloon/manager.js';
import { Dialogs } from '../../src/balloon/dialogs.js';
import { fixture, makeBalloons } from './setup.mjs';
import { DiskFiles, TSUBASA } from './node_helpers.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

class MockStage extends Emitter {
  constructor() {
    super();
    this.rects = { 0: { x: 900, y: 300, width: 200, height: 400 }, 1: { x: 100, y: 500, width: 4, height: 4 } };
    this.shell = { descript: new Map([['sakura.balloon.offsetx', '2'], ['sakura.balloon.offsety', '14']]) };
  }
  char(scope) {
    const r = this.rects[scope] || { x: 300, y: 600, width: 0, height: 0 };
    return { rect: r, balloonOffset: scope === 0 ? { x: 2, y: 14 } : { x: 0, y: 0 } };
  }
  move(scope, x, y) { Object.assign(this.rects[scope], { x, y }); this.emit('move', { scope }); }
}

test('visibility: only non-blank content opens a balloon (SUM C14); \\b[-1] hides until new content', real, async () => {
  const { balloons } = await makeBalloons();
  const v = balloons.get(0);
  const seen = [];
  v.on('visibility', on => seen.push(on));
  v.write(' 　');
  v.newline();
  v.locate('0', '0');
  assert.equal(v.visible, false);
  v.write('.');
  assert.equal(v.visible, true);
  v.setKind(2);
  v.setKind(-1);
  assert.equal(v.visible, false);
  assert.equal(v.kind, 2);
  v.newline();
  v.clear();
  assert.equal(v.visible, false);
  v.write('Um...');
  assert.equal(v.visible, true, 'shown again with the last valid kind');
  assert.equal(v.height, 384);
  assert.deepEqual(seen, [true, false, true]);
  const k = balloons.get(1);
  k.image('menu\\choice5.png', 'inline', '', []);
  assert.equal(k.visible, true, 'an image is content');
});

test('script start: reset (clear, hide, default kind) unless appending with \\C', real, async () => {
  const { skin, ghost } = await fixture();
  const b = new Balloons({ skin, ghostFiles: ghost, root: null, ghostDescript: new Map([['kero.balloon.defaultsurface', '2']]) });
  b.images.decode = false;
  assert.equal(b.defaultKind(0), 0);
  assert.equal(b.defaultKind(1), 2);
  assert.equal(b.get(1).kind, 2);
  const v = b.get(0);
  v.setKind(2);
  v.write('menu');
  v.setFont('bold', '1');
  v.toggleNoWrap();
  b.beginScript(true);
  assert.equal(v.visible, true);
  assert.equal(v.engine.elements.length, 4);
  assert.equal(v.kind, 2);
  assert.equal(v.engine.font.bold, false, 'font is script-lifetime state');
  assert.equal(v.engine.noWrap, false);
  b.beginScript(false);
  assert.equal(v.visible, false);
  assert.equal(v.engine.elements.length, 0);
  assert.equal(v.kind, 0);
  v.setKind(4);
  assert.equal(v.kind, 0, '\\0\\b[4] does not exist in LightBlue: kind kept');
  v.setKind(3);
  assert.equal(v.kind, 2, 'odd ids normalised');
  assert.deepEqual(b.visibleKinds(), []);
  v.write('x');
  assert.deepEqual(b.visibleKinds(), [[0, 2]]);
});

test('placement follows the character; right click switches sides; settings persist', real, async () => {
  const { skin, ghost } = await fixture();
  const stage = new MockStage();
  const b = new Balloons({ skin, ghostFiles: ghost, root: null, stage });
  const v = b.get(0);
  v.setKind(2);
  v.write('hello');
  assert.deepEqual([v.x, v.y, v.side], [900 - 340 + 2, 314, 'left']);
  assert.equal(v.img.name, 'balloons2');
  stage.move(0, 600, 200);
  assert.deepEqual([v.x, v.y], [600 - 340 + 2, 214]);
  b.toggleSide(0);
  assert.equal(v.side, 'right');
  assert.equal(v.img.name, 'balloons3', 'odd image on the right');
  assert.deepEqual([v.x, v.y], [800 - 2, 214]);
  stage.move(0, 1000, 200);
  assert.equal(v.side, 'left', 'no room on the right any more: flipped');
  stage.move(0, 600, 200);
  assert.equal(v.side, 'left', 'an automatic switch sticks while it fits, like SSP [observed]');
  stage.move(0, 300, 200);
  assert.equal(v.side, 'right', 'cut off on the left: right again');
  stage.move(0, 600, 200);
  assert.equal(v.side, 'right', 'and that sticks too');
  b.setOffset(0, '@10', '0');
  assert.equal(v.y, 200);
  b.setAlign(0, 'left');
  assert.equal(v.side, 'left');
  const saved = b.saveState();
  assert.deepEqual(saved[0], { kind: 2, side: 'right', userOffset: [0, 0], alignOverride: 'left', offsetOverride: { x: { rel: true, v: 10 }, y: { rel: false, v: 0 } } });
  const b2 = new Balloons({ skin, ghostFiles: ghost, root: null, stage, state: JSON.parse(JSON.stringify({ scopes: { 0: { balloon: saved[0] } } })) });
  const w = b2.get(0);
  b2.setAlign(0, '');
  w.write('again');
  assert.equal(w.side, 'right', 'restored right-click choice');
  // extra scopes are placed against their own window (a 4×4 music box here)
  const k = b.get(1);
  k.write('playlist');
  assert.equal(k.side, 'right');
  assert.deepEqual([k.x, k.y], [104, 500]);
});

test('a side switch made before the character has a size does not stick (UI §4.1): the saved side comes back', real, async () => {
  const { skin, ghost } = await fixture();
  const stage = new MockStage();
  // a resumed page: her images are not loaded yet (CharacterView.rect is 0×0), the balloon's saved side is right
  stage.rects[0] = { x: 0, y: 0, width: 0, height: 0 };
  const b = new Balloons({ skin, ghostFiles: ghost, root: null, stage, state: { 0: { kind: 2, side: 'right' } } });
  let states = 0;
  b.on('state', () => states++);
  const v = b.get(0);
  v.write('hello');
  assert.equal(v.side, 'left', 'against the placeholder at the right edge: shown on the left for now');
  assert.equal(b.saveState()[0].side, 'right', 'not remembered');
  assert.equal(states, 0);
  // the real rect arrives, mid-screen: room on the right
  Object.assign(stage.rects[0], { x: 530, y: 340, width: 220, height: 380 });
  stage.emit('move', { scope: 0 });
  assert.equal(v.side, 'right');
  assert.equal(v.x, 750 - 2);
  assert.equal(b.saveState()[0].side, 'right');
  // a hidden character never placed (0×0 at its base point) does not decide the side either
  stage.rects[1] = { x: 1270, y: 700, width: 0, height: 0 };
  const k = b.get(1);
  k.write('hi');
  assert.equal(k.side, 'left');
  assert.equal(b.saveState()[1].side, null);
  assert.equal(states, 0);
});

test('events are re-emitted with the scope; hover is aggregated', real, async () => {
  const { balloons, run } = await makeBalloons();
  await run('\\0\\b[2]\\_l[0,50]\\_l[@-2,@3]\\__q[初回空白\u0001x,r1]\\_b["menu\\choice5.png",inline]\\__q\\_l[@0,@-16]　 Nope\\n\\e');
  const got = [];
  balloons.on('link', l => got.push(['link', l]));
  balloons.on('click', c => got.push(['click', c]));
  balloons.on('dblclick', c => got.push(['dblclick', c]));
  const v = balloons.get(0);
  v.click(23 + 10, 13 + 60, 0);
  v.click(23 + 10, 13 + 200, 0);
  v.click(23 + 10, 13 + 60, 2);
  v.emit('dblclick');
  assert.deepEqual(got, [
    ['link', { kind: 'choice', id: '初回空白\u0001x', refs: ['r1'], label: '', scope: 0 }],
    ['click', { scope: 0, button: 0 }],
    ['click', { scope: 0, button: 2 }],
    ['dblclick', { scope: 0 }],
  ]);
  assert.equal(v.pointerMove(23 + 10, 13 + 60), true);
  assert.equal(v.hoverLink, 0);
  assert.equal(v.pointerMove(23 + 11, 13 + 60), false);
  v.pointerLeave();
  assert.equal(v.hoverLink, -1);
  assert.equal(balloons.hovered, false);
  v.hovered = true;
  assert.equal(balloons.hovered, true);
  balloons.hideAll();
  assert.equal(balloons.anyVisible, false);
});

test('choosing: a \\q or \\__q item in any balloon while one is up; anchors never (Status choosing, EV §1.6) [disasm 0x639ad8, GetSelectModeAll 0x649540]', real, async () => {
  const { balloons } = await makeBalloons();
  const v0 = balloons.get(0);
  v0.write('menu');
  assert.equal(balloons.choosing, false);
  v0.addChoice('A', { id: 'a', refs: [] });
  assert.equal(v0.hasChoices, true);
  assert.equal(balloons.choosing, true);
  balloons.hideAll();
  assert.equal(balloons.choosing, false, 'no balloon is up (IsBalloonVisible)');
  balloons.get(1).write('other');
  assert.equal(balloons.choosing, true, 'the hidden \\0 still holds its item; \\1 is up');
  v0.clear();
  assert.equal(balloons.choosing, false, 'a clear drops the items');
  const { balloons: b2 } = await makeBalloons();
  const w0 = b2.get(0);
  w0.beginLink({ kind: 'anchor', id: 'x', refs: [] });
  w0.write('anchor only');
  w0.endLink();
  assert.equal(w0.hasLinks, true);
  assert.equal(b2.choosing, false, '\\_a sets 0x20000, not 0x10000');
  w0.beginLink({ kind: 'choice', id: 'y', refs: [] });
  w0.write('span');
  w0.endLink();
  assert.equal(b2.choosing, true, 'a \\__q range');
});

test('images load asynchronously: layout is redone when the size arrives; missing files are never fetched', real, async () => {
  const { skin } = await fixture();
  const files = new DiskFiles(TSUBASA);
  const slow = Object.create(files);
  let release;
  const gate = new Promise(r => { release = r; });
  slow.bytes = async p => { await gate; return files.bytes(p); };
  const b = new Balloons({ skin, ghostFiles: slow, root: null });
  b.images.decode = false;
  const v = b.get(0);
  v.image('menu\\choice3.png', 'inline', '', []);
  v.write('label');
  v.image('2048\\0.png', 'inline', 'opaque', []);
  v.image('unyu\\unyu0.png', '32', '24', []);
  assert.equal(v.engine.elements.filter(e => e.t === 'g')[0].x, 0, 'size unknown yet');
  release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(v.engine.elements.filter(e => e.t === 'g')[0].x, 150, 'relaid out with the real width');
  assert.deepEqual(files.fetched, ['ghost/master/menu/choice3.png']);
});

test('content snapshot round trip (BA §7)', real, async () => {
  const { balloons, run, skin, ghost } = await makeBalloons();
  await run('\\0\\b[2]\\_q\\_l[0,50]\\__q[a]\\_b["menu\\choice5.png",inline]\\__q\\_l[@0,@-16]　 Sure\\n\\f[color,red]red\\e');
  const st = JSON.parse(JSON.stringify(balloons.saveState({ content: true })));
  const b2 = new Balloons({ skin, ghostFiles: ghost, root: null, state: st });
  await b2.images.prefetch(['menu\\choice5.png']);
  const v = b2.get(0);
  v.engine.relayout();
  assert.equal(v.visible, true);
  assert.equal(v.kind, 2);
  const a = balloons.get(0).engine.elements.map(e => [e.t, e.x, e.y, e.w, e.h]);
  assert.deepEqual(v.engine.elements.map(e => [e.t, e.x, e.y, e.w, e.h]), a);
  assert.deepEqual(v.engine.elements.at(-1).font.color, [255, 0, 0]);
});

test('dialogs: input box results, timeout, silent close, several boxes, persistence', real, async () => {
  const { skin } = await fixture();
  const d = new Dialogs({ skin, root: null });
  const p1 = d.inputBox({ id: 'ユーザ名', defaultText: 'Neighbor' });
  const p2 = d.inputBox({ id: 'タイプ答え', timeoutMs: 30 });
  const p3 = d.inputBox({ id: '数当て答え' });
  assert.equal(d.anyOpen, true);
  assert.deepEqual(d.openKinds, ['input']);
  d.submit('ユーザ名');
  assert.deepEqual(await p1, { text: 'Neighbor', timedOut: false, reason: 'ok' });
  assert.deepEqual(await p2, { text: null, timedOut: true, reason: 'timeout' });
  const saved = d.saveState();
  assert.deepEqual(saved.map(s => [s.kind, s.id, s.remainingMs]), [['input', '数当て答え', null]]);
  d.close('数当て答え');
  assert.deepEqual(await p3, { text: null, timedOut: false, reason: 'closed' });
  const c = d.communicateBox({ defaultText: 'hi' });
  d.cancel('communicatebox');
  assert.equal(await c, null);
  const c2 = d.communicateBox({ detailed: true });
  d.submit('communicatebox', 'tea');
  assert.deepEqual(await c2, { text: 'tea', reason: 'ok' });
  const again = d.restoreState(saved);
  assert.equal(again.length, 1);
  d.submit('数当て答え', '42');
  assert.deepEqual(await again[0].promise, { text: '42', timedOut: false, reason: 'ok' });
  const a = d.inputBox({ id: 'x' });
  const b = d.inputBox({ id: 'x' });
  assert.equal((await a).reason, 'closed', 'reopening the same id replaces the box');
  d.inputBox({ id: 'y' });
  d.close('__SYSTEM_ALL_INPUT__');
  assert.equal((await b).reason, 'closed');
  assert.equal(d.anyOpen, false);
  const dt = d.inputBox({ id: 'd', kind: 'dateinput' });
  assert.equal(d.boxes[0].kind, 'date');
  d.submit('d', '2026,10,6');
  assert.equal((await dt).text, '2026,10,6');
});

test('dialogs: an empty id closes only the box opened without an id; no argument closes everything', async () => {
  const d = new Dialogs({ root: null });
  const settled = p => Promise.race([p, new Promise(r => setTimeout(() => r('open'), 20))]);
  const unnamed = d.inputBox({ id: '' });
  const named = d.inputBox({ id: '名前' });
  const comm = d.communicateBox({ detailed: true });
  d.close('');
  assert.deepEqual(await unnamed, { text: null, timedOut: false, reason: 'closed' });
  assert.equal(await settled(named), 'open', 'other input boxes stay open');
  assert.equal(await settled(comm), 'open', 'the communicate box stays open');
  assert.deepEqual(d.boxes.map(b => b.id), ['名前', 'communicatebox']);
  d.close('__SYSTEM_ALL_INPUT__');
  assert.equal((await named).reason, 'closed');
  assert.equal(await settled(comm), 'open', '__SYSTEM_ALL_INPUT__ is input boxes only');
  d.close();
  assert.deepEqual(await comm, { text: null, reason: 'closed' });
  assert.equal(d.anyOpen, false);
});

// Stage + CharacterView end to end, headless (no DOM): Tsubasa's real files through Stage.create, ImageCache with a
// Node PNG decoder, manual frames on a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Stage } from '../../src/shell/stage.js';
import { parseShell } from '../../src/shell/surfaces.js';
import { FsFiles, GHOST, ROOT, FakeClock, nodeDecode, referenceView, compareWithRender, seeded, sizedStage } from './helpers.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');
// the reference renders are made from her shell, so like the ghost they are not in the repository
const RENDERED = needs('site/ghost/tsubasa', 'tests/shell/fixtures/renders');
// the synthetic test ghost: shells master and alt (named Winter, with a small dress-up menu)
const TESTGHOST = path.join(ROOT, 'tests/fixtures/ghost/testghost');

async function make(opts = {}) {
  const clock = new FakeClock(0);
  const files = opts.files || new FsFiles(GHOST);
  const stage = await Stage.create({ files, dom: false, decode: nodeDecode, clock, random: () => 0.99, desk: { w: 1280, h: 720 }, ...opts });
  const events = [];
  for (const t of ['surface', 'bind', 'move', 'mouse']) stage.on(t, e => events.push([t, e]));
  const settle = async (ms = 0) => {
    for (let i = 0; i < 30; i++) {
      stage.tick(clock.now());
      await new Promise(r => setImmediate(r));
    }
    if (ms) { clock.advance(ms); stage.tick(clock.now()); }
  };
  await settle();
  return { stage, clock, files, events, settle };
}

const rec = (v, clock, x, y, extra = {}) => {
  const p = v.toSurface(x, y);
  return { x, y, sx: p.x, sy: p.y, hit: v.hitTestSurface(p.x, p.y), device: 'mouse', time: clock.now(), ...extra };
};

test('boot: default surfaces, first-boot layout, surface events, lazy image loading', real, async () => {
  const { stage, events, files } = await make();
  assert.deepEqual(stage.scopes, [0, 1]);
  const s0 = stage.char(0), s1 = stage.char(1);
  assert.equal(s0.surfaceId, 0);
  assert.equal(s1.surfaceId, 10);
  assert.ok(s0.visible && s1.visible);
  assert.deepEqual(events.filter(e => e[0] === 'surface').map(e => e[1]),
    [{ scope: 0, id: 0, width: 220, height: 380 }, { scope: 1, id: 10, width: 4, height: 4 }]);
  assert.deepEqual(s0.rect, { x: 1060, y: 340, width: 220, height: 380 });
  assert.deepEqual(s0.basePoint, { x: 1170, y: 720 });
  // \1 flush against \0's left edge, base points level, no room left for balloons (ssp.exe, UI §3.2)
  assert.deepEqual(s1.rect, { x: 1056, y: 716, width: 4, height: 4 });
  assert.equal(s0.alignment, 'bottom');
  // only what is needed was read: the shell texts and the images of the shown surfaces and worn parts
  const images = files.reads.filter(p => /\.(png|pna)$/i.test(p));
  assert.ok(images.length > 3 && images.length < 80, `read ${images.length} images`);
  assert.ok(!files.reads.some(p => /surface9500/.test(p)));
});

test('composition through the stage matches the reference render; hit testing; cursor rules', RENDERED, async () => {
  const { stage, settle } = await make();
  const v = stage.char(0);
  v.bind('下着', 'スポーツ下着黒', '1');
  await settle();
  const img = v.image;
  const b = v.renderer.base(0);
  const res = compareWithRender(referenceView(img, { x: b.ox, y: b.oy, w: b.width, h: b.height }), 's0_default.png', 2);
  assert.ok(res.sameSize && res.over === 0, JSON.stringify(res));
  const r = v.rect;
  assert.equal(v.hitTest(r.x + 100, r.y + 30), 'Head');
  assert.equal(v.hitTest(r.x + 1, r.y + 1), null);            // transparent corner: click-through
  // an opaque pixel outside every collision gives ''
  let empty = null;
  for (let y = 0; y < 380 && !empty; y += 3) for (let x = 0; x < 220 && !empty; x += 3) if (v.hitTestSurface(x, y) === '') empty = [x, y];
  assert.ok(empty, 'found an opaque pixel without a collision');
  assert.equal(v.hitTest(r.x + empty[0], r.y + empty[1]), '');
  assert.equal(stage.shell.cursorFor(0, 'mouseup', v.hitTest(r.x + 100, r.y + 30)), 'pointer');
});

test('binds: events in order, immediate animation effects, dressupInfo', real, async () => {
  const { stage, events, settle } = await make();
  const v = stage.char(0);
  const info0 = stage.dressupInfo();
  const lines = info0.split('\r\n');
  assert.equal(lines.length, 3885);
  assert.deepEqual(stage.dressupRefs(), lines);
  assert.equal(lines[0], '0\x01髪\x01ポニーテール\x01default\x011\x01');
  assert.ok(lines[230].startsWith('27\x01'));                     // scope-major order
  assert.ok(lines.at(-1).startsWith('100\x01P900\x01m4\x01'));
  // categories in SSP's order (first menu-listed part), not by id: 服 (5th) before 下着 (unlisted)
  const cats = [...new Set(lines.slice(0, 230).map(l => l.split('\x01')[1]))];
  assert.deepEqual(cats.slice(0, 8), ['髪', 'アクセサリ１', 'アクセサリ２', 'アクセサリ３', '服', 'エプロン', '足', '指輪']);
  const jacket = lines.findIndex(l => l.startsWith('0\x01服\x01夏服＋上着ピンク\x01'));
  assert.equal(lines[jacket], '0\x01服\x01夏服＋上着ピンク\x01default\x011\x01');
  events.length = 0;
  const changes = v.bind('服', '体操着ジャージ', '1');
  assert.deepEqual(events.filter(e => e[0] === 'bind').map(e => [e[1].scope, e[1].part, e[1].on]),
    [[0, '夏服＋上着ピンク', false], [0, '体操着ジャージ', true]]);
  assert.equal(changes.length, 2);
  assert.ok(!v.getBinds().includes(51));
  const info1 = stage.dressupInfo();
  assert.notEqual(info1, info0);
  assert.equal(stage.dressupInfo(), info1);                      // cached while nothing changes
  assert.ok(info1.split('\r\n')[jacket].endsWith('\x010\x01'));
  // binds of a scope without a view still work through the stage
  stage.char(100).bind('P1', 'm1', '1');
  assert.deepEqual(stage.char(100).getBinds(), [11001]);
  await settle();
});

test('\\![bind-noevent]: the bind events carry noEvent so no OnDressupChanged is sent', real, async () => {
  const { stage, events } = await make();
  const v = stage.char(0);
  events.length = 0;
  // the player calls c.bind(category, part, value, {noEvent: true})
  v.bind('服', '体操着ジャージ', '1', { noEvent: true });
  const quiet = events.filter(e => e[0] === 'bind').map(e => e[1]);
  assert.equal(quiet.length, 2);
  assert.ok(quiet.every(e => e.noEvent === true));
  events.length = 0;
  v.bind('服', '体操着ジャージ', '0');
  stage.setBind(0, 51, true);
  const loud = events.filter(e => e[0] === 'bind').map(e => e[1]);
  assert.ok(loud.length >= 2 && loud.every(e => e.noEvent === false));
  stage.setBind(0, 51, false, { noEvent: true });
  assert.equal(events.at(-1)[1].noEvent, true);
});

test('cursor files resolve against the shell folder, not the page', () => {
  const shell = parseShell({
    descript: '',
    surfaces: ['surface0\n{\ncollision0,0,0,10,10,Head\n}\nsakura.cursor\n{\nmouseup0,Head,cursor\\hand.cur\nmousedown0,Head,cursor\\gone.cur\n}\n'],
    files: ['surface0.png', 'Cursor/Hand.cur'],
  });
  const shellFiles = {
    has: p => p === 'Cursor/Hand.cur',
    resolve: p => (p.toLowerCase() === 'cursor/hand.cur' ? 'Cursor/Hand.cur' : null),
    url: p => 'http://127.0.0.1:8642/ghost/x/shell/master/' + p.split('/').map(encodeURIComponent).join('/'),
    bytes: () => Promise.reject(new Error('no images in this test')),
  };
  const stage = new Stage({ shell, shellFiles, dom: false, clock: new FakeClock(), desk: { w: 800, h: 600 } });
  const v = stage.char(0);
  assert.equal(v._cursorFor('mouseup', 'Head'), 'url("http://127.0.0.1:8642/ghost/x/shell/master/Cursor/Hand.cur"), auto');
  assert.equal(v._cursorFor('mousedown', 'Head'), 'default');       // missing file: system default
  assert.equal(v._cursorFor('mouseup', null), 'default');
  stage.destroy();
});

test('extra scopes: hidden until a surface is set, defaultleft, free alignment, moveTo, docking', real, async () => {
  const { stage, settle } = await make();
  const p = stage.char(99);
  assert.equal(p.visible, false);
  assert.equal(p.setSurface(9700), true);
  await settle();
  assert.ok(p.visible);
  assert.equal(p.alignment, 'free');
  assert.deepEqual(p.rect, { x: 300, y: 720 - 125, width: 204, height: 125 });
  p.moveTo(500, 400);
  assert.deepEqual(p.basePoint, { x: 500, y: 400 });
  // \0 is docked at the bottom: y is ignored until the alignment is set free
  const v = stage.char(0);
  v.moveTo(600, 100);
  assert.deepEqual(v.basePoint, { x: 600, y: 720 });
  v.setAlignment('free');
  v.moveTo(600, 100);
  assert.deepEqual(v.basePoint, { x: 600, y: 100 });
  v.moveRectTo(10, 20);
  assert.deepEqual([v.rect.x, v.rect.y], [10, 20]);
  v.setAlignment('default');
  assert.equal(v.rect.y, 340);
  // unknown surface: keep the current one; -1 hides
  assert.equal(p.setSurface(123456), false);
  assert.equal(p.surfaceId, 9700);
  assert.equal(p.setSurface(-1), true);
  assert.equal(p.visible, false);
  assert.equal(p.hitTest(510, 300), null);
});

test('default places as ssp.exe (UI §3.2): by scope index, flush against the nearest lower window where it stands now, its defaultleft first; Reset shell position', async () => {
  const descript = 'char3.defaultleft,300\r\nchar6.seriko.alignmenttodesktop,free\r\nchar6.defaulttop,100\r\n';
  const stage = await sizedStage({ sizes: { 0: [220, 380], 10: [255, 161], 20: [100, 50], 30: [80, 80] }, descript });
  const r = s => { const x = stage.char(s).rect; return [x.x, x.y, x.width, x.height]; };
  assert.deepEqual(r(0), [1060, 340, 220, 380], '\\0: bottom-right');
  assert.deepEqual(r(1), [805, 559, 255, 161], '\\1: flush against \\0, base points level, no balloon gap');
  stage.char(0).moveTo(400, 720);                         // \0 dragged away: \1 stays
  assert.deepEqual(r(1), [805, 559, 255, 161]);
  stage.char(2).setSurface(20);                           // a \p[n] shown for the first time: against \1 where it stands
  assert.deepEqual(r(2), [705, 670, 100, 50]);
  stage.char(5).setSurface(20);                           // no \p[3] or \p[4] window: against \p[2]
  assert.deepEqual(r(5), [605, 670, 100, 50]);
  stage.char(3).setSurface(20);                           // its defaultleft
  assert.deepEqual(r(3), [300, 670, 100, 50]);
  stage.char(3).moveTo(950, 720);
  stage.char(4).setSurface(30);                           // against \p[3]'s defaultleft, not where \p[3] stands now
  assert.deepEqual(r(4), [220, 640, 80, 80]);
  stage.char(6).setSurface(20);                           // free with a defaulttop
  assert.deepEqual(r(6), [505, 100, 100, 50]);
  // Reset shell position: lowest scope first, each against the new place of the one below it
  stage.resetPositions();
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(s => r(s)[0]), [1060, 805, 705, 300, 220, 120, 20]);
  assert.equal(r(6)[1], 100);
});

test('stored places win over the default (UI §3.3): \\1 is not laid out again against a moved \\0; a \\p[n] comes back where it stood after a cold boot', async () => {
  const { coldStageState, showDefaultCharacters } = await import('../../src/core/runtime.js');
  const sizes = { 0: [220, 380], 10: [255, 161], 20: [100, 50] };
  const a = await sizedStage({ sizes });
  a.char(2).setSurface(20);
  a.char(2).moveTo(150, 720);
  a.char(0).moveTo(600, 720);
  const saved = JSON.parse(JSON.stringify(a.saveState()));
  const b = await sizedStage({ sizes, state: coldStageState(saved) });
  showDefaultCharacters(b);                               // what a cold boot does next
  assert.deepEqual([b.char(0).rect.x, b.char(1).rect.x], [490, 805], 'each scope at its own stored place');
  assert.equal(b.has(2), false, 'no \\p[2] window before a script shows it');
  assert.deepEqual(b.saveState().scopes[2].pos, saved.scopes[2].pos, 'its place is kept meanwhile');
  b.char(2).setSurface(20);
  assert.deepEqual(b.char(2).rect, { x: 100, y: 670, width: 100, height: 50 }, 'where it stood, not against \\1');
  // Reset shell position forgets the places up to the highest scope that has a window (ssp.exe: Char0 … Char<n> of
  // the highest \p[n] window made); a \p[n] above it keeps its stored place and comes back there
  const c = await sizedStage({ sizes, state: coldStageState(saved) });
  showDefaultCharacters(c);
  c.resetPositions();
  assert.deepEqual([c.char(0).rect.x, c.char(1).rect.x], [1060, 805]);
  assert.deepEqual(c.saveState().scopes[2].pos, saved.scopes[2].pos, 'no \\p[2] window yet: its place survives');
  c.char(2).setSurface(20);
  assert.equal(c.char(2).rect.x, 100);
  // with a \p[3] window made, the reset forgets \p[2]'s place too
  const e = await sizedStage({ sizes, state: coldStageState(saved) });
  showDefaultCharacters(e);
  e.char(3);
  e.resetPositions();
  assert.equal(e.saveState().scopes[2], undefined);
  e.char(2).setSurface(20);
  assert.equal(e.char(2).rect.x, 805 - 100);
});

test('a character hidden by \\s[-1] still counts for the scopes above it (UI §3.2): Reset shell position moves it too, with the size it was last shown with', async () => {
  const sizes = { 0: [220, 380], 10: [255, 161], 20: [100, 50] };
  // \0 and \1 moved, then \0 hidden (Tsubasa's mask), then Reset shell position
  const a = await sizedStage({ sizes });
  a.char(0).moveTo(400, 720);
  a.char(1).moveTo(900, 720);
  a.char(0).setSurface(-1);
  a.resetPositions();
  assert.deepEqual(a.char(0).lastRect, { x: 1060, y: 340, width: 220, height: 380 }, 'hidden \\0 at its default place');
  assert.equal(a.char(1).rect.x, 805, '\\1 flush against it, not in the middle of the desk');
  assert.ok(Math.abs(a.saveState().scopes[0].pos.rx - 1170 / 1280) < 1e-9, 'the reset place is saved');
  a.char(0).setSurface(0);
  assert.deepEqual([a.char(0).rect.x, a.char(1).rect.x], [1060, 805], 'shown again: no gap');
  // \p[2] shown, \1 hidden, Reset: \p[2] against \1's new place, not against \0
  const b = await sizedStage({ sizes });
  b.char(2).setSurface(20);
  b.char(2).moveTo(300, 720);
  b.char(1).setSurface(-1);
  b.resetPositions();
  assert.equal(b.char(2).rect.x, 705);
  b.char(1).setSurface(10);
  assert.deepEqual([b.char(1).rect.x, b.char(2).rect.x], [805, 705], 'no overlap when \\1 comes back');
});

test('a character hidden by \\s[-1] keeps counting after a page change: the size it was last shown with is saved (`last`)', async () => {
  const sizes = { 0: [220, 380], 10: [255, 161], 20: [100, 50] };
  // the same page: a \p[2] shown for the first time stands against the hidden \1's last place
  const a = await sizedStage({ sizes });
  a.char(1).setSurface(-1);
  a.char(2).setSurface(20);
  assert.equal(a.char(2).rect.x, 705);
  // a page change: the next page resumes from the stored state, then shows the same \p[2] for the first time
  const b = await sizedStage({ sizes });
  b.char(1).setSurface(-1);
  const saved = JSON.parse(JSON.stringify(b.saveState()));
  assert.deepEqual(saved.scopes[1].last, { x: 0, y: 0, w: 255, h: 161, bx: 127.5, by: 161 });
  assert.equal(saved.scopes[0].last, undefined, 'only while hidden');
  const c = await sizedStage({ sizes, state: saved });
  assert.equal(c.char(1).visible, false);
  assert.deepEqual(c.char(1).lastRect, { x: 805, y: 559, width: 255, height: 161 }, '\\4 / \\5 know its size too');
  c.char(2).setSurface(20);
  assert.equal(c.char(2).rect.x, 705, 'the page change moved nothing');
  c.char(1).setSurface(10);
  assert.equal(c.char(1).rect.x, 805);
  // resumed with \0 hidden and \1 not placed yet: \1 against the hidden \0, not in the middle of the desk
  const d = await sizedStage({ sizes });
  d.char(0).setSurface(-1);
  const st = JSON.parse(JSON.stringify(d.saveState()));
  delete st.scopes[1].pos;
  const e = await sizedStage({ sizes, state: st });
  assert.equal(e.char(1).rect.x, 805);
});

test('a character hidden by \\s[-1] follows a viewport resize too: shown again, it stands where a shown one would', async () => {
  const sizes = { 0: [220, 380], 10: [255, 161] };
  const a = await sizedStage({ sizes, desk: { w: 1920, h: 1040 } });
  const b = await sizedStage({ sizes, desk: { w: 1920, h: 1040 } });
  assert.equal(a.char(0).rect.x, 1700);
  a.char(0).setSurface(-1);
  a.setDesk(800, 600);                                  // the window narrowed, a phone rotated
  b.setDesk(800, 600);
  assert.deepEqual(a.char(0).lastRect, b.char(0).rect);
  assert.equal(a.char(1).rect.x, b.char(1).rect.x);
  a.char(0).setSurface(0);
  const r = a.char(0).rect;
  assert.deepEqual(r, b.char(0).rect);
  assert.ok(r.x < 800 && r.x + r.width > 0 && r.y + r.height === 600, JSON.stringify(r));
  // hidden before it was ever sized: placed from its ratio once shown
  const c = await sizedStage({ sizes, desk: { w: 1920, h: 1040 }, state: { v: 1, shell: 'master', scopes: { 0: { surface: -1, pos: { rx: 1810 / 1920, ry: 1 } } } } });
  c.char(0).moveTo(1810, 1040);                         // a \![move] while hidden
  c.setDesk(800, 600);
  c.char(0).setSurface(0);
  assert.deepEqual(c.char(0).rect, b.char(0).rect);
});

test('animations through the view: talk hook, mirrored hit test, move offsets shift the rect', real, async () => {
  const { stage, clock, settle, events } = await make({ random: () => 0 });
  const v = stage.char(0);
  v.onTalk(1);
  assert.ok(v.isAnimating(200));
  await settle(70);
  assert.equal(v.animator.frame(200).surface, 1100);
  // mirror about the base point: a point right of the base point maps to the left
  v.setScaling(-100, 100);
  const bp = v.basePoint;
  assert.equal(v.hitTest(bp.x + 10, bp.y - 350), 'Head');       // surface x 100 -> client bp.x + 10
  assert.deepEqual(v.toSurface(bp.x + 10, bp.y - 350), { x: 100, y: 30 });
  v.setScaling(100, 100);
  // fireworks on an extra scope move the window ('move' patterns)
  const f = stage.char(2);
  f.setSurface(930);
  await settle();
  const r0 = f.rect;
  events.length = 0;
  clock.advance(1000);
  stage.tick(clock.now());
  assert.ok(f.isAnimating(1));
  assert.equal(f.rect.x, r0.x + 100);
  assert.ok(events.some(e => e[0] === 'move' && e[1].scope === 2));
});

test('mouse: click and drag through the view; drag moves only x when docked; ratios persist', real, async () => {
  const { stage, clock, events } = await make();
  const v = stage.char(0);
  const r = v.rect;
  const x = r.x + 100, y = r.y + 30;
  v.mouse.down({ ...rec(v, clock, x, y), button: 0 });
  v.mouse.up({ ...rec(v, clock, x, y), button: 0 });
  const mouse = events.filter(e => e[0] === 'mouse').map(e => e[1]);
  assert.deepEqual(mouse.map(m => m.type), ['enterall', 'enter', 'down', 'up', 'click']);
  assert.deepEqual([mouse[2].x, mouse[2].y, mouse[2].collision, mouse[2].scope], [100, 30, 'Head', 0]);
  events.length = 0;
  clock.advance(1000);
  v.mouse.down({ ...rec(v, clock, x, y), button: 0 });
  v.mouse.move({ ...rec(v, clock, x - 50, y - 50), buttons: 1 });
  v.mouse.move({ ...rec(v, clock, x - 50, y), buttons: 1 });
  v.mouse.up({ ...rec(v, clock, x - 50, y), button: 0 });
  assert.deepEqual(events.filter(e => e[0] === 'mouse').map(e => e[1].type), ['down', 'dragstart', 'dragend', 'up']);
  assert.deepEqual([v.rect.x, v.rect.y], [r.x - 50, r.y]);
  assert.ok(events.some(e => e[0] === 'move' && e[1].reason === 'dragend'));
  const st = stage.saveState();
  assert.ok(Math.abs(st.scopes[0].pos.rx - (1170 - 50) / 1280) < 1e-9);
});

test('state: save and restore surfaces, binds, positions, alignment, visibility', real, async () => {
  const a = await make();
  a.stage.char(0).bind('髪', 'ツインテール', '1');
  a.stage.char(0).setSurface(1);
  a.stage.char(99).setSurface(9700);
  await a.settle();
  a.stage.char(99).setAlignment('free');
  a.stage.char(99).moveTo(640, 360);
  a.stage.char(100).bind('P5', 'm2', '1');
  const st = JSON.parse(JSON.stringify(a.stage.saveState()));
  assert.equal(st.v, 1);
  assert.deepEqual(st.scopes[0].binds, [1, 30, 51]);
  assert.equal(st.scopes[0].surface, 1);
  assert.deepEqual(st.scopes[100].binds, [12005]);
  const b = await make({ state: st, desk: { w: 1280, h: 720 } });
  assert.deepEqual(b.stage.scopes, [0, 1, 99, 100]);
  assert.equal(b.stage.char(0).surfaceId, 1);
  assert.deepEqual(b.stage.char(0).getBinds(), [1, 30, 51]);
  assert.deepEqual(b.stage.char(99).basePoint, { x: 640, y: 360 });
  assert.deepEqual(b.stage.char(0).rect, a.stage.char(0).rect);
  assert.equal(b.stage.char(100).visible, false);
  assert.deepEqual(b.stage.char(100).getBinds(), [12005]);
  // resize: positions follow the ratios and stay on screen
  b.stage.setDesk(640, 480);
  assert.deepEqual(b.stage.char(99).basePoint, { x: 320, y: 240 });
  assert.equal(b.stage.char(0).rect.y + b.stage.char(0).rect.height, 480);
  // resetPositions back to the first-boot layout
  b.stage.resetPositions();
  assert.equal(b.stage.char(0).rect.x, 640 - 220);
  assert.equal(b.stage.char(99).rect.x, 300);
});

test('shell scaling (Stage.setScale): about the base point, docked, in the corner; hit tests, mouse coordinates and \\![set,scaling] follow', real, async () => {
  const { stage, clock, events } = await make();
  const v = stage.char(0);
  assert.deepEqual(v.rect, { x: 1060, y: 340, width: 220, height: 380 });
  assert.deepEqual(v.basePoint, { x: 1170, y: 720 });
  // surface (100, 30) is her head: 10 px left of and 350 px above the base point at scale 1
  assert.equal(v.hitTest(1170 - 10, 720 - 350), 'Head');
  events.length = 0;
  stage.setScale(1.5);
  assert.deepEqual(v.rect, { x: 1280 - 330, y: 720 - 570, width: 330, height: 570 }, 'docked at the bottom, still in the bottom-right corner');
  assert.deepEqual(v.basePoint, { x: 1280 - 165, y: 720 });
  assert.ok(events.some(e => e[0] === 'move' && e[1].scope === 0 && e[1].reason === 'scale'), 'balloons follow');
  const bp = v.basePoint;
  assert.equal(v.hitTest(bp.x - 15, bp.y - 525), 'Head');
  assert.deepEqual(v.toSurface(bp.x - 15, bp.y - 525), { x: 100, y: 30 });
  assert.notEqual(v.hitTest(bp.x - 10, bp.y - 350), 'Head', 'the unscaled place is somewhere else on her now');
  // mouse events report surface coordinates, whatever the scale
  v.mouse.down({ ...rec(v, clock, bp.x - 15, bp.y - 525), button: 0 });
  v.mouse.up({ ...rec(v, clock, bp.x - 15, bp.y - 525), button: 0 });
  const down = events.filter(e => e[0] === 'mouse' && e[1].type === 'down').map(e => e[1]);
  assert.deepEqual([down[0].x, down[0].y, down[0].collision], [100, 30, 'Head']);
  // \![set,scaling] multiplies on top: a mirror at 150 %
  v.setScaling(-100, 100);
  assert.equal(v.rect.width, 330);
  assert.equal(v.hitTest(bp.x + 15, bp.y - 525), 'Head');
  v.setScaling(50, 50);
  assert.deepEqual([v.rect.width, v.rect.height], [165, 285]);
  v.setScaling(100, 100);
  // the saved position is the base point's ratio; back to 100 %: back where she was
  assert.ok(Math.abs(stage.saveState().scopes[0].pos.rx - 1115 / 1280) < 1e-9);
  stage.setScale(1);
  assert.deepEqual(v.rect, { x: 1060, y: 340, width: 220, height: 380 });
  // a character in the middle of the desk keeps its base point; one pushed past the edge stays on the desk
  v.moveTo(640, 720);
  stage.setScale(2);
  assert.deepEqual(v.basePoint, { x: 640, y: 720 });
  assert.deepEqual([v.rect.width, v.rect.height, v.rect.y + v.rect.height], [440, 760, 720], 'taller than the desk: still docked');
  stage.setScale(1);
  v.moveTo(1250, 720);                                  // partly off the desk: only kept in view
  stage.setScale(2);
  assert.ok(v.rect.x < 1280 - 32 && v.rect.x + v.rect.width > 1280, 'a corner stays in view');
});

test('shell scaling from the start (Stage.create scale): the first-boot layout uses the scaled sizes', real, async () => {
  const { stage } = await make({ scale: 0.8 });
  const r = stage.char(0).rect;
  assert.deepEqual([r.x, r.y, r.width, r.height], [1280 - 176, 720 - 304, 176, 304]);
  assert.equal(stage.char(0).hitTest(1280 - 88 - 8, 720 - 280), 'Head');
});

test('stage without a shell folder or with bad data never throws', async () => {
  const files = new FsFiles(GHOST, ['ghost/master/descript.txt']);
  const stage = await Stage.create({ files, shellId: 'nosuch', dom: false, decode: nodeDecode, clock: new FakeClock(), desk: { w: 800, h: 600 } });
  assert.equal(stage.char(0).surfaceId, -1);
  assert.equal(stage.char(0).setSurface(5), false);
  assert.equal(stage.dressupInfo(), '');
  stage.tick(0);
  stage.destroy();
});

const fixtureOpts = () => ({ files: new FsFiles(TESTGHOST), dom: false, decode: nodeDecode, clock: new FakeClock(), desk: { w: 800, h: 600 } });

test('Stage.create reports the shell folder it actually loaded (B1)', async () => {
  const gone = await Stage.create({ ...fixtureOpts(), shellId: 'gone' });
  assert.equal(gone.shellId, 'master');
  assert.equal(gone.shell.descript.get('name'), 'master');
  assert.equal(gone.saveState().shell, 'master');
  const alt = await Stage.create({ ...fixtureOpts(), shellId: 'ALT' });
  assert.equal(alt.shellId, 'alt', 'the folder\'s real name');
  assert.equal(alt.shell.descript.get('name'), 'Winter');
  // no master folder: the first shell/<dir>/descript.txt
  const o = fixtureOpts();
  const noMaster = new FsFiles(TESTGHOST, o.files.paths.filter(p => !/^shell\/master\//i.test(p)));
  const first = await Stage.create({ ...o, files: noMaster, shellId: 'gone' });
  assert.equal(first.shellId, 'alt');
  for (const s of [gone, alt, first]) s.destroy();
});

test('binds saved for another shell are ignored (B2); its positions still apply', async () => {
  const pos = { rx: 0.25, ry: 1 };
  const other = await Stage.create({ ...fixtureOpts(), shellId: 'alt', state: { v: 1, shell: 'master', scopes: { 0: { binds: [0], pos } } } });
  assert.deepEqual(other.char(0).getBinds(), [1], 'alt keeps its own default part (Red)');
  assert.deepEqual(other.saveState().scopes[0].pos, pos);
  const same = await Stage.create({ ...fixtureOpts(), shellId: 'alt', state: { v: 1, shell: 'alt', scopes: { 0: { binds: [0] } } } });
  assert.deepEqual(same.char(0).getBinds(), [0]);
  const unnamed = await Stage.create({ ...fixtureOpts(), shellId: 'alt', state: { v: 1, scopes: { 0: { binds: [0] } } } });
  assert.deepEqual(unnamed.char(0).getBinds(), [0], 'a state without a shell id still restores');
  for (const s of [other, same, unnamed]) s.destroy();
});

test('Winter (alt) shell: dressupMenu, setBind origin, mustselect through the stage, OnNotifyDressupInfo order', async () => {
  const stage = await Stage.create({ ...fixtureOpts(), shellId: 'alt' });
  const binds = [];
  stage.on('bind', e => binds.push(e));
  const part = (id, category, p, on) => ({ type: 'part', id, category, part: p, on });
  // menuitem2, 0, 1, 4 in that file order: Hat - Straw, Scarf - Red (default), ----, Scarf - Blue
  assert.deepEqual(stage.dressupMenu(0), { mode: 'manual', enabled: true, entries: [
    part(2, 'Hat', 'Straw', false), part(1, 'Scarf', 'Red', true), { type: 'sep' }, part(0, 'Scarf', 'Blue', false)] });
  assert.deepEqual(stage.dressupMenu(1), { mode: 'manual', enabled: false, entries: [] });
  assert.deepEqual(stage.dressupRefs(), [
    '0\x01Hat\x01Straw\x01\x010\x01',
    '0\x01Scarf\x01Blue\x01mustselect\x010\x01',
    '0\x01Scarf\x01Red\x01default,mustselect\x011\x01',
  ]);
  assert.deepEqual(stage.setBind(0, 2, true, { origin: 'user' }).map(c => c.id), [2]);
  assert.deepEqual(binds, [{ scope: 0, id: 2, category: 'Hat', part: 'Straw', on: true, noEvent: false, origin: 'user' }]);
  binds.length = 0;
  stage.setBind(0, 2, false);
  assert.equal(binds.length, 1);
  assert.ok(!('origin' in binds[0]), 'no origin unless the caller gives one');
  // mustselect: toggling Red (the only part) off brings it straight back: no change, no event
  binds.length = 0;
  assert.deepEqual(stage.setBind(0, 1, undefined, { origin: 'user' }), []);
  assert.equal(binds.length, 0);
  stage.setBind(0, 0, true, { origin: 'user' });
  binds.length = 0;
  stage.setBind(0, 0, undefined, { origin: 'user' });
  assert.deepEqual(binds.map(e => [e.id, e.on, e.origin]), [[0, false, 'user'], [1, true, 'user']]);
  assert.equal(stage.dressupMenu(0).entries[1].on, true);
  stage.destroy();
});

test('\\![bind] by name on a category/part two groups share: only the menu-listed one goes on (DSLGS マフラー/黄色)', () => {
  const shell = parseShell({
    descript: ['sakura.bindgroup205.name,Scarf,Yellow,', 'sakura.bindgroup207.name,Scarf,Yellow,', 'sakura.menuitem0,207'].join('\n'),
    surfaces: [],
  });
  const stage = new Stage({ shell, shellFiles: null, dom: false, clock: new FakeClock(), desk: { w: 800, h: 600 } });
  const binds = [];
  stage.on('bind', e => binds.push(e));
  stage.char(0).bind('Scarf', 'Yellow', '1');
  assert.deepEqual(binds.map(e => [e.id, e.on]), [[207, true]]);
  assert.deepEqual(stage.char(0).getBinds(), [207]);
  assert.deepEqual(stage.dressupMenu(0).entries, [{ type: 'part', id: 207, category: 'Scarf', part: 'Yellow', on: true }]);
  stage.destroy();
});

test('carrying: true while a carry is open, false after its drop or cancel', async () => {
  const { stage } = await make({ files: new FsFiles(TESTGHOST), desk: { w: 800, h: 600 } });
  assert.equal(stage.carrying, false);
  const c = stage.carry(0);
  assert.equal(stage.carrying, true);
  c.drop();
  assert.equal(stage.carrying, false);
  stage.carry(0);
  assert.equal(stage.carrying, true);
  stage.carry(0).cancel();                        // a new carry cancels the open one, then itself
  assert.equal(stage.carrying, false);
  assert.equal(stage.carry(5).done instanceof Promise, true);
  assert.equal(stage.carrying, false, 'an inert handle (nothing shown at scope 5) carries nothing');
  stage.destroy();
});

test('Stage.dressupMenu: auto mode by category, hidden mode, only menuitem0,-, no menuitem at all', () => {
  const shell = parseShell({
    descript: [
      'sakura.menu,auto',
      'sakura.bindgroup3.name,Hair,Long,', 'sakura.bindgroup3.default,1', 'sakura.bindgroup1.name,Hair,Short,',
      'sakura.bindgroup2.name,Hat,Straw,', 'sakura.bindgroup0.name,Tail,Cat,',
      'kero.menu,hidden', 'kero.bindgroup0.name,Hat,Cap,', 'kero.menuitem0,0',
      'char2.bindgroup0.name,Panel,Close,', 'char2.menuitem0,-',
      'char4.bindgroup0.name,Ring,Gold,',
    ].join('\n'),
    surfaces: [],
  });
  const stage = new Stage({ shell, shellFiles: null, dom: false, clock: new FakeClock(), desk: { w: 800, h: 600 } });
  assert.deepEqual(stage.dressupMenu(0), { mode: 'auto', enabled: true, entries: [
    { type: 'category', category: 'Hair', on: true, parts: [{ id: 3, part: 'Long', on: true }, { id: 1, part: 'Short', on: false }] },
    { type: 'category', category: 'Hat', on: false, parts: [{ id: 2, part: 'Straw', on: false }] },
    { type: 'category', category: 'Tail', on: false, parts: [{ id: 0, part: 'Cat', on: false }] },
  ] });
  assert.deepEqual(stage.dressupMenu(1), { mode: 'hidden', enabled: false, entries: [] });
  assert.deepEqual(stage.dressupMenu(2), { mode: 'manual', enabled: true, entries: [{ type: 'sep' }] });
  assert.deepEqual(stage.dressupMenu(3), { mode: 'manual', enabled: false, entries: [] });
  assert.deepEqual(stage.dressupMenu(4), { mode: 'manual', enabled: false, entries: [] });
  stage.destroy();
});

test('carry ("Move character window"): the centre follows, a drop is saved like a drag, cancel puts it back', async () => {
  const { stage, events } = await make({ files: new FsFiles(TESTGHOST), desk: { w: 800, h: 600 } });
  const v = stage.char(0);
  assert.ok(v.visible);
  const centre = () => { const r = v.rect; return [r.x + r.width / 2, r.y + r.height / 2]; };
  // docked at the bottom: only x follows, as in a drag
  let c = stage.carry(0);
  c.move(300, 100);
  assert.equal(centre()[0], 300);
  assert.equal(v.rect.y + v.rect.height, 600);
  c.cancel();
  v.setAlignment('free');
  const bp0 = v.basePoint, pos0 = stage.saveState().scopes[0].pos;
  events.length = 0;
  c = stage.carry(0);
  c.move(400, 300);
  assert.deepEqual(centre(), [400, 300]);
  assert.ok(events.some(e => e[0] === 'move' && e[1].scope === 0 && e[1].reason === 'drag'));
  c.move(200, 250);
  c.drop();
  assert.equal(await c.done, true);
  assert.deepEqual(centre(), [200, 250]);
  assert.ok(events.some(e => e[0] === 'move' && e[1].reason === 'dragend'));
  const bp = v.basePoint, pos = stage.saveState().scopes[0].pos;
  assert.deepEqual(pos, { rx: bp.x / 800, ry: bp.y / 600 });
  assert.notDeepEqual(bp, bp0);
  c.move(10, 10);                                               // after the drop: nothing
  assert.deepEqual(v.basePoint, bp);
  // cancel: back where it was, the saved position too
  const d = stage.carry(0);
  d.move(100, 100);
  assert.notDeepEqual(v.basePoint, bp);
  d.cancel();
  assert.equal(await d.done, false);
  assert.deepEqual(v.basePoint, bp);
  assert.deepEqual(stage.saveState().scopes[0].pos, pos);
  // a new carry cancels the open one; a character that is not shown cannot be carried
  const e1 = stage.carry(0);
  e1.move(50, 50);
  const e2 = stage.carry(0);
  assert.equal(await e1.done, false);
  assert.deepEqual(v.basePoint, bp);
  e2.cancel();
  assert.equal(await stage.carry(5).done, false);
  assert.ok(pos0);
  stage.destroy();
});

test('DOM: the characters mount in the given root (the ghost\'s layer, UI §9.1), else in the shadow root; Stage.create passes it on', async () => {
  const { FakeEl } = await import('../balloon/fake_dom.mjs');
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    body: new FakeEl('body'), documentElement: Object.assign(new FakeEl('html'), { clientWidth: 800, clientHeight: 600 }), hidden: false,
    createElement: tag => new FakeEl(tag), addEventListener() {}, removeEventListener() {},
  };
  globalThis.window = { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} };
  const stages = [];
  try {
    const { getRoot } = await import('../../src/ui/root.js');
    const clock = { now: () => 0, setTimeout: () => 0, clearTimeout() {} };      // no requestFrame: nothing is painted
    const shell = parseShell({ descript: '', surfaces: [] });
    const chars = el => el.children.filter(c => c.className === 'smk-char').map(c => c.dataset.scope);
    const layer = new FakeEl('div');
    const inLayer = new Stage({ shell, shellFiles: null, dom: true, root: layer, clock });
    stages.push(inLayer);
    assert.equal(inLayer.root, layer);
    assert.deepEqual(chars(layer), ['0', '1']);
    inLayer.char(5);                                      // a \p[5] window made later joins it too
    assert.deepEqual(chars(layer), ['0', '1', '5']);
    assert.deepEqual(chars(getRoot()), [], 'nothing at root level');
    // without a root: the shadow root
    const plain = new Stage({ shell, shellFiles: null, dom: true, clock });
    stages.push(plain);
    assert.equal(plain.root, null);
    assert.deepEqual(chars(getRoot()), ['0', '1']);
    // Stage.create hands the option to the constructor (a ghost without any shell folder)
    const layer2 = new FakeEl('div');
    const created = await Stage.create({ files: { list: () => [] }, dom: true, root: layer2, clock });
    stages.push(created);
    assert.deepEqual(chars(layer2), ['0', '1']);
  } finally {
    for (const s of stages) s.destroy();
    for (const k of ['document', 'window']) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; }
  }
});

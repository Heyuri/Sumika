// Collision tooltips (UI §4.8, SH §2.16): the tracker's rest rule (a named collision only, `fresh` once per collision
// change, case-insensitive, reset by a rest off any collision and by leaving), the shell's own <scope>.tooltips, and a
// character view on Tsubasa's real shell asking stage.tipSource and showing the box while the pointer still rests
// (where it first appeared, its auto-pop restarted by moves; not after a surface change since the rest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MouseTracker } from '../../src/shell/mouse.js';
import { parseShell } from '../../src/shell/surfaces.js';
import { Stage } from '../../src/shell/stage.js';
import { TipBox, TIP_AUTOPOP_MS } from '../../src/ui/tooltip.js';
import { FsFiles, GHOST, FakeClock, nodeDecode } from './helpers.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');
const tick = () => new Promise(r => setImmediate(r));

test('rest: hover only on a named collision, fresh once per collision change (any case), forgotten off a collision or on leaving', () => {
  const clock = new FakeClock(1000);
  const out = [];
  const m = new MouseTracker({ scope: 0, clock, emit: i => out.push(i) });
  const at = (x, hit) => ({ x, y: 50, sx: x - 10, sy: 40, hit, device: 'mouse', time: clock.now() });
  const hovers = () => out.filter(i => i.type === 'hover').map(i => [i.collision, i.fresh]);
  m.move(at(20, 'Head'));
  clock.advance(499);
  assert.deepEqual(hovers(), []);
  clock.advance(1);
  assert.deepEqual(hovers(), [['Head', true]]);
  const h = out.at(-1);
  assert.deepEqual([h.clientX, h.clientY, h.x, h.y, h.rest === m.rest], [20, 50, 10, 40, true]);
  m.move(at(21, 'Head')); clock.advance(500);
  m.move(at(22, 'Face')); clock.advance(500);
  m.move(at(23, 'face')); clock.advance(500);               // another name only by case: the same collision
  m.move(at(24, 'Head')); clock.advance(100);
  m.move(at(25, 'Face')); clock.advance(500);               // passed over Head without resting
  assert.deepEqual(hovers(), [['Head', true], ['Head', false], ['Face', true], ['face', false], ['Face', false]]);
  m.move(at(26, '')); clock.advance(500);                   // a rest on the body, no collision: nothing, forgotten
  m.move(at(27, 'Face')); clock.advance(500);
  m.move(at(28, null));                                     // left the character
  m.move(at(29, 'Face')); clock.advance(500);
  assert.deepEqual(hovers().slice(5), [['Face', true], ['Face', true]]);
  const r = m.rest;
  m.move(at(30, 'Face'));
  assert.notEqual(m.rest, r, 'every move makes the last rest stale');
  m.leave(at(31, null));
  const t = new MouseTracker({ scope: 0, clock, emit: i => out.push(i) });
  t.move({ ...at(32, 'Face'), device: 'touch' });
  clock.advance(1000);
  assert.equal(hovers().length, 7, 'touch never rests');
});

test('<scope>.tooltips: any brace name starting with tooltip, collision names without case, a later line wins, an empty text deletes', () => {
  const shell = parseShell({
    descript: '',
    surfaces: [{ name: 'surfaces.txt', text: [
      'sakura.tooltips', '{', 'Head,Head pat\\nnext line', 'Bust,first', 'bust,second', 'Face,first', 'face,', 'Nose,',
      ',nameless', '}',
      'kero.Tooltip', '{', 'Hand,Kero\'s hand', '}',
      'char2.tooltipsX', '{', 'Tail,the tail', '}',
      'char3.tooltip_s', '{', 'Ear,an ear', '}',
    ].join('\r\n') }],
  });
  assert.equal(shell.tooltip(0, 'head'), 'Head pat\\nnext line', 'as written (tipText converts \\n)');
  assert.equal(shell.tooltip(0, 'BUST'), 'second');
  assert.equal(shell.tooltip(0, 'Face'), null, 'an empty text removes the entry defined before it (any case)');
  assert.equal(shell.tooltip(0, 'Nose'), null, 'one for a name never defined removes nothing else');
  assert.equal(shell.tooltip(0, 'Head'), 'Head pat\\nnext line');
  assert.equal(shell.tooltip(0, ''), null);
  assert.equal(shell.tooltip(1, 'hand'), 'Kero\'s hand');
  assert.equal(shell.tooltip(2, 'Tail'), 'the tail');
  assert.equal(shell.tooltip(3, 'Ear'), 'an ear');
  assert.equal(shell.tooltip(1, 'Head'), null);
});

async function stageWithTips() {
  const clock = new FakeClock(0);
  const tips = new TipBox({ root: null, clock });
  const stage = await Stage.create({ files: new FsFiles(GHOST), dom: false, decode: nodeDecode, clock, desk: { w: 1280, h: 720 }, tips });
  const asked = [];
  let reply = req => `tip of ${req.collision}`;
  stage.tipSource = req => { asked.push(req); return reply(req); };
  const mouse = [];
  stage.on('mouse', i => mouse.push(i.type));
  const v = stage.char(0);
  const move = (x, hit) => v.mouse.move({ x, y: 300, sx: x - 1000, sy: 100, hit, device: 'mouse', time: clock.now() });
  return { clock, tips, stage, v, asked, mouse, move, setReply: f => { reply = f; } };
}

test('a character asks stage.tipSource at a fresh rest, shows the box at the pointer, uses its cache, hides on changes', real, async () => {
  const { clock, tips, stage, v, asked, mouse, move, setReply } = await stageWithTips();
  move(1050, 'Head');
  clock.advance(500);
  await tick();
  assert.deepEqual(asked, [{ scope: 0, collision: 'Head', x: 50, y: 100, fresh: true, device: 'mouse' }]);
  assert.equal(tips.owner, v);
  assert.equal(tips.text, 'tip of Head');
  assert.deepEqual(tips.at, { x: 1050, y: 300 });
  assert.equal(tips.look, 'system');
  assert.ok(!mouse.includes('hover'), 'the rest is not a MouseInfo of its own');
  move(1052, 'Head');
  assert.equal(tips.owner, v, 'moving inside the collision keeps it');
  move(1060, 'Face');
  assert.equal(tips.owner, null, 'a collision change takes it away');
  clock.advance(500); await tick();
  move(1052, 'head'); clock.advance(500); await tick();
  assert.deepEqual(asked.map(r => [r.collision, r.fresh]), [['Head', true], ['Face', true], ['head', true]],
    'Head again after Face: asked again (SSP remembers one collision)');
  move(1053, 'Head'); clock.advance(500); await tick();
  assert.equal(asked.length, 3, 'the same collision (any case): the cached text');
  assert.equal(tips.text, 'tip of head');
  // a late reply after a move is not shown; the next rest shows it from the cache
  let release;
  setReply(() => new Promise(r => { release = r; }));
  move(1060, 'Face'); clock.advance(500);
  move(1061, 'Face');
  release('late Face');
  await tick();
  assert.equal(tips.owner, null);
  clock.advance(500); await tick();
  assert.equal(tips.text, 'late Face');
  // a press and a surface change take it away; undefined (not asked) shows nothing and asks again
  v.mouse.down({ x: 1061, y: 300, sx: 61, sy: 100, hit: 'Face', button: 0, device: 'mouse', time: clock.now() });
  assert.equal(tips.owner, null);
  v.mouse.up({ x: 1061, y: 300, sx: 61, sy: 100, hit: 'Face', button: 0, device: 'mouse', time: clock.now() });
  move(1062, 'Face'); clock.advance(500); await tick();
  assert.equal(tips.owner, v);
  v.setSurface(1);
  assert.equal(tips.owner, null, 'a surface change pops it');
  setReply(() => undefined);
  move(1070, 'Bust'); clock.advance(500); await tick();
  move(1071, 'Bust'); clock.advance(500); await tick();
  assert.equal(asked.filter(r => r.collision === 'Bust').length, 2);
  assert.equal(tips.owner, null);
  stage.tipSource = null;
  move(1080, 'Hand'); clock.advance(500); await tick();
  assert.equal(asked.filter(r => r.collision === 'Hand').length, 0, 'no source (a frozen tab): nothing');
  setReply(r => 'x ' + r.collision);
  stage.tipSource = req => { asked.push(req); return 'x ' + req.collision; };
  move(1081, 'Head'); clock.advance(500); await tick();
  assert.equal(tips.owner, v);
  stage.setVeiled(true);
  assert.equal(tips.owner, null, 'veiled');
  stage.setVeiled(false);
  move(1082, 'Head'); clock.advance(500); await tick();
  assert.equal(tips.owner, v);
  stage.destroy();
  assert.equal(tips.owner, null, 'torn down');
});

test('a shown tip stays put, moves restart its auto-pop; unanswered rests ask fresh; late after a surface change: hidden', real, async () => {
  const { clock, tips, stage, v, asked, move, setReply } = await stageWithTips();
  move(1050, 'Head'); clock.advance(500); await tick();
  assert.deepEqual([tips.owner, tips.at], [v, { x: 1050, y: 300 }]);
  const pos = tips.pos;
  move(1150, 'Head'); clock.advance(500); await tick();      // a rest elsewhere on the same collision
  assert.deepEqual([tips.owner, tips.at, tips.pos], [v, { x: 1050, y: 300 }, pos], 'where it first appeared [win32]');
  assert.equal(asked.length, 1);
  clock.advance(TIP_AUTOPOP_MS - 1000);
  move(1151, 'Head');                                        // restarts the auto-pop
  clock.advance(TIP_AUTOPOP_MS - 1);
  assert.equal(tips.owner, v, 'still up 20 s after it showed: the move restarted it');
  clock.advance(1);
  assert.equal(tips.owner, null, 'auto-pop 20 s after the last move');
  // an undefined answer (the loop not live yet) or no source at all: the next rest asks again, fresh (OnMouseHover)
  setReply(() => undefined);
  move(1060, 'Face'); clock.advance(500); await tick();
  move(1061, 'Face'); clock.advance(500); await tick();
  stage.tipSource = null;                                    // a frozen tab
  move(1070, 'Hand'); clock.advance(500); await tick();
  const source = req => { asked.push(req); return `tip of ${req.collision}`; };
  stage.tipSource = source;                                  // it took the set over
  move(1071, 'Hand'); clock.advance(500); await tick();
  assert.deepEqual(asked.slice(1).map(r => [r.collision, r.fresh]), [['Face', true], ['Face', true], ['Hand', true]]);
  assert.equal(tips.text, 'tip of Hand');
  // the surface changes while the text is on its way: not shown at the old spot; cached for the next rest
  let release;
  stage.tipSource = req => { asked.push(req); return new Promise(r => { release = r; }); };
  move(1080, 'Bust'); clock.advance(500); await tick();
  assert.equal(v.setSurface(v.surfaceId === 1 ? 0 : 1), true);
  release('tip of Bust');
  await tick();
  assert.equal(tips.owner, null, 'a surface change pops the tip, also one still being asked for');
  stage.tipSource = source;
  move(1081, 'Bust'); clock.advance(500); await tick();
  assert.deepEqual([tips.owner, tips.text], [v, 'tip of Bust']);
  assert.equal(asked.filter(r => r.collision === 'Bust').length, 1, 'from the cache');
  stage.destroy();
});

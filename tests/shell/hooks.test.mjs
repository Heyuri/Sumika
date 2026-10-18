// The SakuraScript player driving a real Stage: the hook names the two modules agree on (CONTRACTS "Shell",
// character.js header) — talk animations, \![anim,...], \![bind-noevent], \![move] right after \s. The player is
// imported statically: an import error in src/sakura/ fails this file, it doesn't skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../../src/core/emitter.js';
import { Stage } from '../../src/shell/stage.js';
import { CharacterView } from '../../src/shell/character.js';
import { ScriptPlayer } from '../../src/sakura/player.js';
import { ManualClock } from '../../src/sakura/clock.js';
import { FsFiles, GHOST, FakeClock, nodeDecode, delayedDecode } from './helpers.mjs';
import { needs } from '../needs.mjs';

const opts = needs('site/ghost/tsubasa');

/** balloons that accept every call (a Proxy of no-ops; never thenable) */
class NullBalloons extends Emitter {
  get(scope) {
    return new Proxy({ scope }, {
      get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : k === 'hasLinks' || k === 'visible' ? false : () => {}),
    });
  }
  hideAll() {}
  get hovered() { return false; }
}

async function make(decode = nodeDecode) {
  const clock = new FakeClock(0);
  const stage = await Stage.create({ files: new FsFiles(GHOST), dom: false, decode, clock, random: () => 0.99, desk: { w: 1280, h: 720 } });
  const pclock = new ManualClock(0);
  const player = new ScriptPlayer({ stage, balloons: new NullBalloons(), clock: pclock, viewport: () => ({ width: 1280, height: 720 }) });
  const settle = async () => {
    for (let i = 0, calm = 0; i < 400 && calm < 3; i++) {
      stage.tick(clock.now());
      await new Promise(r => setTimeout(r, 2));
      calm = stage.images.pending.size === 0 && stage.images.queue.length === 0 ? calm + 1 : 0;
    }
  };
  await settle();
  return { stage, clock, player, pclock, settle };
}

test('hook aliases exist on CharacterView', () => {
  for (const m of ['onTalk', 'talk', 'anim', 'pauseAnimation', 'resumeAnimation', 'offsetAnimation', 'talkState',
    'onScriptEnd', 'waitAnimation', 'geometryReady']) assert.equal(typeof CharacterView.prototype[m], 'function', m);
});

test('player: text starts the talk animation (mouth flap, anim 200 on surface 0)', opts, async () => {
  const { stage, player, pclock } = await make();
  const v = stage.char(0);
  assert.equal(v.isAnimating(200), false);
  player.play('\\0\\s[0]Hello\\e');
  await pclock.runAll();
  assert.equal(v.isAnimating(200), true);
});

test('player: \\![anim,pause|resume|offset] and \\![bind-noevent] reach the view', opts, async () => {
  const { stage, player, pclock } = await make();
  const v = stage.char(0);
  const calls = [];
  for (const m of ['anim', 'pauseAnimation', 'resumeAnimation', 'offsetAnimation']) {
    const f = v[m];
    v[m] = function (...a) { calls.push([m, ...a]); return f.apply(this, a); };
  }
  const binds = [];
  stage.on('bind', e => binds.push(e));
  player.play('\\0\\s[0]\\![anim,start,200]\\![anim,pause,200]\\![anim,offset,200,3,4]\\![anim,resume,200]'
    + '\\![bind-noevent,服,体操着ジャージ,1]\\e');
  await pclock.runAll();
  // either spelling is fine: anim(id, 'pause') or pauseAnimation(id)
  const seen = calls.map(c => (c[0] === 'anim' ? c[2] : c[0].replace('Animation', '')));
  for (const c of ['pause', 'resume', 'offset']) assert.ok(seen.includes(c), `${c}: ${JSON.stringify(calls)}`);
  assert.deepEqual(v.animator.offset(200), { x: 3, y: 4 });
  assert.ok(binds.length >= 1 && binds.every(e => e.noEvent === true), JSON.stringify(binds));
});

test('player: \\4 / \\5 on a character hidden by \\s[-1] move it with the size it was last shown with (UI §3.8)', opts, async () => {
  const { stage, player, pclock, settle } = await make();
  const s0 = stage.char(0), s1 = stage.char(1);
  const shown = { x: 1060, y: 340, width: 220, height: 380 };
  assert.deepEqual(s0.rect, shown);
  assert.deepEqual(s1.rect, { x: 1056, y: 716, width: 4, height: 4 });       // flush against \0 (UI §3.2)
  assert.deepEqual(s0.lastRect, shown, 'shown: lastRect is rect');
  s0.setSurface(-1);
  assert.deepEqual([s0.rect.width, s0.rect.height], [0, 0], 'hidden: rect is the base point');
  assert.deepEqual(s0.lastRect, shown, 'lastRect keeps the size');
  s0.moveTo(s0.basePoint.x - 100, s0.basePoint.y);
  assert.deepEqual(s0.lastRect, { ...shown, x: 960 }, 'and follows a move');
  s0.moveTo(s0.basePoint.x + 100, s0.basePoint.y);
  // \4 against the right edge while hidden: she comes back where she was, not 64 px off the viewport
  player.play('\\0\\s[-1]\\4\\4\\s[0]\\e');
  await pclock.runAll();
  await settle();
  assert.deepEqual(s0.rect, shown);
  // \5 while hidden: she comes back touching \1 (moved to 806..810), not overlapping it by half her width
  s1.moveTo(808, s1.basePoint.y);
  player.play('\\0\\s[-1]\\5\\5\\s[0]\\e');
  await pclock.runAll();
  await settle();
  assert.deepEqual(s0.rect, { ...shown, x: 810 });
  assert.deepEqual(s1.rect, { x: 806, y: 716, width: 4, height: 4 });
});

test('player: \\p[10]\\s[951] then \\![move,...,right.top,right.top] in one go lands at the top-right corner', opts, async () => {
  const { stage, player, pclock, settle } = await make(delayedDecode(() => 15));
  player.play('\\p[10]\\s[951]\\![set,alignmentondesktop,free]\\![move,0,0,1,screen,right.top,right.top]\\e');
  await pclock.runAll();
  await settle();
  assert.deepEqual(stage.char(10).rect, { x: 650, y: 0, width: 630, height: 350 });
});

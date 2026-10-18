// The balloon module driven by the REAL SakuraScript player (src/sakura/player.js) instead of the tests' mini player
// (script.mjs), to catch contract drift at the seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBalloons } from './setup.mjs';
import { ScriptPlayer } from '../../src/sakura/player.js';
import { ManualClock } from '../../src/sakura/clock.js';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

async function realPlayer() {
  const { balloons } = await makeBalloons();
  const clock = new ManualClock();
  const ch = { setSurface() { return true; }, bind() {}, rect: { x: 900, y: 300, width: 200, height: 400 }, balloonOffset: { x: 2, y: 14 } };
  const stage = { char: () => ch, get scopes() { return [0, 1]; } };
  const host = new Proxy({}, { get: (t, k) => (k === 'raise' ? async () => null : k === 'envVar' ? () => null : () => {}) });
  const player = new ScriptPlayer({ stage, balloons, host, clock, speedMs: 0 });
  const play = async s => { const done = player.play(s, { event: 'OnTest' }); await clock.runAll(); return done; };
  return { balloons, play };
}

test('real player: a fresh script resets \\_n and \\f', real, async () => {
  const { balloons, play } = await realPlayer();
  await play('\\0\\_n\\f[bold,1]' + 'x'.repeat(80) + '\\e');
  const e = balloons.get(0).engine;
  assert.equal(e.noWrap, true);
  await play('\\0' + 'y'.repeat(80) + '\\e');
  assert.equal(e.noWrap, false);
  assert.equal(e.font.bold, false);
});

// SS §4 lifetime table: \f attributes and \_n end with the script; \C keeps only the content (BA §3.11, SUM §2.2).
// Balloons.beginScript(append) does this reset; the player does it itself for \C scripts too.
test('real player: a \\C script keeps the content but not \\_n / \\f of the previous script', real, async () => {
  const { balloons, play } = await realPlayer();
  await play('\\0\\_n\\f[bold,1]' + 'x'.repeat(80) + '\\e');
  const v = balloons.get(0), e = v.engine;
  const before = e.elements.length;
  await play('\\C\\0\\n' + 'y'.repeat(80) + '\\e');
  assert.ok(e.elements.length > before, 'content appended');
  assert.equal(e.noWrap, false, '\\_n does not leak into the next script');
  assert.equal(e.font.bold, false, '\\f does not leak into the next script');
  const ys = e.elements.filter(x => x.t === 'g' && x.ch === 'y');
  assert.ok(ys.length === 80 && ys.every(x => x.x <= e.geo.lineLimit), 'the appended text wraps inside the balloon');
});

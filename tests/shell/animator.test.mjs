// SERIKO scheduler tests with explicit time (fake clock) and injectable randomness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Animator, AUTO, EXPLICIT } from '../../src/shell/animator.js';
import { parseShell } from '../../src/shell/surfaces.js';
import { orderedCollisions, collisionAt } from '../../src/shell/hittest.js';
import { tsubasaShell } from './helpers.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');
const fr = (a, id) => { const f = a.frame(id); return f ? f.surface : null; };

function synth(body, version = 1) {
  return parseShell({ descript: '', surfaces: [`descript\n{\nversion,${version}\n}\nsurface0\n{\n${body}\n}\n`] }).surface(0);
}

test('blink (sometimes): 1 Hz trigger, wait before each frame, -1 clears and ends', real, () => {
  const { shell } = tsubasaShell();
  const a = new Animator({ random: () => 0.1 });
  a.setSurface(shell.surface(0), 0);
  assert.equal(a.nextDue(), 1000);
  a.tick(999);
  assert.equal(a.isAnimating(0), false);
  a.tick(1000);
  assert.equal(a.isAnimating(0), true);
  assert.equal(fr(a, 0), null);              // first frame only after its 50 ms wait
  a.tick(1050); assert.equal(fr(a, 0), 1000);
  a.tick(1100); assert.equal(fr(a, 0), 1006);
  a.tick(1150); assert.equal(fr(a, 0), 1000);
  assert.equal(a.tick(1199), false);
  assert.equal(a.tick(1200), true);
  assert.equal(fr(a, 0), null);
  assert.equal(a.isAnimating(0), false);
  // random >= 1/2: no blink
  const b = new Animator({ random: () => 0.6 });
  b.setSurface(shell.surface(0), 0);
  b.tick(5000);
  assert.equal(b.isAnimating(0), false);
});

test('talk: N defaults to 1; AUTO triggers do not restart a running mouth', real, () => {
  const { shell } = tsubasaShell();
  const a = new Animator({ random: () => 0.9 });
  a.setSurface(shell.surface(0), 0);
  a.talk(100);
  assert.ok(a.isAnimating(200));
  a.tick(150);
  a.talk(150);                               // ~50 ms per character: must not restart
  a.tick(170); assert.equal(fr(a, 200), 1100);
  a.talk(220);
  a.tick(240); assert.equal(fr(a, 200), null);
  assert.equal(a.isAnimating(200), false);
  a.talk(260);
  assert.ok(a.isAnimating(200));
  a.tick(330); assert.equal(fr(a, 200), 1100);
  // talk,3 only every third character
  const s = synth('animation1.interval,talk,3\nanimation1.pattern0,overlay,5,10,0,0');
  const t = new Animator();
  t.setSurface(s, 0);
  t.talk(0, 2); assert.ok(!t.isAnimating(1));
  t.talk(0, 1); assert.ok(t.isAnimating(1));
});

test('fireworks (old syntax): alternativestart, exclusive, base override, move offsets', real, () => {
  const { shell } = tsubasaShell();
  let r = 0.0;
  const a = new Animator({ random: () => r });
  a.setSurface(shell.surface(930), 0);
  a.tick(1000);                              // anim 0 (sometimes) fires alternativestart [1..12] -> pick index 0 -> anim 1
  assert.ok(a.isAnimating(1));
  assert.equal(a.baseOverride(), 9300);      // pattern0 base 9300 (wait 0) applied at once
  assert.deepEqual(a.moveOffset(), { x: 100, y: 0 });
  assert.equal(a.start(2, 1000, EXPLICIT), false, 'exclusive blocks other starts');
  a.tick(1080); assert.deepEqual(a.moveOffset(), { x: 100, y: -50 });
  a.tick(1080 + 80 * 9); assert.deepEqual(a.moveOffset(), { x: 100, y: -500 });
  a.tick(1880); assert.equal(a.baseOverride(), 9301);
  const end = 1880 + 120 + 150 + 300 + 100 + 100;
  a.tick(end);
  assert.equal(a.isAnimating(1), false);
  assert.equal(a.baseOverride(), 10);        // last frame persists: base 10 (blank) = "disappear"
  assert.deepEqual(a.moveOffset(), { x: 100, y: -500 });
  assert.equal(a.exclusive, null);
  r = 0.99;
  assert.equal(a.start(2, end, EXPLICIT), true);
  assert.equal(a.baseOverride(), 9310);      // most recent base wins
  a.stop(2);
  assert.equal(a.baseOverride(), 10);
  a.stopAll();
  assert.equal(a.baseOverride(), null);
  assert.equal(a.moveOffset(), null);
});

test('always: Christmas tree loops its base frames without drifting', real, () => {
  const { shell } = tsubasaShell();
  const a = new Animator();
  a.setSurface(shell.surface(960), 0);
  assert.equal(a.baseOverride(), 9360);
  a.tick(1999); assert.equal(a.baseOverride(), 9360);
  a.tick(2000); assert.equal(a.baseOverride(), 9361);
  a.tick(4000); assert.equal(a.baseOverride(), 9362);
  a.tick(6000); assert.equal(a.baseOverride(), 9360);     // -1 then the restart's 0 ms first frame
  assert.ok(a.isAnimating(0));
  a.tick(8000); assert.equal(a.baseOverride(), 9361);
  assert.equal(a.nextDue(), 10000);
  // long stall (hidden tab): no backlog replay
  a.tick(1e9);
  assert.ok(a.isAnimating(0));
  assert.ok(a.nextDue() > 1e9);
});

test('rhythm game: bind+runonce, -1 mid-sequence continues, alternativestart chain with timed collisions', real, () => {
  const { shell } = tsubasaShell();
  const surf = shell.surface(9425);
  const on = new Set();
  const a = new Animator({ bindOn: id => on.has(id), random: () => 0 });
  a.setSurface(surf, 0);
  assert.equal(fr(a, 50000), 9434);                       // runonce single frame persists
  assert.equal(a.isAnimating(50000), false);
  assert.ok(!a.isAnimating(9426));
  on.add(9426);
  a.bindChanged(9426, true, 0);
  assert.ok(a.isAnimating(9426));
  a.tick(50); assert.deepEqual([fr(a, 9426), a.frame(9426).y], [9426, -40]);
  const hit = () => collisionAt(orderedCollisions(shell, surf, a), 10, 170);
  assert.equal(hit(), 'LM');
  // 9426: 31 frames of 50 ms (last at 1550), then -1 and alternativestart [19426] with no wait
  a.tick(1549);
  assert.ok(a.isAnimating(9426));
  a.tick(1550);
  assert.equal(a.isAnimating(9426), false);
  assert.ok(a.isAnimating(19426));
  assert.equal(hit(), 'LG1');                             // animation collision in front of the base one
  a.tick(1600);
  assert.ok(a.isAnimating(29426) && !a.isAnimating(19426));
  assert.equal(hit(), 'LB1');
  a.tick(1650);
  assert.equal(hit(), 'LG1');
  a.tick(1700);
  assert.ok(a.isAnimating(49426));
  assert.equal(hit(), 'LM');
  // the same chain replayed by one coarse tick (throttled tab) ends in the same state
  const b = new Animator({ bindOn: id => on.has(id), random: () => 0 });
  b.setSurface(surf, 0);
  b.bindChanged(9426, true, 0);
  b.tick(1700);
  assert.ok(b.isAnimating(49426) && !b.isAnimating(9426));
  // OFF then ON in one script restarts the part (SUM §2.3)
  a.tick(5000);
  on.delete(9426); a.bindChanged(9426, false, 5000);
  on.add(9426); a.bindChanged(9426, true, 5000);
  assert.ok(a.isAnimating(9426));
  a.tick(5050); assert.equal(a.frame(9426).y, -40);
  // bind OFF clears the frame
  on.delete(9426); a.bindChanged(9426, false, 5100);
  assert.equal(fr(a, 9426), null);
});

test('runonce on surface change, never, explicit start/restart, -2, stop, pause/resume, waits', async () => {
  const s = synth([
    'animation1.interval,runonce', 'animation1.pattern0,overlay,11,100,0,0', 'animation1.pattern1,overlay,12,100,0,0',
    'animation2.interval,never', 'animation2.pattern0,overlay,21,10,0,0', 'animation2.pattern1,overlay,-2,10,0,0', 'animation2.pattern2,overlay,22,10,0,0',
    'animation3.interval,never', 'animation3.pattern0,start,1', 'animation3.pattern1,stop,2',
  ].join('\n'));
  const a = new Animator();
  a.setSurface(s, 0);
  assert.ok(a.isAnimating(1));
  a.tick(100); assert.equal(fr(a, 1), 11);
  assert.ok(!a.isAnimating(2));
  a.start(2, 100);
  a.tick(110); assert.equal(fr(a, 2), 21);
  a.tick(120);                                            // -2 stops every other animation and clears itself
  assert.ok(!a.isAnimating(1));
  assert.equal(fr(a, 1), null);
  assert.equal(fr(a, 2), null);
  a.tick(130); assert.equal(fr(a, 2), 22);
  // explicit restart of a running animation from pattern 0; AUTO is ignored
  a.start(1, 200);
  a.tick(300); assert.equal(fr(a, 1), 11);
  assert.equal(a.start(1, 300, AUTO), false);
  a.start(1, 350, EXPLICIT);
  assert.equal(fr(a, 1), null);
  // control patterns run immediately after the previous one
  a.start(2, 400);
  a.start(3, 400);                                        // start,1 (restart) then stop,2
  assert.ok(a.isAnimating(1) && !a.isAnimating(2));
  // pause / resume shifts the schedule
  a.start(1, 1000);
  a.pause(1, 1050);
  a.tick(1200); assert.equal(fr(a, 1), null);
  a.resume(1, 1200);
  a.tick(1249); assert.equal(fr(a, 1), null);
  a.tick(1250); assert.equal(fr(a, 1), 11);
  // wait() resolves on finish
  let done = false;
  a.wait(1).then(() => { done = true; });
  a.tick(1350);
  await Promise.resolve();
  assert.ok(done);
  assert.equal(fr(a, 1), 12);                             // last frame persists after a natural end
  // \s to another surface clears everything
  a.setSurface(null, 2000);
  assert.equal(a.nextDue(), Infinity);
});

test('exclusive with an id list; random,N; rarely; periodic; yen-e; bind+always loop', () => {
  const s = synth([
    'animation1.interval,never', 'animation1.option,exclusive,(2)', 'animation1.pattern0,overlay,11,100,0,0',
    'animation2.interval,never', 'animation2.pattern0,overlay,21,100,0,0',
    'animation3.interval,never', 'animation3.pattern0,overlay,31,100,0,0',
    'animation4.interval,random,4', 'animation4.pattern0,overlay,41,10,0,0',
    'animation5.interval,periodic,3', 'animation5.pattern0,overlay,51,10,0,0',
    'animation6.interval,yen-e', 'animation6.pattern0,overlay,61,0,0,0',
    'animation7.interval,bind+always', 'animation7.pattern0,overlay,71,30,0,0', 'animation7.pattern1,overlay,72,30,0,0',
    'animation8.interval,rarely', 'animation8.pattern0,overlay,81,10,0,0',
  ].join('\n'));
  let rnd = 0.3;
  const on = new Set();
  const a = new Animator({ bindOn: id => on.has(id), random: () => rnd });
  a.setSurface(s, 0);
  a.start(2, 0); a.start(3, 0);
  a.start(1, 0);
  assert.ok(!a.isAnimating(2) && a.isAnimating(3), 'exclusive (2) stops only 2');
  assert.equal(a.start(2, 10), false);
  assert.equal(a.start(3, 10), true);
  // random,4: 0.3*4 >= 1 -> no; rarely (1/4) -> no
  a.tick(1000);
  assert.ok(!a.isAnimating(4) && !a.isAnimating(8));
  rnd = 0.2;
  a.tick(2000);
  assert.ok(a.isAnimating(4) && a.isAnimating(8));
  // periodic,3
  a.tick(2999); assert.ok(!a.isAnimating(5));
  a.tick(3000); assert.ok(a.isAnimating(5));
  // yen-e
  a.scriptEnd(3000);
  assert.equal(fr(a, 6), 61);
  // bind+always loops only while its group is on
  on.add(7); a.bindChanged(7, true, 4000);
  a.tick(4030); assert.equal(fr(a, 7), 71);
  a.tick(4060); assert.equal(fr(a, 7), 72);
  a.tick(4090); assert.equal(fr(a, 7), 71);
  on.delete(7); a.bindChanged(7, false, 4100);
  assert.ok(!a.isAnimating(7));
  assert.equal(fr(a, 7), null);
});

test('degenerate data: zero-length always loops and start cycles terminate', () => {
  const s = synth([
    'animation1.interval,always', 'animation1.pattern0,overlay,11,0,0,0',
    'animation2.interval,never', 'animation2.pattern0,start,3',
    'animation3.interval,never', 'animation3.pattern0,start,2',
  ].join('\n'));
  const a = new Animator();
  a.setSurface(s, 0);
  assert.equal(fr(a, 1), 11);
  a.tick(100000);
  assert.ok(a.isAnimating(1));
  assert.ok(a.nextDue() > 100000);
  a.start(2, 0);                                          // 2 <-> 3 explicit start cycle: bounded
  assert.ok(true);
});

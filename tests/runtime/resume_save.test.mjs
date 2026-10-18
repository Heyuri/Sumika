// Saves while EventLoop.boot() is on its way (SUMMARY §2.5). The collector is registered when the loop is made, but a
// resume applies the stored run, timers, boxes and music only after the engine has answered version and the NOTIFY
// batch. A save in between (pagehide, the tab hidden, a takeover's suspend(), a debounced change) must keep them
// as stored, both in localStorage (a quick second navigation resumes from it) and for boot() itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage, normalizeState, stateKey } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, deferred, settle } from './fakes.mjs';

setLogLevel('silent');

const GHOST = { id: 'tsubasa', name: 'Tsubasa', sakuraName: 'Tsubasa', defaultShell: 'master' };
const NOW = new FakeClock().now();
const MUSIC = { path: 'C:\\sumika\\drop\\0123abcd\\Song.mp3', currentTime: 42.5, loop: true, volume: 0.5, playing: true };

/** What the previous page left in localStorage. */
function seed(storage, extra = {}) {
  const s = new StateStore('tsubasa', { storage, clock: new FakeClock() });
  s.data = normalizeState({
    v: 1,
    run: { src: '\\0Still talking\\e', ip: 3, state: 'running', hasChoices: false, origin: 'OnMouseDoubleClick', refs: ['0'] },
    timers: [{ ev: 'later', refs: ['x'], repeat: false, intervalMs: 5000, dueAt: NOW + 3000, kind: 'raise' }],
    boxes: [{ kind: 'inputbox', id: 'OnName', args: ['OnName', '', 'Hana'], dueAt: 0 }],
    music: MUSIC,
    ...extra,
  });
  s.saveNow();
}

const stored = storage => JSON.parse(storage.getItem(stateKey('tsubasa')));

/** The next page: a fresh store read back from storage; `version` answers once the gate opens. */
function nextPage(storage, gate) {
  const clock = new FakeClock();
  const state = new StateStore('tsubasa', { storage, clock });
  const shiori = new FakeShiori(r => (r.id === 'version' ? gate.promise : null));
  const player = new FakePlayer();
  const stage = new FakeStage();
  const dialogs = new FakeDialogs();
  const audio = { resumed: [], sound() {}, musicState() { return this.resumed.at(-1) || null; }, resumeMusic(m) { this.resumed.push(m); } };
  const loop = new EventLoop({
    shiori, player, stage, balloons: new FakeBalloons(), dialogs, ghost: GHOST, state, clock, audio,
    env: { win: null, doc: null }, site: { ghosts: [GHOST], balloons: [] },
  });
  return { clock, state, shiori, player, stage, dialogs, audio, loop };
}

test('resume: saves before boot() has restored the run, timers, boxes and music keep them as stored', async () => {
  const storage = memoryStorage();
  seed(storage);
  const before = stored(storage);
  const gate = deferred();
  const t = nextPage(storage, gate);
  const booting = t.loop.boot({ resume: true });
  await settle();
  assert.deepEqual(t.shiori.ids(), ['GET version'], 'boot() waits for the engine');

  t.state.saveNow();                                     // pagehide, the tab hidden, a takeover's suspend()
  t.stage.emit('move', { scope: 0, reason: 'resize' });  // a debounced save
  await t.clock.advance(300);
  for (const k of ['run', 'timers', 'boxes', 'music']) assert.deepEqual(stored(storage)[k], before[k], `stored ${k}`);

  gate.resolve('Satori phase Mc203-6');
  await booting;
  await settle();
  assert.deepEqual(t.player.replays.map(r => r.run.src), ['\\0Still talking\\e'], 'the run is replayed');
  assert.deepEqual(t.dialogs.boxes.map(b => [b.kind, b.o.id, b.o.defaultText]), [['input', 'OnName', 'Hana']]);
  assert.deepEqual([...t.loop.timers.keys()], ['later']);
  assert.deepEqual(t.audio.resumed, [MUSIC]);

  // restored: from now on the live objects are the state
  t.state.saveNow();
  let s = stored(storage);
  assert.equal(s.run.src, '\\0Still talking\\e');
  assert.deepEqual(s.timers.map(x => [x.ev, x.dueAt]), [['later', NOW + 3000]]);
  assert.deepEqual(s.boxes.map(b => b.id), ['OnName']);
  assert.deepEqual(s.music, MUSIC);
  t.loop.timerRaise(0, '1', 'later');                    // \![timerraise,0,...] cancels it
  t.state.saveNow();
  assert.deepEqual(stored(storage).timers, []);
  t.loop.destroy();
});

test('cold boot: a save while OnBoot is on its way already writes the cleared state', async () => {
  const storage = memoryStorage();
  seed(storage, { ghostLife: { passive: true, induction: false }, minimized: { reason: 'user', scopes: [0, 1] } });
  const gate = deferred();
  const t = nextPage(storage, gate);
  const booting = t.loop.boot({ resume: false });
  await settle();
  t.state.saveNow();
  const s = stored(storage);
  assert.deepEqual([s.run, s.timers, s.boxes, s.music, s.minimized], [null, [], [], null, null]);
  assert.deepEqual(s.ghostLife, { passive: false, induction: false }, 'SSP starting again leaves passive mode');
  gate.resolve(null);
  await booting;
  assert.deepEqual([t.player.replays.length, t.dialogs.boxes.length, t.loop.timers.size, t.audio.resumed.length], [0, 0, 0, 0]);
  t.loop.destroy();
});

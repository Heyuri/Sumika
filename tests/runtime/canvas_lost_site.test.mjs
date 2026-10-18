// A ghost whose canvas cannot draw (Runtime._canvasLost, Site._dropFailed) on the lead Site with several
// ghosts (multi_world.mjs): the views' onCanvasLost is called as the real Stage, Balloons and BalloonSkin call it
// (canvas_lost.test.mjs drives those on the fake DOM). While a boot builds or plays its boot talk, the start fails (one
// error) and she leaves the set if others run; later (a balloon after the boot, a shell swap) one error at once, her
// characters veiled and balloons hidden and she stops (saved as for a takeover: no talk, timer or event of hers from
// then on, so a change under way ends early and nothing shows her balloons again), then, once that change settled, she
// is unloaded and leaves the set while others run; alone, the set stays and the lead goes, so the next page tries her
// again. A frozen tab's stage that cannot draw is not shown; one shown that loses a canvas goes, and the tab still takes
// the ghost over. invariants() after every step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimePrefs, sessionMarker, stateKey } from '../../src/core/state.js';
import { markerGhosts } from '../../src/core/ghostset.js';
import { setLogLevel } from '../../src/core/log.js';
import { settle } from './fakes.mjs';
import { ghost, world, defaultAnswer, TestRuntime, TestSite, loopOf, eng, ids, until, up, invariants } from './multi_world.mjs';

setLogLevel('warn');

/**
 * TestRuntime whose views report a lost canvas as the real ones do: w.lose = {stage: id | id/shell, balloons: id,
 * bootTalk: id, frozen: id, balloonSkin: balloon id}: that ghost's Stage (or the one of that shell) at its creation,
 * its Balloons when the test calls w.lost[id].balloons(kind), at its boot talk's start, its frozen stage at its
 * creation, an image of that balloon's skin as a balloon change loads it. w.lost[id]: the onCanvasLost each part got.
 * The balloons' `up` stands for a balloon on screen: a run's start shows it, and so does player.write() while that
 * run plays (BalloonModel.write shows a hidden balloon); hideAll() hides it. w.swapBlank: a stage built for a shell
 * swap has no surface yet (swapStageState's -1), as the real one.
 */
class LostRuntime extends TestRuntime {
  async _createStage(opts) {
    const s = await super._createStage(opts);
    const id = this.ghost.id, lose = this.w.lose || {};
    s.setVeiled = on => { s.veiled = !!on; };
    if (opts.shellId) s.shellId = opts.shellId;
    if (this.w.swapBlank && this.parts && this.parts.booted) {
      for (const [k, st] of Object.entries((opts.state && opts.state.scopes) || {})) if (st && st.surface === -1) s.char(Number(k)).surfaceId = -1;
    }
    (this.w.lost[id] ||= {}).stage = opts.onCanvasLost;
    if (lose.stage === id || lose.stage === `${id}/${opts.shellId}` || (lose.frozen === id && this.state && this.state.readOnly)) {
      s.lost = 'character';
      opts.onCanvasLost('character', s);
    }
    return s;
  }
  async _createBalloons(opts) {
    const b = await super._createBalloons(opts);
    b.hideAll = () => { b.hiddenAll = (b.hiddenAll || 0) + 1; b.up = false; };
    (this.w.lost[this.ghost.id] ||= {}).balloons = opts.onCanvasLost;
    return b;
  }
  async _loadBalloon(entry, files, o = {}) {
    await settle(1);                  // the skin's images decode after its files load (BalloonSkin.load)
    if ((this.w.lose || {}).balloonSkin === entry.id && o.onCanvasLost) o.onCanvasLost('balloon image');
    return { skin: { balloon: () => null, name: entry.name }, id: entry.id, name: entry.name || entry.id, path: `/balloon/${entry.id}/`, files: null };
  }
  _createPlayer(o = {}) {
    const p = super._createPlayer();
    const id = this.ghost.id;
    p.on('start', () => { if (o.balloons) o.balloons.up = true; });
    p.write = () => { if (p.busy && o.balloons) o.balloons.up = true; };
    if ((this.w.lose || {}).bootTalk === id) {
      const off = p.on('start', () => { off(); this.w.lost[id].balloons('balloon'); });
    }
    return p;
  }
}

/** The ghost state stored for id (localStorage, as the next page reads it). */
const stored = id => JSON.parse(localStorage.getItem(stateKey(id)));

function lostWorld(o = {}) {
  const w = world(o);
  w.lost = {};
  w.lose = {};
  return w;
}

/** console.error lines while f runs */
async function errorsOf(f) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(x => (x instanceof Error ? x.message : String(x))).join(' '));
  try { await f(); } finally { console.error = orig; }
  return lines;
}

const LOST = /^\[sumika\] .*y cannot be drawn: the browser gave its (character|balloon) canvas no drawing memory/;

test('a boot whose character canvas cannot draw, in a set of two: her start fails (one error), she leaves the set, X runs on', async () => {
  const w = lostWorld();
  w.lose.stage = 'y';
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  let site;
  const errors = await errorsOf(async () => { site = await up(w, { Runtime: LostRuntime }); });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /failed to start .*y cannot be drawn: the browser gave its character canvas/);
  assert.deepEqual(ids(site), ['x']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x']);
  assert.ok(!w.locks.held.has('sumika:y'), 'her lock let go');
  assert.ok(loopOf(site.slots[0]) && !loopOf(site.slots[0]).closed, 'X runs');
  const ey = eng(w, 'y');
  await settle();
  assert.ok(!ey || ey.terminated, 'her engine stopped');
  invariants(site, w);
});

test('her boot talk\'s balloon cannot draw: the start fails after the boot (one error), she leaves the set, X runs on', async () => {
  const w = lostWorld();
  w.lose.bootTalk = 'y';
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  let site;
  const errors = await errorsOf(async () => { site = await up(w, { Runtime: LostRuntime }); await settle(); });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /failed to start .*y cannot be drawn: the browser gave its balloon canvas/);
  assert.deepEqual(ids(site), ['x']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x']);
  assert.ok(!w.locks.held.has('sumika:y'));
  assert.equal(eng(w, 'y').terminated, true);
  invariants(site, w);
});

test('later, with X on screen: one error at once, Y veiled and her balloons hidden; then saved, unloaded and out of the set; X re-NOTIFYed', async () => {
  const w = lostWorld();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w, { Runtime: LostRuntime });
  const [x, y] = site.slots;
  const ex = eng(w, 'x'), ey = eng(w, 'y');
  const p = y.parts;
  ex.log.length = 0;
  const errors = await errorsOf(async () => {
    w.lost.y.balloons('balloon');
    assert.equal(p.stage.veiled, true, 'veiled at once');
    assert.equal(p.balloons.hiddenAll, 1, 'balloons hidden at once');
    assert.equal(p.loop.frozen, true, 'she stops at once');
    w.lost.y.balloons('balloon image');            // a second loss: nothing more
    w.lost.y.stage('character');
    await until(() => site.slots.length === 1);
  });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], LOST);
  assert.equal(y.parts, null);
  assert.ok(ey.persisted >= 1, 'saved as for a takeover');
  assert.equal(ey.terminated, true);
  assert.equal(ey.find('OnClose').length, 0, 'no OnClose');
  assert.ok(!w.locks.held.has('sumika:y'));
  assert.deepEqual(ids(site), ['x']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x']);
  assert.deepEqual(markerGhosts(sessionMarker.read()), ['x']);
  assert.ok(loopOf(x) && !loopOf(x).closed, 'X runs on');
  assert.deepEqual(ex.ids().filter(i => /otherghostname/.test(i)), ['NOTIFY otherghostname'], 'X hears the set without her');
  invariants(site, w);
});

test('later, alone: she goes, the set stays (the next page tries her again) and the lead goes', async () => {
  const w = lostWorld();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x'], rev: 1 });
  const site = await up(w, { Runtime: LostRuntime });
  const [x] = site.slots;
  assert.ok(site.lead.held);
  const errors = await errorsOf(async () => {
    w.lost.x.stage('character');
    await until(() => !x.parts);
    await settle();
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /x cannot be drawn: the browser gave its character canvas/);
  assert.equal(x.parts, null);
  assert.deepEqual(ids(site), ['x'], 'her slot stays (window.sumika.runtime)');
  assert.deepEqual(runtimePrefs.get().ghosts, ['x'], 'the set stays');
  assert.equal(site.lead.held, false, 'the lead goes');
  assert.ok(!w.locks.held.has('sumika:x'));
  assert.equal(eng(w, 'x').terminated, true);
});

test('a shell swap whose new stage cannot draw: she stops at once, the swap ends without OnShellChanged, then she goes (one error); the next page gets the remembered surfaces', async () => {
  const w = lostWorld({ ghosts: [ghost('x'), ghost('y', { shells: [{ id: 'master', name: 'm' }, { id: 'b', name: 'b' }] })] });
  w.lose.stage = 'y/b';
  w.swapBlank = true;
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w, { Runtime: LostRuntime });
  const y = site.slots[1];
  const ey = eng(w, 'y');
  const p = y.parts;
  let changed;
  const errors = await errorsOf(async () => {
    const pr = site.changeShell('b', { ghost: 'y' });
    for (let i = 0; i < 20 && !(y.player && y.player.busy); i++) await settle();
    if (y.player && y.player.busy) y.player.finish();      // OnShellChanging's talk, if any
    changed = await pr;
    await until(() => site.slots.length === 1);
  });
  assert.equal(changed, true, 'the swap itself ended');
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], LOST);
  assert.deepEqual(ids(site), ['x']);
  assert.equal(ey.find('OnShellChanged').length, 0, 'no OnShellChanged: its reply would show a balloon');
  assert.equal(p.balloons.up, false, 'her balloons stay hidden');
  assert.equal(p.stage.veiled, true, 'the new stage veiled too');
  const st = stored('y');
  assert.equal(st.shell, 'b');
  assert.deepEqual(st.shellSwap, { surfaces: { 0: 0, 1: 10 } }, 'the swap\'s marker stays: the next page shows the remembered surfaces (settleSwapSurfaces)');
  invariants(site, w);
});

test('a loss while a shell change waits for OnShellChanging\'s talk: she stops at once, a balloon write shows nothing, the change is cancelled without its 30 s wait; then she goes', async () => {
  const w = lostWorld({
    ghosts: [ghost('x'), ghost('y', { shells: [{ id: 'master', name: 'm' }, { id: 'b', name: 'b' }] })],
    answer: (id, r, mem) => (r.id === 'OnShellChanging' ? `\\0${id}: changing\\e` : defaultAnswer(id, r, mem)),
  });
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w, { Runtime: LostRuntime });
  const y = site.slots[1];
  const ey = eng(w, 'y');
  const p = y.parts;
  let changed = null;
  const errors = await errorsOf(async () => {
    const pr = site.changeShell('b', { ghost: 'y' });
    pr.then(v => { changed = v; });
    assert.ok(await until(() => y.player.busy && y.player.cur.meta.event === 'OnShellChanging'), 'her OnShellChanging talk plays');
    assert.equal(p.balloons.up, true);
    w.lost.y.balloons('balloon');
    assert.equal(p.balloons.up, false, 'hidden at once');
    assert.equal(p.loop.frozen, true, 'she stops at once');
    assert.equal(y.player.busy, false, 'her talk is cut');
    y.player.write();                                    // the talk's next text
    assert.equal(p.balloons.up, false, 'a balloon write shows nothing');
    assert.ok(await until(() => site.slots.length === 1), 'she goes without the talk\'s end or the 30 s cap');
  });
  assert.equal(changed, false, 'the shell change is cancelled');
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], LOST);
  assert.equal(ey.find('OnShellChanged').length, 0);
  assert.equal(p.balloons.up, false);
  assert.equal(p.stage.veiled, true);
  assert.equal(stored('y').shell, 'master', 'the shell stays');
  assert.equal(ey.terminated, true);
  assert.deepEqual(ids(site), ['x']);
  invariants(site, w);
});

test('a balloon change whose new skin loses an image canvas: she stops at once, no OnBalloonChange (its reply would show a balloon), the choice stored; then she goes', async () => {
  const w = lostWorld({ answer: (id, r, mem) => (r.id === 'OnBalloonChange' ? `\\0${id}: a new balloon\\e` : defaultAnswer(id, r, mem)) });
  w.index.balloons = [{ id: 'b2', name: 'B2' }];
  w.lose.balloonSkin = 'b2';
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w, { Runtime: LostRuntime });
  const y = site.slots[1];
  const ey = eng(w, 'y');
  const p = y.parts;
  const plays = y.player.plays.length;
  let changed;
  const errors = await errorsOf(async () => {
    changed = await site.changeBalloon('b2', { ghost: 'y' });
    assert.ok(await until(() => site.slots.length === 1));
  });
  assert.equal(changed, true, 'the swap itself ended');
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /y cannot be drawn: the browser gave its balloon image canvas/);
  assert.equal(ey.find('OnBalloonChange').length, 0);
  assert.equal(y.player.plays.length, plays, 'nothing played after she stopped');
  assert.equal(p.balloons.up, false);
  assert.equal(stored('y').balloon, 'b2', 'the choice the swap made after she stopped is stored');
  assert.equal(ey.terminated, true);
  assert.deepEqual(ids(site), ['x']);
  invariants(site, w);
});

test('a frozen tab: a stage that cannot draw is not shown (one error); one shown that loses a canvas goes', async () => {
  const w = lostWorld();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const a = await up(w, { Runtime: LostRuntime });
  w.lose.frozen = 'y';
  const b = new TestSite(w, { hidden: true, Runtime: LostRuntime });
  let out;
  let errors = await errorsOf(async () => { out = await b.start(); await settle(); });
  assert.equal(out, 'frozen');
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], LOST);
  const [bx, by] = b.slots;
  assert.ok(bx.frozen, 'X shows frozen');
  assert.equal(by.frozen, null, 'Y is not shown');
  // X's frozen stage, shown, loses a canvas
  errors = await errorsOf(async () => { w.lost.x.stage('character', bx.frozen); await settle(); });
  assert.equal(errors.length, 1);
  assert.equal(bx.frozen, null, 'the frozen view goes');
  assert.deepEqual(ids(a), ['x', 'y'], 'the tab running the set is untouched');
  b.done();
});

test('a frozen tab with a lone ghost whose shown stage loses a canvas: the view goes, and turning to the tab still takes her over', async () => {
  const w = lostWorld();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x'], rev: 1 });
  const a = await up(w, { Runtime: LostRuntime });
  const b = new TestSite(w, { hidden: true, Runtime: LostRuntime });
  assert.equal(await b.start(), 'frozen');
  const [bx] = b.slots;
  const shown = bx.frozen;
  assert.ok(shown, 'X shows frozen');
  const errors = await errorsOf(async () => { w.lost.x.stage('character', shown); await settle(); });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /x cannot be drawn: the browser gave its character canvas/);
  assert.equal(bx.frozen, null, 'the frozen view goes');
  assert.equal(shown.destroyed, true);
  a.doc.hidden = true;
  b.show(true);                                         // the visitor turns to B
  assert.ok(await until(() => loopOf(b.slots[0]) && loopOf(b.slots[0]).booted), 'B takes her over');
  await settle(20);
  assert.ok(b.lead.held && w.locks.held.has('sumika:x'));
  assert.ok(!a.lead.held);
  assert.ok(a.slots.every(rt => !rt.parts), 'A let her go');
  assert.equal(eng(w, 'x').resume, true, 'taken over: resumed');
  invariants(a, w);
  invariants(b, w);
});

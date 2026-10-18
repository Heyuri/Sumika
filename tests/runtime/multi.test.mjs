// Several ghosts on one page (EV §2.7, UI §2.12, §9.5; CONTRACTS "Site"): the lead Site main.js builds, with
// fake engines and views (real headless Stages on synthetic shells for the ghosts in w.shells: placement). A synthetic
// site of four Satori ghosts (x, y, z, w) and a Misaka one (multi_world.mjs); every request of every engine goes into
// one order log, so the cross-ghost order (a callee's batch, the others' re-NOTIFY, its boot GET) can be asserted.
// invariants() (multi_world.mjs) runs after every step. Ghosts talking to each other: interact.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage, runtimePrefs, sessionMarker, stateKey } from '../../src/core/state.js';
import { markerGhosts } from '../../src/core/ghostset.js';
import { setLogLevel } from '../../src/core/log.js';
import { settle, deferred, keyEvent } from './fakes.mjs';
import {
  defaultAnswer, world, TestSite, loopOf, eng, live, ids, events, idle, until, quitRun, up, menuCall, invariants,
} from './multi_world.mjs';

setLogLevel('silent');

const U = undefined;
const ref = id => `${id.toUpperCase()}s\x010\x0110`;          // otherghostname of a ghost on its default surfaces
const BOOT = /On(Boot|FirstBoot|GhostCalled|GhostChanged)$/;
const OTHER = /On(GhostCallComplete|OtherGhost\w+)$/;
const drop = () => ({ scope: 0, files: [new File([new Uint8Array(2)], 'note.txt', { type: 'text/plain' })], x: 1, y: 2 });

// ---------------------------------------------------------------- 1–5: calls

test('call ▸ X -> Y: OnGhostCalling; Y\'s batch lists X; X re-NOTIFYed after OnGhostCalled; OnGhostCallComplete after Y\'s boot run', async () => {
  const w = world();
  w.saves.set('y', {});                                   // met before: no first boot
  const site = await up(w);
  invariants(site, w);
  const x = site.slots[0];
  const ex = eng(w, 'x');
  w.order.length = 0;
  x.parts.menu._run({ type: 'callghost', id: 'y' }, 0);
  await settle();
  const calling = ex.find('OnGhostCalling');
  assert.equal(calling.length, 1);
  assert.deepEqual(calling[0].refs, ['Ys', 'manual', 'Ghost Y', '/ghost/y/']);
  assert.deepEqual([calling[0].headers.BaseID, calling[0].headers.SenderType], ['OnGhostChanging', 'internal']);
  await idle(site);
  const y = site.find('y');
  assert.ok(y && y !== x && loopOf(y).booted);
  assert.deepEqual(ids(site), ['x', 'y'], 'set order = call order');
  const ey = eng(w, 'y');
  assert.deepEqual(ey.find('otherghostname')[0].refs, [ref('x')], 'Y\'s batch lists X');
  const reNotify = w.order.indexOf('x NOTIFY otherghostname');
  // SSP's AddGhost posts it, then asks Y's boot event before it reads its messages [disasm 0x733045, 0x465CA3]
  assert.ok(reNotify > w.order.indexOf('y GET OnGhostCalled'), 'X is told of Y after Y\'s boot GET');
  assert.deepEqual(ex.find('otherghostname').at(-1).refs, [ref('y')]);
  const called = ey.find('OnGhostCalled');
  assert.deepEqual(called[0].refs, ['Xs', '\\0x: calling Ys\\e', 'Ghost X', '/ghost/x/', U, U, U, 'y-shell']);
  assert.equal(called[0].headers.BaseID, 'OnGhostChanged,OnBoot');
  assert.deepEqual(events(ey, BOOT), ['GET OnGhostCalled']);
  assert.ok(!ex.find('OnGhostCallComplete').length, 'nothing to X while Y\'s boot talk plays');
  assert.deepEqual(sessionMarker.read().carry, { y: { kind: 'after', of: 'call', caller: 'x' } }, 'owed on the next page if left now');
  invariants(site, w);
  y.player.finish();
  await settle();
  const done = ex.find('OnGhostCallComplete');
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].refs, ['Ys', '\\0y: called by Xs\\e', 'Ghost Y', U, U, U, U, 'y-shell']);
  assert.equal(done[0].headers.SenderType, 'internal');
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y']);
  assert.ok(Number.isInteger(runtimePrefs.get().rev) && runtimePrefs.get().rev > 0);
  assert.deepEqual(markerGhosts(sessionMarker.read()), ['x', 'y']);
  assert.equal(sessionMarker.read().carry, undefined, 'nothing owed any more');
  assert.ok(site.layers.top === y.sid, 'the callee comes on top');
  const set = w.posts.filter(m => m.t === 'set' && m.cause && m.cause.kind === 'call');
  assert.deepEqual(set.map(m => [m.ghosts, m.cause.id]), [[['x', 'y'], 'y']], 'the other tabs hear of the call');
  invariants(site, w);
});

test('a bystander Z gets OnOtherGhostBooted (the caller OnGhostCallComplete); a minimized one gets nothing', async () => {
  for (const minimized of [false, true]) {
    const w = world();
    w.saves.set('y', {});
    runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'z'], rev: 1 });
    const site = await up(w);
    assert.deepEqual(ids(site), ['x', 'z']);
    const z = site.find('z');
    if (minimized) await loopOf(z).minimize();
    await menuCall(site, site.slots[0], 'y');
    site.find('y').player.finish();
    await settle();
    const refs = ['Ys', '\\0y: called by Xs\\e', 'Ghost Y', U, U, U, U, 'y-shell'];
    assert.deepEqual(eng(w, 'x').find('OnGhostCallComplete').map(r => r.refs), [refs]);
    assert.deepEqual(events(eng(w, 'x'), OTHER), ['GET OnGhostCallComplete']);
    assert.deepEqual(eng(w, 'z').find('OnOtherGhostBooted').map(r => r.refs), minimized ? [] : [refs]);
    assert.deepEqual(events(eng(w, 'z'), /OnGhostCallComplete$/), []);
    assert.deepEqual(eng(w, 'z').find('otherghostname').at(-1).refs, [ref('x'), ref('y')], 'still told who is up');
    invariants(site, w);
    site.done();
  }
});

test('OnGhostCalled 204 -> OnBoot (OnGhostChanged not tried); a ghost never met -> OnFirstBoot; a silent boot -> OnGhostCallComplete at once', async () => {
  const quiet = (id, r, mem) => (id === 'y' && r.id === 'OnGhostCalled' ? null : defaultAnswer(id, r, mem));
  let w = world({ answer: quiet });
  w.saves.set('y', {});
  let site = await up(w);
  await menuCall(site, site.slots[0], 'y');
  assert.deepEqual(events(eng(w, 'y'), BOOT), ['GET OnGhostCalled', 'GET OnBoot']);
  assert.deepEqual(eng(w, 'y').find('OnBoot')[0].refs, ['y-shell', U, U, U, U, U, '', '']);
  site.find('y').player.finish();
  await settle();
  assert.equal(eng(w, 'x').find('OnGhostCallComplete')[0].refs[1], '\\0y: boot\\e', 'R1: the OnBoot talk');
  site.done();

  w = world();                                            // y never ran in this browser
  site = await up(w);
  await menuCall(site, site.slots[0], 'y');
  assert.deepEqual(events(eng(w, 'y'), BOOT), ['GET OnFirstBoot']);
  site.find('y').player.finish();
  await settle();
  assert.equal(eng(w, 'x').find('OnGhostCallComplete')[0].refs[1], '\\0y: first\\e', 'a first boot still completes the call');
  site.done();

  w = world({ answer: (id, r, mem) => (id === 'y' && BOOT.test(r.id) ? null : defaultAnswer(id, r, mem)) });
  w.saves.set('y', {});
  site = await up(w);
  await menuCall(site, site.slots[0], 'y');
  await settle();
  assert.deepEqual(eng(w, 'x').find('OnGhostCallComplete').map(r => r.refs[1]), [''], 'no boot run: at once, R1 empty');
  invariants(site, w);
});

test('\\![call,ghost,Y] in a script: no OnGhostCalling, the script goes on, R1 = that script; --option=raise-event: OnGhostCalling automatic', async () => {
  const w = world();
  w.saves.set('y', {});
  w.saves.set('z', {});
  const site = await up(w);
  const x = site.slots[0];
  const ex = eng(w, 'x');
  x.loop.playScript('\\0Come over.\\![call,ghost,Ys]See?\\e', { event: 'OnTalk' });
  const run = x.player.cur;
  x.loop.call('ghost', ['Ys']);                          // what the player does at the tag (a sakura name)
  await idle(site);
  assert.ok(!ex.find('OnGhostCalling').length);
  assert.equal(x.player.cur, run, 'the caller\'s script is not interrupted');
  assert.equal(x.player.interrupts, 0);
  assert.equal(eng(w, 'y').find('OnGhostCalled')[0].refs[1], '\\0Come over.\\![call,ghost,Ys]See?\\e');
  x.player.finish();
  site.find('y').player.finish();
  await settle();

  x.loop.playScript('\\0And you.\\e');
  x.loop.call('ghost', ['--option=Raise-Event', 'Ghost Z']);
  await idle(site);
  const calling = ex.find('OnGhostCalling');
  assert.deepEqual(calling.map(r => r.refs), [['Zs', 'automatic', 'Ghost Z', '/ghost/z/']]);
  assert.equal(eng(w, 'z').find('OnGhostCalled')[0].refs[1], '\\0x: calling Zs\\e', 'R1: the OnGhostCalling reply');
  assert.deepEqual(ids(site), ['x', 'y', 'z']);
  invariants(site, w);
});

test('ignored calls: self, a ghost on screen, unknown, Misaka (no engine), beyond a site cap (data-max-ghosts 3) — nothing sent or started; Call ghost ▸ rows mark them', async () => {
  const w = world();
  const site = await up(w, { maxGhosts: 3 });
  const x = site.slots[0];
  const before = w.engines.length;
  for (const t of ['Ghost X', 'nobody', 'Misaka', 'lastinstalled']) x.loop.call('ghost', [t]);
  x.parts.menu._run({ type: 'callghost', id: 'mm' }, 0);
  await idle(site);
  assert.equal(w.engines.length, before, 'no engine started');
  assert.deepEqual(ids(site), ['x']);
  assert.ok(!eng(w, 'x').find('OnGhostCalling').length);
  assert.deepEqual(site.callList(x).map(r => [r.id, !!r.current, !!r.elsewhere, r.needs, r.full || null]), [
    ['x', true, false, null, null], ['y', false, false, null, null], ['z', false, false, null, null], ['w', false, false, null, null], ['mm', false, false, 'Misaka', null],
  ]);

  await menuCall(site, x, 'y');
  const y = site.find('y');
  const n = w.engines.length;
  y.loop.call('ghost', ['Ghost X']);                     // on screen: SSP checks IsGhostIDBooted
  x.parts.menu._run({ type: 'callghost', id: 'y' }, 0);
  await idle(site);
  assert.equal(w.engines.length, n);
  assert.deepEqual(site.ghostList(y).map(r => [r.id, !!r.current, !!r.elsewhere]), [['x', false, true], ['y', true, false], ['z', false, false], ['w', false, false], ['mm', false, false]]);
  assert.deepEqual(site.ghostList(x).find(r => r.id === 'y'), { id: 'y', name: 'Ghost Y', current: false, note: null, needs: null, elsewhere: true });

  await menuCall(site, x, 'z');
  assert.deepEqual(ids(site), ['x', 'y', 'z']);
  const m = w.engines.length;
  x.parts.menu._run({ type: 'callghost', id: 'w' }, 0);
  await idle(site);
  assert.equal(w.engines.length, m, 'the site cap: 3 at once');
  assert.deepEqual(site.callList(x).map(r => r.full), [3, 3, 3, 3, 3]);
  invariants(site, w);
  assert.equal(new TestSite(w, { maxGhosts: 1 }).callList(), null, 'one at a time: no Call ghost ▸');
});

test('no cap by default, as SSP [observed]: every runnable site ghost comes on screen; no Call ghost ▸ row is greyed for a full set', async () => {
  const w = world();
  const site = await up(w);
  assert.equal(site.maxGhosts, Infinity);
  const x = site.slots[0];
  for (const id of ['y', 'z', 'w']) await menuCall(site, x, id);
  assert.deepEqual(ids(site), ['x', 'y', 'z', 'w']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y', 'z', 'w']);
  assert.ok(site.callList(x).every(r => !r.full));
  invariants(site, w);
});

// ---------------------------------------------------------------- 6–8: Close and Quit

test('Close of Y while X stays: OnClose only; Y stays without \\-; at \\- X gets OnOtherGhostClosed, then otherghostname []', async () => {
  const w = world();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  const ey = eng(w, 'y');
  const ex = eng(w, 'x');
  await loopOf(y).close(0);
  assert.deepEqual(events(ey, /OnClose(All)?$/), ['GET OnClose']);
  assert.deepEqual(ey.find('OnClose')[0].refs, ['user', 0, 0]);
  assert.equal(ey.find('OnClose')[0].headers.BaseID, undefined);
  y.player.finish();                                      // a goodbye without \- (C22)
  await settle();
  assert.equal(loopOf(y).closed, false, 'still standing');
  assert.deepEqual(ids(site), ['x', 'y']);

  await loopOf(y).close(0);
  ex.log.length = 0;
  quitRun(y);                                             // \-
  await until(() => site.slots.length === 1);
  assert.deepEqual(ids(site), ['x']);
  assert.deepEqual(ex.ids().filter(i => /OnOtherGhostClosed|otherghostname/.test(i)), ['GET OnOtherGhostClosed', 'NOTIFY otherghostname']);
  assert.deepEqual(ex.find('OnOtherGhostClosed')[0].refs, ['Ys', '\\0y: bye\\-', 'Ghost Y', U, U, U, U, 'y-shell']);
  assert.deepEqual(ex.find('otherghostname')[0].refs, []);
  assert.equal(ey.unloaded, true);
  assert.ok(!w.locks.held.has('sumika:y'));
  assert.equal(y._launcherMode, null, 'no launcher for a ghost that left');
  assert.equal(x._launcherMode, null);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x']);
  assert.deepEqual(markerGhosts(sessionMarker.read()), ['x']);
  assert.equal(JSON.parse(localStorage.getItem(stateKey('y'))).closed, true);
  assert.equal(w.posts.filter(m => m.cause && m.cause.kind === 'close').length, 1);
  invariants(site, w);
});

test('Quit with X and Y: OnCloseAll to both at once; each closes at its script\'s end; no OnOtherGhostClosed; the set is kept and called back', async () => {
  const w = world();
  w.saves.set('x', {});
  w.saves.set('y', {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  x.parts.menu._run({ type: 'quit' }, 1);                // the abbreviated menu's Quit
  await settle();
  for (const id of ['x', 'y']) {
    const c = eng(w, id).find('OnCloseAll');
    assert.equal(c.length, 1, `${id} asked`);
    assert.deepEqual([c[0].refs, c[0].headers.BaseID], [['user', 1, 1], 'OnClose']);
    assert.deepEqual(eng(w, id).find('OnClose')[0].refs, ['user', 1, 1], '204 -> OnClose');
  }
  assert.equal(site.quitting, true);
  x.player.finish();                                      // X's goodbye ends without \-: X still goes [disasm]
  await until(() => loopOf(x) === null);
  assert.equal(site.slots.length, 2, 'the layer stays until the last one');
  assert.ok(!eng(w, 'y').find('OnOtherGhostClosed').length);
  quitRun(y);
  await until(() => site.slots.length === 1);
  assert.deepEqual(ids(site), ['x']);
  assert.equal(site.slots[0]._launcherMode, 'closed', 'one closed launcher, for the first ghost');
  assert.deepEqual(site.running(), [], 'nobody on screen');
  assert.ok(site.siteGhosts().every(g => !g.running));
  assert.equal(site.quitting, false);
  assert.ok(!eng(w, 'x').find('OnOtherGhostClosed').length);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y'], 'Quit keeps the set');
  assert.equal(sessionMarker.read(), null);
  assert.ok(!site.lead.held && !w.locks.held.has('sumika/lead'));
  assert.equal(w.posts.at(-1).cause.kind, 'quit');
  invariants(site, w);
  site.done();
  await settle();

  // the next page: the closed launcher; its click brings the set back, one at a time, OnBoot each
  const next = new TestSite(w);
  assert.equal(await next.start(), 'launcher');
  assert.equal(next.slots.length, 1);
  assert.equal(next.slots[0]._launcherMode, 'closed');
  const n = w.engines.length;
  w.order.length = 0;
  next.slots[0]._launch('closed');
  await until(() => next.slots.length === 2 && loopOf(next.slots[1]) && loopOf(next.slots[1]).booted);
  await idle(next);
  assert.deepEqual(ids(next), ['x', 'y']);
  assert.deepEqual(w.engines.slice(n).map(e => e.ghost), ['x', 'y']);
  assert.deepEqual(events(eng(w, 'x'), BOOT), ['GET OnBoot']);
  assert.deepEqual(events(eng(w, 'y'), BOOT), ['GET OnBoot']);
  assert.ok(w.order.indexOf('x GET OnBoot') < w.order.indexOf('y NOTIFY OnInitialize'), 'one at a time');
  // each cold boot re-NOTIFYs every ghost up, the new one too, after its boot GET (SSP's AddGhost, flag 8 [disasm
  // 0x465C40]; EV §2.7.5)
  assert.deepEqual(eng(w, 'x').find('otherghostname').map(r => r.refs), [[], [], [ref('y')]], 'X re-NOTIFYed after its and Y\'s boot GET');
  assert.deepEqual(eng(w, 'y').find('otherghostname').map(r => r.refs), [[ref('x')], [ref('x')]]);
  for (const id of ['x', 'y']) assert.ok(!events(eng(w, id), OTHER).length && !eng(w, id).find('OnGhostCalled').length);
  invariants(next, w);
});

test('Quit from a menu popupmenu.type redirected (X\'s \\1 showing the main menu): every ghost gets R1 0, R2 1 [disasm 2.9.10 0x41d4ca]', async () => {
  const w = world();
  w.saves.set('x', {});
  w.saves.set('y', {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  x.parts.menu._run({ type: 'quit' }, 0, 1);             // the menu's character 0, the clicked one 1
  await settle();
  for (const id of ['x', 'y']) {
    assert.deepEqual(eng(w, id).find('OnCloseAll').map(r => r.refs), [['user', 0, 1]], id);
    assert.deepEqual(eng(w, id).find('OnClose').map(r => r.refs), [['user', 0, 1]], `${id}: 204 -> OnClose`);
  }
  x.player.finish();
  quitRun(y);
  await until(() => site.slots.length === 1);
  assert.equal(site.quitting, false);
  invariants(site, w);
  site.done();
  await settle();
});

test('Close and Quit do nothing while a call is under way; a Quit during a Close upgrades it without a new event', async () => {
  const w = world();
  w.saves.set('y', {});
  const site = await up(w);
  const x = site.slots[0];
  let release;
  w.hold.y = new Promise(r => { release = r; });
  x.parts.menu._run({ type: 'callghost', id: 'y' }, 0);
  await settle();
  x.player.finish();                                      // its OnGhostCalling talk
  assert.equal(site._jobs, 1);
  await loopOf(x).close(0);
  loopOf(x).quitAll(0);
  assert.equal(await site.quit(0), false);
  await settle();
  assert.ok(!eng(w, 'x').find('OnClose').length && !eng(w, 'x').find('OnCloseAll').length, 'SSP beeps [disasm OnMenuClose]');
  release();
  delete w.hold.y;
  await idle(site);
  const y = site.find('y');
  y.player.finish();
  await settle();

  await loopOf(y).close(0);                               // Close of one: OnClose only ...
  assert.equal(loopOf(y).closing, 'one');
  site.quit(0);                                           // ... then Quit
  await settle();
  assert.equal(loopOf(y).closing, 'all', 'upgraded');
  assert.deepEqual(events(eng(w, 'y'), /OnClose(All)?$/), ['GET OnClose'], 'no new event for Y');
  assert.deepEqual(events(eng(w, 'x'), /OnClose(All)?$/), ['GET OnCloseAll', 'GET OnClose']);
  y.player.finish();                                      // Y's goodbye without \- closes it now
  x.player.finish();
  await until(() => site.slots.length === 1 && site.slots[0]._launcherMode === 'closed');
  assert.ok(!events(eng(w, 'x'), OTHER).some(e => /Closed/.test(e)));
  invariants(site, w);
});

// ---------------------------------------------------------------- 9: Change ghost ▸ with a bystander

/** A ghost change in rt's slot, its farewell played to its end. */
async function changeIn(rt, id) {
  const leaving = rt.loop;
  const p = rt.changeGhost(id);
  await until(() => leaving.current && leaving.current.event === 'OnGhostChanging');
  if (rt.player.busy) rt.player.finish();
  return p;
}

test('change in X\'s slot with Y on screen: Y greyed and skipped; Z takes X\'s slot and layer; Y re-NOTIFYed, then OnOtherGhostChanged after Z\'s boot run', async () => {
  const w = world();
  w.saves.set('z', {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  assert.equal(site.ghostList(x).find(r => r.id === 'y').elsewhere, true);
  assert.equal(await x.loop.change('ghost', ['Ghost Y']), undefined);
  await idle(site);
  assert.ok(!eng(w, 'x').find('OnGhostChanging').length, '\\![change,ghost,<on screen>] is ignored');
  assert.equal(await x.changeGhost('y'), false, 'the page API too');
  assert.deepEqual(ids(site), ['x', 'y']);

  const ey = eng(w, 'y');
  w.order.length = 0;
  const sid = x.sid;
  assert.equal(await changeIn(x, 'z'), true);
  assert.equal(site.slots[0], x, 'the same Runtime ...');
  assert.equal(x.ghost.id, 'z');
  assert.equal(x.sid, sid, '... and layer');
  assert.deepEqual(site.layers.order().includes(sid), true);
  assert.deepEqual(ids(site), ['z', 'y']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['z', 'y']);
  const ez = eng(w, 'z');
  assert.deepEqual(ez.find('otherghostname')[0].refs, [ref('y')]);
  assert.deepEqual(ey.find('otherghostname').at(-1).refs, [ref('z')], 'Y told of Z');
  assert.ok(w.order.indexOf('y NOTIFY otherghostname') > w.order.indexOf('z GET OnGhostChanged'), 'after Z\'s boot GET');
  assert.deepEqual(events(ez, BOOT), ['GET OnGhostChanged']);
  assert.ok(!ey.find('OnOtherGhostChanged').length, 'not before Z\'s boot run ends');
  assert.deepEqual(sessionMarker.read().carry.z.of, 'change');
  x.player.finish();
  await settle();
  const ch = ey.find('OnOtherGhostChanged');
  assert.equal(ch.length, 1);
  assert.equal(ch[0].refs.length, 16);
  assert.deepEqual(ch[0].refs, ['Xs', 'Zs', '\\0x: bye, Zs\\e', '\\0z: from Xs\\e', 'Ghost X', 'Ghost Z', U, U, U, U, U, U, U, U, 'x-shell', 'z-shell']);
  assert.equal(sessionMarker.read().carry, undefined);
  assert.ok(w.posts.some(m => m.cause && m.cause.kind === 'change' && m.cause.from === 'x' && m.cause.to === 'z'));
  invariants(site, w);

  // W fails to start: Z comes back in the same slot, Y hears nothing
  w.failEngine = id => id === 'w';
  assert.equal(await changeIn(x, 'w'), false);
  await settle();
  assert.equal(site.slots[0], x);
  assert.deepEqual(ids(site), ['z', 'y']);
  assert.equal(ey.find('OnOtherGhostChanged').length, 1);
  assert.deepEqual(runtimePrefs.get().ghosts, ['z', 'y']);
  invariants(site, w);
});

test('\\![reload,ghost] in X with Y on screen (EV §2.10): X reloads in its slot without a boot event; X and Y NOTIFY otherghostname again; Y gets no OnOther* event; X comes on top', async () => {
  const w = world();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  const ex = eng(w, 'x');
  const ey = eng(w, 'y');
  site._raise(y);
  assert.equal(site.layers.top, y.sid);
  const told = ey.find('otherghostname').length;
  assert.equal(x.loop.reload('ghost'), undefined);
  assert.equal(await x._changing, true);
  await idle(site);
  const ex2 = eng(w, 'x');
  assert.notEqual(ex2, ex, 'a new engine');
  assert.equal(ex.unloaded, true);
  assert.deepEqual(ex.find('OnDestroy').map(r => r.refs), [['']]);
  assert.deepEqual(events(ex, /On(GhostChanging|Close)$/), [], 'no goodbye');
  assert.deepEqual(events(ex2, BOOT), [], 'no boot event (AddGhost flag 2)');
  // AddGhost's UpdateFileMapping(flag 8) [disasm 0x466cbf]: every ghost is told again, the reloaded one too
  assert.ok(ey.find('otherghostname').length > told);
  assert.deepEqual(ey.find('otherghostname').at(-1).refs, [ref('x')]);
  assert.deepEqual(ex2.find('otherghostname').at(-1).refs, [ref('y')]);
  assert.deepEqual([ids(site), site.slots[0]], [['x', 'y'], x], 'the same slot');
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y']);
  assert.equal(sessionMarker.read().carry, undefined, 'nothing owed');
  assert.equal(site.layers.top, x.sid, 'AddGhost activates it [disasm 0x466dc7]');
  await settle();
  // the 0x3E handler skips a ghost whose previous id is its own [disasm 0x49a7b8]; OnOtherGhostClosed is the close's
  assert.deepEqual(events(ey, OTHER), []);
  invariants(site, w);
});

test('placement as ssp.exe (UI §3.2, §3.5): a callee never met stands at its own default place, on the caller (emily4 after Tsubasa); met before, by call, change or a set\'s start, it stands where it stood', async () => {
  const w = world();
  // Tsubasa-like X (220×380, a 4×4 \1), emily4-like Y (Emily 253×385, Teddy 255×161), a third Z; a 1920×1040 desk
  w.shells = {
    x: { 0: [220, 380], 10: [4, 4] }, y: { 0: [253, 385], 10: [255, 161] }, z: { 0: [300, 400], 10: [100, 100] },
  };
  w.desk = { w: 1920, h: 1040 };
  const site = await up(w);
  const at = (rt, s) => { const r = rt.parts.stage.char(s).rect; return [r.x, r.y, r.width, r.height].map(Math.round); };
  const x = site.slots[0];
  assert.deepEqual(at(x, 0), [1700, 660, 220, 380], 'X at her default place');
  assert.deepEqual(at(x, 1), [1696, 1036, 4, 4]);

  // Y never met, called: her own default place, read from nothing of X's, so she stands on X (and X stays)
  await menuCall(site, x, 'y');
  const y = site.find('y');
  assert.deepEqual(events(eng(w, 'y'), BOOT), ['GET OnFirstBoot']);
  assert.deepEqual(at(y, 0), [1667, 655, 253, 385], 'Emily over X');
  assert.deepEqual(at(y, 1), [1412, 879, 255, 161], 'Teddy flush against Emily, no balloon gap');
  assert.deepEqual(at(x, 0), [1700, 660, 220, 380]);
  y.player.finish();
  await settle();
  invariants(site, w);

  // Y dragged away and closed; called again: where she stood (her own stored place), X's place does not matter
  y.parts.stage.char(0).moveTo(426.5, 1040);
  y.parts.stage.char(1).moveTo(800.5, 1040);
  x.parts.stage.char(0).moveTo(300, 1040);
  await loopOf(y).close(0);
  quitRun(y);
  await until(() => site.slots.length === 1);
  await menuCall(site, x, 'y');
  const y2 = site.find('y');
  assert.deepEqual(events(eng(w, 'y'), BOOT), ['GET OnGhostCalled']);
  assert.deepEqual([at(y2, 0)[0], at(y2, 1)[0]], [300, 673], 'each scope at its stored place');
  y2.player.finish();
  await settle();

  // a change in X's slot to Z, never met: Z at its own default place, not where X stood (no hand-over)
  assert.equal(await changeIn(x, 'z'), true);
  assert.equal(x.ghost.id, 'z');
  assert.deepEqual(at(x, 0), [1620, 640, 300, 400]);
  assert.deepEqual(at(x, 1), [1520, 940, 100, 100]);
  x.player.finish();
  await settle();
  invariants(site, w);

  // a new tab starts the set cold, one ghost at a time: each at its own stored place
  x.parts.stage.char(0).moveTo(1000, 1040);
  site._onPageHide();
  site.done();
  await settle();
  globalThis.sessionStorage = memoryStorage();
  const tab = await up(w);
  assert.deepEqual(ids(tab), ['z', 'y']);
  assert.deepEqual([eng(w, 'z').resume, eng(w, 'y').resume], [false, false]);
  const [z3, y3] = tab.slots;
  assert.deepEqual([at(z3, 0)[0], at(z3, 1)[0]], [850, 1520]);
  assert.deepEqual([at(y3, 0)[0], at(y3, 1)[0]], [300, 673]);
  invariants(tab, w);
});

// ---------------------------------------------------------------- 10–11: pages

test('next page: X and Y resume in parallel, each batch lists the other; a new tab cold-boots X, then Y, X re-NOTIFYed', async () => {
  const w = world();
  w.saves.set('y', {});
  const site = await up(w);
  await menuCall(site, site.slots[0], 'y');
  site.find('y').player.finish();
  await settle();
  site._onPageHide();
  site.done();
  await settle();

  w.order.length = 0;
  const next = await up(w);
  assert.deepEqual(ids(next), ['x', 'y']);
  const [ex, ey] = [eng(w, 'x'), eng(w, 'y')];
  assert.deepEqual([ex.resume, ey.resume], [true, true]);
  assert.ok(!events(ex, BOOT).length && !events(ey, BOOT).length && !events(ex, OTHER).length);
  assert.ok(w.order.indexOf('y GET version') < w.order.indexOf('x NOTIFY OnInitialize'), 'in parallel: Y\'s engine is up before X\'s batch');
  assert.ok(ex.find('otherghostname')[0].refs[0].startsWith('Ys\x01'));
  assert.ok(ey.find('otherghostname')[0].refs[0].startsWith('Xs\x01'));
  assert.equal(ex.find('otherghostname').length, 1, 'no re-NOTIFY for a resumed ghost');
  invariants(next, w);
  next._onPageHide();
  next.done();
  await settle();

  globalThis.sessionStorage = memoryStorage();           // a new tab
  w.order.length = 0;
  const tab = await up(w);
  const [cx, cy] = [eng(w, 'x'), eng(w, 'y')];
  assert.deepEqual([cx.resume, cy.resume], [false, false]);
  assert.deepEqual(cx.find('otherghostname').map(r => r.refs), [[], [], [ref('y')]]);
  assert.deepEqual(cy.find('otherghostname').map(r => r.refs), [[ref('x')], [ref('x')]]);
  assert.deepEqual([events(cx, BOOT), events(cy, BOOT)], [['GET OnBoot'], ['GET OnBoot']]);
  assert.ok(w.order.indexOf('x GET OnBoot') < w.order.indexOf('y NOTIFY OnInitialize'), 'one at a time');
  assert.ok(!events(cx, OTHER).length && !events(cy, OTHER).length, 'a restored set has no caller');
  invariants(tab, w);
});

test('carries: a page left before the callee booted cold-boots it with OnGhostCalled; left during its boot talk: OnGhostCallComplete after the replay', async () => {
  let w = world();
  w.saves.set('y', {});
  let site = await up(w);
  let x = site.slots[0];
  w.hold.y = deferred().promise;                          // Y's engine still loading when the page goes
  x.parts.menu._run({ type: 'callghost', id: 'y' }, 0);
  await until(() => site.find('y'));
  await settle();
  assert.deepEqual(sessionMarker.read().carry.y.kind, 'call');
  site._onPageHide();
  site.done();
  await settle();
  delete w.hold.y;
  let next = await up(w);
  assert.deepEqual(ids(next), ['x', 'y']);
  assert.equal(eng(w, 'x').resume, true);
  const called = eng(w, 'y').find('OnGhostCalled');
  assert.deepEqual(called.map(r => r.refs.slice(0, 4)), [['Xs', '\\0x: calling Ys\\e', 'Ghost X', '/ghost/x/']]);
  await settle();
  assert.deepEqual(eng(w, 'x').find('OnGhostCallComplete').map(r => r.refs[1]), ['\\0y: called by Xs\\e'], 'after Y\'s boot run');
  invariants(next, w);
  next.done();

  // left during the callee's boot talk: it resumes (its run replays) and the caller is told when that run ends
  w = world();
  w.saves.set('y', {});
  site = await up(w);
  x = site.slots[0];
  await menuCall(site, x, 'y');
  x.player.finish();
  assert.ok(site.find('y').player.busy, 'Y\'s boot talk plays');
  site._onPageHide();
  site.done();
  await settle();
  next = new TestSite(w);
  assert.equal(await next.start(), 'booted');
  const y = next.find('y');
  assert.equal(eng(w, 'y').resume, true);
  assert.equal(y.player.replays.length, 1);
  await settle();
  assert.ok(!eng(w, 'x').find('OnGhostCallComplete').length, 'not before the replayed run ends');
  y.player.finish();
  await settle();
  assert.deepEqual(eng(w, 'x').find('OnGhostCallComplete').map(r => r.refs[1]), ['\\0y: called by Xs\\e']);
  assert.equal(sessionMarker.read().carry, undefined);
  invariants(next, w);
  next.done();

  // a ghost closed while the other stayed, whose page went before the set was stored without it: dropped
  w = world();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 3 });
  localStorage.setItem(stateKey('y'), JSON.stringify({ v: 1, closed: true }));
  site = await up(w);
  assert.deepEqual(ids(site), ['x']);
  assert.deepEqual(w.engines.map(e => e.ghost), ['x']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x']);
  invariants(site, w);
});

// ---------------------------------------------------------------- 12–14: tabs and the lead lock

test('tabs: B shows the set frozen; A hidden + B visible: B takes the lead and both ghosts; A made visible while it yields: no split', async () => {
  const w = world();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const a = await up(w);
  invariants(a, w);
  const b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  assert.deepEqual(ids(b), ['x', 'y']);
  assert.ok(b.slots.every(rt => rt.frozen && !rt.parts));
  assert.ok(!b.lead.held);
  invariants(b, w);
  w.persistGate = { id: 'x', ...deferred() };             // A's yield takes a moment
  a.doc.hidden = true;
  b.show(true);
  await until(() => a._yielding);
  a.show(true);                                           // the visitor comes back to A meanwhile
  await settle();
  w.persistGate.resolve();
  await until(() => b.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await settle(20);
  assert.ok(b.lead.held && w.locks.held.has('sumika:x') && w.locks.held.has('sumika:y'));
  assert.ok(a.slots.every(rt => rt.frozen && !rt.parts), 'A shows both frozen');
  assert.ok(!a.lead.held);
  assert.deepEqual(live(w), ['x', 'y'], 'one engine per ghost');
  assert.deepEqual(b.slots.map(rt => eng(w, rt.ghost.id).resume), [true, true], 'taken over: resumed');
  invariants(a, w);
  invariants(b, w);
});

test('tabs: a takeover asked during a call is answered after it, and takes the callee too', async () => {
  const w = world();
  w.saves.set('y', {});
  const a = await up(w);
  const b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  let release;
  w.hold.y = new Promise(r => { release = r; });
  a.slots[0].parts.menu._run({ type: 'callghost', id: 'y' }, 0);
  await until(() => a.find('y'));
  a.slots[0].player.finish();
  a.doc.hidden = true;
  b.show(true);
  await settle(10);
  assert.ok(a.lead.held && a._leadAsked, 'asked, not yet');
  assert.ok(loopOf(a.slots[0]), 'A still runs X');
  await until(() => b.find('y'));
  assert.deepEqual(ids(b), ['x', 'y'], 'B heard of the call: Y frozen there');
  release();
  delete w.hold.y;
  await until(() => b.slots.length === 2 && b.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await settle(20);
  assert.ok(b.lead.held);
  assert.deepEqual(live(w), ['x', 'y']);
  assert.ok(a.slots.every(rt => !rt.parts));
  invariants(a, w);
  invariants(b, w);
});

test('tabs: B follows A\'s set frozen: a call adds, a Close removes, a change replaces in place; a stale rev is ignored', async () => {
  const w = world();
  for (const id of ['y', 'z', 'w']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const a = await up(w);
  const b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  await menuCall(a, a.slots[0], 'z');
  await until(() => b.slots.length === 3);
  assert.deepEqual(ids(b), ['x', 'y', 'z']);
  assert.ok(b.find('z').frozen, 'Z added frozen');
  a.find('z').player.finish();
  a.slots[0].player.finish();
  await settle();

  const y = a.find('y');
  await loopOf(y).close(0);
  quitRun(y);
  await until(() => b.slots.length === 2);
  assert.deepEqual(ids(b), ['x', 'z']);

  assert.equal(await changeIn(a.slots[0], 'w'), true);
  await until(() => b.slots[0].ghost.id === 'w' && b.slots[0].frozen);
  assert.deepEqual(ids(b), ['w', 'z']);
  assert.ok(!b.slots.some(rt => rt.parts), 'never an engine there');

  const rev = b.rev;
  a._post({ t: 'set', ghosts: ['x'], rev: rev - 1, cause: { kind: 'sync' } });
  await settle(10);
  assert.deepEqual(ids(b), ['w', 'z'], 'stale');
  invariants(b, w);
  invariants(a, w);
});

test('one ghost on the lead path: takeover when hidden; a takeover asked during a change waits for it; the new ghost runs in the asking tab; the P7 clock goes with it', async () => {
  const T0 = new Date(2026, 9, 7, 9, 0, 0).getTime();
  const real = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const w = world();
    w.saves.set('w', {});
    const a = await up(w, { maxGhosts: 1 });
    assert.equal(a.callList(), null);
    now = T0 + 600e3;
    const b = new TestSite(w, { hidden: true, maxGhosts: 1 });
    assert.equal(await b.start(), 'frozen');
    now = T0 + 1200e3;
    a.doc.hidden = true;
    b.show(true);
    await until(() => loopOf(b.slots[0]) && loopOf(b.slots[0]).booted);
    await settle(10);
    assert.deepEqual([eng(w, 'x').resume, eng(w, 'x').bootEpochMs], [true, T0], 'the clock A started at 09:00');
    assert.ok(a.slots[0].frozen && !a.slots[0].parts);
    invariants(a, w);
    invariants(b, w);

    // B (running now, visible) changes to W; A asks for the set mid-farewell; B is hidden: it yields after the change
    const p = b.slots[0].changeGhost('w');
    await until(() => b.slots[0].loop && b.slots[0].loop.current && b.slots[0].loop.current.event === 'OnGhostChanging');
    b.doc.hidden = true;
    a.show(true);
    await settle(10);
    assert.equal(b.slots[0].loop.current.event, 'OnGhostChanging', 'the goodbye goes on');
    assert.ok(b.lead.held);
    b.slots[0].player.finish();
    assert.equal(await p, true);
    await until(() => loopOf(a.slots[0]) && loopOf(a.slots[0]).booted);
    await settle(20);
    assert.equal(a.slots[0].ghost.id, 'w', 'the tab that asked runs the new ghost');
    assert.equal(eng(w, 'w').resume, true, 'taken over, not booted again');
    assert.deepEqual(live(w), ['w']);
    assert.ok(w.locks.held.has('sumika:w') && !w.locks.held.has('sumika:x'));
    assert.ok(b.slots[0].frozen);
    invariants(a, w);
    invariants(b, w);
  } finally {
    Date.now = real;
  }
});

test('the end of a ghost\'s last session (Kawari\'s D6, kawari-wasm.md §8): a cold boot passes its state\'s savedAt as the closed tab left it, not its own write; a resume and a ghost never stored pass 0', async () => {
  const T0 = new Date(2026, 9, 7, 9, 0, 0).getTime();
  const real = Date.now;
  let now = T0;
  Date.now = () => now;
  const endOf = id => [eng(w, id).resume, eng(w, id).sessionEndMs];
  let w;
  try {
    w = world();
    w.saves.set('y', {});
    const site = await up(w);
    assert.deepEqual(endOf('x'), [false, 0], 'never stored');
    now = T0 + 300e3;
    await menuCall(site, site.slots[0], 'y');
    site.find('y').player.finish();
    await settle();
    assert.deepEqual(endOf('y'), [false, 0], 'met (its engine has a save), but no state stored');
    now = T0 + 600e3;
    site._onPageHide();                                     // a link followed
    site.done();
    await settle();

    now = T0 + 900e3;
    const next = await up(w);
    assert.deepEqual([...endOf('x'), ...endOf('y')], [true, 0, true, 0], 'a resume closes nothing');
    now = T0 + 1200e3;
    next._onPageHide();                                     // the tab closes
    next.done();
    await settle();

    globalThis.sessionStorage = memoryStorage();           // a new tab, the next day
    now = T0 + 86400e3;
    const tab = await up(w);
    assert.deepEqual(ids(tab), ['x', 'y']);
    assert.deepEqual([...endOf('x'), ...endOf('y')], [false, T0 + 1200e3, false, T0 + 1200e3],
      'each ghost\'s state as the closed tab left it (pagehide), not this cold boot\'s own write');
    assert.ok(JSON.parse(localStorage.getItem(stateKey('x'))).savedAt >= T0 + 86400e3, 'that write came after');
    invariants(tab, w);
  } finally {
    Date.now = real;
  }
});

// ---------------------------------------------------------------- 15–19: keys, drops, crashes, the dock, OnOtherGhostTalk

test('keys: a press on Y takes them from X; only Y\'s OnKeyPress; Escape: nobody; a callee gets them only from an active caller', async () => {
  const w = world();
  for (const id of ['y', 'z']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  x.parts.stage.emit('mouse', { scope: 0, type: 'down', x: 1, y: 1, button: 0 });
  assert.deepEqual([loopOf(x).active, loopOf(y).active], [true, false]);
  y.parts.stage.emit('mouse', { scope: 0, type: 'down', x: 1, y: 1, button: 0 });
  assert.deepEqual([loopOf(x).active, loopOf(y).active], [false, true]);
  assert.equal(site.active, y);
  assert.equal(site.preferred(), y);
  assert.equal(site.layers.top, y.sid, 'the pressed ghost comes on top');
  invariants(site, w);
  for (const rt of [x, y]) loopOf(rt)._onKeyDown(keyEvent('KeyA', 'a'));
  assert.deepEqual([eng(w, 'x').find('OnKeyPress').length, eng(w, 'y').find('OnKeyPress').length], [0, 1]);
  loopOf(y)._onKeyDown(keyEvent('Escape', 'Escape'));
  assert.deepEqual([loopOf(x).active, loopOf(y).active], [false, false]);
  assert.equal(site.preferred(), x, 'nobody has the keys: the first');

  await menuCall(site, x, 'z');                            // X does not have the keys
  assert.equal(loopOf(site.find('z')).active, false);
  site.find('z').player.finish();
  x.player.finish();
  await settle();
  await loopOf(site.find('z')).close(0);
  quitRun(site.find('z'));
  await until(() => site.slots.length === 2);
  x.parts.stage.emit('mouse', { scope: 0, type: 'down', x: 1, y: 1, button: 0 });
  await menuCall(site, x, 'z');                            // now it does
  assert.deepEqual(site.slots.map(rt => loopOf(rt).active), [false, false, true]);
  assert.equal(site.preferred(), site.find('z'));
  invariants(site, w);
});

test('drops: a drop on Y while it loads reaches Y, not X; a drop on a frozen ghost takes the whole set over and reaches it', async () => {
  const w = world();
  w.saves.set('y', {});
  const site = await up(w);
  const x = site.slots[0];
  let release;
  w.hold.y = new Promise(r => { release = r; });
  x.parts.menu._run({ type: 'callghost', id: 'y' }, 0);
  await until(() => site.find('y') && site.find('y').parts && site.find('y').parts.stage);
  site.find('y').parts.stage.emit('drop', drop());
  release();
  delete w.hold.y;
  await idle(site);
  assert.equal(eng(w, 'y').find('OnFileDrop2').length, 1);
  assert.equal(eng(w, 'x').find('OnFileDrop2').length, 0);
  site.find('y').player.finish();
  x.player.finish();
  await settle();

  const b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  site.doc.hidden = true;                                 // the visitor drags from the desktop onto tab B's window:
  b.doc.hidden = false;                                   // no focus, no visibility change
  b.find('y').frozen.emit('drop', drop());
  await until(() => b.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await settle(20);
  assert.ok(b.lead.held);
  assert.deepEqual(live(w), ['x', 'y']);
  assert.equal(eng(w, 'y').find('OnFileDrop2').length, 1, 'delivered to Y in tab B');
  assert.equal(eng(w, 'x').find('OnFileDrop2').length, 0);
  invariants(b, w);
});

test('a crash restarts only that ghost\'s engine; each engine\'s SAORI messages reach its own ghost', async () => {
  const w = world();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  const n = w.engines.length;
  await y._onCrash();
  assert.deepEqual(w.engines.slice(n).map(e => [e.ghost, e.resume]), [['y', true]]);
  assert.equal(loopOf(y).shiori, eng(w, 'y'));
  assert.equal(loopOf(x).shiori, w.engines.find(e => e.ghost === 'x'));
  const got = [];
  for (const rt of [x, y]) rt.parts.pageSaori.handle = m => got.push([rt.ghost.id, m.t]);
  x._client().hooks.onSaori({ t: 'a' });
  y._client().hooks.onSaori({ t: 'b' });
  assert.deepEqual(got, [['x', 'a'], ['y', 'b']]);
  invariants(site, w);
});

test('Iconify: only that ghost hides, its launcher in the dock by set order; restoring it moves the others\' down', async () => {
  const w = world();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  const fakeLauncher = () => ({ slot: -1, setSlot(i) { this.slot = i; }, hide() {}, show() {}, destroy() {} });
  x.launcher = fakeLauncher();
  y.launcher = fakeLauncher();
  await loopOf(y).minimize();
  assert.deepEqual([y._launcherMode, y.launcher.slot], ['minimized', 0]);
  assert.equal(loopOf(x).minimized, null, 'X stays');
  await loopOf(x).minimize();
  assert.deepEqual([x.launcher.slot, y.launcher.slot], [0, 1], 'stacked upward in set order');
  x._launch('minimized');
  await settle();
  assert.equal(loopOf(x).minimized, null);
  assert.equal(x._launcherMode, null);
  assert.equal(y.launcher.slot, 0, 'Y\'s button moved down');
  assert.equal(site.layers.top, x.sid, 'restored: on top');
  assert.ok(eng(w, 'x').find('OnWindowStateRestore').length === 1 && !eng(w, 'y').find('OnWindowStateRestore').length);
  invariants(site, w);
});

test('OnOtherGhostTalk: after / break / before to the ghost that asked; its own reply is told after, never before; the flag survives a page change', async () => {
  const w = world({ answer: (id, r, mem) => (r.id === 'OnOtherGhostTalk' ? `\\0${id}: heard ${r.refs[0]}\\e` : defaultAnswer(id, r, mem)) });
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  const ex = eng(w, 'x');
  const ey = eng(w, 'y');
  loopOf(x).setOption('otherghosttalk', ['true']);
  loopOf(y).setOption('otherghosttalk', ['before,after']);
  y.loop.playScript('\\0Hello there.\\e', { event: 'OnTalk', refs: ['a', 'b'] });
  assert.ok(!ex.find('OnOtherGhostTalk').length, 'X asked only after');
  y.player.finish();
  await settle();
  assert.deepEqual(ex.find('OnOtherGhostTalk').map(r => r.refs), [['Ghost Y', 'Ys', '', 'OnTalk', '\\0Hello there.\\e', 'a\x01b']]);
  assert.equal(ex.find('OnOtherGhostTalk')[0].headers.SenderType, 'internal');
  assert.equal(x.player.last.script, '\\0x: heard Ghost Y\\e', 'X plays its reply');
  assert.ok(!ey.find('OnOtherGhostTalk').length, 'a reply to OnOtherGhostTalk is not told before it plays (SSP\'s guard)');
  x.player.finish();
  await settle();
  // ... but after it, as every run [disasm 0x6397A2, 0x63992F]: two ghosts that answer each other chat on (EV §2.7.4)
  assert.deepEqual(ey.find('OnOtherGhostTalk').map(r => r.refs), [
    ['Ghost X', 'Xs', '', 'OnOtherGhostTalk', '\\0x: heard Ghost Y\\e', 'Ghost Y\x01Ys\x01\x01OnTalk\x01\\0Hello there.\\e\x01a\x01b'],
  ]);
  assert.equal(y.player.last.script, '\\0y: heard Ghost X\\e');
  y.player.finish();
  await settle();
  assert.deepEqual(ex.find('OnOtherGhostTalk').map(r => r.refs[3]), ['OnTalk', 'OnOtherGhostTalk'], 'one turn per script');
  loopOf(y).setOption('otherghosttalk', ['false']);       // Y stops listening: X's turn is the last
  x.player.finish();
  await settle();
  assert.equal(ey.find('OnOtherGhostTalk').length, 1);

  y.loop.playScript('\\0Cut short\\e', { event: 'OnTalk' });
  y.player.interrupt();
  await settle();
  assert.equal(ex.find('OnOtherGhostTalk').at(-1).refs[2], 'break');
  x.player.finish();
  await settle();
  loopOf(x).setOption('otherghosttalk', ['before']);
  const n = ex.find('OnOtherGhostTalk').length;
  y.loop.playScript('\\0Again\\e', { event: 'OnTalk' });
  assert.equal(ex.find('OnOtherGhostTalk').length, n + 1, 'before it plays');
  assert.equal(ex.find('OnOtherGhostTalk').at(-1).refs[2], '');
  y.player.finish();
  x.player.finish();
  await settle();
  assert.deepEqual(loopOf(x).otherGhostTalk, { before: true, after: true });
  site._onPageHide();
  site.done();
  await settle();

  const next = await up(w);
  assert.deepEqual(loopOf(next.find('x')).otherGhostTalk, { before: true, after: true }, 'kept in ghostLife across pages');
  const nx = eng(w, 'x');
  assert.ok(!nx.find('OnOtherGhostTalk').length, 'a replay is not reported');
  invariants(next, w);
});

// ---------------------------------------------------------------- 20–29: races, pages and tabs around Close, Quit and the page API

/** Quit from the first ghost's menu, every goodbye played to its end: the closed launcher. */
async function quitAll(site) {
  site.slots[0].parts.menu._run({ type: 'quit' }, 0);
  await settle();
  for (const rt of site.slots) if (rt.player && rt.player.busy) rt.player.finish();
  await until(() => site.slots.length === 1 && site.slots[0]._launcherMode === 'closed');
}

test('Quit: ghosts that close at once (204, or minimized) each finish their own unload and save; the last one closes the site', async () => {
  for (const how of ['silent', 'minimized']) {
    const w = world({ answer: (id, r, mem) => (how === 'silent' && /^OnClose(All)?$/.test(r.id) ? null : defaultAnswer(id, r, mem)) });
    for (const id of ['x', 'y']) w.saves.set(id, {});
    runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
    const site = await up(w);
    const [x, y] = site.slots;
    if (how === 'minimized') for (const rt of [x, y]) await loopOf(rt).minimize();
    const ey = eng(w, 'y');
    const gate = deferred();
    const unload = ey.unload;
    let cut = null;
    ey.unload = async () => { await gate.promise; cut = !!ey.terminated; return unload(); };
    const q = site.quit(0);
    await until(() => !x.parts);
    await settle(5);
    assert.deepEqual(ids(site), ['x', 'y'], `${how}: Y still unloads, its slot stays`);
    assert.ok(!ey.terminated, `${how}: Y is not torn down mid-unload`);
    assert.equal(site.quitting, true);
    assert.equal(x._launcherMode, null, `${how}: no restore button left for a ghost that closed`);
    gate.resolve();
    assert.equal(await q, true);
    await until(() => site.slots.length === 1 && site.slots[0]._launcherMode === 'closed');
    assert.equal(cut, false, `${how}: its engine lived until the unload had saved`);
    assert.ok(ey.unloaded);
    // minimized too: OnCloseAll / OnClose are sent, the reply dropped (no OnTranslate of it) [disasm CloseGhostProc 0x4969ef]
    for (const id of ['x', 'y']) {
      assert.deepEqual(events(eng(w, id), /OnClose(All)?$/), ['GET OnCloseAll', 'GET OnClose'], `${how}: ${id}`);
      assert.ok(!eng(w, id).find('OnTranslate').some(r => /^OnClose/.test(r.refs[2])), `${how}: ${id}'s reply not translated`);
    }
    for (const id of ['x', 'y']) assert.equal(JSON.parse(localStorage.getItem(stateKey(id))).closed, true, `${how}: ${id} stored closed`);
    assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y'], 'Quit keeps the set');
    assert.equal(site.quitting, false);
    assert.ok(!events(eng(w, 'x'), OTHER).length && !events(ey, OTHER).length, 'no OnOtherGhostClosed');
    invariants(site, w);
    site.done();
    await settle();
    const next = new TestSite(w);
    assert.equal(await next.start(), 'launcher', `${how}: the next page shows the closed launcher, not Y alone`);
    assert.deepEqual(ids(next), ['x']);
    invariants(next, w);
    next.done();
  }
});

test('Quit with a minimized ghost: its restore button goes as it closes; a click on it still on its way boots nothing; nothing is stuck after', async () => {
  const w = world();
  for (const id of ['x', 'y', 'z']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const [x, y] = site.slots;
  await loopOf(y).minimize();
  assert.equal(y._launcherMode, 'minimized');
  x.parts.menu._run({ type: 'quit' }, 0);
  await until(() => !y.parts);
  assert.equal(y._launcherMode, null, 'no "Show Y" left in the dock while X says goodbye');
  assert.deepEqual(events(eng(w, 'y'), /OnClose(All)?$/), ['GET OnCloseAll', 'GET OnClose'], 'Y was asked, its reply dropped');
  const n = w.engines.length;
  y._launch('minimized');
  assert.equal(await site._relaunch(y), 'none', 'nothing is called back during Quit');
  await settle(10);
  assert.equal(w.engines.length, n, 'Y does not boot mid-Quit');
  x.player.finish();
  await until(() => site.slots.length === 1 && site.slots[0]._launcherMode === 'closed');
  assert.equal(site.quitting, false);
  invariants(site, w);
  site.slots[0]._launch('closed');                        // the closed launcher calls the whole set back
  await until(() => site.slots.length === 2 && site.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await idle(site);
  for (const rt of site.slots) if (rt.player.busy) rt.player.finish();
  await settle();
  assert.equal(await site.quit(0), true, 'Quit works again');
  assert.deepEqual(site.slots.map(rt => loopOf(rt).closing), ['all', 'all']);
});

test('Close of a minimized Y while X stays (the page API): GET OnClose only, its reply dropped, Y closes at once; X gets OnOtherGhostClosed with Y\'s last script [disasm 0x4969ef, 0x46bcc2]', async () => {
  const w = world();
  for (const id of ['x', 'y']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  const y = site.slots[1];
  await loopOf(y).minimize();
  const last = loopOf(y).lastScript;
  assert.ok(last, 'Y played something before');
  const ey = eng(w, 'y');
  assert.equal(await site.closeGhost('y'), true);
  await until(() => !y.parts);
  await settle();
  assert.deepEqual(events(ey, /OnClose(All)?$/), ['GET OnClose']);
  assert.ok(!ey.find('OnTranslate').some(r => /^OnClose/.test(r.refs[2])), 'its reply was not translated');
  assert.deepEqual(ids(site), ['x']);
  const other = eng(w, 'x').find('OnOtherGhostClosed');
  assert.equal(other.length, 1);
  assert.equal(other[0].refs[1], last, 'R1: its last script (SPGhost+0x1884), not the dropped reply');
  invariants(site, w);
});

test('a page left during Quit\'s goodbyes: the next page goes on with the Quit (the set stays whole, no OnOtherGhostClosed); a bfcache round trip too', async () => {
  for (const timing of ['x closed', 'both talking']) {
    const w = world();
    for (const id of ['x', 'y', 'z']) w.saves.set(id, {});
    runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
    const site = await up(w);
    const x = site.slots[0];
    x.parts.menu._run({ type: 'quit' }, 0);
    await settle();
    if (timing === 'x closed') { x.player.finish(); await until(() => !x.parts); }
    assert.equal(sessionMarker.read().quit, true, 'the tab marker says a Quit is under way');
    site._onPageHide();
    site.done();
    await settle();

    const next = new TestSite(w);
    assert.equal(await next.start(), 'booted');
    await settle();
    assert.deepEqual(ids(next), ['x', 'y'], `${timing}: the set stays whole`);
    assert.equal(next.quitting, true);
    const [nx, ny] = next.slots;
    assert.equal(!!nx.parts, timing === 'both talking', `${timing}: a ghost closed in that Quit is not booted again`);
    for (const rt of next.slots.filter(s => s.parts)) {
      assert.equal(eng(w, rt.ghost.id).resume, true);
      assert.equal(rt.player.replays.length, 1, 'its goodbye replays');
      assert.equal(loopOf(rt).closing, 'all');
    }
    if (nx.parts) {
      nx.player.finish();                                 // its goodbye ends (no \-): it closes all the same
      await until(() => !nx.parts);
      assert.ok(ny.parts && !eng(w, 'y').find('OnOtherGhostClosed').length, 'Y is not told: it is quitting too');
    }
    ny.player.finish();
    await until(() => next.slots.length === 1 && next.slots[0]._launcherMode === 'closed');
    assert.deepEqual(ids(next), ['x'], 'the closed launcher "Call X"');
    assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y'], 'Quit keeps the set');
    assert.equal(next.quitting, false);
    for (const id of ['x', 'y']) assert.ok(!events(eng(w, id), OTHER).length, `${id}: no OnOtherGhostClosed`);
    assert.equal(sessionMarker.read(), null);
    invariants(next, w);
    next.done();
  }

  // the bfcache: Quit goes on after the round trip, and nothing is stuck once it ends
  const w = world();
  w.saves.set('y', {});
  const site = await up(w);
  site.slots[0].parts.menu._run({ type: 'quit' }, 0);
  await settle();
  site.win.fire('pagehide', { persisted: true });
  site.win.fire('pageshow', { persisted: true });
  await until(() => loopOf(site.slots[0]) && loopOf(site.slots[0]).booted);
  await settle(5);
  assert.equal(site.quitting, true, 'the Quit goes on');
  assert.equal(loopOf(site.slots[0]).closing, 'all');
  site.slots[0].player.finish();
  await until(() => site.slots[0]._launcherMode === 'closed');
  assert.equal(site.quitting, false);
  assert.equal(await site.callGhost('y'), true, 'calls work after it');
  invariants(site, w);
});

test('tabs: a takeover asked during Quit waits for its end, then finds the closed launcher (a Quit is never split)', async () => {
  const w = world();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const a = await up(w);
  const b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  a.slots[0].parts.menu._run({ type: 'quit' }, 0);
  await settle();
  a.doc.hidden = true;
  b.show(true);
  await settle(20);
  assert.ok(a.lead.held && a.quitting, 'A keeps the set while it says goodbye');
  assert.ok(a.slots.every(rt => loopOf(rt) && loopOf(rt).closing === 'all'));
  assert.ok(b.slots.every(rt => rt.frozen && !rt.parts));
  for (const rt of a.slots) rt.player.finish();
  await until(() => b.slots.length === 1 && b.slots[0]._launcherMode === 'closed');
  await settle(10);
  assert.equal(a.quitting, false);
  assert.deepEqual(ids(a), ['x']);
  assert.equal(a.slots[0]._launcherMode, 'closed');
  assert.ok(!a.lead.held && !b.lead.held);
  assert.deepEqual(live(w), []);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y']);
  invariants(a, w);
  invariants(b, w);
});

test('page API in a tab without the lead: changeGhost and callGhost are refused, no lock taken, nothing stored; no deadlock', async () => {
  const w = world();
  for (const id of ['x', 'y', 'z', 'w']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const a = await up(w);
  const b = new TestSite(w);                              // a second visible window: frozen, waiting for the set
  assert.equal(await b.start(), 'frozen');
  await settle(5);
  const posts = w.posts.length;
  assert.equal(await b.changeGhost('w'), false);
  assert.equal(await b.slots[0].changeGhost('w'), false, 'window.sumika.runtime.changeGhost too');
  assert.equal(await b.callGhost('z'), false);
  await settle(10);
  assert.ok(!w.locks.held.has('sumika:w') && !w.locks.held.has('sumika:z'), 'no ghost lock in a tab that runs nothing');
  assert.deepEqual([runtimePrefs.get().ghosts, runtimePrefs.get().rev], [['x', 'y'], 1], 'the stored set is A\'s');
  assert.equal(w.posts.length, posts, 'nothing told to the other tabs');
  assert.deepEqual(ids(a), ['x', 'y']);
  assert.ok(a.slots.every(rt => loopOf(rt) && loopOf(rt).booted), 'A runs on');
  assert.deepEqual(ids(b), ['x', 'y']);
  assert.ok(b.slots.every(rt => rt.frozen && !rt.parts));
  invariants(a, w);
  invariants(b, w);
  // nothing is locked up: A hidden, B takes the whole set over
  a.show(false);
  await until(() => b.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await settle(10);
  assert.ok(b.lead.held);
  assert.deepEqual(live(w), ['x', 'y']);
  // a caller that is not on screen: false, nothing called (as changeGhost)
  assert.equal(await b.callGhost('z', { from: 'nobody' }), false);
  assert.equal(await b.changeGhost('z', { from: 'nobody' }), false);
  await settle();
  assert.deepEqual(ids(b), ['x', 'y']);
  assert.ok(!eng(w, 'z'));
  invariants(a, w);
  invariants(b, w);
});

test('page API with the site closed here (Quit, the last Close): callGhost and changeGhost take the lead and boot cold; the stored set is the slots again', async () => {
  // a call after Quit: the callee alone, a plain cold boot
  let w = world();
  for (const id of ['x', 'y', 'z']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  let site = await up(w);
  await quitAll(site);
  assert.ok(!site.lead.held);
  assert.deepEqual([...site.onScreen()], [], 'the closed launcher is no ghost on screen');
  assert.equal(site.callList(site.slots[0]).find(r => r.id === 'x').elsewhere, undefined);
  assert.equal(await site.callGhost('z'), true);
  assert.deepEqual(ids(site), ['z']);
  assert.deepEqual(events(eng(w, 'z'), BOOT), ['GET OnBoot']);
  assert.ok(site.lead.held);
  assert.equal(site.slots[0]._launcherMode, null);
  assert.deepEqual(runtimePrefs.get().ghosts, ['z']);
  invariants(site, w);
  site.done();

  // the closed launcher's own ghost
  w = world();
  w.saves.set('x', {});
  site = await up(w);
  await quitAll(site);
  assert.equal(await site.callGhost('x'), true, 'not "on screen already"');
  assert.deepEqual(ids(site), ['x']);
  assert.deepEqual(events(eng(w, 'x'), BOOT), ['GET OnBoot']);
  invariants(site, w);
  site.done();

  // a ghost change after the last Close
  w = world();
  for (const id of ['x', 'y']) w.saves.set(id, {});
  site = await up(w);
  const x = site.slots[0];
  assert.equal(await site.closeGhost(), true);
  quitRun(x);
  await until(() => x._launcherMode === 'closed');
  assert.equal(await site.changeGhost('y'), true);
  assert.ok(site.slots[0] === x, 'in the launcher\'s slot');      // (no deep diff of two Runtimes on failure)
  assert.deepEqual(ids(site), ['y']);
  assert.equal(eng(w, 'y').resume, false);
  assert.deepEqual(events(eng(w, 'y'), BOOT), ['GET OnBoot']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['y']);
  assert.equal(x._launcherMode, null);
  invariants(site, w);
  site.done();

  // a call from the closed launcher that does not boot: the site stays closed, its launcher calling the old set back
  w = world({ failEngine: id => id === 'z' });
  for (const id of ['x', 'y']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  site = await up(w);
  await quitAll(site);
  assert.equal(await site.callGhost('z'), false);
  assert.deepEqual(ids(site), ['x']);
  assert.equal(site.slots[0]._launcherMode, 'closed');
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'y']);
  assert.ok(!site.lead.held);
  invariants(site, w);
});

test('a frozen tab started again (window.sumika.start(), a restore button a yield left) keeps one frozen stage per slot and never boots a second engine', async () => {
  let w = world();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  let a = await up(w);
  let b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  const stages = b.slots.map(rt => rt.frozen);
  const listeners = b.doc.count('visibilitychange');
  assert.equal(await b.start(), 'frozen', 'started again');
  assert.ok(b.slots.every((rt, i) => rt.frozen === stages[i]), 'the same frozen stages');
  assert.ok(stages.every(s => !s.destroyed));
  assert.equal(b.doc.count('visibilitychange'), listeners, 'no listener added');
  a._onPageHide();                                        // A goes: nobody runs the set
  a.done();
  await settle();
  assert.equal(await b.start(), 'booted', 'started again with the lead free: the set runs here');
  assert.ok(stages.every(s => s.destroyed) && b.slots.every(rt => !rt.frozen && !rt._frozenOff), 'the frozen stages and their listeners went');
  const n = w.engines.length;
  b.show(true);                                           // a visibility event later: nothing is frozen
  await settle(20);
  assert.equal(w.engines.length, n, 'no second engine');
  assert.deepEqual(live(w), ['x', 'y']);
  invariants(b, w);
  b.done();

  // Y minimized in A; B takes the set over; A keeps Y's restore button, and a click asks for the set, nothing else
  w = world();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  a = await up(w);
  await loopOf(a.slots[1]).minimize();
  b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  a.doc.hidden = true;
  b.show(true);
  await until(() => b.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await settle(10);
  const [ax, ay] = a.slots;
  assert.ok(ax.frozen && !ay.parts && ay.state.readOnly);
  assert.equal(ay._launcherMode, 'minimized', 'Y is still minimized in the tab that runs it');
  const frozenX = ax.frozen;
  const made = w.engines.length;
  ay._launch('minimized');                                // A is hidden: nothing to take over yet
  await settle(10);
  assert.equal(ay._launcherMode, 'minimized', 'the button stays');
  assert.ok(ax.frozen === frozenX, 'X\'s frozen stage is untouched');
  assert.ok(!frozenX.destroyed);
  assert.equal(w.engines.length, made, 'no cold boot');
  assert.ok(b.lead.held && b.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  invariants(a, w);
  invariants(b, w);
});

test('tabs: a slot removed while its frozen stage still loads builds nothing (no stage, no listener, no wake)', async () => {
  const w = world();
  w.saves.set('y', {});
  const a = await up(w);
  const b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  const listeners = b.doc.count('visibilitychange');
  const gate = deferred();
  b.hold.y = gate.promise;                                // tab B is slow to load Y's files
  await menuCall(a, a.slots[0], 'y');
  await until(() => b.find('y'));
  const yb = b.find('y');
  const ya = a.find('y');
  ya.player.finish();
  a.slots[0].player.finish();
  await settle();
  await loopOf(ya).close(0);
  quitRun(ya);                                            // A closes Y before B has drawn it
  await until(() => b.slots.length === 1);
  gate.resolve();
  await settle(20);
  assert.ok(!yb.frozen, 'no frozen stage for a slot that went');
  assert.equal(w.stages.filter(e => e.rt === yb).length, 0, 'none built');
  assert.equal(b.doc.count('visibilitychange'), listeners, 'no listener left behind');
  assert.deepEqual(ids(b), ['x']);
  invariants(b, w);
});

test('next page: a resumed ghost that fails leaves the set, and the others are NOTIFYed otherghostname without it', async () => {
  const w = world();
  for (const id of ['x', 'y']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = await up(w);
  site._onPageHide();
  site.done();
  await settle();
  w.failEngine = id => id === 'y';
  const next = await up(w);
  assert.deepEqual(ids(next), ['x']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x']);
  const names = eng(w, 'x').find('otherghostname').map(r => r.refs);
  assert.ok(names[0][0].startsWith('Ys\x01'), 'the resumed batch listed Y');
  assert.deepEqual(names.at(-1), [], 'told again without Y');
  assert.equal(names.length, 2);
  invariants(next, w);
});

test('a bfcache round trip while A unloads in a ghost change: B boots in the same slot with OnGhostChanged; no second Runtime, engine or layer', async () => {
  const w = world();
  w.saves.set('z', {});
  const site = await up(w);
  const x = site.slots[0];
  const sx = eng(w, 'x');
  const gate = deferred();
  let unloading = false;
  const req = sx.request.bind(sx);
  sx.request = r => (r.id === 'OnDestroy' ? (unloading = true, gate.promise.then(() => req(r))) : req(r));
  const p = changeIn(x, 'z');                             // the farewell ends; A's OnDestroy is on its way
  await until(() => unloading);
  site.win.fire('pagehide', { persisted: true });
  await settle(3);
  site.win.fire('pageshow', { persisted: true });
  gate.resolve();
  assert.equal(await p, true);
  await until(() => loopOf(site.slots[0]) && loopOf(site.slots[0]).booted);
  await settle(10);
  assert.deepEqual(ids(site), ['z']);
  assert.ok(site.slots[0] === x, 'the same Runtime, slot and layer');
  assert.equal(site.layers.order().length, 1);
  assert.deepEqual(live(w), ['z'], 'one engine');
  assert.deepEqual(w.engines.filter(e => e.ghost === 'z').flatMap(e => events(e, BOOT)), ['GET OnGhostChanged'], 'B boots once, with OnGhostChanged');
  site.slots[0].player.finish();
  await settle();
  assert.equal(sessionMarker.read().carry, undefined, 'nothing carried any more');
  invariants(site, w);
});

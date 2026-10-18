// The property system on a page of several ghosts (properties.md): the real EventLoop, Site and Runtime on
// the synthetic site of multi_world.mjs (Satori x, y, z), fake engines and views. \![get,property] (the loop's
// raiseProperty), %property in a script before OnTranslate and in an \![embed] reply, \![set,property] (setProperty),
// ghostlist / activeghostlist through the Site's props (Site.propsFor), another ghost's username, and the balloon
// numbers (FakeBalloons.metrics). The resolver alone: properties.test.mjs; the expander alone: expand.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimePrefs } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { settle, FAKE_METRICS } from './fakes.mjs';
import { defaultAnswer, world, eng, ids, idle, until, quitRun, up, invariants } from './multi_world.mjs';

setLogLevel('silent');

/** world()'s answer from a table {'<ghost> <event>' | '<event>': answer | fn(r, ghost)}; else defaultAnswer. */
function answers(table) {
  return (id, r, mem) => {
    const key = Object.hasOwn(table, `${id} ${r.id}`) ? `${id} ${r.id}` : Object.hasOwn(table, r.id) ? r.id : null;
    if (key === null) return defaultAnswer(id, r, mem);
    return typeof table[key] === 'function' ? table[key](r, id) : table[key];
  };
}

/** A tab with these ghosts on screen (met before: OnBoot), every boot talk played to its end. */
async function set(w, list = ['x', 'y']) {
  for (const id of list) w.saves.set(id, {});
  runtimePrefs.set({ ghost: list[0], ghosts: list, rev: 1 });
  const site = await up(w);
  for (let i = 0; i < 5; i++) {
    await idle(site);
    for (const rt of site.slots) if (rt.player && rt.player.busy) rt.player.finish();
    await settle();
  }
  assert.deepEqual(ids(site), list);
  invariants(site, w);
  return site;
}

test('\\![get,property,E,activeghostlist.count,activeghostlist.index(1).name]: GET E [2, Ghost Y], SenderType internal,property; its reply plays, expanded', async () => {
  const w = world({ answer: answers({ 'x OnE': '\\0got %property[activeghostlist.count] ghosts\\e' }) });
  const site = await set(w);
  const [x] = site.slots;
  const v = await x.loop.raiseProperty('OnE', ['activeghostlist.count', 'activeghostlist.index(1).name', 'no.such.name']);
  assert.equal(v, '\\0got %property[activeghostlist.count] ghosts\\e', 'resolves with the reply (the player stops its run)');
  const e = eng(w, 'x').find('OnE');
  assert.deepEqual(e.map(r => r.refs), [['2', 'Ghost Y', '']], 'a failed name is ""');
  assert.equal(e[0].headers.SenderType, 'internal,property');
  await settle();
  assert.equal(x.loop.current.script, '\\0got 2 ghosts\\e', 'played as \\![raise]\'s reply, expanded before OnTranslate');
  assert.equal(x.loop.current.origin, 'raise');
  assert.equal(eng(w, 'x').find('OnTranslate').at(-1).headers.SenderType, 'internal,property');
  assert.equal(await x.loop.raiseProperty('', ['ghostlist.count']), null, 'an empty event is no event');
  invariants(site, w);
  site.done();
});

test('ghostlist: the site index in index order, a ghost up here with its live part; activeghostlist: the ghosts up here, set order, the caller included', async () => {
  const w = world({ answer: answers({ 'y username': 'Mister\\Y' }) });
  const site = await set(w, ['y', 'x']);
  const [y, x] = site.slots;
  const ex = s => x.loop.expand(s);
  assert.equal(ex('%property[ghostlist.count]/%property[activeghostlist.count]'), '5/2');
  assert.equal(ex('%property[ghostlist.index(1).scope(0).name]'), 'Ys', 'index order; a running ghost\'s scope names');
  assert.equal(ex('%property[ghostlist(Ys).path]|%property[ghostlist(z).sakuraname]|%property[ghostlist(z).scope(0).name]|'),
    '/ghost/y/|Zs||', 'by sakura name; z is not up: its descript names only');
  assert.equal(ex('%property[activeghostlist.index(0).name],%property[activeghostlist.index(1).name]'), 'Ghost Y,Ghost X');
  assert.equal(ex('%property[ghostlist.current.name] %property[activeghostlist.current.index] %property[currentghost.path]'),
    'Ghost X 0 /ghost/x/', 'a ghost\'s index is its place in ghostlist');
  assert.equal(ex('[%property[activeghostlist.index(2).name]]'), '[]', 'out of range: removed');
  // another ghost's username: GET username to its engine, raw (the property inserts it as it is)
  const p = ex('%property[activeghostlist(Ys).username]');
  assert.ok(p && typeof p.then === 'function');
  assert.equal(await p, 'Mister\\Y');
  assert.equal(eng(w, 'y').find('username').length, 1);
  assert.equal(eng(w, 'x').find('username').length, 0);
  assert.equal(await ex('<%property[currentghost.username]>'), '<>', 'x answers 204: the property fails (no fallback)');
  // %username asks x itself, then falls back to the stored nickname, else `user`
  assert.equal(await ex('%username'), 'user');
  assert.equal(eng(w, 'x').find('username').length, 2);
  invariants(site, w);

  // y closes: it leaves activeghostlist, and ghostlist no longer asks its engine
  assert.equal(await site.closeGhost('y'), true);
  quitRun(y);
  assert.ok(await until(() => site.slots.length === 1));
  await settle();
  assert.equal(ex('%property[activeghostlist.count]'), '1');
  assert.equal(ex('%property[activeghostlist.index(0).name]'), 'Ghost X');
  assert.equal(ex('[%property[ghostlist(y).username]]'), '[]');
  assert.equal(eng(w, 'y').find('username').length, 1);
  invariants(site, w);
  site.done();
});

test('a ghost still in the slots but closed, frozen or still booting is no active ghost: listed nowhere, its engine never asked (plan R5)', async () => {
  const w = world({ answer: answers({ 'y username': 'Mister Y', 'z username': 'Mister Z' }) });
  const site = await set(w);
  const [x, y] = site.slots;
  const ex = s => x.loop.expand(s);
  const asked = id => eng(w, id).find('username').length;
  const kept = y.loop.propRecord().live;        // a record an expansion took while y was up
  // y between its farewell's end and its slot's removal (closed), or the tab froze the set (frozen)
  for (const [what, flag] of [['closed', 'closed'], ['frozen', 'frozen']]) {
    y.loop[flag] = true;
    assert.ok(site.slots.includes(y), `${what}: still in the slots`);
    assert.equal(ex('%property[activeghostlist.count]/%property[ghostlist.count]'), '1/5', `${what}: x only`);
    assert.equal(ex('[%property[activeghostlist.index(1).name]]'), '[]', what);
    assert.equal(await ex('[%property[activeghostlist(Ys).username]]'), '[]', what);
    assert.equal(await ex('[%property[ghostlist(Ys).username]]'), '[]', `${what}: the index record, no live part`);
    assert.equal(await kept.username(), null, `${what}: a record taken before asks nothing either`);
    assert.equal(asked('y'), 0, `${what}: no GET username reached y`);
    y.loop[flag] = false;
  }
  assert.equal(await ex('%property[activeghostlist(Ys).username]'), 'Mister Y', 'up again: asked');
  assert.equal(asked('y'), 1);

  // a called ghost still booting (its loop runs GET version, the NOTIFY batch not out yet: not _up)
  let release;
  w.answer = answers({ 'z version': () => new Promise(r => { release = r; }), 'z username': 'Mister Z' });
  x.parts.menu._run({ type: 'callghost', id: 'z' }, 0);
  assert.ok(await until(() => !!release));
  const z = site.slots.find(rt => rt.ghost && rt.ghost.id === 'z');
  assert.ok(z && z.loop && !z.loop.closed && !z.loop.frozen && !z._up, 'z is booting');
  assert.equal(ex('%property[activeghostlist.count]'), '2');
  assert.equal(await ex('[%property[activeghostlist(Zs).username]][%property[ghostlist(Zs).username]]'), '[][]');
  assert.equal(asked('z'), 0, 'no GET username reached z');
  release('Satori');
  await idle(site);
  for (const rt of site.slots) if (rt.player && rt.player.busy) rt.player.finish();
  await idle(site);
  assert.equal(ex('%property[activeghostlist.count]'), '3', 'z up: listed');
  invariants(site, w);
  site.done();
});

test('%property in a script: expanded before OnTranslate (R0 the expanded text); balloon numbers; an \\![embed] reply expanded before it is spliced in', async () => {
  const w = world({ answer: answers({
    'x OnT': '\\0w=%property[currentghost.balloon.scope0.validwidth] l=%property[currentghost.balloon.sakura.lines] '
      + 'cw=%property[currentghost.balloon.scope(0).char_width] n=%property[currentghost.balloon.scope(1).num] '
      + 'r=%property[currentghost.balloon.scope(1).rect] s9=%property[currentghost.balloon.scope(9).lines].\\e',
    'x OnEm': 'count %property[ghostlist.count]',
  }) });
  const site = await set(w);
  const [x] = site.slots;
  await x.loop.send('OnT');
  const tr = eng(w, 'x').find('OnTranslate').at(-1);
  const want = `\\0w=${FAKE_METRICS.validWidth} l=${FAKE_METRICS.lines} cw=${FAKE_METRICS.charWidth} n=0 r=500,200,800,350 s9=.\\e`;
  assert.equal(tr.refs[0], want, 'a scope the ghost does not have fails');
  assert.equal(x.loop.current.script, want);
  assert.equal(await x.loop.raise('OnEm', [], { embed: true }), 'count 5');
  assert.equal(eng(w, 'x').find('OnEm')[0].headers.SenderType, 'internal,embed');
  invariants(site, w);
  site.done();
});

test('\\![set,property]: a surface and a balloon of the calling ghost, also through ghostlist(other); activeghostlist.current. is not settable', async () => {
  const w = world();
  const site = await set(w);
  const [x, y] = site.slots;
  const surf = rt => rt.parts.stage.char(0).surfaceId;
  assert.equal(x.loop.setProperty('currentghost.scope(0).surface.num', '5'), true);
  assert.equal(surf(x), 5);
  assert.equal(x.loop.setProperty('ghostlist(Ys).scope(0).surface.num', '8'), true);
  assert.deepEqual([surf(x), surf(y)], [8, 0], 'acts on the caller [disasm 0x6C45E7]');
  assert.equal(x.loop.setProperty('activeghostlist.current.scope(0).surface.num', '3'), false);
  assert.equal(surf(x), 8);
  assert.equal(x.loop.setProperty('currentghost.balloon.scope(1).num', '2'), true);
  assert.equal(x.parts.balloons.get(1).kind, 2);
  assert.equal(x.loop.expand('%property[currentghost.balloon.scope(1).num]'), '2');
  assert.equal(x.loop.setProperty('system.year', '1999'), false);
  invariants(site, w);
  site.done();
});

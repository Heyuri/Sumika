// Ghosts interacting on one page, end to end (EV §2.7.7–§2.7.9): the real EventLoop and Site on the
// synthetic site of multi_world.mjs (Satori x, y, z), fake engines whose answers may carry response headers.
// COMMUNICATE (a reply that names another ghost goes to it when its run ends: OnCommunicate there), \![raiseother] /
// \![notifyother] and \![timerraiseother] through the Site's page-wide queue (OnRaiseOtherFailure back to the raiser),
// and the FMO text a Satori ghost's requests carry. invariants() after each step. The loop alone:
// interact_loop.test.mjs; the Site's routing on stub loops: site.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimePrefs, stateKey } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { ShioriClient } from '../../src/core/shiori.js';
import { settle, deferred, FakeClock } from './fakes.mjs';
import {
  ghost, GHOSTS, defaultAnswer, world, TestSite, TestRuntime, loopOf, eng, ids, idle, until, quitRun, up, invariants,
} from './multi_world.mjs';

setLogLevel('silent');

const ALL = '__SYSTEM_ALL_GHOST__';
/** A response with a script and response headers (FakeShiori). */
const say = (value, headers = {}) => ({ status: 200, value, headers });

/** world()'s answer from a table {'<ghost> <event>' | '<event>': answer | fn(r, ghost)}; else defaultAnswer. */
function answers(table) {
  return (id, r, mem) => {
    const key = Object.hasOwn(table, `${id} ${r.id}`) ? `${id} ${r.id}` : Object.hasOwn(table, r.id) ? r.id : null;
    if (key === null) return defaultAnswer(id, r, mem);
    return typeof table[key] === 'function' ? table[key](r, id) : table[key];
  };
}

/** Every script that plays is played to its end, until nothing plays (talks passed on, replies, raises). */
async function quiet(site, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await idle(site);
    if (site._raiseTail) await site._raiseTail;
    const busy = site.slots.filter(rt => rt.player && rt.player.busy);
    if (!busy.length) return;
    for (const rt of busy) rt.player.finish();
    await settle();
  }
}

/** A tab with these ghosts on screen (met before: OnBoot), every boot talk played to its end. */
async function set(w, list = ['x', 'y', 'z']) {
  for (const id of list) w.saves.set(id, {});
  runtimePrefs.set({ ghost: list[0], ghosts: list, rev: 1 });
  const site = await up(w);
  await quiet(site);
  assert.deepEqual(ids(site), list);
  invariants(site, w);
  return site;
}

/** The raises asked so far have run (the Site's queue), and their replies have started. */
async function raised(site) {
  if (site._raiseTail) await site._raiseTail;
  await settle();
}

/** One key of every ghost in an FMO text, by entry (0 = the reader). */
function fmo(text, key) {
  const out = [];
  for (const line of String(text).split('\r\n')) {
    const m = /^ssp_fmo_header_00000000_([0-9a-f]{8})\.([^\x01]+)\x01(.*)$/.exec(line);
    if (m && m[2] === key) out[parseInt(m[1], 16)] = m[3];
  }
  return out;
}

// ---------------------------------------------------------------- 1–8: COMMUNICATE (EV §2.7.7)

test('a reply naming Y goes to Y when X\'s run ends: GET OnCommunicate [Xs, the raw Value], external,sstp,communicate, Age 0, Surface; Y\'s reply cuts its own talk', async () => {
  const w = world({ answer: answers({
    'x OnTest': say('\\0Hi Y.\\e', { Reference0: 'Ys' }),
    'y OnCommunicate': r => `\\0y: hello, ${r.refs[0]}\\e`,
  }) });
  const site = await set(w);
  const [x, y] = site.slots;
  y.loop.playScript('\\0Y talks on.\\e', { event: 'OnTalk' });
  await x.loop.send('OnTest', []);
  await settle();
  assert.equal(x.loop.current.script, '\\0Hi Y.\\e');
  assert.deepEqual(x.loop.current.communicate.ids, ['y'], 'resolved when the response came');
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 0, 'nothing while X still talks');
  invariants(site, w);
  x.player.finish();
  await settle();
  const got = eng(w, 'y').find('OnCommunicate');
  assert.deepEqual(got.map(r => [r.method, r.refs]), [['GET', ['Xs', '\\0Hi Y.\\e']]]);
  assert.deepEqual([got[0].headers.SenderType, got[0].headers.Age, got[0].headers.Surface, got[0].headers.Marker],
    ['external,sstp,communicate', '0', '0\x0110', undefined]);
  assert.equal(y.loop.current.script, '\\0y: hello, Xs\\e', 'Y\'s reply plays ...');
  assert.equal(y.player.plays.at(-2).script, '\\0Y talks on.\\e', '... in place of its own talk');
  assert.equal(eng(w, 'z').find('OnCommunicate').length, 0);
  y.player.finish();
  await settle();
  assert.equal(eng(w, 'x').find('OnCommunicate').length, 0, 'Y\'s reply names nobody: nothing comes back');
  invariants(site, w);
});

test('a broken run passes nothing on: a balloon break, a newer script, \\- (the sender goes)', async () => {
  const w = world({ answer: answers({ 'x OnTest': say('\\0Hi Y.\\e', { Reference0: 'Ys' }) }) });
  const site = await set(w, ['x', 'y']);
  const x = site.slots[0];
  await x.loop.send('OnTest', []);
  x.player.interrupt();                                   // a balloon break (or a choice clicked while it typed)
  await settle();
  await x.loop.send('OnTest', []);
  x.loop.playScript('\\0Something else.\\e');              // a newer script replaces it
  x.player.finish();
  await settle();
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 0);
  await x.loop.send('OnTest', []);
  x.player.finish();                                      // the same talk played to its end goes
  await settle();
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 1);
  invariants(site, w);
  await x.loop.send('OnTest', []);
  quitRun(x);                                             // \- in it: the ghost goes, and its talk with it
  await until(() => site.slots.length === 1);
  await settle();
  assert.deepEqual(ids(site), ['y']);
  assert.equal(eng(w, 'y').find('OnOtherGhostClosed').length, 1);
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 1);
  invariants(site, w);
});

test('To decides when it differs from Reference0 (every Reference passed on: R2 Zs, R3 a); Reference0 as the target: from Reference1 on', async () => {
  const w = world({ answer: answers({
    'x OnA': say('\\0To Y.\\e', { To: 'Ys', Reference0: 'Zs', Reference1: 'a' }),
    'x OnB': say('\\0Y again.\\e', { Reference0: 'Ys', Reference1: 'a' }),
    // Satori drops an empty ＄Value2: the later References keep their numbers, the gap goes as '' [disasm 0x6AEC60]
    'x OnC': say('\\0Gap.\\e', { Reference0: 'Ys', Reference1: 'ECHO/1.0', Reference3: 'a', Reference4: 'b' }),
  }) });
  const site = await set(w);
  const x = site.slots[0];
  for (const ev of ['OnA', 'OnB', 'OnC']) {
    await x.loop.send(ev, []);
    x.player.finish();
    await settle();
  }
  assert.deepEqual(eng(w, 'y').find('OnCommunicate').map(r => r.refs),
    [['Xs', '\\0To Y.\\e', 'Zs', 'a'], ['Xs', '\\0Y again.\\e', 'a'], ['Xs', '\\0Gap.\\e', 'ECHO/1.0', '', 'a', 'b']]);
  assert.equal(eng(w, 'z').find('OnCommunicate').length, 0, 'To wins: Reference0 is only a Reference then');
  invariants(site, w);
});

test('targets: __SYSTEM_ALL_GHOST__ (any case, whole value) = Y then Z, never X; duplicates twice; sakura names any case, spaces skipped; a descript name or a ghost not on screen: nobody', async () => {
  let to = ALL;
  const w = world({ answer: answers({ 'x OnTest': () => say('\\0Hello.\\e', { Reference0: to }) }) });
  const site = await set(w);
  const x = site.slots[0];
  const talk = async t => {
    to = t;
    w.order.length = 0;
    await x.loop.send('OnTest', []);
    x.player.finish();
    await settle();
    return w.order.filter(e => / GET OnCommunicate$/.test(e));
  };
  const Y = 'y GET OnCommunicate';
  const Z = 'z GET OnCommunicate';
  assert.deepEqual(await talk(ALL), [Y, Z]);
  assert.deepEqual(await talk('__system_all_ghost__'), [Y, Z]);
  assert.deepEqual(await talk(`Ys\x01${ALL}`), [Y], 'ALL only as the whole value');
  assert.deepEqual(await talk('Ys\x01Ys'), [Y, Y], 'duplicates kept');
  assert.deepEqual(await talk('Zs\x01\x01Ys'), [Z, Y], 'in the order named; empty tokens dropped');
  assert.deepEqual(await talk(' y　S '), [Y], 'SSP\'s compare: any case, spaces and U+3000 skipped');
  for (const t of ['Ghost Y', 'Ws', 'Xs', '']) assert.deepEqual(await talk(t), [], JSON.stringify(t));
  assert.equal(eng(w, 'x').find('OnCommunicate').length, 0, 'never the sender');
  invariants(site, w);
});

test('a conversation: each reply that names the other starts the next turn, with no cap; it stops at a reply without a target', async () => {
  let turns = 0;
  const w = world({ answer: answers({
    'x OnTest': say('\\0x: hello\\e', { Reference0: 'Ys' }),
    OnCommunicate: (r, id) => {
      turns++;
      if (turns >= 12) return `\\0${id}: enough\\e`;
      return say(`\\0${id}: turn ${turns}\\e`, { Reference0: id === 'x' ? 'Ys' : 'Xs' });
    },
  }) });
  const site = await set(w);
  const [x, y] = site.slots;
  await x.loop.send('OnTest', []);
  for (let i = 0; i < 40 && site.slots.some(rt => rt.player.busy); i++) {
    for (const rt of site.slots) if (rt.player.busy) rt.player.finish();
    await settle();
  }
  assert.equal(turns, 12);
  const ex = eng(w, 'x').find('OnCommunicate');
  const ey = eng(w, 'y').find('OnCommunicate');
  assert.deepEqual([ex.length, ey.length], [6, 6]);
  assert.deepEqual(ey.map(r => r.refs[1]), ['\\0x: hello\\e', ...[2, 4, 6, 8, 10].map(n => `\\0x: turn ${n}\\e`)]);
  assert.deepEqual(ex.map(r => r.refs[0]), Array(6).fill('Ys'));
  assert.ok([...ex, ...ey].every(r => r.headers.Age === '0'), 'Age as given: SSP never adds 1');
  assert.equal(x.player.last.script, '\\0x: enough\\e');
  assert.equal(y.player.busy || x.player.busy, false);
  assert.equal(eng(w, 'z').find('OnCommunicate').length, 0);
  invariants(site, w);
});

test('the receiver: minimized, its SHIORI hears it and nothing plays; sstp.allowcommunicate,0: not asked; in a ghost change: not asked', async () => {
  const table = { 'x OnTest': say('\\0Hi Y.\\e', { Reference0: 'Ys' }), 'y OnCommunicate': '\\0y: hm?\\e' };
  let w = world({ answer: answers(table) });
  let site = await set(w, ['x', 'y']);
  let [x, y] = site.slots;
  await loopOf(y).minimize();
  const n = y.player.plays.length;
  await x.loop.send('OnTest', []);
  x.player.finish();
  await settle();
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 1, 'asked');
  assert.equal(y.player.plays.length, n, 'its reply is dropped');
  invariants(site, w);
  site.done();

  const shy = ghost('y', { descript: [['sstp.allowcommunicate', '0']] });
  w = world({ answer: answers(table), ghosts: GHOSTS.map(g => (g.id === 'y' ? shy : g)) });
  site = await set(w, ['x', 'y']);
  x = site.slots[0];
  await x.loop.send('OnTest', []);
  assert.deepEqual(x.loop.current.communicate.ids, ['y']);
  x.player.finish();
  await settle();
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 0, 'refused (420) before its SHIORI');
  invariants(site, w);
  site.done();

  w = world({ answer: answers(table) });
  w.saves.set('w', {});
  site = await set(w, ['x', 'y']);
  [x, y] = site.slots;
  await x.loop.send('OnTest', []);                        // the talk names Y ...
  const change = y.changeGhost('w');                      // ... then Y starts a ghost change
  await until(() => y.loop && y.loop.current && y.loop.current.event === 'OnGhostChanging');
  assert.equal(y.loop.changing, true);
  x.player.finish();
  await settle();
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 0, 'not while it says goodbye for a ghost change');
  y.player.finish();
  assert.equal(await change, true);
  await quiet(site);
  assert.deepEqual(ids(site), ['x', 'w']);
  assert.equal(eng(w, 'w').find('OnCommunicate').length, 0, 'nor the ghost that took its place');
  invariants(site, w);
});

test('a page left while X\'s talk plays: the next page replays it and Y gets OnCommunicate at its end, once (not on a third page)', async () => {
  const w = world({ answer: answers({ 'x OnTest': say('\\0Hi Y.\\e', { Reference0: 'Ys' }) }) });
  const site = await set(w, ['x', 'y']);
  await site.slots[0].loop.send('OnTest', []);
  site._onPageHide();
  site.done();
  await settle();

  const next = new TestSite(w);
  assert.equal(await next.start(), 'booted');
  await settle();
  const x = next.slots[0];
  assert.deepEqual([eng(w, 'x').resume, eng(w, 'y').resume], [true, true]);
  assert.equal(x.player.replays.length, 1, 'X\'s talk replays');
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 0, 'not before its end');
  x.player.finish();
  await settle();
  assert.deepEqual(eng(w, 'y').find('OnCommunicate').map(r => r.refs), [['Xs', '\\0Hi Y.\\e']]);
  invariants(next, w);
  next._onPageHide();
  next.done();
  await settle();

  const third = await up(w);                              // X's finished talk replays again (its balloon is up)
  await quiet(third);
  assert.equal(eng(w, 'x').resume, true);
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 0, 'never twice');
  invariants(third, w);
});

test('another tab takes the set over while X\'s talk plays: it replays there and Y gets OnCommunicate there, once', async () => {
  const w = world({ answer: answers({ 'x OnTest': say('\\0Hi Y.\\e', { Reference0: 'Ys' }) }) });
  const a = await set(w, ['x', 'y']);
  await a.slots[0].loop.send('OnTest', []);
  const b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  a.doc.hidden = true;
  b.show(true);
  await until(() => b.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await settle(20);
  assert.ok(b.lead.held && a.slots.every(rt => rt.frozen && !rt.parts), 'B runs the set');
  const x = b.find('x');
  assert.equal(x.player.replays.length, 1);
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 0);
  x.player.finish();
  await settle();
  assert.deepEqual(eng(w, 'y').find('OnCommunicate').map(r => r.refs), [['Xs', '\\0Hi Y.\\e']]);
  assert.equal(w.engines.filter(e => e.ghost === 'y').reduce((n, e) => n + e.find('OnCommunicate').length, 0), 1,
    'once over both tabs');
  invariants(a, w);
  invariants(b, w);
});

test('OnOtherGhostTalk R2: communicate before and after a run that carries a talk, communicate,break when it is cut; the after broadcast goes before the talk', async () => {
  const w = world({ answer: answers({ 'x OnTest': say('\\0Hi Y.\\e', { Reference0: 'Ys' }) }) });
  const site = await set(w);
  const [x, , z] = site.slots;
  loopOf(z).setOption('otherghosttalk', ['before,after']);
  w.order.length = 0;
  await x.loop.send('OnTest', []);
  x.player.finish();
  await settle();
  const ez = eng(w, 'z');
  assert.deepEqual(ez.find('OnOtherGhostTalk').map(r => [r.refs[2], r.refs[3]]),
    [['communicate', 'OnTest'], ['communicate', 'OnTest']]);
  assert.ok(w.order.lastIndexOf('z GET OnOtherGhostTalk') < w.order.indexOf('y GET OnCommunicate'),
    'after, then the talk');
  await x.loop.send('OnTest', []);
  x.player.interrupt();
  await settle();
  assert.deepEqual(ez.find('OnOtherGhostTalk').slice(2).map(r => r.refs[2]), ['communicate', 'communicate,break']);
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 1, 'the cut one passes nothing on');
  invariants(site, w);
});

test('\\![change,ghost] in a talk breaks it only when it finds a ghost (GetGhostIDFromTag): an unknown one or one on screen leave the talk to Y going; another installed one, X itself or random break it', async () => {
  for (const [target, broken, after] of [
    ['NoSuchGhost', false, ['x', 'y', 'z']],
    ['Ghost Z', false, ['x', 'y', 'z']],                   // on screen in another slot: -1 [disasm 0x62A9C0]
    ['lastinstalled', false, ['x', 'y', 'z']],             // nothing is installed in a browser
    ['Ghost X', true, ['x', 'y', 'z']],                    // itself: SSP breaks it (Sumika changes nothing then)
    ['Ws', true, ['w', 'y', 'z']],                         // by its sakura name, not on screen: the change goes
    ['random', true, ['w', 'y', 'z']],                     // w is the only one left (kk has no engine here)
  ]) {
    const w = world({ answer: answers({ 'x OnTest': say(`\\0Hi Y.\\![change,ghost,${target}]\\e`, { Reference0: 'Ys' }) }) });
    w.saves.set('w', {});
    const site = await set(w);
    const [x, , z] = site.slots;
    loopOf(z).setOption('otherghosttalk', ['after']);
    await x.loop.send('OnTest', []);
    assert.equal(x.loop.change('ghost', [target]), undefined);       // what the player does at the tag
    x.player.finish();
    await quiet(site);
    assert.equal(eng(w, 'y').find('OnCommunicate').length, broken ? 0 : 1, target);
    assert.equal(eng(w, 'z').find('OnOtherGhostTalk')[0].refs[2], broken ? 'communicate,break' : 'communicate', target);
    assert.deepEqual(ids(site), after, target);
    invariants(site, w);
    site.done();
  }
});

// ---------------------------------------------------------------- 9–10: raiseother, notifyother, timers (EV §2.7.9)

test('\\![raiseother] from X to ALL: Y then Z get GET <event> [refs] with Sender: Xs, SenderType internal, and play their replies; X is skipped silently and its script goes on', async () => {
  const w = world({ answer: answers({ OnTea: (r, id) => `\\0${id}: tea from ${r.headers.Sender}\\e` }) });
  const site = await set(w);
  const [x, y, z] = site.slots;
  x.loop.playScript('\\0Tea time!\\![raiseother,__SYSTEM_ALL_GHOST__,OnTea,紅茶,クッキー]\\e', { event: 'OnTalk' });
  const run = x.loop.current;
  w.order.length = 0;
  x.loop.raiseOther(ALL, 'OnTea', ['紅茶', 'クッキー']);       // what the player does at the tag
  await raised(site);
  for (const id of ['y', 'z']) {
    assert.deepEqual(eng(w, id).find('OnTea').map(r => [r.method, r.refs, r.headers.Sender, r.headers.SenderType]),
      [['GET', ['紅茶', 'クッキー'], 'Xs', 'internal']], id);
  }
  assert.ok(w.order.indexOf('y GET OnTea') < w.order.indexOf('z GET OnTea'), 'in set order');
  assert.deepEqual([y.loop.current.script, z.loop.current.script], ['\\0y: tea from Xs\\e', '\\0z: tea from Xs\\e']);
  assert.equal(eng(w, 'x').find('OnTea').length + eng(w, 'x').find('OnRaiseOtherFailure').length, 0,
    'the raiser: skipped, no failure');
  assert.equal(x.loop.current, run, 'X\'s script did not wait and goes on');
  assert.equal(x.player.busy, true);
  // by descript name too (C3: descript names first), and the raiser by its own name: nothing at all
  x.loop.raiseOther('Ghost Z', 'OnTea', []);
  x.loop.raiseOther('Xs', 'OnTea', []);
  await raised(site);
  assert.deepEqual([eng(w, 'y').find('OnTea').length, eng(w, 'z').find('OnTea').length], [1, 2]);
  assert.equal(eng(w, 'x').find('OnTea').length + eng(w, 'x').find('OnRaiseOtherFailure').length, 0);
  invariants(site, w);
});

test('raiseother failures come back to X as one OnRaiseOtherFailure [reasons, sakura names, event, refs] (internal,raise): notfound, passivemode, 204, invalid; a list names only the ghosts that failed', async () => {
  const w = world({ answer: answers({
    'y OnTea': '\\0y: tea!\\e', 'z OnTea': null, OnRaiseOtherFailure: r => `\\0x: ${r.refs[0]}\\e`,
  }) });
  const site = await set(w);
  const [x, y] = site.slots;
  const fails = () => eng(w, 'x').find('OnRaiseOtherFailure');
  const raise = async (...a) => { x.loop.raiseOther(...a); await raised(site); return fails().at(-1).refs; };
  assert.deepEqual(await raise('nobody', 'OnTea', ['a', 'b']), ['notfound', 'nobody', 'OnTea', 'a', 'b']);
  assert.deepEqual([fails()[0].method, fails()[0].headers.SenderType], ['GET', 'internal,raise']);
  assert.equal(x.loop.current.script, '\\0x: notfound\\e', 'its reply plays on the raiser');
  loopOf(y).ghostLife.passive = true;
  assert.deepEqual(await raise('Ys', 'OnTea', ['a']), ['passivemode', 'Ys', 'OnTea', 'a']);
  assert.equal(eng(w, 'y').find('OnTea').length, 0, 'a locked ghost is not asked');
  assert.deepEqual(await raise(ALL, 'OnTea', []), ['passivemode\x01204', 'Ys\x01Zs', 'OnTea']);
  loopOf(y).ghostLife.passive = false;
  assert.deepEqual(await raise('Zs', 'OnTea', []), ['204', 'Zs', 'OnTea']);
  const n = fails().length;
  assert.deepEqual(await raise('Ys\x01Zs', 'OnTea', ['c']), ['204', 'Zs', 'OnTea', 'c'], 'only the ghost that failed');
  assert.equal(fails().length, n + 1, 'one event for the whole tag');
  assert.equal(eng(w, 'y').find('OnTea').length, 1);
  assert.deepEqual(await raise(undefined, '', []), ['invalid'], 'a bare \\![raiseother]');
  assert.deepEqual(await raise('Ys', '', []), ['invalid', 'Ys'], 'no event, a ghost found');
  assert.deepEqual(await raise('nobody', '', []), ['notfound', 'nobody'], 'no event, nobody found');
  assert.equal(eng(w, 'x').find('OnNotifyOtherFailure').length, 0);
  invariants(site, w);
});

test('\\![notifyother]: NOTIFY with Sender, the reply never plays and 204 is no failure; OnNotifyOtherFailure for a ghost not there', async () => {
  const w = world({ answer: answers({ 'y OnTea': '\\0y: never played\\e' }) });
  const site = await set(w);
  const [x, y] = site.slots;
  const n = y.player.plays.length;
  x.loop.raiseOther(ALL, 'OnTea', ['a'], { notify: true });
  await raised(site);
  assert.deepEqual(['y', 'z'].map(id => eng(w, id).find('OnTea').map(r => [r.method, r.refs, r.headers.Sender])),
    [[['NOTIFY', ['a'], 'Xs']], [['NOTIFY', ['a'], 'Xs']]]);
  assert.equal(y.player.plays.length, n, 'a NOTIFY\'s reply never plays');
  assert.equal(eng(w, 'x').find('OnNotifyOtherFailure').length, 0, 'Z\'s 204 is no failure');
  x.loop.raiseOther('nobody', 'OnTea', [], { notify: true });
  await raised(site);
  assert.deepEqual(eng(w, 'x').find('OnNotifyOtherFailure').map(r => r.refs), [['notfound', 'nobody', 'OnTea']]);
  assert.equal(eng(w, 'x').find('OnRaiseOtherFailure').length, 0);
  invariants(site, w);
});

test('two tags in one script run in tag order, one raise at a time for the whole page: Z is asked once Y has answered, a raise from Z waits behind them', async () => {
  const slow = deferred();
  const w = world({ answer: answers({
    'y OnFirst': () => slow.promise, 'z OnSecond': '\\0z: second\\e', 'x OnThird': '\\0x: third\\e',
  }) });
  const site = await set(w);
  const [x, , z] = site.slots;
  w.order.length = 0;
  x.loop.raiseOther('Ys', 'OnFirst', []);
  x.loop.raiseOther('Zs', 'OnSecond', []);
  z.loop.raiseOther('Xs', 'OnThird', []);
  await settle();
  const asked = () => w.order.filter(e => /On(First|Second|Third)$/.test(e));
  assert.deepEqual(asked(), ['y GET OnFirst'], 'the rest wait for Y\'s answer');
  slow.resolve('\\0y: first\\e');
  await raised(site);
  assert.deepEqual(asked(), ['y GET OnFirst', 'z GET OnSecond', 'x GET OnThird']);
  assert.equal(x.loop.current.script, '\\0x: third\\e');
  assert.equal(eng(w, 'x').find('OnRaiseOtherFailure').length + eng(w, 'z').find('OnRaiseOtherFailure').length, 0);
  invariants(site, w);
});

test('\\![timerraiseother,50,0,Ys,OnTick] with a slow Y: one OnTick at a time, none piled up; after the cancel Y gets nothing more, and other raises are not held up', async () => {
  const answersY = [];
  const w = world({ answer: answers({
    'y OnTick': () => { const d = deferred(); answersY.push(d); return d.promise; },
    'z OnTea': '\\0z: tea\\e',
  }) });
  const site = await set(w);
  const lx = loopOf(site.slots[0]);
  lx.stop();
  lx.clock = new FakeClock();                             // X's timers on a test clock
  lx.start();
  lx.timerRaise(50, '0', 'OnTick', [], { to: 'Ys' });
  await lx.clock.advance(500);
  assert.equal(eng(w, 'y').find('OnTick').length, 1, 'Y has not answered: the ticks meanwhile are skipped');
  lx.raiseOther('Zs', 'OnTea', []);                       // another raise of the page waits only for that one
  answersY.shift().resolve('\\0y: tick\\e');
  assert.ok(await until(() => eng(w, 'z').find('OnTea').length === 1), 'Z is raised next, not after a backlog');
  await lx.clock.advance(100);
  assert.equal(eng(w, 'y').find('OnTick').length, 2, 'the next tick once Y answered');
  await lx.clock.advance(100);
  lx.timerRaise(0, '', 'OnTick');                         // cancelled while Y answers the second one
  answersY.shift().resolve('\\0y: tick\\e');
  await lx.clock.advance(500);
  await settle(40);
  assert.equal(eng(w, 'y').find('OnTick').length, 2, 'nothing after the cancel');
  assert.equal(answersY.length, 0);
  assert.equal(lx.timers.size, 0);
  invariants(site, w);
});

test('a ghost whose start never ends (a call whose engine hangs) does not hold the page\'s raises and talks: X → Y still goes', async () => {
  const w = world({ answer: answers({ 'y OnTea': '\\0y: tea\\e', 'x OnA': say('\\0Hi Y.\\e', { Reference0: 'Ys' }) }) });
  const site = await set(w, ['x', 'y']);
  const x = site.slots[0];
  w.hold.z = new Promise(() => {});                       // Z's engine never answers init
  x.parts.menu._run({ type: 'callghost', id: 'z' }, 0);
  await until(() => site.slots.length === 3);
  await settle();
  assert.ok(site.slots[2]._starting && !site.slots[2]._up, 'Z is still loading its engine');
  x.loop.raiseOther('Ys', 'OnTea', []);
  assert.ok(await until(() => eng(w, 'y').find('OnTea').length === 1), 'Y is raised');
  assert.equal(eng(w, 'x').find('OnRaiseOtherFailure').length, 0);
  x.loop.raiseOther('Zs', 'OnTea', []);                   // Z is not up: no target yet, as in SSP
  assert.ok(await until(() => eng(w, 'x').find('OnRaiseOtherFailure').length === 1));
  assert.deepEqual(eng(w, 'x').find('OnRaiseOtherFailure')[0].refs, ['notfound', 'Zs', 'OnTea']);
  // a talk from X to Y does not wait for Z either (Site._upSettled, not _settled)
  await x.loop.send('OnA', []);
  x.player.finish();
  assert.ok(await until(() => eng(w, 'y').find('OnCommunicate').length === 1), 'Y gets the talk');
});

test('next page: a resumed ghost whose start never ends (a load that stalls) holds the raises and talks only for the wait (Site.upWaitMs); then X → Y goes and Z is no target', async () => {
  const w = world({ answer: answers({ 'y OnTea': '\\0y: tea\\e', 'x OnA': say('\\0Hi Y.\\e', { Reference0: 'Ys' }) }) });
  const site = await set(w);
  site._onPageHide();
  site.done();
  await settle();
  w.hold.z = new Promise(() => {});                       // the next page: Z's engine never comes, and no error says so
  const next = new TestSite(w);
  const clock = new FakeClock();
  next.clock = clock;                                     // the Site's waits on a test clock
  next.upWaitMs = 1000;
  next.start();
  assert.ok(await until(() => ['x', 'y'].every(id => loopOf(next.find(id)) && loopOf(next.find(id)).booted)));
  const [x, z] = [next.find('x'), next.find('z')];
  assert.equal(eng(w, 'x').resume, true);
  assert.ok(z._up && !loopOf(z), 'Z counts as up (a resumed page) and is still starting');
  x.loop.raiseOther('Ys', 'OnTea', []);
  await x.loop.send('OnA', []);
  x.player.finish();
  await settle(20);
  assert.equal(eng(w, 'y').find('OnTea').length, 0, 'held while Z may still come (a timer due at the resume reaches it)');
  assert.equal(eng(w, 'y').find('OnCommunicate').length, 0);
  await clock.advance(1000);
  assert.ok(await until(() => eng(w, 'y').find('OnTea').length === 1), 'then Y is raised');
  assert.ok(await until(() => eng(w, 'y').find('OnCommunicate').length === 1), 'and gets the talk');
  assert.equal(eng(w, 'x').find('OnRaiseOtherFailure').length, 0);
  x.loop.raiseOther('Zs', 'OnTea', []);                   // Z is no target until it is up
  assert.ok(await until(() => eng(w, 'x').find('OnRaiseOtherFailure').length === 1), 'no wait for Z any more');
  assert.deepEqual(eng(w, 'x').find('OnRaiseOtherFailure')[0].refs, ['notfound', 'Zs', 'OnTea']);
});

test('a takeover: a ghost still waiting for its lock (a tab on the one-ghost runtime holds it) is waited for, so X → Y goes once Y is up', async () => {
  const w = world({ answer: answers({ 'y OnTea': '\\0y: tea\\e' }) });
  const a = await set(w, ['x', 'y']);
  const b = new TestSite(w, { hidden: true });
  assert.equal(await b.start(), 'frozen');
  let letGo = null;
  w.locks.request('sumika:y', {}, () => new Promise(r => { letGo = r; }));   // that tab takes Y as soon as A lets it go
  a.doc.hidden = true;
  b.show(true);
  assert.ok(await until(() => loopOf(b.find('x')) && loopOf(b.find('x')).booted));
  assert.ok(letGo, 'the other tab holds Y');
  const by = b.find('y');
  assert.ok(by._up && !by._starting && !loopOf(by), 'Y counts as up and waits for its lock (Site._runSet: _resuming)');
  b.find('x').loop.raiseOther('Ys', 'OnTea', []);
  await settle(20);
  assert.equal(eng(w, 'x').find('OnRaiseOtherFailure').length, 0, 'no notfound: the raise waits for Y');
  letGo();
  assert.ok(await until(() => loopOf(b.find('y')) && loopOf(b.find('y')).booted));
  assert.ok(await until(() => eng(w, 'y').find('OnTea').length === 1), 'Y is raised once it is up');
  assert.equal(eng(w, 'y').resume, true);
  assert.equal(eng(w, 'x').find('OnRaiseOtherFailure').length, 0);
  await quiet(b);
  invariants(b, w);
});

test('\\![timerraiseother,2000,1,Ys,OnT] from X: stored with its target; the page changes first; on the next page (overdue) Y gets OnT once the set has started', async () => {
  const T0 = new Date(2026, 9, 10, 12, 0, 0).getTime();
  const real = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const w = world({ answer: answers({ 'y OnT': r => `\\0y: OnT from ${r.headers.Sender}\\e` }) });
    const site = await set(w, ['x', 'y']);
    loopOf(site.slots[0]).timerRaise(2000, '1', 'OnT', ['a'], { to: 'Ys' });     // what the player does at the tag
    site._onPageHide();
    site.done();
    await settle();
    const saved = JSON.parse(localStorage.getItem(stateKey('x'))).timers;
    assert.deepEqual(saved.map(t => [t.ev, t.to, t.repeat, t.kind, t.intervalMs]), [['OnT', 'Ys', false, 'raise', 2000]]);
    assert.equal(eng(w, 'y').find('OnT').length, 0, 'not on the first page');

    now = T0 + 3000;                                      // the next page comes after OnT's time
    const gate = deferred();
    w.hold.y = gate.promise;                              // and Y's engine is slow to start there
    const next = new TestSite(w);
    const started = next.start();
    await until(() => loopOf(next.find('x')) && loopOf(next.find('x')).booted);
    await settle();
    assert.equal(eng(w, 'x').resume, true);
    assert.equal(loopOf(next.find('x')).timers.size, 0, 'fired at the resume\'s boot');
    assert.equal(eng(w, 'x').find('OnRaiseOtherFailure').length, 0, 'it waits for the set (Y is not up yet)');
    gate.resolve();
    delete w.hold.y;
    assert.equal(await started, 'booted');
    await idle(next);
    await raised(next);
    assert.deepEqual(eng(w, 'y').find('OnT').map(r => [r.method, r.refs, r.headers.Sender]), [['GET', ['a'], 'Xs']]);
    assert.equal(eng(w, 'y').resume, true);
    assert.equal(next.find('y').loop.current.script, '\\0y: OnT from Xs\\e');
    assert.equal(eng(w, 'x').find('OnRaiseOtherFailure').length, 0);
    invariants(next, w);
  } finally {
    Date.now = real;
  }
});

// ---------------------------------------------------------------- 11: Satori's FMO view (EV §2.7.8)

test('FMO: X\'s requests list X, then Y and Z in set order; Y\'s list Y first; after Y\'s Close the next one lacks Y; a YAYA ghost is listed but reads none', async () => {
  const w = world({ ghosts: GHOSTS.map(g => (g.id === 'z' ? ghost('z', { shiori: 'yaya.dll', engine: 'yaya' }) : g)) });
  const site = await set(w);
  const [x, y] = site.slots;
  await x.loop.send('OnA', []);
  const text = eng(w, 'x').find('OnA')[0].fmo;
  assert.deepEqual(fmo(text, 'name'), ['Xs', 'Ys', 'Zs']);
  assert.deepEqual(fmo(text, 'fullname'), ['Ghost X', 'Ghost Y', 'Ghost Z']);
  assert.deepEqual(fmo(text, 'ghostpath'), ['/', '/ssp/ghost/y/', '/ssp/ghost/z/'], 'the reader finds itself by /');
  assert.deepEqual(fmo(text, 'sakura.surface'), ['0', '0', '0']);
  assert.deepEqual(fmo(text, 'kero.surface'), ['10', '10', '10']);
  assert.deepEqual(fmo(text, 'keroname'), [], 'no kero names: no line');
  await y.loop.send('OnA', []);
  assert.deepEqual(fmo(eng(w, 'y').find('OnA')[0].fmo, 'name'), ['Ys', 'Xs', 'Zs']);
  assert.ok(eng(w, 'z').log.every(r => !('fmo' in r)), 'YAYA gets none');
  await loopOf(y).close(0);
  quitRun(y);
  await until(() => site.slots.length === 2);
  await x.loop.send('OnB', []);
  assert.deepEqual(fmo(eng(w, 'x').find('OnB')[0].fmo, 'name'), ['Xs', 'Zs']);
  invariants(site, w);
});

test('a Satori request still queued when its ghost is torn down reads no FMO: the dead stage gets no new character view', async () => {
  const w = world();
  w.shells = { x: { 0: [100, 200], 10: [50, 60] } };      // x on a real (headless) Stage
  const site = await set(w, ['x', 'y']);
  const x = site.find('x');
  const loop = loopOf(x);
  const stage = x.parts.stage;
  // the real client, on a worker that has not answered yet (an engine busy with OnMouseMove, say)
  const client = new ShioriClient('http://s/sumika/engines/worker.js', { onLog: () => {} });
  client.worker = { postMessage() {}, terminate() {} };
  loop.setShiori(client);
  x.parts.client = client;
  const a = loop.send('OnMouseMove', ['1', '1']);         // in flight
  const b = loop.send('OnSecondChange', []);              // queued behind it
  await settle();
  assert.ok(stage._views.size > 0);
  x._teardown();                                          // Site.restart() (a bfcache pageshow), a slot removed
  assert.equal(stage._views.size, 0);
  await Promise.allSettled([a, b]);
  await settle();
  assert.equal(stage._views.size, 0, 'no view made on the destroyed stage');
  assert.equal(loop._fmoSource(), null, 'a torn-down loop has no FMO text');
  assert.deepEqual(loop.peerInfo().surfaces, [-1, -1], 'peerInfo() reads no view it would have to make');
  assert.equal(stage._views.size, 0);
});

test('otherghostname as SSP re-sends it: a cold-booting ghost gets a second one after its boot GET; a shell change tells every ghost, itself too, so a shell\'s sakura.name is the name the others aim at', async () => {
  const orig = TestRuntime.prototype._createStage;
  TestRuntime.prototype._createStage = async function (opts) {
    const s = await orig.call(this, opts);
    if (opts && opts.shellId === 'alt') s.shell = { ...s.shell, descript: new Map([['sakura.name', 'AltName']]) };
    return s;
  };
  try {
    const shells = [{ id: 'master', name: 'y-shell' }, { id: 'alt', name: 'alt-shell' }];
    const w = world({
      ghosts: GHOSTS.map(g => (g.id === 'y' ? ghost('y', { shells }) : g)),
      answer: answers({ 'x OnA': say('\\0Hi.\\e', { Reference0: 'AltName' }) }),
    });
    const site = await set(w, ['x', 'y']);
    const [x, y] = site.slots;
    const refs = id => eng(w, id).find('otherghostname').map(r => r.refs);
    const X = 'Xs\x010\x0110';
    // AddGhost posts the re-send to every ghost, the new one included, then asks its boot event before SSP reads its
    // messages [disasm 0x465C4F, 0x733045, 0x465CA3]
    assert.deepEqual(refs('x'), [[], [], ['Ys\x010\x0110']], 'X: its batch, after its own boot GET, after Y\'s');
    assert.deepEqual(refs('y'), [[X], [X]], 'Y: its batch, then a second one');
    const onBoot = w.order.indexOf('y GET OnBoot');
    assert.ok(w.order.indexOf('y NOTIFY otherghostname') < onBoot, 'its batch first');
    assert.ok(w.order.lastIndexOf('y NOTIFY otherghostname') > onBoot, 'the second one after its boot GET');
    assert.ok(w.order.lastIndexOf('x NOTIFY otherghostname') > onBoot, 'X\'s too');

    assert.equal(await y._requestView({ kind: 'shell', target: 'alt', byId: true, raiseEvent: false }), true);
    await quiet(site);
    assert.equal(loopOf(y).peerInfo().sakuraName, 'AltName');
    assert.equal(refs('x').length, 4, 'X told of the change [disasm 0x62177D]');
    assert.match(refs('x').at(-1)[0], /^AltName\x01/);
    assert.deepEqual(refs('y').length, 3, 'Y itself too');
    assert.deepEqual(refs('y').at(-1), [X]);
    // Satori's → takes its target from otherghostname: the new name reaches Y
    await x.loop.send('OnA', []);
    x.player.finish();
    await settle();
    assert.equal(eng(w, 'y').find('OnCommunicate').length, 1);
    invariants(site, w);
  } finally {
    TestRuntime.prototype._createStage = orig;
  }
});

test('next page: a ghost whose loop is not up yet is listed by its stored names in effect (a shell\'s sakura.name), so a → aimed by otherghostname still reaches it', async () => {
  const orig = TestRuntime.prototype._createStage;
  const origCommon = TestRuntime.prototype._ghostCommon;
  // the shell picked boots again on the next page (multi_world's own _ghostCommon always boots master)
  TestRuntime.prototype._ghostCommon = async function () {
    const c = await origCommon.call(this);
    const d = this.state && this.state.data;
    return { ...c, shellId: (d && d.shellChosen && d.shell) || 'master' };
  };
  TestRuntime.prototype._createStage = async function (opts) {
    const s = await orig.call(this, opts);
    if (opts && opts.shellId) s.shellId = opts.shellId;    // the shell it was made of (FakeStage says master)
    if (opts && opts.shellId === 'alt') s.shell = { ...s.shell, descript: new Map([['sakura.name', 'AltName']]) };
    return s;
  };
  try {
    let target = '';
    const shells = [{ id: 'master', name: 'y-shell' }, { id: 'alt', name: 'alt-shell' }];
    const w = world({
      ghosts: GHOSTS.map(g => (g.id === 'y' ? ghost('y', { shells }) : g)),
      answer: answers({ 'x OnA': () => say('\\0Hi.\\e', { Reference0: target }) }),
    });
    const site = await set(w, ['x', 'y']);
    assert.equal(await site.find('y')._requestView({ kind: 'shell', target: 'alt', byId: true, raiseEvent: false }), true);
    await quiet(site);
    site._onPageHide();
    site.done();
    await settle();

    const gate = deferred();
    const next = new TestSite(w);
    next.hold.y = gate.promise;                           // Y's files come after X's batch
    const started = next.start();
    assert.ok(await until(() => loopOf(next.find('x')) && loopOf(next.find('x')).booted));
    assert.equal(eng(w, 'x').resume, true);
    assert.ok(!loopOf(next.find('y')), 'Y\'s loop is not up yet');
    const told = eng(w, 'x').find('otherghostname').map(r => r.refs);
    assert.equal(told.length, 1, 'no re-send on a resumed page');
    assert.match(told[0][0], /^AltName\x01/, 'the name in effect when the last page was left, not the index\'s Ys');
    gate.resolve();
    assert.equal(await started, 'booted');
    await quiet(next);
    assert.equal(loopOf(next.find('y')).peerInfo().sakuraName, 'AltName');
    // Satori's → takes its target from otherghostname: it reaches Y, as on the first page
    target = told[0][0].split('\x01')[0];
    await next.find('x').loop.send('OnA', []);
    await quiet(next);
    assert.equal(eng(w, 'y').find('OnCommunicate').length, 1);
    invariants(next, w);
  } finally {
    TestRuntime.prototype._createStage = orig;
    TestRuntime.prototype._ghostCommon = origCommon;
  }
});

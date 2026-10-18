// The EventLoop's side of ghosts interacting (shiori-events.md §2.7.7–§2.7.9), on fakes with a stand-in `peers`:
// COMMUNICATE (the pending slot, what takes it, when it goes, the 'talk' flags, the run's carry across a page), the
// receiver (communicated, raisedByOther, notifyEvent, lockReason), raiseOther and the timers (C8), and the FMO text a
// Satori ghost's requests carry. The site's routing is tests/runtime/interact.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLoop, communicateOf } from '../../src/core/events.js';
import { fmoText } from '../../src/core/fmo.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { buildRequest } from '../../src/core/shiori.js';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, deferred, settle } from './fakes.mjs';

const X = { id: 'x', name: 'Ghost X', sakuraName: 'Xs', keroName: 'Xk', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };
const ALL = '__SYSTEM_ALL_GHOST__';

/** The site's handle as a stand-in: Y and Z on screen; match() by exact sakura name (ghostset.js does SSP's compare). */
function stubPeers(list = [
  { id: 'y', name: 'Ghost Y', sakuraName: 'Ys', keroName: '', surfaces: [3, -1], shell: 'master' },
  { id: 'z', name: 'Ghost Z', sakuraName: 'Zs', keroName: 'Zk', surfaces: [5, 15], shell: 'master' },
]) {
  const p = {
    list, asked: [],
    others: () => p.list,
    count: () => p.list.length + 1,
    busy: () => false,
    match: to => {
      p.asked.push(to);
      if (to === ALL) return p.list.map(g => g.id);
      return String(to).split('\x01').map(n => (p.list.find(g => g.sakuraName === n) || {}).id).filter(Boolean);
    },
  };
  return p;
}

function make({ handler = () => null, ghost = X, peers, descript = [], storage = memoryStorage() } = {}) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const player = new FakePlayer();
  const state = new StateStore(ghost.id, { storage, clock });
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost, state, clock,
    env: { win: null, doc: null }, sessionEpochMs: clock.now(), site: { ghosts: [ghost], balloons: [] },
    ghostDescript: new Map([['name', ghost.name], ['sakura.name', ghost.sakuraName], ['kero.name', ghost.keroName || ''], ...descript]),
    peers: peers === undefined ? stubPeers() : peers,
  });
  const seen = [];
  for (const type of ['talk', 'communicate', 'raiseother', 'closed']) loop.on(type, e => seen.push([type, e]));
  return { clock, shiori, player, state, storage, loop, seen, peers: loop.peers };
}

async function booted(o) {
  const t = make(o);
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  t.seen.length = 0;
  return t;
}

/** A response with a script and headers (FakeShiori lower-cases their names). */
const reply = (value, headers = {}, status = 200) => ({ status, value, headers });
/** handler helper: {id: answer | fn(req)} */
const answers = map => r => (typeof map[r.id] === 'function' ? map[r.id](r) : map[r.id] ?? null);
const res = (status, headers) => ({ status, headers: new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });
const kinds = t => t.seen.map(([type, e]) => (type === 'talk' ? `${e.phase}:${e.flags}` : type));

test('communicateOf: SSP\'s headers in SSP\'s order (A2–A5) [disasm 0x70F620]', () => {
  const base = { Value: '\\0hi\\e', Reference0: 'Ys' };
  assert.deepEqual(communicateOf(res(200, base)), { to: 'Ys', shifted: true, sentence: '\\0hi\\e', refs: [], age: '0', marker: '' });
  for (const st of [204, 400, 404, 500]) assert.equal(communicateOf(res(st, base)), null, `status ${st}`);
  for (const st of [201, 310, 311, 312]) assert.ok(communicateOf(res(st, base)), `status ${st}`);
  // Reference0 as target: the References go on from Reference1, up to the highest one, a gap kept as ''
  // (GetValueReference [disasm 0x6AEC60]; Satori drops an empty ＄ValueN: Northern sets ＄Value0/1/3/4)
  assert.deepEqual(communicateOf(res(200, { ...base, Reference1: 'a', Reference2: 'b', Reference4: 'gap' })).refs, ['a', 'b', '', 'gap']);
  assert.deepEqual(communicateOf(res(200, { ...base, Reference1: 'ECHO/1.0', Reference3: 'a', Reference4: 'b' })).refs,
    ['ECHO/1.0', '', 'a', 'b']);
  // To wins when it differs, and every Reference is passed on unshifted; equal: shifted
  assert.deepEqual(communicateOf(res(200, { Value: 'v', To: 'Ys', Reference0: 'Zs', Reference1: 'a' })),
    { to: 'Ys', shifted: false, sentence: 'v', refs: ['Zs', 'a'], age: '0', marker: '' });
  assert.deepEqual(communicateOf(res(200, { Value: 'v', To: 'Ys', Reference0: 'Ys', Reference1: 'a' })).refs, ['a']);
  assert.deepEqual(communicateOf(res(200, { Value: 'v', To: 'Ys', Reference1: 'a' })).refs, ['', 'a'], 'To alone: from Reference0');
  // the index as strtoul reads it, in header order (a later one wins); above 100000 or negative: skipped
  assert.deepEqual(communicateOf(res(200, { Value: 'v', To: 'Ys', Reference02: 'b', 'Reference 1': 'a', Reference2: 'c' })).refs,
    ['', 'a', 'c']);
  assert.deepEqual(communicateOf(res(200, { Value: 'v', To: 'Ys', Reference100001: 'x', Reference1: 'a' })).refs, ['', 'a']);
  assert.deepEqual(communicateOf(res(200, { Value: 'v', To: 'Ys', 'Reference-1': 'y', Reference2: 'b' })).refs, ['', '', 'b'],
    'Reference-1 is not Reference1');
  // Sentence stands in for Value; an empty Value is a Value; none: nothing
  assert.equal(communicateOf(res(200, { Sentence: 's', Reference0: 'Ys' })).sentence, 's');
  assert.equal(communicateOf(res(200, { Value: '', Reference0: 'Ys' })).sentence, '');
  assert.equal(communicateOf(res(200, { Reference0: 'Ys' })), null);
  assert.equal(communicateOf(res(200, { Value: 'v' })), null, 'no target');
  // Age copied (never +1), MarkerSend
  assert.deepEqual(communicateOf(res(200, { ...base, Age: '3', MarkerSend: 'from X' })).age, '3');
  assert.deepEqual(communicateOf(res(200, { ...base, MarkerSend: 'from X' })).marker, 'from X');
  // a window handle decides alone, with a Value
  assert.deepEqual(communicateOf(res(200, { ...base, HWnd: '1000' })), { hwnd: true });
  assert.deepEqual(communicateOf(res(200, { Value: 'v', To: 'Ys', TargetHWnd: '0' })), { hwnd: true });
  assert.equal(communicateOf(res(200, { HWnd: '1000', Reference0: 'Ys' })), null);
  assert.equal(communicateOf(null), null);
  assert.equal(communicateOf({ status: 200, value: 'v' }), null, 'no headers');
  // a SHIORI/2.x reply (the bridge keeps its status line: res.protocol 2.6): the target is To only, every Reference
  // passed on unshifted [disasm SendCommunicate 0x711878–0x7118c3]
  const v2 = (headers, status = 200) => ({ ...res(status, headers), protocol: 2.6 });
  assert.equal(communicateOf(v2(base)), null, 'Reference0 is no target');
  assert.deepEqual(communicateOf(v2({ Value: 'v', To: 'Ys', Reference0: 'Ys', Reference1: 'a', Age: '1' })),
    { to: 'Ys', shifted: false, sentence: 'v', refs: ['Ys', 'a'], age: '1', marker: '' });
  assert.equal(communicateOf(v2({ Sentence: 's', To: 'Ys' })).sentence, 's');
  assert.equal(communicateOf(v2({ Value: 'v', To: 'Ys' }, 204)), null);
  assert.equal(communicateOf({ ...res(200, base), protocol: 3 }).to, 'Ys', 'SHIORI/3.0: Reference0 is');
});

test('the pending slot: filled when a response names other ghosts, taken by the next script, overwritten, kept', async () => {
  const t = await booted({
    handler: answers({
      OnMouseDoubleClick: reply('\\0To Y.\\e', { Reference0: 'Ys', Reference1: 'r1', Age: '2', MarkerSend: 'mk' }),
      OnA: reply('one', { Reference0: 'Ys' }),
      OnB: reply('two', { To: `Zs\x01Ys` }),
      OnNobody: reply('\\0x\\e', { Reference0: 'Ws' }),
      OnPlain: reply('', {}),
    }),
  });
  await t.loop.send('OnMouseDoubleClick', [0, 0, 0, 0, '', 0, 'mouse']);
  await settle();
  assert.deepEqual(t.loop.current.communicate, {
    ids: ['y'], sender: 'Xs', sentence: '\\0To Y.\\e', refs: ['r1'], age: '2', surface: '0\x0110', marker: 'mk',
  });
  assert.equal(t.loop._comm, null, 'taken');
  // a NOTIFY's response counts (SPShiori::Request), the next one overwrites; one naming nobody leaves it as it was
  await t.loop.send('OnA', [], { method: 'NOTIFY' });
  await t.loop.send('OnB', [], { method: 'NOTIFY' });
  await t.loop.send('OnNobody', [], { method: 'NOTIFY' });
  await t.loop.send('OnPlain', [], { method: 'NOTIFY' });
  assert.deepEqual(t.loop._comm.ids, ['z', 'y']);
  assert.equal(t.loop._comm.sentence, 'two');
  assert.deepEqual(t.peers.asked, ['Ys', 'Ys', `Zs\x01Ys`, 'Ws'], 'targets resolved when the response arrives');
  // whatever script comes next takes it (SSP's "leak"): here one the page starts
  const run = t.loop.playScript('\\0Something else\\e');
  assert.equal(run.communicate.sentence, 'two');
  assert.equal(t.loop.playScript('\\0And then\\e').communicate, null, 'once');
  // the surfaces when the response arrived, -1 for none
  t.loop.stage.chars.get(1).surfaceId = -1;
  await t.loop.send('OnA', [], { method: 'NOTIFY' });
  assert.equal(t.loop._comm.surface, '0\x01-1');
  // HWnd: no windows here, the slot is emptied [decision]
  t.shiori.handler = () => reply('v', { HWnd: '1000' });
  await t.loop.send('OnH', [], { method: 'NOTIFY' });
  assert.equal(t.loop._comm, null);
});

test('never from the NOTIFY batch, otherghostname or resource strings; never alone (no peers.match)', async () => {
  const all = () => reply('\\0v\\e', { Reference0: 'Ys' });
  const t = make({ handler: r => (r.id === 'OnBoot' || r.id.startsWith('OnSurface') ? null : all()) });
  await t.loop.boot({ resume: false });
  assert.equal(t.loop._comm, null, 'version, the batch (otherghostname, ownerghostname …)');
  await t.loop.resource('username');
  assert.equal(t.loop._comm, null, '%username\'s GET username (a resource)');
  assert.equal(await t.loop.expand('%property[currentghost.ext.k]'), '\\0v\\e');
  await t.loop.setProperty('currentghost.ext.k', 'v');
  await t.loop.notifyUserInfo();
  assert.equal(t.loop._comm, null, 'property.get / property.set and OnNotifyUserInfo');
  await t.loop.notifyOthers();
  await t.loop.resource('sakura.recommendsites');
  await t.loop.resources(['a', 'b']);
  assert.equal(t.loop._comm, null);
  assert.deepEqual(t.peers.asked, []);

  for (const peers of [null, { others: () => [], count: () => 1, busy: () => false }]) {
    const a = await booted({ handler: all, peers });
    await a.loop.send('OnA', [], { method: 'NOTIFY' });
    assert.equal(a.loop._comm, null, 'alone');
    a.loop.destroy();
  }
});

test('never from the tooltips: balloon_tooltip and tooltip are GetStringShiori reads; the hover events are events', async () => {
  const named = (value, to = 'Ys') => reply(value, { Reference0: to, To: to });
  const t = await booted({ handler: r => (r.id === 'balloon_tooltip' || r.id === 'tooltip' ? named('tip') : null) });
  assert.equal(await t.loop.balloons.tipSource({ kind: 'choice', id: 'a', refs: [], label: 'A', scope: 0 }), 'tip');
  assert.equal(await t.loop.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: true }), 'tip');
  assert.deepEqual(t.shiori.ids(), ['GET OnChoiceHover', 'GET balloon_tooltip', 'GET OnMouseHover', 'GET tooltip']);
  assert.equal(t.loop._comm, null, 'GetStringShiori never reaches SendCommunicate [disasm 0x71234F]');
  assert.deepEqual(t.peers.asked, []);
  // the hover events go through SPShiori::Request like every event: their reply's target counts
  t.shiori.handler = r => (r.id === 'OnChoiceHover' ? named('\\0hover\\e', 'Zs') : null);
  await t.loop.balloons.tipSource({ kind: 'choice', id: 'b', refs: [], label: 'B', scope: 0 });
  assert.deepEqual(t.peers.asked, ['Zs']);
  assert.deepEqual(t.loop.current.communicate.ids, ['z'], 'its run took it');
});

test('the event\'s record goes with its script; an OnTranslate response with its own target waits for the next', async () => {
  const t = await booted({
    handler: answers({
      OnKeyPress: reply('\\0key\\e', { Reference0: 'Ys' }),
      OnTranslate: r => reply(`${r.refs[0]}!`, { Reference0: 'Zs' }),
    }),
  });
  await t.loop.send('OnKeyPress', ['a']);
  await settle();
  assert.equal(t.loop.current.script, '\\0key\\e!');
  assert.deepEqual(t.loop.current.communicate.ids, ['y'], 'taken before OnTranslate, as SSP queues it first');
  assert.deepEqual(t.loop.current.communicate.sentence, '\\0key\\e', 'the raw Value, before OnTranslate');
  assert.deepEqual(t.loop._comm.ids, ['z']);
  assert.deepEqual(t.loop.playScript('\\0next\\e').communicate.ids, ['z']);
});

test('a reply that is not played (a tick while something else started) leaves the slot for the next script', async () => {
  const slow = deferred();
  const t = await booted({ handler: answers({ OnSecondChange: () => slow.promise }) });
  await t.clock.advance(1100);                         // GET OnSecondChange is on its way
  t.loop.playScript('\\0meanwhile\\e');
  slow.resolve(reply('\\0tick\\e', { Reference0: 'Ys' }));
  await settle();
  assert.equal(t.loop.current.script, '\\0meanwhile\\e', 'the tick reply is dropped');
  assert.equal(t.loop.current.communicate, null);
  assert.equal(t.loop._comm.sentence, '\\0tick\\e');
  assert.equal(t.loop.playScript('\\0later\\e').communicate.sentence, '\\0tick\\e');
  // a minimized ghost queues nothing: the slot stays
  t.loop.minimized = { reason: 'user', scopes: [0] };
  t.shiori.handler = () => reply('v', { Reference0: 'Ys' });
  await t.loop.send('OnA', [], { method: 'NOTIFY' });
  assert.equal(t.loop.playScript('\\0hidden\\e').communicate, null);
  assert.ok(t.loop._comm);
});

test('\\![raise], a reply that waits for its script (shell change) and a choice\'s script: take it as they queue', async () => {
  const t = await booted({
    handler: answers({ OnR: reply('\\0raised\\e', { Reference0: 'Ys' }), OnShellChanged: reply('\\0new shell\\e', { Reference0: 'Zs' }) }),
  });
  t.loop.playScript('\\0a\\![raise,OnR]b\\e');
  await t.loop.raise('OnR', []);
  await settle();
  assert.equal(t.loop.current.script, '\\0raised\\e');
  assert.deepEqual(t.loop.current.communicate.ids, ['y']);
  // OnShellChanged after a script's \![change,shell]: queued now, played when the script ends, with its record
  t.loop.playScript('\\0still talking\\e');
  await t.loop.shellChanged({ defer: true });
  assert.equal(t.loop._comm, null, 'the queued reply took it');
  t.player.finish();
  await settle();
  assert.equal(t.loop.current.script, '\\0new shell\\e');
  assert.deepEqual(t.loop.current.communicate.ids, ['z']);
});

test('a reply a shell swap holds keeps the record it took: it plays at the swap\'s end and passes the talk on', async () => {
  const t = await booted({ handler: answers({ OnKeyPress: reply('\\0Hi Y.\\e', { Reference0: 'Ys' }) }) });
  const shown = t.loop.detachStage();
  assert.equal(t.loop.swapping, true);
  await t.loop.send('OnKeyPress', ['a', '65', '1']);
  assert.equal(t.loop._comm, null, 'taken by the held reply');
  assert.equal(t.player.plays.length, 0, 'nothing plays during the swap');
  t.loop.attachStage(new FakeStage(), { id: 'alt', name: 'Winter', path: '/ghost/x/shell/alt/' });
  await t.loop.shellChanged({ surfaces: shown, event: false });
  await settle();
  assert.equal(t.loop.current.script, '\\0Hi Y.\\e');
  assert.deepEqual(t.loop.current.communicate.ids, ['y']);
  t.player.finish();
  await settle();
  assert.deepEqual(kinds(t).slice(-3), ['before:communicate', 'after:communicate', 'communicate']);
});

test('\'communicate\' at the run\'s end only (A8): after the \'talk\' after event, once, and the flags (A12)', async () => {
  const talker = async () => {
    const t = await booted({ handler: answers({ OnTalk: reply('\\0Hi Y.\\e', { Reference0: 'Ys' }) }) });
    await t.loop.send('OnTalk', []);
    await settle();
    return { t, run: t.loop.current };
  };
  let { t, run } = await talker();
  t.player.finish();
  await settle();
  assert.deepEqual(kinds(t), ['before:communicate', 'after:communicate', 'communicate']);
  const ev = t.seen[2][1];
  assert.equal(ev.run, run);
  assert.deepEqual(ev.communicate.ids, ['y']);
  assert.equal(run.communicate, null, 'taken off the run: it goes once');

  // broken: interrupted (a balloon break, a choice clicked while it typed), replaced, \-, an error, \![change,ghost]
  const broken = [
    ['interrupted', x => x.player.interrupt(), ['before:communicate', 'after:communicate,break']],
    ['replaced', x => x.loop.playScript('\\0other\\e'), ['before:communicate', 'before:', 'after:communicate,break']],
    ['quit', x => { x.player.busy = false; x.player.cur.resolve({ reason: 'quit', hasChoices: false }); },
      ['before:communicate', 'after:communicate', 'closed']],
    ['failed', x => { x.player.busy = false; x.player.cur.resolve({ reason: 'end', hasChoices: false, failed: true }); },
      ['before:communicate', 'after:communicate']],
    ['change ghost', x => { assert.equal(x.loop.change('ghost', ['Ghost Y']), undefined); x.player.finish(); },
      ['before:communicate', 'after:communicate,break']],
  ];
  for (const [name, end, flags] of broken) {
    ({ t, run } = await talker());
    end(t);
    await settle();
    assert.deepEqual(kinds(t), flags, name);
    assert.equal(run.communicate, null, name);
    t.loop.destroy();
  }
  // a run without one: '' both times; broken: break
  t = await booted();
  t.loop.playScript('\\0plain\\e');
  t.player.interrupt();
  await settle();
  assert.deepEqual(kinds(t), ['before:', 'after:break']);

  // choices on screen: at once, before the pick
  ({ t } = await talker());
  t.player.finish({ hasChoices: true });
  await settle();
  assert.deepEqual(kinds(t), ['before:communicate', 'after:communicate', 'communicate']);
  assert.equal(t.loop.choicesLive, true);
});

test('\\![change,ghost] breaks its run only when the runtime finds that ghost (ghostFinder); GetGhostIDFromTag\'s -1 leaves it unbroken [disasm 0x62AEEA]', async () => {
  for (const [found, flags] of [
    [false, ['before:communicate', 'after:communicate', 'communicate']],
    [true, ['before:communicate', 'after:communicate,break']],
  ]) {
    const t = await booted({ handler: answers({ OnTalk: reply('\\0Hi Y.\\e', { Reference0: 'Ys' }) }) });
    const asked = [];
    const changes = [];
    t.loop.ghostFinder = (target, o) => { asked.push([target, o]); return found; };
    t.loop.on('change', e => changes.push(e.target));
    await t.loop.send('OnTalk', []);
    await settle();
    assert.equal(t.loop.change('ghost', ['Somebody', '--option=raise-event']), undefined);
    t.player.finish();
    await settle();
    assert.deepEqual(kinds(t), flags, `found: ${found}`);
    assert.deepEqual(asked, [['Somebody', { byId: false }]]);
    assert.deepEqual(changes, ['Somebody'], 'the runtime is asked either way');
    t.loop.destroy();
  }
});

test('a Quit\'s goodbye without \\- passes its talk on, then the ghost closes; a Close of one stays standing', async () => {
  const t = await booted({ handler: answers({ OnCloseAll: reply('\\0Bye, Y.\\e', { Reference0: 'Ys' }) }) });
  await t.loop.close(0, { all: true });
  await settle();
  t.player.finish();
  await settle();
  assert.deepEqual(kinds(t), ['before:communicate', 'after:communicate', 'communicate', 'closed']);
  assert.ok(t.loop.closed);

  const one = await booted({ handler: answers({ OnClose: reply('\\0See you.\\e', { Reference0: 'Ys' }) }) });
  await one.loop.close(0);                              // peers.count() 3: a Close of one
  await settle();
  one.player.finish();
  await settle();
  assert.deepEqual(kinds(one), ['before:communicate', 'after:communicate', 'communicate']);
  assert.equal(one.loop.closed, false);
});

test('a page change: the record rides with the running run, goes at the replay\'s end, and never twice', async () => {
  const storage = memoryStorage();
  const t = await booted({ storage, handler: answers({ OnA: reply('\\0to Y\\e', { Reference0: 'Ys', Reference1: 'r' }) }) });
  await t.loop.send('OnA', [], { method: 'NOTIFY' });
  t.loop.playScript('\\0Still talking\\e', { event: 'OnTalk' });
  const rec = t.loop.current.communicate;
  t.state.saveNow();
  assert.deepEqual(JSON.parse(storage.getItem('sumika:ghost:x:state')).run.communicate, rec);
  t.loop.destroy();

  const next = make({ storage });
  await next.loop.boot({ resume: true });
  assert.equal(next.player.replays.length, 1);
  assert.deepEqual(next.loop.current.communicate, rec);
  next.player.finish();
  await settle();
  assert.deepEqual(kinds(next), ['communicate'], 'no OnOtherGhostTalk for a replay; the talk goes on');
  assert.deepEqual(next.seen[0][1].communicate, rec);
  next.state.saveNow();
  const saved = JSON.parse(storage.getItem('sumika:ghost:x:state')).run;
  assert.ok(saved && saved.state === 'finished', 'kept while its balloon is up');
  assert.equal(saved.communicate, undefined);
  next.loop.destroy();

  const third = make({ storage });
  await third.loop.boot({ resume: true });
  third.player.finish();
  await settle();
  assert.deepEqual(kinds(third), []);
  third.loop.destroy();

  // a malformed record is dropped
  const bad = memoryStorage();
  const run = { src: '\\0x\\e', ip: 1, state: 'running', communicate: { ids: 'y', sender: 'Xs' } };
  bad.setItem('sumika:ghost:x:state', JSON.stringify({ v: 1, run }));
  const b = make({ storage: bad });
  await b.loop.boot({ resume: true });
  assert.equal(b.loop.current.communicate, null);
  b.loop.destroy();

  // a replay never takes the pending slot: it has its own record, or none
  const r = await booted({ handler: answers({ OnA: reply('v', { Reference0: 'Zs' }) }) });
  await r.loop.send('OnA', [], { method: 'NOTIFY' });
  r.loop._replay({ src: '\\0x\\e', ip: 1, state: 'running' });
  assert.equal(r.player.replays.length, 1);
  assert.equal(r.loop.current.communicate, null);
  assert.deepEqual(r.loop._comm.ids, ['z']);
  r.loop.destroy();
});

test('communicated(): GET OnCommunicate [sender, sentence, refs…], external,sstp,communicate, Age / Surface / Marker (A10)', async () => {
  const rec = { ids: ['x'], sender: 'Ys', sentence: '\\0Hello, X.\\e', refs: ['a', 'b'], age: '0', surface: '3\x01-1', marker: '' };
  const t = await booted({ handler: answers({ OnCommunicate: reply('\\0Hello, Y.\\e', { Reference0: 'Ys' }) }) });
  t.loop.playScript('\\0my own talk\\e');
  assert.deepEqual(await t.loop.communicated(rec), { status: 200, played: true });
  const r = t.shiori.find('OnCommunicate')[0];
  assert.deepEqual(r.refs, ['Ys', '\\0Hello, X.\\e', 'a', 'b']);
  assert.equal(r.method, 'GET');
  assert.deepEqual([r.headers.SenderType, r.headers.Age, r.headers.Surface, r.headers.Marker],
    ['external,sstp,communicate', '0', '3\x01-1', undefined]);
  const text = buildRequest(r, { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' });
  assert.match(text, /\r\nSender: SSP\r\n/);
  assert.match(text, /\r\nSecurityLevel: local\r\n/);
  await settle();
  assert.equal(t.loop.current.script, '\\0Hello, Y.\\e', 'the reply cuts what it was saying');
  assert.deepEqual(t.loop.current.communicate.ids, ['y'], 'its own target: the next turn');
  t.player.finish();
  await settle();
  assert.deepEqual(kinds(t).slice(-1), ['communicate']);

  // a Marker when given; the reply cuts a menu, a \t script and a Close of one's goodbye too [decision: as ssp.exe]
  t.loop.playScript('\\0menu\\q[a,b]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  assert.equal(t.loop.choicesLive, true);
  await t.loop.communicated({ ...rec, marker: 'from Y', age: '5' });
  assert.deepEqual([t.shiori.find('OnCommunicate')[1].headers.Marker, t.shiori.find('OnCommunicate')[1].headers.Age], ['from Y', '5']);
  assert.equal(t.loop.choicesLive, false);
  t.player.timeCritical = true;
  assert.equal((await t.loop.communicated(rec)).played, true, 'inside \\t');
  t.player.timeCritical = false;
  // no lock test on this path: passive and induction mode hear it and the reply plays (A11) [decision]
  for (const mode of ['passive', 'induction']) {
    t.loop.playScript(`\\0${mode}\\e`);
    t.loop.ghostLife[mode] = true;
    const asked = t.shiori.find('OnCommunicate').length;
    assert.deepEqual(await t.loop.communicated(rec), { status: 200, played: true }, mode);
    assert.equal(t.shiori.find('OnCommunicate').length, asked + 1, mode);
    await settle();
    assert.equal(t.loop.current.script, '\\0Hello, Y.\\e', `${mode}: the reply cuts in`);
    t.loop.ghostLife[mode] = false;
  }
  t.shiori.handler = answers({ OnClose: '\\0Bye.\\e', OnCommunicate: '\\0Wait!\\e' });
  await t.loop.close(0);
  assert.equal(t.loop.closing, 'one');
  assert.equal((await t.loop.communicated(rec)).played, true);
  t.player.finish();
  await settle();
  assert.equal(t.loop.closing, false, 'the goodbye was cut: it stays');
  assert.equal(t.loop.closed, false);

  // minimized: its SHIORI hears it, nothing plays
  t.loop.minimized = { reason: 'user', scopes: [0] };
  const n = t.player.plays.length;
  assert.deepEqual(await t.loop.communicated(rec), { status: 200, played: false });
  assert.equal(t.player.plays.length, n);
  t.loop.minimized = null;
});

test('communicated(): sstp.allowcommunicate not ParseBool 1 refuses with 420; nothing while changing, closed, frozen', async () => {
  const rec = { ids: ['x'], sender: 'Ys', sentence: 's', refs: [], age: '0', surface: '0\x0110', marker: '' };
  for (const [v, asked] of [['0', false], ['false', false], ['abc', false], ['', false], ['1', true], ['true', true], [null, true]]) {
    const t = await booted({ descript: v === null ? [] : [['sstp.allowcommunicate', v]] });
    const r = await t.loop.communicated(rec);
    assert.equal(t.shiori.find('OnCommunicate').length, asked ? 1 : 0, String(v));
    if (!asked) assert.deepEqual(r, { status: 420, played: false });
    t.loop.destroy();
  }
  const t = await booted();
  for (const [name, on, off] of [
    ['changing', () => { t.loop.changing = true; }, () => { t.loop.changing = false; }],
    ['closed', () => { t.loop.closed = true; }, () => { t.loop.closed = false; }],
    ['frozen', () => { t.loop.frozen = true; }, () => { t.loop.frozen = false; }],
    ['not booted', () => { t.loop.booted = false; }, () => { t.loop.booted = true; }],
  ]) {
    on();
    assert.deepEqual(await t.loop.communicated(rec), { status: 0, played: false }, name);
    off();
  }
  assert.equal(t.shiori.find('OnCommunicate').length, 0);
});

test('raisedByOther(): GET or NOTIFY with Sender = the raiser, SenderType internal; ok and status (C4, C5)', async () => {
  const t = await booted({
    handler: answers({ OnTea: reply('\\0Tea!\\e'), OnNone: null, OnEmpty: reply(''), OnN: reply('\\0never played\\e') }),
  });
  t.loop.playScript('\\0talking\\e');
  assert.deepEqual(await t.loop.raisedByOther('OnTea', ['紅茶'], { sender: 'かなで' }), { ok: true, status: 200 });
  const r = t.shiori.find('OnTea')[0];
  assert.deepEqual([r.method, r.refs, r.headers.Sender, r.headers.SenderType], ['GET', ['紅茶'], 'かなで', 'internal']);
  await settle();
  assert.equal(t.loop.current.script, '\\0Tea!\\e', 'the reply cuts what it said');
  assert.deepEqual(await t.loop.raisedByOther('OnNone', [], { sender: 'かなで' }), { ok: false, status: 204 });
  assert.deepEqual(await t.loop.raisedByOther('OnEmpty', [], { sender: 'かなで' }), { ok: false, status: 200 });
  const n = t.player.plays.length;
  assert.deepEqual(await t.loop.raisedByOther('OnN', ['a'], { notify: true, sender: 'かなで' }), { ok: true, status: 200 });
  assert.deepEqual(await t.loop.raisedByOther('OnNone', [], { notify: true }), { ok: true, status: 204 }, 'a NOTIFY never fails');
  assert.equal(t.shiori.find('OnN')[0].method, 'NOTIFY');
  assert.equal(t.player.plays.length, n, 'a NOTIFY\'s reply never plays');
  assert.equal(t.shiori.find('OnNone')[1].headers.Sender, undefined, 'no name: the base header (SSP)');
  // nothing refuses on this side (C4: not closing, not choosing): the reply cuts a goodbye and a menu
  t.shiori.handler = answers({ OnClose: '\\0Bye.\\e', OnTea: reply('\\0Tea!\\e') });
  await t.loop.close(0);
  assert.equal(t.loop.closing, 'one');
  assert.deepEqual(await t.loop.raisedByOther('OnTea', [], { sender: 'かなで' }), { ok: true, status: 200 }, 'closing');
  await settle();
  assert.equal(t.loop.current.script, '\\0Tea!\\e', 'the goodbye is cut');
  t.player.finish();
  await settle();
  assert.equal(t.loop.closing, false, 'and the ghost stays');
  t.loop.playScript('\\0menu\\q[a,b]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  assert.equal(t.loop.choicesLive, true);
  assert.deepEqual(await t.loop.raisedByOther('OnTea', [], { sender: 'かなで' }), { ok: true, status: 200 }, 'choosing');
  await settle();
  assert.equal(t.loop.choicesLive, false, 'the menu is cut');
  assert.equal(t.loop.current.script, '\\0Tea!\\e');
  t.loop.closed = true;
  assert.deepEqual(await t.loop.raisedByOther('OnTea', [], { notify: true }), { ok: false, status: 0 });
});

test('notifyEvent(): the failure event to the raiser plays its reply; nothing while frozen', async () => {
  const t = await booted({ handler: answers({ OnRaiseOtherFailure: reply('\\0Nobody answered.\\e') }) });
  const refs = ['notfound', 'nobody', 'OnX', 'a'];
  assert.deepEqual(await t.loop.notifyEvent('OnRaiseOtherFailure', refs, { senderType: 'internal,raise' }), { status: 200, played: true });
  const r = t.shiori.find('OnRaiseOtherFailure')[0];
  assert.deepEqual([r.method, r.refs, r.headers.SenderType], ['GET', refs, 'internal,raise']);
  await settle();
  assert.equal(t.loop.current.script, '\\0Nobody answered.\\e');
  t.loop.frozen = true;
  assert.deepEqual(await t.loop.notifyEvent('OnRaiseOtherFailure', refs), { status: 0, played: false });
  assert.equal(t.shiori.find('OnRaiseOtherFailure').length, 1);
});

test('lockReason in SSP\'s order: timecritical, inductionmode, passivemode, minimized [disasm 0x642660, 0x633D53]', async () => {
  const t = await booted();
  assert.equal(t.loop.lockReason, '');
  t.loop.minimized = { reason: 'user', scopes: [0] };
  t.loop.ghostLife.passive = true;
  t.loop.ghostLife.induction = true;
  t.player.timeCritical = true;
  assert.equal(t.loop.lockReason, 'timecritical');
  t.player.timeCritical = false;
  assert.equal(t.loop.lockReason, 'inductionmode');
  t.loop.ghostLife.induction = false;
  assert.equal(t.loop.lockReason, 'passivemode');
  t.loop.ghostLife.passive = false;
  assert.equal(t.loop.lockReason, 'minimized');
  t.loop.minimized = null;
  assert.equal(t.loop.lockReason, '');
});

test('raiseOther(): \'raiseother\' for the site, the script goes on; no site: nothing', async () => {
  const t = await booted();
  t.loop.playScript('\\0talking\\e');
  assert.equal(t.loop.raiseOther('Ys', 'OnTea', ['紅茶', 1], { notify: true }), undefined);
  t.loop.raiseOther(undefined, '', []);
  assert.deepEqual(t.seen.filter(([k]) => k === 'raiseother').map(([, e]) => e), [
    { ghost: 'Ys', id: 'OnTea', refs: ['紅茶', '1'], notify: true },
    { ghost: undefined, id: '', refs: [], notify: false },
  ]);
  assert.equal(t.player.busy, true, 'the run is not touched');
  assert.equal(t.shiori.log.length, 0, 'nothing is sent from here');
  const alone = new EventLoop({ shiori: new FakeShiori(), player: new FakePlayer(), stage: new FakeStage(), env: { win: null, doc: null } });
  assert.doesNotThrow(() => alone.raiseOther('Ys', 'OnX', []));
});

test('timers (C8): one key per event name, any case, for all four tags; 0 cancels any; 1–49 ms become 50', async () => {
  const t = await booted({ handler: answers({ OnFoo: null }) });
  t.loop.timerRaise(1000, '1', 'OnFoo', ['a']);
  t.loop.timerRaise(2000, '1', 'onfoo', ['b'], { to: 'Ys' });             // \![timerraiseother] replaces it
  assert.equal(t.loop.timers.size, 1);
  await t.clock.advance(1500);
  assert.equal(t.shiori.find('OnFoo').length, 0);
  await t.clock.advance(600);
  assert.deepEqual(t.seen.filter(([k]) => k === 'raiseother').map(([, e]) => e), [{ ghost: 'Ys', id: 'onfoo', refs: ['b'], notify: false }]);
  assert.equal(t.shiori.find('onfoo').length, 0, 'not raised here');
  assert.equal(t.loop.timers.size, 0, 'once');

  t.loop.timerRaise(1000, '0', 'ＯｎＢａｒ', [], { notify: true, to: 'Zs' });
  t.loop.timerRaise(0, '1', 'ｏｎｂａｒ');                                // a plain \![timerraise,0,…] cancels it
  t.loop.timerRaise(1000, '1', 'OnÉ');
  t.loop.timerRaise(1000, '1', 'Oné');                                   // À–Þ are not folded: two timers
  assert.deepEqual([...t.loop.timers.values()].map(x => x.ev), ['OnÉ', 'Oné']);
  t.loop.timerRaise(0, '1', 'OnÉ');
  t.loop.timerRaise(0, '1', 'Oné');

  // the floor: 1 ms fires at 50; a repeating one every 50 (the site done with each fire at once)
  t.seen.length = 0;
  t.loop.on('raiseother', e => { if (e.done) e.done(); });
  t.loop.timerRaise(1, '0', 'OnTick', [], { to: 'Ys' });
  t.loop.timerRaise(49, '1', 'OnOnce');
  assert.deepEqual([...t.loop.timers.values()].map(x => x.intervalMs), [50, 50]);
  await t.clock.advance(49);
  assert.equal(t.seen.length + t.shiori.find('OnOnce').length, 0);
  await t.clock.advance(1);
  assert.equal(t.shiori.find('OnOnce').length, 1);
  await t.clock.advance(100);
  assert.equal(t.seen.filter(([k]) => k === 'raiseother').length, 3, 'every 50 ms');
  t.loop.timerRaise(0, '', 'ontick');

  // repeat from the boolean, or SSP's ParseBool: only 1 is once
  const table = [[true, true], [false, false], ['0', true], ['', true], ['abc', true], ['false', true], ['1', false],
    ['2', false], ['on', false]];
  for (const [r, rep] of table) {
    t.loop.timerRaise(1000, r, 'OnR');
    assert.equal(t.loop.timers.get('onr').repeat, rep, JSON.stringify(r));
  }
});

test('timers with a target are saved with it and fire on the next page (overdue ones at its boot) as \'raiseother\'', async () => {
  const storage = memoryStorage();
  const t = await booted({ storage });
  t.loop.timerRaise(2000, '1', 'OnT', ['a'], { to: 'Ys' });
  t.loop.timerRaise(5000, '1', 'OnLater', [], { notify: true, to: `Ys\x01Zs` });
  t.state.saveNow();
  const saved = JSON.parse(storage.getItem('sumika:ghost:x:state')).timers;
  assert.deepEqual(saved.map(x => [x.ev, x.kind, x.to]), [['OnT', 'raise', 'Ys'], ['OnLater', 'notify', `Ys\x01Zs`]]);
  t.loop.destroy();

  const next = make({ storage });
  next.clock.t = t.clock.now() + 3000;                // the page came back after OnT's time
  await next.loop.boot({ resume: true });
  assert.deepEqual(next.seen.filter(([k]) => k === 'raiseother').map(([, e]) => e), [{ ghost: 'Ys', id: 'OnT', refs: ['a'], notify: false }]);
  await next.clock.advance(2100);
  assert.deepEqual(next.seen.filter(([k]) => k === 'raiseother').map(([, e]) => [e.id, e.ghost, e.notify]),
    [['OnT', 'Ys', false], ['OnLater', `Ys\x01Zs`, true]]);
  assert.equal(next.shiori.find('OnT').length + next.shiori.find('OnLater').length, 0);
  next.loop.destroy();
});

test('a repeating \\![timer*other] never piles up: no fire while the site has the last one (done), and live() is false once the timer is cancelled or replaced', async () => {
  const t = await booted();
  const evs = [];
  t.loop.on('raiseother', e => evs.push(e));
  t.loop.timerRaise(50, '0', 'OnTick', ['a'], { to: 'Ys' });
  await t.clock.advance(300);
  assert.equal(evs.length, 1, 'the first fire is still with the site: the ticks after it are skipped');
  assert.deepEqual([evs[0].ghost, evs[0].id, evs[0].refs, typeof evs[0].live, typeof evs[0].done], ['Ys', 'OnTick', ['a'], 'function', 'function']);
  assert.equal(evs[0].live(), true);
  evs[0].done();
  await t.clock.advance(50);
  assert.equal(evs.length, 2, 'the next tick goes once it is done');
  t.loop.timerRaise(0, '', 'ontick');                     // cancelled while the second waits in the site's queue
  assert.equal(evs[1].live(), false, 'the site drops it');
  evs[1].done();
  await t.clock.advance(500);
  assert.equal(evs.length, 2);
  // replaced (the same event, any case): the old fire is dead, the new timer runs on its own
  t.loop.timerRaise(50, '0', 'OnTock', [], { to: 'Ys' });
  await t.clock.advance(50);
  t.loop.timerRaise(50, '0', 'ONTOCK', [], { to: 'Zs' });
  assert.equal(evs[2].live(), false);
  await t.clock.advance(50);
  assert.deepEqual(evs.map(e => e.ghost), ['Ys', 'Ys', 'Ys', 'Zs'], 'the new timer fires, the old fire not done yet');
  t.loop.timerRaise(0, '', 'ontock');
  // closed or torn down: dead too
  t.loop.timerRaise(50, '0', 'OnLast', [], { to: 'Ys' });
  await t.clock.advance(50);
  t.loop.destroy();
  assert.equal(evs.at(-1).live(), false);
  // a one-shot goes as asked (SSP posts those): no live / done; a loop with no site listening holds nothing
  const o = await booted();
  const oe = [];
  o.loop.on('raiseother', e => oe.push(e));
  o.loop.timerRaise(50, '1', 'OnOnce', [], { to: 'Ys' });
  await o.clock.advance(50);
  assert.deepEqual(oe, [{ ghost: 'Ys', id: 'OnOnce', refs: [], notify: false }]);
  const alone = await booted({ peers: null });
  alone.loop._handlers.delete('raiseother');
  alone.loop.timerRaise(50, '0', 'OnTick', [], { to: 'Ys' });
  await alone.clock.advance(60);
  assert.equal(alone.loop.timers.get('ontick').inFlight, false, 'nobody took it: not in flight');
});

test('restored timers get the 50 ms floor too: a state saved before it (Tsubasa\'s 10 ms chains) (C8)', async () => {
  const storage = memoryStorage();
  const first = make({ storage });
  first.state.data.timers = [{ ev: 'OnT', refs: [], repeat: true, intervalMs: 10, dueAt: first.clock.now() - 5, kind: 'raise' }];
  first.state.saveNow();
  const t = make({ storage, handler: answers({ OnT: null }) });
  t.clock.t = first.clock.now();
  await t.loop.boot({ resume: true });
  assert.equal(t.loop.timers.get('ont').intervalMs, 50);
  await t.clock.advance(49);
  assert.equal(t.shiori.find('OnT').length, 0, 'nothing before 50 ms');
  await t.clock.advance(1);
  assert.equal(t.shiori.find('OnT').length, 1);
  await t.clock.advance(50);
  assert.equal(t.shiori.find('OnT').length, 2, 'every 50 ms');
  t.loop.destroy();
});

test('an engine restart empties the pending slot: the new engine owes no talk of the old one (A6)', async () => {
  const t = await booted({ handler: answers({ OnA: reply('v', { Reference0: 'Ys' }) }) });
  await t.loop.send('OnA', [], { method: 'NOTIFY' });      // a NOTIFY's response with a target: the slot is filled
  assert.deepEqual(t.loop._comm.ids, ['y']);
  await t.loop.afterEngineRestart();
  assert.equal(t.loop._comm, null);
  assert.equal(t.loop.playScript('\\0next\\e').communicate, null, 'the next script carries nothing');
});

test('FMO (EV §2.7.8): a Satori ghost\'s requests carry the text, self first, then peers.others() as they are now', async () => {
  const t = await booted();
  await t.loop.send('OnA', []);
  const fmo = t.shiori.find('OnA')[0].fmo;
  assert.equal(fmo, fmoText(t.loop.peerInfo(), t.peers.list));
  assert.ok(fmo.startsWith('ssp_fmo_header_00000000_00000000.path\x01/ssp/\r\n'));
  assert.ok(fmo.includes('ssp_fmo_header_00000000_00000000.keroname\x01Xk\r\n'), 'peerInfo() has the kero name');
  assert.ok(fmo.includes('ssp_fmo_header_00000000_00000001.name\x01Ys\r\n'));
  assert.ok(fmo.includes('ssp_fmo_header_00000000_00000002.name\x01Zs\r\n'));
  assert.equal(t.loop.peerInfo().keroName, 'Xk');
  t.peers.list = t.peers.list.filter(g => g.id !== 'y');               // Y closed
  t.loop.stage.chars.get(0).surfaceId = 7;
  await t.loop.send('OnB', []);
  const after = t.shiori.find('OnB')[0].fmo;
  assert.ok(!after.includes('Ys') && after.includes('00000001.name\x01Zs'));
  assert.ok(after.includes('00000000.sakura.surface\x017\r\n'));
  assert.ok(t.shiori.log.every(r => typeof r.fmo === 'string'), 'every request');

  const alone = await booted({ peers: null });
  await alone.loop.send('OnA', []);
  assert.equal(alone.shiori.find('OnA')[0].fmo, fmoText(alone.loop.peerInfo(), []));

  const yaya = await booted({ ghost: { ...X, engine: 'yaya', module: 'yaya' } });
  await yaya.loop.send('OnA', []);
  assert.ok(yaya.shiori.log.every(r => !('fmo' in r)), 'YAYA gets none');
});

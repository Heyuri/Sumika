// EventLoop side of Shell ▸ / Balloon ▸ / \![change,shell|balloon] (shiori-events.md §2.6): argument parsing and
// guards, OnShellChanging and its cancels, the stage swap (detachStage / attachStage), the NOTIFYs and OnShellChanged
// after it, OnBalloonChange, and a reply that waits for the calling script. The runtime half is view_switch.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLoop } from '../../src/core/events.js';
import { ScriptPlayer } from '../../src/sakura/player.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { setup as playerMocks } from '../sakura/mocks.mjs';
import {
  FakeClock, FakeShiori, FakePlayer, FakeStage, FakeChar, FakeBalloons, FakeDialogs, deferred, settle,
} from './fakes.mjs';

setLogLevel('silent');     // failing switchers and missing views are logged by design

const GHOST = {
  id: 'testghost', name: 'Test Ghost', sakuraName: 'Testy', keroName: '', defaultShell: 'master',
  shells: [{ id: 'master', name: 'master' }, { id: 'alt', name: 'Winter' }], bundledBalloons: [], balloon: null,
};
const ALT = { id: 'alt', name: 'Winter', path: '/ghost/testghost/shell/alt/' };

/** A character whose surface can be set (the stage reports it like CharacterView does). */
class VChar extends FakeChar {
  constructor(stage, scope, surfaceId) { super(scope, surfaceId); this.stage = stage; this.set = []; }
  setSurface(id) {
    this.set.push(id);
    this.surfaceId = id;
    this.stage.emit('surface', { scope: this.scope, id, width: 10, height: 20 });
    return true;
  }
}

/** FakeStage with a parsed shell (descript, surface ids) and characters that take setSurface. */
class VStage extends FakeStage {
  constructor({ surfaces = { 0: 0, 1: 10 }, descript = [], ids = [0, 10] } = {}) {
    super();
    this.chars = new Map(Object.entries(surfaces).map(([s, id]) => [Number(s), new VChar(this, Number(s), id)]));
    this.shell = { descript: new Map(descript), surfaceIds: () => ids.slice() };
  }
  char(s) {
    if (!this.chars.has(s)) this.chars.set(s, new VChar(this, s, -1));
    return this.chars.get(s);
  }
}

function setup({ handler, stage, ghost = GHOST, descript, shell } = {}) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const player = new FakePlayer();
  const balloons = new FakeBalloons();
  const state = new StateStore(ghost.id, { storage: memoryStorage(), clock });
  const loop = new EventLoop({
    shiori, player, stage: stage || new VStage(), balloons, dialogs: new FakeDialogs(), ghost, state, clock,
    menu: { open() {}, close() {} }, env: { win: null, doc: null },
    ghostDescript: new Map(descript || [['name', 'Test Ghost'], ['sakura.name', 'Testy']]),
    site: { ghosts: [ghost], balloons: [{ id: 'sumika', name: 'Sumika' }] }, sessionEpochMs: clock.now(),
    paths: { shell: '/ghost/testghost/shell/master/', balloon: '/balloon/sumika/' }, balloonName: 'Sumika', shell,
  });
  return { clock, shiori, player, balloons, state, loop, stage: loop.stage };
}

async function booted(o = {}) {
  const t = setup(o);
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  return t;
}

const answers = map => r => (typeof map[r.id] === 'function' ? map[r.id](r) : map[r.id] ?? null);
const isThenable = x => !!x && typeof x.then === 'function';

// ---------------------------------------------------------------- requests

test('\\![change,shell|balloon]: --option= tokens are options, the last other token is the target (EV §2.6)', async () => {
  const t = await booted();
  const reqs = [];
  const gate = deferred();
  t.loop.viewSwitcher = req => { reqs.push(req); return gate.promise; };
  const ghostAsked = [];
  t.loop.on('change', r => ghostAsked.push(r));

  const r1 = t.loop.change('shell', ['a', 'B', '--option=raise-event']);
  assert.equal(r1, undefined, 'with raise-event the script is not held (OnShellChanging comes first)');
  const r2 = t.loop.change('shell', ['Winter']);
  assert.ok(isThenable(r2), 'without raise-event the player waits at the tag');
  const r3 = t.loop.change('balloon', ['x', '--option=raise-event']);
  assert.ok(isThenable(r3), 'every balloon change holds the script');
  t.loop.change('shell', ['--OPTION=Raise-Event', ' 少女語り ']);
  assert.equal(t.loop.change('shell', ['--option=raise-event']), undefined, 'no target: ignored');
  assert.equal(t.loop.change('balloon', []), undefined);
  assert.equal(t.loop.change('shell', ['Winter', '']), undefined, 'the last non-option token is empty: no target');

  assert.deepEqual(reqs, [
    { kind: 'shell', target: 'B', byId: false, raiseEvent: true, fromScript: true, scope: 0 },
    { kind: 'shell', target: 'Winter', byId: false, raiseEvent: false, fromScript: true, scope: 0 },
    { kind: 'balloon', target: 'x', byId: false, raiseEvent: false, fromScript: true, scope: 0 },
    { kind: 'shell', target: '少女語り', byId: false, raiseEvent: true, fromScript: true, scope: 0 },
  ]);
  assert.deepEqual(ghostAsked, [], "shell and balloon requests never reach the ghost change's 'change' event");
  gate.resolve(true);
  assert.equal(await r2, true);
  assert.equal(await r3, true);

  // the page API / menu form
  t.loop.changeShell('alt', { byId: true, raiseEvent: true, scope: 1 });
  t.loop.changeBalloon('sumika', { byId: true });
  assert.deepEqual(reqs.slice(4), [
    { kind: 'shell', target: 'alt', byId: true, raiseEvent: true, fromScript: false, scope: 1 },
    { kind: 'balloon', target: 'sumika', byId: true, raiseEvent: false, fromScript: false, scope: 0 },
  ]);

  // a switcher that fails or throws: false, never a rejection
  t.loop.viewSwitcher = () => Promise.reject(new Error('boom'));
  assert.equal(await t.loop.change('shell', ['Winter']), false);
  t.loop.viewSwitcher = () => { throw new Error('boom'); };
  assert.equal(t.loop.changeShell('Winter'), false);
  // no switcher: nothing happens, nothing throws
  t.loop.viewSwitcher = null;
  assert.equal(t.loop.change('shell', ['Winter']), undefined);
  assert.equal(t.loop.changeBalloon('Sumika'), false);
  t.loop.destroy();
});

test('guards: a menu pick is refused while passive, induction, minimized or in \\t; a script only by the ghost change', async () => {
  const t = await booted();
  let n = 0;
  t.loop.viewSwitcher = async () => { n++; return true; };
  const menu = () => [t.loop.changeShell('Winter'), t.loop.changeBalloon('Sumika')];

  assert.ok(menu().every(isThenable));
  assert.equal(n, 2);
  for (const [label, on, off] of [
    ['passive', () => { t.loop.ghostLife.passive = true; }, () => { t.loop.ghostLife.passive = false; }],
    ['induction', () => { t.loop.ghostLife.induction = true; }, () => { t.loop.ghostLife.induction = false; }],
    ['minimized', () => { t.loop.minimized = { reason: 'user', scopes: [0, 1] }; }, () => { t.loop.minimized = null; }],
    ['\\t', () => { t.player.timeCritical = true; }, () => { t.player.timeCritical = false; }],
  ]) {
    on();
    assert.deepEqual(menu(), [false, false], `menu while ${label}`);
    assert.ok(isThenable(t.loop.change('shell', ['Winter'])), `script while ${label}`);
    assert.ok(isThenable(t.loop.change('balloon', ['Sumika'])), `script while ${label}`);
    off();
  }
  assert.equal(n, 10);
  t.loop.changing = true;                                  // a ghost change under way
  assert.deepEqual([...menu(), t.loop.change('shell', ['Winter'])], [false, false, undefined]);
  t.loop.changing = false;
  const fresh = setup();                                   // not booted
  fresh.loop.viewSwitcher = async () => { n++; return true; };
  assert.equal(fresh.loop.changeShell('Winter'), false);
  assert.equal(n, 10);
  t.loop.destroy();
  fresh.loop.destroy();
});

// ---------------------------------------------------------------- OnShellChanging

test('shellChanging: GET OnShellChanging [next, current, next path]; ok on 204 and when its reply has played to its end', async () => {
  let t = await booted();
  let r = await t.loop.shellChanging(ALT);
  assert.deepEqual(r, { ok: true });
  const ev = t.shiori.find('OnShellChanging');
  assert.deepEqual(ev.map(x => [x.method, x.refs]), [['GET', ['Winter', 'master', '/ghost/testghost/shell/alt/']]]);
  t.loop.destroy();

  t = await booted({ handler: answers({ OnShellChanging: "\\0Um... okay, I'll go get changed, then.\\e" }) });
  let done = null;
  t.loop.shellChanging({ name: 'master', path: '/ghost/testghost/shell/master/' }).then(x => { done = x; });
  await settle();
  assert.deepEqual(t.shiori.find('OnShellChanging')[0].refs, ['master', 'master', '/ghost/testghost/shell/master/'],
    'a re-pick of the current shell: R0 = R1');
  assert.equal(t.player.last.script, "\\0Um... okay, I'll go get changed, then.\\e");
  assert.equal(t.player.last.meta.event, 'OnShellChanging');
  assert.equal(done, null, 'the switch waits for the end of her talk');
  t.player.finish();
  await settle();
  assert.deepEqual(done, { ok: true });
  t.loop.destroy();
});

test('shellChanging is not ok after a balloon break, a replacing run, the 30 s cap or a close; a page left meanwhile saves no run', async () => {
  const talk = { OnShellChanging: '\\0Alright, I am going to go change.\\e' };
  const start = async () => {
    const t = await booted({ handler: answers(talk) });
    const out = { t, done: null };
    t.loop.shellChanging(ALT).then(x => { out.done = x; });
    await settle();
    assert.equal(t.player.busy, true);
    return out;
  };

  let o = await start();                                   // double-click on her balloon: a balloon break cancels
  o.t.state.saveNow();
  assert.equal(o.t.state.data.run, null, 'a page left during the talk drops the change and never replays the talk');
  o.t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  assert.equal(o.t.shiori.find('OnBalloonBreak').length, 1);
  assert.deepEqual(o.done, { ok: false });
  o.t.loop.destroy();

  o = await start();                                       // she answers a click: the reply replaces the talk
  o.t.loop.playScript('\\0Hm?\\e', { event: 'OnMouseClick' });
  await settle();
  assert.deepEqual(o.done, { ok: false });
  o.t.loop.destroy();

  o = await start();                                       // the cap (ours; SSP has none)
  await o.t.clock.advance(29000);
  assert.equal(o.done, null);
  await o.t.clock.advance(1500);
  assert.deepEqual(o.done, { ok: false });
  o.t.loop.destroy();

  o = await start();                                       // torn down (a takeover, a ghost change)
  o.t.loop.destroy();
  await settle();
  assert.deepEqual(o.done, { ok: false });

  o = await start();                                       // her talk ends with \-
  o.t.player.busy = false;
  o.t.player.cur.resolve({ reason: 'quit', hasChoices: false });
  await settle();
  assert.deepEqual(o.done, { ok: false });
  assert.equal(o.t.loop.closed, true);

  o = await start();                                       // after the wait, the run is saved again
  o.t.player.finish();
  await settle();
  assert.deepEqual(o.done, { ok: true });
  o.t.state.saveNow();
  assert.ok(o.t.state.data.run, 'her finished line is still up: saved for the next page');
  o.t.loop.destroy();
});

// ---------------------------------------------------------------- the swap

test('detachStage / attachStage: shown surfaces remembered, balloons closed, events follow the new stage', async () => {
  const t = await booted();
  const a = t.stage;
  a.char(99).surfaceId = 3;                                // \p[99] shown
  a.char(2).surfaceId = 5;
  a.char(2).hide();                                        // a character hidden by the runtime: not remembered
  t.loop.playScript('\\0\\![bind,髪,ツインテール,1]\\![change,shell,Winter]');
  a.emit('bind', { scope: 0, id: 1, category: '髪', part: 'ツインテール', on: true });
  const hiddenBefore = t.balloons.hidden;
  t.shiori.log.length = 0;

  const shown = t.loop.detachStage();
  assert.deepEqual([...shown], [[0, 0], [1, 10], [99, 3]]);
  assert.equal(t.balloons.hidden, hiddenBefore + 1, 'every balloon closes');
  assert.deepEqual(t.shiori.log.map(r => `${r.method} ${r.id}`), ['NOTIFY OnDressupChanged', 'NOTIFY OnNotifyDressupInfo'],
    "the script's binds so far are reported first");
  assert.equal(a.acceptsDrops, false);
  t.shiori.log.length = 0;
  a.emit('mouse', { type: 'wheel', scope: 0, x: 1, y: 2, wheel: 120 });
  a.emit('drop', { scope: 0, files: [{ name: 'a.mp3', type: 'audio/mpeg' }] });
  await settle();
  assert.deepEqual(t.shiori.log, [], 'the old stage is not heard any more');

  const b = new VStage({ surfaces: {} });
  const staged = [];
  t.player.setStage = s => staged.push(s);
  t.loop.attachStage(b, ALT);
  assert.equal(t.loop.stage, b);
  assert.deepEqual(staged, [b], "the player's later tags go to the new stage");
  assert.equal(b.acceptsDrops, true);
  b.emit('mouse', { type: 'wheel', scope: 0, x: 1, y: 2, wheel: 120 });
  a.emit('mouse', { type: 'wheel', scope: 0, x: 1, y: 2, wheel: -120 });
  await settle();
  assert.deepEqual(t.shiori.find('OnMouseWheel').map(r => r.refs[2]), [120]);
  t.loop.destroy();
});

test('shellChanged: NOTIFY self, shell and dress-up info and installedshellname, then GET OnShellChanged; 204 puts the surfaces back', async () => {
  const t = await booted();
  const shown = t.loop.detachStage();
  // the new shell names the characters itself (SSP applies a shell's sakura.name / keroname)
  const b = new VStage({ surfaces: {}, descript: [['sakura.name', 'Winter Testy'], ['keroname', 'Snow']], ids: [0, 10, 20] });
  t.loop.attachStage(b, ALT);
  t.shiori.log.length = 0;
  await t.loop.shellChanged({ surfaces: shown });
  await settle();
  assert.deepEqual(t.shiori.ids().slice(0, 5), [
    'NOTIFY OnNotifySelfInfo', 'NOTIFY OnNotifyShellInfo', 'NOTIFY OnNotifyDressupInfo', 'NOTIFY installedshellname',
    'GET OnShellChanged',
  ]);
  const path = '/ghost/testghost/shell/alt/';
  assert.deepEqual(t.shiori.find('OnNotifySelfInfo')[0].refs, ['Test Ghost', 'Winter Testy', 'Snow', 'Winter', path, 'Sumika', '/balloon/sumika/']);
  assert.deepEqual(t.shiori.find('OnNotifyShellInfo')[0].refs, ['Winter', path, '0,10,20']);
  assert.deepEqual(t.shiori.find('installedshellname')[0].refs, ['master', 'Winter']);
  assert.deepEqual(t.shiori.find('OnShellChanged')[0].refs, ['Winter', 'Test Ghost', path]);
  assert.deepEqual([b.char(0).set, b.char(1).set], [[0], [10]], 'no reply: the remembered surfaces come back');
  assert.deepEqual(t.shiori.find('OnSurfaceChange').map(r => r.refs[2]), ['0,0,10,20', '1,10,10,20']);
  assert.equal(t.loop.envVar('selfname'), 'Winter Testy');
  assert.equal(t.loop.envVar('keroname'), 'Snow');
  t.loop.destroy();
});

test('shellChanged: a reply plays at once (menu) and decides the surfaces; without the event they come back at once', async () => {
  let t = await booted({ handler: answers({ OnShellChanged: '\\0\\s[5]Does it suit me?\\e' }) });
  let shown = t.loop.detachStage();
  let b = new VStage({ surfaces: {} });
  t.loop.attachStage(b, ALT);
  await t.loop.shellChanged({ surfaces: shown });
  assert.equal(t.player.last.script, '\\0\\s[5]Does it suit me?\\e');
  assert.equal(t.player.last.meta.event, 'OnShellChanged');
  assert.deepEqual([b.char(0).set, b.char(1).set], [[], []], 'the reply decides; nothing is restored');
  t.loop.destroy();

  t = await booted({ handler: answers({ OnShellChanged: '\\0never asked\\e' }) });
  shown = t.loop.detachStage();
  b = new VStage({ surfaces: {} });
  t.loop.attachStage(b, ALT);
  await t.loop.shellChanged({ surfaces: shown, event: false });
  assert.equal(t.shiori.find('OnShellChanged').length, 0);
  assert.equal(t.shiori.find('OnNotifyShellInfo').length, 1);
  assert.deepEqual([b.char(0).set, b.char(1).set], [[0], [10]]);
  t.loop.destroy();
});

test("shellChanged with defer (a script's \\![change,shell]): the reply plays only when the running script ends", async () => {
  const reply = { OnShellChanged: '\\0Does it suit me?\\e' };
  let t = await booted({ handler: answers(reply) });
  t.loop.playScript('\\0Let me change.\\![change,shell,Winter]Ta-da!\\e', { event: 'OnTalk' });
  let shown = t.loop.detachStage();
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  await t.loop.shellChanged({ surfaces: shown, defer: true });
  await settle();
  assert.equal(t.shiori.find('OnShellChanged').length, 1, 'sent at the swap');
  assert.equal(t.player.plays.length, 1, 'the calling script is not cut');
  t.player.finish();
  await settle();
  assert.equal(t.player.plays.length, 2);
  assert.equal(t.player.last.script, '\\0Does it suit me?\\e');
  assert.equal(t.player.last.meta.event, 'OnShellChanged');
  assert.ok(t.shiori.ids().indexOf('GET OnTranslate') > t.shiori.ids().indexOf('GET OnShellChanged'));
  t.loop.destroy();

  t = await booted({ handler: answers(reply) });           // nothing plays: at once
  shown = t.loop.detachStage();
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  await t.loop.shellChanged({ surfaces: shown, defer: true });
  await settle();
  assert.equal(t.player.last.script, '\\0Does it suit me?\\e');
  t.loop.destroy();

  t = await booted({ handler: answers(reply) });           // the calling script closes the ghost (kirito: ...\-)
  t.loop.playScript('\\0\\![change,shell,Winter]\\-');
  shown = t.loop.detachStage();
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  await t.loop.shellChanged({ surfaces: shown, defer: true });
  t.player.busy = false;
  t.player.cur.resolve({ reason: 'quit', hasChoices: false });
  await settle();
  assert.equal(t.loop.closed, true);
  assert.equal(t.player.plays.length, 1, 'the queued reply is dropped');
});

test('the swap holds the loop: cantalk 0, ticks NOTIFY, no reply plays on the old stage; held ones follow OnShellChanged', async () => {
  const slow = deferred();
  let slowTick = true;
  const t = await booted({ handler: answers({
    OnSecondChange: r => (slowTick ? (slowTick = false, slow.promise) : String(r.refs[3]) === '1' ? '\\0random talk\\e' : null),
    OnKeyPress: '\\0key reply\\e',
    OnUserInput: '\\0box reply\\e',
    OnShellChanged: '\\0Does it suit me?\\e',
  }) });
  const a = t.stage;
  await t.clock.advance(1100);                             // a tick GET goes out before the swap ...
  assert.deepEqual(t.shiori.find('OnSecondChange').map(r => [r.method, r.refs[3]]), [['GET', 1]]);
  const plays = t.player.plays.length;
  const shown = t.loop.detachStage();
  assert.equal(t.loop.swapping, true);
  assert.equal(t.loop.cantalk, false);
  slow.resolve('\\0random talk\\e');                       // ... and its reply comes during it: dropped
  await settle();
  assert.equal(t.player.plays.length, plays, 'no talk on the stage being replaced');
  await t.clock.advance(1000);
  assert.deepEqual(t.shiori.find('OnSecondChange').map(r => [r.method, r.refs[3]]).slice(1), [['NOTIFY', 0]], 'ticks: NOTIFY, R3 0');
  // a key and a box answer during the swap: sent at once, their replies held
  await t.loop.send('OnKeyPress', ['c', 67, 1, 0, '']);
  t.loop.openBox('inputbox', ['q']);
  t.loop.dialogs.boxes[0].resolve({ text: 'hi', timedOut: false, reason: 'ok' });
  await settle();
  assert.equal(t.shiori.find('OnUserInput').length, 1);
  assert.equal(t.player.plays.length, plays);
  assert.equal(t.loop.toggleDressup(0, 1), false, 'no dress-up pick on the detached stage');

  const b = new VStage({ surfaces: {} });
  t.loop.attachStage(b, ALT);
  assert.equal(t.loop.swapping, true, 'the new stage is attached, but OnShellChanged has not gone out yet');
  assert.equal(t.loop.cantalk, false);
  await t.loop.shellChanged({ surfaces: shown });
  assert.equal(t.loop.swapping, false);
  assert.deepEqual(t.player.plays.slice(plays).map(p => p.meta.event), ['OnShellChanged'], "the swap's own reply plays first");
  t.player.finish();
  await settle();
  t.player.finish();
  await settle();
  assert.deepEqual(t.player.plays.slice(plays).map(p => p.script),
    ['\\0Does it suit me?\\e', '\\0key reply\\e', '\\0box reply\\e'], 'then the held ones, oldest first');
  assert.equal(t.loop.cantalk, false, 'the box reply still talks');
  t.player.finish();
  await settle();
  assert.equal(t.loop.cantalk, true);
  assert.notEqual(a, t.loop.stage);
  t.loop.destroy();
});

test('swap end: 204 to OnShellChanged plays the held replies at once; a failed swap ends it when the old stage comes back', async () => {
  const reply = { OnKeyPress: '\\0key reply\\e' };
  let t = await booted({ handler: answers(reply) });
  let shown = t.loop.detachStage();
  await t.loop.send('OnKeyPress', ['c', 67, 1, 0, '']);
  assert.equal(t.player.plays.length, 0);
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  await t.loop.shellChanged({ surfaces: shown });
  await settle();
  assert.deepEqual(t.player.plays.map(p => p.script), ['\\0key reply\\e']);
  t.loop.destroy();

  t = await booted({ handler: answers(reply) });           // the new stage failed to load: the old one again
  const old = t.stage;
  t.loop.detachStage();
  await t.loop.send('OnKeyPress', ['c', 67, 1, 0, '']);
  assert.equal(t.player.plays.length, 0);
  t.loop.attachStage(old, { id: 'master', name: 'master', path: '/ghost/testghost/shell/master/' });
  assert.equal(t.loop.swapping, false);
  await settle();
  assert.deepEqual(t.player.plays.map(p => p.script), ['\\0key reply\\e'], 'the held reply plays at once');
  t.player.finish();
  await settle();
  assert.equal(t.loop.cantalk, true);
  t.loop.destroy();

  t = await booted({ handler: answers({ OnShellChanged: '\\0Ta-da\\e', ...reply }) });   // a script's own change (defer)
  t.loop.playScript('\\0Let me change.\\![change,shell,Winter]and on\\e', { event: 'OnTalk' });
  shown = t.loop.detachStage();
  await t.loop.send('OnKeyPress', ['c', 67, 1, 0, '']);
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  await t.loop.shellChanged({ surfaces: shown, defer: true });
  await settle();
  assert.equal(t.player.plays.length, 1, 'the calling script is not cut by the held key reply');
  t.player.finish();
  await settle();
  t.player.finish();
  await settle();
  assert.deepEqual(t.player.plays.map(p => p.meta.event), ['OnTalk', 'OnShellChanged', 'OnKeyPress']);
  t.loop.destroy();

  t = await booted({ handler: answers(reply) });           // torn down meanwhile: nothing held plays
  t.loop.detachStage();
  await t.loop.send('OnKeyPress', ['c', 67, 1, 0, '']);
  t.loop.destroy();
  await settle();
  assert.equal(t.player.plays.length, 0);
  assert.equal(t.loop.swapping, false);
});

test('Status changing marks a shell change (EV §1.6): from OnShellChanging\'s response until OnShellChanged\'s; cleared on a cancel; never a balloon change', async () => {
  const has = r => /(^|,)changing(,|$)/.test((r && r.headers.Status) || '');
  // the menu path [disasm OnChangeMessage 0x4978c5, ChangeOrReloadShellInternal 0x623125–0x623490]
  let t = await booted({ handler: answers({ OnShellChanging: '\\0Changing.\\e', OnShellChanged: '\\0Done.\\e' }) });
  let done = null;
  t.loop.shellChanging(ALT).then(x => { done = x; });
  await settle();
  assert.equal(has(t.shiori.find('OnShellChanging')[0]), false, 'set only once OnShellChanging has gone out');
  assert.equal(has(t.shiori.find('OnTranslate').at(-1)), true, "its reply's OnTranslate carries it");
  assert.match(t.loop.statusHeader(), /^talking,changing\b/);
  t.player.finish();
  await settle();
  assert.deepEqual(done, { ok: true });
  assert.match(t.loop.statusHeader(), /\bchanging\b/, 'on until the swap');
  const shown = t.loop.detachStage();
  await t.loop.send('OnKeyPress', ['c', 67, 1, 0, '']);
  assert.equal(has(t.shiori.find('OnKeyPress').at(-1)), true, 'a request during the swap');
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  t.shiori.log.length = 0;
  await t.loop.shellChanged({ surfaces: shown });
  for (const id of ['OnNotifySelfInfo', 'OnNotifyShellInfo', 'OnNotifyDressupInfo', 'installedshellname', 'OnShellChanged']) {
    assert.equal(has(t.shiori.find(id)[0]), true, id);
  }
  assert.equal(has(t.shiori.find('OnTranslate').at(-1)), false, "OnShellChanged's reply is translated after it went");
  assert.doesNotMatch(t.loop.statusHeader(), /changing/);
  t.loop.destroy();

  // 204 to OnShellChanging: set too; a cancel clears it (SSP leaves +0x41a4 set [decision])
  t = await booted();
  assert.deepEqual(await t.loop.shellChanging(ALT), { ok: true });
  assert.match(t.loop.statusHeader(), /\bchanging\b/);
  t.loop.destroy();
  assert.doesNotMatch(t.loop.statusHeader(), /changing/);
  t = await booted({ handler: answers({ OnShellChanging: '\\0Changing.\\e' }) });
  done = null;
  t.loop.shellChanging(ALT).then(x => { done = x; });
  await settle();
  t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  assert.deepEqual(done, { ok: false });
  assert.doesNotMatch(t.loop.statusHeader(), /changing/);
  t.loop.destroy();

  // a script's \![change,shell]: from the swap's start, after its binds' report; 204: the restored surfaces without it
  t = await booted();
  t.loop.playScript('\\0\\![bind,髪,ツインテール,1]\\![change,shell,Winter]and on\\e', { event: 'OnTalk' });
  t.stage.emit('bind', { scope: 0, id: 1, category: '髪', part: 'ツインテール', on: true });
  assert.doesNotMatch(t.loop.statusHeader(), /changing/);
  t.shiori.log.length = 0;
  const shown2 = t.loop.detachStage();
  assert.equal(t.shiori.find('OnNotifyDressupInfo').length, 1);
  assert.equal(has(t.shiori.find('OnNotifyDressupInfo')[0]), false, 'the binds so far go first [disasm 0x623120]');
  assert.match(t.loop.statusHeader(), /^talking,changing\b/);
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  await t.loop.shellChanged({ surfaces: shown2, defer: true });
  await settle();
  assert.equal(has(t.shiori.find('OnShellChanged')[0]), true);
  assert.ok(t.shiori.find('OnSurfaceChange').length > 0);
  assert.ok(t.shiori.find('OnSurfaceChange').every(r => !has(r)), 'PopSurfaceStatus after the clear [disasm 0x62349d]');
  assert.doesNotMatch(t.loop.statusHeader(), /changing/);
  t.loop.destroy();

  // a failed swap: the old stage back ends it [disasm 0x6230e5, 0x623113]
  t = await booted();
  const old = t.stage;
  t.loop.detachStage();
  t.loop.attachStage(old, { id: 'master', name: 'master', path: '/ghost/testghost/shell/master/' });
  assert.doesNotMatch(t.loop.statusHeader(), /changing/);
  t.loop.destroy();

  // a balloon change: ChangeOrReloadBalloonInternal never sets +0x41a4
  t = await booted();
  t.loop.setBalloonInfo({ name: 'LightBlue', path: '/ghost/tsubasa/LightBlue/' });
  await t.loop.balloonChanged();
  assert.equal(t.shiori.find('OnBalloonChange').length, 1);
  assert.equal(has(t.shiori.find('OnBalloonChange')[0]), false);
  t.loop.destroy();
});

test('a \\![raise] reply held by the swap follows raise()\'s rule: dropped once a run started after the raising one, else played after the swap', async () => {
  // OnShellChanged's reply replaced the raising run: the held reply goes, as outside a swap
  let t = await booted({ handler: answers({ OnFoo: '\\0foo\\e', OnShellChanged: '\\0new\\e' }) });
  t.loop.playScript('\\0talk\\e', { event: 'OnTalk' });
  let shown = t.loop.detachStage();
  assert.equal(await t.loop.raise('OnFoo', []), '\\0foo\\e', 'the player sees the reply (its run stops)');
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  await t.loop.shellChanged({ surfaces: shown });
  await settle();
  t.player.finish();
  await settle();
  assert.deepEqual(t.player.plays.map(p => p.meta.event), ['OnTalk', 'OnShellChanged']);
  assert.equal(t.loop._replyQueue.length, 0);
  t.loop.destroy();

  // 204: nothing replaced it, so the held reply plays once the raising run is over
  t = await booted({ handler: answers({ OnFoo: '\\0foo\\e', OnKeyPress: '\\0key\\e' }) });
  t.loop.playScript('\\0talk\\e', { event: 'OnTalk' });
  shown = t.loop.detachStage();
  await t.loop.raise('OnFoo', []);
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  await t.loop.shellChanged({ surfaces: shown });
  t.player.finish();
  await settle();
  assert.deepEqual(t.player.plays.map(p => p.meta.event), ['OnTalk', 'OnFoo']);
  t.player.finish();
  await settle();

  // queued after a 204, but another run starts before it could play: dropped too
  t.loop.playScript('\\0talk\\e', { event: 'OnTalk' });
  shown = t.loop.detachStage();
  await t.loop.raise('OnFoo', []);
  t.loop.attachStage(new VStage({ surfaces: {} }), ALT);
  await t.loop.shellChanged({ surfaces: shown });
  await t.loop.send('OnKeyPress', ['c', 67, 1, 0, '']);         // her reply to a key replaces the raising run
  t.player.finish();
  await settle();
  assert.deepEqual(t.player.plays.map(p => p.meta.event).slice(2), ['OnTalk', 'OnKeyPress']);
  assert.equal(t.loop._replyQueue.length, 0);
  t.loop.destroy();
});

// ---------------------------------------------------------------- balloons

test('balloonChanged: NOTIFY OnNotifySelfInfo with the new R5/R6, then GET OnBalloonChange [name, path]', async () => {
  let t = await booted({ handler: answers({ OnBalloonChange: '\\0…と言う名の風船\\e' }) });
  t.loop.setBalloonInfo({ name: 'LightBlue', path: '/ghost/tsubasa/LightBlue/' });
  await t.loop.balloonChanged();
  assert.deepEqual(t.shiori.ids().slice(0, 2), ['NOTIFY OnNotifySelfInfo', 'GET OnBalloonChange']);
  assert.deepEqual(t.shiori.find('OnNotifySelfInfo')[0].refs.slice(5), ['LightBlue', '/ghost/tsubasa/LightBlue/']);
  assert.deepEqual(t.shiori.find('OnBalloonChange')[0].refs, ['LightBlue', '/ghost/tsubasa/LightBlue/']);
  assert.equal(t.player.last.script, '\\0…と言う名の風船\\e');
  t.shiori.log.length = 0;
  await t.loop.balloonChanged({ event: false });             // a shell's own balloon, switched silently
  assert.deepEqual(t.shiori.ids(), ['NOTIFY OnNotifySelfInfo']);
  t.loop.destroy();

  t = await booted({ handler: answers({ OnBalloonChange: '\\0new look\\e' }) });
  t.loop.playScript('\\0\\![change,balloon,random]and on\\e');
  t.loop.setBalloonInfo({ name: 'Sumika', path: '/balloon/sumika/' });
  await t.loop.balloonChanged({ defer: true });
  await settle();
  assert.equal(t.player.plays.length, 1);
  t.player.finish();
  await settle();
  assert.equal(t.player.last.script, '\\0new look\\e');
  t.loop.destroy();
});

// ---------------------------------------------------------------- with the real player

test('real player: \\![change,shell,X] holds the script at the tag; the rest plays on the new stage, then OnShellChanged\'s reply', async () => {
  const m = playerMocks();
  m.player.destroy();
  const m2 = playerMocks();                               // the new shell's stage (its own recording)
  m2.player.destroy();
  const clock = new FakeClock();
  const shiori = new FakeShiori(answers({ OnShellChanged: '\\0\\s[7]How do I look?\\e' }));
  const loop = new EventLoop({ shiori, stage: m.stage, balloons: m.balloons, clock, env: { win: null, doc: null }, ghost: GHOST });
  const player = new ScriptPlayer({
    stage: m.stage, balloons: m.balloons, host: loop, clock: m.clock, speedMs: 0, viewport: () => ({ width: 1000, height: 800 }),
  });
  loop.setPlayer(player);
  await loop.boot({ resume: false });
  shiori.log.length = 0;
  const gate = deferred();
  const reqs = [];
  loop.viewSwitcher = async req => {                     // what Runtime._requestView does for a script's change
    reqs.push(req);
    await gate.promise;
    const shown = loop.detachStage();
    loop.attachStage(m2.stage, ALT);
    await loop.shellChanged({ surfaces: shown, defer: true });
    return true;
  };
  const runOut = async () => { for (let i = 0; i < 3; i++) { await m.clock.runAll(); await settle(); } };

  loop.playScript('\\0before\\![change,shell,Winter]\\s[5]after\\e', { event: 'OnTalk' });
  await runOut();
  assert.deepEqual(reqs.map(r => [r.kind, r.target, r.raiseEvent, r.fromScript]), [['shell', 'Winter', false, true]]);
  assert.equal(m.balloons.get(0).text, 'before');
  assert.equal(player.run.state, 'blocked', 'waiting at the tag for the swap');
  gate.resolve();
  await runOut();
  assert.match(m.balloons.get(0).text, /How do I look\?$/);
  const writes = m.rec.log.filter(e => e[0] === 'b' && e[2] === 'write').map(e => e[3]);
  assert.deepEqual(writes, ['before', 'after', 'How do I look?'], 'the rest of the script, then the reply');
  assert.deepEqual(m2.rec.log.filter(e => e[0] === 'c' && e[2] === 'setSurface').map(e => [e[1], e[3]]), [[0, 5], [0, 7]],
    '\\s after the tag and in the reply go to the new stage');
  assert.equal(m.rec.log.filter(e => e[0] === 'c' && e[2] === 'setSurface' && e[3] === 5).length, 0);
  const ids = shiori.ids();
  assert.ok(ids.indexOf('GET OnShellChanged') < ids.lastIndexOf('GET OnTranslate'), 'the reply is translated at the end');
  loop.destroy();
  player.destroy();
});

test('real player: a script still playing when the swap starts is held from detachStage until the swap ends, then goes on on the new stage after the restored surfaces', async () => {
  const m = playerMocks();
  m.player.destroy();
  const m2 = playerMocks();                               // the new shell's stage
  m2.player.destroy();
  const shiori = new FakeShiori(answers({}));             // OnShellChanged: 204
  const loop = new EventLoop({ shiori, stage: m.stage, balloons: m.balloons, clock: new FakeClock(), env: { win: null, doc: null }, ghost: GHOST });
  const player = new ScriptPlayer({
    stage: m.stage, balloons: m.balloons, host: loop, clock: m.clock, speedMs: 50, viewport: () => ({ width: 1000, height: 800 }),
  });
  loop.setPlayer(player);
  await loop.boot({ resume: false });
  const surfaces = rec => rec.log.filter(e => e[0] === 'c' && e[2] === 'setSurface').map(e => [e[1], e[3]]);
  loop.playScript('\\0\\s[3]ab\\_w[500]\\s[5]c\\e', { event: 'OnTalk' });
  await m.clock.advance(60);                              // 'a' at 0, 'b' at 50, then the wait
  const shown = loop.detachStage();
  assert.deepEqual([...shown], [[0, 3]]);
  await m.clock.advance(2000);
  assert.deepEqual(surfaces(m.rec), [[0, 3]], 'nothing more on the stage being replaced');
  assert.equal(m.balloons.get(0).text, 'ab');
  assert.equal(player.busy, true, 'still her talk (cantalk stays 0)');
  loop.attachStage(m2.stage, ALT);
  await m.clock.advance(2000);
  assert.deepEqual(surfaces(m2.rec), [], 'held until OnShellChanged has answered');
  await loop.shellChanged({ surfaces: shown });
  assert.deepEqual(surfaces(m2.rec), [[0, 3]], '204: the surface comes back first');
  await m.clock.advance(400);
  assert.equal(m.balloons.get(0).text, 'ab', 'the rest of her wait');
  await m.clock.advance(200);
  assert.deepEqual(surfaces(m2.rec), [[0, 3], [0, 5]], 'then the script goes on, on the new stage');
  assert.equal(m.balloons.get(0).text, 'abc');
  assert.deepEqual(surfaces(m.rec), [[0, 3]]);
  loop.destroy();
  player.destroy();
});

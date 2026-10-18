// Ghost switching (EV §2.5, UI §2.1 #12): target resolution, the menu model, the event loop's leaving and arriving
// halves, and the runtime's switch flow with fake engines (per-ghost storage, resume, refusals, failures, other tabs).
// The site index is tests/fixtures/ghosts.json, so these tests do not depend on the ghosts in site/ghost/.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime, chooseGhost, resolveGhostTarget } from '../../src/core/runtime.js';
import { EventLoop } from '../../src/core/events.js';
import { UiLanguage } from '../../src/core/language.js';
import { StateStore, GhostLock, memoryStorage, runtimePrefs, sessionMarker, stateKey, RUNTIME_KEY } from '../../src/core/state.js';
import { buildMenuModel, ghostItems, menuResourceIds, parseCaption, Menu } from '../../src/ui/menu.js';
import { SUPPORTED_ENGINES, engineSupported, engineNote } from '../../src/worker/engines/supported.js';
import { ENGINES } from '../../src/worker/engines/index.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle, deferred } from './fakes.mjs';

setLogLevel('silent');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/ghosts.json'), 'utf8'));
const G = Object.fromEntries(SITE.ghosts.map(g => [g.id, g]));
const ids = list => list.map(g => (g ? g.id : null));

function siteIndex(ghosts = SITE.ghosts) {
  return { base: 'http://s/', ghosts, balloons: [], ghost: id => ghosts.find(g => g.id === id) || null, balloon: () => null };
}

// ---------------------------------------------------------------- pure parts

test('engines: the page list matches the worker registry; a Misaka ghost is not runnable', () => {
  assert.deepEqual([...SUPPORTED_ENGINES].sort(), Object.keys(ENGINES).sort());
  assert.equal(engineSupported(G.tsubasa), true);
  assert.equal(engineSupported({}), true, 'no engine field = Satori');
  assert.equal(engineSupported(G.misakaghost), false);
  assert.equal(engineNote(G.tsubasa), null);
  assert.equal(engineNote(G.misakaghost), 'needs Misaka');
  assert.equal(engineNote({ engine: 'shiori', shiori: 'shiori.dll' }), 'needs shiori.dll');
});

test('target: descript name, sakura name, folder id; random and sequential skip the current ghost and ones whose engine is missing', () => {
  const list = SITE.ghosts;          // testghost, tsubasa, misakaghost
  assert.equal(resolveGhostTarget(list, 'tsubasa', 'Test Ghost').id, 'testghost');
  assert.equal(resolveGhostTarget(list, 'tsubasa', 'Testy').id, 'testghost');
  assert.equal(resolveGhostTarget(list, 'tsubasa', 'testghost').id, 'testghost');
  assert.equal(resolveGhostTarget(list, 'tsubasa', ' hayama-san next door ').id, 'tsubasa', 'trimmed, any case as a last resort');
  assert.equal(resolveGhostTarget(list, 'tsubasa', 'Misaka Test').id, 'misakaghost', 'named outright: the change refuses it');
  assert.equal(resolveGhostTarget(list, 'tsubasa', 'Nobody'), null);
  assert.equal(resolveGhostTarget(list, 'tsubasa', 'lastinstalled'), null);
  assert.equal(resolveGhostTarget(list, 'tsubasa', ''), null);
  assert.equal(resolveGhostTarget(list, 'tsubasa', 'Testy', { byId: true }), null, 'menu ids are ids only');
  for (const r of [0, 0.5, 0.999]) assert.equal(resolveGhostTarget(list, 'tsubasa', 'random', { random: () => r }).id, 'testghost');
  assert.equal(resolveGhostTarget(list, 'tsubasa', 'RANDOM', { random: () => 0 }).id, 'testghost');
  assert.equal(resolveGhostTarget(list, 'tsubasa', 'sequential').id, 'testghost', 'wraps past the Misaka ghost');
  assert.equal(resolveGhostTarget(list, 'testghost', 'sequential').id, 'tsubasa');
  assert.equal(resolveGhostTarget([G.tsubasa], 'tsubasa', 'random'), null, 'one ghost: nothing to change to');
  assert.equal(resolveGhostTarget([G.tsubasa, G.misakaghost], 'tsubasa', 'sequential'), null);
});

test('ghost choice passes over ghosts whose engine is missing', () => {
  const index = siteIndex();
  assert.equal(chooseGhost(index, { supported: engineSupported }).id, 'testghost');
  assert.equal(chooseGhost(index, { stored: 'misakaghost', defaultGhost: 'tsubasa', supported: engineSupported }).id, 'tsubasa');
  assert.equal(chooseGhost(siteIndex([G.misakaghost, G.tsubasa]), { supported: engineSupported }).id, 'tsubasa');
  assert.equal(chooseGhost(siteIndex([G.misakaghost]), { supported: engineSupported }).id, 'misakaghost', 'nothing runnable: the old rule');
});

test('menu: Change ghost ▸ after Utilities, before Iconify; current checked and enabled; Misaka disabled with its reason', () => {
  const ghosts = [
    { id: 'testghost', name: 'Test Ghost', current: false, note: null },
    { id: 'tsubasa', name: 'Hayama-san Next Door', current: true, note: null },
    { id: 'misakaghost', name: 'Misaka & Co', current: false, note: 'needs Misaka' },
  ];
  const res = new Map([['hidebutton.caption', 'Hide for a Bit(&R)']]);
  const m = buildMenuModel(0, res, { ghosts });
  assert.deepEqual(m.map(i => (i.kind === 'sep' ? '-' : i.label)), ['&Recommendations', 'Por&tal site', '-',
    'Utilities (&F)', '-', 'Change &ghost', '-', 'Hide for a Bit(&R)', '-', 'Close (&W)', 'Quit (&X)']);
  const sub = m.find(i => i.label === 'Change &ghost');
  assert.equal(sub.kind, 'sub');
  assert.deepEqual(sub.items.map(i => [parseCaption(i.label).text, !!i.checked, !!i.disabled]), [
    ['Test Ghost', false, false], ['Hayama-san Next Door', true, false], ['Misaka & Co', false, true],
  ]);
  assert.deepEqual(sub.items[0].action, { type: 'ghost', id: 'testghost' });
  // the reason is drawn next to the label, not in it: a long name's ellipsis never hides it
  assert.deepEqual(sub.items.map(i => i.note), [null, null, 'needs Misaka']);
  assert.ok(menuResourceIds(0).includes('ghostrootbutton.caption') && menuResourceIds(0).includes('ghostrootbutton.visible'));
  assert.ok(!menuResourceIds(1).includes('ghostrootbutton.caption'), 'the abbreviated menu has no Change ghost (UI §2.2)');

  // one ghost (SSP lists the running ghost alone); the ghost may rename or hide the item
  const one = buildMenuModel(0, new Map([['ghostrootbutton.caption', 'Swap(&S)']]), { ghosts: [ghosts[1]] });
  const s1 = one.find(i => i.kind === 'sub' && i.label === 'Swap(&S)');
  assert.deepEqual(s1.items.map(i => [i.label, i.checked, i.disabled]), [['Hayama-san Next Door', true, false]], 'its own row stays enabled: a pick reloads it');
  // ghostrootbutton.visible 0 greys it in place (UI §2.11); passive mode etc. (enable level ≥ 2) too
  const hidden = buildMenuModel(0, new Map([['ghostrootbutton.visible', '0']]), { ghosts });
  assert.equal(hidden.find(i => i.kind === 'sub' && i.label === 'Change &ghost').disabled, true);
  assert.equal(buildMenuModel(0, new Map(), { ghosts, enableLevel: 2 }).find(i => i.label === 'Change &ghost').disabled, true);
  assert.equal(buildMenuModel(0, new Map(), { ghosts }).find(i => i.label === 'Change &ghost').disabled, false);
  assert.ok(!buildMenuModel(1, new Map(), { ghosts }).some(i => i.kind === 'sub' && i.label === 'Change &ghost'));
  assert.deepEqual(ghostItems([{ id: 'x', name: 'A&B' }])[0].label, 'A&&B');

  // picking one asks the event loop, with OnGhostChanging (manual) and the menu's scope
  const calls = [];
  new Menu({ host: { changeGhost: (...a) => calls.push(a) } })._run({ type: 'ghost', id: 'testghost' }, 0);
  assert.deepEqual(calls, [['testghost', { reason: 'manual', raiseEvent: true, scope: 0, byId: true }]]);
});

// ---------------------------------------------------------------- the event loop's halves

function loopFor(ghost, { handler, state } = {}) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const player = new FakePlayer();
  const balloons = new FakeBalloons();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons, dialogs: new FakeDialogs(), ghost, clock,
    state: state || new StateStore(ghost.id, { storage: memoryStorage(), clock }), env: { win: null, doc: null },
    ghostDescript: new Map([['name', ghost.name], ['sakura.name', ghost.sakuraName]]), site: siteIndex(),
  });
  return { clock, shiori, player, balloons, loop };
}
const answers = map => r => (typeof map[r.id] === 'function' ? map[r.id](r) : map[r.id] ?? null);
const NEXT = { sakuraName: 'Testy', name: 'Test Ghost', path: '/ghost/testghost/' };

test('scripts: \\![change,ghost,…], \\+ and \\_+ ask the runtime; only --option=raise-event sends OnGhostChanging', async () => {
  const t = loopFor(G.tsubasa);
  await t.loop.boot({ resume: false });
  const asked = [];
  t.loop.on('change', r => asked.push(r));
  t.loop.change('ghost', ['Test Ghost']);
  t.loop.change('ghost', ['random']);                       // \+ (the player sends it so)
  t.loop.change('ghost', ['sequential']);                   // \_+
  t.loop.change('ghost', ['Testy', '--option=raise-event']);
  t.loop.change('ghost', ['']);
  t.loop.change('shell', ['master']);                      // a shell change: never the ghost change's 'change' event
  assert.deepEqual(asked.map(r => [r.target, r.raiseEvent, r.fromScript, r.byId]), [
    ['Test Ghost', false, true, false], ['random', false, true, false], ['sequential', false, true, false], ['Testy', true, true, false],
  ]);
  // a script's change goes as ssp.exe's tag posts it: OnGhostChanging R1 `automatic` [disasm 2.9.10 0x62cd63]
  assert.equal(asked[3].reason, 'automatic');
  t.loop.destroy();
});

test('leaving: OnGhostChanging [next sakura, manual, name, path] (no Status flag of its own) plays to its end, then OnDestroy and unload', async () => {
  const t = loopFor(G.tsubasa, { handler: answers({ OnGhostChanging: r => `\\0Say hi to ${r.refs[0]}-san for me.\\e` }) });
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  let done = null;
  t.loop.farewell(NEXT, { reason: 'manual', raiseEvent: true }).then(r => { done = r; });
  await settle();
  const ch = t.shiori.find('OnGhostChanging')[0];
  assert.deepEqual(ch.refs, ['Testy', 'manual', 'Test Ghost', '/ghost/testghost/']);
  assert.equal(ch.headers.BaseID, undefined, 'no BaseID, as ssp.exe 2.9.10');
  // Status `changing` is SPGhost+0x41a4, a shell change's; a ghost change sets none of AddStatusText's fields
  // [disasm 2.9.10 0x639b32, OnChangeMessage 0x4971d5–0x4974c3] (EV §1.6)
  assert.doesNotMatch(ch.headers.Status || '', /changing/);
  assert.equal(t.player.last.script, '\\0Say hi to Testy-san for me.\\e');
  assert.equal(done, null, 'the change waits for her farewell');
  assert.equal(t.loop.cantalk, false);
  assert.equal(t.loop.statusHeader(), 'talking', 'her farewell is just talking');
  t.player.finish();
  await settle();
  assert.deepEqual(done, { ok: true, script: '\\0Say hi to Testy-san for me.\\e' });
  assert.ok(!t.shiori.find('OnClose').length);
  t.loop.timerRaise(5000, '1', 'later');
  await t.loop.leave();
  assert.deepEqual(t.shiori.ids().slice(-1), ['NOTIFY OnDestroy']);
  assert.equal(t.shiori.unloaded, true);
  const st = t.loop.state.data;
  assert.deepEqual([st.closed, st.run, st.timers, st.boxes], [false, null, [], []], 'stored without a run or timers');
  t.loop.destroy();
});

test('leaving: 204 falls back to OnClose; Satori\'s \\- there ends the farewell, not the ghost', async () => {
  const t = loopFor(G.tsubasa, { handler: answers({ OnClose: '\\0Bye.\\-' }) });
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  const p = t.loop.farewell(NEXT, { reason: 'manual', raiseEvent: true, scope: 0 });
  await settle();
  assert.deepEqual(t.shiori.find('OnClose').map(r => r.refs), [['user']], 'R0 user alone, as ssp.exe 2.9.10');
  t.loop.quit();                                             // the player reaches \- ...
  t.player.cur.resolve({ reason: 'quit', hasChoices: false });
  t.player.busy = false;
  assert.deepEqual(await p, { ok: true, script: '\\0Bye.\\-' });
  assert.equal(t.loop.closed, false, '... and the ghost is not closed by it');
  assert.ok(!t.shiori.find('OnDestroy').length);
  t.loop.destroy();
});

test('leaving: a balloon break during OnGhostChanging cancels the change; a script\'s own change sends no OnGhostChanging', async () => {
  const t = loopFor(G.tsubasa, { handler: answers({ OnGhostChanging: '\\0Off you go...\\e' }) });
  await t.loop.boot({ resume: false });
  const p = t.loop.farewell(NEXT, { raiseEvent: true });
  await settle();
  t.balloons.emit('dblclick', { scope: 0 });
  assert.deepEqual(await p, { ok: false, script: '' });
  assert.equal(t.loop.changing, false);
  assert.equal(t.shiori.find('OnBalloonBreak').length, 1);

  // \![change,ghost,random] at the end of a talk: that talk finishes; it is OnGhostChanged's R1
  t.loop.playScript('\\0Have a good time.\\![change,ghost,random]\\e', { event: 'ランダムで交替' });
  t.shiori.log.length = 0;
  const q = t.loop.farewell(NEXT, { raiseEvent: false, fromScript: true });
  await settle();
  assert.equal(t.player.last.script, '\\0Have a good time.\\![change,ghost,random]\\e', 'nothing replaces it');
  t.player.finish();
  assert.deepEqual(await q, { ok: true, script: '\\0Have a good time.\\![change,ghost,random]\\e' });
  assert.ok(!t.shiori.find('OnGhostChanging').length && !t.shiori.find('OnClose').length);
  t.loop.destroy();

  // the menu does not wait for a talk: OnGhostChanging replaces it at once
  const m = loopFor(G.tsubasa, { handler: answers({ OnGhostChanging: '\\0Bye!\\e' }) });
  await m.loop.boot({ resume: false });
  m.loop.playScript('\\0A long story...\\e');
  const r = m.loop.farewell(NEXT, { raiseEvent: true });
  await settle();
  assert.equal(m.player.last.script, '\\0Bye!\\e');
  m.player.finish();
  assert.deepEqual(await r, { ok: true, script: '\\0Bye!\\e' });
  m.loop.destroy();
});

test('arriving: OnGhostChanged [prev sakura, its script, name, path, R7 shell] instead of OnBoot; 204 -> OnBoot; first meeting -> OnFirstBoot', async () => {
  const changed = { sakuraName: 'Tsubasa', name: 'Hayama-san Next Door', path: '/ghost/tsubasa/', script: '\\0Bye\\e' };
  let t = loopFor(G.testghost, { handler: answers({ OnGhostChanged: r => `\\0From ${r.refs[0]}\\e` }) });
  await t.loop.boot({ resume: false, changed });
  const c = t.shiori.find('OnGhostChanged')[0];
  assert.deepEqual(c.refs, ['Tsubasa', '\\0Bye\\e', 'Hayama-san Next Door', '/ghost/tsubasa/', undefined, undefined, undefined, 'master']);
  assert.equal(c.headers.BaseID, 'OnBoot');
  assert.ok(!t.shiori.find('OnBoot').length);
  assert.equal(t.player.last.script, '\\0From Tsubasa\\e');
  t.loop.destroy();

  t = loopFor(G.testghost, { handler: answers({ OnBoot: '\\0Boot\\e' }) });
  await t.loop.boot({ resume: false, changed });
  assert.deepEqual(t.shiori.ids().filter(x => /On(GhostChanged|Boot|FirstBoot)$/.test(x)), ['GET OnGhostChanged', 'GET OnBoot']);
  assert.deepEqual(t.shiori.find('OnBoot')[0].refs, ['master', undefined, undefined, undefined, undefined, undefined, '', '']);
  t.loop.destroy();

  t = loopFor(G.testghost, { handler: answers({ OnFirstBoot: '\\0Nice to meet you\\e' }) });
  await t.loop.boot({ resume: false, firstBoot: true, changed });
  assert.deepEqual(t.shiori.ids().filter(x => /On(GhostChanged|Boot|FirstBoot)$/.test(x)), ['GET OnFirstBoot']);
  t.loop.destroy();
});

test('leaving: a reply to a click during the farewell plays to its end before the change goes on; no menu, Close or Iconify meanwhile', async () => {
  const t = loopFor(G.tsubasa, { handler: answers({ OnGhostChanging: '\\0A long goodbye...\\e', OnMouseDoubleClick: '\\0Menu?\\q[a,b]\\e' }) });
  const menu = { opened: 0, closed: 0, open() { this.opened++; }, close() { this.closed++; } };
  t.loop.menu = menu;
  await t.loop.boot({ resume: false });
  let done = null;
  t.loop.farewell(NEXT, { raiseEvent: true }).then(r => { done = r; });
  await settle();
  assert.equal(menu.closed, 1, 'a menu still open closes');
  await t.loop.send('OnMouseDoubleClick', [0, 0, 0, 0, '', 0, 'mouse']);
  assert.equal(t.player.last.script, '\\0Menu?\\q[a,b]\\e', 'the ghost still answers the visitor');
  await settle();
  assert.equal(done, null, 'the change waits until she is quiet');
  // a right click the ghost does not answer opens no menu now; Close and Iconify do nothing
  const at = { scope: 0, x: 5, y: 5, button: 1 };
  t.loop.stage.emit('mouse', { ...at, type: 'down' });
  t.loop.stage.emit('mouse', { ...at, type: 'up', click: true });
  t.loop.stage.emit('mouse', { ...at, type: 'click' });
  await settle();
  assert.equal(t.shiori.find('OnMouseClick').length, 1);
  assert.equal(menu.opened, 0);
  await t.loop.close(0);
  await t.loop.minimize('user');
  assert.ok(!t.shiori.find('OnCloseAll').length && !t.shiori.find('OnClose').length && !t.shiori.find('OnWindowStateMinimize').length);
  t.player.finish();
  await settle();
  assert.deepEqual(done, { ok: true, script: '\\0A long goodbye...\\e' }, 'R1 is still her goodbye');
  assert.equal(t.loop.closed, false);
  t.loop.destroy();

  // a ghost that keeps talking: the change goes on changeWaitMs after the farewell started, whatever plays then
  const s = loopFor(G.tsubasa, { handler: answers({ OnGhostChanging: '\\0Bye\\e', OnMouseDoubleClick: '\\0More\\e' }) });
  await s.loop.boot({ resume: false });
  let fin = null;
  s.loop.farewell(NEXT, { raiseEvent: true }).then(r => { fin = r; });
  await settle();
  await s.clock.advance(20000);
  await s.loop.send('OnMouseDoubleClick', [0, 0, 0, 0, '', 0, 'mouse']);
  await s.clock.advance(9990);
  assert.equal(fin, null);
  await s.clock.advance(20);
  assert.deepEqual(fin, { ok: true, script: '\\0Bye\\e' });
  s.loop.destroy();
});

// ---------------------------------------------------------------- the runtime

class FakeLocks {
  constructor() { this.held = new Set(); this.queue = new Map(); }
  request(name, opts, cb) {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.held.add(name);
        Promise.resolve(cb({ name })).then(v => { this.held.delete(name); resolve(v); this._next(name); }, reject);
      };
      if (!this.held.has(name)) grant();
      else if (opts && opts.ifAvailable) Promise.resolve(cb(null)).then(resolve, reject);
      else { if (!this.queue.has(name)) this.queue.set(name, []); this.queue.get(name).push(grant); }
    });
  }
  _next(name) { const q = this.queue.get(name); if (q && q.length && !this.held.has(name)) q.shift()(); }
}

/** BroadcastChannel stand-in: every channel of the same name on one bus hears the others. */
function busChannel() {
  const all = new Set();
  return class {
    constructor(name) { this.name = name; this.onmessage = null; all.add(this); }
    postMessage(data) {
      const msg = structuredClone(data);
      for (const c of all) if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage && c.onmessage({ data: msg }));
    }
    close() { all.delete(this); }
  };
}

class TestStage extends FakeStage {
  constructor(rt) { super(); this.destroyed = false; this.rt = rt; this.veiled = false; this.veils = []; }
  defaultSurface(s) { return s === 0 ? 0 : 10; }
  destroy() { this.destroyed = true; }
  /** records each veil change with the events the newest player had started by then */
  setVeiled(on) {
    if (on === this.veiled) return;      // like Stage.setVeiled
    this.veiled = on;
    const p = this.rt && this.rt.players.length > this.players0 ? this.rt.player : null;
    this.veils.push([on, p ? p.plays.map(e => e.meta && e.meta.event) : []]);
  }
}
class TestBalloons extends FakeBalloons { destroy() {} }

/**
 * The browser around the runtime: storages (localStorage shared by the tabs, sessionStorage per tab — here per test),
 * the engines' save files (IndexedDB ghost:<id>:files) and what each ghost answers.
 */
function world({ ghosts = SITE.ghosts, answer = defaultAnswer, failEngine = () => false } = {}) {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  return { index: siteIndex(ghosts), locks: new FakeLocks(), Channel: busChannel(), saves: new Map(), engines: [], answer, failEngine };
}

function defaultAnswer(id, r, mem) {
  switch (r.id) {
    case 'OnBoot': return `\\0${id}: boot\\e`;
    case 'OnFirstBoot': mem.met = 1; return `\\0${id}: first\\e`;
    case 'OnGhostChanging': return `\\0${id}: bye, ${r.refs[0]} (${r.refs[1]})\\e`;
    case 'OnGhostChanged': mem.changes = (mem.changes || 0) + 1; return `\\0${id}: from ${r.refs[0]} #${mem.changes}\\e`;
    default: return null;
  }
}

const LIVE = new Set();                 // runtimes still running (their clocks) are stopped after each test
afterEach(() => { for (const rt of LIVE) rt.done(); });

class TestRuntime extends Runtime {
  constructor(w, { defaultGhost = 'tsubasa' } = {}) {
    super({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', defaultGhost, Channel: w.Channel });
    this.w = w;
    this.index = w.index;
    this.players = [];
    LIVE.add(this);
  }
  _newLock(id) { return new GhostLock(id, { locks: this.w.locks, Channel: null }); }
  async _ghostCommon() {
    const g = this.ghost;
    const files = { url: p => `http://s/ghost/${g.id}/${p}`, has: () => false, list: () => [] };
    return { files, ghostDescript: new Map([['name', g.name], ['sakura.name', g.sakuraName]]), shellId: g.defaultShell || 'master' };
  }
  async _startEngine(files, { resume, bootEpochMs }) {
    const g = this.ghost;
    if (this.w.hold && this.w.hold[g.id]) await this.w.hold[g.id];      // an engine still loading
    if (this.w.failEngine(g.id)) throw new Error(`no engine for ${g.id}`);
    const hadSave = this.w.saves.has(g.id);
    const mem = { ...(this.w.saves.get(g.id) || {}) };
    const sh = new FakeShiori(r => this.w.answer(g.id, r, mem));
    sh.ghost = g.id;
    sh.resume = resume;
    sh.bootEpochMs = bootEpochMs;
    sh.hadSave = hadSave;
    sh.terminate = () => { sh.terminated = true; };
    sh.unload = async () => { sh.unloaded = true; this.w.saves.set(g.id, { ...mem }); return []; };
    sh.persist = async () => { sh.persisted++; this.w.saves.set(g.id, { ...mem }); return []; };
    // ShioriClient.reload (\![reload,shiori], EV §2.10): marked in the log when asked; records start()'s options
    sh.reloads = [];
    sh.reload = async opts => {
      sh.log.push({ method: 'RELOAD', id: 'engine', refs: [], headers: {} });
      const o = await opts();
      if (this.w.failReload) throw new Error('the engine did not load again');
      sh.reloads.push(o);
      this.w.saves.set(g.id, { ...mem });
      return { ok: true, hadSave: true };
    };
    this.w.engines.push(sh);
    return { client: sh, r: { hadSave } };
  }
  async _engineStartOptions(files, o) { return { engine: this.ghost.engine || 'satori', ...o }; }
  async _createStage() { const s = new TestStage(this); s.players0 = this.players.length; return s; }
  async _loadSkin() { return { skin: { balloon: () => null }, name: '', path: '' }; }
  async _createBalloons() { return new TestBalloons(); }
  _createDialogs() { return new FakeDialogs(); }
  _createPlayer() { const p = new FakePlayer(); this.players.push(p); return p; }
  get loop() { return this.parts && this.parts.loop; }
  get player() { return this.players[this.players.length - 1]; }
  done() {
    LIVE.delete(this);
    this._teardown();
    this._clearFrozen();
    if (this.lock) this.lock.dispose();
    if (this._channel) this._channel.close();
  }
}

const bootIds = sh => sh.ids().filter(x => /On(GhostChanged|GhostChanging|Boot|FirstBoot|Close|Destroy)$/.test(x));
const last = w => w.engines[w.engines.length - 1];

/** A switch the runtime runs while the test plays the leaving ghost's farewell to its end. */
async function switchTo(rt, id) {
  const leaving = rt.loop;
  const p = rt.changeGhost(id);
  for (let i = 0; i < 20 && !(leaving && leaving.current && leaving.current.event === 'OnGhostChanging'); i++) await settle();
  if (rt.player && rt.player.busy) rt.player.finish();
  return p;
}

test('runtime: menu switch A -> B: A says goodbye and unloads, B gets OnGhostChanged; the choice and the tab marker follow', async () => {
  const w = world();
  w.saves.set('testghost', { changes: 4 });              // she has been here before
  const rt = new TestRuntime(w);
  assert.equal(await rt.start(), 'booted');
  const a = last(w);
  assert.equal(a.ghost, 'tsubasa');
  rt.player.finish();
  assert.deepEqual(rt.ghostList().map(g => [g.id, g.current, g.note, g.needs]),
    [['testghost', false, null, null], ['tsubasa', true, null, null], ['misakaghost', false, 'needs Misaka', 'Misaka']]);

  const p = rt.changeGhost('testghost');
  await settle();
  assert.deepEqual(bootIds(a).slice(-1), ['GET OnGhostChanging']);
  assert.deepEqual(a.find('OnGhostChanging')[0].refs, ['Testy', 'manual', 'Test Ghost', '/ghost/testghost/']);
  assert.equal(w.engines.length, 1, 'B waits for the farewell');
  assert.equal(rt.player.last.script, '\\0tsubasa: bye, Testy (manual)\\e');
  rt.player.finish();
  assert.equal(await p, true);
  assert.deepEqual(bootIds(a).slice(-2), ['GET OnGhostChanging', 'NOTIFY OnDestroy']);
  assert.equal(a.unloaded, true);
  const b = last(w);
  assert.equal(b.ghost, 'testghost');
  assert.equal(b.resume, false);
  assert.deepEqual(bootIds(b), ['GET OnGhostChanged'], 'OnGhostChanged instead of OnBoot');
  assert.deepEqual(b.find('OnGhostChanged')[0].refs.slice(0, 4), ['Tsubasa', '\\0tsubasa: bye, Testy (manual)\\e', 'Hayama-san Next Door', '/ghost/tsubasa/']);
  assert.equal(rt.player.last.script, '\\0testghost: from Tsubasa #5\\e', 'her memory came back');
  assert.equal(rt.ghost.id, 'testghost');
  assert.equal(runtimePrefs.get().ghost, 'testghost');
  assert.equal(sessionMarker.read().ghost, 'testghost');
  assert.ok(w.locks.held.has('sumika:testghost') && !w.locks.held.has('sumika:tsubasa'));
  assert.ok(localStorage.getItem(stateKey('tsubasa')), 'A saved on the way out');
  assert.equal(rt.state.key, stateKey('testghost'));
  rt.state.saveNow();
  assert.ok(localStorage.getItem(stateKey('testghost')), 'one state per ghost');
  assert.equal(rt.ghostList().find(g => g.current).id, 'testghost');
  rt.player.finish();
  rt.done();
  await settle();                                        // the page is gone: its locks are let go

  // the next page of this tab resumes her: no OnBoot, no OnGhostChanged
  const rt2 = new TestRuntime(w);
  assert.equal(await rt2.start(), 'booted');
  const b2 = last(w);
  assert.equal(b2.ghost, 'testghost');
  assert.equal(b2.resume, true);
  assert.deepEqual(bootIds(b2), []);

  // back to A: A's own memory and state, OnGhostChanged (not a first boot)
  assert.equal(await switchTo(rt2, 'tsubasa'), true);
  const a2 = last(w);
  assert.equal(a2.ghost, 'tsubasa');
  assert.equal(a2.hadSave, true);
  assert.deepEqual(bootIds(a2), ['GET OnGhostChanged']);
  assert.equal(a2.find('OnGhostChanged')[0].refs[0], 'Testy');
  assert.equal(rt2.player.last.script, '\\0tsubasa: from Testy #1\\e');
  assert.equal(JSON.parse(localStorage.getItem(RUNTIME_KEY)).ghost, 'tsubasa');
  assert.equal(sessionMarker.read().ghost, 'tsubasa');
  rt2.done();
});

test('runtime: a change to the running ghost reloads it: its goodbye to itself, unload, a cold boot, OnGhostChanged naming itself; its lock is kept (ssp.exe 2.9.10)', async () => {
  const w = world();
  const rt = new TestRuntime(w);
  assert.equal(await rt.start(), 'booted');
  const a = last(w);
  rt.player.finish();
  const lock = rt.lock;
  assert.equal(await switchTo(rt, 'tsubasa'), true);
  assert.deepEqual(a.find('OnGhostChanging')[0].refs, ['Tsubasa', 'manual', 'Hayama-san Next Door', '/ghost/tsubasa/']);
  assert.deepEqual(bootIds(a).slice(-2), ['GET OnGhostChanging', 'NOTIFY OnDestroy']);
  assert.equal(a.unloaded, true, 'the engine unloads (and saves)');
  const b = last(w);
  assert.notEqual(b, a, 'a new engine');
  assert.equal(b.ghost, 'tsubasa');
  assert.equal(b.resume, false, 'a cold boot');
  assert.deepEqual(bootIds(b), ['GET OnGhostChanged']);
  assert.deepEqual(b.find('OnGhostChanged')[0].refs.slice(0, 4), ['Tsubasa', '\\0tsubasa: bye, Tsubasa (manual)\\e', 'Hayama-san Next Door', '/ghost/tsubasa/']);
  assert.equal(rt.ghost.id, 'tsubasa');
  assert.equal(rt.lock, lock, 'the same lock, never asked for twice');
  assert.ok(lock.held && w.locks.held.has('sumika:tsubasa'));
  rt.player.finish();

  // a script naming the ghost itself (its sakura name): the same reload, without OnGhostChanging
  const c = last(w);
  rt.loop.change('ghost', ['Tsubasa']);
  await settle();
  if (rt.player && rt.player.busy) rt.player.finish();
  await rt._changing;
  assert.ok(!c.find('OnGhostChanging').length);
  assert.equal(c.unloaded, true);
  assert.equal(last(w).ghost, 'tsubasa');
  assert.deepEqual(bootIds(last(w)), ['GET OnGhostChanged']);
  assert.ok(w.locks.held.has('sumika:tsubasa'));
  rt.done();
});

test('runtime: \\![reload,shiori] (EV §2.10): the same client reloads its engine from the store, cold with the ghost\'s clock; OnDestroy [reload] first, OnInitialize [reload]; no boot event, the script goes on; a load that fails restarts it as a crash', async () => {
  const w = world();
  const rt = new TestRuntime(w);
  assert.equal(await rt.start(), 'booted');
  rt.player.finish();
  const a = last(w);
  const epoch = rt.state.data.bootEpochMs;
  a.log.length = 0;
  rt.loop.playScript('\\0Reloading.\\![reload,shiori]Done.\\e', { event: 'OnTest' });
  const p = rt.loop.reload('shiori');                        // what the player does at the tag
  assert.equal(typeof p.then, 'function', 'the player waits at the tag');
  assert.equal(await p, true);
  assert.equal(w.engines.length, 1, 'the same client');
  assert.equal(rt.parts.client, a);
  assert.deepEqual(a.reloads.map(o => [o.resume, o.bootEpochMs, o.sessionEndMs ?? 0]), [[false, epoch, 0]], 'a cold load, her clock kept');
  assert.deepEqual(a.ids().slice(0, 3), ['NOTIFY OnDestroy', 'RELOAD engine', 'GET version']);
  assert.deepEqual(a.find('OnDestroy')[0].refs, ['reload']);
  assert.deepEqual(a.find('OnInitialize').map(r => r.refs), [['reload']]);
  assert.deepEqual(bootIds(a), ['NOTIFY OnDestroy'], 'no OnBoot, OnFirstBoot, OnGhostChanged');
  assert.equal(rt.player.last.script, '\\0Reloading.\\![reload,shiori]Done.\\e', 'the script plays on');
  assert.equal(rt.state.data.bootEpochMs, epoch);

  // the new engine fails to load: false (the script goes on), and the engine restarts from the store as after a crash
  w.failReload = true;
  assert.equal(await rt.loop.reload('shiori'), false);
  for (let i = 0; i < 20 && w.engines.length < 2; i++) await settle();
  const b = last(w);
  assert.notEqual(b, a);
  assert.deepEqual([b.resume, b.bootEpochMs], [true, epoch], 'a crash restart: resumed from the store');
  for (let i = 0; i < 20 && rt.loop.shiori !== b; i++) await settle();
  assert.equal(rt.loop.shiori, b);
  rt.done();
});

test('runtime: \\![reload,ghost] (EV §2.10): no goodbye; OnDestroy [\'\'] and unload; a new engine, cold, her clock new; booted without a boot event; the script is cut; the lock and the set kept; a page left meanwhile resumes her', async () => {
  const w = world();
  w.saves.set('tsubasa', { changes: 1 });
  const rt = new TestRuntime(w);
  assert.equal(await rt.start(), 'booted');
  rt.player.finish();
  const a = last(w);
  const lock = rt.lock;
  const set = runtimePrefs.get().ghosts;
  const rev = runtimePrefs.get().rev;
  a.log.length = 0;
  rt.loop.playScript('\\0Back in a moment.\\![reload,ghost]and here.\\e', { event: 'OnTest' });
  const player = rt.player;
  const before = Date.now();
  assert.equal(rt.loop.reload('ghost'), undefined, 'the player does not wait');
  const changing = rt._changing;
  assert.ok(changing, 'in the change slot');
  assert.equal(await changing, true);
  assert.ok(!a.find('OnGhostChanging').length && !a.find('OnClose').length, 'no OnGhostChanging, no OnClose (mode 6)');
  assert.deepEqual(a.find('OnDestroy').map(r => [r.method, r.refs]), [['NOTIFY', ['']]], 'ModuleUnloadDirectly: UnloadShiori(0)');
  assert.equal(a.unloaded, true);
  assert.ok(player.interrupts > 0, 'the running script is cut');
  const b = last(w);
  assert.notEqual(b, a, 'a new engine');
  assert.equal(b.ghost, 'tsubasa');
  assert.equal(b.resume, false, 'a cold load');
  assert.ok(b.bootEpochMs >= before, 'her clock starts again');
  assert.deepEqual(bootIds(b), [], 'no OnBoot, OnFirstBoot or OnGhostChanged (AddGhost flag 2 [disasm 0x466d08])');
  assert.deepEqual(b.find('OnInitialize').map(r => r.refs), [['']]);
  assert.ok(b.find('hwnd').length && b.find('OnSurfaceChange').length);
  assert.ok(rt.loop.booted);
  assert.equal(rt.lock, lock, 'the same lock');
  assert.ok(w.locks.held.has('sumika:tsubasa'));
  assert.deepEqual(runtimePrefs.get().ghosts, set, 'the stored set is unchanged');
  assert.ok(runtimePrefs.get().rev >= rev);
  const m = sessionMarker.read();
  assert.deepEqual([m.ghost, m.pending ?? false, m.carry ?? null], ['tsubasa', false, null], 'no change carried');

  // a page left while the new engine loads: the next page resumes her (no OnGhostChanged owed) [decision]
  w.hold = { tsubasa: deferred().promise };
  rt.loop.reload('ghost');
  for (let i = 0; i < 20 && !(rt.parts === null || (rt.parts && !rt.parts.loop)); i++) await settle();
  assert.ok(!rt.parts || !rt.parts.loop, 'the old loop went');
  rt._onPageHide();
  rt.done();
  await settle();
  delete w.hold;
  const rt2 = new TestRuntime(w);
  assert.equal(await rt2.start(), 'booted');
  const c = last(w);
  assert.equal(c.resume, true);
  assert.deepEqual(bootIds(c), []);
  rt2.done();
});

test('runtime: a cold boot keeps its characters veiled until the boot script starts; a resume never veils (EV §2.1 #24)', async () => {
  let release;
  const w = world();
  w.hold = { tsubasa: new Promise(r => { release = r; }) };
  const rt = new TestRuntime(w);
  const started = rt.start();
  await settle();
  const st = rt.parts.stage;
  assert.equal(st.veiled, true, 'veiled while the engine loads');
  release();
  assert.equal(await started, 'booted');
  assert.deepEqual(st.veils, [[true, []], [false, ['OnFirstBoot']]], 'unveiled as the boot script starts, not before');
  rt.player.finish();

  // a switch: B is veiled until OnGhostChanged plays
  w.saves.set('testghost', {});
  assert.equal(await switchTo(rt, 'testghost'), true);
  assert.deepEqual(rt.parts.stage.veils, [[true, []], [false, ['OnGhostChanged']]]);
  rt.player.finish();
  rt.state.saveNow();
  rt.done();
  await settle();

  // the next page resumes her: nothing veiled
  const rt2 = new TestRuntime(w);
  assert.equal(await rt2.start(), 'booted');
  assert.deepEqual(rt2.parts.stage.veils, []);
  rt2.done();

  // a boot event that answers nothing: unveiled once the boot is over
  const w3 = world({ answer: () => null });
  const rt3 = new TestRuntime(w3);
  assert.equal(await rt3.start(), 'booted');
  assert.deepEqual(rt3.parts.stage.veils, [[true, []], [false, []]]);
  rt3.done();
});

test('runtime: a ghost met for the first time gets OnFirstBoot; a script\'s \\![change,ghost,random] sends no OnGhostChanging', async () => {
  const w = world();
  const rt = new TestRuntime(w);
  await rt.start();
  rt.player.finish();
  const a = last(w);
  rt.loop.playScript('\\0See you.\\![change,ghost,random]\\e');
  rt.loop.change('ghost', ['random']);                    // what the player does at the tag
  await settle();
  assert.equal(w.engines.length, 1, 'the talk plays to its end first');
  rt.player.finish();
  await rt._changing;
  const b = last(w);
  assert.equal(b.ghost, 'testghost', 'random: the only other ghost that can run');
  assert.ok(!a.find('OnGhostChanging').length);
  assert.deepEqual(bootIds(a), ['GET OnFirstBoot', 'NOTIFY OnDestroy']);
  assert.deepEqual(bootIds(b), ['GET OnFirstBoot'], 'her first meeting');
  rt.done();
});

test('runtime: a ghost whose engine is missing is refused before anything stops; a single-ghost site has nothing to change to', async () => {
  const w = world();
  const rt = new TestRuntime(w);
  await rt.start();
  rt.player.finish();
  const a = last(w);
  assert.equal(await rt.changeGhost('misakaghost'), false);
  assert.equal(await rt.changeGhost('nobody'), false);
  assert.ok(!a.find('OnGhostChanging').length && !a.unloaded);
  assert.equal(rt.loop.changing, false);
  assert.equal(rt.loop.cantalk, true);
  rt.done();

  const w1 = world({ ghosts: [G.tsubasa] });
  const one = new TestRuntime(w1);
  await one.start();
  one.player.finish();
  assert.deepEqual(one.ghostList(), [{ id: 'tsubasa', name: 'Hayama-san Next Door', current: true, note: null, needs: null }]);
  one.loop.change('ghost', ['random']);
  await settle();
  assert.equal(one._changing, null);
  assert.deepEqual(bootIds(last(w1)), ['GET OnFirstBoot']);
  assert.equal(w1.engines.length, 1);
  one.done();
});

test('runtime: B fails to boot -> A comes back (cold boot) and stays the stored choice', async () => {
  const w = world({ failEngine: id => id === 'testghost' });
  w.saves.set('tsubasa', {});
  const rt = new TestRuntime(w);
  await rt.start();
  rt.player.finish();
  assert.equal(await switchTo(rt, 'testghost'), false);
  const back = last(w);
  assert.equal(back.ghost, 'tsubasa');
  assert.equal(back.resume, false);
  assert.deepEqual(bootIds(back), ['GET OnBoot']);
  assert.equal(rt.ghost.id, 'tsubasa');
  assert.ok(rt.loop && rt.loop.booted);
  assert.equal(runtimePrefs.get().ghost, 'tsubasa');
  assert.equal(sessionMarker.read().ghost, 'tsubasa');
  assert.ok(w.locks.held.has('sumika:tsubasa') && !w.locks.held.has('sumika:testghost'));
  rt.done();
});

test('runtime: another tab follows the change: it shows the new ghost frozen and never runs a second engine', async () => {
  const w = world();
  const tab1 = new TestRuntime(w);
  const tab2 = new TestRuntime(w);
  assert.equal(await tab1.start(), 'booted');
  tab1.player.finish();
  assert.equal(await tab2.start(), 'frozen');
  assert.equal(tab2.ghost.id, 'tsubasa');
  assert.equal(await switchTo(tab1, 'testghost'), true);
  await settle(20);
  assert.equal(tab2.ghost.id, 'testghost', 'the other tab followed');
  assert.equal(tab2.parts, null, 'frozen: no engine there');
  assert.deepEqual(w.engines.map(e => e.ghost), ['tsubasa', 'testghost']);
  assert.ok(w.locks.held.has('sumika:testghost') && !w.locks.held.has('sumika:tsubasa'));
  tab1.done();
  tab2.done();
});

// ---------------------------------------------------------------- pages left and tabs asking during a change

test('runtime: a page left during the farewell carries the change on: the next page boots B with OnGhostChanged, A replays nothing', async () => {
  const w = world();
  w.saves.set('tsubasa', {});
  w.saves.set('testghost', { changes: 2 });
  localStorage.setItem(stateKey('testghost'), JSON.stringify({ v: 1 }));    // met before: a resume would be silent
  const rt = new TestRuntime(w);
  await rt.start();
  rt.player.finish();
  const a = last(w);
  rt.changeGhost('testghost');                           // never settles: the page goes first
  await settle();
  assert.equal(rt.loop.current.event, 'OnGhostChanging');
  rt._onPageHide();                                      // the visitor follows a link mid-goodbye
  rt.done();
  await settle();
  assert.equal(runtimePrefs.get().ghost, 'testghost', 'the choice stands');
  assert.equal(JSON.parse(localStorage.getItem(stateKey('tsubasa'))).run, null, 'her goodbye is not kept for a replay');
  assert.ok(a.persisted > 0, 'her engine saved');

  const rt2 = new TestRuntime(w);
  assert.equal(await rt2.start(), 'booted');
  const b = last(w);
  assert.equal(b.ghost, 'testghost');
  assert.equal(b.resume, false);
  assert.deepEqual(bootIds(b), ['GET OnGhostChanged']);
  assert.deepEqual(b.find('OnGhostChanged')[0].refs.slice(0, 4), ['Tsubasa', '\\0tsubasa: bye, Testy (manual)\\e', 'Hayama-san Next Door', '/ghost/tsubasa/']);
  assert.equal(rt2.player.last.script, '\\0testghost: from Tsubasa #3\\e');
  assert.equal(sessionMarker.read().pending, undefined, 'no longer pending once OnGhostChanged is sent');
  assert.deepEqual(w.engines.map(e => e.ghost), ['tsubasa', 'testghost'], 'A was not started again');
  rt2.done();
  await settle();

  // the page after that resumes B quietly
  const rt3 = new TestRuntime(w);
  assert.equal(await rt3.start(), 'booted');
  assert.equal(last(w).resume, true);
  assert.deepEqual(bootIds(last(w)), []);
  rt3.done();
});

test('runtime: a page left while B\'s engine loads boots B with OnGhostChanged on the next page, not a silent resume', async () => {
  const w = world();
  w.saves.set('testghost', { changes: 1 });
  localStorage.setItem(stateKey('testghost'), JSON.stringify({ v: 1 }));
  const rt = new TestRuntime(w);
  await rt.start();
  rt.player.finish();
  w.hold = { testghost: deferred().promise };            // B's dictionaries take their time
  rt.changeGhost('testghost');
  await settle();
  rt.player.finish();                                    // her goodbye ends
  for (let i = 0; i < 20 && !(sessionMarker.read() && sessionMarker.read().ghost === 'testghost'); i++) await settle();
  assert.equal(sessionMarker.read().pending, true);
  assert.equal(w.engines.length, 1, 'B is still loading');
  rt._onPageHide();
  rt.done();
  await settle();
  delete w.hold;

  const rt2 = new TestRuntime(w);
  assert.equal(await rt2.start(), 'booted');
  const b = last(w);
  assert.equal(b.ghost, 'testghost');
  assert.equal(b.resume, false);
  assert.deepEqual(bootIds(b), ['GET OnGhostChanged']);
  assert.equal(b.find('OnGhostChanged')[0].refs[1], '\\0tsubasa: bye, Testy (manual)\\e');
  rt2.done();
});

test('runtime: a takeover asked for during a change waits for its end; then this hidden tab saves the new ghost and lets it go', async () => {
  const w = world();
  const rt = new TestRuntime(w);
  await rt.start();
  rt.player.finish();
  rt._yieldWhenHidden = true;                            // a visible tab asked for her earlier ...
  const p = rt.changeGhost('testghost');
  await settle();
  rt._yield();                                           // ... and this tab is hidden mid-goodbye (no document = hidden)
  rt._onTakeoverRequest();                               // the other tab asks again
  await settle();
  assert.equal(rt.loop.current.event, 'OnGhostChanging', 'the goodbye goes on');
  assert.equal(rt.loop.frozen, false);
  rt.player.finish();
  assert.equal(await p, true);
  await settle();
  assert.equal(rt.ghost.id, 'testghost');
  assert.equal(rt.parts, null, 'after the change, the tab yields');
  assert.ok(rt.frozen);
  const b = last(w);
  assert.equal(b.ghost, 'testghost');
  assert.ok(b.persisted > 0 && b.terminated);
  assert.deepEqual([...w.locks.held], []);
  assert.equal(runtimePrefs.get().ghost, 'testghost');
  assert.equal(JSON.parse(localStorage.getItem(stateKey('tsubasa'))).run, null);
  rt.done();
});

function fakeDoc(hidden) {
  const l = new Map();
  return {
    hidden,
    addEventListener(t, f) { if (!l.has(t)) l.set(t, new Set()); l.get(t).add(f); },
    removeEventListener(t, f) { const s = l.get(t); if (s) s.delete(f); },
    fire(t) { for (const f of [...(l.get(t) || [])]) f(); },
  };
}

test('runtime: a tab that asked for the ghost while another tab changed it asks again for the new one, and runs it', async () => {
  const w = world();
  const LockBus = busChannel();                          // takeover requests travel on the lock's channel
  class Tab extends TestRuntime {
    constructor(doc) { super(w); this.doc = doc; }
    _doc() { return this.doc; }
    _newLock(id) { return new GhostLock(id, { locks: w.locks, Channel: LockBus }); }
  }
  const d1 = fakeDoc(false);
  const d2 = fakeDoc(true);
  const tab1 = new Tab(d1);
  const tab2 = new Tab(d2);
  assert.equal(await tab1.start(), 'booted');
  tab1.player.finish();
  assert.equal(await tab2.start(), 'frozen');
  const p = tab1.changeGhost('testghost');
  await settle();
  d1.hidden = true;                                      // the visitor turns to tab 2 during the goodbye
  d2.hidden = false;
  d2.fire('visibilitychange');
  await settle();
  assert.equal(tab1.loop.current.event, 'OnGhostChanging', 'tab 1 keeps saying goodbye');
  tab1.player.finish();
  assert.equal(await p, true);
  await settle(30);
  assert.equal(tab2.ghost.id, 'testghost');
  assert.ok(tab2.loop && tab2.loop.booted, 'tab 2 runs the new ghost');
  assert.equal(last(w).resume, true, 'taken over, not booted again');
  assert.equal(tab1.parts, null);
  assert.ok(tab1.frozen, 'tab 1 shows it frozen');
  assert.deepEqual(w.engines.filter(e => !e.terminated && !e.unloaded).map(e => e.ghost), ['testghost']);
  assert.ok(w.locks.held.has('sumika:testghost') && !w.locks.held.has('sumika:tsubasa'));
  tab1.done();
  tab2.done();
});

test('runtime: the old ghost\'s loop no longer reaches the runtime once the new one runs', async () => {
  const w = world();
  const rt = new TestRuntime(w);
  await rt.start();
  rt.player.finish();
  const old = rt.loop;
  assert.equal(await switchTo(rt, 'testghost'), true);
  old.emit('closed');
  old.emit('change', { kind: 'ghost', target: 'tsubasa', byId: true });
  await settle();
  assert.ok(rt.loop && rt.loop.booted && rt.ghost.id === 'testghost', 'B is not closed or changed by it');
  assert.equal(sessionMarker.read().ghost, 'testghost');
  assert.ok(w.locks.held.has('sumika:testghost'));
  rt.done();
});

test('runtime: a page back from the bfcache (restart) reads the Language ▸ choice again, and its boot tells the ghost (UI §2.10)', async () => {
  const w = world();
  runtimePrefs.set({ lang: 'ja' });
  const rt = new TestRuntime(w);
  rt.language = new UiLanguage({ navigator: { languages: ['en-US'] } });
  assert.equal(await rt.start(), 'booted');
  rt.player.finish();
  const a = last(w);
  const lang = sh => sh.find('OnLanguageChange').map(r => [r.method, ...r.refs]);
  assert.deepEqual(lang(a), [['NOTIFY', 'Japanese', '1041', '', '']]);
  runtimePrefs.set({ lang: 'en' });                      // another page's pick while this one sat in the bfcache: no 'storage' event
  assert.equal(rt.language.lang, 'ja');
  assert.equal(await rt.restart(), 'booted');            // pageshow {persisted: true}
  assert.deepEqual([rt.language.pref, rt.language.lang], ['en', 'en']);
  const b = last(w);
  assert.notEqual(b, a);
  assert.deepEqual(lang(b), [['NOTIFY', 'English', '1033', '', '']]);
  assert.deepEqual(lang(a), [['NOTIFY', 'Japanese', '1041', '', '']], 'the torn-down loop was told nothing');
  rt.done();
});

// ---------------------------------------------------------------- P7: which clock zero the engine gets (SUMMARY §2.1)

/** Date.now() at `t` while fn runs (the runtime stamps cold boots with it). */
async function at(clock, fn) {
  const real = Date.now;
  Date.now = () => clock.t;
  try { return await fn(); } finally { Date.now = real; }
}

test('runtime: P7 clock zero: a cold boot sets it; a resume and a crash restart keep it; a ghost change starts the new ghost\'s', async () => {
  const T0 = new Date(2026, 9, 7, 9, 0, 0).getTime();       // the tab opens at 09:00
  const c = { t: T0 };
  await at(c, async () => {
    const w = world();
    const rt = new TestRuntime(w);
    assert.equal(await rt.start(), 'booted');
    rt.player.finish();
    assert.deepEqual([last(w).resume, last(w).bootEpochMs, rt.state.data.bootEpochMs], [false, T0, T0]);
    rt.state.saveNow();
    rt.done();
    await settle();

    // the next page, at 09:30: her clock goes on, also in an engine restarted after a crash
    c.t = T0 + 30 * 60e3;
    const rt2 = new TestRuntime(w);
    assert.equal(await rt2.start(), 'booted');
    assert.deepEqual([last(w).resume, last(w).bootEpochMs], [true, T0]);
    c.t += 60e3;
    const n = w.engines.length;
    await rt2._onCrash();
    assert.equal(w.engines.length, n + 1);
    assert.deepEqual([last(w).resume, last(w).bootEpochMs], [true, T0]);

    // a change at 10:00: the test ghost's clock starts then (SSP starts it when that ghost loads), not at the tab's 09:00,
    // which stays OnSecondChange R0's
    c.t = T0 + 3600e3;
    assert.equal(await switchTo(rt2, 'testghost'), true);
    assert.deepEqual([last(w).ghost, last(w).resume, last(w).bootEpochMs], ['testghost', false, T0 + 3600e3]);
    assert.equal(sessionMarker.read().sessionEpochMs, T0);
    assert.equal(rt2.loop.sessionEpochMs, T0);
    rt2.player.finish();
    rt2.state.saveNow();
    rt2.done();
    await settle();
    c.t = T0 + 3700e3;
    const rt3 = new TestRuntime(w);
    assert.equal(await rt3.start(), 'booted');
    assert.deepEqual([last(w).ghost, last(w).resume, last(w).bootEpochMs], ['testghost', true, T0 + 3600e3]);

    // back to Tsubasa at 11:00: a cold boot, so a new clock, not her 09:00 one
    c.t = T0 + 7200e3;
    assert.equal(await switchTo(rt3, 'tsubasa'), true);
    assert.deepEqual([last(w).ghost, last(w).resume, last(w).bootEpochMs], ['tsubasa', false, T0 + 7200e3]);
    rt3.done();
  });
});

test('runtime: P7 clock zero: a takeover keeps the booting tab\'s; a page left while a cold boot loads never resumes an older one', async () => {
  const T0 = new Date(2026, 9, 7, 9, 0, 0).getTime();
  const c = { t: T0 };
  await at(c, async () => {
    const w = world();
    const LockBus = busChannel();
    class Tab extends TestRuntime {
      constructor(doc) { super(w); this.doc = doc; }
      _doc() { return this.doc; }
      _newLock(id) { return new GhostLock(id, { locks: w.locks, Channel: LockBus }); }
    }
    const d1 = fakeDoc(false);
    const d2 = fakeDoc(true);
    const tab1 = new Tab(d1);
    assert.equal(await tab1.start(), 'booted');
    tab1.player.finish();
    c.t = T0 + 600e3;
    const tab2 = new Tab(d2);
    assert.equal(await tab2.start(), 'frozen');
    c.t = T0 + 1200e3;
    d1.hidden = true;                                       // the visitor turns to tab 2
    d2.hidden = false;
    d2.fire('visibilitychange');
    await settle(30);
    assert.ok(tab2.loop && tab2.loop.booted);
    assert.deepEqual([last(w).resume, last(w).bootEpochMs], [true, T0], 'the ghost tab 1 booted at 09:00');
    tab1.done();
    tab2.done();
  });

  // a new tab cold-boots a ghost stored yesterday, and its page is left while the engine loads
  c.t = T0;
  await at(c, async () => {
    const w = world();
    w.saves.set('tsubasa', {});
    localStorage.setItem(stateKey('tsubasa'), JSON.stringify({ v: 1, bootEpochMs: T0 - 86400e3, run: { src: '\\0Yesterday\\e', ip: 0 } }));
    w.hold = { tsubasa: deferred().promise };
    const rt = new TestRuntime(w);
    rt.start();
    await settle();
    rt._onPageHide();
    rt.done();
    await settle();
    delete w.hold;
    const stored = JSON.parse(localStorage.getItem(stateKey('tsubasa')));
    assert.deepEqual([stored.bootEpochMs, stored.run], [T0, null], 'the cold boot was stored before the engine loaded');
    c.t = T0 + 60e3;
    const rt2 = new TestRuntime(w);
    assert.equal(await rt2.start(), 'booted');
    assert.deepEqual([last(w).resume, last(w).bootEpochMs], [true, T0], 'today\'s boot, not yesterday\'s');
    rt2.done();
  });
});

test('runtime: a page left while a cold boot loads does not resume the last session\'s OnSurfaceRestore stamp (EV §3.4)', async () => {
  // yesterday's tab was closed within 30 s of a talk: its stamp is in the stored state
  const T0 = new Date(2026, 9, 7, 9, 0, 0).getTime();
  const c = { t: T0 };
  await at(c, async () => {
    const w = world();
    w.saves.set('tsubasa', {});
    localStorage.setItem(stateKey('tsubasa'), JSON.stringify({ v: 1, bootEpochMs: T0 - 86400e3, surfaceRestoreAt: T0 - 86390e3 }));
    w.hold = { tsubasa: deferred().promise };
    const rt = new TestRuntime(w);
    rt.start();
    await settle();
    rt._onPageHide();                                    // a link followed while the engine loads
    rt.done();
    await settle();
    delete w.hold;
    assert.equal(JSON.parse(localStorage.getItem(stateKey('tsubasa'))).surfaceRestoreAt, 0, 'cleared with the cold boot\'s first save');
    c.t = T0 + 60e3;
    const rt2 = new TestRuntime(w);
    assert.equal(await rt2.start(), 'booted');
    assert.equal(last(w).resume, true);
    assert.equal(rt2.loop._restoreAt, 0, 'nothing pending: no boot script has ended in this tab (SPGhost ctor 0x61cb1a)');
    rt2.done();
  });
});

// ---------------------------------------------------------------- Close / Iconify, then a cold boot that never booted

/** A tab whose stage keeps what Close and Iconify hid (like Stage._restore / saveState) and records its launcher. */
class HidingTab extends TestRuntime {
  constructor(w) { super(w); this.launchers = []; }
  async _createStage(o) {
    const s = await super._createStage(o);
    for (const [k, st] of Object.entries((o.state && o.state.scopes) || {})) {
      const c = s.char(+k);
      if (Number.isFinite(st.surface) && st.surface >= 0) c.surfaceId = st.surface;
      if (st.visible === false) c.hide();
    }
    s.saveState = () => ({ v: 1, scopes: Object.fromEntries(s.scopes.map(k => [k, { surface: s.char(k).surfaceId, visible: s.char(k).shown }])) });
    return s;
  }
  _showLauncher(mode) { this.launchers.push(mode); }
}
const shownChars = rt => [0, 1].map(s => rt.parts.stage.char(s).visible);

/** Booted, then closed from the menu (OnClose 204: _quit hides everything and saves closed). */
async function closedTab(w) {
  const rt = new HidingTab(w);
  assert.equal(await rt.start(), 'booted');
  rt.player.finish();
  await settle();
  await rt.loop.close();
  await settle();
  assert.deepEqual(rt.launchers, ['closed']);
  const st = JSON.parse(localStorage.getItem(stateKey('tsubasa')));
  assert.deepEqual([st.closed, st.stage.scopes[0].visible], [true, false]);
  return rt;
}

test('runtime: Close, relaunch from the launcher, page left while the engine loads: the next page shows the closed launcher, not an invisible ghost', async () => {
  const w = world();
  const rt = await closedTab(w);
  w.hold = { tsubasa: deferred().promise };
  rt._launch('closed');                                  // the launcher calls her back: a cold boot
  await settle();
  assert.deepEqual(shownChars(rt), [true, true], 'the relaunch shows her');
  rt._onPageHide();                                      // a link followed before the engine is up
  rt.done();
  await settle();
  delete w.hold;
  assert.equal(JSON.parse(localStorage.getItem(stateKey('tsubasa'))).closed, true, 'stored closed until she boots');
  const rt2 = new HidingTab(w);
  assert.equal(await rt2.start(), 'launcher');
  assert.deepEqual(rt2.launchers, ['closed']);
  assert.equal(await rt2.restart({ cold: true }), 'booted', 'its click calls her back');
  assert.deepEqual(shownChars(rt2), [true, true]);
  assert.deepEqual(bootIds(last(w)), ['GET OnBoot']);
  rt2.done();
});

test('runtime: Close, relaunch, the engine fails to start: the next page shows the closed launcher again', async () => {
  const w = world({ failEngine: () => w.broken });
  const rt = await closedTab(w);
  w.broken = true;
  assert.equal(await rt.restart({ cold: true }), 'failed');
  w.broken = false;
  rt._onPageHide();
  rt.done();
  await settle();
  const rt2 = new HidingTab(w);
  assert.equal(await rt2.start(), 'launcher');
  assert.deepEqual(rt2.launchers, ['closed']);
  rt2.done();
});

test('runtime: Iconify, a new tab, its page left while the engine loads: the next page resumes her behind the minimized launcher, which shows her again', async () => {
  const w = world();
  const rt = new HidingTab(w);
  assert.equal(await rt.start(), 'booted');
  rt.player.finish();
  await settle();
  rt.parts.stage.char(0).surfaceId = 5;
  await rt.loop.minimize();
  assert.deepEqual(rt.launchers, ['minimized']);
  rt._onPageHide();                                      // the tab is closed while she is iconified
  rt.done();
  await settle();

  globalThis.sessionStorage = memoryStorage();           // a new tab: a cold boot shows her
  w.hold = { tsubasa: deferred().promise };
  const rt2 = new HidingTab(w);
  rt2.start();
  await settle();
  assert.deepEqual(shownChars(rt2), [true, true]);
  rt2._onPageHide();                                     // a link followed before the engine is up
  rt2.done();
  await settle();
  delete w.hold;
  const st = JSON.parse(localStorage.getItem(stateKey('tsubasa')));
  assert.deepEqual([st.closed, st.minimized && st.minimized.scopes, st.run], [false, [0, 1], null], 'still minimized; the run is gone');

  const rt3 = new HidingTab(w);
  assert.equal(await rt3.start(), 'booted');
  assert.equal(last(w).resume, true);
  assert.deepEqual(rt3.launchers, ['minimized']);
  assert.deepEqual(shownChars(rt3), [false, false], 'hidden behind the launcher');
  rt3._launch('minimized');
  await settle();
  assert.deepEqual(shownChars(rt3), [true, true]);
  assert.equal(rt3.parts.stage.char(0).surfaceId, 5, 'on the surface she was iconified with');
  rt3.done();
});

/** HidingTab whose launcher mode is kept (as _showLauncher sets it) and whose ghost has ghost/master/x.ico. */
class IconTab extends HidingTab {
  _showLauncher(mode) { super._showLauncher(mode); this._launcherMode = mode; }
  async _ghostCommon() {
    const c = await super._ghostCommon();
    c.files = { ...c.files, resolve: p => (String(p).toLowerCase() === 'ghost/master/x.ico' ? 'ghost/master/x.ico' : null) };
    return c;
  }
}

test('runtime: a script\'s \\![set,trayicon] while she is minimized shows her button again with it (the loop\'s \'trayicon\', UI §2.6)', async () => {
  const w = world();
  const rt = new IconTab(w);
  assert.equal(await rt.start(), 'booted');
  rt.player.finish();
  await settle();
  await rt.loop.minimize();
  assert.deepEqual(rt.launchers, ['minimized']);
  rt.loop.setOption('trayicon', ['x.ico']);
  assert.equal(rt.loop.minimized.icon, 'ghost/master/x.ico');
  assert.deepEqual(rt.launchers, ['minimized', 'minimized'], 'repainted with the new icon');
  rt.loop.setOption('trayicon', ['gone.ico']);
  assert.deepEqual(rt.launchers, ['minimized', 'minimized'], 'a missing file changes nothing');
  await rt.loop.restore();
  rt.loop.setOption('trayicon', ['x.ico']);
  assert.deepEqual(rt.launchers, ['minimized', 'minimized'], 'not minimized: kept for the next minimize');
  assert.equal(rt.loop.trayIcon, 'ghost/master/x.ico');
  rt.done();
});

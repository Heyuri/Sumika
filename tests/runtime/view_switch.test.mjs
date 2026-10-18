// Shell ▸ / Balloon ▸ / \![change,shell|balloon] in the runtime (shiori-events.md §2.6, balloon-format.md §12): the
// swap under a running engine, per-shell dress-up and balloon memory, what the next page boots, other tabs, the one
// change slot shared with ghost changes, and the re-indexed site. The real EventLoop and a real headless Stage on the
// synthetic test ghost (tests/fixtures/ghost/testghost: shells master and alt "Winter"); fake engine, player, balloons.
// The event loop's own half is view_events.test.mjs.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime, MAX_CHAINED_CHANGES } from '../../src/core/runtime.js';
import { GhostLock, memoryStorage, runtimePrefs, stateKey } from '../../src/core/state.js';
import { sortShells } from '../../src/core/shells.js';
import { Stage } from '../../src/shell/stage.js';
import { ScriptPlayer } from '../../src/sakura/player.js';
import { infoFlags } from '../../src/ui/info.js';
import { ODM_NAME_IDS, ODM_FILL_IDS } from '../../src/ui/menu.js';
import { setLogLevel } from '../../src/core/log.js';
import { FsFiles, nodeDecode, FakeClock as ShellClock } from '../shell/helpers.mjs';
import { setup as playerMocks } from '../sakura/mocks.mjs';
import { FakeShiori, FakePlayer, FakeBalloons, FakeDialogs, settle, deferred } from './fakes.mjs';
import { manifestOf } from '../index_files.mjs';
import { needs } from '../needs.mjs';

setLogLevel('silent');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/ghost/testghost');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/ghosts.json'), 'utf8'));
const G = Object.fromEntries(SITE.ghosts.map(g => [g.id, g]));
const ALT_PATH = '/ghost/testghost/shell/alt/';

/** The fixture ghost's files as GhostFiles serves them (url() drops a folder's trailing slash, like GhostFiles). */
function ghostFiles(id) {
  const f = id === 'testghost' ? new FsFiles(FIXTURE) : new FsFiles(FIXTURE, []);
  f.url = p => `http://s/ghost/${id}/${String(p).replace(/\\/g, '/').replace(/\/+$/, '')}`;
  f.prefetch = () => {};
  return f;
}

/** A balloon folder stand-in: the runtime only passes it to _balloonSkin and reads its root. */
const balloonFolder = (id, root) => ({ id, root, has: () => false, list: () => [] });

/** The site: the fixture ghosts, Sumika's balloon and Tsubasa's LightBlue hoisted by the indexer (BA §1.6). */
function siteIndex() {
  const balloons = [{ id: 'LightBlue', name: 'LightBlue', ghost: 'tsubasa' }, { id: 'sumika', name: 'Sumika' }];
  const roots = { LightBlue: 'http://s/ghost/tsubasa/LightBlue/', sumika: 'http://s/balloon/sumika/' };
  return {
    base: 'http://s/', ghosts: SITE.ghosts, balloons, defaultBalloon: 'sumika',
    ghost: id => SITE.ghosts.find(g => g.id === id) || null,
    balloon: id => balloons.find(b => b.id === id) || null,
    ghostFiles: async id => ghostFiles(id),
    balloonFiles: async id => balloonFolder(id, roots[id]),
  };
}

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

function fakeDoc(hidden) {
  const l = new Map();
  return {
    hidden,
    addEventListener(t, f) { if (!l.has(t)) l.set(t, new Set()); l.get(t).add(f); },
    removeEventListener(t, f) { const s = l.get(t); if (s) s.delete(f); },
    fire(t) { for (const f of [...(l.get(t) || [])]) f(); },
  };
}

function defaultAnswer(id, r) {
  switch (r.id) {
    case 'OnBoot': return `\\0${id}: boot\\e`;
    case 'OnFirstBoot': return `\\0${id}: first\\e`;
    case 'OnShellChanging': return `\\0To ${r.refs[0]} from ${r.refs[1]}.\\e`;
    case 'OnShellChanged': return `\\0Now in ${r.refs[0]}.\\e`;
    case 'OnBalloonChange': return `\\0A ${r.refs[0]} balloon.\\e`;
    case 'OnGhostChanging': return `\\0Bye.\\e`;
    default: return null;
  }
}

/** The browser around the runtime (storages shared by the tabs), the engines and the stages made. */
function world({ answer = defaultAnswer, descript = [] } = {}) {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  return { index: siteIndex(), locks: new FakeLocks(), Channel: busChannel(), engines: [], stages: [], skins: [], answer, descript };
}

const LIVE = new Set();
afterEach(() => { for (const rt of LIVE) rt.done(); });

class TestRuntime extends Runtime {
  constructor(w, { doc = null, lockBus = null } = {}) {
    super({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', defaultGhost: 'testghost', Channel: w.Channel });
    this.w = w;
    this.doc = doc;
    this.lockBus = lockBus;
    this.index = w.index;
    this.players = [];
    LIVE.add(this);
  }
  _doc() { return this.doc; }
  _newLock(id) { return new GhostLock(id, { locks: this.w.locks, Channel: this.lockBus }); }
  async _ghostCommon() {
    const c = await super._ghostCommon();                  // the fixture's ghost/master/descript.txt, the boot shell
    for (const [k, v] of this.w.descript) c.ghostDescript.set(k, v);
    return c;
  }
  async _startEngine() {
    const g = this.ghost;
    const sh = new FakeShiori(r => this.w.answer(g.id, r));
    sh.ghost = g.id;
    sh.terminate = () => { sh.terminated = true; };
    this.w.engines.push(sh);
    return { client: sh, r: { hadSave: false } };
  }
  async _createStage(o) {
    const s = await Stage.create({ ...o, dom: false, decode: nodeDecode, clock: new ShellClock(0), desk: { w: 1280, h: 720 } });
    const destroy = s.destroy.bind(s);
    s.destroy = () => { s.gone = true; destroy(); };
    s.opts = o;
    this.w.stages.push(s);
    return s;
  }
  async _balloonSkin(files) {
    const skin = { name: files.id, descript: new Map([['name', files.id]]), isFallback: false, balloon: () => null };
    this.w.skins.push(skin);
    return skin;
  }
  async _createBalloons() { return new FakeBalloons(); }
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

/**
 * The real ScriptPlayer (manual clock, recording balloons) instead of FakePlayer: a reply's leading tags run inside
 * play(), so a \![change,…] at its start reaches the runtime while the change that sent the event still holds the slot.
 */
class RealPlayerRuntime extends TestRuntime {
  _createPlayer(o) {
    const m = playerMocks({ speedMs: 0 });
    this.pclock = m.clock;
    this.mocks = m;                       // its recording balloons (what the scripts wrote)
    const p = new ScriptPlayer({ stage: o.stage, balloons: m.balloons, dialogs: o.dialogs, host: o.host, clock: m.clock, speedMs: 0,
      viewport: () => ({ width: 1000, height: 800 }) });
    this.players.push(p);
    return p;
  }
  async runOut() { for (let i = 0; i < 8; i++) { await this.pclock.runAll(); await settle(); } }
}

const last = w => w.engines[w.engines.length - 1];
const VIEW = /On(ShellChang|BalloonChange|Notify)|installedshellname/;
const viewIds = sh => sh.ids().filter(x => VIEW.test(x));
async function booted(w, o) {
  const rt = new TestRuntime(w, o);
  assert.equal(await rt.start(), 'booted');
  if (rt.player.busy) rt.player.finish();
  await settle();
  return rt;
}

/** A Shell ▸ pick through the menu, with OnShellChanging's talk played to its end. */
async function pickShell(rt, id) {
  rt.parts.menu._run({ type: 'shell', id }, 0);
  const p = rt._changing;
  assert.ok(p, 'the pick reached the runtime');
  for (let i = 0; i < 20 && !(rt.loop.current && rt.loop.current.event === 'OnShellChanging'); i++) await settle();
  if (rt.player.busy && rt.loop.current && rt.loop.current.event === 'OnShellChanging') rt.player.finish();
  const r = await p;
  await settle();
  return r;
}

// ---------------------------------------------------------------- the menu path

test('Shell ▸: listed in name order; a pick sends OnShellChanging, swaps after its talk, then the NOTIFYs and OnShellChanged; the engine keeps running', async () => {
  const w = world();
  const rt = await booted(w);
  assert.deepEqual(rt.shellList(), [{ id: 'master', name: 'master', current: true }, { id: 'alt', name: 'Winter', current: false }]);
  assert.deepEqual(rt.parts.menu._options(0).shells, rt.shellList(), 'the menu asks the runtime');
  const sh = last(w);
  const engine = rt.parts.client;
  const old = rt.parts.stage;
  sh.log.length = 0;

  rt.parts.menu._run({ type: 'shell', id: 'alt' }, 0);
  const p = rt._changing;
  await settle();
  assert.deepEqual(sh.find('OnShellChanging').map(r => [r.method, ...r.refs]), [['GET', 'Winter', 'master', ALT_PATH]]);
  assert.equal(rt.player.last.script, '\\0To Winter from master.\\e');
  assert.equal(w.stages.length, 1, 'the swap waits for her talk');
  assert.equal(await rt.changeGhost('tsubasa'), false, 'no ghost change during a shell change');
  rt.player.finish();
  assert.equal(await p, true);
  await settle();

  const stage = rt.parts.stage;
  assert.deepEqual(w.stages.map(s => s.shellId), ['master', 'alt']);
  assert.equal(stage.opts.files, rt.parts.files, 'built from the ghost files already loaded');
  assert.equal(rt.parts.client, engine, 'the same engine');
  assert.equal(w.engines.length, 1);
  assert.ok(old.gone, 'the old stage is gone');
  assert.ok(rt.parts.balloons.hidden >= 1, 'balloons closed');
  assert.deepEqual([rt.parts.balloons.stages, rt.parts.dialogs.stages], [[stage], [stage]]);
  assert.equal(rt.player.stage, stage, 'the player draws on the new stage');
  assert.equal(rt.loop.stage, stage);
  assert.deepEqual([rt.parts.menu.stage, rt.parts.menu.shellDir], [stage, 'shell/alt/']);
  assert.equal(rt.parts.scaling.stage, stage);
  assert.deepEqual(viewIds(sh), ['GET OnShellChanging', 'NOTIFY OnNotifySelfInfo', 'NOTIFY OnNotifyShellInfo', 'NOTIFY OnNotifyDressupInfo',
    'NOTIFY installedshellname', 'GET OnShellChanged']);
  assert.deepEqual(sh.find('OnNotifySelfInfo')[0].refs.slice(3, 5), ['Winter', ALT_PATH]);
  assert.deepEqual(sh.find('OnNotifyShellInfo')[0].refs, ['Winter', ALT_PATH, '0']);
  assert.deepEqual(sh.find('installedshellname')[0].refs, ['master', 'Winter']);
  assert.deepEqual(sh.find('OnShellChanged')[0].refs, ['Winter', 'Test Ghost', ALT_PATH]);
  // the shell load asks the SHIORI for the menu's look again, before the NOTIFYs and OnShellChanged (UI §2.3) [disasm
  // LoadShell → LoadGhostCore(0) 0x6231e3, 0x62161e]: a silent SHIORI, so the names and the fill colours only
  const ids = sh.ids();
  const odm = ids.filter(x => x.startsWith('GET menu.'));
  assert.deepEqual(odm.map(x => x.slice(4)), [...ODM_NAME_IDS, ...ODM_FILL_IDS]);
  assert.ok(ids.indexOf(odm[0]) > ids.indexOf('GET OnShellChanging') && ids.indexOf(odm.at(-1)) < ids.indexOf('NOTIFY OnNotifySelfInfo'));
  assert.ok(sh.find('menu.background.bitmap.filename').every(r => r.kind === 'resource'));
  // Status `changing` (EV §1.6): not on OnShellChanging, on everything after it until OnShellChanged, the shell load's
  // menu resources included (GetStringShiori builds Status too) [disasm AddStatusText 0x639b32, 0x4978c5, 0x623490]
  const changingOn = r => /(^|,)changing(,|$)/.test(r.headers.Status || '');
  assert.equal(changingOn(sh.find('OnShellChanging')[0]), false);
  assert.ok(sh.find('menu.background.bitmap.filename').every(changingOn));
  assert.ok(['OnNotifySelfInfo', 'installedshellname', 'OnShellChanged'].every(id => changingOn(sh.find(id)[0])));
  assert.doesNotMatch(rt.loop.statusHeader(), /changing/, 'over once OnShellChanged has gone out');
  assert.equal(rt.player.last.script, '\\0Now in Winter.\\e', 'the reply plays at once (a menu pick)');
  assert.deepEqual([rt.state.data.shell, rt.state.data.shellChosen], ['alt', true]);
  assert.deepEqual(JSON.parse(localStorage.getItem(stateKey('testghost'))).shell, 'alt', 'stored at once');
  assert.deepEqual(rt.shellList().map(s => s.current), [false, true]);
  // the characters keep their places and start without a surface: OnShellChanged's reply decides
  assert.equal(stage.char(0).surfaceId, -1);
  const info = rt._infoData(rt.parts);
  assert.deepEqual(info.sources.map(s => [s.kind, s.name]), [['ghost', 'Test Ghost'], ['shell', 'Winter'], ['balloon', 'Sumika']]);
  assert.equal(info.sources[1].files, stage.shellFiles);
  assert.deepEqual(infoFlags(info), { readme: true, terms: false }, 'the ghost root\'s readme.txt');
  rt.player.finish();

  // a re-pick of the shell in use reloads it with every event
  sh.log.length = 0;
  assert.equal(await pickShell(rt, 'alt'), true);
  assert.deepEqual(sh.find('OnShellChanging')[0].refs, ['Winter', 'Winter', ALT_PATH]);
  assert.deepEqual(w.stages.map(s => s.shellId), ['master', 'alt', 'alt']);
  assert.equal(sh.find('OnShellChanged').length, 1);
});

test('Shell ▸: a balloon break during OnShellChanging, or another reply replacing it, cancels the change; 204 restores the surfaces', async () => {
  const w = world({ answer: (id, r) => (r.id === 'OnShellChanged' ? null : r.id === 'OnMouseDoubleClick' ? '\\0What?\\e' : defaultAnswer(id, r)) });
  const rt = await booted(w);
  const sh = last(w);
  rt.parts.menu._run({ type: 'shell', id: 'alt' }, 0);
  let p = rt._changing;
  await settle();
  rt.parts.balloons.emit('dblclick', { scope: 0 });
  assert.equal(await p, false);
  assert.equal(sh.find('OnBalloonBreak').length, 1);
  assert.deepEqual(w.stages.map(s => s.shellId), ['master']);
  assert.deepEqual([rt.state.data.shell, rt.state.data.shellChosen], ['master', false]);

  rt.parts.menu._run({ type: 'shell', id: 'alt' }, 0);
  p = rt._changing;
  await settle();
  await rt.loop.send('OnMouseDoubleClick', [0, 0, 0, 0, '', 0, 'mouse']);    // she answers a click instead
  assert.equal(await p, false, 'the switch rode on the replaced talk [infer]');
  assert.deepEqual(w.stages.map(s => s.shellId), ['master']);
  rt.player.finish();

  // OnShellChanged unanswered: each scope that showed a surface shows that id again, from the new shell
  assert.equal(rt.parts.stage.char(0).surfaceId, 0);
  assert.equal(await pickShell(rt, 'alt'), true);
  assert.equal(rt.parts.stage.shellId, 'alt');
  assert.equal(rt.parts.stage.char(0).surfaceId, 0);
  assert.equal(rt.parts.stage.char(1).surfaceId, -1, 'one that showed nothing stays hidden');
});

// ---------------------------------------------------------------- the script path

test('\\![change,shell,NAME]: no OnShellChanging; the swap at the tag; OnShellChanged\'s reply waits for the script; folder ids, unknown names and random with two shells change nothing', async () => {
  const w = world();
  const rt = await booted(w);
  const sh = last(w);
  sh.log.length = 0;
  rt.loop.playScript('\\0Wait here.\\![change,shell,Winter]Done.\\e', { event: 'OnTest' });
  for (const target of ['alt', 'Nobody', 'random', 'lastinstalled']) {
    const r = rt.loop.change('shell', [target]);              // what the player does at the tag
    assert.equal(await r, false, target);
  }
  const p = rt.loop.change('shell', ['winter']);
  assert.equal(typeof p.then, 'function', 'the player waits at the tag');
  assert.equal(await p, true);
  assert.deepEqual(w.stages.map(s => s.shellId), ['master', 'alt']);
  assert.equal(sh.find('OnShellChanging').length, 0);
  assert.deepEqual(sh.find('OnShellChanged')[0].refs, ['Winter', 'Test Ghost', ALT_PATH]);
  assert.equal(rt.player.last.script, '\\0Wait here.\\![change,shell,Winter]Done.\\e', 'the script plays on');
  rt.player.finish();
  await settle();
  assert.equal(rt.player.last.script, '\\0Now in Winter.\\e', 'then the reply');
  assert.deepEqual([rt.state.data.shell, rt.state.data.shellChosen], ['alt', true]);

  // --option=raise-event goes like a menu pick and does not hold the script
  rt.player.finish();
  sh.log.length = 0;
  rt.loop.playScript('\\0Back.\\e', { event: 'OnTest' });
  assert.equal(rt.loop.change('shell', ['master', '--option=raise-event']), undefined);
  await settle();
  assert.deepEqual(sh.find('OnShellChanging')[0].refs, ['master', 'Winter', '/ghost/testghost/shell/master/']);
  rt.player.finish();
  assert.equal(await rt._changing, true);
  assert.equal(rt.parts.stage.shellId, 'master');
});

// ---------------------------------------------------------------- reloads (EV §2.10)

test('\\![reload,shell] / \\![reloadsurface] (EV §2.10): the shell in use swapped again at the tag, without OnShellChanging or OnShellChanged; the NOTIFYs; surfaces, places and dress-up come back; no pick', async () => {
  const w = world();
  const rt = await booted(w);
  const sh = last(w);
  const engine = rt.parts.client;
  const old = rt.parts.stage;
  old.char(0).moveTo(400, 700);
  const pos = old.saveState().scopes[0].pos;
  const posts = [];
  const post = rt._post.bind(rt);
  rt._post = m => { posts.push(m); post(m); };
  sh.log.length = 0;
  rt.loop.playScript('\\0Wait.\\![reload,shell]Done.\\e', { event: 'OnTest' });
  const p = rt.loop.reload('shell');                       // what the player does at the tag
  assert.equal(typeof p.then, 'function', 'the player waits at the tag');
  assert.equal(await p, true);
  // ChangeOrReloadShellInternal(-1, false) [disasm 0x6230d1]: no OnShellChanging, no OnShellChanged (0x62335c)
  assert.deepEqual(w.stages.map(s => s.shellId), ['master', 'master'], 'a new stage of the same shell');
  assert.ok(old.gone);
  assert.equal(rt.parts.client, engine, 'the same engine');
  assert.deepEqual(viewIds(sh), ['NOTIFY OnNotifySelfInfo', 'NOTIFY OnNotifyShellInfo', 'NOTIFY OnNotifyDressupInfo', 'NOTIFY installedshellname']);
  assert.equal(rt.parts.stage.char(0).surfaceId, 0, 'the surface shown before comes back (PopSurfaceStatus [disasm 0x62349d])');
  assert.deepEqual(rt.parts.stage.saveState().scopes[0].pos, pos, 'she stays where she was');
  assert.deepEqual([rt.state.data.shell, rt.state.data.shellChosen, rt.state.data.shellSwap], ['master', false, null], 'a reload is no pick [decision]');
  assert.deepEqual(posts.filter(m => m.t === 'view'), [{ t: 'view', id: 'testghost' }], 'the frozen tabs redraw');
  assert.doesNotMatch(rt.loop.statusHeader(), /changing/);
  assert.equal(rt.player.last.script, '\\0Wait.\\![reload,shell]Done.\\e', 'the script plays on, no reply replaces it');
  rt.player.finish();

  // a picked shell with dress-up: reloaded with its parts, still the visitor's pick
  assert.equal(await pickShell(rt, 'alt'), true);
  rt.player.finish();
  assert.equal(rt.loop.toggleDressup(0, 2), true);           // Hat - Straw
  const parts = rt.parts.stage.bindState(0).onIds().sort();
  sh.log.length = 0;
  assert.equal(await rt.loop.reload('shell'), true);
  assert.deepEqual(w.stages.map(s => s.shellId).slice(-2), ['alt', 'alt']);
  assert.deepEqual(rt.parts.stage.bindState(0).onIds().sort(), parts);
  assert.deepEqual([rt.state.data.shell, rt.state.data.shellChosen], ['alt', true]);
  assert.equal(sh.find('OnShellChanging').length + sh.find('OnShellChanged').length, 0);
  assert.deepEqual(sh.find('OnNotifyShellInfo')[0].refs.slice(0, 2), ['Winter', ALT_PATH]);

  // menus and the page API never reload; a refused loop (a ghost change) neither
  rt.loop.changing = true;
  assert.equal(rt.loop.reload('shell'), undefined);
  rt.loop.changing = false;
});

test('\\![reload,balloon] (EV §2.10): the balloon in use re-skinned at the tag and stored as the choice; OnNotifySelfInfo only, no OnBalloonChange; none in use: false', async () => {
  const w = world();
  const rt = await booted(w);
  const sh = last(w);
  assert.equal(rt.state.data.balloon ?? null, null, 'the site default is no choice yet');
  sh.log.length = 0;
  const skins = w.skins.length;
  rt.loop.playScript('\\0Look.\\![reload,balloon]\\e', { event: 'OnTest' });
  const p = rt.loop.reload('balloon');
  assert.equal(typeof p.then, 'function', 'the player waits at the tag');
  assert.equal(await p, true);
  assert.equal(w.skins.length, skins + 1, 'loaded again');
  assert.equal(w.skins.at(-1).name, 'sumika');
  assert.deepEqual([rt.parts.balloons.skins.at(-1), rt.parts.dialogs.skins.at(-1)], [w.skins.at(-1), w.skins.at(-1)]);
  // ChangeOrReloadBalloonInternal(-1, false): AddValueW "balloon" twice, NotifySelfInfo(1), no OnBalloonChange
  // [disasm 0x622ec9, 0x622eee, 0x622f07, 0x622f0d]
  assert.deepEqual(viewIds(sh), ['NOTIFY OnNotifySelfInfo']);
  assert.deepEqual(sh.find('OnNotifySelfInfo')[0].refs.slice(5), ['Sumika', '/balloon/sumika/']);
  assert.deepEqual([rt.state.data.balloon, rt.state.data.shells.master.balloon], ['sumika', 'sumika']);
  assert.equal(rt.player.last.script, '\\0Look.\\![reload,balloon]\\e', 'the script plays on');
  rt.player.finish();
  // the built-in balloon (no balloon folder in use): nothing to reload
  rt.parts.balloon = { ...rt.parts.balloon, id: null };
  sh.log.length = 0;
  assert.equal(await rt.loop.reload('balloon'), false);
  assert.equal(w.skins.length, skins + 1);
  assert.deepEqual(viewIds(sh), []);
});

// ---------------------------------------------------------------- dress-up per shell

test('dress-up per shell: alt\'s parts come back after alt -> master -> alt; the swap keeps places and drops alignment overrides', async () => {
  const w = world();
  const rt = await booted(w);
  rt.parts.stage.char(0).moveTo(400, 700);
  rt.parts.stage.char(0).setAlignment('free');
  const pos = rt.parts.stage.saveState().scopes[0].pos;
  assert.ok(pos && rt.parts.stage.saveState().scopes[0].align === 'free');
  assert.equal(await pickShell(rt, 'alt'), true);
  rt.player.finish();
  const alt = rt.parts.stage;
  assert.deepEqual(alt.saveState().scopes[0].pos, pos, 'the character stays where she was');
  assert.equal(alt.saveState().scopes[0].align, null, '\\![set,alignmenttodesktop] reset');
  assert.deepEqual(alt.bindState(0).onIds(), [1], 'its defaults: Scarf/Red');
  assert.equal(rt.loop.toggleDressup(0, 2), true);           // Clothes/Dressup ▸ Hat - Straw
  assert.deepEqual(alt.bindState(0).onIds().sort(), [1, 2]);
  assert.deepEqual(rt.parts.menu._options(0).dressup.entries.filter(e => e.type === 'part').map(e => [e.id, e.on]), [[2, true], [1, true], [0, false]]);

  assert.equal(await pickShell(rt, 'master'), true);
  rt.player.finish();
  assert.deepEqual(rt.state.data.shells.alt.binds[0].sort(), [1, 2], 'alt\'s dress-up remembered');
  assert.equal(await pickShell(rt, 'alt'), true);
  rt.player.finish();
  assert.deepEqual(rt.parts.stage.bindState(0).onIds().sort(), [1, 2], 'and back');
  assert.ok(!rt.parts.stage.saveState().scopes[0].binds.includes(0));
  assert.deepEqual(rt.state.data.shells.master.binds[0], [], 'master has no bind groups');
});

// ---------------------------------------------------------------- balloons

test('Balloon ▸: the ghost\'s own on top, all in name order; a pick re-skins in place, stores the choice for the ghost and the shell, then OnBalloonChange', async () => {
  const w = world({ descript: [['balloon', 'lightblue']] });
  const rt = await booted(w);
  const sh = last(w);
  assert.deepEqual(rt.balloonList(), {
    top: [{ id: 'LightBlue', name: 'LightBlue', current: true }],
    all: [{ id: 'LightBlue', name: 'LightBlue', current: false }, { id: 'sumika', name: 'Sumika', current: false }],
  });
  assert.equal(rt.state.data.balloon, 'LightBlue', 'the descript\'s balloon is stored as her choice (a folder id)');
  assert.deepEqual(sh.find('OnNotifySelfInfo')[0].refs.slice(5), ['LightBlue', '/ghost/tsubasa/LightBlue/'], 'hoisted: from Tsubasa\'s folder');
  sh.log.length = 0;

  assert.equal(await rt.changeBalloon('sumika'), true);
  const skin = w.skins.at(-1);
  assert.equal(skin.name, 'sumika');
  assert.deepEqual([rt.parts.balloons.skins, rt.parts.dialogs.skins], [[skin], [skin]]);
  assert.deepEqual(viewIds(sh), ['NOTIFY OnNotifySelfInfo', 'GET OnBalloonChange']);
  assert.deepEqual(sh.find('OnNotifySelfInfo')[0].refs.slice(5), ['Sumika', '/balloon/sumika/']);
  assert.deepEqual(sh.find('OnBalloonChange')[0].refs, ['Sumika', '/balloon/sumika/']);
  assert.equal(rt.player.last.script, '\\0A Sumika balloon.\\e');
  assert.deepEqual([rt.state.data.balloon, rt.state.data.shells.master.balloon], ['sumika', 'sumika']);
  assert.equal(rt.balloonList().all.find(b => b.current).id, 'sumika');
  rt.player.finish();
  // a re-pick does it all again; a name the site lacks changes nothing
  assert.equal(await rt.changeBalloon('sumika'), true);
  assert.equal(sh.find('OnBalloonChange').length, 2);
  assert.equal(await rt.changeBalloon('nosuch'), false);
  // \![change,balloon,NAME] by descript name; the player waits at the tag, the reply waits for the script
  rt.player.finish();
  rt.loop.playScript('\\0Look.\\![change,balloon,LightBlue]\\e', { event: 'OnTest' });
  assert.equal(await rt.loop.change('balloon', ['LightBlue', '--option=raise-event']), true);
  assert.equal(rt.player.last.script, '\\0Look.\\![change,balloon,LightBlue]\\e');
  rt.player.finish();
  await settle();
  assert.equal(rt.player.last.script, '\\0A LightBlue balloon.\\e');
  rt.player.finish();

  // each shell remembers its balloon: master's comes back silently with master (no OnBalloonChange)
  assert.equal(await rt.changeBalloon('sumika'), true);      // master: sumika
  rt.player.finish();
  assert.equal(await pickShell(rt, 'alt'), true);             // alt has none: the balloon stays
  rt.player.finish();
  assert.equal(rt.parts.balloon.id, 'sumika');
  assert.equal(await rt.changeBalloon('LightBlue'), true);    // alt: LightBlue
  rt.player.finish();
  sh.log.length = 0;
  const n = rt.parts.balloons.skins.length;
  assert.equal(await pickShell(rt, 'master'), true);
  assert.equal(rt.parts.balloon.id, 'sumika');
  assert.equal(rt.parts.balloons.skins.length, n + 1);
  assert.equal(sh.find('OnBalloonChange').length, 0);
  assert.deepEqual(sh.find('OnNotifySelfInfo')[0].refs.slice(3), ['master', '/ghost/testghost/shell/master/', 'Sumika', '/balloon/sumika/']);
  assert.equal(rt.state.data.balloon, 'LightBlue', 'the ghost\'s own choice stays the last pick');
});

test('a shell without a remembered balloon gets the one it boots with (the ghost\'s choice, BA §1.6), silently, as the next page does', async () => {
  const w = world();
  // master remembers LightBlue; the ghost's own choice is Sumika's balloon; alt remembers nothing
  localStorage.setItem(stateKey('testghost'), JSON.stringify({ v: 1, shell: 'master', balloon: 'sumika', shells: { master: { balloon: 'LightBlue' } } }));
  const rt = await booted(w);
  assert.equal(rt.parts.balloon.id, 'LightBlue', 'rule 1: the shell\'s own');
  assert.equal(rt.state.data.balloon, 'sumika', 'not stored as her choice');
  const sh = last(w);
  sh.log.length = 0;
  assert.equal(await pickShell(rt, 'alt'), true);
  assert.equal(rt.parts.balloon.id, 'sumika', 'GetBalloonIDFromSetting: the ghost\'s choice');
  assert.equal(sh.find('OnBalloonChange').length, 0, 'silently');
  assert.deepEqual(sh.find('OnNotifySelfInfo')[0].refs.slice(5), ['Sumika', '/balloon/sumika/']);
  assert.deepEqual([rt.state.data.balloon, rt.state.data.shells.alt], ['sumika', undefined], 'nothing stored');
  rt.player.finish();
  assert.equal(await pickShell(rt, 'master'), true);
  assert.equal(rt.parts.balloon.id, 'LightBlue', 'master\'s own again');
  rt.player.finish();
  assert.equal(await pickShell(rt, 'alt'), true);
  rt._onPageHide();
  rt.done();
  await settle();
  const rt2 = await booted(w);
  assert.deepEqual([rt2.parts.stage.shellId, rt2.parts.balloon.id], ['alt', 'sumika'], 'the next page boots the same');
});

test('boot stores the balloon of rule 2, or of rules 3–4 while nothing is stored; a stored choice the site lost is kept and comes back (BA §1.6, D5)', async () => {
  const w = world({ descript: [['balloon', 'lightblue']] });
  localStorage.setItem(stateKey('testghost'), JSON.stringify({ v: 1, balloon: 'retired' }));
  const rt = await booted(w);
  assert.equal(rt.parts.balloon.id, 'LightBlue', 'rule 3: the descript\'s');
  assert.equal(rt.state.data.balloon, 'retired', 'the lost choice is kept');
  rt._onPageHide();
  rt.done();
  await settle();
  assert.equal(JSON.parse(localStorage.getItem(stateKey('testghost'))).balloon, 'retired');

  w.index.balloons.push({ id: 'retired', name: 'Retired' });     // the site has it again
  sessionStorage.clear();
  const rt2 = await booted(w);
  assert.equal(rt2.parts.balloon.id, 'retired', 'it comes back');
  rt2.done();
  await settle();

  // an old state's descript name becomes the folder id (rule 2); with no choice, the descript's is stored (rule 3)
  for (const [stored, want] of [['Sumika', 'sumika'], [null, 'LightBlue']]) {
    localStorage.setItem(stateKey('testghost'), JSON.stringify({ v: 1, balloon: stored }));
    sessionStorage.clear();
    const r = await booted(w);
    assert.equal(r.state.data.balloon, want, String(stored));
    r.done();
    await settle();
  }
});

// ---------------------------------------------------------------- the next page

test('next page: the picked shell resumes with its dress-up; never picked -> the default shell; a stored shell the site lost -> the default', async () => {
  const w = world();
  const rt = await booted(w);
  assert.equal(await pickShell(rt, 'alt'), true);
  rt.player.finish();
  rt.loop.toggleDressup(0, 2);
  rt._onPageHide();
  rt.done();
  await settle();

  const rt2 = await booted(w);
  assert.equal(rt2.parts.stage.shellId, 'alt');
  assert.deepEqual(rt2.parts.stage.bindState(0).onIds().sort(), [1, 2]);
  assert.deepEqual(last(w).find('OnNotifySelfInfo')[0].refs.slice(3, 5), ['Winter', ALT_PATH]);
  rt2.done();
  await settle();

  for (const [stored, why] of [[{ shell: 'alt', shellChosen: false }, 'never picked'], [{ shell: 'gone', shellChosen: true }, 'gone']]) {
    localStorage.setItem(stateKey('testghost'), JSON.stringify({ v: 1, ...stored }));
    sessionStorage.clear();
    const r = await booted(w);
    assert.equal(r.parts.stage.shellId, 'master', why);
    assert.deepEqual([r.state.data.shell, r.state.data.shellChosen], ['master', false], why);
    r.done();
    await settle();
  }
});

test('a page left during OnShellChanging\'s talk drops the change and does not replay it; one left mid-swap boots the new shell', async () => {
  const w = world();
  const rt = await booted(w);
  rt.parts.menu._run({ type: 'shell', id: 'alt' }, 0);
  await settle();
  assert.equal(rt.loop.current.event, 'OnShellChanging');
  rt._onPageHide();
  const st = JSON.parse(localStorage.getItem(stateKey('testghost')));
  assert.deepEqual([st.shell, st.run], ['master', null]);
  rt.done();
  await settle();

  // mid-swap: the new stage is still loading when the page goes
  const rt2 = await booted(w);
  let release;
  const gate = new Promise(r => { release = r; });
  const make = rt2._createStage.bind(rt2);
  rt2._createStage = async o => { await gate; return make(o); };
  const p = rt2.changeShell('alt');
  for (let i = 0; i < 20 && rt2.player.busy === false; i++) await settle();
  rt2.player.finish();
  await settle();
  rt2._onPageHide();
  assert.deepEqual(JSON.parse(localStorage.getItem(stateKey('testghost'))).shell, 'alt');
  rt2.done();
  await settle();
  release();
  assert.equal(await p, false);
  const rt3 = await booted(w);
  assert.equal(rt3.parts.stage.shellId, 'alt');
  assert.equal(last(w).find('OnShellChanged').length, 0);
});

test('a page left after the new stage is attached but before OnShellChanged decides the surfaces: the next page and a frozen tab show the characters', async () => {
  // (a) menu path: the page goes while OnShellChanged is still being asked
  const held = deferred();
  const w = world({ answer: (id, r) => (r.id === 'OnShellChanged' ? held.promise : defaultAnswer(id, r)) });
  const rt = await booted(w);
  const p = rt.changeShell('alt');
  for (let i = 0; i < 20 && !last(w).find('OnShellChanged').length; i++) { if (rt.player.busy) rt.player.finish(); await settle(); }
  assert.equal(rt.parts.stage.shellId, 'alt');
  assert.equal(rt.parts.stage.char(0).surfaceId, -1, 'nothing decided yet');
  rt.state.saveNow();                                     // the debounced save of the attached stage

  // another tab opens the ghost now: frozen, and not invisible
  const tab = new TestRuntime(w, { doc: fakeDoc(true) });
  assert.equal(await tab.start(), 'frozen');
  assert.equal(tab.frozen.shellId, 'alt');
  assert.equal(tab.frozen.char(0).surfaceId, 0, 'the remembered surface');
  tab.done();

  rt._onPageHide();
  const st = JSON.parse(localStorage.getItem(stateKey('testghost')));
  assert.deepEqual([st.stage.shell, st.stage.scopes[0].surface, st.shellSwap], ['alt', -1, { surfaces: { 0: 0 } }]);
  rt.done();
  await settle();
  held.resolve(null);
  await p;
  // the next page of the tab (a resume): the remembered surface comes back, as on a 204
  const rt2 = await booted(w);
  assert.equal(rt2.parts.stage.shellId, 'alt');
  assert.equal(rt2.parts.stage.char(0).surfaceId, 0);
  assert.ok(rt2.parts.stage.char(0).visible);
  assert.equal(rt2.state.data.shellSwap, null, 'settled');
  assert.equal(last(w).find('OnShellChanged').length, 0, 'still no OnShellChanged there [decision]');
});

test('a script\'s \\![change,shell]: until its deferred OnShellChanged reply starts, a page left resumes with the surfaces shown; afterwards a deliberate \\s[-1] stays', async () => {
  const w = world();
  const rt = await booted(w);
  rt.loop.playScript('\\0Wait.\\![change,shell,Winter]A long story.\\e', { event: 'OnTest' });
  assert.equal(await rt.loop.change('shell', ['Winter']), true);
  assert.equal(rt.parts.stage.char(0).surfaceId, -1);
  assert.ok(rt.state.data.shellSwap, 'the reply waits for the script: not decided yet');
  rt._onPageHide();
  rt.done();
  await settle();
  const rt2 = await booted(w);
  assert.equal(rt2.parts.stage.shellId, 'alt');
  assert.equal(rt2.parts.stage.char(0).surfaceId, 0, 'shown again');
  rt2.player.finish();
  await settle();

  // the reply starts: from here the surfaces are the ghost's
  rt2.loop.playScript('\\0Again.\\![change,shell,master]\\e', { event: 'OnTest' });
  assert.equal(await rt2.loop.change('shell', ['master']), true);
  assert.ok(rt2.state.data.shellSwap);
  rt2.player.finish();
  await settle();
  assert.equal(rt2.player.last.script, '\\0Now in master.\\e');
  assert.equal(rt2.state.data.shellSwap, null, 'cleared as the reply starts');
  rt2.parts.stage.char(0).setSurface(-1);                 // what her reply's \s[-1] does
  rt2.player.finish();
  rt2._onPageHide();
  rt2.done();
  await settle();
  const rt3 = await booted(w);
  assert.equal(rt3.parts.stage.char(0).surfaceId, -1, 'she hid herself: stays hidden');

  // 204 to a script's change: the remembered surfaces come back at once, nothing is left pending
  const w2 = world({ answer: (id, r) => (r.id === 'OnShellChanged' ? null : defaultAnswer(id, r)) });
  const r4 = await booted(w2);
  r4.loop.playScript('\\0Wait.\\![change,shell,Winter]\\e', { event: 'OnTest' });
  assert.equal(await r4.loop.change('shell', ['Winter']), true);
  assert.equal(r4.parts.stage.char(0).surfaceId, 0);
  assert.equal(r4.state.data.shellSwap, null);
});

// ---------------------------------------------------------------- tabs and the change slot

test('tabs: a frozen tab of the same ghost redraws with the new shell, then takes over on it', async () => {
  const w = world();
  const lockBus = busChannel();
  const d1 = fakeDoc(false), d2 = fakeDoc(true);
  const tab1 = await booted(w, { doc: d1, lockBus });
  const tab2 = new TestRuntime(w, { doc: d2, lockBus });
  assert.equal(await tab2.start(), 'frozen');
  const frozen = tab2.frozen;
  assert.equal(frozen.shellId, 'master');
  assert.equal(await pickShell(tab1, 'alt'), true);
  tab1.player.finish();
  for (let i = 0; i < 20 && tab2.frozen === frozen; i++) await settle();
  assert.equal(tab2.frozen.shellId, 'alt', 'redrawn with the new shell');
  assert.ok(frozen.gone);
  assert.equal(tab2.frozen.char(0).surfaceId, 0, 'on its default surface');
  assert.equal(tab2.parts, null, 'still frozen: no engine there');

  d1.hidden = true;                                       // the visitor turns to tab 2
  d2.hidden = false;
  d2.fire('visibilitychange');
  for (let i = 0; i < 40 && !(tab2.loop && tab2.loop.booted); i++) await settle();
  assert.ok(tab2.loop && tab2.loop.booted);
  assert.equal(tab2.parts.stage.shellId, 'alt');
  assert.equal(tab1.parts, null);
});

test('one change at a time: a shell change during a ghost change is refused, and a takeover asked during a shell change is answered after it', async () => {
  const w = world();
  const rt = await booted(w);
  const p = rt.changeGhost('tsubasa');
  await settle();
  assert.equal(rt.loop.current.event, 'OnGhostChanging');
  assert.equal(await rt.changeShell('alt'), false);
  assert.equal(rt.loop.change('shell', ['Winter']), undefined, 'a script\'s change too');
  rt.parts.balloons.emit('dblclick', { scope: 0 });          // and the ghost change is cancelled
  assert.equal(await p, false);
  assert.equal(rt.ghost.id, 'testghost');
  rt.player.finish();
  assert.equal(await rt.changeBalloon('sumika'), true, 'free again');
  rt.player.finish();

  rt.parts.menu._run({ type: 'shell', id: 'alt' }, 0);
  const q = rt._changing;
  await settle();
  rt._onTakeoverRequest();                                   // another tab asks (no document here: hidden)
  await settle();
  assert.ok(rt.loop, 'not now');
  assert.equal(await rt.changeBalloon('LightBlue'), false, 'nor a balloon change');
  rt.player.finish();
  assert.equal(await q, true);
  for (let i = 0; i < 20 && rt.parts; i++) await settle();
  assert.equal(rt.parts, null, 'after the change, the tab lets the ghost go');
  assert.equal(JSON.parse(localStorage.getItem(stateKey('testghost'))).shell, 'alt');
  assert.equal(runtimePrefs.get().ghost, 'testghost');
});

test('a script\'s change asked while the slot is held waits for it (333-4.05: OnShellChanged\'s reply changes back; OnBalloonChange\'s reply too)', async () => {
  const answer = (id, r) => {
    if (r.id === 'OnShellChanging') return null;
    if (r.id === 'OnShellChanged') return r.refs[0] === 'Winter' ? '\\0\\![change,shell,master]Back.\\e' : '\\0\\s[0]Now in master.\\e';
    if (r.id === 'OnBalloonChange') return r.refs[0] === 'Sumika' ? '\\0\\![change,balloon,LightBlue]\\e' : '\\0Blue.\\e';
    return defaultAnswer(id, r);
  };
  const w = world({ answer });
  const rt = new RealPlayerRuntime(w);
  assert.equal(await rt.start(), 'booted');
  await rt.runOut();
  const sh = last(w);
  sh.log.length = 0;
  assert.equal(await rt.changeShell('alt'), true);        // Shell ▸ (page API): the reply plays inside the slot
  await rt.runOut();
  assert.deepEqual(w.stages.map(s => s.shellId), ['master', 'alt', 'master'], 'the reply\'s change went through');
  assert.deepEqual(sh.find('OnShellChanged').map(r => r.refs[0]), ['Winter', 'master']);
  assert.equal(sh.find('OnShellChanging').length, 1, 'the second one is a script\'s change: no OnShellChanging');
  assert.equal(rt.loop.current.event, 'OnShellChanged', 'its reply played after "Back."');
  assert.equal(rt.parts.stage.char(0).surfaceId, 0);
  assert.deepEqual([rt.state.data.shell, rt.state.data.shellChosen, rt.state.data.shellSwap], ['master', true, null]);
  assert.equal(rt._changing, null);

  assert.equal(await rt.changeBalloon('sumika'), true);
  await rt.runOut();
  assert.equal(rt.parts.balloon.id, 'LightBlue');
  assert.deepEqual(sh.find('OnBalloonChange').map(r => r.refs[0]), ['Sumika', 'LightBlue']);
  assert.deepEqual([rt.state.data.balloon, rt.state.data.shells.master.balloon], ['LightBlue', 'LightBlue']);
});

test('a \\![change,ghost] in OnBalloonChange\'s reply waits for the balloon change, then the ghost changes', async () => {
  const answer = (id, r) => (r.id === 'OnBalloonChange' ? '\\0\\![change,ghost,Tsubasa]\\e' : defaultAnswer(id, r));
  const w = world({ answer });
  const rt = new RealPlayerRuntime(w);
  assert.equal(await rt.start(), 'booted');
  await rt.runOut();
  assert.equal(await rt.changeBalloon('LightBlue'), true);
  for (let i = 0; i < 4 && rt.ghost.id !== 'tsubasa'; i++) await rt.runOut();
  assert.equal(rt.ghost.id, 'tsubasa');
  assert.ok(rt.loop && rt.loop.booted);
  assert.equal(JSON.parse(localStorage.getItem(stateKey('testghost'))).balloon, 'LightBlue', 'the balloon change went first');
  assert.equal(rt._changing, null);
});

test('a boot script\'s \\![change,shell] after Change ghost ▸ waits for the ghost change and then happens, as on a page load', async () => {
  const answer = (id, r) => {
    if (id === 'testghost' && /^On(Boot|FirstBoot|GhostChanged)$/.test(r.id)) return '\\0\\![change,shell,Winter]\\s[0]Hello.\\e';
    if (r.id === 'OnGhostChanging') return '\\0Bye.\\e';
    if (r.id === 'OnShellChanged') return `\\0\\s[0]Now in ${r.refs[0]}.\\e`;
    return /^On(Boot|FirstBoot)$/.test(r.id) ? '\\0Hi.\\e' : null;
  };
  const w = world({ answer });
  runtimePrefs.set({ ghost: 'tsubasa' });
  const rt = new RealPlayerRuntime(w);
  assert.equal(await rt.start(), 'booted');
  assert.equal(rt.ghost.id, 'tsubasa');
  await rt.runOut();
  const p = rt.changeGhost('testghost');
  await rt.runOut();
  assert.equal(await p, true);
  await rt.runOut();
  assert.equal(rt.ghost.id, 'testghost');
  assert.equal(rt.parts.stage.shellId, 'alt');
  assert.deepEqual(last(w).find('OnShellChanged').map(r => r.refs[0]), ['Winter']);
  assert.equal(rt.loop.current.event, 'OnShellChanged', 'its reply after the boot script');
  assert.equal(rt._changing, null);
});

test('change slot: a script\'s change during OnShellChanging\'s talk is refused (that talk holds the change); menu and page requests are refused; a chain stops after a few', async () => {
  const w = world();
  const rt = await booted(w);
  rt.parts.menu._run({ type: 'shell', id: 'alt' }, 0);
  const q = rt._changing;
  await settle();
  assert.equal(rt.loop.current.event, 'OnShellChanging');
  assert.equal(await rt.loop.change('shell', ['master']), false, 'refused at once: no wait on the talk it would hold');
  assert.equal(await rt.loop.change('balloon', ['LightBlue']), false);
  rt.player.finish();
  assert.equal(await q, true);
  assert.equal(rt.parts.stage.shellId, 'alt');
  rt.player.finish();

  // during the build: the page API is refused, a script's change waits
  let release;
  const gate = new Promise(r => { release = r; });
  const make = rt._createStage.bind(rt);
  rt._createStage = async o => { await gate; return make(o); };
  const sw = rt.changeShell('master');
  for (let i = 0; i < 20 && !rt.player.busy; i++) await settle();
  rt.player.finish();                                     // OnShellChanging's talk: the build starts
  await settle();
  assert.equal(await rt.changeBalloon('LightBlue'), false, 'the page API is refused');
  const chained = rt.loop.change('balloon', ['LightBlue']);
  release();
  assert.equal(await sw, true);
  assert.equal(await chained, true, 'the script\'s change after it');
  assert.equal(rt.parts.balloon.id, 'LightBlue');
  rt._createStage = make;
  rt.player.finish();
  await settle();

  // a reply that always asks for another raise-event change: each is one more request, and the chain stops
  const w2 = world({
    answer: (id, r) => (r.id === 'OnShellChanged' ? `\\0\\![change,shell,${r.refs[0] === 'Winter' ? 'master' : 'Winter'},--option=raise-event]\\e`
      : r.id === 'OnShellChanging' ? null : defaultAnswer(id, r)),
  });
  const r2 = new RealPlayerRuntime(w2);
  assert.equal(await r2.start(), 'booted');
  await r2.runOut();
  assert.equal(await r2.changeShell('alt'), true);
  for (let i = 0; i < 6; i++) await r2.runOut();
  const n = w2.stages.length;
  assert.equal(n, 2 + MAX_CHAINED_CHANGES, 'the pick, then MAX_CHAINED_CHANGES more, then it stops');
  for (let i = 0; i < 4; i++) await r2.runOut();
  assert.equal(w2.stages.length, n, 'no more');
  assert.equal(r2._changing, null);
  assert.ok(await r2.changeShell('alt'), 'the slot is free again');
});

test('a script\'s \\![change,ghost] ahead of its \\![change,shell|balloon]: the ghost change, asked first, goes first and refuses the later one at once; nothing waits for the 30 s cap', async () => {
  // both queued behind the menu swap (OnShellChanged's reply plays inside its slot)
  for (const second of ['\\![change,shell,master]', '\\![change,balloon,LightBlue]']) {
    const answer = (id, r) => {
      if (r.id === 'OnShellChanging') return null;
      if (id === 'testghost' && r.id === 'OnShellChanged') return `\\0\\s[0]\\![change,ghost,Tsubasa]${second}\\0after\\e`;
      return defaultAnswer(id, r);
    };
    const w = world({ answer });
    const rt = new RealPlayerRuntime(w);
    assert.equal(await rt.start(), 'booted');
    await rt.runOut();
    const a = last(w);
    const m = rt.mocks;
    assert.equal(await rt.changeShell('alt'), true);
    for (let i = 0; i < 4 && rt.ghost.id !== 'tsubasa'; i++) await rt.runOut();
    assert.equal(rt.ghost.id, 'tsubasa', `${second}: the ghost changed at the script's end, not after the cap`);
    assert.equal(m.balloons.get(0).text, 'after', 'the script went on past the refused tag');
    assert.deepEqual([a.find('OnShellChanged').length, a.find('OnBalloonChange').length], [1, 0], 'no second change');
    assert.ok(rt.loop && rt.loop.booted);
    assert.equal(rt._changing, null);
    rt.done();
  }

  // a page load's boot script: the ghost change waits for the boot to end, and the later tag is refused meanwhile
  const w = world({
    answer: (id, r) => (id === 'testghost' && /^On(Boot|FirstBoot)$/.test(r.id) ? '\\0\\![change,ghost,Tsubasa]\\![change,shell,Winter]boot\\e' : defaultAnswer(id, r)),
  });
  const rt = new RealPlayerRuntime(w);
  assert.equal(await rt.start(), 'booted');
  const m = rt.mocks;
  for (let i = 0; i < 4 && rt.ghost.id !== 'tsubasa'; i++) await rt.runOut();
  assert.equal(rt.ghost.id, 'tsubasa');
  assert.equal(m.balloons.get(0).text, 'boot');
  assert.ok(!w.stages.some(s => s.shellId === 'alt'), 'no shell change');
  assert.equal(rt._changing, null);
});

test('333-4.05 on the menu path: OnShellChanged\'s reply shows nothing before its \\![change,shell]; a page left or a takeover during the queued swap resumes the ghost visible', async () => {
  const answer = (id, r) => {
    if (r.id === 'OnShellChanging') return null;
    if (r.id === 'OnShellChanged') return r.refs[0] === 'Winter' ? '\\1\\![change,shell,master] \\e' : '\\0\\s[0]Back.\\e';
    return defaultAnswer(id, r);
  };
  // a page left while the queued swap builds master: the menu swap's surfaces carried on
  let w = world({ answer });
  const rt = new RealPlayerRuntime(w);
  assert.equal(await rt.start(), 'booted');
  await rt.runOut();
  const make = rt._createStage.bind(rt);
  let n = 0;
  const gate = deferred();
  rt._createStage = async o => { if (++n === 2) await gate.promise; return make(o); };
  const p = rt.changeShell('alt');
  for (let i = 0; i < 40 && n < 2; i++) await settle();
  assert.equal(n, 2, 'the queued swap builds master');
  assert.equal(rt.parts.stage.char(0).surfaceId, -1, 'the reply showed nothing');
  assert.deepEqual(rt.state.data.shellSwap, { surfaces: { 0: 0 } }, 'the marker the queued swap took over');
  rt._onPageHide();
  rt.done();
  gate.resolve();
  assert.equal(await p, true);
  await settle();
  const rt2 = new RealPlayerRuntime(w);
  assert.equal(await rt2.start(), 'booted');
  assert.equal(rt2.parts.stage.shellId, 'master');
  assert.equal(rt2.parts.stage.char(0).surfaceId, 0, 'visible again');
  rt2.done();

  // the same page: the chain runs to its end, the queued swap's reply decides, nothing is left pending
  w = world({ answer });
  const r3 = new RealPlayerRuntime(w);
  assert.equal(await r3.start(), 'booted');
  await r3.runOut();
  assert.equal(await r3.changeShell('alt'), true);
  await r3.runOut();
  assert.deepEqual(w.stages.map(s => s.shellId), ['master', 'alt', 'master']);
  assert.equal(r3.loop.current.event, 'OnShellChanged');
  assert.equal(r3.parts.stage.char(0).surfaceId, 0);
  assert.deepEqual([r3.state.data.shellSwap, r3._chainMark, r3._changing], [null, null, null]);
  r3.done();

  // a queued shell change that swaps nothing (an unknown name): the kept marker goes when the slot frees
  w = world({ answer: (id, r) => (r.id === 'OnShellChanged' ? '\\1\\![change,shell,Nobody] \\e' : r.id === 'OnShellChanging' ? null : defaultAnswer(id, r)) });
  const r4 = new RealPlayerRuntime(w);
  assert.equal(await r4.start(), 'booted');
  await r4.runOut();
  assert.equal(await r4.changeShell('alt'), true);
  await r4.runOut();
  assert.deepEqual([r4.state.data.shellSwap, r4._chainMark, r4._changing], [null, null, null]);
  r4.done();

  // a reply that queues a balloon change instead: it decided (nothing shown); no marker is kept for it
  w = world({ answer: (id, r) => (r.id === 'OnShellChanged' ? '\\1\\![change,balloon,LightBlue] \\e' : r.id === 'OnShellChanging' ? null : defaultAnswer(id, r)) });
  const r5 = new RealPlayerRuntime(w);
  assert.equal(await r5.start(), 'booted');
  await r5.runOut();
  assert.equal(await r5.changeShell('alt'), true);
  assert.deepEqual([r5.state.data.shellSwap, r5._chainMark], [null, null]);
  await r5.runOut();
  assert.equal(r5.parts.balloon.id, 'LightBlue');
  r5.done();

  // a takeover asked during the menu swap is answered right after the queued swap, before its deferred reply plays
  w = world({ answer });
  const lockBus = busChannel();
  const a = new RealPlayerRuntime(w, { doc: fakeDoc(true), lockBus });
  assert.equal(await a.start(), 'booted');
  await a.runOut();
  const makeA = a._createStage.bind(a);
  const first = deferred();
  let k = 0;
  a._createStage = async o => { if (++k === 1) await first.promise; return makeA(o); };
  const pa = a.changeShell('alt');
  await settle();
  const b = new TestRuntime(w, { doc: fakeDoc(false), lockBus });
  const bStart = b.start();
  for (let i = 0; i < 20 && !a._takeoverAsked; i++) await settle();
  assert.equal(a._takeoverAsked, true, 'asked during the menu swap');
  first.resolve();
  assert.equal(await pa, true);
  for (let i = 0; i < 40 && !(b.loop && b.loop.booted); i++) { await a.pclock.runAll(); await settle(); }
  assert.equal(await bStart, 'frozen');
  assert.ok(b.loop && b.loop.booted, 'tab B took over');
  assert.equal(b.parts.stage.shellId, 'master');
  assert.equal(b.parts.stage.char(0).surfaceId, 0, 'visible');
});

test('333-4.05-like chain whose queued swap answers OnShellChanged with 204: the 204 decides (nothing shown, as SSP), so the marker goes and the next page agrees', async () => {
  const answer = (id, r) => {
    if (r.id === 'OnShellChanging') return null;
    if (r.id === 'OnShellChanged') return r.refs[0] === 'Winter' ? '\\1\\![change,shell,master] \\e' : null;
    return defaultAnswer(id, r);
  };
  const w = world({ answer });
  const rt = new RealPlayerRuntime(w);
  assert.equal(await rt.start(), 'booted');
  await rt.runOut();
  assert.equal(await rt.changeShell('alt'), true);
  await rt.runOut();
  assert.deepEqual(w.stages.map(s => s.shellId), ['master', 'alt', 'master']);
  assert.equal(rt.parts.stage.char(0).surfaceId, -1, 'the queued swap restored only its own (empty) set');
  assert.deepEqual([rt.state.data.shellSwap, rt._chainMark, rt._changing], [null, null, null], 'no marker left');
  rt._onPageHide();
  rt.done();
  await settle();
  const rt2 = new RealPlayerRuntime(w);
  assert.equal(await rt2.start(), 'booted');
  assert.equal(rt2.parts.stage.shellId, 'master');
  assert.equal(rt2.parts.stage.char(0).surfaceId, -1, 'the next page shows what this page showed');
  rt2.done();
});

test('a script still playing when a menu swap starts (OnShellChanging answered 204) waits during the swap: none of its tags land on the stage being replaced; it goes on on the new one', async () => {
  const w = world({ answer: (id, r) => (/^OnShellChang/.test(r.id) ? null : defaultAnswer(id, r)) });
  const rt = new RealPlayerRuntime(w);
  assert.equal(await rt.start(), 'booted');
  await rt.runOut();
  const m = rt.mocks;
  const old = rt.parts.stage;
  rt.loop.playScript('\\0\\s[0]Let me think\\_w[3000]\\s[-1]gone.\\e', { event: 'OnTalk' });
  await rt.pclock.advance(100);
  const make = rt._createStage.bind(rt);
  const gate = deferred();
  rt._createStage = async o => { await gate.promise; return make(o); };
  const p = rt.changeShell('alt');
  for (let i = 0; i < 20 && !rt.loop.swapping; i++) await settle();
  assert.equal(rt.loop.swapping, true, 'OnShellChanging 204: the swap starts while she talks');
  await rt.pclock.advance(5000);
  assert.equal(old.char(0).surfaceId, 0, 'no \\s[-1] on the old stage');
  assert.equal(m.balloons.get(0).text, 'Let me think', 'nothing more said meanwhile');
  assert.equal(rt.player.busy, true, 'still her talk');
  gate.resolve();
  assert.equal(await p, true);
  const stage = rt.parts.stage;
  assert.equal(stage.shellId, 'alt');
  assert.equal(stage.char(0).surfaceId, 0, 'OnShellChanged 204: the surface came back');
  await rt.pclock.advance(3000);
  assert.equal(stage.char(0).surfaceId, -1, 'then her talk went on, on the new stage');
  assert.equal(m.balloons.get(0).text, 'Let me thinkgone.');
  assert.ok(old.gone);
});

test('tabs: a shell change while another tab still builds its frozen stage is followed there', async () => {
  const w = world();
  const tab1 = await booted(w, { doc: fakeDoc(false) });
  const tab2 = new TestRuntime(w, { doc: fakeDoc(true) });
  let release;
  const gate = new Promise(r => { release = r; });
  const make = tab2._createStage.bind(tab2);
  tab2._createStage = async o => { await gate; return make(o); };
  const started = tab2.start();
  await settle();
  assert.equal(await pickShell(tab1, 'alt'), true);       // {t:'view'} arrives before tab 2 has a frozen stage
  tab1.player.finish();
  await settle();
  release();
  assert.equal(await started, 'frozen');
  for (let i = 0; i < 20 && !(tab2.frozen && tab2.frozen.shellId === 'alt'); i++) await settle();
  assert.equal(tab2.frozen.shellId, 'alt');
  assert.equal(tab2.frozen.char(0).surfaceId, 0);
});

// ---------------------------------------------------------------- the site

test('site index (tools/index_site.py): Tsubasa\'s LightBlue hoisted with its own manifest and pack; shells in SSP\'s name order', needs('site/ghost/tsubasa', 'site/ghost/hayato'), () => {
  const dir = path.join(ROOT, 'site/sumika/index');
  const site = JSON.parse(fs.readFileSync(path.join(dir, 'ghosts.json'), 'utf8'));
  assert.deepEqual(site.balloons.find(b => b.id === 'LightBlue'), { id: 'LightBlue', name: 'LightBlue', ghost: 'tsubasa' });
  assert.equal(site.defaultBalloon, 'sumika');
  const m = manifestOf(path.join(ROOT, 'site'), 'balloon', 'LightBlue', site);     // ghosts.json `manifests` names it
  assert.equal(m.root, 'ghost/tsubasa/LightBlue/');
  assert.ok(m.pack && fs.existsSync(path.join(ROOT, 'site', m.pack)), 'its own text pack');
  assert.ok(m.files.some(([p]) => p === 'descript.txt'));
  for (const g of site.ghosts) {
    assert.ok(g.shells.length > 0, g.id);
    assert.deepEqual(g.shells, sortShells(g.shells), `${g.id}: shells in name order`);
    assert.ok(g.shells.some(s => s.id === g.defaultShell), `${g.id}: its default shell is listed`);
  }
  assert.deepEqual(site.ghosts.find(g => g.id === 'hayato').shells, [{ id: 'master', name: 'kinzon_mey' }]);
});

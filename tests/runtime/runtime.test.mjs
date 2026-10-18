// src/core/runtime.js helpers. Imported statically: an import error in runtime.js fails this file, it doesn't skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GhostFiles } from '../../src/core/loader.js';
import * as mod from '../../src/core/runtime.js';
import { FsFiles, GHOST, FakeClock as ShellClock, nodeDecode } from '../shell/helpers.mjs';
import { needs } from '../needs.mjs';

test('engine file list: ghost/master text files of every dictionary folder, no images, DLLs or saves',() => {
  const files = new GhostFiles('http://s/ghost/tsubasa/', [
    ['ghost/master/descript.txt', 1], ['ghost/master/dic01_Boot.txt', 1], ['ghost/master/bath/dic01_Boot.txt', 1],
    ['ghost/master/saori/yaya.txt', 1], ['ghost/master/saori/builtins.aym', 1], ['ghost/master/saori/gomi.dll', 1],
    ['ghost/master/0.png', 1], ['ghost/master/updates.txt', 1], ['ghost/master/updates2.dau', 1],
    ['ghost/master/satori_savedata.txt', 1], ['ghost/master/satori_conf.txt', 1], ['shell/master/descript.txt', 1],
  ]);
  assert.deepEqual(mod.engineFileList(files).sort(), [
    'bath/dic01_Boot.txt', 'descript.txt', 'dic01_Boot.txt', 'saori/builtins.aym', 'saori/yaya.txt', 'satori_conf.txt',
  ]);
});

test('ghost choice: stored, then the page default, then the first',() => {
  const ghosts = [{ id: 'a' }, { id: 'tsubasa' }];
  const index = { ghosts, ghost: id => ghosts.find(g => g.id === id) || null };
  assert.equal(mod.chooseGhost(index, { stored: 'tsubasa', defaultGhost: 'a' }).id, 'tsubasa');
  assert.equal(mod.chooseGhost(index, { stored: 'gone', defaultGhost: 'tsubasa' }).id, 'tsubasa');
  assert.equal(mod.chooseGhost(index, {}).id, 'a');
  assert.equal(mod.chooseGhost({ ghosts: [], ghost: () => null }, {}), null);
});

test('ghost change target with other ghosts on screen (exclude, EV §2.7.2): random and sequential skip them, a named one is refused',() => {
  const ghosts = ['x', 'y', 'z', 'w'].map(id => ({ id, name: `Ghost ${id}`, sakuraName: `${id}s`, engine: 'satori' }));
  const ex = new Set(['y']);
  for (const r of [0, 0.34, 0.67, 0.999]) assert.notEqual(mod.resolveGhostTarget(ghosts, 'x', 'random', { random: () => r, exclude: ex }).id, 'y');
  assert.equal(mod.resolveGhostTarget(ghosts, 'x', 'sequential', { exclude: ex }).id, 'z', 'skips y');
  assert.equal(mod.resolveGhostTarget(ghosts, 'w', 'sequential', { exclude: new Set(['x', 'y', 'z']) }), null, 'nobody left');
  assert.equal(mod.resolveGhostTarget(ghosts, 'x', 'Ghost y', { exclude: ex }), null);
  assert.equal(mod.resolveGhostTarget(ghosts, 'x', 'ys', { exclude: ex }), null, 'by sakura name too');
  assert.equal(mod.resolveGhostTarget(ghosts, 'x', 'y', { byId: true, exclude: ['y'] }), null, 'byId; an array works too');
  // without exclude (one ghost on screen): every ghost counts
  assert.equal(mod.resolveGhostTarget(ghosts, 'x', 'Ghost y').id, 'y');
  assert.equal(mod.resolveGhostTarget(ghosts, 'x', 'y', { byId: true }).id, 'y');
  assert.equal(mod.resolveGhostTarget(ghosts, 'x', 'sequential').id, 'y');
});

test('cold boot stage state: Close/Iconify saved everything hidden; she comes back on default surfaces; every scope keeps its place',() => {
  const saved = {
    v: 1, shell: 'master',
    scopes: {
      0: { surface: 5, pos: { rx: 0.9, ry: 1 }, binds: [0, 30], visible: false, align: 'free', scaling: [100, 100], alpha: 80 },
      1: { surface: -1, last: { x: 0, y: 0, w: 4, h: 4, bx: 2, by: 4 }, pos: null, binds: [], visible: false, align: null, scaling: [100, 100], alpha: 0 },
      100: { surface: 3, pos: { rx: 0.5, ry: 0.5 }, binds: [7], visible: false },
      101: { surface: 1, pos: { rx: 0.1, ry: 0.1 }, binds: [], visible: true },
    },
  };
  assert.deepEqual(mod.coldStageState(saved), {
    v: 1, shell: 'master',
    scopes: {
      0: { visible: true, pos: { rx: 0.9, ry: 1 }, binds: [0, 30], align: 'free', scaling: [100, 100], alpha: 80 },
      1: { visible: true, binds: [], scaling: [100, 100] },
      // a \p[n] keeps its dress-up and its place (SSP's Char<n>.ratio, UI §3.3), no surface: no window until a script
      100: { binds: [7], pos: { rx: 0.5, ry: 0.5 } },
      101: { pos: { rx: 0.1, ry: 0.1 } },
    },
  });
  assert.equal(mod.coldStageState(null), undefined);
  assert.equal(mod.coldStageState({ v: 1 }), undefined);
});

test('cold boot after Close with the real shell: visible, default surfaces, same place and clothes, no \p[100] until shown, then where it stood', { ...needs('site/ghost/tsubasa'), timeout: 60000 }, async () => {
  const { Stage } = await import('../../src/shell/stage.js');
  const make = async state => {
    const stage = await Stage.create({ files: new FsFiles(GHOST), dom: false, decode: nodeDecode, clock: new ShellClock(0), desk: { w: 1280, h: 720 }, state });
    for (let i = 0; i < 20; i++) { stage.tick(0); await new Promise(r => setImmediate(r)); }
    return stage;
  };
  const a = await make();
  a.char(0).moveTo(400, 700);
  a.char(0).setSurface(5);
  a.char(100).setSurface(a.defaultSurface(100));
  for (let i = 0; i < 20; i++) { a.tick(0); await new Promise(r => setImmediate(r)); }
  a.char(100).moveTo(300, 400);                      // dragged away from its default place
  const where = a.char(100).basePoint;
  for (const s of a.scopes) a.char(s).hide();        // what Close and Iconify do before saving
  const saved = JSON.parse(JSON.stringify(a.saveState()));
  assert.equal(saved.scopes[0].visible, false);
  a.destroy();

  const b = await make(mod.coldStageState(saved));
  mod.showDefaultCharacters(b);
  for (const s of [0, 1]) {
    assert.equal(b.char(s).visible, true, `scope ${s} visible`);
    assert.equal(b.char(s).surfaceId, b.defaultSurface(s), `scope ${s} default surface`);
  }
  const st = b.saveState();
  assert.deepEqual(st.scopes[0].pos, saved.scopes[0].pos, 'position kept');
  assert.deepEqual(st.scopes[0].binds, saved.scopes[0].binds, 'dress-up kept');
  assert.ok(!b.has(100) || !b.char(100).visible, 'no extra-scope window before a script shows it');
  assert.deepEqual(st.scopes[100].pos, saved.scopes[100].pos, 'its place is kept meanwhile');
  // a script shows it: it stands where it stood, not at its default place (SSP's Char<n>.ratio, UI §3.3)
  b.char(100).setSurface(b.defaultSurface(100));
  for (let i = 0; i < 20; i++) { b.tick(0); await new Promise(r => setImmediate(r)); }
  assert.equal(b.char(100).visible, true);
  assert.deepEqual(b.char(100).basePoint, where);
  assert.deepEqual(b.saveState().scopes[100].pos, saved.scopes[100].pos);
  b.destroy();
});

test('cold boot: cold stage state; boot failure (shell fetch fails): the loading engine is terminated and the ghost lock released',async () => {
  const { StateStore, memoryStorage } = await import('../../src/core/state.js');
  const { setLogLevel } = await import('../../src/core/log.js');
  setLogLevel('silent');
  const client = { terminated: 0, terminate() { this.terminated++; } };
  let engineReady, stageOpts;
  const lock = { held: false, released: 0, async acquire() { this.held = true; return true; }, release() { this.held = false; this.released++; } };
  class T extends mod.Runtime {
    async _start() {
      this.ghost = { id: 'g', engine: 'satori' };
      this.state = new StateStore('g', { storage: memoryStorage() });
      this.state.data.stage = { v: 1, shell: 'master', scopes: { 0: { surface: 5, pos: { rx: 0.5, ry: 1 }, binds: [], visible: false } } };
      this.lock = lock;
      await this.lock.acquire();
      await this._boot({});
    }
    async _ghostCommon() { return { files: { url: p => p }, ghostDescript: new Map(), shellId: 'master' }; }
    _startEngine() { return new Promise(r => { engineReady = () => r({ client, r: { hadSave: false } }); }); }
    _createStage(o) { stageOpts = o; return Promise.reject(new Error('shell/master/descript.txt: HTTP 404')); }
    async _loadSkin() { return { skin: {}, name: '', path: '' }; }
  }
  const rt = new T({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js' });
  await rt.start();                                   // never rejects
  assert.deepEqual(stageOpts.state.scopes[0], { visible: true, pos: { rx: 0.5, ry: 1 }, binds: [] }, 'a cold boot gets the cold stage state');
  assert.equal(lock.released, 1);
  assert.equal(lock.held, false);
  assert.equal(rt.parts, null);
  engineReady();                                      // the worker finishes loading after the failure
  await new Promise(r => setImmediate(r));
  assert.equal(client.terminated, 1);
  setLogLevel('warn');
});

test('cold boot without a stored stage: no frame draws a character before the boot script starts, however late the balloon loads (EV §2.1 #24)', { ...needs('site/ghost/tsubasa'), timeout: 60000 }, async () => {
  const { Stage } = await import('../../src/shell/stage.js');
  const { StateStore, memoryStorage } = await import('../../src/core/state.js');
  const { setLogLevel } = await import('../../src/core/log.js');
  const { FakeShiori, FakePlayer, FakeBalloons, FakeDialogs, deferred } = await import('./fakes.mjs');
  setLogLevel('silent');
  // a minimal DOM whose elements record each time they become displayed, and whether the boot script ran by then
  let started = false;
  const shown = [];
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.dataset = {}; this.children = []; this.parentNode = null; this.width = 0; this.height = 0;
      this.style = new Proxy({}, { set: (o, k, v) => { if (k === 'display' && v === '' && o.display !== '') shown.push(started); o[k] = v; return true; } });
    }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; }
    addEventListener() {} removeEventListener() {}
    attachShadow() { const r = new El('#shadow'); r.getElementById = id => r.children.find(c => c.id === id) || null; this.shadowRoot = r; return r; }
    getContext() { return { putImageData() {} }; }
  }
  const globals = ['document', 'window', 'ImageData'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  globalThis.document = { createElement: t => new El(t), body: new El('body'), documentElement: { clientWidth: 1280, clientHeight: 720 }, hidden: false, addEventListener() {}, removeEventListener() {} };
  globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
  globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  let t = 0;
  const frames = [];
  const clock = { now: () => t, requestFrame: f => frames.push(f), setTimeout: () => 0, clearTimeout() {} };
  const run = async (n = 40) => { for (let i = 0; i < n; i++) { t += 16; for (const f of frames.splice(0)) f(t); await new Promise(r => setImmediate(r)); } };
  const skin = deferred(), engine = deferred();
  const client = new FakeShiori(r => (r.id === 'OnFirstBoot' ? '\\0\\s[0]Hello\\e' : null));
  client.terminate = () => {};
  let stage = null, player = null;
  class T extends mod.Runtime {
    async _start() {
      this.ghost = { id: 'g', engine: 'satori' };
      this.state = new StateStore('g', { storage: memoryStorage() });     // a ghost never run in this browser: no stage stored
      this.lock = { async acquire() { return true; }, release() {} };
      return this._boot({});
    }
    async _ghostCommon() {
      const files = new FsFiles(GHOST);
      files.url = p => `http://s/ghost/g/${p}`;
      return { files, ghostDescript: new Map(), shellId: 'master' };
    }
    _startEngine() { return engine.promise; }
    async _createStage(o) { stage = await Stage.create({ ...o, decode: nodeDecode, clock, random: () => 0.99 }); return stage; }
    _loadSkin() { return skin.promise; }                // the balloon's PNGs take longer than the two base surfaces
    async _createBalloons() { const b = new FakeBalloons(); b.destroy = () => {}; return b; }
    _createDialogs() { return new FakeDialogs(); }
    _createPlayer() { player = new FakePlayer(); player.on('start', () => { started = true; }); return player; }
  }
  const rt = new T({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js' });
  try {
    const booted = rt.start();
    for (let i = 0; i < 1000 && !(stage && stage.char(0).image && stage.char(1).image); i++) await run(1);
    await run();                                        // more frames while the balloon still loads
    assert.ok(stage && stage.char(0).image && stage.char(1).image, 'the shell was composed while the balloon loaded');
    skin.resolve({ skin: { balloon: () => null }, name: '', path: '' });
    await run();
    engine.resolve({ client, r: { hadSave: false } });
    for (let i = 0; i < 200 && !started; i++) await run(1);
    player.finish();
    assert.equal(await booted, 'booted');
    assert.deepEqual(shown.filter(s => !s), [], 'drawn before the boot script started');
    assert.equal(shown.length, 2, 'both shown as it starts');
  } finally {
    rt._teardown();
    for (const [k, d] of globals) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    setLogLevel('warn');
  }
});

test('balloon choice (BA §1.6): the shell\'s, the stored choice, the descript keys, install.txt, then the site default', () => {
  const tsubasa = { id: 'tsubasa', balloon: 'LightBlue', bundledBalloons: [{ dir: 'LightBlue', name: 'LightBlue' }] };
  const plain = { id: 'plain', balloon: null, bundledBalloons: [] };
  // the index lists the site's balloons and the bundled ones it hoisted (`ghost`: served from that ghost's folder)
  const index = { balloons: [{ id: 'LightBlue', name: 'LightBlue', ghost: 'tsubasa' }, { id: 'other', name: 'Other' }, { id: 'sumika', name: 'Sumika' }], defaultBalloon: 'sumika' };
  const pick = (g, o = {}) => { const r = mod.chooseBalloon(index, g, o); return r && [r.entry.id, r.entry.ghost || null, r.from, !!r.isDefault]; };
  assert.deepEqual(pick(tsubasa), ['LightBlue', 'tsubasa', 'install', false], 'her own (install.txt balloon.directory)');
  assert.deepEqual(pick(tsubasa, { choice: 'other' }), ['other', null, 'choice', false], 'a stored folder id');
  assert.deepEqual(pick(tsubasa, { choice: 'Other' }), ['other', null, 'choice', false], 'an older state\'s descript name');
  assert.deepEqual(pick(tsubasa, { choice: 'gone' }), ['LightBlue', 'tsubasa', 'install', false]);
  assert.deepEqual(pick(tsubasa, { shellBalloon: 'sumika', choice: 'other' }), ['sumika', null, 'shell', false], 'the shell\'s own first');
  assert.deepEqual(pick(tsubasa, { shellBalloon: 'gone', choice: 'other' }), ['other', null, 'choice', false]);
  // descript keys come before install.txt: default.balloon.path (a folder, also as a path) before balloon (a name)
  const desc = new Map([['balloon', 'Other'], ['default.balloon.path', 'balloon\\sumika\\']]);
  assert.deepEqual(pick(tsubasa, { ghostDescript: desc }), ['sumika', null, 'descript', false]);
  assert.deepEqual(pick(tsubasa, { ghostDescript: new Map([['balloon', 'other']]) }), ['other', null, 'descript', false], 'names in any case');
  assert.deepEqual(pick(tsubasa, { ghostDescript: new Map([['balloon', 'other-folder-id']]) }), ['LightBlue', 'tsubasa', 'install', false]);
  // no balloon of its own: the site default (no choice), the page's when installed
  assert.deepEqual(pick(plain), ['sumika', null, 'default', true]);
  assert.deepEqual(pick(plain, { choice: 'gone' }), ['sumika', null, 'default', true]);
  assert.deepEqual(pick(plain, { choice: 'LightBlue' }), ['LightBlue', 'tsubasa', 'choice', false], 'one hoisted from another ghost');
  assert.deepEqual(pick(plain, { pageDefault: 'other' }), ['other', null, 'default', true], 'data-default-balloon');
  assert.deepEqual(pick(plain, { pageDefault: 'nosuch' }), ['sumika', null, 'default', true], 'a page default the site lacks');
  assert.equal(mod.chooseBalloon({ ...index, defaultBalloon: null }, plain, {}), null, 'no default: the built-in balloon');
  assert.equal(mod.chooseBalloon({ balloons: [], defaultBalloon: null }, plain, {}), null);
  // the ghost's own bundled balloon is the entry for its folder id (it loads from her files)
  assert.equal(mod.chooseBalloon({ balloons: [{ id: 'lightblue', name: 'LB elsewhere' }] }, tsubasa, {}).entry.name, 'LightBlue');
});

test('shell choice and per-shell dress-up (EV §2.6): the boot shell, the stage state a shell gets, the memory', () => {
  const ghost = { id: 'g', shells: [{ id: 'alt', name: 'Winter' }, { id: 'master', name: 'master' }, { id: 'Surface', name: 'Old' }], defaultShell: 'master' };
  const none = new Map();
  assert.equal(mod.bootShellId(ghost, none, { shell: 'alt', shellChosen: false }), 'master', 'never picked: the default');
  assert.equal(mod.bootShellId(ghost, none, { shell: 'ALT', shellChosen: true }), 'alt', 'picked and still listed (any case)');
  assert.equal(mod.bootShellId(ghost, none, { shell: 'gone', shellChosen: true }), 'master', 'picked but gone');
  assert.equal(mod.bootShellId(ghost, new Map([['seriko.defaultsurfacedirectoryname', 'surface']]), {}), 'Surface');
  assert.equal(mod.bootShellId({ id: 'x' }, none, {}), 'master');

  // a stage stored for another shell keeps places and surfaces; this shell's dress-up comes from the memory
  const saved = { v: 1, shell: 'master', scopes: { 0: { surface: 5, pos: { rx: 0.5, ry: 1 }, binds: [0, 3] }, 1: { surface: 10, binds: [] } } };
  const memory = { alt: { binds: { 0: [2] }, balloon: 'sumika' } };
  assert.equal(mod.stageStateForShell(saved, 'MASTER', memory), saved, 'the same shell: as stored');
  assert.equal(mod.stageStateForShell({ v: 1, scopes: {} }, 'alt', memory).shell, undefined, 'an old state without `shell`: as stored');
  assert.deepEqual(mod.stageStateForShell(saved, 'alt', memory), {
    v: 1, shell: 'alt', scopes: { 0: { surface: 5, pos: { rx: 0.5, ry: 1 }, binds: [2] }, 1: { surface: 10 } },
  });
  assert.deepEqual(mod.stageStateForShell(saved, 'other', memory).scopes, { 0: { surface: 5, pos: { rx: 0.5, ry: 1 } }, 1: { surface: 10 } }, 'no memory: the defaults');
  // the size a hidden scope was last shown with (`last`) belongs to the shell it was shown on
  const hidden = { v: 1, shell: 'master', scopes: { 1: { surface: -1, pos: { rx: 0.4, ry: 1 }, last: { x: 0, y: 0, w: 4, h: 4, bx: 2, by: 4 } } } };
  assert.equal(mod.stageStateForShell(hidden, 'master', memory), hidden);
  assert.deepEqual(mod.stageStateForShell(hidden, 'other', memory).scopes, { 1: { surface: -1, pos: { rx: 0.4, ry: 1 } } });
  assert.deepEqual(mod.stageStateForShell(undefined, 'Alt', memory), { v: 1, shell: 'Alt', scopes: { 0: { binds: [2] } } });
  assert.equal(mod.stageStateForShell(undefined, 'other', memory), undefined);

  // the memory records a stage's ON ids per scope (a copy; the key keeps its spelling)
  const m2 = mod.withShellBinds(memory, 'ALT', { v: 1, scopes: { 0: { binds: [1, 2] }, 1: { binds: [] }, 2: { surface: 3 } } });
  assert.deepEqual(m2, { alt: { binds: { 0: [1, 2], 1: [] }, balloon: 'sumika' } });
  assert.deepEqual(memory.alt.binds, { 0: [2] }, 'not changed in place');
  assert.deepEqual(mod.withShellBinds(null, 'master', saved), { master: { binds: { 0: [0, 3], 1: [] } } });
  assert.deepEqual(mod.withShellBinds(memory, 'master', { v: 1, scopes: { 0: { surface: 1 } } }), memory, 'no bind lists: unchanged');
  assert.deepEqual(mod.shellMemory(memory, 'ALT'), memory.alt);
  assert.equal(mod.shellMemory(memory, 'master'), null);

  // the swap's new stage: places and alpha kept, no surfaces, no alignment or scaling, the new shell's dress-up
  const old = { v: 1, shell: 'master', scopes: {
    0: { surface: 5, pos: { rx: 0.9, ry: 1 }, binds: [0], visible: true, align: 'free', scaling: [50, 50], alpha: 80 },
    1: { surface: 10, pos: null, binds: [], visible: false },
    2: { surface: 3, pos: { rx: 0.2, ry: 0.5 }, visible: true },
    3: { surface: -1, pos: { rx: 0.1, ry: 0.1 }, visible: true },
  } };
  assert.deepEqual(mod.swapStageState(old, 'alt', memory, new Map([[0, 5], [2, 3]])), {
    v: 1, shell: 'alt', scopes: {
      0: { surface: -1, pos: { rx: 0.9, ry: 1 }, alpha: 80, binds: [2] },
      1: { surface: -1, visible: false },
      2: { surface: -1, pos: { rx: 0.2, ry: 0.5 } },
      3: { pos: { rx: 0.1, ry: 0.1 } },         // not on screen: only its place, for when a script shows it
    },
  });
  assert.deepEqual(mod.swapStageState(null, 'x', {}), { v: 1, shell: 'x', scopes: { 0: { surface: -1 }, 1: { surface: -1 } } });
});

test('site balloon: the real index names Sumika\'s balloon as the default; _loadSkin gives it to a ghost without one (isDefault: not stored as her choice)', needs('site/ghost/tsubasa'), async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { StateStore, memoryStorage } = await import('../../src/core/state.js');
  const ROOT = path.resolve(GHOST, '..', '..', '..');
  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'site/sumika/index/ghosts.json'), 'utf8'));
  assert.equal(site.defaultBalloon, 'sumika');
  assert.ok(site.balloons.some(b => b.id === 'sumika'));
  assert.ok(fs.existsSync(path.join(ROOT, 'site/balloon/sumika/balloons0.png')));
  const bf = new FsFiles(path.join(ROOT, 'site/balloon/sumika'));
  bf.root = 'http://s/balloon/sumika/';
  const index = { ...site, balloon: id => site.balloons.find(b => b.id === id) || null, balloonFiles: async () => bf };
  const rt = new mod.Runtime({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js' });
  rt.index = index;
  rt.ghost = { id: 'plain', balloon: null, bundledBalloons: [] };
  rt.state = new StateStore('plain', { storage: memoryStorage() });
  const b = await rt._loadSkin(new FsFiles(GHOST));
  assert.equal(b.skin.isFallback, false);
  assert.equal(b.skin.name, 'Sumika');
  assert.deepEqual([b.id, b.name, b.path, b.isDefault, b.files], ['sumika', 'Sumika', '/balloon/sumika/', true, bf]);
  assert.equal(b.skin.balloon(0, 0, 'left').w, 335, 'SSP default balloon metrics');
  // Tsubasa keeps LightBlue, from her own files (GhostFiles.url drops a folder's trailing slash; the path keeps it)
  rt.ghost = site.ghosts.find(g => g.id === 'tsubasa');
  const gf = new FsFiles(GHOST);
  gf.url = p => `http://s/ghost/tsubasa/${p.replace(/\/+$/, '')}`;
  const t = await rt._loadSkin(gf);
  assert.deepEqual([t.skin.name, t.id, t.name, t.path, !!t.isDefault, t.from], ['LightBlue', 'LightBlue', 'LightBlue', '/ghost/tsubasa/LightBlue/', false, 'install']);
  assert.ok(t.files.has('descript.txt') && !t.files.has('LightBlue/descript.txt'), 'its own folder');
});

test('engine start: a YAYA ghost gets engines/yaya.js, its whole root (ghost-root paths, copies of the bytes) and engineOpts; Satori\'s start is unchanged', async () => {
  const te = new TextEncoder();
  const manifest = [['readme.txt', 6], ['ghost/master/descript.txt', 5], ['ghost/master/yaya.txt', 5], ['ghost/master/dic/a.dic', 5],
    ['ghost/master/yaya.dll', 5], ['ghost/master/yaya_variable.cfg', 5], ['shell/master/surface0.png', 5, 1, 1], ['ghost/master/gone.dic', 5]];
  const files = new GhostFiles('http://s/ghost/yy/', manifest);
  // GhostFiles caches one buffer per path and hands every caller the same one (here from a stand-in pack)
  files._fromPack = async p => {
    if (p === 'ghost/master/gone.dic') throw new Error('HTTP 404');
    return te.encode(p === 'readme.txt' ? 'readme' : 'x:' + p).buffer;
  };
  const started = [];
  const client = {
    // like ShioriClient.start: every files[].data is transferred, which detaches it here
    async start(o) {
      started.push({ ...o, files: o.files.map(f => ({ path: f.path, text: new TextDecoder().decode(f.data) })) });
      for (const f of o.files) structuredClone(f.data, { transfer: [f.data] });
      return { ok: true, hadSave: false, ms: 1 };
    },
    terminate() {},
  };
  const { setLogLevel } = await import('../../src/core/log.js');
  setLogLevel('silent');
  const rt = new mod.Runtime({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', Channel: null });
  rt._client = () => client;
  rt.index = {
    ghosts: [{ id: 'yy', name: 'Y Ghost', sakuraName: 'Y', keroName: 'K', craftman: 'me', shiori: 'yaya.dll', engine: 'yaya', module: 'yaya', shells: [] },
      { id: 't', name: 'T', sakuraName: 'Ts', keroName: '', craftman: 'm', shiori: 'satori.dll', engine: 'satori' }],
    balloons: [{ id: 'sumika', name: 'Sumika' }],
  };
  rt.ghost = rt.index.ghosts[0];
  rt.state = { data: { engine: { dicStamp: '0123abcd' } } };
  try {
    const r = await rt._startEngine(files, { resume: true, bootEpochMs: 42 });
    assert.equal(r.client, client);
    const o = started[0];
    assert.deepEqual({ ...o, files: undefined }, {
      engine: 'yaya', engineUrl: 'http://s/sumika/engines/yaya.js', files: undefined, resume: true, volatile: { dicStamp: '0123abcd' },
      bootEpochMs: 42, sessionEndMs: 0, storeNamespace: 'sumika', storeKey: 'ghost:yy:files',
      engineOpts: {
        module: 'yaya', ghostId: 'yy', placeholders: ['shell/master/surface0.png', 'ghost/master/gone.dic'],
        site: {
          ghosts: [{ id: 'yy', name: 'Y Ghost', sakuraName: 'Y', keroName: 'K', craftman: 'me', shiori: 'yaya.dll' },
            { id: 't', name: 'T', sakuraName: 'Ts', keroName: '', craftman: 'm', shiori: 'satori.dll' }],
          balloons: ['sumika'],
        },
      },
    });
    assert.deepEqual(o.files, [{ path: 'readme.txt', text: 'readme' }, { path: 'ghost/master/descript.txt', text: 'x:ghost/master/descript.txt' },
      { path: 'ghost/master/yaya.txt', text: 'x:ghost/master/yaya.txt' }, { path: 'ghost/master/dic/a.dic', text: 'x:ghost/master/dic/a.dic' }],
    'ghost-root paths; a file that cannot be read becomes a placeholder');
    // the buffers went to the worker as copies: the readme window still reads the ghost's own, and a crash restart
    // (_onCrash -> _startEngine) sends them again
    assert.equal(await files.text('readme.txt'), 'readme');
    await rt._startEngine(files, { resume: true, bootEpochMs: 42 });
    assert.deepEqual(started[1].files, o.files);

    // Satori: ghost/master-relative text files, no engineOpts
    const sf = new GhostFiles('http://s/ghost/t/', [['ghost/master/dic.txt', 5], ['readme.txt', 6], ['shell/master/surface0.png', 5, 1, 1]]);
    sf._fromPack = async p => te.encode('s:' + p).buffer;
    rt.ghost = rt.index.ghosts[1];
    rt.state = { data: { engine: { talkCount: 3 } } };
    await rt._startEngine(sf, { resume: false, bootEpochMs: 7 });
    assert.deepEqual(started[2], {
      engine: 'satori', engineUrl: 'http://s/sumika/engines/satori.js', files: [{ path: 'dic.txt', text: 's:ghost/master/dic.txt' }],
      resume: false, volatile: null, bootEpochMs: 7, sessionEndMs: 0, storeNamespace: 'sumika', storeKey: 'ghost:t:files', engineOpts: null,
    });
  } finally {
    setLogLevel('warn');
  }
});

test('engine start: a Kawari ghost gets engines/kawari.js, its whole root by KAWARI_TEXT (.kis with bytes; DLLs, logs, saves never) and engineOpts without module', async () => {
  const te = new TextEncoder();
  const manifest = [['readme.txt', 6], ['ghost/master/descript.txt', 5], ['ghost/master/kawarirc.kis', 5], ['ghost/master/dict/a.KIS', 5],
    ['ghost/master/enc.kaw', 5], ['ghost/master/shiori.dll', 5], ['ghost/master/kawari.log', 5], ['ghost/master/satori_savedata.txt', 5],
    ['shell/master/surface0.png', 5, 1, 1], ['shell/master/descript.txt', 5]];
  const files = new GhostFiles('http://s/ghost/kk/', manifest);
  files._fromPack = async p => te.encode('k:' + p).buffer;
  const started = [];
  const client = {
    async start(o) {
      started.push({ ...o, files: o.files.map(f => ({ path: f.path, text: new TextDecoder().decode(f.data) })) });
      return { ok: true, hadSave: true, ms: 1 };
    },
    terminate() {},
  };
  const { setLogLevel } = await import('../../src/core/log.js');
  setLogLevel('silent');
  const rt = new mod.Runtime({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', Channel: null });
  rt._client = () => client;
  rt.index = {
    ghosts: [{ id: 'kk', name: 'K Ghost', sakuraName: 'か', keroName: '', craftman: 'me', shiori: 'shiori.dll', engine: 'kawari', shells: [] },
      { id: 'y', name: 'Y', sakuraName: 'Ys', keroName: 'K', craftman: 'm', shiori: 'yaya.dll', engine: 'yaya', module: 'yaya' }],
    balloons: [{ id: 'sumika', name: 'Sumika' }],
  };
  rt.ghost = rt.index.ghosts[0];
  rt.state = { data: { engine: { dicStamp: '89abcdef' } } };
  try {
    await rt._startEngine(files, { resume: true, bootEpochMs: 9 });
    assert.deepEqual({ ...started[0], files: undefined }, {
      engine: 'kawari', engineUrl: 'http://s/sumika/engines/kawari.js', files: undefined, resume: true, volatile: { dicStamp: '89abcdef' },
      bootEpochMs: 9, sessionEndMs: 0, storeNamespace: 'sumika', storeKey: 'ghost:kk:files',
      engineOpts: {
        ghostId: 'kk', placeholders: ['shell/master/surface0.png'],
        site: {
          ghosts: [{ id: 'kk', name: 'K Ghost', sakuraName: 'か', keroName: '', craftman: 'me', shiori: 'shiori.dll' },
            { id: 'y', name: 'Y', sakuraName: 'Ys', keroName: 'K', craftman: 'm', shiori: 'yaya.dll' }],
          balloons: ['sumika'],
        },
      },
    });
    assert.equal('module' in started[0].engineOpts, false, 'no module: Kawari reads kawarirc.kis');
    assert.deepEqual(started[0].files, ['readme.txt', 'ghost/master/descript.txt', 'ghost/master/kawarirc.kis', 'ghost/master/dict/a.KIS',
      'ghost/master/enc.kaw', 'shell/master/descript.txt'].map(p => ({ path: p, text: `k:${p}` })), 'ghost-root paths');
    // a cold start sends no engine state
    rt.state = { data: { engine: null } };
    await rt._startEngine(files, { resume: false, bootEpochMs: 10 });
    assert.equal(started[1].volatile, null);
    assert.equal(started[1].engine, 'kawari');
    assert.equal(started[1].sessionEndMs, 0);
    // a cold boot's end of the ghost's last session (Runtime._boot: the state's savedAt), for D6 (kawari-wasm.md §8)
    await rt._startEngine(files, { resume: false, bootEpochMs: 10, sessionEndMs: 7 });
    assert.equal(started[2].sessionEndMs, 7);
  } finally {
    setLogLevel('warn');
  }
});

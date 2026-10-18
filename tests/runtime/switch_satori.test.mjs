// Ghost change against the real Satori build (no worker: the engine adapter runs in-process, as in
// satori_integration.test.mjs): Tsubasa <-> the synthetic test ghost (tests/fixtures/ghost/testghost). Asserts what
// Tsubasa really answers to OnGhostChanging and OnGhostChanged (EV §2.5), and that each ghost's save data comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SatoriEngine } from '../../src/worker/engines/satori.js';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { buildRequest, parseResponse } from '../../src/core/shiori.js';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { loadEngineFactory } from '../load_engine.mjs';
import { FakeClock, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';
import { needs } from '../needs.mjs';

setLogLevel('silent');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'satori.js');
const SITE = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/ghosts.json'), 'utf8'));
const GHOSTS = {
  tsubasa: { entry: SITE.ghosts.find(g => g.id === 'tsubasa'), dir: path.join(root, 'site', 'ghost', 'tsubasa', 'ghost', 'master') },
  testghost: { entry: SITE.ghosts.find(g => g.id === 'testghost'), dir: path.join(root, 'tests', 'fixtures', 'ghost', 'testghost', 'ghost', 'master') },
};
const real = needs('site/sumika/engines/satori.js', 'site/ghost/tsubasa', 'tests/fixtures/ghost/testghost');

class NodeSatori extends SatoriEngine {
  async factory() { return loadEngineFactory('satori'); }
}

function engineFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + '/');
      else if (/\.(txt|dic|sat|ini|csv|aym)$/i.test(e.name) && !/^(satori_save|updates)/i.test(e.name)) {
        const b = fs.readFileSync(p);
        out.push({ path: rel + e.name, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
      }
    }
  })(dir, '');
  return out;
}

/** ShioriClient look-alike around an in-process engine; unload() keeps the save files like the worker's store. */
class InProcessShiori {
  constructor(engine, saves) {
    this.engine = engine;
    this.saves = saves;
    this.base = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
    this.log = [];
  }
  async request(r) {
    const res = parseResponse(this.engine.request(buildRequest(r, this.base)));
    this.log.push({ method: r.method || 'GET', id: r.id, refs: r.refs || [], status: res.status, value: res.value, headers: r.headers || {} });
    Object.assign(this.saves, this.engine.changedFiles());
    return res;
  }
  async unload() { Object.assign(this.saves, this.engine.unload()); this.unloaded = true; return Object.keys(this.saves); }
  async persist() { this.engine.save(); Object.assign(this.saves, this.engine.changedFiles()); return []; }
  find(id) { return this.log.filter(x => x.id === id); }
}

const saves = { tsubasa: {}, testghost: {} };   // IndexedDB ghost:<id>:files

/** Boot one ghost as the runtime does after a change: a fresh engine on its own save files, then EventLoop.boot. */
async function bootGhost(id, { changed = null } = {}) {
  const g = GHOSTS[id];
  const engine = new NodeSatori({ engineUrl: ENGINE_JS, ghostDir: '/ghost/master/', log: () => {}, saori: saoriBridge });
  await engine.boot();
  const hadSave = Object.keys(saves[id]).length > 0;
  engine.init(engineFiles(g.dir), saves[id], { resume: false });
  const shiori = new InProcessShiori(engine, saves[id]);
  const clock = new FakeClock();
  const player = new FakePlayer();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost: g.entry, clock,
    state: new StateStore(id, { storage: memoryStorage(), clock }), env: { win: null, doc: null },
    ghostDescript: new Map([['name', g.entry.name], ['sakura.name', g.entry.sakuraName]]),
    site: { ghosts: SITE.ghosts, balloons: [] },
  });
  await loop.boot({ resume: false, firstBoot: !hadSave, changed });
  return { id, shiori, player, loop };
}

const info = id => ({ sakuraName: GHOSTS[id].entry.sakuraName, name: GHOSTS[id].entry.name, path: `/ghost/${id}/` });

/** The menu's change: OnGhostChanging plays to its end, then OnDestroy and unload; returns OnGhostChanged's previous ghost. */
async function leave(t, to) {
  if (t.player.busy) t.player.finish();
  const p = t.loop.farewell(info(to), { reason: 'manual', raiseEvent: true });
  await settle();
  if (t.player.busy) t.player.finish();
  const bye = await p;
  assert.equal(bye.ok, true);
  await t.loop.leave();
  t.loop.destroy();
  return { ...info(t.id), script: bye.script };
}

test('Tsubasa <-> test ghost on the real engine: farewells, OnGhostChanged answered (no OnBoot), memory per ghost', { ...real, timeout: 120000 }, async () => {
  const a = await bootGhost('tsubasa');
  assert.equal(a.shiori.find('OnFirstBoot')[0].status, 200);

  // Tsubasa leaves: her 他のゴーストへ変更 talk (Satori's alias of OnGhostChanging), ended by \e, not \-
  let from = await leave(a, 'testghost');
  const ch = a.shiori.find('OnGhostChanging')[0];
  assert.deepEqual(ch.refs, ['Testy', 'manual', 'Test Ghost', '/ghost/testghost/']);
  assert.equal(ch.status, 200, 'Tsubasa answers OnGhostChanging');
  assert.ok(!a.shiori.find('OnClose').length, 'so no OnClose');
  assert.match(from.script, /Testy-san|take her leave|Have a good time|You're going out|Master/, from.script);
  assert.doesNotMatch(from.script, /\\-/);
  assert.ok(a.shiori.find('OnDestroy').length && a.shiori.unloaded);
  assert.ok(saves.tsubasa['satori_savedata.txt'], 'her save data is stored on the way out');

  // the test ghost has never been here: OnFirstBoot (it sets its counter to 10)
  const b = await bootGhost('testghost', { changed: from });
  assert.deepEqual(b.shiori.log.filter(r => /^On(FirstBoot|Boot|GhostChanged)$/.test(r.id)).map(r => `${r.id}:${r.status}`), ['OnFirstBoot:200']);
  assert.match(b.player.last.script, /Hello, I am Testy\. First boot\./);
  from = await leave(b, 'tsubasa');
  assert.match(from.script, /Testy hands over to Tsubasa, manual\./);

  // back to Tsubasa: she has save data, so OnGhostChanged, which she answers (no OnBoot fallback)
  const a2 = await bootGhost('tsubasa', { changed: from });
  const got = a2.shiori.find('OnGhostChanged')[0];
  assert.deepEqual(got.refs.slice(0, 4), ['Testy', from.script, 'Test Ghost', '/ghost/testghost/']);
  assert.equal(got.refs[7], 'master');
  assert.equal(got.status, 200, 'Tsubasa answers OnGhostChanged');
  assert.ok(!a2.shiori.find('OnBoot').length && !a2.shiori.find('OnFirstBoot').length);
  assert.ok(a2.player.last && a2.player.last.script.length > 0);
  from = await leave(a2, 'testghost');

  // and to the test ghost again: its own memory (10 from the first boot, +1)
  const b2 = await bootGhost('testghost', { changed: from });
  assert.equal(b2.shiori.find('OnGhostChanged')[0].status, 200);
  assert.match(b2.player.last.script, /\\0Testy takes over from Tsubasa\. Change (?:11|１１)\./, 'Satori writes numbers full-width');
  await b2.loop.leave();
  b2.loop.destroy();
});

test('Tsubasa\'s own random change talk ends in \\![change,ghost,random], which asks the runtime without OnGhostChanging', { ...real, timeout: 120000 }, async () => {
  const t = await bootGhost('tsubasa');
  const r = await t.shiori.request({ method: 'GET', id: 'ランダムで交替', refs: [], headers: {} });
  assert.equal(r.status, 200);
  assert.match(r.value, /\\!\[change,ghost,random\]/);
  const asked = [];
  t.loop.on('change', x => asked.push(x));
  t.loop.change('ghost', ['random']);
  assert.deepEqual(asked.map(x => [x.target, x.raiseEvent, x.fromScript]), [['random', false, true]]);
  await t.loop.leave();
  t.loop.destroy();
});

// The event loop against the real Satori build with Tsubasa's dictionaries (no worker: the engine adapter is driven
// directly). Checks that what the runtime sends gets the answers Tsubasa's P0 features depend on.
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
import { menuResourceIds, buildMenuModel, parseCaption } from '../../src/ui/menu.js';
import { loadEngineFactory } from '../load_engine.mjs';
import { FakeClock, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, FakeWindow, keyEvent, settle } from './fakes.mjs';
import { needs } from '../needs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GHOST_DIR = path.join(root, 'site', 'ghost', 'tsubasa', 'ghost', 'master');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'satori.js');
const real = needs('site/sumika/engines/satori.js', 'site/ghost/tsubasa');
const GHOST = { id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };

class NodeSatori extends SatoriEngine {
  async factory() { return loadEngineFactory('satori'); }
}

function engineFiles() {
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
  })(GHOST_DIR, '');
  return out;
}

/** ShioriClient look-alike around an in-process engine. */
class InProcessShiori {
  constructor(engine) {
    this.engine = engine;
    this.base = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
    this.log = [];
  }
  async request(r) {
    const res = parseResponse(this.engine.request(buildRequest(r, this.base)));
    this.log.push({ method: r.method || 'GET', id: r.id, refs: r.refs || [], status: res.status, value: res.value });
    return res;
  }
  async unload() { return this.engine.unload(); }
  async persist() { this.engine.save(); return this.engine.changedFiles(); }
}

async function startEngine(persisted = {}, resume = false) {
  const e = new NodeSatori({ engineUrl: ENGINE_JS, ghostDir: '/ghost/master/', log: () => {}, saori: saoriBridge });
  await e.boot();
  e.init(engineFiles(), persisted, { resume });
  return e;
}

function makeLoop(shiori, { state, win = null } = {}) {
  const clock = new FakeClock();
  const player = new FakePlayer();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost: GHOST,
    state: state || new StateStore('tsubasa', { storage: memoryStorage(), clock }), clock, env: { win, doc: null },
    ghostDescript: new Map([['name', 'Hayama-san Next Door'], ['sakura.name', 'Tsubasa']]), site: { ghosts: [GHOST], balloons: [] },
  });
  return { loop, player, clock };
}

test('Tsubasa on the real engine: first boot, first-meeting choice, resume without a boot, menu, keys', { ...real, timeout: 120000 }, async () => {
  const engine = await startEngine();
  const shiori = new InProcessShiori(engine);
  const win = new FakeWindow();
  const { loop, player, clock } = makeLoop(shiori, { win });
  await loop.boot({ resume: false, firstBoot: true });
  const first = shiori.log.find(r => r.id === 'OnFirstBoot');
  assert.equal(first.status, 200, 'Tsubasa defines OnFirstBoot');
  assert.ok(!shiori.log.some(r => r.id === 'OnBoot'), 'no OnBoot after a first boot that talked');
  assert.ok(shiori.log.some(r => r.id === 'OnTranslate'));
  assert.equal(player.plays.length, 1);
  assert.match(player.plays[0].script, /\\q\[|\\__q\[/, 'the first meeting asks a question');
  assert.doesNotMatch(player.plays[0].script, /（dsaudio|（aya/, 'SAORI calls do not leak');
  const hwnd = shiori.log.find(r => r.id === 'hwnd');
  assert.ok(hwnd && hwnd.status < 500);
  player.finish({ hasChoices: true });
  await settle();

  // the first-meeting choice, as Satori wrote its ID (id\x01label\x01n) or a plain one
  const ch = /\\q\[([^,\]]*),([^\]]*)\]/.exec(player.plays[0].script) || /\\__q\[([^\]]*)\]/.exec(player.plays[0].script);
  assert.ok(ch, 'a choice is offered');
  player.emit('link', { kind: 'choice', id: ch[2] ?? ch[1], label: ch[2] ? ch[1] : '', refs: [], scope: 0 });
  await settle();
  const sel = shiori.log.filter(r => /^OnChoiceSelect/.test(r.id)).map(r => `${r.id}:${r.status}`);
  assert.deepEqual(sel, ['OnChoiceSelectEx:204', 'OnChoiceSelect:200']);
  assert.equal(player.plays.length, 2);
  player.finish();
  await settle();

  // ticks reach Satori as GET while she can talk
  await clock.advance(3100);
  const ticks = shiori.log.filter(r => r.id === 'OnSecondChange');
  assert.ok(ticks.length >= 3);
  assert.ok(ticks.every(r => r.status < 500));

  // menu resources: her captions and site lists build a menu
  const res = await loop.resources(menuResourceIds(0), { timeoutMs: 5000 });
  const model = buildMenuModel(0, res);
  const labels = model.filter(i => i.kind !== 'sep').map(i => parseCaption(i.label).text);
  assert.ok(labels.length >= 4, labels.join(' | '));
  const rec = model.find(i => i.kind === 'sub' && i.items.some(x => x.action && x.action.kind === 'recommend'));
  assert.ok(rec && rec.items.length > 10, 'her recommended sites');
  assert.ok(model.some(i => i.action && i.action.type === 'iconify'));
  assert.ok(!labels.some(l => /talk/i.test(l)));

  // a shortcut key: 'm' opens her main menu (OnKeyPress R0 m, R2 1)
  loop.stage.emit('mouse', { type: 'down', scope: 0, x: 100, y: 100, button: 0, collision: '', device: 'mouse' });
  await settle();
  const before = player.plays.length;
  win.dispatch('keydown', keyEvent('KeyM', 'm', { keyCode: 77 }));
  await settle();
  const kp = shiori.log.find(r => r.id === 'OnKeyPress');
  assert.deepEqual(kp.refs, ['m', 77, 1, 0, '']);
  assert.equal(kp.status, 200, 'the m shortcut answers');
  assert.equal(player.plays.length, before + 1);

  // page navigation: save, new engine resumed from the save data, no OnBoot
  const saved = await shiori.persist();
  const persisted = { ...saved };
  assert.ok(persisted['satori_savedata.txt']);
  loop.destroy();
  const engine2 = await startEngine(persisted, true);
  const shiori2 = new InProcessShiori(engine2);
  const { loop: loop2, player: player2 } = makeLoop(shiori2);
  await loop2.boot({ resume: true });
  assert.ok(!shiori2.log.some(r => /^On(First)?Boot$/.test(r.id)));
  assert.equal(player2.plays.length, 0, 'a resume says nothing');
  loop2.destroy();
});

test('dsaudio stand-in: her volume buttons call （dsaudio,volume,n） inline and nothing leaks into the balloon', { ...real, timeout: 120000 }, async () => {
  const engine = await startEngine();
  const shiori = new InProcessShiori(engine);
  for (const id of ['ボリュームアップ', 'ボリュームダウン']) {
    const r = await shiori.request({ method: 'GET', id, refs: [], headers: {} });
    assert.equal(r.status, 200, id);
    assert.match(r.value, /Volume/, id);
    assert.doesNotMatch(r.value, /^\1\d/, `${id}: the volume number is not shown`);
  }
  engine.unload();
});

// The event loop against the real YAYA build with the synthetic tests/fixtures/ghost/yayatest (no worker: the engine
// adapter is driven in-process, its reports kept as the worker keeps them). A first meeting, a menu and a choice, random
// talk, the communicate box, Close with its save, then the next page's resume and a later cold boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YayaEngine } from '../../src/worker/engines/yaya.js';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { yayaFilePlan, yayaSite } from '../../src/core/engine-files.js';
import { GhostFiles } from '../../src/core/loader.js';
import { buildRequest, parseResponse } from '../../src/core/shiori.js';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { loadEngineFactory } from '../load_engine.mjs';
import { FakeClock, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';

globalThis.self = globalThis.self || { postMessage() {} };      // worker.js touches self at import
const { mergeFiles, hasSave } = await import('../../src/worker/worker.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'yaya.js');
const FIXTURE = path.join(root, 'tests', 'fixtures', 'ghost', 'yayatest');
const GHOST = {
  id: 'yayatest', name: 'YAYA Test', sakuraName: 'Yayako', keroName: 'Kero', craftman: 'Sumika tests', shiori: 'yaya.dll',
  engine: 'yaya', module: 'yaya', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }], bundledBalloons: [], balloon: null,
};
const OTHER = { id: 'other', name: 'Other Ghost', sakuraName: 'Oto', keroName: '', shiori: 'satori.dll', engine: 'satori' };
const SITE = { ghosts: [GHOST, OTHER], balloons: [] };

class NodeYaya extends YayaEngine {
  async factory() { return loadEngineFactory('yaya'); }
}

/** What the runtime sends the worker for the fixture: bytes for text, placeholders for the rest (yayaFilePlan). */
function ghostFiles() {
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else list.push([rel + e.name, fs.statSync(path.join(d, e.name)).size]);
    }
  })(FIXTURE, '');
  const plan = yayaFilePlan(new GhostFiles('mem:/yayatest/', list));
  const files = plan.bytes.map(p => {
    const b = fs.readFileSync(path.join(FIXTURE, p));
    return { path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  });
  return { files, placeholders: plan.placeholders };
}

/** ShioriClient look-alike around an in-process engine; `stored` follows every report as worker.js's store does. */
class InProcessShiori {
  constructor(engine, stored) {
    this.engine = engine;
    this.stored = mergeFiles(stored, engine.changedFiles());
    this.base = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
    this.log = [];
  }
  async request(r) {
    const res = parseResponse(this.engine.request(buildRequest(r, this.base)));
    this.stored = mergeFiles(this.stored, this.engine.changedFiles());
    this.log.push({ method: r.method || 'GET', id: r.id, refs: r.refs || [], status: res.status, value: res.value });
    return res;
  }
  async unload() {
    const files = this.engine.unload();
    this.stored = mergeFiles(this.stored, files);
    return files;
  }
  async persist() {
    this.engine.save();
    const files = this.engine.changedFiles();
    this.stored = mergeFiles(this.stored, files);
    return files;
  }
  find(id, method) { return this.log.filter(r => r.id === id && (!method || r.method === method)); }
}

/** The worker's init: the engine, the visitor's files, resume only with a save, the stored engine state. */
async function startEngine(stored = {}, { resume = false, volatile = null } = {}) {
  assert.ok(fs.existsSync(ENGINE_JS), 'site/sumika/engines/yaya.js is missing: run python engines/yaya/build.py');
  const { files, placeholders } = ghostFiles();
  const e = new NodeYaya({
    engineUrl: ENGINE_JS, log: () => {}, saori: saoriBridge,
    opts: { module: GHOST.module, ghostId: GHOST.id, placeholders, site: yayaSite(SITE), lang: 'en-US' },
  });
  await e.boot();
  const ok = e.init(files, stored, { resume: resume && hasSave(stored), bootEpochMs: Date.now(), volatile: resume ? volatile : null });
  assert.equal(ok, true);
  return new InProcessShiori(e, stored);
}

function makeLoop(shiori, clock = new FakeClock()) {
  const player = new FakePlayer();
  const dialogs = new FakeDialogs();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs, ghost: GHOST,
    state: new StateStore(GHOST.id, { storage: memoryStorage(), clock }), clock, env: { win: null, doc: null },
    ghostDescript: new Map([['name', GHOST.name], ['sakura.name', GHOST.sakuraName], ['kero.name', GHOST.keroName]]), site: SITE,
  });
  return { loop, player, dialogs, clock };
}

const ask = async (shiori, ...refs) => (await shiori.request({ method: 'GET', id: 'OnTest', refs })).value;
/** variable name -> its line in the stored save (YAYA's `name,value,"delimiter",` lines) */
const saveVars = stored => {
  const b = stored['ghost/master/yaya_variable.cfg'];
  assert.ok(b, 'a save is stored');
  return new Map(new TextDecoder().decode(b).split(/\r?\n/).filter(l => l && !l.startsWith('//')).map(l => [l.slice(0, l.indexOf(',')), l]));
};

test('a YAYA ghost on the event loop: first meeting, menu, talk, communicate, Close and save, resume, cold boot', { timeout: 120000 }, async () => {
  // ---- a first meeting: the NOTIFY batch reaches the engine, OnFirstBoot plays
  const shiori = await startEngine();
  const { loop, player, dialogs, clock } = makeLoop(shiori);
  assert.equal(hasSave(shiori.stored), false, 'no save yet: a first meeting');
  await loop.boot({ resume: false, firstBoot: true });
  const notified = shiori.find('installedghostname', 'NOTIFY');
  assert.deepEqual(notified.map(r => r.refs), [['YAYA Test', 'Other Ghost']]);
  assert.equal(await ask(shiori, 'eval', 'installed'), 'YAYA Test,Other Ghost', 'the engine kept what the NOTIFY said');
  const first = shiori.find('OnFirstBoot');
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 200);
  assert.equal(shiori.find('OnBoot').length, 0);
  assert.equal(player.plays.length, 1);
  assert.match(player.plays[0].script, /Nice to meet you\. I am Yayako\./);
  player.finish();
  await settle();

  // ---- a double-click opens her menu; a choice gets its reply
  loop.stage.emit('mouse', { type: 'dblclick', scope: 0, x: 50, y: 50, button: 0, collision: '', device: 'mouse' });
  await settle();
  assert.equal(shiori.find('OnMouseDoubleClick')[0].status, 200);
  assert.match(player.last.script, /\\q\[Talk,talk\]/);
  player.finish({ hasChoices: true });
  await settle();
  player.emit('link', { kind: 'choice', id: 'talk', label: 'Talk', refs: [], scope: 0 });
  await settle();
  const sel = shiori.find('OnChoiceSelect');
  assert.equal(sel.length, 1);
  assert.equal(sel[0].refs[0], 'talk');
  assert.match(player.last.script, /Let us talk\./);
  player.finish();
  await settle();

  // ---- random talk: every 5th OnSecondChange talks
  const before = player.plays.length;
  await clock.advance(5100);
  const ticks = shiori.find('OnSecondChange', 'GET');
  assert.ok(ticks.length >= 5, String(ticks.length));
  assert.equal(player.plays.length, before + 1);
  assert.match(player.last.script, /^\\0\\s\[0\]Tick \d+\.\\e$/);
  player.finish();
  await settle();

  // ---- the communicate box
  loop.openBox('communicatebox', []);
  await settle();
  const box = dialogs.boxes.find(b => b.kind === 'communicate');
  assert.ok(box);
  box.o.onSend('hello');
  await settle();
  assert.deepEqual(shiori.find('OnCommunicate').map(r => r.refs), [['user', 'hello']]);
  assert.match(player.last.script, /You said: hello/);
  player.finish();
  box.resolve({ text: null, timedOut: false });
  await settle();

  // ---- a SAORI in `dll`, a mid-session save holds it; Close: OnClose's \- unloads, and the save loses it
  assert.equal(await ask(shiori, 'saori'), 'loadlib 1, SAORI/1.0 200 OK');
  await shiori.persist();
  assert.match(saveVars(shiori.stored).get('dll'), /saori\/gomi\.dll/);
  const vol = shiori.engine.getVolatileState();
  const ticksSaved = await ask(shiori, 'eval', 'ticks');
  await loop.close(0);
  await settle();
  assert.equal(shiori.find('OnClose')[0].status, 200);
  assert.match(player.last.script, /Goodbye\.\\-$/);
  player.finish({ reason: 'quit' });
  await settle();
  assert.equal(loop.closed, true);
  assert.equal(shiori.find('OnDestroy', 'NOTIFY').length, 1);
  const saved = saveVars(shiori.stored);
  assert.ok(saved.has('lastunload'), 'unload stamped the time');
  assert.equal(saved.has('dll'), false, 'unload erased dll');
  assert.match(saved.get('boots'), /^boots,1,/);
  loop.destroy();

  // ---- the next page resumes from the stored files: no boot event, no boot counted
  const stored = shiori.stored;
  const shiori2 = await startEngine(stored, { resume: true, volatile: vol });
  const { loop: loop2, player: player2 } = makeLoop(shiori2);
  const firstBoot = !hasSave(stored);
  assert.equal(firstBoot, false);
  await loop2.boot({ resume: true, firstBoot });
  assert.equal(shiori2.log.filter(r => /^On(First)?Boot$/.test(r.id)).length, 0);
  assert.equal(player2.plays.length, 0, 'a resume says nothing');
  assert.equal(await ask(shiori2, 'boots'), '1');
  assert.equal(await ask(shiori2, 'eval', 'ticks'), ticksSaved, 'the talk counter goes on');
  loop2.destroy();

  // ---- a cold boot later (a new tab): OnBoot, not OnFirstBoot, and the boot counts
  const shiori3 = await startEngine(shiori2.stored);
  const { loop: loop3, player: player3 } = makeLoop(shiori3);
  await loop3.boot({ resume: false, firstBoot: !hasSave(shiori2.stored) });
  assert.equal(shiori3.find('OnFirstBoot').length, 0);
  assert.equal(shiori3.find('OnBoot')[0].status, 200);
  assert.match(player3.plays[0].script, /Welcome back\./);
  assert.equal(await ask(shiori3, 'boots'), '2');
  loop3.destroy();
});

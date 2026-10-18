// A Kawari ghost from the page to the engine (kawari-wasm.md §13): the registration (SUPPORTED_ENGINES, ENGINES,
// Kawari 7 beside it), the runtime's own start (Runtime._startEngine: engines/kawari.js, the root plan by KAWARI_TEXT,
// engineOpts without module) booting the registry's engine on the real build with our Shift_JIS fixture
// tests/fixtures/ghost/kawaritest, and the event loop on it (no worker: the engine is driven in-process, its reports
// kept as the worker keeps them): a first meeting, a menu choice, the communicate box in Japanese, a page change that
// resumes from the entry snapshot (no OnBoot, the counters kept though the ghost saved nothing), Close with the save
// OnUnload writes, the next page's resume, a later cold boot, and a tab closed without Close (D6); a minimized ghost's
// Quit on a variant that saves in OnClose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../../src/core/runtime.js';
import { ENGINES } from '../../src/worker/engines/index.js';
import { SUPPORTED_ENGINES, engineSupported, engineNote } from '../../src/worker/engines/supported.js';
import { KawariEngine, RESUME_KEY, snapshotStamp, D6_FINISHED } from '../../src/worker/engines/kawari.js';
import { Kawari7Engine } from '../../src/worker/engines/kawari7.js';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { KAWARI_TEXT, KAWARI7_TEXT, KAWARI_SKIP, rootEngine } from '../../src/core/engine-files.js';
import { GhostFiles } from '../../src/core/loader.js';
import { buildRequest, parseResponse } from '../../src/core/shiori.js';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { loadEngineFactory } from '../load_engine.mjs';
import { FakeClock, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';

globalThis.self = globalThis.self || { postMessage() {} };      // worker.js touches self at import
const { mergeFiles, hasSave } = await import('../../src/worker/worker.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'kawari.js');
const FIXTURE = path.join(root, 'tests', 'fixtures', 'ghost', 'kawaritest');
const GHOST = {
  id: 'kawaritest', name: 'Kawari Test', sakuraName: 'かわり', keroName: 'ケロ', craftman: 'Sumika tests', shiori: 'shiori.dll',
  engine: 'kawari', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }], bundledBalloons: [], balloon: null,
};
const OTHER = { id: 'other', name: 'Other Ghost', sakuraName: 'おと', keroName: '', craftman: 'Zoë', shiori: 'satori.dll', engine: 'satori' };
const SITE = { ghosts: [GHOST, OTHER], balloons: [{ id: 'sumika', name: 'Sumika' }] };
const sjis = new TextDecoder('shift_jis');

test('registration: Kawari and Kawari 7 run (page list = worker registry); both get the root plan', () => {
  assert.ok(SUPPORTED_ENGINES.includes('kawari'));
  assert.deepEqual([...SUPPORTED_ENGINES].sort(), Object.keys(ENGINES).sort());
  assert.equal(ENGINES.kawari, KawariEngine);
  assert.equal(engineSupported(GHOST), true);
  assert.equal(engineSupported({ engine: 'KAWARI' }), true, 'any case');
  assert.equal(engineNote(GHOST), null);
  assert.equal(ENGINES.kawari7, Kawari7Engine);
  assert.equal(engineSupported({ engine: 'kawari7', shiori: 'shiori.dll' }), true);
  assert.equal(engineNote({ engine: 'kawari7', shiori: 'shiori.dll' }), null);
  assert.deepEqual(rootEngine('kawari'), { text: KAWARI_TEXT, skip: KAWARI_SKIP });
  assert.deepEqual(rootEngine('kawari7'), { text: KAWARI7_TEXT, skip: KAWARI_SKIP });
});

/** The fixture as the site serves it: a GhostFiles over its manifest, reading the bytes from disk. */
function siteFiles() {
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else list.push([rel + e.name, fs.statSync(path.join(d, e.name)).size]);
    }
  })(FIXTURE, '');
  const gf = new GhostFiles('http://s/ghost/kawaritest/', list);
  gf._fromPack = async p => {
    const b = fs.readFileSync(path.join(FIXTURE, p));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  return gf;
}

/** What the page sends the worker for this ghost: Runtime._startEngine's ShioriClient.start options. */
async function pageStart({ resume = false, volatile = null } = {}) {
  let o = null;
  const rt = new Runtime({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', Channel: null });
  rt._client = () => ({ async start(x) { o = x; return { ok: true, hadSave: false, ms: 1 }; }, terminate() {} });
  rt.index = SITE;
  rt.ghost = GHOST;
  rt.state = { data: { engine: volatile } };
  await rt._startEngine(siteFiles(), { resume, bootEpochMs: Date.now() });
  return o;
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

/**
 * `edits` {path: [[from, to], …]}: a variant of a fixture file in the start options, each pair replaced once on its
 * bytes read as latin1 (kawari_engine.test.mjs `edited()`); every `from` must be there.
 */
function applyEdits(files, edits) {
  for (const [p, pairs] of Object.entries(edits)) {
    const f = files.find(x => x.path === p);
    assert.ok(f, `${p} is in the start options`);
    let t = Buffer.from(f.data).toString('latin1');
    for (const [from, to] of pairs) {
      assert.ok(t.includes(from), `${p} has ${JSON.stringify(from)}`);
      t = t.replace(from, to);
    }
    const b = Buffer.from(t, 'latin1');
    f.data = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}

/**
 * The page's start, then the worker's init on it: the registry's engine (ENGINES[engine], its module loaded in Node),
 * the visitor's files, resume only with a save, the stored engine state on a resume; `edits`: applyEdits.
 */
async function startEngine(stored = {}, { resume = false, volatile = null, edits = null } = {}) {
  assert.ok(fs.existsSync(ENGINE_JS), 'site/sumika/engines/kawari.js is missing: run python engines/kawari/build.py');
  const o = await pageStart({ resume, volatile });
  if (edits) applyEdits(o.files, edits);
  const logs = [];
  class InNode extends ENGINES[o.engine] {
    async factory() { return loadEngineFactory(o.engine); }
  }
  const e = new InNode({ engineUrl: ENGINE_JS, ghostDir: o.ghostDir, log: (level, text) => logs.push({ level, text }), saori: saoriBridge, opts: o.engineOpts });
  await e.boot();
  const ok = e.init(o.files, stored, { resume: o.resume && hasSave(stored), bootEpochMs: o.bootEpochMs, volatile: o.resume ? o.volatile || null : null });
  assert.equal(ok, true, JSON.stringify(logs));
  const shiori = new InProcessShiori(e, stored);
  shiori.logs = logs;
  return shiori;
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

/** A word of the ghost's dictionary (GET ShioriEcho evaluates Reference0: the fixture says `debugger on`). */
const word = async (shiori, name) => {
  const r = await shiori.request({ method: 'GET', id: 'ShioriEcho', refs: [`\${${name}}`] });
  return r.status === 200 ? String(r.value).replace(/\\e$/, '') : `status ${r.status}`;
};
const infos = shiori => shiori.logs.filter(l => l.level === 'info').map(l => l.text);
const saveText = stored => {
  const b = stored['ghost/master/save.txt'];
  assert.ok(b, 'save.txt is stored');
  return sjis.decode(b);
};

test('the page starts a Kawari ghost: engines/kawari.js, the whole root by KAWARI_TEXT, engineOpts {ghostId, placeholders, site}', async () => {
  setLogLevel('silent');
  try {
    const o = await pageStart();
    assert.equal(o.engine, 'kawari');
    assert.equal(o.engineUrl, 'http://s/sumika/engines/kawari.js');
    assert.deepEqual(o.files.map(f => f.path).sort(), [
      'ghost/master/data/lines.txt', 'ghost/master/data/shipped.txt', 'ghost/master/descript.txt', 'ghost/master/dict-event.kis',
      'ghost/master/dict-test.kis', 'ghost/master/kawarirc.kis', 'install.txt', 'readme.txt', 'shell/master/descript.txt',
    ]);
    assert.deepEqual(o.engineOpts, {
      ghostId: 'kawaritest', placeholders: ['shell/master/surface0.png'],
      site: {
        ghosts: [
          { id: 'kawaritest', name: 'Kawari Test', sakuraName: 'かわり', keroName: 'ケロ', craftman: 'Sumika tests', shiori: 'shiori.dll' },
          { id: 'other', name: 'Other Ghost', sakuraName: 'おと', keroName: '', craftman: 'Zoë', shiori: 'satori.dll' },
        ],
        balloons: ['sumika'],
      },
    });
    assert.equal('module' in o.engineOpts, false, 'Kawari has no module');
  } finally {
    setLogLevel('warn');
  }
});

test('a Kawari ghost on the event loop: first meeting, menu, communicate, page change, Close and OnUnload\'s save, resume, cold boot, a tab closed without Close', { timeout: 120000 }, async () => {
  setLogLevel('silent');
  try {
    // ---- a first meeting: the NOTIFY batch reaches the engine, OnFirstBoot plays and counts
    const shiori = await startEngine();
    const { loop, player, dialogs } = makeLoop(shiori);
    assert.equal(hasSave(shiori.stored), false, 'nothing stored: a first meeting');
    await loop.boot({ resume: false, firstBoot: true });
    assert.deepEqual(shiori.find('installedghostname', 'NOTIFY').map(r => r.refs), [['Kawari Test', 'Other Ghost']]);
    assert.equal(await word(shiori, 'installed'), 'Kawari Test,Other Ghost', 'the engine kept what the NOTIFY said');
    assert.equal(shiori.find('OnFirstBoot')[0].status, 200);
    assert.equal(shiori.find('OnBoot').length, 0);
    assert.equal(player.plays.length, 1);
    assert.match(player.plays[0].script, /はじめまして、かわりです。\\1\\s\[10\]ケロだよ。/);
    player.finish();
    await settle();

    // ---- a double-click opens its menu; a choice gets its reply (Japanese both ways through Kawari's Shift_JIS)
    loop.stage.emit('mouse', { type: 'dblclick', scope: 0, x: 50, y: 50, button: 0, collision: '', device: 'mouse' });
    await settle();
    assert.equal(shiori.find('OnMouseDoubleClick')[0].status, 200);
    assert.match(player.last.script, /\\q\[お話し,talk\]/);
    player.finish({ hasChoices: true });
    await settle();
    player.emit('link', { kind: 'choice', id: 'talk', label: 'お話し', refs: [], scope: 0 });
    await settle();
    assert.deepEqual(shiori.find('OnChoiceSelect').map(r => r.refs[0]), ['talk']);
    assert.match(player.last.script, /お話ししましょう。1回目です。/);
    player.finish();
    await settle();

    // ---- the communicate box, in Japanese (characters with 0x5C trail bytes and NEC/IBM extensions)
    loop.openBox('communicatebox', []);
    await settle();
    const box = dialogs.boxes.find(b => b.kind === 'communicate');
    assert.ok(box);
    box.o.onSend('こんにちは、ソ表①～髙');
    await settle();
    assert.deepEqual(shiori.find('OnCommunicate').map(r => r.refs), [['user', 'こんにちは、ソ表①～髙']]);
    assert.match(player.last.script, /「こんにちは、ソ表①～髙」ですね。/);
    player.finish();
    box.resolve({ text: null, timedOut: false });
    await settle();

    // ---- a page change: the worker's save stores the entry snapshot (the ghost itself saved nothing yet)
    await shiori.persist();
    const snap = shiori.stored[RESUME_KEY];
    assert.ok(snap && snap.byteLength > 0, 'the snapshot is stored');
    assert.equal(snapshotStamp(snap), shiori.engine.dicStamp);
    assert.equal(shiori.stored['ghost/master/save.txt'], undefined, 'OnUnload has not run');
    const vol = shiori.engine.getVolatileState();
    assert.deepEqual(vol, { dicStamp: shiori.engine.dicStamp });
    loop.destroy();

    const page2 = await startEngine(shiori.stored, { resume: true, volatile: vol });
    assert.equal(page2.engine.resumed, 'restored');
    const p2 = makeLoop(page2);
    await p2.loop.boot({ resume: true, firstBoot: !hasSave(shiori.stored) });
    assert.equal(page2.log.filter(r => /^On(First)?Boot$/.test(r.id)).length, 0, 'a resume sends no boot event');
    assert.equal(p2.player.plays.length, 0, 'and says nothing');
    assert.equal(await word(page2, 'boots'), '1');
    assert.equal(await word(page2, 'talks'), '1', 'the counter came back from the snapshot');
    assert.equal(await word(page2, 'lastword'), 'こんにちは、ソ表①～髙');

    // ---- another talk, then Close: OnClose's \- unloads, OnUnload writes save.txt, the snapshot key turns into the
    // empty marker (met, nothing to restore)
    p2.loop.stage.emit('mouse', { type: 'dblclick', scope: 0, x: 50, y: 50, button: 0, collision: '', device: 'mouse' });
    await settle();
    p2.player.finish({ hasChoices: true });
    await settle();
    p2.player.emit('link', { kind: 'choice', id: 'talk', label: 'お話し', refs: [], scope: 0 });
    await settle();
    assert.match(p2.player.last.script, /お話ししましょう。2回目です。/);
    p2.player.finish();
    await settle();
    await p2.loop.close(0);
    await settle();
    assert.equal(page2.find('OnClose')[0].status, 200);
    assert.match(p2.player.last.script, /さようなら。\\-$/);
    p2.player.finish({ reason: 'quit' });
    await settle();
    assert.equal(p2.loop.closed, true);
    const saved = saveText(page2.stored);
    assert.match(saved, /^# Kawari saved file\r$/m, 'Kawari\'s own save format');
    assert.match(saved, /^boots : "1"\r$/m);
    assert.match(saved, /^talks : "2"\r$/m, 'written as on Windows (CRLF)');
    assert.match(saved, /^lastword : "こんにちは、ソ表①～髙"\r$/m, 'in code page 932');
    assert.equal(page2.stored[RESUME_KEY].byteLength, 0, 'the empty marker');
    p2.loop.destroy();

    // ---- the next page resumes from the stored files: nothing to restore, kawarirc.kis loads save.txt; no boot event
    const page3 = await startEngine(page2.stored, { resume: true, volatile: page2.engine.getVolatileState() });
    assert.equal(page3.engine.resumed, '', 'the marker: nothing to restore');
    const p3 = makeLoop(page3);
    await p3.loop.boot({ resume: true, firstBoot: !hasSave(page2.stored) });
    assert.equal(page3.log.filter(r => /^On(First)?Boot$/.test(r.id)).length, 0);
    assert.equal(p3.player.plays.length, 0);
    assert.equal(await word(page3, 'boots'), '1');
    assert.equal(await word(page3, 'talks'), '2', 'from the ghost\'s own save');
    p3.loop.destroy();

    // ---- a cold boot later (a new tab): OnBoot, not OnFirstBoot (the marker counts as met), and the boot counts
    const page4 = await startEngine(page3.stored);
    assert.equal(page4.engine.resumed, '');
    const p4 = makeLoop(page4);
    const firstBoot = !hasSave(page3.stored);
    assert.equal(firstBoot, false);
    await p4.loop.boot({ resume: false, firstBoot });
    assert.equal(page4.find('OnFirstBoot').length, 0);
    assert.equal(page4.find('OnBoot')[0].status, 200);
    assert.match(p4.player.plays[0].script, /おかえりなさい。2回目の起動です。/);
    p4.player.finish();
    await settle();

    // ---- a talk, the worker's save, then the tab closes without Close: the next cold boot first closes that session
    // from its snapshot as ssp.exe closes one Windows ends (OnCloseAll / OnClose "system", inside the worker), then
    // OnUnload saves the talk, then it boots (D6 [decision: kawari-wasm.md §16])
    p4.loop.stage.emit('mouse', { type: 'dblclick', scope: 0, x: 50, y: 50, button: 0, collision: '', device: 'mouse' });
    await settle();
    p4.player.finish({ hasChoices: true });
    await settle();
    p4.player.emit('link', { kind: 'choice', id: 'talk', label: 'お話し', refs: [], scope: 0 });
    await settle();
    assert.match(p4.player.last.script, /お話ししましょう。3回目です。/);
    p4.player.finish();
    await settle();
    await page4.persist();
    assert.ok(page4.stored[RESUME_KEY].byteLength > 0);
    assert.match(saveText(page4.stored), /^talks : "2"\r$/m, 'the ghost\'s own save is still the old one');
    p4.loop.destroy();

    const page5 = await startEngine(page4.stored);
    assert.equal(page5.engine.resumed, 'finished');
    assert.deepEqual(infos(page5), [D6_FINISHED]);
    assert.deepEqual(page5.engine.d6Close.steps.map(s => s.id), ['OnCloseAll', 'OnClose', 'OnTranslate']);
    assert.equal(page5.find('OnClose').length + page5.find('OnCloseAll').length, 0, 'D6\'s close stays in the worker');
    assert.match(saveText(page5.stored), /^talks : "3"\r$/m, 'OnUnload ran from the snapshot and its save is stored');
    assert.equal(page5.stored[RESUME_KEY].byteLength, 0, 'that snapshot is done with');
    const p5 = makeLoop(page5);
    await p5.loop.boot({ resume: false, firstBoot: !hasSave(page4.stored) });
    assert.match(p5.player.plays[0].script, /おかえりなさい。3回目の起動です。/);
    assert.equal(await word(page5, 'talks'), '3');
    p5.loop.destroy();
  } finally {
    setLogLevel('warn');
  }
});

test('Quit of a minimized Kawari ghost that saves in OnClose (bthver.5\'s way): OnClose is sent and saves, its goodbye dropped [disasm CloseGhostProc 0x4969ef]', { timeout: 120000 }, async () => {
  setLogLevel('silent');
  try {
    // the fixture's OnClose-saving variant: no save at unload
    const edits = {
      'ghost/master/dict-event.kis': [
        ['System.Callback.OnUnload : $(save save.txt boots talks lastword)\r\n', ''],
        ['event.OnClose : "', 'event.OnClose : $(save save.txt boots talks lastword)"'],
      ],
    };
    const shiori = await startEngine({}, { edits });
    const { loop, player } = makeLoop(shiori);
    await loop.boot({ resume: false, firstBoot: true });
    player.finish();
    await settle();
    loop.stage.emit('mouse', { type: 'dblclick', scope: 0, x: 50, y: 50, button: 0, collision: '', device: 'mouse' });
    await settle();
    player.finish({ hasChoices: true });
    await settle();
    player.emit('link', { kind: 'choice', id: 'talk', label: 'お話し', refs: [], scope: 0 });
    await settle();
    assert.match(player.last.script, /お話ししましょう。1回目です。/);
    player.finish();
    await settle();
    await loop.minimize();
    assert.ok(loop.minimized);
    const plays = player.plays.length;
    const translated = shiori.find('OnTranslate').length;
    await loop.close(0, { all: true });
    await settle();
    assert.equal(shiori.find('OnCloseAll')[0].status, 204);
    assert.equal(shiori.find('OnClose')[0].status, 200);
    assert.equal(shiori.find('OnTranslate').length, translated, 'the goodbye is not translated');
    assert.equal(player.plays.length, plays, 'nor played');
    assert.equal(loop.closed, true);
    assert.match(saveText(shiori.stored), /^talks : "1"\r$/m, 'OnClose saved the session');
    loop.destroy();
  } finally {
    setLogLevel('warn');
  }
});

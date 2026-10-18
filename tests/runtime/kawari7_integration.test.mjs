// A Kawari Phase 7 ghost from the page to the engine (kawari7-wasm.md): the runtime's own start (Runtime._startEngine:
// engines/kawari7.js, the root plan, engineOpts without module) booting the registry's Kawari7Engine on the real build
// with our Shift_JIS fixture tests/fixtures/ghost/kawari7test, and the event loop on it through the SHIORI/2.x bridge
// (no worker: the engine is driven in-process, the call's kind and self passed as worker.js passes them): a first
// meeting (ownerghostname's sakura name, OnTranslate as TRANSLATE), a resource and the other GetStringShiori reads (the
// tooltips, `.ext.` properties: GET String, EV §5.5), the communicate box, a page change that
// resumes from the snapshot, Close with system.OnUnload's save, a cold boot; the %ms-style words of a reply (GET Word,
// properties.md §2.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../../src/core/runtime.js';
import { ENGINES } from '../../src/worker/engines/index.js';
import { RESUME_KEY7 } from '../../src/worker/engines/kawari7.js';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { GhostFiles, decodeText } from '../../src/core/loader.js';
import { buildRequest, parseResponse } from '../../src/core/shiori.js';
import { EventLoop } from '../../src/core/events.js';
import { parseWordList, WORD_FILE } from '../../src/core/words.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { loadEngineFactory } from '../load_engine.mjs';
import { FakeClock, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';
import { needs } from '../needs.mjs';

globalThis.self = globalThis.self || { postMessage() {} };      // worker.js touches self at import
const { mergeFiles, hasSave } = await import('../../src/worker/worker.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'kawari7.js');
const FIXTURE = path.join(root, 'tests', 'fixtures', 'ghost', 'kawari7test');
const GHOST = {
  id: 'kawari7test', name: 'Kawari7 Test', sakuraName: 'なな', keroName: 'ケロ', craftman: 'Sumika tests', shiori: 'shiori.dll',
  engine: 'kawari7', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }], bundledBalloons: [], balloon: null,
};
const SITE = { ghosts: [GHOST], balloons: [{ id: 'sumika', name: 'Sumika' }] };
const sjis = new TextDecoder('shift_jis');

/** The fixture as the site serves it: a GhostFiles over its manifest, reading the bytes from disk. */
function siteFiles() {
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else list.push([rel + e.name, fs.statSync(path.join(d, e.name)).size]);
    }
  })(FIXTURE, '');
  const gf = new GhostFiles('http://s/ghost/kawari7test/', list);
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

/** ShioriClient look-alike around an in-process engine, passing kind and self as worker.js does. */
class InProcessShiori {
  constructor(engine, stored) {
    this.engine = engine;
    this.stored = mergeFiles(stored, engine.changedFiles());
    this.base = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
    this.log = [];
  }
  async request(r) {
    const res = parseResponse(this.engine.request(buildRequest(r, this.base), { kind: r.kind || '', self: r.self || '' }));
    this.stored = mergeFiles(this.stored, this.engine.changedFiles());
    this.log.push({ method: r.method || 'GET', id: r.id, refs: r.refs || [], kind: r.kind || '', status: res.status, value: res.value });
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

async function startEngine(stored = {}, { resume = false, volatile = null } = {}) {
  assert.ok(fs.existsSync(ENGINE_JS), 'site/sumika/engines/kawari7.js is missing: run python engines/kawari7/build.py');
  const o = await pageStart({ resume, volatile });
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
  shiori.start = o;
  return shiori;
}

function makeLoop(shiori, clock = new FakeClock(), more = {}) {
  const player = new FakePlayer();
  const dialogs = new FakeDialogs();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs, ghost: GHOST,
    state: new StateStore(GHOST.id, { storage: memoryStorage(), clock }), clock, env: { win: null, doc: null },
    ghostDescript: new Map([['name', GHOST.name], ['sakura.name', GHOST.sakuraName], ['kero.name', GHOST.keroName]]), site: SITE,
    ...more,
  });
  return { loop, player, dialogs, clock };
}

/** a word of the dictionary (`debug : debugger`'s ShioriEcho evaluates Reference0) */
const word = async (shiori, name) => {
  const r = await shiori.request({ method: 'GET', id: 'ShioriEcho', refs: [`\${${name}}`] });
  return r.status === 200 ? String(r.value).replace(/\\e$/, '') : `status ${r.status}`;
};

test('a Kawari 7 ghost on the event loop: the page\'s start, a first meeting, a resource, the tooltips and `.ext.` (GET String), the communicate box, a page change, Close and system.OnUnload\'s save, a cold boot', { timeout: 120000 }, async () => {
  setLogLevel('silent');
  try {
    // ---- the page starts it as a root engine: engines/kawari7.js, the whole root, no module
    const shiori = await startEngine();
    const o = shiori.start;
    assert.equal(o.engine, 'kawari7');
    assert.equal(o.engineUrl, 'http://s/sumika/engines/kawari7.js');
    assert.deepEqual(o.files.map(f => f.path).sort(), [
      'ghost/master/descript.txt', 'ghost/master/dict.txt', 'ghost/master/kawari.ini', 'install.txt', 'readme.txt',
      'shell/master/descript.txt',
    ]);
    assert.deepEqual(o.engineOpts.placeholders, ['shell/master/surface0.png']);
    assert.equal('module' in o.engineOpts, false);
    assert.equal(shiori.engine.session.version, 26);

    // ---- a first meeting: ownerghostname names the sakura (system.Ghost), OnTranslate goes as TRANSLATE
    const { loop, player, dialogs } = makeLoop(shiori);
    await loop.boot({ resume: false, firstBoot: true });
    assert.deepEqual(shiori.find('ownerghostname', 'NOTIFY').map(r => r.refs), [['なな']]);
    assert.equal(shiori.find('basewareversion', 'NOTIFY')[0].status, 204, 'never sent to a 2.x SHIORI');
    assert.deepEqual(shiori.find('version').map(r => [r.kind, r.status]), [['resource', 204]]);
    assert.equal(shiori.find('OnFirstBoot')[0].status, 200);
    assert.deepEqual(shiori.find('OnTranslate').map(r => r.kind), ['translate']);
    assert.equal(player.plays.length, 1);
    assert.equal(player.plays[0].script, '\\0\\s[0]はじめまして、ななです。\\1\\s[10]ケロだよ。\\eにゃ');
    player.finish();
    await settle();
    assert.equal(await loop.resource('homeurl'), 'http://example.invalid/kawari7test/');

    // ---- the tooltips and `.ext.` are GetStringShiori reads too (EV §5.5): GET String SHIORI/2.5 with the ID and
    // every Reference, no SenderType; the String decoded. The hover event itself goes as an event.
    const sent = [];
    const exchange = shiori.engine._exchange.bind(shiori.engine);
    shiori.engine._exchange = (text, cs) => { sent.push(text); return exchange(text, cs); };
    assert.equal(await loop.balloons.tipSource({ kind: 'choice', id: 'TALK', refs: [], label: '話して', scope: 0 }),
      'balloon_tooltip&tip\nline');
    assert.equal(await loop.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: false }), 'shell-tooltip');
    assert.equal(await loop._property('currentghost.ext.k'), '<ext>');
    assert.equal(await loop.setProperty('currentghost.ext.k', 'v'), true);
    delete shiori.engine._exchange;
    assert.deepEqual(sent.map(t => t.split('\r\n')[0]), ['GET Sentence SHIORI/2.2', ...Array(4).fill('GET String SHIORI/2.5')]);
    assert.match(sent[0], /\r\nEvent: OnChoiceHover\r\n/);
    assert.match(sent[1], /\r\nID: balloon_tooltip\r\n(Status: [^\r]*\r\n)?Reference0: 話して\r\nReference1: TALK\r\n\r\n$/);
    assert.match(sent[2], /\r\nID: tooltip\r\n(Status: [^\r]*\r\n)?Reference0: 1\r\nReference1: 2\r\nReference2: 0\r\nReference3: 0\r\nReference4: Head\r\nReference5: 0\r\n\r\n$/);
    assert.match(sent[4], /\r\nID: property\.set\r\n(Status: [^\r]*\r\n)?Reference0: k\r\nReference1: v\r\n\r\n$/);
    assert.doesNotMatch(sent.join(''), /SenderType/);
    assert.deepEqual(shiori.log.slice(-5).map(r => [r.id, r.kind, r.status]), [
      ['OnChoiceHover', '', 204], ['balloon_tooltip', 'resource', 200], ['tooltip', 'resource', 200],
      ['property.get', 'resource', 200], ['property.set', 'resource', 200],
    ]);

    // ---- the communicate box: GET Sentence SHIORI/2.0 with Sender User
    loop.openBox('communicatebox', []);
    await settle();
    const box = dialogs.boxes.find(b => b.kind === 'communicate');
    assert.ok(box);
    box.o.onSend('こんにちは、ソ表①～髙');
    await settle();
    assert.deepEqual(shiori.find('OnCommunicate').map(r => [r.kind, r.refs]), [['communicate-user', ['user', 'こんにちは、ソ表①～髙']]]);
    assert.equal(player.last.script, '返事:こんにちは、ソ表①～髙|User|\\eにゃ');
    player.finish();
    box.resolve({ text: null, timedOut: false });
    await settle();

    // ---- a count, then a page change: the worker's save stores the snapshot
    loop.send('OnCount');
    await settle();
    assert.equal(player.last.script, '1\\eにゃ');
    player.finish();
    await settle();
    await shiori.persist();
    assert.ok(shiori.stored[RESUME_KEY7].byteLength > 0);
    const vol = shiori.engine.getVolatileState();
    loop.destroy();

    const page2 = await startEngine(shiori.stored, { resume: true, volatile: vol });
    assert.equal(page2.engine.resumed, 'restored');
    const p2 = makeLoop(page2);
    await p2.loop.boot({ resume: true, firstBoot: !hasSave(shiori.stored) });
    assert.equal(page2.log.filter(r => /^On(First)?Boot$/.test(r.id)).length, 0, 'a resume sends no boot event');
    assert.equal(await word(page2, 'counter'), '1', 'from the snapshot');
    assert.equal(await word(page2, 'bootcount'), '1');

    // ---- Close: OnClose's \- unloads, system.OnUnload writes save.txt, the snapshot key turns into the empty marker
    await p2.loop.close(0);
    await settle();
    assert.equal(page2.find('OnClose')[0].status, 200);
    assert.match(p2.player.last.script, /^\\0\\s\[0\]またね。\\-\\e/);
    p2.player.finish({ reason: 'quit' });
    await settle();
    assert.equal(p2.loop.closed, true);
    const saved = sjis.decode(page2.stored['ghost/master/save.txt']);
    assert.match(saved, /^counter : "1"\r$/m, 'Shift_JIS, CRLF');
    assert.match(saved, /^bootcount : "1"\r$/m);
    assert.equal(page2.stored[RESUME_KEY7].byteLength, 0);
    p2.loop.destroy();

    // ---- a cold boot later: OnBoot (not OnFirstBoot), the count from save.txt
    const page3 = await startEngine(page2.stored);
    const p3 = makeLoop(page3);
    await p3.loop.boot({ resume: false, firstBoot: !hasSave(page2.stored) });
    assert.equal(page3.find('OnFirstBoot').length, 0);
    assert.equal(p3.player.plays[0].script, '\\0\\s[0]2回目の起動です。\\eにゃ');
    p3.loop.destroy();
  } finally {
    setLogLevel('warn');
  }
});

test('the %ms-style words of a reply: GET Word to the ghost (compatible.*), \\m? again as \\m, SSP\'s list for the rest', { ...needs('site/sumika/word_compatible.txt'), timeout: 60000 }, async () => {
  setLogLevel('silent');
  try {
    const shiori = await startEngine();
    const list = parseWordList(decodeText(fs.readFileSync(path.join(root, 'site', ...WORD_FILE.split('/')))));
    const { loop, player } = makeLoop(shiori, new FakeClock(), { wordList: async () => list, random: () => 0 });
    await loop.boot({ resume: false, firstBoot: true });
    player.finish();
    await settle();
    shiori.log.length = 0;
    // event.OnWords : \0%ms/%m?/%dms/%ml\e (the fixture has compatible.ms, .m and .dms = %msの影, no .ml)
    loop.send('OnWords');
    await settle();
    assert.equal(player.last.script, '\\0鈴木/何か/鈴木の影/仲間\\eにゃ', '%ml from SSP\'s list (its first word, random 0)');
    assert.deepEqual(shiori.log.map(r => [r.id, r.kind, r.status]), [
      ['OnWords', '', 200],
      ['\\ms', 'word', 200], ['\\m?', 'word', 204], ['\\m', 'word', 200], ['\\dms', 'word', 200], ['\\ml', 'word', 204],
      ['\\ms', 'word', 200],                                              // pass 2: the %ms the \dms word brought
      ['OnTranslate', 'translate', 200],
    ]);
    assert.equal(shiori.find('OnTranslate')[0].refs[0], '\\0鈴木/何か/鈴木の影/仲間\\e', 'the ghost translates the expanded text');
    loop.destroy();
  } finally {
    setLogLevel('warn');
  }
});

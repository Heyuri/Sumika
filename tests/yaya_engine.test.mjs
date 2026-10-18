// YAYA's engine adapter (src/worker/engines/yaya.js) on the real build (site/sumika/engines/yaya.js) in Node, with the
// synthetic tests/fixtures/ghost/yayatest (yaya-wasm.md test plan): load status, the module name, the request buffer,
// UTF-8 transport, CP932, persistence, resume (D1, N3) and the dictionary stamp, GETTICKCOUNT, SAORI, logs, the OS
// stand-ins, the SSP view and ENV. CP932 dictionaries are written as explicit bytes here, never shipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YayaEngine, dicStamp } from '../src/worker/engines/yaya.js';
import { yayaFilePlan } from '../src/core/engine-files.js';
import { GhostFiles } from '../src/core/loader.js';
import { buildRequest, parseResponse } from '../src/core/shiori.js';
import { loadEngineFactory } from './load_engine.mjs';

globalThis.self = globalThis.self || { postMessage() {} };      // worker.js touches self at import
const { mergeFiles, hasSave } = await import('../src/worker/worker.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'yaya.js');
const FIXTURE = path.join(root, 'tests', 'fixtures', 'ghost', 'yayatest');
const HEADERS = { Charset: 'UTF-8', Sender: 'SSP', SecurityLevel: 'local' };
const SITE = {
  ghosts: [
    { id: 'yayatest', name: 'YAYA Test', sakuraName: 'Yayako', keroName: 'Kero', craftman: 'Sumika tests', shiori: 'yaya.dll' },
    { id: 'other', name: 'Other Ghost', sakuraName: 'Oto', keroName: '', craftman: 'someone', shiori: 'satori.dll' },
  ],
  balloons: ['sumika'],
};
const te = new TextEncoder();
const td = new TextDecoder();
const STAMP_LINE = 'dictionaries changed since the last boot: loading as after an update';

class NodeYaya extends YayaEngine {
  async factory() { return loadEngineFactory('yaya'); }
}

/**
 * The fixture as the runtime hands it to the worker (yayaFilePlan over the whole ghost root): {files: [{path, data}],
 * placeholders}. `replace` adds or replaces files (string or bytes; null drops one).
 */
function fixture(replace = {}) {
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else list.push([rel + e.name, fs.statSync(path.join(d, e.name)).size]);
    }
  })(FIXTURE, '');
  const plan = yayaFilePlan(new GhostFiles('mem:/yayatest/', list));
  const files = new Map(plan.bytes.map(p => [p, fs.readFileSync(path.join(FIXTURE, p))]));
  for (const [p, v] of Object.entries(replace)) {
    if (v === null) files.delete(p);
    else files.set(p, typeof v === 'string' ? te.encode(v) : v);
  }
  return {
    files: [...files].map(([p, b]) => ({ path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) })),
    placeholders: plan.placeholders,
  };
}

const fixtureText = p => fs.readFileSync(path.join(FIXTURE, p), 'utf8');

/** A booted NodeYaya (not loaded yet); its log and YAYA's own lines are kept. */
async function engine({ ghost = fixture(), opts = {}, saori = null } = {}) {
  if (!fs.existsSync(ENGINE_JS)) throw new Error('site/sumika/engines/yaya.js is missing: run python engines/yaya/build.py');
  const logs = [];
  const engineLog = [];
  const e = new NodeYaya({
    engineUrl: ENGINE_JS, saori, log: (level, text) => logs.push({ level, text }), onEngineLog: l => engineLog.push(l),
    opts: { module: 'yaya', ghostId: 'yayatest', placeholders: ghost.placeholders, site: SITE, lang: 'ja-JP', ...opts },
  });
  await e.boot();
  e.ghost = ghost;
  e.logs = logs;
  e.engineLog = engineLog;
  return e;
}

/** engine() + init(); the first report is merged into e.persisted, as the worker does right after init. */
async function start({ ghost = fixture(), persisted = {}, resume = false, volatile = null, bootEpochMs = 0, ...o } = {}) {
  const e = await engine({ ghost, ...o });
  e.ok = e.init(ghost.files, persisted, { resume, volatile, bootEpochMs });
  e.persisted = mergeFiles(persisted, e.changedFiles());
  return e;
}

const req = (e, id, refs = [], method = 'GET') => parseResponse(e.request(buildRequest({ id, refs, method }, HEADERS)));
/** OnTest's answer for a case (events.dic), `status N` when it is not 200 */
const ask = (e, ...refs) => {
  const r = req(e, 'OnTest', refs);
  return r.status === 200 ? r.value : `status ${r.status}`;
};
const evalIn = (e, expr) => ask(e, 'eval', expr);
const report = (e) => {
  const ch = e.changedFiles();
  e.persisted = mergeFiles(e.persisted, ch);
  return ch;
};
const shape = files => Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([p, v]) => [p, v instanceof ArrayBuffer ? td.decode(v) : v]));
const tick = () => new Promise(r => setTimeout(r, 5));       // MEMFS mtimes are milliseconds

test('load status: normal 0 and emergency 1 boot; suppressed 2 and shell mode 3 fail, each with a warn line', async () => {
  const normal = await start();
  assert.equal(normal.ok, true);
  assert.equal(normal.status, 0);
  assert.deepEqual(normal.logs.filter(l => l.level === 'warn'), []);
  assert.equal(ask(normal, 'boots'), '1');

  const BROKEN = 'OnBroken\n{\n\t"x"\n';
  const broken = await start({ ghost: fixture({ 'ghost/master/dic/events.dic': BROKEN }) });
  assert.equal(broken.ok, false);
  assert.equal(broken.status, 2);
  assert.ok(broken.logs.some(l => l.level === 'warn' && l.text === 'nothing usable loaded (dictionary errors; details with ?sumika-debug)'));

  const emergency = await start({
    ghost: fixture({
      'ghost/master/dic/events.dic': BROKEN,
      'ghost/master/yaya_emerg.txt': 'charset, UTF-8\ndic, emerg.dic\n',
      'ghost/master/emerg.dic': 'request\n{\n\t\'SHIORI/3.0 200 OK\' + CHR(13, 10) + \'Value: emergency\' + CHR(13, 10) + CHR(13, 10)\n}\n',
    }),
  });
  assert.equal(emergency.ok, true);
  assert.equal(emergency.status, 1);
  assert.ok(emergency.logs.some(l => l.level === 'warn' && l.text === 'emergency mode: yaya_emerg.txt answers'));
  assert.equal(req(emergency, 'OnBoot').value, 'emergency');

  const shell = await start({ ghost: fixture({ 'ghost/master/yaya.txt': null }) });
  assert.equal(shell.ok, false);
  assert.equal(shell.status, 3);
  assert.ok(shell.logs.some(l => l.level === 'warn' && /^no yaya\.txt or no dictionary: /.test(l.text)));
});

test('module aya5: aya5.txt is the config and ghost/master/aya5_variable.cfg the save', async () => {
  const ghost = fixture({ 'ghost/master/yaya.txt': null, 'ghost/master/aya5.txt': fixtureText('ghost/master/yaya.txt') });
  const e = await start({ ghost, opts: { module: 'aya5' } });
  assert.equal(e.status, 0);
  assert.equal(ask(e, 'boots'), '1');
  assert.match(evalIn(e, "GETSETTING('coreinfo.savefile')"), /\/ssp\/ghost\/yayatest\/ghost\/master\/aya5_variable\.cfg$/);
  assert.equal(e.save(), true);
  assert.deepEqual(Object.keys(report(e)), ['ghost/master/aya5_variable.cfg']);
});

test('the request buffer: the heap probe stays in place over 5,000 requests (request frees its input, we free the reply)', async () => {
  const e = await start();
  const M = e.M;
  const probe = () => { const p = M._malloc(1 << 20); M._free(p); return p; };
  for (let i = 0; i < 100; i++) ask(e, 'boots');
  const p0 = probe();
  const heap0 = M.HEAPU8.length;
  for (let i = 0; i < 5000; i++) assert.equal(ask(e, 'boots'), '1');
  assert.equal(probe(), p0);
  assert.equal(M.HEAPU8.length, heap0);
});

test('transport: after SETSETTING(charset.output, Shift_JIS) the reply bytes are still UTF-8', async () => {
  const e = await start();
  const raw = e.request(buildRequest({ id: 'OnTest', refs: ['sjisout'] }, HEADERS));
  assert.ok(!raw.includes('�'), raw);
  assert.equal(parseResponse(raw).value, 'こんにちは①～髙');
  assert.equal(evalIn(e, "'あ①' + GETSETTING('charset.output')"), 'あ①Shift_JIS');
});

test('CP932 as Windows: a Shift_JIS dictionary, invalid pairs, byte counts and Shift_JIS writes (best fit, IBM codes)', async () => {
  const head = te.encode("SjisText\r\n{\r\n\t'");
  const tail = te.encode("'\r\n}\r\n");
  const sjis = new Uint8Array([...head, 0x81, 0x60, 0x81, 0x7c, 0x81, 0x5f, 0x87, 0x40, 0xfb, 0xfc, ...tail]);
  const ghost = fixture({
    'ghost/master/yaya.txt': fixtureText('ghost/master/yaya.txt') + 'dic, dic/sjis.dic, Shift_JIS\n',
    'ghost/master/dic/sjis.dic': sjis,
  });
  const e = await start({ ghost });
  assert.equal(e.status, 0);
  assert.equal(evalIn(e, 'SjisText'), '～－＼①髙');
  // MultiByteToWideChar(932): a lead byte takes the next byte along (81 0A -> U+30FB), a lone one at the end too
  assert.equal(evalIn(e, "STRDECODE('X%81%0AY', 'Shift_JIS')"), 'X・Y');
  assert.equal(evalIn(e, "STRDECODE('A%81', 'Shift_JIS')"), 'A・');
  assert.equal(evalIn(e, 'GETSTRBYTES("①～－＼", 0)'), '8');
  evalIn(e, 'FCHARSET("Shift_JIS"); _d = FOPEN("w.txt", "w"); _d = FWRITE2("w.txt", "あいう①éⅰ"); _d = FCLOSE("w.txt")');
  const w = e.M.FS.readFile(e.ghostDir + 'w.txt');
  // あいう① as Windows writes them, é by best fit, ⅰ as the IBM code FA40 (not NEC's EEEF)
  assert.equal(Buffer.from(w).toString('hex'), '82a082a282a4874065fa40');
});

test('persistence: new files (also beside ghost/master), a rewritten shipped dictionary that shadows, deletions as null / false, never *.log', async () => {
  const e = await start();
  assert.deepEqual(shape(e.persisted), {}, 'load wrote and deleted nothing');
  await tick();
  assert.equal(ask(e, 'write'), 'written');
  assert.deepEqual(shape(report(e)), { 'ghost/master/var/note.txt': 'a note', 'notelog/n.txt': 'outside' });
  assert.equal(ask(e, 'fsize', 'x.log'), '5', 'the log file exists, but is never reported');
  await tick();
  assert.equal(ask(e, 'rewrite'), 'rewritten');
  assert.deepEqual(Object.keys(report(e)), ['ghost/master/dic/memo.dic']);
  await tick();
  assert.equal(ask(e, 'delete'), 'deleted 11');
  assert.deepEqual(shape(report(e)), { 'ghost/master/data/shipped.txt': null, 'ghost/master/var/note.txt': false });
  assert.deepEqual(Object.keys(e.persisted).sort(), ['ghost/master/data/shipped.txt', 'ghost/master/dic/memo.dic', 'notelog/n.txt']);

  // the next page: the visitor's dictionary shadows the site's, the tombstone keeps the shipped file deleted
  const next = await start({ persisted: e.persisted });
  assert.equal(next.status, 0);
  assert.equal(evalIn(next, 'Memo'), 'rewritten');
  assert.equal(ask(next, 'fsize', 'data/shipped.txt'), '-1');
  assert.equal(ask(next, 'fsize', 'var/note.txt'), '-1');
  assert.equal(ask(next, 'read', '../../notelog/n.txt'), 'outside|');
  assert.deepEqual(shape(next.changedFiles()), {}, 'restored files are no changes');
});

test('persistence: FDEL and RMDIR in another case, FRENAME over a file in another case leave no name behind (J1); a stale name is dropped', async () => {
  const e = await start();
  const FS = e.M.FS;
  const write = (p, text) => evalIn(e, `_r = FOPEN('${p}', 'w'); _r = FWRITE2('${p}', '${text}'); _r = FCLOSE('${p}')`);
  const names = dir => FS.readdir(e.ghostDir + dir).filter(n => n !== '.' && n !== '..');
  assert.equal(evalIn(e, "MKDIR('var')"), '1');
  write('var/Note.txt', 'a');
  write('var/keep.txt', 'b');
  assert.deepEqual(Object.keys(report(e)).sort(), ['ghost/master/var/Note.txt', 'ghost/master/var/keep.txt']);
  await tick();
  assert.equal(evalIn(e, "FDEL('var/NOTE.TXT')"), '1', 'Windows deletes in any case');
  assert.deepEqual(names('var'), ['keep.txt']);
  assert.equal(ask(e, 'fenum', 'var'), 'keep.txt');
  assert.equal(evalIn(e, "FDEL('DATA/SHIPPED.TXT')"), '1');
  assert.deepEqual(shape(report(e)), { 'ghost/master/data/shipped.txt': null, 'ghost/master/var/Note.txt': false });

  write('var/a.txt', 'from a');
  report(e);
  await tick();
  assert.equal(evalIn(e, "FRENAME('var/a.txt', 'VAR/KEEP.TXT')"), '1');
  assert.deepEqual(names('var'), ['KEEP.TXT'], 'the replaced keep.txt is gone, not listed beside it');
  assert.deepEqual(shape(report(e)), { 'ghost/master/var/KEEP.TXT': 'from a', 'ghost/master/var/a.txt': false, 'ghost/master/var/keep.txt': false });
  await tick();
  assert.equal(evalIn(e, "FDEL('VAR/KEEP.TXT') + RMDIR('VAR')"), '2');
  assert.ok(!names('').includes('var'));
  assert.deepEqual(shape(report(e)), { 'ghost/master/var/KEEP.TXT': false });
  assert.deepEqual(Object.keys(e.persisted), ['ghost/master/data/shipped.txt']);

  // a name an older build's MEMFS left listed without its node: the scan drops it and the file counts as gone (the
  // unlink that leaves such a name goes through FS.unlink, which marks the engine dirty; here the test does both)
  assert.equal(evalIn(e, "MKDIR('old')"), '1');
  write('old/x.txt', 'x');
  report(e);
  FS.hashRemoveNode(FS.lookupPath(e.ghostDir + 'old').node.contents['x.txt']);
  e.dirty = true;
  assert.deepEqual(shape(report(e)), { 'ghost/master/old/x.txt': false });
  assert.deepEqual(names('old'), []);
  assert.deepEqual(Object.keys(e.unload()), ['ghost/master/yaya_variable.cfg'], 'unload reports its save (the Close save)');
});

test('persistence: the scan runs only after a request that wrote (FWRITE, FDEL, the save): none for one that only read', async () => {
  const e = await start();
  let scans = 0;
  const scan = e.scan.bind(e);
  e.scan = () => { scans++; return scan(); };
  await tick();
  report(e);                // a file stamped in the millisecond of init's report is looked at once more
  scans = 0;
  for (let i = 0; i < 5; i++) {
    assert.equal(ask(e, 'boots'), '1');
    assert.deepEqual(report(e), {});
  }
  assert.match(ask(e, 'fsize', 'data/shipped.txt'), /^[1-9]\d*$/);
  assert.deepEqual(report(e), {});
  assert.equal(scans, 0, 'requests that only read');
  assert.equal(ask(e, 'write'), 'written');
  assert.deepEqual(Object.keys(report(e)).sort(), ['ghost/master/var/note.txt', 'notelog/n.txt']);
  assert.equal(scans, 1);
  await tick();
  assert.equal(ask(e, 'delete'), 'deleted 11');
  assert.deepEqual(shape(report(e)), { 'ghost/master/data/shipped.txt': null, 'ghost/master/var/note.txt': false });
  assert.equal(e.save(), true);
  assert.deepEqual(Object.keys(report(e)), ['ghost/master/yaya_variable.cfg']);
  assert.equal(scans, 3);
});

test('persistence: in the millisecond of the last report a rewrite in place counts by its bytes, a rename over a file by its node', async () => {
  const e = await start();
  const now = Date.now;
  const t = now();
  Date.now = () => t;               // MEMFS stamps mtimes with Date.now: a frozen clock (the sweep's followClock)
  try {
    assert.equal(ask(e, 'write'), 'written');
    assert.deepEqual(Object.keys(report(e)).sort(), ['ghost/master/var/note.txt', 'notelog/n.txt']);
    evalIn(e, "_r = FOPEN('var/note.txt', 'w'); _r = FWRITE2('var/note.txt', 'b note'); _r = FCLOSE('var/note.txt')");
    assert.equal(e.scan().get('ghost/master/var/note.txt').split(':')[0], String(t), 'the same mtime');
    assert.deepEqual(shape(report(e)), { 'ghost/master/var/note.txt': 'b note' }, 'same size, same mtime, other bytes');
    evalIn(e, "_r = FOPEN('var/x.txt', 'w'); _r = FWRITE2('var/x.txt', 'xx'); _r = FCLOSE('var/x.txt')");
    report(e);
    assert.equal(evalIn(e, "FRENAME('var/x.txt', 'var/note.txt')"), '1');
    assert.deepEqual(shape(report(e)), { 'ghost/master/var/note.txt': 'xx', 'ghost/master/var/x.txt': false });
    assert.deepEqual(shape(report(e)), {}, 'nothing changed since');
  } finally {
    Date.now = now;
  }
});

test('the first report holds what load wrote or deleted: a save moved from an old module (emily4\'s template) is never lost', async () => {
  // the visitor's store from when the index said module aya5 (yaya_shiori3.dic:98-107 moves it to the module's own)
  const old = await start();
  evalIn(old, 'precious = 42');
  evalIn(old, "SAVEVAR('aya5_variable.cfg')");
  const u8 = old.M.FS.readFile(old.ghostDir + 'aya5_variable.cfg');
  const stored = { 'ghost/master/aya5_variable.cfg': u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) };
  const base = fixtureText('ghost/master/dic/base.dic');
  const moving = base.replace("\tevlist = GETFUNCLIST('On')\n", "\tevlist = GETFUNCLIST('On')\n" +
    "\tif FSIZE(GETSETTING('coreinfo.savefile')) <= 0 {\n\t\tif FSIZE('aya5_variable.cfg') > 0 {\n" +
    "\t\t\tRESTOREVAR('aya5_variable.cfg')\n\t\t\tFDEL('aya5_variable.cfg')\n\t\t}\n\t\tSAVEVAR()\n\t}\n");
  assert.notEqual(moving, base);
  const ghost = fixture({ 'ghost/master/dic/base.dic': moving });
  for (const resume of [false, true]) {     // a new tab; a page of the same session whose store still has the old save
    const e = await start({ ghost, persisted: stored, resume, volatile: { dicStamp: dicStamp(ghost.files) } });
    assert.equal(evalIn(e, 'precious'), '42');
    assert.deepEqual(Object.keys(e.persisted), ['ghost/master/yaya_variable.cfg'], `resume ${resume}: stored at once, the old one gone`);
    assert.match(shape(e.persisted)['ghost/master/yaya_variable.cfg'], /^precious,42,/m);
    assert.equal(hasSave(e.persisted), true);
    const next = await start({ ghost, persisted: e.persisted });      // the page went before any later save
    assert.equal(evalIn(next, 'precious'), '42');
    assert.equal(ask(next, 'boots'), '2', 'a cold boot after it counts on from the moved save');
  }
});

test('resume (D1): no boot counted and load\'s values restored; a cold boot counts; a changed dictionary loads as after an update', async () => {
  const cold = await start();
  assert.equal(ask(cold, 'boots'), '1');
  evalIn(cold, 'bootsec = 12345');
  const evlist = evalIn(cold, 'evlist');
  assert.equal(cold.save(), true);
  report(cold);
  const vol = cold.getVolatileState();
  assert.match(vol.dicStamp, /^[0-9a-f]{8}$/);

  const resumed = await start({ persisted: cold.persisted, resume: true, volatile: vol });
  assert.equal(resumed.status, 0);
  assert.equal(ask(resumed, 'boots'), '1');
  assert.equal(evalIn(resumed, 'bootsec'), '12345', 'load set it again, the second restore put the saved one back');
  assert.equal(evalIn(resumed, 'evlist'), evlist);
  assert.ok(!resumed.logs.some(l => l.text === STAMP_LINE));
  assert.equal(resumed.getVolatileState().dicStamp, vol.dicStamp);

  const again = await start({ persisted: cold.persisted });
  assert.equal(ask(again, 'boots'), '2');
  assert.notEqual(evalIn(again, 'bootsec'), '12345');

  // a site update between save and resume: the cached event list would be stale, so load runs as after an update
  const updated = fixture({ 'ghost/master/dic/events.dic': fixtureText('ghost/master/dic/events.dic') + "\nOnAdded\n{\n\t'added'\n}\n" });
  const stamped = await start({ ghost: updated, persisted: cold.persisted, resume: true, volatile: vol });
  assert.equal(stamped.status, 0);
  assert.ok(stamped.logs.some(l => l.level === 'info' && l.text === STAMP_LINE), JSON.stringify(stamped.logs));
  assert.equal(ask(stamped, 'boots'), '2');
  assert.notEqual(evalIn(stamped, "ASEARCH('OnAdded', evlist)"), '-1');
  assert.equal(req(stamped, 'OnAdded').value, 'added');
  assert.notEqual(stamped.getVolatileState().dicStamp, vol.dicStamp);

  // an empty folder MKDIR made is not reported (only regular files persist; yaya-wasm.md, persistence)
  await tick();
  assert.equal(evalIn(resumed, "MKDIR('emptydir')"), '1');
  assert.equal(ask(resumed, 'fenum', 'emptydir'), 'status 204');
  assert.deepEqual(shape(resumed.changedFiles()), {});
});

test('resume (N3): a load that writes the save itself (SAVEVAR, as cyau_cyaka\'s OnSystemLoad.INIT) gets the saved values back', async () => {
  const base = fixtureText('ghost/master/dic/base.dic');
  const saving = base.replace("\tevlist = GETFUNCLIST('On')\n", "\tevlist = GETFUNCLIST('On')\n\tSAVEVAR()\n");
  assert.notEqual(saving, base);
  const ghost = fixture({ 'ghost/master/dic/base.dic': saving });
  const cold = await start({ ghost });
  assert.equal(ask(cold, 'boots'), '1');
  evalIn(cold, 'bootsec = 12345');
  assert.equal(cold.save(), true);         // load wrote the save already: a rewrite in its millisecond counts too
  report(cold);
  const vol = cold.getVolatileState();

  let persisted = cold.persisted;
  for (const page of [1, 2]) {           // the next page, then the one after it (from the first resume's save)
    const resumed = await start({ ghost, persisted, resume: true, volatile: vol });
    assert.equal(resumed.status, 0);
    assert.equal(ask(resumed, 'boots'), '1', `page ${page}: load's SAVEVAR() did not replace the save`);
    assert.equal(evalIn(resumed, 'bootsec'), '12345', `page ${page}`);
    assert.deepEqual(resumed.M.FS.readdir('/tmp').filter(n => n !== '.' && n !== '..'), [], 'the copy under /tmp is gone');
    // load's SAVEVAR() wrote load's values; the first report stores the save written again from the restored ones
    const first = shape(resumed.persisted)['ghost/master/yaya_variable.cfg'];
    assert.match(first, /^bootsec,12345,/m, `page ${page}: the first report`);
    assert.match(first, /^boots,1,/m);
    await tick();
    assert.equal(resumed.save(), true);
    assert.match(td.decode(report(resumed)['ghost/master/yaya_variable.cfg']), /^bootsec,12345,/m);
    persisted = resumed.persisted;
  }
  const again = await start({ ghost, persisted });
  assert.equal(ask(again, 'boots'), '2', 'a cold boot still counts');
});

test('GETTICKCOUNT counts from bootEpochMs (the last cold boot) and never goes back', async () => {
  const e = await start({ bootEpochMs: Date.now() - 3 * 3600e3 });
  const t1 = Number(ask(e, 'tick'));
  assert.ok(t1 >= 10800000 && t1 < 10800000 + 120e3, String(t1));
  await tick();
  const t2 = Number(ask(e, 'tick'));
  assert.ok(t2 >= t1, `${t1} -> ${t2}`);
});

test('SAORI: the bridge sees ghost-root paths and UTF-8 requests and unloads at unload(); no stand-in -> LOADLIB 0', async () => {
  const calls = [];
  const saori = {
    load(p, dir) { calls.push(['load', p, dir]); return /missing/.test(p) ? 0 : 7; },
    request(h, bytes) { calls.push(['request', h, td.decode(bytes)]); return 'SAORI/1.0 200 OK\r\nCharset: UTF-8\r\nResult: ok\r\n\r\n'; },
    unload(h) { calls.push(['unload', h]); },
  };
  const e = await start({ saori });
  assert.equal(ask(e, 'saori'), 'loadlib 1, SAORI/1.0 200 OK');
  assert.deepEqual(calls[0], ['load', '/ghost/master/saori/gomi.dll', '/ghost/master/saori/']);
  assert.equal(calls[1][0], 'request');
  assert.match(calls[1][2], /^EXECUTE SAORI\/1\.0\r\n/);
  assert.match(calls[1][2], /\r\nArgument0: あ①\r\n/);
  assert.equal(ask(e, 'missing'), 'loadlib 0');
  assert.deepEqual(calls[2], ['load', '/ghost/master/saori/missing.dll', '/ghost/master/saori/']);
  e.unload();
  assert.deepEqual(calls.slice(3), [['unload', 7]]);
});

test('logs: a broken dictionary reaches onEngineLog as an error and the console only at debug; `log, x.log` writes no file', async () => {
  const e = await start({ ghost: fixture({ 'ghost/master/dic/events.dic': 'OnBroken\n{\n\t"x"\n' }) });
  const errors = e.engineLog.filter(l => l.mode === 'error');
  assert.ok(errors.length > 0, JSON.stringify(e.engineLog));
  assert.ok(errors.every(l => !/\n/.test(l.text) && l.text.trim()));
  assert.ok(e.logs.some(l => l.level === 'debug' && /^yaya error: /.test(l.text)));
  assert.ok(!e.logs.some(l => l.level !== 'debug' && /^yaya (fatal|error|warning|note)/.test(l.text)));

  const logged = await start({ ghost: fixture({ 'ghost/master/yaya.txt': fixtureText('ghost/master/yaya.txt') + 'log, yayatest.log\n' }) });
  assert.equal(logged.status, 0);
  for (let i = 0; i < 5; i++) ask(logged, 'boots');
  logged.unload();
  assert.equal(logged.M.FS.analyzePath(logged.ghostDir + 'yayatest.log').exists, false);
  assert.ok(![...logged.scan().keys()].some(p => /\.log$/i.test(p)));
});

test('OS stand-ins (D8): GETENV empty with error 12, GETMEMINFO constants (load 45 computed by YAYA), EXECUTE / EXECUTE_WAIT -1', async () => {
  const e = await start();
  assert.equal(ask(e, 'env'), '|12');
  assert.equal(ask(e, 'mem'), '45,8589934592,4724464025,2147352576,1717986918');
  assert.equal(ask(e, 'exec'), '-1|-1');
});

test('the SSP view: FENUM(..\\..\\..) lists the site, other ghosts have a descript.txt, ../../ files and placeholders are there', async () => {
  const e = await start();
  assert.equal(ask(e, 'fenum', '..\\..\\..'), '\\other,\\yayatest');
  assert.equal(ask(e, 'fenum', '..\\..\\..\\..\\balloon'), '\\sumika');
  assert.equal(ask(e, 'read', '../../../other/ghost/master/descript.txt'),
    'charset,UTF-8|type,ghost|name,Other Ghost|sakura.name,Oto|kero.name,|craftman,someone|shiori,satori.dll|');
  assert.equal(ask(e, 'fsize', '../../updates2.dau'), String(fs.statSync(path.join(FIXTURE, 'updates2.dau')).size));
  assert.equal(ask(e, 'open', '../../shell/master/surface0.png'), 'open 1, size 0');
  assert.equal(evalIn(e, "GETSETTING('coreinfo.path')"), '/ssp/ghost/yayatest/ghost/master/');
});

test('ENV: coreinfo.timezone names this machine\'s zone; msglang follows opts.lang', async () => {
  const e = await start();
  assert.equal(evalIn(e, "GETSETTING('coreinfo.timezone')"), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(evalIn(e, "GETSETTING('msglang')"), 'japanese');
  const en = await start({ opts: { lang: 'en-US' } });
  assert.equal(evalIn(en, "GETSETTING('msglang')"), 'english');
});

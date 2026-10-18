// Kawari's engine adapter (src/worker/engines/kawari.js) on the real build (site/sumika/engines/kawari.js) in Node, with
// the project's own Shift_JIS ghost tests/fixtures/ghost/kawaritest (kawari-wasm.md §13): load and a missing
// kawarirc.kis, UTF-8 transport over Kawari's Shift_JIS (patch K4, encoded as ssp.exe does: R1), code page 932
// dictionaries, persistence under the ghost root, the snapshot key's three states, the resume, D6 (ssp.exe's
// end-of-session close, then OnUnload, at the time the session ended: runAt), the dictionary stamp, the SSP view in
// code page 932, SAORI root paths, logs, getenv and the stack restore. Invalid byte sequences are written as bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KawariEngine, RESUME_KEY, snapshotStamp, D6_FINISHED, END_SESSION_REFS, endSessionRequest, runAt } from '../src/worker/engines/kawari.js';
import { dicStamp, STAMP_CHANGED } from '../src/worker/engines/ssproot.js';
import { buildRequest, parseResponse, BASE_HEADERS } from '../src/core/shiori.js';
import { loadEngineFactory } from './load_engine.mjs';

globalThis.self = globalThis.self || { postMessage() {} };      // worker.js touches self at import
const { mergeFiles, hasSave } = await import('../src/worker/worker.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'kawari.js');
const FIXTURE = path.join(root, 'tests', 'fixtures', 'ghost', 'kawaritest');
const HEADERS = { Charset: 'UTF-8', Sender: 'SSP', SecurityLevel: 'local' };
const SITE = {
  ghosts: [
    { id: 'kawaritest', name: 'Kawari Test', sakuraName: 'かわり', keroName: 'ケロ', craftman: 'Sumika tests', shiori: 'shiori.dll' },
    { id: 'other', name: 'Other Ghost', sakuraName: 'おと①', keroName: '', craftman: 'Zoë', shiori: 'satori.dll' },
  ],
  balloons: ['sumika'],
};
// the root plan (YAYA's, with Kawari's .kis/.kaw dictionaries as text): text with its bytes, the rest placeholders,
// DLLs, EXEs and logs never; the page's own copy belongs to src/core/engine-files.js (kawari-wasm.md §6)
const TEXT = /\.(txt|kis|kaw|dic|ini|csv|dau)$/i;
const SKIP = /\.(dll|exe|log)$/i;
const OTHER_DICTS = 'the snapshot of the last session is of other dictionaries: dropped';
const te = new TextEncoder();
const sjis = new TextDecoder('shift_jis');

class NodeKawari extends KawariEngine {
  async factory() { return loadEngineFactory('kawari'); }
}

const cat = (...parts) => Uint8Array.from(parts.flatMap(p => (typeof p === 'string' ? [...te.encode(p)] : [...p])));
const fixtureBytes = p => fs.readFileSync(path.join(FIXTURE, p));
/** A fixture file with ASCII parts replaced in its code page 932 bytes (each `from` must occur). */
function edited(p, pairs) {
  let t = fixtureBytes(p).toString('latin1');
  for (const [from, to] of pairs) {
    assert.ok(t.includes(from), `${p} has ${JSON.stringify(from)}`);
    t = t.replace(from, to);
  }
  return Buffer.from(t, 'latin1');
}
const withoutDebugger = () => edited('ghost/master/kawarirc.kis', [['debugger on;\r\n', '']]);

/**
 * The fixture as the runtime hands it to the worker: {files: [{path, data}], placeholders}. `replace` adds or replaces
 * files (an ASCII string or bytes; null drops one).
 */
function fixture(replace = {}) {
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else list.push(rel + e.name);
    }
  })(FIXTURE, '');
  const files = new Map(list.filter(p => !SKIP.test(p) && TEXT.test(p)).map(p => [p, fixtureBytes(p)]));
  for (const [p, v] of Object.entries(replace)) {
    if (v === null) files.delete(p);
    else files.set(p, typeof v === 'string' ? te.encode(v) : v);
  }
  return {
    files: [...files].map(([p, b]) => ({ path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) })),
    placeholders: list.filter(p => !SKIP.test(p) && !TEXT.test(p)),
  };
}

/** A booted NodeKawari (not loaded yet); its log and Kawari's own lines are kept. */
async function engine({ ghost = fixture(), opts = {}, saori = null } = {}) {
  if (!fs.existsSync(ENGINE_JS)) throw new Error('site/sumika/engines/kawari.js is missing: run python engines/kawari/build.py');
  const logs = [];
  const engineLog = [];
  const e = new NodeKawari({
    engineUrl: ENGINE_JS, saori, log: (level, text) => logs.push({ level, text }), onEngineLog: l => engineLog.push(l),
    opts: { ghostId: 'kawaritest', placeholders: ghost.placeholders, site: SITE, ...opts },
  });
  await e.boot();
  e.ghost = ghost;
  e.logs = logs;
  e.engineLog = engineLog;
  return e;
}

/**
 * engine() + init(); the first report is merged into e.persisted, as the worker does right after init. sessionEndMs:
 * the page's (the ghost state's savedAt on a cold boot).
 */
async function start({ ghost = fixture(), persisted = {}, resume = false, volatile = null, sessionEndMs = 0, ...o } = {}) {
  const e = await engine({ ghost, ...o });
  e.ok = e.init(ghost.files, persisted, { resume: resume && hasSave(persisted), volatile: resume ? volatile : null, sessionEndMs });
  e.persisted = mergeFiles(persisted, e.changedFiles());
  return e;
}

const req = (e, id, refs = [], method = 'GET') => parseResponse(e.request(buildRequest({ id, refs, method }, HEADERS)));
/** A script through Kawari's KOSUI hook (GET ShioriEcho; the fixture says `debugger on`): its value without the \e. */
const evalIn = (e, script) => {
  const r = req(e, 'ShioriEcho', [script]);
  return r.status === 200 ? r.value.replace(/\\e$/, '') : `status ${r.status}`;
};
const report = e => {
  const ch = e.changedFiles();
  e.persisted = mergeFiles(e.persisted, ch);
  return ch;
};
/** stored files as text (code page 932) */
const shape = files => Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([p, v]) => [p, v instanceof ArrayBuffer ? sjis.decode(v) : v]));
const tick = () => new Promise(r => setTimeout(r, 5));       // MEMFS mtimes are milliseconds
const infos = e => e.logs.filter(l => l.level === 'info').map(l => l.text);

test('load: kawarirc.kis loads the rest at the SSP-shaped data path; Kawari answers version 8.2.8; no kawarirc.kis fails with a warn line', async () => {
  const e = await start();
  assert.equal(e.ok, true);
  assert.deepEqual(e.logs.filter(l => l.level !== 'debug'), []);
  assert.deepEqual(e.persisted, {}, 'load wrote nothing');
  assert.equal(evalIn(e, '${System.DataPath}'), '/ssp/ghost/kawaritest/ghost/master/');
  assert.equal(req(e, 'version').value, '8.2.8');
  assert.ok(e.entries > 0);
  assert.ok(e.logs.some(l => l.level === 'debug' && /^kawari: module \d+ ms, load \d+ ms, stamp \d+ ms, heap 32 MB, 9 files \d+ KB, 1 placeholders, \d+ entries$/.test(l.text)),
    JSON.stringify(e.logs));

  const upper = fixture({ 'ghost/master/kawarirc.kis': null, 'ghost/master/KAWARIRC.KIS': fixtureBytes('ghost/master/kawarirc.kis') });
  const any = await start({ ghost: upper });
  assert.equal(any.ok, true, 'Windows finds it in any case');
  assert.equal(evalIn(any, '${word}'), 'ソ表能～－①＼髙');

  const none = await start({ ghost: fixture({ 'ghost/master/kawarirc.kis': null }) });
  assert.equal(none.ok, false);
  assert.deepEqual(none.logs.filter(l => l.level === 'warn').map(l => l.text), ['no kawarirc.kis: nothing to load']);
  assert.deepEqual(none.persisted, {}, 'the site\'s files are no visitor files');
});

test('a site id code page 932 cannot write (café: é by best fit) fails the boot with a warn line, not a silent ghost; a Japanese id loads', async () => {
  const cafe = await start({ opts: { ghostId: 'café' } });
  assert.equal(cafe.ok, false);
  assert.deepEqual(cafe.logs.filter(l => l.level === 'warn').map(l => l.text),
    ['site id "café" is not writable in code page 932: Kawari would not find its files']);
  for (const id of ['wave〜', 'yen¥']) assert.equal((await start({ opts: { ghostId: id } })).ok, false, id);

  const jp = await start({ opts: { ghostId: 'かわり①～' } });
  assert.equal(jp.ok, true);
  assert.equal(evalIn(jp, '${System.DataPath}|${word}'), '/ssp/ghost/かわり①～/ghost/master/|ソ表能～－①＼髙');
});

test('transport: UTF-8 in and out, while the ghost reads Shift_JIS headers (Charset: Shift_JIS, as SSP sends it)', async () => {
  const e = await start();
  const raw = e.request(buildRequest({ id: 'OnCommunicate', refs: ['user', 'こんにちは①～髙'] }, HEADERS));
  assert.match(raw, /^SHIORI\/3\.0 200 OK\r\n/);
  assert.match(raw, /\r\nCharset: UTF-8\r\n/);
  assert.equal(parseResponse(raw).value, '\\0\\s[0]「こんにちは①～髙」ですね。\\e');
  assert.equal(evalIn(e, '${System.Request.Charset}'), 'Shift_JIS');
  assert.equal(evalIn(e, '${lastword}'), 'こんにちは①～髙');
});

test('code page 932 as ssp.exe (R1): 0x5C trail bytes, half-width kana entry names (K3), an invalid pair, IBM codes, best fit, ?? above the BMP', async () => {
  const more = cat('bad : a', [0x81, 0x7f], 'b\r\nibm : ', [0xfa, 0x40], '\r\n');
  const e = await start({ ghost: fixture({ 'ghost/master/more.kis': more }) });
  assert.equal(evalIn(e, '${word}'), 'ソ表能～－①＼髙');
  assert.equal(evalIn(e, '$(echo ～－＼①髙ソ表能)'), '～－＼①髙ソ表能');
  assert.equal(evalIn(e, '$(length ソ表能～)'), '4');
  assert.equal(evalIn(e, '${ｶﾅ}|${ｱ･ｲ}|$(length ｱｲｳ･)'), 'はんかく|なかてん|4');
  // MultiByteToWideChar(932, 0): a lead byte takes the next byte along (81 7F -> U+30FB); FA40 is the IBM ⅰ both ways
  assert.equal(evalIn(e, '$(load more.kis)${bad}|${ibm}|$(echo ⅰ)'), 'a・b|ⅰ|ⅰ');
  // WideCharToMultiByte(932, 0), as ssp.exe encodes a request: é « ゔ by best fit, 😀 as ??, 〜 (U+301C) as ?
  assert.equal(evalIn(e, '$(echo é«ゔ😀〜)'), 'e≪ヴ???');
});

test('the SSP view in code page 932: readdir ../../.. lists the site, other ghosts\' descript.txt are Shift_JIS bytes saying so, ../../shell is there', async () => {
  const e = await start();
  assert.equal(evalIn(e, '${ghosts}'), 'kawaritest,other');
  assert.equal(evalIn(e, '$(readdir @b ../../../../balloon)$(join @b ",")'), 'sumika');
  // KEEPS' installed-ghost scan textloads them as Shift_JIS; a character code page 932 lacks goes by best fit (ë -> e)
  assert.equal(evalIn(e, '${otherdescript}'),
    'charset,Shift_JIS|type,ghost|name,Other Ghost|sakura.name,おと①|kero.name,|craftman,Zoe|shiori,satori.dll');
  const raw = e.M.FS.readFile('/ssp/ghost/other/ghost/master/descript.txt');
  assert.match(Buffer.from(raw).toString('hex'), /^636861727365742c53686966745f4a49530d0a/, 'charset,Shift_JIS\\r\\n first');
  assert.ok(Buffer.from(raw).toString('hex').includes('82a882c68740'), 'おと① in code page 932');
  assert.equal(evalIn(e, '${shells}|${shelldescript}'), 'master|charset,Shift_JIS|type,shell|name,master');
  assert.equal(evalIn(e, '$(isfile ../../shell/master/surface0.png)$(isfile ../../readme.txt)'), '11', 'a placeholder and a file');
});

test('SAORI: the bridge sees ghost-root paths and UTF-8 both ways; one load for every call, its unload at unload(); no stand-in -> ""', async () => {
  const calls = [];
  const saori = {
    load(p, dir) { calls.push(['load', p, dir]); return 7; },
    request(h, bytes) { calls.push(['request', h, new TextDecoder().decode(bytes)]); return 'SAORI/1.0 200 OK\r\nCharset: UTF-8\r\nResult: ①～\r\n\r\n'; },
    unload(h) { calls.push(['unload', h]); },
  };
  const e = await start({ saori });
  assert.equal(evalIn(e, '${saoricall}|${saoricall}'), '①～|①～');
  assert.deepEqual(calls[0], ['load', '/ghost/master/saori/echo.dll', '/ghost/master/saori/']);
  const executes = calls.filter(c => c[0] === 'request' && /^EXECUTE SAORI\/1\.0\r\n/.test(c[2]));
  assert.equal(executes.length, 2);
  assert.match(executes[0][2], /\r\nArgument0: ソ表～①\r\n/);
  assert.match(executes[0][2], /\r\nCharset: UTF-8\r\n/);
  assert.equal(calls.filter(c => c[0] === 'load').length, 1);
  e.unload();
  assert.deepEqual(calls.at(-1), ['unload', 7]);

  const missing = await start({ saori: { load() { return 0; }, request() { throw new Error('no'); }, unload() {} } });
  assert.equal(evalIn(missing, '[${saoricall}]'), '[]', 'as a DLL Windows cannot load');
});

test('persistence: what the ghost saves (Shift_JIS, CRLF), beside ghost/master, a rewritten shipped file that shadows, a download; never *.log', async () => {
  const e = await start();
  await tick();
  evalIn(e, '$(set memo メモ)$(save memo.txt memo)$(textsave ../../note.txt memo)$(textsave data/shipped.txt memo)$(save x.log memo)');
  e.writeMasterFile('var/dl.txt', te.encode('downloaded\r\n'));
  assert.deepEqual(shape(report(e)), {
    'ghost/master/data/shipped.txt': 'メモ\r\n',
    'ghost/master/memo.txt': '#\r\n# Kawari saved file\r\n#\r\n# Entry memo\r\nmemo : "メモ"\r\n',
    'ghost/master/var/dl.txt': 'downloaded\r\n',
    'note.txt': 'メモ\r\n',
  });
  assert.equal(evalIn(e, '$(isfile x.log)'), '1', 'the log-named file exists, but is never reported');
  assert.equal(evalIn(e, '$(textload @t var/dl.txt)$(get @t[0])'), 'downloaded');

  // the next page: the visitor's copy shadows the site's, the ghost's own files are there
  const next = await start({ persisted: e.persisted });
  assert.equal(evalIn(next, '$(textload @t data/shipped.txt)$(get @t[0])|$(isfile ../../note.txt)|$(load memo.txt)${memo}'), 'メモ|1|メモ');
  assert.deepEqual(next.changedFiles(), {}, 'restored files are no changes');
});

test('the snapshot key: absent until a save; then the entries the session changed, stamped with the dictionaries; reported when it changed; empty at unload (D7)', async () => {
  const e = await start();
  assert.equal(RESUME_KEY in e.persisted, false);
  assert.equal(hasSave(e.persisted), false, 'never met');
  assert.equal(req(e, 'OnFirstBoot').status, 200);
  assert.equal(e.save(), true);
  const snap = report(e)[RESUME_KEY];
  assert.ok(snap instanceof ArrayBuffer && snap.byteLength > 0);
  assert.equal(snapshotStamp(snap), dicStamp(e.ghost.files));
  const text = sjis.decode(snap);
  assert.match(text, /^# dicStamp [0-9a-f]{8}\n#\n# Sumika resume snapshot/);
  assert.ok(text.includes('\n# clear boots\n') && text.includes('\nboots : "1"\n'), text);
  assert.ok(text.includes('\nSystem.Debugger : "on"\n'), `load made it (\`debugger on\` in a KIS zone): carried, ${text}`);
  assert.ok(!/System\.Request|System\.DataPath|\nword :|\nevent\./.test(text), `no definition load read as it is, ${text}`);
  assert.equal(hasSave(e.persisted), true);
  assert.equal(e.save(), true);
  assert.deepEqual(report(e), {}, 'unchanged: not reported again');
  assert.match(req(e, 'OnChoiceSelect', ['talk']).value, /お話ししましょう。1回目です。/);
  e.save();
  assert.ok(sjis.decode(report(e)[RESUME_KEY]).includes('talks : "1"\n'));

  // Close: OnUnload saves the counters itself, the key becomes the empty marker (met, nothing to restore)
  assert.equal(req(e, 'OnClose').value, '\\0\\s[0]さようなら。\\-');
  const files = e.unload();
  e.persisted = mergeFiles(e.persisted, files);
  assert.deepEqual(Object.keys(files).sort(), [RESUME_KEY, 'ghost/master/save.txt']);
  assert.equal(files[RESUME_KEY].byteLength, 0);
  assert.match(sjis.decode(files['ghost/master/save.txt']), /\r\nboots : "1"\r\n# Entry talks\r\ntalks : "1"\r\n/);
  assert.equal(hasSave(e.persisted), true);
  assert.equal(e.save(), false, 'no engine after unload');

  // a ghost that never writes a file of its own is met all the same once a save ran: its snapshot holds only what its
  // load made, and with no KIS zone that writes an entry (no `debugger on` here) it is the empty marker
  const plain = fixture({ 'ghost/master/kawarirc.kis': withoutDebugger() });
  const quiet = await start({ ghost: plain });
  quiet.save();
  const marker = report(quiet);
  assert.deepEqual(Object.keys(marker), [RESUME_KEY]);
  assert.equal(marker[RESUME_KEY].byteLength, 0);
  assert.equal(hasSave(quiet.persisted), true);
  const quiet2 = await start();
  quiet2.save();
  assert.equal(sjis.decode(report(quiet2)[RESUME_KEY]).replace(/^# dicStamp \w+\n/, ''),
    '#\n# Sumika resume snapshot: the entries this session changed and those its load made (engines/kawari/em_kawari.cpp)\n#\n' +
    '# clear System.Debugger\nSystem.Debugger : "on"\n', 'nothing changed: only the entry load made');
});

test('resume: the next page restores what the session changed, without a boot; page after page; Close, then a cold boot reads the ghost\'s own save', async () => {
  const cold = await start();
  req(cold, 'OnFirstBoot');
  req(cold, 'OnChoiceSelect', ['talk']);
  req(cold, 'OnCommunicate', ['user', 'またね']);
  cold.save();
  report(cold);
  const vol = cold.getVolatileState();
  assert.deepEqual(vol, { dicStamp: dicStamp(cold.ghost.files) });

  // a page change: no unload, so the ghost saved nothing of its own
  const page2 = await start({ persisted: cold.persisted, resume: true, volatile: vol });
  assert.equal(page2.ok, true);
  assert.equal(page2.resumed, 'restored');
  assert.equal(evalIn(page2, '${boots}|${talks}|${lastword}'), '1|1|またね');
  assert.equal('ghost/master/save.txt' in page2.persisted, false);
  assert.deepEqual(infos(page2), []);
  assert.match(req(page2, 'OnChoiceSelect', ['talk']).value, /2回目です/);
  page2.save();
  const snap2 = sjis.decode(report(page2)[RESUME_KEY]);
  assert.ok(snap2.includes('talks : "2"\n') && snap2.includes('boots : "1"\n'), 'restored entries stay in the next snapshot');

  const page3 = await start({ persisted: page2.persisted, resume: true, volatile: vol });
  assert.equal(evalIn(page3, '${boots}|${talks}|${lastword}'), '1|2|またね');

  // Close, then a later visit: a cold boot from the ghost's own save (nothing left to restore)
  req(page3, 'OnClose');
  page3.persisted = mergeFiles(page3.persisted, page3.unload());
  const again = await start({ persisted: page3.persisted });
  assert.equal(again.resumed, '');
  assert.equal(evalIn(again, '${boots}|${talks}'), '1|2');
  assert.match(req(again, 'OnBoot').value, /おかえりなさい。2回目の起動です。/);
});

test('resume: an entry load sets from the clock keeps the cold boot\'s value on every later page (KEEPS\' cntwork), though the session never changed it', async () => {
  // a second KIS zone in kawarirc.kis, as KEEPS' System.Callback.OnLoad sets cntwork: `started` = the load's time
  const ghost = fixture({ 'ghost/master/kawarirc.kis': cat(fixtureBytes('ghost/master/kawarirc.kis'), '=kis\r\nsetstr started $(date %s);\r\n=end\r\n') });
  const real = Date.now;
  try {
    const cold = await start({ ghost });
    const started = evalIn(cold, '${started}');
    assert.match(started, /^\d{9,}$/);
    req(cold, 'OnFirstBoot');
    cold.save();
    const snap = sjis.decode(report(cold)[RESUME_KEY]);
    assert.ok(snap.includes(`\nstarted : "${started}"\n`), snap);
    const vol = cold.getVolatileState();

    const later = h => { Date.now = () => real() + h * 3600e3; };
    later(2);                                  // the next page, two hours later: its load sets `started` anew
    const page2 = await start({ ghost, persisted: cold.persisted, resume: true, volatile: vol });
    assert.equal(page2.resumed, 'restored');
    assert.notEqual(evalIn(page2, '$(date %s)'), started, 'the clock moved');
    assert.equal(evalIn(page2, '${started}|${boots}'), `${started}|1`);
    page2.save();
    report(page2);
    later(4);
    const page3 = await start({ ghost, persisted: page2.persisted, resume: true, volatile: vol });
    assert.equal(evalIn(page3, '${started}|${boots}'), `${started}|1`, 'still the cold boot\'s');

    // a load-made entry the session emptied stays empty on the next page
    evalIn(page3, '$(clear started)');
    page3.save();
    report(page3);
    const page4 = await start({ ghost, persisted: page3.persisted, resume: true, volatile: vol });
    assert.equal(evalIn(page4, '[${started}]'), '[]');
  } finally {
    Date.now = real;
  }
});

test('resume: a defined entry load emptied with a script stays empty on the next page; the definitions load read as they are stay out of the snapshot', async () => {
  // `clear ｶﾅ` in code page 932 (half-width kana are single bytes there)
  const ghost = fixture({ 'ghost/master/kawarirc.kis': cat(fixtureBytes('ghost/master/kawarirc.kis'), '=kis\r\nclear ', [0xb6, 0xc5], ';\r\n=end\r\n') });
  const cold = await start({ ghost });
  assert.equal(evalIn(cold, '[${ｶﾅ}]${ｱ･ｲ}'), '[]なかてん');
  cold.save();
  const snap = sjis.decode(report(cold)[RESUME_KEY]);
  assert.ok(snap.includes('\n# clear ｶﾅ\n') && !snap.includes('ｶﾅ :') && !snap.includes('ｱ･ｲ'), snap);
  const page2 = await start({ ghost, persisted: cold.persisted, resume: true, volatile: cold.getVolatileState() });
  assert.equal(evalIn(page2, '[${ｶﾅ}]${ｱ･ｲ}'), '[]なかてん');
});

test('D6: a cold boot after a session that ended without Close finishes it first: restored, closed from outside, OnUnload saves, then the cold load', async () => {
  const cold = await start();
  req(cold, 'OnFirstBoot');
  req(cold, 'OnChoiceSelect', ['talk']);
  req(cold, 'OnChoiceSelect', ['talk']);
  cold.save();
  report(cold);            // the tab closes here
  assert.equal('ghost/master/save.txt' in cold.persisted, false);
  assert.equal(cold.d6Close, null);

  const next = await start({ persisted: cold.persisted });
  assert.equal(next.ok, true);
  assert.equal(next.resumed, 'finished');
  assert.deepEqual(infos(next), [D6_FINISHED]);
  assert.deepEqual(next.d6Close.steps.map(s => `${s.id} ${s.status}`), ['OnCloseAll 204', 'OnClose 200', 'OnTranslate 204'],
    'the fixture has no OnCloseAll and no OnTranslate');
  assert.equal(typeof next.d6Close.ms, 'number');
  assert.ok(next.logs.some(l => l.level === 'debug'
    && /^kawari: closed from outside: OnCloseAll 204, OnClose 200, OnTranslate 204 \(\d+ ms\)$/.test(l.text)), JSON.stringify(next.logs));
  assert.match(sjis.decode(next.persisted['ghost/master/save.txt']), /\r\nboots : "1"\r\n# Entry talks\r\ntalks : "2"\r\n/,
    'the first report stores what OnUnload saved');
  assert.equal(next.persisted[RESUME_KEY].byteLength, 0);
  assert.equal(evalIn(next, '${boots}|${talks}'), '1|2', 'the cold load read that save');
  assert.match(req(next, 'OnBoot').value, /2回目の起動です/);

  const after = await start({ persisted: next.persisted });
  assert.equal(after.resumed, '');
  assert.equal(after.d6Close, null);
  assert.deepEqual(infos(after), [], 'the marker: nothing to finish');
});

test('D6 closes the session as ssp.exe does when Windows ends it: a ghost that saves in OnClose (the BTH family) keeps a session that ended without Close [decision: kawari-wasm.md §16]', async () => {
  // the fixture with its save moved from OnUnload to OnClose
  const ghost = fixture({
    'ghost/master/dict-event.kis': edited('ghost/master/dict-event.kis', [
      ['System.Callback.OnUnload : $(save save.txt boots talks lastword)\r\n', ''],
      ['event.OnClose : "', 'event.OnClose : $(save save.txt boots talks lastword)"'],
    ]),
  });
  // a first visit closed with Close: OnClose saves boots 1
  const first = await start({ ghost });
  req(first, 'OnFirstBoot');
  req(first, 'OnClose');
  first.persisted = mergeFiles(first.persisted, first.unload());
  assert.match(sjis.decode(first.persisted['ghost/master/save.txt']), /\r\nboots : "1"\r\n/);

  // the second visit: a cold boot from that save, two talks, then the tab closes without Close
  const second = await start({ ghost, persisted: first.persisted });
  assert.equal(second.resumed, '');
  req(second, 'OnBoot');
  req(second, 'OnChoiceSelect', ['talk']);
  req(second, 'OnChoiceSelect', ['talk']);
  assert.equal(evalIn(second, '${boots}|${talks}'), '2|2');
  second.save();
  report(second);

  // the third: D6 closes the session from its snapshot (OnClose "system" saves it), then its OnUnload (nothing here),
  // then the cold load reads that save
  const third = await start({ ghost, persisted: second.persisted });
  assert.equal(third.resumed, 'finished');
  assert.deepEqual(infos(third), [D6_FINISHED]);
  assert.deepEqual(third.d6Close.steps.map(s => `${s.id} ${s.status}`), ['OnCloseAll 204', 'OnClose 200', 'OnTranslate 204']);
  const saved = sjis.decode(third.persisted['ghost/master/save.txt']);
  assert.match(saved, /\r\nboots : "2"\r\n/, 'the second visit\'s session, saved by its OnClose');
  assert.match(saved, /\r\ntalks : "2"\r\n/);
  assert.equal(third.persisted[RESUME_KEY].byteLength, 0, 'the snapshot is done with');
  assert.equal(evalIn(third, '${boots}|${talks}'), '2|2');
  assert.match(req(third, 'OnBoot').value, /3回目の起動です/);
});

test('D6 at the session\'s end: its close and OnUnload read the time the last session ended (sessionEndMs), as ssp.exe runs them while Windows ends the session; the cold load and every request after it the real time', async () => {
  // OnClose and OnUnload stamp the time, as bthver.5's OnClose (CoEndtime) and KEEPS' OnUnload (endtime) do
  const ghost = fixture({
    'ghost/master/dict-event.kis': edited('ghost/master/dict-event.kis', [
      ['System.Callback.OnUnload : $(save save.txt boots talks lastword)',
        'System.Callback.OnUnload : $(setstr unloadedat $(date %s))$(save save.txt boots talks lastword closedat unloadedat)'],
      ['event.OnClose : "', 'event.OnClose : $(setstr closedat $(date %s))"'],
    ]),
  });
  const real = Date.now;
  let now = new Date(2026, 8, 1, 20, 0).getTime();
  Date.now = () => now;
  try {
    const cold = await start({ ghost });
    req(cold, 'OnFirstBoot');
    req(cold, 'OnChoiceSelect', ['talk']);
    cold.save();
    report(cold);                             // the tab closes here
    const end = now += 30 * 60e3;             // the ghost state's last write: pagehide
    now += 3 * 86400e3;                       // the next visit, three days later
    const saved = e => sjis.decode(e.persisted['ghost/master/save.txt']);

    const next = await start({ ghost, persisted: cold.persisted, sessionEndMs: end });
    assert.equal(next.ok, true);
    assert.equal(next.resumed, 'finished');
    assert.deepEqual(next.d6Close.steps.map(s => `${s.id} ${s.status}`), ['OnCloseAll 204', 'OnClose 200', 'OnTranslate 204']);
    assert.equal(next.d6At, end);
    assert.equal(Date.now(), now, 'the real clock is back');
    assert.match(saved(next), new RegExp(`\\r\\nclosedat : "${end / 1000}"\\r\\n`), 'OnClose ran at the session\'s end');
    assert.match(saved(next), new RegExp(`\\r\\nunloadedat : "${end / 1000}"\\r\\n`), 'and OnUnload');
    assert.match(saved(next), /\r\nboots : "1"\r\n# Entry talks\r\ntalks : "1"\r\n/, 'the session is kept');
    assert.equal(+next.M.FS.stat(next.ghostDir + 'save.txt').mtime, end, 'MEMFS stamped the save then; the first report has it all the same');
    assert.ok(next.logs.some(l => l.level === 'debug' && l.text === 'kawari: closed at the session\'s end, 4320 min before this boot'),
      JSON.stringify(next.logs));
    assert.deepEqual(infos(next), [D6_FINISHED]);
    assert.equal(evalIn(next, '$(date %s)'), String(now / 1000), 'requests after the boot see the real time');
    assert.equal(evalIn(next, '${closedat}|${boots}|${talks}'), `${end / 1000}|1|1`, 'the cold load read that save');
    assert.deepEqual(report(next), {}, 'nothing reported twice');

    // no end time known (0, NaN), or one not before now (the clock was set back): the real clock
    for (const sessionEndMs of [0, NaN, now, now + 60e3]) {
      const e = await start({ ghost, persisted: cold.persisted, sessionEndMs });
      assert.equal(e.resumed, 'finished', String(sessionEndMs));
      assert.equal(e.d6At, 0);
      assert.match(saved(e), new RegExp(`\\r\\nclosedat : "${now / 1000}"\\r\\n# Entry unloadedat\\r\\nunloadedat : "${now / 1000}"\\r\\n`),
        String(sessionEndMs));
      assert.ok(!e.logs.some(l => /closed at the session's end/.test(l.text)));
      assert.equal(Date.now(), now);
    }
    // a resume never closes: the end time does nothing there
    const page = await start({ ghost, persisted: cold.persisted, resume: true, volatile: cold.getVolatileState(), sessionEndMs: end });
    assert.deepEqual([page.resumed, page.d6At, page.d6Close], ['restored', 0, null]);
  } finally {
    Date.now = real;
  }
});

test('runAt: Date.now runs on from the start given and comes back, also after a throw; a start not before now (0, NaN, now, the future) leaves the clock alone', () => {
  const real = Date.now;
  let now = 1_800_000_000_000;
  const fake = () => now;
  Date.now = fake;
  try {
    const seen = [];
    const start = now - 86400e3;
    assert.equal(runAt(start, () => { seen.push(Date.now()); now += 5; seen.push(Date.now()); }), start);
    assert.deepEqual(seen, [start, start + 5], 'it runs on (successive writes keep distinct mtimes)');
    assert.equal(Date.now, fake, 'the clock it had');
    assert.throws(() => runAt(now - 1000, () => { throw new Error('boom'); }), /boom/);
    assert.equal(Date.now, fake, 'restored after a throw');
    for (const start of [0, -5, NaN, undefined, '1000', now, now + 60e3]) {
      let t = null;
      assert.equal(runAt(start, () => { t = Date.now(); }), 0, String(start));
      assert.equal(t, now, String(start));
    }
    assert.equal(Date.now, fake);
  } finally {
    Date.now = real;
  }
});

test('D6\'s close request by request: OnCloseAll [system, 0, 0] BaseID OnClose, OnClose on its 204, OnTranslate on the script that answered; a ghost whose OnCloseAll answers gets no OnClose', async () => {
  const sent = async ghost => {
    const cold = await start({ ghost });
    req(cold, 'OnFirstBoot');
    cold.save();
    report(cold);          // the tab closes here
    const e = await engine({ ghost });
    const texts = [];
    const request = e.request.bind(e);
    e.request = (text, meta) => { texts.push(text); return request(text, meta); };
    assert.equal(e.init(ghost.files, cold.persisted, { resume: false }), true);
    e.persisted = mergeFiles(cold.persisted, e.changedFiles());
    assert.equal(e.resumed, 'finished');
    e.texts = texts;
    return e;
  };
  const e = await sent(fixture());
  assert.deepEqual(END_SESSION_REFS, ['system', '0', '0']);
  assert.deepEqual(e.texts, [
    'GET SHIORI/3.0\r\nCharset: UTF-8\r\nSender: SSP\r\nSenderType: internal\r\nSecurityLevel: local\r\nBaseID: OnClose\r\n'
      + 'ID: OnCloseAll\r\nReference0: system\r\nReference1: 0\r\nReference2: 0\r\n\r\n',
    endSessionRequest('OnClose'),
    // the raw reply (TranslateParam runs later in ssp.exe), R1 written empty, R2 the event that answered, R3 the reason
    'GET SHIORI/3.0\r\nCharset: UTF-8\r\nSender: SSP\r\nSenderType: internal\r\nSecurityLevel: local\r\nID: OnTranslate\r\n'
      + 'Reference0: \\0\\s[0]さようなら。\\-\r\nReference1: \r\nReference2: OnClose\r\nReference3: system\r\n\r\n',
  ]);
  assert.equal(e.texts[1], buildRequest({ id: 'OnClose', refs: ['system', '0', '0'] }, BASE_HEADERS));

  // a ghost that answers OnCloseAll: no OnClose; what Kawari read of the request, saved by its OnUnload
  const ghost = fixture({
    'ghost/master/dict-event.kis': edited('ghost/master/dict-event.kis', [
      ['System.Callback.OnUnload : $(save save.txt boots talks lastword)', 'System.Callback.OnUnload : $(save save.txt boots talks lastword closedby)'],
      ['event.OnClose : "', 'event.OnCloseAll : $(setstr closedby ${System.Request.ID}/${System.Request.Reference0}/'
        + '${System.Request.Reference1}/${System.Request.Reference2}/${System.Request.BaseID}/${System.Request.SenderType})'
        + '"\\0bye\\-"\r\nevent.OnClose : "'],
    ]),
  });
  const all = await sent(ghost);
  assert.deepEqual(all.texts.map(t => /\r\nID: (\w+)\r\n/.exec(t)[1]), ['OnCloseAll', 'OnTranslate']);
  assert.match(all.texts[1], /\r\nReference0: \\0bye\\-\r\nReference1: \r\nReference2: OnCloseAll\r\nReference3: system\r\n/);
  assert.deepEqual(all.d6Close.steps.map(s => `${s.id} ${s.status}`), ['OnCloseAll 200', 'OnTranslate 204']);
  assert.match(sjis.decode(all.persisted['ghost/master/save.txt']), /\r\nclosedby : "OnCloseAll\/system\/0\/0\/OnClose\/internal"\r\n/);
});

test('D6 with a runaway OnClose: it answers 500 (stack restored), no OnTranslate, the unload still saves and the boot goes on', async () => {
  const ghost = fixture({ 'ghost/master/dict-event.kis': edited('ghost/master/dict-event.kis', [['event.OnClose : "', 'event.OnClose : ${rec}"']]) });
  const cold = await start({ ghost });
  req(cold, 'OnFirstBoot');
  req(cold, 'OnChoiceSelect', ['talk']);
  req(cold, 'OnChoiceSelect', ['talk']);
  cold.save();
  report(cold);

  const next = await start({ ghost, persisted: cold.persisted });
  assert.equal(next.ok, true);
  assert.equal(next.resumed, 'finished');
  assert.deepEqual(next.d6Close.steps.map(s => `${s.id} ${s.status}`), ['OnCloseAll 204', 'OnClose 500']);
  assert.ok(next.logs.some(l => l.level === 'error' && /^request: RangeError/.test(l.text)), JSON.stringify(next.logs));
  assert.match(sjis.decode(next.persisted['ghost/master/save.txt']), /\r\nboots : "1"\r\n# Entry talks\r\ntalks : "2"\r\n/,
    'OnUnload saved the session');
  assert.equal(next.persisted[RESUME_KEY].byteLength, 0);
  const boot = req(next, 'OnBoot');
  assert.equal(boot.status, 200);
  assert.match(boot.value, /2回目の起動です/);
});

test('the scan for changed files runs only after a request that wrote: none for a request that wrote nothing or for the snapshot; a save is reported', async () => {
  const e = await start();
  let scans = 0;
  const scan = e.scan.bind(e);
  e.scan = () => { scans++; return scan(); };
  await tick();
  report(e);                // a file stamped in the millisecond of init's report is looked at once more
  scans = 0;
  for (let i = 0; i < 5; i++) {
    assert.equal(req(e, 'OnMouseDoubleClick').status, 200);
    assert.deepEqual(report(e), {});
  }
  assert.equal(evalIn(e, '${word}'), 'ソ表能～－①＼髙');
  assert.deepEqual(report(e), {});
  assert.equal(scans, 0, 'requests that wrote nothing');
  req(e, 'OnFirstBoot');
  e.save();
  assert.deepEqual(Object.keys(report(e)), [RESUME_KEY]);
  assert.equal(scans, 0, 'the snapshot lies outside the ghost root');

  await tick();
  evalIn(e, '$(save memo.txt word)');
  assert.deepEqual(Object.keys(report(e)), ['ghost/master/memo.txt']);
  assert.equal(scans, 1);
  await tick();
  e.writeMasterFile('var/dl.txt', te.encode('downloaded\r\n'));
  assert.deepEqual(Object.keys(report(e)), ['ghost/master/var/dl.txt']);
  req(e, 'OnClose');
  assert.deepEqual(Object.keys(e.unload()).sort(), [RESUME_KEY, 'ghost/master/save.txt']);
});

test('scan() lists what a walk by path lists (FS.readdir, FS.stat): every file under the ghost root with mtime, size and inode', async () => {
  const e = await start();
  evalIn(e, '$(save memo.txt word)$(textsave ../../note.txt word)');
  const FS = e.M.FS;
  const byPath = new Map();
  (function walk(dir) {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const st = FS.stat(dir + name);
      if (FS.isDir(st.mode)) walk(dir + name + '/');
      else byPath.set((dir + name).slice(e.ghostRoot.length), `${+st.mtime}:${st.size}:${st.ino}`);
    }
  })(e.ghostRoot);
  assert.deepEqual([...e.scan()], [...byPath]);
  assert.ok(byPath.has('ghost/master/memo.txt') && byPath.has('note.txt') && byPath.has('shell/master/surface0.png'));
});

test('the dictionary stamp: a resume after a site update loads cold and drops the snapshot (no D6); a cold boot drops a snapshot of other dictionaries', async () => {
  const cold = await start();
  req(cold, 'OnChoiceSelect', ['talk']);
  cold.save();
  report(cold);
  const vol = cold.getVolatileState();
  const updated = fixture({ 'ghost/master/dict-test.kis': cat(fixtureBytes('ghost/master/dict-test.kis'), 'added : yes\r\n') });

  const resumed = await start({ ghost: updated, persisted: cold.persisted, resume: true, volatile: vol });
  assert.equal(resumed.ok, true);
  assert.deepEqual(infos(resumed), [STAMP_CHANGED]);
  assert.equal(resumed.resumed, 'dropped');
  assert.equal(evalIn(resumed, '[${talks}]${added}'), '[]yes');
  assert.equal(resumed.persisted[RESUME_KEY].byteLength, 0, 'the old snapshot is gone, the ghost still met');
  assert.equal('ghost/master/save.txt' in resumed.persisted, false, 'no OnUnload ran');
  assert.notEqual(resumed.getVolatileState().dicStamp, vol.dicStamp);

  const coldUpdated = await start({ ghost: updated, persisted: cold.persisted });
  assert.equal(coldUpdated.resumed, 'dropped');
  assert.deepEqual(infos(coldUpdated), [OTHER_DICTS]);
  assert.equal('ghost/master/save.txt' in coldUpdated.persisted, false);
  assert.equal(evalIn(coldUpdated, '[${talks}]'), '[]');
});

test('logs: a dictionary error reaches onEngineLog with its kind and the console only at debug; logfile writes no file; getenv finds nothing', async () => {
  const e = await start({ ghost: fixture({ 'ghost/master/dict-test.kis': cat(fixtureBytes('ghost/master/dict-test.kis'), 'no colon here\r\n') }) });
  assert.equal(e.ok, true);
  const errors = e.engineLog.filter(l => l.mode === 'error');
  assert.ok(errors.length > 0 && errors.every(l => /dict-test\.kis \d+: error: /.test(l.text)), JSON.stringify(e.engineLog));
  assert.ok(e.logs.some(l => l.level === 'debug' && /^kawari: .*dict-test\.kis \d+: error: /.test(l.text)));
  assert.ok(!e.logs.some(l => l.level !== 'debug' && /kawari/.test(l.text)));

  e.engineLog.length = 0;
  evalIn(e, '$(logfile kawari.log)$(load nothere.kis)$(logfile)');
  assert.ok(e.engineLog.some(l => l.mode === 'log' && l.text.includes('nothere.kis')), JSON.stringify(e.engineLog));
  assert.equal(e.M.FS.analyzePath(e.ghostDir + 'kawari.log').exists, false);
  assert.ok(![...e.scan().keys()].some(p => /\.log$/i.test(p)));
  assert.equal(evalIn(e, '[$(getenv HOME)$(getenv PATH)$(getenv USER)]'), '[]');
});

test('the stack restore: 40 runaway recursions answer 500 with the stack pointer back where it was; the engine answers on', async () => {
  const e = await start();
  const M = e.M;
  const sp0 = M.stackSave();
  for (let i = 0; i < 40; i++) {
    assert.equal(req(e, 'ShioriEcho', ['${rec}']).status, 500);
    assert.equal(M.stackSave(), sp0);
  }
  assert.equal(e.logs.filter(l => l.level === 'error' && /^request: RangeError/.test(l.text)).length, 40);
  assert.equal(evalIn(e, '${word}|$(length ソ表)'), 'ソ表能～－①＼髙|2');

  // what the guard repairs: a throw straight out of _request leaves the stack pointer down
  const b = te.encode(buildRequest({ id: 'ShioriEcho', refs: ['${rec}'] }, HEADERS));
  const p = e._toHeap(b);
  const lenp = M._malloc(4);
  M.HEAP32[lenp >> 2] = b.length;
  assert.throws(() => M._request(p, lenp), RangeError);
  assert.notEqual(M.stackSave(), sp0);
  M.stackRestore(sp0);
  M._free(lenp);
  assert.equal(evalIn(e, '${word}'), 'ソ表能～－①＼髙');
});

test('the request buffer: the heap probe stays in place over 5,000 requests (request frees its input, we free the reply)', async () => {
  const e = await start();
  const M = e.M;
  const probe = () => { const p = M._malloc(1 << 20); M._free(p); return p; };
  for (let i = 0; i < 100; i++) req(e, 'OnMouseDoubleClick');
  const p0 = probe();
  const heap0 = M.HEAPU8.length;
  for (let i = 0; i < 5000; i++) assert.equal(req(e, 'OnMouseDoubleClick').status, 200);
  assert.equal(probe(), p0);
  assert.equal(M.HEAPU8.length, heap0);
});

// Kawari 7's engine adapter (src/worker/engines/kawari7.js) on the real build (site/sumika/engines/kawari7.js) in Node,
// with our own Shift_JIS Phase 7 ghost tests/fixtures/ghost/kawari7test (kawari7-wasm.md): load and ssp.exe's
// handshake, a missing kawari.ini, the page's SHIORI/3.0 calls through the SHIORI/2.x bridge (code page 932 both ways),
// the save, the snapshot and the resume, D6 (its end-of-session close through the bridge, at the session's end), unload.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kawari7Engine, RESUME_KEY7 } from '../src/worker/engines/kawari7.js';
import { snapshotStamp, D6_FINISHED } from '../src/worker/engines/kawari.js';
import { buildRequest, parseResponse } from '../src/core/shiori.js';
import { communicateOf } from '../src/core/events.js';
import { loadEngineFactory } from './load_engine.mjs';

globalThis.self = globalThis.self || { postMessage() {} };      // worker.js touches self at import
const { mergeFiles, hasSave } = await import('../src/worker/worker.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'kawari7.js');
const FIXTURE = path.join(root, 'tests', 'fixtures', 'ghost', 'kawari7test');
const HEADERS = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
const SITE = {
  ghosts: [{ id: 'kawari7test', name: 'Kawari7 Test', sakuraName: 'なな', keroName: 'ケロ', craftman: 'Sumika tests', shiori: 'shiori.dll' }],
  balloons: ['sumika'],
};
const TEXT = /\.(txt|ini|kis|dic)$/i;
const te = new TextEncoder();
const sjis = new TextDecoder('shift_jis');

class NodeKawari7 extends Kawari7Engine {
  async factory() { return loadEngineFactory('kawari7'); }
}

const fixtureBytes = p => fs.readFileSync(path.join(FIXTURE, p));

/** The fixture as the runtime hands it to the worker; `replace` adds or replaces files (null drops one). */
function fixture(replace = {}) {
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else list.push(rel + e.name);
    }
  })(FIXTURE, '');
  const files = new Map(list.filter(p => TEXT.test(p)).map(p => [p, fixtureBytes(p)]));
  for (const [p, v] of Object.entries(replace)) {
    if (v === null) files.delete(p);
    else files.set(p, typeof v === 'string' ? te.encode(v) : v);
  }
  return {
    files: [...files].map(([p, b]) => ({ path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) })),
    placeholders: list.filter(p => !TEXT.test(p)),
  };
}

/**
 * A booted and initialised NodeKawari7; the first report merged into e.persisted, as the worker does. `before(e)` runs
 * after the boot, before init; sessionEndMs: the page's (the ghost state's savedAt on a cold boot).
 */
async function start({ ghost = fixture(), persisted = {}, resume = false, volatile = null, before = null, sessionEndMs = 0 } = {}) {
  if (!fs.existsSync(ENGINE_JS)) throw new Error('site/sumika/engines/kawari7.js is missing: run python engines/kawari7/build.py');
  const logs = [];
  const e = new NodeKawari7({
    engineUrl: ENGINE_JS, log: (level, text) => logs.push({ level, text }), onEngineLog: () => {},
    opts: { ghostId: 'kawari7test', placeholders: ghost.placeholders, site: SITE },
  });
  await e.boot();
  e.logs = logs;
  if (before) before(e);
  e.ok = e.init(ghost.files, persisted, { resume: resume && hasSave(persisted), volatile: resume ? volatile : null, sessionEndMs });
  e.persisted = mergeFiles(persisted, e.changedFiles());
  return e;
}

/** The page's request through the adapter, as the worker passes it (kind, self). */
const ask = (e, id, refs = [], { method = 'GET', headers = {}, kind = '', self = '' } = {}) =>
  parseResponse(e.request(buildRequest({ id, refs, method, headers }, HEADERS), { kind, self }));
/** a word of the dictionary (`debug : debugger`'s ShioriEcho evaluates Reference0) */
const word = (e, name) => {
  const r = ask(e, 'ShioriEcho', [`\${${name}}`]);
  return r.status === 200 ? r.value.replace(/\\e$/, '') : `status ${r.status}`;
};
const report = e => {
  const ch = e.changedFiles();
  e.persisted = mergeFiles(e.persisted, ch);
  return ch;
};

test('load: kawari.ini loads the dictionary; ssp.exe\'s handshake gives SHIORI/2.6, Shift_JIS and the ID; no kawari.ini fails with a warn line', async () => {
  const e = await start();
  assert.equal(e.ok, true);
  assert.deepEqual(e.logs.filter(l => l.level !== 'debug'), []);
  assert.deepEqual({ ...e.session }, { version: 26, charset: 'Shift_JIS', name: 'KAWARI.kdt.i18n', craftman: 'KawariDevelopmentTeam' });
  assert.ok(e.entries > 10, `entries ${e.entries}`);
  assert.ok(e.logs.some(l => l.level === 'debug' && /^kawari7: module \d+ ms, load \d+ ms, stamp \d+ ms, heap 32 MB, 6 files \d+ KB, 1 placeholders, \d+ entries$/.test(l.text)),
    JSON.stringify(e.logs));
  assert.deepEqual(e.persisted, {}, 'load wrote nothing');
  assert.equal(word(e, 'bootcount'), '1', 'system.OnLoad ran');

  const upper = await start({ ghost: fixture({ 'ghost/master/kawari.ini': null, 'ghost/master/KAWARI.INI': fixtureBytes('ghost/master/kawari.ini') }) });
  assert.equal(upper.ok, true, 'Windows finds it in any case');

  const none = await start({ ghost: fixture({ 'ghost/master/kawari.ini': null }) });
  assert.equal(none.ok, false);
  assert.deepEqual(none.logs.filter(l => l.level === 'warn').map(l => l.text), ['no kawari.ini: nothing to load']);
});

test('the page\'s calls through the bridge: events with References in code page 932, the NOTIFYs, resources, translate, teach, both communicates', async () => {
  const e = await start();
  // what ssp.exe never sends a 2.x SHIORI: 204 without asking
  assert.equal(ask(e, 'basewareversion', ['2.9.10', 'SSP'], { method: 'NOTIFY' }).status, 204);
  ask(e, 'ownerghostname', ['なな'], { method: 'NOTIFY' });
  ask(e, 'otherghostname', ['おと\x010\x0110'], { method: 'NOTIFY' });
  const first = ask(e, 'OnFirstBoot', [0]);
  assert.equal(first.status, 200);
  assert.equal(first.protocol, 2.6);
  assert.equal(first.value, '\\0\\s[0]はじめまして、ななです。\\1\\s[10]ケロだよ。\\e', 'system.Ghost from NOTIFY OwnerGhostName');
  assert.equal(ask(e, 'OnTest', ['ソ表①', '～髙', undefined, undefined, undefined, undefined, undefined, 'r7', 'r8']).value,
    'ソ表①|～髙|r7|SSP|local|OnTest\\e', '0x5C trail bytes and IBM/NEC codes; Kawari reads Reference0–7');
  assert.equal(ask(e, 'OnOther').value, 'おと\\e');
  assert.equal(ask(e, 'OnSecondChange', [0, 0, 0, 0, 0]).status, 204, 'an event the ghost lacks');
  assert.equal(ask(e, 'version', [], { kind: 'resource' }).status, 204, 'GET String ID: version: Kawari has no resource.version');
  assert.equal(ask(e, 'homeurl', [], { kind: 'resource' }).value, 'http://example.invalid/kawari7test/');
  assert.equal(ask(e, 'sakura.recommendsites', [], { kind: 'resource' }).value, '華和梨\x01http://example.invalid/');
  assert.equal(ask(e, 'OnTranslate', ['\\0abc\\e', '', 'OnBoot'], { kind: 'translate' }).value, '\\0abc\\eにゃ');
  assert.equal(ask(e, 'OnTeach', ['りんご'], { kind: 'teach' }).value, '教わった:りんご\\e');
  assert.equal(ask(e, 'OnCommunicate', ['user', 'こんにちは'], { kind: 'communicate-user' }).value, '返事:こんにちは|User|\\e',
    'the communicate box: Sender User, no Age');
  // its own talk to another ghost: To and Reference0 from the reply, Reference0 no target (2.x)
  const talk = ask(e, 'OnTalk');
  assert.deepEqual(communicateOf(talk), { to: 'おと', shifted: false, sentence: '話しかけ\\e', refs: ['ソ表'], age: '0', marker: '' });
  // another ghost's COMMUNICATE: Sender and To; Kawari answers back to a sender it knows (Age + 1)
  const back = ask(e, 'OnCommunicate', ['おと', 'やあ'], { headers: { Age: '0' }, kind: 'communicate', self: 'なな' });
  assert.equal(back.value, '返事:やあ|おと|0\\e');
  assert.deepEqual(communicateOf(back), { to: 'おと', shifted: false, sentence: '返事:やあ|おと|0\\e', refs: [], age: '1', marker: '' });
});

test('a %ms-style word through the bridge: GET Word with Type \\ms reads compatible.ms (Shift_JIS), 204 for a type the ghost lacks', async () => {
  const e = await start();
  const w = (type, headers = {}) => ask(e, type, [], { kind: 'word', headers });
  const ms = w('\\ms', { Status: 'talking' });
  assert.deepEqual([ms.status, ms.protocol, ms.value, ms.headers.get('word')], [200, 2.6, '鈴木', '鈴木'],
    'Kawari 7\'s `Word` header, read as the Value');
  assert.equal(w('\\m').value, '何か');
  assert.equal(w('\\dms').value, '%msの影', 'a word with a variable in it comes back as written (the page expands it)');
  assert.equal(w('\\m?').status, 204, 'compatible.m? is no entry: the page asks \\m next');
  assert.equal(w('\\ml').status, 204, 'compatible.ml: none in the fixture');
  assert.equal(w('\\mz').value, null);
  // the type goes as it is: without the backslash Kawari would read `compatible.s` (Type's first character is cut)
  assert.equal(w('ms').status, 204);
});

test('persistence: what the ghost saves (Shift_JIS, CRLF) is reported; the snapshot key carries the entries the session changed', async () => {
  const e = await start();
  assert.equal(ask(e, 'OnCount').value, '1\\e');
  assert.equal(ask(e, 'OnCount').value, '2\\e');
  assert.equal(ask(e, 'OnSave').value, 'saved\\e');
  const ch = report(e);
  assert.deepEqual(Object.keys(ch), ['ghost/master/save.txt']);
  const saved = sjis.decode(ch['ghost/master/save.txt']);
  assert.match(saved, /^# Kawari saved file\r$/m);
  assert.match(saved, /^counter : "2"\r$/m);
  assert.match(saved, /^bootcount : "1"\r$/m);
  assert.equal(e.save(), true);
  const snap = report(e)[RESUME_KEY7];
  assert.ok(snap && snap.byteLength > 0);
  assert.equal(snapshotStamp(snap), e.dicStamp);
  const text = sjis.decode(snap);
  assert.match(text, /^K7SNAP 1$/m);
  assert.match(text, /^E counter\nW "2"$/m);
  e.save();
  assert.deepEqual(Object.keys(report(e)), [], 'an unchanged snapshot is not reported again');
});

test('resume: the next page restores what the session changed, without a boot event; Close (unload) leaves the empty marker; a cold boot reads the save', async () => {
  const e = await start();
  ask(e, 'OnCount');
  ask(e, 'OnCount');
  ask(e, 'OnCount');
  e.save();
  report(e);
  const vol = e.getVolatileState();

  const p2 = await start({ persisted: e.persisted, resume: true, volatile: vol });
  assert.equal(p2.resumed, 'restored');
  assert.equal(word(p2, 'counter'), '3', 'restored from the snapshot');
  assert.equal(word(p2, 'bootcount'), '1', 'the load\'s own count comes back as the snapshot had it');
  ask(p2, 'OnCount');
  const files = p2.unload();
  p2.persisted = mergeFiles(p2.persisted, files);
  assert.equal(p2.persisted[RESUME_KEY7].byteLength, 0, 'the empty marker: met, nothing to restore');
  assert.match(sjis.decode(p2.persisted['ghost/master/save.txt']), /^counter : "4"\r$/m, 'system.OnUnload saved');

  const cold = await start({ persisted: p2.persisted });
  assert.equal(cold.resumed, '');
  assert.equal(word(cold, 'counter'), '4', 'system.OnLoad loads save.txt');
  assert.equal(word(cold, 'bootcount'), '2');
});

test('D6: a cold boot after a session that ended without Close finishes it first (restored, closed from outside, system.OnUnload saves), then loads cold', async () => {
  const e = await start();
  ask(e, 'OnCount');
  ask(e, 'OnCount');
  e.save();
  report(e);
  assert.equal(e.persisted['ghost/master/save.txt'], undefined, 'the ghost saved nothing yet');

  const next = await start({ persisted: e.persisted });
  assert.equal(next.resumed, 'finished');
  assert.deepEqual(next.logs.filter(l => l.level === 'info').map(l => l.text), [D6_FINISHED]);
  assert.deepEqual(next.d6Close.steps.map(s => `${s.id} ${s.status}`), ['OnCloseAll 204', 'OnClose 200', 'OnTranslate 200'],
    'the fixture defines system.OnTranslate');
  assert.match(sjis.decode(next.persisted['ghost/master/save.txt']), /^counter : "2"\r$/m);
  assert.equal(next.persisted[RESUME_KEY7].byteLength, 0);
  assert.equal(word(next, 'counter'), '2');
  assert.equal(word(next, 'bootcount'), '2', 'the load after D6\'s unload counted');
  assert.equal(next.session.version, 26, 'the handshake again after that load');
});

test('D6 on a Phase 7 ghost that saves in event.OnClose: the close goes to the engine as ssp.exe sends it a SHIORI/2.x DLL, and the session survives [decision: kawari-wasm.md §16]', async () => {
  let dict = fixtureBytes('ghost/master/dict.txt').toString('latin1');
  for (const [from, to] of [
    ['system.OnUnload : $(save save.txt counter bootcount)\r\n', ''],
    ['event.OnClose : ', 'event.OnClose : $(save save.txt counter bootcount)'],
  ]) {
    assert.ok(dict.includes(from), from);
    dict = dict.replace(from, to);
  }
  const ghost = fixture({ 'ghost/master/dict.txt': Buffer.from(dict, 'latin1') });
  const e = await start({ ghost });
  ask(e, 'OnCount');
  ask(e, 'OnCount');
  ask(e, 'OnCount');
  e.save();
  report(e);               // the tab closes here

  const sent = [];
  const next = await start({
    ghost, persisted: e.persisted,
    before: k => {
      const exchange = k._exchange.bind(k);
      k._exchange = (text, cs) => { sent.push(text); return exchange(text, cs); };
    },
  });
  assert.equal(next.resumed, 'finished');
  assert.deepEqual(sent.filter(t => /^(GET Sentence|TRANSLATE)/.test(t)), [
    'GET Sentence SHIORI/2.2\r\nCharset: Shift_JIS\r\nSecurityLevel: local\r\nSender: SSP\r\nEvent: OnCloseAll\r\nBaseEvent: OnClose\r\n'
      + 'Reference0: system\r\nReference1: 0\r\nReference2: 0\r\n\r\n',
    'GET Sentence SHIORI/2.2\r\nCharset: Shift_JIS\r\nSecurityLevel: local\r\nSender: SSP\r\nEvent: OnClose\r\n'
      + 'Reference0: system\r\nReference1: 0\r\nReference2: 0\r\n\r\n',
    'TRANSLATE Sentence SHIORI/2.6\r\nCharset: Shift_JIS\r\nSecurityLevel: local\r\nSecurityOrigin: null\r\nSender: SSP\r\n'
      + 'Sentence: \\0\\s[0]またね。\\-\\e\r\n\r\n',
  ]);
  assert.deepEqual(next.d6Close.steps.map(s => `${s.id} ${s.status}`), ['OnCloseAll 204', 'OnClose 200', 'OnTranslate 200']);
  assert.match(sjis.decode(next.persisted['ghost/master/save.txt']), /^counter : "3"\r$/m, 'event.OnClose saved the session');
  assert.equal(word(next, 'counter'), '3');
  assert.equal(word(next, 'bootcount'), '2');
});

test('D6 at the session\'s end through the bridge: system.OnUnload reads the time the last session ended (sessionEndMs), every request after the boot the real time', async () => {
  // Kawari 7's date has no %s: the minute
  let dict = fixtureBytes('ghost/master/dict.txt').toString('latin1');
  const from = 'system.OnUnload : $(save save.txt counter bootcount)';
  assert.ok(dict.includes(from), from);
  dict = dict.replace(from, 'system.OnUnload : $(set closedat $(date %Y%m%d%H%M))$(save save.txt counter bootcount closedat)');
  const ghost = fixture({ 'ghost/master/dict.txt': Buffer.from(dict, 'latin1') });
  const p2 = n => String(n).padStart(2, '0');
  const minute = t => { const d = new Date(t); return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`; };
  const real = Date.now;
  let now = new Date(2026, 8, 1, 20, 0).getTime();
  Date.now = () => now;
  try {
    const e = await start({ ghost });
    ask(e, 'OnCount');
    ask(e, 'OnCount');
    e.save();
    report(e);                                // the tab closes here
    const end = now += 30 * 60e3;             // the ghost state's last write: pagehide
    now += 3 * 86400e3 + 7 * 60e3;            // the next visit

    const next = await start({ ghost, persisted: e.persisted, sessionEndMs: end });
    assert.equal(next.resumed, 'finished');
    assert.deepEqual(next.d6Close.steps.map(s => `${s.id} ${s.status}`), ['OnCloseAll 204', 'OnClose 200', 'OnTranslate 200']);
    assert.equal(next.d6At, end);
    assert.equal(Date.now(), now, 'the real clock is back');
    const saved = sjis.decode(next.persisted['ghost/master/save.txt']);
    assert.match(saved, new RegExp(`^closedat : "${minute(end)}"\\r$`, 'm'), '202609012030: the session\'s end');
    assert.match(saved, /^counter : "2"\r$/m);
    assert.equal(word(next, 'closedat'), minute(end), 'system.OnLoad loaded that save');
    assert.equal(word(next, 'bootcount'), '2');
    const echo = ask(next, 'ShioriEcho', ['$(date %Y%m%d%H%M)']);
    assert.equal(echo.value.replace(/\\e$/, ''), minute(now), 'requests after the boot see the real time');
    assert.ok(next.logs.some(l => l.level === 'debug' && l.text === 'kawari7: closed at the session\'s end, 4327 min before this boot'),
      JSON.stringify(next.logs));
  } finally {
    Date.now = real;
  }
});

test('a snapshot of other dictionaries is dropped; the Phase 8 key is not Kawari 7\'s', async () => {
  const e = await start();
  ask(e, 'OnCount');
  e.save();
  report(e);
  const changed = fixture({ 'ghost/master/dict.txt': Buffer.concat([fixtureBytes('ghost/master/dict.txt'), Buffer.from('extra : x\r\n')]) });
  const next = await start({ ghost: changed, persisted: e.persisted, resume: true, volatile: e.getVolatileState() });
  assert.equal(next.resumed, 'dropped', 'a site update: cold, no D6');
  assert.equal(word(next, 'counter'), '', 'the session\'s count is gone');
  assert.notEqual(RESUME_KEY7, '?kawari/resume.kis');
});

test('one unload (patch C9): a second unload is no crash, a request after it answers 500', async () => {
  const e = await start();
  e.unload();
  e.unload();
  assert.deepEqual(e.logs.filter(l => l.level === 'error'), []);
  assert.equal(ask(e, 'OnBoot').status, 500);
});

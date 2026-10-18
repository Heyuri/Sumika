// Smoke test of a Kawari 7 build (engines/kawari7/build.py), straight on the C exports: load, SHIORI/2.x requests in
// code page 932 (GET Version, GET Sentence with Event, GET String, NOTIFY OwnerGhostName / OtherGhostName, TEACH,
// TRANSLATE, communicate), CRLF and Ctrl+Z reads (C4), save in CRLF (C4), readdir names back in 932 (C5), the log
// (C6), SAORI (C3), the resume snapshot (C7), unload and reload.
//   node engines/kawari7/smoke.mjs [DIR]      DIR holds kawari7.js + kawari7.wasm (default site/sumika/engines)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.resolve(process.argv[2] || path.join(root, 'site', 'sumika', 'engines'));
const enc = new TextEncoder();
const GHOST = '/ssp/ghost/テスト/ghost/master/';
const CRLF = '\r\n';

function loadFactory(file) {
  const mod = { exports: {} };
  const fn = vm.runInThisContext(`(function (module, exports, require, __dirname, __filename) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  fn(mod, mod.exports, createRequire(file), path.dirname(file), file);
  return mod.exports;
}
const factory = loadFactory(path.join(dir, 'kawari7.js'));

async function boot(files, extra = {}) {
  const logs = [];
  const M = await factory({ print: () => {}, printErr: () => {}, kawariLog: t => logs.push(t), ...extra });
  const heap = b => { const p = M._malloc(b.length + 1); M.HEAPU8.set(b, p); M.HEAPU8[p + b.length] = 0; return p; };
  const conv = (fn, b) => {
    const p = heap(b), lenp = M._malloc(4);
    const r = fn(p, b.length, lenp);
    const out = M.HEAPU8.slice(r, r + M.HEAP32[lenp >> 2]);
    M._free(r); M._free(lenp); M._free(p);
    return out;
  };
  const k = {
    M, logs,
    sjis: text => conv(M._kawari7_utf8_to_cp932, enc.encode(text)),
    utf8: bytes => new TextDecoder().decode(conv(M._kawari7_cp932_to_utf8, bytes)),
    write(rel, data) {
      const full = GHOST + rel;
      M.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      M.FS.writeFile(full, typeof data === 'string' ? k.sjis(data) : data);
    },
    load() {
      const b = enc.encode(GHOST);
      return M._load(heap(b), b.length);
    },
    /** a SHIORI/2 request in Unicode text -> the reply as text (code page 932 both ways, as SSP talks to it) */
    request(text) {
      const b = k.sjis(text);
      const p = heap(b), lenp = M._malloc(4);
      M.HEAP32[lenp >> 2] = b.length;
      const r = M._request(p, lenp);
      const out = M.HEAPU8.slice(r, r + M.HEAP32[lenp >> 2]);
      M._free(r); M._free(lenp);
      return k.utf8(out);
    },
    ask(lines) { return k.request(lines.join(CRLF) + CRLF + CRLF); },
    header(reply, name) { const m = new RegExp(`^${name}: (.*)$`, 'mi').exec(reply); return m ? m[1].replace(/\r$/, '') : null; },
  };
  for (const [rel, data] of Object.entries(files)) k.write(rel, data);
  return k;
}

const GET = (ev, refs = [], more = []) => ['GET Sentence SHIORI/2.2', 'Charset: Shift_JIS', 'Sender: SSP', 'SecurityLevel: local',
  `Event: ${ev}`, ...refs.map((r, i) => `Reference${i}: ${r}`), ...more];

const DICT = [
  '# a Phase 7 dictionary',
  'event.OnBoot : \\0\\s[0]起動です。${name}\\e',
  'event.OnTest : ${system.Reference0}と${system.Reference1}\\e',
  'name : テスト君',
  'resource.homeurl : http://example.invalid/',
  'resource.sakura.recommendsites : 華和梨$(chr 1)http://kawari.sourceforge.net/',
  'system.OnLoad : $(set loadcount $(expr ${loadcount} + 1))$(set bootpick ${pick})',
  'pick : A , B , C , D , E , F , G , H',
  'loadcount : 0',
  'system.OnTeach : 教わった:${system.Sentence}',
  'system.OnTranslate : [${system.Sentence}]',
  'event.OnSave : $(save save.txt name counter)saved',
  'event.OnDir : $(readdir . files)$(size files)/$(enumerate files)',
  'counter : 1',
  'event.OnCount : $(set counter $(expr ${counter} + 1))${counter}',
  'event.OnClearName : $(clear name)cleared',
  'event.OnTalkTo : $(set system.communicate Other)$(set system.Response0 ref0)話しかけ',
  'sentence : AIトーク\\e',
].join(CRLF) + CRLF + '\x1a' + 'garbage : after Ctrl+Z' + CRLF;

const k = await boot({ 'kawari.ini': ['dict : dict.txt', 'debug : log', 'set : fromini value'].join(CRLF) + CRLF, 'dict.txt': DICT });
assert.equal(k.load(), 1, 'load');
let r = k.ask(['GET Version SHIORI/2.6', 'Charset: Shift_JIS', 'Sender: SSP']);
console.log(r.split(CRLF)[0], '|', k.header(r, 'ID'), k.header(r, 'Version'));
assert.match(r, /^SHIORI\/2\.6 200 OK/);
assert.equal(k.header(r, 'Version'), '7.5.0');
r = k.ask(GET('OnBoot'));
console.log(JSON.stringify(r));
assert.equal(k.header(r, 'Sentence'), '\\0\\s[0]起動です。テスト君\\e');
assert.equal(k.header(r, 'Charset'), 'Shift_JIS');
r = k.ask(GET('OnTest', ['ソ表', 'ー']));
assert.equal(k.header(r, 'Sentence'), 'ソ表とー\\e', 'references in 932 (0x5C trail bytes)');
r = k.ask(GET('OnUnknownEvent'));
assert.match(r, /^SHIORI\/2\.6 204/, 'an unknown event: 204');
r = k.ask(['GET String SHIORI/2.5', 'Charset: Shift_JIS', 'Sender: SSP', 'SecurityLevel: local', 'ID: sakura.recommendsites']);
assert.equal(k.header(r, 'String'), '華和梨\x01http://kawari.sourceforge.net/');
r = k.ask(['GET Sentence SHIORI/2.2', 'Charset: Shift_JIS', 'Sender: SSP', 'SecurityLevel: local']);
assert.equal(k.header(r, 'Sentence'), 'AIトーク\\e', 'GET Sentence without Event: the talk');
r = k.ask(['TEACH SHIORI/2.4', 'Charset: Shift_JIS', 'Sender: SSP', 'SecurityLevel: local', 'Word: りんご']);
assert.equal(k.header(r, 'Sentence'), '教わった:りんご');
r = k.ask(['TRANSLATE Sentence SHIORI/2.6', 'Charset: Shift_JIS', 'Sender: SSP', 'SecurityLevel: local', 'Sentence: abc']);
assert.equal(k.header(r, 'Sentence'), '[abc]');
k.ask(['NOTIFY OwnerGhostName SHIORI/2.0', 'Charset: Shift_JIS', 'Sender: SSP', 'SecurityLevel: local', 'Ghost: テスト']);
k.ask(['NOTIFY OtherGhostName SHIORI/2.3', 'Charset: Shift_JIS', 'Sender: SSP', 'SecurityLevel: local', 'Ghost: Other', 'GhostEx: Other\x010\x0110']);
r = k.ask(GET('OnTalkTo'));
console.log(JSON.stringify(r));
assert.equal(k.header(r, 'To'), 'Other', 'communicate: To');
assert.equal(k.header(r, 'Sender'), 'テスト');
assert.equal(k.header(r, 'Reference0'), 'ref0');
// a ghost the engine does not know is no target
r = k.ask(['GET Sentence SHIORI/2.3', 'Charset: Shift_JIS', 'Sender: Other', 'SecurityLevel: local', 'Sentence: hi', 'Age: 0']);
console.log('communicate in:', JSON.stringify(r));
// save: CRLF, its file name in 932 on MEMFS; readdir in 932
r = k.ask(GET('OnSave'));
assert.equal(k.header(r, 'Sentence'), 'saved');
const saved = k.M.FS.readFile(GHOST + 'save.txt');
const savedText = k.utf8(saved);
console.log(JSON.stringify(savedText));
assert.ok(savedText.startsWith('#\r\n# Kawari saved file\r\n') && savedText.includes('name : "テスト君"\r\n'), 'save writes CRLF');
r = k.ask(GET('OnDir'));
console.log('readdir:', k.header(r, 'Sentence'));
assert.ok(/^\d+\/.*kawari\.ini.*/.test(k.header(r, 'Sentence')) && /save\.txt/.test(k.header(r, 'Sentence')), 'readdir');
// the Ctrl+Z ended the dictionary; the CRLF lines read without CR
r = k.ask(['GET String SHIORI/2.5', 'Charset: Shift_JIS', 'Sender: SSP', 'SecurityLevel: local', 'ID: homeurl']);
assert.equal(k.header(r, 'String'), 'http://example.invalid/', 'no CR left on a CRLF line');
assert.ok(!/garbage/.test(k.ask(GET('OnDir'))), '');
// ini `set` and the log
assert.ok(k.logs.length > 0, 'debug: log goes to Module.kawariLog');
assert.ok(!k.M.FS.analyzePath(GHOST + 'kawari.log').exists, 'no kawari.log file');
// the snapshot: OnLoad's count and pick, a changed counter, a cleared entry
k.ask(GET('OnCount'));
k.ask(GET('OnCount'));
k.ask(GET('OnClearName'));
const pathp = enc.encode('/sumika/resume.k7\0');
k.M.FS.mkdirTree('/sumika');
const pp = k.M._malloc(pathp.length); k.M.HEAPU8.set(pathp, pp);
const size = k.M._kawari7_snapshot(pp);
const snap = k.utf8(k.M.FS.readFile('/sumika/resume.k7'));
console.log('snapshot', size, JSON.stringify(snap));
assert.ok(size > 0);
assert.match(snap, /^K7SNAP 1\n/);
assert.match(snap, /E counter\nW "3"\n/);
assert.match(snap, /C name\n/);
assert.match(snap, /E loadcount\nW "1"\n/);
assert.ok(!/system\.Reference0/.test(snap), 'request entries left out');
const snapBytes = k.M.FS.readFile('/sumika/resume.k7');
k.M._unload();
// a second engine (the next page): load, then restore
const k2 = await boot({ 'kawari.ini': ['dict : dict.txt'].join(CRLF) + CRLF, 'dict.txt': DICT });
assert.equal(k2.load(), 1);
k2.M.FS.mkdirTree('/sumika');
k2.M.FS.writeFile('/sumika/resume.k7', snapBytes);
const pp2 = k2.M._malloc(pathp.length); k2.M.HEAPU8.set(pathp, pp2);
assert.equal(k2.M._kawari7_restore(pp2), 1);
r = k2.ask(GET('OnCount'));
assert.equal(k2.header(r, 'Sentence'), '4', 'the counter came back');
r = k2.ask(GET('OnBoot'));
assert.equal(k2.header(r, 'Sentence'), '\\0\\s[0]起動です。\\e', 'the cleared name stays cleared');
r = k2.ask(['GET String SHIORI/2.5', 'Charset: Shift_JIS', 'Sender: SSP', 'SecurityLevel: local', 'ID: homeurl']);
assert.equal(k2.header(r, 'String'), 'http://example.invalid/');
k2.M._unload();
console.log('kawari7 smoke: ok');

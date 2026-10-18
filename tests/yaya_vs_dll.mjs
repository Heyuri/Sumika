// Run the WebAssembly YAYA over the requests a real yaya.dll answered, and compare, as tests/satori_vs_dll.mjs does for
// Satori. The DLL's answers come from tools/dll_harness.ps1 -Dll yaya.dll -Charset UTF-8, run on a scratch copy of the
// ghost (never in the SSP install). A regression net, not an oracle: emily4's DLL is Tc571-15 and ours Tc606-2, and
// random choices differ (each side seeds its own generator).
// usage: node tests/yaya_vs_dll.mjs <ghost root (the scratch copy)> <dll .res.txt> [--module yaya] [--limit N] [--show N]
import fs from 'node:fs';
import path from 'node:path';
import { YayaEngine } from '../src/worker/engines/yaya.js';
import { saoriBridge } from '../src/worker/saori/index.js';
import { yayaFilePlan } from '../src/core/engine-files.js';
import { GhostFiles } from '../src/core/loader.js';
import { loadEngineFactory } from './load_engine.mjs';

class NodeYaya extends YayaEngine {
  async factory() { return loadEngineFactory('yaya'); }
}

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));
const [rootDir, corpusPath] = positional;
if (!rootDir || !corpusPath) { console.error('usage: node tests/yaya_vs_dll.mjs <ghost root> <dll .res.txt> [--module yaya] [--limit N] [--show N]'); process.exit(2); }
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const MODULE = opt('--module', 'yaya');
const LIMIT = Number(opt('--limit', Infinity));
const SHOW = Number(opt('--show', 5));
console.log(`ghost=${rootDir} corpus=${corpusPath} module=${MODULE}`);

// the ghost root as the runtime sends it (yayaFilePlan: personal files, logs and DLLs never; text with its bytes)
const list = [];
(function walk(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
    else list.push([rel + e.name, fs.statSync(path.join(d, e.name)).size]);
  }
})(rootDir, '');
const plan = yayaFilePlan(new GhostFiles('mem:/', list));
const files = plan.bytes.map(p => {
  const b = fs.readFileSync(path.join(rootDir, p));
  return { path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
});

const logs = [];
saoriBridge.log = (lvl, t) => logs.push(`[${lvl}] ${t}`);
saoriBridge.notifyPage = () => {};
const engine = new NodeYaya({
  engineUrl: path.resolve('site/sumika/engines/yaya.js'), saori: saoriBridge, log: (lvl, t) => logs.push(`[${lvl}] ${t}`),
  opts: { module: MODULE, ghostId: path.basename(path.resolve(rootDir)), placeholders: plan.placeholders, site: { ghosts: [], balloons: [] }, lang: 'ja-JP' },
  onEngineLog: l => { if (l.mode !== 'info') logs.push(`[yaya ${l.mode}] ${l.text}`); },
});
await engine.boot();
let t0 = Date.now();
const loaded = engine.init(files, {}, { resume: false, bootEpochMs: Date.now() });
console.log(`load=${loaded} status=${engine.status} files=${files.length} placeholders=${plan.placeholders.length} in ${Date.now() - t0} ms`);

// corpus: "\n=== <ID>\t<ref0>\t...\nSTATUS ...\nVALUE ..." (an ID starting with '!' was sent as NOTIFY)
const corpus = fs.readFileSync(corpusPath, 'utf8').replace(/\r\n/g, '\n').split('\n=== ').slice(1).map(b => {
  const [head, ...rest] = b.split('\n');
  const st = rest.find(l => l.startsWith('STATUS ')) || '';
  const val = rest.find(l => l.startsWith('VALUE '));
  return { head, status: st.slice(7), value: val === undefined ? null : val.slice(6) };
}).slice(0, LIMIT);

const strip = v => (v || '').replace(/\\_w\[\d+\]|\\w\d/g, '');        // automatic waits may differ in rounding
// menus padded by GETSTRBYTES(x, 127): CHARSET_DEFAULT is CP932 here (Japanese Windows), the DLL uses the PC's ANSI
// code page, so on a non-Japanese Windows its padding differs (yaya-wasm.md, charset)
const loose = v => strip(v).replace(/ {2,}/g, ' ');
const code = s => (s.split(' ')[1] || s);
let same = 0, sameNoWait = 0, sameSpaces = 0, statusSame = 0, bothValue = 0;
const diffs = [];
t0 = Date.now();
for (const c of corpus) {
  const [first, ...refs] = c.head.split('\t');
  const method = first.startsWith('!') ? 'NOTIFY' : 'GET';
  const id = first.replace(/^!/, '');
  let req = `${method} SHIORI/3.0\r\nCharset: UTF-8\r\nSender: SSP\r\nSecurityLevel: local\r\nID: ${id}\r\n`;
  refs.forEach((r, i) => { req += `Reference${i}: ${r}\r\n`; });
  const res = engine.request(req + '\r\n');
  const status = res.split('\r\n')[0] || '(null)';
  const vm = /\r\nValue: ([^\r\n]*)/.exec(res);
  const value = vm ? vm[1] : null;
  if (code(status) === code(c.status)) statusSame++;
  if (value !== null && c.value !== null) bothValue++;
  if (value === c.value) same++;
  else if (strip(value) === strip(c.value)) sameNoWait++;
  else if (loose(value) === loose(c.value)) sameSpaces++;
  else diffs.push({ head: c.head, dll: c.value, wasm: value, status, dllStatus: c.status });
}
const ms = Date.now() - t0;
console.log(`requests=${corpus.length} in ${ms} ms (${(ms / Math.max(1, corpus.length)).toFixed(2)} ms/req)`);
console.log(`same status=${statusSame}  identical value=${same}  identical except waits=${sameNoWait}  `
  + `identical except waits and padding=${sameSpaces}  different=${diffs.length}  (both had a value: ${bothValue})`);
const shown = process.env.STATUS_ONLY ? diffs.filter(d => code(d.status) !== code(d.dllStatus)) : diffs;
for (const d of shown.slice(0, SHOW)) {
  console.log(`\n--- ${d.head}   [dll ${d.dllStatus} | wasm ${d.status}]\nDLL : ${(d.dll || '').slice(0, 400)}\nWASM: ${(d.wasm || '').slice(0, 400)}`);
}
t0 = Date.now();
console.log(`\nsave: ${engine.save()} in ${Date.now() - t0} ms`);
if (logs.length) console.log(`\n${logs.length} log lines, first:\n` + logs.slice(0, 15).join('\n'));

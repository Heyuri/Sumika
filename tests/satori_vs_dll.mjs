// Run the WebAssembly Satori over the same requests the real satori.dll answered, and compare.
// usage: node tests/satori_vs_dll.mjs [master|bath|date|meal] [--limit N] [--show N]
//          Tsubasa's corpus in tests/corpus/ (see its README); the mode picks the dictionary folder and the .res.txt
//        node tests/satori_vs_dll.mjs <ghost/master dir prepared by the DLL harness> <dll .res.txt corpus> [--limit N] [--show N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saoriBridge } from '../src/worker/saori/index.js';
import { loadEngineFactory } from './load_engine.mjs';

const createSatori = loadEngineFactory('satori');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODES = { master: '.', bath: 'bath', date: 'date', meal: 'meal' };
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
let [ghostDir, corpusPath] = positional, dicFolder = null;
if (!ghostDir || Object.hasOwn(MODES, ghostDir)) {
  const mode = ghostDir || 'master';
  ghostDir = path.join(HERE, 'corpus', 'ghost', 'master');
  corpusPath = path.join(HERE, 'corpus', `final_${mode}.res.txt`);
  dicFolder = MODES[mode];
}
console.log(`ghost=${ghostDir} corpus=${corpusPath}${dicFolder ? ` ＄辞書フォルダ=${dicFolder}` : ''}`);

// The corpus ghost's savedata ends with "＄辞書フォルダ\t." (Shift_JIS); bath/date/meal set it like the harness's prepare() did.
const DIC_FOLDER_KEY = Buffer.from('81908eab8f9183748348838b835f09', 'hex');
function setDicFolder(b, value) {
  const i = b.indexOf(DIC_FOLDER_KEY);
  if (i < 0) throw new Error('satori_savedata.txt has no ＄辞書フォルダ line');
  const j = b.indexOf('\r\n', i);
  return Buffer.concat([b.subarray(0, i + DIC_FOLDER_KEY.length), Buffer.from(value), b.subarray(j < 0 ? b.length : j)]);
}
const opt = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? +process.argv[i + 1] : d; };
const LIMIT = opt('--limit', Infinity);
const SHOW = opt('--show', 5);
const SKIP_EXT = new Set(['.png', '.pna', '.jpg', '.jpeg', '.gif', '.bmp', '.wav', '.mp3', '.ogg', '.mid', '.dll', '.exe', '.zip']);

const logs = [];
saoriBridge.log = (lvl, t) => logs.push(`[${lvl}] ${t}`);
saoriBridge.notifyPage = () => {};

const M = await createSatori({ print: () => {}, printErr: t => logs.push('[stderr] ' + t), saoriBridge });

function mkdirs(p) {
  let cur = '';
  for (const seg of p.split('/').filter(Boolean)) { cur += '/' + seg; try { M.FS.mkdir(cur); } catch (e) {} }
}
let nfiles = 0;
(function copy(dir, vdir) {
  mkdirs(vdir);
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) copy(p, vdir + ent.name + '/');
    else if (!SKIP_EXT.has(path.extname(ent.name).toLowerCase())) {
      let data = fs.readFileSync(p);
      if (dicFolder && vdir === '/ghost/master/' && ent.name.toLowerCase() === 'satori_savedata.txt') data = setDicFolder(data, dicFolder);
      M.FS.writeFile(vdir + ent.name, data);
      nfiles++;
    }
  }
})(ghostDir, '/ghost/master/');

function call(text) {
  const n = M.lengthBytesUTF8(text);
  const p = M._malloc(n + 1);
  M.stringToUTF8(text, p, n + 1);
  const lp = M._malloc(8);
  M.HEAP32[lp >> 2] = n;
  const rp = M._request(p, lp);
  const rn = M.HEAP32[lp >> 2];
  M._free(lp);
  const out = rp ? M.UTF8ToString(rp, rn) : '';
  if (rp) M._free(rp);
  return out;
}

let t0 = Date.now();
const dir = '/ghost/master/';
const dn = M.lengthBytesUTF8(dir);
const dp = M._malloc(dn + 1);
M.stringToUTF8(dir, dp, dn + 1);
const loaded = M._load(dp, dn);
console.log(`load=${loaded} files=${nfiles} in ${Date.now() - t0} ms`);

// corpus: "\n=== <ID>\t<ref0>\t...\nSTATUS ...\nVALUE ..."
const corpus = fs.readFileSync(corpusPath, 'utf8').replace(/\r\n/g, '\n').split('\n=== ').slice(1).map(b => {
  const [head, ...rest] = b.split('\n');
  const st = rest.find(l => l.startsWith('STATUS ')) || '';
  const val = rest.find(l => l.startsWith('VALUE '));
  return { head, status: st.slice(7), value: val === undefined ? null : val.slice(6) };
}).slice(0, LIMIT);

const strip = v => (v || '').replace(/\\_w\[\d+\]|\\w\d/g, ''); // automatic waits may differ in rounding
let same = 0, sameNoWait = 0, statusSame = 0, bothValue = 0;
const diffs = [];
t0 = Date.now();
for (const c of corpus) {
  const [id, ...refs] = c.head.split('\t');
  let req = `GET SHIORI/3.0\r\nCharset: UTF-8\r\nSender: SSP\r\nSecurityLevel: local\r\nID: ${id}\r\n`;
  refs.forEach((r, i) => { req += `Reference${i}: ${r}\r\n`; });
  const res = call(req + '\r\n');
  const status = (res.split('\r\n')[0] || '');
  const vm = /\r\nValue: ([^\r\n]*)/.exec(res);
  const value = vm ? vm[1] : null;
  if (status.split(' ')[1] === c.status.split(' ')[1]) statusSame++;
  if (value !== null && c.value !== null) bothValue++;
  if (value === c.value) same++;
  else if (strip(value) === strip(c.value)) sameNoWait++;
  else diffs.push({ head: c.head, dll: c.value, wasm: value, status, dllStatus: c.status });
}
const ms = Date.now() - t0;
console.log(`requests=${corpus.length} in ${ms} ms (${(ms / corpus.length).toFixed(1)} ms/req)`);
console.log(`same status=${statusSame}  identical value=${same}  identical except waits=${sameNoWait}  different=${diffs.length}  (both had a value: ${bothValue})`);
const shown = process.env.STATUS_ONLY ? diffs.filter(d => d.status.split(' ')[1] !== d.dllStatus.split(' ')[1]) : diffs;
for (const d of shown.slice(0, SHOW)) {
  console.log(`\n--- ${d.head}   [dll ${d.dllStatus} | wasm ${d.status}]\nDLL : ${(d.dll || '').slice(0, 400)}\nWASM: ${(d.wasm || '').slice(0, 400)}`);
}
const errs = ['引数の個数が正しくありません', '引数が足りません', '式が計算不能', 'not found'];
for (const e of errs) {
  const a = corpus.filter(c => (c.value || '').includes(e)).length;
  const b = diffs.filter(d => (d.wasm || '').includes(e)).length + corpus.filter(c => (c.value || '').includes(e)).length - diffs.filter(d => (d.dll || '').includes(e)).length;
  console.log(`error "${e}": dll=${a} wasm=${b}`);
}
t0 = Date.now();
M._satori_save();
console.log(`save: ${Date.now() - t0} ms, savedata ${M.FS.stat('/ghost/master/satori_savedata.txt').size} bytes`);
if (logs.length) console.log(`\n${logs.length} log lines, first:\n` + logs.slice(0, 10).join('\n'));

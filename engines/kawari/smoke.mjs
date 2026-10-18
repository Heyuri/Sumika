// Smoke test of a Kawari build (engines/kawari/build.py), straight on the C exports: version, the Shift_JIS <-> UTF-8
// edges (K4), half-width kana entry names (K3), CRLF reads and writes (K10, K11), getenv (K7), logs (K8, K9),
// encrypted dictionaries, SAORI (K5), the resume snapshot (K12), unload and reload, runaway recursion with the stack
// restored, and the request buffer.
//   node engines/kawari/smoke.mjs [DIR]      DIR holds kawari.js + kawari.wasm (default site/sumika/engines)
// Loaded through vm like tests/load_engine.mjs (package.json is "type": "module"), so a scratch --out build works too.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.resolve(process.argv[2] || path.join(root, 'site', 'sumika', 'engines'));
const enc = new TextEncoder();
const dec = new TextDecoder();
const sjisDec = new TextDecoder('shift_jis');
const GHOST = '/ghost/master/';
const CRLF = '\r\n';
const hex = b => Buffer.from(b).toString('hex');
const cat = (...parts) => Uint8Array.from(parts.flatMap(p => (typeof p === 'string' ? [...enc.encode(p)] : [...p])));

function loadFactory(file) {
  const mod = { exports: {} };
  const fn = vm.runInThisContext(`(function (module, exports, require, __dirname, __filename) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  fn(mod, mod.exports, createRequire(file), path.dirname(file), file);
  return mod.exports;
}
const factory = loadFactory(path.join(dir, 'kawari.js'));

/** One engine with ghost files in MEMFS. A string file is written in code page 932 (the build's own encoder, which
 *  the first check pins against Windows' bytes); a Uint8Array as it is. opts: Module fields (saoriBridge, kawariLog…);
 *  load: false leaves _load to the caller. */
async function boot(files, { load = true, log = true, ...extra } = {}) {
  const logs = [], printed = [];
  const M = await factory({ print: t => printed.push(t), printErr: t => printed.push(t),
    ...(log ? { kawariLog: t => logs.push(t) } : {}), ...extra });
  const heap = b => {
    const p = M._malloc(b.length + 1);
    M.HEAPU8.set(b, p);
    M.HEAPU8[p + b.length] = 0;
    return p;
  };
  const k = {
    M, logs, printed,
    sjis(text) {
      const b = enc.encode(text);
      const p = heap(b);
      const lenp = M._malloc(4);
      const r = M._kawari_utf8_to_cp932(p, b.length, lenp);
      const out = M.HEAPU8.slice(r, r + M.HEAP32[lenp >> 2]);
      M._free(r); M._free(lenp); M._free(p);
      return out;
    },
    /** raw request bytes -> raw reply bytes (null: no reply). A throw out of the wasm (a runaway recursion's
     *  RangeError) leaves the stack pointer down: it is put back before anything else runs (kawari-wasm.md D8). */
    requestBytes(b) {
      const p = heap(b);
      const lenp = M._malloc(4);
      M.HEAP32[lenp >> 2] = b.length;
      const sp = M.stackSave();
      let r;
      try {
        r = M._request(p, lenp);
      } catch (e) {
        M.stackRestore(sp);
        M._free(lenp);
        throw e;
      }
      const n = M.HEAP32[lenp >> 2];
      M._free(lenp);
      if (!r) return null;
      const out = M.HEAPU8.slice(r, r + n);
      M._free(r);
      return out;
    },
    request(text) { const r = k.requestBytes(enc.encode(text)); return r && dec.decode(r); },
    get(id, refs = [], headers = {}) {
      let s = `GET SHIORI/3.0${CRLF}Charset: UTF-8${CRLF}Sender: smoke${CRLF}SecurityLevel: local${CRLF}ID: ${id}${CRLF}`;
      refs.forEach((r, i) => { s += `Reference${i}: ${r}${CRLF}`; });
      for (const [h, v] of Object.entries(headers)) s += `${h}: ${v}${CRLF}`;
      return k.request(s + CRLF);
    },
    /** a script through the KOSUI hook (GET ID: ShioriEcho; the fixture says `debugger on`): its Value without the \e */
    eval(script) {
      const r = k.get('ShioriEcho', [script]) || '';
      const v = /\r\nValue: (.*)\r\n/.exec(r);
      return v ? v[1].replace(/\\e$/, '') : `(no value: ${r.split(CRLF)[0]})`;
    },
    load() {
      const b = enc.encode(GHOST);
      return M._load(heap(b), b.length);
    },
    file(p) { try { return M.FS.readFile(p.startsWith('/') ? p : GHOST + p); } catch { return null; } },
    write(p, data) {
      const full = p.startsWith('/') ? p : GHOST + p;
      M.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      M.FS.writeFile(full, typeof data === 'string' ? k.sjis(data) : data);
    },
    /** _kawari_snapshot(path, all) -> [return value, the file's bytes] */
    snapshot(p = '/sumika/resume.kis', all = 0) {
      M.FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
      const b = enc.encode(p);
      const s = heap(b);
      const n = M._kawari_snapshot(s, all);
      M._free(s);
      return [n, k.file(p)];
    },
    restore(p = '/sumika/resume.kis') {
      const b = enc.encode(p);
      const s = heap(b);
      const r = M._kawari_restore(s);
      M._free(s);
      return r;
    },
  };
  for (const [p, data] of Object.entries(files)) k.write(p, data);
  if (load) k.loaded = k.load();
  return k;
}

// the base fixture: a Phase 8 ghost whose kawarirc.kis is all there is (dictionary lines, then a KIS zone)
const BASE = {
  'kawarirc.kis': ['keep : 1', 'chg : a', 'gone : x , y', 'prot : p', 'word : ソ表能～－①＼髙',
    'ｶﾅ : はんかく', 'ｱ･ｲ : なかてん', 'rec : ${rec}', 'w : ok', 'System.Callback.OnUnload : $(save unl.txt keep chg)',
    '=kis', 'debugger on;', 'writeprotect prot;', '=end', ''].join(CRLF),
};
const getVersion = `GET SHIORI/3.0${CRLF}Charset: UTF-8${CRLF}Sender: smoke${CRLF}ID: version${CRLF}${CRLF}`;

let failed = 0;
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true) { console.log(`ok   ${name}`); return; }
    failed++;
    console.log(`FAIL ${name}: ${r}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e && e.stack || e}`);
  }
}
const expect = (got, want) => (got === want ? true : `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
const crlfOnly = b => { const t = Buffer.from(b).toString('latin1'); return t.includes('\r\n') && !/[^\r]\n|^\n/.test(t); };

const info = fs.existsSync(path.join(dir, 'kawari.build-info.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'kawari.build-info.json'), 'utf8')) : {};
console.log(`${dir}: kawari.wasm ${fs.statSync(path.join(dir, 'kawari.wasm')).size} bytes, ${JSON.stringify(info)}`);

await check('the encoder is ssp.exe\'s WideCharToMultiByte(932, 0): ソ表能～－①＼髙ⅰ -> 835C955C945C8160817C8740815FFBFCFA40; best fit é¥«ゔ¢£¬ -> 65 5C 81E1 8394 8191 8192 81CA; 〜 -> 3F; 😀 -> 3F3F', async () => {
  const k = await boot({}, { load: false });
  return expect(hex(k.sjis('ソ表能～－①＼髙ⅰé¥«ゔ¢£¬〜😀')), '835c955c945c8160817c8740815ffbfcfa40' +
    '655c81e183948191819281ca' + '3f' + '3f3f');
});
await check('GET version (no dictionary) -> 200, Value 8.2.8, Charset: UTF-8', async () => {
  const k = await boot({});
  const r = k.request(getVersion) || '';
  if (!/^SHIORI\/3\.0 200 OK\r\n/.test(r) || !/\r\nCharset: UTF-8\r\n/.test(r)) return `reply ${JSON.stringify(r)}`;
  return expect((/\r\nValue: (.*)\r\n/.exec(r) || [])[1], info.kawari || '8.2.8');
});
await check('a Charset: UTF-8 request reaches Kawari as Shift_JIS (System.Request.Charset)', async () => {
  const k = await boot(BASE);
  return expect(k.eval('${System.Request.Charset}'), 'Shift_JIS');
});
await check('a request without Charset passes unchanged: the reply is code page 932 and says Shift_JIS', async () => {
  const k = await boot(BASE);
  const r = k.requestBytes(cat(`GET SHIORI/3.0${CRLF}Sender: smoke${CRLF}SecurityLevel: local${CRLF}ID: ShioriEcho${CRLF}Reference0: \${word}${CRLF}${CRLF}`));
  const t = Buffer.from(r).toString('latin1');
  if (!/\r\nCharset: Shift_JIS\r\n/.test(t)) return `reply ${JSON.stringify(t)}`;
  return t.includes(Buffer.from(k.sjis('ソ表能～－①＼髙')).toString('latin1')) ? true : `reply ${hex(r)}`;
});
await check('round trips: ソ表能～－①＼髙 from the dictionary and through $(echo); $(length) counts characters', async () => {
  const k = await boot(BASE);
  return expect([k.eval('${word}'), k.eval('$(echo ～－＼①髙ソ表能)'), k.eval('$(length ソ表能～)')].join('|'),
    'ソ表能～－①＼髙|～－＼①髙ソ表能|4');
});
await check('an invalid pair (81 7F) reads as one ・; FA40 is ⅰ both ways; é😀 -> e??', async () => {
  const k = await boot({ ...BASE, 'more.kis': cat('bad : a', [0x81, 0x7f], 'b\r\nibm : ', [0xfa, 0x40], '\r\n') });
  k.eval('$(load more.kis)');
  return expect([k.eval('${bad}'), k.eval('${ibm}'), k.eval('$(echo ⅰ)'), k.eval('$(echo é😀)')].join('|'), 'a・b|ⅰ|ⅰ|e??');
});
await check('K3: half-width kana entry names (ｶﾅ, ｱ･ｲ with 0xA5)', async () => {
  const k = await boot(BASE);
  return expect([k.eval('${ｶﾅ}'), k.eval('${ｱ･ｲ}'), k.eval('$(length ｱｲｳ･)')].join('|'), 'はんかく|なかてん|4');
});
await check('K10: textload of a CRLF file drops the CRs; a CR that ends the file stays', async () => {
  const k = await boot({ ...BASE, 'crlf.txt': '一\r\n二\r\n', 'tail.txt': 'x\r\ny\r' });
  return expect([k.eval('$(textload @t crlf.txt)$(size @t)[$(get @t[0])][$(get @t[1])]$(length $(get @t[0]))'),
    k.eval('$(textload @u tail.txt)$(size @u)$(length $(get @u[0]))$(length $(get @u[1]))')].join('|'), '2[一][二]1|212');
});
await check('K11: save / textsave / textappend write CRLF; save loads back', async () => {
  const k = await boot(BASE);
  k.eval('$(set sv.a 1)$(set sv.b あ)$(save sv.txt sv.a sv.b)$(textsave ts.txt sv.b sv.a)$(textappend ts.txt sv.b)');
  const sv = k.file('sv.txt'), ts = k.file('ts.txt');
  if (!sv || !crlfOnly(sv)) return `sv.txt ${sv && hex(sv)}`;
  if (!ts || hex(ts) !== hex(cat(k.sjis('あ'), '\r\n1\r\n', k.sjis('あ'), '\r\n'))) return `ts.txt ${ts && hex(ts)}`;
  return expect(k.eval('$(clear sv.b)[${sv.b}]$(load sv.txt)[${sv.b}]'), '[][あ]');
});
await check('K6: a Japanese file name is a UTF-8 name in MEMFS and is found again', async () => {
  const k = await boot(BASE);
  k.eval('$(save テスト.txt keep)');
  if (!k.file('テスト.txt')) return `MEMFS ${JSON.stringify(k.M.FS.readdir(GHOST))}`;
  return expect(k.eval('$(isexist テスト.txt)$(isfile テスト.txt)|$(readdir @d .)$(size @d)|$(textload @t テスト.txt)$(size @t)'),
    '11|2|5');
});
await check('K7: getenv finds nothing', async () => {
  const k = await boot(BASE);
  return expect(k.eval('[$(getenv HOME)$(getenv PATH)$(getenv USER)]'), '[]');
});
await check('K8: a dictionary error at load reaches Module.kawariLog (default level error|warning)', async () => {
  const k = await boot({ 'kawarirc.kis': 'good : 1\r\nno colon here\r\n' });
  return k.logs.length > 0 ? true : 'no log line';
});
await check('K9: logfile x.txt / logfile - write no file and no stdout, the lines reach Module.kawariLog; logfile alone stops', async () => {
  const k = await boot(BASE);
  k.eval('$(logfile x.txt)');
  k.logs.length = 0;
  k.eval('$(load nothere1.kis)');
  const a = k.logs.some(l => l.includes('nothere1'));
  k.eval('$(logfile -)');
  k.eval('$(load nothere2.kis)');
  const b = k.logs.some(l => l.includes('nothere2'));
  k.eval('$(logfile)');
  k.eval('$(load nothere3.kis)');
  const c = k.logs.some(l => l.includes('nothere3'));
  const files = k.M.FS.readdir(GHOST).filter(n => n !== '.' && n !== '..');
  const k2 = await boot(BASE, { log: false });     // no Module.kawariLog: nowhere
  k2.eval('$(logfile y.txt)$(load nothere4.kis)');
  return expect([a, b, c, files.join(','), k.printed.length, String(k2.file('y.txt')), k2.printed.length].join(' '),
    'true true false kawarirc.kis 0 null 0');
});
await check('encrypted dictionary lines !KAWA0000 and !KAWA0001 load', async () => {
  const x = (s, key) => Uint8Array.from(enc.encode(s), c => c ^ key);
  const line0 = '!KAWA0000' + Buffer.from(x('enc0 : zero', 0xcc)).toString('base64');
  const line1 = '!KAWA0001' + Buffer.from(cat([0x5a], x('enc1 : one', 0x5a))).toString('base64');
  const k = await boot({ ...BASE, 'crypt.kis': line0 + '\r\n' + line1 + '\r\n' });
  return expect(k.eval('$(load crypt.kis)${enc0}${enc1}'), 'zeroone');
});
await check('K5: SAORI through Module.saoriBridge: UTF-8 both ways, one handle for two aliases, one unload', async () => {
  const calls = [];
  const saoriBridge = {
    load(p, d) { calls.push(`load ${p} ${d}`); return /\/echo\.dll$/i.test(p) ? 1 : 0; },
    request(h, bytes) {
      let t;
      try { t = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { calls.push('not UTF-8'); return null; }
      if (/^EXECUTE/.test(t)) calls.push(`request ${h} ${/\r\nCharset: UTF-8\r\n/.test(t)} ${(/\r\nArgument0: (.*)\r\n/.exec(t) || [])[1]}`);
      return `SAORI/1.0 200 OK${CRLF}Charset: UTF-8${CRLF}Result: ①～${CRLF}${CRLF}`;
    },
    unload(h) { calls.push(`unload ${h}`); },
  };
  const k = await boot({ 'kawarirc.kis': '=kis\r\ndebugger on;\r\nsaoriregist echo.dll echo;\r\nsaoriregist ECHO.DLL echo2;\r\nsaoriregist missing.dll gone;\r\n=end\r\n' },
    { saoriBridge });
  const r = k.eval('$(callsaori echo ソ表～①)$(callsaori echo2 x)[$(callsaori gone y)]');
  k.M._unload();
  if (r !== '①～①～[]') return `results ${JSON.stringify(r)}`;
  const shown = calls.filter(c => !/missing/.test(c));
  return expect(shown.join('; '), 'load /ghost/master/echo.dll /ghost/master/; request 1 true ソ表～①; request 1 true x; unload 1');
});
await check('K12: snapshot -> restore: changed, cleared, new and odd-named entries and what load made; protected and unchanged definitions left out', async () => {
  const k = await boot(BASE);
  if (!(k.M._kawari_baseline() > 0)) return 'baseline';
  k.eval('$(set chg b)$(clear gone)$(set newent あ)$(adddict newent い)$(set odd-name z)$(set prot q)');
  const [n, f] = k.snapshot();
  if (!(n > 0) || !f || f.length !== n) return `snapshot ${n}, file ${f && f.length}`;
  const t = sjisDec.decode(f);
  for (const want of ['# clear chg\n', 'chg : "b"\n', '# clear gone\n', 'newent : "あ" , "い"\n', '# move 1 odd-name\n',
    'System.Sumika.Snapshot.1 : "z"\n', '# clear System.Debugger\n', 'System.Debugger : "on"\n']) {
    if (!t.includes(want)) return `missing ${JSON.stringify(want)} in ${JSON.stringify(t)}`;
  }
  for (const not of ['gone :', 'keep', 'prot', 'System.Request', 'word']) {
    if (t.includes(not)) return `${JSON.stringify(not)} in ${JSON.stringify(t)}`;
  }
  const k2 = await boot(BASE);
  if (!(k2.M._kawari_baseline() > 0)) return 'baseline 2';
  // an unchanged engine carries only what its load made: `debugger on` in the KIS zone
  const [only, of] = k2.snapshot('/sumika/only.kis');
  const ot = only > 0 ? sjisDec.decode(of) : '';
  if (!ot.endsWith('#\n# clear System.Debugger\nSystem.Debugger : "on"\n')) return `unchanged engine: ${JSON.stringify(ot)}`;
  const k3 = await boot({ 'kawarirc.kis': 'keep : 1\r\n' });
  k3.M._kawari_baseline();
  const [empty, ef] = k3.snapshot('/sumika/empty.kis');
  if (empty !== 0 || !ef || ef.length) return `unchanged definitions only: snapshot ${empty}, ${ef && ef.length} bytes`;
  k2.write('/sumika/resume.kis', f);
  if (k2.restore() !== 1) return 'restore';
  const got = k2.eval('${chg}|$(size gone)|$(size newent)$(get newent[0])$(get newent[1])|$(get odd-name)|$(size System.Sumika.Snapshot.1)|${keep}|${prot}');
  if (got !== 'b|0|2あい|z|0|1|p') return `restored ${got}`;
  const [n2, f2] = k2.snapshot('/sumika/again.kis');
  return n2 > 0 && sjisDec.decode(f2).includes('chg : "b"\n') && sjisDec.decode(f2).includes('# move 1 odd-name\n') ? true
    : `the next snapshot (restored entries differ from this page's baseline) ${n2}`;
});
await check('K12: what load made (a KIS zone: the clock, an entry it set, a definition it cleared) is carried unchanged and comes back on a later load', async () => {
  const files = { 'kawarirc.kis': 'def : 1\r\nkana : x\r\n=kis\r\ndebugger on;\r\nsetstr started $(date %s);\r\nset made v;\r\nclear kana;\r\n'
    + 'function twice $(echo $(get @arg[1])$(get @arg[1]));\r\nfunction gone $(echo x);\r\nrmfunc gone;\r\n=end\r\n' };
  const k = await boot(files);
  k.M._kawari_baseline();
  const started = k.eval('${started}');
  if (k.eval('$(twice ab)') !== 'abab') return `function ${k.eval('$(twice ab)')}`;
  const [n, f] = k.snapshot();
  const t = n > 0 ? sjisDec.decode(f) : '';
  for (const want of [`started : "${started}"\n`, 'made : "v"\n', '# clear kana\n', '# clear System.Function.gone\n']) {
    if (!t.includes(want)) return `missing ${JSON.stringify(want)} in ${JSON.stringify(t)}`;
  }
  if (t.includes('def') || t.includes('kana :') || t.includes('twice')) return `a definition in ${JSON.stringify(t)}`;
  k.eval('$(function twice $(echo $(get @arg[1])$(get @arg[1])$(get @arg[1])))');      // a function the session redefines is carried
  if (!sjisDec.decode(k.snapshot('/sumika/redef.kis')[1]).includes('System.Function.twice : ')) return 'redefined function not carried';
  const real = Date.now;
  let got;
  try {
    Date.now = () => real() + 2 * 3600e3;          // a later page: its load sets `started` anew
    const k2 = await boot(files);
    k2.M._kawari_baseline();
    if (k2.eval('${started}') === started) return 'the later load set the same time';
    k2.write('/sumika/resume.kis', f);
    if (k2.restore() !== 1) return 'restore';
    got = k2.eval('${started}|${made}|[${kana}]|${def}');
  } finally {
    Date.now = real;
  }
  return expect(got, `${started}|v|[]|1`);
});
await check('K12: all = 1 dumps every entry; no baseline or no engine -> -1 / 0', async () => {
  const k = await boot(BASE);
  k.M._kawari_baseline();
  const [n, f] = k.snapshot('/sumika/all.kis', 1);
  const t = n > 0 ? sjisDec.decode(f) : '';
  if (!t.includes('keep : "1"\n') || !t.includes('chg : "a"\n') || t.includes('prot :')) return `dump ${JSON.stringify(t.slice(0, 300))}`;
  k.M._unload();
  return expect([k.M._kawari_baseline(), k.snapshot('/sumika/after.kis')[0], k.restore('/sumika/all.kis')].join(' '), '-1 -1 0');
});
await check('K12: an entry whose word id was freed and handed out again counts as changed', async () => {
  // request 1 empties cnt (its unique word v1 is freed at the end of the request), request 2's new header word v3
  // takes that freed id and is copied into cnt: the same id list as the baseline, another word
  const files = { 'kawarirc.kis': 'cnt : v1\r\nSystem.Callback.OnGET : $(clear cnt)$(copy System.Request.Reference0 cnt)\r\n' };
  const k = await boot(files);
  k.M._kawari_baseline();
  k.get('OnSet', ['v2']);
  k.get('OnSet', ['v3']);
  const [n, f] = k.snapshot();
  const t = n > 0 ? sjisDec.decode(f) : '';
  if (!t.includes('cnt : "v3"\n')) return `snapshot ${JSON.stringify(t)}`;
  const k2 = await boot(files);
  k2.M._kawari_baseline();
  k2.write('/sumika/resume.kis', f);
  if (k2.restore() !== 1) return 'restore';
  const [n2, f2] = k2.snapshot('/sumika/again.kis');
  return n2 > 0 && sjisDec.decode(f2).includes('cnt : "v3"\n') ? true : `after restore ${n2} ${f2 && sjisDec.decode(f2)}`;
});
await check('_unload runs System.Callback.OnUnload (the ghost saves, CRLF); a second _load in the same module answers', async () => {
  const k = await boot(BASE);
  k.eval('$(set chg c)');
  k.M._unload();
  const f = k.file('unl.txt');
  if (!f || !crlfOnly(f) || !sjisDec.decode(f).includes('chg : "c"')) return `unl.txt ${f && JSON.stringify(sjisDec.decode(f))}`;
  if (k.load() !== 1) return 'second load';
  return expect([k.eval('${chg}'), k.M._kawari_baseline() > 0].join(' '), 'a true');
});
await check('40 runaway recursions (${rec}) with the stack pointer restored, then a normal answer', async () => {
  const k = await boot(BASE);
  let thrown = 0;
  for (let i = 0; i < 40; i++) {
    try { k.eval('${rec}'); } catch { thrown++; }
  }
  return thrown === 40 ? expect([k.eval('${w}'), k.eval('$(length ソ表)')].join(' '), 'ok 2') : `thrown ${thrown}`;
});
await check('20,000 requests of 1 KB leave the malloc probe in place (request frees its input)', async () => {
  const k = await boot(BASE);
  const probe = () => { const p = k.M._malloc(1 << 20); k.M._free(p); return p; };
  const p0 = probe();
  const pad = 'x'.repeat(1000);
  for (let i = 0; i < 20000; i++) k.get('OnPad', [pad]);
  const p1 = probe();
  return p1 === p0 ? true : `probe ${p0} -> ${p1}, heap ${k.M.HEAPU8.length}`;
});

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);

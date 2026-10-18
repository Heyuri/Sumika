// Smoke test of a YAYA build (engines/yaya/build.py), straight on the C exports: load status, module name, save,
// resume, CP932, the OS stand-ins, logs, SAORI and the request buffer.
//   node engines/yaya/smoke.mjs [DIR]      DIR holds yaya.js + yaya.wasm (default site/sumika/engines)
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
const GHOST = '/ghost/master/';
const CRLF = '\r\n';

function loadFactory(file) {
  const mod = { exports: {} };
  const fn = vm.runInThisContext(`(function (module, exports, require, __dirname, __filename) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  fn(mod, mod.exports, createRequire(file), path.dirname(file), file);
  return mod.exports;
}
const factory = loadFactory(path.join(dir, 'yaya.js'));

/** One engine instance with ghost files in MEMFS. opts: module name, Module fields (saoriBridge, bootEpochMs...). */
async function boot(files, { module = null, resume = false, load = true, ...extra } = {}) {
  const logs = [];
  const M = await factory({ print: () => {}, printErr: () => {}, yayaLog: (text, mode) => logs.push({ mode, text }), ...extra });
  M.FS.mkdirTree(GHOST);
  for (const [p, data] of Object.entries(files)) {
    const full = GHOST + p;
    M.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    M.FS.writeFile(full, typeof data === 'string' ? enc.encode(data) : data);
  }
  const heap = b => {
    const p = M._malloc(b.length + 1);
    M.HEAPU8.set(b, p);
    M.HEAPU8[p + b.length] = 0;
    return p;
  };
  const y = {
    M, logs,
    statusBefore: M._yaya_load_status(),
    request(text) {
      const b = enc.encode(text);
      const p = heap(b);
      const lenp = M._malloc(4);
      M.HEAP32[lenp >> 2] = b.length;
      const r = M._request(p, lenp);
      const n = M.HEAP32[lenp >> 2];
      M._free(lenp);
      if (!r) return null;
      const out = dec.decode(M.HEAPU8.subarray(r, r + n));
      M._free(r);
      return out;
    },
    file(p) { try { return M.FS.readFile(GHOST + p); } catch { return null; } },
    files() { return M.FS.readdir(GHOST).filter(n => n !== '.' && n !== '..'); },
  };
  if (module) {
    const b = enc.encode(module);
    const p = heap(b);
    M._yaya_set_module_name(p, b.length);
    M._free(p);
  }
  if (load) {
    const b = enc.encode(GHOST);
    y.loaded = (resume ? M._yaya_load_resume : M._load)(heap(b), b.length);
    y.status = M._yaya_load_status();
  }
  return y;
}

// a ghost whose request evaluates the raw request text, like shell mode but with a config (normal mode)
const evalGhost = (extraConfig = '', load = '') => ({
  'yaya.txt': 'charset, UTF-8' + CRLF + 'dic, eval.dic' + CRLF + extraConfig,
  'eval.dic': (load ? 'load' + CRLF + '{' + CRLF + '\t' + load + CRLF + '}' + CRLF : '') +
    'request' + CRLF + '{' + CRLF + '\tEVAL(_argv[0])' + CRLF + '}' + CRLF,
});
const shioriGhost = {   // the 2-line config of a minimal SHIORI/3.0 ghost that answers ID: version
  'yaya.txt': 'charset, UTF-8' + CRLF + 'dic, shiori.dic' + CRLF,
  'shiori.dic': ['request', '{', '\tif RE_SEARCH(_argv[0], "ID: version") {',
    '\t\t"SHIORI/3.0 200 OK" + CHR(13,10) + "Charset: UTF-8" + CHR(13,10) + "Value: " + GETSETTING("coreinfo.version") + CHR(13,10) + CHR(13,10)',
    '\t}', '\telse {', '\t\t"SHIORI/3.0 204 No Content" + CHR(13,10) + CHR(13,10)', '\t}', '}', ''].join(CRLF),
};
const broken = {
  'yaya.txt': 'charset, UTF-8' + CRLF + 'dic, broken.dic' + CRLF,
  'broken.dic': 'request' + CRLF + '{' + CRLF + '\t"x"' + CRLF,
};
const emergency = {
  'yaya_emerg.txt': 'charset, UTF-8' + CRLF + 'dic, emerg.dic' + CRLF,
  'emerg.dic': 'request' + CRLF + '{' + CRLF + '\t"emergency"' + CRLF + '}' + CRLF,
};

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

const info = fs.existsSync(path.join(dir, 'yaya.build-info.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'yaya.build-info.json'), 'utf8')) : {};
console.log(`${dir}: yaya.wasm ${fs.statSync(path.join(dir, 'yaya.wasm')).size} bytes, ${JSON.stringify(info)}`);

await check('shell mode: no config -> request is EVAL of the raw text, status 3', async () => {
  const y = await boot({});
  if (y.statusBefore !== -1) return `status before load ${y.statusBefore}`;
  return y.status === 3 ? expect(y.request('1+2'), '3') : `status ${y.status}`;
});
await check('GET SHIORI/3.0 ID: version on a 2-line ghost -> the YAYA version, status 0', async () => {
  const y = await boot(shioriGhost);
  const r = y.request('GET SHIORI/3.0' + CRLF + 'ID: version' + CRLF + 'Charset: UTF-8' + CRLF + 'Sender: SSP' + CRLF + CRLF) || '';
  const v = (/^Value: (.*)$/m.exec(r) || [])[1];
  return y.status !== 0 ? `status ${y.status}` : expect(v && v.trim(), info.version || 'Tc606-2');
});
await check('module aya5: aya5.txt is the config, aya5_variable.cfg the save file, status 0', async () => {
  const files = evalGhost();
  files['aya5.txt'] = files['yaya.txt'];
  delete files['yaya.txt'];
  const y = await boot(files, { module: 'aya5' });
  if (y.status !== 0) return `status ${y.status}`;
  const sf = y.request('GETSETTING("coreinfo.savefile")');
  if (!/\/aya5_variable\.cfg$/.test(sf)) return `savefile ${sf}`;
  return y.M._yaya_save() === 1 && y.file('aya5_variable.cfg') ? true : `files ${y.files()}`;
});
await check('a broken dictionary -> status 2, no reply; Module.yayaLog gets a mode-2 (error) line', async () => {
  const y = await boot(broken);
  if (y.status !== 2) return `status ${y.status}`;
  if (y.request('GET SHIORI/3.0' + CRLF + CRLF) !== null) return 'a reply';
  return y.logs.some(l => l.mode === 2 && l.text.trim()) ? true : `logs ${JSON.stringify(y.logs.slice(0, 8))}`;
});
await check('a broken dictionary with yaya_emerg.txt -> status 1, the emergency dictionary answers', async () => {
  const y = await boot({ ...broken, ...emergency });
  return y.status === 1 ? expect(y.request('x'), 'emergency') : `status ${y.status}`;
});
await check('yaya_save -> 1 and yaya_variable.cfg exists', async () => {
  const y = await boot(evalGhost(), {});
  y.request('saved_value = 42');
  if (y.M._yaya_save() !== 1) return 'yaya_save != 1';
  const f = y.file('yaya_variable.cfg');
  return f && /saved_value/.test(dec.decode(f)) ? true : `files ${y.files()}`;
});
await check('resume: load does boots += 1; yaya_load_resume with the save keeps 1, a cold load makes 2', async () => {
  const files = evalGhost('', 'boots += 1');
  const y1 = await boot(files);
  if (y1.request('boots') !== '1') return `cold boots ${y1.request('boots')}`;
  y1.M._yaya_save();
  const save = { ...files, 'yaya_variable.cfg': y1.file('yaya_variable.cfg') };
  const y2 = await boot(save, { resume: true });
  if (y2.status !== 0) return `resume status ${y2.status}`;
  if (y2.request('boots') !== '1') return `resumed boots ${y2.request('boots')}`;
  const y3 = await boot(save);
  return expect(y3.request('boots'), '2');
});
await check('resume when load does SAVEVAR() itself (cyau_cyaka), plain and .ays: boots stays 1, nothing left in /tmp', async () => {
  for (const config of ['', 'save.encode, on' + CRLF]) {
    const files = evalGhost(config, 'boots += 1' + CRLF + '\tSAVEVAR()');
    const name = config ? 'yaya_variable.cfg.ays' : 'yaya_variable.cfg';
    const y1 = await boot(files);
    y1.request('kept = 42');
    if (y1.M._yaya_save() !== 1 || !y1.file(name)) return `${name}: files ${y1.files()}`;
    let save = { ...files, [name]: y1.file(name) };
    for (const round of [1, 2]) {     // and the next page, from the first resume's save
      const y = await boot(save, { resume: true });
      const tmp = y.M.FS.readdir('/tmp').filter(n => n !== '.' && n !== '..');
      const got = [y.status, y.request('boots'), y.request('kept'), tmp.length, y.files().length].join(' ');
      if (got !== '0 1 42 0 3') return `${name} round ${round}: status, boots, kept, /tmp files, ghost files = ${got}`;
      y.M._yaya_save();
      save = { ...files, [name]: y.file(name) };
    }
    if ((await boot(save)).request('boots') !== '2') return `${name}: a cold boot did not count`;
  }
  return true;
});
await check('CP932: GETSTRBYTES("①～－＼",0) = 8', async () => expect((await boot({})).request('GETSTRBYTES("①～－＼",0)'), '8'));
await check('CP932: FWRITE in Shift_JIS writes あいう① as 82A0 82A2 82A4 8740 and é as 65 (best fit)', async () => {
  const y = await boot(evalGhost());
  y.request('FCHARSET("Shift_JIS"); _d = FOPEN("w.txt","w"); _d = FWRITE2("w.txt","あいう①é"); _d = FCLOSE("w.txt")');
  const f = y.file('w.txt');
  return expect(f && Buffer.from(f).toString('hex'), '82a082a282a4874065');
});
await check('GETTICKCOUNT counts from Module.bootEpochMs (now - 3 h)', async () => {
  const y = await boot({}, { bootEpochMs: Date.now() - 3 * 3600e3 });
  const t = +y.request('GETTICKCOUNT()');
  return t >= 10800000 && t < 10800000 + 60e3 ? true : `GETTICKCOUNT ${t}`;
});
await check('EXECUTE / EXECUTE_WAIT -> -1, nothing runs', async () => {
  const y = await boot({});
  return expect([y.request('EXECUTE("notepad.exe")'), y.request('EXECUTE_WAIT("a.exe")')].join(' '), '-1 -1');
});
await check('GETENV("HOME") = "" with GETLASTERROR 12', async () => {
  const y = await boot({});
  return expect([y.request('GETENV("HOME")'), y.request('GETLASTERROR()')].join('|'), '|12');
});
await check('GETMEMINFO() = 45,8589934592,4724464025,2147352576,1717986918', async () =>
  expect((await boot({})).request('GETMEMINFO()'), '45,8589934592,4724464025,2147352576,1717986918'));
await check('FWRITEXML in the default charset declares Shift_JIS (CHARSET_DEFAULT = 932)', async () => {
  const y = await boot(evalGhost());
  y.request('_x = PARSEXML("<a>t</a>"); FWRITEXML("x.xml", _x, "default")');
  const f = y.file('x.xml');
  return f && /encoding="Shift_JIS"/.test(dec.decode(f)) ? true : `x.xml ${f && dec.decode(f)}`;
});
await check('requests and replies stay UTF-8 after SETSETTING("charset.output","Shift_JIS")', async () => {
  const y = await boot(evalGhost());
  y.request('SETSETTING("charset.output","Shift_JIS")');
  return expect(y.request('"あ①～" + "ア"'), 'あ①～ア');
});
await check('`log, x.log` writes no file; no request/response lines reach Module.yayaLog', async () => {
  const y = await boot(evalGhost('log, x.log' + CRLF));
  for (let i = 0; i < 5; i++) y.request('1+' + i);
  y.M._unload();
  if (y.file('x.log')) return 'x.log written';
  return y.logs.some(l => /\/\/ request|\/\/ response/.test(l.text)) ? 'request lines logged' : true;
});
await check('SAORI goes to Module.saoriBridge (UTF-8 both ways); no stand-in -> LOADLIB 0', async () => {
  const calls = [];
  const saoriBridge = {
    load(p, d) { calls.push(`load ${p} ${d}`); return /missing/.test(p) ? 0 : 7; },
    request(h, bytes) { calls.push(`request ${h} ${/Argument0: あ①/.test(dec.decode(bytes))}`); return 'SAORI/1.0 200 OK\r\nCharset: UTF-8\r\nResult: ①～\r\n\r\n'; },
    unload(h) { calls.push(`unload ${h}`); },
  };
  const y = await boot({}, { saoriBridge });
  const r = [y.request('LOADLIB("saori/test.dll")'),
    y.request('REQUESTLIB("saori/test.dll", "EXECUTE SAORI/1.0" + CHR(13,10) + "Charset: Shift_JIS" + CHR(13,10) + "Argument0: あ①" + CHR(13,10) + CHR(13,10))'),
    y.request('LOADLIB("saori/missing.dll")'), y.request('UNLOADLIB("saori/test.dll")')];
  if (r[0] !== '1' || !/Result: ①～/.test(r[1]) || r[2] !== '0') return `results ${JSON.stringify(r)}`;
  return expect(calls.join('; '), 'load /ghost/master/saori/test.dll /ghost/master/saori/; request 7 true; ' +
    'load /ghost/master/saori/missing.dll /ghost/master/saori/; unload 7');
});
await check('20,000 requests of 1 KB leave the malloc probe in place (request frees its input)', async () => {
  const y = await boot({});
  const probe = () => { const p = y.M._malloc(1 << 20); y.M._free(p); return p; };
  const p0 = probe();
  const expr = '1' + ' '.repeat(1000);
  for (let i = 0; i < 20000; i++) y.request(expr);
  const p1 = probe();
  return p1 === p0 ? true : `probe ${p0} -> ${p1}, heap ${y.M.HEAPU8.length}`;
});

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);

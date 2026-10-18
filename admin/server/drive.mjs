// sumika-admin driven from outside, as a site admin's browser would (CONTRACTS "Admin API"): the program started as a
// child process with scratch settings and temp folders, then the end-to-end steps over real HTTP on a scratch site
// (CLAUDE.md "The program and its builds": the e2e test and the build's smoke). Used by tests/admin/e2e.test.mjs (`node
// admin/server/main.mjs`) and admin/build.mjs (the compiled Windows program, also in a real hidden console:
// startInConsole), so both run the same steps. Not part of the program. Every path it writes is checked to lie
// outside the project (scratch copies only).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMA } from '../../src/core/schema.js';
import { zip } from '../zip.mjs';

export const PROJECT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXTURE = path.join(PROJECT, 'tests', 'fixtures', 'ghost', 'testghost');
const BALLOON = path.join(PROJECT, 'site', 'balloon', 'sumika');

/** p itself, when it lies outside the project; throws otherwise (tests and checks run on scratch copies only). */
export function scratchOnly(p) {
  const rel = path.relative(PROJECT, path.resolve(p));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`${p} is inside the project: scratch copies only`);
  return p;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A promise's value, or null after ms (the timer cleared either way, so it never holds the process). */
function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(r => { timer = setTimeout(() => r(null), ms); })]).finally(() => clearTimeout(timer));
}

function write(root, rel, data) {
  const p = path.join(scratchOnly(root), ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

/** Every file under a folder: [rel ('/'-separated), absolute path]. */
export function filesUnder(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else if (e.isFile()) out.push([r, path.join(dir, ...r.split('/'))]);
  }
  return out;
}

/** A copy of a folder (files and folders only). */
function copyDir(from, to) {
  for (const [rel, abs] of filesUnder(from)) write(to, rel, fs.readFileSync(abs));
}

export const SITE_BUILD = 'b0b0b0b0b0b0';
export const STALE = 'sumika/engines/worker.9999999999.js';

/**
 * A synthetic runtime set (what tools/prune.mjs reads: build.json, a sumika.js naming its build id once and its table,
 * the hashed files, hub.html naming its hub) with 404.html, a demo page, a dev/ page, a stale hashed worker and the
 * default balloon copied from the project's site/balloon/sumika; no index yet.
 */
export function makeSite(dir) {
  scratchOnly(dir);
  const table = {
    worker: 'engines/worker.0123456789.js',
    engines: { satori: { js: 'engines/satori.1111111111.js', wasm: 'engines/satori.2222222222.wasm' } },
  };
  const hub = 'engines/hub.3333333333.js';
  write(dir, 'sumika/build.json', JSON.stringify({ format: 1, build: SITE_BUILD, schema: SCHEMA, ...table, hub }, null, 2) + '\n');
  const named = [table.worker, table.engines.satori.js, table.engines.satori.wasm];
  write(dir, 'sumika/sumika.js', `/* a stand-in for the runtime bundle, build ${SITE_BUILD} */\nconst FILES = ${JSON.stringify(named)};\n`);
  write(dir, `sumika/${table.worker}`, '// a stand-in worker\n//# sourceMappingURL=worker.0123456789.js.map\n');
  write(dir, `sumika/${table.engines.satori.js}`, '// a stand-in engine\n');
  write(dir, `sumika/${table.engines.satori.wasm}`, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  write(dir, `sumika/${hub}`, '// a stand-in hub\n');
  write(dir, 'sumika/hub.html', `<!doctype html>\n<script src="${hub}"></script>\n`);
  write(dir, STALE, '// an older worker no upload carried\n');
  write(dir, 'sumika/engines/satori.js', '// a plain engine file (optional)\n');
  write(dir, 'sumika/engines/worker.0123456789.js.map', '{}\n');
  write(dir, '404.html', '<!doctype html><title>Not found</title>\n');
  write(dir, 'index.html', '<!doctype html><title>Sumika</title>\n');
  write(dir, 'dev/test.html', '<!doctype html><title>dev</title>\n');
  copyDir(BALLOON, path.join(dir, 'balloon', 'sumika'));
  return dir;
}

/** The fixture ghost (tests/fixtures/ghost/testghost) as a .nar's bytes, its files under `prefix`. */
export function fixtureNar(prefix = '') {
  return zip(filesUnder(FIXTURE).map(([rel, abs]) => ({ name: prefix + rel, data: fs.readFileSync(abs) })));
}

/**
 * Starts the program as a child: `command args --no-browser --settings <scratch>/settings.json --temp
 * <scratch>/temp`; `ready` resolves with {port, key} from its console's address line.
 */
export function startProgram({ command, args = [], scratch, env = process.env, cwd = undefined }) {
  scratchOnly(scratch);
  fs.mkdirSync(scratch, { recursive: true });
  const settings = path.join(scratch, 'settings.json'), temp = path.join(scratch, 'temp');
  const child = spawn(command, [...args, '--no-browser', '--settings', settings, '--temp', temp], {
    env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '', err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no address within 60 s\n${out}\n${err}`)), 60000);
    child.stdout.on('data', d => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?key=([0-9a-f]{64})/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), key: m[2] });
      }
    });
    child.stderr.on('data', d => { err += d; });
    exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`the program exited (${code}) before its address\n${out}\n${err}`));
    });
  });
  return { child, ready, exited, output: () => ({ out, err }), settings, temp, kill: () => child.kill() };
}

/** One argument of a Windows command line, quoted as CommandLineToArgvW reads it back. */
export function winArg(a) {
  const s = String(a);
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

const psQuote = s => `'${String(s).replace(/'/g, '\'\'')}'`;

/**
 * A console reader (Windows): pid → the text of that program's console window, or null. Runs admin/readcon.mjs with
 * the pinned deno.exe (FFI; its stdout and stderr are pipes, never that console), its output in `dir`.
 * @param {string} deno the pinned deno.exe (admin/build.mjs unpacks it into admin/build/)
 * @param {string} dir a scratch folder
 */
export function consoleReader(deno, dir) {
  let n = 0;
  return async pid => {
    scratchOnly(dir);
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `console-${pid}-${++n}.json`);
    const script = path.join(PROJECT, 'admin', 'readcon.mjs');
    const child = spawn(deno, ['run', '--no-config', '--no-prompt', '--allow-ffi', `--allow-write=${out}`, script, String(pid), out], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, DENO_DIR: path.join(dir, 'deno-dir'), DENO_NO_UPDATE_CHECK: '1', DENO_NO_PACKAGE_JSON: '1', NO_COLOR: '1' },
    });
    child.stdout.resume();
    child.stderr.resume();
    const end = await within(new Promise(r => child.on('exit', code => r({ code }))), 30000);
    if (!end && child.exitCode === null) child.kill();
    try {
      const j = JSON.parse(fs.readFileSync(out, 'utf8'));
      return j.lines ? j.lines.join('\n').replace(/\n+$/, '') : `(the console could not be read: ${j.error})`;
    } catch (e) {
      return null;
    }
  };
}

/**
 * Starts the program in a real console of its own, hidden (Windows): PowerShell's `Start-Process -WindowStyle Hidden
 * -PassThru`, so its std handles are that console and Deno sees a terminal, as when the admin double-clicks the
 * program (a run with piped stdin, as startProgram's, never sees a permission prompt: Deno denies silently there).
 * `ready` from <temp>/instance.json (the console is no pipe of ours), the exit status through the PowerShell that
 * waits for it, `consoleText()` through readConsole (consoleReader), `kill()` ends the program itself.
 * @param {{command: string, args?: string[], scratch: string, readConsole?: ((pid: number) => Promise<string|null>)|null}} o
 */
export function startInConsole({ command, args = [], scratch, readConsole = null }) {
  scratchOnly(scratch);
  fs.mkdirSync(scratch, { recursive: true });
  const settings = path.join(scratch, 'settings.json'), temp = path.join(scratch, 'temp');
  const line = [...args, '--no-browser', '--settings', settings, '--temp', temp].map(winArg).join(' ');
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$p = Start-Process -FilePath ${psQuote(command)} -ArgumentList ${psQuote(line)} -WindowStyle Hidden -PassThru`,
    '$null = $p.Handle',                                      // keeps the handle, so ExitCode is there after the exit
    '[Console]::Out.WriteLine("pid " + $p.Id)',
    '[Console]::Out.Flush()',
    '$p.WaitForExit()',
    'exit $p.ExitCode',
  ].join('\n');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '', pid = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => {
    out += d;
    const m = /^pid (\d+)\s*$/m.exec(out);
    if (m) pid = Number(m[1]);
  });
  child.stderr.on('data', d => { err += d; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  let gone = false;
  exited.then(() => { gone = true; });
  const ready = (async () => {
    const end = Date.now() + 60000;
    for (;;) {
      if (gone) throw new Error(`the program exited before it wrote ${path.join(temp, 'instance.json')}\n${out}\n${err}`);
      try {
        const j = JSON.parse(fs.readFileSync(path.join(temp, 'instance.json'), 'utf8'));
        if (pid !== null && j.pid === pid && Number.isInteger(j.port) && typeof j.key === 'string') return { port: j.port, key: j.key };
      } catch (e) { /* not yet */ }
      if (Date.now() > end) throw new Error(`no ${path.join(temp, 'instance.json')} within 60 s (pid ${pid})\n${out}\n${err}`);
      await sleep(100);
    }
  })();
  ready.catch(() => {});                                       // a second start never writes one: not awaited there
  // only while the PowerShell lives: it holds the program's handle, so that pid is no other process's yet
  const kill = () => {
    if (gone || pid === null) return;
    try { process.kill(pid); } catch (e) { /* ended meanwhile */ }
  };
  const consoleText = async () => (readConsole && pid !== null && !gone ? readConsole(pid) : null);
  return { child, ready, exited, output: () => ({ out: '', err: '' }), settings, temp, kill, consoleText, pid: () => pid };
}

/**
 * The API over real HTTP with the start's key; a call that has no answer within timeoutMs fails (a program that
 * stopped answering: a permission prompt in its console, a blocked thread).
 */
export function client(port, key, { timeoutMs = 45000 } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body = undefined, headers = {}) => {
    const init = { method, headers: { 'X-Sumika-Admin-Key': key, ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      if (body instanceof Uint8Array) init.body = body;
      else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
      }
    }
    let r, text;
    try {
      r = await fetch(base + p, init);
      text = await r.text();
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`e2e: ${method} ${p}: no answer within ${timeoutMs} ms`);
      throw e;
    }
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: r.status, body: json, text, headers: r.headers };
  };
  const post = (p, b = {}) => call('POST', p, b);
  const waitJob = async (id, ms = 120000) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = await call('GET', '/api/status');
      const j = s.body && s.body.job;
      if (j && j.id === id && j.state !== 'running') return j;
      if (Date.now() > end) throw new Error(`job ${id} still running after ${ms} ms`);
      await sleep(40);
    }
  };
  /** Starts a job and waits for its end: the finished job. */
  const job = async (p, b = {}) => {
    const r = await post(p, b);
    if (r.status !== 200) throw new Error(`${p}: ${r.status} ${r.text}`);
    return waitJob(r.body.id);
  };
  return { base, call, post, job, waitJob };
}

/** A raw GET with a Host header of one's own (fetch would send the real one). */
export function rawGet(port, p, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { Host: host } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function expect(cond, what, detail = undefined) {
  if (!cond) throw new Error(`e2e: ${what}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

/**
 * The end-to-end steps on a new scratch site: hello; a wrong Host; the site; add the fixture ghost from its folder,
 * from a .nar and through a drop; the ghost list; Check; Prepare upload (first); the hub.json screen; the preview; a
 * junction inside an added ghost (Check names it, Remove deletes the ghost and leaves what the junction points to);
 * Quit; no error log written. Throws at the first step that goes wrong (a call with no answer too: client's timeout).
 * With `inConsole` (Windows) the program runs in a real hidden console (startInConsole), and a failure carries that
 * console's text (readConsole).
 * @param {{command: string, args?: string[], scratch: string, log?: (line: string) => void, inConsole?: boolean,
 *   readConsole?: (pid: number) => Promise<string|null>}} o
 * @returns {Promise<object>} what the steps answered, and the site's final sumika/index/ files
 */
export async function runE2E({ command, args = [], scratch, log = () => {}, inConsole = false, readConsole = null }) {
  scratchOnly(scratch);
  const report = {};
  const site = makeSite(path.join(scratch, 'site'));
  const src = path.join(scratch, 'src');
  const nar = write(src, 'testghost_nar.nar', fixtureNar());
  const begin = o => (inConsole ? startInConsole({ ...o, readConsole }) : startProgram(o));
  const prog = begin({ command, args, scratch: path.join(scratch, 'program') });
  try {
    return await steps();
  } catch (e) {
    // what the program's own window shows (a permission prompt, an error) belongs to the failure
    const text = prog.consoleText ? await prog.consoleText().catch(() => null) : null;
    if (prog.consoleText) e.message += `\n--- the program's console ---\n${text ?? '(it could not be read: the program has ended?)'}`;
    throw e;
  } finally {
    prog.kill();
  }

  async function steps() {
    const { port, key } = await prog.ready;
    const api = client(port, key);
    log(`program at ${api.base}`);

    const hello = await api.call('GET', '/api/hello');
    expect(hello.status === 200 && hello.body.app === 'sumika-admin', 'hello', hello.text);
    expect(hello.body.settings.where === 'given' && hello.body.site === null, 'hello settings', hello.body.settings);
    report.version = hello.body.version;
    expect((await api.call('GET', '/api/hello', undefined, { 'X-Sumika-Admin-Key': '0'.repeat(64) })).status === 403, 'a wrong key');
    const bad = await rawGet(port, '/', `evil.example:${port}`);
    expect(bad.status === 403 && /bad-host/.test(bad.body), 'a wrong Host', bad);
    report.badHost = bad.status;

    const roots = await api.post('/api/fs/roots');
    expect(roots.status === 200 && roots.body.drives.length >= 1 && Array.isArray(roots.body.places), 'fs/roots', roots.text);
    const listed = await api.post('/api/fs/list', { path: src });
    const narEntry = listed.body && listed.body.entries.find(e => e.name === 'testghost_nar.nar');
    expect(listed.status === 200 && narEntry && narEntry.archive === true && narEntry.kind === 'file', 'fs/list', listed.text);
    report.roots = roots.body.drives;

    const set = await api.post('/api/site', { path: site });
    expect(set.status === 200 && set.body.readOnly === null && set.body.runtime.build === SITE_BUILD, 'the site', set.text);
    report.site = set.body;

    const indexed = await api.job('/api/index');
    expect(indexed.state === 'done', 'the first index', indexed);

    // from the folder
    const ins = await api.job('/api/inspect', { sources: [{ path: FIXTURE }] });
    expect(ins.state === 'done' && ins.result.items.length === 1 && ins.result.items[0].token, 'inspect the folder', ins);
    expect(ins.result.items[0].id === 'testghost' && !ins.result.items[0].refusal, 'the folder item', ins.result.items[0]);
    const add1 = await api.job('/api/add', { plan: [{ token: ins.result.items[0].token }] });
    expect(add1.state === 'done' && add1.result.items[0].ok && add1.result.index, 'add the folder', add1);

    // from a .nar
    const insNar = await api.job('/api/inspect', { sources: [{ path: nar }] });
    const narItem = insNar.result && insNar.result.items[0];
    expect(insNar.state === 'done' && narItem && narItem.id === 'testghost_nar' && narItem.token && !narItem.refusal, 'inspect the .nar', insNar);
    const add2 = await api.job('/api/add', { plan: [{ token: narItem.token }] });
    expect(add2.state === 'done' && add2.result.items[0].ok, 'add the .nar', add2);

    // through a drop
    const drop = await api.post('/api/drop');
    expect(drop.status === 200 && drop.body.drop, 'a drop', drop.text);
    for (const [rel, abs] of filesUnder(FIXTURE)) {
      const put = await api.call('PUT', `/api/drop/${drop.body.drop}/0`, fs.readFileSync(abs), {
        'Content-Type': 'application/octet-stream', 'X-Sumika-Path': ['droppedghost', ...rel.split('/')].map(encodeURIComponent).join('/'),
      });
      expect(put.status === 200, `drop ${rel}`, put.text);
    }
    const done = await api.post(`/api/drop/${drop.body.drop}/done`, { roots: [{ n: 0, name: 'droppedghost', kind: 'dir' }] });
    expect(done.status === 200, 'the drop is done', done.text);
    const insDrop = await api.waitJob(done.body.id);
    const dropItem = insDrop.result && insDrop.result.items[0];
    expect(insDrop.state === 'done' && dropItem && dropItem.id === 'droppedghost' && dropItem.dropped && dropItem.dropped.name === 'droppedghost', 'inspect the drop', insDrop);
    const add3 = await api.job('/api/add', { plan: [{ token: dropItem.token }] });
    expect(add3.state === 'done' && add3.result.items[0].ok, 'add the drop', add3);
    const dropGone = await api.post(`/api/drop/${drop.body.drop}/cancel`);
    expect(dropGone.status === 404, 'a drop an add used is gone', dropGone.text);

    const ghosts = await api.post('/api/ghosts');
    report.ghosts = ghosts.body.ghosts.map(g => g.id);
    expect(ghosts.status === 200 && report.ghosts.join(',') === 'droppedghost,testghost,testghost_nar'
      && ghosts.body.ghosts.every(g => g.indexed && g.folder), 'the ghost list', ghosts.body);

    const check = await api.job('/api/check');
    expect(check.state === 'done' && check.result.ok && !check.result.problems.length, 'a clean Check', check);

    const noFirst = await api.post('/api/prepare');
    expect(noFirst.status === 409 && noFirst.body.error.code === 'needs-first', 'prepare without a ledger', noFirst.text);
    const prep = await api.job('/api/prepare', { first: true });
    expect(prep.state === 'done', 'prepare (first)', prep);
    const files = prep.result.files.map(f => f.path);
    report.prepare = { deleted: prep.result.deleted, count: prep.result.count, last: files.slice(-3) };
    expect(prep.result.deleted.includes(STALE) && !fs.existsSync(path.join(site, ...STALE.split('/'))), 'prune deleted the stale worker', prep.result.deleted);
    expect(files.slice(-3).join(',') === 'sumika/hub.html,sumika/sumika.js,sumika/index/ghosts.json', 'the upload order', files.slice(-3));
    expect(!files.some(f => f.startsWith('dev/')) && files.includes('404.html'), 'dev/ left out, 404.html in', files);
    expect(prep.result.files.find(f => f.path === 'sumika/engines/satori.js').optional === 'plain-engine', 'a plain engine file is optional');
    expect(prep.result.files.find(f => f.path === 'sumika/engines/worker.0123456789.js.map').optional === 'map', 'a map is optional');
    expect(fs.existsSync(`${site}.published.json`), 'the ledger beside the site');

    const hubBad = await api.post('/api/hub/save', { origins: ['https://a.example.com', 'http://localhost:8644'] });
    expect(hubBad.status === 200 && !hubBad.body.ok && hubBad.body.problems[0].code === 'loopback', 'hub.json refuses a loopback entry', hubBad.text);
    expect(!fs.existsSync(path.join(site, 'sumika', 'hub.json')), 'nothing written for a refused list');
    const hubOk = await api.post('/api/hub/save', { origins: ['https://a.example.com'] });
    const hubRead = await api.post('/api/hub');
    expect(hubOk.body.ok && hubRead.body.exists && hubRead.body.origins.join() === 'https://a.example.com' && hubRead.body.runtimeHasHub, 'hub.json saved', hubRead.text);
    const hubEmpty = await api.post('/api/hub/save', { origins: [] });
    expect(hubEmpty.body.ok && !fs.existsSync(path.join(site, 'sumika', 'hub.json')), 'an empty list deletes hub.json');

    const pv = await api.post('/api/preview/start', { lang: 'ja' });
    expect(pv.status === 200 && pv.body.pages.length === 2, 'the preview', pv.text);
    const hubAnswer = await (await fetch(`${pv.body.site}sumika/hub.json`)).json();
    expect(hubAnswer.origins.join() === pv.body.pages.map(u => u.replace(/\/$/, '')).join(), 'the preview hub.json', hubAnswer);
    const pageA = await (await fetch(pv.body.pages[0])).text();
    expect(pageA.includes(`${pv.body.site}sumika/sumika.js`) && pageA.includes('data-hub') && pageA.includes(pv.body.pages[1].replace(/\/$/, '')), 'the preview page', pageA);
    const ghostFile = await fetch(`${pv.body.site}ghost/testghost/ghost/master/descript.txt`);
    expect(ghostFile.status === 200 && ghostFile.headers.get('access-control-allow-origin') === '*', 'the preview serves the site');
    const sPort = Number(new URL(pv.body.site).port);
    expect((await rawGet(sPort, '/', `localhost:${sPort}`)).status === 403, 'the preview checks Host');
    expect((await api.post('/api/preview/stop')).status === 200, 'the preview stops');

    // a junction inside an added ghost, pointing out of the site
    const outside = path.join(scratch, 'outside');
    write(outside, 'keep.txt', 'not the site\'s\n');
    fs.symlinkSync(outside, path.join(site, 'ghost', 'testghost', 'linked'), 'junction');
    const inGhost = await api.post('/api/fs/list', { path: path.join(site, 'ghost', 'testghost') });
    const linkEntry = inGhost.body && inGhost.body.entries.find(e => e.name === 'linked');
    expect(linkEntry && linkEntry.kind === 'link' && linkEntry.target === 'dir', 'fs/list names the junction a link', inGhost.text);
    const check2 = await api.job('/api/check');
    expect(check2.state === 'done' && check2.result.problems.some(p => p.code === 'site.link' && p.params.path === 'ghost/testghost/linked'), 'Check names the junction', check2.result);
    const rm = await api.job('/api/remove', { id: 'testghost' });
    expect(rm.state === 'done' && rm.result.deleteOnHost === 'ghost/testghost/', 'remove', rm);
    expect(!fs.existsSync(path.join(site, 'ghost', 'testghost')) && fs.existsSync(path.join(outside, 'keep.txt')), 'the junction removed, its target kept');
    const after = await api.post('/api/ghosts');
    expect(after.body.ghosts.map(g => g.id).join(',') === 'droppedghost,testghost_nar', 'the list after removing', after.body);

    // a second start on the same temp root finds this one (its probe of 127.0.0.1) and leaves it running (in a console
    // its lines are in its own window, gone with it: the status and the first start's answers tell)
    const second = begin({ command, args, scratch: path.join(scratch, 'program') });
    try {
      const secondEnd = await within(second.exited, 30000);
      expect(secondEnd && secondEnd.code === 0 && (inConsole || second.output().out.includes(`http://127.0.0.1:${port}/?key=${key}`)),
        'a second start opens the first', secondEnd ? second.output() : 'it did not end within 30 s');
    } finally {
      second.kill();
    }
    expect((await api.call('GET', '/api/status')).status === 200, 'the first start goes on');

    const output = inConsole ? { out: (await prog.consoleText()) ?? '', err: '' } : null;
    const quit = await api.post('/api/quit');
    expect(quit.status === 200, 'quit', quit.text);
    const ended = await within(prog.exited, 15000);
    expect(ended && ended.code === 0, 'the program stopped with status 0', ended);
    expect(!fs.existsSync(path.join(prog.temp, 'instance.json')), 'instance.json removed');
    expect(!fs.readdirSync(prog.temp).some(n => /^r-/.test(n)), 'the run folder removed', fs.readdirSync(prog.temp));
    expect(!fs.existsSync(path.join(prog.temp, 'job.json')), 'no journal left');
    const errors = path.join(prog.temp, 'sumika-admin.log');
    expect(!fs.existsSync(errors), 'nothing in the error log', fs.existsSync(errors) ? fs.readFileSync(errors, 'utf8') : '');
    report.index = Object.fromEntries(filesUnder(path.join(site, 'sumika', 'index')).map(([rel, abs]) => [rel, fs.readFileSync(abs)]));
    report.output = output || prog.output();
    return report;
  }
}

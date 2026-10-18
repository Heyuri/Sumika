#!/usr/bin/env node
// Builds sumika-admin (CLAUDE.md "The program and its builds"), offline (tools make no network requests):
//   node admin/build.mjs --page                         the page only: admin/build/page.gen.mjs (dev starts run it)
//   node admin/build.mjs [--target T[,T…]] [--no-smoke]  T: windows-x64, macos-arm64, macos-x64, linux-x64, all (default)
// (1) every pinned download's size and SHA-256 against admin/pins.json, else it stops naming what to download where;
// (2) the page: admin/page/main.js (an IIFE, ES2020) and style.css inlined into index.html, their CSP hashes;
// (3) the program's bundles in admin/build/: sumika-admin.mjs (the server, with the page), job.mjs (the job worker)
//     and pickwin.mjs (the Windows file dialog's worker), import.meta.main compiled out (a bundled CLI guard would run
//     its main), stopping if any is left; the version is package.json's + the nameHash of the server
//     bundle; the two workers are embedded beside the server bundle (--include), whose new URL('./….mjs') names them;
// (4) deno compile per target, permissions baked in, from a scratch folder with no package.json above it, with
//     DENORT_BIN the pinned runtime (unpacked into admin/build/) and DENO_NO_UPDATE_CHECK, so nothing is downloaded (a
//     "download" in its output stops the build);
// (5) the macOS and Linux programs zipped with mode 0755 (admin/zip.mjs), and SHA256SUMS.txt;
// (6) unless --no-smoke, the smoke on the Windows program: admin/server/drive.mjs's e2e steps against it (with piped
//     stdio, then again in a real hidden console, where a permission prompt would show) and against a Node run on
//     the same inputs, their sumika/index/ compared;
// (7) one line per output: name, size, SHA-256. Programs go to admin/dist/<version>/, never under site/.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nameHash } from '../tools/hashname.mjs';
import { openZip } from '../tools/sweep/zip.mjs';
import { zip } from './zip.mjs';

const ADMIN = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(ADMIN, '..');
export const BUILD = path.join(ADMIN, 'build');
export const DIST = path.join(ADMIN, 'dist');

/**
 * The four programs (deno's target is the pin's `target`); `run`: the programs each may start, its browser opener
 * (admin/server/open.mjs) and on macOS and Linux its file dialogs (admin/server/picker.mjs); `ffi`: the Windows file
 * dialog's system calls (admin/server/pickwin.mjs).
 */
export const TARGETS = Object.freeze({
  'windows-x64': { output: 'sumika-admin.exe', zip: false, run: 'rundll32.exe', ffi: true },
  'macos-arm64': { output: 'sumika-admin-macos-arm64', zip: true, run: 'open,osascript', ffi: false },
  'macos-x64': { output: 'sumika-admin-macos-x64', zip: true, run: 'open,osascript', ffi: false },
  'linux-x64': { output: 'sumika-admin-linux-x64', zip: true, run: 'xdg-open,zenity,kdialog', ffi: false },
});

/** The environment the program reads (admin/server/main.mjs ENV_NAMES; a test keeps them equal). */
export const ENV_ALLOWED = Object.freeze(['APPDATA', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMP', 'TEMP', 'TMPDIR']);

/**
 * The permissions baked into a program: no network but 127.0.0.1, no other program than its
 * platform's browser opener (admin/server/open.mjs), only the environment it reads; reading and writing stay broad (the
 * file browser covers every drive, the site is chosen at run time; the program's own write rules are in admin/server/).
 * --no-prompt: an access the flags do not grant throws at once. Without it Deno asks "Allow? [y/n/A]" in the console
 * window and the whole program waits there for an answer: the job worker's environment did that in a real run
 * [measured, Deno 2.9.7; admin/server/jobs.mjs workerRunner], and a run without a terminal (stdin a pipe,
 * as in the tests) never sees it, which is why the smoke also runs the program in a real console (smoke, drive.mjs).
 * --allow-ffi (Windows) is whole: Deno 2.9.7's --allow-ffi=<the four DLLs> lets their dlopen through but refuses the
 * pointer operations a COM call needs (UnsafePointer.create: "Requires ffi access") [measured].
 */
export const permissions = target => ['--allow-read', '--allow-write', '--allow-net=127.0.0.1',
  `--allow-run=${TARGETS[target].run}`, `--allow-env=${ENV_ALLOWED.join(',')}`, ...(TARGETS[target].ffi ? ['--allow-ffi'] : []),
  '--no-prompt'];

class Stop extends Error {}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const sha256File = file => sha256(fs.readFileSync(file));
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');

/** Writes a file through a temporary one and a rename (dev starts may build the page at the same time). */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function writeIfChanged(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  try {
    if (fs.readFileSync(file).equals(buf)) return false;
  } catch (e) { /* not there yet */ }
  writeAtomic(file, buf);
  return true;
}

// ---- (2) the page ----------------------------------------------------------------------------------------------

// where the style and the script go: the template's <style>/*@@SUMIKA_ADMIN_STYLE@@*/</style> and
// <script>/*@@SUMIKA_ADMIN_SCRIPT@@*/</script> (each tag replaced whole, so its text is exactly what is hashed), or a
// <!--sumika-admin:style--> / <!--sumika-admin:script--> marker, or the tags that load style.css and main.js
const STYLE = [/<style>\s*\/\*@@SUMIKA_ADMIN_STYLE@@\*\/\s*<\/style>/g, /<!--\s*sumika-admin:style\s*-->/g,
  /<link\b[^>]*\bhref=["']?(?:\.\/)?style\.css["']?[^>]*>/gi];
const SCRIPT = [/<script>\s*\/\*@@SUMIKA_ADMIN_SCRIPT@@\*\/\s*<\/script>/g, /<!--\s*sumika-admin:script\s*-->/g,
  /<script\b[^>]*\bsrc=["']?(?:\.\/)?main\.js["']?[^>]*>\s*<\/script>/gi];

/** The one place in the template a marker (or the tag it stands for) is; throws when there is none or several. */
function slot(template, patterns, what) {
  for (const re of patterns) {
    const hits = [...template.matchAll(re)];
    if (hits.length > 1) throw new Stop(`admin/page/index.html has ${hits.length} ${what} markers`);
    if (hits.length === 1) return { at: hits[0].index, length: hits[0][0].length };
  }
  throw new Stop(`admin/page/index.html has no ${what} marker (<!--sumika-admin:${what}-->)`);
}

const hashSource = s => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/**
 * The page: main.js and style.css bundled and inlined into index.html, and the CSP with their hashes; written to
 * admin/build/page.gen.mjs (`export const PAGE, CSP`), which the program's bundle embeds.
 * @param {{dir?: string, write?: boolean}} [o] dir: the page's folder (tests: a scratch page)
 * @returns {Promise<{html: string, csp: string}>}
 */
export async function buildPage({ dir = path.join(ADMIN, 'page'), write = true } = {}) {
  const template = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const common = { absWorkingDir: ROOT, bundle: true, write: false, logLevel: 'warning', charset: 'utf8', legalComments: 'none' };
  const js = await esbuild.build({ ...common, entryPoints: [path.join(dir, 'main.js')], format: 'iife', target: ['es2020'], platform: 'browser', outfile: path.join(BUILD, 'page.js') });
  const css = await esbuild.build({ ...common, entryPoints: [path.join(dir, 'style.css')], outfile: path.join(BUILD, 'page.css') });
  // the HTML parser turns CR LF into LF before a hash is taken: the inlined text is LF only
  const script = Buffer.from(js.outputFiles[0].contents).toString('utf8').replace(/\r\n?/g, '\n').replace(/<\/script/gi, '<\\/script');
  const style = Buffer.from(css.outputFiles[0].contents).toString('utf8').replace(/\r\n?/g, '\n');
  if (/<\/style/i.test(style)) throw new Stop('admin/page/style.css holds "</style"');
  const s1 = slot(template, STYLE, 'style'), s2 = slot(template, SCRIPT, 'script');
  const parts = [[s1, `<style>${style}</style>`], [s2, `<script>${script}</script>`]].sort((a, b) => b[0].at - a[0].at);
  let html = template;
  for (const [s, text] of parts) html = html.slice(0, s.at) + text + html.slice(s.at + s.length);
  html = html.replace(/\r\n?/g, '\n');
  const csp = `default-src 'none'; script-src ${hashSource(script)}; style-src ${hashSource(style)}; connect-src 'self'; `
    + 'img-src \'self\' data:; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'';
  if (write) writeIfChanged(path.join(BUILD, 'page.gen.mjs'), `export const PAGE = ${JSON.stringify(html)};\nexport const CSP = ${JSON.stringify(csp)};\n`);
  return { html, csp };
}

// ---- (3) the bundles -------------------------------------------------------------------------------------------

const ENTRY = 'import { PAGE, CSP } from \'./page.gen.mjs\';\nimport { main } from \'../server/main.mjs\';\n'
  + 'main({ page: { html: PAGE, csp: CSP } });\n';

const defines = version => ({
  'import.meta.main': 'false', __SUMIKA_ADMIN_COMPILED__: 'true', __SUMIKA_ADMIN_VERSION__: JSON.stringify(version),
});

async function bundle(options, version) {
  const r = await esbuild.build({
    absWorkingDir: ROOT, bundle: true, platform: 'node', format: 'esm', target: ['es2022'], write: false,
    legalComments: 'none', logLevel: 'warning', charset: 'utf8', define: defines(version), ...options,
  });
  const out = Buffer.from(r.outputFiles[0].contents);
  if (/import\.meta\.main/.test(out.toString('utf8'))) throw new Stop(`${options.outfile}: import.meta.main is left in the bundle`);
  return out;
}

/**
 * The server bundle (twice: the version is the hash of the first pass) and the two worker bundles, in admin/build/.
 * @returns {Promise<{version: string, server: string, worker: string, picker: string}>}
 */
export async function buildBundles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const server = { stdin: { contents: ENTRY, resolveDir: BUILD, sourcefile: 'admin/build/entry.mjs', loader: 'js' }, outfile: path.join(BUILD, 'sumika-admin.mjs') };
  const first = await bundle(server, `${pkg.version}-0000000000`);
  const version = `${pkg.version}-${nameHash(first)}`;
  const serverJs = await bundle(server, version);
  const workerJs = await bundle({ entryPoints: [path.join(ADMIN, 'server', 'job.mjs')], outfile: path.join(BUILD, 'job.mjs') }, version);
  const pickerJs = await bundle({ entryPoints: [path.join(ADMIN, 'server', 'pickwin.mjs')], outfile: path.join(BUILD, 'pickwin.mjs') }, version);
  writeIfChanged(server.outfile, serverJs);
  writeIfChanged(path.join(BUILD, 'job.mjs'), workerJs);
  writeIfChanged(path.join(BUILD, 'pickwin.mjs'), pickerJs);
  return { version, server: server.outfile, worker: path.join(BUILD, 'job.mjs'), picker: path.join(BUILD, 'pickwin.mjs') };
}

// ---- (1) and (4): the pinned Deno, the programs ----------------------------------------------------------------

export function readPins() {
  return JSON.parse(fs.readFileSync(path.join(ADMIN, 'pins.json'), 'utf8'));
}

/** Step 1: each pinned archive the targets need, by size and SHA-256. */
export function checkPins(pins, targets) {
  const dir = path.join(ROOT, pins.deno.dir);
  const need = [['deno', pins.deno.cli], ...targets.map(t => [t, pins.deno.denort[t]])];
  for (const [what, p] of need) {
    if (!p) throw new Stop(`admin/pins.json pins nothing for ${what}`);
    const file = path.join(dir, p.file);
    const where = `download ${p.url} into ${pins.deno.dir}/ (${p.size} bytes, SHA-256 ${p.sha256})`;
    if (!fs.existsSync(file)) throw new Stop(`${pins.deno.dir}/${p.file} is missing: ${where}`);
    const size = fs.statSync(file).size;
    if (size !== p.size) throw new Stop(`${pins.deno.dir}/${p.file} is ${size} bytes, not ${p.size}: ${where}`);
    const sum = sha256File(file);
    if (sum !== p.sha256) throw new Stop(`${pins.deno.dir}/${p.file} has SHA-256 ${sum}, not ${p.sha256}: ${where}`);
  }
}

/** A pinned archive's one binary, unpacked into admin/build/deno-<version>/ (again only when the archive changed). */
function unpack(pins, p, name) {
  const zipFile = path.join(ROOT, pins.deno.dir, p.file);
  const out = path.join(BUILD, `deno-${pins.deno.version}`, name);
  const stamp = `${out}.from`;
  try {
    if (fs.statSync(out).size === p.memberSize && fs.readFileSync(stamp, 'utf8') === p.sha256) return out;
  } catch (e) { /* unpack it */ }
  const rec = openZip(zipFile).all.find(r => r.name === p.member);
  if (!rec) throw new Stop(`${p.file} holds no ${p.member}`);
  const data = rec.readChecked();
  if (data.length !== p.memberSize) throw new Stop(`${p.file}: ${p.member} is ${data.length} bytes, not ${p.memberSize}`);
  writeAtomic(out, data);
  if (!name.endsWith('.exe')) fs.chmodSync(out, 0o755);
  fs.writeFileSync(stamp, p.sha256);
  return out;
}

/** A folder with no package.json, deno.json or deno.jsonc in it or above it (nothing of node_modules gets embedded). */
function cleanScratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-build-'));
  for (let d = path.dirname(dir); ; d = path.dirname(d)) {
    for (const f of ['package.json', 'deno.json', 'deno.jsonc']) {
      if (fs.existsSync(path.join(d, f))) throw new Stop(`${path.join(d, f)} is above the build's scratch folder ${dir}`);
    }
    if (path.dirname(d) === d) break;
  }
  return dir;
}

/** Step 4: one program. */
function compile({ deno, denort, name, target, entry, include, output, denoDir }) {
  const args = ['compile', '--target', target, '--output', output, '--no-config', ...include.flatMap(f => ['--include', f]),
    ...permissions(name), entry];
  const r = spawnSync(deno, args, {
    cwd: path.dirname(entry), encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true,
    env: { ...process.env, DENO_NO_UPDATE_CHECK: '1', DENO_NO_PACKAGE_JSON: '1', DENO_DIR: denoDir, DENORT_BIN: denort, NO_COLOR: '1' },
  });
  if (r.error) throw r.error;
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) throw new Stop(`deno compile --target ${target} failed (${r.status}):\n${log}`);
  // Deno names each fetch on a line of its own ("Download https://…"); the build must never fetch
  if (/^\s*Download\b/m.test(log)) throw new Stop(`deno compile --target ${target} downloaded something:\n${log}`);
  return log;
}

// ---- (6) the smoke ---------------------------------------------------------------------------------------------

/** The files of a folder: rel -> bytes. */
function snapshot(dir) {
  const out = new Map();
  const walk = r => {
    for (const e of fs.readdirSync(path.join(dir, r), { withFileTypes: true })) {
      const p = r ? `${r}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else out.set(p, fs.readFileSync(path.join(dir, p)));
    }
  };
  walk('');
  return out;
}

/**
 * The e2e steps against the compiled Windows program and against a Node run on the same inputs; the two sites'
 * sumika/index/ compared (ghosts.json and the manifests byte for byte, the packs by name and gunzipped content: gzip
 * bytes may differ between runtimes, a pack's name is the hash of its content). With `deno` (the pinned deno.exe) the
 * steps run a third time, on the program started in a real hidden console (drive.mjs startInConsole: Deno sees a
 * terminal there, as at a double-click, and a permission it lacks would block the program at a prompt; a run with
 * piped stdin never shows that), a step that gets no answer failing with that console's text (admin/readcon.mjs).
 * Nothing may appear beside the program (no sumika-admin.json: --settings is given), and the project's site/ index
 * must not change.
 */
export async function smoke(exe, { log = line => console.log(line), deno = null } = {}) {
  const { runE2E, consoleReader } = await import('./server/drive.mjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-smoke-'));
  const beside = fs.readdirSync(path.dirname(exe)).sort().join('\n');
  const projectIndex = path.join(ROOT, 'site', 'sumika', 'index');
  const before = fs.existsSync(projectIndex) ? fs.readdirSync(projectIndex).sort().join('\n') : null;
  /** A run's index against the Node run's: [byte-identical, packs of equal content but other gzip bytes]. */
  const compare = (what, run, node) => {
    const a = Object.keys(run.index).sort(), b = Object.keys(node.index).sort();
    if (a.join('\n') !== b.join('\n')) throw new Stop(`smoke: the index files differ:\n  ${what}:  ${a.join(' ')}\n  node: ${b.join(' ')}`);
    let same = 0, packs = 0;
    for (const name of a) {
      const x = run.index[name], y = node.index[name];
      if (name.endsWith('.pack.gz')) {
        if (!zlib.gunzipSync(x).equals(zlib.gunzipSync(y))) throw new Stop(`smoke: ${name}'s content differs between the ${what} and Node`);
        if (x.equals(y)) same++;
        else packs++;
      } else if (!x.equals(y)) throw new Stop(`smoke: ${name} differs between the ${what} and Node`);
      else same++;
    }
    return [same, packs];
  };
  try {
    const t0 = Date.now();
    const exeRun = await runE2E({ command: exe, scratch: path.join(scratch, 'exe') });
    const exeMs = Date.now() - t0;
    const t1 = Date.now();
    const nodeRun = await runE2E({ command: process.execPath, args: [path.join(ADMIN, 'server', 'main.mjs')], scratch: path.join(scratch, 'node') });
    const nodeMs = Date.now() - t1;
    const [same, packs] = compare('exe', exeRun, nodeRun);
    let consoleMs = null;
    if (deno) {
      const t2 = Date.now();
      const conRun = await runE2E({ command: exe, scratch: path.join(scratch, 'console'), inConsole: true,
        readConsole: consoleReader(deno, path.join(scratch, 'console-read')) });
      consoleMs = Date.now() - t2;
      compare('exe in a console', conRun, nodeRun);
      if (!/このウィンドウを閉じると/.test(conRun.output.out)) throw new Stop(`smoke: the console lacks the start lines:\n${conRun.output.out}`);
    }
    if (fs.readdirSync(path.dirname(exe)).sort().join('\n') !== beside) throw new Stop(`smoke: something was written beside ${exe}`);
    if (before !== null && fs.readdirSync(projectIndex).sort().join('\n') !== before) throw new Stop('smoke: the project\'s site/sumika/index changed');
    const files = Object.keys(exeRun.index).length;
    log(`smoke: the e2e steps passed on ${path.basename(exe)} (${exeMs} ms)${consoleMs !== null ? `, on it in a console (${consoleMs} ms)` : ''} `
      + `and on Node (${nodeMs} ms); ${files} index files, ${same} byte-identical${packs ? `, ${packs} pack(s) of equal content but other gzip bytes` : ''}`);
    return { files, identical: same, packsOtherBytes: packs, version: exeRun.version, exeMs, nodeMs, consoleMs, output: exeRun.output };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- the command -----------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { page: false, targets: null, smoke: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--page') o.page = true;
    else if (a === '--no-smoke') o.smoke = false;
    else if (a === '--target' && i + 1 < argv.length) {
      for (const t of argv[++i].split(',')) {
        if (t === 'all') o.targets = Object.keys(TARGETS);
        else if (TARGETS[t]) o.targets = [...new Set([...(o.targets || []), t])];
        else throw new Stop(`unknown target ${t} (${Object.keys(TARGETS).join(', ')}, all)`);
      }
    } else throw new Stop(`unknown argument ${a}\nusage: node admin/build.mjs [--page] [--target T[,T…]|all] [--no-smoke]`);
  }
  o.targets ||= Object.keys(TARGETS);
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.page) {
    const p = await buildPage();
    console.log(`admin/build/page.gen.mjs: the page, ${Buffer.byteLength(p.html)} bytes`);
    return;
  }
  const pins = readPins();
  checkPins(pins, o.targets);
  await buildPage();
  const { version, server, worker, picker } = await buildBundles();
  console.log(`sumika-admin ${version}: ${[server, worker, picker].map(f => `${rel(f)} ${fs.statSync(f).size} bytes`).join(', ')}`);
  const deno = unpack(pins, pins.deno.cli, pins.deno.cli.member);
  const out = path.join(DIST, version);
  fs.mkdirSync(out, { recursive: true });
  const scratch = cleanScratch();
  const outputs = [];
  try {
    const entry = path.join(scratch, 'sumika-admin.mjs');
    const include = [worker, picker].map(f => path.join(scratch, path.basename(f)));
    fs.copyFileSync(server, entry);
    fs.copyFileSync(worker, include[0]);
    fs.copyFileSync(picker, include[1]);
    for (const t of o.targets) {
      const p = pins.deno.denort[t];
      const denort = unpack(pins, p, `denort-${t}${p.member.endsWith('.exe') ? '.exe' : ''}`);
      const output = path.join(out, TARGETS[t].output);
      const t0 = Date.now();
      const log = compile({ deno, denort, name: t, target: p.target, entry, include, output, denoDir: path.join(scratch, 'deno-dir') });
      const embedded = (/^Files: .*$/m.exec(log) || ['Files: ?'])[0];
      console.log(`${t}: compiled in ${Date.now() - t0} ms (denort ${p.memberSize} bytes; embedded ${embedded.slice(7)})`);
      outputs.push(output);
      if (TARGETS[t].zip) {
        const day = new Date();
        day.setHours(0, 0, 0, 0);
        const z = `${output}.zip`;
        fs.writeFileSync(z, zip([{ name: TARGETS[t].output, data: fs.readFileSync(output), mode: 0o755 }], { date: day }));
        outputs.push(z);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const sums = fs.readdirSync(out).filter(n => n !== 'SHA256SUMS.txt').sort()
    .map(n => `${sha256File(path.join(out, n))}  ${n}`);
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  const exe = path.join(out, TARGETS['windows-x64'].output);
  if (o.smoke && o.targets.includes('windows-x64') && process.platform === 'win32') await smoke(exe, { deno });
  else if (o.smoke) console.log('smoke: skipped (it runs the Windows program, on Windows)');
  for (const f of outputs) console.log(`${rel(f)}  ${fs.statSync(f).size} bytes  sha256 ${sha256File(f)}`);
}

// run as a script: import.meta.main, or on a Node without it the script Node was started with
if (import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(e => {
    console.error(e instanceof Stop ? `build stopped: ${e.message}` : e);
    process.exitCode = 1;
  });
}

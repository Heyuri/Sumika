#!/usr/bin/env node
// Parity of the admin core (admin/core/, through admin/cli.mjs's run()) with tools/index_site.py and tools/add_ghost.py
// (CLAUDE.md "The admin tool": both are kept, and a change is made in both). Each scenario runs the Python tool
// and the JS port on the same input, each into its own copy of a site, then compares the two sites file by file:
// every byte equal, except a pack (sumika/index/*.pack.gz), which must have the same name and the same content once
// gunzipped (Node's zlib deflates otherwise than Python's; the name is the SHA-1 of the content: index_site.py
// write_pack). Exit statuses must agree, and a refusal must list the same files. An archive is added the documented way
// on the Python side (admin/parity_extract.py, then add_ghost.py <that folder> --archive <it> --from-archive: the
// folder is that archive's extraction, so a Kawari ghost's save-header files are kept and recorded in
// sumika/kawari-shipped.json, compared byte for byte too) and straight from the archive on the JS side.
//
//   node admin/parity.mjs [--work DIR] [--ssp DIR] [--all-archives | --only REGEX] [--keep-work]   (npm run parity)
//
// --only REGEX: only the download folder's archives whose names match (none of the other scenarios).
//
// The full run: the fixture ghosts, a scratch copy of the real site (read only), ghosts of a local SSP install (--ssp)
// (tsubasa, emily4, bthver.5 with their update lists: read only, their personal files never opened: profile/ is never
// entered and the saves are left out by name before anything is read), archives of its download folder read in place
// (kuro, roommate, mayura_v350, bonsyou, BTHver.5, machi; with --all-archives every .nar / .zip there). Without --ssp
// the SSP install and its archives are skipped (one line says so); a removal takes the site's first ghost, or the
// fixtures' when the site has none. The npm test subset is tests/admin/parity.test.mjs. Python runs with -I -B
// (PYTHON names another interpreter).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run as cli } from './cli.mjs';
import { idProblem } from './core/api.mjs';
import { readShipped, setShipped } from './core/shipped.mjs';
import { KAWARI_RECORD } from './core/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const PY = process.env.PYTHON || 'python';
const INDEX_PY = path.join(ROOT, 'tools', 'index_site.py');
const ADD_PY = path.join(ROOT, 'tools', 'add_ghost.py');
const EXTRACT_PY = path.join(HERE, 'parity_extract.py');
const ARCHIVE = /\.(nar|zip)$/i;
/**
 * A scenario's work folder: 8 hex of its name's SHA-1, short because Python's tools fail on Windows paths over 260
 * characters (no long-path support: WinError 206 / 145), which Node's do not.
 */
export const slug = name => crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 8);

/**
 * python -I -B -X utf8 args: {status, stdout, stderr} (a missing interpreter throws: the parity needs Python). UTF-8
 * mode only for what the tools print: into a pipe Windows' Python writes the ANSI code page (cp1252 here) and fails
 * on a Japanese name, where in a console it writes Unicode; -I ignores PYTHONIOENCODING. The tools open every file in
 * binary, so nothing else changes.
 */
export function py(args) {
  const r = spawnSync(PY, ['-I', '-B', '-X', 'utf8', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`the parity runs Python (${PY}; set PYTHON to another): ${r.error.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** admin/cli.mjs in this process: {status, stdout, stderr}. */
export async function js(args) {
  const out = [], err = [];
  const status = await cli(args, { out: l => out.push(l), err: t => err.push(t) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** Every folder and file below root: Map(rel -> 'dir' | 'file'). */
export function listTree(root) {
  const out = new Map();
  const walk = rel => {
    for (const e of fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      out.set(p, e.isDirectory() ? 'dir' : 'file');
      if (e.isDirectory()) walk(p);
    }
  };
  if (fs.existsSync(root)) walk('');
  return out;
}

/**
 * Two sites compared: {same, files, packs, packsByteEqual, diffs: [{path, why}]}. A pack counts as the same when its
 * name (named by its content) and its gunzipped bytes are equal.
 */
export function compareTrees(a, b) {
  const A = listTree(a), B = listTree(b);
  const diffs = [];
  let files = 0, packs = 0, packsByteEqual = 0;
  for (const [p, kind] of A) {
    if (!B.has(p)) { diffs.push({ path: p, why: 'only in the Python run' }); continue; }
    if (B.get(p) !== kind) { diffs.push({ path: p, why: `a ${kind} in the Python run, a ${B.get(p)} in the JS run` }); continue; }
    if (kind === 'dir') continue;
    files++;
    const x = fs.readFileSync(path.join(a, p)), y = fs.readFileSync(path.join(b, p));
    if (p.endsWith('.pack.gz')) {
      packs++;
      if (x.equals(y)) { packsByteEqual++; continue; }
      let same = false;
      try { same = zlib.gunzipSync(x).equals(zlib.gunzipSync(y)); } catch (e) { same = false; }
      if (!same) diffs.push({ path: p, why: 'pack content differs' });
      continue;
    }
    if (!x.equals(y)) diffs.push({ path: p, why: 'bytes differ' });
  }
  for (const p of B.keys()) if (!A.has(p)) diffs.push({ path: p, why: 'only in the JS run' });
  return { same: diffs.length === 0, files, packs, packsByteEqual, diffs };
}

/** The lines of a refusal that name files ("  path", "  path (why)"), for comparing the two tools' refusals. */
export const listed = text => String(text || '').split(/\r?\n/).filter(l => /^ {2}\S/.test(l)).map(l => l.trim()).sort();

function copyTop(from, to, tops) {
  fs.mkdirSync(to, { recursive: true });
  for (const t of tops) {
    const s = path.join(from, ...t.split('/'));
    if (fs.existsSync(s)) fs.cpSync(s, path.join(to, ...t.split('/')), { recursive: true });
  }
}

/**
 * What a tool printed, comparable across the two runs: its own site folder as <site>, a pack's gzip size as # (Node's
 * zlib gives other sizes), an extracted archive's folder as the archive (the Python side's `src`), line ends as \n.
 */
function printed(text, site, swap = null) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim().split(site).join('<site>');
  if (swap) t = t.split(swap[0]).join(swap[1]);
  return t.replace(/KB -> \d+ KB gzip/g, 'KB -> # KB gzip');
}

function verdict(name, rp, rj, sites, extra = {}, swap = null) {
  const cmp = compareTrees(sites[0], sites[1]);
  const problems = [];
  if (rp.status !== rj.status) problems.push(`exit status: Python ${rp.status}, JS ${rj.status}`);
  const out = [printed(rp.stdout, sites[0], swap), printed(rj.stdout, sites[1])];
  const err = [printed(rp.stderr, sites[0], swap), printed(rj.stderr, sites[1])];
  if (out[0] !== out[1]) problems.push(`stdout differs:\n--- Python\n${out[0]}\n--- JS\n${out[1]}`);
  if (err[0] !== err[1]) problems.push(`stderr differs:\n--- Python\n${err[0]}\n--- JS\n${err[1]}`);
  for (const d of cmp.diffs.slice(0, 20)) problems.push(`${d.path}: ${d.why}`);
  if (cmp.diffs.length > 20) problems.push(`… ${cmp.diffs.length - 20} more`);
  return { name, ok: !problems.length, status: [rp.status, rj.status], files: cmp.files, packs: cmp.packs,
    packsByteEqual: cmp.packsByteEqual, problems, refusal: listed(rj.stderr), stderr: err[1], sites, ...extra };
}

/**
 * Index parity: copies of `from`'s ghost/, balloon/ (and sumika/index/ with `withIndex`, to check what each tool
 * keeps) indexed by each tool.
 */
export async function parityIndex(name, from, work, { withIndex = false } = {}) {
  const dir = path.join(work, slug(name));
  const sites = [path.join(dir, 'py'), path.join(dir, 'js')];
  for (const s of sites) copyTop(from, s, ['ghost', 'balloon', KAWARI_RECORD, ...(withIndex ? ['sumika/index'] : [])]);
  const rp = py([INDEX_PY, sites[0]]);
  const rj = await js(['index', sites[1]]);
  return verdict(name, rp, rj, sites);
}

/**
 * Add parity: `src` (a ghost folder, or a .nar / .zip) added to copies of `base` (a site folder, or null for an empty
 * one) by add_ghost.py and by the JS core; `times` runs each add again on the same site (a replace).
 */
export async function parityAdd(name, { src, id = null, archive = null, keep = [], skip = [], base = null, times = 1 }, work) {
  const dir = path.join(work, slug(name));
  const sites = [path.join(dir, 'py'), path.join(dir, 'js')];
  for (const s of sites) {
    if (base) copyTop(base, s, ['ghost', 'balloon', KAWARI_RECORD, 'sumika/index']);
    else fs.mkdirSync(s, { recursive: true });
  }
  let pySrc = src, pyArchive = archive, swap = null, fromArchive = [];
  const extra = {};
  if (ARCHIVE.test(src)) {
    const x = path.join(dir, 'extracted');
    const r = py([EXTRACT_PY, src, x]);
    if (r.status !== 0) return { name, ok: true, skipped: `parity_extract.py: ${r.stderr.trim() || r.status}` };
    extra.prefix = r.stdout.trim();
    pySrc = x;
    pyArchive = archive || src;
    swap = [path.resolve(x), path.resolve(src)];     // add_ghost.py names its source: the extraction folder
    fromArchive = ['--from-archive'];                // that folder is the archive's extraction: the core's archive source
  }
  const opt = (k, v) => (v ? [k, v] : []);
  const more = [...keep.flatMap(k => ['--keep', k]), ...skip.flatMap(k => ['--skip', k])];
  let rp, rj;
  for (let i = 0; i < times; i++) {
    rp = py([ADD_PY, pySrc, '--site', sites[0], ...opt('--id', id), ...opt('--archive', pyArchive), ...fromArchive, ...more]);
    rj = await js(['add', src, '--site', sites[1], ...opt('--id', id), ...opt('--archive', archive), ...more]);
  }
  return verdict(name, rp, rj, sites, extra, swap);
}

/**
 * Index parity on one site in place (a large one is not copied twice): index_site.py's sumika/index/ set aside, then
 * the JS core's, and the two folders compared.
 */
export async function parityIndexInPlace(name, site) {
  const idx = path.join(site, 'sumika', 'index');
  const keep = [path.join(site, 'index-py'), path.join(site, 'index-js')];
  for (const d of [idx, ...keep]) fs.rmSync(d, { recursive: true, force: true });      // sumika/kawari-shipped.json stays
  const rp = py([INDEX_PY, site]);
  if (fs.existsSync(idx)) fs.renameSync(idx, keep[0]);
  const rj = await js(['index', site]);
  if (fs.existsSync(idx)) fs.renameSync(idx, keep[1]);
  const r = verdict(name, rp, rj, keep);
  r.problems = r.problems.filter(p => !p.startsWith('stdout differs') && !p.startsWith('stderr differs'));
  const out = [printed(rp.stdout, site), printed(rj.stdout, site)], err = [printed(rp.stderr, site), printed(rj.stderr, site)];
  if (out[0] !== out[1]) r.problems.push(`stdout differs:\n--- Python\n${out[0]}\n--- JS\n${out[1]}`);
  if (err[0] !== err[1]) r.problems.push(`stderr differs:\n--- Python\n${err[0]}\n--- JS\n${err[1]}`);
  r.ok = !r.problems.length;
  return r;
}

/**
 * Remove parity: the ghost folder deleted, its entries of the site's record dropped (index_site.py set_kawari_record)
 * and index_site.py run, against the JS core's removeGhost.
 */
export async function parityRemove(name, base, id, work) {
  const dir = path.join(work, slug(name));
  const sites = [path.join(dir, 'py'), path.join(dir, 'js')];
  for (const s of sites) copyTop(base, s, ['ghost', 'balloon', KAWARI_RECORD, 'sumika/index']);
  fs.rmSync(path.join(sites[0], 'ghost', id), { recursive: true, force: true });
  if (fs.existsSync(path.join(sites[0], ...KAWARI_RECORD.split('/')))) {
    const r = py(['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import index_site; '
      + 'index_site.set_kawari_record(sys.argv[2], sys.argv[3], [])', path.dirname(INDEX_PY), sites[0], id]);
    if (r.status !== 0) throw new Error(`set_kawari_record: ${r.stderr}`);
  }
  const rp = py([INDEX_PY, sites[0]]);
  const rj = await js(['remove', id, '--site', sites[1]]);
  rj.stdout = rj.stdout.split('\n').filter(l => !l.startsWith('deleted ')).join('\n');      // the deletion's own line
  return verdict(name, rp, rj, sites);
}

/** A site holding the given ghost folders (copies) and the default balloon. */
export function makeSite(dir, ghosts) {
  fs.mkdirSync(path.join(dir, 'ghost'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'site', 'balloon', 'sumika'), path.join(dir, 'balloon', 'sumika'), { recursive: true });
  for (const [id, from] of Object.entries(ghosts)) fs.cpSync(from, path.join(dir, 'ghost', id), { recursive: true });
  return dir;
}

// ---- the full run ----------------------------------------------------------------------------------------------

async function main(argv) {
  const arg = k => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const work = path.resolve(arg('--work') || fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-parity-')));
  const ssp = arg('--ssp') ? path.resolve(arg('--ssp')) : null;      // no default: an SSP install is the user's own
  const downloads = ssp && path.join(ssp, 'ghost', 'ukagaka download');
  fs.mkdirSync(work, { recursive: true });
  const fixtures = path.join(ROOT, 'tests', 'fixtures', 'ghost');
  const results = [];
  const step = async p => {
    const t = Date.now();
    const r = await p;
    r.ms = Date.now() - t;
    results.push(r);
    console.log(`${r.skipped ? 'skip' : r.ok ? 'same' : 'DIFF'}  ${r.name}  (${r.skipped || `${r.files} files, ${r.packs} packs, exit ${r.status.join('/')}`}, ${r.ms} ms)`);
    for (const p2 of r.problems || []) console.log(`      ${p2}`);
    return r;
  };

  const only = arg('--only') ? new RegExp(arg('--only'), 'i') : null;      // archives of the download folder only
  if (!only) await defaults();
  async function defaults() {
  // the index: the fixtures, a copy of the real site, and again over its own sumika/index/ (old files kept)
  const fixSite = makeSite(path.join(work, 'base-fixtures'), Object.fromEntries(fs.readdirSync(fixtures).map(g => [g, path.join(fixtures, g)])));
  await step(parityIndex('index: fixtures', fixSite, work));
  await step(parityIndex('index: the site (copy)', path.join(ROOT, 'site'), work));
  await step(parityIndex('index: the site with its sumika/index', path.join(ROOT, 'site'), work, { withIndex: true }));

  // adds from folders: the fixtures, into a site with the default balloon
  const minimal = makeSite(path.join(work, 'base-min'), {});
  for (const g of fs.readdirSync(fixtures)) {
    const up = path.join(fixtures, g, 'updates2.dau');
    await step(parityAdd(`add: fixture ${g}`, { src: path.join(fixtures, g), base: minimal, archive: fs.existsSync(up) ? up : null }, work));
  }
  // the local SSP install (--ssp), read only (the CLAUDE.md flows)
  const inst = n => path.join(ssp, 'ghost', n);
  if (!ssp) console.log('skip  the SSP install (no --ssp DIR given)');
  else if (fs.existsSync(inst('tsubasa'))) {
    await step(parityAdd('add: SSP tsubasa', { src: inst('tsubasa'), base: minimal }, work));
    await step(parityAdd('add: SSP emily4 --archive updates2.dau (her balloon from SSP\'s balloon/)',
      { src: inst('emily4'), archive: path.join(inst('emily4'), 'updates2.dau'), base: minimal }, work));
    await step(parityAdd('add: SSP BTHver.5 --id bthver.5 --archive updates2.dau',
      { src: inst('BTHver.5'), id: 'bthver.5', archive: path.join(inst('BTHver.5'), 'updates2.dau'), base: minimal }, work));
    await step(parityAdd('add: SSP emily4 over the site copy (replace, the site\'s ghosts indexed)',
      { src: inst('emily4'), archive: path.join(inst('emily4'), 'updates2.dau'), base: path.join(ROOT, 'site') }, work));
  } else console.log(`skip  the SSP install (${ssp} not found)`);
  }
  const minimal = makeSite(path.join(work, 'base-min'), {});
  // archives, read in place
  const named = [['kuro.nar', 'like_a_cat'], ['roommate.nar', 'roommate'], ['mayura_v350.nar', 'mayura'],
    ['bonsyou.nar', 'bonsyou'], ['BTHver.5_2.732.nar', 'bthver.5'], ['machi_1.0.nar', 'machimaki']];
  const everything = !!downloads && (argv.includes('--all-archives') || !!only) && fs.existsSync(downloads);
  const ids = new Map(named);
  const all = !downloads ? []
    : everything ? fs.readdirSync(downloads).filter(n => ARCHIVE.test(n) && (!only || only.test(n))).sort()
      .map(n => [n, ids.get(n) || null])
    : named;
  if (!downloads) console.log('skip  the SSP install\'s archives (no --ssp DIR given)');
  const together = path.join(work, 'all-archives-site');
  const taken = new Set();
  for (const [n, given] of all) {
    const file = path.join(downloads, n);
    if (!fs.existsSync(file)) { console.log(`skip  ${n} (not found)`); continue; }
    // short ids for the whole folder (Windows' 260-character limit of the Python tools)
    let id = given || `x${String(taken.size).padStart(3, '0')}`;
    if (idProblem(id) || taken.has(id)) id = `x${results.length}`;
    taken.add(id);
    const r = await step(parityAdd(`add: ${n}`, { src: file, id, base: minimal }, work));
    const added = path.join(work, slug(r.name), 'js', 'ghost', id);
    if (everything && r.ok && !r.skipped && r.status[1] === 0 && fs.existsSync(added)) {
      fs.cpSync(added, path.join(together, 'ghost', id), { recursive: true });
      // with its entries of the site's record (a Kawari ghost's archive files), which the index reads
      const kept = readShipped(path.join(work, slug(r.name), 'js')).get(id);
      if (kept) setShipped(together, id, kept);
    }
    if (!argv.includes('--keep-work')) fs.rmSync(path.join(work, slug(r.name)), { recursive: true, force: true });
  }
  if (everything && fs.existsSync(together)) {
    fs.cpSync(path.join(ROOT, 'site', 'balloon', 'sumika'), path.join(together, 'balloon', 'sumika'), { recursive: true });
    await step(parityIndexInPlace(`index: every archive ghost added above, together (${fs.readdirSync(path.join(together, 'ghost')).length})`, together));
  }
  // remove: the site's first ghost (by folder id) from a copy of it, or the fixtures' first when the site has none
  if (!only) {
    const firstGhost = site => {
      const g = path.join(site, 'ghost');
      if (!fs.existsSync(g)) return undefined;
      return fs.readdirSync(g, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()[0];
    };
    const own = firstGhost(path.join(ROOT, 'site'));
    const [base, where] = own ? [path.join(ROOT, 'site'), 'the site'] : [path.join(work, 'base-fixtures'), 'the fixtures\' site'];
    const id = own || firstGhost(base);
    await step(parityRemove(`remove: ${id} from a copy of ${where}`, base, id, work));
  }

  const bad = results.filter(r => !r.ok);
  const skipped = results.filter(r => r.skipped);
  console.log(`\n${results.length} scenarios: ${results.length - bad.length - skipped.length} the same, ${bad.length} different, ${skipped.length} skipped`);
  const packs = results.reduce((n, r) => n + (r.packs || 0), 0), eq = results.reduce((n, r) => n + (r.packsByteEqual || 0), 0);
  console.log(`packs compared by content: ${packs} (${eq} byte-equal too); every other file byte for byte`);
  fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(results, null, 1));
  console.log(`report: ${path.join(work, 'report.json')}`);
  if (!argv.includes('--keep-work')) {
    for (const e of fs.readdirSync(work)) if (e !== 'report.json') fs.rmSync(path.join(work, e), { recursive: true, force: true });
  }
  return bad.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}

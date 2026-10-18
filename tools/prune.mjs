// Retention of the versioned site files (safe updates). Run just before each upload, and nothing else
// deletes: the build and the indexer never delete a versioned file, and no tool touches a file's mtime (nginx's
// and Apache's ETag and Last-Modified come from it, and a sync upload compares it).
// usage: node tools/prune.mjs [--site DIR] [--first | --retire-all]
//
// - Versioned: in sumika/engines/ the hashed runtime files (`<name>.<10 hex>.js|.wasm|.js.map|.sf3.gz`: the MIDI
//   player's bank too); in sumika/index/ every *.json but ghosts.json, and every *.pack.gz.
// - Current: what sumika/build.json names (the worker, the map its last line names, the engine pairs, the MIDI player
//   `midi` with its map and bank, the storage hub's script `hub` and the control page's script `control` with their
//   maps, when build.json has them) and what sumika/index/ghosts.json names (`manifests`, and each manifest's `pack`).
//   midi.LICENSES.txt is no versioned file; nor are the fixed sumika/hub.html and sumika/index.html (the control page)
//   and the publisher's sumika/hub.json (the allowlist), which prune never touches.
// - The ledger `<DIR>.published.json` sits beside the site folder, so it is never uploaded (the project's:
//   site.published.json): {"format": 1, "published": [the versioned paths current at the last run], "retired":
//   {path: "YYYY-MM-DD"}}.
// Rules, in order: (1) stop, deleting and writing nothing, unless every current file exists, sumika/sumika.js is the
// bundle build.json describes (its build id once, every path of its table: build.mjs writes sumika.js first) and, when
// build.json names a `hub` (a `control`), sumika/hub.html (sumika/index.html) names exactly that script (build.mjs
// writes both pages before sumika.js and build.json); (2) a
// versioned file that is not current: when `retired` has it, deleted once its date is 14 or more days ago, else kept;
// when the last upload carried it (`published`), retired today and kept; else (no upload ever carried it: a --watch
// intermediate, a build or re-index superseded before an upload) deleted now; (3) a `retired` entry whose file is gone,
// or is current again, is dropped;
// (4) `published` becomes the current set and the ledger is written (only when it changed; whole, through a temporary
// file renamed over it, so a cut-off run never leaves a torn one). With no ledger it
// refuses, unless --first (nothing was ever uploaded: every non-current versioned file is deleted) or --retire-all (the
// ledger was lost: every non-current versioned file is retired today, which only keeps files longer). A ledger that
// exists and does not read stops the run too (code `bad-ledger`): restore it, or delete it and run with --retire-all
// (the admin's Prepare upload renames it aside instead: its "Start a new record").
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mapName } from './hashname.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Days a file the last upload carried stays on the host after the upload that no longer needs it. */
export const RETAIN_DAYS = 14;

/** A hashed runtime file in sumika/engines/ (worker and engine copies, the MIDI player and its bank, the hub script, their maps). */
export const ENGINE_FILE = /^[a-z0-9_]+\.[0-9a-f]{10}\.(js|wasm|js\.map|sf3\.gz)$/;

/** The ledger's path for a site folder: `<DIR>.published.json`, beside it. */
export function ledgerPath(site) {
  return path.resolve(site) + '.published.json';
}

/** A Date's local calendar day, YYYY-MM-DD. */
export function localDay(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whole days from day a to day b (YYYY-MM-DD), or NaN when either is no day. */
function daysBetween(a, b) {
  const t = s => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN);
  return Math.round((t(b) - t(a)) / 86400000);
}

/**
 * A refusal; `code` names the ones a caller words in its own way (the admin's Check: `no-manifests`; its Prepare
 * upload: `bad-ledger`, a ledger that exists and does not read).
 */
class Refused extends Error {
  constructor(message, code = undefined) {
    super(message);
    if (code) this.code = code;
  }
}

function readJson(file, what, hint, code = undefined) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Refused(`${what} is missing (${file}): ${hint}`, code);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));          // an editor's BOM, as the admin's settings take it
  } catch (e) {
    throw new Refused(`${what} is no JSON (${file}): ${hint}`, code);
  }
}

/** A site-relative path from a table path; null when it leaves the site or is empty. */
function sitePath(p, prefix = '') {
  if (typeof p !== 'string' || !p) return null;
  const n = path.posix.normalize(prefix + p.replace(/\\/g, '/'));
  return n.startsWith('../') || n === '..' || n.startsWith('/') || /^[a-z]:/i.test(n) ? null : n;
}

/**
 * The one script a fixed-name page loads (sumika/hub.html, sumika/index.html: its `src`, relative to sumika/), or null
 * when it names none or several.
 */
export function pageScript(html) {
  const srcs = [...String(html).matchAll(/<script\b[^>]*\bsrc="([^"]*)"/gi)].map(m => m[1]);
  return srcs.length === 1 ? srcs[0] : null;
}

/** The one script sumika/hub.html loads (pageScript). */
export const hubScript = pageScript;

/**
 * The current files: every path build.json and ghosts.json name (site-relative, `/`), each of which must exist (the
 * worker's or the MIDI player's map counts only when its bundle's last line names it: a --minify build has none), and
 * what is wrong (also a sumika.js that is not the bundle build.json describes).
 * @returns {{current: Set<string>, problems: string[]}}
 */
export function currentFiles(site) {
  const sumika = path.join(site, 'sumika');
  const build = readJson(path.join(sumika, 'build.json'), 'sumika/build.json', 'run npm run build');
  const index = readJson(path.join(sumika, 'index', 'ghosts.json'), 'sumika/index/ghosts.json', 'run python -I tools/index_site.py');
  const current = new Set();
  const problems = [];
  const need = (p, what) => {
    if (!p) { problems.push(`${what}: no usable path`); return null; }
    current.add(p);
    if (!fs.existsSync(path.join(site, p))) problems.push(`${p} (${what}) is missing`);
    return p;
  };
  // build.json: paths relative to sumika/ (runtimeUrl)
  /** A bundle and the map its last line names (none under --minify). */
  const bundleAndMap = (rel, what) => {
    const p = need(sitePath(rel, 'sumika/'), what);
    if (p && fs.existsSync(path.join(site, p))) {
      const map = mapName(fs.readFileSync(path.join(site, p)));
      if (map) need(sitePath(map, path.posix.dirname(p) + '/'), `the map ${p} names`);
    }
  };
  bundleAndMap(build && build.worker, 'build.json worker');
  const engines = build && build.engines && typeof build.engines === 'object' ? build.engines : null;
  if (!engines) problems.push('build.json names no engines');
  const table = [build && build.worker];
  for (const [e, pair] of Object.entries(engines || {})) {
    need(sitePath(pair && pair.js, 'sumika/'), `build.json ${e}.js`);
    need(sitePath(pair && pair.wasm, 'sumika/'), `build.json ${e}.wasm`);
    table.push(pair && pair.js, pair && pair.wasm);
  }
  // the MIDI player: an older build.json without `midi` is fine
  const midi = build && build.midi;
  if (midi != null) {
    if (typeof midi !== 'object') problems.push('build.json midi is no object');
    else {
      bundleAndMap(midi.js, 'build.json midi.js');
      need(sitePath(midi.bank, 'sumika/'), 'build.json midi bank');
      table.push(midi.js, midi.bank);
    }
  }
  // the storage hub: build.json's `hub` and its map are current, and the fixed sumika/hub.html must
  // name exactly that script; an older build.json without `hub` is fine, and sumika.js's table never names it
  const hub = build && build.hub;
  if (hub != null) {
    if (typeof hub !== 'string') problems.push('build.json hub is no path');
    else {
      bundleAndMap(hub, 'build.json hub');
      let html = null;
      try { html = fs.readFileSync(path.join(sumika, 'hub.html'), 'utf8'); } catch (e) { problems.push('sumika/hub.html is missing: run npm run build'); }
      if (html != null && pageScript(html) !== hub) problems.push(`sumika/hub.html does not name build.json's hub ${hub}: run npm run build`);
    }
  }
  // the control page (build.mjs step 4d) likewise: build.json's `control` and its map, and the fixed sumika/index.html
  // naming exactly that script; an older build.json without `control` is fine. The missing line reads as the others'
  // (`<path> (<what>) is missing`), which the admin's Check words as a missing file
  const control = build && build.control;
  if (control != null) {
    if (typeof control !== 'string') problems.push('build.json control is no path');
    else {
      bundleAndMap(control, 'build.json control');
      let html = null;
      try { html = fs.readFileSync(path.join(sumika, 'index.html'), 'utf8'); } catch (e) { problems.push('sumika/index.html (the control page) is missing'); }
      if (html != null && pageScript(html) !== control) problems.push(`sumika/index.html does not name build.json's control ${control}: run npm run build`);
    }
  }
  // the bundle that goes up must be the one build.json describes: build.mjs writes sumika.js before build.json, so a
  // build that died between the two leaves a bundle naming files build.json does not (tests/build_output.test.mjs)
  let page = null;
  try { page = fs.readFileSync(path.join(sumika, 'sumika.js'), 'utf8'); } catch (e) { problems.push('sumika/sumika.js is missing'); }
  if (page != null) {
    const id = build && typeof build.build === 'string' ? build.build : '';
    const n = id ? page.split(id).length - 1 : 0;
    if (n !== 1) problems.push(`sumika/sumika.js holds build.json's build ${JSON.stringify(id)} ${n} times, not once`);
    for (const p of table) if (typeof p === 'string' && p && !page.includes(p)) problems.push(`sumika/sumika.js does not name ${p}`);
  }
  // ghosts.json: site-relative paths
  const manifests = index && index.manifests && typeof index.manifests === 'object' ? index.manifests : null;
  if (!manifests) {
    throw new Refused(`sumika/index/ghosts.json names no hashed manifests (format ${index && index.format}): run python -I tools/index_site.py`, 'no-manifests');
  }
  for (const kind of ['ghost', 'balloon']) {
    for (const [id, p] of Object.entries(manifests[kind] || {})) {
      const m = need(sitePath(p), `${kind} ${id}'s manifest`);
      if (!m || !fs.existsSync(path.join(site, m))) continue;
      let man;
      try {
        man = JSON.parse(fs.readFileSync(path.join(site, m), 'utf8'));
      } catch (e) {
        problems.push(`${m} is no JSON`);
        continue;
      }
      if (man && man.pack != null) need(sitePath(man.pack), `${kind} ${id}'s pack`);
    }
  }
  return { current, problems };
}

/** Every versioned file on disk, site-relative. */
export function versionedFiles(site) {
  const out = [];
  const list = (rel, keep) => {
    let ents;
    try {
      ents = fs.readdirSync(path.join(site, rel), { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const d of ents) if (d.isFile() && keep(d.name)) out.push(`${rel}/${d.name}`);
  };
  list('sumika/engines', n => ENGINE_FILE.test(n));
  list('sumika/index', n => (n.endsWith('.json') && n !== 'ghosts.json') || n.endsWith('.pack.gz'));
  return out.sort();
}

/**
 * The ledger: null when there is none; one that exists and does not read (no JSON, not a format 1 ledger, or it
 * cannot be opened) is a refusal with the code `bad-ledger` (the admin's Prepare upload offers a new record for it).
 * @returns {null | {published: Set<string>, retired: object}}
 */
export function readLedger(file) {
  if (!fs.existsSync(file)) return null;
  const l = readJson(file, 'the ledger', 'restore it, or delete it and run with --retire-all', 'bad-ledger');
  if (!l || l.format !== 1 || !Array.isArray(l.published) || !l.retired || typeof l.retired !== 'object' || Array.isArray(l.retired)) {
    throw new Refused(`the ledger ${file} is not a format 1 ledger: restore it, or delete it and run with --retire-all`, 'bad-ledger');
  }
  return { published: new Set(l.published.filter(p => typeof p === 'string')), retired: { ...l.retired } };
}

/**
 * Writes the ledger whole or not at all: a temporary file beside it, then a rename over it (as the admin's
 * writeAtomic), so a run cut off mid-write (a closed window) leaves the last ledger, never a torn one that the next run
 * refuses as "not a format 1 ledger".
 */
function writeLedger(file, text) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* gone */ }
    throw e;
  }
}

function ledgerText(published, retired) {
  const r = {};
  for (const k of Object.keys(retired).sort()) r[k] = retired[k];
  return JSON.stringify({ format: 1, published: [...published].sort(), retired: r }, null, 1) + '\n';
}

/**
 * Prune a site folder.
 * @param {{site?: string, first?: boolean, retireAll?: boolean, now?: number|Date, log?: (line: string) => void}} [o]
 * @returns {{deleted: string[], retired: string[], kept: string[], ledger: string, wrote: boolean}}
 * @throws {Error} with `refused: true` when it stops (nothing deleted or written)
 */
export function prune({ site = path.join(root, 'site'), first = false, retireAll = false, now = Date.now(), log = () => {} } = {}) {
  try {
    if (first && retireAll) throw new Refused('--first and --retire-all exclude each other');
    site = path.resolve(site);
    const file = ledgerPath(site);
    const ledger = readLedger(file);
    if (ledger && (first || retireAll)) {
      throw new Refused(`a ledger exists (${file}): --first and --retire-all are for a site without one`);
    }
    if (!ledger && !first && !retireAll) {
      throw new Refused(`no ledger (${file}): run with --first before the first upload, or --retire-all when the ledger was lost`);
    }
    const { current, problems } = currentFiles(site);
    if (problems.length) {
      throw new Refused(`stopped, nothing deleted: ${problems.join('; ')} (run npm run build and python -I tools/index_site.py)`);
    }
    const today = localDay(new Date(now));
    const published = ledger ? ledger.published : new Set();
    const retired = ledger ? ledger.retired : {};
    const deleted = [], newlyRetired = [], kept = [];
    const remove = p => {
      fs.unlinkSync(path.join(site, p));
      deleted.push(p);
      delete retired[p];
    };
    for (const p of versionedFiles(site)) {
      if (current.has(p)) continue;
      if (first) remove(p);
      else if (retireAll) { retired[p] = today; newlyRetired.push(p); }
      else if (Object.prototype.hasOwnProperty.call(retired, p)) {
        const age = daysBetween(retired[p], today);
        if (age >= RETAIN_DAYS) remove(p);
        else {
          if (Number.isNaN(age)) retired[p] = today; // an unreadable date: start again, which only keeps it longer
          kept.push(p);
        }
      } else if (published.has(p)) { retired[p] = today; newlyRetired.push(p); }
      else remove(p);
    }
    for (const p of Object.keys(retired)) {
      if (current.has(p) || !fs.existsSync(path.join(site, p))) delete retired[p];
    }
    const text = ledgerText(current, retired);
    let old = null;
    try { old = fs.readFileSync(file, 'utf8'); } catch (e) { /* none yet */ }
    const wrote = old !== text;
    if (wrote) writeLedger(file, text);
    for (const p of deleted) log(`deleted ${p}`);
    for (const p of newlyRetired) log(`retired ${p} (kept until ${RETAIN_DAYS} days after ${today})`);
    log(`prune: ${current.size} current, ${deleted.length} deleted, ${newlyRetired.length} retired today, ${kept.length} kept while retired; ledger ${file}${wrote ? '' : ' (unchanged)'}`);
    return { deleted, retired: newlyRetired, kept, ledger: file, wrote };
  } catch (e) {
    if (e instanceof Refused) e.refused = true;
    throw e;
  }
}

function main(argv) {
  const o = { log: line => console.log(line) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site' && i + 1 < argv.length) o.site = path.resolve(argv[++i]);
    else if (a === '--first') o.first = true;
    else if (a === '--retire-all') o.retireAll = true;
    else {
      console.error(`prune: unknown argument ${a}\nusage: node tools/prune.mjs [--site DIR] [--first | --retire-all]`);
      return 2;
    }
  }
  try {
    prune(o);
    return 0;
  } catch (e) {
    console.error(`prune: ${e.refused ? '' : 'failed: '}${e.message}`);
    return 1;
  }
}

// run as a script: import.meta.main, or on a Node without it (undefined there) the script Node was started with
if (import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}

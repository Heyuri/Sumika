// Adding and removing ghosts, as tools/add_ghost.py does it (CLAUDE.md "The admin tool"; the parity tests compare the
// two): the same files left out (profile/ never entered, the engines' saves and logs, DLLs and EXEs, PERSONAL_PATHS,
// and what the admin leaves out: --skip / leaveOut, which can only remove a file), the same checks in the same order
// (the archive comparison, install.txt's refreshundeletemask, Kawari's save header, the balloon SSP moved to its own
// balloon/ folder, bundled balloons a re-copy would lose), the same copy (every folder, data only), then the index.
// On top, for the admin program: a source may be a .nar / .zip (extracted into a new temporary folder first:
// archive.mjs; then exactly the folder path, with the archive as --archive), inspectSource lists what an add would do
// without doing it, a site id must be one writable folder name, a site folder of that id is replaced only when asked
// (and removed without following a link), removeGhost deletes a site ghost and re-indexes, ghost/ changes only by
// renames of complete copies (staging.mjs: crash-safe, where add_ghost.py copies in place), and every finding is a
// code (codes.mjs) with its English text. A Kawari ghost's save-header files are refused from a folder and kept from
// an archive source, recorded in the site's sumika/kawari-shipped.json (shipped.mjs; add_ghost.py --from-archive does
// the same on an extraction) [decision]. Nothing returned holds a file's contents but a readme's or terms
// file's (only one that would be copied: never a personal file). The core prints nothing: `log` gets add_ghost.py's
// lines, `onProgress` the steps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normPath } from '../../src/core/loader.js';
import { engineSupported, engineNeeds } from '../../src/worker/engines/supported.js';
import { findReadme, findTerms, readmeText } from '../../src/ui/info.js';
import { pyStrip, pySplitlines, fnmatchcase, pyRepr } from './py.mjs';
import { readDescript, readTextFile } from './text.mjs';
import { sourceFiles, copyTree, removeTree, isFile, isDir, isLink, listdir } from './tree.mjs';
import { ALWAYS_LISTED, KAWARI_ENGINES } from './rules.mjs';
import { archiveIndex, matches, extractGhost, badSegment } from './archive.mjs';
import { folderEngine, kawariSaved, kawariUnlisted, bundledBalloons, indexSite, personalFiles, personalRefusal } from './index.mjs';
import { readShipped, setShipped, shippedUnion } from './shipped.mjs';
import { AdminRefusal, refusalOf } from './refusal.mjs';
import { finding, message } from './codes.mjs';
import { progress } from './progress.mjs';
import { workEntry, dropWorkDir, moveRetry, removeRetry } from './staging.mjs';

const ARCHIVE = /\.(nar|zip)$/i;
const errText = e => String((e && (e.code || e.message)) || e);
const rel = (root, p) => path.join(root, ...p.split('/'));
const lowSet = list => new Set((list || []).map(k => String(k).replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '')));

// ---- add_ghost.py's checks -------------------------------------------------------------------------------------

/**
 * add_ghost.py unlisted: [{path, code}] of the files the archive does not list ('compare.notListed') or holds with
 * other bytes ('compare.differs'), that --keep does not name; install.txt and updates*.dau / updates*.txt always count
 * as listed. tick(done, total, rel): progress per file.
 */
export function unlisted(src, files, archive, keep = [], tick = () => {}) {
  const index = archiveIndex(archive);
  const kept = lowSet(keep);
  const out = [];
  files.forEach((p, i) => {
    tick(i, files.length, p);
    if (kept.has(p.toLowerCase()) || ALWAYS_LISTED.test(p)) return;
    const listed = index.get(p.toLowerCase());
    if (!listed || !listed.length) {
      out.push({ path: p, code: 'compare.notListed' });
      return;
    }
    const data = fs.readFileSync(rel(src, p));
    if (!listed.some(e => matches(data, e))) out.push({ path: p, code: 'compare.differs' });
  });
  tick(files.length, files.length, null);
  return out;
}

/**
 * add_ghost.py undelete_mask: {names, hits}: install.txt's refreshundeletemask names (every such line; `:`, `;` or `,`
 * between them) and the files to copy they name, relative to the ghost root or to ghost/master.
 */
export function undeleteMask(src, files) {
  const file = path.join(src, 'install.txt');
  const names = [];
  if (isFile(file)) {
    for (const line of pySplitlines(readTextFile(file))) {
      const i = line.indexOf(',');
      if (i < 0 || pyStrip(line.slice(0, i)).toLowerCase() !== 'refreshundeletemask') continue;
      for (const n of line.slice(i + 1).split(/[:;,]/)) {
        if (pyStrip(n)) names.push(pyStrip(n).replace(/\\/g, '/').replace(/^\/+/, ''));
      }
    }
  }
  const pats = names.flatMap(n => [n.toLowerCase(), `ghost/master/${n.toLowerCase()}`]);
  return { names, hits: files.filter(p => pats.some(q => fnmatchcase(p.toLowerCase(), q))) };
}

/**
 * add_ghost.py kawari_refused: [{path, code, line?}] of the files a Kawari ghost's index would refuse for their save
 * header: 'kawari.shippedDefault' with the KAWARI_SHIPPED_SAVES line to add when the archive holds it as it is, else
 * 'kawari.runSave' (a save of SSP's run). Paths and CRC-32s only.
 */
export function kawariRefused(src, files, archive) {
  const index = archive ? archiveIndex(archive) : new Map();
  return kawariUnlisted(src, files).map(([p, crc]) => {
    const data = fs.readFileSync(rel(src, p));
    const shipped = (index.get(p.toLowerCase()) || []).some(e => matches(data, e));
    return shipped
      ? { path: p, code: 'kawari.shippedDefault', line: `(${pyRepr(p)}, 0x${crc.toString(16).padStart(8, '0')}),    # ${path.basename(archive)}` }
      : { path: p, code: 'kawari.runSave' };
  });
}

/**
 * add_ghost.py ssp_balloon: {dir, folder} of the balloon install.txt names (balloon.directory) when the ghost folder
 * lacks it and SSP's shared balloon/ folder has it (<SSP>/ghost/<name> -> <SSP>/balloon/<directory>), else null.
 */
export function sspBalloon(src) {
  const want = pyStrip(readDescript(path.join(src, 'install.txt')).get('balloon.directory') ?? '');
  if (!want || want.includes('/') || want.includes('\\') || want === '.' || want === '..') return null;
  if (listdir(src).some(d => d.toLowerCase() === want.toLowerCase() && isDir(path.join(src, d)))) return null;
  const parent = path.dirname(src);
  const folder = path.join(path.dirname(parent), 'balloon', want);
  if (path.basename(parent).toLowerCase() !== 'ghost' || !isFile(path.join(folder, 'descript.txt'))) return null;
  return { dir: want, folder };
}

/** add_ghost.py lost_balloons: bundled balloons of the site folder dst that a re-copy from src would delete for good. */
export function lostBalloons(src, dst, balloon) {
  if (!isDir(dst)) return [];
  const have = new Set(listdir(src).filter(d => isDir(path.join(src, d))).map(d => d.toLowerCase()));
  if (balloon) have.add(balloon.dir.toLowerCase());
  return bundledBalloons(dst).filter(b => !have.has(b.dir.toLowerCase()));
}

/** Why a site id cannot be used, as a name.* code (one folder name Windows writes as it is), or null. */
export function idProblem(id) {
  if (typeof id !== 'string' || !id) return 'name.empty';
  if (id.includes('/') || id.includes('\\')) return 'name.separator';
  return badSegment(id);
}

// ---- the readme's terms, for the admin's view ------------------------------------------------------------------

const TERMS_WORDS = new RegExp(['転載', '再配布', '配布', '改変', '二次創作', '利用規約', '規約', '著作権', 'ライセンス',
  '禁止', '無断', '許可', '商用', 'licen[cs]e', 'redistribut', 'distribut', 'copyright', 'terms', 'permission',
  'commercial', 'CC[- ]?BY', 'NYSL', 'MIT', 'GPL'].join('|'), 'i');
const EXCERPT_LINES = 40;
const EXCERPT_CHARS = 4000;

/** The lines of a readme that speak of terms (each with a line before and two after), else its head; capped. */
export function termsExcerpt(text) {
  const lines = String(text).split('\n');
  const keep = new Set();
  lines.forEach((l, i) => {
    if (TERMS_WORDS.test(l)) for (let k = i - 1; k <= i + 2; k++) if (k >= 0 && k < lines.length) keep.add(k);
  });
  const picked = [...keep].sort((a, b) => a - b);
  let out = [];
  if (picked.length) {
    let prev = -2;
    for (const i of picked) {
      if (out.length && i > prev + 1) out.push('...');
      out.push(lines[i]);
      prev = i;
    }
  } else out = lines.slice(0, 15);
  let truncated = out.length > EXCERPT_LINES || (!picked.length && lines.length > 15);
  let s = out.slice(0, EXCERPT_LINES).join('\n');
  if (s.length > EXCERPT_CHARS) {
    s = s.slice(0, EXCERPT_CHARS);
    truncated = true;
  }
  return { excerpt: s.replace(/\s+$/, ''), truncated };
}

/**
 * The ghost's terms as SSP shows them (Information ▸: src/ui/info.js): its terms file (terms.md / .txt / .rtf …), else
 * its readme's lines about terms. Only a file that would be copied is read.
 */
async function termsOf(root, descript, copied) {
  const byLower = new Map(copied.map(p => [p.toLowerCase(), p]));
  const files = {
    resolve: p => byLower.get(normPath(p).toLowerCase()) ?? null,
    has: p => byLower.has(normPath(p).toLowerCase()),
    bytes: async p => fs.readFileSync(rel(root, p)),
  };
  const terms = findTerms(files);
  if (terms) {
    const text = await readmeText(files, terms, descript);
    return { file: terms, kind: 'terms', excerpt: text.slice(0, EXCERPT_CHARS).replace(/\s+$/, ''), truncated: text.length > EXCERPT_CHARS };
  }
  const readme = findReadme(files, descript, { ghost: true });
  if (!readme) return null;
  return { file: readme, kind: 'readme', ...termsExcerpt(await readmeText(files, readme, descript)) };
}

// ---- one ghost -------------------------------------------------------------------------------------------------

const blank = (source, id, archive) => ({
  source, id, name: null, engine: null, runs: null, sizeBytes: 0, fileCount: 0, excluded: [], refusal: null, notes: [],
  terms: null, balloons: [], conflict: null, archive: archive || null, updateList: null,
});

/**
 * add_ghost.py main up to the copy, in its order. mode 'add': logs what it prints and throws the first refusal;
 * mode 'inspect': records the first refusal and goes on, to describe everything. `shipped` (returned): the Kawari
 * save-header files an archive source keeps, [[path, CRC-32]], for the site's record.
 */
async function prepare(root, { mode, id, site, archive, keep, leaveOut, label, log, source, tick }) {
  const item = blank(source, id, archive);
  const note = (code, params) => {
    if (item.refusal) return;
    const f = finding(code, params);
    item.notes.push(f);
    if (mode === 'add') log(f.message);
  };
  const stop = e => {
    if (mode === 'add') throw e;
    if (!item.refusal) item.refusal = refusalOf(e);
  };
  if (!isFile(path.join(root, 'ghost', 'master', 'descript.txt'))) {
    stop(new AdminRefusal('source.notGhost', { label }));
    return { item };
  }
  // the site's Kawari record (shipped.mjs): every add sets its ghost's entries, so one that does not read stops the
  // add before anything is written ('kawari.record'), where add_ghost.py reads it too [decision]
  if (site) {
    try {
      readShipped(site);
    } catch (e) {
      stop(e);
    }
  }
  const bad = idProblem(id);
  if (bad) stop(new AdminRefusal('id.bad', { id, problem: bad }));
  const d = readDescript(path.join(root, 'ghost', 'master', 'descript.txt'));
  item.name = d.has('name') ? d.get('name') : id;
  const src = sourceFiles(root);
  const { folders, excluded, sizes } = src;
  // --skip / leaveOut: only ever a file the rules above would copy
  const skip = lowSet(leaveOut);
  const leftOut = src.files.filter(p => skip.has(p.toLowerCase()));
  const files = src.files.filter(p => !skip.has(p.toLowerCase()));
  for (const p of leftOut) {
    sizes.delete(p);
    excluded.push({ path: p, code: 'admin.leaveOut', why: message('admin.leaveOut') });
  }
  item.excluded = excluded;
  if (leftOut.length) note('note.leftOut', { paths: leftOut });
  // what later steps may open: add_ghost.py stops at a refusal and reads nothing more, so an inspection that goes on
  // never opens a file the archive comparison flagged (an SSP run may have written it)
  let readable = files;
  if (archive) {
    let extra = [];
    try {
      extra = unlisted(root, files, archive, keep, (n, t, p) => tick('compare', n, t, p));
    } catch (e) {
      stop(new AdminRefusal('compare.unreadable', { archive, error: e.message }));
    }
    if (extra.length) {
      stop(new AdminRefusal('compare.unlisted', { label, archive }, extra));
      const flagged = new Set(extra.map(x => x.path));
      readable = files.filter(p => !flagged.has(p));
    } else note('note.compared', { count: files.length, archiveName: path.basename(archive), kept: keep.length });
  }
  const { names, hits } = undeleteMask(root, files);
  if (names.length) note('note.undeleteMask', { names, hits });
  const engine = await folderEngine(root, readable);
  item.engine = engine.engine;
  if (engine.module !== undefined) item.module = engine.module;
  const needs = engineNeeds({ engine: engine.engine, shiori: d.get('shiori') });
  item.runs = needs ? { ok: false, code: 'engine.needs', params: { engine: needs }, note: message('engine.needs', { engine: needs }) }
    : { ok: engineSupported(engine.engine), code: null, params: null, note: null };
  let shipped = [];
  if (KAWARI_ENGINES.includes(engine.engine)) {
    if (source.kind === 'archive') {
      // from the ghost's own .nar / .zip they are the author's starting files [decision]:
      // every one the extraction wrote is a member as the archive holds it (its size
      // and CRC-32 checked), = add_ghost.py --from-archive on that extraction
      shipped = kawariUnlisted(root, readable);
      if (shipped.length) note('note.kawariKept', { paths: shipped.map(([p]) => p) });
    } else {
      const refused = kawariRefused(root, readable, archive);
      if (refused.length) {
        stop(new AdminRefusal('kawari.saveHeader',
          { label, archive: archive || null, archiveName: archive ? path.basename(archive) : null }, refused));
      }
    }
  } else if (!item.refusal) {
    for (const [p] of kawariSaved(root, readable)) note('note.kawariHeader', { path: p });
  }
  const balloon = sspBalloon(root);
  item.balloons = bundledBalloons(root).map(b => ({ dir: b.dir, name: b.name, from: 'ghost' }));
  let bplan = null;
  if (balloon) {
    bplan = { ...balloon, ...sourceFiles(balloon.folder) };
    const bdesc = readDescript(path.join(balloon.folder, 'descript.txt'));
    item.balloons.push({ dir: balloon.dir, name: bdesc.has('name') ? bdesc.get('name') : balloon.dir, from: 'ssp', path: balloon.folder });
    item.excluded.push(...bplan.excluded.map(x => ({ ...x, path: `${balloon.dir}/${x.path}` })));
  }
  if (site && !bad) {
    const dst = path.join(path.resolve(site), 'ghost', id);
    if (isDir(dst) || isLink(dst)) {
      const lost = lostBalloons(root, dst, balloon);
      item.conflict = { path: dst, lostBalloons: lost.map(b => ({ dir: b.dir, name: b.name })) };
      if (lost.length) {
        stop(new AdminRefusal('balloon.wouldLose', { dst, label },
          lost.map(b => ({ path: `${b.dir}/`, code: 'balloon.lost', params: { name: b.name } }))));
      }
    }
  }
  let bytes = 0;
  for (const n of sizes.values()) bytes += n;
  if (bplan) for (const n of bplan.sizes.values()) bytes += n;
  item.fileCount = files.length + (bplan ? bplan.files.length : 0);
  item.sizeBytes = bytes;
  item.updateList = files.find(p => /^updates2\.dau$/i.test(p)) || files.find(p => /^updates\.txt$/i.test(p)) || null;
  if (mode === 'inspect') {
    try {
      item.terms = await termsOf(root, d, readable);
    } catch (e) {
      item.terms = null;
    }
  }
  return { item, folders, files, balloon: bplan, shipped };
}

/** The site id an admin is offered: install.txt's `directory` for an archive, else the folder's name; lower-cased. */
export function proposeId(root, { archive = null } = {}) {
  if (archive) {
    const dir = pyStrip(readDescript(path.join(root, 'install.txt')).get('directory') ?? '');
    if (dir && !idProblem(dir)) return dir.toLowerCase();
    return path.basename(archive).replace(/\.[^.]*$/, '').toLowerCase();
  }
  return path.basename(root).toLowerCase();
}

async function withArchive(file, { tempDir, tick }, fn) {
  const tmp = fs.mkdtempSync(path.join(tempDir || os.tmpdir(), 'sumika-admin-'));
  try {
    const x = extractGhost(file, tmp, (n, t, p) => tick('extract', n, t, p));
    return await fn(tmp, x);
  } finally {
    removeTree(tmp);
  }
}

// ---- the API ---------------------------------------------------------------------------------------------------

/**
 * What adding each ghost of a source would do, nothing done: a ghost folder, a folder of ghosts (an SSP ghost/ folder:
 * every sub-folder with ghost/master/descript.txt, and every .nar / .zip in it), or a .nar / .zip.
 * @param {string} source
 * @param {{site?: string, id?: string, archive?: string, keep?: string[], leaveOut?: string[], tempDir?: string,
 *   onProgress?: (p: {phase, done, total, item}) => void}} [o] id, archive, keep and leaveOut apply to a single ghost
 *   (a ghost folder or an archive); onProgress phases 'inspect' (each source of a folder), 'extract', 'compare'
 * @returns {Promise<object[]>} one item per ghost: {source: {kind: 'folder'|'archive', path, root?}, id, name, engine,
 *   module?, runs: {ok, code, params, note}, sizeBytes, fileCount, excluded: [{path, code, params?, why}], refusal:
 *   null | {code, params, message, files: [{path, code, params?, line?, why}]}, notes: [{code, params, message}],
 *   terms: null | {file, kind: 'terms'|'readme', excerpt, truncated}, balloons: [{dir, name, from: 'ghost'|'ssp',
 *   path?}], conflict: null | {path, lostBalloons: [{dir, name}]}, archive, updateList}
 */
export async function inspectSource(source, { site = null, id = null, archive = null, keep = [], leaveOut = [],
  tempDir = null, onProgress = null } = {}) {
  const tick = progress(onProgress);
  const abs = path.resolve(source);
  const one = async (p, single) => {
    const opts = single ? { id, archive, keep, leaveOut } : { id: null, archive: null, keep: [], leaveOut: [] };
    if (isFile(p)) return inspectArchive(p, { ...opts, site, tempDir, tick });
    const sid = opts.id || proposeId(p);
    return (await prepare(p, { mode: 'inspect', id: sid, site, archive: opts.archive, keep: opts.keep,
      leaveOut: opts.leaveOut, label: p, source: { kind: 'folder', path: p }, tick })).item;
  };
  if (isFile(abs)) {
    if (!ARCHIVE.test(abs)) throw new AdminRefusal('source.notSource', { path: abs });
    return [await one(abs, true)];
  }
  if (!isDir(abs)) throw new AdminRefusal('source.missing', { path: abs });
  if (isFile(path.join(abs, 'ghost', 'master', 'descript.txt'))) return [await one(abs, true)];
  const found = listdir(abs).map(name => path.join(abs, name)).filter(p =>
    (isDir(p) && !isLink(p) && isFile(path.join(p, 'ghost', 'master', 'descript.txt'))) || (ARCHIVE.test(p) && isFile(p)));
  const out = [];
  for (const [i, p] of found.entries()) {
    tick('inspect', i, found.length, p);
    out.push(await one(p, false));
  }
  tick('inspect', found.length, found.length, null);
  return out;
}

async function inspectArchive(file, { id, archive, keep, leaveOut, site, tempDir, tick }) {
  const source = { kind: 'archive', path: file };
  try {
    return await withArchive(file, { tempDir, tick }, async (tmp, x) => {
      source.root = x.prefix;
      const r = await prepare(tmp, { mode: 'inspect', id: id || proposeId(tmp, { archive: file }), site,
        archive: archive || file, keep, leaveOut, label: file, source, tick });
      r.item.excluded = [...x.excluded, ...r.item.excluded];
      return r.item;
    });
  } catch (e) {
    if (!(e instanceof AdminRefusal)) throw e;
    return { ...blank(source, id || null, archive || file), refusal: refusalOf(e) };
  }
}

/**
 * Adds one ghost to a site as add_ghost.py does (its checks, the copy, then indexSite), from a folder or straight from
 * a .nar / .zip. A refusal throws AdminRefusal before anything is written (or, as add_ghost.py, from the index after
 * the copy: 'site.personal' when another ghost of the site holds personal files). The copy goes into a staging folder
 * in the site and is renamed into ghost/<id> when complete; a replaced folder is moved aside first and deleted after
 * (staging.mjs): a refused or failed add leaves ghost/<id> as it was ('work.rename', 'work.undo' when even the undo
 * failed: recoverWork finishes it). The site's record (shipped.mjs) then holds the Kawari save-header files an archive
 * source kept for this id, and nothing for it after any other add; a record that does not read refuses every add
 * ('kawari.record', before anything is written).
 * @param {{source: {kind: 'folder'|'archive', path: string}, id?: string}|string} plan  an inspectSource item, or a path
 * @param {string} site
 * @param {{id?: string, archive?: string, keep?: string[], leaveOut?: string[], replace?: boolean, index?: boolean,
 *   log?: (line: string) => void, onProgress?: (p: {phase, done, total, item}) => void, tempDir?: string,
 *   onStep?: (step: 'copy'|'swap'|'placed'|'index', id: string) => void, io?: object}} [o]
 *   replace: delete a site folder of that id (add_ghost.py always does; else refused with 'site.exists');
 *   archive: compare with it (an archive source is compared with itself); leaveOut: files not to copy (--skip);
 *   index: false leaves the index to the caller (a batch indexes once); onProgress phases 'extract', 'compare', 'copy',
 *   'remove', 'index'; onStep, before each: 'copy' (into the staging folder: nothing visible changed), 'swap' (the
 *   renames), then 'placed' (ghost/<id> is final), 'index'; io: tests' stand-ins (staging.mjs moveRetry)
 * @returns {Promise<{id, path, copied, balloon: null | {dir, from, copied}, notes, excluded, index: object|null}>}
 */
export async function addGhost(plan, site, { id = null, archive = null, keep = [], leaveOut = [], replace = false,
  index = true, log = () => {}, onProgress = null, tempDir = null, onStep = () => {}, io = {} } = {}) {
  const tick = progress(onProgress);
  const source = typeof plan === 'string'
    ? { kind: ARCHIVE.test(plan) && isFile(plan) ? 'archive' : 'folder', path: path.resolve(plan) } : plan.source;
  const want = id || (typeof plan === 'object' && plan.id) || null;
  const opts = { site, keep, leaveOut, replace, index, log, onProgress, onStep, io, tick };
  if (source.kind === 'archive') {
    return withArchive(source.path, { tempDir, tick }, (tmp, x) => addFolder(tmp, {
      ...opts, id: want || proposeId(tmp, { archive: source.path }), archive: archive || source.path,
      label: source.path, source: { ...source, root: x.prefix }, extracted: x.excluded,
    }));
  }
  const root = path.resolve(source.path);
  return addFolder(root, { ...opts, id: want || path.basename(root), archive, label: root, source });
}

async function addFolder(root, { id, site, archive, keep, leaveOut, replace, index, log, onProgress, onStep, io, tick,
  label, source, extracted = [] }) {
  const siteAbs = path.resolve(site);
  const r = await prepare(root, { mode: 'add', id, site: siteAbs, archive, keep, leaveOut, label, log, source, tick });
  const dst = path.join(siteAbs, 'ghost', id);
  const old = isDir(dst) || isLink(dst);
  if (old && !replace) throw new AdminRefusal('site.exists', { dst });
  onStep('copy', id);
  const stage = workEntry(siteAbs, 'new', id);
  let copied, balloon = null;
  try {
    copied = copyTree(root, stage, r.folders, r.files, (n, t, p) => tick('copy', n, t, p));
    if (r.balloon) {
      const n = copyTree(r.balloon.folder, path.join(stage, r.balloon.dir), r.balloon.folders, r.balloon.files,
        (k, t, p) => tick('copy', k, t, p));
      balloon = { dir: r.balloon.dir, from: r.balloon.folder, copied: n };
    }
  } catch (e) {
    await removeRetry(stage, io);
    dropWorkDir(siteAbs);
    throw e;
  }
  onStep('swap', id);
  // the site's record of this ghost's archive files (shipped.mjs): while the folders are swapped it lists the old
  // ghost's and the new one's, so whichever ghost/<id> a cut-off swap leaves (recoverWork may put the old one back)
  // passes the index; once placed, the new one's alone (none: the key goes, as add_ghost.py sets it after its copy).
  // A union left behind accepts only files an archive holds as they are.
  let before = [];
  try {
    before = readShipped(siteAbs).get(id) || [];
    setShipped(siteAbs, id, shippedUnion(before, r.shipped));
  } catch (e) {
    await removeRetry(stage, io);
    dropWorkDir(siteAbs);
    throw e;
  }
  try {
    await swapIn(siteAbs, stage, dst, old ? workEntry(siteAbs, 'old', id) : null, { io, tick });
  } catch (e) {
    try { setShipped(siteAbs, id, before); } catch (e2) { /* the union is safe to leave */ }
    throw e;
  }
  try { setShipped(siteAbs, id, r.shipped); } catch (e) { /* the union is safe to leave */ }
  onStep('placed', id);
  // add_ghost.py's lines, in its order (it prints each after its copy)
  log(`copied ${copied} files to ${dst}`);
  if (balloon) {
    log(`copied ${balloon.copied} files of its balloon from ${balloon.from} (install.txt balloon.directory) to ${dst}/${balloon.dir}`);
  }
  if (index) onStep('index', id);
  const done = index ? await indexSite(siteAbs, { log, onProgress }) : null;
  return { id, path: dst, copied, balloon, notes: r.item.notes, excluded: [...extracted, ...r.item.excluded], index: done };
}

/**
 * The complete staging copy into ghost/<id>: the old folder (a replace) renamed aside first, the copy renamed in, the
 * old one deleted (what a held file keeps is left for recoverWork). A refused move undoes what was done: the old
 * folder back, the copy deleted.
 */
async function swapIn(site, stage, dst, aside, { io, tick }) {
  const refuse = async (code, params) => {
    await removeRetry(stage, io);
    dropWorkDir(site);
    throw new AdminRefusal(code, params);
  };
  if (aside) {
    try {
      await moveRetry(dst, aside, io);
    } catch (e) {
      await refuse('work.rename', { path: dst, error: errText(e) });
    }
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    await moveRetry(stage, dst, io);
  } catch (e) {
    if (aside) {
      try {
        await moveRetry(aside, dst, io);
      } catch (e2) {
        await removeRetry(stage, io);
        throw new AdminRefusal('work.undo', { path: dst, kept: aside, error: errText(e2) });
      }
    }
    await refuse('work.rename', { path: dst, error: errText(e) });
  }
  if (aside) await removeRetry(aside, { ...io, tick: n => tick('remove', n, null, null) });
  dropWorkDir(site);
}

/**
 * Deletes a site ghost (its folder; a link or junction in its place, or inside it, is removed as a link: what it
 * points to stays) and re-indexes; the index's older manifests and packs stay for tools/prune.mjs (safe updates).
 * Refused, nothing deleted, when no such ghost folder exists ('ghost.missing'), the site's Kawari record does not read
 * ('kawari.record'), the index would refuse the site without it ('site.personal': personal files elsewhere) or the
 * folder cannot be moved ('work.rename'). The folder is
 * renamed into the work folder first, then deleted (staging.mjs): a cut-off removal never leaves half a ghost. Its
 * entries of the site's record (shipped.mjs) go once the folder is out of ghost/.
 * @param {{log?: (line: string) => void, onProgress?: (p: {phase, done, total, item}) => void, index?: boolean,
 *   onStep?: (step: 'swap'|'placed'|'index', id: string) => void, io?: object}} [o] onStep as addGhost's ('placed':
 *   ghost/<id> is gone)
 * @returns {Promise<{id, path, link: boolean, index: object|null}>}
 */
export async function removeGhost(site, id, { log = () => {}, onProgress = null, index = true, onStep = () => {},
  io = {} } = {}) {
  const bad = idProblem(id);
  if (bad) throw new AdminRefusal('id.bad', { id, problem: bad });
  const tick = progress(onProgress);
  const siteAbs = path.resolve(site);
  const dir = path.join(siteAbs, 'ghost', id);
  const link = isLink(dir);
  if (!link && !isDir(dir)) throw new AdminRefusal('ghost.missing', { path: dir });
  const own = `ghost/${id.toLowerCase()}/`;
  // personalFiles reads the site's Kawari record first: one that does not read refuses here ('kawari.record'), before
  // the move, since the removal drops this ghost's entries from it
  const personal = (await personalFiles(siteAbs)).filter(p => !p.path.toLowerCase().startsWith(own));
  if (personal.length) throw personalRefusal(personal);
  onStep('swap', id);
  const aside = workEntry(siteAbs, 'del', id);
  try {
    await moveRetry(dir, aside, io);
  } catch (e) {
    dropWorkDir(siteAbs);
    throw new AdminRefusal('work.rename', { path: dir, error: errText(e) });
  }
  onStep('placed', id);
  // its entries of the site's record go once its folder is out of ghost/ (left by a cut-off removal, or when Windows
  // refuses the record's write, as a scanner holding it does: they accept only files an archive held as they are, so
  // the removal goes on)
  try { setShipped(siteAbs, id, []); } catch (e) { /* the entries are safe to leave */ }
  await removeRetry(aside, { ...io, tick: n => tick('remove', n, null, null) });   // a held file's rest: recoverWork
  dropWorkDir(siteAbs);
  log(link ? `deleted the link ${dir} (what it points to stays)` : `deleted ${dir}`);
  if (index) onStep('index', id);
  return { id, path: dir, link, index: index ? await indexSite(siteAbs, { log, onProgress }) : null };
}

// The program's per-user temp root (CLAUDE.md "A cut-off job"): `instance.json` (one instance per user, so two programs
// never write one site), the job journal `job.json` (written when a job starts, stepped by the job, deleted when it
// ends: one left behind is a job a closed window cut off, and how far it got), `sumika-admin.log` (log.mjs), and one
// run folder `r-<6 hex>/` per start with `drops/` (drag-and-drop uploads) and `x/` (archive extractions). A start
// deletes the run folders of dead instances. Windows: %TEMP%\sumika-admin\, macOS: $TMPDIR/sumika-admin/, Linux:
// ${XDG_CACHE_HOME:-~/.cache}/sumika-admin/ (not the shared /tmp); made 0700.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTree, isLink, isDir } from '../core/tree.mjs';
import { writeAtomic } from './settings.mjs';
import { sameOrInside } from './paths.mjs';
import { interruptedOf } from './outcome.mjs';
import { errorText, errorLog } from './log.mjs';

export const INSTANCE = 'instance.json';
export const JOURNAL = 'job.json';
const RUN = /^r-[0-9a-f]{6}$/;

/** The temp root for this user, or `given` (--temp DIR: dev runs and tests). */
export function tempRoot({ given = null, platform = process.platform, env = {} } = {}) {
  if (given) return path.resolve(given);
  if (platform === 'win32') {
    const t = env.TEMP || env.TMP || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local', 'Temp') : null);
    if (!t) throw new Error('no TEMP folder (TEMP, TMP and USERPROFILE are unset)');
    return path.join(t, 'sumika-admin');
  }
  if (platform === 'darwin') {
    const t = env.TMPDIR || (env.HOME ? path.join(env.HOME, 'Library', 'Caches') : null);
    if (!t) throw new Error('no TMPDIR or HOME');
    return path.join(t, 'sumika-admin');
  }
  const base = env.XDG_CACHE_HOME || (env.HOME ? path.join(env.HOME, '.cache') : null);
  if (!base) throw new Error('no XDG_CACHE_HOME or HOME');
  return path.join(base, 'sumika-admin');
}

/** Makes the temp root (mode 0700) and checks it is a folder of its own, not a link to somewhere else. */
export function makeRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (isLink(root) || !fs.lstatSync(root).isDirectory()) throw new Error(`${root} is not a folder of its own (a link?)`);
  return root;
}

function readJsonFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch (e) {
    return null;
  }
}

/** instance.json: {pid, port, key, version, startedAt}, or null. */
export function readInstance(root) {
  const j = readJsonFile(path.join(root, INSTANCE));
  return j && Number.isInteger(j.port) && typeof j.key === 'string' ? j : null;
}

export function writeInstance(root, info) {
  writeAtomic(path.join(root, INSTANCE), JSON.stringify(info, null, 1) + '\n');
}

/** Deletes instance.json when it is this start's (its key). */
export function removeInstance(root, key) {
  const j = readInstance(root);
  if (j && j.key === key) {
    try { fs.unlinkSync(path.join(root, INSTANCE)); } catch (e) { /* gone */ }
  }
}

/**
 * The instance instance.json names, when it answers `GET /api/hello` with its key within timeoutMs (another start of
 * the program, live); else null.
 */
export async function liveInstance(root, { timeoutMs = 1000, fetchImpl = globalThis.fetch } = {}) {
  const j = readInstance(root);
  if (!j || j.port < 1 || j.port > 65535) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`http://127.0.0.1:${j.port}/api/hello`, {
      headers: { 'X-Sumika-Admin-Key': j.key }, signal: ac.signal, redirect: 'error',
    });
    if (r.status !== 200) return null;
    const body = await r.json();
    return body && body.app === 'sumika-admin' ? j : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The run folders r-<6 hex> under the root, but `keep` (this start's own). */
export function runFolders(root, { keep = null } = {}) {
  try {
    return fs.readdirSync(root).filter(name => RUN.test(name) && name !== keep);
  } catch (e) {
    return [];
  }
}

/**
 * Deletes every run folder r-<6 hex> under the root (a dead instance's) but `keep`, never following a link; their
 * count. A cut-off inspect or add leaves its archive's extraction there, which can take seconds to delete: a start
 * does it in the job worker, after it serves (main.mjs).
 */
export function cleanRuns(root, { keep = null } = {}) {
  let n = 0;
  for (const name of runFolders(root, { keep })) {
    try {
      removeTree(path.join(root, name));
      n++;
    } catch (e) { /* in use or locked: the next start tries again */ }
  }
  return n;
}

/** A new run folder r-<6 hex>/ with drops/ and x/. */
export function makeRun(root) {
  for (let i = 0; i < 16; i++) {
    const dir = path.join(root, `r-${crypto.randomBytes(3).toString('hex')}`);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    fs.mkdirSync(path.join(dir, 'drops'));
    fs.mkdirSync(path.join(dir, 'x'));
    return dir;
  }
  throw new Error(`no free run folder name in ${root}`);
}

const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

/**
 * The journal of a job an earlier start never finished, deleted once read; or null (none, or an ended mark). A
 * journal that is there but does not read (cut off mid-write) comes back with kind null. Older starts wrote only
 * {kind, label, startedAt}: step and site are then undefined. `keep`: read only, dropJournal deletes it later (a start
 * that is settling the work folder: a start cut off meanwhile leaves the journal for the next one).
 * @param {string} root
 * @param {{keep?: boolean, log?: {write: Function}|null}} [o]
 * @returns {{kind: string|null, label: string, startedAt: number|null, site?: string, step?: string|null,
 *   ghost?: string|null, placed: string[], ghosts: {id, name}[]}|null} ghost: the ghost of the last step
 */
export function takeJournal(root, { keep = false, log = null } = {}) {
  const file = path.join(root, JOURNAL);
  const there = fs.existsSync(file);
  const j = readJsonFile(file);
  if (!keep) dropJournal(root, { log });
  if (!there || (j && j.ended)) return null;
  if (!j || typeof j.kind !== 'string') return { kind: null, label: '', startedAt: null, placed: [], ghosts: [] };
  const out = {
    kind: j.kind, label: typeof j.label === 'string' ? j.label : '', startedAt: Number(j.startedAt) || null,
    placed: strs(j.placed),
    ghosts: Array.isArray(j.ghosts) ? j.ghosts.filter(g => g && typeof g.id === 'string')
      .map(g => ({ id: g.id, name: typeof g.name === 'string' ? g.name : g.id })) : [],
  };
  if (typeof j.site === 'string') out.site = j.site;
  if ('step' in j) out.step = typeof j.step === 'string' ? j.step : null;
  if ('ghost' in j) out.ghost = typeof j.ghost === 'string' ? j.ghost : null;
  return out;
}

/**
 * Deletes the journal a start has read (takeJournal); while Windows holds it for a moment (a scanner) it is marked
 * ended instead, so the next start does not report it again.
 */
export function dropJournal(root, { log = null } = {}) {
  const file = path.join(root, JOURNAL);
  const j = readJsonFile(file);
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') writeJournal(file, { id: j && j.id, ended: true }, log);
  }
}

const journalText = entry => JSON.stringify(entry, null, 1) + '\n';

/**
 * A journal write that never throws (the journal is a help): through a rename, else in place; one that gives up goes
 * to the log (`log`: errorLog's), as the next start could then say less of a cut-off job.
 */
function writeJournal(file, entry, log = null) {
  try {
    writeAtomic(file, journalText(entry));
  } catch (e) {
    try {
      fs.writeFileSync(file, journalText(entry));
    } catch (e2) {
      if (log) log.write(`the journal ${file} could not be written`, `${JSON.stringify(entry)}\n${errorText(e)}\n${errorText(e2)}`);
    }
  }
}

const pause = ms => new Promise(r => setTimeout(r, ms));
/** The waits of a journal clear while Windows holds the new file (a virus scanner reading it), ms. */
export const CLEAR_MS = Object.freeze([20, 50, 100, 200, 400]);

/**
 * The journal, written at a job's start ({id, kind, label, startedAt, step: null, placed: [], …}), stepped by the job
 * (journalSteps, in the job worker) and deleted at its end. clear(id) touches only that job's journal (a newer job may
 * own the file by then); while Windows refuses the deletion (EBUSY / EPERM: a scanner holds the new file) it tries
 * again, then overwrites the file in place with an ended mark takeJournal ignores, so a job that ended is never
 * reported as cut off. A write that gives up goes to `log`.
 */
export function journal(root, { clearMs = CLEAR_MS, unlink = fs.unlinkSync, log = null } = {}) {
  const file = path.join(root, JOURNAL);
  return {
    file,
    write: entry => writeJournal(file, entry, log),
    clear: async id => {
      for (let i = 0; ; i++) {
        const j = readJsonFile(file);
        if (j ? id !== undefined && j.id !== id : !fs.existsSync(file)) return;
        try {
          unlink(file);
          return;
        } catch (e) {
          if (e.code === 'ENOENT') return;
          if (i >= clearMs.length) break;
        }
        await pause(clearMs[i]);
      }
      const j = readJsonFile(file);
      if (j ? id === undefined || j.id === id : fs.existsSync(file)) {
        const mark = { id: j ? j.id : id, ended: true };
        try { fs.writeFileSync(file, journalText(mark)); } catch (e) { writeJournal(file, mark, log); }
      }
    },
  };
}

/**
 * A start's settling of what an earlier one left: the work folder of the journal's site and of the chosen site
 * deleted or put back (core recoverWork; never a forbidden folder: a dev run's project site/), then hello's
 * `interrupted` (outcome.mjs) for the journal, if any; both noted in the log.
 * @param {{journal: object|null, site?: string|null, forbidden?: string[], recover: (site: string) =>
 *   Promise<{entries: object[]}>, log?: {write: Function}|null}} o
 * @returns {Promise<object|null>} interrupted
 */
export async function settleStart({ journal, site = null, forbidden = [], recover, log = null }) {
  const sites = [...new Set([journal && journal.site, site].filter(s => typeof s === 'string' && s))]
    .filter(s => !forbidden.some(f => sameOrInside(f, s)) && isDir(s));
  const found = new Map();
  for (const s of sites) {
    try {
      const r = await recover(s);
      found.set(s, r);
      if (log && r.entries.length) {
        log.write(`a start settled what a cut-off job left in ${s}`, r.entries.map(e => `${e.name}: ${e.action}${e.error ? ` (${e.error})` : ''}`).join('\n'));
      }
    } catch (e) {
      if (log) log.write(`a start could not settle the work folder of ${s}`, errorText(e));
    }
  }
  if (!journal) return null;
  const at = journal.site && found.has(journal.site) ? journal.site : null;
  const inGhost = id => !!at && (isDir(path.join(at, 'ghost', id)) || isLink(path.join(at, 'ghost', id)));
  const it = interruptedOf(journal, at ? found.get(at) : null, inGhost);
  if (log) log.write(`the last start's job was cut off: ${it.kind} (${it.label}), outcome ${it.outcome}`, JSON.stringify(it));
  return it;
}

/**
 * The job's side of the journal (run in the job worker: synchronous, so the file says a step before it begins):
 * onStep(step, id) of the core's addGhost / removeGhost and the jobs' index step. 'copy', 'swap' and 'index' become
 * {step, ghost: id}; 'placed' adds id to `placed` (its ghost/<id> is final). The job's own id stays in `id`. A write
 * that gives up goes to the log beside the journal (the temp root's sumika-admin.log; the worker has no other way
 * there).
 * @param {string} file the journal (journal(root).file)
 * @param {{log?: {write: Function}}} [o]
 */
export function journalSteps(file, { log = errorLog(path.dirname(file)) } = {}) {
  const placed = [];
  return (step, id = null) => {
    const j = readJsonFile(file);
    if (!j || j.ended) return;
    if (step === 'placed') {
      if (id && !placed.includes(id)) placed.push(id);
    } else {
      j.step = step;
      j.ghost = id;
    }
    j.placed = [...strs(j.placed).filter(x => !placed.includes(x)), ...placed];
    writeJournal(file, j, log);
  };
}

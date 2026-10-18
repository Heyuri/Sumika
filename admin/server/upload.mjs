// Prepare upload (CLAUDE.md "What gets published", the publishing flow's steps 6 and 7): Check
// first (any problem refuses), then tools/prune.mjs on the site (its ledger `<site>.published.json` beside the folder),
// then the upload list in the flow's order: everything else, then the fixed-name pages that name hashed scripts
// (sumika/index.html, the control page, and sumika/hub.html), sumika/sumika.js and sumika/index/ghosts.json last (a
// host that takes files one by one needs that order; a whole-folder host any order).
// Never listed: dev/, the work folder .sumika-admin-work/ (core/staging.mjs: the job settles it first, and Check
// refuses what is left in it), the temporary files of the Kawari record and hub.json, sumika/kawari-shipped.json.tmp-*
// and sumika/hub.json.tmp-* (a write cut off before its rename: the job's settling deletes them first too), Thumbs.db,
// desktop.ini, .DS_Store, links. Optional
// files are marked (docs/guide.md "You may leave out"): the .map files and the plain engine files (no hash in their
// name) with their build-info. A ledger that does not read (prune's `bad-ledger`) is `ledger-unreadable`; Start a new
// record (`newRecord`) renames it aside, never over a file, and goes on as for a lost ledger (prune's retireAll:
// nothing deleted now, every old file kept RETAIN_DAYS more days) [decision]. Runs in the job worker.
import fs from 'node:fs';
import path from 'node:path';
import { prune, ledgerPath, readLedger, localDay, ENGINE_FILE, RETAIN_DAYS } from '../../tools/prune.mjs';
import { isLink } from '../core/tree.mjs';
import { WORK_DIR, moveRetry } from '../core/staging.mjs';
import { SUMIKA_TEMP } from '../core/shipped.mjs';
import { JobError } from './codes.mjs';
import { checkProblems } from './check.mjs';

/**
 * The files uploaded last, in this order: each fixed-name page after the hashed script it names (in "everything
 * else"), the control page first (no page loads it; sumika.js reads the choice it writes, either version: core/choice.js),
 * the hub before the code, the index last (CLAUDE.md "What gets published").
 */
export const LAST = Object.freeze(['sumika/index.html', 'sumika/hub.html', 'sumika/sumika.js', 'sumika/index/ghosts.json']);
const NEVER = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a site file may be left out of an upload: 'map', 'plain-engine' or null. */
export function optionalKind(rel) {
  if (rel.endsWith('.map')) return 'map';
  const m = /^sumika\/engines\/([^/]+)$/.exec(rel);
  if (!m) return null;
  if (/^[a-z0-9_]+\.build-info\.json$/.test(m[1])) return 'plain-engine';
  if (/^[a-z0-9_]+\.(js|wasm)$/.test(m[1]) && !ENGINE_FILE.test(m[1])) return 'plain-engine';
  return null;
}

/** The upload list: [{path, size, optional?}] in the publishing flow's order. */
export function uploadList(site) {
  const all = [];
  const walk = (abs, rel) => {
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of ents) {
      if (!rel && (e.name.toLowerCase() === 'dev' || e.name.toLowerCase() === WORK_DIR)) continue;
      if (NEVER.has(e.name.toLowerCase())) continue;
      if (rel === 'sumika' && SUMIKA_TEMP.test(e.name)) continue;          // a cut-off write's, never the file itself
      const p = path.join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || isLink(p)) continue;        // Check refuses a site with links before this runs
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) all.push({ path: r, size: fs.statSync(p).size });
    }
  };
  walk(site, '');
  all.sort((a, b) => cmp(a.path, b.path));
  const rest = all.filter(f => !LAST.includes(f.path));
  const tail = LAST.map(p => all.find(f => f.path === p)).filter(Boolean);
  return [...rest, ...tail].map(f => {
    const kind = optionalKind(f.path);
    return kind ? { ...f, optional: kind } : f;
  });
}

/** Whether the ledger reads: true, false (it exists and does not: prune's `bad-ledger`), or null when there is none. */
export function ledgerReads(ledger) {
  try {
    return readLedger(ledger) ? true : null;
  } catch (e) {
    if (e && e.code === 'bad-ledger') return false;
    throw e;
  }
}

/**
 * Renames a ledger that does not read aside, beside it: `<ledger>.broken-<YYYY-MM-DD>`, else `…-2`, `…-3` (never over
 * a file: staging.mjs moveRetry refuses an existing name, and the next one is tried). Its path.
 */
export async function setLedgerAside(ledger, now = Date.now(), io = {}) {
  const day = localDay(new Date(now));
  for (let n = 1; ; n++) {
    const aside = `${ledger}.broken-${day}${n > 1 ? `-${n}` : ''}`;
    if (fs.existsSync(aside) || isLink(aside)) continue;
    try {
      await moveRetry(ledger, aside, io);
      return aside;
    } catch (e) {
      if (!(e && e.code === 'EEXIST')) throw e;          // taken meanwhile: the next name
    }
  }
}

/**
 * Prepare an upload of a site folder.
 * @param {string} site
 * @param {{first?: boolean, retireAll?: boolean, newRecord?: boolean, core: object, onProgress?: Function, now?:
 *   number}} o newRecord: Start a new record, for a ledger that does not read (renamed aside, then as retireAll; a
 *   ledger that reads is `ledger-reads`, left as it is; none at all is retireAll as it is)
 */
export async function prepareUpload(site, { first = false, retireAll = false, newRecord = false, core, onProgress = () => {},
  now = Date.now() }) {
  const check = await checkProblems(site, { core, onProgress });
  if (!check.ok) throw new JobError('check-failed', { count: check.problems.length }, { problems: check.problems });
  onProgress({ phase: 'prune', done: 0, total: null, item: null });
  const ledger = ledgerPath(site);
  let has = fs.existsSync(ledger);
  let aside = null;
  if (newRecord) {
    // repaired meanwhile, or another tab's Start a new record came first: left as it is; gone meanwhile: a lost one
    const reads = has ? ledgerReads(ledger) : null;
    if (reads) throw new JobError('ledger-reads', { ledger });
    // after Check, so a site with problems keeps its ledger as it was; before prune, whose retireAll needs no ledger
    if (reads === false) aside = await setLedgerAside(ledger, now);
    has = false;
    retireAll = true;
  }
  if (!has && !first && !retireAll) throw new JobError('needs-first');
  if (has && (first || retireAll)) throw new JobError('ledger-exists', { ledger });
  let r;
  try {
    r = prune({ site, first, retireAll, now });
  } catch (e) {
    // prune stopped, nothing deleted or written: the ledger goes back where it was, so nothing changed
    if (aside && !fs.existsSync(ledger)) await moveRetry(aside, ledger).catch(() => {});
    if (e && e.refused && e.code === 'bad-ledger') throw new JobError('ledger-unreadable', { ledger, days: RETAIN_DAYS });
    if (e && e.refused) throw new JobError('prune-refused', { message: e.message });
    throw e;
  }
  onProgress({ phase: 'list', done: 0, total: null, item: null });
  const files = uploadList(site);
  return {
    first: !!first, retireAll: !!retireAll, newRecord: !!newRecord, setAside: aside, deleted: r.deleted,
    retired: r.retired, kept: r.kept, ledger: r.ledger, files, count: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0), last: [...LAST], deleteOnHost: r.deleted,
  };
}

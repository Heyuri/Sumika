// Crash-safe folder moves for the admin program's adds and removals (tools/add_ghost.py deletes and copies in place;
// the outputs are the same: the parity tests). An add copies into a staging folder inside the site and renames it into
// ghost/<id> only when the copy is complete; a replace renames the old folder aside first, then the new one in, then
// deletes the old one; a removal renames ghost/<id> aside, then deletes it. So a closed window, a crash or a full disk
// never leaves a half-copied or half-deleted ghost in ghost/. The work folder SITE/.sumika-admin-work/ is no content:
// the index scans only ghost/ and balloon/, Prepare upload never lists it, Check reports what is left in it, and it is
// deleted when empty. Its entries are `<kind>-<6 hex>-<id>`: new (a staging copy), old (a replaced ghost moved aside),
// del (a removed ghost moved aside). recoverWork (the program runs it at its start and before each write job) deletes
// or puts back what a cut-off job left, and the Kawari record's temporary files a cut-off write left (shipped.mjs). Windows refuses a rename now and then (a virus scanner or an Explorer window
// holding a file): each move is retried with a short backoff, then refused with what was done undone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTree, isDir, isLink } from './tree.mjs';
import { dropWriteTemps } from './shipped.mjs';

export const WORK_DIR = '.sumika-admin-work';
/** The waits between the tries of a move or a deletion (ms): about 3 s in all. */
export const RETRY_MS = Object.freeze([50, 100, 200, 400, 800, 1600]);
const ENTRY = /^(new|old|del)-([0-9a-f]{6})-(.+)$/;
// what Windows answers while another program holds a file (EPERM: access denied, EBUSY: a sharing violation;
// ENOTEMPTY: a folder whose deleted file is still held, "delete pending")
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'UNKNOWN']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const present = p => isDir(p) || isLink(p) || fs.existsSync(p);

/** SITE/.sumika-admin-work */
export const workDir = site => path.join(path.resolve(site), WORK_DIR);

/** A new entry's path in the work folder (the folder made, the entry not): `<kind>-<6 hex>-<id>`. */
export function workEntry(site, kind, id) {
  const dir = workDir(site);
  fs.mkdirSync(dir, { recursive: true });
  for (;;) {
    const p = path.join(dir, `${kind}-${crypto.randomBytes(3).toString('hex')}-${id}`);
    if (!present(p)) return p;
  }
}

/** Deletes the work folder when nothing is left in it. */
export function dropWorkDir(site) {
  try { fs.rmdirSync(workDir(site)); } catch (e) { /* not there, or not empty */ }
}

/**
 * Renames `from` to `to`, retried while Windows refuses for a moment; never over an existing `to` (EEXIST at once).
 * @param {{rename?: (from: string, to: string) => void, retryMs?: number[]}} [io] tests' stand-in and delays
 */
export async function moveRetry(from, to, { rename = fs.renameSync, retryMs = RETRY_MS } = {}) {
  for (let i = 0; ; i++) {
    if (present(to)) throw Object.assign(new Error(`${to} exists`), { code: 'EEXIST' });
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (i >= retryMs.length || !TRANSIENT.has(e && e.code)) throw e;
    }
    await sleep(retryMs[i]);
  }
}

/** Deletes a tree (never following a link), retried the same way; false when something is left (a leftover). */
export async function removeRetry(p, { retryMs = RETRY_MS, tick = () => {} } = {}) {
  for (let i = 0; ; i++) {
    try {
      removeTree(p, tick);
      return true;
    } catch (e) {
      if (i >= retryMs.length || !TRANSIENT.has(e && e.code)) return false;
    }
    await sleep(retryMs[i]);
  }
}

/**
 * What the work folder holds: [{name, path, kind: 'new'|'old'|'del'|null, id}] (kind null: a name it never makes). A
 * link or junction in the work folder's place is no folder of the program's: one entry for the link itself (name ''),
 * never what it points to, which recoverWork would otherwise delete.
 */
export function workLeftovers(site) {
  const dir = workDir(site);
  if (isLink(dir)) return [{ name: '', path: dir, kind: null, id: null }];
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch (e) { return []; }
  return names.map(name => {
    const m = ENTRY.exec(name);
    return { name, path: path.join(dir, name), kind: m ? m[1] : null, id: m ? m[3] : null };
  });
}

/**
 * Settles what a cut-off add or removal left in the work folder: a staging copy (new) and a removed ghost (del) are
 * deleted; a replaced ghost moved aside (old) goes back into ghost/<id> while that is missing (the swap was cut off
 * before the new folder was in), else it is deleted. A name the core never makes is deleted too (a link as a link,
 * what it points to left alone): everything in the work folder is the program's own scratch, and Check's "deleted at
 * the next change" must come true [decision]; so is a link in the work folder's own place (workLeftovers),
 * never followed. Then the temporary files a write of the site's Kawari record or hub.json cut off before its rename
 * left in sumika/ (shipped.mjs dropWriteTemps: entries of kind 'temp', named site-relative). Nothing else is touched
 * but ghost/<id>.
 * @param {string} site
 * @param {{io?: {rename?: Function, retryMs?: number[]}}} [o]
 * @returns {Promise<{entries: {name, kind: 'new'|'old'|'del'|'temp'|null, id, action: 'deleted'|'restored'|'kept',
 *   error?: string}[], clean: boolean}>}
 *   kept: still there (in use, or an old folder that could not go back); clean: the work folder is gone (nothing was
 *   there, or all of it settled)
 */
export async function recoverWork(site, { io = {} } = {}) {
  const entries = [];
  for (const e of workLeftovers(site)) {
    const out = { name: e.name, kind: e.kind, id: e.id };
    entries.push(out);
    const dst = e.kind ? path.join(path.resolve(site), 'ghost', e.id) : null;
    if (e.kind === 'old' && !present(dst)) {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        await moveRetry(e.path, dst, io);
        out.action = 'restored';
      } catch (err) {
        out.action = 'kept';
        out.error = String((err && err.code) || err);
      }
      continue;
    }
    if (await removeRetry(e.path, io)) out.action = 'deleted';
    else {
      out.action = 'kept';
      out.error = 'in use';
    }
  }
  dropWorkDir(site);
  for (const t of dropWriteTemps(site)) entries.push({ name: t.name, kind: 'temp', id: null, action: t.action, ...(t.error ? { error: t.error } : {}) });
  return { entries, clean: !fs.existsSync(workDir(site)) };
}

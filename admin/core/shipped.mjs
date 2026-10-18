// The site's record of the Kawari save-header files that ghosts added from their own .nar / .zip brought (rules.mjs
// KAWARI_RECORD, SITE/sumika/kawari-shipped.json; index_site.py KAWARI_RECORD, read_kawari_record,
// kawari_record_bytes, set_kawari_record: the same bytes, a change is made in both). In a Kawari ghost a file that
// starts with Kawari's save header may keep what a user told the ghost; in the ghost's archive it is the author's
// starting file, so an add from the archive copies it and records it here, ghost-root-relative with its CRC-32, under
// the site folder's id [decision], and both index tools accept a
// file the record lists for its ghost while its CRC-32 is the same (index.mjs personalFiles). An add sets its ghost's
// entries (none: its key goes), removeGhost drops them, a record without entries is deleted. Written only when its
// bytes change, atomically: a temporary file beside it (SUMIKA_TEMP), then a rename; a write or a rename that fails
// deletes it, and one a cut-off run left is deleted by the program's tidy-up (staging.mjs recoverWork:
// dropWriteTemps).
// A record that exists and does not read is never read as empty [decision]: the next write would drop the
// other ghosts' entries and the index then refuse their files as saves. So it throws the refusal 'kawari.record'
// {problem}, and every add, removal and index stops before anything is written, until it is repaired or deleted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { KAWARI_RECORD } from './rules.mjs';
import { dumps, cmpPy } from './py.mjs';
import { isFile, isLink, removeTree } from './tree.mjs';
import { AdminRefusal } from './refusal.mjs';

const fileOf = site => path.join(path.resolve(site), ...KAWARI_RECORD.split('/'));

const isCrc = v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
// json.loads reads a number written with a fraction or an exponent (3.0, 1e2) as a float, which `== 1` takes as format
// 1 but `type(e[1]) is int` never as a CRC-32; JSON.parse gives 3 for 3.0, so such a number is kept boxed (a Number
// object, which JSON gives for nothing else), told by the reviver's source text (Node 21+, Deno 2)
const INT = /^-?(?:0|[1-9][0-9]*)$/;
const pyNumbers = (k, v, ctx) => (typeof v === 'number' && ctx && typeof ctx.source === 'string' && !INT.test(ctx.source)
  ? Object(v) : v);
const isOne = v => (typeof v === 'number' || v instanceof Number) && Number(v) === 1;
// json.loads' dict: an object, never a list, null or a number kept boxed above
const isDict = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Number);
// a string UTF-8 can write: both readers take an escaped lone surrogate ("\ud800"), which neither tool could write
// again (index_site.py _writable)
const isText = v => typeof v === 'string' && v.isWellFormed();
const unreadable = problem => new AdminRefusal('kawari.record', { problem });

/**
 * The temporary files of the two files the admin writes in sumika/, `<file>.tmp-<8 hex>` beside each: the record's
 * (both tools) and hub.json's (the Sharing screen's Save, admin/server/settings.mjs writeAtomic).
 */
export const SUMIKA_TEMP = /^(?:kawari-shipped|hub)\.json\.tmp-[0-9a-f]{8}$/;

/**
 * index_site.py read_kawari_record: Map(ghost id -> [[path, CRC-32]]); empty when the file is missing. One that exists
 * reads whole, as Python reads it, or throws AdminRefusal 'kawari.record' {problem} (KAWARI_RECORD_PROBLEMS there):
 * 'record.open' (it cannot be opened), 'record.json' (strict UTF-8 after one BOM, an editor's, which Python's utf-8-sig
 * drops too; then JSON, which json.loads reads alike once its NaN and Infinity are refused and an int too long for
 * int() is its float), 'record.format' (not {"format": 1, "ghosts": {…}}, or an id UTF-8 cannot write; other keys are
 * ignored), 'record.entries' (an entry that is no [string UTF-8 can write, int of 0..0xFFFFFFFF]: json.loads' int and
 * float apart).
 * @returns {Map<string, [string, number][]>}
 */
export function readShipped(site) {
  let bytes;
  try {
    bytes = fs.readFileSync(fileOf(site));
  } catch (e) {
    if (e && e.code === 'ENOENT') return new Map();
    throw unreadable('record.open');
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), pyNumbers);
  } catch (e) {
    throw unreadable('record.json');
  }
  const ghosts = isDict(data) && isOne(data.format) ? data.ghosts : null;
  // the ids first: Object.entries puts integer-like keys first, json.loads keeps the file's order
  if (!isDict(ghosts) || !Object.keys(ghosts).every(isText)) throw unreadable('record.format');
  const out = new Map();
  for (const [gid, v] of Object.entries(ghosts)) {
    if (!Array.isArray(v) || !v.every(e => Array.isArray(e) && e.length === 2 && isText(e[0]) && isCrc(e[1]))) {
      throw unreadable('record.entries');
    }
    out.set(gid, v.map(e => [e[0], e[1]]));
  }
  return out;
}

/**
 * index_site.py kawari_record_bytes: the ghosts with entries by id, each one's entries by path (Python's sorted: code
 * points, then the CRC-32), json.dumps with a 1-space indent, LF line ends; null when no ghost has entries.
 * @param {Map<string, [string, number][]>} record
 * @returns {Buffer|null}
 */
export function shippedBytes(record) {
  const ghosts = new Map();
  for (const gid of [...record.keys()].sort(cmpPy)) {
    const v = record.get(gid);
    if (v && v.length) ghosts.set(gid, [...v].map(([p, crc]) => [p, crc]).sort((a, b) => cmpPy(a[0], b[0]) || a[1] - b[1]));
  }
  if (!ghosts.size) return null;
  return Buffer.from(dumps(new Map([['format', 1], ['ghosts', ghosts]]), { indent: 1 }) + '\n', 'utf8');
}

/**
 * index_site.py set_kawari_record: sets ghost `id`'s entries ([[path, CRC-32]]; none drops its key) and returns its
 * old ones. A record that does not read throws (readShipped), nothing written.
 * @returns {[string, number][]}
 */
export function setShipped(site, id, entries) {
  const file = fileOf(site);
  const record = readShipped(site);
  const old = record.get(id) || [];
  record.delete(id);
  if (entries && entries.length) record.set(id, entries);
  const data = shippedBytes(record);
  if (!data) {
    if (isFile(file)) fs.unlinkSync(file);
    return old;
  }
  let same = false;
  try { same = fs.readFileSync(file).equals(data); } catch (e) { same = false; }
  if (same) return old;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx');             // one of that name is not this run's: EEXIST, left alone
  let placed = false;
  try {
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    placed = true;
  } finally {
    if (!placed) try { fs.unlinkSync(tmp); } catch (e) { /* gone */ }
  }
  return old;
}

/**
 * Deletes the temporary files a write of the record or of hub.json cut off between its write and its rename left in
 * sumika/ (a closed window, a crash; either tool): [{name: 'sumika/<file>', action: 'deleted'|'kept', error?}]. A file
 * or a link (as a link) of such a name only; nothing else is touched.
 */
export function dropWriteTemps(site) {
  const dir = path.dirname(fileOf(site));
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => SUMIKA_TEMP.test(n)).sort(); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    const p = path.join(dir, name);
    let file = false;
    try { file = fs.lstatSync(p).isFile(); } catch (e) { file = false; }
    if (!file && !isLink(p)) continue;
    const e = { name: `sumika/${name}` };
    try {
      removeTree(p);                             // a link as a link, a read-only file too
      e.action = 'deleted';
    } catch (err) {
      e.action = 'kept';
      e.error = String((err && err.code) || err);
    }
    out.push(e);
  }
  return out;
}

/** The entries of both lists, each (path, CRC-32) once: what a replace records while its folders are swapped. */
export function shippedUnion(a, b) {
  const seen = new Set();
  const out = [];
  for (const [p, crc] of [...a, ...b]) {
    const k = `${p}\n${crc}`;
    if (!seen.has(k)) out.push([p, crc]);
    seen.add(k);
  }
  return out;
}

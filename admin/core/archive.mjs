// Archives for the admin core: a .nar / .zip read in place (tools/sweep/zip.mjs) with tools/add_ghost.py's names
// (zip_name: UTF-8 when flagged, else strict cp932, else zipfile's cp437; `\` as `/`), add_ghost.py archive_index (a
// .nar's CRC-32s and sizes, an update list's MD5s and size=), and the ghost root of an archive extracted into a new
// folder for an add (the documented flow: "extract it into a new empty scratch folder, then add_ghost.py <that folder>
// --archive <its .nar>", CLAUDE.md Commands) with these guards: no name that leaves the folder (absolute, a drive, `..`,
// an empty or `.` segment), none Windows would change or refuse (`<>:"|?*`, control characters, a trailing dot or
// space, a device name such as CON or COM1), no encrypted or unknown-method member, no member whose size or CRC-32
// differs from its record (inflated to its recorded size at most), no file and folder of one name; links are never
// written (reported as left out). What add_ghost.py leaves out is never written either: profile/ folders (never
// entered), the engines' saves and logs, DLLs and EXEs, PERSONAL_PATHS; the folders around them are made, as an
// extraction makes them, so the copy that follows matches add_ghost.py's on a full extraction.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openZip, crc32 } from '../../tools/sweep/zip.mjs';
import { pyStrip } from './py.mjs';
import { zipName, decodeCp932 } from './text.mjs';
import { isSkipDir, skipCode } from './rules.mjs';
import { message } from './codes.mjs';
import { AdminRefusal } from './refusal.mjs';

const DESCRIPT = /(^|\/)ghost\/master\/descript\.txt$/i;

/** Members with add_ghost.py's names: [{name, rec}] in central-directory order (folders end with '/'). */
export function zipMembers(file) {
  const z = openZip(file);
  return z.all.map(rec => ({ name: zipName(rec.raw, rec.flags), rec }));
}

/** The ghost root inside an archive, as archive_index finds it: the shortest …ghost/master/descript.txt's folder. */
export function ghostPrefix(members) {
  const desc = members.map(m => m.name).filter(n => !n.endsWith('/') && DESCRIPT.test(n))
    .sort((a, b) => a.length - b.length);
  return desc.length ? desc[0].slice(0, -'ghost/master/descript.txt'.length) : null;
}

// Python's int() of a str of \d digits (any Unicode Nd: re's \d is Unicode): Nd digits come in runs of ten from a zero
// (back to back for the mathematical ones), so a digit's value is the count of Nd characters before it, mod 10
function digits(s) {
  let n = 0;
  for (const ch of s) {
    let back = 0;
    for (let c = ch.codePointAt(0) - 1; c >= 0 && /\p{Nd}/u.test(String.fromCodePoint(c)); c--) back++;
    n = n * 10 + (back % 10);
  }
  return n;
}

/**
 * add_ghost.py archive_index: Map(lower-cased ghost-root-relative name -> [[kind, digest, size]]): kind 'crc32' (a
 * .nar / .zip member; digest a number) or 'md5' (an update list's line; digest and size null when missing).
 */
export function archiveIndex(file) {
  const out = new Map();
  const add = (k, v) => {
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(v);
  };
  if (/\.(nar|zip)$/.test(file.toLowerCase())) {
    const members = zipMembers(file).filter(m => !m.name.endsWith('/'));
    const prefix = ghostPrefix(members) ?? '';
    for (const { name, rec } of members) {
      if (name.startsWith(prefix)) add(name.slice(prefix.length).toLowerCase().replace(/^\/+/, ''), ['crc32', rec.crc, rec.size]);
    }
    return out;
  }
  const data = fs.readFileSync(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);          // utf-8-sig: one BOM dropped, strict
  } catch (e) {
    text = decodeCp932(data);
  }
  for (const line of text.split(/\r\n|\r|\n/)) {
    const fields = line.split('\x01');
    let first = pyStrip(fields[0]);
    if (first.toLowerCase().startsWith('file,')) first = pyStrip(first.slice(5));      // updates.txt: file,<path>…
    if (!first) continue;
    let md5 = fields.length > 1 ? pyStrip(fields[1]).toLowerCase() : '';
    md5 = /^[0-9a-f]{32}$/.test(md5) ? md5 : null;
    let size = null;
    for (const f of fields.slice(2)) {
      const m = /^size=(\p{Nd}+)$/u.exec(pyStrip(f));
      if (m) { size = digits(m[1]); break; }
    }
    add(first.replace(/\\/g, '/').toLowerCase().replace(/^\/+/, ''), ['md5', md5, size]);
  }
  return out;
}

/** add_ghost.py matches: a file's bytes against one archive entry (a missing digest or size matches anything). */
export function matches(data, [kind, digest, size]) {
  if (size !== null && size !== undefined && data.length !== size) return false;
  if (digest === null || digest === undefined) return true;
  if (kind === 'crc32') return crc32(data) === digest;
  return crypto.createHash('md5').update(data).digest('hex') === digest;
}

const BAD_CHARS = /[<>:"|?*\x00-\x1f]/;
const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\xb9\xb2\xb3]|lpt[0-9\xb9\xb2\xb3])(\..*)?$/i;

/** Why a path segment (a file or folder name, a site id) cannot be written as it is named: a name.* code, or null. */
export function badSegment(s) {
  if (s === '' || s === '.' || s === '..') return 'name.dots';
  if (BAD_CHARS.test(s)) return 'name.badChar';
  if (/[. ]$/.test(s)) return 'name.trailingDotSpace';
  if (DEVICE.test(s)) return 'name.device';
  return null;
}

/** A Unix symbolic link or a Windows reparse point, as the archive's attributes say. */
function isLinkMember(rec) {
  const host = rec.madeBy >> 8;
  if (host === 3 && ((rec.attrs >>> 16) & 0o170000) === 0o120000) return true;
  return (host === 0 || host === 10 || host === 11 || host === 14) && (rec.attrs & 0x400) !== 0;
}

const left = (p, code, params) => ({ path: p, code, ...(params ? { params } : {}), why: message(code, params || {}) });

/**
 * Extracts an archive's ghost root into `dest` (a new empty folder) as described at the head of this file.
 * @param {string} file  @param {string} dest
 * @param {(done: number, total: number, item: string|null) => void} [tick] progress per file written
 * @returns {{prefix: string, excluded: {path, code, params?, why}[], files: number, bytes: number}}
 * @throws {AdminRefusal} 'archive.unreadable', 'archive.noGhost', 'archive.unsafe' (members refused, nothing written)
 *   or 'archive.damaged'
 */
export function extractGhost(file, dest, tick = () => {}) {
  let members;
  try {
    members = zipMembers(file);
  } catch (e) {
    throw new AdminRefusal('archive.unreadable', { file, error: e.message });
  }
  const prefix = ghostPrefix(members);
  if (prefix === null) throw new AdminRefusal('archive.noGhost', { file });
  const bad = [], excluded = [], seen = new Map(), dirs = new Map(), plan = [];
  const real = (segs, isDirectory) => {
    // the first spelling of a name wins, in any case, as on Windows; a file and a folder of one name cannot be
    let out = '';
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1;
      const key = (out ? out + '/' : '') + segs[i];
      const low = key.toLowerCase();
      const kind = last && !isDirectory ? 'file' : 'dir';
      const prev = seen.get(low);
      if (prev && prev.kind !== kind) return null;
      if (!prev) seen.set(low, { kind, name: key });
      out = (prev || seen.get(low)).name;
    }
    return out;
  };
  const folder = (segs, name) => {
    const r = real(segs, true);
    if (r === null) bad.push({ path: name, code: 'member.fileAndFolder' });
    else dirs.set(r.toLowerCase(), r);
    return r !== null;
  };
  for (const { name, rec } of members) {
    if (!name.startsWith(prefix)) continue;
    // leading slashes dropped, as archive_index drops them from its names and zipfile when it extracts (BTHver.5's
    // archive holds a record `\`: its own root folder)
    const rel = name.slice(prefix.length).replace(/^\/+/, '');
    if (!rel) continue;
    const isDirectory = rel.endsWith('/');
    const segs = (isDirectory ? rel.slice(0, -1) : rel).split('/');
    const why = segs.map(badSegment).find(Boolean);
    if (why) { bad.push({ path: name, code: why }); continue; }
    const skipAt = segs.findIndex((s, i) => (i < segs.length - 1 || isDirectory) && isSkipDir(s));
    if (skipAt >= 0) {
      // the folders around it are made, as an extraction makes them; nothing inside is read
      if (skipAt > 0 && !folder(segs.slice(0, skipAt), name)) continue;
      const dir = segs.slice(0, skipAt + 1).join('/') + '/';
      if (!excluded.some(x => x.path === dir)) excluded.push(left(dir, 'personal.profile'));
      continue;
    }
    if (isDirectory) { folder(segs, name); continue; }
    if (segs.length > 1 && !folder(segs.slice(0, -1), name)) continue;
    if (rec.flags & 1) { bad.push({ path: name, code: 'member.encrypted' }); continue; }
    if (rec.method !== 0 && rec.method !== 8) { bad.push({ path: name, code: 'member.method', params: { method: rec.method } }); continue; }
    if (isLinkMember(rec)) { excluded.push(left(rel, 'archive.link')); continue; }
    const skip = skipCode(rel);
    if (skip) { excluded.push(left(rel, skip.code, skip.params)); continue; }
    const r = real(segs, false);
    if (r === null) { bad.push({ path: name, code: 'member.fileAndFolder' }); continue; }
    plan.push({ rel: r, rec, name });
  }
  if (bad.length) throw new AdminRefusal('archive.unsafe', { file }, bad);
  const root = path.resolve(dest);
  const inside = p => {
    const abs = path.resolve(root, ...p.split('/'));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`${p} leaves ${root}`);
    return abs;
  };
  fs.mkdirSync(root, { recursive: true });
  for (const d of dirs.values()) fs.mkdirSync(inside(d), { recursive: true });
  let bytes = 0;
  plan.forEach(({ rel, rec, name }, i) => {
    tick(i, plan.length, rel);
    let data;
    try {
      data = rec.readChecked();
    } catch (e) {
      const why = String(e.message);                    // "<member name>: damaged (…)" from zip.mjs: the reason alone
      throw new AdminRefusal('archive.damaged', { file, member: name, error: why.startsWith(`${rec.name}: `) ? why.slice(rec.name.length + 2) : why });
    }
    fs.writeFileSync(inside(rel), data);
    bytes += data.length;
  });
  tick(plan.length, plan.length, null);
  return { prefix, excluded, files: plan.length, bytes };
}

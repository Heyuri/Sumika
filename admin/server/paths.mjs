// Path rules of the admin program (CONTRACTS "Admin API"): one pure check for the relative paths a page sends (a
// dropped file's path) and a URL asks for (the preview), the real-path containment test, and the drives and places of
// the file browser. The program's own walks never follow a link (admin/core/tree.mjs isLink / removeTree: one rule
// for links in the whole program).
import fs from 'node:fs';
import path from 'node:path';

const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const BAD_CHAR = /[\\:<>"|?*\u0000-\u001f\u007f]/;

/**
 * The segments of a '/'-separated relative path, or null when it is none the program writes or serves: an empty, '.'
 * or '..' segment, a leading '/', a '\', a ':' (drive letters, NTFS streams), '<>"|?*', a control character, a Windows
 * device name in any segment (CON, NUL, COM1 …, with or without an extension), a segment ending in a space or a dot.
 * Any other character is fine (Japanese names).
 * @param {unknown} rel
 * @returns {string[]|null}
 */
export function safeRelPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/')) return null;
  const segs = rel.split('/');
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || BAD_CHAR.test(s) || /[ .]$/.test(s)) return null;
    if (DEVICE.test(s.split('.')[0].replace(/ +$/, ''))) return null;
  }
  return segs;
}

const realpath = p => (fs.realpathSync.native || fs.realpathSync)(p);

/** Case folding of the file system's names: Windows and macOS compare names without case. */
export const foldCase = (p, platform = process.platform) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);

/** The real path of p, or null when it does not exist (or cannot be resolved). */
export function realOrNull(p) {
  try {
    return realpath(p);
  } catch (e) {
    return null;
  }
}

/**
 * Whether target lies inside root: the real path of the target (of its parent folder, for a file not there yet)
 * starts with the real path of root and a separator (case-insensitive on Windows and macOS). Root itself is not
 * inside root.
 */
export function inside(root, target) {
  const r = realOrNull(root);
  if (!r) return false;
  let t = realOrNull(target);
  if (!t) {
    const parent = realOrNull(path.dirname(target));
    if (!parent) return false;
    t = path.join(parent, path.basename(target));
  }
  const base = r.endsWith(path.sep) ? r : r + path.sep;
  return foldCase(t).startsWith(foldCase(base));
}

/** Whether p is root or inside it, by real paths (the project-site guard). */
export function sameOrInside(root, p) {
  const r = realOrNull(root), t = realOrNull(p);
  if (!r || !t) return false;
  return foldCase(t) === foldCase(r) || inside(r, t);
}

export function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

export function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

/**
 * The file browser's drives: Windows' drive letters A–Z probed with stat at once, waiting at most timeoutMs (those
 * that gave no answer by then are `unavailable`; those that answered with an error do not exist); '/' elsewhere.
 * @returns {Promise<{drives: string[], unavailable: string[]}>}
 */
export async function drives({ platform = process.platform, timeoutMs = 2000, stat = p => fs.promises.stat(p) } = {}) {
  if (platform !== 'win32') return { drives: ['/'], unavailable: [] };
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(c => `${c}:\\`);
  const state = new Map();
  let timer = null;
  await Promise.race([
    Promise.all(letters.map(d => Promise.resolve().then(() => stat(d))
      .then(() => state.set(d, true), () => state.set(d, false)))),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
  return { drives: letters.filter(d => state.get(d) === true), unavailable: letters.filter(d => !state.has(d)) };
}

/**
 * The file browser's places, each an existing folder: home, Desktop (and OneDrive's Desktop), Downloads, /Volumes on
 * macOS, the program's folder (compiled builds only), then the recent folders. Home comes from USERPROFILE / HOME.
 * @returns {{kind: 'home'|'desktop'|'downloads'|'volumes'|'program'|'recent', path: string}[]}
 */
export function places({ platform = process.platform, env = {}, programDir = null, recent = [], exists = isDir } = {}) {
  const out = [];
  const add = (kind, p) => {
    if (p && exists(p) && !out.some(x => x.kind === kind && foldCase(x.path, platform) === foldCase(p, platform))) out.push({ kind, path: p });
  };
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (home) {
    add('home', home);
    add('desktop', path.join(home, 'Desktop'));
    if (platform === 'win32') add('desktop', path.join(home, 'OneDrive', 'Desktop'));
    add('downloads', path.join(home, 'Downloads'));
  }
  if (platform === 'darwin') add('volumes', '/Volumes');
  if (programDir) add('program', programDir);
  for (const r of recent) add('recent', r);
  return out;
}

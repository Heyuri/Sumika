// The constants of tools/index_site.py and tools/add_ghost.py the admin core shares (CLAUDE.md "The admin tool": a
// change is made in both). tests/admin/core.test.mjs imports the two Python modules and fails while any of these
// differs from its Python twin. The root engines' pack patterns are src/core/engine-files.js's (= index_site.py
// YAYA_PACK_EXT, KAWARI_PACK_EXT, KAWARI7_PACK_EXT, PACK_MAX). Pure and page-safe, as py.mjs (the admin page's drop
// walker imports skipCode / isSkipDir): no node: import here.
import { YAYA_TEXT, KAWARI_TEXT, KAWARI7_TEXT, YAYA_MAX_BYTES } from '../../src/core/engine-files.js';
import { INDEX_FORMAT } from '../../src/core/loader.js';
import { fnmatchcase } from './py.mjs';

/** index_site.py FORMAT (= src/core/loader.js INDEX_FORMAT) */
export const FORMAT = INDEX_FORMAT;
/** hex digits of a manifest's or pack's SHA-1 in its name */
export const NAME_HASH = 10;
/** hex digits of a file's SHA-1 in its `?v=` */
export const VERSION_HASH = 8;

// What SSP and the engines write about the person using the ghost: never published (index_site.py PERSONAL_*)
export const PERSONAL_DIRS = Object.freeze(['profile']);
export const PERSONAL_FILES = Object.freeze(['satori_savedata*', 'satori_savebackup*', '*_variable.*', '*.log']);
/** files an SSP run created or rewrote inside one ghost: ghost-root-relative patterns, any case */
export const PERSONAL_PATHS = Object.freeze([
  // bonsyou: what SSP's \![execute,http-get,…,--file=bonsyou.txt] downloaded, and its menu counter's bonsyou_now.txt
  'ghost/master/var/bonsyou*.txt',
  // bthver.5 (BloodTeaHOUSE ver.5): its saves, written by an SSP run
  'ghost/master/savefile1.txt',
  'ghost/master/savebackup.txt',
]);

// Kawari's save header (index_site.py KAWARI_SAVE_HEAD; Phase 7 wrote 華和梨セーブファイル in code page 932, these bytes)
export const KAWARI_ENGINES = Object.freeze(['kawari', 'kawari7']);
const PHASE7_HEAD = String.fromCharCode(...'89d89861979c835a815b8375837483408343838b'.match(/../g).map(h => parseInt(h, 16)));
/** matched on a file's first 128 bytes read as Latin-1 (one character per byte) */
export const KAWARI_SAVE_HEAD = new RegExp(
  `^#[ \\t]*\\r?\\n#[ \\t]*(?:Kawari saved file|${PHASE7_HEAD.replace(/[[\]\\^$.|?*+(){}]/g, '\\$&')})[ \\t]*\\r?\\n#`);
/** (ghost-root-relative path, CRC-32) of each such file a site ghost's archive ships as it is, any case */
export const KAWARI_SHIPPED_SAVES = Object.freeze([
  ['ghost/master/mayura.ini', 0x1344d712],    // mayura_v350.nar
  ['ghost/master/news.dat', 0x2dbe2cb7],    // mayura_v350.nar
]);
/** site-relative: the site's record of such files ghosts added from their own .nar / .zip brought (shipped.mjs) */
export const KAWARI_RECORD = 'sumika/kawari-shipped.json';

// the packs (index_site.py PACK_EXT, PACK_SKIP, ROOT_PACK_EXT by ghosts.json engine, PACK_MAX)
export const PACK_EXT = Object.freeze(['.txt', '.dic', '.ini', '.csv', '.aym', '.sat', '.ayc']);
export const PACK_SKIP = Object.freeze(['updates', 'readme']);
export const ROOT_PACK_EXT = Object.freeze({ yaya: YAYA_TEXT, kawari: KAWARI_TEXT, kawari7: KAWARI7_TEXT });
export const PACK_MAX = YAYA_MAX_BYTES;

export const DEFAULT_BALLOON = 'sumika';

// SSP's thumbnail extensions (index_site.py THUMB_EXT, THUMB_EXT_PREFIX)
export const THUMB_EXT = Object.freeze(new Set([
  'png', 'pnr', 'apng', 'apnr', 'dgp', 'dfp', 'ddp', 'dap', 'webp', 'gif', 'jpg', 'jpeg', 'jpe', 'jfif', 'jfi', 'jif',
  'pjpeg', 'pjp', 'bmp', 'dib', 'rle', 'btf', 'tf8', 'ico', 'cur', 'mag', 'pi', 'xbm', 'xpm', 'tga', 'targa', 'vda',
  'icb', 'vst', 'pbm', 'pgm', 'ppm', 'pam', 'pnm', 'pfm', 'pcx', 'qoi', 'psd', 'psp', 'pspimage', 'ora', 'kra', 'krz',
  'clip', 'lip', 'xcf']));
export const THUMB_EXT_PREFIX = Object.freeze(['tif', 'mdi']);

// add_ghost.py: what a copy leaves out besides index_site.py's personal files, and what an archive always lists
export const SKIP_FILES = Object.freeze([...PERSONAL_FILES, '*.dll', '*.exe', 'thumbs.db', 'desktop.ini']);
export const ALWAYS_LISTED = /(^|\/)(install\.txt|updates[^/]*\.(dau|txt))$/i;

/** index_site.py is_personal_path: a ghost-root-relative path PERSONAL_PATHS names (any case). */
export function isPersonalPath(rel) {
  const low = String(rel).replace(/\\/g, '/').toLowerCase();
  return PERSONAL_PATHS.some(p => fnmatchcase(low, p.toLowerCase()));
}

/** The PERSONAL_PATHS pattern a ghost-root-relative path matches, or null. */
function personalPattern(rel) {
  const low = String(rel).replace(/\\/g, '/').toLowerCase();
  return PERSONAL_PATHS.find(p => fnmatchcase(low, p.toLowerCase())) ?? null;
}

// the code of each name pattern (admin/core/codes.mjs): a pattern added to SKIP_FILES needs its code here, its text
// in codes.mjs and its translations in admin/page/strings.js (tests/admin/core.test.mjs and strings.test.mjs fail
// until then)
const FILE_CODE = {
  'satori_savedata*': 'personal.satoriSave', 'satori_savebackup*': 'personal.satoriBackup',
  '*_variable.*': 'personal.variable', '*.log': 'personal.log', '*.dll': 'program.dll', '*.exe': 'program.exe',
  'thumbs.db': 'windows.thumbsDb', 'desktop.ini': 'windows.desktopIni',
};
const fileCode = hit => ({ code: FILE_CODE[hit] });

/**
 * index_site.py is_personal as a code: rel below site/ghost or site/balloon ('<id>/…'); ghost: PERSONAL_PATHS too.
 * @returns {{code: string, params?: object}|null}
 */
export function personalCode(rel, ghost = false) {
  const parts = String(rel).toLowerCase().split('/');
  if (parts.slice(0, -1).some(d => PERSONAL_DIRS.includes(d))) return { code: 'personal.profile' };
  const hit = PERSONAL_FILES.find(p => fnmatchcase(parts[parts.length - 1], p));
  if (hit) return fileCode(hit);
  const pattern = ghost ? personalPattern(parts.slice(1).join('/')) : null;
  return pattern ? { code: 'personal.path', params: { pattern } } : null;
}

/** index_site.py is_personal. */
export const isPersonal = (rel, ghost = false) => personalCode(rel, ghost) !== null;

/**
 * Why add_ghost.py leaves a file out (skip_file), as a code, or null. rel: ghost-root-relative.
 * @returns {{code: string, params?: object}|null}
 */
export function skipCode(rel) {
  const name = String(rel).replace(/\\/g, '/').split('/').pop().toLowerCase();
  const hit = SKIP_FILES.find(p => fnmatchcase(name, p));
  if (hit) return fileCode(hit);
  const pattern = personalPattern(rel);
  return pattern ? { code: 'personal.path', params: { pattern } } : null;
}

/** add_ghost.py SKIP_DIRS: a folder never entered (any case). */
export const isSkipDir = name => PERSONAL_DIRS.includes(String(name).toLowerCase());

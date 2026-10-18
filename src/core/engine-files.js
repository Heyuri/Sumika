// Which of a ghost's files an engine's worker gets, for engines other than Satori (whose list is engineFileList in
// runtime.js). Page-safe: no engine imports, so the page bundle can use it.
// YAYA (yaya-wasm.md, MEMFS) and Kawari (kawari-wasm.md §6): the whole ghost root goes into an SSP-like MEMFS
// (src/worker/engines/ssproot.js), because scripts read and write beside ghost/master (../../updates2.dau,
// ../../shell/<id>/surface0.png, ../../notelog/, readdir ../../..). Text up to the pack's size cap comes with its
// bytes; every other file is an empty placeholder, so FOPEN/FSIZE/FENUM and isexist/isfile still see it.

export const YAYA_TEXT = /\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u)$/i;   // = index_site.py YAYA_PACK_EXT
// personal files (SSP's profile/, the engine's saves, logs: never on the site, skipped again here) and DLLs/EXEs
export const YAYA_SKIP = /(^|\/)profile\/|(^|\/)[^/]*_variable\.[^/]*$|\.log$|\.(dll|exe)$/i;
export const YAYA_MAX_BYTES = 4 * 1024 * 1024;     // = index_site.py PACK_MAX
// Kawari (kawari-wasm.md §6): YAYA's text plus its dictionaries (.kis, and .kaw for encrypted ones); every load target
// in the corpus is .kis or .txt [corpus]
export const KAWARI_TEXT = /\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u|kis|kaw)$/i;   // = index_site.py KAWARI_PACK_EXT
// Kawari 7 (kawari7-wasm.md §7): Kawari's set plus what Phase 7 ghosts name in kawari.ini's `dict` lines besides .txt:
// maria_re's .kdf, mayura's .dat (and its data/*.dat) [corpus]
export const KAWARI7_TEXT = /\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u|kis|kaw|kdf|dat)$/i;   // = index_site.py KAWARI7_PACK_EXT
// the personal set (profile/, *_variable.*, satori_save*: asri101's Satori emulator, *.log: sakura_r ships one) and
// DLLs/EXEs. A Kawari save has no fixed name (the ghost picks it): index_site.py's save-header net and add_ghost.py
// --archive keep those off the site [kawari-wasm.md §12]
export const KAWARI_SKIP = /(^|\/)profile\/|(^|\/)[^/]*_variable\.[^/]*$|(^|\/)satori_save[^/]*$|\.log$|\.(dll|exe)$/i;
// what a ghost may never send out (\![execute,http-*]'s --param-input-file, EV §4.15) [decision]: index_site.py's
// personal files (profile/, the engines' saves, logs), tested on the path as resolved inside ghost/master
const PERSONAL = /(^|\/)(profile\/|[^/]*_variable\.[^/]*$|satori_save[^/]*$|[^/]*\.log$)/i;

/**
 * The engines whose ghost runs in the SSP-shaped MEMFS (ssproot.js): the worker gets the whole ghost root by these
 * patterns, ghost-root-relative, and engineOpts {ghostId, placeholders, site} (YAYA adds its module). = index_site.py
 * ROOT_PACK_EXT's engines: their packs hold every file `text` names.
 */
export const ROOT_ENGINES = Object.freeze({
  yaya: Object.freeze({ text: YAYA_TEXT, skip: YAYA_SKIP }),
  kawari: Object.freeze({ text: KAWARI_TEXT, skip: KAWARI_SKIP }),
  kawari7: Object.freeze({ text: KAWARI7_TEXT, skip: KAWARI_SKIP }),
});

/** The root plan's patterns for an engine name (any case), or null for an engine that gets ghost/master's text only. */
export function rootEngine(engine) {
  const k = String(engine || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROOT_ENGINES, k) ? ROOT_ENGINES[k] : null;
}

/**
 * `rel` inside ghost/master as EmscriptenShiori.masterPath resolves it: `\` as `/`, empty and `.` segments dropped,
 * `..` resolved; null when it leaves the folder or names nothing.
 */
export function masterRel(rel) {
  const parts = [];
  for (const seg of String(rel ?? '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** A path a ghost may not read out (EV §4.15): a personal file once resolved, or nothing inside ghost/master. */
export function personalFile(rel) {
  const p = masterRel(rel);
  return p == null || PERSONAL.test(p);
}

/**
 * A path a ghost may not read out because the visitor's own run wrote it (kawari-wasm.md §12 [decision]):
 * a stored key with bytes (a save of any name, a rewritten shipped file, a download), for every engine.
 * Kawari saves have no fixed names, so personalFile cannot know them. Compared in any case, as Windows would.
 * @param {Record<string, ArrayBuffer|null>} stored the worker's stored files
 * @param {string} rel the path inside ghost/master as the ghost gave it
 * @param {string} prefix what the stored keys put before a ghost/master path ('ghost/master/' for a root engine's
 *   ghost-root-relative keys, '' for Satori's ghost/master-relative ones)
 */
export function visitorFile(stored, rel, prefix = '') {
  const p = masterRel(rel);
  if (p == null) return true;
  const want = (prefix + p).toLowerCase();
  return Object.entries(stored || {}).some(([k, v]) => !!v && k.toLowerCase() === want);
}

/**
 * @param {{files: {path: string, size?: number}[]}} files the ghost root's GhostFiles (its manifest, every file)
 * @param {{text: RegExp, skip: RegExp, max?: number}} o text: sent with bytes (within `max`); skip: never sent
 * @returns {{bytes: string[], placeholders: string[]}} ghost-root-relative paths, in manifest order
 */
export function rootFilePlan(files, { text, skip, max = YAYA_MAX_BYTES }) {
  const bytes = [];
  const placeholders = [];
  for (const f of (files && files.files) || []) {
    const p = f && f.path;
    if (!p || skip.test(p)) continue;
    if (text.test(p) && !(f.size > max)) bytes.push(p);
    else placeholders.push(p);
  }
  return { bytes, placeholders };
}

/** YAYA's root plan (YAYA_TEXT, YAYA_SKIP). */
export function yayaFilePlan(files) {
  return rootFilePlan(files, ROOT_ENGINES.yaya);
}

/** YAYA's module name (<module>.txt, <module>_variable.cfg): the index's `module`, else the stem of `shiori`. */
export function yayaModule(ghost) {
  const g = ghost || {};
  if (typeof g.module === 'string' && g.module.trim()) return g.module.trim();
  const stem = String(g.shiori || '').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]*$/, '').trim();
  return stem || 'yaya';
}

const line = v => String(v == null ? '' : v).replace(/[\r\n]/g, '');

/**
 * The site as an SSP install shows it to a root engine's ghost (`FENUM('..\..\..')`, `readdir ../../..`, other
 * ghosts' descript.txt, the balloon folder): plain JSON for the worker's engineOpts, one line per value.
 */
export function siteView(index) {
  const ghosts = ((index && index.ghosts) || []).filter(g => g && g.id).map(g => ({
    id: line(g.id), name: line(g.name), sakuraName: line(g.sakuraName), keroName: line(g.keroName),
    craftman: line(g.craftman), shiori: line(g.shiori),
  }));
  const balloons = ((index && index.balloons) || []).filter(b => b && b.id).map(b => line(b.id));
  return { ghosts, balloons };
}

/** siteView's first name (YAYA was the first root engine), kept for its callers. */
export const yayaSite = siteView;

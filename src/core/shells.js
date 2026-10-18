// Shell and balloon lists the way SSP orders, names and picks them (pure, no DOM): Shell ▸ / Balloon ▸ order, the
// default shell, the targets of \![change,shell|balloon,…], the balloons a ghost can wear and the one it boots with.
// BA §12 (name order, balloons), EV §2.6 (shell and balloon changes). tools/index_site.py sorts with the same rules.

// ---- names ------------------------------------------------------------------------------------------------------

/** SSP's case folding (ssp.exe's WORD table at 0xb77244) [disasm]: Unicode simple lower case, except À–Þ. */
function fold(c) {
  if (c < 0x100) return c >= 0x41 && c <= 0x5a ? c + 32 : c;
  if (c >= 0xd800 && c <= 0xdfff) return c;
  const l = String.fromCharCode(c).toLowerCase();
  return l.length === 1 ? l.charCodeAt(0) : c;
}

/** wcsicmpex's character key [disasm]: full-width ASCII (U+FF01–FF9F) shifted down by 0xFEE0, katakana → hiragana. */
function exKey(c) {
  if (c >= 0xff01 && c <= 0xff9f) c -= 0xfee0;
  else if (c >= 0x30a1 && c <= 0x30f4) c -= 0x60;
  return fold(c);
}

const isDigit = c => (c >= 0x30 && c <= 0x39) || (c >= 0xff10 && c <= 0xff19);
const digitValue = c => (c <= 0x39 ? c - 0x30 : c - 0xff10);

/**
 * SSP's name order for shells and balloons (`wcsicmpex`, BA §12.1) [disasm]: UTF-16 units compared case-insensitively
 * (full-width ASCII = ASCII, katakana = hiragana); where both strings have a digit (ASCII or full-width) the two digit
 * runs are compared as 32-bit numbers. SSP's quirk is kept: a run's first digit is not width-normalised, so a run that
 * starts with a full-width digit counts 65248 more per first digit than an ASCII one.
 * @param {string} a
 * @param {string} b
 * @returns {number} < 0, 0 or > 0
 */
export function compareNames(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    let ca = a.charCodeAt(i), cb = b.charCodeAt(j);
    if (isDigit(ca) && isDigit(cb)) {
      let na = (ca - 0x30) | 0, nb = (cb - 0x30) | 0;
      for (i++; i < a.length && isDigit(a.charCodeAt(i)); i++) na = (Math.imul(na, 10) + digitValue(a.charCodeAt(i))) | 0;
      for (j++; j < b.length && isDigit(b.charCodeAt(j)); j++) nb = (Math.imul(nb, 10) + digitValue(b.charCodeAt(j))) | 0;
      if (na !== nb) return na > nb ? 1 : -1;
      if (i >= a.length || j >= b.length) break;
      ca = a.charCodeAt(i);
      cb = b.charCodeAt(j);
    }
    const ka = exKey(ca), kb = exKey(cb);
    if (ka !== kb) return ka > kb ? 1 : -1;
    i++;
    j++;
  }
  if (i >= a.length && j >= b.length) return 0;
  return j < b.length ? -1 : 1;
}

/**
 * SSP's plain case-insensitive compare (`wcsicmp_custom`) [disasm]: the tie-break on folders after equal names, and
 * how `\![change,shell|balloon,NAME]` and the ghost descript's balloon keys match a name (`SPProp::FindFromName`).
 */
export function compareFolders(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ka = fold(a.charCodeAt(i)), kb = fold(b.charCodeAt(i));
    if (ka !== kb) return ka > kb ? 1 : -1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Equal for SSP's name lookups (compareFolders). */
export function sameName(a, b) {
  return a !== undefined && a !== null && b !== undefined && b !== null && compareFolders(a, b) === 0;
}

const nameOf = e => (e && e.name !== undefined && e.name !== null ? String(e.name) : String((e && e.id) ?? ''));

/** By name (compareNames), ties by folder id (compareFolders): SSP's `SPProp::operator<` [disasm]. */
export function compareEntries(x, y) {
  return compareNames(nameOf(x), nameOf(y)) || compareFolders(x && x.id, y && y.id);
}

// ---- shells -----------------------------------------------------------------------------------------------------

/**
 * Shell ▸ order (EV §2.6): a sorted copy.
 * @template {{id:string, name?:string}} T
 * @param {T[]} list
 * @returns {T[]}
 */
export function sortShells(list) {
  return [...(Array.isArray(list) ? list : [])].filter(Boolean).sort(compareEntries);
}

/** The shells Shell ▸ lists: a ghost index entry's `shells` without the `menu,hidden` ones, in menu order. */
export function visibleShells(ghost) {
  return sortShells(((ghost && ghost.shells) || []).filter(s => s && !s.hidden));
}

/** A shell's descript `name` (what SSP sends as "shell name"), else its folder id. */
export function shellName(ghost, id) {
  if (id === undefined || id === null) return '';
  const list = (ghost && ghost.shells) || [];
  const s = list.find(x => x && x.id === id) || list.find(x => x && sameName(x.id, id));
  return s && s.name !== undefined && s.name !== null && s.name !== '' ? String(s.name) : String(id);
}

function descriptGet(d, key) {
  if (!d) return undefined;
  if (typeof d.get === 'function') return d.get(key);
  return d[key];
}

/** A descript folder value ('shell\\x\\', './x/') as a bare folder path. */
function folderOf(v) {
  return String(v ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
}

/**
 * The shell a ghost boots when the visitor never picked one (EV §2.6) [disasm `GetDefaultShellID`]: the ghost
 * descript's `seriko.defaultsurfacedirectoryname` (a folder, any case; a path by its last folder [infer]), else folder
 * `master`, else `surface`, else the first shell in name order. Hidden shells count. No shell listed: the index's
 * `defaultShell`, else 'master'.
 * @param {{shells?: {id:string, name?:string}[], defaultShell?: string}} ghost  a ghosts.json entry
 * @param {Map<string,string>|object} [ghostDescript]
 * @returns {string}
 */
export function defaultShellId(ghost, ghostDescript) {
  const shells = sortShells((ghost && ghost.shells) || []);
  if (!shells.length) return (ghost && ghost.defaultShell) || 'master';
  const want = folderOf(descriptGet(ghostDescript, 'seriko.defaultsurfacedirectoryname'));
  for (const f of [want, want.slice(want.lastIndexOf('/') + 1), 'master', 'surface']) {
    const s = f && shells.find(x => sameName(x.id, f));
    if (s) return s.id;
  }
  return shells[0].id;
}

/**
 * The shell a Shell ▸ pick (byId) or `\![change,shell,TARGET]` names (EV §2.6) [disasm `ExecuteChangeFromTag`]:
 * `random` = one of the other shells, but only when at least 2 others exist (SSP returns otherwise); `sequential` = the
 * next other shell in menu order, wrapping, with the same guard [guess for the order: SSP's index arithmetic looks
 * like a bug]; `lastinstall…` = none (nothing is installed in a browser); else the descript `name`, case-insensitive,
 * first in menu order. Folder ids never match a name. The current shell's name gives the current shell (a reload).
 * @param {{id:string, name?:string}[]} shells  sorted (sortShells), hidden ones included
 * @param {string|null} currentId
 * @param {string} target
 * @param {{byId?: boolean, random?: () => number}} [o]
 */
export function resolveShellTarget(shells, currentId, target, { byId = false, random = Math.random } = {}) {
  const list = (Array.isArray(shells) ? shells : []).filter(Boolean);
  const t = String(target ?? '').trim();
  if (!t) return null;
  if (byId) return list.find(s => s.id === t) || list.find(s => sameName(s.id, t)) || null;
  const key = t.toLowerCase();
  if (key === 'random' || key === 'sequential') {
    const others = list.filter(s => !sameName(s.id, currentId));
    if (others.length < 2) return null;
    if (key === 'random') return others[Math.min(others.length - 1, Math.floor(random() * others.length))];
    return nextAfter(list, currentId);
  }
  if (key.startsWith('lastinstall')) return null;
  return list.find(s => sameName(nameOf(s), t)) || null;
}

/** The entry after the current one in list order, wrapping, never the current one; null when there is no other. */
function nextAfter(list, currentId) {
  const i = list.findIndex(e => sameName(e.id, currentId));
  for (let n = 1; n <= list.length; n++) {
    const e = list[(i + n + list.length) % list.length];
    if (!sameName(e.id, currentId)) return e;
  }
  return null;
}

// ---- balloons ---------------------------------------------------------------------------------------------------

/**
 * @typedef {{id:string, name:string, ghost?:string, thumbnails?:string[]}} BalloonEntry
 *   id: folder; ghost: the ghost that bundles it (served from ghost/<ghost>/<id>/), absent for a site balloon
 */

/** an index entry's `thumbnails` (site paths, Balloon ▸ / Shell ▸, UI §2.14), kept when there are any */
const thumbsOf = b => (b && Array.isArray(b.thumbnails) && b.thumbnails.length ? { thumbnails: b.thumbnails.map(String) } : {});

/**
 * Every balloon a ghost can wear (BA §1.6): the index's balloons (the site's and the bundled ones the indexer hoisted,
 * as SSP installs bundled balloons for every ghost) and the ghost's own bundled ones, one per folder id (any case),
 * in Balloon ▸ order. A ghost's own bundled balloon wins a folder id it shares with another [decision: it is what the
 * ghost was made with, and it loads from the ghost's own files].
 * @param {{balloons?: object[]}} index  SiteIndex or ghosts.json
 * @param {{id?:string, bundledBalloons?: {dir:string, name?:string}[]}} [ghost]
 * @returns {BalloonEntry[]}
 */
export function installedBalloons(index, ghost) {
  const byKey = new Map();
  for (const b of (index && index.balloons) || []) {
    if (!b || !b.id) continue;
    const k = String(b.id).toLowerCase();
    if (byKey.has(k)) continue;
    byKey.set(k, { id: String(b.id), name: nameOf(b), ...(b.ghost ? { ghost: String(b.ghost) } : {}), ...thumbsOf(b) });
  }
  for (const b of (ghost && ghost.bundledBalloons) || []) {
    const id = b && (b.dir || b.id);
    if (!id) continue;
    const e = { id: String(id), name: b.name !== undefined && b.name !== null && b.name !== '' ? String(b.name) : String(id), ...thumbsOf(b) };
    if (ghost.id) e.ghost = String(ghost.id);
    byKey.set(String(id).toLowerCase(), e);
  }
  return [...byKey.values()].sort(compareEntries);
}

/** A balloon by folder id (exact, then any case), else by descript name (exact, then any case). */
export function findBalloon(list, key) {
  const k = String(key ?? '').trim();
  if (!k || !Array.isArray(list)) return null;
  return list.find(b => b.id === k) || list.find(b => sameName(b.id, k))
    || list.find(b => b.name === k) || list.find(b => sameName(b.name, k)) || null;
}

/**
 * The ghost descript's own balloons, in SSP's order (`SPGhostProp::GetDefaultBalloon`) [disasm]:
 * `recommended.balloon.path` (folder), `recommended.balloon` (name), `default.balloon.path` (folder), `balloon` (name).
 * @param {Map<string,string>|object} [ghostDescript]
 * @returns {({path:string}|{name:string})[]}
 */
export function ghostBalloonKeys(ghostDescript) {
  const out = [];
  for (const [key, kind] of [['recommended.balloon.path', 'path'], ['recommended.balloon', 'name'], ['default.balloon.path', 'path'], ['balloon', 'name']]) {
    const v = String(descriptGet(ghostDescript, key) ?? '').trim();
    if (v) out.push(kind === 'path' ? { path: v } : { name: v });
  }
  return out;
}

/**
 * One key of ghostBalloonKeys / bootBalloonKeys against the list: {path} = a folder (any case; a relative path also by
 * its last folder), {name} = a descript name (any case, first in list order), {key} = findBalloon (id, then name).
 * @returns {BalloonEntry|null}
 */
export function resolveBalloonKey(list, k) {
  if (!k || !Array.isArray(list)) return null;
  if (k.path !== undefined) {
    const p = folderOf(k.path);
    if (!p) return null;
    const last = p.slice(p.lastIndexOf('/') + 1);
    return list.find(b => sameName(b.id, p)) || list.find(b => sameName(b.id, last)) || null;
  }
  if (k.name !== undefined) return String(k.name).trim() ? list.find(b => sameName(b.name, String(k.name).trim())) || null : null;
  if (k.key !== undefined) return findBalloon(list, k.key);
  return null;
}

/**
 * Balloon ▸ (BA §12.1) [disasm `InitBalloonMenu`]: `top` = the ghost's own balloons (ghostBalloonKeys resolved, each
 * once; the menu puts a separator after them when there are any), `all` = every installed balloon in name order (a top
 * balloon appears twice). `current` marks only the first row of the balloon in use [infer: Win32 MF_BYCOMMAND checks
 * the first item with that id]. Names are the descript's, uncut (the menu cuts them).
 * @param {BalloonEntry[]} list  installedBalloons()
 * @param {({path:string}|{name:string})[]} keys  ghostBalloonKeys()
 * @param {string|null} currentId
 * @returns {{top: {id:string, name:string, current:boolean}[], all: {id:string, name:string, current:boolean}[]}}
 */
export function balloonMenu(list, keys, currentId) {
  const all = Array.isArray(list) ? list : [];
  const top = [];
  for (const k of keys || []) {
    const e = resolveBalloonKey(all, k);
    if (e && !top.includes(e)) top.push(e);
  }
  let marked = false;
  const row = e => {
    const current = !marked && sameName(e.id, currentId);
    if (current) marked = true;
    return { id: e.id, name: e.name, current, ...thumbsOf(e) };
  };
  return { top: top.map(row), all: all.map(row) };
}

/**
 * The balloon a Balloon ▸ pick (byId) or `\![change,balloon,TARGET]` names (BA §12.2) [disasm `ExecuteChangeFromTag`]:
 * `random` = any other balloon (none: null); `sequential` = the next other balloon in menu order, wrapping [guess: SSP's
 * code keeps the last one]; `lastinstall…` = none; else the descript `name`, case-insensitive, first in menu order.
 * Folder ids never match a name. The current balloon's name gives the current balloon (a reload).
 * @param {BalloonEntry[]} list  installedBalloons()
 * @param {string|null} currentId
 * @param {string} target
 * @param {{byId?: boolean, random?: () => number}} [o]
 * @returns {BalloonEntry|null}
 */
export function resolveBalloonTarget(list, currentId, target, { byId = false, random = Math.random } = {}) {
  const all = (Array.isArray(list) ? list : []).filter(Boolean);
  const t = String(target ?? '').trim();
  if (!t) return null;
  if (byId) return all.find(b => b.id === t) || all.find(b => sameName(b.id, t)) || null;
  const key = t.toLowerCase();
  if (key === 'random') {
    const others = all.filter(b => !sameName(b.id, currentId));
    return others.length ? others[Math.min(others.length - 1, Math.floor(random() * others.length))] : null;
  }
  if (key === 'sequential') return nextAfter(all, currentId);
  if (key.startsWith('lastinstall')) return null;
  return all.find(b => sameName(b.name, t)) || null;
}

/**
 * Which balloon boots (BA §1.6) [disasm `GetBalloonIDFromSetting`], rules (1)–(4); the caller resolves them in order
 * (bootBalloon), then falls back to the site default and the built-in balloon:
 * (1) the current shell's remembered balloon, (2) the ghost's stored choice (a folder id; old states: a descript name),
 * (3) the ghost descript's balloon keys (ghostBalloonKeys), (4) install.txt `balloon.directory` (the index's `balloon`).
 * @param {{shellBalloon?: string|null, choice?: string|null, ghostDescript?: Map<string,string>|object,
 *          ghost?: {balloon?: string|null}}} o
 * @returns {({key:string}|{path:string}|{name:string}) & {from: 'shell'|'choice'|'descript'|'install'})[]}
 */
export function bootBalloonKeys({ shellBalloon = null, choice = null, ghostDescript = null, ghost = null } = {}) {
  const keys = [];
  if (shellBalloon) keys.push({ key: String(shellBalloon), from: 'shell' });
  if (choice) keys.push({ key: String(choice), from: 'choice' });
  for (const k of ghostBalloonKeys(ghostDescript)) keys.push({ ...k, from: 'descript' });
  if (ghost && ghost.balloon) keys.push({ key: String(ghost.balloon), from: 'install' });
  return keys;
}

/**
 * The first key that names an installed balloon.
 * @returns {{entry: BalloonEntry, from: string}|null}
 */
export function bootBalloon(list, keys) {
  for (const k of keys || []) {
    const entry = resolveBalloonKey(list, k);
    if (entry) return { entry, from: k.from || '' };
  }
  return null;
}

// The ghost's tray icon (ssp-ui.md §2.6). ssp.exe shows a minimized ghost as her notification-area icon; Sumika's
// stand-in is the launcher button's image. Pure: the descript's icon names, finding them in a ghost's files as
// SPGhost::GetIconName / GetIconMinimizeName do, \![set,trayicon]'s names, and which icon the launcher shows. No DOM,
// no imports. tools/index_site.py (descript_last, icon_rel, find_icon) records the descript's icons in ghosts.json
// with the same rule, and tools/sweep/views.mjs ghostEntry uses ghostIcons (tests/runtime/sweep_views.test.mjs).

/**
 * An icon name as a ghost-root-relative path: `\` as `/`, empty and `.` segments dropped, `..` going up. null when it
 * would leave the ghost folder or names a drive (`:`): a site serves the ghost folder only [decision].
 * @param {unknown} name  @param {string} [base] the folder it is relative to ('' = the ghost root, or 'ghost/master/')
 * @returns {string|null}
 */
export function iconRel(name, base = '') {
  const s = name == null ? '' : String(name);
  if (!s || s.includes(':')) return null;
  const out = [];
  for (const seg of `${base}/${s}`.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/** files' real spelling of a ghost-root-relative path, any case (GhostFiles.resolve, else a scan of list('')). */
function realPath(files, rel) {
  if (typeof files.resolve === 'function') return files.resolve(rel) || null;
  if (typeof files.list !== 'function') return null;
  const want = rel.toLowerCase();
  return files.list('').find(p => String(p).toLowerCase() === want) || null;
}

/**
 * Where ssp.exe finds an icon file: the ghost root + name, then ghost\master\ + name, the first that exists (any
 * case, as on Windows) [disasm SPGhost::GetIconName 0x6373c0, GetIconMinimizeName 0x6375f0, SetTrayIconName
 * 0x61f160]. Numbered frames (`icon1.ico`…, which SPGhostProp::IsIconFileExist 0x6c4b60 also accepts) are not followed
 * [decision, known gap].
 * @param {{resolve?(p:string):string|null, list?(prefix:string):string[]}|null} files the ghost root
 * @param {unknown} name
 * @returns {string|null} its real ghost-root-relative path
 */
export function findIcon(files, name) {
  if (!files) return null;
  for (const base of ['', 'ghost/master/']) {
    const rel = iconRel(name, base);
    const real = rel ? realPath(files, rel) : null;
    if (real) return real;
  }
  return null;
}

/**
 * The descript's icon names as ssp.exe reads them [disasm LoadDescript 0x6246ad]: `icon` and `iconfilename` set the
 * same field and `icon.minimize` its own; keys in any case, and every line assigns, so the last one wins (not the
 * first, as parseDescript keeps). No `icon` (or an empty one) is `icon.ico` [disasm GetIconName 0x637423]; no
 * `icon.minimize` is '' (none) [disasm GetIconMinimizeName 0x637652].
 * @param {string} text ghost/master/descript.txt, decoded
 * @returns {{icon: string, iconMinimize: string}}
 */
export function descriptIcons(text) {
  let icon = '';
  let iconMinimize = '';
  for (let line of String(text || '').split(/\r\n|\r|\n/)) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    const i = line.indexOf(',');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (k === 'icon' || k === 'iconfilename') icon = line.slice(i + 1).trim();
    else if (k === 'icon.minimize') iconMinimize = line.slice(i + 1).trim();
  }
  return { icon: icon || 'icon.ico', iconMinimize };
}

/**
 * A ghost's icons as ghosts.json records them (site paths, 'ghost/<id>/<real path>'): `icon` (GetIconName's file)
 * and `iconMinimize` (GetIconMinimizeName's), each only when its file exists.
 * @param {object} files the ghost root (findIcon)  @param {string} descriptText  @param {string} gid
 * @returns {{icon?: string, iconMinimize?: string}}
 */
export function ghostIcons(files, descriptText, gid) {
  const { icon, iconMinimize } = descriptIcons(descriptText);
  const out = {};
  const a = findIcon(files, icon);
  if (a) out.icon = `ghost/${gid}/${a}`;
  const m = iconMinimize ? findIcon(files, iconMinimize) : null;
  if (m) out.iconMinimize = `ghost/${gid}/${m}`;
  return out;
}

/**
 * \![set,NAME] is the tray icon: ssp.exe's \![set] table matches `trayi` and `tasktrayi` as prefixes, any case
 * (entry flag 2) [disasm table 0xbbc710, id 0x6d]; `trayb…` / `tasktrayb…` are the tray balloon (0x6c), not this.
 */
export function isTrayIconTag(name) {
  return /^(trayi|tasktrayi)/.test(String(name || '').toLowerCase());
}

/**
 * The icon the launcher shows, as a site path, or null (none: SSP's own icon, Sumika's initial letter). Minimized:
 * `iconMinimize`, else the icon shown before she minimized (a script's \![set,trayicon] one, `minimized.icon`, a
 * ghost-root-relative path), else her `icon` [disasm LoadTrayIcon 0x49e56e–0x49e614]. Closed: her `icon` (SSP has no
 * closed state: her normal tray icon [decision]).
 * @param {{id?: string, icon?: string, iconMinimize?: string}} g the ghosts.json entry
 * @param {'minimized'|'closed'} mode
 * @param {{icon?: string}|null} [minimized] the loop's (or the stored state's) `minimized`
 * @returns {string|null}
 */
export function launcherIconPath(g, mode, minimized = null) {
  const entry = g || {};
  const own = typeof entry.icon === 'string' && entry.icon ? entry.icon : null;
  if (mode !== 'minimized') return own;
  if (typeof entry.iconMinimize === 'string' && entry.iconMinimize) return entry.iconMinimize;
  const shown = minimized && typeof minimized.icon === 'string' && minimized.icon ? minimized.icon : null;
  if (shown && entry.id) return `ghost/${entry.id}/${shown}`;
  return own;
}

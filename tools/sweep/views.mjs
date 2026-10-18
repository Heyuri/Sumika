// The sweep's (tools/sweep/ghost.mjs) stand-ins for what the site and the runtime do around a ghost's shells and
// balloons: the ghosts.json entry with tools/index_site.py's rules (its engine too: detectEngine), and a view switcher
// like Runtime._requestView, so a ghost's own \![change,shell|balloon] goes down the event loop's real path (EV §2.6,
// BA §12): shellChanging, detachStage, attachStage and shellChanged for a shell; setBalloonInfo and balloonChanged for
// a balloon. No DOM.
import { parseDescript } from '../../src/core/loader.js';
import {
  sortShells, defaultShellId, shellName, sameName, resolveShellTarget, installedBalloons, resolveBalloonTarget,
} from '../../src/core/shells.js';
import { chooseBalloon, swapStageState, withShellBinds, shellMemory, MAX_CHAINED_CHANGES } from '../../src/core/runtime.js';
import { ghostIcons } from '../../src/core/trayicon.js';

/**
 * Shell ▸'s shells as tools/index_site.py shell_entries() lists them [disasm SPGhostBase::EnumShells]: every
 * shell/<dir>/ with a descript.txt (no `name`: 'default'; `menu` containing 'hid': hidden), plus master/ or surface/
 * without one ('Default'), in SSP's name order (sortShells). A folder spelt in two cases counts once (its first spelling).
 * @param {{list(prefix:string):string[], text(path:string):Promise<string>}} files  the ghost root
 * @returns {Promise<{id:string, name:string, hidden?:true}[]>}
 */
export async function shellEntries(files) {
  const dirs = new Map();              // lower-case folder -> {id, descript}
  for (const p of files.list('shell')) {
    const m = /^shell\/([^/]+)\/(.+)$/i.exec(p);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (!dirs.has(k)) dirs.set(k, { id: m[1], descript: null });
    if (/^descript\.txt$/i.test(m[2])) dirs.get(k).descript = p;
  }
  const shells = [];
  for (const { id, descript } of dirs.values()) {
    if (descript) {
      const sd = parseDescript(await files.text(descript));
      const e = { id, name: sd.get('name') || 'default' };
      if ((sd.get('menu') || '').toLowerCase().includes('hid')) e.hidden = true;
      shells.push(e);
    } else if (/^(master|surface)$/i.test(id)) shells.push({ id, name: 'Default' });
  }
  return sortShells(shells);
}

// ---------------------------------------------------------------- the engine (tools/index_site.py detect_engine)
//
// The engine is the lower-cased stem of descript's `shiori` DLL (a missing line counts as shiori.dll), except for the
// AYA family: the site never has the DLL, so its config ghost/master/<stem>.txt decides. A listed dictionary that
// defines `request` is AYA5 / YAYA (engine 'yaya', and `module` = the stem: YAYA reads <module>.txt and saves
// <module>_variable.cfg); one that defines only `OnRequest` is AYA4 ('aya'); yaya.dll / aya5.dll with dictionaries
// that define neither (`request` in an encrypted .ayc) are 'yaya' too. Then Kawari by its files (kawariPhase). Keep it
// in step with index_site.py (tests/runtime/sweep_views.test.mjs checks every site ghost's entry against ghosts.json).

const NOT_AYA = ['satori', 'lang_switch', 'gcore'];      // whatever <stem>.txt holds (the proxies: sweepEngine)
// Kawari (index_site.py KAWARI_STEMS; kawari-wasm.md §12 [decision]): after the AYA probe, for these stems (shiori: a
// missing line too): ghost/master/kawarirc.kis (any case), the only file Phase 8 loads, is 'kawari'; else
// ghost/master/kawari.ini (Phase 7, SHIORI/2.x) or a kawari* stem is 'kawari7' (nothing 8.2.8 could load); else the
// stem. Other stems keep their name (snow girl: satori.dll, Kawari only as a SAORI).
const KAWARI_STEMS = ['shiori', 'kawari', 'kawari8', 'kawarirc'];
const CONFIG_DEPTH = 8;
const SPACE = /^[ \t\u3000]+|[ \t\u3000]+$/g;             // YAYA's IsSpace
const trim = s => s.replace(SPACE, '');
const lines = text => text.split(/\r\n|\r|\n/);
const folderOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const hasBom = u8 => u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf;

const dllStem = name => name.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]*$/, '');

/** descript's `shiori` DLL without folder and extension, case kept ('shiori' without a line) */
export function shioriStem(descript) {
  return dllStem(descript.get('shiori') || 'shiori.dll');
}

/** `\` as `/`, `.` and `..` resolved; null when the path leaves the ghost root */
function rootPath(p) {
  const out = [];
  for (const s of p.replace(/\\/g, '/').split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out.join('/');
}

/** tok's index outside '…' and "…" (YAYA's Find_IgnoreDQ), or -1 */
function findCode(s, tok) {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; } else if (s.startsWith(tok, i)) return i;
    else if (c === '"' || c === '\'') q = c;
  }
  return -1;
}

/** One line without comments, as YAYA's CComment (index_site.py _code): [code, still inside a block comment]. */
function codeOf(line, block) {
  if (line.replace(/^[ \t]+/, '').startsWith('//')) return ['', block];
  for (;;) {
    if (block) {
      const j = line.indexOf('*/');
      if (j < 0) return ['', true];
      line = line.slice(j + 2);
      block = false;
    } else {
      const i = findCode(line, '/*');
      if (i < 0) break;
      const j = line.indexOf('*/', i + 2);
      if (j < 0) { line = line.slice(0, i); block = true; break; }
      line = line.slice(0, i) + line.slice(j + 2);
    }
  }
  const i = findCode(line, '//');
  return [i < 0 ? line : line.slice(0, i), block];
}

/** Bytes as Latin-1 (one char per byte, as Python's 'latin-1'; TextDecoder's 'latin1' is windows-1252). */
function latin1(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
}

const readU8 = async (files, p) => new Uint8Array(await files.bytes(p));

/**
 * The dictionaries ghost/master/<module>.txt lists, as YAYA's config reader finds them (index_site.py config_dics,
 * CBasis::SetParameter): `dic` (missing files too) and `dicif` (only existing ones) relative to the current folder,
 * `include` read in place, `includeEX` with its own folder as the current one, `dicdir` every file below a folder
 * except *.bak / *.tmp (or its _loading_order[_override].txt, read as an includeEX). Keys in any case, at most
 * CONFIG_DEPTH levels, each config read once. A config is UTF-8 with a BOM, else Shift_JIS (ASCII outside comments);
 * `files.decodeConfig(u8)`, when given, decodes it instead (the admin core: index_site.py's cp932, byte for byte).
 * @param {{list(prefix?:string):string[], bytes(path:string):Promise<ArrayBuffer>,
 *   decodeConfig?(u8: Uint8Array): string}} files  the ghost root
 * @param {string} module
 * @returns {Promise<string[]>} ghost-root-relative paths ([] when there is no such config)
 */
export async function configDics(files, module) {
  const paths = files.list('');
  const byLower = new Map(paths.map(p => [p.toLowerCase(), p]));
  const seen = new Set();
  const dics = [];
  const dicdir = async (folder, cs, depth) => {
    if (depth > CONFIG_DEPTH) return;
    if (!cs) {
      for (const name of ['_loading_order_override.txt', '_loading_order.txt']) {
        const order = byLower.get(`${folder}/${name}`.toLowerCase());
        if (order) { await walk(order, folder, depth + 1); return; }
      }
    }
    const pre = folder.toLowerCase() + '/';
    const subs = [];
    for (const p of paths) {
      if (!p.toLowerCase().startsWith(pre)) continue;
      const rest = p.slice(pre.length);
      const first = rest.split('/')[0];
      if (first.includes('.') && ['bak', 'tmp'].includes(first.slice(first.lastIndexOf('.') + 1))) continue;
      if (rest.includes('/')) { if (!subs.includes(first)) subs.push(first); } else dics.push(p);
    }
    for (const s of subs) await dicdir(`${folder}/${s}`, cs, depth + 1);
  };
  const walk = async (real, base, depth) => {
    if (depth > CONFIG_DEPTH || seen.has(real.toLowerCase())) return;
    seen.add(real.toLowerCase());
    const u8 = await readU8(files, real);
    const text = typeof files.decodeConfig === 'function' ? files.decodeConfig(u8)
      : hasBom(u8) ? new TextDecoder('utf-8').decode(u8.subarray(3)) : new TextDecoder('shift_jis').decode(u8);
    let block = false;
    for (const raw of lines(text)) {
      let line;
      [line, block] = codeOf(raw, block);
      const c = line.indexOf(',');
      if (c < 0) continue;
      const key = trim(line.slice(0, c)).toLowerCase();
      const param = line.slice(c + 1);
      const c2 = param.indexOf(',');
      const path = c2 < 0 ? param : param.slice(0, c2);
      const cs = c2 < 0 ? '' : param.slice(c2 + 1);
      const target = rootPath(`${base}/${trim(path)}`);
      if (!target) continue;
      const found = byLower.get(target.toLowerCase());
      if (key === 'include' || key === 'includeex') {
        if (found) await walk(found, key === 'include' ? base : folderOf(found), depth + 1);
      } else if (key === 'dic' || (key === 'dicif' && found)) dics.push(found || target);
      else if (key === 'dicdir') await dicdir(target, trim(cs), depth + 1);
    }
  };
  const config = byLower.get(`ghost/master/${module}.txt`.toLowerCase());
  if (config) await walk(config, 'ghost/master', 0);
  return dics;
}

/** a top-level-looking `NAME`, `NAME : option…` or `NAME {…` line outside comments (case-sensitive) */
export function defines(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = new RegExp(`^[ \\t]*${esc}[ \\t]*(?::[ \\t]*[A-Za-z0-9_]+[ \\t]*)*(?:\\{.*)?$`);
  let block = false;
  for (const raw of lines(text)) {
    let line;
    [line, block] = codeOf(raw, block);
    if (pat.test(line)) return true;
  }
  return false;
}

/**
 * 'yaya' when a dictionary ghost/master/<module>.txt lists defines `request` (AYA5 / YAYA), 'aya' when one defines
 * `OnRequest` and none `request` (AYA4), 'unknown' when its dictionaries define neither (encrypted .ayc are not read),
 * null when there is no such config or it lists no dictionary (index_site.py aya_config_kind). Dictionaries are read
 * byte for byte (Latin-1): the names are ASCII, and Shift_JIS trail bytes are never a quote, `/` or `*`.
 * @param {{list(prefix?:string):string[], bytes(path:string):Promise<ArrayBuffer>}} files  the ghost root
 * @param {string} module
 * @returns {Promise<'yaya'|'aya'|'unknown'|null>}
 */
export async function ayaConfigKind(files, module) {
  const dics = await configDics(files, module);
  if (!dics.length) return null;
  const byLower = new Map(files.list('').map(p => [p.toLowerCase(), p]));
  let aya = false;
  for (const p of new Set(dics.map(d => d.toLowerCase()))) {
    const real = byLower.get(p);
    if (real === undefined || p.endsWith('.ayc')) continue;
    const u8 = await readU8(files, real);
    const text = latin1(hasBom(u8) ? u8.subarray(3) : u8);
    if (defines(text, 'request')) return 'yaya';
    aya = aya || defines(text, 'OnRequest');
  }
  return aya ? 'aya' : 'unknown';
}

/**
 * 'kawari', 'kawari7' or null for a ghost root and its lower-cased shiori stem (index_site.py kawari_phase).
 * @param {{list(prefix?:string):string[]}} files
 * @param {string} base
 * @returns {'kawari'|'kawari7'|null}
 */
function kawariPhase(files, base) {
  if (!KAWARI_STEMS.includes(base)) return null;
  const low = new Set(files.list('ghost/master').map(p => p.replace(/\\/g, '/').toLowerCase()));
  if (low.has('ghost/master/kawarirc.kis')) return 'kawari';
  if (low.has('ghost/master/kawari.ini') || base !== 'shiori') return 'kawari7';
  return null;
}

/**
 * The engine a ghost needs, by the index's rule (index_site.py detect_engine): `module` only for 'yaya'.
 * @param {{list(prefix?:string):string[], bytes(path:string):Promise<ArrayBuffer>}} files  the ghost root (paths in
 *   any case)
 * @param {Map<string,string>} descript  ghost/master/descript.txt (parseDescript)
 * @returns {Promise<{engine: string, module?: string}>}
 */
export async function detectEngine(files, descript) {
  const stem = shioriStem(descript);
  const base = stem.toLowerCase();
  if (!NOT_AYA.includes(base)) {
    const kind = await ayaConfigKind(files, stem);
    if (kind === 'yaya' || (kind === 'unknown' && ['yaya', 'aya5'].includes(base))) return { engine: 'yaya', module: stem };
    if (kind === 'aya') return { engine: 'aya' };
  }
  return { engine: kawariPhase(files, base) || base };
}

/**
 * The engine the sweep runs a ghost with (tools/sweep.mjs and tools/sweep/ghost.mjs): detectEngine (`by:
 * 'descript'`) when it names Satori, YAYA or Kawari (kawarirc.kis decides before a satori.dll beside it [decision]);
 * else, without a `shiori` line, a satori.dll among `dlls` (`by: 'dll'`; the index, which never sees DLLs, says
 * `shiori`); else a proxy's AYA5 / YAYA module when its config defines
 * `request` (`by: 'override'`): lang_switch's DLL for Japanese in lang_switch_descript.txt (else its first), gcore's
 * `aishiori`. Else detectEngine's answer. The site never runs the last two (no DLLs; the proxies' own tags are not
 * supported).
 * @param {{list(prefix?:string):string[], bytes(path:string):Promise<ArrayBuffer>}} files  the ghost root
 * @param {Map<string,string>} descript
 * @param {string[]} [dlls]  base names of the DLLs in ghost/master
 * @returns {Promise<{engine: string, module?: string, by: 'descript'|'dll'|'override'}>}
 */
export async function sweepEngine(files, descript, dlls = []) {
  const found = await detectEngine(files, descript);
  if (['satori', 'yaya', 'kawari', 'kawari7'].includes(found.engine)) return { ...found, by: 'descript' };
  if (!descript.get('shiori') && dlls.some(n => String(n).toLowerCase() === 'satori.dll')) {
    return { engine: 'satori', by: 'dll' };
  }
  const base = shioriStem(descript).toLowerCase();
  let dll = '';
  if (base === 'lang_switch') {
    const p = files.list('ghost/master').find(x => /^ghost\/master\/lang_switch_descript\.txt$/i.test(x));
    if (p) {
      const u8 = await readU8(files, p);
      const langs = parseDescript(new TextDecoder(hasBom(u8) ? 'utf-8' : 'shift_jis').decode(hasBom(u8) ? u8.subarray(3) : u8));
      dll = langs.get('japanese') || [...langs.values()][0] || '';
    }
  } else if (base === 'gcore') dll = descript.get('aishiori') || '';
  const module = dllStem(dll);
  if (module && await ayaConfigKind(files, module) === 'yaya') return { engine: 'yaya', module, by: 'override' };
  return { ...found, by: 'descript' };
}

/**
 * The ghosts.json entry for a ghost folder held in memory, as tools/index_site.py ghost_entry() makes it: `engine`
 * (and YAYA's `module`) by detectEngine, shells by shellEntries, `defaultShell` by defaultShellId
 * (seriko.defaultsurfacedirectoryname, master, surface, the first by name; what the runtime boots for a visitor who
 * never picked a shell), bundled balloons, install.txt's balloon, the tray icons `icon` / `iconMinimize` (ghostIcons:
 * index_site.py ghost_icons, ssp-ui.md §2.6).
 * @param {{list(prefix:string):string[], has(path:string):boolean, text(path:string):Promise<string>,
 *   bytes(path:string):Promise<ArrayBuffer>}} files
 * @param {string} id
 * @returns {Promise<{entry: object, descript: Map<string,string>}>}
 */
export async function ghostEntry(files, id) {
  const descriptText = await files.text('ghost/master/descript.txt');
  const d = parseDescript(descriptText);
  const inst = files.has('install.txt') ? parseDescript(await files.text('install.txt')) : new Map();
  const shells = await shellEntries(files);
  const top = new Set(files.list('').map(p => p.split('/')[0]));
  const bundled = [];
  for (const b of [...top].sort()) {
    if (/^(ghost|shell)$/i.test(b) || !files.list(b).length) continue;
    const bd = files.has(`${b}/descript.txt`) ? parseDescript(await files.text(`${b}/descript.txt`)) : new Map();
    if ((bd.get('type') || '').toLowerCase() === 'balloon' || files.has(`${b}/balloons0.png`)) bundled.push({ dir: b, name: bd.get('name') || b });
  }
  let preferred = null;
  if (inst.get('balloon.directory') && bundled.some(b => b.dir === inst.get('balloon.directory'))) preferred = inst.get('balloon.directory');
  else if (bundled.length) preferred = bundled[0].dir;
  const shiori = d.get('shiori') || 'shiori.dll';
  const { engine, module } = await detectEngine(files, d);
  return {
    entry: {
      id, name: d.get('name') || id, sakuraName: d.get('sakura.name') || '', keroName: d.get('kero.name') || '',
      craftman: d.get('craftmanw') || d.get('craftman') || '', shiori, engine, ...(module !== undefined ? { module } : {}),
      ...ghostIcons(files, descriptText, id),
      shells, defaultShell: shells.length ? defaultShellId({ shells }, d) : null,
      bundledBalloons: bundled, balloon: preferred || d.get('balloon') || null,
    },
    descript: d,
  };
}

/** Site-absolute folder of a balloon entry (EV §2.1 "Paths"): a bundled one under its ghost, else the site's. */
export function balloonPath(entry) {
  if (!entry) return '';
  return entry.ghost ? `/ghost/${entry.ghost}/${entry.id}/` : `/balloon/${entry.id}/`;
}

/**
 * A loop.viewSwitcher for the sweep, after Runtime._requestView / _swapShell / _swapBalloon (EV §2.6, BA §12):
 * - one change slot; a menu or page request while it is held is refused; a script's waits for it (_chainChange), at
 *   most MAX_CHAINED_CHANGES in a row, and is refused while the slot's change waits for OnShellChanging's talk;
 * - a shell: resolveShellTarget over every shell, with raise-event loop.shellChanging first (not ok: nothing), then
 *   loop.detachStage(), the old shell's dress-up into the per-shell memory, createStage(swapStageState(...)),
 *   balloons / dialogs / loop.attachStage on the new stage, the old one destroyed, the balloon this shell boots with
 *   silently (chooseBalloon), loop.shellChanged({surfaces, event: true, defer: a script's change without raise-event});
 *   a stage that fails to load puts the old one back;
 * - a balloon: resolveBalloonTarget over installedBalloons, loadSkin, balloons / dialogs re-skinned,
 *   loop.setBalloonInfo, loop.balloonChanged({defer: from a script}); the choice and the shell's balloon remembered;
 * - a reload (req.reload: \![reload,shell|balloon], \![reloadsurface]; EV §2.10): the shell or balloon in use, as above
 *   with event false (Runtime._changeShell / _changeBalloon's reload).
 * @param {object} o
 * @param {object} o.loop  EventLoop
 * @param {object} o.ghost  ghostEntry().entry
 * @param {Map<string,string>} [o.ghostDescript]
 * @param {{balloons?: object[], defaultBalloon?: string}} o.site
 * @param {object} o.stage  the stage in use
 * @param {(shellId: string, state: object, old: object) => Promise<object>} o.createStage
 * @param {(entry: object) => Promise<object|null>} o.loadSkin  a BalloonSkin for an installedBalloons() entry
 * @param {object} [o.balloons]  Balloons (setStage, setSkin)
 * @param {object} [o.dialogs]  setStage / setSkin when it has them
 * @param {object|null} [o.balloon]  the balloon entry in use
 * @param {(stage: object) => void} [o.onStage]  the new stage, before anything uses it
 * @param {(skin: object, entry: object) => void} [o.onSkin]
 * @param {(change: object) => void} [o.note]  every request: {kind, target, fromScript, raiseEvent, reload?, result, from,
 *   to}
 * @returns {{request: (req: object) => Promise<boolean>, state: object}}
 */
export function viewSwitcher({ loop, ghost, ghostDescript = null, site, stage, createStage, loadSkin, balloons = null,
  dialogs = null, balloon = null, onStage = null, onSkin = null, note = () => {} }) {
  const sw = { stage, balloon, choice: null, shells: {}, slot: null, chained: 0, waiting: 0, waitingTalk: false };
  const shellRef = sid => ({ id: sid, name: shellName(ghost, sid), path: `/ghost/${ghost.id}/shell/${sid}/` });
  const call = (o, name, ...a) => { if (o && typeof o[name] === 'function') o[name](...a); };

  const swapBalloon = async (entry, { event = true, defer = false, silent = false } = {}) => {
    const skin = await loadSkin(entry);
    if (!skin) return false;
    call(balloons, 'setSkin', skin);
    call(dialogs, 'setSkin', skin);
    sw.balloon = entry;
    if (onSkin) onSkin(skin, entry);
    if (!silent) {
      sw.choice = entry.id;
      const sid = sw.stage.shellId;
      const mem = shellMemory(sw.shells, sid);
      sw.shells = { ...sw.shells, [sid]: { ...(mem || {}), balloon: entry.id } };
    }
    loop.setBalloonInfo({ name: entry.name || entry.id, path: balloonPath(entry) });
    if (!silent) await loop.balloonChanged({ event, defer });
    return true;
  };

  // reload: \![reload,shell] / \![reloadsurface] (EV §2.10): the shell in use again, no OnShellChanging or OnShellChanged
  const changeShell = async ({ target, byId = false, raiseEvent = false, fromScript = false, scope = 0, reload = false }) => {
    const cur = sw.stage.shellId;
    const next = reload ? sortShells(ghost.shells || []).find(s => sameName(s.id, cur)) || { id: cur }
      : resolveShellTarget(sortShells(ghost.shells || []), cur, target, { byId });
    if (!next) return 'no such shell';
    if (raiseEvent) {
      sw.waitingTalk = true;
      let r;
      try { r = await loop.shellChanging(shellRef(next.id), { scope }); } finally { sw.waitingTalk = false; }
      if (!r || !r.ok) return 'cancelled';
    }
    const old = sw.stage;
    const surfaces = loop.detachStage();
    let oldState = null;
    try { oldState = old.saveState(); } catch (e) { oldState = null; }
    sw.shells = withShellBinds(sw.shells, cur, oldState);
    let stage;
    try {
      stage = await createStage(next.id, swapStageState(oldState, next.id, sw.shells, surfaces), old);
    } catch (e) {
      loop.attachStage(old, shellRef(cur));
      return 'failed: ' + String((e && e.message) || e).slice(0, 200);
    }
    const sid = stage.shellId || next.id;
    sw.stage = stage;
    if (onStage) onStage(stage);
    call(balloons, 'setStage', stage);
    call(dialogs, 'setStage', stage);
    loop.attachStage(stage, shellRef(sid));
    try { old.destroy(); } catch (e) { /* ignore */ }
    const mem = shellMemory(sw.shells, sid);
    const pick = chooseBalloon(site, ghost, { shellBalloon: mem && mem.balloon, choice: sw.choice, ghostDescript });
    if (pick && !(sw.balloon && sameName(sw.balloon.id, pick.entry.id))) await swapBalloon(pick.entry, { event: false, silent: true });
    await loop.shellChanged({ surfaces, event: !reload, defer: !!fromScript && !raiseEvent && !reload });
    return 'switched';
  };

  // reload: \![reload,balloon] (EV §2.10): the balloon in use again, only OnNotifySelfInfo; none in use: nothing
  const changeBalloon = async ({ target, byId = false, fromScript = false, reload = false }) => {
    const list = installedBalloons(site, ghost);
    if (reload) {
      const cur = sw.balloon && list.find(b => sameName(b.id, sw.balloon.id));
      if (!cur) return 'no balloon in use';
      return (await swapBalloon(cur, { event: false })) ? 'switched' : 'failed: no skin';
    }
    const next = resolveBalloonTarget(list, sw.balloon ? sw.balloon.id : null, target, { byId });
    if (!next) return 'no such balloon';
    return (await swapBalloon(next, { event: true, defer: !!fromScript })) ? 'switched' : 'failed: no skin';
  };

  const viewOf = kind => (kind === 'balloon' ? (sw.balloon ? sw.balloon.id : '') : sw.stage.shellId);
  const record = (req, result, from) => note({
    kind: req.kind, target: String(req.target ?? ''), fromScript: !!req.fromScript, raiseEvent: !!req.raiseEvent,
    ...(req.reload ? { reload: true } : {}), result, from, to: viewOf(req.kind),
  });
  const run = async req => {
    const from = viewOf(req.kind);
    let result;
    try {
      result = req.kind === 'balloon' ? await changeBalloon(req) : await changeShell(req);
    } catch (e) {
      result = 'failed: ' + String((e && e.message) || e).slice(0, 200);
    }
    record(req, result, from);
    return result === 'switched';
  };
  const freed = () => { if (!sw.waiting) sw.chained = 0; };

  const request = (req, queued = false) => {
    if (!req) return Promise.resolve(false);
    if (sw.slot) {
      const refused = !req.fromScript ? 'refused: a change is under way'
        : sw.waitingTalk ? 'refused: OnShellChanging\'s talk'
          : !queued && sw.chained >= MAX_CHAINED_CHANGES ? `refused: ${MAX_CHAINED_CHANGES + 1} changes in a row` : null;
      if (refused) { record(req, refused, viewOf(req.kind)); return Promise.resolve(false); }
      if (!queued) sw.chained++;
      sw.waiting++;
      const go = () => {
        sw.waiting--;
        const r = request(req, true);
        if (!sw.slot) freed();
        return r;
      };
      return sw.slot.then(go, go);
    }
    sw.slot = run(req).finally(() => { sw.slot = null; freed(); });
    return sw.slot;
  };

  return { request, state: sw };
}

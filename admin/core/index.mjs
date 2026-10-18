// The site index, as tools/index_site.py writes it, byte for byte (CLAUDE.md "The admin tool"; the parity tests in
// tests/admin/ and admin/parity.mjs compare the two): SITE/sumika/index/ghosts.json, each ghost's and balloon's
// manifest `<kind>.<id>.<10 hex of its SHA-1>.json` and pack `<kind>.<id>.<10 hex of the SHA-1 of the pack before
// gzip>.pack.gz`. The packs are the one output whose bytes differ between the two tools: Node's zlib deflates
// otherwise than Python's, so a pack is named after its content and an existing pack that holds the same content is
// kept as it is, whichever tool wrote it (index_site.py write_pack does the same). Nothing in sumika/index/ is deleted
// (tools/prune.mjs's work). Same order of writing: each ghost's pack and manifest, the balloons', ghosts.json last.
//
// Reused: engine detection (tools/sweep/views.mjs detectEngine = index_site.py detect_engine), SSP's name order and
// default shell (src/core/shells.js), the icon lookup (src/core/trayicon.js findIcon), the root engines' pack patterns
// (src/core/engine-files.js). Ported here because the JS twins differ in what they are fed: the descript reading
// (Python's read_text, splitlines and strip: text.mjs), the folder listing (os.walk: tree.mjs), the entry assembly
// (views.mjs ghostEntry lists folders from file paths and has no thumbnails).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { detectEngine } from '../../tools/sweep/views.mjs';
import { crc32 } from '../../tools/sweep/zip.mjs';
import { sortShells, defaultShellId, compareEntries } from '../../src/core/shells.js';
import { findIcon } from '../../src/core/trayicon.js';
import { dumps, cmpPy } from './py.mjs';
import { readDescript, descriptLast, decodeCp932, decodeUtf8 } from './text.mjs';
import { walk, fileList, listdir, isFile, isDir } from './tree.mjs';
import {
  FORMAT, NAME_HASH, VERSION_HASH, KAWARI_ENGINES, KAWARI_SAVE_HEAD, KAWARI_SHIPPED_SAVES, PACK_EXT, PACK_SKIP,
  ROOT_PACK_EXT, PACK_MAX, DEFAULT_BALLOON, THUMB_EXT, THUMB_EXT_PREFIX, isPersonal, personalCode,
} from './rules.mjs';
import { AdminRefusal } from './refusal.mjs';
import { progress } from './progress.mjs';
import { message } from './codes.mjs';
import { readShipped } from './shipped.mjs';

const EOL = process.platform === 'win32' ? '\r\n' : '\n';      // os.linesep: ghosts.json's line ends (index_site.py)
const sha1 = data => crypto.createHash('sha1').update(data).digest('hex');
const join = (root, rel) => path.join(root, ...rel.split('/'));
const hasBom = u8 => u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf;

// ---- the engine ------------------------------------------------------------------------------------------------

/**
 * A ghost root's files as views.mjs detectEngine reads them: `paths` (ghost-root-relative, the list index_site.py
 * passes), bytes from disk, and its configs decoded as index_site.py config_dics decodes them (UTF-8 after a BOM,
 * else cp932, errors replaced).
 */
export function engineFiles(root, paths) {
  return {
    list(prefix = '') {
      const pre = prefix ? prefix.toLowerCase() + '/' : '';
      return paths.filter(p => p.toLowerCase().startsWith(pre));
    },
    async bytes(p) {
      return fs.readFileSync(join(root, p));
    },
    decodeConfig: u8 => (hasBom(u8) ? decodeUtf8(u8.subarray(3)) : decodeCp932(u8)),
  };
}

/** index_site.py folder_engine (and its module): detect_engine for a ghost folder and the paths given. */
export async function folderEngine(root, paths) {
  const d = readDescript(path.join(root, 'ghost', 'master', 'descript.txt'));
  return detectEngine(engineFiles(root, paths), d);
}

// ---- personal files --------------------------------------------------------------------------------------------

/** index_site.py kawari_saved: [[path, CRC-32]] of the paths (relative to root) that start with Kawari's save header */
export function kawariSaved(root, paths) {
  const found = [];
  const head = Buffer.alloc(128);
  for (const rel of paths) {
    const file = join(root, rel);
    const fd = fs.openSync(file, 'r');
    let n;
    try {
      n = fs.readSync(fd, head, 0, 128, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!KAWARI_SAVE_HEAD.test(head.subarray(0, n).toString('latin1'))) continue;
    found.push([rel, crc32(fs.readFileSync(file))]);
  }
  return found;
}

/**
 * index_site.py kawari_unlisted: [[path, CRC-32]] of kawariSaved that neither KAWARI_SHIPPED_SAVES nor `shipped` (the
 * ghost's entries of the site's record, shipped.mjs) lists with these contents.
 */
export function kawariUnlisted(root, paths, shipped = []) {
  const key = (p, crc) => `${p.replace(/\\/g, '/').toLowerCase()}\n${crc}`;
  const known = new Set([...KAWARI_SHIPPED_SAVES, ...shipped].map(([p, crc]) => key(p, crc)));
  return kawariSaved(root, paths).filter(([p, crc]) => !known.has(key(p, crc)));
}

/** index_site.py kawari_saves: the paths of kawariUnlisted */
export function kawariSaves(root, paths, shipped = []) {
  return kawariUnlisted(root, paths, shipped).map(([p]) => p);
}

/** file_list's paths only, same order (os.walk), for the personal-file check (no PNG header is read) */
function paths(root) {
  const out = [];
  for (const { rel, files } of walk(root)) for (const f of files) out.push(rel ? `${rel}/${f}` : f);
  return out;
}

/**
 * index_site.py personal_files: the site files that hold a user's personal state, in its order: PERSONAL_DIRS /
 * PERSONAL_FILES under ghost/ and balloon/, PERSONAL_PATHS in ghosts, then each Kawari ghost's files that start with
 * Kawari's save header (unless KAWARI_SHIPPED_SAVES lists them, or the site's record does for that ghost: an add from
 * its own .nar / .zip, shipped.mjs). A record that does not read throws its refusal ('kawari.record') first, as
 * index_site.py raises KawariRecordError: without it a Kawari ghost's starting files cannot be told from saves.
 * @returns {Promise<{path: string, code: string, params?: object}[]>} site-relative paths, each with its personal.* code
 */
export async function personalFiles(site) {
  const record = readShipped(site);
  const found = [];
  for (const top of ['ghost', 'balloon']) {
    const d = path.join(site, top);
    if (!isDir(d)) continue;
    for (const p of paths(d)) {
      const hit = personalCode(p, top === 'ghost');
      if (hit) found.push({ path: `${top}/${p}`, ...hit, why: message(hit.code, hit.params || {}) });
    }
  }
  const gdir = path.join(site, 'ghost');
  for (const gid of isDir(gdir) ? listdir(gdir) : []) {
    const root = path.join(gdir, gid);
    if (!isFile(path.join(root, 'ghost', 'master', 'descript.txt'))) continue;
    const list = paths(root).filter(p => !isPersonal(`${gid}/${p}`, true));
    if (KAWARI_ENGINES.includes((await folderEngine(root, list)).engine)) {
      found.push(...kawariSaves(root, list, record.get(gid) || []).map(p => ({ path: `ghost/${gid}/${p}`, code: 'personal.kawariSave', why: message('personal.kawariSave') })));
    }
  }
  return found;
}

/** index_site.py's refusal of a site holding personal files ('site.personal'). */
export const personalRefusal = found => new AdminRefusal('site.personal', {}, found);

// ---- shells, balloons, thumbnails, icons -----------------------------------------------------------------------

/** index_site.py shell_entries: Shell ▸'s shells (SPGhostBase::EnumShells) in SSP's name order (sortShells). */
export function shellEntries(root) {
  const shells = [];
  const shellRoot = path.join(root, 'shell');
  if (isDir(shellRoot)) {
    for (const s of listdir(shellRoot)) {
      const sd = path.join(shellRoot, s);
      if (!isDir(sd)) continue;
      let entry;
      if (isFile(path.join(sd, 'descript.txt'))) {
        const sdesc = readDescript(path.join(sd, 'descript.txt'));
        entry = { id: s, name: sdesc.get('name') || 'default' };
        if ((sdesc.get('menu') ?? '').toLowerCase().includes('hid')) entry.hidden = true;
      } else if (['master', 'surface'].includes(s.toLowerCase())) {
        entry = { id: s, name: 'Default' };
      } else continue;
      shells.push(entry);
    }
  }
  return sortShells(shells);
}

/** index_site.py bundled_balloons: [{dir, name}] of the balloons inside a ghost folder, in folder order. */
export function bundledBalloons(root) {
  const bundled = [];
  for (const b of listdir(root)) {
    const bd = path.join(root, b);
    if (!isDir(bd) || b === 'ghost' || b === 'shell') continue;
    const bdesc = readDescript(path.join(bd, 'descript.txt'));
    if ((bdesc.get('type') ?? '').toLowerCase() === 'balloon' || isFile(path.join(bd, 'balloons0.png'))) {
      bundled.push({ dir: b, name: bdesc.has('name') ? bdesc.get('name') : b });
    }
  }
  return bundled;
}

/** index_site.py thumbnail_ext_ok: SSP's extension test (low byte of each UTF-16 unit, at most 15, cut at NUL). */
export function thumbnailExtOk(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  let ext = '';
  const tail = name.slice(dot + 1);
  for (let i = 0; i < tail.length && i < 15; i++) ext += String.fromCharCode(tail.charCodeAt(i) & 0xff);
  const nul = ext.indexOf('\0');
  if (nul >= 0) ext = ext.slice(0, nul);
  ext = ext.replace(/[A-Z]/g, c => c.toLowerCase());
  return THUMB_EXT.has(ext) || THUMB_EXT_PREFIX.some(p => ext.startsWith(p));
}

/** index_site.py thumbnail_names: `thumbnail*.*` files SSP takes as images, sorted by (upper case, name). */
export function thumbnailNames(folder) {
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch (e) {
    return [];
  }
  return names.filter(n => n.toLowerCase().startsWith('thumbnail') && thumbnailExtOk(n) && isFile(path.join(folder, n)))
    .sort((a, b) => cmpPy(a.toUpperCase(), b.toUpperCase()) || cmpPy(a, b));
}

function ghostThumbnails(root, gid) {
  const names = thumbnailNames(root);
  if (names.length) return names.map(n => `ghost/${gid}/${n}`);
  return thumbnailNames(path.join(root, 'ghost', 'master')).map(n => `ghost/${gid}/ghost/master/${n}`);
}

/** index_site.py ghost_icons: `icon` / `iconMinimize` site paths, each only when its file exists. */
function ghostIcons(root, gid, files) {
  const desc = path.join(root, 'ghost', 'master', 'descript.txt');
  const byLower = new Map(files.map(e => [e[0].toLowerCase(), e[0]]));
  const found = { resolve: rel => byLower.get(rel.toLowerCase()) ?? null };
  const out = {};
  const icon = findIcon(found, descriptLast(desc, ['icon', 'iconfilename']) || 'icon.ico');
  if (icon) out.icon = `ghost/${gid}/${icon}`;
  const name = descriptLast(desc, ['icon.minimize']);
  const minimize = name ? findIcon(found, name) : null;
  if (minimize) out.iconMinimize = `ghost/${gid}/${minimize}`;
  return out;
}

// ---- versions, manifests, packs --------------------------------------------------------------------------------

function versionOf(memo, file) {
  const key = path.resolve(file);
  let v = memo.get(key);
  if (v === undefined) memo.set(key, v = sha1(fs.readFileSync(key)).slice(0, VERSION_HASH));
  return v;
}

/**
 * index_site.py ghost_entry: the ghosts.json entry (keys in its order) and the manifest of site/ghost/<gid>.
 * @returns {Promise<{entry: object, manifest: object, root: string}>}
 */
export async function ghostEntry(site, gid, memo = new Map()) {
  const root = path.join(site, 'ghost', gid);
  const d = readDescript(path.join(root, 'ghost', 'master', 'descript.txt'));
  const inst = readDescript(path.join(root, 'install.txt'));
  const shells = shellEntries(root);
  const bundled = bundledBalloons(root);
  for (const sh of shells) {
    const th = thumbnailNames(path.join(root, 'shell', sh.id)).map(n => `ghost/${gid}/shell/${sh.id}/${n}`);
    if (th.length) sh.thumbnails = th;
  }
  for (const b of bundled) {
    const th = thumbnailNames(path.join(root, b.dir)).map(n => `ghost/${gid}/${b.dir}/${n}`);
    if (th.length) b.thumbnails = th;
  }
  let preferred = null;
  const want = inst.get('balloon.directory');
  if (want && bundled.some(b => b.dir === want)) preferred = want;
  else if (bundled.length) preferred = bundled[0].dir;
  const files = fileList(root);
  const { engine, module } = await detectEngine(engineFiles(root, files.map(e => e[0])), d);
  const entry = {
    id: gid,
    name: d.has('name') ? d.get('name') : gid,
    sakuraName: d.get('sakura.name') ?? '',
    keroName: d.get('kero.name') ?? '',
    craftman: d.get('craftmanw') || (d.get('craftman') ?? ''),
    shiori: d.has('shiori') ? d.get('shiori') : 'shiori.dll',
    engine,
  };
  if (module !== undefined && module !== null) entry.module = module;      // YAYA's <module>.txt / _variable.cfg
  entry.thumbnails = ghostThumbnails(root, gid);
  Object.assign(entry, ghostIcons(root, gid, files));
  entry.shells = shells;
  // [disasm SPGhost::GetDefaultShellID]: shells.js defaultShellId is index_site.py default_shell's rule
  entry.defaultShell = shells.length ? defaultShellId({ shells }, d) : null;
  entry.bundledBalloons = bundled;
  entry.balloon = preferred || d.get('balloon') || null;
  const manifest = { format: FORMAT, id: gid, root: `ghost/${gid}/`, files, versions: files.map(e => versionOf(memo, join(root, e[0]))) };
  return { entry, manifest, root };
}

/**
 * The pack's bytes before gzip ("SMKP" | uint32 LE header length | header JSON | file bytes, src/core/loader.js
 * TextPack) and its name (index_site.py write_pack), or null when no file goes in.
 */
export function packOf(root, files, stem, ext = null) {
  const entries = [], blobs = [];
  let off = 0;
  for (const [rel, size] of files) {
    const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
    const wanted = ext ? ext.test(name) : PACK_EXT.some(e => name.endsWith(e)) && !PACK_SKIP.some(s => name.startsWith(s));
    if (!wanted || size > PACK_MAX) continue;
    const data = fs.readFileSync(join(root, rel));
    entries.push([rel, off, data.length]);
    blobs.push(data);
    off += data.length;
  }
  if (!entries.length) return null;
  const header = Buffer.from(dumps({ files: entries }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  const raw = Buffer.concat([Buffer.from('SMKP', 'latin1'), len, header, ...blobs]);
  return { name: `${stem}.${sha1(raw).slice(0, NAME_HASH)}.pack.gz`, count: entries.length, raw };
}

/** gzip -9 with mtime 0 and the OS byte 255, as Python's gzip.compress(raw, 9, mtime=0) heads it (its deflate differs) */
export function gzipPack(raw) {
  const gz = zlib.gzipSync(raw, { level: 9 });
  gz[9] = 0xff;
  return gz;
}

/** The file's bytes are the pack `raw` gzip'd (by any zlib): true / false, false when it is missing or no gzip. */
export function holdsPack(file, raw) {
  let old;
  try {
    old = fs.readFileSync(file);
  } catch (e) {
    return null;
  }
  try {
    return zlib.gunzipSync(old).equals(raw) ? old.length : null;
  } catch (e) {
    return null;
  }
}

/** Writes into sumika/index/ as index_site.py does: a file only when its bytes (a pack: its content) change. */
function diskSink(out) {
  const written = [], kept = [];
  return {
    written, kept,
    file(name, data) {
      const p = path.join(out, name);
      let same = false;
      try { same = fs.readFileSync(p).equals(data); } catch (e) { same = false; }
      if (same) kept.push(name);
      else {
        fs.writeFileSync(p, data);
        written.push(name);
      }
    },
    pack(name, raw) {
      const p = path.join(out, name);
      const size = holdsPack(p, raw);
      if (size !== null) {
        kept.push(name);
        return size;
      }
      const gz = gzipPack(raw);
      fs.writeFileSync(p, gz);
      written.push(name);
      return gz.length;
    },
  };
}

/** Compares instead of writing (checkSite): what an index run would write that is not on disk as it would be. */
function checkSink(out) {
  const stale = [];
  const add = (name, code) => stale.push({ path: `sumika/index/${name}`, code, why: message(code) });
  return {
    stale,
    file(name, data) {
      let old = null;
      try { old = fs.readFileSync(path.join(out, name)); } catch (e) { old = null; }
      if (!old) add(name, 'index.missing');
      else if (!old.equals(data)) add(name, 'index.differs');
    },
    pack(name, raw) {
      const size = holdsPack(path.join(out, name), raw);
      if (size === null) add(name, fs.existsSync(path.join(out, name)) ? 'index.differs' : 'index.missing');
      return size ?? 0;
    },
  };
}

// ---- the run ---------------------------------------------------------------------------------------------------

async function build(site, out, sink, log, tick = () => {}) {
  const memo = new Map();
  const ghosts = [], balloons = [];
  const manifests = { ghost: new Map(), balloon: new Map() };
  const writeManifest = (manifest, stem) => {
    const data = Buffer.from(dumps(manifest), 'utf8');
    const name = `${stem}.${sha1(data).slice(0, NAME_HASH)}.json`;
    sink.file(name, data);
    return name;
  };
  const gdir = path.join(site, 'ghost');
  const bdir = path.join(site, 'balloon');
  const gids = (isDir(gdir) ? listdir(gdir) : []).filter(g => isFile(path.join(gdir, g, 'ghost', 'master', 'descript.txt')));
  const bids = (isDir(bdir) ? listdir(bdir) : []).filter(b => isFile(path.join(bdir, b, 'descript.txt')));
  let done = 0, total = gids.length + bids.length;          // the hoisted balloons are added once they are known
  for (const gid of gids) {
    tick('index', done++, total, `ghost/${gid}`);
    const { entry, manifest, root } = await ghostEntry(site, gid, memo);
    ghosts.push(entry);
    const ext = Object.prototype.hasOwnProperty.call(ROOT_PACK_EXT, entry.engine) ? ROOT_PACK_EXT[entry.engine] : null;
    const pack = packOf(root, manifest.files, `ghost.${gid}`, ext);
    if (pack) {
      const gz = sink.pack(pack.name, pack.raw);
      manifest.pack = `sumika/index/${pack.name}`;
      log(`  ${gid}: packed ${pack.count} text files, ${Math.floor(pack.raw.length / 1024)} KB -> ${Math.floor(gz / 1024)} KB gzip`);
    }
    manifests.ghost.set(gid, `sumika/index/${writeManifest(manifest, `ghost.${gid}`)}`);
  }

  const addBalloon = (bid, root, rel, entry) => {
    const th = thumbnailNames(root).map(n => rel + n);           // Balloon ▸ thumbnails (ssp-ui.md §2.14)
    if (th.length) entry.thumbnails = th;
    const bfiles = fileList(root);
    const bman = { format: FORMAT, id: bid, root: rel, files: bfiles, versions: bfiles.map(e => versionOf(memo, join(root, e[0]))) };
    const pack = packOf(root, bfiles, `balloon.${bid}`);
    if (pack) {
      sink.pack(pack.name, pack.raw);
      bman.pack = `sumika/index/${pack.name}`;
    }
    manifests.balloon.set(bid, `sumika/index/${writeManifest(bman, `balloon.${bid}`)}`);
    balloons.push(entry);
  };

  for (const bid of bids) {
    tick('index', done++, total, `balloon/${bid}`);
    const root = path.join(bdir, bid);
    const bdesc = readDescript(path.join(root, 'descript.txt'));
    addBalloon(bid, root, `balloon/${bid}/`, { id: bid, name: bdesc.has('name') ? bdesc.get('name') : bid });
  }
  const ids = balloons.map(b => b.id);
  const defaultBalloon = ids.includes(DEFAULT_BALLOON) ? DEFAULT_BALLOON : (ids.length ? ids[0] : null);
  // a ghost's bundled balloon is listed for every ghost, as SSP installs it (BA §1.6): a site balloon of the same
  // folder id wins, then the first ghost in id order
  const taken = new Map(balloons.map(b => [b.id.toLowerCase(), b]));
  total += ghosts.reduce((n, g) => n + g.bundledBalloons.length, 0);
  for (const g of ghosts) {
    for (const b of g.bundledBalloons) {
      const key = b.dir.toLowerCase();
      if (taken.has(key)) {
        if (taken.get(key).ghost !== g.id) log(`  ${g.id}/${b.dir}: not listed for other ghosts, the folder id is taken`);
        continue;
      }
      const entry = { id: b.dir, name: b.name, ghost: g.id };
      taken.set(key, entry);
      tick('index', done++, total, `ghost/${g.id}/${b.dir}`);
      addBalloon(b.dir, path.join(gdir, g.id, b.dir), `ghost/${g.id}/${b.dir}/`, entry);
    }
  }
  const sorted = sortShells(balloons);
  // Change ghost ▸'s order, as ssp.exe lists the ghosts: by descript name, ties by folder [observed];
  // the loops above stay in id order (the lines they print, the ghost whose bundled balloon takes an id)
  const listed = [...ghosts].sort(compareEntries);
  const named = [];
  for (const g of listed) {
    named.push(...g.thumbnails);
    for (const k of ['icon', 'iconMinimize']) if (g[k]) named.push(g[k]);
    for (const item of [...g.shells, ...g.bundledBalloons]) named.push(...(item.thumbnails || []));
  }
  for (const b of sorted) named.push(...(b.thumbnails || []));
  const versions = new Map();
  for (const p of named) if (!versions.has(p)) versions.set(p, versionOf(memo, join(site, p)));
  const index = new Map([
    ['format', FORMAT], ['ghosts', listed], ['balloons', sorted], ['defaultBalloon', defaultBalloon],
    ['manifests', new Map([['ghost', manifests.ghost], ['balloon', manifests.balloon]])], ['versions', versions],
  ]);
  // last: it names everything above (line ends as index_site.py's text-mode write on this system ends them)
  sink.file('ghosts.json', Buffer.from(dumps(index, { indent: 1 }).replace(/\n/g, EOL), 'utf8'));
  tick('index', total, total, null);
  const shared = sorted.filter(b => !('ghost' in b)).length;
  log(`indexed ${ghosts.length} ghost(s), ${shared} shared balloon(s) + ${sorted.length - shared} bundled, default balloon ${defaultBalloon ?? 'None'} -> ${out}`);
  return { ghosts: listed, balloons: sorted, defaultBalloon, manifests, shared };
}

/**
 * index_site.py main: refuses a site whose Kawari record does not read (AdminRefusal 'kawari.record') or with personal
 * files ('site.personal'), nothing written, else writes sumika/index/ (packs and manifests whose bytes changed,
 * ghosts.json last) and deletes nothing.
 * @param {string} site
 * @param {{log?: (line: string) => void, onProgress?: (p: {phase, done, total, item}) => void}} [o] log: what
 *   index_site.py prints, line by line; onProgress: phase 'index', a step per ghost and balloon
 * @returns {Promise<{ghosts: number, sharedBalloons: number, bundledBalloons: number, defaultBalloon: string|null,
 *   written: string[], kept: string[], ids: string[]}>}
 */
export async function indexSite(site, { log = () => {}, onProgress = null } = {}) {
  const abs = path.resolve(site);
  const out = path.join(abs, 'sumika', 'index');
  const personal = await personalFiles(abs);
  if (personal.length) throw personalRefusal(personal);
  fs.mkdirSync(out, { recursive: true });
  const sink = diskSink(out);
  const r = await build(abs, out, sink, log, progress(onProgress));
  return {
    ghosts: r.ghosts.length, sharedBalloons: r.shared, bundledBalloons: r.balloons.length - r.shared,
    defaultBalloon: r.defaultBalloon, written: sink.written, kept: sink.kept, ids: r.ghosts.map(g => g.id),
  };
}

/**
 * Whether sumika/index/ is what an index run would write now (nothing written): {upToDate, stale: [{path, code,
 * why}], personal: [], record: null}; a site with personal files gets {upToDate: false, stale: [], personal: [{path,
 * code}], record: null}, one whose Kawari record does not read {upToDate: false, stale: [], personal: [], record:
 * {code: 'kawari.record', params, message}} (the index would refuse either; the record is said as itself, never as
 * the personal files its loss would make of the Kawari ghosts' starting files).
 */
export async function indexState(site, { onProgress = null } = {}) {
  const abs = path.resolve(site);
  const out = path.join(abs, 'sumika', 'index');
  let personal;
  try {
    personal = await personalFiles(abs);
  } catch (e) {
    if (e instanceof AdminRefusal && e.code === 'kawari.record') {
      return { upToDate: false, stale: [], personal: [], record: { code: e.code, params: e.params, message: e.message } };
    }
    throw e;
  }
  if (personal.length) return { upToDate: false, stale: [], personal, record: null };
  const sink = checkSink(out);
  await build(abs, out, sink, () => {}, progress(onProgress));
  return { upToDate: sink.stale.length === 0, stale: sink.stale, personal: [], record: null };
}

// Site index and ghost/balloon folder access over HTTP.
// Ghosts were written for Windows: paths may use '\', any letter case, and Shift_JIS text.
// Safe updates (CLAUDE.md "What gets published"): ghosts.json is the one data file every page rechecks ('no-cache');
// the manifests and packs it names carry a hash in their names and ghost files a `?v=<hash>` from their manifest, so
// every fetch() of them may take any stored copy ('force-cache') and fetches once more ('reload') when that copy is not
// what the name promises. Files the page loads through elements (<img>, CSS url(), <audio>, cursors) keep their plain
// URL (url()).
import { log } from './log.js';
import { tabSession as session } from './platform.js';    // the tab's sessionStorage, or the storage hub's
import { compareEntries } from './shells.js';

/** The newest site index this runtime reads (= tools/index_site.py FORMAT): 2 names hashed manifests (`manifests`). */
export const INDEX_FORMAT = 2;

/**
 * sessionStorage: '1' once this tab met a file whose size still differed from its manifest's after a 'reload' (a host
 * that rewrites files, such as a CDN's image optimisation; fetchVersioned). From then on the tab takes a stored copy of
 * another size as it is, so such a host costs one download again per tab, not every image again on every page.
 */
export const REWRITES_KEY = 'sumika.hostRewrites';

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** a site path as a relative URL: each segment encoded (a folder named `a#1` stays a folder) */
const encPath = p => String(p).split('/').map(encodeURIComponent).join('/');

/** Normalize a ghost-relative path: '\' -> '/', drop './', resolve '..', strip leading '/'. */
export function normPath(p) {
  const out = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * Site paths (ghosts.json `thumbnails`: 'ghost/<id>/thumbnail.png') as URLs against the site's base, each segment
 * encoded (a folder named `a#1` stays a folder); none when the base is not a URL. With `versions` (ghosts.json
 * `versions`, SiteIndex.versions) a path it lists gets `?v=<hash>`: only for URLs fetch() loads (loadThumbnail), never
 * for an element's (the launcher icon <img>), which keep the plain URL.
 * @param {string} base  @param {unknown} paths  @param {Object<string, string>|null} [versions]
 * @returns {string[]}
 */
export function siteUrls(base, paths, versions = null) {
  const out = [];
  const vs = isObj(versions) ? versions : null;
  for (const p of Array.isArray(paths) ? paths : []) {
    if (!p) continue;
    let u;
    try { u = new URL(encPath(p), base).href; } catch (e) { continue; /* no base */ }
    const v = vs && hasOwn(vs, String(p)) ? vs[String(p)] : null;
    out.push(typeof v === 'string' && v ? `${u}?v=${encodeURIComponent(v)}` : u);
  }
  return out;
}

/** Decode ghost text: UTF-8 if it has a BOM or declares charset UTF-8 near the top, otherwise Shift_JIS (CP932). */
export function decodeText(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 4096)).toLowerCase();
  if (/charset\s*,\s*utf-?8/.test(head)) return new TextDecoder('utf-8').decode(u8);
  return new TextDecoder('shift_jis').decode(u8);
}

async function fetchOk(url, kind) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`sumika: ${r.status} fetching ${url}`);
  return kind === 'json' ? r.json() : kind === 'text' ? r.text() : r.arrayBuffer();
}

/** A `?v=` URL (GhostFiles.versionedUrl, siteUrls with versions): its bytes are named, so any stored copy is right. */
const VERSIONED = /\?(?:[^#]*&)?v=[^&#]/;

/**
 * fetch() of a ghost or balloon file. A `?v=` URL takes any stored copy ('force-cache': no recheck, also in
 * Firefox on a host that sends no expiry); a response that is not ok, or not `size` bytes when the manifest gives one,
 * is fetched once more with 'reload', and a size that still differs is used as it came, logged once (a CDN that
 * rewrites images must not break the shell), and marks the tab (REWRITES_KEY): after that a stored copy of another
 * size is taken as it is, and only a stored copy that is not ok is fetched again. A URL without `?v=` is fetched with
 * the browser's default.
 * @param {string} url
 * @param {{size?: number, as?: 'bytes'|'blob'}} [o] size: the manifest's (-1: unknown); as: ArrayBuffer or Blob
 * @returns {Promise<ArrayBuffer|Blob>}
 */
export async function fetchVersioned(url, { size = -1, as = 'bytes' } = {}) {
  const read = r => (as === 'blob' ? r.blob() : r.arrayBuffer());
  const length = b => (as === 'blob' ? b.size : b.byteLength);
  if (!VERSIONED.test(String(url))) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`sumika: ${r.status} fetching ${url}`);
    return read(r);
  }
  const want = Number.isInteger(size) && size >= 0 ? size : -1;
  const stored = await fetch(url, { cache: 'force-cache' });
  if (stored.ok) {
    const body = await read(stored);
    if (want < 0 || length(body) === want || session.get(REWRITES_KEY) === '1') return body;
  }
  const r = await fetch(url, { cache: 'reload' });
  if (!r.ok) throw new Error(`sumika: ${r.status} fetching ${url}`);
  const body = await read(r);
  if (want >= 0 && length(body) !== want) {
    log.once(`size:${url}`, `${url}: ${length(body)} bytes where the index says ${want}; used as it came`);
    session.set(REWRITES_KEY, '1');
  }
  return body;
}

/**
 * A file whose name holds the hash of its bytes (a manifest, a pack): any stored copy ('force-cache'), and once
 * more with 'reload' when the response is not ok or `check` refuses its bytes (an error stored by an upload done in
 * the wrong order, a host's HTML page for a missing file). Still bad: rejects with code 'gone'.
 * @param {string} url  @param {(u8: Uint8Array) => any} check the parsed file, or null when it is not one
 */
async function fetchNamed(url, check) {
  let why = '';
  for (const cache of ['force-cache', 'reload']) {
    const r = await fetch(url, { cache });
    if (!r.ok) { why = String(r.status); continue; }
    const got = check(new Uint8Array(await r.arrayBuffer()));
    if (got != null) return got;
    why = 'not the file its name promises';
  }
  const e = new Error(`sumika: ${why} fetching ${url}`);
  e.code = 'gone';
  throw e;
}

/** A manifest's bytes parsed: JSON with a `root` string and a `files` array, else null. */
function manifestOf(u8) {
  try {
    const m = JSON.parse(new TextDecoder().decode(u8));
    return isObj(m) && typeof m.root === 'string' && Array.isArray(m.files) ? m : null;
  } catch (e) {
    return null;
  }
}

/** A pack's bytes: gzip (1f 8b), or already decoded by the host (`SMKP`, Content-Encoding: gzip); else null. */
function packBytes(u8) {
  if (u8[0] === 0x1f && u8[1] === 0x8b) return u8;
  return String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) === 'SMKP' ? u8 : null;
}

/**
 * ghosts.json, the data root: 'no-cache' on every page (a 304 when unchanged); when the network fails (a TypeError,
 * not an HTTP status) once more from the browser's copy, so a page shown offline still has its ghosts. An index
 * newer than INDEX_FORMAT rejects with code 'index-newer': this runtime is older than the site.
 */
async function fetchIndex(url) {
  let r;
  try {
    r = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    r = await fetch(url, { cache: 'force-cache' });
  }
  if (!r.ok) throw new Error(`sumika: ${r.status} fetching ${url}`);
  const data = await r.json();
  if (!isObj(data)) throw new Error(`sumika: ${url} is no site index`);
  const format = Number(data.format) || 1;
  if (format > INDEX_FORMAT) {
    const e = new Error(`sumika: the site index is format ${format}; this runtime reads up to ${INDEX_FORMAT}`);
    e.code = 'index-newer';
    throw e;
  }
  return data;
}

/** ghosts.json `manifests` as {ghost: {id: path}, balloon: {id: path}} (empty for format 1). */
function manifestMaps(data) {
  const m = isObj(data.manifests) ? data.manifests : {};
  return { ghost: isObj(m.ghost) ? m.ghost : {}, balloon: isObj(m.balloon) ? m.balloon : {} };
}

export class SiteIndex {
  /** @param {string} base absolute URL of the site root (ends with '/') */
  static async load(base) {
    const idx = new SiteIndex();
    idx.base = base;
    const data = await fetchIndex(new URL('sumika/index/ghosts.json', base));
    idx.format = Number(data.format) || 1;
    /**
     * the ghosts in ssp.exe's Change ghost ▸ order: by descript name, ties by folder (shells.js compareEntries) [observed:
     * 23 ghosts of 23]. Sorted here once, so an index an older tool wrote in folder order is listed so
     * too; every list of the site's ghosts follows (Change ghost ▸, Call ghost ▸, the page API's ghosts(), ghostlist,
     * the random and sequential targets), and a page without data-default-ghost starts with the first of them that can
     * run (site.js chooseGhost)
     */
    idx.ghosts = Array.isArray(data.ghosts) ? [...data.ghosts].sort(compareEntries) : [];
    idx.balloons = data.balloons || [];
    /** the shared balloon for ghosts without one (BA §9; index_site.py); null = the built-in one */
    idx.defaultBalloon = typeof data.defaultBalloon === 'string' && data.defaultBalloon ? data.defaultBalloon : null;
    /** each manifest's hashed name (format 2) */
    idx.manifests = manifestMaps(data);
    /** {site path: hash}: the `?v=` of the thumbnails and icons named here (siteUrls) */
    idx.versions = isObj(data.versions) ? data.versions : {};
    idx._reread = null;
    return idx;
  }
  ghost(id) { return this.ghosts.find(g => g.id === id) || null; }
  balloon(id) { return this.balloons.find(b => b.id === id) || null; }
  ghostFiles(id) { return this._files('ghost', id); }
  balloonFiles(id) { return this._files('balloon', id); }

  /** [relative URL, hashed]: the manifest `manifests` names, else the fixed name of format 1 */
  _manifest(kind, id) {
    const named = this.manifests && this.manifests[kind];
    const p = named && hasOwn(named, id) ? named[id] : null;
    if (typeof p === 'string' && p) return [encPath(p), true];
    return [`sumika/index/${kind}.${encodeURIComponent(id)}.json`, false];
  }

  /**
   * A folder's GhostFiles. A manifest that is gone (still not ok or not a manifest after its retry: pruned under a
   * long-open tab, or named by a stale ghosts.json) re-reads ghosts.json once per page, which replaces only
   * `manifests` and `versions`, and is asked for once more under its new name. Never reloads the page; when the
   * index read again is newer than this runtime, the rejection is its 'index-newer', which the Runtime takes to
   * Site.staleCheck.
   */
  async _files(kind, id) {
    const [url, hashed] = this._manifest(kind, id);
    try {
      return await GhostFiles.open(this.base, url, { hashed });
    } catch (e) {
      if (e.code !== 'gone') throw e;
      const again = await this._reindex();
      if (again !== true) throw again && again.code === 'index-newer' ? again : e;
      const [next, nextHashed] = this._manifest(kind, id);
      if (next === url) throw e;
      return GhostFiles.open(this.base, next, { hashed: nextHashed });
    }
  }

  /**
   * ghosts.json read again (once per page): true when its `manifests` and `versions` replaced ours, else why not (an
   * Error, code 'index-newer' for an index newer than this runtime).
   */
  _reindex() {
    if (!this._reread) {
      this._reread = fetchIndex(new URL('sumika/index/ghosts.json', this.base)).then(data => {
        this.manifests = manifestMaps(data);
        this.versions = isObj(data.versions) ? data.versions : {};
        return true;
      }, e => {
        log.once('index-reread', 'the site index could not be read again', e && e.message);
        return e || new Error('sumika: the site index could not be read again');
      });
    }
    return this._reread;
  }
}

/**
 * The text files of a folder packed into one gzip'd download (written by tools/index_site.py):
 * "SMKP" | uint32 LE header length | header JSON {files: [[path, offset, size], ...]} | file bytes.
 * One request instead of ~70, and the hashed file name lets browsers cache it for good ('force-cache'). A host
 * that sends it with Content-Encoding: gzip hands it over decoded, which is used as it is.
 */
class TextPack {
  constructor(url) {
    this.url = url;
    this.promise = null;
  }

  /** @returns {Promise<{data: Uint8Array, entries: Map<string, [number, number]>}|null>} null = use single files */
  load() {
    if (!this.promise) {
      this.promise = (async () => {
        if (typeof DecompressionStream === 'undefined') return null;
        const got = await fetchNamed(this.url, packBytes);
        const u8 = got[0] === 0x1f
          ? new Uint8Array(await new Response(new Response(got).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
          : got;
        if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'SMKP') throw new Error('not a pack');
        const hlen = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
        const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
        const base = 8 + hlen;
        const entries = new Map(header.files.map(([p, off, size]) => [p.toLowerCase(), [base + off, size]]));
        return { data: u8, entries };
      })().catch(e => {
        console.warn('[sumika] text pack unavailable, loading files one by one:', e);
        return null;
      });
    }
    return this.promise;
  }
}

/** One folder on the server (a ghost or a balloon), described by its manifest. */
export class GhostFiles {
  /**
   * @param {string} base the site's URL  @param {string} manifestPath relative to it, already encoded
   * @param {{hashed?: boolean}} [o] hashed: the name holds the manifest's hash (format 2: 'force-cache', a 'reload'
   *   retry, the parse check; still bad: code 'gone'); else a fixed name (index format 1), a plain fetchOk
   */
  static async open(base, manifestPath, { hashed = false } = {}) {
    const url = new URL(manifestPath, base);
    const m = hashed ? await fetchNamed(url, manifestOf) : await fetchOk(url, 'json');
    const pack = m.pack ? new TextPack(new URL(m.pack, base).href) : null;
    return new GhostFiles(new URL(m.root, base).href, m.files, pack, '', m.versions);
  }

  /**
   * @param {string} rootUrl absolute URL ending with '/'
   * @param {Array<[string, number, number?, number?]>} files [path, size, imageWidth?, imageHeight?]
   * @param {TextPack|null} pack  @param {string} packPrefix this view's path inside the pack ('' or 'Sub/')
   * @param {Array<string|null>|null} [versions] the manifest's `versions`, parallel to files: each file's hash for its
   *   `?v=` (versionedUrl); a file without one gets none
   */
  constructor(rootUrl, files, pack = null, packPrefix = '', versions = null) {
    this.root = rootUrl;
    const vs = Array.isArray(versions) ? versions : [];
    this.files = files.map(([p, size, w, h], i) => {
      const f = { path: p, size, w, h };
      if (typeof vs[i] === 'string' && vs[i]) f.v = vs[i];
      return f;
    });
    this.byLower = new Map();
    for (const f of this.files) this.byLower.set(f.path.toLowerCase(), f);
    this.cache = new Map();
    this.pack = pack;
    this.packPrefix = packPrefix;
  }

  /** A view of a subfolder (e.g. a balloon bundled inside a ghost), sharing the pack and the versions. */
  sub(prefix) {
    const pre = normPath(prefix) + '/';
    const lower = pre.toLowerCase();
    const inside = this.files.filter(f => f.path.toLowerCase().startsWith(lower));
    const files = inside.map(f => [f.path.slice(pre.length), f.size, f.w, f.h]);
    const real = this.files.find(f => f.path.toLowerCase().startsWith(lower));
    const realPre = real ? real.path.slice(0, pre.length) : pre;
    return new GhostFiles(this.root + realPre.split('/').map(encodeURIComponent).join('/'), files, this.pack, this.packPrefix + realPre,
      inside.map(f => f.v || null));
  }

  /** Pixel size of an image, when the index recorded it (lets layout happen before the image arrives). */
  imageSize(p) {
    const r = this.resolve(p);
    const f = r && this.byLower.get(r.toLowerCase());
    return f && f.w ? { width: f.w, height: f.h } : null;
  }

  resolve(p) {
    const f = this.byLower.get(normPath(p).toLowerCase());
    return f ? f.path : null;
  }
  has(p) { return this.resolve(p) !== null; }
  size(p) { const r = this.resolve(p); return r ? this.byLower.get(r.toLowerCase()).size : -1; }

  /** The file's plain URL, for what an element loads (<img>, CSS url(), <audio>, a cursor): no query. */
  url(p) {
    const r = this.resolve(p) ?? normPath(p);
    return this.root + r.split('/').map(encodeURIComponent).join('/');
  }

  /**
   * The URL fetch() loads it from (fetchVersioned): url() + `?v=<hash>` when the manifest gave the file a version; a
   * path it does not list gets none.
   */
  versionedUrl(p) {
    const r = this.resolve(p);
    const f = r !== null ? this.byLower.get(r.toLowerCase()) : null;
    const u = this.url(p);
    return f && f.v ? `${u}?v=${encodeURIComponent(f.v)}` : u;
  }

  /** Real paths under a folder prefix ('' = everything), optionally only direct children. */
  list(prefix = '', { recursive = true } = {}) {
    const pre = prefix ? normPath(prefix).toLowerCase() + '/' : '';
    return this.files.map(f => f.path).filter(p => {
      const l = p.toLowerCase();
      if (!l.startsWith(pre)) return false;
      return recursive || !l.slice(pre.length).includes('/');
    });
  }

  async bytes(p) {
    const r = this.resolve(p);
    if (r === null) throw new Error(`sumika: no such file ${p}`);
    let pr = this.cache.get(r);
    if (!pr) {
      pr = this._fromPack(r).then(b => b || fetchVersioned(this.versionedUrl(r), { size: this.size(r) }));
      this.cache.set(r, pr);
      pr.catch(() => this.cache.delete(r));
    }
    return pr;
  }

  async _fromPack(real) {
    if (!this.pack) return null;
    const p = await this.pack.load();
    const e = p && p.entries.get((this.packPrefix + real).toLowerCase());
    return e ? p.data.slice(e[0], e[0] + e[1]).buffer : null;
  }

  /** Start downloading the text pack now (it is needed by the engine and the shell parser alike). */
  prefetch() { if (this.pack) this.pack.load(); }

  async text(p) { return decodeText(await this.bytes(p)); }
  async textOrNull(p) { return this.has(p) ? this.text(p) : null; }
}

/**
 * Parse a descript.txt-style file ('key,value' lines, '//' comments). First value wins, keys are lower-cased.
 * @returns {Map<string,string>}
 */
export function parseDescript(text) {
  const d = new Map();
  for (let line of text.split(/\r\n|\r|\n/)) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    const i = line.indexOf(',');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!d.has(k)) d.set(k, line.slice(i + 1).trim());
  }
  return d;
}

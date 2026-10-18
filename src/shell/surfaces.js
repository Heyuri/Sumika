// Shell definition parser: descript.txt + surfaces*.txt -> Shell model (pure, no DOM).
// Spec: docs/research/shell-format.md (SH) §1–§4. Blocks are parsed once; a surface keeps references to the
// blocks that name it and is merged lazily on first use (Tsubasa's multi-ID headers expand to ~192k animations).
import { log } from '../core/log.js';
import { pickLoadable } from '../core/loadable.js';

/** @typedef {{min:number, max:number}} Wait */
/**
 * @typedef {Object} Pattern
 * @property {number} index
 * @property {string} method      lower-cased, aliases normalised (overlay-fast -> overlayfast ...)
 * @property {number} surface     part surface id; -1 clear, -2 stop others; NaN for control methods
 * @property {number} wmin
 * @property {number} wmax        wait in ms (old syntax already x10)
 * @property {number} x
 * @property {number} y
 * @property {number[]|null} ids  targets of start, stop, insert, alternative- and parallel- methods
 * @property {number|undefined} alpha
 */
/** @typedef {{kind:'rect'|'ellipse'|'circle'|'polygon'|'region', id:string, index:number, x1?:number, y1?:number, x2?:number, y2?:number, cx?:number, cy?:number, r?:number, pts?:number[], file?:string}} Collision */
/**
 * @typedef {Object} AnimDef
 * @property {number} id
 * @property {Set<string>} atoms   interval atoms (sometimes, rarely, random, periodic, always, runonce, never, yen-e, talk, starttalk, endtalk, bind)
 * @property {number} param        interval parameter (random,N / periodic,N / talk,N); 0 when absent
 * @property {boolean} isBind
 * @property {boolean} isPureBind  atoms == {bind}: static dress-up layer, waits ignored
 * @property {true|number[]|null} exclusive
 * @property {boolean} background
 * @property {boolean} sharedIndex
 * @property {Pattern[]} patterns  sorted by index (indices may be sparse)
 * @property {Collision[]} collisions
 * @property {string|undefined} name
 */
/**
 * @typedef {Object} SurfaceDef  a resolved (merged) surface
 * @property {number} id
 * @property {string|null} png               real file name of surfaceN.png, if any
 * @property {{index:number, method:string, file:string, x:number, y:number}[]} elements   one per number, sorted by
 *   number (a later line of the same number wins). Not what is drawn: drawing follows SurfaceRenderer.elementList.
 * @property {{index:number, method:string, file:string, x:number, y:number}[]} elementsRead   every element line in
 *   read order (blocks in load order, repeats kept): the list ssp.exe draws from (render.js elementList). The records
 *   are shared by every surface of a list header: never write to them.
 * @property {Collision[]} collisions        in collision-sort order (front first)
 * @property {Map<number, AnimDef>} anims
 * @property {number[]} drawOrder           animation ids, back to front (animation-sort)
 * @property {Map<string,string>} keys       other keys (point.*, balloon offsets, name ...), lower-cased
 * @property {{x:number,y:number}|null} basepos
 * @property {boolean} textDefined
 */
/** @typedef {{id:number, category:string, part:string, thumbnail:string, default:boolean, addid:number[]}} BindGroup */

const CONTROL = new Set(['start', 'stop', 'insert', 'alternativestart', 'alternativestop', 'parallelstart', 'parallelstop']);
const METHOD_ALIASES = { 'overlay-fast': 'overlayfast', overlaymultiply: 'blend-multiply-fast', overlayscreen: 'blend-screen-fast' };
const ATOMS = new Set(['sometimes', 'rarely', 'random', 'periodic', 'always', 'runonce', 'never', 'yen-e', 'talk', 'starttalk', 'endtalk', 'bind']);

const RE_ELEMENT = /^element(\d+)$/;
const RE_COLL = /^collision(\d+)$/;
const RE_COLLEX = /^collisionex(\d+)$/;
// block headers, for a "surface5 {" line found inside a block whose "}" is missing (SH §2.2, lenient)
const HEADER_START = /^(surface|sakura\.|kero\.|char\d+\.|descript)/i;
// a tooltip block is any brace name starting with `tooltip` after the scope (strnicmp 7 [disasm 0x6ebd8d])
const RE_SCOPE_BLOCK = /^(sakura|kero|char(\d+))\.(surface\.alias|cursor|tooltip.*)$/;

// Animation key scanner (hot path: ~48k lines in Tsubasa's shell). Sets K_ID / K_IDX and returns the kind.
const K_NONE = 0, K_INTERVAL = 1, K_PATTERN = 2, K_OPTION = 3, K_NAME = 4, K_COLL = 5, K_COLLEX = 6;
let K_ID = 0, K_IDX = 0;
function digitsAt(key, p) {
  let v = 0, q = p;
  const n = key.length;
  while (q < n) {
    const c = key.charCodeAt(q);
    if (c < 48 || c > 57) break;
    v = v * 10 + (c - 48);
    q++;
  }
  K_IDX = v;
  return q === p ? -1 : q;
}
function animKey(key, isNew) {
  let p = 0;
  if (isNew) {
    if (!key.startsWith('animation')) return K_NONE;
    p = 9;
  }
  const q = digitsAt(key, p);
  if (q < 0) return K_NONE;
  K_ID = K_IDX;
  p = q;
  if (isNew) {
    if (key.charCodeAt(p) !== 46) return K_NONE;
    p++;
  }
  const rest = key.length - p;
  switch (key.charCodeAt(p)) {
    case 105: return rest === 8 && key.startsWith('interval', p) ? K_INTERVAL : K_NONE;
    case 111: return rest === 6 && key.startsWith('option', p) ? K_OPTION : K_NONE;
    case 110: return isNew && rest === 4 && key.startsWith('name', p) ? K_NAME : K_NONE;
    case 112:
      if (!(key.startsWith('pattern', p) || key.startsWith('patturn', p) || key.startsWith('putturn', p))) return K_NONE;
      return digitsAt(key, p + 7) === key.length ? K_PATTERN : K_NONE;
    case 99:
      if (key.startsWith('collisionex', p)) return digitsAt(key, p + 11) === key.length ? K_COLLEX : K_NONE;
      if (key.startsWith('collision', p)) return digitsAt(key, p + 9) === key.length ? K_COLL : K_NONE;
      return K_NONE;
    default: return K_NONE;
  }
}

/** 0 -> 'sakura', 1 -> 'kero', n -> 'char<n>' */
export function scopeName(scope) { return scope === 0 ? 'sakura' : scope === 1 ? 'kero' : 'char' + scope; }
/** 'sakura' -> 0, 'kero' -> 1, 'char<n>' -> n (char0/char1 are synonyms of sakura/kero); null if not a scope name */
export function scopeOf(name) {
  name = String(name).toLowerCase();
  if (name === 'sakura') return 0;
  if (name === 'kero') return 1;
  const m = /^char(\d+)$/.exec(name);
  return m ? +m[1] : null;
}

const toInt = s => {
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : NaN;
};

/**
 * SPSeriko_wcstonum 0x6e97f0 [disasm]: an optional '-', then `0x` hex or decimal with leading zeros skipped, read by
 * wcstoul (blanks and a sign first; no digit gives 0).
 */
export function wcstonum(s) {
  s = String(s);
  let i = 0, neg = false, hex = false;
  if (s[0] === '-') { neg = true; i = 1; }
  if (/^0x/i.test(s.slice(i, i + 2))) { hex = true; i += 2; }
  while (s[i] === '0') i++;
  const m = (hex ? /^\s*([+-]?)([0-9a-f]*)/i : /^\s*([+-]?)([0-9]*)/).exec(s.slice(i));
  let v = m[2] ? parseInt(m[2], hex ? 16 : 10) : 0;
  if (m[1] === '-') v = -v;
  return (neg ? -v : v) || 0;
}

/**
 * Parse a surface ID list ("0-4,6,!5,surface9"). Exclusions apply wherever they appear (SH §2.4).
 * @returns {number[]} ascending, unique
 */
export function parseIdList(s) {
  const inc = new Set(), exc = new Set();
  for (let item of String(s).split(',')) {
    item = item.trim();
    if (!item) continue;
    let neg = false;
    if (item[0] === '!') { neg = true; item = item.slice(1).trim(); }
    item = item.replace(/^surface/i, '').trim();
    const m = /^(-?\d+)\s*(?:-\s*(\d+))?$/.exec(item);
    if (!m) { log.once('shell:idlist:' + item, 'shell: bad surface id', item); continue; }
    let a = +m[1], b = m[2] !== undefined ? +m[2] : a;
    if (b < a) [a, b] = [b, a];
    if (b - a > 1e6) { log.once('shell:idrange', 'shell: surface range too large', item); continue; }
    const set = neg ? exc : inc;
    for (let i = a; i <= b; i++) set.add(i);
  }
  const out = [];
  for (const v of inc) if (!exc.has(v)) out.push(v);
  return out.sort((a, b) => a - b);
}

function parseWait(s, old) {
  const k = old ? 10 : 1;
  if (s === undefined || s === '') return [0, 0];
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(s);
  if (m) {
    const a = +m[1] * k, b = +m[2] * k;
    return a <= b ? [a, b] : [b, a];
  }
  const v = Math.abs(toInt(s) || 0) * k;
  return [v, v];
}

/**
 * Pattern field parsing (SH §2.10).
 * @param {string} raw value after "animationA.patternP,"
 * @param {boolean} old old SERIKO syntax (surface,wait,method,x,y; waits in 10 ms)
 * @param {number} index
 * @returns {Pattern}
 */
export function parsePattern(raw, old, index) {
  let ids = null;
  const m = /[([]\s*([^)\]]*)[)\]]/.exec(raw);
  if (m) {
    ids = m[1].split(/[,.]/).map(t => toInt(t.trim())).filter(Number.isFinite);
    raw = raw.slice(0, m.index) + raw.slice(m.index + m[0].length);
  }
  let f = raw.split(',').map(t => t.trim());
  if (old) f = [f[2], f[0], f[1], f[3], f[4], ...f.slice(5)];
  let method = (f[0] || 'base').toLowerCase();
  method = METHOD_ALIASES[method] || method;
  const surf = f[1], wait = f[2], x = f[3], y = f[4];
  const p = { index, method, surface: NaN, wmin: 0, wmax: 0, x: 0, y: 0, ids: null, alpha: undefined };
  if (method === 'start' || method === 'stop' || method === 'insert') {
    // documented "start,ID" (ID in the surface slot); Tsubasa / mechanical old conversion "insert,0,0,ID" (x slot)
    let id = ids && ids.length ? ids[0] : toInt(surf);
    if ((!ids || !ids.length) && id === 0 && x !== undefined && x !== '') id = toInt(x);
    p.ids = Number.isFinite(id) ? [id] : [];
    return p;
  }
  if (CONTROL.has(method)) {
    p.ids = ids && ids.length ? ids : [toInt(surf)].filter(Number.isFinite);
    return p;
  }
  [p.wmin, p.wmax] = parseWait(wait, old);
  p.x = toInt(x) || 0;
  p.y = toInt(y) || 0;
  if (method === 'move') p.surface = toInt(surf);   // -1 resets the offset
  else {
    p.surface = toInt(surf);
    if (!Number.isFinite(p.surface)) {
      // SSP 2.8.25 allows surface names/aliases here (P2)
      log.once('shell:patsurf:' + surf, 'shell: unsupported pattern surface', surf);
      p.surface = -1;
    }
    for (let i = 5; i < f.length; i++) {
      if (/^--alpha$/i.test(f[i]) && f[i + 1] !== undefined) p.alpha = Math.max(0, Math.min(255, toInt(f[i + 1]) || 0));
      const am = /^--alpha=(\d+)$/i.exec(f[i] || '');
      if (am) p.alpha = Math.min(255, +am[1]);
    }
  }
  return p;
}

/** interval spec "bind+runonce", "random,6", "talk" -> {atoms, param} */
export function parseInterval(s) {
  const i = s.indexOf(',');
  const spec = (i < 0 ? s : s.slice(0, i)).trim().toLowerCase();
  const param = i < 0 ? 0 : toInt(s.slice(i + 1).trim()) || 0;
  const atoms = new Set();
  for (const a of spec.split('+')) {
    const t = a.trim();
    if (!t) continue;
    if (ATOMS.has(t)) atoms.add(t);
    else log.once('shell:interval:' + t, 'shell: unknown interval', t);
  }
  return { atoms, param };
}

function parseOption(s) {
  const o = { exclusive: null, background: false, sharedIndex: false };
  let ids = null;
  const m = /[([]\s*([^)\]]*)[)\]]/.exec(s);
  if (m) {
    ids = m[1].split(/[,.]/).map(t => toInt(t.trim())).filter(Number.isFinite);
    s = s.slice(0, m.index) + s.slice(m.index + m[0].length);
  }
  for (const part of s.split(/[+,]/)) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (t === 'exclusive') o.exclusive = ids && ids.length ? ids : true;
    else if (t === 'background') o.background = true;
    else if (t === 'shared-index') o.sharedIndex = true;
    else log.once('shell:option:' + t, 'shell: unsupported animation option', t);
  }
  return o;
}

/** "x1,y1,x2,y2,ID" */
function parseCollision(s, index) {
  const f = s.split(',');
  if (f.length < 5) return null;
  let x1 = toInt(f[0]), y1 = toInt(f[1]), x2 = toInt(f[2]), y2 = toInt(f[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  return { kind: 'rect', id: f.slice(4).join(',').trim(), index, x1, y1, x2, y2 };
}

/** collisionex "ID,type,coords..." */
function parseCollisionEx(s, index) {
  const f = s.split(',').map(t => t.trim());
  const id = f[0] || '', type = (f[1] || '').toLowerCase();
  const n = f.slice(2).map(toInt);
  if (type === 'rect' || type === 'ellipse') {
    if (n.length < 4 || !n.slice(0, 4).every(Number.isFinite)) return null;
    let [x1, y1, x2, y2] = n;
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    return { kind: type, id, index, x1, y1, x2, y2 };
  }
  if (type === 'circle') {
    if (n.length < 3 || !n.slice(0, 3).every(Number.isFinite)) return null;
    return { kind: 'circle', id, index, cx: n[0], cy: n[1], r: n[2] };
  }
  if (type === 'polygon') {
    const pts = n.filter(Number.isFinite);
    if (pts.length < 6) return null;
    return { kind: 'polygon', id, index, pts: pts.slice(0, pts.length & ~1) };
  }
  if (type === 'region') {
    log.once('shell:collisionex:region', 'shell: collisionex region is not supported');
    return null;
  }
  log.once('shell:collisionex:' + type, 'shell: unknown collisionex type', type);
  return null;
}

class RawAnim {
  constructor(id, old) {
    this.id = id;
    this.old = old;
    this.interval = null;   // raw interval value (parsed when the animation is first resolved)
    this.option = null;     // raw option value
    this.name = undefined;
    this.patterns = new Map();  // index -> raw pattern value
    this.collisions = new Map(); // 'c<K>' / 'x<K>' -> Collision
    this._def = undefined;
  }
}

/** A surface block. Its lines are parsed on first use (Shell.surface), not at load. */
class Block {
  constructor(file, line, src) {
    this.file = file;
    this.line = line;
    this.src = src;                  // raw content text until parsed
    this.elements = null;            // element records in read order, a repeated number included
    this.collisions = null;          // key 'c<N>' / 'x<N>' -> Collision (order of first appearance)
    this.anims = null;               // id -> RawAnim
    this.keys = null;
  }
  ensure() {
    if (this.anims === null) {
      this.elements = [];
      this.collisions = new Map();
      this.anims = new Map();
      this.keys = new Map();
      parseBlockLines(this, this.src);
      this.src = null;
    }
    return this;
  }
}

/** Freeze one RawAnim (or several merged in load order) into an AnimDef. Patterns are parsed here, lazily. */
function finishAnim(raws) {
  const id = raws[0].id;
  let interval = null, option = null, name;
  const patterns = new Map(), colls = new Map();
  for (const r of raws) {
    if (r.interval !== null) interval = r.interval;
    if (r.option !== null) option = r.option;
    if (r.name !== undefined) name = r.name;
    for (const [k, v] of r.patterns) patterns.set(k, { raw: v, old: r.old });
    for (const [k, v] of r.collisions) colls.set(k, v);
  }
  if (interval === null) {
    log.once('shell:nointerval:' + id, 'shell: animation without interval ignored', id);
    return null;
  }
  const { atoms, param } = parseInterval(interval);
  const isBind = atoms.has('bind');
  const pats = [];
  for (const [index, p] of patterns) pats.push(parsePattern(p.raw, p.old, index));
  pats.sort((a, b) => a.index - b.index);
  if (!pats.length && !isBind) return null;
  const opt = option !== null ? parseOption(option) : null;
  return {
    id,
    atoms,
    param,
    isBind,
    isPureBind: isBind && atoms.size === 1,
    exclusive: opt && !isBind ? opt.exclusive : null,
    background: !!(opt && opt.background),
    sharedIndex: !!(opt && opt.sharedIndex),
    patterns: pats,
    collisions: [...colls.values()],
    name,
  };
}

function rawDef(raw) {
  if (raw._def === undefined) raw._def = finishAnim([raw]);
  return raw._def;
}

const SORTS = { collision: new Set(['none', 'ascend', 'descend']), animation: new Set(['ascend', 'descend']) };

function sortCollisions(list, mode) {
  if (mode === 'ascend') return list.slice().sort((a, b) => a.index - b.index);
  if (mode === 'descend') return list.slice().sort((a, b) => b.index - a.index);
  return list;
}

export class Shell {
  constructor() {
    /** @type {Map<string,string>} shell descript.txt, keys lower-cased, first value wins (as parseDescript) */
    this.descript = new Map();
    /** @type {Array<[string,string]>} every descript line [key lower-cased, value] in file order, repeats included */
    this.descriptLines = [];
    /** surface id -> {blocks: Block[], textDefined: boolean} */
    this._table = new Map();
    /** surface id -> real png file name */
    this._png = new Map();
    /** lower-cased relative path -> real path (shell folder listing), when known */
    this._files = null;
    this._dirs = null;           // lower-cased folder ('' or ending in '/') -> its files, for resolveFile's lookup
    this._aliases = new Map();   // scope -> Map<key, number[]>
    this._cursors = new Map();   // scope -> [{event, index, collision, cursor}]
    this._tooltips = new Map();  // scope -> Map<collision, text>
    this._resolved = new Map();  // LRU of resolved surfaces
    this._resolvedMax = 192;
    this._groups = null;
    this.stats = { blocks: 0, lines: 0, files: [] };
  }

  // ------------------------------------------------------------------ surfaces

  /** @returns {boolean} the surface exists (text-defined or surfaceN.png) */
  hasSurface(id) {
    const e = this._table.get(id);
    return (e !== undefined && e.textDefined) || this._png.has(id);
  }

  /** All existing surface ids, ascending. */
  surfaceIds() {
    const ids = new Set(this._png.keys());
    for (const [id, e] of this._table) if (e.textDefined) ids.add(id);
    return [...ids].sort((a, b) => a - b);
  }

  /** real file name of surfaceN.png, or null */
  pngOf(id) { return this._png.get(id) || null; }

  /**
   * Resolve (merge) a surface. Cached (LRU).
   * @returns {SurfaceDef|null}
   */
  surface(id) {
    const hit = this._resolved.get(id);
    if (hit !== undefined) {
      this._resolved.delete(id);
      this._resolved.set(id, hit);
      return hit;
    }
    if (!this.hasSurface(id)) return null;
    const s = this._resolve(id);
    this._resolved.set(id, s);
    if (this._resolved.size > this._resolvedMax) this._resolved.delete(this._resolved.keys().next().value);
    return s;
  }

  _resolve(id) {
    const entry = this._table.get(id);
    const blocks = entry ? entry.blocks : [];
    const elements = new Map(), elementsRead = [], colls = new Map(), keys = new Map();
    const animRaws = new Map();
    for (const b of blocks) {
      b.ensure();
      for (const e of b.elements) { elements.set(e.index, e); elementsRead.push(e); }
      for (const [k, v] of b.collisions) colls.set(k, v);
      for (const [k, v] of b.keys) keys.set(k, v);
      for (const [aid, raw] of b.anims) {
        const list = animRaws.get(aid);
        if (list) list.push(raw); else animRaws.set(aid, [raw]);
      }
    }
    const anims = new Map();
    for (const [aid, raws] of animRaws) {
      const def = raws.length === 1 ? rawDef(raws[0]) : finishAnim(raws);
      if (def) anims.set(aid, def);
    }
    const file = blocks.length ? blocks[0].file : null;
    const collisionSort = file ? file.collisionSort : 'none';
    const animationSort = file ? file.animationSort : 'descend';
    const drawOrder = [...anims.keys()].sort(animationSort === 'descend' ? (a, b) => a - b : (a, b) => b - a);
    let basepos = null;
    const bx = toInt(keys.get('point.basepos.x')), by = toInt(keys.get('point.basepos.y'));
    if (Number.isFinite(bx) || Number.isFinite(by)) basepos = { x: Number.isFinite(bx) ? bx : NaN, y: Number.isFinite(by) ? by : NaN };
    return {
      id,
      png: this._png.get(id) || null,
      elements: [...elements.values()].sort((a, b) => a.index - b.index),
      elementsRead,
      collisions: sortCollisions([...colls.values()], collisionSort),
      collisionSort,
      anims,
      drawOrder,
      keys,
      basepos,
      textDefined: !!(entry && entry.textDefined),
    };
  }

  /**
   * Real path of a shell-relative file (case-insensitive, '\' = '/'), or the normalised input if unknown. An image
   * named without its extension, or with one no file has, is SSP's any-extension lookup (core/loadable.js):
   * SPSurfaceManager::LoadInfo searches it for element files [disasm 2.9.10.3000 0x778443]
   * (`element0,overlay,surface0,0,0` in shop_robin is surface0.png).
   */
  resolveFile(path) {
    const norm = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!this._files) return norm;
    const hit = this._files.get(norm.toLowerCase());
    if (hit) return hit;
    if (!this._dirs) {
      this._dirs = new Map();
      for (const p of this._files.values()) {
        const d = p.slice(0, p.lastIndexOf('/') + 1).toLowerCase();
        if (!this._dirs.has(d)) this._dirs.set(d, []);
        this._dirs.get(d).push(p);
      }
    }
    return pickLoadable(this._dirs.get(norm.slice(0, norm.lastIndexOf('/') + 1).toLowerCase()) || [], norm);
  }

  // ------------------------------------------------------------------ aliases, cursors, tooltips

  /**
   * Resolve a surface alias for a scope; random pick when several ids are listed. Numbers pass through.
   * \s[a,b] is one string (SS §3.4): SPSeriko::GetSurfaceIndexChar 0x6e9220 splits it at commas and looks each part
   * up as an alias in turn; with none, the whole string is read as its leading number (SPSeriko_wcstonum 0x6e97f0:
   * `0,wait` is 0, `20,200` is 20) [disasm].
   */
  alias(scope, id, random = Math.random) {
    const m = this._aliases.get(scope);
    const key = String(id);
    const parts = typeof id === 'number' ? [key] : key.split(',');
    if (m) {
      for (const p of parts) {
        const ids = m.get(p);
        if (ids && ids.length) return ids[Math.min(ids.length - 1, Math.floor(random() * ids.length))];
      }
    }
    if (typeof id === 'number') return id;
    if (parts.length > 1) return wcstonum(key);
    return /^\s*-?\d+\s*$/.test(key) ? parseInt(key, 10) : NaN;
  }

  /** sakura.cursor rules: [{event:'mouseup'|'mousedown'|'mouserightdown'|'mousewheel'|'mousehover', index, collision, cursor}] */
  cursors(scope) { return this._cursors.get(scope) || []; }

  /**
   * CSS cursor for a pointer state over a collision (SH §2.16). Rules are matched by (event, collision), ignoring N.
   * @param {string} event 'mouseup' | 'mousedown' | ...
   * @param {string|null} collision null = not on the character
   * @param {(file:string)=>string|null} [toUrl] cursor file (relative to the shell folder) -> absolute URL
   */
  cursorFor(scope, event, collision, toUrl = null) {
    if (collision === null || collision === undefined) return 'default';
    for (const r of this.cursors(scope)) {
      if (r.event === event && r.collision === collision) return cssCursor(r.cursor, toUrl);
    }
    if (collision === '') return 'default';
    const bust = collision.toLowerCase() === 'bust';
    if (event === 'mousedown') return bust ? 'grabbing' : 'pointer';
    if (event === 'mouseup') return bust ? 'grab' : 'pointer';
    return 'default';
  }

  /**
   * The shell's own tooltip for a collision (`<scope>.tooltips`, SH §2.16): matched without case, a later line for the
   * same name replaces an earlier one, an empty name never matches [disasm SPSerikoToolTipsEntry::Set / Find]. The
   * text as written (tipText converts `\n`); null when the block has none.
   */
  tooltip(scope, collision) {
    const m = this._tooltips.get(scope);
    if (!m || !collision) return null;
    return m.get(String(collision).toLowerCase()) || null;
  }

  // ------------------------------------------------------------------ descript-derived data

  /** Shell descript value for a scope key: `<scopeName>.<key>` (char0/char1 accepted for sakura/kero). */
  scopeValue(scope, key) {
    const d = this.descript;
    const k = key.toLowerCase();
    const v = d.get(scopeName(scope) + '.' + k);
    if (v !== undefined) return v;
    if (scope < 2) return d.get('char' + scope + '.' + k);
    return undefined;
  }

  /**
   * Dress-up data of every scope, read from the descript's lines one by one in file order (SH §4.3; SSP's
   * SPBindProp::ParseEntry [disasm]). bindgroup keys: the first line of a key wins, as in the descript Map.
   * bindoption: every line counts (DSLGS repeats `sakura.bindoption0.group`; etherism writes `bindoption.group`
   * unnumbered) [infer]; a later line for the same category replaces its options [guess]. menuitem / menuitemex: file
   * order; N is only a key, a repeated N overwrites in place [disasm].
   */
  _loadGroups() {
    if (this._groups) return this._groups;
    const groups = new Map(), options = new Map(), records = new Map(), seen = new Set();
    const get = (map, scope, mk) => { let v = map.get(scope); if (!v) map.set(scope, v = mk()); return v; };
    const RE_G = /^(sakura|kero|char\d+)\.bindgroup(\d+)\.(name|default|addid)$/;
    const RE_O = /^(sakura|kero|char\d+)\.bindoption(\d*)\.group$/;
    const RE_M = /^(sakura|kero|char\d+)\.(menuitem|menuitemex)(\d+)$/;
    for (const [k, v] of this.descriptLines) {
      if (k.indexOf('.bind') < 0 && k.indexOf('.menuitem') < 0) continue;
      let m = RE_G.exec(k);
      if (m) {
        if (seen.has(k)) continue;
        seen.add(k);
        const scope = scopeOf(m[1]), id = +m[2];
        // a group is created by its first line (definition order = SSP's entry order)
        const g = get(get(groups, scope, () => new Map()), id, () => ({ id, category: '', part: '', thumbnail: '', default: false, addid: [], named: false }));
        if (m[3] === 'name') {
          const f = v.split(',');
          g.category = (f[0] || '').trim();
          g.part = (f[1] || '').trim();
          g.thumbnail = f.slice(2).join(',').trim();
          g.named = true;
        } else if (m[3] === 'default') g.default = v.trim() === '1' || /^true$/i.test(v.trim());
        else g.addid = v.split(',').map(t => toInt(t.trim())).filter(Number.isFinite);
        continue;
      }
      m = RE_O.exec(k);
      if (m) {
        const scope = scopeOf(m[1]);
        const f = v.split(',');
        const cat = (f[0] || '').trim();
        const opts = f.slice(1).join('+').toLowerCase().split('+').map(t => t.trim()).filter(Boolean);
        get(options, scope, () => new Map()).set(cat, { mustSelect: opts.includes('mustselect'), multiple: opts.includes('multiple'), raw: opts });
        continue;
      }
      m = RE_M.exec(k);
      if (m) {
        const scope = scopeOf(m[1]);
        const r = get(records, scope, () => ({ list: [], at: new Map() }));
        const key = (m[2] === 'menuitemex' ? 'x' : 'm') + +m[3];
        const rec = { ex: m[2] === 'menuitemex', n: +m[3], value: v.trim() };
        if (r.at.has(key)) {
          log.once(`shell:menuitem2:${m[1]}:${key}`, `shell: ${k} defined twice; the later value is used`);
          r.list[r.at.get(key)] = rec;
        } else {
          r.at.set(key, r.list.length);
          r.list.push(rec);
        }
      }
    }
    const out = { groups: new Map(), defined: new Map(), options, menus: new Map(), hasMenu: new Set(records.keys()), catOrder: new Map() };
    for (const [scope, map] of groups) {
      const list = [...map.values()].filter(g => g.named);
      for (const g of list) delete g.named;
      out.defined.set(scope, list);
      out.groups.set(scope, list.slice().sort((a, b) => a.id - b.id));
    }
    for (const [scope, r] of records) out.menus.set(scope, buildDressupMenu(scope, r.list, out.groups.get(scope) || []));
    return (this._groups = out);
  }

  /** @returns {BindGroup[]} ascending id */
  bindGroups(scope) { return this._loadGroups().groups.get(scope) || []; }

  /** The same groups in descript definition order (SSP's entry order: OnNotifyDressupInfo, category rules). */
  bindGroupsInFileOrder(scope) { return this._loadGroups().defined.get(scope) || []; }

  /** scopes that define bind groups, ascending */
  bindScopes() { return [...this._loadGroups().groups.keys()].sort((a, b) => a - b); }

  /** @returns {Map<string,{mustSelect:boolean, multiple:boolean, raw:string[]}>} category -> options (every bindoption line) */
  bindOptions(scope) { return this._loadGroups().options.get(scope) || new Map(); }

  /**
   * Manual dress-up menu of a scope (SH §4.3.1): `menuitem*` / `menuitemex*` records in descript file order. Group ids,
   * '-' separators (any value not starting with a digit) and `{menu, items}` submenus (menuitemex, placed at their
   * first record). Ids that name no bind group and submenus left without a part are dropped [disasm].
   * @returns {Array<number|'-'|{menu:string, items:Array<number|'-'>}>}
   */
  dressupMenu(scope) { return this._loadGroups().menus.get(scope) || []; }

  /** any menuitem / menuitemex line for the scope (manual mode without one greys Clothes/Dressup ▸) [disasm] */
  hasMenuItems(scope) { return this._loadGroups().hasMenu.has(scope); }

  /** `<scope>.menu`: contains `auto` → 'auto', contains `hid` → 'hidden', else 'manual' [disasm ParseEntry] */
  dressupMode(scope) {
    const v = String(this.scopeValue(scope, 'menu') || '').toLowerCase();
    return v.includes('auto') ? 'auto' : v.includes('hid') ? 'hidden' : 'manual';
  }

  /**
   * Category order of a scope (SH §4.3.2; SSP's SPBindProp::CheckEntry [disasm]): categories in order of creation,
   * stably sorted by the menu position of their first part (definition order) that a menuitem lists; categories
   * with no listed part follow in creation order. Orders OnNotifyDressupInfo and the auto-mode menu.
   * @returns {string[]}
   */
  bindCategoryOrder(scope) {
    const data = this._loadGroups();
    let order = data.catOrder.get(scope);
    if (order) return order;
    const pos = new Map();
    let i = 0;
    const walk = list => {
      for (const x of list) {
        if (typeof x === 'number') { if (!pos.has(x)) pos.set(x, i); } else if (x && typeof x === 'object') walk(x.items);
        i++;
      }
    };
    walk(this.dressupMenu(scope));
    const cats = new Map();
    for (const g of this.bindGroupsInFileOrder(scope)) {
      if (!cats.has(g.category)) cats.set(g.category, Infinity);
      if (cats.get(g.category) === Infinity && pos.has(g.id)) cats.set(g.category, pos.get(g.id));
    }
    order = [...cats].map(([c, p], k) => ({ c, p, k })).sort((a, b) => (a.p - b.p) || (a.k - b.k)).map(e => e.c);
    data.catOrder.set(scope, order);
    return order;
  }

  /** Descript balloon offset for a scope (char<n> -> kero fallback for n >= 2). Default 0,0. */
  balloonOffset(scope) {
    const pick = axis => {
      let v = this.scopeValue(scope, 'balloon.offset' + axis);
      if (v === undefined && scope >= 2) v = this.descript.get('kero.balloon.offset' + axis);
      return toInt(v) || 0;
    };
    return { x: pick('x'), y: pick('y') };
  }

  /** What the right-click menu needs from the shell descript (SH §4.2). */
  get menuInfo() {
    if (this._menuInfo) return this._menuInfo;
    const d = this.descript;
    const rgb = pre => {
      const r = toInt(d.get(pre + '.r')), g = toInt(d.get(pre + '.g')), b = toInt(d.get(pre + '.b'));
      return [r, g, b].some(Number.isFinite) ? [r || 0, g || 0, b || 0] : null;
    };
    const bmp = name => {
      const file = d.get(`menu.${name}.bitmap.filename`);
      return { file: file ? this.resolveFile(file) || file : null, alignment: (d.get(`menu.${name}.alignment`) || '').toLowerCase() || null };
    };
    return (this._menuInfo = {
      font: { name: d.get('menu.font.name') || null, height: toInt(d.get('menu.font.height')) || null },
      background: bmp('background'),
      foreground: bmp('foreground'),
      sidebar: bmp('sidebar'),
      colors: {
        backgroundFont: rgb('menu.background.font.color'),
        foregroundFont: rgb('menu.foreground.font.color'),
        separator: rgb('menu.separator.color'),
        disableFont: rgb('menu.disable.font.color'),
        frame: rgb('menu.frame.color'),
      },
      hidden: (d.get('menu') || '').toLowerCase() === 'hidden',
    });
  }
}

/**
 * The manual dress-up menu from a scope's menuitem records (SH §4.3.1; SSP's CCharWndCode::UpdateBindMenu [disasm]).
 * `menuitemN,<value>`: a value starting with a digit is a bind-group id, anything else a separator.
 * `menuitemexN,<menu name>,<id>`: the part goes into a submenu of that name, created at its first record; a non-digit
 * id is a separator inside it; fewer than 2 fields: ignored.
 */
function buildDressupMenu(scope, records, groups) {
  const ids = new Set(groups.map(g => g.id));
  const top = [], subs = new Map();
  const item = (value, line) => {
    if (!/^\d/.test(value)) return '-';
    const id = parseInt(value, 10);
    if (ids.has(id)) return id;
    log.once(`shell:menuitem:${scope}:${id}`, `shell: ${scopeName(scope)}.${line} names no bind group (${id}); left out`);
    return null;
  };
  for (const r of records) {
    if (!r.ex) {
      const x = item(r.value, 'menuitem' + r.n);
      if (x !== null) top.push(x);
      continue;
    }
    const f = r.value.split(',');
    if (f.length < 2) { log.once(`shell:menuitemex:${scope}:${r.n}`, `shell: ${scopeName(scope)}.menuitemex${r.n} needs a menu name and an id; ignored`); continue; }
    const name = f[0].trim();
    let sub = subs.get(name);
    if (!sub) { subs.set(name, sub = { menu: name, items: [] }); top.push(sub); }
    const x = item(f[1].trim(), 'menuitemex' + r.n);
    if (x !== null) sub.items.push(x);
  }
  return top.filter(x => typeof x !== 'object' || x.items.some(i => i !== '-'));
}

/**
 * descript.txt lines (SH §4.1): trimmed `key,value` pairs in file order, keys lower-cased, `//` comments and lines
 * without a comma skipped (the rules of parseDescript in core/loader.js, without dropping repeated keys).
 * @returns {Array<[string,string]>}
 */
export function descriptLines(text) {
  const out = [];
  for (let line of String(text).split(/\r\n|\r|\n/)) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    const i = line.indexOf(',');
    if (i < 0) continue;
    out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
  }
  return out;
}

/**
 * system cursor names and files -> CSS cursor values (SH §2.16). Cursor files are relative to the shell folder:
 * `toUrl` turns them into absolute URLs (null = no such file -> 'default'); without it the path is kept as is.
 * @param {(file:string)=>string|null} [toUrl]
 */
export function cssCursor(v, toUrl = null) {
  const s = String(v || '').trim();
  const m = /^system:(\w+)$/i.exec(s);
  if (m) {
    return ({ arrow: 'default', cross: 'crosshair', no: 'not-allowed', hand: 'grab', grip: 'grabbing', finger: 'pointer',
      wait: 'wait', text: 'text', move: 'move', help: 'help' })[m[1].toLowerCase()] || 'default';
  }
  if (/\.cur$/i.test(s)) {
    const file = s.replace(/\\/g, '/');
    const url = toUrl ? toUrl(file) : file;
    return url ? `url("${String(url).replace(/["\\]/g, '\\$&')}"), auto` : 'default';
  }
  return 'default';
}

/**
 * Sort surfaces*.txt names like SSP (ordinal comparison of upper-cased names, SH §1.4).
 * @param {string[]} names
 */
export function sortSurfaceFiles(names) {
  return names.slice().sort((a, b) => {
    const A = a.toUpperCase(), B = b.toUpperCase();
    return A < B ? -1 : A > B ? 1 : 0;
  });
}

/**
 * Parse a shell.
 * @param {{descript: string|Map<string,string>, surfaces: (string|{name:string,text:string})[], files?: string[]}} input
 *   files: names of the files in the shell folder (relative paths); used for surfaceN.png discovery and
 *   case-insensitive element file lookup. Without it, only text-defined surfaces exist.
 * @returns {Shell}
 */
export function parseShell({ descript, surfaces = [], files = null }) {
  const shell = new Shell();
  if (descript instanceof Map) {
    shell.descript = descript;
    shell.descriptLines = [...descript];
  } else {
    shell.descriptLines = descriptLines(String(descript || ''));
    for (const [k, v] of shell.descriptLines) if (!shell.descript.has(k)) shell.descript.set(k, v);
  }
  if (files) {
    shell._files = new Map();
    for (const f of files) {
      const p = String(f).replace(/\\/g, '/');
      shell._files.set(p.toLowerCase(), p);
      const m = /^surface(\d+)\.png$/i.exec(p);
      if (m) {
        const id = parseInt(m[1], 10);
        const prev = shell._png.get(id);
        if (prev !== undefined) log.once('shell:dup:' + id, 'shell: two images for surface', id, prev, p);
        if (prev === undefined || p.length < prev.length) shell._png.set(id, p);
      }
    }
  }
  surfaces.forEach((src, i) => {
    const name = typeof src === 'string' ? `surfaces#${i}` : src.name;
    const text = typeof src === 'string' ? src : src.text;
    parseSurfacesText(shell, String(text || ''), name);
  });
  return shell;
}

/** content lines of a block: trimmed, without empty lines and // comments */
function blockLines(src) {
  const out = [];
  for (const raw of src.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('//')) out.push(line);
  }
  return out;
}

/**
 * Scan one surfaces*.txt (or alias.txt): find the blocks (SH §2.2 state machine) without allocating anything
 * for the lines inside them; surface blocks are parsed later, on demand.
 */
function parseSurfacesText(shell, text, name) {
  const file = { name, version: 0, collisionSort: 'none', animationSort: 'descend' };
  shell.stats.files.push(file);
  if (text.indexOf('\n') < 0 && text.indexOf('\r') >= 0) text = text.replace(/\r/g, '\n');
  const len = text.length;
  let pos = 0, lineNo = 0, pending = null, pendingLine = 0, first = true;
  let inBlock = false, header = null, headerLine = 0, start = 0, count = 0;
  let prevStart = -1, prevEnd = 0, prevLine = 0;     // the last content line inside the open block
  /** A block opens before the open one was closed: its "}" is missing, so it ends where the new header starts. */
  const reopen = (cut, newHeader, newHeaderLine, newStart, n) => {
    log.once('shell:noclose:' + name, `shell: "}" not found before line ${newHeaderLine} of ${name}; a new block starts there`);
    finishBlock(shell, file, header, headerLine, text.slice(start, cut), n);
    header = newHeader; headerLine = newHeaderLine; start = newStart; count = 0; prevStart = -1;
  };
  while (pos < len) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = len;
    lineNo++;
    let i = pos;
    for (; i < nl; i++) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 9 && c !== 13 && c !== 0x3000 && c !== 0xfeff) break;
    }
    if (i < nl) {
      const c = text.charCodeAt(i);
      const comment = c === 47 && text.charCodeAt(i + 1) === 47;
      if (inBlock) {
        if (c === 125) {
          finishBlock(shell, file, header, headerLine, text.slice(start, pos), count);
          inBlock = false;
          prevStart = -1;
        } else if (c === 123 && prevStart >= 0) {
          // "{" inside a block (SH §2.2, lenient): the "}" before the line above was forgotten, and that line heads
          // the next block (type01-Mono: "surface1020 { … surface1021 { … }")
          reopen(prevStart, text.slice(prevStart, prevEnd).trim(), prevLine, nl + 1, count - 1);
        } else if (!comment) {
          let e = nl - 1;
          while (e > i && (text.charCodeAt(e) === 13 || text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e--;
          if (text.charCodeAt(e) === 123 && HEADER_START.test(text.slice(i, Math.min(e, i + 32)))) {
            reopen(i, text.slice(i, e).trim(), lineNo, nl + 1, count);       // "surface5 {" inside a block, likewise
          } else {
            count++;
            prevStart = i; prevEnd = nl; prevLine = lineNo;
          }
        }
      } else if (!comment) {
        const line = text.slice(i, nl).trim();
        const wasFirst = first;
        first = false;
        if (wasFirst && /^charset\s*,/i.test(line)) {
          // consumed by the decoder
        } else if (c === 123) {
          if (line.length > 1) log.once('shell:braceextra', `shell: extra character after "{" (${name}:${lineNo})`);
          inBlock = true; header = pending; headerLine = pendingLine; pending = null; start = nl + 1; count = 0;
        } else {
          const m = /^(.+?)\s*\{\s*$/.exec(line);
          if (m) {
            log.once('shell:inlinebrace', `shell: "{" on the header line (${name}:${lineNo})`);
            inBlock = true; header = m[1]; headerLine = lineNo; pending = null; start = nl + 1; count = 0;
          } else {
            if (pending !== null) log.once('shell:nobrace:' + pending, `shell: "{" not found after ${pending} (${name}:${pendingLine})`);
            pending = line;
            pendingLine = lineNo;
          }
        }
      }
    }
    pos = nl + 1;
  }
  if (inBlock) {
    log.once('shell:noclose:' + name, `shell: "}" not found at the end of ${name}`);
    finishBlock(shell, file, header, headerLine, text.slice(start), count);
  }
}

function finishBlock(shell, file, rawHeader, line, src, count) {
  shell.stats.blocks++;
  shell.stats.lines += count;
  const header = (rawHeader || '').trim();
  const h = header.toLowerCase();
  if (h === 'descript') {
    for (const l of blockLines(src)) {
      const i = l.indexOf(',');
      if (i < 0) continue;
      const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim().toLowerCase();
      if (k === 'version') file.version = toInt(v) || 0;
      else if (k === 'collision-sort' && SORTS.collision.has(v)) file.collisionSort = v;
      else if (k === 'animation-sort' && SORTS.animation.has(v)) file.animationSort = v;
    }
    return;
  }
  if (h.startsWith('surface.append')) {
    const ids = parseIdList(header.slice('surface.append'.length));
    const block = new Block(file, line, src);
    for (const id of ids) {
      const e = shell._table.get(id);
      if (e && e.textDefined) e.blocks.push(block);
      else if (shell._png.has(id)) {
        if (e) e.blocks.push(block); else shell._table.set(id, { blocks: [block], textDefined: false });
      }
    }
    return;
  }
  if (h.startsWith('surface') && /^surface\s*[!\d]/.test(h)) {
    const ids = parseIdList(header.slice('surface'.length));
    const block = new Block(file, line, src);
    for (const id of ids) {
      const e = shell._table.get(id);
      if (e) { e.blocks.push(block); e.textDefined = true; } else shell._table.set(id, { blocks: [block], textDefined: true });
    }
    return;
  }
  const m = RE_SCOPE_BLOCK.exec(h);
  if (m) {
    const scope = scopeOf(m[1]);
    const lines = blockLines(src);
    if (m[3] === 'surface.alias') {
      let map = shell._aliases.get(scope);
      if (!map) shell._aliases.set(scope, map = new Map());
      for (const l of lines) {
        const i = l.indexOf(',');
        if (i < 0) continue;
        const ids = (l.slice(i + 1).match(/-?\d+/g) || []).map(Number);
        map.set(l.slice(0, i).trim(), ids);
      }
    } else if (m[3] === 'cursor') {
      const list = shell._cursors.get(scope) || [];
      for (const l of lines) {
        const f = l.split(',');
        const km = /^(mouseup|mousedown|mouserightdown|mousewheel|mousehover)(\d*)$/i.exec((f[0] || '').trim());
        if (!km || f.length < 3) continue;
        list.push({ event: km[1].toLowerCase(), index: toInt(km[2]) || 0, collision: f[1].trim(), cursor: f.slice(2).join(',').trim() });
      }
      shell._cursors.set(scope, list);
    } else {
      let map = shell._tooltips.get(scope);
      if (!map) shell._tooltips.set(scope, map = new Map());
      for (const l of lines) {
        const i = l.indexOf(',');
        const name = i > 0 ? l.slice(0, i).trim().toLowerCase() : '';
        const text = i > 0 ? l.slice(i + 1).trim() : '';
        if (!name) continue;
        if (text) map.set(name, text); else map.delete(name);   // an empty text removes the entry [disasm Add]
      }
    }
    return;
  }
  log.once('shell:block:' + h, `shell: unknown block "${header}" (${file.name}:${line}) ignored`);
}

function parseBlockLines(b, src) {
  const file = b.file;
  let warned = false;
  for (const line of blockLines(src)) {
    const i = line.indexOf(',');
    if (i < 0) continue;
    let key = line.slice(0, i);
    if (/[A-Z\s]/.test(key)) key = key.trim().toLowerCase();
    const val = line.slice(i + 1);
    const c0 = key.charCodeAt(0);
    let m;
    const kind = c0 === 97 ? animKey(key, true) : c0 >= 48 && c0 <= 57 ? animKey(key, false) : K_NONE;
    if (kind !== K_NONE) {
      const old = c0 !== 97;
      if (!warned && old !== (file.version === 0)) {
        warned = true;
        log.once('shell:syntax:' + file.name, `shell: ${old ? 'old' : 'new'} SERIKO syntax in a version ${file.version} file (${file.name})`);
      }
      let a = b.anims.get(K_ID);
      if (!a) b.anims.set(K_ID, a = new RawAnim(K_ID, old));
      switch (kind) {
        case K_PATTERN: a.patterns.set(K_IDX, val); break;
        case K_INTERVAL: a.interval = val; break;
        case K_OPTION: a.option = val; break;
        case K_NAME: a.name = val.trim(); break;
        case K_COLL: { const idx = K_IDX, c = parseCollision(val, idx); if (c) a.collisions.set('c' + idx, c); break; }
        case K_COLLEX: { const idx = K_IDX, c = parseCollisionEx(val, idx); if (c) a.collisions.set('x' + idx, c); break; }
      }
      continue;
    }
    if (c0 === 101 && (m = RE_ELEMENT.exec(key))) {
      const f = val.split(',').map(t => t.trim());
      if (f.length < 2) continue;
      const opts = f.slice(4).filter(t => t.startsWith('--'));
      if (opts.length) log.once('shell:elemopt', 'shell: element options are not supported', opts.join(' '));
      b.elements.push({ index: +m[1], method: (METHOD_ALIASES[f[0].toLowerCase()] || f[0].toLowerCase()), file: f[1], x: toInt(f[2]) || 0, y: toInt(f[3]) || 0 });
      continue;
    }
    if (c0 === 99) {
      if ((m = RE_COLL.exec(key))) {
        const c = parseCollision(val, +m[1]);
        if (c) b.collisions.set('c' + m[1], c);
        continue;
      }
      if ((m = RE_COLLEX.exec(key))) {
        const c = parseCollisionEx(val, +m[1]);
        if (c) b.collisions.set('x' + m[1], c);
        continue;
      }
    }
    b.keys.set(key, val.trim());
  }
}

/** Balloon offset for a surface (per-surface keys override the descript ones, SH §4.4). */
export function surfaceBalloonOffset(shell, surf, scope) {
  const base = shell.balloonOffset(scope);
  if (!surf) return base;
  const k = surf.keys;
  const pick = (axis, def) => {
    for (const key of [`${scopeName(scope)}.balloon.offset${axis}`, `balloon.offset${axis}`, `balloon.offset.${axis}`]) {
      const v = toInt(k.get(key));
      if (Number.isFinite(v)) return v;
    }
    return def;
  };
  return { x: pick('x', base.x), y: pick('y', base.y) };
}

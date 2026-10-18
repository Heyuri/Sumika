// Image loading for balloons: balloon skin parts and \_b images, decoded once, keyed and cached.
// Paths are looked up in the folder manifest (case-insensitive); a path that is not in it is never fetched
// (74 % of Tsubasa's \_b uses name files that do not exist, on purpose). Sizes come from the PNG header as soon as
// the bytes arrive, so layout does not wait for decoding. Works without a DOM (sizes only) for Node tests.
import { Emitter } from '../core/emitter.js';
import { log } from '../core/log.js';
import { pngSize, applyColorKey, applyMask, forceOpaque, opaqueRects, withoutTrns } from './bitmap.js';
import { canvasLostError, isCanvasLost, releaseCanvas } from '../core/canvas.js';

/** A canvas usable as a drawImage source (OffscreenCanvas when available). */
export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    return c;
  }
  return null;
}

/** True when this environment can decode images (a browser). */
export function canDecode() {
  return typeof createImageBitmap === 'function' && makeCanvas(1, 1) !== null;
}

async function bitmapOf(bytes) {
  return createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/**
 * Decode an image and apply transparency (BA §1.3). The returned canvas is the drawing source; a .pna's canvas is
 * temporary and sized 0×0 once read (core/canvas.js releaseCanvas). A canvas without a 2D context throws
 * canvasLostError (core/canvas.js).
 * @param {ArrayBuffer} bytes
 * @param {{mode?:'key'|'opaque'|'self', mask?:ArrayBuffer|null, paintBlack?:boolean, wantRects?:boolean}} o
 * @returns {Promise<{source:any, w:number, h:number, rects:Array|null}>}
 */
export async function decodeImage(bytes, o = {}) {
  const mode = o.mode || 'key';
  // where PNG alpha is ignored, a transparent pixel keeps its own colour (withoutTrns), as in SSP
  const bmp = await bitmapOf(mode !== 'self' || o.mask ? withoutTrns(bytes) : bytes);
  const w = bmp.width, h = bmp.height;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    if (bmp.close) bmp.close();
    releaseCanvas(c);
    throw canvasLostError('balloon image');
  }
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  let rects = null;
  if (mode !== 'self' || o.mask || o.wantRects) {
    const id = ctx.getImageData(0, 0, w, h);
    if (o.mask) {
      const mb = await bitmapOf(o.mask);
      const mc = makeCanvas(w, h);
      try {
        const mctx = mc.getContext('2d', { willReadFrequently: true });
        if (!mctx) {
          if (mb.close) mb.close();
          releaseCanvas(c);
          throw canvasLostError('balloon image');
        }
        mctx.drawImage(mb, 0, 0);
        if (mb.close) mb.close();
        applyMask(id.data, mctx.getImageData(0, 0, w, h).data, w, h, !!o.paintBlack);
      } finally {
        releaseCanvas(mc);
      }
    } else if (mode === 'opaque') forceOpaque(id.data);
    else if (mode === 'key') applyColorKey(id.data, w, h);
    if (o.wantRects) rects = opaqueRects(id.data, w, h);
    ctx.putImageData(id, 0, 0);
  }
  return { source: c, w, h, rects };
}

/** 'ghost/master/' when files is the ghost root folder, '' when it already is ghost/master. */
export function masterPrefix(files) {
  return files && files.has && files.has('ghost/master/descript.txt') ? 'ghost/master/' : '';
}

/**
 * @typedef {{key:string, path:string, mode:string}} ImageRef
 * @typedef {object} Entry
 * @property {string} key
 * @property {'loading'|'ready'|'error'} status
 * @property {number} w
 * @property {number} h
 * @property {any} source       keyed canvas, or null (not decoded / evicted / no DOM)
 * @property {Promise<Entry>|null} promise
 * @property {number} used      last use (for eviction)
 */

export class ImageStore extends Emitter {
  /**
   * @param {object} files  GhostFiles-like: resolve/has/bytes
   * @param {{prefix?:string, decode?:boolean, budget?:number, onCanvasLost?:Function}} [o]  budget = decoded bytes
   *   kept (default 96 MB); onCanvasLost(): a decode's canvas got no 2D context (canvasLostError, core/canvas.js): the
   *   image fails as any other, and this is called (the runtime ends the ghost)
   */
  constructor(files, o = {}) {
    super();
    this.files = files;
    this.prefix = o.prefix ?? masterPrefix(files);
    this.decode = o.decode ?? canDecode();
    this.budget = o.budget ?? 96 * 1024 * 1024;
    this.onCanvasLost = typeof o.onCanvasLost === 'function' ? o.onCanvasLost : null;
    /** @type {Map<string, Entry>} */
    this.entries = new Map();
    this.bytesInUse = 0;
    this.clock = 0;
    this.refs = new Map(); // mode -> path as written -> ImageRef|null (games resolve the same paths thousands of times)
  }

  /** Real manifest path of a \_b path relative to ghost/master, or null (missing or unsupported: never fetched). */
  resolve(path) {
    const p = String(path ?? '').trim();
    if (!p) return null;
    if (/^[a-z][a-z0-9+.-]+:/i.test(p)) {
      log.once('balloon:url:' + p.slice(0, 40), 'balloon: image URLs are not supported, skipped:', p);
      return null;
    }
    if (/^[a-z]:[\\/]/i.test(p) || p[0] === '/' || p[0] === '\\') {
      log.once('balloon:abs:' + p, 'balloon: absolute image path skipped:', p);
      return null;
    }
    return this.files ? this.files.resolve(this.prefix + p) : null;
  }

  /**
   * Reference for drawing a \_b image; null when the file does not exist.
   * @param {string} path  as written in the script
   * @param {'key'|'opaque'|'self'} [mode]
   * @returns {ImageRef|null}
   */
  ref(path, mode = 'key') {
    let m = this.refs.get(mode);
    if (!m) this.refs.set(mode, (m = new Map()));
    let r = m.get(path);
    if (r === undefined) {
      const real = this.resolve(path);
      r = real ? { key: real + '|' + mode, path: real, mode } : null;
      if (m.size > 20000) m.clear();
      m.set(path, r);
    }
    return r;
  }

  /** Size if known; null while loading (loading starts now); false if it cannot be loaded. */
  info(ref) {
    if (!ref) return false;
    let e = this.entries.get(ref.key);
    if (!e) e = this._load(ref);
    if (e.status === 'error') return false;
    if (e.w > 0 || e.status === 'ready') return { w: e.w, h: e.h };
    return null;
  }

  /** Drawable keyed bitmap, or null (still loading, failed, or no DOM). Re-decodes evicted bitmaps. */
  source(ref) {
    if (!ref) return null;
    const e = this.entries.get(ref.key) || this._load(ref);
    e.used = ++this.clock;
    if (e.source) return e.source;
    if (e.status === 'ready' && this.decode && !e.promise) this._decode(ref, e);
    return null;
  }

  /** Start loading these paths (relative to ghost/master); resolves when all known sizes are in. */
  prefetch(paths, mode = 'key') {
    const ps = [];
    for (const p of paths) {
      const r = this.ref(p, mode);
      if (!r) continue;
      const e = this.entries.get(r.key) || this._load(r);
      if (e.promise) ps.push(e.promise);
    }
    return Promise.all(ps).then(() => undefined);
  }

  /** @returns {Entry} */
  _load(ref) {
    const e = { key: ref.key, status: 'loading', w: 0, h: 0, source: null, promise: null, used: ++this.clock, mask: undefined };
    this.entries.set(ref.key, e);
    e.promise = (async () => {
      try {
        const bytes = await this.files.bytes(ref.path);
        const size = pngSize(bytes);
        if (size) { e.w = size.w; e.h = size.h; }
        if (this.decode) await this._decodeBytes(ref, e, bytes);
        else if (!size) throw new Error('unknown image size');
        e.status = 'ready';
      } catch (err) {
        e.status = 'error';
        if (isCanvasLost(err)) this._lost();
        else log.once('balloon:img:' + ref.path, 'balloon: cannot load image', ref.path, String(err && err.message || err));
      }
      e.promise = null;
      this.emit('load', ref.key);
      return e;
    })();
    return e;
  }

  async _decodeBytes(ref, e, bytes) {
    let mask = null;
    const pna = ref.path.replace(/\.png$/i, '.pna');
    if (pna !== ref.path && this.files.has(pna)) {
      try { mask = await this.files.bytes(pna); } catch (err) { mask = null; }
    }
    const d = await decodeImage(bytes, { mode: ref.mode, mask });
    e.w = d.w;
    e.h = d.h;
    e.source = d.source;
    this.bytesInUse += d.w * d.h * 4;
    if (this.bytesInUse > this.budget) this._evict();
  }

  _decode(ref, e) {
    e.promise = (async () => {
      try {
        await this._decodeBytes(ref, e, await this.files.bytes(ref.path));
      } catch (err) {
        e.status = 'error';
        if (isCanvasLost(err)) this._lost();
      }
      e.promise = null;
      this.emit('load', ref.key);
      return e;
    })();
  }

  /** A decode canvas got no 2D context: onCanvasLost (core/canvas.js). */
  _lost() {
    if (this.onCanvasLost) { try { this.onCanvasLost(); } catch (e) { /* ignore */ } }
  }

  _evict() {
    const live = [...this.entries.values()].filter(e => e.source).sort((a, b) => a.used - b.used);
    for (const e of live) {
      if (this.bytesInUse <= this.budget * 0.75) break;
      if (e.used >= this.clock - 256) break; // keep everything drawn recently
      this.bytesInUse -= e.w * e.h * 4;
      e.source = null;
    }
  }
}

/** Paths of every \_b image in a script, for ImageStore.prefetch (cheap scan, no tokenizer needed). */
export function scanImagePaths(script) {
  const out = new Set();
  const re = /\\_b\[\s*(?:"((?:[^"]|"")*)"|([^,\]]*))/g;
  let m;
  while ((m = re.exec(script))) {
    const p = (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]).trim();
    if (p) out.add(p);
  }
  return [...out];
}

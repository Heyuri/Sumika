// Image loading for shells (SH §3.1–3.3): fetch PNG (+ .pna mask), decode to straight RGBA without colour
// management, apply the transparency rules, keep the result in an LRU with a byte budget.
// The decoder is injectable so Node tests can use a pure PNG decoder instead of createImageBitmap.
import { log } from '../core/log.js';
import { fetchVersioned } from '../core/loader.js';
import { prepareImage } from './compositor.js';
import { canvasLostError, isCanvasLost, releaseCanvas } from '../core/canvas.js';

/**
 * Browser decoder: createImageBitmap(colorSpaceConversion 'none', premultiplyAlpha 'none') -> canvas -> getImageData.
 * The canvas is temporary: sized 0×0 once read (core/canvas.js releaseCanvas: WebKit counts it against its canvas
 * memory cap until it is collected); one without a 2D context throws canvasLostError (core/canvas.js).
 * @param {ArrayBuffer} bytes
 * @returns {Promise<{width:number, height:number, data:Uint8ClampedArray}>}
 */
export async function decodeImageBrowser(bytes) {
  const blob = new Blob([bytes], { type: 'image/png' });
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  let c = null;
  try {
    const w = bmp.width, h = bmp.height;
    if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
    else {
      c = document.createElement('canvas');
      c.width = w; c.height = h;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw canvasLostError('shell image');
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: id.data };
  } finally {
    if (bmp.close) bmp.close();
    releaseCanvas(c);
  }
}

export class ImageCache {
  /**
   * @param {{files: {has:(p:string)=>boolean, resolve:(p:string)=>string|null, bytes:(p:string)=>Promise<ArrayBuffer>},
   *          decode?: (bytes:ArrayBuffer, path:string)=>Promise<{width:number,height:number,data:Uint8ClampedArray|Uint8Array}>,
   *          budget?: number, concurrency?: number, alpha?: {useSelfAlpha?: string, paintBlack?: boolean|null},
   *          onCanvasLost?: () => void}} opts
   *   onCanvasLost: a decode's canvas got no 2D context (canvasLostError, core/canvas.js): the image counts as missing and
   *   this is called (the Stage ends the ghost: no half-drawn character)
   */
  constructor({ files, decode = decodeImageBrowser, budget = 96 * 1024 * 1024, concurrency = 6, alpha = {}, onCanvasLost = null }) {
    this.files = files;
    this.decode = decode;
    this.onCanvasLost = typeof onCanvasLost === 'function' ? onCanvasLost : null;
    this.budget = budget;
    this.concurrency = concurrency;
    this.alpha = alpha;
    this.ready = new Map();      // path -> Img|null (LRU order)
    this.pending = new Map();    // path -> Promise
    this.queue = [];
    this.active = 0;
    this.bytes = 0;
    this.listeners = new Set();
  }

  /** prepared image, null when missing/broken, undefined while not loaded (call want()/load()) */
  get(path) {
    const v = this.ready.get(path);
    if (v !== undefined) {
      this.ready.delete(path);
      this.ready.set(path, v);
    }
    return v;
  }

  /**
   * Pixel size of an image without waiting for it: from the decoded image, else from the optional
   * `files.imageSize(path)` (e.g. PNG sizes recorded in the site manifest).
   * @returns {{width:number,height:number}|null|undefined} null = missing/broken, undefined = unknown until decoded
   */
  size(path) {
    const v = this.ready.get(path);
    if (v !== undefined) return v ? { width: v.width, height: v.height } : null;
    if (!this.files.has(path)) return null;
    const s = typeof this.files.imageSize === 'function' ? this.files.imageSize(path) : undefined;
    return s && Number.isFinite(s.width) && Number.isFinite(s.height) ? { width: s.width, height: s.height } : undefined;
  }

  /** request images; resolves when all of them are settled */
  load(paths) {
    const list = Array.isArray(paths) ? paths : [paths];
    return Promise.all(list.map(p => this._one(p)));
  }

  /** called with the path whenever an image becomes ready (or fails) */
  onReady(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _one(path) {
    if (this.ready.has(path)) return Promise.resolve(this.ready.get(path));
    let pr = this.pending.get(path);
    if (pr) return pr;
    pr = new Promise(resolve => this.queue.push({ path, resolve }));
    this.pending.set(path, pr);
    this._pump();
    return pr;
  }

  _pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this._fetch(job.path).then(img => {
        this.active--;
        this.pending.delete(job.path);
        this._store(job.path, img);
        job.resolve(img);
        for (const f of this.listeners) { try { f(job.path); } catch (e) { log.error(e); } }
        this._pump();
      });
    }
  }

  async _fetch(path) {
    try {
      if (!this.files.has(path)) { log.once('shell:img:' + path, 'shell: image not found', path); return null; }
      const pnaPath = path.replace(/\.[^./]*$/, '') + '.pna';
      const hasPna = /\.png$/i.test(path) && this.files.has(pnaPath);
      const [png, pna] = await Promise.all([
        this._bytes(path).then(b => this.decode(b, path)),
        hasPna ? this._bytes(pnaPath).then(b => this.decode(b, pnaPath)).catch(e => {
          if (isCanvasLost(e)) throw e;       // no canvas memory is no bad file: the image cannot be drawn right
          log.once('shell:pna:' + pnaPath, 'shell: bad PNA', pnaPath, e && e.message);
          return null;
        }) : null,
      ]);
      if (pna && (pna.width !== png.width || pna.height !== png.height)) log.once('shell:pnasize:' + pnaPath, 'shell: PNA size differs from its PNG', pnaPath);
      return prepareImage(png, pna, { useSelfAlpha: this.alpha.useSelfAlpha, paintBlack: this.alpha.paintBlack, hasAlpha: png.hasAlpha });
    } catch (e) {
      if (isCanvasLost(e)) {
        if (this.onCanvasLost) { try { this.onCanvasLost(); } catch (e2) { /* ignore */ } }
        return null;
      }
      log.once('shell:imgerr:' + path, 'shell: cannot load image', path, e && e.message);
      return null;
    }
  }

  /**
   * Image bytes: straight from the URL when the folder has one (GhostFiles.bytes keeps every response in memory),
   * its `?v=` one when the manifest versions it (fetchVersioned: any stored copy, checked against the manifest's size).
   */
  async _bytes(path) {
    if (typeof this.files.url === 'function' && typeof fetch === 'function') {
      const f = this.files;
      const url = typeof f.versionedUrl === 'function' ? f.versionedUrl(path) : f.url(path);
      return fetchVersioned(url, { size: typeof f.size === 'function' ? f.size(path) : -1 });
    }
    return this.files.bytes(path);
  }

  _store(path, img) {
    this.ready.set(path, img);
    if (img) this.bytes += img.data.byteLength;
    if (this.bytes <= this.budget) return;
    for (const [p, v] of this.ready) {
      if (this.bytes <= this.budget * 0.8) break;
      if (p === path) continue;
      this.ready.delete(p);
      if (v) this.bytes -= v.data.byteLength;
    }
  }

  clear() { this.ready.clear(); this.bytes = 0; }
}

// Pure RGBA compositing for shells (SH §3). Buffers are straight (non-premultiplied) RGBA, row-major, the layout of
// ImageData, so the DOM side can putImageData the result directly. Every image carries an origin (ox, oy): the
// surface coordinates of its pixel (0,0). Nothing here touches the DOM.

/**
 * @typedef {Object} Img
 * @property {number} width
 * @property {number} height
 * @property {Uint8ClampedArray} data   straight RGBA
 * @property {number} ox               surface x of pixel (0,0)
 * @property {number} oy
 */

/** @returns {Img} transparent image */
export function createImage(width, height, ox = 0, oy = 0) {
  width = Math.max(0, width | 0);
  height = Math.max(0, height | 0);
  return { width, height, data: new Uint8ClampedArray(width * height * 4), ox, oy };
}

const EMPTY = Object.freeze({ width: 0, height: 0, data: new Uint8ClampedArray(0), ox: 0, oy: 0 });
export function emptyImage(ox = 0, oy = 0) { return ox || oy ? { ...EMPTY, ox, oy } : EMPTY; }

function u32(data) { return new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2); }

/**
 * Apply SSP's transparency rules to a decoded PNG (SH §3.2, §3.3).
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}} png decoded RGBA (straight)
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}|null} pna decoded mask image, or null
 * @param {{useSelfAlpha?: '0'|'1'|'full'|string, paintBlack?: boolean|null, hasAlpha?: boolean}} [opts]
 *   paintBlack: seriko.paint_transparent_region_black (null/undefined = default: on for PNA, off for self alpha)
 *   hasAlpha: the PNG has an alpha channel or tRNS (default: detected from the pixels)
 * @returns {Img}
 */
export function prepareImage(png, pna, opts = {}) {
  const w = png.width, h = png.height, src = png.data;
  const out = createImage(w, h);
  const d = out.data;
  d.set(src.subarray(0, w * h * 4));
  if (!w || !h) return out;
  const kr = src[0], kg = src[1], kb = src[2];
  const usa = String(opts.useSelfAlpha || '0').toLowerCase();
  const selfAlpha = usa === '1' || usa === 'true' || usa === 'full';
  if (pna) {
    const paint = opts.paintBlack == null ? true : !!opts.paintBlack;
    const pw = pna.width, ph = pna.height, pd = pna.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let a = 0;
        if (x < pw && y < ph) {
          const j = (y * pw + x) * 4;
          const r = pd[j], g = pd[j + 1], b = pd[j + 2];
          a = r === g && g === b ? r : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        }
        d[i + 3] = a;
        if (paint && d[i] === kr && d[i + 1] === kg && d[i + 2] === kb) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; }
      }
    }
    return out;
  }
  let hasAlpha = opts.hasAlpha;
  if (selfAlpha && hasAlpha === undefined) {
    hasAlpha = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) { hasAlpha = true; break; }
  }
  if (selfAlpha && hasAlpha) {
    if (opts.paintBlack) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0 && d[i] === kr && d[i + 1] === kg && d[i + 2] === kb) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; }
      }
    }
    return out;
  }
  if (usa === 'full') {
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    return out;
  }
  // classic colour key: the PNG's own alpha is ignored
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i] === kr && d[i + 1] === kg && d[i + 2] === kb ? 0 : 255;
  }
  return out;
}

/** Methods as they behave when drawing a layer. */
export function normalizeMethod(m) {
  switch (m) {
    case 'overlay': case 'add': case 'bind': case 'base': return 'overlay';
    case 'overlayfast': case 'interpolate': case 'replace': case 'reduce': case 'asis': return m;
    default:
      if (m && m.startsWith('blend-')) return m;
      return 'overlay';
  }
}

/** Rectangle of an image in surface coordinates when drawn at (x, y). */
export function layerRect(img, x, y) {
  return { x: x + img.ox, y: y + img.oy, w: img.width, h: img.height };
}

/**
 * Draw src into dst (both straight RGBA). (dx, dy) = position of src's pixel (0,0) in dst pixel coordinates.
 * dst must already be large enough for growing methods (see composeLayers); pixels outside dst are clipped.
 * @param {Img} dst
 * @param {Img} src
 * @param {string} method normalised method (overlay, overlayfast, interpolate, replace, reduce, asis, blend-*)
 * @param {number} [alpha] 0..255 extra opacity (--alpha)
 */
export function drawInto(dst, src, dx, dy, method = 'overlay', alpha = 255) {
  const W = dst.width, H = dst.height, w = src.width, h = src.height;
  const D = dst.data, S = src.data;
  if (method === 'reduce') {
    // destination-in; everything outside src's rectangle counts as transparent
    for (let y = 0; y < H; y++) {
      const sy = y - dy;
      const rowIn = sy >= 0 && sy < h;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4 + 3;
        if (D[i] === 0) continue;
        const sx = x - dx;
        if (!rowIn || sx < 0 || sx >= w) { D[i] = 0; continue; }
        const sa = S[(sy * w + sx) * 4 + 3];
        if (sa !== 255) D[i] = (D[i] * sa + 127) / 255;
      }
    }
    return;
  }
  const x0 = Math.max(0, dx), y0 = Math.max(0, dy);
  const x1 = Math.min(W, dx + w), y1 = Math.min(H, dy + h);
  if (x1 <= x0 || y1 <= y0) return;
  if (alpha < 255 && method !== 'replace') return drawSlow(dst, src, dx, dy, method, alpha, x0, y0, x1, y1);
  const D32 = u32(D), S32 = u32(S);
  if (method === 'overlay') {
    for (let y = y0; y < y1; y++) {
      let di = y * W + x0, si = (y - dy) * w + (x0 - dx);
      for (let x = x0; x < x1; x++, di++, si++) {
        const sa = S[si * 4 + 3];
        if (sa === 0) continue;
        const da = D[di * 4 + 3];
        if (sa === 255 || da === 0) { D32[di] = S32[si]; continue; }
        over(D, di * 4, S, si * 4, sa, da);
      }
    }
    return;
  }
  if (method === 'interpolate') {
    // destination-over: src shows only where dst is (partly) transparent
    for (let y = y0; y < y1; y++) {
      let di = y * W + x0, si = (y - dy) * w + (x0 - dx);
      for (let x = x0; x < x1; x++, di++, si++) {
        const da = D[di * 4 + 3];
        if (da === 255) continue;
        const sa = S[si * 4 + 3];
        if (sa === 0) continue;
        if (da === 0) { D32[di] = S32[si]; continue; }
        under(D, di * 4, S, si * 4, sa, da);
      }
    }
    return;
  }
  if (method === 'overlayfast') {
    // source-atop: dst alpha unchanged
    for (let y = y0; y < y1; y++) {
      let di = y * W + x0, si = (y - dy) * w + (x0 - dx);
      for (let x = x0; x < x1; x++, di++, si++) {
        const p = di * 4, q = si * 4;
        const sa = S[q + 3];
        if (sa === 0 || D[p + 3] === 0) continue;
        if (sa === 255) { D[p] = S[q]; D[p + 1] = S[q + 1]; D[p + 2] = S[q + 2]; continue; }
        const f = sa / 255, g = 1 - f;
        D[p] = S[q] * f + D[p] * g; D[p + 1] = S[q + 1] * f + D[p + 1] * g; D[p + 2] = S[q + 2] * f + D[p + 2] * g;
      }
    }
    return;
  }
  if (method === 'replace') {
    for (let y = y0; y < y1; y++) {
      const di = y * W + x0, si = (y - dy) * w + (x0 - dx);
      D32.set(S32.subarray(si, si + (x1 - x0)), di);
    }
    return;
  }
  if (method === 'asis') {
    for (let y = y0; y < y1; y++) {
      let di = y * W + x0, si = (y - dy) * w + (x0 - dx);
      for (let x = x0; x < x1; x++, di++, si++) {
        D32[di] = S32[si];
        D[di * 4 + 3] = 255;
      }
    }
    return;
  }
  if (method.startsWith('blend-')) return drawBlend(dst, src, dx, dy, method, x0, y0, x1, y1);
  return drawInto(dst, src, dx, dy, 'overlay');
}

// source-over for one pixel, straight alpha
function over(D, p, S, q, sa, da) {
  const fa = sa / 255, fb = (da / 255) * (1 - fa);
  const oa = fa + fb;
  D[p] = (S[q] * fa + D[p] * fb) / oa;
  D[p + 1] = (S[q + 1] * fa + D[p + 1] * fb) / oa;
  D[p + 2] = (S[q + 2] * fa + D[p + 2] * fb) / oa;
  D[p + 3] = oa * 255;
}
// destination-over for one pixel
function under(D, p, S, q, sa, da) {
  const fa = da / 255, fb = (sa / 255) * (1 - fa);
  const oa = fa + fb;
  D[p] = (D[p] * fa + S[q] * fb) / oa;
  D[p + 1] = (D[p + 1] * fa + S[q + 1] * fb) / oa;
  D[p + 2] = (D[p + 2] * fa + S[q + 2] * fb) / oa;
  D[p + 3] = oa * 255;
}

function drawSlow(dst, src, dx, dy, method, alpha, x0, y0, x1, y1) {
  // scale the source alpha first, then draw normally
  const tmp = createImage(x1 - x0, y1 - y0);
  const T = tmp.data, S = src.data, w = src.width;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const q = ((y - dy) * w + (x - dx)) * 4, p = ((y - y0) * tmp.width + (x - x0)) * 4;
      T[p] = S[q]; T[p + 1] = S[q + 1]; T[p + 2] = S[q + 2]; T[p + 3] = (S[q + 3] * alpha + 127) / 255;
    }
  }
  drawInto(dst, tmp, x0, y0, method, 255);
}

const BLEND = {
  multiply: (a, b) => a * b / 255,
  screen: (a, b) => a + b - a * b / 255,
  darken: Math.min,
  lighten: Math.max,
  difference: (a, b) => Math.abs(a - b),
  exclusion: (a, b) => a + b - 2 * a * b / 255,
  add: (a, b) => Math.min(255, a + b),
  subtract: (a, b) => Math.max(0, b - a),
  overlay: (a, b) => (b < 128 ? 2 * a * b / 255 : 255 - 2 * (255 - a) * (255 - b) / 255),
  'hard-light': (a, b) => (a < 128 ? 2 * a * b / 255 : 255 - 2 * (255 - a) * (255 - b) / 255),
};
let blendWarned = false;
// Photoshop-style separable blends (P2). "-fast" variants keep dst's outline.
function drawBlend(dst, src, dx, dy, method, x0, y0, x1, y1) {
  const fast = method.endsWith('-fast');
  const name = method.slice(6, fast ? -5 : undefined);
  const fn = BLEND[name];
  if (!fn) {
    if (!blendWarned) { blendWarned = true; console.warn('[sumika] shell: unsupported blend', method); }
    return drawInto(dst, src, dx, dy, fast ? 'overlayfast' : 'overlay');
  }
  const W = dst.width, w = src.width, D = dst.data, S = src.data;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * W + x) * 4, q = ((y - dy) * w + (x - dx)) * 4;
      const sa = S[q + 3];
      if (sa === 0) continue;
      const da = D[p + 3];
      if (da === 0) { if (!fast) { D[p] = S[q]; D[p + 1] = S[q + 1]; D[p + 2] = S[q + 2]; D[p + 3] = sa; } continue; }
      // blended colour where both exist, then source-over (or source-atop for -fast)
      const f = sa / 255;
      const br = fn(S[q], D[p]), bg = fn(S[q + 1], D[p + 1]), bb = fn(S[q + 2], D[p + 2]);
      if (fast || da === 255) {
        D[p] = br * f + D[p] * (1 - f); D[p + 1] = bg * f + D[p + 1] * (1 - f); D[p + 2] = bb * f + D[p + 2] * (1 - f);
        if (!fast) D[p + 3] = 255;
        continue;
      }
      const fd = da / 255;
      const mr = br * fd + S[q] * (1 - fd), mg = bg * fd + S[q + 1] * (1 - fd), mb = bb * fd + S[q + 2] * (1 - fd);
      const fb = fd * (1 - f), oa = f + fb;
      D[p] = (mr * f + D[p] * fb) / oa; D[p + 1] = (mg * f + D[p + 1] * fb) / oa; D[p + 2] = (mb * f + D[p + 2] * fb) / oa;
      D[p + 3] = oa * 255;
    }
  }
}

/**
 * A growable canvas in surface coordinates (SH §3.5): drawing past an edge grows the canvas in that direction.
 */
export class GrowCanvas {
  /** @param {Img|null} [img] initial content (copied) */
  constructor(img = null) {
    this.img = img ? copyImage(img) : createImage(0, 0);
  }
  /** grow to contain the surface rectangle [x0,x1) x [y0,y1) */
  ensure(x0, y0, x1, y1) {
    const c = this.img;
    const nx0 = c.width ? Math.min(c.ox, x0) : x0, ny0 = c.height ? Math.min(c.oy, y0) : y0;
    const nx1 = c.width ? Math.max(c.ox + c.width, x1) : x1, ny1 = c.height ? Math.max(c.oy + c.height, y1) : y1;
    if (c.width && c.height && nx0 === c.ox && ny0 === c.oy && nx1 === c.ox + c.width && ny1 === c.oy + c.height) return;
    const n = createImage(nx1 - nx0, ny1 - ny0, nx0, ny0);
    if (c.width && c.height) blit(n, c, c.ox - nx0, c.oy - ny0);
    this.img = n;
  }
  /** draw an image at surface position (x, y) (its own origin offset is added) */
  draw(src, x, y, method = 'overlay', alpha = 255) {
    const m = normalizeMethod(method);
    const sx = x + src.ox, sy = y + src.oy;
    if (m !== 'reduce') {
      if (!src.width || !src.height) return;
      this.ensure(sx, sy, sx + src.width, sy + src.height);
    }
    const c = this.img;
    if (!c.width || !c.height) return;
    drawInto(c, src, sx - c.ox, sy - c.oy, m, alpha);
  }
}

/** copy src into dst at (dx, dy) without blending */
export function blit(dst, src, dx, dy) {
  const W = dst.width, w = src.width;
  const x0 = Math.max(0, dx), y0 = Math.max(0, dy);
  const x1 = Math.min(W, dx + w), y1 = Math.min(dst.height, dy + src.height);
  if (x1 <= x0 || y1 <= y0) return;
  const D32 = u32(dst.data), S32 = u32(src.data);
  for (let y = y0; y < y1; y++) {
    const si = (y - dy) * w + (x0 - dx);
    D32.set(S32.subarray(si, si + (x1 - x0)), y * W + x0);
  }
}

export function copyImage(img) {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data), ox: img.ox, oy: img.oy };
}

/**
 * Compose a list of layers in one pass: the bounding box of every non-reduce layer is computed first, then one
 * canvas is allocated and the layers are drawn in order.
 * @param {{img: Img, x: number, y: number, method: string, alpha?: number}[]} layers
 * @param {{prefix?: Img|null}} [opts] prefix: an already composed image drawn (copied) first
 * @returns {Img}
 */
export function composeLayers(layers, opts = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (rx, ry, rw, rh) => {
    if (!rw || !rh) return;
    if (rx < x0) x0 = rx;
    if (ry < y0) y0 = ry;
    if (rx + rw > x1) x1 = rx + rw;
    if (ry + rh > y1) y1 = ry + rh;
  };
  const pre = opts.prefix || null;
  if (pre) grow(pre.ox, pre.oy, pre.width, pre.height);
  for (const L of layers) {
    if (normalizeMethod(L.method) === 'reduce') continue;
    grow(L.x + L.img.ox, L.y + L.img.oy, L.img.width, L.img.height);
  }
  if (x0 === Infinity) return createImage(0, 0);
  const out = createImage(x1 - x0, y1 - y0, x0, y0);
  if (pre) blit(out, pre, pre.ox - x0, pre.oy - y0);
  for (const L of layers) {
    const m = normalizeMethod(L.method);
    drawInto(out, L.img, L.x + L.img.ox - x0, L.y + L.img.oy - y0, m, L.alpha === undefined ? 255 : L.alpha);
  }
  return out;
}

/** alpha (0..255) at surface coordinates, 0 outside */
export function alphaAt(img, sx, sy) {
  if (!img) return 0;
  const x = Math.floor(sx - img.ox), y = Math.floor(sy - img.oy);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  return img.data[(y * img.width + x) * 4 + 3];
}

/**
 * Opaque area as rectangles (runs of alpha > 0 per row, merged with identical runs of the following rows).
 * Coordinates are image pixels (not surface coordinates).
 * @returns {number[]} flat [x, y, w, h, ...]
 */
export function opaqueRects(img) {
  const { width: W, height: H, data: D } = img;
  const out = [];
  let open = [];   // runs of the previous row: {x0, x1, y0, idx}
  for (let y = 0; y <= H; y++) {
    const runs = [];
    if (y < H) {
      let x = 0;
      const row = y * W;
      while (x < W) {
        while (x < W && D[(row + x) * 4 + 3] === 0) x++;
        if (x >= W) break;
        const s = x;
        while (x < W && D[(row + x) * 4 + 3] !== 0) x++;
        runs.push(s, x);
      }
    }
    // match runs to open rects; identical runs extend them
    const next = [];
    let j = 0;
    for (const r of open) {
      while (j < runs.length && runs[j] < r.x0) j += 2;
      if (j < runs.length && runs[j] === r.x0 && runs[j + 1] === r.x1) {
        next.push(r);
        runs[j] = -1;   // consumed
        j += 2;
      } else {
        out.push(r.x0, r.y0, r.x1 - r.x0, y - r.y0);
      }
    }
    for (let k = 0; k < runs.length; k += 2) if (runs[k] >= 0) next.push({ x0: runs[k], x1: runs[k + 1], y0: y });
    next.sort((a, b) => a.x0 - b.x0);
    open = next;
  }
  return out;
}

const REAL = new WeakMap();

/**
 * ssp.exe's "real rect" of an image (SPSurface +0x410, filled while it RLE-compresses the image at load): the box of
 * the pixels it keeps, alpha > 8, in image px; r / b are the index of the last such column / row (inclusive, as SSP
 * stores them). None: {l: w>>1, t: h>>1, r: w>>1, b: h>>1} [disasm SPSurface_CompressRLETable 0x75e8c0, fallback
 * 0x75ec5c]. prepareImage already turned a colour key into alpha 0 and a .pna into alpha, so its other variants
 * (key ≠ pixel 0x75df30, mask byte > 8 0x75e3a0) are this same test. Cached per Img (EV §3.2.1).
 * @param {Img} img
 * @returns {{l:number, t:number, r:number, b:number}}
 */
export function realRect(img) {
  let r = REAL.get(img);
  if (r) return r;
  const { width: W, height: H, data: D } = img;
  let l = W, t = H, rr = -1, b = -1;
  for (let y = 0; y < H; y++) {
    let i = y * W * 4 + 3;
    for (let x = 0; x < W; x++, i += 4) {
      if (D[i] <= 8) continue;
      if (x < l) l = x;
      if (x > rr) rr = x;
      if (y < t) t = y;
      b = y;
    }
  }
  r = b < 0 ? { l: W >> 1, t: H >> 1, r: W >> 1, b: H >> 1 } : { l, t, r: rr, b };
  REAL.set(img, r);
  return r;
}

/**
 * CSS clip-path for the opaque area: `path('M..h..v..h..z ...')` scaled by `scale`; '' when nothing is opaque.
 * @param {Img} img
 */
export function clipPathFor(img, scale = 1) {
  const r = opaqueRects(img);
  if (!r.length) return '';
  let s = '';
  const f = v => (scale === 1 ? v : Math.round(v * scale * 100) / 100);
  for (let i = 0; i < r.length; i += 4) s += `M${f(r[i])} ${f(r[i + 1])}h${f(r[i + 2])}v${f(r[i + 3])}h${-f(r[i + 2])}z`;
  return `path('${s}')`;
}

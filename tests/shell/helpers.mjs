// Shared helpers for the shell tests: Tsubasa's real files from disk, a GhostFiles stand-in, a fake clock.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeText, normPath } from '../../src/core/loader.js';
import { parseShell, sortSurfaceFiles } from '../../src/shell/surfaces.js';
import { prepareImage } from '../../src/shell/compositor.js';
import { decodePng, readPng } from './png.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const GHOST = path.join(ROOT, 'site/ghost/tsubasa');
export const SHELL_DIR = path.join(GHOST, 'shell/master');
// renders of Tsubasa's shell made by docs/research/scratch/ref_compose.py; like the ghost, not in the repository (the
// tests that compare with them skip without them: needs('tests/shell/fixtures/renders'))
export const RENDERS = path.join(ROOT, 'tests/shell/fixtures/renders');
export const CORPUS = path.join(ROOT, 'tests/corpus');

function walk(dir, pre = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, pre + name + '/'));
    else out.push(pre + name);
  }
  return out;
}

/** Minimal GhostFiles over a local folder (same surface as core/loader.js GhostFiles). */
export class FsFiles {
  constructor(dir, files = null) {
    this.dir = dir;
    this.paths = files || walk(dir);
    this.files = this.paths.map(p => ({ path: p, size: 0 }));
    this.byLower = new Map(this.paths.map(p => [p.toLowerCase(), p]));
    this.reads = [];
  }
  resolve(p) { return this.byLower.get(normPath(p).toLowerCase()) || null; }
  has(p) { return this.resolve(p) !== null; }
  list(prefix = '') {
    const pre = prefix ? normPath(prefix).toLowerCase() + '/' : '';
    return this.paths.filter(p => p.toLowerCase().startsWith(pre));
  }
  sub(prefix) {
    const pre = normPath(prefix);
    const real = this.paths.find(p => p.toLowerCase().startsWith(pre.toLowerCase() + '/'));
    const realPre = real ? real.slice(0, pre.length) : pre;
    const sub = new FsFiles(path.join(this.dir, realPre), this.list(prefix).map(p => p.slice(pre.length + 1)));
    sub.reads = this.reads;
    return sub;
  }
  async bytes(p) {
    const r = this.resolve(p);
    if (!r) throw new Error('no such file ' + p);
    this.reads.push(r);
    const b = readFileSync(path.join(this.dir, r));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  async text(p) { return decodeText(await this.bytes(p)); }
  async textOrNull(p) { return this.has(p) ? this.text(p) : null; }
}

/** async decoder for ImageCache / Stage in Node */
export const nodeDecode = async bytes => decodePng(new Uint8Array(bytes));

let cached = null;
/** Tsubasa's shell, parsed once per test process. */
export function tsubasaShell() {
  if (cached) return cached;
  const names = readdirSync(SHELL_DIR);
  const surf = sortSurfaceFiles(names.filter(n => /^surfaces.*\.txt$/i.test(n)));
  const t0 = performance.now();
  const texts = surf.map(n => ({ name: n, text: decodeText(readFileSync(path.join(SHELL_DIR, n))) }));
  const descript = decodeText(readFileSync(path.join(SHELL_DIR, 'descript.txt')));
  const t1 = performance.now();
  const shell = parseShell({ descript, surfaces: texts, files: names });
  const t2 = performance.now();
  cached = { shell, decodeMs: t1 - t0, parseMs: t2 - t1 };
  return cached;
}

/** Synchronous image source over the shell folder (decode + transparency rules), cached. */
export function fsImages(dir = SHELL_DIR) {
  const cache = new Map();
  const lower = new Map(readdirSync(dir).map(n => [n.toLowerCase(), n]));
  return {
    get(p) {
      if (cache.has(p)) return cache.get(p);
      const real = lower.get(p.toLowerCase());
      let img = null;
      if (real) {
        const png = readPng(path.join(dir, real));
        const pnaName = lower.get(real.toLowerCase().replace(/\.png$/, '.pna'));
        const pna = pnaName ? readPng(path.join(dir, pnaName)) : null;
        img = prepareImage(png, pna, {});
      }
      cache.set(p, img);
      return img;
    },
  };
}

/** The view ref_compose.py writes: composite over an 8 px grey checker, red frame on the base rectangle. */
export function referenceView(img, baseRect) {
  const w = img.width, h = img.height, out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, o = (y * w + x) * 3;
      const a = img.data[i + 3] / 255;
      const bg = ((x >> 3) + (y >> 3)) % 2 === 0 ? 0.85 : 0.75;
      for (let k = 0; k < 3; k++) out[o + k] = Math.floor(((img.data[i + k] / 255) * a + bg * (1 - a)) * 255);
    }
  }
  const x0 = baseRect.x - img.ox, y0 = baseRect.y - img.oy, bw = baseRect.w, bh = baseRect.h;
  const red = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 3; out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; } };
  for (let x = x0; x < x0 + bw; x++) { red(x, y0); red(x, y0 + bh - 1); }
  for (let y = y0; y < y0 + bh; y++) { red(x0, y); red(x0 + bw - 1, y); }
  return { width: w, height: h, data: out };
}

/** compare an RGB view with a reference PNG; returns {sameSize, maxDiff, over} (pixels whose diff > tol) */
export function compareWithRender(view, file, tol = 3) {
  const ref = readPng(path.join(RENDERS, file));
  if (ref.width !== view.width || ref.height !== view.height) return { sameSize: false, ref: [ref.width, ref.height], got: [view.width, view.height] };
  let maxDiff = 0, over = 0;
  for (let i = 0, j = 0; i < view.data.length; i += 3, j += 4) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(view.data[i + k] - ref.data[j + k]));
    if (d > maxDiff) maxDiff = d;
    if (d > tol) over++;
  }
  return { sameSize: true, maxDiff, over };
}

/** Deterministic fake clock with timers (for the mouse tracker and the stage) */
export class FakeClock {
  constructor(t = 0) { this.t = t; this.timers = []; this.seq = 0; }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = ++this.seq; this.timers.push({ id, at: this.t + Math.max(0, ms), fn }); return id; }
  clearTimeout(id) { this.timers = this.timers.filter(t => t.id !== id); }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

/** seeded PRNG (mulberry32) */
export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** PNG width/height from the IHDR chunk (what a site manifest could record without decoding) */
export function pngSize(file) {
  const b = readFileSync(file).subarray(0, 24);
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** FsFiles that also knows image sizes up front (the optional GhostFiles.imageSize hook) */
export class SizedFiles extends FsFiles {
  imageSize(p) {
    const r = this.resolve(p);
    return r && /\.png$/i.test(r) ? pngSize(path.join(this.dir, r)) : null;
  }
  sub(prefix) {
    const s = super.sub(prefix);
    const out = new SizedFiles(s.dir, s.paths);
    out.reads = s.reads;
    return out;
  }
}

/**
 * A headless Stage on a synthetic shell without files: one image per surface (`sizes`: surface id -> [w, h]), its size
 * known up front (imageSize) and decoded as transparent pixels, so placement tests need no PNGs. `opaque`: surface id
 * -> [x0, y0, x1, y1] (x1 / y1 exclusive), a box of opaque white pixels in that image (it must leave pixel (0,0), the
 * colour key, transparent). `descript`: the shell descript's text; the other options go to the Stage (state, desk,
 * ghostDescript, clock, scale).
 */
export async function sizedStage({ sizes, opaque = {}, descript = '', ...opts }) {
  const { Stage } = await import('../../src/shell/stage.js');
  const dim = new Map(Object.entries(sizes).map(([id, wh]) => [`surface${id}.png`, wh]));
  const box = new Map(Object.entries(opaque).map(([id, b]) => [`surface${id}.png`, b]));
  const shellFiles = {
    has: p => dim.has(p), resolve: p => (dim.has(p) ? p : null), list: () => [...dim.keys()],
    imageSize: p => { const d = dim.get(p); return d ? { width: d[0], height: d[1] } : undefined; },
    bytes: async () => new ArrayBuffer(8),
  };
  const decode = async (bytes, p) => {
    const [w, h] = dim.get(p);
    const data = new Uint8Array(w * h * 4);
    const b = box.get(p);
    if (b) for (let y = b[1]; y < b[3]; y++) data.fill(255, (y * w + b[0]) * 4, (y * w + b[2]) * 4);
    return { width: w, height: h, data };
  };
  const shell = parseShell({ descript, files: [...dim.keys()] });
  return new Stage({ shell, shellFiles, shellId: 'master', dom: false, decode, clock: new FakeClock(0), desk: { w: 1280, h: 720 }, ...opts });
}

/** an async PNG decoder whose delay depends on the file (like fetch + createImageBitmap in a browser) */
export const delayedDecode = delayMs => async (bytes, p) => {
  const ms = delayMs(bytes, p);
  await new Promise(r => setTimeout(r, ms));
  return decodePng(new Uint8Array(bytes));
};

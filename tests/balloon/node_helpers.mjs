// Node-only test helpers: a GhostFiles stand-in over a local folder and a small PNG decoder.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { normPath, decodeText } from '../../src/core/loader.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TSUBASA = path.join(ROOT, 'site/ghost/tsubasa');

function walk(dir, base = '', out = []) {
  for (const ent of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(dir, rel, out);
    else out.push(rel);
  }
  return out;
}

/** GhostFiles-compatible view of a local folder (has/resolve/list/bytes/text/sub). */
export class DiskFiles {
  constructor(dir, files) {
    this.dir = dir;
    this.files = files || walk(dir);
    this.byLower = new Map(this.files.map(f => [f.toLowerCase(), f]));
    this.fetched = [];
  }
  resolve(p) { return this.byLower.get(normPath(p).toLowerCase()) ?? null; }
  has(p) { return this.resolve(p) !== null; }
  list(prefix = '', { recursive = true } = {}) {
    const pre = prefix ? normPath(prefix).toLowerCase() + '/' : '';
    return this.files.filter(p => {
      const l = p.toLowerCase();
      return l.startsWith(pre) && (recursive || !l.slice(pre.length).includes('/'));
    });
  }
  async bytes(p) {
    const r = this.resolve(p);
    if (!r) throw new Error('no such file ' + p);
    this.fetched.push(r);
    const b = fs.readFileSync(path.join(this.dir, r));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  async text(p) { return decodeText(await this.bytes(p)); }
  sub(prefix) {
    const low = normPath(prefix).toLowerCase() + '/';
    const f = this.files.find(x => x.toLowerCase().startsWith(low));
    return new DiskFiles(path.join(this.dir, f ? f.slice(0, low.length - 1) : normPath(prefix)));
  }
}

/** Decode an 8-bit PNG (colour types 0, 2, 3, 4, 6; no interlace) to RGBA. */
export function decodePng(buf) {
  const b = Buffer.from(buf);
  let pos = 8, w = 0, h = 0, ct = 0, depth = 0, pal = null, trns = null;
  const idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos), type = b.toString('latin1', pos + 4, pos + 8), d = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; }
    else if (type === 'PLTE') pal = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('unsupported bit depth ' + depth);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = new Uint8ClampedArray(w * h * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, up = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * ch;
      if (ct === 0) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255; }
      else if (ct === 2) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; }
      else if (ct === 3) { const p = cur[s]; out[o] = pal[p * 3]; out[o + 1] = pal[p * 3 + 1]; out[o + 2] = pal[p * 3 + 2]; out[o + 3] = trns && p < trns.length ? trns[p] : 255; }
      else if (ct === 4) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1]; }
      else { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3]; }
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

// Test-only PNG decoder (node:zlib): non-interlaced and Adam7, colour types 0/2/3/4/6, bit depths 1-16.
// Returns straight RGBA like ImageData, plus hasAlpha (alpha channel or tRNS present).
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';

export function decodePng(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) throw new Error('not a PNG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8, w = 0, h = 0, bd = 8, ct = 0, il = 0, plte = null, trns = null;
  const idat = [];
  while (pos < b.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const body = b.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      const hv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      w = hv.getUint32(0); h = hv.getUint32(4);
      bd = body[8]; ct = body[9]; il = body[12];
    } else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat.map(x => Buffer.from(x.buffer, x.byteOffset, x.byteLength))));
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const bpp = Math.max(1, (ch * bd) >> 3);
  const out = new Uint8ClampedArray(w * h * 4);
  let rp = 0;
  const passes = il ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const maxv = (1 << Math.min(bd, 8)) - 1;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = (pw * ch * bd + 7) >> 3;
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const f = raw[rp++];
      cur.set(raw.subarray(rp, rp + stride));
      rp += stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v = cur[i];
        if (f === 1) v += a;
        else if (f === 2) v += up;
        else if (f === 3) v += (a + up) >> 1;
        else if (f === 4) {
          const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
        }
        cur[i] = v & 255;
      }
      const sample = (x, k) => {
        if (bd === 8) return cur[x * ch + k];
        if (bd === 16) return cur[(x * ch + k) * 2];
        const bit = (x * ch + k) * bd;
        return (cur[bit >> 3] >> (8 - bd - (bit & 7))) & ((1 << bd) - 1);
      };
      for (let x = 0; x < pw; x++) {
        const o = (((y0 + y * dy) * w) + x0 + x * dx) * 4;
        let r, g, bl, al = 255;
        if (ct === 3) {
          const idx = sample(x, 0);
          r = plte[idx * 3]; g = plte[idx * 3 + 1]; bl = plte[idx * 3 + 2];
          if (trns && idx < trns.length) al = trns[idx];
        } else if (ct === 0 || ct === 4) {
          const v = sample(x, 0);
          r = g = bl = bd < 8 ? Math.round(v * 255 / maxv) : v;
          if (ct === 4) al = sample(x, 1);
          else if (trns && trns.length >= 2 && ((trns[0] << 8) | trns[1]) === (bd === 16 ? (cur[x * 2] << 8) | cur[x * 2 + 1] : v)) al = 0;
        } else {
          r = sample(x, 0); g = sample(x, 1); bl = sample(x, 2);
          if (ct === 6) al = sample(x, 3);
          else if (trns && trns.length >= 6 && r === trns[1] && g === trns[3] && bl === trns[5]) al = 0;
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = al;
      }
      [prev, cur] = [cur, prev];
    }
  }
  return { width: w, height: h, data: out, hasAlpha: ct === 4 || ct === 6 || !!trns };
}

export function readPng(path) { return decodePng(readFileSync(path)); }

/** Encode straight RGBA as an 8-bit RGBA PNG (for debugging output). */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

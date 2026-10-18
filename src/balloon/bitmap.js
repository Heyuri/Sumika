// Pixel helpers for balloon and \_b images (pure: RGBA byte arrays in, no DOM). BA §1.3.

/** Width, height and whether the colour type has an alpha channel, from a PNG header; null if not a PNG. */
export function pngSize(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 24 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20), alpha: u8[25] === 4 || u8[25] === 6 };
}

/**
 * A PNG without its tRNS chunk, for a colour type without an alpha channel (0 grey, 2 RGB, 3 palette); any other
 * bytes as they are. Where SSP ignores PNG alpha (the colour key, `opaque`, a .pna mask) it keeps a transparent
 * pixel's own colour [disasm 2.9.10 JLibPNG::ReadFromBufferFunc 0x568500: tRNS kept in a separate table], but a
 * browser hands such pixels back from a canvas as black (premultiplied): wiz's palette PNGs, whose top-left key
 * colour (204,204,204) is the tRNS entry, would key their black body away. Chunks carry their own CRCs, so the rest
 * stays valid.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {ArrayBuffer|Uint8Array}
 */
export function withoutTrns(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!pngSize(u8) || ![0, 2, 3].includes(u8[25])) return bytes;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const keep = [];
  let found = false;
  for (let p = 8; p + 12 <= u8.length;) {
    const len = dv.getUint32(p);
    const end = p + 12 + len;
    if (end > u8.length) return bytes;          // truncated: leave it to the decoder
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    if (type === 'tRNS') found = true;
    else keep.push([p, end]);
    p = end;
    if (type === 'IEND') break;
  }
  if (!found) return bytes;
  const out = new Uint8Array(8 + keep.reduce((n, [a, b]) => n + b - a, 0));
  out.set(u8.subarray(0, 8), 0);
  let o = 8;
  for (const [a, b] of keep) { out.set(u8.subarray(a, b), o); o += b - a; }
  return out;
}

/** Make every pixel whose RGB equals the top-left pixel's transparent, every other pixel opaque (PNG alpha ignored). */
export function applyColorKey(data, w, h) {
  if (!w || !h) return data;
  const r = data[0], g = data[1], b = data[2];
  for (let i = 0, n = w * h * 4; i < n; i += 4) {
    data[i + 3] = data[i] === r && data[i + 1] === g && data[i + 2] === b ? 0 : 255;
  }
  return data;
}

/** Ignore any alpha channel (the `opaque` option). */
export function forceOpaque(data) {
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return data;
}

/**
 * Alpha from a .pna mask (its red channel, i.e. the grey level). With paintBlack, transparent pixels whose RGB equals
 * the key colour are painted black (paint_transparent_region_black, BA §1.3).
 */
export function applyMask(data, mask, w, h, paintBlack = false) {
  const n = w * h * 4;
  const r = data[0], g = data[1], b = data[2];
  for (let i = 0; i < n; i += 4) {
    const a = i < mask.length ? mask[i] : 255;
    data[i + 3] = a;
    if (paintBlack && data[i] === r && data[i + 1] === g && data[i + 2] === b) data[i] = data[i + 1] = data[i + 2] = 0;
  }
  return data;
}

/**
 * Rectangles covering the opaque pixels (alpha > 0): runs per row, identical consecutive rows merged.
 * @returns {{x:number,y:number,w:number,h:number}[]}
 */
export function opaqueRects(data, w, h) {
  const out = [];
  let prev = null; // runs of the previous row, as "x0,x1;..."
  let open = [];
  for (let y = 0; y < h; y++) {
    const runs = [];
    let x = 0;
    const row = y * w * 4;
    while (x < w) {
      while (x < w && data[row + x * 4 + 3] === 0) x++;
      if (x >= w) break;
      const x0 = x;
      while (x < w && data[row + x * 4 + 3] !== 0) x++;
      runs.push(x0, x);
    }
    const key = runs.join(',');
    if (key === prev) {
      for (const r of open) r.h++;
    } else {
      open = [];
      for (let i = 0; i < runs.length; i += 2) {
        const r = { x: runs[i], y, w: runs[i + 1] - runs[i], h: 1 };
        open.push(r);
        out.push(r);
      }
      prev = key;
    }
  }
  return out;
}

/** CSS clip-path path() string covering the given rectangles (union under the nonzero rule). */
export function rectsToPath(rects) {
  if (!rects.length) return 'path("M0 0Z")';
  return 'path("' + rects.map(r => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`).join('') + '")';
}

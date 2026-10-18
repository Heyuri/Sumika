// PNG tRNS where SSP ignores PNG alpha (BA §1.3): mayura's balloon wiz (site/ghost/mayura/wiz) is palette PNGs whose
// top-left key colour (204,204,204) is the tRNS entry and whose body is opaque black. A browser canvas hands an alpha-0
// pixel back as black (premultiplied), so the colour key became black and keyed the body away (text invisible, clicks
// through). decodeImage now drops tRNS first (withoutTrns), so the key is the pixel's own colour, as in ssp.exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, decodePng } from './node_helpers.mjs';
import { withoutTrns, applyColorKey } from '../../src/balloon/bitmap.js';
import { needs } from '../needs.mjs';

const WIZ = path.join(ROOT, 'site/ghost/mayura/wiz/balloons0.png');

/** PNG chunk types in order */
function chunks(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  for (let p = 8; p + 12 <= u8.length;) {
    const len = dv.getUint32(p);
    out.push(String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]));
    p += 12 + len;
  }
  return out;
}
/** a minimal PNG of the given colour type with the given chunk types (dummy data and CRCs) */
function png(colorType, types) {
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)];
  for (const t of types) {
    const data = t === 'IHDR' ? Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, colorType, 0, 0, 0) : Uint8Array.of(1, 2, 3);
    const c = new Uint8Array(12 + data.length);
    new DataView(c.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = t.charCodeAt(i);
    c.set(data, 8);
    c.set([9, 9, 9, 9], 8 + data.length);
    parts.push(c);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

test('withoutTrns: drops tRNS from grey, RGB and palette PNGs, the other chunks byte for byte; leaves the rest alone', () => {
  for (const ct of [0, 2, 3]) {
    const src = png(ct, ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    const out = withoutTrns(src);
    assert.deepEqual(chunks(out), ['IHDR', 'PLTE', 'IDAT', 'IEND'], `colour type ${ct}`);
    assert.equal(out.length, src.length - 15);
    assert.deepEqual([...out.subarray(out.length - 12)], [...src.subarray(src.length - 12)], 'IEND with its CRC');
  }
  for (const ct of [4, 6]) {
    const src = png(ct, ['IHDR', 'tRNS', 'IDAT', 'IEND']);
    assert.equal(withoutTrns(src), src, `colour type ${ct} has its own alpha channel: unchanged`);
  }
  const plain = png(3, ['IHDR', 'PLTE', 'IDAT', 'IEND']);
  assert.equal(withoutTrns(plain), plain, 'no tRNS: the same bytes');
  const notPng = Uint8Array.of(1, 2, 3);
  assert.equal(withoutTrns(notPng), notPng);
  assert.equal(withoutTrns(plain.subarray(0, 40)).length, 40, 'truncated: left to the decoder');
});

test('wiz: keyed on a browser\'s pixels it loses its black body; without tRNS its key is (204,204,204) and the body stays',
  needs('site/ghost/mayura'), () => {
    const bytes = new Uint8Array(fs.readFileSync(WIZ));
    assert.equal(bytes[25], 3, 'a palette PNG');
    // what a browser canvas returns: RGB 0 wherever alpha is 0 (premultiplied)
    const asBrowser = img => {
      for (let i = 0; i < img.data.length; i += 4) if (!img.data[i + 3]) img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      return img;
    };
    const opaqueAt = (img, x, y) => img.data[(y * img.w + x) * 4 + 3] === 255;
    const before = asBrowser(decodePng(bytes));
    applyColorKey(before.data, before.w, before.h);
    assert.equal(opaqueAt(before, before.w >> 1, before.h >> 1), false, 'the old way: the middle of the body keyed away');
    const after = asBrowser(decodePng(withoutTrns(bytes)));
    assert.deepEqual([...after.data.subarray(0, 4)], [204, 204, 204, 255], 'the top-left keeps its own colour');
    applyColorKey(after.data, after.w, after.h);
    assert.equal(opaqueAt(after, after.w >> 1, after.h >> 1), true, 'the black body stays');
    assert.equal(opaqueAt(after, 0, 0), false, 'the grey margin is the key');
  });

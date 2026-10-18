// Minimal .nar/.zip reader for the ghost sweep: central directory, stored and deflated entries, CP932 names.
// The admin core (admin/core/archive.mjs) reads archives with it too: every central-directory record (`all`, folders
// included) with its raw name bytes, flags, CRC-32, sizes, method and attributes, and readChecked(), which inflates no
// more than the recorded size and checks the size and CRC-32. ZIP64 archives are refused.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';

const sjis = new TextDecoder('shift_jis');
const utf8 = new TextDecoder('utf-8');

let crcTable = null;

/** CRC-32 (zlib.crc32, the ZIP one) of bytes. */
export function crc32(u8, crc = 0) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = ~crc;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * @param {string} file
 * @returns {{entries: {name:string, size:number, read:() => Buffer}[], all: object[]}} entries: the files (names
 *   decoded here: UTF-8 when flagged, else Shift_JIS); all: every record in central-directory order, folders too, each
 *   {name, raw, flags, method, crc, csize, size, attrs, madeBy, read, readChecked}
 */
export function openZip(file) {
  const buf = fs.readFileSync(file);
  // end of central directory: the last "PK\5\6" (a comment may follow it)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) throw new Error('a ZIP64 archive (not supported)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  const all = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new Error('a ZIP64 archive (not supported)');
    const raw = buf.subarray(p + 46, p + 46 + nlen);
    const name = ((flags & 0x800) ? utf8 : sjis).decode(raw).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    const data = () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: bad local header`);
      const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
      const start = local + 30 + lnlen + lxlen;
      if (start + csize > buf.length) throw new Error(`${name}: cut short`);
      return buf.subarray(start, start + csize);
    };
    const read = () => {
      const d = data();
      if (method === 0) return Buffer.from(d);
      if (method === 8) return zlib.inflateRawSync(d);
      throw new Error(`${name}: compression method ${method}`);
    };
    // the admin's read: never more than the recorded size, which must be exact, and the recorded CRC-32
    const readChecked = () => {
      if (flags & 1) throw new Error(`${name}: encrypted`);
      let out;
      if (method === 0) out = Buffer.from(data());
      else if (method === 8) {
        try {
          out = zlib.inflateRawSync(data(), { maxOutputLength: Math.max(usize, 1) });
        } catch (e) {
          throw new Error(`${name}: damaged (${e.code || e.message})`);
        }
      } else throw new Error(`${name}: compression method ${method} (not supported)`);
      if (out.length !== usize || crc32(out) !== crc) throw new Error(`${name}: damaged (size or CRC-32 differs)`);
      return out;
    };
    const rec = { name, raw: Buffer.from(raw), flags, method, crc, csize, size: usize, attrs, madeBy, read, readChecked };
    all.push(rec);
    if (name.endsWith('/')) continue;
    entries.push({ name, size: usize, read });
  }
  return { entries, all };
}

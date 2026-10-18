// A small ZIP writer: the macOS and Linux programs ship as .zip with the Unix mode 0755 in
// each entry's external attributes (version made by = Unix), because a browser download never sets the executable
// bit; the admin e2e test makes its .nar with it too. Deflated with node:zlib (stored when that is no smaller), CRC-32
// from zlib, UTF-8 names flagged, one fixed time for every entry (the caller's; 1980-01-01 by default), so the same
// input gives the same bytes. No ZIP64: entries under 4 GiB, fewer than 65,536.
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { crc32 as crc32js } from '../tools/sweep/zip.mjs';

const crc32 = typeof zlib.crc32 === 'function' ? b => zlib.crc32(b) >>> 0 : b => crc32js(b);

/** A local time as the DOS date and time a ZIP entry holds (2-second steps; 1980 at the earliest). */
export function dosTime(d) {
  const y = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * The bytes of a ZIP archive.
 * @param {{name: string, data?: Uint8Array|string, mode?: number}[]} entries a folder's name ends with '/'; mode: the
 *   Unix permission bits (0o644 for a file, 0o755 for a folder by default)
 * @param {{date?: Date, level?: number}} [o]
 * @returns {Buffer}
 */
export function zip(entries, { date = new Date(1980, 0, 1), level = 9 } = {}) {
  if (entries.length > 0xffff) throw new Error('too many entries for a ZIP without ZIP64');
  const { time, date: day } = dosTime(date);
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const dir = e.name.endsWith('/');
    const name = Buffer.from(e.name, 'utf8');
    const data = dir ? Buffer.alloc(0) : Buffer.from(typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : (e.data ?? []));
    if (data.length >= 0xffffffff) throw new Error(`${e.name}: too large for a ZIP without ZIP64`);
    const deflated = dir ? data : zlib.deflateRawSync(data, { level });
    const stored = dir || deflated.length >= data.length;
    const body = stored ? data : deflated;
    const sum = crc32(data);
    const flags = /[^\x20-\x7e]/.test(e.name) ? 0x800 : 0;
    const mode = ((e.mode ?? (dir ? 0o755 : 0o644)) & 0o7777) | (dir ? 0o040000 : 0o100000);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(dir ? 10 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);                    // made by: Unix, ZIP 2.0
    c.writeUInt16LE(dir ? 10 : 20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(stored ? 0 : 8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(day, 14);
    c.writeUInt32LE(sum, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((mode << 16) | (dir ? 0x10 : 0)) >>> 0, 38);   // Unix mode high, the DOS folder bit low
    c.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(c, name);
    offset += 30 + name.length + body.length;
    if (offset >= 0xffffffff) throw new Error('the archive is too large for a ZIP without ZIP64');
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

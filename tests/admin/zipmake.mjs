// A zip writer for the admin tests' synthetic archives (no test file): stored or deflated members with raw name bytes
// (CP932 without the UTF-8 flag, or UTF-8 with it), folders, attributes (a Unix link), flags (encrypted), any method
// number and a CRC-32 that lies, so the core's guards and Python's zipfile see the same archive.
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { crc32 } from '../../tools/sweep/zip.mjs';

/**
 * @param {{name: string|Buffer, data?: string|Buffer, utf8?: boolean, method?: number, flags?: number, madeBy?: number,
 *   attrs?: number, crc?: number}[]} members  a folder's name ends with '/'
 * @returns {Buffer}
 */
export function makeZip(members) {
  const locals = [], central = [];
  let offset = 0;
  for (const m of members) {
    const name = Buffer.isBuffer(m.name) ? m.name : Buffer.from(m.name, 'utf8');
    const data = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data ?? '', 'utf8');
    const method = m.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const flags = (m.flags ?? 0) | (m.utf8 ? 0x800 : 0);
    const crc = m.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(m.madeBy ?? 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE((m.attrs ?? 0) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A Unix symbolic link member's attributes (made by Unix, mode 0120777). */
export const UNIX_LINK = { madeBy: (3 << 8) | 20, attrs: (0o120777 << 16) >>> 0 };

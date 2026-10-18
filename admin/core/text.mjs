// Text as tools/index_site.py and tools/add_ghost.py read it, byte for byte (CLAUDE.md "The admin tool"): read_text
// (UTF-8 with a BOM or a `charset,utf-8` in the first 4096 bytes, else cp932, errors replaced, leading BOMs dropped),
// read_descript (str.splitlines, str.strip, first value wins), descript_last (the last line wins), and zip_name's member
// names (strict cp932, else zipfile's cp437). The runtime's decodeText (src/core/loader.js) is not this: it takes
// `charset , utf8` too, and its TextDecoder('shift_jis') is ICU's ibm-943 in Node (0x1A/0x1C/0x7F rotated, 0x80 an
// error) and WHATWG's in Deno and Bun, none of them Python's cp932; parseDescript trims and splits as JS does. The
// index's names must not depend on the runtime: Python's codec tables are in cp932-table.mjs (admin/gen_cp932.py).
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { CP932_SINGLE_HI, CP932_DBCS, CP437_HI } from './cp932-table.mjs';
import { pyStrip, pySplitlines } from './py.mjs';

function units(b64) {
  const bin = atob(b64);
  const out = new Uint16Array(bin.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
  return out;
}

let tables = null;
const T = () => (tables ||= { hi: units(CP932_SINGLE_HI), dbcs: units(CP932_DBCS), cp437: units(CP437_HI) });

const fromUnits = arr => {
  let s = '';
  for (let i = 0; i < arr.length; i += 8192) s += String.fromCharCode.apply(null, arr.subarray(i, i + 8192));
  return s;
};

/**
 * bytes.decode('cp932', 'replace' | 'strict') as Python 3.13 does it (CPython _codecs_jp.c cp932): 0x00-0x80 as is,
 * 0xA0-0xDF and 0xFD-0xFF single, a lead byte with a valid trail one character; an invalid pair or a lead byte at the
 * end is an error of one byte (U+FFFD, then the next byte is read on its own).
 * @param {Uint8Array} u8  @param {{fatal?: boolean}} [o] fatal: throw at the first error (strict)
 * @returns {string}
 */
export function decodeCp932(u8, { fatal = false } = {}) {
  const { hi, dbcs } = T();
  const out = new Uint16Array(u8.length);
  let o = 0;
  for (let i = 0; i < u8.length;) {
    const c = u8[i];
    if (c <= 0x80) { out[o++] = c; i++; continue; }
    if (c >= 0xa0 && (c <= 0xdf || c >= 0xfd)) { out[o++] = hi[c - 0x80]; i++; continue; }
    const t = i + 1 < u8.length ? u8[i + 1] : -1;
    const u = t >= 0x40 && t <= 0xfc ? dbcs[(c <= 0x9f ? c - 0x81 : c - 0xe0 + 31) * 189 + t - 0x40] : 0;
    if (u) { out[o++] = u; i += 2; continue; }
    if (fatal) throw new Error(`cp932: invalid byte 0x${c.toString(16)} at ${i}`);
    out[o++] = 0xfffd;
    i++;
  }
  return fromUnits(out.subarray(0, o));
}

/** bytes.decode('cp437'): every byte is a character. */
export function decodeCp437(u8) {
  const { cp437 } = T();
  const out = new Uint16Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = u8[i] < 0x80 ? u8[i] : cp437[u8[i] - 0x80];
  return fromUnits(out);
}

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
const utf8Strict = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

/** bytes.decode('utf-8', 'replace' | 'strict'): the BOM kept (U+FEFF), as Python's 'utf-8' keeps it. */
export function decodeUtf8(u8, { fatal = false } = {}) {
  return (fatal ? utf8Strict : utf8).decode(u8);
}

const hasBom = u8 => u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf;
const PROBE = Buffer.from('charset,utf-8', 'latin1');
const LEADING_BOMS = new RegExp('^\ufeff+');

/**
 * index_site.py read_text over bytes: 'charset,utf-8' in the first 4096 bytes lower-cased (as ASCII: other bytes never
 * match), or a BOM -> UTF-8, else cp932; errors replaced; every leading U+FEFF dropped.
 */
export function readText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = Buffer.from(u8.subarray(0, 4096));
  for (let i = 0; i < head.length; i++) if (head[i] >= 0x41 && head[i] <= 0x5a) head[i] += 32;
  const text = hasBom(u8) || head.indexOf(PROBE) >= 0 ? decodeUtf8(u8) : decodeCp932(u8);
  return text.replace(LEADING_BOMS, '');
}

/** read_text of a file. */
export function readTextFile(file) {
  return readText(fs.readFileSync(file));
}

/** read_descript's lines over a text: 'key,value' (key stripped and lower-cased, value stripped), first value wins. */
export function parseDescriptPy(text) {
  const d = new Map();
  for (let line of pySplitlines(text)) {
    line = pyStrip(line);
    if (!line || line.startsWith('//') || !line.includes(',')) continue;
    const i = line.indexOf(',');
    const k = pyStrip(line.slice(0, i)).toLowerCase();
    if (!d.has(k)) d.set(k, pyStrip(line.slice(i + 1)));
  }
  return d;
}

/** index_site.py read_descript: a descript.txt / install.txt as a Map (empty when it is no file). */
export function readDescript(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return new Map();
  }
  return st.isFile() ? parseDescriptPy(readTextFile(file)) : new Map();
}

/**
 * index_site.py descript_last: the value of the last line whose key (any case) is one of `keys` (lower case), else
 * null; lines split on \r\n, \r, \n only (re.split, not splitlines). null when the file is missing.
 */
export function descriptLast(file, keys) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return null;
  }
  if (!st.isFile()) return null;
  let found = null;
  for (let line of readTextFile(file).split(/\r\n|\r|\n/)) {
    line = pyStrip(line);
    if (!line || line.startsWith('//') || !line.includes(',')) continue;
    const i = line.indexOf(',');
    if (keys.includes(pyStrip(line.slice(0, i)).toLowerCase())) found = pyStrip(line.slice(i + 1));
  }
  return found;
}

/**
 * add_ghost.py zip_name over a member's raw name bytes: UTF-8 when the archive flags it (strict: zipfile raises on a
 * bad one), else the bytes as cp932 when they are valid cp932, else zipfile's cp437 reading; then `\` as `/`.
 * @param {Uint8Array} raw  @param {number} flags the general purpose flags (0x800: UTF-8)
 */
export function zipName(raw, flags) {
  let n;
  if (flags & 0x800) {
    n = decodeUtf8(raw, { fatal: true });
  } else {
    try {
      n = decodeCp932(raw, { fatal: true });
    } catch (e) {
      n = decodeCp437(raw);
    }
  }
  return n.replace(/\\/g, '/');
}

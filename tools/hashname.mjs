// The name hash of a published runtime file (safe updates): the 10 hex in `worker.<h>.js`,
// `<engine>.<h>.js` and `<engine>.<h>.wasm`. SHA-1 of the bytes, lower-case hex, with a trailing
// `//# sourceMappingURL=…` line left out: that line names the hashed map, so it cannot be inside its own hash. Engine
// files and minified bundles have no such line, so theirs is the plain SHA-1. Used by tools/build.mjs (the names),
// tools/prune.mjs and the tests (tests/build_output.test.mjs checks the names on disk with it).
import crypto from 'node:crypto';

/** Hex digits of a hashed file name. */
export const NAME_HASH_LEN = 10;

const MAP_LINE = Buffer.from('//# sourceMappingURL=');

/** @param {Uint8Array|string} bytes */
function asBuffer(bytes) {
  return typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Where the last line starts and ends (without its line break) when it is a sourceMappingURL comment, else null. */
function mapLine(b) {
  let end = b.length;
  if (end && b[end - 1] === 0x0a) end--;
  if (end && b[end - 1] === 0x0d) end--;
  const start = end ? b.lastIndexOf(0x0a, end - 1) + 1 : 0;
  return end - start >= MAP_LINE.length && b.subarray(start, start + MAP_LINE.length).equals(MAP_LINE) ? { start, end } : null;
}

/**
 * The bytes without their last line when that line is a `//# sourceMappingURL=` comment (its line break, LF or CRLF,
 * goes with it); otherwise the bytes as they are.
 * @param {Uint8Array|string} bytes
 * @returns {Buffer}
 */
export function withoutMapLine(bytes) {
  const b = asBuffer(bytes);
  const l = mapLine(b);
  return l ? b.subarray(0, l.start) : b;
}

/** The file name a trailing `//# sourceMappingURL=` line names, or null when the last line is no such comment. */
export function mapName(bytes) {
  const b = asBuffer(bytes);
  const l = mapLine(b);
  return l ? b.subarray(l.start + MAP_LINE.length, l.end).toString('utf8') : null;
}

/** @param {Uint8Array|string} bytes @returns {string} the SHA-1, 40 lower-case hex */
export function sha1Hex(bytes) {
  return crypto.createHash('sha1').update(asBuffer(bytes)).digest('hex');
}

/**
 * The name hash: NAME_HASH_LEN hex of the SHA-1 of the bytes without a trailing sourceMappingURL line.
 * @param {Uint8Array|string} bytes
 */
export function nameHash(bytes) {
  return sha1Hex(withoutMapLine(bytes)).slice(0, NAME_HASH_LEN);
}

/** `name.<h>.ext` for a plain `name.ext` (the first dot splits: `worker.js` → `worker.<h>.js`). */
export function hashedName(plain, h) {
  const dot = plain.indexOf('.');
  return dot < 0 ? `${plain}.${h}` : `${plain.slice(0, dot)}.${h}${plain.slice(dot)}`;
}

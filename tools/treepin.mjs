// The tree pin of kawari-wasm.md §1 (the same function as engines/kawari7/build.py tree_pin):
// SHA-256 over every file under a folder, in sorted relative POSIX path order (JS string order = Python's for these
// ASCII names), of `path NUL size NUL bytes`. tools/build.mjs checks the MIDI player's vendor folders with it against
// engines/midi/pins.json (docs/research/midi.md §1).
// usage: node tools/treepin.mjs <dir> [<dir> ...]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} root a folder
 * @returns {{sha256: string, files: number}} the pin and how many files it covers
 */
export function treePin(root) {
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const data = fs.readFileSync(path.join(root, rel));
    h.update(Buffer.from(rel, 'utf8'));
    h.update(Buffer.from([0]));
    h.update(Buffer.from(String(data.length), 'ascii'));
    h.update(Buffer.from([0]));
    h.update(data);
  }
  return { sha256: h.digest('hex'), files: files.length };
}

if (import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  for (const d of process.argv.slice(2)) {
    const r = treePin(d);
    console.log(r.sha256, r.files, path.basename(d));
  }
}

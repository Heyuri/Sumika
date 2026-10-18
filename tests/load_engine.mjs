// Load an Emscripten engine build (CommonJS-style output) from ESM tests.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEngineFactory(name) {
  const file = path.join(root, 'site', 'sumika', 'engines', `${name}.js`);
  const mod = { exports: {} };
  const fn = vm.runInThisContext(`(function (module, exports, require, __dirname, __filename) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  fn(mod, mod.exports, createRequire(file), path.dirname(file), file);
  return mod.exports;
}

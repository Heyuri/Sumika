// SHIORI engines available to the worker. Each engine is an Emscripten module exposing the POSIX SHIORI ABI:
//   int load(char *dir, long len)          dir: malloc'd UTF-8 path ending in '/', freed by the engine
//   char *request(char *req, long *len)    req: malloc'd, freed by the engine; returns malloc'd response, caller frees
//   int unload(void)
// A new engine also goes into SUPPORTED_ENGINES (./supported.js), which the page reads. An engine is constructed with
// {engineUrl, wasmUrl, ghostDir, log, saori, opts}; wasmUrl is the page's hashed .wasm (null: the one next to
// engineUrl; emscripten.js); opts is the page's engineOpts (plain JSON; null for Satori; YAYA, Kawari and
// Kawari 7, the root engines of src/core/engine-files.js ROOT_ENGINES: {ghostId, placeholders, site}, YAYA's with its
// module). request(text, {kind, self}): the call's kind matters only to Kawari 7's SHIORI/2.x bridge (shiori2.js).
import { SatoriEngine } from './satori.js';
import { YayaEngine } from './yaya.js';
import { KawariEngine } from './kawari.js';
import { Kawari7Engine } from './kawari7.js';

export const ENGINES = {
  satori: SatoriEngine,
  yaya: YayaEngine,
  kawari: KawariEngine,
  kawari7: Kawari7Engine,
};

export async function createEngine(name, opts) {
  const E = ENGINES[String(name).toLowerCase()];
  if (!E) throw new Error(`no engine for SHIORI "${name}" yet`);
  const e = new E(opts);
  await e.boot();
  return e;
}

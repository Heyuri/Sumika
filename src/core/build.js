// The build's own table (safe updates). tools/build.mjs defines __SUMIKA_BUILD__ (the build id: 12 hex
// of the SHA-1 of the page bundle built with an empty id, so the bundle holds its id as a string literal exactly once)
// and __SUMIKA_FILES__ (JSON: the hashed worker and engine names the bundle loads, relative to runtimeUrl; the same
// table as sumika/build.json). Unbundled (tests, site/dev pages, the sweep) neither is defined: BUILD is 'dev', FILES
// is null, and the helpers give the plain names. BUILD is not VERSION (events.js): that one is ghost-visible
// through baseware.version and changes only with a release (1.0.0).

/** The build id, or 'dev' when unbundled. */
export const BUILD = typeof __SUMIKA_BUILD__ === 'string' ? __SUMIKA_BUILD__ : 'dev';

/**
 * The table of hashed runtime files, or null when unbundled.
 * @type {{worker: string, engines: Object<string, {js: string, wasm: string}>}|null}
 */
export const FILES = typeof __SUMIKA_FILES__ === 'string' ? JSON.parse(__SUMIKA_FILES__) : null;

/**
 * The worker script, relative to runtimeUrl: the table's hashed name, or the plain name with no table.
 * @param {{worker?: string}|null} [files]
 */
export function workerPath(files = FILES) {
  return files && typeof files.worker === 'string' && files.worker ? files.worker : 'engines/worker.js';
}

/**
 * An engine's .js and .wasm, relative to runtimeUrl: the table's pair, or the plain .js and no wasm (Emscripten then
 * finds the .wasm next to its .js) with no table or for an engine the table lacks (the worker refuses an
 * unknown engine anyway).
 * @param {string} engine 'satori', 'yaya', 'kawari', 'kawari7'
 * @param {{engines?: Object<string, {js?: string, wasm?: string}>}|null} [files]
 * @returns {{js: string, wasm: string|null}}
 */
export function enginePaths(engine, files = FILES) {
  const e = files && files.engines && Object.prototype.hasOwnProperty.call(files.engines, engine) ? files.engines[engine] : null;
  if (e && typeof e.js === 'string' && e.js) return { js: e.js, wasm: typeof e.wasm === 'string' && e.wasm ? e.wasm : null };
  return { js: `engines/${engine}.js`, wasm: null };
}

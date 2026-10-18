// Bundle the runtime (safe updates: CLAUDE.md "What gets published"): src/worker/worker.js ->
// DIR/sumika/engines/worker.<h>.js, a copy of each engine pair under its hashed names, the control page
// (src/control/main.js -> control.<h>.js, and DIR/sumika/index.html), the storage hub (src/hub/hub.js -> hub.<h>.js,
// and DIR/sumika/hub.html), src/main.js -> DIR/sumika/sumika.js, and DIR/sumika/build.json (the build id, the
// stored-data SCHEMA and the table of hashed names, the same table the bundle holds: src/core/build.js; and `hub` and
// `control`, which only build.json names).
// usage: node tools/build.mjs [--minify] [--watch] [--site DIR]   (DIR: default the project's site/)
//
// Steps: (1) a previous build.json whose `schema` is higher for any record kind than SCHEMA stops the build before it
// writes anything (a schema bump is one-way); (2) so does a missing plain engine pair (`<e>.js`, `<e>.wasm` for every
// SUPPORTED_ENGINES name: the engine builds write those), and a MIDI vendor folder whose tree pin, or a bank whose
// SHA-256 or size, differs from engines/midi/pins.json (docs/research/midi.md §1); (3) the worker, named by nameHash
// (tools/hashname.mjs: its trailing sourceMappingURL line, which names the hashed map, is left out of the hash) with its
// map unless --minify; (4) each engine's .js and .wasm copied to `<e>.<h>.js` / `<e>.<h2>.wasm` (two hashes: YAYA's JS
// patches can change the .js alone, and a .wasm is 0.4 to 2.6 MB); (4b) the MIDI player (midi.md §5):
// src/midi/engine.js -> `midi.<h>.js`, always minified (third-party code) and always with its map, so --minify does not
// change its bytes under the same name; the bank gzipped as `generaluser_gs.<h>.sf3.gz` with h the name hash of the SF3
// itself (gzip bytes differ by OS and zlib; written only when absent), and `midi.LICENSES.txt` under its plain name;
// (4c) the storage hub (CLAUDE.md "The storage hub"): src/hub/hub.js -> `hub.<h>.js` like the worker (its map unless --minify), then
// the fixed-name `sumika/hub.html` naming it, a third root next to sumika.js and ghosts.json (pages plant it as an
// iframe with `data-hub` and reach it by that fixed name, so the page's table has no `hub`: build.json alone names it);
// before it (4d) the control page (docs/guide.md "Turning Sumika on or off"): src/control/main.js ->
// `control.<h>.js` the same way, then the fixed-name `sumika/index.html` naming it (controlHtml; served as
// https://<host>/sumika/, a fourth root no page loads: visitors open it from a link on the site's pages, so build.json alone names
// its script too); (5) the page bundle twice, the first time with an empty build id, whose SHA-1 (12 hex) is the id the
// second pass gets, so the map stays exact and the result deterministic; --minify writes no other map and deletes a
// leftover sumika.js.map, which would describe another build; (6) build.json; (7) one line. The order (the control
// script and index.html, the hub script and hub.html, sumika.js, build.json) is the upload order of a host that takes
// files one by one: each fixed-name page after its script, sumika.js after both pages.
// esbuild runs with absWorkingDir = the project, so the bundles' `// src/…` comments, and with them the names and
// bytes, do not depend on the working directory. A file whose bytes would not change is not written again (its mtime
// is the ETag of nginx and Apache). Nothing is deleted but that leftover map: older hashed files stay until
// tools/prune.mjs, run before an upload.
// --watch: the full build again after a change under src/ (debounced); each rebuild leaves the previous worker.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { nameHash, sha1Hex, hashedName } from './hashname.mjs';
import { treePin } from './treepin.mjs';
import { SUPPORTED_ENGINES } from '../src/worker/engines/supported.js';
import { SCHEMA } from '../src/core/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Hex digits of the build id. */
const BUILD_LEN = 12;

/** The MIDI player's pins, and the pinned folders the build reads (the reference SF2's folder is not shipped). */
export const MIDI_PINS = path.join(root, 'engines', 'midi', 'pins.json');
export const MIDI_VENDOR = ['spessasynth_core', 'stb-vorbis', 'generaluser-gs-sf3'];

export class Stop extends Error {}

function parseArgs(argv) {
  const o = { watch: false, minify: false, site: path.join(root, 'site') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--watch') o.watch = true;
    else if (a === '--minify') o.minify = true;
    else if (a === '--site' && i + 1 < argv.length) o.site = path.resolve(argv[++i]);
    else throw new Stop(`unknown argument ${a}\nusage: node tools/build.mjs [--minify] [--watch] [--site DIR]`);
  }
  return o;
}

/** Write bytes unless the file already holds exactly them. */
function writeIfChanged(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  try {
    if (fs.readFileSync(file).equals(buf)) return false;
  } catch (e) { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return true;
}

/** Step 1: the previous build.json's schema must not be higher than this tree's for any record kind. */
function checkSchema(buildJson) {
  if (!fs.existsSync(buildJson)) return;
  let prev;
  try {
    prev = JSON.parse(fs.readFileSync(buildJson, 'utf8'));
  } catch (e) {
    throw new Stop(`${buildJson} is unreadable (${e.message}): fix it, or delete it to build anyway`);
  }
  const was = prev && prev.schema && typeof prev.schema === 'object' ? prev.schema : {};
  const higher = Object.keys(was).filter(k => Number(was[k]) > Number(SCHEMA[k] || 0));
  if (higher.length) {
    throw new Stop(`the previous build (${prev.build}) has a newer stored-data schema (${higher.map(k => `${k} ${was[k]} > ${SCHEMA[k] || 0}`).join(', ')}): ` +
      'a schema bump is one-way, so this older tree must not be published. To build it on purpose, delete ' +
      `${buildJson}, and never publish that build`);
  }
}

/** Step 2: the plain engine pairs the engine builds write. */
function checkEngines(engDir) {
  const missing = [];
  for (const e of SUPPORTED_ENGINES) {
    for (const ext of ['js', 'wasm']) if (!fs.existsSync(path.join(engDir, `${e}.${ext}`))) missing.push(`${e}.${ext}`);
  }
  if (missing.length) {
    const engines = [...new Set(missing.map(f => f.split('.')[0]))];
    throw new Stop(`${engDir} lacks ${missing.join(', ')}: run ${engines.map(e => `python engines/${e}/build.py`).join(', ')}`);
  }
}

/** engines/midi/pins.json, parsed. */
export function readMidiPins(file = MIDI_PINS) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Stop(`${path.relative(root, file)} is missing or no JSON (${e.message}): restore it (docs/research/midi.md §1)`);
  }
}

/**
 * Step 2: the MIDI player's vendor folders against their pins (tools/treepin.mjs), and the bank's SHA-256 and size.
 * A missing folder or file, or any difference, stops the build before it writes anything.
 * @param {object} pins engines/midi/pins.json
 * @param {string} [base] the folder the pins' paths are relative to (the project; a test passes a scratch copy)
 * @returns {{core: string, stb: string, bank: Buffer, notices: string}} the two packages' entry files, the SF3's
 *   bytes, the notices file
 */
export function checkMidiPins(pins, base = root) {
  const v = (pins && pins.vendor) || {};
  const restore = ': restore it (docs/research/midi.md §1)';
  for (const name of MIDI_VENDOR) {
    const p = v[name];
    if (!p || typeof p.dir !== 'string') throw new Stop(`engines/midi/pins.json names no ${name}${restore}`);
    const dir = path.join(base, p.dir);
    if (!fs.existsSync(dir)) throw new Stop(`${p.dir} is missing${restore}`);
    const got = treePin(dir);
    if (got.sha256 !== p.tree || got.files !== p.files) throw new Stop(`${p.dir} differs from engines/midi/pins.json${restore}`);
  }
  const b = pins.bank || {};
  const bankFile = path.join(base, String(b.file));
  if (!fs.existsSync(bankFile)) throw new Stop(`${b.file} is missing${restore}`);
  const bank = fs.readFileSync(bankFile);
  if (bank.length !== b.size || crypto.createHash('sha256').update(bank).digest('hex') !== b.sha256) {
    throw new Stop(`${b.file} differs from engines/midi/pins.json${restore}`);
  }
  const notices = path.join(base, String(pins.notices && pins.notices.file));
  if (!fs.existsSync(notices)) throw new Stop(`${pins.notices && pins.notices.file} is missing${restore}`);
  return {
    core: path.join(base, v.spessasynth_core.dir, 'dist', 'index.js'),
    stb: path.join(base, v['stb-vorbis'].dir, 'dist', 'index.js'),
    bank,
    notices,
  };
}

/** esbuild's options for the bundles (exported for tests/runtime/support.test.mjs, which bundles main.js the same way). */
export function common(minify) {
  return {
    absWorkingDir: root,
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    minify,
    sourcemap: minify ? false : 'linked',
    logLevel: 'warning',
    legalComments: 'none',
    write: false,
  };
}

/** The .js and .map (or null) of a write:false build. */
function outputs(result) {
  const js = result.outputFiles.find(f => f.path.endsWith('.js'));
  const map = result.outputFiles.find(f => f.path.endsWith('.js.map')) || null;
  return { js: Buffer.from(js.contents), map: map ? Buffer.from(map.contents) : null };
}

/**
 * A bundle into engDir under its name hash (`<plain>` → `name.<h>.js`), its map line rewritten to the hashed map's
 * name; returns its table path.
 */
async function buildNamed(engDir, plain, options) {
  const { js, map } = outputs(await esbuild.build({ ...options, outfile: path.join(engDir, plain) }));
  const h = nameHash(js);
  const name = hashedName(plain, h);
  let text = js;
  if (map) {
    const line = `//# sourceMappingURL=${plain}.map`;
    const s = js.toString('utf8');
    const at = s.lastIndexOf(line);
    if (at < 0) throw new Error(`the ${plain} bundle has no sourceMappingURL line`);
    text = Buffer.from(s.slice(0, at) + `//# sourceMappingURL=${name}.map` + s.slice(at + line.length));
    if (nameHash(text) !== h) throw new Error(`the ${plain} bundle's name hash changed with its map line`);
    writeIfChanged(path.join(engDir, `${name}.map`), map);
  }
  writeIfChanged(path.join(engDir, name), text);
  return `engines/${name}`;
}

/** Step 3: the worker under its name hash. */
function buildWorker(engDir, minify) {
  return buildNamed(engDir, 'worker.js', { ...common(minify), entryPoints: [path.join(root, 'src/worker/worker.js')] });
}

/** A project-relative `./` path for esbuild's `alias` (resolved against absWorkingDir). */
const aliasPath = p => `./${path.relative(root, p).split(path.sep).join('/')}`;

/**
 * esbuild's options for the MIDI bundle (exported for tests/midi_engine.test.mjs, which builds the same entry as ESM):
 * the same with and without --minify, so its name always names the same bytes (the name hash leaves out the map line,
 * the one part a map would change): always minified (third-party code: 134 KB gzip instead of 185 KB) and always with
 * its linked map; core imported by its bare name, `stb-vorbis` → src/midi/vorbis.js (the decoder evaluated outside the
 * worklet only), and the package itself as `stb-vorbis-impl`. A vendor bump changes engines/midi/pins.json and nothing
 * in src/midi/.
 * @param {{core: string, stb: string}} vendor the packages' entry files (checkMidiPins)
 */
export function midiOptions(vendor) {
  return {
    ...common(false),
    minify: true,
    entryPoints: [path.join(root, 'src/midi/engine.js')],
    alias: {
      spessasynth_core: aliasPath(vendor.core),
      'stb-vorbis': './src/midi/vorbis.js',
      'stb-vorbis-impl': aliasPath(vendor.stb),
    },
  };
}

/**
 * Step 4b: the MIDI player's three files: the bundle (and its map, --minify or not), the bank (gzip -9, named by the
 * SF3's own name hash, written only when absent, through a temporary file so an interrupted build leaves no partial
 * bank under the final name), and the notices; returns the table's `midi` entry.
 */
async function buildMidi(engDir, vendor) {
  const js = await buildNamed(engDir, 'midi.js', midiOptions(vendor));
  const bankName = hashedName('generaluser_gs.sf3.gz', nameHash(vendor.bank));
  const bankFile = path.join(engDir, bankName);
  if (!fs.existsSync(bankFile)) {
    const tmp = `${bankFile}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(vendor.bank, { level: 9 }));
    fs.renameSync(tmp, bankFile);
  }
  writeIfChanged(path.join(engDir, 'midi.LICENSES.txt'), fs.readFileSync(vendor.notices));
  return { js, bank: `engines/${bankName}` };
}

/**
 * The hub page exactly: no inline script (a hub host's `script-src 'self'` works), its script
 * classic and blocking, so the hello listener is installed before the frame's `load`.
 * @param {string} script the hub script's path relative to sumika/ (`engines/hub.<h>.js`)
 */
export function hubHtml(script) {
  return '<!doctype html>\n<meta charset="utf-8">\n<meta name="robots" content="noindex">\n' +
    '<meta name="referrer" content="no-referrer">\n<title>Sumika storage</title>\n' +
    `<script src="${script}"></script>\n`;
}

/** Step 4c: the hub script under its name hash, then sumika/hub.html naming it; returns build.json's `hub`. */
async function buildHub(sumikaDir, engDir, minify) {
  const hub = await buildNamed(engDir, 'hub.js', { ...common(minify), entryPoints: [path.join(root, 'src/hub/hub.js')] });
  writeIfChanged(path.join(sumikaDir, 'hub.html'), hubHtml(hub));
  return hub;
}

/** The control page's style: plain, light and dark, a phone's width too (the page itself is built by its script). */
const CONTROL_CSS = [
  ':root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --muted: #5d5d66; --line: #d4d4dc; --accent: #1f5fbf; }',
  '@media (prefers-color-scheme: dark) { :root { --bg: #17171a; --fg: #ececf1; --muted: #a3a3ad; --line: #3a3a42; --accent: #7aa7ff; } }',
  'body { margin: 0; background: var(--bg); color: var(--fg);',
  '  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif; }',
  'main, noscript { display: block; max-width: 36rem; margin: 0 auto; padding: 2rem 1rem 3rem; }',
  'h1 { font-size: 1.5rem; line-height: 1.3; margin: 0 0 .75rem; }',
  'fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 1.5rem 0 1rem; padding: .25rem 1rem .5rem; }',
  'legend { font-weight: 600; padding: 0 .3rem; }',
  '.option { display: grid; grid-template-columns: auto 1fr; column-gap: .7rem; padding: .7rem 0; cursor: pointer; }',
  '.option + .option { border-top: 1px solid var(--line); }',
  '.option input { grid-row: 1 / 3; width: 1.15rem; height: 1.15rem; margin: .25rem 0 0; accent-color: var(--accent); }',
  '.name { font-weight: 600; }',
  '.hint, .where { color: var(--muted); font-size: .94rem; }',
  '.status { min-height: 1.6em; margin: 0 0 1rem; font-weight: 600; }',
  ':focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }',
].join('\n');

/**
 * The control page exactly (sumika/index.html): its style, its one script deferred (it builds the page in the browser's
 * language), a noscript line in both languages, no inline script (a host's `script-src 'self'` works; the <style> needs
 * `style-src 'unsafe-inline'`, as Sumika's own elements do).
 * @param {string} script the control script's path relative to sumika/ (`engines/control.<h>.js`)
 */
export function controlHtml(script) {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="robots" content="noindex">\n' +
    '<meta name="referrer" content="no-referrer">\n<meta name="color-scheme" content="light dark">\n<title>Sumika</title>\n' +
    `<style>\n${CONTROL_CSS}\n</style>\n<script src="${script}" defer></script>\n</head>\n<body>\n` +
    '<noscript><p lang="en">This page needs JavaScript to keep your choice.</p>' +
    '<p lang="ja">選択を保存するには JavaScript が必要です。</p></noscript>\n</body>\n</html>\n';
}

/** Step 4d: the control script under its name hash, then sumika/index.html naming it; returns build.json's `control`. */
async function buildControl(sumikaDir, engDir, minify) {
  const control = await buildNamed(engDir, 'control.js', { ...common(minify), entryPoints: [path.join(root, 'src/control/main.js')] });
  writeIfChanged(path.join(sumikaDir, 'index.html'), controlHtml(control));
  return control;
}

/** Step 4: each engine's pair under its hashed names; a name that exists has these bytes by construction. */
function copyEngines(engDir) {
  const out = {};
  for (const e of SUPPORTED_ENGINES) {
    const pair = {};
    for (const ext of ['js', 'wasm']) {
      const bytes = fs.readFileSync(path.join(engDir, `${e}.${ext}`));
      const name = hashedName(`${e}.${ext}`, nameHash(bytes));
      const file = path.join(engDir, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      pair[ext] = `engines/${name}`;
    }
    out[e] = pair;
  }
  return out;
}

/** Step 5: the page bundle, twice; returns its build id. */
async function buildMain(sumikaDir, files, minify) {
  const pass = async build => outputs(await esbuild.build({
    ...common(minify),
    entryPoints: [path.join(root, 'src/main.js')],
    outfile: path.join(sumikaDir, 'sumika.js'),
    define: { __SUMIKA_BUILD__: JSON.stringify(build), __SUMIKA_FILES__: JSON.stringify(JSON.stringify(files)) },
  }));
  const id = sha1Hex((await pass('')).js).slice(0, BUILD_LEN);
  const { js, map } = await pass(id);
  writeIfChanged(path.join(sumikaDir, 'sumika.js'), js);
  const mapFile = path.join(sumikaDir, 'sumika.js.map');
  if (map) writeIfChanged(mapFile, map);
  else if (fs.existsSync(mapFile)) fs.unlinkSync(mapFile);
  return id;
}

/**
 * One full build into a site folder.
 * @param {{site: string, minify?: boolean, midiRoot?: string}} o midiRoot: where engines/midi/pins.json and the
 *   folders it pins are (the project; tests/build_output.test.mjs passes a scratch copy)
 * @returns {Promise<{build: string, files: object, hub: string, control: string}>}
 */
export async function build({ site, minify = false, midiRoot = root }) {
  const sumikaDir = path.join(site, 'sumika');
  const engDir = path.join(sumikaDir, 'engines');
  const buildJson = path.join(sumikaDir, 'build.json');
  checkSchema(buildJson);
  checkEngines(engDir);
  const vendor = checkMidiPins(readMidiPins(path.join(midiRoot, 'engines', 'midi', 'pins.json')), midiRoot);
  const worker = await buildWorker(engDir, minify);
  const files = { worker, engines: copyEngines(engDir) };
  files.midi = await buildMidi(engDir, vendor);
  const control = await buildControl(sumikaDir, engDir, minify);
  const hub = await buildHub(sumikaDir, engDir, minify);
  const id = await buildMain(sumikaDir, files, minify);
  writeIfChanged(buildJson, JSON.stringify({ format: 1, build: id, schema: SCHEMA, ...files, hub, control }, null, 2) + '\n');
  const names = [files.worker, ...Object.values(files.engines).flatMap(p => [p.js, p.wasm]), files.midi.js, files.midi.bank, control, hub]
    .map(p => p.replace(/^engines\//, ''));
  console.log(`build ${id}${minify ? ' (minified)' : ''} -> ${path.relative(process.cwd(), sumikaDir) || '.'}: ${names.join(', ')}, index.html, hub.html`);
  return { build: id, files, hub, control };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.watch) {
    await build(o);
    return;
  }
  let running = null, again = false, timer = null;
  const run = async () => {
    if (running) { again = true; return; }
    do {
      again = false;
      running = build(o).catch(e => console.error(e instanceof Stop ? `build stopped: ${e.message}` : `build failed: ${e.message}`));
      await running;
      running = null;
    } while (again);
  };
  await run();
  fs.watch(path.join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  });
  console.log('watching src/ for changes...');
}

// run as a script: import.meta.main, or on a Node without it (undefined there) the script Node was started with, so an
// older Node builds, or stops loudly, instead of exiting 0 having done nothing
if (import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main().catch(e => {
    console.error(e instanceof Stop ? `build stopped: ${e.message}` : e);
    process.exitCode = 1;
  });
}

// The published runtime set (safe updates) and tools/build.mjs. The real site's half fails until
// `npm run build` has run on the current tree (and after every engine build, until it runs again): sumika/build.json
// names a hashed worker and a hashed copy of every engine pair, each name is the name hash of its bytes
// (tools/hashname.mjs), the engine copies are byte-equal to the plain files the tests load, the page bundle holds the
// build id once and the whole table, the schema is SCHEMA, no plain worker.js is left, and the top-level 404.html is
// there. The scratch half builds into a folder in the OS temp folder with `--site` (copies of the plain engine files):
// two builds, the second run from inside that folder, give the same names and the same bundle (absWorkingDir), which
// names no path of the builder's; an engine change renames that engine and the bundle only, the old copy stays; a
// previous build.json with a higher schema stops the build before it writes anything. The MIDI player:
// build.json's `midi` names `midi.<h>.js` (its name hash, always its own map: a --minify build leaves its name, bytes
// and map as they were) and `generaluser_gs.<h>.sf3.gz`, which inflates to the pinned SF3 and is named by the SF3's
// own name hash, as pins.json's `publishAs` says; midi.LICENSES.txt is engines/midi's, where `publishAs` says; no
// plain midi.js or SF3 is published; a vendor folder or bank that differs from engines/midi/pins.json stops the build
// (checkMidiPins on a scratch copy of the folders pins.json names, with one byte changed). The storage hub (CLAUDE.md
// "The storage hub"): build.json's `hub` names `hub.<h>.js` (its name hash, its map unless --minify), the fixed
// sumika/hub.html is exactly the page that names it, sumika.js does not name it; and the publish gate for the
// publisher's sumika/hub.json (none is fine; a loopback origin, an unusable file or an entry no hub keeps is not). The
// control page (docs/guide.md "Turning Sumika on or off"): build.json's `control` names `control.<h>.js` the same way,
// the fixed sumika/index.html is exactly the page that names it (no inline script), sumika.js does not name it.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nameHash, mapName } from '../tools/hashname.mjs';
import { checkMidiPins, readMidiPins, MIDI_VENDOR, hubHtml, controlHtml } from '../tools/build.mjs';
import { SUPPORTED_ENGINES } from '../src/worker/engines/supported.js';
import { SCHEMA } from '../src/core/schema.js';
import { hubJsonProblems } from '../admin/core/check.mjs';
import { WORK_DIR, workLeftovers } from '../admin/core/staging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(root, 'site');
const HASHED = /^engines\/([a-z0-9_]+)\.([0-9a-f]{10})\.(js|wasm)$/;
const MIDI_JS = /^engines\/midi\.([0-9a-f]{10})\.js$/;
const MIDI_BANK = /^engines\/generaluser_gs\.([0-9a-f]{10})\.sf3\.gz$/;
const HUB_JS = /^engines\/hub\.([0-9a-f]{10})\.js$/;
const CONTROL_JS = /^engines\/control\.([0-9a-f]{10})\.js$/;
const PINS = readMidiPins();
/** The pinned folders the build reads, as pins.json names them (a version bump changes them there only). */
const MIDI_DIRS = Object.fromEntries(MIDI_VENDOR.map(k => [k, PINS.vendor[k].dir]));
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A pins.json `publishAs` (`<…>` for a name hash) as a pattern for a published path. */
const publishPattern = s => new RegExp(`^${escapeRe(s).replace(/<[^>]*>/g, '[0-9a-f]{10}')}$`);

/** What is wrong with the MIDI player's three files (build.json's `midi`, the bank, the notices). */
function midiProblems(sumika, b) {
  const out = [];
  const midi = b.midi;
  if (!midi || typeof midi !== 'object') return ['build.json has no midi: run npm run build'];
  const js = MIDI_JS.exec(String(midi.js));
  if (!js) out.push(`build.json's midi.js ${JSON.stringify(midi.js)} is no hashed name`);
  else if (!fs.existsSync(path.join(sumika, midi.js))) out.push(`${midi.js} is missing: run npm run build`);
  else {
    const bytes = fs.readFileSync(path.join(sumika, midi.js));
    if (nameHash(bytes) !== js[1]) out.push(`${midi.js}: its bytes' name hash is ${nameHash(bytes)}`);
    // always its own map, --minify or not: the map line is the one part of the bytes the name hash leaves out
    const map = mapName(bytes);
    if (map !== `${path.basename(midi.js)}.map`) out.push(`${midi.js} names the map ${map}, not its own: run npm run build`);
    else if (!fs.existsSync(path.join(sumika, 'engines', map))) out.push(`${midi.js} names ${map}, which is missing: run npm run build`);
  }
  const bank = MIDI_BANK.exec(String(midi.bank));
  if (!bank) out.push(`build.json's midi bank ${JSON.stringify(midi.bank)} is no hashed name`);
  else if (!publishPattern(PINS.bank.publishAs).test(`sumika/${midi.bank}`)) {
    out.push(`engines/midi/pins.json's bank.publishAs ${PINS.bank.publishAs} does not name sumika/${midi.bank}`);
  } else if (!fs.existsSync(path.join(sumika, midi.bank))) out.push(`${midi.bank} is missing: run npm run build`);
  else {
    let sf3 = null;
    try { sf3 = zlib.gunzipSync(fs.readFileSync(path.join(sumika, midi.bank))); } catch (e) { out.push(`${midi.bank} is no gzip: ${e.message}`); }
    if (sf3 && (sf3.length !== PINS.bank.size || sha256(sf3) !== PINS.bank.sha256)) out.push(`${midi.bank} does not inflate to the pinned SF3`);
    else if (sf3 && nameHash(sf3) !== bank[1]) out.push(`${midi.bank} is not named by the SF3's name hash ${nameHash(sf3)}`);
  }
  const notices = path.join(path.dirname(sumika), PINS.notices.publishAs);
  if (!fs.existsSync(notices) || !fs.readFileSync(notices).equals(fs.readFileSync(path.join(root, PINS.notices.file)))) {
    out.push(`${PINS.notices.publishAs} is not ${PINS.notices.file}: run npm run build`);
  }
  for (const f of fs.readdirSync(path.join(sumika, 'engines'))) {
    if (f === 'midi.js' || f === 'midi.js.map' || /\.sf3$/i.test(f)) out.push(`sumika/engines/${f} is a plain MIDI file: no build writes it`);
  }
  return out;
}

/**
 * What is wrong with the storage hub's files: build.json's `hub` names `hub.<h>.js` by its name hash,
 * with its own map unless --minify; sumika/hub.html is exactly the page build.mjs writes for it (a fixed name: the
 * third root); sumika.js does not name it (pages reach the hub by hub.html, so the page's table has no `hub`).
 */
function hubProblems(sumika, b) {
  const out = [];
  const m = HUB_JS.exec(String(b.hub));
  if (!m) return [`build.json's hub ${JSON.stringify(b.hub)} is no hashed hub script: run npm run build`];
  const file = path.join(sumika, b.hub);
  if (!fs.existsSync(file)) return [`${b.hub} is missing: run npm run build`];
  const bytes = fs.readFileSync(file);
  if (nameHash(bytes) !== m[1]) out.push(`${b.hub}: its bytes' name hash is ${nameHash(bytes)}`);
  const map = mapName(bytes);
  if (map != null && map !== `${path.basename(b.hub)}.map`) out.push(`${b.hub} names the map ${map}, not its own`);
  else if (map != null && !fs.existsSync(path.join(sumika, 'engines', map))) out.push(`${b.hub} names ${map}, which is missing: run npm run build`);
  const html = path.join(sumika, 'hub.html');
  if (!fs.existsSync(html)) out.push('sumika/hub.html is missing: run npm run build');
  else if (fs.readFileSync(html, 'utf8') !== hubHtml(b.hub)) out.push(`sumika/hub.html does not name ${b.hub} as build.mjs writes it: run npm run build`);
  const page = path.join(sumika, 'sumika.js');
  if (fs.existsSync(page) && fs.readFileSync(page, 'utf8').includes(b.hub)) out.push(`sumika.js names ${b.hub}: the page's table has no hub`);
  return out;
}

/**
 * What is wrong with the control page's files (build.mjs step 4d): build.json's `control` names `control.<h>.js` by its
 * name hash, with its own map unless --minify; sumika/index.html is exactly the page build.mjs writes for it (a fixed
 * name, served as /sumika/); sumika.js does not name it (no page loads it: visitors open it from a link on the site's pages).
 */
function controlProblems(sumika, b) {
  const out = [];
  const m = CONTROL_JS.exec(String(b.control));
  if (!m) return [`build.json's control ${JSON.stringify(b.control)} is no hashed control script: run npm run build`];
  const file = path.join(sumika, b.control);
  if (!fs.existsSync(file)) return [`${b.control} is missing: run npm run build`];
  const bytes = fs.readFileSync(file);
  if (nameHash(bytes) !== m[1]) out.push(`${b.control}: its bytes' name hash is ${nameHash(bytes)}`);
  const map = mapName(bytes);
  if (map != null && map !== `${path.basename(b.control)}.map`) out.push(`${b.control} names the map ${map}, not its own`);
  else if (map != null && !fs.existsSync(path.join(sumika, 'engines', map))) out.push(`${b.control} names ${map}, which is missing: run npm run build`);
  const html = path.join(sumika, 'index.html');
  if (!fs.existsSync(html)) out.push('sumika/index.html is missing: run npm run build');
  else if (fs.readFileSync(html, 'utf8') !== controlHtml(b.control)) out.push(`sumika/index.html does not name ${b.control} as build.mjs writes it: run npm run build`);
  const page = path.join(sumika, 'sumika.js');
  if (fs.existsSync(page) && fs.readFileSync(page, 'utf8').includes(b.control)) out.push(`sumika.js names ${b.control}: no page loads the control page`);
  return out;
}

// The publish gate for the storage hub's allowlist (CLAUDE.md "Pages on other origins") is hubJsonProblems
// (admin/core/check.mjs, which the admin tool's checkSite uses too): a usable sumika/hub.json with no loopback origin
// and no entry a hub ignores.

/** What is wrong with a site folder's runtime set, each with what to run; [] when it is complete and consistent. */
function publishSetProblems(site) {
  const out = [];
  const sumika = path.join(site, 'sumika');
  const bj = path.join(sumika, 'build.json');
  if (!fs.existsSync(bj)) return ['sumika/build.json is missing: run npm run build'];
  let b;
  try {
    b = JSON.parse(fs.readFileSync(bj, 'utf8'));
  } catch (e) {
    return [`sumika/build.json is no JSON (${e.message}): run npm run build`];
  }
  if (typeof b.build !== 'string' || !/^[0-9a-f]{12}$/.test(b.build)) out.push(`build.json's build ${JSON.stringify(b.build)} is no 12-hex id`);
  try {
    assert.deepEqual(b.schema, SCHEMA);
  } catch (e) {
    out.push(`build.json's schema ${JSON.stringify(b.schema)} is not SCHEMA ${JSON.stringify(SCHEMA)}: run npm run build`);
  }
  const table = [['worker', b.worker]];
  for (const e of SUPPORTED_ENGINES) {
    const pair = b.engines && b.engines[e];
    if (!pair) out.push(`engine ${e} is not in build.json: run npm run build`);
    else table.push([`${e}.js`, pair.js], [`${e}.wasm`, pair.wasm]);
  }
  for (const [what, rel] of table) {
    const m = HASHED.exec(String(rel));
    if (!m) { out.push(`build.json's ${what} ${JSON.stringify(rel)} is no hashed name`); continue; }
    const file = path.join(sumika, rel);
    if (!fs.existsSync(file)) { out.push(`${rel} is missing: run npm run build`); continue; }
    const bytes = fs.readFileSync(file);
    if (nameHash(bytes) !== m[2]) out.push(`${rel}: its bytes' name hash is ${nameHash(bytes)}`);
    const map = m[3] === 'js' ? mapName(bytes) : null;
    if (map != null) {
      if (what === 'worker' && map !== `${path.basename(rel)}.map`) out.push(`${rel} names the map ${map}, not its own`);
      if (!fs.existsSync(path.join(path.dirname(file), map))) out.push(`${rel} names ${map}, which is missing: run npm run build`);
    }
    if (what !== 'worker') {
      const plain = path.join(sumika, 'engines', `${m[1]}.${m[3]}`);
      if (!fs.existsSync(plain) || !fs.readFileSync(plain).equals(bytes)) {
        out.push(`engines/${m[1]}.${m[3]} differs from ${rel} (an engine was rebuilt): run npm run build`);
      }
    }
  }
  out.push(...midiProblems(sumika, b));
  out.push(...hubProblems(sumika, b));
  out.push(...controlProblems(sumika, b));
  if (b.midi && typeof b.midi === 'object') table.push(['midi.js', b.midi.js], ['midi bank', b.midi.bank]);
  const page = path.join(sumika, 'sumika.js');
  if (!fs.existsSync(page)) out.push('sumika/sumika.js is missing: run npm run build');
  else {
    const bytes = fs.readFileSync(page);
    const text = bytes.toString('utf8');
    const n = typeof b.build === 'string' && b.build ? text.split(b.build).length - 1 : 0;
    if (n !== 1) out.push(`sumika.js holds the build id ${b.build} ${n} times, not once: run npm run build`);
    for (const [, rel] of table) if (typeof rel === 'string' && !text.includes(rel)) out.push(`sumika.js does not name ${rel}: run npm run build`);
    const map = mapName(bytes);
    if (map != null && !fs.existsSync(path.join(sumika, map))) out.push(`sumika.js names ${map}, which is missing: run npm run build`);
  }
  for (const f of ['worker.js', 'worker.js.map']) {
    if (fs.existsSync(path.join(sumika, 'engines', f))) out.push(`sumika/engines/${f} is left from before hashed names: delete it (our own old build output)`);
  }
  if (!fs.existsSync(path.join(site, '404.html'))) out.push('404.html is missing at the top level of the site');
  return out;
}

test('the real site: build.json, the hashed worker and engine copies, the hub script and hub.html, the control script and index.html, sumika.js and 404.html form one complete set', () => {
  const problems = publishSetProblems(SITE);
  assert.deepEqual(problems, [], `site/: ${problems.join('; ')}`);
});

test('the real site: sumika/hub.json, when there is one, is a usable allowlist with no loopback origin (the publish gate)', () => {
  const problems = hubJsonProblems(SITE);
  assert.deepEqual(problems, [], `site/: ${problems.join('; ')}`);
});

test('the real site: no sumika-admin work folder (what a cut-off add or removal left is never published)', () => {
  const left = workLeftovers(SITE).map(e => `${WORK_DIR}/${e.name}`);
  assert.deepEqual(left, [], `site/: ${left.join(', ')}: settle them with admin/core/staging.mjs recoverWork (an old-… folder may be a ghost to put back)`);
  assert.ok(!fs.existsSync(path.join(SITE, WORK_DIR)), `site/${WORK_DIR} is there: delete it (empty)`);
});

// ---- scratch builds ----

let scratch = null;
after(() => { if (scratch) fs.rmSync(scratch.dir, { recursive: true, force: true }); });

/** A scratch site with copies of the plain engine files and the 404 page. */
function scratchSite() {
  if (scratch) return scratch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-build-'));
  const site = path.join(dir, 'site');
  const eng = path.join(site, 'sumika', 'engines');
  fs.mkdirSync(eng, { recursive: true });
  for (const e of SUPPORTED_ENGINES) {
    for (const ext of ['js', 'wasm']) {
      const from = path.join(SITE, 'sumika', 'engines', `${e}.${ext}`);
      assert.ok(fs.existsSync(from), `site/sumika/engines/${e}.${ext} is missing: run python engines/${e}/build.py`);
      fs.copyFileSync(from, path.join(eng, `${e}.${ext}`));
    }
  }
  fs.copyFileSync(path.join(SITE, '404.html'), path.join(site, '404.html'));
  scratch = { dir, site };
  return scratch;
}

function build(site, { cwd = root, args = [] } = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs'), '--site', site, ...args], { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}

/** Every file of a folder: relative path → 'size mtimeMs'. */
function listing(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else {
        const s = fs.statSync(path.join(dir, r));
        out[r] = `${s.size} ${s.mtimeMs}`;
      }
    }
  };
  walk('');
  return out;
}

const readBuild = site => JSON.parse(fs.readFileSync(path.join(site, 'sumika', 'build.json'), 'utf8'));

test('a scratch build passes the same publish-set checks', () => {
  const { site } = scratchSite();
  const r = build(site);
  assert.equal(r.status, 0, r.stderr);
  const problems = publishSetProblems(site);
  assert.deepEqual(problems, [], problems.join('; '));
});

test('the storage hub: hub.<h>.js with its map and the fixed hub.html naming it, in build.json only (not in sumika.js\'s table); hub.html has no inline script', () => {
  const { site } = scratchSite();
  assert.equal(build(site).status, 0);
  const b = readBuild(site);
  assert.match(b.hub, HUB_JS);
  const html = fs.readFileSync(path.join(site, 'sumika', 'hub.html'), 'utf8');
  assert.equal(html, '<!doctype html>\n<meta charset="utf-8">\n<meta name="robots" content="noindex">\n' +
    `<meta name="referrer" content="no-referrer">\n<title>Sumika storage</title>\n<script src="${b.hub}"></script>\n`);
  assert.equal(mapName(fs.readFileSync(path.join(site, 'sumika', b.hub))), `${path.basename(b.hub)}.map`);
  const page = fs.readFileSync(path.join(site, 'sumika', 'sumika.js'), 'utf8');
  assert.ok(!page.includes('hub.'.concat(HUB_JS.exec(b.hub)[1])), 'the page bundle does not name the hub script');
  const keys = Object.keys(b);
  assert.ok(keys.indexOf('hub') > keys.indexOf('midi'), 'build.json: the hub after the table');
  // a broken hub.html (by hand, or a build that died after it) is caught
  const was = html;
  fs.writeFileSync(path.join(site, 'sumika', 'hub.html'), was.replace(b.hub, 'engines/hub.0000000000.js'));
  try {
    assert.ok(publishSetProblems(site).some(p => p.startsWith('sumika/hub.html does not name')));
  } finally {
    fs.writeFileSync(path.join(site, 'sumika', 'hub.html'), was);
  }
});

test('the control page: control.<h>.js with its map and the fixed sumika/index.html naming it (deferred, no inline script), in build.json only (no page loads it), after the hub; a wrong or missing index.html is caught', () => {
  const { site } = scratchSite();
  assert.equal(build(site).status, 0);
  const b = readBuild(site);
  assert.match(b.control, CONTROL_JS);
  const html = fs.readFileSync(path.join(site, 'sumika', 'index.html'), 'utf8');
  assert.equal(html, controlHtml(b.control));
  assert.equal([...html.matchAll(/<script\b[^>]*>/g)].length, 1, 'one script element');
  assert.ok(html.includes(`<script src="${b.control}" defer></script>`), 'its one script, deferred, no inline code');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /prefers-color-scheme: dark/, 'light and dark');
  assert.match(html, /<noscript>.*lang="en".*lang="ja"/s, 'a line for a browser without JavaScript, in both languages');
  assert.equal(mapName(fs.readFileSync(path.join(site, 'sumika', b.control))), `${path.basename(b.control)}.map`);
  const page = fs.readFileSync(path.join(site, 'sumika', 'sumika.js'), 'utf8');
  assert.ok(!page.includes(`control.${CONTROL_JS.exec(b.control)[1]}`), 'the page bundle does not name the control script');
  const keys = Object.keys(b);
  assert.ok(keys.indexOf('control') > keys.indexOf('hub'), 'build.json: after the hub');
  const was = html;
  fs.writeFileSync(path.join(site, 'sumika', 'index.html'), was.replace(b.control, 'engines/control.0000000000.js'));
  try {
    assert.ok(publishSetProblems(site).some(p => p.startsWith('sumika/index.html does not name')));
  } finally {
    fs.writeFileSync(path.join(site, 'sumika', 'index.html'), was);
  }
  fs.renameSync(path.join(site, 'sumika', 'index.html'), path.join(site, 'sumika', 'index.gone'));
  try {
    assert.ok(publishSetProblems(site).includes('sumika/index.html is missing: run npm run build'));
  } finally {
    fs.renameSync(path.join(site, 'sumika', 'index.gone'), path.join(site, 'sumika', 'index.html'));
  }
});

test('the hub.json publish gate: none is fine; a loopback origin, an unusable file or an entry no hub keeps is a problem', () => {
  const { site } = scratchSite();
  const file = path.join(site, 'sumika', 'hub.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    assert.deepEqual(hubJsonProblems(site), [], 'no hub.json: the hub answers nobody, a choice');
    const write = o => fs.writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o));
    write({ format: 1, origins: ['https://a.example.com', 'http://b.example.com', 'https://c.example.com:8443'] });
    assert.deepEqual(hubJsonProblems(site), []);
    write({ format: 1, origins: ['https://a.example.com', 'http://localhost:8644', 'http://127.0.0.1:8644', 'http://a.test.localhost:8644'] });
    const p = hubJsonProblems(site);
    assert.equal(p.length, 3, p.join('; '));
    for (const x of p) assert.match(x, /lists the loopback origin .*remove it before publishing/);
    write({ format: 1, origins: ['https://a.example.com/sumika/', 'https://*.example.com'] });
    assert.deepEqual(hubJsonProblems(site).map(x => x.replace(/:.*?is ignored: /, ': ')),
      ['sumika/hub.json: has a path (/sumika/): list the origin only', 'sumika/hub.json: no wildcards: list each address']);
    write('{"format": 1, "origins": ["https://a.example.com"]');
    assert.deepEqual(hubJsonProblems(site), ['sumika/hub.json: no JSON (the hub would answer no page)']);
    write({ format: 1 });
    assert.match(hubJsonProblems(site)[0], /no "origins" array/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a rebuild from another working directory gives the same names and bytes, and no bundle names the builder\'s paths', () => {
  const { site } = scratchSite();
  let r = build(site);
  assert.equal(r.status, 0, r.stderr);
  const first = readBuild(site);
  const page = fs.readFileSync(path.join(site, 'sumika', 'sumika.js'));
  const worker = fs.readFileSync(path.join(site, 'sumika', first.worker));
  const before = listing(site);
  r = build(site, { cwd: site });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readBuild(site), first);
  assert.ok(fs.readFileSync(path.join(site, 'sumika', 'sumika.js')).equals(page), 'the same sumika.js');
  assert.deepEqual(listing(site), before, 'the same files, not even rewritten (their mtimes are ETags)');
  const forms = [];
  for (const p of [root, os.homedir()]) forms.push(p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\'));
  const midi = fs.readFileSync(path.join(site, 'sumika', first.midi.js));
  const hub = fs.readFileSync(path.join(site, 'sumika', first.hub));
  const control = fs.readFileSync(path.join(site, 'sumika', first.control));
  for (const [name, bytes] of [['sumika.js', page], [first.worker, worker], [first.midi.js, midi], [first.hub, hub], [first.control, control]]) {
    const text = bytes.toString('utf8').toLowerCase();
    for (const f of forms) assert.ok(!text.includes(f.toLowerCase()), `${name} names ${f}`);
  }
});

test('a --minify build leaves the MIDI bundle as it was (its name, its bytes, its map); the worker and sumika.js change and lose their maps', () => {
  const { site } = scratchSite();
  assert.equal(build(site).status, 0);
  const a = readBuild(site);
  const sumika = path.join(site, 'sumika');
  const midi = fs.readFileSync(path.join(sumika, a.midi.js));
  const map = fs.readFileSync(path.join(sumika, `${a.midi.js}.map`));
  try {
    const r = build(site, { args: ['--minify'] });
    assert.equal(r.status, 0, r.stderr);
    const b = readBuild(site);
    assert.equal(b.midi.js, a.midi.js);
    assert.ok(fs.readFileSync(path.join(sumika, b.midi.js)).equals(midi), 'the same bytes under the same name');
    assert.ok(fs.readFileSync(path.join(sumika, `${b.midi.js}.map`)).equals(map), 'and the map it names');
    assert.notEqual(b.worker, a.worker, 'the minified worker is another file under another name');
    assert.equal(mapName(fs.readFileSync(path.join(sumika, b.worker))), null);
    assert.notEqual(b.hub, a.hub, 'so is the hub script');
    assert.equal(mapName(fs.readFileSync(path.join(sumika, b.hub))), null);
    assert.equal(fs.readFileSync(path.join(sumika, 'hub.html'), 'utf8'), hubHtml(b.hub), 'hub.html names the minified one');
    assert.notEqual(b.control, a.control, 'and the control script');
    assert.equal(mapName(fs.readFileSync(path.join(sumika, b.control))), null);
    assert.equal(fs.readFileSync(path.join(sumika, 'index.html'), 'utf8'), controlHtml(b.control), 'index.html names the minified one');
    assert.ok(!fs.existsSync(path.join(sumika, 'sumika.js.map')));
    assert.deepEqual(publishSetProblems(site), []);
  } finally {
    assert.equal(build(site).status, 0);
  }
});

test('an engine change renames that engine\'s file and the bundle only; the old copy stays for prune.mjs', () => {
  const { site } = scratchSite();
  assert.equal(build(site).status, 0);
  const a = readBuild(site);
  const page = fs.readFileSync(path.join(site, 'sumika', 'sumika.js'));
  const plain = path.join(site, 'sumika', 'engines', 'satori.js');
  fs.appendFileSync(plain, '\n// a changed engine\n');
  try {
    const r = build(site);
    assert.equal(r.status, 0, r.stderr);
    const b = readBuild(site);
    assert.notEqual(b.engines.satori.js, a.engines.satori.js);
    assert.notEqual(b.build, a.build);
    assert.deepEqual({ ...b, build: a.build, engines: { ...b.engines, satori: { ...b.engines.satori, js: a.engines.satori.js } } }, a,
      'every other name stays');
    assert.ok(!fs.readFileSync(path.join(site, 'sumika', 'sumika.js')).equals(page));
    assert.ok(fs.existsSync(path.join(site, 'sumika', a.engines.satori.js)), 'the old copy stays');
    assert.deepEqual(publishSetProblems(site), []);
  } finally {
    fs.writeFileSync(plain, fs.readFileSync(path.join(SITE, 'sumika', 'engines', 'satori.js')));
  }
});

test('a previous build.json with a higher schema version stops the build before it writes anything', () => {
  const { site } = scratchSite();
  assert.equal(build(site).status, 0);
  const bj = path.join(site, 'sumika', 'build.json');
  const text = fs.readFileSync(bj, 'utf8');
  const kind = Object.keys(SCHEMA)[0];
  fs.writeFileSync(bj, JSON.stringify({ ...JSON.parse(text), schema: { ...SCHEMA, [kind]: SCHEMA[kind] + 1 } }));
  try {
    fs.appendFileSync(path.join(site, 'sumika', 'engines', 'yaya.js'), '\n// would be a new copy\n');
    const before = listing(site);
    const r = build(site);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /schema bump is one-way/);
    assert.match(r.stderr, new RegExp(`${kind} ${SCHEMA[kind] + 1} > ${SCHEMA[kind]}`));
    assert.deepEqual(listing(site), before, 'nothing written');
  } finally {
    fs.writeFileSync(bj, text);
    fs.writeFileSync(path.join(site, 'sumika', 'engines', 'yaya.js'), fs.readFileSync(path.join(SITE, 'sumika', 'engines', 'yaya.js')));
  }
});

test('engines/midi/midi.LICENSES.txt names the versions engines/midi/pins.json pins (make_notices.mjs takes them from there)', () => {
  const text = fs.readFileSync(path.join(root, PINS.notices.file), 'utf8');
  const v = k => PINS.vendor[k].version;
  for (const words of [`spessasynth_core ${v('spessasynth_core')} by spessasus`, `stb-vorbis ${v('stb-vorbis')}`,
    `GeneralUser GS v${v('generaluser-gs')} by S. Christian Collins`, `== GeneralUser GS v${v('generaluser-gs-sf3')} (`]) {
    assert.ok(text.includes(words), `the notices name ${words}: run make_notices.mjs again`);
  }
});

test('a MIDI vendor folder, bank or pins file that differs from engines/midi/pins.json stops the build before it writes anything', async () => {
  const { dir, site } = scratchSite();
  assert.equal(build(site).status, 0);
  // a scratch project: the pins, the three pinned folders, the notices
  const proj = path.join(dir, 'proj');
  const copy = rel => fs.cpSync(path.join(root, rel), path.join(proj, rel), { recursive: true });
  const { spessasynth_core: coreDir, 'stb-vorbis': stbDir, 'generaluser-gs-sf3': bankDir } = MIDI_DIRS;
  for (const rel of ['engines/midi', coreDir, stbDir, bankDir]) copy(rel);
  const pins = readMidiPins(path.join(proj, 'engines', 'midi', 'pins.json'));
  const got = checkMidiPins(pins, proj);
  assert.equal(got.bank.length, PINS.bank.size);
  assert.equal(got.core, path.join(proj, coreDir, 'dist', 'index.js'));
  assert.ok(PINS.bank.file.startsWith(`${bankDir}/`), 'the bank lies in its pinned folder');
  const flip = (rel, at) => { const f = path.join(proj, rel); const b = fs.readFileSync(f); b[at] ^= 1; fs.writeFileSync(f, b); };
  const { build: run } = await import('../tools/build.mjs');
  const before = listing(site);
  for (const [rel, at, words] of [
    [`${coreDir}/dist/index.js`, 1000, `${coreDir} differs from engines/midi/pins.json: restore it`],
    [`${stbDir}/dist/index.js`, 5, `${stbDir} differs`],
    [PINS.bank.file, PINS.bank.size - 728, `${bankDir} differs`],
  ]) {
    flip(rel, at);
    assert.throws(() => checkMidiPins(pins, proj), e => e.message.includes(words), rel);
    await assert.rejects(run({ site, midiRoot: proj }), e => e.message.includes(words), `${rel}: the build stops`);
    assert.deepEqual(listing(site), before, `${rel}: nothing written`);
    flip(rel, at);
  }
  checkMidiPins(pins, proj);
  fs.renameSync(path.join(proj, stbDir), path.join(proj, 'gone'));
  assert.throws(() => checkMidiPins(pins, proj), new RegExp(`${escapeRe(stbDir)} is missing: restore it`));
  fs.renameSync(path.join(proj, 'gone'), path.join(proj, stbDir));
  assert.throws(() => checkMidiPins({ ...pins, bank: { ...pins.bank, size: pins.bank.size + 1 } }, proj),
    e => e.message.includes(`${PINS.bank.file} differs`));
  fs.writeFileSync(path.join(proj, 'engines', 'midi', 'pins.json'), '{');
  await assert.rejects(run({ site, midiRoot: proj }), /pins\.json is missing or no JSON/);
  assert.deepEqual(listing(site), before, 'nothing written');
});

// tools/prune.mjs (safe updates): the retention of hashed runtime and index files, on synthetic site
// folders in the OS temp folder (`<tmp>/x/site`, its ledger `<tmp>/x/site.published.json`) with an injected clock.
// A file the last upload carried stays 14 days after the upload that replaced it; one no upload carried goes at once;
// a current file never goes; a missing current file, or a sumika.js that is not the bundle build.json describes, stops
// the run before anything is deleted or written; files outside the versioned patterns and every mtime are left alone; a
// second run changes nothing. The storage hub's script is versioned like the worker, and a sumika/hub.html that does
// not name build.json's `hub` stops the run; hub.html and the publisher's hub.json are never touched. The control
// page's script likewise, with sumika/index.html naming build.json's `control`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prune, ledgerPath, readLedger, versionedFiles, hubScript, pageScript, RETAIN_DAYS } from '../tools/prune.mjs';
import { nameHash, hashedName } from '../tools/hashname.mjs';
import { hubHtml, controlHtml } from '../tools/build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = new Date(2020, 0, 1, 12); // every fixture file's mtime, so a touched one shows
const day = n => new Date(2026, 9, 1 + n, 12); // local noon: no DST edge

function tmpSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-prune-'));
  const site = path.join(dir, 'x', 'site');
  fs.mkdirSync(path.join(site, 'sumika', 'engines'), { recursive: true });
  fs.mkdirSync(path.join(site, 'sumika', 'index'), { recursive: true });
  return { dir, site };
}

function put(site, rel, data) {
  const f = path.join(site, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  fs.utimesSync(f, OLD, OLD);
}

/** The files that never take part: plain engine files, licences, build-info, word list, pages. */
function plainFiles(site) {
  put(site, 'sumika/engines/satori.js', 'plain satori js');
  put(site, 'sumika/engines/satori.wasm', 'plain satori wasm');
  put(site, 'sumika/engines/satori.LICENSES.txt', 'licences');
  put(site, 'sumika/engines/satori.build-info.json', '{}');
  put(site, 'sumika/engines/worker.js', 'an old plain worker');
  put(site, 'sumika/word_compatible.txt', 'words');
  put(site, 'sumika/sumika.js', 'bundle');
  put(site, 'index.html', '<!doctype html>');
}

/** A page bundle as build.mjs writes it: its build id once, the table as a JSON string (core/build.js). */
const bundle = (build, table) => `(()=>{var BUILD="${build}",FILES=${JSON.stringify(JSON.stringify(table))};})();\n`;

/**
 * Write version n's hashed files; with `current` also the build.json, sumika.js and ghosts.json that name them; with
 * `midi` also the MIDI player (`midi.<h>.js`, its map, `generaluser_gs.<h>.sf3.gz`) and the table's `midi`; with `hub`
 * the storage hub's script (`hub.<h>.js`, its map), build.json's `hub` and, when current, sumika/hub.html naming it
 * (sumika.js's table never names the hub, as build.mjs writes it).
 * @returns {string[]} its versioned paths, site-relative
 */
function version(site, n, { current = true, midi = false, hub = false, control = false } = {}) {
  const paths = [];
  const hashed = (dir, plain, body) => {
    const name = hashedName(plain, nameHash(body));
    put(site, `${dir}/${name}`, body);
    paths.push(`${dir}/${name}`);
    return name;
  };
  const wbody = `worker ${n}\n`;
  const wname = hashedName('worker.js', nameHash(wbody));
  put(site, `sumika/engines/${wname}`, `${wbody}//# sourceMappingURL=${wname}.map\n`);
  put(site, `sumika/engines/${wname}.map`, `{"version":3,"n":${n}}`);
  paths.push(`sumika/engines/${wname}`, `sumika/engines/${wname}.map`);
  const js = hashed('sumika/engines', 'satori.js', `satori js ${n}`);
  const wasm = hashed('sumika/engines', 'satori.wasm', `satori wasm ${n}`);
  const pack = hashed('sumika/index', 'ghost.a.pack.gz', `pack ${n}`);
  const gman = hashed('sumika/index', 'ghost.a.json', JSON.stringify({ format: 2, id: 'a', root: 'ghost/a/', files: [], pack: `sumika/index/${pack}` }));
  const bman = hashed('sumika/index', 'balloon.b.json', JSON.stringify({ format: 2, id: 'b', root: 'balloon/b/', files: [], v: n }));
  let midiTable = null;
  if (midi) {
    const mbody = `midi ${n}\n`;
    const mname = hashedName('midi.js', nameHash(mbody));
    put(site, `sumika/engines/${mname}`, `${mbody}//# sourceMappingURL=${mname}.map\n`);
    put(site, `sumika/engines/${mname}.map`, `{"version":3,"midi":${n}}`);
    paths.push(`sumika/engines/${mname}`, `sumika/engines/${mname}.map`);
    const bank = hashed('sumika/engines', 'generaluser_gs.sf3.gz', `bank ${n}`);
    midiTable = { js: `engines/${mname}`, bank: `engines/${bank}` };
  }
  let hubPath = null;
  if (hub) {
    const hbody = `hub ${n}\n`;
    const hname = hashedName('hub.js', nameHash(hbody));
    put(site, `sumika/engines/${hname}`, `${hbody}//# sourceMappingURL=${hname}.map\n`);
    put(site, `sumika/engines/${hname}.map`, `{"version":3,"hub":${n}}`);
    paths.push(`sumika/engines/${hname}`, `sumika/engines/${hname}.map`);
    hubPath = `engines/${hname}`;
  }
  let controlPath = null;
  if (control) {
    const cbody = `control ${n}\n`;
    const cname = hashedName('control.js', nameHash(cbody));
    put(site, `sumika/engines/${cname}`, `${cbody}//# sourceMappingURL=${cname}.map\n`);
    put(site, `sumika/engines/${cname}.map`, `{"version":3,"control":${n}}`);
    paths.push(`sumika/engines/${cname}`, `sumika/engines/${cname}.map`);
    controlPath = `engines/${cname}`;
  }
  if (current) {
    const table = { worker: `engines/${wname}`, engines: { satori: { js: `engines/${js}`, wasm: `engines/${wasm}` } } };
    if (midiTable) table.midi = midiTable;
    put(site, 'sumika/build.json', JSON.stringify({ format: 1, build: `build${n}`, schema: {}, ...table, ...(hubPath ? { hub: hubPath } : {}),
      ...(controlPath ? { control: controlPath } : {}) }));
    if (hubPath) put(site, 'sumika/hub.html', hubHtml(hubPath));
    if (controlPath) put(site, 'sumika/index.html', controlHtml(controlPath));
    put(site, 'sumika/sumika.js', bundle(`build${n}`, table));
    put(site, 'sumika/index/ghosts.json', JSON.stringify({ format: 2, ghosts: [], balloons: [],
      manifests: { ghost: { a: `sumika/index/${gman}` }, balloon: { b: `sumika/index/${bman}` } }, versions: {} }));
  }
  return paths.sort();
}

/** Every file under the site and the ledger: path → mtime ms. */
function snapshot(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out[r] = fs.statSync(path.join(dir, r)).mtimeMs;
    }
  };
  walk('');
  return out;
}

const exists = (site, p) => fs.existsSync(path.join(site, p));
const ledger = site => JSON.parse(fs.readFileSync(ledgerPath(site), 'utf8'));
const run = (site, now, o = {}) => prune({ site, now, ...o });

test('the ledger lives beside the site folder, so it is never uploaded', () => {
  const { dir, site } = tmpSite();
  try {
    assert.equal(ledgerPath(site), path.join(dir, 'x', 'site.published.json'));
    assert.equal(ledgerPath(site + path.sep), path.join(dir, 'x', 'site.published.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no ledger: refuses and deletes nothing; --first deletes every non-current versioned file; --retire-all retires them today', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    const v1 = version(site, 1, { current: false });
    const v2 = version(site, 2);
    const before = snapshot(path.dirname(site));
    assert.throws(() => run(site, day(0)), e => e.refused && /--first/.test(e.message));
    assert.deepEqual(snapshot(path.dirname(site)), before, 'nothing deleted or written');
    assert.equal(fs.existsSync(ledgerPath(site)), false);

    const r = run(site, day(0), { retireAll: true });
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.retired, v1);
    for (const p of v1) assert.ok(exists(site, p), p);
    assert.deepEqual(ledger(site), { format: 1, published: v2, retired: Object.fromEntries(v1.map(p => [p, '2026-10-01'])) });
    assert.throws(() => run(site, day(0), { first: true }), e => e.refused && /ledger exists/.test(e.message),
      'a ledger exists: --first would forget it');

    fs.unlinkSync(ledgerPath(site));
    const f = run(site, day(0), { first: true });
    assert.deepEqual(f.deleted, v1);
    for (const p of v1) assert.equal(exists(site, p), false, p);
    for (const p of v2) assert.ok(exists(site, p), p);
    assert.deepEqual(ledger(site), { format: 1, published: v2, retired: {} });
    assert.throws(() => run(site, day(0), { first: true, retireAll: true }), e => e.refused);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a ledger that exists and does not read stops the run with the code bad-ledger (the admin words it, its line names the flags); nothing deleted or written; --first and --retire-all do not pass it', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    version(site, 1, { current: false });
    version(site, 2);
    for (const text of ['not json', '', JSON.stringify({ format: 2, published: [], retired: {} }), JSON.stringify({ format: 1, published: [] }),
      JSON.stringify({ format: 1, published: [], retired: [] })]) {
      fs.writeFileSync(ledgerPath(site), text);
      const before = snapshot(path.dirname(site));
      assert.throws(() => run(site, day(0)), e => e.refused && e.code === 'bad-ledger'
        && /restore it, or delete it and run with --retire-all$/.test(e.message), JSON.stringify(text));
      for (const o of [{ first: true }, { retireAll: true }]) {
        assert.throws(() => run(site, day(0), o), e => e.refused && e.code === 'bad-ledger', JSON.stringify(o));
      }
      assert.deepEqual(snapshot(path.dirname(site)), before, 'nothing deleted or written');
      assert.equal(fs.readFileSync(ledgerPath(site), 'utf8'), text);
    }
    assert.equal(readLedger(path.join(dir, 'none.json')), null, 'no ledger: none');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('uploads, not builds, count: the last upload\'s files stay 14 days after the next upload; files no upload carried go at once', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    const v1 = version(site, 1);
    run(site, day(0), { first: true }); // the first upload carries v1
    const v2 = version(site, 2);
    let r = run(site, day(1)); // the upload of v2: v1 retired today, kept
    assert.deepEqual(r.retired, v1);
    assert.deepEqual(r.deleted, []);
    for (const p of v1) assert.ok(exists(site, p), p);
    assert.deepEqual(ledger(site).retired, Object.fromEntries(v1.map(p => [p, '2026-10-02'])));

    const v3 = version(site, 3); // a build never uploaded …
    const v4 = version(site, 4); // … superseded by this one before the next upload
    r = run(site, day(2));
    assert.deepEqual(r.deleted, v3, 'no upload carried v3');
    assert.deepEqual(r.retired, v2);
    for (const p of [...v1, ...v2, ...v4]) assert.ok(exists(site, p), p);
    assert.deepEqual(ledger(site).published, v4);

    r = run(site, day(1 + RETAIN_DAYS - 1)); // 13 days after v1 was retired
    assert.deepEqual(r.deleted, []);
    for (const p of v1) assert.ok(exists(site, p), p);
    r = run(site, day(1 + RETAIN_DAYS)); // 14 days
    assert.deepEqual(r.deleted, v1);
    for (const p of v1) assert.equal(exists(site, p), false, p);
    const l = ledger(site);
    assert.deepEqual(Object.keys(l.retired), v2, 'v1\'s entries dropped with their files');
    for (const p of v2) assert.ok(exists(site, p), p);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a current file is never deleted, whatever the ledger says; a retired file that is current again loses its entry', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    const v1 = version(site, 1);
    fs.writeFileSync(ledgerPath(site), JSON.stringify({ format: 1, published: [],
      retired: Object.fromEntries(v1.map(p => [p, '2000-01-01'])) }));
    let r = run(site, day(0));
    assert.deepEqual(r.deleted, []);
    for (const p of v1) assert.ok(exists(site, p), p);
    assert.deepEqual(ledger(site), { format: 1, published: v1, retired: {} });

    const v2 = version(site, 2);
    run(site, day(1)); // v1 retired
    assert.deepEqual(Object.keys(ledger(site).retired), v1);
    version(site, 1); // a rollback to v1's set: v1 is current again
    r = run(site, day(2));
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.retired, v2);
    assert.deepEqual(ledger(site), { format: 1, published: v1, retired: Object.fromEntries(v2.map(p => [p, '2026-10-03'])) });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing current file (or no build.json, or a format 1 index) stops the run before any delete or write', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    const v1 = version(site, 1);
    run(site, day(0), { first: true });
    version(site, 2);
    run(site, day(1)); // v1 retired: day 40 would delete it
    const read = rel => JSON.parse(fs.readFileSync(path.join(site, rel), 'utf8'));
    const pack = read(read('sumika/index/ghosts.json').manifests.ghost.a).pack;
    const map = `sumika/${read('sumika/build.json').worker}.map`;
    const stash = path.join(dir, 'stash');
    const before = snapshot(path.dirname(site));
    const without = (rel, why, words) => { // rename keeps the mtime
      fs.renameSync(path.join(site, rel), stash);
      assert.throws(() => run(site, day(40)), e => e.refused && words.every(w => e.message.includes(w)), why);
      fs.renameSync(stash, path.join(site, rel));
      assert.deepEqual(snapshot(path.dirname(site)), before, `${why}: nothing deleted or written`);
    };
    without(pack, 'a current pack', ['stopped, nothing deleted', `${pack} (ghost a's pack) is missing`]);
    without(map, 'the map the worker names', ['stopped, nothing deleted', `${map} (`]);
    without('sumika/build.json', 'build.json', ['sumika/build.json is missing']);

    const gj = path.join(site, 'sumika', 'index', 'ghosts.json');
    const text = fs.readFileSync(gj);
    fs.writeFileSync(gj, JSON.stringify({ format: 1, ghosts: [], balloons: [] }));
    assert.throws(() => run(site, day(40)), e => e.refused && /format 1/.test(e.message));
    fs.writeFileSync(gj, text);
    fs.utimesSync(gj, OLD, OLD);
    assert.deepEqual(snapshot(path.dirname(site)), before, 'a format 1 index: nothing deleted or written');
    assert.equal(run(site, day(40)).deleted.length, v1.length, 'the same run goes through once the set is whole');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a sumika.js that is not the bundle build.json describes (a build that died before writing build.json), or none, stops the run: the new bundle\'s files stay', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    version(site, 1);
    run(site, day(0), { first: true });
    const b1 = JSON.parse(fs.readFileSync(path.join(site, 'sumika', 'build.json'), 'utf8'));
    const v2 = version(site, 2, { current: false });
    const named = re => v2.find(p => re.test(p)).slice('sumika/'.length);
    const t2 = { worker: named(/worker\.\w+\.js$/), engines: { satori: { js: named(/satori\.\w+\.js$/), wasm: named(/satori\.\w+\.wasm$/) } } };
    put(site, 'sumika/sumika.js', bundle('build2', t2));    // build.json still names build1
    const before = snapshot(path.dirname(site));
    assert.throws(() => run(site, day(1)), e => e.refused && e.message.includes('stopped, nothing deleted') &&
      e.message.includes('sumika/sumika.js holds build.json\'s build "build1" 0 times, not once') &&
      e.message.includes(`sumika/sumika.js does not name ${b1.worker}`));
    assert.deepEqual(snapshot(path.dirname(site)), before, 'nothing deleted or written');
    for (const p of v2) assert.ok(exists(site, p), p);
    fs.unlinkSync(path.join(site, 'sumika', 'sumika.js'));
    assert.throws(() => run(site, day(1)), e => e.refused && e.message.includes('sumika/sumika.js is missing'));
    put(site, 'sumika/sumika.js', bundle('build1', { worker: b1.worker, engines: b1.engines }));
    assert.deepEqual(run(site, day(1)).deleted, v2, 'the bundle build.json describes: no upload carried v2');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the MIDI player: midi.<h>.js, its map and generaluser_gs.<h>.sf3.gz are versioned, current while build.json names them, then retired or deleted by the rules; a missing current bank, or a sumika.js that does not name it, stops the run; midi.LICENSES.txt is left alone', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    put(site, 'sumika/engines/midi.LICENSES.txt', 'notices');
    const v1 = version(site, 1, { midi: true });
    const midi1 = v1.filter(p => /\/(midi|generaluser_gs)\./.test(p));
    assert.equal(midi1.length, 3, JSON.stringify(v1));
    assert.ok(midi1.some(p => /^sumika\/engines\/generaluser_gs\.[0-9a-f]{10}\.sf3\.gz$/.test(p)));
    assert.deepEqual(versionedFiles(site).filter(p => midi1.includes(p)), midi1, 'versioned');
    run(site, day(0), { first: true });
    for (const p of v1) assert.ok(exists(site, p), `${p}: current, kept`);
    assert.deepEqual(ledger(site).published, v1);

    const v2 = version(site, 2, { midi: true });
    const v3 = version(site, 3, { midi: true, current: false }); // a build no upload carried
    const bank = v2.find(p => p.endsWith('.sf3.gz'));
    const stash = path.join(dir, 'stash');
    const before = snapshot(path.dirname(site));
    fs.renameSync(path.join(site, bank), stash);
    assert.throws(() => run(site, day(1)), e => e.refused && e.message.includes(`${bank} (build.json midi bank) is missing`));
    fs.renameSync(stash, path.join(site, bank));
    const page = fs.readFileSync(path.join(site, 'sumika', 'sumika.js'), 'utf8');
    put(site, 'sumika/sumika.js', page.replace(bank.slice('sumika/'.length), 'engines/generaluser_gs.0000000000.sf3.gz'));
    assert.throws(() => run(site, day(1)), e => e.refused && e.message.includes(`sumika/sumika.js does not name ${bank.slice('sumika/'.length)}`));
    put(site, 'sumika/sumika.js', page);
    assert.deepEqual(snapshot(path.dirname(site)), before, 'nothing deleted or written');

    let r = run(site, day(1));
    assert.deepEqual(r.retired, v1, 'the last upload\'s MIDI files are retired with the rest');
    assert.deepEqual(r.deleted, v3, 'no upload carried v3');
    for (const p of v2) assert.ok(exists(site, p), p);

    version(site, 4); // an older build.json without midi is fine: v2's MIDI files are no longer current
    r = run(site, day(2));
    for (const p of v2.filter(p => /\/(midi|generaluser_gs)\./.test(p))) assert.ok(r.retired.includes(p), p);
    r = run(site, day(1 + RETAIN_DAYS));
    for (const p of midi1) assert.equal(exists(site, p), false, `${p}: 14 days after it was retired`);
    assert.ok(exists(site, 'sumika/engines/midi.LICENSES.txt'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the storage hub: hub.<h>.js and its map are versioned, current while build.json names them, then retired or deleted by the rules; hub.html that names another script or none, or is missing, stops the run; sumika.js need not name the hub; hub.html and hub.json are never touched', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    put(site, 'sumika/hub.json', '{"format": 1, "origins": ["https://a.example.com"]}');   // the publisher's
    const v1 = version(site, 1, { hub: true });
    const hub1 = v1.filter(p => /\/hub\./.test(p));
    assert.equal(hub1.length, 2, JSON.stringify(v1));
    assert.deepEqual(versionedFiles(site).filter(p => hub1.includes(p)), hub1, 'versioned');
    assert.ok(!fs.readFileSync(path.join(site, 'sumika', 'sumika.js'), 'utf8').includes('hub.'), 'the page bundle does not name it');
    run(site, day(0), { first: true });
    for (const p of v1) assert.ok(exists(site, p), `${p}: current, kept`);
    assert.deepEqual(ledger(site).published, v1);

    const v2 = version(site, 2, { hub: true });
    const v3 = version(site, 3, { hub: true, current: false });    // a build no upload carried
    const html = path.join(site, 'sumika', 'hub.html');
    const good = fs.readFileSync(html, 'utf8');
    const hub2 = JSON.parse(fs.readFileSync(path.join(site, 'sumika', 'build.json'), 'utf8')).hub;
    assert.equal(hubScript(good), hub2);
    const before = snapshot(path.dirname(site));
    for (const [what, text, words] of [
      ['the old script', hubHtml(hub1[0].slice('sumika/'.length)), `sumika/hub.html does not name build.json's hub ${hub2}`],
      ['two scripts', good + good, 'sumika/hub.html does not name'],
      ['none', '<!doctype html><title>x</title>\n', 'sumika/hub.html does not name'],
      ['missing', null, 'sumika/hub.html is missing: run npm run build'],
    ]) {
      if (text == null) fs.unlinkSync(html); else put(site, 'sumika/hub.html', text);
      assert.throws(() => run(site, day(1)), e => e.refused && e.message.includes('stopped, nothing deleted') && e.message.includes(words), what);
      put(site, 'sumika/hub.html', good);
    }
    const map2 = `sumika/${hub2}.map`;
    fs.renameSync(path.join(site, map2), path.join(dir, 'stash'));
    assert.throws(() => run(site, day(1)), e => e.refused && e.message.includes(`${map2} (the map sumika/${hub2} names) is missing`));
    fs.renameSync(path.join(dir, 'stash'), path.join(site, map2));
    assert.deepEqual(snapshot(path.dirname(site)), before, 'nothing deleted or written');

    let r = run(site, day(1));
    assert.deepEqual(r.retired, v1, 'the last upload\'s hub files are retired with the rest');
    assert.deepEqual(r.deleted, v3, 'no upload carried v3');
    for (const p of v2) assert.ok(exists(site, p), p);
    version(site, 4);         // an older build.json without hub is fine: v2's hub files are no longer current
    r = run(site, day(2));
    for (const p of v2.filter(p => /\/hub\./.test(p))) assert.ok(r.retired.includes(p), p);
    r = run(site, day(1 + RETAIN_DAYS));
    for (const p of hub1) assert.equal(exists(site, p), false, `${p}: 14 days after it was retired`);
    assert.equal(fs.statSync(path.join(site, 'sumika', 'hub.json')).mtimeMs, OLD.getTime(), 'hub.json untouched');
    assert.ok(exists(site, 'sumika/hub.html'), 'hub.html is no versioned file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the control page: control.<h>.js and its map are versioned, current while build.json names them, then retired by the rules; sumika/index.html that names another script, or is missing, stops the run; index.html is never touched', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    const v1 = version(site, 1, { hub: true, control: true });
    const c1 = v1.filter(p => /\/control\./.test(p));
    assert.equal(c1.length, 2, JSON.stringify(v1));
    assert.deepEqual(versionedFiles(site).filter(p => c1.includes(p)), c1, 'versioned');
    run(site, day(0), { first: true });
    for (const p of v1) assert.ok(exists(site, p), `${p}: current, kept`);

    const v2 = version(site, 2, { hub: true, control: true });
    const html = path.join(site, 'sumika', 'index.html');
    const good = fs.readFileSync(html, 'utf8');
    const control2 = JSON.parse(fs.readFileSync(path.join(site, 'sumika', 'build.json'), 'utf8')).control;
    assert.equal(pageScript(good), control2);
    const before = snapshot(path.dirname(site));
    for (const [what, text, words] of [
      ['the old script', controlHtml(c1[0].slice('sumika/'.length)), `sumika/index.html does not name build.json's control ${control2}`],
      ['none', '<!doctype html><title>x</title>\n', 'sumika/index.html does not name'],
      ['missing', null, 'sumika/index.html (the control page) is missing'],
    ]) {
      if (text == null) fs.unlinkSync(html); else put(site, 'sumika/index.html', text);
      assert.throws(() => run(site, day(1)), e => e.refused && e.message.includes('stopped, nothing deleted') && e.message.includes(words), what);
      put(site, 'sumika/index.html', good);
    }
    assert.deepEqual(snapshot(path.dirname(site)), before, 'nothing deleted or written');
    const r = run(site, day(1));
    for (const p of c1) assert.ok(r.retired.includes(p), `${p}: retired with the rest`);
    for (const p of v2) assert.ok(exists(site, p), p);
    assert.equal(fs.statSync(html).mtimeMs, OLD.getTime(), 'index.html untouched');
    version(site, 3, { hub: true });      // an older build.json without control is fine (its index.html stays as it is)
    run(site, day(2));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hubScript (pageScript): the one script src of hub.html or index.html, or null', () => {
  assert.equal(hubScript, pageScript);
  assert.equal(pageScript(controlHtml('engines/control.0123456789.js')), 'engines/control.0123456789.js', 'its <script src defer>');
  assert.equal(hubScript(hubHtml('engines/hub.0123456789.js')), 'engines/hub.0123456789.js');
  assert.equal(hubScript('<SCRIPT defer SRC="engines/hub.a.js"></SCRIPT>'), 'engines/hub.a.js');
  assert.equal(hubScript('<script>inline()</script>'), null);
  assert.equal(hubScript('<script src="a.js"></script><script src="b.js"></script>'), null);
  assert.equal(hubScript(''), null);
});

test('only versioned files take part; no mtime changes; a second run with nothing changed changes nothing', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    version(site, 1, { current: false });
    const v2 = version(site, 2);
    put(site, 'sumika/engines/worker.0123456789.txt', 'not a runtime file');
    put(site, 'sumika/engines/Worker.0123456789.js', 'upper case: not ours');
    put(site, 'sumika/engines/sub/yaya.0123456789.js', 'in a subfolder');
    const plain = ['sumika/engines/satori.js', 'sumika/engines/satori.wasm', 'sumika/engines/satori.LICENSES.txt',
      'sumika/engines/satori.build-info.json', 'sumika/engines/worker.js', 'sumika/word_compatible.txt', 'sumika/sumika.js',
      'index.html', 'sumika/build.json', 'sumika/index/ghosts.json', 'sumika/engines/worker.0123456789.txt',
      'sumika/engines/Worker.0123456789.js', 'sumika/engines/sub/yaya.0123456789.js'];
    assert.deepEqual(versionedFiles(site).filter(p => plain.includes(p)), []);
    run(site, day(0), { first: true });
    const after = snapshot(site);
    for (const p of [...plain, ...v2]) assert.equal(after[p], OLD.getTime(), `${p} kept, its mtime untouched`);
    assert.deepEqual(Object.keys(after).sort(), [...plain, ...v2].sort());

    const l = fs.statSync(ledgerPath(site)).mtimeMs;
    const text = fs.readFileSync(ledgerPath(site), 'utf8');
    const r = run(site, day(5));
    assert.deepEqual([r.deleted, r.retired, r.wrote], [[], [], false]);
    assert.deepEqual(snapshot(site), after);
    assert.equal(fs.readFileSync(ledgerPath(site), 'utf8'), text);
    assert.equal(fs.statSync(ledgerPath(site)).mtimeMs, l, 'the ledger is not even rewritten');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the ledger is written whole: a run cut off before its rename leaves the last ledger and no temporary file, and the next run reads it', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    version(site, 1);
    run(site, day(0), { first: true });
    const text = fs.readFileSync(ledgerPath(site), 'utf8');
    version(site, 2);
    const rename = fs.renameSync;
    let renamed = null;
    fs.renameSync = (from, to) => {
      renamed = [path.basename(from), path.basename(to)];
      throw Object.assign(new Error('EPERM: cut off'), { code: 'EPERM' });
    };
    try {
      assert.throws(() => run(site, day(1)), /cut off/);
    } finally {
      fs.renameSync = rename;
    }
    assert.match(renamed[0], /^site\.published\.json\.tmp-[0-9a-f]{8}$/);
    assert.equal(renamed[1], 'site.published.json');
    assert.equal(fs.readFileSync(ledgerPath(site), 'utf8'), text, 'the last ledger as it was, never a torn one');
    assert.deepEqual(fs.readdirSync(path.dirname(site)).sort(), ['site', 'site.published.json'], 'no temporary file left');
    const r = run(site, day(1));
    assert.ok(r.wrote && r.retired.length, 'the next run reads it and goes through');
    assert.deepEqual(fs.readdirSync(path.dirname(site)).sort(), ['site', 'site.published.json']);
    assert.equal(ledger(site).format, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a ledger an editor saved with a BOM still reads', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    version(site, 1);
    run(site, day(0), { first: true });
    const text = fs.readFileSync(ledgerPath(site), 'utf8');
    fs.writeFileSync(ledgerPath(site), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
    version(site, 2);
    const r = run(site, day(1));
    assert.ok(r.wrote && r.retired.length, 'read and gone through');
    assert.equal(ledger(site).format, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the index of an older format stops the run with a code the admin words its own way (no-manifests); the line names the indexer', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    version(site, 1);
    put(site, 'sumika/index/ghosts.json', JSON.stringify({ format: 1, ghosts: [], balloons: [] }));
    assert.throws(() => run(site, day(0), { first: true }),
      e => e.refused && e.code === 'no-manifests' && /names no hashed manifests .*tools\/index_site\.py/.test(e.message));
    put(site, 'sumika/build.json', 'not json');
    assert.throws(() => run(site, day(0), { first: true }), e => e.refused && e.code === undefined, 'others have none');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the command line: exit 1 with no ledger and nothing deleted, --first then works, an unknown argument is exit 2', () => {
  const { dir, site } = tmpSite();
  try {
    plainFiles(site);
    const v1 = version(site, 1, { current: false });
    version(site, 2);
    const cli = args => spawnSync(process.execPath, [path.join(root, 'tools', 'prune.mjs'), ...args], { encoding: 'utf8' });
    let r = cli(['--site', site]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /no ledger/);
    for (const p of v1) assert.ok(exists(site, p), p);
    r = cli(['--site', site, '--first']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`prune: ${v1.length} current, ${v1.length} deleted`));
    for (const p of v1) assert.equal(exists(site, p), false, p);
    assert.equal(cli(['--nope']).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('on a Node without import.meta.main, prune.mjs and build.mjs still run as scripts (the script Node was started with); imported, neither runs', () => {
  const { dir } = tmpSite();
  try {
    // an older Node, where import.meta.main is undefined: the tools' source with it read so, through a module hook
    const hook = path.join(dir, 'no-main.mjs');
    fs.writeFileSync(hook, [
      "import { registerHooks } from 'node:module';",
      'registerHooks({ load(url, context, next) {',
      '  const r = next(url, context);',
      "  const tool = ['/tools/build.mjs', '/tools/prune.mjs'].find(t => url.endsWith(t));",
      '  if (!tool) return r;',
      "  process.stderr.write(`hooked ${tool}\\n`);",
      "  return { ...r, source: String(r.source).replaceAll('import.meta.main', 'undefined') };",
      '} });',
      ''].join('\n'));
    const node = (...args) => spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, ...args], { cwd: dir, encoding: 'utf8' });
    let r = node(path.join(root, 'tools', 'prune.mjs'), '--nope');
    assert.match(r.stderr, /hooked \/tools\/prune\.mjs/);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /prune: unknown argument --nope/);
    r = node(path.join(root, 'tools', 'build.mjs'), '--nope');
    assert.match(r.stderr, /hooked \/tools\/build\.mjs/);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /build stopped: unknown argument --nope/);
    const imp = path.join(dir, 'imp.mjs');
    fs.writeFileSync(imp, ['prune', 'build'].map(t => `await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools', `${t}.mjs`)).href)});\n`).join(''));
    r = node(imp, '--nope');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.replace(/hooked \/tools\/(prune|build)\.mjs\n/g, ''), '', 'both imported, neither ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

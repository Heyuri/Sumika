// The site index of safe updates: tools/index_site.py writes format 2, each manifest
// under a name holding the SHA-1 of its bytes (ghosts.json `manifests`), each pack under one holding the SHA-1 of its
// content before gzip (gzip bytes differ by zlib: the admin core's Node zlib), each file's version
// (`versions`, parallel to `files`: the SHA-1 of its bytes, 8 hex, the runtime's `?v=`), ghosts.json `versions` for
// the thumbnails and icons it names, and deletes nothing; the same site gives the same names, bytes and mtimes, and a
// pack another zlib wrote with the same content is kept. Runs Python (`python -I`; the environment variable PYTHON
// names another interpreter): no Python is a failure. The real site's half holds once the site is indexed ("re-run
// python -I tools/index_site.py"); its packs an older indexer wrote are named after their gzip bytes, which names
// one content too, until that index renames them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INDEX_FORMAT } from '../../src/core/loader.js';
import { siteIndexOf, manifestFile, manifestOf } from '../index_files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.env.PYTHON || 'python';
const sha1 = b => crypto.createHash('sha1').update(b).digest('hex');

function indexSite(site, cwd = root) {
  const r = spawnSync(PY, ['-I', '-B', path.join(root, 'tools', 'index_site.py'), site], { encoding: 'utf8', cwd });
  if (r.error) throw new Error(`this test runs Python (${PY}; set PYTHON to another): ${r.error.message}`);
  return r;
}

/** the head of a PNG (index_site.py png_size reads IHDR only) with a byte that tells files apart */
function png(w, h, tag = 0) {
  const b = Buffer.alloc(34);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[33] = tag;
  return b;
}

/** A scratch site: ghosts a (a shell with a thumbnail, a bundled balloon, an icon) and b, the shared balloon sumika. */
function makeSite(tmp) {
  const site = path.join(tmp, 'site');
  const put = (rel, data) => {
    const p = path.join(site, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  for (const id of ['a', 'b']) {
    put(`ghost/${id}/ghost/master/descript.txt`, `charset,UTF-8\r\nname,${id}\r\nsakura.name,${id.toUpperCase()}\r\nshiori,satori.dll\r\n`);
    put(`ghost/${id}/ghost/master/dic.txt`, `＊OnBoot\r\n：${id}\r\n`);
    put(`ghost/${id}/shell/master/descript.txt`, 'charset,UTF-8\r\nname,master\r\n');
    put(`ghost/${id}/shell/master/surface0.png`, png(80, 120, id.charCodeAt(0)));
    put(`ghost/${id}/thumbnail.png`, png(10, 10, id.charCodeAt(0) + 1));
  }
  put('ghost/a/ghost/master/icon.ico', 'ico');
  put('ghost/a/shell/master/thumbnail.png', png(8, 8, 3));
  put('ghost/a/bal/descript.txt', 'charset,UTF-8\r\ntype,balloon\r\nname,Bal\r\n');
  put('ghost/a/bal/balloons0.png', png(100, 50, 4));
  put('ghost/a/bal/thumbnail.png', png(6, 6, 5));
  put('balloon/sumika/descript.txt', 'charset,UTF-8\r\nname,sumika\r\n');
  put('balloon/sumika/balloons0.png', png(100, 50, 6));
  put('balloon/sumika/thumbnail.png', png(6, 6, 7));
  return site;
}

const indexDir = site => path.join(site, 'sumika', 'index');
/** {name: [mtimeMs, sha1]} of every file in SITE/sumika/index */
function snapshot(site) {
  const out = {};
  for (const n of fs.readdirSync(indexDir(site)).sort()) {
    const p = path.join(indexDir(site), n);
    out[n] = [fs.statSync(p).mtimeMs, sha1(fs.readFileSync(p))];
  }
  return out;
}
/** every file of SITE/sumika/index dated back to 2020 (so a rewrite shows) */
function backdate(site) {
  const t = new Date('2020-01-01T00:00:00Z');
  for (const n of fs.readdirSync(indexDir(site))) fs.utimesSync(path.join(indexDir(site), n), t, t);
}

/**
 * A pack's name holds the SHA-1 of its content before gzip; `legacy`: or of its gzip bytes, an older indexer's rule
 * (both name one content: the real site keeps such packs until its next index renames them).
 */
function packNamed(file, legacy) {
  const h = /\.([0-9a-f]{10})\.pack\.gz$/.exec(file)[1];
  const bytes = fs.readFileSync(file);
  return h === sha1(zlib.gunzipSync(bytes)).slice(0, 10) || (legacy && h === sha1(bytes).slice(0, 10));
}

/** The checks every indexed site passes (the scratch one, the real one): names, versions, ghosts.json `versions`. */
function checkSite(site, hint = '', { legacyPacks = false } = {}) {
  const idx = siteIndexOf(site);
  assert.equal(idx.format, 2, `ghosts.json format 2${hint}`);
  const hashes = new Map();
  const version = p => {
    if (!hashes.has(p)) hashes.set(p, sha1(fs.readFileSync(p)).slice(0, 8));
    return hashes.get(p);
  };
  const named = [];
  for (const kind of ['ghost', 'balloon']) {
    const list = kind === 'ghost' ? idx.ghosts : idx.balloons;
    assert.deepEqual(Object.keys(idx.manifests[kind]).sort(), list.map(e => e.id).sort(), `every ${kind} has a manifest${hint}`);
    for (const e of list) {
      const file = manifestFile(site, kind, e.id, idx);
      assert.ok(fs.existsSync(file), `${idx.manifests[kind][e.id]} exists${hint}`);
      const m = /\.([0-9a-f]{10})\.json$/.exec(path.basename(file));
      assert.ok(m, `${path.basename(file)}: a 10-hex name hash`);
      assert.equal(m[1], sha1(fs.readFileSync(file)).slice(0, 10), `${path.basename(file)} is named after its bytes${hint}`);
      const man = manifestOf(site, kind, e.id, idx);
      assert.equal(man.format, 2);
      assert.equal(man.id, e.id);
      assert.equal(man.versions.length, man.files.length, `${e.id}: one version per file`);
      const top = path.join(site, ...man.root.split('/'));
      man.files.forEach(([p], i) => {
        assert.equal(man.versions[i], version(path.join(top, ...p.split('/'))), `${kind} ${e.id}: ${p}'s version${hint}`);
      });
      if (man.pack) {
        const pack = path.join(site, ...man.pack.split('/'));
        assert.ok(fs.existsSync(pack), `${man.pack} exists${hint}`);
        assert.ok(packNamed(pack, legacyPacks), `${man.pack} is named after its content${hint}`);
      }
      named.push(...(e.thumbnails || []));
      for (const k of ['icon', 'iconMinimize']) if (e[k]) named.push(e[k]);
      for (const s of [...(e.shells || []), ...(e.bundledBalloons || [])]) named.push(...(s.thumbnails || []));
    }
  }
  assert.deepEqual(Object.keys(idx.versions).sort(), [...new Set(named)].sort(), `ghosts.json versions: every thumbnail and icon it names${hint}`);
  for (const p of named) assert.equal(idx.versions[p], version(path.join(site, ...p.split('/'))), `${p}'s version${hint}`);
  return idx;
}

test('index_site.py: format 2, manifests named after their bytes, a version per file, ghosts.json `versions` for every thumbnail and icon; the entries keep their shape', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-index-'));
  try {
    const site = makeSite(tmp);
    const r = indexSite(site);
    assert.equal(r.status, 0, r.stderr);
    const idx = checkSite(site);
    assert.deepEqual(Object.keys(idx), ['format', 'ghosts', 'balloons', 'defaultBalloon', 'manifests', 'versions']);
    assert.match(idx.manifests.ghost.a, /^sumika\/index\/ghost\.a\.[0-9a-f]{10}\.json$/);
    assert.match(idx.manifests.balloon.bal, /^sumika\/index\/balloon\.bal\.[0-9a-f]{10}\.json$/);
    // the ghost and balloon entries: nothing of the versions in them (thumbList, indexGhostRecord, the sweep)
    const a = idx.ghosts.find(g => g.id === 'a');
    assert.deepEqual(Object.keys(a), ['id', 'name', 'sakuraName', 'keroName', 'craftman', 'shiori', 'engine', 'thumbnails',
      'icon', 'shells', 'defaultShell', 'bundledBalloons', 'balloon']);
    assert.deepEqual(a.shells, [{ id: 'master', name: 'master', thumbnails: ['ghost/a/shell/master/thumbnail.png'] }]);
    assert.deepEqual(a.bundledBalloons, [{ dir: 'bal', name: 'Bal', thumbnails: ['ghost/a/bal/thumbnail.png'] }]);
    assert.deepEqual(idx.balloons.map(b => Object.keys(b)), [['id', 'name', 'ghost', 'thumbnails'], ['id', 'name', 'thumbnails']]);
    assert.equal(idx.versions['ghost/a/ghost/master/icon.ico'], sha1(Buffer.from('ico')).slice(0, 8));
    // the manifest: the [path, size, w?, h?] tuples, `versions` beside them
    const m = manifestOf(site, 'ghost', 'a', idx);
    assert.deepEqual(Object.keys(m), ['format', 'id', 'root', 'files', 'versions', 'pack']);
    assert.deepEqual(m.files.find(f => f[0] === 'shell/master/surface0.png'), ['shell/master/surface0.png', 34, 80, 120]);
    // nothing but the hashed names: no fixed ghost.<id>.json
    const names = fs.readdirSync(indexDir(site));
    assert.deepEqual(names.filter(n => /^(ghost|balloon)\.[^.]+\.json$/.test(n)), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('re-index: one changed PNG changes its ghost\'s manifest name and that one version; the other ghost\'s manifest and pack stay untouched, the old manifest stays; nothing changed gives the same names, bytes and mtimes from any working directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-index-'));
  try {
    const site = makeSite(tmp);
    assert.equal(indexSite(site).status, 0);
    const before = siteIndexOf(site);
    backdate(site);
    const snap = snapshot(site);
    // nothing changed, run from the scratch folder: the same files, none rewritten
    let r = indexSite(site, tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(snapshot(site), snap, 'same names, bytes and mtimes');

    const manA = manifestOf(site, 'ghost', 'a', before);
    const manB = manifestOf(site, 'ghost', 'b', before);
    fs.writeFileSync(path.join(site, 'ghost', 'a', 'shell', 'master', 'surface0.png'), png(80, 120, 99));
    r = indexSite(site);
    assert.equal(r.status, 0, r.stderr);
    const after = checkSite(site);
    assert.notEqual(after.manifests.ghost.a, before.manifests.ghost.a, 'A: a new manifest name');
    const manA2 = manifestOf(site, 'ghost', 'a', after);
    const changed = manA.versions.map((v, i) => (v !== manA2.versions[i] ? manA.files[i][0] : null)).filter(Boolean);
    assert.deepEqual(changed, ['shell/master/surface0.png'], 'that one version changed');
    assert.equal(manA2.pack, manA.pack, 'A\'s text did not change: the same pack');
    assert.equal(after.manifests.ghost.b, before.manifests.ghost.b, 'B: the same manifest name');
    assert.deepEqual(after.manifests.balloon, before.manifests.balloon);
    const now = snapshot(site);
    for (const n of [path.basename(before.manifests.ghost.a), path.basename(before.manifests.ghost.b), path.basename(manB.pack)]) {
      assert.deepEqual(now[n], snap[n], `${n}: kept, its mtime unchanged`);
    }
    assert.deepEqual(Object.keys(now).filter(n => !(n in snap)), [path.basename(after.manifests.ghost.a)], 'only A\'s new manifest is new');
    assert.notDeepEqual(now['ghosts.json'], snap['ghosts.json'], 'ghosts.json names the new manifest');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a refused index (a personal file) writes and deletes nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-index-'));
  try {
    const site = makeSite(tmp);
    assert.equal(indexSite(site).status, 0);
    backdate(site);
    const snap = snapshot(site);
    fs.writeFileSync(path.join(site, 'ghost', 'a', 'ghost', 'master', 'satori_savedata.txt'), 'x');
    fs.writeFileSync(path.join(site, 'ghost', 'b', 'ghost', 'master', 'dic.txt'), '＊OnBoot\r\n：changed\r\n');
    const r = indexSite(site);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing to index/);
    assert.deepEqual(snapshot(site), snap);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('index_site.py FORMAT = loader.js INDEX_FORMAT', () => {
  const py = fs.readFileSync(path.join(root, 'tools', 'index_site.py'), 'utf8');
  const m = /^FORMAT = (\d+)$/m.exec(py);
  assert.ok(m, 'FORMAT in tools/index_site.py');
  assert.equal(Number(m[1]), INDEX_FORMAT);
});

test('the site: every manifest and pack ghosts.json names exists and is named after its bytes (a pack: its content), every version matches its file', () => {
  checkSite(path.join(root, 'site'), ': re-run python -I tools/index_site.py', { legacyPacks: true });
});

test('a pack is named after its content, and one that holds the same content under another zlib\'s bytes is kept', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-index-'));
  try {
    const site = makeSite(tmp);
    assert.equal(indexSite(site).status, 0);
    const man = manifestOf(site, 'ghost', 'a');
    const pack = path.join(site, ...man.pack.split('/'));
    const raw = zlib.gunzipSync(fs.readFileSync(pack));
    assert.equal(/\.([0-9a-f]{10})\.pack\.gz$/.exec(man.pack)[1], sha1(raw).slice(0, 10), 'the SHA-1 of the content');
    // the same content deflated otherwise (level 1, another OS byte): kept as it is, bytes and mtime
    const other = zlib.gzipSync(raw, { level: 1 });
    fs.writeFileSync(pack, other);
    backdate(site);
    const before = fs.statSync(pack).mtimeMs;
    assert.equal(indexSite(site).status, 0);
    assert.ok(fs.readFileSync(pack).equals(other), 'kept: not written again');
    assert.equal(fs.statSync(pack).mtimeMs, before);
    // a damaged pack of that name is written again
    fs.writeFileSync(pack, other.subarray(0, other.length - 9));
    assert.equal(indexSite(site).status, 0);
    assert.ok(zlib.gunzipSync(fs.readFileSync(pack)).equals(raw), 'rewritten');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

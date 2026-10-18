// The Kawari save-header net end to end (kawari-wasm.md §12 [decision]): on a
// scratch site, tools/index_site.py refuses a Kawari ghost that holds a file starting with Kawari's save header, as
// the real build's `save` writes it (K11: CRLF) and as Phase 7 wrote it, and tools/add_ghost.py refuses such a ghost
// before it copies anything. A file `textsave` wrote (no header) passes, and so does a header in a ghost of another
// engine. Runs Python (`python -I -B`; the environment variable PYTHON names another interpreter): no Python is a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KawariEngine } from '../../src/worker/engines/kawari.js';
import { buildRequest } from '../../src/core/shiori.js';
import { loadEngineFactory } from '../load_engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'kawari.js');
const FIXTURES = path.join(root, 'tests', 'fixtures', 'ghost');
const PY = process.env.PYTHON || 'python';
const TEXT = /\.(txt|kis)$/i;

class NodeKawari extends KawariEngine {
  async factory() { return loadEngineFactory('kawari'); }
}

function py(args) {
  const r = spawnSync(PY, ['-I', '-B', ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`this test runs Python (${PY}; set PYTHON to another): ${r.error.message}`);
  return r;
}

function files(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...files(dir, rel + e.name + '/'));
    else out.push(rel + e.name);
  }
  return out;
}

/** What the real build writes: `save` (OnUnload's, with Kawari's header) and `textsave` (none), and the encoder. */
async function realWrites() {
  assert.ok(fs.existsSync(ENGINE_JS), 'site/sumika/engines/kawari.js is missing: run python engines/kawari/build.py');
  const dir = path.join(FIXTURES, 'kawaritest');
  const e = new NodeKawari({ engineUrl: ENGINE_JS, log: () => {}, opts: { ghostId: 'kawaritest', placeholders: [], site: { ghosts: [], balloons: [] } } });
  await e.boot();
  const list = files(dir).filter(p => TEXT.test(p)).map(p => {
    const b = fs.readFileSync(path.join(dir, p));
    return { path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  });
  assert.equal(e.init(list, {}, {}), true);
  const ask = (id, refs = []) => e.request(buildRequest({ id, refs }, { Charset: 'UTF-8', Sender: 'SSP', SecurityLevel: 'local' }));
  ask('OnFirstBoot');
  ask('ShioriEcho', ['$(textsave plain.txt word)']);
  const read = p => Buffer.from(e.M.FS.readFile(e.ghostDir + p));
  const plain = read('plain.txt');
  const phase7 = Buffer.from(e._cp932('華和梨セーブファイル'));
  e.unload();
  return { saved: read('save.txt'), plain, phase7 };
}

function copyGhost(from, to) {
  for (const p of files(from)) {
    fs.mkdirSync(path.dirname(path.join(to, p)), { recursive: true });
    fs.copyFileSync(path.join(from, p), path.join(to, p));
  }
}

test('the Kawari save net: index_site.py refuses a save the real build wrote (CRLF), an LF one and Phase 7\'s; add_ghost.py copies nothing; textsave output and other engines pass', async () => {
  const { saved, plain, phase7 } = await realWrites();
  assert.equal(saved.subarray(0, 25).toString('latin1'), '#\r\n# Kawari saved file\r\n#', 'K11: the header in CRLF');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-kawari-guard-'));
  try {
    const src = path.join(tmp, 'src', 'kawaritest');
    copyGhost(path.join(FIXTURES, 'kawaritest'), src);
    fs.writeFileSync(path.join(src, 'ghost', 'master', 'save.txt'), saved);
    const site = path.join(tmp, 'site');
    fs.mkdirSync(site);
    const index = () => py([path.join(root, 'tools', 'index_site.py'), site]);
    const listed = () => JSON.parse(fs.readFileSync(path.join(site, 'sumika', 'index', 'ghosts.json'), 'utf8')).ghosts
      .map(g => `${g.id}:${g.engine}`);

    // add_ghost.py: refused before anything is copied
    const add = py([path.join(root, 'tools', 'add_ghost.py'), src, '--id', 'kawaritest', '--site', site]);
    assert.notEqual(add.status, 0, add.stdout);
    assert.match(add.stderr, /start with Kawari's save header/);
    assert.match(add.stderr, /ghost\/master\/save\.txt/);
    assert.equal(fs.existsSync(path.join(site, 'ghost', 'kawaritest')), false, 'nothing copied');

    // index_site.py on a site that holds it all the same (a hand copy)
    const dst = path.join(site, 'ghost', 'kawaritest');
    copyGhost(src, dst);
    let r = index();
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /refusing to index/);
    assert.match(r.stderr, /ghost\/kawaritest\/ghost\/master\/save\.txt/);
    assert.equal(fs.existsSync(path.join(site, 'sumika', 'index', 'ghosts.json')), false, 'no index written');

    // the same header with LF line ends, and Phase 7's (華和梨セーブファイル in code page 932), in a kawari7 ghost
    const lf = Buffer.from(saved.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    fs.writeFileSync(path.join(dst, 'ghost', 'master', 'save.txt'), lf);
    r = index();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ghost\/kawaritest\/ghost\/master\/save\.txt/);
    fs.rmSync(path.join(dst, 'ghost', 'master', 'save.txt'));
    const k7 = path.join(site, 'ghost', 'k7', 'ghost', 'master');
    fs.mkdirSync(k7, { recursive: true });
    fs.writeFileSync(path.join(k7, 'descript.txt'), 'charset,Shift_JIS\r\nname,k7\r\nshiori,shiori.dll\r\n');
    fs.writeFileSync(path.join(k7, 'kawari.ini'), 'dictfile,dict.txt\r\n');
    fs.writeFileSync(path.join(k7, 'memory.txt'), Buffer.concat([Buffer.from('#\r\n# '), phase7, Buffer.from('\r\n#\r\nname : x\r\n')]));
    r = index();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ghost\/k7\/ghost\/master\/memory\.txt/);
    assert.doesNotMatch(r.stderr, /kawaritest/);
    fs.rmSync(path.join(site, 'ghost', 'k7'), { recursive: true });

    // what textsave wrote has no header: indexed; so is a header in a Satori ghost (Kawari only as a SAORI)
    fs.writeFileSync(path.join(dst, 'ghost', 'master', 'plain.txt'), plain);
    const satori = path.join(site, 'ghost', 'testghost');
    copyGhost(path.join(FIXTURES, 'testghost'), satori);
    fs.writeFileSync(path.join(satori, 'ghost', 'master', 'kawari-save.txt'), saved);
    r = index();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(listed().sort(), ['kawaritest:kawari', 'testghost:satori']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

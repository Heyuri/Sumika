// sumika-admin end to end (CLAUDE.md "The program and its builds"):
// `node admin/server/main.mjs --no-browser --settings … --temp …` as a child process, driven over real HTTP through
// admin/server/drive.mjs's steps (the build's smoke runs the same steps against the compiled program): hello, a wrong
// Host, the site, add from a folder, a .nar and a drop, the ghost list, Check, Prepare upload, hub.json, the preview, a
// junction inside an added ghost (Check names it, Remove leaves what it points to), Quit. Everything on scratch folders
// under os.tmpdir(); the steps refuse any path inside the project.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runE2E, scratchOnly, startProgram, client, makeSite } from '../../admin/server/drive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN = path.join(ROOT, 'admin', 'server', 'main.mjs');

function scratch(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-e2e-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return scratchOnly(d);
}

test('the steps refuse a folder inside the project', () => {
  assert.throws(() => scratchOnly(path.join(ROOT, 'site')), /inside the project/);
  assert.throws(() => scratchOnly(ROOT), /inside the project/);
  assert.equal(scratchOnly(os.tmpdir()), os.tmpdir());
});

test('end to end: a dev run of the program from hello to Quit on a scratch site', { timeout: 180000 }, async t => {
  const d = scratch(t);
  const report = await runE2E({ command: process.execPath, args: [MAIN], scratch: d });
  assert.match(report.version, /^\d+\.\d+\.\d+-dev$/);
  assert.deepEqual(report.ghosts, ['droppedghost', 'testghost', 'testghost_nar']);
  assert.deepEqual(report.prepare.last, ['sumika/hub.html', 'sumika/sumika.js', 'sumika/index/ghosts.json']);
  assert.ok(report.index['ghosts.json'], 'the site\'s index');
  const gj = JSON.parse(report.index['ghosts.json'].toString('utf8'));
  assert.deepEqual(gj.ghosts.map(g => g.id), ['droppedghost', 'testghost_nar']);
  assert.match(report.output.out, /このウィンドウを閉じると sumika-admin は終了します。/, 'the console lines in both languages');
  assert.equal(report.output.err, '');
});

test('a second start opens the live one instead; a start after it ended takes the temp root over', { timeout: 120000 }, async t => {
  const d = scratch(t);
  const first = startProgram({ command: process.execPath, args: [MAIN], scratch: d });
  const { port, key } = await first.ready;
  t.after(() => { if (first.child.exitCode === null) first.child.kill(); });
  const second = startProgram({ command: process.execPath, args: [MAIN], scratch: d });
  const ended = await second.exited;
  assert.equal(ended.code, 0);
  const out = second.output().out;
  assert.match(out, /already running/);
  assert.ok(out.includes(`http://127.0.0.1:${port}/?key=${key}`), 'it names the live one');
  const api = client(port, key);
  assert.equal((await api.post('/api/quit')).status, 200);
  assert.equal((await first.exited).code, 0);
  // a dead instance's leftovers: instance.json naming a closed port, a run folder, a journal of an add cut off in its
  // copy, and that copy in the site's work folder
  fs.writeFileSync(path.join(first.temp, 'instance.json'), JSON.stringify({ pid: 1, port, key, version: 'x', startedAt: 0 }));
  fs.mkdirSync(path.join(first.temp, 'r-0a0b0c', 'drops'), { recursive: true });
  const site = makeSite(path.join(d, 'site'));
  const staged = path.join(site, '.sumika-admin-work', 'new-0a0b0c-emily4');
  fs.mkdirSync(path.join(staged, 'ghost', 'master'), { recursive: true });
  fs.writeFileSync(path.join(first.temp, 'job.json'), JSON.stringify({
    id: 'a1', kind: 'add', label: 'Emily', startedAt: 1, site, ghosts: [{ id: 'emily4', name: 'Emily' }], step: 'copy', ghost: 'emily4',
    placed: [],
  }));
  const third = startProgram({ command: process.execPath, args: [MAIN], scratch: d });
  t.after(() => { if (third.child.exitCode === null) third.child.kill(); });
  const r3 = await third.ready;
  const api3 = client(r3.port, r3.key);
  // it serves at once and settles the work folder after (in its job worker): hello says `starting` until then
  let hello = (await api3.call('GET', '/api/hello')).body;
  for (let i = 0; i < 200 && hello.starting; i++) {
    await new Promise(r => setTimeout(r, 50));
    hello = (await api3.call('GET', '/api/hello')).body;
  }
  assert.equal(hello.starting, false);
  assert.deepEqual(hello.interrupted, {
    kind: 'add', label: 'Emily', startedAt: 1, step: 'copy', outcome: 'unchanged', ghosts: [{ id: 'emily4', name: 'Emily', placed: false }],
  });
  assert.ok(!fs.existsSync(path.join(site, '.sumika-admin-work')), 'the cut-off copy is deleted at the start');
  assert.match(fs.readFileSync(path.join(first.temp, 'sumika-admin.log'), 'utf8'), /new-0a0b0c-emily4: deleted[\s\S]*outcome unchanged/,
    'the start says in the log what it found');
  assert.ok(!fs.existsSync(path.join(first.temp, 'r-0a0b0c')), 'the dead run folder is gone');
  assert.ok(!fs.existsSync(path.join(first.temp, 'job.json')), 'the journal was read once');
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.temp, 'instance.json'), 'utf8')).port, r3.port);
  const old = await api.call('GET', '/api/hello').catch(() => null);
  assert.ok(!old || old.status === 403, 'the first start\'s address and key are dead');
  assert.equal((await api3.post('/api/quit')).status, 200);
  assert.equal((await third.exited).code, 0);
});

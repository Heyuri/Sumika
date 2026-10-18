// The admin program's handler (CONTRACTS "Admin API"), called directly with Request objects (no
// sockets): the guards, bodies, one job at a time, the path rules, settings, the temp root and instance takeover, the
// file browser, drops, hub.json against the publish gate, Check, Prepare upload, the version guard, the project-site
// guard, the ghost list, the job worker. Every folder is a scratch folder under os.tmpdir(); the project is only read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from '../../admin/core/api.mjs';
import { parseAllowlist } from '../../src/hub/allowlist.js';
import { createApp } from '../../admin/server/app.mjs';
import { Jobs, workerRunner } from '../../admin/server/jobs.mjs';
import { work } from '../../admin/server/work.mjs';
import { Drops } from '../../admin/server/drops.mjs';
import { safeRelPath, inside, places, drives } from '../../admin/server/paths.mjs';
import { settingsPlace, loadSettings, saveSettings, addRecent, SETTINGS_NAME } from '../../admin/server/settings.mjs';
import {
  liveInstance, cleanRuns, makeRun, takeJournal, dropJournal, journal, journalSteps, settleStart, makeRoot, writeInstance,
  readInstance,
} from '../../admin/server/instance.mjs';
import { errorLog, catchStray } from '../../admin/server/log.mjs';
import { entryProblem, ENTRY_CODES } from '../../admin/server/hubentry.mjs';
import { runtimeFindings } from '../../admin/server/check.mjs';
import { CODE_LIST, message as programMessage } from '../../admin/server/codes.mjs';
import { makeSite, STALE, scratchOnly, client } from '../../admin/server/drive.mjs';
import { ENV_NAMES, start, settleSite } from '../../admin/server/main.mjs';
import { zip } from '../../admin/zip.mjs';
import { uploadList } from '../../admin/server/upload.mjs';
import { localDay, RETAIN_DAYS } from '../../tools/prune.mjs';
import { buildPage, permissions, TARGETS, ENV_ALLOWED } from '../../admin/build.mjs';
import { openZip } from '../../tools/sweep/zip.mjs';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'ghost', 'testghost');
const PORT = 4321;
const KEY = 'ab'.repeat(32);
const PAGE = { html: '<!doctype html><title>admin</title><p>page</p>', csp: 'default-src \'none\'' };

function scratch(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return scratchOnly(d);
}

const put = (root, rel, data = '') => {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
};

/** A program on a scratch folder: its handler, and req() to call it as a browser would. */
function harness(t, o = {}) {
  const dir = scratch(t);
  const run = path.join(dir, 'run');
  fs.mkdirSync(path.join(run, 'x'), { recursive: true });
  const st = loadSettings({ file: path.join(dir, 'settings.json'), where: 'given' });
  const runner = o.runner || ((kind, args, onProgress) => work(kind, args, { core, onProgress }));
  const jobs = new Jobs({ runner, journal: o.journal || null });
  const drops = new Drops(run);
  const quits = [];
  const app = createApp({
    port: PORT, key: KEY, page: PAGE, st, jobs, drops, xDir: path.join(run, 'x'), forbidden: o.forbidden || [],
    serve: async () => { throw new Error('no sockets in this test'); }, onQuit: () => quits.push(1), env: {},
  });
  const responses = [];
  async function req(method, p, { body, headers = {}, host = `127.0.0.1:${PORT}`, key = KEY, raw } = {}) {
    const h = new Headers(headers);
    if (key !== null) h.set('X-Sumika-Admin-Key', key);
    let b;
    if (raw !== undefined) b = raw;
    else if (body !== undefined) {
      b = JSON.stringify(body);
      if (!h.has('content-type')) h.set('Content-Type', 'application/json');
    }
    const init = { method, headers: h };
    if (b !== undefined) {
      init.body = b;
      init.duplex = 'half';
    }
    const res = await app.handle(new Request(`http://127.0.0.1:${PORT}${p}`, init), { host });
    responses.push(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: res.status, headers: res.headers, json, text };
  }
  /** Starts a job through the API and waits for its end. */
  async function job(p, body = {}) {
    const r = await req('POST', p, { body });
    assert.equal(r.status, 200, `${p}: ${r.text}`);
    await jobs.done;
    return jobs.snapshot();
  }
  return { dir, run, st, jobs, drops, app, req, job, quits, responses };
}

/** A synthetic site (admin/server/drive.mjs makeSite), indexed, chosen in the harness. */
async function withSite(h) {
  const site = makeSite(path.join(h.dir, 'site'));
  await core.indexSite(site);
  const r = await h.req('POST', '/api/site', { body: { path: site } });
  assert.equal(r.status, 200, r.text);
  return fs.realpathSync.native(site);
}

test('the guards: Host, Origin, the method, the key; no CORS header on any answer', async t => {
  const h = harness(t);
  const page = await h.req('GET', '/', { key: null });
  assert.equal(page.status, 200);
  assert.equal(page.text, PAGE.html);
  assert.equal(page.headers.get('content-security-policy'), PAGE.csp);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  for (const host of [`localhost:${PORT}`, '127.0.0.1', `127.0.0.1:${PORT + 1}`, `[::1]:${PORT}`, `evil.example:${PORT}`, '']) {
    for (const p of ['/', '/api/hello']) {
      const r = await h.req('GET', p, { host });
      assert.equal(r.status, 403, `${host} ${p}`);
      assert.equal(r.json.error.code, 'bad-host');
    }
  }
  for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${PORT + 1}`, `http://localhost:${PORT}`, `https://127.0.0.1:${PORT}`]) {
    const r = await h.req('GET', '/api/hello', { headers: { Origin: origin } });
    assert.equal(r.status, 403, origin);
    assert.equal(r.json.error.code, 'bad-origin');
  }
  assert.equal((await h.req('GET', '/api/hello', { headers: { Origin: `http://127.0.0.1:${PORT}` } })).status, 200);
  assert.equal((await h.req('GET', '/api/hello')).status, 200);
  for (const p of ['/', '/api/hello', '/api/site']) {
    const r = await h.req('OPTIONS', p, { headers: { Origin: `http://127.0.0.1:${PORT}`, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(r.status, 405, p);
    assert.equal(r.json.error.code, 'method');
  }
  assert.equal((await h.req('GET', '/api/site')).status, 405);
  assert.equal((await h.req('POST', '/api/hello', { body: {} })).status, 405);
  assert.equal((await h.req('GET', '/api/nothing')).json.error.code, 'not-found');
  assert.equal((await h.req('GET', '/favicon.ico', { key: null })).status, 404);
  const none = await h.req('GET', '/api/hello', { key: null });
  assert.deepEqual([none.status, none.json.error.code], [403, 'no-key']);
  const empty = await h.req('GET', '/api/hello', { key: '' });
  assert.deepEqual([empty.status, empty.json.error.code], [403, 'no-key']);
  for (const key of ['cd'.repeat(32), KEY.slice(1), `${KEY}0`]) {
    const r = await h.req('POST', '/api/fs/roots', { key, body: {} });
    assert.deepEqual([r.status, r.json.error.code], [403, 'bad-key']);
  }
  const hello = await h.req('GET', '/api/hello');
  assert.equal(hello.json.app, 'sumika-admin');
  assert.deepEqual(Object.keys(hello.json).sort(), ['app', 'interrupted', 'job', 'os', 'pick', 'picker', 'preview', 'settings', 'site', 'siteError',
    'starting', 'version']);
  assert.equal(hello.json.picker, false, 'no picker given: the page\'s file browser');
  assert.deepEqual([hello.json.pick, hello.json.starting], [null, false]);
  assert.equal(hello.json.settings.where, 'given');
  for (const res of h.responses) {
    for (const [k] of res.headers) assert.ok(!k.startsWith('access-control-'), `${k} on an answer`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('POST bodies: JSON only (415), at most 1 MiB (413), an object (400)', async t => {
  const h = harness(t);
  const text = await h.req('POST', '/api/fs/roots', { raw: '{}', headers: { 'Content-Type': 'text/plain' } });
  assert.deepEqual([text.status, text.json.error.code], [415, 'not-json']);
  const none = await h.req('POST', '/api/fs/roots', { raw: '{}' });
  assert.equal(none.status, 415);
  const big = await h.req('POST', '/api/fs/list', { body: { path: 'x'.repeat(1 << 20) } });
  assert.deepEqual([big.status, big.json.error.code], [413, 'too-large']);
  for (const raw of ['not json', '[1]', 'null', '"x"']) {
    const r = await h.req('POST', '/api/fs/roots', { raw, headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual([r.status, r.json.error.code], [400, 'bad-request'], raw);
  }
  const ok = await h.req('POST', '/api/settings', { raw: '{"language":"ja"}', headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.language, 'ja');
});

test('one job at a time: 409 busy, progress in status, the result after it ends; Quit refused while busy', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness(t, {
    runner: async (kind, args, onProgress) => {
      onProgress({ phase: 'extract', done: 1, total: 3, item: 'a.nar' });
      await gate;
      return { items: [], seen: args.sources.length };
    },
  });
  const started = await h.req('POST', '/api/inspect', { body: { sources: [{ path: h.dir }] } });
  assert.equal(started.status, 200);
  assert.equal(started.json.state, 'running');
  assert.equal(started.json.kind, 'inspect');
  const busy = await h.req('POST', '/api/inspect', { body: { sources: [{ path: h.dir }] } });
  assert.deepEqual([busy.status, busy.json.error.code, busy.json.error.params.kind], [409, 'busy', 'inspect']);
  const quit = await h.req('POST', '/api/quit', { body: {} });
  assert.deepEqual([quit.status, quit.json.error.code], [409, 'busy']);
  const mid = (await h.req('GET', '/api/status')).json.job;
  assert.deepEqual([mid.state, mid.phase, mid.done, mid.total, mid.item], ['running', 'extract', 1, 3, 'a.nar']);
  release();
  await h.jobs.done;
  const end = (await h.req('GET', '/api/status')).json.job;
  assert.equal(end.state, 'done');
  assert.deepEqual(end.result, { items: [], seen: 1 });
  assert.equal(end.id, started.json.id);
  assert.ok(end.endedAt >= end.startedAt);
  const ok = await h.req('POST', '/api/quit', { body: {} });
  assert.deepEqual(ok.json, { ok: true });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(h.quits.length, 1);
});

test('a failed job keeps its finding; the next job replaces it', async t => {
  const h = harness(t, {
    runner: async kind => {
      if (kind === 'inspect') throw { code: 'source.missing', params: { path: 'x' }, message: 'x: no such file or folder' };
      return {};
    },
  });
  await h.req('POST', '/api/inspect', { body: { sources: [{ path: h.dir }] } });
  await h.jobs.done;
  const job = (await h.req('GET', '/api/status')).json.job;
  assert.equal(job.state, 'failed');
  assert.equal(job.error.code, 'source.missing');
});

test('safeRelPath: the program\'s rule for dropped and served paths', () => {
  for (const ok of ['a', 'a/b.txt', 'ゴースト/ghost/master/descript.txt', 'a..b', '.DS_Store', 'shell/master/surface0.png',
    'con2', 'console.txt', 'a b/c', 'comx', 'lpt']) {
    assert.ok(safeRelPath(ok), ok);
  }
  assert.deepEqual(safeRelPath('a/b/c'), ['a', 'b', 'c']);
  for (const bad of ['', '/a', 'a//b', './a', 'a/./b', '../a', 'a/..', '..', 'a\\b', 'C:/x', 'a:b', 'x/a:stream',
    'a\u0000b', 'a\u001fb', 'a\u007fb', 'CON', 'con.txt', 'nul', 'a/COM1/b', 'LPT9.log', 'com\u00b9', 'AUX .txt',
    'conin$', 'a ', 'a.', 'a/b./c', 'x<y', 'x>y', 'x"y', 'x|y', 'x?y', 'x*y', null, 42, undefined]) {
    assert.equal(safeRelPath(bad), null, JSON.stringify(bad));
  }
});

test('inside(): real paths; a junction pointing out is not inside', t => {
  const d = scratch(t);
  const root = path.join(d, 'root'), out = path.join(d, 'out');
  put(root, 'a/file.txt');
  put(out, 'secret.txt');
  fs.symlinkSync(out, path.join(root, 'j'), 'junction');
  assert.ok(inside(root, path.join(root, 'a', 'file.txt')));
  assert.ok(inside(root, path.join(root, 'new.txt')), 'a file not there yet: its parent counts');
  assert.ok(!inside(root, root));
  assert.ok(!inside(root, path.join(out, 'secret.txt')));
  assert.ok(!inside(root, path.join(root, 'j', 'secret.txt')), 'through the junction');
  assert.ok(!inside(root, path.join(root, 'j', 'new.txt')));
  assert.ok(!inside(root, path.join(root, '..', 'out', 'secret.txt')));
  assert.ok(!inside(path.join(d, 'missing'), path.join(d, 'missing', 'x')));
  if (process.platform === 'win32') assert.ok(inside(root.toUpperCase(), path.join(root, 'a', 'file.txt')), 'any case on Windows');
});

test('settings: beside the program, app-data when its folder takes no file, both there: beside; a bad file is never written over', t => {
  const d = scratch(t);
  const env = { APPDATA: path.join(d, 'appdata') };
  const prog = path.join(d, 'prog');
  fs.mkdirSync(prog);
  const beside = settingsPlace({ compiled: true, programDir: prog, platform: 'win32', env });
  assert.deepEqual(beside, { file: path.join(prog, SETTINGS_NAME), where: 'beside' });
  assert.deepEqual(fs.readdirSync(prog), [], 'the probe file is gone');
  const notDir = put(d, 'afile', 'a file where the program\'s folder would be');
  const app = settingsPlace({ compiled: true, programDir: notDir, platform: 'win32', env });
  assert.deepEqual(app, { file: path.join(d, 'appdata', 'sumika-admin', SETTINGS_NAME), where: 'appdata' });
  const st = loadSettings(app);
  assert.equal(saveSettings(st, { site: 'C:\\sites\\mine', language: 'ja' }), true);
  assert.equal(settingsPlace({ compiled: true, programDir: prog, platform: 'win32', env }).where, 'appdata', 'an app-data file and none beside');
  put(prog, SETTINGS_NAME, '{"format": 1, "site": null, "recent": []}\n');
  assert.equal(settingsPlace({ compiled: true, programDir: prog, platform: 'win32', env }).where, 'beside', 'both: beside');
  assert.equal(settingsPlace({ compiled: false, programDir: prog, platform: 'win32', env }).where, 'appdata', 'from source: app-data');
  assert.deepEqual(settingsPlace({ given: path.join(d, 'x.json'), compiled: true, programDir: prog, env }), { file: path.join(d, 'x.json'), where: 'given' });
  // the file: unknown keys kept, language absent = follow the browser, 1-space indent
  const f = put(d, 'keep.json', '{"format": 1, "site": "C:\\\\s", "recent": ["C:\\\\s"], "future": {"x": 1}}');
  const kept = loadSettings({ file: f, where: 'given' });
  assert.equal(kept.problem, null);
  saveSettings(kept, { language: 'en' });
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n "format": 1,\n "site": "C:\\\\s",\n "recent": [\n  "C:\\\\s"\n ],\n "language": "en",\n "future": {\n  "x": 1\n }\n}\n');
  saveSettings(kept, { language: null });
  assert.ok(!('language' in JSON.parse(fs.readFileSync(f, 'utf8'))));
  // a bad file
  for (const text of ['not json', '[1]', '{"format": 2}']) {
    const bad = put(d, 'bad.json', text);
    const b = loadSettings({ file: bad, where: 'given' });
    assert.equal(b.problem.code, 'settings-bad', text);
    assert.equal(saveSettings(b, { language: 'ja' }), false);
    assert.equal(fs.readFileSync(bad, 'utf8'), text, 'never written over');
    assert.equal(b.data.language, 'ja', 'the change holds for this run');
  }
  // recent: newest first, no duplicates (any case on Windows), at most 10
  let recent = [];
  for (let i = 0; i < 12; i++) recent = addRecent(recent, `C:\\f${i}`, 'win32');
  assert.equal(recent.length, 10);
  assert.equal(recent[0], 'C:\\f11');
  assert.deepEqual(addRecent(['C:\\A', 'C:\\b'], 'c:\\a', 'win32'), ['c:\\a', 'C:\\b']);
  assert.deepEqual(addRecent(['/A'], '/a', 'linux'), ['/a', '/A']);
});

test('the settings route: the language, the site and the recent folders are saved', async t => {
  const h = harness(t);
  const file = h.st.file;
  assert.equal((await h.req('POST', '/api/settings', { body: { language: 'xx' } })).status, 400);
  const ja = await h.req('POST', '/api/settings', { body: { language: 'ja' } });
  assert.equal(ja.json.language, 'ja');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).language, 'ja');
  const site = await withSite(h);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.site, site);
  assert.equal(saved.recent[0], site);
  await h.req('POST', '/api/inspect', { body: { sources: [{ path: FIXTURE }] } });
  await h.jobs.done;
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).recent[0], path.dirname(FIXTURE), 'the folder sources were picked in');
  const hello = (await h.req('GET', '/api/hello')).json;
  assert.equal(hello.site.path, site);
  assert.equal(hello.siteError, null);
  fs.rmSync(path.join(site, 'sumika', 'sumika.js'));
  const gone = (await h.req('GET', '/api/hello')).json;
  assert.equal(gone.site, null);
  assert.equal(gone.siteError.code, 'not-a-site');
});

test('the temp root: a dead instance is taken over, stale run folders go (a junction in one as a link), the journal is read once', async t => {
  const d = scratch(t);
  const root = makeRoot(path.join(d, 'temp'));
  const outside = path.join(d, 'outside');
  put(outside, 'keep.txt', 'not the program\'s');
  put(root, 'r-abcdef/drops/x/file.txt', 'x');
  fs.symlinkSync(outside, path.join(root, 'r-abcdef', 'link'), 'junction');
  fs.mkdirSync(path.join(root, 'r-123456'));
  fs.mkdirSync(path.join(root, 'other'));
  writeInstance(root, { pid: 1, port: 9, key: 'dead', version: 'x', startedAt: 0 });
  assert.deepEqual(readInstance(root).key, 'dead');
  assert.equal(await liveInstance(root, { fetchImpl: async () => { throw new Error('refused'); } }), null);
  assert.equal(await liveInstance(root, { fetchImpl: async () => new Response('{"app":"other"}', { status: 200 }) }), null);
  let asked = null;
  const live = await liveInstance(root, {
    fetchImpl: async (url, init) => {
      asked = [url, init.headers['X-Sumika-Admin-Key']];
      return new Response('{"app":"sumika-admin"}', { status: 200 });
    },
  });
  assert.equal(live.port, 9);
  assert.deepEqual(asked, ['http://127.0.0.1:9/api/hello', 'dead']);
  assert.equal(cleanRuns(root), 2);
  assert.deepEqual(fs.readdirSync(root).sort(), ['instance.json', 'other']);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'what the junction pointed to stays');
  const run = makeRun(root);
  assert.match(path.basename(run), /^r-[0-9a-f]{6}$/);
  assert.deepEqual(fs.readdirSync(run).sort(), ['drops', 'x']);
  journal(root).write({ kind: 'add', label: 'Emily', startedAt: 5 });
  assert.deepEqual(takeJournal(root), { kind: 'add', label: 'Emily', startedAt: 5, placed: [], ghosts: [] }, 'an older start\'s journal: no step');
  assert.equal(takeJournal(root), null);
  assert.ok(!fs.existsSync(path.join(root, 'job.json')));
});

test('the journal: written at a job\'s start, deleted at its end, kept when the program closes mid-job', async t => {
  const root = makeRoot(path.join(scratch(t), 'temp'));
  let release;
  const runner = () => new Promise(r => { release = r; });
  const jobs = new Jobs({ runner, journal: journal(root) });
  const tick = () => new Promise(r => setImmediate(r));
  jobs.start('index', {}, { label: '' });
  assert.ok(fs.existsSync(path.join(root, 'job.json')));
  await tick();
  release({});
  await jobs.done;
  assert.ok(!fs.existsSync(path.join(root, 'job.json')));
  jobs.start('add', {}, { label: 'Tsubasa' });
  await tick();
  jobs.close();
  release({});
  await jobs.done;
  assert.deepEqual(takeJournal(root).label, 'Tsubasa', 'a job the close cut off is known at the next start');
  assert.throws(() => jobs.start('index', {}), e => e.code === 'busy' && /is busy/.test(e.message));
});

test('fs/list: folders first, ghost badges, archives and update lists, links never followed', async t => {
  const h = harness(t);
  const dir = path.join(h.dir, 'list');
  put(dir, 'b ghost/ghost/master/descript.txt', 'charset,UTF-8\r\nname,ビー\r\n');
  fs.mkdirSync(path.join(dir, 'a folder'));
  for (const f of ['z.nar', 'x.ZIP', 'updates2.dau', 'readme.txt', 'file10.txt', 'file9.txt']) put(dir, f, 'x');
  const out = put(path.join(h.dir, 'out'), 'secret/x.txt');
  fs.symlinkSync(path.dirname(out), path.join(dir, 'link'), 'junction');
  const r = await h.req('POST', '/api/fs/list', { body: { path: dir } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.path, fs.realpathSync.native(dir));
  assert.equal(r.json.parent, path.dirname(fs.realpathSync.native(dir)));
  assert.deepEqual(r.json.entries.map(e => e.name), ['a folder', 'b ghost', 'link', 'file9.txt', 'file10.txt', 'readme.txt', 'updates2.dau', 'x.ZIP', 'z.nar']);
  const by = Object.fromEntries(r.json.entries.map(e => [e.name, e]));
  assert.deepEqual(by['b ghost'], { name: 'b ghost', kind: 'dir', ghost: { name: 'ビー' } });
  assert.deepEqual(by.link, { name: 'link', kind: 'link', target: 'dir' });
  assert.equal(by['z.nar'].archive, true);
  assert.equal(by['x.ZIP'].archive, true);
  assert.equal(by['updates2.dau'].list, true);
  assert.equal(by['readme.txt'].size, 1);
  assert.ok(!r.json.entries.some(e => e.name === 'x.txt'));
  const via = await h.req('POST', '/api/fs/list', { body: { path: path.join(dir, 'link') } });
  assert.equal(via.json.path, fs.realpathSync.native(path.dirname(out)), 'a link lists its target, by its real path');
  for (const [p, code] of [['relative/path', 'path-not-absolute'], [path.join(dir, 'missing'), 'path-missing'],
    [path.join(dir, 'z.nar'), 'path-not-folder']]) {
    const e = await h.req('POST', '/api/fs/list', { body: { path: p } });
    assert.deepEqual([e.status, e.json.error.code], [400, code], p);
  }
  assert.equal((await h.req('POST', '/api/fs/list', { body: {} })).status, 400);
});

test('fs/roots: the drives that answer, the ones that do not, and the places', async () => {
  const stat = async d => {
    if (d === 'C:\\' || d === 'D:\\') return {};
    if (d === 'E:\\') return new Promise(() => {});           // a drive that never answers
    throw Object.assign(new Error('no'), { code: 'ENOENT' });
  };
  assert.deepEqual(await drives({ platform: 'win32', stat, timeoutMs: 30 }), { drives: ['C:\\', 'D:\\'], unavailable: ['E:\\'] });
  assert.deepEqual(await drives({ platform: 'linux' }), { drives: ['/'], unavailable: [] });
  const have = new Set(['C:\\Users\\a', 'C:\\Users\\a\\Desktop', 'C:\\Users\\a\\OneDrive\\Desktop', 'C:\\Users\\a\\Downloads', 'C:\\prog', 'C:\\r1']);
  const exists = p => have.has(p);
  if (process.platform === 'win32') {
    assert.deepEqual(places({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\a' }, programDir: 'C:\\prog', recent: ['C:\\r1', 'C:\\gone'], exists }), [
      { kind: 'home', path: 'C:\\Users\\a' }, { kind: 'desktop', path: 'C:\\Users\\a\\Desktop' },
      { kind: 'desktop', path: 'C:\\Users\\a\\OneDrive\\Desktop' }, { kind: 'downloads', path: 'C:\\Users\\a\\Downloads' },
      { kind: 'program', path: 'C:\\prog' }, { kind: 'recent', path: 'C:\\r1' },
    ]);
  }
  assert.deepEqual(places({ platform: 'linux', env: {}, exists: () => true }), []);
});

test('drops: paths checked, never over another file, done names the roots, cancel deletes, nothing outside the run folder', async t => {
  const h = harness(t);
  const before = fs.readdirSync(h.dir).sort();
  const id = (await h.req('POST', '/api/drop', { body: {} })).json.drop;
  assert.match(id, /^[0-9a-f]{16}$/);
  const send = (n, rel, data = 'x', drop = id) => h.req('PUT', `/api/drop/${drop}/${n}`, {
    raw: data, headers: rel === null ? {} : { 'X-Sumika-Path': rel, 'Content-Type': 'application/octet-stream' },
  });
  for (const rel of ['..%2Fx', 'g/..%2F..%2Fx', '%2E%2E/x', 'C%3A/x', 'g%5Cx', '', 'a//b', '%2Fabs', 'g/CON', 'g/a%3Fb', '%E0%A4%A']) {
    const r = await send(0, rel);
    assert.deepEqual([r.status, r.json.error.code], [400, 'drop-bad-path'], rel);
  }
  assert.equal((await send(0, null)).status, 400, 'no path');
  assert.equal((await send('01', 'g/x')).status, 400);
  assert.equal((await send('x', 'g/x')).status, 404, 'n is a number');
  for (const [rel, body] of [['g/ghost/master/descript.txt', 'charset,UTF-8\r\nname,Dropped\r\n'], ['g/%E3%82%B4.txt', 'ゴ'], ['g/a', 'a']]) {
    const r = await send(0, rel, body);
    assert.equal(r.status, 200, `${rel}: ${r.text}`);
  }
  assert.equal(fs.readFileSync(path.join(h.run, 'drops', id, '0', 'g', 'ゴ.txt'), 'utf8'), 'ゴ');
  const twice = await send(0, 'g/a');
  assert.deepEqual([twice.status, twice.json.error.code], [409, 'drop-exists']);
  assert.equal((await send(0, 'g/a/b')).status, 409, 'a file where a folder would be');
  assert.equal(fs.readFileSync(path.join(h.run, 'drops', id, '0', 'g', 'a'), 'utf8'), 'a', 'never written over');
  put(path.join(h.run, 'drops', id, '1'), 'z.nar', 'not really');
  assert.equal((await h.req('POST', `/api/drop/${id}/done`, { body: { roots: [{ n: 0, name: '../g', kind: 'dir' }] } })).status, 400);
  assert.equal((await h.req('POST', `/api/drop/${id}/done`, { body: { roots: [{ n: 0, name: 'missing.nar', kind: 'file' }] } })).json.error.code, 'drop-bad-root');
  const done = await h.req('POST', `/api/drop/${id}/done`, { body: { roots: [{ n: 0, name: 'g', kind: 'dir' }, { n: 1, name: 'z.nar', kind: 'file' }] } });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.kind, 'inspect');
  await h.jobs.done;
  const items = h.jobs.snapshot().result.items;
  assert.deepEqual(items.map(i => i.dropped.name), ['g', 'z.nar']);
  assert.equal(items[0].name, 'Dropped');
  assert.ok(items[0].token, 'a ghost that can be added has a token');
  assert.ok(items[0].source.path.startsWith(path.join(h.run, 'drops', id)));
  assert.equal(items[1].token, null, 'an archive Sumika cannot read cannot be added');
  assert.equal(items[1].refusal.code, 'archive.unreadable');
  assert.equal((await send(0, 'g/late')).json.error.code, 'drop-closed');
  const id2 = (await h.req('POST', '/api/drop', { body: {} })).json.drop;
  assert.equal((await send(0, 'h/x', 'x', id2)).status, 200);
  assert.deepEqual((await h.req('POST', `/api/drop/${id2}/cancel`, { body: {} })).json, { ok: true });
  assert.ok(!fs.existsSync(path.join(h.run, 'drops', id2)), 'cancel deletes its files');
  assert.equal((await send(0, 'h/y', 'x', id2)).json.error.code, 'drop-missing');
  assert.equal((await h.req('POST', `/api/drop/${'0'.repeat(16)}/cancel`, { body: {} })).json.error.code, 'drop-missing');
  assert.deepEqual(fs.readdirSync(h.dir).sort(), before, 'nothing written outside the run folder');
});

test('hub.json: each entry\'s code agrees with the publish gate (parseAllowlist, https: and http: hubs, no loopback)', t => {
  const site = scratch(t);
  fs.mkdirSync(path.join(site, 'sumika'));
  const entries = [
    'https://a.example.com', 'https://a.example.com/', 'HTTPS://A.EXAMPLE.COM', 'https://a.example.com:8443',
    'http://a.example.com', ' https://a.example.com ', 'https://例え.jp', 'https://xn--r8jz45g.jp', 'http://0.0.0.0',
    null, 123, true, 'null', '', 'example.com', 'a.example.com:443', 'https://*.example.com', '*',
    'ftp://a.example.com', 'javascript:alert(1)', 'file:///C:/x', 'https://u:p@a.example.com', 'https://@a.example.com',
    'https://u@a.example.com', 'https://a.example.com?', 'https://a.example.com/#', 'https://a.example.com/?q=1',
    'https://a.example.com/x', 'https://a.example.com/x/', 'http://localhost:8644', 'http://LOCALHOST', 'http://127.0.0.1',
    'http://127.1.2.3:9', 'http://[::1]:8000', 'http://a.localhost', 'http://localhost/x', 'https://localhost?x',
    'http://*.localhost', 'http://[::ffff:7f00:1]', 'https://exa mple.com', 'https://a.example.com:99999',
  ];
  for (const entry of entries) {
    fs.writeFileSync(path.join(site, 'sumika', 'hub.json'), JSON.stringify({ format: 1, origins: [entry] }));
    const gate = core.hubFindings(site);
    const code = entryProblem(entry);
    assert.equal(code !== null, gate.length > 0, `${JSON.stringify(entry)}: ${code} vs ${JSON.stringify(gate)}`);
    if (code) {
      assert.ok(ENTRY_CODES.includes(code));
      assert.equal(gate[0].code, code === 'loopback' ? 'hub.loopback' : 'hub.ignored', JSON.stringify(entry));
    }
    // and the parser itself: a problem exactly when a hub on neither scheme keeps it, or it is a loopback origin
    const text = JSON.stringify({ format: 1, origins: [entry] });
    const keptAnywhere = ['https://hub.invalid/', 'http://hub.invalid/'].some(u => parseAllowlist(text, u).origins.size > 0);
    let loop = false;
    try { loop = /^(localhost|.*\.localhost|127\.|\[::1\]|\[::ffff:7f)/.test(new URL(entry).hostname); } catch (e) { loop = false; }
    assert.equal(code !== null, !keptAnywhere || loop, `${JSON.stringify(entry)} against parseAllowlist`);
  }
  // an object or a list in origins: no hub keeps it (parseAllowlist: not a string); the gate pairs the two parses' ignored
  // entries by identity, which two parses of an object never share, so only the parser is the reference here
  for (const entry of [{ origin: 'x' }, ['https://a.example.com']]) {
    const text = JSON.stringify({ format: 1, origins: [entry] });
    assert.ok(['https://hub.invalid/', 'http://hub.invalid/'].every(u => parseAllowlist(text, u).origins.size === 0));
    assert.equal(entryProblem(entry), 'not-string');
  }
});

test('hub.json: read with its findings, saved only without a problem, deleted for an empty list', async t => {
  const h = harness(t);
  const site = await withSite(h);
  const file = path.join(site, 'sumika', 'hub.json');
  const empty = await h.req('POST', '/api/hub', { body: {} });
  assert.deepEqual(empty.json, { exists: false, origins: [], problems: [], runtimeHasHub: true });
  const bad = await h.req('POST', '/api/hub/save', { body: { origins: ['https://a.example.com', 'http://localhost:8644', 'https://b.example.com/x'] } });
  assert.equal(bad.json.ok, false);
  assert.deepEqual(bad.json.problems.map(p => [p.code, p.params.index, p.params.entry]), [['loopback', 1, 'http://localhost:8644'], ['has-path', 2, 'https://b.example.com/x']]);
  assert.ok(!fs.existsSync(file), 'nothing written');
  const ok = await h.req('POST', '/api/hub/save', { body: { origins: [' https://a.example.com ', 'https://b.example.com:8443'] } });
  assert.deepEqual(ok.json, { ok: true, problems: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n "format": 1,\n "origins": [\n  "https://a.example.com",\n  "https://b.example.com:8443"\n ]\n}\n');
  assert.deepEqual((await h.req('POST', '/api/hub', { body: {} })).json.origins, ['https://a.example.com', 'https://b.example.com:8443']);
  fs.writeFileSync(file, JSON.stringify({ format: 1, origins: ['https://a.example.com', 'http://127.0.0.1:8644', 'https://*.example.com'] }));
  const read = (await h.req('POST', '/api/hub', { body: {} })).json;
  assert.deepEqual(read.problems.map(p => [p.code, p.params.entry, p.params.reason]), [['hub.loopback', 'http://127.0.0.1:8644', 'loopback'], ['hub.ignored', 'https://*.example.com', 'wildcard']]);
  assert.equal((await h.req('POST', '/api/hub/save', { body: { origins: 'x' } })).status, 400);
  assert.deepEqual((await h.req('POST', '/api/hub/save', { body: { origins: [] } })).json, { ok: true, problems: [] });
  assert.ok(!fs.existsSync(file), 'an empty list deletes the file');
  fs.writeFileSync(file, 'not json');
  assert.equal((await h.req('POST', '/api/hub', { body: {} })).json.problems[0].code, 'hub.unusable');
});

test('Check: the core\'s findings, the runtime set as prune reads it, 404.html, hub.json and links, as codes', async t => {
  const h = harness(t);
  const site = await withSite(h);
  const clean = await h.job('/api/check');
  assert.equal(clean.state, 'done', JSON.stringify(clean.error));
  assert.deepEqual(clean.result, { ok: true, problems: [] });
  // the runtime set, as tools/prune.mjs would stop on it
  const read = rel => fs.readFileSync(path.join(site, ...rel.split('/')), 'utf8');
  const write = (rel, text) => fs.writeFileSync(path.join(site, ...rel.split('/')), text);
  const js = read('sumika/sumika.js'), hubHtml = read('sumika/hub.html');
  fs.renameSync(path.join(site, 'sumika', 'engines', 'satori.1111111111.js'), path.join(site, 'sumika', 'engines', 'satori.js.bak'));
  write('sumika/sumika.js', js.replace('engines/satori.2222222222.wasm', 'x'));
  write('sumika/hub.html', '<script src="engines/hub.4444444444.js"></script>');
  const man = fs.readdirSync(path.join(site, 'sumika', 'index')).find(n => /^ghost\.|^balloon\./.test(n) && n.endsWith('.json'));
  const manText = read(`sumika/index/${man}`);
  write(`sumika/index/${man}`, 'not json');
  assert.deepEqual(runtimeFindings(site).map(f => [f.code, f.params]), [
    ['runtime-missing', { file: 'sumika/engines/satori.1111111111.js' }], ['hub-html', {}],
    ['bundle-stale', { file: 'engines/satori.2222222222.wasm' }], ['bad-json', { file: `sumika/index/${man}` }],
  ]);
  write('sumika/sumika.js', `${js}\n// b0b0b0b0b0b0\n`);
  assert.deepEqual(runtimeFindings(site).map(f => f.code).filter(c => c === 'bundle-stale'), ['bundle-stale']);
  fs.renameSync(path.join(site, 'sumika', 'engines', 'satori.js.bak'), path.join(site, 'sumika', 'engines', 'satori.1111111111.js'));
  write('sumika/sumika.js', js);
  write('sumika/hub.html', hubHtml);
  write(`sumika/index/${man}`, manText);
  // ghosts.json naming no manifests: prune's own line tells a developer to run the Python indexer; Check says it in
  // the page's words (index-old, fixed by Update the index), and once only beside the stale index
  const gj = read('sumika/index/ghosts.json');
  write('sumika/index/ghosts.json', JSON.stringify({ format: 2, ghosts: [] }));
  const old = runtimeFindings(site);
  assert.deepEqual(old.map(f => f.code), ['index-old']);
  assert.doesNotMatch(old[0].message, /python|index_site/i);
  const oldCheck = await h.job('/api/check');
  assert.deepEqual(oldCheck.result.problems.map(p => p.code), ['index-stale']);
  write('sumika/index/ghosts.json', gj);
  // a stale index, a personal file, no 404.html, a hub.json problem, a link
  put(site, 'ghost/kid/ghost/master/descript.txt', 'charset,UTF-8\r\nname,Kid\r\n');
  fs.rmSync(path.join(site, '404.html'));
  write('sumika/hub.json', JSON.stringify({ format: 1, origins: ['http://localhost:1'] }));
  const outside = put(path.join(h.dir, 'outside'), 'x.txt');
  fs.symlinkSync(path.dirname(outside), path.join(site, 'balloon', 'linked'), 'junction');
  const dirty = await h.job('/api/check');
  assert.deepEqual(dirty.result.problems.map(p => p.code), ['index-stale', 'no-404', 'hub.loopback', 'site.link']);
  const stale = dirty.result.problems[0];
  assert.ok(stale.params.count >= 1 && stale.files.some(f => f.path === 'sumika/index/ghosts.json'), JSON.stringify(stale));
  assert.deepEqual(dirty.result.problems[3].params, { path: 'balloon/linked' });
  put(site, 'ghost/kid/ghost/master/satori_savedata.txt', 'the user\'s');
  const personal = await h.job('/api/check');
  assert.equal(personal.result.problems[0].code, 'site.personal');
  assert.deepEqual(personal.result.problems[0].files.map(f => f.path), ['ghost/kid/ghost/master/satori_savedata.txt']);
  assert.ok(!personal.result.problems.some(p => p.code === 'index-stale'), 'no index run would pass: no stale list');
});

test('Check: the control page (sumika/index.html) as prune reads it, in the page\'s words: missing, or naming another script', async t => {
  const h = harness(t);
  const site = await withSite(h);
  const bj = path.join(site, 'sumika', 'build.json');
  const control = 'engines/control.5555555555.js';
  fs.writeFileSync(bj, JSON.stringify({ ...JSON.parse(fs.readFileSync(bj, 'utf8')), control }));
  fs.writeFileSync(path.join(site, 'sumika', ...control.split('/')), '// a stand-in control script\n');
  const page = path.join(site, 'sumika', 'index.html');
  const found = () => runtimeFindings(site).map(f => [f.code, f.params]);
  assert.deepEqual(found(), [['runtime-missing', { file: 'sumika/index.html' }]]);
  fs.writeFileSync(page, `<!doctype html>\n<script src="${control}" defer></script>\n`);
  assert.deepEqual(found(), []);
  fs.writeFileSync(page, '<!doctype html>\n<script src="engines/control.6666666666.js" defer></script>\n');
  const other = runtimeFindings(site);
  assert.deepEqual(other.map(f => [f.code, f.params]), [['control-html', {}]], 'never runtime-problem with prune\'s line');
  assert.doesNotMatch(other[0].message, /npm|run /, 'no developer\'s command reaches the admin');
});

test('Prepare upload: needs-first without a ledger; first deletes what no upload carried; the upload order; Check first', async t => {
  const h = harness(t);
  const site = await withSite(h);
  const none = await h.req('POST', '/api/prepare', { body: {} });
  assert.deepEqual([none.status, none.json.error.code], [409, 'needs-first']);
  assert.equal((await h.req('POST', '/api/prepare', { body: { first: true, retireAll: true } })).status, 400);
  const first = await h.job('/api/prepare', { first: true });
  assert.equal(first.state, 'done', JSON.stringify(first.error));
  const r = first.result;
  assert.deepEqual(r.deleted, [STALE]);
  assert.deepEqual(r.deleteOnHost, [STALE]);
  assert.ok(!fs.existsSync(path.join(site, ...STALE.split('/'))));
  assert.equal(r.ledger, `${site}.published.json`);
  assert.ok(fs.existsSync(r.ledger));
  const paths = r.files.map(f => f.path);
  assert.deepEqual(paths.slice(-3), ['sumika/hub.html', 'sumika/sumika.js', 'sumika/index/ghosts.json']);
  assert.deepEqual(r.last, ['sumika/index.html', 'sumika/hub.html', 'sumika/sumika.js', 'sumika/index/ghosts.json']);
  assert.ok(!paths.some(p => p.startsWith('dev/')), 'dev/ is never uploaded');
  assert.ok(paths.includes('404.html') && paths.includes('balloon/sumika/descript.txt'));
  assert.equal(r.count, paths.length);
  assert.equal(r.bytes, r.files.reduce((n, f) => n + f.size, 0));
  assert.equal(r.files.find(f => f.path === 'sumika/engines/satori.js').optional, 'plain-engine');
  assert.equal(r.files.find(f => f.path === 'sumika/engines/worker.0123456789.js.map').optional, 'map');
  assert.equal(r.files.find(f => f.path === 'sumika/engines/worker.0123456789.js').optional, undefined);
  const again = await h.req('POST', '/api/prepare', { body: { first: true } });
  assert.deepEqual([again.status, again.json.error.code], [409, 'ledger-exists']);
  const next = await h.job('/api/prepare', {});
  assert.equal(next.state, 'done');
  assert.deepEqual(next.result.deleted, []);
  fs.rmSync(path.join(site, '404.html'));
  const refused = await h.job('/api/prepare', {});
  assert.equal(refused.state, 'failed');
  assert.equal(refused.error.code, 'check-failed');
  assert.deepEqual(refused.error.problems.map(p => p.code), ['no-404']);
});

test('Prepare upload: a record of uploads that does not read is ledger-unreadable, nothing changed; Start a new record sets it aside under a name of its own and retires every old file', async t => {
  const h = harness(t);
  const site = await withSite(h);
  const ledger = `${site}.published.json`;
  const stale = path.join(site, ...STALE.split('/'));
  const day = localDay(new Date());
  for (const [i, text] of ['not json', JSON.stringify({ format: 2, published: [] })].entries()) {
    fs.writeFileSync(ledger, text);
    const broken = await h.job('/api/prepare', {});
    assert.deepEqual([broken.state, broken.error.code, broken.error.params], ['failed', 'ledger-unreadable', { ledger, days: RETAIN_DAYS }], `${i}`);
    assert.doesNotMatch(programMessage('ledger-unreadable', broken.error.params), /--|retire-all|prune/, 'no command-line flag in what the page may show');
    assert.ok(fs.existsSync(stale) && fs.readFileSync(ledger, 'utf8') === text, 'nothing changed');
    // the first-upload question is for a site without a record: refused
    assert.equal((await h.req('POST', '/api/prepare', { body: { retireAll: true } })).json.error.code, 'ledger-exists');
  }
  assert.equal((await h.req('POST', '/api/prepare', { body: { newRecord: true, first: true } })).status, 400);
  // a Check with problems: the record stays as it is
  fs.rmSync(path.join(site, '404.html'));
  const unchecked = await h.job('/api/prepare', { newRecord: true });
  assert.deepEqual([unchecked.state, unchecked.error.code], ['failed', 'check-failed']);
  assert.ok(fs.existsSync(ledger) && !fs.existsSync(`${ledger}.broken-${day}`));
  fs.writeFileSync(path.join(site, '404.html'), '<!doctype html><title>Not found</title>\n');
  // Start a new record: set aside, then as for a lost record (nothing deleted, every old file retired today)
  const fresh = await h.job('/api/prepare', { newRecord: true });
  assert.equal(fresh.state, 'done', JSON.stringify(fresh.error));
  assert.equal(fresh.result.setAside, `${ledger}.broken-${day}`);
  assert.equal(fs.readFileSync(fresh.result.setAside, 'utf8'), JSON.stringify({ format: 2, published: [] }), 'kept as it was');
  assert.deepEqual([fresh.result.retireAll, fresh.result.deleted, fresh.result.retired], [true, [], [STALE]]);
  assert.ok(fs.existsSync(stale));
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8')).retired[STALE], day);
  assert.ok(!fresh.result.files.some(f => /published\.json/.test(f.path)), 'neither is uploaded');
  // once more on the same day: the next name, never over the first
  fs.writeFileSync(ledger, '{');
  const again = await h.job('/api/prepare', { newRecord: true });
  assert.equal(again.result.setAside, `${ledger}.broken-${day}-2`);
  assert.equal(fs.readFileSync(`${ledger}.broken-${day}`, 'utf8'), JSON.stringify({ format: 2, published: [] }));
  // a record that reads (repaired meanwhile, or another tab's Start a new record came first) is never set aside, and
  // said in its own words, not as "first upload" / "record lost"; none at all is a lost record
  const kept = fs.readFileSync(ledger, 'utf8');
  const readable = await h.job('/api/prepare', { newRecord: true });
  assert.deepEqual([readable.state, readable.error.code, readable.error.params], ['failed', 'ledger-reads', { ledger }]);
  assert.equal(fs.readFileSync(ledger, 'utf8'), kept);
  assert.ok(!fs.existsSync(`${ledger}.broken-${day}-3`), 'nothing set aside');
  fs.rmSync(ledger);
  const lost = await h.job('/api/prepare', { newRecord: true });
  assert.deepEqual([lost.state, lost.result.setAside, lost.result.retireAll], ['done', null, true]);
});

test('Prepare upload never lists a temporary file of the Kawari record or hub.json; the job\'s settling deletes one a cut-off write left first', async t => {
  const h = harness(t);
  const site = await withSite(h);
  put(site, 'sumika/kawari-shipped.json.tmp-0123abcd', '{}');
  put(site, 'sumika/hub.json.tmp-4567cdef', '{"format": 1, "origins": []}');
  assert.ok(!uploadList(site).some(f => /\.tmp-/.test(f.path)), 'never listed');
  const first = await h.job('/api/prepare', { first: true });
  assert.equal(first.state, 'done', JSON.stringify(first.error));
  for (const n of ['kawari-shipped.json.tmp-0123abcd', 'hub.json.tmp-4567cdef']) {
    assert.equal(fs.existsSync(path.join(site, 'sumika', n)), false, `${n} settled first`);
  }
});

test('Check: a Kawari record that does not read is one problem in its own words, never the Kawari files as personal ones', async t => {
  const h = harness(t);
  const site = await withSite(h);
  put(site, 'sumika/kawari-shipped.json', '\ufeff{"format": 1, "ghosts": {}}');
  assert.deepEqual((await h.job('/api/check')).result, { ok: true, problems: [] }, 'an editor\'s BOM reads');
  put(site, 'sumika/kawari-shipped.json', '{"format": 1, "ghosts": {"kid": [["ghost/master/x.txt", "1"]]}}');
  const r = await h.job('/api/check');
  assert.deepEqual(r.result.problems.map(p => [p.code, p.params]), [['kawari.record', { problem: 'record.entries' }]]);
  assert.match(r.result.problems[0].message, /^stopped, nothing changed: sumika\/kawari-shipped\.json cannot be read: an entry/);
  // an add or the index answers the same
  const index = await h.job('/api/index');
  assert.deepEqual([index.state, index.error.code, index.error.params], ['failed', 'kawari.record', { problem: 'record.entries' }]);
});

test('the version guard: another Sumika version\'s index or runtime opens read-only', async t => {
  const h = harness(t);
  const site = await withSite(h);
  const gj = path.join(site, 'sumika', 'index', 'ghosts.json');
  const text = fs.readFileSync(gj, 'utf8');
  fs.writeFileSync(gj, text.replace(/"format": 2/, '"format": 1'));
  const info = (await h.req('POST', '/api/site', { body: { path: site } })).json;
  assert.equal(info.readOnly, 'index-format');
  assert.deepEqual(info.readOnlyInfo.params, { format: 1, expected: core.FORMAT });
  for (const [p, body] of [['/api/index', {}], ['/api/remove', { id: 'x' }], ['/api/prepare', { first: true }], ['/api/hub/save', { origins: [] }], ['/api/add', { plan: [{ token: 'x' }] }]]) {
    const r = await h.req('POST', p, { body });
    assert.deepEqual([r.status, r.json.error.code, r.json.error.params.reason], [409, 'read-only', 'index-format'], p);
  }
  assert.equal((await h.req('POST', '/api/check', { body: {} })).status, 200, 'Check only reads');
  await h.jobs.done;
  fs.writeFileSync(gj, text);
  const bj = path.join(site, 'sumika', 'build.json');
  const build = JSON.parse(fs.readFileSync(bj, 'utf8'));
  fs.writeFileSync(bj, JSON.stringify({ ...build, schema: { ...build.schema, state: 99 } }));
  const schema = (await h.req('POST', '/api/site', { body: { path: site } })).json;
  assert.equal(schema.readOnly, 'schema');
  assert.deepEqual(schema.readOnlyInfo.params, { kind: 'state', schema: 99, expected: 1 });
  fs.writeFileSync(bj, JSON.stringify({ ...build, schema: { ...build.schema, future: 1 } }));
  assert.equal((await h.req('POST', '/api/site', { body: { path: site } })).json.readOnly, 'schema', 'a kind this tree lacks counts as newer (tools/build.mjs)');
  fs.writeFileSync(bj, JSON.stringify(build));
  assert.equal((await h.req('POST', '/api/site', { body: { path: site } })).json.readOnly, null);
});

test('the site: whether its runtime has the control page (sumika/index.html) and whether it has a page at its top', async t => {
  const h = harness(t);
  const site = await withSite(h);
  const info = async () => (await h.req('POST', '/api/site', { body: { path: site } })).json;
  const first = await info();
  assert.deepEqual([first.runtime.hub, first.runtime.control, first.front], [true, false, true], 'makeSite: a hub, no control page, a demo page');
  fs.writeFileSync(path.join(site, 'sumika', 'index.html'), '<!doctype html><title>Sumika</title>\n');
  fs.rmSync(path.join(site, 'index.html'));
  const then = await info();
  assert.deepEqual([then.runtime.control, then.front], [true, false]);
  assert.equal((await h.req('GET', '/api/hello')).json.site.runtime.control, true, 'hello\'s SiteInfo too');
  fs.mkdirSync(path.join(site, 'index.html'));
  assert.equal((await info()).front, false, 'only a file counts');
});

test('the site: a folder without the runtime is no site; the project\'s own site/ is refused', async t => {
  const projectSite = path.join(ROOT, 'site');
  const h = harness(t, { forbidden: [projectSite] });
  const plain = path.join(h.dir, 'plain');
  fs.mkdirSync(plain);
  const no = await h.req('POST', '/api/site', { body: { path: plain } });
  assert.deepEqual([no.status, no.json.error.code], [400, 'not-a-site']);
  for (const p of [projectSite, path.join(projectSite, 'ghost'), path.join(projectSite, 'sumika')]) {
    if (!fs.existsSync(p)) continue;
    const r = await h.req('POST', '/api/site', { body: { path: p } });
    assert.deepEqual([r.status, r.json.error.code], [400, 'project-site'], p);
  }
  assert.equal(h.st.data.site, null, 'nothing saved');
  for (const p of ['/api/ghosts', '/api/check', '/api/hub', '/api/preview/start']) {
    assert.equal((await h.req('POST', p, { body: {} })).json.error.code, 'no-site', p);
  }
});

test('the ghost list: Change ghost ▸\'s order (ssp.exe\'s: by descript name, ties by folder), indexed or not, whatever the index\'s order', async t => {
  const h = harness(t);
  const site = await withSite(h);
  const names = { b: 'Bee', d: 'Dee', c: 'シー', a: 'しー', Z: 'Ghost Z', y: 'Dee' };
  for (const [id, name] of Object.entries(names)) put(site, `ghost/${id}/ghost/master/descript.txt`, `charset,UTF-8\r\nname,${name}\r\n`);
  put(site, 'ghost/x/ghost/master/descript.txt', 'charset,UTF-8\r\ntype,ghost\r\n');         // no name: its folder id
  fs.mkdirSync(path.join(site, 'ghost', 'notaghost'));
  const gj = path.join(site, 'sumika', 'index', 'ghosts.json');
  const index = JSON.parse(fs.readFileSync(gj, 'utf8'));
  index.ghosts = [                     // an index an older tool wrote: folder order, and ghosts it does not name
    { id: 'b', name: 'Bee', engine: 'aya' },
    { id: 'd', name: 'Dee', engine: 'satori', bundledBalloons: [{ dir: 'bb', name: 'Bee Balloon' }] },
    { id: 'e', name: 'Gone', engine: 'yaya' },
    { id: 'y', name: 'Dee', engine: 'satori' },
  ];
  fs.writeFileSync(gj, JSON.stringify(index));
  const r = (await h.req('POST', '/api/ghosts', { body: {} })).json;
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.ghosts.map(g => [g.id, g.indexed, g.folder]), [
    ['b', true, true], ['d', true, true], ['y', true, true], ['Z', false, true], ['e', true, false], ['x', false, true],
    ['a', false, true], ['c', false, true],
  ], 'Bee, Dee (d, then y: folders break the tie), Ghost Z, Gone, x (no name: its id), しー = シー (a, then c)');
  const by = Object.fromEntries(r.ghosts.map(g => [g.id, g]));
  assert.deepEqual(by.d.balloons, [{ id: 'bb', name: 'Bee Balloon' }]);
  assert.equal(by.d.needs, null);
  assert.equal(by.b.needs, 'AYA');
  assert.equal(by.a.name, 'しー');
  assert.equal(by.x.name, 'x');
  fs.rmSync(gj);
  const none = (await h.req('POST', '/api/ghosts', { body: {} })).json;
  assert.deepEqual(none.problems.map(p => p.code), ['no-index']);
  assert.deepEqual(none.ghosts.map(g => g.id), ['b', 'd', 'y', 'Z', 'x', 'a', 'c'], 'no index: the folders, in the same order');
});

test('inspect and add: tokens stand for inspected ghosts; a plan names known tokens', async t => {
  const h = harness(t);
  await withSite(h);
  assert.equal((await h.req('POST', '/api/inspect', { body: { sources: [] } })).status, 400);
  assert.equal((await h.req('POST', '/api/inspect', { body: { sources: [{ path: 'relative' }] } })).json.error.code, 'path-not-absolute');
  const ins = await h.job('/api/inspect', { sources: [{ path: FIXTURE }, { path: path.join(h.dir, 'missing') }, { path: h.dir }] });
  const [item, missing, empty] = ins.result.items;
  assert.equal(item.id, 'testghost');
  assert.match(item.token, /^[0-9a-f]{16}$/);
  assert.deepEqual([missing.token, missing.refusal.code], [null, 'source.missing']);
  assert.deepEqual([empty.token, empty.refusal.code], [null, 'source.notGhost']);
  for (const plan of [[], [{ token: 'nope' }], [{ token: item.token, keep: 'x' }], 'x']) {
    const r = await h.req('POST', '/api/add', { body: { plan } });
    assert.equal(r.status, 400, JSON.stringify(plan));
  }
  assert.equal((await h.req('POST', '/api/add', { body: { plan: [{ token: 'nope' }] } })).json.error.code, 'token-unknown');
  const add = await h.job('/api/add', { plan: [{ token: item.token }] });
  assert.equal(add.state, 'done', JSON.stringify(add.error));
  assert.deepEqual(add.result.items.map(i => [i.id, i.ok]), [['testghost', true]]);
  assert.ok(add.result.index && add.result.indexRefusal === null);
  const twice = await h.job('/api/add', { plan: [{ token: item.token }] });
  assert.deepEqual([twice.result.items[0].ok, twice.result.items[0].refusal.code], [false, 'site.exists']);
  assert.equal(twice.result.index, null, 'no index run when nothing was added');
  const replaced = await h.job('/api/add', { plan: [{ token: item.token, replace: true }] });
  assert.equal(replaced.result.items[0].ok, true);
  const rm = await h.job('/api/remove', { id: 'testghost' });
  assert.deepEqual([rm.state, rm.result.deleteOnHost, rm.result.link], ['done', 'ghost/testghost/', false]);
  const again = await h.job('/api/remove', { id: 'testghost' });
  assert.deepEqual([again.state, again.error.code], ['failed', 'ghost.missing']);
});

test('the job worker: a real job in a worker thread; a worker that dies is a failed job', async t => {
  const d = scratch(t);
  const site = makeSite(path.join(d, 'site'));
  await core.indexSite(site);
  const runner = workerRunner();
  const progress = [];
  const result = await runner('check', { site }, p => progress.push(p.phase));
  assert.deepEqual(result, { ok: true, problems: [] });
  assert.ok(progress.includes('index') && progress.includes('check'), progress.join());
  await assert.rejects(runner('nothing', {}, () => {}), e => e.code === 'job-failed' && /no such job/.test(e.params.error));
  const boom = path.join(d, 'boom.mjs');
  fs.writeFileSync(boom, 'throw new Error("boom");\n');
  await assert.rejects(workerRunner(pathToFileURL(boom))('check', {}, () => {}), e => e.code === 'job-crashed');
  const quiet = path.join(d, 'quiet.mjs');
  fs.writeFileSync(quiet, '// ends without an answer\n');
  // the page gets the exit code in plain words (no "worker": CLAUDE.md "Wording"), the log the technical line
  await assert.rejects(workerRunner(pathToFileURL(quiet))('check', {}, () => {}), e => e.code === 'job-crashed'
    && Number.isInteger(e.params.exit) && !('error' in e.params) && !/worker/i.test(e.message) && /worker exited/.test(e.detail));
  const log = errorLog(makeRoot(path.join(d, 'temp')));
  const jobs = new Jobs({ runner: workerRunner(pathToFileURL(quiet)), log });
  jobs.start('check', {}, { label: '' });
  await jobs.done;
  const shown = jobs.snapshot().error;
  assert.deepEqual(Object.keys(shown).sort(), ['code', 'message', 'params'], 'no detail or stack in the API');
  const { findingText } = await import('../../admin/page/strings.js');
  for (const L of ['en', 'ja']) assert.doesNotMatch(findingText(shown, L), /worker|ワーカー/i);
  assert.match(findingText(shown, 'en'), /unexpected error \(code -?\d+\)/);
  assert.match(fs.readFileSync(log.file, 'utf8'), /job check ended job-crashed: .* \[the job's worker exited \(-?\d+\) without an answer\]/);
});

test('the zip writer: Unix modes, UTF-8 names, deflated or stored, the same bytes for the same input', () => {
  const big = Buffer.from('sumika '.repeat(5000));
  const rnd = crypto.randomBytes(300);
  const entries = [
    { name: 'sumika-admin-linux-x64', data: big, mode: 0o755 }, { name: 'dir/' }, { name: 'dir/ゴースト.txt', data: 'ゴ' },
    { name: 'random.bin', data: rnd },
  ];
  const a = zip(entries, { date: new Date(2026, 9, 17, 12, 30, 10) });
  assert.ok(a.equals(zip(entries, { date: new Date(2026, 9, 17, 12, 30, 10) })), 'the same bytes again');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-zip-'));
  try {
    fs.writeFileSync(path.join(d, 'a.zip'), a);
    const z = openZip(path.join(d, 'a.zip'));
    const by = Object.fromEntries(z.all.map(r => [r.name, r]));
    assert.deepEqual(z.all.map(r => r.name), ['sumika-admin-linux-x64', 'dir/', 'dir/ゴースト.txt', 'random.bin']);
    const exe = by['sumika-admin-linux-x64'];
    assert.equal(exe.madeBy >> 8, 3, 'made by Unix');
    assert.equal(exe.attrs >>> 16, 0o100755, 'an executable regular file');
    assert.equal(exe.method, 8);
    assert.ok(exe.readChecked().equals(big));
    assert.equal(by['dir/'].attrs >>> 16, 0o040755);
    assert.equal(by['dir/ゴースト.txt'].flags & 0x800, 0x800, 'the UTF-8 flag');
    assert.equal(by['dir/ゴースト.txt'].attrs >>> 16, 0o100644);
    assert.equal(by['random.bin'].method, 0, 'stored when deflate would not shrink it');
    assert.ok(by['random.bin'].readChecked().equals(rnd));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('the page build: script and style inlined whole, the CSP hashes their exact text; the program\'s permissions', async t => {
  const d = scratch(t);
  put(d, 'index.html', '<!doctype html>\r\n<html><head><style>/*@@SUMIKA_ADMIN_STYLE@@*/</style></head>\r\n<body><p>x</p><script>/*@@SUMIKA_ADMIN_SCRIPT@@*/</script></body></html>\r\n');
  put(d, 'main.js', 'import { say } from \'./lib.js\';\ndocument.body.append(say(\'</script>\'));\n');
  put(d, 'lib.js', 'export const say = s => `<b>${s}</b>`;\n');
  put(d, 'style.css', 'body {\r\n  color: #123;\r\n}\r\n');
  const { html, csp } = await buildPage({ dir: d, write: false });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.ok(!/<\/script/i.test(script), 'a "</script" inside the bundle is escaped');
  assert.match(script, /<\\\/script>/);
  assert.ok(!/\r/.test(html), 'LF only, as the HTML parser hashes it');
  const sha = s => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
  assert.ok(csp.includes(`script-src ${sha(script)};`), csp);
  assert.ok(csp.includes(`style-src ${sha(style)};`), csp);
  assert.match(csp, /^default-src 'none'; .*connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  put(d, 'index.html', '<style>/*@@SUMIKA_ADMIN_STYLE@@*/</style>');
  await assert.rejects(buildPage({ dir: d, write: false }), /no script marker/);
  assert.deepEqual(ENV_ALLOWED, ENV_NAMES, 'the env the program reads is the env it may read');
  const RUN = { 'windows-x64': 'rundll32.exe', 'macos-arm64': 'open,osascript', 'macos-x64': 'open,osascript', 'linux-x64': 'xdg-open,zenity,kdialog' };
  for (const [t2, o] of Object.entries(TARGETS)) {
    const p = permissions(t2);
    assert.deepEqual(p.filter(x => x.startsWith('--allow-run')), [`--allow-run=${RUN[t2]}`], `${t2}: the browser opener and the file dialogs only`);
    assert.equal(o.run, RUN[t2]);
    assert.deepEqual(p.filter(x => x.startsWith('--allow-ffi')), t2 === 'windows-x64' ? ['--allow-ffi'] : [], `${t2}: FFI for the Windows file dialog only`);
    assert.ok(p.includes('--allow-net=127.0.0.1') && !p.some(x => x === '--allow-net' || x.startsWith('--allow-sys') || x === '--allow-all'), t2);
    // a permission the flags lack throws: Deno never asks in the console window, where the program would wait
    assert.ok(p.includes('--no-prompt'), `${t2}: --no-prompt`);
  }
});

test('every code the program sends is in its CODE_LIST (admin/server/codes.mjs: the page translates by code)', () => {
  const dir = path.join(ROOT, 'admin', 'server');
  const used = new Set();
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.mjs') && n !== 'drive.mjs')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\b(?:ApiError\(\d+, |JobError\(|finding\()'([a-z0-9.-]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 30, `${used.size} codes found`);
  const missing = [...used].filter(c => !CODE_LIST.includes(c));
  assert.deepEqual(missing, []);
  for (const c of ENTRY_CODES) assert.ok(CODE_LIST.includes(c), c);
});

// ---------------------------------------------------------------- the freeze, the journal's steps, the log

test('the job worker gets an empty environment (Deno lists every variable for the default one: a console prompt)', async t => {
  const d = scratch(t);
  const probe = path.join(d, 'env.mjs');
  fs.writeFileSync(probe, 'import { parentPort, workerData } from \'node:worker_threads\';\n'
    + 'parentPort.postMessage({ type: \'done\', result: { keys: Object.keys(process.env).length, journal: workerData.journal } });\n');
  process.env.SUMIKA_ADMIN_TEST_ENV = 'x';
  t.after(() => { delete process.env.SUMIKA_ADMIN_TEST_ENV; });
  const r = await workerRunner(pathToFileURL(probe))('check', {}, () => {}, { journal: 'j.json' });
  assert.deepEqual(r, { keys: 0, journal: 'j.json' });
});

test('the journal: the job writes its steps; a clear Windows refuses for a moment is retried, then marked ended', async t => {
  const root = makeRoot(path.join(scratch(t), 'temp'));
  const j = journal(root);
  j.write({ id: 'a1', kind: 'add', label: 'ピット, B', startedAt: 7, site: 'C:\\site', ghosts: [{ id: 'pit', name: 'ピット' }, { id: 'b', name: 'B' }], step: null, placed: [] });
  const step = journalSteps(j.file);
  step('copy', 'pit');
  step('swap', 'pit');
  step('placed', 'pit');
  step('copy', 'b');
  const taken = JSON.parse(fs.readFileSync(j.file, 'utf8'));
  assert.deepEqual([taken.id, taken.step, taken.ghost, taken.placed], ['a1', 'copy', 'b', ['pit']], 'the job\'s own id stays');
  assert.deepEqual(takeJournal(root), {
    kind: 'add', label: 'ピット, B', startedAt: 7, placed: ['pit'], ghosts: [{ id: 'pit', name: 'ピット' }, { id: 'b', name: 'B' }],
    site: 'C:\\site', step: 'copy', ghost: 'b',
  });
  // a virus scanner holds the new file: unlink refused, tried again, then the file is marked ended in place
  let tries = 0;
  const busy = journal(root, { clearMs: [1, 1], unlink: () => { tries++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } });
  busy.write({ id: 'b2', kind: 'index', label: '', startedAt: 8, step: null, placed: [] });
  await busy.clear('b2');
  assert.equal(tries, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(busy.file, 'utf8')), { id: 'b2', ended: true });
  assert.equal(takeJournal(root), null, 'an ended job is no cut-off job');
  assert.ok(!fs.existsSync(busy.file));
  // a clear for an older job leaves a newer job's journal alone
  j.write({ id: 'new', kind: 'check', label: '', startedAt: 9, step: null, placed: [] });
  await j.clear('old');
  assert.equal(takeJournal(root).kind, 'check');
  // cut off mid-write: there, but no JSON
  fs.writeFileSync(j.file, '{"id": "c3", "ki');
  assert.deepEqual(takeJournal(root), { kind: null, label: '', startedAt: null, placed: [], ghosts: [] });
  // read but kept (a start settling the work folder), deleted after
  j.write({ id: 'k4', kind: 'index', label: '', startedAt: 10, step: 'index', placed: [] });
  assert.equal(takeJournal(root, { keep: true }).kind, 'index');
  assert.equal(takeJournal(root, { keep: true }).kind, 'index', 'still there');
  dropJournal(root);
  assert.equal(takeJournal(root), null);
});

test('the journal: a write that gives up goes to the log (the next start could say less of a cut-off job)', async t => {
  const root = makeRoot(path.join(scratch(t), 'temp'));
  const log = errorLog(root);
  // a folder where the journal goes: neither the rename nor the write in place puts a file there
  fs.mkdirSync(path.join(root, 'job.json'));
  journal(root, { log }).write({ id: 'a1', kind: 'index', label: '', startedAt: 1, step: null, placed: [] });
  assert.match(fs.readFileSync(log.file, 'utf8'), /^\S+ the journal \S+job\.json could not be written\n {4}\{"id":"a1"/);
  fs.rmdirSync(path.join(root, 'job.json'));
  journal(root, { log }).write({ id: 'b2', kind: 'index', label: '', startedAt: 2, step: null, placed: [] });
  assert.equal((fs.readFileSync(log.file, 'utf8').match(/could not be written/g) || []).length, 1, 'a write that works: nothing logged');
});

test('the journal: a step the job worker cannot write goes to the log beside the journal', {
  skip: process.platform !== 'win32' && 'a read-only file stops a rename over it on Windows only',
}, async t => {
  const root = makeRoot(path.join(scratch(t), 'temp'));
  const j = journal(root);
  j.write({ id: 'a1', kind: 'add', label: 'pit', startedAt: 1, site: 'C:\\site', ghosts: [{ id: 'pit', name: 'pit' }], step: null, placed: [] });
  fs.chmodSync(j.file, 0o444);
  t.after(() => { try { fs.chmodSync(j.file, 0o666); } catch (e) { /* gone */ } });
  journalSteps(j.file)('copy', 'pit');
  assert.equal(JSON.parse(fs.readFileSync(j.file, 'utf8')).step, null, 'the step could not be written');
  assert.match(fs.readFileSync(path.join(root, 'sumika-admin.log'), 'utf8'), /the journal \S+job\.json could not be written\n {4}\{"id":"a1".*"step":"copy"/);
});

test('Jobs.hold: a job asked for while the start settles waits in phase settle and writes its journal as it begins', async t => {
  const root = makeRoot(path.join(scratch(t), 'temp'));
  const ran = [];
  const runner = async kind => { ran.push(kind); return {}; };
  const jobs = new Jobs({ runner, journal: journal(root) });
  let release;
  jobs.hold(new Promise(r => { release = r; }));
  const j = jobs.start('check', {}, { label: '' });
  assert.deepEqual([j.state, j.phase], ['running', 'settle']);
  assert.throws(() => jobs.start('index', {}), e => e.code === 'busy', 'one at a time, a waiting one too');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(ran, []);
  assert.ok(!fs.existsSync(path.join(root, 'job.json')), 'no journal before it begins: the earlier start\'s is the only one');
  release();
  await jobs.done;
  assert.deepEqual([ran, jobs.snapshot().state, jobs.snapshot().phase], [['check'], 'done', null]);
  jobs.start('index', {}, { label: '' });
  assert.ok(fs.existsSync(path.join(root, 'job.json')), 'held no more: the journal at the start, as before');
  await jobs.done;
  // the program closes while one waits: it never begins, no journal, no crash in the log
  const log = errorLog(root);
  const k = new Jobs({ runner, journal: journal(root), log });
  let go;
  k.hold(new Promise(r => { go = r; }));
  k.start('add', {}, { label: 'pit' });
  k.close();
  go();
  await k.done;
  assert.deepEqual([ran, k.snapshot().state], [['check', 'index'], 'failed']);
  assert.ok(!fs.existsSync(path.join(root, 'job.json')) && !fs.existsSync(log.file));
});

test('a start serves first, then settles the work folder in the job worker: instance.json at once, hello says starting, a job waits', { timeout: 90000 }, async t => {
  const d = scratch(t);
  const site = makeSite(path.join(d, 'site'));
  await core.indexSite(site);
  const temp = makeRoot(path.join(d, 'temp'));
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ format: 1, site, recent: [] }));
  // what an earlier start left: a cut-off index run's journal, and a staging copy of a cut-off add
  fs.writeFileSync(path.join(temp, 'job.json'), JSON.stringify({ id: 'a1', kind: 'index', label: '', startedAt: 1, site, step: 'index', ghost: null, placed: [] }));
  put(site, '.sumika-admin-work/new-0a0b0c-emily4/ghost/master/descript.txt', 'name,Emily\r\n');
  let release;
  const gate = new Promise(r => { release = r; });
  const asked = [];
  const r = await start(['--no-browser', '--settings', path.join(d, 'settings.json'), '--temp', temp], {
    page: PAGE, out: () => {}, exit: () => {}, signals: false,
    recover: async (s, runner) => { asked.push(s); await gate; return settleSite(s, runner); },
  });
  t.after(() => r.stop());
  assert.equal(readInstance(temp).port, r.port, 'instance.json first: a second start finds this one');
  const api = client(r.port, r.key);
  let hello = (await api.call('GET', '/api/hello')).body;
  assert.deepEqual([hello.starting, hello.interrupted, hello.site && hello.site.path], [true, null, fs.realpathSync.native(site)]);
  assert.equal((await api.call('GET', '/api/status')).body.starting, true);
  const job = await api.post('/api/check');
  assert.deepEqual([job.status, job.body.state, job.body.phase], [200, 'running', 'settle'], job.text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'job.json'), 'utf8')).id, 'a1', 'the earlier start\'s journal stays until settled');
  assert.ok(fs.existsSync(path.join(site, '.sumika-admin-work')));
  release();
  await r.settled;
  assert.deepEqual(asked, [site]);
  hello = (await api.call('GET', '/api/hello')).body;
  assert.equal(hello.starting, false);
  assert.equal(hello.interrupted && hello.interrupted.outcome, 'index', 'a Check does not finish a cut-off index run');
  assert.ok(!fs.existsSync(path.join(site, '.sumika-admin-work')), 'settled (in the job worker)');
  const done = await api.waitJob(job.body.id);
  assert.equal(done.state, 'done', JSON.stringify(done.error));
  assert.ok(!fs.existsSync(path.join(temp, 'job.json')), 'the old journal deleted, the Check\'s cleared');
  assert.match(fs.readFileSync(path.join(temp, 'sumika-admin.log'), 'utf8'), /new-0a0b0c-emily4: deleted[\s\S]*outcome index/);
});

test('a start closed while it settles settles no further site: the journal stays for the next start as it was found', { timeout: 90000 }, async t => {
  const d = scratch(t);
  const a = makeSite(path.join(d, 'a')), b = makeSite(path.join(d, 'b'));
  const temp = makeRoot(path.join(d, 'temp'));
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ format: 1, site: b, recent: [] }));
  // a replace of pit in site a cut off between its renames; site b is the one chosen now
  fs.writeFileSync(path.join(temp, 'job.json'), JSON.stringify({
    id: 'a1', kind: 'add', label: 'pit', startedAt: 1, site: a, ghosts: [{ id: 'pit', name: 'pit' }], step: 'swap', ghost: 'pit', placed: [],
  }));
  let release;
  const gate = new Promise(r => { release = r; });
  const asked = [];
  const r = await start(['--no-browser', '--settings', path.join(d, 'settings.json'), '--temp', temp], {
    page: PAGE, out: () => {}, exit: () => {}, signals: false,
    recover: async s => { asked.push(s); if (asked.length === 1) await gate; return { entries: [] }; },
  });
  for (let i = 0; i < 200 && !asked.length; i++) await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(asked, [a], 'the journal\'s site first');
  const stopped = r.stop();
  release();
  await r.settled;
  await stopped;
  assert.deepEqual(asked, [a], 'closed: the chosen site is not settled in the exit\'s last moments');
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'job.json'), 'utf8')).id, 'a1', 'the journal stays for the next start');
});

test('the next start: the work folder settled, and what the cut-off job did as one outcome', async t => {
  const d = scratch(t);
  const site = makeSite(path.join(d, 'site'));
  const put2 = rel => put(site, rel, 'name,x\r\n');
  const at = (o, step = {}) => ({ kind: 'add', label: '', startedAt: 1, placed: [], ghosts: [], site, ...o, ...step });
  const settle = async j => settleStart({ journal: j, recover: core.recoverWork });
  const g = (id, name = id) => ({ id, name });
  // cut off in the copy: the staging copy goes, nothing changed
  put2('.sumika-admin-work/new-aaaaaa-pit/ghost/master/descript.txt');
  let it = await settle(at({ ghosts: [g('pit', 'ピット')], step: 'copy', ghost: 'pit' }));
  assert.deepEqual(it, { kind: 'add', label: '', startedAt: 1, step: 'copy', outcome: 'unchanged', ghosts: [{ id: 'pit', name: 'ピット', placed: false }] });
  assert.ok(!fs.existsSync(path.join(site, '.sumika-admin-work')));
  // cut off between the renames of a replace: the old folder goes back, nothing changed
  put2('.sumika-admin-work/old-bbbbbb-pit/ghost/master/descript.txt');
  put2('.sumika-admin-work/new-cccccc-pit/ghost/master/descript.txt');
  it = await settle(at({ ghosts: [g('pit')], step: 'swap', ghost: 'pit' }));
  assert.equal(it.outcome, 'unchanged');
  assert.ok(fs.existsSync(path.join(site, 'ghost', 'pit', 'ghost', 'master', 'descript.txt')), 'the old ghost is back');
  // cut off after the new folder went in (its old one still aside): placed, the index not rewritten
  put2('.sumika-admin-work/old-dddddd-pit/ghost/master/descript.txt');
  it = await settle(at({ ghosts: [g('pit'), g('b')], step: 'swap', ghost: 'pit' }));
  assert.deepEqual([it.outcome, it.ghosts.map(x => x.placed)], ['index', [true, false]]);
  // the second ghost's copy, the first one placed before
  it = await settle(at({ ghosts: [g('pit'), g('b')], step: 'copy', ghost: 'b', placed: ['pit'] }));
  assert.deepEqual([it.outcome, it.ghosts.map(x => x.placed)], ['index', [true, false]]);
  // a removal: before its rename nothing changed; after it the folder is gone
  it = await settle(at({ kind: 'remove', ghosts: [g('pit')], step: 'swap', ghost: 'pit' }));
  assert.equal(it.outcome, 'unchanged', 'ghost/pit is still there');
  fs.renameSync(path.join(site, 'ghost', 'pit'), path.join(path.dirname(site), 'gone'));
  it = await settle(at({ kind: 'remove', ghosts: [g('pit')], step: 'swap', ghost: 'pit' }));
  assert.equal(it.outcome, 'index');
  // the kinds, an older start's journal, a site not there now
  for (const [kind, outcome] of [['inspect', 'unchanged'], ['check', 'unchanged'], ['index', 'index'], ['prepare', 'prepare'], [null, 'unknown']]) {
    assert.equal((await settle(at({ kind }))).outcome, outcome, String(kind));
  }
  assert.equal((await settle({ kind: 'add', label: 'Emily', startedAt: 1, placed: [], ghosts: [] })).outcome, 'unknown', 'no step');
  assert.equal((await settle(at({ site: path.join(d, 'nowhere'), step: 'copy', ghost: 'x' }))).outcome, 'unknown');
  assert.equal(await settle(null), null);
  // a dev run never settles the project's own site/
  let asked = 0;
  await settleStart({ journal: null, site: path.join(ROOT, 'site'), forbidden: [path.join(ROOT, 'site')], recover: async () => { asked++; return { entries: [] }; } });
  assert.equal(asked, 0);
});

test('hello\'s interrupted goes when a job settles it: any job for unchanged, an index run for index', async t => {
  const make = interrupted => {
    const dir = scratch(t);
    const st = loadSettings({ file: path.join(dir, 'settings.json'), where: 'given' });
    const jobs = new Jobs({ runner: async () => ({ index: {} }) });
    const app = createApp({
      port: PORT, key: KEY, page: PAGE, st, jobs, drops: new Drops(dir), xDir: dir, serve: async () => { throw new Error('no'); },
      env: {}, interrupted,
    });
    const req = async (method, p, body) => {
      const init = { method, headers: { 'X-Sumika-Admin-Key': KEY } };
      if (body) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
      const r = await app.handle(new Request(`http://127.0.0.1:${PORT}${p}`, init), { host: `127.0.0.1:${PORT}` });
      return r.json();
    };
    return { req, jobs };
  };
  const a = make({ kind: 'inspect', label: 'pit', startedAt: 1, step: null, outcome: 'unchanged', ghosts: [] });
  assert.equal((await a.req('GET', '/api/hello')).interrupted.outcome, 'unchanged');
  await a.req('POST', '/api/inspect', { sources: [{ path: FIXTURE }] });
  assert.equal((await a.req('GET', '/api/hello')).interrupted, null, 'any job');
  const b = make({ kind: 'add', label: 'pit', startedAt: 1, step: 'index', outcome: 'index', ghosts: [{ id: 'pit', name: 'pit', placed: true }] });
  await b.req('POST', '/api/inspect', { sources: [{ path: FIXTURE }] });
  await b.jobs.done;
  assert.equal((await b.req('GET', '/api/hello')).interrupted.outcome, 'index', 'an inspect does not finish an add');
});

test('the log: errors nothing caught and failed jobs with their stack, the console never; kept under its size', async t => {
  const root = makeRoot(path.join(scratch(t), 'temp'));
  const log = errorLog(root, { now: () => new Date(Date.UTC(2026, 9, 17, 1, 2, 3)) });
  // under Node: process's events; in the compiled program: Deno's globalThis events, kept from ending it
  const proc = new (await import('node:events')).EventEmitter();
  catchStray(log, { deno: null, proc });
  proc.emit('uncaughtException', new Error('stray'));
  proc.emit('unhandledRejection', 'just a text');
  const target = new EventTarget();
  catchStray(log, { deno: {}, target });
  const ev = new Event('unhandledrejection', { cancelable: true });
  ev.reason = new Error('rejected');
  target.dispatchEvent(ev);
  assert.ok(ev.defaultPrevented, 'the program keeps serving');
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /^2026-10-17T01:02:03\.000Z an error nothing caught\n {4}Error: stray\n {8}at /);
  assert.match(text, /a rejection nothing handled\n {4}just a text\n/);
  assert.match(text, /a rejection nothing handled\n {4}Error: rejected\n/);
  const small = errorLog(root, { maxBytes: text.length - 1 });
  small.write('one more', 'x'.repeat(10));
  assert.equal(fs.readFileSync(`${log.file}.old`, 'utf8'), text, 'past its size the log moves to .old');
  assert.match(fs.readFileSync(log.file, 'utf8'), /^\S+ one more\n {4}x{10}\n$/);
  // a job that fails: its stack in the log, never in the API's answer
  const jobs = new Jobs({ runner: async () => { throw new TypeError('x is not a function'); }, log });
  jobs.start('index', {}, { label: '' });
  await jobs.done;
  assert.equal(jobs.snapshot().error.code, 'job-crashed');
  assert.ok(!('stack' in jobs.snapshot().error));
  const w = new Jobs({ runner: async () => { throw { code: 'job-failed', params: { error: 'EIO' }, message: 'the job failed: EIO', stack: 'Error: EIO\n    at copy (x.mjs:1:1)' }; }, log });
  w.start('add', {}, { label: 'pit' });
  await w.done;
  assert.deepEqual(w.snapshot().error, { code: 'job-failed', params: { error: 'EIO' }, message: 'the job failed: EIO' });
  const last = fs.readFileSync(log.file, 'utf8');
  assert.match(last, /job add \(pit\) ended job-failed: the job failed: EIO\n {4}Error: EIO\n {8}at copy \(x\.mjs:1:1\)/);
});

test('the log, further: a job the closing program stops is no crash; a route that fails is logged with its stack', async t => {
  const d = scratch(t);
  const root = makeRoot(path.join(d, 'temp'));
  const log = errorLog(root);
  // Ctrl+C mid-job stops the worker: the journal stays for the next start, which logs the cut-off job; no crash here
  const slow = put(d, 'slow.mjs', 'setInterval(() => {}, 1000);\n');
  const jobs = new Jobs({ runner: workerRunner(pathToFileURL(slow)), journal: journal(root), log });
  jobs.start('add', {}, { label: 'pit' });
  await new Promise(r => setTimeout(r, 200));
  jobs.close();
  await jobs.done;
  assert.equal(jobs.snapshot().state, 'failed');
  assert.ok(!fs.existsSync(log.file), fs.existsSync(log.file) ? fs.readFileSync(log.file, 'utf8') : '');
  assert.equal(takeJournal(root).label, 'pit');
  // a route that throws what is no refusal answers 500 internal; the stack goes to the log, never into the answer
  const st = loadSettings({ file: path.join(d, 'settings.json'), where: 'given' });
  const broken = new Jobs({ runner: async () => ({}) });
  broken.snapshot = () => { throw new TypeError('x is not a function'); };
  const app = createApp({
    port: PORT, key: KEY, page: PAGE, st, jobs: broken, drops: new Drops(d), xDir: d, env: {}, log,
    serve: async () => { throw new Error('no sockets in this test'); },
  });
  const call = (method, p) => app.handle(new Request(`http://127.0.0.1:${PORT}${p}`, {
    method, headers: { 'X-Sumika-Admin-Key': KEY, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}),
  }), { host: `127.0.0.1:${PORT}` });
  const r = await call('GET', '/api/status');
  assert.equal(r.status, 500);
  const body = await r.text();
  assert.equal(JSON.parse(body).error.code, 'internal');
  assert.ok(!/\bat /.test(body), body);
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /^\S+ GET \/api\/status answered 500 internal\n {4}TypeError: x is not a function\n {8}at /);
  // a refusal is an answer: nothing logged
  assert.equal((await call('POST', '/api/ghosts')).status, 409);
  assert.equal(fs.readFileSync(log.file, 'utf8'), text);
});

test('the job worker writes the journal\'s steps itself: a real add of one ghost, then the index', async t => {
  const d = scratch(t);
  const site = makeSite(path.join(d, 'site'));
  await core.indexSite(site);
  const j = journal(makeRoot(path.join(d, 'temp')));
  j.write({ id: 'w1', kind: 'add', label: 'Test Ghost', startedAt: 1, site, ghosts: [{ id: 'testghost', name: 'Test Ghost' }], step: null, placed: [] });
  const items = [{ token: 't', source: { kind: 'folder', path: FIXTURE }, id: 'testghost', name: 'Test Ghost' }];
  const r = await workerRunner()('add', { site, tempDir: d, items }, () => {}, { journal: j.file });
  assert.ok(r.items[0].ok && r.index, JSON.stringify(r.items[0]));
  const steps = JSON.parse(fs.readFileSync(j.file, 'utf8'));
  assert.deepEqual([steps.id, steps.step, steps.ghost, steps.placed], ['w1', 'index', null, ['testghost']]);
});

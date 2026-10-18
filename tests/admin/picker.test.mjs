// The file dialogs (CLAUDE.md "The admin tool"; CONTRACTS "Admin API" /api/pick), with no dialog on screen: the
// endpoint on a fake picker (one at a time, cancel, no-picker, the held answer and /api/pick/wait, where each purpose
// starts, the page's language in the titles), --fake-picker's file, the Windows picker's worker protocol on a stand-in
// Worker, the macOS and Linux programs' arguments and answers on a stand-in runner, the Windows layouts (GUID bytes,
// options, where the owner goes), the settings' lastFolders, and a dev run with --fake-picker. The real dialog was
// driven by a harness on a real desktop (CLAUDE.md "The admin tool"), never here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../admin/server/app.mjs';
import { Jobs } from '../../admin/server/jobs.mjs';
import { Drops } from '../../admin/server/drops.mjs';
import { loadSettings, settingsText } from '../../admin/server/settings.mjs';
import { parseArgs } from '../../admin/server/main.mjs';
import { loadStrings } from '../../admin/server/say.mjs';
import {
  PURPOSES, FILTERS, PickerError, pickRequest, fakePicker, windowsPicker, macPicker, linuxPicker, appleScript,
} from '../../admin/server/picker.mjs';
import {
  guidBytes, wide, dialogOptions, ownerPlace, FOS, CLSID_FileOpenDialog, IID_IFileOpenDialog, IID_IShellItem, DLLS,
} from '../../admin/server/pickwin.mjs';
import { makeSite } from '../../admin/server/drive.mjs';
import * as core from '../../admin/core/api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4322;
const KEY = 'cd'.repeat(32);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function scratch(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-pick-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A picker the test answers by hand: each open() waits for answer() / fail(); requests are kept. */
function handPicker() {
  const p = {
    kind: 'hand', available: true, requests: [], pending: null, cancels: 0, closes: 0,
    open(req) {
      p.requests.push(req);
      return new Promise((resolve, reject) => { p.pending = { resolve, reject }; });
    },
    answer(v) {
      const x = p.pending;
      p.pending = null;
      x.resolve(v);
    },
    fail(message) {
      const x = p.pending;
      p.pending = null;
      p.available = false;
      x.reject(new PickerError(message));
    },
    cancel() {
      p.cancels++;
      if (p.pending) p.answer({ canceled: true });
      return true;
    },
    close() {
      p.closes++;
      p.cancel();
    },
  };
  return p;
}

function harness(t, { picker = handPicker(), pickWaitMs = 2000, settings = null } = {}) {
  const dir = scratch(t);
  const run = path.join(dir, 'run');
  fs.mkdirSync(path.join(run, 'x'), { recursive: true });
  const file = path.join(dir, 'settings.json');
  if (settings) fs.writeFileSync(file, JSON.stringify(settings));
  const st = loadSettings({ file, where: 'given' });
  const jobs = new Jobs({ runner: async () => ({}) });
  const app = createApp({
    port: PORT, key: KEY, page: { html: '', csp: '' }, st, jobs, drops: new Drops(run), xDir: path.join(run, 'x'),
    serve: async () => { throw new Error('no sockets'); }, env: {}, picker, pickWaitMs,
  });
  const req = async (p, body = {}, method = 'POST') => {
    const init = { method, headers: { 'X-Sumika-Admin-Key': KEY } };
    if (method === 'POST') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await app.handle(new Request(`http://127.0.0.1:${PORT}${p}`, init), { host: `127.0.0.1:${PORT}` });
    return { status: res.status, json: await res.json() };
  };
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { dir, st, app, req, picker, saved, file };
}

/** Lets the handler's promise chain run. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

test('/api/pick: the dialog\'s paths; the folder it picked in is where this purpose starts next; titles in the page\'s language', async t => {
  await loadStrings();
  const h = harness(t);
  assert.equal((await h.req('/api/hello', null, 'GET')).json.picker, true);
  const a = path.join(h.dir, 'dl', 'a.nar'), b = path.join(h.dir, 'dl', 'b.zip');
  const first = h.req('/api/pick', { purpose: 'files', lang: 'ja' });
  await settle();
  const r0 = h.picker.requests[0];
  assert.deepEqual([r0.purpose, r0.start, r0.folders, r0.multi, r0.guid], ['files', null, false, true, PURPOSES.files.guid],
    'nothing picked yet: the dialog\'s own memory');
  assert.equal(r0.title, '追加する .nar / .zip ファイルを選ぶ');
  assert.deepEqual(r0.filters, [{ name: 'ゴーストのアーカイブ（*.nar, *.zip）', spec: '*.nar;*.zip', patterns: ['*.nar', '*.zip'] }]);
  h.picker.answer({ paths: [a, b, 'relative.nar', 7] });
  assert.deepEqual((await first).json, { paths: [a, b] }, 'only full paths');
  assert.deepEqual(h.saved().lastFolders, { files: path.dirname(a) });

  const second = h.req('/api/pick', { purpose: 'files', lang: 'en' });
  await settle();
  assert.equal(h.picker.requests[1].start, path.dirname(a), 'files start where files were last picked');
  assert.equal(h.picker.requests[1].title, 'Choose .nar / .zip files to add');
  h.picker.answer({ canceled: true });
  assert.deepEqual((await second).json, { canceled: true });

  const near = path.join(h.dir, 'ghosts');
  const third = h.req('/api/pick', { purpose: 'compare', lang: 'en', near });
  await settle();
  const r2 = h.picker.requests[2];
  assert.deepEqual([r2.start, r2.folders, r2.multi], [near, false, false], 'no compare folder yet: the page\'s guess');
  assert.equal(r2.filters[0].spec, '*.nar;*.zip;updates2.dau;updates.txt');
  h.picker.answer({ paths: [] });
  assert.deepEqual((await third).json, { canceled: true }, 'nothing chosen is a cancel');
  assert.deepEqual(h.saved().lastFolders, { files: path.dirname(a) }, 'a cancel remembers nothing');

  const folder = h.req('/api/pick', { purpose: 'folders', lang: 'ja', near: 'not/absolute' });
  await settle();
  assert.deepEqual([h.picker.requests[3].start, h.picker.requests[3].folders, h.picker.requests[3].multi], [null, true, true]);
  h.picker.answer({ paths: [path.join(near, 'emily4'), path.join(near, 'tsubasa')] });
  await folder;
  assert.deepEqual(h.saved().lastFolders, { files: path.dirname(a), folders: near });
  for (const p of Object.keys(PURPOSES)) assert.ok(!/^pick\./.test(pickRequest(p, 'ja').title) && !/^pick\./.test(pickRequest(p, 'en').title), p);
});

test('/api/pick: the site dialog starts beside the current site; a bad purpose is 400; none is 501 no-picker', async t => {
  const h = harness(t);
  const site = makeSite(path.join(h.dir, 'sites', 'one'));
  await core.indexSite(site);
  assert.equal((await h.req('/api/site', { path: site })).status, 200);
  const pick = h.req('/api/pick', { purpose: 'site', lang: 'en' });
  await settle();
  assert.equal(h.picker.requests[0].start, path.dirname(fs.realpathSync.native(site)), 'the folder that holds the site');
  assert.deepEqual([h.picker.requests[0].folders, h.picker.requests[0].multi, h.picker.requests[0].filters], [true, false, []]);
  h.picker.answer({ paths: [path.join(h.dir, 'sites', 'two')] });
  await pick;
  for (const purpose of [undefined, 'everything', 'toString', 7]) {
    const r = await h.req('/api/pick', { purpose, lang: 'en' });
    assert.deepEqual([r.status, r.json.error.code], [400, 'bad-request'], String(purpose));
  }
  const none = harness(t, { picker: null });
  assert.equal((await none.req('/api/hello', null, 'GET')).json.picker, false);
  const r = await none.req('/api/pick', { purpose: 'files', lang: 'en' });
  assert.deepEqual([r.status, r.json.error.code], [501, 'no-picker']);
  assert.deepEqual((await none.req('/api/pick/cancel')).json, { ok: true, open: false });
});

test('/api/pick: one dialog at a time (409 picker-open); cancel closes it; Quit\'s closePicker too', async t => {
  const h = harness(t);
  const pick = h.req('/api/pick', { purpose: 'folders', lang: 'en' });
  await settle();
  const again = await h.req('/api/pick', { purpose: 'files', lang: 'en' });
  assert.deepEqual([again.status, again.json.error.code, again.json.error.params.purpose], [409, 'picker-open', 'folders']);
  const { id } = again.json.error.params;
  assert.match(id, /^[0-9a-f]{12}$/, 'the open dialog\'s id: the tab that did not open it waits for it to close');
  const watch = h.req('/api/pick/wait', { id });
  assert.equal((await h.req('/api/status', null, 'GET')).status, 200, 'the program answers while a dialog is open');
  assert.deepEqual((await h.req('/api/pick/cancel')).json, { ok: true, open: true });
  assert.deepEqual((await pick).json, { canceled: true });
  assert.deepEqual((await watch).json, { canceled: true }, 'the watching tab learns it closed');
  assert.equal(h.picker.cancels, 1);
  assert.deepEqual((await h.req('/api/pick/cancel')).json, { ok: true, open: false }, 'nothing open: nothing to cancel');
  const next = h.req('/api/pick', { purpose: 'files', lang: 'en' });
  await settle();
  h.app.closePicker();
  assert.deepEqual((await next).json, { canceled: true });
  assert.equal(h.picker.closes, 1);
});

test('/api/pick: hello and status name the open dialog (a reloaded page waits on it at once); a fault after it never keeps it open', async t => {
  const h = harness(t);
  assert.equal((await h.req('/api/hello', null, 'GET')).json.pick, null);
  const pick = h.req('/api/pick', { purpose: 'folders', lang: 'en' });
  await settle();
  const { id } = (await h.req('/api/pick', { purpose: 'files', lang: 'en' })).json.error.params;
  assert.deepEqual((await h.req('/api/hello', null, 'GET')).json.pick, { id, purpose: 'folders' });
  assert.deepEqual((await h.req('/api/status', null, 'GET')).json.pick, { id, purpose: 'folders' });
  // remembering the folder fails after the dialog answered: the paths are the answer all the same
  Object.defineProperty(h.st.data, 'lastFolders', { get() { throw new Error('boom'); }, configurable: true });
  const p = path.join(h.dir, 'g1');
  h.picker.answer({ paths: [p] });
  assert.deepEqual((await pick).json, { paths: [p] });
  assert.equal((await h.req('/api/status', null, 'GET')).json.pick, null);
  delete h.st.data.lastFolders;
  // anything else that fails after the dialog: 500 internal, and the open mark goes all the same
  const bad = h.req('/api/pick', { purpose: 'files', lang: 'en' });
  await settle();
  h.picker.answer({ get paths() { throw new Error('a strange answer'); } });
  const r = await bad;
  assert.deepEqual([r.status, r.json.error.code], [500, 'internal']);
  const next = h.req('/api/pick', { purpose: 'site', lang: 'en' });
  await settle();
  assert.equal(h.picker.requests.length, 3, 'the next pick opens a dialog: no 409 picker-open for the rest of the run');
  h.picker.answer({ canceled: true });
  assert.deepEqual((await next).json, { canceled: true });
});

test('/api/pick: a dialog that cannot be shown is said in plain words ({exit}: a code), its technical line goes to the log', async t => {
  const dir = scratch(t);
  const run = path.join(dir, 'run');
  fs.mkdirSync(path.join(run, 'x'), { recursive: true });
  const lines = [];
  const picker = { kind: 'w', available: true, open: () => Promise.reject(Object.assign(new PickerError('the dialog\'s worker exited (1)'), { exit: 1 })), cancel: () => false, close() {} };
  const app = createApp({
    port: PORT, key: KEY, page: { html: '', csp: '' }, st: loadSettings({ file: path.join(dir, 's.json'), where: 'given' }),
    jobs: new Jobs({ runner: async () => ({}) }), drops: new Drops(run), xDir: path.join(run, 'x'), env: {}, picker,
    serve: async () => { throw new Error('no sockets'); }, log: { write: (what, detail) => lines.push([what, detail]) },
  });
  const res = await app.handle(new Request(`http://127.0.0.1:${PORT}/api/pick`, {
    method: 'POST', headers: { 'X-Sumika-Admin-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'files', lang: 'en' }),
  }), { host: `127.0.0.1:${PORT}` });
  const { error } = await res.json();
  assert.deepEqual([res.status, error.code, error.params], [501, 'no-picker', { exit: 1 }]);
  assert.doesNotMatch(error.message, /worker/);
  assert.equal(lines.length, 1);
  assert.match(lines[0][0], /files file window could not be shown/);
  assert.match(lines[0][1], /worker exited \(1\)/);
});

test('/api/pick: an answer is held at most pickWaitMs, then {open, id}; /api/pick/wait gets it later, until the next pick', async t => {
  const h = harness(t, { pickWaitMs: 30 });
  const r = await h.req('/api/pick', { purpose: 'files', lang: 'en' });
  assert.equal(r.json.open, true);
  assert.match(r.json.id, /^[0-9a-f]{12}$/);
  const w1 = await h.req('/api/pick/wait', { id: r.json.id });
  assert.deepEqual(w1.json, { open: true, id: r.json.id }, 'still open');
  const w2 = h.req('/api/pick/wait', { id: r.json.id });
  await settle();
  const p = path.join(h.dir, 'x.nar');
  h.picker.answer({ paths: [p] });
  assert.deepEqual((await w2).json, { paths: [p] });
  assert.deepEqual((await h.req('/api/pick/wait', { id: r.json.id })).json, { paths: [p] },
    'kept for every wait on it: the tab that opened it gets it after a tab that only watched it (picker-open) asked');
  // an answer that came while nobody waited: the next wait gets it
  const r2 = await h.req('/api/pick', { purpose: 'site', lang: 'en' });
  assert.deepEqual((await h.req('/api/pick/wait', { id: r.json.id })).json, { canceled: true }, 'the next pick: a dialog it no longer knows');
  h.picker.answer({ paths: [h.dir] });
  await settle();
  assert.deepEqual((await h.req('/api/pick/wait', { id: 'other' })).json, { canceled: true });
  assert.deepEqual((await h.req('/api/pick/wait', { id: r2.json.id })).json, { paths: [h.dir] });
  assert.deepEqual((await h.req('/api/pick/wait', {})).json, { canceled: true });
});

test('/api/pick: a dialog that cannot be shown answers 501 no-picker with why, and the picker is off from then on', async t => {
  const h = harness(t);
  const pick = h.req('/api/pick', { purpose: 'files', lang: 'en' });
  await settle();
  h.picker.fail('CoCreateInstance failed (0x80040154)');
  const r = await pick;
  assert.deepEqual([r.status, r.json.error.code, r.json.error.params.error], [501, 'no-picker', 'CoCreateInstance failed (0x80040154)']);
  assert.match(r.json.error.message, /could not open a file window/);
  assert.equal((await h.req('/api/hello', null, 'GET')).json.picker, false, 'the page falls back to its file browser');
  assert.equal((await h.req('/api/pick', { purpose: 'files', lang: 'en' })).status, 501);
});

test('/api/pick: lastFolders from the settings file; the site dialog with no site uses its own; bad entries dropped', async t => {
  const dl = path.join(os.tmpdir(), 'dl'), sites = path.join(os.tmpdir(), 'sites');
  const h = harness(t, { settings: { format: 1, site: null, recent: [], lastFolders: { compare: dl, site: sites, files: 'rel', x: 3 } } });
  assert.deepEqual(h.st.data.lastFolders, { compare: dl, site: sites }, 'full paths only');
  const pick = h.req('/api/pick', { purpose: 'compare', lang: 'en', near: path.join(os.tmpdir(), 'ghost') });
  await settle();
  assert.equal(h.picker.requests[0].start, dl, 'the folder last used beats the page\'s guess');
  h.picker.answer({ canceled: true });
  await pick;
  const site = h.req('/api/pick', { purpose: 'site', lang: 'en' });
  await settle();
  assert.equal(h.picker.requests[1].start, sites);
  h.picker.answer({ canceled: true });
  await site;
  assert.equal(settingsText({ format: 1, site: null, recent: [], lastFolders: {} }), '{\n "format": 1,\n "site": null,\n "recent": []\n}\n',
    'no lastFolders written before a dialog picked something');
  assert.match(settingsText({ format: 1, site: null, recent: [], language: 'ja', lastFolders: { files: dl }, z: 1 }),
    /"language": "ja",\n "lastFolders": \{\n {2}"files": [^\n]+\n \},\n "z": 1/);
});

test('--fake-picker FILE: lists, "canceled", "open" until cancelled, "no-picker", delayMs, a bad file', async t => {
  const dir = scratch(t);
  const file = path.join(dir, 'pick.json');
  const a = path.join(dir, 'a.nar');
  fs.writeFileSync(file, JSON.stringify({ files: [a, 'not-full'], folders: 'canceled', site: 'open', compare: 'no-picker' }));
  const f = fakePicker(file);
  assert.deepEqual(await f.open(pickRequest('files', 'en')), { paths: [a] });
  assert.deepEqual(await f.open(pickRequest('folders', 'en')), { canceled: true });
  const open = f.open(pickRequest('site', 'en'));
  await sleep(20);
  assert.equal(f.cancel(), true);
  assert.deepEqual(await open, { canceled: true });
  assert.equal(f.cancel(), false);
  fs.writeFileSync(file, JSON.stringify({ delayMs: 60, files: [a] }));
  const t0 = Date.now();
  assert.deepEqual(await f.open(pickRequest('files', 'en')), { paths: [a] });
  assert.ok(Date.now() - t0 >= 50, 'delayMs');
  assert.deepEqual(await f.open(pickRequest('compare', 'en')), { canceled: true }, 'a missing key: canceled');
  fs.writeFileSync(file, '{');
  await assert.rejects(f.open(pickRequest('files', 'en')), e => e instanceof PickerError && /fake picker's file/.test(e.message));
  assert.equal(f.available, true, 'a broken file is the developer\'s: fix it and pick again');
  fs.writeFileSync(file, JSON.stringify({ compare: 'no-picker' }));
  await assert.rejects(f.open(pickRequest('compare', 'en')), PickerError);
  assert.equal(f.available, false, 'no-picker: off, as a real picker after a failure');
  assert.deepEqual(f.requests.map(r => r.purpose), ['files', 'folders', 'site', 'files', 'compare', 'files', 'compare']);
  assert.deepEqual(parseArgs(['--fake-picker', file], { compiled: false }).fakePicker, file);
  assert.throws(() => parseArgs(['--fake-picker', file], { compiled: true }), /development runs/);
  assert.throws(() => parseArgs(['--fake-picker'], { compiled: false }), /unknown argument/);
});

/** A stand-in for node:worker_threads' Worker: records how it was made; the test speaks for the worker. */
class FakeWorker extends EventEmitter {
  static made = [];
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.terminated = 0;
    FakeWorker.made.push(this);
  }

  terminate() {
    this.terminated++;
    queueMicrotask(() => this.emit('exit', 1));             // as a real worker ends: its 'exit' follows
    return Promise.resolve(1);
  }
}

test('the Windows picker: a worker per dialog with env {}, its answers; cancel sets the flag and closes its windows', async () => {
  FakeWorker.made = [];
  const closed = [];
  const p = windowsPicker({ WorkerClass: FakeWorker, closeDialogs: thread => closed.push(thread), cancelMs: 300 });
  assert.equal(p.available, false, 'no Deno FFI under Node');
  p.available = true;                                          // as under Deno
  const req = pickRequest('files', 'en', 'C:\\dl');
  const one = p.open(req);
  const w = FakeWorker.made[0];
  assert.deepEqual(w.opts.env, {}, 'env: {} (a default worker asks for env permission: the compiled program has none)');
  assert.equal(w.opts.workerData.pick, req);
  assert.ok(w.opts.workerData.flag instanceof SharedArrayBuffer);
  assert.match(String(w.url), /pickwin\.mjs$/);
  w.emit('message', { type: 'owner', hwnd: '123', thread: 4242 });
  w.emit('message', { type: 'done', paths: ['C:\\dl\\a.nar', '', 5] });
  assert.deepEqual(await one, { paths: ['C:\\dl\\a.nar'] });
  await settle();
  assert.equal(w.terminated, 1, 'its worker ends with its answer');
  assert.equal(p.available, true, 'and its exit then is no failure');
  assert.equal(p.cancel(), false, 'nothing open');

  const two = p.open(req);
  const w2 = FakeWorker.made[1];
  assert.equal(p.cancel(), true);
  assert.equal(Atomics.load(new Int32Array(w2.opts.workerData.flag), 0), 1, 'cancelled before Show: the worker skips it');
  w2.emit('message', { type: 'owner', hwnd: '9', thread: 77 });
  await sleep(250);
  assert.ok(closed.length >= 1 && closed.every(x => x === 77), `WM_CLOSE to the dialog's thread, again and again (${closed.length})`);
  w2.emit('message', { type: 'canceled' });
  assert.deepEqual(await two, { canceled: true });
  await settle();
  assert.equal(p.available, true);

  // a dialog that never closes is given up after cancelMs; its late answer is ignored
  const three = p.open(req);
  const w3 = FakeWorker.made[2];
  w3.emit('message', { type: 'owner', hwnd: '10', thread: 78 });
  p.cancel();
  assert.deepEqual(await three, { canceled: true });
  w3.emit('message', { type: 'done', paths: ['C:\\late.nar'] });
  const four = p.open(req);
  assert.equal(FakeWorker.made.length, 4, 'the next dialog gets a worker of its own');
  FakeWorker.made[3].emit('message', { type: 'error', error: 'CoCreateInstance failed (0x80040154)' });
  await assert.rejects(four, e => e instanceof PickerError && /CoCreateInstance/.test(e.message));
  assert.equal(p.available, false, 'a failure turns the picker off');

  const q = windowsPicker({ WorkerClass: FakeWorker });
  const five = q.open(req);
  FakeWorker.made[4].emit('exit', 1);
  await assert.rejects(five, /worker exited \(1\)/);
  const r = windowsPicker({ WorkerClass: class { constructor() { throw new Error('no workers'); } } });
  await assert.rejects(r.open(req), /no workers/);
  assert.equal(r.available, false);
});

/** A runner standing in for Deno.Command: answers per program; 'missing' throws as an absent program does. */
function runner(answers) {
  const calls = [];
  const run = async (cmd, args, onChild) => {
    calls.push([cmd, args]);
    const a = answers[cmd];
    if (a === 'missing' || a === undefined) throw Object.assign(new Error(`${cmd}: not found`), { name: 'NotFound' });
    if (a === 'hang') {
      return new Promise(resolve => onChild({ kill: () => resolve({ code: 143, stdout: '', stderr: '' }) }));
    }
    return a;
  };
  return { run, calls };
}

test('the macOS picker: osascript with the title and the start folder as arguments; -128 is a cancel; an error turns it off', async () => {
  const lines = appleScript(pickRequest('files', 'en', '/Users/a/Downloads'));
  assert.ok(lines.includes('set picked to choose file with prompt (item 1 of argv) of type {"nar", "zip"} with multiple selections allowed'));
  assert.ok(lines.some(l => l.includes('default location (POSIX file (item 2 of argv))')));
  assert.ok(appleScript(pickRequest('compare', 'en')).some(l => l.includes('of type {"nar", "zip", "dau", "txt"}') && !l.includes('multiple')));
  assert.ok(appleScript(pickRequest('site', 'en')).every(l => !l.includes('of type')) && appleScript(pickRequest('site', 'en')).some(l => l.includes('choose folder')));
  const ok = runner({ osascript: { code: 0, stdout: '/Users/a/x.nar\n/Users/a/y.zip\n', stderr: '' } });
  const p = macPicker({ run: ok.run });
  assert.deepEqual(await p.open(pickRequest('files', 'ja', '/Users/a')), { paths: ['/Users/a/x.nar', '/Users/a/y.zip'] });
  const args = ok.calls[0][1];
  assert.deepEqual(args.slice(-2), ['追加する .nar / .zip ファイルを選ぶ', '/Users/a'], 'text as arguments, never inside the script');
  assert.ok(args.filter((x, i) => i % 2 === 0 && i < args.length - 2).every(x => x === '-e'));
  const dirs = macPicker({ run: runner({ osascript: { code: 0, stdout: '/Users/a/g1/\n/\n', stderr: '' } }).run });
  assert.deepEqual(await dirs.open(pickRequest('folders', 'en')), { paths: ['/Users/a/g1', '/'] }, 'a folder\'s trailing / goes');
  const cancel = macPicker({ run: runner({ osascript: { code: 1, stdout: '', stderr: '0:1: execution error: User canceled. (-128)\n' } }).run });
  assert.deepEqual(await cancel.open(pickRequest('site', 'en')), { canceled: true });
  assert.equal(cancel.available, true);
  const bad = macPicker({ run: runner({ osascript: { code: 1, stdout: '', stderr: 'execution error: Not authorized (-1743)' } }).run });
  await assert.rejects(bad.open(pickRequest('site', 'en')), e => e instanceof PickerError && /-1743/.test(e.message));
  assert.equal(bad.available, false);
  const hang = macPicker({ run: runner({ osascript: 'hang' }).run });
  const open = hang.open(pickRequest('files', 'en'));
  await settle();
  assert.equal(hang.cancel(), true, 'cancel kills it');
  assert.deepEqual(await open, { canceled: true });
});

test('the Linux picker: zenity\'s arguments, its exit 1 is a cancel; kdialog when zenity is absent; neither: no picker', async () => {
  const z = runner({ zenity: { code: 0, stdout: '/home/a/x.nar\n/home/a/Y.ZIP\n', stderr: '' } });
  const p = linuxPicker({ run: z.run });
  assert.deepEqual(await p.open(pickRequest('files', 'en', '/home/a')), { paths: ['/home/a/x.nar', '/home/a/Y.ZIP'] });
  assert.deepEqual(z.calls[0], ['zenity', ['--file-selection', '--title=Choose .nar / .zip files to add', '--multiple', '--separator=\n',
    '--filename=/home/a/', '--file-filter=Ghost archives (*.nar, *.zip) | *.nar *.NAR *.zip *.ZIP']]);
  const zd = runner({ zenity: { code: 0, stdout: '/home/a/site\n', stderr: '' } });
  await linuxPicker({ run: zd.run }).open(pickRequest('site', 'en'));
  assert.deepEqual(zd.calls[0][1], ['--file-selection', '--title=Choose the site folder (the one that holds the sumika folder)', '--directory']);
  const warn = linuxPicker({ run: runner({ zenity: { code: 1, stdout: '', stderr: 'Gtk-WARNING **: cannot open display' } }).run });
  assert.deepEqual(await warn.open(pickRequest('files', 'en')), { canceled: true }, 'zenity: 1 is Cancel, whatever GTK printed');
  const k = runner({ zenity: 'missing', kdialog: { code: 0, stdout: '/home/a/x.nar\n', stderr: '' } });
  assert.deepEqual(await linuxPicker({ run: k.run }).open(pickRequest('files', 'en', '/home/a')), { paths: ['/home/a/x.nar'] });
  assert.deepEqual(k.calls[1], ['kdialog', ['--title', 'Choose .nar / .zip files to add', '--getopenfilename', '/home/a/',
    'Ghost archives (*.nar, *.zip) (*.nar *.NAR *.zip *.ZIP)', '--multiple', '--separate-output']]);
  const kf = runner({ zenity: 'missing', kdialog: { code: 0, stdout: '/x\n', stderr: '' } });
  await linuxPicker({ run: kf.run }).open(pickRequest('folders', 'en'));
  assert.deepEqual(kf.calls[1][1], ['--title', 'Choose ghost folders, or folders of ghosts, to add', '--getexistingdirectory', '.']);
  const none = linuxPicker({ run: runner({}).run });
  await assert.rejects(none.open(pickRequest('files', 'en')), e => e instanceof PickerError && /no dialog program/.test(e.message));
  assert.equal(none.available, false);
});

test('the Linux picker: a cancel between zenity (not installed) and kdialog keeps kdialog from opening; one before a child kills it', async () => {
  let p, first = true;
  const calls = [];
  p = linuxPicker({
    run: async cmd => {
      calls.push(cmd);
      if (cmd === 'zenity' && first) {
        first = false;
        assert.equal(p.cancel(), true, 'a dialog is being opened: the cancel holds (pick/cancel answered open: true)');
        throw Object.assign(new Error('zenity: not found'), { name: 'NotFound' });
      }
      return { code: 0, stdout: '/home/a/x.nar\n', stderr: '' };
    },
  });
  assert.deepEqual(await p.open(pickRequest('files', 'en')), { canceled: true });
  assert.deepEqual(calls, ['zenity'], 'kdialog never started');
  assert.equal(p.cancel(), false, 'nothing is open now');
  assert.equal(p.available, true);
  // the next request of the same picker is a request of its own: the earlier cancel no longer holds
  calls.length = 0;
  assert.deepEqual(await p.open(pickRequest('files', 'en')), { paths: ['/home/a/x.nar'] });
  assert.deepEqual(calls, ['zenity']);
  // a cancel before the program's child is there: the child is killed as it comes
  let killed = 0;
  const early = linuxPicker({
    run: (cmd, args, onChild) => {
      early.cancel();
      return new Promise(resolve => onChild({ kill: () => { killed++; resolve({ code: 143, stdout: '', stderr: '' }); } }));
    },
  });
  assert.deepEqual(await early.open(pickRequest('site', 'en')), { canceled: true });
  assert.equal(killed, 1);
});

test('the Windows layouts: GUID bytes, UTF-16 strings, the dialog\'s options, where its owner goes, the DLLs', () => {
  assert.deepEqual([...guidBytes(CLSID_FileOpenDialog)].map(b => b.toString(16).padStart(2, '0')).join(''),
    '9c5a1cdc8ae8de4da5a160f82a20aef7', 'Data1–3 little-endian, Data4 as written');
  assert.deepEqual([...guidBytes(`{${IID_IFileOpenDialog.toUpperCase()}}`)].slice(0, 4), [0x88, 0x72, 0x7c, 0xd5]);
  assert.equal(guidBytes(IID_IShellItem).length, 16);
  for (const p of Object.values(PURPOSES)) assert.equal(guidBytes(p.guid).length, 16);
  assert.equal(new Set(Object.values(PURPOSES).map(p => p.guid)).size, 4, 'a client GUID per purpose');
  assert.throws(() => guidBytes('nope'), /not a GUID/);
  assert.deepEqual([...wide('aゴ')], [0x61, 0x30b4, 0]);
  const files = dialogOptions(FOS.PATHMUSTEXIST | FOS.FILEMUSTEXIST | FOS.NOCHANGEDIR, { multi: true });
  assert.equal(files, FOS.PATHMUSTEXIST | FOS.FILEMUSTEXIST | FOS.NOCHANGEDIR | FOS.FORCEFILESYSTEM | FOS.ALLOWMULTISELECT);
  const site = dialogOptions(0, { folders: true });
  assert.equal(site, FOS.PICKFOLDERS | FOS.FORCEFILESYSTEM | FOS.PATHMUSTEXIST | FOS.NOCHANGEDIR);
  assert.equal(dialogOptions(0, { folders: true, multi: true }) & FOS.ALLOWMULTISELECT, FOS.ALLOWMULTISELECT);
  // [measured] a maximized browser at 120 dpi: the dialog (960 × 600) came out centred on it
  assert.deepEqual(ownerPlace([0, 0, 1920, 1032], [-9, -9, 1929, 1029], 120), [480, 215, 960, 600]);
  assert.deepEqual(ownerPlace([0, 0, 1280, 720], null, 96), [256, 120, 768, 480], 'nothing in front: the monitor\'s middle');
  assert.deepEqual(ownerPlace([1920, 0, 3840, 1040], [2000, 100, 2400, 400], 96), [1920, 10, 768, 480], 'a small browser: kept on its monitor');
  assert.deepEqual(ownerPlace([0, 0, 800, 600], [0, 0, 800, 600], 192), [0, 0, 800, 600], 'never larger than the work area');
  assert.deepEqual(DLLS, ['ole32', 'shell32', 'user32', 'kernel32'].map(n => `C:\\Windows\\System32\\${n}.dll`));
  assert.deepEqual(FILTERS.archives, ['*.nar', '*.zip']);
});

test('a dev run with --fake-picker: hello says picker, /api/pick answers from the file', async t => {
  const dir = scratch(t);
  const file = path.join(dir, 'pick.json');
  const site = path.join(dir, 'mysite');
  fs.writeFileSync(file, JSON.stringify({ site: [site] }));
  const child = spawn(process.execPath, [path.join(ROOT, 'admin', 'server', 'main.mjs'), '--no-browser', '--settings',
    path.join(dir, 'settings.json'), '--temp', path.join(dir, 'temp'), '--fake-picker', file], { windowsHide: true });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', d => { out += d; });
  let m = null;
  for (let i = 0; i < 300 && !m; i++) {
    m = /http:\/\/127\.0\.0\.1:(\d+)\/\?key=([0-9a-f]{64})/.exec(out);
    if (!m) await sleep(50);
  }
  assert.ok(m, `the address line: ${out}`);
  const call = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${m[1]}${p}`, {
      method: body ? 'POST' : 'GET', headers: { 'X-Sumika-Admin-Key': m[2], ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  assert.equal((await call('/api/hello')).picker, true);
  assert.deepEqual(await call('/api/pick', { purpose: 'site', lang: 'ja' }), { paths: [site] });
  assert.deepEqual(await call('/api/pick', { purpose: 'files', lang: 'ja' }), { canceled: true });
  const exited = new Promise(resolve => child.once('exit', resolve));
  assert.deepEqual(await call('/api/quit', {}), { ok: true });
  await exited;
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).lastFolders.site, dir);
});

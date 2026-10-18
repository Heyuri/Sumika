// The admin page's logic in Node, no DOM (CLAUDE.md "The program and its builds", Tests): the drop walker on fake
// entries (readEntries in batches until empty, the core's skip rules, roots that are no ghost, the depth guard), the
// drop's sending (4 at a time, cancel on a failure or a stop), the API client (the key header, paths only in bodies and
// the one header, 403; no answer: the wait for the program, a lost job start found in the status, never sent twice),
// the ghost list (ghostRows: the program's order as it comes), the Sharing rows and the script line, the job poller,
// the Add plan, the upload list's order, the system's file dialogs (picker.js: the wait, the fallback, one open
// elsewhere); and that the page bundles for a browser with no node: built-in in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipCode, isSkipDir } from '../../admin/core/rules.mjs';
import { parseAllowlist, isLoopback } from '../../src/hub/allowlist.js';
import { walkDrop, sendDrop, readAll, fileRoots, droppedEntries, MAX_DEPTH } from '../../admin/page/drop.js';
import {
  createApi, takeKey, encodeRel, ApiError, KEY_HEADER, PATH_HEADER, KEY_STORAGE, STATUS_MS, PROBE_MS, BACKOFF_MS, WAIT_MS,
  RETRY_MS, MAX_SENDS,
} from '../../admin/page/api.js';
import { ghostRows, engineName } from '../../admin/page/ghostlist.js';
import {
  entryProblem, rowProblems, rowFinding, rowsToSave, scriptUrl, snippet, ENTRY_CODES, EXAMPLE, DEFAULT_STATES,
} from '../../admin/page/hub.js';
import { previewLinks } from '../../admin/page/screens/preview.js';
import { defaultState as runtimeDefaultState, DEFAULT_STATES as RUNTIME_DEFAULT_STATES } from '../../src/core/choice.js';
import { Jobs, Throttled, statusText, FAST_MS, SLOW_MS } from '../../admin/page/jobs.js';
import { verdict, addable, entryOf, planOf, mergeItems, addResults } from '../../admin/page/addplan.js';
import { uploadGroups, uploadText, optionalPath, prepareAsks, LAST } from '../../admin/page/upload.js';
import { LAST as SERVER_LAST } from '../../admin/server/upload.mjs';
import { joinPath, baseName, ledgerName, formatBytes, sepOf } from '../../admin/page/format.js';
import { Picker } from '../../admin/page/picker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES = { skip: skipCode, skipDir: isSkipDir };

// ---------------------------------------------------------------- fake file-system entries (webkitGetAsEntry)

/** A folder entry; its reader gives at most `batch` entries a call, as Chromium gives at most 100. */
function dir(name, children = [], { batch = 100, fail = false } = {}) {
  const d = {
    name, isFile: false, isDirectory: true, children, reads: 0,
    createReader() {
      let i = 0;
      return {
        readEntries(ok, err) {
          queueMicrotask(() => {
            d.reads++;
            if (fail) {
              err(new Error('NotReadableError'));
              return;
            }
            const b = d.children.slice(i, i + batch);
            i += b.length;
            ok(b);
          });
        },
      };
    },
  };
  return d;
}

function file(name, size = 10) {
  return { name, isFile: true, isDirectory: false, file(ok) { queueMicrotask(() => ok({ name, size })); } };
}

/** A ghost root: ghost/master/descript.txt (in the case given) and more. */
const ghost = (name, master = [], rest = [], { ghostDir = 'ghost', masterDir = 'master', descript = 'descript.txt' } = {}) =>
  dir(name, [dir(ghostDir, [dir(masterDir, [file(descript), ...master])]), ...rest]);

const sent = walked => walked.roots.flatMap(r => r.files.map(f => `${r.n}:${f.rel}`));

// ---------------------------------------------------------------- the drop walker

test('drop walker: a ghost root sends every file but what the copy leaves out; readEntries until empty', async () => {
  const many = Array.from({ length: 250 }, (_, i) => file(`surface${String(i).padStart(3, '0')}.png`));
  const shell = dir('master', many);
  const root = ghost('emily4', [
    file('dic.txt'), file('satori_savedata.txt'), file('yaya_variable.cfg'), file('debug.log'), file('yaya.dll'),
    dir('var', [file('bonsyou_now.txt'), file('kept.txt')]),
  ], [dir('shell', [shell]), dir('Profile', [file('ghost.dat')]), file('readme.txt'), file('Thumbs.db'), file('setup.exe')]);
  const w = await walkDrop([root], RULES);
  assert.deepEqual(w.refused, []);
  assert.equal(w.roots.length, 1);
  assert.deepEqual([w.roots[0].n, w.roots[0].name, w.roots[0].kind], [0, 'emily4', 'dir']);
  const rels = w.roots[0].files.map(f => f.rel);
  assert.equal(rels.length, 250 + 4, 'the 250 surfaces, descript.txt, dic.txt, kept.txt, readme.txt');
  assert.ok(rels.every(r => r.startsWith('emily4/')), 'each path starts with the dropped name');
  assert.ok(rels.includes('emily4/ghost/master/descript.txt') && rels.includes('emily4/shell/master/surface249.png'));
  assert.equal(shell.reads, 4, 'readEntries called until it gave nothing: 100 + 100 + 50 + 0');
  const left = Object.fromEntries(w.left.map(x => [x.path, x.code]));
  assert.deepEqual(left, {
    'ghost/master/satori_savedata.txt': 'personal.satoriSave',
    'ghost/master/yaya_variable.cfg': 'personal.variable',
    'ghost/master/debug.log': 'personal.log',
    'ghost/master/yaya.dll': 'program.dll',
    'ghost/master/var/bonsyou_now.txt': 'personal.path',
    'Profile/': 'personal.profile',
    'Thumbs.db': 'windows.thumbsDb',
    'setup.exe': 'program.exe',
  }, 'personal files, programs and Windows\' own files are never sent; profile/ is not even read');
  assert.ok(w.left.every(x => x.root === 'emily4'));
  assert.equal(w.left.find(x => x.code === 'personal.path').params.pattern, 'ghost/master/var/bonsyou*.txt');
  assert.equal(w.roots[0].bytes, 254 * 10);
});

test('drop walker: ghost/master/descript.txt in any case; a folder of ghosts sends its ghosts and archives only', async () => {
  const odd = ghost('Odd', [file('x.dic')], [], { ghostDir: 'Ghost', masterDir: 'MASTER', descript: 'Descript.TXT' });
  const ssp = dir('ghost', [
    ghost('tsubasa', [file('dic01.txt'), file('satori_savebackup.txt')]),
    odd,
    dir('not-a-ghost', [file('notes.txt')]),
    file('nato.nar', 500), file('readme.txt'), file('Old.ZIP', 7),
  ]);
  const w = await walkDrop([ssp], RULES);
  assert.deepEqual(w.refused, []);
  assert.deepEqual(sent(w), [
    '0:ghost/tsubasa/ghost/master/descript.txt', '0:ghost/tsubasa/ghost/master/dic01.txt',
    '0:ghost/Odd/Ghost/MASTER/Descript.TXT', '0:ghost/Odd/Ghost/MASTER/x.dic',
    '0:ghost/nato.nar', '0:ghost/Old.ZIP',
  ]);
  assert.deepEqual(w.left.map(x => [x.root, x.path, x.code]), [['ghost/tsubasa', 'ghost/master/satori_savebackup.txt', 'personal.satoriBackup']],
    'a ghost inside a folder of ghosts is judged from its own root');
});

test('drop walker: archives, files and folders that are no ghost, items that are no file, roots numbered in order', async () => {
  const w = await walkDrop([null, file('readme.txt'), file('a.nar', 3), dir('empty'), ghost('g'), dir('docs', [file('x.txt')]), file('B.Zip', 4)], RULES);
  assert.deepEqual(w.roots.map(r => [r.n, r.name, r.kind, r.bytes]), [[0, 'a.nar', 'file', 3], [1, 'g', 'dir', 10], [2, 'B.Zip', 'file', 4]]);
  assert.deepEqual(w.roots[0].files.map(f => f.rel), ['a.nar'], 'an archive is sent under its own name');
  assert.deepEqual(w.refused.map(r => [r.name, r.code]), [['readme.txt', 'drop.notSource'], ['empty', 'drop.noGhost'], ['docs', 'drop.noGhost']]);
  assert.deepEqual(await walkDrop([], RULES), { roots: [], refused: [], left: [] });
});

test('drop walker: a link loop stops at 64 folder levels and that item is not sent; an unreadable folder neither', async () => {
  const loop = dir('loop');
  loop.children.push(loop);                                  // a folder that holds itself, as a looping link reads
  const w = await walkDrop([ghost('looped', [loop]), ghost('fine'), dir('locked', [], { fail: true })], RULES);
  assert.deepEqual(w.roots.map(r => [r.n, r.name]), [[0, 'fine']]);
  assert.deepEqual(w.refused.map(r => [r.name, r.code, r.params && r.params.max]), [['looped', 'drop.tooDeep', MAX_DEPTH], ['locked', 'drop.unreadable', undefined]]);
  const shallow = dir('a', [dir('b', [dir('c', [file('deep.txt')])])]);
  assert.equal((await walkDrop([ghost('g', [shallow])], { ...RULES, maxDepth: 3 })).refused[0].code, 'drop.tooDeep', 'the guard is a depth');
  assert.equal((await walkDrop([ghost('g', [dir('a', [dir('b', [file('ok.txt')])])])], { ...RULES, maxDepth: 4 })).refused.length, 0);
});

test('readAll reads one reader until it is empty; droppedEntries and the no-entry-API fallback', async () => {
  const d = dir('x', Array.from({ length: 7 }, (_, i) => file(`f${i}`)), { batch: 3 });
  assert.equal((await readAll(d)).length, 7);
  assert.equal(d.reads, 4);
  const entry = { name: 'e' };
  const items = [{ kind: 'file', webkitGetAsEntry: () => entry }, { kind: 'string', webkitGetAsEntry: () => null }];
  assert.deepEqual(droppedEntries({ items }), [entry], 'only file items');
  assert.deepEqual(droppedEntries({ items: [{ kind: 'file', getAsEntry: () => 1, webkitGetAsEntry: () => 2 }] }), [1], 'the standard name first');
  assert.equal(droppedEntries({ items: [{ kind: 'file' }] }), null, 'no entry API: null');
  // a folder in dataTransfer.files cannot be read: it is named for the folder dialog's note, not refused as no source;
  // a plain file that is no archive is no source, and gets no note about folders
  const asBlob = (name, bytes, folder = false) => ({
    name, size: bytes.length,
    slice: () => asBlob(name, bytes.slice(0, 1), folder),
    arrayBuffer: () => (folder ? Promise.reject(new DOMException('A requested file or directory could not be found', 'NotFoundError'))
      : Promise.resolve(new Uint8Array(bytes).buffer)),
  });
  const fr = await fileRoots([asBlob('a.nar', [1, 2]), asBlob('folder', [], true), asBlob('readme.txt', [65]), asBlob('empty.txt', [])]);
  assert.deepEqual(fr.roots.map(r => [r.n, r.name, r.kind, r.bytes]), [[0, 'a.nar', 'file', 2]]);
  assert.deepEqual(fr.folders, ['folder']);
  assert.deepEqual(fr.refused, [{ name: 'readme.txt', code: 'drop.notSource' }, { name: 'empty.txt', code: 'drop.notSource' }]);
  assert.deepEqual((await fileRoots([asBlob('notes.txt', [65])])).folders, [], 'no folder dropped: no note');
  const { t } = await import('../../admin/page/strings.js');
  assert.equal(t('drop.noEntries', 'en', { names: 'folder' }),
    'folder: this browser cannot read dropped folders, so they were not sent. Choose them with Choose folders… instead.',
    'the folder dialog\'s button by its own name');
  assert.match(t('drop.noEntries', 'ja', { names: 'folder' }), /「フォルダを選ぶ…」/);
});

// ---------------------------------------------------------------- sending a drop

function fakeDropApi({ failAt = null, doneFails = false } = {}) {
  const log = [];
  let inFlight = 0, most = 0, puts = 0;
  return {
    log,
    get most() { return most; },
    async dropStart() { log.push(['start']); return { drop: 'd1' }; },
    async dropPut(drop, n, rel, blob, { signal } = {}) {
      const k = ++puts;
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 2);
          if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
        });
        if (failAt === k) throw new ApiError({ status: 500, code: 'drop-write', params: { error: 'ENOSPC' } });
        log.push(['put', drop, n, rel]);
        return { ok: true };
      } finally {
        inFlight--;
      }
    },
    async dropDone(drop, roots) {
      log.push(['done', drop, roots]);
      if (doneFails) throw new ApiError({ status: 409, code: 'busy', params: { kind: 'add' } });
      return { id: 'job1', kind: 'inspect', state: 'running' };
    },
    async dropCancel(drop) { log.push(['cancel', drop]); return { ok: true }; },
  };
}

test('sendDrop: every file PUT with its root number and path, 4 at a time, then done names the roots', async () => {
  const w = await walkDrop([ghost('a', Array.from({ length: 9 }, (_, i) => file(`d${i}.txt`))), file('b.nar', 5)], RULES);
  const api = fakeDropApi();
  const progress = [];
  const job = await sendDrop(api, w, { onProgress: p => progress.push(p) });
  assert.deepEqual(job, { id: 'job1', kind: 'inspect', state: 'running' });
  const puts = api.log.filter(e => e[0] === 'put');
  assert.equal(puts.length, 11);
  assert.ok(puts.every(([, drop]) => drop === 'd1'));
  assert.deepEqual(puts.filter(p => p[2] === 1).map(p => p[3]), ['b.nar']);
  assert.ok(puts.filter(p => p[2] === 0).every(p => p[3].startsWith('a/ghost/master/')));
  assert.equal(api.most, 4, 'at most 4 at a time, and 4 used');
  assert.deepEqual(api.log.at(-1), ['done', 'd1', [{ n: 0, name: 'a', kind: 'dir' }, { n: 1, name: 'b.nar', kind: 'file' }]]);
  assert.deepEqual([progress[0].done, progress.at(-1).done, progress.at(-1).total, progress.at(-1).totalBytes], [0, 11, 11, 105]);
});

test('sendDrop: a failed PUT cancels the drop (its folder goes) and throws; so does a stop and a refused done', async () => {
  const w = await walkDrop([ghost('a', Array.from({ length: 20 }, (_, i) => file(`d${i}.txt`)))], RULES);
  const api = fakeDropApi({ failAt: 6 });
  await assert.rejects(sendDrop(api, w), e => e.code === 'drop-write');
  assert.deepEqual(api.log.at(-1), ['cancel', 'd1']);
  assert.ok(!api.log.some(e => e[0] === 'done'));
  assert.ok(api.log.filter(e => e[0] === 'put').length < 20, 'no new PUT after the failure');

  const ctrl = new AbortController();
  const api2 = fakeDropApi();
  const p = sendDrop(api2, w, { signal: ctrl.signal, onProgress: x => { if (x.done === 3) ctrl.abort(); } });
  await assert.rejects(p, e => e.name === 'AbortError');
  assert.deepEqual(api2.log.at(-1), ['cancel', 'd1']);

  const api3 = fakeDropApi({ doneFails: true });
  await assert.rejects(sendDrop(api3, w), e => e.code === 'busy');
  assert.deepEqual(api3.log.at(-1), ['cancel', 'd1'], 'files sent for an inspection that could not start are deleted');
});

// ---------------------------------------------------------------- the API client

function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, ...init, headers: { ...init.headers } });
    const r = await answer(url, init);
    if (r instanceof Error) throw r;
    const { status = 200, body = {}, type = 'application/json; charset=utf-8' } = r || {};
    return {
      ok: status >= 200 && status < 300, status, statusText: 'x',
      headers: { get: k => (k.toLowerCase() === 'content-type' ? type : null) },
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { f, calls };
}

test('API client: the key on every call, JSON bodies, paths in bodies, a drop file\'s path in its header', async () => {
  const { f, calls } = fakeFetch(() => ({ body: { ok: true } }));
  const api = createApi({ key: 'k'.repeat(64), fetch: f });
  await api.hello();
  await api.list('C:\\Users\\someone\\ゴースト');
  await api.inspect([{ path: '/home/a/b.nar' }]);
  await api.dropPut('ab12', 3, 'emily4/ghost/master/ゴースト #1.txt', { size: 1 });
  await api.add([{ token: 't', replace: false, keep: [], leaveOut: ['x'] }]);
  await api.previewStart('ja');
  assert.ok(calls.every(c => c.headers[KEY_HEADER] === 'k'.repeat(64)), 'every call carries the key');
  assert.ok(calls.every(c => c.cache === 'no-store' && c.credentials === 'omit'));
  assert.deepEqual(calls.map(c => [c.method, c.url]), [
    ['GET', '/api/hello'], ['POST', '/api/fs/list'], ['POST', '/api/inspect'], ['PUT', '/api/drop/ab12/3'], ['POST', '/api/add'],
    ['POST', '/api/preview/start']]);
  assert.equal(calls[0].body, undefined, 'a GET has no body');
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].body), { path: 'C:\\Users\\someone\\ゴースト' });
  assert.ok(!calls.some(c => c.url.includes('someone') || c.url.includes('home')), 'no path in a URL');
  assert.equal(calls[3].headers[PATH_HEADER], 'emily4/ghost/master/%E3%82%B4%E3%83%BC%E3%82%B9%E3%83%88%20%231.txt');
  assert.equal(decodeURIComponent(calls[3].headers[PATH_HEADER]), 'emily4/ghost/master/ゴースト #1.txt', 'one decodeURIComponent reads it back');
  assert.equal(calls[3].headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(calls[3].body, { size: 1 }, 'the file itself is the body');
  assert.deepEqual(JSON.parse(calls[4].body), { plan: [{ token: 't', replace: false, keep: [], leaveOut: ['x'] }] });
  assert.equal(encodeRel('a/b c/d'), 'a/b%20c/d');
});

test('API client: an error answer is an ApiError with its code; 403 tells the tab is old (and ends the waiting); no answer after that fails at once', async () => {
  const lost = [], off = [];
  let mode = '403';
  const { f } = fakeFetch(() => {
    if (mode === '403') return { status: 403, body: { error: { code: 'bad-key', message: 'this tab belongs to an earlier start' } } };
    if (mode === '409') return { status: 409, body: { error: { code: 'busy', params: { kind: 'add' }, message: 'another job is running (add)' } } };
    if (mode === 'text') return { status: 500, body: 'oops', type: 'text/plain' };
    return new TypeError('Failed to fetch');
  });
  const api = createApi({ key: 'k', fetch: f, onAuthLost: e => lost.push(e.code), onState: s => off.push(s) });
  await assert.rejects(api.status(), e => e instanceof ApiError && e.auth && !e.offline && e.code === 'bad-key' && e.status === 403);
  mode = '409';
  await assert.rejects(api.remove('x'), e => e.code === 'busy' && e.params.kind === 'add' && !e.auth);
  mode = 'text';
  await assert.rejects(api.check(), e => e.code === 'http-500' && e.message === 'oops');
  mode = 'down';
  await assert.rejects(api.hello(), e => e.offline && e.code === 'offline', 'this tab is done with the program: no waiting');
  assert.deepEqual([lost, off], [['bad-key'], []]);
  assert.deepEqual(new ApiError({ status: 409, code: 'busy', params: { kind: 'x' }, message: 'm' }).toJSON(), { code: 'busy', params: { kind: 'x' }, message: 'm' });
  const abort = Object.assign(new Error('stop'), { name: 'AbortError' });
  const api2 = createApi({ key: 'k', fetch: async () => { throw abort; }, onState: () => assert.fail('a stop is no lost answer') });
  await assert.rejects(api2.dropPut('d', 0, 'a', {}), e => e === abort);
});

test('the key: from ?key= into the tab\'s sessionStorage and the address cleaned; then from storage; none', () => {
  const store = new Map();
  const ss = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const replaced = [];
  const win = (search, s = ss) => ({ location: { search }, history: { replaceState: (...a) => replaced.push(a) }, sessionStorage: s });
  assert.equal(takeKey(win('?key=abc123')), 'abc123');
  assert.equal(store.get(KEY_STORAGE), 'abc123');
  assert.deepEqual(replaced, [[null, '', '/']], 'the key leaves the address bar');
  assert.equal(takeKey(win('')), 'abc123', 'a reload of / keeps the tab\'s key');
  assert.equal(replaced.length, 1);
  assert.equal(takeKey(win('?key=new')), 'new', 'a new start\'s address wins');
  store.clear();
  assert.equal(takeKey(win('')), null);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(takeKey(win('?key=k2', broken)), 'k2', 'storage refused: the key still works for this page');
  assert.equal(takeKey(win('', broken)), null);
});

// ---------------------------------------------------------------- the ghost list

test('ghost list: the program\'s order (Change ghost ▸\'s) as it comes, never sorted here', () => {
  const sent = [
    { id: 'tsubasa', name: 'Hayama-san Next Door', indexed: true }, { id: 'zeta', name: 'Zeta', indexed: false },
    { id: 'emily4', name: 'Emily/Phase4.5', indexed: true }, { id: 'Katari', name: 'カタリベカタリ', indexed: false },
  ];
  assert.deepEqual(ghostRows(sent), sent, 'not by name, not by folder, indexed or not: as sent');
  assert.deepEqual(ghostRows([{ id: 'b' }, null, { name: 'no id' }, { id: 'a' }]).map(r => r.id), ['b', 'a'], 'rows without an id are left out');
  assert.deepEqual(ghostRows(null), []);
  assert.deepEqual(['satori', 'yaya', 'kawari', 'kawari7', null, 'other'].map(engineName), ['Satori', 'YAYA', 'Kawari', 'Kawari 7', 'Satori', 'other']);
});

// ---------------------------------------------------------------- Sharing

const ENTRIES = ['https://a.example.com', 'https://a.example.com/', 'http://b.example.com:8080', 'https://A.Example.com',
  'https://*.example.com', 'a.example.com', 'ftp://a.example.com', 'https://user:pw@a.example.com', 'https://a.example.com?x',
  'https://a.example.com#', 'https://a.example.com/page', 'http://localhost:8644', 'http://127.0.0.1:8643', 'https://[::1]',
  'null', 'https://sub.a.example.com:443'];

test('Sharing rows: the gate\'s verdict as you type (kept on some scheme and no loopback = no problem)', () => {
  for (const entry of ENTRIES) {
    const text = JSON.stringify({ format: 1, origins: [entry] });
    const kept = ['https://hub.invalid/sumika/hub.html', 'http://hub.invalid/sumika/hub.html']
      .some(hub => parseAllowlist(text, hub).origins.size === 1);
    let loop = false;
    try { loop = isLoopback(new URL(entry).hostname); } catch (e) { loop = false; }
    assert.equal(entryProblem(entry) === null, kept && !loop, `${entry}: ${entryProblem(entry)}`);
  }
  assert.deepEqual(['https://*.a.com', 'a.com', 'ftp://a.com', 'https://u@a.com', 'https://a.com?', 'https://a.com/x', 'http://localhost:1']
    .map(e => entryProblem(e)), ['wildcard', 'not-absolute', 'not-http', 'userinfo', 'query-or-fragment', 'has-path', 'loopback']);
  assert.equal(entryProblem('  https://a.example.com  '), null, 'trimmed, as Save trims');
  assert.equal(entryProblem(''), null, 'an empty row is no problem (it is not saved)');
  assert.equal(entryProblem('http://a.example.com', { scheme: 'https:' }), 'scheme', 'the hub keeps entries of its own scheme only');
  assert.equal(entryProblem('https://a.example.com', { scheme: 'https:' }), null);
  assert.deepEqual(rowProblems(['https://a.example.com', 'https://a.example.com/', '', 'https://A.example.com:443', 'x']),
    [null, 'duplicate', null, 'duplicate', 'not-absolute'], 'one origin twice: the second row');
  assert.deepEqual(rowsToSave([' https://a.example.com ', '', '  ']), ['https://a.example.com']);
  assert.ok(ENTRY_CODES.includes('scheme') && ENTRY_CODES.includes('duplicate') && ENTRY_CODES.includes('loopback'));
});

test('the script line: the Sumika host\'s address as typed, https by default, a site under a path, escaped', () => {
  assert.deepEqual(scriptUrl('sumika.example.com'), {
    url: 'https://sumika.example.com/sumika/sumika.js', control: 'https://sumika.example.com/sumika/', scheme: 'https:', problem: null,
  });
  assert.equal(scriptUrl('https://sumika.example.com/').url, 'https://sumika.example.com/sumika/sumika.js');
  assert.equal(scriptUrl('example.com/site').url, 'https://example.com/site/sumika/sumika.js', 'a site in a folder of the host');
  assert.equal(scriptUrl('http://example.com:8080/a/').url, 'http://example.com:8080/a/sumika/sumika.js');
  assert.equal(scriptUrl('localhost:8642').url, 'https://localhost:8642/sumika/sumika.js', 'host:port is a host');
  assert.equal(scriptUrl('').url, null);
  for (const bad of ['https://a.com/?x=1', 'ftp://a.com', 'https://u:p@a.com', 'https://a.com/#top', 'http://']) {
    assert.equal(scriptUrl(bad).problem, 'bad', bad);
  }
  assert.equal(snippet('https://sumika.example.com/sumika/sumika.js'),
    '<script src="https://sumika.example.com/sumika/sumika.js" data-hub defer></script>', 'no data-default-ghost: no extras');
  assert.equal(snippet(null), '<script src="https://sumika.example.com/sumika/sumika.js" data-hub defer></script>', 'the example');
  assert.equal(snippet('https://a.com/x&y"/sumika/sumika.js'), '<script src="https://a.com/x&amp;y&quot;/sumika/sumika.js" data-hub defer></script>');
});

test('the visitor\'s choice: the control page beside sumika.js on the typed host; data-default-state only when not the default', () => {
  // the control page is the folder of sumika.js (sumika/index.html), on a site under a path too
  assert.equal(scriptUrl('https://sumika.example.com').control, 'https://sumika.example.com/sumika/');
  assert.equal(scriptUrl('example.com/site').control, 'https://example.com/site/sumika/');
  assert.equal(scriptUrl('http://example.com:8080/a/').control, 'http://example.com:8080/a/sumika/');
  for (const typed of ['sumika.example.com', 'example.com/site', 'http://example.com:8080/a/']) {
    const s = scriptUrl(typed);
    assert.equal(new URL('sumika.js', s.control).href, s.url, `${typed}: the page beside sumika.js`);
  }
  assert.equal(scriptUrl('').control, null, 'nothing typed: the screen shows the example');
  assert.equal(scriptUrl('ftp://a.com').control, null, 'an unusable address has none');
  assert.equal(new URL('sumika.js', EXAMPLE.control).href, EXAMPLE.url, 'the example\'s two addresses agree');
  assert.deepEqual(DEFAULT_STATES, ['', 'tucked', 'off'], 'Shown, Tucked as her button, Off: the select\'s values');
  const url = 'https://sumika.example.com/sumika/sumika.js';
  assert.equal(snippet(url, { defaultState: 'tucked' }), `<script src="${url}" data-hub data-default-state="tucked" defer></script>`);
  assert.equal(snippet(url, { defaultState: 'off' }), `<script src="${url}" data-hub data-default-state="off" defer></script>`);
  for (const none of ['', undefined, 'enabled', 'x" onload="y']) {
    assert.equal(snippet(url, { defaultState: none }), snippet(url), `${none}: the default is no attribute; no other value is written`);
  }
  assert.equal(snippet(null, { defaultState: 'off' }), `<script src="${EXAMPLE.url}" data-hub data-default-state="off" defer></script>`,
    'the example line shows the choice too');
});

test('the visitor\'s choice: the select\'s options are DEFAULT_STATES, and the runtime reads each line as that state', () => {
  const html = fs.readFileSync(path.join(ROOT, 'admin', 'page', 'index.html'), 'utf8');
  const select = /<select id="sharing-default"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select, 'the Sharing screen\'s select');
  assert.deepEqual([...select[1].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]), [...DEFAULT_STATES]);
  // the line as the runtime reads its script tag (src/core/choice.js): the same state, no warning; Shown is the
  // runtime's default, 'enabled', which the line says by leaving the attribute out
  const url = 'https://sumika.example.com/sumika/sumika.js';
  for (const v of DEFAULT_STATES) {
    const line = snippet(url, { defaultState: v });
    const m = /\sdata-default-state="([^"]*)"/.exec(line);
    const warned = [];
    assert.equal(runtimeDefaultState(m ? { defaultState: m[1] } : {}, w => warned.push(w)), v || 'enabled', line);
    assert.deepEqual(warned, [], `${line}: no warning`);
  }
  assert.deepEqual(RUNTIME_DEFAULT_STATES.map(s => (s === 'enabled' ? '' : s)), [...DEFAULT_STATES],
    'one option per state the runtime knows, in its order');
});

test('the Preview\'s links: the site\'s top page only when it has one, a page elsewhere, the control page when the runtime has it', () => {
  const p = { site: 'http://127.0.0.1:5001/', pages: ['http://127.0.0.1:5002/', 'http://127.0.0.1:5003/'] };
  const site = (front, control) => ({ path: 'x', front, runtime: { build: 'b', hub: true, control } });
  assert.deepEqual(previewLinks(p, site(true, true)), [
    ['http://127.0.0.1:5001/', 'preview.openSite'],
    ['http://127.0.0.1:5002/', 'preview.openPage'],
    ['http://127.0.0.1:5001/sumika/', 'preview.openControl'],
  ]);
  assert.deepEqual(previewLinks(p, site(false, true)).map(l => l[1]), ['preview.openPage', 'preview.openControl'],
    'no index.html at the top (the project\'s site/ since its test pages went to dev/): no link to a "Not found"');
  assert.deepEqual(previewLinks(p, site(true, false)).map(l => l[1]), ['preview.openSite', 'preview.openPage'], 'a runtime from before the control page');
  assert.deepEqual(previewLinks(p, { path: 'x', front: true, runtime: null }).map(l => l[1]), ['preview.openSite', 'preview.openPage']);
  assert.deepEqual(previewLinks(null, site(true, true)), []);
  assert.deepEqual(previewLinks({ site: null }, site(true, true)), [], 'no preview running');
});

// ---------------------------------------------------------------- jobs and the status line

class FakeTimers {
  constructor() {
    this.now = 0;
    this.queue = [];
    this.seq = 0;
  }

  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.queue.push({ id, at: this.now + ms, fn });
    return id;
  }

  clearTimeout(id) {
    this.queue = this.queue.filter(t => t.id !== id);
  }

  /** Runs the timers due within ms, in order, letting promises settle between them. */
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.now = next.at;
      next.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    this.now = end;
  }
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('jobs: polls every 10 s, every second while a job runs; a followed job resolves when the status shows it done', async () => {
  const timers = new FakeTimers();
  const answers = [];
  let polls = 0;
  const api = { status: async () => { polls++; return answers.shift() || { job: null, preview: null }; } };
  const seen = [];
  const jobs = new Jobs({ api, timers, onChange: s => seen.push(s.job && s.job.state) });
  jobs.start();
  await timers.advance(SLOW_MS - 1);
  assert.equal(polls, 0);
  await timers.advance(1);
  await settle();
  assert.equal(polls, 1, 'idle: every 10 s');
  answers.push({ job: { id: 'j1', kind: 'add', state: 'running', phase: 'copy', done: 2, total: 10 } });
  const done = jobs.follow({ id: 'j1', kind: 'add', state: 'running' });
  await settle();
  assert.equal(polls, 2, 'following a job polls at once');
  assert.ok(jobs.busy);
  answers.push({ job: { id: 'j1', kind: 'add', state: 'done', result: { items: [] } } });
  await timers.advance(FAST_MS);
  await settle();
  const final = await done;
  assert.deepEqual([final.state, final.result], ['done', { items: [] }]);
  assert.equal(polls, 3, 'a second later');
  assert.ok(!jobs.busy);
  jobs.stop();
  assert.equal(timers.queue.length, 0);
});

test('jobs: a job already done in its start answer resolves at once; another tab\'s new job ends the wait; no answer ends polling', async () => {
  const timers = new FakeTimers();
  const answers = [];
  const ends = [];
  const api = { status: async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a || { job: null }; } };
  const jobs = new Jobs({ api, timers, onEnd: why => ends.push(why) });
  jobs.start();
  assert.equal((await jobs.follow({ id: 'q', kind: 'check', state: 'done', result: { problems: [] } })).state, 'done');
  answers.push({ job: { id: 'j2', kind: 'index', state: 'running' } });
  const waiting = jobs.follow({ id: 'j2', kind: 'index', state: 'running' });
  await settle();
  answers.push({ job: { id: 'other', kind: 'remove', state: 'running' } });
  await timers.advance(FAST_MS);
  await settle();
  const r = await waiting;
  assert.deepEqual([r.state, r.error.code], ['failed', 'job-replaced']);
  const stuck = jobs.follow({ id: 'j3', kind: 'add', state: 'running' });
  answers.push(Object.assign(new ApiError({ status: 0, code: 'offline' })));
  await settle();
  await timers.advance(FAST_MS);
  await settle();
  assert.deepEqual(ends, ['offline']);
  assert.deepEqual((await stuck).error, { code: 'offline' }, 'a waiter is not left hanging');
  assert.equal(timers.queue.length, 0, 'polling has ended');
  assert.equal((await jobs.follow({ id: 'late', state: 'running' })).state, 'failed');
});

test('status line: the job in words, its phase and count; written at most every 5 s, at once on a change', async () => {
  assert.equal(statusText(null, 'en'), 'Ready.');
  assert.equal(statusText({ kind: 'add', state: 'running', phase: 'copy', done: 3, total: 40 }, 'en'), 'Adding ghosts: copying files (3 of 40)');
  assert.equal(statusText({ kind: 'add', state: 'running', phase: 'copy', done: 3, total: 40 }, 'ja'), 'ゴーストの追加中：ファイルをコピーしています（40件中3件）');
  assert.equal(statusText({ kind: 'add', state: 'running', phase: 'add', done: 1, total: 2 }, 'en'), 'Adding ghosts… (1 of 2)', 'a phase named like its job says nothing more');
  assert.equal(statusText({ kind: 'mystery', state: 'running', phase: 'strange' }, 'en'), 'Working…');
  assert.equal(statusText({ kind: 'check', state: 'done' }, 'ja'), 'サイトの確認が完了しました。');
  assert.equal(statusText({ kind: 'remove', state: 'failed', error: { code: 'busy', params: { kind: 'add' } } }, 'en'),
    'Removing a ghost: did not finish. sumika-admin is busy (Adding ghosts): wait until that has finished, then try again.');
  const timers = new FakeTimers();
  const out = [];
  const say = new Throttled(s => out.push(s), { timers, now: () => timers.now });
  say.set('a 1', 'k');
  say.set('a 2', 'k');
  say.set('a 3', 'k');
  assert.deepEqual(out, ['a 1']);
  say.set('b', 'other');
  assert.deepEqual(out, ['a 1', 'b'], 'a new job, state or phase: at once');
  say.set('b 2', 'other');
  await timers.advance(5000);
  assert.deepEqual(out, ['a 1', 'b', 'b 2'], 'the last text arrives after 5 s');
  say.dispose();
});

// ---------------------------------------------------------------- the wait for a program that gives no answer (api.js)

/**
 * A fake program behind fetch. `up`: true answers, false gives no answer (a closed window), 'hang' none until the
 * call's own timeout aborts it (a stuck program), 403 answers bad-key (a new start). GET /api/status answers
 * `p.status`; other calls `answer(url, init, p)` (an object, or an Error to throw: a lost answer). Each request is
 * logged as 'METHOD path'.
 */
function fakeProgram(answer = () => ({ body: { ok: true } })) {
  const p = { up: true, log: [], status: { job: null, preview: null } };
  p.fetch = (url, init) => {
    p.log.push(`${init.method} ${url}`);
    if (p.up === 'hang') {
      return new Promise((resolve, reject) => {
        if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (!p.up) return Promise.reject(new TypeError('Failed to fetch'));
    const r = p.up === 403 ? { status: 403, body: { error: { code: 'bad-key', message: 'm' } } }
      : url === '/api/status' && init.method === 'GET' ? { body: p.status } : answer(url, init, p);
    if (r instanceof Error) return Promise.reject(r);
    const { status = 200, body = {} } = r || {};
    return Promise.resolve({
      ok: status >= 200 && status < 300, status, statusText: 'x',
      headers: { get: k => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body, text: async () => JSON.stringify(body),
    });
  };
  return p;
}

/** Runs the fake timers `ms` ahead in small steps, letting every promise settle first and in between. */
async function run(timers, ms, step = 50) {
  await new Promise(r => setImmediate(r));
  for (let t = 0; t < ms; t += step) {
    await timers.advance(Math.min(step, ms - t));
    await new Promise(r => setImmediate(r));
  }
}

const statuses = p => p.log.filter(l => l === 'GET /api/status').length;

test('waiting for the program: a read whose answer was lost is sent again; a gap the first status call bridges shows no line', async () => {
  const timers = new FakeTimers();
  let fail = 1;
  const p = fakeProgram(url => (url === '/api/ghosts' && fail-- > 0 ? new TypeError('Failed to fetch') : { body: { ghosts: [{ id: 'a' }] } }));
  const states = [];
  const api = createApi({ key: 'k', fetch: p.fetch, timers, now: () => timers.now, onState: s => states.push(s) });
  const r = await api.ghosts();
  assert.deepEqual(r, { ghosts: [{ id: 'a' }] });
  assert.deepEqual(p.log, ['POST /api/ghosts', 'GET /api/status', 'POST /api/ghosts'], 'the status answered at once: sent again');
  assert.deepEqual(states, [], 'no line for a gap that short');
});

test('waiting for the program: "waiting" with status calls 0.5, 1, 2 s apart, "stopped" after 20 s, then every 3 s; it answers: the read goes on', async () => {
  const timers = new FakeTimers();
  const p = fakeProgram(() => ({ body: { ghosts: [] } }));
  const states = [];
  const api = createApi({ key: 'k', fetch: p.fetch, timers, now: () => timers.now, onState: s => states.push(s) });
  p.up = false;
  let answer = null;
  const pending = api.ghosts().then(v => { answer = v; });
  await run(timers, 0);
  assert.deepEqual([states, statuses(p)], [['waiting'], 1], 'the line at once when the first status call gets nothing');
  await run(timers, BACKOFF_MS[0]);
  assert.equal(statuses(p), 2);
  await run(timers, BACKOFF_MS[1]);
  assert.equal(statuses(p), 3);
  await run(timers, BACKOFF_MS[2] * 2);
  assert.equal(statuses(p), 5, 'then every 2 s');
  await run(timers, WAIT_MS - timers.now - 1);
  assert.deepEqual(states, ['waiting'], 'not yet stopped before 20 s');
  await run(timers, 3000);
  assert.deepEqual(states, ['waiting', 'stopped'], 'closed or stuck: said after 20 s');
  const before = statuses(p);
  await run(timers, RETRY_MS * 3);
  assert.equal(statuses(p), before + 3, 'and asked on every 3 s');
  assert.equal(answer, null);
  p.up = true;
  await run(timers, RETRY_MS);
  await pending;
  assert.deepEqual(answer, { ghosts: [] }, 'it answers: the call goes on as if nothing happened');
  assert.deepEqual(states, ['waiting', 'stopped', 'ok']);
  assert.equal(p.log.filter(l => l === 'POST /api/ghosts').length, 2);
  assert.equal(timers.queue.length, 0, 'nothing left asking');
});

test('waiting for the program: a job start whose answer was lost is found in the status (never started twice); one that never arrived is sent again', async () => {
  const timers = new FakeTimers();
  timers.now = 100000;
  const starts = { check: 0, index: 0, remove: 0 };
  const p = fakeProgram((url, init, prog) => {
    const kind = url.slice('/api/'.length);
    starts[kind]++;
    if (kind === 'check') {
      // the job starts, then the answer is lost
      prog.status = { job: { id: 'j1', kind: 'check', state: 'running', startedAt: timers.now }, preview: null };
      return new TypeError('NetworkError when attempting to fetch resource.');
    }
    if (kind === 'index' && starts.index === 1) return new TypeError('Failed to fetch');   // never arrived
    if (kind === 'index') return { body: { id: 'j2', kind: 'index', state: 'running', startedAt: timers.now } };
    // remove: lost while another tab's add started
    prog.status = { job: { id: 'j3', kind: 'add', state: 'running', startedAt: timers.now }, preview: null };
    return new TypeError('Failed to fetch');
  });
  const api = createApi({ key: 'k', fetch: p.fetch, timers, now: () => timers.now });
  const j1 = await api.check();
  assert.deepEqual([j1.id, starts.check], ['j1', 1], 'its job, from the status: not started again');
  timers.now += 60000;                                       // j1 is long done
  p.status = { job: { ...p.status.job, state: 'done' }, preview: null };
  const j2 = await api.index();
  assert.deepEqual([j2.id, starts.index], ['j2', 2], 'no job started since it was sent: sent again, once');
  timers.now += 60000;
  await assert.rejects(api.remove('x'), e => e.code === 'job-replaced' && !e.offline, 'another job since: not sent again');
  assert.equal(starts.remove, 1);
});

test('waiting for the program: a status call unanswered for 10 s is none (a stuck program); a 403 meanwhile ends the waiting (a new start)', async () => {
  const timers = new FakeTimers();
  const p = fakeProgram();
  const states = [], lost = [];
  const api = createApi({ key: 'k', fetch: p.fetch, timers, now: () => timers.now, onState: s => states.push(s), onAuthLost: e => lost.push(e.code) });
  p.up = 'hang';
  let err = null;
  const pending = api.status().catch(e => { err = e; });
  await run(timers, STATUS_MS - 100);
  assert.deepEqual([states, statuses(p)], [[], 1], 'still waiting for its answer');
  await run(timers, 100 + PROBE_MS);
  assert.deepEqual([states, statuses(p)], [['waiting'], 2], 'no answer in 10 s, nor to the next call in 5 s: the line');
  p.up = 403;
  await run(timers, BACKOFF_MS[0] + 100);
  await pending;
  assert.ok(err && err.auth && err.code === 'bad-key', 'the tab is old now');
  assert.deepEqual(lost, ['bad-key']);
  const n = p.log.length;
  await run(timers, WAIT_MS);
  assert.equal(p.log.length, n, 'nothing asked after that');
});

test('waiting for the program: sent again after a lost answer, a file that arrived counts as sent and a file dialog is the one open; a preview from the status', async () => {
  const timers = new FakeTimers();
  const seen = { put: 0, pick: 0, preview: 0, list: 0 };
  const p = fakeProgram((url, init, prog) => {
    if (init.method === 'PUT') {
      if (seen.put++ === 0) return new TypeError('Failed to fetch');                         // written, answer lost
      return { status: 409, body: { error: { code: 'drop-exists', params: { path: 'g/a.txt' }, message: 'm' } } };
    }
    if (url === '/api/pick') {
      if (seen.pick++ === 0) return new TypeError('Failed to fetch');                        // the dialog opened
      return { status: 409, body: { error: { code: 'picker-open', params: { purpose: 'files', id: 'p9' }, message: 'm' } } };
    }
    if (url === '/api/preview/start') {
      seen.preview++;
      prog.status = { job: null, preview: { site: 'http://127.0.0.1:5/', pages: [] } };
      return new TypeError('Failed to fetch');
    }
    seen.list++;
    return new TypeError('NotReadableError');                                                   // fails every time
  });
  const api = createApi({ key: 'k', fetch: p.fetch, timers, now: () => timers.now });
  assert.deepEqual(await api.dropPut('d1', 0, 'g/a.txt', { size: 1 }), { ok: true }, 'drop-exists on the second send: the first arrived');
  assert.deepEqual(await api.pick({ purpose: 'files', lang: 'en' }), { open: true, id: 'p9' }, 'waited out with /api/pick/wait');
  assert.deepEqual(await api.previewStart('en'), { site: 'http://127.0.0.1:5/', pages: [] });
  assert.equal(seen.preview, 1, 'a preview start is not sent again when the status shows the preview');
  await assert.rejects(api.list('C:\\x'), e => e.code === 'not-sent' && !e.offline && e.params.error === 'NotReadableError',
    'the program answers, this one fails each time: said after a few sends');
  assert.equal(seen.list, MAX_SENDS);
  const first = new ApiError({ status: 409, code: 'drop-exists', message: 'm' });
  const once = fakeProgram(() => ({ status: 409, body: { error: first.toJSON() } }));
  await assert.rejects(createApi({ key: 'k', fetch: once.fetch, timers }).dropPut('d', 0, 'a', {}), e => e.code === 'drop-exists',
    'a first send that is refused is refused');
});

test('waiting for the program: end() stops the waiting at once, a stop of the caller (Stop sending) too; a followed job survives a wait', async () => {
  const timers = new FakeTimers();
  const p = fakeProgram();
  const api = createApi({ key: 'k', fetch: p.fetch, timers, now: () => timers.now });
  p.up = false;
  const ctrl = new AbortController();
  const put = api.dropPut('d', 0, 'a', {}, { signal: ctrl.signal });
  const ghosts = api.ghosts();
  await run(timers, 100);
  ctrl.abort();
  await assert.rejects(put, e => e.name === 'AbortError', 'Stop sending ends its wait');
  api.end();
  await assert.rejects(ghosts, e => e.offline, 'the page has ended (Quit): the wait ends at once');
  const n = p.log.length;
  await assert.rejects(api.hello(), e => e.offline);
  assert.equal(p.log.length, n + 1, 'no status call after the end');
  assert.equal(timers.queue.length, 0);

  // the poller across a stopped program: its job is still followed
  const t2 = new FakeTimers();
  const q = fakeProgram();
  const api2 = createApi({ key: 'k', fetch: q.fetch, timers: t2, now: () => t2.now });
  const jobs = new Jobs({ api: api2, timers: t2 });
  jobs.start();
  q.status = { job: { id: 'j', kind: 'add', state: 'running', startedAt: 0 }, preview: null };
  const done = jobs.follow({ id: 'j', kind: 'add', state: 'running' });
  await run(t2, 100);
  q.up = false;
  await run(t2, WAIT_MS + RETRY_MS);
  q.status = { job: { id: 'j', kind: 'add', state: 'done', result: { items: [] } }, preview: null };
  q.up = true;
  await run(t2, RETRY_MS + FAST_MS);
  assert.deepEqual((await done).state, 'done', 'the job a stopped program finished meanwhile is still reported');
  jobs.stop();
});

test('waiting for the program: Stop sending ends a drop at once while its calls wait, and nothing is sent after it', async () => {
  const timers = new FakeTimers();
  const w = { roots: [{ n: 0, name: 'g', kind: 'dir', files: [{ rel: 'g/a.txt', file: { size: 1 } }, { rel: 'g/b.txt', file: { size: 1 } }] }] };
  const others = p => p.log.filter(l => l !== 'GET /api/status');
  // stopped while POST /api/drop waits: once the program answers, no file goes and no inspection starts
  const p = fakeProgram(url => (url === '/api/drop' ? { body: { drop: 'd1' } } : { body: { ok: true } }));
  const api = createApi({ key: 'k', fetch: p.fetch, timers, now: () => timers.now });
  p.up = false;
  const ctrl = new AbortController();
  let r1 = null;
  const s1 = sendDrop(api, w, { signal: ctrl.signal }).catch(e => { r1 = e; });
  await run(timers, 1000);
  ctrl.abort();
  await run(timers, 0);
  assert.equal(r1 && r1.name, 'AbortError', 'said at once');
  p.up = true;
  await run(timers, RETRY_MS);
  await s1;
  assert.deepEqual(others(p), ['POST /api/drop'], 'nothing after the stop');
  // stopped while its files wait: said at once, not after the cancel, which goes when the program answers
  const q = fakeProgram((url, init, prog) => {
    if (url === '/api/drop') return { body: { drop: 'd2' } };
    if (init.method === 'PUT') {
      prog.up = false;
      return new TypeError('Failed to fetch');
    }
    return { body: { ok: true } };
  });
  const api2 = createApi({ key: 'k', fetch: q.fetch, timers, now: () => timers.now });
  const ctrl2 = new AbortController();
  let r2 = null;
  const s2 = sendDrop(api2, w, { signal: ctrl2.signal }).catch(e => { r2 = e; });
  await run(timers, 1000);
  ctrl2.abort();
  await run(timers, 0);
  assert.equal(r2 && r2.name, 'AbortError', 'not held up by the cancel');
  q.up = true;
  await run(timers, RETRY_MS + 1000);
  await s2;
  assert.deepEqual(others(q).filter(l => l.startsWith('POST')), ['POST /api/drop', 'POST /api/drop/d2/cancel', 'POST /api/drop/d2/cancel'],
    'the cancel sent again once it answers; no done');
  // stopped while done waits: no inspection is started after it (nor followed)
  const d = fakeProgram((url, init, prog) => {
    if (url === '/api/drop') return { body: { drop: 'd3' } };
    if (url === '/api/drop/d3/done') {
      prog.up = false;
      return new TypeError('Failed to fetch');                                                  // never arrived
    }
    return { body: { ok: true } };
  });
  const api3 = createApi({ key: 'k', fetch: d.fetch, timers, now: () => timers.now });
  const ctrl3 = new AbortController();
  let r3 = null;
  const s3 = sendDrop(api3, w, { signal: ctrl3.signal }).catch(e => { r3 = e; });
  await run(timers, 1000);
  ctrl3.abort();
  await run(timers, 0);
  assert.equal(r3 && r3.name, 'AbortError');
  d.up = true;
  await run(timers, RETRY_MS + 1000);
  await s3;
  assert.equal(others(d).filter(l => l === 'POST /api/drop/d3/done').length, 1, 'not sent again after the stop');
  assert.equal(timers.queue.length, 0);
});

// ---------------------------------------------------------------- the Add plan

const item = (o = {}) => ({ token: 't1', id: 'g', name: 'G', source: { kind: 'folder', path: '/s/g' }, refusal: null,
  conflict: null, runs: { ok: true }, ...o });

test('Add plan: flagged files left out unless ticked, replace only when ticked, refusals and lost balloons block', () => {
  const flagged = item({ refusal: { code: 'compare.unlisted', params: {}, files: [{ path: 'a.txt', code: 'compare.notListed' }, { path: 'b.txt', code: 'compare.differs' }] } });
  const e1 = entryOf(flagged, { key: 1 });
  e1.keep.add('b.txt');
  const conflict = item({ token: 't2', id: 'h', conflict: { path: '/site/ghost/h', lostBalloons: [] } });
  const e2 = entryOf(conflict, { key: 2 });
  const lost = entryOf(item({ token: 't3', conflict: { path: 'x', lostBalloons: [{ dir: 'b', name: 'B' }] } }), { key: 3 });
  const kawari = entryOf(item({ token: 't4', refusal: { code: 'kawari.saveHeader', files: [{ path: 'save.txt', code: 'kawari.runSave' }] } }), { key: 4 });
  const noToken = entryOf(item({ token: null }), { key: 5 });
  const misaka = entryOf(item({ token: 't6', runs: { ok: false, code: 'engine.needs', params: { engine: 'Misaka' } } }), { key: 6 });
  assert.deepEqual([e1, e2, lost, kawari, noToken, misaka].map(e => verdict(e.item).blocked), [false, false, true, true, true, false]);
  assert.deepEqual([e1, e2, lost, kawari, noToken, misaka].map(addable), [true, false, false, false, false, false],
    'a folder the site has waits for "replace"; a ghost Sumika cannot run starts unticked');
  e2.replace = true;
  misaka.include = true;
  assert.deepEqual(planOf([e1, e2, lost, kawari, noToken, misaka]), [
    { token: 't1', replace: false, keep: ['b.txt'], leaveOut: ['a.txt'] },
    { token: 't2', replace: true, keep: [], leaveOut: [] },
    { token: 't6', replace: false, keep: [], leaveOut: [] },
  ]);
  assert.deepEqual(verdict(item({ refusal: { why: 'archive', files: [{ path: 'x' }] } })).flagged.map(f => f.path), ['x'], 'the core\'s older code');
});

test('Add list: a new inspection of the same source replaces its entry in place; results matched by token', () => {
  let key = 0;
  const make = (it, old) => ({ ...entryOf(it, { key: ++key }), old: !!old });
  const a = item({ token: 'ta', source: { kind: 'folder', path: '/s/a' } });
  const b = item({ token: 'tb', source: { kind: 'archive', path: '/s/b.nar', root: '' } });
  let { entries } = mergeItems([], [a, b], make);
  assert.deepEqual(entries.map(e => e.item.token), ['ta', 'tb']);
  const a2 = item({ token: 'ta2', source: { kind: 'folder', path: '/s/a' }, archive: '/s/a.nar' });
  ({ entries } = mergeItems(entries, [a2, item({ token: 'tc', source: { kind: 'folder', path: '/s/c' } })], make));
  assert.deepEqual(entries.map(e => [e.item.token, e.old]), [['ta2', true], ['tb', false], ['tc', false]]);
  const rows = addResults({ items: [
    { token: 'ta2', id: 'a', name: 'A', ok: true, copied: 3 },
    { token: 'tb', id: 'b', name: 'B', ok: false, refusal: { code: 'site.exists', params: { dst: '/x' } } },
  ], index: {}, indexRefusal: null }, entries);
  assert.deepEqual(rows.map(r => [r.entry && r.entry.item.token, r.ok, r.id, r.error ? r.error.code : null]), [['ta2', true, 'a', null], ['tb', false, 'b', 'site.exists']]);
  assert.deepEqual(addResults({ added: [{ id: 'a' }], failed: [{ id: 'b', error: { code: 'x' } }] }, []).map(r => [r.id, r.ok]), [['a', true], ['b', false]]);
  assert.deepEqual(addResults(null, []), []);
});

// ---------------------------------------------------------------- the upload list

test('upload list: everything else, then index.html (the control page), hub.html, sumika.js, ghosts.json last; optional files marked; dev/ never', () => {
  assert.deepEqual([...LAST], [...SERVER_LAST], 'the page groups by the program\'s own order (admin/server/upload.mjs)');
  const g = uploadGroups({
    files: [{ path: '404.html', size: 1 }, { path: 'sumika/index/ghosts.json' }, { path: 'sumika/sumika.js.map', optional: 'map' },
      { path: 'sumika/sumika.js' }, { path: 'sumika/engines/satori.js' }, { path: 'sumika/engines/worker.0123456789.js' },
      { path: 'sumika/hub.html' }, { path: 'sumika/index.html' }, { path: 'sumika/engines/control.0123456789.js' },
      { path: 'dev/x.html' }, 'ghost/a/descript.txt'],
    deleted: ['sumika/engines/worker.old0000000.js'], retired: [], kept: ['x'], ledger: 'C:\\w\\site.published.json',
  });
  assert.deepEqual(g.last.map(e => e.path), [...LAST]);
  assert.deepEqual(g.rest.map(e => [e.path, e.optional]), [['404.html', false], ['sumika/sumika.js.map', true],
    ['sumika/engines/satori.js', true], ['sumika/engines/worker.0123456789.js', false],
    ['sumika/engines/control.0123456789.js', false], ['ghost/a/descript.txt', false]]);
  assert.deepEqual([g.deleted, g.kept, g.ledger], [['sumika/engines/worker.old0000000.js'], ['x'], 'C:\\w\\site.published.json']);
  assert.equal(uploadText(g).split('\n').at(-1), 'sumika/index/ghosts.json');
  assert.deepEqual(['a.js.map', 'sumika/engines/yaya.wasm', 'sumika/engines/yaya.0123456789.wasm', 'sumika/sumika.js'].map(optionalPath),
    [true, true, false, false]);
  assert.deepEqual(uploadGroups({ upload: { rest: ['a'], last: ['sumika/sumika.js'] } }).last.map(e => e.path), ['sumika/sumika.js']);
  assert.equal(g.setAside, null);
  assert.equal(uploadGroups({ files: [], setAside: 'C:\\w\\site.published.json.broken-2026-10-17' }).setAside,
    'C:\\w\\site.published.json.broken-2026-10-17', 'where Start a new record put the unreadable record');
});

test('Prepare upload refused: no record asks whether it is the first upload, one that does not read offers Start a new record, anything else is said as it is', async () => {
  const failed = code => ({ state: 'failed', error: { code, params: {}, message: 'm' } });
  assert.deepEqual(['needs-first', failed('needs-first'), failed('ledger-unreadable'), failed('check-failed'), failed('prune-refused'),
    { state: 'done', result: {} }, null, 'busy'].map(prepareAsks), ['first', 'first', 'newRecord', null, null, null, null, null]);
  // what the page says of it: what the file is and that nothing changed, the one way on, never the command line's flags
  const { findingText } = await import('../../admin/page/strings.js');
  const err = { code: 'ledger-unreadable', params: { ledger: 'C:\\w\\site.published.json', days: 14 }, message: 'm' };
  for (const L of ['en', 'ja']) {
    const text = findingText(err, L);
    assert.ok(text.includes('C:\\w\\site.published.json') && text.includes('14'), text);
    assert.doesNotMatch(text, /--|retire|prune|ledger/i, text);
  }
  assert.match(findingText(err, 'en'), /record of what was uploaded before.*Nothing was changed.*press Start a new record.*nothing is deleted now.*14 more days/);
  // the button by its own name, in both languages (CLAUDE.md "Wording")
  const { t } = await import('../../admin/page/strings.js');
  for (const L of ['en', 'ja']) assert.ok(findingText(err, L).includes(t('prepare.newRecord', L)), L);
  // Start a new record that met a record that reads: said as such, never as the first-upload question's options
  const reads = { code: 'ledger-reads', params: { ledger: 'C:\\w\\site.published.json' }, message: 'm' };
  assert.equal(prepareAsks({ state: 'failed', error: reads }), null);
  for (const L of ['en', 'ja']) {
    const text = findingText(reads, L);
    assert.ok(text.includes('C:\\w\\site.published.json') && text.includes(t('prepare.run', L)), text);
    assert.doesNotMatch(text, /first upload|record lost|初めて|なくなった/, text);
  }
});

test('paths and sizes: joins in the program\'s own form, the ledger beside the site, sizes in the page\'s language', () => {
  assert.deepEqual([joinPath('C:\\', 'x'), joinPath('C:\\a', 'b'), joinPath('/', 'x'), joinPath('/a', 'b'), joinPath('\\\\srv\\share', 'g')],
    ['C:\\x', 'C:\\a\\b', '/x', '/a/b', '\\\\srv\\share\\g']);
  assert.deepEqual([sepOf('D:\\x'), sepOf('/x')], ['\\', '/']);
  assert.deepEqual([baseName('C:\\a\\site'), baseName('/home/u/site/'), baseName('C:\\')], ['site', 'site', 'C:\\']);
  assert.equal(ledgerName('C:\\Users\\a\\mysite'), 'mysite.published.json');
  assert.deepEqual([formatBytes(0, 'en'), formatBytes(1, 'en'), formatBytes(1536, 'en'), formatBytes(12_345_678, 'ja'), formatBytes(512, 'ja')],
    ['0 bytes', '1 byte', '1.5 kB', '12.3 MB', '512 バイト']);
});

// ---------------------------------------------------------------- the bundle

test('the page bundles for a browser: no node: built-in and no </script in it (admin/build.mjs --page inlines it)', async () => {
  const esbuild = await import('esbuild');
  const r = await esbuild.build({
    entryPoints: [path.join(ROOT, 'admin', 'page', 'main.js')], bundle: true, format: 'iife', platform: 'browser',
    target: ['es2020'], write: false, logLevel: 'silent', absWorkingDir: ROOT, metafile: true,
  });
  const js = r.outputFiles[0].text;
  assert.doesNotMatch(js, /<\/script/i);
  assert.doesNotMatch(js, /\brequire\(|import\.meta/);
  const inputs = Object.keys(r.metafile.inputs);
  assert.ok(inputs.includes('admin/core/rules.mjs') && inputs.includes('admin/core/py.mjs'), 'the core\'s own skip rules and their fnmatch');
  assert.ok(!inputs.some(i => /admin\/core\/(add|archive|index|tree|text|check|staging)\.mjs|admin\/server\/(?!hubentry|outcome)/.test(i)),
    `only the page-safe modules of the core and the program: ${inputs.filter(i => i.startsWith('admin/') && !i.startsWith('admin/page/'))}`);
});

test('hub rows: every row problem reads without a placeholder left, with or without the Sumika host typed', async () => {
  const { findingText } = await import('../../admin/page/strings.js');
  const rows = ['https://a.example.com', 'http://b.example.com', 'https://a.example.com/page.html', 'https://*.example.com',
    'a.example.com', 'https://a.example.com', 'https://x:y@a.example.com', 'https://a.example.com/?q', 'http://localhost:8644'];
  for (const scheme of ['https:', null]) {
    const codes = rowProblems(rows, { scheme }).filter(Boolean);
    assert.ok(codes.length >= 6, `problems found (${scheme})`);
    if (scheme) assert.ok(codes.includes('scheme') && codes.includes('duplicate'));
    for (const code of codes) {
      for (const lang of ['en', 'ja']) {
        const text = findingText(rowFinding(code, { scheme }), lang);
        assert.ok(text && !/[{}]/.test(text), `${code} (${lang}, ${scheme}): ${text}`);
      }
    }
  }
  assert.equal(rowFinding(null), null);
  assert.ok(findingText(rowFinding('scheme', { scheme: 'https:' }), 'en').includes('https:'));
});

test('a cut-off job\'s notice: what happened, whether the site changed, the one thing to do, ghosts by name', async () => {
  const { interruptedNotice } = await import('../../admin/page/interrupted.js');
  const { settles } = await import('../../admin/server/outcome.mjs');
  const pit = { kind: 'inspect', label: 'pit', startedAt: 1, step: null, outcome: 'unchanged', ghosts: [] };
  assert.deepEqual(interruptedNotice(pit, 'en'), {
    text: 'Last time sumika-admin closed while it was still reading what you had picked to add (pit). Nothing on your site was changed: to go on, pick it again.',
    action: { key: 'job.interrupted.dismiss', run: 'dismiss' },
  }, 'an inspect cut off before it finished');
  assert.match(interruptedNotice(pit, 'ja').text, /^前回、追加のために選んだもの（pit）を読み込んでいる途中で sumika-admin が終了しました。サイトは何も変更されていません。/);
  const two = { kind: 'add', label: 'ピット, B', outcome: 'index', ghosts: [{ id: 'pit', name: 'ピット', placed: true }, { id: 'b', name: 'B', placed: false }] };
  assert.deepEqual(interruptedNotice(two, 'en'), {
    text: 'Last time sumika-admin closed while adding ピット, B. The files of ピット are in place, but the index (the site\'s list of ghosts) was not updated yet. Not added (add again later): B.',
    action: { key: 'job.interrupted.finishAdd', run: 'index' },
  });
  assert.match(interruptedNotice(two, 'ja').text, /ピット のファイルは配置済みですが、.*追加されなかったゴースト（後でもう一度追加してください）：B。$/);
  const addNone = { ...two, outcome: 'unchanged', ghosts: two.ghosts.map(g => ({ ...g, placed: false })) };
  assert.match(interruptedNotice(addNone, 'en').text, /while adding ピット, B, before it had put anything in place, so nothing on your site was changed\. To go on/,
    'a replace cut off in its copy: the old version is still in place, so "nothing changed" (not "no ghost in place")');
  const rm = { kind: 'remove', label: 'Emily', outcome: 'index', ghosts: [{ id: 'emily4', name: 'Emily', placed: true }] };
  assert.deepEqual(interruptedNotice(rm, 'en').action, { key: 'job.interrupted.finishRemove', run: 'index' });
  assert.match(interruptedNotice(rm, 'en').text, /while removing Emily\. Its folder is deleted, but the index .* was not updated yet\.$/);
  assert.match(interruptedNotice({ ...rm, outcome: 'unchanged' }, 'en').text, /folder was still in place, so nothing on your site was changed/);
  assert.deepEqual(interruptedNotice({ kind: 'index', label: '', outcome: 'index' }, 'en').action, { key: 'job.interrupted.runIndex', run: 'index' });
  assert.deepEqual(interruptedNotice({ kind: 'prepare', label: '', outcome: 'prepare' }, 'ja').action, { key: 'job.interrupted.prepareAgain', run: 'prepare' });
  const old = { kind: 'add', label: 'Emily', outcome: 'unknown', ghosts: [] };
  assert.deepEqual(interruptedNotice(old, 'en'), {
    text: 'Last time sumika-admin closed before it finished this: Adding ghosts (Emily). It cannot tell how far it got, so your site may be partly changed. Press Check the site to see what is left to fix.',
    action: { key: 'job.interrupted.checkSite', run: 'check' },
  }, 'an older start\'s journal, or a site that cannot be read now');
  assert.match(interruptedNotice({ kind: null, label: '', outcome: 'unknown' }, 'en').text, /before it finished what it was doing, and it cannot tell what that was/,
    'a journal naming no job: no "Working" for its name');
  // Dismiss stays dismissed in this tab (a reload); another cut-off job's notice shows; storage off: this page only
  const { wasDismissed, rememberDismissed } = await import('../../admin/page/interrupted.js');
  const store = new Map();
  const win = { sessionStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } };
  assert.equal(wasDismissed(win, pit), false);
  rememberDismissed(win, pit);
  assert.equal(wasDismissed(win, { ...pit }), true, 'the same cut-off job after a reload');
  assert.equal(wasDismissed(win, { ...pit, startedAt: 2 }), false, 'the next one');
  const denied = { get sessionStorage() { throw new Error('denied'); } };
  rememberDismissed(denied, pit);
  assert.equal(wasDismissed(denied, pit), false);
  // what happened, whether the site changed, and the thing to do, in plain words: no inner term of the program
  for (const it of [pit, two, addNone, rm, old, { ...rm, outcome: 'unchanged' }, { kind: 'index', outcome: 'index' }, { kind: 'prepare', outcome: 'prepare' }]) {
    assert.doesNotMatch(interruptedNotice(it, 'en').text, /\b(job|journal|worker|token|drop|API)s?\b/i, it.kind);
  }
  for (const it of [pit, two, addNone, rm, old, { kind: null, label: '', outcome: 'unknown' }]) {
    for (const L of ['en', 'ja']) assert.doesNotMatch(interruptedNotice(it, L).text, /[{}]|undefined/, `${it.kind} ${L}`);
  }
  // the notice goes when a job settles it: any job for 'unchanged', else one that does what the outcome names
  assert.equal(settles(pit, { kind: 'check', state: 'running' }), true);
  assert.equal(settles(two, { kind: 'inspect', state: 'done' }), false);
  assert.equal(settles(two, { kind: 'add', state: 'done', result: { index: null } }), false, 'an add that indexed nothing');
  assert.equal(settles(two, { kind: 'add', state: 'done', result: { index: {} } }), true);
  assert.equal(settles(two, { kind: 'index', state: 'failed' }), false);
  assert.equal(settles(two, { kind: 'index', state: 'done' }), true);
  assert.equal(settles({ outcome: 'prepare' }, { kind: 'check', state: 'done' }), false);
  assert.equal(settles({ outcome: 'prepare' }, { kind: 'prepare', state: 'done' }), true);
  assert.equal(settles(old, { kind: 'check', state: 'done' }), true);
  assert.equal(settles(null, { kind: 'check', state: 'done' }), false);
});

// ---------------------------------------------------------------- the system's file dialogs (picker.js)

/** The pick calls of the API client, answered from a script: each answer an object or an ApiError to throw. */
function pickApi(answers) {
  const calls = [];
  const next = async (name, arg) => {
    calls.push([name, arg]);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, pick: o => next('pick', o), pickWait: id => next('wait', id), pickCancel: () => next('cancel') };
}

test('dialogs: the purpose and the page\'s language go to /api/pick; {open} is waited out with /api/pick/wait; the buttons wait meanwhile', async () => {
  const api = pickApi([{ open: true, id: 'p1' }, { open: true, id: 'p1' }, { paths: ['C:\\dl\\a.nar', 'C:\\dl\\b.zip'] }]);
  const seen = [];
  let lang = 'ja';
  const p = new Picker({ api, lang: () => lang, available: true, onChange: () => seen.push([p.open, p.busy]) });
  const entry = { key: 7 };
  const r = await p.pick('compare', { near: 'C:\\ghosts', owner: entry });
  assert.deepEqual(r, { paths: ['C:\\dl\\a.nar', 'C:\\dl\\b.zip'] });
  assert.deepEqual(api.calls, [['pick', { purpose: 'compare', lang: 'ja', near: 'C:\\ghosts' }], ['wait', 'p1'], ['wait', 'p1']]);
  assert.deepEqual(seen, [['compare', true], [null, false]], 'open while it waits, then closed');
  assert.equal(p.owner, null);
  lang = 'en';
  const api2 = pickApi([{ canceled: true }, { paths: [] }]);
  const q = new Picker({ api: api2, lang: () => lang, available: true });
  assert.deepEqual(await q.pick('files'), { canceled: true });
  assert.deepEqual(api2.calls[0], ['pick', { purpose: 'files', lang: 'en' }], 'no near: none sent');
  assert.deepEqual(await q.pick('site'), { canceled: true }, 'nothing chosen is a cancel');
});

test('dialogs: none in the program (hello, or no-picker) is the in-page browser; picker-open is a dialog elsewhere, which Cancel closes', async () => {
  const off = new Picker({ api: pickApi([]), lang: () => 'en', available: false });
  assert.deepEqual(await off.pick('files'), { fallback: true, problem: null }, 'hello said picker: false');
  const noPicker = new ApiError({ status: 501, code: 'no-picker', params: { error: 'CoCreateInstance failed' }, message: 'm' });
  const p = new Picker({ api: pickApi([noPicker]), lang: () => 'en', available: true });
  const r = await p.pick('folders');
  assert.equal(r.fallback, true);
  assert.deepEqual(r.problem, { code: 'no-picker', params: { error: 'CoCreateInstance failed' }, message: 'm' });
  assert.equal(p.available, false, 'from now on the in-page browser');
  assert.deepEqual(await p.pick('files'), { fallback: true, problem: r.problem });

  const busy = new ApiError({ status: 409, code: 'picker-open', params: { purpose: 'site' }, message: 'm' });
  const api = pickApi([busy, { ok: true, open: true }]);
  const changes = [];
  const q = new Picker({ api, lang: () => 'en', available: true, onChange: () => changes.push(q.elsewhere) });
  assert.deepEqual(await q.pick('files'), { elsewhere: true });
  assert.ok(q.elsewhere && q.busy, 'its line and Cancel show; the buttons wait');
  assert.deepEqual(await q.pick('files'), { elsewhere: true }, 'no second request while one is open');
  await q.cancel();
  assert.ok(!q.busy);
  assert.deepEqual(api.calls.map(c => c[0]), ['pick', 'cancel']);
  assert.deepEqual(changes, [false, true, false]);

  const gone = new ApiError({ status: 0, code: 'offline', message: 'Failed to fetch' });
  const s = new Picker({ api: pickApi([gone, gone]), lang: () => 'en', available: true });
  await assert.rejects(s.pick('site'), e => e.offline, 'a stopped program is the page\'s to say');
  assert.ok(!s.busy && s.available);
  await s.cancel();
  const bad = new ApiError({ status: 400, code: 'bad-request', message: 'm' });
  await assert.rejects(new Picker({ api: pickApi([bad]), lang: () => 'en', available: true }).pick('x'), e => e.code === 'bad-request');
});

test('dialogs: one open elsewhere (the 409 names it) is waited on, so its closing frees the buttons without Cancel', async () => {
  const until = async ok => { for (let i = 0; i < 50 && !ok(); i++) await new Promise(r => setImmediate(r)); };
  const open = id => new ApiError({ status: 409, code: 'picker-open', params: { purpose: 'files', id }, message: 'm' });
  // another tab's dialog: still open at the first wait, then answered there
  const api = pickApi([open('d1'), { open: true, id: 'd1' }, { paths: ['/dl/a.nar'] }]);
  const changes = [];
  const q = new Picker({ api, lang: () => 'en', available: true, onChange: () => changes.push(q.elsewhere) });
  assert.deepEqual(await q.pick('folders'), { elsewhere: true });
  assert.ok(q.busy, 'its line and Cancel show while it is open');
  await until(() => !q.elsewhere);
  assert.ok(!q.busy, 'closed there: the buttons are free again');
  assert.deepEqual(api.calls.map(c => c[0]), ['pick', 'wait', 'wait']);
  assert.deepEqual(api.calls.slice(1).map(c => c[1]), ['d1', 'd1']);
  assert.deepEqual(changes, [false, true, false]);
  // the other dialog failed: no dialog from now on, as after this page's own no-picker
  const noPicker = new ApiError({ status: 501, code: 'no-picker', params: { error: 'Show failed' }, message: 'm' });
  const f = new Picker({ api: pickApi([open('d2'), noPicker]), lang: () => 'en', available: true });
  await f.pick('files');
  await until(() => !f.elsewhere);
  assert.deepEqual([f.busy, f.available, f.problem.code], [false, false, 'no-picker']);
  // a stopped program while watching: dead() says it, the line stays as it was
  const gone = new ApiError({ status: 0, code: 'offline', message: 'Failed to fetch' });
  const s = new Picker({ api: pickApi([open('d3'), gone]), lang: () => 'en', available: true });
  await s.pick('files');
  await until(() => s.api.calls.length >= 2);
  await settle();
  assert.ok(s.elsewhere && s.available);
});

test('dialogs: one hello or status names (a reload while it is open) shows its line and Cancel at once and is waited out', async () => {
  const until = async ok => { for (let i = 0; i < 50 && !ok(); i++) await new Promise(r => setImmediate(r)); };
  const api = pickApi([{ open: true, id: 'd1' }, { paths: ['/dl/a.nar'] }]);
  const changes = [];
  const q = new Picker({ api, lang: () => 'en', available: true, onChange: () => changes.push(q.elsewhere) });
  q.seen({ id: 'd1', purpose: 'files' });
  assert.ok(q.busy && q.elsewhere, 'before any button is pressed');
  q.seen({ id: 'd1', purpose: 'files' });
  await until(() => !q.elsewhere);
  assert.deepEqual(api.calls, [['wait', 'd1'], ['wait', 'd1']], 'one wait at a time, also when the next status names it again');
  assert.deepEqual(changes, [true, false]);
  // this page's own dialog, while it waits for it: nothing more
  const own = pickApi([{ open: true, id: 'p1' }, { canceled: true }]);
  const p = new Picker({ api: own, lang: () => 'en', available: true });
  const picking = p.pick('folders');
  p.seen({ id: 'p1', purpose: 'folders' });
  p.seen(null);
  assert.equal(p.elsewhere, false);
  assert.deepEqual(await picking, { canceled: true });
  assert.deepEqual(own.calls.map(c => c[0]), ['pick', 'wait']);
});

test('jobs: status\'s pick and starting reach onChange; polled every second while the start settles what was left', async () => {
  const timers = new FakeTimers();
  const answers = [];
  let polls = 0;
  const api = { status: async () => { polls++; return answers.shift() || { job: null, preview: null, pick: null, starting: false }; } };
  const seen = [];
  const jobs = new Jobs({ api, timers, onChange: s => seen.push([s.pick, s.starting]) });
  jobs.update({ job: null, preview: null, pick: { id: 'd1', purpose: 'site' }, starting: true });
  jobs.start();
  answers.push({ job: null, preview: null, pick: null, starting: true });
  await timers.advance(FAST_MS);
  await settle();
  assert.equal(polls, 1, 'starting: every second');
  await timers.advance(FAST_MS);
  await settle();
  assert.equal(polls, 2);
  await timers.advance(FAST_MS);
  await settle();
  assert.equal(polls, 2, 'done starting: every 10 s again');
  assert.deepEqual(seen, [[{ id: 'd1', purpose: 'site' }, true], [null, true], [null, false]]);
  jobs.update({ job: null });
  assert.deepEqual(seen.at(-1), [undefined, false], 'an answer that does not say: undefined');
  jobs.stop();
});

test('wording: one thing to do per notice (the site folder that is no site, a page that could not start); an unknown cut-off job', async () => {
  const { failedText } = await import('../../admin/page/main.js');
  const { siteErrorText } = await import('../../admin/page/screens/site.js');
  const { interruptedNotice } = await import('../../admin/page/interrupted.js');
  const count = (s, re) => (s.match(re) || []).length;
  const notSite = { code: 'not-a-site', params: { path: 'C:\\x' }, message: 'm' };
  assert.equal(siteErrorText(notSite, 'en'), 'The site folder in the settings cannot be used now. C:\\x is not a Sumika site folder: it has no '
    + 'sumika/sumika.js and sumika/build.json. Choose the folder that holds the sumika folder.');
  assert.equal(count(siteErrorText(notSite, 'ja'), /選んでください/g), 1);
  const missing = { code: 'path-missing', params: { path: 'D:\\site' }, message: 'm' };
  assert.match(siteErrorText(missing, 'en'), /D:\\site\b.*Choose it again, or another one\.$/, 'a folder that is gone: choose it again');
  // the path text ends with the path: it gets its own sentence end, so the path never runs into what follows
  assert.match(siteErrorText(missing, 'en'), /: D:\\site\. Choose it again/);
  assert.match(siteErrorText(missing, 'ja'), /：D:\\site。もう一度選ぶか/);
  assert.equal(count(siteErrorText({ code: 'path-no-access', params: { path: 'D:\\site', error: 'EPERM' } }, 'en'), /\.\./g), 0, 'no second period');
  // the project's own site/ in a dev run: choosing it again cannot work, so its own end
  const project = { code: 'project-site', params: { path: 'C:\\sumika\\site' }, message: 'm' };
  assert.equal(siteErrorText(project, 'en'), 'The site folder in the settings cannot be used now: C:\\sumika\\site is the Sumika '
    + 'project\'s own site folder, or inside it: a development run never changes it. Choose another site folder, such as a '
    + 'copy of it outside the project.');
  assert.doesNotMatch(siteErrorText(project, 'en'), /choose it again/i);
  assert.doesNotMatch(siteErrorText(project, 'ja'), /もう一度選ぶ/);
  assert.equal(count(siteErrorText(project, 'ja'), /選んでください/g), 1);
  const internal = { code: 'internal', params: { error: 'boom' }, message: 'm' };
  for (const L of ['en', 'ja']) {
    const text = failedText(internal, L);
    assert.ok(text.includes('boom'), text);
    assert.equal(count(text, L === 'en' ? /try again/gi : /もう一度試して/g), 1, text);
    // the settings' site folder met an unexpected error: its own "try again", no "choose it again" after it
    const site = siteErrorText(internal, L);
    assert.ok(site.includes('boom'), site);
    assert.equal(count(site, L === 'en' ? /try again|choose it again/gi : /もう一度/g), 1, site);
  }
  assert.equal(count(failedText({ code: 'not-sent', params: { error: 'Failed to fetch' } }, 'en'), /try again/gi), 1);
  assert.equal(failedText({ code: 'not-found', message: 'm' }, 'en'), 'sumika-admin could not open this page: sumika-admin has no such address. Reload the page to try again.');
  // a journal naming a job this page does not know, with a label: the unknown-kind text, never "Working (label)"
  const odd = interruptedNotice({ kind: 'frobnicate', label: 'Emily', outcome: 'unknown', ghosts: [] }, 'en');
  assert.match(odd.text, /cannot tell what that was/);
  assert.doesNotMatch(odd.text, /Working/);
  assert.deepEqual(odd.action, { key: 'job.interrupted.checkSite', run: 'check' });
  assert.doesNotMatch(interruptedNotice({ kind: 'drop', label: 'x', outcome: 'unknown' }, 'ja').text, /処理（x）/);
});

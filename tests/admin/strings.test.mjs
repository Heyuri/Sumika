// The admin page's strings (CLAUDE.md "Wording"): its table passes the runtime's table check (tests/strings_check.mjs),
// every key the template and the page's code name exists (and every key of the table is used), every code the admin
// core exports (admin/core/codes.mjs CODE_LIST) and the program exports (admin/server/codes.mjs CODE_LIST, once it
// exists) has its `code.<code>` text, a core code's text uses only the parameters the core gives it, and the console
// and preview-page keys the program prints exist in both languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkStringTables, paramsOf } from '../strings_check.mjs';
import {
  STRINGS, SAME_IN_JA, PROPER_NOUNS, PARAMS, LANGS, DERIVED_PARAMS, t, plural, template, findingText, findingParams,
  joinList, has,
} from '../../admin/page/strings.js';
import { ENTRY_CODES } from '../../admin/page/hub.js';
import { AUTH_CODES } from '../../admin/page/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = path.join(ROOT, 'admin', 'page');

/** Every .js file of the page, recursively. */
function pageFiles(dir = PAGE) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...pageFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// the table's key families: a dotted literal starting with one of these in the page's code is a key
const FAMILIES = ['app', 'nav', 'lang', 'boot', 'common', 'status', 'job', 'phase', 'site', 'settings', 'browser',
  'ghosts', 'remove', 'add', 'drop', 'sharing', 'check', 'prepare', 'preview', 'console'];
const KEYLIKE = new RegExp(`^(?:${FAMILIES.join('|')})\\.[A-Za-z0-9.-]+$`);
// keys the code builds at run time (`browser.place.${kind}`, `phase.${p}`, `job.${kind}`, `sharing.${state}`)
const DYNAMIC = [
  ...['home', 'desktop', 'downloads', 'volumes', 'program'].map(k => `browser.place.${k}`),
  ...['extract', 'compare', 'copy', 'index', 'remove', 'inspect', 'check', 'prune', 'list', 'settle'].map(k => `phase.${k}`),
  ...['inspect', 'add', 'remove', 'index', 'check', 'prepare', 'drop', 'other'].map(k => `job.${k}`),
  'sharing.saved', 'sharing.savedEmpty', 'sharing.fixFirst',
];
// what the program prints from this table (the console lines, the preview's test page)
const PROGRAM_KEYS = ['console.version', 'console.open', 'console.stop', 'console.already', 'console.failed',
  'console.enter', 'console.stopped', 'console.idle', 'preview.page.title', 'preview.page.intro', 'preview.page.link'];
// codes the program answers with (the 403s, busy, needs-first, a hub.json entry's)
const PROGRAM_CODES = ['no-key', 'bad-key', 'bad-host', 'bad-origin', 'busy', 'needs-first', 'not-string', 'wildcard',
  'not-absolute', 'not-http', 'userinfo', 'query-or-fragment', 'has-path', 'loopback'];
// the page's own codes and the parts of a code's text
const PAGE_CODES = ['offline', 'not-sent', 'job-replaced', 'scheme', 'duplicate', 'note.compared.kept',
  'note.undeleteMask.hits', 'note.undeleteMask.none', 'bundle-stale.file', 'job-crashed.exit', 'no-picker.exit'];

/** Keys the page's code names as literals: t('…'), tNodes('…'), 'data-t': '…', ['…', {…}], plural bases. */
function codeKeys() {
  const keys = new Set();
  const bases = new Set();
  for (const file of pageFiles()) {
    if (path.basename(file) === 'strings.js') continue;               // the table itself names every key
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bplural\(\s*'([^']+)'/g)) bases.add(m[1]);
    // every single-quoted literal, empty ones too (else '' : t('…') pairs the wrong quotes)
    for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) if (KEYLIKE.test(m[1])) keys.add(m[1]);
  }
  for (const b of bases) {
    keys.delete(b);
    keys.add(`${b}.one`).add(`${b}.many`);
  }
  return { keys, bases };
}

/** Keys the template names: data-t, data-t-aria-label, data-t-title, data-t-placeholder. */
function templateKeys() {
  const html = fs.readFileSync(path.join(PAGE, 'index.html'), 'utf8');
  return [...html.matchAll(/\bdata-t(?:-[a-z-]+)?="([^"]+)"/g)].map(m => m[1]);
}

/** A module of the admin tree, or null while it is not there (the port and the program are written alongside). */
async function optional(...rel) {
  const file = path.join(ROOT, ...rel);
  if (!fs.existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

/** admin/core/codes.mjs (CODE_LIST, CODES), or null while the port has not written it. */
const coreCodes = () => optional('admin', 'core', 'codes.mjs');

/** admin/server/codes.mjs, or null until the program has one. */
const serverModule = () => optional('admin', 'server', 'codes.mjs');

/** The program's code list (admin/server/codes.mjs CODE_LIST), or null until the program has one. */
async function serverCodes() {
  const mod = await serverModule();
  if (!mod) return null;
  const list = mod.CODE_LIST || mod.SERVER_CODES || (mod.CODES && Object.keys(mod.CODES));
  assert.ok(Array.isArray(list) || (list && typeof list[Symbol.iterator] === 'function'),
    'admin/server/codes.mjs exports CODE_LIST: every code the program sends');
  return [...list];
}

/** The keys the program looks up in this table (admin/server/say.mjs STRING_KEYS), else the list here. */
async function programKeys() {
  const m = await optional('admin', 'server', 'say.mjs');
  return m && Array.isArray(m.STRING_KEYS) ? [...m.STRING_KEYS] : PROGRAM_KEYS;
}

/**
 * The page's texts of `list`'s codes that name a parameter the code's English text (CODES[code], read with a
 * recording stand-in) never reads: the sender does not give it. PARAMS and the page's derived parameters are fine.
 */
function strayParams(codes, list) {
  const bad = [];
  for (const code of list) {
    if (!has(`code.${code}`) || typeof codes[code] !== 'function') continue;
    const seen = new Set();
    const params = new Proxy({}, {
      get(target, k) {
        if (typeof k !== 'string') return undefined;
        seen.add(k);
        // a nested code (the core's id.bad `problem`) must be a real one; lists are joined; anything else is a word
        return k === 'problem' ? list.find(c => c.startsWith('name.')) || 'x' : ['x'];
      },
      has: () => true,
    });
    try {
      codes[code](params, []);
    } catch (e) {
      bad.push(`${code}: its English text could not be read with a stand-in (${e.message})`);
      continue;
    }
    const ok = new Set([...seen, ...Object.keys(PARAMS), ...(DERIVED_PARAMS[code] || [])]);
    for (const L of LANGS) {
      for (const p of paramsOf(template(`code.${code}`, L))) if (!ok.has(p)) bad.push(`${code} (${L}): {${p}} is no parameter it is given`);
    }
  }
  return bad;
}

// ---------------------------------------------------------------- the table

test('table: the runtime\'s check (same keys and {parameters}, translated, no English left in Japanese)', () => {
  checkStringTables(STRINGS, { sameInJa: SAME_IN_JA, properNouns: PROPER_NOUNS, mnemonic: null });
  assert.deepEqual(LANGS, ['ja', 'en'], 'SSP\'s Language ▸ order');
  assert.deepEqual([t('lang.ja', 'en'), t('lang.en', 'ja')], ['日本語', 'English'], 'each language in its own words');
  for (const k of PROPER_NOUNS) assert.match(k, /^[A-Za-z]+$/, `${k}: a name`);
});

test('the shared check catches what it should (a missing key, a parameter, English left, untranslated, no Japanese)', () => {
  const base = { en: { a: 'Hello {name}' }, ja: { a: 'こんにちは {name}' } };
  checkStringTables(base);
  assert.throws(() => checkStringTables({ en: { a: 'x', b: 'y' }, ja: { a: 'エックス' } }), /the same keys/);
  assert.throws(() => checkStringTables({ en: { a: 'Hi {name}' }, ja: { a: 'やあ {nom}' } }), /parameters/);
  assert.throws(() => checkStringTables({ en: { a: 'Open file' }, ja: { a: 'file を開く' } }), /English in it/);
  assert.throws(() => checkStringTables({ en: { a: 'OK' }, ja: { a: 'OK' } }), /translated/);
  assert.throws(() => checkStringTables({ en: { a: 'Go' }, ja: { a: '-> ' } }), /Japanese text/);
  checkStringTables({ en: { a: 'OK' }, ja: { a: 'OK' } }, { sameInJa: ['a'] });
  checkStringTables({ en: { a: 'About Sumika' }, ja: { a: 'Sumikaについて' } }, { properNouns: ['Sumika'] });
  checkStringTables({ en: { a: '&Quit' }, ja: { a: '終了(&Q)' } }, { mnemonic: /[(（]&[A-Z]\)/g });
  assert.throws(() => checkStringTables({ en: { a: '&Quit' }, ja: { a: '終了(&QU)' } }, { mnemonic: /[(（]&[A-Z]\)/g }),
    /English in it/, 'only what the pattern names is taken out');
  assert.deepEqual(paramsOf('{b} and {a} and {b}'), ['a', 'b', 'b']);
});

test('t(): parameters, then the fixed names; unknown language and key fall back; plural; lists', () => {
  assert.equal(t('console.stop', 'ja'), 'このウィンドウを閉じると sumika-admin は終了します。', 'the console line');
  assert.equal(t('console.stop', 'en'), 'Close this window to stop sumika-admin.');
  assert.equal(t('remove.text', 'en', { name: 'Emily', id: 'emily4', folder: 'ghost/emily4/' }),
    'Remove Emily (emily4)? Its folder ghost/emily4/ is deleted.');
  assert.equal(t('sharing.noHub', 'fr'), t('sharing.noHub', 'en'), 'an unknown language: English');
  assert.equal(t('no.such.key', 'ja'), 'no.such.key');
  assert.equal(t('remove.done', 'en', { name: 'X' }), 'Removed X ({id}).', 'a missing parameter stays visible');
  assert.equal(t('code.not-absolute', 'en', { example: 'https://b.example.org' }), 'Not a full address (for example https://b.example.org).',
    'the caller\'s value beats the fixed one');
  assert.equal(template('remove.done', 'ja'), '{name}（{id}）を削除しました。');
  assert.deepEqual([plural('add.add', 1, 'en'), plural('add.add', 3, 'en'), plural('add.add', 3, 'ja')],
    ['Add 1 ghost', 'Add 3 ghosts', 'ゴーストを3体追加']);
  assert.deepEqual([joinList(['a', 'b'], 'en'), joinList(['a', 'b'], 'ja')], ['a, b', 'a、b']);
  for (const k of Object.keys(PARAMS)) assert.match(PARAMS[k], /\S/, k);
});

test('findingText: a code in either language, nested codes and lists, the English message for an unknown code', () => {
  assert.equal(findingText({ code: 'engine.needs', params: { engine: 'YAYA' } }, 'ja'), 'YAYAが必要');
  assert.equal(findingText({ code: 'source.missing', params: { path: 'C:\\x' }, message: 'C:\\x: no such file or folder' }, 'en'),
    'C:\\x: no such file or folder.');
  assert.equal(findingText({ code: 'id.bad', params: { id: 'a/b', problem: 'name.separator' } }, 'en'),
    'The site folder name a/b cannot be used: it must be one folder name (no / or \\).', 'a nested code is translated');
  assert.equal(findingText({ code: 'note.undeleteMask', params: { names: ['save.txt', 'x.dat'], hits: [] } }, 'en'),
    'install.txt lists files a refresh install keeps (refreshundeletemask, often the saves): save.txt, x.dat. None of them will be copied.');
  assert.match(findingText({ code: 'note.undeleteMask', params: { names: ['a'], hits: ['ghost/master/a'] } }, 'ja'),
    /これらはコピーされるので.*ghost\/master\/a/);
  assert.equal(findingText({ code: 'note.compared', params: { count: 12, archiveName: 'x.nar', kept: 0 } }, 'en'),
    '12 files, all in x.nar with the same contents.');
  assert.equal(findingText({ code: 'note.compared', params: { count: 12, archiveName: 'x.nar', kept: 2 } }, 'en'),
    '12 files, all in x.nar with the same contents or kept by you (2).');
  assert.equal(findingText({ code: 'some.future', message: 'English from the program' }, 'ja'), 'English from the program');
  assert.equal(findingText({ path: 'a.log', code: 'some.future', why: 'an engine log, in English' }, 'ja'), 'an engine log, in English',
    'a left-out file\'s English reason');
  assert.equal(findingText({ why: 'personal.log' }, 'ja'), 'エンジンのログ', 'a refusal\'s older {why: code}');
  assert.equal(findingText('busy', 'en'), 'sumika-admin is busy (Working): wait until that has finished, then try again.');
  assert.equal(findingText({ code: 'busy', params: { kind: 'add' } }, 'ja'), 'sumika-admin は今、別の処理（ゴーストの追加）をしています。終わってから、もう一度試してください。');
  assert.equal(findingText({ code: 'read-only', params: { reason: 'index-format', format: 1, expected: 2 } }, 'en'),
    'This sumika-admin cannot change this site, so nothing was changed. It was made with another version of Sumika: its index is format 1, and this sumika-admin writes format 2.');
  assert.equal(findingText({ code: 'bundle-stale', params: {} }, 'en'),
    'sumika/sumika.js is not the build sumika/build.json describes: the runtime build did not finish.');
  assert.equal(findingText({ code: 'bundle-stale', params: { file: 'engines/worker.1.js' } }, 'ja'),
    'sumika/sumika.js は sumika/build.json の示すビルドではありません（engines/worker.1.js を指していません）。ランタイムのビルドが終わっていません。');
  assert.equal(findingText({ code: 'job-crashed', params: {} }, 'en'),
    'It stopped because of an unexpected error, so it may be only partly done. Check the site to see what is left to fix.');
  assert.match(findingText({ code: 'job-crashed', params: { error: 'x' } }, 'ja'), /^予期しないエラーで止まりました（x）。/);
  // a part of the program that ended without an answer: its code in plain words (the log names the part)
  assert.equal(findingText({ code: 'job-crashed', params: { exit: 1 } }, 'en'),
    'It stopped because of an unexpected error (code 1), so it may be only partly done. Check the site to see what is left to fix.');
  assert.match(findingText({ code: 'job-crashed', params: { exit: 0 } }, 'ja'), /^予期しないエラーで止まりました（コード 0）。/);
  assert.equal(findingText({ code: 'no-picker', params: { exit: 3 } }, 'en'),
    'sumika-admin could not open a file window on this computer (code 3). Pick in this page instead.');
  assert.equal(findingText({ code: 'bad-request', params: { detail: 'id' } }, 'ja'), '要求が正しくありません（id）。');
  assert.equal(findingText(null), '');
  assert.deepEqual(findingParams('x', { list: ['a', 'b'], n: 2 }, 'ja'), { list: 'a、b', n: 2 });
});

test('Kawari save files: a folder\'s refusal says plainly that the ghost is added only from its .nar / .zip, and why; the archive\'s note lists what it keeps; no developers\' line', () => {
  const refusal = { code: 'kawari.saveHeader', params: { label: 'C:\\SSP\\ghost\\k', archive: null, archiveName: null },
    files: [{ path: 'ghost/master/runonce.txt', code: 'kawari.runSave', line: '(\'ghost/master/runonce.txt\', 0x1),    # k.nar' }] };
  assert.equal(findingText(refusal, 'en'), 'This Kawari ghost can only be added from its .nar / .zip file, not from the folder '
    + 'C:\\SSP\\ghost\\k. Files that start like Kawari\'s save files may keep what a user told the ghost when they come from a '
    + 'folder, but in its archive they are the author\'s starting files. The folder has these:');
  assert.equal(findingText(refusal, 'ja'), 'この華和梨のゴーストは、フォルダ C:\\SSP\\ghost\\k からではなく、.nar / .zip ファイルからしか'
    + '追加できません。華和梨のセーブファイルと同じ形で始まるファイルは、フォルダの中ではユーザーがゴーストに教えた内容を記録しているかもしれ'
    + 'ませんが、アーカイブの中では作者が用意した最初のファイルです。このフォルダにあるもの：');
  for (const L of LANGS) {
    assert.doesNotMatch(findingText(refusal, L), /KAWARI_SHIPPED_SAVES|PERSONAL_PATHS|index_site|rules\.mjs|0x/, L);
  }
  const kept = { code: 'note.kawariKept', params: { paths: ['ghost/master/Dict-KEEPSs.txt', 'ghost/master/runonce.txt'] } };
  assert.equal(findingText(kept, 'en'), 'Copied as they are: ghost/master/Dict-KEEPSs.txt, ghost/master/runonce.txt. They '
    + 'start like Kawari\'s save files, but in the ghost\'s archive they are the author\'s starting files.');
  assert.equal(findingText(kept, 'ja'), 'そのままコピーするもの：ghost/master/Dict-KEEPSs.txt、ghost/master/runonce.txt。華和梨のセーブ'
    + 'ファイルと同じ形で始まりますが、ゴーストのアーカイブの中では作者が用意した最初のファイルです。');
  assert.equal(has('add.item.devLine'), false, 'the KAWARI_SHIPPED_SAVES line is the CLI\'s');
  const add = fs.readFileSync(path.join(PAGE, 'screens', 'add.js'), 'utf8');
  assert.doesNotMatch(add, /\.line\b/, 'the Add screen shows no refusal file\'s developers\' line');
});

test('the Kawari record that does not read: what the file is, that it cannot be read and why, what to do, in plain words', () => {
  const f = problem => ({ code: 'kawari.record', params: { problem }, message: 'm' });
  assert.equal(findingText(f('record.json'), 'en'), 'sumika/kawari-shipped.json cannot be read: it is not valid JSON. It is '
    + 'the list of Kawari files that the ghosts\' own archives ship, which Sumika keeps beside the index. While it cannot '
    + 'be read, no ghost is added or removed and the index is not updated, so nothing was changed. Repair it, or delete it '
    + 'and add those Kawari ghosts again from their .nar / .zip files.');
  for (const L of LANGS) {
    for (const problem of ['record.open', 'record.json', 'record.format', 'record.entries']) {
      const text = findingText(f(problem), L);
      assert.ok(text.includes(t(`code.${problem}`, L)), `${L} ${problem}: the reason, translated`);
      assert.doesNotMatch(text, /KAWARI|CRC|index_site|stopped|\{/, `${L}: no developers' word, no parameter left`);
    }
  }
  assert.match(findingText(f('record.entries'), 'ja'), /^sumika\/kawari-shipped\.json を読み込めません（ファイル名とチェックサムの組になっていない項目があります）。/);
});

test('the control page has one name on the Sharing and the Preview screen and in Check, in both languages (Wording)', () => {
  for (const L of LANGS) {
    const name = t('sharing.control', L).replace(/[:：]\s*$/, '').toLowerCase();
    assert.ok(t('preview.openControl', L).toLowerCase().includes(name), `${L}: "${name}" in the Preview's link`);
    assert.ok(findingText({ code: 'control-html', params: {} }, L).toLowerCase().includes(name), `${L}: "${name}" in Check's finding`);
    assert.match(t('sharing.noControl', L), /sumika\/index\.html/, `${L}: the file named`);
  }
  // the select's three texts, and what each of the two that are not the default does
  assert.deepEqual(['shown', 'tucked', 'off'].map(k => t(`sharing.default.${k}`, 'en')), ['Shown', 'Tucked as her button', 'Off']);
  assert.match(t('sharing.defaultHint.off', 'en'), /page above/, 'Off: until the visitor turns Sumika on there');
});

// ---------------------------------------------------------------- keys in use

test('every key the template and the page\'s code name exists; every key of the table is used', async () => {
  const missing = [];
  for (const k of templateKeys()) if (!has(k)) missing.push(`index.html: ${k}`);
  const { keys } = codeKeys();
  for (const k of keys) if (!has(k)) missing.push(`admin/page: ${k}`);
  for (const k of DYNAMIC) if (!has(k)) missing.push(`built at run time: ${k}`);
  assert.deepEqual(missing, []);
  const used = new Set([...templateKeys(), ...keys, ...DYNAMIC, ...PROGRAM_KEYS, ...await programKeys()]);
  const unused = Object.keys(STRINGS.en).filter(k => !k.startsWith('code.') && !used.has(k));
  assert.deepEqual(unused, [], 'keys no code names (drop them, or name them in this test when the program uses them)');
});

test('the program\'s console lines and the preview\'s test page exist in both languages (admin/server/say.mjs)', async () => {
  const keys = await programKeys();
  for (const k of new Set([...PROGRAM_KEYS, ...keys])) {
    assert.ok(has(k), k);
    for (const L of LANGS) assert.ok(t(k, L).trim(), `${k} (${L})`);
  }
  assert.equal(t('console.open', 'en', { url: 'http://127.0.0.1:1/?key=k' }), 'Open this address in your browser: http://127.0.0.1:1/?key=k');
  assert.equal(t('preview.page.link', 'ja', { other: 'http://127.0.0.1:2' }), 'http://127.0.0.1:2 の同じページへ移動：ゴーストは続きから再開するはずです。');
});

// ---------------------------------------------------------------- codes

test('every code the admin core exports has its text in both languages (admin/core/codes.mjs CODE_LIST)', async t2 => {
  const core = await coreCodes();
  if (!core) {
    t2.diagnostic('admin/core/codes.mjs is not there yet: nothing to check');
    return;
  }
  assert.ok(Array.isArray(core.CODE_LIST) && core.CODE_LIST.length, 'CODE_LIST');
  const missing = core.CODE_LIST.filter(c => !has(`code.${c}`));
  assert.deepEqual(missing, [], 'codes without a page text (add code.<code> to admin/page/strings.js)');
});

test('a code\'s text uses only parameters its sender gives (the core\'s and the program\'s English texts, read with a stand-in)', async t2 => {
  const core = await coreCodes();
  const server = await serverModule();
  if (!core && !server) {
    t2.diagnostic('neither admin/core/codes.mjs nor admin/server/codes.mjs is there yet: nothing to check');
    return;
  }
  const bad = [];
  if (core && core.CODES) bad.push(...strayParams(core.CODES, core.CODE_LIST));
  if (server && server.CODES) bad.push(...strayParams(server.CODES, server.CODE_LIST || Object.keys(server.CODES)));
  assert.deepEqual(bad, []);
});

test('every code of the program has its text (admin/server/codes.mjs)', async t2 => {
  for (const c of [...PROGRAM_CODES, ...PAGE_CODES, ...AUTH_CODES, ...ENTRY_CODES]) assert.ok(has(`code.${c}`), c);
  const list = await serverCodes();
  if (!list) {
    t2.diagnostic('admin/server/codes.mjs is missing: only the codes listed here are checked');
    return;
  }
  const missing = list.filter(c => !has(`code.${c}`));
  assert.deepEqual(missing, [], 'program codes without a page text (add code.<code> to admin/page/strings.js)');
});

test('every code key of the table belongs to the core, the program or the page', async t2 => {
  const core = await coreCodes();
  if (!core) {
    t2.diagnostic('admin/core/codes.mjs is not there yet: nothing to compare with');
    return;
  }
  const known = new Set([...core.CODE_LIST, ...PROGRAM_CODES, ...PAGE_CODES, ...((await serverCodes()) || [])]);
  const stray = Object.keys(STRINGS.en).filter(k => k.startsWith('code.') && !known.has(k.slice(5)));
  assert.deepEqual(stray, [], 'texts of codes nobody sends any more');
});

// The word variables %ms %mz %ml %mc %mh %mt %me %mp %m? %dms (and a %m that ends the script), as ssp.exe 2.9.10's
// SPGhost::GetWord (properties.md §2.4): the ghost asked first (GET, ID \ms, kind 'word'), \m? again as \m, then SSP's
// word list (src/core/words.js: its parser and pick, the site's copy site/sumika/word_compatible.txt, the Site's loader).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWordList, pickWord, loadWordList, WORD_FILE } from '../../src/core/words.js';
import { decodeText } from '../../src/core/loader.js';
import { EventLoop } from '../../src/core/events.js';
import { Site } from '../../src/core/site.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';
import { needs } from '../needs.mjs';

setLogLevel('silent');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE_COPY = path.join(root, 'site', ...WORD_FILE.split('/'));
const sspList = () => parseWordList(decodeText(fs.readFileSync(SITE_COPY)));
/** a random() that returns these numbers in turn */
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test('the site\'s copy of SSP\'s data/word_compatible.txt, read by SPCompatibleWord::Load\'s rules: 9 sections, comments and the charset line skipped, ends trimmed', needs('site/sumika/word_compatible.txt'), () => {
  const list = sspList();
  assert.deepEqual(list.map(s => [s.name, s.words.length]), [
    ['ms', 21], ['mz', 11], ['mc', 17], ['mh', 6], ['mt', 5], ['me', 14], ['ml', 2], ['mp', 29], ['dms', 14],
  ]);
  const all = list.flatMap(s => s.words);
  assert.ok(!all.some(w => w.startsWith('//') || /^charset,/i.test(w) || w !== w.trim()), 'no comment, charset line or untrimmed word');
  assert.equal(list[0].words[0], '鈴木一郎');
  assert.equal(list[2].words[0], '日刊工業新聞社', 'its trailing space trimmed');
  assert.deepEqual(list[6].words, ['仲間', '人類']);
  assert.equal(list[8].words[5], '%msが企画したとんでもない%m?ゲーム', '\\dms words hold variables of their own');
});

test('parseWordList: whole lines, spaces and tabs trimmed (not full-width ones), // lines, words before the first *, sections merged in any case', () => {
  const text = [
    'lost before any section', '*ms', '  a word  ', '\tb\t', '  // a comment', 'c // not one', '　full　', '',
    'CHARSET,UTF-8', 'x,y', '*mz', 'z', '*MS', 'more', '*', 'nameless',
  ].join('\r\n') + '\rlone-cr\nlone-lf';
  assert.deepEqual(parseWordList(text), [
    { name: 'ms', words: ['a word', 'b', 'c // not one', '　full　', 'x,y', 'more'] },
    { name: 'mz', words: ['z'] },
    { name: '', words: ['nameless', 'lone-cr', 'lone-lf'] },
  ]);
  assert.deepEqual(parseWordList(''), []);
  assert.deepEqual(parseWordList(null), []);
});

test('pickWord: the type without its backslash, any case; \\m? picks a section first, \\dms among them; none: null', () => {
  const list = parseWordList('*ms\r\na\r\nb\r\nc\r\n*dms\r\n%msの影\r\n*empty');
  assert.equal(pickWord(list, '\\ms', seq(0)), 'a');
  assert.equal(pickWord(list, '\\ms', seq(0.5)), 'b');
  assert.equal(pickWord(list, '\\MS', seq(0.9999999)), 'c', 'any case');
  assert.equal(pickWord(list, 'ms', seq(0)), 'a', 'no backslash: the same');
  assert.equal(pickWord(list, '\\m?', seq(0.2, 0.99)), 'c', 'section ms, then its last word');
  assert.equal(pickWord(list, '\\m?', seq(0.5, 0)), '%msの影', 'section dms');
  assert.equal(pickWord(list, '\\M?', seq(0, 0)), 'a');
  assert.equal(pickWord(list, '\\m?', seq(0.9, 0)), null, 'the empty section: no word (ssp.exe would divide by zero)');
  assert.equal(pickWord(list, '\\empty', seq(0)), null);
  assert.equal(pickWord(list, '\\mz', seq(0)), null, 'no such section');
  assert.equal(pickWord(list, '\\m', seq(0)), null);
  assert.equal(pickWord([], '\\ms'), null);
  assert.equal(pickWord(null, '\\ms'), null);
  assert.equal(pickWord(list, '\\ms', () => 1), 'c', 'a random() of 1 stays in range');
});

test('loadWordList: the site\'s sumika/word_compatible.txt through the given fetch, decoded as ghost text; none without a fetch, a base or the file', needs('site/sumika/word_compatible.txt'), async () => {
  const urls = [];
  const bytes = fs.readFileSync(SITE_COPY);
  const ok = async url => { urls.push(url); return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; };
  const list = await loadWordList('http://s/sub/', ok);
  assert.deepEqual(urls, ['http://s/sub/sumika/word_compatible.txt']);
  assert.deepEqual(list, sspList());
  // without a charset line: code page 932, as a ghost's text
  const sjis = Uint8Array.from([0x2a, 0x6d, 0x73, 0x0d, 0x0a, 0x83, 0x5c, 0x95, 0x5c]);   // *ms / ソ表
  assert.deepEqual(await loadWordList('http://s/', async () => ({ ok: true, arrayBuffer: async () => sjis.buffer })),
    [{ name: 'ms', words: ['ソ表'] }]);
  assert.equal(await loadWordList('http://s/', async () => ({ ok: false, status: 404 })), null);
  assert.equal(await loadWordList('http://s/', async () => { throw new Error('offline'); }), null);
  assert.equal(await loadWordList('http://s/', null), null);
  assert.equal(await loadWordList('', ok), null);
});

test('Site.compatibleWords: read once per page through the window\'s fetch; null without a window (Node, the sweep)', needs('site/sumika/word_compatible.txt'), async () => {
  assert.equal(typeof globalThis.window, 'undefined');
  const bare = new Site({ base: 'http://s/', Channel: null, lead: false, maxGhosts: 1 });
  assert.equal(await bare.compatibleWords(), null, 'no window: nothing fetched');
  const urls = [];
  const bytes = fs.readFileSync(SITE_COPY);
  globalThis.window = {
    fetch: async url => { urls.push(url); return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; },
  };
  try {
    const site = new Site({ base: 'http://s/', Channel: null, lead: false, maxGhosts: 1 });
    const [a, b] = await Promise.all([site.compatibleWords(), site.compatibleWords()]);
    assert.equal(a, b);
    assert.equal(a.length, 9);
    await site.compatibleWords();
    assert.deepEqual(urls, ['http://s/sumika/word_compatible.txt'], 'one fetch for the page');
  } finally {
    delete globalThis.window;
  }
});

const GHOST = { id: 'g', name: 'G', sakuraName: 'Gee', keroName: '', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };

/** A booted loop over a FakeShiori whose requests also record the call's kind. */
async function booted({ handler = () => null, wordList, random, peers = null } = {}) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const kinds = [];
  const request = shiori.request.bind(shiori);
  shiori.request = r => { kinds.push([r.id, r.kind || '']); return request(r); };
  const player = new FakePlayer();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost: GHOST,
    state: new StateStore(GHOST.id, { storage: memoryStorage(), clock }), clock, env: { win: null, doc: null },
    ghostDescript: new Map([['name', 'G'], ['sakura.name', 'Gee']]), site: { ghosts: [GHOST], balloons: [] },
    wordList, random, peers,
  });
  await loop.boot({ resume: false });
  shiori.log.length = 0;
  kinds.length = 0;
  return { loop, shiori, player, kinds };
}

test('a word the ghost answers: GET with ID \\ms, no References, kind word; 200 / 311 / 312, Value else Word; not cached', async () => {
  let n = 0;
  const t = await booted({
    handler: r => {
      if (r.id === '\\ms') return `ms${++n}`;
      if (r.id === '\\mz') return { status: 311, headers: { Word: 'w\\z' } };
      if (r.id === '\\mc') return { status: 312, value: 'v', headers: { Word: 'x' } };
      if (r.id === '\\mh') return { status: 404, value: 'no' };
      if (r.id === '\\mt') return { status: 200, value: '', headers: { Word: 'x' } };
      return null;
    },
  });
  const s = await t.loop.expand('[%ms][%ms][%mz][%mc][%mh][%mt]');
  assert.equal(s, '[ms1][ms2][w\\z][v][%mh][%mt]', 'each variable asks again; a backslash is not doubled; an empty Value is no word');
  // pass 1 changed the text, so pass 2 asks the two left as written once more
  assert.deepEqual(t.shiori.log.map(r => [r.method, r.id, r.refs]), [
    ['GET', '\\ms', []], ['GET', '\\ms', []], ['GET', '\\mz', []], ['GET', '\\mc', []], ['GET', '\\mh', []], ['GET', '\\mt', []],
    ['GET', '\\mh', []], ['GET', '\\mt', []],
  ]);
  assert.ok(t.kinds.every(([, kind]) => kind === 'word'), JSON.stringify(t.kinds));
  t.loop.destroy();
});

test('\\m? is asked again as \\m; then SSP\'s list (\\m? from any section); no list: the variable stays as written', async () => {
  const answers = { '\\m': 'any' };
  const t = await booted({ handler: r => answers[r.id] ?? null });
  assert.equal(await t.loop.expand('<%m?>'), '<any>');
  assert.deepEqual(t.shiori.log.map(r => r.id), ['\\m?', '\\m']);
  delete answers['\\m'];
  t.shiori.log.length = 0;
  assert.equal(await t.loop.expand('<%m?><%ms><%dms>'), '<%m?><%ms><%dms>', 'no word anywhere');
  assert.deepEqual(t.shiori.log.map(r => r.id), ['\\m?', '\\m', '\\ms', '\\dms'], 'one pass: nothing changed');
  t.loop.destroy();

  const list = parseWordList('*ms\r\n鈴木\r\n*me\r\nりんご\r\n*dms\r\n%msの影');
  const u = await booted({ wordList: async () => list, random: seq(0) });
  assert.equal(await u.loop.expand('[%ms][%me投げ][%m?][%ml]'), '[鈴木][りんご投げ][鈴木][%ml]', 'no section ml: as written');
  assert.deepEqual(u.shiori.log.map(r => r.id), ['\\ms', '\\me', '\\m?', '\\m', '\\ml', '\\ml'], '%ml again in pass 2');
  u.loop.destroy();
});

test('a word with a variable in it is expanded as ssp.exe rescans: inside the value from its 2nd character, else on the next pass', async () => {
  const list = parseWordList('*ms\r\n鈴木\r\n*dms\r\n%msの影\r\nこの%msの影');
  let pick = 0;
  const t = await booted({ wordList: async () => list, random: () => [0.5, 0.9, 0.1, 0.1][pick++ % 4] });
  // \dms → この%msの影 (index 1): its %ms after the 1st character goes in the same pass
  const s = await t.loop.expand('%dms!');
  assert.equal(s, 'この鈴木の影!');
  // \dms → %msの影 (index 0): the leading %ms waits for pass 2
  t.loop.random = seq(0);
  t.shiori.log.length = 0;
  assert.equal(await t.loop.expand('%dms'), '鈴木の影');
  assert.deepEqual(t.shiori.log.map(r => r.id), ['\\dms', '\\ms']);
  t.loop.destroy();
});

test('a %m that ends the script asks \\m (ssp.exe\'s wcschr finds the terminating NUL); elsewhere %m is text', async () => {
  const t = await booted({ handler: r => (r.id === '\\m' ? 'M' : null) });
  assert.equal(await t.loop.expand('a%m'), 'aM');
  assert.equal(await t.loop.expand('%m b'), '%m b');
  assert.equal(await t.loop.expand('%mx'), '%mx');
  assert.deepEqual(t.shiori.log.map(r => r.id), ['\\m']);
  t.loop.destroy();
});

test('a word reply is never a COMMUNICATE (ssp.exe reads it with ParseGenericHeaders only)', async () => {
  const peers = { others: () => [], count: () => 1, busy: () => false, match: () => ['other'] };
  const t = await booted({ handler: r => (r.id === '\\ms' ? { status: 200, value: 'w', headers: { To: 'Other', Reference0: 'Other' } } : null), peers });
  assert.equal(await t.loop.expand('%ms'), 'w');
  assert.equal(t.loop._comm, null);
  t.loop.destroy();
});

test('a script plays with its words: the reply\'s %me from the list, before OnTranslate (the ghost sees the expanded text)', async () => {
  const list = parseWordList('*me\r\nりんご');
  const t = await booted({ handler: r => (r.id === 'OnTalk' ? '\\0%me投げ\\e' : null), wordList: async () => list });
  await t.loop.send('OnTalk');
  await settle();
  assert.equal(t.player.last.script, '\\0りんご投げ\\e');
  assert.deepEqual(t.shiori.log.map(r => r.id), ['OnTalk', '\\me', 'OnTranslate']);
  assert.equal(t.shiori.find('OnTranslate')[0].refs[0], '\\0りんご投げ\\e');
  t.loop.destroy();
});

test('a word list that fails to load counts as none', async () => {
  const t = await booted({ wordList: async () => { throw new Error('boom'); } });
  assert.equal(await t.loop.expand('%ms'), '%ms');
  t.loop.destroy();
});

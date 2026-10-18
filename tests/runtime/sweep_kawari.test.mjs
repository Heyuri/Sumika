// The ghost sweep's Kawari parts (tools/sweep/kawari.mjs, docs/research/ghost-sweep.md; kawari-wasm.md §6, §15): the
// worker's file plan for a Kawari ghost, Kawari's log lines as one key, and the resume check's reading of full
// dictionary dumps and of a stored snapshot, its sorting of the entries that differ after a resume, and D6's outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KAWARI_TEXT, kawariFilePlan, kawariLogText, joinLiterals, parseKawariDump, snapshotNames, parseK7Dump, k7SnapshotNames,
  classifyResume, d6Outcome,
} from '../../tools/sweep/kawari.mjs';
import { KAWARI7_TEXT } from '../../src/core/engine-files.js';

test('the Kawari file plan: text with bytes (.kis and .kaw too), the rest placeholders, personal files and DLLs skipped', () => {
  const files = { files: [
    { path: 'ghost/master/kawarirc.kis', size: 900 },
    { path: 'ghost/master/dict-crypt.kaw', size: 400 },
    { path: 'ghost/master/descript.txt', size: 300 },
    { path: 'ghost/master/big.txt', size: 5 * 1024 * 1024 },
    { path: 'shell/master/surface0.png', size: 1000 },
    { path: 'ghost/master/shiori.dll', size: 268800 },
    { path: 'ghost/master/saori/bln.exe', size: 10 },
    { path: 'ghost/master/kawari.log', size: 10 },
    { path: 'ghost/master/satori_savedata.txt', size: 10 },
    { path: 'profile/ghost.dat', size: 10 },
    { path: 'install.txt', size: 50 },
  ] };
  assert.deepEqual(kawariFilePlan(files), {
    bytes: ['ghost/master/kawarirc.kis', 'ghost/master/dict-crypt.kaw', 'ghost/master/descript.txt', 'install.txt'],
    placeholders: ['ghost/master/big.txt', 'shell/master/surface0.png'],
  });
  // = index_site.py KAWARI_PACK_EXT
  assert.ok(KAWARI_TEXT.test('a/B.KIS') && KAWARI_TEXT.test('x.kaw') && KAWARI_TEXT.test('updates2.dau') && !KAWARI_TEXT.test('x.png'));
});

test("Kawari's log lines: the lexer's file and line dropped, the ghost's MEMFS folder as <id>", () => {
  assert.equal(kawariLogText("/ssp/ghost/kuro_r/ghost/master/ghost-keeps.kis 53: error: ')' not found. runaway script?"),
    "')' not found. runaway script?");
  assert.equal(kawariLogText('/ssp/ghost/x/ghost/master/a b.kis 7: warning: blank definition.'), 'blank definition.');
  assert.equal(kawariLogText('load : load failed/ssp/ghost/machi_1.0/ghost/master/dict-keeps-savedata.txt'),
    'load : load failed/ssp/ghost/<id>/ghost/master/dict-keeps-savedata.txt');
});

test('adjacent string literals are joined, an escaped quote is not a boundary', () => {
  assert.equal(joinLiterals('"a""b"'), '"ab"');
  assert.equal(joinLiterals('"a""b""c" , "d"'), '"abc" , "d"');
  assert.equal(joinLiterals('"x\\\\""y"'), '"x\\\\y"');        // \\ then the boundary
  assert.equal(joinLiterals('"x\\""'), '"x\\""');              // \" then the closing quote
  assert.equal(joinLiterals('plain , $(a)'), 'plain , $(a)');
});

test('a full dump: entries by name, moved names under their own, comment lines skipped', () => {
  const text = [
    '#', '# Sumika resume snapshot: …', '#',
    '# clear count', '# clear 名前', '# clear odd name', '# move 1 odd name',
    'count : 3', '名前 : "a""b" , c', 'System.Sumika.Snapshot.1 : x', 'empty : ', '',
  ].join('\n');
  const d = parseKawariDump(text);
  assert.deepEqual([...d.entries()], [['count', '3'], ['名前', '"ab" , c'], ['odd name', 'x'], ['empty', '']]);
  assert.equal(parseKawariDump('').size, 0);
});

test("a stored snapshot's entries: its # clear lines, in code page 932", () => {
  const head = new TextEncoder().encode('# dicStamp 0123abcd\n#\n# clear count\n# clear ');
  const name = Uint8Array.of(0x83, 0x65, 0x83, 0x58, 0x83, 0x67);       // テスト in code page 932
  const tail = new TextEncoder().encode('\r\ncount : 3\n');
  const bytes = new Uint8Array(head.length + name.length + tail.length);
  bytes.set(head);
  bytes.set(name, head.length);
  bytes.set(tail, head.length + name.length);
  assert.deepEqual([...snapshotNames(bytes.buffer)], ['count', 'テスト']);
  assert.equal(snapshotNames(new ArrayBuffer(0)).size, 0);        // the empty marker
  assert.equal(snapshotNames(null).size, 0);
});

test('the entries that differ after a resume: in the snapshot, missed by it, or set by load', () => {
  const m = o => new Map(Object.entries(o));
  // counter: saved 5, came back 4; clock: load's value, the next load's differs; guarded: the session write-protected
  // it (absent from the dump), the snapshot left it out; added: a new entry that came back; same: untouched
  const base = m({ counter: '1', clock: '100', guarded: 'a , b', same: 'x', gone: 'y' });
  const before = m({ counter: '5', clock: '100', same: 'x', gone: 'y', added: 'z' });
  const after = m({ counter: '4', clock: '160', guarded: 'a , b', same: 'x', added: 'z' });
  const r = classifyResume({ base, before, after, names: new Set(['counter', 'added']) });
  // gone: as load made it, and the next load does not make it
  assert.deepEqual(r, { changed: ['counter'], missed: ['guarded'], loadSet: ['clock', 'gone'] });
  const ok = classifyResume({ base, before, after: before, names: new Set() });
  assert.deepEqual(ok, { changed: [], missed: [], loadSet: [] });
});

test("D6's outcome: ok when the session's own close and unload saved it, no effect when they save nothing (somberlain, maria_re), nothing to finish without a snapshot", () => {
  const run = o => d6Outcome({ booted: true, finish: true, resumed: 'finished', saves: ['ghost/master/dict-keeps-savedata.txt'], differ: [], ...o });
  assert.equal(run({}), 'ok');
  assert.equal(run({ saves: [] }), 'no effect', 'somberlain: neither its close events nor its OnUnload write a file (as in SSP)');
  assert.equal(run({ finish: false, resumed: '', saves: [] }), 'nothing to finish');
  assert.equal(run({ differ: ['ghost/master/dict-keeps-savedata.txt'] }), 'failed', 'wrote other values than the session');
  assert.equal(run({ resumed: '' }), 'failed', 'D6 did not run');
  assert.equal(run({ finish: false }), 'failed', 'D6 ran without a snapshot');
  assert.equal(run({ booted: false }), 'failed');
});

test('Kawari 7: the file plan by KAWARI7_TEXT (.kdf and .dat dictionaries with bytes); dumps and snapshots in K7SNAP form', () => {
  const files = { files: [
    { path: 'ghost/master/kawari.ini', size: 500 },
    { path: 'ghost/master/dictionary/base.kdf', size: 2800 },
    { path: 'ghost/master/maze.dat', size: 52000 },
    { path: 'ghost/master/shiori.dll', size: 133120 },
  ] };
  assert.deepEqual(kawariFilePlan(files, KAWARI7_TEXT), {
    bytes: ['ghost/master/kawari.ini', 'ghost/master/dictionary/base.kdf', 'ghost/master/maze.dat'], placeholders: [],
  });
  assert.deepEqual(kawariFilePlan(files).placeholders, ['ghost/master/dictionary/base.kdf', 'ghost/master/maze.dat'], 'Phase 8\'s rule');
  // the file as em_kawari7.cpp writes it: a backslash doubled, a newline as \n
  const text = String.raw`# dicStamp 0123abcd
K7SNAP 1
E param1
W "こんばんわ"",""\\0\\s[5]\\e"
E two
W "a"
W "b\nc"
C gone
E empty
`;
  assert.deepEqual([...parseK7Dump(text)], [
    ['param1', String.raw`"こんばんわ,\0\s[5]\e"`], ['two', '"a"\n"b\nc"'], ['gone', ''], ['empty', ''],
  ], 'adjacent literals joined, as Phase 8; escapes undone');
  const sj = new Uint8Array([...'K7SNAP 1\nE a\nW "1"\nC b\n'].map(c => c.charCodeAt(0)));
  assert.deepEqual([...k7SnapshotNames(sj)], ['a', 'b']);
  assert.deepEqual([...k7SnapshotNames(new Uint8Array(0))], []);
  assert.deepEqual([...k7SnapshotNames(null)], []);
});

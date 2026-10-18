// The admin core (admin/core/, CLAUDE.md "The admin tool") against its Python twins and on its own: the constants it
// shares with tools/index_site.py and tools/add_ghost.py, and the Python semantics it reproduces (str.strip and
// splitlines, fnmatch, repr, json.dumps, read_text / read_descript / descript_last, zip_name, cp932 on every 1- and
// 2-byte sequence, Kawari's save header, SSP's thumbnail extensions and name order, the skip rules, archive_index)
// checked by running Python on the same cases; then the archive guards, inspectSource's items, codes, progress, a
// removal that never follows a junction, checkSite and the CLI's statuses. Runs Python (`python -I -B`; PYTHON names
// another interpreter): no Python is a failure. Everything on scratch folders in the OS temp folder.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pyStrip, pySplitlines, fnmatchcase, pyRepr, dumps, cmpPy, sortedPy } from '../../admin/core/py.mjs';
import { decodeCp932, readTextFile, readDescript, descriptLast, zipName } from '../../admin/core/text.mjs';
import * as R from '../../admin/core/rules.mjs';
import { archiveIndex, extractGhost } from '../../admin/core/archive.mjs';
import { thumbnailExtOk, indexSite, personalFiles } from '../../admin/core/index.mjs';
import { readShipped, shippedBytes, setShipped } from '../../admin/core/shipped.mjs';
import { crc32 } from '../../tools/sweep/zip.mjs';
import {
  inspectSource, addGhost, removeGhost, checkSite, recoverWork, AdminRefusal, CODE_LIST, CODES, message,
} from '../../admin/core/api.mjs';
import { compareNames } from '../../src/core/shells.js';
import { YAYA_TEXT, KAWARI_TEXT, KAWARI7_TEXT } from '../../src/core/engine-files.js';
import { run as cli } from '../../admin/cli.mjs';
import { makeZip, UNIX_LINK } from './zipmake.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.env.PYTHON || 'python';
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'ghost');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-core-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ch = (...cps) => String.fromCodePoint(...cps);
const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};

// ---- the Python side, once ----

const PY_SCRIPT = [
  'import json, os, sys, fnmatch, zipfile',
  'sys.path.insert(0, sys.argv[1])',
  'import index_site as I, add_ghost as A',
  'c = json.load(open(sys.argv[2], encoding="utf-8"))',
  'o = {}',
  'o["consts"] = dict(FORMAT=I.FORMAT, NAME_HASH=I.NAME_HASH, VERSION_HASH=I.VERSION_HASH,',
  '  PERSONAL_DIRS=sorted(I.PERSONAL_DIRS), PERSONAL_FILES=list(I.PERSONAL_FILES), PERSONAL_PATHS=list(I.PERSONAL_PATHS),',
  '  KAWARI_ENGINES=list(I.KAWARI_ENGINES), KAWARI_SHIPPED_SAVES=[list(x) for x in I.KAWARI_SHIPPED_SAVES],',
  '  KAWARI_RECORD=I.KAWARI_RECORD, KAWARI_RECORD_PROBLEMS=I.KAWARI_RECORD_PROBLEMS,',
  '  PACK_EXT=list(I.PACK_EXT), PACK_SKIP=list(I.PACK_SKIP), PACK_MAX=I.PACK_MAX, DEFAULT_BALLOON=I.DEFAULT_BALLOON,',
  '  ROOT_PACK_EXT={k: [v.pattern, bool(v.flags & 2)] for k, v in I.ROOT_PACK_EXT.items()},',
  '  THUMB_EXT=sorted(I.THUMB_EXT), THUMB_EXT_PREFIX=list(I.THUMB_EXT_PREFIX),',
  '  SKIP_FILES=list(A.SKIP_FILES), SKIP_DIRS=sorted(A.SKIP_DIRS), ALWAYS_LISTED=[A.ALWAYS_LISTED.pattern, bool(A.ALWAYS_LISTED.flags & 2)])',
  'o["strip"] = [s.strip() for s in c["strings"]]',
  'o["splitlines"] = [s.splitlines() for s in c["strings"]]',
  'o["repr"] = [repr(s) for s in c["strings"]]',
  'o["fnmatch"] = [fnmatch.fnmatchcase(n, p) for n, p in c["fnmatch"]]',
  'o["dumps"] = [json.dumps(v, ensure_ascii=False, separators=(",", ":")) for v in c["values"]]',
  'o["dumps1"] = [json.dumps(v, ensure_ascii=False, indent=1) for v in c["values"]]',
  'o["read_text"] = [I.read_text(p) for p in c["files"]]',
  'o["read_descript"] = [list(I.read_descript(p).items()) for p in c["files"]]',
  'o["descript_last"] = [I.descript_last(p, ("icon", "iconfilename")) for p in c["files"]]',
  'def zn(h, f):',
  '  raw = bytes.fromhex(h); i = zipfile.ZipInfo(); i.flag_bits = f',
  '  try: i.orig_filename = raw.decode("utf-8") if f & 0x800 else raw.decode("cp437")',
  '  except UnicodeDecodeError: return None',
  '  return A.zip_name(i)',
  'o["zip_name"] = [zn(h, f) for h, f in c["zipnames"]]',
  'o["kawari_head"] = [I.KAWARI_SAVE_HEAD.match(bytes.fromhex(h)) is not None for h in c["heads"]]',
  'def rb(r):',
  '  b = I.kawari_record_bytes({g: [tuple(e) for e in v] for g, v in r})',
  '  return None if b is None else b.decode("utf-8")',
  'o["record_bytes"] = [rb(r) for r in c["records"]]',
  'def rr(s):',
  '  try: return sorted([g, [list(e) for e in v]] for g, v in I.read_kawari_record(s).items())',
  '  except I.KawariRecordError as e: return {"problem": e.problem, "message": str(e)}',
  'o["record_read"] = [rr(s) for s in c["record_sites"]]',
  // a write whose rename or write fails deletes its temporary file; one that does not read is never written over
  'def failed_write(s):',
  '  real = I.os.replace',
  '  def refuse(a, b): raise PermissionError(13, "refused")',
  '  I.os.replace = refuse',
  '  try: I.set_kawari_record(s, "g", [("ghost/master/x.txt", 1)])',
  '  except PermissionError: pass',
  '  finally: I.os.replace = real',
  '  return sorted(os.listdir(os.path.join(s, "sumika")))',
  'class Refusing:',
  '  def __init__(self, f): self.f = f',
  '  def __enter__(self): return self',
  '  def __exit__(self, *a): self.f.close()',
  '  def write(self, b): raise PermissionError(13, "refused")',
  'def failed_bytes(s):',
  '  def fake(p, mode="r", *a, **k):',
  '    f = open(p, mode, *a, **k)',
  '    return Refusing(f) if mode == "xb" else f',
  '  I.open = fake',          // index_site's own global, before the builtin: the temporary file's write refuses
  '  try: I.set_kawari_record(s, "g", [("ghost/master/x.txt", 1)])',
  '  except PermissionError: pass',
  '  finally: del I.open',
  '  return sorted(os.listdir(os.path.join(s, "sumika")))',
  'o["record_failed_write"] = [failed_write(c["record_write_site"]), failed_bytes(c["record_bytes_site"])]',
  'def over_bad(s):',
  '  try: I.set_kawari_record(s, "g", [])',
  '  except I.KawariRecordError as e: return e.problem',
  'o["record_over_bad"] = over_bad(c["record_bad_site"])',
  'o["thumb"] = [I.thumbnail_ext_ok(n) for n in c["thumbs"]]',
  'o["compare_names"] = [I.compare_names(a, b) for a, b in c["names"]]',
  'o["skip_file"] = [A.skip_file(p) for p in c["rels"]]',
  'o["is_personal"] = [[I.is_personal(p, False), I.is_personal(p, True)] for p in c["rels"]]',
  'o["archive_index"] = [{k: [list(e) for e in v] for k, v in A.archive_index(p).items()} for p in c["lists"]]',
  'cp = {}',
  'for a in range(256):',
  '  cp["%02x" % a] = bytes([a]).decode("cp932", "replace")',
  '  for b in range(256): cp["%02x%02x" % (a, b)] = bytes([a, b]).decode("cp932", "replace")',
  'for h in c["cp932"]: cp[h] = bytes.fromhex(h).decode("cp932", "replace")',
  'o["cp932"] = cp',
  'sys.stdout.write(json.dumps(o))',
].join('\n');

const ws = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029,
  0x202f, 0x205f, 0x3000, 0xfeff, 0x180e, 0x200b];
const STRINGS = [
  ...ws.map(c => `${ch(c)}a${ch(c)}b${ch(c)}`),
  'plain', '', 'a\r\nb\rc\nd', 'a\n', '\n', 'a\n\n', 'it\'s', 'a"b', 'both\'"', 'tab\tnew\nline\x01\x7f', ch(0xe9, 0x3042, 0x1f600),
  ch(0xe000, 0xad, 0x200e, 0xfff0), 'back\\slash',
];
const FNMATCH = [
  ['ghost/master/var/bonsyou_now.txt', 'ghost/master/var/bonsyou*.txt'], ['x.log', '*.log'], ['a/b.log', '*.log'],
  ['save1.txt', 'save[1].txt'], ['save[1].txt', 'save[1].txt'], ['x.txt', '[!a-c]*'], ['b.txt', '[!a-c]*'], [']', '[]]'],
  ['a-b', 'a-b'], ['-', '[-a]'], ['a', '[z-a]'], ['b', '[a-]'], ['-', '[a-]'], ['a?b', 'a?b'], ['axb', 'a?b'], ['ab', 'a?b'],
  ['a\nb', 'a*b'], ['abc', '[abc'], ['[abc', '[abc'], ['a.b', 'a.b'], ['axb', 'a.b'], ['^$', '^$'], ['x', '[!]'], ['!', '[!]'],
  ['x', '[^x]'], ['^', '[^x]'], ['\\', '[\\]'], ['a+b', 'a+b'], ['(x)', '(x)'], ['ab', 'a**b'], ['ab', '*'], ['', '*'],
  ['satori_savedata.txt', 'satori_savedata*'], ['yaya_variable.cfg.ays', '*_variable.*'], [ch(0x3042), '?'],
  [ch(0x1f600), '?'], ['.', '[.]'], ['b', '[a-c-e]'], ['-', '[a-c-e]'], ['d', '[a-c-e]'],
];
const VALUES = [
  { format: 2, ghosts: [{ id: 'x', name: ch(0x3042), thumbnails: [], shells: [{ id: 'master', name: 'M', hidden: true }],
    balloon: null }], versions: {}, empty: [], obj: { a: [1, [2, []]], b: {} } },
  ['a"b\\c\n\t\x01\x7f', ch(0x2028, 0x2029), 0, -1, 1234567890123, true, false, null],
];
const HEADS = [
  '#\r\n# Kawari saved file\r\n#', '#\n# Kawari saved file\n#\nx', '#  \t\r\n#\t Kawari saved file \t\r\n#',
  '#\r\n# Kawari saved file', ' #\r\n# Kawari saved file\r\n#', '#\r\n# kawari saved file\r\n#', '#\r\n#\r\n#',
].map(s => Buffer.from(s, 'latin1').toString('hex'))
  .concat(['23200d0a2320' + '89d89861979c835a815b8375837483408343838b' + '0d0a23', '230a23' + '89d89861979c835a815b837583748340' + '0a23']);
const THUMBS = ['thumbnail.png', 'thumbnail.PNR', 'thumbnail.tiff', 'thumbnail.mdix', 'thumbnail.exe', 'thumbnail', 'x.png',
  'thumbnail.' + ch(0xff52) + 'ng', 'thumbnail.p' + ch(0) + 'x', 'thumbnail.webp.bak', 'thumbnail.JPEG', 'thumbnail.0123456789abcdefpng'];
const NAMES = [['a', 'B'], ['shell2', 'shell10'], [ch(0xff11, 0xff10), '10'], ['カタ', 'かた'], ['x99999999999', 'x1'],
  ['', 'a'], ['Ab', 'aB'], ['À', 'à'], ['z', ch(0x3042)]];
const RELS = ['ghost/master/satori_savedata.txt', 'ghost/master/SATORI_SAVEBACKUP.txt', 'ghost/master/yaya_variable.cfg',
  'ghost/master/x.LOG', 'ghost/master/a.dll', 'x/Thumbs.db', 'desktop.ini', 'ghost/master/var/bonsyou_now.txt',
  'GHOST/MASTER/SaveFile1.txt', 'profile/x.txt', 'g/profile/x.txt', 'g/ghost/master/savefile1.txt', 'g/x.txt', 'ok.txt',
  'ghost/master/profile', 'g/Profile/a'];

// the site's record of a Kawari ghost's archive files (shipped.mjs = index_site.py kawari_record_bytes): [ghost id,
// entries] pairs, ids and paths in Python's order (code points: an astral id after U+FF21), an entry's CRC-32 second
const RECORDS = [
  [['b', [['ghost/master/z.txt', 1], ['ghost/master/a.txt', 2], ['ghost/master/a.txt', 1]]], ['a', [['x', 3]]], ['empty', []]],
  [[ch(0x8d64, 0x5341, 0x5b57, 0x9065), [['ghost/master/' + ch(0x30bb, 0x30fc, 0x30d6) + '.txt', 0xffffffff]]],
    [ch(0x3042, 0x308b, 0x3068), [['ghost/master/Dict-KEEPSs.txt', 0], ['ghost/master/Dict-KEEPSs.txt', 0]]],
    [ch(0x1f600), [['a' + ch(0xe9), 5]]], [ch(0xff21), [['b"\\', 6]]], ['10', [['c', 7]]], ['9', [['d', 8]]]],
  [['x', []]],
  [],
];
// how both read a record (CONTRACTS "The Kawari record"): [text, what it reads as] where that is the number of ghosts,
// or the record.* problem both refuse it with; null is no file (an empty record), DIR a folder in its place
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DIR = Symbol('a folder');
const ok1 = '{"format": 1, "ghosts": {"g": [["ghost/master/a.txt", 1]]}}';
const bad = e => `{"format": 1, "ghosts": {"g": [["ok", 1], ${e}]}}`;
const RECORD_TEXTS = [
  [null, 0], [ok1, 1], [DIR, 'record.open'],
  // an editor's BOM is read past, as Python's utf-8-sig reads it; a second one, or bytes no UTF-8, are no JSON
  [Buffer.concat([BOM, Buffer.from(ok1)]), 1], [Buffer.concat([BOM, BOM, Buffer.from(ok1)]), 'record.json'],
  [Buffer.concat([BOM, Buffer.from('{"format": 1,')]), 'record.json'], [BOM, 'record.json'], ['', 'record.json'],
  [Buffer.concat([Buffer.from('{"format": 1, "ghosts": {"g": [["'), Buffer.from([0xff]), Buffer.from('", 1]]}}')]), 'record.json'],
  ['not json', 'record.json'],
  // NaN and Infinity, which json.loads alone would take (even where nothing reads them)
  [bad('["p", NaN]'), 'record.json'], ['{"format": 1, "ghosts": {}, "x": -Infinity}', 'record.json'],
  ['{"format": 2, "ghosts": {"g": [["p", 1]]}}', 'record.format'], ['{"format": true, "ghosts": {"g": [["p", 1]]}}', 'record.format'],
  ['{"format": "1", "ghosts": {}}', 'record.format'], ['{"ghosts": {}}', 'record.format'], ['{"format": 1}', 'record.format'],
  ['{"format": 1, "ghosts": []}', 'record.format'], ['{"format": 1, "ghosts": 1.5}', 'record.format'],
  ['{"format": 1, "ghosts": null}', 'record.format'], ['[1]', 'record.format'], ['1.5', 'record.format'], ['null', 'record.format'],
  // every entry of a ghost an entry: [string, int of 0..0xFFFFFFFF], json.loads' int and float apart
  ...['["q"]', '["r", "1"]', '[1, 2]', '["s", 1.5]', '"t"', '["u", 3, 4]', '["w", true]', '["n", -1]', '["big", 4294967296]',
    '["f", 3.0]', '["e", 1E2]', '["z", null]', '{"p": 1}'].map(e => [bad(e), 'record.entries']),
  ['{"format": 1, "ghosts": {"g": "x"}}', 'record.entries'], ['{"format": 1, "ghosts": {"g": {}}}', 'record.entries'],
  // an escaped lone surrogate, which both JSON readers take and neither tool could write again: in a path the entry's,
  // in an id the record's form (ids before entries, so the problem is the same in either key order); a pair reads
  ['{"format": 1, "ghosts": {"g": [["ghost/master/a\\ud800.txt", 1]]}}', 'record.entries'],
  ['{"format": 1, "ghosts": {"g\\udc00": [["a", 1]]}}', 'record.format'],
  ['{"format": 1, "ghosts": {"b\\ud800": [["a", 1]], "1": [["x", "1"]]}}', 'record.format'],
  ['{"format": 1, "ghosts": {"\\ud83d\\ude00": [["\\ud83d\\ude00.txt", 1]]}}', 1],
  // an int longer than Python's int() takes (4300 digits) reads as JSON.parse reads it, a float (inf)
  [`{"format": 1, "ghosts": {"g": [["p", 1${'0'.repeat(5000)}]]}}`, 'record.entries'],
  [`{"format": 1${'0'.repeat(5000)}, "ghosts": {}}`, 'record.format'],
  [`{"format": 1, "ghosts": {"g": [["p", 1]]}, "n": -${'9'.repeat(5000)}}`, 1],
  // read: format 1.0 and 1e0 (== 1), other keys, a ghost without entries, the last of two keys, the largest CRC-32
  ['{"format": 1.0, "ghosts": {"g": [["p", 1]]}}', 1],
  ['{"format": 1e0, "ghosts": {"e": [["p", 1], ["max", 4294967295]], "c": [], "10": [["v", 9]], "a": [["first", 1]], '
    + '"a": [["dup", 2]]}, "note": ["ignored"]}', 4],
];
const recordSites = () => RECORD_TEXTS.map(([text], i) => {
  const site = path.join(tmp, 'records', String(i));
  fs.mkdirSync(site, { recursive: true });
  if (text === DIR) fs.mkdirSync(path.join(site, 'sumika', 'kawari-shipped.json'), { recursive: true });
  else if (text !== null) put(path.join(site, 'sumika', 'kawari-shipped.json'), text);
  return site;
});
/** A scratch site whose record reads (`text`), for a write's cases. */
const recordSite = (name, text) => {
  const site = path.join(tmp, 'record-writes', name);
  fs.mkdirSync(path.join(site, 'sumika'), { recursive: true });
  if (text !== null) put(path.join(site, 'sumika', 'kawari-shipped.json'), text);
  return site;
};

const lists = [];
function makeLists() {
  const dir = path.join(tmp, 'lists');
  lists.push(put(path.join(dir, 'updates2.dau'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('install.txt\x01613c69aea6555d981265c5d8bf0ad108\x01size=59\x01\r\n\\ghost\\master\\A.txt\x01BAD\x01size=3\x01size=4\r\n'
      + '  file, shell/x.png \x01 0123456789ABCDEF0123456789ABCDEF \x01 size=12 \r\nfile,\r\n\x01\x01\r\nnosize\x01'
      + '0123456789abcdef0123456789abcdef\x01size=' + ch(0xff11, 0xff12) + '\n')])));
  lists.push(put(path.join(dir, 'updates.txt'), Buffer.concat([Buffer.from('file,'), Buffer.from([0x95, 0x5c, 0x2e, 0x74, 0x78, 0x74]),
    Buffer.from('\x01d41d8cd98f00b204e9800998ecf8427e\x01size=0\x01\r\n'), Buffer.from([0x82, 0xa0, 0xff, 0x0d, 0x0a])])));
  lists.push(put(path.join(dir, 'a.nar'), makeZip([
    { name: 'top/install.txt', data: 'type,ghost\r\n' },
    { name: 'top/ghost/master/descript.txt', data: 'name,x\r\n' },
    { name: 'top/x/ghost/master/descript.txt', data: 'deeper' },
    { name: Buffer.from([0x74, 0x6f, 0x70, 0x2f, 0x95, 0x5c, 0x2e, 0x74, 0x78, 0x74]), data: 'cp932 with a 0x5c trail byte' },
    { name: 'top/dir/', method: 0 },
    { name: 'outside.txt', data: 'not under the prefix' },
    { name: 'top/' + ch(0x3042) + '.txt', data: 'utf-8 flagged', utf8: true },
    { name: Buffer.from([0x74, 0x6f, 0x70, 0x2f, 0x81, 0x7f, 0x2e, 0x74]), data: 'invalid cp932: cp437' },
  ])));
}

const FILES = [];
function makeFiles() {
  const d = path.join(tmp, 'descripts');
  const add = (n, b) => FILES.push(put(path.join(d, n), b));
  add('utf8bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('name,' + ch(0x3042) + '\r\nname,second\r\n')]));
  add('probe.txt', Buffer.from('// x\r\nCHARSET,UTF-8\r\nname,' + ch(0xe9) + '\r\nicon,a.ico\r\nIcon , b.ico \r\n'));
  add('spaces.txt', Buffer.from('charset, UTF-8\r\nname,' + ch(0xe9) + '\r\n'));
  add('cp932.txt', Buffer.concat([Buffer.from('name,'), Buffer.from([0x95, 0x5c, 0x81, 0x41, 0x80, 0xa0, 0xfd, 0x81]), Buffer.from('\r\n')]));
  add('ws.txt', Buffer.from(['charset,utf-8', `${ch(0x1c)}name${ch(0x85)},${ch(0x3000)}x${ch(0x1f)}`, `k${ch(0x2028)}v,1`,
    `a,b${ch(0x0c)}c,d`, `${ch(0xfeff)}feff,1`, ',empty key', 'nocomma', '  // comment,x', 'iconfilename,'].join('\r\n')));
  add('control.txt', Buffer.from([0x1a, 0x1c, 0x7f, 0x6e, 0x61, 0x6d, 0x65, 0x2c, 0x7a]));
  add('empty.txt', Buffer.alloc(0));
}

let pyOut = null;
function python() {
  if (pyOut) return pyOut;
  makeLists();
  makeFiles();
  const rnd = [];
  let seed = 7;
  const pool = [0x41, 0x0a, 0x5c, 0x7f, 0x80, 0x81, 0x9f, 0xa0, 0xa1, 0xdf, 0xe0, 0xeb, 0xed, 0xef, 0xf0, 0xf9, 0xfa, 0xfc, 0xfd, 0xff, 0x40, 0x7e];
  for (let i = 0; i < 3000; i++) {
    let h = '';
    const n = 1 + (i % 9);
    for (let k = 0; k < n; k++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      h += pool[seed % pool.length].toString(16).padStart(2, '0');
    }
    rnd.push(h);
  }
  const cases = {
    strings: STRINGS, fnmatch: FNMATCH, values: VALUES, files: FILES, heads: HEADS, thumbs: THUMBS, names: NAMES, rels: RELS,
    lists, cp932: rnd,
    zipnames: [['74657374', 0], ['955c2e747874', 0], ['8141802e74', 0], ['e38182', 0x800], ['ff', 0x800], ['615c62', 0],
      ['8140', 0], ['81', 0], ['a0fdfeff', 0]],
    records: RECORDS, record_sites: recordSites(),
    record_write_site: recordSite('py-failed', ok1), record_bytes_site: recordSite('py-failed-bytes', ok1),
    record_bad_site: recordSite('py-bad', 'not json'),
  };
  const input = put(path.join(tmp, 'cases.json'), JSON.stringify(cases));
  const script = put(path.join(tmp, 'twins.py'), PY_SCRIPT);
  const r = spawnSync(PY, ['-I', '-B', script, path.join(ROOT, 'tools'), input], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`this test runs Python (${PY}; set PYTHON to another): ${r.error.message}`);
  assert.equal(r.status, 0, r.stderr);
  pyOut = { cases, out: JSON.parse(r.stdout) };
  return pyOut;
}

test('rules.mjs holds index_site.py\'s and add_ghost.py\'s constants (a change is made in both)', () => {
  const c = python().out.consts;
  assert.equal(R.FORMAT, c.FORMAT);
  assert.equal(R.NAME_HASH, c.NAME_HASH);
  assert.equal(R.VERSION_HASH, c.VERSION_HASH);
  assert.deepEqual([...R.PERSONAL_DIRS].sort(), c.PERSONAL_DIRS);
  assert.deepEqual([...R.PERSONAL_FILES], c.PERSONAL_FILES);
  assert.deepEqual([...R.PERSONAL_PATHS], c.PERSONAL_PATHS);
  assert.deepEqual([...R.KAWARI_ENGINES], c.KAWARI_ENGINES);
  assert.deepEqual(R.KAWARI_SHIPPED_SAVES.map(x => [...x]), c.KAWARI_SHIPPED_SAVES);
  assert.equal(R.KAWARI_RECORD, c.KAWARI_RECORD);
  assert.deepEqual([...R.PACK_EXT], c.PACK_EXT);
  assert.deepEqual([...R.PACK_SKIP], c.PACK_SKIP);
  assert.equal(R.PACK_MAX, c.PACK_MAX);
  assert.equal(R.DEFAULT_BALLOON, c.DEFAULT_BALLOON);
  assert.deepEqual(Object.fromEntries(Object.entries(R.ROOT_PACK_EXT).map(([k, v]) => [k, [v.source, v.flags.includes('i')]])), c.ROOT_PACK_EXT);
  assert.deepEqual(R.ROOT_PACK_EXT, { yaya: YAYA_TEXT, kawari: KAWARI_TEXT, kawari7: KAWARI7_TEXT }, 'engine-files.js\'s patterns');
  assert.deepEqual([...R.THUMB_EXT].sort(), c.THUMB_EXT);
  assert.deepEqual([...R.THUMB_EXT_PREFIX], c.THUMB_EXT_PREFIX);
  assert.deepEqual([...R.SKIP_FILES], c.SKIP_FILES);
  assert.deepEqual([...R.PERSONAL_DIRS].sort(), c.SKIP_DIRS);
  assert.deepEqual([R.ALWAYS_LISTED.source.replace(/\\\//g, '/'), R.ALWAYS_LISTED.flags.includes('i')], c.ALWAYS_LISTED);
});

test('Python\'s str.strip, splitlines and repr, fnmatch.fnmatchcase and json.dumps, as Python gives them', () => {
  const { cases, out } = python();
  assert.deepEqual(cases.strings.map(pyStrip), out.strip);
  assert.deepEqual(cases.strings.map(pySplitlines), out.splitlines);
  assert.deepEqual(cases.strings.map(pyRepr), out.repr);
  assert.deepEqual(cases.fnmatch.map(([n, p]) => fnmatchcase(n, p)), out.fnmatch);
  assert.deepEqual(cases.values.map(v => dumps(v)), out.dumps);
  assert.deepEqual(cases.values.map(v => dumps(v, { indent: 1 })), out.dumps1);
  assert.deepEqual(sortedPy(['b', 'B', 'a', ch(0xffff), ch(0x1f600), ch(0xe000)]), ['B', 'a', 'b', ch(0xe000), ch(0xffff), ch(0x1f600)],
    'code points, not UTF-16 units');
  assert.equal(cmpPy('a', 'ab'), -1);
  assert.throws(() => dumps(['x' + String.fromCharCode(0xd800)]), /lone surrogate/);
});

test('read_text, read_descript, descript_last and zip_name, as index_site.py and add_ghost.py read them', () => {
  const { cases, out } = python();
  assert.deepEqual(cases.files.map(readTextFile), out.read_text);
  assert.deepEqual(cases.files.map(f => [...readDescript(f)]), out.read_descript);
  assert.deepEqual(cases.files.map(f => descriptLast(f, ['icon', 'iconfilename'])), out.descript_last);
  const zn = cases.zipnames.map(([h, f]) => {
    try { return zipName(Buffer.from(h, 'hex'), f); } catch (e) { return null; }
  });
  assert.deepEqual(zn, out.zip_name);
});

test('cp932 as Python decodes it, on every 1- and 2-byte sequence and 3000 longer ones (errors replaced, one byte each)', () => {
  const { out } = python();
  const bad = [];
  for (const [h, v] of Object.entries(out.cp932)) {
    const js = decodeCp932(Buffer.from(h, 'hex'));
    if (js !== v) bad.push([h, v, js]);
  }
  assert.equal(Object.keys(out.cp932).length > 68000, true);
  assert.deepEqual(bad.slice(0, 5), []);
  assert.throws(() => decodeCp932(Buffer.from([0x81]), { fatal: true }), /cp932/);
});

test('Kawari\'s save header, SSP\'s thumbnail extensions and name order, the skip and personal rules, archive_index: as in Python', () => {
  const { cases, out } = python();
  assert.deepEqual(cases.heads.map(h => R.KAWARI_SAVE_HEAD.test(Buffer.from(h, 'hex').toString('latin1'))), out.kawari_head);
  assert.deepEqual(cases.thumbs.map(thumbnailExtOk), out.thumb);
  assert.deepEqual(cases.names.map(([a, b]) => Math.sign(compareNames(a, b))), out.compare_names);
  assert.deepEqual(cases.rels.map(p => R.skipCode(p) !== null), out.skip_file);
  assert.deepEqual(cases.rels.map(p => [R.isPersonal(p, false), R.isPersonal(p, true)]), out.is_personal);
  assert.deepEqual(cases.lists.map(f => Object.fromEntries([...archiveIndex(f)].map(([k, v]) => [k, v.map(e => [...e])]))), out.archive_index);
});

test('the site\'s record of a Kawari ghost\'s archive files: the bytes index_site.py writes, read as it reads it', () => {
  const { cases, out } = python();
  const text = r => {
    const b = shippedBytes(new Map(r));
    return b === null ? null : b.toString('utf8');
  };
  assert.deepEqual(cases.records.map(text), out.record_bytes);
  // read alike, refused alike: the same problem and the same text (index_site.py KawariRecordError = 'kawari.record')
  const read = s => {
    try {
      return [...readShipped(s)].sort((a, b) => cmpPy(a[0], b[0]));
    } catch (e) {
      assert.ok(e instanceof AdminRefusal && e.code === 'kawari.record', String(e));
      return { problem: e.params.problem, message: e.message };
    }
  };
  assert.deepEqual(cases.record_sites.map(read), out.record_read);
  assert.deepEqual(out.consts.KAWARI_RECORD_PROBLEMS, Object.fromEntries(Object.keys(out.consts.KAWARI_RECORD_PROBLEMS)
    .map(k => [k, message(k)])), 'the problems\' texts: index_site.py KAWARI_RECORD_PROBLEMS = codes.mjs record.*');
  assert.deepEqual(Object.keys(out.consts.KAWARI_RECORD_PROBLEMS), CODE_LIST.filter(c => c.startsWith('record.')));
  // what that is: ids by code point, entries by path then CRC-32, empty ones dropped; a record without entries none
  assert.deepEqual([...out.record_bytes[1].matchAll(/^ {2}"([^"]+)": \[$/gm)].map(m => m[1]), ['10', '9',
    ch(0x3042, 0x308b, 0x3068), ch(0x8d64, 0x5341, 0x5b57, 0x9065), ch(0xff21), ch(0x1f600)]);
  assert.deepEqual(JSON.parse(out.record_bytes[0]), { format: 1, ghosts: { a: [['x', 3]],
    b: [['ghost/master/a.txt', 1], ['ghost/master/a.txt', 2], ['ghost/master/z.txt', 1]] } });
  assert.ok(out.record_bytes[0].endsWith(']\n }\n}\n') && !out.record_bytes[0].includes('\r'), 'LF, a 1-space indent');
  assert.deepEqual(out.record_bytes.slice(2), [null, null]);
  assert.deepEqual(out.record_read.map(r => (Array.isArray(r) ? r.length : r.problem)), RECORD_TEXTS.map(([, want]) => want));
  assert.deepEqual(out.record_read.at(-1), [['10', [['v', 9]]], ['a', [['dup', 2]]], ['c', []],
    ['e', [['p', 1], ['max', 0xffffffff]]]]);
  assert.deepEqual(out.record_read[3], [['g', [['ghost/master/a.txt', 1]]]], 'a BOM read past');
  assert.equal(out.record_read[7].message, 'stopped, nothing changed: sumika/kawari-shipped.json cannot be read: it is not '
    + 'JSON. That file is the site\'s list of the Kawari save-header files that ghosts added from their own .nar or .zip '
    + 'brought (the index accepts such a file while the list names it): repair it, or delete it and add those Kawari '
    + 'ghosts again from their .nar or .zip');
  // a write: a rename or a write that fails leaves no temporary file (Python's finally) and the record as it was; a
  // record that does not read is never written over (both)
  assert.deepEqual(out.record_failed_write, [['kawari-shipped.json'], ['kawari-shipped.json']], 'the rename, the write');
  for (const s of [cases.record_write_site, cases.record_bytes_site]) {
    assert.equal(fs.readFileSync(path.join(s, 'sumika', 'kawari-shipped.json'), 'utf8'), ok1);
  }
  assert.equal(out.record_over_bad, 'record.json');
  assert.equal(fs.readFileSync(path.join(cases.record_bad_site, 'sumika', 'kawari-shipped.json'), 'utf8'), 'not json');
});

test('the Kawari record\'s writes leave no temporary file when the write or the rename fails; one a cut-off write left is deleted by recoverWork, nothing else', async () => {
  const listing = s => fs.readdirSync(path.join(s, 'sumika')).sort();
  for (const [what, name] of [['the write', 'writeFileSync'], ['the rename', 'renameSync']]) {
    const site = recordSite(`js-${name}`, ok1);
    const real = fs[name];
    fs[name] = (...a) => {
      if (name === 'writeFileSync' && typeof a[0] !== 'number') return real(...a);     // the temporary file's fd only
      throw Object.assign(new Error(`${what} refused`), { code: 'EPERM' });
    };
    try {
      assert.throws(() => setShipped(site, 'g', [['ghost/master/x.txt', 2]]), /refused/, what);
    } finally {
      fs[name] = real;
    }
    assert.deepEqual(listing(site), ['kawari-shipped.json'], what);
    assert.equal(fs.readFileSync(path.join(site, 'sumika', 'kawari-shipped.json'), 'utf8'), ok1, `${what}: as it was`);
  }
  // one that does not read: refused, nothing written
  const broken = recordSite('js-broken', 'not json');
  assert.throws(() => setShipped(broken, 'g', []), e => e.code === 'kawari.record' && e.params.problem === 'record.json');
  assert.equal(fs.readFileSync(path.join(broken, 'sumika', 'kawari-shipped.json'), 'utf8'), 'not json');
  // what a write of the record or of hub.json cut off between its write and its rename left: deleted by the program's
  // tidy-up, and only that
  const site = recordSite('js-leftover', ok1);
  for (const n of ['kawari-shipped.json.tmp-0123abcd', 'kawari-shipped.json.tmp-x', 'kawari-shipped.json.tmp-0123abcd0', 'hub.json',
    'hub.json.tmp-4567cdef', 'settings.json.tmp-0123abcd']) {
    put(path.join(site, 'sumika', n), 'x');
  }
  fs.mkdirSync(path.join(site, 'sumika', 'kawari-shipped.json.tmp-89abcdef'));      // a folder: no write's, kept
  const r = await recoverWork(site);
  assert.deepEqual(r.entries, [
    { name: 'sumika/hub.json.tmp-4567cdef', kind: 'temp', id: null, action: 'deleted' },
    { name: 'sumika/kawari-shipped.json.tmp-0123abcd', kind: 'temp', id: null, action: 'deleted' },
  ]);
  assert.deepEqual(listing(site), ['hub.json', 'kawari-shipped.json', 'kawari-shipped.json.tmp-0123abcd0',
    'kawari-shipped.json.tmp-89abcdef', 'kawari-shipped.json.tmp-x', 'settings.json.tmp-0123abcd']);
  assert.ok(r.clean);
});

// ---- archives ----

const cp = bytes => Buffer.from(bytes);
/** A ghost archive with what an extraction must and must not write. */
function ghostZip(more = []) {
  return makeZip([
    { name: 'install.txt', data: 'type,ghost\r\ndirectory,ZipGhost\r\nrefreshundeletemask,save.txt\r\n' },
    { name: 'ghost/master/descript.txt', data: 'charset,UTF-8\r\nname,Zip Ghost\r\nshiori,satori.dll\r\n' },
    { name: 'ghost/master/dic.txt', data: '*OnBoot\r\n:hi\r\n' },
    { name: 'ghost/master/satori_savedata.txt', data: 'SECRET save' },
    { name: 'ghost/master/profile/x.txt', data: 'SECRET profile' },
    { name: 'profile/', method: 0 },
    { name: 'ghost/master/a.dll', data: 'MZ' },
    { name: 'empty/', method: 0 },
    { name: cp([0x95, 0x5c, 0x2e, 0x74, 0x78, 0x74]), data: 'a CP932 name whose trail byte is 0x5c' },
    { name: 'shell/master/descript.txt', data: 'name,master\r\n' },
    { name: 'link', data: '../../etc/passwd', ...UNIX_LINK },
    ...more,
  ]);
}

test('an archive is extracted with add_ghost.py\'s names, never writing a personal file, a DLL or a link', () => {
  // a record `\` (the archive's own root folder: BTHver.5's) and a leading `/` are dropped, as archive_index drops them
  const file = put(path.join(tmp, 'z1', 'g.nar'), ghostZip([{ name: Buffer.from([0x5c]), method: 0, attrs: 0x10 },
    { name: '/lead.txt', data: 'x' }]));
  const dest = path.join(tmp, 'z1', 'x');
  const r = extractGhost(file, dest);
  assert.equal(r.prefix, '');
  const all = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      all.push(rel + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
    }
  })(dest, '');
  assert.deepEqual(all.sort(), ['empty/', 'ghost/', 'ghost/master/', 'ghost/master/descript.txt', 'ghost/master/dic.txt',
    'install.txt', 'lead.txt', 'shell/', 'shell/master/', 'shell/master/descript.txt', ch(0x8868) + '.txt'].sort());
  assert.deepEqual(r.excluded.map(x => [x.path, x.code]).sort(), [['ghost/master/a.dll', 'program.dll'],
    ['ghost/master/profile/', 'personal.profile'], ['ghost/master/satori_savedata.txt', 'personal.satoriSave'],
    ['link', 'archive.link'], ['profile/', 'personal.profile']].sort());
});

test('an archive that would write outside its folder, or a name Windows changes, or a damaged member, writes nothing', () => {
  const cases = [
    [{ name: '../escape.txt', data: 'x' }, 'name.dots'], [{ name: '/../abs.txt', data: 'x' }, 'name.dots'],
    [{ name: 'C:/x.txt', data: 'x' }, 'name.badChar'], [{ name: 'a\\..\\..\\b.txt', data: 'x' }, 'name.dots'],
    [{ name: 'con.txt', data: 'x' }, 'name.device'], [{ name: 'COM1', data: 'x' }, 'name.device'],
    [{ name: 'x?.txt', data: 'x' }, 'name.badChar'], [{ name: 'dot.', data: 'x' }, 'name.trailingDotSpace'],
    [{ name: 'a//b', data: 'x' }, 'name.dots'], [{ name: 'enc.txt', data: 'x', flags: 1 }, 'member.encrypted'],
    [{ name: 'b.txt', data: 'x', method: 12 }, 'member.method'],
  ];
  for (const [m, code] of cases) {
    const dir = fs.mkdtempSync(path.join(tmp, 'bad-'));
    const file = put(path.join(dir, 'g.zip'), ghostZip([m]));
    const dest = path.join(dir, 'x');
    assert.throws(() => extractGhost(file, dest), e => e instanceof AdminRefusal && e.code === 'archive.unsafe'
      && e.files.some(f => f.code === code), `${m.name}: ${code}`);
    assert.equal(fs.existsSync(dest), false, `${m.name}: nothing written`);
    assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
  }
  const clash = put(path.join(tmp, 'clash', 'g.zip'), ghostZip([{ name: 'A', data: 'x' }, { name: 'a/b.txt', data: 'y' }]));
  assert.throws(() => extractGhost(clash, path.join(tmp, 'clash', 'x')), e => e.code === 'archive.unsafe'
    && e.files[0].code === 'member.fileAndFolder');
  const damaged = put(path.join(tmp, 'dmg', 'g.zip'), ghostZip([{ name: 'bad.txt', data: 'data', crc: 1 }]));
  assert.throws(() => extractGhost(damaged, path.join(tmp, 'dmg', 'x')), e => e.code === 'archive.damaged');
  assert.throws(() => extractGhost(put(path.join(tmp, 'no', 'g.zip'), Buffer.from('not a zip')), path.join(tmp, 'no', 'x')),
    e => e.code === 'archive.unreadable');
  assert.throws(() => extractGhost(put(path.join(tmp, 'none', 'g.zip'), makeZip([{ name: 'readme.txt', data: 'x' }])),
    path.join(tmp, 'none', 'x')), e => e.code === 'archive.noGhost');
});

// ---- the API ----

/** An SSP layout: ghost/<g> with install.txt naming a balloon SSP moved to balloon/<b>, personal files beside. */
function sspLayout(dir) {
  const g = path.join(dir, 'ssp', 'ghost', 'G1');
  fs.cpSync(path.join(FIXTURES, 'testghost'), g, { recursive: true });
  put(path.join(g, 'install.txt'), 'type,ghost\r\ndirectory,G1\r\nballoon.directory,bal\r\nrefreshundeletemask,ghost/master/dic01_test.txt\r\n');
  put(path.join(g, 'ghost', 'master', 'satori_savedata.txt'), 'SECRET satori');
  put(path.join(g, 'ghost', 'master', 'profile', 'ghost.dat'), 'SECRET profile');
  put(path.join(g, 'ghost', 'master', 'descript.txt'), fs.readFileSync(path.join(FIXTURES, 'testghost', 'ghost', 'master', 'descript.txt'), 'utf8')
    + 'readme,ghost/master/satori_savedata.txt\r\n');
  put(path.join(g, 'readme.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('Test ghost.\r\nRedistribution: free (再配布自由).\r\nThe end.\r\n')]));
  const b = path.join(dir, 'ssp', 'balloon', 'bal');
  put(path.join(b, 'descript.txt'), 'charset,UTF-8\r\ntype,balloon\r\nname,Bal\r\n');
  put(path.join(b, 'balloons0.png'), fs.readFileSync(path.join(FIXTURES, 'testghost', 'shell', 'master', 'surface0.png')));
  put(path.join(b, 'profile', 'x.txt'), 'SECRET balloon profile');
  return g;
}

test('inspectSource: one item per ghost with codes, sizes, what is left out, the balloon SSP moved, terms; no personal contents', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'inspect-'));
  const g = sspLayout(dir);
  const steps = [];
  const items = await inspectSource(path.join(dir, 'ssp', 'ghost'), { onProgress: p => steps.push(p) });
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.id, 'g1');
  assert.equal(it.engine, 'satori');
  assert.deepEqual(it.runs, { ok: true, code: null, params: null, note: null });
  assert.equal(it.refusal, null);
  assert.deepEqual(it.balloons.map(b => [b.dir, b.from]), [['bal', 'ssp']]);
  assert.deepEqual(it.excluded.map(x => [x.path, x.code]), [['ghost/master/profile/', 'personal.profile'],
    ['ghost/master/satori_savedata.txt', 'personal.satoriSave'], ['bal/profile/', 'personal.profile']]);
  for (const x of it.excluded) assert.equal(x.why, message(x.code, x.params));
  assert.deepEqual(it.notes.map(n => n.code), ['note.undeleteMask']);
  assert.deepEqual(it.notes[0].params, { names: ['ghost/master/dic01_test.txt'], hits: ['ghost/master/dic01_test.txt'] });
  assert.equal(it.terms.kind, 'readme');
  assert.equal(it.terms.file, 'readme.txt', 'the descript\'s readme names a personal file: never read');
  assert.match(it.terms.excerpt, /再配布/);
  assert.ok(it.fileCount > 3 && it.sizeBytes > 600);
  assert.doesNotMatch(JSON.stringify(items), /SECRET/, 'no personal file\'s contents');
  assert.ok(steps.some(s => s.phase === 'inspect'));

  // the same ghost as an archive (zip of the folder, the balloon inside as an archive ships it), and a conflict
  const nar = put(path.join(dir, 'G1.nar'), makeZip([
    { name: 'install.txt', data: 'type,ghost\r\ndirectory,G1\r\n' },
    { name: 'ghost/master/descript.txt', data: 'charset,UTF-8\r\nname,Zipped\r\nshiori,yaya.dll\r\n' },
    { name: 'ghost/master/yaya.txt', data: 'dic,a.dic\r\n' },
    { name: 'ghost/master/a.dic', data: 'OnRequest\r\n{\r\n}\r\n' },
  ]));
  const site = path.join(dir, 'site');
  put(path.join(site, 'ghost', 'g1', 'ghost', 'master', 'descript.txt'), 'name,old\r\n');
  const [z] = await inspectSource(nar, { site });
  assert.equal(z.source.kind, 'archive');
  assert.equal(z.id, 'g1', 'install.txt directory, lower-cased');
  assert.equal(z.engine, 'aya');
  assert.deepEqual(z.runs, { ok: false, code: 'engine.needs', params: { engine: 'AYA' }, note: 'needs AYA' });
  assert.deepEqual(z.notes.map(n => n.code), ['note.compared'], 'an archive source is compared with itself');
  assert.equal(z.conflict.path, path.join(site, 'ghost', 'g1'));
  // a refused comparison: the flagged files are listed, never opened by what the inspection still looks at
  const [y] = await inspectSource(path.join(FIXTURES, 'yayatest'), { archive: path.join(FIXTURES, 'yayatest', 'updates2.dau') });
  assert.equal(y.refusal.code, 'compare.unlisted');
  assert.deepEqual(y.refusal.files.map(f => f.code), Array(8).fill('compare.notListed'));
  assert.deepEqual(y.notes, [], 'add_ghost.py prints nothing after its refusal');
  assert.equal(y.engine, 'yaya');
  const bad = await inspectSource(put(path.join(dir, 'bad.zip'), makeZip([{ name: 'ghost/master/descript.txt', data: 'x' },
    { name: 'ghost/../../x.txt', data: 'x' }])));
  assert.equal(bad[0].refusal.code, 'archive.unsafe');
  assert.equal(fs.existsSync(path.join(dir, 'x.txt')), false);
});

test('addGhost: leaveOut leaves a file out (never brings a personal one back), progress per phase, the core prints nothing', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'add-'));
  const g = sspLayout(dir);
  const site = path.join(dir, 'site');
  fs.mkdirSync(site);
  const steps = [];
  const lines = [];
  const write = process.stdout.write;
  let printed = '';
  process.stdout.write = (s, ...a) => { printed += s; return true; };
  let r;
  try {
    r = await addGhost(g, site, { id: 'g1', leaveOut: ['READme.txt', 'ghost/master/satori_savedata.txt'], log: l => lines.push(l),
      onProgress: p => steps.push(p) });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(printed, '', 'nothing on stdout from the core');
  assert.equal(fs.existsSync(path.join(site, 'ghost', 'g1', 'readme.txt')), false, 'left out');
  assert.equal(fs.existsSync(path.join(site, 'ghost', 'g1', 'ghost', 'master', 'satori_savedata.txt')), false);
  assert.ok(fs.existsSync(path.join(site, 'ghost', 'g1', 'bal', 'balloons0.png')), 'the balloon SSP moved');
  assert.deepEqual(r.excluded.filter(x => x.code === 'admin.leaveOut').map(x => x.path), ['readme.txt']);
  assert.equal(r.excluded.find(x => x.path === 'ghost/master/satori_savedata.txt').code, 'personal.satoriSave');
  assert.equal(lines[0], 'left out with --skip: readme.txt');
  assert.ok(lines.some(l => /^copied \d+ files to /.test(l)) && lines.some(l => /^indexed 1 ghost/.test(l)));
  const phases = [...new Set(steps.map(s => s.phase))];
  assert.deepEqual(phases, ['copy', 'index']);
  for (const s of steps) assert.ok(Number.isInteger(s.done) && (s.total === null || s.done <= s.total), JSON.stringify(s));
  // replace is asked for; the index may be left to the caller
  await assert.rejects(addGhost(g, site, { id: 'g1' }), e => e instanceof AdminRefusal && e.code === 'site.exists');
  const again = await addGhost(g, site, { id: 'g1', replace: true, index: false });
  assert.equal(again.index, null);
  await assert.rejects(addGhost(g, site, { id: 'a/b' }), e => e.code === 'id.bad' && e.params.problem === 'name.separator');
  await assert.rejects(addGhost(path.join(dir, 'nothing'), site, { id: 'x' }), e => e.code === 'source.notGhost');
});

const KAWARI_HEAD = '#\r\n# Kawari saved file\r\n#\r\n';
/** The kawaritest fixture's files and `more`: {ghost-root-relative path: bytes}. */
function kawariFiles(more = {}) {
  const out = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
      else out[rel + e.name] = fs.readFileSync(path.join(d, e.name));
    }
  })(path.join(FIXTURES, 'kawaritest'), '');
  for (const [p, d] of Object.entries(more)) out[p] = Buffer.from(d);
  return out;
}
const kawariZip = (file, files) => put(file, makeZip(Object.entries(files).map(([name, data]) => ({ name, data }))));
const kawariFolder = (dir, files) => {
  for (const [p, d] of Object.entries(files)) put(path.join(dir, ...p.split('/')), d);
  return dir;
};

test('Kawari save-header files: kept and recorded from the ghost\'s own archive [decision], refused from a folder (compared with that archive or not); a replace and a removal set the record; the index accepts what it lists unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'kawari-'));
  const saves = { 'ghost/master/Dict-KEEPSs.txt': `${KAWARI_HEAD}a : 1\r\n`, 'ghost/master/runonce.txt': `${KAWARI_HEAD}b : 2\r\n` };
  const entries = Object.entries(saves).map(([p, d]) => [p, crc32(Buffer.from(d))]);
  const nar = kawariZip(path.join(dir, 'k.nar'), kawariFiles(saves));
  const folder = kawariFolder(path.join(dir, 'installed', 'k'), kawariFiles(saves));
  const site = path.join(dir, 'site');
  fs.mkdirSync(site);
  const recordFile = path.join(site, ...R.KAWARI_RECORD.split('/'));

  // inspect: the archive's files are a note; the folder's a refusal, with the developers' line once it is compared
  const [a] = await inspectSource(nar, { site });
  assert.equal(a.refusal, null);
  assert.deepEqual(a.notes.map(n => [n.code, n.params]), [
    ['note.compared', { count: Object.keys(kawariFiles(saves)).length, archiveName: 'k.nar', kept: 0 }],
    ['note.kawariKept', { paths: Object.keys(saves) }]]);
  const [f] = await inspectSource(folder, { site });
  assert.equal(f.refusal.code, 'kawari.saveHeader');
  assert.deepEqual(f.refusal.files.map(x => [x.path, x.code]), Object.keys(saves).map(p => [p, 'kawari.runSave']));
  assert.match(f.refusal.message, /^a Kawari ghost with such files is added only from its own \.nar or \.zip/m);
  const [fc] = await inspectSource(folder, { site, archive: nar });
  assert.deepEqual(fc.refusal.files.map(x => x.code), ['kawari.shippedDefault', 'kawari.shippedDefault']);
  assert.equal(fc.refusal.files[1].line, `('ghost/master/runonce.txt', 0x${entries[1][1].toString(16).padStart(8, '0')}),    # k.nar`);
  for (const o of [{}, { archive: nar }]) {
    await assert.rejects(addGhost(folder, site, { id: 'k', ...o }), e => e.code === 'kawari.saveHeader');
  }
  assert.ok(!fs.existsSync(path.join(site, 'ghost', 'k')) && !fs.existsSync(recordFile), 'nothing written');

  // added from the archive: copied, recorded (add_ghost.py's note in the log), indexed, and the site checks out
  const lines = [];
  const r = await addGhost(nar, site, { id: 'k', log: l => lines.push(l) });
  assert.deepEqual(r.index.ids, ['k']);
  assert.ok(lines.includes(message('note.kawariKept', { paths: Object.keys(saves) })), lines.join('\n'));
  for (const p of Object.keys(saves)) assert.ok(fs.existsSync(path.join(site, 'ghost', 'k', ...p.split('/'))), p);
  assert.deepEqual(JSON.parse(fs.readFileSync(recordFile, 'utf8')), { format: 1, ghosts: { k: entries } });
  assert.equal((await checkSite(site)).ok, true);

  // a second ghost; a replace of it from another archive sets its entries alone; while the folders are swapped the
  // record lists both versions' files, and a refused swap puts it back as it was
  await addGhost(nar, site, { id: 'k2' });
  const v2 = `${KAWARI_HEAD}b : 3\r\n`;
  const other = kawariZip(path.join(dir, 'k-v2.nar'), kawariFiles({ 'ghost/master/runonce.txt': v2 }));
  const during = [];
  const watch = { retryMs: [], rename: (x, y) => { during.push(readShipped(site).get('k2')); fs.renameSync(x, y); } };
  await addGhost(other, site, { id: 'k2', replace: true, io: watch });
  const v2entries = [['ghost/master/runonce.txt', crc32(Buffer.from(v2))]];
  const byPath = l => [...l].sort((x, y) => cmpPy(x[0], y[0]) || x[1] - y[1]);
  assert.deepEqual(during[0], byPath([...entries, ...v2entries]));
  assert.deepEqual(readShipped(site).get('k2'), v2entries);
  assert.deepEqual(readShipped(site).get('k'), entries);
  const refuse = { retryMs: [], rename: (x, y) => {
    if (path.basename(x).startsWith('new-')) throw Object.assign(new Error('held'), { code: 'EPERM' });
    fs.renameSync(x, y);
  } };
  await assert.rejects(addGhost(nar, site, { id: 'k2', replace: true, io: refuse }), e => e.code === 'work.rename');
  assert.deepEqual(readShipped(site).get('k2'), v2entries, 'as it was');

  // a recorded file changed in the site: refused again, and only it
  const runonce = path.join(site, 'ghost', 'k', 'ghost', 'master', 'runonce.txt');
  fs.appendFileSync(runonce, 'name : someone\r\n');
  assert.deepEqual((await personalFiles(site)).map(p => [p.path, p.code]), [['ghost/k/ghost/master/runonce.txt', 'personal.kawariSave']]);
  await assert.rejects(indexSite(site), e => e.code === 'site.personal' && /kawari-shipped\.json lists it unchanged/.test(e.message));
  // removed: its entries go (its own files never stop its removal)
  await removeGhost(site, 'k');
  assert.deepEqual([...readShipped(site).keys()], ['k2']);
  // a replace from a folder without such files: its key goes, and with the last one the record
  await addGhost(kawariFolder(path.join(dir, 'plain', 'k2'), kawariFiles()), site, { id: 'k2', replace: true });
  assert.equal(fs.existsSync(recordFile), false);
  assert.equal(fs.existsSync(path.join(site, 'sumika', 'index', 'ghosts.json')), true);
});

test('a removal whose record write Windows refuses still removes and re-indexes; the entries left accept only what the archive held', async t => {
  if (process.platform !== 'win32' && process.getuid && process.getuid() === 0) return t.skip('root writes anyway');
  const dir = fs.mkdtempSync(path.join(tmp, 'kawari-held-'));
  const saves = { 'ghost/master/runonce.txt': `${KAWARI_HEAD}b : 2\r\n` };
  const nar = kawariZip(path.join(dir, 'k.nar'), kawariFiles(saves));
  const site = path.join(dir, 'site');
  await addGhost(nar, site, { id: 'k', index: false });
  await addGhost(nar, site, { id: 'k2' });
  const recordFile = path.join(site, ...R.KAWARI_RECORD.split('/'));
  const before = fs.readFileSync(recordFile);
  // a rename over a read-only file fails on Windows (EPERM), as over one a scanner holds; elsewhere a read-only folder
  const held = process.platform === 'win32' ? recordFile : path.dirname(recordFile);
  fs.chmodSync(held, process.platform === 'win32' ? 0o444 : 0o555);
  let r;
  try {
    r = await removeGhost(site, 'k');
  } finally {
    fs.chmodSync(held, process.platform === 'win32' ? 0o644 : 0o755);
  }
  assert.deepEqual(r.index.ids, ['k2']);
  assert.deepEqual(fs.readdirSync(path.join(site, 'ghost')), ['k2']);
  assert.equal(fs.existsSync(path.join(site, '.sumika-admin-work')), false, 'nothing left in the work folder');
  assert.ok(fs.readFileSync(recordFile).equals(before), 'the record as it was');
  assert.deepEqual(fs.readdirSync(path.dirname(recordFile)).filter(n => n.includes('.tmp-')), [], 'no temporary file');
  assert.equal((await checkSite(site)).ok, true);
});

/** Every folder and file under root with each file's CRC-32, sorted: a site as it is. */
function treeOf(root) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel + e.name;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(p, `${r}/`);
      } else out.push(`${r} ${crc32(fs.readFileSync(p))}`);
    }
  })(root, '');
  return out.sort();
}

test('the Kawari record: an editor\'s BOM is read past; one that does not read refuses inspect, every add, a removal and the index (kawari.record) before anything changes, and Check says it once, never as personal files', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'kawari-record-'));
  const saves = { 'ghost/master/runonce.txt': `${KAWARI_HEAD}b : 2\r\n` };
  const nar = kawariZip(path.join(dir, 'k.nar'), kawariFiles(saves));
  const site = path.join(dir, 'site');
  await addGhost(nar, site, { id: 'k', index: false });
  await addGhost(nar, site, { id: 'k2' });
  const recordFile = path.join(site, ...R.KAWARI_RECORD.split('/'));
  const entries = [['ghost/master/runonce.txt', crc32(Buffer.from(saves['ghost/master/runonce.txt']))]];
  // a BOM: the record reads, the site checks out, and the next write is the bytes both tools write (no BOM)
  fs.writeFileSync(recordFile, Buffer.concat([BOM, fs.readFileSync(recordFile)]));
  assert.deepEqual([...readShipped(site)], [['k', entries], ['k2', entries]]);
  assert.equal((await checkSite(site)).ok, true);
  await removeGhost(site, 'k2');
  assert.ok(fs.readFileSync(recordFile).equals(shippedBytes(new Map([['k', entries]]))), 'written again without the BOM');

  const refused = problem => e => e instanceof AdminRefusal && e.code === 'kawari.record' && e.params.problem === problem
    && e.message === message('kawari.record', { problem });
  for (const [text, problem] of [['not json', 'record.json'], ['{"format": 1, "ghosts": {"k": [["ghost/master/runonce.txt", 1.0]]}}', 'record.entries'],
    ['{"format": 2, "ghosts": {}}', 'record.format']]) {
    fs.writeFileSync(recordFile, text);
    const before = treeOf(site);
    const [item] = await inspectSource(nar, { site, id: 'k3' });
    assert.deepEqual([item.refusal.code, item.refusal.params], ['kawari.record', { problem }], 'said before Add is pressed');
    await assert.rejects(addGhost(nar, site, { id: 'k3' }), refused(problem));
    await assert.rejects(addGhost(path.join(FIXTURES, 'testghost'), site, { id: 't' }), refused(problem), 'any ghost: every add sets its entries');
    await assert.rejects(addGhost(nar, site, { id: 'k', replace: true }), refused(problem));
    await assert.rejects(removeGhost(site, 'k'), refused(problem));
    await assert.rejects(indexSite(site), refused(problem));
    assert.deepEqual(treeOf(site), before, `${problem}: nothing changed`);
    const c = await checkSite(site);
    assert.deepEqual([c.ok, c.index, c.personal, c.record.code, c.record.params], [false, null, [], 'kawari.record', { problem }]);
  }
});

test('removeGhost deletes the ghost folder and re-indexes, and a junction inside it or in its place is removed as a link', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'remove-'));
  const site = path.join(dir, 'site');
  for (const id of ['a', 'b']) fs.cpSync(path.join(FIXTURES, 'testghost'), path.join(site, 'ghost', id), { recursive: true });
  await indexSite(site);
  const outside = path.join(dir, 'outside');
  put(path.join(outside, 'keep.txt'), 'must survive');
  fs.symlinkSync(outside, path.join(site, 'ghost', 'a', 'shell', 'linked'), 'junction');
  const check = await checkSite(site);
  assert.deepEqual(check.links.map(l => [l.path, l.code]), [['ghost/a/shell/linked', 'site.link']]);
  assert.equal(check.ok, false);
  const r = await removeGhost(site, 'a');
  assert.equal(r.link, false);
  assert.equal(fs.existsSync(path.join(site, 'ghost', 'a')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'must survive', 'not followed');
  assert.deepEqual(r.index.ids, ['b']);
  // a junction as the ghost folder: the link goes, its target stays
  fs.symlinkSync(path.join(site, 'ghost', 'b'), path.join(site, 'ghost', 'c'), 'junction');
  const r2 = await removeGhost(site, 'c', { index: false });
  assert.equal(r2.link, true);
  assert.ok(fs.existsSync(path.join(site, 'ghost', 'b', 'ghost', 'master', 'descript.txt')));
  await assert.rejects(removeGhost(site, 'nope'), e => e.code === 'ghost.missing');
  await assert.rejects(removeGhost(site, '..'), e => e.code === 'id.bad');
});

test('checkSite: a stale index, personal files and hub.json findings come as codes', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'check-'));
  const site = path.join(dir, 'site');
  fs.cpSync(path.join(FIXTURES, 'testghost'), path.join(site, 'ghost', 't'), { recursive: true });
  let c = await checkSite(site);
  assert.equal(c.index.upToDate, false);
  assert.ok(c.index.stale.some(s => s.path === 'sumika/index/ghosts.json' && s.code === 'index.missing'));
  await indexSite(site);
  c = await checkSite(site);
  assert.equal(c.ok, true, JSON.stringify(c));
  put(path.join(site, 'ghost', 't', 'ghost', 'master', 'x.txt'), 'new');
  c = await checkSite(site);
  assert.ok(c.index.stale.some(s => s.code === 'index.differs'));
  put(path.join(site, 'ghost', 't', 'ghost', 'master', 'yaya_variable.cfg'), 'SECRET');
  c = await checkSite(site);
  assert.equal(c.index, null);
  assert.deepEqual(c.personal.map(p => [p.path, p.code]), [['ghost/t/ghost/master/yaya_variable.cfg', 'personal.variable']]);
  await assert.rejects(indexSite(site), e => e.code === 'site.personal' && /refusing to index/.test(e.message));
  fs.rmSync(path.join(site, 'ghost', 't', 'ghost', 'master', 'yaya_variable.cfg'));
  put(path.join(site, 'sumika', 'hub.json'), JSON.stringify({ format: 1, origins: ['http://localhost:1', 'https://a.example.com/x'] }));
  c = await checkSite(site);
  assert.deepEqual(c.hub.problems.map(p => p.code), ['hub.loopback', 'hub.ignored']);
  assert.match(c.hub.problems[0].message, /loopback origin http:\/\/localhost:1/);
});

test('every code has an English text; a refusal and its files carry code, params and that text', () => {
  for (const code of CODE_LIST) assert.equal(typeof CODES[code]({ id: 'x', problem: 'name.dots', engine: 'AYA', path: 'p',
    file: 'f', label: 'l', archive: 'a', archiveName: 'a', count: 1, kept: 0, names: [], hits: [], paths: [], dst: 'd',
    method: 9, error: 'e', member: 'm', entry: 'e', why: 'w', pattern: 'p' }, []), 'string', code);
  for (const p of [...R.SKIP_FILES, ...R.PERSONAL_PATHS]) {
    const c = R.skipCode(p.replace(/\*/g, 'x'));
    assert.ok(c && CODE_LIST.includes(c.code), `${p}: ${JSON.stringify(c)}`);
  }
  const e = new AdminRefusal('compare.unlisted', { label: 'L', archive: 'A' }, [{ path: 'x', code: 'compare.notListed' }]);
  assert.deepEqual(e.toJSON().files, [{ path: 'x', code: 'compare.notListed', why: 'not listed' }]);
  assert.match(e.message, /^not copied: 1 file\(s\) of L are not in A as they are there/);
  assert.throws(() => message('no.such'), /no such code/);
});

test('admin/cli.mjs: statuses 0, 1 (a refusal, on stderr) and 2 (usage), as the Python tools; one run as a process', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'cli-'));
  const io = () => {
    const o = { out: [], err: [] };
    return [o, { out: l => o.out.push(l), err: t => o.err.push(t) }];
  };
  let [o, sink] = io();
  assert.equal(await cli(['add'], sink), 2);
  assert.match(o.err.join('\n'), /the following arguments are required: src/);
  [o, sink] = io();
  assert.equal(await cli(['add', path.join(dir, 'none'), '--site', path.join(dir, 's'), '--bogus', 'x'], sink), 2);
  [o, sink] = io();
  assert.equal(await cli(['add', path.join(dir, 'none'), '--site', path.join(dir, 's')], sink), 1);
  assert.match(o.err.join('\n'), /does not look like a ghost folder/);
  [o, sink] = io();
  assert.equal(await cli(['add', path.join(FIXTURES, 'testghost'), '--si', path.join(dir, 's'), '--id=t'], sink), 0, 'a prefix and --opt=value');
  assert.ok(fs.existsSync(path.join(dir, 's', 'ghost', 't', 'ghost', 'master', 'descript.txt')));
  [o, sink] = io();
  assert.equal(await cli(['check', path.join(dir, 's')], sink), 0, o.out.join('\n'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'admin', 'cli.mjs'), 'remove', 'nope', '--site', path.join(dir, 's')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such ghost folder/);
  assert.equal(r.stdout, '');
});

test('gzip of a pack as written: mtime 0 and OS byte 255, as Python heads it', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'gz-'));
  const site = path.join(dir, 'site');
  fs.cpSync(path.join(FIXTURES, 'testghost'), path.join(site, 'ghost', 't'), { recursive: true });
  await indexSite(site);
  const pack = fs.readdirSync(path.join(site, 'sumika', 'index')).find(n => n.endsWith('.pack.gz'));
  const gz = fs.readFileSync(path.join(site, 'sumika', 'index', pack));
  assert.equal(gz.subarray(0, 10).toString('hex'), '1f8b08000000000002ff');
  assert.ok(zlib.gunzipSync(gz).subarray(0, 4).equals(Buffer.from('SMKP')));
});

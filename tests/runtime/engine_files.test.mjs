// src/core/engine-files.js: what a root engine's worker gets (YAYA, Kawari: the whole ghost root, text with its bytes,
// everything else as an empty placeholder, personal files and DLLs never), YAYA's module name and the site as SSP
// shows it; paths resolved inside ghost/master, the personal files --param-input-file may never read, and the files
// the visitor's run wrote (kawari-wasm.md §12). Satori's list is runtime.js engineFileList's. The site's
// YAYA and Kawari packs hold what the worker reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { GhostFiles } from '../../src/core/loader.js';
import { engineFileList } from '../../src/core/runtime.js';
import { manifestOf } from '../index_files.mjs';
import {
  yayaFilePlan, yayaModule, yayaSite, YAYA_MAX_BYTES, YAYA_TEXT, YAYA_SKIP, masterRel, personalFile,
  rootFilePlan, rootEngine, ROOT_ENGINES, KAWARI_TEXT, KAWARI7_TEXT, KAWARI_SKIP, siteView, visitorFile,
} from '../../src/core/engine-files.js';
import { EmscriptenShiori } from '../../src/worker/engines/emscripten.js';
import { needs } from '../needs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MANIFEST = [
  ['install.txt', 10], ['readme.txt', 20], ['updates2.dau', 30], ['thumbnail.png', 400, 100, 100],
  ['ghost/master/descript.txt', 1], ['ghost/master/yaya.txt', 1], ['ghost/master/dic/base.dic', 1],
  ['ghost/master/dic/enc.AYC', 1], ['ghost/master/data/list.csv', 1], ['ghost/master/data/a.json', 1],
  ['ghost/master/data/b.yml', 1], ['ghost/master/music.m3u', 1], ['ghost/master/updates2.dau', 1],
  ['ghost/master/yaya.dll', 1], ['ghost/master/saori/foo.DLL', 1], ['ghost/master/tool.exe', 1],
  ['ghost/master/yaya_variable.cfg', 1], ['ghost/master/aya5_variable.cfg.ays', 1], ['ghost/master/ayame.log', 1],
  ['ghost/master/profile/x.dat', 1], ['shell/master/profile/shell.dat', 1], ['ghost/master/profile_notes.txt', 1],
  ['ghost/master/huge.dic', YAYA_MAX_BYTES + 1], ['ghost/master/edge.dic', YAYA_MAX_BYTES],
  ['ghost/master/var/notes.bin', 5], ['ghost/master/icon.ico', 5],
  ['shell/master/descript.txt', 1], ['shell/master/surface0.png', 1, 80, 120], ['shell/master/se.wav', 1],
  ['balloon/b/balloons0.png', 1, 10, 10], ['balloon/b/descript.txt', 1],
];
const files = () => new GhostFiles('http://s/ghost/yy/', MANIFEST);

test('YAYA files: the whole ghost root; text up to 4 MiB with its bytes, the rest as placeholders; profile/, saves, logs, DLLs and EXEs never', () => {
  const plan = yayaFilePlan(files());
  assert.deepEqual(plan.bytes, [
    'install.txt', 'readme.txt', 'updates2.dau', 'ghost/master/descript.txt', 'ghost/master/yaya.txt',
    'ghost/master/dic/base.dic', 'ghost/master/dic/enc.AYC', 'ghost/master/data/list.csv', 'ghost/master/data/a.json',
    'ghost/master/data/b.yml', 'ghost/master/music.m3u', 'ghost/master/updates2.dau', 'ghost/master/profile_notes.txt',
    'ghost/master/edge.dic', 'shell/master/descript.txt', 'balloon/b/descript.txt',
  ]);
  assert.deepEqual(plan.placeholders, [
    'thumbnail.png', 'ghost/master/huge.dic', 'ghost/master/var/notes.bin', 'ghost/master/icon.ico',
    'shell/master/surface0.png', 'shell/master/se.wav', 'balloon/b/balloons0.png',
  ]);
  const all = [...plan.bytes, ...plan.placeholders];
  for (const p of ['ghost/master/yaya.dll', 'ghost/master/saori/foo.DLL', 'ghost/master/tool.exe', 'ghost/master/yaya_variable.cfg',
    'ghost/master/aya5_variable.cfg.ays', 'ghost/master/ayame.log', 'ghost/master/profile/x.dat', 'shell/master/profile/shell.dat']) {
    assert.ok(!all.includes(p), p);
  }
  assert.deepEqual(yayaFilePlan(null), { bytes: [], placeholders: [] });
  assert.deepEqual(yayaFilePlan({ files: [{ path: 'a.txt' }] }).bytes, ['a.txt'], 'no size recorded: within the cap');
});

test('root plans: yayaFilePlan is rootFilePlan with YAYA\'s patterns; the root engines are YAYA, Kawari and Kawari 7, any case', () => {
  assert.deepEqual(yayaFilePlan(files()), rootFilePlan(files(), { text: YAYA_TEXT, skip: YAYA_SKIP }));
  assert.deepEqual(Object.keys(ROOT_ENGINES).sort(), ['kawari', 'kawari7', 'yaya']);
  assert.deepEqual(rootEngine('KAWARI7'), { text: KAWARI7_TEXT, skip: KAWARI_SKIP }, 'Phase 7: the Phase 8 set, .kdf and .dat');
  for (const p of ['a.txt', 'dictionary/base.kdf', 'data/system.dat', 'MAZE.DAT', 'kawari.ini', 'x.kis']) assert.ok(KAWARI7_TEXT.test(p), p);
  for (const p of ['a.kdf', 'a.dat']) assert.ok(!KAWARI_TEXT.test(p), `${p}: not Phase 8's`);
  assert.deepEqual(rootEngine('yaya'), { text: YAYA_TEXT, skip: YAYA_SKIP });
  assert.deepEqual(rootEngine('Kawari'), { text: KAWARI_TEXT, skip: KAWARI_SKIP });
  for (const e of ['satori', 'aya', '', null, undefined, 'constructor', '__proto__', 'toString']) {
    assert.equal(rootEngine(e), null, String(e));
  }
  assert.ok(Object.isFrozen(ROOT_ENGINES) && Object.isFrozen(ROOT_ENGINES.kawari));
  // a smaller cap
  assert.deepEqual(rootFilePlan({ files: [{ path: 'a.txt', size: 11 }, { path: 'b.txt', size: 10 }] }, { text: YAYA_TEXT, skip: YAYA_SKIP, max: 10 }),
    { bytes: ['b.txt'], placeholders: ['a.txt'] });
});

test('Kawari files (kawari-wasm.md §6): YAYA\'s text plus .kis and .kaw; the personal set (satori_save* too), logs, DLLs and EXEs never', () => {
  const man = new GhostFiles('http://s/ghost/kk/', [
    ['install.txt', 1], ['readme.txt', 1], ['ghost/master/descript.txt', 1], ['ghost/master/kawarirc.kis', 1],
    ['ghost/master/dict-keeps.KIS', 1], ['ghost/master/secret.kaw', 1], ['ghost/master/dict-keeps-savedata.txt', 1],
    ['ghost/master/brain/memories2.txt', 1], ['ghost/master/kawari.ini', 1], ['ghost/master/data.dau', 1],
    ['ghost/master/shiori.dll', 1], ['ghost/master/saori/bln.DLL', 1], ['ghost/master/tool.exe', 1],
    ['ghost/master/kawari.log', 1], ['ghost/master/satori_savedata.txt', 1], ['ghost/master/Satori_SaveBackup.txt', 1],
    ['ghost/master/yaya_variable.cfg', 1], ['ghost/master/profile/x.txt', 1], ['ghost/master/huge.kis', YAYA_MAX_BYTES + 1],
    ['ghost/master/sound/a.wav', 1], ['shell/master/descript.txt', 1], ['shell/master/surface0.png', 1, 10, 10],
  ]);
  const plan = rootFilePlan(man, rootEngine('kawari'));
  assert.deepEqual(plan.bytes, [
    'install.txt', 'readme.txt', 'ghost/master/descript.txt', 'ghost/master/kawarirc.kis', 'ghost/master/dict-keeps.KIS',
    'ghost/master/secret.kaw', 'ghost/master/dict-keeps-savedata.txt', 'ghost/master/brain/memories2.txt',
    'ghost/master/kawari.ini', 'ghost/master/data.dau', 'shell/master/descript.txt',
  ]);
  assert.deepEqual(plan.placeholders, ['ghost/master/huge.kis', 'ghost/master/sound/a.wav', 'shell/master/surface0.png']);
  // YAYA's plan differs: a .kis is no YAYA text, and YAYA does not skip satori_save*
  const yaya = yayaFilePlan(man);
  assert.ok(yaya.placeholders.includes('ghost/master/kawarirc.kis'));
  assert.ok(yaya.bytes.includes('ghost/master/satori_savedata.txt'));
  for (const ext of ['txt', 'dic', 'ayc', 'aym', 'ini', 'csv', 'dau', 'json', 'xml', 'yml', 'yaml', 'toml', 'htm', 'html', 'm3u']) {
    assert.equal(KAWARI_TEXT.test(`a.${ext}`), YAYA_TEXT.test(`a.${ext}`), ext);
  }
});

test('the site as SSP shows it: siteView, under its old name yayaSite too', () => {
  assert.equal(yayaSite, siteView);
});

test('files the visitor\'s run wrote (kawari-wasm.md §12): a stored key with bytes, resolved and in any case; root keys and Satori\'s', () => {
  const b = new ArrayBuffer(1);
  const root = { 'ghost/master/savefile1.txt': b, 'ghost/master/var/dl.txt': b, 'ghost/master/dic/gone.kis': null, '?kawari/resume.kis': b, 'readme.txt': b };
  for (const p of ['savefile1.txt', 'SaveFile1.TXT', 'x/../savefile1.txt', '.\\var\\dl.txt', 'var//dl.txt/.']) {
    assert.equal(visitorFile(root, p, 'ghost/master/'), true, p);
  }
  for (const p of ['dic/gone.kis', 'kawarirc.kis', 'readme.txt', '?kawari/resume.kis', 'ghost/master/savefile1.txt']) {
    assert.equal(visitorFile(root, p, 'ghost/master/'), false, p);
  }
  assert.equal(visitorFile(root, '../outside.txt', 'ghost/master/'), true, 'nothing inside ghost/master');
  assert.equal(visitorFile(root, '', 'ghost/master/'), true);
  const satori = { 'var/dl.txt': b, 'satori_savedata.txt': b };
  assert.equal(visitorFile(satori, 'var/dl.txt'), true);
  assert.equal(visitorFile(satori, 'VAR\\DL.TXT'), true);
  assert.equal(visitorFile(satori, 'dic01.txt'), false);
  assert.equal(visitorFile(null, 'a.txt'), false);
  assert.equal(visitorFile({}, 'a.txt', 'ghost/master/'), false);
});

test('Satori\'s engine file list is unchanged: ghost/master text only, no .ayc, .dau, .json, saves or logs', () => {
  assert.deepEqual(engineFileList(files()), [
    'descript.txt', 'yaya.txt', 'dic/base.dic', 'data/list.csv', 'profile_notes.txt', 'huge.dic', 'edge.dic',
  ]);
});

test('YAYA module: the index\'s module, else the stem of the shiori DLL (case kept), else yaya', () => {
  assert.equal(yayaModule({ shiori: 'yaya.dll', engine: 'yaya', module: 'yaya' }), 'yaya');
  assert.equal(yayaModule({ shiori: 'aya5.dll', engine: 'yaya' }), 'aya5');
  assert.equal(yayaModule({ shiori: 'Foo.DLL' }), 'Foo');
  assert.equal(yayaModule({ shiori: 'lang_switch.dll', module: 'yaya_jp' }), 'yaya_jp', 'the sweep\'s override');
  assert.equal(yayaModule({ shiori: 'aya5.dll', module: '  ' }), 'aya5');
  assert.equal(yayaModule({ shiori: 'bin\\aya.dll' }), 'aya');
  assert.equal(yayaModule({}), 'yaya');
  assert.equal(yayaModule(null), 'yaya');
});

test('YAYA site view: every ghost\'s names and DLL, one line each, and the balloon ids', () => {
  const index = {
    ghosts: [
      { id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', craftman: 'Macaroni', shiori: 'satori.dll', engine: 'satori', shells: [] },
      { id: 'emily4', name: 'Emily/Phase4.5\r\nevil', sakuraName: 'Emily', keroName: 'Teddy\n', craftman: null, shiori: 'yaya.dll', module: 'yaya' },
      { name: 'no id' },
    ],
    balloons: [{ id: 'LightBlue', name: 'LightBlue', ghost: 'tsubasa' }, { id: 'sumika', name: 'Sumika' }, {}],
  };
  assert.deepEqual(yayaSite(index), {
    ghosts: [
      { id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', craftman: 'Macaroni', shiori: 'satori.dll' },
      { id: 'emily4', name: 'Emily/Phase4.5evil', sakuraName: 'Emily', keroName: 'Teddy', craftman: '', shiori: 'yaya.dll' },
    ],
    balloons: ['LightBlue', 'sumika'],
  });
  assert.deepEqual(yayaSite(null), { ghosts: [], balloons: [] });
  assert.doesNotThrow(() => JSON.stringify(yayaSite(index)), 'plain JSON for the worker message');
});

test('paths inside ghost/master as the engine resolves them; a personal file stays personal however it is spelled', () => {
  const eng = new EmscriptenShiori({ engineUrl: 'x', ghostDir: '/ghost/master/' });
  const cases = [
    ['var/a.txt', 'var/a.txt'], ['var\\..\\yaya.txt', 'yaya.txt'], ['./a//b/./c', 'a/b/c'], ['a/', 'a'],
    ['../x', null], ['a/../../x', null], ['', null], ['./', null], [null, null],
  ];
  for (const [rel, want] of cases) {
    assert.equal(masterRel(rel), want, String(rel));
    assert.equal(eng.masterPath(rel), want == null ? null : `/ghost/master/${want}`, `masterPath ${rel}`);
  }
  for (const p of ['yaya_variable.cfg', 'yaya_variable.cfg/', 'yaya_variable.cfg/.', './satori_savedata.txt/',
    'x/../aya5_variable.cfg//', 'YAYA_VARIABLE.CFG', 'dic\\..\\satori_savebackup.txt', 'profile/ghost.dat',
    'a/../profile//x', 'ayame.log/.', '../outside.txt', '', './']) {
    assert.equal(personalFile(p), true, p);
  }
  for (const p of ['post.txt', 'var/bonsyou_now.txt', 'profile_notes.txt', 'dic/variable.dic', 'logs/a.txt']) {
    assert.equal(personalFile(p), false, p);
  }
});

test('a root engine ghost\'s text pack holds every file its worker gets with bytes (index_site.py YAYA_PACK_EXT = YAYA_TEXT, KAWARI_PACK_EXT = KAWARI_TEXT, KAWARI7_PACK_EXT = KAWARI7_TEXT, ROOT_PACK_EXT = ROOT_ENGINES)', needs('site/ghost/emily4', 'site/ghost/nodepsimoon', 'site/ghost/bonsyou'), () => {
  const py = fs.readFileSync(path.join(root, 'tools', 'index_site.py'), 'utf8');
  for (const [name, re] of [['YAYA_PACK_EXT', YAYA_TEXT], ['KAWARI_PACK_EXT', KAWARI_TEXT], ['KAWARI7_PACK_EXT', KAWARI7_TEXT]]) {
    const m = new RegExp(`^${name} = re\\.compile\\(r'([^']+)', re\\.I\\)`, 'm').exec(py);
    assert.ok(m, `${name} in tools/index_site.py`);
    assert.equal(m[1], re.source, name);
    assert.equal(re.flags, 'i');
  }
  const pe = /^ROOT_PACK_EXT = \{([^}]*)\}/m.exec(py);
  assert.ok(pe, 'ROOT_PACK_EXT in tools/index_site.py');
  const pairs = [...pe[1].matchAll(/'(\w+)':\s*(\w+)/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(pairs, [['yaya', 'YAYA_PACK_EXT'], ['kawari', 'KAWARI_PACK_EXT'], ['kawari7', 'KAWARI7_PACK_EXT']]);
  assert.deepEqual(pairs.map(p => p[0]), Object.keys(ROOT_ENGINES));
  const index = JSON.parse(fs.readFileSync(path.join(root, 'site', 'sumika', 'index', 'ghosts.json'), 'utf8'));
  const ghosts = index.ghosts.filter(g => rootEngine(g.engine));
  assert.ok(ghosts.filter(g => g.engine === 'yaya').length >= 3, 'the site\'s YAYA ghosts');
  for (const g of ghosts) {       // Kawari ghosts too, once the site has one
    const man = manifestOf(path.join(root, 'site'), 'ghost', g.id, index);      // ghosts.json `manifests` names it
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(root, 'site', man.pack)));
    const packed = new Set(JSON.parse(raw.subarray(8, 8 + raw.readUInt32LE(4)).toString('utf8')).files.map(e => e[0].toLowerCase()));
    const plan = rootFilePlan(new GhostFiles(`http://s/ghost/${g.id}/`, man.files), rootEngine(g.engine));
    assert.deepEqual(plan.bytes.filter(p => !packed.has(p.toLowerCase())), [], `${g.id}: fetched one by one`);
  }
});

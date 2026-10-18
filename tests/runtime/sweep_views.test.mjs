// The ghost sweep's stand-ins (tools/sweep/views.mjs, docs/research/ghost-sweep.md): its ghost entry lists shells
// with tools/index_site.py's rules (names, `hidden`, SSP's name order, the default shell) and finds the engine with
// the index's rule (detectEngine: YAYA's module, AYA4, Kawari's phase; sweepEngine's sweep-only additions), and its
// view switcher swaps shells and balloons through the event loop's real path (EV §2.6, BA §12), so a ghost's own
// \![change,shell|balloon] switches in the sweep as on the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeText, parseDescript } from '../../src/core/loader.js';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import {
  shellEntries, ghostEntry, viewSwitcher, configDics, ayaConfigKind, detectEngine, sweepEngine,
} from '../../tools/sweep/views.mjs';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, deferred, settle } from './fakes.mjs';
import { needs } from '../needs.mjs';

setLogLevel('silent');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A ghost folder as views.mjs reads it (list, has, text, bytes), from {path: text (UTF-8) | Uint8Array}. */
function memFiles(map, read = k => map[k], readBytes = null) {
  const paths = Object.keys(map);
  const find = p => paths.find(x => x.toLowerCase() === String(p).toLowerCase());
  const real = p => {
    const k = find(p);
    if (k === undefined) throw new Error(`no such file ${p}`);
    return k;
  };
  const raw = k => {
    if (readBytes) return readBytes(k);
    const v = read(k);
    return v instanceof Uint8Array ? v : new TextEncoder().encode(v);
  };
  return {
    list(prefix = '') {
      const pre = prefix ? prefix.toLowerCase() + '/' : '';
      return paths.filter(p => p.toLowerCase().startsWith(pre));
    },
    has: p => find(p) !== undefined,
    async text(p) {
      const v = read(real(p));
      return v instanceof Uint8Array ? decodeText(v) : v;
    },
    async bytes(p) {
      const b = raw(real(p));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

/** A folder on disk the same way (text decoded like the runtime: BOM, charset line, else Shift_JIS). */
function diskFiles(dir) {
  const map = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else map[rel + e.name] = true;
    }
  })(dir, '');
  const file = k => fs.readFileSync(path.join(dir, k));
  return memFiles(map, k => decodeText(file(k)), file);
}

test('sweep ghost entry: shells as the indexer lists them (names, hidden, master/surface without descript) in SSP\'s name order', async () => {
  const files = memFiles({
    'ghost/master/descript.txt': 'charset,UTF-8\nname,G\nshiori,satori.dll\n',
    'shell/alt/descript.txt': 'name,Winter\n',
    'shell/master/descript.txt': 'name,master\n',
    'shell/noname/descript.txt': 'type,shell\n',
    'shell/secret/descript.txt': 'name,Secret\nmenu,hidden\n',
    'shell/surface/surface0.png': '',
    'shell/loose/surface0.png': '',
  });
  const shells = await shellEntries(files);
  assert.deepEqual(shells, [
    { id: 'noname', name: 'default' },
    { id: 'surface', name: 'Default' },
    { id: 'master', name: 'master' },
    { id: 'secret', name: 'Secret', hidden: true },
    { id: 'alt', name: 'Winter' },
  ], 'by name (any case), ties by folder; a folder without a descript only as master/ or surface/');
  const { entry } = await ghostEntry(files, 'g');
  assert.equal(entry.defaultShell, 'master', 'no seriko.defaultsurfacedirectoryname: master');
  assert.deepEqual(entry.shells, shells);
});

test('sweep ghost entry: the default shell is seriko.defaultsurfacedirectoryname (any case), never a `default.shell` key', async () => {
  const base = { 'shell/alt/descript.txt': 'name,Winter\n', 'shell/master/descript.txt': 'name,master\n' };
  const named = memFiles({ ...base, 'ghost/master/descript.txt': 'name,G\nseriko.defaultsurfacedirectoryname,ALT\n' });
  assert.equal((await ghostEntry(named, 'g')).entry.defaultShell, 'alt');
  const old = memFiles({ ...base, 'ghost/master/descript.txt': 'name,G\ndefault.shell,alt\n' });
  assert.equal((await ghostEntry(old, 'g')).entry.defaultShell, 'master', 'SSP has no default.shell key');
  const noMaster = memFiles({ 'ghost/master/descript.txt': 'name,G\n', 'shell/b/descript.txt': 'name,Beta\n', 'shell/a/descript.txt': 'name,Zed\n' });
  assert.equal((await ghostEntry(noMaster, 'g')).entry.defaultShell, 'b', 'else the first by name');
});

// the site this test was written against: 10 ghosts or more, YAYA ones among them
const SITE = ['bonsyou', 'bthver.5', 'emily4', 'etherism', 'hayato', 'katari', 'like_a_cat', 'machimaki', 'mayura', 'nato',
  'nodepsimoon', 'roommate', 'tsubasa', 'waha'];
test('sweep ghost entry: every site ghost gets the engine, module, tray icons, shells, default shell and balloons ghosts.json has (but the menu thumbnails)', needs(...SITE.map(id => `site/ghost/${id}`)), async () => {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'sumika', 'index', 'ghosts.json'), 'utf8'));
  assert.ok(index.ghosts.length >= 10);
  assert.ok(index.ghosts.some(g => g.engine === 'yaya'), 'the site has YAYA ghosts (emily4, bonsyou, nodepsimoon)');
  for (const g of index.ghosts) {
    const { entry } = await ghostEntry(diskFiles(path.join(ROOT, 'site', 'ghost', g.id)), g.id);
    assert.equal(entry.engine, g.engine, `${g.id}: engine`);
    assert.equal(entry.module, g.module, `${g.id}: module`);
    assert.equal('module' in entry, 'module' in g, `${g.id}: module only on YAYA entries`);
    // the tray icons (index_site.py ghost_icons = trayicon.js ghostIcons, UI §2.6), each only when found
    assert.equal(entry.icon, g.icon, `${g.id}: icon`);
    assert.equal(entry.iconMinimize, g.iconMinimize, `${g.id}: iconMinimize`);
    // `thumbnails` is for the menu's thumbnail window (UI §2.14): the headless sweep has no menu
    const noThumbs = list => (list || []).map(({ thumbnails, ...rest }) => rest);
    assert.deepEqual(entry.shells, noThumbs(g.shells), `${g.id}: shells`);
    assert.equal(entry.defaultShell, g.defaultShell, `${g.id}: default shell`);
    assert.deepEqual(entry.bundledBalloons, noThumbs(g.bundledBalloons), `${g.id}: bundled balloons`);
    assert.equal(entry.balloon, g.balloon, `${g.id}: balloon`);
  }
});

// ---------------------------------------------------------------- the engine (index_site.py detect_engine's rule)

const REQUEST = 'request\n{\n  "SHIORI/3.0 204 No Content\\r\\n\\r\\n"\n}\n';
const ON_REQUEST = 'OnRequest\n{\n  "x"\n}\n';
const desc = shiori => `charset,UTF-8\nname,G\n${shiori == null ? '' : `shiori,${shiori}\n`}`;
const ghost = (shiori, more = {}) => memFiles({ 'ghost/master/descript.txt': desc(shiori), ...more });
const detect = async files => detectEngine(files, parseDescript(await files.text('ghost/master/descript.txt')));

test('detectEngine: the AYA family by the config\'s dictionaries; YAYA\'s module is the DLL\'s stem, case kept', async () => {
  const yaya = { 'ghost/master/yaya.txt': 'charset,UTF-8\ndic,dic/base.dic\n', 'ghost/master/dic/base.dic': REQUEST };
  assert.deepEqual(await detect(ghost('yaya.dll', yaya)), { engine: 'yaya', module: 'yaya' });
  assert.deepEqual(await detect(ghost('aya5.dll', { 'ghost/master/aya5.txt': 'dic,a.dic\n', 'ghost/master/a.dic': REQUEST })),
    { engine: 'yaya', module: 'aya5' }, 'umeici\'s AYA5 runs on YAYA');
  assert.deepEqual(await detect(ghost('aya.dll', { 'ghost/master/aya.txt': 'dic,a.dic\n', 'ghost/master/a.dic': ON_REQUEST })),
    { engine: 'aya' }, 'AYA4: OnRequest only');
  assert.deepEqual(await detect(ghost('Foo.DLL', { 'ghost/master/foo.txt': 'DIC , x.dic\n', 'ghost/master/X.dic': 'request : nonoverlap\n{\n}\n' })),
    { engine: 'yaya', module: 'Foo' }, 'a renamed DLL; the config and keys in any case');
  assert.deepEqual(await detect(ghost('ghost\\master\\yaya.dll', yaya)), { engine: 'yaya', module: 'yaya' }, 'a folder in the line');
  assert.deepEqual(await detect(ghost('aya.dll', { 'ghost/master/aya.txt': 'dic,a.dic\n', 'ghost/master/a.dic': ON_REQUEST + REQUEST })),
    { engine: 'yaya', module: 'aya' }, 'request wins over OnRequest');
});

test('detectEngine: everything else keeps the DLL\'s lower-cased stem (no module)', async () => {
  const req = { 'ghost/master/satori.txt': 'dic,a.dic\n', 'ghost/master/a.dic': REQUEST };
  assert.deepEqual(await detect(ghost('satori.dll', req)), { engine: 'satori' }, 'a Satori ghost with a stray satori.txt');
  for (const dll of ['lang_switch.dll', 'gcore.dll']) {
    const stem = dll.slice(0, -4);
    assert.deepEqual(await detect(ghost(dll, { [`ghost/master/${stem}.txt`]: 'dic,a.dic\n', 'ghost/master/a.dic': REQUEST })), { engine: stem });
  }
  assert.deepEqual(await detect(ghost('shiori.dll')), { engine: 'shiori' }, 'no config');
  assert.deepEqual(await detect(ghost(null)), { engine: 'shiori' }, 'no shiori line counts as shiori.dll');
  assert.deepEqual(await detect(ghost('Kawari.DLL', { 'ghost/master/kawari.txt': 'not a config\n' })), { engine: 'kawari7' },
    'a kawari* stem without kawarirc.kis: nothing Kawari 8.2.8 could load');
  assert.deepEqual(await detect(ghost('yaya.dll', { 'ghost/master/yaya.txt': '// nothing listed\ncharset,UTF-8\n' })), { engine: 'yaya' },
    'a config that lists no dictionary: no module (the runtime falls back to the stem)');
});

test('detectEngine: dictionaries that define neither (request only in an encrypted .ayc) are YAYA only for yaya.dll / aya5.dll', async () => {
  const ayc = { 'ghost/master/a.dic': '// only helpers\nOnBoot\n{\n}\n', 'ghost/master/sec.ayc': REQUEST };
  for (const stem of ['yaya', 'aya5', 'foo']) {
    const files = ghost(`${stem}.dll`, { ...ayc, [`ghost/master/${stem}.txt`]: 'dic,a.dic\ndic,sec.ayc\n' });
    assert.equal(await ayaConfigKind(files, stem), 'unknown', 'the .ayc is not read');
    assert.deepEqual(await detect(files), stem === 'foo' ? { engine: 'foo' } : { engine: 'yaya', module: stem });
  }
  const missing = ghost('yaya.dll', { 'ghost/master/yaya.txt': 'dic,gone.dic\ndicif,also_gone.dic\n' });
  assert.deepEqual(await configDics(missing, 'yaya'), ['ghost/master/gone.dic'], 'dic lists a missing file, dicif does not');
  assert.deepEqual(await detect(missing), { engine: 'yaya', module: 'yaya' });
});

test('detectEngine: the config walk follows include, includeEX (its own folder), dicdir and its loading order', async () => {
  const files = ghost('yaya.dll', {
    'ghost/master/yaya.txt': 'include, system/conf.txt\nincludeEX,sub/conf.txt\ndicdir,dics\ninclude,yaya.txt\ndic,../../../x.dic\n',
    'ghost/master/system/conf.txt': 'dic,system/a.dic\n',
    'ghost/master/system/a.dic': 'x',
    'ghost/master/sub/conf.txt': 'dic,b.dic\ninclude,more.txt\n',
    'ghost/master/sub/b.dic': 'x',
    'ghost/master/sub/more.txt': 'dic,c.dic\n',
    'ghost/master/dics/d.dic': 'x',
    'ghost/master/dics/old.dic.bak': REQUEST,
    'ghost/master/dics/sub/e.dic': 'x',
    'ghost/master/dics/sub.tmp/f.dic': REQUEST,
  });
  assert.deepEqual(await configDics(files, 'yaya'), [
    'ghost/master/system/a.dic', 'ghost/master/sub/b.dic', 'ghost/master/sub/c.dic', 'ghost/master/dics/d.dic', 'ghost/master/dics/sub/e.dic',
  ], 'include keeps the folder, includeEX takes its own; *.bak / *.tmp skipped; a loop and a path out of the ghost ignored');
  assert.equal(await ayaConfigKind(files, 'yaya'), 'unknown');
  const ordered = ghost('yaya.dll', {
    'ghost/master/yaya.txt': 'dicdir,ordered\n', 'ghost/master/ordered/_loading_order.txt': 'dic,g.dic\n',
    'ghost/master/ordered/g.dic': 'x', 'ghost/master/ordered/h.dic': REQUEST,
  });
  assert.deepEqual(await configDics(ordered, 'yaya'), ['ghost/master/ordered/g.dic'], 'the loading order, read as includeEX, decides');
  assert.equal(await ayaConfigKind(ordered, 'yaya'), 'unknown');
  const charset = ghost('yaya.dll', { 'ghost/master/yaya.txt': 'dicdir,ordered,UTF-8\n', 'ghost/master/ordered/_loading_order.txt': 'x',
    'ghost/master/ordered/g.dic': 'x' });
  assert.deepEqual(await configDics(charset, 'yaya'), ['ghost/master/ordered/_loading_order.txt', 'ghost/master/ordered/g.dic'],
    'with a charset the folder is read whole');
});

test('detectEngine: comments as YAYA strips them (//, /* … */ across lines, not inside quotes); configs in UTF-8 with a BOM or CP932', async () => {
  const kind = text => ayaConfigKind(ghost('foo.dll', { 'ghost/master/foo.txt': 'dic,a.dic\n', 'ghost/master/a.dic': text }), 'foo');
  assert.equal(await kind('// request\n/*\nrequest\n{\n*/\nOnBoot { "x" }\n'), 'unknown');
  assert.equal(await kind('x = "/*"\nrequest // the entry point\n{\n}\n'), 'yaya', 'a /* in a string starts no comment');
  assert.equal(await kind('/* a */ request {\n'), 'yaya');
  assert.equal(await kind('requests\n{\n}\n_request\n{\n}\nRequest\n{\n}\n'), 'unknown', 'the exact name, case-sensitive');
  assert.equal(await kind('\ufeffrequest\r\n{\r\n}\r\n'), 'yaya', 'a BOM before the first line');
  assert.equal(await kind(new Uint8Array([0x82, 0xa0, 0x0d, 0x0a, ...new TextEncoder().encode('\trequest\t:\tall\n{\n}\n')])), 'yaya',
    'CP932 bytes before it');
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('// 設定\r\ndic,a.dic\r\n')]);
  const sjis = new Uint8Array([0x2f, 0x2f, 0x20, 0x90, 0xdd, 0x92, 0xe8, 0x0d, 0x0a, ...new TextEncoder().encode('dic , a.dic // x\r\n')]);
  for (const config of [bom, sjis]) {
    const files = ghost('foo.dll', { 'ghost/master/foo.txt': config, 'ghost/master/a.dic': REQUEST });
    assert.deepEqual(await configDics(files, 'foo'), ['ghost/master/a.dic']);
  }
  assert.equal(await kind('/* never closed\nrequest\n{\n}\n'), 'unknown');
});

// Kawari (kawari-wasm.md §12): the corpus' 26 Kawari ghosts all say shiori.dll or nothing; their files tell the phase.
const RC = { 'ghost/master/kawarirc.kis': '=kis\nload dict.txt\n=end\n' };
const INI = { 'ghost/master/kawari.ini': 'dict : dict.txt\n' };

test('detectEngine: Kawari by its files: ghost/master/kawarirc.kis is Phase 8 (kawari), kawari.ini alone Phase 7 (kawari7)', async () => {
  assert.deepEqual(await detect(ghost('shiori.dll', RC)), { engine: 'kawari' }, 'shiori.dll + kawarirc.kis (BTHver.5)');
  assert.deepEqual(await detect(ghost(null, RC)), { engine: 'kawari' }, 'no shiori line (17 of the 26)');
  assert.deepEqual(await detect(ghost('shiori.dll', { ...RC, ...INI })), { engine: 'kawari' },
    'both: Phase 8 reads only kawarirc.kis (Aria\'s leftover kawari.ini, brynhild\'s compatibility layer)');
  assert.deepEqual(await detect(ghost('shiori.dll', INI)), { engine: 'kawari7' }, 'kawari.ini alone: Phase 7, SHIORI/2.x (nijino)');
  assert.deepEqual(await detect(ghost(null, INI)), { engine: 'kawari7' });
  assert.deepEqual(await detect(ghost(null, { 'Ghost/Master/KAWARIRC.KIS': 'x' })), { engine: 'kawari' }, 'the file in any case');
  assert.deepEqual(await detect(ghost('Shiori.DLL', { 'ghost/master/Kawari.INI': 'x' })), { engine: 'kawari7' }, 'the line in any case');
  assert.deepEqual(await detect(ghost('ghost\\master\\shiori.dll', RC)), { engine: 'kawari' }, 'a folder in the line');
  for (const dll of ['kawari.dll', 'kawari8.dll', 'KawariRC.dll']) {
    assert.deepEqual(await detect(ghost(dll, RC)), { engine: 'kawari' }, dll);
    assert.deepEqual(await detect(ghost(dll, INI)), { engine: 'kawari7' }, `${dll} + kawari.ini`);
    assert.deepEqual(await detect(ghost(dll)), { engine: 'kawari7' }, `${dll} alone: nothing 8.2.8 could load`);
  }
  assert.deepEqual(await detect(ghost('shiori.dll', { 'ghost/master/dict/kawarirc.kis': 'x', 'kawari.ini': 'x', 'ghost/kawarirc.kis': 'x' })),
    { engine: 'shiori' }, 'only ghost/master itself counts; shiori.dll with neither stays shiori');
  const { entry } = await ghostEntry(ghost(null, RC), 'g');
  assert.equal(entry.engine, 'kawari');
  assert.equal('module' in entry, false, 'no module');
});

test('detectEngine: the Kawari rule comes after the AYA probe and only for shiori / kawari* stems', async () => {
  assert.deepEqual(await detect(ghost('satori.dll', RC)), { engine: 'satori' }, 'snow girl: a Satori ghost that calls Kawari as a SAORI');
  assert.deepEqual(await detect(ghost('misaka.dll', { ...RC, ...INI })), { engine: 'misaka' });
  assert.deepEqual(await detect(ghost('kawari7.dll', RC)), { engine: 'kawari7' }, 'not a Kawari stem: the stem itself');
  assert.deepEqual(await detect(ghost('yaya.dll', { ...RC, 'ghost/master/yaya.txt': 'dic,a.dic\n', 'ghost/master/a.dic': REQUEST })),
    { engine: 'yaya', module: 'yaya' });
  assert.deepEqual(await detect(ghost('shiori.dll', { ...RC, 'ghost/master/shiori.txt': 'dic,a.dic\n', 'ghost/master/a.dic': REQUEST })),
    { engine: 'yaya', module: 'shiori' }, 'an AYA5 config wins');
  assert.deepEqual(await detect(ghost(null, { ...INI, 'ghost/master/shiori.txt': 'dic,a.dic\n', 'ghost/master/a.dic': ON_REQUEST })),
    { engine: 'aya' }, 'an AYA4 config wins');
  assert.deepEqual(await detect(ghost('shiori.dll', { ...RC, 'ghost/master/shiori.txt': 'dic,a.dic\n', 'ghost/master/a.dic': 'OnBoot\n{\n}\n' })),
    { engine: 'kawari' }, 'a config whose dictionaries define neither is no AYA ghost');
});

test('sweepEngine: the index rule, then Satori by DLL without a shiori line, then the proxies\' YAYA module; ghostEntry keeps the index rule', async () => {
  const run = async (files, dlls = []) => {
    const d = parseDescript(await files.text('ghost/master/descript.txt'));
    return [await sweepEngine(files, d, dlls), (await ghostEntry(files, 'g')).entry.engine];
  };
  assert.deepEqual(await run(ghost('satori.dll')), [{ engine: 'satori', by: 'descript' }, 'satori']);
  assert.deepEqual(await run(ghost(null), ['Satori.dll']), [{ engine: 'satori', by: 'dll' }, 'shiori']);
  assert.deepEqual(await run(ghost(null)), [{ engine: 'shiori', by: 'descript' }, 'shiori']);
  assert.deepEqual(await run(ghost('shiori.dll'), ['satori.dll']), [{ engine: 'shiori', by: 'descript' }, 'shiori'], 'only without a line');
  const yaya = { 'ghost/master/yaya.txt': 'dic,a.dic\n', 'ghost/master/a.dic': REQUEST };
  assert.deepEqual(await run(ghost('yaya.dll', yaya)), [{ engine: 'yaya', module: 'yaya', by: 'descript' }, 'yaya']);
  const lang = {
    'ghost/master/lang_switch_descript.txt': 'Chinese,yaya_cn.dll\r\nJapanese,yaya_jp.dll\r\n',
    'ghost/master/yaya_cn.txt': 'dic,dic_cn/a.dic\n', 'ghost/master/dic_cn/a.dic': REQUEST,
    'ghost/master/yaya_jp.txt': 'dic,dic_jp/a.dic\n', 'ghost/master/dic_jp/a.dic': REQUEST,
  };
  assert.deepEqual(await run(ghost('lang_switch.dll', lang)), [{ engine: 'yaya', module: 'yaya_jp', by: 'override' }, 'lang_switch']);
  const noJa = { ...lang, 'ghost/master/lang_switch_descript.txt': 'Chinese,yaya_cn.dll\r\n' };
  assert.deepEqual((await run(ghost('lang_switch.dll', noJa)))[0], { engine: 'yaya', module: 'yaya_cn', by: 'override' }, 'else the first');
  const aya4 = { ...lang, 'ghost/master/dic_jp/a.dic': ON_REQUEST };
  assert.deepEqual((await run(ghost('lang_switch.dll', aya4)))[0], { engine: 'lang_switch', by: 'descript' }, 'only for YAYA');
  const gcore = memFiles({
    'ghost/master/descript.txt': 'name,G\naishiori,aya.dll\nshiori,gcore.dll\nmakoto,gcorem.dll\n',
    'ghost/master/aya.txt': 'dic,aya_shiori3.dic\n', 'ghost/master/aya_shiori3.dic': REQUEST,
  });
  assert.deepEqual(await run(gcore, ['gcore.dll', 'aya.dll']), [{ engine: 'yaya', module: 'aya', by: 'override' }, 'gcore']);
  assert.deepEqual(await run(ghost('gcore.dll')), [{ engine: 'gcore', by: 'descript' }, 'gcore'], 'no aishiori');
  assert.deepEqual(await run(ghost('aya.dll', { 'ghost/master/aya.txt': 'dic,a.dic\n', 'ghost/master/a.dic': ON_REQUEST })),
    [{ engine: 'aya', by: 'descript' }, 'aya']);
  assert.deepEqual(await run(ghost(null, RC), ['shiori.dll']), [{ engine: 'kawari', by: 'descript' }, 'kawari']);
  assert.deepEqual(await run(ghost(null, RC), ['satori.dll']), [{ engine: 'kawari', by: 'descript' }, 'kawari'],
    'kawarirc.kis decides before the Satori-by-DLL rule');
  assert.deepEqual(await run(ghost(null, INI), ['shiori.dll']), [{ engine: 'kawari7', by: 'descript' }, 'kawari7'], 'Phase 7: not run');
});

// ---------------------------------------------------------------- the view switcher on a real EventLoop

const GHOST = {
  id: 'testghost', name: 'Test Ghost', sakuraName: 'Testy', keroName: '', defaultShell: 'master',
  shells: [{ id: 'master', name: 'master' }, { id: 'alt', name: 'Winter' }],
  bundledBalloons: [{ dir: 'own', name: 'Own' }], balloon: 'own',
};
const OWN = { id: 'own', name: 'Own', ghost: 'testghost' };

async function setup({ handler = () => null, gate = null } = {}) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const balloons = new FakeBalloons();
  const dialogs = new FakeDialogs();
  const site = { ghosts: [GHOST], balloons: [{ id: 'sumika', name: 'Sumika' }], defaultBalloon: 'sumika' };
  const ghostDescript = new Map([['name', 'Test Ghost'], ['sakura.name', 'Testy']]);
  const stage = new FakeStage();
  const loop = new EventLoop({
    shiori, player: new FakePlayer(), stage, balloons, dialogs, ghost: GHOST, clock, ghostDescript, site,
    state: new StateStore(GHOST.id, { storage: memoryStorage(), clock }), menu: { open() {}, close() {} },
    env: { win: null, doc: null }, sessionEpochMs: clock.now(), balloonName: 'Own', shell: { id: 'master', name: 'master' },
    paths: { shell: '/ghost/testghost/shell/master/', balloon: '/ghost/testghost/own/' },
  });
  const t = { clock, shiori, balloons, dialogs, loop, first: stage, made: [], notes: [], skins: [], cur: stage };
  const sw = viewSwitcher({
    loop, ghost: GHOST, ghostDescript, site, stage, balloons, dialogs, balloon: OWN,
    createStage: async (id, st) => {
      if (gate && !t.made.length) await gate;
      const s = new FakeStage();
      s.shellId = id;
      s.state = st;
      for (const c of s.chars.values()) c.surfaceId = -1;      // every character without a surface (swapStageState)
      t.made.push(s);
      return s;
    },
    loadSkin: async e => { t.skins.push(e.id); return { id: e.id }; },
    onStage: s => { t.cur = s; },
    note: c => t.notes.push(c),
  });
  t.sw = sw;
  loop.viewSwitcher = sw.request;
  await loop.boot({ resume: false });
  shiori.log.length = 0;
  return t;
}

test('sweep view switcher: a script\'s \\![change,shell,NAME] swaps through the loop (detach, new stage, attach, OnShellChanged)', async () => {
  const t = await setup();
  const p = t.loop.change('shell', ['Winter']);
  assert.ok(p && typeof p.then === 'function', 'the player waits at the tag');
  assert.equal(await p, true);
  assert.equal(t.made.length, 1);
  const alt = t.made[0];
  assert.equal(alt.shellId, 'alt');
  assert.equal(t.loop.stage, alt, 'loop.attachStage got the new stage');
  assert.equal(t.cur, alt);
  assert.ok(t.first.destroyed, 'the old stage is destroyed');
  assert.deepEqual(t.balloons.stages, [alt]);
  assert.deepEqual(t.dialogs.stages, [alt]);
  assert.equal(alt.state.shell, 'alt');
  assert.equal(alt.state.scopes[0].surface, -1, 'swapStageState: no surface until OnShellChanged');
  assert.deepEqual(t.shiori.find('OnNotifyShellInfo', 'NOTIFY')[0].refs.slice(0, 2), ['Winter', '/ghost/testghost/shell/alt/']);
  assert.deepEqual(t.shiori.find('OnShellChanged', 'GET')[0].refs, ['Winter', 'Test Ghost', '/ghost/testghost/shell/alt/']);
  assert.equal(t.shiori.find('OnShellChanging').length, 0, 'no raise-event: no OnShellChanging');
  assert.deepEqual([alt.char(0).surfaceId, alt.char(1).surfaceId], [0, 10], 'OnShellChanged 204: the old surfaces come back');
  assert.equal(t.loop.swapping, false);
  assert.deepEqual(t.notes, [{ kind: 'shell', target: 'Winter', fromScript: true, raiseEvent: false, result: 'switched', from: 'master', to: 'alt' }]);

  assert.equal(await t.loop.change('shell', ['alt']), false, 'a folder id is no name');
  assert.equal(await t.loop.change('shell', ['random']), false, 'random needs two other shells');
  assert.deepEqual(t.notes.slice(1).map(n => n.result), ['no such shell', 'no such shell']);
  assert.equal(t.made.length, 1);
});

test('sweep view switcher: balloons re-skin with OnBalloonChange; a shell brings back its remembered balloon silently', async () => {
  const t = await setup();
  assert.equal(await t.loop.change('balloon', ['Sumika']), true);
  assert.deepEqual(t.skins, ['sumika']);
  assert.deepEqual(t.balloons.skins, [{ id: 'sumika' }]);
  assert.deepEqual(t.dialogs.skins, [{ id: 'sumika' }]);
  assert.deepEqual(t.shiori.find('OnBalloonChange', 'GET')[0].refs, ['Sumika', '/balloon/sumika/']);
  assert.equal(t.shiori.find('OnNotifySelfInfo', 'NOTIFY')[0].refs[5], 'Sumika');
  assert.equal(await t.loop.change('shell', ['Winter']), true);
  assert.deepEqual(t.skins, ['sumika'], 'alt remembers nothing: the choice (sumika) stays');
  assert.equal(await t.loop.change('balloon', ['Own']), true);
  t.shiori.log.length = 0;
  assert.equal(await t.loop.change('shell', ['master']), true);
  assert.deepEqual(t.skins, ['sumika', 'own', 'sumika'], 'master remembers sumika');
  assert.equal(t.shiori.find('OnBalloonChange').length, 0, 'silently');
  assert.equal(t.shiori.find('OnNotifySelfInfo', 'NOTIFY')[0].refs[5], 'Sumika', 'OnNotifySelfInfo names it');
});

test('sweep view switcher: one change slot; a menu request meanwhile is refused, a script\'s waits for it', async () => {
  const gate = deferred();
  const t = await setup({ gate: gate.promise });
  const a = t.loop.changeShell('alt', { byId: true });              // a menu pick: OnShellChanging (204) first
  await settle();
  assert.equal(t.shiori.find('OnShellChanging', 'GET').length, 1);
  assert.equal(t.loop.swapping, true);
  assert.equal(await t.loop.changeShell('master', { byId: true }), false, 'menu: refused');
  const c = t.loop.change('shell', ['master']);                       // a script: waits
  await settle();
  assert.equal(t.made.length, 0);
  gate.resolve();
  assert.equal(await a, true);
  assert.equal(await c, true);
  assert.deepEqual(t.made.map(s => s.shellId), ['alt', 'master']);
  assert.equal(t.loop.stage.shellId, 'master');
  assert.deepEqual(t.notes.map(n => `${n.target} ${n.result}`), ['master refused: a change is under way', 'alt switched', 'master switched']);
});

test('sweep view switcher: \\![reload,shell] / \\![reload,balloon] (EV §2.10) swap to the ones in use with the NOTIFYs only, as the runtime', async () => {
  const t = await setup();
  const p = t.loop.reload('shell');
  assert.ok(p && typeof p.then === 'function', 'the player waits at the tag');
  assert.equal(await p, true);
  assert.deepEqual(t.made.map(s => s.shellId), ['master'], 'a new stage of the same shell');
  assert.ok(t.first.destroyed);
  assert.deepEqual([t.loop.stage.char(0).surfaceId, t.loop.stage.char(1).surfaceId], [0, 10], 'the surfaces come back');
  assert.equal(t.shiori.find('OnShellChanging').length + t.shiori.find('OnShellChanged').length, 0);
  assert.equal(t.shiori.find('OnNotifyShellInfo', 'NOTIFY').length, 1);
  t.shiori.log.length = 0;
  assert.equal(await t.loop.reload('balloon'), true);
  assert.deepEqual(t.skins, ['own'], 'the balloon in use loaded again');
  assert.deepEqual(t.shiori.ids(), ['NOTIFY OnNotifySelfInfo'], 'no OnBalloonChange');
  assert.deepEqual(t.notes.map(n => [n.kind, n.target, n.reload, n.result, n.from, n.to]),
    [['shell', '', true, 'switched', 'master', 'master'], ['balloon', '', true, 'switched', 'own', 'own']]);
});

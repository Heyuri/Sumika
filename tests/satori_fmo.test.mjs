// Satori's FMO view from the page (patch P8, satori-wasm.md §8): the real build reads Module.fmoText (set through the
// engine adapter's setFmo) wherever satori.dll reads SSP's "SakuraUnicode" FMO: （FMOn<key>）, （Xの存在）,
// （Xのサーフェス）. Its own entry is the one whose ghostpath + ghost/master/ is its folder (/ghost/master/), the others
// follow in id order. With no text the built-ins answer as without P8.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SatoriEngine } from '../src/worker/engines/satori.js';
import { saoriBridge } from '../src/worker/saori/index.js';
import { buildRequest, parseResponse } from '../src/core/shiori.js';
import { loadEngineFactory } from './load_engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'satori.js');
const available = fs.existsSync(ENGINE_JS);
const SKIP = { skip: !available && 'engine build missing', timeout: 60000 };

class NodeSatori extends SatoriEngine {
  async factory() { return loadEngineFactory('satori'); }
}

// one talk per kind of built-in; fields split by '|' (no punctuation: Satori would add waits)
const DIC = `＊OnName
：A（FMO0name）|（FMO1name）|（FMO2name）|（FMO3name）|（ＦＭＯ１ｎａｍｅ）|（FMO（calc,1+1）name）

＊OnKeys
：B（FMO1keroname）|（FMO1sakura.surface）|（FMO1kero.surface）|（FMO2kero.surface）|（FMO0sakura.surface）|（FMO0kero.surface）|（FMO0ghostpath）|（FMO1ghostpath）|（FMO1fullname）|（FMO1modulestate）|（FMO1path）|（FMO1hwnd）

＊OnExists
：C（なとの存在）|（なと太郎の存在）|（オマケの存在）|（テスト子の存在）|（謎の装置の存在）|（誰かの存在）|（ナの存在）

＊OnSurface
：D（なとのサーフェス）|（オマケのサーフェス）|（カタリのサーフェス）|（謎の装置のサーフェス）|（テスト子のサーフェス）|（誰かのサーフェス）
`;

async function boot() {
  const e = new NodeSatori({ engineUrl: ENGINE_JS, ghostDir: '/ghost/master/', log: () => {}, saori: saoriBridge });
  await e.boot();
  assert.ok(e.init([{ path: 'dic01.txt', data: new TextEncoder().encode(DIC).buffer }], {}, {}), 'load');
  return e;
}

const HEADERS = { Charset: 'UTF-8', Sender: 'SSP', SecurityLevel: 'local' };
/** The fields of one talk: the text after its letter, split on '|'. */
function talk(e, id) {
  const res = parseResponse(e.request(buildRequest({ id }, HEADERS)));
  const m = /\\0[A-D](.*)\\e$/.exec(res.value || '');
  assert.ok(m, `${id}: ${res.status} ${res.value}`);
  return m[1].split('|');
}

// the text as the page builds it (src/core/fmo.js): ids sort in slot order, keys in SSP's order, empty values left out
const ID = n => `ssp_fmo_header_00000000_${String(n).padStart(8, '0')}`;
function fmo(entries) {
  let t = '';
  for (const [n, e] of entries) {
    const kv = [['path', '/ssp/'], ['name', e.name], ['keroname', e.kero], ['sakura.surface', e.s0], ['kero.surface', e.s1],
      ['ghostpath', e.ghostpath], ['fullname', e.full], ['modulestate', 'shiori:running']];
    for (const [k, v] of kv) if (v !== '' && v !== undefined) t += `${ID(n)}.${k}\x01${v}\r\n`;
  }
  return t;
}
const NATO = { name: 'なと', kero: 'オマケ', s0: 0, s1: 10, ghostpath: '/ssp/ghost/nato/', full: 'なっとう' };
const SELF = { name: 'テスト子', kero: '', s0: 3, s1: -1, ghostpath: '/', full: 'testghost' };
const KATARI = { name: 'カタリ', kero: '謎の装置', s0: 5, s1: 15, ghostpath: '/ssp/ghost/katari/', full: 'カタリベカタリ' };
// the reader's id (…0001) sorts between the others: it is still FMO0, found by its ghostpath
const THREE = fmo([[0, NATO], [1, SELF], [2, KATARI]]);

test('no FMO text from the page: the FMO built-ins answer as without P8 ("", 0, -1)', SKIP, async () => {
  const e = await boot();
  assert.deepEqual(talk(e, 'OnName'), ['', '', '', '', '', '']);
  assert.deepEqual(talk(e, 'OnKeys'), ['', '', '', '', '', '', '', '', '', '', '', '']);
  assert.deepEqual(talk(e, 'OnExists'), ['0', '0', '0', '0', '0', '0', '0']);
  assert.deepEqual(talk(e, 'OnSurface'), ['-1', '-1', '-1', '-1', '-1', '-1']);
  e.unload();
});

test('the page\'s FMO: （FMOn<key>） with the reader first, the others in id order', SKIP, async () => {
  const e = await boot();
  e.setFmo(THREE);
  assert.deepEqual(talk(e, 'OnName'), ['テスト子', 'なと', 'カタリ', '', 'なと', 'カタリ'],
    'FMO0 the reader, 1 and 2 the others, 3 none; full-width digits and a computed index work');
  assert.deepEqual(talk(e, 'OnKeys'),
    ['オマケ', '0', '10', '15', '3', '-1', '/', '/ssp/ghost/nato/', 'なっとう', 'shiori:running', '/ssp/', ''],
    'every key as given; one the text leaves out (hwnd) is ""');
  e.unload();
});

test('the page\'s FMO: （Xの存在） and （Xのサーフェス） match the head of X against every name and kero name, the reader\'s too', SKIP, async () => {
  const e = await boot();
  e.setFmo(THREE);
  assert.deepEqual(talk(e, 'OnExists'), ['1', '1', '1', '1', '1', '0', '0'],
    'なと, なと太郎 (starts with なと), オマケ (a kero name), テスト子 (the reader), 謎の装置; not 誰か, not ナ');
  assert.deepEqual(talk(e, 'OnSurface'), ['0', '10', '5', '15', '3', '-1'], 'sakura.surface for a name, kero.surface for a kero name');
  e.unload();
});

test('the page\'s FMO: a text without the reader leaves FMO0 empty; a withdrawn text keeps the last list', SKIP, async () => {
  const e = await boot();
  e.setFmo(THREE);
  assert.equal(talk(e, 'OnName')[0], 'テスト子');
  e.setFmo(fmo([[0, NATO], [2, KATARI]]));
  assert.deepEqual(talk(e, 'OnName'), ['', 'なと', 'カタリ', '', 'なと', 'カタリ'], 'no entry with ghostpath "/": the others from 1');
  assert.deepEqual(talk(e, 'OnExists'), ['1', '1', '1', '0', '1', '0', '0'], 'the reader is no longer found');
  e.setFmo(fmo([[0, NATO]]));
  assert.deepEqual(talk(e, 'OnName'), ['', 'なと', '', '', 'なと', ''], 'a shorter text shortens the list');
  delete e.M.fmoText;                           // Satori cannot open the FMO: it keeps what it read last
  assert.deepEqual(talk(e, 'OnName'), ['', 'なと', '', '', 'なと', '']);
  e.setFmo(THREE);
  assert.equal(talk(e, 'OnName')[2], 'カタリ');
  e.setFmo(null);                               // the adapter withdraws it the same way
  assert.deepEqual(talk(e, 'OnName'), ['テスト子', 'なと', 'カタリ', '', 'なと', 'カタリ']);
  e.unload();
});

// The worker's engine adapter (src/worker/engines/*.js) driven directly in Node with Tsubasa's files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SatoriEngine } from '../src/worker/engines/satori.js';
import { saoriBridge } from '../src/worker/saori/index.js';
import { buildRequest, parseResponse } from '../src/core/shiori.js';
import { loadEngineFactory } from './load_engine.mjs';
import { needs } from './needs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GHOST = path.join(root, 'site', 'ghost', 'tsubasa', 'ghost', 'master');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'satori.js');
const TEXT = /\.(txt|dic|sat|ini|csv|aym)$/i;
const HEADERS = { Charset: 'UTF-8', Sender: 'SSP', SecurityLevel: 'local' };

class NodeSatori extends SatoriEngine {
  async factory() { return loadEngineFactory('satori'); }
}

function filesFrom(dir, filter = TEXT) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + '/');
      else if (filter.test(e.name) && !/^satori_save/i.test(e.name)) {
        const b = fs.readFileSync(p);
        out.push({ path: rel + e.name, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
      }
    }
  })(dir, '');
  return out;
}

function sjis(text) {
  // tiny Shift_JIS encoder for test dictionaries: build the table from the decoder
  const map = new Map();
  const dec = new TextDecoder('shift_jis');
  for (let a = 0x81; a <= 0xfc; a++) {
    if (a > 0x9f && a < 0xe0) continue;
    for (let b = 0x40; b <= 0xfc; b++) {
      if (b === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([a, b]));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [a, b]);
    }
  }
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (map.has(ch)) out.push(...map.get(ch));
    else out.push(0x3f);
  }
  return new Uint8Array(out).buffer;
}

async function engine(files, persisted = {}, opts = {}) {
  const logs = [];
  const e = new NodeSatori({ engineUrl: ENGINE_JS, ghostDir: '/ghost/master/', log: (l, t) => logs.push(`${l}: ${t}`), saori: saoriBridge });
  await e.boot();
  e.init(files, persisted, opts);
  e.logs = logs;
  return e;
}

const req = (e, id, refs = []) => parseResponse(e.request(buildRequest({ id, refs }, HEADERS)));

test('Tsubasa: boot, first meeting, save, resume without counting a boot', needs('site/ghost/tsubasa'), async () => {
  const e = await engine(filesFrom(GHOST));
  const ver = req(e, 'version');
  assert.match(ver.value, /^phase Mc\d/);
  assert.equal(req(e, 'OnBoot', ['master']).status, 200);
  assert.match(req(e, 'OnChoiceSelect', ['初回']).value, /Nice to meet you/);

  assert.equal(e.save(), true);
  const saved = e.changedFiles();
  assert.ok(saved['satori_savedata.txt'], 'save data written: ' + Object.keys(saved).join(','));
  const boots = t => (/＄起動回数\t(\S+)/.exec(new TextDecoder().decode(t)) || [])[1];
  const n1 = boots(saved['satori_savedata.txt']);
  assert.deepEqual(Object.keys(e.changedFiles()), [], 'nothing changed since');

  const vol = e.getVolatileState();
  assert.equal(typeof vol.talkCount, 'number');

  // page navigation: resume with the saved file -> boot count unchanged
  const e2 = await engine(filesFrom(GHOST), saved, { resume: true });
  e2.setVolatileState(vol);
  assert.equal(req(e2, 'OnSecondChange', ['0', '0', '0', '1', '0']).status >= 200, true);
  e2.save();
  const n2 = boots(e2.changedFiles()['satori_savedata.txt'] || saved['satori_savedata.txt']);
  assert.equal(n2, n1, 'a resume is not a boot');

  // a real restart counts one more boot
  const e3 = await engine(filesFrom(GHOST), saved, { resume: false });
  const files3 = e3.unload();
  assert.notEqual(boots(files3['satori_savedata.txt']), n1);
});

// P7 (SUMMARY §2.1): the engine's EM_JS clock reads Date.now once per worker, then performance.now (same realm:
// tests/load_engine.mjs). Both are faked: pass(ms) is time passing, step(ms) the visitor (or NTP) setting the date.
const clockFiles = () => [{ path: 'dic_clock.txt', data: sjis('＊OnClock\r\n：s=（単純起動秒）,h=（起動時）,m=（起動分）,t=（単純累計秒）\r\n') }];
const han = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const clock = e => Object.fromEntries([...han(req(e, 'OnClock').value).matchAll(/([a-z]+)=(\d+)/g)].map(([, k, v]) => [k, +v]));
const saved = (f, name) => +(new RegExp(`＄${name}\\t(\\d+)`).exec(new TextDecoder().decode(f['satori_savedata.txt'])) || [])[1];

async function withFakeClocks(fn) {
  const realNow = Date.now, realPerf = performance.now;
  const c = { wall: realNow(), mono: Math.floor(realPerf.call(performance)) };   // whole ms: exact float sums
  Date.now = () => c.wall;
  performance.now = () => c.mono;
  try {
    await fn({ c, pass: ms => { c.wall += ms; c.mono += ms; }, step: ms => { c.wall += ms; } });
  } finally {
    Date.now = realNow;
    performance.now = realPerf;
  }
}

test('P7 clock: （単純起動秒）/（起動時…） count from the cold boot across resumes and restarts; the saved total stays exact', () => withFakeClocks(async ({ c, pass }) => {
  const files = clockFiles;
  // a cold boot (a new tab, a ghost change): the clock starts at 0, the total at the saved one (none yet)
  const boot = c.wall;
  const e1 = await engine(files(), {}, { bootEpochMs: boot });
  assert.deepEqual(clock(e1), { s: 0, h: 0, m: 0, t: 0 });
  pass(600e3);                                             // ten minutes on that page
  assert.deepEqual(clock(e1), { s: 600, h: 0, m: 10, t: 600 });
  assert.equal(e1.save(), true);
  const save1 = e1.changedFiles();
  assert.equal(saved(save1, 'ゴースト起動時間累計秒'), 600);

  // the next page, 50 minutes later (the visitor was elsewhere): an hour since her boot; the total goes on from the
  // save. The resume's load time (3600) exceeds the saved total (600): the fold must not clamp it away
  pass(3000e3);
  const e2 = await engine(files(), save1, { resume: true, bootEpochMs: boot });
  assert.deepEqual(clock(e2), { s: 3600, h: 1, m: 0, t: 600 });
  pass(23 * 60e3 + 5e3);
  assert.deepEqual(clock(e2), { s: 4985, h: 1, m: 23, t: 1985 });
  e2.save();
  const save2 = { ...save1, ...e2.changedFiles() };
  assert.equal(saved(save2, 'ゴースト起動時間累計秒'), 1985);
  assert.equal(saved(save2, 'ゴースト起動時間累計ミリ秒'), 1985000);
  assert.equal(saved(save2, '起動回数'), saved(save1, '起動回数'), 'a resume is not a boot');

  // the engine restarted after a crash, 40 s after that save: the same clock; the total from the save
  pass(40e3);
  const e3 = await engine(files(), save2, { resume: true, bootEpochMs: boot });
  assert.deepEqual(clock(e3), { s: 5025, h: 1, m: 23, t: 1985 });

  // a later cold boot (back from another ghost): her clock starts again, the total and the boot count go on
  pass(7200e3);
  const e4 = await engine(files(), save2, { bootEpochMs: c.wall });
  assert.deepEqual(clock(e4), { s: 0, h: 0, m: 0, t: 1985 });
  pass(61e3);
  assert.deepEqual(clock(e4), { s: 61, h: 0, m: 1, t: 2046 });
  const save4 = e4.unload();
  assert.equal(saved(save4, 'ゴースト起動時間累計秒'), 2046);
  assert.equal(saved(save4, '起動回数'), saved(save1, '起動回数') + 1);
}));

test('P7 clock: monotonic within a page; setting the date ahead or back never reaches the saved total', () => withFakeClocks(async ({ c, pass, step }) => {
  const D = 30 * 86400e3;                                  // visitors set the date ahead to see seasonal talk
  const st = e => { const { s, t } = clock(e); return { s, t }; };
  const saveOf = e => {                                    // read the file itself: MEMFS mtimes follow the fake date
    assert.equal(e.save(), true);
    return { 'satori_savedata.txt': e.M.FS.readFile('/ghost/master/satori_savedata.txt').slice().buffer };
  };
  const total = f => saved(f, 'ゴースト起動時間累計秒');

  // within a page the clock runs on performance.now, like GetTickCount64 on SSP: date steps either way change nothing
  const boot = c.wall;
  const e1 = await engine(clockFiles(), {}, { bootEpochMs: boot });
  pass(600e3);
  assert.deepEqual(st(e1), { s: 600, t: 600 });
  step(+D);
  assert.deepEqual(st(e1), { s: 600, t: 600 }, 'a date set ahead adds nothing');
  pass(60e3);
  step(-2 * D);                                            // back past her cold boot
  assert.deepEqual(st(e1), { s: 660, t: 660 }, 'a date set back takes nothing and never wraps');
  pass(40e3);
  const save1 = saveOf(e1);
  assert.equal(total(save1), 700);

  // the next page with the date still behind: bootEpochMs lies in the future; the clock counts from this load
  pass(20e3);
  const e2 = await engine(clockFiles(), save1, { resume: true, bootEpochMs: boot });
  assert.deepEqual(st(e2), { s: 0, t: 700 });
  pass(100e3);
  assert.deepEqual(st(e2), { s: 100, t: 800 });
  const save2 = saveOf(e2);
  assert.equal(total(save2), 800);

  // the date set right between pages: since-load is back on her cold boot; the total goes on from the save
  step(+D);
  pass(10e3);
  const e3 = await engine(clockFiles(), save2, { resume: true, bootEpochMs: boot });
  assert.deepEqual(st(e3), { s: 830, t: 800 });
  pass(70e3);
  const save3 = saveOf(e3);
  assert.equal(total(save3), 870);

  // the date set ahead between pages: since-load reads the wall clock at a load, the total does not; then the date
  // set back on that page (resumed at c_r, saved total S: S - c_r must not wrap)
  step(+D);
  pass(10e3);
  const e4 = await engine(clockFiles(), save3, { resume: true, bootEpochMs: boot });
  assert.deepEqual(st(e4), { s: D / 1e3 + 910, t: 870 });
  pass(30e3);
  step(-D);
  assert.deepEqual(st(e4), { s: D / 1e3 + 940, t: 900 });
  pass(30e3);
  const save4 = saveOf(e4);
  assert.equal(total(save4), 930);

  // the next page: its clock (980) is below where the last page ended (D + 970): the total still only goes on
  pass(10e3);
  const e5 = await engine(clockFiles(), save4, { resume: true, bootEpochMs: boot });
  assert.deepEqual(st(e5), { s: 980, t: 930 });
  pass(20e3);
  const save5 = saveOf(e5);
  assert.equal(total(save5), 950);

  // a cold boot whose bootEpochMs lies in the future counts from 0 as well
  const e6 = await engine(clockFiles(), save5, { bootEpochMs: c.wall + D });
  assert.deepEqual(st(e6), { s: 0, t: 950 });
  pass(61e3);
  assert.deepEqual(st(e6), { s: 61, t: 1011 });
  assert.equal(total(e6.unload()), 1011);
}));

test('CP932 decoding matches Windows; SAORI calls reach JavaScript stand-ins', async () => {
  const dic = '＊OnZen\r\n：（zen2han、－５～）\r\n＊OnGomi\r\n：gomi=（gomi、-n）\r\n＊OnNone\r\n：none=[（nosuch、1）]\r\n＊OnChars\r\n：A～B－C―D＼E\r\n';
  const conf = '＠SAORI\r\ngomi,saori/gomi.dll\r\nnosuch,saori/nosuch.dll\r\n';
  const e = await engine([
    { path: 'dic_test.txt', data: sjis(dic) },
    { path: 'satori_conf.txt', data: sjis(conf) },
  ]);
  assert.match(req(e, 'OnZen').value, /-5~/);
  assert.match(req(e, 'OnGomi').value, /gomi=0/);
  assert.match(req(e, 'OnNone').value, /none=\[\]/, 'a SAORI without a stand-in expands to nothing');
  assert.match(req(e, 'OnChars').value, /A～B－C―D＼E/);
});

// S1/S2: the table and the invalid-pair rule of engines/common/gen_cp932.py, checked there against Windows' own
// conversions. satori.dll decodes with MultiByteToWideChar(932, 0) and encodes with WC_NO_BEST_FIT_CHARS. Tsubasa has
// no invalid pair and no IBM/NEC duplicate, and the worker asks in UTF-8, so satori_vs_dll cannot see either.
const cat = (...parts) => {
  const u8 = parts.map(p => (p instanceof ArrayBuffer ? new Uint8Array(p) : Uint8Array.from(p)));
  const out = new Uint8Array(u8.reduce((n, p) => n + p.length, 0));
  u8.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out.buffer;
};

/** A request in the engine's own bytes (the adapter always speaks UTF-8); the reply as bytes. */
function rawRequest(e, text) {
  const M = e.M;
  const b = new TextEncoder().encode(text);
  const p = e._toHeap(b);
  const lenp = M._malloc(4);
  M.HEAP32[lenp >> 2] = b.length;
  const r = M._request(p, lenp);
  const out = M.HEAPU8.slice(r, r + M.HEAP32[lenp >> 2]);
  M._free(lenp);
  M._free(r);
  return out;
}

test('CP932 like satori.dll: an invalid pair is one U+30FB, duplicates encode to the IBM code, no best fit (S1, S2)', async () => {
  const e = await engine([
    { path: 'dic_pairs.txt', data: cat(sjis('＊OnPair\r\n：X'), [0x85, 0x40], sjis('Y\r\n＊OnSpace\r\n：X'), [0x81, 0x20],
      sjis('A\r\n＊OnIbm\r\n：i'), [0xfa, 0x40], sjis('i\r\n')) },
    { path: 'dic_lone.txt', data: cat(sjis('＊OnLone\r\n：L'), [0x81]) },                     // a lead byte ends the file
    { path: 'dic_utf8.txt', data: new TextEncoder().encode('﻿＊OnEnc\r\n：AⅰBゔCéD\r\n').buffer },
  ]);
  assert.match(req(e, 'OnPair').value, /X・Y/, '85 40 (unassigned) takes both bytes');
  assert.match(req(e, 'OnSpace').value, /X・A/, 'a lead byte takes the space after it');
  assert.match(req(e, 'OnLone').value, /L・/);
  assert.match(req(e, 'OnIbm').value, /iⅰi/);

  const sjisReply = String.fromCharCode(...rawRequest(e, 'GET SHIORI/3.0\r\nID: OnEnc\r\nCharset: Shift_JIS\r\nSender: SSP\r\n\r\n'));
  assert.match(sjisReply, /^Charset: Shift_JIS\r$/m);
  // U+2170 is FA 40 on Windows (Python's codec: EE EF); ゔ and é have only best-fit encodings, which satori.dll
  // turns off
  assert.match(sjisReply, /^Value: .*A\xfa@B\?C\?D/m);
});

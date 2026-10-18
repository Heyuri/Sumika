// Tsubasa's real menu frames (1,995 unique scripts with choices from her satori.dll corpus, fixtures/corpus.json.gz)
// laid out on LightBlue: no errors, labels sit inside their image buttons, choice regions do not collide, wrapping
// never splits a word, and the largest script (530 KB of puyo frames) lays out in time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeBalloons } from './setup.mjs';
import { play, tokenize } from './script.mjs';
import { scanImagePaths } from '../../src/balloon/images.js';
import { isWordChar } from '../../src/balloon/metrics.js';
import { ROOT } from './node_helpers.mjs';
import { needs } from '../needs.mjs';

// the frames come from her corpus, so like the ghost they are not in the repository: without them the tests skip
const FRAMES = 'tests/balloon/fixtures/corpus.json.gz';
const real = needs('site/ghost/tsubasa', FRAMES);
const data = real.skip ? null : JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, FRAMES))).toString('utf8'));
const name = r => r.request.split('\t')[1];

// Frames whose oddities are in the ghost's own output (they look the same in SSP's arithmetic):
const FRAGMENT = new Set(['デートメニュー２', 'デートメニュー３']); // parts of the main menu, not standalone frames
const TRANSLATION = new Set([ // English labels longer than the Japanese originals push a button past the wrap point
  '恋人トークの設定', '２０４８ゲーム', '２０４８ゲームデータ消去２', '２０４８インフレ設定', '２０４８インフレ設定２',
  '起動時天気予報取得設定', 'ツッコミサポート設定', 'お絵描きロジック続ける' /* a \q title wider than the balloon */,
  // the English intro word-wraps onto a third line ("...a word" + "list."), pushing the buttons into the Back/Close
  // row placed at \_l[-2,125]
  'コミュニケーション設定']);
const BY_DESIGN = new Set([
  'しろくろゲーム開始', '初期配置白', '初期配置ランダム', 'オセロゲーム', 'お絵描きロジック中メニュー', 'ＵＦＯ終了３', // label wider than its button
  '服着せ替えメニュー', 'ニーソ着せ替えメニュー', // the selection frame sits on the worn item
  // the left cell of the last button row is empty: \_l[@-2,@3]\n advances 14 where a button row advances 17, so the
  // right button lands 3 px higher and covers the bottom 2 px of the one above (the ghost's arithmetic)
  'リーチ中アガリ可能',
]);
// The corpus harness left some Satori variables unexpanded, e.g. \_b["card\（ゲットカード上数値６）.png",...]
const JUNK = /（[^）\\]{2,}）/;
const allowed = n => FRAGMENT.has(n) || TRANSLATION.has(n) || BY_DESIGN.has(n);

const BUTTON = /menu\/(choice\d+|icon\/choicem\d*)\.png$/i;

test('Tsubasa menu frames: labels inside image buttons, no colliding choices', real, async () => {
  const { balloons, ghost } = await makeBalloons();
  ghost.fetched.length = 0;
  let frames = 0, labels = 0, links = 0, wraps = 0;
  const badLabels = [], overlaps = [], outside = [], badCoords = [], splits = [];
  for (const r of data.menus) {
    await balloons.images.prefetch(scanImagePaths(r.script));
    play(balloons, r.script);
    const n = name(r);
    const junk = JUNK.test(r.script);
    for (const v of balloons.views.values()) {
      if (!v.visible) continue;
      const e = v.engine, g = e.geo;
      frames++;
      links += e.links.length;
      for (const el of e.elements) {
        if (![el.x, el.y, el.w, el.h, el.dy].every(Number.isInteger)) badCoords.push(n);
      }
      // the label after an image button (the \__q[...]\_b[choiceN.png,inline]\__q\_l[...]label idiom) is on the button
      const els = e.elements;
      for (let i = 0; i < els.length; i++) {
        const b = els[i];
        if (b.t !== 'i' || !b.w || !b.img.path || !BUTTON.test(b.img.path)) continue;
        const label = [];
        for (let j = i + 1; j < els.length; j++) {
          const t = els[j];
          if (t.t !== 'g') { if (t.missing) continue; break; }
          if (label.length && t.y !== label[0].y) break;
          if (t.ch.trim() && t.ch !== '　') label.push(t);
        }
        if (!label.length) continue;
        labels++;
        const ok = label.every(t => t.y >= b.y && t.y + t.h <= b.y + b.h && t.x >= b.x && t.x + t.w <= b.x + b.w);
        if (!ok && !allowed(n)) badLabels.push(`${n}: ${label.map(t => t.ch).join('')} at ${label[0].x},${label[0].y} button ${b.x},${b.y}`);
      }
      // regions of different choices never overlap; choices stay inside the balloon horizontally
      const rect = el => el.t === 'p' ? [el.x, el.y, el.w, el.h] : [g.originX + el.x, g.originY + el.y + el.dy, el.w, el.h];
      const L = els.filter(el => el.link >= 0 && !el.missing && el.w && el.h);
      for (const el of L) {
        const [x, , w] = rect(el);
        if ((x < 0 || x + w > v.width) && !allowed(n) && !junk) outside.push(`${n}: ${e.links[el.link].info.id} x=${x} w=${w}`);
      }
      for (let i = 0; i < L.length; i++) {
        for (let j = i + 1; j < L.length; j++) {
          if (L[i].link === L[j].link) continue;
          const [ax, ay, aw, ah] = rect(L[i]), [bx, by, bw, bh] = rect(L[j]);
          if (ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah && !allowed(n) && !junk) overlaps.push(n);
        }
      }
      // an automatic wrap (same logical line, next row, x 0) never splits a word that does not start its row
      const gl = els.filter(el => el.t === 'g');
      const word = el => isWordChar(el.ch.codePointAt(0));
      for (let i = 1; i < gl.length; i++) {
        const a = gl[i - 1], b = gl[i];
        if (b.y <= a.y || b.x !== 0 || a.line !== b.line) continue;
        wraps++;
        if (!word(a) || !word(b)) continue;
        let k = i - 1;
        while (k > 0 && gl[k - 1].y === a.y && word(gl[k - 1])) k--;
        if (k > 0 && gl[k - 1].y === a.y) splits.push(`${n}: ${gl.slice(k, i).map(t => t.ch).join('')}|${b.ch}`);
      }
    }
  }
  assert.ok(wraps > 500, 'automatic wraps: ' + wraps);
  assert.deepEqual(splits.slice(0, 10), [], 'words split by wrapping (BA §3.5)');
  assert.ok(frames > 1900, 'frames laid out: ' + frames);
  assert.ok(labels > 6000, 'button labels checked: ' + labels);
  assert.ok(links > 10000, 'choices: ' + links);
  assert.deepEqual(badCoords, [], 'non-integer coordinates');
  assert.deepEqual(badLabels.slice(0, 10), [], 'labels off their buttons');
  assert.deepEqual([...new Set(overlaps)], [], 'overlapping choices');
  assert.deepEqual([...new Set(outside.map(s => s.split(':')[0]))], [], 'choices outside the balloon');
  assert.ok(!ghost.fetched.some(p => /2048\/0\.png$|unyu\/unyu0\.png$/i.test(p)), 'missing files never fetched');
});

test('choices are clickable at their centre and report their ids', real, async () => {
  const { balloons } = await makeBalloons();
  let checked = 0;
  for (const r of data.menus.slice(0, 400)) {
    await balloons.images.prefetch(scanImagePaths(r.script));
    play(balloons, r.script);
    for (const v of balloons.views.values()) {
      if (!v.visible) continue;
      const e = v.engine;
      e.links.forEach((l, i) => {
        const rects = e.linkRects(i);
        if (!rects.length) return;
        const top = rects[0];
        const hit = e.linkAt(top.x + (top.w >> 1), top.y + (top.h >> 1));
        if (hit < 0) return; // scrolled out or covered by a later element
        checked++;
        const got = [];
        v.on('link', info => got.push(info));
        v.click(top.x + (top.w >> 1), top.y + (top.h >> 1), 0);
        assert.equal(got.length, 1);
        assert.equal(got[0].id, e.links[hit].info.id);
        assert.equal(typeof got[0].label, 'string');
        v._handlers.delete('link');
      });
    }
  }
  assert.ok(checked > 1000, 'clicked ' + checked);
});

test('the 530 KB puyo script lays out in under 80 ms (pure layout)', real, async () => {
  const s = data.big.script;
  assert.ok(s.length > 500000);
  const { balloons } = await makeBalloons();
  await balloons.images.prefetch(scanImagePaths(s));
  const toks = tokenize(s);
  assert.ok(toks.length > 25000);
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const t0 = performance.now();
    play(balloons, s, { tokens: toks });
    best = Math.min(best, performance.now() - t0);
  }
  const v = balloons.get(0);
  assert.equal(v.kind, 2);
  assert.ok(v.engine.elements.some(e => e.t === 'p' && /uback\.png$/i.test(e.img.path)));
  assert.ok(best < 80, `layout took ${best.toFixed(1)} ms`);
});

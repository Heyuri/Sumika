// Golden layout tests A–G (BA §3.10): layouts Tsubasa's authors tuned in SSP, reproduced exactly. A builds its page
// from rows of its own; B–G play real responses of her satori.dll (corpus final_master.res.txt; B and G as recorded,
// C–F shortened), read from fixtures/golden.json. That file is made from the ghost, so like the ghost it is not in
// the repository, and without it B–G skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeBalloons, laid } from './setup.mjs';
import { ROOT } from './node_helpers.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');
const GOLDEN = 'tests/balloon/fixtures/golden.json';
const golden = needs('site/ghost/tsubasa', GOLDEN);
const SCRIPTS = golden.skip ? {} : JSON.parse(fs.readFileSync(path.join(ROOT, GOLDEN), 'utf8')).scripts;
const imgs = (els, name) => els.filter(e => (e.t === 'i' || e.t === 'p') && e.img && e.img.path && e.img.path.toLowerCase().endsWith(name.toLowerCase()));
const text = (els, s) => {
  // first glyph of the first occurrence of s (glyphs in order)
  const g = els.filter(e => e.t === 'g');
  const str = g.map(e => e.ch).join('');
  const i = str.indexOf(s);
  assert.ok(i >= 0, 'text not found: ' + s);
  return g[i];
};
const xy = e => [e.x, e.y];

test('A: full-width image button rows (自己紹介 "Ask About Tsubasa": \\c\\n\\_l[@-2,@0], 16 rows of \\_l[@-2,@3] … \\_l[@0,@-16])', real, async () => {
  // the page starts with \c\n\_l[@-2,@0]: a relative \_l before the first string is measured from the origin (BA §3.3),
  // so row 1 starts at y 0 and the last of 16 rows ends at 319, just above the Previous/Next buttons at \_l[-2,321]
  const { balloons, run } = await makeBalloons();
  const row = (id, label, first) => `\\_l[@-2,@${first ? 0 : 3}]\\__q[${id}]\\_b["menu\\choice5.png",inline]\\__q\\_l[@0,@-16]${label}\\n`;
  let rows = row('a', '　　　　　　　　　　　  Sure', true) + row('b', '　　　　　　　　　　　 Nope');
  for (let i = 2; i < 16; i++) rows += row('q' + i, '　　　　　　　　 Question ' + i);
  await run('\\0\\b[2]\\_q\\c\\n' + rows + '\\n\\_l[-2,321]\\_b["menu\\choice2.png",inline]\\_l[6,324]　　 Previous\\n' +
    '\\_l[98,321]\\__q[next]\\_b["menu\\choice1.png",inline]\\__q\\_l[106,324]　　　Next\\n\\_q\\e');
  const els = laid(balloons);
  const b = imgs(els, 'choice5.png');
  assert.equal(b.length, 16);
  assert.deepEqual([b[0].x, b[0].y, b[0].w, b[0].h], [-2, 0, 300, 19], 'the \\n before the relative \\_l is lost');
  const sure = text(els, 'Sure');
  assert.deepEqual(xy(sure), [144, 3], 'label centred in the button: 11 full + 2 half spaces = 144');
  assert.deepEqual(xy(b[1]), [-2, 20], 'next button: pitch 20, 1 px gap');
  assert.equal(text(els, 'Nope').y, 23);
  b.forEach((e, k) => assert.equal(e.y, 20 * k, 'row ' + k));
  const next = imgs(els, 'choice1.png')[0];
  assert.deepEqual(xy(next), [98, 321]);
  assert.equal(b[15].y + b[15].h, 319, 'the last row ends above the Previous/Next row');
  const e = balloons.get(0).engine;
  assert.equal(e.links.length, 17);
  assert.equal(e.linkAt(23 + 10, 13 + 10), 0, 'button is clickable');
  assert.equal(e.linkAt(23 + 150, 13 + 30), 1);
  assert.equal(e.linkAt(23 + 150, 13 + 320), -1, 'nothing between the last row and Next');
  assert.equal(e.linkAt(23 + 100, 13 + 325), 16);
});

test('B: two-column choice3 menu (カードゲームメニュー２)', golden, async () => {
  const { balloons, run } = await makeBalloons();
  await run(SCRIPTS.B);
  const els = laid(balloons);
  assert.equal(text(els, 'Card Game').y, 0);
  assert.equal(text(els, 'Record').y, 21, '\\n[half] advances 7');
  assert.equal(text(els, 'Cards owned').y, 35);
  const Y = 56;
  const b = imgs(els, 'choice3.png');
  assert.deepEqual(xy(b[0]), [-2, Y + 3]);
  assert.equal(text(els, 'Start Game').y, Y + 6);
  assert.deepEqual(xy(b[1]), [150, Y + 3], 'right column aligned with the left one');
  assert.equal(text(els, 'How to Play').y, Y + 6, 'commit of the pending wrap (19) then @-16');
  assert.deepEqual(xy(b[2]), [-2, Y + 23], 'x reset to 0 by \\n, next row 23 lower');
  assert.equal(text(els, 'Card List').y, Y + 26);
  assert.deepEqual(xy(b[3]), [150, Y + 23], 'relative @150 column after \n');
  assert.deepEqual(xy(text(els, 'Card List Display')), [150 + 2 * 12 + 2 * 6, Y + 26]);
  assert.deepEqual(xy(b[4]), [-2, Y + 43]);
  assert.deepEqual(xy(b[5]), [-2, Y + 63]);
  assert.equal(text(els, 'Back').y, Y + 66);
});

test('C: main menu with \\_n (mが押された)', golden, async () => {
  const { balloons, run } = await makeBalloons();
  await run(SCRIPTS.C);
  const els = laid(balloons);
  const bg = imgs(els, 'sky3.png')[0];
  assert.deepEqual([bg.t, bg.x, bg.y, bg.w, bg.h], ['p', 0, 0, 340, 384], 'positioned \\_b uses balloon coordinates');
  const btn = imgs(els, 'choicem.png');
  // \_b[sky3.png,0,0]\n　\n\n\n\n: the positioned image opens no string, so the first \n counts (BA §3.3); the
  // full-width space opens one at y 14, so \_l[-9,@0] after the four \n is measured from the pen at y 70
  assert.deepEqual(xy(btn[0]), [-9, 70]);
  assert.equal(btn[0].by, 83, 'balloon y of row 1 = 83, 13 px below the MENU banner (dark rows 2–66, border 67–69)');
  assert.deepEqual(xy(text(els, 'Say Something')), [16, 75]);
  assert.deepEqual(xy(imgs(els, 'icon/t.png')[0]), [-9, 70]);
  assert.deepEqual(xy(btn[1]), [146, 70], 'right column aligned (no wrap under \\_n)');
  assert.deepEqual(xy(text(els, 'Help with Homework')), [171, 75]);
  assert.deepEqual(xy(btn[2]), [-9, 96], '\\n advanced by the 23 px icon, then @3');
  assert.deepEqual(xy(btn[3]), [146, 96]);
  assert.deepEqual(xy(imgs(els, 'menu.png')[0]), [257, 0]);
  assert.equal(balloons.get(0).engine.scrollY, 0);
  assert.equal(balloons.get(0).kind, 2);
  assert.equal(balloons.get(0).height, 384);
});

test('D: dress-up grid with \\f[height,3] spaces (頭着せ替えメニュー)', golden, async () => {
  const { balloons, run } = await makeBalloons();
  await run(SCRIPTS.D);
  const els = laid(balloons);
  const marker = els.find(e => e.t === 'm');
  assert.equal(marker.y, 69, '\\_l[198,38]\\_l[@0,@3]\\n\\n: 41 -> 55 -> 69');
  assert.equal(text(els, 'Head\u0000'.slice(0, 4)) && els.filter(e => e.t === 'g' && e.y === 69).length > 0, true);
  assert.equal(marker.w, 8);
  assert.equal(marker.dy, 2, 'the 8 px marker is centred in the 12 px cell');
  const icons = els.filter(e => e.t === 'i' && e.img.path && /menu\/(head\d+|q2)\.png$/i.test(e.img.path));
  assert.equal(icons.length, 18);
  icons.forEach((e, k) => assert.deepEqual(xy(e), [2 + 42 * (k % 7), 83 + 40 * Math.floor(k / 7)], 'icon ' + k));
  const frame = imgs(els, 'f2.png')[0];
  assert.deepEqual(xy(frame), [2, 83], 'selection frame lands on icon 0');
  const back = imgs(els, 'choice1.png').at(-2);
  assert.deepEqual(xy(back), [-2, 340]);
  assert.equal(balloons.get(0).engine.scrollY, 0, 'Back button ends at 358 <= 359: no scroll');
  assert.equal(text(els, 'Hair Clip').x + 9 * 6, 290, 'label ends at 290 (past the limit, on one line)');
});

test('E: 2048 board — \\_b in balloon space, \\_l in text space (２０４８最初)', golden, async () => {
  const { balloons, run, ghost } = await makeBalloons();
  ghost.fetched.length = 0;
  await run(SCRIPTS.E);
  const els = laid(balloons);
  const waku = imgs(els, 'waku.png')[0];
  assert.deepEqual([waku.t, waku.bx, waku.by, waku.img.mode], ['p', 48, 55, 'opaque']);
  const b = n => imgs(els, `2048/b${n}.png`)[0];
  assert.deepEqual([b(1).bx, b(1).by], [48, 25]);
  assert.equal(b(1).by + b(1).h, 55, 'up button bottom edge touches the frame');
  assert.deepEqual([b(2).bx, b(2).by], [18, 55]);
  assert.equal(b(2).bx + b(2).w, 48, 'left button right edge touches the frame');
  assert.deepEqual([b(3).bx, b(3).by], [289, 55]);
  assert.deepEqual([b(4).bx, b(4).by], [48, 296]);
  const tile = imgs(els, '2048/2.png')[0];
  assert.deepEqual([tile.bx, tile.by], [229, 116]);
  const missing = els.filter(e => e.missing);
  assert.equal(missing.length, 2, '2048\\0.png does not exist: zero-size elements');
  assert.ok(!ghost.fetched.some(p => /2048\/0\.png$/i.test(p)), 'missing files are never fetched');
  const score = text(els, 'Score');
  assert.deepEqual([score.bx, score.by], [113, 9]);
  assert.equal(score.font.bold, true);
  assert.deepEqual(balloons.get(0).engine.links[0].font.cursor.pen, [250, 250, 50], 'cursorpencolor is captured per choice');
  assert.equal(balloons.get(0).engine.scrollY, 0);
});

test('F: card board from --clipping cells (カード選択１)', golden, async () => {
  const { balloons, run } = await makeBalloons();
  await run(SCRIPTS.F);
  const els = laid(balloons);
  const cells = imgs(els, 'field.png');
  assert.equal(cells.length, 9);
  cells.forEach((c, k) => {
    assert.deepEqual([c.x, c.y, c.w, c.h], [60 * (k % 3), -1 + 74 * Math.floor(k / 3), 60, 74], 'cell ' + k);
    assert.deepEqual(c.clip, [60 * (k % 3), 74 * Math.floor(k / 3), 60 * (k % 3) + 60, 74 * Math.floor(k / 3) + 74]);
  });
  const hand = els.filter(e => e.t === 'i' && /card\/No[2-5]\.png$/i.test(e.img.path));
  assert.deepEqual(hand.map(e => e.x), [60, 120, 180, 240], 'a 60 px full-width space first');
  assert.ok(hand.every(e => e.y === 235));
  assert.equal(text(els, 'Place your card').y, 337);
  assert.equal(imgs(els, 'card/0.png').length, 0, 'missing positioned image: no element');
  const fg = imgs(els, 'card/1.png')[0];
  assert.deepEqual([fg.t, fg.x, fg.y, fg.fg], ['p', 25, 24, true]);
  assert.equal(imgs(els, 'No1.png')[0].fg, false);
  assert.equal(balloons.get(0).engine.links.length, 13);
  assert.deepEqual(balloons.get(0).engine.links[9].font.cursor.pen, [250, 50, 250]);
  assert.equal(balloons.get(0).engine.scrollY, 0);
});

test('G: plain text lines advance 14 px (初回)', golden, async () => {
  const { balloons, run } = await makeBalloons();
  await run(SCRIPTS.G);
  const els = laid(balloons);
  const ys = [...new Set(els.filter(e => e.t === 'g' && e.ch.trim() && e.ch !== '　').map(e => e.y))];
  // 5 text lines; the 4th wraps once (a wrap advances 14 too); the 3rd ends with a hanging '.'
  assert.deepEqual(ys.slice(0, 6), [0, 14, 28, 42, 56, 70]);
  const third = els.filter(e => e.t === 'g' && e.y === 28);
  assert.equal(third.at(-1).ch, '.', 'kinsoku: the full stop hangs past the limit');
  assert.equal(third.at(-1).x, 288);
  const b = imgs(els, 'choice5.png');
  assert.equal(b[0].y, 70 + 14 + 14 + 3, '\n\_q\n then @3');
  assert.equal(text(els, 'Sure').y, b[0].y + 3);
  assert.equal(b[1].y - b[0].y, 20);
  const e = balloons.get(0).engine;
  assert.equal(e.contentBottom, b[1].y + 19);
  assert.equal(e.scrollY, 0, 'fits the 170 px balloon (visible bottom 145)');
});

// Layout engine unit tests on a synthetic LightBlue-like geometry (BA §3.3–§3.9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LayoutEngine, parseLocation } from '../../src/balloon/layout.js';
import { skinGeometry, skinFont } from '../../src/balloon/geometry.js';

const cfg = new Map([['origin.x', '23'], ['origin.y', '13'], ['wordwrappoint.x', '-30'], ['validrect.left', '0'], ['validrect.top', '0'],
  ['validrect.right', '0'], ['validrect.bottom', '-12'], ['font.height', '12'], ['font.color.r', '84'], ['font.color.g', '32'], ['font.color.b', '27'],
  ['cursor.blendmethod', 'notmaskpen'], ['cursor.brush.color.r', '150'], ['cursor.brush.color.g', '100'], ['cursor.brush.color.b', '100']]);
const G170 = skinGeometry(cfg, 340, 170);
const G384 = skinGeometry(cfg, 340, 384);
const FONT = skinFont(cfg);

function engine(sizes = {}, o = {}) {
  return new LayoutEngine({ geometry: o.geo || G170, font: FONT, wordWrap: o.wordWrap,
    imageInfo: ref => (ref.key in sizes ? sizes[ref.key] : false) });
}
const glyphs = e => e.elements.filter(x => x.t === 'g');
const line = (e, y) => glyphs(e).filter(g => g.y === y).map(g => g.ch).join('');
const xy = el => [el.x, el.y];

test('advances: full width = h, half width = round(h/2)', () => {
  const e = engine();
  e.write('あA　 ←x');
  assert.deepEqual(glyphs(e).map(g => g.w), [12, 6, 12, 6, 12, 6]);
  e.setFont('height', '3');
  e.write(' ');
  assert.equal(glyphs(e).at(-1).w, 2, 'a space at \\f[height,3] is 2 px');
  e.setFont('height', '13');
  e.write('a');
  assert.equal(glyphs(e).at(-1).w, 7, 'round half up');
});

test('eager wrap: place first, then break; \\n uses up a pending wrap', () => {
  const e = engine();
  e.write('a'.repeat(48)); // 288 > 287
  assert.equal(e.pendingFeed, true);
  assert.equal(e.penY, 0);
  e.write('b');
  assert.equal(glyphs(e).at(-1).y, 14, 'the next glyph starts the new line');
  assert.equal(glyphs(e).at(-1).x, 0);
  const f = engine();
  f.write('a'.repeat(48));
  f.newline();
  assert.deepEqual([f.penX, f.penY], [0, 14], 'no empty line after an exact wrap');
  f.write('a'.repeat(48));
  f.newline(0.5);
  assert.deepEqual([f.penX, f.penY], [0, 14 + 14 + 7], 'pending wrap then half line');
});

test('kinsoku: punctuation hangs, opening brackets move to the next line', () => {
  const e = engine();
  e.write('a'.repeat(48) + '。b');
  const g = glyphs(e);
  assert.deepEqual([g[48].ch, g[48].y, g[48].x], ['。', 0, 288]);
  assert.deepEqual([g[49].ch, g[49].y, g[49].x], ['b', 14, 0]);
  const f = engine();
  f.write('a'.repeat(46) + '「c');
  const h = glyphs(f);
  assert.deepEqual([h[46].ch, h[46].y, h[46].x], ['「', 14, 0], '「 at 276+12 > 287 starts the next line');
});

test('word wrap (default): a word that crosses the wrap point moves whole to the next line', () => {
  // observed in SSP: "Tamagawa R" + "iver" is drawn "Tamagawa" + "River"
  const e = engine();
  e.write('x'.repeat(37) + ' Tamagawa River flows.');
  assert.equal(line(e, 0), 'x'.repeat(37) + ' Tamagawa ');
  assert.equal(line(e, 14), 'River flows.');
  assert.deepEqual(xy(glyphs(e).find(g => g.ch === 'R')), [0, 14]);
  const pc = engine({}, { wordWrap: false });
  pc.write('x'.repeat(37) + ' Tamagawa River flows.');
  assert.equal(line(pc, 0), 'x'.repeat(37) + ' Tamagawa R', 'wordWrap:false keeps the per-character rule');
  // attached punctuation belongs to the word; a space at the wrap point hangs instead of starting the line
  const f = engine();
  f.write('x'.repeat(36) + " I don't-know, Neighbor.");
  assert.equal(line(f, 0), 'x'.repeat(36) + ' I ');
  assert.equal(line(f, 14), "don't-know, Neighbor.");
  const s = engine();
  s.write('x'.repeat(43) + ' word next');
  assert.equal(line(s, 0), 'x'.repeat(43) + ' word ', '"word" ends at 288, the space after it hangs');
  assert.equal(line(s, 14), 'next', 'no leading space on the new line');
  // only spaces after words hang: after an inline image or CJK text a space starts the new line
  const i = engine({ btn: { w: 290, h: 19 } });
  i.inlineImage({ key: 'btn' });
  i.write(' x');
  assert.deepEqual(glyphs(i).map(xy), [[0, 19], [6, 19]]);
  const c = engine();
  c.write('あ'.repeat(24) + ' x');
  assert.equal(line(c, 14), ' x');
  // place first, then break: a word whose last character crosses stays (the dress-up "Hair Clip" label ends at 290)
  const h = engine();
  h.locate('206', '3');
  h.write('　　 Hair Clip');
  assert.equal(line(h, 3), '　　 Hair Clip');
  h.write(' and');
  assert.equal(line(h, 17), 'and');
});

test('word wrap: long words, CJK text, \\f changes inside a word, links, \\q titles, alignment', () => {
  // a word wider than the line breaks by character, after moving to a line of its own
  const e = engine();
  e.write('ab ' + 'w'.repeat(60));
  assert.equal(line(e, 0), 'ab ');
  assert.equal(line(e, 14), 'w'.repeat(48));
  assert.equal(line(e, 28), 'w'.repeat(12));
  // CJK keeps the per-character rule with kinsoku; a full-width space does not hang
  const j = engine();
  j.write('あ'.repeat(24) + '　い。う');
  assert.equal(line(j, 0), 'あ'.repeat(24));
  assert.equal(line(j, 14), '　い。う');
  const k = engine();
  k.write('あ'.repeat(22) + 'Tamagawa');
  assert.equal(line(k, 0), 'あ'.repeat(22), 'a Latin word after CJK text moves whole');
  assert.equal(line(k, 14), 'Tamagawa');
  // a \f change inside the word: the glyphs keep their fonts; the old line keeps only its own height
  const f = engine();
  f.write('x'.repeat(40) + ' Ri');
  f.setFont('height', '24');
  f.write('ver');
  f.setFont('height', 'default');
  f.write('s go');
  const g = glyphs(f);
  assert.deepEqual(g.slice(41, 47).map(x => [x.ch, x.x, x.y, x.h]),
    [['R', 0, 14, 12], ['i', 6, 14, 12], ['v', 12, 14, 24], ['e', 24, 14, 24], ['r', 36, 14, 24], ['s', 48, 14, 12]]);
  f.newline();
  assert.equal(f.penY, 14 + 26, 'the moved 24 px glyphs set the height of their new line');
  // inside a \__q range the moved glyphs keep their link; the highlight follows them
  const l = engine();
  l.write('x'.repeat(41) + ' ');
  l.beginLink({ kind: 'choice', id: 'c', refs: [] });
  l.write('Choices');
  l.endLink();
  assert.deepEqual(l.linkRects(0), [{ x: 23, y: 13 + 14, w: 42, h: 12 }]);
  assert.equal(l.linkInfo(0).label, 'Choices');
  // a \q title never breaks inside, and what follows cannot pull its last word down
  const q = engine();
  q.write('x'.repeat(40));
  q.choice('Long choice title', { kind: 'choice', id: 'A', refs: [] });
  q.write('s!');
  assert.equal(line(q, 0), 'x'.repeat(40) + 'Long choice title');
  assert.equal(line(q, 14), 's!');
  // centred text: both lines are centred for their final widths
  const c = engine();
  c.setFont('align', 'center');
  c.write('x'.repeat(40) + ' Tamagawa');
  const t = glyphs(c);
  assert.equal(t[0].x, Math.floor((287 - 246) / 2), 'the first line is centred without the moved word');
  assert.deepEqual(xy(t[41]), [Math.floor((287 - 48) / 2), 14]);
  // a positioned image placed in the middle of a moved word stays where it is (balloon space)
  const p = engine({ img: { w: 10, h: 10 } });
  p.write('x'.repeat(40) + ' Tama');
  p.positionedImage({ key: 'img' }, 5, 6);
  p.write('gawa');
  const pi = p.elements.find(x => x.t === 'p');
  assert.deepEqual([pi.x, pi.y], [5, 6]);
  assert.equal(line(p, 14), 'Tamagawa');
  // \c[char,n] that keeps the start of the word: the word goes on
  const d = engine();
  d.write('x'.repeat(40) + ' Tama');
  d.clearChars(2);
  d.write('magawa');
  assert.equal(line(d, 14), 'Tamagawa');
  // replaying the operations gives the same layout
  const snap = JSON.parse(JSON.stringify(f.snapshot()));
  const r = engine();
  r.restore(snap);
  assert.deepEqual(r.elements.map(x => [x.ch, x.x, x.y]), f.elements.map(x => [x.ch, x.x, x.y]));
});

test('a leading \\n counts; a relative \\_l before the first string starts from the origin (BA §3.3)', () => {
  const e = engine({ img: { w: 10, h: 10 }, slow: null });
  e.newline();
  e.newline(0.5);
  assert.deepEqual([e.penX, e.penY], [0, 21], 'line breaks move the pen in an empty balloon');
  e.positionedImage({ key: 'img' }, 0, 0);
  e.locate('@5', '@3');
  assert.deepEqual([e.penX, e.penY], [5, 3], 'no string yet (a positioned image is none): from the origin');
  e.newline();
  e.locate('@0', '@0');
  assert.deepEqual([e.penX, e.penY], [0, 17], '\\_l opened a string: from the pen');
  e.clear();
  e.newline();
  e.newline();
  e.write('x');
  assert.equal(glyphs(e).at(-1).y, 28, 'after \\c, text starts below the leading line breaks');
  const opens = [x => x.inlineImage({ key: 'nope' }), x => x.inlineImage({ key: 'slow' }), x => x.marker({ key: 'm' }, 8, 8),
    x => x.write(' '), x => x.choice('A', { kind: 'choice', id: 'a', refs: [] }), x => x.beginLink({ kind: 'anchor', id: 'b' }),
    x => x.setFont('bold', '1'), x => x.locate('', '')];
  for (const add of opens) {
    const f = engine({ slow: null });
    add(f);
    f.newline();
    f.locate('@0', '@0');
    assert.equal(f.penY, 14, 'inline images (missing and loading too), markers, spaces, choices, links, \\f and \\_l open a string');
  }
  for (const add of [x => x.positionedImage({ key: 'img' }, 0, 0), x => x.setFont('align', 'center'), x => x.setFont('default', ''), x => x.setNoWrap(true)]) {
    const f = engine({ img: { w: 10, h: 10 } });
    add(f);
    f.newline();
    f.locate('@0', '@0');
    assert.equal(f.penY, 0, 'positioned images, \\f[align], the font reset and \\_n do not');
  }
  const a = engine();
  a.setFont('align', 'center');
  a.newline();
  a.write('ab');
  assert.deepEqual(xy(glyphs(a)[0]), [Math.floor((287 - 12) / 2), 14], 'a \\f[align] before the first string survives a leading \\n');
  // choices first, the title last at \_l[0,0]: \0\n\_q\n\![*]\q[…]\_l[,@3]\n…\_l[0,0]title keeps the title row free
  const t = engine();
  t.newline();
  t.newline();
  t.marker({ key: 'm' }, 8, 8);
  t.choice('First', { kind: 'choice', id: 'a', refs: [] });
  t.locate('', '@3');
  t.newline();
  t.marker({ key: 'm' }, 8, 8);
  t.choice('Second', { kind: 'choice', id: 'b', refs: [] });
  t.locate('0', '0');
  t.write('Title');
  assert.deepEqual([line(t, 0), line(t, 28), line(t, 45)], ['Title', 'First', 'Second']);
  // the main menu idiom: \_b[sky3.png,0,0]\n　\n\n\n\n\_l[-9,@0] puts the first row at y 70; the full-width space is what
  // makes the relative \_l count from the pen
  const m = engine({ img: { w: 340, h: 384 } }, { geo: G384 });
  m.positionedImage({ key: 'img' }, 0, 0);
  m.newline();
  m.write('　');
  for (let i = 0; i < 4; i++) m.newline();
  m.locate('-9', '@0');
  assert.deepEqual([m.penX, m.penY], [-9, 70]);
  const snap = JSON.parse(JSON.stringify(m.snapshot()));
  const r = engine({ img: { w: 340, h: 384 } }, { geo: G384 });
  r.restore(snap);
  assert.deepEqual([r.penX, r.penY], [-9, 70], 'restore replays the same rule');
  m.relayout();
  assert.deepEqual([m.penX, m.penY], [-9, 70]);
  const n = engine({ img: { w: 340, h: 384 } }, { geo: G384 });
  n.positionedImage({ key: 'img' }, 0, 0);
  for (let i = 0; i < 5; i++) n.newline();
  n.locate('-9', '@0');
  assert.deepEqual([n.penX, n.penY], [-9, 0], 'without it the \\_l starts from the origin');
});

test('\\_l forms', () => {
  const e = engine();
  e.write('ab');
  e.locate('@5', '@2');
  assert.deepEqual([e.penX, e.penY], [17, 2]);
  e.locate('', '30');
  assert.deepEqual([e.penX, e.penY], [17, 30], 'empty axis unchanged');
  e.locate('2em', '1lh');
  assert.deepEqual([e.penX, e.penY], [24, 14]);
  e.locate('@50%', '@-1.5em');
  assert.deepEqual([e.penX, e.penY], [30, -4]);
  e.locate('centerx', 'centery');
  assert.deepEqual([e.penX, e.penY], [170 - 23, 85 - 13], 'centre of the balloon image in text space');
  e.locate('＠-31', '@0');
  assert.equal(e.penX, 147, 'full-width ＠ is not recognised: axis unchanged');
  assert.equal(parseLocation('-9', 'x', 12, G170).v, -9);
  assert.equal(parseLocation('x', 'x', 12, G170), null);
});

test('line advance = max(LH, tallest element in the segment); images add no gap', () => {
  const e = engine({ img40: { w: 40, h: 40 } });
  e.write('A');
  e.inlineImage({ key: 'img40' });
  e.newline();
  assert.equal(e.penY, 40);
  e.locate('0', '100');
  e.inlineImage({ key: 'img40' });
  e.locate('@0', '@0'); // a new segment: the image no longer counts
  e.write('x');
  e.newline();
  assert.equal(e.penY, 114);
});

test('\\c, \\c[char,n], \\c[line,n]', () => {
  const e = engine({ i: { w: 10, h: 10 } });
  e.write('abc');
  e.inlineImage({ key: 'i' });
  e.clearChars(2);
  assert.equal(glyphs(e).map(g => g.ch).join(''), 'ab');
  assert.equal(e.elements.length, 2);
  assert.deepEqual([e.penX, e.penY], [12, 0], 'pen back to the first removed character');
  e.write('Z');
  assert.equal(glyphs(e).at(-1).x, 12);
  e.newline();
  e.write('second');
  e.newline();
  e.write('third');
  e.clearLines(1);
  assert.equal(glyphs(e).map(g => g.ch).join(''), 'abZsecond');
  assert.equal(e.penY, 28);
  e.setFont('bold', '1');
  e.clear();
  assert.equal(e.elements.length, 0);
  assert.deepEqual([e.penX, e.penY, e.scrollY], [0, 0, 0]);
  assert.equal(e.font.bold, true, 'font survives \\c');
  assert.equal(e.hasContent, false);
});

test('\\f[bold|underline|…,toggle] flips the flag (\\B, \\U) [disasm ParseFontCommand]', () => {
  const e = engine();
  e.setFont('bold', 'toggle');
  assert.equal(e.font.bold, true);
  e.setFont('bold', 'TOGGLE');
  assert.equal(e.font.bold, false);
  e.setFont('underline', 'toggle');
  assert.equal(e.font.underline, true);
  e.setFont('sup', '1');
  e.setFont('sub', 'toggle');
  assert.deepEqual([e.font.sub, e.font.sup], [true, false], 'sub and sup still exclude each other');
});

test('\\f tags', () => {
  const e = engine();
  e.setFont('color', '245,245,245');
  assert.deepEqual(e.font.color, [245, 245, 245]);
  e.setFont('color', 'red');
  assert.deepEqual(e.font.color, [255, 0, 0]);
  e.setFont('color', 'nonsense');
  assert.deepEqual(e.font.color, [255, 0, 0], 'invalid colours are ignored');
  e.setFont('color', 'default');
  assert.deepEqual(e.font.color, [84, 32, 27]);
  e.setFont('shadowcolor', 'none');
  assert.equal(e.font.shadow, null);
  e.setFont('height', '+3');
  assert.equal(e.font.height, 15);
  e.setFont('height', '200%');
  assert.equal(e.font.height, 24);
  e.setFont('height', 'default');
  assert.equal(e.font.height, 12);
  e.setFont('strike', 'true');
  e.setFont('bold', '1');
  assert.equal(e.font.strike && e.font.bold, true);
  e.setFont('cursorpencolor', '250,250,50');
  e.setFont('cursormethod', 'xorpen');
  e.setFont('cursorstyle', 'underline');
  assert.deepEqual(e.font.cursor.pen, [250, 250, 50]);
  assert.equal(e.font.cursor.method, 'xorpen');
  assert.equal(e.font.cursor.style, 'underline');
  e.setFont('cursorbrushcolor', '#ff0000');
  assert.deepEqual(e.font.cursor.brush, [255, 0, 0]);
  e.setFont('default', '');
  assert.equal(e.font, FONT);
  e.setFont('unknownthing', '1'); // ignored, logged once
});

test('\\f[align] re-aligns the current line until the next \\n or \\_l', () => {
  const e = engine();
  e.setFont('align', 'center');
  e.write('ab');
  assert.equal(glyphs(e)[0].x, Math.floor((287 - 12) / 2));
  e.newline();
  e.write('c');
  assert.equal(glyphs(e).at(-1).x, 0, '\\n returns to left alignment');
  e.setFont('align', 'right');
  e.write('d');
  assert.equal(glyphs(e).at(-1).x + 6, 287);
});

test('choices: \\q title is one unit, \\__q ranges, hit test and highlight rectangles', () => {
  const e = engine({ btn: { w: 300, h: 19 } });
  e.write('x'.repeat(40));
  e.choice('Long choice title', { kind: 'choice', id: 'A', refs: [] });
  const t = glyphs(e).filter(g => g.link === 0);
  assert.equal(t.length, 17);
  assert.ok(t.every(g => g.y === 0), 'the title does not break inside');
  assert.equal(e.pendingFeed, true);
  e.newline();
  e.beginLink({ kind: 'choice', id: 'B\u0001x', refs: ['r'] });
  e.inlineImage({ key: 'btn' });
  e.endLink();
  e.locate('@0', '@-16');
  e.write('label');
  assert.equal(e.linkAt(23 + 100, 13 + 14 + 5), 1);
  assert.equal(e.linkAt(23 + 250, 13 + 2), 0);
  assert.equal(e.linkAt(23 + 100, 13 + 2), -1);
  assert.equal(e.linkAt(339, 13 + 2), 0);
  assert.deepEqual(e.linkRects(0), [{ x: 23 + 240, y: 13, w: 340 - 263, h: 12 }], 'clipped to validRect');
  assert.deepEqual(e.linkRects(1), [{ x: 23, y: 13 + 14, w: 300, h: 19 }]);
  assert.deepEqual(e.linkInfo(1), { kind: 'choice', id: 'B\u0001x', refs: ['r'], label: '' });
  assert.equal(e.linkInfo(0).label, 'Long choice title');
  assert.equal(e.links[0].font.cursor.method, 'notmaskpen');
});

test('hit band: no item above validrect.top or below validrect.bottom, positioned \\_b links too [disasm SelectLineInternal]', () => {
  const geo = skinGeometry(new Map([...cfg, ['validrect.top', '20'], ['validrect.bottom', '-20']]), 340, 170);
  const e = engine({ btn: { w: 40, h: 20 } }, { geo });
  assert.deepEqual([e.inBand(19), e.inBand(20), e.inBand(150), e.inBand(151)], [false, true, true, false],
    'y only, both edges inside');
  e.beginLink({ kind: 'choice', id: 'top', refs: [] });
  e.positionedImage({ key: 'btn' }, 100, 5);                // y 5..25, across validrect.top
  e.endLink();
  e.beginLink({ kind: 'choice', id: 'bottom', refs: [] });
  e.positionedImage({ key: 'btn' }, 200, 140);              // y 140..160, across validrect.bottom
  e.endLink();
  assert.equal(e.linkAt(110, 10), -1, 'drawn above the text rect: not hit');
  assert.equal(e.linkAt(110, 22), 0);
  assert.equal(e.linkAt(210, 150), 1, 'the bottom row still counts');
  assert.equal(e.linkAt(210, 155), -1);
});

test('scrolling: autoscroll to the last content, not on exact fit; manual scroll', () => {
  const e = engine();
  for (let i = 0; i < 10; i++) { e.write('line'); e.newline(); }
  assert.equal(e.contentBottom, 9 * 14 + 12);
  assert.equal(e.scrollY, 0, '10 lines fit the 170 px balloon');
  e.write('line');
  assert.equal(e.scrollY, 10 * 14 + 12 - 145);
  e.setAutoscroll(false);
  assert.equal(e.scrollBy(-100), true);
  assert.equal(e.scrollY, 0);
  e.write('more');
  assert.equal(e.scrollY, 0, 'no autoscroll while disabled');
  e.setGeometry(G384);
  assert.equal(e.maxScroll, 0, 'a taller balloon has room');
});

test('async image sizes: relayout when the size arrives', () => {
  const sizes = { a: null };
  const e = engine(sizes);
  e.write('x');
  e.inlineImage({ key: 'a' });
  e.write('y');
  assert.ok(e.pendingKeys.has('a'));
  assert.equal(glyphs(e)[1].x, 6);
  sizes.a = { w: 100, h: 30 };
  e.relayout();
  assert.equal(glyphs(e)[1].x, 106);
  assert.equal(e.pendingKeys.size, 0);
  const snap = JSON.parse(JSON.stringify(e.snapshot()));
  const f = engine(sizes);
  f.restore(snap);
  assert.deepEqual(f.elements.map(x => [x.t, x.x, x.y]), e.elements.map(x => [x.t, x.x, x.y]));
});

test('missing images: zero size, never content; positioned ones produce nothing', () => {
  const e = engine({});
  e.inlineImage({ key: 'nope' });
  e.positionedImage({ key: 'nope' }, 10, 10);
  assert.equal(e.hasContent, false);
  assert.equal(e.elements.length, 1);
  assert.equal(e.elements[0].missing, true);
  e.write(' 　');
  assert.equal(e.hasContent, false, 'blank glyphs are not content');
  e.write('.');
  assert.equal(e.hasContent, true);
});

test('\\_n disables wrapping', () => {
  const e = engine();
  e.setNoWrap(true);
  e.write('a'.repeat(60));
  assert.equal(e.pendingFeed, false);
  assert.ok(glyphs(e).every(g => g.y === 0));
});

test('\__q label: the text inside the range, whitespace collapsed (OnChoiceSelectEx R0)', () => {
  const e = engine();
  e.beginLink({ kind: 'choice', id: 'x', refs: [], label: '' }); // the player passes '' and fills its own copy later
  e.write('　 Talk  to me ');
  e.endLink();
  assert.equal(e.linkInfo(0).label, 'Talk to me');
});

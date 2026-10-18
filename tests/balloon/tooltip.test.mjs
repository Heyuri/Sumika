// Choice hover on a real layout (Tsubasa's LightBlue, headless; UI §4.8, EV §4.7): SSP's selection ('select' events),
// the References of each kind of item, the tooltip's rest timer on a fake clock, its per-entry cache, stale and 204
// replies, presses and leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './setup.mjs';
import { play } from './script.mjs';
import { scanImagePaths } from '../../src/balloon/images.js';
import { TipBox, TIP_AUTOPOP_MS } from '../../src/ui/tooltip.js';
import { FakeClock, deferred, settle } from '../runtime/fakes.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');
const { Balloons } = await import('../../src/balloon/manager.js');

// Alpha (a Satori-style id), Beta (two more arguments), an icon-only \__q, an anchor; the line to the right of Alpha
// is empty balloon space
const MENU = String.raw`\0\q[Alpha,a` + '\x01Alpha\x011' + String.raw`]\n\q[Beta,b,p1,p2]\n` +
  String.raw`\__q[服着せ替えメニュー]\_b["menu\choice5.png",inline]\__q\n\_a[OnAnchorWordExec,ゴースト]ゴースト\_a\n\nend\e`;

async function setup({ answer } = {}) {
  const { skin, ghost } = await fixture();
  const clock = new FakeClock();
  const tips = new TipBox({ root: null, clock });
  const b = new Balloons({ skin, ghostFiles: ghost, root: null, ghostDescript: new Map(), clock, tips });
  b.images.decode = false;
  await b.images.prefetch(scanImagePaths(MENU));
  play(b, MENU);
  const v = b.get(0);
  const asked = [];
  let reply = answer || (item => `tip of ${item.id}`);
  b.tipSource = item => { asked.push(item); return reply(item); };
  const sel = [];
  b.on('select', ev => sel.push(ev));
  // balloon-space centres of the four items, and a point on empty space
  const P = [0, 1, 2, 3].map(i => { const r = v.engine.linkRects(i)[0]; return [r.x + r.w / 2, r.y + r.h / 2]; });
  const EMPTY = [200, P[0][1]];
  const move = ([x, y], rest = true) => v.hoverAt(x, y, 500 + x, 300 + y, rest);
  const near = ([x, y], dx = 1) => [x + dx, y];
  return { b, v, tips, clock, asked, sel, P, EMPTY, move, near, setReply: f => { reply = f; } };
}

test('select: entering, item to item, to empty space; leaving the window keeps the item; References per kind', real, async () => {
  const { b, v, sel, P, EMPTY, move, near } = await setup();
  move(P[0]);
  move(near(P[0], 2));                                      // within the item: nothing
  move(P[1]);
  move(EMPTY);
  move(P[2]);
  v.pointerLeave();                                         // straight out of the window: no event, still selected
  assert.equal(v.selected, 2);
  move(P[2]);                                               // back on the same item: nothing
  move(P[3]);
  assert.deepEqual(sel.map(e => [e.index, e.prev, e.cause, e.scope]),
    [[0, -1, 'move', 0], [1, 0, 'move', 0], [-1, 1, 'move', 0], [2, -1, 'move', 0], [3, 2, 'move', 0]]);
  assert.deepEqual(sel.map(e => e.info), [
    { kind: 'choice', id: 'a\x01Alpha\x011', refs: [], label: 'Alpha' },
    { kind: 'choice', id: 'b', refs: ['p1', 'p2'], label: 'Beta' },
    null,
    { kind: 'choice', id: '服着せ替えメニュー', refs: [], label: '' },              // an icon only: R0 empty
    { kind: 'anchor', id: 'OnAnchorWordExec', refs: ['ゴースト'], label: 'ゴースト' },
  ]);
  v.endSelection('timeout');
  assert.deepEqual([sel.at(-1).index, sel.at(-1).prev, sel.at(-1).cause], [-1, 3, 'timeout']);
  v.endSelection('timeout');
  assert.equal(sel.length, 6, 'nothing selected: nothing to let go');
  move(P[1]);
  v.clear();
  assert.equal(v.selected, -1, 'new content: the selection goes without an event');
  assert.equal(sel.length, 7);
  play(b, MENU);
  v.pointerMove(...P[0]);                                   // touch: the highlight only
  assert.equal(v.hoverLink, 0);
  assert.equal(sel.length, 7);
});

test('above validrect.top / below validrect.bottom: each new position lets the item go, which stays selected [disasm]', async () => {
  // SSP's SelectLineInternal answers "none" there without storing it (0x5cf7a4 / 0x5cf7c6), so UpdateSelection lets the
  // stored item go at every new position; the default balloon has both margins (validrect 14..157 of 169 px)
  const { BalloonSkin } = await import('../../src/balloon/skin.js');
  const clock = new FakeClock();
  const tips = new TipBox({ root: null, clock });
  const b = new Balloons({ skin: BalloonSkin.fallback(), root: null, ghostDescript: new Map(), clock, tips });
  play(b, String.raw`\0\q[Alpha,a]\n\q[Beta,b]\e`);
  const v = b.get(0);
  const vr = v.img.geo.validRect;
  assert.ok(vr.top > 0 && vr.bottom < v.height, JSON.stringify(vr));
  const asked = [], sel = [];
  b.tipSource = item => { asked.push(item.id); return 'tip ' + item.id; };
  b.on('select', ev => sel.push([ev.index, ev.prev]));
  const P = [0, 1].map(i => { const r = v.engine.linkRects(i)[0]; return [r.x + 5, r.y + 5]; });
  assert.equal(P[0][1] - 5, vr.top, 'Alpha sits at the text rect\'s top, like emily4\'s first menu item');
  const move = ([x, y], rest = true) => v.hoverAt(x, y, 500 + x, 300 + y, rest);
  const UP = [P[0][0], vr.top - 2], UP2 = [P[0][0] + 3, vr.top - 1];
  move(P[0]); await clock.advance(500);
  assert.deepEqual([asked, tips.owner], [['a'], v]);
  move(UP);
  assert.equal(tips.owner, null, 'the tip pops');
  move(UP2);
  move(UP2);                                                // the same position again: nothing
  assert.deepEqual(sel, [[0, -1], [-1, 0], [-1, 0]]);
  assert.equal(v.selected, 0, 'still selected');
  assert.equal(v.hoverLink, -1, 'no item under the pointer');
  await clock.advance(500);                                 // a rest there: no item, the tip cache resets
  move(P[0]);
  assert.equal(sel.length, 3, 'back onto the same item: nothing');
  await clock.advance(500);
  assert.deepEqual(asked, ['a', 'a'], 'asked again after the rest outside');
  move(UP);
  move(P[1]);                                               // to another item: prev 0 (the loop's NOTIFY, then GET)
  move([P[1][0], vr.bottom + 1]);                           // below validrect.bottom
  move([P[1][0] + 200, vr.bottom]);                         // the bottom row is inside: empty space lets go for good
  move([P[1][0] + 200, vr.bottom + 3]);                     // nothing selected: nothing to let go
  assert.deepEqual(sel.slice(3), [[-1, 0], [1, 0], [-1, 1], [-1, 1]]);
  assert.equal(v.selected, -1);
  v.pointerLeave();
  move(P[0]);
  v.pointerLeave();
  move(UP);                                                 // back in through the top margin after a leave: a new position
  assert.deepEqual(sel.slice(7), [[0, -1], [-1, 0]]);
  b.destroy();
});

test('tip: asked after a 500 ms rest, once per entry; shown at the pointer; stays while moving inside; auto-pops', real, async () => {
  const { v, tips, clock, asked, P, move, near } = await setup();
  move(P[0]);
  await clock.advance(499);
  assert.equal(asked.length, 0);
  await clock.advance(1);
  assert.deepEqual(asked, [{ kind: 'choice', id: 'a\x01Alpha\x011', refs: [], label: 'Alpha', scope: 0 }]);
  assert.equal(tips.owner, v);
  assert.equal(tips.text, 'tip of a\x01Alpha\x011');
  assert.deepEqual(tips.at, { x: 500 + P[0][0], y: 300 + P[0][1] });
  move(near(P[0], 3));
  await clock.advance(1000);
  assert.equal(tips.owner, v, 'a move inside the item keeps the tip where it is');
  assert.deepEqual(tips.at, { x: 500 + P[0][0], y: 300 + P[0][1] });
  await clock.advance(TIP_AUTOPOP_MS);
  assert.equal(tips.owner, null, 'auto-pop after 20 s without a move');
  // [guess] (UI §4.8, check 6): back after the next rest, from the cache. The Windows control may well keep it
  // hidden until the pointer leaves the tool (another item or the window); change this step if ssp.exe is seen to do that
  move(near(P[0]));
  await clock.advance(500);
  assert.equal(tips.owner, v, 'back after the next rest, from the cache [guess]');
  assert.equal(asked.length, 1);
});

test('tip cache: A -> B -> A asks three times; over a gap without resting keeps A; a rest on empty space or a leave forgets', real, async () => {
  const { v, tips, clock, asked, P, EMPTY, move, near } = await setup();
  const ids = () => asked.map(i => i.id);
  move(P[0]); await clock.advance(500);
  move(P[1]);
  assert.equal(tips.owner, null, 'another item: the tip goes at once');
  await clock.advance(500);
  move(P[0]); await clock.advance(500);
  assert.deepEqual(ids(), ['a\x01Alpha\x011', 'b', 'a\x01Alpha\x011']);
  move(EMPTY); move(P[0]); await clock.advance(500);
  assert.equal(asked.length, 3, 'passing over the gap: still cached');
  assert.equal(tips.owner, v);
  move(EMPTY); await clock.advance(500);
  assert.equal(tips.owner, null);
  move(P[0]); await clock.advance(500);
  assert.equal(asked.length, 4, 'a rest on empty space reset the cache');
  v.pointerLeave();
  assert.equal(tips.owner, null);
  move(P[0]); await clock.advance(500);
  assert.equal(asked.length, 5, 'leaving the window reset it too');
  v.pointerDown();
  assert.equal(tips.owner, null, 'a press takes it away');
  move(near(P[0]), false); await clock.advance(1000);
  assert.equal(tips.owner, null, 'no tip while a button is held');
  move(P[0]); await clock.advance(500);
  assert.equal(tips.owner, v);
  assert.equal(asked.length, 5);
});

test('tip replies: 204 shows nothing and is not asked again; a late reply shows only if the pointer still rests; stale drops', real, async () => {
  const s = await setup({ answer: item => (item.id === 'b' ? null : `tip of ${item.id}`) });
  const { v, tips, clock, asked, P, move, near } = s;
  move(P[1]); await clock.advance(500);
  assert.equal(tips.owner, null, '204');
  move(near(P[1])); await clock.advance(500);
  assert.equal(asked.length, 1, 'the empty answer is cached for the item');
  // a late reply after a move inside the item: kept, shown at the next rest without a new request
  let d = deferred();
  s.setReply(() => d.promise);
  move(P[0]); await clock.advance(500);
  move(near(P[0]));
  d.resolve('late');
  await settle();
  assert.equal(tips.owner, null, 'the pointer moved: not shown');
  await clock.advance(500);
  assert.equal(tips.text, 'late');
  assert.equal(asked.length, 2);
  // a reply for a balloon that changed meanwhile is dropped, and the next rest asks again
  d = deferred();
  move(P[3]); await clock.advance(500);
  play(s.b, MENU);
  d.resolve('stale');
  await settle();
  assert.equal(tips.owner, null);
  move(P[3]); await clock.advance(500);
  assert.equal(asked.length, 4);
  // not asked (the ghost is not live): nothing shown, asked again at the next rest
  s.setReply(() => undefined);
  move(P[1]); await clock.advance(500);
  move(near(P[1])); await clock.advance(500);
  assert.equal(asked.length, 6);
  assert.equal(tips.owner, null);
  // re-skinning and hiding take a shown tip away; a re-skin keeps the cache
  s.setReply(item => 'tip ' + item.id);
  move(P[0]); await clock.advance(500);
  assert.equal(tips.owner, v);
  v.setSkin(v.skin);
  assert.equal(tips.owner, null);
  move(near(P[0])); await clock.advance(500);
  assert.equal(tips.owner, v);
  assert.equal(asked.length, 7, 're-skinned: the cache stays');
  v.hide();
  assert.equal(tips.owner, null);
});

test('no tip source (a frozen tab): nothing asked, nothing shown', real, async () => {
  const s = await setup();
  s.b.tipSource = null;
  s.move(s.P[0]);
  await s.clock.advance(1000);
  assert.equal(s.tips.owner, null);
  assert.equal(s.asked.length, 0);
});

// Tooltips (UI §4.8) and choice hover events (EV §4.3, §4.7): SSP's text, colour and placement rules (ui/tooltip.js),
// the tip box headless, and the event loop's side against a fake engine: OnChoiceEnter / OnAnchorEnter from the
// balloons' 'select', OnChoiceHover + balloon_tooltip and OnMouseHover + the shell's text or `tooltip` through the
// views' tipSource hooks, the click's and the choice timeout's NOTIFY, and when nothing is asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLoop, hoverRefs } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import {
  tipText, placeTip, luminance, fitLuminance, tipColors, dominantColor, dominantGrid, gridColor, tipMaxWidth, TipBox,
  TIP_AUTOPOP_MS, TIP_Z,
} from '../../src/ui/tooltip.js';
import { Z_BASE } from '../../src/ui/root.js';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle, deferred } from './fakes.mjs';

const GHOST = { id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };
const answers = map => r => (typeof map[r.id] === 'function' ? map[r.id](r) : map[r.id] ?? null);

async function booted(handler = () => null) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const player = new FakePlayer();
  const stage = new FakeStage();
  const balloons = new FakeBalloons();
  const loop = new EventLoop({
    shiori, player, stage, balloons, dialogs: new FakeDialogs(), ghost: GHOST, clock, env: { win: null, doc: null },
    state: new StateStore('test', { storage: memoryStorage(), clock }), ghostDescript: new Map([['name', GHOST.name]]),
    site: { ghosts: [GHOST], balloons: [] },
  });
  await loop.boot({ resume: false });
  shiori.log.length = 0;
  return { clock, shiori, player, stage, balloons, loop };
}

// ---------------------------------------------------------------- SSP's pure rules

test('text: every literal \\n is a line break; nothing else is touched (UI §4.8; entities are the loop\'s, EV §5.5)', () => {
  assert.equal(tipText('■なんか話して■\\nみんなでおしゃべりします。'), '■なんか話して■\nみんなでおしゃべりします。');
  assert.equal(tipText('Automatically shortens file names to fit\\nTurn this OFF if the display is slow'),
    'Automatically shortens file names to fit\nTurn this OFF if the display is slow');
  assert.equal(tipText('a\\\\nb'), 'a\\\nb', 'a plain substring replace: \\\\n gives \\ + a break');
  assert.equal(tipText('\\_q\\s[0] & <b>  '), '\\_q\\s[0] & <b>  ', 'tags, & and spaces stay as they are');
  assert.equal(tipText('a\\&[amp]\\nb'), 'a\\&[amp]\nb', 'entities stay: GetStringShiori decoded a reply before');
  assert.equal(tipText(null), '');
});

test('placement: at the pointer x, 20 px under it; above it at the bottom, moved left at the right edge', () => {
  const vp = { width: 1280, height: 720 };
  assert.deepEqual(placeTip({ x: 100, y: 100 }, { w: 200, h: 40 }, vp), { left: 100, top: 120 });
  assert.deepEqual(placeTip({ x: 1200, y: 100 }, { w: 200, h: 40 }, vp), { left: 1078, top: 120 }, 'kept 2 px inside');
  assert.deepEqual(placeTip({ x: 100, y: 690 }, { w: 200, h: 40 }, vp), { left: 100, top: 648 }, 'above the pointer');
  assert.deepEqual(placeTip({ x: -5, y: 10 }, { w: 2000, h: 900 }, vp), { left: 2, top: 2 }, 'never past the top-left');
});

test('colours: SSP\'s luminance, FitLuminance and the tooltip\'s contrast fix (SetColors)', () => {
  assert.equal(luminance([255, 255, 255]), 255);
  assert.equal(luminance([105, 25, 25]), 48);
  assert.equal(luminance([84, 32, 27]), 46, 'truncated: 46.978');
  // emily4: white under the menu, dark red text -> far apart, kept
  assert.deepEqual(tipColors([255, 255, 255], [105, 25, 25]), { bg: [255, 255, 255], fg: [105, 25, 25] });
  // a light background and a light text (within 90): the text goes dark, to L(bg) - 130
  const t = tipColors([230, 240, 250], [200, 200, 200]);
  assert.ok(Math.abs(luminance(t.fg) - (luminance([230, 240, 250]) - 130)) <= 1, String(t.fg));
  // a dark background and a dark text: the text goes light
  const d = tipColors([20, 20, 40], [60, 60, 60]);
  assert.ok(luminance(d.fg) >= luminance([20, 20, 40]) + 129, String(d.fg));
  assert.deepEqual(fitLuminance([10, 20, 30], luminance([10, 20, 30])), [10, 20, 30], 'already there: unchanged');
  assert.deepEqual(fitLuminance([100, 100, 100], 0), [0, 0, 0]);
  assert.deepEqual(fitLuminance([100, 100, 100], 255), [255, 255, 255]);
});

test('dominant colour: alpha >= 128 only, 4-bit bins, the fullest bin\'s average; the 6 x 8 grid over the validrect', () => {
  const w = 30, h = 40, data = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, c, a = 255) => { const i = (y * w + x) * 4; data.set([...c, a], i); };
  const fill = (x0, y0, x1, y1, c, a) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, c, a); };
  // alpha 127 never counts, 128 does (the 127 pixel's bin is the lower one: it would win the tie)
  put(0, 0, [10, 10, 10], 127); put(1, 0, [100, 0, 0], 128);
  assert.deepEqual(dominantColor(data, w, 0, 0, 2, 1), [100, 0, 0]);
  put(1, 0, [100, 0, 0], 127);
  assert.deepEqual(dominantColor(data, w, 0, 0, 2, 1), [0, 0, 0], 'nothing counted: black');
  // one bin, three pixels (their average) beats a lower bin with two
  put(0, 1, [100, 0, 0]); put(1, 1, [104, 2, 0]); put(2, 1, [100, 0, 6]); put(3, 1, [10, 10, 10]); put(4, 1, [12, 12, 12]);
  assert.deepEqual(dominantColor(data, w, 0, 1, 5, 2), [101, 0, 2]);
  // the grid: an inset validrect (18 x 24: 3 x 3 px cells), blue inside, grey outside, its first cell red
  const OUT = [250, 250, 250], IN = [20, 40, 200], RED = [200, 30, 30];
  const vr = { left: 6, top: 8, right: 24, bottom: 32 };
  fill(0, 0, w, h, OUT, 255);
  fill(vr.left, vr.top, vr.right, vr.bottom, IN, 255);
  fill(6, 8, 9, 11, RED, 255);
  const grid = dominantGrid(data, w, h, vr);
  assert.equal(grid.cells.length, 48);
  assert.deepEqual([grid.cells[0], grid.cells[1], grid.cells[5], grid.cells[47]], [RED, IN, IN, IN],
    'cells over the validrect only');
  assert.deepEqual(grid.whole, OUT, 'the whole image');
  assert.deepEqual(gridColor(grid, 6, 8), RED, 'just inside the top-left corner: the first cell');
  assert.deepEqual(gridColor(grid, 8.9, 10.9), RED);
  assert.deepEqual(gridColor(grid, 9, 8), IN, 'the next cell');
  assert.deepEqual(gridColor(grid, 2, 3), RED, 'clamped to the grid');
  assert.deepEqual(gridColor(grid, 23, 31), IN);
  assert.deepEqual(gridColor(grid, 999, -40), IN);
  const empty = dominantGrid(data, w, h, { left: 5, top: 5, right: 5, bottom: 20 });
  assert.deepEqual(gridColor(empty, 3, 3), empty.whole, 'a rect without area: the whole image\'s colour');
});

test('wrap width: TTM_SETMAXTIPWIDTH 500 is device px (SSP is DPI-aware): 400 CSS px on a 125 % display', () => {
  assert.equal(tipMaxWidth(1), 500);
  assert.equal(tipMaxWidth(1.25), 400);
  assert.equal(tipMaxWidth(2), 250);
  assert.equal(tipMaxWidth(0), 500, 'no ratio: 1');
});

test('the box (headless): one owner at a time, hide(owner) only its own, auto-pop after 20 s, touch restarts it', async () => {
  const clock = new FakeClock();
  const box = new TipBox({ root: null, clock });
  const a = {}, b = {};
  box.show(a, 'Tip A', { x: 10, y: 20 });
  assert.equal(box.owner, a);
  assert.deepEqual(box.pos, { left: 10, top: 40 });
  box.show(b, 'Tip B', { x: 30, y: 40, look: { bg: [255, 255, 255], fg: [1, 2, 3] } });
  assert.equal(box.owner, b, 'a new tip replaces the old one');
  box.hide(a);
  assert.equal(box.owner, b, 'another owner cannot hide it');
  await clock.advance(TIP_AUTOPOP_MS - 100);
  box.touch(b);
  await clock.advance(TIP_AUTOPOP_MS - 100);
  assert.equal(box.text, 'Tip B', 'touched: the auto-pop started over');
  await clock.advance(100);
  assert.equal(box.owner, null, 'auto-pop');
  box.show(a, '', { x: 0, y: 0 });
  assert.equal(box.owner, null, 'no text, no tip');
  assert.equal(TIP_Z, Z_BASE + 199, 'above every ghost layer (<= +189) and the dock (+190), below the menus (+200)');
});

// ---------------------------------------------------------------- the event loop

test('choice hover: enter GET with References, leave NOTIFY (to another item) or GET (to empty space); anchors', async () => {
  const t = await booted();
  const a = { kind: 'choice', id: 'a\x01Alpha\x011', refs: [], label: 'Alpha　 ' };
  const b = { kind: 'choice', id: 'On再生リスト削除', refs: ['3'], label: '×' };
  const w = { kind: 'anchor', id: 'OnAnchorWordExec', refs: ['ゴースト'], label: 'ゴースト' };
  t.balloons.emit('select', { scope: 0, index: 0, prev: -1, cause: 'move', info: a });
  t.balloons.emit('select', { scope: 0, index: 1, prev: 0, cause: 'move', info: b });
  t.balloons.emit('select', { scope: 0, index: -1, prev: 1, cause: 'move', info: null });
  t.balloons.emit('select', { scope: 0, index: 2, prev: -1, cause: 'move', info: w });
  t.balloons.emit('select', { scope: 0, index: -1, prev: 2, cause: 'timeout', info: null });
  await settle();
  assert.deepEqual(t.shiori.log.map(r => [r.method, r.id, r.refs]), [
    ['GET', 'OnChoiceEnter', ['Alpha　 ', 'a\x01Alpha\x011']],
    ['NOTIFY', 'OnChoiceEnter', []],
    ['GET', 'OnChoiceEnter', ['×', 'On再生リスト削除', '3']],
    ['GET', 'OnChoiceEnter', []],
    ['GET', 'OnAnchorEnter', ['ゴースト', 'OnAnchorWordExec', 'ゴースト']],
    ['NOTIFY', 'OnChoiceEnter', []],
  ]);
  assert.deepEqual(hoverRefs({ label: '', id: '何か話して' }), ['', '何か話して'], 'an image-only item: R0 empty');
});

test('choice hover: the enter reply plays like a click\'s (it replaces the running script) [disasm PlayScriptWithMsg]', async () => {
  const t = await booted(answers({ OnChoiceEnter: r => (r.refs.length ? '\\1Help for ' + r.refs[1] + '\\e' : null) }));
  t.loop.playScript('\\0menu\\q[A,a]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  t.balloons.emit('select', { scope: 0, index: 0, prev: -1, cause: 'move', info: { kind: 'choice', id: 'a', refs: [], label: 'A' } });
  await settle();
  assert.equal(t.player.last.script, '\\1Help for a\\e');
  assert.equal(t.player.last.meta.event, 'OnChoiceEnter');
});

test('balloon tip: GET OnChoiceHover, then GET balloon_tooltip, same References; 204 -> null; \\n -> break', async () => {
  const t = await booted(answers({
    balloon_tooltip: r => (r.refs[1] === 'AITALK' ? '■' + r.refs[0].trim() + '■\\nみんなでおしゃべりします。' : null),
  }));
  const item = { kind: 'choice', id: 'AITALK', refs: [], label: 'なんか話して    ' };
  assert.equal(await t.balloons.tipSource({ ...item, scope: 0 }), '■なんか話して■\nみんなでおしゃべりします。');
  assert.equal(await t.balloons.tipSource({ kind: 'choice', id: 'CANCEL', refs: [], label: '閉じる', scope: 0 }), null);
  assert.equal(await t.balloons.tipSource({ kind: 'anchor', id: 'http://example.com/', refs: [], label: 'link', scope: 0 }), null);
  assert.deepEqual(t.shiori.log.map(r => [r.method, r.id, r.refs]), [
    ['GET', 'OnChoiceHover', ['なんか話して    ', 'AITALK']],
    ['GET', 'balloon_tooltip', ['なんか話して    ', 'AITALK']],
    ['GET', 'OnChoiceHover', ['閉じる', 'CANCEL']],
    ['GET', 'balloon_tooltip', ['閉じる', 'CANCEL']],
    ['GET', 'OnAnchorHover', ['link', 'http://example.com/']],
    ['GET', 'balloon_tooltip', ['link', 'http://example.com/']],
  ]);
});

test('a click lets the item go first: NOTIFY OnChoiceEnter, then OnChoiceSelectEx; a choice timeout NOTIFYs before OnChoiceTimeout', async () => {
  const t = await booted();
  t.loop.playScript('\\0menu\\q[Yes,y]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  t.balloons.emit('link', { kind: 'choice', id: 'y', label: 'Yes', refs: [], scope: 0 });
  await settle();
  assert.deepEqual(t.shiori.ids().slice(0, 3), ['NOTIFY OnChoiceEnter', 'GET OnChoiceSelectEx', 'GET OnChoiceSelect']);
  t.shiori.log.length = 0;
  // the timeout: the balloons let their selected items go ('select' cause timeout) before the hide
  const order = [];
  t.balloons.endSelections = cause => {
    order.push('end:' + cause);
    t.balloons.emit('select', { scope: 0, index: -1, prev: 0, cause, info: null });
  };
  const hideAll = t.balloons.hideAll.bind(t.balloons);
  t.balloons.hideAll = () => { order.push('hide'); hideAll(); };
  t.loop.playScript('\\0menu\\q[Yes,y]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  await t.clock.advance(30000);
  assert.deepEqual(order.slice(0, 2), ['end:timeout', 'hide']);
  assert.deepEqual(t.shiori.ids().filter(x => /Choice/.test(x)), ['NOTIFY OnChoiceEnter', 'GET OnChoiceTimeout']);
});

test('nothing hovers while not live: frozen, closed, swapping, minimized, or a picked choice\'s reply on its way', async () => {
  const t = await booted();
  const item = { kind: 'choice', id: 'a', refs: [], label: 'A', scope: 0 };
  const sel = { scope: 0, index: 0, prev: -1, cause: 'move', info: item };
  // a choice was picked and its reply has not started: the old balloon is dead
  const wait = deferred();
  t.shiori.handler = r => (r.id === 'OnChoiceSelectEx' ? wait.promise : null);
  t.loop.playScript('\\0menu\\q[A,a]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  t.balloons.emit('link', { kind: 'choice', id: 'a', label: 'A', refs: [], scope: 0 });
  await settle();
  t.shiori.log.length = 0;
  t.balloons.emit('select', sel);
  assert.equal(await t.balloons.tipSource(item), undefined, 'not asked');
  assert.equal(await t.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: true }), undefined);
  assert.deepEqual(t.shiori.ids(), []);
  wait.resolve(null);
  await settle();
  // a shell swap
  t.shiori.handler = () => null;
  t.loop.detachStage();
  t.shiori.log.length = 0;
  t.balloons.emit('select', sel);
  assert.equal(await t.balloons.tipSource(item), undefined);
  assert.deepEqual(t.shiori.ids(), []);
  assert.equal(t.stage.tipSource, null, 'the detached stage has no tip source any more');
  t.loop.attachStage(t.stage);
  assert.equal(typeof t.stage.tipSource, 'function', 'a re-attached stage gets it back');
  // minimized (Iconify), then live again after the restore
  const refused = async (what) => {
    t.shiori.log.length = 0;
    t.balloons.emit('select', sel);
    assert.equal(await t.balloons.tipSource(item), undefined, what);
    assert.equal(await t.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: true }), undefined, what);
    await settle();
    assert.deepEqual(t.shiori.ids(), [], what);
  };
  await t.loop.minimize();
  assert.ok(t.loop.minimized);
  await refused('minimized');
  await t.loop.restore();
  await settle();
  t.shiori.log.length = 0;
  t.balloons.emit('select', sel);
  await settle();
  assert.deepEqual(t.shiori.ids(), ['GET OnChoiceEnter'], 'restored: live again');
  // frozen (suspended: another tab leads) and destroyed
  await t.loop.suspend();
  t.shiori.log.length = 0;
  t.balloons.emit('select', sel);
  assert.equal(await t.balloons.tipSource(item), undefined);
  assert.deepEqual(t.shiori.ids(), []);
  t.loop.destroy();
  assert.equal(t.balloons.tipSource, null);
  assert.equal(t.stage.tipSource, null);
  // closed: Close of the only ghost (OnCloseAll and OnClose answered 204: closed at once); the hooks are still set
  const c = await booted();
  await c.loop.close();
  assert.equal(c.loop.closed, true);
  assert.equal(typeof c.balloons.tipSource, 'function');
  c.shiori.log.length = 0;
  c.balloons.emit('select', sel);
  assert.equal(await c.balloons.tipSource(item), undefined, 'closed');
  assert.equal(await c.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: true }), undefined, 'closed');
  await settle();
  assert.deepEqual(c.shiori.ids(), [], 'closed');
});

test('shell tip: a fresh rest sends OnMouseHover, then the shell\'s own text wins; else GET tooltip [x, y, 0, scope, collision, 0]', async () => {
  const t = await booted(answers({ tooltip: r => (r.refs[4] === 'Mmenu' ? 'Show menu' : null), OnMouseHover: null }));
  t.stage.shell.tooltip = (scope, c) => (scope === 0 && c.toLowerCase() === 'head' ? 'Head\\nof the shell' : null);
  assert.equal(await t.stage.tipSource({ scope: 0, collision: 'Head', x: 10.7, y: 20.2, fresh: true, device: 'pen' }), 'Head\nof the shell');
  assert.equal(await t.stage.tipSource({ scope: 99, collision: 'Mmenu', x: 5, y: 6, fresh: true, device: 'mouse' }), 'Show menu');
  assert.equal(await t.stage.tipSource({ scope: 99, collision: 'Mmenu', x: 5, y: 6, fresh: false }), 'Show menu', 'not fresh: no OnMouseHover');
  assert.equal(await t.stage.tipSource({ scope: 99, collision: 'Mdate', x: 5, y: 6, fresh: true }), null, '204: no tip');
  assert.equal(await t.stage.tipSource({ scope: 0, collision: '', x: 5, y: 6, fresh: true }), undefined, 'no collision: nothing');
  assert.deepEqual(t.shiori.log.map(r => [r.method, r.id, r.refs]), [
    ['GET', 'OnMouseHover', [10, 20, 0, 0, 'Head', 0, 'pen']],
    ['GET', 'OnMouseHover', [5, 6, 0, 99, 'Mmenu', 0, 'mouse']],
    ['GET', 'tooltip', [5, 6, 0, 99, 'Mmenu', 0]],
    ['GET', 'tooltip', [5, 6, 0, 99, 'Mmenu', 0]],
    ['GET', 'OnMouseHover', [5, 6, 0, 99, 'Mdate', 0, 'mouse']],
    ['GET', 'tooltip', [5, 6, 0, 99, 'Mdate', 0]],
  ]);
});

test('balloon_tooltip and tooltip go out and are read as GetStringShiori (EV §5.5): kind resource, SenderType internal; 200/311/312', async () => {
  let reply = null;
  const t = await booted(r => (r.id === 'balloon_tooltip' || r.id === 'tooltip' ? reply : null));
  const balloonTip = () => t.balloons.tipSource({ kind: 'choice', id: 'a', refs: ['r2'], label: 'A', scope: 0 });
  const shellTip = () => t.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: false });
  for (const [r, want, what] of [
    [{ status: 200, value: 'one\\ntwo' }, 'one\ntwo', '200'],
    [{ status: 311, value: 'x' }, 'x', '311'],
    [{ status: 312, value: 'x' }, 'x', '312'],
    [{ status: 203, value: 'x' }, null, 'another 2xx: no tip'],
    [{ status: 200, headers: { String: 'from String' } }, 'from String', 'String without Value'],
    [{ status: 200, headers: { Sentence: 'from Sentence' } }, 'from Sentence', 'then Sentence'],
  ]) {
    reply = r;
    assert.equal(await balloonTip(), want, `balloon_tooltip: ${what}`);
    assert.equal(await shellTip(), want, `tooltip: ${what}`);
  }
  const reads = t.shiori.log.filter(r => r.id === 'balloon_tooltip' || r.id === 'tooltip');
  assert.equal(reads.length, 12);
  for (const r of reads) assert.deepEqual([r.method, r.kind, r.headers.SenderType], ['GET', 'resource', 'internal'], r.id);
  assert.deepEqual(reads[0].refs, ['A', 'a', 'r2'], 'the hover event\'s References');
  assert.equal(t.shiori.find('OnChoiceHover')[0].kind, undefined, 'the hover event itself is an event');
});

test('tip texts from the ghost get SSP\'s entity decoding (GetStringShiori, EV §5.5); the shell\'s own text does not', async () => {
  const t = await booted(answers({
    balloon_tooltip: 'Tom \\&[amp] Jerry \\&[star] \\\\&[amp]\\nnext',
    tooltip: '\\&[lt]menu\\&[gt]\\n\\&[AMP]',
    OnMouseHover: null,
  }));
  assert.equal(await t.balloons.tipSource({ kind: 'choice', id: 'a', refs: [], label: 'A', scope: 0 }),
    'Tom & Jerry   \\\\&[amp]\nnext', 'SSP\'s table: `star` is no name there (a space); `\\\\` is skipped as a pair');
  assert.equal(await t.stage.tipSource({ scope: 99, collision: 'Mmenu', x: 5, y: 6, fresh: true }), '<menu>\n ',
    'case-sensitive: AMP is unknown');
  t.stage.shell.tooltip = () => 'own \\&[amp]\\ntext';
  assert.equal(await t.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: false }), 'own \\&[amp]\ntext',
    'a shell\'s <scope>.tooltips line never went through GetStringShiori');
});

test('shell tip inside \\t: no OnMouseHover (SSP\'s IsNoInterrupt), the text is still asked; OnMouseHover\'s reply plays', async () => {
  const t = await booted(answers({ OnMouseHover: '\\0hovered\\e', tooltip: 'tip' }));
  t.player.timeCritical = true;
  assert.equal(await t.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: true }), 'tip');
  assert.deepEqual(t.shiori.ids(), ['GET tooltip']);
  t.player.timeCritical = false;
  t.shiori.log.length = 0;
  await t.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: true });
  assert.deepEqual(t.shiori.ids(), ['GET OnMouseHover', 'GET OnTranslate', 'GET tooltip']);
  assert.equal(t.player.last.script, '\\0hovered\\e');
  // the stage's 'hover' MouseInfo is not an event of its own any more
  t.shiori.log.length = 0;
  t.stage.emit('mouse', { type: 'hover', scope: 0, x: 1, y: 2, collision: 'Head', device: 'mouse' });
  await settle();
  assert.deepEqual(t.shiori.ids(), []);
});

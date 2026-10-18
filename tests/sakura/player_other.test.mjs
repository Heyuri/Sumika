// The player's side of \![raiseother], \![notifyother], \![timerraiseother], \![timernotifyother] (EV §2.7.9,
// SS §5.7): the host gets SSP's arguments (C2, C8), the script never waits, a replay never repeats them; and the
// `repeat` of every timer tag read as SSP's ParseBool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './mocks.mjs';
import { tokenize } from '../../src/sakura/tokenizer.js';
import { isSideEffect } from '../../src/sakura/commands.js';

const S = s => s.replace(/¥/g, '\\');

/** mocks.mjs setup() with a host that also takes raiseOther (what the EventLoop has). */
function other(o = {}) {
  const m = setup({ speedMs: 0, ...o });
  m.host.raiseOther = (...a) => { m.rec.host.push(['raiseOther', ...a]); m.rec.log.push(['h', 'raiseOther', ...a]); return o.ret; };
  return m;
}
const hostCalls = (m, name) => m.rec.host.filter(h => h[0] === name).map(h => h.slice(1));

test('\\![raiseother] / \\![notifyother] reach host.raiseOther(ghost, event, References, {notify}) (C2)', async () => {
  const m = other();
  await m.player.play(S('¥0a¥![raiseother,Ys,OnKanadeTeaTime,紅茶,クッキー,1,]b¥![notifyother,__SYSTEM_ALL_GHOST__,OnN,,x]c¥e'));
  assert.deepEqual(hostCalls(m, 'raiseOther'), [
    ['Ys', 'OnKanadeTeaTime', ['紅茶', 'クッキー', '1'], { notify: false }],
    ['__SYSTEM_ALL_GHOST__', 'OnN', ['', 'x'], { notify: true }],
  ], 'References as ParametersToArray: an empty last one ends them, a middle one is empty');
  assert.equal(m.balloons.get(0).text, 'abc');
  assert.deepEqual(hostCalls(m, 'unknownTag'), [], 'not reported as unsupported');

  // no argument: no ghost (SSP's `invalid` alone); a ghost without an event: the host refuses it (`invalid|notfound`)
  const n = other();
  await n.player.play(S('¥![raiseother]¥![raiseother,Ys]¥![NotifyOther,Ys,]¥e'));
  assert.deepEqual(hostCalls(n, 'raiseOther'), [
    [undefined, '', [], { notify: false }], ['Ys', '', [], { notify: false }], ['Ys', '', [], { notify: true }],
  ]);

  // a host without raiseOther (an older one): reported once, like any tag it cannot do
  const old = setup({ speedMs: 0 });
  await old.player.play(S('¥![raiseother,Ys,OnX]¥![raiseother,Zs,OnY]¥e'));
  assert.deepEqual(hostCalls(old, 'unknownTag'), [[S('¥![raiseother,Ys,OnX]')]]);
});

test('the script never waits for another ghost: a host promise that never settles does not hold it (C1)', async () => {
  const m = other({ ret: new Promise(() => {}) });
  const r = await m.player.play(S('¥0before¥![raiseother,Ys,OnX]after¥e'));
  assert.deepEqual(hostCalls(m, 'raiseOther'), [['Ys', 'OnX', [], { notify: false }]]);
  assert.equal(r.reason, 'end');
  assert.equal(m.balloons.get(0).text, 'beforeafter');
  assert.equal(m.player.busy, false);
});

test('\\![timerraiseother] / \\![timernotifyother,ms,repeat,ghost,event,r…] -> timerRaise with `to` (C8)', async () => {
  const m = other();
  await m.player.play(S('¥![timerraiseother,2000,1,Ys,OnT,a,]¥![timernotifyother,30000,0,Zs\x01Ys,OnN]' +
    '¥![timerraiseother,1000,1,Ys]¥![timerraiseother,1000,1,Ys,]¥![timerraiseother,0,1,,OnT]¥e'));
  assert.deepEqual(hostCalls(m, 'timerRaise'), [
    [2000, false, 'OnT', ['a'], { notify: false, to: 'Ys' }],
    [30000, true, 'OnN', [], { notify: true, to: 'Zs\x01Ys' }],
    [0, false, 'OnT', [], { notify: false, to: '' }],
  ], 'without an event (or an empty one) SSP ignores the tag; 0 ms cancels');
  assert.deepEqual(hostCalls(m, 'raiseOther'), [], 'nothing raised at the tag');
});

test('timer `repeat` is SSP\'s ParseBool for all four tags: only 1 is once; 0, false, empty, garbage repeat [disasm 0x789660]', async () => {
  const m = other();
  const vals = ['0', 'false', '', 'abc', '1.5', '1', '2', 'true', 'ON'];
  await m.player.play(S(vals.map((r, i) => `¥![timerraise,100,${r},E${i}]`).join('') +
    vals.map((r, i) => `¥![timerraiseother,100,${r},Ys,O${i}]`).join('') + '¥![timernotify,100,,N]¥e'));
  const t = hostCalls(m, 'timerRaise');
  const want = [true, true, true, true, true, false, false, false, false];
  assert.deepEqual(t.slice(0, 9).map(x => [x[2], x[1]]), vals.map((_, i) => [`E${i}`, want[i]]));
  assert.deepEqual(t.slice(9, 18).map(x => [x[2], x[1]]), vals.map((_, i) => [`O${i}`, want[i]]));
  assert.deepEqual(t[18], [100, true, 'N', [], { notify: true }]);
});

test('a replay after a page change skips all four tags (side effects, SS §7)', async () => {
  for (const s of ['¥![raiseother,Ys,OnX]', '¥![notifyother,Ys,OnX]', '¥![timerraiseother,1,1,Ys,OnX]',
    '¥![timernotifyother,1,1,Ys,OnX]']) assert.equal(isSideEffect(tokenize(S(s))[0]), true, s);
  const a = other({ speedMs: 50 });
  a.player.play(S('¥0ab¥![raiseother,Ys,OnX]¥![timerraiseother,500,1,Ys,OnT]cdef¥e'));
  await a.clock.advance(120);
  const rs = a.player.runState();
  assert.equal(rs.state, 'running');
  assert.equal(hostCalls(a, 'raiseOther').length, 1);
  const b = other({ speedMs: 50 });
  b.player.replay(JSON.parse(JSON.stringify(rs)));
  await b.clock.runAll();
  assert.equal(b.balloons.get(0).text, 'abcdef');
  assert.deepEqual([hostCalls(b, 'raiseOther'), hostCalls(b, 'timerRaise')], [[], []]);
});

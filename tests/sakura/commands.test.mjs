// Pure helpers of the player: lenient parsing, \![move] geometry, \C detection, replay classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../src/sakura/tokenizer.js';
import {
  num, parseOffset, parseMoveArgs, moveTarget, approachTarget, AWAY_SHARE, findAppendC, isSideEffect, parseBalloonWait,
  bindValue, alignmentMode, newlineRatio, codeChar, refList, jumpString, scopeNumber, parseBool,
} from '../../src/sakura/commands.js';

const S = s => s.replace(/¥/g, '\\');

test('num is lenient but strict about junk (SS §3.7)', () => {
  assert.equal(num(' 12 '), 12);
  assert.equal(num('-3.5'), -3.5);
  assert.equal(num('＠-31', 0), 0);
  assert.equal(num('１２', 7), 7);
  assert.equal(num('', 4), 4);
  assert.equal(num(undefined, 4), 4);
});

test('move offsets fall back per half (corpus: ritht.top, left, top)', () => {
  assert.deepEqual(parseOffset('right.top'), { x: 'right', y: 'top' });
  assert.deepEqual(parseOffset('ritht.top'), { x: 'left', y: 'top' });
  assert.deepEqual(parseOffset('left'), { x: 'left', y: 'top' });
  assert.deepEqual(parseOffset('top'), { x: 'left', y: 'top' });
  assert.deepEqual(parseOffset('center.bottom'), { x: 'center', y: 'bottom' });
});

test('move arguments: legacy positional and --key= forms', () => {
  const m = parseMoveArgs(['豆撒き4', '-62', '0', '', 'left.top', 'left.top']);
  assert.equal(m.x, null);
  assert.equal(m.y, -62);
  assert.equal(m.time, 0);
  assert.equal(m.base, 'screen');
  const n = parseMoveArgs(['--X=10', '--y=fix', '--time=500', '--base=me', '--base-offset=right.bottom', '--move-offset=center.center',
    '--option=ignore-sticky-window']);
  assert.deepEqual([n.x, n.y, n.time, n.base, n.baseOffset, n.moveOffset, n.ignoreSticky],
    [10, null, 500, 'me', { x: 'right', y: 'bottom' }, { x: 'center', y: 'center' }, true]);
  assert.equal(parseMoveArgs(['cancel']).cancel, true);
});

test('move target puts the moveOffset point at anchor + (x, y)', () => {
  const me = { rect: { x: 100, y: 240, width: 50, height: 60 }, basePoint: { x: 125, y: 300 } };
  const screen = { rect: { x: 0, y: 0, width: 1000, height: 800 } };
  assert.deepEqual(moveTarget(parseMoveArgs(['-500', '0', '0', 'screen', 'right.top', 'ritht.top']), me, screen), { x: 525, y: 60 });
  assert.deepEqual(moveTarget(parseMoveArgs(['0', '0', '0', 'screen', 'right.bottom', 'right.bottom']), me, screen), { x: 975, y: 800 });
  assert.deepEqual(moveTarget(parseMoveArgs(['fix', '10', '0', 'screen']), me, screen), { x: 125, y: 70 });
});

test('\\4 / \\5 targets (UI §3.8): sideways, away by 1/20 of the viewport or until the rects touch, kept on screen', () => {
  const vp = { width: 1000, height: 800 };
  // me: rect x 300..400, base point at its bottom centre (350, 500)
  const me = (x, w = 100) => ({ rect: { x, y: 300, width: w, height: 200 }, basePoint: { x: x + w / 2, y: 500 } });
  const other = (x, w = 100) => ({ x, y: 400, width: w, height: 100 });
  assert.equal(AWAY_SHARE, 1 / 20);
  // \4: 50 px further on the side me is on; y never changes
  assert.deepEqual(approachTarget(false, me(300), other(600), vp), { x: 300, y: 500 }, 'left of the other: further left');
  assert.deepEqual(approachTarget(false, me(700), other(100), vp), { x: 800, y: 500 }, 'right of it: further right');
  assert.deepEqual(approachTarget(false, me(300), other(320), vp), { x: 300, y: 500 }, 'overlapping: still by its centre');
  assert.deepEqual(approachTarget(false, me(500), other(500), vp), { x: 500, y: 500 }, 'same centre, other in the right half: left');
  assert.deepEqual(approachTarget(false, me(400), other(400), vp), { x: 500, y: 500 }, 'same centre in the left half: right');
  // the viewport's edges stop it; a window already partly outside is not pushed further out
  assert.deepEqual(approachTarget(false, me(20), other(600), vp), { x: 50, y: 500 }, 'stops at the left edge');
  assert.equal(approachTarget(false, me(0), other(600), vp), null, 'at the edge: nothing to do');
  assert.equal(approachTarget(false, me(-30), other(600), vp), null, 'already partly outside');
  assert.deepEqual(approachTarget(false, me(880), other(100), vp), { x: 950, y: 500 }, 'stops at the right edge');
  assert.equal(approachTarget(false, me(300), other(600), { width: 0 }), null, 'no viewport: no distance');
  // \5: the facing edges meet; touching or overlapping already: no move
  assert.deepEqual(approachTarget(true, me(100), other(600), vp), { x: 550, y: 500 }, 'right edge to the other\'s left edge');
  assert.deepEqual(approachTarget(true, me(800), other(100, 200), vp), { x: 350, y: 500 }, 'left edge to its right edge');
  assert.equal(approachTarget(true, me(500), other(600), vp), null, 'touching');
  assert.equal(approachTarget(true, me(550), other(600), vp), null, 'overlapping');
  assert.deepEqual(approachTarget(true, me(100), other(950), vp), { x: 900, y: 500 }, 'an other partly off screen: me stays inside');
});

test('\\C counts as append behind non-content tags only (SUM §2.2)', () => {
  assert.equal(findAppendC(tokenize(S('¥C¥0x'))), 0);
  assert.equal(findAppendC(tokenize(S('¥1¥s[10]¥C¥0x'))), 2);
  assert.equal(findAppendC(tokenize(S('¥1¥s[10]¥![bind,a,b,1]¥![set,alignmentondesktop,free]¥w4¥C'))), 5);
  assert.equal(findAppendC(tokenize(S('¥1¥s[10]¥![raise,OnDirectSaoriCall,x]¥C'))), 3);
  assert.equal(findAppendC(tokenize(S('¥1x¥C'))), -1);
  assert.equal(findAppendC(tokenize(S('¥1¥![raise,OnOther]¥C'))), -1);
  assert.equal(findAppendC(tokenize(S('¥1¥s[10]¥0x'))), -1);
});

test('replay classes (SS §7)', () => {
  const side = s => isSideEffect(tokenize(S(s))[0]);
  for (const s of ['¥![raise,OnX]', '¥![timerraise,1,1,X]', '¥![bind,a,b,1]', '¥![move,0,0]', '¥![set,alignmentondesktop,free]',
    '¥![set,scaling,-100,100]', '¥![open,inputbox,x]', '¥-', '¥j[http://a]', '¥i[1]', '¥![set,windowstate,minimize]',
    '¥__w[animation,1]', '¥![notify,X]', '¥4', '¥5', '¥__c', '¥__t', '¥![open,teachbox]']) assert.equal(side(s), true, s);
  // \![set,balloontimeout,0] too: a replayed finished run keeps holding OnSurfaceRestore with it (EV §3.4)
  for (const s of ['¥s[1]', '¥b[2]', '¥![*]', '¥![set,choicetimeout,0]', '¥![set,balloontimeout,0]', '¥![set,balloonwait,2]',
    '¥q[a,b]', '¥x', '¥_q', '¥![quicksection,1]', '¥![embed,OnX]', '¥__w[100]', 'text']) assert.equal(side(s), false, s);
});

test('small parsers', () => {
  assert.equal(parseBalloonWait(''), null);
  assert.equal(parseBalloonWait('1'), null);
  assert.deepEqual(parseBalloonWait('0'), { mul: 0 });
  assert.deepEqual(parseBalloonWait('2.5'), { mul: 2.5 });
  assert.deepEqual(parseBalloonWait('200%'), { mul: 2 });
  assert.deepEqual(parseBalloonWait('30ms'), { ms: 30 });
  assert.equal(bindValue(undefined), '');
  assert.equal(bindValue(' 1 '), '1');
  assert.equal(bindValue('(うにゅうｹﾞｯﾄ)'), null);
  assert.equal(alignmentMode('free'), 'free');
  assert.equal(alignmentMode('FREE'), 'free');
  assert.equal(alignmentMode('nonsense'), null);
  // default / left / right go to the shell unchanged (it resolves the descript default, SS §5.2)
  assert.equal(alignmentMode('default'), 'default');
  assert.equal(alignmentMode(''), 'default');
  assert.equal(alignmentMode(' Left '), 'left');
  assert.equal(alignmentMode('right'), 'right');
  assert.equal(alignmentMode('top'), 'top');
  assert.equal(newlineRatio(null), 1);
  assert.equal(newlineRatio(['half']), 0.5);
  assert.equal(newlineRatio(['150']), 1.5);
  assert.equal(codeChar('0x41'), 'A');
  assert.equal(codeChar('12354'), 'あ');
  assert.equal(codeChar('0x80', true), '');
});

test('SSP\'s argument helpers: ParametersToArray, GetJumpString, \\p[]\'s number (SS §3.4, §5.6.2) [disasm]', () => {
  // the list ends at an empty last argument (a middle one is SSP's " "); a one-space argument is empty
  assert.deepEqual(refList(['raise', 'OnX', 'a', ''], 2), ['a']);
  assert.deepEqual(refList(['raise', 'OnX', '', 'b'], 2), ['', 'b']);
  assert.deepEqual(refList(['raise', 'OnX', ' ', 'b', ' '], 2), ['', 'b', '']);
  assert.deepEqual(refList(['raise', 'OnX', ''], 2), []);
  assert.deepEqual(refList(null, 2), []);
  // a jump ID is re-joined with every non-empty reference; any case; other IDs: null
  assert.equal(jumpString(S('script:¥![raise'), ['OnX', '', 'a]']), S('script:¥![raise,OnX,a]'));
  assert.equal(jumpString('HTTPS://a.example/?q=1', ['b=2']), 'HTTPS://a.example/?q=1,b=2');
  assert.equal(jumpString('mailto:a@b', []), 'mailto:a@b');
  assert.equal(jumpString('file://x', ['y']), null, 'file: needs three slashes');
  assert.equal(jumpString('OnX', ['a']), null);
  assert.equal(scopeNumber(''), 0, '\\p[]: SSP goes on with 0');
  assert.equal(scopeNumber('101'), 101);
  assert.equal(scopeNumber('9999'), 9999);
  assert.equal(scopeNumber('10000'), null, 'out of range');
  assert.equal(scopeNumber(' 1'), null);
  assert.equal(scopeNumber('foo'), null);
});

test('parseBool is SSP\'s SPUtils::ParseBool: words, signed digits, -1 for the rest [disasm 0x789660]', () => {
  for (const s of ['1', '2', '10', '007', '+1', '-1', 'true', 'TRUE', ' On ', 'yes', 'ok', 'enable', 'Enabled', '\t1\r\n']) {
    assert.equal(parseBool(s), 1, JSON.stringify(s));
  }
  for (const s of ['0', '00', '-0', '+000', 'false', 'False', 'off', 'no', 'ng', 'none', 'disable', 'DISABLED', ' 0 ']) {
    assert.equal(parseBool(s), 0, JSON.stringify(s));
  }
  for (const s of ['', ' ', 'abc', '1.5', '1a', '+', '１', 'truee', 'o n', undefined, null]) {
    assert.equal(parseBool(s), -1, JSON.stringify(s));
  }
});

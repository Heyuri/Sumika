// ScriptPlayer behaviour against recording mocks and a manual clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, displayLog } from './mocks.mjs';
import { ScriptPlayer } from '../../src/sakura/player.js';

const S = s => s.replace(/¥/g, '\\');
const writes = (rec, scope) => rec.log.filter(e => e[0] === 'b' && e[2] === 'write' && (scope == null || e[1] === scope));
/** play and run the clock until nothing is pending */
async function play(m, script, meta) {
  const p = m.player.play(script, meta);
  await m.clock.runAll();
  return p;
}
const calls = (rec, kind, name) => rec.log.filter(e => e[0] === kind && (kind === 'h' ? e[1] === name : e[2] === name));

/** Record the time of every write. */
function timeline(m) {
  const out = [];
  const v = m.balloons.get(0);
  const w = v.write.bind(v);
  v.write = t => { out.push([m.clock.now(), t]); w(t); };
  return out;
}

test('per-character wait, \\w digits, \\w[ms], \\_w', async () => {
  const m = setup();
  const tl = timeline(m);
  let res = null;
  m.player.play(S('¥0Hi¥w2!¥_w[30]¥w[100]x¥e'), { event: 'OnTest' }).then(r => { res = r; });
  assert.equal(m.player.busy, true);
  await m.clock.advance(1000);
  assert.deepEqual(tl, [[0, 'H'], [50, 'i'], [200, '!'], [380, 'x']]);
  assert.deepEqual(res, { reason: 'end', hasChoices: false, noChoiceTimeout: false, event: 'OnTest', shown: true });
  assert.equal(m.player.busy, false);
});

test('the virtual clock does not drift when steps run late', async () => {
  const m = setup();
  const tl = timeline(m);
  m.player.play(S('¥0abcd¥e'));
  await m.clock.advance(0);
  // jump 120 ms at once: b (50) and c (100) are both due and land in one write
  m.clock.t += 120;
  await m.clock.advance(0);
  await m.clock.advance(100);
  assert.deepEqual(tl, [[0, 'a'], [120, 'bc'], [150, 'd']]);
});

test('\\_q: text is instant, waits inside still apply, one write per frame', async () => {
  const m = setup();
  const tl = timeline(m);
  m.player.play(S('¥0¥_qabc¥_b[x.png,inline]def¥_w[100]¥cghi¥_q¥w1j¥e'));
  await m.clock.advance(1000);
  assert.deepEqual(tl, [[0, 'abc'], [0, 'def'], [100, 'ghi'], [150, 'j']]);
  const img = calls(m.rec, 'b', 'image')[0];
  assert.deepEqual(img.slice(3), ['x.png', 'inline', '', []]);
});

test('script start clears balloons and resets kinds (C15); \\e stops; balloons stay open', async () => {
  const m = setup();
  await play(m, S('¥0¥b[2]hello¥1¥s[10]x¥e never'));
  await m.clock.runAll();
  assert.equal(m.balloons.get(0).text, 'hello');
  assert.equal(m.balloons.get(0).visible, true);
  m.rec.log.length = 0;
  m.player.play(S('¥0bye¥e'));
  await m.clock.runAll();
  const head = m.rec.log.slice(0, 7).map(e => e.slice(0, 3).join(':'));
  assert.deepEqual(head, ['hideAll', 'b:0:clear', 'b:0:resetKind', 'b:0:setFont', 'b:1:clear', 'b:1:resetKind', 'b:1:setFont']);
  assert.equal(m.balloons.get(0).text, 'bye');
});

test('\\C appends, also behind non-content tags (SUM §2.2); not when nothing is visible', async () => {
  const m = setup();
  await play(m, S('¥0abc¥e'));
  m.rec.log.length = 0;
  m.player.play(S('¥1¥s[10]¥C¥![bind,a,b,1]def¥e'));
  await m.clock.runAll();
  assert.equal(calls(m.rec, 'b', 'clear').length, 0);
  assert.equal(m.rec.log.some(e => e[0] === 'hideAll'), false);
  assert.equal(m.balloons.get(0).text, 'abcdef', 'appended to scope 0 (scope resets to 0 at \\C)');
  // \C after content is not an append
  m.player.play(S('¥0x¥Cy¥e'));
  await m.clock.runAll();
  assert.equal(m.balloons.get(0).text, 'xy');
  // nothing visible -> normal clear
  m.balloons.hideAll();
  m.rec.log.length = 0;
  m.player.play(S('¥Cz¥e'));
  await m.clock.runAll();
  assert.ok(calls(m.rec, 'b', 'clear').length > 0);
  assert.equal(m.balloons.get(0).text, 'z');
});

test('a \\C run keeps the content but resets \\f and \\_n of every used balloon (SS §4 lifetime table)', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥0¥_n¥f[bold,1]abc¥1¥f[color,1,2,3]kero¥e'));
  m.rec.log.length = 0;
  await m.player.play(S('¥C¥0def¥e'));
  const ops = m.rec.log.filter(e => e[0] === 'b').map(e => e.slice(1));
  assert.deepEqual(ops, [[0, 'setFont', 'default', ''], [0, 'setNoWrap', false], [1, 'setFont', 'default', ''], [0, 'write', 'def']]);
  assert.equal(m.balloons.get(0).text, 'abcdef', 'content kept');
  assert.equal(m.balloons.get(1).text, 'kero');
  // the player's own \_n toggle was reset too: the next \_n turns no-wrap on again (not off)
  m.rec.log.length = 0;
  await m.player.play(S('¥C¥0¥_nghi¥e'));
  assert.deepEqual(calls(m.rec, 'b', 'setNoWrap').map(e => e.slice(1)), [[0, 'setNoWrap', true]]);
  // ... and a \C after that turns it off once; a balloon whose \_n is off is not touched
  m.rec.log.length = 0;
  await m.player.play(S('¥C¥0jkl¥e'));
  assert.deepEqual(calls(m.rec, 'b', 'setNoWrap').map(e => e.slice(1)), [[0, 'setNoWrap', false]]);
  assert.equal(calls(m.rec, 'b', 'clear').length, 0);
  assert.equal(m.balloons.get(0).text, 'abcdefghijkl');
});

test('play() replaces the current run', async () => {
  const m = setup();
  const r1 = m.player.play(S('¥0long text here¥e'));
  await m.clock.advance(120);
  const r2 = m.player.play(S('¥0new¥e'));
  assert.equal((await r1).reason, 'replaced');
  await m.clock.runAll();
  assert.equal((await r2).reason, 'end');
  assert.equal(m.balloons.get(0).text, 'new');
  assert.equal(m.player.generation, 2);
});

test('interrupt() stops a run; \\- quits', async () => {
  const m = setup();
  const r1 = m.player.play(S('¥0abcdef¥e'));
  await m.clock.advance(60);
  m.player.interrupt();
  assert.equal((await r1).reason, 'interrupted');
  await m.clock.advance(1000);
  assert.equal(m.balloons.get(0).text, 'ab');
  const r2 = m.player.play(S('¥0bye¥w9¥-¥e'));
  await m.clock.runAll();
  assert.equal((await r2).reason, 'quit');
  assert.equal(calls(m.rec, 'h', 'quit').length, 1);
});

test('PlayResult.shown: a run cut before it showed anything is false; text, \\s, \\i, a marker, a choice, an anchor, an image, binds, moves and other shell tags make it true (EV §3.4)', async () => {
  const cut = async (script, ms = 0) => {
    const m = setup();
    m.stage.char(0);                            // a booted ghost has the windows of \0 and \1
    m.stage.char(1);
    const r = m.player.play(S(script));
    await m.clock.advance(ms);
    m.player.interrupt();
    return (await r).shown;
  };
  assert.equal(await cut('¥0¥w9¥w9late text¥e', 100), false, 'only scope switches and waits so far');
  assert.equal(await cut('¥1¥b[2]¥n¥_l[0,0]¥![set,balloontimeout,0]¥w9x¥e', 100), false, 'balloon kind, line feed, locate, options');
  assert.equal(await cut('¥0abc¥w9¥w9¥e', 60), true, 'text written');
  assert.equal(await cut('¥0¥s[-1]¥w9¥w9x¥e', 100), true, 'a surface change, \\s[-1] too');
  assert.equal(await cut('¥0¥i[2]¥w9¥w9x¥e', 100), true, 'an animation');
  assert.equal(await cut('¥0¥![*]¥w9¥w9x¥e', 100), true, 'a marker');
  assert.equal(await cut('¥0¥q[a,b]¥w9¥w9x¥e', 100), true, 'a choice');
  assert.equal(await cut('¥0¥_a[id]¥w9¥w9x¥e', 100), true, 'an anchor');
  assert.equal(await cut('¥0¥_b[a.png,0,0]¥w9¥w9x¥e', 100), true, 'an image');
  // every tag that reaches SSP's SPSerikoAnimation::PlayCommand / PlayPatternArrayInternal of an existing character
  // [disasm 0x6f9092, 0x6f947b], whatever it changes on screen
  for (const [script, what] of [
    ['¥0¥![bind,head,ribbon,1]', 'a bind (QueueBindBlock)'], ['¥0¥4', '\\4 (ExecuteMoveTag)'], ['¥1¥5', '\\5'],
    ['¥0¥![moveasync,cancel]', 'a move cancelled (ExecuteMoveTagCancel)'],
    ['¥0¥![set,alignmenttodesktop,free]', 'an alignment (SetSerikoAlign)'], ['¥0¥![set,alpha,50]', 'alpha (SetAlpha)'],
    ['¥0¥![set,scaling,50]', 'scaling (SetScale)'], ['¥0¥![set,balloonoffset,10,10]', 'a balloon offset'],
    ['¥0¥![set,balloonalign,left]', 'a balloon alignment'], ['¥0¥![lock,repaint]', 'a repaint lock (LockRedraw)'],
    ['¥0¥![unlock,balloonmove]', 'the balloon move lock (LockBalloonUserOffset)'],
    ['¥0¥![enter,selectmode,rect]', 'select mode (EnterSelectMode)'], ['¥0¥![anim,stop,2]', 'any \\![anim]'],
  ]) assert.equal(await cut(script + '¥w9¥w9x¥e', 100), true, what);
  assert.equal(await cut('¥p[5]¥![bind,head,ribbon,1]¥w9¥w9x¥e', 100), false, 'no window for \\p[5]: nothing played');
  assert.equal(await cut('¥0¥![set,balloonwait,2]¥![set,autoscroll,disable]¥w9¥w9x¥e', 100), false, 'balloon options');
  const m = setup();
  assert.equal((await play(m, S('¥e'))).shown, false, 'an empty script reached its end (the event loop counts every end)');
  const r = m.player.play(S('¥0first'));
  await m.clock.advance(100);
  m.player.play(S('¥0second¥e'));
  assert.deepEqual([(await r).reason, (await r).shown], ['replaced', true]);
});

test('scopes up to \\p[101], surfaces, \\s[-1], balloon kinds', async () => {
  const m = setup();
  m.player.play(S('¥p[101]¥s[9702]¥p5¥s[-1]¥h¥s[3]¥u¥s[10]¥0¥b[2]¥b[-1]¥p[foo]¥e'));
  await m.clock.runAll();
  const s = calls(m.rec, 'c', 'setSurface').map(e => [e[1], e[3]]);
  assert.deepEqual(s, [[101, 9702], [5, -1], [0, 3], [1, 10]]);
  assert.deepEqual(calls(m.rec, 'b', 'setKind').map(e => e[3]), [2, -1]);
});

test('balloon tags map to the BalloonView API', async () => {
  const m = setup({ speedMs: 0 });
  m.player.play(S('¥0a¥nb¥n[half]¥n[150]¥_l[@-2,@3]¥c¥c[char,1]¥c[line,2,1]¥f[color,1,2,3]¥f[default]¥_n¥_b["menu¥choice5.png",0,0,--option=foreground]¥![*]%*¥_u[0x41]¥&[amp]¥e'));
  await m.clock.runAll();
  const ops = m.rec.log.filter(e => e[0] === 'b').map(e => e.slice(2));
  assert.deepEqual(ops, [
    ['write', 'a'], ['newline', 1], ['write', 'b'], ['newline', 0.5], ['newline', 1.5], ['locate', '@-2', '@3'],
    ['clear'], ['clearChars', 1, undefined], ['clearLines', 2, 1], ['setFont', 'color', '1,2,3'], ['setFont', 'default', ''],
    ['setNoWrap', true], ['image', S('menu¥choice5.png'), '0', '0', ['--option=foreground']], ['marker'], ['marker'],
    ['write', 'A'], ['write', '&'],
  ]);
});

test('\\&[name] is ssp.exe\'s lookup on ParseBracket\'s string: 252 names, case-sensitive, else a space (SS §5.3) [disasm 0x6292c5]', async () => {
  const text = async src => {
    const m = setup({ speedMs: 0 });
    await play(m, S('¥0[' + src + ']¥e'));
    return m.balloons.get(0).text;
  };
  assert.equal(await text('¥&[amp]¥&[lt]¥&[hearts]'), '[&<♥]');
  assert.equal(await text('fr¥&[uuml]here ¥&[Ouml]¥&[szlig]'), '[frühere Öß]', 'HTML 4 names beyond the old 47 (kayuko3, toxic060816)');
  assert.equal(await text('¥&[nope]'), '[ ]', 'unknown: a space, not ?');
  assert.equal(await text('¥&[#38]¥&[#x26]'), '[  ]', 'no numeric form');
  assert.equal(await text('¥&[AMP]¥&[Hearts]'), '[  ]', 'case-sensitive: no retry in lower case');
  assert.equal(await text('¥&[ amp]¥&[amp ]'), '[  ]', 'no trimming');
  assert.equal(await text('¥&[star]¥&[starf]¥&[apos]'), '[   ]', 'not HTML 4 names');
  assert.equal(await text('¥&[]'), '[ ]', 'an empty name is looked up too (the player has no 1–19 rule)');
  assert.equal(await text('¥&[abcdefghijklmnopqrstuvwxyz]'), '[ ]', 'nor a length limit');
  assert.equal(await text('¥&["lt"]¥&[a,b]¥&[lt¥]]'), '[<  ]', 'ParseBracket: quotes dropped, a comma is data, \\] is ]');
  assert.equal(await text('a¥&b ¥_u0x41'), '[a&b _u0x41]', 'no bracket: the name shows as text (SS §3.3)');
});

test('a tag with no bracket where it needs one shows its name, as ssp.exe (SS §3.3) [disasm]', async () => {
  const m = setup({ speedMs: 0 });
  await play(m, S('¥0¥s[4]¥1¥sもう少し¥b¥0x¥w¥p!¥e'));
  assert.equal(m.balloons.get(1).text, 'sもう少しb');
  assert.equal(m.balloons.get(0).text, 'x!', '\\w and \\p consume their name');
  assert.deepEqual(calls(m.rec, 'c', 'setSurface').map(e => [e[1], e[3]]), [[0, 4]], 'no surface change for a bare \\s');
});

test('blank text does not count; control characters are not drawn', async () => {
  const m = setup({ speedMs: 0 });
  m.player.play(S('¥0a\x01b¥e'));
  await m.clock.runAll();
  assert.deepEqual(writes(m.rec).map(e => e[3]), ['ab']);
});

test('choices: \\q forms, \\__q ranges, stray \\__q, \\*, choosing, clicks', async () => {
  const m = setup({ speedMs: 0 });
  const links = [];
  m.player.on('link', l => links.push(l));
  const r = await m.player.play(S('¥0¥q[Yes,id1]¥q[Go,OnGo,r0,r1]¥q[Run,script:¥0hi¥e]¥__q[ID2,x]¥_b[b.png,inline]Label  two¥__q¥__q¥q[Old][Title]¥e'));
  assert.deepEqual(r, { reason: 'end', hasChoices: true, noChoiceTimeout: false, event: '', shown: true });
  const v = m.balloons.get(0);
  const ops = m.rec.log.filter(e => e[0] === 'b' && /Choice|Link/.test(e[2])).map(e => e.slice(2));
  assert.deepEqual(ops, [
    ['addChoice', 'Yes', 'id1', []], ['addChoice', 'Go', 'OnGo', ['r0', 'r1']], ['addChoice', 'Run', S('script:¥0hi¥e'), []],
    ['beginLink', 'choice', 'ID2', ['x']], ['endLink'], ['addChoice', 'Title', 'Old', []],
  ]);
  // a \__q range leaves its label to the balloon (the glyph text), it must not pass an empty one
  assert.equal('label' in v.openInfo, false);
  assert.equal(m.player.choosing, true);
  assert.equal(m.player.busy, false);
  // a click stops the script but leaves the balloons up until the reply (UI §4.5); the label of a \__q range is
  // filled in when the balloon reports none
  const hides = m.rec.log.filter(e => e[0] === 'hideAll').length;
  m.balloons.emit('link', { kind: 'choice', id: 'ID2', refs: ['x'], label: '', scope: 0 });
  assert.equal(m.player.choosing, false);
  assert.equal(v.visible, true);
  assert.equal(m.rec.log.filter(e => e[0] === 'hideAll').length, hides);
  assert.equal(links.length, 1);
  assert.equal(links[0].id, 'ID2');
  assert.equal(links[0].label, 'Label two');
  // further choice clicks on the same run are ignored until the next script
  m.balloons.emit('link', { ...v.lastChoice, scope: 0 });
  assert.equal(links.length, 1);
  // \* disables the choice timeout
  const r2 = await m.player.play(S('¥0¥*¥q[a,b]¥e'));
  assert.equal(r2.noChoiceTimeout, true);
  m.balloons.emit('link', { ...m.balloons.get(0).lastChoice, scope: 0 });
  assert.equal(links.length, 2);
  assert.equal(links[1].label, 'a');
});

test('a choice click does not hide the balloons, so a \\C reply appends to them (UI §4.5, SUM §2.2)', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥0¥*¥_q¥b[2]Menu¥n¥__q[ワンタッチメニュー表示]¥_b[menu.png,inline]¥__q¥n¥q[Talk,talk]¥e'), { event: 'OnMenu' });
  const v = m.balloons.get(0);
  const menuText = v.text;
  m.rec.log.length = 0;
  m.balloons.emit('link', { kind: 'choice', id: 'ワンタッチメニュー表示', refs: [], scope: 0 });
  assert.equal(m.rec.log.some(e => e[0] === 'hideAll'), false);
  assert.equal(v.visible, true);
  // the real reply of the one-touch menu button (dic03_Menu.txt), already rewritten by OnTranslate
  const reply = S('¥C¥0¥s[0]¥1¥s[10]¥0¥_q¥_l[0,0] ¥_q¥n¥p[99]¥_w[18]¥s[9700]¥![set,alignmentondesktop,free]¥![bind,メニュー,メニュー×,1]¥e');
  const r = await play(m, reply, { event: 'OnChoiceSelect' });
  assert.equal(m.rec.log.some(e => e[0] === 'hideAll' || (e[0] === 'b' && /^(clear|resetKind)$/.test(e[2]))), false);
  assert.equal(v.visible, true);
  assert.equal(v.text, menuText + ' \n');
  // the menu's choices are still live, and so is its \* (SS §6.3, SUM §2.4)
  assert.deepEqual(r, { reason: 'end', hasChoices: true, noChoiceTimeout: true, event: 'OnChoiceSelect', shown: true });
  assert.equal(m.player.choosing, true);
  // ... and can be clicked again
  const links = [];
  m.player.on('link', l => links.push(l));
  m.balloons.emit('link', { kind: 'choice', id: 'ワンタッチメニュー表示', refs: [], scope: 0 });
  assert.equal(links.length, 1);
  // a reply that is not \C clears as usual
  await play(m, S('¥0Bye¥e'));
  assert.equal(v.text, 'Bye');
});

test('a \\C run inherits live choices; a \\c that removes them drops the inherited flags', async () => {
  const m = setup({ speedMs: 0 });
  const r1 = await m.player.play(S('¥0¥*Board¥n¥q[a1,OnA1]¥q[b2,OnB2]¥e'));
  assert.deepEqual([r1.hasChoices, r1.noChoiceTimeout], [true, true]);
  const r2 = await m.player.play(S('¥C¥1¥s[10]¥0Thinking...¥1¥e'));
  assert.deepEqual([r2.hasChoices, r2.noChoiceTimeout], [true, true]);
  assert.equal(m.player.choosing, true);
  assert.equal(m.balloons.get(0).text, 'Board\nThinking...');
  // \c clears the old choices: nothing is live any more
  const r3 = await m.player.play(S('¥C¥0¥cDone.¥e'));
  assert.deepEqual([r3.hasChoices, r3.noChoiceTimeout], [false, false]);
  assert.equal(m.player.choosing, false);
  // a run whose own \* stays
  await m.player.play(S('¥0x¥q[a,b]¥e'));
  const r4 = await m.player.play(S('¥C¥0¥*¥cy¥e'));
  assert.deepEqual([r4.hasChoices, r4.noChoiceTimeout], [false, true]);
  // without a visible balloon \C is a normal start: nothing is inherited
  await m.player.play(S('¥0¥*¥q[a,b]¥e'));
  m.balloons.hideAll();
  const r5 = await m.player.play(S('¥C¥0z¥e'));
  assert.deepEqual([r5.hasChoices, r5.noChoiceTimeout], [false, false]);
});

test('runState() of a \\C run carries its base; replay() rebuilds the content underneath', async () => {
  for (const stopAt of [0, 100, 'end']) {
    const b = setup();
    // stop the \C run part-way (or let it finish), then navigate
    const live = setup();
    live.player.play(S('¥0¥*Pick one:¥n¥q[Alpha,a]¥n¥q[Beta,b]¥e'), { event: 'OnMenu' });
    await live.clock.runAll();
    live.balloons.emit('link', { kind: 'choice', id: 'a', refs: [], scope: 0 });
    live.player.play(S('¥C¥0¥_q (panel on)¥_q¥1Some kero text.¥e'), { event: 'OnToggle', refs: ['r'] });
    if (stopAt === 'end') await live.clock.runAll(); else await live.clock.advance(stopAt);
    const rs = JSON.parse(JSON.stringify(live.player.runState()));
    assert.equal(rs.origin, 'OnToggle');
    assert.equal(rs.base.origin, 'OnMenu');
    assert.equal(rs.base.state, 'finished');
    assert.equal(rs.base.base, undefined);
    let ended = null;
    b.player.replay(rs).then(r => { ended = r; });
    assert.deepEqual(displayLog(b.rec.log), displayLog(live.rec.log), `display at ${stopAt}`);
    assert.equal(b.rec.host.filter(h => h[0] !== 'unknownTag').length, 0);
    await b.clock.runAll();
    await live.clock.runAll();
    assert.equal(b.balloons.get(0).text, 'Pick one:\n\n (panel on)');
    assert.equal(b.balloons.get(0).text, live.balloons.get(0).text);
    assert.equal(b.balloons.get(1).text, live.balloons.get(1).text);
    assert.deepEqual(ended, { reason: 'end', hasChoices: true, noChoiceTimeout: true, event: 'OnToggle', shown: true });
    assert.equal(b.player.choosing, true);
    // the replayed run saves the same chain again
    assert.deepEqual(JSON.parse(JSON.stringify(b.player.runState())).base, rs.base);
  }
});

test('a \\C base is dropped once its balloons were cleared; chains are bounded', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥0Board 1¥q[x,OnX]¥e'));
  await m.player.play(S('¥C¥0 AI moves.¥e'));
  assert.equal(m.player.runState().base.src, S('¥0Board 1¥q[x,OnX]¥e'));
  // the next board frame clears scope 0 (like the Othello frames): the old chain is not needed any more
  await m.player.play(S('¥C¥0¥_q　¥c¥b[2]¥*Board 2¥q[y,OnY]¥_q¥e'));
  assert.equal(m.player.runState().base, undefined);
  // the base of a \C run that wrote into another scope is kept until that scope is cleared too
  await m.player.play(S('¥0zero¥1one¥e'));
  await m.player.play(S('¥C¥0¥cnew zero¥e'));
  assert.ok(m.player.runState().base, 'scope 1 still shows the base');
  await m.player.play(S('¥C¥1¥c¥0more¥e'));
  assert.ok(m.player.runState().base, 'the chain still holds "new zero"');
  const p = m.player.play(S('¥C¥0¥x¥e'));
  await m.clock.runAll();
  m.balloons.emit('click', { button: 0 });
  await p;
  assert.equal(m.player.runState().base, undefined, '\\x cleared every balloon');
  // depth limit
  await m.player.play(S('¥0start¥e'));
  for (let i = 0; i < 20; i++) await m.player.play(S(`¥C¥0 ${i}¥e`));
  let depth = 0;
  for (let rs = m.player.runState(); rs; rs = rs.base) depth++;
  assert.ok(depth <= 9, `chain depth ${depth}`);
});

test('OnChoiceSelect reply pairs from the corpus: a \\C frame on a board keeps the board choices live', async () => {
  const m = setup({ speedMs: 0 });
  const board = S('¥C¥0¥s[0]¥1¥s[10]¥p[99]¥s[9702]¥0¥_q　¥c¥b[2]¥*¥f[cursorpencolor,250,250,50]　¥n¥_b["othello_0.png",inline]¥__q[OnA1]¥_b["othello_1.png",inline]¥__q¥_q¥e');
  const think = S("¥C¥1¥s[10]¥p[99]¥s[9702]¥0¥s[0]I'll start things off...¥w8 ¥s[5]There.¥w8¥n¥1¥e");
  const r1 = await play(m, board, { event: 'OnChoiceSelect' });
  assert.deepEqual([r1.hasChoices, r1.noChoiceTimeout, m.player.choosing], [true, true, true]);
  const r2 = await play(m, think, { event: 'OnChoiceSelect' });
  assert.deepEqual([r2.hasChoices, r2.noChoiceTimeout, m.player.choosing], [true, true, true]);
});

test('a reply started by an earlier listener of the same click is not stopped (runtime wiring order)', async () => {
  const m = setup();
  m.player.destroy();
  // like src/core/runtime.js: the event loop subscribes to the balloons before the player exists
  let reply = null;
  m.balloons.on('link', info => { if (info.script) reply = player.play(info.script, { event: 'script:' }); });
  const player = new ScriptPlayer({ stage: m.stage, balloons: m.balloons, host: m.host, clock: m.clock, speedMs: 50 });
  player.play(S('¥0Pick¥q[Run,script:¥0reply text¥e]¥e'));
  await m.clock.runAll();
  m.balloons.emit('link', { ...m.balloons.get(0).lastChoice, scope: 0 });
  assert.ok(reply);
  assert.equal(player.busy, true, 'the reply keeps playing');
  await m.clock.runAll();
  assert.equal((await reply).reason, 'end');
  assert.equal(m.balloons.get(0).text, 'reply text');
});

test('a choice clicked while the script still types interrupts it; anchors do not', async () => {
  const m = setup();
  const p = m.player.play(S('¥0¥_a[anc]link¥_a¥q[a,b]long long text¥e'));
  await m.clock.advance(300);
  m.balloons.emit('link', { kind: 'anchor', id: 'anc', refs: [], label: 'link', scope: 0 });
  assert.equal(m.player.busy, true);
  m.balloons.emit('link', { kind: 'choice', id: 'b', refs: [], label: 'a', scope: 0 });
  assert.equal((await p).reason, 'interrupted');
  assert.equal(m.player.busy, false);
});

test('\\x waits for a balloon click, then clears all balloons and returns to scope 0', async () => {
  const m = setup({ speedMs: 0 });
  let res = null;
  m.player.play(S('¥0aaa¥1bbb¥x¥nccc¥e')).then(r => { res = r; });
  await m.clock.advance(5000);
  assert.equal(m.player.run.state, 'clickwait');
  assert.equal(m.player.busy, true);
  assert.deepEqual(calls(m.rec, 'b', 'showClickWait').map(e => [e[1], e[3]]), [[1, true]]);
  m.balloons.emit('click', { scope: 1, button: 2 });         // right click does nothing
  assert.equal(m.player.run.state, 'clickwait');
  m.balloons.emit('click', { scope: 1, button: 0 });
  await m.clock.runAll();
  assert.equal(res.reason, 'end');
  assert.equal(m.balloons.get(0).text, '\nccc');
  assert.equal(m.balloons.get(1).text, '');
});

test('\\t: timeCritical until the end of the script', async () => {
  const m = setup();
  m.player.play(S('¥0a¥tbc¥e'));
  assert.equal(m.player.timeCritical, false);
  await m.clock.advance(60);
  assert.equal(m.player.timeCritical, true);
  await m.clock.runAll();
  assert.equal(m.player.timeCritical, false);
});

test('\\![raise] blocks until the reply; empty reply continues', async () => {
  let release;
  const m = setup({ raise: () => new Promise(r => { release = r; }) });
  m.player.play(S('¥0a¥![raise,OnX,1,"2,3"]b¥e'));
  await m.clock.advance(5000);
  assert.deepEqual(m.rec.host.find(h => h[0] === 'raise').slice(1), ['OnX', ['1', '2,3'], { notify: false, embed: false, waitReply: true }]);
  assert.equal(m.balloons.get(0).text, 'a');
  assert.equal(m.player.run.state, 'blocked');
  assert.equal(m.player.busy, true);
  release(null);
  await m.clock.runAll();
  assert.equal(m.balloons.get(0).text, 'ab');
});

test('\\![raise] with a non-empty reply ends the run (the host plays the reply)', async () => {
  const m = setup({ raise: async () => S('¥0new¥e') });
  const r = await play(m, S('¥0a¥![raise,OnGoto]b¥e'));
  assert.equal(r.reason, 'replaced');
  await m.clock.runAll();
  assert.equal(m.balloons.get(0).text, 'a');
});

test('\\![raise,OnDirectSaoriCall] never waits (C25); \\![notify] never waits', async () => {
  const m = setup({ speedMs: 0, raise: () => new Promise(() => {}) });
  const r = await m.player.play(S('¥0a¥![raise,OnDirectSaoriCall,set,x,1]b¥![notify,OnN,1]c¥e'));
  assert.equal(r.reason, 'end');
  assert.equal(m.balloons.get(0).text, 'abc');
  const raises = m.rec.host.filter(h => h[0] === 'raise').map(h => [h[1], h[3].waitReply, h[3].notify]);
  assert.deepEqual(raises, [['OnDirectSaoriCall', false, false], ['OnN', false, true]]);
});

test('a reply that arrives after the run was replaced is dropped', async () => {
  let release;
  const m = setup({ raise: () => new Promise(r => { release = r; }) });
  const p1 = m.player.play(S('¥0a¥![raise,OnSlow]b¥e'));
  await m.clock.advance(100);
  m.player.play(S('¥0second¥e'));
  assert.equal((await p1).reason, 'replaced');
  release(S('¥0late¥e'));
  await m.clock.runAll();
  assert.equal(m.balloons.get(0).text, 'second');
});

test('\\![embed] splices the reply in place', async () => {
  const m = setup({ speedMs: 0, raise: async (id) => (id === 'OnE' ? S('X¥_w[10]Y') : null) });
  await play(m, S('¥0a¥![embed,OnE]b¥e'));
  assert.equal(m.balloons.get(0).text, 'aXYb');
});

test('\\![timerraise] (C3): 0 = repeat, >=1 once, ms 0 cancels', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥![timerraise,80,1,ぷよ自動落下,a,b]¥![timerraise,0,1,X]¥![timerraise,30000,0,Y]¥![timernotify,5,1,Z]¥![timerraise,5,1,]¥e'));
  const t = m.rec.host.filter(h => h[0] === 'timerRaise').map(h => h.slice(1));
  assert.deepEqual(t, [[80, false, 'ぷよ自動落下', ['a', 'b'], undefined], [0, false, 'X', [], undefined],
    [30000, true, 'Y', [], undefined], [5, false, 'Z', [], { notify: true }]]);
});

test('\\![bind] values (C24) and immediate application of off/on pairs (SUM §2.3)', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥p[95]¥![bind,L1,L1,0]¥![bind,L1,L1,1]¥0¥![bind,足,,0]¥![bind,髪,髪下ろし]¥![bind,a,b,(うにゅうｹﾞｯﾄ)]¥![bind-noevent,c,d,1]¥e'));
  const b = calls(m.rec, 'c', 'bind').map(e => e.slice(1));
  assert.deepEqual(b, [[95, 'bind', 'L1', 'L1', '0'], [95, 'bind', 'L1', 'L1', '1'], [0, 'bind', '足', '', '0'],
    [0, 'bind', '髪', '髪下ろし', ''], [0, 'bind', 'c', 'd', '1', { noEvent: true }]]);
});

test('\\![move] legacy form, lenient parse, blocking with time', async () => {
  const m = setup({ speedMs: 0, viewport: { width: 1000, height: 800 } });
  // scope 22: base (122,300), rect x 97..147, y 240..300
  await m.player.play(S('¥p[22]¥![move,-500,0,0,screen,right.top,ritht.top]¥e'));
  assert.deepEqual(calls(m.rec, 'c', 'moveTo').map(e => e.slice(3)), [[525, 60]]);
  m.rec.log.length = 0;
  // junk X = fix; base = scope 22's window
  await m.player.play(S('¥p[101]¥![move,豆撒き4,-62,0,22,left.top,left.top]¥e'));
  // scope 22 top is now 0 -> scope 101 top must be -62 -> base y = -62 + 60
  assert.deepEqual(calls(m.rec, 'c', 'moveTo').map(e => e.slice(1)), [[101, 'moveTo', 201, -2]]);
  m.rec.log.length = 0;
  // time > 0 blocks until the move completes
  const tl = [];
  const p = m.player.play(S('¥p[5]¥![move,0,0,100,screen,left.top,left.top]¥0done¥e'));
  m.balloons.get(0).write = t => tl.push([m.clock.now(), t]);
  await m.clock.advance(50);
  assert.equal(m.player.run.state, 'blocked');
  await m.clock.runAll();
  assert.equal((await p).reason, 'end');
  const moves = calls(m.rec, 'c', 'moveTo');
  assert.ok(moves.length > 3);
  assert.deepEqual(moves[moves.length - 1].slice(3), [25, 60]);
  assert.ok(tl[0][0] >= 100, 'text after the move');
});

/**
 * Make a mock character report geometryPending (its surface size still loading); `release(w, h)` gives it the new
 * size and resolves the geometryReady() promises. `asked` counts geometryReady() calls.
 */
function pendingGeometry(c) {
  const g = { asked: 0, waiters: [] };
  c.geometryPending = true;
  c.geometryReady = () => {
    g.asked++;
    if (!c.geometryPending) return Promise.resolve();
    return new Promise(r => g.waiters.push(r));
  };
  g.release = (width, height) => {
    c.size = { width, height };
    c.geometryPending = false;
    for (const r of g.waiters.splice(0)) r();
  };
  return g;
}

// scope 5: base point (105, 300); 50x60 now -> rect (80, 240); once loaded 100x200 -> rect (55, 100).
// Moving the rect's top-left corner to the screen's top-left puts the base point at (25, 60) with the stale size and
// at (50, 200) with the real one.
test('\\![move] right after a \\s waits for the surface size (geometryPending / geometryReady)', async () => {
  const m = setup({ speedMs: 0 });
  const g = pendingGeometry(m.stage.char(5));
  let res = null;
  m.player.play(S('¥p[5]¥![move,0,0,0,screen,left.top,left.top]¥0done¥e')).then(r => { res = r; });
  await m.clock.advance(100);
  assert.equal(g.asked, 1);
  assert.equal(m.player.run.state, 'blocked');
  assert.equal(calls(m.rec, 'c', 'moveTo').length, 0, 'no move with the previous surface size');
  assert.equal(m.balloons.get(0).text, '', 'the script waits for the move');
  g.release(100, 200);
  await m.clock.runAll();
  assert.deepEqual(calls(m.rec, 'c', 'moveTo').map(e => e.slice(1)), [[5, 'moveTo', 50, 200]]);
  assert.equal(m.balloons.get(0).text, 'done');
  assert.equal(res.reason, 'end');
  // timed: the animation starts from the position the window has once the size is known
  m.rec.log.length = 0;
  const g2 = pendingGeometry(m.stage.char(5));
  const p = m.player.play(S('¥p[5]¥![move,100,0,100,screen,left.top,left.top]¥0done¥e'));
  await m.clock.advance(500);
  assert.equal(calls(m.rec, 'c', 'moveTo').length, 0);
  g2.release(60, 100);                           // base (50, 200) -> rect (20, 100); stale 100x200 would say (0, 0)
  const t0 = m.clock.now();
  const tl = timeline(m);
  await m.clock.runAll();
  assert.equal((await p).reason, 'end');
  const moves = calls(m.rec, 'c', 'moveTo').map(e => e.slice(3));
  assert.ok(moves.length > 3);
  assert.deepEqual(moves[0], [63, 184], 'first frame (16 ms of 100) from the current base point (50, 200)');
  assert.deepEqual(moves[moves.length - 1], [130, 100]);
  assert.ok(tl[0][0] >= t0 + 100, 'text after the whole move');
});

test('\\![moveasync] waits for the surface size without blocking the script; cancel drops a waiting move', async () => {
  const m = setup({ speedMs: 0 });
  const g = pendingGeometry(m.stage.char(5));
  const r = m.player.play(S('¥p[5]¥![moveasync,0,0,50,screen,left.top,left.top]¥0text¥e'));
  await m.clock.advance(10);
  assert.equal((await r).reason, 'end', 'the script does not wait');
  assert.equal(m.balloons.get(0).text, 'text');
  assert.equal(calls(m.rec, 'c', 'moveTo').length, 0, 'nothing moved yet');
  g.release(100, 200);
  await m.clock.runAll();
  const moves = calls(m.rec, 'c', 'moveTo').map(e => e.slice(3));
  assert.deepEqual(moves[moves.length - 1], [50, 200]);
  // \![moveasync,cancel] before the size arrived: the move never happens
  m.rec.log.length = 0;
  const g2 = pendingGeometry(m.stage.char(5));
  m.player.play(S('¥p[5]¥![moveasync,0,0,50,screen,left.top,left.top]¥![moveasync,cancel]¥e'));
  await m.clock.advance(10);
  g2.release(10, 10);
  await m.clock.runAll();
  assert.equal(calls(m.rec, 'c', 'moveTo').length, 0);
});

test('a \\![move] waiting for the surface size: base scope pending, abort, fallback timeout', async () => {
  // the base window's size is still loading: wait for it as well
  const m = setup({ speedMs: 0 });
  const g = pendingGeometry(m.stage.char(22));
  m.player.play(S('¥p[101]¥![move,0,0,0,22,left.top,left.top]¥e'));
  await m.clock.advance(10);
  assert.equal(calls(m.rec, 'c', 'moveTo').length, 0);
  g.release(100, 200);                           // scope 22: base (122, 300) -> rect top-left (72, 100)
  await m.clock.runAll();
  // scope 101: base (201, 300), rect top-left (176, 240) -> base point at (72 + 25, 100 + 60)
  assert.deepEqual(calls(m.rec, 'c', 'moveTo').map(e => e.slice(1)), [[101, 'moveTo', 97, 160]]);

  // a run replaced while its \![move] waits: the window jumps to the target once the size is known
  const a = setup({ speedMs: 0 });
  const ga = pendingGeometry(a.stage.char(5));
  const r1 = a.player.play(S('¥p[5]¥![move,0,0,300,screen,left.top,left.top]¥0one¥e'));
  await a.clock.advance(10);
  const r2 = a.player.play(S('¥0two¥e'));
  assert.equal((await r1).reason, 'replaced');
  assert.equal(calls(a.rec, 'c', 'moveTo').length, 0);
  ga.release(100, 200);
  await a.clock.runAll();
  assert.deepEqual(calls(a.rec, 'c', 'moveTo').map(e => e.slice(1)), [[5, 'moveTo', 50, 200]], 'one jump, no animation');
  assert.equal((await r2).reason, 'end');
  assert.equal(a.balloons.get(0).text, 'two');

  // the size never arrives: after the fallback timeout the move uses what the view has (virtual clock)
  const b = setup({ speedMs: 0 });
  pendingGeometry(b.stage.char(5));
  const r = b.player.play(S('¥p[5]¥![move,0,0,0,screen,left.top,left.top]¥0late¥e'));
  await b.clock.advance(5000);
  assert.equal(b.player.run.state, 'blocked');
  await b.clock.runAll();
  assert.equal((await r).reason, 'end');
  assert.deepEqual(calls(b.rec, 'c', 'moveTo').map(e => e.slice(3)), [[25, 60]]);
  assert.equal(b.balloons.get(0).text, 'late');

  // destroy() while waiting: nothing moves afterwards
  const d = setup({ speedMs: 0 });
  const gd = pendingGeometry(d.stage.char(5));
  d.player.play(S('¥p[5]¥![move,0,0,0,screen,left.top,left.top]¥e'));
  await d.clock.advance(10);
  d.player.destroy();
  gd.release(100, 200);
  await d.clock.runAll();
  assert.equal(calls(d.rec, 'c', 'moveTo').length, 0);
});

test('known geometry keeps \\![move] synchronous; replay fast-forward never waits for geometry', async () => {
  // geometryReady() exists but nothing is pending: moved in the same step, no promise hop, no clock tick
  const m = setup({ speedMs: 0 });
  const c = m.stage.char(5);
  let asked = 0;
  c.geometryPending = false;
  c.geometryReady = () => { asked++; return Promise.resolve(); };
  m.player.play(S('¥p[5]¥![move,0,0,0,screen,left.top,left.top]¥0x¥e'));
  assert.deepEqual(calls(m.rec, 'c', 'moveTo').map(e => e.slice(3)), [[25, 60]]);
  assert.equal(m.balloons.get(0).text, 'x');
  assert.equal(m.player.busy, false);
  assert.equal(asked, 0);

  // a saved run with moves before its saved point: the fast-forward skips them (side effects) synchronously even
  // though the view's size is pending, and the rest plays on the virtual clock as usual
  const script = S('¥p[5]¥![move,0,0,0,screen,left.top,left.top]¥![moveasync,10,0,100]¥0abcdef¥e');
  const live = setup();
  live.player.play(script, { event: 'OnTest' });
  await live.clock.advance(120);
  const rs = JSON.parse(JSON.stringify(live.player.runState()));
  assert.equal(rs.state, 'running');
  const b = setup();
  const g = pendingGeometry(b.stage.char(5));
  let ended = null;
  b.player.replay(rs).then(r => { ended = r; });
  assert.equal(g.asked, 0);
  assert.deepEqual(displayLog(b.rec.log), displayLog(live.rec.log), 'restored at once');
  const tl = timeline(b);
  await b.clock.runAll();
  assert.equal(b.balloons.get(0).text, 'abcdef');
  assert.deepEqual(tl.map(e => e[0] - tl[0][0]), [0, 50, 100], 'per-character waits after the saved point');
  assert.equal(ended.reason, 'end');
  assert.equal(calls(b.rec, 'c', 'moveTo').length, 0);
  assert.equal(g.asked, 0);
});

test('\\4 / \\5 move the scope\'s character away from / next to the other one, then the script goes on (UI §3.8)', async () => {
  const m = setup({ speedMs: 0, viewport: { width: 1000, height: 800 } });
  // scope 0: base (100, 300), rect x 75..125; scope 1 shown at base (400, 300), rect x 375..425
  m.stage.char(0).setSurface(0);
  const c1 = m.stage.char(1);
  c1.setSurface(10);
  c1.base = { x: 400, y: 300 };
  m.rec.log.length = 0;
  const moves = () => calls(m.rec, 'c', 'moveTo').map(e => e.slice(1));
  // \4: 1/20 of the viewport (50 px) further left, as \0 is left of \1; then the edge stops it
  await play(m, S('¥0¥4away¥4¥4¥e'));
  assert.deepEqual(moves(), [[0, 'moveTo', 50, 300], [0, 'moveTo', 25, 300]]);
  assert.equal(m.balloons.get(0).text, 'away');
  const order = m.rec.log.filter(e => (e[0] === 'c' && e[2] === 'moveTo') || (e[0] === 'b' && e[2] === 'write'));
  assert.deepEqual(order.slice(0, 2).map(e => e[2]), ['moveTo', 'write'], 'the text after \\4 comes after the move');
  // \5 from \1: next to \0 (rect x 0..50), then nothing more to do
  m.rec.log.length = 0;
  await play(m, S('¥1¥5¥5near¥e'));
  assert.deepEqual(moves(), [[1, 'moveTo', 75, 300]]);
  assert.equal(m.balloons.get(1).text, 'near');
  // \p[2+] moves against \0 [guess]: scope 3 (base 103, rect 78..128) goes left until it touches \0's right edge
  m.rec.log.length = 0;
  await play(m, S('¥p[3]¥s[5]¥5¥e'));
  assert.deepEqual(moves(), [[3, 'moveTo', 75, 300]]);
  // \0 against a hidden \1: nothing moves, nothing is reported as unsupported
  m.rec.log.length = 0;
  c1.surfaceId = -1;
  await play(m, S('¥0¥4¥5x¥e'));
  assert.deepEqual(moves(), []);
  assert.equal(m.balloons.get(0).text, 'x');
  assert.deepEqual(m.rec.host.filter(h => h[0] === 'unknownTag'), []);
  // a ghost without \1: no window is created for it
  const one = setup({ speedMs: 0 });
  await play(one, S('¥0¥4¥5ok¥e'));
  assert.equal(one.stage.chars.has(1), false);
  assert.deepEqual(calls(one.rec, 'c', 'moveTo'), []);
  assert.equal(one.balloons.get(0).text, 'ok');
});

test('\\4 / \\5 on a character hidden by \\s[-1] move it with the size it was last shown with (UI §3.8)', async () => {
  const m = setup({ speedMs: 0, viewport: { width: 1000, height: 800 } });
  // like CharacterView: hidden, rect is 0×0 at the base point; lastRect keeps the size it was last shown with
  const hides = c => {
    const sized = () => ({ x: c.base.x - c.size.width / 2, y: c.base.y - c.size.height, ...c.size });
    Object.defineProperty(c, 'rect', { configurable: true, get: () => (c.surfaceId < 0 ? { x: c.base.x, y: c.base.y, width: 0, height: 0 } : sized()) });
    Object.defineProperty(c, 'lastRect', { configurable: true, get: () => (c.surfaceId >= 0 || c.wasShown ? sized() : null) });
    return c;
  };
  const c0 = hides(m.stage.char(0)), c1 = hides(m.stage.char(1));
  c0.size = { width: 300, height: 400 };
  c0.base = { x: 850, y: 800 };                   // rect x 700..1000: against the viewport's right edge
  c1.size = { width: 200, height: 300 };
  c1.base = { x: 300, y: 800 };                   // rect x 200..400
  c0.setSurface(0);
  c1.setSurface(10);
  c0.wasShown = c1.wasShown = true;
  const moves = () => calls(m.rec, 'c', 'moveTo').map(e => e.slice(1));
  // Maamikaso's kero runs away, hides, and comes back next to the sakura: touching it, not overlapping it
  m.rec.log.length = 0;
  await play(m, S('¥1¥s[-1]¥5¥5¥s[10]back¥e'));
  assert.deepEqual(moves(), [[1, 'moveTo', 600, 800]]);
  assert.equal(c1.rect.x + c1.rect.width, c0.rect.x);
  // \4 at the edge: a hidden window is not pushed out of the viewport either
  m.rec.log.length = 0;
  await play(m, S('¥0¥s[-1]¥4¥4¥s[0]x¥e'));
  assert.deepEqual(moves(), []);
  assert.deepEqual(c0.rect, { x: 700, y: 400, width: 300, height: 400 });
  // never shown (a \p[n] before its first \s): no size to move with, nothing moves
  hides(m.stage.char(2));
  m.rec.log.length = 0;
  await play(m, S('¥p[2]¥5¥4y¥e'));
  assert.deepEqual(moves(), []);
  assert.equal(m.balloons.get(2).text, 'y');
  // a shown window with a 0×0 base rect (an image-less surface) still moves, as a point
  m.stage.char(2).size = { width: 0, height: 0 };
  m.rec.log.length = 0;
  await play(m, S('¥p[2]¥s[5]¥5¥e'));
  assert.deepEqual(moves(), [[2, 'moveTo', 700, 300]]);
});

test('\\5 right after a \\s waits for the surface size like \\![move]; replay skips \\4 / \\5', async () => {
  const m = setup({ speedMs: 0, viewport: { width: 1000, height: 800 } });
  const c1 = m.stage.char(1);
  c1.setSurface(10);
  c1.base = { x: 400, y: 300 };                   // rect x 375..425
  const g = pendingGeometry(m.stage.char(0));     // base (100, 300), 50 wide now, 100 wide once loaded
  let res = null;
  m.player.play(S('¥0¥5done¥e')).then(r => { res = r; });
  await m.clock.advance(100);
  assert.equal(m.player.run.state, 'blocked');
  assert.equal(m.balloons.get(0).text, '');
  g.release(100, 200);                            // rect x 50..150: its right edge goes to 375
  await m.clock.runAll();
  assert.deepEqual(calls(m.rec, 'c', 'moveTo').map(e => e.slice(1)), [[0, 'moveTo', 325, 300]]);
  assert.equal(m.balloons.get(0).text, 'done');
  assert.equal(res.reason, 'end');

  // a saved run with \4 / \5 before its saved point: the window already moved (its position is saved with the stage)
  const shown = s => {
    s.stage.char(0).setSurface(0);
    s.stage.char(1).setSurface(10);
    s.stage.char(1).base = { x: 400, y: 300 };
    s.rec.log.length = 0;
  };
  const live = setup();
  shown(live);
  live.player.play(S('¥0¥4¥1¥5¥0abcdef¥e'), { event: 'OnTest' });
  await live.clock.advance(120);
  const rs = JSON.parse(JSON.stringify(live.player.runState()));
  assert.deepEqual(calls(live.rec, 'c', 'moveTo').map(e => e.slice(1)), [[0, 'moveTo', 50, 300], [1, 'moveTo', 100, 300]]);
  const b = setup();
  shown(b);
  b.player.replay(rs);
  await b.clock.runAll();
  assert.equal(b.balloons.get(0).text, 'abcdef');
  assert.deepEqual(calls(b.rec, 'c', 'moveTo'), []);
});

test('\\__c and \\__t open the communicate and teach boxes (SS §5.9)', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥0Hi¥__c¥__t¥![open,teachbox]¥![close,teachbox]¥![close,communicatebox]¥e'));
  assert.deepEqual(m.rec.host.map(x => x.slice()), [
    ['openBox', 'communicatebox', []], ['openBox', 'teachbox', []], ['openBox', 'teachbox', []],
    ['closeBox', 'teachbox', []], ['closeBox', 'communicatebox', []],
  ]);
  assert.equal(m.balloons.get(0).text, 'Hi');
});

test('window and dialog tags reach the host / views', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥p[99]¥![set,alignmentondesktop,free]¥![set,scaling,-100,100]¥![open,inputbox,タイプ答え,11500]' +
    '¥![close,inputbox,短冊２]¥![open,communicatebox]¥![set,windowstate,minimize]¥![set,choicetimeout,5000]' +
    '¥![open,browser,http://example.com/x]¥j[https://a.b/]¥j[OnAnchorSelect.URL]¥![change,ghost,random]¥![set,wallpaper,"x",center]¥e'));
  assert.deepEqual(calls(m.rec, 'c', 'setAlignment').map(e => e.slice(1)), [[99, 'setAlignment', 'free']]);
  assert.deepEqual(calls(m.rec, 'c', 'setScaling').map(e => e.slice(3)), [[-100, 100]]);
  const h = m.rec.host.filter(x => x[0] !== 'unknownTag').map(x => x.slice());
  assert.deepEqual(h, [
    ['openBox', 'inputbox', ['タイプ答え', '11500']], ['closeBox', 'inputbox', ['短冊２']], ['openBox', 'communicatebox', []],
    ['windowState', 'minimize'], ['setOption', 'choicetimeout', ['5000']], ['openUrl', 'http://example.com/x'],
    ['openUrl', 'https://a.b/'], ['change', 'ghost', ['random']], ['setOption', 'wallpaper', ['x', 'center']],
  ]);
  assert.deepEqual(m.rec.host.filter(x => x[0] === 'unknownTag').map(x => x[1]), [S('¥j[OnAnchorSelect.URL]')]);
});

test('an unclosed bracket: the tag is not run and nothing after it plays, \\e included (SS §3.4, SSP\'s "Unclosed \'[\'")', async () => {
  const m = setup({ speedMs: 0 });
  const r = await m.player.play(S('¥0a¥![raise,OnX,"b] c¥e'));
  assert.equal(r.reason, 'end');
  assert.equal(m.balloons.get(0).text, 'a');
  assert.deepEqual(m.rec.host.filter(h => h[0] === 'raise' || h[0] === 'unknownTag'), [], 'neither run nor reported as unsupported');
  // the script ends inside an open quote on a ']': closed, so it runs (SSP's last-character check)
  await m.player.play(S('¥0x¥![raise,OnY,"z]'));
  assert.deepEqual(m.rec.host.filter(h => h[0] === 'raise').map(h => [h[1], h[2]]), [['OnY', ['z]']]]);
});

test('\\q with one argument is "too few parameters": SSP shows the bracket as text; \\q skips one character', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥0¥q[abc]x¥qy[t,i]¥e'));
  assert.equal(m.balloons.get(0).text, '[abc]x');
  assert.deepEqual(calls(m.rec, 'b', 'addChoice').map(e => e.slice(3)), [['t', 'i', []]]);
});

test('\\p[]: scope 0 (SSP logs and goes on with 0); \\p[ 1] is no number, \\p[10000] out of range', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥1¥p[]a¥1¥p[ 1]b¥p[10000]c¥p["1]"]d¥e'));
  assert.equal(m.balloons.get(0).text, 'a');
  assert.equal(m.balloons.get(1).text, S('bc"]d'));
});

test('References as SSP\'s ParametersToArray hands them on: an empty last argument ends them, " " is empty', async () => {
  const m = setup({ speedMs: 0, raise: async () => null });
  await m.player.play(S('¥![raise,OnA,a,]¥![raise,OnB,,b]¥![notify,OnC, ,"x,y"]¥![embed,OnD,1,,]¥q[t,id,r,]¥__q[ID,,s]x¥__q¥e'));
  assert.deepEqual(m.rec.host.filter(h => h[0] === 'raise').map(h => [h[1], h[2]]),
    [['OnA', ['a']], ['OnB', ['', 'b']], ['OnC', ['', 'x,y']], ['OnD', ['1', '']]]);
  const links = m.rec.log.filter(e => e[0] === 'b' && (e[2] === 'addChoice' || e[2] === 'beginLink')).map(e => e.slice(4));
  assert.deepEqual(links, [['id', ['r']], ['ID', ['', 's']]]);
});

test('timer References as ParametersToArray too: \\![timerraise] / \\![timernotify] end at an empty last argument (SS §6.6)', async () => {
  // SSP copies the list into the timer up to its first empty string (0x633089–0x633141), then ExecuteRaiseTimer
  // 0x632bc2 → ExecuteRaiseReal → ParametersToArray 0x633548 [disasm]; a Satori （予定） that expanded to '' is the case
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥![timerraise,10,1,OnT,a,]¥![timerraise,10,1,OnRemind,]¥![timernotify,10,1,OnN,,b, ,]¥![timerraise,10,1,OnR,"x,y"]¥e'));
  assert.deepEqual(m.rec.host.filter(h => h[0] === 'timerRaise').map(h => [h[3], h[4]]),
    [['OnT', ['a']], ['OnRemind', []], ['OnN', ['', 'b', '']], ['OnR', ['x,y']]]);
});

test('a script: choice runs its ID re-joined with the references (SSP\'s GetJumpString): sancyome\'s clap', async () => {
  const m = setup({ speedMs: 0 });
  const v = m.balloons.get(0);
  const infos = [];
  const add = v.addChoice.bind(v);
  v.addChoice = (label, info) => { infos.push([label, info.script]); add(label, info); };
  await m.player.play(S('¥0¥q[送信,script:¥![execute,http-post,http://a.example/clap.php?id=x@2,--param=message_body="ok, then",--async=communicate¥]]' +
    '¥q[raw,script:¥![raise,OnX,a¥]]¥q[up,SCRIPT:¥0hi]¥q[plain,OnY,a,b]¥e'));
  assert.deepEqual(infos, [
    ['送信', S('¥![execute,http-post,http://a.example/clap.php?id=x@2,--param=message_body=ok, then,--async=communicate]')],
    ['raw', S('¥![raise,OnX,a]')],
    ['up', S('¥0hi')],
    ['plain', undefined],
  ]);
});

test('unknown and ignored tags are reported once per kind; any other unknown \\X is text, as ssp.exe (SS §3.2)', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥0a¥__z[1]b¥__z¥6¥6¥v¥![raiseplugin,x]¥![raiseplugin,y]c¥k¥_h¥e'));
  assert.equal(m.balloons.get(0).text, S('a[1]bck¥_h'), '\\__z swallowed, its bracket text; \\k -> k; \\_h as written');
  assert.deepEqual(m.rec.host.filter(x => x[0] === 'unknownTag').map(x => x[1]),
    [S('¥__z'), S('¥6'), S('¥v'), S('¥![raiseplugin,x]')]);
});

test('\\B \\U toggle bold and underline, \\_e hides the balloon, \\y ends, \\l \\_i do nothing (SS §3.2) [disasm]', async () => {
  const m = setup({ speedMs: 0 });
  const r = await m.player.play(S('¥0¥Ba¥U¥l¥_ib¥_e¥yc'));
  assert.deepEqual(m.rec.log.filter(e => e[0] === 'b' && e[2] === 'setFont' && e[4] === 'toggle').map(e => e[3]), ['bold', 'underline']);
  assert.equal(m.balloons.get(0).text, 'ab', '\\y ends the script like \\e');
  assert.equal(m.balloons.get(0).visible, false, '\\_e hid it');
  assert.equal(r.reason, 'end');
  assert.deepEqual(m.rec.host.filter(x => x[0] === 'unknownTag'), []);
  // with \_s on, \_e hides each synced scope's balloon
  const m2 = setup({ speedMs: 0 });
  await m2.player.play(S('¥_s¥0x¥1y¥_e¥_s¥e'));
  assert.deepEqual([m2.balloons.get(0).visible, m2.balloons.get(1).visible], [false, false]);
});

test('the player expands no %-variable (the loop did, before it played): text and \\q titles as written; %* is the marker', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥0Hi %username, %month %property[a.b] 100%%*¥q[%username,x]¥e'));
  assert.equal(m.balloons.get(0).text, 'Hi %username, %month %property[a.b] 100%');
  assert.deepEqual(calls(m.rec, 'b', 'addChoice')[0].slice(3), ['%username', 'x', []]);
  assert.equal(calls(m.rec, 'b', 'marker').length, 1);
  assert.deepEqual(m.rec.host, [], 'no host call');
});

test('\\![get,property,EV,names…]: host.raiseProperty with the names as written; the run waits for the reply (properties.md §3)', async () => {
  const replies = [];
  const m = setup({ speedMs: 0, raiseProperty: () => new Promise(r => replies.push(r)) });
  let res = null;
  m.player.play(S('¥0a¥![get,property,OnP,activeghostlist.count,"ghostlist(a,b).name", x ]b¥e')).then(r => { res = r; });
  await m.clock.runAll();
  assert.deepEqual(m.rec.host, [['raiseProperty', 'OnP', ['activeghostlist.count', 'ghostlist(a,b).name', ' x ']]]);
  assert.equal(m.balloons.get(0).text, 'a', 'waits at the tag');
  replies.shift()('');
  await m.clock.runAll();
  assert.equal(m.balloons.get(0).text, 'ab', 'an empty reply goes on');
  assert.equal(res.reason, 'end');
  // a non-empty reply replaces the run (the host plays it), as \![raise]'s
  m.player.play(S('¥0c¥![get,property,OnQ,system.year]d¥e')).then(r => { res = r; });
  await m.clock.runAll();
  replies.shift()(S('¥0reply¥e'));
  await m.clock.runAll();
  assert.equal(res.reason, 'replaced');
  assert.equal(m.balloons.get(0).text, 'c');
});

test('\\![get,property] needs an event and one name: nothing below; an empty event is refused; no host method: reported', async () => {
  const m = setup({ speedMs: 0 });
  await play(m, S('¥![get,property,OnP]¥![get,property]¥![get,property, ,a]¥![get,property,OnP,]x¥e'));
  assert.deepEqual(m.rec.host, [['raiseProperty', 'OnP', ['']]], 'only the one with a (here empty) name');
  assert.equal(m.balloons.get(0).text, 'x');
  const p = new ScriptPlayer({ host: { unknownTag: raw => p.reported.push(raw) }, clock: m.clock });
  p.reported = [];
  await p.play(S('¥![get,property,OnP,a]¥![get,other,x]¥e'));
  assert.deepEqual(p.reported, [S('¥![get,property,OnP,a]'), S('¥![get,other,x]')]);
});

test('\\![set,property,NAME,VALUE]: host.setProperty(NAME, VALUE), nothing without VALUE, later arguments dropped (properties.md §4)', async () => {
  const m = setup({ speedMs: 0 });
  await play(m, S('¥![set,property,a]¥![set,property,b,]¥![set,property,currentghost.scope(0).surface.num,5,6]¥e'));
  assert.deepEqual(m.rec.host, [['setProperty', 'b', ''], ['setProperty', 'currentghost.scope(0).surface.num', '5']]);
  // a thenable (an ext. property, a SHIORI request) holds the run until it settles, as ssp.exe's synchronous Set
  let done;
  const n = setup({ speedMs: 0, setProperty: () => new Promise(r => { done = r; }) });
  n.player.play(S('¥0a¥![set,property,currentghost.ext.k,v]b¥e'));
  await n.clock.runAll();
  assert.equal(n.balloons.get(0).text, 'a');
  done(true);
  await n.clock.runAll();
  assert.equal(n.balloons.get(0).text, 'ab');
  assert.ok(!n.rec.host.some(h => h[0] === 'setOption'), "no setOption('property') any more");
});

test('\\![open,con…(,PAGE)]: host.openWindow(\'configurationdialog\', args) for any case and any prefix of 3+ letters (SS §5.9)', async () => {
  const m = setup({ speedMs: 0 });
  await play(m, S('¥0a¥![open,configurationdialog,setup]¥![open,CONFIG,setup]¥![open,con]¥![open,Conf, setup,x]' +
    '¥![open,co]¥![open,configurationdialog]b¥e'));
  assert.deepEqual(m.rec.host.filter(h => h[0] === 'openWindow'), [
    ['openWindow', 'configurationdialog', ['setup']], ['openWindow', 'configurationdialog', ['setup']],
    ['openWindow', 'configurationdialog', []], ['openWindow', 'configurationdialog', [' setup', 'x']],
    ['openWindow', 'configurationdialog', []],
  ]);
  assert.deepEqual(m.rec.host.filter(h => h[0] === 'unknownTag').map(h => h[1]), [S('¥![open,co]')]);
  assert.equal(m.balloons.get(0).text, 'ab', 'the script goes on (a modeless dialog)');
  const p = new ScriptPlayer({ host: { unknownTag: raw => p.reported.push(raw) }, clock: m.clock });
  p.reported = [];
  await p.play(S('¥![open,configurationdialog,setup]¥e'));
  assert.deepEqual(p.reported, [S('¥![open,configurationdialog,setup]')], 'a host without openWindow: reported');
});

test('\\![set,balloonwait] and \\![quicksection]', async () => {
  const m = setup();
  const tl = timeline(m);
  m.player.play(S('¥0¥![set,balloonwait,2]ab¥![set,balloonwait,10ms]cd¥![quicksection,true]ef¥![quicksection,false]g¥e'));
  await m.clock.runAll();
  assert.deepEqual(tl, [[0, 'a'], [100, 'b'], [200, 'c'], [210, 'd'], [220, 'ef'], [220, 'g']]);
});

test('\\__w waits from the script start; \\__w[clear] resets it', async () => {
  const m = setup();
  const tl = timeline(m);
  m.player.play(S('¥0ab¥__w[500]c¥__w[clear]¥__w[100]d¥e'));
  await m.clock.runAll();
  assert.deepEqual(tl, [[0, 'a'], [50, 'b'], [500, 'c'], [650, 'd']]);
});

test('\\i[ID,wait] blocks until the animation stops', async () => {
  const m = setup({ speedMs: 0 });
  const p = m.player.play(S('¥0¥i[7,wait]x¥e'));
  await m.clock.advance(500);
  assert.equal(m.player.run.state, 'blocked');
  m.stage.char(0).stopAnimation(7);
  await m.clock.advance(100);
  assert.equal((await p).reason, 'end');
  assert.equal(m.balloons.get(0).text, 'x');
});

test('talk triggers count visible characters per scope (CharacterView.onTalk, legacy talk)', async () => {
  const m = setup({ speedMs: 0 });
  m.stage.char(0);
  await m.player.play(S('¥0ab c　d¥e'));
  assert.equal(m.rec.talk, 4);
  // a view that only has the old name still gets the trigger
  const c1 = m.stage.char(1);
  let legacy = 0;
  c1.onTalk = undefined;
  c1.talk = n => { legacy += n; };
  await m.player.play(S('¥1xyz¥e'));
  assert.equal(legacy, 3);
  // fast-forward replay does not move mouths
  const b = setup({ speedMs: 0 });
  b.stage.char(0);
  b.player.replay({ src: S('¥0abc¥e'), ip: 2, sub: 0, state: 'finished', hasChoices: false, noChoiceTimeout: false, origin: '', refs: [], embeds: [] });
  await b.clock.runAll();
  assert.equal(b.rec.talk, 0);
});

test('\\![anim] uses CharacterView.anim(id, cmd, ...) when the view has it', async () => {
  const m = setup({ speedMs: 0 });
  const got = [];
  m.stage.char(0).anim = (...a) => got.push(a);
  await m.player.play(S('¥0¥![anim,start,100]¥![anim,pause,100]¥![anim,resume,100]¥![anim,offset,100,5,-3]¥![anim,clear,100]¥![anim,bogus,1]¥e'));
  assert.deepEqual(got, [[100, 'start'], [100, 'pause'], [100, 'resume'], [100, 'offset', 5, -3], [100, 'clear']]);
  // views without anim(): start / stop map to the contract methods
  await m.player.play(S('¥1¥![anim,start,7]¥![anim,stop,7]¥e'));
  assert.deepEqual(calls(m.rec, 'c', 'startAnimation').map(e => e.slice(1)), [[1, 'startAnimation', 7]]);
  assert.deepEqual(calls(m.rec, 'c', 'stopAnimation').map(e => e.slice(1)), [[1, 'stopAnimation', 7]]);
});

test('\\![enter|leave,mode] reaches host.setOption; nouserbreakmode stays in the player', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥![enter,passivemode]¥![leave,passivemode]¥![enter,inductionmode]¥![enter,nouserbreakmode]¥![enter,selectmode,rect,1,2]¥e'));
  assert.deepEqual(m.rec.host.filter(h => h[0] === 'setOption').map(h => h.slice(1)), [
    ['enter', ['passivemode']], ['leave', ['passivemode']], ['enter', ['inductionmode']], ['enter', ['selectmode', 'rect', '1', '2']],
  ]);
  assert.equal(m.player.run.userBreakDisabled, true);
  // Status nouserbreak (SPGhost+0x41ac): kept after the run ends, until the next run [disasm Loop 0x63b540] or the leave
  assert.equal(m.player.noUserBreak, true);
  await m.player.play(S('¥0x¥e'));
  assert.equal(m.player.noUserBreak, false);
  await m.player.play(S('¥![enter,nouserbreakmode]¥![leave,nouserbreakmode]¥e'));
  assert.equal(m.player.noUserBreak, false);
});

test('\\![set,alignmenttodesktop] passes default / left / right to the shell', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥p[99]¥![set,alignmenttodesktop,default]¥![set,alignmentondesktop,left]¥![set,alignmenttodesktop,RIGHT]¥![set,alignmenttodesktop,]¥e'));
  assert.deepEqual(calls(m.rec, 'c', 'setAlignment').map(e => e[3]), ['default', 'left', 'right', 'default']);
});

test('\\_s sends text to several balloons', async () => {
  const m = setup({ speedMs: 0 });
  await m.player.play(S('¥0¥_sboth¥_s¥1one¥e'));
  assert.equal(m.balloons.get(0).text, 'both');
  assert.equal(m.balloons.get(1).text, 'bothone');
});

test('runState() + replay() reproduce the display of a full run (SS §7)', async () => {
  const script = S('¥1¥s[10]¥0¥s[5]¥b[2]Hello¥w9 there.¥![bind,a,b,1]¥![raise,OnDirectSaoriCall,x]¥n¥_q¥_l[@-2,@3]' +
    '¥__q[ID1]¥_b["menu¥choice5.png",inline]¥__q¥_l[@0,@-16]Pick me¥n¥q[Two,ID2]¥![*]¥_q¥1¥s[11]Kero talks a bit here.¥0¥x' +
    '¥nAfter the click.¥![timerraise,100,1,OnT]¥_w[300]¥![set,choicetimeout,9000]¥q[Three,OnThree,r]¥e');
  for (const stopAt of [130, 1500, 2600, 'clickwait', 'finished']) {
    const a = setup();
    a.player.play(script, { event: 'OnTest', refs: ['r0'] });
    if (stopAt === 'clickwait') await a.clock.runAll();
    else if (stopAt === 'finished') { await a.clock.runAll(); a.balloons.emit('click', { button: 0 }); await a.clock.runAll(); }
    else await a.clock.advance(stopAt);
    const rs = JSON.parse(JSON.stringify(a.player.runState()));
    assert.ok(rs, `runState at ${stopAt}`);
    assert.equal(rs.origin, 'OnTest');
    const b = setup();
    let ended = null;
    b.player.replay(rs).then(r => { ended = r; });
    // the fast-forward runs synchronously and is painted on its own; a saved click wait is re-entered by the
    // following step: the display so far is identical
    if (rs.state === 'clickwait') await b.clock.advance(0);
    assert.deepEqual(displayLog(b.rec.log), displayLog(a.rec.log), `display at ${stopAt}`);
    // side effects are not repeated
    // (script-lifetime settings such as choicetimeout are re-applied by design)
    assert.equal(b.rec.host.filter(h => h[0] !== 'unknownTag' && h[0] !== 'setOption').length, 0, `no host calls at ${stopAt}`);
    if (stopAt === 'finished') assert.deepEqual(b.rec.host.filter(h => h[0] === 'setOption'), [['setOption', 'choicetimeout', ['9000']]]);
    assert.equal(calls(b.rec, 'c', 'bind').length, 0);
    // and both runs end the same way
    for (const x of [a, b]) {
      for (let i = 0; i < 5; i++) {
        await x.clock.runAll();
        if (x.player.run.state === 'clickwait') x.balloons.emit('click', { button: 0 });
      }
    }
    if (stopAt === 'finished') assert.deepEqual(ended, { reason: 'end', hasChoices: true, noChoiceTimeout: false, event: 'OnTest', shown: true });
    assert.equal(b.balloons.get(0).text, a.balloons.get(0).text, `final text at ${stopAt}`);
    assert.equal(b.player.choosing, true);
    assert.deepEqual(b.player.runState().state, 'finished');
  }
});

test('replay re-applies saved \\![embed] replies without asking the host', async () => {
  const a = setup({ raise: async () => S('E1¥_w[200]E2') });
  a.player.play(S('¥0a¥![embed,OnE]b¥e'));
  await a.clock.advance(100);
  const rs = a.player.runState();
  assert.deepEqual(rs.embeds, [S('E1¥_w[200]E2')]);
  const b = setup({ raise: async () => 'WRONG' });
  b.player.replay(JSON.parse(JSON.stringify(rs)));
  await b.clock.runAll();
  await a.clock.runAll();
  assert.equal(b.balloons.get(0).text, 'aE1E2b');
  assert.equal(a.balloons.get(0).text, 'aE1E2b');
  assert.equal(b.rec.host.filter(h => h[0] === 'raise').length, 0);
});

test('runState is null when nothing is left on screen', async () => {
  const m = setup({ speedMs: 0 });
  assert.equal(m.player.runState(), null);
  await m.player.play(S('¥0abc¥e'));
  assert.equal(m.player.runState().state, 'finished');
  m.balloons.hideAll();
  assert.equal(m.player.runState(), null);
});

test('a run blocked on a raise is saved past the tag and replayed without re-sending it', async () => {
  let release;
  const a = setup({ speedMs: 0, raise: () => new Promise(r => { release = r; }) });
  a.player.play(S('¥0a¥![raise,OnWait]b¥e'));
  await a.clock.advance(10);
  const rs = a.player.runState();
  assert.equal(rs.state, 'blocked');
  const b = setup({ speedMs: 0 });
  const done = b.player.replay(JSON.parse(JSON.stringify(rs)));
  await b.clock.runAll();
  const r = await done;
  assert.equal(r.reason, 'end');
  assert.equal(b.balloons.get(0).text, 'ab');
  assert.equal(b.rec.host.filter(h => h[0] === 'raise').length, 0);
  release(null);
});

test('position points at the current token (OnBalloonBreak R2)', async () => {
  const m = setup();
  m.player.play(S('¥0abc¥w9def¥e'));
  await m.clock.advance(60);
  assert.equal(m.player.position, 4);          // after "ab": the next character is 'c' at offset 4
  assert.equal(m.player.script, S('¥0abc¥w9def¥e'));
  // still valid after interrupt() (the event loop breaks the script first, then sends OnBalloonBreak)
  m.player.interrupt();
  assert.equal(m.player.position, 4);
  // a stopped click wait points at the \x
  m.player.play(S('¥0ab¥xcd¥e'));
  await m.clock.runAll();
  m.player.interrupt();
  assert.equal(m.player.position, 4);
});

test('\![change,shell|balloon] waits at the tag while the host swaps (EV §2.6); a plain return or a replay does not wait', async () => {
  const m = setup({ speedMs: 0 });
  const calls = [];
  let swap = null;
  m.host.change = (kind, args) => {
    calls.push([kind, args]);
    if (kind === 'ghost' || args.some(a => /raise-event/i.test(a))) return undefined;     // EventLoop.change's rule
    swap = Promise.withResolvers();
    return swap.promise;
  };
  let res = null;
  m.player.play(S('¥0a¥![change,shell,Winter]b¥e')).then(r => { res = r; });
  await m.clock.runAll();
  assert.deepEqual(calls, [['shell', ['Winter']]]);
  assert.equal(m.balloons.get(0).text, 'a');
  assert.equal(m.player.run.state, 'blocked');
  assert.equal(m.player.busy, true);
  const saved = m.player.runState();
  assert.equal(saved.state, 'blocked');
  swap.resolve(true);
  await m.clock.runAll();
  assert.equal(m.balloons.get(0).text, 'ab', 'the script goes on once the swap is done');
  assert.equal(res && res.reason, 'end');

  // a failed swap: the script goes on too
  m.player.play(S('¥0c¥![change,balloon,Nobody]d¥e'));
  await m.clock.runAll();
  assert.equal(m.balloons.get(0).text, 'c');
  swap.reject(new Error('no such balloon'));
  await m.clock.runAll();
  assert.equal(m.balloons.get(0).text, 'cd');

  // raise-event (OnShellChanging comes first, the script is not held), and \+ / \![change,ghost] never wait
  await play(m, S('¥0e¥![change,shell,Winter,--option=raise-event]f¥+g¥![change,ghost,random]h¥e'));
  assert.equal(m.balloons.get(0).text, 'efgh');

  // a page left while it waited: the replay starts after the tag and never asks again
  const n = calls.length;
  const b = setup({ speedMs: 0 });
  b.host.change = (...a) => { calls.push(a); return new Promise(() => {}); };
  const p = b.player.replay(saved);
  await b.clock.runAll();
  assert.equal((await p).reason, 'end');
  assert.equal(calls.length, n);
  assert.equal(b.balloons.get(0).text, 'ab');
});

test('\![call,ghost,…] reaches host.call and the script goes on at once (EV §2.7); \![call,shell] is ignored', async () => {
  const m = setup({ speedMs: 0 });
  const calls = [];
  // even a thenable from the host does not hold the script: a call never waits (no BreakScript [disasm])
  m.host.call = (kind, args) => { calls.push([kind, args]); return new Promise(() => {}); };
  const res = await play(m, S('¥0a¥![call,ghost,X,--option=raise-event]b¥![call,shell,Y]c¥e'));
  assert.equal(res.reason, 'end');
  assert.deepEqual(calls, [['ghost', ['X', '--option=raise-event']]]);
  assert.equal(m.balloons.get(0).text, 'abc');
  assert.deepEqual(m.rec.host.filter(x => x[0] === 'unknownTag').map(x => x[1]), [S('¥![call,shell,Y]')]);

  // a page change replays the run without calling again (a side effect, SS §7)
  m.player.play(S('¥0d¥![call,ghost,Z]e¥xf¥e'));
  await m.clock.runAll();
  const saved = m.player.runState();
  assert.equal(saved.state, 'clickwait');
  const b = setup({ speedMs: 0 });
  b.host.call = (...a) => { calls.push(a); };
  b.player.replay(saved);
  await b.clock.runAll();
  assert.deepEqual(calls.map(c => c[1][0]), ['X', 'Z']);
  assert.equal(b.balloons.get(0).text, 'de');
});

test('\![reload,shiori|shell|balloon] and \![reloadsurface] wait at the tag for host.reload, then ResetWait; \![reload,ghost] never waits; other kinds are unknown; a replay skips them (EV §2.10)', async () => {
  const m = setup({ speedMs: 0 });
  const calls = [];
  let done = null;
  m.host.reload = kind => {
    calls.push(kind);
    if (kind === 'ghost') return undefined;      // EventLoop.reload returns nothing for a ghost
    done = Promise.withResolvers();
    return done.promise;
  };
  // reloadsurface is reload,shell [disasm 0x6313a8]; the sub-command in any case [disasm 0x62d830]
  for (const [tag, kind] of [['¥![reload,shiori]', 'shiori'], ['¥![RELOAD,Shell]', 'shell'], ['¥![reload,balloon]', 'balloon'], ['¥![reloadsurface]', 'shell']]) {
    calls.length = 0;
    let res = null;
    m.player.play(S(`¥0a${tag}b¥e`)).then(r => { res = r; });
    await m.clock.runAll();
    assert.deepEqual(calls, [kind], tag);
    assert.equal(m.balloons.get(0).text, 'a', tag);
    assert.deepEqual([m.player.run.state, m.player.run.blockKind], ['blocked', 'reload'], tag);
    done.resolve(kind !== 'balloon');           // a refused reload (false) lets the script go on too
    await m.clock.runAll();
    assert.equal(m.balloons.get(0).text, 'ab', tag);
    assert.equal(res && res.reason, 'end', tag);
  }

  // ResetWait after the tag (ExecuteExclamationTag's common exit [disasm 0x632cf0]): \__w counts from the reload's end
  const tl = timeline(m);
  m.player.play(S('¥0a¥![reload,shiori]¥__w[100]b¥e'));
  await m.clock.advance(1000);
  done.resolve(true);
  await m.clock.runAll();
  assert.deepEqual(tl.map(e => e[1]), ['a', 'b']);
  assert.equal(tl[1][0] - tl[0][0], 1100, 'b 100 ms after the reload ended, not at once');
  // a reload that does not hold the run (ghost) or does nothing (makoto) resets it at the tag
  for (const sub of ['ghost', 'makoto']) {
    tl.length = 0;
    await play(m, S(`¥0a¥_w[300]¥![reload,${sub}]¥__w[100]b¥e`));
    assert.equal(tl[1][0] - tl[0][0], 400, sub);
  }

  // ghost posts its change and the script goes on; makoto, descript and aigraph stay no-ops (unknownTag, once each)
  calls.length = 0;
  const res = await play(m, S('¥0c¥![reload,ghost]d¥![reload,makoto]¥![reload,descript]¥![reload,descript]¥![reload,aigraph]e¥e'));
  assert.equal(res.reason, 'end');
  assert.deepEqual(calls, ['ghost']);
  assert.equal(m.balloons.get(0).text, 'cde');
  assert.deepEqual(m.rec.host.filter(x => x[0] === 'unknownTag').map(x => x[1]),
    [S('¥![reload,makoto]'), S('¥![reload,descript]'), S('¥![reload,aigraph]')]);

  // a page left while it waited: the replay starts after the tag and never reloads again (a side effect, SS §7)
  m.player.play(S('¥0f¥![reload,shiori]g¥e'));
  await m.clock.runAll();
  const saved = m.player.runState();
  assert.equal(saved.state, 'blocked');
  const n = calls.length;
  const b = setup({ speedMs: 0 });
  b.host.reload = kind => { calls.push(kind); return new Promise(() => {}); };
  const p = b.player.replay(saved);
  await b.clock.runAll();
  assert.equal((await p).reason, 'end');
  assert.equal(calls.length, n);
  assert.equal(b.balloons.get(0).text, 'fg');

  // without host.reload every reload is an unknown tag
  const c = setup({ speedMs: 0 });
  await play(c, S('¥0x¥![reload,shiori]¥![reloadsurface]y¥e'));
  assert.equal(c.balloons.get(0).text, 'xy');
  assert.deepEqual(c.rec.host.filter(x => x[0] === 'unknownTag').map(x => x[1]), [S('¥![reload,shiori]'), S('¥![reloadsurface]')]);
});

test('setStage: later tags go to the new stage; moves and animation waits on the old one end', async () => {
  const m = setup({ speedMs: 0 });
  const next = setup().stage;
  m.player.play(S('¥0¥s[1]a¥x¥s[5]b¥e'));
  await m.clock.runAll();
  m.player.setStage(next);
  m.balloons.emit('click', { button: 0 });
  await m.clock.runAll();
  assert.deepEqual(calls(m.rec, 'c', 'setSurface').map(e => e[3]), [1], 'the old stage got only the \s before the swap');
  assert.equal(next.char(0).surfaceId, 5);

  // \i[ID,wait] on a character of the old stage: those windows are gone, the script goes on
  const o = setup({ speedMs: 0 });
  let res = null;
  o.player.play(S('¥0¥i[7,wait]x¥e')).then(r => { res = r; });
  await o.clock.advance(500);
  assert.equal(o.player.run.state, 'blocked');
  o.player.setStage(setup().stage);
  await o.clock.runAll();
  assert.equal(res && res.reason, 'end');
  assert.equal(o.balloons.get(0).text, 'x');

  // a blocking \![move] on the old stage ends at once
  const v = setup({ speedMs: 0 });
  res = null;
  v.player.play(S('¥0¥![move,100,200,1000,screen]y¥e')).then(r => { res = r; });
  await v.clock.advance(100);
  assert.equal(v.player.run.state, 'blocked');
  v.player.setStage(setup().stage);
  await v.clock.advance(20);
  assert.equal(res && res.reason, 'end');
  assert.equal(v.balloons.get(0).text, 'y');
});

test('hold / release (a shell swap, EV §2.6): nothing of the held run executes; it goes on with its waits shifted; a newer run is not held', async () => {
  const m = setup();
  const tl = timeline(m);
  let res = null;
  m.player.play(S('¥0¥s[1]ab¥_w[100]¥s[5]c¥e'), { event: 'OnTalk' }).then(r => { res = r; });
  await m.clock.advance(60);                               // 'a' at 0, 'b' at 50
  m.player.hold();
  assert.equal(m.player.busy, true, 'still talking');
  await m.clock.advance(1000);
  assert.deepEqual(tl, [[0, 'a'], [50, 'b']], 'nothing while held');
  const next = setup().stage;
  m.player.setStage(next);
  m.player.release();                                      // at 1060: held 1000 ms
  await m.clock.runAll();
  assert.deepEqual(tl, [[0, 'a'], [50, 'b'], [1200, 'c']], 'the rest of \\_w[100] after the pause');
  assert.deepEqual(calls(m.rec, 'c', 'setSurface').map(e => e[3]), [1]);
  assert.equal(next.char(0).surfaceId, 5, 'later tags on the new stage');
  assert.equal(res && res.reason, 'end');

  // a reply it waited for while held unblocks it, but nothing runs until release
  const raise = Promise.withResolvers();
  const r = setup({ speedMs: 0, raise: () => raise.promise });
  r.player.play(S('¥0d¥![raise,OnFoo]e¥e'));
  await r.clock.runAll();
  r.player.hold();
  raise.resolve(null);                                     // 204: the script goes on ...
  await r.clock.runAll();
  assert.equal(r.balloons.get(0).text, 'd', '... but not while held');
  r.player.release();
  await r.clock.runAll();
  assert.equal(r.balloons.get(0).text, 'de');

  // a newer run (OnShellChanged's reply) is not held and replaces it; release then changes nothing
  const n = setup({ speedMs: 0 });
  let old = null;
  n.player.play(S('¥0long talk¥_w[5000]never¥e')).then(x => { old = x; });
  await n.clock.advance(10);
  n.player.hold();
  let reply = null;
  n.player.play(S('¥0reply¥e')).then(x => { reply = x; });
  await n.clock.runAll();
  assert.deepEqual([old && old.reason, reply && reply.reason], ['replaced', 'end']);
  n.player.release();
  await n.clock.runAll();
  assert.equal(n.balloons.get(0).text, 'reply');

  // nothing playing: nothing to hold
  const e = setup({ speedMs: 0 });
  e.player.hold();
  e.player.release();
  await play(e, S('¥0x¥e'));
  assert.equal(e.balloons.get(0).text, 'x');
});

// EventLoop wired to the real ScriptPlayer (the recording stage / balloons of tests/sakura/mocks.mjs), in the
// runtime's order: the loop hears balloon clicks before the player. Choices answered by `\C` scripts, the
// double-click break offset and stage.scriptEnd() across the two modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLoop } from '../../src/core/events.js';
import { ScriptPlayer } from '../../src/sakura/player.js';
import { setup as playerMocks } from '../sakura/mocks.mjs';
import { FakeClock, FakeShiori, settle } from './fakes.mjs';

async function wire(handler, { props = null, files = null } = {}) {
  const m = playerMocks();
  m.player.destroy();                       // its player talks to a recording host; ours talks to the loop
  const clock = new FakeClock();            // the loop's clock; m.clock (ManualClock) drives the player
  const shiori = new FakeShiori(handler);
  const loop = new EventLoop({ shiori, stage: m.stage, balloons: m.balloons, clock, env: { win: null, doc: null }, props, files });
  const player = new ScriptPlayer({
    stage: m.stage, balloons: m.balloons, host: loop, clock: m.clock, speedMs: 50, viewport: () => ({ width: 1000, height: 800 }),
  });
  loop.setPlayer(player);
  const t = { rec: m.rec, stage: m.stage, balloons: m.balloons, pclock: m.clock, clock, shiori, loop, player, ends: 0 };
  m.stage.scriptEnd = () => { t.ends++; };
  await loop.boot({ resume: false });
  shiori.log.length = 0;
  return t;
}

/** Let the player run to its end (its own clock) and the loop handle replies and the end of the run. */
async function runOut(t) {
  for (let i = 0; i < 3; i++) { await t.pclock.runAll(); await settle(); }
}

const hideAlls = log => log.filter(e => e[0] === 'hideAll').length;

test('real player: a choice answered with \\C appends to the board (never hidden); a second click is ignored', async () => {
  const t = await wire(r => (r.id === 'OnChoiceSelect' && r.refs[0] === 'a' ? '\\C\\0\\n→ you picked A\\e' : null));
  t.loop.playScript('\\0board\\n\\q[A,a]\\q[B,b]\\*\\e', { event: 'OnKeyPress' });
  await runOut(t);
  assert.equal(t.player.choosing, true);
  assert.equal(t.loop.choicesLive, true);
  assert.equal(t.ends, 1);

  const mark = t.rec.log.length;
  t.balloons.emit('link', { kind: 'choice', id: 'a', label: 'A', refs: [], scope: 0 });
  t.balloons.emit('link', { kind: 'choice', id: 'b', label: 'B', refs: [], scope: 0 });   // while A's reply is pending
  await runOut(t);
  assert.deepEqual(t.shiori.find('OnChoiceSelectEx').map(r => r.refs), [['A', 'a']]);
  assert.deepEqual(t.shiori.find('OnChoiceSelect').map(r => r.refs), [['a']]);
  assert.equal(hideAlls(t.rec.log.slice(mark)), 0, 'no balloon was hidden');
  const view = t.balloons.get(0);
  assert.equal(view.visible, true);
  assert.match(view.text, /^board\n/, 'the board is still there');
  assert.match(view.text, /you picked A$/);
  assert.equal(t.ends, 2, 'one scriptEnd per finished run');

  // a choice of the appended board that nobody answers closes the balloons
  t.clock.t += 1000;
  t.balloons.emit('link', { kind: 'choice', id: 'b', label: 'B', refs: [], scope: 0 });
  await runOut(t);
  assert.deepEqual(t.shiori.find('OnChoiceSelect').map(r => r.refs), [['a'], ['b']]);
  assert.equal(hideAlls(t.rec.log.slice(mark)), 1);
  assert.equal(view.visible, false);
  assert.equal(t.loop.cantalk, true);
  assert.equal(t.ends, 2);
});

test('real player: a double-click break sends the source offset of the next character (OnBalloonBreak R2)', async () => {
  const t = await wire(() => null);
  const script = '\\0\\s[5]abcdefghij\\e';
  t.loop.playScript(script, { event: 'OnTalk' });
  await t.pclock.advance(120);
  assert.equal(t.player.busy, true);
  const before = t.player.position;
  t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  const written = t.balloons.get(0).text;
  assert.ok(written.length > 0 && written.length < 10, JSON.stringify(written));
  const brk = t.shiori.find('OnBalloonBreak');
  assert.equal(brk.length, 1);
  assert.deepEqual(brk[0].refs, [script, 0, '\\0\\s[5]'.length + written.length]);
  assert.equal(brk[0].refs[2], before);
  assert.equal(t.player.position, before, 'the offset stays valid after interrupt()');
  assert.equal(t.player.busy, false);
  await runOut(t);
  assert.equal(t.ends, 0, 'a broken script never reached \\e');
});

// ---------------------------------------------------------------- the property system (properties.md §2–§4)

test('real player: \\![get,property] reads its names at the tag and waits for its event; the \\![embed] after it is asked only then, its reply expanded, then OnTranslate', async () => {
  const month = String(new Date(new FakeClock().now()).getMonth() + 1);
  let translate = () => null;
  const t = await wire(r => (r.id === 'OnX' ? '<%month>' : r.id === 'OnTranslate' ? translate(r) : null));
  t.loop.playScript('\\0\\s[3]\\![get,property,OnE,currentghost.scope(0).surface.num,currentghost.scope(5).name]\\![embed,OnX,a,b]tail\\e');
  await runOut(t);
  assert.deepEqual(t.shiori.ids(), ['GET OnE', 'GET OnX', 'GET OnTranslate']);
  const e = t.shiori.find('OnE')[0];
  assert.deepEqual(e.refs, ['3', ''], 'the surface at the tag; a scope the ghost lacks fails ("")');
  assert.equal(e.headers.SenderType, 'internal,property');
  // EmbedSendEventFunc: TranslateParam, then TranslateScript on the reply [disasm 0x633349, 0x633389]
  const tr = t.shiori.find('OnTranslate')[0];
  assert.deepEqual(tr.refs, [`<${month}>`, '', 'OnX', 'a\x01b'], 'R0 the expanded reply, R1 "", R2 the event, R3 its refs');
  assert.equal(tr.headers.SenderType, 'internal,embed');
  assert.equal(t.balloons.get(0).text, `<${month}>tail`, 'OnTranslate 204: the expanded reply');
  assert.equal(t.ends, 1);
  // a reply OnTranslate changed (emily4 prefixes hers) is spliced as returned: no second expansion
  translate = r => (r.refs[2] === 'OnX' ? `(${r.refs[0]} %month)` : null);
  t.loop.playScript('\\0\\![embed,OnX]tail\\e');
  await runOut(t);
  assert.equal(t.balloons.get(0).text, `(<${month}> %month)tail`);
});

test('real player: a reply to \\![get,property] replaces the run (expanded, after OnTranslate); \\![get,property,E] alone sends nothing', async () => {
  const t = await wire(r => (r.id === 'OnE' ? '\\0reply %property[system.os.type]\\e' : null));
  t.loop.playScript('\\0before\\![get,property,OnNothing]\\![get,property,OnE,system.year]after\\e');
  await runOut(t);
  assert.deepEqual(t.shiori.ids(), ['GET OnE', 'GET OnTranslate']);
  assert.equal(t.shiori.find('OnTranslate')[0].refs[0], '\\0reply Web\\e');
  assert.equal(t.loop.current.script, '\\0reply Web\\e');
  assert.equal(t.balloons.get(0).text, 'reply Web', 'the old run stopped at the tag');
});

test('real player: %property is read when the script starts (before \\s), removed when it fails; \\![set,property] sets a surface and a balloon', async () => {
  const t = await wire(r => (r.id === 'OnTalk' ? '\\0\\s[5]%property[currentghost.scope(0).surface.num]/%property[no.such]\\e' : null));
  t.stage.char(0).setSurface(2);
  await t.loop.send('OnTalk');
  assert.equal(t.shiori.find('OnTranslate')[0].refs[0], '\\0\\s[5]2/\\e', 'OnTranslate sees the expanded script');
  await runOut(t);
  assert.equal(t.balloons.get(0).text, '2/');
  assert.equal(t.stage.char(0).surfaceId, 5);
  t.loop.playScript('\\0\\![set,property,currentghost.scope(0).surface.num,7]\\![set,property,currentghost.balloon.scope(0).num,2]'
    + '\\![set,property,currentghost.scope(0).surface.num]x\\e');
  await runOut(t);
  assert.equal(t.stage.char(0).surfaceId, 7, 'a set without a value does nothing');
  assert.equal(t.balloons.get(0).kind, 2);
});

test('real player: \\![open,con…,page] hands the page to the Site (props.openSettings); \\![open,co] is another command', async () => {
  const pages = [];
  const t = await wire(() => null, { props: { openSettings: p => { pages.push(p); return p !== 'biff'; } } });
  t.loop.playScript('\\0\\![open,configurationdialog,setup]\\![open,CONFIG]\\![open,con,biff]\\![open,co]x\\e');
  await runOut(t);
  assert.deepEqual(pages, ['setup', '', 'biff']);
  assert.equal(t.balloons.get(0).text, 'x', 'the script goes on (a modeless box)');
  // without a Site (no openSettings) nothing opens
  const alone = await wire(() => null);
  assert.equal(alone.loop.openWindow('configurationdialog', ['setup']), false);
});

test('real player: \\![set,trayicon,…] and \\![set,tasktrayicon,…] reach the loop\'s tray icon (UI §2.6)', async () => {
  const paths = ['ghost/master/img/x.ico', 'ghost/master/b.ico'];
  const files = { resolve: p => paths.find(x => x.toLowerCase() === String(p).toLowerCase()) || null };
  const t = await wire(() => null, { files });
  t.loop.playScript('\\0a\\![set,trayicon,img\\x.ico,"a tip",--duration=100]b\\e', { event: 'OnTest' });
  await runOut(t);
  assert.equal(t.loop.trayIcon, 'ghost/master/img/x.ico');
  assert.match(t.balloons.get(0).text, /ab$/, 'the script goes on');
  t.loop.playScript('\\0\\![set,TaskTrayIcon,b.ico]\\e', { event: 'OnTest' });
  await runOut(t);
  assert.equal(t.loop.trayIcon, 'ghost/master/b.ico');
  t.loop.playScript('\\0\\![set,trayicon]\\e', { event: 'OnTest' });
  await runOut(t);
  assert.equal(t.loop.trayIcon, null, 'no path: back to the descript\'s icon');
});

test('real player: Status choosing while a \\q / \\__q item is up (also playing and in the pick\'s own request), nouserbreak until the next script, one mode slot (EV §1.6)', async () => {
  const t = await wire(() => null);
  // AddStatusText [disasm 0x639ad8–0x639b09]: the balloons' choice items, not the run state
  t.loop.playScript('\\0menu\\q[A,a]\\w9\\w9\\w9\\w9\\e', { event: 'OnTest' });
  await t.pclock.advance(300);
  await settle();
  assert.equal(t.player.busy, true);
  assert.equal(t.loop.statusHeader(), 'talking,choosing');
  await runOut(t);
  assert.equal(t.loop.statusHeader(), 'choosing');
  t.clock.t += 1000;
  t.balloons.emit('link', { kind: 'choice', id: 'a', label: 'A', refs: [], scope: 0 });
  await runOut(t);
  const pick = t.shiori.find('OnChoiceSelect');
  assert.equal(pick.length, 1);
  assert.match(pick[0].headers.Status || '', /(^|,)choosing(,|$)/, 'the balloon is still up when the pick is sent [infer ChoiceSelect 0x470df4]');
  assert.doesNotMatch(t.loop.statusHeader(), /choosing/, 'no reply: the balloons closed');
  // a \__q range counts, a \_a anchor does not (AddAnchorOrSelectable 0x5ce02c–0x5ce044)
  t.loop.playScript('\\0\\__q[b]range\\__q\\e', { event: 'OnTest' });
  await runOut(t);
  assert.equal(t.loop.statusHeader(), 'choosing');
  t.loop.playScript('\\0\\_a[x]anchor\\_a\\e', { event: 'OnTest' });
  await runOut(t);
  assert.doesNotMatch(t.loop.statusHeader(), /choosing/);
  // SPGhost+0x41ac: kept after \e, cleared when the next script starts [disasm 0x62f44e, Loop 0x63b540]
  t.loop.playScript('\\0\\![enter,nouserbreakmode]hi\\e', { event: 'OnTest' });
  await runOut(t);
  assert.match(t.loop.statusHeader(), /(^|,)nouserbreak(,|$)/);
  t.loop.playScript('\\0b\\e', { event: 'OnTest' });
  await runOut(t);
  assert.doesNotMatch(t.loop.statusHeader(), /nouserbreak/);
  // SPGhost+0x41a8 [disasm 0x62f43a, 0x62f484]: the last mode entered wins
  t.loop.playScript('\\![enter,passivemode]\\![enter,inductionmode]\\e', { event: 'OnTest' });
  await runOut(t);
  assert.deepEqual([t.loop.ghostLife.passive, t.loop.ghostLife.induction], [false, true]);
  assert.equal(t.loop.statusHeader(), 'induction');
});

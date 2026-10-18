// EventLoop side of OnOtherGhostTalk (shiori-events.md §2.7, sakurascript.md §5.7): \![set,otherghosttalk] into
// ghostLife, the 'talk' events before and after each run (not for replays; OnOtherGhostTalk's own replies only after),
// and two loops wired by a stand-in for the site's forwarding (src/core/site.js does it in the runtime).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { otherTalkRefs } from '../../src/core/ghostset.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, settle } from './fakes.mjs';

const TSUBASA = { id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };
const RUUSA = { id: 'ruusa', name: 'るーさ', sakuraName: 'るーさ', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };

/** One ghost's loop on fakes; `storage` shared between page loads. */
function make(ghost, { handler = () => null, storage = memoryStorage() } = {}) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const player = new FakePlayer();
  const state = new StateStore(ghost.id, { storage, clock });
  const balloons = new FakeBalloons();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons, ghost, state, clock, env: { win: null, doc: null },
    ghostDescript: new Map([['name', ghost.name], ['sakura.name', ghost.sakuraName]]), sessionEpochMs: clock.now(),
  });
  return { clock, shiori, player, balloons, state, storage, loop };
}

async function booted(ghost, o) {
  const t = make(ghost, o);
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  return t;
}

test('\\![set,otherghosttalk]: true = after, before and after add up (one argument may name both), false clears both', async () => {
  const t = await booted(RUUSA);
  assert.deepEqual(t.loop.otherGhostTalk, { before: false, after: false });
  const set = args => { t.loop.setOption('otherghosttalk', args); return t.loop.otherGhostTalk; };
  assert.deepEqual(set(['true']), { before: false, after: true });
  assert.deepEqual(set(['false']), { before: false, after: false });
  assert.deepEqual(set(['before']), { before: true, after: false });
  assert.deepEqual(set(['after']), { before: true, after: true }, 'before stays');
  assert.deepEqual(set(['FALSE']), { before: false, after: false });
  assert.deepEqual(set(['before,after']), { before: true, after: true });
  assert.deepEqual(set(['false']), { before: false, after: false });
  assert.deepEqual(set(['before', 'after']), { before: true, after: true }, 'as two arguments');
  setLogLevel('silent');
  assert.deepEqual(set(['nonsense']), { before: true, after: true }, 'an unknown value changes nothing');
  setLogLevel('warn');
  assert.equal(t.loop.ghostLife.otherGhostTalk, 'before,after');
  t.loop.destroy();
});

test('otherghosttalk lives in ghostLife: a page change keeps it, a cold boot (the ghost started again) drops it', async () => {
  const storage = memoryStorage();
  const t = await booted(RUUSA, { storage });
  t.loop.setOption('otherghosttalk', ['after']);
  t.state.saveNow();
  assert.equal(JSON.parse(storage.getItem('sumika:ghost:ruusa:state')).ghostLife.otherGhostTalk, 'after');
  t.loop.destroy();

  const next = make(RUUSA, { storage });
  await next.loop.boot({ resume: true });
  assert.deepEqual(next.loop.otherGhostTalk, { before: false, after: true });
  next.loop.destroy();

  const cold = make(RUUSA, { storage });
  await cold.loop.boot({ resume: false });
  assert.deepEqual(cold.loop.otherGhostTalk, { before: false, after: false });
  cold.state.saveNow();
  assert.deepEqual(JSON.parse(storage.getItem('sumika:ghost:ruusa:state')).ghostLife, { passive: false, induction: false });
  cold.loop.destroy();
});

test("'talk' before each run plays and after it ends; break when it did not reach its end", async () => {
  const t = await booted(TSUBASA, { handler: r => (r.id === 'OnMouseDoubleClick' ? '\\0Hm?\\e' : null) });
  const seen = [];
  t.loop.on('talk', e => seen.push({ ...e, plays: t.player.plays.length }));
  t.loop.playScript('\\0Hello\\e', { event: 'OnTalk', refs: ['a', 'b'] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, 'before');
  assert.equal(seen[0].flags, '');
  assert.equal(seen[0].plays, 0, 'before the player starts it');
  assert.deepEqual([seen[0].run.event, seen[0].run.script, seen[0].run.refs], ['OnTalk', '\\0Hello\\e', ['a', 'b']]);
  t.player.finish();
  await settle();
  assert.deepEqual(seen.slice(1).map(e => [e.phase, e.flags, e.run.event]), [['after', '', 'OnTalk']]);

  // replaced by a click's reply: the old run is reported broken [guess], the new one before and after
  seen.length = 0;
  t.loop.playScript('\\0Long talk\\e', { event: 'OnTalk' });
  await t.loop.send('OnMouseDoubleClick', [0, 0, 0, 0, '', 0, 'mouse']);
  await settle();
  assert.deepEqual(seen.map(e => [e.phase, e.flags, e.run.event]), [
    ['before', '', 'OnTalk'], ['before', '', 'OnMouseDoubleClick'], ['after', 'break', 'OnTalk'],
  ]);
  // a balloon break
  seen.length = 0;
  t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  assert.deepEqual(seen.map(e => [e.phase, e.flags, e.run.event]), [['after', 'break', 'OnMouseDoubleClick']]);
  // \- reaches the end of its script: not a break
  seen.length = 0;
  t.loop.playScript('\\0Bye\\-', { event: 'OnClose' });
  t.player.busy = false;
  t.player.cur.resolve({ reason: 'quit', hasChoices: false });
  await settle();
  assert.deepEqual(seen.map(e => [e.phase, e.flags]), [['before', ''], ['after', '']]);
});

test("no 'talk' for a replay after a page change; a reply to OnOtherGhostTalk only after it (the loop guard)", async () => {
  const storage = memoryStorage();
  const t = await booted(RUUSA, { storage, handler: r => (r.id === 'OnOtherGhostTalk' ? '\\0Who said that?\\e' : null) });
  const seen = [];
  t.loop.on('talk', e => seen.push(e));
  assert.deepEqual(await t.loop.otherEvent('OnOtherGhostTalk', ['Hayama-san Next Door', 'Tsubasa', '', 'OnTalk', '\\0Hi\\e', '']),
    { played: true });
  assert.equal(t.player.last.script, '\\0Who said that?\\e');
  assert.equal(t.shiori.find('OnOtherGhostTalk')[0].headers.SenderType, 'internal');
  t.player.finish();
  await settle();
  // SSP skips only the "before" broadcast for it; "after" goes out as for any run [disasm 0x6397A2, 0x63992F]
  assert.deepEqual(seen.map(e => [e.phase, e.flags, e.run.event]), [['after', '', 'OnOtherGhostTalk']]);

  t.loop.playScript('\\0Still talking\\e', { event: 'OnTalk' });
  t.state.saveNow();
  t.loop.destroy();
  const next = make(RUUSA, { storage });
  const again = [];
  next.loop.on('talk', e => again.push(e));
  await next.loop.boot({ resume: true });
  assert.equal(next.player.replays.length, 1);
  next.player.finish();
  await settle();
  assert.deepEqual(again, []);
  next.loop.destroy();
});

test('two loops and a stand-in for the site: the listener hears the talker before / after, never itself, and only while live', async () => {
  const ruusa = await booted(RUUSA, { handler: r => (r.id === 'OnOtherGhostTalk' ? `\\0(${r.refs[2] || 'ok'})\\e` : null) });
  const tsubasa = await booted(TSUBASA);
  const slots = [tsubasa, ruusa];
  // what site.js does with a loop's 'talk': every other slot that asked for that phase gets GET OnOtherGhostTalk
  for (const s of slots) {
    s.loop.on('talk', ({ phase, run, flags }) => {
      for (const o of slots) {
        if (o === s || !o.loop.otherGhostTalk[phase]) continue;
        o.loop.otherEvent('OnOtherGhostTalk', otherTalkRefs(s.loop.peerInfo(), run, flags));
      }
    });
  }
  ruusa.loop.setOption('otherghosttalk', ['true']);
  tsubasa.loop.playScript('\\0Good evening\\e', { event: 'OnTalk', refs: ['x', 'y'] });
  await settle();
  assert.equal(ruusa.shiori.find('OnOtherGhostTalk').length, 0, 'after only: nothing before');
  tsubasa.player.finish();
  await settle();
  const req = ruusa.shiori.find('OnOtherGhostTalk');
  assert.deepEqual(req.map(r => r.refs), [['Hayama-san Next Door', 'Tsubasa', '', 'OnTalk', '\\0Good evening\\e', 'x\x01y']]);
  assert.equal(ruusa.player.last.script, '\\0(ok)\\e', 'the listener plays its reply');
  assert.equal(tsubasa.shiori.find('OnOtherGhostTalk').length, 0, 'the talker never hears its own talk or the reply');

  // before, and a broken run
  ruusa.loop.setOption('otherghosttalk', ['before']);
  ruusa.player.finish();
  await settle();
  ruusa.shiori.log.length = 0;
  tsubasa.loop.playScript('\\0Look\\e', { event: 'OnMouseDoubleClick' });
  await settle();
  tsubasa.player.interrupt();
  await settle();
  assert.deepEqual(ruusa.shiori.find('OnOtherGhostTalk').map(r => [r.refs[2], r.refs[4]]), [['', '\\0Look\\e'], ['break', '\\0Look\\e']]);

  // a listener that is not live (minimized) hears nothing
  ruusa.shiori.log.length = 0;
  ruusa.loop.minimized = { reason: 'user', scopes: [0] };
  tsubasa.loop.playScript('\\0Again\\e');
  tsubasa.player.finish();
  await settle();
  assert.deepEqual(ruusa.shiori.find('OnOtherGhostTalk'), []);
  for (const s of slots) s.loop.destroy();
});

test('resumeClose (a Quit gone on from the last page): the replayed goodbye closes the ghost at its end, \\- or not; nothing playing: at once', async () => {
  const storage = memoryStorage();
  const t = await booted(RUUSA, { storage });
  t.loop.playScript('\\0Good night.\\e', { event: 'OnClose' });
  t.state.saveNow();                                      // the page goes during the goodbye
  t.loop.destroy();

  const next = make(RUUSA, { storage });
  assert.equal(next.loop.resumeClose(), undefined, 'nothing before boot');
  assert.equal(next.loop.closing, false);
  await next.loop.boot({ resume: true });
  assert.equal(next.player.replays.length, 1);
  let closed = null;
  next.loop.on('closed', e => { closed = e; });
  next.loop.resumeClose();
  assert.equal(next.loop.closing, 'all');
  await settle();
  assert.equal(closed, null, 'not before its goodbye ends');
  next.player.finish();                                   // the goodbye ends without \-
  await settle();
  assert.ok(next.loop.closed && closed, 'closed at its end');
  assert.deepEqual(next.shiori.ids().filter(i => /OnDestroy/.test(i)), ['NOTIFY OnDestroy']);
  assert.equal(JSON.parse(storage.getItem('sumika:ghost:ruusa:state')).closed, true);
  next.loop.resumeClose();
  await settle();
  assert.deepEqual(next.shiori.ids().filter(i => /OnDestroy/.test(i)), ['NOTIFY OnDestroy'], 'once');

  const idle = await booted(TSUBASA);                     // nothing replayed: it closes at once
  await idle.loop.resumeClose();
  assert.ok(idle.loop.closed && idle.shiori.unloaded);
  next.loop.destroy();
  idle.loop.destroy();
});

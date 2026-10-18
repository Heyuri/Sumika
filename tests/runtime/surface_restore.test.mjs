// OnSurfaceRestore as ssp.exe 2.9.9.3000 sends it (EV §3.4) [disasm SPGhost::DecodeProc 0x628d92, CSakuraWnd::TimerExec
// 0x498244–0x498310, SPGhost::OnSurfaceRestore 0x6426c0]: a stamp at every run's end (a broken run's only when it had
// shown something; never the restore's own reply), checked on the 1-second tick after the time events, sent more than
// Timeout.Balloon + 15 s (30 s) after the stamp at a tick whose local second is 10–50, held (never dropped) while the
// ghost cannot take it. A reported case: Nato's first boot broken at its \x left her \0 hidden for minutes; on the
// real Satori build with her own dictionaries she now comes back 30–51 s after the break.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { ScriptPlayer } from '../../src/sakura/player.js';
import { SatoriEngine } from '../../src/worker/engines/satori.js';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { buildRequest, parseResponse } from '../../src/core/shiori.js';
import { setup as playerMocks } from '../sakura/mocks.mjs';
import { loadEngineFactory } from '../load_engine.mjs';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';
import { needs } from '../needs.mjs';

const GHOST = { id: 'testghost', name: 'Test', sakuraName: 'Testko', keroName: '', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };
/** Local time on the test day (the clock-second window is local, as SSP's GetLocalTime). */
const at = (h, m, s, ms = 0) => new Date(2026, 9, 6, h, m, s, ms).getTime();
const T0 = at(21, 13, 20);

function setup({ handler = () => null, start = T0, doc = null, state = null, storage = null } = {}) {
  const clock = new FakeClock(start);
  const shiori = new FakeShiori(handler);
  const player = new FakePlayer();
  const stage = new FakeStage();
  const balloons = new FakeBalloons();
  const dialogs = new FakeDialogs();
  const st = state || new StateStore('testghost', { storage: storage || memoryStorage(), clock });
  const loop = new EventLoop({
    shiori, player, stage, balloons, dialogs, ghost: GHOST, state: st, menu: { open() {} }, clock,
    env: { win: null, doc }, ghostDescript: new Map([['name', 'Test']]), site: { ghosts: [GHOST], balloons: [] },
    sessionEpochMs: clock.now(),
  });
  return { clock, shiori, player, stage, balloons, dialogs, state: st, loop };
}

async function booted(o = {}) {
  const t = setup(o);
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  return t;
}

/** Move the loop's clock to an absolute time. */
const until = (t, time) => t.clock.advance(time - t.clock.now());
const restores = t => t.shiori.find('OnSurfaceRestore');
/** Play a script that ends at once (the stamp is now). */
async function talk(t, script = '\\0\\s[5]hello\\e', o = {}) {
  t.loop.playScript(script, { event: 'OnTalk' });
  if (o.balloonTimeout !== undefined) t.loop.setOption('balloontimeout', [o.balloonTimeout]);
  t.player.finish(o.result || {});
  await settle();
}

test('a script that ends: OnSurfaceRestore at the first tick more than 30 s later whose local second is 10–50', async () => {
  // ended at :20 -> the tick at :50.005 (second 50 is in the window)
  let t = await booted();
  await talk(t);
  await until(t, at(21, 13, 50));
  assert.equal(restores(t).length, 0, 'not at 30.000 s: SSP wants more than 30 s');
  await until(t, at(21, 13, 50, 100));
  const r = restores(t);
  assert.equal(r.length, 1);
  assert.equal(r[0].method, 'GET');
  assert.deepEqual(r[0].refs, [0, 10], 'R0 the \\0 surface, R1 the \\1 surface');
  assert.equal(r[0].headers.SenderType, undefined, 'the client\'s SenderType internal applies');

  // ended at :25 -> due after :55, but :51–:09 are outside the window: the tick at 21:14:10.005
  t = await booted({ start: at(21, 13, 25) });
  await talk(t);
  await until(t, at(21, 14, 10));
  assert.equal(restores(t).length, 0);
  await until(t, at(21, 14, 10, 100));
  assert.equal(restores(t).length, 1);
  // once: nothing more, however long the ghost stays quiet (a 204 is not retried)
  await t.clock.advance(300000);
  assert.equal(restores(t).length, 1);

  // a reply plays as a surface restore, and its own end never stamps again (SSP's play flag 0x8000)
  t = await booted({ handler: r => (r.id === 'OnSurfaceRestore' ? '\\0\\s[0]\\1\\s[10]\\e' : null) });
  await talk(t);
  await until(t, at(21, 13, 50, 100));
  assert.equal(restores(t).length, 1);
  assert.equal(t.player.last.script, '\\0\\s[0]\\1\\s[10]\\e');
  assert.equal(t.player.last.meta.event, 'OnSurfaceRestore');
  t.player.finish();
  await t.clock.advance(300000);
  assert.equal(restores(t).length, 1);
});

test('a balloon break arms it when the run had shown something; a run broken before showing anything keeps the old stamp', async () => {
  let t = await booted();
  t.loop.playScript('\\0\\s[-1]a long talk...', { event: 'OnTalk' });
  t.clock.t = at(21, 13, 21);
  t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  assert.equal(t.shiori.find('OnBalloonBreak').length, 1);
  await until(t, at(21, 13, 51, 100));
  assert.equal(restores(t).length, 0, 'due after :51, outside the window');
  await until(t, at(21, 14, 10, 100));
  assert.equal(restores(t).length, 1, '49 s after the break');

  // ended at :20; at :30 a new talk is broken before it showed anything: the stamp of :20 stays (due at :50.005)
  t = await booted();
  await talk(t);
  await until(t, at(21, 13, 30));
  t.loop.playScript('\\0\\w9\\w9late', { event: 'OnTalk' });
  t.player.shown = false;
  t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  assert.equal(t.shiori.find('OnBalloonBreak').length, 1);
  await until(t, at(21, 13, 50, 100));
  assert.equal(restores(t).length, 1, 'the old due time, not 30 s after the break');
});

test('closing an idle balloon (OnBalloonClose) leaves it pending; \\- (the ghost exits) ends it', async () => {
  let t = await booted();
  await talk(t);
  await until(t, at(21, 13, 25));
  t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  assert.equal(t.shiori.find('OnBalloonClose').length, 1);
  await until(t, at(21, 13, 50, 100));
  assert.equal(restores(t).length, 1);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 0, 'the closed balloon has no timeout left');

  t = await booted();
  await talk(t);
  assert.equal(t.state.data.surfaceRestoreAt, 0, 'not saved yet');
  t.state.saveNow();
  assert.equal(t.state.data.surfaceRestoreAt, T0, 'pending');
  t.loop.playScript('\\0bye\\-', { event: 'OnClose' });
  t.player.busy = false;
  t.player.cur.resolve({ reason: 'quit', hasChoices: false, shown: true });
  await settle();
  assert.equal(t.loop.closed, true);
  await t.clock.advance(120000);
  assert.equal(restores(t).length, 0);
  assert.equal(t.state.data.surfaceRestoreAt, 0);
});

test('choices: held while the menu is up, then sent at the next tick in the window once it is gone', async () => {
  // OnChoiceTimeout (204) at 30 s closes the menu; the stamp of its script is then overdue: right after it
  let t = await booted();
  await talk(t, '\\0menu\\q[a,b]\\e', { result: { hasChoices: true } });
  await until(t, at(21, 13, 49, 900));
  assert.equal(restores(t).length, 0);
  await until(t, at(21, 13, 50, 100));
  const ids = t.shiori.ids();
  assert.ok(ids.indexOf('GET OnChoiceTimeout') >= 0 && ids.indexOf('GET OnChoiceTimeout') < ids.indexOf('GET OnSurfaceRestore'), ids.join(' '));

  // a menu with \* stays up: held for minutes; a pick whose reply is 204 closes it -> the next tick in the window
  t = await booted();
  await talk(t, '\\0menu\\q[a,b]\\*\\e', { result: { hasChoices: true, noChoiceTimeout: true } });
  await until(t, at(21, 15, 0));
  assert.equal(restores(t).length, 0, 'held while choosing');
  t.balloons.emit('link', { kind: 'choice', id: 'b', label: 'a', refs: [], scope: 0 });
  await settle();
  assert.equal(t.shiori.find('OnChoiceSelect').length, 1);
  await until(t, at(21, 15, 9, 900));
  assert.equal(restores(t).length, 0, ':00–:09 is outside the window');
  await until(t, at(21, 15, 10, 100));
  assert.equal(restores(t).length, 1);
});

test('the balloon, an open box or a hidden tab do not delay it: it can come before OnBalloonTimeout', async () => {
  // the pointer keeps the balloon up (its timeout pauses); the restore does not wait for it [infer: TimerExec never
  // looks at balloons]
  let t = await booted();
  await talk(t);
  t.balloons.hovered = true;
  await until(t, at(21, 13, 50, 100));
  assert.equal(restores(t).length, 1);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 0, 'the balloon is still up');

  // an open input box holds neither (no part of cantalk, C6; no timeout code reads a box [disasm]);
  // a hidden tab holds the balloon timeout [decision], not the restore
  t = await booted();
  await talk(t);
  t.loop.openBox('inputbox', ['name']);
  assert.equal(t.loop.cantalk, true);
  await until(t, at(21, 13, 50, 100));
  assert.equal(restores(t).length, 1);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 1, 'the box does not hold the balloon timeout');
  t = await booted({ doc: { hidden: true } });
  await talk(t);
  await until(t, at(21, 13, 50, 100));
  assert.equal(restores(t).length, 1);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 0, 'a hidden tab holds it');
});

test('held, never dropped: minimized, passive mode, a shell swap; sent at the first tick in the window after', async () => {
  // minimized at :25, shown again at 21:14:20 -> the tick at 21:14:20.005
  let t = await booted();
  await talk(t);
  await until(t, at(21, 13, 25));
  await t.loop.minimize('user');
  assert.ok(t.loop.minimized);
  await until(t, at(21, 14, 20));
  assert.equal(restores(t).length, 0);
  await t.loop.restore();
  await until(t, at(21, 14, 20, 100));
  assert.equal(restores(t).length, 1);

  // passive mode from :25 to 21:14:30
  t = await booted();
  await talk(t);
  await until(t, at(21, 13, 25));
  t.loop.setOption('enter', ['passivemode']);
  await until(t, at(21, 14, 30));
  assert.equal(restores(t).length, 0);
  t.loop.setOption('leave', ['passivemode']);
  await until(t, at(21, 14, 30, 100));
  assert.equal(restores(t).length, 1);

  // a shell swap from :45 to 21:14:40 (a failed one: the old stage comes back and ends it)
  t = await booted();
  await talk(t);
  await until(t, at(21, 13, 45));
  t.loop.detachStage();
  await until(t, at(21, 14, 40));
  assert.equal(restores(t).length, 0);
  t.loop.attachStage(t.stage);
  await until(t, at(21, 14, 40, 100));
  assert.equal(restores(t).length, 1);
});

test('a newer script holds it while it plays and stamps anew at its end; so does a time event\'s reply, which ends its tick', async () => {
  let t = await booted();
  await talk(t);
  await until(t, at(21, 13, 40));
  t.loop.playScript('\\0a long one', { event: 'OnTalk' });
  await until(t, at(21, 14, 0));
  assert.equal(restores(t).length, 0, 'held while talking');
  t.player.finish();
  await settle();
  await until(t, at(21, 14, 30));
  assert.equal(restores(t).length, 0, 'the stamp moved to 21:14:00');
  await until(t, at(21, 14, 30, 100));
  assert.equal(restores(t).length, 1);

  // OnSecondChange answers with a talk on the tick that was due: no restore on that tick [disasm TimerExec 0x49803f]
  let armed = false;
  t = await booted({
    handler: r => {
      if (r.id !== 'OnSecondChange' || r.method !== 'GET' || !armed) return null;
      armed = false;
      return '\\0tick talk\\e';
    },
  });
  await talk(t);
  await until(t, at(21, 13, 49, 900));
  armed = true;           // the tick at :50.005 talks
  await until(t, at(21, 13, 50, 100));
  assert.equal(t.player.last.script, '\\0tick talk\\e');
  assert.equal(restores(t).length, 0, 'the tick ended with its time event\'s talk');
  t.player.finish();      // ends at :50.100: due after 21:14:20.100
  await settle();
  await until(t, at(21, 14, 20, 100));
  assert.equal(restores(t).length, 0);
  await until(t, at(21, 14, 21, 100));
  assert.equal(restores(t).length, 1);

  // a reply without waits ends inside play() (ScriptPlayer runs `\0\s[5]\e` to its end at once), so nothing talks any
  // more when the tick would check: the tick still ends there, and the old stamp is not used
  armed = false;
  t = await booted({
    handler: r => {
      if (r.id !== 'OnSecondChange' || r.method !== 'GET' || !armed) return null;
      armed = false;
      return '\\0\\s[5]\\e';
    },
  });
  await talk(t);
  await until(t, at(21, 13, 49, 900));
  armed = true;
  t.player.instant = true;
  await until(t, at(21, 13, 50, 100));
  assert.equal(t.player.last.script, '\\0\\s[5]\\e');
  assert.equal(t.player.busy, false, 'it ended at once');
  assert.equal(restores(t).length, 0, 'the tick ended with its time event\'s talk, though that talk is over');
  await until(t, at(21, 14, 20, 100));
  assert.equal(restores(t).length, 0, 'its end at :50.005 stamped anew');
  await until(t, at(21, 14, 21, 100));
  assert.equal(restores(t).length, 1);
});

test('\\![set,balloontimeout,0] holds it until the next script (without \\C) starts; a broken one that showed nothing keeps the old stamp', async () => {
  const t = await booted();
  await talk(t, '\\0stay\\e', { balloonTimeout: '0' });
  await until(t, at(21, 16, 0));
  assert.equal(restores(t).length, 0);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 0);
  // at 21:16:20 a script starts (its own options are the defaults) and is broken before it showed anything
  await until(t, at(21, 16, 20));
  t.loop.playScript('\\0\\w9\\w9x', { event: 'OnTalk' });
  t.player.shown = false;
  t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  await until(t, at(21, 16, 20, 100));
  assert.equal(restores(t).length, 1, 'the stamp of 21:13:20 is long overdue');
});

test('a script that starts with \\C keeps the last script\'s \\![set,balloontimeout,0]; one without \\C ends the hold', async () => {
  // SSP resets the per-script balloon and choice timeouts only for a script without play flag 0x20, and a leading \C
  // sets it [disasm PlayScriptInternal 0x63c883–0x63c8a2, DecodeProcReal 0x628f3b / 0x628fdc]
  let t = await booted();
  await talk(t, '\\0stay\\e', { balloonTimeout: '0' });
  await until(t, at(21, 14, 0));
  await talk(t, '\\C\\n more\\e');                     // an anchor's or a click's reply that appends to the balloon
  await until(t, at(21, 16, 0));
  assert.equal(restores(t).length, 0, 'still held after the \\C script ended at 21:14:00');
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 0, 'and the balloon still has no timeout');
  await talk(t, '\\0next\\e');                         // ends at 21:16:00 with the default options
  await until(t, at(21, 16, 30, 100));
  assert.equal(restores(t).length, 1, 'due again 30 s after the script without \\C');
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 1);

  // SSP tests only the script's first two characters: \C behind leading tags (SUM §2.2's lenient append) resets them
  t = await booted();
  await talk(t, '\\0stay\\e', { balloonTimeout: '0' });
  await until(t, at(21, 14, 0));
  await talk(t, '\\1\\s[10]\\C\\n more\\e');
  await until(t, at(21, 14, 30, 100));
  assert.equal(restores(t).length, 1);
});

test('R0 / R1: -1 for a scope that is not shown (\\s[-1] or hidden) or has no window', async () => {
  const t = await booted();
  await talk(t);
  t.stage.char(0).hide();
  await until(t, at(21, 13, 50, 100));
  assert.deepEqual(restores(t)[0].refs, [-1, 10]);

  const u = await booted();
  await talk(u);
  u.stage.char(1).setSurface(-1);
  u.stage.has = s => s !== 0;                // a stage without scope 0's window
  await until(u, at(21, 13, 50, 100));
  assert.deepEqual(restores(u)[0].refs, [-1, -1]);
});

test('a page change keeps a pending restore (its stamp is in the ghost state); a cold boot starts with none', async () => {
  const storage = memoryStorage();
  const a = await booted({ storage });
  await talk(a);
  a.state.saveNow();
  assert.equal(a.state.data.surfaceRestoreAt, T0);
  a.loop.destroy();

  // the next page, 10 s later: resumed, the restore comes at its old due time (its replayed run, already ended with
  // its balloon still up, does not stamp again: that would move it to 21:14:10)
  const b = setup({ start: at(21, 13, 30), storage });
  assert.equal(b.state.data.surfaceRestoreAt, T0);
  await b.loop.boot({ resume: true });
  assert.equal(b.player.replays.length, 1);
  b.player.finish();
  await settle();
  await until(b, at(21, 13, 50, 100));
  assert.equal(restores(b).length, 1);
  b.loop.destroy();

  // a cold boot (a new tab): nothing pending until its boot script ends
  const c = setup({ start: at(21, 13, 30), storage });
  c.state.data.surfaceRestoreAt = T0;
  await c.loop.boot({ resume: false });
  await c.clock.advance(120000);
  assert.equal(restores(c).length, 0);
  assert.equal(c.state.data.surfaceRestoreAt, 0);
});

/** A page with the real ScriptPlayer on recording mocks (its clock is m.clock; the loop's is `clock`). */
function realPage({ start, storage }) {
  const m = playerMocks();
  m.player.destroy();                        // its player talks to a recording host; ours talks to the loop
  const clock = new FakeClock(start);
  const shiori = new FakeShiori(() => null);
  const state = new StateStore('testghost', { storage, clock });
  const loop = new EventLoop({ shiori, stage: m.stage, balloons: m.balloons, clock, ghost: GHOST, state, env: { win: null, doc: null } });
  const player = new ScriptPlayer({
    stage: m.stage, balloons: m.balloons, host: loop, clock: m.clock, speedMs: 50, viewport: () => ({ width: 1000, height: 800 }),
  });
  loop.setPlayer(player);
  return { m, clock, shiori, state, loop, player };
}

test('a finished run kept up by \\![set,balloontimeout,0] is replayed on the next page, so the hold goes on there', async () => {
  // real players: the replay itself runs the tag again (SS §7 REPLAY_SET); nothing sets the option by hand
  const storage = memoryStorage();
  const a = realPage({ start: T0, storage });
  await a.loop.boot({ resume: false });
  a.loop.playScript('\\0stay\\![set,balloontimeout,0]\\e', { event: 'OnTalk' });
  await a.m.clock.runAll();
  await settle();
  a.state.saveNow();
  assert.equal(a.state.data.run.state, 'finished');
  assert.equal(a.state.data.surfaceRestoreAt, T0);
  a.loop.destroy();
  a.player.destroy();

  const b = realPage({ start: at(21, 14, 0), storage });
  try {
    await b.loop.boot({ resume: true });
    await b.m.clock.runAll();
    await settle();
    assert.equal(b.m.balloons.get(0).text, 'stay', 'the replay put the balloon back');
    assert.equal(b.loop.scriptOpts.balloonTimeoutMs, 0, 'and ran the tag again');
    await b.clock.advance(120000);
    assert.equal(b.shiori.find('OnSurfaceRestore').length, 0, 'the stamp of 21:13:20 is overdue, but held');
    assert.equal(b.shiori.find('OnBalloonTimeout').length, 0);
  } finally {
    b.loop.destroy();
    b.player.destroy();
  }
});

// ---------------------------------------------------------------- the reported case: Nato on the real engine

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NATO_DIR = path.join(root, 'site', 'ghost', 'nato', 'ghost', 'master');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'satori.js');
const nato = needs('site/sumika/engines/satori.js', 'site/ghost/nato');

class NodeSatori extends SatoriEngine {
  async factory() { return loadEngineFactory('satori'); }
}

/** ShioriClient look-alike around an in-process engine (as satori_integration.test.mjs). */
class InProcessShiori {
  constructor(engine) {
    this.engine = engine;
    this.base = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
    this.log = [];
  }
  async request(r) {
    const req = { ...r, headers: { ...(r.headers || {}) } };
    const res = parseResponse(this.engine.request(buildRequest(req, this.base)));
    this.log.push({ method: r.method || 'GET', id: r.id, refs: r.refs || [], status: res.status, value: res.value });
    return res;
  }
  find(id) { return this.log.filter(e => e.id === id); }
  async unload() { return this.engine.unload(); }
}

function natoFiles() {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + '/');
      else if (/\.(txt|dic|sat|ini|csv)$/i.test(e.name) && !/^(satori_save|updates)/i.test(e.name)) {
        const b = fs.readFileSync(p);
        out.push({ path: rel + e.name, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
      }
    }
  })(NATO_DIR, '');
  return out;
}

test('Nato\'s first boot broken at its \\x (double-click) leaves her \\0 hidden; OnSurfaceRestore brings her back 30–51 s later', {
  ...nato, timeout: 120000,
}, async () => {
  const engine = new NodeSatori({ engineUrl: ENGINE_JS, ghostDir: '/ghost/master/', log: () => {}, saori: saoriBridge });
  await engine.boot();
  assert.ok(engine.init(natoFiles(), {}, {}), 'Nato loads');
  const shiori = new InProcessShiori(engine);
  const m = playerMocks();
  m.player.destroy();                        // its player talks to a recording host; ours talks to the loop
  m.stage.char(0).setSurface(0);              // the shell's default surfaces, up before the boot talk
  m.stage.char(1).setSurface(10);
  const clock = new FakeClock(new Date(2026, 9, 14, 12, 0, 5, 0).getTime());
  const nato = { id: 'nato', name: 'なっとう', sakuraName: 'なと', keroName: 'ごはん', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };
  const loop = new EventLoop({ shiori, stage: m.stage, balloons: m.balloons, clock, ghost: nato, env: { win: null, doc: null } });
  const player = new ScriptPlayer({
    stage: m.stage, balloons: m.balloons, host: loop, clock: m.clock, speedMs: 50, viewport: () => ({ width: 1000, height: 800 }),
  });
  loop.setPlayer(player);
  try {
    await loop.boot({ resume: false, firstBoot: true });
    const boot = shiori.find('OnFirstBoot');
    assert.equal(boot.length, 1);
    assert.match(boot[0].value, /^\\1\\s\[10\]\\0\\s\[-1\]\\n\\1（冷蔵庫を開けた。）\\x/, 'her OnFirstBoot hides \\0 until after the click-wait');
    // the player reaches the \x: only the \1 balloon, \0 hidden
    await m.clock.runAll();
    await settle();
    assert.equal(player.run.state, 'clickwait');
    assert.equal(m.stage.char(0).surfaceId, -1);
    assert.match(m.balloons.get(1).text, /冷蔵庫を開けた/);

    // a double-click: the first click ends the \x, the double-click breaks the rest before \0 shows (OnBalloonBreak)
    m.balloons.emit('click', { scope: 1, button: 0 });
    m.balloons.emit('dblclick', { scope: 1 });
    await settle();
    await m.clock.runAll();
    await settle();
    assert.equal(shiori.find('OnBalloonBreak').length, 1);
    assert.equal(player.busy, false);
    assert.equal(m.stage.char(0).surfaceId, -1, 'what was seen: no Nato');

    // 12:00:05 + 30 s: nothing yet; the tick at 12:00:35.005 asks the ghost (R0 -1: \0 not shown, R1 10)
    await clock.advance(30000);
    assert.equal(shiori.find('OnSurfaceRestore').length, 0);
    await clock.advance(100);
    const sr = shiori.find('OnSurfaceRestore');
    assert.equal(sr.length, 1);
    assert.equal(sr[0].method, 'GET');
    assert.deepEqual(sr[0].refs, [-1, 10]);
    assert.equal(sr[0].value, '\\0\\s[0]\\1\\s[10]\\e', 'Satori\'s surface_restore_string');
    await m.clock.runAll();
    await settle();
    assert.equal(m.stage.char(0).surfaceId, 0, 'she appears');
    assert.equal(m.stage.char(1).surfaceId, 10);
    // and only once
    await clock.advance(20000);
    assert.equal(shiori.find('OnSurfaceRestore').length, 1);
  } finally {
    loop.destroy();
    player.destroy();
    try { engine.unload(); } catch (e) { /* ignore */ }
  }
});

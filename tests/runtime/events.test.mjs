// EventLoop (src/core/events.js) against fake engine/player/stage: boot and resume sequences, clock, arbitration,
// mouse and key mapping, timers, post-script timeouts, dress-up and close; the loop's side of several ghosts (EV §2.7:
// calls, otherghostname, Close vs Quit, the OnOther* events, the keys) against a fake `peers` handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventLoop, BASEWARE, statusFlags, computeCantalk, keyName, keyVk, keyModifiers, parseBoxArgs, minuteKey, mouseRefs,
  gestureRefs,
} from '../../src/core/events.js';
import { StateStore, memoryStorage, normalizeState } from '../../src/core/state.js';
import { UserProfile } from '../../src/core/user.js';
import { buildRequest } from '../../src/core/shiori.js';
import { setLogLevel } from '../../src/core/log.js';
import {
  FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, FakeWindow, keyEvent, deferred, settle,
} from './fakes.mjs';

const GHOST = {
  id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', defaultShell: 'master',
  shells: [{ id: 'master', name: 'master' }], bundledBalloons: [{ dir: 'LightBlue', name: 'LightBlue' }], balloon: 'LightBlue',
};

function setup({ handler, state, win = null, peers = null, layer = null, user = null, props = null, files = null, ghost = GHOST } = {}) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const player = new FakePlayer();
  const stage = new FakeStage();
  const balloons = new FakeBalloons();
  const dialogs = new FakeDialogs();
  const menu = { opened: [], open(r) { this.opened.push(r); } };
  const st = state || new StateStore('test', { storage: memoryStorage(), clock });
  const loop = new EventLoop({
    shiori, player, stage, balloons, dialogs, ghost, state: st, menu, clock,
    env: { win, doc: null },
    ghostDescript: new Map([['name', 'Hayama-san Next Door'], ['sakura.name', 'Tsubasa']]),
    site: { ghosts: [ghost], balloons: [] }, sessionEpochMs: clock.now(),
    paths: { shell: '/ghost/tsubasa/shell/master/', balloon: '/ghost/tsubasa/LightBlue/' },
    peers, layer, user, props, files,
  });
  return { clock, shiori, player, stage, balloons, dialogs, menu, state: st, loop };
}

/** handler helper: {id: value | fn(req)}; OnTranslate defaults to 204 */
const answers = map => r => (typeof map[r.id] === 'function' ? map[r.id](r) : map[r.id] ?? null);

async function booted(o = {}) {
  const t = setup(o);
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  return t;
}

test('cold boot: version, NOTIFY batch, surfaces, OnFirstBoot -> OnBoot chain, OnTranslate, then play', async () => {
  const { shiori, player, loop } = setup({
    handler: answers({
      version: 'Satori phase Mc203-6',
      OnBoot: '\\0\\s[0]Hello\\e',
      OnTranslate: r => r.refs[0] + 'nya',
    }),
  });
  await loop.boot({ resume: false, firstBoot: true });
  assert.deepEqual(shiori.ids(), [
    'GET version',
    'NOTIFY OnInitialize', 'NOTIFY ownerghostname', 'NOTIFY basewareversion', 'NOTIFY capability', 'NOTIFY OnLanguageChange',
    'NOTIFY OnNotifySelfInfo', 'NOTIFY otherghostname', 'NOTIFY installedsakuraname', 'NOTIFY installedkeroname',
    'NOTIFY installedghostname', 'NOTIFY installedballoonname', 'NOTIFY installedshellname',
    'NOTIFY OnNotifyDressupInfo', 'NOTIFY hwnd',
    'NOTIFY OnSurfaceChange', 'NOTIFY OnSurfaceChange',
    'GET OnFirstBoot', 'GET OnBoot', 'GET OnTranslate',
  ], 'no GET username at boot (ssp.exe asks it at each %username) and no OnNotifyUserInfo without a saved profile');
  assert.deepEqual(shiori.find('basewareversion')[0].refs, BASEWARE);
  assert.deepEqual(shiori.find('ownerghostname')[0].refs, ['Tsubasa'], 'the scope-0 name (GetCharName(0)), not the descript name');
  assert.deepEqual(shiori.find('otherghostname')[0].refs, []);
  assert.deepEqual(shiori.find('OnLanguageChange')[0].refs, ['English', '1033', '', ''], 'no UiLanguage: English');
  assert.deepEqual(shiori.find('OnNotifySelfInfo')[0].refs,
    ['Hayama-san Next Door', 'Tsubasa', '', 'master', '/ghost/tsubasa/shell/master/', 'LightBlue', '/ghost/tsubasa/LightBlue/']);
  assert.deepEqual(shiori.find('OnNotifyDressupInfo')[0].refs, ['0\x01髪\x01ポニーテール\x01\x011\x01', '0\x01足\x01ニーソピンク\x01\x011\x01']);
  assert.deepEqual(shiori.find('OnSurfaceChange').map(r => r.refs), [[0, 10, '0,0,200,400'], [0, 10, '1,10,4,4']]);
  const first = shiori.find('OnFirstBoot')[0];
  assert.equal(first.headers.BaseID, 'OnBoot');
  const u = undefined;
  assert.deepEqual(first.refs, ['0', u, u, u, u, u, u, 'master'], 'SSP sends 8 references, R7 the shell name (EV §2.1)');
  const boot = shiori.find('OnBoot')[0];
  const text = buildRequest(boot, { Charset: 'UTF-8' });
  assert.match(text, /Reference0: master\r\n/);
  assert.match(text, /Reference6: \r\nReference7: \r\n/);
  assert.doesNotMatch(text, /Reference1:/);
  const tr = shiori.find('OnTranslate')[0];
  assert.equal(tr.refs[0], '\\0\\s[0]Hello\\e');
  assert.equal(tr.refs[1], undefined);
  assert.equal(tr.refs[2], 'OnBoot');
  assert.equal(tr.refs[3], ['master', '', '', '', '', '', '', ''].join('\x01'));
  assert.doesNotMatch(buildRequest(tr, {}), /Reference1:/);
  assert.equal(player.plays.length, 1);
  assert.equal(player.plays[0].script, '\\0\\s[0]Hello\\enya');
  assert.equal(player.plays[0].meta.event, 'OnBoot');
  assert.ok(loop.tickHandle, 'ticker started');
});

test('OnNotifyUserInfo (EV §4.16): in the boot batch right before otherghostname once the profile is saved, with its refs; none while unset; again after an engine restart', async () => {
  const batch = sh => sh.ids().filter(x => x.startsWith('NOTIFY ') && !/OnSurfaceChange/.test(x));
  const user = new UserProfile({ storage: null });
  user.set({ name: 'Taro Yamada', nickname: 'Taro', birthday: '2003-05-05', sex: 'male' });
  let t = setup({ user });
  await t.loop.boot({ resume: false });
  const ids = batch(t.shiori);
  assert.equal(ids[ids.indexOf('NOTIFY otherghostname') - 1], 'NOTIFY OnNotifyUserInfo');
  assert.equal(ids.indexOf('NOTIFY OnNotifySelfInfo'), ids.indexOf('NOTIFY OnNotifyUserInfo') - 1);
  assert.deepEqual(t.shiori.find('OnNotifyUserInfo')[0].refs, ['Taro', 'Taro Yamada', '2003,05,05', 'male']);
  assert.equal(t.shiori.find('username').length, 0, 'no GET username at boot');
  t.shiori.log.length = 0;
  await t.loop.afterEngineRestart();
  assert.equal(t.shiori.find('OnNotifyUserInfo').length, 1, 'a reloaded engine is told again');
  // the Site's call when the Preferences box closes after an edit: one NOTIFY, never a COMMUNICATE
  t.shiori.log.length = 0;
  await t.loop.notifyUserInfo();
  assert.deepEqual(t.shiori.log.map(r => [r.method, r.id, r.refs]), [['NOTIFY', 'OnNotifyUserInfo', ['Taro', 'Taro Yamada', '2003,05,05', 'male']]]);
  t.loop.destroy();
  t.shiori.log.length = 0;
  await t.loop.notifyUserInfo();
  assert.equal(t.shiori.log.length, 0, 'nothing once frozen');

  for (const u of [null, new UserProfile({ storage: null })]) {
    t = setup({ user: u });
    await t.loop.boot({ resume: false });
    assert.equal(t.shiori.find('OnNotifyUserInfo').length, 0, u ? 'a profile never saved' : 'no profile');
    t.loop.destroy();
  }
});

test('the menu\'s look from the SHIORI (UI §2.3): asked after the NOTIFY batch, before the surfaces and the boot event, on a resume too; not once torn down [disasm LoadGhostCore 0x62161e]', async () => {
  for (const o of [{ resume: false, firstBoot: true }, { resume: false }, { resume: true }]) {
    const t = setup({ handler: answers({ OnBoot: '\\0hi\\e', OnFirstBoot: '\\0hi\\e' }) });
    let calls = 0;
    t.loop.menu = { open() {}, async loadShioriLook() { calls++; await t.loop.resource('menu.background.bitmap.filename'); } };
    await t.loop.boot(o);
    const ids = t.shiori.ids();
    const at = ids.indexOf('GET menu.background.bitmap.filename');
    assert.equal(calls, 1, JSON.stringify(o));
    assert.deepEqual([ids[at - 1], ids[at + 1]], ['NOTIFY hwnd', 'NOTIFY OnSurfaceChange'], JSON.stringify(o));
    const boot = ids.findIndex(x => /^GET On(First)?Boot$/.test(x));
    if (o.resume) assert.equal(boot, -1);
    else assert.ok(boot > at, 'before the boot event');
    assert.equal(t.shiori.find('menu.background.bitmap.filename')[0].kind, 'resource', 'GetStringShiori (GET String for a 2.x SHIORI)');
    t.loop.destroy();
  }
  // the loop torn down during the NOTIFY batch: nothing asked; a menu without loadShioriLook boots as usual (setup's)
  let calls = 0;
  const t = setup({ handler: r => { if (r.id === 'hwnd') t.loop.destroy(); return null; } });
  t.loop.menu = { open() {}, loadShioriLook() { calls++; return Promise.resolve(); } };
  await t.loop.boot({ resume: false });
  assert.equal(calls, 0);
});

test('%username (properties.md §2.3): GET username at each expansion before OnTranslate; 204 -> the stored nickname -> `user`; backslashes doubled', async () => {
  const user = new UserProfile({ storage: null });
  let name = null;
  const t = await booted({ user, handler: answers({ username: () => name, OnTalk: '\\0Hi %username!\\e' }) });
  await t.loop.send('OnTalk');
  assert.deepEqual(t.shiori.ids(), ['GET OnTalk', 'GET username', 'GET OnTranslate']);
  assert.equal(t.shiori.find('OnTranslate')[0].refs[0], '\\0Hi user!\\e', 'OnTranslate sees the expanded script');
  assert.equal(t.player.last.script, '\\0Hi user!\\e');
  user.set({ nickname: 'Taro' });
  await t.loop.send('OnTalk');
  assert.equal(t.player.last.script, '\\0Hi Taro!\\e', 'the nickname the visitor stored');
  name = 'a\\b';
  await t.loop.send('OnTalk');
  assert.equal(t.player.last.script, '\\0Hi a\\\\b!\\e', 'the ghost\'s own, its backslash doubled [disasm 0x637252]');
  assert.equal(t.shiori.find('username').length, 3, 'no cache');
  // playScript: a Promise of the run when the expansion asked an engine, the run itself otherwise
  const p = t.loop.playScript('\\0%username\\e');
  assert.ok(p && typeof p.then === 'function');
  assert.equal((await p).script, '\\0a\\\\b\\e');
  assert.equal(t.loop.playScript('\\0%month\\e').script, `\\0${new Date(t.clock.now()).getMonth() + 1}\\e`);
  // a replay plays the stored script as it is
  t.loop._replay({ src: '\\0%username\\e', origin: 'OnTalk', refs: [] });
  assert.equal(t.player.replays.at(-1).script, '\\0%username\\e');
  t.loop.destroy();
});

test('OnTranslate: a reply that changed the script is expanded again; one that did not, not', async () => {
  let reply = () => null;
  // %ms has no value here (the ghost answers no word and the loop has no word list), so it stays as written and an
  // expansion of the unchanged reply would ask for it again
  const t = await booted({ handler: answers({ OnTalk: '\\0%selfname %ms\\e', OnTranslate: r => reply(r) }) });
  const asked = [];
  const envVar = t.loop.envVar.bind(t.loop);
  const word = t.loop.word.bind(t.loop);
  t.loop.envVar = name => { asked.push(name); return envVar(name); };
  t.loop.word = type => { asked.push(type); return word(type); };
  const send = async () => { asked.length = 0; await t.loop.send('OnTalk'); };
  const once = ['selfname', '\\ms', '\\ms'];             // one expansion: pass 1 changed the text, pass 2 did not
  await send();                                          // 204
  assert.equal(t.player.last.script, '\\0Tsubasa %ms\\e');
  assert.deepEqual(asked, once);
  reply = () => '\\0%selfname, %keroname.\\e';           // changed: expanded once more
  await send();
  assert.equal(t.player.last.script, '\\0Tsubasa, .\\e');
  assert.deepEqual(asked, [...once, 'selfname', 'keroname']);
  reply = r => r.refs[0];                                // 200 with R0 as it came (emily4's when she adds nothing)
  await send();
  assert.equal(t.shiori.find('OnTranslate').at(-1).refs[0], '\\0Tsubasa %ms\\e');
  assert.equal(t.player.last.script, '\\0Tsubasa %ms\\e');
  assert.deepEqual(asked, once, 'not expanded again [disasm 0x63B7EF–0x63B822: only a changed script]');
  t.loop.destroy();
});

test('%et and %wronghour as ssp.exe draws them: r = genrand(59787) gives r mod 1000 and the unit r mod 5; the hour 1 or 2 off', async () => {
  const t = await booted();
  /** random() values that make genrand(n) return each of rs in turn */
  const draws = (n, ...rs) => { let i = 0; t.loop.random = () => (rs[i++ % rs.length] + 0.5) / n; };
  const et = r => { draws(59787, r); return t.loop.envVar('et'); };
  assert.deepEqual([et(0), et(1234), et(1003), et(59786)], ['0msec', '234dozen', '3t', '786yard']);
  t.loop.random = () => 1;
  assert.equal(t.loop.envVar('et'), '786yard', 'a random() of 1 stays in range');
  let i = 0;
  t.loop.random = () => (i++ * 0.6180339887) % 1;
  for (let k = 0; k < 200; k++) {
    const [, num, unit] = /^(\d+)(msec|yard|kg|t|dozen)$/.exec(t.loop.envVar('et'));
    assert.equal(unit, ['msec', 'yard', 'kg', 't', 'dozen'][num % 5], 'the number decides the unit (1000 is a multiple of 5)');
  }
  // FakeClock: 21:13. First genrand(23): even 1 hour, odd 2; second: even earlier, odd later
  const wrong = (a, b) => { draws(23, a, b); return t.loop.envVar('wronghour'); };
  assert.deepEqual([wrong(0, 0), wrong(1, 0), wrong(0, 1), wrong(1, 1), wrong(22, 21)], ['20', '19', '22', '23', '22']);
  t.clock.t = new Date(2026, 9, 6, 23, 30).getTime();
  assert.deepEqual([wrong(1, 1), wrong(0, 1)], ['1', '0'], 'past midnight: mod 24');
  t.clock.t = new Date(2026, 9, 6, 0, 5).getTime();
  assert.deepEqual([wrong(1, 0), wrong(0, 0)], ['22', '23']);
  // through the expander: 3 and 10 characters, a prefix match (%wronghours keeps its s)
  draws(59787, 42);
  assert.equal(await t.loop.expand('%et/%etc'), '42kg/42kgc');
  draws(23, 0, 1);
  assert.equal(await t.loop.expand('%wronghours'), '1s');
  t.loop.destroy();
});

/** The engine answers one request at a time, each on a later turn, as ShioriClient's FIFO and the worker do. */
function fifo(shiori) {
  const request = shiori.request.bind(shiori);
  let chain = Promise.resolve();
  shiori.request = r => {
    const p = chain.then(() => new Promise(res => setImmediate(res))).then(() => request(r));
    chain = p.catch(() => {});
    return p;
  };
  return shiori;
}

test('replies play in the order their events were sent, also when one needs an engine read (%username) before OnTranslate', async () => {
  // A's reply asks GET username, which the FIFO puts behind B's event: the stage after a reply (expand, OnTranslate,
  // play) still goes in reply order, so the newer B is the one left playing, as ssp.exe's Loop takes A then B
  for (const named of [false, true]) {
    const t = await booted({ handler: answers({ OnA: named ? '\\0A %username\\e' : '\\0A\\e', OnB: '\\0B\\e', username: 'Taro' }) });
    fifo(t.shiori);
    await Promise.all([t.loop.send('OnA'), t.loop.send('OnB')]);
    await settle();
    assert.deepEqual(t.shiori.ids(), ['GET OnA', 'GET OnB', ...(named ? ['GET username'] : []), 'GET OnTranslate', 'GET OnTranslate']);
    assert.deepEqual(t.shiori.find('OnTranslate').map(r => r.refs[2]), ['OnA', 'OnB']);
    assert.deepEqual(t.player.plays.map(p => p.script), [named ? '\\0A Taro\\e' : '\\0A\\e', '\\0B\\e'], 'B is left playing');
    t.loop.destroy();
  }
  // a \![raise] reply that needs GET username goes before a later click's reply too
  const t = await booted({ handler: answers({ OnR: '\\0R %username\\e', OnB: '\\0B\\e', username: 'Taro' }) });
  t.loop.playScript('\\0talk\\e', { event: 'OnTalk' });
  fifo(t.shiori);
  const raised = t.loop.raise('OnR', []);
  await t.loop.send('OnB');
  await raised;
  await settle();
  assert.deepEqual(t.player.plays.map(p => p.script), ['\\0talk\\e', '\\0R Taro\\e', '\\0B\\e']);
  t.loop.destroy();
});

test('a reply queued behind the running script (OnShellChanged after its \\![change,shell]) is expanded when it plays, before OnTranslate; a script: choice too', async () => {
  const t = await booted({ handler: answers({ OnShellChanged: '\\0%selfname, is it %username?\\e', username: 'Taro' }) });
  t.loop.playScript('\\0Let me change.\\![change,shell,Winter]Ta-da!\\e', { event: 'OnTalk' });
  const shown = t.loop.detachStage();
  t.loop.attachStage(new FakeStage(), { id: 'alt', name: 'Winter', path: '/ghost/tsubasa/shell/alt/' });
  await t.loop.shellChanged({ surfaces: shown, defer: true });
  await settle();
  assert.equal(t.player.plays.length, 1, 'queued (_deferReply): the calling script is not cut');
  assert.equal(t.shiori.find('username').length, 0, 'read when the reply is about to play, not when it was queued');
  t.player.finish();
  await settle();
  assert.deepEqual(t.shiori.ids().filter(x => /OnShellChanged|username|OnTranslate/.test(x)),
    ['GET OnShellChanged', 'GET username', 'GET OnTranslate'], '_playQueued: expanded, then OnTranslate');
  assert.equal(t.shiori.find('OnTranslate')[0].refs[0], '\\0Tsubasa, is it Taro?\\e');
  assert.equal(t.player.last.meta.event, 'OnShellChanged');
  assert.equal(t.player.last.script, '\\0Tsubasa, is it Taro?\\e');
  // \q[x,script:…]: expanded, never translated (EV §4.12)
  t.shiori.log.length = 0;
  t.player.emit('link', { kind: 'choice', id: 'script:\\0%selfname\\e', label: 'x', refs: [], scope: 0 });
  await settle();
  assert.deepEqual(t.shiori.log.filter(r => r.method === 'GET').map(r => r.id), []);
  assert.equal(t.player.last.script, '\\0Tsubasa\\e');
  assert.equal(t.player.last.meta.event, 'script:');
  t.loop.destroy();
});

test('OnNotifySelfInfo names the balloon actually loaded, not a stale stored choice (R5 and R6 match)', async () => {
  const clock = new FakeClock();
  const state = new StateStore('test', { storage: memoryStorage(), clock });
  state.data.balloon = 'foo';                          // a shared balloon the site has since dropped
  const make = balloonName => new EventLoop({
    shiori: new FakeShiori(() => null), player: new FakePlayer(), stage: new FakeStage(), balloons: new FakeBalloons(),
    dialogs: new FakeDialogs(), ghost: { ...GHOST, balloon: null, bundledBalloons: [] }, state, menu: { open() {} }, clock,
    env: { win: null, doc: null }, ghostDescript: new Map([['name', 'Plain']]), site: { ghosts: [], balloons: [] },
    sessionEpochMs: clock.now(), balloonName, paths: { shell: '/ghost/plain/shell/master/', balloon: '/balloon/sumika/' },
  });
  const loop = make('Sumika');
  await loop.boot({ resume: false });
  assert.deepEqual(loop.shiori.find('OnNotifySelfInfo')[0].refs.slice(5), ['Sumika', '/balloon/sumika/']);
  loop.destroy();
  const builtin = make('');                            // the built-in balloon has no name: the stored one is all there is
  await builtin.boot({ resume: false });
  assert.equal(builtin.shiori.find('OnNotifySelfInfo')[0].refs[5], 'foo');
  builtin.destroy();
});

test('OnFirstBoot with a script does not send OnBoot; OnTranslate 204 plays the original', async () => {
  const { shiori, player, loop } = setup({ handler: answers({ OnFirstBoot: '\\0Nice to meet you\\e' }) });
  await loop.boot({ resume: false, firstBoot: true });
  assert.equal(shiori.find('OnBoot').length, 0);
  assert.equal(player.plays[0].script, '\\0Nice to meet you\\e');
});

test('\\![reload,shiori] (EV §2.10): NOTIFY OnDestroy [reload], the engine reloads, then GET version, the NOTIFY batch with OnInitialize [reload] and OnSurfaceChange, all queued at once; no boot event', async () => {
  const t = await booted({ handler: answers({ OnBoot: '\\0hi\\e', version: 'v1' }) });
  let release = null;
  t.loop.shioriReloader = () => {
    t.shiori.log.push({ method: 'RELOAD', id: 'engine', refs: [], headers: {} });
    return new Promise(r => { release = r; });
  };
  t.loop._comm = { ids: ['x'] };             // a COMMUNICATE still pending goes with the old engine (EV §2.7.7)
  const p = t.loop.reload('shiori');
  assert.equal(typeof p.then, 'function', 'the player waits at the tag');
  assert.equal(t.loop._comm, null);
  assert.deepEqual(t.shiori.ids(), [
    'NOTIFY OnDestroy', 'RELOAD engine', 'GET version',
    'NOTIFY OnInitialize', 'NOTIFY ownerghostname', 'NOTIFY basewareversion', 'NOTIFY capability', 'NOTIFY OnLanguageChange',
    'NOTIFY OnNotifySelfInfo', 'NOTIFY otherghostname', 'NOTIFY installedsakuraname', 'NOTIFY installedkeroname',
    'NOTIFY installedghostname', 'NOTIFY installedballoonname', 'NOTIFY installedshellname',
    'NOTIFY OnNotifyDressupInfo', 'NOTIFY hwnd',
    'NOTIFY OnSurfaceChange', 'NOTIFY OnSurfaceChange',
  ], 'queued at once, in this order: the client sends what follows the reload to the new engine');
  // UnloadShiori(true) [disasm 0x6221c9], NotifyInitialEvents(false, true) [disasm 0x621b00]
  assert.deepEqual(t.shiori.find('OnDestroy')[0].refs, ['reload']);
  assert.deepEqual(t.shiori.find('OnInitialize')[0].refs, ['reload']);
  assert.ok(t.shiori.find('OnDestroy').every(r => r.method === 'NOTIFY'));
  let done = null;
  p.then(v => { done = v; });
  await settle();
  assert.equal(done, null, 'held until the engine has loaded again');
  release(true);
  assert.equal(await p, true);
  await settle();
  assert.ok(!t.shiori.ids().some(x => /On(Boot|FirstBoot|GhostChanged|Reload\w*)$/.test(x)), 'no boot event, no event of its own');
  assert.equal(t.loop.booted, true);
  t.loop.destroy();

  // refused (false, nothing sent): not booted, closed, a ghost change, frozen; no reloader
  const fresh = setup();
  fresh.loop.shioriReloader = () => Promise.resolve(true);
  assert.equal(fresh.loop.reloadShiori(), false, 'not booted');
  for (const flag of ['closed', 'changing', 'frozen']) {
    const u = await booted();
    u.loop.shioriReloader = () => Promise.resolve(true);
    u.loop[flag] = true;
    assert.equal(u.loop.reloadShiori(), false, flag);
    assert.equal(u.shiori.log.length, 0, flag);
    u.loop.destroy();
  }
  const v = await booted();
  setLogLevel('silent');
  try {
    assert.equal(v.loop.reloadShiori(), false, 'no reloader');
    assert.equal(v.loop.reload('shiori'), undefined, 'the player does not wait');
    assert.equal(v.shiori.log.length, 0);
    // a reloader that answers false (a load that failed) or throws: false, and the script goes on
    v.loop.shioriReloader = () => Promise.resolve(false);
    assert.equal(await v.loop.reloadShiori(), false);
    v.loop.shioriReloader = () => { throw new Error('boom'); };
    assert.equal(await v.loop.reloadShiori(), false);
    assert.equal(v.loop.reload('makoto'), undefined, 'other kinds are not done');
  } finally {
    setLogLevel('warn');
  }
  v.loop.destroy();
});

test('boot({silent}) (\\![reload,ghost], EV §2.10): a cold boot with the NOTIFY batch and the surfaces but no boot event; nothing of the last session replays', async () => {
  const t = setup({ handler: answers({ OnBoot: '\\0hi\\e', OnFirstBoot: '\\0first\\e', OnGhostChanged: '\\0back\\e' }) });
  t.state.data.run = { src: '\\0old\\e', ip: 0, state: 'running', origin: 'OnBoot' };
  const r = await t.loop.boot({ resume: false, firstBoot: true, changed: { sakuraName: 'X' }, silent: true });
  assert.equal(r.run, null);
  const ids = t.shiori.ids();
  assert.equal(ids[0], 'GET version');
  assert.ok(ids.includes('NOTIFY hwnd') && ids.includes('NOTIFY OnSurfaceChange'));
  assert.ok(!ids.some(x => x.startsWith('GET On')), ids.join());
  assert.deepEqual(t.shiori.find('OnInitialize')[0].refs, ['']);
  assert.equal(t.player.plays.length + t.player.replays.length, 0);
  assert.equal(t.loop.booted, true);
  assert.ok(t.loop.tickHandle, 'the ticks run');
  t.loop.destroy();
});

test('\\![reload,ghost] (EV §2.10): the lazy binds go out, then a change to the ghost itself with reload (no OnGhostChanging); the player does not wait', async () => {
  const t = await booted({ handler: answers({ OnBoot: '\\0hi\\e' }) });
  const asked = [];
  t.loop.on('change', r => asked.push(r));
  let flushed = 0;
  t.loop._flushDressup = () => { flushed++; };
  t.loop.pendingDressup.push({ scope: 0 });
  assert.equal(t.loop.reload('ghost'), undefined);
  assert.equal(flushed, 1, 'ProcessLazyCommandExec [disasm 0x6209e3]');
  assert.deepEqual(asked, [{ kind: 'ghost', target: 'tsubasa', byId: true, reload: true, reason: 'automatic', raiseEvent: false, scope: 0, fromScript: true }]);
  assert.equal(t.shiori.find('OnGhostChanging').length + t.shiori.find('OnClose').length, 0);
  t.loop.changing = true;
  assert.equal(t.loop.reloadGhost(), false, 'not during a ghost change');
  assert.equal(asked.length, 1);
  t.loop.changing = false;
  t.loop.destroy();
});

test('resume: no OnBoot, NOTIFY dress-up info, run replayed, timers re-armed (overdue one-shot fires once)', async () => {
  const clock0 = new FakeClock();
  const storage = memoryStorage();
  const now = clock0.now();
  const seed = new StateStore('test', { storage, clock: clock0 });
  seed.data = normalizeState({
    v: 1,
    run: { src: '\\0Menu\\q[A,a]\\e', ip: 9, state: 'finished', hasChoices: true, origin: 'OnMouseDoubleClick', timeoutRemainingMs: 20000 },
    timers: [
      { ev: '服着せ替えメニュー', refs: [], repeat: false, intervalMs: 1, dueAt: now - 100, kind: 'raise' },
      { ev: 'later', refs: ['x'], repeat: false, intervalMs: 5000, dueAt: now + 3000, kind: 'raise' },
      { ev: 'rep', refs: [], repeat: true, intervalMs: 1000, dueAt: now - 5000, kind: 'raise' },
    ],
    clock: { lastMinute: minuteKey(now) },
  });
  seed.saveNow();
  const state = new StateStore('test', { storage, clock: clock0 });
  assert.equal(state.isNew, false);
  const t = setup({ state });
  t.clock.t = now;
  await t.loop.boot({ resume: true });
  const ids = t.shiori.ids();
  assert.ok(!ids.includes('GET OnBoot') && !ids.includes('GET OnFirstBoot'));
  assert.ok(ids.includes('NOTIFY OnNotifyDressupInfo'));
  assert.equal(t.player.replays.length, 1);
  assert.equal(t.player.replays[0].run.src, '\\0Menu\\q[A,a]\\e');
  await settle();
  const fired = t.shiori.find('服着せ替えメニュー');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].method, 'GET');
  assert.equal(fired[0].headers.SenderType, 'internal,raise');
  assert.equal(t.shiori.find('rep').length, 0, 'overdue repeating timer moved to now+interval');
  await t.clock.advance(1000);
  assert.equal(t.shiori.find('rep').length, 1);
  await t.clock.advance(2000);
  assert.deepEqual(t.shiori.find('later').map(r => r.refs), [['x']]);
  // the replayed run finishes with choices: its remaining 20 s choice timeout applies
  t.player.finish({ hasChoices: true });
  await t.clock.advance(19000);
  assert.equal(t.shiori.find('OnChoiceTimeout').length, 0);
  await t.clock.advance(1500);
  assert.deepEqual(t.shiori.find('OnChoiceTimeout').map(r => r.refs), [['\\0Menu\\q[A,a]\\e']]);
});

test('ticks: GET when the ghost can talk, NOTIFY with R3=0 while talking; OnMinuteChange after OnSecondChange', async () => {
  const t = await booted();
  await t.clock.advance(1100);          // ticks land 5 ms after each wall-clock second
  let sec = t.shiori.find('OnSecondChange');
  assert.equal(sec.length, 1);
  assert.equal(sec[0].method, 'GET');
  assert.deepEqual(sec[0].refs, [0, 0, 0, 1, 0]);
  assert.equal(sec[0].headers.Status, undefined);
  t.loop.playScript('\\0talking\\e');
  await t.clock.advance(1000);
  sec = t.shiori.find('OnSecondChange');
  assert.equal(sec.length, 2);
  assert.equal(sec[1].method, 'NOTIFY');
  assert.equal(sec[1].refs[3], 0);
  assert.equal(sec[1].headers.Status, 'talking');
  // 21:13:22 -> 21:14:00
  await t.clock.advance(39000);
  const ids = t.shiori.ids().filter(x => /SecondChange|MinuteChange/.test(x));
  const m = ids.indexOf('NOTIFY OnMinuteChange');
  assert.ok(m > 0, 'minute change sent');
  assert.equal(ids[m - 1], 'NOTIFY OnSecondChange');
  assert.equal(ids.filter(x => /MinuteChange/.test(x)).length, 1);
});

test('R1 / R2 (EV §3.2.1): the collision rects, sampled on odd local seconds before the tick; R1 against the desk', async () => {
  // ssp.exe 2.9.10 CCharWndCodeManager::Check [disasm OnTimerMain 0x467d1d, Check 0x420ec5, 0x420c44, 0x420d29]
  const t = await booted();
  t.stage.desk = () => ({ w: 1280, h: 720 });
  const c0 = t.stage.char(0), c1 = t.stage.char(1);
  c0.rect = { x: 1090, y: 340, width: 220, height: 380 };            // her image reaches past the right edge,
  c0.collisionRect = { x: 1159, y: 387, width: 112, height: 294 };   // her body does not
  c1.collisionRect = null;                                            // a blank \1 never counts
  const refs = () => t.shiori.find('OnSecondChange').at(-1).refs;
  const tick = async () => { await t.clock.advance(1000); return refs().slice(1, 3); };
  await t.clock.advance(1100);                                        // 21:13:21, odd: sampled
  assert.deepEqual(refs().slice(1, 3), [0, 0]);
  c0.collisionRect = { x: 1168, y: 387, width: 112, height: 294 };   // right edge on the desk's: still inside
  assert.deepEqual(await tick(), [0, 0]);                             // :22
  assert.deepEqual(await tick(), [0, 0]);                             // :23
  c0.collisionRect = { x: 1169, y: 387, width: 112, height: 294 };   // one pixel past it
  assert.deepEqual(await tick(), [0, 0], ':24, even: not sampled');
  assert.deepEqual(await tick(), [1, 0], ':25: 見切れ');
  c0.collisionRect = undefined;                                       // loading: the last value stays
  assert.deepEqual([await tick(), await tick()], [[1, 0], [1, 0]]);
  c0.hide();                                                          // a hidden window never counts
  assert.deepEqual([await tick(), await tick()], [[1, 0], [0, 0]]);  // :28, :29
  c0.show();
  // R2: scope 0 and scope 1, strict intersection
  c0.collisionRect = { x: 940, y: 323, width: 280, height: 352 };
  c1.collisionRect = { x: 778, y: 617, width: 108, height: 90 };
  assert.deepEqual([await tick(), await tick()], [[0, 0], [0, 0]]);  // :30, :31
  c1.collisionRect = { x: 840, y: 617, width: 108, height: 90 };
  assert.deepEqual([await tick(), await tick()], [[0, 0], [0, 1]]);  // :32, :33: 重なり
  c1.collisionRect = { x: 832, y: 617, width: 108, height: 90 };     // right edge on \0's left edge
  assert.deepEqual([await tick(), await tick()], [[0, 1], [0, 0]]);
  const c2 = t.stage.char(2);                                         // a \p[2] over \0 does not count
  c2.surfaceId = 20;
  c2.collisionRect = { x: 950, y: 400, width: 100, height: 100 };
  assert.deepEqual([await tick(), await tick()], [[0, 0], [0, 0]]);
  c1.collisionRect = { x: 840, y: 617, width: 108, height: 90 };
  c1.hide();
  assert.deepEqual([await tick(), await tick()], [[0, 0], [0, 0]], 'a hidden \\1 does not count');
  c1.show();
  assert.deepEqual([await tick(), await tick()], [[0, 0], [0, 1]]);
  c1.collisionRect = undefined;
  assert.deepEqual([await tick(), await tick()], [[0, 1], [0, 1]], 'unknown: the last value stays');
});

test('an open box leaves the ticks alone (C6): GET, R3 1, Status opening(…); the reply plays and the box stays', async () => {
  // ssp.exe 2.9.10: a box only sets SPGhost+0x4198, which only AddStatusText reads; a tick is NOTIFY only for the
  // flags OnTimeChange tests [disasm 0x641e03–0x641e50, CreateInputBox 0x49b27a; decision: follow SSP]
  let quiet = false;
  const t = await booted({
    handler: answers({
      OnTeachStart: '\\0Teach me!\\e',
      OnSecondChange: r => (r.method === 'GET' && !quiet ? '\\0random talk\\e' : null),
    }),
  });
  const ticks = () => t.shiori.find('OnSecondChange').map(r => [r.method, r.refs[3], r.headers.Status]);
  t.loop.openBox('inputbox', ['数当て答え']);
  await settle();
  await t.clock.advance(1100);
  assert.deepEqual(ticks(), [['GET', 1, 'opening(input)']]);
  assert.equal(t.player.last.script, '\\0random talk\\e', 'random talk plays during the prompt');
  assert.equal(t.dialogs.boxes.length, 1);
  assert.equal(t.loop.statusHeader(), 'talking,opening(input)', 'the box stays open');
  await t.clock.advance(1000);
  assert.deepEqual(ticks().at(-1), ['NOTIFY', 0, 'talking,opening(input)'], 'the talk makes it NOTIFY, not the box');
  t.player.finish();
  await settle();
  t.dialogs.boxes[0].resolve({ text: '42', timedOut: false });
  await settle();
  assert.deepEqual(t.shiori.find('OnUserInput').map(r => r.refs), [['数当て答え', '42', '']]);

  // the teach box (once its OnTeachStart reply has ended) and the communicate box
  t.loop.openBox('teachbox', []);
  await settle();
  assert.equal(t.player.last.script, '\\0Teach me!\\e');
  t.player.finish();
  await settle();
  await t.clock.advance(1000);
  assert.deepEqual(ticks().at(-1), ['GET', 1, 'opening(teach)']);
  t.player.finish();
  t.loop.closeBox('teachbox', []);
  await settle();
  t.loop.openBox('communicatebox', []);
  await settle();
  await t.clock.advance(1000);
  assert.deepEqual(ticks().at(-1), ['GET', 1, 'opening(communicate)']);
  t.player.finish();
  t.dialogs.boxes.at(-1).resolve({ text: null, reason: 'cancel' });
  await settle();
  assert.equal(t.loop.statusHeader(), '');

  // the runtime's own box (Other percentage…): no opening(…), and the ticks go on as GET, as under SSP's modal
  // CScalingDlg, whose RunModalLoop keeps the main timer running [disasm 0x42f7e9]
  Object.defineProperty(t.dialogs, 'anyOpen', { get: () => true });
  await t.clock.advance(1000);
  assert.deepEqual(ticks().at(-1), ['GET', 1, undefined]);
  t.player.finish();
  await settle();

  // OnMinuteChange the same: 21:13:25 -> 21:14:00 with an input box open
  quiet = true;
  t.loop.openBox('inputbox', ['ユーザ名']);
  await settle();
  await t.clock.advance(new Date(2026, 9, 6, 21, 14, 0, 100).getTime() - t.clock.now());
  assert.deepEqual(t.shiori.find('OnMinuteChange').map(r => [r.method, r.refs[3], r.headers.Status]), [['GET', 1, 'opening(input)']]);
  assert.equal(t.dialogs.boxes.at(-1).o.id, 'ユーザ名');
  t.loop.destroy();
});

test('ticks are coalesced while the previous one is unanswered', async () => {
  let hold = null;
  const t = await booted({ handler: r => (r.id === 'OnSecondChange' && !hold ? (hold = deferred()).promise : null) });
  await t.clock.advance(3000);
  assert.equal(t.shiori.find('OnSecondChange').length, 1);
  hold.resolve(null);
  await t.clock.advance(1000);
  assert.equal(t.shiori.find('OnSecondChange').length, 2);
});

test('a tick reply plays only if no other run started while it was in flight', async () => {
  let hold = null;
  const t = await booted({
    handler: r => {
      if (r.id !== 'OnSecondChange') return null;
      if (!hold) return '\\0random talk\\e';
      return hold.promise;
    },
  });
  await t.clock.advance(1100);
  assert.equal(t.player.plays.length, 1);
  assert.equal(t.player.last.script, '\\0random talk\\e');
  t.player.finish();
  await settle();
  hold = deferred();
  await t.clock.advance(1000);
  t.loop.playScript('\\0user\\e');
  hold.resolve('\\0stale random talk\\e');
  await settle();
  assert.equal(t.player.plays.length, 2);
  assert.equal(t.player.last.script, '\\0user\\e');
});

test('choices: Ex then plain (raw IDs), On-IDs raised directly, script: plays, anchors do not interrupt', async () => {
  const t = await booted({ handler: answers({ OnChoiceSelect: '\\0chosen\\e' }) });
  t.loop.playScript('\\0menu\\q[Yes,y]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  const info = { kind: 'choice', id: '選択\x01Yes\x011', label: 'Yes', refs: [], scope: 0 };
  t.player.emit('link', info);
  t.balloons.emit('link', info);        // the same click reported twice
  await settle();
  assert.deepEqual(t.shiori.find('OnChoiceSelectEx').map(r => r.refs), [['Yes', '選択\x01Yes\x011']]);
  assert.deepEqual(t.shiori.find('OnChoiceSelect').map(r => r.refs), [['選択\x01Yes\x011']]);
  assert.equal(t.player.last.script, '\\0chosen\\e');
  assert.equal(t.balloons.hidden, 0, 'the reply owns the balloons (it clears them itself unless it starts with \\C)');

  t.shiori.log.length = 0;
  t.player.emit('link', { kind: 'choice', id: 'On再生リスト移動', label: 'Up', refs: ['１'], scope: 0 });
  await settle();
  // every click lets the item go first: NOTIFY OnChoiceEnter without References (EV §4.7)
  assert.deepEqual(t.shiori.ids(), ['NOTIFY OnChoiceEnter', 'GET On再生リスト移動']);
  assert.deepEqual(t.shiori.log[0].refs, []);
  assert.deepEqual(t.shiori.log[1].refs, ['１']);
  assert.equal(t.shiori.log[1].headers.SenderType, 'internal,raise');
  assert.equal(t.balloons.hidden, 1, 'a raise that plays nothing closes the balloons');

  t.shiori.log.length = 0;
  t.player.emit('link', { kind: 'choice', id: 'script:\\0inline\\e', label: 'x', refs: [], scope: 0 });
  await settle();
  assert.equal(t.shiori.log.filter(r => r.method === 'GET').length, 0);
  assert.equal(t.player.last.script, '\\0inline\\e');
  assert.equal(t.balloons.hidden, 1, 'script: choices play at once, on the same balloons');

  t.shiori.log.length = 0;
  t.loop.playScript('\\0long talk with \\_a[link1]a link\\_a ...');
  const interrupts = t.player.interrupts;
  t.clock.t += 1000;
  t.player.emit('link', { kind: 'anchor', id: 'link1', label: 'a link', refs: [], scope: 0 });
  await settle();
  assert.deepEqual(t.shiori.ids().filter(x => /Anchor/.test(x)), ['GET OnAnchorSelectEx', 'GET OnAnchorSelect']);
  assert.equal(t.player.interrupts, interrupts);
  assert.equal(t.player.busy, true);
});

test('a choice keeps the balloons until its reply; clicks while the reply is pending are ignored; no reply closes them', async () => {
  const pending = [];
  const t = await booted({
    win: new FakeWindow(),
    handler: answers({
      OnChoiceSelectEx: () => { const d = deferred(); pending.push(d); return d.promise; },
      OnChoiceSelect: r => ({ cell1: '\\C\\0\\_q[board 2]\\q[3,cell3]\\*\\e' })[r.refs[0]] ?? null,
    }),
  });
  t.loop.playScript('\\0\\_q[board]\\q[1,cell1]\\q[2,cell2]\\*\\e', { event: 'OnKeyPress' });
  t.player.finish({ hasChoices: true, noChoiceTimeout: true });
  await settle();
  assert.equal(t.loop.cantalk, false);

  // the click: the selection goes out, the balloons stay up
  t.balloons.emit('link', { kind: 'choice', id: 'cell1', label: '1', refs: [], scope: 0 });
  await settle();
  assert.equal(pending.length, 1);
  assert.equal(t.balloons.hidden, 0, 'not hidden while the reply is pending');
  assert.equal(t.loop.choicesLive, false);
  assert.equal(t.loop.cantalk, false, 'the reply to a user action is on its way');

  // while it is pending: other choices, anchors and a double-click on the old balloon do nothing; ticks are NOTIFY
  t.clock.t += 100;
  t.balloons.emit('link', { kind: 'choice', id: 'cell2', label: '2', refs: [], scope: 0 });
  t.player.emit('link', { kind: 'choice', id: 'cell2', label: '2', refs: [], scope: 0 });
  t.balloons.emit('link', { kind: 'anchor', id: 'help', label: 'help', refs: [], scope: 0 });
  t.clock.t += 1000;
  t.balloons.emit('dblclick', { scope: 0 });
  await t.clock.advance(1100);
  assert.equal(pending.length, 1, 'one selection per balloon');
  assert.equal(t.shiori.find('OnAnchorSelectEx').length, 0);
  assert.equal(t.shiori.find('OnBalloonClose').length, 0);
  assert.equal(t.balloons.hidden, 0);
  const tick = t.shiori.find('OnSecondChange').at(-1);
  assert.equal(tick.method, 'NOTIFY');
  assert.equal(tick.refs[3], 0);

  // Ex has nothing -> OnChoiceSelect answers with a \C script: it plays on the same balloons (never hidden)
  pending[0].resolve(null);
  await settle();
  assert.deepEqual(t.shiori.find('OnChoiceSelect').map(r => r.refs), [['cell1']]);
  assert.equal(t.player.last.script, '\\C\\0\\_q[board 2]\\q[3,cell3]\\*\\e');
  assert.equal(t.balloons.hidden, 0);

  // the guard lifts with the reply: its own choices work; one that plays nothing closes the balloons
  t.player.finish({ hasChoices: true, noChoiceTimeout: true });
  await settle();
  t.clock.t += 1000;
  t.balloons.emit('link', { kind: 'choice', id: 'cell3', label: '3', refs: [], scope: 0 });
  await settle();
  assert.equal(pending.length, 2);
  assert.equal(t.balloons.hidden, 0);
  pending[1].resolve(null);
  await settle();
  assert.deepEqual(t.shiori.find('OnChoiceSelect').map(r => r.refs), [['cell1'], ['cell3']]);
  assert.equal(t.balloons.hidden, 1, 'no reply: the balloons close');
  assert.equal(t.loop.cantalk, true);

  // a URL choice opens the page and closes the balloons
  t.loop.playScript('\\0\\q[site,https://example.com/]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  t.clock.t += 1000;
  t.balloons.emit('link', { kind: 'choice', id: 'https://example.com/', label: 'site', refs: [], scope: 0 });
  await settle();
  assert.deepEqual(t.loop.env.win.opened, ['https://example.com/']);
  assert.equal(t.balloons.hidden, 2);

  // another run started while the selection was pending owns the balloons: they are not closed under it
  t.loop.playScript('\\0\\q[x,cellx]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  t.clock.t += 1000;
  t.balloons.emit('link', { kind: 'choice', id: 'cellx', label: 'x', refs: [], scope: 0 });
  await settle();
  t.loop.playScript('\\0a timer talk\\e', { origin: 'timer' });
  pending[2].resolve(null);
  await settle();
  assert.deepEqual(t.shiori.find('OnChoiceSelect').at(-1).refs, ['cellx']);
  assert.equal(t.balloons.hidden, 2);
  assert.equal(t.player.last.script, '\\0a timer talk\\e');
});

test('a choice clicked while the script still types stops it; the reply plays without the balloons closing first', async () => {
  const t = await booted({ handler: answers({ OnChoiceSelectEx: '\\C\\0 ...and then\\e' }) });
  t.loop.playScript('\\0\\q[stop,s]long talk that keeps typing\\e');
  assert.equal(t.player.busy, true);
  t.balloons.emit('link', { kind: 'choice', id: 's', label: 'stop', refs: [], scope: 0 });
  assert.equal(t.player.interrupts, 1);
  assert.equal(t.player.busy, false);
  await settle();
  assert.deepEqual(t.shiori.find('OnChoiceSelectEx').map(r => r.refs), [['stop', 's']]);
  assert.equal(t.shiori.find('OnChoiceSelect').length, 0);
  assert.equal(t.player.last.script, '\\C\\0 ...and then\\e');
  assert.equal(t.balloons.hidden, 0);
});

test('stage.scriptEnd (yen-e) runs once per run that reached \\e, at once; never for interrupted, failed or re-shown runs', async () => {
  const t = await booted({ handler: answers({ OnDressupChanged: '\\0dress-up reply\\e' }) });
  let ends = 0;
  t.stage.scriptEnd = () => { ends++; };
  t.loop.playScript('\\0a\\e');
  t.player.finish();
  await settle();
  assert.equal(ends, 1);
  await t.clock.advance(15500);              // balloon timeout, OnBalloonTimeout: no second call
  assert.equal(ends, 1);

  // replaced, broken and quit runs never reached \e
  t.loop.playScript('\\0b...');
  t.loop.playScript('\\0c...');
  t.player.interrupt();
  await settle();
  assert.equal(ends, 1);

  // a dress-up reply after \e does not swallow it
  t.loop.playScript('\\0\\![bind,服,夏服,1]\\e');
  t.stage.emit('bind', { scope: 0, id: 4, category: '服', part: '夏服', on: true });
  t.player.finish();
  await settle();
  assert.equal(t.player.last.script, '\\0dress-up reply\\e');
  assert.equal(ends, 2);
  t.player.finish();
  await settle();
  assert.equal(ends, 3);

  // a run that ends while the ghost is minimized still reached \e
  t.loop.minimized = { reason: 'user', scopes: [0, 1] };
  t.loop.playScript('\\0quiet\\e');
  t.player.finish();
  await settle();
  assert.equal(ends, 4);
  t.loop.minimized = null;

  // the player could not start it
  t.player.play = () => { throw new Error('broken'); };
  setLogLevel('silent');
  t.loop.playScript('\\0x\\e');
  await settle();
  setLogLevel('warn');
  delete t.player.play;
  assert.equal(ends, 4);

  // page navigation: a finished run shown again does not end twice; one that was still talking does end
  t.loop._replay({ src: '\\0shown\\e', ip: 3, state: 'finished', hasChoices: false, origin: 'OnTalk', refs: [] });
  t.player.finish();
  await settle();
  assert.equal(ends, 4);
  t.loop._replay({ src: '\\0half\\e', ip: 2, state: 'running', hasChoices: false, origin: 'OnTalk', refs: [] });
  t.player.finish();
  await settle();
  assert.equal(ends, 5);
});

test('C26: right click opens the menu only when OnMouseUp and OnMouseClick are both 204', async () => {
  const mouse = (type, button, extra = {}) => ({ type, scope: 0, x: 10, y: 20, button, wheel: 0, collision: '', device: 'mouse', ...extra });
  let t = await booted();
  t.stage.emit('mouse', mouse('down', 1));
  t.stage.emit('mouse', mouse('up', 1, { click: true }));
  t.stage.emit('mouse', mouse('click', 1));
  await settle();
  assert.deepEqual(t.shiori.ids(), ['GET OnMouseDown', 'GET OnMouseUp', 'GET OnMouseClick']);
  assert.deepEqual(t.shiori.find('OnMouseClick')[0].refs, [10, 20, 0, 0, '', 1, 'mouse']);
  assert.equal(t.menu.opened.length, 1);
  assert.equal(t.menu.opened[0].scope, 0);
  assert.equal(t.menu.opened[0].device, undefined, 'a mouse: SSP\'s rows');

  // a long press (touch): the menu is told, for its touch rows (UI §9.6)
  t = await booted();
  t.stage.emit('mouse', mouse('down', 1, { device: 'touch' }));
  t.stage.emit('mouse', mouse('up', 1, { click: true, device: 'touch' }));
  t.stage.emit('mouse', mouse('click', 1, { device: 'touch' }));
  await settle();
  assert.deepEqual([t.menu.opened.length, t.menu.opened[0].device], [1, 'touch']);

  t = await booted({ handler: answers({ OnMouseClick: '\\0no menu\\e' }) });
  t.stage.emit('mouse', mouse('down', 1));
  t.stage.emit('mouse', mouse('up', 1, { click: true }));
  t.stage.emit('mouse', mouse('click', 1));
  await settle();
  assert.equal(t.menu.opened.length, 0);
  assert.equal(t.player.last.script, '\\0no menu\\e');

  t = await booted({ handler: answers({ OnMouseUp: '\\0up\\e' }) });
  t.stage.emit('mouse', mouse('down', 1));
  t.stage.emit('mouse', mouse('up', 1, { click: true }));
  t.stage.emit('mouse', mouse('click', 1));
  await settle();
  assert.equal(t.shiori.find('OnMouseClick').length, 0);
  assert.equal(t.menu.opened.length, 0);

  // a view that reports no click for the right button still gets the menu
  t = await booted();
  t.stage.emit('mouse', mouse('down', 1));
  t.stage.emit('mouse', mouse('up', 1));
  await t.clock.advance(10);
  assert.equal(t.shiori.find('OnMouseClick').length, 1);
  assert.equal(t.menu.opened.length, 1);
});

test('C31: a right drag: GET OnMouseGesture between OnMouseDown and OnMouseUp, its reply plays, then end; no click, no menu', async () => {
  const mouse = (type, button, extra = {}) => ({ type, scope: 0, x: 10, y: 20, button, wheel: 0, collision: '', device: 'mouse', ...extra });
  const g = (name, extra = {}) => mouse('gesture', 1, {
    name, deg: 180.7, dir: 3, run: 1, wx: 30, wy: 40, wx0: 50, wy0: 40, collision0: 'Skirt', sx0: 7, sy0: 8, ...extra,
  });
  const drag = (t, first = g('left'), d = 'mouse') => {
    t.stage.emit('mouse', mouse('down', 1, { collision: 'Skirt', device: d }));
    t.stage.emit('mouse', first);
    t.stage.emit('mouse', mouse('up', 1, { click: false, device: d }));
    t.stage.emit('mouse', g('end', { deg: 0, dir: -1, wx: 20, device: d }));
  };
  let t = await booted();
  drag(t);
  await settle();
  assert.deepEqual(t.shiori.ids(), ['GET OnMouseDown', 'GET OnMouseGesture', 'GET OnMouseUp', 'GET OnMouseGesture']);
  const [left, end] = t.shiori.find('OnMouseGesture');
  assert.deepEqual(left.refs, [0, '30\x0140', '', '50\x0140', 'Skirt', 'left', 180], 'SendGestureEvent\'s 7 References');
  assert.deepEqual(end.refs, [0, '20\x0140', '', '50\x0140', 'Skirt', 'end', 0]);
  assert.equal(t.menu.opened.length, 0);
  assert.equal(t.shiori.find('OnMouseClick').length, 0);

  // the reply plays (bonsyou rings on 'end', emily4 flips her skirt on 'left')
  t = await booted({ handler: answers({ OnMouseGesture: r => (r.refs[5] === 'left' ? '\\0flip\\e' : null) }) });
  drag(t);
  await settle();
  assert.equal(t.player.last.script, '\\0flip\\e');
  assert.equal(t.player.last.meta.event, 'OnMouseGesture');

  // \t: none of it (C7; SendGestureEvent and OnEXRButtonUp check IsNoInterrupt)
  t = await booted();
  t.player.timeCritical = true;
  drag(t);
  await settle();
  assert.equal(t.shiori.log.length, 0);
});

test('C31: a touch gesture up / down without a Value becomes the wheel: 3 notches, then one per step of that run', async () => {
  const mouse = (type, button, extra = {}) => ({ type, scope: 0, x: 10, y: 20, button, wheel: 0, collision: '', device: 'touch', ...extra });
  const info = (type, name, extra = {}) => mouse(type, 1, {
    name, deg: 90, dir: 1, run: 2, wx: 30, wy: 40, wx0: 30, wy0: 60, collision0: 'Bust', sx0: 7, sy0: 8, ...extra,
  });
  const swipe = (t, first, steps = [info('gesturestep', null), info('gesturestep', null)]) => {
    t.stage.emit('mouse', mouse('down', 1));
    t.stage.emit('mouse', info('gesturestep', null));            // before the gesture: not a wheel yet
    t.stage.emit('mouse', first);
    for (const s of steps) t.stage.emit('mouse', s);
    t.stage.emit('mouse', mouse('up', 1, { click: false }));
  };
  const wheels = t => t.shiori.find('OnMouseWheel').map(r => r.refs);
  let t = await booted();
  swipe(t, info('gesture', 'up'), [info('gesturestep', null), info('gesturestep', null), info('gesturestep', null, { run: 3 })]);
  await settle();
  assert.deepEqual(t.shiori.ids(), ['GET OnMouseDown', 'GET OnMouseGesture', 'GET OnMouseWheel', 'GET OnMouseWheel',
    'GET OnMouseWheel', 'GET OnMouseWheel', 'GET OnMouseWheel', 'GET OnMouseUp']);
  assert.deepEqual(wheels(t)[0], [7, 8, 120, 0, 'Bust', 0, 'touch'], 'at the press point and its collision');
  // down: -120
  t = await booted();
  swipe(t, info('gesture', 'down', { dir: 5, deg: 270 }), [info('gesturestep', null, { dir: 5 })]);
  await settle();
  assert.deepEqual(wheels(t).map(r => r[2]), [-120, -120, -120, -120]);
  // none: an answered gesture, a mouse's, a sideways one
  t = await booted({ handler: answers({ OnMouseGesture: '\\0ok\\e' }) });
  swipe(t, info('gesture', 'up'));
  await settle();
  assert.equal(wheels(t).length, 0);
  t = await booted();
  swipe(t, info('gesture', 'up', { device: 'mouse' }), [info('gesturestep', null, { device: 'mouse' })]);
  await settle();
  assert.equal(wheels(t).length, 0);
  t = await booted();
  swipe(t, info('gesture', 'left', { dir: 3, deg: 180 }));
  await settle();
  assert.equal(wheels(t).length, 0);
});

test('left, middle and double clicks; \\t drops mouse events; one OnMouseMove in flight', async () => {
  const mouse = (type, button, extra = {}) => ({ type, scope: 99, x: 5, y: 6, button, wheel: 0, collision: 'Mclose', device: 'mouse', ...extra });
  let t = await booted();
  t.stage.emit('mouse', mouse('down', 0));
  t.stage.emit('mouse', mouse('up', 0, { click: true }));
  t.stage.emit('mouse', mouse('click', 0));
  t.stage.emit('mouse', mouse('dblclick', 0));
  t.stage.emit('mouse', mouse('up', 0, { click: true }));
  t.stage.emit('mouse', mouse('click', 0));
  await settle();
  // SSP order [L 3948]: the first click completes before the double-click replaces the second press (C11)
  assert.deepEqual(t.shiori.ids(), ['GET OnMouseDown', 'GET OnMouseUp', 'GET OnMouseClick', 'GET OnMouseDoubleClick', 'GET OnMouseUp', 'GET OnMouseClick']);
  assert.deepEqual(t.shiori.find('OnMouseDown')[0].refs, [5, 6, 0, 99, 'Mclose', 0, 'mouse']);

  t = await booted();
  t.stage.emit('mouse', mouse('down', 2));
  await settle();
  t.stage.emit('mouse', mouse('up', 2, { click: true }));
  t.stage.emit('mouse', mouse('click', 2));
  await settle();
  assert.deepEqual(t.shiori.log.map(r => `${r.id}:${r.refs[5]}`),
    ['OnMouseDownEx:middle', 'OnMouseDown:2', 'OnMouseUpEx:middle', 'OnMouseClickEx:middle', 'OnMouseUp:2', 'OnMouseClick:2']);

  t = await booted();
  t.player.timeCritical = true;
  t.stage.emit('mouse', mouse('down', 0));
  t.stage.emit('mouse', mouse('move', 0));
  await settle();
  assert.equal(t.shiori.log.length, 0);

  let hold = null;
  t = await booted({ handler: r => (r.id === 'OnMouseMove' && !hold ? (hold = deferred()).promise : null) });
  for (let x = 1; x <= 3; x++) t.stage.emit('mouse', mouse('move', 0, { x }));
  await settle();
  assert.equal(t.shiori.find('OnMouseMove').length, 1);
  hold.resolve(null);
  await settle();
  assert.deepEqual(t.shiori.find('OnMouseMove').map(r => r.refs[0]), [1, 3]);

  t = await booted();
  t.stage.emit('mouse', { type: 'wheel', scope: 100, x: 1, y: 2, button: 0, wheel: -120, collision: 'P1', device: 'mouse' });
  await settle();
  assert.deepEqual(t.shiori.find('OnMouseWheel')[0].refs, [1, 2, -120, 100, 'P1', 0, 'mouse']);
});

test('timerraise: one-shot, repeat, cancel, replace; persisted with absolute due times', async () => {
  const t = await booted();
  t.loop.timerRaise(1000, '1', 'ぷよ自動落下', ['a']);
  t.loop.timerRaise(400, '0', 'rep', []);
  t.loop.timerRaise(5000, true === false ? '0' : '1', 'cancelme', []);
  t.loop.timerRaise(0, '1', 'cancelme', []);
  t.loop.timerRaise(2000, '1', 'replaced', []);
  t.loop.timerRaise(3000, '1', 'replaced', ['second']);
  t.state.saveNow();
  const saved = t.state.data.timers;
  assert.deepEqual(saved.map(x => x.ev).sort(), ['replaced', 'rep', 'ぷよ自動落下'].sort());
  const fall = saved.find(x => x.ev === 'ぷよ自動落下');
  assert.equal(fall.dueAt, t.clock.now() + 1000);
  assert.equal(fall.repeat, false);
  assert.equal(saved.find(x => x.ev === 'rep').repeat, true);
  await t.clock.advance(1200);
  const fired = t.shiori.find('ぷよ自動落下');
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].refs, ['a']);
  assert.equal(fired[0].headers.SenderType, 'internal,raise');
  assert.equal(t.shiori.find('rep').length, 3);
  await t.clock.advance(4000);
  assert.equal(t.shiori.find('ぷよ自動落下').length, 1);
  assert.equal(t.shiori.find('cancelme').length, 0);
  assert.deepEqual(t.shiori.find('replaced').map(r => r.refs), [['second']]);
  t.loop.timerRaise(0, '1', 'rep', []);
  const n = t.shiori.find('rep').length;
  await t.clock.advance(2000);
  assert.equal(t.shiori.find('rep').length, n);
});

test('a timer reply replaces the running script', async () => {
  const t = await booted({ handler: answers({ tick: '\\0frame 2\\e' }) });
  t.loop.playScript('\\0frame 1\\e');
  t.loop.timerRaise(80, '1', 'tick', []);
  await t.clock.advance(100);
  assert.equal(t.player.last.script, '\\0frame 2\\e');
});

test('post-script timers: balloon 15 s -> OnBalloonTimeout; OnSurfaceRestore 30 s after the end; choices 30 s; hover pauses', async () => {
  let t = await booted();
  t.loop.playScript('\\0hello\\e', { event: 'OnTalk' });   // 21:13:20.000
  t.player.finish();
  await t.clock.advance(14900);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 0);
  const hidden = t.balloons.hidden;
  await t.clock.advance(300);
  assert.deepEqual(t.shiori.find('OnBalloonTimeout').map(r => r.refs), [['\\0hello\\e', '0']]);
  assert.ok(t.balloons.hidden > hidden);
  // counted from the script's end, not from OnBalloonTimeout (EV §3.4): the first tick more than 30 s after it
  await t.clock.advance(14800);              // 21:13:50.000
  assert.equal(t.shiori.find('OnSurfaceRestore').length, 0);
  await t.clock.advance(100);                // the tick at 21:13:50.005
  assert.deepEqual(t.shiori.find('OnSurfaceRestore').map(r => r.refs), [[0, 10]]);

  t = await booted();
  t.loop.playScript('\\0menu\\q[a,b]\\e');
  t.player.finish({ hasChoices: true });
  await t.clock.advance(1100);
  assert.equal(t.loop.cantalk, false, 'an open choice blocks talk');
  assert.equal(t.shiori.find('OnSecondChange').at(-1).method, 'NOTIFY');
  await t.clock.advance(20000);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 0);
  assert.equal(t.shiori.find('OnChoiceTimeout').length, 0);
  await t.clock.advance(9500);
  assert.equal(t.shiori.find('OnChoiceTimeout').length, 1);
  assert.equal(t.loop.cantalk, true);

  // \* (1,419 of Tsubasa's menus) and a choice timeout of 0: the menu stays until the user answers; no balloon
  // timeout either, which would hide it while it still counted as choosing (cantalk stuck at 0)
  for (const [script, opt] of [['\\0menu\\q[a,b]\\*\\e', null], ['\\0menu\\q[a,b]\\e', '0']]) {
    t = await booted();
    t.loop.playScript(script);
    if (opt) t.loop.setOption('choicetimeout', [opt]);
    t.player.finish({ hasChoices: true, noChoiceTimeout: !opt });
    t.balloons.choosing = true;        // the menu is up: Status reads the balloons (EV §1.6)
    const hidden = t.balloons.hidden;
    await t.clock.advance(120000);
    assert.equal(t.shiori.find('OnBalloonTimeout').length, 0, script);
    assert.equal(t.shiori.find('OnChoiceTimeout').length, 0, script);
    assert.equal(t.shiori.find('OnSurfaceRestore').length, 0, script);
    assert.equal(t.balloons.hidden, hidden, 'the menu is still up');
    assert.equal(t.loop.cantalk, false);
    assert.match(t.loop.statusHeader(), /choosing/);
  }

  t = await booted();
  t.loop.playScript('\\0hover me\\e');
  t.player.finish();
  t.balloons.hovered = true;
  await t.clock.advance(30000);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 0);
  t.balloons.hovered = false;
  await t.clock.advance(15500);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 1);

  // \![set,balloontimeout,0]: the balloon stays, and so does the face: OnSurfaceRestore waits for the next script
  // (EV §3.4) [disasm TimerExec 0x4982d9–0x4982fa]
  t = await booted();
  t.loop.playScript('\\0stay\\e');
  t.loop.setOption('balloontimeout', ['0']);
  t.player.finish();
  await t.clock.advance(120000);
  assert.equal(t.shiori.find('OnBalloonTimeout').length, 0);
  assert.equal(t.shiori.find('OnSurfaceRestore').length, 0);
});

test('an open box does not pause the balloon or choice timeout; the box stays open (EV §3.4, ssp.exe)', async () => {
  // ssp.exe 2.9.10: one SetTimer on \0's balloon (StartWaiting 0x5d1b35); CMessageWnd::OnTimer -> DoWaiting reads no
  // box state, and a box is a modeless CInputWnd (CreateInputBox 0x49b1bc–0x49b221) [disasm]
  let t = await booted();
  t.loop.playScript('\\0your name?\\e');
  t.player.finish();
  t.loop.openBox('inputbox', ['name']);
  await settle();
  await t.clock.advance(15300);
  assert.deepEqual(t.shiori.find('OnBalloonTimeout').map(r => r.refs), [['\\0your name?\\e', '0']]);
  assert.match(t.loop.statusHeader(), /opening\(input\)/, 'the box stays open');
  // a choice menu with the communicate box and the runtime's own box (Other percentage…) open
  t = await booted();
  t.loop.playScript('\\0menu\\q[a,b]\\e');
  t.player.finish({ hasChoices: true });
  t.loop.openBox('communicatebox', []);
  Object.defineProperty(t.dialogs, 'anyOpen', { get: () => true });
  await settle();
  await t.clock.advance(30300);
  assert.equal(t.shiori.find('OnChoiceTimeout').length, 1);
  assert.match(t.loop.statusHeader(), /opening\(communicate\)/);
});

test('a menu the runtime hides (iconify) does not count as choosing: ticks are GET again after restore', async () => {
  const t = await booted();
  t.loop.playScript('\\0menu\\q[a,b]\\*\\e');
  t.player.finish({ hasChoices: true, noChoiceTimeout: true });
  await settle();
  assert.equal(t.loop.cantalk, false);
  await t.loop.minimize('user');
  await t.loop.restore();
  assert.equal(t.loop.choicesLive, false);
  assert.equal(t.loop.cantalk, true);
  t.shiori.log.length = 0;
  await t.clock.advance(1100);
  assert.equal(t.shiori.find('OnSecondChange').at(-1).method, 'GET');
  assert.equal(t.shiori.find('OnSecondChange').at(-1).headers.Status, undefined);
});

test('balloon double-click: OnBalloonBreak with the character offset while talking, OnBalloonClose after', async () => {
  const t = await booted();
  t.loop.playScript('\\0\\s[0]a long talk\\e', { event: 'OnTalk' });
  t.player.pos = 17;
  t.balloons.emit('dblclick', { scope: 1 });
  await settle();
  assert.deepEqual(t.shiori.find('OnBalloonBreak').map(r => r.refs), [['\\0\\s[0]a long talk\\e', 1, 17]]);
  assert.equal(t.player.busy, false);
  t.loop.playScript('\\0short\\e');
  t.player.finish();
  await settle();
  t.clock.t += 1000;
  t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  assert.deepEqual(t.shiori.find('OnBalloonClose').map(r => r.refs), [['\\0short\\e']]);
});

test('dress-up: OnDressupChanged per change (last one GET), then OnNotifyDressupInfo; >100 changes skip the first', async () => {
  let t = await booted();
  t.loop.playScript('\\0\\![bind,服,夏服,1]\\e');
  t.stage.emit('bind', { scope: 0, id: 3, category: '服', part: '冬服', on: false });
  t.stage.emit('bind', { scope: 0, id: 4, category: '服', part: '夏服', on: true });
  t.player.finish();
  await settle();
  const ev = t.shiori.log.filter(r => /Dressup/.test(r.id)).map(r => [r.method, r.id, r.refs]);
  assert.deepEqual(ev, [
    ['NOTIFY', 'OnDressupChanged', [0, '冬服', 0, '服', 'script']],
    ['GET', 'OnDressupChanged', [0, '夏服', 1, '服', 'script']],
    ['GET', 'OnNotifyDressupInfo', t.stage.info],
  ]);

  t = await booted();
  t.loop.playScript('\\p[100]...');
  for (let i = 0; i < 101; i++) t.stage.emit('bind', { scope: 100, id: i, category: `P${i}`, part: 'm1', on: true });
  t.player.finish();
  await settle();
  assert.equal(t.shiori.find('OnDressupChanged').length, 0);
  assert.equal(t.shiori.find('OnNotifyDressupInfo', 'GET').length, 1);
});

test('dress-up: a \\![timerraise] set after a \\![bind] fires after that bind\'s OnNotifyDressupInfo (Tsubasa\'s menu redraw)', async () => {
  // Tsubasa: `\![bind,髪,ポニーテール,1]` then `\![timerraise,1,1,頭着せ替えメニュー]`; the redraw frames the part
  // OnNotifyDressupInfo told her she wears, so it must come after it, as in ssp.exe [observed]
  const slow = deferred();
  const order = r => `${r.method} ${r.id}`;
  let t = await booted({ handler: answers({ OnDressupChanged: () => slow.promise, Redraw: '\\0menu\\e' }) });
  t.loop.playScript('\\0\\![bind,髪,ポニーテール,1]\\n\\![timerraise,1,1,Redraw]');
  t.stage.emit('bind', { scope: 0, id: 0, category: '髪', part: 'ポニーテール', on: true });
  t.loop.timerRaise(1, '1', 'Redraw', []);             // 1 ms: SSP's 50 (C8)
  t.player.finish();                                   // the script ends: GET OnDressupChanged, its reply still on its way
  await t.clock.advance(60);                           // the timer comes due meanwhile
  assert.equal(t.shiori.find('Redraw').length, 0, 'the timer waits for the dress-up report');
  slow.resolve(null);
  await settle();
  await t.clock.advance(5);
  assert.deepEqual(t.shiori.log.filter(r => /Dressup|Redraw/.test(r.id)).map(order),
    ['GET OnDressupChanged', 'GET OnNotifyDressupInfo', 'GET Redraw']);
  assert.equal(t.player.last.script, '\\0menu\\e');

  // the timer comes due while the script still plays (its next text or wait ended the bind's lazy block in SSP): the
  // binds so far go out first, as NOTIFY
  t = await booted({ handler: answers({ Redraw: '\\0menu\\e' }) });
  t.loop.playScript('\\0\\![bind,髪,ポニーテール,1]\\w9\\w9 still talking');
  t.stage.emit('bind', { scope: 0, id: 0, category: '髪', part: 'ポニーテール', on: true });
  t.loop.timerRaise(1, '1', 'Redraw', []);
  await t.clock.advance(60);
  assert.deepEqual(t.shiori.log.filter(r => /Dressup|Redraw/.test(r.id)).map(order),
    ['NOTIFY OnDressupChanged', 'NOTIFY OnNotifyDressupInfo', 'GET Redraw']);
  t.player.finish();
  await settle();
  assert.equal(t.shiori.find('OnNotifyDressupInfo').length, 1, 'nothing left to report at the script\'s end');
});

/** FakeStage whose setBind reports like Stage: the changes, off first, with the caller's origin (shell-format.md). */
class BindStage extends FakeStage {
  constructor() { super(); this.calls = []; }
  setBind(scope, id, on, opts = {}) {
    this.calls.push([scope, id, on, opts]);
    const changes = [
      { id: 0, category: '髪', part: 'ポニーテール', on: false },
      { id: 1, category: '髪', part: 'ツインテール', on: true },
    ];
    for (const c of changes) this.emit('bind', { scope, ...c, noEvent: false, ...(opts.origin ? { origin: opts.origin } : {}) });
    return changes;
  }
}

test('Clothes/Dressup ▸ picks are reported at once with R4 user, also while a script plays (EV §4.11)', async () => {
  const stage = new BindStage();
  const t = setup({ handler: answers({ OnDressupChanged: '\\0Twin tails!\\e' }) });
  t.loop.destroy();                                   // rebuild the loop on the binding stage
  const loop = new EventLoop({
    shiori: t.shiori, player: t.player, stage, balloons: t.balloons, dialogs: t.dialogs, ghost: GHOST, state: t.state,
    clock: t.clock, env: { win: null, doc: null }, ghostDescript: new Map([['name', 'Hayama-san Next Door']]),
  });
  await loop.boot({ resume: false });
  loop.playScript('\\0I am still talking about the weather...\\e', { event: 'OnTalk' });
  t.shiori.log.length = 0;
  assert.equal(loop.toggleDressup(0, 1), true);
  assert.deepEqual(stage.calls, [[0, 1, undefined, { origin: 'user' }]], 'a toggle of that one group');
  await settle();
  assert.equal(t.player.plays.at(-2).meta.event, 'OnTalk');
  assert.deepEqual(t.shiori.log.filter(r => /Dressup/.test(r.id)).map(r => [r.method, r.id, r.refs]), [
    ['NOTIFY', 'OnDressupChanged', [0, 'ポニーテール', 0, '髪', 'user']],
    ['GET', 'OnDressupChanged', [0, 'ツインテール', 1, '髪', 'user']],
    ['NOTIFY', 'OnNotifyDressupInfo', stage.info],           // NOTIFY: OnDressupChanged's reply already plays
  ], 'sent before the talking script ended');
  assert.match(t.shiori.find('OnDressupChanged', 'NOTIFY')[0].headers.Status || '', /\btalking\b/);
  assert.equal(t.player.last.script, '\\0Twin tails!\\e', 'her reply plays like any user event');

  // refused (no change, no event) while minimized, passive or induction, or in \t [disasm IsLocked]
  t.player.finish();
  await settle();
  stage.calls.length = 0;
  for (const [on, off] of [
    [() => { loop.ghostLife.passive = true; }, () => { loop.ghostLife.passive = false; }],
    [() => { loop.ghostLife.induction = true; }, () => { loop.ghostLife.induction = false; }],
    [() => { loop.minimized = { reason: 'user', scopes: [0] }; }, () => { loop.minimized = null; }],
    [() => { t.player.timeCritical = true; }, () => { t.player.timeCritical = false; }],
  ]) {
    on();
    assert.equal(loop.toggleDressup(0, 1), false);
    off();
  }
  assert.deepEqual(stage.calls, []);
  loop.destroy();
});

/** A stage with Tsubasa's hair: setBind toggles ツインテール (id 1) like Stage (changes, 'bind' events, info after). */
class HairStage extends FakeStage {
  constructor() {
    super();
    this.worn = new Set([0]);                        // ポニーテール
    this.names = new Map([[0, 'ポニーテール'], [1, 'ツインテール'], [2, 'サイドテール']]);
    this.refresh();
  }
  refresh() { this.info = [...this.names].map(([id, p]) => `0\x01髪\x01${p}\x01\x01${this.worn.has(id) ? 1 : 0}\x01`); }
  bindState() { return { byId: new Map([...this.names.keys()].map(id => [id, {}])) }; }
  setBind(scope, id, on, opts = {}) {
    if (!this.names.has(id)) return [];
    const changes = [];
    const was = this.worn.has(id);
    if (was) { this.worn.delete(id); changes.push({ id, on: false }); } else {
      for (const o of [...this.worn]) { this.worn.delete(o); changes.push({ id: o, on: false }); }
      this.worn.add(id);
      changes.push({ id, on: true });
    }
    this.refresh();
    const out = changes.map(c => ({ ...c, category: '髪', part: this.names.get(c.id) }));
    for (const c of out) this.emit('bind', { scope, ...c, noEvent: false, origin: opts.origin });
    return out;
  }
}

async function hairLoop(handler) {
  const stage = new HairStage();
  const t = setup({ handler });
  t.loop.destroy();
  const loop = new EventLoop({
    shiori: t.shiori, player: t.player, stage, balloons: t.balloons, dialogs: t.dialogs, ghost: GHOST, state: t.state,
    clock: t.clock, env: { win: null, doc: null }, ghostDescript: new Map([['name', 'Hayama-san Next Door']]),
  });
  await loop.boot({ resume: false });
  t.shiori.log.length = 0;
  return { ...t, stage, loop };
}

const dressLog = t => t.shiori.log.filter(r => /Dressup/.test(r.id)).map(r => [r.method, r.id, r.refs]);

test("a pick during a script comes after that script's binds so far (NOTIFY), so the last report is what she wears", async () => {
  const t = await hairLoop(answers({}));
  // the talk switches to twin tails and keeps talking; the visitor unticks them meanwhile
  t.loop.playScript('\\0\\![bind,髪,ツインテール,1]Do you like my hair?\\e', { event: 'OnTalk' });
  t.stage.setBind(0, 1, true);                       // what CharacterView.bind does for the script's tag (no origin)
  const before = t.stage.info.slice();
  t.shiori.log.length = 0;
  assert.equal(t.loop.toggleDressup(0, 1), true);
  await settle();
  assert.deepEqual(dressLog(t), [
    ['NOTIFY', 'OnDressupChanged', [0, 'ポニーテール', 0, '髪', 'script']],
    ['NOTIFY', 'OnDressupChanged', [0, 'ツインテール', 1, '髪', 'script']],
    ['NOTIFY', 'OnNotifyDressupInfo', before],              // the script's block, before the pick
    ['GET', 'OnDressupChanged', [0, 'ツインテール', 0, '髪', 'user']],
    ['GET', 'OnNotifyDressupInfo', t.stage.info],
  ]);
  t.player.finish();
  await settle();
  assert.equal(dressLog(t).length, 5, 'nothing stale is reported at the script\'s end');
  t.loop.destroy();
});

test('a pick that changes no flag (a mustselect default comes back) still sends GET OnNotifyDressupInfo with origin user', async () => {
  const t = await hairLoop(answers({ OnNotifyDressupInfo: '\\0That one stays on.\\e' }));
  t.stage.setBind = function (scope, id, on, opts) { this.calls = (this.calls || 0) + 1; return []; };   // applied, no net change
  assert.equal(t.loop.toggleDressup(0, 0), true);
  await settle();
  assert.deepEqual(t.shiori.ids(), ['GET OnNotifyDressupInfo', 'GET OnTranslate']);
  assert.deepEqual(t.shiori.find('OnNotifyDressupInfo')[0].refs, t.stage.info);
  assert.equal(t.player.last.script, '\\0That one stays on.\\e', 'its reply plays like any user event');
  // an id that names no group: nothing
  t.shiori.log.length = 0;
  assert.equal(t.loop.toggleDressup(0, 99), true);
  await settle();
  assert.deepEqual(t.shiori.log, []);
  // refused picks: nothing either
  t.loop.ghostLife.passive = true;
  assert.equal(t.loop.toggleDressup(0, 0), false);
  t.loop.ghostLife.passive = false;
  await settle();
  assert.deepEqual(t.shiori.log, []);
  t.loop.destroy();
});

test('dress-up events: every off before every on; a part switched on and off again is not reported; 100 changes send none', async () => {
  let t = await booted();
  t.loop.playScript('\\0\\![bind,服,夏服,1]\\![bind,帽子,麦わら,0]\\![bind,猫耳,猫耳,1]\\![bind,猫耳,猫耳,0]\\e');
  t.stage.emit('bind', { scope: 0, id: 5, category: '服', part: '夏服', on: true });
  t.stage.emit('bind', { scope: 0, id: 3, category: '帽子', part: '麦わら', on: false });
  t.stage.emit('bind', { scope: 0, id: 9, category: '猫耳', part: '猫耳', on: true });
  t.stage.emit('bind', { scope: 0, id: 9, category: '猫耳', part: '猫耳', on: false });
  t.player.finish();
  await settle();
  assert.deepEqual(t.shiori.log.filter(r => /Dressup/.test(r.id)).map(r => [r.method, r.id, r.refs]), [
    ['NOTIFY', 'OnDressupChanged', [0, '麦わら', 0, '帽子', 'script']],
    ['GET', 'OnDressupChanged', [0, '夏服', 1, '服', 'script']],
    ['GET', 'OnNotifyDressupInfo', t.stage.info],
  ]);

  t = await booted();
  t.loop.playScript('\\p[100]...');
  for (let i = 0; i < 100; i++) t.stage.emit('bind', { scope: 100, id: i, category: `P${i}`, part: 'm1', on: true });
  t.player.finish();
  await settle();
  assert.equal(t.shiori.find('OnDressupChanged').length, 0, '"jae 0x64": 100 or more changes send no OnDressupChanged');
  assert.equal(t.shiori.find('OnNotifyDressupInfo', 'GET').length, 1);
});

test('shell names, not folder ids: OnBoot R0, OnFirstBoot R7, OnGhostChanged R7, OnNotifySelfInfo R3, installedshellname', async () => {
  const hayato = {
    id: 'hayato', name: 'ハヤト', sakuraName: 'ハヤト', keroName: '', defaultShell: 'master',
    shells: [{ id: 'master', name: 'kinzon_mey' }],
  };
  const make = (o = {}) => {
    const clock = new FakeClock();
    return new EventLoop({
      shiori: new FakeShiori(() => null), player: new FakePlayer(), stage: o.stage || new FakeStage(), balloons: new FakeBalloons(),
      ghost: hayato, state: new StateStore('hayato', { storage: memoryStorage(), clock }), clock, env: { win: null, doc: null },
      ghostDescript: new Map([['name', 'ハヤト'], ['sakura.name', 'ハヤト'], ...(o.descript || [])]),
      paths: { shell: '/ghost/hayato/shell/master/' }, shell: o.shell,
    });
  };
  let loop = make();
  await loop.boot({ resume: false });
  assert.equal(loop.shiori.find('OnBoot')[0].refs[0], 'kinzon_mey');
  assert.equal(loop.shiori.find('OnNotifySelfInfo')[0].refs[3], 'kinzon_mey');
  assert.deepEqual(loop.shiori.find('installedshellname')[0].refs, ['kinzon_mey']);
  loop.destroy();

  loop = make();
  await loop.boot({ resume: false, firstBoot: true });
  const first = loop.shiori.find('OnFirstBoot')[0].refs;
  assert.equal(first.length, 8);
  assert.deepEqual([first[0], first[7]], ['0', 'kinzon_mey']);
  assert.equal(loop.shiori.find('OnBoot')[0].refs[0], 'kinzon_mey');
  loop.destroy();

  loop = make({ shell: { id: 'alt', name: 'Winter' } });     // the runtime names the shell it loaded
  await loop.boot({ resume: false, changed: { sakuraName: 'Tsubasa', name: 'Hayama-san Next Door', path: '/ghost/tsubasa/' } });
  assert.equal(loop.shiori.find('OnGhostChanged')[0].refs[7], 'Winter');
  assert.equal(loop.shiori.find('OnBoot')[0].refs[0], 'Winter');
  assert.equal(loop.shiori.find('OnNotifySelfInfo')[0].refs[3], 'Winter');
  loop.destroy();

  // a shell descript's sakura.name / keroname name the characters while it is current, whatever the ghost's
  // name.allowoverride says (ssp.exe 2.9.9: that key gates only the shell's sakura.name2 / sakura.friend.name [disasm
  // 0x6E5A79–0x6E5C35]); `none` is a name like any other (roommate's shells) [disasm: no compare]
  const stage = new FakeStage();
  stage.shell = { descript: new Map([['sakuraname', 'メイ'], ['kero.name', 'ちび']]) };
  loop = make({ stage });
  await loop.boot({ resume: false });
  assert.deepEqual(loop.shiori.find('OnNotifySelfInfo')[0].refs.slice(1, 4), ['メイ', 'ちび', 'kinzon_mey']);
  assert.deepEqual([loop.envVar('selfname'), loop.envVar('keroname')], ['メイ', 'ちび']);
  loop.destroy();
  for (const v of ['0', 'false']) {
    loop = make({ stage, descript: [['name.allowoverride', v]] });
    await loop.boot({ resume: false });
    assert.deepEqual(loop.shiori.find('OnNotifySelfInfo')[0].refs.slice(1, 3), ['メイ', 'ちび'], v);
    assert.deepEqual([loop.envVar('selfname'), loop.peerInfo().sakuraName], ['メイ', 'メイ'], v);
    loop.destroy();
  }
  const room = new FakeStage();
  room.shell = { descript: new Map([['sakura.name', 'none'], ['kero.name', 'none']]) };
  loop = make({ stage: room, descript: [['name.allowoverrid', '1']] });       // roommate's descripts, her typo too
  await loop.boot({ resume: false });
  assert.deepEqual(loop.shiori.find('OnNotifySelfInfo')[0].refs.slice(1, 3), ['none', 'none']);
  assert.deepEqual([loop.envVar('selfname'), loop.peerInfo().sakuraName, loop.peerInfo().keroName], ['none', 'none', 'none']);
  loop.destroy();
});

test('enableLevel (UI §2.11): 3 in passive mode, 2 in induction mode or minimized, else 0', async () => {
  const t = await booted();
  assert.equal(t.loop.enableLevel, 0);
  t.loop.minimized = { reason: 'user', scopes: [0] };
  assert.equal(t.loop.enableLevel, 2);
  t.loop.minimized = null;
  t.loop.ghostLife.induction = true;
  assert.equal(t.loop.enableLevel, 2);
  t.loop.ghostLife.passive = true;
  assert.equal(t.loop.enableLevel, 3);
  t.loop.destroy();
});

test('passive and induction are one mode (SPGhost+0x41a8) [disasm 0x62f43a, 0x62f484, 0x630513, 0x63055d]', async () => {
  const t = await booted();
  const life = () => [t.loop.ghostLife.passive, t.loop.ghostLife.induction];
  t.loop.setOption('enter', ['passivemode']);
  assert.deepEqual(life(), [true, false]);
  assert.equal(t.loop.statusHeader(), 'passive');
  assert.equal(t.loop.enableLevel, 3);
  t.player.timeCritical = true;
  assert.equal(t.loop.statusHeader(), 'passive', 'timecritical only when neither mode is on [disasm 0x639ba4]');
  t.loop.setOption('enter', ['inductionmode']);
  assert.deepEqual(life(), [false, true], 'entering one mode leaves the other');
  assert.equal(t.loop.statusHeader(), 'induction');
  assert.equal(t.loop.enableLevel, 2);
  t.loop.setOption('leave', ['passivemode']);
  assert.deepEqual(life(), [false, false], 'leaving either leaves both');
  assert.equal(t.loop.statusHeader(), 'timecritical');
  t.player.timeCritical = false;
  assert.equal(t.loop.statusHeader(), '');
  assert.equal(t.loop.cantalk, true);
  // the runtime's own \![set,passivemode|inductionmode] keeps the one slot too
  t.loop.setOption('inductionmode', ['1']);
  t.loop.setOption('passivemode', ['0']);
  assert.deepEqual(life(), [false, true], 'turning off the other mode changes nothing');
  t.loop.setOption('passivemode', []);
  assert.deepEqual(life(), [true, false]);
  t.loop.setOption('passivemode', ['0']);
  assert.deepEqual(life(), [false, false]);
  t.loop.destroy();
});

test('Status nouserbreak from the player, after the mode slot [disasm AddStatusText 0x639bce]', async () => {
  const t = await booted();
  t.player.noUserBreak = true;
  assert.equal(t.loop.statusHeader(), 'nouserbreak');
  t.player.timeCritical = true;
  assert.equal(t.loop.statusHeader(), 'timecritical,nouserbreak');
  await t.clock.advance(1100);
  assert.equal(t.shiori.find('OnSecondChange').at(-1).headers.Status, 'timecritical,nouserbreak', 'every request carries it');
  t.player.noUserBreak = false;
  t.player.timeCritical = false;
  assert.equal(t.loop.statusHeader(), '');
  t.loop.destroy();
});

test('Status choosing reads the balloons (a \\q / \\__q item while one is up), not the choice wait [disasm 0x639ad8]', async () => {
  const t = await booted();
  t.loop.playScript('\\0menu\\q[a,b]\\e');
  t.player.finish({ hasChoices: true });
  await settle();
  assert.equal(t.loop.cantalk, false, 'the choice wait still holds talk');
  assert.doesNotMatch(t.loop.statusHeader(), /choosing/, 'no choice item in a balloon that is up');
  t.balloons.choosing = true;
  assert.equal(t.loop.statusHeader(), 'choosing');
  t.loop.playScript('\\C\\0more\\e');
  assert.equal(t.player.busy, true);
  assert.equal(t.loop.statusHeader(), 'talking,choosing', 'while a script plays too');
  t.player.finish();
  t.balloons.choosing = false;
  t.loop.destroy();
});

test('surface changes reach the engine before later requests, coalesced per scope', async () => {
  const t = await booted();
  t.stage.chars.get(0).surfaceId = 5;
  t.stage.emit('surface', { scope: 0, id: 4, width: 100, height: 200 });
  t.stage.emit('surface', { scope: 0, id: 5, width: 100, height: 200 });
  t.loop.raise('天気予報情報取得開始２', []);
  await settle();
  assert.deepEqual(t.shiori.ids(), ['NOTIFY OnSurfaceChange', 'GET 天気予報情報取得開始２']);
  assert.deepEqual(t.shiori.log[0].refs, [5, 10, '0,5,100,200']);
});

test('raise: OnDirectSaoriCall does not wait; other raises wait and their reply replaces the run unless it is stale', async () => {
  let hold = null;
  const t = await booted({ handler: r => (r.id === 'X' ? '\\0from X\\e' : r.id === 'slow' ? (hold = deferred()).promise : null) });
  const p = t.loop.raise('OnDirectSaoriCall', ['set', '喋り間隔', '60'], { waitReply: false });
  assert.equal(await p, null);
  assert.deepEqual(t.shiori.find('OnDirectSaoriCall')[0].refs, ['set', '喋り間隔', '60']);
  t.loop.playScript('\\0before\\![raise,X]after');
  const v = await t.loop.raise('X', [], { waitReply: true });
  assert.equal(v, '\\0from X\\e');
  assert.equal(t.player.last.script, '\\0from X\\e');
  const plays = t.player.plays.length;
  const slow = t.loop.raise('slow', [], { waitReply: true });
  await settle();
  t.loop.playScript('\\0newer\\e');
  hold.resolve('\\0too late\\e');
  await slow;
  await settle();
  assert.equal(t.player.plays.length, plays + 1);
  assert.equal(t.player.last.script, '\\0newer\\e');
  t.loop.raise('N', ['1'], { notify: true });
  await settle();
  assert.equal(t.shiori.find('N')[0].method, 'NOTIFY');
});

test('close: OnCloseAll -> OnClose; both 204 closes at once (OnDestroy, unload, state.closed)', async () => {
  let t = await booted();
  let closed = 0;
  t.loop.on('closed', () => closed++);
  await t.loop.close(0);
  assert.deepEqual(t.shiori.ids(), ['GET OnCloseAll', 'GET OnClose', 'NOTIFY OnDestroy']);
  assert.equal(t.shiori.find('OnCloseAll')[0].headers.BaseID, 'OnClose');
  assert.deepEqual(t.shiori.find('OnClose')[0].refs, ['user', 0, 0]);
  assert.equal(t.shiori.unloaded, true);
  assert.equal(closed, 1);
  assert.equal(t.state.data.closed, true);
  assert.equal(t.loop.tickHandle, null);

  t = await booted({ handler: answers({ OnClose: '\\0Bye\\-' }) });
  await t.loop.close(0);
  assert.equal(t.player.last.script, '\\0Bye\\-');
  assert.equal(t.loop.closed, false, 'waits for \\-');
  t.loop.quit();
  await settle();
  assert.equal(t.loop.closed, true);
  assert.ok(t.shiori.ids().includes('NOTIFY OnDestroy'));
});

test('input boxes: submit -> OnUserInput, timeout -> OnUserInputCancel -> OnUserInput(timeout), \\![close] is silent', async () => {
  const t = await booted();
  t.loop.openBox('inputbox', ['タイプ答え', '12000']);
  await settle();
  const box = t.dialogs.boxes[0];
  assert.equal(box.o.id, 'タイプ答え');
  assert.equal(box.o.timeoutMs, 12000);
  assert.equal(t.loop.cantalk, true, 'an open box leaves talk on: only Status opening(input) (C6)');
  assert.match(t.loop.statusHeader(), /opening\(input\)/);
  box.resolve({ text: null, timedOut: true });
  await settle();
  assert.deepEqual(t.shiori.log.map(r => [r.id, r.refs]), [['OnUserInputCancel', ['タイプ答え', 'timeout']], ['OnUserInput', ['タイプ答え', 'timeout']]]);

  t.shiori.log.length = 0;
  t.loop.openBox('inputbox', ['ユーザ名']);
  await settle();
  t.dialogs.boxes[1].resolve({ text: 'Hana', timedOut: false });
  await settle();
  assert.deepEqual(t.shiori.log.map(r => [r.id, r.refs]), [['OnUserInput', ['ユーザ名', 'Hana', '']]]);

  t.shiori.log.length = 0;
  t.loop.openBox('inputbox', ['短冊２']);
  await settle();
  t.loop.closeBox('inputbox', ['短冊２']);
  await settle();
  assert.equal(t.shiori.log.length, 0);
  assert.deepEqual(t.dialogs.closed, ['短冊２']);

  t.loop.openBox('communicatebox', []);
  await settle();
  t.dialogs.boxes.at(-1).resolve('tea');
  await settle();
  assert.deepEqual(t.shiori.log.map(r => [r.id, r.refs]), [['OnCommunicate', ['user', 'tea']]]);
});

test('communicate box stays open: every message is an OnCommunicate; × -> OnCommunicateInputCancel; \\![close] is silent', async () => {
  const t = await booted({ handler: answers({ OnCommunicate: r => `\\0You said ${r.refs[1]}\\e` }) });
  t.loop.openBox('communicatebox', []);
  await settle();
  const box = t.dialogs.boxes[0];
  assert.equal(typeof box.o.onSend, 'function', 'the box reports each message while it stays open');
  box.o.onSend('hello');
  await settle();
  box.o.onSend('again');
  await settle();
  assert.deepEqual(t.shiori.find('OnCommunicate').map(r => r.refs), [['user', 'hello'], ['user', 'again']]);
  assert.equal(t.player.last.script, '\\0You said again\\e', 'the replies play while the box is open');
  assert.match(t.loop.statusHeader(), /opening\(communicate\)/, 'still open');
  box.resolve({ text: null, reason: 'cancel' });
  await settle();
  assert.deepEqual(t.shiori.find('OnCommunicateInputCancel').map(r => r.refs), [['', 'cancel']]);
  assert.doesNotMatch(t.loop.statusHeader(), /opening/);
  box.o.onSend('late');
  await settle();
  assert.equal(t.shiori.find('OnCommunicate').length, 2, 'nothing is sent from a closed box');

  t.shiori.log.length = 0;
  t.loop.openBox('communicatebox', []);
  await settle();
  const b2 = t.dialogs.boxes.at(-1);
  t.loop.closeBox('communicatebox', []);
  b2.o.onSend('ignored');
  b2.resolve({ text: null, reason: 'closed' });
  await settle();
  assert.deepEqual(t.shiori.log.map(r => r.id).filter(id => id.startsWith('OnCommunicate')), []);
});

test('teach box (UI §6.3): open -> OnTeachStart; a word -> OnTeach; × -> OnTeachInputCancel; \\![close] is silent', async () => {
  const t = await booted({ handler: answers({ OnTeachStart: '\\0Teach me!\\e', OnTeach: r => `\\0Learned ${r.refs.join('+')}\\e` }) });
  t.loop.openBox('teachbox', []);
  await settle();
  assert.deepEqual(t.dialogs.boxes.map(b => [b.kind, b.o.scope, b.o.defaultText]), [['teach', 0, '']]);
  assert.deepEqual(t.shiori.log.map(r => [r.method, r.id, r.refs]), [['GET', 'OnTeachStart', []], ['GET', 'OnTranslate', ['\\0Teach me!\\e', undefined, 'OnTeachStart', '']]]);
  assert.match(t.shiori.log[0].headers.Status, /opening\(teach\)/, 'sent with the box open');
  assert.equal(t.player.last.script, '\\0Teach me!\\e', 'its reply plays');
  assert.equal(t.loop.cantalk, false, 'its OnTeachStart reply is still talking');
  t.player.finish();
  await settle();
  assert.equal(t.loop.cantalk, true, 'the open teach box alone does not block talk (C6)');
  assert.equal(t.loop.statusHeader(), 'opening(teach)');
  t.dialogs.boxes[0].resolve({ text: 'ねこ', timedOut: false, reason: 'ok' });
  await settle();
  assert.deepEqual(t.shiori.find('OnTeach').map(r => [r.method, r.refs]), [['GET', ['ねこ']]]);
  assert.equal(t.player.last.script, '\\0Learned ねこ\\e');
  assert.equal(t.dialogs.boxes.length, 1, 'a 200 ends the round: no new box');
  assert.doesNotMatch(t.loop.statusHeader(), /opening/);

  // × / Esc
  t.shiori.log.length = 0;
  t.loop.openBox('teachbox', []);
  await settle();
  t.dialogs.boxes.at(-1).resolve({ text: null, timedOut: false, reason: 'cancel' });
  await settle();
  assert.deepEqual(t.shiori.log.filter(r => r.id !== 'OnTranslate').map(r => [r.id, r.refs]),
    [['OnTeachStart', []], ['OnTeachInputCancel', ['', 'cancel']]]);

  // \![close,teachbox]: closed without OnTeachInputCancel; \![close,inputbox,__SYSTEM_ALL_INPUT__] leaves it alone
  t.shiori.log.length = 0;
  t.loop.openBox('teachbox', []);
  t.loop.openBox('inputbox', ['a']);
  await settle();
  t.loop.closeBox('inputbox', ['__SYSTEM_ALL_INPUT__']);
  assert.match(t.loop.statusHeader(), /opening\(teach\)/);
  assert.doesNotMatch(t.loop.statusHeader(), /input/);
  t.loop.closeBox('teachbox', []);
  await settle();
  assert.deepEqual(t.dialogs.closed, ['a', 'teachbox']);
  assert.doesNotMatch(t.loop.statusHeader(), /opening/);
  assert.deepEqual(t.shiori.log.filter(r => r.id.startsWith('OnTeach') || r.id.startsWith('OnUser')).map(r => r.id), ['OnTeachStart']);
  // a second \![open,teachbox] replaces the open one silently and starts again
  t.shiori.log.length = 0;
  t.loop.openBox('teachbox', []);
  await settle();
  const first = t.dialogs.boxes.at(-1);
  t.loop.openBox('teachbox', ['--text=いぬ']);
  await settle();
  assert.equal(t.dialogs.boxes.at(-1).o.defaultText, 'いぬ');
  first.resolve({ text: 'late', timedOut: false, reason: 'ok' });
  await settle();
  assert.deepEqual(t.shiori.log.filter(r => r.id.startsWith('OnTeach')).map(r => r.id), ['OnTeachStart', 'OnTeachStart']);
});

test('teach box: 311 Not Enough asks again with the words so far, 312 Advice drops the newest; a page change keeps them', async () => {
  // the SHIORI wants three words; "huh" is not one (EV §1.2)
  const handler = answers({
    OnTeach: r => {
      if (r.refs.at(-1) === 'huh') return { status: 312, value: '\\0Pardon?\\e' };
      if (r.refs.length < 3) return { status: 311, value: null };
      return `\\0Got ${r.refs.join(',')}\\e`;
    },
  });
  const storage = memoryStorage();
  const clock0 = new FakeClock();
  const t = setup({ handler, state: new StateStore('test', { storage, clock: clock0 }) });
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  t.loop.openBox('teachbox', []);
  await settle();
  t.dialogs.boxes[0].resolve({ text: 'cat', timedOut: false, reason: 'ok' });
  await settle();
  assert.equal(t.dialogs.boxes.length, 2, '311: the box opens again');
  assert.equal(t.player.plays.length, 0, 'nothing to say');
  t.dialogs.boxes[1].resolve({ text: 'huh', timedOut: false, reason: 'ok' });
  await settle();
  assert.equal(t.player.last.script, '\\0Pardon?\\e', 'a 312 Value plays');
  assert.equal(t.dialogs.boxes.length, 3, '312: the box opens again');
  assert.match(t.loop.statusHeader(), /opening\(teach\)/);
  assert.deepEqual(t.shiori.find('OnTeach').map(r => r.refs), [['cat'], ['cat', 'huh']]);
  assert.equal(t.shiori.find('OnTeachStart').length, 1, 'one OnTeachStart per round');

  // the page changes while the box asks for the second word: it comes back with "cat" and no OnTeachStart
  t.state.saveNow();
  t.loop.destroy();
  const t2 = setup({ handler, state: new StateStore('test', { storage, clock: clock0 }) });
  await t2.loop.boot({ resume: true });
  await settle();
  assert.deepEqual(t2.dialogs.boxes.map(b => b.kind), ['teach']);
  assert.equal(t2.shiori.find('OnTeachStart').length, 0);
  t2.dialogs.boxes[0].resolve({ text: 'dog', timedOut: false, reason: 'ok' });
  await settle();
  assert.equal(t2.dialogs.boxes.length, 2, 'still not enough');
  t2.dialogs.boxes[1].resolve({ text: 'cow', timedOut: false, reason: 'ok' });
  await settle();
  assert.deepEqual(t2.shiori.find('OnTeach').map(r => r.refs), [['cat', 'dog'], ['cat', 'dog', 'cow']]);
  assert.equal(t2.player.last.script, '\\0Got cat,dog,cow\\e');
  assert.equal(t2.dialogs.boxes.length, 2, 'the round is over');
  assert.doesNotMatch(t2.loop.statusHeader(), /opening/);

  // a reply that closes the teach box wins over the 311 that asked again
  const t3 = await booted({ handler: answers({ OnTeach: { status: 311, value: '\\0Never mind.\\![close,teachbox]\\e' } }) });
  t3.player.play = (script, meta) => {          // play the reply's tags the way the player would
    if (script.includes('\\![close,teachbox]')) t3.loop.closeBox('teachbox', []);
    return FakePlayer.prototype.play.call(t3.player, script, meta);
  };
  t3.loop.openBox('teachbox', []);
  await settle();
  t3.dialogs.boxes[0].resolve({ text: 'x', timedOut: false, reason: 'ok' });
  await settle();
  assert.equal(t3.player.last.script, '\\0Never mind.\\![close,teachbox]\\e');
  assert.equal(t3.dialogs.boxes.length, 2, 'it had opened again ...');
  assert.deepEqual(t3.dialogs.closed, ['teachbox'], '... and the reply closed it');
  assert.doesNotMatch(t3.loop.statusHeader(), /opening/);
});

test('minimize plays OnWindowStateMinimize first, then hides; restore shows and sends OnWindowStateRestore', async () => {
  const t = await booted();
  let minimized = null;
  t.loop.on('minimized', m => { minimized = m; });
  t.loop.windowState('minimize');
  await settle();
  assert.deepEqual(t.shiori.find('OnWindowStateMinimize')[0].refs, ['script']);
  assert.equal(minimized.reason, 'script');
  assert.equal(t.stage.chars.get(0).shown, false);
  assert.equal(t.loop.cantalk, false);
  assert.match(t.loop.statusHeader(), /minimizing/);
  await t.loop.restore();
  assert.equal(t.stage.chars.get(0).shown, true);
  assert.deepEqual(t.shiori.find('OnWindowStateRestore')[0].refs, ['script']);
});

// ---------------------------------------------------------------- the tray icon (UI §2.6, core/trayicon.js)

/** a ghost root as the loop's `files` (GhostFiles' resolve: any case, the real spelling) */
const iconFiles = paths => ({
  resolve: p => paths.find(x => x.toLowerCase() === String(p).toLowerCase()) || null,
  list: () => paths.slice(),
});
const ICON_FILES = iconFiles(['ghost/master/descript.txt', 'ghost/master/tsubasa.ico', 'ghost/master/IMG/Batt_1.ico', 'root.ico']);

/** console.warn's lines while f runs (log.once warns) */
async function warnings(f) {
  const seen = [];
  const warn = console.warn;
  console.warn = (...a) => { seen.push(a.join(' ')); };
  try { await f(); } finally { console.warn = warn; }
  return seen;
}

test('\\![set,trayicon,path,…] (and tasktrayicon, any trayi… name): the file from the ghost root or ghost/master/, kept for the next minimize [disasm SetTrayIconName 0x61f160]', async () => {
  const t = await booted({ files: ICON_FILES });
  assert.equal(t.loop.trayIcon, null);
  t.loop.setOption('trayicon', ['img\\batt_1.ico', 'tip', '--duration=100', '--runcount=2']);
  assert.equal(t.loop.trayIcon, 'ghost/master/IMG/Batt_1.ico', 'ghost/master/ after the root, its real spelling; tooltip and options unused');
  t.loop.setOption('TaskTrayIcon', ['root.ico']);
  assert.equal(t.loop.trayIcon, 'root.ico', 'the root first');
  // a file that is not there changes nothing (SetTrayIconName returns 0), logged once
  const seen = await warnings(() => { t.loop.setOption('trayicon', ['gone.ico']); t.loop.setOption('trayicon', ['gone.ico']); });
  assert.equal(t.loop.trayIcon, 'root.ico');
  assert.equal(seen.filter(s => /gone\.ico/.test(s)).length, 1);
  assert.ok(!seen.some(s => /is not handled/.test(s)));
  // no path, or an empty one: back to the descript's icon
  t.loop.setOption('trayicon', []);
  assert.equal(t.loop.trayIcon, null);
  t.loop.setOption('trayicon', ['root.ico']);
  t.loop.setOption('trayicon', ['']);
  assert.equal(t.loop.trayIcon, null);
  // the tray balloon is still not handled
  const balloon = await warnings(() => t.loop.setOption('trayballoon', ['x']));
  assert.ok(balloon.some(s => /\\!\[set,trayballoon\] is not handled/.test(s)), balloon.join('|'));
});

test('tray icon: minimize carries the script\'s icon (minimized.icon) and clears the slot; a restore forgets it; a set while minimized updates it and emits \'trayicon\' [disasm ToggleMinimize, LoadTrayIcon]', async () => {
  const t = await booted({ files: ICON_FILES });
  t.loop.setOption('trayicon', ['root.ico']);
  await t.loop.minimize('user');
  assert.deepEqual(t.loop.minimized, { reason: 'user', scopes: t.loop.minimized.scopes, icon: 'root.ico' });
  assert.equal(t.loop.trayIcon, null, 'ReloadTrayIcon(NULL): the script slot is empty');
  t.state.saveNow();
  assert.equal(t.state.data.minimized.icon, 'root.ico', 'stored with the minimized state');
  const seen = [];
  t.loop.on('trayicon', ev => seen.push(ev));
  t.loop.setOption('trayicon', ['img/batt_1.ico']);
  assert.equal(t.loop.minimized.icon, 'ghost/master/IMG/Batt_1.ico');
  assert.deepEqual(seen, [{ icon: 'ghost/master/IMG/Batt_1.ico' }]);
  t.loop.setOption('trayicon', []);
  assert.equal(t.loop.minimized.icon, 'ghost/master/IMG/Batt_1.ico', 'minimized, a reset keeps the icon shown');
  assert.equal(seen.length, 1);
  await t.loop.restore();
  assert.equal(t.loop.minimized, null);
  assert.equal(t.loop.trayIcon, null, 'restored: the descript\'s icon again');
  await t.loop.minimize('user');
  assert.equal('icon' in t.loop.minimized, false, 'no script icon: none recorded (the launcher shows her icon)');
});

test('tray icon: a set during OnWindowStateMinimize\'s talk is the minimized icon; a reset then keeps what was shown', async () => {
  const t = await booted({ files: ICON_FILES });
  const talk = deferred();
  t.shiori.handler = r => (r.id === 'OnWindowStateMinimize' ? talk.promise : null);
  t.loop.setOption('trayicon', ['root.ico']);
  const p = t.loop.minimize('user');
  await settle();
  assert.equal(t.loop.minimizing, true);
  t.loop.setOption('trayicon', []);
  assert.equal(t.loop.trayIcon, 'root.ico', 'minimizing counts as minimized for a reset');
  t.loop.setOption('trayicon', ['img/batt_1.ico']);
  talk.resolve(null);
  await p;
  assert.equal(t.loop.minimized.icon, 'ghost/master/IMG/Batt_1.ico');
});

test('tray icon: a resume keeps the script\'s icon (state trayIcon); a cold boot drops it', async () => {
  const t = await booted({ files: ICON_FILES });
  t.loop.setOption('trayicon', ['root.ico']);
  t.state.saveNow();
  assert.equal(t.state.data.trayIcon, 'root.ico');
  const st = new StateStore('test', { storage: t.state.storage, clock: t.clock });
  const r = setup({ files: ICON_FILES, state: st });
  await r.loop.boot({ resume: true });
  assert.equal(r.loop.trayIcon, 'root.ico', 'a page change is no restart');
  const st2 = new StateStore('test', { storage: t.state.storage, clock: t.clock });
  const c = setup({ files: ICON_FILES, state: st2 });
  await c.loop.boot({ resume: false });
  assert.equal(c.loop.trayIcon, null);
  assert.equal(st2.data.trayIcon, null);
});

test('propRecord: `icon` is ghosts.json\'s (the file that exists, root first), site-absolute; none: the property fails', async () => {
  const t = setup({ ghost: { ...GHOST, icon: 'ghost/tsubasa/ghost/master/tsubasa.ico' } });
  t.loop.paths = { ...t.loop.paths, site: '/s/' };
  assert.equal(t.loop.propRecord().icon, '/s/ghost/tsubasa/ghost/master/tsubasa.ico');
  const none = setup();
  none.loop.descript.set('icon', 'tsubasa.ico');
  assert.equal('icon' in none.loop.propRecord(), false, 'the descript alone is no file: SSP checks it exists');
});

test('keys: SSP names, VK, repeat count from 1, modifiers; only while active; never from editable fields', async () => {
  const win = new FakeWindow();
  const t = setup({ win });
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  win.dispatch('keydown', keyEvent('KeyM', 'm', { keyCode: 77 }));
  await settle();
  assert.equal(t.shiori.find('OnKeyPress').length, 0, 'not active yet');
  t.stage.emit('mouse', { type: 'down', scope: 0, x: 1, y: 1, button: 0, collision: '', device: 'mouse' });
  const e1 = keyEvent('ArrowRight', 'ArrowRight', { keyCode: 39 });
  win.dispatch('keydown', e1);
  win.dispatch('keydown', keyEvent('ArrowRight', 'ArrowRight', { keyCode: 39, repeat: true }));
  win.dispatch('keydown', keyEvent('ArrowRight', 'ArrowRight', { keyCode: 39, repeat: true }));
  win.dispatch('keyup', keyEvent('ArrowRight', 'ArrowRight', { keyCode: 39 }));
  win.dispatch('keydown', keyEvent('ArrowRight', 'ArrowRight', { keyCode: 39 }));
  win.dispatch('keydown', keyEvent('Digit1', '!', { keyCode: 49, shift: true }));
  win.dispatch('keydown', keyEvent('KeyA', 'a', { keyCode: 65, target: { nodeType: 1, tagName: 'INPUT', type: 'text' } }));
  win.dispatch('keydown', keyEvent('KeyW', 'w', { keyCode: 87, ctrl: true }));
  await settle();
  assert.deepEqual(t.shiori.find('OnKeyPress').map(r => r.refs), [
    ['right', 39, 1, 0, ''], ['right', 39, 2, 0, ''], ['right', 39, 3, 0, ''], ['right', 39, 1, 0, ''], ['1', 49, 1, 0, 'shift'],
  ]);
  assert.equal(e1.prevented, true);
  t.player.timeCritical = true;
  win.dispatch('keydown', keyEvent('Space', ' ', { keyCode: 32 }));
  await settle();
  assert.equal(t.shiori.find('OnKeyPress').length, 5, '\\t drops keys');
  t.player.timeCritical = false;
  win.dispatch('pointerdown', { composedPath: () => [{ tagName: 'DIV' }], clientX: 0, clientY: 0 });
  win.dispatch('keydown', keyEvent('KeyM', 'm', { keyCode: 77 }));
  await settle();
  assert.equal(t.shiori.find('OnKeyPress').length, 5, 'a click elsewhere deactivates the ghost');

  // Tab to a page link: Enter belongs to the link again (not sent, not prevented)
  const el = (tagName, extra = {}) => ({ nodeType: 1, tagName, ...extra });
  const focusin = target => ({ target, composedPath: () => [target] });
  t.stage.emit('mouse', { type: 'down', scope: 0, x: 1, y: 1, button: 0, collision: '', device: 'mouse' });
  win.dispatch('focusin', focusin(el('BODY')));
  win.dispatch('focusin', { target: el('SUMIKA-ROOT'), composedPath: () => [el('DIV'), el('SUMIKA-ROOT'), el('BODY')] });
  win.dispatch('keydown', keyEvent('KeyM', 'm', { keyCode: 77 }));
  await settle();
  assert.equal(t.shiori.find('OnKeyPress').length, 6, 'focus on the body or inside the runtime keeps the ghost active');
  const link = el('A', { href: 'https://example.com/' });
  win.dispatch('focusin', focusin(link));
  const enter = keyEvent('Enter', 'Enter', { keyCode: 13, target: link });
  win.dispatch('keydown', enter);
  await settle();
  assert.equal(t.shiori.find('OnKeyPress').length, 6, 'focus moved to a page control');
  assert.equal(enter.prevented, false);
  assert.equal(enter.stopped, false);
});

test('keys while a character is carried (Move character window): none reaches the ghost, Escape keeps it active', async () => {
  const win = new FakeWindow();
  const t = setup({ win });
  await t.loop.boot({ resume: false });
  t.stage.emit('mouse', { type: 'down', scope: 0, x: 1, y: 1, button: 2, collision: '', device: 'mouse' });   // a right-click
  await settle();
  t.shiori.log.length = 0;
  // the carry's window capture listener comes after the loop's (Stage._carryDom adds it when the carry starts)
  t.stage.carrying = true;
  let cancelled = 0;
  win.addEventListener('keydown', e => {
    if (e.key === 'Escape' && t.stage.carrying) { e.preventDefault(); e.stopPropagation(); t.stage.carrying = false; cancelled++; }
  }, true);
  const c = keyEvent('KeyC', 'c', { keyCode: 67 });
  win.dispatch('keydown', c);
  win.dispatch('keydown', keyEvent('Escape', 'Escape', { keyCode: 27 }));
  await settle();
  assert.equal(cancelled, 1, 'Escape cancels the carry');
  assert.deepEqual(t.shiori.find('OnKeyPress'), [], 'the ghost hears no key of the carry');
  assert.equal(c.prevented, false, 'a key the ghost does not get stays the page\'s');
  assert.equal(t.loop.active, true, 'the keyboard stays with the ghost after the carry');
  win.dispatch('keydown', keyEvent('KeyC', 'c', { keyCode: 67 }));
  await settle();
  assert.deepEqual(t.shiori.find('OnKeyPress').map(r => r.refs[0]), ['c'], 'her shortcut keys work again at once');
});

test('keys typed into editable elements never reach the ghost: page fields, web components, our own boxes', async () => {
  const win = new FakeWindow();
  const t = setup({ win });
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  t.stage.emit('mouse', { type: 'down', scope: 0, x: 1, y: 1, button: 0, collision: '', device: 'mouse' });
  const el = (tagName, extra = {}) => ({ nodeType: 1, tagName, ...extra });
  const body = el('BODY');
  const html = el('HTML');
  const shadowRoot = { nodeType: 11 };
  const host = el('SUMIKA-ROOT');
  // a key typed into `inner`; shadow DOM retargets `target` to the host, composedPath() starts at the real element
  const typed = (inner, { target = inner, path = [inner, body, html] } = {}) => {
    const e = keyEvent('KeyA', 'a', { keyCode: 65, target });
    e.composedPath = () => path;
    return e;
  };
  const shadowInput = (hostEl, extra = []) => {
    const input = el('INPUT', { type: 'text' });
    return typed(input, { target: hostEl, path: [input, ...extra, shadowRoot, hostEl, body, html] });
  };
  const fields = [
    typed(el('INPUT', { type: 'search' })),
    typed(el('INPUT', { type: 'password' })),
    typed(el('TEXTAREA')),
    typed(el('SELECT')),
    typed(el('DIV', { isContentEditable: true })),
    typed(el('P', { getAttribute: n => (n === 'contenteditable' ? '' : null) })),
    shadowInput(el('MY-EDITOR')),                 // a web component of the page
    shadowInput(host, [el('DIV')]),               // our own input / communicate box
    typed(el('TEXTAREA'), { path: [] }),          // no composed path: the target itself
  ];
  for (const e of fields) win.dispatch('keydown', e);
  await settle();
  assert.equal(t.shiori.find('OnKeyPress').length, 0);
  assert.ok(fields.every(e => !e.prevented && !e.stopped), 'the field keeps its keys');

  // not text fields: a page checkbox, contenteditable="false", the page body
  const keys = [
    typed(el('INPUT', { type: 'checkbox' })),
    typed(el('DIV', { isContentEditable: false, getAttribute: n => (n === 'contenteditable' ? 'false' : null) })),
    typed(body, { path: [body, html] }),
  ];
  for (const e of keys) win.dispatch('keydown', e);
  await settle();
  assert.equal(t.shiori.find('OnKeyPress').length, 3);
  assert.ok(keys.every(e => e.prevented));
});

test('pure helpers: keyName, keyVk, modifiers, statusFlags, cantalk, box args, mouse refs', () => {
  assert.equal(keyName({ code: 'KeyA', key: 'A', shiftKey: true }), 'a');
  assert.equal(keyName({ code: 'Digit5', key: '%', shiftKey: true }), '5');
  assert.equal(keyName({ code: 'Backspace', key: 'Backspace' }), 'back');
  assert.equal(keyName({ code: 'Enter', key: 'Enter' }), 'return');
  assert.equal(keyName({ code: 'Comma', key: ',' }), ',');
  assert.equal(keyName({ code: 'Slash', key: '?', shiftKey: true }), '/');
  assert.equal(keyName({ code: 'Equal', key: '~', shiftKey: true }, new Map([['Equal', '^']])), '^');
  assert.equal(keyName({ code: 'PageUp', key: 'PageUp' }), 'pageup');
  assert.equal(keyName({ code: 'F5', key: 'F5' }), 'f5');
  assert.equal(keyName({ code: 'ShiftLeft', key: 'Shift' }), 'shift-left');
  assert.equal(keyVk({ keyCode: 0 }, 'a'), 65);
  assert.equal(keyVk({ keyCode: 0 }, ','), 188);
  assert.equal(keyVk({ keyCode: 0 }, 'f2'), 113);
  assert.equal(keyModifiers({ shiftKey: true, ctrlKey: true, altKey: true }), 'shift,ctrl,alt');
  assert.equal(keyModifiers({ altKey: true, ctrlKey: true }), 'ctrl,alt');
  assert.equal(statusFlags({}), '');
  assert.equal(statusFlags({ talking: true, timecritical: true, balloons: [[0, 2], [1, 0]] }), 'talking,timecritical,balloon(0=2/1=0)');
  assert.equal(statusFlags({ choosing: true, minimizing: true, opening: ['input', 'communicate'] }), 'choosing,minimizing,opening(input/communicate)');
  // one mode slot: induction or passive, timecritical only when neither [disasm AddStatusText 0x639b5b–0x639bce]
  assert.equal(statusFlags({ induction: true, passive: true, timecritical: true, nouserbreak: true }), 'induction,nouserbreak');
  assert.equal(statusFlags({ passive: true, timecritical: true }), 'passive');
  assert.equal(statusFlags({ timecritical: true, nouserbreak: true }), 'timecritical,nouserbreak');
  const base = { booted: true };
  assert.equal(computeCantalk(base), true);
  for (const k of ['closing', 'talking', 'choosing', 'minimized', 'passive', 'induction', 'hidden', 'frozen']) {
    assert.equal(computeCantalk({ ...base, [k]: true }), false, k);
  }
  assert.equal(computeCantalk({ ...base, anyBoxOpen: true }), true, 'an open box is no part of cantalk (C6, ssp.exe)');
  assert.equal(computeCantalk({}), false);
  assert.deepEqual(parseBoxArgs('inputbox', ['数当て答え', '', '50']), { id: '数当て答え', timeoutMs: 0, text: '50', options: [], refs: [], limit: 0, balloon: null, title: '' });
  const o = parseBoxArgs('inputbox', ['OnX', '--timeout=-1', '--text=hi', '--reference=r1', '--option=noclose']);
  assert.equal(o.id, 'OnX');
  assert.equal(o.timeoutMs, 0);
  assert.equal(o.text, 'hi');
  assert.deepEqual(o.refs, ['r1']);
  assert.deepEqual(o.options, ['noclose']);
  assert.equal(parseBoxArgs('communicatebox', ['hello']).text, 'hello');
  assert.deepEqual(mouseRefs({ type: 'move', x: 3.7, y: 4.2, scope: 1, collision: null }, 0), [3, 4, 0, 1, '', 0, 'mouse']);
  assert.deepEqual(gestureRefs({ scope: 1, wx: -2.5, wy: 7.9, collision: null, wx0: 3, wy0: 4, collision0: 'Face', name: 'circle.cw', deg: 321.9 }),
    [1, '-3\x017', '', '3\x014', 'Face', 'circle.cw', 321]);
  assert.equal(gestureRefs({ name: 'end', deg: 45 })[6], 0);
  assert.equal(minuteKey(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02T03:04');
});

test('state collector: timers, minimized, stage and run with the remaining timeout', async () => {
  const t = await booted();
  t.loop.playScript('\\0menu\\q[a,b]\\e', { event: 'OnMouseDoubleClick', refs: ['1'] });
  t.player.finish({ hasChoices: true });
  await t.clock.advance(5000);
  t.loop.timerRaise(1000, '1', 'X', []);
  t.state.saveNow();
  const d = JSON.parse(t.state.storage.getItem(t.state.key));
  assert.equal(d.v, 1);
  assert.deepEqual(d.stage, { v: 1, scopes: { 0: { surface: 0 } } });
  assert.equal(d.run.src, '\\0menu\\q[a,b]\\e');
  assert.equal(d.run.origin, 'OnMouseDoubleClick');
  assert.ok(d.run.timeoutRemainingMs > 24000 && d.run.timeoutRemainingMs <= 25000, String(d.run.timeoutRemainingMs));
  assert.deepEqual(d.timers.map(x => x.ev), ['X']);
  assert.equal(d.closed, false);
});

test('a finished run is persisted only while its balloon is up', async () => {
  const t = await booted();
  t.loop.playScript('\0hello\e');
  t.state.saveNow();
  assert.equal(t.state.data.run.state, 'running');
  t.player.finish();
  await settle();
  t.state.saveNow();
  assert.equal(t.state.data.run.src, '\0hello\e', 'balloon still up: replay it on the next page');
  await t.clock.advance(15500);
  t.state.saveNow();
  assert.equal(t.state.data.run, null, 'timed out: nothing to show again');
});

// ---------------------------------------------------------------- several ghosts (EV §2.7)

const u = undefined;
const HAYATO = { id: 'hayato', name: 'ハヤト', sakuraName: 'ハヤト', surfaces: [0, -1], shell: 'kinzon_mey' };
const RUDOLF = { id: 'like_a_cat', name: '猫になった日', sakuraName: 'ルドルフ', surfaces: [5, 10], shell: 'master' };

/** The site's handle (EV §2.7): the other ghosts up, how many are on screen, whether a call or change runs. */
function fakePeers(list = [], { count = list.length + 1, busy = false } = {}) {
  return { list, n: count, isBusy: busy, others() { return this.list; }, count() { return this.n; }, busy() { return this.isBusy; } };
}

const bootIds = shiori => shiori.ids().filter(x => /OnBoot|OnFirstBoot|OnGhostCalled|OnGhostChanged/.test(x));
const evIds = shiori => shiori.ids().filter(x => x !== 'GET OnTranslate');

test('boot({called}): GET OnGhostCalled [caller sakura, its script, name, path, u, u, u, own shell] BaseID OnGhostChanged,OnBoot; returns the run', async () => {
  const caller = { sakuraName: 'Tsubasa', name: 'Hayama-san Next Door', path: '/ghost/tsubasa/', script: '\\0Come over\\e' };
  let t = setup({ handler: answers({ OnGhostCalled: '\\0You called?\\e' }) });
  const { run } = await t.loop.boot({ resume: false, called: caller });
  assert.deepEqual(bootIds(t.shiori), ['GET OnGhostCalled']);
  const req = t.shiori.find('OnGhostCalled')[0];
  assert.deepEqual(req.refs, ['Tsubasa', '\\0Come over\\e', 'Hayama-san Next Door', '/ghost/tsubasa/', u, u, u, 'master']);
  assert.equal(req.headers.BaseID, 'OnGhostChanged,OnBoot');
  assert.equal(run, t.loop.current, 'the boot run');
  assert.equal(run.event, 'OnGhostCalled');
  assert.equal(run.script, '\\0You called?\\e');
  t.loop.destroy();

  // 204 -> OnBoot (OnGhostChanged is not tried); OnBoot's run is returned
  t = setup({ handler: answers({ OnBoot: '\\0Hello\\e' }) });
  const b = await t.loop.boot({ resume: false, called: caller });
  assert.deepEqual(bootIds(t.shiori), ['GET OnGhostCalled', 'GET OnBoot']);
  assert.equal(b.run.event, 'OnBoot');
  t.loop.destroy();

  // a ghost never met says its first-boot talk, never its "called" talk [disasm]; nothing played -> null
  t = setup();
  const f = await t.loop.boot({ resume: false, firstBoot: true, called: caller });
  assert.deepEqual(bootIds(t.shiori), ['GET OnFirstBoot', 'GET OnBoot']);
  assert.equal(f.run, null);
  t.loop.destroy();

  // a resume sends no boot event and returns no run
  t = setup();
  assert.deepEqual(await t.loop.boot({ resume: true, called: caller }), { run: null });
  assert.deepEqual(bootIds(t.shiori), []);
  t.loop.destroy();
});

test("'notified' fires right after the NOTIFY batch, before any boot GET; otherghostname lists peers.others(); notifyOthers", async () => {
  const peers = fakePeers([HAYATO, RUDOLF]);
  const t = setup({ peers, handler: answers({ OnBoot: '\\0Hi\\e' }) });
  const seen = [];
  t.loop.on('notified', e => seen.push({ at: t.shiori.log.length, e }));
  await t.loop.boot({ resume: false });
  const ids = t.shiori.ids();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].e, { resume: false });
  assert.equal(ids[seen[0].at - 1], 'NOTIFY hwnd', 'after the last NOTIFY of the batch');
  assert.equal(ids[seen[0].at], 'NOTIFY OnSurfaceChange', 'before the requests that follow it');
  assert.ok(ids.indexOf('GET OnBoot') > seen[0].at);
  assert.deepEqual(t.shiori.find('otherghostname')[0].refs, ['ハヤト\x010\x01-1', 'ルドルフ\x015\x0110']);

  // the site re-NOTIFYs when another ghost comes or goes
  t.shiori.log.length = 0;
  peers.list = [RUDOLF];
  await t.loop.notifyOthers();
  assert.deepEqual(t.shiori.log.map(r => [r.method, r.id, r.refs]), [['NOTIFY', 'otherghostname', ['ルドルフ\x015\x0110']]]);
  peers.list = [];
  await t.loop.notifyOthers();
  assert.deepEqual(t.shiori.log[1].refs, [], 'alone again: no References');
  t.loop.destroy();

  // a resume notifies too (the site counts a resumed ghost as up from the start)
  const r = setup({ peers });
  let resumed = null;
  r.loop.on('notified', e => { resumed = e; });
  await r.loop.boot({ resume: true });
  assert.deepEqual(resumed, { resume: true });
  r.loop.destroy();
});

test('Close among several (EV §2.3): only GET OnClose, no BaseID; no \\-: the ghost stays (C22); \\-: it goes, closed {script}', async () => {
  const peers = fakePeers([HAYATO]);
  const t = await booted({ peers, handler: answers({ OnClose: '\\0Bye\\e' }) });
  let closed = null;
  t.loop.on('closed', e => { closed = e; });
  await t.loop.close(0);
  assert.deepEqual(evIds(t.shiori), ['GET OnClose']);
  const req = t.shiori.find('OnClose')[0];
  assert.deepEqual(req.refs, ['user', 0, 0]);
  assert.equal(req.headers.BaseID, undefined);
  assert.equal(t.loop.closing, 'one');
  assert.equal(t.loop.cantalk, false);
  t.player.finish();
  await settle();
  assert.equal(t.loop.closed, false, 'a goodbye without \\- leaves it standing');
  assert.equal(t.loop.closing, false);
  assert.equal(closed, null);

  t.shiori.handler = answers({ OnClose: '\\0Bye\\-' });
  t.shiori.log.length = 0;
  await t.loop.close(1);
  assert.deepEqual(t.shiori.find('OnClose').map(r => r.refs), [['user', 1, 1]]);
  t.loop.quit();                       // the player reaches \-
  await settle();
  assert.equal(t.loop.closed, true);
  assert.deepEqual(evIds(t.shiori), ['GET OnClose', 'NOTIFY OnDestroy']);
  assert.deepEqual(closed, { script: '\\0Bye\\-' }, 'OnOtherGhostClosed R1: the goodbye');

  // 204: at once, without a script of its own
  const n = await booted({ peers });
  let c2 = null;
  n.loop.on('closed', e => { c2 = e; });
  await n.loop.close(0);
  assert.deepEqual(n.shiori.ids(), ['GET OnClose', 'NOTIFY OnDestroy']);
  assert.deepEqual(c2, { script: '' });
});

test('Quit / the last Close (EV §2.3): OnCloseAll -> OnClose; the ghost goes when the reply ends, \\- or not, or when a newer run ends', async () => {
  let t = await booted({ handler: answers({ OnClose: '\\0Bye\\e' }) });
  let closed = null;
  t.loop.on('closed', e => { closed = e; });
  await t.loop.close(0);
  assert.deepEqual(evIds(t.shiori), ['GET OnCloseAll', 'GET OnClose']);
  assert.equal(t.loop.closing, 'all');
  assert.equal(t.loop.closed, false, 'not before its end');
  t.player.finish();
  await settle();
  assert.equal(t.loop.closed, true, 'closed at the end of its script without \\-');
  assert.deepEqual(closed, { script: '\\0Bye\\e' });
  assert.deepEqual(evIds(t.shiori).slice(2), ['NOTIFY OnDestroy']);
  assert.equal(t.state.data.closed, true);

  // the site's Quit with two on screen: {all: true}; the menu's scope in R1/R2
  t = await booted({ peers: fakePeers([HAYATO]), handler: answers({ OnCloseAll: '\\0See you all\\e' }) });
  await t.loop.close(1, { all: true });
  assert.deepEqual(evIds(t.shiori), ['GET OnCloseAll']);
  assert.deepEqual(t.shiori.log[0].refs, ['user', 1, 1]);
  assert.equal(t.shiori.log[0].headers.BaseID, 'OnClose');
  // a click's reply replaces the goodbye: the ghost goes when that newer run ends [guess]
  t.loop.playScript('\\0Ouch\\e', { event: 'OnMouseDoubleClick' });
  await settle();
  assert.equal(t.loop.closed, false, 'the replaced goodbye does not close it');
  t.player.finish();
  await settle();
  assert.equal(t.loop.closed, true);

  // a balloon break of the goodbye closes it too (the script is over)
  t = await booted({ handler: answers({ OnClose: '\\0Bye\\e' }) });
  await t.loop.close(0);
  t.balloons.emit('dblclick', { scope: 0 });
  await settle();
  assert.equal(t.loop.closed, true);

  // a talk that ends while OnCloseAll is on its way is not the close script
  const hold = deferred();
  t = await booted({ handler: r => (r.id === 'OnCloseAll' ? hold.promise : null) });
  t.loop.playScript('\\0still talking\\e');
  const p = t.loop.close(0);
  await settle();
  t.player.finish();
  await settle();
  assert.equal(t.loop.closed, false);
  hold.resolve('\\0Goodbye\\e');
  await p;
  await settle();
  assert.equal(t.loop.closed, false, 'its goodbye plays');
  assert.equal(t.player.last.script, '\\0Goodbye\\e');
  t.player.finish();
  await settle();
  assert.equal(t.loop.closed, true);

  // a minimized ghost gets its events, the reply dropped, and closes at once [disasm CloseGhostProc 0x4969ef]
  t = await booted({ handler: answers({ OnCloseAll: '\\0x\\e', OnClose: '\\0y\\e' }) });
  t.loop.minimized = { reason: 'user', scopes: [0, 1] };
  const n = t.player.plays.length;
  await t.loop.close(1, { all: true });
  assert.deepEqual(t.shiori.ids(), ['GET OnCloseAll', 'NOTIFY OnDestroy'], 'a script in OnCloseAll\'s reply: no OnClose');
  assert.deepEqual(t.shiori.log[0].refs, ['user', 1, 1]);
  assert.equal(t.shiori.log[0].headers.BaseID, 'OnClose');
  assert.equal(t.player.plays.length, n, 'nothing plays');
  assert.equal(t.loop.closed, true);
});

test('a minimized, minimizing or locked ghost (\\t, passive, induction): the same close events, the reply dropped, closed at once; restore refused meanwhile [disasm CloseGhostProc 0x4969ef, IsLocked 0x6447c0]', async () => {
  const states = [
    ['minimized', t => { t.loop.minimized = { reason: 'user', scopes: [0] }; }],
    ['passive', t => { t.loop.ghostLife.passive = true; }],
    ['induction', t => { t.loop.ghostLife.induction = true; }],
    ['\\t', t => { t.player.timeCritical = true; }],
  ];
  for (const [name, lock] of states) {
    const t = await booted({ handler: answers({ OnClose: '\\0bye\\e' }) });
    let closed = null;
    t.loop.on('closed', e => { closed = e; });
    t.loop.playScript('\\0before\\e');
    await settle();
    lock(t);
    t.shiori.log.length = 0;
    const n = t.player.plays.length;
    await t.loop.close(0, { all: true });
    assert.deepEqual(t.shiori.ids(), ['GET OnCloseAll', 'GET OnClose', 'NOTIFY OnDestroy'], `${name}: no OnTranslate`);
    const req = t.shiori.find('OnClose')[0];
    assert.deepEqual(req.refs, ['user', 0, 0], name);
    assert.equal(req.headers.BaseID, undefined, name);
    assert.equal(t.player.plays.length, n, `${name}: the goodbye does not play`);
    assert.equal(t.loop.closed, true, name);
    assert.deepEqual(closed, { script: '\\0before\\e' }, `${name}: OnOtherGhostClosed R1 = its last script (+0x1884)`);
  }

  // Close of one while another stays: OnClose only; no \- in the dropped reply, yet it goes (no C22 standing)
  let t = await booted({ peers: fakePeers([HAYATO]), handler: answers({ OnClose: '\\0Bye\\e' }) });
  let closed = null;
  t.loop.on('closed', e => { closed = e; });
  t.loop.minimized = { reason: 'user', scopes: [0] };
  await t.loop.close(0);
  assert.deepEqual(t.shiori.ids(), ['GET OnClose', 'NOTIFY OnDestroy']);
  assert.equal(t.shiori.find('OnClose')[0].headers.BaseID, undefined);
  assert.equal(t.loop.closed, true);
  assert.deepEqual(closed, { script: '' }, 'nothing played before: empty');

  // minimizing (OnWindowStateMinimize's talk still playing: SSP's +0x419c is already 1): its talk is cut
  t = await booted({ handler: answers({ OnWindowStateMinimize: '\\0hiding\\e', OnClose: '\\0bye\\e' }) });
  closed = null;
  t.loop.on('closed', e => { closed = e; });
  const p = t.loop.minimize('user');
  await settle();
  assert.equal(t.loop.minimizing, true);
  t.shiori.log.length = 0;
  await t.loop.close(0, { all: true });
  await p;
  assert.deepEqual(t.shiori.ids(), ['GET OnCloseAll', 'GET OnClose', 'NOTIFY OnDestroy']);
  assert.equal(t.loop.closed, true);
  assert.equal(t.loop.minimized, null, 'closed, not minimized after it');
  assert.deepEqual(closed, { script: '\\0hiding\\e' });

  // the launcher's "Show" clicked while the close's events are on their way: nothing (no OnWindowStateRestore)
  const hold = deferred();
  t = await booted({ handler: r => (r.id === 'OnCloseAll' ? hold.promise : null) });
  t.loop.minimized = { reason: 'user', scopes: [0] };
  const q = t.loop.close(0, { all: true });
  await settle();
  await t.loop.restore();
  assert.equal(t.shiori.find('OnWindowStateRestore').length, 0);
  assert.ok(t.loop.minimized, 'still minimized');
  hold.resolve(null);
  await q;
  assert.equal(t.loop.closed, true);
  assert.deepEqual(t.shiori.ids(), ['GET OnCloseAll', 'GET OnClose', 'NOTIFY OnDestroy']);

  // a Close of one whose goodbye has no \- (C22: she stays), Iconify during it: "Show" restores her (only a minimized
  // close's own events refuse it)
  t = await booted({ peers: fakePeers([HAYATO]), handler: answers({ OnClose: '\\0Bye\\e' }) });
  await t.loop.close(0);
  assert.equal(t.loop.closing, 'one');
  await t.loop.minimize('user');
  assert.ok(t.loop.minimized, 'OnWindowStateMinimize 204: minimized at once');
  await t.loop.restore();
  assert.equal(t.loop.minimized, null);
  assert.equal(t.shiori.find('OnWindowStateRestore').length, 1);
});

test('a Quit during a Close upgrades it without a new event; Close and Quit do nothing while a call or change is under way', async () => {
  const peers = fakePeers([HAYATO]);
  let t = await booted({ peers, handler: answers({ OnClose: '\\0Bye\\e' }) });
  await t.loop.close(0);
  await t.loop.close(0, { all: true });
  assert.deepEqual(evIds(t.shiori), ['GET OnClose'], 'no OnCloseAll after the OnClose');
  assert.equal(t.loop.closing, 'all');
  t.player.finish();
  await settle();
  assert.equal(t.loop.closed, true, 'closed at the end of the Close script, without \\-');

  // asked while OnClose is on its way
  const hold = deferred();
  t = await booted({ peers, handler: r => (r.id === 'OnClose' ? hold.promise : null) });
  const p = t.loop.close(0);
  await settle();
  await t.loop.close(0, { all: true });
  hold.resolve('\\0Bye\\e');
  await p;
  await settle();
  t.player.finish();
  await settle();
  assert.equal(t.loop.closed, true);
  assert.equal(t.shiori.find('OnCloseAll').length, 0);

  // busy: nothing at all
  t = await booted({ peers: fakePeers([HAYATO], { busy: true }), handler: answers({ OnClose: '\\0Bye\\-' }) });
  const quits = [];
  t.loop.on('quitall', e => quits.push(e));
  await t.loop.close(0);
  await t.loop.close(0, { all: true });
  t.loop.quitAll(0);
  assert.deepEqual(t.shiori.ids(), []);
  assert.deepEqual(quits, []);
  assert.equal(t.loop.closing, false);
});

test("quitAll: 'quitall' {scope, window} for the site; with nobody listening it is this ghost's Quit", async () => {
  let t = await booted({ peers: fakePeers([HAYATO]) });
  const quits = [];
  t.loop.on('quitall', e => quits.push(e));
  t.loop.quitAll(1);
  t.loop.quitAll(0, 1);           // a menu popupmenu.type redirected: the menu's character, then the clicked one
  assert.deepEqual(quits, [{ scope: 1, window: 1 }, { scope: 0, window: 1 }]);
  assert.deepEqual(t.shiori.ids(), [], 'the site sends the events');

  t = await booted();
  await t.loop.quitAll(0);
  assert.deepEqual(t.shiori.ids(), ['GET OnCloseAll', 'GET OnClose', 'NOTIFY OnDestroy']);
  t = await booted();
  await t.loop.quitAll(1, 0);
  assert.deepEqual(t.shiori.find('OnCloseAll').map(r => r.refs), [['user', 1, 0]], 'R1 the menu\'s, R2 the clicked one');
  assert.deepEqual(t.shiori.find('OnClose').map(r => r.refs), [['user', 1, 0]]);
  t = await booted();
  t.loop.changing = true;
  t.loop.quitAll(0);
  assert.deepEqual(t.shiori.ids(), [], 'not while leaving');
});

test('close(scope, {window}): R1 the menu\'s character, R2 the clicked one, as a menu popupmenu.type redirected sends them [disasm 2.9.10 0x41d503]', async () => {
  let t = await booted();
  await t.loop.close(0, { window: 1 });
  assert.deepEqual(evIds(t.shiori), ['GET OnCloseAll', 'GET OnClose', 'NOTIFY OnDestroy']);
  assert.deepEqual([t.shiori.find('OnCloseAll')[0].refs, t.shiori.find('OnClose')[0].refs], [['user', 0, 1], ['user', 0, 1]]);
  // among several: OnClose alone, the same refs
  t = await booted({ peers: fakePeers([HAYATO]) });
  await t.loop.close(0, { window: 1 });
  assert.deepEqual(evIds(t.shiori), ['GET OnClose', 'NOTIFY OnDestroy']);
  assert.deepEqual(t.shiori.find('OnClose')[0].refs, ['user', 0, 1]);
  // no window: the same scope twice, as before
  t = await booted();
  await t.loop.close(1, { all: true });
  assert.deepEqual(t.shiori.find('OnCloseAll')[0].refs, ['user', 1, 1]);
});

test('ghostCalling: GET OnGhostCalling [callee sakura, manual|automatic, name, path] BaseID OnGhostChanging, SenderType internal', async () => {
  const t = await booted({ handler: answers({ OnGhostCalling: '\\0Come, ハヤト\\e', OnTranslate: r => r.refs[0] + '!' }) });
  const callee = { sakuraName: 'ハヤト', name: 'ハヤト', path: '/ghost/hayato/' };
  const r = await t.loop.ghostCalling(callee);
  const req = t.shiori.find('OnGhostCalling')[0];
  assert.deepEqual(req.refs, ['ハヤト', 'manual', 'ハヤト', '/ghost/hayato/']);
  assert.equal(req.headers.BaseID, 'OnGhostChanging');
  assert.equal(req.headers.SenderType, 'internal');
  assert.deepEqual(r, { script: '\\0Come, ハヤト\\e!' }, 'the reply as played (OnGhostCalled R1)');
  assert.equal(t.player.busy, true, 'resolved once the reply started, not at its end');
  assert.equal(t.player.last.meta.event, 'OnGhostCalling');

  t.shiori.handler = () => null;
  assert.deepEqual(await t.loop.ghostCalling(callee, { reason: 'automatic' }), { script: '' });
  assert.equal(t.shiori.find('OnGhostCalling')[1].refs[1], 'automatic');
  assert.deepEqual(t.shiori.ids().filter(x => /OnClose|OnGhostChanging/.test(x)), [], 'no fallback event');
});

test("callGhost / \\![call,ghost]: 'call' with the playing script; first non-option token; refusals", async () => {
  const t = await booted();
  const calls = [];
  t.loop.on('call', e => calls.push(e));
  const script = '\\0Come\\![call,ghost,Y,--option=Raise-Event]here\\e';
  t.loop.playScript(script);
  assert.equal(t.loop.call('ghost', ['Y', '--option=Raise-Event']), undefined, 'the player never waits for a call');
  assert.deepEqual(calls[0], {
    target: 'Y', byId: false, raiseEvent: true, reason: 'automatic', scope: 0, fromScript: true, script,
  });
  t.loop.call('ghost', ['--option=raise-event', 'Y', 'Z']);
  assert.deepEqual([calls[1].target, calls[1].raiseEvent], ['Y', true], 'the first non-option token');
  t.loop.call('GHOST', [' なと ']);
  assert.deepEqual([calls[2].target, calls[2].raiseEvent, calls[2].reason], ['なと', false, 'automatic']);
  t.loop.call('ghost', ['--option=raise-event']);          // no target: ignored
  t.loop.call('ghost', []);
  setLogLevel('silent');
  t.loop.call('shell', ['x']);                              // not a ghost: logged
  setLogLevel('warn');
  assert.equal(calls.length, 3);
  assert.equal(t.player.interrupts, 0, 'the caller keeps talking');

  // a menu pick
  assert.equal(t.loop.callGhost('hayato', { byId: true, scope: 1 }), true);
  assert.deepEqual(calls[3], {
    target: 'hayato', byId: true, raiseEvent: true, reason: 'manual', scope: 1, fromScript: false, script: '',
  });

  // inside \t a pick is refused, a script's call is not
  t.player.timeCritical = true;
  assert.equal(t.loop.callGhost('hayato', { byId: true }), false);
  t.loop.call('ghost', ['Y']);
  assert.equal(calls.length, 5);
  t.player.timeCritical = false;
  // locked states do not refuse a pick [guess]
  t.loop.ghostLife.passive = true;
  t.loop.minimized = { reason: 'user', scopes: [0] };
  assert.equal(t.loop.callGhost('hayato', { byId: true }), true);
  t.loop.ghostLife.passive = false;
  t.loop.minimized = null;
  assert.equal(calls.length, 6);

  for (const k of ['changing', 'closing', 'frozen', 'closed']) {
    const was = t.loop[k];
    t.loop[k] = k === 'closing' ? 'one' : true;
    assert.equal(t.loop.callGhost('hayato', { byId: true }), false, k);
    t.loop.call('ghost', ['Y']);
    t.loop[k] = was;
  }
  assert.equal(calls.length, 6);
});

test('otherEvent: GET with SenderType internal, the reply cuts the talk; nothing unless peerLive; peerInfo', async () => {
  const t = await booted({ handler: answers({ OnOtherGhostClosed: '\\0See you, ハヤト-san.\\e' }) });
  t.loop.playScript('\\0random talk\\e', { origin: 'tick' });
  const refs = ['ハヤト', '\\0Bye\\-', 'ハヤト', u, u, u, u, 'kinzon_mey'];
  assert.equal(t.loop.peerLive, true);
  assert.deepEqual(await t.loop.otherEvent('OnOtherGhostClosed', refs), { played: true });
  const req = t.shiori.find('OnOtherGhostClosed')[0];
  assert.equal(req.method, 'GET');
  assert.equal(req.headers.SenderType, 'internal');
  assert.deepEqual(req.refs, refs);
  assert.equal(t.player.last.script, '\\0See you, ハヤト-san.\\e');
  assert.equal(t.loop.current.origin, 'user');

  const locks = [
    ['minimized', () => { t.loop.minimized = { reason: 'user', scopes: [0] }; }, () => { t.loop.minimized = null; }],
    ['passive', () => { t.loop.ghostLife.passive = true; }, () => { t.loop.ghostLife.passive = false; }],
    ['induction', () => { t.loop.ghostLife.induction = true; }, () => { t.loop.ghostLife.induction = false; }],
    ['changing', () => { t.loop.changing = true; }, () => { t.loop.changing = false; }],
    ['closing', () => { t.loop.closing = 'one'; }, () => { t.loop.closing = false; }],
    ['\\t', () => { t.player.timeCritical = true; }, () => { t.player.timeCritical = false; }],
  ];
  for (const [name, lock, unlock] of locks) {
    lock();
    assert.equal(t.loop.peerLive, false, name);
    assert.deepEqual(await t.loop.otherEvent('OnOtherGhostBooted', refs), { played: false }, name);
    unlock();
  }
  assert.equal(t.shiori.find('OnOtherGhostBooted').length, 0);
  assert.equal(t.loop.peerLive, true);

  // as the others see her: the shell's sakura name override, the kero name (none), both surfaces, the shell's name
  assert.deepEqual(t.loop.peerInfo(), {
    id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', surfaces: [0, 10], shell: 'master',
  });
  t.stage.shell.descript = new Map([['sakura.name', 'つばさ']]);
  t.stage.chars.get(1).surfaceId = -1;
  assert.deepEqual([t.loop.peerInfo().sakuraName, t.loop.peerInfo().surfaces], ['つばさ', [0, -1]]);
  assert.equal(t.loop.lastScript, '\\0See you, ハヤト-san.\\e');
});

test("keys: 'activate' on a press, a balloon click, a link, a drop; a press on another ghost's layer takes the keys, a menu does not", async () => {
  const win = new FakeWindow();
  const el = (tagName, classes = []) => ({ nodeType: 1, tagName, classList: { contains: c => classes.includes(c) } });
  const layer = el('DIV', ['smk-ghost']);
  const t = await booted({ win, layer });
  const seen = [];
  t.loop.on('activate', e => seen.push(e.scope));
  t.stage.emit('mouse', { type: 'down', scope: 1, x: 1, y: 1, button: 0, collision: '', device: 'mouse' });
  t.balloons.emit('click', { scope: 0 });
  t.balloons.emit('link', { kind: 'anchor', id: 'x', refs: [], scope: 1 });
  t.stage.emit('drop', { scope: 0, files: [{ name: 'a.mp3', size: 3, lastModified: 1, type: 'audio/mpeg' }] });
  await settle();
  assert.deepEqual(seen, [1, 0, 1, 0]);
  assert.equal(t.loop.active, true);
  t.loop.deactivate();
  assert.equal(t.loop.active, false, 'the site hands the keys to another ghost');

  const root = el('SUMIKA-ROOT');
  const down = path => win.dispatch('pointerdown', { composedPath: () => path, clientX: 0, clientY: 0 });
  t.loop.active = true;
  down([el('CANVAS'), layer, root]);
  assert.equal(t.loop.active, true, 'a press on its own character');
  down([el('DIV', ['smk-menu']), root]);
  assert.equal(t.loop.active, true, 'a root-level menu');
  down([el('CANVAS'), el('DIV', ['smk-ghost']), root]);
  assert.equal(t.loop.active, false, "another ghost's character");
  t.shiori.log.length = 0;
  win.dispatch('keydown', keyEvent('KeyM', 'm', { keyCode: 77 }));
  await settle();
  assert.equal(t.shiori.find('OnKeyPress').length, 0);

  // a className string (no classList) works too
  t.loop.active = true;
  down([{ nodeType: 1, tagName: 'DIV', className: 'x smk-ghost' }, root]);
  assert.equal(t.loop.active, false);
});

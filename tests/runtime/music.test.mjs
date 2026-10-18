// Dropped files end to end on the page side (TS §3.4, EV §4.14): stage 'drop' -> GET OnFileDrop2 with pseudo-paths;
// dsaudio and \_v playing them from the DropStore (load is asynchronous, the commands behind it keep their order);
// the music box kept across page navigation (resume only, never after a cold boot).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { PageSaori } from '../../src/core/page-saori.js';
import { DropStore, dropPath } from '../../src/core/drops.js';
import { GhostFiles } from '../../src/core/loader.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, FakeWindow, settle, deferred } from './fakes.mjs';

setLogLevel('silent');

const GHOST = { id: 'tsubasa', name: 'Tsubasa', sakuraName: 'Tsubasa', defaultShell: 'master' };
const files = new GhostFiles('http://site/ghost/tsubasa/', [['ghost/master/se.wav', 5]]);
const file = (name, size = 4, type = '') => new File([new Uint8Array(size)], name, { type, lastModified: 1700000000000 });

class FakeAudio {
  constructor(src) {
    this.src = src; this.paused = true; this.loop = false; this.volume = 1; this.currentTime = 0; this.l = {};
    FakeAudio.all.push(this);
  }
  play() {
    if (FakeAudio.block) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }               // as in HTML: removing src neither pauses nor unloads
  load() { this.loads = (this.loads || 0) + 1; }
  addEventListener(t, f) { this.l[t] = f; }
}
FakeAudio.all = [];

function urls() {
  const u = { live: new Set(), n: 0, createObjectURL() { const s = `blob:t/${++u.n}`; u.live.add(s); return s; }, revokeObjectURL(s) { u.live.delete(s); } };
  return u;
}

function setup({ state, handler = () => null, drops = new DropStore({ URL: urls() }), win = new FakeWindow() } = {}) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const player = new FakePlayer();
  const stage = new FakeStage();
  const st = state || new StateStore('tsubasa', { storage: memoryStorage(), clock });
  const page = new PageSaori({ files, Audio: FakeAudio, win, drops });
  const loop = new EventLoop({
    shiori, player, stage, balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost: GHOST, state: st, clock,
    env: { win: null, doc: null }, audio: page, drops, site: { ghosts: [GHOST], balloons: [] },
  });
  page.host = loop;
  return { clock, shiori, player, stage, state: st, page, loop, drops, win };
}

test('a drop on a character: GET OnFileDrop2 [paths \\x01, scope, MIME types \\x01]; the reply plays', async () => {
  const t = setup({ handler: r => (r.id === 'OnFileDrop2' ? '\\1Music box?\\e' : null) });
  const song = file('Song A.mp3', 8, 'audio/mpeg');
  const pic = file('wall:paper.PNG', 3);
  t.stage.emit('drop', { scope: 1, files: [song, pic], x: 3, y: 4 });
  await settle();
  assert.equal(t.shiori.find('OnFileDrop2').length, 0, 'nothing before boot');
  assert.ok(!t.stage.acceptsDrops, 'characters take no file drags before boot (the runtime holds them)');
  await t.loop.boot({ resume: false });
  assert.equal(t.stage.acceptsDrops, true);
  t.player.timeCritical = true;                      // \t drops only mouse and key events (C7)
  t.stage.emit('drop', { scope: 1, files: [song, pic], x: 3, y: 4 });
  await settle();
  const [req] = t.shiori.find('OnFileDrop2');
  assert.equal(req.method, 'GET');
  const paths = req.refs[0].split('\x01');
  assert.deepEqual(paths, [dropPath(song), dropPath(pic)]);
  assert.match(paths[0], /^C:\\sumika\\drop\\[0-9a-f]{8}\\Song A\.mp3$/);
  assert.match(paths[1], /\\wallpaper\.PNG$/);
  assert.deepEqual(req.refs.slice(1), [1, 'audio/mpeg\x01image/png']);
  assert.equal(t.player.last.script, '\\1Music box?\\e');
  assert.ok(t.drops.has(paths[0]), 'the files are registered for playback');
  // nothing usable dropped: no event
  t.stage.emit('drop', { scope: 0, files: [] });
  t.stage.emit('drop', null);
  await settle();
  assert.equal(t.shiori.find('OnFileDrop2').length, 1);
  await t.loop._quit();
  assert.equal(t.stage.acceptsDrops, false, 'closed: no more drops');
  // no store (tests, other hosts): the same paths, nothing to play
  const plain = setup({ drops: null });
  await plain.loop.boot({ resume: false });
  plain.stage.emit('drop', { scope: 0, files: [song] });
  await settle();
  assert.deepEqual(plain.shiori.find('OnFileDrop2')[0].refs, [dropPath(song), 0, 'audio/mpeg']);
});

test('dsaudio with a dropped file: load is asynchronous, stop/loop/volume/play wait for it in order', async () => {
  const URL = urls();
  const drops = new DropStore({ URL });
  const page = new PageSaori({ files, Audio: FakeAudio, win: new FakeWindow(), drops });
  const [song] = drops.add([file('Song A.mp3', 8)]);
  const n = FakeAudio.all.length;
  // Tsubasa's ＊通常再生: load, stop, loop, volume, play in one go (TS §3.4)
  for (const [cmd, ...args] of [['load', song.path], ['stop'], ['loop', 'enable'], ['volume', '3000'], ['play']]) {
    page.handle({ name: 'dsaudio.dll', cmd, args });
  }
  assert.equal(FakeAudio.all.length, n, 'nothing yet: the file is opened asynchronously');
  assert.deepEqual(page.musicState(), { path: song.path, currentTime: 0, loop: true, volume: 0.3, playing: true },
    'a save meanwhile keeps what the queued commands will do');
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.equal(FakeAudio.all.length, n + 1);
  assert.ok(URL.live.has(a.src), 'an object URL of the stored file');
  assert.deepEqual([a.loop, a.volume, a.paused], [true, 0.3, false]);
  a.currentTime = 12;
  assert.deepEqual(page.musicState(), { path: song.path, currentTime: 12, loop: true, volume: 0.3, playing: true });
  page.handle({ name: 'dsaudio', cmd: 'pause', args: [] });
  assert.equal(page.musicState().playing, false);

  // the next track releases the URL; a path no longer stored plays nothing, and the queue still drains
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['C:\\sumika\\drop\\00000000\\gone.mp3'] });
  page.handle({ name: 'dsaudio', cmd: 'volume', args: ['10000'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  assert.equal(URL.live.has(a.src), false, 'revoked');
  await settle();
  assert.equal(FakeAudio.all.length, n + 1);
  assert.equal(page.music.volume, 1);
  assert.equal(page.musicState(), null);

  // unload while a load is pending: nothing starts, the URL is released
  page.handle({ name: 'dsaudio', cmd: 'load', args: [song.path] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  page.handle({ name: 'dsaudio', cmd: 'unload', args: [] });
  await settle();
  assert.equal(FakeAudio.all.length, n + 1);
  assert.equal(URL.live.size, 0);

  // ghost-folder files stay synchronous
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['se.wav'] });
  assert.equal(FakeAudio.all.at(-1).src, 'http://site/ghost/tsubasa/ghost/master/se.wav');
  page.destroy();
});

test('\\_v / \\![sound] with a dropped file; stop before it opened cancels it', async () => {
  const URL = urls();
  const drops = new DropStore({ URL });
  const page = new PageSaori({ files, Audio: FakeAudio, win: new FakeWindow(), drops });
  const [se] = drops.add([file('ding.wav', 2)]);
  page.sound('play', [se.path]);
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.ok(URL.live.has(a.src));
  assert.equal(a.paused, false);
  a.onended();
  assert.equal(URL.live.size, 0, 'released at the end');
  const n = FakeAudio.all.length;
  page.sound('loop', [se.path]);
  page.sound('stop', [se.path]);
  await settle();
  assert.equal(FakeAudio.all.length, n);
  assert.equal(URL.live.size, 0);
  page.sound('loop', [se.path]);
  await settle();
  page.destroy();
  assert.equal(URL.live.size, 0, 'destroy releases playing sounds');
});

test('page navigation: the music box comes back on resume (position, loop, volume, playing), not after a cold boot', async () => {
  const storage = memoryStorage();
  const be = { m: new Map(), async get(k) { return this.m.get(k); }, async set(k, v) { this.m.set(k, v); return true; }, async delete(k) { this.m.delete(k); } };
  const first = setup({ state: new StateStore('tsubasa', { storage }), drops: new DropStore({ backend: be, URL: urls() }) });
  await first.loop.boot({ resume: false });
  const [song] = first.drops.add([file('Song A.mp3', 8)]);
  await first.drops.whenIdle();
  for (const [cmd, ...args] of [['load', song.path], ['loop', 'enable'], ['volume', '5000'], ['play']]) {
    first.page.handle({ name: 'dsaudio', cmd, args });
  }
  await settle();
  FakeAudio.all.at(-1).currentTime = 42.5;
  first.state.saveNow();                              // pagehide
  assert.deepEqual(JSON.parse(storage.getItem(first.state.key)).music,
    { path: song.path, currentTime: 42.5, loop: true, volume: 0.5, playing: true });
  first.loop.destroy();
  first.page.destroy();

  // the next page of the same tab: a new page, the store read back from IndexedDB; autoplay blocked until a gesture
  FakeAudio.block = true;
  const n = FakeAudio.all.length;
  const second = setup({ state: new StateStore('tsubasa', { storage }), drops: new DropStore({ backend: be, URL: urls() }) });
  second.state.saveNow();                             // a save before boot() must not lose the stored track
  await second.loop.boot({ resume: true });
  await settle();
  const b = FakeAudio.all.at(-1);
  assert.equal(FakeAudio.all.length, n + 1);
  assert.deepEqual([b.currentTime, b.loop, b.volume, b.paused], [42.5, true, 0.5, true]);
  b.currentTime = 0;                                  // a browser that ignored the early seek
  b.l.loadedmetadata();
  assert.equal(b.currentTime, 42.5, 'the position is applied again once the metadata is known');
  assert.equal(second.page.musicState().playing, true, 'still meant to play while autoplay waits');
  FakeAudio.block = false;
  second.win.dispatch('pointerdown', {});
  await settle();
  assert.equal(b.paused, false);
  second.state.saveNow();
  second.loop.destroy();
  second.page.destroy();

  // a cold boot (a new tab, after Close): SSP's music stopped with it
  const third = setup({ state: new StateStore('tsubasa', { storage }), drops: new DropStore({ backend: be, URL: urls() }) });
  const m = FakeAudio.all.length;
  await third.loop.boot({ resume: false });
  await settle();
  assert.equal(FakeAudio.all.length, m);
  third.state.saveNow();
  assert.equal(JSON.parse(storage.getItem(third.state.key)).music, null);

  // closing (\-) forgets it as well
  third.page.handle({ name: 'dsaudio', cmd: 'load', args: ['se.wav'] });
  third.page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await third.loop._quit();
  assert.equal(JSON.parse(storage.getItem(third.state.key)).music, null);
  third.page.destroy();
});

test('mciaudior: its track\'s end is GET OnMAAPlayFinish [the file as loaded, R1] and the reply plays; kept across pages', async () => {
  const storage = memoryStorage();
  const handler = r => (r.id === 'OnMAAPlayFinish' ? '\\0再生終了っ。\\e' : r.id === 'OnMAAPlayLoop' ? '\\0もう一回。\\e' : null);
  const first = setup({ state: new StateStore('tsubasa', { storage }), handler });
  await first.loop.boot({ resume: false });
  // （mciaudior,load,se.wav）（mciaudior,loop）: the stand-in sends the ghost-root path and the ghost's own argument
  for (const [cmd, ...args] of [['load', 'ghost/master/se.wav', 'se.wav'], ['loop', 'enable'], ['play']]) {
    first.page.handle({ name: 'mciaudior.dll', cmd, args });
  }
  await settle();
  const a = FakeAudio.all.at(-1);
  a.onended();                                         // one pass done: it starts over and tells the ghost
  await settle();
  const [lp] = first.shiori.find('OnMAAPlayLoop');
  assert.deepEqual([lp.method, lp.refs], ['GET', ['se.wav', '0']]);
  assert.equal(first.player.last.script, '\\0もう一回。\\e');
  assert.equal(a.paused, false);
  a.currentTime = 7;
  first.state.saveNow();                               // pagehide
  assert.deepEqual(JSON.parse(storage.getItem(first.state.key)).music,
    { path: 'ghost/master/se.wav', currentTime: 7, loop: true, volume: 1, playing: true, owner: 'mciaudior', given: 'se.wav' });
  first.loop.destroy();
  first.page.destroy();

  const second = setup({ state: new StateStore('tsubasa', { storage }), handler });
  await second.loop.boot({ resume: true });
  await settle();
  const b = FakeAudio.all.at(-1);
  assert.deepEqual([b.currentTime, b.loop, b.paused], [7, false, false]);
  second.page.handle({ name: 'mciaudior.dll', cmd: 'loop', args: ['disable'] });
  b.onended();
  await settle();
  const [fin] = second.shiori.find('OnMAAPlayFinish');
  assert.deepEqual([fin.method, fin.refs], ['GET', ['se.wav', '0']], 'R0 as the ghost loaded it, also on the next page');
  assert.equal(second.player.last.script, '\\0再生終了っ。\\e', 'Satori ghosts answer with talk');
  assert.equal(second.shiori.find('OnDSAPlayFinish').length, 0);
  second.loop.destroy();
  second.page.destroy();
});

test('the next track stops the one playing: an element whose src is removed plays on, out of reach of stop/unload', async () => {
  const URL = urls();
  const drops = new DropStore({ URL, locks: null });
  const sent = [];
  const page = new PageSaori({ files, Audio: FakeAudio, win: new FakeWindow(), drops, host: { send: id => sent.push(id) } });
  const [a, b] = drops.add([file('A.mp3', 8), file('B.mp3', 9)]);
  // Tsubasa's ＊通常再生 / Next in playlist mode: load, stop, loop, volume, play; no stop before the load (TS §3.4)
  const choose = p => { for (const [cmd, ...args] of [['load', p], ['stop'], ['loop', 'disable'], ['volume', '8000'], ['play']]) page.handle({ name: 'dsaudio', cmd, args }); };
  const n = FakeAudio.all.length;
  choose(a.path);
  await settle();
  const first = FakeAudio.all.at(-1);
  const firstUrl = first.src;
  assert.equal(first.paused, false);
  choose(b.path);
  assert.deepEqual([first.paused, first.loads, first.onended, URL.live.has(firstUrl)], [true, 1, null, false],
    'paused, unloaded, no OnDSAPlayFinish from it, URL revoked');
  await settle();
  const second = FakeAudio.all.at(-1);
  assert.equal(second.paused, false);
  choose('se.wav');                                    // a ghost-folder file replaces it the same way, at once
  assert.equal(second.paused, true);
  await settle();
  assert.deepEqual(FakeAudio.all.slice(n).map(x => x.paused), [true, true, false], 'one track at a time');
  page.handle({ name: 'dsaudio', cmd: 'unload', args: [] });
  assert.equal(FakeAudio.all.at(-1).paused, true);
  assert.deepEqual(sent, []);
  page.destroy();
});

test('resume: a save while the stored file still opens keeps the track playing', async () => {
  const p = 'C:\\sumika\\drop\\0123abcd\\Song.mp3';
  const music = { path: p, currentTime: 42.5, loop: true, volume: 0.5, playing: true };
  const storage = memoryStorage();
  const before = new StateStore('tsubasa', { storage });
  before.data.music = music;
  before.saveNow();
  const open = deferred();
  const t = setup({ state: new StateStore('tsubasa', { storage }), drops: { open: () => open.promise, add: () => [] } });
  await t.loop.boot({ resume: true });
  assert.deepEqual(t.page.musicState(), music);
  t.state.saveNow();                                   // pagehide before IndexedDB answered
  assert.deepEqual(JSON.parse(storage.getItem(t.state.key)).music, music);
  t.page.handle({ name: 'dsaudio', cmd: 'pause', args: [] });
  assert.equal(t.page.musicState().playing, false, 'a pause queued behind the load counts too');
  t.page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  open.resolve({ url: 'blob:song', release() {} });
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.deepEqual([a.src, a.currentTime, a.paused], ['blob:song', 42.5, false]);
  assert.deepEqual(t.page.musicState(), music);
  t.loop.destroy();
  t.page.destroy();
});

test('a dropped file that never opens: given up after the timeout, the commands behind it run', async () => {
  const late = deferred();
  let released = 0;
  // 250 ms: settle() alone took over 20 ms on a busy machine (the whole suite in parallel), so the timeout fired first
  const page = new PageSaori({ files, Audio: FakeAudio, win: new FakeWindow(), drops: { open: () => late.promise }, openTimeoutMs: 250 });
  const n = FakeAudio.all.length;
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['C:\\sumika\\drop\\0123abcd\\Hung.mp3'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['se.wav'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await settle();
  assert.equal(FakeAudio.all.length, n, 'still waiting');
  await new Promise(r => setTimeout(r, 300));
  await settle();
  assert.equal(FakeAudio.all.length, n + 1);
  const a = FakeAudio.all.at(-1);
  assert.deepEqual([a.src, a.paused], ['http://site/ghost/tsubasa/ghost/master/se.wav', false]);
  late.resolve({ url: 'blob:late', release: () => released++ });
  await settle();
  assert.equal(released, 1, 'opened too late: released at once');
  assert.equal(FakeAudio.all.length, n + 1);
  page.destroy();
});

test('warnings name dropped files by id and extension only (host pages may collect console output)', async () => {
  const seen = [];
  const warn = console.warn;
  console.warn = (...a) => seen.push(a.map(String).join(' '));
  setLogLevel('warn');
  try {
    class Unplayable extends FakeAudio { play() { return Promise.reject(Object.assign(new Error('no MIDI'), { name: 'NotSupportedError' })); } }
    const drops = new DropStore({ URL: urls(), locks: null });
    const page = new PageSaori({ files, Audio: Unplayable, win: new FakeWindow(), drops });
    const [mid] = drops.add([file('Private voice memo.mid', 4)]);
    page.handle({ name: 'dsaudio', cmd: 'load', args: [mid.path] });
    page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
    page.handle({ name: 'dsaudio', cmd: 'load', args: ['C:\\sumika\\drop\\00000000\\Another private name.mp3'] });
    page.sound('play', ['C:\\sumika\\drop\\00000001\\Secret sound.wav']);
    await settle();
    page.destroy();
  } finally {
    console.warn = warn;
    setLogLevel('silent');
  }
  assert.equal(seen.length, 3, seen.join('\n'));
  assert.ok(seen.every(s => !/Private|Another|Secret/.test(s)), seen.join('\n'));
  assert.ok(seen.some(s => /dropped file [0-9a-f]{8} \(\.mid\)/.test(s)), seen.join('\n'));
});

test('sound events through the event loop (EV §4.17): GET OnSoundStop, SenderType internal, the reply plays; minimized: sent, not played; closed: not sent', async () => {
  const t = setup({ handler: r => (r.id === 'OnSoundStop' ? '\\0鳴り終わった。\\e' : r.id === 'OnSoundLoop' ? '\\0もう一回。\\e' : null) });
  t.page.sound('play', ['se.wav']);
  FakeAudio.all.at(-1).onended();
  await settle();
  assert.deepEqual(t.shiori.find('OnSoundStop'), [], 'nothing before boot');
  await t.loop.boot({ resume: false });
  t.page.sound('play', ['se.wav']);
  await settle();
  FakeAudio.all.at(-1).onended();
  await settle();
  const [ev] = t.shiori.find('OnSoundStop');
  assert.deepEqual([ev.method, ev.refs, ev.headers.SenderType], ['GET', ['se.wav', 'end'], 'internal']);
  assert.equal(t.player.last.script, '\\0鳴り終わった。\\e', 'the reply plays');
  t.page.sound('loop', ['se.wav']);
  await settle();
  FakeAudio.all.at(-1).onended();
  await settle();
  assert.deepEqual(t.shiori.find('OnSoundLoop').map(r => [r.method, r.refs]), [['GET', ['se.wav']]]);
  assert.equal(t.player.last.script, '\\0もう一回。\\e');
  t.page.sound('stop', []);
  t.page.sound('play', ['nothere.wav']);
  await settle();
  assert.deepEqual(t.shiori.find('OnSoundError').map(r => r.refs.slice(0, 3)), [['play', '2', 'nothere.wav']]);

  // minimized: the GET still goes (bonsyou's lock clears), its reply does not play
  t.loop.minimized = { reason: 'user', scopes: [0] };
  const plays = t.player.plays.length;
  t.page.sound('play', ['se.wav']);
  await settle();
  FakeAudio.all.at(-1).onended();
  await settle();
  assert.equal(t.shiori.find('OnSoundStop').length, 2);
  assert.equal(t.player.plays.length, plays);
  t.loop.minimized = null;

  // closed: nothing is sent any more
  t.page.sound('play', ['se.wav']);
  await settle();
  const end = FakeAudio.all.at(-1).onended;
  await t.loop._quit();
  end();
  await settle();
  assert.equal(t.shiori.find('OnSoundStop').length, 2);
  t.page.destroy();
});

test('a dropped file\'s sound: R0 is its pseudo-path; played twice while it opens, one element', async () => {
  const URL = urls();
  const t = setup({ handler: () => null, drops: new DropStore({ URL }) });
  await t.loop.boot({ resume: false });
  const [se] = t.drops.add([file('ding.wav', 2)]);
  const n = FakeAudio.all.length;
  t.page.sound('play', [se.path]);
  t.page.sound('play', [se.path]);
  await settle();
  assert.equal(FakeAudio.all.length, n + 1, 'the second play starts the first over');
  assert.equal(URL.live.size, 1, 'the second URL is released');
  FakeAudio.all.at(-1).onended();
  await settle();
  assert.deepEqual(t.shiori.find('OnSoundStop').map(r => r.refs), [[se.path, 'end']]);
  assert.equal(URL.live.size, 0);
  // a dropped file no longer stored: OnSoundError with its pseudo-path
  t.page.sound('play', ['C:\\sumika\\drop\\00000000\\gone.wav']);
  await settle();
  assert.deepEqual(t.shiori.find('OnSoundError').map(r => r.refs.slice(0, 3)), [['play', '2', 'C:\\sumika\\drop\\00000000\\gone.wav']]);
  await t.loop._quit();
  t.page.destroy();
});

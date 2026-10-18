// src/core/page-saori.js: ghost path resolution and the dsaudio music box with a fake Audio element.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PageSaori, resolveGhostPath, activates } from '../../src/core/page-saori.js';
import { GhostFiles } from '../../src/core/loader.js';
import { settle } from './fakes.mjs';

const files = new GhostFiles('http://site/ghost/tsubasa/', [
  ['ghost/master/music/Song A.mp3', 10], ['ghost/master/se.wav', 5], ['readme.txt', 1],
]);

test('ghost paths: relative, case-insensitive, Windows separators, absolute paths through ghost\\master', () => {
  assert.equal(resolveGhostPath(files, 'music\\song a.MP3'), 'ghost/master/music/Song A.mp3');
  assert.equal(resolveGhostPath(files, '"se.wav"'), 'ghost/master/se.wav');
  assert.equal(resolveGhostPath(files, 'readme.txt'), 'readme.txt');
  assert.equal(resolveGhostPath(files, 'C:\\ssp\\ghost\\tsubasa\\ghost\\master\\music\\Song A.mp3'), 'ghost/master/music/Song A.mp3');
  assert.equal(resolveGhostPath(files, 'C:\\Users\\me\\Music\\other.mp3'), null);
  assert.equal(resolveGhostPath(files, 'http://example.com/a.mp3'), null);
  assert.equal(resolveGhostPath(files, ''), null);
  assert.equal(resolveGhostPath(null, 'x'), null);
});

class FakeAudio {
  constructor(src) { this.src = src; this.paused = true; this.loop = false; this.volume = 1; this.currentTime = 0; FakeAudio.all.push(this); }
  play() { if (FakeAudio.block) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })); this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
}
FakeAudio.all = [];

test('dsaudio: load from the ghost folder, play, volume, loop, stop; end of track raises OnDSAPlayFinish', async () => {
  const sent = [];
  const win = { l: new Map(), addEventListener(t, f) { this.l.set(t, f); }, removeEventListener(t) { this.l.delete(t); } };
  const page = new PageSaori({ files, host: { send: (id, refs) => sent.push([id, refs]) }, Audio: FakeAudio, win });
  page.handle({ name: 'dsaudio.dll', cmd: 'volume', args: ['5000'] });
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['music\\Song A.mp3'] });
  const a = FakeAudio.all.at(-1);
  assert.equal(a.src, 'http://site/ghost/tsubasa/ghost/master/music/Song%20A.mp3');
  assert.equal(a.volume, 0.5);
  page.handle({ name: 'dsaudio', cmd: 'loop', args: ['enable'] });
  assert.equal(a.loop, true);
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await settle();
  assert.equal(a.paused, false);
  page.handle({ name: 'dsaudio', cmd: 'stop', args: [] });
  assert.equal(a.paused, true);
  a.onended();
  assert.equal(sent.length, 0, 'looping tracks do not finish');
  page.handle({ name: 'dsaudio', cmd: 'loop', args: ['disable'] });
  a.onended();
  assert.deepEqual(sent, [['OnDSAPlayFinish', []]]);

  // a file the browser does not have: nothing happens, nothing throws
  const n = FakeAudio.all.length;
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['C:\\Users\\me\\Music\\x.mp3'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  assert.equal(FakeAudio.all.length, n);

  // autoplay blocked: retried on the next gesture
  FakeAudio.block = true;
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['se.wav'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await settle();
  const b = FakeAudio.all.at(-1);
  assert.equal(b.paused, true);
  FakeAudio.block = false;
  win.l.get('pointerdown')();
  await settle();
  assert.equal(b.paused, false);
  page.handle(null);
  page.handle({ name: 'unknown', cmd: 'x' });
  page.destroy();
});

test('mciaudior: the end of a track raises OnMAAPlayFinish [the file as the ghost loaded it, R1], also after a resume', async () => {
  const sent = [];
  const host = { send: (id, refs) => sent.push([id, refs]) };
  const page = new PageSaori({ files, host, Audio: FakeAudio, win: null });
  // the worker stand-in sends the ghost-root path (relative to the DLL's folder) and the ghost's own argument
  page.handle({ name: 'mciaudior.dll', cmd: 'load', args: ['ghost/master/se.wav', '..\\se.wav'] });
  page.handle({ name: 'mciaudior.dll', cmd: 'loop', args: ['disable'] });
  page.handle({ name: 'mciaudior.dll', cmd: 'play', args: [] });
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.equal(a.src, 'http://site/ghost/tsubasa/ghost/master/se.wav');
  assert.equal(a.paused, false);
  const st = page.musicState();
  assert.equal(st.owner, 'mciaudior');
  assert.equal(st.given, '..\\se.wav');
  a.onended();
  assert.deepEqual(sent, [['OnMAAPlayFinish', ['..\\se.wav', '0']]], 'R0 is not resolved: mikaru loads it again');
  assert.equal(page.musicState().playing, false);

  sent.length = 0;
  const next = new PageSaori({ files, host, Audio: FakeAudio, win: null });
  next.resumeMusic({ ...st, playing: true });
  await settle();
  assert.equal(next.musicState().given, '..\\se.wav');
  FakeAudio.all.at(-1).onended();
  assert.deepEqual(sent, [['OnMAAPlayFinish', ['..\\se.wav', '0']]], 'still mciaudior\'s track after a page navigation');
  sent.length = 0;
  next.handle({ name: 'dsaudio', cmd: 'load', args: ['se.wav'] });
  next.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await settle();
  assert.equal(next.musicState().given, undefined, 'a dsaudio track keeps no load argument');
  FakeAudio.all.at(-1).onended();
  assert.deepEqual(sent, [['OnDSAPlayFinish', []]], 'dsaudio\'s own event, never OnMAAPlayFinish');
  page.destroy();
  next.destroy();
});

test('mciaudior loop: the track starts over by hand and raises OnMAAPlayLoop each time; stop ends it quietly', async () => {
  const sent = [];
  const page = new PageSaori({ files, host: { send: (id, refs) => sent.push([id, refs]) }, Audio: FakeAudio, win: null });
  page.handle({ name: 'mciaudior.dll', cmd: 'load', args: ['ghost/master/se.wav', 'se.wav'] });
  page.handle({ name: 'mciaudior.dll', cmd: 'loop', args: ['enable'] });
  page.handle({ name: 'mciaudior.dll', cmd: 'play', args: [] });
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.equal(a.loop, false, 'the element does not loop by itself: its end must be seen');
  assert.equal(page.musicState().loop, true);
  for (let i = 0; i < 2; i++) {
    a.currentTime = 3; a.paused = true;                // the end of the track
    a.onended();
    await settle();
    assert.deepEqual([a.currentTime, a.paused], [0, false], 'playing again from the start');
  }
  assert.deepEqual(sent, [['OnMAAPlayLoop', ['se.wav', '0']], ['OnMAAPlayLoop', ['se.wav', '0']]]);
  assert.equal(page.musicState().playing, true);
  // play (loop disable) on the same track: the next end finishes it
  page.handle({ name: 'mciaudior.dll', cmd: 'loop', args: ['disable'] });
  a.onended();
  assert.deepEqual(sent.at(-1), ['OnMAAPlayFinish', ['se.wav', '0']]);
  // a dsaudio loop is still the element's own (no event per pass)
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['se.wav'] });
  page.handle({ name: 'dsaudio', cmd: 'loop', args: ['enable'] });
  assert.equal(FakeAudio.all.at(-1).loop, true);
  page.destroy();
});

test('mciaudio.dll has no events; numbered MCI players (mciaudior2.dll ...) never reach the music box', async () => {
  const sent = [];
  const page = new PageSaori({ files, host: { send: (id, refs) => sent.push([id, refs]) }, Audio: FakeAudio, win: null });
  page.handle({ name: 'mciaudio.dll', cmd: 'load', args: ['ghost/master/se.wav', 'se.wav'] });
  page.handle({ name: 'mciaudio.dll', cmd: 'play', args: [] });
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.equal(page.musicState().owner, 'mciaudio');
  a.onended();
  assert.deepEqual(sent, [], 'mciaudio.dll (no r) sends nothing');
  // um.nar: BGM on mciaudior, footsteps on mciaudior２-６; a footstep must not touch the BGM
  const n = FakeAudio.all.length;
  for (const cmd of ['load', 'loop', 'play']) page.handle({ name: 'mciaudior2.dll', cmd, args: cmd === 'load' ? ['ghost/master/se.wav'] : ['disable'] });
  assert.equal(FakeAudio.all.length, n);
  assert.equal(page.musicState().owner, 'mciaudio');
  page.destroy();
});

// ---------------------------------------------------------------- \_v / \8 / \![sound] and their events (EV §4.17)

/** A PageSaori whose host is an EventLoop's notifyEvent (GET, SSP's OnNotifyEvent); `sent` lists [id, refs]. */
function soundRig(o = {}) {
  const sent = [];
  const host = { notifyEvent: (id, refs) => (sent.push([id, refs]), Promise.resolve({ status: 204, played: false })) };
  const win = { l: new Map(), addEventListener(t, f) { this.l.set(t, f); }, removeEventListener(t) { this.l.delete(t); } };
  return { sent, win, page: new PageSaori({ files, host, Audio: FakeAudio, win, ...o }) };
}

test('sound: the natural end is OnSoundStop [the file as the tag gave it, end]; stop (named, any case, or all), pause, resume and close say nothing', async () => {
  const { sent, page } = soundRig();
  page.sound('play', ['SE.wav']);
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.deepEqual([a.src, a.paused, a.loop], ['http://site/ghost/tsubasa/ghost/master/se.wav', false, false]);
  a.onended();
  assert.deepEqual(sent, [['OnSoundStop', ['SE.wav', 'end']]], 'R0 as given (bonsyou reads it), not the resolved path');
  assert.equal(page.sounds.size, 0);
  sent.length = 0;

  page.sound('play', ['se.wav']);
  const b = FakeAudio.all.at(-1);
  page.sound('pause', ['SE.WAV']);
  assert.equal(b.paused, true, 'names match in any case');
  page.sound('resume', ['Se.Wav']);
  await settle();
  assert.equal(b.paused, false);
  const late = b.onended;
  page.sound('stop', ['se.WAV']);
  assert.deepEqual([b.paused, b.onended, b.onerror, page.sounds.size], [true, null, null, 0]);
  late();                                              // an `ended` already queued when it was stopped
  page.sound('play', ['se.wav']);
  page.sound('play', ['music\\Song A.mp3']);
  const [c, d] = FakeAudio.all.slice(-2);
  page.sound('stop', []);
  assert.deepEqual([c.paused, d.paused, page.sounds.size], [true, true, 0], 'no file: every sound');
  page.sound('play', ['se.wav']);
  const e = FakeAudio.all.at(-1).onended;
  page.destroy();                                      // the ghost closes or changes
  e();
  assert.deepEqual(sent, []);
});

test('sound: the same file again starts that sound over (one element, the cut play silent, a stale end ignored); two files play side by side', async () => {
  const { sent, page } = soundRig();
  const n = FakeAudio.all.length;
  page.sound('play', ['se.wav']);
  await settle();
  const a = FakeAudio.all.at(-1);
  a.currentTime = 2;
  page.sound('play', ['SE.WAV']);
  await settle();
  assert.equal(FakeAudio.all.length, n + 1, 'no second element');
  assert.deepEqual([a.currentTime, a.paused], [0, false]);
  a.ended = false;                                     // an `ended` of the cut play that arrives after the restart
  a.onended();
  assert.deepEqual(sent, []);
  a.ended = true;
  a.onended();
  assert.deepEqual(sent, [['OnSoundStop', ['se.wav', 'end']]], 'once, with the name the sound was started with');
  sent.length = 0;
  page.sound('play', ['se.wav']);
  page.sound('play', ['music\\Song A.mp3']);
  await settle();
  const [b, c] = FakeAudio.all.slice(-2);
  assert.equal(FakeAudio.all.length, n + 3);
  assert.deepEqual([b.paused, c.paused], [false, false]);
  c.onended();
  b.onended();
  assert.deepEqual(sent, [['OnSoundStop', ['music\\Song A.mp3', 'end']], ['OnSoundStop', ['se.wav', 'end']]]);
  sent.length = 0;
  // a paused sound played again is rewound and stays paused until its resume [disasm 0x725527–0x725536]
  page.sound('play', ['se.wav']);
  await settle();
  const p = FakeAudio.all.at(-1);
  p.currentTime = 2;
  page.sound('pause', ['se.wav']);
  page.sound('loop', ['se.wav']);
  await settle();
  assert.deepEqual([p.currentTime, p.paused, p.__loop], [0, true, true], 'rewound, still paused, the new tag\'s loop');
  page.sound('resume', ['se.wav']);
  await settle();
  assert.equal(p.paused, false);
  page.destroy();
});

test('sound loop: started over by hand at each end with OnSoundLoop [file]; a play of it makes it end once; stop is quiet', async () => {
  const { sent, page } = soundRig();
  page.sound('loop', ['se.wav']);
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.equal(a.loop, false, 'the element does not loop by itself: its end must be seen');
  for (let i = 0; i < 2; i++) {
    a.currentTime = 3; a.paused = true;                // the end of a pass
    a.onended();
    await settle();
    assert.deepEqual([a.currentTime, a.paused], [0, false], 'playing again from the start');
  }
  assert.deepEqual(sent, [['OnSoundLoop', ['se.wav']], ['OnSoundLoop', ['se.wav']]], 'one Reference');
  page.sound('play', ['se.wav']);                      // the new tag's flags: no loop any more
  a.onended();
  assert.deepEqual(sent.at(-1), ['OnSoundStop', ['se.wav', 'end']]);
  assert.equal(page.sounds.size, 0);
  sent.length = 0;
  page.sound('loop', ['se.wav']);
  const late = FakeAudio.all.at(-1).onended;
  page.sound('stop', ['se.wav']);
  late();
  assert.deepEqual(sent, []);
  page.destroy();
});

test('OnSoundError [play, code, file, text]: a file the site lacks, a sound that cannot start (once); not for autoplay, a cut play(), load, or without Audio', async () => {
  const { sent, page, win } = soundRig();
  page.sound('play', ['nothere.wav']);
  page.sound('loop', ['C:\\Users\\me\\x.mp3']);
  assert.deepEqual(sent, [
    ['OnSoundError', ['play', '2', 'nothere.wav', 'The system cannot find the file specified.']],
    ['OnSoundError', ['play', '2', 'C:\\Users\\me\\x.mp3', 'The system cannot find the file specified.']],
  ], 'R0 is `play` for a loop too');
  sent.length = 0;
  page.sound('play', []);                              // no file: ssp.exe plays nothing
  assert.deepEqual(sent, []);

  // the element fails before it ever played: its error and the play() rejection both come, one event
  class Broken extends FakeAudio { play() { return Promise.reject(Object.assign(new Error('no codec'), { name: 'NotSupportedError' })); } }
  const bad = soundRig({ Audio: Broken });
  bad.page.sound('play', ['se.wav']);
  FakeAudio.all.at(-1).onerror();
  await settle();
  assert.deepEqual(bad.sent, [['OnSoundError', ['play', '14020', 'se.wav', 'The byte stream type of the given URL is unsupported.']]]);
  assert.equal(bad.page.sounds.size, 0);
  bad.page.sound('play', ['music\\Song A.mp3']);       // the rejection alone
  await settle();
  assert.deepEqual(bad.sent.at(-1)[1].slice(0, 3), ['play', '14020', 'music\\Song A.mp3']);

  // after it played, an error ends it as a finished sound
  page.sound('play', ['se.wav']);
  await settle();
  FakeAudio.all.at(-1).onerror();
  assert.deepEqual(sent, [['OnSoundStop', ['se.wav', 'end']]]);
  sent.length = 0;

  // autoplay blocked: no error; it plays after the next gesture and then ends as usual
  FakeAudio.block = true;
  page.sound('play', ['se.wav']);
  await settle();
  const z = FakeAudio.all.at(-1);
  assert.deepEqual([z.paused, sent], [true, []]);
  FakeAudio.block = false;
  win.l.get('pointerdown')();
  await settle();
  assert.equal(z.paused, false);
  z.onended();
  assert.deepEqual(sent, [['OnSoundStop', ['se.wav', 'end']]]);

  // a pause that cuts play() short is no failure
  class Cut extends FakeAudio { play() { return Promise.reject(Object.assign(new Error('paused'), { name: 'AbortError' })); } }
  const cut = soundRig({ Audio: Cut });
  cut.page.sound('play', ['se.wav']);
  await settle();
  assert.deepEqual([cut.sent, cut.page.sounds.size], [[], 1]);

  // load and the other sub-commands send nothing; without an Audio constructor (Node, the sweep) nothing either
  sent.length = 0;
  page.sound('load', ['se.wav']);
  page.sound('wait', []);
  const none = soundRig({ Audio: null });
  none.page.sound('play', ['nothere.wav']);
  none.page.sound('play', ['se.wav']);
  assert.deepEqual([sent, none.sent], [[], []]);
  for (const r of [page, bad.page, cut.page, none.page]) r.destroy();
});

test('a host with only send() still hears the sound events', async () => {
  const sent = [];
  const page = new PageSaori({ files, host: { send: (id, refs) => sent.push([id, refs]) }, Audio: FakeAudio, win: null });
  page.sound('play', ['se.wav']);
  await settle();
  FakeAudio.all.at(-1).onended();
  page.sound('play', ['gone.wav']);
  assert.deepEqual(sent.map(s => s[0]), ['OnSoundStop', 'OnSoundError']);
  page.destroy();
});

// ---------------------------------------------------------------- the gesture a blocked play waits for (TS §3.4)

test('activates: the HTML spec\'s activation events: a mouse\'s pointerdown, a touch\'s or pen\'s pointerup, touchend, keydown', () => {
  assert.equal(activates(undefined), true, 'a direct call (the tests)');
  assert.equal(activates({ type: 'pointerdown' }), true, 'no pointerType: counts');
  assert.equal(activates({ type: 'pointerdown', pointerType: 'mouse' }), true);
  for (const t of ['touch', 'pen', '']) {
    assert.equal(activates({ type: 'pointerdown', pointerType: t }), false, `${t || 'unknown'} pointerdown grants no activation`);
    assert.equal(activates({ type: 'pointerup', pointerType: t }), true, `${t || 'unknown'} pointerup`);
  }
  assert.equal(activates({ type: 'pointerup', pointerType: 'mouse' }), false, 'a mouse activates at its pointerdown');
  assert.equal(activates({ type: 'pointerup' }), false);
  assert.equal(activates({ type: 'touchend' }), true);
  assert.equal(activates({ type: 'keydown', key: 'a' }), true);
});

test('afterGesture: a touch\'s pointerdown leaves the retry for the finger\'s lift (pointerup or touchend); a mouse runs it at pointerdown; one run takes every listener away', async () => {
  /** a window with listener sets per type (capture options ignored) */
  const fakeWin = () => {
    const l = new Map();
    return {
      l,
      addEventListener(t, f) { if (!l.has(t)) l.set(t, new Set()); l.get(t).add(f); },
      removeEventListener(t, f) { if (l.has(t)) l.get(t).delete(f); },
      fire(t, e) { for (const f of [...(l.get(t) || [])]) f({ type: t, ...e }); },
      count() { let n = 0; for (const s of l.values()) n += s.size; return n; },
    };
  };
  const rig = () => {
    const win = fakeWin();
    const page = new PageSaori({ files, host: { send() {} }, Audio: FakeAudio, win });
    const ran = [];
    page.afterGesture(() => ran.push(1));
    page.afterGesture(() => ran.push(2));
    return { win, page, ran };
  };
  // touch: the press does nothing, the lift runs both, once
  let r = rig();
  assert.deepEqual([...r.win.l.keys()].sort(), ['keydown', 'pointerdown', 'pointerup', 'touchend']);
  r.win.fire('pointerdown', { pointerType: 'touch' });
  assert.deepEqual(r.ran, [], 'a touch\'s pointerdown grants no activation');
  assert.equal(r.win.count(), 4, 'still listening');
  r.win.fire('pointerup', { pointerType: 'touch' });
  assert.deepEqual(r.ran, [1, 2]);
  assert.equal(r.win.count(), 0, 'every listener gone after one run');
  r.win.fire('touchend', {});
  assert.deepEqual(r.ran, [1, 2], 'no second run');
  // WebKit's touchend; a key; a pen's lift
  for (const [t, e] of [['touchend', {}], ['keydown', { key: 'a' }], ['pointerup', { pointerType: 'pen' }]]) {
    r = rig();
    r.win.fire(t, e);
    assert.deepEqual(r.ran, [1, 2], t);
    assert.equal(r.win.count(), 0);
  }
  // a mouse: at its pointerdown (its pointerup alone does nothing)
  r = rig();
  r.win.fire('pointerup', { pointerType: 'mouse' });
  assert.deepEqual(r.ran, []);
  r.win.fire('pointerdown', { pointerType: 'mouse' });
  assert.deepEqual(r.ran, [1, 2]);
  assert.equal(r.win.count(), 0);
  // the blocked dsaudio play of the first test, on a phone: retried at the lift, and it plays
  FakeAudio.block = true;
  const win = fakeWin();
  const page = new PageSaori({ files, host: { send() {} }, Audio: FakeAudio, win });
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['se.wav'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await settle();
  const a = FakeAudio.all.at(-1);
  FakeAudio.block = false;
  win.fire('pointerdown', { pointerType: 'touch' });
  await settle();
  assert.equal(a.paused, true, 'not at the press');
  win.fire('touchend', {});
  await settle();
  assert.equal(a.paused, false, 'at the lift');
  page.destroy();
});

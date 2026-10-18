// PageSaori (src/core/page-saori.js) with the page's MIDI engine (midi.md §6.3): a MIDI
// file by its name plays on the engine's players (\_v / \![sound], dsaudio, mciaudior, dropped files) and the ghost
// hears the same events as for any file (EV §4.17, TS §3.4); the music box's MIDI-only error path; each sound's player
// released; the music box resumed at its saved position. On the real MidiEngine / MidiPlayer over midi_fakes.mjs.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { PageSaori } from '../../src/core/page-saori.js';
import { DropStore } from '../../src/core/drops.js';
import { GhostFiles } from '../../src/core/loader.js';
import { IDLE_MS, END_EPS } from '../../src/core/midi.js';
import { setLogLevel } from '../../src/core/log.js';
import { settle } from './fakes.mjs';
import { midiRig, seeks } from './midi_fakes.mjs';

setLogLevel('silent');

// every test settles on fakes within milliseconds: a play that never settles fails the test instead of stalling the run
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
const BASE ='http://site/ghost/katari/';
const files = new GhostFiles(BASE, [
  ['ghost/master/m_birthday.mid', 100], ['ghost/master/m_canon.mid', 100], ['ghost/master/se.wav', 5],
  ['ghost/master/A.MID', 10], ['ghost/master/x.smf', 10], ['ghost/master/y.rmi', 10], ['ghost/master/a.mid.wav', 5],
]);
const UNSUPPORTED = 'The byte stream type of the given URL is unsupported.';

class FakeAudio {
  constructor(src) { this.src = src; this.paused = true; this.loop = false; this.volume = 1; this.currentTime = 0; FakeAudio.all.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
  load() {}
  addEventListener() {}
}
FakeAudio.all = [];

/** A PageSaori on a MIDI rig; `sent` lists the sound events (notifyEvent) and the music box's (send) as [id, refs]. */
function rigs({ midi = {}, drops = null, Audio = FakeAudio, engine = true } = {}) {
  const r = midiRig(midi);
  const sent = [];
  const host = {
    notifyEvent: (id, refs) => { sent.push([id, refs]); return Promise.resolve({ status: 204 }); },
    send: (id, refs) => sent.push([id, refs]),
  };
  const win = { l: new Map(), addEventListener(t, f) { this.l.set(t, f); }, removeEventListener(t) { this.l.delete(t); } };
  const page = new PageSaori({ files, host, Audio, win, drops, midi: engine ? r.engine : null });
  return { r, sent, win, page };
}

const only = page => { assert.equal(page.sounds.size, 1); return [...page.sounds][0]; };

test('\\_v of a MIDI file plays on the engine, not an <audio>; its end is OnSoundStop [the file as the tag gave it, end] and its player is released', async () => {
  const { r, sent, page } = rigs();
  const n = FakeAudio.all.length;
  page.sound('play', ['m_birthday.mid']);
  assert.equal(FakeAudio.all.length, n, 'no element');
  const a = only(page);
  assert.deepEqual([a.__midi, a.src, a.__file, a.loop], [true, `${BASE}ghost/master/m_birthday.mid`, 'm_birthday.mid', false]);
  await r.prepared();
  const node = r.node();
  assert.deepEqual(node.types(), ['load', 'play']);
  assert.equal(a.__started, true);
  node.end();
  await settle();
  assert.deepEqual(sent, [['OnSoundStop', ['m_birthday.mid', 'end']]]);
  assert.equal(page.sounds.size, 0);
  assert.deepEqual([node.last('close') !== undefined, node.disconnected], [true, true], 'its node and song go');
  page.destroy();
});

test('\\![sound,loop] on a MIDI: each end starts it over from 0 with OnSoundLoop [file]; a stop is quiet and releases it', async () => {
  const { r, sent, page } = rigs();
  page.sound('loop', ['m_canon.mid']);
  await r.prepared();
  const a = only(page), node = r.node();
  assert.equal(a.loop, false, 'started over by hand, so the ghost hears each pass');
  for (let i = 0; i < 2; i++) {
    node.end();
    await settle();
    assert.deepEqual(node.sent.slice(-2).map(m => [m.t, m.time]), [['seek', 0], ['play', undefined]]);
    assert.equal(a.paused, false);
  }
  assert.deepEqual(sent, [['OnSoundLoop', ['m_canon.mid']], ['OnSoundLoop', ['m_canon.mid']]]);
  page.sound('stop', ['M_CANON.MID']);
  node.end();
  await settle();
  assert.equal(sent.length, 2);
  assert.deepEqual([page.sounds.size, node.last('close') !== undefined], [0, true]);
  page.destroy();
});

test('a MIDI that cannot start: OnSoundError [play, 14020, file, text], once; one that fails after it played ends as OnSoundStop', async () => {
  const { r, sent, page } = rigs();
  r.fetchStatus = 404;
  page.sound('play', ['m_birthday.mid']);
  await settle();
  assert.deepEqual(sent, [['OnSoundError', ['play', '14020', 'm_birthday.mid', UNSUPPORTED]]]);
  assert.equal(page.sounds.size, 0);
  sent.length = 0;
  r.fetchStatus = 200;
  page.sound('play', ['m_canon.mid']);
  await r.prepared({ fail: { kind: 'bank', message: 'HTTP 503' } });
  assert.deepEqual(sent, [['OnSoundError', ['play', '14020', 'm_canon.mid', UNSUPPORTED]]], 'the bank: the same');
  sent.length = 0;
  page.sound('play', ['m_canon.mid']);
  await r.prepared();
  r.node().onprocessorerror();
  await settle();
  assert.deepEqual(sent, [['OnSoundStop', ['m_canon.mid', 'end']]]);
  page.destroy();
});

test('which files are MIDI: by the name the tag gave (.MID, .smf, .rmi, quoted); a.mid.wav is not; a dropped one is read from its Blob; without an engine MIDI goes to <audio>', async () => {
  const { r, page } = rigs();
  for (const name of ['A.MID', 'x.smf', 'y.rmi', '"m_canon.mid"']) {
    page.sound('play', [name]);
    const a = [...page.sounds].at(-1);
    assert.equal(a.__midi, true, name);
  }
  const n = FakeAudio.all.length;
  page.sound('play', ['a.mid.wav']);
  assert.equal(FakeAudio.all.length, n + 1);
  page.destroy();

  const urls = { n: 0, createObjectURL() { return `blob:t/${++this.n}`; }, revokeObjectURL() {} };
  const drops = new DropStore({ URL: urls, locks: null });
  const d = rigs({ drops });
  const [e] = drops.add([new File([new Uint8Array(9)], 'Song.MID', { lastModified: 1 })]);
  d.page.sound('play', [e.path]);
  await d.r.prepared();
  const a = only(d.page);
  assert.deepEqual([a.__midi, a.__file, d.r.fetched], [true, e.path, []], 'the Blob itself, no fetch of its blob: URL');
  assert.equal(d.r.worker().jobs()[0].midi.byteLength, 9);
  assert.deepEqual(d.r.node().types(), ['load', 'play']);
  d.page.destroy();

  const plain = rigs({ engine: false });
  const m = FakeAudio.all.length;
  plain.page.sound('play', ['m_birthday.mid']);
  assert.equal(FakeAudio.all.length, m + 1, 'no engine (unbundled, no AudioWorklet): <audio>');
  plain.page.destroy();
});

test('stop, pause and destroy: MIDI sounds go quietly, each player released', async () => {
  const { r, sent, page } = rigs();
  page.sound('play', ['m_birthday.mid']);
  page.sound('play', ['m_canon.mid']);
  await r.prepared();
  const [n1, n2] = r.nodes;
  page.sound('pause', ['m_canon.mid']);
  assert.equal(n2.last('pause') !== undefined, true);
  page.destroy();
  n1.end();
  await settle();
  assert.deepEqual(sent, []);
  assert.deepEqual([n1.last('close') !== undefined, n2.last('close') !== undefined], [true, true]);
});

test('the same \\_v MIDI again right at its end plays again: the end already on its way is dropped (review point 4)', async () => {
  const { r, sent, page } = rigs();
  page.sound('play', ['m_birthday.mid']);
  await r.prepared();
  const node = r.node();
  r.auto = false;
  node.playing = false;
  const old = node.lastN;
  page.sound('play', ['m_birthday.mid']);              // _restartSound: currentTime = 0, play()
  node.reply({ t: 'ended', pos: 60, n: old });         // the first play's end, sent before the restart arrived
  await settle();
  assert.deepEqual([sent, page.sounds.size], [[], 1]);
  node.reply({ t: 'state', playing: false, pos: 0, at: 0, n: node.last('seek').n });
  assert.equal(node.last('play').n, node.lastN, 'told to play again');
  node.reply({ t: 'state', playing: true, pos: 0, at: 0, n: node.lastN });
  node.end();
  await settle();
  assert.deepEqual(sent, [['OnSoundStop', ['m_birthday.mid', 'end']]], 'its own end, once');
  page.destroy();
});

test('music box: a dsaudio MIDI\'s end is OnDSAPlayFinish; mciaudior\'s loop starts it over with OnMAAPlayLoop, its finish is OnMAAPlayFinish; dsaudio\'s loop is the node\'s own', async () => {
  const { r, sent, page } = rigs();
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['m_canon.mid'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await r.prepared();
  r.node().end();
  await settle();
  assert.deepEqual(sent, [['OnDSAPlayFinish', []]]);
  sent.length = 0;

  page.handle({ name: 'mciaudior', cmd: 'load', args: ['ghost/master/m_canon.mid', 'm_canon.mid'] });
  page.handle({ name: 'mciaudior', cmd: 'loop', args: ['enable'] });
  page.handle({ name: 'mciaudior', cmd: 'play', args: [] });
  await r.prepared();
  const node = r.node();
  assert.equal(node.last('loop'), undefined, 'mciaudior: the element does not loop by itself');
  node.end();
  await settle();
  assert.deepEqual(sent, [['OnMAAPlayLoop', ['m_canon.mid', '0']]]);
  assert.deepEqual(node.sent.slice(-2).map(m => [m.t, m.time]), [['seek', 0], ['play', undefined]]);
  page.handle({ name: 'mciaudior', cmd: 'loop', args: ['disable'] });
  node.end();
  await settle();
  assert.deepEqual(sent.at(-1), ['OnMAAPlayFinish', ['m_canon.mid', '0']]);
  sent.length = 0;

  page.handle({ name: 'dsaudio', cmd: 'load', args: ['m_birthday.mid'] });
  page.handle({ name: 'dsaudio', cmd: 'loop', args: ['enable'] });
  page.handle({ name: 'dsaudio', cmd: 'volume', args: ['2500'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await r.prepared();
  const n3 = r.node();
  assert.deepEqual([n3.last('loop').on, r.ctx().gains.at(-1).gain.value], [true, 0.25]);
  n3.end();
  await settle();
  assert.deepEqual(sent, [], 'started over by the node: no event per pass');
  page.handle({ name: 'dsaudio', cmd: 'stop', args: [] });
  assert.equal(n3.last('pause') !== undefined, true);
  page.handle({ name: 'dsaudio', cmd: 'unload', args: [] });
  assert.equal(n3.last('close') !== undefined, true);
  page.destroy();
});

test('music box, MIDI only: a track that cannot play stops quietly (no finish event) and is not wanted on the next page; an <audio> track that fails is tried again on the next page', async () => {
  const { r, sent, page } = rigs();
  r.fetchStatus = 404;
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['m_canon.mid'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await settle();
  assert.deepEqual(sent, []);
  assert.equal(page.musicState().playing, false, 'saved as not playing: no retry on every page');
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });     // the ghost asks again: it fails again, quietly
  await settle();
  r.fetchStatus = 200;
  page.handle({ name: 'mciaudior', cmd: 'load', args: ['ghost/master/m_canon.mid', 'm_canon.mid'] });
  page.handle({ name: 'mciaudior', cmd: 'play', args: [] });
  await r.prepared({ fail: { kind: 'bank', message: 'stalled' } });
  assert.deepEqual(sent, [], 'no OnMAAPlayFinish: mikaru would load it again at full speed');
  assert.equal(page.musicState().playing, false);
  page.destroy();

  class Unplayable extends FakeAudio { play() { return Promise.reject(Object.assign(new Error('no codec'), { name: 'NotSupportedError' })); } }
  const audio = rigs({ Audio: Unplayable });
  audio.page.handle({ name: 'dsaudio', cmd: 'load', args: ['se.wav'] });
  audio.page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await settle();
  assert.equal(audio.page.musicState().playing, true, '<audio>: tried again on the next page');
  assert.equal(FakeAudio.all.at(-1).onerror, undefined, 'no error handler on an <audio> track');
  audio.page.destroy();
});

test('resume: the saved position is kept and sent as a seek at ready (loadedmetadata finds it in place); a track saved at its end finishes at once; a paused one loads nothing', async () => {
  const { r, sent, page } = rigs();
  page.resumeMusic({ path: 'm_canon.mid', currentTime: 12.5, loop: false, volume: 0.5, playing: true });
  await r.prepared();
  const node = r.node();
  assert.deepEqual(node.sent.map(m => [m.t, m.time]), [['load', undefined], ['seek', 12.5], ['play', undefined]], 'one seek');
  assert.equal(r.ctx().gains[0].gain.value, 0.5);
  assert.deepEqual([page.musicState().currentTime, page.musicState().playing], [12.5, true]);
  page.destroy();

  // saved at its end (the page went just as it ended): it ends here, OnDSAPlayFinish, nothing sought there
  const end = rigs();
  end.page.resumeMusic({ path: 'm_canon.mid', currentTime: 60, loop: false, volume: 1, playing: true });
  await end.r.prepared();
  await settle();
  assert.deepEqual(end.sent, [['OnDSAPlayFinish', []]]);
  assert.deepEqual(end.r.node().types(), ['load']);
  assert.equal(end.page.musicState().playing, false);
  // past its end (the file changed between visits): the same, and the box's second seek reaches nothing either
  const past = rigs();
  past.page.resumeMusic({ path: 'm_canon.mid', currentTime: 75, playing: true, owner: 'mciaudior', given: 'm_canon.mid' });
  await past.r.prepared();
  await settle();
  assert.deepEqual(past.sent, [['OnMAAPlayFinish', ['m_canon.mid', '0']]]);
  assert.ok(seeks(past.r).every(t => t < 60 - END_EPS), String(seeks(past.r)));
  end.page.destroy();
  past.page.destroy();

  const paused = rigs();
  paused.page.resumeMusic({ path: 'm_canon.mid', currentTime: 30, playing: false });
  await settle();
  assert.deepEqual([paused.r.fetched, paused.r.workers.length, paused.r.contexts.length], [[], 0, 0], 'nothing downloaded for a track not played');
  assert.equal(paused.page.musicState().currentTime, 30);
  paused.page.destroy();
});

test('autoplay: a MIDI play refused for want of an activation (no context made) plays at the next gesture, which makes the context inside it', async () => {
  const { r, sent, page, win } = rigs({ midi: { activated: false } });
  page.sound('play', ['m_birthday.mid']);
  page.handle({ name: 'dsaudio', cmd: 'load', args: ['m_canon.mid'] });
  page.handle({ name: 'dsaudio', cmd: 'play', args: [] });
  await r.prepared();
  assert.deepEqual([r.contexts.length, sent], [0, []], 'refused, no error');
  assert.ok(win.l.has('pointerdown'), 'waiting for a gesture');
  r.nav.userActivation.hasBeenActive = true;
  win.l.get('pointerdown')({ type: 'pointerdown', pointerType: 'mouse' });
  assert.equal(r.contexts.length, 1, 'made inside the gesture');
  await settle();
  assert.deepEqual(r.nodes.map(n => n.types()), [['load', 'play'], ['load', 'play']]);
  assert.deepEqual(sent, []);
  page.destroy();
});

test('two \\_v MIDI in a row: the first ends and is released, the second plays on past 10 s with no suspend; once nothing plays, 10 s later the context is suspended (review point 1)', async () => {
  const { r, sent, page } = rigs();
  page.sound('play', ['m_birthday.mid']);
  await r.prepared();
  r.node().end();
  await settle();
  assert.deepEqual(sent, [['OnSoundStop', ['m_birthday.mid', 'end']]]);
  await r.clock.advance(IDLE_MS / 2);
  page.sound('play', ['m_canon.mid']);
  await r.prepared();
  await r.clock.advance(IDLE_MS * 3);
  assert.equal(r.ctx().suspends, 0);
  page.sound('stop', []);
  await r.clock.advance(IDLE_MS);
  assert.equal(r.ctx().suspends, 1);
  page.destroy();
});

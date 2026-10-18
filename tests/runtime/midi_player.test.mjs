// src/core/midi.js (midi.md §6.2): MIDI names, support, the build table's paths,
// MidiEngine (one context, Worker and module per page; nothing before a play; the blob: bootstrap; the context only
// after an activation; the idle suspend and the audio session) and MidiPlayer (element-like for page-saori.js: play
// promises, positions kept before ready, stale node replies dropped by their number, seeks at the end never reaching
// the sequencer, failures, release), on the fakes of midi_fakes.mjs.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {
  MidiEngine, MidiPlayer, isMidiPath, midiSupported, midiPaths, RESUME_WAIT_MS, IDLE_MS, CLOSE_WAIT_MS, END_EPS,
} from '../../src/core/midi.js';
import { Site } from '../../src/core/site.js';
import { setLogLevel } from '../../src/core/log.js';
import { settle } from './fakes.mjs';
import { midiRig, seeks, JS_URL, BANK_URL, PATHS, RUNTIME_URL } from './midi_fakes.mjs';

setLogLevel('silent');

// every test settles on fakes within milliseconds: a play that never settles fails the test instead of stalling the run
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
const SONG ='http://site/ghost/katari/ghost/master/m_canon.mid';
const caught = p => p.then(() => null, e => e);

/** A player of r's engine, played and brought to `ready`: the Worker answered, the node made (await p: playing). */
async function up(r, { url = SONG } = {}) {
  const a = r.engine.player({ url });
  const p = a.play();
  await r.prepared();
  return { a, p, node: r.node() };
}

// ---------------------------------------------------------------- the pure helpers

test('MIDI names by the path as the ghost gave it; support; the build table\'s paths', () => {
  for (const p of ['m_birthday.mid', 'A.MID', 'x.midi', 'x.smf', 'x.rmi', '"q.mid"', ' C:\\sumika\\drop\\0a1b2c3d\\Song.MID ', '..\\sound\\hymn109.mid']) {
    assert.equal(isMidiPath(p), true, p);
  }
  for (const p of ['a.mid.wav', 'mid', 'x.mp3', '', null, undefined, 'blob:http://site/1234']) assert.equal(isMidiPath(p), false, String(p));
  const F = function () {};
  const g = { isSecureContext: true, AudioContext: F, AudioWorkletNode: F, Worker: F };
  assert.equal(midiSupported(g), true);
  assert.equal(midiSupported({ ...g, isSecureContext: false }), false, 'plain http: no AudioWorklet');
  assert.equal(midiSupported({ ...g, AudioWorkletNode: undefined }), false, 'an old browser');
  assert.equal(midiSupported({ ...g, Worker: undefined }), false);
  assert.equal(midiSupported(null), false);
  assert.equal(midiSupported(), false, 'Node: no AudioContext');
  assert.deepEqual(midiPaths({ worker: 'w', engines: {}, midi: { ...PATHS, extra: 1 } }), PATHS);
  for (const f of [null, {}, { midi: null }, { midi: { js: PATHS.js } }, { midi: { js: '', bank: PATHS.bank } }, { midi: { js: 1, bank: 2 } }]) {
    assert.equal(midiPaths(f), null, JSON.stringify(f));
  }
  assert.equal(midiPaths(), null, 'unbundled: no table');
});

test('Site.midi: null unbundled or where MIDI cannot run; with the table, one engine for the page that loads nothing when made', () => {
  assert.equal(new Site({ Channel: null, lead: false, maxGhosts: 1 }).midi, null, 'no table (tests, site/dev, the sweep)');
  const files = { worker: 'engines/worker.0000000000.js', engines: {}, midi: PATHS };
  const keys = ['isSecureContext', 'AudioContext', 'AudioWorkletNode', 'Worker'];
  const saved = keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  let made = 0;
  try {
    Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true, writable: true });
    globalThis.AudioContext = class { constructor() { made++; } };
    globalThis.AudioWorkletNode = class {};
    globalThis.Worker = class { constructor() { made++; } };
    assert.equal(new Site({ Channel: null, lead: false, maxGhosts: 1, runtimeUrl: RUNTIME_URL, runtimeFiles: files }).midi, null, 'not a secure context');
    globalThis.isSecureContext = true;
    const site = new Site({ Channel: null, lead: false, maxGhosts: 1, runtimeUrl: RUNTIME_URL, runtimeFiles: files });
    const e = site.midi;
    assert.ok(e instanceof MidiEngine);
    assert.equal(site.midi, e, 'one per page');
    assert.deepEqual([e.jsUrl, e.bankUrl, e.ctx, made], [JS_URL, BANK_URL, null, 0], 'absolute URLs; no context, no Worker yet');
    assert.equal(new Site({ Channel: null, lead: false, maxGhosts: 1, runtimeUrl: RUNTIME_URL, runtimeFiles: { worker: 'w', engines: {} } }).midi, null,
      'a build without the MIDI files');
  } finally {
    for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

// ---------------------------------------------------------------- loading and playing

test('nothing loads before the first play; one Worker (a blob: bootstrap) and one module serve every player; play resolves at the node\'s state, after loadedmetadata', async () => {
  const r = midiRig({ duration: 54.381 });
  const a = r.engine.player({ url: SONG });
  assert.ok(a instanceof MidiPlayer);
  assert.deepEqual([a.paused, a.ended, a.duration, a.currentTime, a.error, a.src], [true, false, NaN, 0, null, SONG]);
  await settle();
  assert.deepEqual([r.contexts.length, r.workers.length, r.fetched.length], [0, 0, 0], 'a player made (a paused music box restored) loads nothing');

  const order = [];
  a.addEventListener('loadedmetadata', () => order.push('meta'), { once: true });
  const p = a.play().then(() => order.push('played'));
  assert.equal(a.paused, false);
  assert.deepEqual(r.ctx().opts, { latencyHint: 'playback' }, 'made inside the play, at the default sample rate');
  await settle();
  assert.deepEqual(r.fetched, [SONG], 'the ghost file by its plain URL');
  const w = r.worker();
  assert.match(w.url, /^blob:fake\//, 'a worker script must be same-origin: started from a blob: bootstrap');
  assert.equal(r.blobText(w.url), `importScripts(${JSON.stringify(JS_URL)});`);
  assert.deepEqual(w.sent[0], { t: 'bank', url: BANK_URL }, 'the bank download starts at once');
  assert.equal(w.sent[1].t, 'prepare');
  assert.ok(w.sent[1].midi instanceof ArrayBuffer);
  assert.deepEqual(r.revoked, []);
  await r.prepared();
  assert.deepEqual(r.revoked, [w.url], 'the bootstrap URL goes once the script is up');
  assert.deepEqual(r.ctx().modules, [JS_URL], 'the worklet module: the same URL');
  const node = r.node();
  assert.equal(node.name, 'sumika-midi');
  assert.deepEqual(node.opts, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  const gain = r.ctx().gains[0];
  assert.deepEqual([node.connected[0], gain.connected[0]], [gain, r.ctx().destination], 'node -> its gain -> the speakers');
  assert.equal(node.sent[0].t, 'load');
  assert.deepEqual(node.transfers[0], [node.sent[0].sf2, node.sent[0].midi], 'the song is transferred, not copied');
  await p;
  assert.deepEqual(order, ['meta', 'played']);
  assert.deepEqual(node.types(), ['load', 'play']);
  assert.equal(a.duration, 54.381);
  assert.ok(node.sent.every(m => typeof m.n === 'number'), 'every command numbered');

  // a second player: the same Worker and module, its own node
  const b = r.engine.player({ url: 'http://site/ghost/katari/ghost/master/m_holy.mid' });
  const q = b.play();
  await r.prepared();
  await q;
  assert.deepEqual([r.workers.length, r.contexts.length, r.ctx().modules.length, r.nodes.length], [1, 1, 1, 2]);
  assert.deepEqual(r.worker().jobs().length, 2);
});

test('a context that stays suspended: NotAllowedError after RESUME_WAIT_MS, paused again; the load goes on; a play inside a gesture plays', async () => {
  const r = midiRig({ resume: 'hang' });
  const a = r.engine.player({ url: SONG });
  const p = caught(a.play());
  await settle();
  let settled = false;
  p.then(() => { settled = true; });
  await r.clock.advance(RESUME_WAIT_MS - 1);
  assert.equal(settled, false, 'a slow resume inside a gesture is not a refusal');
  await r.clock.advance(1);
  const e = await p;
  assert.equal(e.name, 'NotAllowedError');
  assert.equal(a.paused, true);
  assert.equal(r.engine._holders.size, 0);
  await r.prepared();
  assert.deepEqual(r.node().types(), ['load'], 'loaded meanwhile, not played');
  r.resume = 'run';                                    // page-saori's afterGesture: play() inside the next gesture
  await a.play();
  assert.deepEqual(r.node().types(), ['load', 'play']);
  assert.equal(r.ctx().resumes, 2);
});

test('no activation yet: no context is made (Chrome warns about one), NotAllowedError at once; the song is prepared meanwhile; a resume that rejects is a refusal at once', async () => {
  const r = midiRig({ activated: false });
  const a = r.engine.player({ url: SONG });
  const e = await caught(a.play());
  assert.equal(e.name, 'NotAllowedError', 'without waiting RESUME_WAIT_MS');
  assert.deepEqual([r.contexts.length, a.paused], [0, true]);
  await r.prepared();
  assert.deepEqual([r.contexts.length, r.nodes.length], [0, 0], 'the prepared song waits for the context');
  r.nav.userActivation.hasBeenActive = true;           // a gesture
  await a.play();
  assert.deepEqual([r.contexts.length, r.ctx().modules.length], [1, 1]);
  assert.deepEqual(r.node().types(), ['load', 'play']);

  // WebKit: resume() rejects
  const s = midiRig({ resume: 'reject', activated: undefined });
  const b = s.engine.player({ url: SONG });
  const e2 = await caught(b.play());
  assert.equal(e2.name, 'NotAllowedError');
  assert.deepEqual(s.clock.q.map(x => x.at - s.clock.t), [IDLE_MS], 'no resume timer left waiting, only the idle one');
});

test('a pause while a play waits: AbortError, and the node is never told to play', async () => {
  const r = midiRig();
  const a = r.engine.player({ url: SONG });
  const p = caught(a.play());
  a.pause();
  assert.equal((await p).name, 'AbortError');
  await r.prepared();
  assert.deepEqual(r.node().types(), ['load']);
  assert.equal(r.engine._holders.size, 0);
});

test('a dropped file: its Blob is read as it is, never fetched', async () => {
  const r = midiRig();
  const blob = new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1, 2, 3])]);
  const a = r.engine.player({ url: 'blob:http://site/1234', blob });
  const p = a.play();
  await r.prepared();
  await p;
  assert.deepEqual(r.fetched, []);
  assert.equal(r.worker().jobs()[0].midi.byteLength, 7);
});

// ---------------------------------------------------------------- positions

test('currentTime: kept before ready and sent at ready (after loop); estimated from the context clock while it plays; the setter moves it at once', async () => {
  const r = midiRig();
  const a = r.engine.player({ url: SONG });
  a.loop = true;
  a.currentTime = 12.5;
  assert.equal(a.currentTime, 12.5);
  const p = a.play();
  await settle();
  r.ctx().currentTime = 100;
  await r.prepared();
  await p;
  const node = r.node();
  assert.deepEqual(node.sent.map(m => [m.t, m.on ?? m.time]), [['load', undefined], ['loop', true], ['seek', 12.5], ['play', undefined]]);
  r.ctx().currentTime = 103;
  assert.equal(a.currentTime, 15.5, 'the node\'s position at its context time, plus the time since');
  a.currentTime = 30;
  assert.deepEqual([node.last('seek').time, a.currentTime], [30, 30], 'at once, not after the round trip');
  await settle();
  r.ctx().currentTime = 104;
  assert.equal(a.currentTime, 31);
  a.currentTime = -5;
  assert.deepEqual([node.last('seek').time, a.currentTime], [0, 0]);
  a.currentTime = NaN;                                 // an element would throw; the box catches either way
  assert.equal(node.last('seek').time, 0);
  r.ctx().currentTime = 105;
  assert.equal(a.currentTime, 1);
  a.pause();
  r.ctx().currentTime = 110;
  await settle();
  assert.equal(a.currentTime, 1, 'paused: it stands');
  a.loop = false;
  assert.deepEqual(node.last('loop'), { t: 'loop', on: false, n: node.lastN });
});

test('the end: ended, onended and paused; a play after the end starts at 0; with loop the node starts over by itself, no event', async () => {
  const r = midiRig();
  const { a, p, node } = await up(r);
  await p;
  const seen = [];
  a.onended = ev => seen.push(['on', ev.type, ev.target === a]);
  a.addEventListener('ended', ev => seen.push(['listener', ev.type]));
  node.end();
  assert.deepEqual([a.ended, a.paused, a.currentTime], [true, true, 60]);
  await settle();
  assert.deepEqual(seen, [['on', 'ended', true], ['listener', 'ended']]);
  assert.equal(r.engine._holders.size, 0);
  await a.play();
  assert.deepEqual(node.sent.slice(-2).map(m => [m.t, m.time]), [['seek', 0], ['play', undefined]], 'from the start, as an element');
  assert.equal(a.ended, false);
  a.loop = true;
  await settle();
  r.ctx().currentTime = 5;
  node.end();
  await settle();
  assert.deepEqual([seen.length, a.ended, a.paused, a.currentTime], [2, false, false, 0], 'started over: no ended');

  // loop turned on while the node's `ended` (sent without it) was on its way: started over by hand, no event
  const s = midiRig({ auto: true });
  const u = await up(s);
  await u.p;
  u.a.onended = () => seen.push('late');
  u.node.loop = false;
  const n = u.node.lastN;
  u.a.loop = true;                                     // the page's loop message is behind the node's end
  u.node.reply({ t: 'ended', pos: 60, n });
  await settle();
  assert.equal(seen.includes('late'), false);
  assert.deepEqual(u.node.sent.slice(-2).map(m => [m.t, m.time]), [['seek', 0], ['play', undefined]]);
  assert.equal(u.a.paused, false);
});

test('seeks at the end never reach the sequencer (core 4.3.22 throws there): paused it stays at its end, playing it ends, a play from there starts at 0', async () => {
  const r = midiRig();
  const { a, p, node } = await up(r);
  await p;
  a.pause();
  const sent = node.sent.length;
  for (const t of [60, 60 - END_EPS / 2, 1e9]) {
    a.currentTime = t;
    assert.deepEqual([a.ended, a.currentTime], [true, 60], String(t));
  }
  assert.equal(node.sent.length, sent, 'nothing sent');
  a.currentTime = 60 - 2 * END_EPS;
  assert.deepEqual([a.ended, node.last('seek').time], [false, 60 - 2 * END_EPS], 'just before the end is a seek');
  a.currentTime = 60;
  await a.play();
  assert.deepEqual(node.sent.slice(-2).map(m => [m.t, m.time]), [['seek', 0], ['play', undefined]]);
  // playing: a seek to the end ends the song (the node is paused, not sought)
  let ended = 0;
  a.onended = () => ended++;
  a.currentTime = 60;
  assert.deepEqual([a.ended, a.paused, node.last('pause').n === node.lastN], [true, true, true]);
  await settle();
  assert.equal(ended, 1);
  // looping: the end is the start
  a.loop = true;
  await a.play();
  a.currentTime = 60;
  assert.deepEqual([a.ended, node.last('seek').time], [false, 0]);
  assert.ok(seeks(r).every(t => t < 60 - END_EPS / 2), `no seek at the end: ${seeks(r)}`);
});

test('a position kept at the end (a music box saved at its end): at ready loadedmetadata, then the song ends at once; nothing at the end is sent', async () => {
  const r = midiRig();
  const a = r.engine.player({ url: SONG });
  const order = [];
  a.addEventListener('loadedmetadata', () => order.push(['meta', a.currentTime]), { once: true });
  a.onended = () => order.push(['ended', a.currentTime]);
  a.currentTime = 75;                                  // the saved position may even lie past the song's end
  const p = a.play().then(() => order.push(['played']));
  await r.prepared();
  await p;
  await settle();
  assert.deepEqual(order, [['meta', 60], ['played'], ['ended', 60]]);
  assert.deepEqual(r.node().types(), ['load'], 'neither a seek nor a play');
  assert.deepEqual([a.ended, a.paused], [true, true]);
  // paused at the end: it stays there, ended
  const b = r.engine.player({ url: SONG });
  b.currentTime = 60;
  const pb = caught(b.play());
  b.pause();
  assert.equal((await pb).name, 'AbortError');
  await r.prepared();
  assert.deepEqual([b.ended, b.currentTime, r.node().types()], [true, 60, ['load']]);
});

test('stale replies are dropped by their number: an end older than a restart, a state older than a seek; a node that stopped by itself is told to play again; a reply without a number counts', async () => {
  const r = midiRig();
  const { a, p, node } = await up(r);
  await p;
  r.auto = false;                                      // the test answers from here on
  let ended = 0;
  a.onended = () => ended++;
  const old = node.lastN;
  node.playing = false;                                // the node reached its end; its `ended` is on its way
  a.currentTime = 0;                                   // \_v of the same file: started over (page-saori _restartSound)
  const again = a.play();
  node.reply({ t: 'ended', pos: 60, n: old });
  await settle();
  assert.deepEqual([ended, a.ended, a.paused], [0, false, false], 'not the new play\'s end');
  const seekN = node.last('seek').n;
  node.reply({ t: 'state', playing: false, pos: 0, at: 0, n: seekN });   // stopped at its end, sought to 0
  await settle();
  assert.equal(node.last('play').n, seekN + 1, 'told to play again');
  node.reply({ t: 'state', playing: true, pos: 0, at: 0, n: seekN + 1 });
  await again;
  r.ctx().currentTime = 1;
  a.currentTime = 20;
  node.reply({ t: 'state', playing: true, pos: 5, at: 1, n: seekN + 1 });  // the play's answer, after the seek went
  await settle();
  assert.equal(a.currentTime, 20, 'a state older than the seek moves nothing');
  node.reply({ t: 'state', playing: true, pos: 20, at: 1, n: node.lastN });
  assert.equal(a.currentTime, 20);

  // a node that echoes no number: its replies are taken as current
  const s = midiRig({ echo: false });
  const u = await up(s);
  await u.p;
  assert.equal(u.a.paused, false);
  u.node.end();
  await settle();
  assert.deepEqual([u.a.ended, u.a.paused], [true, true]);
});

test('a play() while it plays resolves without a second play command', async () => {
  const r = midiRig();
  const { a, p, node } = await up(r);
  await p;
  await a.play();
  await a.play();
  assert.deepEqual(node.types(), ['load', 'play']);
});

// ---------------------------------------------------------------- failures and release

test('failures: a prepare that fails is an error once (code 4) and play rejects NotSupportedError; a bank failure fails that song only, the next prepares again on the same Worker', async () => {
  const r = midiRig();
  const a = r.engine.player({ url: SONG });
  const errors = [];
  a.onerror = ev => errors.push(ev.type);
  a.addEventListener('error', () => errors.push('listener'));
  const p = caught(a.play());
  await r.prepared({ fail: { kind: 'midi', message: 'not a MIDI file' } });
  assert.equal((await p).name, 'NotSupportedError');
  assert.deepEqual([a.error.code, /not a MIDI file/.test(a.error.message), a.paused, errors], [4, true, true, ['error', 'listener']]);
  assert.equal((await caught(a.play())).name, 'NotSupportedError', 'a failed player stays failed');
  await settle();
  assert.equal(errors.length, 2, 'once');
  assert.equal(r.engine._holders.size, 0);
  // the bank could not load: this song fails; the next play prepares again (the Worker downloads again)
  const b = r.engine.player({ url: SONG });
  const q = caught(b.play());
  await r.prepared({ fail: { kind: 'bank', message: 'HTTP 404' } });
  assert.equal((await q).name, 'NotSupportedError');
  const c = r.engine.player({ url: SONG });
  const pc = c.play();
  await r.prepared();
  await pc;
  assert.deepEqual([r.workers.length, r.worker().jobs().length], [1, 3]);
  // the file itself: an HTTP error
  r.fetchStatus = 404;
  const d = r.engine.player({ url: SONG });
  assert.equal((await caught(d.play())).name, 'NotSupportedError');
  assert.match(d.error.message, /404/);
});

test('a Worker error fails every song it was preparing; the next play makes a new Worker; a module that failed is asked for again', async () => {
  const r = midiRig();
  const a = r.engine.player({ url: SONG }), b = r.engine.player({ url: SONG });
  const pa = caught(a.play()), pb = caught(b.play());
  await settle();
  const w = r.worker();
  w.fail('importScripts failed');
  assert.deepEqual([(await pa).name, (await pb).name, w.terminated], ['NotSupportedError', 'NotSupportedError', true]);
  const c = r.engine.player({ url: SONG });
  const pc = c.play();
  await r.prepared();
  await pc;
  assert.equal(r.workers.length, 2);
  assert.deepEqual(r.worker().sent[0], { t: 'bank', url: BANK_URL });
  // addModule refused (a CSP, a file pruned under a very old tab): that play fails, the next asks again
  const s = midiRig();
  s.moduleFail = true;
  const d = s.engine.player({ url: SONG });
  const pd = caught(d.play());
  await s.prepared();
  assert.equal((await pd).name, 'NotSupportedError');
  s.moduleFail = false;
  const before = s.ctx().modules.length;
  const e = s.engine.player({ url: SONG });
  const pe = e.play();
  await s.prepared();
  await pe;
  assert.equal(s.ctx().modules.length, before + 1, 'asked for again');
});

test('the processor fails: an error before or after it played; its node goes at once', async () => {
  const r = midiRig();
  const { a, p, node } = await up(r);
  await p;
  let errors = 0;
  a.onerror = () => errors++;
  node.onprocessorerror();
  await settle();
  assert.deepEqual([errors, a.error.code, a.paused, node.last('close') !== undefined], [1, 4, true, true]);
  assert.equal(node.disconnected, true, 'closed');
  const b = r.engine.player({ url: SONG });
  const q = caught(b.play());
  r.auto = false;
  await r.prepared();
  r.node().reply({ t: 'error', message: 'cannot load the bank' });
  assert.equal((await q).name, 'NotSupportedError');
  assert.match(b.error.message, /cannot load the bank/);
});

test('release (removeAttribute(\'src\') then load()): close, no event again, disconnected at closed or CLOSE_WAIT_MS later; a release while it loads connects nothing', async () => {
  const r = midiRig();
  const { a, p, node } = await up(r);
  await p;
  a.onended = () => assert.fail('no event after a release');
  a.pause();
  a.removeAttribute('src');
  a.load();
  assert.deepEqual([a.src, a.paused, node.last('close') !== undefined], ['', true, true]);
  node.end();
  await settle();
  assert.deepEqual([node.disconnected, r.ctx().gains[0].disconnected], [true, true], 'at `closed`');
  assert.equal((await caught(a.play())).name, 'NotSupportedError');
  // a node that never answers: CLOSE_WAIT_MS
  r.auto = false;
  const b = r.engine.player({ url: SONG });
  const pb = caught(b.play());
  await r.prepared();
  const bn = r.node();
  b.removeAttribute('src');
  b.load();
  assert.equal((await pb).name, 'AbortError', 'a play still waiting for `ready`');
  await r.clock.advance(CLOSE_WAIT_MS - 1);
  assert.equal(bn.disconnected, false);
  await r.clock.advance(1);
  assert.equal(bn.disconnected, true);
  // released while it loads: the prepared song is dropped, no node made
  r.auto = true;
  const c = r.engine.player({ url: SONG });
  const pc = caught(c.play());
  await settle();
  c.removeAttribute('src');
  c.load();
  assert.equal((await pc).name, 'AbortError');
  const nodes = r.nodes.length;
  await r.prepared();
  assert.equal(r.nodes.length, nodes);
  // a load() with a src does nothing
  const d = r.engine.player({ url: SONG });
  d.load();
  assert.equal(d._released, false);
});

test('volume: the GainNode\'s value, clamped; set before the node exists it applies when it connects', async () => {
  const r = midiRig();
  const a = r.engine.player({ url: SONG });
  a.volume = 0.25;
  const p = a.play();
  await r.prepared();
  await p;
  const gain = r.ctx().gains[0];
  assert.equal(gain.gain.value, 0.25);
  a.volume = 2;
  assert.deepEqual([a.volume, gain.gain.value], [1, 1]);
  a.volume = -1;
  assert.deepEqual([a.volume, gain.gain.value], [0, 0]);
  a.volume = 'x';
  assert.equal(a.volume, 0);
});

// ---------------------------------------------------------------- the idle suspend (review point 1)

test('idle: each player holds once (its flag): two \\_v MIDI in a row, the second past 10 s, never suspended; pause then release, play twice, an end then release count once; 10 s with none holding suspends and gives the audio session back', async () => {
  const r = midiRig();
  const one = await up(r);
  await one.p;
  assert.equal(r.nav.audioSession.type, 'playback', 'MIDI ignores the silent switch where Safari has audioSession');
  one.node.end();                                       // its end, then page-saori's release (_soundEnded -> _dropSound)
  await settle();
  one.a.pause();                                        // the music box's stop() pauses an ended player
  one.a.removeAttribute('src');
  one.a.load();
  await r.clock.advance(IDLE_MS / 2);
  const two = await up(r);
  await two.p;
  await two.a.play();                                   // played twice
  await r.clock.advance(IDLE_MS * 2);
  assert.equal(r.ctx().suspends, 0, 'the second song plays on past 10 s');
  two.a.pause();
  two.a.pause();
  two.a.removeAttribute('src');
  two.a.load();
  await r.clock.advance(IDLE_MS - 1);
  assert.equal(r.ctx().suspends, 0);
  await r.clock.advance(1);
  assert.deepEqual([r.ctx().suspends, r.ctx().state, r.nav.audioSession.type], [1, 'suspended', 'auto']);
  // a later play resumes it (no gesture needed once it ran) and takes the session again
  const three = r.engine.player({ url: SONG });
  const p3 = three.play();
  await r.prepared();
  await p3;
  assert.deepEqual([r.ctx().resumes, r.ctx().state, r.nav.audioSession.type], [2, 'running', 'playback']);
  // a play while the suspend is still in flight (it reads 'running') resumes after it
  three.pause();
  await r.clock.advance(IDLE_MS);
  r.ctx().state = 'running';
  r.engine._suspending = new Promise(() => {});
  three.play();
  assert.equal(r.ctx().resumes, 3);
});

test('a session type the page set itself is given back as it was; none where there is no audioSession', async () => {
  const r = midiRig();
  r.nav.audioSession.type = 'ambient';
  const { a, p } = await up(r);
  await p;
  a.pause();
  await r.clock.advance(IDLE_MS);
  assert.equal(r.nav.audioSession.type, 'ambient');
  const s = midiRig({ session: false });
  const u = await up(s);
  await u.p;
  assert.equal(s.nav.audioSession, undefined);
});

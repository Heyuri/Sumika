// The MIDI player's engine side (docs/research/midi.md §5): src/midi/engine.js bundled as ESM with
// tools/build.mjs's MIDI options (core and stb-vorbis aliased to the pinned vendor folders) into the OS temp folder.
// songOf (durations from tick 0 to the file's last event), bankBytes (gzip and raw SF3, what is not the bank), the
// Worker's per-song SF2 (one preset for each of Katari's files, the same bytes again; every velocity of a used key
// kept), SongPlayer rendered offline (sound, the end within a quantum, loop, seeks at the end on every Katari file,
// the command numbers echoed, the tail after the last voice, close, failures, a load in slices while another song
// sounds: core's preload a voice per step, commands held until ready, the same samples as a load in one go), the
// Worker's protocol on fakes (the download at `bank`, the reload retry, a stall, one download for two songs, a failure
// forgotten), and the published IIFE in vm scopes: as an AudioWorklet (no TextDecoder, atob, timers, fetch or
// performance; with and without WebAssembly; the Vorbis decoder never instantiated there; a second node's load in
// slices while the first sounds) and as a classic Worker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { checkMidiPins, readMidiPins, midiOptions } from '../tools/build.mjs';
import { needs } from './needs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KATARI = path.join(root, 'site', 'ghost', 'katari', 'ghost', 'master');
const SONGS = { 'm_birthday.mid': 69.973, 'm_canon.mid': 54.381, 'm_holy.mid': 41.786, 'm_xmas.mid': 39.496 };
const SR = 44100;
const Q = 128;

const vendor = checkMidiPins(readMidiPins());
const SF3 = new Uint8Array(vendor.bank);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-midi-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// the ESM build of the entry (plus core, for the reference renders and the checks), and the published IIFE
const esmOptions = midiOptions(vendor);
delete esmOptions.entryPoints;
await esbuild.build({
  ...esmOptions, format: 'esm', minify: false, sourcemap: false, write: true, outfile: path.join(tmp, 'engine.mjs'),
  stdin: {
    contents: "export * from './src/midi/engine.js';\nexport * as core from 'spessasynth_core';\n",
    resolveDir: root, loader: 'js', sourcefile: 'midi-test-entry.js',
  },
});
const m = await import(pathToFileURL(path.join(tmp, 'engine.mjs')).href);
const { core } = m;
const published = await esbuild.build({ ...midiOptions(vendor), outfile: path.join(tmp, 'midi.js') });
const IIFE = Buffer.from(published.outputFiles.find(f => f.path.endsWith('.js')).contents).toString('utf8');
core.SpessaLog.setLogLevel(false, false, false);
await core.BasicSoundBank.isSF3DecoderReady;

const katari = name => fs.readFileSync(path.join(KATARI, name));
const ab = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// ---- a small SMF writer: events [tick, bytes] (meta [0xff, type, ...data], sysex [0xf0, ...data]) ----

const vlq = n => { const out = [n & 0x7f]; while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (id, body) => [...Buffer.from(id, 'latin1'), ...be32(body.length), ...body];
function smf(tracks, division = 480) {
  const out = chunk('MThd', [0, tracks.length > 1 ? 1 : 0, 0, tracks.length, division >> 8, division & 255]);
  for (const events of tracks) {
    const body = [];
    let t = 0;
    for (const [tick, msg] of [...events].sort((a, b) => a[0] - b[0])) {
      body.push(...vlq(tick - t));
      t = tick;
      if (msg[0] === 0xff) body.push(0xff, msg[1], ...vlq(msg.length - 2), ...msg.slice(2));
      else if (msg[0] === 0xf0) body.push(0xf0, ...vlq(msg.length - 1), ...msg.slice(1));
      else body.push(...msg);
    }
    out.push(...chunk('MTrk', body));
  }
  return new Uint8Array(out);
}
const TEMPO_120 = [0, [0xff, 0x51, 0x07, 0xa1, 0x20]]; // 120 BPM: at 480 ticks a beat, 960 ticks a second
const sec = s => Math.round(s * 960);
const EOT = s => [sec(s), [0xff, 0x2f]];

/** A song whose voices end at 1 s and whose track ends at 3 s. */
const RESTS = smf([[TEMPO_120, [0, [0xc0, 0]], [0, [0x90, 60, 100]], [sec(1), [0x80, 60, 0]], EOT(3)]]);
/** Program 10 at 0 s, a note held 1–5 s, program 40 and CC 7 = 50 at 2 s, a program 40 note at 6 s, the end at 7 s. */
const SEEKER = smf([[TEMPO_120, [0, [0xc0, 10]], [sec(1), [0x90, 60, 100]], [sec(2), [0xc0, 40]], [sec(2), [0xb0, 7, 50]],
  [sec(5), [0x80, 60, 0]], [sec(6), [0x90, 72, 100]], [sec(6.5), [0x80, 72, 0]], EOT(7)]]);

/** A player with its messages; `now` follows the frames it rendered; `o`: SongPlayer's busy and clock. */
function player(bank, midi, o = {}) {
  const msgs = [];
  const clock = { t: 0 };
  const p = new m.SongPlayer({ sampleRate: SR, post: x => msgs.push(x), now: () => clock.t, ...o });
  if (bank) p.message({ t: 'load', sf2: bank, midi: ab(midi) });
  return { p, msgs, clock };
}

/** Render seconds (or until `stop` says so); the peak, the quanta rendered, whether render still answered true. */
function render(x, seconds, { stop = null, keep = null } = {}) {
  const L = new Float32Array(Q), R = new Float32Array(Q);
  let peak = 0;
  const n = Math.round(seconds * SR / Q);
  for (let i = 0; i < n; i++) {
    L.fill(0); R.fill(0);
    const alive = x.p.render(L, R);
    x.clock.t += Q / SR;
    for (let j = 0; j < Q; j++) peak = Math.max(peak, Math.abs(L[j]), Math.abs(R[j]));
    if (keep) keep(L, R, i);
    if (!alive) return { peak, quanta: i + 1, alive: false };
    if (stop && stop()) return { peak, quanta: i + 1, alive: true };
  }
  return { peak, quanta: n, alive: true };
}

const prepared = new Map();
async function sf2Of(name, bytes = katari(name)) {
  if (!prepared.has(name)) prepared.set(name, await m.prepareSong(m.songOf(bytes), SF3));
  return prepared.get(name).sf2.slice(0);
}

// ---------------------------------------------------------------- songOf

test('songOf: Katari\'s four files last from tick 0 to their last event; a file that rests after its last note ends at its end of track; a non-MIDI throws', needs('site/ghost/katari'), () => {
  for (const [name, d] of Object.entries(SONGS)) {
    const s = m.songOf(katari(name));
    assert.ok(Math.abs(s.duration - d) < 0.001, `${name}: ${s.duration}`);
  }
  const rests = m.songOf(RESTS);
  assert.ok(Math.abs(rests.duration - 3) < 1e-9, `the end of track at 3 s, not the last note at 1 s: ${rests.duration}`);
  assert.equal(rests.lastVoiceEventTick, sec(3));
  for (const bad of [Buffer.from('<!doctype html><html></html>'), new Uint8Array(0), Buffer.from('RIFF\0\0\0\0WAVEfmt ')]) {
    assert.throws(() => m.songOf(bad), /not a MIDI file/);
  }
  const body = Buffer.from(RESTS);
  const rmid = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('RMIDdata'), Buffer.alloc(4), body]);
  rmid.writeUInt32LE(rmid.length - 8, 4);
  rmid.writeUInt32LE(body.length, 16);
  const r = m.songOf(rmid);
  assert.ok(Math.abs(r.duration - 3) < 1e-9, 'an RMID wraps the same song');
  assert.equal(r.embeddedSoundBank, undefined);
});

/** What songSteps gives (its song and how often it yielded, or its error) next to songOf's song or error. */
function bothParses(bytes) {
  const outcome = f => { try { return { song: f() }; } catch (e) { return { error: `${e.name}: ${e.message}` }; } };
  let yields = 0;
  const steps = outcome(() => {
    const g = m.songSteps(bytes);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      yields++;
    }
  });
  return { steps, core: outcome(() => m.songOf(bytes)), yields };
}

/** A raw SMF from track bodies given as bytes (delta times, running status and all, as written). */
function rawSmf(format, division, bodies) {
  const out = chunk('MThd', [0, format, 0, bodies.length, division >> 8, division & 255]);
  for (const b of bodies) out.push(...chunk('MTrk', b));
  return new Uint8Array(out);
}

test('songSteps: the song songOf gives, byte for byte (Katari\'s four; running status, sysex, meta, format 1 and 2; a track cut short; an RMID through core\'s parse), a step every SONG_STEP_EVENTS events and one before the flush; core\'s errors', needs('site/ghost/katari'), () => {
  // running status, a sysex, a text, a marker and a tempo meta, two tracks
  const running = [0, 0x90, 60, 100, 120, 62, 100, 120, 64, 100, 0, 0x80, 60, 0, 0, 62, 0, 0, 64, 0,
    0, 0xf0, 4, 0x41, 0x10, 0x42, 0xf7, 0, 0xff, 0x01, 3, 0x61, 0x62, 0x63, 0, 0xff, 0x06, 4, 0x6c, 0x6f, 0x6f, 0x70,
    ...vlq(240), 0xc0, 5, 0, 0x90, 67, 90, ...vlq(480), 67, 0, 0, 0xff, 0x2f, 0];
  const tempo = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xff, 0x03, 2, 0x41, 0x42, ...vlq(960), 0xff, 0x2f, 0];
  const many = [];
  for (let i = 0; i < 700; i++) many.push(0, 0x90, 40 + (i % 40), 80, 30, 0x80, 40 + (i % 40), 0);
  many.push(0, 0xff, 0x2f, 0);
  const files = { RESTS, SEEKER, running: rawSmf(1, 480, [tempo, running]), format2: rawSmf(2, 96, [tempo, running, many]), many: rawSmf(0, 480, [many]) };
  for (const name of Object.keys(SONGS)) files[name] = katari(name);
  const cut = Buffer.from(files.running);
  files.cut = cut.subarray(0, cut.length - 9); // the last track's chunk says more bytes than the file has
  for (const [name, bytes] of Object.entries(files)) {
    const { steps, core: ref, yields } = bothParses(bytes);
    assert.ok(ref.song, `${name}: core parses it (${ref.error})`);
    assert.deepStrictEqual(steps, ref, name);
    const events = ref.song.tracks.reduce((n, t) => n + t.events.length, 0);
    assert.equal(yields, Math.floor(events / m.SONG_STEP_EVENTS) + 1, `${name}: ${events} events`);
  }
  assert.ok(bothParses(files.many).yields >= 6, 'the 1,400-event file in several steps');
  // an RMID: core's parse, in one step
  const body = Buffer.from(RESTS);
  const rmid = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('RMIDdata'), Buffer.alloc(4), body]);
  rmid.writeUInt32LE(rmid.length - 8, 4);
  rmid.writeUInt32LE(body.length, 16);
  const r = bothParses(rmid);
  assert.deepStrictEqual(r.steps, r.core);
  assert.equal(r.yields, 0);
  // what core refuses, songSteps refuses with core's words
  const noRunning = rawSmf(0, 480, [[0, 60, 100, 0, 0xff, 0x2f, 0]]);
  const badHeader = Buffer.from(rawSmf(0, 480, [tempo]));
  badHeader[7] = 7;
  const badTrack = Buffer.from(rawSmf(0, 480, [tempo]));
  badTrack.write('MTrx', 14, 'latin1');
  for (const bytes of [noRunning, badHeader, badTrack, Buffer.from('not midi at all')]) {
    const { steps, core: ref } = bothParses(bytes);
    assert.ok(ref.error, 'core refuses it');
    assert.deepStrictEqual(steps, ref);
  }
});

// ---------------------------------------------------------------- bankBytes

test('bankBytes: a gzip of the bank inflates to the pinned SF3 (header fields skipped); raw SF3 passes; HTML, a truncated gzip, a wrong CRC or length throw', () => {
  const gz = zlib.gzipSync(SF3, { level: 1 });
  const out = m.bankBytes(gz);
  assert.ok(Buffer.from(out.buffer, out.byteOffset, out.byteLength).equals(Buffer.from(SF3)));
  assert.equal(m.bankBytes(SF3), SF3, 'the bank itself (a host that sent Content-Encoding: gzip)');
  // FEXTRA, FNAME and FCOMMENT fields
  const named = Buffer.concat([gz.subarray(0, 3), Buffer.from([4 | 8 | 16]), gz.subarray(4, 10), Buffer.from([3, 0, 1, 2, 3]),
    Buffer.from('GeneralUserGS.sf3\0a comment\0'), gz.subarray(10)]);
  assert.equal(m.bankBytes(named).length, SF3.length);
  assert.throws(() => m.bankBytes(Buffer.from('<!doctype html><title>404</title>')), /not the sound bank/);
  assert.throws(() => m.bankBytes(gz.subarray(0, gz.length >> 1)), /not the sound bank/);
  const crc = Buffer.from(gz); crc[crc.length - 8] ^= 1;
  assert.throws(() => m.bankBytes(crc), /CRC-32/);
  const len = Buffer.from(gz); len.writeUInt32LE(0xfffffff0, len.length - 4);
  assert.throws(() => m.bankBytes(len), /gzip length/, 'an ISIZE no DEFLATE stream can reach: nothing that size is allocated');
  const riff = Buffer.from(SF3.subarray(0, 4096)); // the right header, the wrong length
  assert.throws(() => m.bankBytes(riff), /not the sound bank/);
  assert.equal(m.crc32(Buffer.from('123456789')), 0xcbf43926);
});

// ---------------------------------------------------------------- the Worker's per-song SF2

test('prepareSong: each Katari file gets an SF2 with one preset; the same song from the same SF3 again gives the same bytes; the SF3 is not changed', needs('site/ghost/katari'), async () => {
  const sha = u8 => crypto.createHash('sha256').update(u8).digest('hex');
  const first = await m.prepareSong(m.songOf(katari('m_canon.mid')), SF3);
  const other = await m.prepareSong(m.songOf(katari('m_holy.mid')), SF3);
  const again = await m.prepareSong(m.songOf(katari('m_canon.mid')), SF3);
  assert.ok(Buffer.from(first.sf2).equals(Buffer.from(again.sf2)), 'identical SF2 bytes');
  assert.equal(sha(SF3), readMidiPins().bank.sha256, 'the SF3 is not changed by a trim');
  assert.ok(other.sf2.byteLength > 0);
  for (const name of Object.keys(SONGS)) {
    const r = await m.prepareSong(m.songOf(katari(name)), SF3);
    const bank = core.SoundBankLoader.fromArrayBuffer(r.sf2);
    assert.equal(bank.presets.length, 1, name);
    assert.equal(r.presets, 1);
    assert.ok(r.sf2.byteLength < 200000, `${name}: ${r.sf2.byteLength} B`);
  }
});

test('usedKeys: every velocity of each key the song plays (velocity sense moves the layer), every key when it retunes keys, one preset for a song with no note', () => {
  const bank = core.SoundBankLoader.fromArrayBuffer(ab(SF3));
  const used = m.usedKeys(m.songOf(SEEKER), bank);
  assert.deepEqual([...used.keys()].map(p => p.program).sort((a, b) => a - b), [10, 40]);
  for (const keys of used.values()) {
    for (const v of keys.values()) assert.equal(v.size, 128);
  }
  assert.deepEqual([...[...used.values()].find(k => k.has(60)).keys()], [60]);
  // a single-note tuning change (F0 7F 7F 08 02 …): every key
  const tuned = smf([[TEMPO_120, [0, [0xf0, 0x7f, 0x7f, 0x08, 0x02, 0x00, 0x01, 60, 62, 0, 0, 0xf7]], [0, [0xc0, 10]],
    [0, [0x90, 60, 100]], [sec(1), [0x80, 60, 0]], EOT(2)]]);
  const all = m.usedKeys(m.songOf(tuned), bank);
  assert.equal([...all.values()][0].size, 128);
  const silent = smf([[TEMPO_120, [0, [0xc0, 10]], EOT(1)]]);
  const one = m.usedKeys(m.songOf(silent), bank);
  assert.equal(one.size, 1, 'a song with no note keeps one preset');
});

// ---------------------------------------------------------------- SongPlayer, offline

test('SongPlayer: each Katari file sounds in its first 5 s; ready carries the duration; play answers a state', needs('site/ghost/katari'), async () => {
  for (const name of Object.keys(SONGS)) {
    const x = player(await sf2Of(name), katari(name));
    x.p.message({ t: 'play', n: 1 });
    assert.equal(x.msgs[0].t, 'ready');
    assert.ok(Math.abs(x.msgs[0].duration - SONGS[name]) < 0.001);
    assert.deepEqual({ ...x.msgs[1], at: 0 }, { t: 'state', playing: true, pos: 0, at: 0, n: 1 });
    const r = render(x, 5);
    assert.ok(r.peak > 0.01, `${name}: peak ${r.peak}`);
    assert.ok(r.alive);
    assert.ok(!x.msgs.some(y => y.t === 'error'), JSON.stringify(x.msgs));
  }
});

test('SongPlayer: the end comes within a quantum of the duration; with loop on the song starts over at 0 and nothing ends; close renders the tail, then closed and render false', needs('site/ghost/katari'), async () => {
  const name = 'm_holy.mid';
  const d = SONGS[name];
  const x = player(await sf2Of(name), katari(name));
  x.p.message({ t: 'seek', time: d - 2, n: 1 });
  x.p.message({ t: 'play', n: 2 });
  const r = render(x, 3, { stop: () => x.msgs.some(y => y.t === 'ended') });
  const ended = x.msgs.find(y => y.t === 'ended');
  assert.ok(ended, JSON.stringify(x.msgs));
  const t = r.quanta * Q / SR;
  assert.ok(t >= 2 - 1e-9 && t <= 2 + 2 * Q / SR, `ended after ${t} s of song`);
  assert.deepEqual(ended, { t: 'ended', pos: x.p.duration, n: 2 });
  assert.equal(x.p.position(), x.p.duration);

  const y = player(await sf2Of(name), katari(name));
  y.p.message({ t: 'loop', on: true, n: 1 });
  y.p.message({ t: 'seek', time: d - 1, n: 2 });
  y.p.message({ t: 'play', n: 3 });
  y.msgs.length = 0;
  render(y, 3);
  assert.ok(!y.msgs.some(z => z.t === 'ended'), 'no end with loop');
  const over = y.msgs.filter(z => z.t === 'state');
  assert.equal(over.length, 1, JSON.stringify(y.msgs));
  assert.deepEqual({ ...over[0], at: 0 }, { t: 'state', playing: true, pos: 0, at: 0, n: 3 });
  assert.ok(over[0].at > 0.99 && over[0].at < 1.01, `started over at ${over[0].at} s of context time`);
  const p = y.p.position();
  assert.ok(p > 1.9 && p < 2.1, `2 s into the second round: ${p}`);

  // close while notes sound (m_canon at 10 s)
  const z = player(await sf2Of('m_canon.mid'), katari('m_canon.mid'));
  z.p.message({ t: 'seek', time: 10, n: 1 });
  z.p.message({ t: 'play', n: 2 });
  render(z, 0.5);
  assert.ok(z.p.synth.voiceCount > 0, 'notes sound');
  z.p.message({ t: 'close', n: 3 });
  assert.ok(!z.msgs.some(w => w.t === 'closed'), 'sounding: the tail is rendered first');
  const r3 = render(z, 3);
  assert.equal(r3.alive, false);
  assert.ok(r3.peak > 0.001, 'the release and the reverb ring on');
  const tail = r3.quanta * Q / SR;
  assert.ok(tail >= m.CLOSE_TAIL_S - Q / SR && tail <= m.CLOSE_TAIL_S + Q / SR, `closed after ${tail} s`);
  assert.deepEqual(z.msgs.at(-1), { t: 'closed' });
  z.p.message({ t: 'play', n: 4 });
  assert.equal(z.msgs.filter(w => w.t === 'closed').length, 1, 'nothing after closed');
  assert.equal(z.msgs.at(-1).t, 'closed');
});

test('SongPlayer: seeks at and past the end never reach the sequencer (core 4.3.22 throws there): paused it is the end and play starts at 0; playing the song ends, or starts over with loop', needs('site/ghost/katari'), async () => {
  const L = new Float32Array(Q), R = new Float32Array(Q);
  for (const name of Object.keys(SONGS)) {
    const sf2 = await sf2Of(name);
    const d = SONGS[name];
    for (const [k, t] of [x => x, x => x - 1e-9, x => x - 0.0005, x => x - 0.001, x => x + 5, () => Infinity].entries()) {
      // paused
      const a = player(sf2, katari(name));
      a.p.message({ t: 'seek', time: t(a.p.duration), n: 1 });
      assert.deepEqual(a.msgs.at(-1).pos, a.p.duration, `${name} paused: at the end`);
      a.p.message({ t: 'play', n: 2 });
      assert.deepEqual({ ...a.msgs.at(-1), at: 0 }, { t: 'state', playing: true, pos: 0, at: 0, n: 2 }, `${name}: play from the end starts at 0`);
      const r = render(a, k ? 0.1 : 4);
      if (!k) assert.ok(r.peak > 0.01, `${name}: it plays from the start`);
      // playing
      const b = player(sf2, katari(name));
      b.p.message({ t: 'play', n: 1 });
      render(b, 0.1);
      b.p.message({ t: 'seek', time: t(b.p.duration), n: 2 });
      assert.deepEqual(b.msgs.at(-1), { t: 'ended', pos: b.p.duration, n: 2 }, `${name} playing: the seek ends the song`);
      L.fill(0); R.fill(0);
      assert.equal(b.p.render(L, R), true);
      // playing with loop
      const c = player(sf2, katari(name));
      c.p.message({ t: 'loop', on: true, n: 1 });
      c.p.message({ t: 'play', n: 2 });
      render(c, 0.1);
      c.p.message({ t: 'seek', time: t(c.p.duration), n: 3 });
      assert.deepEqual({ ...c.msgs.at(-1), at: 0 }, { t: 'state', playing: true, pos: 0, at: 0, n: 3 });
      for (const x of [a, b, c]) assert.ok(!x.msgs.some(y => y.t === 'error'), `${name}: ${JSON.stringify(x.msgs.filter(y => y.t === 'error'))}`);
    }
    // just inside the guard the sequencer takes it, and the song ends from there
    const e = player(sf2, katari(name));
    e.p.message({ t: 'seek', time: d - 0.002, n: 1 });
    e.p.message({ t: 'play', n: 2 });
    render(e, 0.1, { stop: () => e.msgs.some(y => y.t === 'ended') });
    assert.ok(e.msgs.some(y => y.t === 'ended'), name);
    assert.ok(!e.msgs.some(y => y.t === 'error'), name);
  }
});

test('SongPlayer: a seek replays programs and controllers and leaves no note sounding; pause keeps the position; play after the end starts at 0', async () => {
  const sf2 = await sf2Of('seeker', SEEKER);
  const x = player(sf2, SEEKER);
  x.p.message({ t: 'seek', time: 3, n: 1 });
  const ch = x.p.synth.midiChannels[0];
  assert.equal(ch.patch.program, 40);
  assert.equal(ch.midiControllers[7] >> 7, 50);
  assert.equal(x.p.synth.voiceCount, 0);
  assert.deepEqual({ ...x.msgs.at(-1), at: 0 }, { t: 'state', playing: false, pos: 3, at: 0, n: 1 });
  x.p.message({ t: 'play', n: 2 });
  let most = 0;
  render(x, 0.5, { keep: () => { most = Math.max(most, x.p.synth.voiceCount); } });
  assert.equal(most, 0, 'the note held from 1 s to 5 s is not sounded from 3 s');
  x.p.message({ t: 'pause', n: 3 });
  const at = x.msgs.at(-1);
  assert.equal(at.playing, false);
  assert.ok(Math.abs(at.pos - 3.5) < 2 * Q / SR, `paused at ${at.pos}`);
  render(x, 1);
  assert.equal(x.p.position(), at.pos, 'the position stays while paused');
  x.p.message({ t: 'play', n: 4 });
  const r = render(x, 5, { stop: () => x.msgs.some(y => y.t === 'ended') });
  assert.ok(r.peak > 0.01, 'the program 40 note at 6 s sounds');
  assert.deepEqual(x.msgs.at(-1), { t: 'ended', pos: 7, n: 4 });
  x.p.message({ t: 'play', n: 5 });
  assert.equal(x.msgs.at(-1).pos, 0, 'after the end, play starts at 0');
  render(x, 0.01);
  assert.equal(x.p.synth.midiChannels[0].patch.program, 10, 'with the song\'s first program again');
});

test('SongPlayer: a paused seek into a rest stays where it was sent (core alone jumps to the next event, and from the rest before the end of track play started over at 0)', async () => {
  const sf2 = await sf2Of('rests', RESTS);
  const x = player(sf2, RESTS);
  x.p.message({ t: 'seek', time: 2, n: 1 });
  assert.equal(x.msgs.at(-1).pos, 2);
  x.p.message({ t: 'play', n: 2 });
  assert.equal(x.msgs.at(-1).pos, 2);
  const r = render(x, 2, { stop: () => x.msgs.some(y => y.t === 'ended') });
  const t = r.quanta * Q / SR;
  assert.ok(t >= 1 && t <= 1 + 2 * Q / SR, `the last second of rest plays out: ended after ${t} s`);
  assert.deepEqual(x.msgs.at(-1), { t: 'ended', pos: 3, n: 2 });
  const y = player(sf2, RESTS);
  y.p.message({ t: 'seek', time: 0.5, n: 1 });
  y.p.message({ t: 'play', n: 2 });
  render(y, 0.3);
  const p = y.p.position();
  assert.ok(p > 0.79 && p < 0.81, `0.3 s after 0.5 s: ${p}`);
});

test('SongPlayer: state and ended echo the last command\'s number (midi.md §5.5); a command without one keeps it; a loop\'s start-over carries it', async () => {
  const sf2 = await sf2Of('rests', RESTS);
  const x = player(sf2, RESTS);
  x.p.message({ t: 'loop', on: true, n: 7 });
  assert.equal(x.msgs.at(-1).n, 7);
  x.p.message({ t: 'play' });
  assert.equal(x.msgs.at(-1).n, 7, 'no number: the last one stays');
  x.p.message({ t: 'seek', time: 2.9, n: 8 });
  render(x, 0.2);
  const over = x.msgs.at(-1);
  assert.equal(over.t, 'state');
  assert.equal(over.pos, 0);
  assert.equal(over.n, 8);
  x.p.message({ t: 'loop', on: false, n: 9 });
  x.p.message({ t: 'seek', time: 2.95, n: 10 });
  render(x, 0.2);
  assert.deepEqual(x.msgs.at(-1), { t: 'ended', pos: 3, n: 10 });
});

test('SongPlayer: after the last voice the synth renders TAIL_S more (the reverb tail), then no synth call; render stays true until close', async () => {
  const sf2 = await sf2Of('rests', RESTS);
  const x = player(sf2, RESTS);
  x.p.message({ t: 'play', n: 1 });
  render(x, 0.5);
  x.p.message({ t: 'pause', n: 2 });
  const t0 = x.p.synth.currentTime;
  let lastVoice = 0, tailPeak = 0;
  const r = render(x, 6, { keep: L => {
    if (x.p.synth.voiceCount > 0) lastVoice = x.p.synth.currentTime;
    else for (let j = 0; j < Q; j++) tailPeak = Math.max(tailPeak, Math.abs(L[j]));
  } });
  assert.ok(lastVoice > t0, 'the voices released after the pause');
  assert.ok(r.alive, 'nothing sounding: render answers true (a false return would stop process() for good)');
  const stopped = x.p.synth.currentTime;
  assert.ok(Math.abs(stopped - (lastVoice + m.TAIL_S)) <= 2 * Q / SR, `the synth stopped ${stopped - lastVoice} s after the last voice`);
  assert.ok(stopped > t0);
  assert.ok(tailPeak > 0, 'the tail after the last voice is not silence');
  render(x, 1);
  assert.equal(x.p.synth.currentTime, stopped, 'no synth call while nothing sounds');
  x.p.message({ t: 'close', n: 3 });
  assert.deepEqual(x.msgs.at(-1), { t: 'closed' }, 'nothing sounding: closed at once');
  assert.equal(render(x, 0.01).alive, false);
});

test('SongPlayer: failures become error (a bad SF2, a command before load); a failed player answers close at once and render false', needs('site/ghost/katari'), () => {
  const a = player(null, null);
  a.p.message({ t: 'play', n: 1 });
  assert.equal(a.msgs.at(-1).t, 'error');
  assert.equal(render(a, 0.01).alive, false);
  a.p.message({ t: 'close' });
  assert.deepEqual(a.msgs.at(-1), { t: 'closed' });
  const b = player(new Uint8Array(64).buffer, katari('m_holy.mid'));
  assert.equal(b.msgs.length, 1);
  assert.equal(b.msgs[0].t, 'error');
  b.p.message({ t: 'play' });
  assert.equal(b.msgs.length, 1, 'nothing after the error');
  const c = player(new Uint8Array(64).buffer, Buffer.from('not midi'));
  assert.equal(c.msgs[0].t, 'error');
});

/** The voice cache's keys (preset, key, velocity) of a synth. */
const voiceKeys = synth => [...synth.synthCore.cachedVoices.keys()].sort((a, b) => a - b);

test('SongPlayer: while another song sounds a load runs in slices from render, a step per LOAD_SLICE_MS (core\'s preload a voice per step); commands sent meanwhile apply after ready, in order; the song then renders as after a load in one go; once nothing else sounds the rest runs at once', needs('site/ghost/katari'), async () => {
  const name = 'm_canon.mid';
  const sf2 = await sf2Of(name);
  let ms = 0;
  // the clock moves a millisecond at each read, so every slice is exactly one step
  const x = player(sf2, katari(name), { busy: () => true, clock: () => ++ms });
  assert.deepEqual(x.msgs, [], 'another song sounds: nothing done at the load itself');
  assert.equal(x.p.synth, null);
  const commands = [{ t: 'loop', on: true, n: 1 }, { t: 'seek', time: 10, n: 2 }, { t: 'play', n: 3 }];
  for (const c of commands) x.p.message(c);
  assert.deepEqual(x.msgs, [], 'held until ready');
  const L = new Float32Array(Q), R = new Float32Array(Q);
  let quanta = 0;
  while (!x.msgs.length) {
    L.fill(0); R.fill(0);
    assert.equal(x.p.render(L, R), true);
    x.clock.t += Q / SR;
    assert.ok(++quanta < 10000, 'the load ends');
  }
  const first = [Float32Array.from(L), Float32Array.from(R)]; // the quantum that ended the load played already

  // core's own preloadSynth on a synth with the same SF2: the same voices, and a quantum for each besides five steps
  const ref = new core.SpessaSynthProcessor(SR, { effectsEnabled: true, eventsEnabled: false, maxBufferSize: Q });
  ref.soundBankManager.addSoundBank(core.SoundBankLoader.fromArrayBuffer(sf2.slice(0)), 'main');
  const song = m.songOf(katari(name));
  let voices = 0;
  for (const [, keys] of song.getUsedProgramsAndKeys(ref.soundBankManager)) for (const [, v] of keys) voices += v.size;
  song.preloadSynth(ref);
  assert.ok(voices > 10, `${voices} voices`);
  assert.deepEqual(voiceKeys(x.p.synth), voiceKeys(ref), 'the voices core\'s preloadSynth builds');
  const events = song.tracks.reduce((n, t) => n + t.events.length, 0);
  const songSteps = Math.floor(events / m.SONG_STEP_EVENTS) + 1;
  assert.ok(songSteps >= 2, `${events} events`);
  assert.equal(quanta, voices + songSteps + 5,
    'one step a quantum: the SF2, the song\'s events SONG_STEP_EVENTS at a time, its flush, the synth, the sequencer, the used keys with the first voice, each further voice, ready');
  ref.destroySynthProcessor();

  // the same commands to a player loaded in one go: the same answers, then the same samples
  const y = player(await sf2Of(name), katari(name));
  assert.equal(y.msgs[0].t, 'ready', 'busy() false (the default): in one go');
  for (const c of commands) y.p.message(c);
  const noAt = list => list.map(({ at, ...rest }) => rest);
  assert.deepEqual(noAt(x.msgs), noAt(y.msgs));
  assert.deepEqual(x.msgs.map(z => z.n), [undefined, 1, 2, 3]);
  const a = [], b = [...first];
  render(y, 200 * Q / SR, { keep: (l, r) => a.push(Float32Array.from(l), Float32Array.from(r)) });
  render(x, 199 * Q / SR, { keep: (l, r) => b.push(Float32Array.from(l), Float32Array.from(r)) });
  assert.equal(b.length, a.length);
  let peak = 0;
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(b[i], a[i], `quantum ${i >> 1} after ready`);
    for (const v of a[i]) peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(peak > 0.01, `m_canon sounds at 10 s: ${peak}`);

  // the other song falls quiet during the load: the rest runs in the next quantum
  let busy = true;
  const z = player(await sf2Of(name), katari(name), { busy: () => busy, clock: () => ++ms });
  render(z, 3 * Q / SR);
  assert.deepEqual(z.msgs, []);
  busy = false;
  render(z, Q / SR);
  assert.equal(z.msgs.length, 1);
  assert.equal(z.msgs[0].t, 'ready');
  assert.deepEqual(voiceKeys(z.p.synth), voiceKeys(x.p.synth));
});

test('SongPlayer: a close during a sliced load drops it with the commands held for it (closed at once, never ready, render false); a step that throws there fails from render', needs('site/ghost/katari'), async () => {
  let ms = 0;
  const x = player(await sf2Of('m_holy.mid'), katari('m_holy.mid'), { busy: () => true, clock: () => ++ms });
  assert.equal(render(x, 3 * Q / SR).alive, true);
  x.p.message({ t: 'play', n: 1 });
  assert.deepEqual(x.msgs, []);
  x.p.message({ t: 'close', n: 2 });
  assert.deepEqual(x.msgs, [{ t: 'closed' }]);
  assert.equal(render(x, 0.01).alive, false);
  assert.deepEqual(x.msgs, [{ t: 'closed' }], 'no ready, and the held play was dropped');
  const y = player(new Uint8Array(64).buffer, katari('m_holy.mid'), { busy: () => true });
  assert.deepEqual(y.msgs, [], 'the bad SF2 is parsed at the first render');
  assert.equal(render(y, 0.01).alive, false);
  assert.equal(y.msgs.length, 1);
  assert.equal(y.msgs[0].t, 'error');
  y.p.message({ t: 'close' });
  assert.deepEqual(y.msgs.at(-1), { t: 'closed' });
});

test('SongPlayer: trim fidelity: m_canon\'s first 10 s on its prepared SF2 equal those on the full SF3', needs('site/ghost/katari'), async () => {
  const name = 'm_canon.mid';
  const full = player(ab(SF3), katari(name));
  const trim = player(await sf2Of(name), katari(name));
  full.p.message({ t: 'play' });
  trim.p.message({ t: 'play' });
  const a = [];
  render(full, 10, { keep: (L, R) => a.push(Float32Array.from(L), Float32Array.from(R)) });
  let i = 0, diff = 0, peak = 0;
  render(trim, 10, { keep: (L, R) => {
    for (const [ref, got] of [[a[i++], L], [a[i++], R]]) for (let j = 0; j < Q; j++) { diff = Math.max(diff, Math.abs(ref[j] - got[j])); peak = Math.max(peak, Math.abs(ref[j])); }
  } });
  assert.ok(peak > 0.05, `the reference sounds: ${peak}`);
  assert.ok(diff < 1e-4, `max abs difference ${diff}`);
});

// ---------------------------------------------------------------- the Worker's protocol, on fakes

/** Fake timers on a virtual clock: `advance(ms)` runs those due, and says how many ran. */
function timers() {
  let id = 0, now = 0;
  const pending = new Map();
  return {
    setTimeout: (f, ms) => { pending.set(++id, { f, due: now + ms }); return id; },
    clearTimeout: t => { pending.delete(t); },
    advance(ms) {
      now += ms;
      let ran = 0;
      for (const [k, p] of [...pending].sort((a, b) => a[1].due - b[1].due)) {
        if (p.due > now) continue;
        pending.delete(k);
        p.f();
        ran++;
      }
      return ran;
    },
    get size() { return pending.size; },
  };
}
const tick = () => new Promise(r => setImmediate(r));
async function until(pred, what, ms = 20000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

let tinyBank = null;
/** A small SF2 as "the bank" (m_holy's prepared SF2: `RIFF` `sfbk` like the SF3), so these tests parse fast. */
async function tiny() {
  if (!tinyBank) tinyBank = Buffer.from(zlib.gzipSync(Buffer.from(await sf2Of('m_holy.mid'))));
  return tinyBank;
}
const response = (bytes, status = 200) => new Response(status === 200 ? bytes : 'nope', { status });

function worker(fetch) {
  const t = timers();
  const out = [];
  const w = new m.BankWorker({ fetch, post: (msg, transfer) => out.push({ msg, transfer }), setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, AbortController });
  return { w, out, t, msgs: () => out.map(o => o.msg) };
}

test('BankWorker: the download starts at `bank`; a prepare answers prepared with the SF2, the MIDI bytes back (both transferred) and the duration', needs('site/ghost/katari'), async () => {
  const gz = await tiny();
  const calls = [];
  const x = worker(async (url, o) => { calls.push([url, o.cache]); return response(gz); });
  x.w.message({ t: 'bank', url: 'https://site.example/sumika/engines/generaluser_gs.0123456789.sf3.gz' });
  assert.deepEqual(calls, [['https://site.example/sumika/engines/generaluser_gs.0123456789.sf3.gz', 'force-cache']], 'at once, before any prepare');
  const midi = ab(katari('m_holy.mid'));
  x.w.message({ t: 'prepare', id: 1, midi });
  x.w.message({ t: 'prepare', id: 2, midi: ab(SEEKER) });
  await until(() => x.out.length === 2, 'two answers');
  assert.equal(calls.length, 1, 'one download for both');
  const [a, b] = x.out;
  assert.equal(a.msg.t, 'prepared');
  assert.equal(a.msg.id, 1);
  assert.ok(Math.abs(a.msg.duration - SONGS['m_holy.mid']) < 0.001);
  assert.deepEqual(a.transfer, [a.msg.sf2, a.msg.midi]);
  assert.equal(a.msg.midi, midi, 'the MIDI bytes go back to the page for the worklet');
  assert.equal(core.SoundBankLoader.fromArrayBuffer(a.msg.sf2).presets.length, 1);
  assert.equal(b.msg.id, 2);
  assert.equal(b.msg.duration, 7);
  assert.equal(x.t.size, 0, 'no stall timer left');
});

test('BankWorker: no 2xx or not the bank: once more with reload; still bad: failed kind bank, forgotten, so the next prepare downloads again; a network error fails at once; a non-MIDI fails kind midi', needs('site/ghost/katari'), async () => {
  const gz = await tiny();
  let answers = [response('x', 404), response(gz)];
  const calls = [];
  const x = worker(async (url, o) => { calls.push(o.cache); return answers.shift(); });
  x.w.message({ t: 'bank', url: 'https://h/b.sf3.gz' });
  x.w.message({ t: 'prepare', id: 1, midi: ab(RESTS) });
  await until(() => x.out.length === 1, 'prepared');
  assert.deepEqual(calls, ['force-cache', 'reload']);
  assert.equal(x.out[0].msg.t, 'prepared');

  calls.length = 0;
  answers = [response(Buffer.from('<html>')), response(Buffer.from('<html>')), response(gz)];
  const y = worker(async (url, o) => { calls.push(o.cache); return answers.shift(); });
  y.w.message({ t: 'bank', url: 'https://h/b.sf3.gz' });
  y.w.message({ t: 'prepare', id: 1, midi: ab(RESTS) });
  await until(() => y.out.length === 1, 'failed');
  assert.deepEqual(y.msgs()[0], { t: 'failed', id: 1, kind: 'bank', message: 'not the sound bank fetching https://h/b.sf3.gz' });
  assert.deepEqual(calls, ['force-cache', 'reload']);
  y.w.message({ t: 'prepare', id: 2, midi: ab(RESTS) });
  await until(() => y.out.length === 2, 'prepared after a new download');
  assert.equal(y.msgs()[1].t, 'prepared');
  assert.deepEqual(calls, ['force-cache', 'reload', 'force-cache']);

  let n = 0;
  const z = worker(async () => { n++; throw new TypeError('Failed to fetch'); });
  z.w.message({ t: 'bank', url: 'https://h/b.sf3.gz' });
  z.w.message({ t: 'prepare', id: 1, midi: ab(RESTS) });
  z.w.message({ t: 'prepare', id: 2, midi: ab(Buffer.from('<html>')) });
  await until(() => z.out.length === 2, 'two failures');
  const by = Object.fromEntries(z.msgs().map(msg => [msg.id, msg]));
  assert.equal(by[1].kind, 'bank');
  assert.match(by[1].message, /Failed to fetch/);
  assert.equal(by[2].kind, 'midi');
  assert.match(by[2].message, /not a MIDI file/);
  assert.equal(n, 1, 'a network error is not retried in the same attempt');

  const q = worker(async () => response(gz));
  q.w.message({ t: 'prepare', id: 1, midi: ab(RESTS) });
  await until(() => q.out.length === 1, 'failed');
  assert.equal(q.msgs()[0].kind, 'bank', 'no bank URL yet');
});

test('BankWorker: a body that stalls BANK_STALL_MS fails kind bank and is aborted; a slow body whose chunks keep coming does not', needs('site/ghost/katari'), async () => {
  const gz = await tiny();
  const half = gz.length >> 1;
  let aborted = 0;
  const stalling = (url, o) => {
    o.signal.addEventListener('abort', () => aborted++);
    let sent = false;
    return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({ read: () => {
      if (!sent) { sent = true; return Promise.resolve({ done: false, value: new Uint8Array(gz.subarray(0, half)) }); }
      return new Promise(() => {}); // no more data, ever
    } }) } });
  };
  const x = worker(stalling);
  x.w.message({ t: 'bank', url: 'https://h/b.sf3.gz' });
  x.w.message({ t: 'prepare', id: 1, midi: ab(RESTS) });
  for (let i = 0; i < 10; i++) await tick(); // the first chunk is in
  assert.equal(x.t.advance(m.BANK_STALL_MS - 1), 0, 'not yet');
  assert.equal(x.t.advance(1), 1);
  await until(() => x.out.length === 1, 'failed');
  assert.equal(x.msgs()[0].kind, 'bank');
  assert.match(x.msgs()[0].message, /stalled/);
  assert.equal(aborted, 1);
  assert.equal(x.t.size, 0);

  // a slow body: every chunk arrives just inside the stall time; the whole takes far longer than it
  const parts = [];
  for (let at = 0; at < gz.length; at += 8192) parts.push(new Uint8Array(gz.subarray(at, at + 8192)));
  const y = worker(async () => ({ ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(r => { waiting = r; }) }) } }));
  let waiting = null;
  y.w.message({ t: 'bank', url: 'https://h/b.sf3.gz' });
  y.w.message({ t: 'prepare', id: 1, midi: ab(RESTS) });
  for (const p of [...parts, null]) {
    await until(() => waiting, 'a read');
    assert.equal(y.t.advance(m.BANK_STALL_MS - 1), 0, 'each chunk restarts the stall time');
    const r = waiting;
    waiting = null;
    r(p ? { done: false, value: p } : { done: true, value: undefined });
  }
  await until(() => y.out.length === 1, 'prepared');
  assert.equal(y.msgs()[0].t, 'prepared');
  assert.ok(parts.length >= 2, 'longer than the stall time in all');
});

// ---------------------------------------------------------------- the published IIFE in vm scopes

const quietConsole = () => ({ info() {}, warn() {}, log() {}, error() {}, debug() {}, group() {}, groupEnd() {}, groupCollapsed() {} });

/** An AudioWorkletGlobalScope: registerProcessor, AudioWorkletProcessor with a port, sampleRate, currentTime, console. */
function workletScope({ wasm = true } = {}) {
  const registered = new Map();
  const ctx = vm.createContext({ console: quietConsole(), sampleRate: SR, currentTime: 0, registerProcessor: (name, cls) => registered.set(name, cls) });
  vm.runInContext(`
    globalThis.__posted = [];
    globalThis.AudioWorkletProcessor = class AudioWorkletProcessor {
      constructor() { this.port = { onmessage: null, postMessage: (m) => globalThis.__posted.push(m) }; }
    };
    globalThis.__wasm = 0;
    if (typeof WebAssembly === 'object') {
      for (const k of ['instantiate', 'compile', 'Module', 'Instance']) {
        const f = WebAssembly[k];
        WebAssembly[k] = function (...a) { globalThis.__wasm++; return new.target ? new f(...a) : f.apply(this, a); };
      }
    }
    ${wasm ? '' : 'delete globalThis.WebAssembly;'}
  `, ctx);
  return { ctx, registered };
}

test('the IIFE as an AudioWorklet module: registers sumika-midi in a scope without TextDecoder, atob, timers, fetch or performance, with and without WebAssembly; load and play give sound; the Vorbis decoder is never instantiated there', needs('site/ghost/katari'), async () => {
  const sf2 = await sf2Of('m_canon.mid');
  for (const wasm of [true, false]) {
    const { ctx, registered } = workletScope({ wasm });
    for (const k of ['TextDecoder', 'atob', 'setTimeout', 'fetch', 'performance', 'importScripts']) {
      assert.equal(vm.runInContext(`typeof ${k}`, ctx), 'undefined', k);
    }
    assert.equal(vm.runInContext('typeof WebAssembly', ctx), wasm ? 'object' : 'undefined');
    const unhandled = [];
    const onUnhandled = e => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      vm.runInContext(IIFE, ctx, { filename: 'midi.js' });
      for (let i = 0; i < 10; i++) await tick();
      assert.deepEqual([...registered.keys()], ['sumika-midi']);
      const Proc = registered.get('sumika-midi');
      const node = new Proc();
      node.port.onmessage({ data: { t: 'load', sf2: sf2.slice(0), midi: ab(katari('m_canon.mid')) } });
      node.port.onmessage({ data: { t: 'play', n: 1 } });
      const posted = JSON.parse(vm.runInContext('JSON.stringify(__posted)', ctx));
      assert.deepEqual(posted.map(x => x.t), ['ready', 'state'], JSON.stringify(posted));
      let peak = 0;
      const L = new Float32Array(Q), R = new Float32Array(Q);
      for (let i = 0; i < 4 * SR / Q; i++) {
        L.fill(0); R.fill(0);
        assert.equal(node.process([], [[L, R]], {}), true);
        ctx.currentTime += Q / SR;
        for (let j = 0; j < Q; j++) peak = Math.max(peak, Math.abs(L[j]));
      }
      assert.ok(peak > 0.01, `wasm ${wasm}: peak ${peak}`);
      // a mono output gets a scratch right channel
      const mono = new Float32Array(Q);
      assert.equal(node.process([], [[mono]], {}), true);
      assert.equal(vm.runInContext('__wasm', ctx), 0, 'no WebAssembly compiled or instantiated in the worklet');
      for (let i = 0; i < 10; i++) await tick();
      assert.deepEqual(unhandled, [], 'no unhandled rejection');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }
});

test('the IIFE as an AudioWorklet module: a load while another node sounds runs in slices from process() (no ready at the load; the sounding node plays on), a load while none sounds in one go; a node that closed leaves', needs('site/ghost/katari'), async () => {
  const canon = await sf2Of('m_canon.mid'), holy = await sf2Of('m_holy.mid');
  const { ctx, registered } = workletScope();
  vm.runInContext(IIFE, ctx, { filename: 'midi.js' });
  for (let i = 0; i < 10; i++) await tick();
  const Proc = registered.get('sumika-midi');
  const node = () => {
    const n = new Proc();
    const posted = [];
    n.port.postMessage = msg => posted.push(JSON.parse(JSON.stringify(msg)));
    const send = data => n.port.onmessage({ data });
    return { n, posted, send, alive: true };
  };
  /** One render quantum of every live node; the peak of each. */
  const quantum = nodes => nodes.map(x => {
    if (!x.alive) return 0;
    const L = new Float32Array(Q), R = new Float32Array(Q);
    x.alive = x.n.process([], [[L, R]], {});
    let peak = 0;
    for (let j = 0; j < Q; j++) peak = Math.max(peak, Math.abs(L[j]));
    return peak;
  });
  const step = nodes => { const p = quantum(nodes); ctx.currentTime += Q / SR; return p; };

  const a = node();
  a.send({ t: 'load', sf2: canon.slice(0), midi: ab(katari('m_canon.mid')) });
  assert.deepEqual(a.posted.map(x => x.t), ['ready'], 'nothing else sounds: in one go');
  a.send({ t: 'seek', time: 10, n: 1 });
  a.send({ t: 'play', n: 2 });
  for (let i = 0; i < 20; i++) step([a]);

  const b = node();
  b.send({ t: 'load', sf2: holy.slice(0), midi: ab(katari('m_holy.mid')) });
  b.send({ t: 'play', n: 1 });
  assert.deepEqual(b.posted, [], 'a sounds: b loads in slices, its play held');
  let quanta = 0, peakA = 0;
  while (!b.posted.length) {
    peakA = Math.max(peakA, step([a, b])[0]);
    assert.ok(++quanta < 20000, 'b gets ready');
  }
  assert.ok(quanta >= 2, `in ${quanta} quanta`);
  assert.ok(peakA > 0.01, `a played on meanwhile: ${peakA}`);
  assert.deepEqual(b.posted.map(x => x.t), ['ready', 'state'], 'then the held play');
  assert.equal(b.posted[1].playing, true);

  // both close; once their tails have rung out they leave, and the next load is in one go again
  a.send({ t: 'close', n: 3 });
  b.send({ t: 'close', n: 2 });
  for (let i = 0; i < 10 * SR / Q && (a.alive || b.alive); i++) step([a, b]);
  assert.equal(a.alive || b.alive, false, 'both closed');
  assert.equal(a.posted.at(-1).t, 'closed');
  const c = node();
  c.send({ t: 'load', sf2: holy.slice(0), midi: ab(katari('m_holy.mid')) });
  assert.deepEqual(c.posted.map(x => x.t), ['ready']);
});

test('the IIFE as a classic Worker: up first; bank then prepare gives prepared; a stalled body fails kind bank and the next prepare fetches again', needs('site/ghost/katari'), async () => {
  const gz = zlib.gzipSync(SF3, { level: 1 });
  const t = timers();
  const posted = [];
  let mode = 'ok';
  let fetches = 0;
  const fetch = async (url, o) => {
    fetches++;
    if (mode === 'ok') return new Response(gz);
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: () => {
      if (!sent) { sent = true; return Promise.resolve({ done: false, value: new Uint8Array(gz.subarray(0, 1000)) }); }
      return new Promise(() => {});
    } }) } };
  };
  const ctx = vm.createContext({
    console: quietConsole(), importScripts() {}, postMessage: (msg, transfer) => posted.push({ msg, transfer }),
    fetch, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, AbortController, atob, TextDecoder,
  });
  vm.runInContext(IIFE, ctx, { filename: 'midi.js' });
  assert.deepEqual(JSON.parse(JSON.stringify(posted.map(p => p.msg))), [{ t: 'up' }]);
  assert.equal(typeof ctx.onmessage, 'function');
  mode = 'stall';
  ctx.onmessage({ data: { t: 'bank', url: 'https://h/engines/generaluser_gs.0123456789.sf3.gz' } });
  ctx.onmessage({ data: { t: 'prepare', id: 1, midi: ab(katari('m_holy.mid')) } });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(t.advance(30000), 1);
  await until(() => posted.length === 2, 'failed');
  assert.deepEqual(JSON.parse(JSON.stringify({ ...posted[1].msg, message: '' })), { t: 'failed', id: 1, kind: 'bank', message: '' });
  assert.equal(fetches, 1);
  mode = 'ok';
  ctx.onmessage({ data: { t: 'prepare', id: 2, midi: ab(katari('m_holy.mid')) } });
  await until(() => posted.length === 3, 'prepared', 60000);
  const p = posted[2];
  assert.equal(p.msg.t, 'prepared', JSON.stringify(p.msg));
  assert.equal(p.msg.id, 2);
  assert.equal(fetches, 2, 'the next prepare fetched again');
  assert.ok(Math.abs(p.msg.duration - SONGS['m_holy.mid']) < 0.001);
  assert.equal(p.transfer.length, 2);
  assert.ok(Buffer.from(p.msg.sf2).equals(Buffer.from(await sf2Of('m_holy.mid'))), 'the same SF2 as in Node');
});

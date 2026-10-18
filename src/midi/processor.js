// The MIDI player's worklet role (midi.md §5.4): a SongPlayer per AudioWorkletNode holds one synth and one
// sequencer (two songs never share channels, programs or a GS reset); the registered processor 'sumika-midi' is a thin
// wrapper. It runs on the audio thread: no timers, TextDecoder, atob, fetch or performance in this role.
//
// Commands from the page may carry a number `n` (midi.md §5.5); `state` and `ended` echo the number of the last command
// applied, so the page can drop an answer that was already on its way when it sent a newer command.
//
// The audio thread renders every node of the page's one context, so a `load` is work done between two render quanta
// of every song already playing: in one block it took up to 178 ms in Chromium on desktop and dropped up to 120 ms
// of the other song's output (docs/research/midi.md §5.4). While another song sounds, the load runs in steps from
// `render`, about LOAD_SLICE_MS per quantum; alone, in one go. Its steps: the SF2, the song's events a few
// hundred at a time (song.js songSteps), the synth, the sequencer, then core's preload one voice at a time.
import { SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer, SpessaLog } from 'spessasynth_core';
import { songSteps, toArrayBuffer } from './song.js';

/**
 * While another song on this audio thread sounds, a load works about this long per render quantum (ms), at least one
 * step. The worklet's clock is Date.now(), in whole milliseconds, so a slice is 0–1 ms of work in a quantum of 2.7–2.9
 * ms. Core's calls that cannot be cut stay one block each, at most about 20 ms in Chromium on desktop [measured,
 * midi.md §5.4]: the SF2's parse, the song's flush, the synth, the used-keys pass.
 */
export const LOAD_SLICE_MS = 1;
/** Seconds rendered on after the last voice, for the reverb and chorus tails (midi.md §5.4). */
export const TAIL_S = 2;
/** At most this long after a close the node renders before `closed` [decision: release tails ring briefly]. */
export const CLOSE_TAIL_S = 2;
/**
 * The sequencer never gets a time at or above duration − END_GUARD_S (midi.md §5.4, measured): core 4.3.22's
 * setTimeToInternal reads past its last event, and throws, when the time it sums falls a little short of
 * `midiTicksToSeconds(last)`. A seek there is the end: playing, the song ends (or starts over with `loop`); paused, the
 * position is the end, and `play` starts at 0, as an `<audio>` element's does.
 */
export const END_GUARD_S = 0.001;
/** Frames per synth call (core's maxBufferSize; a longer render quantum is rendered in pieces). */
const BLOCK = 128;

export class SongPlayer {
  /**
   * @param {{sampleRate: number, post: (m: object, transfer?: Transferable[]) => void, now?: () => number,
   *   busy?: () => boolean, clock?: () => number}} o
   *   post: to the page; now: the context's time (the worklet's `currentTime`), sent as `at` with each `state`;
   *   busy: another song on this audio thread sounds (installWorklet: another player not quiet), so a load runs in
   *   slices; clock: milliseconds (Date.now), for the slices
   */
  constructor({ sampleRate, post, now = () => 0, busy = () => false, clock = () => Date.now() }) {
    this.sampleRate = sampleRate;
    this.post = post;
    this.now = now;
    this.busy = busy;
    this.clock = clock;
    /** The load's remaining steps (a generator) while it runs; commands that came meanwhile wait in `held`. */
    this.loading = null;
    this.held = [];
    this.synth = null;
    this.seq = null;
    /** Seconds from tick 0 to the file's end (songOf); NaN until loaded. */
    this.duration = NaN;
    this.playing = false;
    /** The position is the song's end (after `ended`, or a seek there while paused): the sequencer is not told. */
    this.atEnd = false;
    this.loop = false;
    /** The number of the last command applied. */
    this.n = 0;
    this.songEnded = false;
    /** Synth time until which a silent synth still renders: TAIL_S after the last voice. */
    this.quietAt = 0;
    /** Synth time of `close`, or null. */
    this.closing = null;
    /** Closed or failed: `render` returns false (process() stops for good). */
    this.done = false;
    this.failed = false;
  }

  /**
   * One message from the page; every failure becomes `{t:'error'}`. While a load runs in slices, every command but
   * `close` waits and is applied after `ready`, in order (the page sends none before `ready`).
   */
  message(m) {
    if (this.done || !m || typeof m !== 'object') return;
    if (this.loading && m.t !== 'close') {
      this.held.push(m);
      return;
    }
    if (typeof m.n === 'number') this.n = m.n;
    try {
      if (m.t === 'close') this.close();
      else if (this.closing !== null || this.failed) return;
      else if (m.t === 'load') this.load(m.sf2, m.midi);
      else if (m.t === 'play') this.play();
      else if (m.t === 'pause') this.pause();
      else if (m.t === 'seek') this.seek(m.time);
      else if (m.t === 'loop') { this.loop = !!m.on; this.state(); }
    } catch (e) {
      this.fail(e);
    }
  }

  /** The load: in one go when no other song sounds, else in slices from `render`. */
  load(sf2, midi) {
    if (this.synth || this.loading) throw new Error('loaded twice');
    this.loading = this.steps(sf2, midi);
    if (!this.busy()) this.advance(true);
  }

  /**
   * The load's work, a step per `next()`: each step is one block on the audio thread. Core's preloadSynth (the song's
   * voices built before it plays, so no note waits for its samples) runs here a voice per step; the sequencer's own
   * preload is off. Ends with `ready`.
   */
  *steps(sf2, midi) {
    const bank = SoundBankLoader.fromArrayBuffer(toArrayBuffer(sf2));
    yield;
    const song = yield* songSteps(midi); // SONG_STEP_EVENTS events a step, then core's flush
    yield;
    const synth = new SpessaSynthProcessor(this.sampleRate, { effectsEnabled: true, eventsEnabled: false, maxBufferSize: BLOCK });
    yield;
    synth.soundBankManager.addSoundBank(bank, 'main');
    const seq = new SpessaSynthSequencer(synth);
    seq.skipToFirstNoteOn = false; // ssp.exe plays from tick 0
    seq.loopCount = 0; // the whole file loops, by hand (render): no marker loops
    seq.preload = false; // preloaded below, a voice per step
    seq.onEventCall = e => { if (e.type === 'songEnded') this.songEnded = true; };
    if (song.duration > 0) {
      seq.loadNewSongList([song]); // paused at 0 (core refuses length 0)
      yield;
      // core's preloadSynth: every preset, key and velocity the song plays (core leaves out a song with its own bank;
      // songOf drops it)
      for (const [preset, keys] of song.getUsedProgramsAndKeys(synth.soundBankManager)) {
        for (const [key, velocities] of keys) {
          for (const velocity of velocities) {
            yield;
            synth.getVoicesForPreset(preset, key, velocity);
          }
        }
      }
    }
    this.synth = synth;
    this.seq = seq;
    this.duration = song.duration;
    this.post({ t: 'ready', duration: song.duration });
  }

  /**
   * The load's next steps: all of them, or LOAD_SLICE_MS of them (at least one). When the last is done (`ready`
   * posted), the held commands are applied.
   */
  advance(all) {
    const steps = this.loading;
    const until = this.clock() + LOAD_SLICE_MS;
    while (!steps.next().done) {
      if (!all && this.clock() >= until) return;
    }
    this.loading = null;
    const held = this.held;
    this.held = [];
    for (const m of held) this.message(m);
  }

  need() {
    if (!this.seq) throw new Error('no song loaded');
  }

  play() {
    this.need();
    if (this.playing) { this.state(); return; }
    if (this.duration <= END_GUARD_S) { // nothing to play: it ends at once, or loops in silence
      this.playing = true;
      this.atEnd = false;
      this.state();
      if (!this.loop) this.reachEnd();
      return;
    }
    if (this.atEnd) { this.atEnd = false; this.toSeq(0); }
    this.seq.play();
    this.playing = true;
    this.state();
  }

  pause() {
    this.need();
    if (this.playing) {
      this.playing = false;
      if (this.seq.midiData) this.seq.pause(); // all notes off: voices release
    }
    this.state();
  }

  seek(time) {
    this.need();
    let t = Number(time);
    if (!(t > 0)) t = 0;
    if (t >= this.duration - END_GUARD_S) {
      if (this.playing) this.reachEnd();
      else { this.atEnd = true; this.state(); }
      return;
    }
    this.atEnd = false;
    this.toSeq(t);
    this.state();
  }

  /**
   * Programs, controllers and sysex replayed up to t (core's setter: a GS reset, every note off, notes skipped). Paused,
   * core's setter leaves the position at the next event's time, not at t [measured: a seek into a rest jumps to its
   * end, and one into the rest before the end of track lands on the duration, where core's play() starts over at 0];
   * the position is set back to t, so the rest plays out as `<audio>`'s position would (the next event still waits for
   * its own time).
   */
  toSeq(t) {
    this.songEnded = false;
    this.seq.currentTime = t;
    if (this.seq.paused) this.seq.pausedTime = t;
  }

  /** The song's end, playing: with `loop` it starts over at tick 0 (the element's own loop: no end message). */
  reachEnd() {
    if (this.loop) {
      if (this.seq.midiData) {
        this.toSeq(0);
        if (this.seq.paused) this.seq.play();
      }
      this.state();
      return;
    }
    if (this.seq.midiData && !this.seq.paused) this.seq.pause();
    this.playing = false;
    this.atEnd = true;
    this.post({ t: 'ended', pos: this.duration, n: this.n });
  }

  position() {
    if (!this.seq) return 0;
    if (this.atEnd) return this.duration;
    const t = this.seq.midiData ? this.seq.currentTime : 0;
    return Math.min(Math.max(t, 0), this.duration);
  }

  state() {
    this.post({ t: 'state', playing: this.playing, pos: this.position(), at: this.now(), n: this.n });
  }

  /** Nothing sounds: not playing, no voice, and the effects' tail has rung out. */
  quiet() {
    const s = this.synth;
    return !s || (!this.playing && s.voiceCount === 0 && s.currentTime >= this.quietAt);
  }

  close() {
    if (this.closing !== null) return;
    this.loading = null; // a load under way is dropped, with the commands held for it
    this.held = [];
    if (this.playing && this.seq && this.seq.midiData) this.seq.pause();
    this.playing = false;
    this.closing = this.synth ? this.synth.currentTime : 0;
    if (this.failed || this.quiet()) this.finish();
  }

  finish() {
    this.done = true;
    this.release();
    this.post({ t: 'closed' });
  }

  release() {
    try {
      if (this.synth) this.synth.destroySynthProcessor();
    } catch (e) { /* gone either way */ }
    this.synth = null;
    this.seq = null;
    this.loading = null;
    this.held = [];
  }

  fail(e) {
    if (this.failed || this.done) return;
    this.failed = true;
    this.playing = false;
    this.release();
    this.post({ t: 'error', message: String((e && e.message) || e) });
    if (this.closing !== null) this.finish();
  }

  /**
   * One render quantum into L and R (zeroed by the caller). Returns true while the node lives: a false return stops
   * process() for good, so only after `closed` or a failure. Nothing sounding: no synth call at all.
   * @param {Float32Array} L @param {Float32Array} R
   */
  render(L, R) {
    if (this.done || this.failed) return false;
    try {
      if (this.loading) this.advance(!this.busy()); // the rest in one go once nothing else sounds
      const s = this.synth;
      if (s) {
        for (let i = 0; i < L.length; i += BLOCK) {
          if (this.quiet()) break;
          if (this.playing) this.seq.processTick();
          s.process(L, R, i, Math.min(BLOCK, L.length - i));
          if (s.voiceCount > 0) this.quietAt = s.currentTime + TAIL_S;
          if (this.songEnded) {
            this.songEnded = false;
            if (this.playing) this.reachEnd();
          }
        }
      }
      if (this.closing !== null && (this.quiet() || !s || s.currentTime - this.closing >= CLOSE_TAIL_S)) {
        this.finish();
        return false;
      }
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }
}

/**
 * The worklet role on an AudioWorkletGlobalScope: registers 'sumika-midi' (no inputs, one stereo output).
 * @param {object} scope the AudioWorkletGlobalScope (`globalThis`: registerProcessor, AudioWorkletProcessor,
 *   sampleRate, currentTime)
 */
export function installWorklet(scope) {
  SpessaLog.setLogLevel(false, false, false);
  /** Every live player of this scope (one audio thread: the page's one context); a player leaves at its last render. */
  const players = new Set();
  scope.registerProcessor('sumika-midi', class extends scope.AudioWorkletProcessor {
    constructor() {
      super();
      const player = new SongPlayer({
        sampleRate: scope.sampleRate,
        post: (m, transfer) => this.port.postMessage(m, transfer || []),
        now: () => scope.currentTime,
        busy: () => {
          for (const p of players) if (p !== player && !p.quiet()) return true;
          return false;
        },
        clock: () => Date.now(),
      });
      this.player = player;
      players.add(player);
      this.port.onmessage = e => player.message(e.data);
      this.right = null;
    }

    process(inputs, outputs) {
      const alive = this.render(outputs);
      if (!alive) players.delete(this.player);
      return alive;
    }

    render(outputs) {
      const out = outputs[0] || [];
      const L = out[0];
      if (!L) return this.player.render(new Float32Array(BLOCK), new Float32Array(BLOCK));
      let R = out[1];
      if (!R) {
        if (!this.right || this.right.length !== L.length) this.right = new Float32Array(L.length);
        else this.right.fill(0);
        R = this.right;
      }
      return this.player.render(L, R);
    }
  });
}

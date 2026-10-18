// A MIDI file as the player plays it (midi.md §5.4), shared by the Worker (bank.js) and the worklet (processor.js).
import { BasicMIDI, MIDITrack, MIDIMessage, IndexedByteArray } from 'spessasynth_core';

/** Events songSteps reads per step (a median 0.3–0.6 ms in Chromium on desktop [measured, midi.md §5.4]). */
export const SONG_STEP_EVENTS = 256;

/** An ArrayBuffer of exactly these bytes (the buffer itself when a view covers all of it). Works across realms. */
export function toArrayBuffer(b) {
  if (Object.prototype.toString.call(b) === '[object ArrayBuffer]') return b;
  if (ArrayBuffer.isView(b)) {
    return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  throw new TypeError('not bytes');
}

const tag = (u8, at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);

/**
 * The song of a MIDI file: an SMF (`MThd`) or an RMID (`RIFF`…`RMID`), parsed by spessasynth_core.
 * - Its end is the file's last event (the latest last event of any track), when that comes after core's
 *   `lastVoiceEventTick`: DirectShow's MIDI parser reports the file's length, so ssp.exe's end (OnSoundStop, a loop's
 *   restart) comes at the end of the track [infer; ssp.exe [verify] V2]. `duration` is seconds from tick 0.
 * - An RMID's embedded sound bank is dropped [decision]: ssp.exe plays MIDI through the default MIDI out device, which
 *   cannot load one; and the worklet must never decode an SF3 or DLS.
 * @param {ArrayBuffer|ArrayBufferView} bytes
 * @returns {BasicMIDI}
 * @throws {Error} 'not a MIDI file', or core's parse error
 */
export function songOf(bytes) {
  const buf = toArrayBuffer(bytes);
  const u8 = new Uint8Array(buf);
  const smf = u8.length >= 14 && tag(u8, 0) === 'MThd';
  const rmid = u8.length >= 12 && tag(u8, 0) === 'RIFF' && tag(u8, 8) === 'RMID';
  if (!smf && !rmid) throw new Error('not a MIDI file');
  return played(BasicMIDI.fromArrayBuffer(buf));
}

/** songOf's changes to core's parse: no embedded bank, the end at the file's last event. */
function played(song) {
  song.embeddedSoundBank = undefined;
  song.bankOffset = 0;
  let last = 0;
  for (const t of song.tracks) {
    const e = t.events[t.events.length - 1];
    if (e && e.ticks > last) last = e.ticks;
  }
  if (last > song.lastVoiceEventTick) {
    song.lastVoiceEventTick = last;
    song.duration = song.midiTicksToSeconds(last);
  }
  return song;
}

/** Core's DataBytesAmount: the data bytes of a channel message by its high nibble. */
const DATA_BYTES = { 8: 2, 9: 2, 10: 2, 11: 2, 12: 1, 13: 1, 14: 2 };

/** Core's readBinaryString: bytes as characters up to a zero byte. */
function text(u8, at, n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const b = u8[at + i];
    if (b === 0) return s;
    s += String.fromCharCode(b);
  }
  return s;
}

/** Core's readBigEndian. */
function bigEndian(u8, at, n) {
  let out = 0;
  for (let i = 0; i < n; i++) out = out << 8 | u8[at + i];
  return out >>> 0;
}

/**
 * songOf in steps, for the worklet (docs/research/midi.md §5.4): core's SMF parse is one block of up to 66 ms in
 * Chromium on desktop for an 85 KB file (two typed arrays per event), so an SMF's events are read here,
 * SONG_STEP_EVENTS per step, into core's own MIDITrack / MIDIMessage / IndexedByteArray as core's parseSMFInternal
 * builds them (the same reads, byte for byte, malformed files included), and core's `flush(false)` then interprets
 * them as its parse does. tests/midi_engine.test.mjs compares the result with songOf's. An RMID (rare) is core's parse
 * in one step.
 * @param {ArrayBuffer|ArrayBufferView} bytes
 * @returns {Generator<undefined, BasicMIDI>} `yield*` it; it returns songOf(bytes)'s song
 */
export function* songSteps(bytes) {
  const buf = toArrayBuffer(bytes);
  const u8 = new Uint8Array(buf);
  if (!(u8.length >= 14 && tag(u8, 0) === 'MThd')) return songOf(buf);
  const song = new BasicMIDI();
  song.fileName = '';
  let at = 0;
  // core's readMIDIChunk: the type, then a copy of `size` bytes (zeros past the file's end)
  const chunk = () => {
    const type = text(u8, at, 4);
    const size = bigEndian(u8, at + 4, 4);
    const data = new Uint8Array(size);
    data.set(u8.subarray(at + 8, at + 8 + size), 0);
    at += 8 + size;
    return { type, size, data };
  };
  const head = chunk();
  if (head.type !== 'MThd') throw new SyntaxError(`Invalid MIDI Header! Expected "MThd", got "${head.type}"`);
  if (head.size !== 6) throw new RangeError(`Invalid MIDI header chunk size! Expected 6, got ${head.size}`);
  song.format = bigEndian(head.data, 0, 2);
  const trackCount = bigEndian(head.data, 2, 2);
  song.timeDivision = bigEndian(head.data, 4, 2);
  let n = 0;
  for (let i = 0; i < trackCount; i++) {
    const track = new MIDITrack();
    const c = chunk();
    if (c.type !== 'MTrk') throw new SyntaxError(`Invalid track header! Expected "MTrk" got "${c.type}"`);
    const d = c.data;
    let p = 0;
    // core's readVariableLengthQuantity
    const vlq = () => {
      let out = 0;
      for (;;) {
        const b = d[p++];
        out = out << 7 | b & 127;
        if (b >> 7 !== 1) return out;
      }
    };
    let running;
    let ticks = 0;
    if (song.format === 2 && i > 0) {
      const prev = song.tracks[i - 1].events;
      ticks += prev[prev.length - 1].ticks;
    }
    while (p < c.size) {
      ticks += vlq();
      const check = d[p];
      let status;
      if (running !== undefined && check < 128) status = running;
      else if (check < 128) throw new SyntaxError(`Unexpected byte with no running byte. (${check})`);
      else {
        status = check;
        p++;
      }
      let size;
      if (status >= 0x80 && status < 0xf0) {
        size = DATA_BYTES[status >> 4];
        running = status;
      } else if (status === 0xf0) size = vlq();
      else if (status === 0xff) {
        status = d[p++];
        size = vlq();
      } else size = 0;
      const data = new IndexedByteArray(size);
      data.set(d.subarray(p, p + size));
      track.pushEvent(new MIDIMessage(ticks, status, data));
      p += size;
      if (++n % SONG_STEP_EVENTS === 0) yield;
    }
    song.tracks.push(track);
  }
  yield;
  song.flush(false);
  return played(song);
}

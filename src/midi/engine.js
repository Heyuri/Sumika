// The MIDI player's one bundle (midi.md §5.2): tools/build.mjs builds this entry, always minified, as
// sumika/engines/midi.<h>.js, an IIFE the page loads twice: as a classic Worker (bank.js: the sound bank and each
// song's SF2) and as an AudioWorklet module (processor.js: the synth and sequencer). Both need most of
// spessasynth_core, so one file saves visitors a second download of the same code. The role comes from the global
// scope; anywhere else (Node, the tests' ESM build of this entry) nothing runs and the pieces are exported.
import { installWorklet } from './processor.js';
import { installWorker } from './bank.js';

export { songOf, songSteps, toArrayBuffer, SONG_STEP_EVENTS } from './song.js';
export { bankBytes, crc32, usedKeys, prepareSong, BankWorker, installWorker, BANK_STALL_MS } from './bank.js';
export { SongPlayer, installWorklet, TAIL_S, CLOSE_TAIL_S, END_GUARD_S, LOAD_SLICE_MS } from './processor.js';

if (typeof registerProcessor === 'function') installWorklet(globalThis);
else if (typeof importScripts === 'function') installWorker(globalThis);

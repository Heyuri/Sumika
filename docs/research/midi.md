# MIDI: inputs, provenance, the sound bank and the player

Status: built. §1–§4: what was downloaded, where it lives, which bank file ships and why, the notices, two listening
samples. §5–§6: the player (an AudioWorklet Sumika owns, driving spessasynth_core; the bank decoded and trimmed in a
Worker; the media-factory seam in `page-saori.js`), from research (synths, banks, the code map and ssp.exe's MIDI
path): the engine side (§5; the bank ships gzipped, `.sf3.gz`) and the page side (§6), built and wired on the real
site, with a load in slices while another song sounds (§5.4), the bundle's map in every build (§5.6), the pins'
`publishAs`, and the version-bump steps (CLAUDE.md). Checked on build `527fa764f824` (`midi.96a2cdf932.js`): `npm test`
1,360 tests, fail 0, skipped 0, and a first browser check (§7). Left: the rest of the browser check and the device
checks (§7).

Tags: **[measured]**; **[infer]**; **[decision]**.

Not in the repository: the research scripts in `docs/research/scratch/midi/` (`render.mjs`, `tree_pin.mjs`, the
comparison and scan scripts; its `make_notices.mjs` is in the repository as `tools/make_notices.mjs`, and
`tree_pin.mjs`'s function as `tools/treepin.mjs`), the ghosts' MIDI files (Katari's are in her folder,
`site/ghost/katari/`: CLAUDE.md "The ghosts Sumika was tested with") and the author's SF2 of the bank
(`vendor/generaluser-gs-2.0.3/GeneralUser-GS.sf2`, pinned by size and SHA-256 in `engines/midi/pins.json` `reference`;
the folder's `SOURCE.txt` says where it comes from). These are development material, cited as the sources (CLAUDE.md
"Project rules"); the build reads none of them.

---

## 1. Inputs

Everything was downloaded into new scratch folders, checked, then copied unchanged into `vendor/`. No
package manager ran (the npm tarballs were fetched with curl and unpacked with tar), so no package script ran. Each
folder has a `SOURCE.txt`; `engines/midi/pins.json` pins every folder by the tree pin of kawari-wasm.md §1 (the
Node version in `docs/research/scratch/midi/tree_pin.mjs`, now `tools/treepin.mjs`, gives Kawari 7's `TREE_PIN` on
`vendor/kawari-7.5.0`, as the Python one does).

| Folder | What | Source | Bytes | Hash |
|---|---|---|---|---|
| `vendor/spessasynth_core-4.3.22` | spessasynth_core 4.3.22 (npm 2026-08-24, the registry's latest), Apache-2.0, 6 files | `https://registry.npmjs.org/spessasynth_core/-/spessasynth_core-4.3.22.tgz` (gitHead `99f294d9…`) | tgz 469,015 | tgz sha256 `ff232efd…9af722f9`; npm integrity `sha512-qP6Nkc…b7k4A==` = the registry's; tree `c7ebff5e…48060139` (7 files) |
| `vendor/stb-vorbis-0.0.6` | stb-vorbis 0.0.6 (npm 2026-08-11, latest), core's only runtime dependency (`"stb-vorbis": "latest"` upstream; pinned here), Apache-2.0, stb_vorbis.c v1.22 as base64 wasm | `https://registry.npmjs.org/stb-vorbis/-/stb-vorbis-0.0.6.tgz` (gitHead `2c5f11f0…`) | tgz 59,785 | tgz sha256 `c9b539e7…72f52659`; integrity `sha512-Cyvj…rbbg==` = the registry's; tree `3c2fab9c…fadcc841` (6) |
| `vendor/generaluser-gs-2.0.3` | GeneralUser GS v2.0.3 (2026-02-22), the author's SF2 (not in the repository) + `README.md` + `documentation/{LICENSE.txt, README.md, CHANGELOG.md}` | `https://github.com/mrbumpy409/GeneralUser-GS` at `684543d5…` (head of main; no release, no tag) | SF2 32,319,396 | SF2 sha256 `9575028c…52688cfe`, git blob `298b552d…` = the API's; tree `82192790…6cbd0a45` (6, with the SF2 in place) |
| `vendor/generaluser-gs-2.0.3-sf3` | `GeneralUserGS.sf3`, the same bank with Vorbis samples, made by SpessaSynth | `https://github.com/spessasus/SpessaSynth`, `soundfonts/GeneralUserGS.sf3` at `6f750508…` ("Update GeneralUser GS to 2.0.3", 2026-04-08) | 8,423,728 | sha256 `e2ed326f…797bc66c`, git blob `74c99699…` = the API's; tree `501c7284…0d3ab8df` (2) |

Full hashes are in `SOURCE.txt` and `pins.json`. Git LFS: neither repository uses it (no `.gitattributes` in
GeneralUser-GS; SpessaSynth's has only `* text=auto eol=lf`); the raw URLs served the whole files, and each file's git
blob SHA-1 equals the one GitHub's contents API lists [measured].

Read, not kept (licence texts for the notices, at the packages' gitHeads): spessasynth_core's
`src/externals/fflate/LICENSE` (sha256 `805f6cb2…`) and `src/synthesizer/audio_engine/effects/reverb/dattorro.ts`;
stb-vorbis' `wasm/stb_vorbis.c` (sha256 `3eff78a8…201718d`, its licence block). Nothing else was downloaded.

What the code holds [measured]: core's `dist/index.js` imports `stb-vorbis` by bare name and bundles one external,
fflate (its source map's only sources outside core's own `src/`); the one attribution comment in its effects is the
Dattorro reverb ("by khoin on GitHub, public domain"). Its low-pass filter credits FluidSynth's "tricks" in a comment
(ideas, no copied file). stb-vorbis decodes base64 with `atob`, or, where there is none (an AudioWorklet's scope),
with its own decoder that calls `String.prototype.replaceAll` (ES2021: inside the Chrome 95 / Firefox 100 /
Safari 15.2 baseline).

## 2. The bank: SpessaSynth's SF3 of GeneralUser GS 2.0.3

**Choice [decision]: ship `vendor/generaluser-gs-2.0.3-sf3/GeneralUserGS.sf3`, unchanged.** It is the 8.4 MB
file. Converting the SF2 in the project would need a package beyond the two downloaded: spessasynth_core writes SF3 only
with a Vorbis encoder passed in (`SampleEncodingFunction`, `BasicSample.compressSample`); it ships a decoder only, and
an encoder (libvorbis, sf3convert) is another package [measured in its typings and code]. So there is no second SF3
to compare; the author's own SF2 is kept as the reference and for a later lossless choice.

**Same bank version: how it was checked** (scripts in `docs/research/scratch/midi/`) [measured]:
- INFO: both say INAM "GeneralUser GS 2.0.3 BETA" (the author's own released SF2 carries that name; its ICRD is
  2024-10-15, ISFT Polyphone), the same IENG, ICOP and ICMT (the licence text); the SF3 adds ISFT "SpessaSynth",
  ifil 3.0.
- Structure (`compare_hydra.mjs`, a raw pdta reader): 287 presets, 324 instruments, 920 samples, and the same count of
  every record (pbag 2,913, pgen 17,272, pmod 448, ibag 2,486, igen 12,356, imod 1,808). Every bank:program has the
  same preset name; instrument and sample names are the same sets (SpessaSynth reordered them).
- Zones (`compare_zones.mjs`): every preset's and every instrument's zones are equal as a multiset (generators and
  modulators exactly, instrument and sample references by name): 287 of 287, 324 of 324.
- Sample headers: rate, root key, correction, type and stereo link equal for 919 of 920; loop points equal for 919.
  The one difference is SpessaSynth's own compressor (`compressSample` resamples anything under 8 kHz to 48 kHz by
  repeating points): Hammond Organ-11 is 6 kHz in the SF2 and 48 kHz in the SF3, loop points ×8. StrLoop - F#1, whose
  loop 2.0.3 changed (its CHANGELOG), has the SF2's loop (19,328–76,167).
- Sample data (`compare_samples.mjs`): every SF3 sample decoded and compared with the SF2's PCM of the same name: best
  alignment at lag 0 for all (the one other is "Dead Air", silence), gain median 1.0006 (0.00 dB), SNR median
  28.5 dB (noise and cymbal samples lowest, 4–9 dB, as a perceptual codec codes noise); 918 of 920 the same length
  (Cello-F1 +427 points and Cello-G#1 +53 after decoding, past their loop ends). Decoding all 920 takes about 1.2 s
  in Node here, 61 MiB as Float32 (`decode_time.mjs`).
- The SpessaSynth commit that brought it in is dated 2026-04-08 and says 2.0.3, after the author's 2.0.3 of
  2026-02-22. A 2.0.2 SF2 was not downloaded, so "not 2.0.2" rests on that message and StrLoop's loop.

**How it differs from the author's recommended conversion** (README §6: sf3convert, Ogg quality 0.8, −1 dB, "nearly
indistinguishable") [measured unless tagged]:
- No −1 dB: the decoded samples keep the SF2's level, so 264 of 920 decode past full scale (5,427 points; 15 by more
  than 1 dB; the highest +2.47 dBFS in Wave_Noise_White), and core's `decodeVorbis` clamps them to ±1. The SF2 has 715
  samples peaking above −1 dBFS.
- Quality: all 920 streams are libVorbis 20200704; the nominal bitrates in their headers (96 kb/s mono at 44.1 kHz,
  86 kb/s at 32 kHz) are libvorbis' quality-0.5 rows [infer], not 0.8. The author's README also says the web
  player's SF3 is the compressed one and the SF2 gives the best quality.
- 43.6 % of its sample chunk is Ogg header pages (each of the 920 streams carries its own Vorbis codebooks): gzip -9
  shrinks the file to 4,820,423 bytes (the SF2: 29,296,220). Hosts usually send an unknown `.sf3` uncompressed, so
  shipping it gzipped (inflated in the Worker, as the packs are) would halve the download; a choice for the player
  step, same bank either way.
- The listening samples of §3 let the difference be heard.

GS coverage noted on the way: cocktail.mid selects GS variation tones 8:54 and 16:19, which GeneralUser GS lacks
(its banks: 0, 1–9, 11–13, 16, 24–26, 120, 128); SpessaSynth plays the capital tones 0:54 and 0:19, as a Sound Canvas
falls back.

## 3. Listening samples

Rendered into a scratch folder (they are not kept in the project):
`canon_compressed_8MB.wav`, `canon_original_32MB.wav`, `cocktail_compressed_8MB.wav`, `cocktail_original_32MB.wav`.
"compressed_8MB" = the SF3 that would ship, "original_32MB" = the author's SF2.

- Made by `docs/research/scratch/midi/render.mjs` with spessasynth_core 4.3.22 in Node, offline: 44.1 kHz stereo,
  16-bit WAV, the first 30 s from tick 0 (`skipToFirstNoteOn = false`, as SSP), no loop, the synth's defaults
  (effects on, its own gain), no normalisation, so both banks play at the same gain. Rendering is deterministic (a
  second render was byte-identical) and takes about 2 s per 30 s.
- `canon`: Katari's `site/ghost/katari/ghost/master/m_canon.mid` (read only; 54 s, GM System On + XG System On and
  XG part parameters, Celesta on 14 channels): peak −10.0 dBFS, RMS −26.6 dBFS with both banks; the SF3 render
  differs from the SF2 render by an SNR of 36.2 dB.
- `cocktail`: souzou_syoka's `ghost\master\saori\cocktail.mid` (only that file was taken from `souzou_syoka.nar`,
  into a scratch folder; CRC-32 `4ced83ab` = the archive's; 132 s, GS reset, variation tones, GS NRPN vibrato / TVF /
  TVA, RPN bend range, all within the first 2 s): peak −5.5 dBFS, RMS −22.0 dBFS; SNR between the renders 34.3 dB.
- `midscan.mjs` lists what a file uses (sysex kinds, bank selects, NRPN/RPN, programs, with times).

## 4. Where the build picks things up [decision]

- Sources stay in `vendor/` (never published). The build reads `vendor/spessasynth_core-4.3.22/dist/index.js` and
  aliases the bare `stb-vorbis` to `vendor/stb-vorbis-0.0.6/dist/index.js` (esbuild `alias`); Node tests need the
  same alias (a bundle, or a resolve hook), since there is no `node_modules` for them. It checks the tree pins of
  `engines/midi/pins.json` first and stops on a mismatch, as the engine builds do.
- Published names (all in `sumika/engines/`, so `tools/prune.mjs` keeps one versioned folder; `ENGINE_FILE` needs
  `sf3` added; built: `sf3.gz`, §5.6): the worklet module `midi.<nameHash>.js` (+ map), the bank
  `generaluser_gs.<nameHash>.sf3` (built: gzipped, `.sf3.gz`, named by the SF3's hash) copied from
  `vendor/generaluser-gs-2.0.3-sf3/GeneralUserGS.sf3` (lower case: `ENGINE_FILE` allows `[a-z0-9_]`), both in the
  build table; `midi.LICENSES.txt` under its plain name next to them, copied from `engines/midi/midi.LICENSES.txt`,
  like the engines' `*.LICENSES.txt` (nothing loads it). No plain-name copy of the bank under `site/`.
- Measured with the project's esbuild (`bundle_size.mjs`): core + stb-vorbis for a worklet (processor, sequencer,
  MIDI and bank loaders), minified, `target: es2020`: 402,190 bytes, 134,344 gzip, no warnings (es2022: 394,869 /
  133,032). About 113 KB of that is stb-vorbis' base64 wasm, which core imports at module level; a worklet that only
  ever receives SF2 from the Worker could alias it to a stub [infer].
- `midi.LICENSES.txt` (made by `tools/make_notices.mjs` from the vendored files and the two texts in §1, which a
  version bump fetches again at the new `gitHead`s: CLAUDE.md "Commands", the MIDI player's inputs): Apache-2.0 (the
  same `LICENSE` in both packages), fflate's MIT notice, stb_vorbis.c's MIT-or-public-domain block, the Dattorro
  header, GeneralUser GS's `LICENSE.txt`, and last the Emscripten runtime and libc inside the stb-vorbis wasm (an
  Emscripten build: Emscripten's `LICENSE` and musl's `COPYRIGHT`, read from the emsdk the engines are built with,
  as `engines/common/notices.py` `emscripten` does for the engines).
- iPhones [decision]: while MIDI plays, set
  `navigator.audioSession.type = 'playback'` where it exists (Safari 16.4+), so MIDI ignores the silent switch as the
  `<audio>` sounds do; on Safari 15.2–16.3 MIDI follows the silent switch (no silent-`<audio>` workaround).
- Visitors fetch nothing for MIDI until a ghost first plays a MIDI file; then the worklet module and the bank, under
  their hashed names (safe updates).

## 5. The player: engine side

Status: built and tested in Node: the one MIDI bundle (Worker and AudioWorklet roles), the build, prune, the tests.
The page side (§6) uses the interface in §5.5; both were
joined and built on the real `site/` (build `e0071916a0fd`: `midi.38bc5643bf.js`,
`generaluser_gs.4ea5673a9e.sf3.gz`). The browser check follows (§7). Tags as above; [verify] = for the browser check
or the device checks (§7).

### 5.1 Files

| File | What |
|---|---|
| `src/midi/engine.js` | the bundle's entry: `registerProcessor` is a function → worklet role; `importScripts` is → Worker role; else (Node, the tests' ESM build) nothing runs and the pieces are exported |
| `src/midi/song.js` | `songOf(bytes)`, `toArrayBuffer` (both roles) |
| `src/midi/bank.js` | Worker role: `bankBytes`, `usedKeys`, `prepareSong`, `BankWorker`, `installWorker`, `BANK_STALL_MS` |
| `src/midi/processor.js` | worklet role: `SongPlayer`, `installWorklet` ('sumika-midi'), `TAIL_S`, `CLOSE_TAIL_S`, `END_GUARD_S` |
| `src/midi/vorbis.js` | what core imports as `stb-vorbis`: the real package (`stb-vorbis-impl`) evaluated lazily, never in a worklet |
| `tools/treepin.mjs` | the tree pin of kawari-wasm.md §1 (the function of `docs/research/scratch/midi/tree_pin.mjs`) |
| `tools/make_notices.mjs` | writes `engines/midi/midi.LICENSES.txt` (§4) from the folders `engines/midi/pins.json` names and the two texts of §1: `node tools/make_notices.mjs <fflate LICENSE> <stb_vorbis.c> [out]` |
| `tools/build.mjs` | `readMidiPins`, `checkMidiPins`, `midiOptions`, step 4b (`buildMidi`) |
| `tools/prune.mjs` | `ENGINE_FILE` with `sf3.gz`; build.json's `midi` is current |
| `tests/midi_engine.test.mjs` | the engine side (§5.7); `tests/build_output.test.mjs` and `tests/prune.test.mjs` extended |

### 5.2 The bundle

- One IIFE for both roles [decision: both need most of core; a "worklet only" bundle is as large as everything]:
  `sumika/engines/midi.<h>.js`, always minified (third-party code) and always with its linked map, `--minify` or not
  (the name hash leaves out the map line, so with a map only in normal builds a `--minify` build would write
  `midi.<h>.js` with other bytes under the same name; `midiOptions(vendor)` takes no mode). The site's build: 411,679
  B, 138,015 B gzip -9 [measured, Node 24, esbuild 0.28; core and stb-vorbis alone: 402,427 B].
- `stb-vorbis` is evaluated lazily and outside a worklet only [decision]: the package compiles and
  instantiates its decoder (16.1 MiB of memory) as soon as its module runs. esbuild turns the shim's `import()` into a
  module wrapper run on demand (no `import(` is left in the IIFE [measured]), so in the worklet the decoder's base64 is
  never decoded and nothing is compiled (`WebAssembly.*` called 0 times in the vm worklet scope [measured]); its
  `ready` is resolved there, so a worklet scope without WebAssembly leaves no rejected promise either. The Worker and
  Node evaluate it at the first `ready` read (core's `isSF3DecoderReady`, at module load).
- Aliases (`midiOptions`): `spessasynth_core` → `vendor/spessasynth_core-4.3.22/dist/index.js`, `stb-vorbis` →
  `src/midi/vorbis.js`, `stb-vorbis-impl` → `vendor/stb-vorbis-0.0.6/dist/index.js` (the vendor paths come from
  `pins.json`, so a vendor bump changes nothing in `src/`). The tests build the same entry as ESM with the same options.

### 5.3 The Worker (`bank.js`)

- `{t:'bank', url}` starts the download at once: `fetch(url, {cache: 'force-cache', signal})`, the body read chunk by
  chunk; `BANK_STALL_MS` = 30 s without a new chunk (or without the answer) aborts it [decision: no total cap]. No 2xx,
  or not the bank: once more with `cache: 'reload'` (as loader.js `fetchNamed`); a network error or a stall fails at
  once. A failure fails every waiting prepare (kind `bank`) and is forgotten, so the next prepare downloads again.
- `bankBytes`: a gzip member (`1f 8b 08`; FEXTRA, FNAME, FCOMMENT and FHCRC skipped) inflated with core's fflate into a
  buffer of its ISIZE, then checked against ISIZE and its CRC-32; an ISIZE above 1032 times the deflate data (DEFLATE's
  largest expansion) is refused before anything that size is allocated. Or bytes that already are the bank (a host
  that sent `Content-Encoding: gzip`). Either way `RIFF` … `sfbk` with the RIFF size equal to the length.
- `prepare`: `songOf` (kind `midi` on failure), the bank and the decoder (kind `bank`), then `prepareSong`: a fresh
  parse of the SF3 (`trim` works in place; the SF3's bytes are unchanged [measured: SHA-256 after three prepares]),
  `trim(usedKeys)`, `setSampleFormat({format: 'pcm'})`, `writeSF2()`; an error there is kind `midi`. The answer
  transfers the SF2 and the MIDI bytes back. The same song from the same SF3 gives the same SF2 bytes [measured].
- `usedKeys` [decision]: for each preset core's `getUsedProgramsAndKeys` finds, every velocity (0–127)
  of each key the song plays, since core picks a zone by the velocity after velocity sense and key modifiers; every key
  when the song sends a MIDI Tuning Standard message (bulk dump, single note: `F0 7E|7F <dev> 08 01|02|07`), since
  core's `tunings` move the key a zone is picked by; a song with no note keeps the bank's first preset.
- Measured on every MIDI file the corpus archives ship (26 files in 13 archives, 2,189 s of music, read in
  memory; a scratch script): each whole song rendered through `SongPlayer` on the full SF3 and on its
  prepared SF2 differs by at most 6.4e-5 (sinobis_gm.mid, peak 0.93; about two 16-bit steps: the SF2 holds 16-bit
  PCM), and every song ended. A trim by core's raw velocities gave the same renders on all 26 (none of these files sets
  velocity sense); the wider trim costs 0 to 7.6 KB per song (0.1–0.5 %). Prepared SF2 sizes: 6.5 KB (BEL.MID) to
  5.26 MB (ps.mid: 7 presets, 64 samples); Katari's four 88 KB each (one preset, 5 samples).

### 5.4 The worklet (`processor.js`)

- `load {sf2, midi}`: the SF2 parsed, `new SpessaSynthProcessor(sampleRate, {effectsEnabled: true, eventsEnabled:
  false, maxBufferSize: 128})` (the synth's default gain), the sequencer with `skipToFirstNoteOn = false` and
  `loopCount = 0`, `songEnded` noted; the song preloaded and paused at 0; `{t:'ready', duration}`. A song of length 0
  is not given to core (core refuses one); its `play` ends at once (or loops in silence).
- The load in slices [decision]. The audio thread renders every node of the page's one context, so the load's work is
  a gap in every song already playing. In one block it took 8–124 ms in Node and 18–178 ms in Chromium on desktop
  (median of 5: canon the least, hokkyokusei.mid the most), and while canon played on another node Chromium lost
  68–120 ms of output to a hokkyokusei.mid load and 40–48 ms to a ps.mid load, a canon load nothing
  (`ctx.playbackStats` on a probe page, four runs) [measured]. So the load is a
  generator of steps (`SongPlayer.steps`): the SF2's parse; the MIDI file's events read `SONG_STEP_EVENTS` = 256 at
  a time by `songSteps` (song.js: core's `parseSMFInternal` reads, byte for byte, into core's own `MIDITrack`,
  `MIDIMessage`, `IndexedByteArray`, then core's `flush(false)`; an RMID is core's parse in one step); the synth;
  the sequencer, with core's preload off; core's used-keys pass; then core's `preloadSynth` one voice
  (`getVoicesForPreset`) per step, the same voices in the same cache; `ready`. (Slicing the preload alone left the
  ps.mid case at 40 ms lost in the probe: core's parse of its 21,245 events was one block of 66 ms in Chromium, hence
  `songSteps`.) While another player of the scope is
  not `quiet()` (`busy`, a set of the scope's players in `installWorklet`), `render` runs steps for `LOAD_SLICE_MS`
  = 1 ms of `Date.now()` per quantum (at least one), and commands other than `close` wait in `held` until `ready`
  (the page sends none before it; `close` drops the load); otherwise the load runs in one go, and a load
  in slices finishes at once in the quantum after the other song fell quiet.
- Measured with the slices [measured]: `songSteps` gives songOf's song (`deepStrictEqual`) on all 30
  MIDI files of the corpus archives and Katari's (a scratch script); the longest single step is
  6–11 ms in Node on every one of them (the synth's constructor is the floor; one block was 7–86 ms, medians of 3),
  and 9–21 ms in Chromium for canon, hokkyokusei.mid and ps.mid (one block 18–178 ms), with a `songSteps` step's
  median 0.3–0.6 ms (core's flush up to 13 ms, a GC pause up to 20 ms). The probe in Chromium with the sliced
  load, twice: hokkyokusei.mid, ps.mid and canon loaded beside canon, 0 underruns each (in one block: 5–8, 3 and 0); a
  60 ms busy-wait in a worklet handler shifted the output clock in 3 of 4 runs, a 30 ms one in none, so a block under
  about 30 ms passes on the test desktop (`latencyHint: 'playback'`, output latency 40–48 ms). The cost: such a load
  reaches `ready` later, post to ready 113–306 ms instead of 52–128 ms for hokkyokusei.mid and ps.mid (canon 22–32
  instead of 12), in that case only. A phone is slower by a factor not yet
  measured [verify, with the phone checks of ssp-ui.md §9.11]: core's blocks that cannot be cut (the synth, the flush,
  the used-keys pass, the SF2's parse) may still drop out there.
- The sequencer never gets a time at or above `duration − END_GUARD_S` (1 ms) [measured: core 4.3.22's
  `setTimeToInternal` reads `timeline[++index].tr` before its end check, so `currentTime = duration` throws "reading
  'tr'" for m_xmas.mid and cocktail.mid, paused or playing; a probe]. A seek there,
  paused: the position is the end, and `play` starts at 0 (as `<audio>`); playing: the song ends (`ended`), or with
  `loop` starts over at 0 (`state` pos 0). Measured with this code (a scratch script): 1,144 seeks at, around and
  past the end on all 26 files, paused and playing, with and without loop: no error.
- A paused seek keeps the position it was sent [measured: core's setter leaves a paused position at the next event's
  time, so a seek into a rest would jump to the rest's end, and one into the rest before the end of track would land
  on the duration, where core's `play()` starts over at 0]: `toSeq` sets core's `pausedTime` back to t; the next event
  still waits for its own time. A seek while playing is exact.
- `pause`: core's all notes off (voices release); `play` retriggers the notes held at the pause (core's default).
- `render(L, R)`: playing → `processTick`, then `synth.process` per 128 frames (a longer quantum in pieces); not playing
  → the synth renders on while a voice sounds and `TAIL_S` = 2 s after the last voice (the reverb and chorus
  tails), then not at all (the outputs stay zero, the synth's clock stops) while `render` still returns true;
  it returns false only after `closed` or a failure (a false return stops `process()` for good).
- `close`: pause, then `closed` once nothing sounds (at once when quiet) or `CLOSE_TAIL_S` = 2 s after the close
  [decision: the page disconnects at `closed`, 3 s at the latest]; the synth is destroyed.
- Every message runs inside try/catch, and so does `render`: a failure posts `{t:'error', message}` once, releases the
  synth and makes `render` return false; later commands are ignored, and `close` answers `closed` at once.
- No timers, `TextDecoder`, `atob`, `fetch` or `performance` in this role (the vm worklet test runs it in a scope
  without them, with and without WebAssembly); the load's slices read `Date.now()`, an ECMAScript built-in.

### 5.5 The interface between the engine and the page (as built)

- Build table (`__SUMIKA_FILES__` and `build.json`, `format: 1`): `"midi": {"js": "engines/midi.<10 hex>.js",
  "bank": "engines/generaluser_gs.<10 hex>.sf3.gz"}`; the bank's code is the name hash of the SF3 itself (gzip bytes
  differ by OS and zlib; the Worker checks the inflated content).
- Worker (classic: the page starts it as it starts the SHIORI worker, through a `blob:` bootstrap that
  calls `importScripts(url)`, so a runtime on another origin works, and the role check sees `importScripts` either
  way): `{t:'up'}` first; page → `{t:'bank', url}` (absolute), `{t:'prepare', id, midi}` (ArrayBuffer, transferred);
  worker → `{t:'prepared', id, sf2, midi, duration}` (both ArrayBuffers transferred) or `{t:'failed', id, kind:
  'bank'|'midi', message}`.
- Worklet (`addModule(url)`, processor `'sumika-midi'`, `numberOfInputs: 0`, one stereo output): page → `{t:'load',
  sf2, midi}` first, then `{t:'play'}`, `{t:'pause'}`, `{t:'seek', time}`, `{t:'loop', on}`, `{t:'close'}`; node →
  `{t:'ready', duration}`, `{t:'error', message}`, `{t:'state', playing, pos, at, n}`, `{t:'ended', pos, n}`,
  `{t:'closed'}`. `ready` comes at the load itself, or (another song sounding) after the load's slices; a command
  sent before it is applied after it, in order, and `close` drops the load (§5.4). Every page → node
  command may carry a number `n` (the page's own, increasing);
  `state` and `ended` echo the `n` of the last command applied (a command without one keeps the last), so the page
  can drop an answer older than its last command; a loop's start-over `state` carries it too. `at` is the worklet's
  `currentTime` when `pos` applied.
- `songOf`: `MThd`, or `RIFF` … `RMID`, else "not a MIDI file"; the end is the file's last event when that is later
  than core's `lastVoiceEventTick` (DirectShow reports the file's length [infer; V2]), `duration` in seconds from tick
  0; an RMID's embedded sound bank is dropped [decision: ssp.exe plays through the default MIDI out device, which
  cannot load one, and the worklet must never decode one].

### 5.6 Build, prune, publishing

- `npm run build` checks the three pinned folders (`spessasynth_core`, `stb-vorbis`, `generaluser-gs-sf3`; the
  reference SF2's folder is not read) by tree pin and file count, the bank's SHA-256 and size, and that the notices
  file exists, before it writes anything; a difference stops it ("vendor/… differs from engines/midi/pins.json:
  restore it (docs/research/midi.md §1)"). Cost: about 10 MB hashed per build.
- Then `midi.<h>.js` + `.map` (with or without `--minify`, §5.2), named and map-rewritten as the worker;
  `generaluser_gs.<nameHash(SF3)>.sf3.gz` (`zlib.gzipSync` level 9: 4,823,969 B in about 0.2 s; only when the file
  is absent, through a `.tmp` file and a rename, so an interrupted build leaves no partial bank under the final name);
  `midi.LICENSES.txt` (plain name); the table's `midi`; the summary line names both. `build({midiRoot})` takes another
  project folder (the tests' scratch copy). `pins.json`'s `bank.publishAs` says `.sf3.gz`;
  `tests/build_output.test.mjs` checks both `publishAs` against what the build writes.
- `tools/prune.mjs`: `ENGINE_FILE = /^[a-z0-9_]+\.[0-9a-f]{10}\.(js|wasm|js\.map|sf3\.gz)$/`; build.json's `midi.js`,
  the map its last line names and `midi.bank` are current when build.json has `midi` (an older one without it is
  fine), and both join the `sumika.js` table check. `midi.LICENSES.txt` is no versioned file.
- Nothing new for a CSP; MIDI needs a secure context; a runtime on another host needs CORS for `addModule` and the
  bank's fetch, as for the engines' wasm (docs/guide.md "Browsers"). The Worker's bootstrap is the `blob:` the guide's
  `worker-src blob:` already allows; dropped MIDI files are read as Blobs, never fetched.

### 5.7 Tests

`tests/midi_engine.test.mjs` (22 tests, about 35 s): songOf (Katari's durations ± 1 ms, a final rest kept, an RMID,
non-MIDI), songSteps (songOf's song, `deepStrictEqual`, on Katari's four and synthetic files: running status, sysex,
meta, formats 1 and 2, a track cut short, an RMID; core's errors), bankBytes (gzip with header fields, raw, HTML,
truncated, CRC, ISIZE), prepareSong (one preset each, the same bytes again, the SF3 unchanged), usedKeys (velocities,
a tuning message, no note), SongPlayer (sound in the first 5 s, the end within a quantum, the loop's start-over, close
with its tail, every end seek on Katari's four, a seek's programs and controllers, a paused seek into a rest, the
command numbers, the tail after the last voice, failures, a load in slices: one step a quantum on a fake clock, core's
preload's voices, held commands, the same samples as a load in one go, the rest at once when the other song falls
quiet, a close or a bad SF2 during the slices; m_canon's first 10 s on the SF2 against the SF3 < 1e-4), BankWorker on
fakes (the download at `bank`, one download for two songs, the reload retry, a failure forgotten, a network error, a
stall aborted, a slow body that keeps coming), and the published IIFE in vm scopes (a worklet with and without
WebAssembly; a second node's load in slices while the first sounds; a Worker with a stall, then a fresh download).
`tests/build_output.test.mjs` checks the three files on the real site and on the scratch site (the bundle always names
its own map; a `--minify` build leaves its name, bytes and map as they were), both `publishAs`, that the notices name
the pinned versions, the builder's paths in the bundle, and the pins check on a scratch copy of the folders pins.json
names (a byte changed in each folder, a folder gone, the bank's size, a broken pins file: the build stops having
written nothing); `tests/runtime/info.test.mjs` compares About's versions with the pins; `tests/prune.test.mjs`
covers the MIDI files' retention. Each of these checks was seen to fail on a temporary change to the code it guards
(11 changes).

## 6. The player: page side

The page side: `src/core/midi.js`, `page-saori.js`, `drops.js`, `site.js`, `runtime.js`, the maho
stand-in, About. The seams are in CONTRACTS (core/midi.js, PageSaori, drops.js, Site `midi`, build.js's table, the
"MIDI protocol" section); this section keeps the decisions.

### 6.1 What visitors get

- A ghost's `.mid` / `.midi` / `.smf` / `.rmi` plays: `\_v`, `\8`, `\![sound,play|loop]`, dsaudio, mciaudior,
  mciaudio, and dropped files. The ghost hears OnSoundStop / OnSoundLoop / OnDSAPlayFinish / OnMAAPlayFinish /
  OnMAAPlayLoop as for any other sound. Which files are MIDI: the name as the ghost gave it (`isMidiPath`: the
  extension, trimmed and unquoted; a drop's pseudo-path keeps its name, its `blob:` URL has none), never the URL
  [decision: ssp.exe's MIDI flag covers mid / midi / smf; `.rmi` goes through DirectShow without it, [verify] V6].
- Nothing is fetched for MIDI before a ghost first plays a MIDI file: `Site.midi` is a lazy getter, and making the
  engine makes no context, Worker or request. Then the bundle and the bank, once per page, from the HTTP cache on later
  pages (hashed names).
- Where MIDI cannot run (`midiSupported` false: no secure context, no `AudioContext`, `AudioWorkletNode` or `Worker`;
  or no build table: tests, `site/dev`, the sweep), `Site.midi` is null and MIDI files go to `<audio>`:
  OnSoundError [play, 14020, file, …] for `\_v` / `\![sound]`, a silent music box. MIDI is not in `missingFeatures`'
  required set (it has this fallback: CLAUDE.md "Browsers").
- MIDI follows the other sounds' rules on desktops and phones, but for two things: a music-box MIDI track that cannot
  play is not retried on every page (§6.3), and a dropped MIDI file is kept in the browser like dropped audio (§6.5).

### 6.2 `MidiEngine` and `MidiPlayer` (`src/core/midi.js`)

- One `MidiEngine` per page, on the Site, shared by every ghost: one `AudioContext` (made at the first play allowed to
  make it, `{latencyHint: 'playback'}`, the default sample rate: WebKit bug 274507), one Worker (holding the bank),
  one worklet module. One `AudioWorkletNode` per playing file, each with its own synth and sequencer, through its own
  `GainNode` (the volume) [decision: two songs never share channels, programs or a GS reset; several ghosts and
  several MIDI at once mix; ssp.exe sends every stream to one MIDI-out device, [verify] V1]. All nodes render on the
  context's one audio thread, so a song that starts while another sounds is loaded in slices (§5.4).
- The Worker starts from a `blob:` bootstrap `importScripts(<absolute js URL>)`, as the SHIORI worker does (a runtime
  on another origin), and is sent the bank's URL at once; the module is added once the Worker said `up`
  (its script then comes from the HTTP cache [infer]) and a context exists. A rejected module or a Worker error is
  forgotten: the next play tries again [decision: no `staleCheck` for MIDI].
- `wake()` runs synchronously inside `play()`, so a play inside a gesture resumes inside it. No user activation yet
  (`navigator.userActivation.hasBeenActive === false`): no context is made (Chrome warns about one) and the play is
  refused at once; a `resume()` that rejects, or a context not running within `RESUME_WAIT_MS` = 1 s, is a refusal
  too [decision: generous, so a slow phone's resume inside a gesture is not taken for one]. A refusal is the
  `<audio>` path: `NotAllowedError`, page-saori's `afterGesture` plays it at the next activating gesture; the song is
  prepared meanwhile.
- iPhones [decision]: `navigator.audioSession.type = 'playback'` from a
  MIDI play until the engine idles, where it exists (Safari 16.4+), so MIDI ignores the silent switch as the `<audio>`
  sounds do; the old type comes back at the idle suspend. Safari 15.2–16.3: no workaround (no silent-`<audio>` trick):
  MIDI follows the switch there. Web Audio's volume works on iOS, so a music box's volume reaches MIDI on an iPhone
  (it does not reach `<audio>` there).
- Idle: each player holds the engine from its `play()` until a pause, its end, a failure or its release, counted by
  its own flag (two `\_v` MIDI in a row never suspend the second); none for `IDLE_MS` = 10 s → `suspend()`
  and the audio session given back [decision: no audio thread while nothing plays; a later play resumes it, without a
  gesture once the context has run in Chrome and Firefox [infer: sticky activation]; WebKit [verify]].
- `MidiPlayer` stands in for an `<audio>` element: `src`, `preload` (ignored: nothing loads before the first `play()`,
  so a paused music box restored on the next page downloads nothing [decision]), `paused`, `ended`, `duration` (NaN
  until ready), `currentTime`, `loop`, `volume` (0..1 clamped, linear as an element's), `error` (`{code: 4}` once
  failed), `onended` / `onerror` and listeners, `play()`, `pause()`, and `removeAttribute('src')` + `load()` as the
  release. `currentTime` while it plays is the last current `state`'s `pos` plus the context clock since its `at`.
- Positions at the song's end never reach the sequencer (`END_EPS` = 1 ms): a play from the end starts at
  0; a seek there while playing sends `pause` and ends the song (`ended`); paused, it stands at its end; with loop the
  end is the start. A track restored at its end ends at once (the finish event, no seek sent).
- Stale replies: every command carries `n`; a `state` or `ended` older than the last play, pause or seek is
  dropped, so a `\_v` restarted right at its end is not ended by the old end, and `currentTime` never jumps back. A
  current `state` saying "not playing" while play was sent (the node stopped at its end before that command) sends
  play again [decision: without it such a restart would stall]. With loop turned on while the node's `ended` is in
  flight, the player starts the song over itself, with no event.
- Failures (the MIDI file's fetch, a `blob.arrayBuffer()`, the prepare, the module, the node, its `error`,
  `processorerror`, an `AudioContext` constructor that throws): `error` set, the node closed at once, `error` once,
  waiting plays reject `NotSupportedError` → OnSoundError 14020 before it played, OnSoundStop `end` after (page-saori's
  rule for every sound). A failed sound is dropped, so its next play makes a new player and tries again (a bank failure
  is forgotten in the Worker, so that play downloads the bank again); a music-box track that failed stays silent until
  the next load. A bank failure is logged once (`midi-bank`). A play promise still waiting when a song ends at once
  resolves (it did play, to its end).

### 6.3 `page-saori.js`

- One factory, `_media(path, url, blob)`, for the music box (`MusicBox.attach`, path = the load's argument) and the
  sounds (`_startSound`, path = the tag's file): a MIDI path with an engine → `midi.player({url, blob})`, marked
  `__midi`; else `new Audio(url)`. The `Audio` gate stays in front of both (Node and the sweep send nothing).
- Drops hand their Blob to the factory (`openDropped` → `{url, release, blob}`): the player reads it directly, so no
  `fetch()` of a `blob:` URL, which a CSP's `connect-src` would refuse.
- The music box's error path, MIDI players only [decision]: the player's `error`, or a `play()` rejection other than
  `NotAllowedError` and `AbortError`, → `failed(a)`: ignored unless `a` is the current track; `wantPlay = false` (so
  `state()` saves `playing: false` and the next page does not try it again); logged once; no OnDSAPlayFinish /
  OnMAAPlayFinish [infer: the DLLs send theirs at a track's end, and a track their player could not open never ends;
  sending it would loop mikaru, which loads its OnMAAPlayFinish R0 again, at full speed on a bank that cannot load].
  An `<audio>` track that fails is logged and still wanted [decision]. `release()` clears
  `onerror` too.
- `_dropSound` releases a MIDI player (pause, `removeAttribute('src')`, `load()`), so its node and song go; an `<audio>`
  sound is left as it is.
- A loop (`\![sound,loop]`, mciaudior) is restarted by hand at each end (`currentTime = 0`, `play()`) with OnSoundLoop
  / OnMAAPlayLoop, as for `<audio>`: the gap is one message round trip [decision; ssp.exe also restarts on a
  notification, [verify] V3]. dsaudio's own loop is the node's (`loop` on the player: the processor starts over at
  tick 0 itself, no event).
- Resume after a page change: the code every sound uses. `state()` reads the player's `currentTime`; `restore()` loads
  at `at`, the kept position is sent as `seek` at `ready` (programs and controllers replayed, nothing left hanging); the
  new page prepares the song again (the bank from the HTTP cache). No IndexedDB cache of prepared songs [decision:
  30–120 ms per song on desktop; revisit if a phone shows a long gap, S6].

### 6.4 `maho`

`MAHO_TYPES` gains `smf: 'midi'` (the DLL reads magic bytes, and an SMF is `MThd` whatever its extension). `.rmi` stays
`unknown` (what the DLL says for `RIFF` … `RMID` is not known) [decision].

### 6.5 `drops.js`

`playable(type, name)`: a name `isMidiPath` → `midiSupported()`; otherwise by the type, as for any dropped audio.
`DropStore.add` passes the name [decision: MIDI kept by extension; the browser's type for MIDI varies (`audio/mid`,
`audio/midi`, empty) and `canPlayType` says no for MIDI everywhere]. Same limits as dropped audio (64 MB each, 256 MB in
total). `open(path)` → `{url, release, blob}`.

### 6.6 About

Information ▸ About Sumika lists, after the SHIORI lines, `MIDI: SpessaSynth core 4.3.22 (…)` and
`Sound bank: GeneralUser GS 2.0.3 (…)` (keys `info.midi`, `info.bank`; `MIDI` joins `PROPER_NOUNS`), as in
`midi.LICENSES.txt`.

### 6.7 Tests

`tests/runtime/midi_player.test.mjs` (20 tests) runs `MidiEngine` / `MidiPlayer` against a fake context, Worker and
worklet node (`tests/runtime/midi_fakes.mjs`, no test file); `tests/runtime/midi_sounds.test.mjs` (11) runs `PageSaori`
with a fake engine (`\_v`, `\![sound,loop]`, OnSoundError, which names are MIDI, drops, stop / pause / destroy, a
restart at the end, the music box's finish and loop events, its MIDI error path, autoplay, the idle rule); both with
a 20 s timeout per test (one mutation run hung instead of failing). `drops`, `info`, `standins` and `i18n` tests are
extended. Eight temporary code changes (no stale-reply check, no end guard, the old busy counter, `failed()` applied
to `<audio>`, no re-play, a context made before activation, no release in `_dropSound`, …) were each caught. The
worker bundle holds no MIDI code (the page side adds 13 bytes to it); `sumika.js` holds about 14 KB minified of it
(4.4 KB gzip).

## 7. Left: the browser check and the device checks

Browser check (Chromium, a scratch copy of the built site on its own port, `?sumika-debug`) [1, 2
and 5 made on the served `site/` itself, build `527fa764f824`; the rest not yet]:
1. Before any MIDI: no request for `midi.*.js` or `*.sf3.gz`. Made: with Tsubasa and Katari up and no click yet, the
   engine had no Worker, module or context, and the page's resource entries named no MIDI file. After the play they
   named only `m_canon.mid` (the page's own fetch): the Worker's `importScripts` and fetch and `addModule` are not in
   the page's resource timeline in Chromium [measured], so the check is the engine's state plus the HTTP cache: after
   the play the bundle and the bank answered a `cache: 'only-if-cached'` fetch with 200.
2. Katari: `m_canon.mid` through a sound play after a click on the page: one Worker and one module request for
   `midi.<h>.js` (the second from the cache), one `.sf3.gz`; the context `running`; `currentTime` advances;
   `currentTime = duration - 2` → OnSoundStop in the debug log. Made (her loop's `playScript('\_v[m_canon.mid]\e')`
   after one click): Worker and module made, context `running` at 48 kHz, `currentTime` advancing; a seek to
   `duration − 2` → OnSoundStop [m_canon.mid, end] reached her event loop (`notifyEvent`) 2.02 s later.
3. The same without a prior click: NotAllowedError (no context made), then a click plays it.
4. A dsaudio MIDI (a `File` added through the drop store, then dsaudio load / play): stored in IndexedDB; follow a link
   to page 2: the track resumes within about 1 s of where it was.
5. Two at once (also: `ctx.playbackStats`' underruns from the second song's play to 1.5 s
   after it sounds must not grow). Made with Katari's `\_v[m_canon.mid]`, then `\_v[m_holy.mid]` 1.5 s into it: both
   played, 0 underruns while the second started; both seeks to `duration − 2` → both OnSoundStop [file, end]. A
   music-box MIDI under a `\_v` is not made yet.
6. The full CSP line of docs/guide.md "Browsers": MIDI plays.
7. Timings: the first-play wait on localhost; per-song prepare ms in the debug log.

Device checks (with a trial site and ssp.exe):
- V1 two MIDI at once in ssp.exe (Katari's `\_v` over a dsaudio MIDI, or two ghosts): both, or does one take over?
- V2 OnSoundStop: at the last note or at the end of the track; are sounding notes cut at the end and at a stop?
- V3 a looped MIDI: the restart gap; does it start again from tick 0 (Katari's ~2 s lead-in)?
- V4 listening: Katari's canon in SSP and in Sumika; loudness against her WAV sounds (the synth's default gain is one
  constant).
- V5 which MIDI-out device the Windows install uses.
- V6 does ssp.exe play an `.rmi`?
- iPhone / Safari (with the phone and browser checks: CLAUDE.md "Unverified in browsers and on hosts"): MIDI plays on
  the iPhone; with the silent switch on it still plays on iOS 16.4+ (and is silent before 16.4); no crackle on an older
  iPhone; the first-play wait on mobile data; the gap before music resumes after a link (S6); after 10 s idle a ghost's
  next MIDI plays without a tap; console noise from the worklet scope.

// Assemble the MIDI player's notices, engines/midi/midi.LICENSES.txt (`npm run build` publishes it as
// sumika/engines/midi.LICENSES.txt), from the vendored files and two texts the vendor folders do not hold: fflate's
// licence (src/externals/fflate/LICENSE in https://github.com/spessasus/spessasynth_core) and stb_vorbis.c
// (wasm/stb_vorbis.c in https://github.com/spessasus/stb-vorbis), each at the gitHead engines/midi/pins.json names for
// its package (docs/research/midi.md §1). The vendor folders and versions come from engines/midi/pins.json, so a
// version bump needs no change here. stb-vorbis's WebAssembly is an Emscripten build (it imports Emscripten's runtime
// functions and exports malloc / free), so Emscripten's LICENSE and musl's COPYRIGHT follow too, read from the emsdk
// the engines are built with ($EMSDK, as emsdk's own environment sets it, else toolchain/emsdk), as the engine
// builds' notices take them (engines/common/notices.py emscripten).
// usage: node tools/make_notices.mjs <fflate LICENSE> <stb_vorbis.c> [out file (default: pins.json's notices.file)]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [fflatePath, stbPath, outArg] = process.argv.slice(2);
if (!fflatePath || !stbPath) {
  console.error('usage: node tools/make_notices.mjs <fflate LICENSE> <stb_vorbis.c> [out file]');
  process.exit(2);
}
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const text = p => read(p).replace(/^\s*\n/, '').trimEnd() + '\n';
const pinsJson = JSON.parse(read(path.join(root, 'engines', 'midi', 'pins.json')));
const pins = pinsJson.vendor;
const pin = name => {
  const p = pins[name];
  if (!p || !p.dir || !p.version) throw new Error(`engines/midi/pins.json has no dir or version for ${name}`);
  return { dir: path.join(root, p.dir), version: p.version };
};
const CORE = pin('spessasynth_core'), STB = pin('stb-vorbis'), GUGS = pin('generaluser-gs');
if (!outArg && !(pinsJson.notices && pinsJson.notices.file)) throw new Error('engines/midi/pins.json has no notices.file');
const outPath = outArg ? path.resolve(outArg) : path.join(root, pinsJson.notices.file);

const apache = text(path.join(CORE.dir, 'LICENSE'));
if (apache !== text(path.join(STB.dir, 'LICENSE'))) throw new Error('the two Apache LICENSE files differ');

// stb_vorbis.c: the licence block at the end of the file, without the comment markers
const stb = read(stbPath);
const i = stb.indexOf('This software is available under 2 licenses');
const j = stb.lastIndexOf('*/');
if (i < 0 || j < i) throw new Error('stb_vorbis.c: licence block not found');
const stbVersion = (stb.split('\n')[0].match(/v\d+\.\d+/) || [])[0];
if (!stbVersion) throw new Error('stb_vorbis.c: no version on its first line');
const stbBlock = stb.slice(i, j).split('\n').filter(l => !/^-+$/.test(l.trim())).join('\n').trim() + '\n';

// Dattorro: the header comment as it stands in dist/index.js
const core = read(path.join(CORE.dir, 'dist', 'index.js'));
const d0 = core.indexOf('* Dattorro Reverb Node');
const d1 = core.indexOf('*/', d0);
if (d0 < 0 || d1 < 0) throw new Error('Dattorro header not found');
const dattorro = core.slice(d0, d1).split('\n').map(l => l.replace(/^\s*\* ?/, '')).join('\n').trim() + '\n';

const gugs = text(path.join(GUGS.dir, 'documentation', 'LICENSE.txt'));
const fflate = text(fflatePath);

// Emscripten's own code and musl libc, as the emsdk holds them (the version is that emsdk's: the stb-vorbis build
// records none of its own)
const emsdk = process.env.EMSDK ? path.resolve(process.env.EMSDK) : path.join(root, 'toolchain', 'emsdk');
const em = path.join(emsdk, 'upstream', 'emscripten');
const emFile = rel => {
  const p = path.join(em, ...rel.split('/'));
  if (!fs.existsSync(p)) throw new Error(`${p} is missing: install the emsdk (docs/building.md "What the builds need") or set EMSDK`);
  return p;
};
const emVersion = (read(emFile('emscripten-version.txt')).match(/\d+\.\d+\.\d+/) || [])[0];
const muslVersion = (read(emFile('system/lib/libc/musl/VERSION')).match(/\d+\.\d+\.\d+/) || [])[0];
if (!emVersion || !muslVersion) throw new Error('the emsdk names no Emscripten or musl version');
const emLicense = text(emFile('LICENSE'));
const muslCopyright = text(emFile('system/lib/libc/musl/COPYRIGHT'));

const out = `Sumika's MIDI player is two published files and their notices: a worklet module, Sumika's own code bundled
with spessasynth_core ${CORE.version} by spessasus (https://github.com/spessasus/spessasynth_core) and with stb-vorbis ${STB.version}
by spessasus (https://github.com/spessasus/stb-vorbis: Sean Barrett's stb_vorbis.c ${stbVersion} compiled to WebAssembly),
and the sound bank GeneralUser GS v${GUGS.version} by S. Christian Collins (https://www.schristiancollins.com/generaluser) as
an SF3 file (its samples compressed to Ogg Vorbis by SpessaSynth, https://github.com/spessasus/SpessaSynth). Every
notice in that code and the bank's licence follow.

== spessasynth_core and stb-vorbis (Apache License 2.0), LICENSE (the same file in both packages)

${apache}
== fflate (MIT), bundled in spessasynth_core: its src/externals/fflate/LICENSE

${fflate}
== stb_vorbis.c ${stbVersion} (MIT or public domain), compiled into stb-vorbis: the licence block at the end of the file

${stbBlock}
== The Dattorro reverb in spessasynth_core (public domain), its header comment

${dattorro}
== GeneralUser GS v${GUGS.version} (GeneralUser GS License v2.0), documentation/LICENSE.txt

${gugs}
== Emscripten runtime and C library in stb-vorbis's WebAssembly

stb-vorbis's WebAssembly is an Emscripten build: Emscripten's own code (MIT or University of Illinois/NCSA) and
musl libc (MIT) want their texts, which follow as of Emscripten ${emVersion} and musl ${muslVersion} (the versions Sumika's
engines are built with; the stb-vorbis build records none).

=== Emscripten (MIT or University of Illinois/NCSA), upstream/emscripten/LICENSE

${emLicense}
=== musl libc (MIT), upstream/emscripten/system/lib/libc/musl/COPYRIGHT

${muslCopyright}`;
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log(`${outPath}: ${Buffer.byteLength(out)} bytes`);

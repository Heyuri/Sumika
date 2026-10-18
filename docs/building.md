# Building and testing Sumika

How to rebuild Sumika and the admin programs, what the builds need, how to run the tests, and where the code is.

## Building

The built runtime and engines are in the repository, in `site/sumika/`: serving a site and adding ghosts need no build.
To rebuild (what each step needs: [What the builds need](#what-the-builds-need)):

```bash
. tools/env.sh                 # Node and Emscripten from toolchain/ (Git Bash); not needed with a Node 24 on PATH
npm install                    # esbuild, the one package the build uses (the version package-lock.json pins)
python engines/satori/build.py # vendor/satoriya-shiori -> site/sumika/engines/satori.js + .wasm (+ satori.LICENSES.txt)
python engines/yaya/build.py   # vendor/yaya-shiori -> site/sumika/engines/yaya.js + .wasm (+ yaya.LICENSES.txt)
python engines/kawari/build.py # vendor/kawari-8.2.8 -> site/sumika/engines/kawari.js + .wasm (+ kawari.LICENSES.txt)
python engines/kawari7/build.py # vendor/kawari-7.5.0 -> site/sumika/engines/kawari7.js + .wasm (+ kawari7.LICENSES.txt)
npm run build                  # src/ -> site/sumika/sumika.js, engines/worker.<code>.js, the engines' coded copies,
                               # the MIDI player engines/midi.<code>.js, its sound bank and midi.LICENSES.txt,
                               # the control page index.html and engines/control.<code>.js, the storage hub
                               # hub.html and engines/hub.<code>.js, build.json
npm test                       # unit tests (Node; some run tools/index_site.py and add_ghost.py with Python; see Tests)
```

The engine builds are only needed after a change to an engine, but `npm run build` must run after every one of them:
pages load the coded copies it makes, and the tests fail until they match the engine files again. It writes the same
names and bytes for the same sources, wherever it is run from, and rewrites no file that would not change. It never
deletes an older version's files (that is `tools/prune.mjs`, before an upload), and it stops before writing anything
when an engine file is missing, when the MIDI player's sources or sound bank in `vendor/` differ from the hashes in
`engines/midi/pins.json`, or when the last build recorded a newer version of the visitors' stored data (see
[Publishing](guide.md#publishing)). `npm run build:min` makes a minified build without `.map` files (except the MIDI
player's, which is minified either way and always keeps its map, so its coded name never changes bytes); `node
tools/build.mjs --watch` builds again after each change under `src/`. `python tools/serve.py --cache none` (no cache
headers, as a plain nginx) or `--cache 600` (as GitHub Pages) lets you watch an update reach a browser locally; use a
copy of the site for that (`--site <folder>`).

The Emscripten SDK in `toolchain/emsdk` and the engines' sources in `vendor/` are only needed for building the engines;
`npm run build` needs the MIDI player's three folders there, unchanged: the ones `engines/midi/pins.json` names
(`spessasynth_core-4.3.22`, `stb-vorbis-0.0.6`, `generaluser-gs-2.0.3-sf3`).

Each engine build checks its sources in `vendor/` before it compiles:

- `vendor/satoriya-shiori` and `vendor/yaya-shiori` are plain copies of the upstream commits Sumika was tested with
  (they have no `.git` of their own here; `vendor/SOURCES.txt` names the commits). The two builds hash the files they
  read from them (`INPUTS_PIN` in each `build.py`, computed by `engines/common/vendor.py`) and name the commits the
  copy was made from (`COPY_OF` in the Satori build, `PINNED` in the YAYA build). `engines/yaya/build.py` stops when
  the hash differs (`--allow-vendor-drift` builds anyway and records `drift: true` in `yaya.build-info.json`);
  `engines/satori/build.py` warns and writes `inputsPin` and `drift` into `satori.build-info.json`.
- In a git checkout of its own (a clone of the upstream at those commits, put in place of the copy), the builds name
  the checkout's own commits instead: YAYA stops unless it and its five submodules are at `PINNED` with no local
  changes.
- `engines/kawari/build.py` and `engines/kawari7/build.py` hash their whole `vendor/kawari-*` folder (`TREE_PIN`) and
  stop when it differs (`--allow-vendor-drift`, as above).

All the builds take the code page 932 table from `engines/common/gen_cp932.py`, which checks it against conversions
measured on Windows, and publish nothing that names the builder's folders (a `--debug` build goes to the engine's
`build/out-debug` folder, and is refused, because the Emscripten library cache carries its builder's path).

`node admin/build.mjs` builds the [admin tool](guide.md#the-admin-tool)'s four programs into `admin/dist/<version>/`,
with their `SHA256SUMS.txt`. It works offline: Deno 2.9.7 and its runtimes come from `toolchain/deno-2.9.7/`, checked
against `admin/pins.json`. On Windows it then tries the Windows program on scratch folders before it reports.

## What the builds need

None of these is in the repository (its `.gitignore` keeps `node_modules/` and `toolchain/` out):

- **Node**, for `npm run build`, `npm test`, the `tools/*.mjs` scripts and `admin/`. Sumika is built and tested with
  Node 24.19, the one the Emscripten SDK below installs; `. tools/env.sh` puts it on PATH, so run it before
  `npm install` when your Node comes from there. Without the SDK, a Node 24 already on PATH runs `npm install`,
  `npm run build` and `npm test` (`package.json` sets no `engines` field; only 24.19 has been tested). `npm install`
  installs esbuild, the only package (a devDependency, at the version `package-lock.json` pins).
- **Python 3**, for `tools/*.py` (serving, adding ghosts, indexing), the engine builds and the tests that run the
  tools (the `PYTHON` environment variable names another interpreter than `python`).
- **The Emscripten SDK 6.0.11** in `toolchain/emsdk` (about 1 GB), for the four engine builds only. The build scripts
  call it there, through the SDK's own Python (`toolchain/emsdk/python/3.13.3_64bit/python.exe` on Windows; without
  it, the Python that runs the script), and write its version into each `*.build-info.json`
  (`"emcc": "6.0.11 (a0014542110d6078c3a1a7941fa1ddb3a2281f16)"`). Install it with the SDK's own installer, from the
  emsdk commit Sumika was built with:

  ```bash
  git clone https://github.com/emscripten-core/emsdk toolchain/emsdk
  cd toolchain/emsdk
  git checkout 96c657fc60920d2a6a82318aa50e0abf82749604
  ./emsdk install 6.0.11       # from cmd or PowerShell: emsdk.bat install 6.0.11
  ./emsdk activate 6.0.11      # writes toolchain/emsdk/.emscripten, which the builds read
  ```

  The Node and Python the SDK installs come from the emsdk checkout's own manifest, not from the SDK version: at that
  commit they are Node 24.19.0 and Python 3.13.3 (the Python on Windows and macOS only), whose folders
  (`toolchain/emsdk/node/24.19.0_64bit`, `toolchain/emsdk/python/3.13.3_64bit`) `tools/env.sh` and the four build
  scripts name. A later emsdk checkout may install other versions, and those paths would then not exist.
- **Deno 2.9.7**, for `node admin/build.mjs` only: the five archives `admin/pins.json` pins, from Deno's release
  https://github.com/denoland/deno/releases/tag/v2.9.7 (each at
  `https://github.com/denoland/deno/releases/download/v2.9.7/<file>`), saved unchanged in `toolchain/deno-2.9.7/`.
  The build checks each one's size and SHA-256, unpacks the programs into `admin/build/` and downloads nothing: a
  missing or different archive stops it, naming the one to download. It runs the Windows `deno.exe`, so the programs
  are built on Windows; `--target` leaves out the runtimes of the targets it does not build.

  | File | Bytes | SHA-256 | Holds |
  |---|---|---|---|
  | `deno-x86_64-pc-windows-msvc.zip` | 42,630,221 | `a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238` | `deno.exe`, which compiles |
  | `denort-x86_64-pc-windows-msvc.zip` | 32,692,172 | `1ed45440e881cbadbfa754c8dd25c70635bf3b16a5ad663f65ec3c5cc4a975fd` | the runtime of `windows-x64` |
  | `denort-aarch64-apple-darwin.zip` | 28,741,449 | `b0a08debcba347f9bf2391ac0e12f99f27c7a375ad561baeccb35f01369acda4` | the runtime of `macos-arm64` |
  | `denort-x86_64-apple-darwin.zip` | 31,598,122 | `4f909123297d4921d72f70effea23b65d7ef8b9f40de6d3351d28eef7b9e884c` | the runtime of `macos-x64` |
  | `denort-x86_64-unknown-linux-gnu.zip` | 34,409,117 | `ab416b7470f3f7c6d7b4363be475e5d8cf3d8469d866b3b8459a332a5874cd0d` | the runtime of `linux-x64` |

## Tests

`npm test` runs the unit tests with Node; a few run the Python tools on scratch folders, so Python must be there too.
A good run ends with `fail 0`. A test that reads what the repository does not hold skips, with the reason
(`tests/needs.mjs`): one of the ghosts Sumika was tested with (`site/ghost/<id>`), the recorded answers of real SHIORI
DLLs (`tests/corpus/`) and the test fixtures made from a ghost's files (all development material, not in the
repository), or SSP's word list (`site/sumika/word_compatible.txt`). To run the ghosts' tests, add those ghosts under
the ids the tests name (`python tools/add_ghost.py <folder> --id <id>`: without `--id` the id is the folder's name;
the list, with the archive each one comes from, is in `CLAUDE.md`, "The ghosts Sumika was tested with") and copy the
word list from an SSP install; with them all, the corpus and the fixtures, a run ends with `skipped 0` as well.

Two test files check the published set on the real `site/`: `tests/build_output.test.mjs` fails until
`npm run build` has run on the current sources (and again after an engine build), and
`tests/runtime/index_versions.test.mjs` until `python tools/index_site.py` has run after the last change under
`site/ghost/` or `site/balloon/`.

## Code

| Path | What |
|---|---|
| `src/core/` | loader (index, files, text packs), storage and the versions of what it stores (`schema.js`), the build's table of runtime files (`build.js`), SHIORI client, event loop, state, the page's site and its set of ghosts (`site.js`, `ghostset.js`), one runtime per ghost, shell and balloon lists (`shells.js`), UI strings (`i18n.js`) and language choice (`language.js`), the visitor's user information (`user.js`), SSP's property system (`properties.js`), phone detection and the script tag's phone options (`phone.js`), the browser check (`support.js`), the site's default and the visitor's on or off (`choice.js`), canvases that cannot draw (`canvas.js`), the page side of the MIDI player (`midi.js`) and the sound players ghosts drive (`page-saori.js`) |
| `src/control/` | the control page's own small bundle (`sumika/index.html`): the visitor's Site default, On or Off |
| `src/shell/` | surfaces.txt parser, compositor, SERIKO/MAYUNA animation, character windows, hit testing |
| `src/balloon/` | balloon skins, text layout, choices, input and communicate boxes |
| `src/sakura/` | SakuraScript tokenizer and player, the %-variable expander (`expand.js`) |
| `src/ui/` | right-click menu (with its thumbnail window, `thumbnail.js`), the Information window, the Preferences box (`settings.js`), launcher, one layer per ghost (`layers.js`), the visible part of a phone's screen (`viewport.js`), shadow-DOM root |
| `src/worker/` | engine host (Web Worker), SAORI stand-ins |
| `src/midi/` | the MIDI player's own bundle: a Worker that downloads the sound bank and prepares each song, and the audio worklet that plays it (on spessasynth_core) |
| `engines/midi/` | the MIDI player's pinned inputs (`pins.json`) and their notices |
| `engines/satori/`, `engines/yaya/`, `engines/kawari/`, `engines/kawari7/` | Satori, YAYA, Kawari and Kawari 7 → WebAssembly build scripts and patches |
| `engines/common/` | the code page 932 table the engines share, and the Windows measurements it is checked against |
| `admin/` | the admin tool: the JavaScript twin of `tools/add_ghost.py` and `tools/index_site.py` (`core/`; `npm run parity` checks that both give the same results), the local program (`server/`), its page (`page/`) and the build of its programs (`build.mjs`) |
| `tests/` | Node tests (see [Tests](#tests)); the real-DLL responses of Tsubasa and emily4 they compare with, `tests/corpus/`, are development material, not in the repository |
| `docs/` | `guide.md`, `building.md` (this page), `differences.md` and `licenses.md`; architecture, module contracts, research specs |

# Sumika: developer notes

Sumika (住処, "home": a dwelling place) runs ukagaka ghosts, the desktop mascots made for SSP, in a browser tab,
from the ghosts' original unmodified files.
- The SHIORI engines Satori, YAYA (which also runs AYA5 ghosts), Kawari 8.2.8 (Phase 8 ghosts) and Kawari 7.5.0
  (Phase 7 ghosts, spoken to in SHIORI/2.x) are compiled to WebAssembly and run in a Web Worker.
- `src/` holds the SHIORI client and event loop, the SakuraScript player, and the shell (character) and balloon
  renderers; `src/midi/` the MIDI player (spessasynth_core and the GeneralUser GS bank in a Worker and an
  AudioWorklet), loaded only when a ghost first plays a MIDI file.
- Each page includes `site/sumika/sumika.js`. Following a link reloads the ghosts, which resume from the state saved in
  the visitor's browser. Several ghosts can be on screen at once (Call ghost ▸, `\![call,ghost]`).

`README.md` is the front page for people, and `docs/guide.md`, `docs/building.md`, `docs/differences.md` and
`docs/licenses.md` hold the details. This file is the developer guide: read it first before changing Sumika.
Sumika's own code is under the MIT License (`LICENSE`); the third-party parts in `vendor/` and what is compiled from
them keep their own licences (docs/licenses.md).

A Sumika site holds many ghosts, Japanese originals and English translations, in an SSP-style `site/ghost/<id>/`
folder, switchable like in ssp.exe. The repository ships none: its `site/ghost/` holds only `.gitkeep`. Sumika was
developed and tested with ghosts on every engine, which a developer adds to a local `site/ghost/` with the tools
below: Tsubasa (となりの羽山さん, English translation) and others on Satori; emily4, bonsyou and nodepsimoon on YAYA;
bthver.5 and machimaki on Kawari; mayura on Kawari 7 ("The ghosts Sumika was tested with").

## Project rules

- **Ghost files are never edited.** `site/ghost/<id>/` is a filtered copy of a ghost from an SSP install
  (`<ssp>/ghost/<id>`), or of a pristine extraction of its archive (bthver.5, machimaki and mayura were copied that
  way; bthver.5 was copied again from an SSP install after SSP's network update). Edit neither, nor the archives.
  - Compatibility goes into the runtime: stand-ins, lenient parsing. Sumika has no code for individual ghosts.
  - A problem that a ghost's own content causes (for example an English line too long for its menu) is the ghost's
    matter, not Sumika's.
- **No ghost goes into the source repository.** Ghosts are test data, copied into a local `site/ghost/` with the
  tools below; `.gitignore` keeps them out, and with them what adding them writes into `site/sumika/index/` (their
  manifests and packs, and those of the balloons they bring) and the Kawari record `site/sumika/kawari-shipped.json`.
  - The repository keeps the index of its own site, no ghost and the default balloon (`ghosts.json` and
    `balloon.sumika.<h>.*`) [decision], so a fresh clone serves at once and the index checks of `npm test` pass on
    it. A local index run rewrites `ghosts.json` to list the local ghosts: never commit it so
    (`git checkout site/sumika/index/ghosts.json` brings the empty one back, and the next index run lists the ghosts
    again; `git update-index --skip-worktree` hides the change). A change that moves that index (index `FORMAT`, the
    default balloon) is committed with the index of a site without ghosts: index a scratch copy of `site/` whose
    `ghost/` is empty (`python -I tools/index_site.py <copy>`) and commit its `ghosts.json` and
    `balloon.sumika.<h>.*`.
- **Development material that is not in the repository.** These docs also name what Sumika was developed with: the
  ghosts above (`site/ghost/<id>`), the real-DLL corpora `tests/corpus/` ("Test data"), the research leftovers
  `docs/research/scratch/` ("Gotchas"), SSP's word list `site/sumika/word_compatible.txt` ("What gets published"),
  and the toolchains in `toolchain/` (docs/building.md "What the builds need"). Where a doc cites a file there, it is a
  record of the source, not a file of the repository; tests that need one skip with the reason ("Commands"). The
  docs say so in one wording, "development material, not in the repository": here where each is named, and in each
  research doc once, in a "Not in the repository" note near its top.
- **Never ship personal data.**
  - The SSP user's own data lives in `profile/` folders and in the engine's save files.
  - `tools/add_ghost.py` leaves these out, and `tools/index_site.py` refuses to index a site that has them
    (`PERSONAL_DIRS` / `PERSONAL_FILES` / `PERSONAL_PATHS` in index_site.py; for YAYA and Kawari the runtime's
    `YAYA_SKIP` / `KAWARI_SKIP` skip `profile/`, saves and logs again).
  - The guard knows Satori (`satori_savedata*`, `satori_savebackup*`), YAYA/AYA (`*_variable.*`: `.cfg`, `.cfg.ays`,
    SSP's `yaya_variable.ays`) and engine logs (`*.log`; some archives even ship one). Other SHIORIs write their own
    files; for example the MEMORY_ ghost gets `s_vars.txt` and `s_conf.txt` in an SSP install.
  - Kawari saves have no fixed names: each ghost picks its own (`savefile1.txt`, `dict-keeps-savedata.txt`,
    `brain/…`; BTH4th_last's holds the user's name, sex and birthday). So `--archive` and a `PERSONAL_PATHS` line per
    save are the gate, and a net sits on top [decision, kawari-wasm.md §12]: in a `kawari` / `kawari7` ghost
    `index_site.py` refuses a file that starts with Kawari's save header (`KAWARI_SAVE_HEAD`) unless
    `KAWARI_SHIPPED_SAVES` lists it with its archive's CRC-32 (an author's default; `add_ghost.py --archive` prints the
    line), or the site's record `sumika/kawari-shipped.json` lists it for that ghost with its CRC-32. From a folder (an
    installed ghost) `add_ghost.py` refuses such a ghost before copying anything; from the ghost's own `.nar` / `.zip`
    (the admin core's archive source, `add_ghost.py <its extraction> --archive <it> --from-archive`) such files are
    the author's starting files: copied, and recorded there with their CRC-32 ("The admin tool", "From an archive").
    `add_ghost.py` prints `install.txt`'s `refreshundeletemask` (often the author's list of saves) with the files it
    names, for every ghost.
  - Ghosts write files of their own too. `PERSONAL_PATHS` holds what an SSP run created inside one ghost,
    ghost-root-relative, any case, glob patterns (for example bonsyou's `ghost/master/var/bonsyou*.txt`: its two
    http-get results, `bonsyou.txt` and the menu counter's `bonsyou_now.txt`).
  - Before adding any ghost, compare the installed folder with its original archive by **file names and contents**:
    `add_ghost.py <ghost> --archive <.nar|.zip|updates2.dau|updates.txt>` does it (a .nar's CRC-32s and sizes, an
    update list's MD5s and `size=`) and copies nothing while a file is unlisted or differs (`install.txt` and
    `updates*` count as listed). A shipped file an SSP run rewrote counts too (flele's empty `dat/tmp.m3u` becomes a
    playlist of the user's music paths). An SSP-bundled ghost like emily4 has only its `updates2.dau`. Add every file
    that SSP's run created or rewrote to `PERSONAL_PATHS` (a new kind of engine save to `PERSONAL_FILES`), or name a
    legitimate one with `--keep <path>`.
  - Personal files in an SSP install are never opened.
- **ssp.exe is the reference for behaviour.** Observations of ssp.exe beat the research docs' guesses. Fix toward SSP,
  then write the rule into the matching `docs/research/*.md` with the tag `[observed]`.
  - The reference build is ssp.exe **FileVersion 2.9.10.3000** (its version resource; the Kawari research R1 read this
    build). SSP updates itself: some docs cite 2.9.08f's disassembly addresses or call the build 2.9.9.3000, and
    every function compared between 2.9.08f and that build was identical. Before trusting an old address for new work,
    check it in the reference build.
  - `basewareversion` says 2.9.8.0 (`BASEWARE` in `src/core/events.js`), and `%property[baseware.version]` is built
    from it (`SSP/2.9.08 (sumika-1.0.0; Web)`, `system.platform` `ssp.exe`): both stay on 2.9.8 [decision].
- **No ghost's DLL or EXE is run**, by the runtime, the tools or the tests. The real-DLL corpora in `tests/corpus/` are
  records (development material, not in the repository: "Test data"); there is none for Kawari.
- **Tools and tests make no network requests.** Builds work offline from pinned inputs, tests of web requests use a
  fake fetch, and the ghost sweep stubs `fetch`.
- **Downloads and archives are untrusted data.** Each goes into its own new, empty folder; its files are never run;
  Python that reads them runs with `-I`. Third-party inputs are pinned (`PINNED` and `COPY_OF` with `INPUTS_PIN`, `TREE_PIN`,
  `engines/midi/pins.json`, `admin/pins.json`: "Commands"; `vendor/SOURCES.txt` lists where each `vendor/` folder
  came from).
- **SSP's own files are not redistributed** (its default balloon, its icon), and none is in the repository. SSP's word
  list is a separate file, `sumika/word_compatible.txt`, that a publisher copies from an SSP install or leaves out
  ("What gets published").
- **No limits SSP lacks.** Any number of ghosts on screen, as in SSP (a site may cap it with `data-max-ghosts`).
  Menu items that cannot work in a browser are left out (Network update, Uninstall: a visitor's browser updates and
  installs nothing).
- **The admin tool is tested on scratch copies.** During development the program never adds or removes anything in
  the project's real `site/` (a dev run refuses it as a site).

## Commands

The commands run from the project root in a POSIX shell (Git Bash on Windows). Where the working directory does not
persist between calls, use absolute paths.

- **`. tools/env.sh`** goes first in every shell that needs Node, where Node is not on PATH otherwise (before
  `npm install` too). It puts Node 24.19 and Emscripten from `toolchain/emsdk` on PATH: the Emscripten SDK 6.0.11,
  installed there from emsdk commit `96c657fc60920d2a6a82318aa50e0abf82749604` as docs/building.md "What the builds
  need" says, whose manifest gives the `node/24.19.0_64bit` and `python/3.13.3_64bit` folders that env.sh and the engine
  builds name; `toolchain/` is not in the repository. Without the SDK, a Node 24 already on PATH serves `npm install`,
  `npm run build` and `npm test` (only 24.19 is tested). `npm install` installs esbuild, the one devDependency.
- **`npm test`** runs about 1,600 tests in about 65 s (up to 90 s on a busy machine). Seven files run Python
  (`tests/runtime/kawari_guard.test.mjs`: `python -I tools/index_site.py` and `add_ghost.py` on a scratch site in the
  OS temp folder; `thumbnail.test.mjs`, `trayicon.test.mjs` and `index_versions.test.mjs`: `index_site.py` on one;
  `tests/serve.test.mjs`: `serve.py`'s Handler in-process on a stand-in keep-alive connection, no socket;
  `tests/admin/core.test.mjs` and `parity.test.mjs`: the admin core against `index_site.py` / `add_ghost.py`, "The
  admin tool"; `PYTHON` names another interpreter); without Python they fail. `tests/build_output.test.mjs` runs
  `tools/build.mjs --site` on a scratch site (and the MIDI pins check on scratch copies of the pinned folders) and
  `tests/prune.test.mjs` runs `tools/prune.mjs` on one, all in the OS temp folder; `tests/midi_engine.test.mjs` bundles
  `src/midi/engine.js` there and renders Katari's `.mid` files offline (about 35 s of the run, in parallel with the
  rest). None goes on the network: `\![execute,http-*]` tests use a fake fetch, and an EventLoop without a window (and
  no `fetch` option) sends nothing.
  - A good run ends with `fail 0`. A skip means missing data, and says which: a test that reads what the repository
    does not hold skips with the reason while it is missing (`needs(…)` in `tests/needs.mjs`): a ghost of "The ghosts
    Sumika was tested with" (`site/ghost/<id>`, added under that id), `tests/corpus/`, a fixture made from a ghost's
    files ("Test data"), or SSP's `site/sumika/word_compatible.txt`; also the built `site/sumika/engines/satori.js`
    (`satori_integration.test.mjs`). With all of them in place (development material, not in the repository, and
    SSP's file) a full run ends with `skipped 0` too. An import
    error in `src/` is a failure, never a skip; so is a missing `site/sumika/engines/yaya.js`, `kawari.js` or
    `kawari7.js` (those tests fail with "run python engines/yaya/build.py" / "engines/kawari/build.py" /
    "engines/kawari7/build.py").
  - The published set is checked on the real `site/` (safe updates: "What gets published"), so two tests fail until
    the site is built and indexed: `tests/build_output.test.mjs` until `npm run build` has run on the current tree, and
    again after every engine build until it runs once more ("an engine was rebuilt: run npm run build": the hashed
    copies must equal the plain files the tests load); the real-site half of `tests/runtime/index_versions.test.mjs`
    until `python -I tools/index_site.py` has run after the last change under `site/ghost/` or `site/balloon/`.
  - One file: `node --test tests/balloon/layout.test.mjs`.
  - One test: `node --test --test-name-pattern="…" tests/balloon/layout.test.mjs`. The flag must come before the file;
    after it, the flag is silently ignored.
  - A new test folder must be added to the globs in `package.json`.
- **`npm run build`** (`node tools/build.mjs [--minify] [--watch] [--site DIR]`, DIR default `site`) writes the
  published runtime set (safe updates: every name below holds a hash of its bytes, so an unchanged file keeps its name
  and visitors' caches):
  - `src/worker/worker.js` → `sumika/engines/worker.<h>.js` (+ `.map`), `h` = `nameHash` (`tools/hashname.mjs`: 10
    hex of the SHA-1 with the trailing `//# sourceMappingURL=` line left out, since that line names the hashed map);
  - a copy of each engine pair the engine builds wrote under plain names, `<e>.<h>.js` and `<e>.<h2>.wasm` (two
    hashes: YAYA's JS patches can change the `.js` alone, and a `.wasm` is 0.4 to 2.6 MB);
  - the MIDI player (`docs/research/midi.md` §5.6): `src/midi/engine.js` → `sumika/engines/midi.<h>.js` + `.map`, the
    same with and without `--minify` (always minified, third-party code, and always with its map: `nameHash` leaves
    the map line out, so a map only some builds wrote would change the bytes under one name); the pinned bank
    `vendor/generaluser-gs-2.0.3-sf3/GeneralUserGS.sf3` → `generaluser_gs.<h>.sf3.gz` (gzip -9; `h` = `nameHash` of
    the SF3 itself, since gzip bytes differ by OS and zlib; written only when absent, through a `.tmp` and a rename);
    `engines/midi/midi.LICENSES.txt` → `sumika/engines/midi.LICENSES.txt` (plain name);
  - the control page (Code "On or off" below): `src/control/main.js` → `sumika/engines/control.<h>.js` (+ `.map`
    unless `--minify`; about 13 KB, 9.5 KB minified), then the fixed-name `sumika/index.html` naming it
    (`controlHtml`: its style, the script deferred, a noscript line, no inline script), written only when its bytes
    change;
  - the storage hub (Code "The storage hub" below): `src/hub/hub.js` → `sumika/engines/hub.<h>.js` (+ `.map` unless
    `--minify`), then the fixed-name `sumika/hub.html` naming it (`hubHtml`: no inline script, the script classic and
    blocking), written only when its bytes change;
  - `src/main.js` → `sumika/sumika.js` (+ `.map`), built twice: the SHA-1 (12 hex) of the first pass is the build id
    `BUILD` the second gets, with the table of hashed names (`__SUMIKA_BUILD__`, `__SUMIKA_FILES__`:
    `src/core/build.js`);
  - `sumika/build.json`: `{format: 1, build, schema: SCHEMA, worker, engines, midi: {js, bank}, hub, control}`, the
    same table as in the bundle plus `hub` and `control`, which the bundle's table never holds (pages reach the hub by
    the fixed `hub.html`, and no page loads the control page, so a change of either does not change `sumika.js`);
    order of writing: control script, `index.html`, hub script, `hub.html`, `sumika.js`, `build.json`;
  - one line naming the build id and the files.

  Pages see `src/` changes only after a build; tests import `src/` directly. **Run it after any engine build too**:
  pages load the hashed copies, and `tests/build_output.test.mjs` fails until they equal the plain files again.
  - It stops before writing anything when a plain engine pair is missing ("run python engines/<e>/build.py"), when a
    MIDI vendor folder's tree pin or file count, or the bank's SHA-256 or size, differs from `engines/midi/pins.json`
    or the notices file is missing ("vendor/… differs from engines/midi/pins.json: restore it"), or when the previous
    `build.json` records a higher `schema` for any record kind than `src/core/schema.js` `SCHEMA` (a schema bump is
    one-way; to build an older tree on purpose, delete `build.json`, and never publish that build).
  - esbuild runs with `absWorkingDir` = the project, so the same tree gives the same names and bytes from any working
    directory; a file whose bytes would not change is not written again (its mtime stays: nginx's and Apache's ETag).
  - It deletes nothing but a leftover `sumika.js.map` under `--minify` (`npm run build:min`, which writes no maps but
    the MIDI bundle's). Older hashed workers and engine copies stay for `tools/prune.mjs`. `--watch` runs the full
    build again after a change under `src/` (debounced); each rebuild leaves the previous worker, which the next prune
    deletes.
- **`python engines/satori/build.py`** is only needed after changing `engines/satori/patches.py`,
  `engines/common/gen_cp932.py` or `vendor/satoriya-shiori`. It takes about 1 minute.
  - `vendor/satoriya-shiori` is a copy of upstream commit `e2bf348` (Mc203-6) and deelx `af1a690`, without a `.git`
    of its own (git run there would answer for the enclosing repository: `engines/common/vendor.py`
    `own_checkout`). `identity()` names those commits from `COPY_OF` and hashes the 134 files the build reads
    (`inputs()`: `LICENSE` and the `.cpp`/`.h` of `satori/`, `_/`, `deelx/`; `vendor.files_pin`, the tree pin of
    kawari-wasm.md §1 over a file list) against `INPUTS_PIN`: a difference is a warning, not a stop.
    `satori.build-info.json` gets `satori`, `deelx`, `inputsPin` and `drift` (the shipped file has the last two only
    once the next Satori build writes it).
    A git checkout of its own in its place names its own commits; the pin is checked the same way.
  - It runs em++ as `toolchain/emsdk/python/3.13.3_64bit/python.exe …/em++.py`, because the `em++.exe` launcher fails
    ("No module named emcc"). Don't call em++ yourself.
  - Each patch's old text must match exactly once.
  - `-ffile-prefix-map` keeps the builder's absolute path (with the Windows user name) out of the published wasm's
    assert strings. Keep it.
  - `--out DIR` (default `site/sumika/engines`); `--debug` (`-O0 -g`, assertions) writes to
    `engines/satori/build/out-debug/` unless `--out` names a folder. It links in `engines/satori/build/link-*` and
    publishes nothing whose `satori.js`/`satori.wasm` names the builder's home or project path (YAYA's check). That
    check refuses a `--debug` build: emsdk's cached debug libc++ libraries carry the builder's path (kawari-wasm.md
    §2) [measured].
  - It also writes `satori.LICENSES.txt` (Satori's BSD-2-Clause, MT19937's BSD-3-Clause, DEELX's header, which says
    only "All Rights Reserved"): both licences want their notice with the binary. A rebuild with nothing changed gives
    a bit-identical wasm.
  - Every engine's `*.LICENSES.txt` (all four builds) ends with `engines/common/notices.py` `emscripten(EMSDK)`: what
    Emscripten compiles into each engine, read from `toolchain/emsdk` (its version, Emscripten's `LICENSE` and musl's
    `COPYRIGHT` in full, dlmalloc's version and CC0, LLVM's libc++, libc++abi, libunwind and compiler-rt named with
    their release, Apache-2.0 WITH LLVM-exception asking no notice); a version or licence line that moved stops the
    build.
- **`python engines/yaya/build.py`** (`docs/research/yaya-wasm.md`) is only needed after changing
  `engines/yaya/patches.py`, `engines/common/gen_cp932.py` or `vendor/yaya-shiori`. A full build takes about
  1.5 minutes (sqlite3 alone about 40 s); unchanged objects are kept (`engines/yaya/build/obj-<variant>/`, keyed by a
  hash of the source, every header, the flags and the emcc version). Same em++ call and exact-once patches as Satori;
  the linked `yaya.js` gets `JS_PATCHES` too (J1: MEMFS removes a name in its own case), each expression exactly once.
  - It checks its inputs first (`check_vendor`). The repository's `vendor/yaya-shiori` is a copy of the commits in
    `PINNED` (Tc606-2, `e69fefb`, and its submodules deelx, gumbo, parson, sqlite and tinyxml2) without a `.git` of
    its own (`engines/common/vendor.py`, as for Satori): the build hashes the 151 files it reads (`inputs()`: the files
    directly in it, `messagetxt/`, `gumbo/src/` and the submodule files it copies or quotes) and stops unless they
    match `INPUTS_PIN`; build-info then names the `PINNED` commits. A git checkout of its own in its place must be at
    `PINNED`, submodules included, with a clean tree. Either way `--allow-vendor-drift` builds anyway and writes
    `drift: true` into `yaya.build-info.json`. Never `submodule update --remote` in such a checkout: a new pin means
    matching the patches again and re-running the checks in yaya-wasm.md, and a new copy a new `INPUTS_PIN`.
  - `--opt O2` (the default, and what the site ships: yaya-wasm.md §13) or `--opt Oz`; `--out DIR` (default
    `site/sumika/engines`); `--debug` (`-O0 -g`, assertions) writes to `engines/yaya/build/out-debug/` unless `--out`
    names a folder. Comparison builds go to a scratch `--out`, never into `site/`.
  - It links in `engines/yaya/build/link-<variant>/` and publishes nothing when `yaya.js`/`yaya.wasm` contain the
    builder's home or project path (`-ffile-prefix-map`; `-fdebug-compilation-dir=.` for debug builds). That check
    refuses a `--debug` build: emsdk's cached debug libc++ libraries carry the builder's path (yaya-wasm.md §2,
    kawari-wasm.md §2); the -O2 and -Oz builds are clean.
  - Outputs: `yaya.js`, `yaya.wasm`, `yaya.build-info.json` (commits, emcc version, patch counts, opt) and
    `yaya.LICENSES.txt` (every notice in the code compiled in: YAYA, MT19937, RSA's MD5, CRC-32, parson, TinyXML-2,
    Gumbo and its UTF-8 decoder, DEELX, SQLite, then the Emscripten section as above; `engines/common/notices.py`,
    which stops the build when a notice moved).
    `node engines/yaya/smoke.mjs [DIR]` runs 19 checks on a build (default: the site's).
- **`python engines/kawari/build.py`** (`docs/research/kawari-wasm.md`) is only needed after changing
  `engines/kawari/patches.py`, `em_kawari.cpp` / `em_kawari.h`, `engines/common/gen_cp932.py` or
  `vendor/kawari-8.2.8` (read-only; never edit it). Options `[--opt O2|Oz] [--debug] [--out DIR]
  [--allow-vendor-drift] [-j N]`; about 1 minute.
  - `vendor/kawari-8.2.8` is no git repository: the build pins it by a tree hash (`TREE_PIN`, 177 files) and stops on a
    mismatch unless `--allow-vendor-drift` (`drift: true` in build-info). 42 patches (K1–K12; K12 holds the definition
    hooks for the entries the load makes), each exactly once, on a UTF-8 copy of the EUC-JP sources; 41 units; linked
    with `-Wl,--stack-first`.
  - Same em++ call, `EM_CONFIG` absolute and `EMSDK_PYTHON` set (in all three build scripts: a relative `EM_CONFIG`
    once erased emsdk's library cache; Satori and YAYA build byte-identical with it), builder-path check and scratch
    `--out` rule as YAYA. The check refuses a `--debug` build until emsdk's debug libc++ libraries are rebuilt without
    the builder's path (kawari-wasm.md §2).
  - Outputs: `kawari.js`, `kawari.wasm`, `kawari.build-info.json`, `kawari.LICENSES.txt` (Kawari's `license.txt`, a
    modified BSD, MT19937's notice and the Emscripten section, as Satori's). A rebuild with nothing changed is
    byte-identical.
    `node engines/kawari/smoke.mjs [DIR]` runs 22 checks on a build.
- **`python engines/kawari7/build.py`** (`docs/research/kawari7-wasm.md`) is only needed after changing
  `engines/kawari7/patches.py`, `em_kawari7.cpp` / `em_kawari7.h`, `engines/common/gen_cp932.py` or
  `vendor/kawari-7.5.0` (read-only; never edit it). Same options as Kawari's; under a minute.
  - `vendor/kawari-7.5.0` (`kawari-750-kdt.zip`) is pinned by `TREE_PIN` (143 files). Its string literals are
    Shift_JIS, so the build compiles an escaped copy (every byte 0x80–0xFF as an octal escape, the authors' own
    `sjis2ascii.rb` method) with `-DI18N_HACK` (the shipped DLL's `KAWARI.kdt.i18n`); 33 patches (C1–C9), 32 units.
  - Outputs: `kawari7.js`, `kawari7.wasm`, `kawari7.build-info.json`, `kawari7.LICENSES.txt`. A clean rebuild is
    byte-identical. `node engines/kawari7/smoke.mjs [DIR]` checks a build on the C exports (SHIORI/2.x in code page
    932, CRLF and Ctrl+Z reads, save, readdir, the log, SAORI, the snapshot).
- **The MIDI player's inputs** (`docs/research/midi.md` §1, §4, §5) have no build script of their own:
  `npm run build` bundles and copies them (above). They came as the npm tarballs, unpacked with tar (no package manager
  and no package script ran), each folder with a `SOURCE.txt`, and are read-only: never edit them.
  - `vendor/spessasynth_core-4.3.22` (Apache-2.0, the synth, sequencer, bank and MIDI parsers; it bundles fflate and
    the Dattorro reverb), `vendor/stb-vorbis-0.0.6` (its only dependency: stb_vorbis.c as base64 wasm, for the SF3's
    Vorbis samples), `vendor/generaluser-gs-2.0.3-sf3` (the bank that ships: SpessaSynth's 8,423,728-byte SF3 of
    GeneralUser GS 2.0.3) and `vendor/generaluser-gs-2.0.3` (the bank's documentation and licence; the author's
    32 MB SF2, the reference only, is neither read by the build nor in the repository: the folder's `SOURCE.txt`
    names where it comes from, and `engines/midi/pins.json` `reference` its size and SHA-256).
  - `engines/midi/pins.json` pins each folder by the tree pin of kawari-wasm.md §1 (`tools/treepin.mjs`) and its file
    count, and the bank by SHA-256 and size; `npm run build` stops on a difference. Its `dir`s are also the esbuild
    aliases (`midiOptions`: `spessasynth_core`, `stb-vorbis` → `src/midi/vorbis.js`, which loads the real package as
    `stb-vorbis-impl` outside a worklet only), and `tests/build_output.test.mjs` and `tools/make_notices.mjs` read them
    there.
  - A version bump: a new vendor folder (downloaded into a new empty folder and checked first), its pins (`dir`,
    `version`, `tree`, `files`, `gitHead`, and the bank's `file`, `size`, `sha256`), nothing in `src/midi/`. Then, by
    hand: About's lines (`src/ui/info.js` `DEFAULT_MIDI`; `tests/runtime/info.test.mjs` fails until they name the
    pinned versions); the notices (`tools/make_notices.mjs` again, below; `tests/build_output.test.mjs` checks they
    name the pinned versions); the folder list in docs/building.md "Building" and the licence paragraph in
    docs/licenses.md; a re-check of what is specific to core 4.3.22: the end-seek guard (`END_EPS` in
    `src/core/midi.js`, `END_GUARD_S` in `src/midi/processor.js`, midi.md §5.4) and `songSteps` against core's own parse
    (`src/midi/song.js`; the test compares them on Katari's files and synthetic ones; run it on the download folder's
    files too, midi.md §5.4); then `npm run build`, `npm test`, and the fidelity probe of midi.md §5.3.
  - `engines/midi/midi.LICENSES.txt` holds every notice (Apache-2.0, fflate's MIT, stb_vorbis.c's MIT-or-public-domain
    block, the Dattorro header, GeneralUser GS's licence, then Emscripten's `LICENSE` and musl's `COPYRIGHT` for the
    stb-vorbis wasm, read from `$EMSDK` or `toolchain/emsdk`), made by `tools/make_notices.mjs`:

    ```bash
    node tools/make_notices.mjs <fflate LICENSE> <stb_vorbis.c> [out]   # out: default pins.json notices.file
    ```

    It takes the vendor folders and versions from `pins.json`. Its two inputs are not in `vendor/` and are not kept
    (midi.md §1): fflate's `LICENSE` (`src/externals/fflate/LICENSE` in spessasynth_core's repository) and
    `stb_vorbis.c` (`wasm/stb_vorbis.c` in stb-vorbis'), each read at the `gitHead` `pins.json` names for its package.
- **`engines/common/gen_cp932.py`** writes the code page 932 table the three builds use (`cp932_table.h`) and checks
  it with `--verify engines/common/cp932` against conversions measured on Windows (every build stops on a mismatch).
  Satori uses its `WC_NO_BEST_FIT_CHARS` part, YAYA and Kawari add the 85 best-fit encodings (Kawari because ssp.exe
  encodes requests to a Shift_JIS SHIORI with `WideCharToMultiByte(932, 0)`: kawari-wasm.md §3). A change there
  changes every engine: rebuild them and compare the Satori sweep before and after (below).
- **`python tools/serve.py`** serves `site/` at http://localhost:8642/.
  - Use it, not `python -m http.server`: on Windows that one costs about 2 s per request through the IPv6 fallback.
  - For a browser preview, a local `.claude/launch.json` (not in the repository) names the configuration `site`:
    `python tools/serve.py --port 8642`, port 8642 (it opens `/`; go on to `/dev/`).
  - The test pages are `/dev/` (`site/dev/index.html`: no `data-default-ghost`, so the site's first ghost by Change
    ghost ▸'s order; on a site without ghosts nothing of Sumika shows, and the console warns "this site has no ghosts
    (sumika/index/ghosts.json is empty)") and its link `/dev/page2.html` (a resume). They live in `dev/`, which is never uploaded; the admin tool's Preview has test
    pages of its own. They load `../sumika/sumika.js`, so they work on this server and with the project root served
    (`/site/dev/`). The site has no top page: `/` here is serve.py's folder listing (`404.html`, `balloon/`, `dev/`,
    `ghost/`, `sumika/`); `/sumika/` is the control page (`sumika/index.html`, where visitors turn Sumika on or off).
  - Add `?sumika-debug` to a page URL to log to the console.
  - The other `site/dev/*.html` import `../../src` and `../../tests`; `runtime.html`, `shell.html` and `balloon.html`
    show the ghost `?ghost=ID` names, by default the site's first (`balloon.html` without one: the default balloon).
    Serve the project root for them with `python tools/serve.py --site .`, then open `/site/dev/…`. The exception is
    `site/dev/elsewhere.html`, a page on another origin for the storage hub's checks: it imports nothing, so `site/`
    is served for it on the page ports (8644, 8645), and it loads the built `sumika.js` from `?runtime=` (default
    `http://localhost:8643/sumika/sumika.js`) with `data-hub` unless `?hub=0` (`?hub=URL` names a hub page;
    `?ghost=` sets `data-default-ghost`, absent: the site's first ghost; `?phone=`), links to itself on `?next=`
    (an origin; the link carries the query, with `next` turned back), has a long-talk button, and says when Back or
    Forward brought it from the back/forward cache (`pageshow` persisted; an embedded preview pane's Chromium may
    restore nothing from that cache: `notRestoredReasons` 'masked' [measured]).
  - `--cache no-cache|none|<seconds>` (default `no-cache`: edits show at once) is for checking the update path
    locally: `none` sends no `Cache-Control`, as a plain nginx or Apache does (the browser's heuristic freshness), and
    `600` sends `max-age=600`, as GitHub Pages does. Use a scratch copy of the site for that; the preview's
    configuration keeps the default.
  - Pages on other origins (the storage hub, `data-hub`; docs/guide.md "Pages on other sites"): `--cors` adds
    `Access-Control-Allow-Origin: *` to every response (no OPTIONS handler: the runtime sends plain GETs only), and
    `--hub-allow ORIGIN` (repeatable) answers any `…/sumika/hub.json` with `{"format": 1, "origins": [...]}` and
    `Cache-Control: no-store`, whatever file is there: a test allowlist is never a file, so none is published. Checks
    run on scratch servers on ports 8643–8649 (8642 is the default site server's): the runtime and hub on one port, the
    pages on others (ports on `localhost` are one site), or the nested names `a.test.localhost` /
    `b.test.localhost` / `sumika.test.localhost` (one site); never `a.localhost` / `b.localhost` (two sites).
    `127.0.0.1` against `localhost` is the cross-site case that must fall back.
- **`python tools/add_ghost.py <SSP ghost dir>`** deletes and re-copies `site/ghost/<id>/`, then re-indexes.
  `node admin/cli.mjs add` does the same, byte for byte, and reads a `.nar` / `.zip` straight ("The admin tool").
  - From an archive (as bthver.5, machimaki and mayura were added): extract it into a new empty scratch folder
    (archives are untrusted: never run their files; Python with `-I`), then `python -I tools/add_ghost.py
    <that folder> --id <id> --archive <its .nar> --from-archive` (`--from-archive`: the folder is that archive's
    extraction, so a Kawari ghost's save-header files the archive holds as they are are kept and recorded in
    `sumika/kawari-shipped.json`, as the admin core does from the archive itself). Site ids are the install folder
    (`install.txt` `directory`) lower-cased.
  - `--skip PATH` (repeatable, in both tools) leaves one more file out of the copy: neither compared nor checked nor
    copied; it never brings back a file the rules leave out.
  - A balloon the ghost's `install.txt` names (`balloon.directory`) that SSP moved to its own `balloon/` folder at
    install (emily4's) is copied from there into the site ghost. It refuses to delete a site ghost folder whose bundled
    balloon neither the source nor SSP's `balloon/` folder has.
- **`python tools/index_site.py`**: re-run after ANY change under `site/ghost/` or `site/balloon/`. The manifests record
  file and PNG sizes, and the runtime reads text files from the pack (`ghost.<id>.<hash>.pack.gz`) before the server.
  A YAYA or Kawari ghost's pack holds every file its worker gets with bytes (`YAYA_TEXT` / `KAWARI_TEXT`: readmes,
  `updates2.dau`, Kawari's `.kis` too; `ROOT_PACK_EXT`). Until you re-index, edits and new files don't show up.
  - Index format 2 (`FORMAT`, kept equal to `src/core/loader.js` `INDEX_FORMAT` by a test; safe updates): each
    manifest is `ghost.<id>.<h>.json` / `balloon.<id>.<h>.json` (10 hex of the SHA-1 of its bytes), named in
    `ghosts.json` `manifests`; a manifest's `versions` (parallel to `files`) and `ghosts.json` `versions` (the
    thumbnails and icons it names) give each file's 8-hex SHA-1, which the runtime fetches as `?v=`. `ghosts.json` is
    written last. The same site gives the same names and bytes, and an unchanged file is not written again.
  - A pack is `<kind>.<id>.<h>.pack.gz` with `h` the SHA-1 of its content before gzip (gzip bytes differ by zlib, and
    the admin core deflates with Node's), and a pack file that already holds that content is kept as it is, whichever
    tool wrote it ("The admin tool", "Pack names"). Packs an older indexer named by their gzip bytes keep those names
    until the next index renames them once.
  - `node admin/cli.mjs index [SITE]` writes the same files ("The admin tool").
  - It deletes nothing in `sumika/index/`: older manifests and packs stay for a page still running them, and
    `tools/prune.mjs` removes them.
- **`node tools/prune.mjs [--site DIR] [--first | --retire-all]`** is the only tool that deletes a versioned file, and
  it runs only right before an upload (the publishing flow under "What gets published"), never against `site/`
  otherwise: checks of the update path use scratch copies. Versioned: the hashed files in `sumika/engines/`
  (`<name>.<10 hex>.js`, `.wasm`, `.js.map`, `.sf3.gz`) and every `.json` but `ghosts.json` and every `.pack.gz` in
  `sumika/index/`; current: what `build.json` and `ghosts.json` name, with the worker's, the MIDI bundle's, the hub
  script's and the control script's maps and each manifest's pack (`midi.LICENSES.txt` is no versioned file, nor are
  `sumika/hub.html`, `sumika/index.html` and the publisher's `sumika/hub.json`, which prune never touches; a
  `build.json` without `midi`, `hub` or `control` is fine).
  - The ledger `<DIR>.published.json` sits beside the site folder (for `site/`: `site.published.json` in the project
    root), so it is never uploaded: `{format: 1, published: [the versioned paths current at the last run], retired:
    {path: 'YYYY-MM-DD'}}`. It is written whole (a temporary file beside it renamed over it, as the admin's
    `writeAtomic`), so a run cut off mid-write (the admin's Prepare upload in a closed window) leaves the last ledger,
    never a torn one the next run would refuse as "not a format 1 ledger".
  - Rules: it stops, deleting and writing nothing, unless every current file exists and `sumika/sumika.js` is the
    bundle `build.json` describes (its build id once, every path of the table, the MIDI two included: `build.mjs`
    writes `sumika.js` first, so a build that died before `build.json` would otherwise lose the new bundle's files),
    and, when `build.json` names a `hub` (a `control`), `sumika/hub.html` (`sumika/index.html`) names exactly that
    script (`pageScript`, alias `hubScript`; the table check never asks `sumika.js` for either); a non-current file
    the last upload carried (`published`) is retired today and kept, a retired one is deleted by the first run 14 or
    more days later (`RETAIN_DAYS`), and one no upload ever carried (a `--watch` intermediate, a build or re-index
    superseded before an upload) is deleted at once; then `published` becomes the current set. So the 14 days count
    from the upload that no longer needed a file. A second run before the same upload changes nothing. No file's mtime
    is touched. A run not followed by an upload makes the next run treat that set as uploaded, which only keeps files
    longer.
  - No ledger: it refuses, unless `--first` (nothing was ever uploaded: every non-current versioned file goes; the
    first upload under this scheme, which also removes the old fixed-name `ghost.<id>.json` / `balloon.<id>.json` of
    index format 1) or `--retire-all` (a lost ledger: every non-current versioned file is retired today, which only
    keeps files longer). With a ledger, both flags are refused.
- **WebAssembly Satori vs the real DLL** (not part of `npm test`; it needs the corpus `tests/corpus/`, development
  material, not in the repository, which its own README describes):

  ```bash
  FAKE_NOW=2026-10-06T01:59:00 node --import ./tests/fake_time.mjs tests/satori_vs_dll.mjs [master|bath|date|meal]
  ```

  - `FAKE_NOW` is the clock the corpus was recorded at. It prints four counts: same status / identical value /
    identical except waits / different. Noise bands [measured] (several runs of an unchanged build per mode):
    - same status: bath 699/700, date 1,685/1,686 and meal 861/863 (860 once in 8 runs); master 5,294–5,317 of
      5,368. Master's misses are the corpus' 8 `TIMEOUT` blocks (never matchable) and OnChoiceSelect 200↔204 after
      earlier random choices;
    - identical value (random talk choices): bath 589–607, date 1,239–1,266, meal 704–721, master 3,297–3,373. Satori
      seeds MT19937 from the clock, so each run draws other talks and this count is a random count; identical except
      waits moves by about ±2 (master 187–196).
  - The corpus DLL is Satori Mc159-6 and Sumika's is Mc203-6, so values differ. Treat it as a regression net, not an
    oracle. It cannot see the CP932 table (Tsubasa has no IBM/NEC duplicate or invalid pair, and the requests are
    UTF-8); `tests/engine_adapter.test.mjs` checks that directly.
  - bath, date and meal take about 20 s each. master takes 5–7 minutes, so run it in the background or with a
    600000 ms timeout.
- **Ghost sweep** (not part of `npm test`; `docs/research/ghost-sweep.md`): every Satori, YAYA, Kawari and Kawari 7
  ghost of a folder, headless on the real runtime parts, ranked list of what the runtime cannot do yet.

  ```bash
  node tools/sweep.mjs "<archive folder>" --engine satori --out <scratch dir>
  node tools/sweep.mjs "<archive folder>" site/ghost/emily4 --engine yaya --out <scratch dir>
  node tools/sweep.mjs "<archive folder>" --engine kawari --out <scratch dir>
  node tools/sweep.mjs "<archive folder>" --engine kawari7 --out <scratch dir>
  ```

  - `--engine satori`, `yaya`, `kawari`, `kawari7`, a comma list or `all` (default: all four). On the archive folder of
    ghost-sweep.md's reports (a collection of ghost archives: development material, not in the repository; the sweep
    reads SSP's word list from `site/sumika/word_compatible.txt` when it is there, and leaves such words as written
    without it): Satori about 5 minutes for its 247 archives (233 by the descript's `shiori` line + 14
    that have none but ship `satori.dll`; run it in the background); YAYA about 1 minute for 26 ghosts (the 25 archives
    plus emily4 from the site copy, never from an SSP install: `profile/`, her save); Kawari about 1.5 minutes for its
    18 archives; Kawari 7 under a minute for its 8 (kawari7-wasm.md §7: all 8 load, every resume check passes).
    `--only REGEX` picks ghosts; `SWEEP_TRACE=1 node tools/sweep/ghost.mjs <archive>` traces one. Site ghost folders
    work as sources too (`site/ghost/bthver.5`).
  - `--clock` (`tools/sweep/clock.mjs`, ghost-sweep.md "The clock"): `fixed`, the default, runs every ghost at
    2026-10-07 20:00:00 local time, the page side and the engine alike from the engine's boot on (`fixProcessClock`:
    the process's `Date` and `performance.now` follow the sweep's fake clock), so the time of day never reaches a
    report and the engines' clock seeds (Satori's and YAYA's MT19937, Kawari's) repeat; `--clock YYYY-MM-DDTHH:MM[:SS]`
    starts elsewhere (`2026-10-07T19:55` crosses an hour: time signals); `--clock real` runs Satori on the real clock,
    and YAYA and Kawari from the real time on (`followClock`). The sweep only: ghosts on the site keep the real date
    and time. Wall times stay real (a root engine's module and load ms are taken again on the real clock:
    `realTimings`); each report has `clock`, the summary a "Clock:" line.
  - A YAYA ghost also gets the resume check (yaya-wasm.md, resume): a fresh engine resumed from the stored files must
    save the same variables, and must load as after an update when a dictionary changed. Expected: 24 of 26 load
    (raychel_kisekae and ure_c fail on Tc606: "Load status", not a runner failure); the counts to compare against are
    in yaya-wasm.md §14.
  - A Kawari ghost gets its own resume check (kawari-wasm.md §15): every entry after the run against every entry of a
    fresh engine resumed from the store; each entry that differs is "back different" (must be 0), "missed" (the
    session changed it, the snapshot left it out: 3–4, the write-protect gap of kawari-wasm.md §8) or "load-set" (0,
    since the snapshot carries what load made; a definition read from a save the session rewrote can still show,
    firefox in one run); then the stamp reload and D6 (a cold boot from the same store, a day later with the session's
    end as `sessionEndMs`, closes and finishes the session, so its files match B's own close only when that close ran
    at the session's end) with its outcome: `ok`, `nothing to finish`, `failed`, or `no effect` (the session's own close
    and unload write no file: a ghost that saves nothing when it closes, somberlain and maria_re; sakura_r030103b too,
    whose save comes out as its shipped file in the sweep's frozen clock: ghost-sweep.md "Kawari run K4"). A request's
    time includes the worker's scan after it. A runaway recursion is a 500 and the engine goes on (kuro_r030114b's
    `Comm`); a ghost whose own script closes it gets a new engine. The pure parts are in `tools/sweep/kawari.mjs`
    (`tests/runtime/sweep_kawari.test.mjs`); runs K1's, K3's, K4's and K5's counts are in ghost-sweep.md "Kawari run
    K1", "K3", "K4" and "K5". A Kawari 7 ghost gets the same check through `_kawari7_dump` (`parseK7Dump`); its
    TRANSLATE answers 400 when the ghost has no `system.OnTranslate` (all 8), listed under SHIORI errors, and the
    script plays unchanged, as in ssp.exe.
  - Write `--out` to a scratch folder outside the project: the reports quote ghost scripts.
  - The summary also counts the property names the ghosts read or set (`ok` / `fails`) and the Preferences box pages
    they ask for; the sweep's visitor never saves the box (ghost-sweep.md "SSP properties").
  - It never goes on the network: `\![execute,http-*]` gets a stub fetch that records each request and fails it as
    an unreachable host ("HTTP requests the ghosts made, never sent" in `summary.md`), and the process's `fetch`
    refuses http(s) URLs. Never give it a real fetch: the requests would reach the ghost authors' sites.
  - Re-run it after runtime changes that ghosts could feel (parsers, stand-ins, script tags) and compare the counts.
    Run-to-run noise (two identical Satori runs S0 / S0b, then S1 against S2b): ran / ok / crashed / fatal and the
    SAORI tally stay exactly equal; unknown tags, request errors and warnings move by up to about 3 keys between
    identical runs (timing-dependent talk paths, "scope N has no surface", a ghost slower inside the full sweep:
    draftyroom). Judge a key that moved by running that ghost alone (`--only`) before and after. For an engine-wide
    change (a shared table, the sweep's engine choice) sweep before and after, one change per comparison. Kawari's
    noise (four K1 runs) is wider: ran / ok / crashed / fatal, parse errors, files written and request errors stay
    equal, but the SAORI tally moved once (a talk path reached two more DLLs), warnings by up to 5 keys, the
    snapshot's entry count by a few, and two statuses follow a random pick (bloody_moon's double-click,
    honue090104's `Wearmode`). So "the SAORI tally stays exactly equal" holds for Satori, not always for Kawari.
    Those bands were measured with the engines on the real clock (`--clock real`). Under the fixed clock (16 ghosts:
    ghost-sweep.md "A fixed clock") two runs gave 15 of 16 reports identical, wall times left out (also with the
    machine's clock moved to another day and hour); what is left comes from the page side's own random picks
    (surface aliases: bukimi, bthver.5) and the wall times (`wallMs`, slowest, load ms, saves, `date`).
  - `tools/sweep/views.mjs` copies the indexer's shell list, its engine rule (`detectEngine` = `index_site.py`
    `detect_engine`, the Kawari rule included; `sweepEngine` adds the sweep-only Satori-by-DLL rule and the
    `lang_switch` / `gcore` overrides, and returns `kawari` early), its tray icon rule (`icon` / `iconMinimize`:
    `src/core/trayicon.js` `ghostIcons` = `index_site.py` `ghost_icons`) and the runtime's shell / balloon swap (so a
    ghost's own `\![change,shell|balloon]` switches there too); keep it in step when `index_site.py` or
    `Runtime._requestView` change (`tests/runtime/sweep_views.test.mjs` checks the entry, `engine`, `module` and the
    icons included, against `ghosts.json`).
- **WebAssembly YAYA vs emily4's real DLL** (not part of `npm test`; it needs `site/ghost/emily4` and the corpus
  `tests/corpus/emily4/`, development material, not in the repository, which the corpus' README describes):

  ```bash
  node tests/yaya_vs_dll.mjs site/ghost/emily4 tests/corpus/emily4/yaya_dll.res.txt --show 5
  ```

  - Expect the same status on 631 of 631 requests, 621–622 identical values, 6–7 identical except the menu padding,
    2–4 different (`version`: her DLL is Tc571-15; random choices). A regression net, not an oracle.

## Gotchas

- Don't write files through Bash heredocs that contain Python string escapes (`\r\n`, `\x89`, `\v`, …). They have
  corrupted files in this project. Use an editor tool, or put the script in a file first.
- Editing tools that unescape their text (an agent's Write/Edit tools) turn a backslash-u escape (a backslash, `u` and
  four hex digits) into that character: a U+2028 escape in a regular expression literal became a raw line separator
  and broke the module. For such characters in code use `String.fromCharCode(…)`, a `\xNN` escape below 0x100, or a
  RegExp built from a string; grep new files for non-ASCII afterwards.
- Node's `TextDecoder('shift_jis')` is ICU's ibm-943, not WHATWG's: 0x1A, 0x1C and 0x7F come out rotated and 0x80 is
  an error ([measured] on all 65,792 1- and 2-byte sequences); Deno's and Bun's are WHATWG's, and none is Python's
  cp932. The runtime's `decodeText` in tests and the sweep goes through it; the admin core has Python's own
  (`admin/core/text.mjs`).
- The Python tools fail on Windows paths over 260 characters (no long-path support: WinError 206, or 145 inside
  `shutil.rmtree`); Node does not. Keep scratch work folders short (the parity run's `--work`).
- Ghost text files are CP932 unless they declare `charset,UTF-8`. Decode them with `decodeText` (`src/core/loader.js`).
  Requests go to the engine as `Charset: UTF-8`.
- `package.json` is `"type": "module"`, so tests load the Emscripten `satori.js`, `yaya.js`, `kawari.js` and
  `kawari7.js` through `tests/load_engine.mjs` (vm), not with import or require.
- A visitor's stored set of ghosts beats `data-default-ghost` (`chooseSet` in `src/core/ghostset.js` over the runtime
  prefs' `ghosts`; with none stored, `chooseGhost` in `src/core/site.js`, re-exported by `runtime.js`). Without
  `data-default-ghost` a first visit starts the first ghost by descript name that can run (Change ghost ▸'s order),
  not the first folder.
- Some tests can flake on a busy machine: the wall-clock assertions (balloon corpus, sakura tokenizer, shell compositor)
  and the shell geometry race test. Re-run them before chasing a failure. `tests/midi_engine.test.mjs` renders audio
  offline for about 35 s of the run, which loads the machine meanwhile; a test that races a timer of a few ms against
  `settle()` can fail that way (music.test.mjs's dropped-file timeout is 250 ms, not 20, for that reason).
- Only Satori, YAYA, Kawari (Phase 8) and Kawari 7 (Phase 7) ghosts boot.
  - The engine name is the lower-cased base name of the DLL in descript's `shiori` line (`index_site.py`
    `detect_engine`). A missing line counts as `shiori.dll`. The MEMORY_ ghost has none, so it would become engine
    `shiori`.
  - The AYA family is decided by its config, because the site never has the DLL: when `ghost/master/<stem>.txt` lists a
    dictionary that defines `request`, the engine is `yaya` and the entry gets `module` = the stem (YAYA reads
    `<module>.txt` and saves `<module>_variable.cfg`: `aya5.dll` ghosts are `module: aya5`); only `OnRequest` → `aya`
    (AYA4, not supported); `yaya.dll` / `aya5.dll` whose dictionaries define neither (`request` only in an encrypted
    `.ayc`) → `yaya`. `satori`, `lang_switch` and `gcore` keep their name whatever their `.txt` holds.
  - Kawari is decided by its files, after the AYA probe and only for the stems `shiori`, `kawari`, `kawari8`,
    `kawarirc` (`kawari_phase` / `kawariPhase`, kawari-wasm.md §12): `ghost/master/kawarirc.kis` (any case) → `kawari`;
    else `ghost/master/kawari.ini` or a `kawari*` stem → `kawari7` (Phase 7, SHIORI/2.x: the Kawari 7.5.0 build,
    kawari7-wasm.md); else the stem stays. No `module`. snow girl (`satori.dll`, Kawari only as a SAORI) stays
    `satori`.
  - The root engines (`ROOT_ENGINES` in `src/core/engine-files.js`: `yaya`, `kawari`, `kawari7`) get the whole ghost
    root (`rootFilePlan`) and `engineOpts` `{ghostId, placeholders, site}`; only YAYA adds `module`. Satori gets
    `ghost/master`'s text. Kawari 7's text set (`KAWARI7_TEXT` = index_site.py `KAWARI7_PACK_EXT`) adds `.kdf` and
    `.dat`, which Phase 7 ghosts name as dictionaries.
  - The page knows which engines exist from `SUPPORTED_ENGINES` (`src/worker/engines/supported.js`; a test keeps it
    equal to `ENGINES`). `chooseGhost` passes over other ghosts while a runnable one exists, the menu greys them out
    ("needs AYA", "needs Misaka"), and a switch to one is refused before the running ghost is touched.
  - Kawari 7 speaks SHIORI/2.x only. The page still speaks SHIORI/3.0; `ShioriClient.request` passes the call's `kind`
    (`resource`, `translate`, `teach`, `word`, `communicate-user`, `communicate` with `self`) to the worker, and
    `src/worker/engines/shiori2.js` turns each request into what ssp.exe 2.9.10 sends a 2.x SHIORI after its
    `GET Version SHIORI/2.6` handshake (skipping what it never sends: basewareversion, capability, OnTranslate below
    2.6) and maps the reply back, its `SHIORI/2.6` status line kept: a 2.x reply's COMMUNICATE target is `To` only
    (`communicateOf`). kawari7-wasm.md §6.
  - If one still starts (the only ghost of a site), it logs `no engine for SHIORI "<x>" yet`. On a cold boot
    the characters stay veiled (unseen) until it is torn down; on a resume they may flash for a moment.
- A YAYA or Kawari ghost lives at `/ssp/ghost/<id>/` in its MEMFS (`coreinfo.path` / `System.DataPath` read
  `/ssp/ghost/<id>/ghost/master/`), with the site's other ghosts beside it, as in an SSP install (yaya-wasm.md, MEMFS;
  `SspRootShiori` in `src/worker/engines/ssproot.js`). Its own error and warning lines reach the console only with
  `?sumika-debug`; why a boot failed is logged at warn.
- Kawari is Shift_JIS inside: its dictionaries, saves and file names are code page 932 bytes, and the build converts at
  the SHIORI, SAORI and file-name edges (patches K4–K6) as ssp.exe encodes (best fit, kawari-wasm.md §3), so the page
  and the worker stay UTF-8. The other ghosts' `descript.txt` in its MEMFS are 932 too. A Kawari ghost's site id must
  be writable in code page 932: `KawariEngine.init` fails the boot with a warn line otherwise (`café`; kawari-wasm.md
  §9); the tools do not check it.
- Kawari's state is its dictionary, and many ghosts save only at unload, so a page change restores a snapshot of the
  entries the session changed and of those its load made (a KIS zone's clock or random value, such as KEEPS'
  `cntwork`; `?kawari/resume.kis` in the ghost's stored files), and a cold boot after a tab closed without Close first
  closes the old session as ssp.exe closes one Windows ends (OnCloseAll / OnClose with R0 `system`, OnTranslate,
  replies dropped; `closeFromOutside`), then runs its OnUnload (D6), so a ghost that saves in OnClose (bthver.5, the
  BTH family, KEEPS) keeps that session too. Both run at the time the old session ended (the ghost state's `savedAt`,
  read by `Runtime._boot` before its own write, passed as `sessionEndMs`; the worker's `Date.now` moved for that window
  only, `runAt`), as ssp.exe runs them inside `WM_ENDSESSION`; the cold load and every request after it see the real
  time. kawari-wasm.md §8, shiori-events.md §2.3.1.
- The root engines (YAYA, Kawari) scan their ghost root for changed files only after a request that wrote one
  (`watchWrites` marks `dirty` at the FS calls that write; ssproot.js). Code that changes MEMFS some other way must set
  `engine.dirty = true` itself.
- `vendor/satoriya-shiori/CLAUDE.md` and `vendor/yaya-shiori/CLAUDE.md` belong to upstream (their maintainers' notes),
  not to this project. `vendor/kawari-8.2.8` is read-only too (a SourceForge download, pinned by a tree hash).
- `docs/research/scratch/` (research leftovers: logs, scripts, dumps of SSP's resources and copies of third-party
  documents, 133 MB) is development material, not in the repository. The research docs still cite its files as the
  sources of what they state; they are not normative, and no build or test reads from it.

## Which docs to trust

When docs disagree, the earlier item in this list wins:

1. **Observations of ssp.exe.** In the specs they appear as `[observed]` (or `[observed: …]`), or in prose ("settled
   by comparison with ssp.exe"). Most are in `balloon-format.md` and `ssp-ui.md` §6.1. The leading-`\n` rule
   (BA §3.3) follows ssp.exe's code; it has not been observed directly.
2. **`docs/CONTRACTS.md` v2:** the module seams (names, shapes, and behaviour other modules rely on). Update it when you
   change a seam.
3. **`docs/research/balloon-format.md` and `ssp-ui.md` §6** for balloon behaviour: word wrap, leading `\n`, pen-only
   hover for ROP blend methods, dragging, the communicate box. These are newer than SUMMARY.
4. **`docs/research/SUMMARY.md` §0–§2:** the normative decisions where the specs contradicted each other or left gaps.
   Its risk list and §3 checklist predate most of the code, so check their status claims against the code.
5. **The other research specs** (`sakurascript`, `shiori-events`, `shell-format`, `satori-wasm`, `yaya-wasm`,
   `kawari-wasm`, `tsubasa-needs`, and `ssp-ui` outside §6) are implementation specs. The exceptions are lines tagged
   `[guess]`, `[infer]`, `[?]`, `UNVERIFIED` or `ASSUMPTION`.
6. **`docs/ARCHITECTURE.md`** is the original design. Where it disagrees with CONTRACTS.md or the code, they win.

Code comments cite doc sections (`BA §3.5`, `SUM C16`, …), so don't renumber them. The abbreviations are defined at the
top of `CONTRACTS.md`.

## Code

Plain ES modules, no runtime dependencies; esbuild is the only devDependency. UI lives in a Shadow DOM root
(`src/ui/root.js`). Tests use `node:test`. Match the surrounding style: terse comments that cite doc sections.

What exists once per page or spans ghosts (site index, UI language, tab id, idle clock, the `sumika/runtime` channel,
page hooks, tab marker and the stored set, the lead lock, the ghosts' layers and keyboard owner, the launcher dock, the
queue of calls and ghost changes, the events between ghosts, the visitor's user information and the Preferences box,
the ghost lists of the property system (`propsFor`), the page API) is on the `Site` (`src/core/site.js`); each
ghost is a `Runtime` (`src/core/runtime.js`) in its `slots`, which keeps everything it does by itself. Pure set helpers
(the stored set, call targets, the cross-ghost References, the marker v2) are in `src/core/ghostset.js`. The one class
has two configurations: `main.js` builds a lead Site (`multi`: lead lock, layers, peers); a `Runtime` made without a
`site` gets an implicit one-ghost Site with the single-ghost behaviour, which is how many runtime tests build it
(`tests/runtime/site.test.mjs` tests the split, `tests/runtime/multi.test.mjs` several ghosts on the lead path).

**UI text is bilingual** (`ssp-ui.md` §2.10). Every string a visitor sees from the runtime itself (menu captions,
notes, tooltips, aria-labels, placeholders, the launcher, the boxes) is a key in `STRINGS` in `src/core/i18n.js`,
with an `en` and a `ja` text, looked up with `t(key, lang)`. New UI text needs both; `tests/runtime/i18n.test.mjs`
fails on a missing key or English left in a Japanese string. Use SSP's own string where SSP has the item (its
resources, SSP-RES and SSP-RES-JA in `ssp-ui.md`: an SSP install's, dumped into `docs/research/scratch/menu_ja.txt` /
`menu_en.txt`, `sspui/dialogs_ja.txt`: development material, not in the repository); word new ones in SSP's style.
Some of SSP's captions are set at run time, not in the resources: "Use System Lang." is hard-coded in ssp.exe for every
language, so check the code before trusting a resource item. Text the ghost provides (SHIORI captions, site lists,
names, box titles) is never translated; neither is balloon artwork (the input boxes' drawn "Communicate" / "Input"
captions stay English, like SSP's default balloon). Components take a `language` (`UiLanguage`,
`src/core/language.js`) and show English without one, so tests don't depend on the machine's locale. Log messages
stay English.

**Phones** (`ssp-ui.md` §9.11 holds every [decision] and [verify]): one predicate, `phoneInfo` in `src/core/phone.js`
(`(pointer: coarse)` and the screen's short side under 600 CSS px; `{short, long, mobileView}` or null), read once per
page by main.js before the Site exists, and passed down as a `phone` option (Site, Stage, Balloons, Dialogs,
UserScaling, SettingsWindow, Launcher). A component made without it is exactly its desktop self (no listener, inline
style or element added): desktop is SSP's, and each phone test file also pins that (at 1280×720 and 1920×1080).
- Without the phone path, at 375 px Tsubasa stood half off the left edge with her balloon over most of the page
  [measured]. On a phone by default: (a) a smaller default Shell scaling that fits (`phoneFit`, per shell); (b) a
  balloon with no room beside her goes above her head, inside the screen, its text not below 11 px (`overhead`,
  `balloonFit`); (c) the text boxes and the Preferences box stay above the on-screen keyboard, their fields 16 px. A
  visitor's own scaling picks win.
- The script tag's `data-phone="tucked"` starts the ghost as her corner icon (a tap brings her out), and
  `data-phone="off"` turns Sumika off on phones; `window.sumika.phone` tells pages which applies.
  `data-default-state="tucked"` takes the same tucked path on every device (Code "On or off").
- The touch fixes F1–F6 are outside the `phone` option: they key on touch input (a touchscreen laptop's touch gets
  them too) or are CSS a desktop reads the same (`ssp-ui.md` §9.11 "Touch fixes").
- A first visit costs about 2.2 MB for Tsubasa on a host that gzips, 3.7 MB uncompressed (§9.11 "Measured").
- `?sumika-phone` / `?sumika-phone=0` force the phone path on or off (forced on, the window's sides stand for the
  screen); use a scratch site on its own port, since a forced tab stores picks and places like any other.

**Browsers** (CONTRACTS main.js, support.js, canvas.js, Stage, Balloons, Runtime and Site; `ssp-ui.md` §9.11): the
baseline is Chrome / Edge / Android WebView 95 (Opera 81, Samsung Internet 17), Firefox 100, Safari / iOS 15.2, set by
the engines' legacy WebAssembly exception handling (emsdk's default; a browser that ever drops it is refused cleanly by
the check, and the fix is an engine rebuild with the new format: Chrome 137, Firefox 131, Safari 18.4). Safari 15.4
has everything but the faster text-pack and offscreen paths, 16.4 all of it. A browser too old leaves the page as it
was, with no ghost and no error the visitor sees.
- `src/core/support.js` `missingFeatures(window)` checks the required set once, in main.js right after the phone
  decision and before anything is made (not with `data-phone="off"` on a phone): WebAssembly, a 116-byte probe module
  validated and compiled (`PROBE`: every instruction family beyond the MVP that `wasm-dis` finds in the four engines:
  legacy try / catch / catch_all / delegate / rethrow / throw, bulk memory, DataCount, sign extension, trunc_sat;
  re-check after an engine build changes emsdk or flags), `BigInt64Array`, `createImageBitmap`. The rule for the set:
  the no-fallback features a ghost needs to start or draw that some engine shipped after it could parse `sumika.js`
  (ES2020: Chrome 80, Firefox 74, Safari 13.1; `target: ['es2020']` stays); a new feature with no fallback joins it,
  one with a fallback does not. A browser that lacks one gets `unsupportedApi` (offApi's members, `supported: false`,
  `missing`), one warn, and nothing else; `tests/runtime/support.test.mjs` runs the bundle in a vm with tripwires to
  keep it so.
- A canvas a ghost draws on that cannot draw (WebKit's canvas memory cap: getContext null, or no backing store at a
  resize; `src/core/canvas.js`) ends that ghost as a failed start ends: CharacterView and BalloonView take their
  contexts before anything joins the page and read one pixel back once per canvas, at its first sizing (`backingLost`;
  never twice: Chromium warns at a canvas's second read [measured] and moves it to software rendering [infer]; so a
  refusal at a later resize is not detected, a known limit: ssp-ui.md §9.11 S5), decoders throw `canvasLostError` and
  give their temporary canvases back (0×0), and Stage / Balloons / BalloonSkin.load report through `onCanvasLost` to
  `Runtime._canvasLost` (during the boot its `lostCheck` fails the start; later she is veiled, hidden and stopped at
  once, saved as for a takeover, so a change under way ends early and nothing shows her again, then unloaded and
  dropped by `Site._dropFailed`; a frozen tab's lost stage goes, its takeover listeners stay). Nothing of it fires
  where every canvas is granted.
- `findLastIndex` (Safari 15.4) is not used (the End key works without it). A blocked sound is retried on the HTML
  spec's activation events (a touch's lift, not its press: TS §3.4).
- The CSP line in docs/guide.md "Browsers" (`'wasm-unsafe-eval'`, `worker-src 'self' blob:`) runs Sumika; a CSP without
  `'wasm-unsafe-eval'` leaves the page untouched, as a missing feature does; a `default-src 'self'` CSP blocks
  Sumika's `<style>` elements and blob: media (the ghost boots misplaced and unstyled).
- MIDI (an AudioWorklet in a secure context) is outside the required set: it has a fallback (`midiSupported` false →
  MIDI files go to an `<audio>` element and stay silent), so a browser without it still runs every ghost.

**On or off** (docs/guide.md "Turning Sumika on or off"; CONTRACTS main.js, core/choice.js, src/control/): the script
tag's `data-default-state` (`enabled`: absent, empty or unknown, which warns once; `tucked`: the phone's tucked path,
Site `tucked`, on every device with the desktop's layout there; `off`) is what a visitor who made no choice gets, and
the visitor's own choice lives in the record `sumika:choice` (`{choice: 'on' | 'off', v}`, schema kind `choice`; none =
"Site default"), written only by the control page `sumika/index.html` (`src/control/`, served as
`https://<host>/sumika/`). The control page offers On, Off and Site default only, and nothing of Sumika links to it
[decision]: publishers link it from their pages. `src/core/choice.js` is the one module both use (key, values,
`readChoice`, `saveChoice`, `defaultState`, `startState`).
- main.js decides in the order data-phone="off" on a phone → a browser that cannot run Sumika → the visitor's choice →
  data-default-state; On runs as `enabled` whatever the default (a phone's data-phone="tucked" stays). The Site's
  `tucked` does not need `phone`: main.js decides it.
- Off (the visitor's, or the site's with no choice) is `offApi(VERSION, {phone, reason})`: nothing of the Site made,
  nothing fetched, stored, shown or listened to (only the choice read, from the runtime's own storage without the
  state.js probe).
- Without `data-hub` the choice is this origin's, read at once; with it the choice is the hub's (the Sumika host's
  origin, which is where the control page writes): the live api is made with `state` null, and the first page API call
  that can start anything (autostart's start too) waits for `Site.storageReady()` (the hub planted, the index loading
  meanwhile unless the default is `off`), reads the choice through the mirror, and on Off calls `HubClient.close()`
  (the frame removed, no onGone listener told) and replaces window.sumika with the stub (the earlier object answers as
  it: state 'off', site null, calls false); with a hub that is not usable the page falls back to its own origin, and
  the page origin's choice decides. In Safari the hub's storage is expected to be per page address, so a choice made
  at the Sumika host may not reach other origins (docs/guide.md "Turning Sumika on or off").
- A choice applies to pages opened or reloaded after it; a running page never re-reads it. `window.sumika.state`
  ('enabled' | 'tucked' | 'off'; null while the hub decides) and, in the stubs, `reason` ('phone' | 'unsupported' |
  'visitor' | 'site').
- The control page loads only its script (choice.js and schema.js; no loader, Site, worker or engine:
  `tests/runtime/control_page.test.mjs` checks its bundle's inputs), its text is its own table (en / ja, checked by
  `tests/strings_check.mjs`), its language the browser's (i18n.js `systemLanguage`'s rule, kept equal by a test). It
  saves On, Off or Site default at a click, with a status line (Site default removes the record), and shows the stored
  choice checked on load.
- Tucked (`data-default-state="tucked"` on a desktop) shows "Show X" in the corner and fetches only `sumika.js`,
  `ghosts.json` and the ghost's icon until that is clicked; Off fetches only `sumika.js`.
- Tests: `choice.test.mjs` (the precedence table), `default_state.test.mjs` (the bundle in a vm: every pair, off
  touching nothing, phones, unsupported, the hub's choice, a hub not usable), `control_page.test.mjs`.

**MIDI** (`docs/research/midi.md` §5–§6, every [decision], [measured] and [verify] there; CONTRACTS core/midi.js,
PageSaori, drops.js, Site and "MIDI protocol"): SSP plays MIDI through Windows' own synth, whose sound bank cannot be
shipped, so Sumika brings spessasynth_core 4.3.22 (Apache-2.0), driven by an AudioWorklet Sumika owns, and the
GeneralUser GS 2.0.3 SF3 (8.4 MB, shipped gzipped: 4.8 MB), decoded and trimmed per song in a Worker. Every way a
ghost plays sound (`\_v`, `\8`, `\![sound]`, dsaudio, mciaudior, mciaudio, drops) plays MIDI, with SSP's events.
- One bundle, `src/midi/` → `sumika/engines/midi.<h>.js`, is loaded twice by the page, as a classic Worker (`bank.js`:
  the bank downloaded once, inflated, trimmed per song to an SF2) and as an AudioWorklet module (`processor.js`: one
  `SongPlayer`, a spessasynth_core synth and sequencer, per playing file); it picks its role by its global scope.
- The page side is `src/core/midi.js`: `Site.midi` (lazy; null unbundled or where `midiSupported()` is false) is the
  page's one `MidiEngine` (one AudioContext, Worker and module for every ghost), and `MidiPlayer` stands in for an
  `<audio>` element in `page-saori.js`, whose one factory `_media(path, url, blob)` picks it by the name the ghost gave
  (`isMidiPath`). Nothing MIDI is fetched before a ghost first plays a MIDI file; then the bundle (140 KB gzip) and the
  bank, once, under hashed names.
- ssp.exe's rules hold: from tick 0, the end at the file's last event, a loop of the whole file.
- The worklet's audio thread renders every song of the page, so a song's load runs in slices from `render` while
  another song sounds (`LOAD_SLICE_MS`; the MIDI file's events read by `songSteps`, core's preload a voice per step;
  midi.md §5.4), and in one go when none does: a load in one go blocked the audio thread (68–120 ms of another song
  lost in Chromium [measured]; 0 underruns in slices).
- iPhones [decision]: `navigator.audioSession.type = 'playback'` while MIDI plays where it exists (Safari 16.4+), so
  MIDI ignores the silent switch as the `<audio>` sounds do; no workaround for Safari 15.2–16.3 (MIDI follows the
  switch there).
- The page side imports nothing from `build.js` and has no module-level side effects (the worker bundle imports
  `drops.js`, which imports `midi.js`; it holds no MIDI code, keep it so).

**The storage hub** (`data-hub`; CONTRACTS core/platform.js, core/hub.js, core/portstore.js and "Hub protocol";
docs/guide.md "Pages on other sites"): pages on other origins of one site (`a.example.com`, `b.example.com`) that load
`sumika.js` from the runtime host share one visitor. With `data-hub` on the script tag (read only on main.js's
supported, not-off path) main.js installs a `HubClient` (`src/core/hub.js`) in `src/core/platform.js` before the Site
exists; the Site's first `start()` plants a hidden iframe of the runtime host's `sumika/hub.html?sumika-hub=<protocol>`
and waits for its answer; every visitor record then lives at the hub's origin, over one private MessagePort: a
synchronous mirror of the `sumika:` localStorage keys and the `sumika.` sessionStorage keys, IndexedDB through store
ports (`src/core/portstore.js` PortStore, for the page's drops and in the engine worker, whose `init` gets a
`storePort`), Web Locks and BroadcastChannels (real ones inside the hub). Nothing changes without the attribute; the hub
answers only origins allowlisted on its own host.
- `platform.js` is the one seam: each default (storage, session, channel class, lock manager, `Store`, estimate, the
  `storage` event source) is resolved when it is used, never captured at import or construction, and with no hub it
  is exactly the browser's own global (tests swap `globalThis.localStorage` and friends). A hub that is not
  usable (no answer, a refusal) makes the page fall back to its own origin's storage for the rest of the page, logged
  once.
- The hub side is `src/hub/`, its own bundle (`hub.<h>.js`), which runs as the frame and again as the frame's dedicated
  store worker, picked by its global scope: `allowlist.js` (the publisher's `sumika/hub.json`: exact origins, pure),
  `probe.js` (the same-site rule: a `SameSite=Lax` cookie with a nonce in its name and the hub page's own Path, set,
  read back and deleted at once; `hasStorageAccess()` only vetoes), `server.js` (a hello's checks in the order
  allowlist / origin, version, site, storage, busy, with nothing of the hub's storage touched before the origin passed
  and the `ack` before any check; then one Connection: ops in arrival order, the delta `snap` with each lock grant,
  channel delivery, `storage` event and `sync` reply (each with `seq`, the last of the page's numbered `ls.*` writes it
  had handled, so the page skips an entry its own later write crosses; `sync`, the page's pageshow after the
  back/forward cache, also carries the tab's `sumika.` session keys, which another page of the tab may have changed),
  the wills, the pagehide that commits wills, releases locks and takes back waits not granted, and with `persisted`
  retires the store ports the page marked `retire`), `store.js` (core/storage.js's database `sumika` / 1 / `kv`, every
  write with `commit()`, served from the dedicated worker so a YAYA or Kawari save map never crosses the page's thread,
  which a same-site hub frame shares; the frame serves it when no worker can be made; without IndexedDB memory for the
  page, as a page's own engine worker keeps saves), `hub.js` (the wiring; the allowlist is reused from the tab's hub
  sessionStorage for 5 minutes, `ALLOW_TTL_MS`).
- The protocol (`src/core/hubproto.js`, version 1), not the build, is the contract between a page and a hub: a change
  an older peer would misread takes a new version, and the hub keeps answering the old one while builds speaking it
  can be cached.
- **The back/forward cache** [decision]: a page and its hub frame go into it together, and in Firefox what the page
  posts from its pagehide on waits at the cached frame and is applied after Back, over what another origin's page wrote
  meanwhile. So the `HubClient` gets main.js's `window` and listens to its pagehide and pageshow first of Sumika's
  listeners (made before the Site, `capture`); from a pagehide with `persisted` to the pageshow (`hidden`) it posts no
  write: `ls.*` / `ss.*` stay in the mirrors (taken back at the pageshow, before the Site's sync and restart), no will,
  the page's PortStores hold theirs, and `Runtime._onPageHide` asks no engine for its files (the leave-flush stored
  everything already). The engine workers' own saves (a save timer on the thaw after Back, before the restart replaces
  them) go straight to the hub's store worker, out of the page's reach: an engine start's store port is marked
  `retire` and the hub's pagehide with `persisted` retires it (writes answered `retired`, which PortStore takes as a
  lost store, quietly); the restart's engines get new ports. Lock releases and channel posts still go; a pagehide
  not persisted and pages without `data-hub` are not affected. Residue: a write posted just before the pagehide that the
  frozen frame had not handled yet still lands after Back (CONTRACTS "Hub protocol").
- Known limits [decision]: a fallback tab and a hub tab of one origin do not coordinate; a hub that goes away mid-page
  stops that page's ghosts; no migration of a page origin's existing data; WebKit keys a frame's storage by the top
  page's origin, not its site [infer, not measured], so in Safari each listed origin keeps its own copy at the hub (no
  resume across origins there; not detected, and harmless: it is per-origin storage, like without the hub).
- Tests: the page side runs against a fake hub written from the protocol (`tests/runtime/hub_fakes.mjs`), the hub side
  on fakes (`hub_server`, `hub_allowlist`), and `hub_e2e.test.mjs` joins the real halves over Node's MessageChannel,
  with a stand-in browser around them (the hub origin's storage first-party under a same-site page, partitioned under
  another site; the page's pagehide posts lost, as measured; the back/forward cache as Firefox keeps it: page and frame
  frozen, their posts held and delivered after Back): a resume across origins, the will at a tab close, two tabs of two
  origins, save files and a dropped file through the hub's store worker, the fallbacks. A protocol change goes into
  `hubproto.js`, CONTRACTS "Hub protocol", both halves and all three kinds of test.

**A new engine** needs: a build that outputs `site/sumika/engines/<name>.js` and `.wasm` (then `npm run build` copies
them to the hashed names pages load, and stops while they are missing); an entry in `ENGINES` and `SUPPORTED_ENGINES`
(and `ENGINE_LABELS` for its "needs" note); its file list (Satori: `ENGINE_TEXT`/`ENGINE_SKIP` in
`src/core/runtime.js`; a root engine: `ROOT_ENGINES` in `src/core/engine-files.js` and `ROOT_PACK_EXT` in
`index_site.py`); a rule in `detect_engine` and `detectEngine` (names like `shiori.dll` are ambiguous); its save files
in the personal-file guard; its notices in About (`DEFAULT_ENGINES`, `src/ui/info.js`) and docs/licenses.md. Keep YAYA
the engine apart from the `yaya.dll` SAORI stand-in in `src/worker/saori/standins.js`.

**A new ghost's needs**: inventory its engine, SAORIs and script commands, then write stand-ins in the runtime;
`docs/research/tsubasa-needs.md` is the worked example.

## The ghosts Sumika was tested with

Sumika was developed and tested with the ghosts below. None of them is in the repository: the Archive column names
each one's archive for reference, and a developer adds them to a local `site/ghost/` under the ids of the first
column (`tools/add_ghost.py` or `node admin/cli.mjs add`: "Commands") to run the tests that read them ("Test data").
What this file says of "the site's" ghosts, and the docs of "the site copy" of one, means such a local copy.

The ids are those of the development site, and the tests name them (`needs('site/ghost/<id>')`, `tests/needs.mjs`):
a ghost added under another folder name leaves its tests skipped. Both add tools take a source folder's name as the
id, case kept, unless `--id <id>` names it (`node admin/cli.mjs add` names a `.nar` / `.zip` by its `install.txt`
`directory`, lower-cased). So pass `--id` where an install folder differs from the id: in case only for `Katari`,
`DSLGS`, `NodePsimoon`, `Nato`, `BTHver.5` (on a case-sensitive file system the tests do not find
`site/ghost/Katari`), and in name for the extraction folder of `add_ghost.py --from-archive`. The 14 ghosts
`tests/runtime/sweep_views.test.mjs` asks for all at once (its `SITE` list, the development site's set) include
`waha` and not `dslgs`. No test reads `site/ghost/dslgs`: what DSLGS showed is in the docs, and the tests that need
it use synthetic data.

Each of them can also be installed in SSP from the same folder or archive, to compare the two side by side. SSP
moves a ghost's bundled balloon to its own `balloon/` folder at install: etherism's as `balloon/angel_ladder`,
emily4's as `balloon/emily4`, BTHver.5's as `balloon/convulsions`, mayura's as `balloon/wiz`. mayura's archive holds a
`shiori.dll` too (never run). BTHver.5 got SSP's network update (`updates2.dau` of 2019: 10 files changed,
`ghost/master/blood/event_story.txt` added); its site copy is made from the updated install with
`add_ghost.py <install> --archive <install>/updates2.dau` (its saves `savefile1.txt`, `savebackup.txt` are in
`PERSONAL_PATHS`).

**Any ghost may be used for testing, whatever its distribution terms.** Testing the runtime against a ghost is not
redistributing it; asking authors for permission is the job of whoever hosts a site with Sumika (docs/guide.md "Adding a
ghost" tells them). Pick test ghosts for what they exercise (engine, SAORIs, shell features, balloon, characters), not
for their licence. The Terms column below is a note for a publisher.

| id | Ghost | Characters | Archive | Terms |
|---|---|---|---|---|
| `tsubasa` | Hayama-san Next Door (となりの羽山さん, English translation) | one (Tsubasa), own balloon LightBlue, many SAORIs | (an SSP install of the translation) | original's readme: 転載・配布可, contact the author first |
| `hayato` | ハヤト (by てにてに) | one (his \1 is a blank surface that holds info balloons), Satori Mc160-1, layered dress-up free shell, `empty.dll` SAORI | `hayato.nar` | redistribution on the web is fine as long as nobody claims to be the author; a modified copy names its modifier; no direct links to the archive |
| `like_a_cat` | 猫になった日 (by 八ツ墓) | two (ルドルフ, 琥珀), old Satori, no SAORI, first-boot choices | `kuro.nar` | ghost part free to modify and redistribute; shell 御影黒姉 (by 猫見) may be bundled, its PNGs must not be edited |
| `katari` | カタリベカタリ (by amo) | two (カタリ, 謎の装置); 2 shells `master` / `loligatari` (named 少女語り: folder order ≠ name order) that her own menu switches with `\![change,shell]`; OnShellChanging / OnShellChanged that re-dress with `\![bind]`; key `b` → `\![change,balloon,random]` + OnBalloonChange; script-only dress-up (`menuitem0,-`); dsaudio, httpc, time_check | `Katari.nar` | readme states no terms |
| `dslgs` | Downer_Smoker_LegalLolita_Gothic_Surgeon (by wahoge) | two (Charlotte Peace, Parliament); a large Clothes/Dressup ▸ (36 menuitems with separators and a numbering gap, mustselect categories as repeated `bindoption0.group` lines, a duplicated category/part マフラー/黄色, OnDressupChanged talk per part); `fill_desktop` | `DSLGS.nar` | readme: 転載や二次創作、批評などは完全に自由 |
| `waha` | わはー＆危い | two (わはー, 危い); Satori; three shells `master`, `OS`, `summer`; no balloon of its own. One of the 14 that `tests/runtime/sweep_views.test.mjs` needs (above) | (not recorded; install folder `waha`) | readme states no terms |
| `etherism` | エーテリズム (by 零号) | two (エーテル, シモン); its own balloon 天使の梯子 (`angel_ladder`), hoisted into every ghost's Balloon ▸; OnBalloonChange and OnFirstBoot read the balloon's numbers with `\![get,property,…]` (`currentghost.balloon.scope0.validwidth`, `.lines`, `.char_width`) for its menu rules (the property system answers them); OnNotifyUserInfo sets its `ユーザ名`; unnumbered `bindoption.group` mustselect; OnNotifyDressupInfo read by position | `etherism.nar` | readme: no redistribution on the web while it is being distributed (×), allowed after distribution ended (〇); no direct links to the archive |
| `roommate` | ルームメイトは変わり者 (by らきあ) | 琥珀 あかね (the ghost names no kero); 2 shells `master` / `masterx1.5` (マスターシェル / マスターシェルその２) with the same 4-group dress-up (per-shell dress-up memory), menuitems 0 and 3 only. Both shells say `sakura.name,none` / `kero.name,none`, so the others see her as `none` (otherghostname, FMO, a talk's sender): ssp.exe does the same (no special `none`; her `name.allowoverrid,1` is no key, and `name.allowoverride` would not stop it) [disasm, EV §2.1 #11] | `roommate.nar` | readme: 無断での再配布はご遠慮ください (no redistribution without asking); the shell (モノクローム by Tylwing) follows its author's terms |
| `emily4` | Emily/Phase4.5 (by the Emily Development Team; SSP's bundled ghost) | five (Emily, Teddy and `\p[2]`–`\p[4]`); YAYA (her own DLL is Tc571-15), the Lilith template, 33 UTF-8 dictionaries, an emergency config `yaya_emerg.txt`, no SAORI; an element-composed shell with `.pna` masks, one bind group, a menu skin; her own balloon `emily4` (Balloon for Emily/P4) at `site/ghost/emily4/emily4/`, copied from SSP's `balloon/emily4` (add_ghost does it): her archive ships it in `balloon/` (`install.txt`: `balloon.directory,emily4`, `balloon.source.directory,balloon`) and SSP moves it to the shared folder at install | (ships with SSP; compared with her `updates2.dau`) | readme: CC BY-NC 4.0 |
| `bonsyou` | 梵鐘/MMOBPG | one (梵鐘; the kero is named なし); YAYA (its DLL 5.39.3), 5 Shift_JIS dictionaries; `\![sound,play]` → OnSoundStop (EV §4.17) → `\![execute,http-get,…,--async]` → OnCountComplete, and OnMouseGesture, its main interaction (right-drag left then right: the gong; EV §4.5.1; it rings again once the gong's OnSoundStop has cleared its `GongLock`). Its menu counter (今まで撞かれた数) fetches `bonsyou_count.txt` into `var/bonsyou_now.txt` and OnCountCompleteMenu reads it (EV §4.15). SSP's run left both downloads, `ghost/master/var/bonsyou.txt` and `bonsyou_now.txt` (in `PERSONAL_PATHS` as `var/bonsyou*.txt`) | `bonsyou.nar` | readme: NYSL (public domain), except YAYA's own files |
| `nodepsimoon` | NodePsimoon | two (さい子, アオハ); AYA5 c240 (`aya5.dll`, so engine `yaya` with `module: aya5`: `aya5.txt`, `aya5_variable.cfg`), 10 dictionaries, no SAORI | `NodePsimoon.nar` | none found |
| `nato` | なっとう (by amo) | two (なと, ごはん); Satori, SAORIs dsaudio, fill_desktop, gomi, httpc, time_check (stand-ins; ssu is built into Satori); Katari's designed partner: answers her lines by name (`＊カタリ「…`), talks to a random FMO partner or `__SYSTEM_ALL_GHOST__`, answers the property protocol with `（FMO0name）` (EV §2.7.7–§2.7.9) | `Nato.nar` | readme states no terms |
| `bthver.5` | BloodTeaHOUSE ver.5 (裏子ver.2.732, by 竜子) | two (裏子, んごー); Kawari 8.2.8 (its own DLL is 8.1.0), KIS dictionaries in `.txt` files under `core/`, `comm/`, `blood/` that `kawarirc.kis` loads (4,924 entries), no SAORI (its `bln` line is commented out), the widest event use (OnTranslate, OnOtherGhostTalk, call events, OnDressupChanged, OnBalloonChange) [corpus]; 2 shells `master` / `5th-smart` (5th-Normal / 5th-Smart, a bind group 髪); its own balloon `convulsions` (痙攣-ケイレン-), hoisted into every ghost's Balloon ▸; saves `savefile1.txt` and a backup `savebackup.txt` (every 7 days, its readme) in `event.OnClose` / `OnGhostChanging` (`Save1`, `Save3`) and at first-boot answers and menu settings (`Save1`), never at unload; a tab closed without Close is saved by D6's close at the next visit (OnClose `system`, kawari-wasm.md §8), at the time the tab was closed, so its `CoEndtime` / `CoEndday` stamps and the time away it counts at boot start there; Katari's lines are the ones its `comm/comm_ghost03.txt` answers [corpus], once its `Mode` is `Tea1` (during its first boot `Mode` is `First` and it answers 204, by its own dictionary); its balloon's wrap point lies right of its validrect (balloon-format.md §2.1) | `BTHver.5_2.732.nar` (install folder `BTHver.5`) | readme: 二次創作は基本的にOK (no permission needed); 再配布はご連絡下さい、無断配布は認めていません (redistribution: contact the author first; none without asking) |
| `machimaki` | 同人屋稼業 (by 酉) | two (真知, ちまき); Kawari 8.2.8 (its own DLL is 8.0.0), the OpenKEEPS template (shared with kuro, umikoF, bloody_moon …) in 9 `.kis` files (544 entries; 17 parse errors per load from 8.0-era syntax), no SAORI; one shell 戦闘服 with menu images; saves `dict-keeps-savedata.txt` only at unload (the test for the resume snapshot and D6); its first boot asks the user's name; after a killed SSP it says the last session ended abnormally (KEEPS's crash talk), but not after a tab closed without Close (D6's close sets its `closemode`, as SSP's close at a Windows shutdown) [measured], and its OnUnload's `endtime` / `endday` are the tab's close, so back after 40 days it says its long-time-no-see boot talk (`TalkBootup.long.31over`), not its back-within-3-minutes one [measured] | `machi_1.0.nar` (install folder `machimaki`) | none found (the archive has no readme) |
| `mayura` | まゆら＆黒うにゅう (『何か』Wiz まゆら v3.50, by 夢蛍) | two (まゆら, うにゅう; her menus call him 黒うにゅう); Kawari Phase 7 (`kawari.ini`, engine `kawari7`, SHIORI/2.x through the bridge; its own DLL is 7.5.0 `KAWARI.kdt.i18n`, the build Sumika compiles), 4 Shift_JIS `.dat` dictionaries (734 entries), no SAORI; a maze sub-game and a junk shop, site patrol and headlines that open pages with `\![open,browser]`, SNTP (`\6`), OnGetStatus; the teach box (`\![open,teachbox]`, 7 places: the player's name, the patrol interval and sites, the shop) → TEACH → `system.OnTeach`; saves `mayura.ini` in `system.OnUnload` (so D6 finishes a session whose tab was closed) and a backup `mayura.bak` at every boot; ships the author's encrypted save `mayura.ini` (`!KAWA0000` lines: game flags and the shop's stock, no player name) and an empty `news.dat`, both in `KAWARI_SHIPPED_SAVES`; looks for alto (あると) among the other ghosts; one shell `master` with `.pna` masks and a menu skin (menu_background/foreground/sidebar.png); its own balloon `wiz` (palette PNGs with tRNS: balloon-format.md §1.3), hoisted into every ghost's Balloon ▸. Added from a pristine extraction with `add_ghost.py --archive` | `mayura_v350.nar` (install folder `mayura`) | readme: reusing, modifying or redistributing its files: ask the author (夢蛍) first; files of older versions: not at all; fan works need no check, commercial or paid works: ask first |

Only Tsubasa, etherism, emily4, bthver.5 and mayura bring a balloon (`LightBlue`, `angel_ladder`, `emily4`,
`convulsions`, `wiz`); the others boot with the site's default balloon `sumika`. Balloon ▸ offers every balloon of the
site to every ghost: `tools/index_site.py` hoists bundled balloons into the site's balloon list, as SSP installs them
(`balloon-format.md` §1.6), so `LightBlue`, 天使の梯子, Balloon for Emily/P4, 痙攣-ケイレン- and wiz are in everyone's
Balloon ▸ next to `sumika`.

## What gets published

- **Published:** `site/` without `site/dev/`, uploaded to the root of a static host.
  - That is the top-level `404.html`, `sumika/` (runtime, engines, index), `ghost/<id>/` and `balloon/<id>/`. There is
    no page at the top: the test pages are in `dev/`, and the publisher's own pages go beside.
  - **Versions** (safe updates): only four published names are roots that stay fixed: `sumika/sumika.js` (the code: it
    holds its build id and the table of the hashed worker and engine names), `sumika/index/ghosts.json` (the data:
    index format 2, naming the hashed manifests and the `?v=` of its thumbnails and icons), the storage hub
    `sumika/hub.html` (naming the hashed `engines/hub.<h>.js`, which only `build.json` names besides it) and the
    control page `sumika/index.html` (served as `https://<host>/sumika/`, naming the hashed `engines/control.<h>.js`,
    which only `build.json` names besides it; Code "On or off"). Everything a root names carries a hash of its bytes,
    in its name (worker, engine copies, manifests, packs) or as `?v=` (ghost and balloon files, which keep their
    ghost-given names; fetched with `force-cache`).
    Code and index meet through the index `format`, not a build id. So the files of one version load together on any
    static host, with no host settings, and an unchanged file keeps its URL and the visitors' caches. Files loaded by
    elements (menu skins, cursors, the launcher icon, sounds) keep their plain URL (CONTRACTS loader.js); so do a
    ghost's MIDI files, which the MIDI player fetches at that URL with the browser's default caching.
  - `sumika/build.json` names the current build, its stored-data `schema` and the table (read by `tools/prune.mjs`,
    the tests and the next build's schema check). Pages read it only in `Site.staleCheck`: a page older than the
    published build whose own files are gone (or that meets an index, ghost state or prefs newer than itself) reloads
    once into the published build, and only once the new `sumika.js` is in hand.
  - `sumika/engines/` holds the hashed `worker.<h>.js` (+ `.map`) and engine copies `<e>.<h>.js` / `<e>.<h>.wasm` that
    pages load, and the plain `satori.{js,wasm}`, `yaya.{js,wasm}`, `kawari.{js,wasm}` and `kawari7.{js,wasm}` that the
    engine builds write and the tools read (tests, `tests/load_engine.mjs`, the sweep, the smoke scripts,
    `*_vs_dll`); pages never load the plain ones, so a publisher may leave them out. With them their
    `*.build-info.json` and `satori.LICENSES.txt`, `yaya.LICENSES.txt`, `kawari.LICENSES.txt`, `kawari7.LICENSES.txt`
    (each the notices of everything compiled into that wasm; BSD's binary clause, Kawari's modified BSD and Gumbo's
    Apache-2.0 want them with the binary, so keep them next to it; plain names, not versioned: nothing loads them).
  - The MIDI player is three more files in `sumika/engines/`: `midi.<h>.js` (+ `.map`, in every build; about 414 KB,
    140 KB gzip), its sound bank `generaluser_gs.<h>.sf3.gz` (4.8 MB; the gzip of the pinned SF3, named by the SF3's
    hash; the Worker inflates it, so no host setting is needed), both in the build table and fetched by a page only
    when a ghost first plays a MIDI file, and `midi.LICENSES.txt` (plain name, not versioned: Apache-2.0 and the bank's
    licence want it with them; keep it). MIDI needs a secure context: on a plain `http://` host MIDI files stay silent.
    There is no plain-name copy of the bundle or the bank under `site/`.
  - `404.html` must stay at the top level (a publisher may restyle it): with it GitHub Pages, Netlify and Cloudflare
    Pages answer a missing file with 404; without it Cloudflare Pages answers every unknown path with `/index.html` and
    status 200, so a file that is gone would not read as missing. nginx and Apache ignore it.
  - The README's script line loads `/sumika/sumika.js` with a root-absolute path. Under a subpath, make that path
    relative; the runtime finds the site from its own URL, or from `data-base`.
  - The `.map` files are optional; they embed `src/`.
  - **Pages on other origins** (docs/guide.md "Pages on other sites", Code "The storage hub"): a page elsewhere that
    loads `sumika.js` from the runtime host needs CORS on that host (`Access-Control-Allow-Origin: *` on every GET:
    `ghosts.json`, manifests, packs, ghost and balloon files, thumbnails, `build.json`, `word_compatible.txt`, the
    `.wasm`, the MIDI bundle and bank, `.mid` files; the runtime sends only plain GETs, so `*` is enough and no
    preflight is needed; `importScripts` of the worker and engines needs none). GitHub Pages sends it [verify], Netlify
    and Cloudflare Pages take a `_headers` file, nginx `add_header … always`, Apache `Header always set`; Sumika ships
    no `_headers` (host-specific). With `data-hub` the hub page `sumika/hub.html` must be frameable by the listed
    origins (no `X-Frame-Options`; `frame-ancestors` optional hardening). `sumika/hub.json` is the publisher's
    allowlist (`{"format": 1, "origins": [...]}`, exact origins), never built, versioned, pruned or committed (not in
    the repository; `.gitignore` keeps it out); missing = the hub
    answers no page; `tests/build_output.test.mjs` fails while `site/sumika/hub.json` lists a loopback origin, is
    unusable or has an entry no hub keeps (the publish gate: `npm test` is step 5); local tests use
    `serve.py --hub-allow`, never a file.
  - `sumika/word_compatible.txt` is SSP's own `data/word_compatible.txt`, byte for byte: the word list for the
    `%ms`-style variables no ghost answers (properties.md §2.4), fetched by the Site at the first such word. SSP's
    readme asks people not to redistribute parts cut out of SSP, so it is a separate file a publisher may leave out
    (then such a variable stays as written, as in an SSP without it). The repository does not hold it [decision]: a
    publisher who wants it copies it unchanged from an SSP install (`data/word_compatible.txt` in SSP's folder; SSP
    2.9.10's is 2,341 bytes), and `.gitignore` keeps it out. Tests read it (`tests/runtime/words.test.mjs`, the
    Kawari 7 integration test) and skip without it; the sweep uses it when it is there.
  - `sumika/kawari-shipped.json` ("The admin tool", "From an archive"): the record of the Kawari save-header files
    ghosts added from their own `.nar` / `.zip` brought (`{"format": 1, "ghosts": {"<id>": [[path, crc32], …]}}`),
    written by the two add tools, read by the two index tools; no page reads it. Not in the repository: it describes
    a local site's ghosts, and `.gitignore` keeps it out. Published with the rest [decision]:
    it holds the authors' file names and CRC-32s, nothing a user told a ghost (those very files are published beside
    it), and keeping it out would be sound only with an exception to "`site/` without `site/dev/`" that every
    publisher of a whole folder (GitHub Pages, Netlify, Cloudflare Pages, as Prepare upload advises them) makes by
    hand; and as it stays with the site folder, a copy of the folder indexes the same. Never built, versioned or pruned
    (`tools/prune.mjs` lists only `engines/` and `index/`); Prepare upload lists it among "everything else", never its
    temporary files `sumika/kawari-shipped.json.tmp-<8 hex>` (a write cut off before its rename; the program's tidy-up
    deletes them, and hub.json's `sumika/hub.json.tmp-<8 hex>` alike). Missing = no ghost added from its archive
    brought such files. An editor's BOM is read past; one that exists and does not read otherwise is never read as
    empty [decision]: every add, a removal and the index (both tools) stop, nothing changed, until it is repaired, or
    deleted and those Kawari ghosts added again from their `.nar` / `.zip` ("The admin tool", "From an archive").
- **Publishing flow:**
  1. the engine builds, only when engine sources changed;
  2. `add_ghost.py` / `make_default_balloon.py`, only when ghosts or balloons changed;
  3. `npm run build`;
  4. `python -I tools/index_site.py` (3 and 4 are independent, neither reads the other's output, and both always run
     before a publish);
  5. `npm test`, ending `fail 0` (the publish-set tests, which skip nothing, check that the set on disk is complete;
     a skip names development data a publisher's site need not have: "Commands");
  6. `node tools/prune.mjs` (the very first time `--first`), only when an upload follows; an editor's BOM in the
     ledger is read past; a ledger that exists and does not read stops it (code `bad-ledger`: restore it, or delete it
     and run with `--retire-all`; the admin's Prepare upload offers "Start a new record" for it, "The admin tool");
  7. the upload of `site/` without `site/dev/`. A host that publishes a whole folder at once (GitHub Pages, Netlify,
     Cloudflare Pages): any order. A host that takes files one by one (FTP, a plain server): everything else first
     (`engines/hub.<h>.js` and `engines/control.<h>.js` included), then `sumika/index.html`, then `sumika/hub.html`,
     then `sumika/sumika.js`, then `sumika/index/ghosts.json` last (`admin/server/upload.mjs` `LAST`, and the admin
     page's own copy `admin/page/upload.js` `LAST`). That order is required: a ghost file that arrived after the
     `ghosts.json` naming its new `?v=` could be kept by browsers with its old bytes under the new name; with the hub
     before the code, a new page never meets an old hub during an upload; each fixed-name page after the hashed script
     it names. The control page goes first of the four [decision]: no page loads it, and either version of it writes a
     record either version of `sumika.js` reads (`core/choice.js`; a newer record is read for what fits).
     What prune deleted locally may then be deleted on the host; leaving it longer does no harm.
- **The rollback rule** (a schema bump is one-way): once a build whose `SCHEMA` (`src/core/schema.js`) is higher for
  some record kind has been published, visitors hold records only it and later builds can write. A host that serves
  an older build again (Netlify's or Cloudflare Pages' one-click rollback, a git revert on GitHub Pages) leaves them
  read-only for good. So a host's own rollback must never cross a schema bump; publish the older behaviour as a new
  build that keeps the newer readers (revert the feature, not `schema.js`). `build.mjs` refuses to build a lower
  `schema` than the last `build.json`, and a page that meets newer records while `build.json` names its own build logs
  it once. A new kind counts as a bump for older tools (a kind they lack is 0): an older tree's `build.mjs` refuses to
  build over a site whose `build.json` has a kind it lacks (such as `choice`), and a sumika-admin built from such a
  tree opens the site read-only ("made with a newer Sumika") until it is rebuilt.
- **The bounded exceptions:** ghost files are replaced in place (their names are the ghost's), so a tab left open
  across a ghost update can get the new bytes of a file it had not loaded yet under its old `?v=` (a size that differs
  from the manifest's is fetched again, unless the tab has met a host that rewrites files: `sumika.hostRewrites`),
  until its next page; and an element-loaded file (plain URL) may show its old bytes after an update until the
  browser's own cache lets it go. Nothing mixes code.
- **Never published:** `tests/`, `docs/`, `tools/`, `admin/` (with the admin tool's generated `admin/build/` and its
  programs in `admin/dist/`), `engines/`, `toolchain/`, `vendor/`, and the prune ledger `site.published.json` (outside
  `site/`, as is a ledger that did not read which Prepare upload's "Start a new record" set aside beside it,
  `site.published.json.broken-<YYYY-MM-DD>[-n]`).
- **Not in the repository** (`.gitignore`): `node_modules/`, `toolchain/`, `admin/build/`, `admin/dist/` (a release
  may attach the programs), `engines/*/build/`, `__pycache__/`, the local ghosts and their index files (`site/ghost/*`
  but `.gitkeep`, `site/sumika/index/*` but `ghosts.json` and `balloon.sumika.*`: "Project rules"), the publisher's
  `site/sumika/hub.json`, `word_compatible.txt` and `kawari-shipped.json` (and their cut-off `.tmp-*` writes), the
  ledgers `*.published.json` and `*.published.json.broken-*`, `.claude/`, and OS litter. So a host that publishes
  from a clone of the repository gets no ghosts: a publisher uploads a copy of `site/`, keeps the site in a repository
  or branch of its own, or drops those lines in a fork (docs/guide.md "Publishing"). `.gitattributes` keeps
  every file byte for byte (`* -text`: no line-end conversion), since the published names are hashes of bytes and the
  test ghosts and `vendor/` keep their CRLF and code page 932 files as they are.
- **Visitor state** stays in the visitor's browser:
  - IndexedDB `sumika` (store `kv`), key `ghost:<id>:files`: the engine's save files, written by the worker. Without
    IndexedDB they last only for the page (a worker has no localStorage). A YAYA ghost's keys are ghost-root-relative
    (`ghost/master/yaya_variable.cfg`, and every file it wrote or rewrote in its own folder, `../../notelog/` included);
    a `null` value keeps a shipped file it deleted deleted. Its ghost state's `engine` holds the dictionary stamp
    (`{dicStamp}`; Satori's the talk countdown). A Kawari ghost's keys are the same (`ghost/master/savefile1.txt`,
    `ghost/master/dict-keeps-savedata.txt`, whatever names it saves under), plus `?kawari/resume.kis`, the snapshot
    of the dictionary entries the session changed and those its load made (`?` is in no Windows file name): absent =
    never met, empty = met with nothing to restore (after Close, D7), bytes = `# dicStamp <hex>` + the snapshot
    (kawari-wasm.md §8). A `\![execute,http-*]` download is one more file the ghost wrote (`ghost/master/var/<name>`;
    Satori's key `var/<name>`), replaced by the next one. `--param-input-file` never sends a personal file nor any file
    the visitor's own run wrote (a stored key with bytes), for every engine [decision].
  - Same store, keys `drop:<lower-cased path>` and `drop:index`: audio files the visitor dropped on a ghost
    (`src/core/drops.js`; only audio the browser can play, and MIDI files by their name where the MIDI player runs
    (`playable(type, name)`); at most 64 MB each, 256 MB in total, and never so much that the quota gets tight; never
    uploaded). Other dropped files, and every file without IndexedDB: this page only. The MIDI player's bundle and bank
    are no visitor state: the browser's HTTP cache keeps them (hashed names). `DropStore.clear()` forgets them; nothing
    calls it: a menu item for it would be an addition SSP does not have.
  - localStorage `sumika:ghost:<id>:state` and `sumika:runtime` (`ghosts`: the ghosts on screen, in call order;
    `ghost`: the first of them, for older code; `rev`: +1 on every write of the set; `lang`: the UI language choice
    `ja` | `en` | `system`, site-wide; `user`: what the visitor typed into the Preferences box, `{name?, nickname?,
    birthday?: 'YYYY-MM-DD' | '', sex?: 'male' | 'female' | 'undef'}`, site-wide, absent until the box was saved;
    `src/core/user.js`, UI §2.13: it reaches only the ghosts' own engines, through OnNotifyUserInfo and `%username`,
    never a log or a URL). The ghost state also holds `ghostLife.otherGhostTalk` (what
    `\![set,otherghosttalk]` asked for), the sakura and kero names in effect (`names`: what the other ghosts see of
    it on the next page until it is up), the shell in use (`shell`), whether the visitor picked it (`shellChosen`;
    otherwise the ghost boots its default shell), the chosen balloon's folder id (`balloon`), the per-shell memory
    `shells` (each shell's dress-up and balloon, like SSP's `shell.dat`) and `shellSwap` (the surfaces shown before a
    shell swap whose OnShellChanged has not decided them yet, so a page left meanwhile comes back visible), and
    `trayIcon` / `minimized.icon` (a script's `\![set,trayicon]` file, for the next minimize / shown while minimized;
    UI §2.6). Its `savedAt` (the time of its last write, at pagehide too) is read at a cold boot, before that boot
    writes it, as the time the ghost's last session ended: Kawari's D6 closes that session at it (`sessionEndMs`,
    kawari-wasm.md §8).
  - localStorage `sumika:choice` (Code "On or off"): the visitor's On or Off from the control page,
    `{choice: 'on' | 'off', v: 1}`; absent = "Site default". Written by the control page only (at the Sumika host, so
    with `data-hub` it is the hub's), read by main.js before anything is made; Off keeps every other record as it is,
    so On later carries on.
  - sessionStorage `sumika.session` (resume vs cold boot: `ghosts` = the ghosts this tab booted; `carry` = per ghost
    what the next page finishes: a change or call whose ghost has not booted yet, or OnGhostCallComplete /
    OnOtherGhostChanged still owed; `quit: true` while Quit says goodbye, so the next page goes on with it; cleared
    when the site closes; the v1 `ghost` and `pending` stay for older code), `sumika.lastInputMs` (idle clock),
    `sumika.reloadedFrom` (the build this tab reloaded away from: `Site.staleCheck`'s guard, one reload per tab per
    build) and `sumika.hostRewrites` (`'1'` once a file's size still differed from its manifest's after a reload: a
    host that rewrites files, such as a CDN's image optimisation; `fetchVersioned` then takes stored copies of another
    size as they are, so such a host costs one download per tab, not every image on every page).
  - **Version marks** (`src/core/schema.js` `SCHEMA`, safe updates): one per record kind, and one hook (`upgrade`) on
    each kind's read path, run before any field is read. Ghost state `v` 1 (`STATE_VERSION`); `sumika:runtime` `v` 1
    (in storage only: `runtimePrefs.get()` hides it); the tab marker `v` 2 (unmarked: 2 with a `ghosts` array, else 1,
    which `sessionMarker.read` brings up); the save files 1, which is the key `ghost:<id>:files` itself (a new shape
    would take `ghost:<id>:files.v2`: a mark inside the record would be mounted as a file by older workers);
    `drop:index` `v` 1; `sumika:choice` `v` 1 (kind `choice`: a key of its own, which the control page writes alone; a
    newer one is shown and never written over there). Not versioned: `sumika.lastInputMs`, `sumika.reloadedFrom`,
    `sumika.hostRewrites`, the cross-tab messages (additive fields; an incompatible one takes a new `t`), and
    IndexedDB's `DB_VERSION`, frozen at 1 (an upgrade is blocked by open older tabs). Bump a kind only for a change an
    older reader would misread or an older writer would damage; every writer keeps the fields it does not know.
    `upgrade` marks a record it moved up with the version reached, so a second pass on the same read runs no step
    twice. The only migration step is the marker's v1 step. The full rules (also: a change of the SakuraScript
    tokenizer's token numbering bumps the state version) are in CONTRACTS schema.js; the rollback rule is above.
  - **A record newer than the page** (a visitor back on an older cached page, an old tab) is read for what fits and
    never written or cleared: the ghost state (`StateStore.newer`), the prefs (`runtimePrefs.set` answers false; the
    Site then posts no set message), the drop store (read-only for the page). The marker is the exception: each page
    writes its own version. A newer ghost state or prefs record also makes `Site.staleCheck` ask whether a newer
    Sumika is published. A save-files record the worker cannot read makes it run memory-only for that page instead of
    writing over it.
  - Cross-tab locks: `sumika:<id>` per ghost (one engine per ghost); `sumika/lead` for the tab that runs the set (every
    ghost on screen; only it changes the set; the others show them frozen and take the whole set over); the drop index
    lock `sumika/drops`. The BroadcastChannel `sumika/runtime` carries set messages (`{t:'set', ghosts, rev, cause}`: a
    call, a close, a ghost change, Quit, a sync) and shell changes (`{t:'view', id}`) to the other tabs.
  - **With `data-hub`** (Code "The storage hub"): the same keys, records, locks and channels, at the hub's origin (its
    localStorage, the tab's sessionStorage there, its IndexedDB `sumika`, its Web Locks and BroadcastChannels), so
    every listed origin's pages see one visitor. A page with the hub neither reads nor writes its own origin's Sumika
    data, and nothing is migrated [decision]: turned on after visitors came, their ghosts start afresh on the hub, and
    their per-origin data comes back if the hub is turned off. **Wills**: the tab holding a ghost's engine lock tells
    the hub its state key; when that lock goes (the page's unlock, or the hub's own pagehide, persisted or not) the hub
    sets the record's `savedAt` to its own clock before releasing the lock, so Kawari's D6 gets the session's end even
    when the page's last write was lost: posts a page makes in its pagehide do not reach the hub in Chromium (link,
    reload, tab close: 0 of 20) while the hub's own pagehide writes land (20 of 20, IndexedDB up to 16 MB) [measured,
    Chromium]. So the page flushes earlier (a link click, a form submit, `beforeunload`, hiding: CONTRACTS site.js),
    and what no Sumika event sees (iOS Safari's reload, back or typed URL, a host page's `location.assign`, a crash)
    resumes from the last write the hub got. A pagehide into the back/forward cache (`persisted`) posts no write at
    all until the pageshow, and the engines' store ports are retired at the hub then: in Firefox those posts would
    otherwise land after Back, over what another origin's page wrote meanwhile (Code "The storage hub"). The hub's own
    keys stay out of the pages' reach: the probe cookie `sumika-hub-probe-<nonce>` (set and deleted at once),
    `sumika-hub:probe` (localStorage, removed at once) and `sumika-hub:allow` (the allowlist cached in its
    sessionStorage, 5 minutes).

## Test data

- **`tests/fixtures/`** (in the repository: the project's own test data): `ghosts.json` is a site index (the
  synthetic `testghost`, an index entry of Tsubasa, and a Misaka ghost `misakaghost` (`misaka.dll`) that exists only
  there, for "needs Misaka": the runtime has no Misaka engine, and Sumika never runs that closed DLL);
  `ssp-ghost-order.json` is ssp.exe's Change ghost ▸ of one SSP install with 23 ghosts, as a screenshot showed it
  (folder id and descript name, in the menu's order: "The admin tool", "Order"), for the order tests in
  `tests/runtime/shells.test.mjs`, `site.test.mjs` and `tests/admin/parity.test.mjs`; `ghost/kawaritest/` is the
  project's own Kawari Phase 8 ghost in code page 932 with CRLF (counters saved by OnUnload to `save.txt`, a menu,
  OnCommunicate, a CRLF `textload`, `readdir ../../..`, a `../../shell` read, half-width kana entries, a SAORI with no DLL shipped, `debugger on` so the tests evaluate KIS with
  `GET ShioriEcho`) for `tests/kawari_engine.test.mjs` and `tests/runtime/kawari_integration.test.mjs`;
  `ghost/kawari7test/` is the project's own Kawari Phase 7 ghost (kawari.ini and one Phase 7 dictionary, code page
  932, CRLF; counters loaded and saved by `system.OnLoad` / `OnUnload` without dictionary defaults, since `$(load)` adds
  words;
  every SHIORI/2 path: OnTranslate, OnTeach, OnResponse, a resource, a talk to another ghost, `GET Word`'s
  `compatible.ms` / `.m` / `.dms` and `OnWords` that uses them; `debug : debugger`) for
  `tests/kawari7_engine.test.mjs` and `tests/runtime/kawari7_integration.test.mjs`;
  `ghost/yayatest/` is the project's own UTF-8 YAYA ghost (`yaya.dll`, Yayako and Kero; a small load / request / unload
  framework that counts boots, a dictionary the ghost rewrites, a data file it deletes, `OnTest` helper cases) for
  `tests/yaya_engine.test.mjs` and `tests/runtime/yaya_integration.test.mjs` (Shift_JIS cases are written as bytes by
  the tests); `ghost/testghost/` is a tiny UTF-8 Satori ghost (one dictionary, one 80×120 surface, no balloon, a
  ghost-root `readme.txt`) for the ghost-change tests. It has two shells: `master` and `alt` (named `Winter`: name
  order master < Winter, folder order alt < master), whose dress-up has a mustselect category and menuitems in a
  non-numeric file order; the shell-change tests (`tests/runtime/view_switch.test.mjs`) run on it. For a browser
  check, copy `site/dev/index.html` and `site/dev/page2.html` (into the folder's `dev/`), `site/sumika`, a local
  `site/ghost/tsubasa`, `site/balloon/sumika` (the default balloon the fixture ghost gets) and the fixture ghost into
  a scratch folder, run `python tools/index_site.py <folder>` (copy `sumika/`, never link it: indexing rewrites
  `sumika/index`), and serve it with `tools/serve.py --site <folder> --port <free port>` (the pages at `/dev/`).
- **`tests/runtime/multi.test.mjs`** runs several ghosts on a synthetic site (Satori `x`, `y`, `z`, `w` and a Misaka
  `mm`, whose engine is missing) with fake engines that log every request in one order, real `GhostLock`s over fake
  Web Locks and channels, and `invariants(site, w)` (the lead ⇔ a ghost lock, the stored set = the slots, the marker
  lists every booted ghost, one layer per slot, one ghost with the keys) after every step. Its stages are fakes, except
  for ghosts in `w.shells`: real headless Stages on synthetic shells of given surface sizes (`sizedStage` in
  `tests/shell/helpers.mjs`, no PNGs), for placement. That synthetic site is `tests/runtime/multi_world.mjs` (a
  ghost's `descript` pairs add to its descript.txt); `tests/runtime/interact.test.mjs` runs ghosts talking to each
  other, raising events in each other and reading the FMO on it.
- **`tests/corpus/`** (development material, not in the repository: it holds ghost content) holds Tsubasa's
  responses from the real `satori.dll`, plus the ghost it ran on (see the README there), and `emily4/`: what her own
  `yaya.dll` (Tc571-15) answered to 631 requests, for `tests/yaya_vs_dll.mjs`.
  - The sakura corpus/replay tests and the shell dress-up test read it, and skip with the reason when it is missing.
  - `tools/dll_harness.ps1` (32-bit PowerShell) hosts a SHIORI DLL (`-Dll`) for the requests, in Shift_JIS or with
    `-Charset UTF-8`. It recorded these corpora on a scratch copy of a site ghost, never in an SSP install.
  - The driver that made the requests, the timeouts and the ghost copy is kept as a record in
    `tests/corpus/runtest.py`. It does not run as is.
- **Fixtures made from a ghost's files** are development material, not in the repository, like the ghost they come
  from. `FIXTURES` in `tests/needs.mjs` names each, and its tests skip with that reason while it is missing:
  - `tests/balloon/fixtures/corpus.json.gz`: the 1,995 menu frames extracted from the corpus (Tsubasa's menu
    scripts), for `tests/balloon/corpus.test.mjs`;
  - `tests/balloon/fixtures/golden.json`: the real responses of her `satori.dll` that golden layouts B–G of
    `tests/balloon/golden.test.mjs` play (A builds its page from rows of its own and needs only the ghost);
  - `tests/shell/fixtures/renders/`: reference compositions of her shell, made by
    `docs/research/scratch/ref_compose.py` (development material, not in the repository), for the render comparison
    in `tests/shell/compositor.test.mjs`.

  The scripts that made them are development material too, so the fixtures come with the rest of it, never through
  the repository.
- Many tests also read `site/ghost/tsubasa`, `site/sumika/engines/satori.js`, `yaya.js`, `kawari.js` and `kawari7.js`
  directly (the ghosts' tests skip while the ghost is not in the local `site/ghost/`; "Commands"); the pack test walks
  every root-engine site ghost (bthver.5, machimaki and mayura included, when they are there);
  `tests/balloon/wrap_clip.test.mjs` reads `site/ghost/bthver.5` and `trns.test.mjs` `site/ghost/mayura`;
  `tests/runtime/menu_odm.test.mjs` reads `site/ghost/bthver.5` and asks it for its menu skin on `kawari.js`. There
  is no real-DLL corpus for Kawari: no DLL is run ("Project rules"). `tests/midi_engine.test.mjs` reads Katari's four
  `.mid` files (`site/ghost/katari/ghost/master/`: their durations are pinned to 1 ms) and the pinned bank in
  `vendor/`; the page-side MIDI tests (`tests/runtime/midi_player.test.mjs`, `midi_sounds.test.mjs`) run on fakes
  (`tests/runtime/midi_fakes.mjs`, no test file).

## The admin tool (sumika-admin)

A GUI for one site admin (no accounts) to set up `hub.json`, list, add and remove ghosts, check the site and prepare an
upload, in English and Japanese. Its interfaces are CONTRACTS "Admin core" and "Admin API".
- **How it runs:** a small local program (`sumika-admin.exe` on Windows; Mac and Linux builds from the same code,
  untested on real machines) that serves the admin page to the admin's own browser on 127.0.0.1 only (any browser:
  Firefox, Chrome, Edge, Safari) and does all file work itself. Not a browser page with the File System Access API
  (Firefox lacks it), not PHP on the host (archives should not go to the server; static hosts run no PHP), not Python
  (admins should not need it).
- **Sources from anywhere:** ghosts are picked from any folder or archive on the computer, several at once; never one
  fixed SSP folder. In the system's own file and folder dialogs, which the program opens ("The file dialogs" below),
  and by drag-and-drop from Explorer; the in-page file browser over all drives is the fallback where the program has
  no dialog, and stays one link away ("Browse in this page instead").
- **Settings:** a plain JSON file the program reads and writes, `sumika-admin.json` next to the program (the site
  folder, recent places, the folder each file dialog last picked in, the language); in the user's app-data folder when
  the program's folder is not writable.
- **Removing a ghost deletes it** (folder and index entries; the index's old versions go at the next "Prepare upload",
  on the safe-updates schedule); the admin re-adds from a folder or archive if wanted.
- **Order:** SSP's order. ssp.exe lists the ghosts by descript `name` (`ghost/master/descript.txt`), not by folder
  [observed]: its Change ghost ▸ shows the 23 ghosts of `tests/fixtures/ssp-ghost-order.json` exactly in the order of
  `compareEntries` (`src/core/shells.js`: wcsicmpex on the names, case-insensitive, full-width ASCII = ASCII, katakana =
  hiragana, digit runs as numbers; ties by folder with wcsicmp_custom), the same rule as Shell ▸ and Balloon ▸. Both
  index tools write ghosts.json's `ghosts` so (`menu_order`; the packs, the manifests and the bundled-balloon rule stay
  in folder-id order), `SiteIndex.load` sorts the index it loads once more (an index an older tool wrote in folder
  order), so Change ghost ▸, Call ghost ▸, the page API's `ghosts()`, `ghostlist` and a page without
  `data-default-ghost` (its first ghost that can run) follow it, and the program's Ghosts list sorts its rows (indexed
  or not) the same way. **No extras** (no site default ghost, no default balloon picker, no hiding, no "update from a
  newer archive" button; adding a ghost whose folder exists asks to replace it).
- **The Python tools keep working:** the add and index logic is ported to JavaScript for the program, and a parity test
  runs both on the same inputs and fails if their outputs differ; a change is made in both.
- **Building:** with Deno ("The program and its builds"). Tests and checks run on scratch copies only ("Project
  rules").
- **No upload of its own** [decision]: Prepare upload makes the upload list (in the order a host that takes files one
  by one needs); the program uploads nothing itself and keeps no FTP upload memory.
- **Wording:** every error, notice, confirmation and refusal of the page (`admin/page/strings.js`) and the console
  (`admin/server/say.mjs`) says what happened, whether the site changed and what to do next, in plain words: no inner
  term of the program (job, token, drop, run folder, journal, worker, API, status codes). One name per thing on every
  screen and in both languages: "the index" (インデックス; "the site's list of ghosts" where it first comes up), "file
  window", the buttons by their own names ("Check the site" 「サイトを確認」). Japanese written as Japanese, not word
  for word. What to do is said once: a text that holds a finding with its own advice does not add its own (the
  settings' site folder that is no site, or that met an unexpected error: `site.errorNotSite`; a page that could not
  start with an unexpected error: `boot.failedInternal`), and one whose usual advice cannot work gets its own (the
  project's own `site/` in a dev run: `site.errorProject`, "choose another site folder", never "choose it again").
  What reaches the page inside a finding's {error} is plain words too (a worker's exit code, "Never silent"; Check's
  `index-old` instead of prune's "run python -I tools/index_site.py", and `control-html` for a control page that does
  not name its script, instead of prune's line ending "run npm run build"), and the program's English fallback texts
  (`admin/server/codes.mjs`: logs, the API's `message`) read as the page's English.
- **The visitor's choice** (the runtime's `data-default-state` and the control page `sumika/index.html`, where
  visitors pick On, Off or Site default: Code "On or off"): the Sharing screen shows the control page's address for
  the Sumika host typed there (sumika.js's folder: `sumika/`; the example host's while none is typed), one sentence on
  it ("On this page each visitor turns Sumika on or off for their own browser; Sumika itself never links to it, so
  link it from your pages."), and a select "When a visitor has not chosen" (Shown / Tucked as her button / Off;
  表示する / ボタンにしまっておく / オフにする) that adds `data-default-state="tucked"` or `"off"` to the script line it
  shows (nothing for Shown), with a hint for the two others; like the host field, not stored (`admin/page/hub.js`
  `scriptUrl().control`, `snippet(url, {defaultState})`, `DEFAULT_STATES`). A site whose runtime has no control page
  (SiteInfo `runtime.control` false: a runtime from before it) gets a line saying so under the address. The Preview
  [decision]: its two test pages keep the line without `data-default-state` (the select is not previewed); the control
  page is the site's own file, so the preview's site address serves it, and the screen links it ("Open the page where
  visitors turn Sumika on or off", when `runtime.control`): it is at the hub's address of the two pages, so a choice
  made there holds for them, and each start is new ports, a visitor who has not chosen. "Open the site" is shown only
  when the site has a page at its top (SiteInfo `front`): the project's own `site/` has none (its test pages are in
  `dev/`), and the preview's site server answers a folder without `index.html` with "Not found".

### The core (`admin/core/`)

- **What it is:** the JS twin of `tools/index_site.py` and `tools/add_ghost.py`, plain ES modules on `node:` built-ins
  (never published). `admin/core/api.mjs` is its API (CONTRACTS "Admin core"): `inspectSource` (what adding each ghost
  of a folder, a folder of ghosts such as SSP's `ghost/`, or a `.nar` / `.zip` would do; nothing written),
  `addGhost`, `removeGhost`, `indexSite`, `indexState`, `checkSite`, `hubFindings` / `hubJsonProblems` (the hub.json
  publish gate, which `tests/build_output.test.mjs` imports), `idProblem`, `proposeId`. Every finding is a code
  (`codes.mjs` `CODES` / `CODE_LIST`, for the page's translations) with params and its English text (what the Python
  tools print); a refusal is an `AdminRefusal` (`{code, params, message, files}`). The core prints nothing: `log` gets
  the Python tools' lines, `onProgress({phase, done, total, item})` the steps (extract, compare, copy, remove, index;
  at most every 100 ms).
- **Reused, not copied:** engine detection (`tools/sweep/views.mjs` `detectEngine`, with a `decodeConfig` hook for
  Python's cp932), SSP's name order and default shell (`src/core/shells.js`), the icon lookup (`trayicon.js`
  `findIcon`), the pack patterns (`engine-files.js`), readme and terms lookup (`src/ui/info.js`), engine notes
  (`supported.js`), the allowlist (`src/hub/allowlist.js`), archives (`tools/sweep/zip.mjs`, with the raw records,
  CRC-32 and a checked read). **Ported to Python's semantics**, because the JS twins differ: text reading
  (`text.mjs`: `read_text`, `read_descript`, `descript_last`, `zip_name`; cp932 from `cp932-table.mjs`, generated by
  `python -I admin/gen_cp932.py` from `engines/common/gen_cp932.py`'s tables), `str.strip` / `splitlines` / `sorted`,
  fnmatch, `repr`, `json.dumps` (`py.mjs`), `os.walk` (`tree.mjs`), the ghosts.json entry (`index.mjs`; views.mjs
  `ghostEntry` has no thumbnails and lists folders from file paths).
- **The shared constants** (`PERSONAL_*`, `KAWARI_SHIPPED_SAVES`, `KAWARI_RECORD`, the pack and thumbnail sets,
  `SKIP_FILES`, `ALWAYS_LISTED`) live in `admin/core/rules.mjs` too: **a change is made in both**;
  `tests/admin/core.test.mjs` imports the Python modules and fails while any differs (the tools' messages name both
  files), or while the Kawari record's bytes or reading differ.
- **From an archive** (the core only): extracted into a new temp folder, then exactly the folder path with the
  archive as `--archive`. Refused, nothing written: a name that leaves the folder (`..`, an empty segment, a drive),
  one Windows would change (`<>:"|?*`, control characters, a trailing dot or space, `CON`/`COM1`…), an encrypted or
  unknown-method member, a size or CRC-32 that differs, a file and a folder of one name. Never written: links,
  `profile/`, saves, logs, DLLs and EXEs, `PERSONAL_PATHS`. Leading slashes are dropped, as `archive_index` drops
  them (BTHver.5's archive holds a record `\`, its own root).
  - **Kawari save-header files** [decision]: in a Kawari ghost added from its own `.nar` / `.zip` they are the
    author's starting files (each one the extraction wrote is a member as the archive holds it: size and CRC-32
    checked), so they are copied (an inspect item's note `note.kawariKept` {paths}) and recorded with their CRC-32
    under the site id in `SITE/sumika/kawari-shipped.json` (`admin/core/shipped.mjs`; `index_site.py`
    `KAWARI_RECORD`, `read_kawari_record`, `set_kawari_record`: the same bytes, json.dumps with a 1-space indent, ids
    and paths sorted, LF, written atomically and only when changed, deleted when empty), which the personal-file check
    of both index tools reads: such a file passes while the record lists it for its ghost with its current CRC-32 (or
    `KAWARI_SHIPPED_SAVES` lists it, mayura's two). An archive packed from someone's own install would carry their
    save as a starting file; the archive the admin adds from is taken as the author's.
  - The record is read alike by both, strictly [decision]: strict UTF-8 with an editor's BOM read past, JSON as
    JSON.parse takes it (json.loads' NaN and Infinity refused; an int too long for Python's int(), over 4,300 digits,
    is JSON.parse's float), `{"format": 1, "ghosts": {id: [[path, CRC-32], …]}}` with every entry so (other keys
    ignored), and no id or path with an escaped lone surrogate, which both JSON readers take and neither tool could
    write again (add_ghost.py would copy the ghost, then fail on the record's write). One that exists and does not
    read is never empty (the next write would drop the other ghosts' entries and the index then refuse their files as
    saves): `index_site.KawariRecordError` / AdminRefusal `kawari.record` {problem: `record.open` | `record.json` |
    `record.format` | `record.entries`}, the same text in both tools ("stopped, nothing changed: … repair it, or
    delete it and add those Kawari ghosts again from their .nar or .zip"), stops every add (add_ghost.py right after
    its source check, the core's inspect and add at the same point: any ghost, since each add sets its entries), a
    removal (before its move) and both index tools; Check (`checkSite`'s `record`) shows it as one problem, never as
    the personal files it would make of the Kawari ghosts' starting files.
  - A write whose write or rename fails deletes its temporary file (`<file>.tmp-<8 hex>`; try/finally in both); one a
    cut-off write left is deleted by `recoverWork` (kind `temp`; shipped.mjs `dropWriteTemps`, hub.json's too), and
    Prepare upload never lists one. Every add sets its ghost's entries (none: its key goes, so a replace from a folder
    drops them); `removeGhost` drops them once the folder is out of `ghost/` (when Windows refuses that write they stay
    and the removal goes on, as after a cut-off one); a replace's swap holds the old and the new entries together, so
    whichever folder a cut-off swap leaves passes the index.
  - From a folder (an installed ghost, also when compared with that archive or an update list) such a ghost is refused
    (`kawari.saveHeader`): the page says it can be added only from its `.nar` / `.zip`, and why; the
    `KAWARI_SHIPPED_SAVES` line stays in the CLI's and `add_ghost.py`'s text only. A Kawari file refused from a folder
    "may be a save made while the ghost ran in SSP" (the program cannot know that it is one). The Python twin is
    `add_ghost.py <extraction> --archive <it> --from-archive` (it needs a `.nar` / `.zip`; it keeps those the archive
    holds as they are, which the comparison checks for every file; `admin/parity.mjs` passes it in its archive
    scenarios).
- **Beyond the Python tools** [decision]: a site id must be one folder name Windows writes as it is (Python takes
  `--id ../x`); a site folder is replaced only with `replace` (the CLI always replaces, as add_ghost.py); links and
  junctions are never followed (a source's link is left out, `removeGhost` and a replace delete a link as a link, and
  Python's `os.walk` enters a junction, so a site or source holding one is outside the parity); `leaveOut` /
  `--skip PATH`, in both tools, leaves a file out of the copy and can never bring a personal one back.
- **Crash-safe writes** (`admin/core/staging.mjs`, JS only [decision]; the Python tools still copy in place, and the
  parity outputs are the same): `addGhost` copies into `SITE/.sumika-admin-work/new-<6 hex>-<id>/` and renames the
  complete copy into `ghost/<id>`; a replace renames the old folder aside first (`old-…`), then the new one in, then
  deletes the old one; `removeGhost` renames `ghost/<id>` aside (`del-…`), then deletes it. Each rename is retried
  (`RETRY_MS`, about 3 s) while Windows refuses it (EPERM / EBUSY: a file held open anywhere inside the folder stops
  it, in Node and Deno alike [measured], as a virus scanner or another program holds one), then refused with what was
  done undone (`work.rename`; `work.undo` when even putting the old folder back failed). `onStep(step, id)` tells the
  journal 'copy' / 'swap' / 'placed' / 'index' before each. `recoverWork(site)` settles leftovers: a `new-` and a
  `del-` entry deleted, an `old-` one put back into `ghost/<id>` while that is missing (cut off between the renames),
  else deleted; a name it never makes is deleted too, a link as a link (the folder is the program's own scratch, and
  Check's "deleted at its next change" must come true: a kept entry would block Prepare upload for good); a link or
  junction in the work folder's own place is one such entry, deleted as a link (followed, it would empty the folder it
  points to); then the temporary files a write of the Kawari record or of hub.json cut off before its rename left
  (`sumika/kawari-shipped.json.tmp-<8 hex>`, either tool's, `sumika/hub.json.tmp-<8 hex>`: kind `temp`; files and
  links only). The work folder is no content: only `ghost/` and `balloon/` are indexed, Prepare upload never lists it,
  `checkSite` reports what is in it (`work`, code `work.leftover`), it is deleted when empty, and
  `tests/build_output.test.mjs` fails while the real `site/` has one.
- **CLI:** `node admin/cli.mjs index [SITE] | add <src> [--id] [--site] [--archive] [--keep …] [--skip …] |
  remove <id> [--site] | check [SITE] | inspect <src> …` (usage in its head; SITE defaults to the project's `site/`,
  as the Python tools' does); status 0, 1 (refused, the message on stderr) or 2 (usage), as the Python tools.
  `node admin/cli.mjs inspect` finds each of the eight Kawari archives of the sweep's folder that ship save-header
  files addable from its archive (brynhild_conf, wakaba `kawari`, the six others `kawari7`; 14 files kept).
- **Pack names** [decision]: Node's zlib (Chromium's "motley" 1.3.2.1) deflates otherwise than Python's zlib 1.3.1: all
  20 real packs differ (and the gzip OS byte, 10 against 255), so no JS port could name packs by their gzip bytes. Both
  tools name a pack by the SHA-1 of its content before gzip and keep a pack file that already holds that content
  (bytes and mtime), whichever zlib wrote it; the JS core writes Python's gzip header (mtime 0, OS byte 255). Safe
  updates hold: one name, one content; nothing records a pack's size or gzip hash (the manifest names it, `TextPack`
  gunzips it, prune compares names), and the same site gives the same pack names on any OS and zlib. A site an older
  tool indexed (packs named by their gzip bytes, ghosts in folder order) reads as a stale index at its first Check;
  "Update the index" renames the packs once and writes the ghosts in name order. `tests/runtime/index_versions.test.mjs`
  accepts both pack rules on the real site, the new one only on scratch sites.
- **Parity:** `tests/admin/parity.test.mjs` (in `npm test`, about 25 s: the fixtures, an SSP layout with a moved
  balloon, synthetic archives with CP932 names, every refusal kind, `--keep` / `--skip`, a replace, a removal, a
  Kawari ghost's archive with its record, that record with a BOM and not readable) and `npm run parity`
  (`admin/parity.mjs [--work DIR] [--ssp DIR] [--all-archives | --only REGEX] [--keep-work]`: adds a copy of the real
  site, an SSP install's tsubasa, emily4 and BTHver.5 with their update lists, six archives of its download folder
  (`--ssp`: a local SSP install, development material; without it those scenarios are skipped, and on a site without
  ghosts the removal takes a fixture ghost); about 10 minutes; `--all-archives` takes every archive there and indexes all the ghosts added together, about 25 minutes;
  `--only` re-runs matching archives alone; writes `report.json`). Each scenario runs both tools into their own copies
  and compares every file byte for byte (a pack by name and gunzipped content), the exit statuses and everything
  printed (site paths and gzip sizes aside). Python runs with `-X utf8` there: into a pipe it writes the ANSI code
  page and fails on a Japanese name, where a console gets Unicode (`-I` ignores PYTHONIOENCODING). Give `--work` a
  short folder: the Python tools fail on Windows paths over 260 characters. Expected [measured]: the default run 18 of
  18 the same; `--all-archives` 0 different (308 archives added alike, 3 hold no ghost), the ghosts indexed together
  the same, 1,187 packs compared by content; the 8 Kawari archives that ship save-header files (`--only` them) 8 of 8
  the same, `sumika/kawari-shipped.json` byte for byte. A scenario's sites carry the base's record too, and the remove
  scenario's Python side drops the ghost's entries as well (`set_kawari_record`).

### The program and its builds (`admin/server/`, `admin/build.mjs`)

- **Run from source** (dev; the page is built in-process from `admin/page/`): `node admin/server/main.mjs --no-browser
  --settings <scratch>/settings.json --temp <scratch>/temp`, then open the `http://127.0.0.1:<port>/?key=…` line it
  prints (always pass `--settings` and `--temp` under a scratch folder; a dev run refuses the project's `site/` as a
  site). The API, the guards and every shape are CONTRACTS "Admin API"; the page alone: `node admin/build.mjs --page`
  (→ `admin/build/page.gen.mjs`).
- **Build:** `node admin/build.mjs [--target windows-x64,macos-arm64,macos-x64,linux-x64|all] [--no-smoke]` (about 1
  minute for all four with the smoke). Offline: Deno 2.9.7's `deno.exe` and the four `denort` runtimes are pinned in
  `admin/pins.json` (each archive's URL, size and SHA-256; the archives themselves sit in `toolchain/deno-2.9.7/`,
  which is not in the repository: docs/building.md "What the builds need"), unpacked into `admin/build/deno-2.9.7/`, and
  `deno compile` gets `DENORT_BIN`, so it never downloads; a missing or different archive stops the build with the
  URL to fetch it from. It writes `admin/build/`
  (generated: the page, the bundles `sumika-admin.mjs`, `job.mjs` and `pickwin.mjs` (the two workers, embedded with
  `--include`), the unpacked runtimes, about 410 MB) and `admin/dist/<version>/` (`sumika-admin.exe`, about 80 MB,
  `sumika-admin-macos-arm64`, `-macos-x64`, `-linux-x64`, a `.zip` of each non-Windows program with mode 0755,
  `SHA256SUMS.txt`; about 410 MB, and an older version's folder stays until deleted by hand); version =
  `package.json`'s + the server bundle's `nameHash` (the page is in that bundle), e.g. `1.0.0-<10 hex>`. Never under
  `site/`; never published, never committed (a release may attach the programs). Unsigned [decision].
  - The smoke runs `admin/server/drive.mjs`'s e2e steps against the built `sumika-admin.exe` (with piped stdio, then
    again started in a real hidden console: PowerShell `Start-Process -WindowStyle Hidden -PassThru`, the address from
    `<temp>/instance.json`) and a Node run on the same inputs and compares their indexes (ghosts.json and manifests
    byte for byte; packs by name and content: Deno's gzip bytes differ). Every API call of the steps has a 45 s limit;
    in the console run a step that gets no answer fails with that console's text, read by `admin/readcon.mjs` (a Deno
    FFI script run with the pinned `deno.exe`: FreeConsole, AttachConsole, ReadConsoleOutputCharacterW). The steps
    also check that nothing was written to `sumika-admin.log`. The console run is the one that catches a program
    waiting at a console prompt ("The freeze": "POST /api/index: no answer within 45000 ms", the console showing
    Deno's prompt).
- **The freeze** [measured, Deno 2.9.7]: `new Worker()` from `node:worker_threads` copies `process.env` into the worker
  by default, which Deno's polyfill does by listing every variable (`Object.keys(process.env)` →
  `Deno.env.toObject()`); the program may read only the eight variables of `--allow-env`, so Deno asks "Deno requests
  env access … Allow? [y/n/A]" in the console window, and the whole program (server included) waits there for an
  answer. With stdin not a terminal (every test, a piped smoke) Deno denies at once and the polyfill goes on, so no
  piped run sees it. So, twice over: the job worker gets `env: {}` (it reads no variable; the server passes `tempDir`),
  and the programs are compiled with `--no-prompt` (`permissions()`; an access the flags lack throws instead: a probe
  compiled with it threw `NotCapable` in a hidden console, one without waited). A 75-job stress run with piped stdin
  never failed.
- **Never silent** [decision]: after the start lines the console gets nothing until the stop lines (a console in
  QuickEdit selection blocks whoever writes to it). An error nothing caught goes to `<temp root>/sumika-admin.log` with
  its stack and the program keeps serving (`admin/server/log.mjs` `catchStray`: Deno's globalThis `error` /
  `unhandledrejection` with `preventDefault` in the compiled program, `process.on` under Node); so does a job that ends
  `job-crashed` or `job-failed` and a route that answers 500 `internal` (their stack never in the API; not a job the
  closing program stops), what a start found of an earlier one's cut-off job, a file dialog that could not be shown,
  and a journal write that gave up (`writeJournal`; the job worker's steps write to the log beside the journal
  themselves). The page gets plain words for what only the log names: a job's worker that ended without an answer is
  `job-crashed` {exit} ("It stopped because of an unexpected error (code 1)…"), a dialog's worker `no-picker` {exit};
  the log keeps "the job's worker exited (1)". Past 1 MB the log becomes `sumika-admin.log.old`.
- **A cut-off job** (the journal `job.json`, `admin/server/instance.mjs`): written at a job's start with the job's id,
  kind, label, site and ghosts; the job worker itself writes each step before it begins (`journalSteps`: a message to
  the main thread could arrive after a closed window ended both); deleted at the end, retried while Windows refuses
  (a scanner holding the new file), else overwritten in place with an ended mark the next start ignores, so a job that
  ended is never reported.
  - A start serves first (the server, `instance.json`, the console lines, the browser), then tidies up in the job
    worker: the run folders of dead starts (a cut-off inspect's or add's extraction) and the work folder of the
    journal's site and of the chosen site (`recoverWork`; every write job does it first too). Tidying up first would
    leave the window blank for seconds after a big cut-off job (2.1 s for 5,000 files, 10.8 s for 20,000 [measured]),
    and a second start meanwhile would find no `instance.json` and start a second program; serving first, a dev start
    answers hello in about 0.1 s while 5,000 or 20,000 leftover files (and 1,000 in a dead run folder) are deleted (6 s
    and 17 s, hello asked every 20 ms).
  - A job asked for meanwhile waits in phase `settle` ("Checking the site: first tidying up what was left when
    sumika-admin last closed") and writes its journal when it begins (`Jobs.hold`); the old journal is deleted only
    once settled, so a start closed meanwhile leaves it for the next (and settles no further site, which the next
    would misread); hello and status say `starting`, and the page shows "sumika-admin is first tidying up what was
    left when it last closed…" until status says it is done, then asks hello again for the notice.
  - Then the start says per outcome (`admin/server/outcome.mjs`; hello's `interrupted`): `unchanged` (a read-only job,
    or a write job cut off before anything visible changed: "Last time sumika-admin closed while it was still reading
    what you had picked to add (pit). Nothing on your site was changed: to go on, pick it again.", with Dismiss),
    `index` (ghost folders are final, the index not rewritten: one button, Finish adding / Finish removing / Update the
    index), `prepare` (Prepare the upload again) or `unknown` (an older start's journal without steps, a site that
    cannot be read now: "… so your site may be partly changed. Press Check the site to see what is left to fix.", Check
    the site; a kind the page does not know, with a label or not, gets the text that cannot tell what it was, never
    "Working (label)"); ghosts by name. The notice goes when a job settles it (any job for `unchanged`; one running at
    the page's hello too); Dismiss is remembered by the tab (sessionStorage `sumika-admin-dismissed`,
    `admin/page/interrupted.js`), so a reload does not bring it back.
- **No answer is no stopped program** (the page's side, `admin/page/api.js` [decision]): a fetch that fails, or a
  status (or hello) call unanswered for 10 s (`STATUS_MS`: a stuck program answers nothing), makes the API client ask
  GET /api/status (`PROBE_MS` 5 s each, `BACKOFF_MS` 0.5, 1, 2 s apart) with the line "Waiting for sumika-admin to
  answer…"; after 20 s (`WAIT_MS`) the stopped state: a banner says it may be closed or stuck ("If its window is
  closed, start sumika-admin again: it opens a new tab. If the window is still open, wait: this page goes on by
  itself…"), the page is inert (an open Remove dialog closed as by Cancel), and the client asks every 3 s (`RETRY_MS`)
  for as long as the tab is open. When the program answers with this tab's key, every call that lost its answer goes
  on: a read (and an idempotent write: settings, site, hub save, Quit) is sent again; a job start is looked for in the
  status (a job of its kind that started since it was sent, within `START_SLACK_MS` 1 s: its answer; another kind
  since: `job-replaced`, never sent again; none since: it never arrived, sent again), so no job runs twice; a preview
  start takes the status's preview; a dropped file whose second send answers `drop-exists` arrived whole (a body cut
  off on the way fails the program's read, so `drops.mjs` deletes the drop and the second send answers
  `drop-missing`: Node and Deno 2.9.7 alike [measured]); a file dialog whose second pick answers `picker-open` {id} is
  that dialog (`{open, id}`, waited out). A call that fails `MAX_SENDS` (3) times while the program answers between is
  said (`not-sent`, e.g. a dropped file changed on disk). A 403 ends it ("sumika-admin was started again
  after this tab was opened, so this tab no longer works…"); Quit ends it (`api.end()`). Stop sending ends a drop at
  once, a wait included (`sendDrop`: no file and no inspection after it; its cancel goes when the program answers).
  `tests/admin/page.test.mjs` tests it with fake timers.
- **The file dialogs** (`admin/server/picker.mjs`, `pickwin.mjs`, the page's `admin/page/picker.js`; CONTRACTS "Admin
  API" File dialogs): the program opens the system's dialog, since it needs full paths, which no `<input type=file>`
  gives. Purposes `files` (several `.nar` / `.zip`), `folders` (several: ghost folders, folders of ghosts), `site`,
  `compare` (an archive or update list); each opens where it last picked (`lastFolders` in `sumika-admin.json`), the
  site dialog beside the current site; titles in the page's language. The Add screen: "Choose .nar / .zip files…" and
  "Choose folders…" (what is picked is inspected at once), the drop zone under them, "Browse in this page instead";
  while a dialog is open the buttons wait and a line says it may be behind the browser window, with Cancel, on every
  screen whose buttons wait; one another tab (or the page before a reload) opened is waited on through the 409's `id`
  (`Picker.watch`), so its closing frees the buttons, and hello and status name the open dialog (`pick` {id,
  purpose}), so a reloaded page or another tab shows that line and Cancel at once, before any button is pressed
  (`Picker.seen`); the open mark goes with the dialog whatever fails after it (a failure to remember `lastFolders` is
  logged, the paths are still the answer); no dialog opens while a job runs (the inspection or site choice after it
  would be refused `busy`; said first, as for a drop). The Site screen's "Choose the site folder…" and a ghost's
  "Choose the archive or update list…" open theirs; no dialog (hello's `picker` false, or a pick answered
  `no-picker`): the in-page browser.
  - **Windows** (`pickwin.mjs`, Deno only): IFileOpenDialog by hand through Deno FFI (CoCreateInstance, vtable slots
    from shobjidl_core.h, `UnsafeFnPointer` with the object first), in a `node:worker_threads` worker of its own made
    with `env: {}` (Show() blocks its thread; the server answers meanwhile). In front of the browser: the dialog's owner
    is a hidden `WS_EX_TOPMOST` popup over the browser's window, so the dialog is above it, and the worker borrows the
    foreground thread's input (`AttachThreadInput`) for one `SetForegroundWindow`, so it gets the keyboard; the browser
    gets the foreground back after. Cancel and Quit post `WM_CLOSE` to the dialog's `#32770` windows from the server's
    thread (EnumThreadWindows); a dialog not closed within 5 s is given up (its worker stays blocked; the next pick gets
    a new one). An answer is held 25 s, then `{open, id}` and `/api/pick/wait`: Firefox drops a request with no answer
    after 300 s (`network.http.response.timeout`) [infer].
  - **Measured** (Deno 2.9.7, `deno run`; 15 openings by a harness, the first five with Firefox in front, the rest
    with the screen locked, each dialog closed by a second process within about 1 s: WM_SETTEXT into the name box and
    IDOK, or WM_CLOSE): above Firefox and with the keyboard, which went back to Firefox after; centred on the browser
    once the owner window was placed so (the dialog opens at its hidden owner's top-left corner: `ownerPlace`;
    960 × 600 at 120 dpi); titles in Japanese and English; two files from a typed `"a.nar" "b.zip"`; WM_CLOSE and the
    program's own cancel → `{canceled}` (about 55 ms); a cancel before Show opens nothing; through the program: status
    answered in 4 ms while a dialog was open, a second pick 409, the 25 s cap, the comparison opened in its
    `lastFolders` folder, `/api/pick/cancel` closed one, Quit with one open ended the program and the dialog. Three
    findings, fixed: `--allow-ffi=<the four DLLs>` lets `dlopen` through but refuses `UnsafePointer.create` ("Requires
    ffi access"), so windows-x64 gets a whole `--allow-ffi`; with the lock screen in front, a dialog whose thread had
    borrowed LockApp's input took no posted message (no OK, no WM_CLOSE), and without that step it answered, so no UWP
    window's input is borrowed (`NO_BORROW`); the worker's exit after its answer turned the picker off for the rest of
    the run (`windowsPicker`'s `fail`). In folder mode a path typed into the name box returns the folder on show, not
    the typed one (a limit of typing, not of the code: GetResults returned the two files). The compiled program says
    `picker: true` in hello, and a probe compiled with its permissions (`--allow-ffi`, `--no-prompt`) and the build's
    `pickwin.mjs` embedded the same way, cancelled before Show, loaded the DLLs, made the dialog and its hidden owner
    and answered `{canceled}` (about 0.2 s, 3 of 3, no window shown). The dialogs are in Japanese for a Japanese page,
    centred on the foreground window, above it and with the keyboard, the foreground given back after; one file by
    full path, two files at once, the next files dialog in the last folder, and folders picked as a person picks them
    (two highlighted, then OK: both returned) were seen in the compiled program, closed by a second process.
  - **macOS** (`osascript`, choose file / choose folder, the title and folder as arguments; -128 is Cancel) and
    **Linux** (`zenity`, else `kdialog`; exit 1 is Cancel): untested on real machines; any failure answers `no-picker`
    and the page falls back. A cancel holds for the whole pick: one between the two programs (zenity found missing,
    kdialog not started) keeps kdialog from opening, one before a child is there kills it as it comes.
    `--allow-run=open,osascript` / `xdg-open,zenity,kdialog`.
  - **Node runs** (dev, tests): no dialog (`no-picker`) unless `--fake-picker FILE` (a JSON object: per purpose a list
    of paths, `"canceled"`, `"open"` until cancelled, `"no-picker"`; `"delayMs"`), which drives the page's flows in a
    browser; the compiled program refuses the flag.
- **Prepare upload and its record** (`admin/server/upload.mjs`, the page's `screens/check.js`; CONTRACTS "Admin API"
  prepare [decision]): Check first, then `tools/prune.mjs` on the site, its ledger `<site>.published.json` beside the
  folder (never uploaded). No ledger: the first-upload question (`needs-first`; "first upload" = `--first`, "record
  lost" = `--retire-all`). A ledger that exists and does not read (prune's `bad-ledger`: no JSON, not a format 1
  ledger, not openable) is `ledger-unreadable` {ledger, days}: what the file is (the record of what was uploaded
  before, kept beside the site folder so it is never uploaded), that it cannot be read, that nothing changed, and one
  button, "Start a new record" (`newRecord`): once Check passes, the program renames the file aside
  (`<ledger>.broken-<YYYY-MM-DD>`, then `-2`, `-3` …, never over a file) and runs prune as for a lost ledger
  (`retireAll`: nothing deleted now, every old file kept `RETAIN_DAYS`, 14, more days); the answer's `setAside` names
  the file, and the page says where it is. A ledger that reads by then (repaired, or another tab's Start a new record
  came first) is `ledger-reads`, in words of its own (never set aside), none at all is a lost one; prune refusing
  after the rename puts the file back. Prune's CLI says to delete a ledger that is no JSON before `--retire-all`
  (which refuses while a ledger exists). Known window: a run cut off between the rename and prune's write leaves no
  ledger, so the next Prepare upload asks the first-upload question, whose answer then is "record lost". Never
  listed: the Kawari record's temporary files ("The core").
- **Tests** (in `npm test`): `tests/admin/server.test.mjs` (the handler, no sockets; the journal, the next start's
  outcomes, the log, the worker's empty environment; and one in-process `start()` on a real 127.0.0.1 port whose
  settling is held: it serves, writes `instance.json` and lets a job wait before it settles), `picker.test.mjs` (the
  file dialogs with no dialog on screen: the endpoint on a fake, `--fake-picker`, the Windows worker protocol on a
  stand-in Worker, the macOS and Linux programs' arguments, the Windows layouts), `staging.test.mjs` (the core's
  moves, refusals and undo, `recoverWork`), `preview.test.mjs` (the three preview servers), `e2e.test.mjs` (`node
  admin/server/main.mjs` as a child, the same steps as the smoke), `page.test.mjs` (the page's modules without a DOM:
  the drop, the API client's wait for the program on fake timers, the dialogs' flows, the cut-off notice, the bundle)
  and `strings.test.mjs` (every key and code in both languages), all on scratch folders under the OS temp folder.
- **Known limit** [measured, Deno 2.9.7]: closing the console window of the compiled program ends it before its
  cleanup runs (Deno's console handler returns at once and Windows then ends the process: exit 0xC000013A), so its
  run folder and `instance.json` stay in `%TEMP%\sumika-admin\` until the next start, which deletes them and says what
  a job that was running did (above: per outcome, with the one thing to do); Ctrl+C and Quit clean up at once. A Node
  dev run cleans up at a window close too.

## Features by area

What runs and how it follows ssp.exe, by area; what does not is under "Known gaps".

### Engines

Satori, YAYA, Kawari and Kawari 7 run (`docs/research/satori-wasm.md`, `yaya-wasm.md`, `kawari-wasm.md`,
`kawari7-wasm.md`).
- YAYA Tc606-2 runs YAYA and AYA5 ghosts: 24 of the 26 the sweep runs boot. A page change is not a boot (resume), what
  a ghost writes in its own folder stays in the visitor's browser (deletions too), and it sees the site's ghosts as an
  SSP install shows them.
- Kawari 8.2.8 runs the 18 Phase 8 ghosts of the sweep's folder (all 18 load and answer the boot events;
  ghost-sweep.md "Kawari run K1", "K3") in the same SSP-shaped file system. A page change restores a snapshot of the
  dictionary entries the session changed and of every entry the ghost's load made (not by a dictionary definition or a
  `function` body), changed or not: without those, KEEPS' `cntwork` would restart on every page and machimaki's
  hourly talk would never come while pages change more often than once an hour (kawari-wasm.md §8). The snapshot's
  first line is `# dicStamp` [decision].
- **D6** [decision] (kawari-wasm.md §8, shiori-events.md §2.3.1): a Kawari cold boot after a tab closed without Close
  first closes the old session as ssp.exe 2.9.10 closes ghosts when Windows ends the session (`WM_ENDSESSION` →
  `ForceQuitApplication(L"system", 0, 0)` [disasm]): after the restore, GET OnCloseAll [`system`, `0`, `0`] BaseID
  OnClose, OnClose on its 204, OnTranslate on the goodbye, every reply dropped, then OnUnload. Both run at the time the
  tab was closed (the ghost state's `savedAt`), as ssp.exe runs them inside `WM_ENDSESSION`, so bthver.5 counts the
  real time away and machimaki back after 40 days says its long-time-no-see talk. A link to another page is a resume,
  not a cold boot, so D6 never runs there. [measured] (runs K4 and K5 in ghost-sweep.md): 12 of the 14 corpus ghosts
  that lost such a session keep it (the BTH family, honue090104, rotten101010, toxic060816 and 6 Phase 7 KEEPS
  ghosts), and so does the tested bthver.5; somberlain and maria_re save nothing when they close (in SSP too); KEEPS
  ghosts do not say "you crashed last time" after a closed tab (after a killed SSP they still do, as in SSP); the close
  costs 1–11 ms. With `?sumika-debug` it logs `kawari: closed from outside: …` and `kawari: closed at the session's
  end, N min before this boot`. Pinned by `tests/kawari_engine.test.mjs` and `tests/kawari7_engine.test.mjs`
  (OnClose-saving and time-stamping variants of the fixtures).
- One best-fit encoder serves every UTF-8 → 932 edge [decision] (ssp.exe uses `WideCharToMultiByte(932, 0)`: the
  Kawari research R1, kawari-wasm.md §3); the other ghosts' descript.txt in a Kawari ghost's view go through it too,
  which SSP never does.
- Kawari 7.5.0 runs the 8 Phase 7 ghosts (`kawari.ini`, SHIORI/2.x; engine `kawari7`) through the SHIORI/2 bridge:
  all 8 load, play their first boot and resume (kawari7-wasm.md §7). gleto ships a 7.0.0 DLL, for which ssp.exe
  rewrites every request ("kawari 7.0 compatible mode": `Sender: embryo`, no SecurityLevel); with 7.5.0 it would not,
  and Sumika does not [decision] (kawari7-wasm.md §9).
- The tested ghosts per engine: "The ghosts Sumika was tested with". bthver.5 called from Katari boots on Kawari (first boot,
  `\![change,shell]`, its balloon); a page change resumes it without OnBoot and keeps its `Mode`.

### Several ghosts

`shiori-events.md` §2.7, `ssp-ui.md` §2.6, §2.12, §3.5, §9.1, §9.5, §9.7 (every [decision] and [guess] tagged there);
seams in `CONTRACTS.md` "Site"; `multi.test.mjs`.
- Any number on screen, as in SSP (a site may cap it with `data-max-ghosts`). Call ghost ▸,
  `\![call,ghost,X(,--option=raise-event)]`, `window.sumika.callGhost(id)`: OnGhostCalling, OnGhostCalled (204 →
  OnBoot; OnFirstBoot for a ghost never met), then OnGhostCallComplete / OnOtherGhostBooted after the callee's boot
  talk; `otherghostname` with real References, re-sent on every set change. Close of one: OnClose, gone at `\-`,
  OnOtherGhostClosed to the rest. Quit (= Close of the last): OnCloseAll to all at once, each closes at its goodbye's
  end (`\-` or not; amends SUM C22); a minimized or locked one (`\t`, passive, induction) gets the same events, its
  reply dropped, and closes at once, on Close of one too [disasm, EV §2.3]; the closed launcher appears once every
  ghost has unloaded and calls the whole set back. Change ghost ▸ in one slot (OnOtherGhostChanged), OnOtherGhostTalk.
- Placement as ssp.exe (`ssp-ui.md` §3.2, §3.3, §3.5): no rule between ghosts; a booting ghost (call, change, a set's
  start) stands at its own stored places (every scope), else at its own default place (`\0` bottom-right, the next
  scope flush against the one below, no balloon gap), so a ghost never met stands on a caller at its default
  (observations of ssp.exe differ: "Known gaps"); a window that misses the desk comes back as SSP's ClampToWorkRect
  brings it; Reset shell position moves a scope hidden by `\s[-1]` too and forgets the places only up to the highest
  scope that has a window (UI §3.2).
- One layer per ghost (z-order by activation), one ghost with the keys, a launcher dock. The set (`ghosts`, `rev`) is
  stored site-wide; the tab marker carries a call, a change or a Quit to the next page; a resumed set comes back at
  once, a cold one ghost at a time. Tabs: `sumika/lead` runs the set in one tab, all or nothing; the others show it
  frozen, follow it and take it over, but change nothing (their page-API calls and changes answer false); a takeover
  waits for a start, call, change or Quit. After Quit the page API brings one ghost back alone, cold.
- **Ghosts interacting** (EV §2.7.7–§2.7.9, every [decision] there; seams in CONTRACTS.md;
  `tests/runtime/interact.test.mjs`, end to end on `multi_world.mjs`):
  - Ghost-to-ghost talk (COMMUNICATE): a reply that names another ghost (`To` / `Reference0`: Satori's `→` lines and
    `＄Value0`; `__SYSTEM_ALL_GHOST__`; matched by sakura name as SSP) goes to it as GET OnCommunicate once its script
    has played unbroken, and that ghost's reply can answer back: no cap, as SSP. A talk still playing when a link is
    followed goes on the next page, once.
  - Satori ghosts see the others through an FMO stand-in (`（FMOn…）`, `（Xの存在）`, `（Xのサーフェス）`; patch P8,
    `satori-wasm.md` §8): the reader, then the others in slot order [decision].
  - `\![raiseother]` / `\![notifyother]` and their timer forms, with OnRaiseOtherFailure / OnNotifyOtherFailure back;
    one queue per page, which waits only for the ghosts up, each at most 30 s (`Site.upWaitMs` [decision]: a resumed
    ghost whose load stalls is no target until it is up; talks wait the same way). The four timer tags follow SSP's
    ParseBool, the 50 ms floor and one key per event (amends SUM C3); a repeating one with a target fires again only
    when its last raise is done, as SSP's in-callback raise.
  - otherghostname is re-sent as SSP does: to every ghost, the new one too, after each cold boot's boot GET, and after
    a shell change (EV §2.7.5). On a resumed page a ghost whose loop is not up yet is listed by the names in effect its
    state stored (`names`), so a shell's `sakura.name` stays the name the others aim at.
  - A ghost's reply to another ghost (OnCommunicate, a raised event) cuts whatever the partner is saying, even its
    goodbye or a choice menu, as SSP does [observed]. Only OnCommunicate reaches a `\t` script; a raise is refused
    there (`timecritical`; also passive, induction, minimized), as SSP (EV §2.7.9 C4).
  - OnOtherGhostTalk follows SSP's guard: "before" is not sent for a reply to OnOtherGhostTalk, "after" is, so two
    ghosts that both answer every OnOtherGhostTalk chat on.

### Ghost, shell and balloon changes; reloads

- **Ghosts** (`shiori-events.md` §2.5, `ssp-ui.md` §2.1 #12 and §9.5): the main menu's Change ghost ▸,
  `\![change,ghost,name|random|sequential(,--option=raise-event)]`, `\+`, `\_+`, `window.sumika.changeGhost(id)`;
  OnGhostChanging (→ OnClose) with a balloon break to cancel, OnDestroy and unload, then OnGhostChanged (→ OnBoot; a
  ghost never met gets OnFirstBoot). OnGhostChanging follows ssp.exe 2.9.10: R1 `automatic` for a script's
  raise-event, no BaseID, the 204 fallback OnClose with R0 `user` alone. A change to the running ghost itself (its own
  row in Change ghost ▸ is checked and enabled, or a script names it) reloads it the same way, OnGhostChanging and
  OnGhostChanged naming itself, as ssp.exe 2.9.10 [disasm] (Tsubasa: "Wait, that's me!?" … "did something change?").
  Per-ghost memory and state; the tab marker and the stored set follow, also when a link is followed mid-change (the
  marker's `carry`); other tabs follow over the `sumika/runtime` BroadcastChannel, and takeovers wait for the change's
  end; a failed boot brings the old ghost back. During the goodbye, clicks still get replies (the change waits for
  quiet), but no menu, Close or Iconify.
- **Shells and balloons** (`shiori-events.md` §2.6, `balloon-format.md` §12, `shell-format.md` §4.3.3): Shell ▸,
  Balloon ▸, `\![change,shell|balloon,name|random|sequential(,--option=raise-event)]`, `window.sumika.shells()`,
  `balloons()`, `changeShell()`, `changeBalloon()`. A shell change keeps the engine running: OnShellChanging (a
  balloon break or a reply that replaces its talk cancels), the stage swapped under the event loop (places kept,
  balloons closed, open boxes placed again once the new character has a size, the new shell's own dress-up from the
  per-shell memory and the balloon it would boot with, silently), the NOTIFYs (SelfInfo, ShellInfo, DressupInfo,
  installedshellname), then OnShellChanged (204: the old surface ids come back). While the stage is swapped the loop
  is `swapping`: cantalk 0, ticks as NOTIFY, replies held (keys, boxes, raises; a held raise reply is dropped once a
  later run started, as outside a swap [decision]) or dropped (ticks, timeouts) until OnShellChanged's has started,
  and a script still talking (OnShellChanging answered 204) is held until the swap ends, then goes on on the new
  stage [infer]. A script's own `\![change,shell]` swaps at the tag and its OnShellChanged reply waits for the
  script's end [guess]. A script's change asked while another change runs (333-4.05's revert inside OnShellChanged's
  reply, a boot script after Change ghost ▸) waits for it and then runs, at most 4 in a row; the menu's and the page
  API's are refused, and so is a script's shell or balloon change after its own `\![change,ghost]` (the ghost change
  goes first, at the script's end, queued or not [decision]). A balloon change re-skins open balloons and boxes in
  place (text, choices and scroll position kept), then OnBalloonChange. The choice persists (`shellChosen`: a ghost
  whose visitor never picked a shell boots its default one, as in SSP); a page left (or a takeover) mid-swap comes
  back on the new shell with the old surfaces (`shellSwap`, carried into a queued swap when the reply showed nothing
  first, as 333-4.05's does [decision]); a frozen tab of the same ghost redraws with the new shell. Shell names (not
  folder ids) go to OnBoot, OnFirstBoot R7, OnNotifySelfInfo and the rest. Test ghosts: `katari` and `roommate` have
  two shells (Katari switches from her own menu), `etherism` its own balloon; the ghost sweep switches Katari,
  souzou_syoka and tok_2 through their own `\![change,shell]`; the unit tests use the synthetic two-shell
  `tests/fixtures/ghost/testghost`.
- **Reloads** (`shiori-events.md` §2.10, read in ssp.exe 2.9.10's disassembly): `\![reload,shiori]` (OnDestroy
  `reload`, the engine unloads and loads again from its stored files in the client's queue, then the load's NOTIFY
  batch with OnInitialize `reload`; no boot event; the script waits at the tag; bee, mobilemaster and ria reload in
  the sweep), `\![reload,shell]` / `\![reloadsurface]` and `\![reload,balloon]` (the shell or balloon in use swapped
  again through the change paths, no OnShellChanging / OnShellChanged / OnBalloonChange), and `\![reload,ghost]` (a
  change to itself without OnGhostChanging or OnClose, a cold boot without a boot event; kuruka switches its
  characters this way). [decision]s: only the word `reload`; no IsSafeScript gate; a reloaded shell is no pick
  (`shellChosen` kept); a page left mid-reload resumes the ghost; a SHIORI load that fails restarts the engine as a
  crash. `\![reload,makoto|descript|aigraph]` and `\![load|unload,shiori]` stay no-ops.

### Menus and boxes

SSP's main menu (`ssp-ui.md` §2, §2.11) is complete except for the items under "Known gaps", in SSP's order:
Recommendations / Portal (greyed when empty), the scalings, Utilities ▸ (Reset passive mode only with
`?sumika-debug`), Options ▸ Preferences… (below), Change ghost ▸, Call ghost ▸, Shell ▸, Clothes/Dressup ▸, Balloon ▸,
Information ▸ (the readme window with the ghost's, shell's and balloon's readme, Terms, About Sumika), Language ▸,
Iconify, Move character window (no mouse or key events reach the ghost while she is carried), Close (that ghost), Quit
(every ghost). The abbreviated menu has Clothes/Dressup ▸, Move character window and Quit. `*.visible` 0 greys an item
(Other percentage… too); legacy caption names are asked first; passive mode and the like grey the items SSP greys
(enable levels; Call ghost ▸ is not greyed by them [disasm, tentative]). Submenus nest.
- **Clothes/Dressup ▸**: SSP's labels `category - part`, file order, the mustselect rule; picks reach the ghost at once
  with R4 `user`, after the playing script's binds so far; a pick that changes nothing still sends
  OnNotifyDressupInfo; DSLGS's large menu and duplicated マフラー/黄色 work: a named `\![bind]` reaches the listed group.
- **Iconify**: the launcher button shows her tray icon as ssp.exe picks it (UI §2.6): `icon.minimize`, else a
  script's `\![set,trayicon]` icon, else `icon` (`ghosts.json`, `src/core/trayicon.js`); none: her initial letter,
  standing in for SSP's own bow-and-bell icon, which exists only inside ssp.exe [decision]. The size is
  16 × ⌊2 × dpr⌋ device px (25.6 CSS px at 125 %); 16-px icons are pixel art on the white button, BMP icons (katari's,
  nato's) opaque squares as in SSP (mayura's is her 32-px hexagram, Tsubasa's her `tsubasa.ico`); the closed "Call X"
  button shows her normal icon; no tooltip or animation [decision].
- **Shell scaling ▸ and Balloon scaling ▸** (`ssp-ui.md` §2.9, `src/core/scaling.js`): device-pixel percentages, per
  ghost in its state, OnShellScaling / OnBalloonScaling. Compared with ssp.exe: no difference seen [observed]; the
  [guess] lines in §2.9 were not checked one by one.
- **Language ▸** (`ssp-ui.md` §2.10): Japanese / English / Use System Lang., site-wide in the runtime prefs, SSP's own
  Japanese and English captions, OnLanguageChange (NOTIFY at boot, GET on a change). The marks match ssp.exe (bullet on
  the language in effect, a check on Use System Lang.) [observed]; it applies at once here, where SSPHELP says SSP
  applies it after a restart [decision].
- **Options ▸** holds only Preferences… (right after Utilities ▸, SSP's MENU 102 captions; `configurationrootbutton.*`
  / `configurationbutton.*`) [decision]: the Preferences box (`ssp-ui.md` §2.13, `src/ui/settings.js`, the Site's),
  titled "Preferences" / "設定" (SSP's without "SSP:"), with SSP's four user fields (Name, Nickname, Birthday, Sex),
  stored only in the visitor's browser (`src/core/user.js`) and sent only to the ghosts on the page [decision]. Scripts
  open it with `\![open,con…]` (no page, `setup` or an unknown word; SSP's other 15 page types, such as `biff` from
  Katari and Nato, `ghost`, `talk`, `display`, `application`, open nothing, logged once [decision]). Closing it after
  an edit sends OnNotifyUserInfo to every ghost up (EV §4.16); none is sent until the visitor has saved the box once
  [decision]. A script's open while the visitor types in a field of the page takes no focus (the box pulses instead),
  so those keys never land in Name. On phones it stays above the on-screen keyboard, its fields 16 px (`ssp-ui.md`
  §9.11).
- **Thumbnails** (`ssp-ui.md` §2.14, `src/ui/thumbnail.js`): 350 ms after an enabled row of Change ghost ▸ / Call
  ghost ▸ / Shell ▸ / Balloon ▸, a dress-up part or a Recommendations ▸ / Portal site ▸ banner is selected, its
  thumbnail shows at the bottom of the viewport, 10 device px in, on the left unless the pointer is in the left half
  (ssp.exe decides by the pointer, not the ghost), at most half the viewport each way; a `.pnr` keys out its top-left
  colour; another row, a greyed one or closing the menu hides it. Ghosts: `thumbnail*.*` at random, the ghost folder's,
  else `ghost/master/`'s; shells and balloons: their own folder's (`ghosts.json` `thumbnails` on ghosts, `shells`,
  `bundledBalloons`, `balloons`); parts: the bind group's name in the current shell, any extension; banners:
  `ghost/master/banner/`, else an http(s) banner from the web (an `<img>`, no referrer [decision]). None of the tested
  ghosts has parts or banners, so those are covered by the Node tests only.
- **Which menu a right-click opens** follows ssp.exe 2.9.10 (`ssp-ui.md` §2.1 Notes, `askMenu`): the clicked
  character's `popupmenu.visible` (ParseBool) and `popupmenu.type` (a character: `kero.popupmenu.type` 0 gives `\1` the
  main menu) are asked first, then that menu's captions; `applybindtoself` picks whose parts its Clothes/Dressup ▸
  lists; Close / Quit send R1 the menu's character, R2 the clicked one. BloodTeaHOUSE's `\1` (飛白) gets the main menu,
  its Clothes/Dressup ▸ holding only the explorer, in its Tea0 (first-boot welcome) and Xmas modes, and the short menu
  otherwise [measured on its Kawari].
- **The look** follows ssp.exe's owner-drawn menu, read in its disassembly (`ssp-ui.md` §2.3; SSP's rows are 19 device
  px at 125 % [observed]): only the font follows the display (9 pt = 12 CSS px, or the descripts' `menu.font.name` /
  `menu.font.height`, the height in device px, the shell's over the ghost's); rows of the em + 2 × 2 device px, 11-px
  separators, 16-px insets, SSP's check, dot and arrow as pixels (the dot on the current shell, balloon and ghost and
  on worn parts, by SSP's command ids), the menu images 1:1 in device px and aligned right of the sidebar, a
  1-device-px `menu.frame.color` frame with Windows 11's corners, no padding, no open animation, no hot row at open,
  SSP's own colours when the shell's look would not load in SSP (LoadSurface's rule). All of it is
  `n / devicePixelRatio` CSS px (`menuMetrics`, `menuVars`), with SSP's baseline (Blink's half-leading is corrected for
  fonts with an odd internal leading: 125 % and 175 %) and Windows' 2 × average character width after the caption. A
  menu opened by a long press gets 24-CSS-px rows [decision]. No accelerator texts ("Ctrl+W" …): Sumika handles no
  Ctrl shortcut and the browser owns them [decision].
- **The SHIORI's menu skin** (`ssp-ui.md` §2.3 "SHIORI resources"; bthver.5's skin is only in its `resources.txt`):
  ssp.exe 2.9.10's `GetODMFromShiori` read in its disassembly, the same 35 `menu.*` ids in its order and three
  batches, asked at every shell load (before OnBoot and before OnShellChanged) and, when that pass was complete, again
  at every open; images from the shell folder then `ghost/master/`, always `.png`; etherism's partial answers are
  never asked, so its menu stays SSP's own black on white. BloodTeaHOUSE ver.5's menus (both characters, in
  5th-Normal and 5th-Smart) show background, sidebar and hot-row images at the bottom left, black text, white on the
  hot row, greyed 222, black separators.
- **Tooltips and choice hover** work as ssp.exe 2.9.08f does them (`ssp-ui.md` §4.8, EV §4.3, §4.7; read in its
  disassembly): a 500 ms rest on a balloon item asks OnChoiceHover / OnAnchorHover, then `balloon_tooltip` (once per
  item entry); a rest on a named collision OnMouseHover (once per collision change), then the shell's own
  `<scope>.tooltips` or the `tooltip` resource. OnChoiceEnter / OnAnchorEnter on entering an item, OnChoiceEnter
  without References on leaving it (above or below the validrect: at every move, the item staying selected), before
  every click's selection event and before a choice timeout. One box per page (`src/ui/tooltip.js`, `Z_BASE + 199`),
  balloon tips in the balloon's colours, shell tips in a Windows look; touch has no hover, so no tips [decision].
- With Tsubasa the menu asks about 60 resource ids and opens in under 0.1 s, so SSP's resource cache rule is not
  needed.
- **Boxes**: `\4`/`\5`, `\__c` and the teach box work (`ssp-ui.md` §3.8, §6.3). An open box does not make the ticks
  NOTIFY (ssp.exe only adds `opening(…)` to Status; SUMMARY C6) [observed]: random talk can come during a prompt, as in
  SSP. Nor does a box pause the balloon / choice timeout (ssp.exe 2.9.10 reads no box state there; EV §3.4) [disasm].

### Sound and music

- Dropping files on a character sends OnFileDrop2 with pseudo-paths; playable audio is kept in IndexedDB, and the music
  box resumes after page navigation (`tsubasa-needs.md` §3.4). The MCI players `mciaudior` / `mciaudio` (16 ghosts)
  drive the same music box; mciaudior's track ends and loops reach the ghost as OnMAAPlayFinish / OnMAAPlayLoop.
- MIDI plays wherever a ghost plays sound (Code "MIDI", `docs/research/midi.md`).
- OnSoundStop, OnSoundLoop and OnSoundError are sent (EV §4.17: every `\_v`, `\8` and `\![sound,play|loop]` reports
  its end, as in ssp.exe 2.9.10), so bonsyou's gong counter runs and its gong rings again once the sound has ended.

### Session clock

P7 (SUMMARY §2.1): `（単純起動秒）` and `（起動時…）` count from the ghost's last cold boot (`bootEpochMs` in its state; a
new tab, a ghost change or a relaunch restarts it) across page loads and crash restarts. [decision]s, not bugs: the
total `ゴースト起動時間累計` leaves out the time between pages (seconds, or the hours a visitor spent on other sites), and
`（ＯＳ起動…）` report the ghost's age, not the tab's.

### Scripts, properties and web requests

- **SAORI stand-ins**: the most used SAORIs have them (`aya5`, `mciaudior`/`mciaudio`, `time_check`, `saori_cpuid`,
  `sysio`, `maho`); the ghost sweep ranks what is left across 247 Satori ghosts (`docs/research/ghost-sweep.md`).
- **Web requests** (`\![execute,http-*]`, `\![cancel,http,…]`; `shiori-events.md` §4.15, `src/core/http.js`, one
  `HttpRequests` per EventLoop) are sent: many fail on security policies and dead sites, which does no harm
  [decision]. SSP's options, parameters and charsets (CP932 as Windows writes it), sync (the script waits at the tag)
  vs `--async`, the download written into the engine's `ghost/master/var/` before OnExecuteHTTPComplete / Failure (or
  the `On…` ID), SSP's References and failure reasons; which status succeeds, the error page a threaded request saves
  and R6 follow ssp.exe's `RealRead` [disasm]. Privacy [decision]: `credentials: 'omit'`,
  `referrerPolicy: 'no-referrer'`, `cache: 'no-store'` (nothing kept, so no ETag goes back to recognise a visitor);
  `--param-input-file` never reads a personal file, judged on the path as resolved (`engine-files.js` `personalFile`,
  in the worker too), nor any file the visitor's own run wrote (`visitorFile` in the worker), for every engine,
  downloads and rewritten shipped files included [decision]; a simple POST that saves nothing (a web clap) goes
  `no-cors` and counts as SSP's `200`. CORS refusals, mixed content (every corpus URL is `http://`: an `https://` site
  cannot reach them), dead hosts: R4 `error`; stalls: `timeout`. Nothing goes out before boot, after Close or while
  frozen; a page left mid-request drops its event and file. Tests use a fake fetch (bonsyou's counter runs on the real
  YAYA engine, roommate's web clap on the real Satori engine); the sweep counts requests and sends none.
- **Tag brackets** are split as ssp.exe splits them (`sakurascript.md` §3.4, read in its disassembly; notes in
  `docs/research/scratch/tagquotes/`, development material, not in the repository): a `"` opens a quote anywhere in an argument, `\X` is a pair outside quotes,
  one-string tags (`\s \n \j \8 \& \_u \_m \_w \_v`) keep commas, `\p[`/`\w[`/`\q` have their own rules, and a tag
  whose `[` never closes is dropped with the rest of the script. Checked against a model of SSP's loop on all 331,212
  bracket tags of the corpus: no difference. So the web claps with `message_body="…"` (roommate's, yomi_to_syu's) are
  one tag and post what SSP posts. A tag that needs a bracket (or digit) and has none shows its name as text in
  ssp.exe 2.9.10 (`\sx` → `sx`, `\&x` → `&x`, `\_ux` → `_ux`), except `\p \w \q \f \8 \m`, which consume it (§3.3
  [disasm]). Only the names ssp.exe knows are tags (§3.2): after any other `\X` the `\` is dropped and X is text
  (`\k[1]` → `k[1]`, `\わ` → `わ`; BTHver.5's `blood/blood_01.txt:83` `、\わたくしの`, "unknown tag", 0x62be00), an
  unknown `\_X` shows as written, an unknown `\__X` is swallowed; `\URL[…]` is `\U` (underline) and text; `\B` / `\U`
  toggle bold / underline, `\y` ends like `\e`, `\_e` hides the balloon.
- **Mouse gestures** (EV §4.5.1, SUM C31) [disasm]: right-drag left then right across bonsyou's bell and release: it
  rings (its `GongLock` waits for the gong's OnSoundStop: about 23 s later the count talk 「…の煩悩が消えてゆきました。」
  appears where the page may fetch its `http://` counter, and it rings again); right-drag left or right across
  emily4's skirt: it lifts; a right wiggle of 4 px or more opens no menu, a smaller one still does; a middle drag is
  unchanged. Touch [decision]: on a phone a long press on a body spot then a swipe is a gesture (a plain drag still
  moves the character), so emily4's skirt (a named collision) cannot be gestured by touch.
- **OnSecondChange** R1/R2 come from the collision rect (EV §3.2.1, SUM C17) [disasm]: random talk goes on while about
  30 px of Tsubasa's transparent right margin is past the screen edge, and stops once her body is cut off. A cancelled
  OnShellChanging talk leaves Status `changing` set in ssp.exe until the next shell change; Sumika clears it
  [decision].
- **SSP's property system** (`docs/research/properties.md`, the normative spec): `%property[…]`,
  `\![get,property,EV,name…]` (GET EV, SenderType `internal,property`, the script waits as for `\![raise]`) and
  `\![set,property,name,value]`, one resolver (`src/core/properties.js`) with ssp.exe's name rules, over the loop's
  `_world()` and the Site's lists (`Site.propsFor`: `ghostlist` = the site index in Change ghost ▸'s order,
  `activeghostlist` = the ghosts up in this tab, the caller included [infer], `balloonlist`). `%`-variables are
  expanded once over the whole script before it plays (`src/sakura/expand.js`, `EventLoop.expand`: before
  OnTranslate, again after an OnTranslate that changed it, an `\![embed]` reply (which then goes through OnTranslate
  too, as in ssp.exe), `playScript`, a `script:` choice; never inside a tag's bracket, never on a replay; replies still
  play in the order they arrived, `_inOrder`); `%username` asks `GET username` at each expansion (no boot
  `GET username`), else the visitor's stored nickname, else the name, else `user` [decision] (SSP always has the
  Windows name; a fixed default word would give emily4 a name at once, but etherism would store that word instead of
  its own `ユーザ`). Browser stand-ins for the OS (properties.md §5.5): `system.os.type` `Web`, the browser's language
  as the OS locale (the UI language still reaches a ghost only through OnLanguageChange), one monitor = the viewport,
  no CPU / memory / disk / addresses. Settable: `scope(N).surface.num`, `balloon.scope(N).num`, `ext.*`; the other
  settable names log once. properties.md §8 lists the [decision]s (the units: desk CSS px, balloon-image px; ids and
  paths; the balloon numbers before the first show). ssp.exe's "untrusted script" gate (a script OnTranslate rewrote
  may not use `\![open]` or `\![get|set,property]` [disasm 0x63BCAB]) is not copied [decision]: taken literally it
  would refuse them in every ghost whose OnTranslate answers (emily4's does). The ghost sweep counts every name read
  (ghost-sweep.md "SSP properties").
- **The word variables** `%ms %mz %ml %mc %mh %mt %me %mp %m? %dms` (properties.md §2.4, ssp.exe 2.9.10's
  `SPGhost::GetWord` [disasm]): the ghost is asked (`GET`, ID `\ms`, kind `word`; Kawari 7 gets `GET Word SHIORI/2.0`
  / `Type: \ms` and answers from `compatible.*`), `\m?` again as `\m`, then SSP's word list
  (`site/sumika/word_compatible.txt`, `src/core/words.js`, `Site.compatibleWords`). emily4 and NodePsimoon answer
  their own words; Tsubasa and bthver.5 get SSP's. `%et` (r mod 1000 and one of `msec yard kg t dozen` by r mod 5,
  r = genrand(59787)) and `%wronghour` (the hour 1 or 2 off) follow `TranslateParamReal` (properties.md §2.3).

## Known gaps

Current limitations, by area. A [decision] marks a gap kept on purpose.

### Engines

- Kawari (kawari-wasm.md §17): the snapshot leaves out write-protected entries, so `sentence` in brynhild_conf1.13,
  meganeoni040313 and wakaba001 loses its no-repeat state on a page change; 8.0-era syntax that 8.2.8 rejects costs
  entries (kuro 593 parse errors per load); other ghosts' saves are invisible to a Kawari ghost (the BTH family reads
  its partners' saves) [decision]; asri101's OnMouseWheel takes 106 ms; a tab closed during a Close goodbye is closed
  twice (D6's close and unload) [decision]; an endless loop in a request costs 30 s, then the worker is killed and the
  ghost resumes from its last snapshot (at most 3 times in 10 minutes); SAORIs without a stand-in (`bln`, `hanayu`,
  `lettuce`, `textcopy`, which ssp.exe emulates itself …); Kawari as a SAORI (the Satori ghost snow girl) is not run.
- `--debug` builds of all three engines are refused by the builder-path check until emsdk's debug libraries are
  rebuilt. Satori and YAYA are not linked with Kawari's stack fix (`--stack-first`, `stackSave` / `stackRestore`).
- YAYA (yaya-wasm.md §16): raychel_kisekae and ure_c fail to load: Tc606 is stricter than their own DLLs (an undefined
  `GetEvalTalkArrayEX()`; a truncated `longtalk/ure_longtalk_haydn_sym_082.dic`), and neither has an emergency config.
  [decision]s (yaya-wasm.md §15): an empty folder MKDIR made is not kept; GETMEMINFO's constants and an empty GETENV;
  files written outside the ghost's own folder last only for the page; uptime is lost from `ghostupmin_last` when the
  tab is closed instead of the ghost.
- emily4's name: her first boot ends with `\![open,configurationdialog,setup]`, which opens the Preferences box. Her
  framework marks itself `Run` on the boot `GET version`, so only an OnNotifyUserInfo with a non-empty R0 names the
  visitor [probe]; Sumika sends none until the visitor saves the box [decision], so she stays nameless
  ("\uもあまり無理しないでね。") until a nickname is typed there.
- AYA4 (`aya.dll` whose dictionaries define only `OnRequest`; 3 archives) is engine `aya`, greyed "needs AYA".
- The proxies `lang_switch` (cyau_cyaka: a YAYA module per language, `\![language,X]`) and `gcore` (nibihada) run only
  in the sweep, through an override that picks the YAYA module; the site greys them.
- Engine census of the sweep's archive folder (320 archives): 294 of its 317 ghosts boot on the site; the rest are
  other SHIORIs (Misaka 3, AYA4 3, an unnamed `shiori.dll` 4, hisui 2, yuhna 2, one each of dnproxy, shino, yomiko,
  pixy, ruthtsyua), the two proxies the site greys and the two YAYA ghosts that fail to load; MAKOTO translators
  (`makoto.dll` in 14) are not run.

### Several ghosts and changes

- Not built: cross-ghost `Read.SaveData` in the aya5 stand-in; a site-wide
  image accountant (shared balloon skins, one compiled wasm module); Ctrl+Iconify, raise on talk, Quit during a ghost
  change; History ▸ Call ghost; OnOtherSurfaceChange / OnOtherOverlap; `data-default-ghost` with several; `log.once`
  keys per ghost; places per shell (SSP's `shell.dat` before `ghost.dat`) and SHIORI `defaultleft`-style resources
  (`ssp-ui.md` §3.2, §3.3). OnOtherGhostVanished is never sent [decision]. The memory of two big ghosts is not
  measured.
- Interacting: drawing a sender's `MarkerSend` in the partner's balloon and `X-SSTP-PassThru-*` [decision];
  OnTranslate's R1 flags; `SecurityOrigin: null` on every request (EV §1.1); YAYA's `READFMO`.
- EV §2.7.3, UI §2.6, §9.5: another tab that takes the set over after the quitting page went (before the quitting
  tab's next page starts) resumes the goodbye ghosts standing; on a carried Quit a ghost whose engine fails is never
  stored closed; while the lead tab waits for an old-code tab's ghost lock its calls and changes wait and Quit is
  refused; a minimized ghost whose bfcache resume fails keeps a dead "Show X" button.
- OnNotifyBalloonInfo, and SSP's two warnings when leaving a recommended balloon.

### Menus and boxes

- Left out or greyed [decision]: SSP's other Options ▸ items, History ▸, RSS / Plugins / Check mail; the Dressup
  explorer, Help, AI graph, Ghost usage statistics and Output system information are greyed. No Network update or
  Uninstall ("Project rules").
- "Link balloon's scaling" / `balloon.syncscale`, smoothed scaling.
- Close / Quit in passive mode do not ask SSP's "Some commands are currently processing…" first; `\![bind]` with SSP's
  ParseBool values and the `__ALL__` / empty-part forms with any value; SSP's lazy bind blocks (one report per run
  here); storing off-states (so a shell update's new default parts appear); the Dressup explorer.
- The SHIORI's menu skin: the descripts' default image names and numbered images (no tested ghost uses them; §2.3 "Not
  done").
- SSP's `currentghost.seriko.tooltip.*` property override.
- `\![open,…]` windows of SSP's own other than the Preferences box (`readme`, `calendar`, explorers, `help`) do
  nothing: emily4's お役立ちメニュー → カレンダー opens SSP's calendar window in ssp.exe (`\![open,calendar]`), nothing
  here (yaya-wasm.md §15 #9).

### Sound and music

- dsaudio `load` always answers `Result: 1` (the worker cannot see the store) and returns no tag metadata (Value0–2).
- WMA doesn't play.
- Numbered players (`mciaudior2`…`6`, only um.nar) have no stand-in: they need their own channel, not the one music
  box.
- `\_V` and `\![sound,wait]` do not wait.
- `\![set,wallpaper]` (her image drops) only logs; images are not stored (widen `playable` in `drops.js` when a
  wallpaper exists).
- Visitors can forget dropped files only by clearing the site's data (`DropStore.clear()` exists; a menu item would be
  an addition SSP does not have).

### Scripts, properties and web requests

- SAORIs without a stand-in: `effect` 6, `parallel.exe` 6, `mako.exe` 5, `kenonoke` 4 and a tail of 1–2-ghost DLLs,
  plus the ignored tags in ghost-sweep.md.
- `\![updatebymyself]` (on Tsubasa's homework item) does nothing. httpc always fails, so there is no weather.
- `\![vanishbymyself]` and several `\![set,…]` commands only log.
- Web requests: rss / ical / websocket; a read that fails keeps the previous download, which SSP deletes (EV §4.15).
- Properties that still fail (properties.md §7): `animation.num`, `surface(M).rect`, `mousecursor*`, `seriko.*`,
  `sound*`, balloon `background.color` and `index(I).*`, `recommended.*`, other ghosts' `craftmanurl` / `homeurl` (the
  index lacks them; `icon` comes from `ghosts.json`, for every ghost), and the %-variables ssp.exe has beyond Sumika's
  list (`%friendname`, `%0`, `%1` …).
- Word variables left as text: `%friendname`, `%ntpdiffsecond`, `%originalname` … and the single-letter forms of SSP's
  compatible mode (`%d`, `%h`, `%c`, `%0`, `%by` …).

### Unverified in browsers and on hosts

- Phones: the [verify] list of `ssp-ui.md` §9.11 on a real phone, its Safari items S1–S6 among them.
- Browsers: whether WebKit applies a page's CSP to a blob worker (if not, `wasm-compile` refuses Safari on a host whose
  CSP lacks `'wasm-unsafe-eval'`, where it would run; such a host breaks Chrome and Firefox anyway).
- Safe updates: that a `fetch(url, {cache: 'reload'})` replaces the stored copy a later `<script src>` of that URL
  uses; that Safari honours `fetch`'s `cache` option (if not, caching works as without it and stays consistent). The
  host defaults are from documentation, not measured (GitHub Pages `max-age=600`, Netlify and Cloudflare Pages
  `max-age=0, must-revalidate`, nginx and Apache none), and so are the `Content-Type` / `Content-Encoding` hosts send
  for a `.pack.gz` and a `.wasm`, whether a deploy clears GitHub Pages' CDN at once, and that a missing path answers
  404 with `404.html` in place (Cloudflare Pages above all); Firefox's rule that a URL with a query is never
  heuristically fresh is cited from its source.
- The storage hub: whether Safari keys the hub's storage by the top page's origin (then no resume across origins
  there); whether a Lax cookie still reads back after a cross-site arrival in Firefox; whether posts made at
  `beforeunload` land; pagehide in a removed hub frame; GitHub Pages' default `Access-Control-Allow-Origin: *` and
  `hub.html` caching.
- MIDI: the iPhone and Safari items of midi.md §7.
- Web requests have run against a fake fetch only, never against a real host.

### Not yet confirmed in ssp.exe

These follow the disassembly or an inference; ssp.exe has not been watched doing them.
- Balloons and boxes: the leading-`\n` rule (from the disassembly, BA §3.3; it puts Tsubasa's main menu 13 px below
  its banner); the communicate field has no visible border; whether the input box also has OK/×.
- SUMMARY §5's verification backlog (OnKeyPress R2 base, release order after a drag, the timing of script dress-up
  events (their order is settled from ssp.exe's disassembly), cantalk while choosing, `\w[N]`, `\b[-1]`, pixel
  calibration). The runtime follows the §1 resolutions.
- Shells, balloons and menus: EV §7 Q8, BA §12.5, SH §8 #12–14, UI §2.11; the menu's look (`ssp-ui.md` §2.3); the
  ASSUMPTION in EV §2.5 (OnFirstBoot before OnGhostChanged); reloads (EV §2.10); the [guess]es of the boxes (UI §3.8,
  §6.3: distances, the teach box closing after OK); tooltips (UI §4.8, the tip box's colours among them).
- Several ghosts: EV §7 Q9, UI §2.12, §3.5, §9.7, SUMMARY §5 (does Quit's goodbye without `\-` still close the
  ghost?); ghosts interacting: EV §7 Q10. **Where a ghost called for the first time stands** (UI §3.5 check #2): in
  ssp.exe it does not stand on top of the caller, with no clear pattern [observed]; Sumika, following the disassembly,
  puts a ghost never met on top of a caller at its own default place (UI §3.2, §3.3, §3.5, EV §2.7.1). The two agree
  only if every ghost in that SSP had run before and came back where it last stood [infer].
- YAYA (yaya-wasm.md §15): emily4's communicate replies are all 204 (her `OnCommunicate` calls an
  `OnCommunicate_User` no dictionary defines; the same in SSP [infer]). emily4 pads her menus with
  `GETSTRBYTES(x, 127)` in the PC's ANSI code page: on a Windows whose code page is 1252, ssp.exe counts a Japanese
  character as 1 byte, Sumika as 2 (CP932, like Japanese Windows), so her menus are wider in ssp.exe there; compare
  the text, not the widths.
- The property system and the Preferences box (properties.md §8–§9, `ssp-ui.md` §2.13, EV §4.16): which Preferences
  page shows first; what emily4 says after her first boot's box; `activeghostlist` including the caller; the meaning
  of the balloon numbers etherism's main menu header uses (SSP's line height is untraced); the word variables.
- MIDI: the comparisons with ssp.exe in midi.md §7 (V1–V6).

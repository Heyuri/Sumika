# YAYA → WebAssembly: build & integration spec

Status: implemented and measured in Node 24.19 and Chromium. Scope: compile `vendor/yaya-shiori` (YAYA
Tc606-2, which also runs AYA5 ghosts) with Emscripten into `yaya.js` + `yaya.wasm` for the browser (Web Worker) and
Node; the JS ↔ C ABI; the SSP-like file system; persistence and resume; the patches; tests and measurements. Shaped
like `satori-wasm.md` (WASM below), which it follows wherever the two engines are alike.

Tags: **[code]** read in source (YAYA file:line = `vendor/yaya-shiori` at `e69fefb`; the build's UTF-8 copy has the
same line numbers before patching), **[measured]** run here (where: packages A–D of the YAYA build, the browser
check, or the research and plan before them: port, corpus, critic, plan), **[doc]** a document, **[infer]** concluded,
not run, **[guess]** unchecked, **[decision]** a choice made here, **[observed]** seen in a running ssp.exe
(§15).

Files: `engines/yaya/build.py` (build), `patches.py` (§5), `msgtables.py` (message tables), `smoke.mjs` (smoke test);
`engines/common/gen_cp932.py` and `engines/common/cp932/` (the code page 932 table, §3); `src/worker/engines/yaya.js`
(`YayaEngine`); `src/core/engine-files.js` (which files the worker gets); `tools/index_site.py` and
`tools/sweep/views.mjs` (engine detection); tests in §12. Seams: CONTRACTS.md "Worker protocol".

Not in the repository: the ghosts this spec measured on (emily4 and the others of CLAUDE.md "The ghosts Sumika was
tested with"), the archives of the sweep, emily4's corpus (`tests/corpus/emily4/`) and the emsdk copy in
`toolchain/emsdk` (docs/building.md "What the builds need"). These are development material, cited as the sources
(CLAUDE.md "Project rules").

---

## 0. Decisions at a glance

| # | Decision | Where |
|---|---|---|
| D1 | A page navigation resumes, it does not boot: `yaya_load_resume` runs the dictionary's `load`, then restores every saved variable again, from the save as it was before `load` ran (N3). After a site update of `ghost/master` (the dictionary stamp) a resume loads cold. | §8 |
| D2 | An emergency config (`<module>_emerg.txt`) boots, as in SSP; nothing usable (suppressed) or shell mode fails the boot, with the reason at warn. | §9 |
| D3 | The index gives `engine: 'yaya'` and `module` from the ghost's config (`ghost/master/<stem>.txt` lists a dictionary that defines `request`), not from the DLL name alone; `aya5.dll` ghosts are `module: 'aya5'`. `index_site.py detect_engine` = `views.mjs detectEngine`: identical on 60 of 60 corpus ghosts and 34 edge cases [measured, package C]. | CLAUDE.md "Gotchas", CONTRACTS.md ghosts.json |
| D4 | The ghost lives in an SSP-like MEMFS (`/ssp/ghost/<id>/`, the site's other ghosts beside it); whatever it writes in its own folder persists per visitor, deletions too. | §6, §7 |
| D5 | One Windows-exact code page 932 table, shared with Satori: decode = `MultiByteToWideChar(932, 0)`; encode = `WC_NO_BEST_FIT_CHARS`, plus (YAYA only) the 85 best-fit entries of flags 0; `CHARSET_DEFAULT` = CP932, as on Japanese Windows. | §3 |
| D6 | The full YAYA (SQLite, Gumbo, parson, TinyXML-2, DEELX) at -O2; the licence texts ship as `yaya.LICENSES.txt`. | §2, §13 |
| D7 | YAYA's log goes to a JS handler; only fatal / error / warning / note lines reach the console, and only with `?sumika-debug`; no request/response log. | §11 |
| D8 | OS stand-ins: nothing executes (-1), no environment, fixed memory figures, GETTICKCOUNT = the ghost's age. | §10 |
| D9 | The personal-file guard: `*_variable.*`, `*.log`, `PERSONAL_PATHS` (files an SSP run created or rewrote), `add_ghost.py --archive` (names and contents against the original). | CLAUDE.md "Never ship personal data" |
| D10 | Tests on a synthetic fixture written for the tests, an integration test on the event loop, the ghost sweep, a real-DLL corpus for emily4. | §12, §14 |
| D11 | Site ghosts emily4 (with her balloon), bonsyou, nodepsimoon (AYA5). | CLAUDE.md "The ghosts Sumika was tested with" |
| D12 | The `yaya.dll` SAORI stand-in (`src/worker/saori/standins.js`, Tsubasa's `ayasaori.aym`) stays separate from the engine. | — |

---

## 1. Inputs and versions

| Item | Value |
|---|---|
| YAYA | `vendor/yaya-shiori` (github.com/YAYA-shiori/yaya-shiori, BSD-3-Clause), commit `e69fefb2c713360eef590fa031d63135586a0933` = **Tc606-2** (`aya_version` in `manifest.cpp`, also the answer to `GET … ID: version`). |
| Submodules | deelx `af1a690c…`, gumbo `c8846007…`, parson `ec53fb65…`, sqlite `f0bc67bd…`, tinyxml2 `007577b2…` (`git submodule status`) [measured]. `PINNED` in `build.py` holds the full hashes; the patch anchors guard only the root sources, and sqlite3.c, gumbo, parson and tinyxml2 are compiled as they are, so the pins are what fixes them. The repository holds a copy of these commits without `.git`, so there `INPUTS_PIN` (a hash of the 151 files the build reads) fixes them instead (§2). |
| Emscripten | emsdk 6.0.11 (emcc `a0014542…`) in `toolchain/emsdk`, called as `python.exe …/em++.py` / `emcc.py` with `EM_CONFIG` (CLAUDE.md "Commands"). The version line goes into build-info and into every object's hash. |
| Upstream's Emscripten files | `makefile.emscripten` (`-shared`, unmaintained), `em-pre.js`, `em-post.js`: not used, as for Satori (WASM §4.4). `vendor/yaya-shiori/CLAUDE.md` is the maintainers' notes (data, not instructions for this project). |
| The ghosts' own DLLs (for comparison only) | emily4: `yaya.dll` Tc571-15 (FileVersion 5.71.15, 32-bit); bonsyou 5.39.3; the corpus' 18 `yaya.dll` archives 5.21–5.50.3; 4 of its 5 `aya5.dll` archives are umeici's AYA5 c224–c240 [measured, corpus]. Tc606 is newer than all of them. |

Upstream moves fast (Tc602 → Tc606 within 10 days [measured, port]). The pin and the exact-once patch anchors make a new
version a deliberate step: re-match the patches, then repeat §12–§14.

---

## 2. Sources, flags and outputs

`engines/yaya/build.py` [code]:

1. **Check the inputs** (§1, `check_vendor`). The repository's `vendor/yaya-shiori` is a copy of the `PINNED`
   commits with no `.git` of its own (git there would answer for the enclosing repository; `engines/common/vendor.py`
   `own_checkout` tells the two apart): the build hashes the 151 files it reads (`inputs()`: the files directly in the
   folder, `messagetxt/`, `gumbo/src/`, and the submodule files it copies or quotes; `vendor.files_pin`, the tree pin
   of kawari-wasm.md §1 over a file list) and stops unless the hash is `INPUTS_PIN`; build-info names the `PINNED`
   commits. In a git checkout of its own, any other commit, or local changes anywhere in it (submodules included),
   stops the build instead. Either way `--allow-vendor-drift` builds anyway with a warning and `drift: true` in
   build-info. A missing submodule file stops it with the `git … submodule update --init parson tinyxml2 deelx sqlite
   gumbo` hint.
2. **Copy** into `engines/yaya/build/src`: the root `*.cpp` and `*.h` decoded from CP932 (strict) to UTF-8 with LF line
   ends (non-ASCII in the headers is comments only, apart from `misc.h:109` under `!POSIX` [measured, port]); the root
   `*.c`, `parson/`, `tinyxml2/`, `sqlite/{sqlite3.c, sqlite3.h, sqlite3ext.h}`, `deelx/deelx.h` and `gumbo/src/` byte
   for byte.
3. **Generate** `cp932_table.h` (`engines/common/gen_cp932.py … --verify engines/common/cp932`, §3) and
   `messagetxt_builtin.h` (`msgtables.py`: `messagetxt/*.txt` as C literals, the tables `aya5.rc` embeds into yaya.dll,
   which patch Y9 looks up; `--embed-file` would need file_packager, whose `.exe` launcher fails in this emsdk).
4. **Patch** (§5): each entry's old text must occur exactly once.
5. **Compile** makefile.linux's 50 translation units in three groups: 33 `.cpp` with em++; `crc32 md5c sha1
   parson/parson` as C++ (`-x c++`: the makefile's `.c.o` rule uses `$(CXX)`); `sqlite3_yaya` (it `#include`s the
   amalgamation) and the 12 `gumbo/src/*.c` as C with emcc. Flags: `-O2` (or `--opt Oz`), `-fwasm-exceptions -DPOSIX
   -D_FILE_OFFSET_BITS=64 -Wall`, `-ffile-prefix-map=<src>=src` in both slash styles; C++ adds `-std=c++11`
   (`globaldef.h` asks for C++20, but only C++11 is used [measured, port]). `--debug`: `-O0 -g`, plus
   `-fdebug-compilation-dir=.` and `-ffile-prefix-map=<emsdk>=emsdk`, because DWARF names the working directory and
   emsdk's headers. Objects are kept per variant (`obj-O2/`, `obj-Oz/`, `obj-debug/`) and recompiled when the SHA-1 of
   the source, every header, the flags or the emcc version changes. 13 compiler warnings, 2 of them from N7
   (`ExecutePosix` and `MakeExecuteCommandPosix` are unused now) [measured, package A].
6. **Link** in `engines/yaya/build/link-<variant>/`: `-fwasm-exceptions -sMODULARIZE=1 -sEXPORT_NAME=createYaya
   -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sSTACK_SIZE=1MB
   -sCASE_INSENSITIVE_FS=1` and the exports of §4; `--debug` adds `-sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2`. Then
   `patches.JS_PATCHES` go into the linked `yaya.js` (J1, §5: regular expressions, as the release JS is minified and
   the debug JS is not; each must match exactly once, line ends kept).
7. **Check, then publish**: `yaya.js` and `yaya.wasm` must not contain the builder's home folder (`Users\<name>` in
   both slash styles), `AppData\` / `AppData/` (as a folder only: a debug build's DWARF has SQLite's parameter
   `pAppData`) or the project path; otherwise nothing moves. Then `yaya.js`, `yaya.wasm`, `yaya.build-info.json`
   (`{yaya, version, submodules, drift, emcc, patches, jsPatches, opt, debug}`) and `yaya.LICENSES.txt` go to
   `--out` (default `site/sumika/engines`; a `--debug` build to `engines/yaya/build/out-debug` unless `--out` is
   given). Comparison builds (the -Oz measurement) always go to a scratch `--out`, so the site keeps the build the
   checks ran on. **A `--debug` build is refused by this check** [measured, Kawari work P1]: the `-debug`
   libc++ / libc++abi archives in emsdk's library cache carry the builder's path
   (`C:\Users\<name>\…\upstream\lib\clang\24\include`) in their DWARF, which `-g` links in. It stays refused until those
   cache libraries are rebuilt with a prefix map (not done: shared toolchain; kawari-wasm.md §2). The -O2 and -Oz builds
   are clean.

Exceptions are required: YAYA has 15 `try` / 24 `catch` and turns `bad_alloc` into OnMemoryLimit / OnMemoryError
[code, port]. `catch (...)` cannot catch a wasm trap: a script recursion of 800 levels throws a RangeError out of
`_request`; the base adapter answers 500 and the next request works [measured, port]. The default `fncdepth` (32) stops
scripts long before that [measured, critic].

Time: about 60–78 s to compile the 50 files with 8 jobs (`sqlite3_yaya.c` alone 39 s) and 16–25 s to link [measured,
port]. A rebuild with nothing changed reuses all 50 objects and gives a bit-identical wasm [measured, package A].

**`yaya.LICENSES.txt`** (`licenses()` in build.py) [code]: every notice in the code compiled in, in this order: a
header with YAYA's version and commit; YAYA's `LICENSE` (BSD-3-Clause); MT19937's notice from `mt19937ar.cpp`
(BSD-3-Clause, Matsumoto and Nishimura; clause 2 wants it with a binary); RSA's MD5 notice from `md5c.c` ("These notices
must be retained in any copies of any part of this documentation and/or software", and the code is to be named "RSA
Data Security, Inc. MD5 Message-Digest Algorithm"); the CRC-32 header of `crc32.c` (Mark Adler, zlib's conditions);
`parson/LICENSE` (MIT); `tinyxml2/LICENSE.txt` (zlib); Gumbo's "Copyright 2010 Google Inc. All Rights Reserved." (2011
in `char_ref.c`, `tag.c` and four headers) with `gumbo/doc/COPYING` (Apache-2.0, whose text must travel with the
binary); the MIT notice of Bjoern Hoehrmann's UTF-8 decoder from `gumbo/src/utf8.c` ("shall be included in all copies
or substantial portions"); DEELX: the first 12 lines of `deelx/deelx.h` (DEELX v1.3, "Copyright 2006 ~ 2013 (c)
RegExLab.com All Rights Reserved.", no licence terms); SQLite: public domain, with the amalgamation header's words;
`sqlite/LICENSE` (the BSD licence of the sqlite-amalgamation repository YAYA takes SQLite from); last, as in every
engine's notices, what Emscripten compiles in (`notices.emscripten`: its runtime and system libraries, with
Emscripten's `LICENSE` and musl's `COPYRIGHT`, read from `toolchain/emsdk`). `sha1.c` (RFC 3174's SHA-1) carries no
notice. The source notices are cut out by `engines/common/notices.py` (from a first to a last line),
which stops the build when one is not where it was. Upstream's own `LICENSE()` function (`sysfunc.cpp:9174-9331`) lists
MT19937 and the Hoehrmann decoder too [code]. Satori's build writes `satori.LICENSES.txt` the same way (Satori's
BSD-2-Clause, MT19937, DEELX, then the Emscripten section). About Sumika names the same parts (`DEFAULT_ENGINES` in `src/ui/info.js`), and
docs/licenses.md says the same. DEELX's wording is not reviewed further (§15).

---

## 3. Charset: the shared code page 932 table

### 3.1 Why

musl's iconv (Emscripten 6.0.11) maps CP932 by JIS X 0208: `0x815F` → U+005C (a real backslash, so `＼` in a
dictionary becomes SakuraScript), `0x8160` → U+301C, `0x817C` → U+2212; NEC row 13, the IBM extensions and the user area
fail (`①` → `?@`); and it writes `*` for 2,339 code points Windows encodes, without reporting an error, so YAYA's own
`?` path never runs. Measured in YAYA: `GETSTRBYTES("①～－＼",0)` = 4 (Windows 8), FWRITE of `あいう①` wrote
`82a0 82a2 82a4 2a` [measured, port]. Satori had the same problem (WASM §5.3).

### 3.2 The table (`engines/common/gen_cp932.py`)

Measured on Windows 11 with Windows PowerShell 5.1 (the scripts and dumps in `engines/common/cp932/`, see its README)
[measured]:
- **Decode**, `MultiByteToWideChar(932, 0)` (both DLLs): equal to Python's cp932 on all 9,672 valid sequences (9,604
  pairs + 68 single high bytes). An invalid pair, even a lead byte before a newline, is one U+30FB `・` that takes both
  bytes; a lead byte at the end is U+30FB.
- **Encode with `WC_NO_BEST_FIT_CHARS`** (satori.dll, `charset.cpp:237-245`): the decoder's inverse, 9,274 code points.
  Where a character has two codes, Windows writes JIS X 0208 / NEC row 13 first and the IBM extension (0xFA–0xFC)
  before the NEC-selected copy (0xED/0xEE): 373 code points where Python's encoder differs (U+2170 `ⅰ`: Windows `FA40`,
  Python `EEEF`). Anything else is `?`, a surrogate pair `??`.
- **Encode with flags 0** (yaya.dll, `ccct.cpp:914, 920`): the same plus 85 best-fit entries (`é` → `e`, `¥` → 0x5C,
  `«` → 0x81E1, `ゔ` → 0x8394, U+3099/309A → ゛゜, and `¢ £ ¬` → 0x8191/0x8192/0x81CA).

The header holds `cp932_single_hi[128]`, `cp932_dbcs[60*189]` (0 = invalid), `cp932_enc_count/ucs[]/mb[]` (the
`WC_NO_BEST_FIT_CHARS` table) and `cp932_bf_count/ucs[]/mb[]` (the 85), both sorted by code point. `--verify DIR`
compares it with the three dumps (and the dumps' invalid-pair and surrogate lines through a model of the C rules) and
exits 1 on any mismatch: 0 mismatches; a planted error in a scratch copy gives 2 and exit 1 [measured, package A].
Satori's patch P1 uses the base table, YAYA's Y1 the base and then the best-fit part (`EmCp932Encode`). One generator,
one place to fix.

### 3.3 Satori's table (S1, S2)

- **S1, encode**: the 373 IBM/NEC duplicates encode to the IBM code (not Python's choice).
- **S2, decode**: an invalid pair is one U+30FB that takes both bytes (not `?` with the trail byte kept). This answers
  WASM §11 item 3; WASM §8 P1 has a note.

Tsubasa has neither case (no invalid pair, no IBM/NEC character in her 68 CP932 files, and the requests are UTF-8), so
`satori_vs_dll` cannot see them. `tests/engine_adapter.test.mjs` tests them directly: `X 85 40 Y` → `X・Y`,
`X 81 20 A` → `X・A`, a lone lead byte at the end → `・`, `FA 40` → `ⅰ`; a Shift_JIS reply writes `ⅰ` as `FA 40`, and
`ゔ` and `é` as `?` (no best fit) [measured]. Before and after the Satori rebuild (package A) [measured]:
- `satori_vs_dll`: every same-status count equal or higher (bath 699, date 1,685, meal 861, master 5,317), the values
  within their noise bands (CLAUDE.md "Commands"), the error lines equal;
- the 247-ghost Satori sweep, S1 against S0: ran / ok / crashed / fatal 247/247/0/0, SAORI 54 in 37 and unknown tags
  28 in 25 equal; request errors and warnings moved only by keys that also move between two identical runs;
- neko and daytime_cat, the two archives with invalid pairs, have them only in files Satori does not load as
  dictionaries (a resource fork, a non-`dic` `.txt`); their reports equal S0 on every stable field.

`satori.wasm`: 775,906 → 775,918 bytes.

### 3.4 Where the code page shows in YAYA

- Shift_JIS dictionaries and files (`dic, x.dic, Shift_JIS`, `FCHARSET`, `STRDECODE`, …) and `CHARSET_DEFAULT` (charset
  127, "the OS default", also unknown charset names) go through the table (Y1): `CHARSET_DEFAULT` is CP932, as on
  Japanese Windows. `ccct_getcodepage(CHARSET_DEFAULT)` returns 932 (N11), so `FWRITEXML` / the HTML writer in the
  default charset declare `Shift_JIS` over CP932 bytes, not UTF-8 (`jsonxml.cpp:838-850`) [code].
- Requests and replies are UTF-8 both ways whatever `charset.output` says (N6): the worker always speaks UTF-8 (WASM
  §5.1), and a script's `SETSETTING('charset.output','Shift_JIS')` would otherwise send Shift_JIS bytes the worker reads
  as UTF-8. No corpus config sets another output charset [measured, corpus], so N6 is a safety net.
- SAORI traffic is UTF-8 both ways (Y6), what the stand-ins read and answer.
- File names are UTF-8 (`posix_path`); every `CHARSET_DEFAULT` conversion of a path is inside `#if defined(WIN32)`
  [code].
- Checked [measured, `tests/yaya_engine.test.mjs`, smoke]: a Shift_JIS dictionary with `81 60 81 7C 81 5F 87 40 FB FC`
  reads `～－＼①髙`; `STRDECODE('X%81%0AY', 'Shift_JIS')` = `X・Y`; `GETSTRBYTES("①～－＼", 0)` = 8; FWRITE in
  Shift_JIS writes `あいう①éⅰ` as `82A0 82A2 82A4 8740 65 FA40`.
- **On a PC with ANSI code page 1252 (en-US)**, as the comparison runs had [measured, package D]: yaya.dll's charset
  127 is the PC's ANSI code page, so in ssp.exe there a Japanese character counts 1 byte (`?`) for
  `GETSTRBYTES(x, 127)`, where Sumika counts 2, like Japanese Windows. emily4 pads her menu items with it
  (`SHIORI3FW.MakeLongText`), so her menus are wider in that ssp.exe than in Sumika (the 6–7 "identical except the
  menu padding" of §12's `yaya_vs_dll`).
  Sumika follows Japanese Windows [decision]; compare text, not widths.

---

## 4. ABI: exports and Module hooks

The base ABI is Satori's (`src/worker/engines/index.js`): `load(dir, len)` frees `dir`; `request(req, &len)` frees
`req` and returns a malloc'd reply without a NUL, its length in `*len` (NULL when suppressed), which the caller frees;
`unload()`.

| Export | Semantics |
|---|---|
| `int load(char *dir, long len)` | Upstream: builds the VM (config, dictionaries; `Configure` restores the save; then the dictionary's `load`), frees `dir` and returns 1 whatever happened (`aya5.cpp:239-253`). N1's prologue: `LC_CTYPE` = `C.UTF-8`; a second `load` while a VM exists frees `dir` and returns 1 (upstream leaks it); the shell flag cleared; the log handler installed before the VMs are built, so the emergency VM logs too. |
| `char *request(char *req, long *len)` | Upstream, but frees `req` on every path (Y2; without it 1 KB per request leaked [measured, port]); UTF-8 in and out (N6). |
| `int unload(void)` | Upstream `Termination`: the dictionary's `unload`, SAORIs unloaded, files and SQLite closed, `SaveVariable` when `save.auto` is on (`basis.cpp:378-397`). |
| `void yaya_set_module_name(const char *utf8, long len)` | Y5. Call before `load`; the name is copied. It picks `<name>.txt`, `<name>_emerg.txt` and `<name>_variable.cfg` (default `yaya`, Y3). yaya.dll takes its own base name (`aya5.cpp:178-184`); the browser has no DLL, so the index's `module` says it. |
| `int yaya_save(void)` | Y5. `SaveVariable()` now when a VM exists, is not suppressed and `save.auto` is `on` (Termination's condition); 1 = written. About 1 ms for emily4 (§13). |
| `int yaya_load_resume(char *dir, long len)` | N4. `load` with the resume flag: after the dictionary's `load`, N3 restores the saved variables again (§8). 0 when loading threw (it then frees `dir` itself). |
| `int yaya_load_status(void)` | N4. -1 no VM, 2 suppressed, 1 emergency, 3 shell mode, 0 normal, checked in that order (§9). `load` returns 1 whatever happens, and `CI_check_failed` is suppressed OR emergency (`aya5.cpp:375`), so neither tells them apart. |
| `int CI_check_failed(void)` | Upstream; exported for parity tools only. |
| `malloc`, `free` | For the buffers above. |

Runtime methods: `FS`, `HEAPU8`, `HEAP32`, `UTF8ToString`, `stringToUTF8`, `lengthBytesUTF8`, `ENV`.

| Module hook (read by C through `EM_JS`) | Use |
|---|---|
| `saoriBridge` `{load(path, dir) → handle (0: none), request(handle, Uint8Array) → string \| Uint8Array, unload(handle)}` | Y6, the interface of Satori's patch P2, so `src/worker/saori/` serves both engines. C passes full MEMFS paths; `rootBridge` in yaya.js passes `/ssp/ghost/<id>/x` on as `/x`, so the stand-ins and the page's `pathFromDll` see `/ghost/master/saori/foo.dll` exactly as from Satori. `.exe` (SAORI-basic) names reach the bridge too; no stand-in → `LOADLIB` 0 and a log line. Requests and replies are UTF-8 whatever `CHARSETLIB` says. |
| `yayaLog(text, mode)` | N2, §11. |
| `bootEpochMs` | Y11: GETTICKCOUNT = ms since it (the ghost's last cold boot, P7). `Date.now` is read once, then `performance.now`, so it never goes back. Without it: upstream's `CLOCK_MONOTONIC` (the worker's age). |

`preRun` sets `ENV.TZ` to the browser's IANA zone (`coreinfo.timezone`, GETTIMEZONE; local time stays the JS Date's
[measured, port]) and, when `opts.lang` is given, `ENV.LANG` (`ja-JP` → `ja_JP.UTF-8`: YAYA's message language, Y17).
Without it Emscripten fills `LANG` from `navigator.languages`.

---

## 5. Patches (`engines/yaya/patches.py`)

43 entries (build-info `patches: 43`; package A built 42, N3's revision added one) [measured], each an exact-once
replacement on the UTF-8 copy. **Y** = from the port research, each compared with yaya.dll Tc571-15 through 74 test
expressions (every version-independent result matched Windows) [measured, port]; **N** = added with the integration.
All are under `__EMSCRIPTEN__` except Y4 (an upstream bug fix) and Y8/Y15 (no-ops where `wchar_t` is 2 bytes).

| Id (entries) | File | Change | Why |
|---|---|---|---|
| Y1 (4) | ccct.cpp | include `cp932_table.h`; `EmCp932Decode` / `EmCp932Encode`; `CHARSET_SJIS` and `CHARSET_DEFAULT` go through them in `utf16be_to_mbcs` / `mbcs_to_utf16be` | musl's CP932 is wrong (§3) |
| N11 (1) | ccct.cpp | `ccct_getcodepage(CHARSET_DEFAULT)` = 932 | the XML / HTML writers declare Shift_JIS over CP932 bytes (§3.4) |
| Y2 (1) | basis.cpp | `request` frees its input | the ABI; 1 KB leaked per request |
| N6 (2) | basis.cpp | the request decoded and the reply encoded as UTF-8 | the worker speaks UTF-8 (§3.4) |
| Y3 (1) | basis.cpp | the module name from `yaya_set_module_name`, no `*.dll` scan of the ghost folder | DLLs never ship; `aya5.txt` ghosts booted in shell mode |
| Y4 (1) | basis.cpp | `hlogrcvWnd = NULL` on POSIX too | an uninitialised read in `CLog::Start` |
| N5 (1) | basis.cpp | flag shell mode (no `<module>.txt`, or no dictionary in it) | `yaya_load_status` 3: the built-in `request{EVAL(_argv[0])}` would answer raw text without SHIORI framing |
| Y17 (1) | basis.cpp | the default message language from `LANG` | `std::locale("").name()` never names it here, so every ghost logged in English |
| N2 (1) | aya5.cpp | `em_loghandler` → `EM_JS js_yaya_log` → `Module.yayaLog(text, mode)`; the shell and resume flags | D7, §11 |
| N3 (2) | aya5.cpp | `CEmSaveCopy` (before `class CAyaVMWrapper`); around `ExecuteLoad`, on a resume that is neither suppressed nor in shell mode: the save file read before the dictionary's `load` runs, the variables restored from that copy after it | D1, §8 |
| Y5 (3) | aya5.cpp | include `value.h`; `EmSave()`; the exports `yaya_set_module_name`, `yaya_save` and N4's `yaya_load_resume`, `yaya_load_status` (N4 shares Y5's anchor) | §4 |
| N1 (1) | aya5.cpp | `load`'s prologue: `setlocale(LC_CTYPE, "C.UTF-8")`, the second-load leak, the log handler | musl's wide printf needs a UTF-8 `LC_CTYPE` for STRFORM (port's Y14c, merged here) |
| Y6 (6) | lib.h, lib1.cpp | SAORI → `Module.saoriBridge`: `isBasic = false`; `EM_JS` imports; `LoadLib`, `Load`, `Unload`, `Request` | no `dlopen` or `fork` in a browser; Satori's stand-ins |
| N10 (2) | log.cpp | `CLog::Io` / `IoLib` return at once | no request/response log: `iolog` defaults on, 2 blocks per OnSecondChange |
| Y7 (1) | sysfunc.cpp | STRDIGEST hashes UTF-16LE | Windows' digests (`wchar_t` is 4 bytes here) |
| Y8 (1) | yamltoml.cpp | YAML/TOML `\U` escapes as surrogate pairs | 4-byte `wchar_t` |
| Y9 (2) | messages.cpp | built-in message tables (`messagetxt_builtin.h`) | yaya.dll reads its own resources first |
| Y11 (2) | sysfunc.cpp | GETTICKCOUNT from `Module.bootEpochMs` | P7 (§10) |
| N7 (2) | sysfunc.cpp | EXECUTE / EXECUTE_WAIT return -1 | nothing runs in a browser; -1 is Windows' failure value |
| N8 (1) | sysfunc.cpp | GETENV finds no variable | Emscripten's `HOME`, `USER`, `PATH` are not the visitor's |
| Y13 (1) | sysfunc.cpp | SRAND(string) seeds from 4 UTF-16 units per 64-bit word | Windows' random sequence |
| Y14 (2) | sysfunc.cpp | STRFORM `$s` as `%ls`, `$c` as `%lc` | MSVC's printf vs musl's: `[$s]` printed one character, `$c` nothing |
| Y15 (2) | sysfunc.cpp | CHR keeps 16 bits | CHRCODE as on Windows |
| Y16 (1) | sysfunc.cpp | SPLITPATH with the Windows rules | 7 corpus ghosts use it |
| N9 (1) | posix_utils.cpp | GETMEMINFO's four fields fixed | §10 |

Dropped from port's 32: Y10's EXECUTE hook to JavaScript (N7 instead: nothing runs [decision]), Y12 (ignore the `log`
key: with a handler `CLog::Start` drops the file path anyway, `log.cpp:70-72`) and Y14c (merged into N1).

**J1** (`JS_PATCHES`, 3 expressions; build-info `jsPatches: 3`) changes the linked
`yaya.js`, Emscripten's MEMFS, not YAYA. With `-sCASE_INSENSITIVE_FS` the FS layer finds a node in any case, but
MEMFS's `unlink` and `rmdir` delete `parent.contents[name]` in the caller's case: `FDEL('var/NOTE.TXT')` of
`var/Note.txt` (Windows allows it) would leave `Note.txt` listed with its node gone, so FENUM would skip the folder's
other files and the worker's scan would throw ENOENT on every later report: nothing would reach IndexedDB for the rest
of the session, the Close save included [measured]. `RMDIR('VAR')` does the same, and so does `rename` over a file of
another case (FRENAME overwrites on POSIX, `sysfunc.cpp:3048`, where Windows' MoveFile fails). J1 makes each delete
the key of the node it removes, its `name`. `scan()` also drops a name listed without its node, so a stale one counts as
gone [code]. The wasm is unchanged (bit-identical after the J1 rebuild); `yaya.js` went from 90,000 to 90,073 bytes
[measured].

---

## 6. MEMFS layout (the SSP view)

```
/ssp/                                    SSP's folder (= ghost/master/../../../../)
/ssp/ghost/                              FENUM('..\..\..'): the site's ghosts, in NTFS order
/ssp/ghost/<other id>/ghost/master/descript.txt
                                         made for every other site ghost (sspDescript): charset,UTF-8 / type,ghost /
                                         name / sakura.name / kero.name / craftman / shiori, one line each
/ssp/ghost/<id>/                         this ghost's root, the persistence root
    install.txt, readme.txt, updates2.dau, shell/<sid>/descript.txt, surfaces*.txt, a bundled balloon's text …
                                         with their bytes (YAYA_TEXT, at most 4 MiB)
    shell/<sid>/surface0.png, *.pna, sounds …
                                         0-byte placeholders: FOPEN, FSIZE, FENUM see them
/ssp/ghost/<id>/ghost/master/            the path given to load(); coreinfo.path
/ssp/balloon/<balloon id>/               empty folders, one per site balloon
/tmp /home /dev /proc                    Emscripten's own; reachable only by climbing above /ssp
```

- Relative paths work as in an SSP install (`ToFullPath` + `posix_path` from `ghost/master/`, `basis.cpp:454-467`):
  emily4's `../../updates2.dau` (`aya_menu.dic:129-130`), junior's `../../notelog/`, ria's test of
  `../../shell/<n>/surface0.png`; `../../../` lists the site's ghosts, which is what the templates' installed-ghost scan
  reads (emily4 `yaya_shiori3.dic:1232-1317`) [code].
- **Which files** (`yayaFilePlan` in `src/core/engine-files.js`, over the ghost root's manifest): `YAYA_SKIP` never
  (`profile/`, `*_variable.*`, `*.log`, `*.dll`, `*.exe`: personal or useless, and already kept off the site by the
  guard); `YAYA_TEXT` (`txt dic ayc aym ini csv dau json xml yaml yml toml htm html m3u`) up to 4 MiB (the pack's cap)
  with their bytes; every other file an empty placeholder. Over the 26 ghosts' `ghost/master`: `.dic` 380, `.txt`
  157, `.ayc` 4, `.dau` 11, `.m3u` 1; the rest is media, DLLs, `.exe`, `.ico` or logs [measured, plan]. The runtime
  copies every buffer (GhostFiles shares one per path, and the init message transfers it) and makes a file it cannot
  fetch a placeholder, at warn [code]. They all come from the ghost's text pack: for a YAYA ghost `index_site.py`
  packs every `YAYA_TEXT` file (`YAYA_PACK_EXT`), readmes and update lists too, which other ghosts' packs leave out;
  without them emily4's start would fetch 4 files one by one on every page [code, measured].
- **Write order**: placeholders, the site's files over them, then the visitor's (a tombstone removes, a copy
  shadows), in one NTFS-ordered pass, so FENUM lists a folder as Windows does, persisted and placeholder files included
  [code]. Satori keeps its own layout (`/ghost/master/`, WASM §7.1).
- **Names**: the ghost id becomes one folder name (`/` and `\` → `_`; `''`, `.`, `..` → `_`). `-sCASE_INSENSITIVE_FS=1`
  makes lookups case-insensitive as on NTFS (unpatched, `dic/MAIN.DIC` against `Dic/main.dic` suppressed a whole ghost
  [measured, port]); J1 (§5) makes MEMFS remove a deleted, removed or replaced name in its own case.
- **Known differences**: placeholders have size 0 and the page load's mtime (only existence matters to the corpus'
  uses [code]); `coreinfo.path` is POSIX-shaped, so emily4's Lilith developer feature that parses `\ghost\master\` out
  of it stays inert (`aya_lilith.dic:374`) [code]; files written outside the ghost root last for the page (§7).

---

## 7. Persistence

- **Store**: IndexedDB `sumika`, key `ghost:<id>:files`, written by the worker, as for Satori. Keys are
  ghost-root-relative (`ghost/master/yaya_variable.cfg`, `ghost/master/var/x.txt`, `notelog/a.txt`).
- **Values**:
  - bytes: the visitor's copy, written over (shadowing) any shipped file of that name, so a ghost that rewrites a
    shipped dictionary keeps its own version [decision, D4];
  - `null`: a tombstone, a shipped file (or placeholder) the ghost deleted; it is not written at init, so the file
    stays deleted;
  - `false` (in a report only): a file of its own the ghost deleted; `mergeFiles` removes the key.
  - `hasSave` ignores tombstones: a store of tombstones only is no save (a cold engine load, OnFirstBoot).
- **What persists**: every regular file under the ghost root that is new or changed since the last report:
  `<module>_variable.cfg` (or `.cfg.ays` with `save.encode`), FWRITE / FCOPY output, files in folders MKDIR made,
  SQLite databases (and `-journal` while open), rewritten dictionaries, `SAVEVAR(name)` files. Changed = another stamp
  (`mtime:size:inode`, so a file renamed over another, or deleted and written again, counts), or, for a file stamped in
  the millisecond of the last report, other bytes (FNV-1a): MEMFS takes mtimes from `Date.now()`, so a rewrite later in
  that millisecond keeps its mtime, and a coarse or frozen clock (Firefox's resistFingerprinting rounds to 100 ms; the
  sweep's `followClock`) widens that window [code; the engine test freezes `Date.now`]. Only files of that millisecond
  are read for it.
- **Not persisted**: `*.log` (a `log,` key's file; with the handler YAYA writes none anyway); folders: only files are
  scanned, so an empty folder MKDIR made is gone on the next page, and the parents of a stored file are made again
  [decision to revisit; harmless for the corpus: bee and junior write right after MKDIR]; anything outside the root
  (`/ssp/ghost/<other>/`, `/tmp`), which lasts for the page [decision].
- **When**: after every request that wrote a file (the ghost's own SAVEVAR / FWRITE; the base marks
  itself `dirty` at the FS calls that write, `watchWrites` in ssproot.js, and a request that wrote nothing costs no
  scan: emily4's 291 files took about 4 ms by path, 0.4 ms by the node walk the scan uses [measured, Node]); the
  worker's throttled save (`yaya_save` plus the
  changes; at most once a second, every 30 s while a save costs more than 50 ms, WASM §7.3); `persist` at page hide
  (best effort); `unload` at Close, ghost change and Quit (the dictionary's `unload`, then `SaveVariable`).
- **What `load` wrote or deleted** is the first `changedFiles()`, which the worker calls and stores right after init:
  the first report compares with the scan taken before `load`. emily4's template moves an old `aya5_variable.cfg` to
  the module's own save on a first boot (`RESTOREVAR`, `FDEL`, `SAVEVAR`, `yaya_shiori3.dic:98-107`); reporting only
  the deletion would leave a store with the old save deleted and the new one missing until the first scheduled save,
  so a page closed within that second would come back with no variables and play OnFirstBoot again [measured]. On a
  resume, when `load` wrote anything, `init` calls `yaya_save` before that report: N3 restored the saved
  variables in memory only, and a save `load` wrote (cyau_cyaka's) would otherwise be stored with `load`'s values.
- **Personal data**: the site never holds `*_variable.*`, `*.log`, `profile/` or a `PERSONAL_PATHS` file (the indexer
  refuses, add_ghost skips), and the runtime skips them again (`YAYA_SKIP`).
- Measured [browser check]: after emily4's first page IndexedDB holds only `ghost/master/yaya_variable.cfg`; after
  Close it has `ghostupmin_last` updated and no `ghostbootmin` (her `unload` erases it), as in SSP. nodepsimoon stores
  `ghost/master/aya5_variable.cfg`.

---

## 8. Resume

A page navigation, another tab's takeover and a crash restart are not a boot (SUMMARY §2.5). Satori skips its boot
count with `satori_load_resume` (WASM §7.4). YAYA's boot effects live in the dictionary's own `load` function, which
must run to build the ghost, so a resume restores the save a second time after it (D1).

| Step | Cold boot (new tab, ghost change, relaunch, first meeting) | Resume |
|---|---|---|
| Runtime | `resume = false`; `bootEpochMs = now` stored | keeps `bootEpochMs`; sends the stored engine state `{dicStamp}` |
| Worker | `init(…, {resume: false})` | `resume && hasSave(persisted)`; without a save, a cold engine load |
| Engine | `_load`: `Configure` restores the save (`basis.cpp:354-357`), then the dictionary's `load` runs (emily4: boot count +1, `ghostbootmin` = now, talk timer reset, `SAORI.DllList` emptied, OnSystemLoad / OnGhostLoad; `yaya_shiori3.dic:79-196`) | `_yaya_load_resume`: the same, then **every saved variable gets its saved value back** (N3): the boot count, the cold boot's `ghostbootmin`, `SHIORI3FW.LastAITalkTime`, counters, `SAORI.DllList` … Variables only `load` makes keep `load`'s values. `load`'s other effects stay: the function table, SAORIs `load` loaded, `SETSETTING` values back to the config's. |
| Clock | GETTICKCOUNT ≈ 0 | GETTICKCOUNT goes on from the cold boot |
| Events | NOTIFY batch, then OnBoot / OnFirstBoot (`firstBoot = !hadSave`) | NOTIFY batch, no OnBoot; the stored run, timers, boxes and music replay |

- **N3 restores from a pre-load snapshot.** Before the dictionary's `load` runs, `CEmSaveCopy` reads the save file
  (`<module>_variable.cfg` and its encoded `.ays`) into memory; after `load` it writes that copy to
  `/tmp/sumika-resume-<name>` (outside the ghost root, so never persisted), restores the variables from it and deletes
  it (also when the restore throws). No save before `load`: no second restore; a copy that cannot be written: the file
  as `load` left it [code]. The first N3 (packages A–D) read the save file again after `load`; a ghost whose `load`
  saves (cyau_cyaka's `OnSystemLoad.INIT` runs `SAVEVAR()`, `cya_shared.dic:100`) had overwritten it with `load`'s
  values by then, so 16 of its saved values, `ghostbootmin` and `SHIORI3FW.LastAiTalkTime` among them, were lost on
  every resume [measured, sweep Y1]. Revised since (the Y1 numbers in §14 predate it): the engine test resumes
  a fixture whose `load` calls `SAVEVAR()` over two pages, and the smoke does the same with a plain and an `.ays` save,
  checking that nothing is left in `/tmp`.
- **The dictionary stamp.** The second restore also brings back caches `load` builds from the function table: emily4's
  `array_eventtranslate` / `array_translateinternal` come from `GETFUNCLIST` (`yaya_shiori3.dic:168-169`) and only
  `unload` erases them. After a site update of the dictionaries they would be stale until the next cold boot. So
  `init` computes `dicStamp` (32-bit FNV-1a over path, length and bytes of every shipped file under `ghost/master/`,
  in NTFS order); `getVolatileState()` → `{dicStamp}` reaches the ghost state's `engine` with every response; and a
  resume whose stored stamp differs runs a plain `_load`, logging "dictionaries changed since the last boot: loading
  as after an update" at info, as SSP reloads the SHIORI after a network update [decision]. A state without a stamp
  keeps the resume. Skipping the names `unload` erases was rejected: that list also holds `ghostbootmin` and
  `LastAITalkTime`, which D1 must restore.
- **What a mid-session save holds**: `yaya_save` writes every global variable that is not empty or erased, with its
  value of the moment, including transient ones the template's `unload` would erase (`var.req.*`, `SAORI.DllList`,
  `ghostbootmin`, `LastAITalkTime` …); that is what lets a resume bring `ghostbootmin` back. The real `unload` at Close
  overwrites it (erasing those and updating `ghostupmin_last`, `yaya_shiori3.dic:214`). A stale `SAORI.DllList` entry is
  harmless: `FUNCTIONLOAD` appends only when `LOADLIB` returns 1, so the worst case is a duplicate that `UNLOADLIB`
  unloads twice (the second call is a no-op) [code].
- **Lost against SSP**: changes since the last stored save (≤ 1 s, or the best-effort page-hide save); open FOPEN
  handles and positions; SQLite connections (the files stay); SAORI stand-in state; `SETSETTING` changes made at run
  time. A session ended by closing the tab (no `unload`) never adds its uptime to `ghostupmin_last`; and the template's
  uptime (`ghostbootmin = GETSECCOUNT()/60`) is wall clock, so time spent on other sites counts, unlike Satori's P7
  total [decision to revisit].
- Measured: in the browser emily4 kept `ghostuptimes,1` and `ghostbootmin` unchanged over 3 navigations, her
  OnFirstBoot run replayed and went on [measured, browser check]; the sweep's resume check is in §14; the engine and
  integration tests check the boot count, the restored values and the stamp (§12).

---

## 9. Boot failure and emergency

| `yaya_load_status()` | Meaning | `init` | Sumika's log line, at warn |
|---|---|---|---|
| 0 | normal | true | — |
| 1 | emergency: the normal parse failed and `<module>_emerg.txt` loaded (`aya5.cpp:69-93`, `IsEmergency`) | true: it boots, as in SSP | `emergency mode: <module>_emerg.txt answers` |
| 2 | suppressed: nothing usable (the normal parse failed, and there is no emergency config or it failed too) | false | `nothing usable loaded (dictionary errors; details with ?sumika-debug)` |
| 3 | shell mode: no `<module>.txt`, or it lists no dictionary (N5) | false | `no <module>.txt or no dictionary: the index's module is wrong or the ghost has no config` |
| -1 | no VM | false | `load() left no engine` |

A false `init` → `{t:'loaded', ok: false}` → `ShioriClient.start` throws → the runtime's failed-boot path, as for
Satori. YAYA's own lines (file, line, error code) stay at debug (§11), so `?sumika-debug` shows why. In the corpus only
emily4 ships an emergency config [measured, corpus].

---

## 10. OS stand-ins

| Function | Behaviour | Where |
|---|---|---|
| EXECUTE, EXECUTE_WAIT | -1 (Windows' failure value: ShellExecute ≤ 32, a failed CreateProcess); nothing runs, URLs do not open | N7 [decision] |
| SAORI-basic (`.exe`) | offered to the bridge; no stand-in → `LOADLIB` 0 | Y6 |
| GETENV | every name unset: `""`, warning 12 and `GETLASTERROR` 12, Windows' unset path (`sysfunc.cpp:7952-7957`). `ENV.LANG` still serves Y17 and the locale inside | N8 [decision] |
| GETMEMINFO | `45, 8589934592, 4724464025, 2147352576, 1717986918`: an 8 GiB PC running a 32-bit process (load %, physical total / available, virtual total / available). YAYA computes the 45 itself, `(total − avail) × 100 / total` in integers (`sysfunc.cpp:4978-4981`) | N9 [decision] |
| GETTIMEZONE, `coreinfo.timezone` | the browser's IANA zone (`ENV.TZ` in preRun); local time is the JS Date's | yaya.js |
| GETTICKCOUNT | ms since the ghost's last cold boot (P7's rule), never going back | Y11 |
| FENUM and paths outside the ghost | the SSP view (§6) | yaya.js |
| READFMO, DIRECTSSTP | fail cleanly: ninix's shared memory and socket are absent [measured, port] | — |
| SLEEP | busy-waits in the worker (10 → 10.2 ms) [measured, port] | — |

---

## 11. Logs

- Every VM, normal and emergency, gets `em_loghandler` (N1, N2): each fragment goes to `Module.yayaLog(text, mode)` as
  UTF-8. Modes (`messages.h:20-29`): 0 info, 1 fatal, 2 error, 3 warning, 4 note, 5 other; 6 (end) and 16/17/32
  (charset markers) carry no text and are dropped.
- `YayaEngine` joins the fragments into lines (`LogLines`: blank lines dropped; flushed after load, after each request
  and at unload), each with its first fragment's mode. fatal / error / warning / note → `log('debug', 'yaya <mode>:
  <line>')`, which reaches the page console only with `?sumika-debug`, and `onEngineLog`; info and other →
  `onEngineLog` only. The sweep keeps `onEngineLog` as `engineLog` (at most 300 lines).
- Request/response logging is off (N10). With a handler set, `CLog::Start` drops the `log` key's file (`log.cpp:70`),
  so `log, x.log` writes nothing [measured, smoke].
- emily4's load logs 79 info fragments and 1 note, N0000 "前回実行時の変数値の復元は行われませんでした" (no save yet: a
  first boot) [measured, package A].
- Sumika's own lines: at warn only what decides a boot (§9) and a ghost file the runtime could not fetch; at debug the
  engine's one-line summary after load and the runtime's `engine yaya loaded in N ms` (§13).

---

## 12. Test plan

| Where | What |
|---|---|
| `node engines/yaya/smoke.mjs [DIR]` | 19 checks straight on the C exports of a build in any `--out`: shell mode; `version` = Tc606-2; module aya5; a broken dictionary → 2 with a mode-2 log line, with `yaya_emerg.txt` → 1; `yaya_save`; a resume keeps the boot count, also when `load` calls `SAVEVAR()` (plain and `.ays` save, two pages, nothing left in `/tmp`; added with N3's revision); `GETSTRBYTES` 8; Shift_JIS FWRITE with best fit; GETTICKCOUNT from `bootEpochMs`; EXECUTE -1; GETENV; GETMEMINFO; FWRITEXML declares Shift_JIS; UTF-8 after `SETSETTING('charset.output','Shift_JIS')`; `log, x.log`; SAORI; 20,000 requests leave a malloc probe in place. All passed on -O2, -Oz and debug at package A, and all 19 on the published build after N3's revision [measured]. |
| `tests/runtime/engine_files.test.mjs` (5), `yaya_helpers.test.mjs` (5) | `yayaFilePlan`, `yayaModule`, `yayaSite`, Satori's list unchanged; the site's YAYA packs hold every file the worker gets with bytes, and `index_site.py`'s `YAYA_PACK_EXT` = `YAYA_TEXT`; `rootBridge`, `sspDescript`, `LogLines`, `diffScan`, `dicStamp`. |
| `tests/runtime/worker_save.test.mjs`, `shiori_client.test.mjs`, `runtime.test.mjs` | `mergeFiles`, `hasSave`, `init`'s `engineOpts` and `volatile`; `errorText` (an `ErrnoError` thrown by a report is logged by its errno); `engineOpts` in the init message; `_startEngine` for a YAYA ghost, and the copy test (a transferred buffer leaves the readme window and a crash restart intact). |
| `tests/runtime/sweep_views.test.mjs` | The engine rule (`detectEngine`, `ayaConfigKind`, the config walk, comments and charsets, `sweepEngine`), and `engine` / `module` of every site ghost against `ghosts.json`. |
| `tests/yaya_engine.test.mjs` (17) | `YayaEngine` on the real build with the fixture `tests/fixtures/ghost/yayatest`: load status and the warn lines; module aya5; the request buffer over 5,000 requests; UTF-8 transport; CP932 (§3.4); persistence (new files beside `ghost/master`, a shadowing rewrite, `null` / `false`, never `*.log`); FDEL / RMDIR in another case and FRENAME over a file in another case (J1), a stale name dropped; a rewrite in place and a rename over a file under a frozen `Date.now`; the first report of a `load` that moves an old `aya5_variable.cfg`, cold and on a resume; resume and the stamp, and an empty MKDIR folder not reported; a resume whose `load` calls `SAVEVAR()` (N3), over two pages, its first report holding the restored values; GETTICKCOUNT; SAORI; logs; the OS stand-ins; the SSP view; ENV. |
| `tests/runtime/yaya_integration.test.mjs` (1) | `EventLoop` and `YayaEngine` in-process: a first meeting (NOTIFY batch, OnFirstBoot), a menu and a choice, random talk, communicate, Close and its save, the next page's resume (no OnBoot, the boot count unchanged), a later cold boot. |
| `tests/engine_adapter.test.mjs` | Satori's S1 / S2 (§3.3). |
| `tests/yaya_vs_dll.mjs` + `tests/corpus/emily4/` (not in `npm test`) | emily4's 631 requests against her own `yaya.dll` Tc571-15 (`tools/dll_harness.ps1 -Charset UTF-8`, on a scratch copy of the site ghost): the same status on 631 of 631, 621–622 identical values, 6–7 identical except the menu padding (§3.4), 2–4 different (`version`, random choices) [measured, package D]. A regression net, not an oracle. |
| The ghost sweep (not in `npm test`) | §14. |

No YAYA test skips: without the build they fail with "run python engines/yaya/build.py". `npm test` then:
639 tests, 0 failed, 0 skipped.

---

## 13. Sizes and timings

Sizes in bytes (gzip -9 / brotli 11) [measured, package A; the last two rows after N3's revision and J1]:

| Build | wasm | gz | br | js (br) |
|---|---|---|---|---|
| YAYA -O2, package A (the browser check's) | 2,599,688 | 983,557 | 755,125 | 90,000 (22,508) |
| YAYA -Oz (scratch only) | 1,698,856 | 761,949 | 600,544 | 88,716 (22,279) |
| Satori -O2, for comparison | 775,918 | 282,762 | 218,610 | 85,695 (21,761) |
| YAYA -O2 with N3's revision (43 patches) | 2,602,424 | 984,877 | 756,210 | 90,000 (22,508) |
| YAYA -O2 with J1 too (published; the same wasm) | 2,602,424 | 984,877 | 756,210 | 90,073 (22,552) |

SQLite is about 0.9 MB of it: in the research build a link without `sqlite3_yaya.o` gave 1,660,762 bytes against
2,605,345 with it [measured, port].

emily4 in Node 24 (`ghost/master`: 96 files, 993 KB; personal files skipped by name), two runs per build [measured,
package A]:

| | -O2 | -Oz |
|---|---|---|
| module init | 19–20 ms | 16 ms |
| `load` | 176–189 ms | 187–199 ms |
| OnBoot | 6 ms | 7.6–10 ms |
| a double-click | 8.9–9.3 ms | 10.1–10.4 ms |
| OnSecondChange, average (max) | 0.41–0.47 ms (1.2–1.6) | 0.59–0.60 ms (1.3–2.0) |
| `yaya_save` | 0.9–1.2 ms | 1.1–1.2 ms |
| heap | 32 MB (`INITIAL_MEMORY`; it never grew) | 32 MB |

In the browser (Chromium, `?sumika-debug`: the engine's debug line and the
runtime's `engine yaya loaded in`) [measured, browser check]:
- emily4's cold boot from Tsubasa (the wasm's first fetch): module 140 ms, load 250 ms, stamp 31 ms, heap 32 MB,
  69 files with bytes (1,023 KB), 221 placeholders; loaded in 495 ms.
- page2 (a resume), three runs each, ms:

  | | module | load | module + load | loaded in |
  |---|---|---|---|---|
  | -O2 | 46 / 40 / 47 | 250 / 209 / 240 | 296 / 249 / 287 | 377 / 329 / 369 |
  | -Oz | 39 / 41 / 33 | 236 / 220 / 217 | 275 / 261 / 250 | 344 / 326 / 314 |

  -Oz's cold boot: module 59, load 223, loaded in 349 ms.
- Two YAYA ghosts at once (emily4 and bonsyou): the page's JS heap 12 → 16 MB (`performance.memory`); each worker's own
  memory comes on top and was not measured.

**-O2 is kept.** The rule, set before measuring [decision]: take -Oz only if its module + load time on page2 is at
least 20 % lower **and** no request in Node takes more than 1.5 × its -O2 time or more than 100 ms. Measured: about 5 %
lower (262 against 277 ms on average), while requests are about 1.3–1.4 × slower (OnSecondChange 0.59–0.60 against
0.41–0.47 ms). -Oz would save 155 KB of brotli download (600 against 755 KB). Revisit on a slower machine, or if the
download matters more than the requests (§15).

---

## 14. The sweep

YAYA run **Y1** (26 ghosts in 59 s):

```bash
node tools/sweep.mjs <archive folder> \
  site/ghost/emily4 --engine yaya --out <scratch dir>
```

- 0 runner failures, 0 engine crashes, 0 SHIORI request errors, no request over 300 ms [measured].
- **Engines** (`sweepEngine`): 19 `yaya`/`yaya` (the 18 `yaya.dll` archives and emily4) and 5 `yaya`/`aya5` by the
  descript; cyau_cyaka `yaya`/`yaya_jp` (lang_switch's Japanese module) and nibihada `yaya`/`aya` (gcore's `aishiori`)
  by the sweep-only override.
- **Load status**: 24 normal; raychel_kisekae and ure_c suppressed (2), listed under "Load status", not as runner
  failures. Tc606 is stricter than their own DLLs: raychel_kisekae calls an undefined `GetEvalTalkArrayEX()`
  (`aya_lilith_config.dic:104`, E0071 at parse time, `parser0.cpp:2329`); ure_c ships a truncated
  `longtalk/ure_longtalk_haydn_sym_082.dic` (it ends inside `{{CHAIN`, E0094). Neither has an emergency config.
- **Resume** (§8: a fresh engine resumed from the stored files must save the same variables): 23 of 24 got every
  saved value back. cyau_cyaka lost 16, because its `load` saves; that is what N3's pre-load snapshot is for, and this
  run predates it. With the snapshot (sweeps Y2 and Y3): 24 of 24, 0 saved values lost, the same 24 load. Variables only `load` makes, which keep `load`'s value by design: bee `reference` and `marker`,
  bonsyou `AYATEMPLATE.LastTalk`. The stamp reload (one shipped dictionary changed) loaded as after an update and
  answered `version` for 24 of 24.
- **SAORIs without a stand-in** (8 in 6 ghosts): bln (ria), hotkey and weirds (flele), osuwari
  (the_Cassini_Division), sa (nibihada), saori_ip and uds (cyau_cyaka), screenshot (bee). Engine warnings: W0013
  `LOADLIB` for those 6 ghosts; W0008 / W0009 (missing or wrong arguments) in maya, raychel_rest_cos, ria,
  the_Cassini_Division and cyau_cyaka. Every ghost logs N0000 on its first load (no save yet).
- **Unsupported script tags** (22 in 11 ghosts): `\![open,readme]` 4, `\![reload,shiori]` 3 (supported in
  later runs, EV §2.10), `\![execute,http-get]` 2,
  `\![execute,http-post]` 2, one each of `\![execute,install]`, `\![executesntp]`, `\![open,configurationdialog]`
  (emily4; handled in later runs: the Preferences box), `\![open,rateofusegraph]`, `\![open,shellexplorer]`,
  `\![updatebymyself]` (emily4) and `\v`, plus nibihada's gcore tags (`\F`, `\k[N,N]`, `\L`, `\S`).
- Boxes: communicate in 24 ghosts, text input in 14.
- In the sweep a YAYA ghost's `Date.now` and `performance.now` follow the fake clock from the stage on
  (`followClock` in `tools/sweep/ghost.mjs`): the templates time random talk with `GETSECCOUNT`, and without it no YAYA
  ghost talked in 600 fake seconds [measured, package D]. That is `--clock real`; by default the
  sweep's fixed clock does it for every engine from its boot on, from 2026-10-07 20:00:00 (ghost-sweep.md "The clock").

YAYA run **Y3** (with N3's revision, J1, the first report, the stamps, the resume check's store rebuilt from the
engine; the same command, 26 ghosts) [measured]: 0 runner failures, 0 engine crashes, the same engines and load
statuses. Resume: 24 of 24 got every saved value back, cyau_cyaka too;
variables only `load` makes: bee `reference` and `marker`, bonsyou `AYATEMPLATE.LastTalk`, cyau_cyaka `GhostLastBoot`;
the stamp reload worked for 24 of 24. Two engine-log keys moved against Y1: ria's W0009 `REPLACE`
(`t_aitalk.dic:16`) was missing, raychel_rest_cos had E0032 `shiori.OnCallLimit` / E0097 (call depth,
`aya_aitalk.dic:301`). Both come from random talk: the two ghosts alone, three runs, gave ria's W0009 in 3 of 3 and
raychel_rest_cos's E0097 in 1 of 3.

Satori, swept again for this work (247 archives; **S0** before anything, **S1** after the shared table with the old
runner, **S2** with the new engine choice, `--engine satori`; then **S2b** once a concurrent runtime change had settled)
[measured]: 247 ran = 233 by the descript + 14 by `satori.dll`, all to the end; SAORI 54 in 37 in every run; unknown
tags, request errors and warnings within the run-to-run noise (S2b: 30 in 27, 90 in 46, 218 in 102; S0: 28 in 25, 91 in
46, 217 in 101). Every key that moved also moves between two identical runs, or comes back when the ghost runs alone.
One run had an intermittent Satori `unreachable` in souzou_syoka, which the old and the new runner each showed in 1 of
29 runs side by side.

---

## 15. Checks in ssp.exe and decisions to revisit

Compare in ssp.exe (emily4, bonsyou and NodePsimoon are installed); the findings go here as `[observed]`:
1. emily4's boot talk and double-click menu: the same items and the same Japanese, no `?` or `・` where SSP shows
   ～－＼①. On a PC with ANSI code page 1252 (§3.4) her menus are wider in ssp.exe: compare the text, not the widths.
   So far: she comes up fine [observed]; the menu text not compared item by item yet.
2. emily4's random-talk rhythm, and communicate. Here every communicate reply is 204: her `OnCommunicate` calls
   `OnCommunicate_User`, which no dictionary defines (`aya_communicate.dic:57`); the same in SSP [infer].
3. emily4's goodbye at Close.
4. ~~Whatever emily4 shows of her boot count or uptime~~: dropped, as neither program shows them readily
   [observed]; checked instead in her save in Sumika: unchanged over page changes (a page change is not a boot).
5. emily4's first boot ends with `\![open,configurationdialog,setup]` (SSP's settings dialog, where the user enters a
   name). It opens Sumika's Preferences box (UI §2.13; EV §4.16). Why her name was empty: her
   framework sets `SHIORI3FW.Status = 'Run'` on any non-empty reply to the boot `GET version`
   (`system/yaya_shiori3.dic:835-836`), so OnFirstBoot's default `ユーザーさん` (`aya_bootend.dic:9-11`, only while
   Status ≠ Run) is skipped, and only an OnNotifyUserInfo with a non-empty R0 names the visitor
   (`aya_systemex.dic:510`) [probe]. SSP always sends one (its nickname defaults to the Windows name);
   Sumika sends one once the visitor has saved the box [decision], so a visitor who types a nickname
   and closes the box is named at once, and one who closes it empty stays nameless ("\uもあまり無理しないでね。").
   What does SSP show, and what does she say after it? (CLAUDE.md "Not yet confirmed in ssp.exe".)
6. bonsyou: the double-click; its sound and counter features (OnMouseGesture is sent, EV §4.5.1:
   a right drag left then right across the bell rings it, then not again until the gong's end sends OnSoundStop
   (EV §4.17), which clears its `GongLock` and asks for the gong counter (`tests/runtime/http.test.mjs`
   on the real engine); its `\![execute,http-get]` is sent, EV §4.15). The menu's 今まで撞かれた数 fetches
   `http://ms.shillest.net/resource/bonsyou_count.txt` into `var/bonsyou_now.txt` and OnCountCompleteMenu reads it,
   in a browser only where the page may fetch an `http://` URL (an `http://` page such as `localhost`, not an
   `https://` site) and only if that host answers with `Access-Control-Allow-Origin` (unknown [guess]); otherwise the
   Failure event comes, which bonsyou does not define (nothing is shown). What does ssp.exe show there?
7. NodePsimoon side by side (installed in SSP as `ghost/NodePsimoon`).
8. About Sumika lists YAYA and its parts, DEELX among them; DEELX's header says only "All Rights Reserved" (not
   reviewed further); Satori has contained DEELX all along.
9. In ssp.exe emily4's お役立ちメニュー → カレンダー opens SSP's calendar window; in Sumika nothing happens
   [observed]. Her reply holds `\![open,calendar]` (`aya_menu.dic:903`), which Sumika treats as a
   no-op that logs, like every `\![open,…]` window of SSP's own (SS §5.9, "any other `\![open,…]`"). A calendar would be
   a new browser window of Sumika's own; none is planned.

Decisions to revisit [decision]:
- Shell mode fails the boot (D2).
- A mid-session save carries the template's transient variables (D1). Uptime across tab closes is lost from
  `ghostupmin_last`, and the template's uptime counts time away (wall clock), unlike Satori's P7 total.
- The second restore brings back caches `load` built (emily4's event lists). That is right while the dictionaries are
  the ones that built them; after a site update the stamp turns the resume into a plain `load` (boot count +1, uptime
  since boot restarts, as SSP's reload after a network update). A ghost whose `load` caches something derived from data
  outside `ghost/master` would not be caught; none is known.
- An empty folder MKDIR made is not kept (§7); a marker key would fix it if a ghost needs one.
- GETTICKCOUNT is the ghost's age, not the PC's; GETMEMINFO's constants; GETENV empty; EXECUTE -1 (no URL opens).
- A rewritten shipped file shadows site updates for that visitor for good; a "forget this ghost in this browser" item
  would be a non-SSP addition and is not made [decision].
- Files written outside the ghost's own folder are not kept.
- `coreinfo.path`, and SPLITPATH of it, are POSIX-shaped.
- `firstBoot = !hadSave`: a YAYA ghost with `save.auto,off` that never writes a file gets OnFirstBoot on every cold
  boot. SSP decides first boot from its own profile; a rule from the runtime's state would change Satori too.
- The index: `lang_switch` and `gcore` unsupported on the site (Kawari has its rule: `kawarirc.kis` → `kawari`,
  kawari-wasm.md §12);
  the 14 Satori archives without a `shiori` line run in the sweep (they ship `satori.dll`) but would be indexed as
  `shiori` (the site never has the DLL; a rule such as `satori_conf.txt` → satori when such a ghost is added).
  Sites indexed before the YAYA engine still say `engine: 'aya5'` (greyed "needs AYA") until re-indexed [infer].
- `\![reload,shiori]` (7 YAYA ghosts use it) works (EV §2.10): OnDestroy
  `reload`, the engine unloads (the worker stores its files) and a new one loads cold from the store inside the
  client's request queue (`ShioriClient.reload`), then the load's NOTIFY batch with OnInitialize `reload`.
- -O2 against -Oz (§13); `INITIAL_MEMORY` 32 MB against 16 MB (emily4's heap top after load: 9 MB [measured, port]).
- One compiled wasm module shared across ghosts and pages (not built: CLAUDE.md "Known gaps") matters more for YAYA:
  2.6 MB per YAYA worker.

---

## 16. Known gaps and open questions

- `\![open,configurationdialog,setup]` (emily4's name question) opens the Preferences box (§15 #5, UI §2.13).
  Left: emily4 stays nameless until the visitor saves a name there (no OnNotifyUserInfo before that [decision]); her
  help menu's `config,talk|display|biff|application` pages open nothing [decision]; her favourites (お気に入りゴースト
  ▸ 起動中のゴーストを追加) read `activeghostlist.*` and
  `ghostlist(…).sakuraname` / `.path` (properties.md §5.2), not yet compared with ssp.exe; her ranking stays empty (no
  `rateofusegraph`).
- `\![open,calendar]` (emily4's お役立ちメニュー → カレンダー) does nothing; ssp.exe opens its calendar window (§15 #9).
- raychel_kisekae and ure_c do not load on Tc606 (§14). An older YAYA for them, or a lenient-parse patch, would be new
  work; neither is planned [decision].
- OnSoundStop is sent, with OnSoundLoop and OnSoundError (EV §4.17): bonsyou's gong lock clears and its counter runs
  on the real engine (`tests/runtime/http.test.mjs`). `\_V` / `\![sound,wait]` do not wait (EV §4.17 known gaps).
  OnMouseGesture is sent (EV §4.5.1, SUM C31): bonsyou's gong and emily4's skirt answer it on the real engine
  (`tests/runtime/http.test.mjs`).
- `\![execute,http-get]` is sent [decision] (EV §4.15).
  The download goes into the ghost's `ghost/master/var/` in MEMFS (`writeMasterFile`, the worker's `write` message)
  before the event, so bonsyou's `FOPEN('var/bonsyou_now.txt')` reads it (`tests/runtime/http.test.mjs` runs the menu
  counter on the real engine), and it is stored per visitor as `ghost/master/var/<name>` like any file the ghost
  writes. The gong counter (`bonsyou_count.cgi`, OnCountComplete) runs: it follows OnSoundStop.
- `\![reload,shiori]` works (EV §2.10; the sweep reloads bee, mobilemaster and ria once each, ghost-sweep.md
  "Reloads").
- SAORIs without a stand-in: §14.
- `STRFORM("$e")` prints `e+04`, where yaya.dll's VC6 CRT prints `e+004` [measured, port].
- `-sSTACK_SIZE=1MB` comes from Satori (WASM §10.4); YAYA's own need was not measured. A script recursion deep enough
  to exhaust the JS stack throws out of `_request`, and that request answers 500.
- YAYA's `multi_load` / `multi_request` (several VMs in one module) could one day serve a ghost that `LOADLIB`s
  `yaya.dll` as a SAORI; no corpus ghost does (D12).

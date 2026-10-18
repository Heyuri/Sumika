# Satori (unicode branch) → WebAssembly: build & integration spec

Status: research spec, verified by a prototype build.
Scope: compile `vendor/satoriya-shiori` (unicode branch) with Emscripten into `satori.js` + `satori.wasm` for the
browser (Web Worker) and for Node tests; the JS ↔ C ABI; the patches; the Node test plan.

Priorities: **P0** = Tsubasa needs it, **P1** = common in other ghosts, **P2** = rare.

Everything marked *verified* was run here with emsdk 6.0.11 / Node 24.19 (the copy in `toolchain/emsdk`).
Prototype files (scratch, not deliverables): `docs/research/scratch/wasmbuild/` —
`u8conv.py`, `gen_cp932.py`, `apply_patches.py`, `patches.diff`, `shiori_node.cjs`, `smoke.cjs`,
`tsubasa_cmp.cjs`, `prep_tsubasa.py`.

Not in the repository: those prototype files, the corpus and its prepared ghost (`tests/corpus/`), Tsubasa's own files
and the emsdk copy in `toolchain/emsdk` (docs/building.md "What the builds need" says how to install it). These are
development material, cited as the sources (CLAUDE.md "Project rules").

---

## 0. Decisions at a glance

| # | Decision | Prio | Evidence |
|---|---|---|---|
| D1 | Build the 27 objects of `makefile.linux` **minus `SaoriHost.cpp`** (= 26 files), defines `-DPOSIX -DSATORI_DLL`. Since P8 also `SakuraFMO` and `satoriFMO` (28 files). | P0 | §2; link verified without SaoriHost |
| D2 | Convert sources CP932→UTF-8 with **Python's `cp932` codec**, *not* GNU `iconv -f CP932` (the makefiles' way). | P0 | §3.1: GNU libiconv 1.19 turns `〜` `−` into U+301C/U+2212 in 13 files; VC6 gives U+FF5E/U+FF0D |
| D3 | Delete `_/Memory.h` from the build copy and use `-iquote` (not `-I`) for `satori/` and `_/`. | P0 | §3.2: `deelx.h` `#include <memory.h>` resolves to Satori's `Memory.h` on case-insensitive disks |
| D4 | C++ exceptions are required: compile **and** link with `-fwasm-exceptions`. | P0 | §4.3: `throw`/`catch` used by `times`/`while`/`for`/`loop`; default `DISABLE_EXCEPTION_CATCHING=1` would abort |
| D5 | Do **not** use `-shared`, `--memory-init-file`, `em-pre.js`/`em-post.js`. Use `-sMODULARIZE=1 -sEXPORT_NAME=createSatori`. | P0 | §4.4 (verified errors/warnings) |
| D6 | Replace musl `iconv` Shift_JIS with a **generated CP932 table** (patch P1). | P0 | §5: musl maps 0x8160/0x817C/0x815F to U+301C/U+2212/**U+005C**, garbles ①/髙; `zen2han` breaks |
| D7 | SAORI DLLs → **JS stand-ins** via `EM_JS` bridge `Module.saoriBridge` (patch P2); `ssu.dll` stays built-in. | P0 | §6.1 (verified: GET Version + EXECUTE + unload reach JS) |
| D8 | Export `satori_load_resume` (load without `起動回数+1`) and `satori_save` (write savedata now) (patch P3). | P0 | §7.4: Tsubasa has `（起動回数）==50/100/200` talks |
| D9 | Silence Satori's stderr log spill (patch P4). | P1 | §6.2 "Logging" |
| D10 | Always send `Charset: UTF-8` in SHIORI requests; responses come back UTF-8. | P0 | §5.1 (verified) |
| D11 | Run the engine in a **Web Worker** with a watchdog; some Tsubasa requests take 1–7 s. | P0 | §10.3 measured |
| D12 | `-sSTACK_SIZE=1MB` (measured need ≈ 5 KB; default 64 KB), `-sALLOW_MEMORY_GROWTH=1`, `-sINITIAL_MEMORY=32MB`, `-sCASE_INSENSITIVE_FS=1`. | P0 | §4.2, §10.4 |
| D13 | FMO from the page (patch P8): compile `SakuraFMO` and `satoriFMO`; `（FMOn…）`, `（Xの存在）` and `（Xのサーフェス）` read `Module.fmoText`, the text the page builds of the ghosts on screen. No text: answers as before P8. | P2 | §8 P8; `tests/satori_fmo.test.mjs` |

---

## 1. Inputs and versions

| Item | Value |
|---|---|
| Satori | `vendor/satoriya-shiori`, branch `unicode`, commit `e2bf348` = **phase Mc203-6** (`gSatoriVersion`, `satori.cpp`; also returned by `GET Version`). The repository holds a copy of it and of deelx without `.git`: `COPY_OF` names the commits and `INPUTS_PIN` hashes the files the build reads (§9 step 1). |
| DEELX (regex for ssu `regex_*`) | submodule `satoriya/deelx`, commit `af1a690`. It was **not initialised** in the clone; `git submodule update --init satoriya/deelx` was run (header-only: `deelx.h`). The repo's `CLAUDE.md` says to use `--remote` before releases; for Sumika the pinned commit is fine. |
| Emscripten | emsdk **6.0.11** in `toolchain/emsdk` (emcc `a0014542`), installed from emsdk commit `96c657fc…` (docs/building.md "What the builds need"), whose manifest brings Node **24.19.0** and Python 3.13.3. |
| How to call emcc | Run `toolchain/emsdk/python/3.13.3_64bit/python.exe toolchain/emsdk/upstream/emscripten/em++.py`, with `EM_CONFIG=toolchain/emsdk/.emscripten`; this is what `engines/satori/build.py` does. The `em++.exe` launcher fails with `No module named 'emcc'`. Superseded: "`source toolchain/emsdk/emsdk_env.sh`, then `em++` (the shell script)": `upstream/emscripten/` holds only `em++.exe` and `em++.py`, no shell script. |
| Prebuilt system libs | `upstream/emscripten/cache/sysroot/lib/wasm32-emscripten` already holds `libc++-wasmexcept.a`, `libc++abi-wasmexcept.a`, `libunwind-wasmexcept.a` etc.; the prototype build linked with `EM_FROZEN_CACHE=1` (nothing is rebuilt into the toolchain cache). `engines/satori/build.py` does not set it. |

The ghost's own DLL used for the ground-truth corpus is **Satori Mc159-6 (ACP / master branch, 2018)** —
her `ghost/master/satori.dll` as installed in SSP, FileVersion `1, 159, 6, 1` (same file in both `tsu_eng` copies).
This matters for testing (§10).

---

## 2. Source list and defines

### 2.1 Comparison of the makefiles (`satoriya/satori/makefile.*`)

| Object | `.emscripten` (2016, stale) | `.linux` | `.posix` (macOS) | **Use for wasm** |
|---|---|---|---|---|
| `_/Sender` `_/charset` `_/Utilities` `_/calc` `_/calc_float` `_/stltool` `_/random` `_/mt19937ar` | yes | yes | yes | **yes** |
| `SakuraCS` `SakuraClient` `SakuraDLLClient` `SakuraDLLHost` `SaoriClient` | yes | yes | yes | **yes** |
| `SaoriHost` | **no** | yes | yes | **no** (only used by the standalone `ssu.dll` build under `SSU_SAORI_CALL_INTERFACE`, and by dead `cn.cpp`; link verified without it) |
| `satori` `satoriTranslate` `satori_AnalyzeRequest` `satori_builtin` `satori_CreateResponce` `satori_EventOperation` `satori_Kakko` `satori_load_dict` `satori_load_unload` `satori_sentence` `satori_tool` `shiori_plugin` `ssu` | yes | yes | yes | **yes** |

Final list (26 translation units):

```
_/Sender.cpp _/charset.cpp _/Utilities.cpp _/calc.cpp _/calc_float.cpp _/stltool.cpp _/mt19937ar.cpp _/random.cpp
satori/SakuraCS.cpp satori/SakuraClient.cpp satori/SakuraDLLClient.cpp satori/SakuraDLLHost.cpp satori/SaoriClient.cpp
satori/satori.cpp satori/satoriTranslate.cpp satori/satori_AnalyzeRequest.cpp satori/satori_builtin.cpp
satori/satori_CreateResponce.cpp satori/satori_EventOperation.cpp satori/satori_Kakko.cpp satori/satori_load_dict.cpp
satori/satori_load_unload.cpp satori/satori_sentence.cpp satori/satori_tool.cpp satori/shiori_plugin.cpp satori/ssu.cpp
```

Since patch P8 (§8) `satori/SakuraFMO.cpp satori/satoriFMO.cpp` are compiled too (28 units): the FMO
text comes from the page instead of a Windows file mapping.

Not compiled (Windows-only or dead, per the repo's `CLAUDE.md` and the makefiles): `SakuraFMO`, `satoriFMO` (until
P8), `SSTPClient`, `ShioriClient`, `WinMain`, `main`, `cn`, `TimeCommands`, `SakuraScript`, and everything else in `_/`
(`Socket`, `Window`, `FTP`, `bregexp`, …). Note `file name case`: the repo's notes say to write file names exactly as in git
(`satori_CreateResponce.cpp` has a capital C).

### 2.2 Defines and language level

| Flag | Why |
|---|---|
| `-DPOSIX` | selects every POSIX branch (dirent, `fopen` on UTF-8 paths, `/` separator, `FILE_NEWLINE "\n"`, POSIX exports `load/request/unload` taking `char*`) |
| `-DSATORI_DLL` | builds the SHIORI DLL personality (as all makefiles do) |
| `-std=c++11` | sources use `nullptr` (`_/random.cpp`) — c++11 is the minimum the makefiles use. (C++17 would also compile but is untested.) |
| `__EMSCRIPTEN__` | predefined by clang; Sumika's patches key on it. (The old `EMSCRIPTEN` macro is deprecated in 5.0.4+, ChangeLog.) |
| *(not)* `SSU_SAORI_CALL_INTERFACE` | must stay undefined: ssu is then a `SaoriClient` called directly by Satori (`ssu.cpp`, `#ifndef SSU_SAORI_CALL_INTERFACE`). |

Warnings seen (harmless): `-Woverloaded-virtual` (SakuraDLLClient/SaoriClient), unused variables. Add
`-Wno-unknown-pragmas -Wno-overloaded-virtual` to keep the log readable. Compile of all 26 files: ~60 s with 8 jobs
on one desktop machine (verified).

---

## 3. Preparing the sources

### 3.1 Encoding conversion — use Python `cp932`, not GNU iconv (P0)

The sources are Shift_JIS + CRLF (`CLAUDE.md`: "ソースは Shift_JIS + CRLF を維持する"). clang needs UTF-8 for
`L"..."` literals, so a converted copy is compiled (the makefiles do `iconv -f CP932 -t UTF-8` into `utf8src/`).

**Do not use GNU iconv for this.** Verified with `iconv (GNU libiconv 1.19)` from Git Bash:

```
printf '\x81\x60\x81\x7c\x81\x61' | iconv -f CP932 -t UTF-16BE   ->  301C 2212 2016
python: b'\x81\x60\x81\x7c\x81\x61'.decode('cp932')                ->  FF5E FF0D 2225   (= Windows/VC6)
```

13 of 131 files differ between the two conversions (`satori_builtin.cpp`, `satori_EventOperation.cpp`,
`satori_sentence.cpp`, `ssu.cpp`, `satori.h`, `calc.cpp`, `calc_float.cpp`, `stltool.cpp`, `random.cpp`, …).
Behaviour that depends on it, e.g.:

* `calc.cpp` `replace(iString, L"−", L"-")` — with VC6 the literal is U+FF0D (the code also handles U+2212 separately);
* `stltool.cpp` `zen2han`: `c==L'−' || c==0x2212`; `int2zen(-5)` emits `L"−"`;
* `ssu.cpp` `zen_symbol[]` table (`〜` `−` …) used by `zen2han`/`han2zen`.

With GNU-converted sources, U+FF0D coming from a CP932 dictionary would no longer be a minus sign in those places.
Python's `cp932` codec is Microsoft's table, i.e. the code points VC6 gave the literals (the repo's `CLAUDE.md` states
the same for 0x8160/0x817C).

Conversion rules (`u8conv.py` in scratch):
- `satori/*.cpp|h`, `_/*.cpp|h`, `deelx/*.h` → `bytes.decode('cp932')` (strict; all 132 files decode) → UTF-8, no BOM.
- Normalise CRLF→LF (optional; clang accepts both — LF makes the patches below apply verbatim).
- Copy keeps the folder layout `src/satori`, `src/_`, `src/deelx` because sources include `"../_/stltool.h"` and
  `ssu.cpp` includes `"../deelx/deelx.h"`.

### 3.2 `Memory.h` shadowing `<memory.h>` (P0 on Windows build hosts)

`deelx/deelx.h` line 19 does `#include <memory.h>`. With `-I src/_` on a case-insensitive file system (Windows, macOS)
clang resolves it to Satori's `_/Memory.h` (a `class Memory`) and warns `non-portable path to file '<Memory.h>'`
(verified). It happens to compile, but it is the wrong header. Fix both ways:
1. delete `_/Memory.h` from the build copy (nothing compiled includes it; `_/Base.h` has it commented out), and
2. use `-iquote src/satori -iquote src/_` instead of `-I` (all Satori-internal includes use quotes; verified that the 26
   files compile this way and the warning disappears).

### 3.3 Generated file

`_/cp932_table.h` (≈210 KB source, ≈60 KB of data in the wasm) — generated by `gen_cp932.py` from Python's `cp932`
codec, see patch P1. Generate it at build time; don't commit a hand-edited table.

---

## 4. emcc flags

### 4.1 Compile (per file)

```
em++ -O2 -std=c++11 -fwasm-exceptions -DPOSIX -DSATORI_DLL \
     -Wall -Wno-unknown-pragmas -Wno-overloaded-virtual \
     -iquote build/src/satori -iquote build/src/_ \
     -c build/src/<dir>/<file>.cpp -o build/obj/<dir>__<file>.o
```

Debug variant: `-O0 -g` (+ link `-sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2`).

### 4.2 Link

```
em++ build/obj/*.o -o site/sumika/engines/satori.js \
  -O2 -fwasm-exceptions \
  -sMODULARIZE=1 -sEXPORT_NAME=createSatori \
  -sENVIRONMENT=web,worker,node \
  -sFORCE_FILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB \
  -sSTACK_SIZE=1MB -sCASE_INSENSITIVE_FS=1 \
  -sEXPORTED_FUNCTIONS=_load,_request,_unload,_satori_load_resume,_satori_save,_satori_get_talk_count,_satori_get_since_last_talk,_satori_set_talk_state,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAP32,UTF8ToString,stringToUTF8,lengthBytesUTF8
```

| Flag | Value / note |
|---|---|
| `-O2` | Used for all measurements here. `-O3` is optional (not measured). Output: `satori.wasm` 775 KB (281 KB gzip -9), `satori.js` 85 KB (24 KB gzip). |
| `-fwasm-exceptions` | **compile and link**. Link without it fails: `undefined symbol: __cpp_exception` (verified). Uses legacy Wasm EH (`WASM_LEGACY_EXCEPTIONS=1` is the 6.0.11 default): Chrome 95+, Firefox 100+, Safari 15.2+, Node 17+. Fallback if ever needed: `-fexceptions` (JS-based EH; every call with a landing pad becomes an `invoke_*` JS trampoline — much slower for RAII-heavy C++). |
| `MODULARIZE=1`, `EXPORT_NAME=createSatori` | Output is a classic script defining `var createSatori = (…)` (async factory → Promise<Module>), plus a CommonJS `module.exports` tail. Works with `importScripts()` in a classic Worker and `<script>`. |
| `ENVIRONMENT=web,worker,node` | node needed for tests. **Gotcha:** the project's `package.json` has `"type": "module"`, so Node treats `satori.js` as ESM and its `require`/`__dirname` fail. Tests must load it as CJS: copy to `.cjs`, or wrap with `vm`+`createRequire` (what `tests/load_engine.mjs` already does). Alternative: a second link with `-sEXPORT_ES6=1 -sENVIRONMENT=node -o satori.node.mjs` for tests only. |
| `FORCE_FILESYSTEM=1` | keep the full `FS` JS API (`mkdirTree`, `writeFile`, `readFile`, `readdir`, `stat`, `unlink`). |
| `ALLOW_MEMORY_GROWTH=1` | measured heap: 16 MB after Tsubasa load, **71 MB** after the 5 368-request corpus run (savedata had grown to 4.8 MB there). |
| `INITIAL_MEMORY=32MB` | avoids early regrowth (default is 16 MB). |
| `STACK_SIZE` | default is only **64 KB** (settings.js). Satori recurses (`（）` expansion, `＞` jumps, `call`); Windows gives SSP's thread ≥1 MB. Measured need for the full Tsubasa corpus ≈ 5 KB, no overflow at 64 KB with overflow checks on (§10.4). Use 1 MB for head-room. |
| `EXPORTED_FUNCTIONS` | `_load,_request,_unload` (SHIORI), `_satori_load_resume,_satori_save` (patch P3), `_satori_get_talk_count,_satori_get_since_last_talk,_satori_set_talk_state` (patch P6, SUMMARY §2.1; `EXPORTED` in `build.py`), `_malloc,_free` (buffer ownership, §6). Optional: `_satori_load,_satori_request,_satori_unload` (POSIX multi-instance API, §6.1; several Satori ghosts in one module — untested, and `GetSender()`/static tables are shared). |
| `EXPORTED_RUNTIME_METHODS` | `FS,HEAPU8,HEAP32` are required; `UTF8ToString,stringToUTF8,lengthBytesUTF8` are convenient. `Module.HEAPU8`/`HEAP32` are re-assigned on memory growth (`updateMemoryViews` writes `Module["HEAPU8"]=…`, verified) — **re-read them after every call into wasm**, never cache the view. `getValue/setValue` are not needed (use `HEAP32[p>>2]`). |
| *(not)* `-pthread` | Satori uses no threads → no SharedArrayBuffer / COOP+COEP needed. |
| `-sCASE_INSENSITIVE_FS=1` (recommended, P1) | legacy FS option (libfs.js lowercases names for lookup, keeps original names in `readdir`). Gives Windows-like lookup for ghosts whose files differ in case from what Satori/the dictionary asks for. Verified: with `Satori_Conf.txt` + folder `Date/` + `＄辞書フォルダ	date`, the default build answers 204 (nothing loaded), the CI build answers the talk. Note Satori's own dictionary-name filter (`dic` prefix, `.txt` ext in `LoadDicFolder`) is case-sensitive on every platform, so `DIC_X.TXT` is skipped on Windows too. Tsubasa doesn't need it. |

### 4.3 Exceptions are really used (P0)

`satori_builtin.cpp` `func_times`/`func_while`/`func_for`/`func_loop` `throw(L"引数の個数が正しくありません。")` and catch
`const wchar_t*`; `SakuraDLLHost::request` catches `std::exception`/`...` to return 500; `ssu.cpp` uses `try` around
DEELX. Tsubasa hits the throw path: the DLL corpus has the error string 10× (`final_master.summary.txt`).
Verified in wasm: `（times、3、x）（while、1）` → `xxx引数の個数が正しくありません。`.

### 4.4 Obsolete parts of `makefile.emscripten` / `em-pre.js` / `em-post.js`

| Old | Status in emcc 6.0.11 |
|---|---|
| `-shared` in LDFLAGS | now builds a real **side module** (`FAKE_DYLIBS` off since 6.0.0): emits only `.wasm`, then fails with `relocation … recompile with -fPIC` (verified). Never pass it. |
| `--memory-init-file 0` | `warning: --memory-init-file is no longer supported` (verified). Drop. |
| `-s EXPORTED_FUNCTIONS="['_load',…]"` | still accepted; prefer the comma form. |
| `em-pre.js` / `em-post.js` (wraps the whole output in `var Satori = function(){…}` and exports `Module`, `FS`, `PATH`, `ERRNO_CODES`, `NODEFS`, `IDBFS`, `WORKERFS`) | replaced by `MODULARIZE`. `NODEFS/IDBFS/WORKERFS` would now need `-lnodefs.js -lidbfs.js -lworkerfs.js`; Sumika persists through its own storage, so drop them. |
| `-s ALLOW_MEMORY_GROWTH=1` on CXXFLAGS | link-time only; harmless at compile. |
| `CXX = em++` with `-DPOSIX -DSATORI_DLL` | still correct. Since 6.0.6 `DEFAULT_TO_CXX` is off → link with `em++`, not `emcc`. |

---

## 5. Character sets

### 5.1 SHIORI requests/responses (P0, verified)

`SakuraDLLHost::request_bytes` (SakuraDLLHost.cpp):
1. charset = `Charset:` header of the request (case-insensitive name match in `find_charset_header`; names
   `shift_jis|sjis|x-sjis|cp932|ms932|windows-31j` → SJIS, `utf-8|utf8` → UTF-8, `-`/`_`/space and case ignored).
2. No header → `DetectCharset` (BOM or fully valid UTF-8 → UTF-8, else SJIS); an **ASCII-only request without
   Charset is answered in Shift_JIS** (old SHIORI/2.x callers).
3. The response gets `Charset: <request charset>` inserted as the first header; bytes are encoded with the response's
   own Charset header.

→ The runtime must always send `Charset: UTF-8`. Verified: `GET SHIORI/3.0\r\nCharset: UTF-8\r\n…` →
`SHIORI/3.0 200 OK\r\nCharset: UTF-8\r\nValue: …` in UTF-8. `GET Version SHIORI/2.6` + `Charset: UTF-8` →
`ID: Satori`, `Craftman: Yagi Kushigahama/The Maintenance Shop`, `Version: phase Mc203-6`.
(Satori docs `grammar/14-charset.md` describe the same.)

Errors are reported in the SHIORI response, not by dialogs: `ErrorLevel: critical\x01critical…` and
`ErrorDescription: SATORI : …\x01SATORI : …` (values joined by U+0001). Verified. The runtime should log these.

### 5.2 Files

| File | Read as | Written as |
|---|---|---|
| dictionaries `dic*.txt`, `satori_conf.txt`, `replace.txt`, `replace_after.txt`, `characters.ini`, `satori_bootconf.txt` | per file: UTF-8 if `satori_bootconf.txt` says `is_utf8_*` (`is_utf8_all`, `is_utf8_dic`, `is_utf8_replace`, `is_utf8_savedata`, `is_utf8_charactersini`), else BOM → UTF-8, else valid-UTF-8 → UTF-8, else **SJIS** (`detect_lines_charset`, stltool.cpp; `satori_load_unload.cpp`) | — |
| `satori_savedata.txt` / `.sat`, `satori_savebackup.*` | same detection (so the SJIS savedata from SSP loads) | **always UTF-8**, no BOM (`ENCODE(x)` = `WtoUTF8`), **LF** line ends on POSIX (`FILE_NEWLINE`), Windows writes CRLF |
| SAORI traffic | see §6.1 | |

Tsubasa: all `ghost/master/**/*.txt` are CP932 (no BOM, not valid UTF-8). 1 063× `－` (0x817C), 391× `～` (0x8160),
216× `―`; no NEC/IBM extension characters (scan of 68 files).

### 5.3 Why the stock POSIX Shift_JIS path is wrong in wasm (P0 → patch P1)

On POSIX `SJIStoW`/`WtoSJIS` use `iconv` (charset.cpp, tries `CP932`, `SHIFT_JIS`, `SJIS`). Emscripten links musl's
iconv, which has Shift_JIS but maps by JIS X 0208. Verified inside the wasm build (dictionary bytes → response):

| CP932 bytes | Windows / Python cp932 | musl iconv in wasm |
|---|---|---|
| 81 60 `～` | U+FF5E | U+301C |
| 81 7C `－` | U+FF0D | U+2212 |
| 81 5F `＼` | U+FF3C | **U+005C** (a real backslash → becomes SakuraScript!) |
| 81 61 `∥` | U+2225 | U+2016 |
| 81 CA `￢` | U+FFE2 | U+00AC |
| 87 40 `①` (NEC row 13) | U+2460 | `?` + next byte as ASCII (`?@`) |
| FB FC `髙` (IBM ext.) | U+9AD9 | garbage (`?潛`, eats the next char) |

Observable effect even for Tsubasa: `（zen2han、－５～）` returns `−5〜` (unchanged) instead of `-5~`; all `－`/`～`
in her text come out as U+2212/U+301C (differs from SSP). With patch P1 (verified): `-5~`, and
`A～B－C―D＼E∥F￢G①H髙I` round-trips exactly.

Cross-check of the table source: Node's WHATWG `TextDecoder('shift_jis')` and Python `cp932` agree on **all 11 340
double-byte codes**; they differ only for the single bytes 0x80, 0xA0, 0xFD–0xFF (Python maps them to U+0080,
U+F8F0–F8F3 like Windows; WHATWG errors). So a JS-side pre-conversion with `TextDecoder('shift_jis')` would also be
correct for dictionaries, but the C-side table also covers `WtoSJIS` (Shift_JIS SAORIs, Shift_JIS requests) and keeps the
engine self-contained — prefer the C table.

Uncertain: what Windows produces for an *invalid* lead/trail pair (MultiByteToWideChar without
`MB_ERR_INVALID_CHARS` substitutes a default char; possibly U+30FB). The patch emits `?` and consumes only the lead
byte. Rare in practice.

---

## 6. JS ↔ wasm ABI and the system-dependency audit

### 6.1 Exports (POSIX branch of `SakuraDLLHost.cpp`)

```c
int   load(char* dir, long len);             // dir: malloc'd UTF-8 path; engine free()s it; returns 1/0
char* request(char* req, long* len);         // req: malloc'd bytes, engine free()s it;
                                             // returns malloc'd response (NUL-terminated, *len = byte length); caller free()s
int   unload(void);                          // runs OnSatoriUnload, writes savedata, unloads SAORIs; returns 1
// added by patch P3:
int   satori_load_resume(char* dir, long len);   // = load() without 起動回数+1
int   satori_save(void);                         // = Save(false): write savedata now; 1 = written
// already present on POSIX (not needed for Tsubasa's P0):
int   satori_load(char*, long); char* satori_request(int id, char*, long*); int satori_unload(int id);
void  Set_loghandler(void (*)(const wchar_t* str, int mode, int id));   // wchar_t is 32-bit in wasm (UTF-32)
```

This mirrors the Windows DLL contract in UKADOC `manual/spec_dll.html` (`load`/`loadu(HGLOBAL,len)`,
`request(HGLOBAL,long*)`, `unload()`; the baseware allocates with `GlobalAlloc(GMEM_FIXED)`, the module frees the
input and allocates the output, the baseware frees the output), with `malloc`/`free` instead of
`GlobalAlloc`/`GlobalFree` and a UTF-8 path (like `loadu`).

`long` is 32-bit in wasm32. **Buffer ownership** (repo `CLAUDE.md`: "POSIX の load / request は渡したバッファを free
するので、テストは malloc したものを渡す"): pass memory from `_malloc`, never stack/static memory, and never
free it yourself. `load` truncates the path at the first NUL (`to_bytes`), and `len` should exclude the NUL.
`request` reads exactly `*len` bytes. `load` (POSIX) has **no** try/catch (Windows version has) — wrap JS calls in
try/catch; an escaped C++ exception surfaces as a JS exception.

JS pseudo-code (verified in `shiori_node.cjs`):

```js
function toHeap(M, bytes) {                       // engine takes ownership
  const p = M._malloc(bytes.length + 1);
  M.HEAPU8.set(bytes, p); M.HEAPU8[p + bytes.length] = 0;
  return p;
}
function load(M, dir /* '/ghost/master/' */, resume) {
  const b = new TextEncoder().encode(dir);
  return (resume ? M._satori_load_resume : M._load)(toHeap(M, b), b.length);
}
function request(M, text) {                       // text must contain "Charset: UTF-8"
  const b = new TextEncoder().encode(text);
  const p = toHeap(M, b);
  const lenp = M._malloc(4);
  M.HEAP32[lenp >> 2] = b.length;
  const r = M._request(p, lenp);                  // may grow memory: re-read HEAP* after this line
  const n = M.HEAP32[lenp >> 2];
  M._free(lenp);
  if (!r) return null;
  const out = new TextDecoder().decode(M.HEAPU8.subarray(r, r + n));
  M._free(r);
  return out;
}
```

`load` → `unload` → `load` on the same module instance works (verified 3 cycles), so `\![reload,shiori]` and
dictionary-folder reloads don't need a new instance. (The runtime's `\![reload,shiori]` starts a new
worker from the stored files anyway, for every engine: shiori-events.md §2.10.)

### 6.2 Audit table

| Area | Code | Unpatched wasm behaviour (verified unless noted) | Decision | Prio |
|---|---|---|---|---|
| SAORI loading | `SakuraDLLClient::load` → `dlopen`/`dlsym`; `shiori_plugin.cpp` first `w_fopen`s the DLL, then probes `dlopen`, then `getenv("SAORI_FALLBACK_PATH"/"SAORI_FALLBACK_ALWAYS")` | DLLs are not on the site (`tools/add_ghost.py` skips `*.dll`) → `failed to open` → **call name not registered** → `（dsaudio、play）` is printed literally in the balloon | patch P2: JS bridge; skip file checks and fallback | **P0** (Tsubasa: `dsaudio` music player, `gomi`, `httpc`, `fill_desktop`, `aya`=yaya.dll) |
| ssu built-in | `shiori_plugin.cpp`: path ends with `/ssu.dll` or `/ssu` (POSIX) → `new ssu()` (a `SaoriClient` subclass calling `call_ssu` directly), `mIsInternal = true` if no file. `load_default_entry()` registers every ssu function name that the ghost did not map (as `saori/ssu.dll`). | works with no file present (verified: `calc`, `regex_replace`, `zen2han`) | none | P0 |
| Dictionary folder scan | `list_files` → `opendir/readdir` | works on MEMFS; order = MEMFS insertion order (`Object.keys(node.contents)`; integer-like names would sort first) | write files into MEMFS **in NTFS order** (case-insensitive ordinal sort) so load order matches Windows | P0 |
| File I/O | `fopen` (`w_fopen` → UTF-8 path), `stat`, `rename`, `unlink` | MEMFS; default umask 022; permissions enforced after init (`FS.ignorePermissions=false`) — fine for `0666` files | none | P0 |
| `.sat`/`.txt` choice | `select_dict_and_load_to_vector` → `FileExist` (`stat`) | works (the POSIX `CompareTime` with a `wchar_t*` `stat` call is inside `#if 0`) | none | P2 |
| Savedata write | `Save()` writes `satori_savedata.tmp`, `unlink` backup, `rename` savedata→backup, `rename` tmp→savedata, `unlink` the other-extension pair | works (verified) | runtime persists after requests (§7) | P0 |
| Time of day | `time(NULL)` + `localtime` (satori_builtin.cpp `GetTime`) | JS `Date` in the browser's time zone | none | P0 |
| Ticks | `posix_get_current_tick` → `clock_gettime(CLOCK_MONOTONIC)` | `performance.now()` — fine for stroke (なで) timing | none | P0 |
| "OS uptime" | `posix_get_current_sec` → `CLOCK_BOOTTIME` (absent) → `CLOCK_MONOTONIC` | **seconds since page/worker start**; `（OS起動時）` etc. and `（起動時）` (since load) reset on each navigation | P2 patch idea: `EM_JS` clock with a session epoch kept by the runtime. Done as SUMMARY §2.1 P7, with the ghost's last cold boot as the epoch. Tsubasa reads none of the `（ＯＳ起動…）` ones, but she reads `（起動時）` (dic01, dic04), `（単純起動分）`/`（単純起動秒）` (dic05, dic13, dic14) and the totals `（単純累計分）` (dic02) and `（累計時）` (dic07, the proposal gate). Accumulated time (`ゴースト起動時間累計秒`) is saved as a total plus a delta since load, so it stays correct only while the clock never steps back within a load. P7's clock reads the wall clock once per worker and then advances with `performance.now`, so a date change on the visitor's machine never reaches the saved total (a per-call `Date.now` clock added it, or wrapped the total near 2³²; SUMMARY §2.1). | P2 |
| Random seed | `randomize()`: `gettimeofday` ^ `CLOCK_MONOTONIC` ^ `getpid()<<16` → MT19937 | works (`getpid()` is a constant 42 in Emscripten; time still varies) | for deterministic tests add an optional export `satori_test_seed(unsigned)` → `init_genrand` (test builds only) | P2 |
| Locale | `setlocale(LC_ALL,"Japanese")` in `Satori::load` | no observable effect; musl's `iswalpha/iswdigit` are locale-independent. Satori guards most `isw*` with `*p < 0x80`. `wcstod_dot` handles the decimal point (Mc203-6 fix) | none; note `iswdigit(L'０')` is probably true with the MSVC CRT (C1_DIGIT) but false in musl — the only unguarded uses are in `calc_float.cpp`, after `zen2han` (unverified edge) | P2 |
| Logging | `Sender` (`_/Sender.cpp`): every log line is buffered; on POSIX `flush_latest_event()` writes to **stderr** whenever one event exceeds 200 lines (Tsubasa's load does) → Emscripten `printErr` → `console.error` | noise + cost | patch P4 (silence), optional log hook | P1 |
| Error dialogs | `error_buf` → `std::wcerr` on POSIX when not in log mode | errors also arrive in `ErrorDescription` (§5.1) | none | P1 |
| FMO / other ghosts | `updateGhostsInfo()` is a no-op on POSIX (`satori.h`); `SakuraFMO`/`satoriFMO` not compiled | other ghosts known only via `NOTIFY otherghostname`; `（FMOn…）` `""`, `（Xの存在）` 0, `（Xのサーフェス）` −1 | runtime sends `otherghostname` when it has several ghosts. Patched (P8, §8): the FMO built-ins read `Module.fmoText`, which the worker sets from a request's `fmo` (`SatoriEngine.setFmo`) | P2 |
| `get_property` / `set_property` | POSIX path: `shm_open("/ninix")` + `AF_UNIX` socket (`SendDirectSSTP` in satori_builtin.cpp) | fails → returns the default argument | P1 patch idea: under `__EMSCRIPTEN__`, `SendDirectSSTP` → `EM_JS js_sstp_execute(utf8)` answered synchronously by the runtime's property system. Tsubasa: 0 uses. | P1 |
| Window/process search | `FindTopLevelWindow`, `FindProcessName` return 0 on POSIX | `（ウィンドウ存在…）`-style checks are false | none | P2 |
| SAORI-basic (exe) | `call_console_application` returns "" on POSIX; `mIsBasic=false` on POSIX | not supported | none | P2 |
| Threads | none | — | build without `-pthread` | — |
| Sockets/SSTP | only the ninix path above; `SSTPClient` not compiled | — | none | — |
| `getenv` | only the SAORI fallback (removed by P2) | — | — | — |
| Long-running requests | Mc203 limits: `呼び出し回数制限` 200 nesting, `呼び出し総数制限` 100 000 calls per request (`satori_load_dict.h`) | requests terminate, but some take seconds (§10.3) | Worker + watchdog | P0 |

### 6.3 SAORI bridge contract (patch P2)

JS object passed in the module options: `createSatori({ saoriBridge, locateFile, print, printErr })`.

```ts
interface SaoriBridge {
  // path: "/ghost/master/saori/dsaudio.dll" (Satori's full MEMFS path, '/' separators, case as written in satori_conf.txt)
  // dir:  "/ghost/master/saori/"            (the DLL's folder, ends with '/'; what a real SAORI's load() would get)
  load(path: string, dir: string): number;          // > 0 handle; 0 = no stand-in
  request(handle: number, req: Uint8Array): string | Uint8Array;   // raw SAORI/1.0 request → raw response
  unload(handle: number): void;
}
```

Sequence Satori produces (verified with a stand-in):
1. `load("/ghost/master/saori/foo.dll", "/ghost/master/saori/")` — once per distinct DLL path (several call names
   mapping to the same DLL share one handle; reference-counted in `ShioriPlugins`).
2. `GET Version SAORI/1.0` with `Sender: Satori`, `Charset: UTF-8`, `SecurityLevel: Local`.
   The stand-in **must** answer `SAORI/1.0 200 OK\r\nCharset: UTF-8\r\n\r\n`. Any other version string → error log;
   missing/empty `Charset` → Satori switches the DLL to Shift_JIS and sends one dummy `EXECUTE` with `Argument0:` empty
   (shiori_plugin.cpp, Mc203-2/-5 behaviour for old SAORIs).
3. Per call: `EXECUTE SAORI/1.0` with `Charset: UTF-8`, `Sender: SATORI`, `SecurityLevel: Local|External`,
   `Argument0..n` (pre-defined arguments from `satori_conf.txt` first, then the call's arguments).
4. Response parsing (`SakuraClient::request`, `SaoriClient::request`): first line `SAORI/1.0 <code> <text>`, then
   `Key: Value` lines split at the first `": "`. `Result` → the call's value; `Value0..Value65536` → `（Ｓ０）`… ; if no
   `ValueN` header is present the previous S-values are kept. Codes 200/204 silent; 400/500/other → error log.
5. `unload(handle)` at Satori unload/reload (POSIX upstream never called the DLL's `unload` — the patch does).

If `load` returns 0, Satori logs `…: no JavaScript stand-in for this SAORI` and `SAORI/1.xのdllの読み込みに失敗しました`,
but **keeps the call name registered**, so `（foo、1）` expands to `""` (verified). This is what Windows does when a DLL
exists but fails to load; it is preferable to the literal `（foo、1）` text. (The DLL corpus was generated with those
SAORI lines deleted from `satori_conf.txt`, i.e. literal text — keep that in mind when comparing.)

The bridge is synchronous: it runs inside the engine call, i.e. in the worker. A stand-in needing the page (sound,
desktop) must answer immediately and post a message to the page. A stand-in that needs data from the network
(`httpc.dll`) may use a *synchronous* `XMLHttpRequest`, which is still allowed inside workers (not on the main
thread) — subject to CORS; otherwise answer `204`.

Later: `aya,saori/yaya.dll` (Tsubasa's `saori/ayasaori.aym`, `builtins.aym`) can be served by a YAYA-wasm instance
behind the same bridge (P2).

---

## 7. MEMFS layout and persistence

### 7.1 Layout

```
/ghost/master/                 ← path passed to load(); Satori appends '/' if missing
  satori_conf.txt  replace.txt  replace_after.txt  characters.ini  satori_bootconf.txt   (optional ones may be absent)
  dic*.txt / dic*.sat         ← prefix/extension from ＄辞書接頭辞 / ＄辞書拡張子 (default "dic" / "txt")
  bath/ date/ meal/ …         ← dictionary folders selected by ＄辞書フォルダ (comma list, relative to /ghost/master/)
  satori_savedata.txt         ← restored from browser storage before load (if any)
  satori_savebackup.txt       ← optional (Satori falls back to it when savedata fails to load)
  saori/…                     ← not needed (DLLs are stand-ins); non-DLL data files a stand-in reads may go here
```

Rules:
- Put **only text files** of `ghost/master` (recursively) into MEMFS; no images, no DLLs. Tsubasa: ≈1.8 MB of dictionaries.
- Keep them all in MEMFS for the engine's lifetime: Satori **re-reads everything** on reload (`＄辞書フォルダ` change,
  `＄辞書リロード＝実行`), which Tsubasa does when entering/leaving date/meal/bath modes.
- Write files in NTFS order (sort each directory's names case-insensitively, ordinal on the uppercased names) so that
  `readdir` returns the same order as Windows' `FindFirstFile` → same load order.
- Path strings are UTF-8; Japanese folder names are fine.
- Windows lookups are case-insensitive; link with `-sCASE_INSENSITIVE_FS=1` (§4.2) to match.

### 7.2 When Satori writes `satori_savedata.txt`

| Trigger | Code | Notes |
|---|---|---|
| `unload()` | `Satori::unload` → `Save(true)` (runs `＊OnSatoriUnload` first) | only if dictionaries were loaded |
| **Reload inside a request** | `satori_AnalyzeRequest.cpp`: after the response, `if (reload_flag) { unload(); load(mBaseFolder); }`; `reload_flag` set by `＄辞書フォルダ` and `＄辞書リロード＝実行` | **writes savedata in the middle of a request.** Tsubasa sets `＄辞書フォルダ` in many talks (date/meal/bath) and `＄辞書リロード` (key `r`). Also increments `起動回数` (as on Windows). |
| `＄手動セーブ＝実行` | `sysvar_save` → `Save()` | Tsubasa: 34 uses (games, menu) |
| `＄自動セーブ間隔＝N` | every N `OnSecondChange` (`satori_EventOperation.cpp`) | default 0 = off; Tsubasa doesn't set it |
| `satori_save()` (patch P3) | `Save(false)` | for the runtime |

Format: UTF-8, LF, first line `＊セーブデータ`, then `＄name<TAB>value` (φ-escaped), then `＠word-group` sections for
words added with `単語の追加`. Not saved: `ＳN`, `今回は…` variables, expired/flagged timers (satori-docs
`grammar/15-save-data.md`). `＄セーブデータ暗号化＝有効` writes `satori_savedata.sat` instead (byte-shuffled UTF-8) — persist
whichever of `satori_savedata.txt|.sat` and `satori_savebackup.txt|.sat` exist.

### 7.3 Persisting from the runtime (recommendation)

A page can disappear at any time, and a worker round-trip during `pagehide` is not reliable. So:
1. After every request (debounced to ≤ 1 per second, and immediately after a request whose response contains a choice
   or after `OnChoiceSelect`), the worker calls `_satori_save()`, reads `satori_savedata.txt` (and `.sat`, backup)
   with `FS.readFile`, and if the bytes changed, writes them to IndexedDB **from the worker** (IndexedDB is available in
   workers). Measured cost of `_satori_save()` (Node, -O2): **4–7 ms** with Tsubasa's normal savedata (12–21 KB).
   The cost grows linearly with the savedata: the corpus run, which calls every talk out of context, inflated it to
   2.4–4.8 MB and a save then took 0.4–0.8 s. So make the policy adaptive: skip the save while a request is pending,
   debounce (≥ 1 s idle), and back off (e.g. every 30 s) when one save took > 50 ms.
2. Additionally compare after each request: reload-inside-request and `手動セーブ` change the file without a save call.
   (Comparing bytes, or `FS.stat(path).mtime`, both work; MEMFS mtime has ms resolution.)
3. On real ghost exit (OnClose → `\-`), call `_unload()` (runs `OnSatoriUnload`, saves) and persist.

### 7.4 Page navigation = resume, not boot (P0)

Each navigation creates a new engine; `load()` re-reads the dictionaries and the savedata. Side effects of a plain
`load()` that must not happen on navigation:

| Effect | Where | Handling |
|---|---|---|
| `起動回数` +1 | `satori_load_unload.cpp` | **patch P3**: `satori_load_resume()` skips it. Tsubasa has `＞５０回目起動 （起動回数）==50` / 100 / 200 — counting navigations would skip these. Verified: load→`1`, resume→`1`, load→`2`. |
| `＊OnSatoriLoad`, `＊OnSatoriBoot` run | `Satori::load` | harmless: `OnSatoriBoot`'s script is only emitted on `OnBoot`/`OnGhostChanged`, which a resume doesn't send. Tsubasa defines neither. |
| `起動時/分/秒` (uptime since load) restart | `var_uptime` | P2 (see §6.2) |
| Lost in-memory state: overlap avoidance (`Families`), `mResponseHistory` (`remember`), COMMUNICATE log, `otherghostname`, `次から…回目のトーク` reservations are saved but `mCommunicateFor` etc. are not; running `＄…タイマ` countdowns are probably re-armed (savedata is executed as normal `＄` assignments and the `…タイマ` suffix goes through `sysvar_timer`) — not verified | not in savedata | accepted limitation (heap snapshots would be 16–70 MB) |

So: first start of a ghost → `_load` + `OnBoot`; navigation → `_satori_load_resume` and no OnBoot.

---

## 8. Patches (unified diffs against the LF-normalised UTF-8 sources of commit e2bf348)

All verified to apply, compile and run (`patches.diff` in scratch is the exact output of `diff -u`).
Apply them by exact-string replacement that asserts exactly one match per hunk (as `apply_patches.py` and the
existing `engines/satori/build.py` do) — more robust than `patch(1)` on Windows.

### P1 — CP932 table instead of musl iconv (P0)

`_/charset.cpp`:

```diff
--- a/_/charset.cpp
+++ b/_/charset.cpp
@@ -1,6 +1,8 @@
 #include	"charset.h"
 
-#ifdef POSIX
+#if defined(POSIX) && defined(__EMSCRIPTEN__)
+#include	"cp932_table.h"
+#elif defined(POSIX)
 #include	<iconv.h>
 #include	<errno.h>
 #else
@@ -135,7 +137,70 @@
 //----------------------------------------------------------------------
 // Shift_JIS / ACP
 
-#ifdef POSIX
+#if defined(POSIX) && defined(__EMSCRIPTEN__)
+
+// sumika: code page 932 from a table generated with Python's cp932 codec, so that dictionaries decode to the
+// same code points as satori.dll on Windows (musl's iconv maps 0x8160/0x817C/0x815F to U+301C/U+2212/U+005C and
+// has no NEC/IBM extensions).
+static int	cp932_lead_index(unsigned char c)
+{
+	if ( c >= 0x81 && c <= 0x9F ) { return c - 0x81; }
+	if ( c >= 0xE0 && c <= 0xFC ) { return c - 0xE0 + 31; }
+	return -1;
+}
+
+std::wstring	SJIStoW(const std::string& str)
+{
+	std::wstring o;
+	o.reserve(str.size());
+	const unsigned char* p = reinterpret_cast<const unsigned char*>(str.data());
+	const unsigned char* e = p + str.size();
+	while ( p < e ) {
+		const unsigned char c = *p++;
+		if ( c < 0x80 ) { o += static_cast<wchar_t>(c); continue; }
+		const int li = cp932_lead_index(c);
+		if ( li < 0 ) {
+			const unsigned short u = cp932_single_hi[c - 0x80];
+			o += static_cast<wchar_t>(u ? u : L'?');
+			continue;
+		}
+		if ( p < e && *p >= 0x40 && *p <= 0xFC ) {
+			const unsigned short u = cp932_dbcs[li * 189 + (*p - 0x40)];
+			if ( u ) { o += static_cast<wchar_t>(u); ++p; continue; }
+		}
+		o += L'?';	// invalid pair: drop the lead byte only (Windows' exact replacement is not reproduced)
+	}
+	return o;
+}
+
+std::string		WtoSJIS(const std::wstring& str)
+{
+	std::string o;
+	o.reserve(str.size() * 2);
+	for ( std::wstring::const_iterator it = str.begin() ; it != str.end() ; ++it ) {
+		const unsigned long c = static_cast<unsigned long>(*it);
+		if ( c < 0x80 ) { o += static_cast<char>(c); continue; }
+		unsigned int lo = 0, hi = cp932_enc_count;
+		while ( lo < hi ) {
+			const unsigned int mid = (lo + hi) / 2;
+			if ( cp932_enc_ucs[mid] < c ) { lo = mid + 1; } else { hi = mid; }
+		}
+		if ( c <= 0xFFFF && lo < cp932_enc_count && cp932_enc_ucs[lo] == c ) {
+			const unsigned short mb = cp932_enc_mb[lo];
+			if ( mb > 0xFF ) { o += static_cast<char>(mb >> 8); }
+			o += static_cast<char>(mb & 0xFF);
+		}
+		else {
+			o += '?';	// like WideCharToMultiByte(932, WC_NO_BEST_FIT_CHARS)
+		}
+	}
+	return o;
+}
+
+std::wstring	ACPtoW(const std::string& str) { return UTF8toW(str); }
+std::string		WtoACP(const std::wstring& str) { return WtoUTF8(str); }
+
+#elif defined(POSIX)
 
 static std::string	iconv_convert(const std::string& str, const char* to, const char* from)
 {
```

`_/cp932_table.h` generator (Python; complete — `gen_cp932.py` in scratch):

```python
LEADS = list(range(0x81, 0xA0)) + list(range(0xE0, 0xFD))           # 60 lead bytes
dec = []                                                            # [lead index][trail-0x40], trail 0x40..0xFC (189)
for lead in LEADS:
    for trail in range(0x40, 0xFD):
        u = 0
        if trail != 0x7F:
            try:
                s = bytes([lead, trail]).decode('cp932')
                u = ord(s) if len(s) == 1 and ord(s) < 0x10000 else 0
            except UnicodeDecodeError:
                pass
        dec.append(u)
single = {}                                                         # 0x80..0xFF that decode alone (0x80, 0xA0..0xDF, 0xFD..0xFF)
for b in range(0x80, 0x100):
    try:
        s = bytes([b]).decode('cp932'); single[b] = ord(s) if len(s) == 1 else 0
    except UnicodeDecodeError:
        pass
enc = {}                                                            # canonical bytes per code point (Python = Microsoft's choice
for u in sorted(set(x for x in dec if x) | set(single.values())):  #  among NEC/IBM duplicates)
    try:
        b = chr(u).encode('cp932'); enc[u] = b[0] if len(b) == 1 else (b[0] << 8 | b[1])
    except UnicodeEncodeError:
        pass
# emit: cp932_single_hi[128] (0 for lead bytes), cp932_dbcs[60*189], cp932_enc_count,
#       cp932_enc_ucs[] (sorted), cp932_enc_mb[]  -- all 'static const unsigned short'
```

Counts: 9 604 valid double-byte codes, 68 valid single high bytes, 9 274 encodable code points.

**The table is shared** (`yaya-wasm.md` §3): `engines/common/gen_cp932.py`, which every build runs with `--verify
engines/common/cp932`, checks the table against dumps of `MultiByteToWideChar(932, 0)` and
`WideCharToMultiByte(932, …)` made on Windows 11 (0 mismatches) [measured]. Two consequences for Satori, both direct
tests in `tests/engine_adapter.test.mjs` (Tsubasa has neither case, so `satori_vs_dll` cannot see them):
- S1, encode: the table above is Python's, which picks the NEC-selected copy (0xED/0xEE) for the 373 characters that
  exist twice; satori.dll converts with `WC_NO_BEST_FIT_CHARS` (`charset.cpp`), and Windows writes the IBM code
  (0xFA–0xFC), e.g. ⅰ → `FA 40`, not `EE EF`. The shared base table is exactly `WC_NO_BEST_FIT_CHARS`; Satori uses it
  without the 85 best-fit entries YAYA adds, so `é` and `ゔ` still become `?`.
- S2, decode (answers §11 Q3): an invalid pair is one U+30FB that takes both bytes, even a lead byte before a newline,
  and a lead byte at the end is U+30FB too, as `MultiByteToWideChar(932, 0)` does. The diff above writes `?` and keeps
  the trail byte; P1 in `engines/satori/patches.py` follows Windows.
Decoding is unchanged otherwise (decode table identical). The before/after checks (satori_vs_dll, the 247-ghost sweep:
same tallies within its run-to-run noise) are in `yaya-wasm.md` §3.

### P2 — SAORI → JavaScript bridge (P0)

`satori/SakuraDLLClient.h`:

```diff
@@ -55,6 +55,9 @@
 	bool m_version_reply_has_charset;
 	wstring m_version_reply_charset;
 
+#ifdef __EMSCRIPTEN__
+	int     m_em_handle;	// sumika: handle from Module.saoriBridge.load (0 = none)
+#endif
 #ifdef POSIX
 	void*   mModule;
 	bool    (*mLoad)(char* h, long len);
```

`satori/SakuraDLLClient.cpp`:

```diff
@@ -2,6 +2,33 @@
 #include "../_/Sender.h"
 #include <assert.h>
 
+#ifdef __EMSCRIPTEN__
+#  include <emscripten.h>
+// sumika: SAORI calls go to JavaScript stand-ins (Module.saoriBridge) instead of dlopen().
+//   load(path, dir) -> handle > 0, or 0 when there is no stand-in
+//   request(handle, Uint8Array request) -> string | Uint8Array (raw SAORI/1.0 response)
+//   unload(handle)
+EM_JS(int, js_saori_load, (const char* path, const char* dir), {
+	var b = Module['saoriBridge'];
+	if (!b) return 0;
+	try { return b.load(UTF8ToString(path), UTF8ToString(dir)) | 0; } catch (e) { err('SAORI load: ' + e); return 0; }
+});
+EM_JS(char*, js_saori_request, (int h, const char* req, int len, int* out_len), {
+	var b = Module['saoriBridge'], r = null;
+	try { if (b) r = b.request(h, HEAPU8.slice(req, req + len)); } catch (e) { err('SAORI request: ' + e); }
+	if (typeof r === 'string') r = new TextEncoder().encode(r);
+	if (!r || !r.length) r = new TextEncoder().encode('SAORI/1.0 500 Internal Server Error\r\nCharset: UTF-8\r\n\r\n');
+	var p = _malloc(r.length + 1);
+	HEAPU8.set(r, p); HEAPU8[p + r.length] = 0;
+	HEAP32[out_len >> 2] = r.length;
+	return p;
+});
+EM_JS(void, js_saori_unload, (int h), {
+	var b = Module['saoriBridge'];
+	try { if (b) b.unload(h); } catch (e) { err('SAORI unload: ' + e); }
+});
+static char* em_request_marker(char*, long*) { return NULL; }	// never called; only makes mRequest non-NULL
+#endif
 #ifdef POSIX
 #  include <dlfcn.h>
 #  include <string.h>
@@ -23,6 +50,9 @@
 SakuraDLLClient::SakuraDLLClient()
 {
 	m_version_reply_has_charset = true;
+#ifdef __EMSCRIPTEN__
+	m_em_handle = 0;
+#endif
 	mModule = NULL;
 	mLoad = NULL;
 #ifndef POSIX
@@ -66,7 +96,17 @@
 	}
 
 	memcpy(h, theRequest.c_str(), len + 1); //ZeroTermまで
+#ifdef __EMSCRIPTEN__
+	{
+		int out_len = 0;
+		char* r = js_saori_request(m_em_handle, h, (int)len, &out_len);
+		free(h);
+		h = r;
+		len = out_len;
+	}
+#else
 	h = mRequest(h, &len);
+#endif
 
 	std::string theResponse;
 	if ( h ) {
@@ -154,7 +194,12 @@
 
 void	SakuraDLLClient::unload()
 {
-#ifdef POSIX
+#if defined(__EMSCRIPTEN__)
+	if ( m_em_handle > 0 ) {
+		js_saori_unload(m_em_handle);
+	}
+	m_em_handle = 0;
+#elif defined(POSIX)
     if (mModule != NULL) {
 	    dlclose(mModule);
 	}
@@ -194,6 +239,19 @@
 
 	GetSender().sender() << L"SakuraDLLClient::load '" << dll_fullpath << L"' ...";
 
+#ifdef __EMSCRIPTEN__
+	m_em_handle = js_saori_load(WtoUTF8(dll_fullpath).c_str(), WtoUTF8(work_folder).c_str());
+	if ( m_em_handle <= 0 ) {
+		m_em_handle = 0;
+		GetSender().sender() << L"failed." << std::endl;
+		GetSender().errsender() << dll_fullpath + L": no JavaScript stand-in for this SAORI" << satori::endl;
+		return false;
+	}
+	mModule = reinterpret_cast<void*>(1);
+	mRequest = em_request_marker;
+	GetSender().sender() << L"succeed." << std::endl;
+	return true;
+#endif
 #ifdef POSIX
 	mModule = dlopen(WtoUTF8(dll_fullpath).c_str(), RTLD_LAZY);
 	if (mModule == NULL) {
```

Notes: the existing `if ( h ) { theResponse.assign(h, len); free(h); }` frees the bridge's `_malloc`ed buffer, so
`_malloc` must stay exported. `mLoad`/`mUnload` stay NULL — the bridge's `load` replaces the DLL's `load(dir)`.

`satori/shiori_plugin.cpp` (DLLs are not shipped → skip the existence check and the dlopen probe / `SAORI_FALLBACK_*`):

```diff
@@ -149,6 +149,7 @@
 			}
 #endif
 			
+#ifndef __EMSCRIPTEN__
 			// ファイルの存在を確認
 			FILE*	fp = w_fopen(fullpath, L"rb");
 			if ( fp == NULL )
@@ -161,6 +162,7 @@
 				return	false;
 			}
 			fclose(fp);
+#endif
 
 			// ファイル名・フォルダ名・拡張子を分離
 			const wchar_t*	lastyen = wcsrchr(fullpath.c_str(), DIR_CHAR);
@@ -176,7 +178,7 @@
 			wstring	filename(lastyen+1, wcslen(lastyen)-wcslen(lastdot)-1);
 			wstring	extention(lastdot+1);
 
-#ifdef POSIX
+#if defined(POSIX) && !defined(__EMSCRIPTEN__)
 			// 環境変数 SAORI_FALLBACK_ALWAYS が定義されていて、且つ
 			// 空でも"0"でもなければ、このdllファイルを開いてみる事は
 			// 初めからやらない。そうでなければ、試しにdlopenしてみる。
```

Note: a SAORI path without an extension (or with a dot only in a folder name) still returns `false` early (the
`lastdot<lastyen` check) — same as upstream.

The `shiori_plugin.cpp` hunk is needed: without it, with no DLL file in MEMFS `load_a_plugin` returns at the
`w_fopen` check and the bridge is never reached — every non-ssu SAORI stays unregistered (literal `（dsaudio、…）` in
the balloon). Zero-byte placeholder files at the DLL paths would do the same. A `strlen`-based length would also cut a
response at an embedded NUL (harmless in practice).

### P3 — resume load + save export (P0)

`satori/satori_load_unload.cpp`:

```diff
@@ -317,6 +317,10 @@
 	else {
 		sec_count_total = zen2ul(variables[L"ゴースト起動時間累計(ms)"]) / 1000;
 	}
+#ifdef __EMSCRIPTEN__
+	extern bool g_em_resume_load;	// sumika: set by satori_load_resume(); a page navigation is not a boot
+	if ( ! g_em_resume_load )
+#endif
 	variables[L"起動回数"] = itos( zen2int(variables[L"起動回数"])+1 );
```

`satori/satori.h` (inside `class Satori`, next to `Save`):

```diff
@@ -654,7 +654,10 @@
 	// 変数等のデータをファイルに保存
-	bool	Save(bool isOnUnload=false);	
+	bool	Save(bool isOnUnload=false);
+#ifdef __EMSCRIPTEN__
+	bool	EmSave() { return is_dic_loaded ? Save(false) : false; }	// sumika: write savedata without unloading
+#endif
```

`satori/SakuraDLLHost.cpp` (inside the `#ifdef POSIX` block, before `load`):

```diff
@@ -56,6 +56,37 @@
     return id;
 }
 
+#ifdef __EMSCRIPTEN__
+bool g_em_resume_load = false;
+
+// sumika: same as load(), but does not count a boot (起動回数). Used when a page navigation restarts the engine.
+extern "C" SATORI_EXPORT int satori_load_resume(char* i_data, long i_data_len) {
+    wstring the_base_folder = UTF8toW(to_bytes(i_data, i_data_len));
+    free(i_data);
+    g_em_resume_load = true;
+    int r = 0;
+    try {
+        r = SakuraDLLHost::I()->load(the_base_folder);
+    }
+    catch ( ... ) {
+        r = 0;
+    }
+    g_em_resume_load = false;
+    return r;
+}
+
+// sumika: write satori_savedata.txt now (a page can go away at any time). 1 = written.
+extern "C" SATORI_EXPORT int satori_save(void) {
+    try {
+        Satori* s = static_cast<Satori*>(SakuraDLLHost::I());
+        return ( s != NULL && s->EmSave() ) ? 1 : 0;
+    }
+    catch ( ... ) {
+        return 0;
+    }
+}
+#endif
+
 extern "C" SATORI_EXPORT int load(char* i_data, long i_data_len) {
```

(`SakuraDLLHost::I()` is `gSatori` unless the multi-instance API selected another one; the static_cast is valid
because every instance is a `Satori`.)

### P4 — no stderr log spill (P1)

`_/Sender.cpp`:

```diff
@@ -54,7 +54,9 @@
 bool Sender::initialize()
 {
-#ifdef POSIX
+#if defined(POSIX) && defined(__EMSCRIPTEN__)
+	return false;	// sumika: logs only go to Set_loghandler (stderr would be console.error in a page)
+#elif defined(POSIX)
 	return true;
 #else
```

Effect: `auto_init()` fails unless a log handler is set, so `flush_latest_event()` no longer prints; `flush()` on
POSIX already required a handler. Verified: 0 stderr lines for a whole Tsubasa corpus run (201 lines without the
patch, all around load/`OnBoot`).

Optional debug log hook (P2, **untested**): add to a new `satori/em_glue.cpp`:

```cpp
#include <emscripten.h>
#include "../_/Sender.h"
#include "../_/charset.h"
EM_JS(void, js_satori_log, (const char* s, int mode), { if (Module['onSatoriLog']) Module['onSatoriLog'](UTF8ToString(s), mode); });
static void em_loghandler(const wchar_t* s, int mode, int) { js_satori_log(WtoUTF8(s).c_str(), mode); }
extern "C" EMSCRIPTEN_KEEPALIVE void satori_enable_log(int on) { GetSender().set_loghandler(on ? em_loghandler : 0); }
```

(mode = AYA log codes: 0 info, 1 fatal, 2 error, 3 warning, 4 note, 5 other; 17 = "UTF-8" announcement.)

### P5 — build-tree hygiene (P0, no source edits)

Delete `src/_/Memory.h`; compile with `-iquote` (§3.2).

### P8 — FMO from the page (P2)

What. On Windows, Satori reads SSP's shared FMO `SakuraUnicode` (UTF-8 lines `<id>.<key>\x01<value>\r\n`, one block
per running ghost) at every `（FMOn<key>）`, `（Xの存在）` and `（Xのサーフェス）` (`updateGhostsInfo`, `satoriFMO.cpp`,
`SakuraFMO.cpp`). On POSIX `updateGhostsInfo` is a no-op and the two files are not compiled, so these built-ins answered
`""`, 0 and −1. P8 compiles them and takes the text from `Module.fmoText`.

Why. Ghosts check who else is on screen this way: Katari's "already here?" before calling a ghost by name, and the
property answer that 20 Satori ghosts send with `（FMO0name）` [corpus] (shiori-events.md §2.7.8, the stand-in's
text).

The 8 entries (`engines/satori/patches.py`, section 8; each matches once after P1–P7):
1. `satori.h`: the POSIX no-op `updateGhostsInfo()` only when not `__EMSCRIPTEN__`; WebAssembly declares the real one.
2. `SakuraFMO.cpp`: no `_/FMO.h` (a Windows file mapping); `EM_JS js_fmo_text()` copies `Module.fmoText` into a
   `_malloc`'d UTF-8 string (0 when it is not a string); `em_read_fmo` takes it and frees it.
3. and 4. The Windows reader `read_fmo` goes inside `#ifndef __EMSCRIPTEN__`.
5. `SakuraFMO::update` reads `em_read_fmo` instead of `SakuraUnicode` / `Sakura`; the parsing after it is Satori's.
6. `satoriFMO.cpp`: the empty-exe-folder guard is skipped (WebAssembly has no exe folder; it only matters for an entry
   without `ghostpath`).
7. and 8. The self test `ghostpath + "ghost\master\"` uses `/` (`DIR_FMO_MASTER`).

Self test. Satori's base folder is `/ghost/master/`, so the entry whose `ghostpath` is `/` is the reader (FMO0); every
other entry follows in id order. Ids containing `ssp_fmo_header_dummyentry`, `SSTPVIEWER-` or `SSSB` are dropped, and
so is a line whose value is empty or holds another `\x01`, as on Windows.

Without a text. `js_fmo_text` returns 0, `update` fails ("FMO can't open.", a log line only) and Satori keeps the list
it had: nothing before the first text (load clears it), so every built-in answers as without P8. Checked: 29
FMO-related requests on a synthetic dictionary got byte-identical answers from builds without and with P8, and the
build without P8 ignores `fmoText`; `satori_vs_dll` bath / date / meal stayed within that build's run-to-run spread
(Tsubasa reads no FMO: her `（変数「…」の存在）` is another built-in). A text withdrawn later (`delete Module.fmoText`, or
`setFmo(null)`) keeps the last list, as Satori does when SSP's FMO cannot be opened. The two other callers in
`satori_EventOperation.cpp` (window handles for the screen-edge test, GETGHOSTSTATE while stroked) are `#ifndef POSIX`
and stay out.

How the text arrives. `ShioriClient.request(r)` calls `r.fmo()` when the request leaves the queue and posts
`{t:'req', text, fmo}` only when the text differs from the last one this engine got (none at `init`; a new engine gets
it again with its first request; a throwing `r.fmo` is logged once and the request goes without it). The worker calls
`engine.setFmo(fmo)` before the request (`engineRequest`); `SatoriEngine.setFmo` sets `Module.fmoText`. YAYA has no
`setFmo`. The text itself (`src/core/fmo.js`) and which requests carry it (Satori ghosts only, `src/core/events.js`) are
the runtime's.

Build. No new export (`EXPORTED`, `RUNTIME` unchanged: the EM_JS code calls `_malloc`, `lengthBytesUTF8`,
`stringToUTF8`). `satori.build-info.json` counts `patches: 29` (P1–P4, P6, P7: 21 entries; P8: 8). `satori.LICENSES.txt`
is unchanged (no notice in the two files). Sizes: `satori.wasm` 781,730 bytes, `satori.js` 85,859 (before: 775,918 and
85,695). Test: `tests/satori_fmo.test.mjs` (the real build on a synthetic dictionary).

### Not patched on purpose
- `load()` without try/catch (POSIX): JS wraps the call; `satori_load_resume` has its own try/catch.
- `get_property`/`set_property`, OS-uptime clock: P1/P2 ideas in §6.2.
- `SakuraDLLClient` POSIX `unload` not calling the DLL's `unload()`: irrelevant once P2 is in.

---

## 9. Build recipe (Python; fits the existing `engines/satori/build.py` layout)

`engines/satori/build.py` implements this recipe. The differences from the original proposal are noted inline.

```text
engines/satori/build.py [--debug] [--out DIR] [-j N]
  ROOT      = repo root
  SATORIYA  = vendor/satoriya-shiori/satoriya
  BUILD     = engines/satori/build            (src/, obj/, obj-debug/)
  OUT       = site/sumika/engines             (satori.js, satori.wasm, satori.build-info.json, satori.LICENSES.txt)
  EMXX      = [toolchain/emsdk/python/3.13.3_64bit/python.exe, toolchain/emsdk/upstream/emscripten/em++.py]
  env       : EM_CONFIG=toolchain/emsdk/.emscripten, PYTHONDONTWRITEBYTECODE=1
```

Not implemented: the proposed `--node-test-build` flag (step 6) and the optional `EM_FROZEN_CACHE=1`. The tests load
the classic `satori.js` through `tests/load_engine.mjs` instead.

1. **Check inputs**: `SATORIYA/deelx/deelx.h` exists, else stop with
   `git -C vendor/satoriya-shiori submodule update --init satoriya/deelx`.
   Name the commits (`identity()`): the repository's `vendor/satoriya-shiori` is a copy with no `.git` of its own
   (git there would answer for the enclosing repository: `engines/common/vendor.py` `own_checkout`), so the build
   takes them from `COPY_OF` (`e2bf348`, deelx `af1a690`); a git checkout of its own names its own (`git rev-parse
   HEAD` in it and in `satoriya/deelx`). Either way it hashes the 134 files it reads (`inputs()`: `LICENSE` and the
   `.cpp` / `.h` of `satori/`, `_/` and `deelx/`; `vendor.files_pin`) and warns when the hash is not `INPUTS_PIN`.
   Record the two commits, `inputsPin` and `drift` into `OUT/satori.build-info.json`
   (with the patch count and the debug flag; build.py writes it after the link), and next to it
   `OUT/satori.LICENSES.txt`: Satori's `LICENSE` (BSD-2-Clause), MT19937's notice from
   `_/mt19937ar.cpp` (BSD-3-Clause) and DEELX's header, cut out by `engines/common/notices.py`, then what Emscripten
   compiles in (`notices.emscripten`: its runtime and system libraries, with Emscripten's `LICENSE` and musl's
   `COPYRIGHT`). Both BSD licences ask a binary copy to reproduce their notice.
2. **Convert**: wipe `BUILD/src`; for `satori/*.cpp|h`, `_/*.cpp|h`, `deelx/*.h`:
   `text = raw.decode('cp932')` (strict) → `text.replace('\r\n', '\n')` → write UTF-8 (no BOM) to `BUILD/src/<dir>/<name>`.
   Delete `BUILD/src/_/Memory.h`.
3. **Generate** `BUILD/src/_/cp932_table.h` (P1 generator).
4. **Patch**: list of `(file, old, new)`; assert `text.count(old) == 1`, replace, write. Fail loudly on mismatch
   (upstream moves fast: Mc203-1…6 within weeks).
5. **Compile** the 28 files (26 without P8) in parallel (thread pool, `-j` = CPU count) with the §4.1 command; object
   name `<dir>__<name>.o`; collect stderr; on failure print the first 60 lines per failing file and exit 1.
6. **Link** with the §4.2 command into `OUT/satori.js` (+ `satori.wasm` next to it).
   `--debug`: `-O0 -g -sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2`.
   `--node-test-build` (optional, **not implemented**): second link `-sENVIRONMENT=node -sEXPORT_ES6=1 -o BUILD/satori.node.mjs`.
7. Print sizes. Expected (-O2): `satori.wasm` 781,730 and `satori.js` 85,859 bytes (build.py prints KiB: 763 and
   83); about 775 KB and 85 KB without P8.

Incremental builds: re-run step 5 only for files whose converted+patched text changed (hash compare), always relink.
build.py hashes each source together with all headers and the compile flags, and keeps `--debug` objects in
`obj-debug/`. build.py links in `BUILD/link-O2` or `BUILD/link-debug` (so a `--debug` build never overwrites the
release build in `OUT`), refuses to copy a `satori.js`/`satori.wasm` that
names the builder's home or project path (YAYA's check), and writes to `--out DIR` (default `OUT`; a `--debug` build to
`BUILD/out-debug`). A `--debug` build is refused: emsdk's cached debug libc++ archives carry the builder's path in
their DWARF (kawari-wasm.md §2) [measured]. The release build passes the check and came out byte-identical
[measured].

---

## 10. Node test plan

Node: `toolchain/emsdk/node/24.19.0_64bit/node.exe` (or `. tools/env.sh`). Load the classic build via `vm` +
`createRequire` (as `tests/load_engine.mjs` does) or a `.cjs` copy, because the repo is `"type": "module"`.

### 10.1 Smoke test (port of `satoriya/test/posix/posix_smoke.c`) — verified passing

MEMFS `/ghost/master/dic_smoke.txt` ← `satoriya/test/posix/ghost/dic_smoke.txt` (UTF-8, no BOM). `_load('/ghost/master/')`
must return 1. Requests `GET SHIORI/3.0\r\nCharset: UTF-8\r\nSender: SSP\r\nSecurityLevel: local\r\nID: <id>\r\nReference0: master\r\n\r\n`:

| ID | response must contain |
|---|---|
| `OnHello` | `SHIORI/3.0 200 OK` and `hello world` |
| `OnVar` | `x is ５` |
| `OnReplace` | `heLLo` |
| `OnCalc` | `\07\e` |
| `OnRegex` | `abc-def` (DEELX via ssu) |

Plus: `GET Version` → `Version: phase Mc203-6`; `_unload()` = 1 and `/ghost/master/satori_savedata.txt` exists, starts
with `＊セーブデータ` and contains `＄起動回数\t1`.

### 10.2 Unit tests for the patches

All rows were run against the prototype build and pass, except "Shift_JIS response" (not run).

| Test | Input | Expect |
|---|---|---|
| CP932 decode | SJIS dic: `：A～B－C―D＼E∥F￢G①H髙I` | Value contains U+FF5E U+FF0D U+2015 U+FF3C U+2225 U+FFE2 U+2460 U+9AD9, no `?` |
| zen2han | `：（zen2han,－５～）` | `-5~` |
| surface minus | `：（－１）x` | `\s[-1]x` |
| Shift_JIS response | same request with `Charset: Shift_JIS` | bytes decode with `TextDecoder('shift_jis')` to the same text |
| SAORI bridge | `satori_conf.txt`: `＠SAORI` / `foo,saori/foo.dll`; stand-in answers Version + `Result: foo(<args>)` | `load('/ghost/master/saori/foo.dll','/ghost/master/saori/')`, then `GET Version SAORI/1.0`, `EXECUTE` with `Argument0: 1`; Value `foo(1)`; `unload(h)` on `_unload` |
| missing stand-in | bridge returns 0 | `（foo、1）` → `""`; `ErrorDescription` mentions `no JavaScript stand-in` |
| exceptions | `（times、3、x）（while、1）` | `xxx引数の個数が正しくありません。` |
| resume | load → unload → `satori_load_resume` → unload → load → unload | `起動回数` 1, 1, 2 |
| save | `_satori_save()` after a request that sets a variable | returns 1; file contains the variable |
| reload-in-request | dic: `＊OnR` / `＄辞書リロード＝実行` / `＄テスト＝あ` / `：x`; `＊OnY` / `：y（テスト）（起動回数）` | verified: `satori_savedata.txt` appears during `OnR`; `OnY` → `yあ2` (variables survive the reload; the internal reload counts as a boot) |

### 10.3 Tsubasa against the real-DLL corpus

**Setup** (the corpus and its prepared ghost live in `tests/corpus/`; `node tests/satori_vs_dll.mjs <mode>` does
all of this, see `tests/corpus/README.md`): the DLL ran on the translated ghost's text files incl. its
`satori_savedata.txt`, with `satori_conf.txt` lacking the lines `fill_desktop|fill_red|dsaudio|gomi|httpc|aya,…`, every
`dic*.txt` changed `＄辞書フォルダ\t` → `＄辞書フォルダ無効\t` and `set,辞書フォルダ,` → `set,辞書フォルダ無効,`, and the
savedata ending in `＄辞書フォルダ\t<mode>` (`.` for master, `bath`, `date`, `meal`). `tests/corpus/ghost/master` is
that ghost with `<mode>` = `.`; use the matching corpus `tests/corpus/final_<mode>.res.txt`.

**Requests**: for each block `=== <ID>\t<Ref0>\t…` send `GET SHIORI/3.0` with `Charset: UTF-8`, `Sender: SSP`,
`SecurityLevel: local`, `ID`, `Reference0..n` (the harness used `Charset: Shift_JIS`; decode both sides to text before
comparing). Skip blocks whose status is `TIMEOUT` (the DLL hung >20 s; these are 爆弾表示… talks).
Fake the clock to the corpus run (`Date.now` offset; the master run started ≈ 2026-10-06 01:59 +03:00).

**Caveat — different Satori versions.** The corpus DLL is **Mc159-6 (ACP branch)**, the wasm is **Mc203-6**. Measured
on the first 1 500 master requests (two independent wasm runs to separate randomness):

| | unpatched build | patched build (P1–P4) |
|---|---|---|
| identical Value | 1 221 | 1 230 |
| differ only between the two wasm runs (random/time) | 83 | 80 |
| systematic: only `\_w[n]`/`\wN` differ | 70 | 67 |
| systematic: other | 126 | 123 |
| status line differs | 0 | 0 |

Typical systematic differences are version behaviour, not porting bugs: Mc159 writes `…\n\0\_w[204]\s[0]…` where
Mc203 writes `…\n\1\_w[204]\0\s[0]…` (wait placed before the scope switch), and auto-wait lengths differ
(`\_w[126]` vs `\_w[144]`). Full master corpus (5 368 requests, one run): unpatched 3 279 identical / 194 waits-only /
1 887 other / 66 status differences; patched 3 320 / 186 / 1 854 / 58 — the large "other" share comes from state
divergence after early differences (talk choice → variables → later talks).

So the corpus is a **regression net, not an oracle**. Assertions for CI:
1. `_load` = 1 for master/bath/date/meal; no `ErrorDescription` at load except expected SAORI ones.
2. Same status code as the DLL for ≥ 98 % of non-TIMEOUT blocks (measured 100 % on the first 1 500, 98.9 % on all).
3. No Satori error strings in Values that the DLL didn't have (`引数の個数が正しくありません` etc., list in `tests/satori_vs_dll.mjs`).
4. No unresolved `（…）` that the DLL resolved (compare the sets of `（[^（）]{1,30}）` per response).
5. Same set of choice targets: `\q[…,ID]`, `\__q[ID]`, `\_a[ID]` per response, for responses that are identical after
   removing waits.
6. Track the "identical" count; a drop vs. the previous build is a regression.

For exact parity a corpus from the same version is needed: run the same harness (`tools/dll_harness.ps1`) against an official **Mc203-6**
`satori.dll` (32-bit, GitHub release `Mc203-6` of ukatech/satoriya-shiori) — not downloaded. Then expect identical Values except random/time-dependent ones (detect with two wasm runs).
Optional test-only export `satori_test_seed(n)` makes wasm runs reproducible among themselves (not vs. the DLL).

**Performance measured** (Node 24, -O2, one desktop machine): load of Tsubasa master 150–590 ms (first run slower);
1 500 requests in 2.8–4.0 s; the full 5 368-request corpus 303 s; 169 requests > 0.5 s, the slowest 2–7 s
(`爆弾表示９` 7.3 s, Othello `オセロ置場判定…`/`オセロ終了…` 1–3 s, `ぷよ…` ~2 s). The DLL corpus run took 830 s
including 9 × 20 s stalls. Heap 16 MB after load → 71 MB after the full run (mostly variables: the out-of-context
calls grew the savedata to 4.8 MB). → The engine must not run on the page's
main thread; the runtime needs a per-request watchdog (e.g. warn at 2 s, terminate + restart the worker at 30 s,
then resume from the last persisted savedata).

**Stack**: see §10.4.

### 10.4 Stack size check

Build variant linked with the default `-sSTACK_SIZE=64KB` plus `-sSTACK_OVERFLOW_CHECK=2` (every stack-pointer
decrement is bounds-checked) ran the **whole** 5 368-request master corpus without an overflow. A high-water scan of
the stack region afterwards (lowest non-zero byte above the 16-byte stack cookie, via the exported
`emscripten_stack_get_base/end`) gave **≈ 5 KB** used. Most of Satori's recursion state lives in wasm locals and on
the heap (`wstring` buffers), not on the shadow stack.

→ 64 KB would work for Tsubasa; use **1 MB** for head-room against deeper user dictionaries (other ghosts, `call`
chains up to `呼び出し回数制限` 200). 4 MB is also fine; it only costs linear memory. Keep a debug build with
`-sSTACK_OVERFLOW_CHECK=2` in CI so an overflow aborts loudly instead of corrupting the heap.

### 10.5 Browser smoke (manual, later)

Worker: `importScripts('/sumika/engines/satori.js')`; `createSatori({ locateFile: f => '/sumika/engines/' + f,
saoriBridge, print, printErr })`. **Gotcha**: in a worker Emscripten's default script directory is the *worker's* URL
(`self.location.href`), not `satori.js`'s, so pass `locateFile` unless both live in the same folder. Fetch the ghost's
text files (from `site/sumika/index/ghost.<id>.json`), write them to MEMFS in NTFS order, `_load`, send `OnBoot`.

---

## 11. Open questions

1. **Which Satori behaviour?** SSP runs Tsubasa with her bundled **Mc159-6**; Sumika compiles **Mc203-6**. Visible
   differences: auto-wait lengths and wait placement around scope switches (above), plus any fixes since 2018. If exact
   SSP parity matters, the `master` branch (Mc172-3, ACP, `char`-based) could be compiled instead — untested (clang
   passes raw SJIS bytes in narrow literals but warns), and it lacks the Mc2xx fixes. Sumika stays on the unicode
   branch [decision].
2. An official Mc203-6 `satori.dll` would regenerate the corpus for exact comparison (not downloaded, §10).
3. Exact Windows replacement for invalid CP932 byte pairs (U+30FB vs `?`) — unverified. Answered: U+30FB,
   taking both bytes (measured on Windows 11; P1 follows it, see the update under §8 P1).
4. `STACK_SIZE`: 1 MB (measured ≈ 5 KB for Tsubasa); not measured for other ghosts.
5. Save policy: `satori_save` costs 4–7 ms with normal savedata but scales with its size (0.4–0.8 s at 2–5 MB in the
   out-of-context corpus run). The worker saves debounced (§7.3) and also at page hide (`persist`; kawari-wasm.md §7).
6. `CASE_INSENSITIVE_FS=1` is verified to work and is on in `build.py`. (It makes MEMFS reject two names that differ
   only in case — impossible in a ghost copied from Windows anyway.)
7. OS-uptime / since-boot variables across navigations (P2): done as patch P7, the session clock (SUMMARY §2.1).

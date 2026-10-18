# Kawari → WebAssembly: build & integration spec

Status: implemented, measured in Node 24.19 and checked in a browser (§16). Scope: compile
`vendor/kawari-8.2.8` (KAWARI 華和梨 Phase 8.2.8) with Emscripten into `kawari.js` + `kawari.wasm`; the JS ↔ C ABI;
the SSP-shaped file system (YAYA's); persistence and the resume snapshot; the patches K1–K12; detection, the index and
the personal-file guard; tests, sizes and the corpus sweep. Shaped like `yaya-wasm.md`, which it follows wherever the
two engines are alike.

Tags: **[src file:line]** = `vendor/kawari-8.2.8/build/src/…`; **[code]** = read in Sumika's source; **[measured]** =
run here (where: the stage-1 packages R1, P1–P4b of the Kawari work, or the research and prototype before them);
**[corpus]** = a corpus of downloaded archives; **[doc]** = a document; **[disasm]** = read in ssp.exe's
disassembly; **[infer]**; **[guess]**; **[decision]** = a choice made here. No **[observed]** finding (seen in a
running ssp.exe) exists yet. Both Phase 8 site ghosts (bthver.5, machimaki) are installed in an SSP install for that
(§16).

Files: `engines/kawari/build.py` (build), `patches.py` (§5), `em_kawari.cpp` / `em_kawari.h` (Sumika's glue code),
`smoke.mjs` (smoke test); `engines/common/gen_cp932.py` (the code page 932 table, shared with Satori and YAYA);
`src/worker/engines/kawari.js` (`KawariEngine`) on `src/worker/engines/ssproot.js` (`SspRootShiori`, shared with YAYA);
`src/core/engine-files.js` (which files the worker gets); `tools/index_site.py`, `tools/sweep/views.mjs` (detection),
`tools/add_ghost.py` (the guard); `tools/sweep/kawari.mjs` and `tools/sweep/ghost.mjs` (the sweep); tests in §13.
Seams: CONTRACTS.md "Worker protocol" (`SspRootShiori`, `KawariEngine`, `engine-files.js`).

Not in the repository: the site ghosts named here (bthver.5, machimaki: CLAUDE.md "The ghosts Sumika was tested with"),
the corpus of downloaded archives and the emsdk copy in `toolchain/emsdk` (docs/building.md "What the builds need").
These are development material, cited as the sources (CLAUDE.md "Project rules").

---

## 0. Decisions at a glance

| # | Decision | Where |
|---|---|---|
| D1 | This build is Kawari Phase 8.2.8. It runs the 18 Phase 8 ghosts of the corpus (`kawarirc.kis`). The 8 Phase 7 ghosts (`kawari.ini` only, SHIORI/2.x) are engine `kawari7`, which runs on its own 7.5.0 build through a SHIORI/2 bridge (kawari7-wasm.md) [decision]. | §1, §12 |
| D2 | Engine names `kawari` and `kawari7`. The rule runs after the AYA probe, only for the DLL stems `shiori`, `kawari`, `kawari8`, `kawarirc`. | §12 |
| D3 | Kawari is Shift_JIS inside. The build converts at three edges (SHIORI request/reply, SAORI, file names) with the shared Windows table. Encode as ssp.exe does: `WideCharToMultiByte(932, 0)`, best fit on (research R1 [disasm]). | §3 |
| D4 | YAYA's SSP-shaped MEMFS (`/ssp/ghost/<id>/`) and YAYA's persistence rule (every new or changed file under the ghost root). The shared code moved into `SspRootShiori`. | §6, §7 |
| D5 | A page change is a resume: `load`, then a snapshot is restored: the dictionary entries the session changed, and every entry its load made otherwise than by a dictionary definition (a KIS zone or OnLoad: the clock, a random pick), changed or not. The snapshot lives under one reserved key in the ghost's stored files. | §8 |
| D6 | A session that ended without Close (tab closed, crash) is finished at the next cold boot: load, restore, ssp.exe's end-of-session close (OnCloseAll / OnClose with R0 `system`, then OnTranslate; replies dropped), the ghost's `OnUnload`, then a cold load [decision]. So a ghost that saves in OnClose (the BTH family) keeps the session too. The close and the unload run at the time the session ended (the ghost state's `savedAt`), as ssp.exe runs them inside `WM_ENDSESSION` [disasm]; the cold load on the real clock. | §8 |
| D7 | A clean unload leaves an empty marker under the snapshot key, so a ghost that writes no file is not met for the first time again. | §8 |
| D8 | No recursion or loop limit in the engine (the DLL has none). Link with `--stack-first`; the adapter restores the stack pointer after a throw, so a runaway recursion answers 500 and the engine lives. An endless loop is ended by the page: after 30 s the worker is killed and the ghost restarts from its last snapshot (§16). | §2, §4, §16 |
| D9 | Kawari's log goes to `Module.kawariLog`, shown only with `?sumika-debug`. A ghost's `logfile` never writes a file. | §11 |
| D10 | Windows behaviour where cheap: `textload` drops the CR of CRLF, `save` / `textsave` write CRLF, `getenv` finds nothing. | §5, §11 |
| D11 | Personal-file guard: `add_ghost.py --archive` plus a `PERSONAL_PATHS` line per save is the gate (Kawari save names are the ghost's own); a content net on Kawari's save header on top [decision: such files are kept only from the ghost's own .nar / .zip, recorded in the site's `sumika/kawari-shipped.json`]. | §12 |
| D12 | Tests: a CP932 fixture ghost written for the tests, engine tests on the real build, an event-loop integration test, the sweep. No real-DLL corpus: no DLL is run. | §13 |
| D13 | Site ghosts `bthver.5` (BTHver.5_2.732) and `machimaki` (machi_1.0), added from pristine extractions of their archives; an SSP install has both from the same archives, for comparison. | §16 |
| D14 | Other ghosts' save files stay invisible (the BTH family reads its partners' saves by install folder name) [decision]. | §6 |

---

## 1. Inputs and versions

| Item | Value |
|---|---|
| Source | `vendor/kawari-8.2.8` = KAWARI Phase 8.2.8 (2008-03-30, the last release), `KAWARI.kdt/8.2.8` [src libkawari/kawari_version.h]. Downloaded from SourceForge (`kawari-828.zip`, sha256 `32416386…848ab02`); unpacked unchanged without `bin/` (the Windows DLL and tools, never run) (`SOURCE.txt`). Read only. |
| Pin | Not a git repository, so `build.py` pins it by a tree hash: SHA-256 over every file in sorted relative path order of `path NUL size NUL bytes`: `b15b97d8…4df2a7b0`, 177 files (`TREE_PIN`). A mismatch stops the build unless `--allow-vendor-drift` (then `drift: true` in build-info). A new pin means matching the patches again and re-running §13–§15. |
| Licence | Modified BSD (`license.txt`; clause 2 wants the notice with a binary) and MT19937's BSD-3-Clause notice in `misc/mt19937ar.cpp`. `include/shiori.h` says public domain. No other notice in the compiled files [measured, research]. |
| Source encoding | EUC-JP (106 files), CP932 (3), 3 with stray bytes; all non-ASCII is in comments, no string or char literal holds a non-ASCII byte [measured, research]. So a UTF-8 copy cannot change the program. |
| Emscripten | emsdk 6.0.11 in `toolchain/emsdk`, called as `python.exe …/em++.py` with an absolute `EM_CONFIG` and `EMSDK_PYTHON` = emsdk's own Python (a relative `EM_CONFIG` once cleared the whole library cache; the same `EMSDK_PYTHON` line went into the Satori and YAYA builds, which stayed byte-identical [measured, P1; decision]). |

**Phase 8 against Phase 7.** The corpus has 26 Kawari ghosts [measured, corpus]. Phase 8 loads `kawarirc.kis` and
speaks SHIORI/3.0; Phase 7 reads `kawari.ini` and speaks SHIORI/2.x (`GET Sentence`, `GET String`, `TEACH`, …), which
8.2.8 cannot load. The ghosts' own DLLs (version strings read in memory from the UPX-unpacked DLLs [measured, corpus]):

| Kawari | Ghosts |
|---|---|
| 8.2.8 | honue090104, rotten101010 (and snow girl's `kawari.dll`, a SAORI of a Satori ghost) |
| 8.2.4 | BRH1.251; bloody_moon (an MSVC build) |
| 8.2.2 | Aria, firefox |
| 8.2.0 | toxic060816 |
| 8.1.0 | BTH4th_last, BTHver.5_2.732, asri101, meganeoni040313, somberlain |
| 8.0.0 | brynhild_conf1.13, kuro_r030114b, machi_1.0, umikoF, wakaba001, norn_04.00 |
| Phase 7 (engine `kawari7`, kawari7-wasm.md) | mayura_v350 (kdt.i18n 7.5.0), haruka65 (kdt 7.4.0), maria_re, nijino, teruno109, sakura_r030103b (kpcg 7.3.1), alto_beta2 (kpcg 7.0.1), gleto (7.0.0) |

8.2.8 is the only 8.x source available. The changelog lists behaviour changes in 8.2.0 (`split`, `join`, string
search, `break`/`continue` only in loops) [doc], and 8.0-era syntax that 8.2.8 rejects costs entries (§15) [decision:
accepted]. ssp.exe has a "kawari 7.0 compatible mode" for SHIORI/2.x Kawari DLLs [disasm, R1]; a Phase 7 engine needs
a Kawari 7 source (kawari7-wasm.md).

---

## 2. Sources, flags and outputs

`engines/kawari/build.py` [code]:

1. **Check the input** (§1): the tree pin; the emcc version goes into build-info and into every object's hash.
2. **Copy** `build/src/**/*.{cpp,h}` into `engines/kawari/build/src` as UTF-8 with LF (EUC-JP; else CP932; else
   EUC-JP with replacement, which only comment bytes need), plus Sumika's glue `em_kawari.cpp` / `em_kawari.h`.
   Never compiled: `tool/`, `*/old/`, `saori_java`, `saori_python`, `py_shiori`.
3. **Generate** `misc/cp932_table.h` (`engines/common/gen_cp932.py … --verify engines/common/cp932`, stop on any
   mismatch) and **patch** (§5): each `old` exactly once.
4. **Compile** 41 units: the 40 of `files.mak` (`CORESRC` with the KIS and crypt files, `CORESRC_NATIVE` =
   `saori/saori_native`, which K5 turns into the JS bridge, `SHIOSRC`) and `em_kawari.cpp`. Flags: `-O2` (or `--opt
   Oz`) `-std=c++11 -fwasm-exceptions -DNDEBUG -DENABLE_SAORI_NATIVE -Wall -Wno-unknown-pragmas
   -Wno-overloaded-virtual -Wno-writable-strings` (776 `char *Name_ = "…"` warnings, no effect on the code),
   `-ffile-prefix-map=<src>=src` in both slash styles; `--debug` = `-O0 -g -fdebug-compilation-dir=.` plus the emsdk
   prefix map. Objects are kept per variant (`obj-O2/`, `obj-Oz/`, `obj-debug/`), keyed by a hash of the source, every
   header, the flags and the emcc version. One warning remains (upstream `-Wunused-const-variable`) [measured, P1].
5. **Link** in `engines/kawari/build/link-<variant>/`: `-fwasm-exceptions -sMODULARIZE=1 -sEXPORT_NAME=createKawari
   -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sSTACK_SIZE=1MB
   -sCASE_INSENSITIVE_FS=1 -Wl,--stack-first` (Satori's set plus stack-first: an overflow traps instead of writing over
   the static data) and the exports of §4; `--debug` adds `-sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2`.
6. **Check, then publish**: `kawari.js` / `kawari.wasm` must not name the builder's home folder, `AppData` (as a
   folder) or the project path; then `kawari.js`, `kawari.wasm`, `kawari.build-info.json` (`{kawari: '8.2.8', treePin,
   zipSha256, drift, emcc, patches, opt, debug}`) and `kawari.LICENSES.txt` go to `--out` (default
   `site/sumika/engines`; `--debug` to `engines/kawari/build/out-debug` unless `--out`). Comparison builds go to a
   scratch `--out`.

Usage: `python engines/kawari/build.py [--opt O2|Oz] [--debug] [--out DIR] [--allow-vendor-drift] [-j N]`. Time: about
56 s to compile with 8 jobs and 6–10 s to link [measured, prototype]. A rebuild with nothing changed is byte-identical
on all four outputs [measured, P1, P2]. A `--debug` build is refused by the builder-path check: the emsdk cache's
`-debug` libc++ libraries carry the builder's path in their DWARF; fixing it means rebuilding those cache libraries
with a prefix map (not done: shared toolchain) [measured, P1]. The -O2 and -Oz builds are clean. The same cache serves
YAYA's and Satori's debug builds: Satori's build.py links in `engines/satori/build/link-*`, checks the same strings and
writes a `--debug` build to `engines/satori/build/out-debug` (a debug build is refused there too: it names the project
path) [measured].

**`kawari.LICENSES.txt`** (`licenses()` in build.py, `engines/common/notices.py`): a header (8.2.8, the zip's sha256,
the tree pin, "compiled to WebAssembly with patches by Sumika"), Kawari's `license.txt` whole (modified BSD, "Copyright
(C) 2001-2008 KAWARI Development Team"), MT19937's notice cut from `misc/mt19937ar.cpp` (the build stops when the
notice moved), and last, as in every engine's notices, what Emscripten compiles in (`notices.emscripten`: its runtime
and system libraries, with Emscripten's `LICENSE` and musl's `COPYRIGHT`, read from `toolchain/emsdk`). About Sumika
names the engine's own parts (`DEFAULT_ENGINES` in `src/ui/info.js`: "Kawari (modified BSD,
sourceforge.net/projects/kawari; MT19937 (BSD-3-Clause))"), and docs/licenses.md says the same.

---

## 3. Charset (research R1)

Kawari never converts: it keeps header bytes in `System.Request.*` and always answers `Charset: Shift_JIS` [src
shiori/kawari_shiori.cpp:258, 270, 300]. Its dictionaries, saves and file names are code page 932 bytes.

**What ssp.exe does** [disasm, R1; ssp.exe FileVersion 2.9.10.3000, the installed build]:
- After `load()`, Kawari 8.2.8 (no `getversion` export) gets `GET Version SHIORI/2.6`, then `GET SHIORI/3.0` +
  `ID: version`, both pure ASCII with `Charset: UTF-8`. Kawari's reply says `Charset: Shift_JIS`; from then on every
  request says `Charset: Shift_JIS` and is encoded with **code page 932 by name** (SSP's own table: `Shift_JIS` /
  `X-SJIS` → 932; not the ANSI code page, so an ANSI code page such as 1252 does not matter).
- Encode: `WideCharToMultiByte(932, 0, …, NULL, NULL)`: **flags 0, so best fit** (`é` → `e`, `¥` → 0x5C, `«` →
  0x81E1, `ゔ` → 0x8394, `¢ £ ¬` → 0x8191/0x8192/0x81CA), the default `?`, `??` for a character outside the BMP;
  nothing normalised first (U+301C `〜` → `?`), nothing escaped (`shiori.escape_unknown` is off by default).
- Replies: each value decoded with `MultiByteToWideChar(cp, 0)`, `cp` from the reply's own `Charset` (932 here): an
  invalid pair becomes one U+30FB `・`.
- SAORI: SSP sits in the data path only for the 8 DLL names it emulates itself (houchi, clipcopy, textcopy, saori_ip,
  saori_cpuid, mciaudio, cpuusage, httpc; a substring match): it decodes Kawari's Shift_JIS request and answers in
  Shift_JIS, best fit. Every other DLL gets Kawari's bytes unchanged.

**What Sumika does.** The page and the worker stay UTF-8 (`Charset: UTF-8` on every request). Patch K4 converts at
the wasm's edge: a request saying `Charset: UTF-8` reaches Kawari in code page 932 saying `Shift_JIS`; the reply comes
back in UTF-8 saying `UTF-8`; any other request passes unchanged. Decode = `MultiByteToWideChar(932, 0)` (an invalid
pair is one U+30FB); encode = the table's `WC_NO_BEST_FIT_CHARS` part plus its 85 best-fit entries (YAYA's Y1 data;
`EM_CP932_BEST_FIT 1` in `em_kawari.cpp`), which equals `WideCharToMultiByte(932, 0)` (the dumps in
`engines/common/cp932` were made with those exact arguments) [measured]. The same encoder serves the SAORI edge (K5)
and `_kawari_utf8_to_cp932`, which writes the other ghosts' `descript.txt` for the SSP view (§6): one encoder for every
UTF-8 → 932 edge [decision; SSP itself never re-encodes another ghost's descript].

Checked [measured, smoke and `tests/kawari_engine.test.mjs`]: `ソ表能～－①＼髙ⅰ` → `835C 955C 945C 8160 817C 8740 815F
FBFC FA40`; `é¥«ゔ¢£¬` → `65 5C 81E1 8394 8191 8192 81CA`; `〜` → `3F`; `😀` → `3F3F`; `81 7F` reads as one `・`;
`FA40` ↔ `ⅰ`; the ghost reads `System.Request.Charset` = `Shift_JIS`.

---

## 4. ABI: exports and Module hooks

| Export | Semantics |
|---|---|
| `load(dir, len)`, `request(req, &len)`, `unload()` | Kawari's own POSIX SHIORI exports already have Satori's ABI: `load` frees the path, `request` frees the request and returns a malloc'd reply without a NUL that the caller frees [src shiori/shiori.cpp:47-75]. K4: `load` converts the folder to code page 932, `request` converts as §3. `unload` runs `System.Callback.OnUnload`. |
| `kawari_baseline()` | after a load: record each entry's word ids and which entries the load made (other words than its dictionary definitions, K12's `EmDefined`); returns the number of entries, -1 without an engine (K12). |
| `kawari_snapshot(path, all)` | write the entries that differ from the baseline and the load-made ones to `path` (UTF-8, MEMFS); `all` = 1: every entry (the sweep's check). The file is always rewritten; returns its size, 0 = nothing to carry, -1 = no engine or unwritable (§8). |
| `kawari_restore(path)` | load a snapshot into the running engine (after its load and baseline); 1, or 0 without an engine or a readable file. |
| `kawari_utf8_to_cp932(s, len, &outlen)` | the build's encoder (§3); a malloc'd buffer plus a NUL that the caller frees. |
| `malloc`, `free` | buffers. |

Runtime methods: `FS`, `HEAPU8`, `HEAP32`, `UTF8ToString`, `stringToUTF8`, `lengthBytesUTF8`, `stackSave`,
`stackRestore`.

| Module hook | Use |
|---|---|
| `saoriBridge` `{load(path, dir), request(handle, bytes), unload(handle)}` | K5: Satori's P2 interface, UTF-8 both ways (§10). |
| `kawariLog(line)`, `kawariLogLevel` | K8 / K9: one call per log line, UTF-8, without the line end; level a number, default 3 = error\|warning (§11). |

`EmscriptenShiori._stackGuard(fn)` (emscripten.js) takes `stackSave()` before `request`, `callLoad` and `unload` and
calls `stackRestore()` first after a throw, when the module exports both (D8). A runaway recursion throws a RangeError
out of the wasm, which skips the epilogues that would restore the stack pointer; without the guard about 12 such
throws corrupt an -O2 engine [measured, research]. Kawari exports both; the Satori and YAYA builds do not, so the
guard does nothing for them (they are not rebuilt with stack-first: §16 "Not done").

---

## 5. Patches (`engines/kawari/patches.py`)

42 entries (build-info `patches: 42`), each an exact-once
replacement on the UTF-8 copy. Every behaviour change is
under `__EMSCRIPTEN__` except K1–K3. The code they call is in `em_kawari.cpp` / `em_kawari.h` (`misc/l10n.h`
includes the header, so every patched file sees it).

| Id | Entries | File | Change |
|---|---|---|---|
| K1 | 3 | misc/mmap.h | `this->lower_bound`, `this->upper_bound`, `this->insert`: two-phase lookup, needed to compile. |
| K2 | 4 | shiori/kawari_shiori.cpp | spaces in `"SHIORI/" SHIORIVER` and `KAWARI_MAJOR "." …`: C++11 user-defined literals. |
| K3 | 4 | libkawari/kawari_lexer.cpp | the lexer's 256-entry class tables indexed by `(unsigned char)`. A signed `char` read outside the tables for 0x80–0xFF, so half-width kana entry names broke (`${ﾃｽﾄ･ﾃｽﾄ}`; 8.2.5's "0xa5 midpoint" bug) [measured, research; doc changelog]. The real DLL read outside its tables, so its result depended on memory layout (running a real DLL would settle it). |
| K4 | 4 | misc/l10n.h, shiori/shiori.cpp (+ glue) | code page 932 ↔ UTF-8 (§3); `load`'s folder to 932; the request/reply conversion and `Charset` rewrites. |
| K5 | 6 | saori/saori_native.cpp | SAORI → `Module.saoriBridge` (§10): one handle per DLL path (case-insensitive on single bytes), counted like `LoadLibrary` / `FreeLibrary`; request 932 → UTF-8, reply UTF-8 → 932 with `Charset: Shift_JIS`; `dlopen` and the fallbacks compiled out. |
| K6 | 10 | libkawari/kawari_engine.cpp, kis/kis_file.cpp, kis/kis_system.cpp | every file call converts Kawari's code page 932 path to UTF-8 for MEMFS; `readdir` names come back as 932 (`save テスト.txt` works). Two of the 10 also carry K11. |
| K7 | 1 | kis/kis_system.cpp | `getenv` finds nothing (YAYA's N8: Emscripten's HOME/USER/PATH are not the visitor's). |
| K8 | 1 | shiori/kawari_shiori.cpp | the logger's stream → `Module.kawariLog(line)` in UTF-8, level `Module.kawariLogLevel`; a ghost's `loglevel` still applies. |
| K9 | 1 | kis/kis_system.cpp | `logfile NAME` and `logfile -` point the log at the same sink; no file is ever made (a `.txt` log would pass the `*.log` guard); `logfile` alone stops logging, as in Kawari. |
| K10 | 1 | kis/kis_file.cpp | `textload` drops one trailing CR per line that ended in LF (Windows text-mode read); a CR at the very end of the file stays [decision, infer: the C runtime's text mode]. |
| K11 | (in K6) | libkawari/kawari_engine.cpp, kis/kis_file.cpp | `save`, `savecrypt`, `textsave`, `textappend` write CRLF (`EmTextOfstream`, Windows text-mode write) [decision, D10]. |
| K12 | 7 | shiori/kawari_shiori.cpp, kawari_shiori.h, libkawari/kawari_ns.h, libkawari/kawari_dict.cpp, libkawari/kawari_engine.cpp, libkawari/kawari_code.cpp (+ glue) | the snapshot's hooks: `Load` hands its engine to the glue (`Unload` and the destructor take it back); `TEntry::IsWriteProtected`; the garbage collector reports the word ids it frees; `LoadKawariDict`'s dictionary mode reports each definition (`EmDefined`) and KIS's `function NAME body` its body (`EmDefinedOnly`), so the load-made entries can be told (§8). |

Not patched on purpose [decision]: `SRandom(time(NULL))` at load; the iterator erase in `~TUniqueModuleFactory` (the
map is empty by then; AddressSanitizer clean over 26 unloads [measured, research]); `isexist`'s exact-case compare (the
DLL does the same); `save` of an absolute path (cut to its file name, as on Windows); no recursion limit (D8).

---

## 6. MEMFS layout (the SSP view)

YAYA's layout (yaya-wasm.md §6), from `SspRootShiori` (`src/worker/engines/ssproot.js`):

```
/ssp/ghost/                              readdir ../../..: the site's ghosts, in NTFS order
/ssp/ghost/<other id>/ghost/master/descript.txt
                                         every other site ghost's, in code page 932 saying charset,Shift_JIS
/ssp/ghost/<id>/                         this ghost's root, the persistence root
    install.txt, readme.txt, shell/<sid>/descript.txt, a bundled balloon's text …   with their bytes (KAWARI_TEXT)
    shell/<sid>/surface0.png, sounds …   0-byte placeholders: isexist / isfile / readdir see them
/ssp/ghost/<id>/ghost/master/            the path given to load(); System.DataPath
/ssp/balloon/<balloon id>/               empty folders, one per site balloon
/sumika/resume.kis                       the snapshot (§8): outside /ssp/, the ghost never sees it
```

- Kawari's `CanonicalPath` turns `\` into `/` and resolves `../` against the data path [src misc/misc.cpp:74-124], so
  the corpus' reads land where they do in SSP: `../../shell/<x>/descript.txt`, `readdir ../../..` and
  `../../../<ghost>/ghost/master/descript.txt` (KEEPS's installed-ghost scan) [corpus].
- `System.DataPath` shows the POSIX path [decision], as YAYA's `coreinfo.path`.
- The other ghosts' descripts are code page 932 (Kawari ghosts `textload` them as Shift_JIS bytes; YAYA's stay
  UTF-8): `sspDescript(g, 'Shift_JIS')` through `_kawari_utf8_to_cp932` (best fit, `?` for what 932 lacks).
- Absent, as on a PC without them: `../../profile.txt`, SSP's `log/`, `data/profile/`, `crow.ini`, and every other
  ghost's save files (D14: the BTH family and toxic read their partners' saves by install folder name, which would
  also need site ids equal to install folder names, spaces included: `blood tea house`).
- `-sCASE_INSENSITIVE_FS` gives Windows lookups (`isfile KAWARIRC.KIS` = 1). Kawari has no KIS command that deletes or
  renames a file, so YAYA's J1 case cannot arise.
- **Which files** (`engine-files.js`): `rootFilePlan(files, rootEngine('kawari'))`. `KAWARI_TEXT` = YAYA's text set plus
  `kis` and `kaw` (`txt dic ayc aym ini csv dau json xml yaml yml toml htm html m3u kis kaw`) up to 4 MiB with bytes;
  `KAWARI_SKIP` never: `profile/`, `*_variable.*`, `satori_save*` (asri101, a Satori emulator written in KIS, writes
  `satori_savedata.txt`), `*.log`, `*.dll`, `*.exe`; every other file a placeholder. Every `load` target in the corpus
  is `.kis` or `.txt` [corpus]. The index packs the same set (`index_site.py KAWARI_PACK_EXT` = `KAWARI_TEXT`, kept
  equal by a test), so a Kawari ghost's start fetches no text file on its own.
- `engineOpts` = `{ghostId, placeholders, site}` (no `module`: Kawari reads `ghost/master/kawarirc.kis`).
  `Runtime._startEngine` picks the plan by `rootEngine(engine)` (`ROOT_ENGINES` in engine-files.js: yaya, kawari).

---

## 7. Persistence

YAYA's rule, unchanged (yaya-wasm.md §7; `SspRootShiori.changedFiles`): IndexedDB `sumika` / `kv`, key
`ghost:<id>:files`, ghost-root-relative keys; bytes for new or rewritten files (a rewritten shipped file shadows the
site's copy: toxic rewrites its shipped `brain/memories2.txt` [measured, research]); `null` for a shipped file gone
(Kawari never deletes one, so none in practice); never `*.log`.

Kawari has no engine-level save [src kawari_shiori.cpp:119-126]: the ghost's own `save` / `savecrypt` / `textsave` /
`textappend` write files of names it picks (`savefile1.txt`, `dict-keeps-savedata.txt`, `memory/savedata.txt`,
`brain/memories2.txt`, even `satori_savedata.txt`) [corpus], in code page 932 with CRLF (K11). The worker's scan of the
ghost root reports them after each request that wrote a file: `SspRootShiori` marks itself dirty at every FS call that
can change a file (`watchWrites`), and `changedFiles()` skips the scan when nothing was written since the last report
[code]. A scan after every request would cost about 16 ms for bthver.5's 1,507 files (1,444 of them empty
placeholders), against 0.1–0.2 ms for the request itself, so a mouse moving over the ghost would keep the worker busy;
the scan walks MEMFS's nodes instead of resolving each path (about 1 ms for bthver.5, 0.4 ms for emily4's 291 files,
against 15–17 ms and 4 ms by path) [measured, Node]. Satori's base filter (`/save|\.sat$/`) would lose toxic's file,
which is why the root base class is used. The site ghosts store `ghost/master/savefile1.txt` and
`ghost/master/savebackup.txt` (bthver.5) and `ghost/master/dict-keeps-savedata.txt` (machimaki) [measured, site
sweep].

The engine's own state, the dictionary, goes into the snapshot key (§8). The key is reported only when its bytes
change, but ghosts that count seconds in an entry change it every second (`cnttalk`, the talk countdown, in the KEEPS
ghosts and bthver.5: a new snapshot after 30 of 30 idle seconds for both site ghosts once booted [measured]). Each GET OnSecondChange schedules the worker's debounced save, so an idle Kawari ghost stores its whole
map (the snapshot, about 1–2 KB for the site ghosts while idle, and its save files) in IndexedDB about once a second,
as YAYA does [code]. A ghost whose
snapshot stays the same stores nothing. The worker calls `save()` on its usual rhythm (debounced 1 s, urgent after
choices, `persist` at page hide); a snapshot costs at most a few ms (§14), well under the 50 ms that would slow the
rhythm.

---

## 8. Resume: the entry snapshot

Why: Kawari's whole state is its dictionary, and many ghosts save only in `System.Callback.OnUnload` (KEEPS's
`SaveData`; kuro writes nothing until unload) [measured, research]. A page change never unloads, so a plain `load` on
the next page would lose everything since the ghost's last own save. This is Kawari's YAYA N3.

**The key.** `RESUME_KEY` = `?kawari/resume.kis` in the ghost's stored files (`?` cannot occur in a Windows file name,
so it never clashes with a ghost's file); `/sumika/resume.kis` in MEMFS. Three states [decision]:
- absent: never met;
- an empty buffer: met, nothing to restore. Written at a clean unload (D7), by the first `save()` that finds nothing to
  carry (nothing changed and nothing load-made, below; a ghost that booted is met even when its tab was closed), and
  when a snapshot is dropped;
- bytes: `# dicStamp <8 hex>` + LF, then `_kawari_snapshot`'s file. The first line is a comment for Kawari and names
  the dictionaries the snapshot was taken against, so a cold boot (which gets no engine state from the page) can tell
  a snapshot of other dictionaries [decision].

`hasSave` counts the empty buffer (`ArrayBuffer` of length 0), so `firstBoot = !hadSave` stays false for a ghost that
never writes a file (somberlain, norn: no files [measured]). Without D7 they would play OnFirstBoot at every visit after
a Close.

**The snapshot file** (K12, `em_kawari.cpp`; LF line ends, code page 932 bytes like every dictionary) [decision, P1]:
- `# clear NAME`: every entry written, and every entry the session emptied; `kawari_restore` clears them in C++ before
  it loads the file;
- `# move N NAME` + `System.Sumika.Snapshot.N : words`: an entry whose name the dictionary syntax cannot read back
  (`set` takes any name) loads under a temporary name and moves to NAME after the load;
- `NAME : word , word`: the words in `save`'s own format (`GetWordFromID`: the decompiled word, what ghosts save and
  reload themselves). Kawari joins adjacent string literals on the way back (`"a""b"` → `"ab"`), the same words.
- Left out: `System.Request*` and `System.Response*` (every request rewrites them), write-protected entries (they
  refuse writes; see the gap below), `System.Sumika.Snapshot.*`, and names with CR, LF or NUL.

**Load-made entries** [code]: the entries that differ from the page's own load are not enough. Every page loads
again, and an entry a KIS zone or `System.Callback.OnLoad` writes may come out otherwise on each load: KEEPS'
`.setstr cntwork $(MinCalc)` (the minute of the load, dict-keeps.kis:700-703), honue090104's `Wearmode` (a random
pick). The session never changes them, so a snapshot of changed entries alone leaves them out, and each page would take
the new load's value: machimaki's `Worktime` (`MinCalc - cntwork >= 60`) would never say its hourly line while the
visitor changes pages more often than once an hour, where SSP's one load keeps the first value all session [measured:
`cntwork` was load-set in the five KEEPS ghosts, K1]. K12's hooks record the definitions a load reads: every word
`LoadKawariDict`'s dictionary mode pushes (`EmDefined`) and the body of KIS's `function NAME body` (`EmDefinedOnly`:
the body is the zone's own text). `kawari_baseline` marks an entry load-made when load left it with other words than
those definitions (or with none; a definition word whose id was freed and handed out again later in the load counts as
changed), and every snapshot carries the load-made entries with their words, changed or not, plus a `# clear NAME` for
each defined entry load emptied that is still empty. Definitions come back the same from every load and stay out
[decision]. So a snapshot is rarely empty: right after load (nothing changed yet) bthver.5 carries 38 entries (1.5 KB:
its user and state entries, which its load scripts set), machimaki 20 (845 bytes, `cntwork` among them), asri101 415
(58 KB: the Satori dictionaries its KIS emulator builds at load) [measured, Node]. Function bodies stay out
for a second reason: loaded back as dictionary lines they are slow (asri101's 39 KB of them took 17 s to restore,
against 4 ms for its other 42 KB) [measured]. The resume costs bthver.5 234–252 ms, asri101 128 ms, Aria 456–476 ms
in Node [measured].
- Not carried: an entry a load reads as a definition from a file the session rewrote (a save the ghost wrote
  mid-session, then changed back to that page's load value) or from a dictionary a load script picks by date or by
  chance; the next load gives it the new file's words [measured: firefox's `closemode` and `freeze` in one K3 run,
  after the walk's mid-run Close rewrote its save; a dictionary picked by date: infer, none known]. The sweep's
  `loadSet` column counts such entries (§15).

**Recycled word ids** [measured, P1]: word ids are not stable within a module. The dictionary's garbage collector
frees ids and `TWordCollection` hands them out again, last freed first, so a counter can end with the same id list as
the baseline but another word. K12 therefore reports freed ids from
`TNS_KawariDictionary::DeleteContext`, and an entry that holds a freed id counts as changed. A build without that hook
lost a counter in the smoke check written for it.

| Step | What happens |
|---|---|
| Cold boot | `_load`, then `_kawari_baseline()` (`entries`). |
| `save()` | `_kawari_snapshot('/sumika/resume.kis', 0)`; stamped; reported under `RESUME_KEY` when its bytes changed; nothing to carry = the empty marker. Entries restored from the last page differ from this page's baseline too, so they stay in it; load-made ones are in it anyway. |
| Resume (`resume && hasSave`, stored `dicStamp` = this one) | `_load` (kawarirc.kis runs, SAORIs register), baseline, `_kawari_restore`. Entries the session changed come back, and so do the load-made ones with the cold boot's words (`cntwork` keeps the minute of the first load); definitions read as they are keep the new load's (the same) words. No OnBoot, as for every engine (`resumed = 'restored'`). |
| Resume after a site update (another `volatile.dicStamp`) | a cold `_load`, the snapshot dropped (old entries never go into changed dictionaries, so D6 does not run either); `STAMP_CHANGED` at info (`'dropped'`). |
| Cold boot with a snapshot of other dictionaries | dropped, info 'the snapshot of the last session is of other dictionaries: dropped'. |
| Unload (Close, ghost change, Quit) | `_unload` runs `OnUnload` (the ghost saves itself), then the empty marker (D7). After an `_unload` that threw the last snapshot stays, so the next cold boot can still finish that session. |
| Cold boot with a non-empty snapshot (the last session ended without unload) | D6: `_load`, baseline, restore, the close ssp.exe sends when Windows ends the session (`closeFromOutside()`: GET OnCloseAll [`system`, `0`, `0`] BaseID OnClose, GET OnClose on a reply without script, GET OnTranslate [the script, '', the event that answered, `system`]; every reply dropped), `_unload` (its `OnUnload`), then `_load` and baseline again (`'finished'`; `d6Close` = {steps, ms}). The close and the unload run on a clock from `sessionEndMs`, the time the session ended (`runAt`; `d6At`; below), the second `_load` and everything after on the real clock again; without an end time, or with one not before now, all of it runs on the real clock. The first report stores every file the close and the unload wrote. Info `D6_FINISHED` = 'the last session ended without Close: it was closed from its snapshot (OnClose "system", OnUnload) before this boot', debug '`kawari`: closed from outside: OnCloseAll 204, OnClose 200, OnTranslate 204 (N ms)' and, with an end time, '`kawari`: closed at the session's end, N min before this boot' [decision]. A snapshot that does not load gets no close (only the unload). The snapshot is dropped either way. |

**D6 closes the session as ssp.exe closes one Windows ends** [decision; disasm shiori-events.md §2.3.1; measured].
The session's `OnUnload` alone keeps nothing for the many Kawari
ghosts that save in OnClose or OnGhostChanging (in K3 seven of the 17 Phase 8 corpus ghosts D6 finished, and 7 of the
8 Phase 7 ones: the session would be lost, as after a killed SSP). The close is silent, because visitors move between
the site's pages and that must stay seamless. A link to another page of the site is a resume from the snapshot, not a
cold boot, so D6 never runs there. The close is the one ssp.exe 2.9.10 sends every ghost on `WM_ENDSESSION` (Windows shutdown or
logoff: `ForceQuitApplication(L"system", 0, 0)`), the session ending from outside, which is what a closed tab is:
GET OnCloseAll with R0 `system`, R1 `0`, R2 `0` and BaseID OnClose; GET OnClose with the same References when that
reply has no script; the goodbye through GET OnTranslate (R0 the raw script, R1 empty, R2 the event that answered, R3
`system`); then the unload (`ModuleUnload` comes before the goodbye plays on that path). Sumika drops every reply: no
page exists to play it, and ssp.exe never plays an earlier session's goodbye at the next start. Kawari 7's `request()`
bridges each request to SHIORI/2.x (`GET Sentence SHIORI/2.2` with `Event` / `BaseEvent`, `TRANSLATE Sentence
SHIORI/2.6`). A request that throws (a runaway recursion) answers 500 with the stack restored, the close goes on (no
OnTranslate without a script) and the unload still runs. Measured over the 26 Kawari corpus archives and the 3 site
ghosts: every ghost answers OnCloseAll 204, then OnClose 200 with a goodbye; the
close takes at most 6 ms in that probe (1–11 ms in the sweep, K4); the files D6 writes equal, byte for byte, those of a resumed session that is closed the same
way and unloaded; OnTranslate changes no saved file. Of the 14 corpus ghosts whose session an unload alone loses (7
Phase 8, 7 Phase 7), 12 keep it (BRH1.251, BTH4th_last, BTHver.5_2.732, honue090104, rotten101010, toxic060816; Phase 7:
alto_beta2, gleto, haruka65, nijino, sakura_r030103b, teruno109), and so does the site's bthver.5; somberlain and
maria_re save nothing when they close, in SSP too, so theirs stays lost (the sweep also says `no effect` for
sakura_r030103b, whose save comes out as its shipped file: kawari7-wasm.md §7). brynhild_conf1.13 also writes `dict-cr.txt` in the close. bthver.5 saves (`Save1`, `Save3`) in
`event.OnClose` and `event.OnGhostChanging` [corpus core/core.txt:869-905], so a tab closed without Close keeps its
counters, stamps and moods. `tests/kawari_engine.test.mjs` pins it with an OnClose-saving variant of the fixture (and
the requests one by one, an answering OnCloseAll, a runaway OnClose), `tests/kawari7_engine.test.mjs` with a Phase 7
one; the sweep's D6 check closes the resumed session the same way (§15, run K4).

**At the session's end** [code; disasm shiori-events.md §2.3.1; measured]. ssp.exe runs that whole close
inside its `WM_ENDSESSION` handler: `CMainFrame::OnEndSession` (0x46dd50) calls `ForceQuitApplication(L"system", 0,
0)` (0x46dd6d), whose `GhostExitProc` → `CloseGhostProc` sends the close requests, `TranslateScript` (0x496938) and
`ModuleUnload` (0x49694a) synchronously, then `WaitForApplicationQuit` (0x46dd74), which is `SPEventObject::WaitPump(-1)`
(0x46dda8), an infinite wait; only then `ShutdownBlockReasonDestroy` and the return to Windows [disasm, installed
2.9.10.3000]. SSP's requests carry no time, so the ghost reads the clock itself, and Kawari's `date` is `time(NULL)` +
`localtime` in both versions [src kawari-8.2.8 kis_date.cpp:41-43, kawari-7.5.0 kis_date.cpp:27-28]: a ghost's
OnClose / OnUnload stamps are the moment Windows ended the session, and its next boot counts the time away from there.
Sumika does the same:
- The page passes the session's end: `Runtime._boot` reads the ghost state's `savedAt` on a cold boot of a ghost whose
  state is stored (`!resume && !state.isNew`), before the boot's own state write, which sets it anew; it goes as
  `sessionEndMs` through `_startEngine`, `ShioriClient.start` and the worker's `init` message into `init`'s options (0
  otherwise; Satori and YAYA ignore it). `savedAt` is the only time stored: the state is written synchronously to
  localStorage at every save, at pagehide (`Runtime._onPageHide`, `StateStore.bindPage`) and when the tab is hidden,
  and by the debounce at most 2 s after a change; only the tab that holds the ghost's lock writes it. The snapshot's
  stamp is a dictionary hash, and the worker's last save time lives only in its memory.
- `runAt(sessionEndMs, fn)` runs the close and the unload with `Date.now` going on from that time (the end plus the time
  since, so successive writes keep their own mtimes), and puts back whatever `Date.now` was in a `finally`. Both Kawari
  builds read the time only through `emscripten_date_now` (`Date.now()`; no `clock_time_get`, no
  `emscripten_get_now`), so `time()`, `date` and the MEMFS mtimes of what the close writes follow it; `localtime` takes
  the time it is given; `new Date()` (only `__tzset_js`'s DST offsets for the current year) and `performance.now` do
  not. The SAORI stand-ins see the end time too. The window is synchronous inside `init`: the worker handles no other
  message meanwhile, and the page sends no request before `init` answers. `d6At` is the end used (0: the real clock).
- No end time (a state never stored, a state from before `savedAt`), or one not before now (the clock was set back):
  the real clock. A very old end is used as it is (SSP has no limit; machimaki's 31-days-over talk needs it).
- The files the close writes get the past mtimes; change detection compares the stamp for inequality, so the first
  report still stores them, and `_hot` never takes them (stamped before the report).
- Kawari's random seed (`SRandom(time(NULL))` in load [src kawari_shiori.cpp:91]) comes from the new visit's first
  load, the second load reseeds on the real clock; SSP's draws at a Windows shutdown are its own anyway.

Measured on the site copies with the real builds [measured, Node; a one-off script, no project file]: a first
visit closed with Close, a second visit of 30 minutes whose tab closes at 2026-09-01 20:30, then a cold boot later.
machimaki, 40 days later: with the end time KEEPS' OnUnload stores `endtime 13501230` / `endday 9375` (the end) and the
next OnBoot plays `TalkBootup.long.31over` 'お久しゅうございます。…' [corpus dict-keeps.kis:1239-1245, 1273-1280,
1325-1337; dict-keeps-setting.kis:125-137]; on the next visit's clock it stored `13558830` / `9415` and played
`TalkBootup.short.0to3min` '破滅へのロンド！…' (called back within 3 minutes). bthver.5, 3 days later: its OnClose stores
`CoEndtime 13501230`, `CoEndday 9375`, `Work_Day 0901` [corpus core/core.txt:868-875] against `13505550`, `9378`,
`0904`, so its boot counts 3 days away (`HaltCheck`'s `minblank` / `dayblank`, core/core.txt:613-617) instead of 0.
Every other saved line is the same. mayura (Kawari 7) stamps no time: no difference. `Date.now` was the real (test)
clock again after every init. In the sweep (run K5, §15) the D6 check boots a day later with the session's end:
the files D6 writes equal B's own close and unload for every ghost, where the same run without the end time (the clock
the only difference) differs for 11 of the 18 Phase 8 archives and both site ghosts, every one whose close or unload
saves something of the time (the BTH family's stamps, the KEEPS ghosts' `endtime`, brynhild_conf1.13's session length
in its reward, toxic060816's `brain/memories2.txt`); the Kawari 7 corpus saves no time there.

Notes:
- KEEPS' "you crashed last time" talk does not come after a tab closed without Close: KEEPS sets `closemode 1` in
  OnClose / OnGhostChanging and its load talks `TalkCrashed` otherwise [corpus machi_1.0 dict-keeps.kis:734-738];
  after D6's close machimaki's next OnBoot is a normal boot talk instead of 'たまには、おちる、こともある！' [measured,
  site copy]. That is SSP after a Windows shutdown; after a killed SSP (no event at all) the crash talk stays, in SSP.
- The close runs at the time the tab was closed (above; at the next visit's time bthver.5, which stamps `CoEndday` /
  `CoEndtime` in OnClose [corpus core/core.txt:873-874] and counts the time away from them at boot, would see a visitor
  back after a tab close as away 0 minutes). How exact that time is: after a tab closed or left for
  another site it is the pagehide save; without a pagehide (a browser crash, a phone tab discarded while hidden) it is
  the last state write, the hidden-tab flush or a debounced save at most 2 s after the last change, which may come a
  little before the last snapshot (stored 1 s after requests): a little more time away, no worse. A cold boot whose
  page went after its own state write but before the engine's first report hands that boot's time to the next attempt;
  a write the browser refused (quota) leaves an earlier `savedAt` [infer].
- A tab closed during a Close or Quit goodbye (OnClose already answered and saved: the worker saves urgently after
  OnClose*) is closed a second time by D6 [decision]; ssp.exe's `ForceQuitApplication` returns at once while a Quit is
  under way. The saves of the BTH and KEEPS ghosts come out the same, with their stamps about the first close's time
  (the end time is that page's last state write); a counter the close increments counts twice.
- Lost on a resume, as with YAYA: the random generator's state, SAORI stand-in state, logger settings, open
  `textappend` streams. Time spent away counts (ghosts compute uptime from `date %s`).
- A failed restore warns 'the resume snapshot did not load: this page goes on from the ghost's own save'.
- **Entries that differ after a resume** (the sweep's check, §15): 0 snapshot entries came back different in 18 of 18
  ghosts. Entries `load` sets from the clock or the random generator would take the new load's value on every page
  without the load-made entries (K1): `cntwork` in the five KEEPS ghosts (Aria, firefox, kuro_r030114b, machi_1.0,
  umikoF: minutes from the clock); `Wearmode` in honue090104 (a random pick, 1 run of 4); Aria `GhostBirth` (P1's and
  P2's probes; not in the K1 walk); asri101 `satori.system.talkinterval.limit` (one P1 run). As load-made entries they
  come back with the cold boot's words (above; run K3 in §15).
- **Gap: write-protected entries** [measured, P4b]: brynhild_conf1.13, meganeoni040313 and wakaba001 run
  `preset.2 : $(Nonoverlap sentence)…` at boot. The helper copies `sentence` to `sentence.backup` and write-protects
  both, so the snapshot leaves them out; a resumed page has load's unprotected `sentence` and the no-repeat state is
  lost until the next cold boot. Proposed fix (K12, not done): write an entry that is protected now but was not at the
  baseline, with its words and a `# protect NAME` line, and protect it again after the restore; entries protected at
  the baseline stay out. The sweep's "missed" column should then show 0.

---

## 9. Boot failure

Kawari's `load` never fails: a missing `kawarirc.kis` gives an engine that answers 204 to everything [src
kawari_shiori.cpp:88-116; measured on haruka65]. The index never calls such a ghost `kawari` (§12), but when
`ghost/master/kawarirc.kis` (any case) is missing from MEMFS `init` warns 'no kawarirc.kis: nothing to load' and
returns false, the runtime's failed-boot path, as YAYA's shell mode [decision]. A throw inside `_load` → `init` false.
Dictionary parse errors do not fail a boot: the entries they hit are lost and the ghost talks on (§15).

**A site id code page 932 cannot write** [code]: K4 hands Kawari its folder in code page
932 (best fit) and K6 turns each path back into UTF-8, so an id with a character 932 lacks (`café` → `cafe`, `〜` →
`?`, `¥` → `\`) would make Kawari look in another folder and load nothing: a silent ghost, while the UTF-8 check for
kawarirc.kis still passes. So `init` first checks that the folder name comes back unchanged from the build's encoder
and the Encoding Standard's `shift_jis` decoder (`cp932Writable`; that decoder equals MultiByteToWideChar(932) for every
pair the encoder writes) and otherwise warns 'site id "café" is not writable in code page 932: Kawari would not find its
files' and returns false. ASCII and Japanese ids pass. The tools do not refuse such an id.

---

## 10. SAORI

K5 sends every SAORI to `Module.saoriBridge`, the interface of Satori's P2 and YAYA's Y6, in UTF-8 both ways.
`rootBridge` turns `/ssp/ghost/<id>/ghost/master/saori/x.dll` into `/ghost/master/saori/x.dll`, so
`src/worker/saori/` serves Kawari unchanged [code]. Kawari's own sharing is kept: two aliases of one DLL share one
stand-in, its `load` runs once and its `unload` once [measured, smoke]. A SAORI without a stand-in fails to attach
and every `callsaori` returns "", as a missing DLL on Windows; Kawari tries to attach again at each call [src
saori/saori.cpp:29-33], so the sweep lists a missing SAORI once per name.

Stand-ins exist for httpc, mciaudio, mciaudior, saori_cpuid, gomi, fill_desktop and others (`standins.js`).
Missing for the corpus' Kawari ghosts (K1, §15): `bln` (bloody_moon, toxic060816; registered or commented out in Aria
and the BTH family), `hanayu` (somberlain), `launcherhook`, `process`, `windowsmin`, `effect`, `scribble`
(brynhild_conf1.13), `lettuce` (umikoF), `mciaudior2` (meganeoni040313), `textcopy` (toxic060816). R1 found that
ssp.exe emulates `textcopy` itself (one of its 8 built-in names), so in SSP that call answers; here it does not, as
there is no stand-in for it (nor is Kawari run as a SAORI for the Satori ghost snow girl).
Neither site ghost calls a SAORI (bthver.5's `bln` line is commented out; machimaki registers none).

---

## 11. OS stand-ins and logs

| Function | Behaviour |
|---|---|
| `date`, `mktime` | the browser's local time (Emscripten's `localtime`) |
| `rand`, `${}` choices | MT19937, seeded with `time(NULL)` at load, as the DLL |
| `getenv` | nothing (K7) |
| `logfile`, `loglevel` | the JS sink (K8, K9); no file |
| `readdir` | MEMFS in NTFS order (the base writes in that order) |
| `callsaori*` | the stand-ins (§10) |
| `ShioriEcho` | as the DLL: with `debugger on` (BRH1.251, BTH4th_last; commented out in bthver.5) `GET … ID: ShioriEcho` runs `Reference0` as KIS. Sumika never sends it; another site ghost's `\![raiseother]` could, and it could write files in that ghost's own folder, as SSP allows over SSTP. No filter [decision]: every script on a site is the site admin's choice. |

**Logs.** `Module.kawariLog(line)` → `log('debug', 'kawari: <line>')` (the page console only with `?sumika-debug`) and
`onEngineLog({mode, text})` for the sweep and tests. `kawariLogMode`: the lexer's `: error: ` / `: warning: ` marker,
else `log` (a KIS command's error, such as `load : load failed x`) [infer: the K8 sink gives no level]. The default
level is error|warning, so dictionary parse errors show. One debug line after load: `kawari: module N ms, load N ms,
stamp N ms, heap N MB, N files N KB, N placeholders, N entries[, snapshot restored|finished|dropped]`. Sumika's own
warn lines only for what decides a boot (§9) and a failed restore (§8).

---

## 12. Detection, index and the personal-file guard

**The rule** (`index_site.py kawari_phase` = `views.mjs kawariPhase`; `KAWARI_STEMS`) [decision]:
after the AYA probe, when the lower-cased stem of descript's `shiori` (a missing line = `shiori`) is `shiori`,
`kawari`, `kawari8` or `kawarirc`:
1. `ghost/master/kawarirc.kis` (any case) → `kawari`;
2. else `ghost/master/kawari.ini`, or any `kawari*` stem → `kawari7` (nothing 8.2.8 could load);
3. else the stem stays (`shiori`).

No `module` field. snow girl (descript `satori.dll`, Kawari only as a SAORI) stays `satori`; asri101 (ships
`satori_conf.txt`) is `kawari`, so a future "`satori_conf.txt` → satori" rule must come after this one. The sweep's
`sweepEngine` returns `kawari` early, like `satori` and `yaya`. Measured on the corpus [P4a]: 18 → `kawari`, 8 →
`kawari7`, the other 292 roots unchanged; `index_site.py` = `views.mjs` on 318 of 318 roots and 24 edge cases; a
re-index of the site before the Kawari ghosts changed no byte.

**The page.** `SUPPORTED_ENGINES` = `['satori', 'yaya', 'kawari', 'kawari7']` (= `ENGINES`; Kawari 7:
kawari7-wasm.md); `ENGINE_LABELS` names them 'Kawari' and 'Kawari 7' for a "needs" note. The `kawarirc` and `kawari8`
labels stay for indexes written before the rule.

**The pack.** `write_pack(…, ext)` takes the engine's pattern: `ROOT_PACK_EXT` = `{yaya: YAYA_PACK_EXT, kawari:
KAWARI_PACK_EXT}`, and `kawari7: KAWARI7_PACK_EXT` (Kawari's set plus `.kdf` and `.dat`).

**The personal-file guard** (CLAUDE.md "Never ship personal data"). Kawari save names are the ghost's own, so no name
pattern finds them (BTH4th_last's `savefile1.txt` holds the user's name, sex and birthday [corpus]):
- The gate is the existing rule: `add_ghost.py <ghost> --archive <nar>` copies nothing while a file is not in
  the archive or differs from it; each file an SSP run wrote gets a `PERSONAL_PATHS` line.
- The content net [decision]: in a ghost whose engine is `kawari` or `kawari7`, `index_site.py`
  refuses a file that starts with Kawari's save header (`KAWARI_SAVE_HEAD`: `#`, `# Kawari saved file` or Phase 7.0's
  CP932 `# 華和梨セーブファイル`, `#`; LF or CRLF) [src libkawari/kawari_engine.cpp:313], unless `KAWARI_SHIPPED_SAVES`
  lists it with its archive's CRC-32 (an author's default). It lists mayura's `ghost/master/mayura.ini` (the author's
  encrypted game state, no user data) and `ghost/master/news.dat` (an empty save), as `mayura_v350.nar` ships them; the
  Phase 8 site ghosts ship none. The corpus
  ships 16 such files in 9 archives [measured, P4a]; of the Phase 8 ghosts only brynhild_conf1.13 (3) and wakaba001 (1)
  would need lines. `textsave` writes no header, so this is a net, not the gate.
- `add_ghost.py` refuses such a ghost before copying anything (stricter than a warning, so no save is ever left in
  `site/ghost`), and with `--archive` prints the exact `KAWARI_SHIPPED_SAVES` line for a file the archive holds as it
  is. It prints `install.txt`'s `refreshundeletemask` for every ghost (often the author's own list of save files) with
  the files to be copied that it names: bthver.5's names `4th.txt`, `savefile1.txt`, `savebackup.txt`, none shipped.
- The admin tool accepts only `.zip` and `.nar` files [decision]. A Kawari ghost added
  from its own `.nar` / `.zip` (the admin core's archive source; `add_ghost.py <extraction> --archive <it>
  --from-archive`) keeps such files as the author's starting files and records them with their CRC-32 in the site's
  `sumika/kawari-shipped.json`, which both index tools accept beside `KAWARI_SHIPPED_SAVES`; from a folder the ghost
  is refused as above. The eight corpus archives that ship such files (alto_beta2, brynhild_conf1.13, gleto,
  haruka65, nijino, sakura_r030103b, teruno109, wakaba001: 14 files) add so (CLAUDE.md "The admin tool").
- `tests/runtime/kawari_guard.test.mjs` runs both tools on a scratch site (Python, `python -I`): a save the real build
  wrote (`#\r\n# Kawari saved file\r\n#`, K11's CRLF), the same with LF and Phase 7's header are refused, nothing is
  copied, and a `textsave` file and a header in a Satori ghost pass [code].
- `--param-input-file` (`\![execute,http-post]`) never reads a personal file, and never a file the
  visitor's own run wrote (a stored key with bytes: a save of any name, a rewritten shipped file, a download), for
  every engine (`visitorFile`, `readForUpload`; EV §4.15) [decision]. No corpus ghost uses that
  option.

---

## 13. Tests

| Where | What |
|---|---|
| `node engines/kawari/smoke.mjs [DIR]` | 22 checks straight on the C exports of a build: the encoder (§3), `version` 8.2.8, the `Charset` rewrites, round trips, an invalid pair, K3, K10, K11, K6, K7, K8, K9, encrypted lines `!KAWA0000` / `!KAWA0001`, K5 through a fake bridge, K12 (changed, cleared, new and odd-named entries and what load made; protected and unchanged definitions left out; load-made entries carried unchanged and back on a later load, a `function` defined at load left out, one the session redefines carried; `all` = 1; a recycled word id), `OnUnload`'s save at `_unload` and a second `_load`, 40 runaway recursions with the stack restored, 20,000 requests leaving a malloc probe in place. All pass on -O2 (the site's) [measured]; the 21 of P1/P2 passed on -Oz (scratch) and the debug link too. |
| `tests/kawari_engine.test.mjs` (23) | `KawariEngine` on the real build with the fixture `tests/fixtures/ghost/kawaritest`: load (any case of kawarirc.kis; none → warn and false); a site id 932 cannot write (`café`) → warn and false; transport; code page 932 as ssp.exe; the SSP view in 932; SAORI root paths; persistence; the snapshot key's three states (load-made `System.Debugger` carried); resume; an entry load sets from the clock keeps the cold boot's value page after page; a defined entry load emptied stays empty; D6 (its close's steps and debug line); D6 with an OnClose-saving variant (the session kept); D6 at the session's end (a variant whose OnClose and OnUnload stamp `$(date %s)`: both stamp `sessionEndMs` three days back, the save's MEMFS mtime too, `d6At`, the debug line, the real clock back for the cold load and every later request; 0, NaN, now and the future keep the real clock; a resume ignores it); `runAt` (it runs on, comes back after a throw, leaves the clock for a start not before now); D6's close request by request (and a ghost whose OnCloseAll answers: no OnClose, what Kawari read); D6 with a runaway OnClose (500, no OnTranslate, the unload still saves); the scan only after a request that wrote; `scan()` = a walk by path; the stamp; logs, `logfile`, `getenv`; the stack restore; a 5,000-request heap probe. It keeps its own text plan regexes (P2's file). `tests/kawari7_engine.test.mjs` has D6 at the session's end through the SHIORI/2 bridge (`system.OnUnload` stamps `$(date %Y%m%d%H%M)`). |
| `tests/runtime/kawari_guard.test.mjs` (1) | the save-header net end to end on a scratch site, with Python (`python -I`; `PYTHON` names another): `index_site.py` refuses a save the real build wrote (CRLF), an LF one and Phase 7's header in a `kawari7` ghost; `add_ghost.py` refuses before copying; a `textsave` file and a header in a Satori ghost pass. It fails when the header pattern loses its CRLF handling [measured]. |
| `tests/runtime/kawari_helpers.test.mjs` (7) | the key's name, `stampSnapshot` / `snapshotStamp`, D6's close requests (`END_SESSION_REFS`, `endSessionRequest`, `BASE_HEADERS` = the page's, `D6_FINISHED`), `kawariLogMode`, `sspDescript` with a charset, `_stackGuard`, the YAYA move (yaya.js re-exports the same helpers). |
| `tests/runtime/kawari_integration.test.mjs` (3) | registration (`SUPPORTED_ENGINES` = `ENGINES`, "needs Kawari 7", the root plan); the page's own `Runtime._startEngine` for the fixture; an `EventLoop` run on the real wasm from those exact start options: first meeting, a menu choice, communicate in Japanese, a page change (no OnBoot, counters kept), Close (OnUnload's `save.txt`, CRLF, 932; the key becomes the marker), the next page's resume, a cold boot ('2回目'), a tab closed without Close then a cold boot (D6, '3回目'; its close stays in the worker, the page sends no OnClose). |
| `tests/runtime/engine_files.test.mjs`, `runtime.test.mjs`, `worker_save.test.mjs` | `rootFilePlan`, `ROOT_ENGINES`, the Kawari file plan, `siteView`, `visitorFile`; `KAWARI_PACK_EXT` = `KAWARI_TEXT` (`KAWARI7_PACK_EXT` = `KAWARI7_TEXT`) and every root-engine site ghost's pack (bthver.5, machimaki and mayura included); the Kawari engine start (`sessionEndMs` through `_startEngine`, `ShioriClient.start` and the worker's init: `shiori_client.test.mjs`); the `--param-input-file` read rule (§12). `multi.test.mjs` pins what `Runtime._boot` passes: 0 for a ghost never stored and on a resume, a cold boot in a new tab the state's `savedAt` as the closed tab's pagehide left it, not its own write. |
| `tests/runtime/sweep_views.test.mjs`, `sweep_kawari.test.mjs` (7) | the detection rule and every site ghost's `engine` against `ghosts.json`; the sweep's pure Kawari parts (file plan, log keys, literal joining, dump reading, the sort of differing entries, D6's outcome). |
| `tests/yaya_engine.test.mjs`, `tests/runtime/worker_save.test.mjs` | the base's scan only after a write (YAYA: FWRITE, FDEL, the save; none for a request that only read); the worker's `ms` holds the scan, which runs before the reply. |
| `tests/runtime/info.test.mjs` | About Sumika names the engines (all four), Kawari's licence and MT19937. |

**The fixture** `tests/fixtures/ghost/kawaritest` is a Phase 8 ghost written for the tests, in code page 932 with CRLF (made with the
build's encoder and checked to round-trip): OnBoot / OnFirstBoot count `boots`, a double-click menu, OnCommunicate,
counters saved by OnUnload to `save.txt` and loaded back by kawarirc.kis, NOTIFY installedghostname stored, a CRLF
`textload`, `readdir ../../..`, a `../../shell` read, half-width kana entries, a SAORI registered with no DLL shipped,
and `debugger on` so the tests evaluate KIS with `GET ShioriEcho`. No test skips: without the build they fail.

No real-DLL corpus exists: no DLL is run (running one, BTHver.5's own 8.1.0 or 8.2.8's `bin/shiori.dll`, would
also settle K3 and CRLF).

---

## 14. Sizes and timings

| Build | wasm | gzip -9 | brotli | js (brotli) |
|---|---|---|---|---|
| Kawari -O2, published (42 patches) | 535,900 | 205,569 | 159,266 | 67,892 (16,949) |
| Kawari -O2, R1's encoder (40 patches) | 532,695 | 204,468 | 158,676 | 67,892 (16,949) |
| Kawari -Oz (scratch, before R1) | 359,033 | — | 129,020 | — |
| prototype -O2, 36 patches | 522,958 | 202,448 | 157,494 | 67,139 |
| Satori -O2 (published), for comparison | 781,730 | — | — | 85,859 |
| YAYA -O2 (published) | 2,602,424 | 984,877 | 756,210 | 90,073 (22,552) |

Gate ≤ 600 KB: met. -O2 is kept [decision]: the -Oz page-load comparison YAYA made (yaya-wasm.md §13) needs the
browser and is not done; -Oz would save about 30 KB of brotli.

In Node 24 (K1 with `--jobs 1`, 18 corpus ghosts) [measured, P4b]: `load` 23–464 ms (Aria 464, every other ghost at
most 173); slowest request asri101 106 ms (OnMouseWheel: its Satori emulator in KIS), every other ghost at most 21 ms;
heap 32 MB (`INITIAL_MEMORY`, never grew); a snapshot at most 5 ms, the largest 45 KB (toxic060816; BTHver.5 63 KB in
one run); a resumed page's load at most 462 ms, a D6 cold boot at most 859 ms (both Aria). P1 measured baseline ≤ 8
ms, snapshot ≤ 19 ms, restore ≤ 9 ms on its probe.

K3 (`--jobs 1`, the 42-patch build with the load-made entries; a request's time holds the worker's
scan after it) [measured]: `load` 20–491 ms (Aria 491, every other ghost at most 182); slowest request asri101 107 ms
(OnMouseWheel), every other at most 29 ms (brynhild_conf1.13's NOTIFY otherghostname); heap 32 MB; a snapshot at most
6 ms, the largest 62 KB (asri101: the dictionaries its KIS emulator builds at load are load-made); a resumed page's
load at most 497 ms, a D6 cold boot at most 1,012 ms (both Aria).

K4 (`--jobs 1`, D6 with its end-of-session close, §8) [measured]: the close (OnCloseAll, OnClose,
OnTranslate) 1–11 ms (meganeoni040313 11, the site's bthver.5 10, machimaki 4); a D6 cold boot at most 1,094 ms (Aria;
its resume, which D6's close does not touch, 688 ms in the same run against K3's 497: the machine was slower); the
site's bthver.5 D6 741 ms (`ok`), machimaki 95 ms.

The scan after a request [measured, Node, `site/` ghosts]: by path (FS.readdir, FS.stat per file) bthver.5 15–17 ms
for its 1,507 files, emily4 4 ms for 291, machimaki 0.4–0.5 ms for 35; the node walk 1.0–1.2 ms, 0.4 ms, 0.03 ms. A
request that writes nothing (OnSecondChange, OnMouseMove) costs no scan at all:
`changedFiles()` 0.002–0.006 ms against the request's 0.1–1.3 ms.

The site copies (sweep of `site/ghost/bthver.5` and `site/ghost/machimaki`, one at a time; K3's build)
[measured]:

| ghost | entries | load ms | slowest ms | snapshot bytes | resume ms | D6 ms |
|---|---|---|---|---|---|---|
| bthver.5 | 4,924 | 180 | 13 | 4,280 | 312 | 460 (`no effect` in K3; `ok` with D6's close, K4: §8) |
| machimaki | 544 | 53 | 4 | 1,466 | 35 | 48 |

(The run before the load-made entries, two at a time: bthver.5 load 181, slowest 8, snapshot 61,632, resume 311, D6
423; machimaki 62, 6, 1,101, 39, 65. The snapshot sizes depend on how far the walk got.)

Not measured: the browser (the module fetch and compile, `engine kawari loaded in N ms`), and the memory of several
workers at once.

---

## 15. The sweep and the corpus

`node tools/sweep.mjs <archive folder> --engine kawari --out <scratch>` (or `all`, the default; about 1.5
minutes for the 18 Kawari ghosts). Kawari ghosts run in-process through `KawariEngine` (`NodeKawari`), with the fake
clock followed (`followClock`; the fixed clock of ghost-sweep.md "The clock"), the worker's save every 5 s of idle time, Kawari's log counted per phase and kind, and
the resume check: A = every entry after the run (`_kawari_snapshot(path, 1)`), then a fresh engine resumed from the
store, B = every entry again; each entry where B ≠ A is "back different" (in the snapshot), "missed" (the session
changed it, against a dump right after load, and the snapshot left it out) or "load-set". Then the stamp reload (a
changed dictionary loads cold) and D6 (a cold boot from the same store writes what the session's own end writes: B
closed from outside as ssp.exe closes a session Windows ends, `closeFromOutside()`, then unloaded;
that cold boot comes a day later with the session's end as `sessionEndMs`, so the files match only when
D6's close and unload ran at the session's end (§8), `d6At` in the report; the day starts at D6's restore, after the
boot's first load, whose clock seeds Kawari's random numbers: B's seed, so both closes draw alike), with its outcome (`d6Outcome` in `tools/sweep/kawari.mjs`): `ok`, `nothing to finish` (no snapshot), `failed`, or
`no effect` when the session's own close and unload write no file (a ghost that saves nothing when it closes, as in
SSP; in run K3, which had no D6 close, it meant "its unload writes nothing": the OnClose savers). The "D6 close" column: what D6's close got, and the wall time of B's close. A
request's time (`slowest`) holds the worker's scan after it. A runaway recursion (RangeError) is recorded as a 500, not
a crash; a ghost whose own script closes it mid-run gets a new engine. Reports quote ghost scripts: write them to
scratch only. Details and counts: `ghost-sweep.md` "Kawari run K1", "K3", "K4" and "K5".

**K1** (four runs over the 320 archives) [measured, P4b]: 18 Kawari ghosts ran and 8 `kawari7` were
skipped; 0 engine crashes, 0 runner failures; `version`, OnFirstBoot, OnBoot and OnClose 200 for all 18; one SHIORI
500 (kuro_r030114b's menu item `Comm` calls an entry that calls itself without end; the engine answers on); resume 18
of 18 with 0 entries back different, 3 missed (§8 gap), the stamp reload 18 of 18, D6 18 of 18 (norn had nothing to
finish; reported ok, but 7 of the 17 that "finished" wrote nothing at their unload: the K3 outcome below). Left:
kuro's 500 (the ghost's own), asri101's 106 ms, the 3 missed entries.

**K3** (the 42-patch build with the load-made entries, the `no effect` outcome and the scan in the request time;
one run 6 at a time, one with `--jobs 1`) [measured]: 18 of 18 ran; resume 18 of 18 with 0 entries back different;
**load-set 0 for all 18 in one run and 17 of 18 in the other** (K1: `cntwork` in the five KEEPS ghosts and honue090104's
`Wearmode`; carried as load-made entries); firefox showed 2 in the `--jobs 1` run (`closemode`, `freeze`: definitions
read from its own `dict-keeps-savedata.txt`, which the walk's mid-run Close rewrote, the gap §8 names); missed 3
(`sentence`, §8) and in one run a fourth of the same kind (BTH4th_last's `普通の食べ物`, a `Nonoverlap` target its menu reached); the stamp reload 18
of 18; D6 `ok` 10, `nothing to finish` 1 (norn_04.00), **`no effect` 7** (BRH1.251, BTH4th_last, BTHver.5_2.732,
honue090104, rotten101010, somberlain, toxic060816). Timings in §14.

**K4** (D6 with ssp.exe's end-of-session close; one run 6 at a time, one with `--jobs 1`, each
with the site's bthver.5 and machimaki as sources; Kawari 7 below in kawari7-wasm.md §7) [measured]: 20 of 20 ran;
every D6 close got OnCloseAll 204, OnClose 200, then OnTranslate 204 (200 for brynhild_conf1.13, BTHver.5_2.732,
meganeoni040313, toxic060816, wakaba001 and bthver.5, which answer OnTranslate); **D6 `ok` 16** of the 18 archives
(K3's 10, and 6 of its 7 `no effect`: BRH1.251, BTH4th_last, BTHver.5_2.732, honue090104, rotten101010, toxic060816),
`nothing to finish` 1 (norn_04.00), **`no effect` 1** (somberlain: it saves nothing when it closes); the site's
bthver.5 and machimaki `ok`; brynhild_conf1.13 also writes `dict-cr.txt` at D6. The close
took 1–11 ms (`--jobs 1`; meganeoni040313 11, bthver.5 10); D6 at most 1,094 ms (Aria; K3 1,012, and Aria's resume,
which D6's close does not touch, went from 497 to 688 ms in the same run: machine noise). Resume, missed (the 3
`sentence` entries, and BTH4th_last's `普通の食べ物` in the run 6 at a time), load-set 0, the stamp reload 20 of 20, the
SAORI tally and the unsupported tags as in K3.

**K5** (D6 at the session's end, §8; the D6 check's cold boot a day later; the fixed clock; one run 6 at a
time with the site's bthver.5 and machimaki, and `--engine kawari7` with the site's mayura) [measured]: 20 of 20 and 9
of 9 ran; **D6 as in K4**: `ok` 16 of the 18 archives, `nothing to finish` 1 (norn_04.00), `no effect` 1 (somberlain),
the site's two `ok`; Kawari 7 `ok` 7, `no effect` 2 (maria_re, sakura_r030103b); every `d6At` the session's end, the
files equal B's own close and unload for every ghost (`differ` empty). The same runs with the end time dropped (a
scratch preload that passes `sessionEndMs: 0`, the clock the only difference): **13 `failed`**, 11 archives (Aria,
BRH1.251, BTH4th_last, BTHver.5_2.732, bloody_moon, brynhild_conf1.13, firefox, kuro_r030114b, machi_1.0, toxic060816,
umikoF) and the site's bthver.5 and machimaki, each saving something of the time at its close or unload; Kawari 7 none.
A check that starts the day before the boot's first load fails brynhild_conf1.13 alone: its goodbye saves a reward
with a random part (`number3`) in `dict-cr.txt`, and that load's seed comes a day later than B's.
Resume, missed (the 3 `sentence` entries), load-set 0 and the stamp reload as in K4.

| Ghost | own DLL | parse errors per load | files written | SAORIs without a stand-in |
|---|---|---|---|---|
| Aria | 8.2.2 | 64 | dict-savedata.txt | — |
| BRH1.251 | 8.2.4 | 0 | savefile1.txt | — |
| BTH4th_last | 8.1.0 | 0 | savefile1.txt | — |
| BTHver.5_2.732 | 8.1.0 | 0 | savebackup.txt, savefile1.txt | — |
| asri101 | 8.1.0 | 2 | satori_savedata.txt | — |
| bloody_moon | 8.2.4 | 1 | dict-keeps-savedata.txt | bln |
| brynhild_conf1.13 | 8.0.0 | 60 | dict-learnsaved.txt, dict-save.txt, dict-cr.txt | launcherhook, process, windowsmin (effect, scribble) |
| firefox | 8.2.2 | 0 | dict-keeps-savedata.txt | — |
| honue090104 | 8.2.8 | 0 | savefile.txt | — |
| kuro_r030114b | 8.0.0 | 593 | dict-keeps-savedata.txt | — |
| machi_1.0 | 8.0.0 | 17 | dict-keeps-savedata.txt | — |
| meganeoni040313 | 8.1.0 | 154 | dict-save.txt, dict-save2.txt, dict-transient2.txt, dict-learnsaved.txt | mciaudior2 |
| norn_04.00 | 8.0.0 | 17 | — | — |
| rotten101010 | 8.2.8 | 0 | savefile.txt | — |
| somberlain | 8.1.0 | 12 | — | hanayu |
| toxic060816 | 8.2.0 | 0 | brain/memories2.txt | bln, textcopy |
| umikoF | 8.0.0 | 16 | memory/savedata.txt | lettuce |
| wakaba001 | 8.0.0 | 142 | dict-save.txt, dict-save2.txt, dict-transient2.txt, dict-learnsaved.txt | — |

The parse errors come from 8.0-era syntax 8.2.8 rejects (`$([ … ])` / `test`, `if A B C` without `else`, `-` in entry
names) and from the authors' own slips [measured, research]; the entries are lost and the ghosts still talk (accepted, §1).
Double-click: 200 in 13 or 14 ghosts; honue090104, rotten101010, umikoF (and bloody_moon in 2 of 4 runs) answer 200
for some and 204 for others; machi_1.0 answers 204 while its first-boot name question waits (the walk answers it
late). Noise between the four runs: the SAORI tally moved once, warnings by up to 5 keys, the snapshot's entry count by
a few entries.

The Satori (247) and YAYA (26) sweeps before and after the Kawari changes stayed within their noise (ghost-sweep.md
"Satori and YAYA after the Kawari sweep"); moving YAYA into `SspRootShiori` changed 0 fields over 26 YAYA ghosts
[measured, P2].

---

## 16. Site ghosts, checks in ssp.exe and decisions to revisit

**Site ghosts** (CLAUDE.md "The ghosts Sumika was tested with"): `bthver.5` (BTHver.5_2.732, install folder `BTHver.5`)
and `machimaki` (machi_1.0, install folder `machimaki`), ids = the install folders lower-cased, as the other site ghosts
[decision]. Each was extracted from its archive into a new empty scratch folder and added with `add_ghost.py <folder>
--id <id> --archive <nar>` (every file listed with the same contents; `shiori.dll` left out; bthver.5 1,507 files,
machimaki 35), then indexed: both `engine: 'kawari'`, packs of 63 and 14 text files; every existing manifest and pack
stayed byte-identical. bthver.5 brings its balloon `convulsions` (痙攣-ケイレン-), in every ghost's Balloon ▸. For
comparison both are installed in an SSP install from the same archives, unchanged: `ghost/BTHver.5`
with its balloon moved to `balloon/convulsions` as its `install.txt` says (`balloon.directory,convulsions`), and
`ghost/machimaki`.

**Browser check** (Katari + bthver.5 on a test site): bthver.5 called from Katari boots on
Kawari: its first boot asks the screen size, changes to its `5th-smart` shell (OnShellChanged), uses its balloon and
shows three characters (`\0`, `\1`, `\p[2]`). Katari's greetings and skirt lines reach it as OnCommunicate (R0 `カタリ`).
During its first boot it answers 204: its `event.OnCommunicate` looks up `Comm.${Mode}.カタリ.…` and `Mode` is `First`
until the first boot is over [corpus `comm/comm_core.txt:63–75`, `blood/blood_01.txt:34`]. With `Mode` `Tea1` (set
through its own menu entry `MODEtea1`) it answers with its `comm/comm_ghost03.txt` lines (the Unknown line, and a
keyword match on the next page). A page change resumed it without OnBoot and kept `Mode`. Not checked yet: Close then
a cold boot, machimaki. Seen on the way: `blood/blood_01.txt:83` has a stray `\` before `わたくしの`; ssp.exe drops
that `\` as an unknown tag, and so does Sumika (sakurascript.md §3.2 [disasm]).

**Checks in ssp.exe** (both are installed in SSP as `BTHver.5` and `machimaki`); findings go here as `[observed]`:
1. Boot talk and double-click side by side.
2. `～－①＼` and other Japanese in menus: no `?` or `・` where SSP shows the character.
3. Katari's greeting to BTHver.5 and its answer (Katari sends the lines BTHver.5 answers [corpus]).
4. A value changed from a menu kept after a page change.
5. What machi says after SSP was killed (KEEPS's crash talk, which Sumika does not say after a closed tab; §8 D6
   note), and whether Close then a new start shows the same in SSP as in Sumika.

**Decisions to revisit** [decision]:
- D6: finish a session that ended without Close at the next cold boot, with (c), a silent close. An unload alone keeps
  only what OnUnload saves, and 7 of the 17 Phase 8 corpus ghosts D6 runs on (bthver.5 among them) save in OnClose, so
  for them a tab closed without Close would lose the session. The options: (a) the unload alone; (b) when D6's unload
  writes no file, restore the snapshot into the cold boot too; (c) a silent OnClose before OnUnload. (c) is done as
  ssp.exe closes ghosts when Windows ends the session (§8, shiori-events.md §2.3.1): OnCloseAll / OnClose with R0
  `system`, OnTranslate, every reply dropped, then OnUnload. Links between pages are resumes, so D6 never runs there and visitors
  moving between pages see nothing of it. The close and unload run at the time the session ended (§8 "At the session's
  end"); left: the double close (§8 notes).
- The snapshot carries the load-made entries (§8): every entry load left otherwise than its definitions, changed or
  not; a function body defined at load counts as a definition.
- D1: Phase 7 ghosts run on their own Kawari 7.5.0 build (kawari7-wasm.md), not on 8.2.8.
- 8.0-era syntax losses are accepted (kuro 593 parse errors per load).
- The save-header content net in the index (§12).
- `--param-input-file` refuses every file the visitor's run wrote, for every engine.
- D14: other ghosts' saves stay invisible.
- The `EMSDK_PYTHON` line in all three build scripts.
- R1's one encoder for every UTF-8 → 932 edge, the descript writer included.
- The snapshot's `# dicStamp` first line; the empty marker after the first save that finds nothing to carry.
- K10 (a CR at the very end of a file stays), K11 (CRLF writes), K9 (no log file ever), `System.DataPath` POSIX-shaped.
- No recursion or loop limit in the engine (D8), as the DLL has none. An endless `while` in a request does not hang
  the ghost for good [code: `src/core/shiori.js` KILL_MS, `Runtime._onCrash`]: after 30 s ShioriClient kills the worker and the runtime restarts the engine as a resume, from the last stored
  snapshot (`KawariEngine.init` restores it); the same request may loop again, and after more than 3 such restarts
  within 10 minutes (`MAX_CRASHES`) the runtime stops trying until the next page. The page stays responsive throughout;
  SSP would hang with the DLL.
- `ShioriEcho` unfiltered (§11).
- -O2 against -Oz (§14).
- The sweep-only choices (ghost-sweep.md): runaway recursions are 500s, not crashes; a new engine after a mid-run
  close; saves every 5 s while idle.

**Not done**: running a Kawari DLL through `tools/dll_harness.ps1` on a scratch copy (and which one); rebuilding
Satori and YAYA with the stack fix, re-running their DLL comparisons and sweeps; SAORI stand-ins for bln, hanayu,
lettuce; Kawari as a SAORI for snow girl.

---

## 17. Known gaps

- **Write-protected entries are left out of the snapshot** (§8): `sentence` in brynhild_conf1.13, meganeoni040313,
  wakaba001 loses its no-repeat state on a page change. Fix proposed in K12, not done.
- **Browser check partial** (§16): bthver.5's boot, communicate with Katari and a page change are checked; Close then
  a cold boot, a tab closed then a cold boot (D6's close: the debug lines 'kawari: closed from outside: …' and 'kawari:
  closed at the session's end, N min before this boot' with `?sumika-debug`), and machimaki are not checked.
- asri101's OnMouseWheel takes 106 ms in Node (its Satori emulator written in KIS); not on the site.
- kuro_r030114b's `Comm` recurses without end and answers 500 (the ghost's own; the engine lives).
- 8.0-era syntax costs entries (§15).
- SAORIs without a stand-in (§10), `textcopy` among them although SSP emulates it.
- Other ghosts' save files are invisible (D14).
- D6's close and unload run at the time the session ended (§8 "At the session's end"), and that time is the ghost
  state's last write, so
  without a pagehide (a browser crash, a phone tab discarded while hidden) it is the write before (the hidden-tab
  flush, or a save at most 2 s after the state's last change), a little early; a cold boot whose page went before the
  engine's first report hands its own time to the next attempt; with no stored state (or one from before `savedAt`)
  the close runs at the visit's time [infer].
- **A tab closed during a Close or Quit goodbye is closed twice** (§8 notes) [decision]: D6 sends the close again;
  ssp.exe's `ForceQuitApplication` would not. Saves come out the same (stamps at about the first close's time); a
  counter the close increments counts twice. A possible fix: mark the snapshot when a Quit's close was asked.
- D6's close drops every reply (§8): commands in a goodbye (`\![open,browser]`, `\![set,…]`, `\![raise]` …) never run,
  and a ghost that answers neither OnCloseAll nor OnClose gets no `#terminate` script (none of the corpus does).
- Not carried by the snapshot: an entry a load reads as a definition from a file the session rewrote, or from a
  dictionary a load script picks by date or chance (§8) [measured once: firefox, K3].
- An endless loop in a request costs 30 s, then a restart from the last snapshot, at most 3 times in 10 minutes (§16,
  D8) [code]. Not inside `init`: load, D6's close (OnCloseAll / OnClose / OnTranslate) and unload run
  there, and the page arms no kill timer for the start, so an endless loop (not a recursion) in one of those scripts
  would hang that cold boot, and every later one, since the snapshot stays [code; no corpus ghost loops: D6's close took
  at most 11 ms].
- A site id must be writable in code page 932: K4 hands Kawari its load path in 932, so an id with a character 932
  lacks would not find its own files (ASCII and Japanese ids are fine). `init` refuses such an id with a warn line
  (§9); `add_ghost.py` and `index_site.py` do not check it.
- SSP's first two requests reach Kawari as UTF-8 (pure ASCII) and only later ones as Shift_JIS; here every request
  reaches it as Shift_JIS, so `System.Request.Charset` reads `Shift_JIS` during `GET version` too [infer: no corpus
  ghost reads it there].
- Lost on a resume: random state, SAORI stand-in state, logger settings, open `textappend` streams (§8).
- `--debug` builds are refused by the builder-path check until the emsdk cache's debug libraries are rebuilt (§2); the
  same holds for YAYA's and Satori's.
- The Satori and YAYA builds lack the stack fix (§4).
- No real-DLL corpus (§13).

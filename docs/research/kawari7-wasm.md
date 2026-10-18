# Kawari 7 → WebAssembly: build, SHIORI/2 bridge and integration

Status: done. Scope: compile `vendor/kawari-7.5.0` (KAWARI 華和梨
Phase 7.5.0 "kdt", the last Phase 7 release) with Emscripten into `kawari7.js` + `kawari7.wasm`; the patches C1–C9;
the SHIORI/2.x bridge the worker speaks to it as ssp.exe does; the resume snapshot; detection, the index, the sweep.
Shaped like `kawari-wasm.md` (Phase 8.2.8), which it follows wherever the two are alike. The 8 Phase 7 ghosts of the
corpus all load and run (§7).

Tags as in kawari-wasm.md: **[src file:line]** = `vendor/kawari-7.5.0/src/…`; **[disasm]** = ssp.exe 2.9.10.3000 with
its `ssp.map`; **[corpus]** = a corpus of downloaded archives; **[measured]**; **[infer]**; **[decision]**.

Files: `engines/kawari7/build.py` (build), `patches.py` (§5), `em_kawari7.cpp` / `em_kawari7.h` (Sumika's glue),
`smoke.mjs` (smoke test); `src/worker/engines/kawari7.js` (`Kawari7Engine`, on `KawariEngine`),
`src/worker/engines/shiori2.js` (the bridge, §6); tests `tests/shiori2.test.mjs`, `tests/kawari7_engine.test.mjs`,
`tests/runtime/kawari7_integration.test.mjs` on a Phase 7 fixture written for the tests, `tests/fixtures/ghost/kawari7test`.

Not in the repository: the site's mayura (CLAUDE.md "The ghosts Sumika was tested with"), the corpus of downloaded
archives and the emsdk copy in `toolchain/emsdk` (docs/building.md "What the builds need"). These are development
material, cited as the sources (CLAUDE.md "Project rules").

---

## 1. Inputs

| Item | Value |
|---|---|
| Source | `vendor/kawari-7.5.0` = `kawari-750-kdt.zip` (2003-02-17), downloaded from SourceForge (sha256 `7a5632d5…e382c2`), unpacked unchanged without `shiori.dll`, `kosui.exe`, `kawari_encode.exe` (never run) (`SOURCE.txt`). `readme.1st` lists the patches from Phase 7.0 (kawari-2001-0825) to 7.5.0. |
| Pin | `build.py` `TREE_PIN` = `4e501a2f…54578018d3` over 143 files (the method of kawari-wasm.md §1). |
| Licence | Modified BSD (`license.txt`, "Copyright (C) 2001-2003 KAWARI Development Team"), MT19937's BSD notice in `misc/mt19937ar.cpp`. `kawari7.LICENSES.txt` carries both, then what Emscripten compiles in (`engines/common/notices.py` `emscripten`, as every engine's notices). |
| Source encoding | Shift_JIS (CP932), and **string literals hold Shift_JIS text** (messages, i18n tables), unlike 8.2.8 whose non-ASCII is all in comments. The authors' own Linux build ran every file through `sjis2ascii.rb`, which writes each Shift_JIS character as two octal escapes; `build.py` does the same (and escapes every other byte 0x80–0xFF), so the literals keep their bytes and a 0x5C trail byte never ends a comment line with a backslash. |
| Flags | `-DI18N_HACK` as `mingw_kawari.mak`: the shipped DLL calls itself `KAWARI.kdt.i18n` (read in its bytes, UPX-packed, not run) [measured]; the default locale `ja_JP.SJIS` [src misc/i18n.cpp:400] answers `Charset: Shift_JIS`. |
| Emscripten | emsdk 6.0.11 in `toolchain/emsdk`, as the Kawari 8 build. |

**The corpus' Phase 7 ghosts** (kawari-wasm.md §1): mayura_v350 (kdt.i18n 7.5.0), haruka65 (kdt 7.4.0), maria_re,
nijino, teruno109, sakura_r030103b (kpcg 7.3.1), alto_beta2 (kpcg 7.0.1), gleto (7.0.0). §7 has what they use; all run
on the one 7.5.0 build [decision] (§9).

---

## 2. Build

`python engines/kawari7/build.py [--opt O2|Oz] [--debug] [--out DIR] [--allow-vendor-drift] [-j N]`, the steps of
kawari-wasm.md §2 with these differences: the escaped copy (§1); 32 units = `files.mak`'s KAWASRC (the 13 KIS units
and the two crypt units with it) + SHIOSRC + `shiori_so/shiori.cpp` (the POSIX exports) + `em_kawari7.cpp`; never
compiled: `tool/`, `saori/saori_win32.cpp` (C3 replaces it), `shiori_dll/`, `misc/_dirent.cpp` (MSVC only); flags
`-O2 -std=c++11 -fwasm-exceptions -DNDEBUG -DI18N_HACK -Wall -Wno-unknown-pragmas -Wno-overloaded-virtual
-Wno-writable-strings -Wno-deprecated -Wno-deprecated-declarations`; link as Kawari 8 (`-sEXPORT_NAME=createKawari7`,
`-Wl,--stack-first`, `stackSave` / `stackRestore` exported). The remaining warnings are upstream's (non-virtual
destructors of the KIS functions and the engine, member order in `TKawariLexer`'s initialisers) [measured].

Outputs in `site/sumika/engines`: `kawari7.js` (65,756 bytes), `kawari7.wasm` (418,597 bytes), `kawari7.build-info.json`
(`{kawari: '7.5.0', treePin, zipSha256, drift, emcc, patches, opt, debug}`), `kawari7.LICENSES.txt`. A clean rebuild
(the build folder removed) gives the same bytes [measured].

---

## 3. Charset

Kawari 7 never converts: its dictionaries, file names and SHIORI messages are code page 932 bytes, and every reply says
`Charset: Shift_JIS` [src libkawari/kawari.cpp:345]. The build's C side passes the request and reply bytes unchanged
(C8); the worker's adapter encodes each request in the charset the handshake reply named (§6): for Shift_JIS with the
build's encoder (`_kawari7_utf8_to_cp932`: `WideCharToMultiByte(932, 0)`, best fit, the table and encoder of the Kawari
8 build) and decodes the reply with `_kawari7_cp932_to_utf8` (`MultiByteToWideChar(932, 0)`; an invalid pair is one
U+30FB), as ssp.exe does for a SHIORI that answers in Shift_JIS (kawari-wasm.md §3). The handshake itself is ASCII.
`load` gets the folder in code page 932 (C8); each file call converts the path back to UTF-8 for MEMFS (C4, C5); SAORI
requests convert at C3.

---

## 4. ABI

| Export | Semantics |
|---|---|
| `load(dir, len)`, `request(req, &len)`, `unload()` | the other engines' POSIX ABI (C8): `load` frees the path (UTF-8, converted to code page 932); `request` frees the request and returns a malloc'd reply of `*len` bytes plus a NUL; bytes unchanged both ways. `unload` runs `system.OnUnload`; a second one answers 0 and a request after it the build's own `500` (C9). |
| `kawari7_snapshot(path)` | write the entries that differ from the load's baseline to `path` (MEMFS): their size, 0 = nothing, -1 = no engine or unwritable (§8). |
| `kawari7_restore(path)` | load a snapshot into the running engine (after its load): 1, or 0 without an engine or a readable snapshot. Leading `#` lines (the adapter's `# dicStamp`) are skipped. |
| `kawari7_entries()` | the number of entries after the last load's `system.OnLoad` (the adapter's debug line). |
| `kawari7_dump(path)` | every entry with its words in the snapshot's format (write-protected and left-out ones skipped): the sweep's resume check compares two engines by it (§7). |
| `kawari7_utf8_to_cp932(s, len, &outlen)`, `kawari7_cp932_to_utf8(s, len, &outlen)` | the build's converters; a malloc'd buffer plus a NUL that the caller frees. |
| `malloc`, `free` | buffers. |

Module hooks: `saoriBridge` (C3, the Kawari 8 contract), `kawariLog(line)` (C6: `debug: log` in kawari.ini).

---

## 5. Patches (`engines/kawari7/patches.py`)

33 entries (build-info `patches: 33`), each an exact-once replacement on the escaped copy; every behaviour change is
under `__EMSCRIPTEN__` except C2.

| Id | Entries | File | Change |
|---|---|---|---|
| C1 | 1 | config.h | includes `em_kawari7.h` (every unit includes config.h first). |
| C2 | 10 | misc/mmap.h, libkawari/wordcollection.h, misc/i18n.cpp, libkawari/kawari.cpp, shiori/shiori_interface.cpp | to compile: `typename` and `this->` for dependent names, `std::pair`, spaces in `"SHIORI/" SHIORIVER` (C++11 user-defined literals), `::tolower` for `transform`. No behaviour change. |
| C3 | 1 | saori/saori.h (+ glue) | `TSaoriBinding` = the glue's `TSaoriBindingEm`, `TSaoriBindingW32`'s interface over `Module.saoriBridge`: one bridge handle per DLL path (any case on single bytes), its load at the first `Bind` and its unload when the last binding goes (`LoadLibrary`'s count); requests 932 → UTF-8, replies back to 932 saying `Shift_JIS`. |
| C4 | 6 | libkawari/kawari.cpp, libkawari/kawari_engine.cpp (+ glue) | kawari.ini, the dictionaries (`dict`, `load`, `include`), `text` / `textload` read through `EmTextIfstream` and `save` / `savecrypt` write through `EmTextOfstream`: msvcrt's text mode (CRLF read as LF, a Ctrl+Z ends the file; `\n` written as CRLF), the code page 932 path converted to UTF-8 with `\` as `/` (after the conversion, so a 0x5C trail byte is never a separator). |
| C5 | 2 | kis/kis_file.cpp | `readdir`: the path for MEMFS, the names back in code page 932. |
| C6 | 3 | libkawari/kawari.h, libkawari/kawari.cpp | `debug: log` sends Kawari's log to `Module.kawariLog` instead of opening `kawari.log` (no file is ever made). |
| C7 | 4 | libkawari/kawari.cpp, kawari_dict.h, kawari_engine.h (+ glue) | the snapshot's hooks: the engine `TNS_KawariANI` made, the baseline before `system.OnLoad` and the entries after it, read-only accessors to the dictionary's entries and the write-protected set (§8). |
| C8 | 4 | shiori_so/shiori.cpp, shiori_so/shiori.h | the exports in the other engines' ABI (§4). |
| C9 | 1 | shiori/shiori_interface.cpp | one unload: `Shiori_Unload` deletes the interface and left the pointer, so a second unload or a request after it used freed memory (the sweep met it: the ghost's own `\-`, then its close step). The pointer is cleared; ssp.exe never calls either. |

Not patched [decision]: `SRandom(time(NULL))` at load; the append-only word collection (every distinct word stays for
the session, as in the DLL); `EncodeEntryName`'s `isalnum` on a signed char (event and resource names are ASCII);
`$(load)` adding words to an entry rather than replacing them (a dictionary default plus a saved value is two words,
as in the DLL); the request quirks of §6.4.

---

## 6. The SHIORI/2 bridge

The page speaks SHIORI/3.0 to every engine. ssp.exe speaks SHIORI/2.x to a SHIORI that answers its handshake below
3.0, with other request lines, other headers and its own reading of the reply; the bridge makes the worker send what
ssp.exe would send and hand the page what ssp.exe would read. Source: a study of ssp.exe 2.9.10's `SPShiori`
[disasm `GetVersionRequestImpl` 0x7130a0, `SendEvent` 0x710aa0 (2.x branch 0x710cde), `GetSentence` 0x70d090,
`CommunicateSSTP` 0x70c130, `Teach` 0x711290, `Translate` 0x7135f0, `GetStringShiori` 0x712ba0, `NotifyEnvironment`
0x70ded0, `NotifyOtherGhost` 0x710140, `Request` 0x712290, `SendCommunicate` 0x711770, `GetWord` 0x70cbb0]. Nothing of
it was observed in a running ssp.exe.

### 6.1 Plumbing

`ShioriClient.request(r)` (src/core/shiori.js) posts `r.kind` and `r.self` beside the request text when given; the
worker hands them to `engine.request(text, {kind, self})`; only `Kawari7Engine` reads them. The page tags the calls
ssp.exe makes otherwise than as an event (src/core/events.js): `resource` (every GetStringShiori read, sent by
`_getString`: `resource()` and so `resources()` and `%username`, `balloon_tooltip`, `tooltip`, `property.get` /
`property.set` for `….ext.`; the tooltips and `.ext.` are no events: EV
§5.5), `translate`
(both OnTranslate paths), `teach` (OnTeach), `word` (a `%ms`-style word: `word()`, properties.md §2.4),
`communicate-user` (the communicate box's OnCommunicate), `communicate` (another ghost's COMMUNICATE, with `self` =
this ghost's scope-0 name in effect, the `To`). Everything else is an event.

### 6.2 Handshake

After `load`, `GET Version SHIORI/2.6` / `Charset: UTF-8` / `Sender: SSP` in ASCII (no SecurityLevel). The reply's
status line gives the version (`atof×10+0.5`: Kawari 7.5.0 answers `SHIORI/2.6 200 OK` → 26), a 2xx its `ID`
(`KAWARI.kdt.i18n`) and `Craftman`, its `Charset` (`Shift_JIS`) the charset of every later request. Only a 4xx or a
version of 3.0 or more would bring the 3.0 probe (`GET SHIORI/3.0`, `ID: version`). `Kawari7Engine._load` does it
after every load (also D6's second load), `Shiori2Session` keeps the result.

### 6.3 Requests (src/worker/engines/shiori2.js `toShiori2`)

`<cs>` = the session's charset; `<sender>` = the page's `Sender` (`SSP`); `<level>` = the page's `SecurityLevel`.
Every line ends CRLF and every request with an empty line; the header order is ssp.exe's.

| Page call | 2.x request |
|---|---|
| any event, GET or NOTIFY | `GET Sentence SHIORI/2.2`, `Charset`, `SecurityLevel`, `Sender`, `Event: <ID>`, `BaseEvent: <BaseID>` (when the page sent one), `Status` (when it did), `Reference0…n-1` (every index; an absent one empty). The 2.x form has no NOTIFY: ssp.exe sends it as GET and drops the reply. |
| `installedsakuraname` / `installedkeroname` / `installedghostname` | as an event, the References cut to the first 8 [disasm 0x70f5d1]. |
| `basewareversion`, `capability`, `enable_log`, `enable_debug` | none (the page gets 204) [disasm 0x70e144, 0x70e24f, 0x713464, 0x713524]. |
| `ownerghostname` | `NOTIFY OwnerGhostName SHIORI/2.3`, `Charset`, `Sender`, `Ghost: <R0>` [disasm 0x70df8f]. |
| `otherghostname` | `NOTIFY OtherGhostName SHIORI/2.3`, `Charset`, `Sender`, per ghost `GhostEx: name\x01s0\x01s1` then `Ghost: name` [disasm 0x71046e–0x71061d]. |
| `resource` | `GET String SHIORI/2.5`, `Charset`, `SecurityLevel`, `SecurityOrigin: null`, `Sender`, `ID`, `Status` (when the page sent one), `Reference0…n-1` (every index; an absent one empty); no SenderType [disasm GetStringShiori 0x712c2e–0x712f1f, EV §5.5]. The tooltips and `.ext.` reads too: `balloon_tooltip` with the hover event's References, `tooltip` [x, y, 0, scope, collision, 0], `property.get` [key], `property.set` [key, value]. |
| `translate` | `TRANSLATE Sentence SHIORI/2.6`, `Charset`, `SecurityLevel` (`external` when R1 says `remote`), `SecurityOrigin: null`, `Sender`, `Status`, `Sentence: <R0>`; none below version 26 [disasm 0x713611]. |
| `teach` | `TEACH SHIORI/2.4`, `Charset`, `SecurityLevel: local`, `Sender`, `Word: <R0>`, the rest as `Reference0…`. |
| `word` | `GET Word SHIORI/2.0`, `Charset`, `Sender`, `Type: <ID>` (`\ms`, `\m?`, `\dms` …, backslash included), nothing else: no SecurityLevel, no Status [disasm `GetWord` 0x70cdcc–0x70cefe]. Every 2.x version. |
| `communicate-user` | `GET Sentence SHIORI/2.0`, `Charset`, `SecurityLevel: local`, `Sender: User`, `Sentence: <R1>`, R2… as `Reference0…`. |
| `communicate` | `GET Sentence SHIORI/2.3`, `Charset`, `SecurityLevel`, `Sender: <R0>`, `Sentence: <R1>`, `To: <self>`, `Age` (always, default 0), `Marker` and `Surface` when given, R2… as `Reference0…` (absent ones skipped, the index kept). |

The 3.0 request's `SenderType`, `SecurityOrigin` (events), `ID`, `BaseID` lines do not appear in the 2.x forms.

### 6.4 Replies (`fromShiori2`)

The worker decodes the reply (§3) and hands the page a reply whose status line keeps the 2.x protocol
(`SHIORI/2.6 200 OK`), `Charset: UTF-8`, the reply's own headers (`To`, `Age`, `Reference*`, `Sender`, `BalloonOffset`
…) and `Value` = the script as ssp.exe reads it, only for 200, 311 and 312: `Value`, else `Sentence` (events, both
communicates, teach, translate); `Value`, else `String`, else `Sentence` (resources); `Value`, else `Word` (words
[disasm 0x70cfda–0x70cff5]). No reply: 500. ssp.exe's other
reply handling is the 3.0 one (`ParseGenericHeaders`), which the page already does. The page reads a resource's
`Value` for 200, 311 and 312 as GetStringShiori does (`resourceOf`, EV §5.5), so a 311 / 312 string is not
dropped.

`parseResponse` reads the status line's protocol (`res.protocol`, 3 by default). For a 2.x reply ssp.exe takes the
COMMUNICATE target from `To` only, never from Reference0, and passes every Reference on unshifted [disasm
0x711878–0x7118c3, 0x711db2–0x711f02]: `communicateOf` (EV §2.7.7) does so when `protocol < 3`. A `GET String`
reply's `To` names nobody: GetStringShiori never reaches `SendCommunicate` (EV §5.5), and the page sends those with
`comm: false`.

What Kawari 7 does with these requests (kept as the DLL does [decision]): it reads `Reference0`–`7` only; it ignores
`Charset`, `Status`, `BaseEvent`, `To`, `Marker`, `SecurityOrigin`; with `SecurityLevel: local` it cuts the last 7 bytes
off `Sender` (`sender.substr(0, length-7)`, written for the old `name(local)` form [src libkawari/kawari.cpp:155]): a
sender of 7 bytes or less (`SSP`, `User`, `おと`) stays whole (the length underflows), a longer ghost name loses its
end, so Kawari's automatic reply to that sender (`To` = the sender when the dictionary sets no `system.communicate`)
names no ghost it knows and is dropped; TEACH reads only `Word` and always answers 200; a TRANSLATE without
`system.OnTranslate` answers 400, so the script plays unchanged, as in ssp.exe; `GET Word` reads the entry
`compatible.` + `Type` without its first character (`\ms` → `compatible.ms`) and answers `Word: …` (200) or 204
[src libkawari/kawari.cpp:243–262] (`tests/kawari7_engine.test.mjs`, the fixture's `compatible.*`).

### 6.5 Side finding applied to every engine

ssp.exe's `ownerghostname` (3.0) and `OwnerGhostName` (2.x) carry `SPSeriko::GetCharName(0)`, the scope-0 name in
effect, not the descript `name` [disasm 0x70df20–0x70df32]. Sumika sends `_charName(0)` for every engine
(EV §2.1).

---

## 7. The corpus and the sweep

The read-only survey of the 8 archives: every dictionary is plain (the only `!KAWA0000` lines are in
mayura's shipped save `mayura.ini`, read by `$(load)`, which 7.5.0 decrypts); no SAORI; no KIS command 7.5.0 lacks.
Dictionaries are what `kawari.ini`'s `dict` lines name: `.txt` (6 ghosts), maria_re's `dictionary\*.kdf` and
`data\*.dat` (backslash paths, subfolders: C4 turns `\` into `/`), mayura's `*.dat`. So the root plan of `kawari7`
(engine-files.js `KAWARI7_TEXT` = index_site.py `KAWARI7_PACK_EXT`) is Kawari's set plus `.kdf` and `.dat`; without them
maria_re loaded 0 entries and mayura 2 [measured, first sweep]. teruno109's dictionary names differ in case from its
files (MEMFS is case-insensitive, as NTFS). alto says `debug : debugger` (the `ShioriEcho` / `KawariCommand` events run
KIS from Reference0: Kawari's own debug hook, kept).

Sweep (`node tools/sweep.mjs <archive folder> --engine kawari7`, after C9, `KAWARI7_TEXT` and
`kawari7_dump`) [measured]:

| ghost | entries | dicts | load ms | OnFirstBoot | OnClose | snapshot entries | resume | D6 (unload only) | D6 since its close |
|---|---|---|---|---|---|---|---|---|---|
| alto_beta2 | 945 | 13 | 74 | 200 | 200 | 14 | restored, all back | no effect | ok (finished) |
| gleto | 467 | 7 | 74 | 200 | 200 | 24 | restored, all back | no effect | ok (finished) |
| haruka65 | 775 | 12 | 149 | 200 | 200 | 25 | restored, all back | no effect | ok (finished) |
| maria_re | 1548 | 7 | 134 | 200 | 200 | 6 | restored, all back | no effect | no effect (saves nothing when it closes) |
| mayura_v350 | 734 | 5 | 224 | 200 | 200 | 32 | restored, all back | ok (finished) | ok (finished) |
| nijino | 458 | 16 | 87 | 200 | 200 | 13 | restored, all back | no effect | ok (finished) |
| sakura_r030103b | 1036 | 13 | 154 | 200 | 200 | 42 | restored, all back | no effect | ok by a probe; `no effect` in the sweep (below) |
| teruno109 | 2208 | 26 | 142 | 200 | 200 | 56 | restored, all back | no effect | ok (finished) |

No engine crash, no runner error, no Kawari log line, no runaway recursion, no SAORI; the reload after a dictionary
change works for all 8; the worker's save takes at most 14 ms. With the unload only, D6 would have "no effect": the session's
own unload saves nothing because those 7 ghosts (the KEEPS framework) save in OnClose, as the BTH family in Phase 8
(kawari-wasm.md D6), so a session that ended without Close would be lost. D6 first closes the session as ssp.exe closes
ghosts when Windows ends the session (kawari-wasm.md §8 [decision]): `GET Sentence SHIORI/2.2` with `Event:
OnCloseAll`, `BaseEvent: OnClose`, `Reference0: system`, `Reference1: 0`, `Reference2: 0`; the same with `Event:
OnClose` on its 204; `TRANSLATE Sentence SHIORI/2.6` on the goodbye; then `system.OnUnload`. Sweep with the close
(with the site's mayura) [measured]: every close got OnCloseAll 204, OnClose 200, TRANSLATE 400, in 2–13 ms; D6 `ok`
for alto_beta2, gleto, haruka65, mayura_v350, nijino, teruno109 and the site's mayura; maria_re saves nothing when it
closes (in SSP too). sakura_r030103b's OnClose saves (`CallSave`), but only settings the walk never changes, so its
save comes out byte for byte as the shipped `dict-keeps-savedata.txt`; the sweep's frozen fake clock writes it in the
same millisecond, so no file counts as written and the sweep says `no effect`; with a real clock D6 writes it (a probe).
Every other column as in the first sweep. Every ghost's TRANSLATE answers 400 (none defines
`system.OnTranslate`): the sweep lists it under SHIORI errors; the scripts play unchanged, as in ssp.exe. The double
unload is patch C9's case, and the sweep joins adjacent string literals before it compares entries, as for Phase 8.

---

## 8. Resume: the snapshot

Kawari 7 keeps everything in its dictionary (`map<TEntryID, vector<TWordID>>` [src libkawari/kawari_dict.h]) and never
reuses a word id (the collection only grows), so two equal id lists are the same words. The baseline is every entry's
ids once kawari.ini and the dictionaries are read, before `system.OnLoad` (C7); the entries present after OnLoad are
noted too. `kawari7_snapshot` writes each entry whose ids differ from the baseline (what OnLoad made and what the
session changed), each entry the session emptied, and each entry OnLoad made that the session emptied; left out are the
entries every request rewrites (`system.Reference0`–`7`, `Sender`, `Sender.Path`, `Age`, `Sentence`, `Surface`,
`EventName`, `ID`, and the communicate replies `system.Response0`–`7`, `system.communicate`, `system.BalloonOffset`)
and write-protected ones. Format: code page 932, one record per line, fields escaped (`\\`, `\n`, `\r`): `K7SNAP 1`,
`C NAME` (cleared), `E NAME` + `W WORD`… (the words as `save` writes them, `DisCompile`, inserted back with the engine's
own `Insert`, which also refuses a write-protected entry). The next page loads (kawari.ini, dictionaries, OnLoad again)
and restores it, so a boot count or a random pick OnLoad made keeps the session's value.

The adapter is Phase 8's (kawari-wasm.md §8): the snapshot is stored under its own key `?kawari7/resume.k7`
(`RESUME_KEY7`), stamped with the dictionaries' `# dicStamp` line (a site update drops it), emptied to the marker at
unload (D7); D6 finishes a session that ended without Close (restore, the close from outside through the bridge,
`system.OnUnload`, both at the time the session ended (`sessionEndMs`), a cold load; §7). Checked in
`smoke.mjs`, `tests/kawari7_engine.test.mjs` (restore, the marker, D6 and its close's 2.x requests on an OnClose-saving
variant, D6 at the session's end with a `$(date %Y%m%d%H%M)` stamp in `system.OnUnload`, a dropped snapshot), the
integration test (a
page change through the event loop) and in a browser (a scratch copy of the site with the fixture ghost: "snapshot
restored", the counter carried, no boot event) [measured].

---

## 9. Known gaps

- **One engine for Phase 7.0–7.5** [decision]: every Phase 7 ghost runs on 7.5.0, as a ghost's DLL updated to 7.5.0
  would; what changed between versions (KIS commands, SHIORI headers: 7.0.x predates `SecurityLevel`) is not
  reproduced. No ghost of the corpus uses a command 7.5.0 lacks [corpus].
- **gleto and ssp.exe's "kawari 7.0 compatible mode"**: ssp.exe finds `KAWARI/` + a version ≤ 7.0.0 in a `shiori.dll`'s
  image (only gleto's Borland 7.0.0 DLL) and then rewrites every request: `Charset`, `Sender` and `SecurityLevel` lines
  removed, `Charset: Shift_JIS` and `Sender: embryo` appended [disasm `CheckKawariVersion` 0x70bb90,
  `ConvertKawariRequest` 0x70bd60]. With the 7.5.0 engine ssp.exe would not do it, and it is not emulated; gleto loads
  and talks without it [measured; decision: accepted].
- **`\a` (random talk on demand)** is not implemented in the page for any engine; for a 2.x SHIORI ssp.exe sends
  `GET Sentence SHIORI/2.0`, `Charset`, `Sender` with no Event (Kawari's `sentence` entry; 7 of the 8 define it).
  Random talk itself is the ghost's own `OnSecondChange`, as in ssp.exe with its default `SHIORI.event.talk`.
- Not gaps: the **`%ms`-style words** (`%ms %mz %ml %mc %mh %mt %me %mp %m? %dms`) go to every
  engine as ssp.exe 2.9.10 sends them, here as `GET Word SHIORI/2.0` / `Type: \ms` (§6.3), so maria_re's and
  teruno109's `compatible.*` words are used; `\m?` is asked again as `\m` (neither defines `compatible.m?`), and a type
  no ghost answers (`\ml` for both) comes from SSP's word list (properties.md §2.4). The **entity decoding of resource
  replies** (`SPGhost::DecodeEntity`) is done for every engine (`shiori-events.md` §5.5).
- `GET Status` (ssp.exe's AI graph window) and MAKOTO translators (teruno109 ships `makoto.dll`) are not part of a
  browser runtime.

---

## 10. Site ghost

`mayura` (まゆら＆黒うにゅう, `mayura_v350.nar`, install folder `mayura`): extracted into a new empty scratch folder and
added with `add_ghost.py <folder> --id mayura --archive <nar>`. 65 files, all listed in the archive with
the same contents; `shiori.dll` left out. Engine `kawari7`, a pack of 22 text files (its `.dat` dictionaries with bytes
by `KAWARI7_PACK_EXT`); its balloon `wiz` hoisted into every ghost's Balloon ▸; its shipped saves `mayura.ini` (the
author's encrypted game state: flags and the shop's stock, no user data) and `news.dat` (an empty save) in
`KAWARI_SHIPPED_SAVES`. Her own DLL is `KAWARI.kdt.i18n` 7.5.0, the exact build Sumika compiles, so she is the best
side-by-side test of the bridge. For that it is installed in an SSP install (the archive unchanged in
`ghost/mayura`, its balloon in `balloon/wiz`, as SSP's install lays it out).

Checked [measured]: the sweep of the site copy equals the archive run (734 entries, D6 `ok`, every snapshot
entry back; snapshot sizes 29–33 entries between runs, as her random talk varies); a browser on the site (the handshake
line `KAWARI.kdt.i18n SHIORI/2.6, Shift_JIS`; first boot with both characters and her `.pna` masks; her double-click
menu, the SSP menu with her menu skin and site lists; the teach box → TEACH → `system.OnTeach`; the communicate box; a
page change resumed without OnBoot; a ghost change both ways). Her balloon `wiz` rendered hollow (text invisible,
clicks through) until its tRNS was dropped before decoding (balloon-format.md §1.3).

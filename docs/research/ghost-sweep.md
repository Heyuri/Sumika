# Ghost sweep (SW)

`tools/sweep.mjs` runs many ghosts headlessly on the real runtime parts and reports what the runtime cannot do yet,
ranked by how many ghosts each problem affects. This file records how it works and what its runs found.

Not in the repository: the folder of ghost archives the runs below swept, the ghosts of the development site
(`site/ghost/<id>`: CLAUDE.md "The ghosts Sumika was tested with"), SSP's word list and the notes under
`docs/research/scratch/`. These are development material, cited as the sources (CLAUDE.md "Project rules").

## How it works

- `node tools/sweep.mjs <folder of .nar/.zip | archive | ghost folder>... [--out DIR] [--jobs N] [--only REGEX]
  [--seconds N] [--picks N] [--timeout S] [--engine satori,yaya,kawari,kawari7|all]
  [--clock fixed|real|YYYY-MM-DDTHH:MM[:SS]]`. Archives are read in place
  (`tools/sweep/zip.mjs`); nothing is extracted. Satori, YAYA, Kawari and Kawari 7 ghosts run (`--engine` picks one or
  more; the default is all four); the others are listed with their SHIORI.
- **Which engine** (`sweepEngine` in `tools/sweep/views.mjs`, decided without running anything and again in each
  ghost's process): the index's rule (`detectEngine` = `index_site.py detect_engine`: descript's `shiori` line, and for
  the AYA family the config that defines `request`, which also gives YAYA's `module`; Kawari by `kawarirc.kis`, Kawari 7
  by `kawari.ini`); a ghost with no `shiori` line that ships `satori.dll` runs on Satori (sweep only); the proxies
  `lang_switch` (cyau_cyaka) and `gcore` (nibihada) run on YAYA with the module the proxy would load (an override,
  sweep only). The summary lists how each engine was decided.
- Each ghost runs in its own process (`tools/sweep/ghost.mjs`, so `log.once` and the engine start fresh), several at a
  time. Per ghost: the WASM engine fed the same files as the worker (Satori: `engineFileList`, ghost/master's text;
  YAYA: `yayaFilePlan`, the whole ghost root with text as bytes and everything else as empty placeholders, the SSP
  view of yaya-wasm.md §6; Kawari: the same with `.kis` and `.kaw` as text too, `kawariFilePlan` in
  `tools/sweep/kawari.mjs`: index_site.py's `KAWARI_PACK_EXT`, or engine-files.js's `KAWARI_TEXT` / `KAWARI_SKIP` once
  the page has them [decision]), a headless `Stage` (shell parsing, composition, animation), real `Balloons`, the real
  `ScriptPlayer` and `EventLoop`, a fake clock (below, "The clock"), and dialogs that answer like a visitor (`テスト`,
  `こんにちは`, dates...). The balloon is the one the runtime boots with (`chooseBalloon`): the ghost's own when it
  brings one, else `site/balloon/sumika`.
- **The clock** (`--clock`, `tools/sweep/clock.mjs`; `tests/runtime/sweep_clock.test.mjs`). A sweep
  tool only: nothing the site runs changes, and ghosts on the site keep the real date and time.
  - `fixed`, the default: one local date and time, Wednesday 2026-10-07 20:00:00 (the page side's start in every
    run), for the page side and the engine alike. The page side's `SweepClock` (event loop, player, stage,
    dialogs, state) is created before the engine boots, and `fixProcessClock` makes every clock of the ghost's process
    follow it: `Date.now()`, `new Date()` and `Date()` read it in whole ms, `performance.now()` reads 1000 ms plus how
    far it moved. The engines read the time only through these (Emscripten's `time()`, `gettimeofday` and
    `CLOCK_REALTIME` through `Date.now`, `CLOCK_MONOTONIC` and Satori's / YAYA's uptime through `performance.now`,
    `localtime` through `new Date(ms)`, MEMFS mtimes through `Date.now`), so every engine loads at 20:00:00 sharp and
    then stands still between the fake clock's steps, as YAYA and Kawari do under `--clock real`. What the
    ghost's own scripts read (Satori's `（現在時）`, YAYA's `GETTIME`, Kawari's `date`, KEEPS's `cntwork`, time signals
    in OnMinuteChange, the `time_check` stand-in, `system.*` properties) is the same in every run, and so is every seed
    an engine takes from the clock: Satori's and YAYA's MT19937 (`gettimeofday` ^ `CLOCK_MONOTONIC` ^ `getpid()`,
    which is 42 in Emscripten) and Kawari's `SRandom(time(NULL))`, so their random talk repeats from run to run.
  - `YYYY-MM-DDTHH:MM[:SS]`: the same from another local start, for example `2026-10-07T19:55` to have the walk
    cross 20:00 and fire the hour's time signals (from 20:00:00 the walks of "A fixed clock" below ended between
    20:11 and 20:24, inside one hour; Tsubasa says "It's 8 PM." at 20:00 when started at 19:55 [measured]).
  - `real`: the page side from the fixed date, Satori on the real clock (date, hour and
    its seed), YAYA and Kawari on the real date and time of the shell stage, advanced with the page side's clock
    (`followClock`, which also left `new Date()` real), their load on the real clock.
  - Wall times stay real (`realNow`, `realPerf`, bound before the override): `wallMs`, a request's time (`slowest`,
    `slow`), the saves, resume and D6 times; a root engine's own `engine.timing` (module, load: the Kawari table's
    load ms) reads `performance.now` and would stand still, so `realTimings` takes those two again on the real clock
    around its boot and its load call. Each report has `clock` (`mode`; `start` and `end`: the page side's local time
    at the start and at the end of the walk); `summary.json` has `clock` and `summary.md` a "Clock:" line, next to
    `date`, which stays the real date of the run.
- YAYA ghosts differ in three ways (yaya-wasm.md §14 has the counts): their clocks (`Date.now`, `performance.now`)
  follow the fake clock (with `--clock real` from the shell stage on, `followClock`: the templates time random talk
  with `GETSECCOUNT`; under the default fixed clock every engine's do, from its boot on: "The clock"); a
  worker-like store keeps every report (after init and each request, `mergeFiles`); and after the run the resume check
  (`resumeCheck`) saves, resumes a fresh engine from that store (each stored file and the save as the engine holds
  them) and compares the two saves line by line (`changed`: a saved value not brought back; `added`: a variable only
  `load` makes), then resumes once more after a one-line change to a shipped dictionary, which must load as after an
  update (`stampReload`). A YAYA ghost that does not load (status 2 or 3) is a finding under "Load status", not a
  runner failure.
- Kawari ghosts (kawari-wasm.md §15) run like YAYA ghosts (the fake clock for `date` and `time()`, the
  worker-like store), plus:
  - the worker's save (`KawariEngine.save`: the snapshot of the entries the session changed and those its load
    made) every 5 s of the idle
    phase and before the resume check, timed (`kawari.saves`: count, longest, largest stored snapshot);
  - Kawari's own log lines (`error`, `warning`, `log`), counted by phase and kind (`kawari.log`; the parse errors are
    `engine error`, the lines of the run's one load) and kept once each without file and line, with a count
    (`engineLog`);
  - a runaway recursion (a RangeError) answers 500 and the engine goes on, as the stack guard makes it (kawari-wasm.md
    D8): recorded under `runaway` with its request, not as an engine crash;
  - a close that the ghost's own script makes mid-run unloads the engine (the loop's unload at `\-`); the walk's next
    boot then gets a new engine from the stored files, as the runtime's next visit does (`restarts`). This holds for
    YAYA too (no YAYA ghost closes in the walk); Satori's engine answers on after an unload and is kept;
  - the resume check (`kawariResumeCheck`): A = every entry after the run (`_kawari_snapshot(path, 1)`, patch K12),
    B = the same in a fresh engine resumed from the store as the next page, base = the dump right after the run's
    load; words compared with adjacent string literals joined (`"a""b"` comes back as `"ab"`, the same text when
    run). Each entry where B differs from A is `changed` (in the snapshot: it did not come back as saved), `missed`
    (the session changed it, the snapshot did not carry it) or `loadSet` (the session left it as load made it, the next
    load makes it otherwise; the snapshot carries every entry load's scripts made, so only a
    definition read from a file the session rewrote is left: kawari-wasm.md §8). Dumps leave out System.Request*,
    System.Response* and write-protected entries, so an entry the session write-protects shows as `missed`. Then the
    stamp reload (a comment line appended to kawarirc.kis: the info line, the snapshot dropped, `version` answered as
    before) and D6 (kawari-wasm.md D6 [decision]): a cold boot from the same store, a day later with
    the session's end as `sessionEndMs` (`d6At`), closes the session first, as ssp.exe closes ghosts when
    Windows ends the session (OnCloseAll / OnClose `system`, OnTranslate; kawari-wasm.md §8), then unloads it; the
    files it writes must equal what B's own close (`closeFromOutside`) and unload write (time stamps included: only a
    close at the session's end matches), and its OnBoot is asked. Its `outcome` (`tools/sweep/kawari.mjs` `d6Outcome`): `ok`, `nothing to
    finish`, `failed`, or `no effect` when the session's own close and unload write no file (a ghost that saves nothing
    when it closes; in run K3, which had no D6 close, it meant "its unload writes nothing" and counted the OnClose
    savers). A save that comes out byte for byte as the stored file
    is written in the same fake millisecond and does not count (sakura_r030103b, run K4). "D6 close" shows what D6's
    close got and the wall time of B's;
  - a request's time (`slowest`, `slow`) holds the worker's check for changed files after it, as the worker times it
    (a root engine scans only after a request that wrote);
  - `summary.md` adds "Kawari ghosts" (load, parse errors, the boot events' statuses, slowest request, heap, saves,
    files written), "Kawari: runaway recursions", "Kawari engine log" and "Kawari resume". The pure parts (file plan,
    log keys, dump reading, the sort of differing entries) are in `tools/sweep/kawari.mjs`, checked by
    `tests/runtime/sweep_kawari.test.mjs`.
- The ghost's index entry is built as `tools/index_site.py` builds it (`ghostEntry` in `tools/sweep/views.mjs`):
  shells named and ordered by Shell ▸'s rules (`default` / `Default` names, `hidden`, SSP's name order), and the
  shell a visitor who never picked one boots (`defaultShellId`: `seriko.defaultsurfacedirectoryname`, master,
  surface, the first by name). `tests/runtime/sweep_views.test.mjs` checks it against `site/sumika/index/ghosts.json`.
- Shell and balloon changes the ghost's own scripts ask for go down the runtime's path: the loop's `viewSwitcher` is
  `viewSwitcher()` from `tools/sweep/views.mjs`, a small copy of `Runtime._requestView` (one change slot, script
  changes queued behind it, `MAX_CHAINED_CHANGES`): a shell swaps through `shellChanging` (raise-event),
  `detachStage`, a new headless `Stage`, `attachStage` and `shellChanged`, with the per-shell dress-up and the shell's
  balloon; a balloon re-skins (`Balloons.setSkin`) and gets `setBalloonInfo` / `balloonChanged` (EV §2.6, BA §12).
- What it does with each ghost: first boot (follows the first choice of each first-boot question), double-clicks
  both characters and explores the menus breadth-first (up to `--picks` choices, three levels), clicks, strokes and
  wheels every collision area of the current surfaces, presses a few keys, opens the communicate box, then leaves the
  ghost alone for `--seconds` (default 600) of fake time (random talk, minute changes, answering choices in talks),
  and closes it.
- What it records: every runtime log line (warnings, "not supported", "ignored"), every SHIORI request with its
  status, `ErrorDescription` and wall time, unknown script tags (`host.unknownTag`), SAORI loads and whether a
  stand-in exists, input boxes, the script tags each ghost uses, engine aborts (the adapter's `request:` error),
  runner failures and timeouts, the shell it booted (`shell`) and every shell or balloon change it asked for
  (`changes`: kind, target, raise-event, result `switched` / `no such shell` / `cancelled` / `refused: …` / `failed:
  …`, from, to). `summary.md` lists the changes by outcome and each ghost's number of switches. For YAYA ghosts also:
  the engine and module and how they were decided (`engineBy`), the DLL's FileVersion, `loadStatus`, YAYA's own
  fatal / error / warning / note lines (`engineLog`), the stored keys (`stored`) and the resume check (`resume`);
  `summary.md` adds "How the engines were decided", "Engine errors and warnings", "Load status" and "Resume
  differences", and an engine column in the ghost table. Every report also has its slowest request
  (`slowest`), and a SAORI is listed once per name (Kawari tries a missing one again at each call).
- Run-to-run noise: ran / ok / crashed / fatal and the SAORI tally stay equal between identical runs; unknown tags,
  request errors and warnings (Satori) and engine-log keys (YAYA) move by up to about 3 keys (random talk paths that
  depend on timing; a ghost slower inside the full sweep). Run a ghost that moved alone (`--only`) before calling it a
  regression (yaya-wasm.md §14 lists the keys that moved in the YAYA runs). Kawari (four K1 runs, below): ran /
  ok / crashed / fatal, parse errors, files written, request errors, unknown tags and runaway recursions stayed equal;
  the SAORI tally moved once (brynhild_conf1.13 reached two more DLLs in a talk path of one run), warnings by up to 5
  keys, the snapshot's entry count by a few entries, and two statuses that follow a random pick (bloody_moon's
  double-click, honue090104's load-set `Wearmode`). Those runs were all made with the engines on the real clock
  (`--clock real`). The fixed clock takes the time of day and the engines' clock seeds out:
  two runs of the same tree give the same report for most ghosts, and what is left comes from the page side's own
  random picks (surface aliases above all) and the wall times ("A fixed clock" below).
- **No network.** `\![execute,http-*]` (EV §4.15) runs through the real `HttpRequests` with a stub fetch
  (`sweepFetch`): every request is recorded (`http` in the report: phase, method, URL, `cors` / `no-cors`) and answers
  as a host that cannot be reached (fetch's TypeError: Failure `error`), so the ghosts' failure paths run and no
  ghost author's site is contacted. `summary.md` lists them under "HTTP requests the ghosts made, never sent". The
  process's own `fetch` refuses every http(s) and ws(s) URL too (a `\_b[http://…]` image, anything else).
- `SWEEP_TRACE=1 node tools/sweep/ghost.mjs <archive>` prints every request (but ticks and moves) on stderr.
- To compare a finding with the real DLL, extract the ghost and use `tools/dll_harness.ps1` (32-bit PowerShell). Remove
  a shipped `satori_savedata.txt` first: the DLL reads it, Sumika's engine never gets it, and the two then disagree.

## First run: 320 archives of a corpus of downloaded ghosts

This run is Satori only; the YAYA runs (26 ghosts) are in yaya-wasm.md §14, the Satori runs made for
it (S0–S2b) there too.

247 Satori ghosts ran, all to the end: **no engine abort, no runner error, no timeout**. 73 were skipped: 18 YAYA,
8 AYA/AYA5, 21 with no `shiori` line and no `satori.dll` (old ghosts), 9 `shiori.dll`, 3 Misaka, and single ghosts
on other SHIORIs. Wall time 2–9 s per ghost, about 5 minutes for all with 6 at a time.

### Rules this run led to

- **A forgotten `}` in surfaces.txt** (SH §2.2): type01-Mono's `surface1020` block has no `}`, so `surface1021 {` landed
  inside it and `\s[1021]` showed nothing. A `{` inside a block ends the open block.
- **`empty.dll`** (before the run, ハヤト; 5 archives ship it) is the Recycle Bin SAORI and shares the `gomi.dll`
  stand-in.
- **SAORI stand-ins** (`src/worker/saori/standins.js`) for the most used DLLs below: `aya5.dll` (Read.*
  answers "notfound"), `mciaudior.dll` / `mciaudio.dll` (the dsaudio music box; paths relative to the DLL's folder;
  see "MCI players" below), `time_check.dll`, `saori_cpuid.dll` (as the DLL answers: `platform` = the host program,
  `ssp.exe`, which 1st-innerport shows in its balloon; CPU flags `Ready`; keys it does not know `Param Error`),
  `sysio.dll` (see below), `maho.dll`. The table keeps the counts of the first run.
- **Checked against the real DLLs** (in the 32-bit harness, and the ghosts on the WASM engine):
  - **MCI players.** `mciaudior.dll` is not silent. Its strings hold `NOTIFY SSTP/1.0`, `Sender: mciaudior`,
    `Event: %s`, `Reference0: %s`, `Reference1: %d`, `OnMAAPlayFinish` and `OnMAAPlayLoop`: it tells the ghost when a
    track ends and when a looping track starts over. cmn (its playlist moves on), mikaru140920 (end talk, loop
    reservation that loads R0 again), souzou_syoka (title from R0, saved in a bin) and hitujitopanda (a menu) handle
    them. The music box raises both for mciaudior's tracks through the event loop as GET (an SSTP NOTIFY reaches SHIORI
    as a GET whose reply plays unless its `Option` says `notify`, UKADOC SSTP), R0 = the file as the ghost gave it to
    `load`, R1 = `0` [guess: the number's meaning is unknown]. A loop restarts by hand at the end of the track, so
    every pass is seen. `mciaudio.dll` (no r) has only load / play / stop and no events.
  - **Numbered MCI players have no stand-in.** um.nar declares six players, `mciaudior` … `mciaudior６`
    (`mciaudior.dll` … `mciaudior6.dll`, copies of one DLL): BGM on the first, footsteps and knocks on the others,
    played over it. The music box holds one track, so `mciaudior2.dll` sharing it cut um's BGM; `mciaudior2.dll` …
    `mciaudior6.dll` load no stand-in (calls expand to nothing; the footsteps are silent). No other archive calls
    them. A second player channel (like `\_v`) is the way to give them sound later.
  - **sysio.** Not only `isexist`: the first grep missed ghosts with their own argument separators. Flugor (`b4`) and
    cmn (`△`) call `readdir` (`!=-1` = a folder) and cmn `isdir` and `isfile` (`!=1` = missing); with `''` answers
    every dropped song was a folder or missing. The real DLL answers an existing file isexist 1, isfile 1, isdir 0,
    readdir -1. The stand-in answers so for every dropped-file pseudo-path (the worker cannot see the store, so a
    file the browser no longer keeps also counts as there [decision]; souzou_syoka's bins then replay what is still
    stored), and 0 / 0 / 0 / -1 for any other path; a browser reaches no folder.

### SAORI DLLs without a stand-in (ghosts affected)

| DLL | Ghosts | What ghosts call | Stand-in idea |
|---|---|---|---|
| `aya5.dll` | 16 | almost only `Read.SaveData,<ghost>,<variable>`: another ghost's save data (07_words asks about bukimi, ...) | answer "not found" (or read the other ghost's save when the site has it) |
| `mciaudior.dll` / `mciaudio.dll` | 14 + 2 | `load,<file>`, `play`, `stop`, `loop` (music bundled with the ghost or dropped); mciaudior's events OnMAAPlayFinish / OnMAAPlayLoop (4 ghosts) | the dsaudio music box |
| `time_check.dll` | 8 | `how_many_days,Y,M,D` (days since the last session) | date arithmetic |
| `saori_cpuid.dll` | 7 | `os.name`, `os.version`, `cpu.name`, `cpu.clock`, `mem.*`, `platform` (1st-innerport shows it) | browser values |
| `effect.dll` | 6 | a screen effect | no-op |
| `parallel.exe` | 6 | two lines said at once | to check |
| `mako.exe` | 5 | regex over another ghost's `satori_savedata.txt` | "not found" |
| `kenonoke.dll` | 4 | `GETKEYWORD,<text>` (keyword of a communicate line) | to check |
| `sysio.dll` | 4 | `isexist,<path>`; `readdir`, `isfile`, `isdir` (Flugor, cmn, with their own separators) | dropped files exist and are files |
| `maho.dll` | 3 | file type of a dropped file (`mp3`, `wav`, `midi`, `ogg_vorbis`) | by extension |
| others | 1–2 each | `bln`, `houchi`, `obu`, `omni`, `osuwari`, `ccpuid`, `choice`, `dacko`, `driveinfo`, `edittext`, `gyan`, `handutil`, `hitori`, `if`, `substr`, `sunewo`, `kawari` (as SAORI), ... | |

### Script tags the runtime ignores (ghosts)

`\![execute,http-post]` 13 (web claps: requests to the author's site, not sent in this run; they are sent [decision],
see "HTTP requests" below), `\6` 1 (cafe; clock
sync, a no-op by design, SS §5.7), `\![call,ghost]` 4 (two ghosts at once), `\![open,file]` 3,
`\![open,help]` 2, `\![set,trayicon]` 2, and single uses of `\![open,dialog,color]`, `\![open,ghostexplorer]`,
`\![open,mailer]`, `\![open,surfacetest]`, `\![raiseplugin]`, `\![executesntp]`, `\![execute,http-get]`,
`\![set,autoscroll]`, `\![set,otherghosttalk]`, `\![set,sticky-window]`, `\![set,trayballoon]`, `\![updatebymyself]`,
`\_[N]` (a typo).

**Supported after the first run**, so a later sweep does not list them:
- `\4` / `\5` (move away from / next to the other character; UI §3.8). The first run counted them together with `\6`
  as 8 ghosts (`\8` was never ignored: it plays its sound).
- `\__c` (3 ghosts: 6634c730de28dcfd1f90a36367e9db23, chisato2_022, denpa): opens the communicate box.
- The teach box, `\![open,teachbox]` / `\__t` (3 ghosts: 6634c730de28dcfd1f90a36367e9db23, chisato2_022,
  ruka020418; UI §6.3).
- `\![change,shell]` (3 ghosts: Katari, souzou_syoka, tok_2; EV §2.6): see "Satori run with shell changes" below.

A full sweep afterwards lists none of them among the unsupported tags, `\6` only for cafe, and no "`\![open,teachbox]`
is not supported" warning; chisato2_022 and ruka020418 open the teach box from their menus and send OnTeachStart
and OnTeach (both answered 204, see "Not Sumika's").

### SSP properties (`%property[…]`, `\![get,property,…]`)

14 property names occur in the 320 archives, none in more than 2 ghosts: `currentghost.balloon.scopeN.validwidth`
(etherism, mikaru; etherism divides by it and `calc` fails), `currentghost.shelllist.current.name` (kanade_2nd,
souzou_syoka), `.lines`, `.char_width`, `.validheight`, `currentghost.shelllist.current.path` / `.count`,
`currentghost.balloon.name`, `ghostlist.count`, `ghostlist(<sakura name>).name`, `activeghostlist.current.update_time`,
`system.year`.

They resolve (`docs/research/properties.md`), and the sweep counts every name a ghost reads or sets
(`report.properties`: `%` for `%property`, `get` for `\![get,property]`, `set`; `ok` or `fails`; a list's argument
counted as `(NAME)`), plus the Preferences box pages it asks for (`report.settings`); summary sections "Properties read
or set" and "Preferences box asked for". The visitor never saved the box in the sweep (a fake UserProfile, unset), so
no ghost gets OnNotifyUserInfo and `%username` falls back to `user`.

A full sweep (273 ghosts: 247 Satori, 26 YAYA; 271 ok, the same 2 YAYA load failures, no crash or runner
failure): only 4 ghosts reach a property in the sweep's paths, and every name they read has a value:

- etherism: `\![get,property]` of `currentghost.balloon.scope0.validwidth`, `.lines`, `.char_width` and
  `scope1.validwidth`, `.char_width` (OnFirstBoot, OnBalloonChange). Its 4 `calc : Bad Request` keys (6 errors:
  OnCommunicate, OnKeyPress, OnMouseDoubleClick, `表示文字数計算処理`) do not occur.
- souzou_syoka: `%property[ghostlist.count]`, `currentghost.shelllist.current.name`, `currentghost.shelllist.count`,
  `currentghost.balloon.name`.
- mobilemaster (YAYA): `\![get,property]` of `currentghost.balloon.scope(0).validwidth`.
- emily4: `\![open,configurationdialog,setup]` at the end of her first boot opens the box (not an unsupported
  tag); her favourites' `activeghostlist.*` reads are not on the sweep's paths.

No ghost gets a boot `GET username` (ssp.exe asks it only when it expands `%username`); no played script
in the 10 ghosts that use properties or the user name held `%username`. Everything else that moved against the
earlier sweeps moved as much between two identical runs of the same code (1st-innerport `\N`, unyu-unyu's
OnTranslate syntax error, sake_kami's `calc`, kirito's text box, "scope N has no surface"), checked by running those
ghosts alone twice before and twice after.

### Not Sumika's

- **Unbalanced `（` in a dictionary** (DSLGS `dic_com3.txt`, gouki_saki, PAPARIN, unyu-unyu, yukine, chisato2_022):
  Mc203 reports "mismatched parenthesis" in `ErrorDescription` and still loads the file, like the DLL (DSLGS checked
  with its Mc159-3 DLL: same answers).
- **A ghost written for a much older Satori** (PikuandNanika, phase 123): a double-click on `\1` makes Satori's default
  `（）` fallback spin for 10–15 s in Sumika's build and 42 s in the native Mc160-1 DLL, then answer 204; its own phase 123
  DLL prints `（）` at once. The runtime's request watchdog is 30 s (`KILL_MS`), so a slow device could restart the
  engine there.
- **Missing surfaces** asked for by scripts (denpa 4/5/6/12, BellandMell 9107, sakuma 1100, cafe 11, gouki_saki -99,
  zange 4 from another shell; single-character ghosts without surface 10): absent from the ghosts' own files.
- **Word groups requested directly** (`GET <word group>`, 225 ghosts define resources such as `username` that way):
  Mc159 turns `（０）` in the word into `\s[0]`, Mc203 returns `0`. Inside talk entries both agree. Only pankoR3 has a
  number in such a word.
- **Satori `calc` errors**: etherism divides by SSP properties the runtime does not have (see above); sinmai's comes
  from the sweep answering a number prompt with text. 1st-innerport, sagiri_tama, nadeshiko (`sakurahwndold`) and
  sake_kami are not compared with the DLL yet.
- **Sound files a ghost names but does not ship** (PICKLES_34th's voice set `00\021.wav` …, tok_2's `hage*.wav`):
  every sound and music file that is in an archive is found (`media` in the reports).
- **Teach replies written for an older Satori** (6634c730de28dcfd1f90a36367e9db23, chisato2_022, ruka020418):
  `＄教わること	ユーザ名` writes `\![open,teachbox]`, and the taught word was meant to reach `＊ユーザ名を教えてもらった`.
  Mc203 only stores that genre and never reads it again (`teach_genre` in `satori_builtin.cpp`), and these ghosts
  define no `＊OnTeach`, so OnTeach answers 204. Not compared with a DLL.

### Harness limits

- Sounds and music are recorded with whether the file is in the ghost, not played.
- The right-click menus are built from the ghost's resources (`menu` in the reports), not opened or clicked,
  asked as the page asks them (`askMenu`, `ssp-ui.md` §2.1 Notes): the clicked character's `popupmenu.visible` /
  `.type` first, then the shown menu's ids; `resources` counts both rounds' answers (so a ghost answering `type` counts
  one more, one whose `visible` hides the menu 0), and `target` names another character's menu
  (`site/ghost/bthver.5` alone: `menu[1]` went from 4 items / 8 resources to 9 / 36 with `target` 0, its first-boot
  choices having set Mode Tea0; `menu[0]` stayed 9 / 35).
- Input boxes get fixed answers (`テスト`, dates, `こんにちは`): a ghost that wants a number gets text.
- Clicks and strokes use the surfaces shown at that moment; dress-up and other surfaces are not visited, and other
  shells only when the ghost's own scripts switch to them (Shell ▸ and Balloon ▸ are never picked).

## Second Satori run, same 320 archives

247 Satori ghosts, all to the end again (no engine abort, runner error or timeout). Against the first run:

| | First run | Last run |
|---|---|---|
| Missing SAORI DLLs (ghost × DLL) | 108 in 67 ghosts | 54 in 37 ghosts |
| Unsupported script tags (ghost × tag) | 42 in 37 ghosts | 32 in 28 ghosts (13 are web claps) |
| SHIORI errors (ghost × kind) | 149 in 76 ghosts | 90 in 46 ghosts |
| Runtime warnings (ghost × kind) | 275 in 115 ghosts | 220 in 103 ghosts |

The `}` leniency fires in 7 shells (type01-Mono and its two variants, poet, evil_one, yagi_the_twins080602 ...);
each site was read and is a forgotten or misplaced `}` (`…,Neck}` at a line end in evil_one, an empty
`surface0119` block in yagi_the_twins080602).

## Satori run with shell changes, same 320 archives

Run with the sweep's ghost entry and view switcher above. 247 Satori ghosts, all to
the end (no engine abort, runner error or timeout), about 4 minutes with 6 at a time.

- **The three `\![change,shell]` ghosts switch**: Katari goes master → 少女語り (`loligatari`) from `\0`'s menu and back to
  master from `\1`'s; souzou_syoka master → 書架迷宮 (`non2`); tok_2 names its only shell (トクさんのクイズダービー), a reload of
  master. Each sends OnShellChanged on the new shell through the real loop path. No other archive asks for a shell or
  balloon change in the sweep's walk.
- On the new shells, not Sumika's: Katari's `loligatari` surfaces.txt has the same comment-line warnings as its
  master (`"{" not found after #20→猫耳` …), and souzou_syoka asks `non2` for a surface 1 it does not have.
- Against the second Satori run: SAORI DLLs without a stand-in 54 in 37 ghosts (same); unsupported tags 33 in 29
  (`\N` once more, in 1st-innerport's random talk); SHIORI errors 91 in 46 (sake_kami's `calc` error once more);
  runtime warnings 219 in 103. The other differences (which random talks, sounds and missing surfaces came up) vary
  between runs.

## HTTP requests

`\![execute,http-*]` is sent [decision] (EV §4.15). The sweep counts it and sends
nothing (How it works, "No network"). A run of 11 archives that use it (the site's six: DSLGS, Katari, bonsyou,
etherism, hayato, roommate; and b-d, cyau_cyaka, kanade_2nd, pray_p, snow girl from `scratch/http/corpus.md`; `--only`,
both engines) [measured]: 11 of 11 ran to the end; the `\![execute,http-*]` tags left the unsupported list; 4 ghosts
made requests in this walk: bonsyou GET `ms.shillest.net` (cors, 4 times: its menu counter), cyau_cyaka GET
`www.dyndns.org` (cors) and POST `cat-fish.net` (no-cors, twice), snow_girl GET `www.jma.go.jp` (cors), b-d POST
`clap.webclap.com` (no-cors). Each got its Failure (`error`): `OnCountCompleteMenuFailure` 204 (bonsyou defines none),
`OnExecuteHTTPFailure` 200 (snow_girl's trayballoon, cyau_cyaka's dispatch on R1), `OnWebCrapResponseFinishFailure` 200
(b-d). The others' claps need a menu, an input box and a confirmation the walk did not take this time. Expect the next
full sweep to list them under "HTTP requests the ghosts made, never sent" instead of the unsupported tags.

## Tag brackets as SSP splits them

The tokenizer reads `[…]` as ssp.exe does (SS §3.4: quotes anywhere, `\X` pairs, one-string tags, `\p[` `\w[`
`\q`, unclosed brackets dropped). Satori sweep of the 30 archives with a quote in the middle of an argument or a
one-string tag with a comma (`scratch/tagquotes/ssp.md` §10: 07_words … yomi_to_syu, 5sai; mukuro alone, as its
archive name has a suffix), `--only`, before and after the change [measured]: 30 of 30 ran to the end both times;
unsupported tags 3 → 3 (the same `\![open,file]` in nonikatonami, roommate, yomi_to_syu); HTTP requests 12 → 12 in
the same 9 ghosts; warnings, SHIORI errors and SAORI lists unchanged; scripts and choices moved within the run-to-run
noise. What changed is inside the requests: yomi_to_syu's clap (the walk reaches it twice) went out synchronously
with R1 empty, its Failure answered 204, and `テスト",--async=webclap]` was left as balloon text; after it, the clap
is threaded, R1 is `webclap`, and the ghost's own `拍手送信失敗` talk plays (`SWEEP_TRACE=1`, menu0 and menu1).
The walk did not reach roommate's clap; `tests/runtime/http.test.mjs` plays it on the real Satori engine.

## Kawari run K1

The first Kawari sweep (run K1): `--engine kawari` over the 320 archives of the corpus, on
`site/sumika/engines/kawari.wasm` (8.2.8, R1's best-fit encoder). Four runs
[measured]: three with 6 at a time (about 1.5 minutes each) and one with `--jobs 1` (3.6 minutes) for the timings.
Counts only; the reports, which quote the ghosts, are not kept here.

- **What ran.** 18 Kawari ghosts (all `by descript`); 302 skipped, among them the 8 `kawari7` ghosts (alto_beta2,
  gleto, haruka65, maria_re, mayura_v350, nijino, sakura_r030103b, teruno109). snow girl (Kawari only as a SAORI)
  stays in the Satori run.
- **Ran to the end.** 18 of 18 in every run: no engine crash, no runner failure, no timeout.
- **Boot events.** `version`, OnFirstBoot and OnClose answer 200 in all 18. OnBoot answers 200 in all 18 (asked after
  D6's cold boot; in the walk only brynhild_conf1.13 gets one, after its own menu closed it). Double-click: 200 in 13
  or 14, 200 for some double-clicks of the walk and 204 for others in honue090104, rotten101010, umikoF (and
  bloody_moon in 2 of 4 runs), 204 in machi_1.0 (its first boot ends with a name question the walk answers late, and
  it ignores double-clicks until then [infer]). asri101 answers 200 (through K10, P1's finding).
- **SHIORI errors.** One 500: kuro_r030114b's menu item `Comm` calls an entry that calls itself without end. The
  recursion runs out of stack (RangeError), the request answers 500 and the engine answers everything after it as
  before (the stack guard, D8; summary "Kawari: runaway recursions"). Not Sumika's: the entry recurses in any Kawari
  [infer: read in its dictionary; its own DLL, 8.0.0, was not run].
- **Parse errors per load** (the run's one load, every run): Aria 64, asri101 2, bloody_moon 1, BRH1.251 0,
  brynhild_conf1.13 60, BTH4th_last 0, BTHver.5_2.732 0, firefox 0, honue090104 0, kuro_r030114b 593, machi_1.0 17,
  meganeoni040313 154, norn_04.00 17, rotten101010 0, somberlain 12, toxic060816 0, umikoF 16, wakaba001 142. These
  equal P2's per-load counts. Load warnings: brynhild_conf1.13 7,
  meganeoni040313 8, norn_04.00 3, somberlain 19.
- **Files written:** as kawari-wasm.md §15's table lists them (norn_04.00 and somberlain none).
- **SAORIs without a stand-in:** `bln` (bloody_moon, toxic060816), `hanayu` (somberlain), `launcherhook`, `process`,
  `windowsmin` (brynhild_conf1.13), `lettuce` (umikoF), `mciaudior2` (meganeoni040313), `textcopy` (toxic060816); one
  run of four also reached brynhild_conf1.13's `effect` and `scribble`. Unsupported tags: `\![executesntp]`
  (brynhild_conf1.13), `\![raiseplugin]` (honue090104).
- **Speed** (`--jobs 1`; 6 at a time roughly doubles the load times): load 23–464 ms (Aria 464, every other ghost
  at most 173); slowest request: asri101 106 ms (OnMouseWheel; 174–182 ms with 6 at a time), every other ghost at
  most 21 ms; heap 32 MB in all 18; the worker's save (the snapshot) at most 5 ms (9 ms with 6 at a time), the largest
  stored snapshot 45 KB (toxic060816; BTHver.5_2.732 reached 63 KB in one run); a resumed page's load at most 462 ms,
  a D6 cold boot at most 859 ms (both Aria).
- **Resume** (every run): 18 of 18 got every entry of their snapshot back (0 back different). **Missed: 3**:
  `sentence` in brynhild_conf1.13, meganeoni040313 and wakaba001. Their boot processing (`preset.2`, read in their
  dictionaries) runs a no-repeat helper that copies `sentence` to `sentence.backup` and write-protects both. K12 leaves
  write-protected entries out of the snapshot (they refuse writes), so a resumed page has load's unprotected
  `sentence`, and the helper's state stays lost until the next cold boot runs the boot processing again. Fix belongs to
  K12 (P1): an entry protected since the baseline should be written with its words and protected again after the
  restore. Load-set entries: `cntwork` in the five KEEPS
  ghosts (Aria, firefox, kuro_r030114b, machi_1.0, umikoF: minutes from the clock, set at load) and, in 1 of 4 runs,
  `Wearmode` in honue090104 (a random pick at load). P1's Aria `GhostBirth` did not show in the walk. The reload after
  a dictionary change: 18 of 18. D6: 18 of 18 by K1's test (17 finished the session from the snapshot and wrote the
  same files as the session's own unload, machi_1.0's `dict-keeps-savedata.txt` among them; norn_04.00 changed
  nothing, so there was nothing to finish). 7 of those 17 write no file at their unload (they
  save in OnClose), so for them D6 kept nothing and the check passed without testing anything; run K3 below reports
  them as `no effect`.
- **In short.** Every ghost loads and answers the boot events, no crash or runner failure, parse errors as P2
  measured, the same files written, `kawari7` skipped, snow girl on Satori, load ≤ 500 ms, heap, snapshot cost, 0
  snapshot entries back different, stamp reload, D6. Left: one SHIORI 500 (kuro_r030114b's own recursion, above);
  asri101's slowest request of 106 ms (a Satori emulator written in KIS); 3 entries missed by the snapshot
  (`sentence`, above).

## Kawari run K3

With the 42-patch build (kawari-wasm.md §8, §14, §15), whose snapshot also carries the entries load made; D6's
`outcome`; a request's time with the worker's scan; the scan only after a write. Two runs over the same 320 archives
[measured]: one 6 at a time (about 70 s), one with `--jobs 1`; plus the two site ghosts alone. Counts only; the reports
are not kept here.

- **Ran:** 18 of 18, `kawari7` skipped as in K1.
- **Resume:** 0 entries back different. **Load-set 0** for all 18 in one run and for 17 in the other (K1: `cntwork` in
  the five KEEPS ghosts and honue090104's `Wearmode`): firefox's `closemode` and `freeze` in the `--jobs 1` run, read
  as definitions from its own `dict-keeps-savedata.txt`, which the walk's mid-run Close rewrote (the gap kawari-wasm.md
  §8 names). Missed: the 3 `sentence` entries of K1, and in one run BTH4th_last's `普通の食べ物` (a `Nonoverlap` target
  its menu reached: the same write-protect gap).
- **D6:** `ok` 10, `nothing to finish` 1 (norn_04.00), `no effect` 7: BRH1.251, BTH4th_last, BTHver.5_2.732,
  honue090104, rotten101010, somberlain, toxic060816. The site sweep: bthver.5 `no effect`, machimaki `ok`.
- **Snapshots** grew with the load-made entries: largest 62 KB (asri101, whose KIS Satori emulator builds its
  dictionaries at load), BTHver.5_2.732 24–43 KB, bthver.5 (site) 4.3 KB, machimaki 1.5 KB; a save at most 6 ms with
  `--jobs 1`.
- **Speed** (`--jobs 1`): load 20–491 ms (Aria); slowest request asri101 107 ms (OnMouseWheel), every other at most
  29 ms; resume at most 497 ms, D6 at most 1,012 ms (both Aria).
- A build that carries the bodies of KIS `function` definitions too takes 39 s to resume asri101 and 1.4 s for Aria
  with 6 at a time: loading a function body back as a dictionary line is slow (asri101's 39 KB: 17 s). So function
  bodies count as definitions.

## Kawari run K4

With D6 closing the session it finishes as ssp.exe closes ghosts when Windows ends the session ([decision];
kawari-wasm.md §8, shiori-events.md §2.3.1), with the sweep's D6 check closing the
resumed session B the same way before its unload. Runs over the same 320 archives with the site's `bthver.5` and
`machimaki` as more sources [measured]: `--engine kawari` once 6 at a time (about 50 s) and once with `--jobs 1`;
`--engine kawari7` twice with the site's `mayura`. Counts only; the reports are not kept here.

- **Ran:** 20 of 20 Kawari (18 archives, 2 site ghosts), 9 of 9 Kawari 7; no engine crash, no runner failure.
- **D6 close:** every close got OnCloseAll 204, OnClose 200, then OnTranslate 204, or 200 for the ghosts that answer
  OnTranslate (brynhild_conf1.13, BTHver.5_2.732, meganeoni040313, toxic060816, wakaba001, bthver.5), or TRANSLATE 400
  for the Kawari 7 ghosts (none defines `system.OnTranslate`). B's close took 1–11 ms with `--jobs 1`.
- **D6, Kawari:** `ok` 16 of the 18 archives (K3: 10; BRH1.251, BTH4th_last, BTHver.5_2.732, honue090104,
  rotten101010 and toxic060816 finish with the close), `nothing to finish` 1 (norn_04.00), `no effect` 1 (somberlain: it
  saves nothing when it closes); the site's bthver.5 (K3 `no effect`) and machimaki `ok`. brynhild_conf1.13's D6 also
  writes `dict-cr.txt`. D6 at most 1,094 ms (Aria, `--jobs 1`; K3 1,012, while Aria's resume, which D6's close does not
  touch, went from 497 to 688 ms: a slower machine).
- **D6, Kawari 7:** `ok` for alto_beta2, gleto, haruka65, mayura_v350, nijino, teruno109 and the site's mayura (K3-era
  run: only mayura); `no effect` for maria_re (saves nothing when it closes) and sakura_r030103b. sakura's OnClose does
  save, but only settings the walk never changes: its save comes out byte for byte as its shipped
  `dict-keeps-savedata.txt`, written in the same frozen fake millisecond, so no file counts as written; with a real
  clock D6 writes it (a probe; kawari7-wasm.md §7).
- **Everything else as in K3:** 0 entries back different; missed the 3 `sentence` entries (and BTH4th_last's
  `普通の食べ物` in the run 6 at a time); load-set 0; the stamp reload 20 of 20 (Kawari 7 9 of 9); the SAORI tally and
  the unsupported tags as in K1.

## Kawari run K5

With D6's close and unload running at the time the session ended (`sessionEndMs`, the ghost state's `savedAt`:
kawari-wasm.md §8 "At the session's end"; shiori-events.md §2.3.1). The sweep's D6 check boots the cold
engine a day later with the session's end as `sessionEndMs` (`kawariResumeCheck` in `tools/sweep/ghost.mjs`, `d6At` in
the report), so D6's files equal B's own close and unload only when its close and unload ran at the session's end. The
day starts at D6's restore, after the boot's first load: that load seeds Kawari's random numbers from the clock, and
B's seed makes both closes draw alike. Runs on the fixed clock over the same 320 archives [measured], 6 at a time:
`--engine kawari` with the site's `bthver.5` and `machimaki` (about 45 s), `--engine kawari7` with the site's `mayura`.
Counts only; the reports are not kept here.

- **Ran:** 20 of 20 Kawari, 9 of 9 Kawari 7; no engine crash, no runner failure.
- **D6 as in K4:** Kawari `ok` 16 of the 18 archives, `nothing to finish` 1 (norn_04.00), `no effect` 1 (somberlain),
  the site's bthver.5 and machimaki `ok`; Kawari 7 `ok` 7 (alto_beta2, gleto, haruka65, mayura_v350, nijino,
  teruno109, the site's mayura), `no effect` 2 (maria_re, sakura_r030103b). Every finished D6 has `d6At` = the
  session's end and `differ` empty.
- **Control** (the same runs with a scratch `--import` preload that passes `sessionEndMs: 0`, so the clock is the only
  difference): 13 Kawari D6 `failed`, their files differing from B's: Aria, BRH1.251, BTH4th_last, BTHver.5_2.732,
  bloody_moon, brynhild_conf1.13, firefox, kuro_r030114b, machi_1.0, toxic060816, umikoF and the site's bthver.5 and
  machimaki, each saving something of the time at its close or unload (the BTH family's `CoEndtime`, KEEPS' `endtime`,
  brynhild's session length in its reward); Kawari 7 none (no time in their saves).
- **A check that starts the day before the boot's first load** gives everything as above except brynhild_conf1.13
  `failed` on `dict-cr.txt` (its goodbye saves a reward with a random part, `number3`, and that load's seed comes a
  day after B's).
- **Everything else as in K4:** 0 entries back different; missed the 3 `sentence` entries; load-set 0; the stamp reload
  20 of 20 (Kawari 7 9 of 9).

## Satori and YAYA after the Kawari sweep

The sweep's own changes for Kawari (root engines share one path, a SAORI listed once per name, `slowest`, a new
engine after a mid-run close) must not move Satori or YAYA. Runs on the same tree [measured]: before = the old sweep
tools (a scratch copy importing the same `src/`), after = the new ones; then against the earlier runs.

- **Satori**, 247 of the 320 archives: ran / ok / crashed / fatal 247 / 247 / 0 / 0 and the SAORI tally (54 ghost ×
  DLL pairs) equal. Unknown tags 14 → 16, warnings 214 → 220 and request errors 86 → 88 (ghost × key pairs): each key
  that moved (BellandMell, draftyroom, unyutan, uu_du, Northern, ssuitcase, 5sai, SatoPaku, sake_kami) came and went
  as much in two runs of those ghosts alone (`--only`) with the old tools as in two with the new ones; PICKLES_34th's
  missing voice files follow its random talk. Against the earlier runs the counts are the same apart from the property
  system's changes (etherism's `calc` errors gone, properties counted).
- **YAYA**, 26: 24 load (raychel_kisekae and ure_c fail as before). Per ghost, the fields the engine adapter decides
  (load status, engine and module, stored and saved files, SAORI names, errors, load-time engine lines, boot statuses,
  the resume check and its stamp reload) differ in 0 fields over 26 ghosts. One engine-log key moved (ria's `REPLACE`
  warning, which every recent YAYA run has for one ghost or another). Against the earlier runs: emily4's
  configuration dialog left the unsupported tags, the property and Preferences box counts are new, and mobilemaster's
  resume lists one more variable only load makes (other work, as P2 noted).

## Kawari 7 run

The sweep runs `kawari7` ghosts on the Kawari 7.5.0 build (kawari7-wasm.md): `--engine kawari7` (in `all`), the
engine `NodeKawari7`, the page's call kinds passed to the engine as worker.js passes them, the resume check on
`_kawari7_dump` (`parseK7Dump`, adjacent literals joined as for Phase 8) and the snapshot key `RESUME_KEY7`, the site
update appended to `kawari.ini`, the file plan by `KAWARI7_TEXT`. The 8 Phase 7 archives [measured]: all 8 load
(458–2208 entries), play their first boot and their menu, close; no engine crash, runner error, Kawari log line or
runaway recursion; every snapshot entry comes back after a resume; the stamp reload works for all 8; D6 `ok` for
mayura (it saves in OnUnload), `no effect` for the 7 that save in OnClose (with D6's close: `ok` for 5
of them, run K4). Every TRANSLATE answers 400 (no ghost
defines `system.OnTranslate`): listed under SHIORI errors, the scripts play unchanged, as in ssp.exe. Per-ghost counts
are in kawari7-wasm.md §7. What the build and the sweep handle for them: `.kdf` / `.dat` dictionaries with their
bytes (as placeholders, maria_re and mayura load 0 and 2 entries), a second unload after the ghost's own `\-` (it
would use freed memory: patch C9), and adjacent literals joined when dumps are compared.

## The word variables

With `%ms %mz %ml %mc %mh %mt %me %mp %m? %dms` asking the ghost and SSP's word list (properties.md §2.4; the
sweep's loop reads `site/sumika/word_compatible.txt`), one `--engine all` run over the same sources (299 ghosts:
Satori 247, YAYA 26, Kawari 18, Kawari 7 8) [measured]: 297 ok, the 2 YAYA load failures as before, no engine crash or
runner failure. In 600 fake seconds per ghost only sakura_r030103b (Kawari 7) reached a word variable: `\m?` 204, then
`\m` 204, so the word came from SSP's list. No SHIORI error, warning or log line names a word request. Against the
Kawari 7 run before the change (8 ghosts) the outcome, errors and resume fields are the same apart from random-talk
noise (nijino one more "scope 0 has no surface", sakura_r030103b's menu pick). Probed directly on the site copies
with the real builds [measured]: emily4 and NodePsimoon (YAYA) answer every type but `\m?` and `\m` themselves,
Tsubasa (Satori) and bthver.5 (Kawari 8) answer 204 (SSP's list fills in). The per-request counts are in each ghost's
report (`requests`: `GET \ms 204` …).

## Tag names as ssp.exe knows them

With the tokenizer taking only the names ssp.exe 2.9.10 knows (sakurascript.md §3.2: any other `\X` drops its `\`,
an unknown `\_X` shows as written, an unknown `\__X` is swallowed; `\B \U \y \l \_i \_e \_c`, no `\URL`, `\w_`),
one `--engine all` run before and one after, each from a scratch copy of the tree, over the same 299 sources
[measured]: ran / ok / crashed 299 / 297 / 0 both times (the 2 YAYA load failures). The unsupported-tag list lost
exactly the five keys the change turns into text: nibihada's `\F`, `\k[0,0]`, `\L`, `\S` (its own gcore syntax; SSP
shows them as `F`, `k[0,0]` …) and PikuandNanika's `\_[500]` (shown as written, as in SSP). One key came
(draftyroom's `\![raiseplugin,スタンプ帳]`, a random talk). Script counts per ghost moved a lot (pit 19 → 226, touhou 175
→ 74, clear_sky_girl 64 → 31): 13 such ghosts run twice more before and twice after (`--only`), and clear_sky_girl
three times more each, swing as much on both sides (pit 21 / 225 before, 58 / 225 after; clear_sky_girl reaches its
double-click menu or not by where the visitor clicks, `（Ｒ３）（Ｒ４）つつかれ`), so they are random-talk noise.
nibihada and PikuandNanika log a little less (no unknown-tag line). What Kawari hands the player was checked on the
real build with test words [measured]: `\s\[3]`, `\k[1]`, `\_h` and `\わ` pass through unchanged, so
machimaki's `\0\s\[3]お別れ` (`ghost-keeps.kis:455`) shows `s[3]お別れ`, as in ssp.exe.

## A minimized or locked ghost's close

`EventLoop.close` follows ssp.exe's `CloseGhostProc` for a ghost that is minimized, minimizing, in passive or
induction mode or inside `\t` (shiori-events.md §2.3): OnCloseAll / OnClose are sent, but neither OnTranslate nor the
goodbye follows, and the ghost closes at once. The walk's own close (`loop.close(0)` after `player.interrupt()`,
`tools/sweep/ghost.mjs`) takes that path for a ghost its run left in passive or induction mode (or minimized), so a
run from a tree whose close did not take it may differ there in OnTranslate counts, unknown tags and warnings that came
only from the goodbye [infer; no sweep has been run on this path]. When comparing, run such a ghost alone (`--only`) on
both trees.

## A fixed clock

On the real clock, two sweeps made at different times of the same day differ in Satori's time signals and its
hour-dependent talk: Satori reads the real clock (YAYA and Kawari follow the fake one, from the real time of day on),
and every engine takes its random seed from it. So the sweep runs on one fixed local time by default ("The clock"
above); `--clock real` runs on the real clock. Test runs [measured] over 16 ghosts: the
site's tsubasa, katari, nato (Satori), bonsyou (YAYA), bthver.5 (Kawari) and mayura (Kawari 7), and 10 Satori archives
whose dictionaries read the hour (`（現在時）`, `＊OnMinuteChange`, 時報): anomy, bukimi, konoha, kanade_2nd, botan,
draftyroom, yagi_the_twins080602, Ltoto2, mikaru140920, hitomaro. About 1.5 minutes a run, 6 at a time:

```bash
node tools/sweep.mjs site/ghost <archive folder> \
  --only "^(tsubasa|katari|nato|bonsyou|bthver\.5|mayura|(anomy|bukimi|konoha|kanade_2nd|botan|draftyroom|yagi_the_twins080602|ltoto2|mikaru140920|hitomaro)\.nar)$" \
  --out <scratch dir>
```

The anchors keep the site ghosts' own archives (`Katari.nar`, `tsubasa.zip` …) out: their reports would share a file
name with the site copies' (`Katari.json` and `katari.json` are one file on Windows). Reports compared field by field,
wall times left out:

- **Fixed, twice** (F1, F2): 16 of 16 ran and finished; 15 of 16 reports identical.
- **Fixed, with the process's own clock moved** to 2026-10-16 03:30 (F3: `tests/fake_time.mjs` through
  `NODE_OPTIONS=--import=…`, as a run made on another day at another hour): 15 of 16 identical with F1, 14 with F2.
  Of the moved clock only the run's date shows (`summary.json`'s `date`, `summary.md`'s title).
- **`--clock real`**, twice back to back (R1, R2) and once moved like F3 (R3): 1 of 16 reports identical between R1 and
  R2, 2 between R1 and R3; scripts, characters, choices, request counts and the Kawari snapshot's size move in 13 to 15
  ghosts.
- **What still differs between fixed runs, and why:**
  - The page side's random picks (`Math.random`, not the clock, as ssp.exe picks at random): a surface alias, SERIKO's
    random animations, `%et` / `%wronghour`, a word from SSP's list, `\![change,…,random]`, a random call target. In
    these runs only aliases did: bukimi (F2: its goodbye talk, so its tag counts and characters; `\1`'s `\s[51]` shows
    51 or 5100) and bthver.5 (F3: 29 scripts instead of 34; `\0` shows 127, 147 or 182, and the touch phase then
    strokes other collision areas). Each was run alone with every raw SHIORI request logged (bukimi 4 times, bthver.5
    6 times, 4 on the machine's clock and 2 moved): both outcomes come with and without the moved clock, the first
    request that differs is always the OnSurfaceChange after the pick, and up to it the engines answered alike.
  - Wall times, by design: `wallMs`, `slowest` / `slow` (so also which request is the slowest), `engineTiming` (the
    Kawari table's load ms), the saves', the resume's and D6's ms, `summary.json`'s `date`. They move with the
    machine's load. A root engine's files are stamped at the mount, and while the fixed clock stands on that ms
    SspRootShiori counts every one as just written (`_hot`: stamp >= now) and hashes the whole root at each request,
    so the boot phase's requests of a large YAYA or Kawari ghost would take 4–10 times as long (bthver.5's slowest
    267–277 ms against 39–45 ms on the real clock). So `SweepClock.stepPastMount()` moves the fixed clock 1 ms past
    every mount, after the first report's scan [measured: bthver.5's slowest 11–13 ms].
  - Not seen here, possible in a full sweep: an engine's draw from `/dev/urandom` (Emscripten's `getRandomValues`),
    and the order of the page side's asynchronous work (image loads) against the fake clock on a loaded machine (the
    "ghost slower inside the full sweep" above).
- **Fixed against real** (the modes, not the runs): the root engines' stored files, resume check and D6 outcome were
  the same for bonsyou, bthver.5 and mayura in F1 and R1–R3. With the first load frozen too, a file that load rewrites
  with the bytes it shipped with, in the frozen millisecond, does not count as written (as sakura_r030103b's D6 save
  in run K4) [infer: none of the 16 showed it].

## Reloads

`\![reload,shiori|shell|balloon|ghost]` and `\![reloadsurface]` work (shiori-events.md §2.10). The sweep
follows the runtime: a root engine's `\![reload,shiori]` unloads it (its files kept) and loads a new one from them while
the loop's requests wait (`InProcessShiori.gate`; counted per ghost as `reloads`, not as `restarts`); a Satori ghost's
stays a no-op (no corpus Satori ghost has one); `\![reload,shell|balloon]` go through `viewSwitcher` with the shell or
balloon in use (`changes` entries with `reload: true`); `\![reload,ghost]` emits the loop's ghost change, which the sweep
does not follow (as `\![change,ghost]`). The tag tally keys `\![reload,X]` with its sub-command.

Before and after [measured, fixed clock], the 11 archives that use a reload (bee, cyau_cyaka, flele, maya, mobilemaster,
raychel_kisekae, ria, Aria, firefox, kuruka, PikuandNanika); "before" is the same tree with `EventLoop.prototype.reload`
deleted through `NODE_OPTIONS=--import=…` (every reload an unknown tag):

```bash
node tools/sweep.mjs <archive folder> \
  --only "^(bee|cyau_cyaka|flele|maya|mobilemaster|raychel_kisekae|ria|aria|firefox|kuruka|pikuandnanika)\." --out <scratch dir>
```

- 10 of 11 ran and finished both times (raychel_kisekae fails to load on Tc606 in both); nothing crashed; the request
  errors are the same (kuruka's 2).
- The walk reaches `\![reload,shiori]` in 3 ghosts (bee, mobilemaster, ria): "3 × `\![reload,shiori]`" left the unknown
  tags; each reloaded once (`reloads` 1): OnDestroy, GET version, OnInitialize and the rest of the batch twice instead of
  once, and the script went on (bee's 「リロードしました。」 played).
- Moved with it, not noise of the harness: bee's close then logs YAYA's `W0019 … RAND` (its diary picks from `dialyexp`,
  which its own OnSystemUnload erases and OnSystemLoad empties, so after a reload it is empty, as in SSP [infer]);
  ria's walk after the reload draws other talks (30 → 29 scripts; YAYA reseeds MT19937 at the load); mobilemaster's
  resume check lists one fewer "variable only load made" (`半分メニュー無効` was saved at the reload's unload).
- A ghost that reloads repeats run to run: `SweepClock.advance` waits while `InProcessShiori.gate` is set, as a page's
  time would bring no tick to an engine that answers nothing [measured: two runs of bee and ria identical apart from
  wall times]. With the fake clock going on while the new engine loads in real time, the seconds that pass at the tag
  would vary (a second run gave ria 28 scripts instead of 29, bee and ria other OnSecondChange / OnBalloonTimeout /
  OnEasyBalloon counts).
- Everything else equal, wall times aside. The walk reaches no `\![reload,ghost]`, `\![reload,shell|balloon]` or
  `\![reloadsurface]` (they sit behind menu items it does not pick, or kuruka's character switch).

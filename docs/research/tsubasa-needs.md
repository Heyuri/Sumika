# Tsubasa's requirements for the runtime (P0 checklist)

This is an inventory of everything the ghost **Tsubasa** (となりの羽山さん, English translation) asks of the runtime:
the SAORI DLLs she declares, the script commands she emits, the files she touches, the events she handles, her
dress-up, dictionary-folder and game mechanics, and her time and network features. It ends with a prioritised
checklist (§12) and open questions (§13).

Other research documents already specify the generic parts. This document cites them and does not repeat them:

* `docs/research/sakurascript.md`: tag grammar and the corpus tag counts (§1.2–1.4 there).
* `docs/research/shiori-events.md`: wire protocol, boot and resume sequences, mouse and key References, dress-up events.
* `docs/research/ssp-ui.md`: menus, placement, balloons, input boxes, scheduling.

## 0. Conventions

**Priorities**

* **P0**: Tsubasa needs it.
* **P1**: common in other ghosts, or a Tsubasa feature she can run without.
* **P2**: rare, or impossible in a browser.

**Source marks**

| Mark | Source |
|---|---|
| `[T file:line]` | Tsubasa dictionary, relative to `site/ghost/tsubasa/ghost/master/`. `bath/`, `date/` and `meal/` are the sub-folders. Line numbers match the UTF-8 copies in `docs/research/scratch/needs/dic/` (only CR was stripped). |
| `[SH file]` | Tsubasa shell, `site/ghost/tsubasa/shell/master/` |
| `[C]` | Real-satori.dll corpus `final_{master,bath,date,meal}.res.txt`: 7 334 `VALUE` scripts (master 4 884, bath 435, date 1 400, meal 615). Counted by `docs/research/scratch/needs/{bang,bimg,games}.py`. |
| `[S file func]` | Satori source in `vendor/satoriya-shiori/satoriya/satori/` (read through the UTF-8 copies in `docs/research/scratch/satori-u8/`) |
| `[U page]` | UKADOC, `https://ssp.shillest.net/ukadoc/manual/<page>` |
| `[HT]` | `vendor/satoriya-shiori/satoriya/httpc/httpc.txt` (the httpc.dll manual) |
| `[DS]` | dsaudio manual and change log, `http://www5f.biglobe.ne.jp/~nobml/sakura/dsaudio1.html` |
| `[DLL]` | Strings extracted from the shipped DLLs in her `ghost/master/saori/` |
| `[Y]` | YAYA manual, `https://yaya-shiori.github.io/yaya-docs/functions/GETSTRBYTES/` |

Not in the repository: Tsubasa's files (`site/ghost/tsubasa/`: CLAUDE.md "The ghosts Sumika was tested with"), the
corpus (`tests/corpus/`) and the copies and scripts in `docs/research/scratch/`. These are development material, cited
as the sources (CLAUDE.md "Project rules").

**Words used throughout**

* A **raise** is the runtime sending a SHIORI event because a script tag (`\![raise]`, `\![timerraise]`) asked for it.
* **Stand-in** means a JavaScript SAORI implementation that runs in the engine worker.

**Corpus caveat (important for engine tests).** The harness ghost folder contained only `saori/ssu.dll` and
`saori/yaya.txt`. dsaudio, gomi, httpc, fill_desktop and yaya.dll were absent, so every **direct** call to them came
back as **literal text**:

* `（dsaudio,volume,1000）` appears in ボリュームアップ, ボリュームアップ上限, ボリュームダウン, ボリュームダウン下限 and `hwnd`, in all 4 folders.
* `（aya（b1）GETSTRBYTES…` appears in 再生リスト表示０１.

`sync` calls appear as `\![raise,OnDirectSaoriCall,…]` because they are only executed later [C]. Engine tests that run
with the stand-ins enabled must expect different output for these talks.

---

## 1. Most important findings

1. **Every declared SAORI must be registered with a stand-in, or its text leaks into the balloon.** When Satori
   cannot load a plugin DLL, it does not register the call name. A later `（dsaudio,stop）` then fails name resolution
   and stays as literal text in the script [S shiori_plugin.cpp `load_a_plugin`; S satori_Kakko.cpp `CallReal` "not
   found"; C caveat above]. There are 5 DLL paths and 6 call names (§3.2).
2. **The stand-in's `GET Version` reply must contain `Charset: UTF-8`.** Without it, Satori falls back to Shift_JIS
   for that SAORI and sends it a dummy EXECUTE [S shiori_plugin.cpp `load_a_plugin`].
3. **`ssu` needs nothing from the runtime.** Satori has it built in when `saori/ssu.dll` is missing (`mIsInternal`),
   and `makefile.emscripten` already links `ssu.o` [S shiori_plugin.cpp; makefile.emscripten].
4. **Dictionary-folder switching happens inside the engine.** Assigning `＄辞書フォルダ` (any value) sets
   `reload_flag`. After the response is built, Satori unloads (which saves), then loads again from
   `<ghost>/<folder>/dic*.txt` [S satori_builtin.cpp `sysvar_dic_folder`; S satori_AnalyzeRequest.cpp; S
   satori_load_unload.cpp `LoadDicFolder`]. The runtime must:
   * put **all four** dictionary folders in the virtual file system;
   * tolerate a request that takes seconds;
   * re-persist the save data afterwards;
   * accept SAORI unload/load (the music stops).

   Meal mode is reachable on day 1: press `b`, or say "tea", and she switches to `meal` [T dic05_Communicate.txt:1154, 1165].
   So this is **P0**.
5. **Satori's `sync` is used 801 times in the corpus** (765 `set`, 32 `fill_desktop`, 4 `gomi`). Each one arrives as
   `\![raise,OnDirectSaoriCall,fn,args…]`. The raise must be sent with `SecurityLevel: local`, or Satori ignores it
   [S satori_CreateResponce.cpp]. **P0.**
6. **`OnNotifyDressupInfo` must list references scope-major, then by ascending bind-group id, with an empty
   thumbnail field.** Tsubasa walks the References in order. She stops at the first category she does not track
   (`テーブル`, id 1000), and she decides on/off from the last character of each reference [T
   dic16_Dressup.txt:4062]. Group ids are not in file order, and `char99`'s group sits between sakura groups in the
   file [SH descript.txt].
7. **`OnDressupChanged` must send the "off" change before the "on" change.** Her handler clears every flag of the
   category and then sets the flag named by R1, whatever R2 says [T dic16_Dressup.txt:834ff].
8. **Mouse dispatch rules**
   * Main menu: double-click on Tsubasa where no collision is, which gives `＊0つつかれ` [T dic03_Menu.txt:8, 1115].
     The `m` key and the one-touch menu also open it.
   * One-touch menu: **single** click on scope 99 [T dic14_Mouse.txt:2961, dic03_Menu.txt:570].
   * Closing: hold `Mclose` for more than 1 s (OnMouseDown, then OnMouseUp) [T dic14_Mouse.txt:2947].
   * Wheel: R2 must be a full notch, |R2| > 115 [T dic13_Game.txt:7341].
   * Petting: Satori's default, 60 `OnMouseMove` events within 2 s [S satori_load_dict.h].
9. **OnKeyPress R2 has to count auto-repeats, and the evidence favours base 1.**
   * The UFO catcher moves at R2 = 1, 3, 6, 9, … while → is held [T date/dic13_Game.txt:946].
   * Every shortcut is guarded with `（Ｒ２）<2` [T dic02_Event.txt:809].

   Both read most naturally as "first press = 1". This contradicts the base-0 ASSUMPTION in shiori-events.md §4.6.
   See Q1.
10. **There are no sound files.** Tsubasa ships no audio and never uses `\_v`, `\8[…]` or `\![sound]` [C, T]. Audio
    exists only in the dsaudio **music box**, which plays files the user drags onto her [T dic11_etc.txt:7–240].
11. **The network features are dead or emulated.**
    * Weather: `httpc` scrapes `weather.livedoor.com`, which is defunct. The stand-in returns empty, which gives her
      built-in "Failed to retrieve the weather data" [T dic11_etc.txt:1436].
    * Updates: `\![updatebymyself]` is disguised as "Help with Homework" in the main menu. Emulate an update that finds
      nothing ("none") [T dic03_Menu.txt:36, dic02_Event.txt:152ff].

---

## 2. The ghost at a glance

| Item | Value | Source |
|---|---|---|
| SHIORI | `satori.dll` (Satori, Shift_JIS dictionaries) | [T descript.txt] |
| Dictionaries | master 2.50 MB, bath 0.19 MB, date 0.59 MB, meal 0.24 MB (Shift_JIS bytes of `dic*.txt`). Satori loads **one** folder at a time. | measured |
| Always read from the ghost root | `satori_conf.txt` (variable defaults and SAORI list), `replace.txt`, `replace_after.txt`, `satori_savedata.txt` (+ backup). `satori_bootconf.txt` and `characters.ini` are absent, so their defaults apply. | [S satori_load_unload.cpp `load`] |
| `＊` entries | 7 688 names over the four folders. 105 start with `On`. | [shiori-events.md §6] |
| Balloon | `LightBlue`, shipped inside the ghost folder (`install.txt`: `balloon.directory,LightBlue`) | [T ../../install.txt] |
| Shell | 923 PNG, 756 PNA, `surfaces.txt`…`surfaces4.txt`, 230 sakura bind groups (21 categories), 3 655 bind groups on extra scopes, 80 `sakura.menuitem` entries | [SH] |
| Scopes used | 0 (Tsubasa) and 1 (the **music box**: surface 10 is 4×4 and effectively invisible, 11 is the box, 12 is the box playing, an animation with no base PNG). Extra scopes, from \p[n] counts in the 4 corpus files: 99 one-touch menu (in nearly every master/bath/meal script, through surface restore of `デフォルトサーフェス99`), 100 picture-logic board, 101/22 Setsubun, 27 Tanabata, 19 Christmas tree, 18 moon, 96 collection shelf, 23 Ukajan; date mode adds 2–5, 9–17, 20–26, 95, 97, 98. | [C], [SH surfaces.txt] |
| SAORI folder | `saori/yaya.txt`, `ayasaori.aym`, `builtins.aym` (the YAYA-as-SAORI scripts). The DLLs are not deployed. | [T saori/] |

---

## 3. SAORI: declarations, call sites, and stand-in contracts

### 3.1 How Satori talks to a SAORI (P0, applies to every stand-in)

* **Registration.** `＠SAORI` lines have the form `name,path[,predefined args…]`. Satori resolves `path` against the
  ghost root. Rules:
  * `…/ssu.dll` becomes the internal ssu, even when the file is missing.
  * Any other path must exist (POSIX build: `fopen`), or the line is skipped with an error.
  * Each path is loaded once and reference-counted, so `fill_desktop` and `fill_red` share one instance.

  [S shiori_plugin.cpp `load_a_plugin`] Sumika's patch routes these loads to `js_saori_load(path, dir)` (an EM_JS
  function of patch P2 in `engines/satori/patches.py`; the stand-ins answer in `src/worker/saori/`).
* **Version handshake.** After loading, Satori sends `GET Version SAORI/1.0` with `Sender: SATORI`, `Charset: UTF-8`
  and `SecurityLevel: Local`.
  * The reply's protocol must be `SAORI/1.0`.
  * The reply must include `Charset: UTF-8`, or Satori switches that SAORI to Shift_JIS and sends one dummy EXECUTE.

  [S shiori_plugin.cpp; S SakuraDLLClient.cpp `get_version`]

  ```
  stand-in reply to GET Version:  "SAORI/1.0 200 OK\r\nCharset: UTF-8\r\n\r\n"
  ```
* **EXECUTE request.** `EXECUTE SAORI/1.0`, then `Charset`, `Sender: SATORI`, `SecurityLevel: Local|External`, and
  `Argument0…n` [S SaoriClient.cpp `request`]. Predefined arguments from the declaration come first. Example:
  `fill_red` is called as `Argument0=255, Argument1=0, Argument2=0, …`.
* **Arguments are pre-processed by Satori.**
  * Arguments are split at `,` `、` `､` `，` and `\x01`. Tsubasa also writes `（b1）` = `\x01` as the separator, and
    adds `\x02` as an extra one with `＄引数区切り追加` [S satori_load_dict.h; T dic11_etc.txt:8, 1399].
  * An argument that starts with a digit, `+` or `-` is first evaluated as an arithmetic expression (SACM_AUTO)
    [S satori_builtin.cpp].
* **Reply.** Status `200`/`204`. `Result:` becomes the call's value. `Value0…n` become `（Ｓ０）…` **only when at least
  one Value header is present**; otherwise the previous S-values are kept [S SaoriClient.cpp: "Valueヘッダが存在しない
  ときは…上書きしないこと"]. dsaudio relies on this (§3.4).
* **`sync`.** `（sync,f,args）` does not call anything at expansion time. It emits
  `\![raise,OnDirectSaoriCall,f,args]` into the script [S satori_builtin.cpp `func_sync`]. When the runtime raises
  it, Satori calls `f` and returns 204, but only if the request was `SecurityLevel: local` (`secure_flag`) [S
  satori_CreateResponce.cpp].
* **Reload.** Satori's `unload()` saves and then calls `ShioriPlugins::unload()`, which unloads every SAORI;
  `load()` loads them again [S satori_load_unload.cpp]. This happens at every `＄辞書フォルダ` change and every
  `＄辞書リロード 実行` (the `r` key [T dic02_Event.txt:911]). A stand-in's `unload` must therefore release state:
  **dsaudio stops playback**, which matches Tsubasa marking the music as stopped on `r` (`＊音楽再生中リロード`).

### 3.2 Declarations ([T satori_conf.txt:303–336])

| Call name | Path | Predefined args | Used? | Stand-in | P |
|---|---|---|---|---|---|
| `fill_desktop` | `saori/fill_desktop.dll` | – | 8 sync calls, all in ＊サンダー | §3.6 | P0 to register; effect P2 |
| `fill_red` | `saori/fill_desktop.dll` | `255,0,0` | **never called** | same instance | P0 to register |
| `calc`, `calc_float`, `if`, `unless`, `nswitch`, `switch`, `substr`, `split`, `replace`, `replace_first`, `erase`, `erase_first`, `count`, `compare`, `compare_head`, `compare_tail`, `length`, `zen2han`, `han2zen`, `hira2kata`, `kata2hira`, `sprintf`, `iflist`, `is_empty`, `is_digit`, `is_alpha`, `reverse` | `saori/ssu.dll` | the function name | heavily | **internal ssu, nothing to do** | – |
| `dsaudio` | `saori/dsaudio.dll` | – | music box | §3.4 | P0 to register; audio P1 |
| `gomi` | `saori/gomi.dll` | – | Recycle Bin cleaning | §3.5 | P0 stub |
| `httpc` | `saori/httpc.dll` | – | weather | §3.7 | P0 stub |
| `aya` | `saori/yaya.dll` | – | `GETSTRBYTES` only | §3.8 | P0 stub (trivial) |

Notes on ssu. Satori's internal ssu `compare` is **case-insensitive** after zen→han conversion; `compare_case` is the
case-sensitive variant [S ssu.cpp `_compare`]. So `（compare,（Ｒ０）,Back）` also matches `back`. Satori **talk
names** are still case-sensitive, so `＊backが押された` needs R0 = `back`.

### 3.3 Call-site inventory (dictionaries, all folders)

| Call | Sites | Example | Where |
|---|---:|---|---|
| `（dsaudio,load,（再生中曲パス））` | 12 | inside `（nop,…）` chains | ＊通常再生, ＊通常再生リスト中, ＊ループ再生 [T dic11_etc.txt:707, 718, 729] |
| `（dsaudio,stop）` | 20 | | same, plus ＊停止 and ＊オルゴールをしまう (891, 899) |
| `（dsaudio,loop,enable｜disable）` | 4 / 8 | | |
| `（dsaudio,volume,（音楽ボリューム））` | 28 | value `0`…`10000`, step 1000, **may be empty** | ＊ボリュームアップ (851), etc. |
| `（dsaudio,play）` / `（dsaudio,pause）` | 16 / 4 | | ＊一時停止／再開 (882) |
| `（dsaudio,hwnd,（Ｒ０））` | 4 | R0 of `NOTIFY hwnd` | ＊hwnd (928) |
| `（gomi,-n）` | 4 | | ＊ゴミ箱を空にする, ＊ゴミ捨て中 [T dic11_etc.txt:1296–1358] |
| `（sync,gomi,-asfq）` | 5 | | ＊ゴミ箱少量/普通/多量 (1345–1376) |
| `（sync,fill_desktop,R,G,B）` / `（sync,fill_desktop）` | 8 | `255,255,240` / `255,255,0` | ＊サンダー (963) |
| `（httpc（b1）erase_tag（b1）URL（b1）start（b1）end）` | 8 | start `今日の天気 - `, end `天気概況` | dic02_Event.txt:985, 1180, 1301; dic07_Time.txt:132; dic11_etc.txt:1437, 2065, 2108, 2178 |
| `（aya（b1）GETSTRBYTES（b1）a…a）` | 6 | | dic11_etc.txt:295, 301, 346, 750, 754, 760 |

Each sub-folder has its own copy of `dic11_etc.txt` (music box, wallpaper, weather, Recycle Bin), so these calls work
in every mode.

### 3.4 `dsaudio` — the music box (register P0; real audio P1)

**What it is.** dsaudio is a DirectShow audio-player SAORI [DS]. Tsubasa's scope 1 (kero) is a music box.

**Where the music comes from.** The user **drags audio files onto the ghost**. `OnFileDrop2` R0 holds the path, or
several paths joined with `\x01` [U list_shiori_event OnFileDrop2]. She accepts these extensions:
`mp3 MP3 wav WAV wave WAVE mid MID midi MIDI ogg OGG wma WMA au AU` [T dic11_etc.txt:29–44]. Image extensions start the
wallpaper flow instead (§4). Each dropped file is then handled like this:

1. She derives a display name. She splits the path at `\` and takes the last segment, strips the extension with
   `reverse` and `split` at `.`, and swaps some punctuation [T dic11_etc.txt:84–99].
2. She offers "Play Normally / Play on Loop / Add to Playlist".
3. The playlist is saved in her save data as `＄リスト曲数`, `＄リスト曲名N` and `＄リスト曲パスN` (the full path)
   [T dic11_etc.txt:100–103, 219].

**No music file ships with the ghost.**

**Commands she uses** (from [DS], with the behaviour she relies on):

| Argument0 | Args | Stand-in behaviour | Reply |
|---|---|---|---|
| `load` | path (absolute, as given in OnFileDrop2) | Resolve the path to a stored Blob (see "Storage" below) and create an `Audio` element. Read ID3/Vorbis tags if cheap (P2). | `Result: 1`/`0`. **`Value0` = title, `Value1` = artist, `Value2` = album** when known ([DS] says load returns tag metadata). She stores `（Ｓ０）…（Ｓ２）` after the whole `nop` chain as 再生中詳細曲名/アーティスト名/アルバム名 [T dic11_etc.txt:708–711]. **The later calls must not send Value headers**, or they overwrite S0–S2 (§3.1). |
| `stop` | – | Pause and rewind. Does **not** fire OnDSAPlayFinish [DS]. | 200, no Value |
| `play` | – | Start, or resume after `pause` [DS]. | 200, no Value |
| `pause` | – | Pause [DS, no longer a toggle since Ver1.1]. | 200, no Value |
| `loop` | `enable`/`disable` | `audio.loop = …` | 200 |
| `volume` | `0…10000`, or **empty** | Empty argument = query: return `Result: <current>` and change nothing [DS: omitting Argument1 returns the current value]. Otherwise `audio.volume = v/10000` (linear; dsaudio's own curve is unknown, Q4). | 200 |
| `hwnd` | handle list | Ignore. | 200 |

**Events.**
* When the media element fires `ended` while loop is off, the stand-in posts `{t:'saori', name:'dsaudio', cmd:'finish'}`
  to the main thread.
* The runtime then raises **`GET OnDSAPlayFinish`** (no References) as a script event. Her handler moves to the next
  or a random playlist song, or says "Playback finished." [T dic11_etc.txt:735–745].
* She warns users that a song ending during a game interrupts it [T dic03_Menu.txt:1110]. So it is correct for this
  script to replace a running one.

**Storage (P1).** Implemented in `src/core/drops.js` (generic: every ghost, not only Tsubasa).
* Dropped `File`s must outlive the page, because her playlist holds paths.
* Pseudo-path: `C:\sumika\drop\<8 hex>\<file name>`. The 8 hex digits are an FNV-1a hash of name, size and
  lastModified, so the same file always gets the same path. The name loses characters that Windows forbids and control
  characters (`\x01` separates R0 paths); backslashes and the extension stay, because her name parsing depends on both.
* The drop handler (`src/shell/character.js`) takes only drags that carry files over an opaque pixel of a character,
  and only while something receives them (`stage.acceptsDrops`). A drop after an accepted `dragover` is taken even if
  the surface changed under it, so the browser never opens the file in place of the page. Folders are left out. There
  is no `OnFileDropping`: the browser hides file names until the drop.
* A drop while the engine still loads, or on a frozen tab's ghost (another tab has her), is held by the runtime and
  sent once she has booted (at most 30 s later [guess]). On a frozen tab the drop also takes the ghost over, since a
  drag from the desktop does not focus the window.
* IndexedDB `sumika` / `kv` (version 1, shared with the worker): `drop:<lower-cased path>` holds
  `{blob, path, name, type, size, lastModified}`; `drop:index` holds sizes and last use for the caps.
  * Only audio the browser can play is stored (`playable`: `audio/*` and `canPlayType`), and MIDI
    files by their name where the MIDI player runs (`playable(type, name)`, midi.md §6.5). Images, documents, WMA, and
    MIDI where the player cannot run, work on this page only, because nothing could use a stored copy (privacy).
  * A file over 64 MB is not stored, nor one that would leave less than max(32 MB, 10 %) of the origin's quota free
    (`navigator.storage.estimate`), because the engine's save data shares that quota.
  * Beyond 256 MB in total, the least recently used files go, after the new file is written. The index entry is written
    before the file, so a failed write only over-counts. One tab at a time updates the index (Web Lock
    `sumika/drops`). The first update of a page reconciles the index with the stored `drop:` keys.
  * Without IndexedDB, or when the browser refuses a write, a file plays on this page only. Nothing is uploaded.
  * `DropStore.clear()` forgets them all; no menu item calls it yet. Clearing the site's data removes them too. A
    "forget dropped files" item would be a non-SSP addition, so there is none [decision].
* On `load` the page resolves the path to an object URL, asynchronously; the `stop`/`loop`/`volume`/`play` calls that
  follow wait for it, in order (at most 10 s, then the file counts as missing). `\_v` and `\![sound]` take these paths
  too. A new `load` pauses and unloads the previous element: removing `src` alone leaves it playing. Warnings name a
  dropped file only by its 8 hex digits and extension.
* If the Blob is missing (storage cleared), nothing plays. She has no special failure talk. The worker stand-in
  cannot see the store, so it still answers `load` with `Result: 1`.
* Satori splits `（dsaudio,load,（再生中曲パス））` at commas, so a file name with a comma arrives as several arguments.
  The stand-in joins them with `,` again (dsaudio's `load` takes one path).

**Formats.** mp3, wav, ogg and au play natively (ogg is weak on Safari). MIDI plays on Sumika's own
synth (spessasynth_core and GeneralUser GS, `docs/research/midi.md`), where the page is a secure context with
AudioWorklet; elsewhere, and for WMA, the stand-in's `load` still says `Result: 1`, and nothing plays.

**Page navigation.**
* Audio stops when the page unloads, while Satori still says `音楽再生中変数=1` and surface 12.
* Implemented: the ghost state (`state.music`) keeps `{path, currentTime, loop, volume, playing}`. On a resume the
  page loads the track again, seeks and plays. A cold boot drops it, because after a real restart SSP's music has
  stopped too; so does Close. A save while a dropped file is still opening records what the commands queued behind
  the load will do, so a quick second navigation still plays.
* Browsers block autoplay without a user gesture. If `play()` rejects, retry on the page's next gesture: one of the
  HTML spec's activation events, a mouse's `pointerdown`, a touch's or pen's `pointerup`, `touchend`, `keydown`
  (CLAUDE.md "Browsers": a touch's `pointerdown` grants no activation by the spec and in Chrome, so the retry
  waits for the finger's lift; at the press it would fail again on phones; WebKit [verify]). A mouse: at its
  `pointerdown`. (`page-saori.js` `afterGesture`, `activates`.)

**Browser feasibility.** Full (HTMLAudioElement).

### 3.5 `gomi` — Recycle Bin (P0 stub)

**What the DLL does** [DLL strings]:
* `getopt` string `enVafqsvw:`, long options `asynchronous force quiet silent verbose hwnd`.
* It calls `SHQueryRecycleBinA` and `SHEmptyRecycleBinA`.
* When an asynchronous empty finishes, it sends `NOTIFY SSTP/1.1` with `Sender: Gomi`, `Event: OnRecycleBinEmptied`
  and `Reference0: %s`.
* The UKADOC-standard event is `OnRecycleBinEmpty` [U list_shiori_event]; `OnRecycleBinEmptied` is specific to gomi.

**How Tsubasa uses it** [T dic11_etc.txt:1295–1390]:
* `（gomi,-n）` gives the item count; `（Ｓ０）` gives the total bytes.
* Her thresholds: 0 means empty; under 5 items and 5 MB is "a little"; over 50 items or 100 MB is "a lot".
* `（sync,gomi,-asfq）` empties the bin asynchronously, silently, forced and quietly. She then polls with
  `＄ゴミ捨て中タイマ` and waits for `OnRecycleBinEmptied` (R0 = 0 means failure).

**Stand-in.**
* `-n`: reply `Result: 0`, `Value0: 0`. She then says "Huh? There's no trash…" (＊ゴミ箱空) and never reaches `-asfq`.
* Anything else: 200, no-op.
* Never raise `OnRecycleBinEmptied`.

**Browser feasibility.** Impossible; a browser has no Recycle Bin. The stub is honest.

### 3.6 `fill_desktop` / `fill_red` — screen flash (register P0, effect P2)

* **Use.** Only ＊サンダー [T dic11_etc.txt:963] uses it: a lightning gag in reply to the third-party event
  `OnHitThunder`, which a browser never receives. In-script `sync` calls fill the desktop with a colour, and a call
  with no arguments restores it.
* **Stand-in.** Post `{t:'saori', name:'fill_desktop', cmd:'fill', rgb}` or `{cmd:'clear'}`. The main thread shows or
  removes a full-viewport `position:fixed` overlay with `pointer-events:none`, below the characters (P2). Reply 200.
* **`fill_red`** (predefined `255,0,0`) is never called.

### 3.7 `httpc` — HTTP scraper used for weather (P0 stub)

**Semantics** [HT]:

| Arguments | Behaviour |
|---|---|
| none | Connectivity check. |
| 1 (URL) | Body text. |
| 2 | Download to a file. |
| 3 (URL, start, end) | Every substring between the markers, as `Result` plus `Value0…`. |

* Option words such as `erase_tag`, `euc`, `utf-8` may come before the URL. `erase_tag` strips HTML tags before
  matching.
* `bg,<id>` makes the call asynchronous; the result then arrives later as `OnHttpcNotify`.
* Line breaks are removed from the result.
* The call is synchronous: SSP blocks while it downloads.

**How Tsubasa uses it.**
* Only for weather. The URLs are `http://weather.livedoor.com/area/forecast/<code>` for 141 Japanese stations [T
  dic11_etc.txt:2522ff], plus remote images `http://weather.livedoor.com/img/icon/….gif` [T dic11_etc.txt:1739, 1746].
* **Livedoor Weather was shut down**, so the call cannot work even with CORS.
* She treats an empty result as failure: `＞天気予報判別 （変数「天気情報」の存在）`, otherwise "Huh, it's not
  working… ※Failed to retrieve the weather data." [T dic11_etc.txt:1437–1441].
* An empty assignment removes the variable, so the existence check fails. This is the same mechanism she uses to clear
  `スタンプ帳動作` [T dic11_etc.txt:985]. The exact Satori rule was not read in the source: ASSUMPTION, consistent with
  the corpus.

**Stand-in.** Reply 200 with an empty `Result` and no Values. The no-argument connectivity check should return `0`.

**Triggers.**
* Menu "Weather Forecast", the `f` key, the one-touch `Mweather` button.
* A boot-time forecast, controlled by `＄起動時天気予報設定`. **Its default is `OFF`** [T satori_conf.txt].
* The 7 pm hourly chime when `時報中` is set.

**P2 option.** A modern adapter that sends the same marker-delimited text from another API. Not worth it.

### 3.8 `aya` → `yaya.dll`: only `GETSTRBYTES` (P0 stub)

* **Use.** `（aya（b1）GETSTRBYTES（b1）a<text>a）` minus 2 measures how wide a song title is (wrapping it in `a…a`
  keeps leading and trailing spaces). The music menu and the playlist use it to cut titles to about 35 "bytes" and add
  `…` [T dic11_etc.txt:295–301, 346, 750–760].
* **Real implementation.** `saori/yaya.txt` loads `ayasaori.aym` (a SAORI-protocol wrapper) and `builtins.aym`, which
  exposes YAYA built-ins by name. `getstrbytes` with one argument calls `GETSTRBYTES(str)` with charset code 0 [T
  saori/builtins.aym; Y]. Code 0 is Shift_JIS in YAYA's numbering (believed; not verified on the charset page).
* **Stand-in.** When Argument0 equals `GETSTRBYTES`, ignoring case, reply `Result: <Shift_JIS byte length of
  Argument1>`:

  ```js
  function sjisBytes(s) {
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      n += (c < 0x80 || (c >= 0xFF61 && c <= 0xFF9F)) ? 1 : 2;   // ASCII + half-width kana = 1, else 2
    }
    return n;
  }
  ```

  Any other function: `204`. P2: the remaining built-ins in `builtins.aym`.

### 3.9 Stand-in registry (worker side, pseudo-code)

```js
const SAORI = {                       // key: lower-cased path relative to the ghost root, '/' separators
  'saori/dsaudio.dll':      dsaudio,  // §3.4
  'saori/gomi.dll':         gomi,     // §3.5
  'saori/fill_desktop.dll': fill,     // §3.6
  'saori/httpc.dll':        httpc,    // §3.7
  'saori/yaya.dll':         yaya,     // §3.8
};
// js_saori_load(path): the stand-in exists → instance.load(dir), return 1. Unknown path → 0 (Satori then logs the error).
// js_saori_request(path, req): parse the "GET Version" / "EXECUTE" request (CRLF headers),
//   reply "SAORI/1.0 <code> <msg>\r\nCharset: UTF-8\r\n[Result: x\r\n][Value0: …\r\n…]\r\n".
// js_saori_unload(path): instance.unload()  (dsaudio: stop and release audio)
```

Reply values must not contain CR or LF; replace them with a space.

---

## 4. Script-command inventory (`\![…]` and unusual tags)

The counts are tag occurrences over all 4 corpus files [C, bang.py]. The tokenizer and player semantics are in
sakurascript.md; this table says what each command means **for Tsubasa** and what the runtime must do.

| Command | Count / scripts | Typical context | Runtime action | P |
|---|---:|---|---|---|
| `\![bind,cat,part,1｜0]` | 3 292 / 1 179 | Outfits (§7). 1 900 offs, 1 368 ons. An empty part (`bind,足,,0`) means the whole category, about 1 300 times. Scopes: 0 (2 847), 95 (209), 100 (181), 98 (32), 27 (18), 96 (3), 99 (2). Junk third arguments from unexpanded variables (`(うにゅうｹﾞｯﾄ)` etc.) are ignored. Category `指輪２` does not exist in the shell, so it is a no-op. | Bind and refresh, then the dress-up events (§7). | P0 |
| `\![*]` | 2 848 / 349 | Bullet before `\q` in lists | Draw the choice marker | P0 |
| `\![raise,OnDirectSaoriCall,…]` | 801 | `sync` calls: set (765), fill_desktop (32), gomi (4) | Raise **at the tag's position** during playback, with `SecurityLevel: local`. Always 204. | P0 |
| `\![raise,X,…]` (other) | 169 | At the end of a script: chains such as `天気予報情報取得開始２`, `お絵描きロジック開始前２` | Raise `GET X` | P0 |
| `\![timerraise,ms,1,X,…]` | 530 / 415 | Game loops: 80 ms (puyo), 100 ms (Ukajan), 10 ms (card game), 930–1 000 ms (rhythm game), 11 000–12 000 ms (typing time limit), 45 000 ms (rhythm game end), and `0` to cancel | One-shot timer per X; `ms=0` cancels | P0 |
| `\![set,alignmentondesktop,free]` | 443 | Before positioning `\p[99]` and event scopes | Free placement | P0 |
| `\![move,X,Y,time,base,baseOffset,moveOffset]` (legacy positional) | 433 / 87 | Seasonal and date scenes only: cherry-blossom viewing, autumn leaves, Christmas, moon, snow, Setsubun. Scopes 9–27, 95–101. | Move the scope window (sakurascript.md covers the syntax) | P1 |
| `\![raiseplugin,スタンプ帳,OnStampAdd｜OnMenuExec,…]` | 64 / 32 | Neighbourhood circular and New Year card, sent to the third-party "Stamp Book" plugin. Arguments include `ghost\master\kairan.png` and `nenga.png`. **Only reached after the plugin sent `OnStampInfo`** [T dic11_etc.txt:982–990]. | No-op. **Never send `OnStampInfo`.** | P2 |
| `\![open,inputbox,ID[,timeout[,default]]]` | 28 / 28 | IDs §6.7 | Input box → OnUserInput | P0 |
| `\![close,inputbox,ID]` | 13 | Before re-opening the same ID (`短冊２`) [T dic14_Mouse.txt:5222] and the dolphin box | Close if open; no event | P0 |
| `\![open,communicatebox]` | 6 | `c` key, "Talk to Tsubasa", `Mcommunicate` | Communicate box → OnCommunicate (Satori searches `＊ユーザ「…`) | P0 |
| `\![set,windowstate,minimize]` | 5 | `s` key, `Mminimize` | Hide the ghost, show the launcher, OnWindowStateMinimize | P0 |
| `\![set,wallpaper,"path",center｜tile｜stretch]` | 12 | After an image is dropped on her | **No-op** (she still says "There, I changed the wallpaper"). P2: offer the image as a page background. | P2 |
| `\![set,scaling,-100,100]` | 11 | Mirroring event scopes 22 and 25 (date and Christmas) | Horizontal flip | P1 |
| `\![change,ghost,random｜name]` / `\![call,ghost,…]` | 10 / 3 | "Switch / call another ghost" menu items | No-op while only one ghost is installed (SSP also does nothing without another ghost) | P2 (P1 later) |
| `\![raiseother,,,1,つばさ,…]` | 3 | Tea-party plugin protocol (junk arguments) | No-op | P2 |
| `\![updatebymyself]` | 2 | Main menu "Help with Homework", `Mupdate` | Emulate the update events, §10.3 | P1 |
| `\![open,mailer]` | 4 | Old "check mail" item | No-op | P2 |
| `\![open,browser,URL]` | 1 | Card-game help page `http://macapeng.web.fc2.com/card.html` [T dic15_Card.txt:192] | `window.open(url,'_blank','noopener')` | P1 |
| `\j[OnAnchorSelect.URL]` | 4 | URL anchors | sakurascript.md | P1 |

Commands that **never occur** in the corpus or the dictionaries: `\![sound,…]`, `\![embed]`,
`\![set,choicetimeout]`, `\![set,balloontimeout]`, `\![set,autoscroll]`, `\![lock]`, `\![effect]`, `\![filter]`,
`\![anim]`, `\![enter/leave,…]`, `\![execute]`, `\![get]`, `\![notify]`, `\_v`, `\8[…]`, `\i`, `\_a`, `\_s`.
`\8` appears once, **without brackets**, in the Unyu-Puyo description [T dic20_unyu.txt:98]: treat it as a no-op.
There is also a commented-out `＃\![open,browzer,]` (a typo of `browser`) [T dic02_Event.txt:552].

The other unusual tags are counted in sakurascript.md §1.2: `\_b` 262 313, `\_l` 58 674, `\__q` with 220 stray
closes, `\C` 601, `\x` 198, `\6`, `\+`, `\v`. They are handled there.

---

## 5. Files

### 5.1 Inline balloon images (`\_b[...]`)

All paths are relative to `ghost/master` and use `\` separators, often in double quotes. Options seen: `inline`
26 497, `--option=foreground` 8 661, `--option=background` 3 709, `opaque` 2 908, `--clipping` 45 [C bimg.py].
Transparency: use the top-left pixel as a colour key (sakurascript.md §1.4).

| Folder / file pattern | Used by | Notes |
|---|---|---|
| `menu\choice1…7.png` | Every menu: buttons under `\__q` labels (2 774 dictionary sites in master, plus about 1 000 in sub-folders) | **P0.** Choice buttons are images. |
| `menu\icon\*.png` (`choicem`, `t`, `n`, `com`, `qa`, `wel`, `b`, `g`, `d`, `w`, `m`, `e`, `c`, `x`, `sd`, `memo`, `kazu`, …; `sky1-3` and `m1-12` backgrounds) | Main menu and mini-game menu [T dic03_Menu.txt:48–80, dic13_Game.txt:30–49] | **P0.** `\_b["menu\icon\（背景表示）.png",0,0]` is a positioned background. |
| `menu.png` | One-touch-menu toggle button in the main menu | P0 |
| `menu\f*`, `q*`, `clothes*`, `head*`, `inner*`, `accessory*`, `band*`, `face*`, `apron*`, `knee*`, `pendant*`, `muffler*` | Her own dress-up menu (thumbnails) [T dic16_Dressup.txt] | P0 |
| `exclamation.png` | "Retort support" marker after jokes (`＄ツッコミサポート状態`) | P1 |
| `0.png`–`13.png`, `21.png`–`29.png`, `bom1-6.png`, `clear.png`, `miss.png` | **Bomb game** tiles: 0–9 red counts, 10 unexplored, 11 player, 12 goal, 13 chest, 21–29 blue counts, explosion, result [T dic13_Game.txt:2488–2492, 2795–2872] | P0 (game) |
| `kuro.png`, `siro.png` | Black & White game cells | P0 (game) |
| `othello_0/1/2.png` | Reversi pieces (`othello_1` through `＄オセロ黒色`) | P0 (game) |
| `card\No1…No107(b).png`, `card\1-10.png`, `ere*.png`, `field.png`, `win/lose/draw/ura/same/plus/combo/wallsame.png` | Card game (107 cards) and Concentration | P0 (game) |
| `jan\j*.png`, `y*.png`, `jback/jc/je/jf/jp.png` | Ukajan tiles | P0 (game) |
| `2048\*.png`, `b1-4(b).png`, `waku.png` | 2048 | P0 (game) |
| `unyu\*.png` | Unyu-Puyo: about 210 000 `\_b` in the corpus, up to 25 839 tags in one script | P0 (game; performance §9) |
| `date\sea.png`, `swim1-3.png` | Swim race (date mode) | P1 |
| `http://weather.livedoor.com/img/icon/*.gif` | Weather result (unreachable) | P2: load as a plain remote `<img>`, no colour key; a failed load draws nothing |

The corpus shows 897 "missing" paths. All of them are harness artefacts: unexpanded variables such as
`（実表示１）` or `card\（…）.png`, not missing files. Files no talk references: 323 PNGs, mostly unused card and
menu variants, 13 root numbers, `jan\j*r.png` and `2048\4096+`. They may be referenced through variables; keep them
all.

### 5.2 Sounds

None. No sound files ship, and `\_v`, `\8[…]` and `\![sound]` are never used. The only audio path is dsaudio with
user-dropped files (§3.4).

### 5.3 Files read or written at run time

| Path | Who | R/W | Runtime duty |
|---|---|---|---|
| `satori_savedata.txt` (UTF-8 when written), `satori_savebackup.txt`, temporary `satori_savedata.tmp` | Satori `Save()`: write tmp, rename current → backup, rename tmp → current [S satori_load_unload.cpp `Save`]. Runs at unload, at `＄手動セーブ 実行` (34 dictionary sites), and at every dictionary reload. | RW | Persist both files after any request that changed them (the worker stores them in IndexedDB itself and reports `{t:'saved'}`; ARCH "Worker protocol"). The original SSP save (Shift_JIS or UTF-8, 401 lines) could be imported (P2). |
| `dic*.txt` in `.`, `bath/`, `date/`, `meal/` | Satori `LoadDicFolder`: prefix `dic`, extension `.txt` or `.sat` [S] | R | All four folders must be in the virtual FS, with `readdir` working |
| `satori_conf.txt`, `replace.txt`, `replace_after.txt` | Satori load | R | |
| `saori/*` | SAORI loader | R | Stand-ins (§3) |
| user audio and image paths | dsaudio `load`, `\![set,wallpaper]` | R | §3.4 Blob store; wallpaper is a no-op |
| `ghost\master\kairan.png`, `nenga.png` | Arguments to the Stamp Book plugin | – | Not used |
| `mop/0m.png`, `0s.png`, `0unit.txt` | Data for a third-party game ("ghost unit" stats) | – | Not used by the runtime |
| `updates.txt`, `updates2.dau` | SSP network update | – | Not used (§10.3) |
| `tsubasa.ico` | `descript.txt` `icon` | R | Optional launcher or favicon icon (P2) |

Satori does no other file I/O in Tsubasa: logging is off (`れしば送信` is unused) and YAYA has `save.auto, off`.

---

## 6. Events, resources, and input

### 6.1 Event handlers

The per-folder event table is shiori-events.md §6.1–6.6; it is complete for Tsubasa. Additions from this research:

* **`OnSecondChange` is defined** (master [T dic03_Menu.txt:1545], and every sub-folder). It runs every second to:
  * count the stay time (`＄計測秒`, `今回の計測秒`), which is saved;
  * react to going off-screen: R1 = 1 → `＄見切れタイマ 5` → "Am I in the way?", and returning → "Phew… I finally
    made it back.";
  * run the New Year's Eve countdown (`＊カウントダウンNN秒` on 12/31 at 23:59).

  It normally returns an empty script, so Satori goes on to its timers and `OnTalk` [S satori_EventOperation.cpp].
  The tick must therefore be sent **every second** while the ghost is visible, as GET when it can talk and NOTIFY
  otherwise (shiori-events §3.2). R1 is the off-screen flag: 1 when the character's centre lies outside the viewport.
* **`OnMinuteChange`** [T dic02_Event.txt:1347]:
  * +1 affection on every full hour of accumulated run time (`（calc,（単純累計分）％６０）＝＝０`);
  * jumps to `＊（現在分）分`: `＊０分` is the hourly chime, `＊３０分` the half-hour [T dic07_Time.txt:2567, 2573];
  * jumps to `＊（現在時）時（現在分）分`: `２３時５５分`, `１８時３０分` (dinner invitation).

  It must fire once per wall-clock minute, just after the minute changes.
* **Satori special talks.**
  * Defined: `＊OnTalk` (master only; the sub-folders use the nameless `＊`), `＊OnSatoriClose` (clears
    `スタンプ帳動作`), `＊初期化` (in satori_conf), `＊hwnd`.
  * Not defined: `OnSatoriBoot`, `OnSatoriLoad`, `OnSatoriUnload`, `OnSatoriSecondChange`, `OnSatoriTimer`,
    `COMMUNICATE該当なし`, `なでられ時の反応`, `OnMouseMove`, `OnCommunicate`, `OnRecommendsiteChoice`,
    `OnUserInputCancel`, `OnChoiceSelectEx`, `OnSurfaceRestore`, `OnSurfaceChange`, `OnMouseDragStart`.

  So Satori's defaults apply to all of these [S satori_EventOperation.cpp].
* **Resources.** shiori-events §6.4. The runtime must show `dressuprootbutton` (`1`, caption "Dress-up(&C)"). She
  also answers `vanishbutton.visible` = `（消滅指示表示）` (default `1`) [T dic06_String.txt:32–42], which the runtime
  does not ask: there is no Uninstall item [decision] (ssp-ui.md §2.1 #4).

### 6.2 Idle talk timer

| Variable | Default | Changed by | Engine effect |
|---|---|---|---|
| `＄喋り間隔` | `１２０秒` [T satori_conf.txt]; recomputed at boot from `＄喋り設定` (たくさん 30 s, にぎやか 60 s, ふつう 120 s, おとなしめ 200 s, ときどき 300 s) [T dic01_Boot.txt:1707]; the settings menu sets 30/60/120/200/300/0 s [T dic03_Menu.txt:1058–1095]; meal and date modes use `＄喋り設定夕食`, `デート` and `風呂` through `（sync,set,喋り間隔,…）` [T dic05_Communicate.txt:1176] | 88 assignments | Values below 3 mean never [S `sysvar_talk_interval`] |
| `＄喋り間隔誤差` | `１０％` | – | Each wait is interval ± 10 % (108–132 s by default) |
| `＄会話時サーフェス戻し` | `有効` | – | Prefixes talks with `\0\s[default0]\1\s[default1]\p[99]\s[9702]…` |
| `＄デフォルトサーフェス0/1/99` | 0 / 10 / (9702 when set) | 135 assignments | Surface restore per scope |
| `＄スコープ切り換え時` | `\n[half]` | – | |
| `＄自動挿入ウェイトの倍率` | `２００％` | – | Satori adds `\w` after punctuation, so talks are slow on purpose |
| `＄次のトーク` / `＄トーク予約のキャンセル ＊` | | 80 / 32 assignments | Reserved talks; cleared on minimize |
| `＄…タイマ` | | 14 named timers, e.g. `ツッコミタイマ` (251 sets), `頭つつきタイマ`, `ゴミ捨て中タイマ`, `見切れタイマ` | Decremented every OnSecondChange; fire only on a can-talk tick [S] |

**Mechanics** [S satori_EventOperation.cpp]. On each `OnSecondChange` whose script is empty and whose R3 ≠ `0`:
1. Fire a due timer, if any.
2. Otherwise, unless off-screen (R1 = 1 and no `見切れてても喋る`), decrement the talk countdown.
3. At below 0, run `OnTalk` (`＊OnTalk` [T dic12_Base.txt:7] → normal, trivia, quote or lover talk, depending on the
   `＄トーク通常/雑学/名言/恋人` toggles).

Any spoken script resets the countdown.

**Navigation consequence.** The countdown lives in engine memory and restarts at every page load: shiori-events §3.6
and Q1 there.

### 6.3 How menus open

| Gesture | Event chain | Result |
|---|---|---|
| **Double-click** on Tsubasa where no collision is | `OnMouseDoubleClick` R3=0, R4="" → `＞（Ｒ３）（Ｒ４）つつかれ` → `＊0つつかれ` [T dic03_Menu.txt:1115, 8] | **Main menu** (`＊メニュー`, or seasonal variants) |
| Double-click on a collision | → `＊0Headつつかれ` etc. → body reaction (§6.4) | Reaction talk |
| Double-click with no matching talk | → `＞豆撒き４`, then `＞OnTalk` | A random talk |
| Double-click the music box (scope 1) | → `＊1つつかれ` → `＊音楽コマンド` [T dic11_etc.txt:906, 749] | Music menu |
| Key `m` | `＊mが押された` → `＊0つつかれ` [T dic02_Event.txt:862] | Main menu |
| **Single click** on scope 99 (one-touch menu, surface 9700) | `OnMouseClick` R3=99, R5=0 → `＞（Ｒ４）つつかれ` → `＊Mmenu/Mtalk/Mcommunicate/Mgame/Mdress/Mmusic/Mweather/Mgomi/Mdate/Mupdate/Mconfig/Mx/Mminimizeつつかれ` [T dic14_Mouse.txt:2961ff; dic03_Menu.txt:570–612] | The matching item |
| Hold `Mclose` on scope 99 for **more than 1 s** | `OnMouseDown` R5=0 stores `（単純起動秒）`; `OnMouseUp` compares → `＞ユーザ「　またね　ばいばい　バイバイ` [T dic14_Mouse.txt:2947–2957] | "Heading home?" farewell. A plain click on `Mclose` does nothing. |
| Right-click | The runtime's SSP-style menu (ssp-ui.md §2), unless `OnMouseClick` R5=1 answered (Tsubasa answers only for collision reactions when `＄右クリック使用` is 1; default `０`) | Runtime menu |

**The one-touch menu.**
* It is **off** by default (`＄ワンタッチメニュー状態 ０`). Scope 99 then shows surface 9702, a 4×4 image at
  200,121, effectively invisible but present.
* The `menu.png` button in the main menu turns it on: scope 99 shows surface 9700 (204×125) with 14 rectangle
  collisions [SH surfaces.txt:25350].
* `Mdatex` is an **animation collision** inside the bind animation 1150 (`animation1150.collision99`). It is active
  only while the `メニュー,メニュー×` bind is on.
* Shell defaults: `char99.defaultleft,300`, `char99.seriko.alignmenttodesktop,free`.

### 6.4 Mouse events and collision ids

**Talk-name scheme.** Reactions use `＊<R3><R4><verb>`. R3 is the scope as decimal and R4 is the collision id
exactly as the shell writes it (case-sensitive). The verbs are `つつかれ` (double-click), `なでられ` (stroke) and
`ころころ` (wheel). The English-id entries forward to Japanese-named talks. Example: `＊0Headつつかれ` → checks for
hats → `＊頭つつかれ` [T dic14_Mouse.txt:130].

**Coverage.**
* Every collision id used in her dictionaries exists in the shell: 0 missing.
* The shell has 1 045 distinct ids, counting rectangle `collisionN` and 472 `animationN.collisionM`.
* Ids with no reaction talk: `P1…P900` (picture-logic cells, handled through `OnMouseClick`) and the rhythm-game
  arrows `LG*/DG*/UG*/RG*/LB*/…/LM/DM/UM/RM`.

[SH surfaces*.txt; C]

| Event | Tsubasa's handler | What the runtime must send |
|---|---|---|
| `OnMouseDoubleClick` | [T dic03_Menu.txt:1115]: `0Head` → retort check; R3 99 → picture-logic message; else `（Ｒ３）（Ｒ４）つつかれ`; then bean-throwing (R3 22/100); then `OnTalk`. Date and bath folders add game guards [T date/dic03_Menu.txt:2574]. | R3 scope and R4 collision of the **current composed surface, including active bind-animation collisions** |
| `OnMouseClick` | [T dic14_Mouse.txt:2961]: bean-throwing (R3 22/101/0, any button); picture logic (R3 100: R5 0 fills a cell, R5 1 marks it); one-touch menu (R3 99, R5 0); "kiss" reactions on `Head/Ponytail/Mouth/Cheek/…` for R5 2 (middle), and for R5 1 only when `＄右クリック使用` is 1. Date adds the rhythm game: R3 95, R5 0 [T date/dic14_Mouse.txt:1877]. | R5: 0 left, 1 right, 2 middle (compatibility value). Middle click is needed: shiori-events §4.2 recommends Alt+left as a substitute. |
| `OnMouseDown` / `OnMouseUp` | Only for the `Mclose` hold (§6.3) | Both, with R5 |
| `OnMouseWheel` | `＞（Ｒ３）（Ｒ４）ころころ	（Ｒ２）>115\|\|（Ｒ２）<-115`, then `＞（Ｒ３）ころころ`. Picture logic `＊100ころころ` uses the sign of R2: > 0 → judge 3, else judge 4 [T dic13_Game.txt:7341–7347]. | **R2 = ±120 per notch, + = away from the user.** Normalisation code: shiori-events §4.4. |
| `OnMouseMove` | Not defined → Satori petting: 60 moves within 2 s on the same R4 → `＊<R3><R4>なでられ`, except while Status says talking, induction, passive or timecritical [S; satori_load_dict.h `nade_sensitivity=60`, `nade_valid_time_initializer=2`] | One per animation frame while over opaque pixels (shiori-events §4.3) |
| `OnMouseDragEnd` | Date mode only: re-saves cherry or maple tree positions for R3 9/10 [T date/dic14_Mouse.txt:2641] | P1 |

**Hold events.** Satori's built-in hold (`＊<R3><R4>ホールド`) is never used; Tsubasa defines no `ホールド` talks.

### 6.5 Keyboard (`OnKeyPress`)

**Handler** [T dic02_Event.txt:809] (sub-folders: bath:357, meal:368, date:616):

```
puyo running & idle   → ＊ぷよ中<R0>が押された          keys: left right down space x z
picture logic running → its pause menu (any key)
typing game, R2<2     → ＊<R0>が押されたタイピング中 (",") and ＊タイピング判定 (R0 + R4)
shortcuts (＄ショートカット設定 = 使用する, R2<2, not typing, not puyo) → ＊<R0>が押された
```

**Shortcut keys** (master): `a z w x` (talk kinds), `t` talk, `back` repeat the last talk, `c` communicate, `m`
menu, `g` mini-games, `d` dress-up, `o` music, `up`/`down` next/previous song, `e` settings, `b` tea (**this switches
to meal mode**), `f` weather, `v` Recycle Bin, `s` minimize, `r` reload dictionaries. Sub-folders: `down m o r s t
up`.

**Typing game, direct mode** [T dic13_Game.txt:1212]:
* Typed characters: R0 ∈ `a`–`z`, `0`–`9`, `- . [ ] / , ^`.
* Shift combinations come as **R0 = the unshifted key plus R4 containing `shift`**: `1`+shift → `!`, `/` → `?`,
  `^` → `~`, `5` → `%`.
* Backspace is R0 `Back` (compared case-insensitively); Enter is R0 `return`.

This confirms "R0 = unshifted key-top" (shiori-events §4.6).

**Date mode** [T date/dic02_Event.txt:616]:
* race: `left`/`right`;
* UFO catcher: `right` with **R2 = repeat count** (moves at R2 = 1, 3, 6, 9, 12, 15, 18, … [T
  date/dic13_Game.txt:946ff]);
* beach volleyball: `up/down/left/right` (scope 17);
* swim race: `left` [T date/dic14_Mouse.txt:3319].

**R2 contract (recommendation; see Q1).** R2 = 1 on the first `keydown`, and +1 for each auto-repeat `keydown` of
the same key (`KeyboardEvent.repeat`). Send OnKeyPress for **every** repeat, without throttling. Reset when the key
is released.

Call `preventDefault()` on keys sent to an active ghost, so arrows and space do not scroll the page.

### 6.6 Choices, timeouts, minimize

* **Choices.** Choices carry raw IDs; On-IDs become events (shiori-events §4.7). The choice timeout applies to the
  1 289 choice scripts without `\*`. Tsubasa answers `OnChoiceTimeout` with "Is this some kind of neglect play?" and
  similar [T dic02_Event.txt:626]. She never sets `choicetimeout`, so the runtime default applies (ssp-ui.md §4.3).
* **Minimize** (`s` key or `Mminimize`). `OnWindowStateMinimize` resets game flags and cancels the typing and puyo
  timers through `\![timerraise,0,1,…]` [T dic02_Event.txt:7–28].
* **Restore.** `OnWindowStateRestore` says "Th-That was so cramped…" [T dic02_Event.txt:30]. The response contains
  `\![timerraise,0,…]` cancels and must be played even though the ghost is hidden. If a hidden ghost cannot play
  scripts, at least execute the timer cancels.

### 6.7 Input boxes and the communicate box

**The OnUserInput idiom** (every folder): `＄（Ｒ０）	（Ｒ１）` then `＞（Ｒ０）を教えてもらった` [T
dic01_Boot.txt:29, dic03_Menu.txt:1171]. **The box ID is the name of the variable that receives the text.**

| ID | Args | Where | Notes |
|---|---|---|---|
| `ユーザ名`, `ユーザ` | – | First boot (name prompt), settings | P0. First-boot flow: ＊初回 → choice → inputbox [T dic01_Boot.txt:5–70]. |
| `数字記憶答え` | – | Number Memory | |
| `数当て答え` | `,,（数当て答え）` (default text) | Number Guessing | Empty timeout means the runtime default |
| `タイプ答え` | `,（タイプ制限時間）` = 12 000 ms, down to 3 000 | Typing game, box mode (the default) | **Needs timeout handling**: `＊タイプ答えを教えてもらった` → `＞タイプ時間切れ	（compare,（Ｒ１）,timeout）` [T dic13_Game.txt:1108]. On timeout send `GET OnUserInputCancel [ID, timeout]`; she has no handler, so 204; then `GET OnUserInput [ID, "timeout"]` [U list_shiori_event OnUserInput]. |
| `短冊２`…`短冊５` | – | Tanabata wish strips (7/7) | close, then open, of the same ID |
| `イルカボックス` | `,,How to get rid of you` | Date mode, aquarium | |

Cancel (close button or Esc): send `OnUserInputCancel [ID, close]` only. No fallback; nothing happens.

**Communicate box.** `OnCommunicate` R0 = `user`, R1 = text. Satori searches the `＊ユーザ「…` talks: 142 headers in
master [T dic05_Communicate.txt]. There is no `COMMUNICATE該当なし`, so an unmatched text gets no reply.

---

## 7. Dress-up

**How she changes clothes.** Through script `\![bind]` from **her own dress-up menu**: `＊着せ替えメニュー` (the `d`
key, the main menu, `Mdress`), with thumbnail images (§5.1). The menu refreshes itself with
`\![timerraise,…,服着せ替えメニュー]` (41×) and `頭着せ替えメニュー` (27×) [shiori-events §6.2]. She also re-binds
automatically:
* a random set of underwear once per day at boot (`＞下着着せ替え	（下着着せ替え日）!=（現在日）`);
* seasonal clothes (`＄季節の服`, `＄起動時換装`);
* in every event and mode scene.

[T dic02_Event.txt:976]

**SSP's dress-up menu.**
* It is enabled: `dressuprootbutton.visible` = `1`.
* The shell has 80 `sakura.menuitem` entries and three default groups: `髪,ポニーテール`, `足,ニーソピンク`,
  `服,夏服＋上着ピンク` [SH descript.txt].
* User toggles must send `OnDressupChanged` with R4 = `user`. Her handler treats them exactly like script binds. P1:
  the main path is her own menu.

**Categories** (sakura, 230 groups) [SH descript.txt]:

| Category | Parts | Category | Parts |
|---|---:|---|---:|
| 髪 (hair/hats) | 18 | 服 (outfits) | 112 |
| アクセサリ１ (hair ornaments) | 13 | アクセサリ２ (headbands/ears) | 12 |
| アクセサリ３ (glasses/eyepatch) | 9 | 下着 (underwear) | 15 |
| 足 (knee socks) | 7 | エプロン | 7 |
| マフラー | 4 | ペンダント | 5 |
| お面 (masks) | 2 | 上着, 上着腕 (lab coat) | 1 + 1 |
| 首 (kiss mark), 頬 (blush), 口 (pocky), 尻尾, 指輪 | 1 each | テーブル | 2 |
| 料理 (food on the table) | 15 | 風呂 (bath) | 2 |

* `bindoption` is not set, so every category is exclusive.
* Extra scopes:
  * char100: 900 categories `P1…P900` × 4 parts, the picture-logic cells;
  * char95: 33 groups, rhythm-game arrows;
  * char98: UFO prizes;
  * char96: shelf of collected plush toys;
  * char27: Tanabata strips;
  * char99: `メニュー`.

**`OnDressupChanged`** [T dic16_Dressup.txt:834].
* She reads R1 (part) and R2 (on/off). R0 (scope) and R3 (category) are not checked.
* For each category she resets every `＄<item>着用` flag and then sets the flag named by R1.
* **Hence an "off" event must come before the "on" event that replaced it**; if the order were reversed, the final
  flags would name the part that was removed.
* These flags (e.g. `麦藁帽子着用`, `ポニーテール着用`, `猫耳着用`) drive reactions (`＊0Headつつかれ`) and OnTranslate
  speech modes.
* **P0.** Event shape and the >100-changes rule: shiori-events §4.11.

**`OnNotifyDressupInfo`** [T dic16_Dressup.txt:4062].
* During picture logic it returns immediately (`＞お絵描きロジック中着せ替え`). Otherwise it loops over References
  from R0.
* For each reference: if `erase(R(n), \x01)` ends in `0`, the group is off and is skipped. Otherwise the part name is
  `split(R(n), \x01)` → `（Ｓ２）`, which goes into `＄<cat>着せ替え状態`.
* **The loop stops at the first reference whose category is not one of the 18 she knows.**

[U list_shiori_event OnNotifyDressupInfo] defines a reference as `scope\x01category\x01part\x01option\x01on(1/0)\x01thumbnail`.
Runtime rules that follow:

```
order references by scope (0, 1, 2, …, 99, 100), then by bindgroup id ascending       (P0)
   sakura ids 0…229 ascending end with テーブル (1000+), 料理 (1010–1050) and 風呂 (1100–1101);
   so ascending id order lets her read every category she tracks before the loop stops.
   File order is NOT id order, and file order would also put char99's メニュー among the sakura groups.
thumbnail field: empty unless the shell defines one (Tsubasa's shell defines none)    (P0)
   a non-empty thumbnail makes her "ends with 0" test read the file name instead of the flag
option field: empty (no bindoption)
```

**Volume.** With every scope included, the request carries about 3 885 References (≈120 KB). It is sent after every
script that binds, including each picture-logic click; she ignores it during that game. This is acceptable over
`postMessage`. P1 optimisation: reuse the encoded string and cache it per bind state.

**Persistence.** Store the bind state per scope with the ghost state and restore it on resume, without
`OnDressupChanged` (shiori-events §2.2).

---

## 8. Dictionary-folder switching (bath / date / meal)

**Mechanism** (engine-internal, verified in source).
1. `＄辞書フォルダ	<v>`, or `（sync,set,辞書フォルダ,<v>）` through OnDirectSaoriCall, calls
   `sysvar_dic_folder`: `dic_folder = split(v, ",")`, `reload_flag = true` [S satori_builtin.cpp].
2. After the current request's response is built, Satori runs `unload()` then `load(base)` in the same `request()`
   call [S satori_AnalyzeRequest.cpp].
3. `unload()` saves the save data and unloads every SAORI [S satori_load_unload.cpp].
4. `load()` re-reads `satori_conf.txt` (`＊初期化` only adds missing variables), reloads the SAORIs, loads the save data
   (which contains `＄辞書フォルダ`, so the folder survives), then loads only `<base>/<v>/dic*.txt`. `.` means the
   root.
5. Side effects:
   * it runs `OnSatoriLoad`/`OnSatoriBoot` (Tsubasa defines neither);
   * it increments `＄起動回数`;
   * it resets `sec_count_at_load`, which means `（単純起動秒）` and `（起動時）` restart.

**Call sites.**
* Master → `meal`: 8 sites (dinner-or-bath choice ×2, tea, late-night snack, birthday cake, Christmas cake, dinner ×2).
* Master → `bath`: 1 site (bathing together).
* Master → `date`: 3 `＄` sites plus 10 `sync` sites (fireworks, first shrine visit, cherry blossoms, autumn leaves,
  beach, park, arcade, station, aquarium, Christmas).
* Every sub-folder sets `＄辞書フォルダ	.` in its `＊起動` (boot) and `＊終了` (close), and in ghost-change talks.

[T census §6.2; dic17_Date.txt:57ff]

**Runtime duties.**
* **P0.** Include `bath/`, `date/` and `meal/` in the engine's file list. `readdir` must list them, and the sub-folder
  PNGs (`date\sea.png`, `swim*.png`) must be fetchable.
* **P0.** A request that triggers a reload is slow: it re-parses up to 2.5 MB in WASM. Measure; expect 1–3 s. The
  native DLL took 1.4 s for the first load [C header `load=1 (1.4s)`].
  * The response already exists before the reload, but the worker returns it only after the reload.
  * Patch option (P1): return the response first and reload at the start of the next request or on an idle tick.
    This needs a Satori patch, because the reload sits inside `request()`.
  * Without the patch, the player must not wait synchronously. A `sync` raise is fire-and-forget; later events
    simply queue (FIFO).
* **P0.** Persist the changed `satori_savedata.txt` after the reload.
* **P0.** On a **fresh boot** in a sub-mode, the sub-folder's `OnBoot` → `＊起動` sets `.`, so a reload follows the boot
  script. On **resume**, no `OnBoot` is sent, so the mode continues. Both are correct.
* Music stops at every switch, because dsaudio is unloaded (§3.1). This matches SSP.

**Extra needs per mode.**

| Mode | Entered by | Extra runtime features |
|---|---|---|
| meal | `b` key or "tea", dinner invitation (6 pm, affection > 200), late-night snack, cakes | Scopes 19 (Christmas tree) and 100 (hidden with `（１０）`), table and food binds (`テーブル`, `料理`), its own talk interval (`＄喋り設定夕食`). Nothing new for the runtime. |
| bath | Bath event after an overnight stay or engagement (late game) | Bind `風呂`, scope 100 hidden. Nothing new. |
| date | Date menu, **affection > 200**, or dated events | Many scopes (2–5, 9–17, 20–26, 95, 97, 98); `\![move]` positional (233×); `\![set,scaling,-100,100]`; OnMouseDragEnd (tree positions); OnKeyPress games (race, UFO with R2 repeats, volleyball, swim); rhythm game (scope 95 clicks + timerraise inside `\t`); `date\*.png` inline images. **P1.** |

---

## 9. Mini-games

The mini-game menu has 13 entries [T dic13_Game.txt:30–51], reached through the `g` key, `Mgame` or the main menu.
Every game draws its board as inline images in the balloon (`\b[2]` is the large balloon), with `\__q[...]` around
image buttons, and uses scope 0 or 1 for her reactions. Feature counts are summed over each game's talks in the
corpus [C games.py].

| Game | Dictionary | Input | Timers | Images | Special | P |
|---|---|---|---|---|---|---|
| Number Memory (数字記憶) | dic13:422 | inputbox `数字記憶答え` | – | menu | | P0 |
| Number Guessing (数当て) | dic13:596 | inputbox with default text | – | menu | | P0 |
| Stone Taking (石取り, Nim) | dic13:689 | choices | – | menu | | P0 |
| Typing (タイピング) | dic13:1031 | **box mode** (default `＄タイピング方法 ボックス入力`): inputbox with a 12 000→3 000 ms timeout; **direct mode**: OnKeyPress with R0 + R4 `shift`, `Back`, `return` | `timerraise` 11 000–12 000 (time limit), `0` cancel | menu | Romaji spelling settings | P0 (box) / P0 (keys) |
| Black & White (しろくろ, "四角選択") | dic13:1532 | `\__q` on cell images (1 175) | – | `kuro/siro.png`, root numbers | Best time through `（単純起動秒）` difference (resets on navigation) | P0 |
| Bomb (爆弾, minesweeper-like walk) | dic13:2475 | `\__q` cells + `\q` arrows | – | root `0–29.png`, `bom*.png`, `clear/miss.png` | Points shop (`＄ゲームポイント`) | P0 |
| Concentration (神経衰弱) | dic13:3731 | `\__q` on cards | – | `card\` | Scripts up to 9 711 chars | P0 |
| Reversi (リバーシ) | dic13:4519 | `\__q` on the board | – | `othello_*.png` | `\C` (append) | P0 |
| 2048 | dic13:5886 | `\__q`/`\q` arrow buttons (no keys) | – | `2048\` | `\C` 92× | P0 |
| Picture Logic (お絵描きロジック, nonogram) | dic13:7337 | **OnMouseClick on scope 100** collisions `P1…P900` (R5 0 fill, R5 1 mark); **OnMouseWheel** on scope 100 (`＊100ころころ`, sign of R2); any key → pause menu | – | scope 100 surface with **900 bind categories × 4 parts** | `\p[100]\![bind,P<n>,m1,1]` per click [T dic13_Game.txt:7853]; `\t` 65×; save and quit | P0 (scope 100 binds and collisions) |
| Card game (カード, Triple-Triad-like) | dic15_Card.txt | `\__q` on cards | `timerraise,10,1,…` chains (34) | `card\` (22 335 `\_b`) | `\![open,browser]` help page; scripts up to 11 069 chars | P0 |
| Ukajan (うかジャン, "Ponjan" mahjong) | dic19_Jan.txt | `\__q` on tiles | `timerraise,100` | `jan\` | Scope 23 | P0 |
| Unyu-Puyo (うにゅぷよ, falling blocks) | dic20_unyu.txt | **OnKeyPress** `left right down space x z` | `timerraise,80,1,ぷよ自動落下` and others: a **12.5 Hz frame loop**; Satori timer `ぷよぷよ連鎖タイマ` | `unyu\` | Up to **529 675 chars and 25 839 tags in one script**; each frame redraws the whole board as `\_b` inline images | P0, performance-critical |
| Setsubun bean throwing (豆撒き, Feb 3) | dic07_Time.txt:267 | OnMouseClick on scopes 22 (oni), 101, 0 | `timerraise,1000` | – | `\![move]` of scope 22 | P1 (seasonal) |
| Rhythm game (date, arcade) | date/dic13_Game.txt:16 | OnMouseClick on scope 95 (`LG1…`) | `timerraise` 1 000 (spawn), 930 (fade), 45 000 (end), many `0` cancels, inside `\t` | scope 95 binds (209) | Q6 in shiori-events (timerraise during `\t`) | P1 |
| UFO catcher (date) | date/dic13_Game.txt:939 | OnKeyPress `right` with **R2 repeat count** | 10 500 / 12 000 | scope 98 surfaces and binds | | P1 |
| Race (date) | date/dic02_Event.txt:617 | OnKeyPress `left`/`right`, timed to surfaces 9620–9634 | timerraise | scope 97 | | P1 |
| Beach volleyball, swim race (date) | date/dic14_Mouse.txt:3222, 3319 | OnKeyPress arrows | 1 000 | `date\*.png` with `--option=background/foreground` | | P1 |

* **No riddle or quiz game was found.** `なぞなぞ`, `クイズ`, `しりとり` and `占い` match no talk names. Festival
  stalls (おみくじ, 射的, 金魚, ルーレット) in date mode are choice talks.
* **All games keep state in Satori variables.** Save data persists their statistics.
* **What a navigation mid-game loses:**
  * runtime-side `timerraise` timers, so puyo, rhythm and card chains stall;
  * the running script;
  * `（単純起動秒）`-based timing.

  P1: persist pending `timerraise` timers (event, remaining ms, repeat, references) and re-arm them on resume. Picture
  logic has its own save and resume, `お絵描きロジック中断`.
* **Performance (P0 for puyo).**
  * Decode each `\_b` image once and cache it as an `ImageBitmap` or canvas.
  * Apply the colour key once per image.
  * Lay out a balloon of ~25 000 tags in under 80 ms. Recommended: draw inline images onto one canvas per balloon
    instead of creating one DOM node per image.

---

## 10. Time, network and OS features

### 10.1 Dates and seasons

Satori's `（現在年/月/日/時/分/秒/曜日）` (about 3 500 uses) come from libc `localtime`. Emscripten implements it
with the browser's `Date` and time zone, so no work is needed. Test `（現在時）` against `new Date().getHours()` once.

**Events at boot, or on the first talk of the day** [T dic02_Event.txt:1109, 1124, 1222, 1335–1344; dic07_Time.txt]:

| Date | Event |
|---|---|
| 1/1–1/7 | New Year, cards through the Stamp Book plugin (inactive) |
| 2/3 | Setsubun bean throwing (game) |
| 2/14 | Valentine's Day |
| 3/3 | |
| 3/14 | White Day menu |
| 4/1 | April Fool dreams |
| 5/5 | |
| 7/7 | Tanabata strips: scope 27 + input boxes |
| 8/15 | |
| 10/31 | Halloween |
| 11/3 | |
| 11/23 | **Tsubasa's birthday**, cake → meal mode |
| 12/24–25 | Christmas: tree on scope 19, Christmas date |
| 12/31 | New Year's Eve talks and the 23:59 per-second countdown |
| Harvest moon | Date from her own per-year table `（現在年）年中秋の名月`; scope 18 moon |
| User's birthday | Set in settings through choice events `On生誕の月` / `On生誕の日` [T dic03_Menu.txt:1389, dic07_Time.txt:2291] |
| Neighbourhood circular | Before the 16th of each month, only with the Stamp Book plugin |

Spring cherry blossoms and autumn leaves are date-mode events. They have ambient falling-petal and snow scopes, toggled
by `＄左桜`, `右桜`, `花びら落下`, …

**Clock-driven features.**
* Hourly and half-hourly chimes through OnMinuteChange (§6.1). `＄時報トーク設定 ON`; silenced during puyo.
* The 18:30 dinner invitation.
* Affection +1 per accumulated hour (`（単純累計分）` comes from the save data, so it accumulates across pages if the
  save data is persisted at page hide).
* The `（起動時）>＝５` "all-nighter" closing lines use the engine **load** time, which resets on every navigation
  (Q3; resolved by P7: the clock runs from her cold boot).

### 10.2 Network

| Feature | Mechanism | Browser |
|---|---|---|
| Weather | `httpc` (§3.7) | Stub empty; she reports a failure. P0 stub. |
| Network update ("Help with Homework") | `\![updatebymyself]` | §10.3 |
| Card help page | `\![open,browser,…]` | `window.open` (P1) |
| URL anchors | `OnAnchorSelect` → `OnAnchorSelect.URL` → `\j[url]` | P1 |
| Recommend and portal sites | Resources `sakura.recommendsites` / `portalsites` (about 70 defunct 2000s URLs) | Runtime menu, P1 |
| Stamp Book, tea party, kinoko, nekodorifu, etc. | Third-party plugins and apps | Not available (P2) |

### 10.3 `\![updatebymyself]` emulation (P1, DECISION)

In the copy Sumika was tested with, the update URL is commented out (`//updateurl`: an update from the
original author's site would replace the English translation with the Japanese original), and `homeurl` is empty.

Emulate a network update that finds nothing:

```
GET OnUpdateBegin   [R0 "Hayama-san Next Door", R1 "", R2 "ghost"]   → play the script ("Okay! Time to give it my all.")
GET OnUpdateComplete [R0 "none"]                                      → "＊ネットワーク更新none" → "I didn't have any homework today."
```

Her handlers: [T dic02_Event.txt:152–200].

Do **not** emulate `OnUpdateReady` (it would say "0 assignments") or `OnUpdateFailure`. Real SSP without an update
URL would likely raise `OnUpdateFailure`; the exact reason string is unknown (Q5).

### 10.4 OS information

* **Used:** OnSecondChange R0 (OS uptime hours) and R1 (off-screen flag).
* **Not essential:**
  * `（隣で起動しているゴースト）` / `（起動しているゴースト数）`: empty or 1 with a single ghost (P2).
  * Battery and system-resource events: P2. Do not send them.
  * `OnSysResume`: P2.

Tsubasa's `＊OnTalk` starts with `＞（Ｒ１）	（Ｒ０）`. When R0 (uptime hours) is non-zero, it jumps to a talk named R1
(`0`/`1`), which does not exist. Satori then continues with the next line [S satori_sentence.cpp: "not found" keeps
going]. So any sane R0/R1 works.

---

## 11. Persistence and navigation specifics for Tsubasa

| State | Lives in | On page navigation |
|---|---|---|
| All her variables: affection, settings, playlist, game stats, dictionary folder, outfit-state variables | `satori_savedata.txt` | Persist at page hide (patched export, ARCHITECTURE "persist"). **Required** for continuity. |
| Bind state per scope | Runtime state | Restore, then send NOTIFY OnNotifyDressupInfo (§7) |
| Scope positions and surfaces (0, 1, 99, plus event scopes) | Runtime state | Restore. Scope 99 surface 9700 or 9702 must come back with its position. |
| Music playback | dsaudio stand-in | §3.4: persist and resume after a gesture |
| Pending `timerraise` timers | Runtime | P1: persist and re-arm |
| Satori timers (`＄…タイマ`) | Save data (unless `タイマ変数はセーブしない`) | Restored automatically |
| Talk countdown, petting counters, `（単純起動秒）` | Engine memory | Reset (shiori-events Q1; Q3 here) |
| Dropped music Blobs | IndexedDB | Persist |

---

## 12. Prioritised checklist

This is a plan, not a progress tracker. Only the two ticked P1/P2 items were checked against the code;
an unticked box does not mean the item is missing. Tsubasa runs in a tab; "Known gaps" in the project's `CLAUDE.md`
lists what remains.

### P0

**Engine and SAORI**
- [ ] Satori WASM with internal ssu. Put `ghost/master/**` in the virtual FS: `dic*.txt` of `.`, `bath`, `date`, `meal`; `satori_conf.txt`; `replace*.txt`; `saori/yaya.txt` and `*.aym`, which are harmless. `readdir` must work.
- [ ] Writable virtual FS. After every request, report and persist changed `satori_savedata.txt` and `satori_savebackup.txt`. This covers `手動セーブ` (34 sites) and reloads.
- [ ] SAORI bridge: register stand-ins for `saori/dsaudio.dll`, `gomi.dll`, `fill_desktop.dll`, `httpc.dll`, `yaya.dll`. `GET Version` replies `SAORI/1.0 200 OK` with `Charset: UTF-8`.
  - [ ] dsaudio: full command set (§3.4); at minimum, accept everything and reply 200 with no Value headers.
  - [ ] gomi: `-n` → `Result 0`, `Value0 0`; everything else no-op.
  - [ ] fill_desktop: no-op, 200.
  - [ ] httpc: empty Result.
  - [ ] aya: `GETSTRBYTES` → Shift_JIS byte length; everything else 204.
- [ ] Dictionary-folder reload works end to end. The slow request is tolerated, and the persisted save data is refreshed afterwards.

**Script events**
- [ ] `\![raise,OnDirectSaoriCall,…]` raised at the tag's position with `SecurityLevel: local` (801 per corpus).
- [ ] `\![raise]`, `\![timerraise]` (including `ms=0` cancel), On-ID choices, OnTranslate after every GET script (shiori-events).

**Display**
- [ ] Scopes 0, 1 (music box surfaces 10, 11, 12; surface 12 has no base PNG), 99 (9700/9702 with collisions, including the animation collision `Mdatex`), 100 (picture logic: 900 bind categories, `P1…P900` collisions), and generic `\p[n]` for the seasonal scopes.
- [ ] Balloon: inline images with colour key, all §5.1 folders, image caching. Scripts of 500 K characters must render fast enough for the 80 ms puyo loop.

**Mouse**
- [ ] OnMouseDoubleClick (main menu on no-collision `0つつかれ`), OnMouseClick with R5 0/1/2, OnMouseDown/Up (Mclose hold), OnMouseWheel ±120, OnMouseMove (Satori petting), R3/R4 from the composed surface.

**Keyboard and input**
- [ ] OnKeyPress with SSP key names (`a`–`z`, digits, `back`, `return`, `space`, arrows `up/down/left/right`, punctuation unshifted), R4 modifiers, R2 repeat counter (base per Q1), `preventDefault`.
- [ ] Input box with ID, timeout and default text. `OnUserInput`; timeout → `OnUserInputCancel` then `OnUserInput [ID,"timeout"]`; `\![close,inputbox,ID]`.
- [ ] Communicate box → OnCommunicate `user`.
- [ ] Choice timeout → OnChoiceTimeout.

**Dress-up**
- [ ] `\![bind]` with exclusive categories and empty-part = category off. OnDressupChanged with **off before on**. OnNotifyDressupInfo **scope-major, ascending id, empty thumbnail**. Bind state persisted per scope.

**Clock and window**
- [ ] OnSecondChange every second (R1 off-screen, R3 cantalk); OnMinuteChange at each minute boundary.
- [ ] `\![set,windowstate,minimize]`, OnWindowStateMinimize/Restore, and a launcher to restore.

**First boot**
- [ ] OnFirstBoot → name input box (`ユーザ名`) works.

**Stubs (P0 = must not leak or break)**
- [ ] `\![raiseplugin]`, `\![raiseother]`, `\![set,wallpaper]`, `\![open,mailer]`, `\![change/call,ghost]`: no-op.
- [ ] Never send `OnStampInfo`, `OnRecycleBinEmptied`, `OnHitThunder`, or other plugin and app events.
- [ ] `\8` without brackets: no-op.

### P1

- [x] dsaudio real playback: OnFileDrop2 drag and drop onto characters (R0 joined with `\x01`, R1 scope, R2 MIME types); Blob store in IndexedDB with pseudo-paths; `ended` → OnDSAPlayFinish; resume after navigation, subject to the autoplay policy. Missing: tag metadata (Value0–2), WMA (MIDI plays), `load` → `Result: 0` for missing files.
- [ ] `\![move]` legacy positional, `\![set,scaling]`, OnMouseDragEnd: seasonal and date scenes.
- [ ] Date-mode games (rhythm, UFO, race, volleyball, swim) and Setsubun.
- [ ] `\![updatebymyself]` emulation (§10.3). `\![open,browser]` and URL anchors.
- [ ] SSP-style dress-up submenu from `sakura.menuitem` (OnDressupChanged R4 `user`).
- [x] Persist pending `timerraise` timers across navigation. Done: SUMMARY C4 made it P0; the timers are saved in the ghost state (`timers`, SUMMARY §2.5) and re-armed on resume.
- [ ] Satori patch to answer before reloading the dictionaries.

### P2

- [x] fill_desktop flash overlay. Done: `src/core/page-saori.js` shows a brief full-viewport colour flash below the characters.
- [x] MIDI playback (`docs/research/midi.md`).
- [ ] WMA playback.
- [ ] Wallpaper as a page background.
- [ ] Remote `\_b` http images.
- [ ] A weather adapter.
- [ ] A Stamp Book emulation.
- [ ] YAYA built-ins beyond GETSTRBYTES.
- [ ] Import of an SSP save file.
- [ ] Multi-ghost commands.

---

## 13. Open questions

* **Q1 (P0). OnKeyPress R2 base.**
  * Evidence for base 1 (first press = 1): the UFO catcher moves at R2 == 1 on the first press, and the shortcut
    guard is `<2` [T].
  * Evidence for base 0: shiori-events.md §4.6 assumes it.
  * Settle it with a request logger on real SSP 2.9.
  * Until then, use base 1. With base 0, every held shortcut key would fire twice (R2 = 0, then 1).
* **Q2 (P0). Exact OnNotifyDressupInfo order in SSP.** This document requires scope-major, ascending group id
  (derived from how Tsubasa's loop behaves). If SSP used file order, her loop would stop early in SSP too. Verify with
  a logger.
* **Q3 (P1). `（起動時）` and `（単純起動秒）` reset on every page load.** They feed the "all-nighter" lines and the
  Black & White best times.
  * Option A: a Satori patch that takes `sec_count_at_load` from a value the runtime passes at init (session start).
  * Option B: accept the reset.
  * Resolved: option A as patch P7 (SUMMARY §2.1), counting from the ghost's last cold boot rather than the session start.
* **Q4. dsaudio volume curve.** `volume` 0–10000 is assumed to be linear, mapped to `HTMLMediaElement.volume = v/10000`.
  The DLL may use DirectShow attenuation (hundredths of a dB), which would make 5000 much quieter. It is also unknown
  whether `load` or `play` returns the tag Values in practice. [DS] says `load` does.
* **Q5. `\![updatebymyself]` without `updateurl`.** What does SSP actually raise (`OnUpdateFailure` with which R0)?
  The "none" emulation is a product decision to keep the "no homework" joke.
* **Q6. gomi `-n` reply layout** (`Result` = count, `Value0` = bytes) is inferred from Tsubasa's usage and the DLL
  strings. Unconfirmed, but it does not matter for the stub (both 0).
* **Q7. Is an empty Satori assignment a variable deletion?** The weather failure path depends on it (§3.7). It is
  consistent with `＄スタンプ帳動作` being cleared that way, but the exact rule was not read in the source.
* **Q8. Performance budget of a dictionary reload in WASM** (1–3 s estimated). Measure it once the engine builds. This
  decides whether the "respond, then reload" patch (P1) is needed.

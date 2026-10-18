# Sumika architecture

Sumika runs ghosts made for SSP, from their original files, inside an ordinary browser tab.

## Site layout (what gets deployed)

```
site/
  404.html                    "not found": with it, static hosts answer a missing file with 404 (Cloudflare Pages too)
  sumika/sumika.js            the only file pages include: <script src="/sumika/sumika.js" defer>
                              (holds its build id and the table of the hashed names below: core/build.js)
  sumika/build.json           the current build id, its stored-data schema and the same table (tools/build.mjs)
  sumika/hub.html             the storage hub (pages that load sumika.js with data-hub keep the visitor's data here,
                              in a hidden frame); a fixed name, loading the hashed sumika/engines/hub.<h>.js that
                              build.json names as `hub`
  sumika/hub.json             the hub's allowlist {format: 1, origins: [...]}: the publisher's, never built or pruned
  sumika/engines/worker.<h>.js   engine host (runs in a Web Worker): SHIORI engine + SAORI stand-ins
  sumika/engines/satori.<h>.js   Satori compiled with Emscripten (loader) ...
  sumika/engines/satori.<h>.wasm ... and its WebAssembly binary (+ satori.LICENSES.txt: the notices compiled into it)
  sumika/engines/yaya.<h>.js     YAYA (AYA5 / YAYA ghosts), likewise, with yaya.<h>.wasm and yaya.LICENSES.txt
  sumika/engines/kawari.<h>.js   Kawari 8.2.8 (Phase 8 ghosts), likewise, with kawari.<h>.wasm and kawari.LICENSES.txt
  sumika/engines/kawari7.<h>.js  Kawari 7.5.0 (Phase 7 ghosts, SHIORI/2.x), with kawari7.<h>.wasm, kawari7.LICENSES.txt
  sumika/engines/<e>.js, <e>.wasm   the plain names the engine builds write (+ *.build-info.json); tests and tools
                              load these, pages never do: npm run build copies them to the hashed names
  sumika/index/ghosts.json    ghost + balloon list, read on every page load   (all of index/: tools/index_site.py)
  sumika/index/ghost.<id>.<h>.json   one ghost's file list (with PNG sizes and each file's version)
  sumika/index/ghost.<id>.<h>.pack.gz   the ghost's text files in one gzip'd download (read before the server)
  sumika/index/balloon.<id>.<h>.json (+ balloon.<id>.<h>.pack.gz)   one shared balloon's file list (and text pack)
  ghost/<id>/                 ghost folders exactly as SSP has them (minus profile/, save data, logs, files SSP's runs
                              created, *.dll, *.exe)
  balloon/<id>/               shared balloons
```

Versions (safe updates, CONTRACTS loader.js, core/build.js and Site): `<h>` is 10 hex of the SHA-1 of the file's
bytes (the worker's without its trailing `sourceMappingURL` line: tools/hashname.mjs), so only `sumika.js` and
`ghosts.json` keep their names across versions; they name everything else. Ghost and balloon files keep their names;
fetch() asks for them as `?v=<8 hex>` from their manifest's `versions`, elements (`<img>`, CSS, `<audio>`) by their
plain URL. `tools/prune.mjs`, run before each upload, deletes the hashed files no upload needs any more (the last
upload's are kept 14 days).

## Repository layout

```
src/                 runtime source (plain ES2020 modules, JSDoc types) -> bundled to site/sumika/sumika.js
  main.js            entry: reads the <script> tag options, starts Runtime
  core/              runtime, loader, storage, SHIORI protocol client, event loop, which files an engine gets
                     (engine-files.js), the build's table of runtime files (build.js), stored-data versions
                     (schema.js)
  sakura/            SakuraScript tokenizer and player
  shell/             surfaces.txt parser, compositor, animation, character views
  balloon/           balloon skin parser, balloon views, input/communicate boxes
  ui/                right-click menu, launcher button, styles
src/worker/          engine host -> bundled to site/sumika/engines/worker.<h>.js
  worker.js          message loop; loads an engine module by name
  engines/           emscripten.js (shared ABI plumbing), satori.js, yaya.js, kawari.js and kawari7.js (adapters
                     around the Emscripten modules), ssproot.js (the SSP-shaped file system YAYA and Kawari share),
                     shiori2.js (the SHIORI/2.x bridge Kawari 7 is spoken to through, as ssp.exe does), index.js
                     (ENGINES), supported.js (what the page may ask)
  saori/             JavaScript stand-ins for SAORI DLLs (dsaudio, gomi, fill_desktop, httpc, yaya ...)
engines/satori/      build script + patches that compile vendor/satoriya-shiori to site/sumika/engines/satori.*
engines/yaya/        build script + patches that compile vendor/yaya-shiori to site/sumika/engines/yaya.*, smoke test
engines/kawari/      build script, patches and glue (em_kawari.cpp) that compile vendor/kawari-8.2.8 to
                     site/sumika/engines/kawari.*, smoke test (docs/research/kawari-wasm.md)
engines/kawari7/     the same for vendor/kawari-7.5.0 -> site/sumika/engines/kawari7.* (docs/research/kawari7-wasm.md)
engines/common/      the code page 932 table the engine builds share, checked against conversions measured on Windows
tools/               add_ghost.py, index_site.py, serve.py, build.mjs, hashname.mjs (the name hash), prune.mjs
                     (deletes the hashed files no upload needs; its ledger is site.published.json), env.sh (Node +
                     Emscripten on PATH), dll_harness.ps1 (runs a ghost's real SHIORI DLL; made tests/corpus/)
tests/               node --test unit tests + engine tests; real-DLL corpora in tests/corpus/ (Tsubasa's satori.dll,
                     emily4's yaya.dll; none for Kawari: no DLL is run): development material, not in the repository
docs/                this file, research/ specs
vendor/, toolchain/  third-party sources and the Emscripten SDK (not deployed; toolchain/ is not in the repository)
```

## Threads

* **Main thread** (sumika.js): DOM, rendering, input, SakuraScript playback, timers, storage.
* **Engine worker** (engines/worker.<h>.js): the SHIORI engine (WASM) with its virtual filesystem, plus SAORI
  stand-ins, which must answer synchronously because the engine calls them in the middle of a request.
  Stand-ins that need the page (sound, screen effects) post a fire-and-forget message to the main thread.
  One worker per ghost on screen.

* **Storage hub frame** (sumika/hub.html, only with `data-hub` on a page of another origin than the runtime's): a
  hidden iframe of the runtime host that holds the visitor's localStorage, sessionStorage, IndexedDB, Web Locks and
  BroadcastChannels for every allowlisted origin of the site, reached over one MessagePort per page (CONTRACTS "Hub
  protocol"). Being same-site, it runs in the page's own process and event loop in Chromium and Firefox. The page keeps
  a synchronous mirror of its localStorage and sessionStorage (core/hub.js); each engine worker gets its own store port
  to the hub's IndexedDB (core/portstore.js).

Satori parses ~3.6 MB of dictionaries at load, YAYA about 1 MB for emily4 (about 0.2 s), Kawari up to 2.3 MB (Aria,
about 0.46 s in Node; BTHver.5 about 0.18 s); doing that in a worker keeps the page responsive.

## Worker protocol (postMessage, structured clone)

Implemented by `src/worker/worker.js` (worker side) and `src/core/shiori.js` (main side); CONTRACTS.md has the summary.
Every main -> worker message carries an `id`, and its reply echoes it.

main -> worker

| message | meaning |
|---|---|
| `{t:'init', id, engine, engineUrl, wasmUrl, ghostDir:'/ghost/master/', files:[{path, data:ArrayBuffer}], resume, volatile, bootEpochMs, sessionEndMs, storeNamespace, storeKey, engineOpts}` | open the `Store` (`sumika`, key `ghost:<id>:files`) and read the persisted engine files from IndexedDB **inside the worker** (a stored record it cannot read: no save, and nothing stored for this page, so it is never written over); create the engine (with `engineOpts`, plain JSON: null for Satori; ghost id, placeholders and the site's ghosts and balloons for YAYA and Kawari, plus YAYA's module; its `.js` from `engineUrl`, the build's hashed `<engine>.<h>.js`, and its `.wasm` from `wasmUrl`, the hashed `.wasm` that Emscripten's `locateFile` answers; `wasmUrl` null: the `.wasm` next to the `.js`, as with the tests' plain names); write the ghost files, then the persisted files, into the virtual FS; set the uptime clock's zero to `bootEpochMs`, the ghost's last cold boot (P7: `Module.bootEpochMs`; 0 = none); call `load(ghostDir)`, or `satori_load_resume` / `yaya_load_resume` when `resume` is set and a save exists (Kawari: `load`, then the entry snapshot of the last page restored; the engine's `init` also gets `volatile` on a resume: YAYA and Kawari load cold when their dictionaries changed since; and `sessionEndMs` on a cold boot, the ghost state's `savedAt` or 0: the time Kawari's D6 closes a session that ended without an unload at, kawari-wasm.md §8); on a resume, restore the talk countdown from `volatile` (P6, SUMMARY §2.1). Satori gets `ghost/master`'s text files (paths relative to it); YAYA and Kawari the whole ghost root, text with bytes and the rest as empty placeholders (paths relative to the root, `ghostDir` unused; yaya-wasm.md, kawari-wasm.md) |
| `{t:'req', id, text, fmo?, kind?, self?}` | one SHIORI request (UTF-8 text, CRLF). `fmo`: the FMO text of the ghosts on screen (Satori P8, satori-wasm.md §8), set into the engine before the request (`engine.setFmo`, when it has one: Satori's sets `Module.fmoText`); the page sends it only when it changed since the last one this engine got (never with `init`). `kind` / `self`: which of ssp.exe's calls this is (`resource`, `translate`, `teach`, `communicate-user`, `communicate` with this ghost's name), for Kawari 7's SHIORI/2.x bridge (kawari7-wasm.md §6); the other engines ignore them |
| `{t:'persist', id}` | write the save data now (Satori: `satori_save`, patch P3; YAYA: `yaya_save`; Kawari: the snapshot of the entries the session changed and those its load made, `kawari_snapshot`, stored under the key `?kawari/resume.kis`) and store the changed files |
| `{t:'write', id, path, data:ArrayBuffer}` | write `path` (relative to `ghost/master/`) into the engine's file system, then store the changed files: a `\![execute,http-*]` download in `var/` (shiori-events.md §4.15) |
| `{t:'read', id, path}` | a file under `ghost/master/` as the engine has it (`--param-input-file`); null for a personal file, judged on the resolved path (`personalFile`, `src/core/engine-files.js`), and for any file the visitor's own run wrote (`visitorFile`: a save of any name, a rewritten shipped file, a download; every engine, since Kawari saves have no fixed names [decision]) |
| `{t:'unload', id}` | call `unload()` and store the files it wrote |
| `{t:'forget', id}` | delete the stored save data (a fresh start; the engine must be restarted afterwards) |

worker -> main

| message | meaning |
|---|---|
| `{t:'loaded', id, ok, hadSave, ms, ghostDir, error?}` | after init (`ok:false` with `error` when the engine failed to load); `ghostDir`: the engine's `ghost/master/` |
| `{t:'written', id, path}` | after `write`: the file's full path in the engine's file system (R3 of the HTTP events) |
| `{t:'read', id, data}` | after `read`: `ArrayBuffer`, or `null` when missing or outside `ghost/master/` |
| `{t:'res', id, text, ms, vol}` | SHIORI response text, engine time (the request and the worker's check for changed files after it, which runs before the reply), and the talk countdown `vol = {talkCount, sinceLastTalk, at}` (P6; `null` without the P6 exports), sent with every response |
| `{t:'persisted', id, files}` | after `persist`; `files` = names of the files stored |
| `{t:'unloaded', id, files}` | after `unload` |
| `{t:'forgotten', id}` | after `forget` |
| `{t:'saved', files}` | unsolicited: the worker stored changed files in IndexedDB (after load, after a request that wrote the save file, after a scheduled save) |
| `{t:'error', id, error}` | the message failed, or its `t` is unknown |
| `{t:'saori', name, cmd, args}` | side effect for the page (e.g. `dsaudio` play/stop/volume, `fill_desktop` colour flash) |
| `{t:'log', level, text}` | engine/stand-in log |

The worker decides when to save (WASM §7.3, SUMMARY C19): after GET requests and after user-action NOTIFYs
(`IMPORTANT` in worker.js), debounced 1 s; immediately after user actions and after replies with choices; at most every
30 s while one save costs more than 50 ms. It stores the files the engine wrote since the last check (by
modification time; YAYA's and Kawari's also by size, node and, for a file written in the millisecond of the last check,
its bytes; they look only after a request that wrote a file; Satori's rewritten dictionaries are never stored). Satori
and YAYA rewrite their save file on every save, so even a save that changed nothing stores it again: an idle ghost gets
a GET OnSecondChange every second, each one schedules the debounced save, so its whole stored map goes to IndexedDB
about once a second (every 30 s while a save is slow). Kawari's save is a snapshot of the dictionary entries the
session changed and those its load made, reported only when its bytes changed; but the KEEPS ghosts and bthver.5 count
seconds in an entry (`cnttalk`), so an idle Kawari ghost stores about once a second too (kawari-wasm.md §7, §8); after
Close the snapshot is an empty marker. YAYA keeps everything its ghost writes in its own folder, rewritten shipped
files too (they shadow the site's copy for that visitor), and deletions: `null` for a shipped file the ghost deleted
(so it stays deleted), and a file of its own that it deleted leaves the store (CONTRACTS.md "Worker protocol",
yaya-wasm.md). Kawari keeps files by the same rule.

## Main-thread modules and their contracts

An overview. The exact seams are in `docs/CONTRACTS.md` v2, which wins where the two differ.

### core/loader.js
```js
class SiteIndex { static async load(baseUrl): SiteIndex; ghosts; balloons; manifests; versions; ghost(id); balloon(id);
                  ghostFiles(id), balloonFiles(id): Promise<GhostFiles> }
class GhostFiles {           // one ghost folder (or balloon folder) on the server
  static async open(baseUrl, manifestUrl, {hashed}): GhostFiles
  has(path): boolean          // case-insensitive, '\' or '/' separators, './' and '..' resolved
  resolve(path): string|null  // -> real relative path from the manifest
  url(path): string           // absolute URL, each segment encodeURIComponent'd (what elements load: no query)
  versionedUrl(path): string  // url() + '?v=<hash>' from the manifest's versions (what fetch() loads)
  size(path): number          // from the manifest (-1 = not there)
  async text(path): string    // decodes Shift_JIS unless a UTF-8 BOM / 'charset,UTF-8' line is present
  async textOrNull(path)
  async bytes(path): ArrayBuffer   // from the text pack when it holds the file, else fetched
  list(prefix): string[]      // real paths under a folder prefix
  sub(prefix): GhostFiles     // a subfolder (a balloon bundled in the ghost), sharing the pack
  prefetch()                  // start downloading the text pack
}
```
Text files come from the folder's text pack (`ghost.<id>.<hash>.pack.gz`, one gzip'd download, browser-cached by its
hashed name); a file the pack lacks, or every file when the pack fails, is fetched on its own. Images are fetched
lazily (only when a surface is shown); the browser cache does the rest.
`ghosts.json` is fetched with `cache: 'no-cache'` on every page (a 304 when unchanged; offline, the stored copy); the
hashed manifests and packs, and every `?v=` fetch of a ghost file, with `force-cache` and one `reload` retry when the
copy is not what its name promises (CONTRACTS loader.js). An index whose `format` is newer than the runtime's
(`INDEX_FORMAT`) rejects with `index-newer`, also when it is the one a gone manifest's re-read finds. Index format 1,
with fixed manifest names `ghost.<id>.json`, is still read.

### core/storage.js
```js
class Store {                 // IndexedDB, falls back to localStorage, falls back to memory
  static async open(namespace): Store
  async get(key), async set(key, value), async delete(key)
  async read(key)             // get() that rejects when the storage cannot be read (the worker's save files)
}
```
The `Store` holds `ghost:<id>:files` (the engine's save files), in the IndexedDB database `sumika`; the
worker reads and writes it (a worker has no localStorage, so without IndexedDB the save data lasts only for the page).
The same database holds the files visitors drop on a ghost, `drop:<lower-cased path>` and `drop:index`, written by the
main thread (`core/drops.js`, TS §3.4). Everything else lives in Web Storage (`core/state.js`, schema in SUMMARY §2.5):
* localStorage `sumika:ghost:<id>:state`: one JSON object per ghost (surfaces, positions, dress-up, balloons,
  timers, the current run, open boxes, closed/minimized ...), debounced and written synchronously on `pagehide`;
* localStorage `sumika:runtime`: site-wide preferences (the active ghost `ghost`, the UI language `lang`);
* sessionStorage `sumika.session` marks "already booted in this tab": present -> resume silently; absent -> boot
  normally (OnBoot), as a fresh visit. `sumika.lastInputMs` is the idle clock.

Each record kind carries a version mark (`core/schema.js` `SCHEMA`: the state's and the prefs' `v`, the marker's `v`,
`drop:index`'s `v`; the save files' version is their key), read through one hook (`upgrade`) before any field. A
record newer than the page (an older cached page, an old tab) is read for what fits and never written (the tab marker
excepted: each page writes its own); for a ghost state or the prefs `Site.staleCheck` asks whether a newer Sumika is
published. The IndexedDB version stays 1.

With `data-hub` (the storage hub, CONTRACTS core/platform.js, core/hub.js and "Hub protocol") the same records, under
the same keys and versions, live at the runtime host's origin instead of the page's: core/platform.js is the one seam
every default storage, lock and channel comes from, so the code above is unchanged. A page whose hub is not usable
keeps them on its own origin, as without the attribute. Nothing is moved between the two.

### core/shiori.js
```js
class ShioriClient {          // wraps the worker; serializes requests (one at a time, FIFO)
  constructor(workerUrl, hooks: {onSaori, onLog, onSaved, onVolatile, onCrash})
  async start({engine, engineUrl, wasmUrl?, ghostDir?, files, resume?, volatile?, bootEpochMs?, storeNamespace,
               storeKey, engineOpts?})   // one options object
  async request({method:'GET'|'NOTIFY', id, refs:[], headers:{}}): ShioriResponse
  async persist(): string[]   // names of the files stored; stores also arrive as onSaved(names)
  async unload(): string[]; forget(); terminate(); get running
}
// ShioriResponse = {status:number, statusText, headers:Map(lower-case name -> value), value:string|null, ms}
```
Requests carry `Charset: UTF-8`, `Sender: SSP`, `SenderType: internal`, `SecurityLevel: local` (exact header set:
docs/research/shiori-events.md). A request that takes 2 s logs a warning; at 30 s the worker is terminated and
`onCrash(id)` lets the runtime restart it.

### core/events.js
Owns the clock and turns runtime state into SHIORI events: boot/resume sequence, OnSecondChange (with cantalk/idle refs),
OnMinuteChange, mouse events from character views, choice/anchor selections, input/communicate boxes, key presses.
Sends responses with a script to the player; the player reports busy/idle back.

### sakura/tokenizer.js, sakura/player.js
```js
tokenize(script): Token[]     // pure, unit-tested; unknown tags become {type:'unknown'} and are skipped
class ScriptPlayer {          // exact contract: CONTRACTS.md "SakuraScript"
  play(script, {event, refs}): Promise<PlayResult>   // {reason:'end'|'interrupted'|'quit'|'replaced', hasChoices, ...}
  interrupt()                   // a newer script replaces the current one
  get busy(); get choosing(); get timeCritical()
  runState(); replay(run)       // persistence and resume (SS §7)
}
```
The player drives the Stage, Balloons and Dialogs (below) and calls back into events.js (its `PlayerHost`) for
choices, raise/notify, timers.

### Stage (shell/ + balloon/)
Three objects, one per module; CONTRACTS.md v2 has their exact APIs.
```js
stage.char(scope)    -> CharacterView  // src/shell/stage.js, character.js: surface, binds, animations, position, hit test
balloons.get(scope)  -> BalloonView    // src/balloon/manager.js, view.js: one balloon per scope, next to stage.char(scope)
dialogs              -> Dialogs        // src/balloon/dialogs.js: inputBox(), communicateBox(), close()
```

### shell/
Pure modules (no DOM) are marked *pure*; each file's header comment cites its spec sections.
* `surfaces.js` *pure*: parse descript.txt + surfaces*.txt into a Shell model (surfaces, elements, animations, collisions, aliases, bind groups).
* `stage.js` Stage: the per-scope CharacterViews, dress-up state, persistence, the frame loop.
* `character.js` CharacterView: the glue plus the DOM (fixed-position canvas, clip-path, drag).
* `images.js` image loading (PNG + .pna, colour-key transparency), LRU cache.
* `compositor.js` *pure*: RGBA compositing; `render.js` *pure*: base construction and the layer list of a surface.
* `animator.js` *pure*: SERIKO/MAYUNA scheduling per interval type.
* `dressup.js` *pure*: MAYUNA bind state of one scope.
* `mouse.js` *pure*: pointer → MouseInfo sequences (down/up/click, drag, wheel).
* `hittest.js` *pure*: collision lookup. `layout.js` *pure*: character placement (base point, alignment).

### balloon/
* `index.js` module entry (re-exports).
* `skin.js` balloon skins: descript + per-image `*s.txt`, image choice per scope/side/`\b`, part and input-box images.
* `geometry.js` *pure*: descript semantics, derived text geometry, default fonts and cursor styles.
* `fallback.js` the procedural balloon for ghosts without one (BA §9).
* `manager.js` Balloons: one BalloonView per scope, placed next to its character; side, drag offset, saved state.
* `model.js` one balloon without DOM: kind and side, the visibility rule, layout, `\_b` options, links.
* `view.js` BalloonView: the DOM and canvases on top of the model, pointer input, dragging.
* `layout.js` *pure*: the layout engine (script operations in, display list out; word wrap, leading `\n`).
* `metrics.js` *pure*: MS Gothic advance widths, line height, blank/word/kinsoku character classes.
* `paint.js` canvas painter: balloon bitmap, images, text, scroll arrows, choice highlight.
* `rop.js` *pure*: Win32 ROP2 modes (kept for `ropFill`, off: SSP 2.9 draws only the pen, BA §3.8).
* `images.js` balloon part and `\_b` images (manifest lookup, never fetches a missing file), `bitmap.js` *pure*: pixel helpers.
* `color.js` *pure*: colour values of descripts and `\f[...]`.
* `placement.js` *pure*: where a balloon goes next to its character, and where input boxes go.
* `dialogs.js` input box, communicate box.

### ui/
* `menu.js` right-click menu built from SHIORI resources (UI §2, SUMMARY C26/C27/C29), SSP's items in SSP's orders
  (UI §2.11; CONTRACTS src/ui/menu.js). There is no Talk item (C27): ghosts provide their own.
* `launcher.js` small button to bring a minimized or closed ghost back.
* `thumbnail.js` the menu's thumbnail window: a ghost's thumbnail while its Change ghost ▸ / Call ghost ▸ row is
  selected, placed as ssp.exe places it (UI §2.14).
* `root.js` the Shadow DOM root, layer z-indexes and `addStyle`.

## Page navigation

Every link click reloads everything. On load:
1. read `ghosts.json` (rechecked on every page), choose the active ghost (stored, else `data-default-ghost`);
2. fetch its manifest and text pack (named by their hash, so browser-cached for good after the first visit), start
   the build's hashed worker;
3. the worker reads the stored engine files (save data) from IndexedDB and writes them into the virtual FS before
   `load()` (`satori_load_resume` / `yaya_load_resume` on a resume; Kawari: `load`, then its entry snapshot);
4. if this tab already booted (sessionStorage) -> restore surfaces/positions/dress-up and continue without OnBoot;
   otherwise run the boot sequence (OnBoot / OnFirstBoot).
Save data is persisted after requests that change it (cheap: Satori's save file is small, YAYA's `yaya_save` takes
about 1 ms for emily4, Kawari's snapshot at most 5 ms on the 18 corpus ghosts), never only at unload, because a page
can disappear at any moment.

With the storage hub a link to another origin of the site resumes the same way: the next page plants its own hub frame,
which sees the same localStorage, IndexedDB and (same tab) sessionStorage at the runtime host's origin. Its first start
waits for the hub's welcome (the site index loads meanwhile). Because a page's own posts to the hub are lost at its
pagehide, what pagehide writes is written earlier, at the click of a link to another page, a form sent, and
`beforeunload` (the leave-flush; the states then write through until the page is shown again), and the hub stamps the
ghost state's `savedAt` itself when the ghost's lock goes (a will).

A page may come from the browser's cache and be older than the published build. It runs on its own hashed files while
they are kept; when an engine start fails, the index's format is newer, or a stored ghost state or the prefs are
newer than it,
`Site.staleCheck` reads `sumika/build.json` and, if it names another build, fetches the new `sumika.js` and reloads
once (at most once per tab per build, and only once that bundle is in hand). The failed start never goes on, so the
stored set and the tab marker stay for the next page, which resumes them (CONTRACTS "Site").

## Compatibility posture

Unknown SakuraScript tags, SHIORI events and SAORI calls never throw: they are logged once and ignored or answered
with an empty/neutral result. Each ghost's needs are listed in a compatibility report written by hand;
`docs/research/tsubasa-needs.md` is the worked example.

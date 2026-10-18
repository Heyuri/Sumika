# Using Sumika on a site

How to run Sumika on a site: adding ghosts, the script tag, publishing, phones and browsers.

## What Sumika does

Sumika (住処, "home": a dwelling place), developed by Heyuri Applicable Research & Development, runs ukagaka ghosts — the desktop mascots made for SSP — inside an ordinary browser tab, from the ghosts' original
files. Each page includes one script:

```html
<script src="/sumika/sumika.js" defer></script>
```

The ghost appears in the bottom-right corner, talks, reacts to clicks, plays its games, and keeps its memory in the
visitor's browser. Following a link reloads the page; the ghost comes back where it was instead of greeting again.

Sumika runs Satori ghosts (tested with Tsubasa — となりの羽山さん — in its English translation, ハヤト,
猫になった日, カタリベカタリ and ルームメイトは変わり者 with two shells each, the dress-up ghost
Downer_Smoker_LegalLolita_Gothic_Surgeon, and エーテリズム with its own balloon), YAYA ghosts, AYA5 ones included
(tested with SSP's own Emily/Phase4.5 and her balloon, 梵鐘/MMOBPG and NodePsimoon), and Kawari ghosts of Phase 8
(BloodTeaHOUSE ver.5 with its balloon, also checked in a browser next to カタリベカタリ, and 同人屋稼業; not compared
with SSP) and of Phase 7 (SHIORI/2.x: まゆら＆黒うにゅう with her balloon wiz; not compared with SSP). A headless sweep
runs 247 Satori, 26 YAYA, 18 Kawari and 8 Kawari 7 ghosts. A site may hold several ghosts;
visitors switch between them, their shells, balloons and clothes like in SSP, and call several of them onto the page at
once. Their sounds and music play, MIDI files included (see [MIDI](differences.md#midi)); WMA files do not.

No ghost comes with Sumika: `site/ghost/` starts empty, and each site adds the ghosts it hosts (see [Adding a
ghost](#adding-a-ghost)). None of the ghosts named above is in this repository.

## Try it locally

First add a ghost, from its folder in an SSP install or from its `.nar` / `.zip` (see [Adding a ghost](#adding-a-ghost);
the [admin tool](#the-admin-tool) does the same in a browser page), then serve the site:

```bash
python tools/add_ghost.py C:/path/to/ssp/ghost/<name>   # a ghost folder
node admin/cli.mjs add C:/path/to/<ghost>.nar           # or a .nar / .zip, read as it is
python tools/serve.py
```

Then open the test page, http://localhost:8642/dev/ (`site/dev/index.html`; its link leads to a second page, where
the ghost should go on without greeting again). It names no ghost, so it starts the site's first ghost in Change
ghost's order (see [Several ghosts](#several-ghosts)). Without a ghost the test pages show nothing of
Sumika, and the browser's console says `this site has no ghosts (sumika/index/ghosts.json is empty)`. Add
`?sumika-debug` to see the runtime's log in the console; `?sumika-phone` treats a desktop window as a phone, with the
window's size standing for the phone's screen, and `?sumika-phone=0` a phone as a desktop; see [Phones](#phones).
The site itself has no page at its top
(http://localhost:8642/ lists its folders): your own pages go there, and the [admin tool](#the-admin-tool) previews
the site with test pages of its own.

## The admin tool

`sumika-admin` manages a site from your own computer, in English or Japanese, without Python: choose the site folder,
see its ghosts, add ghosts from any folder or `.nar` / `.zip` on the computer (several at once, chosen in your
system's own file and folder windows, which the program opens, or dragged from Explorer or Finder onto the page),
remove them, set up `sumika/hub.json` for pages on your other addresses, check the site, prepare an upload, and preview
the site locally.

The programs are not in the repository: `node admin/build.mjs` builds them (see [Building](building.md#building)), and a
release may carry them as downloads. `node admin/cli.mjs` runs the same core on the command line, with Node.

- **Start:** double-click `sumika-admin.exe` (Windows), `sumika-admin-macos-arm64` / `-macos-x64` (Mac) or
  `sumika-admin-linux-x64` (Linux). A small window opens and your browser shows the admin page. Any browser works.
- **Stop:** close that small window, or press Quit on the page.
- **Choosing files and folders:** "Choose .nar / .zip files…", "Choose folders…" (a ghost's folder, or a folder of
  ghosts such as SSP's `ghost` folder) and "Choose the site folder…" open the system's file window; what you pick is
  looked at at once, before anything is added. If you do not see the window, it may be behind the browser: the page
  says so and has a Cancel button. Where the program cannot open one (a Linux without `zenity` or `kdialog`), or when
  you press "Browse in this page instead", the page lists the computer's folders itself.
- **No answer:** when the program does not answer for a moment, the page says it is waiting and goes on by itself once
  it answers; after 20 to 30 seconds it says the program may be closed or stuck. If the small window is closed, start
  the program again (it opens a new tab).
- **Cut off mid-job** (the window closed, the program crashed): a ghost goes into `ghost/` only as a complete copy,
  and an old one is moved aside before it is deleted, so the site never holds half a ghost. The next start says what
  happened, whether the site changed, and the one thing to do, if any (for example "Finish adding", which updates the
  index). Problems the page could not show are written to `sumika-admin.log` in the program's temp folder
  (`%TEMP%\sumika-admin\` on Windows).
- **Sharing:** besides the list of your other addresses (`sumika/hub.json`), it makes the script line for your pages
  from your Sumika host's address, and shows the address of the page where visitors turn Sumika on or off for their
  own browser (`sumika/` on that host). Sumika itself never links to that page: link it from your pages. "When a
  visitor has not chosen" (Shown, Tucked as her button, Off) adds `data-default-state` to the line. The
  **Preview** opens that page too (a choice made there holds for the preview's own two test pages); its test pages
  always use the line without `data-default-state`.
- **Settings** (the site folder, recent places, the folder each file window last used, the language) are kept in
  `sumika-admin.json` next to the program, or in your user folder when the program's folder cannot be written; the
  Site screen says which. A new version in another folder starts without them: copy the file beside it to keep them.
- **Safety:** the program answers only your own browser on your own computer, through the address it opens; it never
  runs a ghost's programs, and it never copies the files that hold what a user told a ghost (the same rules as
  `add_ghost.py` below). A Kawari ghost whose files start like Kawari's save files can only be added from its `.nar`
  / `.zip`, not from a folder: in its archive those files are the author's starting files.
- **Warnings:** the programs are not signed. A downloaded `.exe` may show "Windows protected your PC" (choose More info,
  then Run anyway); on a Mac, open it once, then allow it in System Settings → Privacy & Security → Open Anyway. The Mac
  and Linux programs have not been tested on a Mac or Linux.

The Python tools below keep working and give the same results.

## Adding a ghost

```bash
python tools/add_ghost.py C:/path/to/ssp/ghost/<name>
```

This copies the ghost into `site/ghost/<name>/` without the files a website must not have — `profile/` folders and
the engine's save files (`satori_savedata*`, `satori_savebackup*`, YAYA's `*_variable.*`) hold whatever the SSP user
told the ghost (names, birthdays), and engine logs (`*.log`) record the requests — and without DLLs and EXEs, which
never run in a browser. Then it rebuilds the index. If you copy folders by hand, run `python tools/index_site.py`
afterwards: browsers cannot list folders on a web server, so the index is how the runtime finds ghosts and files. It
refuses to index while any of those personal files are in `site/`. Re-run it after any change under `site/ghost/` or
`site/balloon/`: the index records file sizes and packs the text files, so the runtime does not see changes until then.

A ghost that has run in SSP may also hold files its runs wrote (a downloaded counter, notes, a playlist written over
a shipped one). To find them, give the ghost's original archive or update list: `python tools/add_ghost.py <ghost>
--archive <its .nar/.zip or updates2.dau>` compares the two by file names and contents (the archive's CRC-32s, the
list's MD5s, and sizes) and copies nothing while the installed folder has a file the original does not list, or holds
with other bytes. Add each such file to `PERSONAL_PATHS` in `tools/index_site.py` and in its twin
`admin/core/rules.mjs` (then neither tool lets it onto the site; `npm test` fails while the two differ), name a
legitimate one with `--keep <path>`, or leave it out of this copy with `--skip <path>`.

Kawari ghosts name their save files themselves (`savefile1.txt`, `dict-keeps-savedata.txt`, …), so for them the
archive comparison is the rule. As a second net, the index refuses a Kawari ghost's file that starts with Kawari's
save header, and `add_ghost.py` copies nothing from a ghost folder while such a file is there: in an installed ghost
it may keep what a user told the ghost. In the ghost's own archive such a file is the author's starting file, so a
Kawari ghost that has them is added from its `.nar` / `.zip`: extract the archive into a new empty folder and run
`python tools/add_ghost.py <that folder> --id <name> --archive <its .nar> --from-archive` (`--from-archive` says the
folder is that archive's extraction). The files the archive holds as they are are then copied and recorded with their
checksums in `site/sumika/kawari-shipped.json`, and the index accepts them while they stay unchanged (or while
`KAWARI_SHIPPED_SAVES` in `tools/index_site.py` and `admin/core/rules.mjs` lists them, as it does mayura's). That
file names only the authors' files and their checksums; it is uploaded with the rest. An editor's byte-order mark in
it is fine; if it cannot be read otherwise, `add_ghost.py` and `index_site.py` stop before changing anything: repair
it, or delete it and add those Kawari ghosts again from their archives. `add_ghost.py` also prints the
names the ghost's `install.txt` keeps on a refresh install (`refreshundeletemask`, often the author's list of saves).
Any other ghost you have not installed can be added from its archive the same way.

With Node instead of Python, `node admin/cli.mjs add <folder | .nar | .zip>` (with the same `--id`, `--archive`,
`--keep` and `--skip`) does what `add_ghost.py` does, file for file, and reads a `.nar` / `.zip` as it is, with no
extraction first; `node admin/cli.mjs index` does what `index_site.py` does. The admin tool uses the same code.

SSP moves a balloon that comes with a ghost into its own `balloon/` folder. When the ghost's `install.txt` names one
(`balloon.directory`) that the ghost folder lacks, `add_ghost.py` copies it from there into the site ghost, so the
ghost keeps it; it never deletes a site ghost whose bundled balloon it cannot copy again.

Only host ghosts whose authors allow redistribution.

## Several ghosts

Every ghost in `site/ghost/` that the index lists is offered in the right-click menu under **Change ghost**, by the name
in its `descript.txt`, sorted by that name as SSP sorts it (case-insensitive, katakana with hiragana, numbers by
value; one name twice: by folder). As in SSP, the running ghost says goodbye (OnGhostChanging), the new one comes
in with OnGhostChanged (or its first-meeting talk when this visitor has never met it), and a double-click on the
goodbye balloon calls the change off. Ghost scripts can switch too (`\![change,ghost,<name>]`, `\+` random,
`\_+` next). Each ghost keeps its own memory in the visitor's browser, so switching back finds it as it was.

- Other open tabs of the site follow a switch, and the next page shows the ghost the visitor switched to, even when
  the link was followed while the old ghost was still saying goodbye.
- A first-time visitor meets the page's `data-default-ghost`, else the first ghost in that menu order that can run
  here; ghosts whose engine the runtime lacks are skipped.
- Ghosts whose engine the runtime does not have (the older AYA…) are listed but greyed out with the reason, e.g.
  "needs AYA". Kawari Phase 7 ghosts run on Kawari 7.5.0, spoken to in SHIORI/2.x as SSP does.

**Call ghost** in the menu (SSP's "他のゴーストを呼ぶ") brings a second ghost next to the first, and a third; ghost
scripts call with `\![call,ghost,<name>]`. As in SSP, the caller may say something first (OnGhostCalling), the new
ghost comes in with OnGhostCalled (or its first-meeting talk), and when it has finished talking the caller hears that it
arrived (OnGhostCallComplete; the others OnOtherGhostBooted). Each ghost talks on its own, has its own menu, balloons
and launcher, and comes in front of the others when clicked; keys go to the one clicked last.

- **Close** sends that ghost away; the others hear of it (OnOtherGhostClosed). **Quit** sends every ghost away at once,
  and the launcher brings them all back. Changing ghosts in one ghost's place keeps the others (OnOtherGhostChanged).
- The ghosts on screen talk to each other as in SSP: a line that names another ghost (Satori's `→` lines, a reply's
  `Reference0`) goes to it when it has been said (OnCommunicate), and its answer can go back. Satori ghosts see who
  else is there (`（FMO1name）`, `（Xの存在）`), and ghosts raise events in each other (`\![raiseother]`,
  `\![notifyother]`, kanade's tea party). An answer cuts what the other ghost was saying, as in SSP.
- The ghosts on screen are kept as a set in the visitor's browser: the next page brings them all back at once, a new
  tab one after the other. Only one tab runs them; other tabs show them still and take the whole set over when the
  visitor turns to them.
- As in SSP, there is no limit on how many ghosts are on screen at once; `data-max-ghosts="<n>"` on the script tag sets
  one (1: one ghost at a time, no Call ghost).
- Pages can do the same with `window.sumika`: `ghosts()` (every ghost of the site, with `running` and `active`),
  `running()` (the ghosts on screen), `callGhost('<folder>')`, `closeGhost('<folder>')`, `quit()`,
  `changeGhost('<folder>', {from: '<folder>'})`; `shells`, `balloons`, `changeShell` and `changeBalloon` take
  `{ghost: '<folder>'}` (without it they act on the ghost with the keys, else the first). Calls and changes work only
  in the tab that runs the ghosts (elsewhere they answer `false`); after Quit, `callGhost` or `changeGhost` brings
  back that one ghost.

## Site layout

```
site/
  404.html                    the "not found" page; keep it at the top level (see Publishing)
  dev/                        development pages, never uploaded: the test pages index.html and page2.html, and
                                pages that load the runtime's source (see Publishing)
  sumika/sumika.js            the runtime (the only file pages include)
  sumika/build.json           which build is current: its id and the names below
  sumika/hub.html             the storage hub, for pages on other sites (see Pages on other sites); it loads
                                engines/hub.<code>.js
  sumika/hub.json             not built, not in the repository: your list of the other sites' pages the hub answers
                                (only if you use it)
  sumika/index.html           the control page, where visitors turn Sumika on or off for their browser (see Turning
                                Sumika on or off); it loads engines/control.<code>.js
  sumika/engines/             the engine worker and Satori, YAYA, Kawari and Kawari 7 compiled to WebAssembly:
                                worker.<code>.js, satori.<code>.js + satori.<code>.wasm, …   what pages load
                                satori.js + satori.wasm, …                                   for the tools only
                              and the MIDI player: midi.<code>.js and its sound bank generaluser_gs.<code>.sf3.gz,
                                loaded only when a ghost first plays a MIDI file (see MIDI in differences.md)
  sumika/word_compatible.txt  SSP's own word list for %ms-style words no ghost answers: optional, not in the
                                repository; copy it from an SSP install (see licenses.md)
  sumika/index/               generated: ghosts.json (the ghost list) and, per ghost and balloon,
                                ghost.<id>.<code>.json (its file list), ghost.<id>.<code>.pack.gz (its text files);
                                the repository holds the index of its own site (no ghost, the default balloon)
  ghost/<id>/                 ghost folders as SSP has them (none in the repository: see Adding a ghost)
  balloon/<id>/               shared balloons (ghosts may also bring their own)
```

`<code>` is ten letters and digits taken from the file's contents, so a changed file gets a new name and an unchanged
one keeps its name (and its place in visitors' browser caches). Pages never load the engine files without a code in
their names (`satori.js`, `yaya.wasm`, …): the engine builds write those, the tests and tools read them, and
`npm run build` copies them to the coded names.

Ghosts that bring no balloon of their own get the site's default balloon, `balloon/sumika/` (as SSP gives them the
user's default balloon). The index records it; `data-default-balloon="<folder>"` on the script tag picks another
shared balloon. A balloon a ghost brings is offered to every ghost of the site (SSP installs it for all of them).

## Script options

Every option of the script tag is optional:

| Option | What it does |
|---|---|
| `data-default-ghost="<folder>"` | the ghost a first-time visitor meets; without it, the first ghost in Change ghost's order that can run here (see [Several ghosts](#several-ghosts)) |
| `data-default-balloon="<folder>"` | the shared balloon (`balloon/<folder>/`) for ghosts that bring none; without it, the one the index records, `balloon/sumika/` (see [Site layout](#site-layout)) |
| `data-max-ghosts="<n>"` | the most ghosts on screen at once; without it, no limit, as in SSP; `1`: one ghost at a time, no Call ghost (see [Several ghosts](#several-ghosts)) |
| `data-base="<url>"` | the site's root, when the runtime is not at `<root>/sumika/sumika.js` (see [Publishing](#publishing)) |
| `data-autostart="0"` | the ghosts do not start by themselves: page code starts them with `window.sumika.start()` |
| `data-phone="tucked"`, `data-phone="off"` | phones only: start as her icon, or no Sumika at all (see [Phones](#phones)) |
| `data-hub`, `data-hub="<url>"` | one visitor across your sites through the storage hub (see [Pages on other sites](#pages-on-other-sites)) |
| `data-default-state="tucked"`, `data-default-state="off"` | what a visitor who made no choice gets (see [Turning Sumika on or off](#turning-sumika-on-or-off)) |

## Publishing

Upload the contents of `site/` to the root of any static web host, except `site/dev/` (development pages: the test
pages, and pages that load `src/` and only work when the whole project is served). No server code and no host settings
are needed: GitHub Pages, Netlify, Cloudflare Pages or a plain nginx or Apache serve it as they come. Your pages go
beside it. The line at the top of this file loads `/sumika/sumika.js` from the site root; to host under a subpath,
make that `src` relative (the runtime finds the site from its own URL, or from `data-base`).

**Your site is not in git.** This repository's `.gitignore` keeps a site's own files out of it: the ghosts
(`site/ghost/*`), what adding them writes into `site/sumika/index/` (everything there but the empty site's
`ghosts.json` and the default balloon's `balloon.sumika.*` files), `sumika/hub.json`, `sumika/word_compatible.txt`,
`sumika/kawari-shipped.json`, and the ledger `site.published.json` (below). So a host that publishes from a clone or
fork of this repository (GitHub Pages, or Netlify or Cloudflare Pages linked to the repository) publishes no ghosts,
and a `ghosts.json` committed with ghosts in it names files that never reach the host. Upload a copy of your `site/`
folder instead, keep your site in a repository or branch of its own, or delete those lines from `.gitignore` in your
fork.

Updates are safe on every such host, whatever its caching. Files whose names carry a ten-letter code
(`worker.3f2a….js`, `ghost.tsubasa.1a2b….json`) belong to one version and never change: visitors' browsers keep
them, and an update only adds new ones. Ghost and balloon files keep their own names; the index records a code for each,
which the runtime adds to the address it fetches (`surface0.png?v=…`). Only `sumika/sumika.js`,
`sumika/index/ghosts.json`, `sumika/hub.html` and `sumika/index.html` keep their names from one version to the next,
and they name everything else, so a browser never mixes the files of two versions. A visitor whose browser still has an older version keeps running it,
complete; if its files have been removed meanwhile, the page reloads once into the current version, with the same
ghosts on screen.

- **Before each upload** run `npm run build` and `python tools/index_site.py` (see [Building](building.md#building) and
  [Adding a ghost](#adding-a-ghost)), `npm test`, then `node tools/prune.mjs` (`--first` the very first time).
- **Old files.** `prune.mjs` keeps the files of the version you uploaded last for 14 days after this upload, so
  visitors with an open tab or an older copy in their browser keep working; it deletes those of older versions once
  their 14 days are over, and those of builds you never uploaded at once. It deletes nothing while a file the current
  version needs is missing, or while `sumika/sumika.js` is not the one `sumika/build.json` describes (a build that
  did not finish). It remembers what you uploaded in `site.published.json`, next to the `site/` folder: don't upload
  it, and don't lose it (git does not keep it: the repository's `.gitignore` leaves it out; if it is lost, run `node tools/prune.mjs --retire-all` once; if it cannot be read,
  `prune.mjs` stops: restore it, or delete it and run `--retire-all` once). After the upload you may delete
  from the host whatever is no longer in your `site/` folder; leaving it longer does no harm.
- **The upload order.** On a host that publishes a whole folder at once (GitHub Pages, Netlify, Cloudflare Pages),
  order does not matter. If your host takes files one at a time (FTP), upload everything else first, then
  `sumika/index.html`, then `sumika/hub.html`, then `sumika/sumika.js`, then `sumika/index/ghosts.json` last. This
  order is required.
- **Keep `404.html`** at the top level (restyle it as you like): some hosts need it to answer "not found" for a
  missing file. Without it, Cloudflare Pages answers every missing address with your front page, and an old file that
  is gone would not look gone.
- **You may leave out** the `.map` files (they only help debugging, and contain the runtime's source) and the engine
  files without a code in their names (`satori.js`, `yaya.wasm`, …). Keep the `*.LICENSES.txt` files (see
  [Licenses](licenses.md)).
- **Don't** set a CDN in front of the site to ignore query strings (`?v=…`).
- **Don't roll back past a change of the stored data.** Each release records the version of what it stores in
  visitors' browsers. Don't use your host's one-click rollback (or a git revert) to go back past a release that raised
  it: visitors' browsers would hold data the older release can only read, and their ghosts would stop saving. Publish
  the older behaviour as a new build instead; `npm run build` refuses to build a lower version than the last one. No
  release has raised it yet.

Two things are not versioned. Ghost files keep their names, so a visitor who keeps a tab open while you update a
ghost may get a picture of that ghost it had not shown yet in its new version, until the next page. And files the
browser loads by itself (menu skins, cursors, the launcher icon, sounds) keep their plain addresses, so after an update
a browser may show its stored copy until its own cache lets it go, as on any site.

### Pages on other sites

Pages on other addresses can load the runtime from your Sumika host, for example pages on `a.example.com` and
`b.example.com` with Sumika on `sumika.example.com`:

```html
<script src="https://sumika.example.com/sumika/sumika.js" defer></script>
```

**Allow cross-origin reads.** The runtime fetches the ghost list, the ghosts' files, the engines and the MIDI player
from its own host, so that host must send `Access-Control-Allow-Origin: *` with its files (all of them is simplest; at
least everything under `sumika/`, `ghost/` and `balloon/`). Without it the page shows no ghost, and the browser's
console names the blocked request. GitHub Pages sends it already. On Netlify and Cloudflare Pages, put a file named
`_headers` at the top of the upload:

```
/*
  Access-Control-Allow-Origin: *
```

On nginx: `add_header Access-Control-Allow-Origin "*" always;`. On Apache: `Header always set
Access-Control-Allow-Origin "*"`. Sumika ships no `_headers` file, because each host has its own way.

**One visitor across your sites (`data-hub`).** Browsers keep what a page stores per address, so without more, the
ghost on `a.example.com` and the ghost on `b.example.com` are two separate copies: a link from one to the other starts
her again instead of resuming, and the two sites' tabs do not know about each other. Add `data-hub` to the script tag
to change that:

```html
<script src="https://sumika.example.com/sumika/sumika.js" data-hub defer></script>
```

The runtime then keeps all of the visitor's Sumika data (the ghosts' memories and places, the dropped music, which
tab runs the ghosts) at the Sumika host, in a hidden frame of `sumika/hub.html`, the storage hub. A link from
`a.example.com` to `b.example.com` resumes the ghost where she was, and tabs on both sites work together as tabs of one
site do. `data-hub` with no value means the `hub.html` next to `sumika.js`; `data-hub="https://…/hub.html"` names
another hub page by its full address. Pages on the Sumika host itself need no `data-hub`: they already share the
hub's data.

- **The list of your pages: `sumika/hub.json`.** The hub answers only the addresses you list in this file, which you
  write and upload yourself next to `hub.html` (no build writes it, and `prune.mjs` never touches it):

  ```json
  {"format": 1, "origins": ["https://a.example.com", "https://b.example.com"]}
  ```

  Each entry is an exact address: the scheme (`https://`, as the hub's own), the host, and the port if it is not the
  usual one; no path, no `*`. Without the file, the hub answers no page. **Every address you list can read and change all of a visitor's Sumika data for
  the whole site**, so list only your own pages. An address you remove is refused from the next page of a new tab, and
  within 5 minutes in a tab already open. `npm test` fails while `site/sumika/hub.json` lists a test address
  (`localhost`, `127.0.0.1`) or something the hub cannot use.
- **One site only.** Browsers let the hub share its storage only with pages of the same site: `a.example.com` and
  `b.example.com` (or `example.com` itself) yes; `example.org` with `example.com` no; two users' `*.github.io` pages
  no; a page shown inside a frame of another site no. Safari, and every browser on an iPhone or iPad, is expected to
  keep a frame's storage per page address even within one site (not tested), so there each of your addresses
  would keep its own copy, as without `data-hub`.
- **When the hub cannot be used** (an address not listed, another site, no answer from the hub, the visitor's settings),
  the page keeps the visitor's data on its own address, exactly as without `data-hub`: the ghost there does not know
  what she did on your other sites. With `?sumika-debug` the console says why.
- **Frames.** Your pages show `hub.html` in a frame, so the Sumika host must not forbid that for it (no
  `X-Frame-Options`; a `frame-ancestors` that lists your sites, if you send one, which is good hardening for
  `hub.html`). A page with a Content-Security-Policy adds the Sumika host to it: `script-src https://sumika.example.com
  'wasm-unsafe-eval'; connect-src https://sumika.example.com; img-src https://sumika.example.com; media-src
  https://sumika.example.com blob:; worker-src blob:; style-src 'unsafe-inline'; frame-src https://sumika.example.com`
  (see [Browsers](#browsers) for why each is needed).
- **Turn it on before your first visitors.** Turned on later, visitors' ghosts start afresh on the hub; what their
  browser kept for each page's own address stays there, and comes back if you turn the hub off again.
- **Upload order** on a host that takes files one at a time: as above, `sumika/hub.html` after everything else (and
  after `sumika/index.html`) and before `sumika/sumika.js`.
- **Privacy.** The data stays in the visitor's browser, under the Sumika host's address. To check that it may share
  storage with the page, the hub sets one cookie for a moment and deletes it at once.

To try it on one computer, serve the Sumika host with both options and the pages on other ports:
`python tools/serve.py --port 8643 --cors --hub-allow http://localhost:8644 --hub-allow http://localhost:8645`
(`--hub-allow` answers `sumika/hub.json` with the addresses given and writes no file, so a test list is never
uploaded). Ports on `localhost` count as one site; `a.localhost` and `b.localhost` do not, but `a.test.localhost` and
`b.test.localhost` do. `127.0.0.1` is another site than `localhost`. `site/dev/elsewhere.html` is such a page: serve
`site/` on ports 8644 and 8645 as well (`python tools/serve.py --port 8644`, the same with 8645) and open
`http://localhost:8644/dev/elsewhere.html?next=http://localhost:8645`. It loads `sumika.js` from port 8643 with
`data-hub` (`?hub=0` leaves it out, `?runtime=` names another `sumika.js`), links to itself on the `next` address,
and has a button that makes her talk for a while, so you can follow the link mid-sentence.

## Turning Sumika on or off

Two things decide what a visitor gets on a page: what the page asks for, and the visitor's own choice for their
browser.

**Your default: `data-default-state`** on the script tag, for visitors who made no choice:

| Option | What such a visitor gets |
|---|---|
| none, or `data-default-state="enabled"` | the ghost, as always |
| `data-default-state="tucked"` | her icon in the bottom-right corner, on every device; a click or tap brings her out (as `data-phone="tucked"` does on phones). Once out, she stays out on the next pages of that tab |
| `data-default-state="off"` | nothing: no ghost, no icon, nothing stored, nothing downloaded but `sumika.js`, until the visitor turns Sumika on |

An unknown value counts as `enabled` (the console says so once). Each page has its own, so your front page may show
her while your other pages keep her tucked.

**The visitor's choice: the control page.** `sumika/index.html`, at `https://<your Sumika host>/sumika/`, offers each
visitor three choices for their browser: **Site default** (what your pages ask for), **On** (the ghost on every page
that has Sumika, also where your default is tucked or off) and **Off** (no ghost and no icon on any page, nothing
stored, nothing downloaded but `sumika.js`). It speaks English or Japanese, after the browser's languages, saves at
once, and says that pages opened or reloaded from then on follow it (a page already open stays as it is). Off keeps the
ghosts' memories, so turning Sumika on again carries on where they were. In a browser that does not let the page store
anything, it says the choice cannot be kept there. Sumika itself never links to it (no menu item, nothing on her icon):
link it from your own pages, for example a "Ghosts on or off" link in your footer. It loads one small script of its
own and nothing else; a Content-Security-Policy on the Sumika host must allow it `script-src 'self'` and, for its
`<style>`, `style-src 'unsafe-inline'`.

**Which pages follow the choice.** It is kept in the visitor's browser under the Sumika host's address, so it reaches
the pages that keep their Sumika data there:

- pages on the Sumika host itself;
- pages on your other sites with `data-hub` (see [Pages on other sites](#pages-on-other-sites)): one choice on the
  control page covers all of them (a `data-hub` that names a hub page on another host by its full address: the
  control page next to that `hub.html`). Such a page asks the hub before anything of Sumika appears, so it still loads the
  hub's hidden frame, and while the hub answers it loads the ghost list (one small file) unless its own default is
  `off`; when the answer is Off, that is all, and the frame goes again. When the hub cannot be used, the page follows
  the choice kept under its own address (normally none: your default);
- not pages on other sites without `data-hub`: they keep their data under their own address, which the control page
  cannot reach. In Safari (and every browser on an iPhone or iPad) the hub is expected to keep its data per page
  address, as said above, so there the choice may not reach your other sites either (not tested).

**What comes first.** On a phone, `data-phone="off"` turns Sumika off whatever the visitor chose, and a browser that
cannot run Sumika gets nothing (see [Browsers](#browsers)). On a phone with `data-phone="tucked"`, On still starts her
as her icon: that is your layout for phones.

**Page code** can ask `window.sumika.state`: the state the page started in, `'enabled'` or `'tucked'`, or `'off'` when
Sumika does nothing on the page. Then `window.sumika.reason` says why (`'visitor'`: the visitor's Off; `'site'`: your
`data-default-state="off"`; `'phone'`: `data-phone="off"`; `'unsupported'`: the browser), `window.sumika.site` and
`window.sumika.runtime` are `null`, and every call does nothing. With `data-hub` the state is `null` until the first
start has heard from the hub; when the answer is Off, `window.sumika` is replaced by the one that does nothing (and
the earlier object does nothing either).

## Phones

On a phone (touch is the main input and the screen's short side is under 600 CSS px; tablets count as desktops):

- the characters start smaller, so that the ghost fits on the screen;
- a balloon with no room beside its character goes above her head, and its text stays readable;
- the text boxes (input, communicate) and the Preferences box stay above the on-screen keyboard.

A visitor's own Shell scaling and Balloon scaling picks in the menu win over these. On a desktop, nothing changes,
whatever the size of the window.

For this, the page needs `<meta name="viewport" content="width=device-width, initial-scale=1">` and the script tag
with `defer`, as in the example at the top. A page without that meta is shown shrunk by the phone's browser and keeps
the desktop sizes.

One option on the script tag changes what happens on phones only:

| Option | On a phone |
|---|---|
| `data-phone="tucked"` | the ghost starts as her icon in the bottom-right corner; a tap brings her out. Once out, she stays out on the next pages of that tab |
| `data-phone="off"` | Sumika does nothing at all: no ghost, no icon, nothing stored |

With either option, a desktop behaves as without it. Pages can ask `window.sumika.phone`: `null` on a desktop or
tablet, else `'on'`, `'tucked'` or `'off'`. When it is `'off'`, `window.sumika.site` and `window.sumika.runtime` are
`null` and every other call does nothing. `data-default-state` and the visitor's choice (see [Turning Sumika on or
off](#turning-sumika-on-or-off)) apply on phones too; `data-phone="off"` wins over both.

What "off" still costs a phone is the download of `sumika.js` itself (about 1.3 MB, 350 KB gzip-compressed; the
minified build from `npm run build:min` about 620 KB, 200 KB compressed).

## Browsers

Sumika runs in Chrome and Edge 95 (October 2021) and later, Firefox 100 (May 2022) and later, on desktops and
Android, and Safari 15.2 (December 2021) and later on Mac, iPhone and iPad; also Opera 81 and Samsung Internet 17 and
later. On iPhone and iPad most browsers use Safari's engine, so they count as Safari; Sumika checks what a browser can
do, not its name. What sets these versions is the way the ghosts' engines handle errors inside WebAssembly.

An older browser, or one with WebAssembly turned off (Lockdown Mode on an iPhone or Mac, some security settings),
shows the page exactly as it is: no ghost, no message, nothing stored, nothing downloaded but `sumika.js`. The
browser's console says what is missing. Page code that talks to Sumika should first check `window.sumika &&
window.sumika.site`: in such a browser `window.sumika.site` is `null`, `window.sumika.supported` is `false` and
`window.sumika.missing` lists what is missing (`'wasm'`, `'wasm-features'`, `'wasm-compile'`, `'BigInt64Array'`,
`'createImageBitmap'`), and every call does nothing; browsers older still (before Chrome 80, Firefox 74 and Safari
13.1, from 2020) cannot read `sumika.js` at all, and `window.sumika` stays undefined.

A host that sends a Content-Security-Policy must allow WebAssembly and the engine's worker:
`'wasm-unsafe-eval'` in `script-src` (Chrome 97, Firefox 102, Safari 16 and later; the browsers before them need
`'unsafe-eval'` instead) and `worker-src blob:`. For example `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'
blob:`. Without them the ghost does not appear, and the console names the policy. A policy with `default-src` (or
`style-src`) must also allow `style-src 'unsafe-inline'`, because Sumika styles its own elements with `<style>`
elements (without it the ghost appears in the wrong place, her balloons and menus unstyled), and `media-src blob:`
for sounds dropped on a ghost: for example `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src
'self' blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:`. Under such a policy a ghost's web requests
to other sites and its banners from the web are refused too (`connect-src`, `img-src`), as they often are anyway.
The MIDI player (see [MIDI](differences.md#midi)) needs nothing more: it is loaded from `sumika/engines/` as a worker
and as an audio worklet (`script-src 'self'`, the worker through `blob:` as the engines' is), and the sound bank and the
ghosts' MIDI files are plain fetches from the site (`connect-src`, covered by `default-src 'self'`).

MIDI also needs a secure page: `https://`, or `http://localhost` while testing. Browsers offer the audio worklet the
synthesizer runs in only there, so on a plain `http://` site a ghost's MIDI files stay silent. If your pages load
`sumika.js` from another host (a CDN, or your Sumika host from your other
sites), that host must allow cross-origin reads (CORS) of its files: the ghost list and files, the engines'
WebAssembly, the MIDI player (loaded as an audio worklet module) and the MIDI sound bank are all fetched from it,
cross-origin requests from the page. Such a page's policy names that host in `script-src`, `connect-src`, `img-src`
and `media-src`, and with `data-hub` in `frame-src`; see [Pages on other sites](#pages-on-other-sites).

In Safari, and on phones in general:

- A sound waits for the visitor's first tap or key on the page (every browser blocks sound before that). On an iPhone
  a ghost cannot change the volume: iOS keeps media at the device's volume. MIDI music is the exception: it plays
  through the browser's audio engine, where a ghost's volume works on an iPhone too.
- An iPhone's ring/silent switch does not mute a ghost's sounds. MIDI music follows that from iOS 16.4 on (Sumika asks
  for playback audio while it plays); on iOS 15.2 to 16.3 the silent switch mutes MIDI music, though not the other
  sounds.
- Safari deletes a site's stored data (the ghosts' memories and places) after seven days of use without a visit.
- When a phone runs out of memory for drawing (several ghosts on an older iPhone), a ghost that cannot be drawn leaves
  the page, as if it had failed to start, instead of standing there half drawn; the others stay. Sumika can tell only
  when a character or balloon is first drawn: if the memory runs out later, when a ghost's picture changes size or a
  balloon grows or is scaled, that part may stay invisible while it still answers taps.
- Safari before 16.4 and Firefox before 113 download a ghost's text files one by one, which makes the first visit
  slower.

## Language

The runtime's own menu items, buttons and labels come in Japanese or English, switched like in SSP with **Language** in
the right-click menu (Japanese, English, or Use System Lang., which follows the browser's languages). The menu uses
SSP's own captions in each language, e.g. "ゴースト切り替え(G)" / "Change ghost"; what the ghost itself puts in the menu
and everything it says stay as the ghost wrote them. The choice holds for the whole site and is kept in the visitor's
browser. Ghosts are told with OnLanguageChange, at every boot and when the language changes.

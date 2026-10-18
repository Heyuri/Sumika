# SSP user-facing behavior for a browser runtime (and lessons from Ikagaka)

Status: research spec, implementation-ready. Scope: what SSP *does* around a ghost (menus, placement, balloons,
talk scheduling, input boxes, idle behavior), how each maps to a browser page, plus the earlier browser
baseware Ikagaka. File formats (surfaces.txt, balloon descript, SakuraScript grammar, SHIORI protocol) are
covered by other research docs; this one only touches them where behavior depends on them.

Priority marks: **P0** = Tsubasa needs it, **P1** = common in other ghosts, **P2** = rare.
Confidence marks: **[doc]** stated in UKADOC/SSP help, **[res]** read from SSP 2.9.08f's own files,
**[src]** read from source code (Satori / ninix-kagari / Ikagaka), **[corpus]** counted in Tsubasa's
ground-truth responses, **[infer]** an inference, **[?]** unknown, needs a check in real SSP.
§2.11 adds **[disasm]** / **[code]** (read from ssp.exe 2.9.08f's disassembly with its shipped symbol map `ssp.map`:
control flow reliable, field meanings inferred), **[guess]** (the most plausible pick, not compared with ssp.exe)
and **[decision]** (a deliberate browser deviation or product choice). **[observed]** = seen in a running ssp.exe (its
screen, menus, balloons), **[measured]** = measured (pixels, sizes, bytes).

---

## 0. Sources and abbreviations

| Tag | Source |
|---|---|
| UKADOC:ev | https://ssp.shillest.net/ukadoc/manual/list_shiori_event.html |
| UKADOC:ss | .../list_sakura_script.html |
| UKADOC:res | .../list_shiori_resource.html |
| UKADOC:shell | .../descript_shell.html |
| UKADOC:ghost | .../descript_ghost.html |
| UKADOC:balloon | .../descript_balloon.html and .../manual_balloon.html |
| UKADOC:odm | .../dev_ownerdraw.html |
| UKADOC:shiori3 | .../spec_shiori3.html (Status header) |
| UKADOC:sstp | .../spec_sstp.html |
| UKADOC:surf | .../descript_shell_surfaces.html (SERIKO intervals) |
| UKADOC:property | .../list_propertysystem.html (local copy `scratch/sspui/list_propertysystem.txt`) |
| SSPHELP:* | https://ssp.shillest.net/ukadoc/ssphelp/ pages `howto-rclick`, `config-talk`, `config-ghost`, `config-ghost2`, `config-disp` (the **live** site; the GitHub copy of config-talk lacks the default values) |
| SSP-RES | `ssp_2_9_08f/data/language/english/resource.dll` (an SSP 2.9.08f install), dumped with `docs/research/scratch/peres.py` into `docs/research/scratch/menu_en.txt` (menus) and `docs/research/scratch/sspui/dialogs_en.txt` (dialog strings) |
| SSP-RES-JA | SSP's Japanese UI is built into `ssp_2_9_08f/ssp.exe` (resources of language 1041; `data/language/japanese/descript.txt`: "Japanese Language Resource is in ssp.exe"), dumped with `peres.py` into `scratch/menu_ja.txt` (menus) and `scratch/strings_ja.txt` (string tables: MFC's only), and with `scratch/dlg_dump.py` into `scratch/sspui/dialogs_ja.txt` (dialogs). `data/language/{japanese,english}/descript.txt` (`name`, `id`, `helpurl`) and `message.txt` hold the rest |
| SSP-ODM | `ssp_2_9_08f/data/ssp_default_odm.txt` (SSP's default menu look) |
| SSP-PROF | `ssp_2_9_08f/ghost/*/ghost/master/profile/ghost.dat` (what SSP saves per ghost) |
| Satori | `vendor/satoriya-shiori/satoriya/satori/satori_EventOperation.cpp`, `satori_CreateResponce.cpp`, `satori_tool.cpp`, `satori_load_dict.h` |
| ninix | ninix-kagari (Tatakinov/ninix-kagari, Ruby, a maintained SSP-compatible baseware for Linux): `lib/ninix/sakura.rb`, `surface.rb`, `balloon.rb`, `keymap.rb`; copies in `docs/research/scratch/sspui/ninix/` |
| Corpus | Tsubasa's real satori.dll responses (`tests/corpus/final_{master,bath,date,meal}.res.txt`, 7,334 VALUE responses); counter script `docs/research/scratch/sspui/corpus_ui.py` |
| Tsubasa | `site/ghost/tsubasa/ghost/master/dic*.txt` (CP932), `shell/master/descript.txt`, `surfaces*.txt` |
| Not in the repository | The local copies, dumps and scripts in `docs/research/scratch/` (`scratch/` below), the corpus (`tests/corpus/`), Tsubasa's files (CLAUDE.md "The ghosts Sumika was tested with") and the SSP install. These are development material, cited as the sources (CLAUDE.md "Project rules"). |
| Ikagaka | github.com/Ikagaka/* READMEs and issues, Narazaka/nativeshiori, Narazaka/libsatori.js, and the author's summary post "イカガカの要素技術" (narazaka.blog109.fc2.com/blog-entry-238.html); copies in `docs/research/scratch/sspui/ika/` |

Conventions used below:
- "Desk" = the browser's **layout viewport**: `{x:0, y:0, w: documentElement.clientWidth, h: documentElement.clientHeight - bottomOffset}`.
  It stands in for SSP's "work area of the monitor the character is on". `bottomOffset` mimics SSP's
  "Offset from taskbar" display setting (default 0) [res: dialog 103].
- Coordinates are CSS px; one shell image pixel = one CSS px by default (see §9.9).
- "Scope" = character index: 0 = `\0` (sakura), 1 = `\1` (kero), n = `\p[n]`.

---

## 1. Key facts in one screen

1. **SSP's right-click menu has no "Communicate"/"Talk" item.** In SSP 2.9 the full menu runs: Recommendations,
   Portal sites, Network update, Uninstall, RSS, Plugins, Mail, Shell scaling, Balloon scaling, Utilities, Options |
   Change ghost, Call ghost, Shell, Dress-up, Balloon, History | Information, Language, Iconify | Close, Quit [res: MENU 102].
   Ghosts provide talking/communicating through their **own balloon menus** opened by double-click (Tsubasa: `＊0つつかれ`
   in dic03_Menu.txt, an on-screen menu panel on scope 99, and keys `t`/`c`/`m`).
2. The menu appears on right-click **only when the ghost does not answer the right-click** (OnMouseUp/OnMouseClick with
   Reference5=1). This rule is confirmed in ninix [src]. For SSP it is likely but not verified [?].
3. Default timeouts [doc SSPHELP:config-talk live, res dialog 104]: **balloon closes 15 s after a talk ends; choices time out after
   30 s; click-wait `\x` never times out; text speed 50 ms per character.** OnSurfaceRestore comes 30–51 s after a talk stops (Timeout.Balloon + 15 s, then a local second of 10–50), whatever the balloon does [disasm, EV §3.4; UKADOC:ev said 15 s after the balloon closes].
4. **OnSecondChange/OnMinuteChange are sent every second/minute regardless of state.** When the ghost cannot talk, they are sent as
   **NOTIFY with Reference3=0** and the reply is ignored [doc UKADOC:ev]. Satori's random talk, `＄喋り間隔` countdown, `タイマ`
   variables and Tsubasa's play-time counter all depend on this tick [src Satori EventOperation].
5. A user event (mouse, key, menu, choice) that returns a script **replaces** the script that is playing. Random talk never does (point 4).
   SSTP SEND also breaks the current script unless it carries `Option: nobreak`. `\t` blocks mouse events and makes SSTP answer 409 [doc UKADOC:ss, UKADOC:sstp].
6. Placement [disasm, §3.2]: on first boot `\0` stands at the bottom-right of the desk, and `\1` stands flush against
   `\0`'s left edge, base points level, with **no room left for balloons**. Each character is anchored at its **base
   point** (defaultx/defaulty, by default the image's bottom-center). SSP saves every scope's position as **ratios of
   the screen** (`Char<n>.ratio.x/y`) [res SSP-PROF], per shell with the ghost's behind it (§3.3), and a ghost always
   comes back there; nothing places one ghost relative to another (§3.5).
7. Tsubasa uses **~30 extra scopes** (`\p[2]..\p[27]`, `\p[95]..\p[101]`). Scope 99 appears in 5,591 of 7,334 responses: it is her on-screen
   menu panel. Its idle surface (9702) is a 204×125 window that is fully transparent except a 4×4 dot. **Per-pixel
   click-through is therefore P0**: without it an invisible box blocks the host page [corpus, Tsubasa surfaces.txt].
8. Mouse events Tsubasa depends on (P0): OnMouseDoubleClick (429 `…つつかれ` sections), OnMouseMove (214 `…なでられ`:
   Satori fires after **60 moves** on the same collision within 2 s), OnMouseWheel (301 `…ころころ`, needs ±120 per notch),
   OnMouseClick/Down/Up on scope 99/100/101/22 (menu panel, games), OnKeyPress (shortcuts and games). Satori also reads
   the `Status` header (`talking`, `passive`…) [src].
9. Input: `\![open,inputbox,ID[,timeout[,text]]]` leads to OnUserInput(ID, text). Tsubasa's typing game relies on the **compatibility rule**: when a box
   times out and OnUserInputCancel gets no answer, SSP sends **OnUserInput with Reference1 = "timeout"** [doc UKADOC:ev, Tsubasa dic `タイプ時間切れ`].
10. Some settings last **"until the ghost exits"**: `\![set,alignmenttodesktop]`, `\![set,scaling]`, `\![set,zorder]`, `\![set,sticky-window]`,
   `\![set,balloonalign]`, timers from `\![timerraise]`, passive/induction mode and others [doc UKADOC:ss]. A browser page reload is *not* a ghost exit,
   so these must be **persisted across page navigations** (Tsubasa uses `alignmentondesktop` in 114 responses and `scaling` in 11).
11. Ikagaka ran Emscripten SHIORIs (including Satori, as `libsatori.js`/`satoriworker.js`) in **Web Workers**, with files
   copied into Emscripten's in-memory FS from a BrowserFS/IndexedDB store, and drew shells with canvas+DOM. Its main pains:
   slow boot (IndexedDB copy plus SHIORI init plus shell compose on the UI thread), no SAORI, touch/mobile problems, and
   talk speed that felt about 2× faster than SSP. It also had a reported bug "隣の羽山さんが下着姿" (Tsubasa shown in underwear), from dress-up default handling. See §8.

---

## 2. The right-click (owner-draw) menu

### 2.1 SSP 2.9 main ("sakura") menu, in order — P0 minimal subset, P1 rest

Source: SSP-RES MENU 102 (English captions, ids in parentheses); item meanings from SSPHELP:howto-rclick; resource ids from
UKADOC:res. "Ghost event" = what the ghost receives when the item is picked. **Browser** = recommended handling.

| # | SSP caption (English resource) | Caption / visible resources | Ghost event(s) on pick | Browser | Pri |
|---|---|---|---|---|---|
| 1 | Recommendations ▸ (submenu) | `recommendrootbutton.caption`, `.visible`; old: `sakura.recommendbuttoncaption` (asked **first**, §2.11). Items from `sakura.recommendsites` | **OnRecommendsiteChoice** (see 2.4); SSP also opens the URL in the browser | **implemented**: open URL in a new tab (`window.open(url,'_blank','noopener')` inside the click handler) **and** send the event; **greyed** when the list is empty [disasm] (it used to be left out) | P0 |
| 2 | Portal site ▸ | `portalrootbutton.caption`/`.visible`; old `sakura.portalbuttoncaption` (asked first). Items from `sakura.portalsites` | OnRecommendsiteChoice with Reference3=`portal` | same as 1 | P0 |
| 3 | Network update (Ctrl+U) | `updatebutton.caption`/`.visible`; old `updatebuttoncaption`, `sakura.updatebuttoncaption` (asked in that order before the new name [disasm]) | OnUpdateBegin… (the update sequence) | **omit**: a visitor's browser updates nothing, and its ids are not asked [decision]. SSP greys it without an update URL (`homeurl`) or at enable level ≥ 1 [disasm], so Tsubasa (empty `homeurl`, `updateurl` commented out) has it greyed in SSP | P2 |
| 4 | Uninstall | `vanishbutton.caption`/`.visible`; old `vanishbuttoncaption`, `vanishbuttonvisible` (asked first) | OnVanishSelecting, then a confirm dialog, then OnVanishSelected / OnVanishCancel, then OnVanished (to the next ghost) | **omit**: nothing is installed in a browser, and its ids are not asked [decision] (SSP greys it while only one ghost is installed and at any enable level ≠ 0 [disasm]). No "forget this ghost in this browser" item either [decision] | P2 |
| 5 | RSS/Headlines ▸ | `headlinesenserootbutton.*` | OnHeadlinesense* | omit | P2 |
| 6 | Plugins ▸ | `pluginrootbutton.*` | plugin events | omit | P2 |
| 7 | Check mail ▸ | `biffbutton.*` | OnBIFF* | omit | P2 |
| 8 | Shell scaling ▸ (`Sh&ell scaling`) | `shellscalerootbutton.*`, `shellscaleotherbutton.*` | OnShellScaling [new x, old x, new y, old y] | **implemented** (§2.9): Default (match display), Other percentage…, 300 %…20 %; per ghost | P1 |
| 9 | Balloon scaling ▸ (`Balloon scaling (&D)`) | `balloonscalerootbutton.*`, `balloonscaleotherbutton.*` (not in UKADOC; ssp.exe has the names [res]) | OnBalloonScaling (same refs) | **implemented** (§2.9) | P2 |
| 10 | Utilities ▸ (calendar, messenger, script log, reload ghost, reset passive mode, reset shell position Ctrl+Shift+F12, reset balloon position, hide all balloons…) | `utilityrootbutton.*`, `leavepassivebutton.*`, `resettodefaultbutton.*`… | e.g. OnResetWindowPos (no answer → default reset) | **implemented**: *Reset shell position* (it also forgets dragged balloon offsets); *Reset passive mode* (`制限モード強制解除(&P)` / `Reset &passive mode`, id 5057) only with `?sumika-debug`, standing in for SSP's "Enable functions for developers" without which SSP deletes the item [disasm `InitWndMenu`; decision], then a separator (SSP's order). *Reload ghost* not done | mixed |
| 11 | Options ▸ (Preferences…, Ghost preferences…) | `configurationrootbutton.*` (the submenu), `configurationbutton.*` (Preferences…) [infer: which is which] | none (Preferences… opens SSP's settings dialog) | **implemented, Preferences… only** (§2.13): `設定(&O)` / `&Options` ▸ `本体設定...(&P)` / `&Preferences...` opens the Preferences box (the General page's user information). The other items (Ghost preferences, window modes, proxy, charset, compatibility switches) have no browser meaning [decision]; Shell scaling ▸ "Default (match display)" stands in for Ghost preferences | P1 |
| — | separator | | | | |
| 12 | Change ghost ▸ (`Change &ghost`) | `ghostrootbutton.caption`/`.visible` | OnGhostChanging (old ghost, R1 `manual`) → OnGhostChanged (new ghost) (EV §2.5) | **implemented**: every ghost of the site index by its descript `name`, in SSP's order: by that name, ties by folder, the rule of Shell ▸ and Balloon ▸ (wcsicmpex, BA §12.1; `shells.js` `compareEntries`) [observed: ssp.exe's Change ghost ▸ with 23 ghosts in exactly that order, `tests/fixtures/ssp-ghost-order.json`; Sumika listed folder order before]; the running one checked (SSP's dot, §2.3) and enabled: a pick reloads it (its goodbye, a cold boot of itself, OnGhostChanged naming itself; EV §2.5); ghosts whose engine the runtime lacks disabled with the reason after the name, e.g. `Misaka Test (needs Misaka)` (the test site's Misaka ghost; on a real site an AYA4 ghost would show `(needs AYA)`; the reason sits in its own right-aligned column, so a long name ellipsizes before it). A list taller than the viewport scrolls; the keyboard's row is kept in sight, and the pointer crossing other rows on its way into the list neither opens nor closes a submenu. Shown on a single-ghost site too (just the running ghost), like SSP [infer]. Not in the abbreviated menu (§2.2). **With several ghosts on screen** (§2.12): a ghost shown in another slot is greyed **without** a check [disasm `CSakuraWnd::InitGhostMenu`]; only the ghost whose menu it is changes, and the new ghost takes its slot. The menu's own ghost stays checked and **enabled**, as SSP's [disasm 2.9.10 0x49b9b7] | P1 |
| 13 | Call ghost ▸ (`Call ghost (&Z)` / `他のゴーストを呼ぶ（&Z)`, full-width `（`) | `callghostrootbutton.caption`/`.visible` | OnGhostCalling (caller, R1 `manual`) → OnGhostCalled (callee; 204 → OnBoot) → OnGhostCallComplete (caller, after the callee's boot talk) (EV §2.7) | **implemented** (§2.12): right after Change ghost ▸, main menu only; the same rows, order and labels as Change ghost ▸; own ghost checked (the dot) and greyed, a ghost on screen elsewhere greyed without a check [disasm], a ghost whose engine is missing greyed with its reason, every other row greyed with "up to {n} at once" while a site's cap (`data-max-ghosts`) is reached, none by default as in SSP [decision]; not greyed by the enable level [disasm, tentative] | P1 |
| 14 | Shell ▸ | `shellrootbutton.*` | OnShellChanging(new name, current name, path) → the swap → OnShellChanged (EV §2.6) | **implemented** (§2.11): every shell by its descript name, in SSP's name order, the current one checked (the dot) and enabled | P1 |
| 15 | Clothes/Dressup ▸ | `dressuprootbutton.caption`/`.visible`, `dressupexplorerbutton.*` (all unprefixed, also in the abbreviated menu) | OnDressupChanged(char, part, 1/0, category, `user`) then OnNotifyDressupInfo | **implemented** (§2.11): Dressup explorer (greyed), separator, the scope's parts ("category - part", the dot while worn); Tsubasa sets it visible with caption "Dress-up(&C)" | P1 |
| 16 | Balloon ▸ | `balloonrootbutton.*` | OnBalloonChange(name, path) (no OnBalloonChanging) | **implemented** (§2.11): the ghost descript's balloons, a separator, every installed balloon by name, the dot on the one in use | P1 |
| 17 | History ▸ | `historyrootbutton.*` | — | omit | P2 |
| — | separator | | | | |
| 18 | Information ▸ (About SSP, About this ghost, Terms, Help, AI graph, usage stats, system information) | `inforootbutton.*`, `firststaffbutton.*`, `readmebutton.*` (old `readmebuttoncaption` first), `termsbutton.*`, `helpbutton.*`, `aistatebutton.*`, `rateofusebutton.*`, `systeminfobutton.*` | none (shows readme / dialogs) | **implemented** (§2.11): About Sumika (in About SSP's slot), About this ghost (SSP's readme window, DIALOG 109), Terms (greyed without `terms.*`), the rest greyed | P1 |
| 19 | Language ▸ (`&Language` in both languages) | none: "[変更不可]Languageの名称" [UKADOC:res `#-`] | OnLanguageChange (EV §4.13) | **implemented** (§2.10): Japanese, English, separator, Use System Lang.; site-wide | P1 |
| 20 | Iconify (Ctrl+I) | `hidebutton.caption`/`.visible` | **OnWindowStateMinimize**(Reference0=`user`) | minimize to a launcher icon (§2.6) | P0 |
| — | separator | | | | |
| 20a | Move character window (inserted at run time, id 5106, no access key) | `charmovebutton.caption`/`.visible` (not in UKADOC) | none [guess] | **implemented** (§2.11): the clicked character follows the pointer until the next click | P2 |
| — | separator | | | | |
| 21 | Close (Ctrl+W) | `closebutton.*` | the only running ghost gets **OnCloseAll** first, and if that returns 204 then **OnClose**(Reference0=`user`, Reference1=menu scope, Reference2=window scope) [doc UKADOC:ev]: R1 the shown menu's character, R2 the clicked one, which differ only in a menu `popupmenu.type` redirected (Notes below) [disasm 2.9.10 `CCWC_OnCommand` 0x41d503]. With other ghosts on screen: **that ghost alone**, GET **OnClose** only (no OnCloseAll) [disasm `OnMenuClose`] | play the script, close on `\-` or at script end (§2.6); among several, at `\-` only (a goodbye without it leaves the ghost standing), then the others get OnOtherGhostClosed (§2.12) | P0 |
| 22 | Quit (Ctrl+Q) | `quitbutton.*` | OnCloseAll | **implemented**: `全て終了(&X)` / `Quit (&X)` in both menus; the same as Close while one ghost runs (SSP: Close with no other ghost *is* Quit [disasm `OnMenuClose`]). With several (§2.12): **every** ghost on screen gets OnCloseAll (204 → OnClose) at once and closes at the end of its own close script, `\-` or not [disasm `PlayScriptWithMsg(…, 0x3A)`]; no OnOtherGhostClosed | P1 |

Notes
- Every SSP item can be renamed with `<item>.caption` and switched off with `<item>.visible` = `0` (UKADOC:res lists about
  90 ids; a missing reply means **visible**). `0` **greys** the item in place; it does not remove it (§2.11 [disasm]).
  The table lists only the ids that matter. Old-style names (`updatebuttoncaption`, `sakura.updatebuttoncaption`,
  `vanishbuttoncaption`, `readmebuttoncaption`, `vanishbuttonvisible`, `sakura.recommendbuttoncaption`,
  `sakura.portalbuttoncaption`, `kero.recommendbuttoncaption`) are still honored. SSP asks **the old name first**, then
  the new one [disasm, §2.11]; ninix does the reverse [src ninix menu.rb `__set_caption`].
- Captions contain Windows access keys, `&X`. Draw the X underlined, strip the `&`, and accept X as a key while the menu is
  open. If a ghost caption has no `&`, ninix appends the default one, e.g. `(R)` [src]. Optional.
- SSP asks the ghost for the captions when the menu opens. The option "Ignore ghost-defined menu strings (faster)" exists because those
  requests are slow [doc SSPHELP:config-ghost]. Tsubasa's captions are **random each time**: `recommendrootbutton.caption`
  has 3 candidates, e.g. "Ghost Friends(&P)" / "Play a Card(&P)" / "Draw--Monster Card!(&P)" (dic06_String.txt). So
  **re-query the captions every time the menu opens.** Sumika's SHIORI runs in a worker, so send all caption/visible/site requests in one
  batch, wait for them with a ~300 ms cap, and fall back to the last values seen (cache them at boot).
- **Which menu a right-click opens** (ssp.exe 2.9.10; `askMenu`, `menuTarget`, `bindScopeOf` in
  `src/ui/menu.js`). UKADOC words `*.popupmenu.type` as "`0` = main (本体側) menu, `1` = abbreviated (省略) menu" [doc
  UKADOC:res]; ssp.exe reads it as a **character**: the clicked character gets that character's own menu, and 0 / 1
  are just sakura's and the kero window's [disasm `CCharWndCode::OnCWContextMenuSSP` 0x41aec0..0x41b0c3].
  - **When**: at every open from a right-click (after OnMouseClick came back without a script) or the Apps key
    (OnCWContextMenu 0x41aeaa, EX_OnKeyDown 0x41b3a5 pass `true`); never from the tray icon (OnTaskTray4 0x49944f passes
    `false`: sakura's main menu, nothing asked), never at boot, never cached [disasm].
  - **What, in order**, before any caption: `<p>.popupmenu.visible`, then `<p>.popupmenu.type`, `<p>` the **clicked**
    character's prefix (`sakura.` / `kero.` / `char%u.`); both always, `type` also when `visible` is 0 [disasm
    0x41af2c..0x41b014; res: an old SSP's log, `scratch/ayame_u8.log` 1637–1650: OnMouseClick, `sakura.popupmenu.visible`,
    `sakura.popupmenu.type`, `recommendrootbutton.visible`].
  - **visible**: SSP's ParseBool through `GetStringBool(…, 1)` [disasm 0x6424c0, 0x41b082]: `0 false off no ng none
    disable(d)` or a zero number = no menu; no answer, an empty or an unparsable one = shown. (Sumika tested `'0'` only
    before.)
  - **type** [disasm 0x41b019..0x41b06e]: no answer (a 204, another status, an empty string: GetString 0x642554) = the
    clicked character's own menu; the whole value `sakura` (any case) = 0, `kero` = 1; starting with `char` (any case) =
    `wtoul` of the rest; anything else = `wtoul` of the whole value. `wtoul_impl` [0x5ae280] skips leading ` `, U+3000
    and tabs, reads `0x` / `0X` as hex, else the CRT's `wcstoul` base 10 (its own white space, a sign, the digits up to
    the first other character; none: 0; `-1` = 0xFFFFFFFF). So any other word (`full`, `none`, `char`, a blank) means
    0, the main menu (`sspWtoul`, `popupTypeScope`). Full-width digits: not read [disasm: the CRT's `_wcstoxl`
    0xacdeaa–0xacdee0 tests `iswctype(_DIGIT)`, then takes c − '0', so U+FF11 ≥ the base stops the number].
  - **Whose window** [disasm 0x41b08b..0x41b098, `CSakuraWnd::GetCharWnd` 0x49ec70]: 0 = sakura (always), 1 = the kero
    window, n ≥ 2 = a `\p[n]` window already made; anything else (never made, out of range) = the clicked character's
    own menu. Sumika: `Stage.has(n)` (`Menu._hasScope`).
  - **The menu shown is that window's own** [disasm `ShowContextMenu` 0x41b0d0..0x41b18f]: scope 0 the main menu (MENU
    102, `CSakuraWnd::ModifyPopupMenu`), any other the abbreviated one (MENU 128, `CCharWndCode::ModifyPopupMenu`, its
    recommend ids and list with the **target's** prefix); then `GetODMFromShiori(0)` and the popup at the pointer, owned
    by the clicked window; the pick goes to the target window, which keeps the clicked scope (`[target+0x78]`, 0x41b107).
    So `kero.popupmenu.type` 0 gives `\1` sakura's full main menu, `sakura.popupmenu.type` 1 gives sakura the kero
    window's abbreviated menu, and with no answer each character keeps its own (`\1` / `\p[n]` the abbreviated one).
    `sakura.popupmenu.visible` is not asked when `\1` is redirected to sakura's menu.
  - **Clothes/Dressup ▸ of a redirected menu**: ModifyPopupMenu's first request is the clicked character's
    `<p>.popupmenu.applybindtoself` (`CheckApplyBindToSelf` 0x41cca0..0x41cdb4, called at 0x41cdf2 and 0x4959f2; asked
    only when the menu is another character's), ParseBool, default 1: 1 (or no answer) = the parts listed and toggled are
    the **clicked** character's, 0 = the menu owner's (`UpdateBindMenu` 0x41ede8, the picks at `CCWC_OnCommand` 0x41d191
    / 0x41d285 use that bind scope). The root is greyed or enabled by the **owner's** bind data all the same
    (`ModifyMenuWithTable` 0x41c975..0x41ca01: the main menu `GetBindPropCharEnable(0)`, the abbreviated one its own
    scope) [disasm].
  - **Picks of a redirected menu** [disasm `CCWC_OnCommand`]: Close and Quit send R1 = the menu's character, R2 = the
    clicked one (0x41d503, 0x41d4ca: `[esi+0x10]`, `[esi+0x78]`; OnMenuClose → `CloseGhostProc("user", 0, J1, J2)`
    0x49670d, `SPShiori::OnGhostClose` 0x710754..0x7107a4; Quit to every ghost); Move character window carries the
    **menu's** character (0x41d535..0x41d5b1: the cursor to that window's centre, a drag start), also when it is hidden
    (Sumika then moves nothing: `Stage.carry` refuses a character not shown); a site pick lists
    and sends R4 as the menu's (0x41d32e, 0x41d3de).
  - **BloodTeaHOUSE ver.5** (site `bthver.5`) [measured on its Kawari 8.2.8, `tests/runtime/menu_odm.test.mjs`]:
    `resource.kero.popupmenu.type` answers `0` while its `Mode` matches `Xmas` or is `Tea0`, else `1`
    (`ghost/master/core/resources.txt` 273–277); a fresh load answers `1`, and after its first-boot door-size answer
    `初回導入_通常` (Mode `Tea0`, `blood/blood_01.txt`) `0`; its other `popupmenu.*` ids answer 204. So during its first-boot
    welcome and in December's `Xmas飛` mode a right-click on 飛白 (`\1`) shows the full main menu, whose Clothes/Dressup ▸ is
    enabled (sakura's 髪 group) and holds only the greyed explorer (\1's parts: none) [infer from the rules above; not
    compared with ssp.exe]. Outside those modes: the short menu.
- `legacyinterface` works only in materia (UKADOC:res). Ignore it.
- Sumika's main menu (`src/ui/menu.js`): Recommendations ▸, Portal site ▸, separator, Shell
  scaling ▸, Balloon scaling ▸, Utilities ▸, Options ▸ (Preferences… only, §2.13), separator, Change ghost ▸, Call
  ghost ▸ (when the site lets more than one ghost stand, §2.12), Shell ▸, Clothes/Dressup ▸, Balloon ▸, separator,
  Information ▸, Language ▸, Iconify, separator, Move character window, separator, Close, Quit (§2.11 has the
  rules); Sumika's captions in the visitor's UI language (§2.10). Left out: Network update, Uninstall, RSS/Headlines ▸,
  Plugins ▸, Check mail ▸, History ▸ (it has its own Call ghost list in SSP). In ssp.exe the two scaling items
  come right after Check mail ▸ and before Utilities [observed]. Picking a ghost in Change ghost ▸ plays the
  running ghost's OnGhostChanging script to its end, then the new ghost boots with OnGhostChanged (EV §2.5); a
  double-click on the farewell balloon (balloon break) cancels it. Until the change is over the menu does not open and
  Close / Iconify do nothing. Other tabs of the site follow the change (§9.5).

### 2.2 Abbreviated ("kero") menu — P1

SSP-RES MENU 128: Recommendations ▸ (`kero.recommendsites`, or `char<n>.recommendsites`), Clothes/Dressup ▸ (for this character),
separator, Close, Quit. SSPHELP:howto-rclick marks the same four items 【サブ】. Shown for `\1` and `\p[n≥2]` when the
clicked character's `<p>.popupmenu.type` gives no answer, and for any character whose `type` names a scope ≥ 1 whose
window exists (that window's own menu: `sakura.popupmenu.type` 1 gives sakura the kero window's); a `type` naming 0 gives
the main menu instead (§2.1 Notes, "Which menu a right-click opens") [disasm]. Its Close has no access key, unlike MENU 102's: "Close\tCtrl+W" / "終了\tCtrl+W"
(id 5045) [res: `scratch/menu_en.txt`, `menu_ja.txt` MENU 128]; Sumika shows "Close" / "終了" there (`menu.closeSub`,
§2.10) unless the ghost sets `closebutton.caption`.

What SSP asks and inserts there [disasm `CCharWndCode::ModifyPopupMenu`, `InitWndMenu`]: the recommend ids carry the
scope prefix, legacy first: `kero.recommendrootbutton.visible`, `kero.recommendbuttoncaption` →
`kero.recommendrootbutton.caption` (`char<n>.` for n ≥ 2); every other id is asked **without** a prefix
(`dressuprootbutton.*`, `dressupexplorerbutton.*`, `charmovebutton.*`, `closebutton.*`, `quitbutton.*`). SSP inserts
Dressup explorer at the top of Clothes/Dressup ▸ and "Move character window" with a separator on each side, so the menu
reads:

```
Recommendations ▸        greyed when the list is empty, at enable level ≥ 2, or with <p>.recommendrootbutton.visible 0
Clothes/Dressup ▸        this character's dress-up (§2.11); greyed like the main menu's
----
Move character window
----
Close                    "Close" / "終了"
Quit                     "Quit (&X)" / "全て終了(&X)"
```

**Implemented** that way; `popupmenu.type` / `applybindtoself` too (§2.1 Notes: the menu a
click opens is the one `type` names, its Clothes/Dressup ▸ lists the bind scope's parts). Neither Change ghost ▸, Call
ghost ▸ nor Shell ▸ / Balloon ▸ / Information ▸ appear here (SSP has them only in MENU 102). With several ghosts on
screen its Close and Quit mean what the main menu's do (§2.12): Close closes the ghost whose character was clicked
(OnClose only), Quit closes every ghost, with this menu's scope in R1 and the clicked character's in R2 (the same
unless `type` redirected the menu) [res; disasm `OnMenuClose`, `OnMenuExit`, 2.9.10 `CCWC_OnCommand` 0x41d4ca /
0x41d503; doc SSPHELP howto-rclick].

### 2.3 Menu look — P1 (ssp.exe's metrics)

- Shell descript.txt or SHIORI resources [doc UKADOC:odm] (UKADOC: "the SHIORI value wins"; in ssp.exe only for the
  35 ids it asks, and only while its pass is complete: "SHIORI resources" below [disasm]):
  `menu.background.bitmap.filename` (normal background), `menu.foreground.bitmap.filename` (the image used under the
  hovered row: the hovered row shows the *foreground* image's pixels at that position), `menu.sidebar.bitmap.filename` (a strip at the left).
  Alignments: `menu.background.alignment` (default `lefttop`), `menu.foreground.alignment` (`lefttop`), `menu.sidebar.alignment` (`bottom`)
  [doc UKADOC:shell]. When the menu is bigger than the image, the image's right and bottom edge colors are extended [doc UKADOC:odm].
  - SSP reads an alignment with `SPUtils::GetAlignFlag` [disasm 0x789370]: substrings in any case, `right`, else
    `center`, else left; `bottom`, else top (so `lefttop` and `center` are top, `Center` is centred). Without the key
    the flags stay 0: the background and foreground sit left top, and the sidebar is drawn **bottom**-aligned (DrawItem
    tests the "top" bit, 0x696081) while its fill colour is its **bottom** pixel (SetValues tests the "bottom" bit,
    0x695551) [disasm]. Sumika: `alignFlag`, `menuLook().sidebarTopEdge`.
  - SSP reads every `menu.*` key of the **ghost's** `descript.txt` first and the **shell's** on top, key by key (each
    colour channel is a key of its own), so the shell's value wins [disasm `SPGhost::LoadShell` 0x61f0e8 / 0x61f12d →
    `LoadDescriptOverride` 0x622a60, whose first call resets the menu → `SPMenu::LoadFromDescript` 0x694580; these
    are 2.9.08f's addresses, 2.9.10's are 0x620ca0, 0x6247d0 (`InitMenuProp` 0x6965c0 on its first call) and
    0x696710]. Sumika does the same (`menuLook(shell, ghost)`). The SHIORI's answers go on top (next bullet).
- **SHIORI resources** (SSP shows BloodTeaHOUSE ver.5's menu with its own background [observed]; bthver.5 gives its
  menu skin only as SHIORI resources, `ghost/master/core/resources.txt` lines 404–441, and neither descript has a
  `menu.*` key) [disasm 2.9.10 `SPGhost::GetODMFromShiori` 0x623730..0x624180]:
  - **Which ids.** Exactly 35, nothing else menu-related: the three `*.bitmap.filename`; `menu.background.color`,
    `menu.foreground.color`, `menu.sidebar.color` (each `.r .g .b`); `menu.sidebar.width`, `menu.sidebar.text`;
    `menu.background.font.color`, `menu.foreground.font.color`, `menu.sidebar.font.color`, `menu.disable.font.color`,
    `menu.separator.color`, `menu.frame.color` (each `.r .g .b`); the three `*.alignment`. Never `menu.font.name` /
    `menu.font.height` nor a colour without its channel, so a SHIORI cannot set the menu font. Each is ssp.exe's only
    use of its UTF-16 string (0xbc01c8–0xbc0874), all through `SPGhost::GetString` 0x642570 → `GetStringShiori`
    0x712ba0 (`GET String SHIORI/2.5` for a 2.x SHIORI) [disasm].
  - **One pass**: the background's name, the foreground's; the sidebar's only when both came back non-empty
    [0x623a18; a missing foreground jumps past it, 0x623925]; then the background's and the foreground's colour
    (r, g, b each). Complete = both names came back, or both colours' flags are set [0x623c3a..0x623c6d]. Incomplete:
    the pass stops there (8 requests) and returns 0; complete: the other 26 in the order above and 1 [disasm].
  - **When**: at every shell load, the ghost's load and every shell change: `LoadGhostCore` loads the SHIORI first at a
    ghost's load (its NOTIFY batch, `NotifyInstalled*`), sets the menu's image paths, runs `LoadSurface` (the
    descripts' look), clears the gate and asks with force 1; the gate is then "the pass returned 0" [disasm 0x6215c4,
    0x6215fd, 0x621608, 0x621618, 0x62161e, 0x6216f8]. So before OnBoot, and at a shell change
    (`ChangeOrReloadShellInternal` → `LoadShell(…, 0)` 0x6231e3) before OnShellChanged. And at **every menu open**,
    either character, with force 0: `CCharWndCode::ShowContextMenu` asks the captions (ModifyPopupMenu), then the
    look, then shows the popup [0x41b10c, 0x41b114, 0x41b160]; the clicked character's `popupmenu.visible` and
    `popupmenu.type` are asked before it (`OnCWContextMenuSSP` 0x41afcd, 0x41b014; §2.1 Notes). While the gate is set
    nothing is asked [0x623778]; an open's result moves no gate.
    So a ghost whose load pass was incomplete is never asked at an open; a complete one is asked 34–35 ids at each.
  - **Answers**: no cache, every ask is a request. A 204, another status or an empty string is no answer, which keeps
    the current value (the descripts' or an earlier answer) until the next shell load resets the menu (InitMenuProp)
    [disasm 0x64254d, 0x62381b]. Key by key on top of both descripts: a channel through the same `SPColor::Set` as the
    descripts' keys (spaces or tabs, a sign, digits, an optional `%`, blanks; wtol ≥ 0; its low byte; an invalid one
    sets nothing) [disasm 0x5eba00, 0x5ebd80]; an alignment replaces the flags (GetAlignFlag); width by
    `wcstoul(v, 0, 0)`, text as given.
  - **Names**: trailing U+0020 cut (tabs and leading blanks stay); at 5 characters or more a `.` 4 from the end
    removes 4, else one 5 from the end removes 5 (`menu\menu_background_1.png` → `menu\menu_background_1`, `.bmp` and
    `.jpeg` go too) [0x623832..0x6238af]. Force (a load) always reloads that slot; an open only when the stem differs
    from the stored name (wcscmp; the descripts' stem, `RemoveExtensionFromFileName` 0x7892b0, or InitMenuProp's
    `menu_background` / `menu_foreground` / `menu_sidebar` 0x696687). A reload clears the slot and loads one image
    from the stem (no numbered siblings); an empty stem keeps the old images [0x6972f6, 0x69729e].
  - **Where**: the search paths are [the shell folder, `ghost/master/`] [0x6215df]; each is tried with path + stem +
    `.png`, whatever extension was written, the first that decodes winning [`LoadSurfaceDataFromName` 0x698d06..
    0x698d88]; `\` and `/` and any case work (Windows); a `!` stem is SSP's own data folder [0x698bf9]. bthver.5's
    `menu\menu_background_1.png` is `shell/<shell>/menu/menu_background_1.png`.
  - **Which look**: decided at the load only. The descripts' LoadSurface succeeded, or the pass was complete: that
    look; else `ssp_default_odm.txt` and SSP's own look, with the gate set [0x621623..0x6216f2]. Complete with a
    SHIORI image that does not load: that slot has none, and the rows get its colour or COLOR_MENU, not SSP's own look.
    LoadSurface's defaults (separator = the text colour, frame black, disabled = (2 × fill + text) / 3) are from the
    load, before the pass [0x6970d4..0x6970f0, 0x697121..0x69719c]: a SHIORI text colour moves neither.
  - bthver.5 on the real Kawari 8.2.8 build (site copy; the same files as the installed BTHver.5 after its network
    update, compared by MD5, saves and `profile/` left out) answers the three names as written, font 0,0,0 and
    255,255,255, disabled 222, separator 0,0,0, alignments `leftbottom` / `leftbottom` / `bottom`, 204 for the rest
    [measured; `tests/runtime/menu_odm.test.mjs`]: complete through the names, 35 requests at the load and
    at each open, its images `shell/<shell>/menu/*_1.png` (300 × 428, 300 × 428, 22 × 500, in both shells). Its
    answers do not depend on its state (those lines are its only `menu` entries). etherism (Satori,
    `dic04_Menu.txt` 706–739) answers only font, disabled and separator colours and alignments (text 252,252,252):
    incomplete, so those are never asked, and its menu stays SSP's black on white [infer from the rules above]; a
    naive "the SHIORI wins" would draw white text on white rows.
  - Sumika (`src/ui/menu.js`): `ODM_NAME_IDS`, `ODM_SIDEBAR_ID`, `ODM_FILL_IDS`, `ODM_REST_IDS`; `odmPass` (the pass,
    three batches through the host's `resources()`, kind `resource`); `odmStem`, `descriptStem`, `odmImagePaths`,
    `colorChannel`, `odmState`; `menuLook(shell, ghost, odm)` puts the answers on top; `Menu.loadShioriLook()` at a
    load (`EventLoop.boot` awaits it right after the NOTIFY batch and 'notified', before the surfaces and the boot
    event; `Menu.setShell` starts it, `Runtime._swapShell` awaits `menu.odmReady` before `shellChanged`); `open()`
    asks after the captions while the load pass was complete (`_odmAtOpen`); passes run one at a time; the look is
    taken at the load (`_popupImages`: menuAccepted on the descripts' images, or the complete pass) and drawn with
    LoadSurface's load-time defaults (`menuColors`' `accepted`, `loadDefaults`); probes per url and edge, the edge
    from the alignment in effect at each open. [decision]s: a resumed page's menu is new, so a page change asks as a
    load; each batch of the load pass waits up to 5 s (`ODM_LOAD_MS`; an open's take `resources()`' 300 ms and the
    last answer seen), and the boot waits for the requests, not for the images; a colour's flag before the load pass
    waits for the descripts' images only when the descripts set that colour; a `!` name loads nothing (no SSP data
    folder here). The ghost sweep builds no Menu, so it sends none of these.
- Colors (0–255 per channel): `menu.background.font.color.*` (normal text), `menu.foreground.font.color.*` (hovered text),
  `menu.separator.color.*`, `menu.disable.font.color.*`; also `menu.background.color.*`, `menu.foreground.color.*`
  (the fills) and `menu.frame.color.*` [disasm LoadFromDescript]. Font: `menu.font.name` / `menu.font.height` in ghost
  descript (SSP); a shell's are read too, as every `menu.*` key.
- SSP's own default look [res SSP-ODM]: data-folder images `menu_background/foreground/sidebar`,
  alignments righttop/righttop/bottom, text black, hovered text white, disabled 217,217,217, separator 160,160,160.
  Its background and foreground images are 1 × 1 pixel, white and black [res `data/ssp-pictures`]. SSP uses it when
  `SPMenu::LoadSurface` fails; then `SPGhost::LoadGhostCore` loads `ssp_default_odm.txt` over the descripts' keys
  [disasm 0x61f8b3, 0x694f20]. LoadSurface succeeds with a background and a foreground image that both load, or with
  `menu.background.color` and `menu.foreground.color`, or with `menu.sidebar.color` [disasm 0x69503c..0x69506f]. A
  colour counts only while its own image did not load: the test runs after PreparePopup's SetValues, which replaces a
  colour with its loaded image's edge pixel and clears the colour's flag [disasm 0x695598]. So a background image that
  loads, a missing foreground image and both colours set: SSP's own look; `menu.sidebar.color` alone: the shell's look
  in Windows' colours (COLOR_MENU rows, a COLOR_HIGHLIGHT hot row). Sumika: `menuAccepted`. Sumika then takes SSP's
  colours (white rows, black text, a black hot row with white text, greyed 217, separators 160) without the shell's
  images; its sidebar image is not copied [decision].
- Tsubasa's shell gives all three images (`menu_background.png`, `menu_foreground.png`, `menu_sidebar.png`) and colors:
  text 15,0,0; hovered 235,255,255; disabled 180,180,180; separator 244,73,71 (shell/master/descript.txt).
- Row spacing: SSP's default vertical padding is 2 px ("Vertical menu spacing (default 2px.)" [res dialog 103]).

**How ssp.exe draws it** [disasm: `SPMenu::CalcMenuTextHeightAndCreateFont` 0x695800, `GetMenuTextHeight` 0x6957a0,
`MeasureItem` 0x695d70, `DrawItem` 0x695f40, `DrawSubMenuArrow` 0x6968e0, `SPMenuHack` 0x697470…]. In emily4's
menu at 125 %, SSP's rows are 19 device px [observed]. All items are owner-drawn, separators
included. Implemented in `src/ui/menu.js` (`menuMetrics`, `menuVars`, `menuColors`).

- **Only the font follows the display.** SSP is per-monitor DPI-aware (`HighDPIAware`, default 1: PER_MONITOR_AWARE_V2)
  [disasm `SPScriptPlayer::PreInitBefore`, `SPHighDPI::SetHighDPIAware` 0x658e50] and takes the font from
  `NONCLIENTMETRICS.lfMenuFont` at the menu window's DPI: Segoe UI 9 pt on an English Windows, 12 / 15 / 18 / 24 device
  px at 100 / 125 / 150 / 200 % [disasm; win32]. Everything else is a constant in device pixels, and the menu images
  are BitBlt'ed 1:1. Sumika: n device px = n / devicePixelRatio CSS px, set as `--smk-*` custom properties on each menu
  element (`menuVars`); the font's em is round(12 × dpr) device px (MulDiv(9, dpi, 72)), which is 12 CSS px at every
  Windows scale; whole device px keep every row on whole pixels. Page zoom changes devicePixelRatio too and counts as a
  display change, as for the tooltip's width (§4.8) [decision]. A devicePixelRatio change while the menu is open
  (another monitor; a zoom also resizes, which closes it) redraws it in place, watched like the characters' (§9.9)
  [decision].
- **Font override**: the face is the first non-empty of SSP's setting `font.menu.face`, the descripts' `menu.font.name`,
  the language pack's `menu.font.name` (commented out in both packs), cut to 31 characters; the height the same way
  (`font.menu.height`, `menu.font.height`, the pack's), as lfHeight = −|v|: **device px, never DPI-scaled**; 0 or none
  keeps lfMenuFont's [disasm 0x695830..0x6958b2]. Sumika: the descripts' (shell over ghost); the face first, then
  Sumika's usual fonts for the glyphs it lacks, as GDI's font linking does [infer]; a height v as v / dpr CSS px.
- **Rows**: the text height th = GetTextExtentPoint32("驫Aj").cy − tmInternalLeading, the em [disasm 0x695930]; a row
  is th + 2 × `ExtraMenuHeight` (the "Vertical menu spacing" setting, default 2, clamped 0–10, not DPI-scaled)
  [disasm `GetMenuTextHeight`, `CDispDlg::OnChangeMenuHeight`]: 16 / 19 / 22 / 25 / 28 device px at 100 / 125 / 150 /
  175 / 200 % [measured: 19 at 125 %]. No padding above the first row or below the last [measured]. SSP's baseline is
  at row top + 2 − ⌊IL/2⌋ + tmAscent (IL = tmInternalLeading) [disasm 0x696591]: 13 / 16 / 18 / 22 / 24 at 100 / 125 /
  150 / 175 / 200 % with Segoe UI (ascent and descent rounded: IL 4 / 5 / 6 / 7 / 8) [font; measured: ink bottom row 15
  at 125 %]. Blink centres the text in a line box of the row's height with ⌊(row − ascent − descent) / 2⌋ above it
  (CalculateLeadingSpace): the ascent then starts 2 − ⌈IL/2⌉ below the row top where SSP's starts 2 − ⌊IL/2⌋ below
  it, so the text is 1 px higher whenever IL is odd (125 % and 175 %; Yu Gothic UI has Segoe UI's metrics, so the
  Japanese menu too) [infer: Blink's layout code]. Sumika: the caption, note and accelerator have the row less 1 px as
  their line height under a 1-px pad when the font's IL is odd (`menuInternalLeading`: the primary font's ascent and
  descent from a canvas, each rounded, else Segoe UI's; `menuMetrics`' `textShift`), which puts the baseline on SSP's
  at every scale [infer; at 125 % that puts the cap top at row 5 and the access key's underline at row 17, not
  compared with a screenshot]. Without the floor the baseline and underline come out 1 px high at 125 % and 175 %.
- **Separators**: 2 × 2 + 7 = 11 device px at every scale, a 1-px line at top + 5 in `menu.separator.color` from the
  sidebar's right edge to the right edge, no margins [disasm 0x695d9e, 0x696498; measured].
- **Across a row**: the caption starts 16 px right of the sidebar; an **accelerator** (the caption's text after its last
  `\t`) ends 16 px left of the right edge, on the caption's baseline [disasm 0x6965de, 0x6966c6]. An item is as wide as
  caption + 32 (+ 8 + accelerator) + the sidebar, at most 1000; Windows then adds 2 × the menu font's average character
  width to an owner-drawn popup item [win32: Wine `MENU_CalcItemSize`], `GdiGetCharDimensions`' cx = (⌊w / 26⌋ + 1) / 2
  of the advance w of `a`–`z` `A`–`Z`, with Windows' own menu font (descript fonts do not change it): Segoe UI at
  12 / 15 / 18 / 21 / 24 px gives w = 347 / 431 / 518 / 605 / 691 (its hinted widths; the linear ones give the same cx),
  so 14 / 16 / 20 / 24 / 26 device px at 100 / 125 / 150 / 175 / 200 % [font; measured: ≈ 16 at 125 %]; no minimum
  width (`ExtendMenuWidth` off) [disasm `MeasureItem`; measured: emily4's 300-px background, a 232-px menu]. Sumika:
  16 / 16 device px, an 8-px gap, and Windows' share after the caption (`menuExtraWidth`, from Segoe UI's design
  widths; Yu Gothic UI's are the same) [font]; a fixed 12.8 CSS px would be 1.2 device px short at 100 % and 1.6
  at 175 %. Sumika's notes ("(display)", "(needs AYA)") sit in the accelerator's column.
- **Check column**: centre x = sidebar + 7, y = top + 2 + ⌊(row − 2) / 2⌋; a tick, Polyline (cx−2, cy−1) → (cx, cy+1)
  → (cx+5, cy−4) with a 2-px pen, or a dot, Ellipse(cx−4, cy−4, cx+5, cy+5) without a pen, in the text colour; never
  scaled [disasm 0x696706..0x696836]. SSP takes the dot for command ids 6000–59999 (0x1770..0xea5f) [disasm 0x696754],
  whatever the item's role. Those ids [disasm]: the scaling percentages (6000 +) and the languages (6100 + i); Shell ▸
  6500 + i (`CSakuraWnd::InitShellMenu` 0x4978f3); Change ghost ▸ 35000 + i and Call ghost ▸ 20000 + i (2.9.10's
  `CSakuraWnd::OnCommand` 0x496a40 sends 35000 + i to the change, 20000 + i to the call)
  (`InitGhostMenu`, CheckMenuItem at 0x49a5cb / 0x49a5ee); Balloon ▸ 50000 + i (`InitBalloonMenu` 0x49a7ee); the
  dress-up parts 13000 + i (`CCharWndCode::UpdateBindMenu` 0x41ef79). The tick: Use System Lang. (5056) and the
  auto-numbered submenu rows (≥ 62899: a checked auto dress-up category). Sumika: the dot on the model's `radio` items
  (scaling, languages, Change / Call ghost, Shell, Balloon) and `dot` items (dress-up parts, still check items:
  `menuitemcheckbox`). Drawn as SSP's pixels (`box-shadow` pixels in the text colour; which pixels GDI fills is
  [infer]).
- **Submenu arrow** (Windows' own is clipped away): a = max(⌊3 th / 10⌋, 4), w = max(⌊(10 a + 5) / 9⌋, 3), a filled
  triangle from x0 = right − 8 − ⌊w/2⌋ to the apex at (x0 + w, cy), in the row's text colour (hot and greyed
  included) [disasm `DrawSubMenuArrow`]: 5 × 7 pixels 5 px clear of the edge at 125 % [measured], 6 × 9 at 150 %,
  8 × 13 at 200 %. Sumika: the same pixels, ⌈w (a − |j|) / a⌉ in row cy + j, as GDI fills the measured one [infer].
- **Hot row**: the whole row right of the sidebar, no inset or rounding, showing the foreground image 1:1. A greyed
  row is highlighted too and keeps its greyed text: the background follows ODS_SELECTED alone [disasm 0x6961d4]
  (Sumika: the pointer highlights a greyed row; the keys still skip them). The pointer on a separator, or off every
  menu, leaves no row hot: Windows selects the separator (SSP draws it without a highlight: it has no command id), or
  nothing in the menu the pointer left; a submenu's parent row stays selected [win32: Wine `MENU_MouseMove`; disasm
  DrawItem]. Sumika: a separator clears the hot row (a submenu waiting to open does not open), and so does leaving the
  menu, except the row of the open submenu, which on a separator stays hot until that submenu closes after a plain row's
  delay [decision].
- **Colours** [disasm `InitMenuProp` 0x694430, `LoadSurface` 0x694f20, `SetValues` 0x695510]: text default
  COLOR_MENUTEXT (black), hot text COLOR_HIGHLIGHTTEXT (white); the fill behind the rows is the background image's
  edge pixel, else `menu.background.color`, else COLOR_MENU (240,240,240 on Windows 10/11 [win32]), behind the hot row
  the foreground image's, else `menu.foreground.color`, else COLOR_HIGHLIGHT; the edge pixel is the image's left
  column, its bottom pixel (the top one when its alignment has the "bottom" flag). **Greyed text** defaults to
  (2 × fill + text) / 3 per channel, the separator to the text colour.
- **Images**: background, foreground and sidebar at one image pixel per device pixel [disasm: BitBlt, no StretchBlt]:
  Sumika's image px / dpr CSS px, unlike the shells, which follow the display (§9.9). The sidebar only in the main menu
  (depth-1 items). The background and foreground are aligned **in the area right of the sidebar**, A = right −
  sidebar wide, blitted from x = sidebar: left at the sidebar, centre at sidebar + ⌊(A − w) / 2⌋ toward zero (a wider
  image: its own middle, the same place), right at right − w [disasm DrawItem 0x69627d..0x6962fd; measured: emily4's
  300-px `background.png` (`centertop`) matches 8.png best with its left at client x −23 = 24 + (206 − 300) / 2, mean
  difference 20.3 against 29 and more elsewhere]. Vertically top / bottom of the whole list
  (`SPMenuItem::GetMenuHeight`) [disasm]. Submenus have no sidebar, so there A is the whole width. Sumika: `_imageAt`
  takes the sidebar's and the list's widths, the list's height (the list is as tall as its rows, also when the menu
  scrolls) and leaves a scrollbar out; the hot row's foreground uses the same place. Aligned against the whole menu,
  sidebar and scrollbar included, emily4's sketch would sit 12 device px left of SSP's and Tsubasa's motif 25, and a
  bottom-aligned image in a scrolling menu would end at the bottom of the first screenful.
- **Frame**: 1 device px in `menu.frame.color` (default black), drawn by SSP over the menu window; on Windows 11 the
  window gets DWM's small rounded corners (DWMWCP_ROUNDSMALL) and shadow [disasm `SPMenuHack::AddMenuData` 0x6978a0,
  `WindowProcReal` 0x697dc0; measured]. Sumika: a 1-device-px border, radius 4 CSS px on every OS (a page cannot tell
  Windows 10's square corners apart) [decision], a box-shadow fitted to the screenshot (`0 11px 10px -2px`, 10 %)
  [measured]. A Windows contrast theme (`forced-colors: active`) turns `box-shadow` off, which would hide Sumika's
  check, dot and arrow (pixel lists): they keep theirs (`forced-color-adjust: none`), in the row's forced text colour,
  and the separator's line is CanvasText [decision; the hot row stays the browser's forced look].
- **Opening**: no fade or slide (SSP turns SPI_SETMENUANIMATION off around TrackPopupMenu) [disasm `ShowPopup`
  0x6956b0]. Opened by the pointer, no row is hot until the pointer or a key picks one [measured]; Down then takes the
  first row, Up the last [win32]. A submenu's first row is level with its parent row [win32 infer].
- **Opened by a touch** (a long press, §9.6): SSP has no touch, and its device-pixel rows are about 13 CSS px on a
  phone (dpr 2.625–3), targets of about 2 mm. Such a menu gets the least spacing that makes its rows 24 CSS px (WCAG
  2.5.8), as if SSP's "Vertical menu spacing" were set that high (separators 2 × spacing + 7, the marks' row from
  SSP's formula); the check and dot keep their size. A mouse or pen keeps SSP's 2 [decision: SSP fidelity for
  the mouse, usable targets on a phone]. `EventLoop._openMenu` passes `device: 'touch'`; `menuSpacing`.
- **Not done**: `menu.sidebar.width` / `.text` (a SHIORI's are asked and kept, never drawn), and `.color` beyond
  deciding whether SSP takes the look (above); the tiled images and the `ExtendMenuWidth` minimum; the bold default
  item; SSP's 1000-px cap is also kept inside the viewport. The descripts' side of the menu images, which no site
  ghost needs (each one with images names all three in its descript): InitMenuProp's default names
  (`menu_background*.png` found with no key), numbered descript images (LoadSurface loads every `<stem><digits>.png`
  and each popup picks one at random [disasm 0x697306..0x69758d, PreparePopup 0x697b70]), the descripts' images also
  looked for in `ghost/master/` and always as `.png`. SPColor's exact reading for the descripts' keys (Sumika needs all
  three channels and clamps to 255; the SHIORI's go through `colorChannel`, but a colour that gets only some channels
  still counts as unset here); LoadSurface's defaults are copied for the load only as menuColors computes them; a
  set fill colour that InitMenuProp keeps across a shell reload. The kana of a Japanese caption: on an English Windows GDI links Segoe UI to
  Tahoma, then Meiryo UI (`FontLink\SystemLink` on the measured system), so SSP draws kana in Meiryo UI, at 16 device px for
  Segoe UI's 15 at 125 % [win32 registry; measured]. Sumika: Meiryo UI next after Segoe UI (Tahoma has no kana), so the
  same typeface, at the em (about 6 % narrower) [decision: matching the size needs an `@font-face` with `size-adjust`
  in the host page's own document]. The Japanese UI language keeps Yu Gothic UI first,
  a Japanese Windows' menu font. SSP's text is GDI ClearType hinted to whole pixels; the browser renders its own way.

**Expected side by side with ssp.exe** (emily4 at 125 %; not compared point by point): rows 19 device px,
separators 11 with their line touching the sidebar and the right edge, the menu 2 + 19 × rows + 11 × separators tall (361 for 16 rows and 5 separators), no
gap above the first row; the caption 16 px after the sidebar, its capitals from row 5 and the access key's underline on
row 17 of the row (the baseline rule above); the arrow 5 × 7 at 5 px from the edge; the black frame with round corners;
the sidebar and the sketch at their real size, the sketch at the same place as SSP's; no row highlighted at open; a
greyed row under the pointer highlighted with grey text, and nothing highlighted on a separator or outside the menu;
the round dot on the current shell, balloon and ghost; the kana of おともだち in the same typeface; a ghost without menu
images (DSLGS, etherism or roommate): SSP's black-on-white look with a black hot row; then the same at 100 % or 150 %
(rows 16 / 22). The SHIORI's skin: BloodTeaHOUSE ver.5's right-click menus of both characters in both
shells (5th-Normal, then Shell ▸ 5th-Smart) side by side: its background, sidebar and hot-row images at the bottom
left, black text, white text on the hot row, greyed rows 222,222,222, black separators; etherism still SSP's black on
white.

### 2.4 Recommend/portal site lists — P0

Format of the resource value [doc UKADOC:res]: items separated by byte `0x02`, and fields within an item by `0x01`:
`name 0x01 url 0x01 bannerPath 0x01 talkScript 0x02 name 0x01 …`. Rules:
- The whole value has SSP's `\&[name]` entities decoded first, then it is split (GetStringShiori → SPGhost::DecodeEntity
  [disasm 0x713033]; `shiori-events.md` §5.5): `Tom \&[amp] Jerry` is shown as `Tom & Jerry`, and a URL written
  `?a=1\&[amp]b=2` opens `?a=1&b=2`. No name decodes to `0x01` or `0x02`.
- The talk script field may be absent. Satori sends only 3 fields per item, plus a trailing `0x02` [src Satori `GetURLList`].
- If `url` starts with `script:`, picking the item **runs the rest as SakuraScript** instead of opening a page [doc UKADOC:res].
- Treat an item whose name is `-` as a separator [infer; common practice, not in UKADOC].
- Satori builds each item from one `＊sakura.recommendsites` (or `＊sakura.portalsites`, `＊kero.recommendsites`,
  `＊char<n>.recommendsites`) section. Line 1 is the name, line 2 the URL, line 3 the banner (optional), and lines 4+ the talk spoken on pick.
  Satori returns that talk as the reply to OnRecommendsiteChoice [src Satori `GetRecommendsiteSentence`, EventOperation].
- **OnRecommendsiteChoice** references [doc UKADOC:ev]: R0 site name, R1 URL, R2 banner (thumbnail shown on hover), R3 `recommend`|`portal`,
  R4 `0`/`1`/n (which character's list), R5 0-based index in the menu. Satori needs R3 and R4 to find the right list [src].
- Tsubasa (dic06_String.txt): portal "Home Sweet Home" → http://macapeng.web.fc2.com (its banner field holds another URL);
  recommend "Yuuri" → http://railway.nanika.jp/top.html. These are old 2000s fan sites, so expect dead links. Still open them.
- Banners: SSP shows the banner image while the item is hovered. Optional (P2). Never fetch remote banners automatically: that is a
  privacy issue on a third-party page. Only show local paths inside the ghost folder.

### 2.5 When and where the menu opens — P0

- **Trigger**: right-button release on a character's opaque pixel. Sequence: send `OnMouseUp`(…, R5=1); if it returns no script, send
  `OnMouseClick`(…, R5=1); **if that also returns no script, open the menu** at the pointer [src ninix sakura.rb `notify_event`:
  the menu opens only when the OnMouseClick reply is empty; SSP believed to match [?]]. Tsubasa answers a right-click only during
  her bean-throwing event and only when her "use right click" option is on (dic14_Mouse.txt `＊OnMouseClick`). So normally the menu opens.
- On touch: a long press (≥ 500 ms, < 10 px movement) acts as a right-click; on a pen, the barrel button does (§9.6).
- Which menu opens: the clicked character's own (scope 0 the main menu, else the abbreviated one) unless its
  `<p>.popupmenu.type` names another character, whose own menu it then gets (`kero.popupmenu.type` 0: the main menu on
  `\1`); `<p>.popupmenu.visible` 0: none. §2.1 Notes, "Which menu a right-click opens" [disasm].
- SSP also opens the main menu from the tray icon. Sumika's analog: right-click or long-press on the minimized launcher icon (§2.6).
- Keyboard: Esc closes it; arrows move; Enter picks; access keys work. It opens with no row hot; Down takes the first
  row, Up the last (§2.3).
- Exclusive: open menus close on pointerdown outside, on scroll, on blur, and when a new menu opens.
- Placement: open down-right of the pointer; flip up/left when it would overflow the desk; submenus open to the right or flip left.

### 2.6 Iconify and Close in a browser — P0

- **Iconify**: send `OnWindowStateMinimize`(R0 = `user` from the menu, `script` from `\![set,windowstate,minimize]`) [doc UKADOC:ev].
  SSP can let the ghost talk before it shrinks ("Don't talk while minimizing" option); play the reply first, then minimize.
  Minimized means: hide all character windows and balloons; stop SERIKO; keep the SHIORI tick (cantalk=0, status `minimizing`).
  Show a small launcher in a desk corner, with the ghost's **tray icon** as its image, following SSP [decision].
  ssp.exe 2.9.10.3000 shows a minimized ghost as
  her notification-area icon:
  - **Which icon** [disasm]. Iconify sets the minimize state (SPGhost+0x419c −2), calls `ReloadTrayIcon(NULL)`, sends
    OnWindowStateMinimize, hides the windows and sets it to 1; restore sets it to 0, sends OnWindowStateRestore, then
    `ReloadTrayIcon(NULL)` (`ToggleMinimize` 0x498fb0: 0x499146, 0x499162, 0x49912b). `LoadTrayIcon` 0x49e460 keeps
    the path shown (CSakuraWnd+0x62c) and a script's path (+0x6b8): a call without script info empties the script's
    (0x49e540); minimized, the path shown becomes descript `icon.minimize` when that file exists, else stays what was
    shown before (0x49e56e–0x49e5c3); not minimized, it is the script's path if that file exists, else descript
    `icon` (0x49e5c5–0x49e614). So a minimized ghost shows `icon.minimize`, else the icon shown before (a script's
    `\![set,trayicon]` icon, else her `icon`), and a restore forgets the script's icon.
  - **The files** [disasm]. `GetIconName` 0x6373c0: descript `icon` (or `iconfilename`, the same field; the last line
    wins, `LoadDescript` 0x6246ad), `icon.ico` when none or empty; the ghost root + name, then `ghost\master\` + name,
    the first that exists (`IsIconFileExist` 0x6c4b60, which also accepts numbered frames `name<digits>.ext`).
    `GetIconMinimizeName` 0x6375f0: descript `icon.minimize` (none: none), same two places, the plain file only.
    Nothing loads: SSP's own icon, resource 110 (16 × 16, 4 bpp: a magenta bow with a gold bell; 0x49e797,
    `LoadSmallIcon` 0x492c10) [measured: ssp.exe's resources; the install has no separate .ico of it].
  - **Decoding** [disasm `SPLoadIconFromFileImpl` 0x6726e0]: a file starting `BM` is a BMP made fully opaque; else an
    ICO, the 16 × 16 entry for the small icon (closest bit depth to 32), else the closest size. Chromium 152's `<img>`
    takes an ICO's **largest** entry and a BMP named `.ico` as a BMP [measured; Firefox
    and Safari not measured]. Every site ghost's icon has one size, so the browser shows SSP's picture.
  - **`\![set,trayicon,path,tooltip,--duration=,--runcount=]`** (`trayi…` / `tasktrayi…` as prefixes, any case: the
    `\![set]` table at 0xbbc710, id 0x6d) [disasm `SetTrayIconName` 0x61f160]: no or an empty path reloads without
    script info; else the ghost root + path, then `ghost\master\` + path, and a missing file changes nothing. Found:
    the icon shown from then on (minimized: until the restore, unless `icon.minimize` exists).
  - **Sumika** (`src/core/trayicon.js`, `ghosts.json` `icon` / `iconMinimize`, `Launcher.setIcon`): the index records
    the two files by GetIconName's / GetIconMinimizeName's rule (site paths, only when found); the EventLoop keeps a
    script's icon (`trayIcon`), moves it into `minimized.icon` at Iconify and forgets it at the restore; the launcher
    shows `iconMinimize`, else `minimized.icon`, else `icon` (`launcherIconPath`); a `\![set,trayicon]` while minimized
    repaints the button. A page change keeps the script's icon (a resume), a cold boot drops it [decision: SSP has
    no pages]. [decision]s: no icon, or one that does not load, shows her **initial letter** in place of SSP's bow
    (SSP's readme asks not to redistribute parts cut out of SSP, so the bow is not shipped); **no thumbnail
    fallback** (SSP's tray never shows one); the closed button ("Call X") shows her `icon` (SSP has no closed state); the icon is drawn at 16 × ⌊2 × dpr⌋ device px (32
    at 100–149 %, 48 at 150–199 %, 64 at 200 %; at most 32 CSS px), its natural size fitted in, pixelated at a whole
    scale of 2 or more (`trayIconDevicePx`, `launcherIconBox`; SSP draws the 16-px icon at the tray's size). Not done:
    numbered frames and the animated icon (`--duration`, `--runcount`), the tooltip (the script's text, else
    `SSP[Minimize]/` + name: the label stays Sumika's "Show X"), a PNG named `.ico` (shows here, not in SSP), the
    untrusted-script refusal of the tag (properties.md §8). nodepsimoon (descript `TrilliumC.ico`, missing) and
    like_a_cat (no key, no `icon.ico`) show SSP's icon in SSP and the initial here; only emily4 has `icon.minimize`
    and uses `\![set,trayicon]` (a battery icon after OnBatteryNotify, which Sumika never sends, and
    `\![set,trayicon,icon.ico]` from her config menu).
  A click or tap restores and sends `OnWindowStateRestore`(R0 reason, `user`). Persist the minimized state across pages.
  Tsubasa reacts to both events (dic02_Event.txt) and minimizes herself from key `s` and from her panel button `Mminimize` (corpus 5×).
- **Close**: send `OnCloseAll`(R0 `user`, R1 menu scope, R2 window scope). If it returns 204, send `OnClose` with the same references [doc UKADOC:ev].
  Satori appends `\-` to every OnClose reply (not to OnCloseAll) [src Satori EventOperation]. Play the script; at `\-` (or at the end of an OnClose
  script without `\-`) the ghost is closed: flush SHIORI save files, hide everything, and store `closed=true` for this site.
  Leave a small "call ghost" launcher. Clicking it boots the ghost (`OnBoot`) [infer; product decision, see open questions].
  The browser closing a tab is **not** a ghost close: never send OnClose on `pagehide`.
- Tsubasa's panel has a press-and-hold close: `Mclose` OnMouseDown records the time, and OnMouseUp > 1 s later runs her goodbye
  (dic14_Mouse.txt). This needs OnMouseDown/OnMouseUp with collision names on scope 99.
- **Several ghosts on screen** (§2.12):
  - **Iconify** hides **that ghost only**: its characters, balloons and boxes; the others keep talking. Each minimized
    ghost gets **its own launcher button** (SSP: its own tray icon), and restoring it sends OnWindowStateRestore to it
    alone [disasm `ToggleMinimize`; doc SSPHELP howto-rclick]. SSP's Ctrl+Iconify (every ghost at once,
    `CMainFrame::AllMinimizeToggle`) is not done.
  - **The launcher dock** [decision]: the buttons stack upward from the bottom-right corner, right 16 px and bottom
    16 + 56 × i px (48 px buttons, 8 px apart), i = the button's order among the visible ones in set order (the
    order the ghosts were called in); one ghost uses the corner itself (`Launcher` `slot` / `setSlot(i)`,
    `launcherBottom(i)`). A restored ghost's button goes and the ones above it move down.
  - A "Show X" button left on a ghost that this tab shows frozen (it is minimized in the tab that runs the set) stays;
    a click asks for the whole set (the takeover of §9.5), never a cold boot of X alone. Known gap: a minimized ghost
    whose resume fails after a bfcache restore keeps its "Show X" button, and a click on it does nothing until the
    page is reloaded.
  - **Close** of one ghost among several: only it goes (OnClose, at `\-`); no launcher. **Quit**, or Close of the last
    ghost: every ghost says goodbye, then **one** closed button "Call X" (X = the first ghost of the set); its click
    calls the **whole** set back, one ghost at a time, each with OnBoot [decision; SSP restores the whole list at its
    next start, disasm `SaveBootingGhostData`]. The button appears once the last ghost has finished its own unload
    (EV §2.7.3). A ghost that closes loses its dock button at once: a ghost minimized at Quit closes without its
    goodbye (OnCloseAll / OnClose sent, reply dropped, then OnDestroy and unload) [disasm, EV §2.3], its "Show X"
    button goes, a click on it during that close restores nothing, and one still on its way boots nothing.
  - With the closed button showing, the page API brings back **one** ghost: `window.sumika.callGhost(id)` or
    `changeGhost(id)` boots `id` alone, cold (OnBoot; OnFirstBoot if never met), in the button's place, and the stored
    set becomes `[id]` [decision]. A failed call brings the button back with the old set (EV §2.7.1, §2.7.2).
  - **Tucked** (phones with `data-phone="tucked"`, §9.11) [decision]: a set start that would cold-boot the stored set
    in a tab shows one "Show X" button for its first ghost (mode `'tucked'`, Iconify's icon) and runs nothing; a tap
    starts the set as a first visit would. The page API follows the closed button's rules above, and a failed call or
    change puts the tucked button back.
  - Passive and induction mode are per ghost: another ghost's menu and keys are not affected [disasm `GetEnableState`
    per window].

### 2.7 What Tsubasa puts in the menu (dic06_String.txt) — P0 data check

`portalrootbutton.caption` "The Basics(&R)"|"Standard(&R)"; `recommendrootbutton.caption` 3 random captions;
`updatebutton.caption` 3 random captions, `updatebutton.visible` 1; `vanishbutton.caption` 3 random captions, `vanishbutton.visible` = `（消滅指示表示）` (a user option);
`readmebutton.caption` "About the Current Shell(&R)"; `dressuprootbutton.visible` 1, `.caption` "Dress-up(&C)";
`hidebutton.caption` "Hide for a Bit(&R)"|"Everybody Get Down!!(&R)"; `homeurl` empty; `username` = `（ユーザ名）`.

### 2.8 Ghost-side menus are the real menus (context for implementers)

Tsubasa's everyday menus are **balloon choice menus**: a double-click on her body (`＊OnMouseDoubleClick` → `＊0つつかれ`) or
key `m`. She also has an **on-screen panel on scope 99**. Surface 9700 is a 204×125 image with collision regions `Mmenu`, `Mtalk`,
`Mcommunicate`, `Mgame`, `Mdress`, `Mmusic`, `Mweather`, `Mgomi`, `Mdate`, `Mupdate`, `Mconfig`, `Mx`, `Mclose`, `Mminimize`.
Surface 9702 is the same box, empty except a 4×4 dot (`surface0010.png` at 200,121). Clicking the dot toggles the panel
(dic03_Menu.txt `＊ワンタッチメニュー表示`, shell surfaces2.txt line ~25350). So for Tsubasa, mouse events on extra scopes
matter more than the SSP menu.

### 2.9 Shell scaling ▸ and Balloon scaling ▸ — P1 (implemented)

What SSP does (evidence):
- **The submenus** [observed, SSP 2.9.08f on a 125 % Windows display]: "Additional settings (Same as ghost
  preferences)", "Other percentage...", a separator, then 300 % 275 % 250 % 225 % 200 % 175 % 166 % 150 % 133 % 125 %
  100 % 80 % 75 % 66 % 50 % 33 % 25 % 20 %. The current one has a bullet; 125 % carries a monitor icon and a house icon.
  The two items sit after Check mail ▸ and before Utilities ▸.
- **The static parts** [res: SSP-RES MENU 102, `scratch/menu_en.txt`]: Shell scaling ▸ holds "Additional settings (Same
  as ghost preferences)" (**id 5072, the same command as Options ▸ Ghost preferences...**, so it opens that dialog) and
  "&Other percentage..." (id 5068); Balloon scaling (&D) ▸ holds only "&Other percentage..." (id 5096) and a separator.
  The percentages are added at run time.
- **Resources** [doc UKADOC:res]: `shellscalerootbutton.caption` ("シェル倍率の名称", SSP and CROW) and
  `shellscaleotherbutton.caption` ("その他の倍率の名称"); every `*.caption` has a `*.visible` (1 shown; 0 "hidden" in
  UKADOC's words, which ssp.exe draws greyed in place, §2.11 [disasm]).
  `balloonscalerootbutton.` and `balloonscaleotherbutton.` are not in UKADOC but are in ssp.exe's strings, next to the
  shell ones, in menu order [res: `scratch/ssp_strings_w.txt` 0x738e20–0x738eb4].
- **Events** [doc UKADOC:ev, "その他イベント"]: `OnShellScaling` "シェル倍率が変更された際に発生" and `OnBalloonScaling`
  "バルーン倍率が変更された際に発生", both R0 new horizontal %, R1 old horizontal %, R2 new vertical %, R3 old vertical %.
  Neither is marked NOTIFY.
- **`\![set,scaling]`** [doc UKADOC:ss]: "ユーザの設定する倍率を100％とした倍率" (percent of the user's setting), so it
  multiplies the user scale. `currentghost.scope(ID).scaling` is "ユーザー設定×タグ設定×SERIKO設定" [doc
  UKADOC:property]; `currentghost.balloon.scope(ID).scaling` the same for balloons.
- **Settings** [doc SSPHELP config-ghost2 "シェル倍率 [シェル個別]", res dialog 145]: the shell scale is per shell;
  "Link balloon's scaling" (バルーンも連携する) makes the balloons follow it; "High-quality scaling" options for both;
  "Scale all shells... / Scale all balloons..." set the defaults every ghost without its own choice uses (SSPHELP faq
  qna-scaling). `balloon.syncscale,true` (ghost descript) and `<scope>.balloon.syncscale,true` (shell) force the link
  on [doc UKADOC:ghost, UKADOC:shell].

What Sumika does (src/core/scaling.js, menu.js, Stage.setScale, Balloons.setScale):
- **Percentages are device pixels**: SSP is DPI-aware, so 100 % = one image pixel per screen pixel, and its default on a
  125 % display is 125 % (the monitor icon = matches the display, the house = default) [infer from the observed submenu].
  The browser already scales CSS px by `devicePixelRatio`, so p % = CSS scale `(p/100)/dpr`; **no choice = follow the
  display = CSS scale 1**, shown as the bullet on `round(dpr × 100) %`, which carries the note "(display)" (text, as the
  menu font has no monitor icon). A display percentage SSP does not list (110 %) and an Other percentage (140 %) are
  inserted into the list in order [guess: what SSP shows for those is unknown].
- **On a phone** (§9.11) [decision] no choice is the **fit**, not the display: the shell's and the balloon's phone
  defaults (`phoneFit`, `balloonFit`), shown as the bullet on their percentage, with Default labelled "Default (fit to
  screen)"; never stored, no event for it, and a pick still wins.
- **"Additional settings (Same as ghost preferences)" → "Default (match display)"** (DECISION): there is no Ghost
  preferences dialog in a browser; the honest equivalent is going back to no choice. Greyed out while there is no choice.
  Sumika puts it in Balloon scaling ▸ too (SSP has no such item there [res]), as the only way back to following the
  display.
- An explicit percentage keeps its size in device pixels when the page zoom or the monitor changes (the runtime
  re-applies on `resize` and a `(resolution)` media query); the default zooms with the page like page content.
- **Other percentage...** opens the input box (balloonc3) with the percentage in effect (placeholder "10–500 %" when
  emptied; `%` and full-width digits accepted). A number is rounded and kept within 10–500 (600 → 500) and applied;
  text that is no number brings the box back with that text, pulsing, until a number or a cancel, so a bad entry is
  never a silent no-op [guess: SSP's own range and what its dialog does with bad input are unknown].
  `shellscaleotherbutton.visible` / `balloonscaleotherbutton.visible` 0 grey it (the caption/visible rule, §2.11). Both
  submenus are greyed at enable level ≥ 2 (minimized, induction or passive mode) [disasm].
- **Per ghost**, in its state (`scaling: {shell, balloon}`, % or null), so it survives page navigation and ghost changes;
  applied when the stage and balloons are made (boot, resume, change) [DECISION: SSP keeps it per shell; a ghost runs
  one shell at a time].
- **Shell scaling** multiplies every character of the running ghost (`Stage.scale`; `\![set,scaling]` on top). Each
  character grows about its base point, stays docked, stays against the desk's left or right edge it stood against
  (the first-boot corner), and is kept wholly on the desk if it was, else a corner in view [infer]. Hit tests, mouse
  references (surface px), drags and the first-boot layout use the scaled sizes. The shell's balloon offsets scale with
  it [guess]. A character canvas is drawn nearest-neighbour (`image-rendering: pixelated`) whenever each image pixel
  covers a whole number of device pixels (100 / 200 / 300 %, and no choice on a 100 % or 200 % display), so it stays
  pixel-exact at a fractional device position; other ratios (no choice on a 125 % display, `\![set,scaling,75]`) are
  smoothed by the browser [guess: which of SSP's "High-quality scaling" settings is its default is unknown].
- **Balloon scaling** scales every balloon (text, choices, hover, arrows, click-wait marker, `\_b` images) by a CSS
  `scale()` on the balloon element; every canvas's backing store is image px × dpr × scale, drawn nearest-neighbour, so
  text stays crisp (with an explicit percentage dpr is the real devicePixelRatio, so p % is p/100 canvas px per image
  px at any page zoom; with no choice it is clamped to 1–3). When devicePixelRatio changes, balloons already on screen
  are redrawn at once, also when their CSS scale stays 1. Choices and links hit where they are drawn (the pointer maps
  back through the element's box);
  placement and drags use the scaled size; the balloon's `windowposition` offsets scale with it [guess].
- **Not scaled** [guess]: the input and communicate boxes keep the size they have (image px on mouse devices, §6.1);
  whether SSP's follow balloon scaling is unknown. The menu itself is not scaled.
- **Events**: OnShellScaling / OnBalloonScaling [new %, old %, new %, old %] as GET (origin user) when a menu pick changes
  the size in effect; not at boot and not for devicePixelRatio changes [guess].
- **Not done**: "Link balloon's scaling" and `balloon.syncscale` (balloons following the shell scale), high-quality
  (smoothed) vs nearest scaling options, SSP's site-wide default scales. (`%property[currentghost.scope(ID).scaling]`
  answers the tag scaling × Shell scaling ▸ in device px [infer], properties.md §5.6.)
- **Compared** [observed]: side by side with ssp.exe, no difference was noticed. The [guess] lines above were not
  checked one by one.

### 2.10 Language ▸ and the runtime's UI text in Japanese and English — P1 (implemented)

What SSP does (evidence):
- **The item** [observed, SSP 2.9.08f]: a top-level "Language" whose caption is "Language" in both languages;
  its submenu: Japanese, English, a separator, Use System Lang.; the current language has a bullet. In both languages'
  MENU 102 it is `&Language` [res: SSP-RES-JA `menu_ja.txt`, SSP-RES `menu_en.txt`]. The submenu is built at run time:
  ssp.exe empties Language ▸ (a `RemoveMenu(…, 0, MF_BYPOSITION)` loop, code at file 0x9AC4B → 0x68F980), then inserts
  the pack names from each pack's `data/language/<dir>/descript.txt` `name` (Japanese, English; ids 1041, 1033), a
  separator and its hard-coded `&Use System Lang.` (UTF-16 in .rdata at file 0x739C38, inserted with id 5056 by the
  code at 0x9ADD9 through `InsertMenuItemW`) [res: ssp.exe 2.9.08f disassembly]. So the caption is "Use System Lang."
  in every language; resource.dll's static `&Use system lang.` (and ssp.exe's own `&Use System Lang.` resource item)
  never show. UKADOC:res has no caption or visible resource for it ("[変更不可]Languageの名称"). SSPHELP howto-rclick
  #19: "SSPの言語を変更します。設定は再起動後に反映されます。※ゴーストのトークまで翻訳されるわけではありません。"
- **Use System Lang.**: the packs' descript.txt say their `id` "is used for auto-recognition of system language ... If
  SSP cannot find Taiwan Chinese settings, it try to find any other Chinese setting", i.e. SSP matches the OS UI
  language by primary language. What it shows for an OS language it has no pack for is unknown.
- **In Japanese** SSP's own items read e.g. "RSS/ヘッドライン(H)", "シェル倍率(E)", "バルーン倍率(D)", "機能(F)",
  "ゴースト切り替え(G)", "アイコン化(I)", "終了(W)": the resource strings end in `(&X)`, the same letter as the English
  `&X` [res; observed]. Items whose captions come from the ghost (`recommendrootbutton.caption`, …,
  `hidebutton.caption`) keep the ghost's text in both languages [observed: Tsubasa's "Ghost Friends", "The
  Basics", "Everybody Get Down!!"].
- **Event** [UKADOC:ev]: OnLanguageChange, on a change and right after boot (then always NOTIFY); R0 name, R1 langid,
  R2 the pack's folder, R3 its help URL (EV §4.13). No property gives the UI language (`system.os.locale*` are the
  OS's [UKADOC:property]).

What Sumika does (src/core/i18n.js, src/core/language.js, menu.js):
- **Strings**: every visitor-visible string of the runtime is a key in `STRINGS` (core/i18n.js), en and ja. SSP's own
  where SSP has the item (the table below), Sumika's otherwise, worded in SSP's style: its words (標準 for default, 画面 for
  the display, 送信, 閉じる; dialogs 145, 103, 113, 124 in `sspui/dialogs_ja.txt`) and its spacing (a space before
  `(&X)` when the caption already ends in a parenthesis: "詳細設定(ゴーストごとの設定) (&D)...", MENU 102). Ghost text
  is never looked up.
- **Exception, balloon artwork**: the captions drawn on the input boxes' images ("Communicate", "Input", … in the
  built-in balloon, `src/balloon/fallback.js` `BOX_CAPTIONS`, and in `site/balloon/sumika/balloonc*.png`) stay
  English in both languages, like SSP's own default balloon (`balloon/ssp/balloonc1.png` reads "Communicate"); the
  boxes' accessible names and buttons do follow the UI language.
- **Other percentage…'s box** is named like SSP's dialog for it, DIALOG 140 (title "シェル倍率", label "シェル倍率 : ",
  X/Y spinners; Japanese only, resource.dll has no DIALOG 140) [res: `sspui/dialogs_ja.txt`; ssp.exe .rsrc 0x9252EE,
  0x92545E]: box name "シェル倍率" / "Shell scaling" (English: MENU 102's caption without the access key) and
  "バルーン倍率" / "Balloon scaling" [guess: what SSP titles the dialog for a balloon; ssp.exe has no other string for
  it], tooltip "シェル倍率 : 10～500 %" / "Shell scaling: 10–500 %", placeholder the range.
- **Language ▸**, scope 0 only, between Information ▸ and Iconify (SSP's place):
  Japanese, English (always by those names, `lang="en"`), separator, Use System Lang. (ssp.exe's hard-coded caption,
  the same in every language, see above). The language in effect has the bullet; Use System Lang. is a check item,
  checked while it is the choice [observed: SSP marks them the same way]. Picking Use System Lang. again
  keeps it on.
- **The choice is site-wide**, not per ghost (SSP has one setting): runtime prefs `sumika:runtime` key `lang`
  (`ja` | `en` | `system`; nothing stored = `system`). **Use System Lang.** = the first of `navigator.languages` (else
  `navigator.language`) whose primary subtag is `ja` or `en`; none: English [guess]. It applies at once (DECISION:
  SSPHELP says SSP applies it after a restart; side by side with ssp.exe no other difference in Language ▸ was
  noticed [observed]): an open menu is drawn again in place, the launcher and
  open boxes re-label themselves, other tabs follow (`storage` event), and so does a change of the browser's languages
  (`languagechange`) while the choice is Use System Lang. Every (re)start reads the choice again (`Runtime._start`), so
  a page restored from the bfcache, which gets no `storage` event while cached, boots in the current choice.
- **Mnemonics**: Japanese captions carry SSP's `(&X)`, drawn "ゴースト切り替え(G)" with the G underlined; English ones
  underline the letter in the word; the keys work the same in both (parseCaption). One SSP caption opens with a
  full-width parenthesis, Call ghost ▸'s `他のゴーストを呼ぶ（&Z)` (MENU 102; History ▸'s copy of it is half-width) [res];
  it is kept as SSP has it, and the table test accepts `（&X)` as well as `(&X)`.
- **OnLanguageChange**: NOTIFY at every boot (EV §2.1 #10a), GET when the language in effect changes (EV §4.13).
- **Accessibility**: the menu element has `lang` = the UI language, the ghost's rows `lang=""` (unknown), Language ▸
  and its items `lang="en"`; Sumika's note on a ghost's row (Change ghost ▸ "(YAYAが必要)") carries the menu's `lang` and
  its own tooltip. The launcher and the runtime's boxes and buttons have `lang` too. Japanese menus use Yu Gothic UI /
  Meiryo UI first.

| Key | en | ja | Source |
|---|---|---|---|
| menu.recommend | &Recommendations | おすすめ(&R) | SSP |
| menu.portal | Por&tal site | ポータルサイト(&T) | SSP |
| menu.shellScale | Sh&ell scaling | シェル倍率(&E) | SSP |
| menu.balloonScale | Balloon scaling (&D) | バルーン倍率(&D) | SSP |
| menu.scale.default | &Default (match display) | 標準(画面に合わせる) (&D) | Sumika (§2.9) |
| menu.scale.other | &Other percentage... | その他の倍率(&O)... | SSP |
| menu.scale.display | display | 画面 | Sumika |
| menu.scale.displayTitle | {p}% matches your display (its scaling times the browser zoom) | {p}% がこの画面に合った倍率です (画面の拡大率×ブラウザのズーム) | Sumika |
| menu.utilities | Utilities (&F) | 機能(&F) | SSP |
| menu.resetPosition | Reset s&hell position | シェル位置初期化(&H) | SSP |
| menu.changeGhost | Change &ghost | ゴースト切り替え(&G) | SSP |
| menu.callGhost | Call ghost (&Z) | 他のゴーストを呼ぶ（&Z) | SSP (MENU 102 position 15; full-width `（`) |
| menu.callLimit | up to {n} at once | 同時に{n}体まで | Sumika (Call ghost ▸ while the site's cap is reached, §2.12) |
| menu.needs | needs {engine} | {engine}が必要 | Sumika |
| menu.language | &Language | &Language | SSP |
| menu.language.system | &Use System Lang. | &Use System Lang. | SSP (ssp.exe, hard-coded) |
| menu.iconify | &Iconify | アイコン化(&I) | SSP |
| menu.close | Close (&W) | 終了(&W) | SSP (MENU 102) |
| menu.closeSub | Close | 終了 | SSP (MENU 128, scope ≥ 1) |
| menu.shell | &Shell | シェル(&S) | SSP |
| menu.dressup | &Clothes/Dressup | 着せ替え(&C) | SSP (MENU 102 and 128) |
| menu.dressupExplorer | Dressup &explorer | 着せ替えエクスプローラ(&E) | SSP 5086 |
| menu.balloon | &Balloon | バルーン(&B) | SSP |
| menu.info | Inform&ation | 情報(&A) | SSP |
| menu.about | &About Sumika... | Sumikaについて(&A) | Sumika, in SSP 5080's slot ("&About SSP..." / "SSPについて(&A)") |
| menu.readme | About this &ghost... | キャラクタについて(&G) | SSP 5051 |
| menu.terms | &Terms of this ghost... | キャラクタの利用条件(&T) | SSP 5098 |
| menu.help | &Help | 説明書(&H) | SSP 5053 |
| menu.aiGraph | A&I graph | AIグラフ(&I) | SSP 5082 |
| menu.usage | Ghost usage statistics (&R) | 使用頻度表示(&R) | SSP 5052 |
| menu.sysinfo | Output &system information | システム情報を書出(&S) | SSP 5075 |
| menu.leavePassive | Reset &passive mode | 制限モード強制解除(&P) | SSP 5057 |
| menu.options | &Options | 設定(&O) | SSP (MENU 102) |
| menu.preferences | &Preferences... | 本体設定...(&P) | SSP 5071 |
| menu.charMove | Move character window | ゴースト本体移動 | SSP (message.txt `resource.setting.balloon.command` item 6; inserted at run time, no access key) |
| menu.quit | Quit (&X) | 全て終了(&X) | SSP 5049 (both menus) |
| info.readme | About this character | キャラクタについて | SSP DIALOG 109 (title) |
| info.author / .url / .none | Author: / URL: / (N/A) | 作者名： / URL： / (N/A) | SSP DIALOG 109 |
| info.ok | OK | OK | SSP |
| info.terms | Terms of use: {file} | 利用条件 : {file} | SSP DIALOG 175's title [guess: what SSP titles its menu viewer] |
| info.about / .aboutText / .version / .developer / .engine | About Sumika / Sumika runs ukagaka ghosts in a browser tab, from their original files. / Version {v} / Developed by {name} / SHIORI: {name} | Sumikaについて / Sumikaは、伺かのゴーストを元のファイルのままブラウザのタブで動かします。 / バージョン {v} / 開発：{name} / SHIORI：{name} | Sumika (the engine line with DIALOG 109's full-width colon) |
| info.source.ghost / .shell / .balloon | Ghost / Shell / Balloon | ゴースト / シェル / バルーン | Sumika (the readme window's switcher) |
| info.close | Close | 閉じる | Sumika (the window's ×) |
| launcher.call / .show / .someone | Call {name} / Show {name} / the ghost | {name}を呼ぶ / {name}を表示 / ゴースト | Sumika (after SSP's 他のゴーストを呼ぶ) |
| box.input / .communicate / .say | Input / Communicate / Say something | 入力 / コミュニケート / 話しかける | Sumika |
| box.send / .close | Send / Close | 送信 / 閉じる | Sumika (SSP's words) |
| scale.box.shell / .balloon | Shell scaling / Balloon scaling | シェル倍率 / バルーン倍率 | SSP (DIALOG 140; MENU 102) |
| scale.hint | {name}: {min}–{max} % | {name} : {min}～{max} % | Sumika (after DIALOG 140's label) |
| scale.range | {min}–{max} % | {min}～{max} % | Sumika |
| settings.title | Preferences | 設定 | Sumika: SSP DIALOG 124's title without "SSP: " / "SSP:" (§2.13) |
| settings.general | General | 一般 | Sumika: DIALOG 105's title up to its colon ("General: Miscellaneous settings" / "一般 : SSP全体の設定") |
| settings.user | User information | ユーザ情報 | SSP DIALOG 105 |
| settings.name / .nickname / .birthday / .sex | Name: / Nickname: / Birthday: / Sex: | 名前 : / 呼ばれ方 : / 誕生日 : / 性別 : | SSP DIALOG 105 |
| settings.sex.male / .female / .undef | Male / Female / Undefined | 男 / 女 / 未設定 | SSP DIALOG 105 |
| settings.note | Unless otherwise noted, changes will take effect immediately | 一部の設定を除き、変更はすぐに反映されます。 | SSP DIALOG 124 |
| settings.close | Close | 閉じる | Sumika: DIALOG 124's "&Close" / "閉じる(&C)" without the access key |

The communicate box's "OK" glyph is SSP's in both languages (message.txt `resource.common.okcancel`: "OK,キャンセル").
**New UI text needs both languages**: add the key to both tables (a test fails otherwise, also when a Japanese string
still has English words in it). Names that stay in Latin letters in Japanese text ("Sumikaについて", "AIグラフ",
"URL：", "SHIORI：…") are listed in `PROPER_NOUNS` (core/i18n.js), which the test strips before that check; unlike
`SAME_IN_JA` it does not skip the "translated" check.

### 2.11 Shell ▸, Balloon ▸, Clothes/Dressup ▸, Information ▸ and the rest of SSP's menus — P1 (implemented)

Built in `src/ui/menu.js` and `src/ui/info.js` (the switches themselves are EV §2.6, the dress-up events EV
§4.11). Nothing here was compared with ssp.exe on screen; the list at the end names the open points.

**The main menu** (scope 0, SSP MENU 102 [res]; "Move character window" is inserted by ssp.exe at run time
[disasm `CCharWndCode::InitWndMenu`]):

```
Recommendations ▸        greyed when the list is empty (not left out)                               [disasm]
Portal site ▸            greyed when the list is empty                                              [disasm]
----
(Network update, Uninstall: left out, a visitor's browser updates and installs nothing              [decision])
(RSS/Headlines ▸, Plugins ▸, Check mail ▸: left out, §2.1 #5–7)
Shell scaling ▸, Balloon scaling ▸                                                                  (§2.9)
Utilities ▸              Reset shell position; Reset passive mode + ---- before it only with ?sumika-debug   [decision]
Options ▸                Preferences... only: the Preferences box (§2.13)                           [decision]
----
Change ghost ▸           (§2.1 #12)
Call ghost ▸             (§2.1 #13, §2.12) only when more than one ghost may stand
Shell ▸
Clothes/Dressup ▸        Dressup explorer (greyed), ----, the parts
Balloon ▸
(History ▸: left out)
----
Information ▸            About Sumika..., About this ghost..., Terms of this ghost..., Help, ----, AI graph,
                         Ghost usage statistics, Output system information
Language ▸               (§2.10)
Iconify
----
Move character window
----
Close
Quit
```

The abbreviated menu (scope ≥ 1) is in §2.2. The look and the metrics are §2.3.

**Accelerators** [decision]: SSP draws the text after a caption's `\t` right-aligned (§2.3): MENU 102's
"&Iconify\tCtrl+I", "Close (&W)\tCtrl+W", "Quit (&X)\tCtrl+Q", MENU 128's "Close\tCtrl+W", Utilities ▸ Reset shell
position Ctrl+Shift+F12, and the "\tCtrl+U" ssp.exe appends to Network update's caption [res `menu_en.txt`; disasm
`CSakuraWnd::ModifyPopupMenu` 0x494b87]. Sumika handles none of these keys: the event loop leaves every Ctrl / Meta
chord to the browser (`EventLoop._onKeyDown`, §9.7), and the browser owns them anyway (Ctrl+W closes the tab, Ctrl+Q
quits some browsers, Ctrl+U shows the page source, Ctrl+Shift+F12 / F12 the developer tools). So none of Sumika's
captions carries one; a shortcut Sumika handles one day gets its text then. A ghost's own caption with a `\t` shows its
accelerator as SSP does (`parseCaption(…).accel`).

**Rules for every item**:
- **`*.visible` = 0 greys the item; it stays in place** [disasm: `CCharWndCode::ModifyMenuWithTable` and
  `CSakuraWnd::ModifyPopupMenu` turn a `0` reply into `MF_GRAYED`, nothing in SSP's owner-draw menu skips greyed items;
  UKADOC words it "0なら非表示（クリック出来なくなる）"]. HighColorMulti answering `shellrootbutton.caption`
  "これしか持ってません" with `.visible 0` fits [corpus]. Exception: the clicked character's `<p>.popupmenu.visible` 0
  (ParseBool: `false`, `off`, `none` … too) still means no menu at all (§2.1 Notes) [disasm].
  A visible id with no answer, or with an empty one, leaves the item enabled; with a legacy visible name
  (SSP's `vanishbuttonvisible`, for the Uninstall Sumika leaves out) the first id that answers decides.
- **Legacy caption names are asked first** [disasm]: `sakura.recommendbuttoncaption` → `recommendrootbutton.caption`;
  `sakura.portalbuttoncaption` → `portalrootbutton.caption`; `updatebuttoncaption` → `sakura.updatebuttoncaption` →
  `updatebutton.caption`; `readmebuttoncaption` → `readmebutton.caption`; `vanishbuttoncaption` → `vanishbutton.caption`
  (Sumika asks no update or vanish ids: those items are left out).
  Everything else: `<id>.caption` / `<id>.visible`. When a menu opens, the clicked character's `popupmenu.visible` and
  `popupmenu.type` go first (§2.2 notes), then all of the shown menu's ids in one batch (57 for the main menu, 14 for
  the abbreviated one).
- **Every answer has SSP's `\&[name]` entities decoded** before the menu reads it, captions and `*.visible` alike
  (GetStringShiori → SPGhost::DecodeEntity [disasm 0x713033]; HTML 4's 252 names, case-sensitive, an unknown one or a
  `#N` gives a space; `shiori-events.md` §5.5). The menu then reads the caption: a decoded `&` is caption syntax like a
  written one (`\&[amp]\&[amp]` → a literal `&`; `\&[amp]X` marks X), and `\&[laquo]Shells\&[raquo]` shows
  `«Shells»`. Sumika: `EventLoop.resource()` / `resources()` decode (`resourceOf`); `menu.js` sees decoded text.
- **Enable levels** [disasm `GetEnableState`, `ModifyPopupMenuEnableStateSakura`]: level 3 = passive mode, level 2 =
  induction mode or minimized, else 0 (`EventLoop.enableLevel`). Level ≥ 2 greys Recommendations ▸, Portal ▸, Shell
  scaling ▸, Balloon scaling ▸, Change ghost ▸, Shell ▸, Clothes/Dressup ▸, Balloon ▸ (in the abbreviated menu
  Recommendations ▸ and Clothes/Dressup ▸); level 3 also greys Iconify. Information ▸, Language ▸, Utilities ▸, Move
  character window, Close and Quit stay enabled. (SSP's level 1, a temporary ghost, does not exist here.)
- Ghost-provided text (captions, shell / balloon / category / part names, readmes) is never translated: rows carry
  `lang=""`, and a literal `&` in a name is doubled so it never becomes an access key [guess for shell names: SSP's flag
  0x10000000 on those items was not decoded].
- **Submenus nest** (auto-mode dress-up categories, `menuitemex` submenus): each level has its own open/close timer and
  the menu-aim rule (a pointer crossing rows on its way into a deeper list neither opens nor closes one); ArrowRight
  opens a row's submenu at any level, ArrowLeft / Escape close the level the focus is in and go back to its row; a
  pointerdown on any level counts as inside.

**Shell ▸** (scope 0 only) [code `CSakuraWnd::InitShellMenu`]: `シェル(&S)` / `&Shell`, `shellrootbutton.*`. One row per
shell of the running ghost, labelled with its descript `name`, in SSP's name order (case-insensitive, digit runs as
numbers, ties by folder; `core/shells.js`); shells whose descript `menu` contains `hid` are left out. The current shell
is **checked and stays enabled**: picking it reloads the shell with all its events [code: no "already current" test,
unlike Change ghost ▸]. The check is CheckMenuItem's, not a radio item's, but SSP's owner-drawn menu draws it as its
**round dot**: the rows' ids 6500 + i are in the dot range (§2.3) [disasm 0x4978f3, 0x696754]. One shell → its one
checked row. A pick asks
`changeShell(id, {byId, raiseEvent, scope})` of the event loop: OnShellChanging, the swap when its script ends, then
OnShellChanged (EV §2.6); refused (nothing happens) while minimized, in passive / induction mode, in `\t`, or during
another change. After the swap the menu takes the new shell's `menu.*` look (`Menu.setShell`), and asks the SHIORI
for its look again before OnShellChanged (§2.3). Thumbnails on hover:
§2.14.

**Balloon ▸** (scope 0 only) [code `CSakuraWnd::InitBalloonMenu`]: `バルーン(&B)` / `&Balloon`, `balloonrootbutton.*`.
A top group (only when not empty) of the ghost descript's `recommended.balloon.path`, `recommended.balloon`,
`default.balloon.path`, `balloon` resolved against the installed balloons, each once, then a separator, then **every
installed balloon** by descript `name` (case-insensitive, ties by folder) [code `GetDefaultBalloon`]; a top-group
balloon shows twice. Names longer than 25 characters are cut to 25 plus `...` (SSP's default "Max. name length in
ghost/balloon menu" [code]; the whole name is the row's tooltip, Sumika's). The balloon in use is **checked on its first
row only** [infer: Win32 `MF_BYCOMMAND`], drawn as SSP's dot (ids 50000 + i, §2.3) [disasm 0x49a7ee]; every row is
enabled, a re-pick reloads it and still sends OnBalloonChange [code]. A pick asks `changeBalloon(id, {byId, scope})`. SSP's Yes/No warnings when leaving a recommended balloon are
not done [decision: no corpus ghost sets `recommended.balloon`].

**Clothes/Dressup ▸** [disasm `CCharWndCode::UpdateBindMenu`, `CCWC_OnCommand`, `SPBindProp::*`]: `着せ替え(&C)` /
`&Clothes/Dressup`, `dressuprootbutton.*` (unprefixed in both menus). Tsubasa answers "Dress-up(&C)" and `.visible 1`,
so hers reads "Dress-up(C)" in both UI languages. First row **Dressup explorer** (`着せ替えエクスプローラ(&E)` /
`Dressup &explorer`, `dressupexplorerbutton.*`), **greyed** (there is no Explorer) [decision], then a separator, then
the parts of the clicked character's scope (main menu: scope 0), from `Stage.dressupMenu(scope)` (shell-format.md):
- **manual** (every Satori ghost): the `<scope>.menuitemN` / `menuitemexN` lines in descript file order; a separator
  for a non-digit value; `menuitemex` parts in a submenu named by the line; each part labelled **`category - part`**
  (always, even when equal) [disasm].
- **auto** (only YAYA ghosts in the corpus): categories with ≥ 2 parts first, as submenus titled with the category (rows
  = part names; the category row has a tick while any of its parts is worn: its auto id ≥ 62899 is outside the dot
  range, §2.3 [disasm]), a separator, then single-part categories flat
  (`category - part`, just `part` when the two are equal in any case); a scope with one category is all flat [disasm].
  SSP's "category(1)/(2)" column split is replaced by the menu's scroll [decision].
- **hidden**: no part rows.
- Every part is a check row (`menuitemcheckbox`), **checked while worn** [disasm], the check drawn as SSP's dot: the
  parts' ids 13000 + i are in the dot range (§2.3) [disasm `UpdateBindMenu` 0x41ef79].
- The root is greyed when the scope has no bind groups, in hidden mode, or in manual mode without any menuitem line
  (`enabled` false), at enable level ≥ 2, and with `dressuprootbutton.visible` 0. A scope whose only line is
  `menuitem0,-` (Tsubasa's char27/95/96/98/99/100, Katari's sakura and kero) is **enabled** and holds only the greyed
  Explorer [infer from the code path; SSP draws its separators too].
- A pick asks `toggleDressup(scope, id)`: the part toggles **at once, also while a script plays**, with
  OnDressupChanged R4 `user` and the category rules (EV §4.11), after the playing script's binds so far are reported
  (NOTIFY, R4 `script`); a pick that changes no flag (a worn mustselect default unticked comes straight back) still
  sends GET OnNotifyDressupInfo; refused while minimized, passive, induction or `\t` [disasm `IsLocked`], and during a
  shell swap.
- Whose parts (the bind scope): the menu's own character's, except in a menu `popupmenu.type` redirected to another
  character, where the clicked character's `<p>.popupmenu.applybindtoself` decides (ParseBool, default 1: the clicked
  character's parts; 0: the menu owner's); the root stays greyed or enabled by the owner's own bind data, and a pick
  toggles a part of the bind scope (§2.1 Notes) [disasm 2.9.10 `CheckApplyBindToSelf` 0x41cca0, `ModifyMenuWithTable`
  0x41c975..0x41ca01, `UpdateBindMenu` 0x41ede8]. Code: `bindScopeOf`, `Menu._options(scope,
  bindScope)`, `buildMenuModel`'s `dressupScope`.

**Information ▸** (scope 0) [res MENU 102; disasm handlers]: `情報(&A)` / `Inform&ation`, `inforootbutton.*`; stays
enabled at every enable level.

| Row (ja / en) | Resource | Here |
|---|---|---|
| `Sumikaについて(&A)` / `&About Sumika...` (Sumika's, in SSP's `SSPについて(&A)` / `&About SSP...` slot) | `firststaffbutton.*` (a ghost caption still replaces it) | the info window with Sumika's name, version, its developer (Heyuri Applicable Research & Development), one line on what it is, and "SHIORI: Satori (BSD-2-Clause, ukatech/satoriya-shiori)" [decision] |
| `キャラクタについて(&G)` / `About this &ghost...` | `readmebuttoncaption` → `readmebutton.*` (Tsubasa: "About the Current Shell(&R)") | the readme window (below); greyed when neither the ghost, nor the current shell, nor the current balloon has a readme [guess] |
| `キャラクタの利用条件(&T)` / `&Terms of this ghost...` | `termsbutton.*` | greyed unless the ghost's root has `terms.md`, `terms.markdown`, `terms.rtf` or `terms.txt` [disasm `GetTermsPath`]; then the same window titled like DIALOG 175, "Terms of use: {file}" / "利用条件 : {file}" [guess]. None of the site's ghosts has one |
| `説明書(&H)` / `&Help` | `helpbutton.*` | greyed [decision: SSP's help describes SSP; Sumika has no help page] |
| ---- | | |
| `AIグラフ(&I)` / `A&I graph` | `aistatebutton.*` | greyed [decision, P2: Satori answers `getaistate`] |
| `使用頻度表示(&R)` / `Ghost usage statistics (&R)` | `rateofusebutton.*` | greyed [decision, P2] |
| `システム情報を書出(&S)` / `Output &system information` | `systeminfobutton.*` | greyed [decision] |

**The readme window** (SSP's DIALOG 109 [res]; `ui/info.js` `InfoWindow`):
- Title `キャラクタについて` / `About this character`; rows `作者名：` / `Author:` (descript `craftmanw`, else `craftman`)
  and `URL：` / `URL:` (`craftmanurl`, a link opening in a new tab with `noopener`, http(s) only; anything else shows as
  text), `(N/A)` when missing; the readme in a scrolling box (`white-space: pre-wrap`, `lang=""`); an `OK` button and a
  × (Sumika's, `閉じる` / `Close`).
- Sources: the ghost, the current shell and the current balloon, each when it has a readme, with its own author and
  URL; a small switcher (`ゴースト` / `シェル` / `バルーン`, Sumika's) when more than one has one [guess: SSP switches
  "from the bottom left", `左下から切替`].
- Readme lookup in a folder [disasm `SPProp::GetReadmePath`]: the descript's `readme` key (a path from the folder; for
  a ghost from its root, as Hayato's `readme,readme.txt`), then `readme.md`, `read me.md`, `readme.markdown`,
  `ghost/master/readme.md` (ghost only), `readme.rtf`, `read me.rtf`, `readme.txt`, `readme.1st`, `read me.txt`,
  `readme`, `お読みください.txt`, `はじめにお読みください.txt`, `ghost/master/readme.txt` (ghost only). Shells and
  balloons use the same list in their folder [guess].
- Text: descript `readme.charset` (UTF-8 or Shift_JIS) when it names one, else `decodeText` (BOM, a `charset,` line,
  else CP932) [infer for the charset]. RTF is shown as plain text (font/colour tables and `\*` destinations dropped,
  `\par` → newline, `\'hh` decoded as CP932, `\uN` as Unicode) and Markdown as text [decision]. Readmes are not in the
  text pack (`index_site.py` `PACK_SKIP`), so each is fetched when the window first shows it; a failed fetch shows an
  empty box (logged).
- Esc, OK and × close it and the focus goes back where it was; Tab stays inside; one window at a time (another
  Information pick replaces what it shows); Shadow DOM, `Z_BASE + 200`; at most 560 px wide with a 16 px margin on a
  phone, and at most 640 px tall with a 16 px margin in the visible height (`100dvh`: a phone's browser bars shown or
  not, §9.11 F3); its labels follow a language change while it is open. About Sumika and the terms use the same
  window (no author rows).

**Other items**:
- SSP's **Network update** `ネットワーク更新(&N)` / `&Network update` and **Uninstall** `アンインストール(&U)` /
  `&Uninstall` are left out: a visitor's browser updates and installs nothing [decision; §2.1 #3, #4].
- **Quit** `全て終了(&X)` / `Quit (&X)`, `quitbutton.*`, both menus: the same as Close (OnCloseAll → OnClose on 204)
  while one ghost runs [disasm: SSP's Close with no other ghost is Quit]; with several, every ghost (§2.12). The menu
  asks the event loop's `quitAll(scope)`; a loop without it gets `close(scope)`.
- **Move character window** `ゴースト本体移動` / `Move character window` (message.txt `resource.setting.balloon.command`
  item 6, no access key), `charmovebutton.*`, both menus [disasm `InitWndMenu`, `DragStartNoMouseDown`]: the clicked
  character is picked up (`Stage.carry(scope)`): its centre follows the pointer until the next click, which is
  swallowed; Esc puts it back; on touch the next tap places it [decision]. The position is saved like a drag. No mouse
  events go to the ghost, and no key events either (`stage.carrying`): no OnKeyPress for any key and no
  `preventDefault`, so keys other than Escape stay the page's; Escape cancels the carry and does not reach the ghost,
  which stays keyboard-active afterwards so her shortcut keys keep working (EV §4.6) [guess].
- **Reset passive mode** `制限モード強制解除(&P)` / `Reset &passive mode`, `leavepassivebutton.*` (asked only then):
  SSP shows it in Utilities ▸ only with "Enable functions for developers" [disasm]; Sumika's only with `?sumika-debug`
  in the page URL [decision]. It leaves passive and induction mode (`setOption('leave', …)`); SSP also clears `\t`,
  which Sumika's does not.
- Close and Quit in passive mode: SSP first asks `info.threadbusy` (Yes/No) [disasm]: not done [decision].

**Not yet compared with ssp.exe on screen** (each is tagged above):
1. Tsubasa → Shell ▸: `master` with the round dot (not a tick, §2.3 [disasm]), clickable?
2. Balloon ▸ for Tsubasa: the round dot (§2.3 [disasm]); order; no top group; is the current one clickable?
3. Main menu: "Move character window / ゴースト本体移動" between Iconify and Close with a separator on each side (also in a
   sub-character's menu)?
4. An item whose `.visible` is 0 (SSP's Uninstall with Tsubasa's 消滅指示表示 option off): greyed or gone?
5. A ghost without recommended sites: Recommendations ▸ greyed or missing?
6. Clothes/Dressup ▸: "着せ替えエクスプローラ / ----, 髪 - ポニーテール (dot) …" labels and order; a sub-character's
   Clothes/Dressup ▸ for a scope with only `menuitem0,-`: enabled with just the Explorer?
7. Information ▸: the readme window (title, Author/URL, can it switch to the shell's and balloon's readme?); Terms
   greyed; what Help opens.
8. Passive mode: which items are greyed (expected: Change ghost, both scalings, Recommendations, Portal, Shell,
   Dress-up, Balloon, Iconify)?
9. Balloon names longer than 25 characters cut with "...".
10. A ghost answering both `sakura.recommendbuttoncaption` and `recommendrootbutton.caption`: which caption shows?

### 2.12 Several ghosts on screen: Call ghost ▸, Close one, Quit all — P1

A page shows several ghosts at once, as SSP does when one ghost calls another (Call ghost ▸,
`\![call,ghost]`). The events and their References are in EV §2.7, the tabs in §9.5, the layers and z-order in §3.5 and
§9.1, keys in §9.7, the launcher dock in §2.6. This section covers the menus. Nothing here was compared with ssp.exe
on screen.

**Each ghost has its own menu**, opened by a right-click on its own character: Change ghost ▸, Call ghost ▸, Shell ▸,
Balloon ▸, Clothes/Dressup ▸, Iconify and Close act on that ghost, Quit on every ghost. Opening one ghost's menu
closes the other's (a menu closes on any pointerdown outside itself) [code], and brings that ghost above the others
(§3.5) [infer].

**Call ghost ▸** [res MENU 102 position 15; disasm `CSakuraWnd::InitGhostMenu` 0x49A2B0]:
- Caption `Call ghost (&Z)` / `他のゴーストを呼ぶ（&Z)`, SSP's own (the Japanese one with a full-width `（`, §2.10);
  `callghostrootbutton.caption` / `.visible`, asked right after `ghostrootbutton.*`.
- Right after Change ghost ▸, in the main menu only (not in MENU 128, §2.2).
- Shown only while the site lets more than one ghost stand: `maxGhosts` above 1 (the script attribute
  `data-max-ghosts`; no cap by default, as in SSP [decision]). With one ghost at a time there is no Call ghost ▸ (the `Menu`'s
  `calls` provider is absent or answers null).
- Rows: every ghost of the site, with the same list, order and labels as Change ghost ▸ (SSP fills both in one loop):

  | Row | Change ghost ▸ | Call ghost ▸ |
  |---|---|---|
  | the menu's own ghost | checked and **enabled**: a pick reloads it (EV §2.5) [disasm 2.9.10 0x49b9b7; decision] | checked, greyed [disasm] |
  | on screen in another slot (`elsewhere`) | greyed, no check [disasm] | greyed, no check [disasm] |

  The check is SSP's round dot in both (ids 35000 + i and 20000 + i, §2.3) [disasm].
  | engine missing | greyed, "(needs AYA)" | greyed, "(needs AYA)" [decision, as Change ghost ▸] |
  | a site cap is reached (`data-max-ghosts`) | enabled | greyed, "(up to {n} at once)" / "(同時に{n}体まで)" (Sumika's; SSP has no cap) |
  | otherwise | enabled | enabled |

- Only `callghostrootbutton.visible` 0 greys it. The enable level (passive, induction, minimized) does not, unlike
  Change ghost ▸: position 15 is not in `ModifyPopupMenuEnableStateSakura`'s list [disasm, tentative]. A pick does
  nothing while the ghost is not booted, closing, changing, frozen, or inside `\t` [guess: SSP's call path showed no
  lock test].
- A pick asks the event loop's `callGhost(id, {byId: true, raiseEvent: true, reason: 'manual', scope})`. The ghost
  gets OnGhostCalling (R1 `manual`) and plays its reply, and the callee boots beside it (EV §2.7), at the callee's own
  stored or default place (§3.5).
- Not done: History ▸'s Call ghost list. Hover thumbnails: §2.14.

**Close and Quit** [disasm `OnMenuClose` 0x495140, `CloseGhostProc` 0x4951F0 (2.9.08f; in 2.9.10 0x496680 and
0x496730), `GhostExitProc` 0x465650; doc SSPHELP
howto-rclick: with several ghosts Close closes only the ghost whose menu it is, and closing the last one ends SSP]:
- **Close** (both menus) while another ghost is on screen: that ghost alone. It gets GET OnClose (R0 `user`, R1 the
  menu's scope, R2 the window's), with no OnCloseAll first; 204 closes it at once. It goes at `\-`, so a goodbye
  without `\-` leaves it standing (SUM C22). Then every other ghost gets OnOtherGhostClosed. **Close of the last
  ghost** is Quit.
- **Quit** (both menus): every ghost, in parallel. Each gets OnCloseAll (R1 the scope of the menu used, R2 the clicked
  character's: the same unless `popupmenu.type` redirected the menu, §2.1 Notes [disasm 2.9.10 0x41d4ca]; the same
  numbers for all; 204 → OnClose) and closes at the end of its own close script, `\-` or not
  [disasm `PlayScriptWithMsg(…, 0x3A)`]. Nobody gets OnOtherGhostClosed. Then the one closed launcher calls the whole
  set back (§2.6).
- Both do nothing while a call or a ghost change is under way (SSP beeps "while any ghost is loading") [disasm
  `OnMenuClose`, `OnMenuExit`]. Quit also does nothing while a ghost still boots (the set's start, a takeover, one
  ghost's start), since that ghost would never close [decision]. A Quit during one ghost's Close turns that Close into
  Quit's, with no new event [decision].
- During Quit's goodbyes no menu pick or page call adds, changes or relaunches a ghost, and another tab's takeover
  waits for the end. The closed button appears once the last ghost has finished its own unload; a page left meanwhile
  goes on with the Quit on the tab's next page (EV §2.7.3).

**In the code** (`src/ui/menu.js`): `callItems(rows, lang)`; `ghostItems` greys `elsewhere` rows; `buildMenuModel(…,
{calls})`; `new Menu({calls: () => rows | null})`; `_run` `callghost` → `host.callGhost(…)`, `quit` → `host.quitAll(scope)`
(a loop without it: `close(scope)`). The rows come from the site (`Site.callList(rt)`, `Site.ghostList(rt)`). The cap
note's n is the row's `full` when that is a number, else the number of rows on screen (current + elsewhere), which is
the cap whenever the set is full.

**Not yet compared with ssp.exe on screen**:
1. Call ghost ▸ with two ghosts running: is the menu's own ghost checked (the dot) and greyed, and the other running
   ghost greyed without a check? With the ghost in passive mode: is Call ghost ▸ still clickable, and does the call
   happen? [disasm, tentative]
2. Change ghost ▸: the running ghost checked (the dot) and **clickable**; does picking it reload the ghost? [disasm]
3. Close on one of two: does only it go, and does the other comment? Its OnClose without `\-` (Script Input box): does
   it stay? [disasm]
4. Quit: do both say goodbye at once, and both come back at the next SSP start? A Quit whose OnClose has no `\-`: does
   the ghost still go? A click on a ghost during Quit's goodbye: does its reply play, and does it still close? [disasm;
   guess]
5. Quit while one ghost is iconified: does it say goodbye? [guess]
6. Iconify one of two: does only it go, with its own tray icon? [disasm]

### 2.13 Options ▸ Preferences… and the Preferences box — P1

Read from ssp.exe 2.9.9.3000 and its `ssp.map`. The box asks the visitor's name
for ghosts such as emily4, whose first boot ends with `\![open,configurationdialog,setup]` [corpus aya_bootend.dic:15].
`OnNotifyUserInfo` (sent by the Site and the event loop) is in EV §4.16, `%username` in SS §5.12, the tag in SS §5.9.

**What SSP does**:
- **The dialog.** DIALOG 124 "SSP: Preferences" / "SSP:設定": a page list, the page, the note "Unless otherwise noted,
  changes will take effect immediately" / "一部の設定を除き、変更はすぐに反映されます。", buttons "&Close" / "閉じる(&C)"
  and "&Help" / "ヘルプ(&H)" [res `sspui/dialogs_{en,ja}.txt`]. One dialog for the whole SSP process and every ghost,
  **modeless**: the script that opened it goes on; a second open only switches the page and activates it [disasm
  `CMainFrame::ShowPropertyWindow` 0x46cae0, `CDialog::CreateIndirect` 0x42f56d]. OK and Cancel both only close
  [disasm 0x4a6840, 0x4b91a0].
- **Who opens it.** Only three callers: Options ▸ Preferences… (`本体設定...(&P)` / `&Preferences...`, id 5071,
  `CSakuraWnd::OnMenuSetup` 0x498d30, no page), the tag, and a button on the `ghost2` page [disasm]. SSP has no
  first-run name question of its own: that is the ghost's script.
- **The tag** `\![open,con…(,PAGE)]`: the sub-command matches any word of 3 letters or more that starts with `con`, any
  case (`configurationdialog`, `config`, `CON`); `\![open,co]` is another command [disasm 0x62d830, table 0xbbd448].
  PAGE is compared exactly, any case, with SSP's 16 page types (`setup` = General, `ghost`, `ghost2`, `folder`,
  `display`, `talk`, `saveshare`, `dictation`, `network`, `network2`, `biff`, `application`, `messenger` /
  `ipmessenger`, `international`, `streamingtool`, `developer`); none or an unknown one shows the page shown last
  (General the first time) [disasm `GetPageFromType` 0x4a6fa0]. Refused for SSTP and other untrusted scripts [disasm
  0x63072f].
- **The General page** (DIALOG 105 "General: Miscellaneous settings" / "一般 : SSP全体の設定"): its "User information" /
  "ユーザ情報" group holds Name: / 名前 :, Nickname: / 呼ばれ方 :, Birthday: / 誕生日 : (a date picker) and Sex: / 性別 :
  with Male / 男, Female / 女, Undefined / 未設定 [res]. One set for the whole install, in `data\profile\app.dat`
  (`UserName`, `UserCallName`, `UserBirthday` as `yyyy.mm.dd`, `UserSex` `male` / `female` / `undef`) [disasm
  0x72a051]. The rest of the page and the other 15 pages are SSP's own settings.
- **Edits** are stored at once, at every keystroke [disasm `OnChangeFirstname` 0x4a5160, `OnChangeCallname` 0x4a5240,
  `OnChangeBirthday` 0x4a5320, `OnSexChoice` 0x4a53c0]. When the General page closes (a page switch or the dialog's
  close) after any of the four fields was touched (even changed back), SSP sends `NOTIFY OnNotifyUserInfo` to every
  running ghost; nothing else is sent [disasm `CSetupDefDlg::OnDestroy` 0x4a4d30, `OnSSPSysMsg` 0x46b478]. It also
  sends it at every SHIORI load, before `otherghostname` [disasm 0x621b66]. References: R0 nickname, R1 name, R2
  birthday `yyyy,mm,dd` zero-padded (`""` if never set), R3 sex [disasm `SPShiori::NotifyUserInfo` 0x70f440].
- **Defaults**: the name is Windows' registered owner, else the login name; the nickname a copy of it; sex `undef`
  [disasm 0x736a40]. So in SSP R0 is practically never empty.
- `?` help on a field sends `GET OnConfigurationDialogHelp` to every ghost [disasm 0x4a8ac0] (only emily4 answers it).

**What Sumika does** (`src/ui/settings.js` `SettingsWindow`, `src/core/user.js` `UserProfile`, `src/ui/menu.js`):
- **The box**: one per page, owned by the Site (as SSP's one dialog), modeless; a second open brings it to the front and
  focuses it, never a second box. Title "Preferences" / "設定" (SSP's without "SSP:"); one page heading "General" /
  "一般" (DIALOG 105's title up to its colon); the "User information" group with the four fields in SSP's order and
  words; SSP's note; one "Close" / "閉じる" button (no access key: the browser owns Alt keys, as `info.ok`) and a ×.
  No page list (one page), no Help, no `?` help, so no OnConfigurationDialogHelp [decision].
- **Fields**: Name and Nickname are text fields; Birthday an `<input type="date">` that may stay or become empty (the
  visitor can take it back; SSP's picker cannot be emptied once set [guess]); Sex three radios, Undefined while nothing
  is stored. `autocomplete="off"`: what the visitor types, never the browser's saved profile [decision]. The focus
  starts in Name, except while the visitor types in a field of the page itself (an input, textarea, select or
  contenteditable, not the runtime's own): then the box opens, or a second open brings it to the front, without the
  focus and pulses, as the input boxes do (§6.4 "never steal focus"), so the keys meant for the page never land in
  Name, are stored and reach the ghosts at Close [infer: Windows' foreground lock keeps SSP's
  dialog from taking the keyboard from the app the user types in].
- **Edits** are stored at every `input` / `change`, as SSP's. The box remembers that a field was touched since it
  opened (changed back counts, as SSP's flag). **Close**, × and Esc (not while an IME composes) close it and hand its
  owner `{touched}`: touched, the Site sends `NOTIFY OnNotifyUserInfo` to every ghost on the page that is booted and
  not closed or frozen; untouched, nothing. Leaving the page with the box open sends nothing; the next page's boot
  tells every ghost.
- **Look**: the Information window's frame (§2.11): centred, Shadow DOM, `Z_BASE + 200`, `role="dialog"`, Tab kept
  inside (×, Name, Nickname, Birthday, the checked radio, Close), the focus back where it was on close; labels left,
  fields right; at most 420 px wide and `100vw − 32px` on a phone, scrolling inside. Its words follow Language ▸ while
  it is open (§2.10); the fields follow another tab's edits. On a phone it stays above the on-screen keyboard and its
  fields are 16 px (§9.11).
- **Options ▸** in the main menu, right after Utilities ▸ and before the separator, as in MENU 102: `設定(&O)` /
  `&Options` ▸ `本体設定...(&P)` / `&Preferences...` [res `menu_{ja,en}.txt`]. Resources `configurationrootbutton.*`
  (the submenu) and `configurationbutton.*` (the item) [infer: which is which]; asked after Utilities ▸'s ids, root
  first, each visible before its caption [res: an SSP request log, `scratch/ayame.log`]; a caption replaces Sumika's, a
  visible 0 greys it. Not greyed by the enable levels (not in `GetEnableState`'s list, §2.11) [infer]. Not in the
  abbreviated menu. A tab that shows the set frozen has no menu, so the box opens only where the ghosts run.
- **The tag**: `\![open,con…]` with no page, `setup` (any case) or an unknown word opens the box (Sumika's last page
  is always General); SSP's other 15 page types open nothing and are logged once (SS §5.9).
- **Storage** (`UserProfile`): one site-wide profile in the runtime prefs, localStorage `sumika:runtime` key `user` =
  `{name?, nickname?, birthday?: 'YYYY-MM-DD' | '', sex?: 'male' | 'female' | 'undef'}`; an absent key was never set;
  other tabs follow through the `storage` event. Never logged, never in a URL, never sent anywhere by the runtime but
  to the ghosts' own engines; ghosts may copy it into their saves, which stay in the browser too [decision].
- **What the ghosts get** (`UserProfile.refs()`): R0 the nickname, else the name (an empty field counts as not given),
  else `""`; R1 the name or `""`; R2 `YYYY,MM,DD` zero-padded as ssp.exe or `""`; R3 the sex or `undef`. In the boot
  batch only once the visitor has saved the box (any field stored) [decision]. `%username` after the ghost's own
  `username`: the nickname, else the name (`UserProfile.nickname()`), else the word `user`.

**[decision]s**:
1. **No name entered yet**: SSP sends the Windows user name, a browser has none. Sumika sends no OnNotifyUserInfo until
   the visitor saves the box once, and `%username` falls back to `user`. (The alternative, a fixed default
   word, would give emily4 a name at once, but etherism would store that word instead of its own `ユーザ`.)
2. **Pages Sumika has no box for** (`biff` from Katari and Nato, `ghost`, `talk`, `display`, `application` …) open
   nothing (logged once); only no page, `setup` or an unknown word open the box.
3. **Options ▸ Preferences…** is in the main menu, after Utilities ▸, and the box is titled "Preferences" / "設定", not
   SSP's "SSP: Preferences" / "SSP:設定".
4. **All four fields** (name, nickname, birthday, sex), as SSP's, stored only in the visitor's browser.

**Not yet compared with ssp.exe on screen**:
1. emily4's first boot: does SSP's settings dialog open on General at the end of her greeting? After a nickname is
   typed and the dialog closed, does she say anything, and what does a later line call the user?
2. Options ▸ Preferences… from the menu: which page shows (the last one, General the first time)?

### 2.14 The menu's thumbnail window — P1

In ssp.exe a ghost's `thumbnail.png` shows at the bottom-left of the screen while its row in Change ghost ▸ is
selected, at the bottom-right when the ghost stands at the bottom-left [observed]. Read from ssp.exe
2.9.10.3000 and its `ssp.map` [disasm]; SSPHELP's display page calls it "show a preview image (thumbnail.png) while an
item of Change ghost, Call ghost, Shell, Balloon … is selected, where supported" [doc `config-disp.txt`].

**What SSP does**:
- **When** [disasm `CCharWndCode::OnCWMenuSelect` 0x41b740, `OnCWTimer` 0x41b8b0]: on every WM_MENUSELECT (the
  selected item changed: the pointer or the keys moved, the menu closed) with the setting on (`thumbnails.show`, on by
  default) the pending timer is killed. An item that is greyed, disabled, a submenu's own row, a separator, or the
  menu's close (flags `0x2813` or `0xFFFF`) clears: if a thumbnail item was selected since the last clear, both its
  ids are reset and the window hides at once. An item in a thumbnail range (shells 6500–6998, ghosts 35000–49999 for
  Change ghost ▸ and 20000–34999 for Call ghost ▸, balloons 50000–59999, plugins, headlines, recommend and portal
  banners, dress-up parts) starts a **350 ms** timer; any other item clears. When the timer fires on an id other than
  the one processed last, `ProcessThumbnail` looks the thumbnail up and shows it, or hides the window when there is
  none [disasm 0x41c250]. Moving from one ghost row to another keeps the shown one until the new row's timer. Ghost,
  shell and balloon rows count only in the main (scope 0) menu.
- **Which file** [disasm `SPGhostProp::GetThumbnail` 0x6c4fa0, `SPProp::GetThumbnailReal` 0x6c2ff0]: `thumbnail*.*` in
  the ghost's folder (any case); none there, the same in `ghost/master/`. A match counts when its extension (after the
  last `.`, each UTF-16 unit's low byte, lower-cased) is in JLibGra's image table (png, pnr, apng, webp, gif, the jpeg
  names, bmp, ico, tga, psd … 51 names; `tif` / `mdi` as a prefix), not `exe` / `dll` [disasm table 0xb87910]. Several
  matches: **one at random each time** (genrand). A folder found without one is not searched again.
- **The image** [disasm `SPSurface::CreateSurfaceForThumbnail` 0x757630]: its own alpha; a `.pna` beside it applies;
  a file whose name ends in `r` (`.pnr`) that is fully opaque gets the top-left pixel's colour transparent (every other
  pixel opaque). A file it cannot read hides the window.
- **Where** [disasm `CThumbnailWnd::CreateMe` 0x4b13f0] in the work area of the pointer's monitor, in device px: above
  96 dpi the image grows by dpi/96; one wider or taller than **half the work area** shrinks by the smaller ratio,
  keeping its shape; y = bottom − h − **10**; x = left + 10, or right − w − 10 **when the pointer is left of the work
  area's middle**. So it is the pointer, not the ghost, that decides: a menu opened on a ghost at the bottom-left has
  its pointer in the left half, and the thumbnail goes right. A layered, topmost, click-through tool window
  (`SSPThumbnailWindow`, one for the process); it stays until a clear, with no time limit (the 5-second limit and the
  pointer-following placement belong to another use of the same window, `tracking` [disasm `UpdateTrackPos`]).

**What Sumika does** (`src/ui/thumbnail.js` `MenuThumbnail`, `placeThumbnail`, `thumbnailAlpha`; `src/ui/menu.js`
`Menu._syncThumb`; `tools/index_site.py` `ghost_thumbnails`):
- Change ghost ▸ and Call ghost ▸ rows (`ghostItems` / `callItems` carry the ghost's thumbnail URLs as `thumbs`).
- **The selection**: the hot row of the deepest open menu that has one stands for WM_MENUSELECT's item (a pointer that
  left a submenu leaves its parent row selected [win32: Wine `MENU_SelectItem`]); each change is reported to the
  page's one `MenuThumbnail`. An enabled ghost row starts the 350 ms timer, anything else clears, as above; closing
  the menu clears.
- **The files**: `ghosts.json` lists each ghost's candidates as `thumbnails` (site paths, in NTFS name order; empty
  when it has none), found as SSP finds them; the window picks one at random each time it shows one. The same list
  answers `%property[…thumbnail]` (one at random, as SSP's `GetThumbnail`, properties.md §5.4). The launcher no
  longer uses it: it shows the ghost's tray icon (§2.6).
- **The image**: fetched, its first frame decoded (`createImageBitmap`, no colour management; an animated one does not
  play, as SSP draws one surface), `thumbnailAlpha` for a `.pnr`, drawn on a canvas. A format the browser cannot decode
  hides the window, as SSP's unreadable file. `.pna` files are not read: no thumbnail in the test ghost archive has
  one [decision].
- **Where**: the viewport is the work area, devicePixelRatio × 96 the dpi, both in device px, then back to CSS px;
  pointer-events none; `Z_BASE + 201`, above the menus.
- Checked in a browser (Tsubasa at the bottom-left of a 1280×720 page at 125 %): Katari's 170×92
  thumbnail at the bottom-right, 10 device px in, 212×115 device px; BTHver.5's `.pnr` logo with its green keyed out;
  a greyed row and closing the menu hide it; a menu opened in the right half puts it bottom-left.

**The other menus** (the same window, timer and placement, `thumbKey` in
`menu.js` standing for SSP's command id ranges):
- **Shell ▸** (6500 + i) and **Balloon ▸** (50000 + i): `SPProp::GetThumbnail`, the plain lookup, `thumbnail*.*` in
  the item's own folder, no `ghost/master/` fallback [disasm: slot 0x18 of `SPShellProp` and `SPBalloonProp` is
  `SPProp::GetThumbnail` 0x6c2fb0]. `ghosts.json` lists them as `thumbnails` on each `shells` entry, each
  `bundledBalloons` entry and each `balloons` entry. A balloon listed twice (the ghost's own on top) has one id, so
  moving between its two rows keeps the thumbnail without loading it again.
- **Clothes/Dressup ▸** parts (13000 + i, in every scope's menu): the bind group's third field, looked up in the
  **current shell's folder** with SSP's any-extension search [disasm `SPBindEntry::GetThumbnail` 0x5dca50,
  `SPUtils::RemoveExtensionFromFileName` 0x7892b0, `SPSurface::FindLoadableExtension` 0x756b50]: the written extension
  goes, then the first file of `<name>.*` in name order whose extension is an image's (fm_ukagaka and raychel_rest_cos
  write `thumbnail/surface500` with no extension). A category's own submenu row has none. Found in the page from the
  ghost's file list when the row's timer fires (`thumbnail.js findLoadable`).
- **Recommendations ▸** (9000 + i, every scope) and **Portal site ▸** (11000 + i): the row's banner (its list's third
  field) [disasm `SPRecommendProp::GetThumbnail` 0x61a970]: of an http, https or file URL the part after its last `/`,
  else the whole value, looked up the same way in `ghost/master/banner/` (the ghost's master folder [disasm
  `SPGhost::LoadGhost` 0x61fbbf]; firefox.nar writes `getfirefox` for `ghost/master/banner/getfirefox.png`); not there,
  an http(s) URL is loaded from the web, as ssp.exe downloads it when its network setting allows [disasm
  `CHelperMainWnd::OnSSPSysMsg` 0x459859]; a `file://` URL or a name not found shows nothing. A row without a URL is
  greyed, so it shows none either. In the test ghost archive brynhild, crawler_uploader, firefox and ria ship banners;
  none of the site's ghosts does.
- A banner on another site is shown from an `<img>` with no referrer and no colour key: a page cannot read another
  site's pixels without its consent [decision; ssp.exe downloads it too].
- Change ghost ▸'s own row is enabled (EV §2.5), so it shows the ghost's own thumbnail too.
- Checked in a browser: Balloon ▸ on Tsubasa's menu shows etherism's `天使の梯子` (`.pnr`, keyed out)
  at the bottom-right; Change ghost ▸'s Tsubasa row shows hers. Shell ▸ (emily4 and like_a_cat have one), dress-up
  parts and banners (no site ghost has them) are covered by the Node tests only.

**Not done**: SSP's headline and plugin menus (no such menus here); no setting to turn it off (`thumbnails.show`), as
SSP's default is on.

**Not yet compared with ssp.exe on screen**: a ghost with two thumbnails (clear_sky_girl in the test archive: `thumbnail.png`
and `thumbnail2.png`): does the picture change between visits to its row?

---

## 3. Character placement, dragging, z-order, extra scopes

### 3.1 Alignment ("alignmenttodesktop") — P0

Values: `bottom` (stuck to the bottom of the work area: only horizontal dragging), `top` (stuck to the top: only horizontal),
`left`/`right` (stuck to that edge: only vertical) (SakuraScript tag only), `free` (no snapping), `default` (tag only: back to the descript value)
[doc UKADOC:ss, UKADOC:shell].

Priority, lowest to highest [doc UKADOC:shell]: ghost descript `seriko.alignmenttodesktop` (**default `bottom`** [doc UKADOC:ghost]) <
ghost `sakura.|kero.|char<n>.seriko.alignmenttodesktop` < shell `seriko.alignmenttodesktop` <
shell `sakura.|kero.|char<n>.seriko.alignmenttodesktop`. A runtime tag `\![set,alignmenttodesktop,dir]` overrides all of
them for the current scope **until the ghost exits**. `\![set,alignmentondesktop,…]` (spelled with "on") and
`alignment_on_desktop` are **accepted aliases** [doc UKADOC:ss: "上記はalignmentondesktopと書いても有効"]. Tsubasa
always writes `\![set,alignmentondesktop,free]` (443 occurrences in 114 responses [corpus]). Her shell sets
`char99.seriko.alignmenttodesktop,free`.

User override (SSP "Ghost (2)" settings): *Always free* / *Ghost's setting* (default [infer]) / *Stick to taskbar* [res dialog 145].

```
alignment(scope) =
  runtimeOverride[scope]                      // from \![set,alignmenttodesktop|alignmentondesktop,…], persisted (§9.5)
  ?? shellDescript[`${name(scope)}.seriko.alignmenttodesktop`]
  ?? shellDescript['seriko.alignmenttodesktop']
  ?? ghostDescript[`${name(scope)}.seriko.alignmenttodesktop`]
  ?? ghostDescript['seriko.alignmenttodesktop']
  ?? 'bottom'
name(0)='sakura', name(1)='kero', name(n)=`char${n}`
apply: bottom → top = desk.h - surfaceH;  top → top = 0;  left → left = 0;  right → left = desk.w - surfaceW
```
Re-apply snapping on: surface change (height changes), viewport resize, alignment change.

### 3.2 Base point and default position — P0

- **Base point** of a character window = `(defaultx, defaulty)` inside the image. Defaults: **horizontal center, bottom edge**.
  Sources, highest first: shell `sakura.defaultx` → ghost `sakura.defaultx` → default [doc UKADOC:shell/ghost]. When the surface changes
  size, keep the base point fixed on screen, so a wider or taller surface grows around it [infer from the purpose of "画像ベース座標"; Ikagaka hit the
  opposite bug: anchoring at `right` made characters jump when the width changed (NamedManager.js #17)].
- `sakura.defaultleft` / `defaulttop` (and `kero.`, `char<n>.`): initial screen X/Y, **from shell or ghost descript or SHIORI resource**
  [doc UKADOC:shell, UKADOC:res]: the window's left / top, for **any** alignment (docking then applies) [disasm
  `GetDefaultWndPosImpl` 0x41D830: SHIORI `<name>.defaultx` (the base point's screen X), `defaultleft`, then the
  descript's `defaultleft` via `SPSeriko::GetDefaultLeftSetting`; the same for Y]. Tsubasa's shell sets
  `char{5,17,19,20,22,23,26,27,95,96,97,98,99,100}.defaultleft,300`.
- **Default place** (where a character stands when nothing is stored for it: a ghost's first boot, Reset shell position,
  a `\p[n]` window shown for the first time) [disasm `CCharWndCode::GetDefaultWndPosX/Y` 0x41DA50/0x41DBD0,
  `…FromCharIndex` 0x41DB30/0x41DCE0]:

```
// W = the primary monitor's work area (the taskbar excluded); w, h, base = this scope's window size and base point
left(n) = defaultleft(n), else
  n == 0: W.right - w                                   // right edge on the work area's right edge
  n >= 1: the nearest lower scope j (n-1 down to 0) that has a window:
            (defaultleft(j) ?? j's window left now) - w // flush against it: no room for balloons
          none: (W.left + W.right) / 2
top(n) = defaulttop(n), else
  n == 0: W.bottom - Desktop.Offset - base.y            // base point on the work area's bottom
  n >= 1: (j's defaulttop + j's base.y ?? j's base point Y now) - base.y   // base points level
          none: W.bottom - Desktop.Offset - h
then ClampToWorkRect (0x41E540; seriko.automove, on by default): a window that overlaps no work area comes back,
  one that overlaps it by any amount stays. Rectangles are half-open (JRect::IsIntersect 0x576650), so a window
  touching an edge from outside misses it too.
    x = W.left       if the window lies wholly left of W (right < W.left), else W.right - w
                     (also when it touches W.left from outside, or misses only above or below)
    y = W.top        if it lies wholly above W, else W.bottom - h            [infer, see below]
then docking (§3.1): UpdateWndSize clamps (0x41E778) before resolveSnapAxis applies the alignment
```
  `\1` stands by scope index against `\0`, `\p[n]` against `\p[n-1]` or the nearest lower scope with a window (not
  "the previous character to appear"), where that one stands **now**, unless it has a `defaultleft`. A scope is placed
  once by its own SERIKO thread after its first base frame [disasm `SPSerikoAnimation::LoopReal` 0x6F96DC]; a
  `\![move]` before that wins. The ninix-kagari layout (`surface.rb#reset_position`: `\1` left of `\0`'s balloon with a
  gap so both balloons fit) is **not** what ssp.exe does.
  - Which axes ClampToWorkRect moves comes from `JRect::GetIntersectRelation` 0x5768A0: when nothing intersects,
    `IsIntersectAny` leaves the index at −1, and `GetOutDirection(−1)` 0x576970 compares the window with the 16
    bytes before the work-rect array, which hold the call's own return address, array pointer, monitor count and index
    pointer [disasm 0x41E59C–0x41E5D4, 0x6A0ABD]. Its width test therefore always fails, so x always moves (relation 1
    or 3) [infer]. Its height test compares the window's height with the difference of two of those values, 112 + 16 ×
    the number of monitors (128 px with one): by that reading only a taller window moves in y as well (relation 3), and
    a shorter one keeps its y, even below or above the screen [infer]. Sumika moves y for every window (relation 3)
    [decision], so no window that misses the desk vertically stays off it.
  - Worked example (1920×1040 work area, bottom-centre base points): Tsubasa alone `\0` x 1700–1920; emily4 never met
    Emily `\0` x 1667–1920, y 655–1040, Teddy `\1` x 1412–1667, y 879–1040 [disasm; infer for the numbers].
  - **Sumika** (`layout.js` `defaultPlace`, `bringBack`; `Stage._defaultAnchor`, `_standing`): the same rule on the
    desk (the viewport, `Desktop.Offset` 0); the descripts' `defaultleft` / `defaulttop` (shell, then ghost), never a
    SHIORI resource (none of the site's ghosts answers one [ghost: grep]; asking needs the engine before the stage is
    placed). A lower scope's window "now" is its docked place without animation offsets; one never placed (a `\p[n]`
    not shown yet) counts at its own default place. One hidden by `\s[-1]` is still a window [disasm
    `GetExtentCharVirtual` 0x6E9DB0 succeeds for any scope that has an animation], with the size it was last shown with:
    at its place, else its stored ratio, else its default place. That size survives a page change (the stage state's
    `last`), and a viewport resize moves a hidden one too (from its ratio), so it never comes back where an older desk
    had it. One whose size is still loading holds the scope back until it arrives (SSP's threads usually place `\0`
    first [infer]); one never sized is skipped.
- "Reset shell position" (menu, `\![execute,resetwindowpos]`, or no answer to `OnResetWindowPos`) puts every scope at
  its default place, lowest scope first, each against the new place of the one below it [doc UKADOC:ev; disasm
  `CSakuraWnd::OnMenuResetpos` 0x49B540, `UpdateAllWndPos(0x23)` 0x497260]. A window hidden by `\s[-1]` moves too, with
  the size it was last shown with: `UpdateAllWndPos` calls `UpdateWndSize` for every window of the ghost and checks no
  visibility, so the scopes above it stand against its new place [disasm]. It forgets the stored places
  `Char<u>.center/centery/ratio.*` for u from 0 up to the highest `\p[n]` window made this session (u < that window
  array's length + 2, 0x49B57F–0x49B694; `CreateCharacter` 0x49C3AF grows the array to n − 1; a boot makes no `\p[n]`
  window: `CreateGhostWindows` 0x49C0B8 makes them only up to `SPSeriko::GetCharNum`, 2 at that point [infer]). A
  `\p[n]` above that keeps its stored place and stands there when its window is made. Sumika: `Stage.resetPositions`
  (forgets the places up to the highest scope that has a view; a scope still loading, or hidden and never sized, gets
  its default place once its size is known).

### 3.3 Saved positions — P0

SSP stores, per ghost, `Char<n>.ratio.x`, `Char<n>.ratio.y`, `Char<n>.ratio.devid` (monitor id) [res SSP-PROF]. Example from an SSP
install: every bottom-docked character has `ratio.y = 0.944444444`, which is the work-area bottom divided by the screen height. So the
ratio is taken at the **base point** (bottom), not at the window top [infer]. Emily4's floating `Char4.ratio.y = 0.536` fits this reading.

How ssp.exe uses them [disasm `CCharWndCode::ResetAllPositions` 0x41DE90, `SPGhost::SaveGhostWndPos` 0x63D640]:
- **Every scope** has its own; they are written to the current shell's `profile/shell.dat` **and** the ghost's
  `profile/ghost.dat` on Close, Change ghost (the old ghost's, before it unloads), a shell change and Reset shell
  position (which then deletes them, up to the highest `\p[n]` window made, §3.2). A ratio is the base point against
  the whole monitor rectangle.
- A scope is placed from `shell.dat`'s ratio, else `ghost.dat`'s (else the older `Char<n>.center/centery`), else at
  its default place (§3.2), each axis on its own. A `\p[n]` shown in a later session comes back to its stored place.
- These readers and writers are the only ones: no other ghost's place is read (§3.5).

Sumika keeps one record per ghost (the stage state, `sumika:ghost:<id>:state`; ratios of the viewport): every scope's
place survives a page change, and a cold boot keeps `\0`'s and `\1`'s and every `\p[n]`'s (`coldStageState`; a
`\p[n]` window is not made until a script shows it, then it stands at its stored place: `Stage._places`); a shell swap
keeps them all too (`swapStageState`). Not done: places per shell (`shell.dat` before `ghost.dat`): after booting or
switching to a shell used before, SSP may put the characters where they stood on that shell, Sumika keeps the
ghost's last place [disasm; infer for what a shell change looks like].

Proposed browser record (per site, per ghost), written on drag end, on `\![move]` end and on `pagehide`:
```json
{ "v":1, "desk":{"w":1536,"h":730}, "scopes":{ "0":{"rx":0.86,"ry":1.0}, "99":{"rx":0.2,"ry":0.4} } }
```
Restore: `baseX = rx*desk.w`, `baseY = ry*desk.h`; for bottom/top alignment ignore `ry`. Then clamp so at least 32 px of the
character (and its whole collision-free bounding box when possible) stays inside the desk. SSP has the option "Automatically move off-screen windows into view" [res dialog 103];
do this on load and on `resize`. (ssp.exe itself only brings back a window that misses the work area, §3.2; the 32 px
margin is Sumika's [decision].)

### 3.4 Dragging — P0

- **Left-button drag** of an opaque pixel moves the character window. Start the drag after 4 px of movement (Windows' drag threshold [infer]).
  Constraints: bottom/top alignment allows only X; left/right only Y; free both. `\![set,position,x,y,scope]` locks a scope
  (no dragging) until `\![reset,position]` [doc UKADOC:ss].
- Events: `OnMouseDown` at press; **`OnMouseDragStart`** when the drag begins; **`OnMouseDragEnd`** at release; then `OnMouseUp`.
  Do **not** send `OnMouseClick` after a drag [infer]. In passive mode DragStart/DragEnd are suppressed [doc UKADOC:ev].
  Satori uses Down/Up/DragStart/DragEnd for its "hold" (`…ホールド終了`) reactions [src Satori EventOperation].
- While dragging: the character's balloon moves with it; the talk keeps playing; the character is raised to the top of the z-order.
  SSP option "Make window translucent while dragging" [res dialog 103]: optional, opacity 0.7.
- `\![set,sticky-window,a,b,…]`: these scopes move together during drags and `\![move]` (except with `--option=ignore-sticky-window`).
  Alignment limits still apply per axis. Lasts until ghost exit [doc UKADOC:ss]. P1 (Tsubasa: 0 uses).
- Implementation: `pointerdown` → `setPointerCapture`, then follow `pointermove` on the captured element. This fixes Ikagaka's
  "drag stops when the pointer leaves the canvas" and "can't let go while dragging" bugs (NamedManager.js #16, #30).
  Use `transform: translate()` for movement.

### 3.5 Z-order — P1 (simple default is P0)

- Default: the most recently clicked character is in front ("the one the user operated last is frontmost" [doc UKADOC:ss
  `\![reset,zorder]`]). Each balloon sits directly above its own character. Menus and input boxes go above everything.
- `\![set,zorder,s1,s2,…]` (front to back), with balloon-aware syntax `b1,s1,b0,s0` (`balloonN`/`surfaceN`). Several
  groups are allowed; reusing a scope already in a group is an error until `\![reset,zorder]`. Lasts until ghost exit. Shell
  descript `seriko.zorder` / `seriko.sticky-window` preset them [doc UKADOC:ss, UKADOC:shell].
- Ikagaka bug to avoid: after `\x` the balloon stayed behind the character (NamedManager.js #10). Raise the balloon whenever its text changes.
- **Several ghosts** (§2.12; layers in §9.1): each ghost stacks as **one group**: its characters, its balloons
  and its input / communicate / teach boxes. The groups are ranked by **activation**: the ghost pressed (character,
  balloon or box), dragged, dropped on, whose menu opened, just called or changed to, or restored from Iconify comes
  above the others, **with its balloons and boxes**. So a character of the ghost on top may cover another ghost's
  balloon or box [infer: Win32 owned windows; SSP's ghosts are independent top-level windows, a click brings that
  ghost forward, doc SSPHELP config-disp]. Within a ghost the rules above stand. Menus, the info window and the launcher
  dock stay above every ghost; PageSaori's `fill_desktop` flash stays below every ghost.
- **No raise when a ghost starts talking** [guess]. SSP's per-ghost "喋る時に手前に出て来る" (`Talk.Activate`) raises a
  ghost when it talks and "喋り終わると裏へ沈む" (`Talk.DeActivate`) lowers it when it stops; with neither key set
  `GetActivateSetting(NULL)` returns 0 (no raise) [disasm `SPGhost::LoadSettings`], but the shipped default may be
  written elsewhere [?] (open point 3 below).
- **Placement** [disasm `CCharWndCode::ResetAllPositions` 0x41DE90, `GetDefaultWndPos*` 0x41D830–0x41DD80; an
  observation of ssp.exe below disagrees until open point 2 settles it]: there is **no rule between ghosts**. A ghost booting while others are on screen (Call ghost ▸ / `\![call,ghost]`,
  Change ghost ▸ / `\![change,ghost]`, the start of a set) places each of its characters from **its own** stored place
  (§3.3), else at **its own** default place (§3.2); nothing reads another ghost's windows (the one cross-ghost window
  list, `CCharWndCodeManager`, serves only drag snapping and the off-screen / overlap checks), nothing cascades, nothing
  avoids the caller, and a change hands no place from the old ghost to the new one (`OnSSPSysMsgGhostChange` 0x46ADD0
  saves the old ghost's places into its own profile only).
  - **Open: an observation of ssp.exe and Sumika disagree.** In ssp.exe **a ghost called for the first time did not
    stand on top of the caller**, with no clear pattern [observed]. Sumika, following the
    disassembly, **does** put a ghost never met on top of a caller that stands at its own default place (both `\0`s
    at the right edge). The two agree only if every ghost in that SSP install had run there before, so that each came
    back where it last stood [infer, unconfirmed]. Open point 2 below settles it: Reset shell position on the caller,
    call the other ghost, Reset shell position on it. If it then jumps onto the caller, its `\1` flush against its
    `\0`, the inference holds; if not, the default place of a called ghost is not traced.
  - **Sumika** (`Stage` per ghost, nothing passed between ghosts; `Site._call` / `Runtime._change` boot the ghost
    cold from its own stored state): a ghost met before in this browser comes back where it stood (every scope, §3.3);
    a ghost never met stands at its default place, so on a caller at its own default
    (`tests/runtime/multi.test.mjs` "placement as ssp.exe", emily4-after-Tsubasa sizes) [disasm; infer until open
    point 2 is settled]. The alternative "left of the leftmost character" has no basis in the disassembly and is not
    used.
  - Reset shell position stays per ghost. Two ghosts' balloons may overlap; nothing moves them apart (SSP neither)
    [disasm: no reader found; infer for what a visitor sees].

**Not yet compared with ssp.exe on screen** (several ghosts; keys are in §9.7):
1. Two ghosts' random talks: do they overlap freely? Which balloon is on top; does the clicked ghost come above the
   other's balloon? Can ghost B's character cover ghost A's communicate box? [infer]
2. **Open.** Where a ghost called for the first time stands. Seen so far [observed]: in ssp.exe
   it does not stand on top of the caller, no clear pattern. Sumika shows it **on top of the caller** (both at the
   right edge). The check that settles it, in ssp.exe with Tsubasa and emily4 (it opens
   no profile file and needs no new ghost): (a) on Tsubasa, right-click ▸ Utilities ▸ Reset shell position: she goes
   to the right edge; (b) Call ghost ▸ emily4: she comes wherever she last stood; (c) on emily4, Utilities ▸ Reset
   shell position. Does Emily now jump onto Tsubasa, with Teddy right against Emily's left side? Yes: SSP remembers
   where each ghost last stood, and a ghost it never met lands where Sumika puts it [infer]. No: where does Emily go?
3. Ghost(2) settings: what are the defaults of "喋る時に手前に出て来る" and "喋り終わると裏へ沈む"? [?]

### 3.6 Extra scopes `\p[2+]` — P0

- A character window for scope n exists from the first time a script selects `\p[n]` and gives it a visible surface. `\s[-1]` hides it.
  It persists until ghost exit [infer from SSP behavior; ninix creates windows on demand].
- Shell/ghost keys use `char<n>.` (`char5.defaultleft`, `char99.seriko.alignmenttodesktop`, `char<n>.balloon.offsetx`, …).
  Balloon images for n≥2: `balloonp<n>def<0|1>.png`, falling back to `balloonk*`, then `balloons*` [doc UKADOC:balloon].
- Mouse events report Reference3 = n (SSP and CROW support n ≥ 2 [doc UKADOC:ev]).
- Tsubasa [corpus, responses containing each scope]: 99:5591, 27:83, 5:76, 100:70, 11–16:67 each, 23:64, 95:59, 96:57, 10:45,
  19:41, 9:37, 17:32, 22:27, 97:27, 98:23, 26:20, 20:19, 21:16, 24:13, 25:13, 2/3/4:11, 18:8, 101:4.
  These are props, game boards and the panel. Many are placed with old-syntax `\![move,x,y,time,screen,left.top,left.top]` right after
  appearing (87 responses use `\![move`), and some are mirrored with `\![set,scaling,-100,100]`.
- `\![move]`/`\![moveasync]` base `screen` = the desk origin (top-left of the monitor in SSP) [doc UKADOC:ss notes_move].
  Map it to the viewport origin. `primaryscreen`/`global` map to the same in a browser.

### 3.7 Off-screen and overlap flags for OnSecondChange/OnMinuteChange — P0

- Reference1 "見切れ" (cut off): 1 when the character is partly outside the screen [doc UKADOC:ev]. ssp.exe 2.9.10 tests
  `\0`'s collision rect (its drawn pixels shrunk to 80 %), not its image: not inside the desk rect, edges inclusive,
  sampled every odd second (EV §3.2.1) [disasm]. Tsubasa reacts to it with timers (dic03_Menu.txt `＊OnSecondChange`: `＞見切れタイマをセット	（Ｒ１）==1`).
- Reference2 "重なり" (overlap): 1 when the characters overlap [doc]. ssp.exe: the collision rects of `\0` and `\1`
  intersect, strictly (EV §3.2.1) [disasm].
- SSP options "Disable screen boundary check" / "Disable character overlap check" force 0 [doc SSPHELP:config-ghost].

### 3.8 `\4` / `\5` — P2

Move the current scope a fixed distance away from the other character (`\4`), or to touching distance (`\5`; "no move
when it need not move"), then continue: UKADOC's examples show the following text only after the move [doc UKADOC:ss].
Distances are not documented [?]. Tsubasa: 0 uses [corpus]; the ghost sweep found `\5` in 6 ghosts and `\4` in 2.

Implemented (`ScriptPlayer._approach`, `approachTarget` in `src/sakura/commands.js`):
- The other character: scope 1 for scope 0, scope 0 for scope 1 and for every `\p[2+]` [guess]. When it is not shown
  (never created, `\s[-1]`), nothing moves [guess].
- Sideways only; `y` stays (a docked character stays docked anyway). The mover keeps the side of the other it is on
  (centres compared; equal centres: away from the half of the viewport the other is in, after ninix).
- `\4`: 1/20 of the viewport width further away [guess: ninix moves 1/20 of the work area; about 96 px at 1920 px].
- `\5`: until the rects (base surfaces) touch edge to edge; no move when they already touch or overlap
  [guess; ninix instead lets the windows overlap by about half the mover's width, surfaces having transparent
  margins, and does nothing while either centre is inside the other window].
- Neither pushes the window out of the viewport, or further out than it already is [guess].
- A mover hidden by `\s[-1]` moves as a window of the size it was last shown with (`CharacterView.lastRect`), so it
  reappears touching the other (`\5`) and inside the viewport (`\4` at an edge) [infer: SSP keeps a hidden window's
  size]. A hidden view's `rect` is only its base point (0×0); measured with that, `\5` put the base point against the
  other's edge (the window overlapped it by half its width) and `\4` let the base point reach the viewport edge (half
  the window off it, so 見切れ, §3.7). Ghosts that hide and then move (in the test ghost archive):
  `Maamikaso.nar`'s kero (`1つつかれ`: hides, `\5\5\4`, shows again next to the sakura), `radeon.nar`
  `\0\s[-1]\4\5\0\s[0]`, `yagi_the_twins080602.nar` `\1\s[-1]\4`. One never shown (no size known) does not move
  [guess]. A surface of another size shown afterwards stands at the same base point, unclamped, as after any `\s`.
- It is an instant, blocking `\![move]` [guess: time 0, as ninix]: it waits for a surface size still loading, the
  saved position follows (§3.3), and replay skips it like any move (SS §7).

---

## 4. Balloon behavior

### 4.1 Placement and side switching — P0

Inputs: character window rect `C`; balloon image size `bw×bh` (fixed-size images; the balloon does **not** grow with text);
shell offsets per side; balloon `windowposition.*`; runtime `\![set,balloonoffset]`/`\![set,balloonalign]`; user drag offset.

- Shell offsets [doc UKADOC:shell]: `sakura.balloon.offsetx/offsety` (and `kero.`, `char<n>.`). SSP lets you add a side suffix to the key:
  `offsetxl/offsetyl` (balloon on the left), `…r` (right), `…c` (above/below, centered), `…b` (below). Fallbacks: `xb→xc→x`;
  `xc/xl/xr→x` (X and Y resolved independently). Sign: **+X always moves the balloon toward the shell**; +Y always moves it down.
  Origin: on the left/right sides the balloon's top lines up with the shell image's top; for `c`, the balloon's bottom touches the shell's top;
  for `b`, the balloon's top touches the shell's bottom. Tsubasa: `sakura.balloon.offsetx,2`, `offsety,14`.
- Balloon descript `windowposition.x` [doc UKADOC:balloon]: a number (+ = right on both sides, unlike offsetx), or `center`/`top` (fixed
  above the shell, centered), or `bottom` (below). `windowposition.y` adds to Y. `windowposition.limit` (default **1**) keeps the
  balloon inside the screen.
- Side preference: shell `*.balloon.alignment` `none` (auto, default) | `left` | `right` (fixed), overridden by `\![set,balloonalign,…]`
  (`left|right|center|top|bottom|none`, until ghost exit).
- SSPHELP:config-talk: "when the balloon would stick out of the side of the screen, it switches left/right automatically".
  The right-click default action on a balloon is "switch side" (§4.4).

```
function placeBalloon(scope):
  dir = alignOverride[scope] ?? shellAlign[scope] ?? state.dir[scope] ?? 'left'
        // the right-click choice, else left; NOT "face the screen centre" (an earlier [infer]): it switched sides while
        // there was plenty of room, SSP switches only near an edge [observed]
  if dir in (left,right) and auto:                                   // flip only when it doesn't fit and the other side fits
     L = C.left  - bw + ox('l');   R = C.right - ox('r')
     if dir=='left'  and L < desk.x       and R+bw <= desk.right: dir='right'
     if dir=='right' and R+bw > desk.right and L >= desk.x:       dir='left'
  x = dir=='left' ? C.left - bw + ox('l') : C.right - ox('r')
  y = C.top + oy(dir)
  if windowposition.x is number: x += wp.x; y += wp.y                // center/top/bottom handled analogously
  x += userBalloonOffset[scope].x; y += userBalloonOffset[scope].y   // persisted, see 4.6
  if windowposition.limit != 0: clamp(x,y) into desk
  state.dir[scope] = dir        // sticky, right click or automatic: a balloon switched to the right stays there until
                                // the right side cuts it off [observed]; persisted with the balloon state.
                                // Automatic only when C has a size: a switch made against a 0×0 stand-in (images not
                                // loaded yet, e.g. on a resumed page; a hidden character never placed) is shown but
                                // not kept, else it would overwrite the saved side; the next place uses the real C
  image id: \b[n] with n even = left image, n|1 = right image (\b[2] → balloons2.png on the left, balloons3.png on the right)
```
  The ninix algorithm is the same, with "start left, flip when needed" [src ninix sakura.rb `reset_balloon_position`].
  Image parity [doc UKADOC:balloon]: even ids are the left-side balloons, odd ids the right-side ones. (Ikagaka's Balloon.js docs list a different 0–3 mapping; trust UKADOC.)
- Tsubasa's balloon use [corpus]: `\b[2]` (tall balloon, her menus) in 4,733 responses; `\b[4]` 79; `\b[1]` 51; `\b[0]` 19; `\b[-1]` 31.

### 4.2 Life cycle — P0

- A scope's balloon becomes visible when the script **first draws non-blank text (or a choice, image or marker) in it**. Scopes that draw nothing get no balloon.
  Blank text does not count: U+0020, U+3000 and TAB move the pen but do not open a balloon (SUMMARY C14, BA §3.11). Tsubasa's panel toggles write only `\_l[0,0] ` to scope 0, which must not pop up an empty balloon.
  `\b[-1]` hides the scope's balloon. [infer from SSP behavior and UKADOC "online mode shows \0's balloon even if empty"].
- **Starting a new script clears and hides all balloons**, unless the script **starts with `\C`**, which appends to the previous
  balloon text; the scope resets to `\0` [doc UKADOC:ss; src ninix `start_script`]. Tsubasa starts 601 responses with `\C` [corpus]. For example,
  opening her panel starts with `\C…\_q\_l[0,0] \_q\p[99]…` so the current talk is not wiped.
  **[?]** Does `\C` reopen a balloon that already timed out with its old text? Proposed: yes (keep the last text per scope until the next non-`\C` script).
- `\c` clears the current scope's balloon text. `\e` ends the script; the balloon **stays** until timeout, a click or the next script.

### 4.3 Timeouts — P0

| Timer | Default | Starts | On expiry | Overrides |
|---|---|---|---|---|
| Balloon ("talk") timeout | **15 s** [doc SSPHELP:config-talk live; res dialog 104 "(Default = 15sec.)"] | when the script has finished displaying (no choices pending) | close the balloons, send **OnBalloonTimeout**(R0 = script shown, R1 = remaining time) [doc UKADOC:ev] | `\![set,balloontimeout,ms]` for this script (`0`/`-1` = never; no value = default) [doc UKADOC:ss]; user setting; 0 = never |
| Choice timeout | **30 s** [same sources] | when the script has finished displaying, choices pending | send **OnChoiceTimeout**(R0 = script). If it returns no script, close the balloons | `\*` anywhere in the script = never (1,459 Tsubasa responses use it) [corpus]; `\![set,choicetimeout,ms]` this script only; anchors `\_a` never time out as choices but do as balloons |
| Click-wait timeout (`\x`) | **none** ("standard = never" [doc SSPHELP]) | at `\x` | continue as if clicked | user setting |
| Surface restore | more than the global talk timeout + **15 s** (30 s), at a local second of 10–50 [disasm] | when the talk stops (its end, or a break after it showed something) | send **OnSurfaceRestore**(R0 = `\0` surface, R1 = `\1` surface; -1 when not shown) once; held, never dropped, while the ghost cannot take it (EV §3.4) | a script's `\![set,balloontimeout,0]` holds it until the next script; its own value does not change the delay [disasm] |

- "Disable timeout when cursor is in balloon" is an SSP option [res dialog 104; doc SSPHELP]. Its default is on (Balloon.NoTimeoutMouseOver = 1) [disasm 0x72822b, 0x7283fb]; ssp.exe drops a default timeout whose expiry finds the pointer over \0's balloon [disasm DoWaiting 0x5d1b92-0x5d1baa].
  Recommend **on** in the browser: pause the balloon and choice timers while the pointer is over any balloon.
- Passive mode: neither balloons nor choices time out [doc UKADOC:ss notes_passivemode].
- An open input, communicate or teach box does not pause either timeout [disasm: no timeout code reads a box; EV §3.4]. ninix pauses (`user_interaction`); Sumika follows SSP.

### 4.4 Mouse on balloons — P0 (P1 for options)

SSP default operations [doc SSPHELP:config-talk "従来的な動作は左ダブルクリックでスクリプトブレーク、右クリックでバルーン左右切替"; res dialog 104
has user-selectable *Double click:* and *Right click:* actions: Do nothing / Same as left-click / Terminate script / Change direction /
Change balloon offset / Show menu / Move character window]:

| Action | Default behavior | Events |
|---|---|---|
| Left click during `\x` | continue. `\x` clears the balloon, `\x[noclear]` keeps it [doc UKADOC:ss] | — |
| Left click otherwise | bring this ghost's windows to front. **Does not** fast-forward text [infer: fast-forward is a held key, default **Ctrl** [doc UKADOC:ev OnUpdate note; SSPHELP "早送りキー"]] | — |
| Left click on a choice / anchor | select (§4.5) | OnChoiceSelectEx → OnChoiceSelect / OnAnchorSelectEx → OnAnchorSelect |
| Left double-click | **script break**: stop the script, close the balloons. Not possible during `\t`, passive mode or `\![enter,nouserbreakmode]`; may not close while choices are shown [doc SSPHELP "選択肢表示中など、閉じられない場合があります"] | while talking: **OnBalloonBreak**(R0 script, R1 scope, R2 break position counted in characters of the script including tags) [doc UKADOC:ev]. If the talk had already ended: **OnBalloonClose**(R0 script) [infer]. A returned script is played |
| Right click | switch this balloon's side (left↔right) | — |
| Wheel / arrow images | scroll the text (§4.7) | — |
| Drag | move the balloon (offset from the character), if "Allow balloon to be moved" is on [res dialog 145] (§4.6) | — |

ninix differs (right-click = break or close) [src]. Follow SSP's documented defaults.

### 4.5 Choices — P0

- Choices are clickable as soon as they are drawn, even while the rest of the script is still typing [infer].
- Selecting: stop the current script, then send **OnChoiceSelectEx**(R0 label text, R1 id, R2… extra args). If it returns no script, send
  **OnChoiceSelect**(R0 id, R1… more ids) [doc UKADOC:ss `\*` example: "Ex, and OnChoiceSelect if Ex has no talk"].
  IDs that start with `On` raise that event directly with the extra args as references. `script:…` runs inline [doc UKADOC:ss `\q`].
  Satori avoids running the same ID twice when both Ex and plain arrive [src Satori EventOperation].
- If the selection event returns **no script, close the balloons** [src ninix `notify_link_selection`; SSP believed same].
  If it returns a script, it starts normally, so the balloons are cleared unless it begins with `\C`.
- A choice ID that is a URL opens it in the browser and closes the balloon [src ninix `is_URL`]. SSP behavior [?].
- Hover: `OnChoiceEnter` (with references on enter, none on leave) and `OnChoiceHover` (pointer resting) [doc UKADOC:ev];
  implemented as ssp.exe 2.9.08f sends them, with `balloon_tooltip` and the tooltip box: §4.8 [disasm].
  Visual hover style comes from the balloon's `cursor.*` keys (a format topic). LightBlue uses `cursor.blendmethod,notmaskpen`, a GDI raster op.
  With a raster-op blendmethod SSP 2.9 draws **only the pen**: the outline (and/or underline) in the pen colour, no fill, text colour unchanged
  [observed; BA §3.8]. Superseded: "approximate it with a filled rect plus `mix-blend-mode: difference`" (and SUMMARY C13's exact ROP2 filter).

### 4.6 Balloon dragging and offset memory — P2 (implemented)

When allowed, dragging a balloon changes `userBalloonOffset[scope]` relative to the character. SSP has "Reset balloon position"
(Ctrl+Shift+F10) and "Enable balloon position correction" items [res MENU 102; UKADOC:res `enableballoonmovebutton`,
`resetballoonpositionbutton`]. Ghost descript `balloon.dontmove,true` disables it [doc UKADOC:ghost]. Persist per ghost.

As implemented (`src/balloon/view.js`, `manager.js`; CONTRACTS "Balloon"):
- A left-button or touch press on the balloon becomes a drag after **4 px** of travel (mouse and pen) or **10 px** (touch), the same
  thresholds as character drags. A drag is not a click: its click and double-click are swallowed.
- The balloon follows the pointer, clamped to the viewport, and is raised. The result is kept as the scope's offset from its computed place,
  so it keeps following its character and survives side flips and `\b[n]` changes. It is saved with the balloon state.
- The menu's Utilities ▸ Reset position also forgets the balloon offsets.

### 4.7 Scrolling, markers, speed — P0/P1

- Text that overflows the valid rect **auto-scrolls** to keep the cursor visible; `\![set,autoscroll,disable|enable]` (user scroll still works).
  Show `arrow0.png` (up) / `arrow1.png` (down) at `arrow0.x/y`, `arrow1.x/y` when more text is above/below. Wheel or arrow click scrolls one
  line [doc UKADOC:balloon, UKADOC:ss]. P1 (Tsubasa's long logs and game boards may overflow).
- `\![*]` draws the marker image (`marker.png`, falling back to `sstp.png`) inline. 349 Tsubasa responses use it [corpus]. LightBlue has only
  `sstp.png`, so use that. P0.
- Online marker: `online0..N.png` animated every `onlinemarker.interval` at `onlinemarker.x/y`, shown during network activity or
  `\![enter,onlinemode]`. SSTP marker `sstp.png` plus sender text at `sstpmarker.*`/`sstpmessage.*` for SSTP-sourced scripts [doc UKADOC:balloon]. P2.
- Text speed: **50 ms per character** by default (dialog slider "Default (50ms)", range up to "Slower (200ms)" [res dialog 104]).
  `\_q` turns per-character delay off; `\w`/`\_w` are explicit waits. Ikagaka users reported its talk ran "about 2× faster than SSP"
  (Shell.js #54), so use 50 ms and make it a setting.
- Holding the **fast-forward key** (default Ctrl) skips waits [doc]. Avoid Ctrl in a browser (Ctrl+click opens tabs, Ctrl+W closes them).
  Use **Shift held while the pointer is over the balloon**, configurable [infer].

### 4.8 Tooltips and choice hover — P1 (implemented)

In ssp.exe a balloon choice shows a tooltip (emily4's double-click menu, "なんか話して": a box with
"■なんか話して■" / "みんなでおしゃべりします。" on two lines, white box, dark border, dark text, below-right of the pointer;
Tsubasa's dress-up icons, e.g. "Monochrome Winter Outfit (Mini) + Tights") [observed]. Read in ssp.exe 2.9.08f with
`ssp.map` [disasm]; the research notes (addresses, the ghost corpus counts, the engine probes) are in
`docs/research/scratch/tooltips/` (`ssp.md`, `code.md`; not normative, their helper scripts and dumps were not kept).
Re-checked in the disassembly for the implementation: the grid and dominant colour, the contrast fix, the tooltip
block's name rule and its empty-text delete, the click's and the timeout's NOTIFY; and the selection's hit band
(SelectLineInternal), the highlight (DrawString) and the width constant. Sumika: `src/ui/tooltip.js`
(the box and SSP's pure rules), `src/balloon/model.js` (selection, rest, cache), `src/shell/mouse.js` and
`character.js` (collision rests), `src/core/events.js` (the events and the texts).

**Balloon** (`CMessageWnd`: one Win32 tooltip per balloon window, its tool the whole window, text by callback):
- **Selection** (UpdateSelection 0x470350): every mouse move hit-tests the items (`\q`, `\__q…\__q` with text or
  images, `\_a…\_a`, event choices; one code path); when the item under the pointer changes, the tip pops and the
  hover events go out (EV §4.7): entering = GET OnChoiceEnter / OnAnchorEnter [R0 text, R1 ID, R2… args]; leaving =
  OnChoiceEnter **without References**: NOTIFY (sent first) when going straight to another item, GET when going to
  empty balloon space. **Leaving the window sends nothing and keeps the item selected** (WM_MOUSELEAVE does not call
  UpdateSelection). **Above validrect.top or below validrect.bottom** (the balloon's top and bottom margins; y only,
  both edges inside) the hit test answers "no item" without storing it (SelectLineInternal returns −1 at 0x5cf7a4 /
  0x5cf7c6, before the item loop; only the loop's end at 0x5cf8a6 stores −1 in the selection +0xA84): UpdateSelection
  compares that −1 with the item still stored, so **every new pointer position there** pops the tip and sends GET
  OnChoiceEnter without References, and the item **stays selected** — coming back onto it sends nothing, going on to
  another item sends the NOTIFY first. Nothing is hit there, positioned `\_b` link images included; a click there is
  not an item's (EX_OnLButtonUp uses the same test). DrawString (0x5cc678 → DrawOneElement) draws the selected item
  (+0xA84) highlighted, which suggested it stays highlighted in a margin and after a leave [disasm]; but ssp.exe
  keeps no highlight after the pointer leaves an item [observed], so what is drawn follows the
  pointer [infer: a repaint path the reading missed]. The selection and its events above are unaffected.
  A click on an item sends NOTIFY OnChoiceEnter (no refs) before OnChoiceSelectEx / OnAnchorSelectEx
  (EX_OnLButtonUp 0x470905), a choice timeout with an item selected before OnChoiceTimeout (DoWaiting 0x5cff45).
  Replies to the GETs play like a click's (PlayScriptWithMsg): one that does not start with `\C` replaces the menu
  [disasm]. Sumika follows that exactly [decision]; none of the site's ghosts answers them (all 204), kanade_2nd (not on
  the site) answers OnChoiceHover with `\C` text in `\1`.
- **When the text is asked** (ToolTipDispInfo 0x472060): at TTN_GETDISPINFO, i.e. when the pointer has rested for the
  initial delay (the double-click time, 500 ms by default [win32]; the tool is re-added on each selection change, so the
  count restarts per item). Over empty space: the cache resets, nothing shown. On the item asked last: its cached text
  (also an empty one), no request. On another item: **GET OnChoiceHover / OnAnchorHover** (reply plays), then **GET
  `balloon_tooltip`** with the same References. WM_MOUSELEAVE resets the cache. So: once per entry; A → B → A asks three
  times; passing over a gap without resting keeps A's text. No check of the player state (items typed so far get tips),
  passive mode or `\t` [disasm]. After the 20 s auto-pop, with the pointer still on the item: the cached text again
  after the next rest [guess: open point (6) below]; the Windows control may as well keep it hidden until the pointer leaves
  the tool (SSP re-adds its tool only on a selection change, so: until another item, empty space or a leave) [win32;
  infer].
- **References** (SelectEvent 0x5cf260): R0 the item's text as shown, all its pieces joined, untrimmed (emily4's padded
  menu labels arrive padded; she strips them), **'' for an image-only `\__q`** (Tsubasa's icons); R1 the ID as parsed
  (Satori's `id\x01label\x01N` unchanged: Tsubasa splits it herself); R2… the tag's further arguments [disasm].
- **Reply**: the Value of a 2xx (SSP also takes 311 / 312 and String / Sentence); 204, an error or empty: no tip. Text:
  `\&[name]` decoded (SPGhost::DecodeEntity's rules, `shiori-events.md` §5.5: SSP's 252 names, an unknown one a space;
  in the loop's `resourceOf`, not with the script player's table), then every
  two-character `\n` → a line break (a plain substring replace); nothing else, other tags
  show literally [disasm GetStringShiori, 0x47227E]. Not a script: never played.
- **Look** (CToolTipCustom, its own paint also outside dark mode): background = the dominant colour of the balloon
  image's cell under the pointer in a **6 × 8 grid over the validrect** (the fullest 4-bit-per-channel bin of the
  opaque pixels, its average; LoadFinish 0x5c1d60, GetDominantColor32 0x754400, LookupDominantGrid 0x5c1c40); a 1 px
  border and the text in the balloon's `font.color`, refitted for contrast when within 90 luminance of the background
  (SetColors 0x4b4110); text 4 px / 2 px inside; word wrap at 500 px (TTM_SETMAXTIPWIDTH, a constant in
  CToolTipCustom::Create 0x4b4009: device px, as SSP is DPI-aware, §9.9, while the font grows with the display); the
  system tooltip font; auto-pop 20 s (TTM_SETDELAYTIME) [disasm]. emily4: white under her menu, dark red (105,25,25)
  border and text, the observed "white box, dark border" [observed; infer for the red].
- **Hidden** at once when the item changes or the pointer goes to empty space, when it leaves the window, on a press
  [win32], on a balloon drag [disasm SetDragMode]; a move inside the item keeps it where it is and restarts the
  auto-pop [win32]. Position: the pointer's x, just under the cursor image, moved onto the screen [win32; infer].

**Shell** (`CCharWndCode`: the same control per character window, the plain Windows look) [disasm ToolTipDispInfo
0x41fa90]: after the rest, **only on a named collision** and only when it differs (any case) from the collision asked
last (reset by a rest off any collision and on leaving the window): **GET OnMouseHover** (its only sender in 2.9.08f;
skipped while IsNoInterrupt, i.e. `\t`), then the text: the property `currentghost.seriko.tooltip.*`, else the shell's
`<scope>.tooltips` line (SH §2.16; the ghost is then not asked), else **GET `tooltip`** [R0 x, R1 y (surface px), R2 0,
R3 scope, R4 collision, R5 0]; the same `\n` rule. A collision change, a surface change, leaving, a press or a drag hide
it. While it shows nothing is asked (no TTN_GETDISPINFO): it stays where it appeared, and a move inside the collision
restarts its auto-pop [win32]. Not in select mode. No option turns any of this off [disasm; doc SSPHELP].

As built:
- One box per page (`TipBox`, `tipBox()`): `<div class="smk-tip" role="tooltip" lang="">` at root level of the shadow
  root, `position: fixed`, **z-index `Z_BASE + 199`**: above every ghost layer (≤ `+189`) and the launcher dock
  (`+190`), below the menus and the info window (`+200`); `pointer-events: none` (SSP's TTF_TRANSPARENT). With several
  ghosts it belongs to the ghost under the pointer: whoever shows it owns it, and only the owner hides it.
- Balloon: the model's `hoverAt` (mouse and pen moves), `selected`, `'select'` → the loop's OnChoiceEnter; the rest timer
  (500 ms), the per-item cache and `tipSource` (the loop: OnChoiceHover, then `balloon_tooltip`). A reply shows only if
  the pointer still rests where it asked; one that comes after a move is kept for the item and shown at the next rest;
  one after the content changed is dropped. Colours from the balloon image (grid computed once per skin image).
  SSP's hit band (`LayoutEngine.inBand`): `linkAt` hits nothing above validrect.top or below validrect.bottom, and
  there `hoverAt` emits `'select'` {index −1, prev: the selected item} at every new client position (a repeated one
  counts once: SSP's PreTranslateMessage drops it) without changing `selected`. The highlight follows the pointer, not
  the selection: it goes in a margin and on a leave, as in ssp.exe [observed: point (3) below].
- Shell: `MouseTracker` emits `hover` {fresh, clientX, clientY, rest} only at a rest on a named collision; the character
  view asks `stage.tipSource` (the loop: OnMouseHover when fresh and not in `\t`, then the shell's text or `tooltip`),
  caches the text per collision and shows it in the system look. The stage emits no `hover` as MouseInfo, and
  OnMouseHover is not sent after every rest anywhere on the character (etherism's help panel comes once per
  collision, as in SSP). The view decides `fresh` too: a rest on a collision it has no answer for (never asked: no
  source in a frozen tab; or answered undefined: the loop not live yet, a picked choice's reply pending) is asked
  fresh, so OnMouseHover goes out once the loop can send it. A shown tip stays where it appeared: moves inside the
  collision restart its auto-pop (`TipBox.touch`), a rest does not show it again. A reply that arrives after something
  took tips away (`hideTip`: a surface change, a press, …) is cached but not shown; the next rest shows it.
- Nothing is asked while the loop is not live: not booted, closed, frozen (another tab leads), swapping shells,
  minimized, or a picked choice's reply on its way (SSP's click holds its UI until answered). A frozen tab's views have
  no tip source.
- Text: `textContent` (never HTML or SakuraScript), `white-space: pre-wrap`, tab size 8, max-width 500 device px
  (`tipMaxWidth`: 500 / devicePixelRatio CSS px, set at each show: 400 on a 125 % display, where the 12 px
  font is SSP's 15 device px; and the viewport), long words wrap anywhere [decision: DrawText would widen the box
  instead; the longest answer in the corpus is an 85-character URL]. Page zoom also narrows the width while the font
  grows [decision: the browser cannot tell zoom from the display; scaling.js reads devicePixelRatio the same way]. Font
  12 px "Segoe UI", "Yu Gothic UI", "Meiryo UI" (9 pt) [infer]; not scaled by Balloon scaling (a separate window in
  SSP) [infer]. Place: the pointer's x, 20 px under it; above the pointer when it would leave the bottom; moved left at
  the right edge; 2 px inside the viewport; fixed while shown [infer]. After the auto-pop a rest shows the cached text
  again, balloon and shell alike [guess: open point (6) below].
- The canvas the tip belongs to gets `aria-describedby` on the box while it shows (accessibility; the choices are
  drawn, not elements).
- Touch has no hover: no selection events, no tooltips [decision]; a tap on an item still sends the click's NOTIFY
  OnChoiceEnter. Pen hover counts as a mouse.
- Not done: SSP's property override `\![set,property,currentghost.seriko.tooltip.…]` (logged once as not supported
  yet, properties.md §6); the
  drag tips ("Offset: x,y", the window position while dragging a character) [decision: SSP's own UI, not the ghost's];
  re-testing the item under a still pointer when new items appear (SSP posts UpdateSelection then; here the next move
  does it) [decision]; SSP's `&` → `&&` in shell tooltip texts (SPSerikoToolTipsEntry::Set) is not copied: with
  TTS_NOPREFIX it would show doubled [infer; no shell in the corpus has an `&` there]; 311 / 312 and String / Sentence
  replies; NFC normalisation of `\q` titles (NormalizeCleanupString) [infer].
- Points not yet compared with ssp.exe on screen [guess unless said]: (1) open: the tip box's colours (a first look
  found them probably the same as SSP's, but what was compared is unclear [observed]). To check, in both programs: click
  "Dress-up" in her own menu (in her balloon), rest the pointer on one of its items until the small tip box appears
  ("Ponytail", "Twin Tails", …), and compare the box's background colour and the colour of its border and text. The
  same for emily4's balloon menus: is the tip text black or very dark red? (2) the delay (~0.5 s), the tip vanishing
  at once on the next item and coming back after another half second; (3) settled: leaving an item, ssp.exe does not
  keep it highlighted either [observed], as here; (4) Balloon scaling 200 %: is the tip text system size?
  (5) Tsubasa's `\p[99]` panel: "Show menu" etc. on its collisions, and not again on the same collision until another
  one or a leave; does the tip stay where it first appeared while the pointer moves and rests on the same collision?
  (6) after the 20 s auto-pop, does it come back while the pointer stays on the item or collision (here yes, at the
  next rest), or only after another item or collision or a leave (the Windows control's likely rule)? (7) the shell tip
  look (here a light Windows 10/11 tooltip: white, grey border #767676, grey text #575757, small shadow); (8)
  etherism's touch-guide panel once per collision; (9) does a menu still time out after kanade_2nd's OnChoiceHover
  `\C` reply (here its run replaces the menu's: the balloon timeout, not the choice timeout, applies after it) [?];
  (10) a tip line of about 35 full-width characters wraps in two at 125 %? (the width is 500 device px here too).

---

## 5. Talk scheduling, interruption, cantalk, passive mode

### 5.1 Event sources and what happens while a script plays — P0

| Source | Sent while a script plays? | If it returns a script |
|---|---|---|
| OnSecondChange / OnMinuteChange | yes, **as NOTIFY with R3=0** whenever cantalk is false [doc UKADOC:ev] | NOTIFY replies are ignored, so they never interrupt |
| OnHourTimeSignal (P1) | **waits** until talking is possible, so it may arrive late [doc UKADOC:ev] | plays |
| Mouse on character (Down/Up/Click/DoubleClick/Wheel/Move/Drag*) | yes, except during **`\t`** (time-critical: no mouse-type events until a script break or `\e` [doc UKADOC:ss]) and passive-mode limits | **replaces** the current script (stop it, start the new one) [infer; ninix behaves this way] |
| OnKeyPress | yes, when the ghost is "active" (§9.7) | replaces |
| Menu items, choices, anchors, input boxes | yes | replaces |
| `\![raise,ev,…]` inside the running script | sends the event at that point | replaces the rest of the current script [infer] |
| `\![embed,ev,…]` | sends the event at that point | the reply text is spliced into the running script at the tag [doc UKADOC:ss] |
| `\![timerraise,ms,once?,ev,…]` timers | fire when due | replaces (if `\t` is active, queue until the script ends) [infer] |
| SSTP SEND (P2, §5.4) | yes | **breaks** the current script unless `Option: nobreak` (then queued). Refused with **409** during `\t` [doc UKADOC:sstp] |
| OnSurfaceRestore, OnBalloonTimeout, OnChoiceTimeout | only when idle | plays |

Rule of thumb for the scheduler: **a returned script from a GET request starts immediately and stops the old one**, except
(a) NOTIFY requests (ticks with cantalk=0 and other notifications), and (b) while `\t` is active, when mouse events are dropped and
other sources wait. When a script is stopped by replacement, send nothing (no OnBalloonBreak; that event is only for the user's break gesture) [infer].

### 5.2 cantalk and the Status header — P0

SSP sends a `Status` request header listing the current states, comma-separated [doc UKADOC:shiori3]:
`talking`, `choosing`, `minimizing`, `induction`, `passive`, `timecritical`, `nouserbreak`, `online`,
`opening(communicate/input/teach/dialog)`, `balloon(0=2/1=0)` (scope=balloon id for each visible balloon).
Satori reads `talking` for hold detection and stroke suppression, and `induction`/`passive`/`timecritical` for strokes [src Satori EventOperation].

```
cantalk = !(talking || choosing || minimizing || passive || timecritical || closingOrBooting)
          && !document.hidden            // browser addition, §9.5
// talking  = a script is executing (including waits and click-waits)
// choosing = the script ended with choices still selectable
tick each second (wall clock aligned):
  method = cantalk ? 'GET' : 'NOTIFY'
  send OnSecondChange(R0 uptimeHours, R1 mikire, R2 kasanari, R3 cantalk?1:0, R4 idleSeconds)
  on minute change: same for OnMinuteChange
```
"choosing" (a `\x` or choice wait) and "minimizing" make the tick NOTIFY [disasm OnTimeChange 0x641e03–0x641e50];
"opening(…)" does not (EV §1.6) [disasm; decision: as ssp.exe]; passive mode forcing cantalk=0 is [doc] and [disasm] (+0x41a8).
After a talk ends and its balloon is still showing (waiting for the timeout), cantalk is **true**: a random talk may replace it [infer, ninix does this].
R4 (SSP only) = seconds the user has been idle at OS level. Browser: seconds since the last pointer/key event on the page.

Satori's random talk [src Satori EventOperation]: in OnSecondChange with cantalk=1 and an empty reply, Satori counts down
`talk_interval` (set by the dictionary variable `＄喋り間隔`). At zero it runs `＊OnTalk` (Tsubasa: 30/60/120/200/300 s
or 0 = off, from her settings menu, dic03). `＄喋り間隔誤差` randomizes the interval. Timers (`…タイマ`) and autosave also run here. So
**SSP itself never decides when to talk** for a modern ghost. SSP's old "talk frequency" and "Raise AI talk from SHIORI" options exist only
for old-spec ghosts [res MENU 102 "[Compatibility] Raise AI talk from SHIORI"; doc SSPHELP]. Send `OnAITalk` only for the `\a` tag [doc UKADOC:ev].

### 5.3 Passive and induction mode — P1 (Tsubasa: 0 uses)

`\![enter,passivemode]` lasts until `\![leave,passivemode]` or ghost exit (menu "Reset passive mode" also leaves it) [doc UKADOC:ss].
It shares one slot with induction mode, SPGhost+0x41a8 (1 induction, 2 passive): entering one mode leaves the other,
and `\![leave,passivemode]`, `\![leave,inductionmode]` and Reset passive mode each leave both [disasm 2.9.10
ExecuteExclamationTag 0x62f43a, 0x62f484, 0x630513, 0x63055d; OnMenuLeavepassive 0x49dd12]. Sumika too
(`_setLifeMode`; Status shows one of `induction`, `passive`: EV §1.6).
These restrictions apply to *user* operations; SakuraScript may still do everything [doc UKADOC:ss notes_passivemode]:

| Restriction | Browser implementation |
|---|---|
| menu items limited | **implemented** (§2.11 "Enable levels"): passive mode (level 3) greys Recommendations ▸, Portal ▸, both scalings, Change ghost ▸, Shell ▸, Clothes/Dressup ▸, Balloon ▸ and Iconify; induction mode and minimized (level 2) the same without Iconify [disasm `GetEnableState`]. Information ▸, Language ▸, Utilities ▸, Close and Quit stay enabled (the earlier "all but Information / leave-passive" was too broad); dress-up picks are refused |
| no script break (double-click) | ignore |
| choices never time out; balloons never time out | skip timers |
| file drops ignored | ignore |
| no OnSurfaceRestore | held until passive mode ends (EV §3.4) |
| **cantalk always false** (OnSecondChange/OnMinuteChange still sent) | NOTIFY ticks |
| cannot change ghost, minimize, close, update, uninstall | Change ghost ▸ and Iconify greyed (above); there is no Network update or Uninstall here. SSP keeps Close / Quit enabled and first asks `info.threadbusy` (Yes/No) [disasm]; Sumika closes without asking [decision] |
| OnMouseDragStart/End suppressed [doc UKADOC:ev] | skip |

`\![enter,inductionmode]` = passive mode, except timeouts happen and minimize/close are allowed [doc]. It replaces
passive mode rather than adding to it (one slot, above) [disasm].

### 5.4 SSTP — P2 (no network SSTP in a browser)

A browser cannot listen on port 9801. If cross-page or cross-tab messaging is needed later, accept SSTP-like messages over
`BroadcastChannel`/`postMessage`. Keep the semantics: `Option: nobreak` queues instead of breaking; 409 during `\t`; `notranslate`;
`nodescript` hides the SSTP sender marker [doc UKADOC:sstp].

### 5.5 Scheduler pseudo-code — P0

```
state: current = {script, tokens, pos, scope, flags{timecritical, nouserbreak, noChoiceTimeout, choiceTimeoutMs, balloonTimeoutMs}}
queue: deferred = []   // timerraise/raise that arrived during \t; SSTP nobreak

async function dispatch(ev, refs, {origin}) {            // origin: 'tick' | 'user' | 'timer' | 'script'
  if (current.flags.timecritical && ev.startsWith('OnMouse')) return       // dropped
  const method = (origin==='tick' && !cantalk()) ? 'NOTIFY' : 'GET'
  const res = await shiori.request({method, id: ev, refs, headers: {Status: statusString()}})
  if (method==='NOTIFY' || !res.value) return false
  if (current.flags.timecritical && origin!=='user-break') { deferred.push(res.value); return true }
  start(res.value)                                        // stops current, clears balloons unless it starts with \C
  return true
}
on script end: if deferred.length → start(deferred.shift())
```

---

## 6. Communicate box and input boxes

### 6.1 Communicate box — P0 (Tsubasa: key `c`, panel `Mcommunicate`, 6 responses)

- Open: `\![open,communicatebox]`, `\![open,communicatebox,text]` or `\![open,communicatebox,--text=…]` (initial text), plus `--option=…` like inputbox [doc UKADOC:ss].
- Look: balloon image **`balloonc1.png`** (`balloonc0` Send box, `balloonc2` Teach, `balloonc3` Input, `balloonc4` Address bar) [doc UKADOC:balloon].
  The editable area is at `communicatebox.x/y/width/height` (LightBlue: 10,18,301,18). Font `communicatebox.font.name`
  (default ＭＳ ゴシック), color `communicatebox.font.color.*`, background `communicatebox.background.color.*`. SSP may add OK/Cancel image
  buttons (`ok_up/down.png`, `cancel_up/down.png`). LightBlue has none, and SSP 2.9.08f then shows a small **OK** push
  button right of the field and a **×** push button right of OK, both about the field's height [observed]. Sumika draws
  them inside the `communicatebox` rectangle, with a shortened field (BA §5).
  Measured from two ssp.exe 2.9.08f screenshots. The first used SSP's default balloon
  "SSPデフォルト+", whose communicatebox is 8,18,301,18; the second used LightBlue (10,18,301,18), with Windows display
  scaling at 125 % [observed: screenshots]:
  - Size: SSP draws the box at its image's own pixel size. At 125 % the balloon and the character grow (340×170 → about
    414×212), but the communicate box stays 322×42. Sumika does the same when the primary pointer is a mouse
    (`transform: scale(1/devicePixelRatio)`); touch screens keep CSS pixels.
  - Layout: [field 262] 1 px gap [OK 20][× 18], all 18 px high; the two buttons touch.
  - Buttons: drawn by SSP, transparent, with a 1 px frame and a bitmap glyph in the balloon's font colour. "OK" is a
    10×9 glyph at +4,+4 and "×" a bold 8×8 glyph at +5,+5. Exact bitmaps are in `src/balloon/dialogs.js` `GLYPHS`.
  - Field: a Windows 11 text box. The outer frame is rgb 236 at top and left, 230 at right and 131 at the bottom; the
    inner frame is 254, or 247 on the right. While focused, the bottom two rows are the accent colour (0,103,192), the
    Windows 11 default.
  - Field fill: one flat colour, the image's pixel at the centre of `communicatebox.*`: (222,231,255) for SSP's
    balloon, white for LightBlue. The image's pattern does not show through.
  - Field text: MS Gothic 12 px in the balloon's `font.color` when `communicatebox.font.color` is not set, starting
    3 px inside the field.
- Position: resource `communicatebox.defaultleft/defaulttop` (screen coords) when given [doc UKADOC:res]. Otherwise SSP's default is
  not documented [?]. Proposal: horizontally centered over `\0`'s balloon area, top = `\0`'s top − box height − 8, clamped; draggable.
- Submit (Enter or OK): send **OnCommunicate**(R0 `user`, R1 text). The box **stays open**: the field is cleared and
  keeps the focus, so the user can keep talking [observed: SSP 2.9.08f does not close it after a message]. Empty text sends
  nothing. Satori turns each message into a search for `ユーザ「text」` talks, or `＊COMMUNICATE該当なし` (no match) [src Satori].
- Close (Esc or ×): send **OnCommunicateInputCancel**(R0 empty, R1 `cancel`). `\![close,communicatebox]` closes **without** that event [doc UKADOC:ss].
- `inputbox.autocomplete` resource is requested when a box opens: a `0x01`-separated suggestion list [doc UKADOC:ev]. P2.

### 6.2 Input box family — P0 for `inputbox`, P2 for the rest

Syntax [doc UKADOC:ss]: `\![open,inputbox,ID,timeoutMs,text,options…]` (old positional form) or `--timeout=`, `--text=`,
`--limit=N` (max chars), `--option=noclose` (stay open after submit), `--option=noclear` (keep the text, use with noclose),
`--balloon=ID` (use `balloonc<ID>.png`), `--reference=X` (extra references). Timeout omitted or ≤ 0 = no limit.
Variants: `passwordinput` (masked), `dateinput` (R1 = `Y,M,D`), `timeinput` (`h,m,s`), `sliderinput` (value; R2 = `min,max`), `ipinput`.

Events [doc UKADOC:ev, UKADOC:ss notes_inputbox-id]:
```
OK:
  if ID starts with "On": send <ID>(R0 text, R1 supplement, R2.. extra)
  else:                   send OnUserInput(R0 ID, R1 text, R2 supplement, R3.. extra)
Close button / Esc / timeout:
  send OnUserInputCancel(R0 ID, R1 'close' | 'timeout')        // ninix sends R0 empty; UKADOC says "input event ID"
  if reason=='timeout' and OnUserInputCancel returned no script:
      send OnUserInput(R0 ID, R1 'timeout')                     // compatibility rule, REQUIRED by Tsubasa
\![close,inputbox,ID]: close silently (no event). Tsubasa uses it (13 responses).
```
Tsubasa [corpus]: `\![open,inputbox,ユーザ名]` (first boot: her name question), `ユーザ`, `数当て答え,,（default)` (guessing game,
initial text), `数字記憶答え`, `タイプ答え,11500` / `,12000` (typing game with timeout; `＊タイプ答えを教えてもらった`
checks `（Ｒ１）==timeout`, dic13_Game.txt), `短冊２..５` (Tanabata strips). Satori's handler `＊OnUserInput` stores R1 into the variable named R0 and calls `（Ｒ０）を教えてもらった`.

SSP note: older bases blocked all other interaction while a box was open; **SSP does not** [doc UKADOC:ss]. Several boxes may be open at once.

### 6.3 Teach box — P2
`\![open,teachbox]` → OnTeachStart; OK → OnTeach(R0 text); close → OnTeachInputCancel [doc UKADOC:ss].

Implemented (`EventLoop._runBox` / `_teachResult`, `Dialogs.teachBox`). Used by 3 ghosts of the sweep (old Satori's
`＄教わること` writes `\![open,teachbox]`); Satori Mc203 has no handler of its own, so OnTeach reaches `＊OnTeach`.
- Open: `\![open,teachbox]` or `\__t`. A second one replaces an open teach box without events. Arguments are parsed
  like the communicate box's (initial text, `--text=`, `--title=`, `--balloon=`) [guess: UKADOC documents none].
- OnTeachStart (no references) is a GET sent once the box is open (`Status: opening(teach)`), and its reply plays
  [guess: GET as ninix; UKADOC says only "notified"].
- Look: the communicate box's ([field][OK][×], §6.1) over `balloonc2` (BA §5). UKADOC names its OK button
  ("TeachBoxのOKボタン"). Its accessible name is the runtime's 'Teach' / 'ティーチ' (`box.teach`).
- One word per box: Enter or OK with some text closes it and sends GET **OnTeach** (R0… = the words of this round,
  the first in R0 and the newest last [doc UKADOC:ev]). Empty text sends nothing. [guess: closes like an input box,
  because SHIORI/3.0's 311/312 "open the input box again"; chisato2_022 and ruka020418 (2002, written for an older
  baseware) tell the user to close the Teach dialog with Esc after it was answered, so it once stayed open.]
- Reply status [doc spec_shiori3]: **311 Not Enough** opens the box again, and the next word is added to the
  references; **312 Advice** drops the newest word first, then opens the box again. A Value with either plays as
  well [guess]. Any other answer (200 plays as usual, 204, errors) ends the round; the next `\![open,teachbox]`
  starts a new one. The box reopens before the reply plays, so a `\![close|open,teachbox]` in that reply wins.
  OnTeachStart is not sent again for a 311/312 box [guess].
- × or Esc: GET **OnTeachInputCancel** (R0 `""`, R1 `cancel`) [doc UKADOC:ev]. `\![close,teachbox]` closes it without
  that event [doc UKADOC:ss]; `\![close,inputbox,__SYSTEM_ALL_INPUT__]` does not touch it [guess].
- An open teach box, like the other boxes, leaves cantalk alone: only `opening(teach)` in Status (§5.2, EV §1.6)
  [disasm; decision: as ssp.exe]. It survives page navigation with the words of its round (state `boxes[].words`); it comes
  back without a second OnTeachStart.

### 6.4 Browser implementation notes — P0
- Use a real `<input>`/`<textarea>` inside the shadow root, styled over the balloonc image, so IME, clipboard, mobile keyboards and screen readers work.
- **Do not submit on Enter while the IME is composing** (`e.isComposing || e.keyCode===229`). Japanese input is expected.
- Autofocus on open, but never steal focus from a page field the user is typing in: open unfocused and pulse the box instead.
- Stop key events in the box from reaching the page and OnKeyPress.
- On mobile the virtual keyboard shrinks the *visual* viewport. Phones: §9.11 (visualViewport, the focused box only,
  moved up or down, never while pinch-zoomed).

---

## 7. Idle behavior: SSP vs the SHIORI

| Behavior | Who does it | Notes |
|---|---|---|
| Blinking, breathing, ambient motion | **SSP (SERIKO)**, from surfaces.txt `animationN.interval` | `sometimes` = each second with probability 1/2; `rarely` = 1/4; `random,N` = 1/N per second; `periodic,N` = every N s; `always` = loop; `runonce` = once on surface entry; `never`; `yen-e` = when `\e` runs; `talk,N` = every N characters drawn; `bind` = dress-up part; combinations like `bind+sometimes` [doc UKADOC:surf]. Tsubasa's blink: `animation0.interval,sometimes` on surface 0 |
| Talking mouth | SSP | `talk,N` intervals (Tsubasa: `animation200.interval,talk`) |
| Random talk timing | **SHIORI** | Satori on OnSecondChange (§5.2). SSP only provides the tick and cantalk |
| Hourly chime | SHIORI. Satori has no built-in chime; Tsubasa's own `＊OnMinuteChange` jumps to `＊（現在時）時（現在分）分` / `＊（現在分）分` sections (dic02_Event.txt) | it is lost if that minute's tick arrives as NOTIFY (cantalk=0); same in SSP. SSP also sends OnHourTimeSignal, which waits for cantalk [doc]. P1 |
| Return to the neutral face | SHIORI on **OnSurfaceRestore** (SSP sends it 30–51 s after a talk stops, EV §3.4) | Satori also prepends its "surface restore" string to talks [src Satori `surface_restore_string`] |
| Stroke / wheel / poke reactions | SHIORI (Satori counts OnMouseMove: **60** moves on one collision, session expires 2 s after the last move; the dictionary variables `なでられ反応回数` / `なでられ持続秒数` change 60 / 2; `トーク中のなでられ反応` allows strokes during talk) [src Satori `satori_load_dict.h`, `satori_builtin.cpp`, EventOperation] | the runtime must send OnMouseMove at about native mouse-move rate (§9.6) |
| Off-screen / overlap reactions | SHIORI, from OnSecondChange R1/R2 | §3.7 |
| Auto ghost change, mail check, headlines | SSP features | omit (P2) |

---

## 8. Ikagaka: architecture and lessons

### 8.1 What it was
"Ikagaka" (イカガカ, 2014–2018, Narazaka, duxca, legokichi) ran unmodified `.nar` ghosts in a browser. Demo: ikagaka.github.io/Ikagaka.demo.
The components (from the author's 2017 summary post and the repo READMEs):

| Layer | Library | How |
|---|---|---|
| Archive | NarLoader / Nar.js | JSZip in the browser; `.nar` = zip |
| Filesystem | NanikaStorage over **BrowserFS** (IndexedDB backend) | installed ghosts persisted in IndexedDB |
| SHIORI | **Emscripten builds**: `kawari.js`, `kawari7.js`, **`libsatori.js` (Satori)**, `yaya.js`, `aya5.js`, plus `*worker.js` variants | built from the ninix-aya-era portable sources with "a few patches" and an Emscripten Makefile |
| SHIORI glue | `nativeshiori` (memory and charset handling around the C `load/request/unload` API; `push(dir, files)` writes files into Emscripten FS, `pull(dir)` reads them back and unlinks; `load()` needs a **trailing `/`** on dirpath), `shiorif` + `shiori_converter` (SHIORI/2.x↔3.x), `ShioriJK` (protocol parser) | |
| Threading | **WebWorker** via `NativeShioriWorker` + `WorkerClientServer` + `single-file-worker` | the demo loaded the SHIORI in a worker; issues asked to also move unzip and encoding off the UI thread |
| Kernel | old: `Nanika` (one ghost) + `NanikaManager` (many); new (unfinished): `ghost-kernel.js` (event router), `ukagaka-timer-event-source.js` (setInterval ticks), `sakurascript` parser + `sakurascript-executer.js` (timed token emitter) | |
| Rendering | **cuttlebone** = Shell.js + Balloon.js + NamedManager.js | surfaces composed on **canvas** (color-key transparency, PNA alpha, overlays); layering, balloons and text in **DOM** (`div.blimpText` over a balloon canvas); a fixed container anchored bottom-right; jQuery-contextMenu for menus |

### 8.2 What it did not support
- **SAORI** (stubbed out: "the most requested feature"); **Misaka** (closed source); general-language SHIORIs.
- Many SakuraScript tags; GDI-specific balloon drawing (`cursor.blendmethod` raster ops); lenient surfaces.txt quirks that SSP accepts.
- Robust touch/mobile, SSTP, network update, owner-draw menu looks.

### 8.3 Pitfalls they hit, and what Sumika does instead
| Ikagaka problem (source) | Sumika's rule |
|---|---|
| Slow boot: copy IndexedDB → memory → Emscripten FS, then SHIORI init, then shell init, all serial (blog; Ikagaka.demo #1, #5) | load the SHIORI and the shell **in parallel**; fetch only the files needed (the JSON index); never pre-compose all surfaces |
| Unzip and SJIS decoding on the UI thread caused GC jank (Ikagaka.demo #2, #3) | decode dictionaries in the worker; decode images with `createImageBitmap` |
| Pre-composing every base surface at load doubled memory (Shell.js #30) | compose lazily, LRU-cache composed frames (Tsubasa: 923 PNG + 756 PNA) |
| Color-keying all images at load was very slow (cuttlebone #18) | key per element on first use; cache the keyed bitmap |
| Old surface's animation timers kept drawing on the new surface (Shell.js #1); blink started half-closed (Shell.js #52) | cancel all timers on surface change; compose each frame into a buffer, then blit |
| Transparent areas swallowed clicks; >2 stacked layers broke event pass-through (Shell.js #31, NamedManager.js #5) | per-pixel hit regions (§9.3) |
| Drag stopped outside the canvas; drag "stuck" (NamedManager.js #16, #30) | pointer capture |
| Positioning by `right` shifted characters when the surface width changed (NamedManager.js #17) | anchor at the base point (§3.2) |
| Balloon left behind the character after `\x` (NamedManager.js #10) | raise the balloon on text change |
| Mobile: menu wouldn't open, touch reactions dead, iPhone fired only mousedown, wrong coordinates under pinch-zoom (NamedManager.js #24, #26, #27, #31; Shell.js #56, #57) | Pointer Events with explicit long-press/double-tap logic (§9.6) |
| Talk felt ~2× faster than SSP (Shell.js #54) | 50 ms per character default (§4.7) |
| Uppercase element filenames vs lowercase files; split `surfaces*.txt`; elements without extension (cuttlebone #16, Shell.js #8, #20) | case-insensitive path lookup in the index; read `surface*.txt` files in name order |
| **"隣の羽山さんが下着姿"** (Tsubasa in underwear; Shell.js #49, no details recorded) | dress-up defaults: honor `bindgroup*.default` and Tsubasa's boot `\![bind,…]` sequence (her OnBoot binds `下着`/`首`/`お面`/`頬`); test the boot outfit against SSP screenshots |
| libsatori crashed on SAORI load; proposed fix was to comment out `satori_load_unload.cpp` ~L242 (libsatori.js #1) | Sumika's SAORI stand-ins (`src/worker/saori/`) must exist before load() |
| `<style scoped>` (dead spec) for isolation | Shadow DOM (§9.2) |

---

## 9. Browser-specific design

### 9.1 Layer structure — P0
```
<sumika-root>  (host; src/ui/root.js already creates it, z-index 2147483000)
  #shadow-root (open)
    <style> …all runtime CSS… </style>
    <div class="desk">                      position:fixed; inset:0; pointer-events:none; contain:layout style;
      <div class="char" data-scope="0">     position:absolute; left:0; top:0; transform:translate(x,y); pointer-events:none
        <canvas class="surface">            pointer-events:auto; clip-path:path(...)   (§9.3)
      <div class="balloon" data-scope="0">  pointer-events:auto (clip-path from balloon alpha)
      … one .char/.balloon per scope; z-order by DOM order or z-index within the shadow root
    <div class="overlay">                   menus, input boxes, dialogs (pointer-events:auto on children)
```
- **As built** (`src/ui/root.js`, `src/ui/layers.js`): there is no `.desk` or `.overlay` wrapper.
  Root level holds the shared stylesheets, the menus and the info window (`Z_BASE + 200`), the tooltip box
  (`Z_BASE + 199`, one for all ghosts, §4.8), the launcher dock (`Z_BASE + 190`), PageSaori's `fill_desktop` flash
  (`Z_BASE − 1`) and **one layer per ghost on screen**:
  `<div class="smk-ghost" data-ghost="<id>">`, `position: fixed; left: 0; top: 0; width: 0; height: 0; overflow:
  visible; z-index: Z_BASE + rank` (`GhostLayers`; rank 0 = bottom, by activation, §3.5). A layer holds its ghost's
  characters (`Stage` option `root`), balloons and input boxes (`Balloons` / `Dialogs` `root`), and a frozen tab's
  frozen stage. A positioned element with a z-index is a stacking context, so the z-indexes inside it (characters
  `Z_BASE` + scope order, balloons + 100, boxes + 200) stay local to the ghost: no balloon or box rises through another
  ghost's group, and every layer stays below the dock and the menus [decision].
  - No `pointer-events` on the layer: it is 0×0, and the characters, balloons and boxes set their own.
  - A capture `pointerdown` on the layer raises it, so a drag of a ghost that is not on top brings it forward first.
    That is z-order only: the Site sets no `GhostLayers.onRaise`. The site hears of a ghost's activation (`active`,
    the keys) only through the event loop's 'activate' (a press on its character or balloon, a link, a choice, a
    drop; §9.7), so a press in a ghost's own input box raises its layer and moves no keys.
  - A ghost change in a slot keeps the layer, its place in the stack and its rank, relabelled (`setGhost`); the new
    ghost's characters stand at their own places (§3.5), not where the old ghost's stood.
  - The event loop tells its own layer from another ghost's by the class `smk-ghost` (§9.7).
  - A Runtime without a layer (`layer` null: the implicit one-ghost site of the tests) mounts at root level.
- Append the host as the **last child of `<html>`** (not `<body>`) when possible, or watch it with a MutationObserver. Two reasons:
  `position:fixed` breaks if any ancestor has `transform`/`filter`/`contain`/`will-change: transform`, and SPA frameworks may replace `body` content [infer].
- Optional **top layer**: make the host `popover="manual"` and call `showPopover()`. It then renders above every z-index stack and escapes
  transformed ancestors. Reset the UA popover styles (`inset:0; margin:0; border:0; padding:0; background:transparent; width/height:100%; overflow:visible`).
  Caveats: page dialogs or popovers opened later stack above Sumika's, and an open modal `<dialog>` makes Sumika inert. P1, behind a flag.
- `@media print { sumika-root { display:none } }` in a document-level style.

### 9.2 CSS isolation — P0
- `:host { all: initial; }` cuts inherited properties (font, color, line-height, letter-spacing, direction, writing-mode, cursor, visibility).
  Re-declare `font-family`, `line-height: normal`, `-webkit-text-size-adjust: 100%` inside.
- Page selectors cannot reach into the shadow tree, but page **scripts** can: events bubble out retargeted to the host, and a page
  `click` listener that calls `preventDefault` or toggles modals may react. Sumika handles its events at the element
  and calls `stopPropagation()` on the ones it consumes (pointer, wheel over the character, keys while its input is
  focused).
- **`@font-face` declared inside a shadow root is ignored by Chromium** (long-standing bug); declare web fonts in a document-level `<style>`
  under a unique family name (e.g. `sumika-gothic`) [infer from known browser behavior; verify].

### 9.3 Hit testing on opaque pixels only — P0
SSP's character windows are layered windows: pixels with alpha 0 are click-through to the desktop [infer from Win32 layered-window
behavior]. Tsubasa's invisible 204×125 panel and 4×4 `\1` make this mandatory.

Recommended approach: **clip-path from the alpha mask**. It works for mouse, pen and touch, and gives correct cursors with no JS per move.
```
on surface composed (base + bind/always layers; ignore transient animation frames, or OR them in):
  mask = alpha > 0 per pixel (use the composed RGBA, after color-key/PNA)
  rects = for y in steps of 2 px: runs of opaque pixels → merge vertically identical runs
  path  = rects.map(r => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`).join('')   // nonzero fill = union
  canvas.style.clipPath = `path('${path}')`      // cache per (surfaceId, bindState, scale)
```
- Points outside a `clip-path` receive no pointer events in all current engines (CSS Masking). Update it only when the opaque shape
  changes, not every animation frame.
- Then do the exact test in the handler: map the event to image coordinates, look up the collision (`collision*`, `collisionex*`, animation
  collisions) for Reference4, and treat an alpha-0 pixel as "no collision".
- Alternative for mouse only: keep canvases at `pointer-events:none`, hit-test on `pointermove` at window capture, and switch
  `pointer-events:auto` while over an opaque pixel. This doesn't work for touch (there is no hover before pointerdown). Ikagaka re-dispatched events to `elementFromPoint`
  under the layer; synthetic events lose default actions (focus, selection, link activation details). Avoid it.
- Balloons: SSP balloon windows are also alpha-shaped. Use the same clip-path from the balloon image's alpha.

### 9.4 Mouse event mapping — P0
| DOM | SHIORI | References |
|---|---|---|
| `pointerdown` (button 0/2/1) | OnMouseDown | R0 x, R1 y (image-local, unscaled px), R2 0, R3 scope, R4 collision id or empty, R5 0 left / 1 right / 2 middle, R6 `mouse`/`touch`/`pen` [doc UKADOC:ev] |
| `pointerup` | OnMouseUp; if no script → OnMouseClick (left/right); middle/X buttons → OnMouseUpEx/OnMouseClickEx (R5 `middle`/`xbutton1`/`xbutton2`) | as above |
| 2nd press within the double-click time (500 ms, 4 px) | **OnMouseDoubleClick** in place of the second OnMouseDown (Win32 order) [infer]; no OnMouseClick for that release | R5 0/1 |
| move past 4 px with a button held | OnMouseDragStart, then OnMouseDragEnd at release | R5 button |
| move with the right button held (mouse; a pen's barrel) | **OnMouseGesture** per direction (4-px steps, the 4th step in a row names it), then OnMouseUp and OnMouseGesture `end` at release; no OnMouseMove meanwhile, no drag, and after a step no OnMouseClick and no menu (EV §4.5.1) [disasm] | R1 / R3 window-local `x\x01y`, R5 the name |
| `pointermove` over the character (no button) | **OnMouseMove**, coalesced to ≤ 1 per animation frame and only when the position changed; drop it if a SHIORI request is still in flight | R2 = 0 |
| `wheel` | OnMouseWheel | **R2 = ±120 per notch, positive = wheel up/away**. Normalize: `deltaMode` 0 → `-deltaY/100*120` (accumulate, emit in 120 steps); mode 1 → `-deltaY/3*120`. Tsubasa tests `R2>115 \|\| R2<-115` |
| `pointerenter/leave` | OnMouseEnter/OnMouseLeave (per collision change), OnMouseEnterAll/LeaveAll (window) | P2 |
| hover still 500 ms on a named collision, once per collision change | OnMouseHover, then the tooltip text (§4.8) [disasm] | implemented |
| right-click with no ghost reply | open menu (§2.5) | |
Always call `preventDefault()` on `contextmenu` over opaque pixels (suppresses the browser menu). Use `user-select:none` and `-webkit-user-drag:none` on the layer.

### 9.5 Page navigation, tabs, visibility — P0
- **No OnBoot/OnClose per page.** First visit (or after a user Close): boot normally (OnFirstBoot or OnBoot). Every later page load: restore silently.
  On a phone with `data-phone="tucked"` (§9.11) a start that would cold-boot the set in a tab shows the tucked button
  instead, before any channel or lock; its tap starts the set as a first visit would.
- Persist on `pagehide` and `visibilitychange→hidden` (both; `beforeunload`/`unload` are unreliable), plus every 30 s:
  - SHIORI files (Satori save data) — engine topic.
  - Per scope: surface id, position (§3.3), visibility, balloon id, alignment override, scaling, dress-up/bind state.
  - Ghost-lifetime state, i.e. everything UKADOC marks "valid until ghost exit": `alignmenttodesktop`, `scaling`, `alpha`, `zorder`, `sticky-window`,
    `balloonalign`, `onlinemode`, `windowstate stayontop`, `otherghosttalk`, `timerraise` timers (store **absolute due time** and repeat flag), `passivemode`,
    `inductionmode`, `selectmode`/`collisionmode` [doc UKADOC:ss, extracted by `scratch/sspui/lifetimes.py`]. Also minimized and closed flags, the boot timestamp
    (for OnSecondChange R0 uptime) and the last minute tick sent.
  - The **visible balloon snapshot**: per scope the rendered content model (text runs, choices with ids, images, cursor), scroll offset, remaining timeout,
    `\*`/choice-timeout flags. On the next page, re-render it **instantly** (no typing), so **choice menus survive link clicks**. If a script was mid-play,
    store the unexecuted remainder and resume it after the snapshot (skip already-executed side effects). Simpler fallback: render the text that was
    already shown and drop the rest [design choice; open question].
- `pageshow` with `persisted=true` (bfcache): JS state is intact. Just re-sync the clock: fire overdue timers and send no catch-up ticks.
- `document.hidden`: hidden tabs throttle timers (to 1/s, or 1/min after ~5 min in Chrome). While hidden: pause SERIKO and typing, send ticks as
  NOTIFY with cantalk=0, or pause ticks entirely [design choice]. Tsubasa's play-time counter then just undercounts.
- **Several tabs of the same site** must not run the same ghost twice (two SHIORI instances would overwrite each
  other's save data). Two kinds of Web Lock (`navigator.locks`; a `BroadcastChannel` fallback without them [infer]):
  - **one per ghost, `sumika:<id>`** (`GhostLock`): one engine per ghost per browser; it guards the ghost's save files
    (IndexedDB `ghost:<id>:files`). Taken before the ghost's engine starts, released after it unloads.
  - **the lead, `sumika/lead`** (`GhostLock('/lead')`: an id starting with `/` names `sumika/<rest>`, and no
    folder id starts with `/`): the tab that runs **the set**, every ghost on screen. Taken before the ghost locks,
    released after them; nobody waits for a ghost lock while holding them the other way round, so there is no
    deadlock [infer]. Without it two visible tabs could each run half the set, and the OnOther* events and
    `otherghostname` cannot cross tabs [infer].

  Only the lead tab runs engines. Another tab shows every ghost of the stored set **frozen** (drawn from its saved
  state: no balloons, no engine) and takes the **whole set** over when it becomes visible or gets the focus, or when a
  file is dropped on one of its ghosts (the drop reaches that ghost after the takeover), while the lead tab is hidden.
  It asks for the lead, waits for it, **reads the stored set again** (a call or a close made meanwhile is picked up),
  then takes every ghost lock and resumes every ghost at once. The lead tab yields when it is hidden: every ghost is
  suspended, saved, torn down and shown frozen, each ghost lock goes, then the lead. It never yields halfway: a
  takeover asked during a start, a call, a ghost change, a shell or balloon swap or a Quit is answered once the set has
  settled (after a Quit: closed) [decision]. **All or nothing**: a set never runs split across tabs. (A Runtime
  built without a site, as in the unit tests, keeps the per-ghost lock alone, with its per-ghost
  takeover.)

  **The set changes only in the tab that runs it** [decision; SSP is one process]. In a tab that shows the set frozen,
  waits for the lead, hands it over or restarts, the page API's `callGhost` and `changeGhost` resolve false: no ghost
  lock, nothing stored, no message. With no tab running the set and
  only the closed launcher here (Quit or the last Close in this tab), the tab takes the lead at once and the ghost
  boots cold (§2.6). A takeover asked during Quit waits for the goodbyes: the site closes, the lead goes, and the
  asking tab finds the closed launcher. So a Quit is not split while the quitting page stays open (known gap: a tab
  that takes the set over after the quitting page went resumes the goodbye ghosts standing, EV §2.7.3).

  A frozen ghost has one frozen stage and one set of listeners: `window.sumika.start()` called again keeps them (and
  does nothing while the set runs here), and a ghost removed while its frozen stage still loads (another tab closed
  it) leaves nothing behind. A bfcache restore (`pageshow` persisted) first lets every start, and every ghost change
  past its farewell, end; then it tears every ghost down and starts the set again, so a change interrupted after its
  farewell finishes in its own slot (EV §2.7.2).

  Known gap (transient): while the lead tab waits for a ghost lock that an old-code tab still holds, its
  Change ghost ▸, Call ghost ▸ and page-API calls and changes wait (and a Close behind them), and Quit is refused,
  until the old tab is hidden or closed.
- **The set** (EV §2.7): the ghosts on screen, in call order, are stored site-wide in the runtime prefs
  (`sumika:runtime`: `ghosts`, `ghost` = the first one for older code, and `rev`, +1 on every write). The tab's
  `sumika.session` marker lists the ghosts this tab runs (`ghosts`) and, per ghost, an event still owed (`carry`: a
  call or a change whose new ghost has not booted yet, or OnGhostCallComplete / OnOtherGhostChanged owed after its boot
  talk), so a page left mid-call finishes it on the next page, and `quit` while Quit says goodbye, so a page left
  then goes on with the Quit (EV §2.7.3). The site counts as closed only while every ghost of the stored set is closed
  (then the closed launcher shows, §2.6; a ghost a change or call was carried to counts as open and boots); a closed
  ghost in an open set is dropped at the next start [decision], except on a page that goes on with a Quit. A new tab
  cold-boots the stored set one ghost at a time in set order; the next page of the same tab resumes all its ghosts at
  once [decision].
- **Set messages** on the BroadcastChannel `sumika/runtime`: `{t:'set', ghosts, rev, from, cause}`, `cause`
  one of `{kind:'call', id}`, `{kind:'close', id}`, `{kind:'change', from, to}`, `{kind:'quit'}`, `{kind:'sync'}`. A
  tab ignores its own messages and any `rev` at or below the last one it applied. A frozen tab reconciles its frozen
  ghosts slot by slot: a ghost gone is cleared, one added appears frozen, one changed in place shows the new ghost
  frozen in the old one's place. A site close is not followed at once: the frozen tab finds the closed launcher at its
  next takeover attempt. An old-code tab's `{t:'ghost', id}` reads as a change of the first ghost.

  | Case | The other tab shows | It takes over |
  |---|---|---|
  | tab 1 runs X + Y, tab 2 opens | X and Y frozen | both, when tab 2 is visible and tab 1 hidden |
  | tab 1 calls Z while tab 2 is frozen | Z added, frozen | with the rest |
  | tab 1 closes Y (one of two) | Y removed | — |
  | tab 1 changes X → W | W frozen in X's place | with the rest |
  | tab 1 quits, or closes the last ghost | its frozen ghosts, until its next takeover attempt finds the closed launcher (a takeover asked during Quit's goodbyes waits for their end) | the launcher |
  | tab 2 (frozen) calls or changes a ghost through `window.sumika` | tab 1 runs on; nothing is stored or posted | — (the call resolves false) |
  | tab 1 is closed | nothing until its next visibility or focus: the lead is free | all, resumed |
  | nobody runs the set and a tab opens | — | it takes the lead and cold-boots the set |
  | an old-code tab holds `sumika:X` across a deploy | the new tab leads; X stays frozen there and asks for X with the per-ghost request; the old tab yields X when hidden (meanwhile the new tab's calls and changes wait and Quit is refused: known gap, above) | X alone, then the set is whole [decision; transient] |

- **A ghost change follows to every tab** (implemented, with several ghosts too): the switching tab takes the
  new ghost's lock before letting go of the old one, stores the set with the new ghost **in the old one's slot**, and
  posts `{t:'set', cause: {kind:'change', from, to}}` on `sumika/runtime` (an old-code tab posts `{t:'ghost', id}`).
  Every other tab then tears that slot's ghost down quietly (saved like a takeover; no OnClose, no OnGhostChanging) and
  shows the new ghost frozen in its place; it takes it over with the rest of the set when it becomes visible. So no
  ghost ever runs twice. The switching tab's `sumika.session` marker names the new ghost, so its next page resumes it; a
  page left before the new ghost got OnGhostChanged carries the change (`carry`; `pending` in the v1 fields while it is
  the first ghost), and the next page finishes it (EV §2.5). The switching tab never yields halfway through a change: a
  takeover asked for meanwhile (or due because the tab went hidden) is answered after it, for the new ghost.
- **A shell change follows to frozen tabs of the same ghost** (implemented, EV §2.6) [decision: a frozen tab does not
  follow surfaces or dress-up, but another character art would be too jarring]: the running tab posts `{t:'view', id}`
  on `sumika/runtime` after the swap, and a frozen tab draws the stage of the slot showing `id` again from the stored
  state (the new shell, its
  dress-up; `\0`/`\1` without a surface get their default ones). A message that arrives after a tab read the state but
  before its frozen stage was built is not lost: the stage is drawn again once it exists. A frozen tab opened while
  OnShellChanged has not decided the surfaces yet shows the surfaces from before the swap (`shellSwap`). Balloon
  changes need nothing (frozen tabs show no balloons). A takeover asked during a shell or balloon change, and a site
  message about another tab's ghost change, are answered after it and after the script changes queued behind it.
- Same-document navigation (SPA `pushState`): nothing to do; the runtime persists.

### 9.6 Touch and pen — P0 basic, P1 polish
- `touch-action: none` on the character canvases (inside the clip-path), so dragging a character never scrolls the page. Page scrolling elsewhere is untouched.
- Gestures: **tap** = left click; **double-tap** (≤ 300 ms, ≤ 20 px) = OnMouseDoubleClick (Tsubasa's main menu); **long-press** (≥ 500 ms, ≤ 10 px) =
  right click → menu; **drag**: starting on a named collision region = stroke (OnMouseMove stream, R6 `touch`); starting outside collisions,
  or after a long-press on a named collision, = move the character [design choice; Ikagaka lost stroke reactions on tablets: Shell.js #56].
  **Long-press on a spot with no named collision, then a move of 10 px or more** = a right drag, so mouse gestures
  (EV §4.5.1): OnMouseUp(R5 0), OnMouseDown(R5 1) at the press point, OnMouseGesture …, OnMouseUp(R5 1), `end`, no
  menu [decision; a plain drag there moves the character].
  SSP's own touch wheel stand-in comes with it: an `up` / `down` gesture that gets no Value sends 3 × OnMouseWheel
  (±120) at the press point, then one per further step of that run [disasm OnEXMouseMove 0x417f5c–0x41802c; doc
  UKADOC:ev]. SSP itself has no two-finger swipe for the wheel: with two fingers it drags the window (OnCWTouch
  0x41bdd0) [disasm]; Sumika has no two-finger input yet: a second finger is ignored while the first one presses
  (§9.11 F1).
- Prevent the 300 ms tap delay and double-tap zoom on the character via `touch-action`. The page's viewport meta is not Sumika's to change.
- Phones: §9.11 (the characters fitted to the screen, a balloon above her head when neither side fits, the boxes above
  the keyboard).
- No hover on touch: no choice hover events and no tooltips (§4.8) [decision]. A pen that hovers counts as a mouse.
- The menu a long press opens has rows of at least 24 CSS px; SSP's device-pixel rows (§2.3) are about 13 CSS px on a
  phone, which a finger cannot hit reliably. A mouse or pen gets SSP's rows [decision] (§2.3 "Opened by
  a touch").

### 9.7 Keyboard: OnKeyPress — P0
- SSP sends keys only while the ghost window is **active** [doc UKADOC:ev]. Browser: active after a pointerdown on a character or balloon, until a pointerdown
  elsewhere, focus moving into a page field, or Esc. Listen on `window` (capture). Ignore events whose target is an editable element (`input`, `textarea`,
  `select`, `[contenteditable]`) or that have Ctrl/Meta held (browser shortcuts).
- **Several ghosts**: **one ghost at most is active**, and only it gets OnKeyPress [doc OnKeyPress
  「本体がアクティブな状態で」; infer for several: the focused window decides].
  - A ghost becomes active on a press on its character or balloon, a link or choice in its balloon, or a file dropped
    on it; every other ghost becomes inactive at once (the event loop reports `'activate'`, the site deactivates the
    others). A press inside **another ghost's layer** (`.smk-ghost`, §9.1) makes a ghost inactive, as a press outside
    the runtime, focus moving into a page field, and Escape do.
  - A press in a ghost's own input box, menu or the info window changes nothing: keys typed there are never a ghost's.
  - A called ghost takes the keys **only if its caller had them** [decision: SSP always activates the new ghost
    (`AddGhost` → `ActivateAllWindow`) [disasm], but an active ghost here calls `preventDefault` on the page's keys, so
    one must never take them unasked].
  - Page calls that name no ghost (`window.sumika`) go to the **preferred** ghost: the active one, else the first of
    the set (SSP's `GetPreferredActiveGhost`: the talk-priority ghost, else the first booted [disasm]).
  - Not yet compared with ssp.exe on screen: click one ghost and press a key: does only that ghost answer? After a call, do
    keys go to the new ghost without a click? [infer; disasm `ActivateAllWindow`]
- References: R0 key name, R1 Win32 virtual-key code, R2 repeat count (SSP), R3 character window id (SSP), R4 modifiers `ctrl,alt,shift` (SSP) [doc UKADOC:ev].
- Key names (from ninix keymap.rb, which mirrors SSP): letters `a`–`z` (lowercase), digits `0`–`9`, `back`, `tab`, `clear`, `return`, `pause`, `escape`,
  `space`, `prior`, `next`, `end`, `home`, `left`, `up`, `right`, `down`, `delete`, `f1`–`f24`, keypad `*`,`+`,`-`,`/`; other printable characters as themselves.
  Tsubasa uses `a b c d e f g m o r s t v w x z`, `space`, `up`, `down`, `back`, `,` (dic02_Event.txt `＊OnKeyPress`; the typing game
  reads any character, and her code treats R2 < 2 as "not auto-repeat").
- Mapping: `KeyboardEvent.key` → name table above; `keyCode` (deprecated but present) → R1; `e.repeat` → R2 counter.

### 9.8 Fonts — P0
- SSP's default balloon font is **ＭＳ ゴシック (MS Gothic)** at `font.height` 12 **px** (pixels, not points) [doc UKADOC:balloon]. LightBlue sets height 12 and no font name.
  MS Gothic is fixed-width: ASCII = ½ em, CJK = 1 em. Tsubasa's menus align labels over images with runs of full-width spaces `　` and `\_l[@…]`
  (e.g. `\_l[@0,@-16]　　　　　　　　　　　  Sure`). **Glyph widths affect layout**: a proportional font misplaces every menu label.
- Stack: `"MS Gothic","ＭＳ ゴシック","Osaka-Mono","BIZ UDGothic","Noto Sans Mono CJK JP",monospace`, with a self-hosted **BIZ UDGothic**
  (SIL OFL, fixed-width like MS Gothic) as the web fallback, subset with `unicode-range`, `font-display: swap`. Load it only if the local fonts are missing:
  the browser fetches a web font only when the family is actually used.
- Honor `font.name` lists (comma-separated, SSP picks the first installed) and font files inside the balloon folder (SSP only) [doc UKADOC:balloon].
- Set `font-kerning:none; font-variant-ligatures:none; letter-spacing:0; line-height:<font.height+N>px` explicitly; measure wrapping with the
  same font the balloon draws with.

### 9.9 Scale and pixels — P1
- SSP 2.9 runs DPI-aware ("Enable high DPI awareness" [res dialog 103]); its scaling percentages are screen pixels, and
  on a 125 % display its default is 125 % (§2.9) [observed].
- Default: 1 image px = 1 CSS px, so the ghost scales with page zoom like page content; that is SSP's "match the display".
  Shell scaling ▸ / Balloon scaling ▸ (§2.9) offer device-pixel sizes: p % = CSS `(p/100)/dpr`, and 100 % is one image
  pixel per device pixel (crisp art). Implemented.
  `\![set,scaling,x,y]` multiplies on top, and negative values mirror (Tsubasa uses -100,100). Balloons scale with the shell only if `balloon.syncscale` or the user setting says so [doc UKADOC:ghost] (not implemented: balloon scaling is its own setting here).
- The right-click menu is the exception: ssp.exe draws it in device pixels, only its font following the display, and
  blits its images 1:1 (§2.3) [disasm], so its lengths and images are n / dpr CSS px.
- Canvases are drawn at device resolution: a balloon canvas's backing store is image px × dpr × balloon scale, its CSS
  size image px (the click-wait marker included), redrawn
  at once when devicePixelRatio changes. Character canvases keep an image-px backing store and a CSS matrix; they are
  `image-rendering: pixelated` whenever each image pixel covers whole device pixels, so 100 % is pixel-exact even at a
  fractional device position (§2.9).
- Pinch-zoom on mobile scales `position:fixed` content with the page; accept this. Hit-testing uses `getBoundingClientRect`, so it stays correct.

### 9.10 Things SSP does that Sumika deliberately does not imitate
Network update, uninstall from disk, SSTP server, mail/headline/calendar/plugins, OS shutdown events, wallpaper changes (`\![set,wallpaper]`: 12 Tsubasa
responses; ignore it, or behind an opt-in let it set a page background), `\![open,mailer]` (ignore), `\![open,browser,url]` (allow, but only on
http(s) and in a new tab with `noopener`; 1 Tsubasa use).

### 9.11 Phones (Sumika's own) — P1

On a phone, by default [decision]: (1) the characters start smaller, to fit; (2) a balloon with no room beside its
character goes above her head; (3) the text boxes stay above the on-screen keyboard. A visitor's own Shell scaling ▸ /
Balloon scaling ▸ pick wins. (4) is a page setting, `data-phone="tucked"`, and `data-phone="off"` is the give-up
switch, for a site that would rather show no ghost on phones. Without these rules, at 375 px Tsubasa stood half off
the left edge with her balloon over most of the page [measured].

SSP has no phone, so every rule below is Sumika's own: a [decision] unless tagged otherwise. Browser facts that only
a real phone settles are tagged [verify] (the list at the end). **Desktop is unchanged**: every phone path sits behind
one `phone` option that the components get only on a phone (`Stage`, `Balloons`, `Dialogs`, `UserScaling`,
`SettingsWindow`, `Launcher`); made without it, each is exactly what it was (no listener, no inline style, no probe
element), and the tests pin that at 1280×720 and 1920×1080 with dpr 1–3.

**Detection** [decision] (`src/core/phone.js` `phoneInfo(win)`): one test for "a phone" (`data-phone`) and "a small
screen" (items 1–3), made once when `sumika.js` runs, before the Site is built:

```
phone  ⇔  matchMedia('(pointer: coarse)').matches === true  &&  min(screen.width, screen.height) < 600   (PHONE_SHORT_MAX)
```

- `(pointer: coarse)` is the **primary** pointer: every window driven by a mouse or a touchpad (every desktop, a
  touchscreen laptop, a Windows tablet with its keyboard cover) answers `fine`, whatever its size, devicePixelRatio
  or zoom. `(hover: none)` is not used: some Android browsers answer `hover: hover` wrongly [verify].
- `screen`'s sides (CSS px) do not change with the window; `min`/`max` make them orientation-free (iOS always reports
  portrait, Android swaps them). 600 is Android's tablet line (`sw600dp`): phones are 320–440, an iPad mini 744, a
  Fold unfolded about 673. A 1080p screen at 200 % (960×540) passes the size test; the pointer test still fails.
- No page width, `innerWidth` or dpr enters the test, so a narrowed desktop window stays desktop, and a page without
  a viewport meta is still detected (the meta is not Sumika's, §9.6). `matchMedia` missing, throwing or without
  `matches === true`, or `screen` missing or zero: not a phone.
- **Tablets** (short side ≥ 600) get desktop behaviour, also in a narrow window (iPad Slide Over or Split View, Android
  split screen, a Fold folded or unfolded after load): such a window is a narrowed desktop window, where Tsubasa at
  full size may not fit, as in any narrow desktop window. The window is not used so that `data-phone="tucked"` and the
  off switch apply per device and never change from one page to the next.
- It is never evaluated again during the page: no rotation, resize, URL-bar move, keyboard or attached mouse changes
  it. The next page decides again.
- The result is `{short, long, mobileView}` (CSS px) or null. **`mobileView`**: the page has a mobile viewport, so its
  layout width is the screen's in the orientation it was loaded in (`across = clientWidth > clientHeight ? long :
  short; mobileView = clientWidth <= across + 2`, read once at load). A page without `<meta name="viewport"
  content="width=device-width…">` lays out at about 980 px and the browser already shrinks it: it gets no fit, no
  balloon fit and no box width change (those three read this flag only), and keeps desktop sizes. 980 > 962, the
  longest phone side, in both orientations; an iPhone's notch letterbox (724 ≤ 814) is still a mobile view. A script
  tag in `<head>` without `defer` could run before the meta is read: docs/guide.md "Phones" asks for `defer` [verify
  that `defer` sees the meta in Safari and Chrome].
- **`?sumika-phone`** in the page URL forces the phone path, `?sumika-phone=0` forces it off (read only in phone.js,
  next to `?sumika-debug`). Forced, the sides are the **window's** at load (`min/max(innerWidth, innerHeight)`) and it
  counts as a mobile view: a desktop window made phone-sized previews items 1–3; a full-size one shows the tucked
  button, the off switch and the keyboard code but no visible fit. A forced tab is an ordinary tab of the origin
  (picks, places and balloon offsets it stores reach the desktop tabs; the fit itself is never stored), so previews
  belong on a scratch site on its own port. A desktop browser's mobile emulation may not emulate `(pointer: coarse)`
  [verify].

**The script tag** (main.js) [decision]:

| `data-phone` | On a phone | Elsewhere |
|---|---|---|
| absent, `on` or empty | items 1–3 | the desktop behaviour |
| `tucked` | item 4 | ignored |
| `off` | Sumika does nothing (the give-up switch) | ignored |
| any other value | as absent, one warn | ignored |

Values are trimmed and read in any case. A desktop page never reads `data-phone` (so it never warns about it). `window.sumika.phone` tells the page which applies: `null` when the device is no phone, else
`'on'`, `'tucked'` or `'off'`.

**Off** [decision] (`offApi(version)` in phone.js; it also stands for the visitor's Off and
`data-default-state="off"`, with `state: 'off'` and a `reason`): nothing of the Site is made, so there is no `ghosts.json` fetch,
no `<sumika-root>` or style, no BroadcastChannel, Web Lock, localStorage (not even `sumika:__probe`), sessionStorage
or IndexedDB access, no worker and no page listener. Only `sumika.js` itself is downloaded and evaluated. For page
code that calls it, `window.sumika` is a frozen inert stub: `{version, phone: 'off', state: 'off', reason: 'phone',
site: null, runtime: null}` (the visitor's or the site's Off: `phone` as on that device, `reason` `'visitor'` / `'site'`),
`start()` → `'none'`, `ghosts()` / `running()` / `shells()` → `[]`, `balloons()` → `{top: [], all: []}`, and
`callGhost`, `closeGhost`, `quit`, `changeGhost`, `changeShell`, `changeBalloon` → `false`. **`runtime` and `site`
null are the one exception** to "window.sumika.runtime is never null" (CONTRACTS "Site"): a stand-in Runtime would be
a half object page code could misuse; `window.sumika.phone === 'off'` tells the cases apart. `data-autostart` does not
matter then. What off still costs is the `sumika.js` download, measured with the project's esbuild settings
on the source with the phone code (an in-memory bundle, no source-map line): unminified 1,159,352 bytes (gzip −9
318,396, brotli 252,423), minified (`npm run build:min`, same name) 562,264 (184,411 / 154,700); the same source
before the phone code gave 1,132,796 (310,492 / 246,454) and 551,141 (180,664 / 151,411) [measured]. Which build a site
publishes is the site's choice.

**Tucked** [decision] (Site `_tuckedStart`, `_showTucked`, `_untuck`): on a phone with `data-phone="tucked"`, a set
start that would **cold-boot the stored set in this tab** shows one launcher button for the set's first ghost instead,
and runs nothing; a tap starts the set exactly as a first visit would. It is decided after the index loads and before
the site channel and the lead lock, so a tucked tab opens no channel, takes no lock and races no other tab. The
same path serves `data-default-state="tucked"` on every device [decision] (a desktop gets the launcher's
desktop layout: no `phone` option), unless the visitor chose On on the control page (core/choice.js); a phone's
`data-phone="tucked"` stays under On. The Site takes `tucked` as main.js decided it (not masked by `phone`).

| Situation | What shows |
|---|---|
| A first visit in a new tab (no marker) | the tucked button |
| The next page of a tab where she was brought out (the marker lists her) | she resumes, as on any page |
| The next page of a tab still tucked (never tapped) | the tucked button (no marker was written) |
| A new tab while another tab has her out | the tucked button; a tap hides it, shows the set frozen here and asks for it (§9.5): the other tab, once hidden, lets it go and she resumes here (no OnBoot). With both tabs visible (Android split screen): frozen, as two desktop windows side by side. A tucked tab never shows another tab's ghosts frozen before the tap |
| After Quit or Close of the last ghost (any tab) | "Call X", on every page and tab: Quit is remembered site-wide, as without tucked |
| Quit or the last Close in another tab while this one shows the tucked button | the button stays "Show X" (a tucked tab hears no set message); one tap brings the set back cold (OnBoot), as "Call X" would, never "Show X" turning into "Call X" |
| A Quit carried by the marker (a page left mid-goodbye) | the goodbye goes on |
| Several ghosts stored | one button for the first; a tap brings the whole set, cold, one at a time, as the closed launcher |
| `data-autostart="0"` | nothing until `window.sumika.start()`, then the button |
| `start()` again while tucked; a bfcache `pageshow` | the button again (`'launcher'`), unless she was brought out meanwhile |

- **What a tucked tab does**: downloads `sumika.js`, `ghosts.json` and the icon; writes `sumika:__probe` (the Site
  constructor's storage probe); reads the prefs, the marker and the ghost states. No prefs, marker, state or IndexedDB
  write, no channel, lock, worker, engine, shell or balloon image; pagehide saves nothing. So she is quiet: no
  OnSecondChange, timer, web request or FMO.
- **The button**: the launcher in mode `'tucked'`, labelled "Show X" / "Xを表示" (`launcher.show`), in colour, with
  Iconify's icon (`iconMinimize`, else `icon`, else her initial letter, §2.6), in the dock's corner (bottom-right 16 px).
- **Safe area** (phones only): every launcher on a phone (`Launcher` option `phone`: minimized and closed buttons too)
  stands at `bottom: calc(<launcherBottom(i)>px + env(safe-area-inset-bottom, 0px))` and `right: calc(16px +
  env(safe-area-inset-right, 0px))`, clear of the iPhone's home indicator and rounded corner on a page with
  `viewport-fit=cover` (else the insets are 0). Desktop keeps `bottom: 16px` and CSS `right: 16px`.
- **The tap** (`Runtime._launch('tucked')` → `Site._untuck`): the button stays, dimmed and busy (`Launcher.setBusy`:
  `smk-busy`, `aria-busy`, a click while busy does nothing), through the engine download until her boot hides it
  right before OnBoot (the characters are veiled meanwhile). `start({untuck: true})` keeps `_runSet`'s rules: ghosts
  never met get OnFirstBoot, the others OnBoot, one at a time in set order; a set closed meanwhile in another tab
  starts cold, as the closed launcher's tap. The tucked time is never told to the ghost: `bootEpochMs` and the tab's
  `sessionEpochMs` start at the tap. If the set shows frozen here (another tab runs it), the button goes; if nothing
  runs (every boot failed), the tucked button comes back, not busy, the lead let go, the marker (and carries) the
  failed boots wrote cleared, so the next page of the tab is tucked again, and the site channel the start opened
  closed again, so the tab hears no other tab's set until the next tap.
- **The page API while tucked** (the closed launcher's rules, pinned for "Call X"): `running()` → `[]`, `ghosts()`
  rows `running: false`, `runtime` → the tucked slot (no parts); `callGhost(id)` / `changeGhost(id)` → that ghost
  alone, cold, in the button's place, the stored set becomes `[id]` (EV §2.7.1, §2.6); a failed call or change puts
  the **tucked** button back with the old set stored, the marker cleared, the lead let go and the site channel closed
  again (never "Call X", never a boot of the tucked ghost, never another tab's ghosts frozen here before a tap); `closeGhost`, `quit`, `changeShell`, `changeBalloon` → `false`; `start()` →
  `'launcher'`. `_shut` counts the tucked slot only while nothing of it is shown frozen here, so `onScreen()` and the
  cap never leave out a ghost on screen.
- **Background tabs** [verify]: a takeover needs the hidden tab's script to answer (§9.5), on phones in general, not
  only tucked pages. If a phone browser pauses a hidden tab so that the new tab waits until the visitor visits the old
  one, the rule to decide then (not built before it is seen, since it costs a resume each time the visitor returns to
  a tab): on phones, the tab that runs the set yields it as soon as it is hidden (`_yieldAll` from
  `visibilitychange`, as `_yieldWhenHidden` already does after a request) and wakes like a frozen tab when visible.

**Item 1: the fit** [decision] (`src/shell/layout.js` `phoneFit(sizes, phone, dpr)`, `FIT = {margin: 8, tallLong:
0.4, bars: 112, min: 0.4}`): the phone default of Shell scaling ▸, in CSS px per image px:

```
W = w0 + w1,  H = max(h0, h1)        base rects of the shell's default surfaces of \0 and \1 (image px; \1 missing: 0)
kW = (short − 2·8) / W               \0 and \1 side by side across the portrait width
kH = min(0.4 · long, short − 112) / H   room above her head in portrait; whole in landscape
k  = min(1, kW, max(0.4, kH))        never enlarged; the 0.4 floor on the height only, never beating the width
percent = floor(k · dpr · 100)       a whole SSP percentage (device px); scale = percent / (100 · dpr)
```

- The default surfaces of the shell being loaded, never the stored or current ones (those change on every page).
  Scopes 2+ get the same factor. An image size the stage cannot know synchronously means no fit [decision].
- 8 px margin each side; at most 40 % of the long side tall (room for a balloon above her head); at most the short
  side minus 112 px, so she stands whole in landscape (Android's short side also holds the status bar, about 24, the
  toolbar, about 56, and the gesture bar, up to 32) [verify the landscape bars on a real phone]. The floor of 0.4
  keeps tap areas and thin lines usable; a very wide pair still fits across.
- **The floor beats landscape** for the two tallest site shells [accepted]: bthver.5 master (645 px) and dslgs (698 px)
  stand 258 and 279 px tall at 360×800, where landscape leaves about 248–280 px: up to about 31 px of the head may be
  under the browser bar in landscape; portrait is whole. The visitor's pick goes below the floor.
- Rounded **down** to a whole percentage, no snapping to the menu's steps (that loses up to 20 % at dpr 2); a fit that
  is not a whole number of device px per image px is drawn smoothed, as any odd percentage on a 125 % desktop. Only
  `screen`'s sides enter, so portrait and landscape loads give the same fit; no mobile view: no fit.

| ghost / shell | 375×812 dpr 2 | 360×800 dpr 3 | 320×568 dpr 2 | 430×932 dpr 3 |
|---|---|---|---|---|
| tsubasa 220×380 | 138 % → `\0` 152×262 | 195 % → 143×247 | 109 % → 120×207 | 251 % → 184×318 |
| emily4 253×385 + 255×161 | 136 % → 172×262, both 345 wide | 193 % | 108 % | 244 % |
| bthver.5 master 348×645 | 81 % → 141×261 | 120 % (floor) → 139×258 | 80 % (floor) | 147 % |
| dslgs 475×698 | 80 % (floor) → 190×279 | 120 % (floor) → 190×279 | 80 % (floor) | 136 % |
| mayura 471×460 + 148×128 | 114 % → 268×262 | 161 % | 90 % | 200 % |
| katari loligatari | 164 % | 232 % | 130 % | 298 % |
| nato 150×300 | 175 % | 248 % | 138 % | 300 % (= display, no fit) |
| roommate master / masterx1.5 | 138 % / 92 %, both about 186×262 | | | |

(Headless sizes. A height-only formula, `min(1, 0.45 · desk.h / tallestSurfaceH)`, gives Tsubasa 0.96 at 812 px and
ignores the width: her `\1` and emily4's stand half off the left edge.)

- **Where**: the `Stage` computes it at its creation (`phone` option, `fitScale`) and starts at it unless a pick is
  passed (`scale`). Boot, the frozen stage and a shell swap or `\![reload,shell]` pass `phone`, plus `scale` only for
  a stored pick. Never on resize, rotation, URL-bar or keyboard resizes: the inputs are fixed for one shell, so there
  is no jitter and no listener. A dpr change keeps the CSS factor (the menu's percentage follows the dpr).
- **Per shell**: the fit is the default of the shell in use, computed again for each shell (roommate's masterx1.5
  shows about as large as master); a picked percentage keeps the visitor's size across shells, as on a desktop. So **the
  percentage in effect can change during a page without an event**: a shell change fits the new shell, a balloon
  change refits the balloon (`UserScaling.refit()`), and with no pick `currentghost.scope(N).scaling` follows.
  OnShellScaling / OnBalloonScaling go only with the visitor's picks, as on a desktop: none at boot, none for the fit,
  none for a dpr change, which already changes the no-pick percentage silently on desktop (§2.9 "Events"). One fit for
  the whole page would only move the size jump to the next link.
- **UserScaling** (`phone` option): with no pick the fit is the percentage in effect (`info().fit {shell, balloon}`;
  `set` and `askOther` start from it: a pick of 200 at a 138 fit sends OnShellScaling [200, 138, 200, 138], Default
  [138, 200, 138, 200]); a stored pick always wins; the fit is never stored (`scaling` stays null, Default stays
  greyed). The menu shows the fit's row with the bullet and Default as "Default (fit to screen)" / 「標準(画面に合わせる)」
  (`menu.scale.defaultPhone`). `currentghost.scope(N).scaling` reports the fit (138 at dpr 2), meaning what SSP's does.
- **Several ghosts**: each fits alone and stands where SSP places it alone (`defaultPlace`: every `\0` on the right
  edge; §3.5: no ghost moves another). Two wide ghosts on a phone cover each other, as several ghosts do on a small
  desktop window; the visitor can drag one aside or pick a smaller scaling. Dividing the width by the number of
  ghosts was not taken: the number changes during the page, and a ghost called later would be smaller than the first.
- Placement code is unchanged: default places, Reset shell position and `\![set,scaling]` already read
  `stage.scale`; stored positions are ratios of the desk, independent of the scale.

**The phone desk follows the browser bar** [decision] [verify on a real phone]: `documentElement.clientHeight`
is the viewport with the browser's bars shown on Chrome Android and iOS Safari, also while a scroll hides them, but
`position: fixed` content (the `<sumika-root>` host the characters are placed in, the launcher) follows the real
visible bottom: she would stand about 56 px above it with page content under her feet. On a phone `Stage.desk()`
reads a `position:fixed; inset:0` probe element in the shadow root instead (the fixed containing block: the host has
no transform), and `Balloons` takes its viewport from `stage.desk()`. The existing `resize` listeners lay her out
again when the bar moves (a window `resize` fires as `innerHeight` changes [verify]); her stored ratio keeps her feet
on the bottom. Desktop: no probe element, documentElement's `clientWidth/clientHeight`.

**Item 2: balloons** [decision] (`src/balloon/placement.js`):

- **Above her head when neither side fits**: `placeBalloon`'s `overhead` (passed by a `Balloons` made with `phone`).
  In the automatic side rule (no fixed alignment, no `windowposition.x` top/bottom), after SSP's flip: when the
  balloon is cut off on the left **and** on the right, it goes `top`, centred over her (`S.x + S.width/2 − B.w/2`,
  `S.y − B.h`). When one side fits, SSP's rule runs unchanged (landscape usually fits beside her). Without `overhead`
  the function is the desktop's, keeping the side and clamping (a narrow desktop window, Balloon scaling 300 %).
- The shell's `balloon.offsetx/y` are tuned for beside-placement (bthver.5's 250 / −150) and are left out there;
  `windowposition.x` (a number) and `.y` and the visitor's drag offset still add, and `limit` keeps it inside the
  viewport. With no room above her head (`S.y − B.h < 0`) the clamp puts it at y 0, over the top of her head: item 1
  leaves 170-px balloons room on every phone above; a 384-px `\b[2]` still fits at 375×812 (y about 14) but overlaps
  her by about 130 px at 320×568 [accepted]. Never `bottom`: she stands on the bottom edge.
- It is drawn with the left image (as `top` always was) and `top` is never stored as the side, so the saved side
  survives and a rotation to landscape goes back beside her. Fixed alignments (the shell's `balloon.alignment`,
  `\![set,balloonalign]`, `windowposition` top/bottom) are obeyed as written: a script asked for them; no site shell
  sets one. `\0` and `\1` are placed each alone: both may go above their heads and overlap; the one talking is raised,
  as on a desktop (no stacking). A drag offset is stored relative to the overhead place (`_drag` spreads the same
  input); after a rotation the same offset applies beside her, clamped [accepted]. Choices and anchors hit where they
  are drawn at any scale.
- Example (375×812, dpr 2, a 375×660 desk): Tsubasa at 138 % is 151.8×262.2 at x 223.2, top 397.8; `\b[0]` (340×170)
  fits neither left (x about −117) nor right (x 375, right edge 715); above her head: centred at x 129.1, clamped to
  375 − 340 = 35, y 397.8 − 170 = 227.8 (228 after rounding).
- **The balloon fit** (`balloonFit(skin, phone)`, `READABLE_PX = 11`): the phone default of Balloon scaling ▸, the
  widest balloon image (`balloons*`, `balloonk*`, `balloonp*`; not the input box) within the short side, its font
  never below 11 CSS px (Apple's smallest text size) unless the screen itself is narrower, never enlarged:
  `min(1, short / w, max((short − 16) / w, 11 / font.height))`. The whole balloon scales (the `BalloonView`
  transform), never a glyph alone, so Tsubasa's `\f[height,3]` spacing stays. LightBlue (340 px, 12-px font), sumika,
  emily4, wiz and convulsions: 1 at 360–430 px; angel_ladder (389 px, 14 px): 0.923 at 375 (12.9-px text); at 320 px
  LightBlue goes to 0.917 (11 px). **The screen beats the floor**: on a screen narrower than the floor allows the
  balloon is as wide as the screen and its text goes below 11 px (the Galaxy Fold cover screen, 280×653: LightBlue
  0.824, 9.9-px text; angel_ladder 0.720, 10.1 px). Text cut off by the edge cannot be read at all; small text still
  can. No phone of 320 px or more is affected. No mobile view: 1. A visitor's Balloon scaling pick wins, with no
  floor. `Balloons` computes `fitScale` at its creation and again in `setSkin`; the runtime applies a new one after a
  balloon change (`UserScaling.refit()`) when there is no pick. Input and communicate boxes do not follow Balloon
  scaling (as on a desktop); item 3 sizes them.

**Item 3: the keyboard** [decision] (`src/ui/viewport.js`: `visibleRect`, `zoomed`, `keepVisible`, `watchVisible`):

- The visible rectangle is `visualViewport`'s (`offsetLeft/Top`, `width`, `height`, `scale`), relative to the layout
  viewport, which is where the boxes live (never `pageTop`); without `visualViewport`, the layout viewport.
- **Vertical only, and nothing while zoomed**: `visualViewport`'s `resize`/`scroll` also fire on pinch zoom and on every
  pan while zoomed. At 2× on a 375-px phone the visible width is about 187 px: a horizontal "keep visible" would pin
  a 340-px box's left edge on every pan, and OK and × at its right end could never be reached. So boxes move only up
  or down (the keyboard takes height, never width), and while the scale is off 1 by more than 0.01 no box moves: each
  keeps its last shift until the visitor zooms back to 1. If iOS still zooms into a field, the browser pans to it
  itself.
- **Input, communicate and teach boxes** (`Dialogs` option `phone`): (1) a `balloonc*` wider than the phone shrinks to
  `min(1, (short − 8) / boxW)` in a mobile view (emily4's and wiz's 400-px boxes on 360–390-px phones keep OK and ×
  on screen; the others stay 1); without a mobile view `boxScale` as on a desktop. (2) No iOS zoom on focus: iOS zooms
  into a focused field whose font is under 16 px [verify]; on a phone the field gets `font-size: 16px`, its size × 16/fh
  and `transform: scale(fh/16)`, so it looks as an fh-px field and computes 16 px [verify on an iPhone that the scaled
  field does not zoom]. Changing the page's viewport meta is not Sumika's job. (3) Above the keyboard: from the first
  box's open, the **focused** box is shifted by `translate: 0px <dy>px` so that it lies inside the visible rectangle,
  8 px in, its top edge winning; every other box goes back home (`translate: ''`). `left/top` stay the box's home (drags
  and rebuilds read them), `transform` stays the box scale's. The watch ends when the last box settles and at destroy; a
  drag first folds the shift into `left/top`. Placement at open stays `placeBox` with the current viewport. The CSS
  `translate` property came in Safari 14.1 (iOS 14.5), Chrome 104 and Firefox 72 [verify]: an older browser ignores
  it, so there a box is never shifted (it may stay under the keyboard) and everything else works.
- **The Preferences box** (`SettingsWindow` option `phone`): its inputs get `font-size: 16px` (the box is 13 px); while
  it is open its `top` is the visible rectangle's middle (the CSS `translate(-50%, -50%)` centres it) and its
  `max-height` the visible height − 16 (at least 120), `left` staying the CSS 50 % (the keyboard takes no width); the
  focused field is scrolled into view inside the box (by `scrollTop`, never `scrollIntoView`, which would scroll the
  page). The focus stays on Name at open: the menu tap raises the keyboard at once and the box moves above it.
- Browsers: on iOS Safari (every iOS browser) the keyboard never resizes the layout viewport; `visualViewport` shrinks
  and Safari pans it toward the field; fixed content stays put; the shift, computed from the box's home each time,
  settles with Safari's own pan. `focus()` outside a user gesture raises no keyboard there: a box a script opens gets
  it when the visitor taps the field. Chrome Android ≥ 108 (`interactive-widget=resizes-visual`) behaves the same,
  with no window `resize` [verify]. Older Chrome, `resizes-content` pages and Firefox Android shrink the layout
  viewport and fire `resize` [verify]: the characters lay out again higher and an open menu closes [accepted].

**Touch fixes** (each phone-only or out of a mouse's reach; F1, F4 and F5 key on touch input, not on `phone`, so a
touchscreen laptop's touch gets them while its mouse and touchpad keep the desktop behaviour):

- **F1** [decision] (character.js): a second finger on a character does not take over the first finger's press (its
  moves would move her to it, its lifting would end the drag): while a press is held, the events of another `pointerId`
  (down, move, up, cancel, lost capture) are not the ghost's, and the first finger's drag ends normally. With no press
  held every pointer is taken, so a press that ended without an up never blocks the next touch; events without a
  numeric `pointerId` are always taken. The second finger's press on her is still kept from the page. A mouse has
  one pointer id: not affected. SSP drags the window with two fingers (OnCWTouch, §9.6): not done.
- **F2** (menu.js): `.smk-menu` gets `max-height: calc(100dvh - 16px)` after its `100vh` line, so Close and Quit stay
  above the browser bar in landscape. **F3** (info.js): the readme window likewise, `min(640px, calc(100dvh -
  32px))`. On desktop `dvh` = `vh`; a browser without `dvh` keeps the `vh` line.
- **F4** (menu.js): a scroll that starts on a "▸" row does not open that submenu: a `pointercancel` from a non-mouse
  pointer clears the row's 150-ms timer. **F5**: a menu opened by a touch gets `overscroll-behavior: contain`
  (`.smk-touch`), so scrolling past its end does not scroll the page, which would close it. **F6** (stage.js):
  `.smk-surface` gets `-webkit-touch-callout: none` against an iOS long-press callout.
- Not done [decision]: a submenu covers its parent at 375 px (a tap outside closes every level, a long press opens the
  menu again); etherism's `\1` has no long-press spot (`\0` opens the menu); tooltips stay off for touch and
  thumbnails are already capped at half the viewport.

**Measured** (what a first visit downloads and how much memory it takes on a phone-sized page, cold and
tucked) [measured in Chromium, `tools/serve.py`, which compresses nothing]:
- Off page (`data-phone="off"`, forced with `?sumika-phone` at 375×812): `sumika.js` only; no localStorage or
  sessionStorage key, no `<sumika-root>`.
- Tucked page before the tap: `sumika.js`, `ghosts.json` and her icon (`tsubasa.ico`). The tap brought her out with
  her first-boot greeting at 138 % (151.8×262.2 CSS px); the next page of the tab resumed her, out, her balloon with
  its choices above her head; her input box at 375 px.
- Tsubasa's cold boot (the page's own requests; the worker's are not in the page's resource timing): 47 requests,
  2,734 KB as served: `sumika.js` 1,132 KB, her text pack 813 KB (already gzip), PNG/PNA 674 KB, the index JSON
  115 KB; plus the worker's `worker.js` 81 KB, `satori.js` 83 KB and `satori.wasm` 763 KB. About 3.7 MB as served
  here; on a host that gzips JS and wasm (most do) about 2.2 MB (`sumika.js` 310, `worker.js` 23, `satori.js` 24,
  `satori.wasm` 278 KB gzip -9). A YAYA ghost adds `yaya.wasm` (2,541 KB, 961 KB gzip) and `yaya.js` (24 KB gzip)
  instead of Satori's. JS heap of the page after boot: 27 MB (`performance.memory`; the worker's wasm memory not
  counted).
Not measured: emily4 and bthver.5, landscape and 320×568 runs, the time to the first words, a real phone's memory.

**Not yet checked on a real phone** [verify]: the iOS zoom check of the 16-px fields; the keyboard shift (none on a browser
older than Safari 14.1 / iOS 14.5 or Chrome 104, which ignores `translate`: Item 3); the landscape bars
(Tsubasa whole in landscape); her feet on the visible bottom after the browser bar hides on scroll; two tabs (open a
second tab while the first runs her, switch to it: she should move to it within a few seconds, not stay frozen until
the first tab is visited again); a long press on a character (no iOS callout); then a whole site looked at on a phone.

Safari and other browsers (not checked: no Safari or WebKit was available, so these are things to look at; an iPhone
has no console without a Mac, so each is something visible):
- S1 (first): Tsubasa appears on the iPhone at all (the browser check passes on real WebKit), then emily4 (YAYA: a
  2.6 MB wasm compiled on a phone), bthver.5 (Kawari) and mayura (Kawari 7: `TextDecoder('shift_jis')` at its start);
  WebKit's worker threads may have smaller stacks than V8, so a deep but legitimate ghost script could overflow there
  only [verify]. Also once in Firefox.
- S2: sound after a tap: Katari's sounds or bonsyou's gong play on the first tap after the ghost asks (the retry runs
  at the finger's lift: TS §3.4). And a sound a ghost starts with no tap after earlier taps (bonsyou's gong on the hour,
  inferred): Safari may allow each new `Audio` only inside a gesture (no sticky activation for media) [verify]; if it
  waits for the next tap, the fix is one `AudioContext` resumed at the first gesture, which also gives volume through
  a `GainNode`.
- S3: the look: emily4's `.pna` edges and Tsubasa's colour key as on the desktop (Safari honouring
  `createImageBitmap`'s `'none'` options), in a normal tab and in a Private tab (Safari 17+ canvas noise in Private
  Browsing, and Safari 26's Advanced Fingerprinting Protection in all browsing, would show as stray dots of the key
  colour or taps caught on transparent parts). The same Private-window look in Firefox.
- S4: Japanese input: in the communicate box, Enter that confirms a conversion does not send the box.
- S5: three ghosts at once (Call ghost ▸): no part missing, the tab not reloaded by iOS. A ghost whose
  canvas the browser refuses (WebKit's canvas memory cap) leaves the page as a failed start does, instead of standing
  half drawn (core/canvas.js; Runtime._canvasLost); temporary decode canvases are given back at once. Left open: the
  balloon ImageStore keeps decoded \_b images as canvases (up to 96 MB per ghost), which count against the cap too;
  and only each canvas's first backing store is checked (one read per canvas: a second makes Chromium warn), so one
  WebKit refuses at a later resize (a surface of another size, a balloon growing, Shell / Balloon scaling, a zoom that
  changes the device pixel ratio) is not noticed: that character or balloon then draws nothing but still takes taps.
  A ghost on the iPhone that answers taps where nothing is drawn is this case.
- S6: Lockdown Mode leaves the page as it was.
- Known, no check: `audio.volume` is read-only on iOS (ghost volume commands do nothing); Safari deletes a site's
  stored data after 7 days of use without a visit; a long press on a balloon does nothing on iOS (`contextmenu`, which
  the balloon acts on, never fires for a long press there; Android fires it) [decision: accepted; a long-press
  timer like the character's (shell/mouse.js) would be the fix].
- Only with a Mac's Web Inspector, else accepted unverified (on failure, caching works as without the option and stays
  consistent): the two Safari `fetch` `cache` items of safe updates (CLAUDE.md "Unverified in browsers and on hosts");
  IndexedDB after minutes in the background. Not
  checkable here, low impact: Safari's Shift_JIS table (page-side display of a few symbols only).
- Android: S1 and S2 in Chrome.

---

## 10. P0 checklist for Tsubasa (from this topic)

- [ ] Menu: right-click / long-press rule (§2.5); items Recommend, Portal, Dress-up (P1 ok), Information→readme, Iconify, Close; captions re-queried per open; look from shell descript.
- [ ] Placement: alignment resolution with the "alignmentondesktop" alias; base-point anchoring; default layout; per-ghost ratios; reset position; clamp on resize.
- [ ] Extra scopes `\p[2..101]` created on demand; `char<n>.defaultleft`; `\![move]` with screen base; `\![set,scaling]` incl. mirroring.
- [ ] Per-pixel hit regions (clip-path) for characters and balloons.
- [ ] Mouse events with scope/collision/button/device refs; OnMouseMove rate; wheel ±120; drag events; hold timing works for scope 99 `Mclose`.
- [ ] OnKeyPress with SSP key names; active-ghost focus rule.
- [ ] Balloon placement/flip; new-script clear vs `\C`; `\b[-1]`; `\![*]` marker; 50 ms/char; 15 s / 30 s timeouts; `\*`; hover pauses timers.
- [ ] Choice flow Ex→plain, `On…` ids, `script:` ids; empty reply closes balloons; double-click break → OnBalloonBreak / OnBalloonClose.
- [ ] Scheduler: user events replace scripts; `\t` drops mouse events; NOTIFY ticks with R3=0; Status header.
- [ ] Inputbox (+timeout compatibility), communicatebox (OnCommunicate / OnCommunicateInputCancel), close without events.
- [ ] Minimize/restore launcher; Close → OnCloseAll→OnClose → `\-`.
- [ ] Navigation resume with ghost-lifetime state and balloon snapshot; single-tab engine lock.
- [ ] MS Gothic-compatible font stack.

## 11. Open questions (verify in SSP 2.9.08f)

1. Does SSP suppress the right-click menu when OnMouseClick(R5=1) returns a script? (ninix: yes.) Same for OnMouseUp?
2. Exact first-boot X positions of `\1` and of `\p[n≥2]` without defaultleft. Is `defaultleft` the window's left edge or the base point?
3. Exact OnMouse* order around a double-click and after a drag (is OnMouseClick sent after OnMouseDragEnd? Is OnMouseDown sent for the second press?).
4. Does `\C` re-open a balloon that already timed out, with its old text?
5. Default of "Disable timeout when cursor is in balloon"; the current default right-click action on balloons (app.dat has `Balloon.RightClick.Method.ReDefault,1`, which hints the default was changed once).
6. Is cantalk 0 while choices are shown, or while an input box is open? (Satori and Tsubasa behave well either way, but random talk must not wipe a menu.) Answered [disasm, EV §1.6]: an input box, no; a choice waiting (+0x14bc), yes.
7. Communicate box default screen position when `communicatebox.defaultleft/top` is absent.
8. Initial balloon side for `\1` (left like ninix, or right?).
9. Does a choice whose ID is a URL open the browser in SSP?
10. Product decisions: what "Close" means on a website (launcher to re-summon?); mid-script resume vs truncate on navigation; whether hidden tabs tick.
11. (SakuraScript topic) UKADOC's `\![timerraise]` text is self-contradictory about which value of the 2nd argument repeats (it says 0 = repeat and also 0 = "valid until the event fires"). Tsubasa uses `\![timerraise,…,1,…]` heavily, so this needs checking in SSP.

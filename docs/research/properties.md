# SSP's property system and %-variables (implementation spec)

Status: implemented. Normative for `src/sakura/expand.js`,
`src/core/properties.js`, the player's `\![get|set,property]` and `\![open,con…]`, and `BalloonModel#metrics`.
Reference: ssp.exe **2.9.9.3000** and its `ssp.map`; every function read here is named with its address.

Tags: [disasm 0x…] read in ssp.exe; [doc] UKADOC `list_propertysystem` / `list_sakura_script` (copies in
`docs/research/scratch/ukadoc/`); [corpus] a ghost's own files; [code file] Sumika; [infer] follows from the code read
but not traced to the end; [guess]; **[decision]** a choice where a browser differs from Windows or ssp.exe is silent
(§8 lists them); [observed] seen in a running ssp.exe.

Not in the repository: the UKADOC copies in `docs/research/scratch/ukadoc/`, the ghosts this spec quotes (CLAUDE.md "The
ghosts Sumika was tested with") and SSP's word list `site/sumika/word_compatible.txt` (§2.4). These are development
material, cited as the sources (CLAUDE.md "Project rules").

---

## 0. Short version

1. **Three script doors, one resolver.** `%property[NAME]`, `\![get,property,EV,NAME…]` and
   `\![set,property,NAME,VALUE]` go to `SPVarSystemDispatcher::Get` 0x78CDF0 / `::Set` 0x78CFE0 with the ghost that
   plays the script [disasm]. Sumika: `getProperty(world, name)` / `setProperty(world, name, value)`.
2. **%-variables are expanded once over the whole script before it plays** (`SPGhost::TranslateParam`), never inside
   a tag's bracket, `%property` raw, names of people and ghosts with doubled backslashes (§2).
3. **`\![get,property]`** sends `GET EV` with the values as References (`SenderType: internal,property`), at the tag;
   the script waits for the reply as for `\![raise]` (§3). **`\![set,property]`** needs NAME and VALUE (§4).
4. **Names** are case-insensitive, never trimmed; lists are `L.count`, `L.index(N).P`, `L(NAME).P` (ID, path, name,
   for ghosts then the sakura name); scopes `scope(N)`, `scopeN`, `sakura`, `kero`… (§5).
5. Failure and an empty value look the same to a ghost: `%property` removes the variable, `\![get]` sends `""`.

## 1. Code

| Part | File | What |
|---|---|---|
| Expander | `src/sakura/expand.js` | `expandScript(script, resolve, {maxPasses})`, `EXPAND_NAMES`, `WORD_NAMES`; pure; a string, or a Promise when a value had to be awaited |
| Words | `src/core/words.js` | SSP's word list (§2.4): `parseWordList`, `pickWord`, `loadWordList`, `WORD_FILE`; the loop's `word(type)`, the Site's `compatibleWords()` |
| Resolver | `src/core/properties.js` | `getProperty`, `setProperty`, `parseCharIndex`, `pickFromList`; pure over a `world` (typedefs in the file) |
| Player | `src/sakura/player.js` | `\![get,property]` → `host.raiseProperty(id, names)`; `\![set,property]` → `host.setProperty(name, value)`; `\![open,con…]` → `host.openWindow('configurationdialog', args)`; expands nothing |
| Tokenizer | `src/sakura/tokenizer.js` | an `env` token only for `%*` |
| Balloon | `src/balloon/model.js`, `manager.js` | `BalloonModel#metrics()`, `balloonMetrics(geo, font, measure)`, `Balloons#metrics(scope)` (§5.7) |
| Wiring | `src/core/events.js`, `site.js`, `runtime.js` | the expansion pipeline (§2.1: `EventLoop.expand`, `_translate`), the `world` (`EventLoop._world`, `propRecord`; `Site.propsFor` for the lists), `raiseProperty` / `setProperty` / `openWindow` (→ `Site.openSettings`, `settingsPage`) |

The world (every member optional; a missing one makes its names fail): `now`, `locale`, `idleSec`, `sessionSec`,
`cursor`, `viewport`, `dark`, `online`, `baseware {name, version, platform}`, `self()` (the calling ghost),
`ghosts()` (the site index, index order), `active()` (up in this tab, set order, the caller included), `balloons()`.
A ghost record carries `live` when it is up here: `username()` and `ext(key)` / `setExt(key, value)` ask that ghost's
engine (Promises), the rest (`status`, `selfname2`, `scopeCount`, `scope(n)`, `shells`, `currentShell`, `balloon`,
`balloonScope(n)`, `setSurface(n, v)`, `setBalloon(n, id)`) is read at once.

## 2. %-variables [disasm `SPGhost::Loop` 0x63B747, `TranslateParam` 0x636440, `TranslateParamReal` 0x636510]

### 2.1 When

- Once over the whole script when it is about to play; OnTranslate then sees the expanded text; when OnTranslate
  changed it, once more [disasm 0x63B7AF–0x63B822].
- A `\![embed]` reply is expanded before it is spliced in [disasm `EmbedSendEventFunc` 0x633349]; so is the legacy
  sentence insertion of `DecodeProcReal` [disasm 0x62AE44]. The same function then sends the expanded reply through
  OnTranslate (R0 the reply, R1 `""`, R2 the event, R3 its refs) and splices a changed reply as returned, without a
  second expansion [disasm `TranslateScript` 0x633389] (EV §4.10).
- Nothing else: `TranslateParam` has these callers only [disasm xref]. A value is read **when the script starts**:
  `\s[5]%property[currentghost.scope(0).surface.num]` gives the surface from before `\s[5]`.
- Sumika: the event loop expands before OnTranslate, after a changing OnTranslate, on `\![embed]`
  replies (then OnTranslate, as above) and in `playScript`; a replay after a page change plays the stored, already
  expanded script. A reply whose expansion asks an engine (`%username`, an `.ext.` property) still plays in the order
  the replies arrived (`EventLoop._inOrder`), so a newer reply is never replaced by an older one.

### 2.2 One pass, and the passes

```text
TranslateParam(s): repeat at most 5 times: before = s; TranslateParamReal(s); stop when s == before
TranslateParamReal(s): i = 0
  while i < len(s) − 1:
    if s[i] == '\': i += 1; skip up to two '_'          # i is at the tag letter
       if s[i+1] == '[': skip to the first ']' that has no '\' before it (quotes are not honoured)
    elif s[i] == '%' and a known name follows (case-sensitive): replace the variable (below)
    i += 1                                                 # after a replacement: the 2nd character of what stands there
```

- **Not inside brackets.** Nothing in any `\X[…]`, `\_X[…]`, `\__X[…]` is expanded: not a `\q[%username,X]` title,
  not `\![embed,E,"%property[a]"]` (kanade_2nd's test entry [corpus]), not `\![open,inputbox,I,,%username]`. Text
  between tags is (`\_a[ID]text\_a`, `\__q[ID]text\__q`). `\%` is never expanded (`%` is the tag letter); `\\%x`
  is. A tag without a bracket skips only its letter (`\s10%username` expands).
- **`%property[NAME]`** (`%property` in lower case only): NAME runs to the first `]` (no quotes, no nesting:
  `%property[ghostlist(a]b).name]` asks for `ghostlist(a`). No `]` before the end, or an empty NAME: left as written.
  Get fails: the whole variable is removed [disasm 0x636FF7]. Get succeeds: the value goes in **raw**, so a value
  holding `\` becomes script [disasm 0x636FE2–0x636FF0].
- **Doubled backslashes**: `%username` 0x637252, `%selfname` 0x6370B1, `%selfname2` 0x63705E, `%keroname` 0x636B1D,
  `%lastobjectname` 0x636B70, `%lastghostname` 0x636BC9 run `Replace("\", "\\")` on their value [disasm]. Numbers
  and `%property` go in as they are.
- **Rescans.** The scan goes on inside an inserted value from its 2nd character, so `<%username>` from a property is
  expanded in the same pass; a value that starts with a variable waits for the next pass. After a removal the scan
  resumes one character late [disasm 0x637024 → 0x637303]: in `%property[bad]\%username` the `\` loses its skip and
  `%username` is expanded. Copied as is.
- **Unknown names** stay text; `%%` is no escape (the first `%` starts no name, the second may). `100%` at the end is
  never looked at (the loop stops before the last character).
- **No bound in ssp.exe**: a value holding its own variable after its first character grows the script for ever.
  Sumika stops expanding after 10,000 substitutions or 1 MB of growth and logs it once [decision].
- `%*` is replaced by `\![*]` in ssp.exe [disasm 0x6372E5]; Sumika's expander leaves it and the tokenizer turns it
  into the marker, which shows the same.

### 2.3 The variables Sumika expands, and their values

`EXPAND_NAMES` (longest first): `property lastobjectname lastghostname screenheight screenwidth selfname2 selfname
wronghour keroname username minute second month hour day exh dms et ms mz ml mc mh mt me mp m?`. The values are the
event loop's; null leaves the variable as written.

| Variable | ssp.exe | Sumika |
|---|---|---|
| `%username` | `SPGhost::GetUserNameW` 0x643A10: `GET username` to the ghost **at each expansion**, no cache; 204 or empty → SSP's nickname setting [disasm] | the same request; then the visitor's stored nickname (else name) from the Preferences box; then the word `user` [decision, §8] |
| `%month %day %hour %minute %second` | local time, `ultowcs`, no padding [disasm 0x636C27] | the loop's clock |
| `%selfname`, `%keroname` | `SPSeriko::GetCharName` 0 / 1 (the shell's names override) [disasm 0x63709E, 0x636B0A] | `_charName(0 / 1)` (EV §2.6) |
| `%ms %mz %ml %mc %mh %mt %me %mp %m? %dms` | `SPGhost::GetWord` 0x63FA00: the ghost's word, else SSP's word list (§2.4) | the same (§2.4) |
| `%et` | r = `genrand(59787)` (MT19937 mod n, 0x578060), then `swprintf(L"%d%s", r mod 1000, unit[r mod 5])` with the units `msec yard kg t dozen` (table 0xBBC5D8), so the number decides the unit: `234dozen`, `3t`; replaces 3 characters [disasm 0x6367C5–0x63681A] | the same over the loop's `random` |
| `%wronghour` | the local hour ± 1 or 2, mod 24: d = (`genrand(23)` & 1) + 1, then a second `genrand(23)` even → hour − d, odd → hour + d (12 / 23 vs 11 / 23 each way, as copied); replaces 10 characters [disasm 0x637274–0x6372E3] | the same |
| others | sakurascript.md §5.12 | as sakurascript.md §5.12 says |

The jump table of `TranslateParamReal` (byte table 0x63736C indexed by the character after `%` − `*`, targets at
0x637320) has cases for `0 1 b c d e f h j k l m n o p s u w *` [disasm]. Names Sumika does not expand (they stay
text; no site ghost uses them) [follow-up]:
- `%friendname`, `%kinokoname`, `%ntpdiffsecond` (`SPTimeClient::GetDiffSecond`), `%originalname` (the fixed text
  `偽○菜`), `%screensizemessage`, and the cases under `j` and `p` not read here.
- Only in a ghost's **compatible mode** (ghost+0x2178, `SPGhost::SetCompatibleMode`, the menu's compatibility item):
  `%d` day, `%h` hour, `%m` minute (when no word type follows), `%o` month, `%s` second (each replacing 2
  characters), `%c` the user name, `%0` / `%1` its parts (split at spaces), `%by` a year from 1950 to last year, `%bm`
  1–12, `%bd` 1–28 [disasm 0x6365FC, 0x63669C, 0x63670B, 0x6367AF, 0x6368E3, 0x636CE2, 0x636D60, 0x6371FF]. Sumika
  has no compatible mode.

Sumika sends no boot-time `GET username`: ssp.exe sends none at boot [disasm `LoadGhost`
0x620619 runs before the SHIORI loads].

### 2.4 The word variables (`%ms` … `%dms`) [disasm ssp.exe 2.9.10.3000]

The legacy random words of the "何か" era. Read in the installed build (FileVersion 2.9.10.3000) with its `ssp.map`.

**Which variables** (`TranslateParamReal` 0x636510, its `d` and `m` cases):
- `%dms` → the type `\dms` [disasm 0x63674C–0x63676C; checked before `%day`].
- `%m` + one of `cehlpstz?` → the type `\m` + that character [disasm 0x636C82–0x636CCD: `wcschr(L"cehlpstz?", c)`,
  after `%month` and `%minute`]: `%mc %me %mh %ml %mp %ms %mt %mz %m?`. Case-sensitive (`%MS` is text).
- A `%m` that **ends the script** asks `\m`: `wcschr` also finds the terminating NUL, and `JWString::Replace` cuts the
  3-character length at the end [disasm 0x636C8F, 0x5AC1BE]. Sumika copies it (`expand.js` `matchVar`, name `m`).
- A word replaces 3 characters (4 for `%dms`) **raw**: no backslash doubling, so a `\` in it is script. No word: the
  variable stays as written. The rescans of §2.2 apply, so a word holding `%ms` after its 1st character is expanded in
  the same pass, one starting with it on the next.

**Where the word comes from** (`SPGhost::GetWord` 0x63FA00):
1. The ghost's SHIORI (`SPShiori::GetWord` 0x70CBB0), with the type as it is (backslash included):
   - SHIORI/3.0 (version ≥ 30): `MakeShiori30Request` over a fresh event (`SPShioriEvent::Clear` 0x419B50: GET,
     `SenderType: internal`, `SecurityLevel: local`, `SecurityOrigin: null`, no References), so `GET SHIORI/3.0`,
     Charset, SecurityLevel, SecurityOrigin, `Sender: SSP`, SenderType, Status, `ID: \ms` [disasm 0x70CD64–0x70CDC7,
     0x70A2F0].
   - SHIORI/2.x: `GET Word SHIORI/2.0` / `Charset: <the module's>` / `Sender: SSP` / `Type: \ms`, nothing else (no
     SecurityLevel, no Status) [disasm 0x70CDCC–0x70CEFE].
   - A SHIORI/1.x DLL without `request` gets its exports `_getdms` / `_getword` instead (`\m?` sent as `\m` there)
     [disasm 0x70CC06–0x70CD39; `SPShiori::Load` 0x70AE70–0x70AE9B looks them up]: no Sumika engine is one.
   - The reply counts for status 200, 311 or 312 only; the word is `Value`, else `Word`; an empty one is none
     [disasm 0x70CF98–0x70D051]. It goes through `ParseGenericHeaders` only: never a COMMUNICATE (EV §2.7.7).
2. `\m?` with no word: the ghost is asked once more for `\m` (`wcsicmp`) [disasm 0x63FA3C–0x63FA5C].
3. **SSP's word list** (`SPCompatibleWord`, sp_compatibleword.obj): at the first word nobody answered, ssp.exe reads
   its own data file `data/word_compatible.txt` (`FindSystemFileFromPartialDir`) and keeps it; a load that gave nothing
   is tried again next time [disasm 0x63FA62–0x63FB66, `Load` 0x5ECAA5]. Then `Get(type)` [disasm 0x5ECBA0]: one
   leading `\` dropped; `m?` (any case) takes a section at random (`\dms` among them), else the section of that name
   (any case, `FindEntry` 0x5ECC20); then a word of it at random (`genrand(n)` = MT19937 mod n, 0x578060). No section:
   none. (`ssp.exe` itself has no word list in its resources: the strings `word_compatible.txt`, `\m?`, `\m`, `\dms`
   are its only traces [disasm xref].)

**The file** (SSP 2.9.10's `data/word_compatible.txt`: 2,341 bytes, UTF-8, dated 2015-01-07; no personal data, not under
`profile/`). `Load` [disasm 0x5EC880] reads it through `JTokenStream` (j_stoken.obj) a **whole line** at a time
(`ReadToken(0)` never splits at its `,` separator), spaces and tabs trimmed at both ends (not full-width ones), empty
lines and lines starting with `//` skipped, a UTF-8 BOM skipped [disasm `ReadEOL` 0x583790, `NextToken` 0x583C51,
`ProcessReturnPointer` 0x583CF0, `Init` 0x583A4F]; `charset,X` (any case, any line) sets the code page (default: the
system's ANSI page); `*NAME` starts the section NAME or goes on with the one of that name (any case); any other line is
a word of the current section, none before the first `*`. Its 9 sections: `ms` 21 people, `mz` 11 things, `mc` 17
companies, `mh` 6 shops, `mt` 5 techniques, `me` 14 foods, `ml` 2 groups, `mp` 29 places, `dms` 14 longer nouns that
hold variables of their own (`%msが企画したとんでもない%m?ゲーム`).

**Who answers** [measured, the real builds on the site copies]: emily4 and NodePsimoon (YAYA) answer every
type but `\m?` and `\m` themselves (`\ms` → 出井伸之, `\me` → バッカス …); Tsubasa (Satori) and bthver.5 (Kawari 8)
answer 204, so their words come from SSP's list (bthver.5's own `dms` talks hold `%mp` and `%mt`). The Kawari 7
ghosts maria_re and teruno109 define `compatible.ms/mz/mc/mh/mt/me/mp/m/dms/d` (Kawari 7.5.0 answers `GET Word` from
`compatible.<Type without its first character>`, `Word: …` or 204; neither defines `ml` or `m?`, so `%m?` reaches
them through the `\m` retry) [corpus; vendor `kawari.cpp` 243–262].

**Sumika** (`src/core/events.js` `word` / `_askWord`, `src/core/words.js`, `src/core/site.js` `compatibleWords`):
- The expander asks the loop's `word('\ms')` for each word variable (`WORD_NAMES`); each one asks again, no cache.
- `_askWord`: `_request(type, [], {comm: false, kind: 'word'})`. A SHIORI/3.0 engine gets the request above (the
  page's usual headers, SecurityOrigin aside as for every request, EV §1.1); the worker hands a SHIORI/2.x engine's to
  the bridge, which sends `GET Word` (kawari7-wasm.md §6). The word: 200 / 311 / 312, Value, else Word, not empty.
- SSP's list: the site's copy `site/sumika/word_compatible.txt` (byte-identical to SSP's), fetched by the Site at the
  first word nobody answered, parsed by `parseWordList` (the rules above) and picked by `pickWord`; the loop's
  `random` (Math.random) stands in for MT19937. A Node loop (tests, the sweep) gets it only when given (`wordList`):
  the sweep reads the site copy when there is one.
- The list is SSP's own file, served from the site, not built into the runtime; the repository does not hold it, and
  a publisher copies it from an SSP install [decision] (§8). SSP's readme lets SSP be redistributed freely but asks
  people not to redistribute parts cut out of it; a site
  that leaves the file out gets what an SSP without its data file does (a word nobody answers stays as written). A
  missing file is not fetched again on that page (ssp.exe would look again) [decision].

## 3. `\![get,property,EV,NAME…]` [disasm `ExecuteExclamationNotifiable` 0x62DFA4–0x62E2FD]

| | ssp.exe | Sumika |
|---|---|---|
| tag name | `get` exact (flags 0x5), sub-command `property` exact (flags 0x3), any case [disasm table 0xBBD448; `SPGhost_FindExclName` 0x62D830: flag bit 0 = whole-name `wcsicmp_opt`, else a prefix of the entry's length with `wcsnicmp_opt`] | the same: `get` exact, `property` any case (spaces trimmed, as for every `\![…]`) |
| `\![get,property,EV]` (fewer than 4 arguments) | nothing sent | nothing sent |
| values | each NAME through Get with the playing ghost, in order; a failed one is `""` [disasm 0x62E179–0x62E1F3] | the same resolver, read when the tag runs (the host's `raiseProperty`) |
| request | `GET EV`, References = the values, `SenderType: internal,property` [disasm 0x62E223] | same |
| reply | played like `\![raise]`'s (`OnNotifyEvent` → `PlayScriptWithMsg`) [disasm 0x62E266, 0x64242D]; synchronous | the run waits at the tag; an empty reply goes on, a non-empty one replaces the run |
| empty EV | sent as is | refused, logged once [decision: an empty ID is no event] |
| untrusted script (flag bit 2) | refused [disasm 0x62DFB7] | no such flag: not copied [decision, §8] |

emily4 and etherism rely on the wait: `\![get,property,…]\![embed,…]` needs the get's event answered before the
embed is asked [corpus aya_menu.dic:1226; etherism dic01_Base.txt:194-199]. EV is not checked for `On` (etherism's
`OnGet0BalloonLines`, sagiri_tama's `シェル変更後情報取得`) [corpus]. A replay never sends it (a side effect, SS §7).

## 4. `\![set,property,NAME,VALUE]` [disasm 0x62E300–0x62E369]

The tag name `set` matches by its first 3 letters in ssp.exe (flags 0x4), `property` exactly (flags 0x3), any case
[disasm table 0xBBD448, 0x62D830]. Sumika matches `set` exactly, like every `\![…]` name but `\![open,con…]`; SSP's
prefix matching for all of them is a [follow-up].
Needs NAME and VALUE (`\![set,property,a,]` sets `""`, `\![set,property,a]` does nothing); arguments after VALUE are
dropped (a value with commas must be quoted, SS §3.4); the result never reaches the script. The same untrusted gate
as §3 (not copied). Sumika: `host.setProperty(NAME, VALUE)`; a thenable (an `.ext.` write asks a SHIORI) holds the run
at the tag until it settles, as ssp.exe's Set is synchronous. Earlier the tag reached `setOption('property')`
and was only logged. Settable names: §6.

## 5. Names

### 5.1 The dispatcher [disasm `Get` 0x78CDF0, `Set` 0x78CFE0, `FindFromName` 0x78C5A0]

- Case-insensitive (`wcsicmp_opt`, ASCII only) and never trimmed, except the words `index`, `scope`, `char`,
  `surface` of `index(N)`… (swscanf: lower case only) [disasm 0x78D890, 0x78D920].
- `currentghost.`, `ghostlist.current.`, `activeghostlist.current.` = the calling ghost for Get; for Set only the
  first two (`activeghostlist.current.X` fails in Set: FindFromName finds no `(`) [disasm 0x78CFE0–0x78D020].
- Exact names: `balloonlist.count`, `headlinelist.count`, `pluginlist.count`, `ghostlist.count`,
  `activeghostlist.count` [disasm 0x78CE5B–0x78CF6C].
- Roots, each followed by `.` or `(` (`IsNodeNameBoundary` 0x78CDD0), else the name fails: `system.`, `baseware.`,
  `balloonlist`, `headlinelist`, `pluginlist`, `ghostlist`, `activeghostlist`, `rateofuselist`, `history`,
  `developer.log.script|network|error|update`. Anything else fails; `shiori.*` does not exist in 2.9.9.
- Nothing is logged by ssp.exe. Sumika logs a name that fails once, at debug.

### 5.2 Lists [disasm `SPPropListNode::GetIndex` 0x78D590, `FindNode` 0x78D740, `VarGet` 0x78D780]

- `L.index(N).P` and `L.indexN.P`: N by swscanf (`index(%d)`, `index%d`; spaces before the number allowed); P after the
  first `.` past `.index(`. GetIndex needs a `(` somewhere, so `ghostlist.index3.name` **fails** while
  `ghostlist.index3.scope(0).name` works [disasm 0x78D59D–0x78D5A8]. Copied.
- `L(NAME).P`: NAME between the first `(` and the last `)` before the first `.` outside parentheses
  (`FindPeriodIgnoreKakko` 0x78DC10: one flag, no nesting), so `ghostlist(Emily/Phase4.5).name` works; one `.`
  after `)` is skipped; nothing after it fails. `currentghost.shelllist(NAME)` uses the plain first `.` (the list
  node's VarGet), so a shell name with a `.` cannot be addressed [disasm 0x78D78C].
- NAME is tried as ID, then path, then name (`SPProp::FindFromID` 0x6C2EF0, `FindFromPath` 0x6C2B60, `FindFromName`
  0x6C2F50), any case; `ghostlist` then tries the sakura name (`FindGhostIDFromName` 0x78C8E7), `activeghostlist`
  `FindActiveGhostFromName` 0x78CB0B [infer: the sakura name too].
- Sumika: a ghost's ID is its folder id in the site index [decision]; a path matches `/ghost/<id>/` or `ghost/<id>`
  with or without the final `/`, `\` read as `/`, any case (ssp.exe's absolute / relative rule) [decision].
- `ghostlist` = the site index's ghosts in its order, which is Change ghost ▸'s (by descript name,
  ties by folder: ssp-ui.md §2.1 #12 [observed: screenshot]; earlier the folder name) [decision; that ssp.exe's
  `ghostlist.index(N)` uses the menu's order is not traced];
  `activeghostlist` = this tab's ghosts that are up, set order, **the caller included** [infer: emily4 skips her own
  name, aya_menu.dic:1263]; `balloonlist` = the site's balloons, index order.

### 5.3 Scopes [disasm `ParseCharIndex` 0x78D920]

`index(N)`, `indexN`, `scope(N)`, `scopeN`, `char(N)`, `charN` (lower case), else a name **starting** `sakura` (0) or
`kero` (1) in any case; the property is what follows the first `.` [disasm 0x647B1F]. So etherism's and mikaru's
`scope0` is right, and `keroXY.name` is scope 1.

### 5.4 Ghosts, and the names every item has [disasm 0x6C3FD0, 0x6C1BD0, 0x6476D0]

A ghost name runs through three levels; the first that knows it answers:

1. **The ghost's descript** (`SPGhostProp`; works for a ghost that is not up): `sakuraname` = `selfname`,
   `keroname` (descript level, not the shell's override), `icon` (the file `SPGhostProp::GetIconName` 0x6c4dd0
   finds: descript `icon`, else `icon.ico`, in the ghost root, then `ghost/master/`; it must exist; fails without one;
   Sumika: `ghosts.json` `icon` as a site path, for every ghost, `ssp-ui.md` §2.6), `homeurl` = `updateurl`,
   `recommended.balloon*` (later).
2. **Every item** (`SPProp`): `name`; `craftman` = `craftmanw` (one field [disasm 0x6C1C08]); `path` (Sumika: the
   site path, `/ghost/<id>/`, shells `/ghost/<id>/shell/<sid>/`, balloons theirs; EV §2.1 "Paths") [decision];
   `craftmanurl`; `homeurl` = `updateurl`; `index` (Sumika: the position in the item's own list: installed ghosts,
   balloons, the ghost's shells [infer]); `thumbnail` (a ghost's: one of its `thumbnail*.*` images in its folder, else
   in `ghost/master/`, picked at random each time as `SPProp::GetThumbnailReal` does [disasm 0x6c3257], from
   `ghosts.json` `thumbnails`, UI §2.14; fails without one; shells and balloons have none yet); `update_result`
   (`""`: Sumika updates nothing); `update_time`, `install_time`, `firstboot_time` (`0,0,0,0,0,0`: none happen in a browser [decision]),
   `lastboot_time` (the ghost state's boot time for a ghost up in this tab, else zeros [decision]).
   `craftmanurl`, `homeurl` of other ghosts: `""` until the site index carries them [decision]; their `icon` comes
   from the index (above).
3. **The running ghost** (`SPGhost`, only when it is up here): `username` (`GET username` to **that** ghost; fails
   without an answer; no fallback to SSP's nickname [disasm 0x6479F0]), `selfname2`, `status` (the `Status` header
   text), `scope.count`, `kinokoname` (fails in Sumika), `scope(N).*` (§5.6), `balloon.*` (§5.7), `shelllist…`
   (§5.6), `ext.KEY` (`GET property.get` [R0 KEY], SenderType internal, to that ghost; a non-empty value
   [disasm 0x648547–0x6485D2]; a GetStringShiori read: `GET String SHIORI/2.5` to a 2.x SHIORI, 200/311/312, never a
   COMMUNICATE, EV §5.5); `mousecursor*`, `seriko.*`, `sound*`: later (§7).

### 5.5 `system.*` and `baseware.*` [disasm `SPSystemNode::VarGet` 0x78D0A0]

| Name | ssp.exe | Sumika |
|---|---|---|
| `system.year .month .day .hour .minute .second .millisecond` | local time, no padding | the loop's clock, local |
| `system.dayofweek` | the weekday **name** from the Windows locale [disasm 0x78D447] | `Intl.DateTimeFormat(locale, {weekday: 'long'})`: `日曜日` on a Japanese browser [decision: the browser's language stands for the OS locale] |
| `system.cursor.pos` | `x,y` screen px | the last pointer position the page saw, desk CSS px; `0,0` before any [decision] |
| `system.platform` | `ssp.exe` | `ssp.exe` [decision, §8] |
| `system.os.type`, `.name` / `.arch` / `.version`, `.build` / `.parenttype`, `.parentname` | Windows' | `Web` [doc: "Web上ランタイムなら"Web""] / `unknown` [doc] / `""` / `""` [decision: no user-agent detail reaches a ghost] |
| `system.os.locale`, `.locale.language`, `.locale.country` | the Windows locale | the browser's language tag and its language and region parts [decision] |
| `system.os.timezone.offset`, `.dst` | `GetTimeZoneInformation`: the standard Bias (minutes, `UTC = local + bias`), `1` in daylight time [disasm 0x768B06–0x768BCA] | the larger of January's and July's `getTimezoneOffset()` (−540 in Japan); `1` when today's offset is below it |
| `system.os.unixtime`, `.uptime`, `.idletime` | seconds | seconds since 1970; since the tab's session started (what `%exh` uses) [decision]; since the visitor's last input |
| `system.cpu.*`, `system.memory.*` = `system.mem.*` | | fail [decision: a browser cannot read them; the coarse ones are fingerprints] |
| `system.power.source`, `.battery.percent` (`.percent`), `.battery.lifetime` (`.lifetime`), `.battery.flag` (`.flag`) | `GetPowerProp` 0x768D20 | `unknown`, `-1`, `-1`, `""`: UKADOC's "cannot get" values [doc] |
| `system.disk.count` | | `0` [decision] |
| `system.network.status`, `.type`, others | `GetNetworkProp` 0x6AABD0 | `online` / `offline` from `navigator.onLine`, `unknown`, fail (never an address) [decision] |
| `system.monitor.count`, `.index(0).work / rect / bpp / dpi / primary` | per monitor [disasm 0x6A2D70, 0x6A1650] | one monitor, the viewport: `0,0,W,H` for both rects, the colour depth, `round(96 × devicePixelRatio)`, `1` [decision] |
| `system.theme.app.mode`, `.os.mode` / `system.dnd.mode` | dark / light; quiet / normal | `prefers-color-scheme` / `normal` |
| `baseware.name` / `.windowmode` | `SSP` / normal, shared, perghost | `SSP` / `normal` |
| `baseware.version` | `SSP/%s (%s; %s)`: `SSP/2.9.09 (20261009-5; Windows NT 10.0.26100)` on one Windows PC [disasm `CreateVersionString` 0x76832D; exact text infer] | `SSP/2.9.08 (sumika-<VERSION>; Web)`, built from the loop's `BASEWARE` so it never disagrees with `basewareversion` (both stay on 2.9.8) [decision, §8] |

Nothing under `system.` or `baseware.` is settable [disasm `SPSystemNode` VarSet 0x65CA80].

### 5.6 `currentghost.scope(N).*` and `currentghost.shelllist…` [disasm 0x647B07–0x647FC7, 0x6483EC–0x648544]

| Name | Sumika |
|---|---|
| `scope(N).name` | the scope's name with the shell's override (`_charName(N)`; scopes ≥ 2: descript `charN.name`) |
| `scope(N).surface.num` | the stage's surface for N |
| `scope(N).seriko.defaultsurface`, `.balloon.defaultsurface` | the shell's default surface for N; the descript's default balloon kind |
| `scope(N).bind.menu` | `auto` [decision: Sumika has no per-scope dress-up menu switch] |
| `scope(N).x`, `.y`, `.rect`, `.currentmonitor.*` | the base point and window rect in desk CSS px [decision]; the one monitor |
| `scope(N).scaling` | tag scaling × Shell scaling ▸, `%.2f` per axis, trailing zeros cut (`100,100`, `133.33,133.33`) [infer] |
| `shelllist.count`, `.index(N).P`, `(NAME).P`, `.current.P` | the ghost's shells in index order; P = the item names (§5.4) plus `sakuraname`, `keroname` (that shell's overrides or `""`), `notinstalled` (`false`), `menu` (`hidden` for an index-hidden shell, else `""`) [disasm `SPShellProp::VarGet` 0x61ABE0] |

`scope(N).x`, `.y` and `.rect` are exact names; `surface.x`, `surface.y` (UKADOC) do not exist [disasm 0x647F13].

### 5.7 `currentghost.balloon.*` and the balloon metrics

[disasm `SPBalloon::VarGet` 0x5C85A0, `SPBalloonWnd::VarGet` 0x5CA080] `currentghost.balloon.NAME` with an item
name (§5.4) reads the balloon in use (Sumika: its site path). Per scope (`currentghost.balloon.scope(N).…`, any scope
form):

| Name | ssp.exe | Sumika (`BalloonModel#metrics`, balloon-image px) |
|---|---|---|
| `num` | the balloon id | the scope's `\b` kind |
| `validwidth` / `.initial` | `min(wrap, right) − x0` / `right − max(left, x0)` [disasm 0x5C9FEB–0x5C9FFD, 0x5CA118] | `min(wordwrappoint.x, right) − x0` / `right − x0` |
| `validheight` / `.initial` | `bottom − top` / `bottom − max(top, y0)` [disasm 0x5CA003–0x5CA00F, 0x5CA1A4] | same |
| `lines` / `.initial` | `(validheight + 2) / line height`, integer [disasm 0x5CA2CF, 0x5CA318] | the same with the layout's line height (font height + 2) [infer: SSP's `ResetGlobalFontHeight` not traced] |
| `basepos` / `.x` / `.y` | `x0,y0` through `LayoutToReal` | `x0,y0` |
| `char_width` | `GetCalcFontWidth` [disasm 0x5CA388]; UKADOC: monospace height ÷ 2, else the mean width of `A`–`Z` [doc] | the layout's mean advance of `A`–`Z`: MS Gothic's half width, `floor(h/2 + 0.5)`, with or without a canvas (height ÷ 2 for the usual even heights) [decision] |
| `vertical` | `1` / `0` | `0` (no vertical balloons) |
| `x…`, `y…`, `rect…` (prefixes) | the window rect | the balloon view's desk rect, CSS px |
| `defaultsurface` (balloon level) | the default balloon id | the descript's default kind |

`x0 = max(origin.x, validrect.left)`, `y0 = max(origin.y, validrect.top)`: `SetBalloon` clamps the origin into the
valid rect and raises the rect's left to the origin [disasm 0x5CA939–0x5CAB1C; field meanings infer]. The numbers
belong to the image in use (kind and side), so `\b[2]` changes them. ssp.exe answers only once the scope's window has
a balloon (+0xA48); Sumika answers before the balloon was ever shown [decision: etherism reads them in OnFirstBoot and
works in SSP, so they exist there by then [infer]]. A scope the ghost does not have fails.
`currentghost.balloon.count` does not exist (UKADOC lists it) [disasm 0x5C89EC].

etherism (site) divides `validwidth` by `char_width` for its menu rules and puts a line at `lines − 1`; mikaru140920
and mobilemaster read `validwidth` / `validheight` [corpus]. The side-by-side check (§9 C3) settles the
inferred fields.

### 5.8 Other lists

`headlinelist.count`, `pluginlist.count`, `rateofuselist.count`, `history.ghost|balloon|headline|plugin.count`,
`developer.log.script|network|error|update.count`: `0`; every other name under them fails (a browser has none of
them) [decision].

### 5.9 Formats [disasm: `ultowcs`, `PointToTextW`, `RectToTextW`, `ftowcs`, `SystemTimeToCommaSeparatedTime`]

Decimal without padding; points `x,y`; rects `l,t,r,b`; scales `X,Y` in percent, `%.2f` with trailing zeros cut;
times `Y,M,D,h,m,s` local without padding, `0,0,0,0,0,0` when unknown; booleans as the name has them (`1`/`0`,
`true`/`false`, `hidden`/`""`, `auto`). Units in Sumika: positions and sizes on the desk are CSS px of the viewport
(the unit `%screenwidth` uses); balloon metrics are balloon-image px [decision].

## 6. Set

| Name | ssp.exe | Sumika |
|---|---|---|
| `currentghost.scope(N).surface.num` | like `\s[]` (`SetSurfaceChar`, the text as given) [disasm 0x6486FB] | like `\s[VALUE]` on scope N |
| `currentghost.balloon.scope(N).num` | `wtol`; `< 0` hides, else that balloon [disasm 0x5CA68C–0x5CA6C1] | like `\b[id]` on scope N |
| `….ext.KEY` | `GET property.set` [R0 KEY, R1 VALUE] to the **caller**, through GetStringShiori (`GET String` to a 2.x SHIORI, EV §5.5); 2xx = success [disasm 0x648C7E–0x648D31] | same |
| `scope(N).animation.num / seriko.defaultsurface / balloon.defaultsurface / bind.menu`, `mousecursor*`, `balloon.scope(N).defaultsurface`, `balloon.mousecursor*`, `seriko.*` (defaultsurface, cursor paths, tooltip texts, `sticky-window`, `zorder`), `sound….position / playing / pause`, `shelllist(…).menu` | settable | logged once "not supported yet", nothing changes [decision; no corpus ghost writes any] |

A write through `ghostlist(X).…` or `activeghostlist(X).…` acts on the **calling** ghost, not on X
(`SPGhostProp::VarSet` passes the caller on) [disasm 0x6C45E7]: copied [decision: faithful; no corpus ghost writes].
Every other name fails. A failed or refused Set changes nothing, and the script never sees the result.

## 7. Later (fail until Sumika has the data)

`scope(N).animation.num`, `scope(N).surface(M).rect`, `mousecursor*` (both families), `seriko.*` (cursor and
tooltip lists, `surfacelist.*`, `sticky-window`, `zorder`), `sound*`, balloon `background.color`, `scaling`,
`scope(N).count` and the balloon description names `index(I).*`, `recommended.*`, other ghosts' `craftmanurl` /
`homeurl` (their `icon` works: §5.4), and the %-variables of §2.3 that Sumika leaves as text. No corpus ghost reads any of them
[corpus, 320 archives + the site].

## 8. Decisions

- `%username` with no answer from the ghost: the nickname the visitor stored in the Preferences box (else the name),
  else `user`; no `OnNotifyUserInfo` before the visitor saves the box once [decision].
- `\![open,con…]` pages: `setup`, none or an unknown word open the Preferences box; the 16 pages Sumika has no box for
  (`ghost`, `biff`, `talk`, `display`…) open nothing and are logged once (sakurascript.md §5.9) [decision].
- `baseware.version` = `SSP/2.9.08 (sumika-<VERSION>; Web)` and `system.platform` = `ssp.exe`; `basewareversion`
  stays `2.9.8.0` [decision].
- The "untrusted script" gate of `\![get|set,property]` and `\![open]` after an OnTranslate rewrite is not copied:
  taken literally it would refuse them in every ghost whose OnTranslate answers (emily4's does), which is unlikely;
  ghost+0x3CE0 or the return value must differ in practice [disasm `TranslateScript` 0x63BCAB–0x63BCCD; decision].
- The browser stands-ins of §5.5 (locale, monitor, cursor, uptime, no CPU / memory / disk / addresses), the units of
  §5.9, `ghostlist` order, IDs and paths (§5.2), the expansion bound (§2.2), metrics before the first show (§5.7).
- SSP's word list (§2.4): SSP's own `data/word_compatible.txt`, copied byte for byte to
  `site/sumika/word_compatible.txt` and served from there, so a publisher can leave it out without a rebuild (SSP's
  readme asks people not to redistribute parts cut out of SSP); without it a word nobody answers stays as written, as
  in an SSP without the file. **The repository does not hold it**: a publisher copies it from an SSP install
  [decision]. Also [decision]: a missing
  file is not fetched again on that page; Math.random for MT19937 (the word picks, `%et`, `%wronghour`).

## 9. Checks in ssp.exe, and open questions

- C2 (developer palette, Script input; needs "Enable functions for developers"):
  `\s[5]%property[currentghost.scope(0).surface.num]\e` should print the surface from before 5;
  `\q[%username,X]\e` should show the literal `%username` as the choice; `%property[baseware.version]\e` shows SSP's
  exact text.
- C3: etherism side by side, the same balloon: the length of the main menu header's rule in SSP and in Sumika.
- The untrusted gate above (emily4's first boot opens the settings box in SSP, or not).
- Not traced: SSP's balloon line height; ghost+0x3CE0's writer; the order behind `ghostlist.index(N)` (Sumika: Change
  ghost ▸'s); whether SSP's tag splitter trims spaces around `\![get,property]` names (the dispatcher does not); who
  registers the kind-6 command listeners that may take a get's event first [disasm 0x62E253].

# Shell definition files (descript.txt, surfaces*.txt) and SSP-compatible rendering

Spec for the Sumika canvas renderer. Target: render Tsubasa's shell (`site/ghost/tsubasa/shell/master/`) the way SSP 2.9.x does, and leave room for other ghosts.

Priority legend: **P0** = Tsubasa uses it, so she needs it. **P1** = common in other ghosts. **P2** = rare.
Confidence tags: **[doc]** = stated in UKADOC or the MATERIA spec. **[src]** = seen in another implementation's source. **[ssp]** = evidence from the SSP 2.9.08f binary or its message files. **[tsu]** = inferred from how Tsubasa's files are written, i.e. her shell only works if SSP behaves this way. **[guess]** = Sumika's own choice, with no evidence for SSP's behaviour.

Everything here is paraphrased. Sources are listed in §9.

Not in the repository: Tsubasa's shell (`site/ghost/tsubasa/`: CLAUDE.md "The ghosts Sumika was tested with"), the
corpus (`tests/corpus/`) and the scripts and renders in `docs/research/scratch/`. These are development material, cited
as the sources (CLAUDE.md "Project rules").

---

## 0. Key facts for implementers (read first)

1. **Four `surfaces*.txt` files, two syntaxes.** `surfaces.txt` and `surfaces3.txt` use the new SERIKO/2.0 syntax (`descript{version,1}`). `surfaces2.txt` and `surfaces4.txt` have no `descript` block and use the **old SERIKO/1.x syntax**, where waits are in units of 10 ms. Each file carries its own charset and version. **P0.**
2. **The same surface is defined in several blocks, and the blocks must be merged.** 444 of her 556 text-defined surfaces appear in 2–4 non-`append` blocks, for example `surface0` (blink and mouth), then `surface0,1,2,5,…` (collisions and dress-up), then `surface0-4,6,8,…` (an animated cat tail). SSP logs "defined twice" but still merges them [ssp][tsu]. **P0.**
3. **Expanding the blocks naively explodes the data.** The multi-ID blocks expand to **191,987 (surface × animation) definitions** and about 200k `insert` patterns. Parse each block **once** and let surfaces hold references to blocks. Merge lazily, per surface, when that surface is first displayed. **P0.**
4. **Dress-up (MAYUNA) is the core of her shell.** There are 3,885 bind groups: 230 for sakura in 21 categories, plus mini-game "characters" `char27`, `char95`–`char100`. The `char100` picross board alone has 3,600 groups in 900 categories. The shell uses `add`, `reduce` and **`insert`**, nested up to 3 levels: the veil inserts the socks, which insert the underwear. The corpus has 3,292 `\![bind]` tags. **P0.**
5. **Her `insert` is written as `insert,0,0,ID`.** The ID sits in the *x* field. This is the mechanical conversion of the old `0,0,insert,ID`. A group reached through an insert is drawn **only at the insertion point**, not again at its own z-slot [tsu]. **P0.**
6. **Pattern indices are sparse.** Examples: `pattern10…21`, `pattern100`, `pattern600`, and `animation251.pattern6` with no `pattern0`. 2,395 animations do not start at index 0, and 7,848 have gaps. Sort patterns by index; never stop at the first gap [tsu]. **P0.**
7. **`-1` in the middle of a sequence clears the layer and the sequence continues.** Her rhythm game chains `…overlay frames → -1 → alternativestart,[next]` (93 distinct animations). If `-1` stopped the animation, the game would break [tsu][doc unofficial]. **P0.**
8. **Transparency.** 756 of the 923 PNGs have a `.pna` alpha mask. The other 167 use the top-left-pixel colour key. No PNG has its own alpha channel. All PNAs are stored as RGB or palette PNGs, never as grayscale-type PNGs. By default, pixels in the key colour that the PNA leaves non-transparent are painted **black** (`seriko.paint_transparent_region_black` default for PNA images) [doc]. **P0.**
9. **The surface canvas must grow in every direction.** 3,601 distinct part placements draw visible pixels outside the base image. For example, the witch hat draws 3,039 px above y=0. 62 surfaces put `element0` at negative x or y. SSP pads the base with transparent pixels, and its `dumpsurface` "fromzero" option exists precisely because composites reach negative coordinates [doc][ssp]. **Keep the surface origin fixed on screen** and let the canvas extend around it. **P0.**
10. **Seven of the surfaces she uses have no image at all:** 12, 930, 942, 945, 952, 961, 962. They are empty, and only their animations (`overlay`, `base`, `move`) draw anything. **P0.**

Reference implementation used to sanity-check §6: `docs/research/scratch/ref_compose.py`. It renders correct-looking outfits (`docs/research/scratch/renders/sheet1.png` … `sheet4.png`). The inventory script is `docs/research/scratch/shell_inventory.py`, and its output is in `shell_inventory.out.txt` and `.json` next to it.

---

## 1. Files, discovery, decoding

### 1.1 Shell folder contents

| File | Meaning | Prio |
|---|---|---|
| `descript.txt` | Shell-wide settings: name, balloon offsets, menu skin, dress-up groups (§4) | P0 |
| `surfaces*.txt` | Surface definitions (§2). Every file whose name starts with `surfaces` and ends with `.txt` is read; the check is case-insensitive [doc] | P0 |
| `surfaceN.png` | Image for surface N. The digits may be zero-padded: `surface0000.png` is surface 0 [doc][tsu] | P0 |
| `surfaceN.pna` / `<name>.pna` | Alpha mask for the PNG with the same base name (§3) | P0 |
| other `*.png` | Element images and menu skin bitmaps | P0 |
| `alias.txt` | Legacy home of the `*.surface.alias` blocks; same syntax as inside surfaces.txt [doc] | P1 |
| `surfacetable.txt`, `surface*s.txt`, `surface*a.txt`, `readme.txt`, `thumbnail.png` | Surface-test listing and other legacy/menu extras. Not needed for rendering | P2 |

Tsubasa's folder: 4 surfaces files, `descript.txt`, 923 `.png` (920 named `surfaceN`, plus 3 menu bitmaps), 756 `.pna`. All file names are lowercase, and there are no duplicate IDs: 874 names are 4-digit padded and 46 have 5 digits.

### 1.2 Index requirements (generated JSON, replacing the folder scan) — P0

* List every file in the shell folder with its exact name and size. The runtime resolves references **case-insensitively** and treats `\` as `/`, because Windows paths are case-insensitive. Build a `lowercasePath → realPath` map.
* Surface ID from filename: `^surface(\d+)\.png$` (case-insensitive), ID = the decimal value with leading zeros allowed (`surface0404.png` → 404). If two files map to the same ID, the choice is unspecified: pick the shorter name and log it [guess].
* Pattern and alias surface references can also have leading zeros (`reduce,0404,…`). Parse them as decimal, never octal. `Number("0404")` is fine; `parseInt(x, 10)` also works.

### 1.3 Text decoding — P0

1. A UTF-8 BOM means UTF-8.
2. Otherwise, if the **first line** is `charset,<name>` (case-insensitive), use that charset. Map `Shift_JIS`/`sjis`/`x-sjis`/`windows-31j`/`cp932` to `TextDecoder('shift_jis')`, which uses the WHATWG CP932 mapping. Map `UTF-8`/`utf8` to `utf-8`. For anything else, pass the label to `TextDecoder` [doc].
3. With no charset line, SSP uses the OS or user default [doc]. Sumika uses: strict UTF-8 if the bytes are valid UTF-8, otherwise `shift_jis` [guess]. Two of Tsubasa's files have no charset line (`surfaces2.txt`, `surfaces4.txt`). All of their non-ASCII text is inside `//` comments, so decoding them cannot go wrong.
4. **Category and part names** in `descript.txt` (e.g. `夏服＋上着ピンク`) must compare equal to the strings Satori emits in `\![bind,…]`. Decode both sides with the same CP932 table. The WHATWG decoder covers both, but watch for U+FF5E vs U+301C style mismatches if any other converter is involved.

### 1.4 Multiple surfaces files — P0

* Load order is "file-name order" [doc]. Sort by **ordinal comparison of upper-cased names**, which mimics the NTFS directory order [guess]. Tsubasa's order is `surfaces.txt`, `surfaces2.txt`, `surfaces3.txt`, `surfaces4.txt`. Note that `surfaces10.txt` would sort before `surfaces2.txt`.
* **Per-file context:** each file has its own `charset` and its own `descript{}` block (`version`, `collision-sort`, `animation-sort`, `maxwidth`) [doc]. A file without a descript block gets the defaults: `version 0` (old syntax), `collision-sort none`, `animation-sort descend`.
* All files feed **one** surface table. A `surface.append` block in a later file can extend surfaces defined in an earlier file.

---

## 2. `surfaces*.txt` grammar (as SSP parses it)

### 2.1 Lines — P0

* Split on CRLF, LF or CR. Trim leading and trailing whitespace (space, tab, and U+3000 [guess]). Indentation is allowed [doc].
* Skip empty lines and lines starting with `//`. More generally, SSP treats any line that is not a header, brace or recognised key as a comment [doc]. So `#…` lines and stray text inside blocks are silently ignored. Log them in debug mode.
* Keys and header names are **case-insensitive**: Tsubasa writes `Version,1`, and her shell only works if that is honoured [tsu]. Values keep their case.
* An entry is `key,value…`: split at the first comma to get the key, then split the rest on commas and trim each field. Exception: bracketed ID lists (§2.10).

### 2.2 Block structure — P0 (official form), P2 (lenient forms)

Official form: a header line, then a line containing only `{`, then entries, then a line containing only `}` [doc]. SSP logs `"{" not found.`, `"}" not found.` and `Extra character after "{" or "}".` [ssp `data/language/english/message.txt`: `log.bracebeginnotfound`, `log.braceendnotfound`, `log.braceextrachar`]. Tsubasa only uses the official form. Her files have no indentation, and every brace is alone on its line.

Parser state machine:

```
pending = null; block = null
for line in lines (after trim):
  if block == null:
     if line == "" or line starts "//": continue
     if this is the first non-empty line and /^charset\s*,/i: continue          // consumed by the decoder
     if line starts "{":            // "{" alone; "{ trailing" = lenient, warn braceextrachar
         block = new Block(header=pending, file, lineNo); pending = null; continue
     if /^(.+?)\s*\{\s*$/ matches:   // P2 lenient: "surface0{" / "surface0 {"; warn
         block = new Block(header=m[1]); continue
     if pending != null: warn('"{" not found after', pending)   // old pending header is dropped
     pending = line
  else:
     if line starts "}": finish(block); block = null; continue       // "} trailing" lenient, warn
     if line == "" or line starts "//": continue
     if line starts "{" and block has lines:                          // P2 lenient: the "}" was forgotten
         prev = block.lines.pop(); warn('"}" not found'); finish(block)
         block = new Block(header=prev.text); continue
     if /^(surface|sakura\.|kero\.|char\d+\.|descript).*\{\s*$/i matches:  // "surface5 {" inside a block, likewise
         warn('"}" not found'); finish(block); block = new Block(header=line minus "{"); continue
     block.lines.push({lineNo, text: line})
at EOF: if block: warn('"}" not found'); finish(block)               // lenient
```

The forgotten-`}` rule comes from the ghost sweep (`tools/sweep.mjs`): type01-Mono's `surface1020` block has no
`}`, so `surface1021` and its `{` landed inside it and her `\s[1021]` showed nothing. A `{` has no meaning inside a block,
and SSP has a "`}` not found" message, so ending the open block there is the only reading [infer: not compared with
SSP].

`finish(block)` routes the block by its header (case-insensitive):

| Header | Meaning | Prio |
|---|---|---|
| `descript` | Per-file settings (§2.6) | P0 |
| `surface<idlist>` | Surface definition(s) (§2.4, §2.5) | P0 |
| `surface.append<idlist>` | Extra lines for surfaces that already exist (§2.5) | P1 |
| `sakura.surface.alias`, `kero.surface.alias`, `char<N>.surface.alias` | Surface aliases (§2.15) | P1 |
| `sakura.cursor`, `kero.cursor`, `char<N>.cursor` | Mouse cursors per collision (§2.16) | P0 (Tsubasa has `sakura.cursor`) |
| `sakura.tooltips`, `kero.tooltips`, `char<N>.tooltips` (any name starting with `tooltip`, any case [disasm]) | Tooltips per collision (§2.16) | implemented |
| anything else / null header | Ignore and log | — |

### 2.3 Scope names (used in headers and in descript.txt)

`sakura` = scope 0, `kero` = scope 1, `char<N>` = scope N (N ≥ 2). Tsubasa uses `char27`, `char95`–`char100`. Sumika treats `char0`/`char1` as synonyms of sakura/kero [guess].

### 2.4 Surface ID lists — P0

```
idlist := item ("," item)*          ; whitespace around items tolerated [guess]
item   := ["!"] range | "surface" N  ; "surface1,surface3" is the MATERIA form [doc]
range  := N | N "-" M               ; inclusive
```

* Result = (union of the non-`!` items) minus (union of the `!` items). An exclusion applies **no matter where it appears** in the list: `surface1-10,!2-4,3` still excludes 3 [doc].
* A range with M < N: swap the ends [guess].
* Tsubasa: 29 multi-ID headers (comma lists), 11 of which use ranges. One header lists about 360 IDs: `surface0-4,6,8,20-24,…,820-861`. She never uses `!` or `surface.append`.

### 2.5 `surface` vs `surface.append`, merging — P0

* `surfaceX{…}`: creates surface X if it does not exist yet; otherwise **appends this block to X** (merge). SSP logs `is defined twice.` [ssp `log.definedtwice`], but Tsubasa depends on the merge [tsu].
* `surface.appendX{…}`: applies only to surfaces that **already exist** at that point, either through an earlier `surface` block (in this or an earlier file) or through a `surfaceX.png` file. Missing IDs in the list are skipped, not created [doc]. This is the documented reason to use `append` with ranges: plain `surface1-3` would create surface 2.
* **Merge rule:** a surface keeps an ordered list of block references. When resolving it, process the blocks in load order:
  * `collisionN`, `collisionexN`, point and balloon keys: map key → value. A later value **replaces** the earlier one but keeps the **first position** (JS `Map` behaves this way) [guess; ninix merges the same way, later wins]. Tsubasa's only repeated keys are `point.kinoko.centerx/y`, with identical values (52 surfaces).
  * `elementN`: **not** a map. Every line is kept in read order, repeats included, and drawn by the element-list rule of §3.4 rule 1 [disasm 2.9.10.3000].
  * `animationA.*`: merged per animation ID. `interval` and `option` are replaced by later lines. `patternP`, `collisionK` and `collisionexK` are replaced per index.
* **Storage (P0, performance):** parse each block once into a `BlockDef`. Each `SurfaceDef` holds `blockRefs[]`. Resolve (merge) a surface on first use and cache the result in an LRU. Never expand blocks × IDs eagerly: Tsubasa would become about 192k animation objects and 313k pattern-line copies.

### 2.6 `descript` block (per file) — P0

| Key | Values / default | Meaning | Prio |
|---|---|---|---|
| `version` | `0` (default) = old SERIKO/1.x syntax; `1` = SERIKO/2.0 | Expected animation syntax for this file [doc]. SSP logs `log.newold` / `log.oldnew` on a mismatch [ssp] | P0 |
| `collision-sort` | `none` (default): earlier-defined collision is on top. `ascend`: lower collision ID on top. `descend`: higher ID on top [doc] | Hit-test priority | P1 |
| `animation-sort` | `descend` (default): higher animation ID is drawn in front. `ascend`: lower ID in front [doc] | Layer order | P1 |
| `maxwidth` | ignored by SSP [doc] | — | P2 |

**Syntax detection:** a line is new-syntax if its key starts with `animation<digits>.`, and old-syntax if it matches `^<digits>(interval|pattern|option|collision|collisionex)`. Parse **each line by its own shape**, with the wait unit following the line's syntax (old ×10). If the shape disagrees with the file's `version`, log a warning [guess: SSP may ignore such lines; Tsubasa never mixes]. Tsubasa: `surfaces.txt` and `surfaces3.txt` have version 1 and contain only new lines (19,574). `surfaces2.txt` and `surfaces4.txt` have no descript block and contain only old lines (28,628).

### 2.7 Keys inside a surface block

| Key (case-insensitive) | Syntax | Meaning | Prio |
|---|---|---|---|
| `elementN` | `elementN,method,file,x,y[,--opt,…]` | Base image composition (§2.8, §3.4) | P0 |
| `animationA.interval` / `Ainterval` | §2.11 | When the animation runs | P0 |
| `animationA.patternP` / `ApatternP` | §2.9, §2.10 | One frame or action | P0 |
| `animationA.option` / `Aoption` | §2.12 | exclusive / background / shared-index | P0 (exclusive) |
| `animationA.collisionK` | `x1,y1,x2,y2,ID` | Collision active only while the animation is active (§6.5) | P0 |
| `animationA.collisionexK` | like `collisionex` | Same, with a shape | P2 |
| `animationA.name` | `name` | Alias for the animation ID in `\i`, `\![anim]`, start/stop (SSP 2.8.24) | P2 |
| `collisionN` | `x1,y1,x2,y2,ID` | Rectangular hit region; ID = name sent to SHIORI | P0 |
| `collisionexN` | `ID,type,coords…` (§2.13) | Shaped hit region | P1 |
| `sakura.balloon.offsetx`/`offsety`, `kero.balloon.offset*`, `balloon.offsetx`/`offsety` (also `offset.x`/`offset.y`) | integer; optional suffix `l`, `r`, `c`, `b` (`offsetxl` …) | Per-surface balloon offset; overrides descript.txt (§4.4) | P1 |
| `point.centerx`/`centery` | integer | Reported to external apps only; default width/2, height/2 | P2 |
| `point.kinoko.centerx`/`centery` | integer | KINOKO plugin anchor. Tsubasa defines it on 434 surfaces: parse and ignore | P0 parse / P2 use |
| `point.basepos.x`/`y` | integer; default (width/2, height) | Anchor point kept fixed when the surface size changes (§6.1) | P1 (default behaviour is P0) |
| `icon.rect` | `x1,y1,x2,y2` | Face-thumbnail crop for the backlog window (2.8.52) | P2 |
| `name` | string | Surface name usable in `\s[name]` (2.8.24) | P2 |

### 2.8 `element` lines — P0

`elementN,method,filename,x,y[,--clipping,l,t,r,b][,--alpha,0-255][,--scaling,…][,--source,…]`

* N is a non-negative integer. Gaps are allowed. N does **not** order the drawing: ssp.exe draws the lines in the order it reads them (§3.4 rule 1) [disasm 2.9.10.3000]. N only matters for `element0`, which replaces surfaceN.png, and for repeats.
* `filename` is relative to the shell folder. Resolve it case-insensitively with `\` → `/`. The `.pna` mask is the same path with a `.pna` extension.
* A name no file has exactly (usually one written without its extension, `element0,overlay,surface0,0,0`) goes through SSP's any-extension search: the written extension is dropped, and the first file of `<name>.*` in name order with an image extension is used [disasm 2.9.10.3000 `SPSurfaceManager::LoadInfo` 0x778443 → `SPSurface::FindLoadableExtension` 0x77d3f0]. Sumika: `Shell.resolveFile` with `core/loadable.js`. Archives that rely on it: shop_robin (37 names), raychel_kisekae (66), and one name each in six others.
* Rules for the base image are in §3.4. Methods are in §3.6. The options `--clipping` (2.8.15), `--alpha` (2.8.37), `--scaling` (2.8.73/82) and `--source` (2.8.41, PSD/TIFF layers) are P2. Tsubasa uses none of them.
* Tsubasa: 935 element lines (883 `overlay`, 52 `reduce`). 508 surfaces have elements, at most 3 each. Typical form: `element0,overlay,surface0000.png,0,0` + `element1,reduce,surface8306.png,0,0` + `element2,overlay,surface1055.png,80,55`.

### 2.9 Animation definitions: new vs old syntax — P0

| | New (SERIKO/2.0, `version,1`) | Old (SERIKO/1.x, `version,0`) |
|---|---|---|
| interval | `animationA.interval,spec` | `Ainterval,spec` |
| pattern | `animationA.patternP,method,surface,wait,x,y[,--opt…]` | `ApatternP,surface,wait,method,x,y` |
| wait unit | 1 ms | **10 ms** (multiply by 10) |
| ID lists | `(1,2)`; SSP also accepts `[1.2]` | `[1.2]` |
| control methods | `start,ID`, `alternativestart,(a,b)` (surface/wait/x/y may be omitted) | `0,0,start,ID`, `0,0,alternativestart,[a.b]` |
| option | `animationA.option,…` | `Aoption,…` |

Sources: [doc] UKADOC "SERIKOの旧定義と新定義について", MATERIA seriko.html. The typo key `ApatturnP` (and `putturn`) is accepted by ninix for old syntax [src]; treat it as P2.

* **Pattern order:** sort by P (numeric). **Gaps and missing `pattern0` are normal** [tsu]. MATERIA's limit of 128 patterns and 128 animations does not apply: Tsubasa uses pattern indices up to 1080 and animation IDs up to 50000.
* The animation ID is just a number; it does not need to be contiguous. The same ID should mean the same thing on every surface of a scope [doc]. Dress-up depends on this.
* An animation with no interval line: ignore it and log [doc: the interval must come first; Sumika accepts it anywhere].
* An animation with an interval but no patterns: ignore it [src ninix].

### 2.10 Pattern field parsing (normative pseudo-code) — P0

```
function parsePattern(syntax, rawValue):
  // 1. extract a bracketed ID list, if any (commas inside must not split fields)
  ids = null
  m = rawValue.match(/[\(\[]\s*([^\)\]]*)[\)\]]/)
  if m: ids = m[1].split(/[,.]/).map(trimInt).filter(isInt)
        rawValue = rawValue.replace(m[0], "")          // remainder for normal splitting
  f = rawValue.split(",").map(trim)
  // 2. normalise to new order: method, surface, wait, x, y, extra...
  if syntax == OLD: f = [f[2], f[0], f[1], f[3], f[4], ...f.slice(5)]
  method = lower(f[0] || "base")                      // empty method in old syntax = base [src ninix]
  method = ALIASES[method] ?? method                   // overlay-fast→overlayfast, overlaymultiply→blend-multiply-fast, overlayscreen→blend-screen-fast
  surf = f[1]; wait = f[2]; x = f[3]; y = f[4]; extra = f.slice(5)  // --alpha,N etc.
  switch method:
    case start, stop, insert:
        // documented: "start,ID"  (ID in surface slot)
        // Tsubasa / mechanical old conversion: "insert,0,0,ID" (ID in x slot)
        id = ids?.[0] ?? (int(surf) != 0 || x === undefined ? int(surf) : int(x))
        return {method, ids:[id], wait:0}
    case alternativestart, alternativestop, parallelstart, parallelstop:
        ids = ids ?? [int(surf)]                       // tolerate a single bare ID
        return {method, ids, wait:0}
    case move:
        return {method, wait: parseWait(wait, syntax), x:int(x)||0, y:int(y)||0}
    default:  // drawing methods incl. base, overlay, add, bind, reduce, replace, interpolate, asis, overlayfast, blend-*
        return {method, surface: resolveSurfaceRef(surf), wait: parseWait(wait, syntax),
                x:int(x)||0, y:int(y)||0, alpha: optAlpha(extra)}

function parseWait(s, syntax):                          // "50", "50-100" (SSP only), missing -> 0
  k = (syntax == OLD) ? 10 : 1
  if /^\s*(\d+)\s*-\s*(\d+)\s*$/: return {min:k*min(a,b), max:k*max(a,b)}
  v = abs(int(s) || 0) * k; return {min:v, max:v}
```

* Surface field values [doc]: `>= 0` is a surface ID. `-1` clears the frame (§6.4): with `base` it restores the original base; with `move` it resets the offset. `-2` stops every *other* running animation and clears this animation's frame. Since SSP 2.8.25 the field may also be a surface alias or name (P2).
* For control methods (`start`, `stop`, `alternative*`, `parallel*`, `insert`), the surface, wait, x and y fields are **ignored**, and the action happens immediately after the previous pattern [doc].
* Tsubasa: every `insert` (10,270 raw lines) is `insert,0,0,ID`. `alternativestart` appears as `alternativestart,[N]` in new syntax (80 lines, single ID in brackets) and as `0,0,alternativestart,[1.2.3…]` in old syntax (10 lines). She never uses `start`, `stop`, `parallel*`, `alternativestop`, wait ranges, `-2` or `--alpha`.

### 2.11 Interval grammar — P0

```
spec  := atom ("+" atom)* ["," number]      ; e.g. "bind+runonce", "random,6", "bind+random,5"
atom  := sometimes | rarely | random | periodic | always | runonce | never | yen-e | talk | starttalk | endtalk | bind
```

* The parameter always comes **last**, even in combinations (`bind+random,5`, not `random,5+bind`). Only one parameterised atom is allowed per spec [doc]. ninix rejects the spec if there are more [src].
* Unknown atoms: ignore and log. `runcount` appears in SSP's keyword table [ssp] but is undocumented: P2/unknown.

| Atom | Trigger (details in §6.4) | Param | Prio |
|---|---|---|---|
| `sometimes` | Each second, start with probability 1/2 (= `random,2`) [doc] | — | P0 |
| `rarely` | Each second, probability 1/4 (= `random,4`) | — | P1 |
| `random,N` | Each second, probability 1/N | N | P0 |
| `periodic,N` | Every N seconds | N | P1 |
| `always` | Start when the surface is shown; restart immediately whenever it ends (loop) | — | P0 |
| `runonce` | Once, when the surface is switched to | — | P0 |
| `never` | Only via `start`/`alternativestart`/`parallelstart`, `\i[ID]` or `\![anim]` | — | P0 |
| `yen-e` | When `\e` (end of script) is reached | — | P1 |
| `talk,N` | Every N characters shown in this scope's balloon. **Tsubasa writes `talk` with no N (233 times)** → default **N = 1** [guess; undocumented] | N | P0 |
| `starttalk` / `endtalk` | When the scope starts or stops talking (SSP 2.7.26) | — | P2 |
| `bind` | Dress-up part (MAYUNA). Static: all patterns are composited at once and waits are ignored [doc] | — | P0 |
| `bind+X` | Animation that only runs while the bind group is ON. It loses the static nature, so waits count [doc] | as X | P0 (`bind+runonce` ×57, `bind+always` ×4 raw lines) |

Tsubasa raw counts: `bind` 11,587; `runonce` 260; `talk` 233; `never` 115; `sometimes` 84; `bind+runonce` 57; `always` 43; `bind+always` 4; `random,6` 3; `random,8` 2; `random,10` 1. She never uses `rarely`, `periodic`, `yen-e` or `starttalk`/`endtalk`.

### 2.12 Options — P0 (exclusive), P2 (others)

`animationA.option,opt[+opt…][,(id,id…)]`

* `exclusive`: when this animation starts, every other animation stops, and no other animation may start until it ends [doc]. With an ID list (SSP), the exclusion is limited to the listed IDs. Undefined for `bind` [doc]: ignore it there. Tsubasa: 33 old-syntax lines, all `exclusive`.
* `background`: draw the animation **behind** the base surface (§6.3). P2.
* `shared-index`: on `\s` switch, an animation with the same ID that has this option on both surfaces continues from the same pattern index (SSP 2.6.02). P2.
* SSP's keyword table also contains prefixes such as `exclu`, `back`, `share`, `multi` [ssp], which suggests SSP matches options by prefix. Sumika matches by full word [guess].

### 2.13 Collisions — P0 (rect), P1 (collisionex)

* `collisionN,x1,y1,x2,y2,ID`: rectangle in surface coordinates (origin = the surface's (0,0), §3.5). If x1 > x2 or y1 > y2, normalise by swapping [guess]. Containment: `x1 <= px < x2 && y1 <= py < y2` [guess; follows the Win32 PtInRect convention, ±1 px].
* `collisionexN,ID,type,…`:
  * `rect,x1,y1,x2,y2`
  * `ellipse,x1,y1,x2,y2` (ellipse inscribed in the box)
  * `circle,cx,cy,r`
  * `polygon,x1,y1,x2,y2,x3,y3,…` (self-intersecting allowed → use the **even-odd** rule [guess, matches Win32 ALTERNATE])
  * `region,file,R,G,B[,true|false]` (pixels of that colour in an image; `true` inverts; SSP 2.5.19; P2)
* The ID is a free string sent as the collision name to SHIORI (`OnMouseClick` etc.). An empty ID (`""`) means "on the character but not on a named part".
* Tsubasa: 2,671 raw `collision` lines (27,271 after expansion) and 472 raw `animationA.collisionK` lines (6,570 expanded). No `collisionex`. Names include Head, Face, Bust, Mouth, Hair, Twintail2, Shoulder, Ear, Cheek, Hand, `P1`…`P900` (picross cells), `Nfairy`, `Treestar` and others.

### 2.14 Points and balloon offsets — see §2.7 and §4.4

### 2.15 Surface aliases — P1

```
sakura.surface.alias
{
smile,[5]
0,[0,1000,2000]
}
```

* The key is any string, including a number. The value is `[id(,id)*]`. When the key is used in `\s[key]`, pick one of the listed IDs uniformly at random [doc]. A numeric key shadows the plain number for that scope [doc MATERIA].
* Aliases apply per scope (`sakura`, `kero`, `charN`). Also read `alias.txt`, which uses the same syntax [doc].
* `surfaceN,newname` lines in `alias.txt` (file-name aliases, MATERIA) are P2. ninix supports them [src].
* Tsubasa: none.

### 2.16 Cursor and tooltip blocks

```
sakura.cursor                       sakura.tooltips
{                                   {
mouseup0,Head,system:hand           Head,Text shown on hover
mousedown0,Head,system:grip         }
}
```

* Cursor keys: `mouseupN` (hovering, button up), `mousedownN` (left button down), `mouserightdownN`, `mousewheelN`, `mousehoverN` (resting). Value = `collisionName,fileOrSystemCursor` [doc].
* System cursors map to CSS: `system:arrow`→`default`, `cross`→`crosshair`, `no`→`not-allowed`, `hand`→`grab`, `grip`→`grabbing`, `finger`→`pointer`, `wait`→`wait`, `text`→`text`, `move`→`move`, `help`→`help`. Map `.cur`/`.ani` files to `url(file), auto`. `.ani` is not supported by browsers, so fall back to `auto` (P2).
* Defaults when no rule matches and the pointer is over a named collision [doc]: mouseup → `finger` (`hand` if the collision name is `bust`, case-insensitive [guess on case]); mousedown → `finger` (`grip` for bust). Elsewhere on the character: `default`.
* **Tsubasa (P0):** one `sakura.cursor` block with 8 lines. **Every line uses index 0** (`mouseup0` four times, for SeeShoulder, SeeArm, SeeBack and SeeWaist). Store the rules **as a list keyed by (event, collisionName)**, ignoring N. If N were the key, only SeeWaist would survive [guess; SSP's handling of duplicate N is unknown].
* Tooltips (implemented; UI §4.8): `collisionName,text`. The block is any brace name whose part after the
  scope starts with `tooltip`, compared without case (`strnicmp` 7 [disasm LoadSurfacePropertiesImpl 0x6ebd8d]).
  Collision names match without case; a later line for a name replaces the earlier one; an empty text deletes it; an
  empty name is ignored [disasm SPSerikoToolTips::Add, SPSerikoToolTipsEntry::Set / Find]. A literal `\n` is a line
  break; SSP also doubles `&` there, which Sumika does not copy [decision: with TTS_NOPREFIX it would show doubled]. The
  shell's line wins over the ghost: SSP asks the `tooltip` resource only for collisions the block leaves out (after
  `\![set,property,currentghost.seriko.tooltip.…]` overrides, not in Sumika yet). Shown after the rest on a named
  collision, once per collision change, with OnMouseHover sent first (EV §4.3). Tsubasa: none; 5 archived shells have
  one (29 lines, one line each) [corpus].

### 2.17 Parsed data model (suggested)

```ts
type ScopeId = number;                 // 0 sakura, 1 kero, N charN
interface FileCtx { name: string; version: 0|1; collisionSort: 'none'|'ascend'|'descend'; animationSort: 'ascend'|'descend'; }
interface BlockDef { file: FileCtx; line: number; entries: Entry[] }   // parsed once, shared by all IDs in the header
interface SurfaceDef { id: number; png?: string; blocks: BlockDef[]; resolved?: ResolvedSurface }
interface ResolvedSurface {
  elements: ElementDef[];                         // one per number, sorted by number
  elementsRead: ElementDef[];                     // every element line in read order, repeats kept (source of the element list)
  collisions: Collision[];                        // first-appearance order (sorted later per collision-sort)
  anims: Map<number, AnimDef>;                    // by animation id
  points: {basepos?: {x:number,y:number}, kinoko?: {...}, center?: {...}};
  balloonOffset: Record<string, number>;          // e.g. "sakura.x", "sakura.xl", "balloon.y"...
  sort: {collision: 'none'|'ascend'|'descend', animation: 'ascend'|'descend'};  // from the file of the first block [guess]
}
interface AnimDef {
  id: number; syntax: 'new'|'old';
  atoms: Set<string>; param?: number;             // interval
  isBind: boolean;                                // 'bind' in atoms
  isPureBind: boolean;                            // atoms == {'bind'}
  exclusive?: true | number[]; background?: boolean; sharedIndex?: boolean;
  patterns: Pattern[];                            // sorted by index (sparse indices kept only for shared-index)
  collisions: Collision[]; name?: string;
}
interface Pattern { index: number; method: string; surface?: number|string; wait: {min:number,max:number};
                    x: number; y: number; ids?: number[]; alpha?: number }
```

---

## 3. Images, transparency, composition methods

### 3.1 Loading pipeline (browser) — P0

```js
const blob = await fetch(url).then(r => r.blob());
const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
```

* Use `colorSpaceConversion: 'none'`. 56 of Tsubasa's PNGs and 4 PNAs carry `gAMA`/`sRGB`/`cHRM` chunks. If the browser applies gamma, mask values change. Colour keys mostly survive, because equal colours stay equal, but **PNA alpha** would not [guess that SSP ignores gAMA; it draws through its own decoder].
* Draw into an `OffscreenCanvas` (`willReadFrequently: true`), read pixels with `getImageData`, apply §3.2, `putImageData`, then keep the result as an `ImageBitmap`, a **premultiplied** "part". Also keep `{width, height}`.
* Load lazily and keep an LRU cache. Decoding all 923 images would cost about 240 MB.
* Optional "opaque" variant (alpha forced to 255, raw RGB) for `asis` (P2).

### 3.2 Alpha rules (decision table) — P0

Let `key` = RGB of pixel (0,0) of the **PNG** [doc]. Let `useSelfAlpha` = the shell descript `seriko.use_self_alpha` (`0`/absent, `1`/`true`, `full`) [doc].

| Case | Alpha | RGB |
|---|---|---|
| `.pna` exists (any `useSelfAlpha`) | PNA gray value (§3.3) | PNG RGB. **If `paintBlack` and RGB == key → (0,0,0)** |
| no `.pna`, `useSelfAlpha` ∈ {1, full}, PNG has an alpha channel or `tRNS` | PNG alpha | PNG RGB. If `paintBlack` and RGB == key and alpha > 0 → black |
| no `.pna`, `useSelfAlpha` = full, no alpha channel | 255 everywhere (no colour key) | PNG RGB |
| otherwise (classic) | 0 where RGB == key, else 255. **The PNG's own alpha channel is ignored** [doc; earlduant guide] | PNG RGB |

* `paintBlack` = descript `seriko.paint_transparent_region_black`. When it is not specified, the default is **1 for PNA-masked images and 0 for self-alpha images** [doc]. Tsubasa specifies neither key, so the classic rows and the PNA row with black paint apply.
* Order when both a PNA and self alpha exist: the PNA wins [guess].
* Where the black rule visibly matters in Tsubasa: 680 of the 756 PNA images use a black key, so painting key pixels black changes nothing there. 667 PNA images have key-coloured pixels with PNA > 0, but the only non-black-key ones are `surface3488-3507` (key 253,220,151; 17–43 semi-transparent edge pixels each), **`surface9486`** (UFO-catcher glass, key 251,251,174; 34,000 px at alpha 128 turn into translucent black instead of translucent cream) and `surface9651` (4 px). Verify against SSP (§8).
* Palette PNGs (2 PNGs, 14 PNAs) are expanded to RGB first. The key is compared on RGB, not on the palette index [guess].
* Without a PNA, matching is exact on RGB (no tolerance).

### 3.3 PNA details — P0

* Same base name, `.pna` extension, same pixel size as the PNG [doc]. If the sizes differ, SSP logs `log.pngpna` ("Size of this PNA is different from its PNG, or the PNA isn't grayscale") [ssp]. Sumika uses the PNA top-left-aligned, clip it, treat missing pixels as alpha 0, and log [guess].
* Gray value → alpha directly: 0 = transparent, 255 = opaque [doc MATERIA shell.html].
* **Tsubasa's PNAs are RGB (742) or palette (14) PNGs, never grayscale-type.** SSP evidently accepts them. Use R when R=G=B. Four files (`surface2255–2258.pna`) have up to 239 pixels where the channels differ by ≤ 32. For those, use luminance `round(0.299R + 0.587G + 0.114B)` [guess; SSP's channel choice is unknown, and the visual impact is negligible].

### 3.4 Base surface construction — P0

`buildBase(id)` returns a `Canvas` with an origin offset `(ox, oy)`: the canvas pixel (0,0) is at surface coordinates (ox, oy).

1. If the resolved surface has **any** `element` lines, it is drawn from its **element list**, onto an **empty** canvas at the origin [disasm 2.9.10.3000]:
   - **The list.** surfaceN.png at (0,0) comes first, if the surface has one; ssp.exe adds it while scanning `surface*.png`, before it reads `surfaces*.txt` (`LoadSurfaceOld` 0x707a01). Then every element line is **appended in the order read**: blocks in load order, `surface.append` blocks and list headers included (`AddSurfaceElement` 0x5b99a0, append 0x5b9c4d). Nothing sorts the list later. The element number does **not** order it: sagiri_tama writes `element1` and `element2` (canvas, head) in a shared block and `element0,overlayfast,<face>` in a later `surface.append` block, so the face paints onto the head.
   - **`element0`** removes the surfaceN.png entry (0x5b9a22). Without an `element0`, **surfaceN.png stays under the elements**; ssp.exe logs `log.compatibility` "Element=0" (`InitFirst` 0x5bfbb5). Nato's surfaces 11 and 24, kamakiri and radeon 1050–1054 rely on it.
   - **A line whose image does not load is skipped**: no record is added, so a missing `element0` file leaves surfaceN.png in place (0x712052). mbr's surfaces 16 and 22 and ssuitcase's 11 name a file `0` that is not there; their png is drawn alone. A surface whose element lines all name missing files, and that has no png, has an empty list: it is image-less (rule 3).
   - **A repeated number** is compared with the first earlier element of that number (method as stored, file, place). If all match, the line is skipped (`log.definedtwice`, 0x5b9b6d). Otherwise it is appended too (0x5b9b83): that_morning writes up to five `element0` lines per surface, all drawn.
   - **Drawing** walks the list in order. The **first image drawn is a plain draw whatever its method**, `asis` included. Every later one uses its own method (`ElementRenderForDrawTask` 0x5b9cc0 draws one element with 0x10002 and several with 0x1000000, which `ElementRender` 0x5b9e00 turns into 0x10002 for the first one drawn, 0x5b9ec5). sagiri_tama, boku, sorane_f1 and type01-Mono start surfaces with `overlayfast`, which would draw nothing onto an empty canvas.
   - **Methods** in element context: `base`, and any method without the drawing bit (`insert`, `move`, `start`, …, or an unknown name such as `bace`), become `overlay`, with a log line (`LoadSurfacePropertiesImpl` 0x711801–0x711824). `add` reads as `overlay`. Sumika also draws the `blend-*` methods as `overlay` here, a simplification.
   - Sumika: `Shell` keeps `elementsRead`; `SurfaceRenderer.elementList()` builds the list, and `base()`, `_sizeRect()`, `baseFiles()` and `sspElements()` all follow it. Known differences: Sumika decides "does not load" by the file being in the shell, while ssp.exe also skips a file that fails to decode, which would keep surfaceN.png [infer]. Sumika ignores element options (`--alpha`, `--source`, …), so it also leaves them out when comparing repeats; ssp.exe compares them (0x5b9b1f–0x5b9b4c). No ghost in the test set uses element options.
2. Else, if `surfaceN.png` exists: the base is that image at (0,0).
3. Else, if the surface is defined in `surfaces*.txt` (or its element lines all name missing files): the base image is **empty**. The surface is still valid, and its animations draw the content [tsu: surfaces 12, 930, 942, 945, 952, 961, 962 are used this way].
   - **Base rectangle** (window size and anchoring, §6.1): it runs from the origin to the right and bottom edges of the
     frames its non-bind animations draw [guess].
   - Frames above or left of the origin do not move its left or top edge; they grow the canvas like overflowing
     overlays (§3.5).
   - Evidence: with a 0×0 rectangle, Tsubasa's playing music box 12 stood below the screen edge, because it only cycles
     13–15 (90×150) at 0,0, and disappeared on play. In SSP it stays where 11 stood [observed].
   - The left/top placements of her game surfaces are unchanged by this rule. For example, 930's fireworks rise 500 px
     above the origin and are placed with `\![move,…,screen,left,top]`.
4. Else: the surface does not exist. `\s[id]` → see §6.2.

The base's extent is the union of the element rectangles with the origin. Negative element offsets extend the canvas to negative coordinates. Examples: `surface521-527` put `element0` at (-50,0); `surface600` at (-10,0); `surface9425` puts element1 at (-40,-40). Cache `buildBase` per surface ID.

### 3.5 Coordinate system and canvas growth — P0

* All coordinates in `surfaces.txt` (element x/y, pattern x/y, collisions, points) are in **surface space**, whose origin is the surface's (0,0). For a PNG surface that is the image's top-left corner.
* When a layer extends past the current canvas, the canvas **grows to contain it, in any direction**, padded with transparent pixels [doc: SSP pads the base layer; ssp: `dumpsurface` has a "fromzero" flag that cuts the negative part, so composites do reach negative coordinates]. `reduce` never grows the canvas, because everything outside its layer becomes transparent anyway.
* The **screen position of surface (0,0) does not move** when the canvas grows. The window or page anchor uses the **base rectangle** (§6.1), not the grown canvas [guess, consistent with Tsubasa's design: the witch hat at y=-50 and the pocky part hidden at y=+1000 on surface 48 only look right if the origin stays put].
* Implementation: compute the bounding box of all layers to be drawn first (cheap rectangle math), allocate or reuse a canvas of that size, then draw with `translate(-minX, -minY)`. Position the `<canvas>` element at `(anchorX + minX, anchorY + minY)` in CSS pixels.

### 3.6 Composition methods

"dst" is the canvas so far (the *base layer*), "src" is the part (the *new layer*) at (x, y). In **element** and **bind** context, dst is everything composited so far, step by step. In **normal animation** context, each frame is one layer drawn over the base and the lower layers. A frame does **not** accumulate with the previous frame of the same animation [doc].

| Method | Semantics [doc] | Canvas 2D implementation | Contexts | Prio |
|---|---|---|---|---|
| `overlay` | Draw src over dst | `globalCompositeOperation='source-over'` + `drawImage` | elem / bind / anim | P0 |
| `add`, `bind` | Same as overlay (dress-up names) | as overlay | bind (elem: tolerated) | P0 (`add`) |
| `base` | Anim: the frame **replaces the base surface** for this animation's duration; x/y ignored; collisions switch to the frame surface's. Bind: valid only as the **first** pattern (replaces the base while the bind is ON); later `base` = overlay. Elem: overlay | replace the base input of §6.3 | anim / bind | P0 (anim, 124 raw lines) |
| `reduce` | Multiply dst alpha by src alpha; src RGB ignored; **outside src's rectangle counts as transparent**, so the whole rest of dst is erased | `'destination-in'` + `drawImage`. Browsers clear outside the drawn image for this op; test it, else clear manually | elem / bind / anim | P0 |
| `interpolate` | Draw src only where dst is transparent; partial where dst is semi-transparent (opposite of overlayfast) | `'destination-over'` | all | P0 (cat tail, 32 raw lines) |
| `overlayfast` (`overlay-fast`) | Draw src only over dst's opaque area, weighted by dst alpha; dst outline unchanged | `'source-atop'` | all | P1 |
| `replace` | Inside src's rectangle, dst := src including transparent pixels; outside, untouched | `clearRect(rect)` then `'source-over'` | all | P1 |
| `asis` | Like overlay but **ignoring src transparency** (key colour / PNA / alpha) | draw the opaque variant with `'source-over'` | all | P2 |
| `blend-<mode>` (multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity, add, subtract, divide, linear-*, vivid/pin-light, hard-mix, darker/lighter-color, add-glow, color-dodge-glow, dither) | Photoshop-style blend; the outline grows like overlay | Canvas has blend modes for the first 15 (`'multiply'` …); others need per-pixel code | all | P2 |
| `blend-<mode>-fast` (`overlaymultiply`, `overlayscreen`) | Blend restricted to dst's opaque area (dst alpha unchanged) | blend into a temp copy of dst, then mask with dst alpha (`destination-in`) and draw back | all | P2 |
| `move` | Anim only: shift the whole character window by (x, y) relative to its **original** position (not cumulative); surface field ignored | CSS transform of the character element | anim | P0 (2,312 raw lines) |
| `scaling` | Anim only: scale the character window (factors in %, decimals allowed) | CSS scale | anim | P2 |
| `insert,ID` | Bind only: draw bind group ID **here** (§6.3) | recursion | bind | P0 |
| `start`/`stop`/`alternative*`/`parallel*` | Control (§6.4) | — | anim (ignored in bind/elem [doc]) | P0 (`alternativestart`) |
| `import,file,wait,x,y` | Plays an APNG/GIF/WebP in parallel (2.7.50) | `<img>` overlay | anim | P2 |
| `auto` | PSD-layer inference with `--source` | — | elem | P2 |
| unknown | Treat as overlay and log [doc: SSP rewrites invalid methods as overlay] | | | — |

Tsubasa uses `overlay`, `add`, `insert`, `reduce`, `interpolate`, `base`, `move` and `alternativestart` (raw counts in §5). She uses no `bind`-method, `overlayfast`, `replace`, `asis` or `blend-*`.

### 3.7 Parts that are themselves composite surfaces — P0 / P2

* A pattern's surface ID refers to the **surface**, not to a file. If that surface has elements, the element composite is used as one image (SSP 2.3.53+) [doc]. The part's own origin offset applies: draw at `(x + part.ox, y + part.oy)` [guess].
* Animations defined *on the part surface* are ignored, **except** its `bind` animations, which SSP applies using the current bind state ("multi-level dress-up"). Circular references are skipped [doc]. Tsubasa: 0 parts carry their own bind animations, so this is P2.
* A part ID with no image and no elements draws nothing.

---

## 4. Shell `descript.txt`

### 4.1 Syntax — P0

Lines of `key,value`. A `charset` first line, `//` comments, keys case-insensitive [guess]. Values may contain commas (bindgroup names). Strings starting with `\` or `%` are dropped as a security measure unless escaped as `\\` / `\%` [doc]: apply this to display strings (names). `type` and `name` are mandatory [doc].

### 4.2 Keys table

| Key | Value / default | Meaning | Prio (Tsubasa) |
|---|---|---|---|
| `charset` | encoding | §1.3 | P0 (Shift_JIS) |
| `type` | `shell` | file-set type | P0 |
| `name` | text | shell name (Tsubasa: `master`) | P0 |
| `id`, `craftman`, `craftmanw`, `craftmanurl`, `homeurl`, `readme`, `readme.charset` | — | metadata (the readme window, UI §2.11) | P2 |
| `menu` (unprefixed) | contains `hid` (`menu,hidden`) | leaves this shell out of Shell ▸ [disasm]; **not** a dress-up mode (that is `<scope>.menu`) | P2 |
| `sakura.name`, `sakura.name2`, `kero.name`, `char*.name` | override the ghost's names | — | P2 |
| `sakura.balloon.offsetx`/`offsety`, `kero.balloon.offset*` | integers; optional suffix `l`/`r`/`c`/`b` | default balloon offsets (§4.4) | **P0** (x=2, y=14) |
| `sakura.balloon.alignment`, `kero.balloon.alignment` | `none` (auto) / `left` / `right` | balloon side | P1 |
| `*.balloon.dontmove`, `*.balloon.syncscale` | 1/true | user-move lock / scale link | P2 |
| `seriko.alignmenttodesktop`, `sakura.seriko.…`, `kero.seriko.…`, **`char*.seriko.alignmenttodesktop`** | `top` / `bottom` / `free` | window docking. Priority: ghost global < ghost per-scope < shell global < shell per-scope [doc] | **P0** (`char99 … free`) |
| `sakura.defaultx`/`defaulty`, `kero.…`, `char*.…` | px | image base point (default: centre x, bottom y) | P1 |
| `sakura.defaultleft`/`defaulttop`, `kero.…`, **`char*.defaultleft`**/`defaulttop` | px | default screen position; `defaulttop` only with `free` | **P0** (14 chars at `defaultleft,300`) |
| `seriko.zorder`, `seriko.sticky-window` | scope lists | stacking / move together | P2 |
| `seriko.dpi` | 96 default | intended DPI | P2 |
| `seriko.use_self_alpha` | `0` (default) / `1`/`true` / `full` | §3.2 | P1 |
| `seriko.paint_transparent_region_black` | 0/1; default 1 for PNA images, 0 for self-alpha images | §3.2 | P0 (default behaviour) |
| `seriko.force_disable_crossfade` | 1/true | SSP crossfades on surface switch (2.8.43); Sumika doesn't | P2 |
| `menu.font.name`, `menu.font.height` | OS default | owner-draw menu font | P1 |
| **`menu.background.bitmap.filename`**, **`menu.foreground.bitmap.filename`**, **`menu.sidebar.bitmap.filename`** | PNG files | menu skin (background, highlight, sidebar strip) | **P0** (cosmetic) |
| **`menu.background.font.color.r/g/b`**, **`menu.foreground.font.color.r/g/b`**, **`menu.separator.color.r/g/b`**, **`menu.disable.font.color.r/g/b`**, `menu.frame.color.r/g/b` | 0–255. Defaults: OS colours; separator = background font colour; disable = (bg pixel(0,0) + 2·bg font)/3; frame = 0 | menu colours | **P0** (cosmetic; all but frame used) |
| `menu.background.alignment`, `menu.foreground.alignment`, `menu.sidebar.alignment` | `lefttop`/`centertop`/`righttop`/`leftbottom`/`centerbottom`/`rightbottom` (+`repeat-x`/`+repeat-y`); sidebar: `top`/`bottom` (default bottom) | bitmap placement | P1 |
| `sakura.icon.frame.color.*` etc. | — | backlog icon frame | P2 |
| **`<scope>.bindgroupN.name`** | `category,part[,thumbnail]` | dress-up group N = **animation ID N** (§4.3) | **P0** |
| **`<scope>.bindgroupN.default`** | 1/0 (default 0) | initial ON state | **P0** |
| `<scope>.bindgroupN.addid` | `id[,id…]` | groups drawn together with N while N is on; they switch no flag (§4.3) | P1 |
| `<scope>.bindoptionN.group`, also unnumbered `<scope>.bindoption.group` | `category,opt[+opt]` with `mustselect`, `multiple` | category rules. N is a plain counter: **every line counts**, repeated keys included (DSLGS writes `sakura.bindoption0.group` three times; etherism and sagiri_tama write it unnumbered) [infer: SSP parses the descript line by line]; a later line for the same category replaces its options [guess: no corpus ghost repeats a category] | P1 |
| **`<scope>.menuitemN`** | bind-group ID, or anything not starting with a digit (`-`, `-1`, text) = separator | dress-up menu, **descript file order** (§4.3.1) | **P0** (menu UI) |
| `<scope>.menuitemexN` | `menuName,ID` | item under a submenu named menuName (§4.3.1) | P2 |
| `<scope>.menu` | contains `auto` → auto; contains `hid` → hidden; else (or absent) manual [disasm] | how Clothes/Dressup ▸ lists this scope's parts (§4.3.1) | P1 |

Tsubasa's descript.txt has 4,106 lines: 3,885 `bindgroup*.name`, 3 `default` (sakura 0, 51, 30), 80 `sakura.menuitem*`, 6 `charN.menuitem0,-`, 14 `charN.defaultleft`, 1 `char99.seriko.alignmenttodesktop,free`, `sakura.balloon.offsetx/y`, and 3 menu bitmaps plus 12 menu colour keys. Every bindgroup name has the form `category,part,` (empty thumbnail). There are no `bindoption`, `addid`, `kero.*`, `use_self_alpha` or `paint_transparent_region_black` keys.

### 4.3 Dress-up (MAYUNA) state and `\![bind]` — P0

* **Model:** `bindState[scope]: Set<animationId>` (each part's on/off **flag**). Groups are defined per scope: `(scope, N) → {category, part, thumbnail}`. The same N may mean different things in different scopes [doc MAYUNA unofficial]. **Definition order** (the order of the groups' first descript lines, SSP's "entry" order) matters below; `Shell.bindGroups` stays in ascending id, `Shell.bindGroupsInFileOrder` gives definition order (Tsubasa's differ in 13 places).
* **Initial state:** groups with `.default,1`, unless a saved state exists. **Persist** `bindState` per (ghost, shell, scope) in storage and restore it on every page load. SSP keeps dress-up state across sessions, per shell (§4.3.3).
* **A change is a block** [disasm `SPBindProp::ApplyBindBlock`, `SPBindGroup::ValidateEntryFlag`, `CheckPreservedEnableState`]: one `\![bind]` or one menu pick. Its entries are applied, then every touched category is validated, then the **changes are the parts whose flag differs from before the block**, all turned-off parts first, then all turned-on parts (stable; within each group Sumika keeps application order, SSP the parts' menu order [disasm, not reproduced]). A part switched off and back on inside one block is no change and sends no event.
* **Category rule (default):** at most **one** part per category may be ON, and turning all of them OFF is allowed. Turning part P ON turns the other parts of its category OFF [doc: "選択解除可能、複数選択不可"; MAYUNA: a category can only be worn once; SSP `DisableAllEntry` [disasm]]. `bindoption … multiple` allows several. Validation without `multiple` keeps only the first part (definition order) that is on (matters only for a saved state with two parts of a category) [disasm].
* **`mustselect`** does not refuse the "off": when a block leaves the category empty, every part whose `bindgroupN.default` is true is switched **on** again; a category without default parts stays empty [disasm `ValidateEntryFlag`]. So turning off Blue in a Scarf category whose default is Red reports Blue off, then Red on; turning off the default part itself, when it is the only one on, changes nothing.
* **`addid`:** while N is ON the listed groups are drawn too, and stay drawn until **all** of the groups that list them are OFF (reference counting) [doc]. It is a drawing-side expansion: an added group's own flag does not change, so it gets no OnDressupChanged, no check mark and no `1` in OnNotifyDressupInfo [infer: SSP's ApplyBindBlock and ValidateEntryFlag never touch the addid list]. `BindState.isOn(id)` = drawn, `isWorn(id)` = flag; the character views get the drawn changes (`BindState.drawChanges`), the 'bind' events the flag changes. No corpus ghost uses addid.
* **`\![bind,category,part,value]`** [doc list_sakura_script] acts on the current scope (`\0`, `\1`, `\p[N]`):
  * `part` non-empty: `value` 1 = ON (apply the category rule), 0 = OFF, empty or omitted = toggle.
  * `part` empty: applies to the whole category. `0` → every part OFF. Tsubasa uses this 1,560 times, e.g. `\![bind,首,,0]` and the picross reset `\![bind,P1,,0]` × up to 900. `1` with an empty part is undefined: no-op [guess]. Toggle: no-op [guess].
  * Category and part are matched as exact strings after decoding. An unknown category or part is a no-op.
  * Several groups of a scope with the same category **and** part (DSLGS `マフラー/黄色` = groups 205 and 207;
    raychel): a named `\![bind]` reaches **one** of them, the first in SSP's entry order, i.e. the lowest menu position
    (the menuitem / menuitemex walk order, submenu items numbered in place, as `bindCategoryOrder` walks them), then
    the groups no menuitem lists, in definition order; with no menu, definition order alone [disasm `SPBindProp`
    lookup 0x5d8c00: the first match in the entry list, which SSP keeps sorted by menu position (§4.3.2)]. Toggles and
    `,0` reach the same group. `BindState(groups, options, menu)` gets the menu from `Stage.bindState(scope)`
    (`shell.dressupMenu(scope)`). The Clothes/Dressup ▸ menu still shows both rows and switches each by id,
    OnNotifyDressupInfo lists both, and the empty-part form is unchanged. DSLGS's script thus wears 205, the listed
    one, and its menu row is ticked (earlier both were switched and the last one stayed on).
  * A non-numeric `value` (the corpus has `(うにゅうｹﾞｯﾄ)`, a Satori variable that was not set in the harness): SSP's behaviour is unknown. Treat it as `parseInt` → NaN → toggle? or 0? **Open question**; choose 0 [guess].
  * After the change: SHIORI `OnDressupChanged` per changed part (off first, then on), then `OnNotifyDressupInfo` [doc; order disasm]. `\![bind-noevent,…]` (2.8.23) suppresses both. The event details belong to the events doc (EV §4.11). The Stage's 'bind' events carry `origin` (`user` for a menu pick, OnDressupChanged R4) only when the caller passes one (`Stage.setBind(scope, id, on, {origin})`).
  * **Batching (P0 performance):** apply state changes immediately, but **recompose at most once per animation frame**. The picross reset issues up to 900 bind tags in one script.
* **Effect on surfaces:** a bind group N only affects animations with ID N that have `bind` in their interval. If animation N on the current surface is not a bind animation, the state has no visual effect there. Tsubasa: bindgroup 0 (`ポニーテール`, default ON) is a "nothing changed" entry. On the main surfaces, `animation0` is the **blink** (`sometimes`), and the ponytail is drawn in the base image. The other hair groups 1–18 cut the base hair out with `reduce,400` and add new hair.
* On a change, every character view of that scope recomposes. `bind+runonce`/`bind+always` animations start when their group turns ON and stop (layer cleared) when it turns OFF (§6.4).

#### 4.3.1 The dress-up menu data (Clothes/Dressup ▸) [disasm `SPBindProp::ParseEntry`, `CCharWndCode::UpdateBindMenu`, `SPSeriko::GetBindPropCharEnable`]

The menu itself (captions, the greyed "Dressup explorer" row, check marks, `&` doubling) is UI §2.11; this is the data
the shell gives it.

* **The descript is read line by line** (`Shell.descriptLines`, every `[key, value]` in file order with repeats; the
  `Shell.descript` Map keeps the first value of a key, as `parseDescript`). The dress-up keys come from the lines:
  `bindgroup*` (first line of a key wins), every `bindoption` line (§4.2), and the menu records.
* **Mode** = `<scope>.menu`: contains `auto` → auto, contains `hid` → hidden, else manual (`Shell.dressupMode`).
* **Manual** (every Satori ghost in the corpus): the `<scope>.menuitemN` / `menuitemexN` records in **descript file
  order**. N is only a key: a repeated N overwrites the earlier record in place (SSP logs `log.definedtwice`), a new N
  appends; **gaps do not stop the list** (DSLGS 0–12 then 18–40, roommate 0 and 3) [disasm; to check in ssp.exe, §8 item 12].
  * `menuitemN,<value>`: a value starting with a digit is a bind-group id; anything else (`-`, `-1`, text) a separator.
  * `menuitemexN,<menu name>,<id>`: the part goes into a submenu of that name, created at the position of its first
    record; a non-digit id is a separator inside it; fewer than 2 fields → ignored (logged).
  * Ids that name no bind group are dropped (logged); a menuitemex submenu left without a part is dropped
    [disasm `CheckEntry`].
  * Groups no record lists are **not** in the menu (script-only dress-up: 156 of Tsubasa's 230 sakura groups).
  * Label = `category - part`, always, even when the two are equal [disasm] (built by the menu).
  * `Shell.dressupMenu(scope)` → `Array<id | '-' | {menu, items: Array<id | '-'>}>`; Tsubasa's sakura: 80 records,
    6 separators (`[0, 1, 16, 2, 3, 5, 15, 4, 6, 7, '-', 210, …]`).
* **Auto** (only YAYA ghosts use it: raychel_kisekae, ria/pia): categories with 2+ parts first as submenus titled with
  the category (items = part names), a separator, then single-part categories flat (`category - part`, just `part`
  when equal case-insensitively); a scope with one category is all flat; categories in §4.3.2's order. A category row
  is checked while any of its parts is worn [disasm]. SSP's `category(1)` / `(2)` column split is replaced by the
  menu's scrolling [decision].
* **Hidden**: no part items.
* **Enabled** [disasm `GetBindPropCharEnable`]: the root is greyed when the scope has no bind groups, in hidden mode,
  or in manual mode without any `menuitem*` / `menuitemex*` line (`Shell.hasMenuItems`). A scope whose only line is
  `menuitem0,-` (Tsubasa's char27/95/96/98/99/100, Katari's sakura and kero) is therefore **enabled** and holds the
  greyed Explorer and a separator [infer from the code path; **to check in ssp.exe**].
* `Stage.dressupMenu(scope)` → `{mode, enabled, entries}`; manual entries `{type:'part', id, category, part, on}` |
  `{type:'sep'}` | `{type:'menu', name, entries}`; auto entries `{type:'category', category, on, parts: [{id, part,
  on}]}` in category order (the menu puts the 2+-part categories first). `on` is the part's flag (worn), not addid
  drawing. The ✓ is a check mark on every part row [disasm].
* A menu pick is `Stage.setBind(scope, id, undefined, {origin: 'user'})`: one block (toggle, category rules, §4.3);
  refusing it while minimized / passive / induction / `\t` is the event loop's job (EV §4.11).

#### 4.3.2 Category order and OnNotifyDressupInfo [disasm `SPShiori::NotifyBindInfo`, `SPBindEntry::GetNotifyEntry`, `SPBindProp::CheckEntry`]

* **Category order** (`Shell.bindCategoryOrder(scope)`): categories in order of creation (first appearance in
  definition order), **stably sorted by the menu position of their first part in definition order that a menuitem
  lists** (not the lowest position of any part); categories with no listed part follow in creation order. Tsubasa's
  sakura: 髪, アクセサリ１, アクセサリ２, アクセサリ３, 服, エプロン, 足 (listed), then 指輪, 上着, 上着腕, 首, 頬,
  マフラー, お面, 尻尾, ペンダント, 口, 下着, 風呂, テーブル, 料理.
* **OnNotifyDressupInfo references** (`Stage.dressupRefs()` / `BindState.info(scope, {order, hasFile})`): one per part,
  `scope \x01 category \x01 part \x01 options \x01 1|0 \x01 thumbnail`; scope-major (ascending), then categories in that
  order, then parts in definition order (was: ascending group id).
  * options = those of **`default`** (that part's `bindgroupN.default` is true), `mustselect`, `multiple` that apply,
    comma-joined in that order (was: the bindoption words only). Tsubasa: `default` on her three default parts.
  * `1|0` = the part's flag (worn).
  * thumbnail = the third `bindgroupN.name` field **only when the shell has that file** (`shellFiles.has`), else
    empty. SSP sends its resolved path; absolute or relative was not traced, so Sumika sends the name as written [guess].
    Tsubasa's names end in a bare comma: always empty.
  * Tsubasa's handler reads every category she knows in either order (dressup research §5.4); etherism reads the
    fields by position, so the order matters there.

#### 4.3.3 Dress-up state belongs to a shell

* Bind-group ids are local to a shell: group 0 of one shell has nothing to do with group 0 of another. A saved stage
  state records its `shell`; **`Stage` ignores the `binds` of a state saved for another shell** (compared without
  case) and those scopes start from this shell's defaults, while positions, surfaces, alignment, scaling and alpha
  still apply. A state without a `shell` field (none is written that way) still
  restores its binds.
* SSP keeps a dress-up per shell (its `shell.dat`) [code]; Sumika's runtime keeps the other shells' dress-up in the
  ghost state's `shells[shellId].binds` and hands the right one to the new stage (EV §2.6 / CONTRACTS "Runtime").
* Not done (follow-ups): saving off-states too, so that a group added by a shell update gets its default (SSP's
  `SPBindProp::Load` applies defaults to parts missing from the save [disasm]); `\![bind]` ParseBool values and the
  `__ALL__` / empty-part forms with any value; the Dressup Explorer. (A part's thumbnail on hover: ssp-ui.md
  §2.14.)

### 4.4 Balloon offsets (summary for the balloon/layout doc) — P0 (descript), P1 (per surface)

* Per-surface keys (§2.7) override the descript keys [doc]. The suffix lookup is independent for x and y: for a balloon below the shell, `offsetxb` → `offsetxc` → `offsetx`. For a balloon above: `offsetxc` → `offsetx`. Left: `offsetxl` → `offsetx`. Right: `offsetxr` → `offsetx` [doc].
* Sign conventions [doc]. The zero position depends on the side:
  * Left/right: the balloon's top edge is level with the surface's top edge, and the balloon touches the surface's side. +x moves the balloon toward the shell.
  * Above: the balloon's bottom touches the surface's top, centred.
  * Below: the balloon's top touches the surface's bottom.
  * +y is always downward.
* Which "surface edges" are meant when the canvas has grown (§3.5): use the **base rectangle** [guess].

---

## 5. Inventory of Tsubasa's shell (P0 = everything listed here)

Produced by `docs/research/scratch/shell_inventory.py` (parser per §2), `overflow_check.py`, `corpus_shell_tags.py` and ad-hoc checks. Inputs: `site/ghost/tsubasa/shell/master/` and the corpus `final_*.res.txt`.

### 5.1 Files and syntax

| File | Bytes / lines | charset line | descript | Syntax | Blocks |
|---|---|---|---|---|---|
| surfaces.txt | 767,981 / 25,408 | Shift_JIS | `Version,1` | new (18,295 SERIKO lines) | 418 |
| surfaces2.txt | 555,412 / 20,342 | none (comments only non-ASCII) | none → v0 | old (17,290) | 79 |
| surfaces3.txt | 59,494 / 1,518 | Shift_JIS | `Version,1` | new (1,279) | 5 |
| surfaces4.txt | 409,463 / 12,678 | none (pure ASCII) | none → v0 | old (11,338) | 86 |
| descript.txt | 151,970 / 4,106 | Shift_JIS | — | — | — |

* All braces sit alone on their lines. No indentation. 217 `//` comment lines. No inline braces, no unknown blocks, no `surface.append`, no `!` exclusions, no alias or tooltip blocks, one `sakura.cursor` block.
* 585 surface blocks; 29 multi-ID headers (11 with ranges).
* **Surfaces:** 556 defined in text, 920 defined by `surfaceN.png`, **1,423 in total**. 444 surfaces are named by more than one block (max 4). 12 have both a PNG and elements. 7 have neither an image nor elements.

### 5.2 Elements, animations, patterns

| Construct | Raw lines | Expanded (per surface) | Notes |
|---|---|---|---|
| `element` overlay / reduce | 883 / 52 | 508 surfaces with elements (1:136, 2:317, 3:55) | 62 surfaces have negative element offsets |
| interval lines | 12,389 | 191,987 animation defs; 3,983 distinct IDs; max ID 50000 | see §2.11 for the interval mix |
| new-syntax pattern methods | insert 10,270; add 3,167; overlay 1,936; reduce 619; alternativestart 80; interpolate 32; base 4 | insert 201,464; add (bind) 200,447 | max pattern index 1,080; max patterns in one pure bind = 190 |
| old-syntax pattern methods | add 9,063; overlay 7,626; move 2,312; base 120; reduce 69; alternativestart 10 | — | waits ×10 ms |
| `-1` patterns / `-2` | 521 / 0 | — | 93 distinct non-bind animations use `-1` mid-sequence (never 65, bind+runonce 20, always 8) |
| wait ranges `a-b` | 0 | — | all fixed |
| options | 33 `exclusive` (old syntax) | — | |
| `collision` / `animation.collision` / `collisionex` | 2,671 / 472 / 0 | 27,271 / 6,570 / 0 | |
| surface keys besides the above | `point.kinoko.centerx/y` only | 434 surfaces | |
| animations with patterns not starting at 0 / with gaps | — | 2,395 / 7,848 | §0 item 6 |

**Insert facts:** every insert is `insert,0,0,ID`. 41,759 (expanded) inserts reference an ID not defined on that surface → no-op. 208 (expanded) inserts target ID 50 on surfaces where animation 50 is an `always` animation, not a bind → no-op [guess]. Nested inserts exist (veil 17 → socks 30–38 → underwear 26–49; veil 17 → dresses 153… → ring 450). No host draws anything *before* inserting a lower-ID group, so "insert position only" and "drawn once at first reach" give identical pixels for Tsubasa (§6.3).

**Overflow facts:** 3,601 of 14,493 distinct (base, part, x, y) placements put visible pixels outside the base image. By side: top 2,342; left+right 1,091; bottom 69; other combinations 99. Examples: witch hat `add,4087,…,0,-50` (3,039 px above the top); rabbit ears at y=-10; cat tail `interpolate` past the right edge; pocky `add,9008,…,105,1000` on surface 48 (deliberately far below). Reduce masks: `404` (380×430 at -80,-50) and `400`–`409` (220×380 at 0,0) cover 220×380 bases. On the 320-wide surfaces 521–527, `reduce,402` erases everything outside 220 px, and the next pattern `add,408,…,-50,0` redraws the frame. So the "outside counts as transparent" rule is consistent with her data.

### 5.3 Images

| | Count | Detail |
|---|---|---|
| PNG | 923 | 921 RGB 8-bit, 2 palette. **0 with an alpha channel or tRNS.** Non-interlaced. 56 have gAMA; 16 have sRGB/cHRM |
| PNA | 756 | 742 RGB, 14 palette, **0 grayscale-type**. 4 non-gray in content (2255–2258). All sizes match their PNG. 4 have gAMA/sRGB/cHRM |
| PNG without PNA (colour key) | 167 | top-left key |
| PNA images by key colour | 680 black, 24 white, 52 others | the black-paint rule matters only for 3488–3507, 9486, 9651 (§3.2) |
| Base sizes | main character 220×380 (surface 0 and most poses); 90×150 (11, 13–15); **surface10 = 4×4 blank**; games: 336×336 (picross 10011…), 400×300 (UFO 9500…), 630×350 (940/950), 280×408 (960), 330×240 at (-40,-40) (9425 rhythm game); empty: 12, 930, 942, 945, 952, 961, 962 | |

### 5.4 descript.txt

* 3,885 bind groups:

  | Scope | Groups | Categories | Content |
  |---|---|---|---|
  | sakura | 230 | 21 | 髪 hair 18, 服 clothes 112, 下着 underwear 15, 料理 food 15, アクセサリ１/２/３ accessories 13/12/9, 足 legs 7, エプロン apron 7, ペンダント pendant 5, マフラー scarf 4, お面 mask 2, テーブル table 2, 風呂 bath 2, 1 each of 指輪/上着/上着腕/首/頬/口/尻尾 |
  | char27 | 5 | 5 | tanzaku |
  | char95 | 33 | 25 | rhythm-game arrows L/D/U/R 1–5, LA…RA, SC |
  | char96 | 8 | 8 | shelf |
  | char98 | 8 | 4 | UFO prizes |
  | char99 | 1 | 1 | menu "×" |
  | char100 | 3,600 | 900 | `P1`…`P900`, parts `m1`…`m4` (picross cells; animation IDs 11001–14900) |

* Every bind group ID has a bind animation on some surface, and every bind animation ID has a group.
* Defaults: sakura 0 (ponytail), 51 (summer clothes + pink jacket), 30 (pink knee socks).

### 5.5 What the ghost actually drives (corpus `final_*.res.txt`)

* 248 distinct `\s[…]` IDs, all numeric and all defined. `\s[-1]` is used. 212 of these surfaces have bind animations. The 7 empty surfaces above are all used.
* 3,292 `\![bind,…]` tags (1,900 with value 0, 1,368 with value 1, 24 with unexpanded variables; 1,560 with an empty part). No `\![bind-noevent]`, **no `\i[…]`, no `\![anim,…]`**.
* `\p[N]` up to 101: `\p[99]` 5,595×, `\p[100]` 250×, `\p[95]` 100×, … so up to about 25 character windows are in play.
* Rendering-relevant `\!` tags: `\![set,alignmentondesktop,…]` 443×, `\![move,…]` 433×, `\![set,scaling,-100,100]` 11× (horizontal mirror; collisions must mirror too; P0), `\![set,wallpaper]` 12×, `\![set,windowstate]` 5×.

### 5.6 Reference renders (sanity check of §6 on her data)

`docs/research/scratch/ref_compose.py <surface> <bindIds> out.png [anim=patternIndex …]`. The red frame marks the base rectangle.

* `renders/sheet1.png`: surface 0 with no binds / defaults {0,51,30,49} / veil 17 with blink frame and mouth frame / witch hat 12 + maid 173 + apron 183 (canvas grows 50 px up, 20 px right).
* `sheet2.png`: surface 521 (element0 at -50), 521 with hair 2 (reduce + re-add), surface 1 (element face).
* `sheet3.png`: UFO catcher 9500 with prizes, decorative lights 961 (empty base), picross 11011/10011 with cell binds (old-syntax `add`).
* `sheet4.png`: bath surface 600 (element0 at -10), rhythm game 9425 (element1 at -40,-40).

All four renders look like correct outfits, which supports the merge, insert, reduce, colour-key/PNA and growth rules. They are not pixel-verified against SSP (see §8).

---

## 6. Runtime algorithm

### 6.1 Per-character state — P0

```ts
interface CharacterView {
  scope: ScopeId;
  surfaceId: number | -1;               // -1 = hidden
  surf: ResolvedSurface | null;
  base: Canvas;                         // buildBase(surfaceId), cached per id
  anims: Map<number, AnimRuntime>;      // one per AnimDef of the current surface
  exclusive: { owner: number, ids?: Set<number> } | null;
  talkCount: number;
  nextRandomTick: number;               // 1 Hz scheduler for sometimes/rarely/random
  periodicNext: Map<number, number>;    // animId -> due time
  anchor: { x: number, y: number };     // screen/page point of the base point
  scaling: { x: number, y: number };    // \![set,scaling] (%), mirror if negative; a percentage of the user's
                                        // Shell scaling ▸ (UKADOC "ユーザの設定する倍率を100％とした倍率"): the two
                                        // multiply (CharacterView._k = stage.scale × scaling/100; UI §2.9)
  dirty: boolean;
}
interface AnimRuntime {
  def: AnimDef;
  running: boolean; paused: boolean;
  next: number;                         // index into def.patterns
  dueAt: number;                        // ms (performance.now()) when patterns[next] fires
  frame: { surface:number, x:number, y:number, method:string, alpha?:number } | null; // current layer
  baseOverride: number | null;          // surface id set by a 'base' frame
  move: { x:number, y:number } | null;  // set by 'move'
  offset: { x:number, y:number };       // \![anim,offset]
  waiters: Function[];                  // \i[ID,wait], \__w[animation,ID]
}
```

**Anchoring (P0):** the base point is `point.basepos` or, by default, `(baseRect.centerX, baseRect.bottom)` [doc: basepos default = centre x, bottom y]. Here `baseRect` is the base surface's rectangle (§3.4) *before* animations and binds. When the surface changes size, keep the base point fixed on screen. Tsubasa switches between 220×380, 90×150, 4×4 and game surfaces. Placement of the anchor itself (docking to the bottom, `free`, `defaultleft`, `\![move]`) is the window-layout doc's topic.

### 6.2 Surface switch `\s[id]` — P0

```
setSurface(view, id):
  id = resolveAlias(view.scope, id)                        // P1
  if id == -1: stopAll(view); hide(view); return
  if not shell.surfaceExists(id): log; return              // SSP shows an error / keeps the old one [guess]
  if id == view.surfaceId and view is shown: return         // [guess] no restart of runonce (open question)
  stopAll(view)                                             // clears every frame/base/move, releases exclusive
                                                            // (shared-index P2: carry the index for anims flagged on both sides)
  view.surfaceId = id; view.surf = resolve(id); view.base = buildBase(id)
  view.anims = new Map(def.anims → new AnimRuntime)
  now = performance.now()
  for a in anims (ascending id):
     if not eligible(view, a): continue                     // eligible = !isBind || bindOn(scope, id)
     if 'runonce' in atoms or 'always' in atoms: start(view, a, AUTO)
     if 'periodic' in atoms: view.periodicNext.set(a.id, now + 1000*param)
  view.nextRandomTick = now + 1000
  show(view); view.dirty = true
```

### 6.3 Composition (normative pseudo-code) — P0

Run this when `dirty`, at most once per animation frame.

```
compose(view):
  S = view.surf; scope = view.scope
  // 1. base: the base override of the most recently started running anim that has one, else the surface base
  baseCanvas = latestBaseOverride(view) ? buildBase(override) : view.base
  // 2. ordered animation list; default animation-sort 'descend' → draw ascending ids (higher id in front)
  ids = sort(S.anims.keys(), S.sort.animation == 'descend' ? ASC : DESC)
  // 3. groups reserved by inserts: drawn only at their insertion point
  reserved = new Set()
  for id in ids where pureBindOn(id): collectInserts(id, {id})
     collectInserts(h, stack): for p in S.anims[h].patterns where p.method=='insert':
         t = p.ids[0]; if bindOnAndBindAnim(t) && !stack.has(t): reserved.add(t); collectInserts(t, stack ∪ {t})
  // 4. layer list (pass A computes bbox, pass B draws; shown fused here)
  layers = []
  for id in ids where S.anims[id].def.background: emitAnim(id)      // P2: behind the base
  layers.push({kind:'base', canvas: baseCanvas})
  drawn = new Set()
  for id in ids where !S.anims[id].def.background: emitAnim(id)
  emitAnim(id):
     a = view.anims.get(id)
     if a.def.isPureBind:
        if bindOn(scope,id) && !reserved.has(id): drawn.add(id); emitBind(id, {id})
     else if a.frame && eligible(view, a): layers.push(partLayer(a.frame, a.offset))
  emitBind(id, stack):
     first = true
     for p in S.anims[id].patterns (sorted):
        if p.method == 'insert':
           t = p.ids[0]
           if bindOnAndBindAnim(t) && !stack.has(t) && !drawn.has(t): drawn.add(t); emitBind(t, stack ∪ {t})
           // an animated bind (bind+X) as insert target: push its current frame instead [guess, P2]
           continue
        if p.method in CONTROL or p.method == 'move': continue          // invalid in bind [doc]
        if p.surface < 0: continue
        m = (p.method == 'base' && !first) ? 'overlay' : p.method
        if m == 'base': replace layers' base with buildBase(p.surface)   // first pattern only [doc]
        else layers.push({part: getPart(p.surface), x: p.x + off(id).x, y: p.y + off(id).y, method: normalizeBindMethod(m)})
        first = false
  // 5. bbox = union of layer rects except reduce layers; allocate a canvas at (minX,minY); draw layers in order (§3.6)
  // 6. apply view.scaling (mirror / scale) and the sum of active move offsets as a CSS transform about the anchor
```

* `normalizeBindMethod`: `add`, `bind`, `overlay` → overlay. `reduce`, `interpolate`, `replace`, `overlayfast`, `asis`, `blend-*` keep their meaning [doc].
* A reserved group is drawn **only** where it is inserted. If two enabled hosts insert it, it is drawn at the first one reached [tsu, §5.2].
* A pure bind that is ON draws even while no animation is "running". Non-pure binds (`bind+X`) and normal animations draw their **current frame**, if any, at their ID's position in the order. That frame persists after a natural end (§6.4).
* `move`: SSP shifts the window [doc]. When several animations set a move, the most recently applied one wins [guess].
* Cost for Tsubasa: about 5–15 drawImage calls per composition on character surfaces, and up to about 900 on a filled picross board. Optimisation (P1): cache the composite of the base plus all static layers below the lowest animated layer, and invalidate it on bind or surface changes.

### 6.4 Animation scheduler — P0

One scheduler loop for all views. Use `requestAnimationFrame` while the page is visible, with a `setTimeout` fallback. Keep absolute times so frames do not drift.

```
tick(now):
  for view in views:
    // 1 Hz random triggers
    while now >= view.nextRandomTick:
      for a in view.anims where eligible && !a.running:
        N = ('sometimes' in atoms) ? 2 : ('rarely' in atoms) ? 4 : ('random' in atoms) ? param : 0
        if N > 0 && Math.random() * N < 1: start(view, a, AUTO)
      view.nextRandomTick += 1000
    for (id, due) in view.periodicNext: while now >= due: start(view, anims[id], AUTO); due += 1000*param
    // due patterns (process in time order; loop because zero-wait chains run in the same tick)
    for a in view.anims where a.running && !a.paused && now >= a.dueAt: step(view, a, now)
  recompose dirty views

start(view, a, cause):                     // cause: AUTO | EXPLICIT (\i, start-method, \![anim])
  if !eligible(view, a): return
  if view.exclusive && view.exclusive.owner != a.id && (!view.exclusive.ids || view.exclusive.ids.has(a.id)): return   // dropped [doc]
  if a.running:
     if cause == AUTO: return              // no restart on re-trigger [guess; needed for talk lip-flap]
     resetRuntime(a)                       // explicit restart from pattern 0 [guess]
  if a.def.exclusive:
     for b in view.anims where b != a && b.running && !b.def.isPureBind && (a.def.exclusive === true || a.def.exclusive.includes(b.id)):
        stop(view, b)
     view.exclusive = {owner: a.id, ids: a.def.exclusive === true ? undefined : new Set(a.def.exclusive)}
  a.running = true; a.next = 0; a.frame = null; a.baseOverride = null; a.move = null   // [guess: clear on start]
  a.dueAt = now + delayOf(a.def.patterns[0])        // the wait comes BEFORE the frame, pattern 0 included [doc unofficial; tsu surface961]

delayOf(p) = isControl(p) ? 0 : randInt(p.wait.min, p.wait.max) * userWaitPercent/100   // SSP has a user "SERIKO wait %" setting [ssp]

step(view, a, now):
  while a.running && a.next < len && now >= a.dueAt:
    p = a.def.patterns[a.next++]
    apply(view, a, p)
    if !a.running: return                  // stopped by itself (-2 does not stop self) or exclusive changes
    if a.next < len: a.dueAt += delayOf(a.def.patterns[a.next])
  if a.next >= len && a.running: finish(view, a)

apply(view, a, p):
  switch p.method:
    start:             start(view, anim(p.ids[0]), EXPLICIT)
    alternativestart:  start(view, anim(randomChoice(p.ids)), EXPLICIT)
    parallelstart:     for id of p.ids: start(view, anim(id), EXPLICIT)
    stop:              stop(view, anim(p.ids[0]))
    alternativestop:   stop(view, anim(randomChoice(p.ids)))
    parallelstop:      for id of p.ids: stop(view, anim(id))
    insert:            /* ignored outside bind */
    move:              a.move = {x:p.x, y:p.y}; markMoved(view)
    default:           // drawing method
      if p.surface == -1: a.frame = null; a.baseOverride = null; a.move = null          // "back to the pre-animation state", then continue [tsu][doc unofficial]
      else if p.surface == -2: for b in view.anims where b != a && b.running: stop(view, b); a.frame = null; a.baseOverride = null; a.move = null
      else if p.method == 'base': a.baseOverride = p.surface; a.baseStartedAt = now        // x,y ignored
      else: a.frame = {surface:p.surface, x:p.x, y:p.y, method:p.method, alpha:p.alpha}
  view.dirty = true

finish(view, a):                           // natural end
  a.running = false                        // frame / baseOverride / move are KEPT (last frame persists) [doc: bind+runonce text; src ninix]
  if view.exclusive?.owner == a.id: view.exclusive = null
  resolve a.waiters
  if 'always' in atoms && eligible(view, a): start(view, a, AUTO)   // loop; guard: if one cycle took 0 ms, delay the restart by >= 16 ms

stop(view, a):                             // explicit stop / -2 / \![anim,clear] / exclusive / surface change / bind OFF
  a.running = false; a.paused = false; a.frame = null; a.baseOverride = null; a.move = null
  if view.exclusive?.owner == a.id: view.exclusive = null
  resolve a.waiters; view.dirty = true
```

**Trigger sources:**

| Event | Action | Prio |
|---|---|---|
| `\s[id]` | §6.2 (runonce, always, random/periodic timers) | P0 |
| a character shown in scope S's balloon | `view(S).talkCount++`; for each `talk` animation of the current surface: `if talkCount % (param \|\| 1) == 0: start(AUTO)`. Count every visible character added to the balloon; tags do not count [guess] | P0 |
| `\e` reached | every view: start its `yen-e` animations (AUTO) | P1 |
| scope starts / stops talking | `starttalk` / `endtalk` (AUTO) | P2 |
| bind group (scope, N) turns ON | views of that scope: dirty. If animation N is `bind+runonce` or `bind+always` → start (AUTO). `bind+random`/`periodic` become eligible | P0 |
| bind group turns OFF | views of that scope: `stop` animation N if it is `bind+X`; dirty | P0 |
| `\i[ID]` / `\i[ID,wait]` | `start(EXPLICIT)` on the current scope's view; `wait` blocks the script until `finish`/`stop` | P1 |
| `\![anim,clear,ID]` = `\![anim,stop,ID]` | `stop` | P1 |
| `\![anim,pause,ID]` / `resume` | set `paused` (shift `dueAt` by the paused time on resume); valid until `\s` | P1 |
| `\![anim,offset,ID,x,y]` | `a.offset = {x,y}` (works for binds too [doc]); until `\s` | P1 |
| `\__w[animation,ID]` | wait for `finish`/`stop` | P1 |
| `\![anim,add,…]`, `\![anim,add,text,…]` | ad-hoc layers | P2 |
| `\![lock,repaint]` / `unlock` | suspend presentation, not the scheduler [doc] | P1 |

**Reasons behind the non-obvious choices:**

* **Wait before the frame:** `surface961` `2pattern0,9348,1700,overlay` (17 s at 10 ms units) only makes sense if pattern 0's wait is honoured. The unofficial spec says so explicitly. ninix ignores pattern 0's wait [src]; do not copy that.
* **`-1` continues the sequence:** the char95 chain `…,-1 → alternativestart,[next]` [tsu].
* **AUTO triggers do not restart a running animation:** with `talk` (N=1) and Tsubasa's 140 ms mouth cycle (open after 70 ms, close after 70 ms), restarting on every character (~50 ms) would never open the mouth. Ikagaka also ignores talk triggers while the animation runs [src].
* **Last frame persists after a natural end:** Tsubasa has single-frame `runonce` animations that act as permanent decorations: `surface9500/9501` anims 9500/9700 (UFO-catcher parts) and `surface9425` anim 50000 (glow frame `9434` at -40,-40). `surface100` anim 200 ends by overlaying a dress part `2200`. These only make sense if the last frame stays [tsu]. UKADOC's bind+runonce note says the same: the final drawing stays until the surface or the bind state changes [doc]. `surface930`'s firework animations end on `base,10` (a blank 4×4), i.e. "disappear". Whether a `move` offset also persists after a natural end is unknown. The unofficial spec says a move is undone when the animation is "terminated", which matches Sumika's `-1`/stop handling [doc unofficial].

### 6.5 Hit testing — P0

```
hitTest(view, clientX, clientY):
  (sx, sy) = toSurfaceSpace(view, clientX, clientY)   // undo anchor, move offsets, scaling/mirror
  if alphaAt(compositeCanvas, sx, sy) == 0: return PASS_THROUGH        // clicks on transparent pixels go to the page
  for region in orderedCollisions(view): if contains(region, sx, sy): return {name: region.id}
  return {name: ""}                                                    // on the character, no named part

orderedCollisions(view):            // front → back [doc "当たり判定の上下構造"]
  out = []
  animIds = sort(ids of non-background anims, animation-sort == 'descend' ? DESC : ASC)   // front first
  for id in animIds where active(id): out += sortCollisions(anim.collisions)
  base = latestBaseOverride(view) ? resolve(override).collisions : view.surf.collisions   // 'base' frames switch collisions [doc]
  out += sortCollisions(base)
  for id in background anims (same order) where active(id): out += sortCollisions(anim.collisions)
  return out
active(id) = pureBind ? (bindOn && (drawn at own slot or via insert)) : (running || frame != null)   // [guess for "persisting frame"]
sortCollisions(list) = collision-sort none → definition order (first = front); ascend → by index asc; descend → by index desc
```

* **Click-through (P0, browser-specific):** the page under the character must stay usable. Keep `pointer-events: none` on the character canvas. A document-level `pointermove`/`pointerdown` listener (capture phase) runs `alphaAt` against a cached `ImageData` of the composite. When the pointer is over an opaque pixel, switch the canvas to `pointer-events: auto`, set the CSS cursor (§2.16), and route the events to the ghost. SSP's layered window takes the mouse wherever alpha > 0 [guess at the threshold]. Refresh the alpha cache on every recomposition.
* Bind parts and animations change the hit area only through (a) pixel alpha (click-through) and (b) their `animationN.collisionK` lines. Base `collisionN` lines stay the same regardless of what is worn. Tsubasa relies on (b): `animation290.collision37 … Pocky`, `animation17.collision49/50 … Sisterveil`, game buttons `animation9010.collision9010 … Nfairy`, and so on.
* A mirrored view (`\![set,scaling,-100,100]`) must mirror the hit test: map the point back through the same transform. The pivot of SSP's mirror is unknown; use the base point [guess].

### 6.6 Performance and caching checklist — P0

* Parse the text once (about 1.8 MB, 64k lines). Do it in a Worker if it is measured above ~30 ms. Caching the parsed `BlockDef` table in IndexedDB, keyed by file sizes and hashes from the index, is a P1 option.
* Resolve surfaces lazily, with an LRU of resolved surfaces.
* Load images lazily, with an LRU of decoded parts (a byte budget of ~64–128 MB). When a surface is shown, **prefetch** every part it references: its non-bind animation frames and the parts of the bind groups that are ON. Otherwise the first blink or mouth flap flickers.
* Recompose only when dirty, at most once per rAF. Coalesce bind storms.
* Every link click reloads the runtime. To avoid a blank first paint, an optional P1 trick is to store the last composited bitmap per view (PNG data URL, sessionStorage/IndexedDB) and show it until the real composition is ready.

### 6.7 "Move character window" (`Stage.carry`) — P2

SSP inserts the item `ゴースト本体移動` / `Move character window` (id 5106) into every character's menu (UI §2.11). Its
handler puts the pointer on the character's centre and starts a drag without a button press
(`DragStartNoMouseDown`), so the character follows the mouse until the next click [disasm `CCWC_OnCommand`]. A page
cannot move the pointer, so `Stage.carry(scope)` moves the character instead:

* The **centre of its base rect follows the pointer** (`move(x, y)`, viewport px): the first move makes it jump under
  the pointer, the equivalent of SSP placing the pointer on it. Docking applies as in a mouse drag (a bottom-docked
  character only moves sideways). The 'move' events have reason `drag`.
* `drop()` places it: 'move' with reason `dragend`, the position ratio is saved exactly as after a drag (so the
  position survives a reload). `cancel()` puts it back where it was, ratio included ('move' reason `restore`).
  `done` resolves true on a drop, false on a cancel. A new carry cancels the open one; destroying the stage cancels it.
* DOM mode drives it itself [decision]: window `pointermove` (capture) moves; the next `pointerdown` anywhere (a click,
  or a **tap on touch**) drops at that point and is swallowed with the rest of that click (pointerup, mouseup, click,
  and contextmenu for a right click); **Esc** cancels. Meanwhile the character canvases ignore the pointer, so the ghost
  gets no mouse event (no OnMouseMove, no click on the drop), and no key event either: `stage.carrying` is true while
  a handle is open, and the event loop then sends no OnKeyPress and prevents no key (so keys other than Escape stay
  the page's); Escape cancels the carry without reaching the ghost, which stays keyboard-active afterwards (EV §4.6)
  [guess: what SSP sends during its drag was not traced].
* `carrying` goes false after the drop, the cancel, a replacing carry or `destroy()`.
* A character that is not shown and placed cannot be carried (the handle does nothing, `done` resolves false, and
  `carrying` stays false).
* Headless (`dom: false`): the caller drives `move` / `drop` / `cancel` (the tests).

### 6.8 Which shell folder a stage loads

`Stage.create({files, shellId})` loads `shell/<shellId>/` when the ghost has that folder (case-insensitive), else
`shell/master/`, else the first `shell/<dir>/descript.txt` in folder order (ordinal, case-insensitive), and
**`stage.shellId` is the folder actually loaded, in its real case** (a missing id kept there would be stored again
by the runtime and used for paths and the menu's images). Only a ghost with no shell at all keeps the
requested id (nothing is drawn). Which shell a ghost *should* boot (the descript's
`seriko.defaultsurfacedirectoryname`, the visitor's choice) is the runtime's business (EV §2.6); the stage only falls
back.

### 6.9 ssp.exe's per-surface boxes (the collision box) [disasm ssp.exe 2.9.10]

At shell load `SPSeriko::LoadSurfacePicts` runs `ProcessSurfaceDef`, which calls `SPAnimeBase::InitFirst` for every
surface, then `MakeBoundingBox`, which calls `CreateBoundingBox` for every surface [disasm 0x6e5c8c, 0x6e5c93, 0x6e60d9,
0x6eac08]. The collision box they make is read only by `GetCollisionRectVirtual`, whose one caller is
`CCharWndCodeManager::Check` (OnSecondChange R1 / R2, EV §3.2.1), and by the debug drawing `DrawCollisionRectScaled`
0x6ff544. Sumika: `realRect` (compositor.js) and `SurfaceRenderer.sspElements` / `realBox` / `collisionBox`
(render.js), used by `CharacterView.collisionRect`.

1. **An image's real rect** (SPSurface +0x410…+0x41c), filled while the image is RLE-compressed at load: the box of the
   pixels SSP keeps, alpha > 8 (a colour-key image: every pixel but the key; with a .pna: mask byte > 8); right and
   bottom are the index of the last such column and row (inclusive). An image with none gets (w>>1, h>>1, w>>1, h>>1),
   which has no size [disasm `SPSurface_CompressRLETable<PixRead32SelfAlpha>` 0x75e8c0, fallback 0x75ec5c; NoAlpha
   0x75df30, WithAlpha 0x75e3a0]. Pixels with alpha 1–8 are dropped there, so ssp.exe never draws them; Sumika still
   draws them faintly.
2. **The element list** (+0x3d0): the implicit surfaceN.png at (0,0) (element id 0xfa0a1f01), which only an `element0`
   removes, and every `elementN` whatever its method, in the order read (§3.4 rule 1) [disasm 2.9.10.3000
   `AddSurfaceElement` 0x5b99a0; `InitFirst` 0x5bfb2e–0x5bfb7e joins it, and logs `log.compatibility` "Element=0" when
   both kinds are there, 0x5bfbb5]. Drawing and the boxes use the same list (`SurfaceRenderer.elementList`).
3. **The element box** (+0x590): from (MAX, MAX, 0, 0), each element's real rect at its (x, y) joined per axis, an axis
   of zero size skipped; an untouched left or top becomes 0. Unscaled surface px [disasm `InitFirst` 0x5bd475–0x5bd539,
   `SPAnimeSurfaceElement::CalcBoundRectReal` 0x5bd3f0].
4. **The fallback box** (+0x324): a copy of +0x590, or (MAX, MAX, 0, 0) when +0x590 is 0×0, joined (an unconditional
   union, `ExpandToIntersect` 0x5780f0) with L2. L2 runs over every animation, bind groups on or off, and every pattern
   whose surface id is ≥ 0 and whose method type has no bit of the mask: that surface's element box at the pattern's
   (x, y), per axis, zero-size axes skipped; an untouched left or top of L2 is 0, so with no pattern the origin joins.
   The mask is 0x1000000 when the surface has elements (it skips `base`, `move`, `start`, `stop`, `insert`,
   `alternativestart` / `-stop`, `parallelstart` / `-stop`, `import`, `noop`, `scaling`), else 0x4000000 (`base`
   counts) [disasm `CreateBoundingBox` 0x5b5fc7–0x5b60a6, `CreateBoundingBoxSub` 0x5b5e20,
   `SPAnimeBase::CalcBoundRectReal` 0x5b5da0; types from `GetMethodTypeFromText` 0x703c20: base 0x1000000, move
   0x7000001, start 0x7041080, insert 0x7040007, overlay 0x10002, …]. Pattern +0x14 holds the type [disasm
   `SetAnimeDefinition` 0x70556c–0x705577: `GetMethodTypeFromText`'s result stored there; `CreateBoundingBoxSub` reads it
   at 0x5b5e9b].
5. **The collision box** (+0x5b0): +0x590, or +0x324 when +0x590 is narrower or lower than 50 px; then
   `MultiplyRectH` / `MultiplyRectV` (0.8): cx = trunc((l+r)/2), half = trunc(trunc((r−l)·0.8)/2), l = cx−half,
   r = cx+half, the same vertically, every step toward zero [disasm `CreateBoundingBox` 0x5b6292–0x5b6320, 0x5784c0,
   0x578510]. It is written only while it holds the sentinel −32767 (constructor `ResetValue` 0x5b3d81, `LoadAreaNew`
   0x5b4622), so once per surface per load: surface changes, animations and dress-up never change it.
6. **The window canvas offset** (+0x338 / +0x33c), the surface origin's place in its window: `CreateBoundingBox` sets
   it to minus the left / top of the surface's image box joined with its patterns' image boxes (+0x314), and
   `MakeBoundingBox` takes the maximum over the shell, capped at 200 px per axis, and applies it to every surface
   (`SetOffset` 0x5b6340 ignores a smaller value, so a surface that reaches further keeps its own) [disasm 0x5b6166–
   0x5b6182, 0x6eac0d–0x6eac66]. So the origin stays put inside the window across surfaces, which supports §3.5's
   [guess]. Sumika places by the base rect (§6.1) and uses it as the window for the collision rect [infer].

Values on real shells: EV §3.2.1.

---

## 7. Priority summary

| Feature | Prio |
|---|---|
| Multiple surfaces files, per-file charset/version, old+new syntax, ×10 old waits | P0 |
| Block merging; multi-ID headers (lists, ranges); lazy shared blocks | P0 |
| `surface.append`, `!` exclusion, MATERIA `surface1,surface3` lists | P1 / P1 / P2 |
| Elements (overlay, reduce), element0 replaces the PNG, empty text-only surfaces | P0 |
| PNA + colour key + black-paint default; palette/RGB PNAs | P0 |
| `use_self_alpha` (PNG alpha) | P1 |
| Canvas growth in every direction; origin-anchored placement | P0 |
| Intervals: bind, runonce, always, sometimes, random, never, talk (no param → 1), bind+runonce, bind+always | P0 |
| rarely, periodic, yen-e | P1 |
| starttalk/endtalk, other combinations, shared-index, background | P2 |
| Methods overlay/add/insert/reduce/interpolate/base/move/alternativestart | P0 |
| overlayfast, replace, start/stop/parallel*/alternativestop, wait ranges, -2 | P1 |
| asis, blend-*, scaling, import, --alpha and other element options | P2 |
| exclusive | P0 |
| Collisions (rect), animation collisions, sorting, click-through | P0 |
| collisionex (rect/ellipse/circle/polygon) | P1 |
| tooltips (§2.16, UI §4.8) | implemented |
| collisionex region | P2 |
| cursor block (system cursors) | P0 |
| aliases / alias.txt | P1 |
| descript: bind groups, defaults, categories, menuitems, menu skin keys, char*.defaultleft, alignmenttodesktop, balloon offsets | P0 |
| bindoption, addid, defaultx/y, balloon alignment, menu font, per-surface balloon offsets, basepos | P1 |
| Dress-up menu data (§4.3.1), OnNotifyDressupInfo order and options (§4.3.2), dress-up per shell (§4.3.3) | P1 (done) |
| Move character window (§6.7), auto-mode dress-up menus | P2 (done) |

---

## 8. Open questions and how to settle them

**Best verification tool:** SSP 2.9.08f itself. The SakuraScript `\![execute,dumpsurface,--dir=…,--scope=0,"--surface=0-9",--animation=ID]` writes SSP's own composites (and, with `--animation`, every frame) to PNG [doc list_sakura_script]. A small SSTP or script session with Tsubasa loaded, after setting binds with `\![bind]`, would produce golden images for pixel tests. Use `--fromzero=0` to see how SSP handles negative coordinates. Not run yet.

1. **Insert semantics when the target ID is lower than the host and the host draws before inserting.** "Insert position only" (Sumika's rule) vs "drawn once at first reach". Tsubasa has no such case.
2. **Black-paint default on PNA images.** Mainly `surface9486`: is the UFO-catcher glass translucent black or translucent cream in places? This needs a dump.
3. **`talk` without a parameter.** Sumika assumes N=1. Also, which characters count, and are counters reset per script?
4. **Re-trigger semantics:** does `\s[sameId]` restart runonce? Does `\i[ID]` on a running animation restart it?
5. **Does a `move` offset persist after a natural end?** And does a persisting frame keep its `animation.collision` active?
6. **Anchoring when the canvas grows.** Sumika keeps surface (0,0) fixed and measure balloon/alignment edges on the base rectangle. Confirm with `dumpsurface --fromzero=0`, which shows the grown extent, and by observing the window position in SSP.
7. **Non-grayscale PNA channel choice** (4 files, ≤ 32 levels) and **gAMA handling** (56 PNGs).
8. **Duplicate cursor indices** (`mouseup0` × 4): which rules survive in SSP.
9. **`\![bind,cat,,1]` and non-numeric values.** Read from ssp.exe since [disasm]: the value goes through SSP's
   ParseBool (`1`/`true`/`yes`/`on`… on, `0`/`false`/`no`/`off`… off, anything else **toggles**), and an empty part,
   `" "` or `__ALL__` applies the value to every part of the category. Not implemented yet (§4.3.3).
10. **Collision rectangle edge inclusivity** (±1 px) and the **mirror pivot** for `\![set,scaling,-100,100]`.
11. Undocumented keywords in SSP's table (`runcount`, `noop`, `ccyr`) [ssp]: not used by Tsubasa; ignore.
12. **Dress-up, to compare in ssp.exe** (§4.3, §4.3.1–4.3.2):
    * Clothes/Dressup ▸ with DSLGS or roommate: are the items after a numbering gap listed (file order, no stop at the
      gap) [disasm]?
    * A scope whose only line is `menuitem0,-` (Tsubasa's `\p[99]` panel if it opens a menu, Katari): an enabled
      Clothes/Dressup ▸ holding only the greyed Explorer [infer]?
    * DSLGS: turning off the last part of a mustselect category brings its default part back [disasm]; are all three
      repeated `sakura.bindoption0.group` lines honoured, and etherism's unnumbered `bindoption.group` [infer]?
    * A menu pick with SSP's request log: OnNotifyDressupInfo with `default` in the options of the default parts, and
      the categories in menu order [disasm].
    * addid (no corpus ghost): do the added parts get OnDressupChanged [infer: no]?
13. **Move character window** (§6.7): does the click that drops the character reach the ghost (OnMouseClick), and
    does SSP send OnMouseMove while it follows the pointer, or OnKeyPress for a key pressed meanwhile [guess: none]?
14. **A duplicated category/part** (§4.3, DSLGS `マフラー/黄色`): does DSLGS's `\![bind,マフラー,黄色,1]` tick the listed
    row (group 205) in Clothes/Dressup ▸ [disasm]?

---

## 9. Sources

* UKADOC "Shell設定 - surfaces.txt" (https://ssp.shillest.net/ukadoc/manual/descript_shell_surfaces.html): brace rules, comments, surfaces*.txt order, descript block, ID lists and exclusion, append vs surface, base surface and element0 rule, layer and collision order, all keys, intervals and combinations, drawing methods incl. reduce/replace/interpolate semantics and overflow padding, alias, cursor and tooltip blocks.
* UKADOC "Shell設定 - descript.txt" (https://ssp.shillest.net/ukadoc/manual/descript_shell.html): all descript keys, bindgroup/bindoption/addid/menuitem, use_self_alpha, paint_transparent_region_black, balloon offset suffixes.
* UKADOC "Sakura Script" (https://ssp.shillest.net/ukadoc/manual/list_sakura_script.html): `\s`, `\i`, `\![anim,…]`, `\![bind]`, `\![bind-noevent]`, `\![lock,repaint]`, `\![set,scaling]`, `\![execute,dumpsurface]` (fromzero flag).
* MATERIA specs: http://usada.sakura.vg/contents/seriko.html (SERIKO 1.2–1.10: units, start/alternativestart/-2/insert/exclusive/random), http://usada.sakura.vg/contents/shell.html (colour key, PNA = grayscale alpha, alias).
* Unofficial specs at ooyashima.net (https://www.ooyashima.net/db/seriko.html, mayuna.html, element.html): wait-before-frame, -1 mid-animation, move undone on terminate, category exclusivity, element0 method ignored.
* earlduant shell guide (https://earlduant.github.io/ukagaka-shell-description/surfaces.html): without use_self_alpha the PNG alpha is ignored and the colour key applies.
* ninix-kagari (https://github.com/Tatakinov/ninix-kagari): `lib/ninix/home.rb` `read_surfaces_txt` / `read_surface_info` (inline brace, merge, append); `lib/ninix/seriko.rb` `get_actors`, `MultipleActor#update` (pattern parsing, old ×10 waits, random as a per-second geometric process); `lib/ninix/surface.rb` (`OPERATOR` table, `compose_elements`, collisionex parsing).
* Ikagaka ikagaka-shell-state (https://github.com/Ikagaka/ikagaka-shell-state): `src/Renderer/Renderer.ts` (canvas growth in all directions with basePos, composite operations); `src/State/SurfaceState.ts` (talk not restarted while playing).
* SSP 2.9.08f binary and data: `data/language/english/message.txt` (`log.definedtwice`, `log.braceextrachar`, `log.newold`, `log.oldnew`, `log.pngpna`, `info.serikowait`); keyword string table in `ssp.exe` (interval, method and option keywords incl. `runcount`, `noop`, prefix options).
* Tsubasa data: `site/ghost/tsubasa/shell/master/*`, corpus `tests/corpus/final_*.res.txt`. Scripts and outputs: `docs/research/scratch/shell_inventory.py` (+ `.out.txt`, `.json`), `overflow_check.py`, `corpus_shell_tags.py`, `ref_compose.py`, `renders/`.

# Balloon skins and SSP text rendering: spec for the Sumika DOM balloon

Status: research spec, written for implementers. Target: SSP 2.9.x behaviour (reference install: SSP 2.9.08f).

Priorities: **P0** = Tsubasa needs it. **P1** = common in other ghosts. **P2** = rare, or no meaning in a browser.

Confidence tags:
- **[doc]**: stated in UKADOC.
- **[corpus]**: derived from Tsubasa's real `satori.dll` output, from the layouts her authors tuned for SSP.
- **[exe]**: seen in the `ssp.exe` 2.9.08f string or symbol table, or in `ssp.map`.
- **[ninix]** or **[ikagaka]**: what another baseware does. This is not authoritative.
- **[disasm]**: read from `ssp.exe` 2.9.08f's disassembly, with function names from its linker map `ssp.map`. The
  control flow is reliable; what a field means is inferred.
- **[infer]**: inferred from code or docs, not observed.
- **[guess]**: Sumika's choice, made without evidence. It needs verification (see §11, §12.5).
- **[decision]**: a deliberate browser deviation or product choice of Sumika's.
- **[observed]**: seen in a running ssp.exe; it beats every other tag.

Sources used:
- UKADOC manual pages: `descript_balloon.html`, `manual_balloon.html`, `list_sakura_script.html`, `descript_shell.html`, `descript_shell_surfaces.html`, `descript_ghost.html`, `descript_install.html`, `list_propertysystem.html`, `list_shiori_event.html`, `list_shiori_resource.html`. Local text copies are in `docs/research/scratch/ukadoc/`.
- SSP help: `ssphelp/config-talk.html` and the other `config-*.html` pages. Copies are in `docs/research/scratch/balloon/`.
- ponapalt's blog post "3人以上のキャラ向けバルーン" (2021-12-16).
- ninix-kagari `lib/ninix/balloon.rb`.
- Ikagaka `Balloon.js/src/BalloonSurface.ts`.
- The corpus `final_{master,bath,date,meal}.res.txt`: 7,334 SHIORI responses.
- The LightBlue files and SSP's bundled balloons `ssp`, `emily4` and `ssp_vertical`.

Helper scripts are in `docs/research/scratch/` (`pnginfo.py`, `tagcount.py`, `tagdetail.py`, `lforms.py`, `linelen.py`, `bscope.py`).

Not in the repository: the copies and scripts in `docs/research/scratch/`, the corpus (`tests/corpus/`) and Tsubasa's
files with her LightBlue balloon (`site/ghost/tsubasa/`). These are development material, cited as the sources
(CLAUDE.md "Project rules").

---

## 0. Most important findings (read first)

1. **Image naming** [doc]. The image index for `\b[id]` is `id + (side == right ? 1 : 0)`. Use `balloons*` for `\0`, `balloonk*` for `\1`, and `balloonp<N>def*` for `\p[N]` (N ≥ 2). The fallback chain is `p → k → s`. Even indices are placed on the **left** of the character, with the tail pointing right. LightBlue has no `balloonp*` files, so every `\p[N≥2]` uses `balloonk*`.
2. **Two coordinate systems** [corpus, proven by the 2048 board].
   - `\_b[file,x,y]` uses **balloon-image** pixels, with (0,0) at the top-left of the balloon bitmap.
   - `\_l[x,y]` uses **text-origin** pixels, with (0,0) at `(origin.x, origin.y)`, which is (23,13) in LightBlue.
3. **Line height is 14 px for 12 px text** (font height + 2) [corpus]. Images add **no** gap: a line holding a 40 px image advances exactly 40.
4. **Layout model** [corpus; seven independent layouts reproduce exactly, see §3.10].
   - The pen y marks the **top** of the current line.
   - The advance of `\n` and of an automatic wrap is the maximum height of the elements placed since the last `\_l` or line break (the "segment"). The floor is the current font's text line height.
   - An inline image is always placed where the pen is, even if it crosses the wrap point. If the pen x is past the wrap point **after** the element, the line breaks immediately.
   - `\n` returns x to 0, not to the last `\_l` x.
5. **MS Gothic metrics** [doc][corpus]. The default font is "ＭＳ ゴシック" at 12 px. Tsubasa's padding and centring are tuned to its metrics:
   - A character that is double-byte in CP932 is **h** wide.
   - A single-byte character (ASCII, half-width kana) is **round(h/2)** wide. A space at `\f[height,3]` is therefore 2 px, and the ghost's own frame coordinates depend on this.
   - This includes ambiguous characters such as `← → ↓ ― ※ … ♪ ×`, which are full width. They appear thousands of times.
   - Every character in the corpus is in CP932.
   - Recommendation: emulate these advances whatever font the browser actually has.
6. **Transparency.** Every LightBlue PNG is 24-bit RGB with no alpha and no `.pna`, so transparency comes from the colour of the **top-left pixel** [doc].
   - Balloon images use key (0,255,0). Arrows, the online marker and `sstp.png` use white.
   - All of Tsubasa's `\_b` images also use a top-left key, even the RGBA ones, whose alpha is fully opaque. Some use other key colours: (34,177,76), (15,191,44), magenta.
   - The `opaque` option disables keying.
7. **Choice highlight** for LightBlue [observed: SSP 2.9.08f].
   - Settings: `cursor.style=square`, `cursor.blendmethod=notmaskpen`, brush (150,100,100), pen (84,32,27).
   - UKADOC describes the blendmethod as a raster operation (`NOT(dst AND brush)` per channel), but **SSP 2.9 draws only the 1 px pen rectangle** around the hovered choice; nothing is inverted and the text keeps its colour (§3.8). This replaces Sumika's earlier ROP fill, which showed as a colour-inverting effect.
   - In practice, Tsubasa's choices are mostly **images inside `\__q`**: 11,537 choices, 26,497 inline images.
8. **Balloon placement.**
   - Left side: the balloon's top-right corner touches the shell's top-left. Right side: its top-left touches the shell's top-right.
   - `offsetx` is positive toward the shell. `offsety` is positive downward. Tsubasa uses `sakura.balloon.offsetx,2` and `offsety,14`.
   - Side `none` (automatic): left of the character at first. It switches only when the balloon would be cut off and the other side has room, not when the character crosses the middle of the screen, and the new side sticks until that side cuts it off in turn; a right click switches it too [observed: Sumika's earlier "left half → right" rule switched while there was still plenty of room; SSP's balloon moved to the right stays there until the character comes too far right]. It is clamped to the screen when `windowposition.limit=1`.
9. **Timeouts** [ssphelp].
   - A talk closes 15 s after the script ends. A balloon with choices closes after 30 s. `\*` turns the choice timeout off; Tsubasa uses it in 1,459 responses.
   - Click-wait (`\x`) has no timeout.
   - A balloon opens only when **non-blank content** arrives [exe symbol `IsSpaceOnly` plus ghost behaviour]. Bare `\n` does not open it.
10. **Settled by comparison with ssp.exe 2.9.08f** (these override earlier guesses):
    - SSP **word-wraps** Latin text: a word that runs past the wrap point moves whole to the next line ("Tamagawa R" + "iver" is drawn "Tamagawa" + "River"). CJK text still breaks per character (§3.5).
    - The buttons of the "Ask About Tsubasa" page (`\c\n\_l[@-2,@0]`…) do not overlap. ssp.exe's code explains it (§3.3): a leading `\n` moves the pen, but a relative `\_l` before the first string is measured from the origin.
    - A ROP blendmethod draws **only the pen** (item 7, §3.8).
11. **Open questions** (§11):
    - The default vertical alignment, inferred to be `top`.
    - The line gap at sizes other than 12 px.

    §11 has a script for measuring these in real SSP with `\![execute,dumpballoon]`.

---

## 1. Balloon folder conventions

### 1.1 Files (from UKADOC `manual_balloon.html` and `descript_balloon.html`)

`<n>` = surface index. `<N>` = character scope number (2, 3, …).

| File | Purpose | Prio |
|---|---|---|
| `descript.txt` | Main settings (§2). Required. | P0 |
| `balloons<n>.png` | Sakura-side (`\0`) balloon images. Even n: placed **left** of the character (tail on the image's right edge). Odd n: placed **right** (tail on the left). Pairs are (0,1), (2,3), (4,5) and so on. The usual convention is 0/1 normal and 2/3 tall, but any number of pairs is allowed. | P0 |
| `balloonk<n>.png` | Kero side (`\1`). Optional: if missing, use `balloons<n>`. | P0 |
| `balloonp<N>def<n>.png` | `\p[N]`, N ≥ 2. For example, `\p[2]` uses `balloonp2def0.png` and `balloonp2def1.png`. Optional; falls back to `balloonk<n>`, then `balloons<n>`. SSP 2.5.51+. | P1 (pattern), P0 (fallback to k) |
| `balloon{s,k,c}<n>s.txt`, `balloonp<N>def<n>s.txt` | Per-image override files. Note the trailing **`s`**. Same key syntax as `descript.txt`; a key set here overrides `descript.txt` for that one image. The identity keys (`name`, `type`, `craftman*`, `id`, `homeurl`, `readme`) are not allowed here. Adds `windowposition.x/y`. | P0 (parse and merge) |
| `<image>.pna` | Grayscale alpha mask for the PNG of the same name (black = transparent, white = opaque). Allowed for s/k/p/c images. | P1 |
| `balloonc<n>.png` (+`.pna`, +`s.txt`) | Input-box skins. 0 = **Send** (script input box), 1 = **Communicate**, 2 = **Teach**, 3 = **Input** (`\![open,inputbox]` and its variants), 4 = **Address bar** (SSP only). | P0 (c3, c1), P2 (others) |
| `arrow0.png` / `arrow1.png` | Scroll markers: 0 = up (more content above), 1 = down. | P1 (P0 once scrolling happens) |
| `arrows<0,1>.png`, `arrowk<0,1>.png`, `arrowp<N>def<0,1>.png` | Arrow images for one side only (SSP 2.4.78+ / 2.5.51+). Fallback is `arrow*`. | P2 |
| `sstp.png` | SSTP sender marker. Also the image for `\![*]` when no `marker*.png` exists. | P0 (as the `\![*]` marker) |
| `marker.png`, `markers.png`, `markerk.png`, `markerp<N>def.png` | Image for `\![*]` (SSP only). Lookup: side-specific, then `marker`, then `sstp`. | P1 |
| `sstp_new.png`, `sstp_newk.png`, `sstp_newp<N>def.png` | SSTP sender marker only. | P2 |
| `online<0..n>.png` (and the old `online.png`) | Animation shown while the ghost is online. Frames are numbered from 0 and loaded until a number is missing. | P2 |
| `clickwait.png`, `clickwaits.png`, `clickwaitk.png`, `clickwaitp<N>def.png` | Click-wait (`\x`) indicator, SSP 2.5.54+. | P1 |
| `ok_up/ok_down.png`, `cancel_up/cancel_down.png`, `mode_up/mode_down.png` | Input-box buttons (SSP only). | P2 |
| `thumbnail.png` (or `.pnr`) | Preview in menus. | P2 |
| `readme.txt`, `install.txt`, `delete.txt`, `updates2.dau`, `updates.txt` | Distribution files. They play no part in rendering. | — |

The lookup order for the optional part images (arrow, marker, online, sstp, clickwait) can be changed per image file with `arrow.filename`, `sstpmarker.filename`, `marker.filename`, `onlinemarker.filename` and `clickwaitmarker.filename`. The value is a name without extension. These keys go in `balloon*s.txt` [doc]. P2.

`balloon.txt` (from the task list) is **not** part of a balloon. It is the placeholder text file in SSP's `balloon/` root folder ("ここにバルーンを入れます", "put balloons here"). Ignore it.

There are no `descript-s0.txt`-style files. The per-image files are `balloons0s.txt` and so on.

### 1.2 Choosing the image for scope + `\b[id]` + side (P0)

```text
prefixFor(scope):   0 -> "balloons" ; 1 -> "balloonk" ; N>=2 -> "balloonp{N}def"
fallbacks(scope):   0 -> [s] ; 1 -> [k, s] ; N>=2 -> [p{N}def, k, s]

resolveBalloonImage(scope, id, side):         // side: 'left' | 'right'
  if id < 0: return HIDDEN                     // \b[-1]
  base = id - (id % 2)                         // see note below
  idx  = base + (side == 'right' ? 1 : 0)
  for prefix in fallbacks(scope):
      if exists(prefix + idx + ".png"): return prefix + idx
  // the requested id is missing in every family:
  return resolveBalloonImage(scope, currentValidIdOrDefault, side)   // [guess] keep the previous id
```

- `\bN` (one digit, 0–9) and `\b[N]` work the same way. Odd IDs are documented as reserved, so only 0 and even IDs should be used [doc].
- Tsubasa nevertheless sends `\0\b[1]` 51 times (`セイム成立判定３`).
  - Sumika **normalises odd IDs to id−1** [guess; Ikagaka's `surface()` intends the same but has a no-op bug].
- SSP 2.6.34+ accepts `\b[ID1,--fallback=ID2,--fallback=ID3]` [doc]. P2.
- When `\b[id]` names a missing image, SSP's string table contains "invalid balloon ID" [exe], but the exact behaviour is unknown. Sumika keeps the current balloon. ninix falls back to ID 0. P2.
- **When the ID resets.**
  - The default ID comes from ghost `descript.txt`: `sakura.balloon.defaultsurface`, `kero.balloon.defaultsurface` or `char*.balloon.defaultsurface`, which fall back to `balloon.defaultsurface` and then to 0 [doc].
  - [guess] Reset each scope's balloon ID to its default when a new script starts. Keep it when the script starts with `\C`.
  - Supporting evidence: Tsubasa repeats `\b[2]` in every script that needs the tall balloon (4,678 times in `\0`).
- The side (left or right) is not part of `\b`. It comes from placement (§4).

### 1.3 Pixel transparency (P0)

Process each balloon image once into an RGBA bitmap and cache the result:

```text
loadBalloonBitmap(png, pna?, cfg):
  img = decode(png)                                   // RGB or RGBA
  if cfg.use_self_alpha in ('1','true') and img.hasAlphaChannel:
        alpha = img.alpha                             // the PNG's own alpha
  elif pna exists:                                    // .pna next to the .png
        alpha = gray(pna)                             // 0 = transparent .. 255 = opaque
        // paint_transparent_region_black (default 1 for .pna):
        // pixels whose RGB equals the key colour keep alpha from the PNA, but their
        // RGB is painted black (value 1) or kept (value 0)
  elif cfg.use_self_alpha == 'full':
        alpha = 255 everywhere                        // no colour keying at all
  else:
        key = RGB(img[0,0])                           // top-left pixel colour
        alpha = (RGB == key) ? 0 : 255                // exact match only
```

- Default `use_self_alpha` is 0. In that mode SSP **ignores the PNG's alpha channel** and uses the colour key [doc]. A `.pna` file, if present, is still used.
- **A tRNS chunk (palette, RGB or grey PNG) changes nothing in that mode**: SSP keeps each pixel's own colour and reads
  tRNS into a separate table [disasm 2.9.10 JLibPNG::ReadFromBufferFunc 0x568500], so the key is the top-left pixel's
  real colour even when tRNS makes that pixel transparent. mayura's balloon `wiz` is built that way: palette PNGs whose
  top-left (204,204,204) is the tRNS entry and whose body is opaque black. A browser canvas returns an alpha-0 pixel as
  black (premultiplied), which made the key black and keyed the whole body away (text invisible, clicks through); Sumika
  drops tRNS before decoding wherever PNG alpha is ignored (key, `opaque`, `.pna`; `bitmap.js` `withoutTrns`)
  [measured: Chrome, wiz balloons0 opaque pixels 4,293 → 53,437 of 56,088]. Colour types 4 and 6 carry
  their own alpha and keep the canvas path (an alpha-0 top-left there would still read as black; no site balloon has one).
- `use_input_alpha=1` is needed before the input-box images (balloonc) can be semi-transparent [doc]. P2.
- The same key rule applies to `arrow*`, `online*`, `sstp*`, `marker*` and `clickwait*`. In LightBlue these all use a **white** key.

For `\_b` images inside the balloon:
- Default: colour key = top-left pixel.
- `opaque` (positional argument) or `--option=opaque`: no keying.
- `--option=use_self_alpha`: use the PNG's alpha channel [doc].

Corpus check: all 9 RGBA images Tsubasa uses (e.g. `menu\choice5.png`) have **all alpha ≥ 224** and a green top-left key. So "key colour, ignore alpha" renders them correctly.

### 1.4 Configuration merge order (P0)

```text
effectiveCfg(image) = defaults  ⊕  descript.txt  ⊕  <image>s.txt     (later wins, key by key)
```

These keys are **whole-balloon only** and cannot be overridden per image [doc]: `paint_transparent_region_black`, `use_self_alpha`, `use_input_alpha`, `overlay_outside_balloon`.

SSP also accepts `windowposition.*` in `descript.txt` [doc].

### 1.5 `descript.txt` syntax (P0)

- One `key,value` per line. Split at the **first** comma; the value may contain more commas.
- Lines end in CRLF. Blank lines and lines starting with `//` are ignored.
- `charset,<enc>` should be the first line. `Shift_JIS` is assumed when it is absent (SSP actually uses the OS default).
- Decode with `TextDecoder('shift_jis')` or `'utf-8'`.
- Keys are lowercase ASCII and compared case-sensitively [guess].
- Values starting with `\` or `%` are dropped for security; `\\` and `\%` escape them [doc]. P2.
- **The negative-coordinate rule (UKADOC note \*1).**
  - It applies to: `origin.*`, `validrect.*`, `wordwrappoint.*`, `arrow0/1.*`, `onlinemarker.*`, `sstpmarker.*`, `sstpmessage.*` (incl. `.xr`, `.yb`), `number.*` and `clickwaitmarker.*`.
  - A **negative** value is measured from the image's right or bottom edge: `x = W + v` and `y = H + v`.
  - To get a literal negative value, write `--N` (two minus signs).
  - These keys do **not** follow the rule: `communicatebox.*`, `windowposition.*`.

```text
resolveX(v, W):  if v starts with "--": return -int(v[2:]); n=int(v); return n<0 ? W+n : n
```

**Edge case: 0 for `validrect.right` and `.bottom` [disasm 2.9.10 MakeRect 0x5C33A3/0x5C33B6, SetBalloon 0x5CAA10–0x5CAA2E].** `right <= 0` is `W + right` and `bottom <= 0` is `H + bottom`: 0 means the edge (LightBlue uses `validrect.right,0`).

Legacy aliases [exe; meaning inferred from ninix and the key names] (P2):
- `zeropoint.x/y` = `origin.x/y`
- `font.face` and `fontface` = `font.name`
- `font.size` and `fontsize` = `font.height`
- `fontcolor`, `fontbold`, `fontitalic`
- `sstpmessage.color` / `sstpmessagecolor`
- `font.shadow.color` / `shadow.color`, and `font.shadow.style` / `shadow.style`
- `*.font.name.candidate`

`fontspace.*` and `{sakura,kero}.{left,right}.offset` also appear in the key table [exe], but their meaning is unknown.

### 1.6 Which balloons a ghost can wear, and which one it boots with (P0)

**Installed balloons** (what Balloon ▸ and `\![change,balloon]` choose from) [disasm `SPScriptPlayer::EnumBalloons`;
decision]. SSP's installer copies a ghost's bundled balloon into its shared `balloon/` folder, so every ghost can wear
every installed balloon. The site does the same:
- `tools/index_site.py` lists the site's balloons (`site/balloon/<id>/`) and **hoists** every balloon a ghost bundles
  (`site/ghost/<gid>/<dir>/` with `type,balloon` or a `balloons0.png`) into `ghosts.json` `balloons` as
  `{id: <dir>, name, ghost: <gid>}`. Each gets its own manifest `sumika/index/balloon.<dir>.json` (root
  `ghost/<gid>/<dir>/`) and text pack, so wearing it never downloads the other ghost's dictionaries.
- A site balloon with the same folder id (any case) wins, then the first ghost in id order [guess: in SSP the later
  install overwrites the folder]. The indexer prints the bundled balloons it leaves out.
- At run time `installedBalloons(index, ghost)` (`src/core/shells.js`) adds the running ghost's own bundled balloons
  too, and they win a folder id they share with another entry [decision: it is what the ghost was made with, and it
  loads from the ghost's own files and pack].
- Sorted by descript `name`, ties by folder (§12.1). `defaultBalloon` is still chosen among `site/balloon/` only (§9).
- The narrower alternative, offering only the site's balloons plus the ghost's own, is not taken (balloon.md D1)
  [decision].

**Which balloon boots** [disasm `SPGhost::GetBalloonIDFromSetting`]: the first of these that names an installed
balloon (`bootBalloonKeys` / `bootBalloon` in `src/core/shells.js`, used by the runtime's `_loadSkin`):
1. the current shell's remembered balloon (state `shells.<shell>.balloon`; SSP keeps one per shell);
2. the ghost's stored choice (state `balloon`: the balloon's folder id; older states hold its descript name, which
   still resolves: folder id first, then name);
3. the ghost descript's own balloon keys, in SSP's order (`SPGhostProp::GetDefaultBalloon`): `recommended.balloon.path`
   (a folder), `recommended.balloon` (a name), `default.balloon.path` (a folder), `balloon` (a name). A name matches
   the balloon's descript **`name`**, never its folder [disasm `SPProp::FindFromName`: case-insensitive, first in
   name order]; a folder value matches a folder id in any case (a relative path also by its last folder) [infer].
   Emily4's `balloon,emily4` is a folder, not her balloon's name, so it does not match here and rule 4 finds it [infer];
4. `install.txt` `balloon.directory` (the index entry's `balloon`: that folder when the ghost bundles it, else its first
   bundled balloon, else descript `balloon`) [doc `descript_install`]. Tsubasa: `balloon.directory,LightBlue`, and her
   ghost descript has no balloon key;
5. the site default (§9): the page's `data-default-balloon`, else `ghosts.json` `defaultBalloon`;
6. the built-in canvas balloon.

What is stored (the runtime's `_boot`):
- At boot, state `balloon` = the booted balloon's folder id only when it was found by rule 2 (the stored choice; this
  also turns an older descript name into the folder id), or by rule 3 (descript balloon keys) or rule 4 (install.txt
  `balloon.directory`) while no choice is stored yet. Rules 1 (the shell's remembered balloon), 5 (the site default)
  and 6 (the built-in balloon) never write it [decision]. So a ghost that falls back to the site default follows it
  when it changes (SSP: a ghost without a saved balloon follows the user's default).
- A Balloon ▸ pick or `\![change,balloon]` stores what was picked, the site default included [decision: SSP stores any
  pick]. Both the ghost's choice and the current shell's are written [disasm: `ChangeOrReloadBalloonInternal` writes
  both]. The silent swap to a new shell's balloon (§12.3) stores nothing.
- A stored choice the site no longer has: the next rule applies and the stored value is kept, whichever rule supplied
  the fallback, so the balloon comes back when it is re-added [decision; SSP overwrites a saved value with the
  fallback] (balloon.md D5, §12.4).

Layout notes:
- The bundled folder sits inside the ghost folder (`site/ghost/tsubasa/LightBlue/`); SSP's installer copies it to
  `balloon/LightBlue`. LightBlue keeps the same text
  metrics as SSPデフォルト+ (text width 287, origin around 23,13–14, bottom −12, font 12, identical colours), so layouts
  tuned in either balloon match.
- Because the site is served case-sensitively and SSP runs on a case-insensitive file system, the index should include a lowercase path map for every balloon and ghost file. P0.

---

## 2. `descript.txt` key reference

Default values are from UKADOC. "?" means UKADOC says 不明 (unknown); in those cases the ninix defaults are given as a fallback. LB = LightBlue's value.

### 2.1 Geometry

| Key | Meaning | Default | LB | Prio |
|---|---|---|---|---|
| `origin.x`, `origin.y` | Where text starts: (0,0) for `\_l` and for the line-start x. Negative values count from the right or bottom. | `validrect.left` / `validrect.top`. ninix: 14. | 23, 13 | P0 |
| `validrect.left/top/right/bottom` | The text area. Rows outside top..bottom are not drawn and its bottom edge is the scroll limit; text is **not clipped at its left or right edge** [disasm 2.9.10 BTextOut 0x5CE528–0x5CE552: each run's ExtTextOut(ETO_CLIPPED) rect is validrect widened to the run, then limited to the image]. Its right edge caps the wrap point (next row). The link/cursor highlight is clipped to it [disasm 0x5CF1EE–0x5CF204]. | ? (ninix: 14, 14, −14, −14) | 0, 0, 0, −12 → (0,0)–(W,H−12) | P0 |
| `wordwrappoint.x` | Wrap point x for horizontal text. Negative counts from the right edge; 0 or missing is W. **Capped at validrect.right**: the line limit is min(wordwrappoint.x, validrect.right) − origin.x [disasm 2.9.10 CreateBackBuffer 0x5C9FD6–0x5C9FFD] (properties.md validwidth). | `validrect.right` | −30 → x = W−30 = 310 | P0 |
| `wordwrappoint.y` | Wrap point for vertical text only (SSP 2.8.80+). | `validrect.bottom` | 0 (unused) | P2 |
| `vertical` | 1 = vertical Japanese text. Changes the meaning of many keys. | 0 | — | P2 |
| `dpi` | DPI the balloon was drawn for. SSP scales it by 96/dpi [inferred]. | 96 | — | P2 |

Derived values (P0):

```text
originX = resolveX(origin.x ?? validrect.left)
originY = resolveY(origin.y ?? validrect.top)
wrapX   = min(resolveX(wordwrappoint.x ?? validrect.right), validRect.right)   // balloon-image coordinates [disasm]
lineLimit = wrapX - originX                                // in text coordinates
validRect = (resolveX(left), resolveY(top), resolveRightBottom(right, W), resolveRightBottom(bottom, H))
```

### 2.2 Fonts

| Key | Meaning | Default | LB | Prio |
|---|---|---|---|---|
| `font.name` | Font family. A comma-separated list means priority order. A font file inside the balloon folder is allowed (SSP). | **ＭＳ ゴシック** | — | P0 |
| `font.height` | Height in **pixels** (not points). | 12 | 12 | P0 |
| `font.color.r/g/b` | Text colour. | 0,0,0 | 84,32,27 | P0 |
| `font.shadowcolor.r/g/b` | Shadow colour. `none` = no shadow. | none | 195,195,239 | P0 |
| `font.shadowstyle` | `offset` (shifted right and down) or `outline` (drawn around the glyph). | offset | — | P0 (offset) |
| `font.bold`, `.italic`, `.underline`, `.strike`, `.outline` | Always on (0/1). | 0 | — | P1 |
| `disable.font.<…>` | Look of "disabled" text, used by `\f[disable]`. | — | — | P2 |

When no `font.name` is given, or the named font is missing, `ssp.exe` contains a candidate list [exe]: IPAゴシック, IPAGothic, VL Gothic, Sazanami Gothic, IPA mona Gothic, Takao Gothic, Ume Gothic, Droid Sans Japanese, Noto Sans CJK JP, Osaka-Mono, Hiragino Sans, メイリオ/Meiryo, ＭＳ ゴシック/MS Gothic.
- On Windows, UKADOC says the default is MS Gothic.
- **Corpus metrics agree with MS Gothic**: a 14 px line pitch at height 12 is impossible with Meiryo, whose line box is 1.5 em.

### 2.3 Choice cursor (`cursor.*`) and anchors (`anchor.*`)

The same structure is used for `cursor.` (hovered choice), `cursor.notselect.` (other choices), `anchor.` (hovered `\_a` anchor), `anchor.notselect.` and `anchor.visited.`.

| Sub-key | Meaning | Default |
|---|---|---|
| `.style` | `square`, `underline`, `square+underline` or `none`. | cursor: `square`; anchor: `underline`; notselect/visited: ? → treat as `none` |
| `.blendmethod` | Win32 ROP2 mode name in lowercase without `R2_` (§3.8); `none` = ordinary painting. `copypen` (the brush as it is) is treated as `none` [guess]. With any other mode **SSP 2.9 draws only the pen** [observed]. Unknown names keep the default. | `none` |
| `.font.color.r/g/b` | Text colour. **Used only when blendmethod is `none`.** | 0,0,0. `anchor.font.color` defaults to 0 as well. |
| `.font.shadowcolor.*`, `.font.shadowstyle` | Shadow of the highlighted text. | `font.shadowcolor` / `font.shadowstyle` |
| `.pen.color.r/g/b` | Rectangle border and underline colour. | the same group's `.font.color` |
| `.brush.color.r/g/b` | Rectangle fill (blendmethod `none` only, §3.8). | 0,0,0 |

The `anchor.*` set is mainly P1, because Tsubasa sends no `\_a`. `anchor.font.color` is still P1: it is the colour of anchor text when not hovered.

LightBlue values:
- `cursor.blendmethod notmaskpen`, `cursor.style square`
- `cursor.brush` 150,100,100; `cursor.pen` 84,32,27; `cursor.font` 0,0,0
- `anchor.font.color` 77,82,194; `anchor.pen.color` 0,0,255

These match SSPデフォルト+ exactly.

### 2.4 Markers, number and arrows

| Key | Meaning | Default | LB | Prio |
|---|---|---|---|---|
| `arrow0.x/y`, `arrow1.x/y` | Scroll-arrow positions. Negative counts from the right or bottom. | ? (ninix: −10, 10 / −10, −20) | (314, 8) / (314, −16) | P1 |
| `clickwaitmarker.x/y` | Position of the `\x` indicator. | same as arrow1 | — | P1 |
| `sstpmarker.x/y` | Position of the SSTP marker. | ? (ninix: 30, −20) | 18, −18 | P2 |
| `sstpmessage.x/y/xr/yb`, `sstpmessage.font.{name,height,color.*}` | SSTP sender text. | font MS Gothic 10, colour 0,0,192 | 30, −20; height 10 | P2 |
| `onlinemarker.x/y`, `onlinemarker.interval` | Online animation position and frame time (minimum 50 ms). | ?, 500 ms | 18, −22 | P2 |
| `number.font.{name,height,color.*}`, `number.x`/`number.xr` (right edge), `number.y`/`number.yb` | Counter for file receive and `\![set,balloonnum]`. | MS Gothic 10, black | xr −28, y −20, height 10, black | P2 |
| `overlay_outside_balloon` | 1 = parts may be drawn outside the balloon shape. | 0 | — | P2 |

### 2.5 Input boxes (`communicatebox.*`)

These keys come from `descript.txt`, or from `balloonc<n>s.txt` to override one box.

| Key | Meaning | Default | LB | Prio |
|---|---|---|---|---|
| `communicatebox.x/y/width/height` | The edit field's rectangle inside the `balloonc` image. The negative rule does **not** apply. | ? | 10, 18, 301, 18 | P0 |
| `communicatebox.font.name` | Field font. | MS Gothic | — | P0 |
| `communicatebox.font.color.r/g/b` | Field text colour. | 0,0,0 | — | P0 |
| `communicatebox.background.color.r/g/b` | Field background. | colour of the box image's centre pixel | — (centre of LB c3 = 234,235,249) | P0 |

UKADOC does not specify the field's font **size** [guess: use `font.height`].

### 2.6 Window and placement

| Key | Meaning | Default | LB | Prio |
|---|---|---|---|---|
| `windowposition.x` | Extra x shift from the base position. **Positive is always rightward**, whichever side the balloon is on. Keywords: `center` or `top` (fixed above the shell's centre); `bottom` (fixed below the shell's centre). Anything else counts as 0. | 0 | 0 (in every `*s.txt`) | P1 |
| `windowposition.y` | Extra y shift; positive is down. The base position depends on the x mode (§4). | 0 | 0 | P1 |
| `windowposition.limit` | 1 = keep the balloon inside the screen. | 1 | — | P0 (clamp) |

### 2.7 Other keys

- Identity: `name` (required), `type,balloon` (required), `charset`, `craftman`, `craftmanw`, `craftmanurl`, `id`, `homeurl`, `readme`, `readme.charset`. These are metadata only; nothing is drawn from them.
- `recommended.ghost(.path)`.
- Mouse cursors: `cursor`/`mousecursor`, `mousecursor.text`, `.wait`, `.arrow`, plus `.finger`, `.grip` and `.hand` [exe] (P2).

**Not supported by SSP:** `maxwidth`, `maxheight` and automatic balloon resizing. No such keys exist in SSP's tables [exe]. Balloon size always equals the image size, and `\b[n]` is the only way to change it.

---

## 3. Text layout and drawing (the core)

### 3.1 Coordinate spaces (P0) [corpus]

| Space | Origin | Used by |
|---|---|---|
| Balloon space | Top-left pixel of the current balloon image | `\_b[file,x,y]` (positioned images), every descript coordinate, the balloon's position on screen |
| Text space | Balloon (originX, originY), which is (23,13) in LightBlue | Pen position, `\_l[x,y]`, line start x = 0, `lineLimit`, scrolling |

**Proof from the 2048 board.** `\_b["2048\waku.png",48,55]` (241×241) sits flush with:
- the arrow buttons at `\_l[25,12]` (balloon 48,25; 241×30; bottom edge at 55),
- `\_l[-5,42]` (balloon 18,55; 30 wide; right edge at 48),
- `\_l[266,42]` (balloon 289,55),
- `\_l[25,283]` (balloon 48,296).

Its tiles are at `\_l[26,43]` (balloon 49,56), on a 60 px pitch. Every edge matches only if `\_b` x,y are balloon coordinates and `\_l` is measured from (23,13). The same holds for the menu frame `\_b["menu\icon\sky3.png",0,0]`: 340×384, the exact balloon size.

### 3.2 Fonts and metrics (P0)

- `em` = the current font height h, in pixels. CSS `font-size: h px` corresponds to GDI `lfHeight = -h`; for MS Gothic the em box and the cell are the same size.
- **Text line height LH(h) = h + gap, with gap = 2 at h = 12** [corpus; see §3.10 tests C, D, G].
  - The gap for other sizes is unknown. Default to **gap = 2 px for every size** [guess], and make it a configuration constant.
  - The alternative `round(h/6)` also gives 2 at 12.
  - UKADOC confirms that a separate line gap exists: "1lh = 1em + 行間".
- **Advance widths, emulating MS Gothic** (recommended, P0):

```text
advance(ch, h) = isCP932DoubleByte(ch) ? h : round_half_up(h / 2)
// single-byte CP932 = ASCII 0x20-0x7E and half-width katakana U+FF61-FF9F
// any character not in CP932 (absent from Tsubasa): use the measured width, rounded
```

  This rule reproduces the 2 px space at `\f[height,3]` that the dress-up grid depends on (§3.10 test D).

- **Draw text top-aligned.** The glyph cell (the em box) spans `[y, y+h)` inside the line box `[y, y+LH)`. The gap is below the text [corpus, weak; see §11 Q2].
  - Canvas: `textBaseline = 'top'`.
  - DOM: a span with `line-height: h px` placed at `top: y`.
- Recommended font stack: `"MS Gothic","ＭＳ ゴシック","IPAGothic","IPAゴシック","VL Gothic","Osaka-Mono","Noto Sans Mono CJK JP","Noto Sans CJK JP",monospace`. Glyphs can come from any font, as long as the **advances** follow the rule above.

### 3.3 Layout state (per balloon window = per scope) (P0)

```text
state:
  pen.x, pen.y         // text space; pen.y = top of the current line
  segTop               // pen.y when the current segment started
  segMaxH              // tallest element placed in the segment; 0 if empty
  noWrap               // toggled by \_n
  pendingFeed          // overflow was detected; feed before the next element (see 3.5)
  hasString            // SSP's "current string" exists: false when the balloon opens and after \c (below)
  font                 // {name, height, color, shadowColor, shadowStyle, bold, italic, underline, strike, outline, sub, sup, align, valign, cursor/anchor styles}
  elements[]           // display list: glyph | inlineImage | posImage | marker | choiceStart/End ...
  scrollY

lineAdvance() = max(LH(font.height), segMaxH)

newSegment(y): pen.y = y; segTop = y; segMaxH = 0

lineFeed(ratio = 1):                         // \n, \n[half], \n[pct], automatic wrap
  if pendingFeed and ratio == 1: pendingFeed = false; return   // \n uses up the pending wrap [guess]
  if pendingFeed: commitFeed()
  adv = round(lineAdvance() * ratio)         // [guess] the ratio applies to the same advance
  pen.x = 0                                  // ALWAYS back to x = 0 [corpus test B]
  newSegment(pen.y + adv)                    // also before the first string: a leading \n counts (below)
  font.align = left?                         // \f[align] lasts until the next deliberate break [doc]; not before
                                             // the first string, which still gets an earlier \f[align] (below)

commitFeed(): pendingFeed = false; pen.x = 0; newSegment(pen.y + lineAdvance())
```

How each element contributes to `segMaxH`:
- A text glyph contributes `LH(glyph font height)`.
- An inline image contributes its pixel height. There is **no gap**: tests D and F show image rows packed with nothing between them.

**Leading line breaks count; a relative `\_l` before the first string starts from the origin** [disasm 2.9.10]. ssp.exe keeps the balloon's text as a list of strings with a "current string" (`SPBalloonWnd` +0xA7C). `ClearString` 0x5CC7B0 (the script start through `ClearBalloons` 0x63E280, and `\c`) sets it to none and the pen to the origin. In detail:
- `\n`, `\n[half]` and `\n[%]` only add a percentage to a pending feed (`LineFeedExt` 0x5D3330, called from `DecodeProcReal`'s `n` case 0x62A083; no check for an empty balloon). The feed is applied by `LineFeedProcessor` 0x5D3390 just before the next text (`AddString`), marker (`AddMarkerIcon`), choice (`AddSelectableString`, `AddAnchorOrSelectable`), inline image (`AddImage`), `\_l` (`SetOffsetString`) or a `\f` that changes the size. With no current string it still moves the pen down (0x5D3480), and the first string is created at the pen (`NewString` 0x5CBA30, 0x5CBC5F). So leading line breaks count.
- `\_l` (`SetOffsetString` 0x5D2BF0) measures `@` coordinates from the current string: x from its end, y from its top. With no current string it measures them from the origin (x 0 at 0x5D2ED6, y `GetDefaultTextElementOffsetY` 0x5CB580 at 0x5D2EFB), not from the pen, so the pending feeds before it are lost. An empty coordinate keeps the pen. `\_l` always ends by opening a new string (0x5D323F), even `\_l[,]`.
- A current string is opened by text (blank characters too), a marker, a choice or anchor, an inline image (`AddImage`'s inline branch 0x5D2880), `\_l`, and every `\f` except `align` and `valign` (`ParseFontCommand`, 0x5D38BC). A positioned `\_b` is not a string (`AddImage`'s other branch only adds the image).
- A `\f[align]` given before the first string waits for it (0x5D37F2 keeps it as pending; `LineFeedProcessor` returns before applying it when there is no string), so a leading `\n` does not reset the alignment.

Sumika: `hasString` in `src/balloon/layout.js`. `\c` and the balloon's opening clear it. `\C` keeps the content and so keeps it, and the recorded operations replay it, so relayout and snapshot restore give the same result. For `\f[default]` Sumika opens no string, because the player sends it itself at the script start, where ssp.exe resets the font without one (`ClearString` calls `InitFontProp`), and after `\x`. A missing inline image opens a string [guess], as it counts as a zero-size character elsewhere (`\c[char]`), so the layout stays the same when a loading image turns out to be missing.

What this gives:
1. The "Ask About Tsubasa" page (`自己紹介`) starts `\c\n\_l[@-2,@0]` and stacks 16 question buttons at pitch 20 above Previous/Next at `\_l[-2,321]`. The `\n` moves the pen, but the relative `\_l` with no string starts from the origin, so row 1 is at y 0 and row 16 ends at 319 < 321, as SSP shows it, with no overlap [observed]. The 17-row settings page `On天気予報地域の設定２` (`\c\_l[@-2,@0]`, no `\n`) ends at 339 < 340, just above its Overview/Back/Close row.
2. Menus that write their choices first and their title last at `\_l[0,0]` keep the title row free with leading `\n`: `\0\n\_q\n\![*]\q[…]…\_l[0,0]title` puts the first choice on row 3 (y 28), below the title on row 1 and an empty row. A three-`\n` start with a two-line title puts the choices on row 4. Ignoring leading `\n` put the title over the first choice.
3. The main menu (`mが押された`, test C) writes `\_b[sky3.png,0,0]\n　\n\n\n\n` and then `\_l[-9,@0]`. The positioned image opens no string, so the first `\n` counts (the full-width space is on row 2), and the full-width space is what lets the relative `\_l` count from the pen. Without it, `\_l[-9,@0]` would start from the origin. The first row is at y 70 (balloon y 83), 13 px below the MENU banner of `sky3.png` (dark rows 2–66, border rows 67–69).
4. Over all 1,995 corpus menu frames, no choices collide and no label leaves its button (`tests/balloon/corpus.test.mjs`).
- **Not the rule:** "a `\n` does nothing until the balloon holds a character". It was inferred from item 1, and it put the title of item 2 over the first choice and the main menu one line higher than ssp.exe's code does.

### 3.4 Script operations → layout

| Op | Effect | Prio |
|---|---|---|
| text character | `placeGlyph` (§3.5) | P0 |
| `\n` | `lineFeed(1)`; counts in an empty balloon too (§3.3) | P0 |
| `\n[half]` | `lineFeed(0.5)`. Tsubasa: 884 uses. | P0 |
| `\n[<percent>]` | `lineFeed(p/100)`. Negative values move up (SSP 2.3.97+). | P1 |
| `\_n` | Toggles `noWrap`. While on, nothing wraps automatically; text past the edge is simply clipped. Tsubasa: 472 uses, e.g. the main menu and mahjong. | P0 |
| `\_l[x,y]` | `commitFeedIfPending()`, then compute the new x and y (below), then `newSegment(newY)`, then `font.align = left` [doc]. Tsubasa: 58,674 uses. | P0 |
| `\_b[f,inline,…]` | `placeInlineImage` (§3.6) | P0 |
| `\_b[f,x,y,…]` | Positioned image (§3.6). Does not move the pen. | P0 |
| `\![*]` | `placeMarker`: an inline element using `marker*.png`, else `sstp.png` (LightBlue: `sstp.png`, 8×8, white key). Tsubasa: 2,848 uses. | P0 |
| `\c` | Clears the scope's display list and scroll; pen to (0,0); `newSegment(0)`; `hasString = false`, so a relative `\_l` before the next string is measured from the origin (§3.3). The balloon stays open and the **font state is kept** [guess]. | P0 |
| `\c[char,n(,start)]` | Removes the last n glyph-like elements (glyphs, inline images, markers) counted in script order, or from `start` (0-based). The pen goes back to where the first removed element started [guess]. Tsubasa: 25 uses, removing one flashed inline image. | P0 |
| `\c[line,n(,start)]` | Removes whole "lines". A line is the content between `\_l`, `\n`, `\n[half]` and `\n[%]`; empty lines between consecutive `\n`s do not count [doc]. | P2 |
| `\C` | At the start of a script: do not clear; append to the previous balloon contents (§3.11). Tsubasa: 601 uses. | P0 |
| `\b[n]` | Changes the scope's balloon image. The size changes; the existing display list is **kept with its coordinates** [guess]. | P0 |
| `\x` | Click-wait (§3.11). When it ends, the scope returns to `\0` and the `\f` decorations are reset [doc]. | P0 |
| `\_q`, `\![quicksection,…]` | Display without per-character delay. This is a matter for the player; layout is unchanged. | P0 (player) |
| `\![set,autoscroll,disable/enable]` | §3.9 | P1 |
| `\![lock,balloonrepaint]` / `unlock` | Stop and resume painting (layout continues). | P2 |
| `\![set,balloonwait,r]`, `\![set,balloontimeout,ms]`, `\![set,choicetimeout,ms]`, `\*` | Timing (§3.11). | P0 (`\*`), P1 (the others) |

**`\_l` coordinates** [doc]. Each of x and y is one of:

```text
""                -> unchanged (if both are empty, \_l does not move the pen, but it opens a string, §3.3)
N                 -> absolute, in text space (may be negative: Tsubasa uses -9, -7, -5, -2 and -4)
@N                -> relative to the current pen; before the first string, to the origin (§3.3)
N em | N% | N lh  -> N*h | N/100*h | N*LH(h); combinable with @; decimals allowed            (P1)
centerx | centery -> centre of the BALLOON IMAGE (W/2 or H/2), converted to text space         (P1)
```

- Unparsable values, such as the full-width `＠-31` that Tsubasa sends 31 times: treat that axis as **unchanged** [guess]. P2.
- `@` is relative to the pen **after** any pending wrap has been applied (see the eager-wrap rule in §3.5; test A depends on it).

### 3.5 Automatic wrapping (P0)

```text
placeGlyph(ch):
  w = advance(ch, font.height)
  if pendingFeed:
     if ch in KINSOKU_LINE_START and not noWrap: pass        // let a forbidden line-start char hang [exe table]
     else if ch is ' ' (or TAB): pass                         // word wrap: a space after a word hangs too
     else if isWordChar(ch) and a word is open: wrapWord()    // word wrap, below
     else: commitFeed()
  else if ch in KINSOKU_LINE_END and it would overflow:       // see the kinsoku rules below
     wrapWord() if it continues an open word, else commitFeed()
  a word is open from its first word character to the next other character
  emit glyph at (pen.x, pen.y) with font, w
  pen.x += w ; segMaxH = max(segMaxH, LH(font.height))
  if not noWrap and pen.x > lineLimit: pendingFeed = true    // the "eager" rule: place first, then break

placeInlineImage(img):            // also markers and \q titles (see 3.8)
  if pendingFeed: commitFeed()
  emit image at (pen.x, pen.y)    // NO check before placing: it may run past lineLimit [corpus D]
  pen.x += img.w ; segMaxH = max(segMaxH, img.h)
  if not noWrap and pen.x > lineLimit: pendingFeed = true
```

Any other op that moves the pen (`\_l`, `\c`, a scope change) commits the pending feed first. `\n` absorbs it instead (§3.3).

Kinsoku tables, verbatim from the `ssp.exe` 2.9.08f string table [exe]. SSP uses them for line breaking; the role of each set is inferred:

- **Cannot start a line**: `。、．，！？♪.,!?・」』）】｝］≫)}]〟’”'"ヽヾ～ーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ々`
- **Cannot end a line** (pull to the next line): `「『（【｛［≪({[`
  - Rule: if the glyph just placed is in this set and `pendingFeed` gets set, move it to the next line [guess].
- **Hanging punctuation** (may extend past the wrap point): `。、．，！？♪.,!?・`
- A combined bracket set `」』）】｝］≫)}]〟’”'"「『（【｛［≪({[` also exists; its purpose is unknown.

**Word wrap for Latin text** [observed: ssp.exe 2.9.08f]. SSP does not split words: where Sumika's per-character rule drew "Tamagawa R" and put "iver" on the next line, SSP draws "Tamagawa" and puts "River" on the next line. The engine word-wraps by default (`LayoutEngine` option `wordWrap`; `false` restores the per-character rule).
- **Word characters**: every non-blank character that is not CJK, so letters, digits and the punctuation attached to them (apostrophes, commas, full stops, hyphens, quotes, brackets: `don't-know,` is one word). CJK = what CP932 draws double-byte (kana, kanji, full-width forms, CJK punctuation and symbols such as `… ― ♪ ※ ～`) and half-width katakana. Greek and Cyrillic letters and the curly quotes `‘ ’ “ ”` are double-byte but count as word characters. CJK text keeps the per-character rule with the kinsoku tables; so do `　` (U+3000), which does not hang.
- **wrapWord()**: the line breaks before the word, and the part of the word already placed moves to the next line (x 0). The rule stays "place first, then break": a word moves only when a character of it **after** the crossing one arrives. A word whose last character is the one that crosses the limit stays on the line, as the per-character rule would keep that character. This keeps the dress-up label `\_l[206,3]　　 Hair Clip\n`, which ends at x = 290 past the limit of 287, on one row (the ghost was tuned in SSP and shows no glitch there).
- A space (U+0020 or TAB) after a word that crossed the limit **hangs** on the full line, so the next line does not start with a space. Hanging punctuation inside a word (`e.g.`, `don't`) hangs as before; if more of the word follows, the whole word moves.
- A word that already starts its row (it is wider than the line) cannot move: it breaks by character at that point, like before.
- The old row's advance is recomputed from what stays on it: `max(LH(font of the word's first glyph), heights of the elements left on the row)`. A `\f[height]` inside the moved word therefore only affects the new row. Moved glyphs keep their fonts and their link (`\__q`/`\_a` regions wrap with them); positioned `\_b` images placed in the middle of the word stay where they are.
- `\f[align,center/right]`: both rows are re-aligned for their final widths.
- `\q[title]` stays one unit (§3.8): nothing that follows the title can pull its last word to the next row.
- Applies in every segment, including those started by an absolute `\_l` (SSP has no notion of segments). Over the 1,995 corpus menu frames this changes only frames that wrap; it splits no word in 5,456 unique corpus responses (2,046 splits with the per-character rule). One frame, `コミュニケーション設定`, now overlaps, and by this rule it would in SSP too: its English intro needs a third row ("…a word" + "list."), which pushes the buttons into the absolutely placed Back/Close row (a translation artefact).

### 3.6 Images in the balloon: `\_b` (P0)

Paths:
- Relative to `ghost/master/`. Backslashes become `/`. Matching is **case-insensitive** through the file index.
- The path may be quoted (`"menu\choice5.png"`) or not (`card\field.png`). Both forms occur.
- Absolute paths, environment variables, `exe,resid`, plug-in folders and `http(s)://` URLs are P2. Tsubasa sends one dead `http://weather.livedoor.com/...gif`; render nothing for it.
- `data:image/png;base64,…` is P2.
- A **missing file must be skipped silently.** Tsubasa sends `2048\0.png` and `unyu\unyu0.png`, which do not exist. Treat each as no element with zero width [guess; the absolute `\_l` layouts around them make the width irrelevant].

| Form | Behaviour | Tsubasa uses |
|---|---|---|
| `\_b[f,x,y]` | Positioned image at **balloon-space** (x,y). Drawn **below the text** by default. Key colour applies. | 223,446 |
| `\_b[f,x,y,opaque]` | No key colour. | (combined with background: 136) |
| `\_b[f,x,y,--option=background]` | Explicit default. The **balloon's transparency wins**: the image is clipped to the balloon's alpha mask. | 3,573 |
| `\_b[f,x,y,--option=foreground]` | Drawn **above the text**. The **image's** transparency wins: it may cover the balloon's transparent area (SSP 2.6.54+). | 8,661 |
| `\_b[f,inline]` | Inline element, counted as **one character** (for `\c[char]`) (§3.5). | 23,680 |
| `\_b[f,inline,opaque]` | Same, without the key colour. | 2,772 |
| `--clipping=L T R B` | Use only the source rectangle `[L,R) × [T,B)`; the element size becomes (R−L)×(B−T). | 45 (card board) |
| `--scaling=W H` / `--scaling=N long/short[max/min]` | Scale. `%` or px; negative values flip; 0 keeps the aspect ratio; limited to 1..4096. | — (P2) |
| `--option=fixed` | The positioned image does not scroll with the text. | — (P1) |
| `--option=use_self_alpha` | Use the PNG's alpha channel. | — (P1) |
| `--source=…` | Page or layer selection. | — (P2) |

Rules:
- Positioned images **scroll with the text** unless they are `fixed`.
- `\c` clears them.
- Draw order follows script order within each layer.
- The vertical placement of inline images in a taller line is covered by the valign note in §3.7.

### 3.7 Font tags `\f[...]` (font state is per balloon or scope; reset at script start, after `\x`, and on `\f[default]`)

| Tag | Prio | Notes |
|---|---|---|
| `\f[color,c]`, `\f[color,default]` | P0 | 7,962 uses. Colour syntax below. |
| `\f[shadowcolor,c / none / default]` | P0 | 3,710 uses. Default style `offset`: draw the shadow +1,+1 px first [guess: 1 px at every size]. `outline`: draw the shadow at the 8 neighbouring offsets. |
| `\f[shadowstyle,offset/outline/default]` | P1 | |
| `\f[bold,1/0/true/false/default/disable]` | P0 | 3,699 uses. Do not change advances [guess; GDI's synthetic bold may add 1 px, see §11]. |
| `\f[height,N / +N / -N / N% / default]` | P0 | Values used: 12, 16, 20, 24, 30, 3, 60, 8. It changes LH for the following glyphs. |
| `\f[strike,…]` | P0 | 400 uses. Mahjong draws rules by striking through full-width spaces. Draw the strike line **for spaces too**, across each glyph cell at y + round(h·0.55) [guess]. |
| `\f[underline,…]`, `\f[italic,…]`, `\f[outline,…]`, `\f[sub,…]`, `\f[sup,…]` | P1 | |
| `\f[name,list / default / disable]` | P1 | A comma-separated list is tried in priority order. |
| `\f[align,left/center/right]` | P1 | It also shifts the glyphs already placed on that line. `\_l` resets it to left [doc]. |
| `\f[valign,top/center/bottom]` | P1 | Default: **top** [guess, see below]. |
| `\f[default]` | P0 | 3,830 uses. Resets every attribute to the balloon's defaults. |
| `\f[disable]` | P2 | |
| `\f[cursorpencolor,c]` | P0 | 790 uses: yellow (250,250,50), magenta and green outlines on game boards. |
| `\f[cursor{style,color/brushcolor,fontcolor,method}…]`, `\f[cursornotselect…]`, `\f[anchor…]`, `\f[anchornotselect…]`, `\f[anchorvisited…]`, `\f[anchor.font.color,c]` | P1 | They set the matching descript fields (§2.3). `default` restores them. |

Colour syntax [doc]:
- `R,G,B` (0–255)
- `R%,G%,B%`
- `#rgb` or `#rrggbb`
- CSS/W3C names, all lowercase
- `default`
- `disable`
- `default.anchor`, `default.anchornotselect`, `default.anchorvisited`
- `default.cursor`, `default.cursornotselect`, `default.plain` (these three only for choice and anchor text)

Invalid values are **ignored** (SSP 2.8.93+).

**Vertical alignment inside a line** [guess, weak evidence].
- When a segment holds elements of different heights, align each element's **top** with the line top.
- Evidence: the main-menu label `\_l[16,@5]` beside a 23 px button, and choice labels `@3` inside 19 px buttons, both come out centred only if 12 px text is top-aligned.
- Exception: centre short inline markers (the 8×8 `\![*]`) inside the font cell, at `y + floor((h − mh)/2)` [guess].

### 3.8 Choices (`\q`, `\__q`) and anchors (`\_a`): regions, hover, raster operations

Choice region:
- `\__q[ID,…] … \__q` (P0, 11,537 uses) makes every element in between part of one choice. That includes glyphs, inline images and `\_l` moves, and the elements still wrap [doc].
- The hit region is the **union of the element rectangles**:
  - glyph: `[x, y, w, h]`, the font cell without the line gap [guess];
  - image: its bitmap rectangle.
- `\q[title,ID,…]` (P0, 4,132 uses) inserts `title` as choice text. UKADOC says it does not word-wrap inside.
  - [guess] Lay the title out glyph by glyph like normal text, but **do not let it break** in the middle. If it would start past the limit, call `commitFeed()` first.
  - Satori puts `\x01` bytes into IDs (e.g. `…リスト２21`). They belong to the ID; never render them.
- `\q[ID][title]` (the old form) appends a line break after the choice. P2.
- `\_a[ID,…] … \_a`: anchor text in `anchor.font.color` with the `anchor.*` styles. P1 (Tsubasa sends none).

Non-hovered appearance:
- Choice text uses the **current `\f` colour** [corpus: the word-list pager greys out other pages with `\f[color,200,200,200]\q[...]`].
- `cursor.notselect.*` styles apply only if they are defined. Treat the default as `none`.

Hovered choice: draw `cursor.style` over the region (anchors the same way with `anchor.*`; non-hovered regions with the `*.notselect` / `anchor.visited` styles).

```text
square:            1px border in pen colour around each row-part of the region
underline:         1px line at the bottom of each row-part of the region, pen colour
square+underline:  both
blendmethod none:  (square styles) also fill the rect with the brush (normal paint) under the content [guess],
  or copypen       and redraw the choice glyphs in cursor.font.color (+ cursor shadow)
any other (ROP2):  nothing else: no brush, no raster operation, text in its own colour [observed]
```

**ROP blendmethods draw only the pen** [observed: ssp.exe 2.9.08f, LightBlue]. LightBlue sets `cursor.blendmethod notmaskpen` with brush (150,100,100). Filling the hovered rectangle with the brush through the ROP, as UKADOC describes, shows as a colour-inverting effect, while SSP 2.9 only draws the dark pen rectangle (84,32,27) around the hovered choice. So with any ROP mode Sumika draws only the pen rectangle and/or underline and leaves the text colour alone (`cursor.font.color` is documented as used only without a ROP). `copypen` paints the brush as it is, so it is treated as `none` [guess]. `\f[cursorpencolor,…]` still sets the pen. The ROP fill below stays available as `Painter.ropFill` (off) for other baseware or older SSP versions.
- **Not the rule:** "fill rect with brush using ROP(blendmethod)" for square cursors. The ROP results table at the end of this section describes UKADOC's semantics, not what SSP 2.9 shows.

Pen [guess].
- Draw the 1 px border with a **plain** pen colour, not through the ROP.
- Evidence: Tsubasa sets pen colours (250,250,50), (250,50,250) and (50,250,50) on dark game boards. These only make sense as literal colours.

**ROP2 modes** for `*.blendmethod` and `\f[*method,…]` (reference; used only with `ropFill`). Each works per 8-bit channel. D = destination (already drawn pixels, background **and** text), P = brush colour.

| name | result | name | result |
|---|---|---|---|
| black | 0 | notmaskpen | ~(P & D) |
| notmergepen | ~(P \| D) | maskpen | P & D |
| masknotpen | ~P & D | notxorpen | ~(P ^ D) |
| notcopypen | ~P | nop | D |
| maskpennot | P & ~D | mergenotpen | ~P \| D |
| not | ~D | copypen | P |
| xorpen | P ^ D | mergepennot | P \| ~D |
| mergepen | P \| D | white | 255 |

Exact DOM implementation of any ROP2 mode:
- Each channel of each mode is a fixed function of D, so it can be written as `<feComponentTransfer>` with `type="discrete"` and 256 `tableValues` per channel (value = f(i)/255).
- Set `color-interpolation-filters="sRGB"`.
- Apply the filter to a **clone of the balloon's composited layers** (background bitmap, background images, text, inline images), clipped to the hover rectangle and stacked above the original. CSS `backdrop-filter: url()` is not reliable across browsers, so use the clone.

LightBlue highlight results under UKADOC's semantics (notmaskpen, brush 150,100,100; not what SSP 2.9 draws):

| Destination | Result |
|---|---|
| White (255,255,255) | (105,155,155) |
| Fill (250,247,249) | (109,155,159) |
| Text (84,32,27) | (235,223,255) |
| Shadow (195,195,239) | (125,191,155) |

The cheap approach would be to precompute these values; image buttons would need the filter clone.

Events (the event spec covers the details):
- Click → OnChoiceSelect / OnChoiceSelectEx, or the event named by an ID that starts with `On`, or a `script:` ID.
- Hover (implemented; EV §4.7, UI §4.8) [disasm]: OnChoiceEnter / OnAnchorEnter when the item under a mouse or
  pen pointer changes, OnChoiceHover / OnAnchorHover and `balloon_tooltip` once per item entry when the pointer rests
  (500 ms). The tooltip takes the balloon's colours: the dominant colour of the image's cell under the pointer in a
  6 × 8 grid over `validrect` as background, a 1 px border and the text in `font.color` (refitted for contrast when the
  two are within 90 luminance) [disasm CToolTipCustom, SPBalloonDesc::LookupDominantGrid]. emily4's balloon: white,
  dark red (105,25,25) [infer]; LightBlue: its cell colour, brown (84,32,27) [infer]. Not compared with ssp.exe yet (Tsubasa's dress-up tips);
  the check is UI §4.8, check (1).
- OnAnchorSelect(Ex) (P1).
- Keyboard selection: P2.

### 3.9 Scrolling (P0 basic, P1 arrows)

```text
visibleBottom = validRect.bottom - originY            // text space; LB: H-12-13
contentBottom = max over elements of (elem.y + elem.h)   // glyph: y+h; images: y+img.h
if autoscroll enabled: scrollY = max(0, contentBottom - visibleBottom)  // after each element
paint content translated by (originX, originY - scrollY): text clipped to validRect's rows (the whole image wide),
  inline images to validRect
arrow0 visible iff scrollY > 0 ; arrow1 visible iff contentBottom - scrollY > visibleBottom
```

- **Do not scroll when `contentBottom == visibleBottom`.** Tsubasa's dress-up "Back" button at `\_l[-2,340]` is 18 px tall in a 384 px balloon. It ends at balloon y 371, against a limit of 372. It must not move.
- Whether SSP scrolls by pixels or by whole lines is unknown [guess: pixels]. Wheel and arrow clicks scroll by LH(12) = 14 px.
- With autoscroll disabled, keep `scrollY`; the user can still scroll by hand [doc].
- Text is clipped to `validRect`'s rows only, never at its left or right edge (§2.1 [disasm]): the character that crosses the wrap point stays on its line whole, past `validrect.right` (BloodTeaHOUSE ver.5's convulsions: wordwrappoint.x −23 against validrect.right −38, so the line limit is 145 and a line's 13th character sits at x 161–173, past 162; SSP screenshots of two such lines match [observed]; before, Sumika wrapped at 160 and hid everything right of 162). Inline images keep the whole `validRect` clip (SSP's horizontal handling of images not traced) [decision]. LightBlue's `validrect.left` is 0, so Tsubasa's elements at negative x (−9, −7, −2) are visible.
- `--option=foreground` positioned images are not clipped to `validRect` [guess].

### 3.10 Golden layout tests (from Tsubasa's tuned layouts) — P0 unit tests

All coordinates are in text space for LightBlue (`lineLimit` 287, LH(12) = 14). A correct engine must reproduce each table exactly.

**A. Full-width image button rows** (`\_l[@-2,@3]\__q[ID]\_b["menu\choice5.png",inline]\__q\_l[@0,@-16]<spaces>Label\n`, repeated; choice5 = 300×19). The row starts at (0,Y).

| Step | Pen / element |
|---|---|
| `\_l[@-2,@3]` | (−2, Y+3) |
| image | rect (−2, Y+3, 300×19); pen.x = 298 > 287, so a feed is pending |
| `\__q`, then `\_l[@0,@-16]` | commit: (0, Y+3+19) = (0, Y+22); then the move gives (0, Y+6) |
| label | glyph tops at Y+6 (centred in the button; 11 full-width + 2 half-width spaces = x 144) |
| `\n` | (0, Y+20) |
| next button | (−2, Y+23) — a 1 px gap, pitch 20 |

The "Ask About Tsubasa" page (`自己紹介`) starts `\c\n\_l[@-2,@0]`: the relative `\_l` comes before the first string, so it is measured from the origin and the `\n` before it is lost (§3.3). Button k is at (−2, 20k), the 16th ends at 319, and Previous/Next at `\_l[-2,321]` sit just below it. The test lays out the whole page.

**B. Two-column choice3 menu** (`カードゲームメニュー２`; choice3 = 150×19). The row starts at (0,Y).

| Step | Pen / element |
|---|---|
| `\_l[@-2,@3]` + image A | rect (−2, Y+3); pen.x = 148, no wrap |
| `\_l[@-150,@3]` + "Start Game" | text at y = Y+6 |
| `\n` | (0, Y+20). The segment holds only text, so the advance is 14. |
| `\_l[150,@-17]` + image B | rect (150, Y+3) — **aligned with A**; pen.x = 300 > 287, feed pending |
| `\_l[150,@-16]` | commit gives y = Y+22, then the move gives (150, Y+6): "How to Play" centred in B |
| `\n` | (0, Y+20) |
| `\_l[@-2,@3]` | the next row's button at Y+23. Note the **x reset**: `\n` returned x to 0. |

**C. Main menu** (`mが押された`, with `\_n` on; choicem 153×23, icons 23×23). After `\c\_n\_b["menu\icon\sky3.png",0,0]` the pen is at (0,0) and there is no string yet (the positioned image is none, §3.3).

| Step | Pen / element |
|---|---|
| `\n` | (0,14): a leading `\n` counts (§3.3) |
| `　\n\n\n\n` | the full-width space opens the first string at (0,14); four `\n` give (0,70) |
| `\_l[-9,@0]` | button at (−9,70), measured from the pen because a string exists |
| `\_l[16,@5]` | label at (16,75) |
| `\_l[-9,@-5]` | icon at (−9,70) |
| `\n` | the segment holds the 23 px icon, so the pen goes to (0,93) |
| `\_l[146,@-23]` | right-column button at (146,70) — aligned |
| …`\n`, then `\_l[-9,@3]` | the next row at (−9,96) |

Balloon y of row 1 = 83, 13 px below the "MENU" banner of `sky3.png` (dark rows 2–66, border rows 67–69; transparent from row 70).

**D. Dress-up grid** (`頭着せ替えメニュー`; head icons 40×40; `\f[height,3]`; space = 2 px).

| Step | Pen / element |
|---|---|
| `\_l[198,38]\_l[@0,@3]\n\n\![*]Head\n` | y: 41 → 55 → 69 → 83 |
| `\f[height,3] ` + `\__q[..]\_b[head1,inline]\__q ` … | icon k at x = 2 + 42·(k mod 7), y = 83 + 40·⌊k/7⌋ |
| 7th icon on a row | ends at 294 > 287: feed, advance **40** (the image height; no gap) |

The ghost then draws its selection frame `menu\f2.png` with `\_l[42·j, 83|123|163] \_b[f2,inline]` (space, then frame), which lands on exactly these positions. For the 35 px accessory icons the values are pitch 37, 8 per row, rows at 83 and 118.

**E. 2048 board** (`２０４８最初`). As listed in §3.1. In addition, `\_l[266,42]` puts b3 at pen.x 296 > 287. The pending feed is harmless because the next op is `\n` and then an absolute `\_l`.

**F. Card 3×3 board** (`カード選択１`).
- `\_l[0,-1]` followed by three `\_b[card\field.png,inline,--clipping=…]` cells of 60×74: x = 0, 60, 120; y = −1.
- `\n` advances 74. Rows land at −1, 73 and 147, rebuilding the 180×222 `field.png` with no seams.

**G. Text line pitch.** "Neighbor…\n\_w[144]\_q\n" followed by choice rows: every plain-text `\n` advances 14. This is the basis of the −16 / −17 / +3 constants used everywhere.

### 3.11 Balloon visibility, click-wait, timeouts, mouse (P0)

- **Opening.** A scope's balloon window becomes visible when its display list first contains a **non-blank** element: a glyph other than U+0020, U+3000 or a tab, any image, a marker, or a choice title [guess, based on `IsSpaceOnly` and `IsContentExist` (exe) and on Tsubasa's boot script, which sends `\n` to scopes 1 and 99 without wanting their balloons to show].
  - Blank glyphs still move the pen and open a string (§3.3). A `\n` moves the pen even in an empty balloon (§3.3) but opens nothing. So Tsubasa's boot `\n` to scopes 1 and 99 opens neither balloon.
  - `\![enter,onlinemode]` forces the scope-0 balloon open (P2).
- **Script start.**
  - Without `\C`, SSP clears all balloons at the start of a new script [doc: implied by the `\C` description]. Each balloon reopens when content arrives.
  - **With `\C`**, keep the content and keep the window open; do not flash it. Tsubasa starts 601 scripts with `\C…\0\c` precisely to avoid the close-and-reopen flicker.
- **`\b[-1]`** hides the scope's balloon. [guess] Later non-blank content in that scope reopens it with the last valid ID. Tsubasa: `…\_w[5000]\b[-1]\_w[15000]\n\c…...Um...`; the talk continues after the hidden pause, so it must become visible again.
- **`\x`** waits for a click on the balloon (or a key).
  - Draw the click-wait indicator `clickwait*.png` at `clickwaitmarker.x/y`, which defaults to the arrow1 position.
  - LightBlue has **no** clickwait image. [guess] Show nothing, or blink `arrow1.png`; this is cosmetic.
  - SSP's default setting is no timeout for `\x` [ssphelp].
  - `\x[noclear]` keeps the content and the font state.
  - Tsubasa: 198 uses.
- **Timeouts** [ssphelp `config-talk`]. Both start counting **after the script has finished displaying**.

  | Balloon state | Timeout | On expiry |
  |---|---|---|
  | Talk | 15 s | close all of the ghost's balloons, then fire OnBalloonTimeout (P2) |
  | Contains choices, and the script has no `\*` | 30 s | fire OnChoiceTimeout, then close |

  - `\![set,balloontimeout,ms]` and `\![set,choicetimeout,ms]` override them for that script. A value of 0 or −1 means never.
  - Anchors do not trigger the choice timeout [doc].
  - Option (SSP setting, default on [disasm 0x72822b]): pause the timeout while the mouse is over the balloon (ssp.exe drops it at expiry instead; EV §3.4).
- **Mouse** [ssphelp].
  - **Left double-click** breaks the script (OnBalloonBreak) and closes the balloons.
  - **Right-click** toggles the balloon's side (left or right).
  - **Left-drag** moves the balloon. This adds a user offset (P1), which is disabled by `balloon.dontmove` and `\![lock,balloonmove]`. Implemented with a 4 px (touch 10 px) threshold; `\![lock,balloonmove]` is not (ssp-ui.md §4.6).
  - **A single left click does not close the balloon** (SUMMARY C16). It resumes a `\x` wait, selects the choice or anchor under it, and raises the balloon.
    Not the rule: "[guess] A single left click on a finished balloon closes it." Nothing in SSP's help documents a close on single click, and the code follows C16.
  - Clicks on transparent pixels must reach the page underneath (§8).

---

## 4. Placing the balloon next to the character (P0)

Inputs:
- `S` = the scope's shell window rectangle (surface bitmap) in viewport pixels.
- `B` = the balloon image size.
- The scope's alignment mode.

Offsets (shell `descript.txt`, overridable per surface in `surfaces.txt`) [doc]:

```text
sakura.balloon.offsetx/y   (scope 0)      kero.balloon.offsetx/y   (scope 1, and [guess] scopes >= 2)
surfaces.txt  surfaceN { sakura.balloon.offsetx … ; balloon.offsetx/offset.x (any scope) }  -> wins over descript
direction suffix (SSP): offsetxl/offsetyl (balloon left), offsetxr/yr (right), offsetxc/yc (top/bottom), offsetxb/yb (bottom)
   resolution: xb -> xc -> x ; xc|xl|xr -> x ; same for y, independently
\![set,balloonoffset,x,y]   replaces the offsets until the ghost ends; '@x' / '@y' = relative to the descript/surface value
```

Tsubasa uses `sakura.balloon.offsetx,2` and `sakura.balloon.offsety,14`. She sets no kero offsets and no per-surface offsets.

Alignment modes: `sakura.balloon.alignment` / `kero.balloon.alignment` in the shell `descript.txt`, or `\![set,balloonalign,ID]` (valid until the ghost ends). The values are `none` (default), `left`, `right`, `center` (= `top`) and `bottom`. Anything else counts as `none` [doc].

```text
placeBalloon(scope):
  side = chooseSide(scope)                 // 'left' | 'right' | 'top' | 'bottom'
  ox, oy = offsets for side
  switch side:
   left:   x = S.left - B.w + ox ;               y = S.top + oy      // balloon top-right touches shell top-left
   right:  x = S.right - ox ;                    y = S.top + oy      // +x is always toward the shell
   top:    x = S.cx - B.w/2 + ox ;               y = S.top - B.h + oy
   bottom: x = S.cx - B.w/2 + ox ;               y = S.bottom + oy
  // balloon-side windowposition (descript or <img>s.txt):
  if windowposition.x is numeric: x += windowposition.x       // +right, whichever side is used
  y += windowposition.y
  x += userDragOffset.x ; y += userDragOffset.y               // the user's drag (below)
  if windowposition.limit (default 1): clamp the balloon rectangle into the viewport
  return (x, y)

chooseSide(scope):
  mode = balloonalign override ?? shell alignment ?? 'none'
  if windowposition.x in (center, top): return 'top' ; if bottom: return 'bottom'
  if mode in (left, right, top, bottom): return mode     // center == top
  // none: automatic
  prefer = side[scope] ?? 'left'                                  // the side it is on; persist it (SSP stores Char%d.balloon.isleft [exe])
  if balloon would be cut off on `prefer` and fits on the other side: use the other side   // "見切れる場合、スイッチ" [doc]
  side[scope] = prefer                                             // sticky: a right click toggles it too [observed]
  return prefer                                                    // not "face the screen centre": that switched too early [observed]
```

- Image parity follows the side: left → even, right → odd. The `top` and `bottom` modes use the even (left) image [guess].
- On phones (Sumika's own, `ssp-ui.md` §9.11) [decision]: when the automatic rule finds the balloon cut off on
  **both** sides, it goes above the head, centred over the shell without the shell's offsets (`placeBalloon`'s
  `overhead`, set by a `Balloons` made with `phone`); `top` is never stored as the side. Fixed alignments are obeyed
  as written; desktop never gets it.
- Recompute the position whenever the shell moves (`\![move]`, drag), the surface changes size, the balloon image changes, or the viewport is resized.
- Scopes ≥ 2 are placed against their own character window. Tsubasa uses `\p[5]`, `\p[17]`, `\p[19]`, `\p[23]` and `\p[96]` with text. If a character's surface is empty (Tsubasa's `\1` uses `surface10 {}`), place the balloon against its position point; treat it as a 0×0 rectangle at its `defaultleft`/`defaulttop` or saved position [guess].
- Worked example for Tsubasa (left side, `\b[2]` = 340×384): `x = S.left − 338`, `y = S.top + 14`. The tail tip at image x 339 lands on `S.left + 1`, and the tail's centre row (281) points at `S.top + 295`.
- **User drag** (implemented; SSP lets the user move the balloon, which also carries the menus drawn in it [observed]):
  a left-button press on the balloon's opaque area, choices included, that travels **4 px** (touch: 10 px, like
  character drags) becomes a drag. The press then emits no click, choice or double click. A shorter press is an
  ordinary click (choices, `\x`). The balloon follows the pointer, clamped to the viewport. On release
  `userDragOffset[scope]` = final position − the position computed without any user offset and without the clamp.
  The offset is relative to the character, so the balloon follows character drags. It is kept across side flips
  (right click) and `\b` changes and is not mirrored (SSP's behaviour there is [?]). It is persisted with the balloon
  state (§7). The runtime menu's "Reset position" clears it. Ghost descript `balloon.dontmove,true` disables dragging
  (UI §4.6).

---

## 5. Input boxes (`balloonc*`) (P0 for Tsubasa's name entry, typing game and number games)

| Tag | Box | Default image | Events |
|---|---|---|---|
| `\![open,inputbox,ID,timeout,text,opts…]`, plus `passwordinput`, `dateinput`, `timeinput`, `sliderinput`, `ipinput` (P2) | Input | `balloonc3` | Enter → OnUserInput (R0 = ID, R1 = text, R3+ = `--reference` values). If ID starts with `On`, the event named by the ID fires instead (R0 = text). Close or timeout → OnUserInputCancel (R1 = `close` or `timeout`). If the ghost does not answer OnUserInputCancel after a timeout, send OnUserInput with R1 = `timeout` for compatibility. |
| `\![open,communicatebox(,text)]`, `\__c` | Communicate | `balloonc1` | Enter / OK → OnCommunicate (R0 = `user`, R1 = text); the box **stays open** for the next message [observed, SSP 2.9.08f]. × / Esc → OnCommunicateInputCancel (R0 empty, R1 = `cancel`). |
| `\![open,teachbox]`, `\__t` | Teach | `balloonc2` | Drawn like the communicate box ([field][OK][×]), one word per box: OnTeachStart at opening, Enter / OK → OnTeach (R0… the words taught), × / Esc → OnTeachInputCancel (UI §6.3, P2, implemented). |
| (script box), (address bar) | Send, address | `balloonc0`, `balloonc4` | P2 |
| `\![close,inputbox,ID or __SYSTEM_ALL_INPUT__]`, `\![close,communicatebox]`, `\![close,teachbox]` | — | — | Closes the box **without** firing a cancel event. |

Options [doc]:
- `--timeout=ms`: ≤ 0 means none.
- `--text=…`: initial text.
- `--option=noclose` / `noclear`.
- `--balloon=<n>`: use `balloonc<n>`.
- `--limit=N`: maximum characters.
- `--reference=…`: extra references.

The old positional forms `ID,timeout,text` are equivalent.

Tsubasa's uses: `ユーザ名`, `ユーザ`, `タイプ答え,<ms>`, `数当て答え,,<text>`, `数字記憶答え`, `短冊N`, plus `\![open,communicatebox]` (6 times).

Rendering:
- A small window: the keyed `balloonc` image, with an `<input>` at `communicatebox.x/y/width/height`. Field background = the image's centre pixel unless configured; colour and font per §2.5.
- Enter submits. Esc or a double-click on the box closes it.
- Communicate box [observed, SSP 2.9.08f; layout details guess]: a small **OK** push button right of the field and a
  **×** push button right of OK, both about the field's height. Sumika puts both inside the `communicatebox` rectangle and
  shorten the field to make room: LightBlue `balloonc1` (322×42, field 10,18,301,18) gives a field of 10,18,242,18,
  OK at x 255 (34×18) and × at x 291 (20×18), so × ends where the rectangle ends. Gaps are 3 px between the field and
  OK and 2 px between OK and ×. A rectangle too narrow for that (field < 80 px) keeps its field, and the buttons go
  just right of it, widening the box past its image. The buttons are plain Windows-style push buttons: light grey
  face, 1 px grey border, 12 px UI font. Enter (not while an IME is composing) or OK sends non-empty text, clears the
  field and keeps the focus. Empty text does nothing. × or Esc closes the box. The input box keeps its field at full
  width plus a small corner ×. Whether SSP's input box has the same OK/× buttons is unverified [?].
- Position on screen:
  1. The SHIORI resource `<boxtype>.defaultleft/defaulttop` (box type `inputbox`, `communicatebox`, …) if provided [doc].
  2. Otherwise [guess] just below the scope-0 balloon, left-aligned with it; failing that, centred above the sakura shell. Clamp to the viewport.
- Several boxes can be open at once [doc: SSP does not make input modal].

---

## 6. Other markers (P2 unless noted)

- `\![*]` → see §3.4 (P0).
- SSTP marker and message: no SSTP in a browser.
- Online animation: `\![enter,onlinemode]`, `\![leave,onlinemode]`, and network activity. Cycle `online0..n` every `onlinemarker.interval` ms, drawn at `onlinemarker.x/y`.
- Counter `\![set,balloonnum,label,cur,max]`: text at `number.*` in `number.font.*`, right-aligned at `number.xr`.
- `\![set,balloonmarker,text]`: SSTP marker text. P2.

---

## 7. Balloon state that persists across page loads (project-specific, P1)

Store in browser storage, per ghost and per scope:
- Side toggle (from right-click).
- User drag offsets.
- `\![set,balloonoffset]` and `\![set,balloonalign]` overrides. SSP keeps these until the ghost ends; Sumika's "ghost session" outlives a single page.

Optional: serialise the display list of a balloon that is still open (choices with their IDs, scroll position, remaining timeout) into session storage. A navigation in the middle of a menu can then restore it silently. The display-list design (§8) makes this a JSON dump.

---

## 8. DOM implementation blueprint (P0)

```html
<div class="smk-balloon" data-scope="0"
     style="position:fixed; left:Xpx; top:Ypx; width:Wpx; height:Hpx; pointer-events:none; z-index: shell+1">
  <canvas class="bg"></canvas>                        <!-- keyed balloon bitmap -->
  <div class="content" style="position:absolute; inset:0; overflow:hidden;
       -webkit-mask-image:url(keyedBalloon); mask-image:url(keyedBalloon)">   <!-- balloon alpha wins -->
    <div class="viewport" style="position:absolute; left:Rl; top:Rt; width:Rw; height:Rh; overflow:hidden">  <!-- validRect clip -->
      <div class="scroller" style="transform:translateY(-scrollY px)">
        <div class="layer-back"/>   <!-- \_b positioned, background (balloon coordinates − validRect origin) -->
        <div class="layer-text"/>   <!-- glyph spans (absolute) and inline <img>/<canvas> -->
      </div>
    </div>
  </div>
  <div class="layer-front"/>          <!-- \_b --option=foreground: NOT masked -->
  <div class="layer-cursor"/>         <!-- hover clone + ROP filter, pen border -->
  <img class="arrow0"/><img class="arrow1"/><img class="clickwait"/>
  <div class="hit" style="pointer-events:auto; clip-path: polygon(from alpha)"/>   <!-- clicks only on opaque pixels -->
</div>
```

Engine and paint layers:
- **Layout engine → display list → painter.**
  - The engine (§3) is pure: script ops in, display-list elements with exact integer coordinates out. Unit-test it against §3.10.
  - The painter maps elements to DOM nodes, absolutely positioned. One span per glyph is fine: a balloon holds a few hundred glyphs. Runs of glyphs with the same style can be merged when their advances match the emulated rule.
  - A per-balloon `<canvas>` text layer is an equally valid painter. It makes ROP and shadows simpler, but then text cannot be selected (SSP text cannot be selected anyway).
- **Image keying.** Decode each image into a canvas once, apply the key colour or PNA (§1.3), and cache it as an object URL. That covers balloon images, part images and `\_b` images. Tsubasa's games redraw many `\_b` images every frame with `\_q\c…`, so the cache is required.
- **Hit testing.**
  - The container has `pointer-events:none`. Only `.hit` and the choice regions receive events.
  - `.hit` gets a `clip-path` polygon traced from the alpha mask. A simpler P0 alternative is the opaque body rectangle: LightBlue x 9..330 by the full height, plus the tail triangle.
  - Choice and anchor regions are transparent absolutely-positioned divs inside `.scroller`.
- **Shadow.** A second glyph span in `shadowcolor` at +1,+1 is safer than CSS `text-shadow`: per-glyph emulated advances, and the result can be cloned for ROP.
- **ROP highlight** (only for the optional UKADOC fill; SSP 2.9 draws just the pen, §3.8). Clone `.bg` + `.layer-back` + `.layer-text` into `.layer-cursor`, clipped to the hover rectangle, with `filter:url(#rop-<mode>-<rrggbb>)`. Build the SVG filter lazily.
- **Scale.** The user's Balloon scaling ▸ is implemented (UI §2.9): a CSS `scale()` on the balloon element, every canvas
  backed at image px × devicePixelRatio × scale and drawn nearest-neighbour, the click-wait marker too. Shell-linked
  balloon scaling, `\![set,scaling]` with `balloon.syncscale`, and `dpi` are P2. Use `image-rendering: pixelated` only for integer scales.
  On a phone with no pick the default is the balloon fit (`balloonFit` in placement.js, `ssp-ui.md` §9.11)
  [decision]: the widest balloon image within the screen's short side, its font not below 11 CSS px (`READABLE_PX`)
  unless the screen is narrower, never enlarged.
- **Glyph rendering.** SSP draws 12 px MS Gothic with GDI and its embedded bitmap strikes, so it is crisp. Browsers anti-alias. This is acceptable; optionally set `-webkit-font-smoothing:none` and `font-smooth`.

---

## 9. Default and fallback balloon (when a ghost's balloon is missing) — P1

SSP behaviour:
1. If the ghost has no usable balloon (§1.6), SSP uses the **user's default balloon**. Factory default: SSPデフォルト+, folder `balloon/ssp`, which comes with SSP.
2. That folder also has `ssp_vertical` (named SSPデフォルト+(頭上), "overhead"; vertical text) and `emily4` (Emily/P4's balloon).

Inventory of SSPデフォルト+:

| Images | Size |
|---|---|
| `balloons0`/`1` | 335×169 |
| `balloons2`/`3` | 335×384 |
| `balloonk0`/`1` | 335×96 |
| `balloonk2`/`3` | 335×169 |
| `balloonc0`–`3` | 317×42 |
| `arrow0`/`1` | 8×8 |
| `online0`–`3` | 48×14 |
| `sstp` | 8×8 |

Its `descript.txt` gives:
- `validrect` 23, 14, −23, −12 → no `origin`, so the origin is (23,14)
- `wordwrappoint.x` −25 → `lineLimit` 287
- `font.height` 12; text (84,32,27); shadow (195,195,239); anchor (77,82,194), pen (0,0,255)
- cursor: notmaskpen, square, brush (150,100,100), pen (84,32,27), font (0,0,0)
- `arrow0` (−20, 8), `arrow1` (−20, −18); `onlinemarker` (17, −22); `sstpmarker` (17, −18); `sstpmessage` (29, −20), height 10
- `number` xr −28, y −20, height 10
- `communicatebox` 8, 18, 301 × 18

A **CSS-drawn fallback** (to avoid shipping SSP's images, whose licence is unclear) needs these essentials:
- **Sizes** as in the table above: pairs for s0/s1, s2/s3, k0/k1, k2/k3; c0–c3 at 317×42.
- **Body:** a rounded rectangle inset 9 px on the tail side and 9 px on the opposite side (x 9..325 of 335), with a corner radius of about 12 px.
  - Border: 1 px, about rgb(49,74,132).
  - Fill: a vertical gradient from rgb(214,231,255) at the top to rgb(239,247,255) at the bottom.
- **Tail:** a triangle 9 px tall and 9 px deep on the character side.
  - Its centre row is at y 66 (s0/s1, 169 high), y 281 (s2/s3, 384 high) and y 50 (k0/k1, 96 high).
  - Tip x: 334 on even (left-placed) images, 0 on odd images.
- **Text metrics** as in the descript values above. Keeping `lineLimit` = 287 and origin ≈ (23,13–14) makes layouts tuned for LightBlue or SSPデフォルト+ fit.
- **Markers:** CSS triangles for the arrows; a small dot for `\![*]`.
- **Input box:** a 317×42 rounded panel with a caption ("Input", "Communicate"…) and a field at (8,18) 301×18.

LightBlue itself (§10) is a re-skin of SSPデフォルト+ with identical metrics and colours. So if LightBlue fails to load, the CSS fallback gives a nearly identical layout.

**Sumika's default balloon**: `site/balloon/sumika/` is an original SSP-style balloon with the
inventory and descript values above, generated by `tools/make_default_balloon.py` (never hand-edit its PNGs; re-run the
script, then `tools/index_site.py`). It is the site's "user's default balloon": `tools/index_site.py` writes
`"defaultBalloon": "sumika"` into `ghosts.json` when the folder exists (else the first balloon of `site/balloon/`,
else null; a balloon hoisted from a ghost is never the default), a page may name another with
`data-default-balloon`, and a ghost without a balloon of its own gets it before the built-in canvas one (§1.6). Ghosts
with their own balloon keep it (Tsubasa → LightBlue). The default reached as a fallback is not stored as the ghost's
choice, so a ghost follows the site's default when it changes; picking it from Balloon ▸ stores it like any pick
(§1.6). Like SSP's right-click menu, Sumika's has no item that changes the default balloon (SSP changes it only in
its Explorer) (balloon.md D4). It is free to redistribute with Sumika (its `readme.txt`).

---

## 10. INVENTORY: Tsubasa's LightBlue balloon (`site/ghost/tsubasa/LightBlue/`)

### 10.1 Files

PNG headers were parsed with Python. Every image is 8-bit truecolour (`ct=2`), non-interlaced, with no alpha and **no `.pna`**.

| File | Size | Key (top-left) | Role / notes |
|---|---|---|---|
| `balloons0.png` | 340×170 | (0,255,0) | `\0` id 0, **left-placed** (tail on the right edge, rows 62–70, tip x 339) |
| `balloons1.png` | 340×170 | green | `\0` id 0, right-placed (tail on the left, rows 62–70, tip x 0) |
| `balloons2.png` | 340×384 | green | `\0` id 2, left (tail rows 277–285). **Byte-identical to `balloonk4.png`.** |
| `balloons3.png` | 340×384 | green | `\0` id 2, right. **Byte-identical to `balloonk5.png`.** |
| `balloonk0.png` / `k1` | 340×96 | green | `\1`/`\p` id 0, left/right (tail rows 46–54) |
| `balloonk2.png` / `k3` | 340×170 | green | id 2, left/right (tail rows 119–127) |
| `balloonk4.png` / `k5` | 340×384 | green | id 4, left/right (tail rows 277–285) |
| `balloonc0.png` | 322×42 | green | "Send" (script box) |
| `balloonc1.png` | 322×42 | green | "Communicate" |
| `balloonc2.png` | 322×42 | green | "Teach" |
| `balloonc3.png` | 322×42 | green | "Input" (all of Tsubasa's input boxes) |
| `arrow0.png` / `arrow1.png` | 8×8 | (255,255,255) | Up and down triangles in (108,140,255) / (170,188,252) |
| `online0..3.png` | 82×14 | white | "connect" followed by 0–3 slashes. Animation frames. |
| `online.png` | 82×14 | white | Identical to `online3.png` (old single-frame name) |
| `sstp.png` | 8×8 | white | Round blue dot: the **`\![*]` marker** (there is no `marker.png`) |
| `balloon{s0..s3,k0..k5}s.txt` | 70 B each, all identical | — | `origin.x,23`, `origin.y,13`, `windowposition.x,0`, `windowposition.y,0` |
| `descript.txt` | 1,237 B | — | Shift_JIS, CRLF (keys in §10.2) |
| `install.txt` | 81 B | — | `type,balloon`, `name,LightBlue`, `directory,LightBlue`, `refresh,1` |
| `readme.txt` | 0 B | — | Empty |

Not present: `balloonp*`, `marker*.png`, `clickwait*.png`, `arrows*`/`arrowk*`, `sstp_new*`, `ok`/`cancel`/`mode` buttons, `thumbnail.png`, any `.pna`, and no `font.name`. Shape: body x 9..330 on every image; corner radius about 12; border (108,140,255); fill near white, (250,247,249) to (255,255,255).

Sizes by `\b` ID:

| `\b[id]` | `\0` (balloons*) | `\1` and `\p[N≥2]` (balloonk*) |
|---|---|---|
| 0 | 340×170 | 340×96 |
| 2 | 340×384 | 340×170 |
| 4 | — (falls back, §1.2) | 340×384 |

### 10.2 `descript.txt` keys used

- `charset` Shift_JIS; `type` balloon; `name` LightBlue
- `origin` 23, 13; `wordwrappoint.x` −30, `.y` 0
- `font.height` 12; `font.color` 84,32,27; `font.shadowcolor` 195,195,239
- `anchor.font.color` 77,82,194; `anchor.pen.color` 0,0,255
- `cursor.blendmethod` notmaskpen; `cursor.style` square; `cursor.brush.color` 150,100,100; `cursor.pen.color` 84,32,27; `cursor.font.color` 0,0,0
- `number.font.height` 10, `number.font.color` 0,0,0, `number.xr` −28, `number.y` −20
- `onlinemarker` 18, −22; `sstpmarker` 18, −18; `sstpmessage` 30, −20, `sstpmessage.font.height` 10
- `arrow0` 314, 8; `arrow1` 314, −16
- `validrect` 0, 0, 0, −12
- `communicatebox` 10, 18, 301, 18
- `craftman` macaroni, `craftmanw` マカロニ, `craftmanurl` `http:` (truncated in the file)

### 10.3 Derived geometry (P0)

| Image height | `validRect` | Visible text height from origin | Lines at LH 14 | `arrow1` y | `number` / online / sstp y |
|---|---|---|---|---|---|
| 96 (k0, k1) | (0,0)–(340,84) | 71 | 5 | 80 | 76 / 74 / 78 |
| 170 (s0, s1, k2, k3) | (0,0)–(340,158) | 145 | 10 | 154 | 150 / 148 / 152 |
| 384 (s2, s3, k4, k5) | (0,0)–(340,372) | 359 | 25 | 368 | 364 / 362 / 366 |

Common to all sizes:
- origin (23,13); wrap x 310; `lineLimit` **287**
- `arrow0` at (314,8)
- number right edge x 312; online and sstp marker x 18; message x 30

### 10.4 What the renderer must support for Tsubasa (P0 checklist), with corpus counts

The corpus has 7,334 responses.

1. Balloon selection: `\b[2]` (4,733 uses: 4,678 in `\0`, 49 in `\1`, plus `\p[5/17/19]`); `\b[4]` (79: `\1` playlist, `\p[23]` mahjong yaku list); `\b[0]` (19); `\b[1]` (51, normalised); `\b[-1]` (31).
2. Colour-key transparency for balloon and part images and for **every** `\_b` image (key colours green, (34,177,76), (15,191,44), magenta, black with `opaque`).
3. Layout engine (§3), including:
   - `\_l` absolute and `@`-relative (58,674);
   - inline images (26,497) with eager wrap;
   - positioned `\_b` (235,680; background and foreground; `opaque`; `--clipping`);
   - `\n` (109,693) and `\n[half]` (884); `\_n` (472);
   - `\c` (5,919), `\c[char,1]` (25), `\C` (601).
4. Fonts: MS Gothic metric emulation; `\f[color]`, `\f[shadowcolor]`, `\f[bold]`, `\f[height]` (3–60), `\f[strike]`, `\f[default]`; the default shadow (offset 1 px).
5. Choices: `\__q` around images and text (11,537) and `\q` (4,132), with hover highlight (`notmaskpen` square = pen rectangle only, `\f[cursorpencolor]` 790), click → SHIORI; `\*` (1,627) disables the choice timeout. `\![*]` marker (2,848) drawn with `sstp.png`.
6. Auto-scroll for long talks in the 170 px balloon (10 lines). About 3,770 text segments between line breaks are at least 50 half-width units (≥ 300 px) wide, against a 287 px line, so automatic wrapping happens constantly (`scratch/linelen.py`).
7. Click-wait `\x` (198); visibility, opening and timeouts (§3.11).
8. Input box from `balloonc3` (OnUserInput / OnUserInputCancel) and communicate box from `balloonc1`.
9. Placement with `sakura.balloon.offsetx,2` and `offsety,14`; automatic side choice and flip; clamp to the viewport; balloons for the extra characters `\p[5,17,19,23,96]` against their own windows.
10. Missing `\_b` files and URL images fail silently.

---

## 11. Open questions and how to verify them in real SSP

None of these can be settled from the documentation or the corpus. A calibration script can be run in SSP, using SSTP or the developer palette, with `\![execute,dumpballoon,<dir>,<scope>,<prefix>]` to save PNGs of the balloon. That command exists in SSP 2.9 [doc]; its MCP tool says the dump is taken before scaling and transparency are applied.

1. **Latin wrapping.** Settled: SSP word-wraps (§3.5, observed). Still open: does a word whose **last** character crosses the limit stay on the row (Sumika's model, from the "Hair Clip" label) or move? Does a space after it hang? Test: `\0\b[0]` followed by `x` × 43 + ` word next` (the `d` ends at 288). Also check whether a line that exactly crosses the limit and is followed by `\n` produces an empty line, and whether a missing `\_b[…,inline]` opens a string (§3.3).
2. **Default `\f[valign]`.** Test `A\f[height,24]B\f[height,12]C\n` and look at where A and C sit relative to B.
3. **Line gap for h ≠ 12.** Test `\f[height,24]X\nX\n` and measure the distance between lines. Sumika's guess is 26.
4. **ROP details.** Settled for LightBlue's `notmaskpen`: only the pen is drawn (§3.8, observed). Still open: is the pen drawn through the ROP? What does `copypen` do? Is the hover rectangle the font cell or the line box?
5. **`\b[-1]` followed by more text.** Does the balloon reappear? With which ID?
6. **`\b[odd]`** and **`\b[missing]`** behaviour.
7. **Visibility rule.** Does a balloon open for `\0 \e` (one space), `\0　\e` or `\0\n\e`?
8. **Shadow offset** at large heights, and **synthetic bold** advance widths.
9. **Input-box screen position** when the SHIORI does not supply `*.defaultleft`.
10. **Click on a finished balloon.** Decided: it does not close (SUMMARY C16, §3.11). Still open: is the timeout paused while hovering (SSP default)?
11. **Scroll granularity** (pixels or whole lines) and the wheel step.
12. Meaning of the undocumented `fontspace.*` and `{sakura,kero}.{left,right}.offset` balloon keys [exe].

---

## 12. Balloon change: re-skin in place (Balloon ▸, `\![change,balloon]`, the balloon side of a shell change)

From the research for shell and balloon changes (ssp.exe 2.9.08f's disassembly with `ssp.map`, UKADOC, a corpus of 320
downloaded archives). Nothing here is [observed] yet: §12.5 lists what to compare in ssp.exe. The
events themselves (OnBalloonChange, OnShellChanging/Changed, OnNotifySelfInfo) are in EV §2.6; the menu in UI §2.11.

### 12.1 Balloon ▸ and SSP's name order

Balloon ▸ (scope 0 only; not in the abbreviated menu) [disasm `CSakuraWnd::InitBalloonMenu`]
(`balloonMenu` in `src/core/shells.js`):
- **Top group**, only when not empty: the ghost descript's own balloons (§1.6 rule 3) that are installed, each once, in
  that key order; then a separator. `install.txt` `balloon.directory` is not in it. Tsubasa has no such key, so no top
  group; etherism (`balloon,天使の梯子` + `default.balloon.path,angel_ladder`) gets 天使の梯子 on top.
- Then **every installed balloon** (§1.6) in name order. A top-group balloon appears twice.
- Captions: the descript `name`, cut to 25 characters plus `...` (SSP's default "Max. name length in ghost/balloon
  menu") [disasm: constructor sets 25]; never translated.
- A **check ✓** (not a bullet) on the balloon in use, on its **first** row only [infer: Win32 `MF_BYCOMMAND` checks the
  first item with that id]. **Every row is enabled**, the current one too: a re-pick reloads it and still sends
  OnBalloonChange [disasm].
- SSP's two Yes/No warnings when leaving a recommended balloon (`info.recommended.*` in message.txt) are not done
  [decision: no archive sets `recommended.balloon`].

**Name order** (`compareNames` in `src/core/shells.js`; Shell ▸ uses the same order) [disasm `wcsicmpex` 0x5ad3e0,
`SPProp::operator<` 0x6bb160]:
- UTF-16 units are compared one by one after a key: U+FF01–FF9F shifted down by 0xFEE0 (full-width ASCII = ASCII;
  half-width katakana land on U+0081–00BF), katakana U+30A1–30F4 = hiragana, then SSP's case folding.
- SSP's case folding (its table at 0xb77244) is Unicode simple lower case, except the Latin-1 capitals À–Þ, which it
  leaves alone.
- Where both strings have a digit (ASCII or full-width), the two digit runs are compared as signed 32-bit numbers.
  SSP's quirk is kept: a run's first digit is not width-normalised, so a run that starts with a full-width digit
  counts 65248 more per first digit (`9 < １`).
- A shorter string that is a prefix of the other comes first. Equal names: folder ids in plain case-insensitive order
  (`wcsicmp_custom` 0x5acb10).
- Examples: `640 < 1800 < master` (um.nar's shells), `シェル２ < シェル１０`, `master < 少女語り`, `ＭＡＳＴＥＲ = master`,
  `ハヤト = はやと`, `_x < ax`.
- Name lookups (`\![change,shell|balloon,NAME]`, the descript's `balloon` / `recommended.balloon`) use the plain
  case-insensitive compare (`SPProp::FindFromName` → `wcsicmp_custom`): no width or kana folding [disasm].
- `tools/index_site.py` sorts `shells` and `balloons` with a Python port of both functions (`compare_names`,
  `compare_folders`), checked pair by pair against `shells.js`.

### 12.2 A balloon change

A Balloon ▸ pick or `\![change,balloon,…]` [disasm `SPGhost::ChangeOrReloadBalloonInternal` 0x61d600,
`CSakuraWnd::OnLoadBalloon` 0x495ad0, `SPGhost::ExecuteChangeFromTag` 0x6273f0]:
1. A menu pick is refused while the ghost is minimized, in passive or induction mode, in `\t`, or while another change
   (ghost, shell or balloon) is under way. A script's `\![change,balloon]` asked during another change waits for it and
   then runs (EV §2.6 "Changes in a row"; the script waits at the tag meanwhile) [decision].
2. The tag's target (`resolveBalloonTarget`): the last argument that does not start with `--option=`;
   `--option=raise-event` is parsed and ignored (OnBalloonChange is always sent). `random` = any other installed
   balloon (none: nothing); `sequential` = the next one in menu order, wrapping [guess: SSP's code keeps the last
   candidate after the current one, i.e. the last balloon]; `lastinstall…` = nothing (nothing is installed in a
   browser); else the descript `name`, case-insensitive, first in menu order. Folder ids never match. An unknown name is
   ignored silently. The player waits at the tag until the new skin has loaded, then the rest of the script runs with
   the new look.
3. There is **no OnBalloonChanging** and no farewell: the ghost cannot refuse [disasm: no such event in ssp.exe].
4. The new skin is loaded; a failure changes nothing.
5. **Re-skin in place** [disasm: `SetBalloon` on every character's balloon window, no `HideBalloons`]
   (`Balloons.setSkin` → `BalloonView.setSkin` → `BalloonModel.setSkin`; `Dialogs.setSkin`):
   - open balloons stay open with their text, choices and scroll position, and are laid out again on the new image:
     the text re-wraps at the new width [guess]. Scroll position (`BalloonModel.setSkin`): a balloon the visitor
     scrolled away from the bottom (scrollY < maxScroll) keeps the line at the top of its view: the topmost element in
     view, found again by its order in the replayed layout, at the same pixel offset into it; when the replay gives a
     different element count (`\c[line]` counts wrapped lines) the view keeps its distance from the bottom instead;
     clamped to 0..maxScroll. A balloon at the bottom stays at the bottom (autoscroll follows the end); the autoscroll
     flag is not changed, so later text still scrolls to the end. This also holds for a balloon whose script turned
     autoscroll off [decision]. Not covered yet: an `\_b` image that finishes loading relays the balloon out and sends
     a scrolled-up balloon with autoscroll on to the bottom;
   - each balloon goes back to its scope's default kind (`balloon.defaultsurface`, else 0) on its side [infer:
     `SetBalloon(new, GetDefaultBalloonIndexSetting(scope), -1)`]; `\b[n]` changes recorded in the content are not
     replayed;
   - `\![*]` markers take the new marker's size; font settings the script never changed follow the new skin's default
     font, the ones it changed (`\f`, carried over `\c`) stay [guess];
   - sides (right click or automatic), drag offsets, `\![set,balloonoffset]` and `\![set,balloonalign]` are kept
     [infer: no reset call]; every balloon is placed again;
   - open input, communicate and teach boxes stay open, redrawn from the new `balloonc*` images, with their typed text,
     caret and focus; each keeps its top-left corner [disasm: `SetBalloon` + `InvalidateRect` on every input window;
     infer: not recreated or moved];
   - balloon scaling stays (per ghost) [decision; SSP keeps it per balloon, UI §2.9].
6. The choice is stored (§1.6); OnNotifySelfInfo is sent with the new balloon (R5 name, R6 path), then
   GET OnBalloonChange [R0 descript name, R1 site-absolute folder path ending in `/`] (EV §2.6). OnNotifyBalloonInfo
   is not sent [decision, P2].

### 12.3 The balloon side of a shell change

- Every balloon is closed at the swap (SSP's `HideBalloons`); the event loop does that (EV §2.6).
- `Balloons.setStage(stage)`: the balloons follow the new Stage's `move` / `surface` events, no longer the old
  one's, and visible ones are placed again. Offsets and alignment come from the new shell's descript with the ghost's
  as fallback (placement already reads `stage.shell.descript`).
- `Dialogs.setStage(stage)`: open boxes stay open [infer: separate windows in SSP]; the ones the visitor dragged keep
  their place [decision]. Each other box is placed again (`placeBox`: under the scope's visible balloon, else centred
  above the character) at once when its scope's character on the new stage already has a size (rect width and height
  > 0). The runtime's swap builds every new character without a surface (0×0 at (0,0), EV §2.6), so there the box
  stays exactly where it is and is placed on the new stage's first `move` event for that scope that comes with a size,
  i.e. once OnShellChanged or the restored surface has placed the character (`surface` can come before the placement,
  so only `move` counts). A box dragged or closed meanwhile is no longer waited for; a box whose character never gets
  a surface stays put. The one `move` listener goes when no box waits, on the next `setStage` and on `destroy()`; a
  stage without `on()` means no wait. A box opened fresh while its character has no size is still placed against the
  empty rect (not covered).
- The new shell gets the balloon it boots with (§1.6 rules 1–5: its remembered balloon, else the ghost's choice, the
  descript keys, install.txt, the site default) and switches to it silently when it differs from the current one:
  re-skin in place, no OnBalloonChange, nothing stored, so a live swap and a reload show the same balloon [disasm:
  `LoadShell` → `GetBalloonIDFromSetting` with the shell's value first; `LoadBalloon` sends no event].

### 12.4 Where Sumika differs from SSP (balloon.md §9.2 D1–D5)

| # | SSP | Sumika |
|---|---|---|
| D1 | A bundled balloon is installed into `balloon/<dir>`, so every ghost can wear it. | The indexer hoists bundled balloons into the site's list (§1.6) [decision; the alternative is site + own only]. |
| D2 | The ghost descript's balloon keys come before `install.txt` `balloon.directory`. | The same order at boot (§1.6). The index's `balloon` field keeps its meaning (rule 4). |
| D3 | The choice is stored as the balloon's path, per ghost and per shell. | Its folder id, per ghost (`balloon`) and per shell (`shells.<id>.balloon`); an old stored name still resolves. |
| D4 | The user's default balloon (`balloon.default`, factory `ssp\`) changes only in the Explorer. | The site default (§9); no menu item changes it. |
| D5 | A saved balloon that is gone is overwritten by the fallback (only when a value exists). | The stored value is kept, whichever rule supplied the fallback, so the balloon comes back when re-added; boot writes `balloon` only from rule 2, or from rules 3–4 while nothing is stored (§1.6) [decision]. |

### 12.5 To compare in ssp.exe

1. Tsubasa's Balloon ▸: a ✓ or a bullet? Order `Balloon for Emily/P4`, `LightBlue`, `SSPデフォルト+`,
   `SSPデフォルト+(頭上)`, no top group? Is the current one clickable, and does a re-pick flicker?
2. Pick another balloon while a balloon with text is open (also a tall `\b[2]` menu): is the text kept and re-wrapped?
   Does the kind fall back to the default balloon? An open communicate box: still open, typed text kept, new look?
3. `\![change,balloon,sequential]` from the script input: the next balloon or the last one?
4. `\![change,balloon,X]` in the middle of a script, with an OnBalloonChange reply: does the reply cut the script?
5. A balloon name longer than 25 characters: cut with `...`?
6. Pick a balloon on one shell, switch to another shell and back: does the balloon follow the shell?

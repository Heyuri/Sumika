# SakuraScript (SSP dialect) — implementation spec for the Sumika player

Status: research spec. Target: `site/sumika/sumika.js` script player.
Audience: implementers. This document is normative for Sumika's player unless a line is marked **UNVERIFIED**.

## 0. Conventions

### 0.1 Priority marks

| Mark | Meaning |
|---|---|
| **P0** | Tsubasa needs it (it appears in her corpus, or the corpus breaks without it). |
| **P1** | Common in other ghosts. Implemented after the P0 items. |
| **P2** | Rare, legacy, Windows-only, or impossible in a browser. Parse it, then ignore it or log it. |

Every tag gets parsed, even P2 tags. Priority only decides what the tag does when executed.

### 0.2 Source marks

| Mark | Source |
|---|---|
| [UKADOC-SS] | https://ssp.shillest.net/ukadoc/manual/list_sakura_script.html (this copy documents SSP up to 2.9.08). A text dump is in `docs/research/scratch/ss/list_sakura_script.txt`. |
| [UKADOC-EV] | https://ssp.shillest.net/ukadoc/manual/list_shiori_event.html |
| [UKADOC-S3] | https://ssp.shillest.net/ukadoc/manual/spec_shiori3.html (the `Status` header) |
| [UKADOC-BAL] | https://ssp.shillest.net/ukadoc/manual/descript_balloon.html |
| [SSPHELP-TALK] | https://ssp.shillest.net/ukadoc/ssphelp/config-talk.html (default timeouts) |
| [CORPUS] | The real satori.dll responses for Tsubasa: `tests/corpus/final_{master,bath,date,meal}.res.txt`, counted by `docs/research/scratch/ss/inventory.py`. Full output: `docs/research/scratch/ss/inventory_out.txt`. |
| [SATORI-SRC] | `vendor/satoriya-shiori/satoriya/satori/*.cpp`, read as CP932. |
| [SATORI-DOC] | https://github.com/ukatech/satori-docs (`grammar/09-choices.md`, `11-auto-insert.md`, `13-sakura-script.md`) |
| [NINIX] | ninix-kagari (GPL; used as a reference only, not copied): `lib/ninix/script.rb`, `sakura.rb`, `balloon.rb`. It is an independent baseware that tries to match SSP. Treat it as weak evidence. |
| [SSP-BIN] | String scan of SSP 2.9.08f's `ssp.exe` and `data/language/english/resource.dll`. This gives setting names only, no default values. |
| [INFERRED] | Reasoning from the evidence above. No document states it. |
| **UNVERIFIED** | A best guess. Section 9 lists a test in real SSP that settles each one. |
| [disasm] [doc] [infer] [guess] [decision] | Tags defined in `shiori-events.md` "Legend": ssp.exe 2.9.08f's disassembly; UKADOC; inferred; Sumika's pick, to compare in ssp.exe; a deliberate browser choice. The addresses of raiseother and the timer rules are those of ssp.exe 2.9.9.3000. [observed]: seen in a running ssp.exe. |

Not in the repository: the corpus (`tests/corpus/`), the dumps and scripts in `docs/research/scratch/` and the ghosts
this spec quotes (CLAUDE.md "The ghosts Sumika was tested with"). These are development material, cited as the sources
(CLAUDE.md "Project rules").

---

## 1. Corpus inventory (what Tsubasa actually emits)

### 1.1 Method

`docs/research/scratch/ss/inventory.py` reads every `VALUE ` line of the 4 corpus files. It runs the tokenizer from §3, which has the same rules as the pseudo-code there, quoting and `\]` included. It counts tags, argument shapes and `\![…]` subcommands. The helper scripts `bang.py`, `bimg.py`, `feat.py`, `raisepos.py`, `qbal.py`, `rare.py` and `ctx.py` sit in the same folder and produced the breakdowns below.

Totals:

| Metric | Value |
|---|---|
| Scripts (VALUE lines) | 7 334 (master 4 884, bath 435, date 1 400, meal 615) |
| Scripts ending in `\e` | 7 334 (100 %). Satori always appends `\e` [SATORI-DOC 11-auto-insert]. |
| First tag of the script | `\1` 4 805, `\0` 1 915, `\C` 601, `\p[99]` 13 |
| Script length | median 233 chars, p90 1 702, p99 5 362, max **529 675 chars / 25 839 tags** (`ぷよ消し実行２`, a puzzle-game frame loop) |
| Displayed characters | 1 088 704 (ASCII 921 987, CJK/full-width 154 251, other 12 466). There are no non-BMP characters (surrogate pairs). |
| Escapes `\\` and `\%` | 0 |
| %-environment variables | **0**. Satori expands its own variables before sending. There are 121 literal `%` characters, such as `(42%)`, and none of them is followed by a variable name. |
| Tags with a quoted argument (`"…"`) | 258 682 (`\_b` 258 583, `\q` 84, `\!` 15) |
| Unquoted bracket arguments that contain a backslash | 331. Example: `\_b[card\field.png,23,12,--option=background]`, a Windows path. |
| `\]` escapes | 0 |
| U+0001 characters | 6 866, all inside `\q[…]` IDs. Example: `\q[Keep Reading,\x01Keep Reading\x011]`. They must pass through untouched. |

### 1.2 Tag counts (all 4 files)

| Tag | Count | Forms seen | Priority |
|---|---:|---|---|
| `\_b[…]` | 262 313 | `x,y` 235 816; `inline` 26 497 | P0 |
| `\n` | 110 577 | plain 109 693; `[half]` 884 | P0 |
| `\_l[…]` | 58 674 | args: absolute `N` 88 343, relative `@N` 28 974, full-width `＠N` 31 | P0 |
| `\s[…]` | 32 317 | 248 distinct ids, including `-1` (617). The digit form never appears. | P0 |
| `\w` | 29 472 | `\w4` 10 418, `\w8` 17 583, `\w9` 1 325, `\w1/2/3/5/6` 76. Non-standard: `\w[1000]` 64, `\w[1500]` 4, `\w[2000]` 2 | P0 |
| `\f[…]` | 23 876 | see §1.4 | P0 |
| `\__q` | 23 294 | open `\__q[…]` 11 537; close `\__q` 11 757. That is **220 stray closes**: the author deleted the opening tag of "selected" options but left the close. | P0 |
| `\0` | 17 658 | | P0 |
| `\_w[…]` | 14 990 | min 6, max 15 000 ms | P0 |
| `\_q` | 14 200 | 136 scripts end with quick mode still on | P0 |
| `\1` | 9 059 | | P0 |
| `\![…]` | 8 678 | see §1.3 | P0 |
| `\e` | 7 334 | | P0 |
| `\p[…]` | 7 029 | 30 distinct scopes: 99 (5 595), 100 (250), 95 (100), 5, 27, 11–16, 23, 96, 10, 19, 9, 17, 98, 97, 22, 26, 20, 21, 24, 25, 2, 3, 4, 18, 101 | P0 |
| `\c` | 5 944 | plain 5 919; `[char,1]` 25 | P0 |
| `\b[…]` | 4 913 | `[2]` 4 733, `[4]` 79, `[1]` 51, `[-1]` 31, `[0]` 19 | P0 |
| `\q[…]` | 4 132 | `[title,ID]` 3 412; `[title,OnXxx,r0]` 717; 3 broken ones from unexpanded Satori expressions | P0 |
| `\*` | 1 627 | | P0 |
| `\t` | 680 | | P0 |
| `\C` | 601 | always the first tag of its script | P0 |
| `\h` | 541 | | P0 |
| `\_n` | 472 | | P0 |
| `\x` | 198 | always followed by `\n` | P0 |
| `\-` | 32 | | P0 |
| `\v` | 8 | | P2 |
| `\6` | 4 | inside "adjust the clock" talks | P2 (no-op) |
| `\j[…]` | 4 | `\j[OnAnchorSelect.URL]`, an artefact of the harness | P1 |
| `\+` | 3 | random ghost change | P1 |
| `\8` | 1 | **without brackets**: `…introduction.\8\n` | P2 (no-op) |

Tags that never occur: `\i`, `\_a`, `\_s`, `\_v`, `\_V`, `\__w`, `\x[noclear]`, `\_?`, `\_!`, `\_u`, `\_m`, `\&`, `\4`, `\5`, `\7`, `\a`, `\z`, `\__t`, `\__c`, `\__v`, `\m`.

### 1.3 `\![…]` subcommands

| Subcommand | Count | Argument shapes seen |
|---|---:|---|
| `bind` | 3 292 | `bind,cat,part,1\|0`. 535 distinct. The part may be empty (`bind,足,,0` = the whole category). |
| `*` | 2 848 | Used as a bullet before `\q` in menus. |
| `raise` | 970 | 801 are `raise,OnDirectSaoriCall,…` (Satori's `sync` function [SATORI-SRC satori_builtin.cpp `func_sync`]); 692 of those have more text after them. Each of the other 169 raises (real events) is the last tag before `\e` (`…\![raise,X]\e`), so it works as a "goto". |
| `timerraise` | 530 | `timerraise,ms,1,Event[,r…]`. ms values seen: 0 (cancel), 1, 10, 80, 930, 1000, 2000, … |
| `set,alignmentondesktop` | 443 | always `free` (the legacy spelling of `alignmenttodesktop`) |
| `move` | 433 | legacy positional form `move,X,Y,time,base,baseOffset,moveOffset`. Typos and junk occur: `ritht.top`, `left`,`top`, X=`豆撒き4`. |
| `raiseplugin` | 64 | `スタンプ帳` plugin |
| `open,inputbox` | 28 | `open,inputbox,ID[,timeout[,text]]`, for example `タイプ答え,11500` and `数当て答え,,（数当て答え）` |
| `close,inputbox` | 13 | |
| `set,wallpaper` | 12 | `"壁紙換装",center\|tile\|stretch` |
| `set,scaling` | 11 | `-100,100` (horizontal mirror) |
| `change,ghost` | 10 | `random`, and an unexpanded variable |
| `open,communicatebox` | 6 | |
| `set,windowstate` | 5 | `minimize` |
| `open,mailer` | 4 | |
| `call,ghost` | 3 | |
| `raiseother` | 3 | junk arguments |
| `updatebymyself` | 2 | |
| `open,browser` | 1 | |

### 1.4 `\f[…]`, `\_b` options, choices

* `\f`: `default` 3 830; `color,R,G,B` (12 distinct colours, 5 747 uses); `color,default` 2 215; `bold,1` 3 520; `bold,default` 179; `shadowcolor,R,G,B` 3 555; `shadowcolor,default` 155; `height,N` 3 485 (N = 3, 8, 12, 16, 20, 24, 30, 60); `cursorpencolor,R,G,B` 790; `strike,1|0` 400. Every colour is in the `R,G,B` form.
* `\_b` options: `--option=foreground` 8 661, `--option=background` 3 709, `opaque` 2 908, `--clipping=l t r b` 45. Paths: 258 583 quoted and 3 730 unquoted. Extensions: `.png` 258 862, `.gif` 31 (http URLs of a defunct weather service), none 3 420 (unexpanded Satori variables).
* Image transparency: 647 of the 658 PNGs in `ghost/master` are RGB. The other 11, which include the menu buttons `menu/choice{1,3,5}.png`, are RGBA, but **fully opaque, with a (0,255,0) chroma key in the top-left pixel**. So `\_b` **must** use the top-left pixel as a colour key by default (§5.3.2). This is P0.
* Choices: 2 708 scripts contain choices. 1 419 of them have `\*`, so there is no timeout. In the other 1 289 the choice timeout applies. Up to 136 choices appear in a single script. Every `\__q[…]` range contains an inline `\_b` image (a button), and the label is then drawn over the image with `\_l[@0,@-16]` or `\_l[@-150,@3]`.
* Scopes per script: 2 → 1 344, 3 → 5 547, 4 → 211, and up to 25 scopes in one script.
* Other script-level counts: `\_q` in 3 338 scripts, `\_b` in 2 833, `\_l` in 3 010, `\b` in 1 353, `\t` in 562, `\x` in 186, `\-` in 32, `raise` in 540, arming `timerraise` in 405, cancelling `timerraise` in 63.

### 1.5 What the inventory makes P0

`\0 \1 \h \p[n]` (any n up to at least 101), `\s[n]`/`\s[-1]`, `\b[n]`/`\b[-1]`, `\n`/`\n[half]`, `\_n`, `\c`/`\c[char,n]`, `\C`, `\_l` (absolute and `@` relative), `\_b` (absolute and inline, quoted paths, `opaque`, `--option=foreground|background`, `--clipping`, colour key), `\f` (`default`, `color`, `bold`, `shadowcolor`, `height`, `strike`, `cursorpencolor`), `\w1-9`, `\w[n]`, `\_w`, `\_q`, `\t`, `\x`, `\*`, `\e`, `\-`, `\q[t,id]`, `\q[t,OnX,r…]`, `\__q[id]…\__q`, `\__q[OnX,r…]` and stray `\__q`, `\![*]`, `\![raise]`, `\![timerraise]`, `\![bind]`, `\![move]` (legacy positional form), `\![set,alignmentondesktop|alignmenttodesktop]`, `\![set,scaling]`, `\![open,inputbox]`/`\![close,inputbox]`, `\![open,communicatebox]`, and quoting plus `\]` in brackets.

---

## 2. Input contract

1. **Decode first, tokenize second.** The SHIORI response is decoded with its `Charset` (Shift_JIS for Satori ghosts) into a JS string before any parsing. Never scan bytes. In CP932 the second byte of a double-byte character may be 0x5C. Examples: 表 = 0x95 0x5C, ソ = 0x83 0x5C. 0x5C must decode to U+005C, not to U+00A5. `TextDecoder('shift_jis')` does both correctly. [INFERRED from CP932]
2. Tag syntax is ASCII only. The full-width characters `＼` (U+FF3C), `￥` (U+FFE5), `［` and `］` are plain text. Tag names use ASCII letters, digits and a few symbols only [SATORI-DOC 13-sakura-script].
3. Raw CR and LF cannot occur in a SHIORI `Value`. If a script from another source (embed or a script: choice) contains them, drop them without output. [INFERRED]
4. U+0001 is a field separator in SSP and Satori. Inside tag arguments it is data and must be kept. In display text, do not draw it (zero width). [CORPUS, UKADOC-SS uses "バイト値1区切り" for lists]
5. The tokenizer must handle a 530 KB script with 26 000 tags in well under 50 ms. Use a single linear pass and no regex backtracking. Run it **lazily or once per script, not once per character**.

---

## 3. Tokenizer

### 3.1 Token model

```ts
type Token =
  | { t: 'text', s: string, pos: number }                  // run of literal characters (already unescaped)
  | { t: 'tag',  name: string, args: string[] | null,      // null = no bracket / no digit argument
      form: 'none' | 'digit' | 'bracket' | 'bracket2',     // bracket2 = legacy \q[ID][title]
      raw: string, pos: number }                           // raw = exact source text of the tag; pos = index in script
  | { t: 'env',  name: '*', raw: string, pos: number };    // %* only: every other %-variable is expanded before (§3.5)
```

`pos` is the index of the token in the source string. `OnBalloonBreak` needs it: Reference2 is the break position counted in characters, tags included [UKADOC-EV OnBalloonBreak].

### 3.2 Tag-name lexing

After a `\`, as ssp.exe 2.9.10.3000's `SPGhost::DecodeProcReal` 0x628de0 reads it [disasm]. It
dispatches the character after the `\` through a byte map 0x62c344 (characters 0x21–0x7a) and the jump table
0x62c2d0, after `\\`, `\%`, `\&`, `\_u`, `\_m`; `\_` and `\__` have their own branches (0x62ad77, 0x62bbe0). Any
name below is the whole set it knows (`TAG_POLICY` in `src/sakura/tokenizer.js`):

| Next chars | Result |
|---|---|
| `\` | literal `\` (escape) |
| `%` | literal `%` (escape) |
| one of `0 h 1 u p s i b n w t j c x q * v 8 m 4 5 6 7 + B U f ! - C l e y z a &` | a 1-char tag (§3.3) |
| `_` + one of `u m c i e q n w v V a b l s ! ? +` | tag `_X` |
| `_` `_` + one of `c q t v w` | tag `__X` |
| `_` `_` + any other character (or none) | "unknown tag" (0x62bd71): all of it is swallowed, nothing shows; a `[` after it is text. Sumika: an `unknown` token, which the player skips and reports |
| `_` + any other character (or none) | "unknown tag" (0x62bd8c): SSP writes the `\`, then reads on from the `_`, so `\_h` shows as `\_h` and `\_d[stop]` as `\_d[stop]` |
| any other character (a letter or digit not listed, `?`, `[`, `,`, a space, a non-ASCII character …) | "unknown tag" (0x62be00): SSP steps back onto that character and reads on, so only the backslash is gone: `\k[1]` → `k[1]`, `\わたくし` → `わたくし`, `\[3]` → `[3]`. A CR, LF or TAB after `\` is skipped, as everywhere in a script (0x629126) |
| nothing (the `\` ends the script) | literal `\` (0x629205) |

Notes:
* `\URL[…]` (a legacy Materia tag [NINIX script.rb]) is no tag in ssp.exe: `U` goes to the underline handler, so it is
  `\U` and the text `RL[…]`. No UTF-16 `URL[` is in the binary; none of the corpus' dictionaries has one.
* `\B` and `\U` are `\f[bold,toggle]` and `\f[underline,toggle]` (0x62ac6a, the strings at 0xbc1598 / 0xbc1574), `\y`
  ends the script like `\e` and `\z` (0x62bea9), `\l` and `\_i` do nothing (0x62be92, 0x62aeed), `\_e` hides the
  balloon (`SPBalloonWnd::Hide`, each `\_s` scope's while `\_s` is on, 0x62aef3), `\_c[X]` plays what
  `SPShiori::GetSentence(X)` answers (0x62ade9; Sumika reports it and does nothing, P2).
* `\-` runs only in a safe script (`SPGhost::IsSafeScript` 0x62c500, `[ghost+0x428c]` bit 2 clear); otherwise it is
  the unknown-tag case without the error, and `-` shows (0x62be00). Sumika has no unsafe scripts (CLAUDE.md, the
  "untrusted script" gate is not copied).
* So the `\` before a non-ASCII character, a space or `[` is dropped, a letter, digit or `! & * - + ?` SSP does not
  know is no tag (its bracket is text, not skipped), and `\URL[…]` is `\U` and text. Corpus
  (the 333 archives and site ghosts, lines that hold other script tags; a raw scan, so some hits are
  engine syntax that never reaches the player): `\` + a letter or digit SSP does not know 3,096 in 74 ghosts (2,422
  nibihada's `\k[…]`, many file paths such as `ghost\master`), `\` + non-ASCII 191 in 50 (the BTH family's `\わ`, `\…`:
  bthver.5's `、\わたくしの` shows without the `\`), `\` + a symbol 229 in 31 (`\[` 163), `\_X` 290 in 3 (288 maya's
  `\_h`), `\__X` none, `\_e` 21, `\_c` 3, `\B` / `\U` / `\URL[` / `\w_` none.

### 3.3 Argument policy per tag

| Policy | Tags | Rule |
|---|---|---|
| NONE | `\0 \1 \h \u \e \y \z \- \+ \_+ \* \t \v \4 \5 \6 \7 \a \C \l \B \U \_q \_n \_V \_? \_! \_i \_e \__t \__c` | Takes no arguments. A `[` right after the tag is ordinary text. |
| DIGIT_OR_BRACKET | `\s \b \p \i \w` | If the next char is an ASCII digit `0-9`, the argument is **that one digit**: `\s10` is `\s[1]` followed by the text "0" [UKADOC-SS \w, \s, \p]. Otherwise, if the next char is `[`, a bracket argument follows (`\p[` and `\w[` by their own rules, §3.4). Otherwise there is no argument, and the tag does what the table below says. |
| OPTIONAL_BRACKET | `\n \c \x \_a \__q \_s \__v` | A bracket argument is taken if `[` follows immediately; without one the tag runs with none (ssp.exe logs nothing). |
| REQUIRED_BRACKET | `\_w \__w \q \_b \_l \f \j \! \8 \_v \_u \_m \_c \& \m` | A bracket argument is taken if `[` follows. Without `[` the tag does what the table below says. |
| `\q` | `\q` + one character, `\q[A][B]`, `\q[A]` | See §3.4 and §3.6. |
| `\w_` | `\w_N`, `\w_[N]` | `\w` skips one `_` when two more characters follow it, then reads a digit or `[` as usual (0x62a191) [disasm]: `\w_5` waits 250 ms; at the very end of the script (`\w_5` last) it does not, and `_5` shows. |
| UNKNOWN | any other name | §3.2: the character shows (`\k` → `k`), `\_X` shows as written, `\__X` is swallowed; a bracket after it is text. |

**No bracket where one is needed** (no `[`, nor a digit where one may stand). Read in ssp.exe 2.9.10.3000's
`SPGhost::DecodeProcReal` 0x628de0 [disasm]. `ParseBracket` 0x6263d0 and `ParseParameters` 0x625e40
return false and leave the position alone when the next character is not `[`. Each handler then does one of two
things, and logs "missing '['" (0xbc16f0) or, for `\s \b \p \i \w`, "missing '[' or digit" (0xbc151c) through
0x62e460:

| Tag | Then | Shows |
|---|---|---|
| `\s` (0x629a0a), `\b` (0x629d1b), `\i` (DecodeProcAnimeExec 0x628cc3), `\j` (0x62a2f1), `\!` (0x62ad74), `\&` (0x6292bc) | the position goes back one, onto the tag's letter | the letter and what follows: `\sx` → `sx`, `\1\sもう少し` → `sもう少し`, `\!raiseother[a]` → `!raiseother[a]` |
| `\_u`, `\_m` (0x6293a1), `\_w`, `\_b` (both through 0x629394), `\_l` (0x62b8f2), `\_v` (through 0x62b8e5), `\_c` (0x62adb5) | back two, onto the `_` | `\_ux` → `_ux` |
| `\__w` (0x62bd4d) | back three, onto the first `_` | `\__wx` → `__wx` |
| `\p` (0x629825), `\w` (0x62a29d), `\q` (0x62a561), `\f` (0x62abf7), `\8` (0x62a79b), `\m` (0x62aac8) | the position stays after the name (`\q` has also skipped one character, §3.6) | nothing; the next character is read as usual |

Only the backslash is gone: the loop's next turn (0x629108) reads the letter as text, as it reads any character but
`\`. When the name is the last thing in the script (the position at the length, `[ebp-0x28]`, the JWString length
less its NUL), the handlers stop before the error and nothing shows (`\p` and `\w` still log theirs). The
optional-bracket tags never log it.
`\8`, `\m` and `\_v` first test `SPGhost::IsSafeScript` 0x62c500 (`[ghost+0x428c]` bit 2) and do nothing at all in an
unsafe script, their bracket then showing as text (Sumika has no unsafe scripts, §3.2). Sumika: the tokenizer drops
the backslash and reads on as text for the first three rows (`STEP_BACK` in `src/sakura/tokenizer.js`); the last
row's tags and the end-of-script case are tag tokens with no arguments, which the player ignores. Corpus (the 333
archives and site ghosts, lines that hold other script tags; a raw scan, so some hits are engine syntax expanded
before the player, such as Kawari's `\s${…}` or the `ai` ghosts' `\s_set_talk[…]`): `\s` 45 in 21 ghosts, `\b` 5 in
2 (alto's and kuro's `\b\0`, `\b\1`), `\j` 18 in 1, `\!` 1 (kanade_2nd's developer dictionary `\!raiseother[`),
`\i` and `\_w` 1 each (nibihada's list of tag names); none in Tsubasa's corpus. The consumed ones: `\w` 112, `\f` 35,
`\8` 29 (the `\8\n` above), `\m` 11.

### 3.4 Bracket-argument grammar

Settled from ssp.exe 2.9.08f's disassembly [disasm]; the notes are `scratch/tagquotes/ssp.md` (the loops
in `scratch/tagquotes/parse.txt`, a JS model in `ssp_parse.mjs`). Code: `parseBracket` / `parseString` and the `\p` /
`\w` / `\q` branches of `tokenize` (`src/sakura/tokenizer.js`). There is **one grammar** with two readers:

| Reader | Tags | Commas |
|---|---|---|
| `SPGhost::ParseParameters` 0x6240d0 (`parseBracket`) | `\! \b \c \f \i \m \q \x \_a \_b \_l \_s \__q \__v \__w`, and unknown tags (§3.3) | split; `\,` is a literal comma |
| `SPGhost::ParseBracket` 0x624660 (`parseString`) | `\s \n \j \8 \& \_u \_m \_w \_v \_c`, the legacy `\q[ID][title]` | data: one string; `\,` stays `\,` |
| DecodeProcReal's own loops | `\p[…]` (0x627ac0), `\w[…]` (0x628457) | below |

```text
read(src, i, split):             // src[i] == '['; both readers, split = ParseParameters
  args = []; cur = ''; j = i + 1; inQuote = false
  while j < len(src):
    c = src[j]
    if inQuote:
      if c == '"':
        if src[j+1] == '"': cur += '"'; j += 2; continue        // "" -> "
        inQuote = false; j += 1; continue                         // the quote itself is dropped
      cur += c; j += 1; continue                                  // , ] \ are data inside quotes
    if c == '\\':                                                 // \X is always a pair
      if src[j+1] == ']' or (split and src[j+1] == ','): cur += src[j+1]   // \] -> ]   \, -> ,
      else: cur += c + src[j+1]                                   // \\ stays \\, \" stays \", \f stays \f
      j += 2; continue
    if c == '"':  inQuote = true; j += 1; continue                // anywhere, not only at an argument's start
    if c == ',' and split: args.push(cur); cur = ''; j += 1; continue
    if c == ']':  args.push(cur); return { args, end: j + 1 }
    cur += c; j += 1
  args.push(cur)
  if inQuote and src ends with ']': return { args, end: len(src) }   // SSP's last-character check (0x6243cf)
  return { args, end: len(src), unterminated: true }
```

Notes:

* **A quote opens anywhere** outside quotes and is dropped; the argument goes on after it closes:
  `a"b,c]d"e` → `ab,c]de`, `k="x"&m="y"` → `k=x&m=y`, ` "a,b"` → ` a,b`. Outside quotes `""` opens and closes at
  once and adds nothing (`a""b` → `ab`). Every UKADOC example ("from the 2nd argument on, quote the whole argument")
  parses the same; SSP also takes the first argument (Tsubasa's 258 583 `\_b["menu\choice5.png",inline]`).
* **Backslashes are pairs outside quotes**, so a backslash never ends the bracket: `\_b[card\field.png,…]` keeps
  `card\field.png` (331 times unquoted [CORPUS]), `\![raise,OnX,a\\]b]` ends after `a\\`, and bee's
  `\![raiseother,…,\![reload\,shell\]]` passes `\![reload,shell]`. Inside quotes the backslash is plain data:
  `"a\]b"` stays `a\]b`, `"a\"` closes at that `"`.
* **Unclosed** (no `]` outside quotes before the end): SSP logs `[GHOST/Script] Unclosed '[' at position N`, does
  not run the tag and moves to the end of the script, so nothing after it plays, the reply's `\e` included. The token
  carries `unterminated: true` and runs to the end; the player drops it (`_exec`). The one exception is a script that
  ends inside an open quote on a `]`: then the bracket counts as closed there (`\![raise,OnX,"abc]` → `abc]`).
* **Empty arguments.** SSP stores an empty argument before others as the placeholder `" "` (one space) and an empty
  last one as `""`. The tokens hold `''` for both: SSP's ParametersToArray and `bind` turn `" "` back into empty
  (EV §4.15's `parseHttpOptions` re-creates it: there it is one more parameter `" "`). Handlers that take their
  References through ParametersToArray stop at an empty last argument and read a one-space argument as empty
  (`refList`: raise, notify, embed, timerraise, timernotify, raiseother, notifyother, timerraiseother,
  timernotifyother, `\q` / `\_a` / `\__q` references) [disasm 0x6244a0, 0x633548]. The
  timer forms too: SSP copies the list into the timer up to its first empty string (0x633089–0x633141) and fires it
  through ExecuteRaiseTimer 0x632bc2 → ExecuteRaiseReal → ParametersToArray (0x633548) [disasm], so
  `\![timerraise,5000,1,OnRemind,]` (a Satori `（予定）` that expanded to nothing) raises OnRemind with no References.
* **One-string tags** keep commas: `\s[0,wait]` is the string `0,wait` (SH: the shell's `alias` splits it into
  alias candidates, else the leading number of the whole string, GetSurfaceIndexChar 0x6e9220), `\n[half,x]` is
  `half,x`, `\8[a,b.wav]` a file name with a comma.
* **`\p[…]`** reads every character up to the **first** `]` (or the end of the script), no quotes or escapes:
  `\p["1]"]` ends after `"1`. `\p[]` is scope 0 (SSP logs "invalid scope number" and goes on with 0); anything but
  digits switches nothing here (SSP folds any character into a number; such a number names no character [infer]).
* **`\w[…]`** takes digits up to `]`, commas skipped (`\w[1,000]` = 1000 ms). Any other character (a space, a quote, a
  sign) or the end of the script puts SSP back at the `[`, which shows as text, and the tag waits 0.
* **`\q`** (0x6287b1): any one character other than `[` after `\q` is skipped (`\q0[ID][title]`, `\qa` eats the `a`);
  a `[` right after the bracket's `]` makes it the legacy form, both brackets re-read as one string each (`\q[A,B][C]`
  → ID `A,B`, title `C`); otherwise it needs two arguments: with one ("too few parameters") SSP goes on at the `[`,
  so `\q[abc]` shows `[abc]` (§3.6). The rewind (0x628948 resets the position) makes each `\q[` inside that
  bracket read to the same `]` again, so `\q[\q[\q[…]` costs the square of its length [disasm; in SSP: infer]. The
  tokenizer gives the same tokens in linear time: when the bracket held no `"`, a later `[` inside it is read from the
  same state (a `[` never starts a `\X` pair), so it ends at the same `]` with no comma: too few again [infer;
  measured: 800 000 random scripts, 51 797 shortcuts, tokens identical to the rescan; 20 000 nested
  `\q[` 1 958 ms → 9 ms]. A bracket with a `"` is rescanned (`\q[a"\q[b,c"]`: the inner one is a choice, ID `c]`).
* Do **not** trim whitespace around arguments in general. Choice titles keep their spaces. Numeric and keyword arguments are trimmed by the consumer before parsing (§3.7).
* A `[` inside an argument is literal. There is no nesting, so `\q[a,script:\q[b,c]]` needs quotes around the script
  argument [UKADOC-SS \q script: example]; re-joining a jump ID with its references (§5.6.2) brings its commas
  back, not a `]`.
* Checked against SSP's model over the corpus (6 773 dictionaries of the site and the 323 archives, 331 212 bracket
  tags): the tokenizer ends and splits every one as SSP does, the `" "` placeholder aside [measured].
  The 75 tags with a quote in the middle of an argument (33 ghost folders; 73 web claps that put the user's text in
  quotes after `message_body=`, roommate's and yomi_to_syu's `"[（拍手送信元）]（拍手送信内容）"` with a literal `]`)
  are one tag each, and the quotes are not posted (EV §4.15). A quote honoured only at an argument's start would end
  roommate's and yomi_to_syu's tag at the `]` after the sender, lose `--async=webclap` and show `…",--async=webclap]`
  in the balloon.

### 3.5 %-variables (P1; Tsubasa uses none)

Rewritten from ssp.exe 2.9.9's `SPGhost::TranslateParam` / `TranslateParamReal` 0x636440 / 0x636510
[disasm]; the full rule is `properties.md` §2, the code `src/sakura/expand.js` (`expandScript`).

Known names, matched **longest first** (`%selfname2` before `%selfname`):

`month day hour minute second username selfname selfname2 keroname screenwidth screenheight exh et wronghour ms mz ml mc
mh mt me mp m? dms lastghostname lastobjectname * property[...]`

* **When**: once over the whole script, before it plays (before OnTranslate; again after an OnTranslate that changed
  it; on a `\![embed]` reply before it is spliced in) [disasm `SPGhost::Loop` 0x63B747, 0x63B7AF–0x63B822, 0x633349].
  The embed reply then goes through OnTranslate too, and a changed one is spliced as returned, not expanded again
  [disasm `EmbedSendEventFunc` → `TranslateScript` 0x633389] (EV §4.10).
  Not when the text is drawn, as UKADOC's 環境変数 suggests: a value is read when the script starts
  (`\s[5]%property[currentghost.scope(0).surface.num]` gives the surface from before `\s[5]`). The event loop does it
  (properties.md §2.1); the player and the tokenizer see plain text, except `%*`, which stays the marker (`\![*]`).
* **Where**: in text only. `\` skips itself, up to two `_` and the tag letter, and a bracket right after the letter
  up to its first `]` without a `\` before it (quotes are not honoured). So nothing inside any tag's bracket is
  expanded: not a `\q[title,…]` title, not `\![raise,…]` arguments. Text
  between tags (`\_a[ID]text\_a`, `\__q[ID]text\__q`) is. `\%` is never expanded.
* `%property[NAME]`: NAME runs to the first `]` (no quotes, no escapes); unclosed or empty: left as written; a failed
  name is removed; the value goes in raw (properties.md §2.2).
* `%username`, `%selfname`, `%selfname2`, `%keroname`, `%lastghostname`, `%lastobjectname` double the backslashes of
  their value [disasm 0x637252, 0x6370B1, 0x63705E, 0x636B1D, 0x636B70, 0x636BC9].
* An inserted value is scanned again from its 2nd character; the whole pass repeats while the text changes, at most
  5 times [disasm 0x6372F4–0x637307]. Sumika stops a value that grows the script for ever [decision].
* Matching is case-sensitive [disasm: a switch on the first letter, then `CheckString`]. A `%` that starts no known
  name is text; `%%` is no escape (the second `%` can start a name) [disasm 0x6365E1].

### 3.6 Legacy `\q` forms (P2)

As ssp.exe 2.9.08f's `\q` handler (DecodeProcReal 0x6287b1) reads them [disasm]:

* `\q` followed by one character that is not `[` (a digit in `\q0[ID][title]`): that character is skipped, whatever
  it is. Without a `[` after it the tag does nothing (`\qab` shows `b`).
* `\q[A][B]`, a `[` right after the first bracket's `]` whatever A holds: legacy form, both brackets re-read as one
  string each (commas are data), ID = A and title = B; a choice with an automatic newline after it [UKADOC-SS].
  `\q[A,B][C]` has the ID `A,B`.
* Otherwise the new form `\q[title,ID,refs…]` needs two arguments. With one, SSP logs "too few parameters" and goes on
  at the `[`, so `\q[abc]` shows `[abc]` as text.

### 3.7 Lenient numeric parsing (shared helper)

`num(s, dflt)` trims the string and accepts `[+-]?digits[.digits]`. Everything else returns `dflt`. **Do not** convert full-width digits or `＠`. SSP most likely uses C `wcstol`-style parsing, so `\_l[0,＠-31]` gives `y = 0`. **UNVERIFIED.** Those 31 uses are in a dead weather feature.

### 3.8 Full tokenizer (state machine)

```text
TAG_POLICY = { ... table §3.3 ... }
ENV_NAMES  = [ 'property', 'selfname2', 'selfname', 'keroname', 'username', 'screenwidth', 'screenheight',
               'lastghostname', 'lastobjectname', 'wronghour', 'minute', 'second', 'month', 'hour', 'day',
               'exh', 'dms', 'et', 'ms', 'mz', 'ml', 'mc', 'mh', 'mt', 'me', 'mp', 'm?', '*' ]
             // match order must be length-descending wherever one name is a prefix of another (selfname2 > selfname)

tokenize(src):
  out = []; text = ''; textPos = 0; i = 0; raw = null      // raw = null | '_?' | '_!'
  addText(s, at) = { if text == '': textPos = at;  text += s }
  flush()        = { if text != '': out.push({t:'text', s:text, pos:textPos}); text = '' }
  while i < len(src):
    c = src[i]
    // --- raw (verbatim) sections: \_? ... \_?  and legacy \_! ... \_!
    if raw != null:
      if src.startsWith('\\' + raw, i): flush(); out.push({t:'tag', name:raw, args:null, form:'none', raw:'\\'+raw, pos:i}); raw = null; i += 3; continue
      addText(c, i); i += 1; continue
    if c == '\\':
      if i + 1 >= len(src): addText('\\', i); i += 1; continue               // lone trailing backslash
      d = src[i+1]
      if d == '\\' or d == '%': addText(d, i); i += 2; continue              // escapes
      // ---- tag name (§3.2: only the names ssp.exe knows)
      if d == '_':
        if src[i+2] == '_': name = '__' + (src[i+3] ?? ''); j = min(i + 4, len(src))  // unknown: swallowed
        else if src[i+2] in UNDER: name = '_' + src[i+2]; j = i + 3
        else: addText('\\_', i); i += 2; continue                             // unknown \_X: as written
      else if d in ONE_CHAR: name = d; j = i + 2
      else: i += 1; continue                                                   // unknown \X: the `\` is dropped
      pol = TAG_POLICY[name] ?? 'UNKNOWN'
      args = null; form = 'none'
      if name == 'w':
        k = (src[j] == '_' and j + 2 < len(src)) ? j + 1 : j                   // \w_N, \w_[N]
        if isAsciiDigit(src[k]): args = [src[k]]; form = 'digit'; j = k + 1
        else if src[k] == '[': digits (commas skipped) up to ']', else no argument and the '_' or '[' is text
      else if pol == 'DIGIT_OR_BRACKET' and j < len(src) and isAsciiDigit(src[j]):
        args = [src[j]]; form = 'digit'; j += 1
      else if name == 'q':                                                     // §3.4, §3.6
        if j < len(src) and src[j] != '[': j += 1                              // \q0[ID][title]: any one char
        if src[j] == '[':
          b = parseBracket(src, j)
          if b.unterminated:         args = b.args; j = b.end; form = 'bracket'; unterminated = true
          else if src[b.end] == '[': a1 = parseString(src, j); a2 = parseString(src, a1.end)   // legacy
                                     args = [a1[0], a2[0]]; j = a2.end; form = 'bracket2'
          else if b.args.length >= 2: args = b.args; j = b.end; form = 'bracket'
          // one argument: too few; j stays at '[', which is text (a later \q '[' inside a
          // quote-free too-few bracket is too few without the rescan, §3.4)
      else if name == 'p' and src[j] == '[': up to the first ']' (or the end), no quotes or escapes
      else if pol is a bracket policy and j < len(src) and src[j] == '[':
        {args, end} = (ONE_STRING has name ? parseString : parseBracket)(src, j); j = end; form = 'bracket'
      if args == null and j < len(src) and STEP_BACK has name: i += 1; continue   // §3.3: the name is text
      flush()
      out.push({t:'tag', name, args, form, raw: src.slice(i, j), pos: i})       // + unterminated: true
      if name == '_?' or name == '_!': raw = name
      i = j; continue
    if c == '%' and src[i+1] == '*':   // the other %-variables were expanded before the script got here (§3.5)
      flush(); out.push({t:'env', name: '*', raw: '%*', pos: i}); i += 2; continue
    addText(c, i); i += 1
  flush()
  return out
```

The player splits `text` tokens into **code points** when it displays them: `for (const ch of s)`. A surrogate pair is one character. Each code point gets the per-character wait (§6.1).

### 3.9 Tokenizer edge cases (test vectors)

| Input | Tokens |
|---|---|
| `\s10` | `s[1]`, text `0` |
| `\w10` | `w[1]`, text `0` (50 ms, then the character 0) [UKADOC-SS \w] |
| `\w[1000]` | `w` bracket `["1000"]` → wait 1000 ms [disasm]; `\w[1,000]` → `["1000"]`; `\w[ 1]x` → `w`, text `[ 1]x` (§3.4) |
| `\_b["menu\choice5.png",inline]` | `_b ["menu\choice5.png","inline"]` |
| `\_b[card\field.png,23,12]` | `_b ["card\field.png","23","12"]` (no `\f` tag) |
| `\![raise,OnTest,"100,2"]` | `! ["raise","OnTest","100,2"]` |
| `\![call,ghost,"the ""MobileMaster"""]` | `! ["call","ghost","the \"MobileMaster\""]` |
| `\![raise,OnX,a"b,c]d"e]` | `! ["raise","OnX","ab,c]de"]` (a quote anywhere, §3.4) [disasm] |
| `\![raise,OnX,a\,b]`, `\![raise,OnX,"a\]b"]` | `"a,b"`; `"a\]b"` (inside quotes a backslash is data) [disasm] |
| `\n[half,x]`, `\s[0,wait]`, `\j[a\,b]` | one string each: `"half,x"`, `"0,wait"`, `"a\,b"` [disasm] |
| `\p["1]"]` | `p ['"1']`, text `"]` (the first `]`) [disasm] |
| `\q[A,B][C]`, `\q[abc]x` | legacy `q ["A,B","C"]`; `q` with no args, text `[abc]x` [disasm] |
| `\q[a\]b,id]` | `q ["a]b","id"]` |
| `\8\n` | `8` (no args, no-op), `n` |
| `\sx`, `\&x`, `\_ux`, `\__wx`; `\px` | text `sx`, `&x`, `_ux`, `__wx` (only the backslash is gone); `p` with no args, text `x`; at the very end `\s` is `s` with no args (§3.3) [disasm] |
| `\k[1]`, `\わ`, `\_h`, `\__z[1]`, `\URL[a]` | text `k[1]`, `わ`, `\_h`; `__z` swallowed (an `unknown` token), text `[1]`; `U`, text `RL[a]` (§3.2) [disasm] |
| `\w_5`, `\w_[100]` | `w ["5"]` digit, `w ["100"]` (§3.3) [disasm] |
| `\e` in the middle | tokenize everything anyway. The player stops at `\e`. |
| `\__q` without an open range | `__q` with null args. The player ignores it (220 cases in the corpus). |
| `\n[half]x` | `n ["half"]`, text `x` |
| `\e[`, `\0[1]` | NONE policy: the `[` and following characters are text |
| `\![` unterminated | `!` with the rest of the script as arguments and `unterminated: true`; the player runs neither it nor anything after it (SSP's "Unclosed '['") [disasm]. `\![raise,OnX,"abc]` at the very end is closed (`"abc]"`) |
| `100%` / `%ms` / `%*x` | text `100%` / text `%ms` (expanded before, §3.5) / env `*`, text `x` |
| `abc\` at the end | text `abc\` |

---

## 4. Execution model

### 4.1 Runtime objects

```ts
interface GhostRuntime {
  scopes: Map<number, Scope>;           // created lazily; 0 and 1 always exist
  run: ScriptRun | null;                // the script being played (or finished-but-balloon-open)
  timers: Map<string, Timer>;           // the four timer tags, keyed by event name in any case (§6.6)
  ghostLife: { stayOnTop, zorderGroups, stickyGroups, otherGhostTalk, otherSurfaceChange,
               passive, induction, online, /* ... */ };
}
interface Scope {
  id: number;
  surface: number | string;             // -1 = hidden
  window: { x, y, alignment, scaling: [sx, sy], alpha, fixedPos? };   // ghost lifetime
  balloon: { kindId: number; visible: boolean;
             content: Element[];        // glyphs, inline/absolute images, choice/anchor ranges, line records
             cursor: {x, y}; lineTop: number; lineHeight: number;
             font: FontState; noWrap: boolean; align: 'left' | 'center' | 'right'; };
}
interface ScriptRun {
  src: string; tokens: Token[]; ip: number;            // instruction pointer (token index)
  scope: number;                                       // current scope
  quick: boolean; sync: number[] | null; timeCritical: boolean;
  noChoiceTimeout: boolean; choiceTimeoutMs?: number; balloonTimeoutMs?: number;
  charWait?: { mul?: number, ms?: number };            // \![set,balloonwait]
  serikoTalk: boolean; repaintLock: 'off' | 'auto' | 'manual'; balloonRepaintLock: 'off' | 'auto' | 'manual';
  autoscroll: boolean; userBreakDisabled: boolean;
  openChoice: ChoiceRange | null; openAnchor: AnchorRange | null;
  t0: number;                                          // reference time for \__w
  hasChoices: boolean; hasAnchors: boolean;
  state: 'running' | 'clickwait' | 'blocked' | 'finished' | 'aborted';
  pendingDressup: DressupChange[];
}
```

### 4.2 Lifetimes

UKADOC's general rule: a tag's effect lasts until the end of its script (`\e`) and is gone when the next script runs. Exceptions are listed per tag [UKADOC-SS, section "さくらスクリプトの寿命"].

| Lifetime | Items |
|---|---|
| **Script**: reset when the next script starts. The values stay in force after `\e` until then, so timeouts set inside a script govern its lingering balloon. | current scope (starts at 0); `\f` attributes and choice-cursor styles; `\_q`/quicksection; `\_s`; `\t`; `\*`; `\![set,choicetimeout]`; `\![set,balloontimeout]`; `\![set,balloonwait]` (UKADOC: back to 100 % after the script); `\![set,serikotalk]` (back to true); `\![lock,repaint]` and `\![lock,balloonrepaint]` (released automatically at the end unless `,manual`); `\_n`; `\__v`. [INFERRED: `\b` balloon kind, `\![set,autoscroll]`, `\![enter,nouserbreakmode]`] `\![set,choicetimeout]` and `\![set,balloontimeout]` are not reset by a script whose first two characters are `\C`: it keeps the last script's [disasm PlayScriptInternal 0x63c883, DecodeProcReal 0x628f3b] (EV §3.4). |
| **Ghost**: until the ghost closes. Persist these across page loads (§7). | `\![set,alignmenttodesktop]`, `\![set,scaling]`, `\![set,alpha]`, `\![set,zorder]`, `\![set,sticky-window]`, `\![set,position]`, `\![set,balloonalign]`, `\v` / `\![set,windowstate,stayontop]`, `\![set,otherghosttalk]`, `\![set,othersurfacechange]`, `\![enter,onlinemode\|passivemode\|inductionmode\|selectmode\|collisionmode]`, `\![set,balloonmarker]`, `\![set,balloonnum]`, timers (repeating ones until cancelled, one-shot ones until they fire). [INFERRED: `\![set,balloonoffset]`] |
| **Until the next `\s` on that scope** | `\![anim,pause,…]`, `\![anim,offset,…]` |
| **Beyond the session** (SSP keeps these; so does Sumika) | dress-up state (`\![bind]`), character and balloon positions the user dragged |

### 4.3 Starting, ending, aborting, breaking

**Start(script, origin)**:

1. If a run exists that is not `finished`, **abort** it. Cancel the old run's post-script timers (balloon and choice timeout).
2. Tokenize.
3. If the first token is `\C` **and** at least one balloon of this ghost is still visible:
   * keep all balloons visible, with their content, cursors and balloon kinds;
   * skip the `\C` token.

   Otherwise, for every scope: clear the balloon content, hide the balloon, reset the balloon kind to 0 [INFERRED], put the cursor at the origin, and reset the font to the balloon defaults.

   UKADOC contradicts itself about the scope after `\C`. The description says it returns to `\0`; the example says the previous scope carries over. Sumika uses **scope 0** (the description). **UNVERIFIED.**
4. Reset the script-lifetime state (§4.2) and set `t0 = now`.
5. Surfaces are **not** touched. Every script sets its own surfaces; Satori prefixes `\1\s[10]\0\s[0]`.
6. Set `state = running`. Status `talking` is on (§6.3).

**End** (`\e` executes, or the last token is consumed):

* set `state = finished`;
* fire the queued `OnDressupChanged`/`OnNotifyDressupInfo` events (§5.2);
* release the automatic repaint locks and flush any deferred paint;
* arm the post-script timers (§6.4).

The balloons **stay open**.

**Abort** (a new script replaces this one, a choice is clicked, or `\-` runs):

* stop at once and cancel the pending waits;
* release the repaint locks;
* send no SHIORI event for being replaced.

Abort does not hide balloons by itself. The next Start does that, unless its script begins with `\C`.

**Break** is the user's script break: by default a left double-click on a balloon (`Balloon.LeftDoubleClick.Method` [SSP-BIN], "script break" in [SSPHELP-TALK]). It is ignored when `userBreakDisabled` or passive mode is set. It does:

* abort;
* hide all balloons;
* send GET `OnBalloonBreak` with R0 = the script, R1 = the scope of the clicked balloon, R2 = the source position of the current token [UKADOC-EV];
* play a non-empty response.

A break also ends `\t`, since UKADOC says the time-critical section lasts until a script break or `\e`.

### 4.4 When a balloon becomes visible (P0)

A scope's balloon becomes visible when the current script writes its first **content element** to it. Content elements are:

* a text character other than U+0020, U+3000 or TAB (SUMMARY C14: spaces do not count);
* an inline image;
* an absolute `\_b` image;
* a choice or anchor;
* the `\![*]` marker;
* a character from `\_u`, `\_m` or `\&`.

These are **not** content: blank characters, `\n`, `\_l`, `\c`, `\f`, `\b[n]`, `\s`, waits. Blank characters still move the pen. Writing blanks into a balloon that is already open (a `\C` append) keeps it open.

Why spaces do not count (SUMMARY C14): Tsubasa's one-touch panel toggles write only `\_l[0,0] ` (one space) to scope 0, and if any character opened the balloon, each would pop up an empty balloon for 15 s. BA §3.11 has the full rule.

Evidence: Tsubasa's OnBoot writes `\n` to scope 99 (the invisible menu-icon character) and to scope 1 (empty `kero.name`). SSP does not show empty balloons for them. [INFERRED from CORPUS; medium confidence]

`\b[-1]` hides the scope's balloon immediately. The next content element written to that scope shows it again with its previous kind [INFERRED from CORPUS `…\_w[5000]\b[-1]\_w[15000]\n\c\_w[318]\s[31]...Um...`, request `お泊り早朝起動婚約済`].

During `\_q` or a repaint lock, "visible" takes effect at the next paint (§6.1).

---

## 5. Tag reference

"Current scope" means `run.scope`. Each row gives the syntax, the arguments and defaults, the behaviour, the events raised, the priority and the sources.

### 5.1 Scope

| Tag | Behaviour | P |
|---|---|---|
| `\0`, `\h` | scope = 0 | P0 |
| `\1`, `\u` | scope = 1 | P0 |
| `\pN` (one digit), `\p[N]` | Scope = N, 0 ≤ N < 10000 [disasm]. Tsubasa uses up to 101. `\p[0]` = `\0` and `\p[1]` = `\1`; `\p[]` = scope 0 [disasm]. The bracket ends at its first `]` (§3.4). The first reference creates the scope's character window, hidden until a surface is set. The initial surface is `char{N}.seriko.defaultsurface` from the shell descript, else none [UKADOC-SS; INFERRED for lazy creation]. A non-numeric N (blanks included) is ignored. | P0 |

* Scope tags inside a `\_s` sync section are ignored. **UNVERIFIED.**
* The balloon of a scope ≥ 2 uses the `p` balloon images and falls back to the `s` images (see the balloon spec).

### 5.2 Surface and shell

| Tag | Arguments and behaviour | Events | P |
|---|---|---|---|
| `\sN`, `\s[ID]` | Sets the surface of the current scope. ID is an integer, or an alias or name from `surfaces.txt`. `\s[a,b,…]` is one string: each part is tried as an alias, else the whole string's leading number (`\s[0,wait]` = 0, `\s[20,200]` = 20) [disasm GetSurfaceIndexChar, §3.4]. `\s[-1]` **hides the character image only**: the balloon still works and stays anchored where the character was. Tsubasa narrates over a hidden character: `\0\t\*\c\s[-1]...You ring the doorbell`. For an unknown ID, keep the current surface and log it. **UNVERIFIED** | Then NOTIFY `OnSurfaceChange` (R0 = surface of scope 0, R1 = surface of scope 1, R2 = `scope,id,w,h`) [UKADOC-EV] | P0 |
| `\iN`, `\i[ID]`, `\i[ID,wait]` | Starts animation ID (or `animation*.name`) on the current surface. `wait` blocks until it ends. | — | P1 |
| `\__w[animation,ID]` | Blocks until animation ID ends; no-op if it is not playing | — | P1 |
| `\![anim,clear\|stop\|pause\|resume,ID]`, `\![anim,offset,ID,x,y]`, `\![anim,add,…]` | Animation control (shell spec). pause and offset last until the next `\s`. | — | P1/P2 |
| `\![bind,cat,part,v]` | Dress-up on the current scope. `v`: `1` = on, `0` = off, empty or omitted = toggle. An empty `part` applies to the whole category (`bind,足,,0`). The state persists. | When the script **ends**: one `OnDressupChanged` per change (R0 scope, R1 part, R2 1/0, R3 category, R4 `script`); the last is GET, the others NOTIFY. Then `OnNotifyDressupInfo`. Above 100 changes, skip `OnDressupChanged` [UKADOC-EV]. Whether an aborted script still fires them is **UNVERIFIED**; Sumika fires them. | P0 |
| `\![bind-noevent,…]` | Same as bind, with no events | — | P1 |
| `\![lock,repaint[,manual]]`, `\![unlock,repaint]` | Freezes shell repaints. Released at the end of the script unless `manual`. | — | P1 |
| `\![set,alignmenttodesktop,D]`, legacy spelling `alignmentondesktop` | D ∈ `top bottom left right free default`. Ghost lifetime. `free` allows any position; `bottom` snaps the window to the bottom of the viewport. | — | **P0** (`free`, 443 uses) |
| `\![set,scaling,S]`, `\![set,scaling,SX,SY[,ms\|--time=ms][,--wait]]` | Percent of the user scale. A negative value flips that axis (`-100,100` = mirror). Ghost lifetime. `--wait` blocks. | — | P0 (mirror) |
| `\![set,alpha,N[,--time=ms][,--wait]]` | 0–100 (above 100 is clamped; negative = repaint only). Ghost lifetime. | — | P1 |
| `\![effect,…]`, `\![effect2,…]`, `\![filter,…]`, `\![filter]` | Plugin effects | — | P2 no-op |
| `\4`, `\5` | `\4` moves away from the other character; `\5` moves next to it (touching; no move when they already touch). Then the script continues. **Implemented** as an instant, blocking `\![move]` sideways; the distance and "the other character" are [guess]es: UI §3.8. | — | P2 |
| `\![move,…]` | §5.2.1. **Blocks** until it arrives. | — | **P0** (legacy form, 433 uses) |
| `\![moveasync,…]`, `\![moveasync,cancel]` | Same, but does not block; `cancel` stops a running move | — | P1 |
| `\![set,position,x,y,scope]`, `\![reset,position]` | Pins a window (no dragging) | — | P2 |
| `\![set,zorder,…]`, `\![reset,zorder]` | Stacking groups. IDs: `N`, or `sN`/`surfaceN`, `bN`/`balloonN`. The first listed is in front. | — | P2 |
| `\![set,sticky-window,…]`, `\![reset,sticky-window]` | Windows that move together | — | P2 |
| `\![execute,resetwindowpos]` | Moves every window back to its default position | — | P2 |

#### 5.2.1 `\![move]` arguments (P0)

* **New form**: `--X= --Y= --time= --base= --base-offset= --move-offset= --option=ignore-sticky-window`, in any order, keys case-insensitive [UKADOC-SS].
* **Legacy positional form**: `X, Y, time, base, baseOffset, moveOffset`.
  * X, Y: a number (negative allowed) or `fix`. Empty, missing or non-numeric means `fix`, which keeps that axis. The corpus has X = `豆撒き4`, which therefore means `fix`.
  * time: ms. Empty or 0 means instant. Easing is linear. **UNVERIFIED**
  * base:
    * `screen` (default): the browser **viewport**, Sumika's "desktop";
    * `primaryscreen` and `global`: the same as `screen`;
    * an integer: that scope's window rect;
    * `me`: the moving window;
    * `ghostname/ID`: another ghost (P2).
  * Offsets have the form `X.Y`, with X ∈ `left right center base` and Y ∈ `top bottom center base`. Default `left.top`. Each half is parsed on its own. A missing or invalid half falls back to `left` / `top`: the corpus has `ritht.top` and plain `left`. `base` = the surface's `point.basepos` (shell spec).
* Target: put the moving window's moveOffset point at `anchor(base, baseOffset) + (X, Y)`. Windows in the same sticky group move by the same delta unless `ignore-sticky-window` is given.

### 5.3 Balloon and text

| Tag | Arguments and behaviour | P |
|---|---|---|
| `\bN`, `\b[ID]`, `\b[ID,--fallback=ID2,…]` | Balloon kind for the current scope. Image index = `2*floor(ID/2) + side`, where side is 0 or 1 for the left- or right-facing variant [NINIX `set_balloon`; UKADOC: "odd IDs are reserved for the right-facing variant"]. So `\b[1]`, used 51 times by Tsubasa, maps to the pair of `\b[0]`. **UNVERIFIED.** A missing kind falls back through the `--fallback` list, then to 0. Changing the kind keeps the content. **UNVERIFIED.** `\b[-1]` hides the balloon (§4.4). | P0 |
| `\n` | New line: x = origin, y += current line height (§5.3.3). Ends the `\f[align]` region. | P0 |
| `\n[half]` | The same with 50 % of the line height | P0 |
| `\n[P]` | P % of the line height (negative allowed; `150` = 1.5 lines) | P1 |
| `\_n` | Toggles no-auto-wrap. Text past the wrap point is clipped instead of wrapped. | P0 |
| `\c` | Clears the current scope's balloon (all content, absolute `\_b` images too) and puts the cursor at the origin. The balloon stays visible. Its choices are removed. The font is kept. **UNVERIFIED** | P0 |
| `\c[char,N]` | Removes the last N "characters" before the cursor, in script order. A glyph and an inline image each count as 1. | P0 |
| `\c[char,N,S]` | Removes N characters from the 0-based character index S | P1 |
| `\c[line,N]`, `\c[line,N,S]` | The same in lines. Lines are split by `\n`, `\n[…]` and `\_l`; empty lines between consecutive `\n` do not count. | P1 |
| `\_l[x,y]` | Moves the cursor (§5.3.4). Resets `\f[align]` to left. | P0 |
| `\C` | Append mode. Meaningful only as the first token (§4.3). | P0 |
| `\_b[…]` | Balloon image (§5.3.2) | P0 |
| `\![*]`, `%*` | Draws the balloon marker image inline at the cursor, like an inline image. The file is `marker.filename` (default `marker`; per kind `markers`/`markerk`/`markerp*`) [UKADOC-BAL]. LightBlue has **no** marker image. The fallback is **UNVERIFIED**: use `sstp.png` if it exists, else draw nothing. | P0 |
| `\![set,autoscroll,disable\|enable]` | When disabled, the balloon no longer follows new lines; manual scrolling still works | P1 |
| `\![set,balloonoffset,x,y]` | Balloon offset; `@` = relative to the descript value | P1 |
| `\![set,balloonalign,D]` | D ∈ `left center top right bottom none` | P1 |
| `\![set,balloontimeout,ms]` | Script lifetime. Empty = default; `0`/`-1` = never. | P1 |
| `\![set,balloonwait,V]` | Multiplier of the per-character wait. `V` = 0–100 (1 = normal, decimals allowed), `N%` (100 = normal), or `Nms` (absolute ms per character). Empty or 1 = default; 0 = instant. Reset at the end of the script. | P1 |
| `\![set,serikotalk,true\|false]` | Turns the mouth animation off or on | P2 |
| `\![set,balloonmarker,…]`, `\![set,balloonnum,…]` | SSTP and download indicators | P2 |
| `\![enter\|leave,onlinemode]` | Online marker | P2 |
| `\![enter\|leave,nouserbreakmode]` | Disables the user break. Status `nouserbreak` until the leave or the next script, kept after `\e` [disasm 0x62f44e, 0x630527, Loop 0x63b540] (EV §1.6) | P1 |
| `\![lock\|unlock,balloonrepaint[,manual]]` | Freezes balloon painting; everything appears at the unlock or at the end of the script | P1 |
| `\![lock\|unlock,balloonmove]` | Prevents the user from dragging the balloon | P2 |
| `\_?…\_?` | Literal text, tags included | P1 |
| `\_!…\_!` | Legacy form of `\_?` | P2 |
| `\__v[disable]…\__v`, `\__v[alternate,str]…\__v` | Speech synthesis hints; the text is still drawn | P2 |
| `\_u[0xHHHH]`, `\_u[DDDD]` | One character by its code point (hex with `0x`, else decimal) | P1 |
| `\_m[0xHH]` | One ASCII character | P2 |
| `\&[name]` | One character by its HTML 4 name, as ssp.exe 2.9.10 does it [disasm `SPGhost::DecodeProcReal`, `&` branch 0x629294–0x629366]: `SPGhost::ParseBracket` 0x6263d0 reads the bracket as one string (§3.4: quotes dropped, `\]` → `]`, commas and spaces kept, nothing trimmed), and that string goes straight to `SPGetCharcodeReference` 0x5e8dd0 (the call at 0x6292c5; nothing in between looks at `#`), the lookup resource values use (`shiori-events.md` §5.5): HTML 4's 252 names, case-sensitive `wcscmp`, no numeric form, no `apos`. Any other name, an empty one or one of any length (the player has no 1–19 rule) gives **a space**, U+0020: `\&[AMP]`, `\&[#38]`, `\&[#x26]`, `\&[ amp]`, `\&[star]` are each a space; `\&["lt"]` is `<`. The character joins the text like a written one (the buffer `\\` and `\%` write to). A 0 from the lookup would add the strict-script error "unknown character reference" (0x62934b); it never returns 0. Sumika: `charcodeReference` (`src/sakura/entity.js`) in the player. Corpus (333 archives and site ghosts): 25 `\&[` in 5 ghosts: kayuko3, naru_m015a and toxic060816 write German letters (`uuml`, `Uuml`, `Auml`, `ouml`, `Ouml`, `szlig`), all HTML 4 names; honue090104's `\&[ID]` is in a comment. Without a `[`, `\&x` shows `&x` (§3.3) | P1 |
| `\![execute,resetballoonpos]` | Resets the balloon positions | P2 |

#### 5.3.1 Scroll and overflow

When content goes below the visible text area and autoscroll is on, scroll so that the cursor line stays visible. Show the arrows (balloon spec). `\_n` clips horizontally.

#### 5.3.2 `\_b` balloon images (P0)

Forms:

* `\_b[file,x,y]`, `\_b[file,x,y,opaque]`, `\_b[file,x,y,opt,…]`: absolute placement;
* `\_b[file,inline]`, `\_b[file,inline,opaque]`, `\_b[file,inline,opt,…]`: inline placement.

The options are positional `opaque`, plus `--option=opaque|use_self_alpha|fixed|background|foreground`, `--clipping=l t r b`, `--scaling=…` (P2) and `--source=…` (P2).

* **Path.** Relative to `ghost/master/`. Replace `\` with `/` and resolve `..`. Look the file up in the ghost's file index **case-insensitively**: Windows paths are case-insensitive and the site's static server is not. Special forms:
  * `data:image/…;base64,…`: supported;
  * `http(s)://`: SSP-only, P2; needs CORS for colour keying;
  * absolute Windows paths and `exe,resid`: unsupported, log them.
* **Missing files are normal.** Draw nothing and raise no error. 194 074 of the 262 313 `\_b` uses point to files that do not exist. `unyu/unyu0.png` alone accounts for 185 923 of them: it is the "empty cell" of a game board, and `unyu0.png` was never shipped [CORPUS, `scratch/ss/missing.py`]. Check the index and **never fetch** a path that is not in it. A missing inline image takes zero width. **UNVERIFIED**
* **Default transparency** [UKADOC-SS \_b]: every pixel whose RGB equals the **top-left pixel's RGB** becomes transparent. This applies to RGBA PNGs too. Tsubasa's RGBA buttons are fully opaque with a (0,255,0) key, so this keying is P0.
  * `opaque` or `--option=opaque`: no keying.
  * `--option=use_self_alpha`: use the PNG alpha channel.

  Cache the processed bitmaps by `(resolvedPath, mode, clipping)`.
* **Absolute x,y** are pixels from the **balloon image's top-left corner**, not from the text origin. Evidence: `\b[2]…\_b["menu\icon\sky3.png",0,0]` lays a 340×384 skin exactly over the 340×384 `balloons2.png`, and `uback.png` (308×352) sits at (16,8) in the same balloon [CORPUS + image sizes; INFERRED].
  * Layer: below the text (`--option=background`, the default) or above it (`--option=foreground`).
  * The image scrolls with the text unless `--option=fixed` is given.
  * An absolute image does not move the cursor.
* **Inline** images are placed at the cursor; the cursor then moves right by the image width. The image counts as one character for `\c[char]` and for the per-character wait [INFERRED]. It raises the current line's height to at least its own height. It follows BA §3.5's **eager** rule, as in `src/balloon/layout.js`: a wrap already pending is applied first, then the image is placed at the cursor **without a fit check**, even when it runs past the line limit (BA corpus test D), and only what follows it goes to the next line. Superseded: "It wraps like a glyph when it does not fit", which implied a check before placing.
* `--clipping=l t r b` takes source pixels `[l,r) × [t,b)`.
* Performance: one game frame draws about 64 images, and one script holds 246 frames (`\c` + redraw + `\_w`). Use a canvas per balloon or pooled DOM nodes, and decode each file once.

#### 5.3.3 Line metrics (P0; exact pixels belong to the balloon spec)

* A line starts at a `\n`, a `\_l` or a wrap. Its height is the maximum of the default line height of the current font and the heights of the inline images on the line. The default line height is the font height plus a line gap; the gap is **UNVERIFIED**.
* `\n[...]` moves y down by that height × factor and x back to the origin.
* Tsubasa's menu idiom depends on this rule. In `\n\_l[@-2,@3]\__q[ID]\_b["menu\choice5.png",inline]\__q\_l[@0,@-16]　　　…Sure\n`, the image is 300×19 and fills the line. The label wraps and is then moved up 16 px, which puts it 3 px below the image top only if the wrap advanced by 19 px, the image height. With `choice3.png` (150 px) the menu uses `\_l[@-150,@3]` and needs no wrap. **Calibrate this in SSP** (§9).

#### 5.3.4 `\_l[x,y]` coordinates (P0)

Each of x and y is one of:

| Form | Meaning |
|---|---|
| empty | that axis is unchanged |
| `N` | pixels from the text origin (`origin.x/y` of the balloon) |
| `@N` | relative to the current position |
| `Nem` | N × the current font height |
| `Nlh` | N × the line height |
| `N%` | N/100 × the current font height |
| `centerx`, `centery` | the centre of the balloon **image**, not of the text area |

Units can be combined with `@` (for example `@-1650%`). Decimals are allowed. Full-width `＠` is not recognised (§3.7).

### 5.4 Font: `\f[…]`

Model: each scope's balloon has a `FontState` initialised from the balloon descript. `\f` changes the current scope's state and affects what is drawn afterwards [INFERRED: per-scope state]. The state is reset when a script starts and after a plain `\x`.

| Command | Values | P |
|---|---|---|
| `\f[default]` | Reset every attribute to the balloon default | P0 |
| `\f[color,C]` | Text colour | P0 |
| `\f[shadowcolor,C\|none]`, `\f[shadowstyle,offset\|outline\|default]` | Shadow | P0 (colour) |
| `\f[bold,B]`, `\f[italic,B]`, `\f[strike,B]`, `\f[underline,B]`, `\f[sub,B]`, `\f[sup,B]`, `\f[outline,B]` | B = `true`/`1`, `false`/`0`, `default`, `disable`, `toggle` (flips it: `SPBalloonWnd::ParseFontCommand` compares with "toggle" seven times, 0x5d4164–0x5d47ed [disasm]; that the seven are these keys is [infer]) | P0 (bold, strike) |
| `\B`, `\U` | `\f[bold,toggle]`, `\f[underline,toggle]` (DecodeProcReal 0x62ac6a [disasm], §3.2) | P2 |
| `\f[height,H]` | H = `N` px, `+N`/`-N` relative, `N%` of the default, `default` | P0 |
| `\f[name,F1,F2,…]` | Fonts in priority order; `default`; `disable`. A file name such as `x.ttf` means a font file in the ghost or balloon folder (load it with FontFace). | P1 |
| `\f[align,left\|center\|right]` | Lasts until the next `\n` or `\_l`; re-aligns the current line | P1 |
| `\f[valign,top\|center\|bottom]` | Not reset by `\n` | P2 |
| `\f[anchor.font.color,C]` | Anchor text colour | P1 |
| `\f[cursorstyle\|cursorcolor\|cursorbrushcolor\|cursorpencolor\|cursorfontcolor\|cursormethod,…]` and the `cursornotselect…`, `anchor…`, `anchornotselect…`, `anchorvisited…` families | Choice and anchor marker styles. Styles: `square`, `underline`, `square+underline`, `none`, `default`. Methods are Win32 ROP2 names: approximate `copypen` as normal paint and the rest as plain fills. Applies to choices drawn after the tag. **UNVERIFIED** | P0 (`cursorpencolor`), P1 others |
| `\f[disable]` | Disabled style | P2 |

**Colour grammar.** The bracket parser splits on commas, so join `args[1..]` with `,` before parsing. Accepted forms:

* `R,G,B` (0–255);
* `R%,G%,B%`;
* `#rgb` or `#rrggbb` (either case);
* a lower-case CSS colour keyword (W3C meanings);
* `default`, `disable`;
* `default.anchor`, `default.anchornotselect`, `default.anchorvisited`;
* `default.cursor`, `default.cursornotselect`, `default.plain` (choice and anchor colours only).

An unparseable value makes the tag **ignored**, as in SSP 2.8.93; older versions sometimes fell back to black [UKADOC-SS 文字色指定の方法].

### 5.5 Waits and sections

| Tag | Behaviour | P |
|---|---|---|
| `\wN` | Wait N × 50 ms; N is one digit, `\w0` = no wait [UKADOC-SS] | P0 |
| `\w[N]` | Not documented. Tsubasa uses `\w[1000]` (64 uses), `[1500]` and `[2000]` to pause between game turns: N ms, digits only, commas skipped; anything else leaves the `[` as text and waits 0 [disasm DecodeProcReal 0x628457, §3.4]. | P0 |
| `\_w[ms]` | Wait ms milliseconds; non-numeric = 0 | P0 |
| `\__w[ms]` | Wait until `now − t0 ≥ ms`. t0 is the script start, the last `\x` resume or the last `\__w[clear]`. Typing time counts. | P1 |
| `\__w[clear]` | `t0 = now` | P1 |
| `\x` | Click wait (§6.2). After the click: clear the text of all of this ghost's balloons (they stay visible), set scope = 0, reset the font, set `t0 = now`. Other script-lifetime state carries on [UKADOC-SS]. Which balloons get cleared is **UNVERIFIED**; Sumika clears all scopes, as [NINIX] does. | P0 |
| `\x[noclear]` | Click wait that keeps content, scope and font | P1 |
| `\t` | Time-critical section until the end of the script or a break. While active, no mouse-type events are sent to SHIORI (§6.5). A second `\t` does **not** switch it off. Adds `timecritical` to `Status`. | P0 |
| `\_q` | Toggles the quick section: characters appear without the per-character wait. **Wait tags still wait inside `\_q`** [UKADOC-SS]. Tsubasa animates her games with `\_q…\c…\_w[n]` frames. (ninix skips waits in quick mode; that is wrong for SSP.) | P0 |
| `\![quicksection,true\|1\|false\|0]` | Sets the quick state explicitly; can be mixed with `\_q` | P1 |
| `\_s`, `\_s[ID,ID,…]` | Toggles the synchronized section: text goes to all listed balloons at once (default: scopes 0 and 1); each character waits once | P1 |
| `\![wait,syncobject,…]`, `\![set\|reset,syncobject,…]` | Windows sync objects: no-op, never block | P2 |
| `\_V`, `\![sound,wait]` | Wait until the sound ends (§5.8) | P1 |

### 5.6 Choices and anchors

#### 5.6.1 Syntax

| Tag | Meaning | P |
|---|---|---|
| `\q[title,ID]` | A choice. The title is drawn as one unit at the cursor and does not wrap inside [UKADOC-SS: use `\__q` if wrapping is needed]. | P0 |
| `\q[title,OnEvent,r0,r1,…]` | An ID starting with `On`: selecting raises `OnEvent` with R0..Rn = r0..rn | P0 |
| `\q[title,ID,r2,r3,…]` | The extra arguments go to `OnChoiceSelectEx` (R2…) | P1 |
| `\q[title,script:S]` | Selecting plays S as a new script. Unquoted commas split S, but SSP runs the ID re-joined with every non-empty reference (GetJumpString), so S comes back whole; a `]` in S needs `\]` or quotes (§5.6.2) | P1 |
| `\q[title,http(s)://…]` | Selecting opens the URL [SATORI-DOC 09-choices] | P1 |
| `\q[ID][title]`, `\qN[ID][title]` | Legacy form, followed by a newline (§3.6) | P2 |
| `\q[title]` | Too few arguments: SSP shows `[title]` as text (§3.6) [disasm] | P2 |
| `\__q[ID,r…]` … `\__q` | A choice range. Everything between (text, `\n`, `\_l`, inline images) is clickable and wraps normally. ID rules as for `\q`. A `\__q` with no open range is a **no-op** (220 in the corpus). A new `\__q[…]` while one is open closes the open one first. **UNVERIFIED** | P0 |
| `\_a[ID,r…]` … `\_a` | An anchor range (clickable text). Same ID rules. A stray close is a no-op. | P1 |
| `\*` | No choice timeout for this script; also valid when it comes after the choices | P0 |
| `\![set,choicetimeout,ms]` | Choice timeout for this script. Empty = default; `0`/`-1` = none. | P1 |
| `\z` | Legacy `\e` for scripts with choices; treat it like `\e` | P2 |

IDs are opaque strings and may contain U+0001 (Satori uses it). Keep them byte-exact.

#### 5.6.2 Selection algorithm (P0)

Choices are clickable as soon as they are drawn, even while the script is still typing [INFERRED].

```text
onChoiceClick(choice):
  title = (choice.kind == 'q') ? choice.title : choice.textContent      // images contribute nothing
  abort(run); hideAllBalloons()
  id = choice.id; extra = choice.args                                     // arguments after the ID
  if id starts with script: (any case): start((id + ',' + nonEmpty(extra)).slice(7), 'choice'); return   // GetJumpString
  if /^https?:\/\//.test(id):         openUrl(id); return
  if id.startsWith('On'):             r = shioriGet(id, extra)            // R0.. = extra
  else:
     r = shioriGet('OnChoiceSelectEx', [title, id, ...extra])
     if isEmpty(r): r = shioriGet('OnChoiceSelect', [id])
  if !isEmpty(r): start(r, 'choice')
```

* A jump ID (SPGhost::IsExecuteJumpString 0x639bb0: `http://`, `https://`, `ftp://`, `mailto:`, `file:///`,
  `script:`, any case) is run re-joined with every non-empty reference (SPBalloonString::GetJumpString 0x5d52f0)
  [disasm]: sancyome's `\q[…,script:\![execute,…,--param=message_body="…",--async=communicate\]]` runs the whole
  `\![execute,…]`. Sumika re-joins `script:` IDs (`jumpString`, the player's `_linkInfo`); a URL ID with references
  (no corpus ghost has one) still opens the ID alone.
* References reach the events as SSP's ParametersToArray gives them: an empty last argument ends them, a one-space
  argument is empty (§3.4, `refList`).
* Every `shioriGet` that is triggered by the script or the user carries `SecurityLevel: local`.
* An `On…` ID sends no `OnChoiceSelectEx` [UKADOC-SS \q OnID].
* `OnChoiceSelect` is sent only when `OnChoiceSelectEx` returned nothing [UKADOC-SS \* example; UKADOC-EV OnAnchorSelectEx].

Anchors: `OnAnchorSelectEx(R0 = text, R1 = ID, R2… = args)`, then `OnAnchorSelect(R0 = ID)`. Unlike a choice, an anchor click does **not** abort the script or hide the balloons unless a non-empty script comes back. **UNVERIFIED.** Mark the anchor as visited.

Hover: draw the cursor style (`\f[cursor…]` or the balloon descript `cursor.*`). Implemented as ssp.exe 2.9.08f sends
them (EV §4.7, UI §4.8) [disasm]: GET `OnChoiceEnter`/`OnAnchorEnter` with References on enter; `OnChoiceEnter`
without References on leave (NOTIFY to another item, GET to empty space, nothing out of the window); NOTIFY
`OnChoiceEnter` before every selection event; `OnChoiceHover`/`OnAnchorHover` then the `balloon_tooltip` resource once
per item entry when the pointer rests; a tooltip box shows the reply.

### 5.7 Events and control

| Tag | Behaviour | P |
|---|---|---|
| `\e` | End of script (§4.3). Everything after it is ignored. `\y` and `\z` are the same tag in ssp.exe (0x62bea9) [disasm]. | P0 |
| `\_e` | Hides the current scope's balloon (`SPBalloonWnd::Hide`), each `\_s` scope's while `\_s` is on (0x62aef3) [disasm]; the ghosts use it before `\e` (`\x\_e\e`) | P2 |
| `\l`, `\_i` | Do nothing (0x62be92, 0x62aeed) [disasm] | P2 |
| `\_c[X]` | Plays what `SPShiori::GetSentence(X)` answers (0x62ade9) [disasm]. Sumika reports it and does nothing (3 uses in the corpus) | P2 |
| `\-` | Quit the ghost: abort, then run the exit sequence. Do **not** send `OnClose` [INFERRED]: `\-` is normally the answer to OnClose or to a "go home" menu item (`メインメニュー終了` ends with `\1\-\e`). Hide all windows, unload SHIORI (Satori saves its data at unload; persist it), and store `ghostClosed = true` so later pages do not resume her. Show a small "call ghost" button. With other ghosts on screen only this one goes; they get OnOtherGhostClosed (EV §2.7.3) [infer], and the button shows once the last one has gone. On Quit and the last Close a ghost also goes at its close script's end without `\-` (EV §2.3) [disasm]. | P0 |
| `\![raise,Ev,r0,…]` | **Synchronous**: when the tag is reached, send GET `Ev` (R0… = args, `SecurityLevel: local`) and pause playback until the reply arrives. If the Value is non-empty, the current script **ends here** and the Value is started as a new script (§4.3: balloons are cleared unless it begins with `\C`). If it is empty or 204, continue with the next token. Evidence: Satori's `sync` function emits `\![raise,OnDirectSaoriCall,…]` mid-script, always answers 204, and drops the call unless `SecurityLevel` is local [SATORI-SRC satori_builtin.cpp `func_sync`, satori_CreateResponce.cpp]. 692 such raises are followed by more text [CORPUS]. UKADOC presents raise as the way to end a `\t` script and start another. | P0 |
| `\![embed,Ev,r…]` | The same request, but the Value replaces the tag: tokenize it and insert the tokens at `ip`. Script state carries on. The host expands the Value's %-variables and sends it through OnTranslate first (§3.5, EV §4.10) [disasm 0x633349, 0x633389]. | P1 |
| `\![notify,Ev,r…]` | NOTIFY `Ev`; the result is ignored | P1 |
| `\![timerraise,ms,R,Ev,r…]` | Timer (§6.6). `ms = 0` cancels the timer named Ev; 1–49 ms become 50. `R` is read with SSP's ParseBool: `1` (`2`, `true`, `on` …) fires once, anything else (`0`, `false`, empty, garbage) repeats every ms (SUMMARY C3 as amended) [disasm 0x632E80, 0x789660]. The same Ev, in any case, replaces an existing timer of any of the four timer tags. Counting starts when the tag executes. | P0 |
| `\![timernotify,…]` | The same, sent as NOTIFY | P1 |
| `\![raiseother\|notifyother,ghost,Ev,r…]` | Implemented (EV §2.7.9): raises Ev (GET) or notifies it (NOTIFY) in other ghosts on the page, with `Sender: <this ghost's sakura name>` and SenderType `internal`. `ghost` is `__SYSTEM_ALL_GHOST__` (whole, any case: every ghost, this one silently left out), `random`, or names separated by U+0001 (a descript name, else a sakura name; `lastinstall…` finds nothing in a browser [decision]). **The script never waits** [disasm 0x6333F5]: PlayerHost `raiseOther(ghost, Ev, refs, {notify})` returns nothing and the site delivers later, in tag order. A raised reply cuts what the target says. A target that is locked (`\t`, passive, induction, minimized), not found or answers nothing makes this ghost GET `OnRaiseOtherFailure` / `OnNotifyOtherFailure`. `\![raiseother]` alone passes no ghost (SSP's `invalid`); an empty Ev fails too. A replay never repeats it (side effect, §7). | P1 |
| `\![timerraiseother\|timernotifyother,ms,R,ghost,Ev,r…]` | Implemented: a timer of this ghost (§6.6), keyed by Ev like the others, that raises in `ghost` when it fires; the target is looked up at each fire [disasm 0x632E80]. Without Ev (fewer arguments, or an empty one) the tag is ignored [disasm 0x632EBC, 0x632F33; decision for the empty one]. Saved and re-armed across pages with its `ghost` (`to`). | P1 |
| `\![raiseplugin\|notifyplugin\|timerraiseplugin\|timernotifyplugin,…]` | Plugins: no-op, log | P2 |
| `\a` | Legacy: raises `OnAITalk` | P2 |
| `\+`, `\_+`, `\![change,ghost,name\|random\|sequential\|lastinstalled[,--option=raise-event]]` | Ghost change (implemented, EV §2.5): `\+` = `random`, `\_+` = `sequential` (next in the site's list, wrapping); a name matches descript `name`, then `sakura.name`, then the folder id; `lastinstalled` and unknown names are ignored. No OnGhostChanging unless `--option=raise-event` [UKADOC-SS]; the script plays to its end, then the ghost changes. Asked during a shell or balloon change (in OnBalloonChange's reply) it waits for that change, then runs (EV §2.6 "Changes in a row") [decision]. With other ghosts on screen only this ghost changes; `random` / `sequential` skip every ghost on screen and a named one is ignored (EV §2.7.2) [disasm]. | P1 |
| `\![call,ghost,name\|random\|sequential[,--option=raise-event]]` | Call another ghost to the page (implemented, EV §2.7.1) [UKADOC-SS; disasm `ExecuteChangeFromTag(…, isCall=1)`]: tokens starting with `--option=` (any case) are options (`raise-event` anywhere in one), **the first other token is the target** (unlike `\![change,shell]`); none: ignored. The target is matched like a change's (descript `name`, `sakura.name`, folder id; the corpus calls by sakura name, `\![call,ghost,なと]`); `random` / `sequential` pick among the site's ghosts not on screen; a ghost already on screen (this one too), an unknown name, `lastinstalled`, a ghost whose engine is missing or a full page (3 by default) are ignored [disasm; decision for the cap]. **The script never waits**: it keeps playing while the callee loads (no BreakScript, unlike a change [disasm]); PlayerHost `call(kind, args)` returns nothing. Without raise-event this ghost gets no event and OnGhostCalled's R1 is this script; with it, `OnGhostCalling` (R1 `automatic`), whose reply replaces this script. Two calls in one script come one after the other [guess]. A replay never repeats it (side effect, §7). Other kinds (`\![call,shell]` …) are ignored and logged. | P1 |
| `\![change,shell,name\|random\|sequential[,--option=raise-event]]` | Shell switch (implemented, EV §2.6). Tokens starting with `--option=` are options (`raise-event` anywhere in one), **the last other token is the target**; none: ignored [disasm]. The target is a shell's descript `name` (any case; folder ids never match), `random` (another shell; ignored unless at least two others exist [disasm]), `sequential` (next in menu order, wrapping [guess], with the same guard: a two-shell ghost such as Katari or roommate ignores it [disasm 0x627702]); `lastinstalled` and unknown names are ignored. **Without raise-event the switch happens at the tag**: the player waits there (blocked, like `\![raise]`) until the new shell is up, the rest of the script runs on it, and `OnShellChanged`'s reply plays when the script ends [disasm; guess for the reply]. Asked while another ghost, shell or balloon change is under way (in an OnShellChanged or OnBalloonChange reply, a boot script after Change ghost ▸) it waits for that change, then runs (EV §2.6 "Changes in a row") [decision]. With raise-event it goes like a Shell ▸ pick: `OnShellChanging` first (its reply replaces this script; a balloon break cancels), then the switch and `OnShellChanged`; the script is not held. A replay never repeats it (side effect, §7). | P1 |
| `\![change,balloon,name\|random\|sequential]` | Balloon switch (implemented, EV §2.6): the same argument rule (`--option=raise-event` is parsed and ignored [disasm]); a balloon's descript `name`, `random` (any other balloon), `sequential` (next in Balloon ▸ order [guess]). The player waits at the tag until the new skin is loaded, then continues with the new look: balloons on screen keep their text and scroll position (re-skinned in place). `OnNotifySelfInfo`, then `OnBalloonChange`, whose reply plays when the script ends [guess]. No `OnBalloonChanging`. Asked during another ghost, shell or balloon change it waits for that change, then runs (EV §2.6 "Changes in a row") [decision]. | P1 |
| `\v`, `\![set,windowstate,stayontop\|!stayontop]` | Top of the z-order (ghost lifetime) | P2 |
| `\![set,windowstate,minimize]` | Hide all windows and show a restore button; send `OnWindowStateMinimize`, and `OnWindowStateRestore` on restore | P1 |
| `\![set,otherghosttalk,true\|false\|before\|after]` | OnOtherGhostTalk about the other ghosts' scripts (implemented, EV §2.7.4) [UKADOC-SS; disasm]: `true` = `after` (and `1` [guess]); `before` and `after` add up, also within one argument (`"before,after"`); `false` (`0`) clears both; an unknown value changes nothing (logged). Kept until the ghost closes (`ghostLife.otherGhostTalk`, so a page change keeps it). The tag itself is a side effect a replay skips (§7). | P1 |
| `\![set,othersurfacechange,…]` | OnOtherSurfaceChange: not sent (0 corpus ghosts use it) | P2 |
| `\![updatebymyself…]`, `\![update,…]`, `\![updateother,…]` | Network update is disabled for this project: no-op, no events. **UNVERIFIED** whether a ghost needs a failure event. | P2 |
| `\6`, `\7`, `\![executesntp]` | Clock sync: no-op | P2 |
| `\![execute,headline,…]`, `\![execute,calendarplugin,…]`, `\![biff…]` | no-op | P2 |
| `\![vanishbymyself…]` | Uninstall: no-op and log | P2 |
| `\![save\|restore,wallpaper]`, `\![set,wallpaper,…]` | The OS wallpaper cannot be changed: no-op (optionally set the page backdrop) | P2 |
| `\![set,trayicon\|tasktrayicon,path,tooltip,--duration=,--runcount=]` | The minimized ghost's launcher image (implemented, `ssp-ui.md` §2.6) [disasm `SetTrayIconName` 0x61f160]: any `\![set]` name starting `trayi` or `tasktrayi` (the table's prefixes, any case); the file from the ghost root, then `ghost/master/`; a missing one changes nothing; no path resets to the descript's icon. The tooltip, `--duration` and `--runcount` are not used [decision]. A side effect a replay skips (§7). | P2 |
| `\![set,trayballoon,…]` | no-op | P2 |

### 5.8 Sound (P1)

| Tag | Behaviour |
|---|---|
| `\_v[file]`, `\![sound,play,file,opts…]` | Play `ghost/master/file` without waiting (HTMLAudioElement). Options: `--volume=0..100`, `--balance=-100..100`, `--rate=` (playbackRate = rate/100), `--seektime=`, `--window=`, `--sound-only=`. ssp.exe 2.9.10: flags 0, so `\_V` waits for it; its end sends OnSoundStop, a file that cannot load or start OnSoundError (EV §4.17) [disasm 0x62afdb, 0x62dea3] |
| `\8[file]` | Legacy; plays like `\_v`, but with flags 1: `\_V` does not wait for it; the same events [disasm 0x62a761–0x62aa71; an encrypted `.daw/.ddw/.dfw/.dgw` is decoded first, flags 5] |
| `\_V`, `\![sound,wait]` | ssp.exe 2.9.10: one wait event per ghost, reset by every waitable start (`\_v`, `\![sound,play]`; not `\8`, not a loop) and set by any waitable sound's end, stop or failure and by a stop of all, so the wait returns at the first waitable end; no-op with nothing playing [doc]. A break while waiting here (balloon double-click, a choice, a tag's `\![change,ghost]`) stops every sound of the ghost, no event [disasm WaitSound 0x64010d, BreakScript 0x63d992–0x63d9b1; EV §4.17]. Sumika: still a no-op |
| `\![sound,load,file,…]` | Preload (a failed load sends nothing [disasm 0x7254c0]) |
| `\![sound,loop,file]` | Loop (flags 3); not covered by `\_V`. Each start-over sends OnSoundLoop [file] (EV §4.17) [disasm 0x62deab, LoopNextEvent 0x719b4b] |
| `\![sound,pause\|resume\|stop[,file]]` | No file = all sounds. A stop sends no event, named or not [disasm 0x72578a–0x7257ac] |
| `\![sound,option,file,opts…]` | Change options while playing |
| `\![sound,cdplay,N]` | no-op |

- **One sound per file name** [disasm `MediaFindPlayingRefAdd` 0x725225]: a play or loop of a file that is still
  there starts that sound over with the new tag's flags (no event for the cut play); different files play side by
  side. Names match in any case (`wcsicmp`), for stop, pause and resume too. The events' R0 is the file as the tag
  gave it. Sumika does the same (`PageSaori.sound`).
- **Sub-command names** [disasm table 0xBBC5F0]: ssp.exe matches them by prefix, in table order (`pl` play, `loo` loop,
  `cdl`, `cd`, `loa` load, `un`, `pa` pause, `re` resume, `st` stop, `op` option, `wa` wait). Sumika keeps whole words,
  any case [decision].

Browsers can block audio until the user's first gesture on the page. Catch the rejection and carry on without blocking:
the sound starts at the next gesture, and its events come after it.

### 5.9 Open and close (dialogs)

| Tag | Behaviour | P |
|---|---|---|
| `\![open,inputbox,ID[,timeout[,text[,opts…]]]]` | Modeless input box; the script continues. timeout in ms (missing or ≤ 0 = none). text = initial value. Options: `--timeout=`, `--text=`, `--option=noclose\|noclear`, `--limit=N`, `--reference=x` (repeatable), `--balloon=ID` (which `balloonc*.png`). Drawn with the balloon's `balloonc` images (balloon spec). | **P0** |
| `\![close,inputbox,ID\|__SYSTEM_ALL_INPUT__]` | Close silently (no cancel event). **UNVERIFIED**: UKADOC says "silent" only for teachbox and communicatebox. | P0 |
| `\![open,communicatebox[,text\|--text=…]]` | Free-text box. Submit → `OnCommunicate(R0 = "user", R1 = text)`. Close → `OnCommunicateInputCancel(R0 = "", R1 = "cancel")`. | P0 |
| `\![close,communicatebox]` | Close silently | P1 |
| `\![open,passwordinput\|dateinput\|sliderinput\|timeinput\|ipinput,ID,timeout,…]` | Variants. R1 = text, `y,m,d`, value, `h,m,s` or ip; for the slider, R2 = `min,max`. | P1/P2 |
| `\![open,teachbox]`, `\__t`, `\![close,teachbox]` | Teach box: opening sends `OnTeachStart`; OK → `OnTeach` (R0… the words taught, the newest last; 311/312 ask again); × / Esc → `OnTeachInputCancel(R0 = "", R1 = "cancel")`; `\![close,teachbox]` closes it silently. **Implemented**: UI §6.3. | P2 |
| `\__c` | Legacy communicate box: the same as `\![open,communicatebox]` (**implemented**) | P2 |
| `\j[URL]` | `http(s)://` → new tab (`noopener`). `file:///x` → `ghost/master/x` in a new tab. `mailto:` → mail link. Anything else (a legacy jump ID) → no-op. | P1 |
| `\![open,browser,URL]` | New tab | P1 |
| `\![open,mailer,addr]` | `mailto:` | P1 |
| `\![open,configurationdialog(,PAGE)]`, and any `\![open,con…]` of 3 or more letters in any case (`config`, `CON`) | SSP's settings dialog, modeless: the script goes on; a second one only switches the page [disasm sub-command table 0xBBD448 (prefix `con`), 0x62D830, `CMainFrame::ShowPropertyWindow` 0x46CAE0]. Sumika: `PlayerHost.openWindow('configurationdialog', [PAGE…])` → the Preferences box (name, nickname, birthday, sex; ssp-ui.md). PAGE `setup` (any case), none or an unknown word: the box; the 16 pages Sumika has no box for (`ghost`, `ghost2`, `folder`, `display`, `talk`, `saveshare`, `dictation`, `network`, `network2`, `biff`, `application`, `messenger`, `ipmessenger`, `international`, `streamingtool`, `developer`) open nothing and are logged once [decision, properties.md §8]. `\![open,co]` is not this command (reported) | P1 |
| any other `\![open,…]` (editor, explorer, file, readme, terms, help, the explorers, calendar, messenger, surfacetest, aigraph, developer, shiorirequest, errorlog, viewers, rateofusegraph, addressbar) | no-op and log | P2 |
| `\![open,dialog,open\|save\|folder\|color,…]`, `\![close,dialog,ID]` | `OnSystemDialog`/`OnSystemDialogCancel` | P2 |

**Input box events** [UKADOC-SS "InputBoxのID"; UKADOC-EV OnUserInput]:

| Outcome | Event |
|---|---|
| OK, ID does not start with `On` | `OnUserInput`: R0 = ID, R1 = text, R2 = extra (slider only), R3… = `--reference` values |
| OK, ID starts with `On` | event named ID: R0 = text, R1 = extra, R2… = references |
| Close button | `OnUserInputCancel(R0 = ID, R1 = "close", …)` |
| Timeout | `OnUserInputCancel(R0 = ID, R1 = "timeout", …)`. If that response is empty, also send `OnUserInput(R0 = ID, R1 = "timeout")`. |

All of these are GET; a non-empty response is played under §6.5.

### 5.10 Property system (P2)

The property spec is `properties.md` (from ssp.exe 2.9.9's `SPVarSystemDispatcher` [disasm]); in short:

* `\![get,property,EV,NAME…]`: with at least one NAME, `GET EV` at the tag with the values as References,
  `SenderType: internal,property`; the script waits for the reply as for `\![raise]` (properties.md §3).
* `\![set,property,NAME,VALUE]`: needs VALUE (it may be empty); later arguments dropped; the result unseen (§4).
* `%property[NAME]`: expanded before the script plays, the value raw, a failed name removed (properties.md §2;
  §3.5 here).
* The names, what Sumika answers for each, and what fails until later: properties.md §5–§7.

### 5.11 Miscellaneous (P2)

| Tags | Behaviour |
|---|---|
| `\![execute,http-get\|http-post\|http-head\|http-put\|http-delete\|http-patch\|http-options,…]`, `\![cancel,http\|rss\|ical\|websocket,URL]` | **Sent** with `fetch()` [decision] (EV §4.15, `src/core/http.js`): SSP's options, parameters and charsets; the answer saved to `ghost/master/var/` in the engine's file system before `OnExecuteHTTPComplete` / `…Failure` (or the `On…` ID); without `--async` the script waits at the tag. Success as ssp.exe's `RealRead` decides it [disasm]: 200, 202 and 203 read the body (0x65f3d6–0x65f3ee), a 204 succeeds only for HEAD or OPTIONS (0x65f781), a 201 only for PUT (0x65fa69, nothing read), any other status is the Failure's R4 (a 201 to other methods and a 300 go to `SPHttp::Redirect`: `404` without a `Location`). What is written [disasm]: a success's body, and with `--async` an error page whose Content-Length is above 0 (0x65f8ab; with `--nofile` it is R3); a synchronous request drops the page (0x65f3fa). An empty value is ignored, except `--nofile=`, `--streaming=` and `--expand=`, which switch their mode on (0x664ef8, 0x6651ff, 0x664e1b) [disasm]. What a browser refuses (CORS, mixed content, dead hosts) fails as SSP's `error`. Never sent again by a replay (§7). |
| `\![execute,rss-get\|rss-post\|ical-get\|ical-post\|websocket,…]`, `\![send,websocket…]` | no-op and log (no corpus ghost uses them) [decision] |
| `\![execute,extractarchive\|compressarchive\|dumpsurface\|dumpballoon\|install\|ping\|nslookup\|filewatch\|createnar\|createupdatedata\|emptyrecyclebin\|schedule-*]` | no-op |
| `\![enter\|leave,passivemode\|inductionmode]` | Passive: cantalk is always 0, and there is no timeout, break or minimize. Induction lifts some of these. One mode at a time: ssp.exe keeps one value (SPGhost+0x41a8: 1 induction, 2 passive), so entering one mode leaves the other and leaving either leaves both [disasm ExecuteExclamationTag 0x62f43a, 0x62f484, 0x630513, 0x63055d] (EV §1.6). |
| `\![enter\|leave,selectmode\|collisionmode]` | no-op |
| `\![reload,shiori]` | Implemented (EV §2.10) [disasm 2.9.10 ReloadShioriFromTag 0x61e140]: at the tag, NOTIFY OnDestroy [R0 `reload`], the engine unloads and loads again from its stored files (a cold load), then GET version, the NOTIFY batch with OnInitialize [R0 `reload`] and OnSurfaceChange; no boot event, no event of its own. The script waits at the tag, then goes on with its `\__w` base at the tag's end (ResetWait 0x632cf0). For every reload: ssp.exe takes any `rel…` prefix and refuses an untrusted script (IsSafeScript 0x62c500); Sumika takes the word `reload` only and has no such gate [decision] (EV §2.10). |
| `\![reload,shell]`, `\![reloadsurface]` | Implemented (EV §2.10) [disasm ChangeOrReloadShellInternal(-1, false), 0x6313a8, 0x6313ee]: the shell in use swapped again at the tag (places, dress-up and the surfaces shown kept), the shell NOTIFYs, no OnShellChanging or OnShellChanged; the script waits, then ResetWait. |
| `\![reload,balloon]` | Implemented (EV §2.10) [disasm ChangeOrReloadBalloonInternal(-1, false) 0x631403]: the balloon in use re-skinned at the tag and stored as the choice, NOTIFY OnNotifySelfInfo, no OnBalloonChange; nothing with the built-in balloon. The script waits, then ResetWait. |
| `\![reload,ghost]` | Implemented (EV §2.10) [disasm ReloadGhost 0x6209e0]: a change to the ghost itself without OnGhostChanging / OnClose: OnDestroy [R0 `''`] and the unload, a cold boot without a boot event. The script is not held; it is cut when the ghost unloads. |
| `\![reload,makoto\|descript\|aigraph]`, `\![unload\|load,shiori\|makoto]`, `\![set,shioridebugmode]`, `\![create,shortcut]` | no-op (unknown tag); a `\![reload,…]` of these still resets the `\__w` base, as every reload's ResetWait (0x632cf0) [disasm]. `\![unload,shiori]` / `\![load,shiori]` would carry `reload` too in ssp.exe (OnDestroy / OnInitialize R0; LoadUnloadShioriFromTag 0x61e160) [disasm]. |
| `\m[…]` | SSTP only: ignore |

### 5.12 %-environment variables (P1)

| Variable | Value in Sumika |
|---|---|
| `%month %day %hour %minute %second` | Local time, no zero padding [disasm `ultowcs` 0x636C27, 0x636C72] |
| `%username` | `GET username` to the ghost at each expansion, no cache, as ssp.exe's `SPGhost::GetUserNameW` 0x643A10 [disasm]; with 204 or an empty value SSP's nickname setting, which in Sumika is the nickname (else the name) the visitor stored in the Preferences box, else `"user"` [decision, properties.md §8]. Its backslashes are doubled (§3.5). Sumika sends no boot-time `GET username` (an earlier version did): ssp.exe sends none |
| `%selfname`, `%selfname2`, `%keroname` | `sakura.name`, `sakura.name2`, `kero.name` from the ghost descript; the current shell descript's `sakura.name` / `sakuraname` and `kero.name` / `keroname` (any value, `none` too) replace `%selfname` / `%keroname` [disasm `SetCurrentShellIndex` 0x641DE0, `GetCharName` 0x6F11B0] (EV §2.6, §2.1 #11). The ghost descript's `name.allowoverride` does not stop that in ssp.exe 2.9.9: it gates only the shell's `sakura.name2` and `sakura.friend.name` [disasm `SPSeriko::LoadDescript` 0x6E5A79–0x6E5C35]; Sumika's `%selfname2` reads the ghost descript only (a shell's `sakura.name2` is not applied yet) |
| `%screenwidth`, `%screenheight` | Viewport size in CSS px |
| `%exh` | Hours since the runtime first started in this browser session (stands in for OS uptime) |
| `%et`, `%wronghour` | Joke values, as ssp.exe 2.9.10 draws them (properties.md §2.3) [disasm 0x6367C5, 0x637274]: `%et` = r mod 1000 + one of `msec yard kg t dozen` (r mod 5) for r = genrand(59787), e.g. `234dozen`; `%wronghour` = the hour 1 or 2 earlier or later, mod 24. The guesses here before (`%exh` + `万年`, hour + 1..11) were wrong |
| `%ms %mz %ml %mc %mh %mt %me %mp %m? %dms` | Random words: the ghost's (`GET` with ID `\ms` …; `GET Word` / `Type` for a SHIORI/2.x one), `\m?` again as `\m`, else SSP's word list `word_compatible.txt`; no word: left as written. A `%m` that ends the script asks `\m`. properties.md §2.4 [disasm `SPGhost::GetWord` 0x63FA00] |
| `%lastghostname`, `%lastobjectname` | Install-time values: empty |
| `%*` | Same as `\![*]` (ssp.exe replaces it by `\![*]` while expanding [disasm 0x6372E5]; Sumika's tokenizer makes it the marker) |
| `%property[x]` | properties.md §2, §5 |

---

## 6. Timing model

### 6.1 Clock and per-character wait

Use a **virtual clock** so that waits do not drift and 0 ms steps cost nothing:

```text
run.due = now()                                     // at Start
step():                                             // called from requestAnimationFrame (and a setTimeout fallback when hidden)
  budget = 8 ms of CPU
  while run.state == 'running' and run.due <= now() and budget left:
     tok = tokens[ip++]
     exec(tok)                                      // may add to run.due, or set state = blocked/clickwait/finished
  paint()                                           // one DOM/canvas commit per frame
exec(text char c):  draw(c); run.due += charWait()
exec(\w N):         run.due += 50*N
exec(\_w[ms]):      run.due += ms
exec(\__w[ms]):     run.due = max(run.due, run.t0 + ms)
blocking ops:       state = 'blocked'; on completion: run.due = max(run.due, now()); state = 'running'
```

`charWait()`:

* `0` if `run.quick`, or inside `\![lock,balloonrepaint]` (painting is deferred anyway; the waits still run).
* Else `run.charWait.ms` if `\![set,balloonwait,Nms]` was given.
* Else `round(MESSAGE_SPEED_MS × (run.charWait.mul ?? 1))`.

`MESSAGE_SPEED_MS` is a user preference (SSP: "Message speed" slider, setting key `MessageSpeed` [SSP-BIN]). Its SSP default in ms is **UNVERIFIED**: no document or string table gives it. Ship **50 ms** as the default (equal to one `\w1` unit) and expose it in Sumika's settings. §9 says how to calibrate it.

A character, for timing purposes, is:

* each code point of display text, spaces and full-width spaces included;
* each `\_u`/`\_m`/`\&` character;
* each inline image;
* the `\![*]` marker;
* a whole `\q[title,…]` title, which is drawn at once and then waits once [INFERRED].

U+0001 and other control characters take no time. Tags take no time.

How the tags combine:

| Combination | Result |
|---|---|
| `\_q` on | Characters cost 0. `\w`, `\_w`, `\__w`, `\x` and all blocking operations still wait [UKADOC-SS \_q]. Everything between two waits appears in a **single paint**. Tsubasa relies on this for game frames: `\_q\c<64 images>\_w[n]`. |
| `\_s` on | Each character goes to every listed balloon and costs one charWait |
| `\![set,balloonwait,0]` | Same as quick, for characters only |
| `\__w[N]` | An absolute deadline from `t0`; it overlaps with the typing time that has already passed |

SSP lets the user hold a "fast-forward" key (`Talk.SpeedUp.Enable`, `Talk.SpeedUpKey` [SSP-BIN]). While the key is held, all waits count as 0. P2, optional.

### 6.2 Blocking points

These set `state = blocked` or `clickwait`. While blocked, `talking` stays on:

* `\x` and `\x[noclear]`: wait for a left click on any balloon of the ghost.
  * Show the balloon's click-wait marker (`clickwaitmarker.*` [UKADOC-BAL]).
  * The click-wait timeout is off by default [SSPHELP-TALK "クリック待ちタイムアウト（標準＝しない）"].
  * Whether clicking the character also resumes is **UNVERIFIED**. Recommendation: balloon clicks only.
* `\i[ID,wait]`, `\__w[animation,ID]`: until the animation ends.
* `\![move]`: until the move completes. Also `\![set,scaling|alpha,…,--wait]`.
* `\_V` and `\![sound,wait]`: until the sound ends.
* `\![raise]` and `\![embed]`: until the SHIORI reply arrives. Sumika's SHIORI may run asynchronously in a worker, so the player must await it.
* `\![change,shell,X]` (without raise-event) and `\![change,balloon,X]`: until the swap is done (`PlayerHost.change` returns a promise; EV §2.6). A ghost change never blocks: it waits for the script's end instead.

### 6.3 Status flags and cantalk

| Flag (SSP `Status` header [UKADOC-S3]) | Sumika's definition |
|---|---|
| `talking` | `run.state ∈ {running, blocked, clickwait}` |
| `choosing` | Some balloon holds a `\q` or `\__q` item (not a `\_a` anchor) and some balloon is visible, whatever the run state: also while the script plays and in a pick's own OnChoiceSelect (`Balloons#choosing`) [disasm AddStatusText 0x639ad8–0x639b09] (EV §1.6). Cantalk and the ticks still read the choice wait (`run.state == finished`, the script had choices, the balloons are still open and the choice timeout has not fired) |
| `timecritical` | `run.timeCritical`, only when neither passive nor induction mode is on [disasm 0x639ba4] |
| `nouserbreak` | `run.userBreakDisabled` of the last run (`ScriptPlayer#noUserBreak`): from `\![enter,nouserbreakmode]` until its leave or the next script, kept after `\e` [disasm 0x62f44e, 0x630527, Loop 0x63b540] |
| `passive`, `induction` | ghost modes, one slot (SPGhost+0x41a8): one of the two at most, `induction` or `passive` [disasm 0x639b5b–0x639ba2] |
| `minimizing` | minimized |
| `opening(input/communicate/teach/dialog)` | input boxes that are open |
| `balloon(0=K/1=K…)` | visible balloons and their kinds |

* **The script is "finished"** when `\e` executes or the token stream ends. Closing the balloon is a separate, later step.
* **cantalk** (Reference3 of `OnSecondChange` and `OnMinuteChange`) = `!talking && !choosing && !passive`. That `choosing` makes cantalk 0 is [INFERRED], medium confidence. It keeps random talk from wiping an open menu.
* When cantalk is 0, `OnSecondChange`/`OnMinuteChange` are still sent every second or minute, but as **NOTIFY** with R3 = 0, and their Value is ignored [UKADOC-EV]. `OnHourTimeSignal` is held back until cantalk is 1, so it can arrive late [UKADOC-EV].
* Satori reads both. Random and timer talk on `OnSecondChange` require R3 ≠ "0" (`can_talk_flag`). A `Status` containing `talking`, `induction` or `passive` suppresses stroke ("nade") reactions while another talk is playing and delays "hold-release" talks [SATORI-SRC satori_EventOperation.cpp]. So both R3 and `Status` must be correct.

### 6.4 After the script finishes

| Timer | Default | Starts | On expiry |
|---|---|---|---|
| Choice timeout (only when the script has a choice and no `\*`) | **30 000 ms** [SSPHELP-TALK]; `\![set,choicetimeout,ms]`; 0/-1 = none | when the script finishes | hide balloons; GET `OnChoiceTimeout(R0 = script)`; play a non-empty Value |
| Balloon timeout (scripts without choices; anchors do not count) | **15 000 ms** [SSPHELP-TALK]; `\![set,balloontimeout,ms]`; 0/-1 = none | when the script finishes | hide balloons; GET `OnBalloonTimeout(R0 = script, R1 = "0")` (UKADOC calls R1 "remaining time"; its meaning is **UNVERIFIED**); play a non-empty Value |
| Pointer over a balloon | SSP option "Disable timeout when cursor is in balloon" (`Balloon.NoTimeoutMouseOver`); its default is on [disasm 0x72822b] | — | Pause the countdown while the pointer is inside a balloon and restart it on leave |
| `OnSurfaceRestore` | more than SSP's global balloon timeout + 15 s (30 s) after the script stopped, at a tick whose local second is 10–50; a script's `\![set,balloontimeout]` does not change it [disasm] | when the script stops: its end, or a break after it had shown something | GET once. A newer script holds it while it plays and stamps again at its end; it waits (never dropped) while choices, `\t`, passive mode and the like hold it (EV §3.4) |

Passive mode turns off all of these timeouts. A pending `OnSurfaceRestore` waits for its end [disasm IsLocked, EV §3.4].

### 6.5 New script while one is running (arbitration)

SSP has no general script queue; SSTP has one, but Sumika does not support SSTP. A **non-empty** GET Value always starts a new script, which aborts the current one (§4.3). An empty Value changes nothing. Per source:

| Source | Idle | Talking or choosing | During `\t` |
|---|---|---|---|
| Mouse on a character (`OnMouseClick`, `…DoubleClick`, `…Move`, `…Wheel`, `…Down/Up`, `…Enter/Leave`, `…Hover`, `…Gesture`, `…Drag*`) | GET; a non-empty Value starts | GET; a non-empty Value **interrupts** | **Not sent at all** (dropped, not queued) [UKADOC-SS \t]. **UNVERIFIED**: whether keyboard events (`OnKeyPress`) are suppressed too; Sumika suppresses them. |
| Clicking a choice | §5.6.2 (always aborts) | same | allowed: a choice selection is a script break, which ends `\t` |
| Clicking an anchor | §5.6.2 | interrupts only if the Value is non-empty | allowed (**UNVERIFIED**) |
| Double-click on a balloon (break) | closes the lingering balloon | break (§4.3) | allowed |
| `OnSecondChange`/`OnMinuteChange` | GET (R3 = 1) | NOTIFY (R3 = 0), Value ignored | NOTIFY |
| `OnHourTimeSignal` | GET | deferred until idle | deferred |
| `\![timerraise]` firing | GET | GET; a non-empty Value **interrupts**. Tsubasa's games chain 80 ms timers on purpose. | delivered (**UNVERIFIED**) |
| `\![raise]` / `\![embed]` in the running script | §5.7 | | |
| Input box / communicate box submit or cancel | GET | GET; interrupts | GET |
| NOTIFY events (`OnSurfaceChange`, non-final `OnDressupChanged`, …) | Value ignored | | |
| The final `OnDressupChanged` (GET) | sent after the script ends; a non-empty Value starts | | |

Implementation: put all SHIORI requests on **one FIFO**, one request at a time. Start a GET response the moment it arrives, so the newest response wins. Stamp each request with the run it came from and drop responses to `\![raise]`/`\![embed]` whose run has already been aborted.

### 6.6 Timers (`\![timerraise]`)

```text
key = fold(ev)                                                 // any case: SSP's table, one list for all four tags
delete timers[key]                                             // the same event replaces whichever timer had it
ms == 0  → done                                                // cancel
ms = max(ms, 50)                                               // `cmp eax, 0x32` [disasm 0x632FBC]
timers[key] = { ev, refs, intervalMs: ms, repeat: (ParseBool(R) != 1), dueAt: Date.now() + ms,
                kind: 'raise'|'notify', to?: ghost }           // to: timerraiseother / timernotifyother
on due:   to ? the site raises ev(refs) in `to`, looked up now (EV §2.7.9); a repeating one skips the tick while
               its last raise is still queued or delivered, and a queued one is dropped once the timer is gone
             : fire GET ev(refs) (or NOTIFY), skipped while the last one is in flight; result → §6.5
          if repeat: dueAt = max(dueAt + intervalMs, now + 1)  // do not burst missed ticks
          else delete
```

* SSP's ExecuteRaise 0x632E80 [disasm]: one list per ghost, keyed by the event name compared with `wcsicmp_custom`
  (A–Z and SSP's lower-case table above U+00FF; not À–Þ), shared by `timerraise`, `timernotify`, `timerraiseother` and
  `timernotifyother`. `R` is SSP's ParseBool (0x789660): `true enable enabled yes on ok`, or digits not all `0`, fire
  once; everything else repeats, an empty `R` too (`commands.js` `parseBool`). Tsubasa's 10 ms card-game chains run at
  50 ms, as in ssp.exe [disasm 0x632FBC]. Timers die with the ghost [disasm ~SPGhost 0x61B3A5]; a shell
  change keeps them [infer].

* `refs` are the arguments after `ev` as ParametersToArray gives them (§3.4, `refList`): an empty last argument ends
  them, a one-space one is empty. SSP copies them into the timer up to the first empty string and fires through
  ExecuteRaiseReal → ParametersToArray [disasm], so `\![timerraise,10,1,OnT,a,]` raises `OnT` with `a` alone, as
  `\![raise,OnT,a,]` does.
* Use wall-clock `Date.now()` due times so timers survive navigation (§7).
* Browsers throttle hidden tabs to about 1 s and to longer in the background; timers will fire late there, which is acceptable.
* The SSP doc says timers survive a network update [UKADOC-SS]. Sumika makes them survive page navigation.

---

## 7. Page navigation and silent resume

Every page navigation reloads `sumika.js`, but the ghost must look continuous (no OnBoot or OnClose per link). What the script player must persist at `pagehide`/`visibilitychange=hidden` (localStorage or IndexedDB, keyed by ghost id), and how to restore it:

| State | Save | Restore |
|---|---|---|
| Ghost-lifetime settings (§4.2) | yes | apply before the first paint |
| Per-scope surface, window position, alignment, scaling, alpha, bind state | yes | apply |
| Timers (§6.6) | yes, with absolute `dueAt` | Re-arm. A one-shot that is already overdue fires right after the resume is complete. A repeating timer that is overdue is moved to `now + interval`. (Design choice: Satori's game and menu state machines depend on these timers.) |
| SHIORI state | the SHIORI layer's job (Satori save data) | — |
| `ghostClosed` (after `\-`) | yes | do not auto-boot; show the call button |
| **Current run** | `src`, `ip`, `state`, `hasChoices`, the remaining post-script timeout ms, `origin` | **Fast-forward replay** (below) |

**Fast-forward replay** rebuilds the balloon instead of serialising the DOM:

1. Re-tokenize `src`.
2. Execute tokens `[0, ip)` with every wait set to 0 and **side-effect tags suppressed** (table below). Display and state tags run normally.
3. Then:
   * if the run was `running`: continue normally from `ip`;
   * if it was `clickwait`: re-enter click wait;
   * if it was `blocked` on a move, animation or sound: treat the block as completed;
   * if it was blocked on a `raise`/`embed` response: the event was already sent, so continue past the tag;
   * if it was `finished`: re-arm the remaining balloon or choice timeout. Choices are rebuilt by the replay and are clickable again.

| Class | Tags |
|---|---|
| **Replay** (state/display) | text, `\0 \1 \h \u \p \s \b \n \_n \c \C \_l \_b \f \_q \![quicksection] \_s \t \* \x(state only) \__q \q \_a \![*] \_u \_m \& \_? \_! \__v \e \![set,balloon*\|choicetimeout\|autoscroll\|serikotalk] \![lock\|unlock,…]` |
| **Skip** (side effects already done) | `\![raise] \![embed]`*, `\![notify]`, `\![timer*]`, `\![bind]` (its state is already persisted), `\![move\|moveasync]` and `\4 \5` (the position is already persisted), `\![set,alignment*\|scaling\|alpha\|zorder\|sticky-window\|position\|windowstate\|wallpaper\|…]` (persisted), `\![open\|close,…]` and `\__c \__t`, sound tags, `\-`, `\+`, `\![change\|call,…]`, `\j`, `\i`, `\![anim]`, `\6 \7 \a`, every `\![execute,…]` (a web request is never sent twice, EV §4.15) and `\![cancel,…]` |

\* For `\![embed]`, the spliced result must have been saved with the run (store the token list after the splice, or store the embed results by position).

Surfaces set by replayed `\s` tags end at the persisted values anyway, so replaying them is harmless. Pick one rule and keep it: replay them.

---

## 8. P0 checklist (Tsubasa)

1. Tokenizer §3: escapes, quoting, `\]`, Windows paths in brackets, digit forms, unknown-tag skipping, stray `\__q`, `\w[n]`. Must handle 530 KB scripts.
2. Scopes 0, 1 and arbitrary `\p[n]`; `\s[n]`/`\s[-1]` (calls into the shell module); lazy character windows.
3. Balloons:
   * visibility rule §4.4; `\b[n]`/`\b[-1]`;
   * content model with cursor and line metrics; `\n`, `\n[half]`, `\_n`, `\_l` (absolute and `@` relative);
   * `\c`, `\c[char,n]`, `\C`;
   * `\_b` absolute and inline, with colour key, `opaque`, foreground/background, clipping, missing-file tolerance and a decode cache;
   * `\![*]`;
   * `\f` (default, color, bold, strike, shadowcolor, height, cursorpencolor).
4. Timing §6: virtual clock, char wait, `\w`, `\w[n]`, `\_w`, `\_q` (waits still apply), `\x`, `\t`, `\e`, post-script timeouts (15 s and 30 s), `\*`.
5. Choices: `\q[t,id]`, `\q[t,OnX,r…]`, `\__q[id]…\__q` with inline image buttons, the selection algorithm §5.6.2, hover cursor style.
6. Events: `\![raise]` (synchronous, `SecurityLevel: local`), `\![timerraise]`, `\![bind]` and the dress-up events after the end, `\-` exit, the arbitration rules §6.5, the Status flags and cantalk §6.3.
7. Windows: `\![set,alignmentondesktop|alignmenttodesktop,free]`, `\![move]` (legacy form, synchronous, lenient), `\![set,scaling,-100,100]` mirror.
8. Dialogs: `\![open,inputbox]` (ID, timeout, text) with the OnUserInput/Cancel events, `\![close,inputbox]`, `\![open,communicatebox]`.
9. Persistence and fast-forward resume §7.
10. Everything else in Tsubasa's corpus (`\v \6 \8 \j \+ \![set,wallpaper] \![set,windowstate,minimize] \![change|call,ghost] \![raiseplugin] \![raiseother] \![updatebymyself] \![open,mailer|browser]`) must at least parse and no-op without visible garbage.

---

## 9. Open questions and calibration tests (run in SSP 2.9.08)

Each **UNVERIFIED** item can be settled by sending a script to a running ghost. Use SSP's developer palette (`\![open,developer]`, after enabling developer options) or SSTP, and watch the result or a screen recording.

| # | Question | Test script / method | Default Sumika ships |
|---|---|---|---|
| 1 | What is SSP's default per-character wait (ms)? | `\0\b[2]` followed by 100 × `あ` and `\e`, with the default Message-speed setting; screen-record at 60 fps and count frames from the first to the last glyph. Repeat with `\![set,balloonwait,100ms]` as a control. | 50 ms |
| 2 | What does `\w[1000]` do: N ms, N × 50 ms, a no-op, or literal text? | `A\w[1000]B\e` | N ms |
| 3 | Which image does `\b[1]` use on scope 0, and does `\b[n]` keep the text? | `\0abc\b[1]def\e` with LightBlue | pair = floor(n/2), text kept |
| 4 | `\C` after the previous balloon timed out; the scope after `\C` | Talk, wait more than 15 s, then `\C\1x\e`; also `\1abc\e` followed by `\Cdef\e` | fresh balloon; scope 0 |
| 5 | Does `\x` clear every balloon or only the current scope's? | `\0aaa\1bbb\x\1ccc\e` | all |
| 6 | Does an open choice make cantalk 0? | Show `\q[a,b]` (without `\*`) and watch the `OnSecondChange` Reference3 in the SHIORI log / dev palette | 0 |
| 7 | Line height for font.height 12, and the wrap after a line-filling inline image | Screenshot Tsubasa's first-boot choice screen (`OnChoiceSelect 初回`) in SSP and compare pixel offsets | max(font line, image height); gap 2 px (guess) |
| 8 | What does `\![*]` draw when the balloon has no `marker*.png` (LightBlue)? | `\![*]abc\e` | `sstp.png`, else nothing |
| 9 | Is full-width `＠` accepted in `\_l`? | `\_l[0,＠-31]x\e` | not accepted (y = 0) |
| 10 | Width of a missing inline image | `a\_b[nonexist.png,inline]b\e` | 0 |
| 11 | Does `\c` reset the font? | `\f[bold,1]aa\cbb\e` | keeps the font |
| 12 | Does an anchor click abort the script when its event returns nothing? | `\_a[x]link\_a long text…` | no |
| 13 | Are timers delivered during `\t`? Are keyboard events suppressed? | `\t\![timerraise,500,1,OnX]` + 2 s of text | timers yes, keys no |
| 14 | `\__q[…]` opened while another range is open | `\__q[a]x\__q[b]y\__q\e` | the first range closes |
| 15 | Does `\![close,inputbox,ID]` send OnUserInputCancel? | open, then close, and watch the log | no |
| 16 | Are `%month` etc. zero-padded? Is `%%` an escape? | settled [disasm, §3.5]: no padding; `%%` is no escape (`%%month` gives `%10`) | no padding; no escape |
| 17 | `\` followed by a non-ASCII character | `a\あb\e` | settled [disasm, §3.2]: the `\` is dropped, `あ` shows |
| 18 | `\![bind]` events when the script is aborted early | bind + a long text, then interrupt with a click | events still fire |
| 19 | Default of "Disable timeout when cursor is in balloon" | fresh profile, open the dialog | on |
| 20 | Inside brackets: is `\\` an escape? | `\![raise,OnX,a\\]b]` with a SHIORI log | `\\` kept, does not escape `]` |
| 21 | %-variables at script start, not in brackets (§3.5; properties.md §9 C2) | `\s[5]%property[currentghost.scope(0).surface.num]\e`; `\q[%username,X]\e` | the surface before 5; the choice shows `%username` |

Questions that the other research topics own: balloon layout pixels (origin, wrap point, line gap, arrow), shell compositing for `\s`/`\![bind]`, SHIORI request headers (`SecurityLevel`, `Status`, `BaseID`), and how the ghost menu raises events.

---

## Appendix A. Scratch artefacts

All in `docs/research/scratch/ss/`:

| File | Content |
|---|---|
| `inventory.py`, `inventory_out.txt` | Tag inventory. The Python tokenizer in it follows §3 and can be ported to JS. |
| `bang.py` | `python bang.py <subcmd\|tag:NAME> [top]`: argument-shape histograms |
| `bimg.py`, `missing.py` | `\_b` options, coordinate units, quoting, missing files |
| `feat.py`, `raisepos.py`, `qbal.py` | Script-level features, raise positions, `\__q` balance |
| `ctx.py`, `rare.py` | Context dumps (write `BS` in place of a backslash in patterns) |
| `list_sakura_script.txt`, `ss_list_shiori_event.txt`, `spec_shiori3.txt`, `descript_balloon.txt`, `help_config-talk.txt` | Text dumps of the UKADOC and SSP help pages used here (for reference; do not quote them at length) |
| `ninix_script.rb`, `ninix_sakura.rb`, `ninix_balloon.rb`, `ikagaka_ssp.coffee` | Prior-art sources consulted (GPL/MIT; consulted only, do not copy). Ikagaka's player uses an 80 ms default and treats `\w` as × 100 ms, which is wrong for SSP. |

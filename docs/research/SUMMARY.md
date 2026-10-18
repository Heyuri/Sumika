# Research synthesis: contradictions, gaps, the P0 list, risks

Status: synthesis of the seven research specs in `docs/research/`. It is normative where it resolves a contradiction or fills a gap. Everything else stays in the topic docs, and this file points to them.

Updated where the code or newer `[observed]` findings overtook it; those places say "Done" or "Superseded". For balloon behaviour (word wrap, leading `\n`, choice hover, dragging, the communicate box) `balloon-format.md` and `ssp-ui.md` §6 are newer than this file and win.

| Short name | File |
|---|---|
| **WASM** | `satori-wasm.md` (Satori build, ABI, patches P1–P5, MEMFS, tests) |
| **SS** | `sakurascript.md` (tokenizer, player, timing, resume replay) |
| **EV** | `shiori-events.md` (protocol, boot/resume, clock, mouse/keys, dress-up events) |
| **SH** | `shell-format.md` (surfaces*.txt, compositing, SERIKO/MAYUNA, hit test) |
| **BA** | `balloon-format.md` (balloon skin, layout engine, placement, input boxes) |
| **UI** | `ssp-ui.md` (menus, placement, scheduling, browser design, Ikagaka lessons) |
| **TS** | `tsubasa-needs.md` (SAORI stand-ins, Tsubasa's commands, games, persistence) |
| **ARCH** / **CON** | `docs/ARCHITECTURE.md` / `docs/CONTRACTS.md` (existing project design) |

Priority marks are the same as in every other doc: **P0** = what Tsubasa in a tab needs, **P1** = common in other ghosts, **P2** = rare.

Evidence tags:
- **[U]**: UKADOC (local dumps in `scratch/ss/` and `scratch/sspui/`).
- **[S]**: Satori source (`scratch/wasmbuild/u8/satori/`, a UTF-8 copy of commit e2bf348).
- **[C]**: the real-DLL corpus (7,334 responses).
- **[L]**: the SSP 2.02 request log, `scratch/ayame_u8.log`.
- **[B]**: strings and `ssp.map` symbols from SSP 2.9.08f's `ssp.exe`.
- **[R]**: the dump of SSP's English resource.dll, `scratch/sspui/dialogs_en.txt`.
- **[H]**: SSP help, `scratch/balloon/config-talk.txt`.

The scripts used for this synthesis are `docs/research/scratch/summary/q*.py`, with the corpus helper `corpus.py`.

Not in the repository: `scratch/` (`docs/research/scratch/`), the corpus (`tests/corpus/`) and Tsubasa's own files
(`site/ghost/tsubasa/`). These are development material, cited as the sources (CLAUDE.md "Project rules").

---

## 0. The decisions in one screen

1. **Engine.** Use Satori **Mc203-6, unicode branch**, with WASM patches **P1–P5** (WASM §8) **plus two new patches: P6 (talk-countdown state) and P7 (session clock)**. Both are specified in §2.1 here.
   - Done: `engines/satori/build.py` and `patches.py` carry P1–P4 (with the `shiori_plugin.cpp` hunk of P2 and `satori_load_resume`), P5 (`-iquote`, no `Memory.h`), P6 and P7.
   - P7's clock counts from **this ghost's last cold boot** (`bootEpochMs` in its state), not from the tab's first page, so a ghost changed to at 10:00 counts from 10:00 (§2.1).
2. **Timing defaults.** All are confirmed from SSP's own files [R dialog 104; H; U]:
   - **50 ms** per character;
   - **15 s** balloon timeout;
   - **30 s** choice timeout;
   - click-wait never times out;
   - OnSurfaceRestore comes more than **30 s** (Timeout.Balloon + 15 s) after a script stopped, at a tick whose local
     second is 10–50: 30–51 s. It does not wait for the balloon (amended, EV §3.4) [disasm].

   `CON` v2 has no 15 s choice timeout (C1).
3. **Navigation is not a ghost exit.** Persist and restore all of the following:
   - Satori save data (written by the worker, after requests);
   - ghost-lifetime state, positions and binds;
   - **timerraise timers**;
   - the **current run** (replayed with SS §7);
   - open input boxes (P1);
   - **Satori's random-talk countdown** (P6).

   The "lost on navigation" decisions in EV §2.2 and §4.10 are overruled (§1, C4 and C5).
4. **cantalk** = booted ∧ ¬closing ∧ ¬talking ∧ ¬choosing ∧ ¬minimized ∧ ¬passive ∧ ¬induction ∧ ¬document.hidden (C6). Ticks are always sent: as GET when cantalk is true, otherwise as NOTIFY with R3=0. "closing" also covers a ghost change and a shell swap (`changing`, `swapping`; EV §1.6, §2.5, §2.6). Status `changing` is a shell change's, never a ghost change's (EV §1.6) [disasm]. An open input, communicate or teach box, and SSP's own dialogs, are no part of it: a box only adds `opening(…)` to Status (C6) [disasm; decision: follow SSP].
5. **`\t`** drops mouse **and** key events only. Timers, raises and box results are still delivered, and their replies may replace the script (C7).
6. **`\![raise,OnDirectSaoriCall,…]`** is **enqueued without waiting**, because Satori always answers 204. Every other raise blocks playback until its reply arrives (C25).
7. **Balloon opening and `\C`.**
   - A balloon opens only for **non-blank** content (C14).
   - `\C` counts as "append" when only non-content tags come before it. This is needed because Tsubasa's OnTranslate output puts `\1\s[10]` in front of `\C` scripts (§2.2).
8. **Mouse and key details.**
   - OnKeyPress R2 = **1 on the first keydown** (C8).
   - After a drag: DragEnd, then Up, never Click (C10).
   - On the second release of a double-click: Up, then Click (C11).
9. **Hit testing.** Use a CSS `clip-path` built from the alpha mask (works with touch), plus an exact collision lookup in the event handler (C12).
10. **One state schema** (§2.5):
    - Engine files go to IndexedDB, written by the worker.
    - Everything else is one JSON object. It is written synchronously to `localStorage` on `pagehide` and on `visibilitychange:hidden`, and debounced on every change.

---

## 1. Contradictions between docs, and their resolution

Each row gives what the docs say, the primary source used, and the **normative resolution**.

| # | Topic | Conflicting statements | Primary source | Resolution |
|---|---|---|---|---|
| C1 | Choice timeout default | CON §ScriptPlayer: 15 s. SS §6.4, EV §3.4, UI §4.3, BA §3.11: 30 s | [H] "選択肢タイムアウト（標準＝30秒）"; [R] dialog 104 "(Default = 30sec.)" | **30 000 ms.** The balloon (talk) timeout is 15 000 ms; click-wait has none. Fix CON. |
| C2 | Per-character speed | SS §6.1 and §9 Q1: unknown, ship 50 ms. UI §4.7: 50 ms | [R] dialog 104 "Message speed … Default (50ms) … Slower (200ms)" | **50 ms**, confirmed. SS §9 test 1 is not needed. |
| C3 | `\![timerraise]` 2nd argument | UI §11 Q11: UKADOC contradicts itself | [U] list_sakura_script (timerraise): the main text says 0 = repeat and ≥1 = once. Both examples agree (5000,1 = once; timerraiseother 30000,0 = every 30 s). Only the "valid until…" sentence is swapped. | **0 = repeat every ms until cancelled; ≥1 = one-shot.** `ms=0` cancels that event's timer. A new timer for the same event replaces the old one. Tsubasa always passes 1 and re-arms the timer herself. **Amended (SS §6.6):** SSP's ParseBool decides `repeat` (empty or garbage = repeat), 1–49 ms = 50, one key per event name (any case) for every timer tag [disasm 0x632E80, 0x789660]. The numbers above stand. |
| C4 | Pending timers across page navigation | EV §2.2 and §4.10: lost (DECISION). SS §7, UI §9.5, TS §9 and §11: persist | [U] timers live until ghost exit and survive a network update. ARCH: navigation is not an exit. | **Persist** `{ev, refs, repeat, intervalMs, dueAt (epoch ms), kind}`. On resume, one-shots that are already overdue fire once, in `dueAt` order, after the resume sequence. Overdue repeating timers move to `now+interval`. **P0**: dress-up submenus re-open through 1 ms timers, and the game loops use timers. |
| C5 | Script in progress at navigation | EV §2.2: lost (P2 option). SS §7: fast-forward replay. UI §9.5: balloon snapshot plus remainder | Product goal "menus survive link clicks" (UI §1.10, BA §7) | **The SS §7 replay is the single mechanism.** Persist the **post-OnTranslate** script, the token index, the run state, the remaining post-script timeout and the `\![embed]` splices. Replay with waits = 0 and side-effect tags skipped. **P0** for finished runs with choices and for running runs; it is the same code. |
| C6 | Definition of cantalk | SS §6.3: ¬talking ∧ ¬choosing ∧ ¬passive. EV §1.6 adds minimized, induction, timecritical, hidden and !booted, and says open boxes do **not** clear it. UI §5.2 adds open boxes (withdrawn) and closing/booting. | [U] OnSecondChange R3 = "a talk can be played"; spec_shiori3 Status flags; the passive-mode notes; [L 4613]: NOTIFY with R3=0 while a choice menu was up | `cantalk = booted ∧ ¬closing ∧ ¬talking ∧ ¬choosing ∧ ¬minimized ∧ ¬passive ∧ ¬induction ∧ ¬document.hidden`. timecritical is a subset of talking. **Open boxes do not clear it** (an earlier DECISION anyBoxOpen → 0, which kept random talk away from Number Guessing and typing prompts, is withdrawn [decision: follow SSP]): ssp.exe 2.9.10 sends a tick as NOTIFY, with R3 = !notify (NotifyTimeChangeEvent 0x641d31), only while a script plays, a `\x` or choice waits, `\t`, a shell change, minimized, passive/induction, SSTP quiet or SSF [disasm OnTimeChange 0x641e03–0x641e50, TimerExec 0x497e37–0x497e8a, 0x497fc6–0x49801d]; a box only sets SPGhost+0x4198 (CreateInputBox 0x49b26c–0x49b27a, UpdateInputMode 0x63e620), which only the Status builder reads (AddStatusText 0x639c2e–0x639d25); SSP's modal dialogs keep the timer running (RunModalLoop) [disasm] (EV §1.6). A finished balloon without choices does **not** block talk (cantalk = 1). A ghost change and a shell swap count as closing (EV §2.5, §2.6). |
| C7 | What `\t` suppresses | UI §5.5: only `OnMouse*`, and other replies are *queued* until the script ends. SS §6.5, EV §1.5: mouse and key events dropped, timers delivered. | [U] `\t`: no notification of "mouse-type and similar" events until a script break or `\e` | **Drop** all `OnMouse*` (including Enter/Leave/Hover/Wheel/Drag) and `OnKeyPress`. **Deliver** timerraise, raise, and input/communicate results; their non-empty replies replace the script, with no deferral queue. Choice clicks are allowed, because a selection is a script break and ends `\t`. In the corpus only 1 of 569 `\t` scripts (`リズムゲーム終了`) contains timerraise, and it only cancels timers (`scratch/summary/q3.py`). So this choice carries little risk for Tsubasa. |
| C8 | OnKeyPress R2 base | EV §4.6: 0 (ASSUMPTION). TS §6.5 and Q1: 1 | [U] R2 = "key hold count", base unstated. The Win32 `WM_KEYDOWN` repeat count is ≥ 1. Tsubasa's UFO moves at R2 = 1, 3, 6, 9…, and every shortcut is guarded with `（Ｒ２）<2` (dic02_Event.txt:812–814). | **R2 = 1 on the first keydown, +1 for each auto-repeat keydown of the same key, reset on keyup.** With base 0, every held shortcut would fire twice, and a single tap would not move the UFO. Verify (§5). |
| C9 | Key names, modifier order | UI §9.7 (from ninix): `prior`/`next`, modifiers `ctrl,alt,shift`. EV §4.6 (from ssp.exe): `pageup`/`pagedown`, `shift,ctrl,alt` | [B] key table: `pageup pagedown escape return space clear capslock kana kanji printscreen numlock scrolllock shift-left …`. Tsubasa compares R4 with exactly `shift` (dic13_Game.txt:1213). | Use the **EV §4.6** table (SSP's own literals). Modifier order is `shift,ctrl,alt`; it only matters when two or more modifiers are held. |
| C10 | Release after a drag | EV §4.5: neither Up nor Click (ASSUMPTION). UI §3.4: DragEnd, then Up, no Click | [U] OnMouseUp is sent whenever the L/R button is released. OnMouseClick is only for a press-and-release click. | **DragStart (≥4 px) … DragEnd, then OnMouseUp; never OnMouseClick.** This keeps Satori's hold logic and Tsubasa's `Mclose` hold consistent. |
| C11 | Second release of a double-click | UI §9.4: Up, no Click. EV §4.2: Up, then Click if 204 | [L 3948–4122]: Down, Up, Click, …, DoubleClick (in place of the 2nd Down), OnTranslate, Up (Status talking), Click (Status talking) | **EV §4.2.** |
| C12 | Hit-testing technique | SH §6.5: canvases are `pointer-events:none` and a document-level capture listener toggles them. UI §9.3: CSS `clip-path` from the alpha mask | Touch has no hover before pointerdown, so toggling cannot work for touch (UI §9.3). | Use a **clip-path**: the union of opaque pixel runs, rebuilt when the opaque shape changes (transient animation frames may be OR'd in or ignored). Then run SH §6.5's exact alpha and collision lookup in the handler. Do the same for balloons. |
| C13 | Choice hover drawing | UI §4.5: `mix-blend-mode: difference` approximation. BA §3.8: exact ROP2 through an SVG `feComponentTransfer` filter | ROP semantics [U descript_balloon] | **BA §3.8.** Superseded [observed]: with a ROP blendmethod SSP 2.9 draws **only the pen** (outline and/or underline in the pen colour), with no fill and no raster operation, so neither the SVG filter nor `mix-blend-mode` is used. The resolution was "BA §3.8: exact ROP2 through an SVG filter, at the same cost". |
| C14 | Does blank text open a balloon? | SS §4.4: any character, spaces included. BA §3.11: only non-blank content | [B] `SPBalloonString::IsSpaceOnly`, `SPBalloonWnd::IsContentExist`. [C] 25 non-`\C` scripts (`ワンタッチメニュー表示２` and `…非表示`, the one-touch panel toggle) write only `\_l[0,0] ` (a single space) to scope 0. Under SS's rule, every panel toggle would pop up an empty balloon for 15 s (`q6.py`). | **BA §3.11:** a balloon opens on a glyph other than U+0020, U+3000 or TAB, or on an image, a marker or a choice. Blank glyphs still move the pen (and open a string, BA §3.3). Writing blanks into a balloon that is already open (the 206 `\C` cases) keeps it open. |
| C15 | Balloon kind at script start | SS §4.3: reset to 0. BA §1.2: reset to the descript default | [U] descript_ghost: `<scope>.balloon.defaultsurface`, then `balloon.defaultsurface`, then 0 | Reset each scope to that default unless the script starts with `\C`. For Tsubasa the default is 0. |
| C16 | Single left click on a finished balloon | BA §3.11: closes it (guess). UI §4.4: only raises it in the z-order | [H] the classic actions are double-click = break and right-click = switch side; nothing is documented for a single click | **It does not close the balloon.** A single click resumes `\x`, selects a choice or anchor, and raises the z-order. |
| C17 | OnSecondChange R1 (見切れ, "cut off") | EV §3.2: scope 0's rect is not fully inside the viewport. TS §6.1: its centre is outside | [U] OnOffscreen: the window overlaps the edge of the work area or lies outside it | **EV §3.2**, using scope 0's **base rectangle**, not the grown canvas (SH §3.5). The choice of rectangle is an ASSUMPTION. **Amended (EV §3.2.1):** ssp.exe 2.9.10 uses each character's **collision rect**, the box of its surface's drawn pixels (alpha > 8) shrunk to 80 % (under 50 px, joined with its animation patterns' boxes; SH §6.9), placed in its window and scaled, never mirrored; not inside the desk (edges inclusive) → R1 [disasm `CCharWndCodeManager::Check` 0x420ec5, `GetCollisionRectVirtual` 0x6faa90, `CreateBoundingBox` 0x5b5f80]. R2 uses the same rects for scopes 0 and 1 (strict intersection). Both are sampled on odd local seconds only, before the tick [disasm `OnTimerMain` 0x467d1d]; a hidden window or an empty box never counts. |
| C18 | Priority of `\![move]` and `\![set,scaling]` | SS §8 and SH §5.5: P0. TS §4: P1 ("seasonal and date scenes only") | [C] `\![move` appears in 32 **master** responses (Setsubun, moon viewing, snow, cherry blossom, autumn leaves, Christmas). These fire by calendar date in the default folder. Scaling appears in 3 master responses (`q7.py`). | The `\![move]` legacy positional form is **P0**. `\![set,scaling,-100,100]` is **P1** (a CSS mirror plus a mirrored hit test; cheap). |
| C19 | When save data is persisted | TS §11: at page hide. EV §1.5: after 200 responses and every 10 s. UI §9.5: on pagehide and every 30 s | WASM §7.3 (measured: 4–7 ms per save at 12–21 KB) | **WASM §7.3.** The worker calls `_satori_save`, compares the bytes, and writes IndexedDB itself. Debounce until ≥1 s idle. Save immediately after OnChoiceSelect, after replies that contain choices, and after user events. Back off adaptively when one save takes > 50 ms. A `pagehide` persist is best effort only. |
| C20 | SAORI bridge contract | TS §3.9 and the prototype's `js_saori.js` (now the `js_saori_*` EM_JS functions of `engines/satori/patches.py` and the stand-ins in `src/worker/saori/`): keyed by path, no `shiori_plugin.cpp` change | WASM §6.3 and P2. Verified: without the hunk, nothing reaches JS and `（dsaudio、…）` leaks into the balloon. | **WASM P2** (`load(path,dir)→handle`, `request(handle, bytes)`, `unload(handle)`). Stand-ins are looked up by lower-cased, ghost-relative path. |
| C21 | Engine load on navigation | EV §2.2: `load()` | WASM §7.4 and P3 | Use **`_satori_load_resume`**, which does not add 1 to `起動回数`. Tsubasa has 50th/100th/200th-boot talks. Then restore P6 and P7 (§2.1). |
| C22 | OnClose reply without `\-` | UI §2.6: close at script end anyway. EV §2.3: the ghost stays | [U] `\-` is what terminates the ghost. [S] Satori appends `\-` to every OnClose reply precisely so the ghost closes. | Close **only at `\-`**, or immediately when OnCloseAll and OnClose both return 204. This does not matter for Tsubasa. **Amended (EV §2.3, §2.7):** that holds for Close of one ghost while others stay (OnClose only, a plain PlayScript [disasm]). **Quit, and Close of the only ghost, close at the end of the close script, `\-` or not** (or when a newer run that replaced it ends [guess]) [disasm `PlayScriptWithMsg(…, 0x3A)`]. So does a Quit's goodbye replayed on the next page of the tab (the marker's `quit`, EV §2.7.3). Satori's OnClose replies end with `\-` anyway, so only an OnCloseAll reply without it shows the difference. |
| C23 | Wheel normalisation | EV §4.4: 40 px per line, 100 px per notch. UI §9.4: 3 lines per notch | Win32 default: 3 lines per notch | `deltaMode 0`: 100 px = 1 notch. `1`: 3 lines = 1 notch. `2`: 1 page = 1 notch. Accumulate, and emit R2 = ±120 per notch, positive = away from the user. |
| C24 | `\![bind]` with a non-numeric value | SH §4.3: treat it as 0 (guess). SS §5.2: empty or omitted = toggle | [U] bind: an empty or omitted value means toggle | Empty or omitted: toggle. Any other value besides `0`/`1`: **no-op, logged once**. The corpus cases are unexpanded harness variables. |
| C25 | Waiting for `\![raise]` replies | SS §5.7: always synchronous. TS §8: sync raises are fire-and-forget | [S] `satori_CreateResponce.cpp:111–136`: OnDirectSaoriCall always returns 204 | For `ID == OnDirectSaoriCall`: enqueue it (FIFO, `SecurityLevel: local`) and **continue immediately**. Other raises: wait for the reply; a non-empty reply replaces the run. This avoids a 0.6–1.4 s stall when `（sync,set,辞書フォルダ,…）` reloads the dictionaries. |
| C26 | Right-click menu trigger | CON §CharacterView: menu on any right click | UI §2.5, EV §4.2 (confirmed in ninix; SSP believed to match) | Right-button release: send OnMouseUp(R5=1). If that returns 204, send OnMouseClick(R5=1). Only if that also returns 204, open the menu. The EventLoop decides this, not `ui/menu.js`. **Amended (C31):** a right press that made a gesture step (4 px or more) gets neither OnMouseClick nor the menu [disasm OnEXRButtonUp 0x41ad03]. Not done: ssp.exe also skips both when the right OnMouseDown(R5 1) reply had a valid script [disasm 0x41a8ac–0x41a8c3] (EV §4.5.1). |
| C27 | "Talk" item in the runtime menu | ARCH `ui/menu.js`: has a Talk item | [R] MENU 102 has no communicate or talk item | **No Talk item.** Ghosts provide it themselves (Tsubasa: double-click, the `t`/`c`/`m` keys, the scope-99 panel). |
| C28 | Character position model | CON: `setPosition(x,y)` = top-left corner | SH §6.1, UI §3.2–3.3 (base point; SSP saves `Char<n>.ratio.x/y`) | Anchor and persist the **base point** (`defaultx/y`, default bottom-centre of the base rect) as viewport ratios. The top-left corner is derived per frame. |
| C29 | Menu caption lookup order | EV §5.1: legacy name, then new name. UI §2.1: new name, then legacy name | [U] both names are valid | Request both in one batch (300 ms cap, UI §2.1). A non-empty reply to the new name wins. Re-query every time the menu opens. |
| C30 | Order at choice-timeout expiry | EV §3.4: close, then send the event. UI and BA: send the event, then close if the reply is empty | The visible result is the same | Hide the balloons, GET `OnChoiceTimeout(R0 = script)`, and play a non-empty reply. |
| C31 | Mouse gestures | EV §4.3: "right or middle drag gestures", P2, never sent. UI §9.6: a two-finger swipe for the wheel | ssp.exe 2.9.10's disassembly (EV §4.5.1) [disasm] | **Right button only** (a pen's barrel too; never middle, nor a right double-click's 2nd press). A move of ≥ 4 px (Euclidean) from the last step's point is a step; the 4th step in a row in one 45° sector sends GET OnMouseGesture once (R5 the direction), all 8 sectors repeated → `circle.cw` / `circle.ccw`; release: OnMouseUp(R5 1), then `end` when a step happened, and then no OnMouseClick and no menu (amends C26). No OnMouseMove and no character drag while the right button is held. R1 / R3 window-local `x\x01y` (CSS px from the base rect [decision]), R2 / R4 collisions by shape, R6 the angle truncated. Touch [decision]: a long press on a spot with no named collision, then a move of ≥ 10 px, is a right drag, with SSP's wheel stand-in (an unanswered up / down: 3 × OnMouseWheel, then one per step). |

Some counts look different but are not contradictions; they use different denominators:
- `\*`: "1,419 of 2,708 choice scripts" (SS) vs "1,459 responses" (UI, BA);
- `\![*]`: 2,848 tags vs 349 responses;
- `\p[99]`: 5,595 tags vs 5,591 responses.

---

## 2. Gaps filled here

### 2.1 Satori's in-memory state across navigation (P0 for P6, P1 for P7)

**Problem.** A page load resets three things (EV §3.6, TS Q3):
- `talk_interval_count`, the random-talk countdown;
- `second_from_last_talk`;
- the load clock behind `（単純起動秒）` and `（起動時）`.

No doc gives the fix.

**Source facts [S].**
- At load (`satori_load_dict.h:56–58, 95–96, 135`): `talk_interval_count=0`, `sec_count_at_load = posix_get_current_sec()`, `sec_count_total = 0`, `second_from_last_talk = 0`.
- Assigning `＄喋り間隔`, which happens when the save data loads, sets `talk_interval_count` to interval ± random% (`satori_builtin.cpp:2203–2216`). So every page restarts the ~120 s countdown.
- The countdown only decreases on ticks that are idle, return an empty script and allow talk. Any reply that speaks resets it (`satori_EventOperation.cpp:498–560`).
- `ゴースト起動時間累計秒` is saved as `now − sec_count_at_load + sec_count_total` and reloaded into `sec_count_total` (`satori_load_unload.cpp:312–318, 393–398`).
- `satori_builtin.cpp:1458–1474` computes total = `now − at_load + total` and since-load = `now − at_load`.
- In `posix_utils.h`, `posix_get_current_sec()` returns `CLOCK_MONOTONIC` seconds, which in WASM is the worker's age.

**Patch P6: export the talk state (P0).** In `satori.h`, inside `class Satori`, next to P3's `EmSave`, under `#ifdef __EMSCRIPTEN__`:

```cpp
int  EmTalkCount() const        { return talk_interval_count; }
int  EmSinceLastTalk() const    { return second_from_last_talk; }
void EmSetTalkState(int count, int since) { if (talk_interval > 0) talk_interval_count = count; second_from_last_talk = since; }
```

In `SakuraDLLHost.cpp`, inside P3's `__EMSCRIPTEN__` block:

```cpp
extern "C" SATORI_EXPORT int  satori_get_talk_count(void)      { Satori* s=static_cast<Satori*>(SakuraDLLHost::I()); return s ? s->EmTalkCount() : 0; }
extern "C" SATORI_EXPORT int  satori_get_since_last_talk(void) { Satori* s=static_cast<Satori*>(SakuraDLLHost::I()); return s ? s->EmSinceLastTalk() : 0; }
extern "C" SATORI_EXPORT void satori_set_talk_state(int c, int since) { Satori* s=static_cast<Satori*>(SakuraDLLHost::I()); if (s) s->EmSetTalkState(c, since); }
```

Add the three functions to `EXPORTED_FUNCTIONS`.

What the runtime does with them:
1. After each `OnSecondChange` reply, the worker reads both values (no allocation needed) and stores `{talkCount, sinceLastTalk, at: Date.now()}` in the ghost state.
2. After `_satori_load_resume`, compute `away = floor((Date.now() − at)/1000)`.
3. Call `satori_set_talk_state(max(0, talkCount − away), sinceLastTalk + away)`.
4. Skip all of this on a cold boot.

**Patch P7: session clock (P1).** Done (`engines/satori/patches.py` section 7).

Goal: `（単純起動秒）` and `（起動時…）` count from **this ghost's last cold boot in this browser**, while `ゴースト起動時間累計` stays exact. (`（起動時）`, `（起動分）`, `（起動秒）` are that uptime split into hours, minutes and seconds, not a time of day; `satori_builtin.cpp:1255–1260`.)

Not from the session start (the tab's first page, `sessionEpochMs`): after a ghost change that would be wrong, since a ghost changed to at 10:00 in a tab opened at 09:00 must count from 10:00, as SSP starts the clock when that ghost loads.

The epoch, `bootEpochMs` (epoch ms):
- The runtime sets it to now at every cold boot (a new tab, a ghost change, a carried change, a relaunch from the launcher) and keeps it in the ghost's state (§2.5). A cold boot stores that state at once, before the engine loads, so a page left meanwhile never resumes an older boot's clock (or its run and timers). That write keeps the stored `closed` and `minimized` (the boot clears them): after a relaunch from the closed launcher, or a new tab of an iconified ghost, a page left before she boots (or an engine that fails) brings back that launcher, not a resume of the stage Close or Iconify saved hidden.
- A resume, a takeover by another tab and an engine restart after a crash reuse it. A state stored before P7 has none: the clock starts at that page.
- It travels as `init.bootEpochMs` → `engine.init(…, {bootEpochMs})` → `Module.bootEpochMs`, set before `load`.
- `sessionEpochMs` (the tab's first page, in the tab marker) is still what OnSecondChange R0 and `%exh` count from.

`posix_utils.h`: the POSIX branch of `posix_get_current_sec()` asks an EM_JS helper first (defined in `SakuraDLLHost.cpp`):

```cpp
extern "C" __attribute__((import_module("env"), import_name("em_boot_seconds"))) double em_boot_seconds(void);
{ const double s = em_boot_seconds(); if ( s >= 0 ) { return static_cast<unsigned long>(s); } }
// EM_JS(double, em_boot_seconds, (), { var e = Module['bootEpochMs']; if (!(e > 0)) return -1;
//        if (Module['emClockBaseMs'] === undefined) { Module['emClockBaseMs'] = Math.max(0, Date.now() - e);
//                                                     Module['emClockPerf0'] = performance.now(); }
//        return Math.floor((Module['emClockBaseMs'] + performance.now() - Module['emClockPerf0']) / 1000); });
```

Without `Module.bootEpochMs` it returns −1 and the `CLOCK_MONOTONIC` path (the worker's age) runs; `tests/satori_vs_dll.mjs` uses that path.

The clock reads the wall clock **once per worker** (its first call, in `load()`), then advances with `performance.now`. So within a page it is monotonic, like `GetTickCount64` on SSP, and ignores date changes: a visitor setting the date ahead to see a seasonal talk, then back, or an NTP or VM step. Each page load re-reads the wall clock, and the resume fold below re-bases on it.
- [decision] Between pages, since-load follows the wall clock: a date set ahead between two pages makes `（単純起動秒）` jump by that much on the next page, and a date set back makes it drop. It is not saved, and it heals when the date is set right. The total never sees it.
- An epoch in the future (the date set back past the cold boot) reads as 0 at the load: since-load counts from that page's load, and the total goes on from the save.
- Not done: returning `floor((Date.now() − bootEpochMs)/1000)` on every call. A date step within a page would then go into the saved total: 30 days ahead added 720 h to `（累計時）`, which Tsubasa's proposal gate reads (`（累計時）>200`), and a step back after a resume wrapped the total to about 4.29 × 10⁹ s [measured on a build that did so].

`satori_load_resume`, after a successful load, calls `Satori::EmResumeClock()`:

```cpp
sec_count_total -= sec_count_at_load;   // unsigned on purpose, see below
sec_count_at_load = 0;
```

The arithmetic (c = the clock in seconds since the epoch; A = `sec_count_at_load`, T = `sec_count_total`; `unsigned long`, 32 bits in WASM as on Windows; since-load = c − A, total = c − A + T, both in `var_uptime` and in the save):
- Cold boot: A = c(load) ≈ 0, T = the saved total. As on Windows.
- Resume at c_r with saved total S: `load()` sets A = c_r and T = S; the fold makes A = 0 and T = S − c_r (mod 2³²). Since-load = c, counted from the cold boot; total = S + (c − c_r), the save plus this page's time. When c_r > S, T wraps, and the sum wraps back to that value. That holds because c ≥ c_r: the clock is monotonic within a worker. A clock that stepped back below c_r would leave the total wrapped near 2³², and the save would keep it.
- A clamp `T > A ? T − A : 0` would be wrong: with S = T0 + (save − boot) and c_r = load − boot, a resume has c_r > S whenever the time between the last save and this load exceeds T0, the total from before this boot. The clamp would then make the total c, the time since the cold boot, dropping T0.
- Crash restart: the same as a resume, from the last save (the engine's variables come back from it too); since-load goes on.
- [decision] The total counts only time an engine ran. The gap between a page's last save and the next page's load (a few seconds per page; hours when the visitor was on another site and came back) is not added, though since-load counts it. Adding it would need the save time, and a stale state could then add days to a persisted counter (Tsubasa: affection per accumulated hour, `（累計時）>200` for the proposal).
- `（ＯＳ起動…）` read the same clock, so they are the ghost's age since its cold boot (≥ since-load, as on Windows), not the worker's age. OnSecondChange R0 stays the tab's age.
- A cold boot's since-load counts from its load; after the first resume it counts from `bootEpochMs`, taken just before the engine starts, so it steps forward once by the load time (about 1–3 s).
- Do not touch `posix_get_current_tick`; it is in ms and drives stroke and hold timing.
- A dictionary reload inside a request still resets since-load (A = c), exactly as on Windows.

Tests: `tests/engine_adapter.test.mjs` (the two "P7 clock" tests: the build under a fake `Date.now` and `performance.now`, with the date set ahead and back by 30 days within and between pages and an epoch in the future) and `tests/runtime/switch.test.mjs` ("P7 clock zero": which epoch each boot gets).

### 2.2 `\C` after an OnTranslate rewrite (P0)

**Problem.** Every GET script goes through `GET OnTranslate` (EV §4.12).
- In Tsubasa's nyan, pyon and blush modes, Satori returns the rewritten text **prefixed with its surface-restore string**, e.g. `\1\s[10]…` ([C] `res_tr_*.txt`).
- `surface_restore_string()` has no special case for `\C`, and nothing else in the source handles `\C` either ([S] `satori_tool.cpp:159–197`).
- So a `\C…` script arrives as `\1\s[10]\C…`. The corpus has 601 of them: panel toggles and game frames.
- A strict "`\C` must be the first token" rule (SS §4.3; [U] says "when written at the head") would then clear the balloon and make it flicker.

**Normative rule.**
- Treat `\C` as append when every token before it is a non-content tag: scope switches, `\s`, `\b`, `\![bind]`, `\![set,…]`, waits.
- Apply SS §4.3 step 3 at that point.
- Mark this UNVERIFIED, since SSP's own test is unknown, and log whenever the lenient path is taken.
- [disasm] ssp.exe's PlayScriptInternal compares only the script's first two characters with `\C`
  (0x63c883, play flag 0x30). The lenient rule stays for appending; the balloon and choice timeouts a `\C` script keeps
  follow SSP's own test (EV §3.4) [decision].

### 2.3 A bind turned off and on inside one script restarts the part (P0)

The rhythm game re-spawns an arrow with `\p[95]\![bind,L1,L1,0]\![bind,L1,L1,1]` in a single script (`左/下/上/右矢印追加`; [C] `q4.py`). The bind state is the same at the end of the script, but the **`bind+runonce` animation must restart**.

- Apply each bind tag immediately (SH §4.3): OFF calls `stop`, and ON calls `start(AUTO)` for `bind+X` animations.
- Batch only the **recomposition**, once per frame.
- Dress-up events: report both changes, in the EV §4.11 order (off, then on; the last one is GET), unless the script makes 100 or more changes.

### 2.4 Script-end pipeline (exact order) (P0)

No doc specified the order of the end-of-script effects. When `\e` executes or the tokens run out:

1. Set `run.state = finished`. Status loses `talking`; `choosing` follows the balloons (a `\q`/`\__q` item while a balloon is up, EV §1.6), not the run state: it was already there while the script played [disasm AddStatusText 0x639ad8–0x639b09].
1a. Stamp OnSurfaceRestore: it is pending from now (EV §3.4) [disasm DecodeProc 0x628d92]. A run that stops early (a break, a newer run) stamps too when it had shown something; the restore's own reply never does.
2. Release repaint locks and flush the paint.
3. A reply queued while the script played (OnShellChanged / OnBalloonChange after its `\![change,shell|balloon]`, EV §2.6 [guess]; then the replies a shell swap held, oldest first) goes through OnTranslate and **starts a new run**; stop here in that case.
3a. Send the queued dress-up events (EV §4.11): the net changes, all offs before all ons [disasm]; NOTIFY OnDressupChanged for all but the last change, GET for the last one (none at 100 or more changes), then GET OnNotifyDressupInfo. A non-empty reply goes through OnTranslate and **starts a new run**; stop here in that case. (Menu picks do not wait for the script's end: they are reported at once, R4 `user`.)
4. Otherwise, arm the post-script timer:
   - choice timeout (30 s), unless the script has `\*`;
   - otherwise the balloon timeout (15 s).

   The timer pauses while the pointer is over a balloon or the tab is hidden (DECISION); an open box does not pause it (EV §3.4) [disasm]. Passive mode arms nothing.
5. Start `yen-e` SERIKO animations (P1).

When the balloon timeout expires:
- hide the balloons;
- GET OnBalloonTimeout (R0 = script, R1 = "0").

Starting any new run cancels both timers. OnSurfaceRestore is not one of them (amended [disasm]): it does
not follow OnBalloonTimeout and no script or closed balloon cancels it. The 1-second tick sends it more than 30 s
(Timeout.Balloon + 15 s) after the stamp, at a local second of 10–50, and holds it, never drops it, while the ghost
cannot take it (EV §3.4).

### 2.5 Unified persisted state (P0)

SS §7, EV §2.2, UI §9.5, BA §7, SH §4.3 and TS §11 each list what to keep, but no schema existed.

| Store | Key | Written by / when | Content |
|---|---|---|---|
| IndexedDB | `ghost:<id>:files` | the worker, following the WASM §7.3 policy (C19) | bytes of `satori_savedata.txt`, plus `.sat` and `satori_savebackup.*` |
| localStorage (synchronous, survives `pagehide`) | `sumika:ghost:<id>:state` | the main thread: debounced 250 ms on every change, and synchronously on `pagehide` and `visibilitychange→hidden` | the JSON below |
| sessionStorage | `sumika.session` | the tab's first page, then the Site at each boot and set change (several ghosts) | `{booted:true, ghost:id, sessionEpochMs}`: the resume marker and OnSecondChange R0 (the P7 epoch is the ghost state's `bootEpochMs`, §2.1); since step 4 also `ghosts` (the ghosts this tab booted), `carry` (a call or change to finish, an event still owed) and `quit` (a Quit was saying goodbye), cleared when the site closes (CONTRACTS state.js, ghostset.js `markerRecord`) |
| sessionStorage | `sumika.lastInputMs` | every input | OnSecondChange R4, the idle seconds |
| localStorage | `sumika:runtime` | the main thread (the Site), at each start, on every set change and on a language pick | site-wide preferences: `{ghost, ghosts, rev, lang}`: the ghosts on screen in call order (`chooseSet`; `ghost` = the first, for older code), +1 on every set write, and the UI language (UI §2.10) |
| IndexedDB (same database `sumika` / `kv`) | `drop:<lower-cased path>`, `drop:index` | the main thread (`DropStore`, `src/core/drops.js`) on an OnFileDrop2 of playable audio; index updates under the Web Lock `sumika/drops` | the dropped files and their sizes and last use, shared by all ghosts (TS §3.4) |

The schema as the code writes it (`defaultState()` in `src/core/state.js`; `EventLoop._collect` in `src/core/events.js`
fills it before every write):

```jsonc
{ "v": 1, "savedAt": 0,                        // epoch ms
  "shell": "master", "balloon": "LightBlue",   // the shell id and balloon name in use
  "closed": false,                              // after \- : next load shows the launcher, then a cold boot (OnBoot)
  "minimized": null,                            // or {"reason":"user"|"script", "scopes":[0,1]} (scopes visible before)
  "stage": { "v": 1, "shell": "master",         // Stage.saveState()
             "scopes": { "0": { "surface": 0, "pos": {"rx": 0.86, "ry": 1.0}, "binds": [0,51,30], "visible": true,
                                "align": null, "scaling": [100,100], "alpha": 100 } } },
                                                // binds: ON bind-group ids (char100 picross: up to 900 ids)
  "balloons": { "0": { "kind": 0, "side": "left", "userOffset": [0,0], "alignOverride": null, "offsetOverride": null } },
                                                // Balloons.saveState(), per scope
  "ghostLife": { "passive": false, "induction": false },
  "timers": [ {"ev": "服着せ替えメニュー", "refs": [], "repeat": false, "intervalMs": 1, "dueAt": 0, "kind": "raise"} ],
  "run": { "src": "<post-OnTranslate script>", "ip": 0, "sub": 0, "state": "running|clickwait|blocked|finished",
           "hasChoices": true, "noChoiceTimeout": false, "origin": "OnMouseDoubleClick", "refs": [], "embeds": [],
           "base": null,                        // the run a \C script appended to (replayed first)
           "timeoutRemainingMs": 23000 },       // dropped when src > 512 KB (puyo frames); such a run is then lost
  "boxes": [ {"kind": "inputbox", "id": "ユーザ名", "args": [], "dueAt": 0} ],   // P1; dueAt 0 = no timeout; a
                                                // teach box adds "words" (its 311/312 round so far, UI §6.3)
  "engine": { "talkCount": 87, "sinceLastTalk": 33, "at": 0 },                // P6: the worker's `vol`, after every request
  "bootEpochMs": 0,                             // P7: this ghost's last cold boot (epoch ms); stored at once by a cold boot
  "clock": { "lastMinute": "2026-10-06T21:13" },
  "surfaceRestoreAt": 0,                        // epoch ms a pending OnSurfaceRestore counts from, 0 = none (EV §3.4)
  "vanished": 0 }                               // OnFirstBoot R0
```

The code stores the top-level `stage` and `balloons` objects above, not everything per scope in `scopes[n]`, and has no
`ghostLife.stayOnTop`, `zorder` or `sticky`; `Balloons` also reads a `scopes[n].balloon` state.

**Resume order** (extends EV §2.2):
1. Read the state. If `closed` is set, show only the launcher and stop.
2. Start the worker with the files; it reads the save data from IndexedDB itself.
3. Call `_satori_load_resume`.
4. Restore P6 and P7 (§2.1): the talk countdown from `engine`; the clock from `bootEpochMs` (set before the load, folded by `satori_load_resume`).
5. Create the Stage, and apply scopes, binds and positions **before the first paint**.
6. Send the NOTIFY batch: no OnBoot, OnNotifyDressupInfo as NOTIFY, OnSurfaceChange per visible scope.
7. Replay `run` (SS §7) and reopen the boxes.
8. Re-arm the timers; overdue one-shots fire now (C4).
9. Start the ticker.

**One engine per ghost.** Use `navigator.locks.request('sumika:'+id)`. Tabs that do not hold the lock show the ghost frozen, and take over when they become visible (UI §9.5).

### 2.6 Initial surfaces and extra-scope windows (P0)

[U] descript_ghost gives these defaults when the keys are absent:

| Key | Default |
|---|---|
| `sakura.seriko.defaultsurface` | **0** |
| `kero.seriko.defaultsurface` | **10** |
| `char*.seriko.defaultsurface` | **10** |

Tsubasa's ghost descript sets none of them. So at boot, scope 0 shows surface 0 and scope 1 shows surface 10, a 4×4 blank.

A `\p[n]` window:
- is created on its first reference, with surface 10 (blank for Tsubasa);
- becomes visible when a script sets a surface (SS §5.1, UI §3.6);
- takes x from `char<n>.defaultleft` (Tsubasa sets 300 for 14 scopes) and y from the alignment rule in UI §3.2.

### 2.7 Worker protocol deltas (P0)

ARCH's worker protocol needs these additions:
- `init.resume: boolean`, which selects `_satori_load_resume`;
- `init.sessionEpochMs` (P7; built as `init.bootEpochMs`, see below);
- `init.talkState` (P6);
- a `talk` message from the worker after each OnSecondChange: `{t:'talk', count, since}`;
- the WASM P2 `saoriBridge` object;
- `{t:'saori', name, cmd, args}`, used for dsaudio `finish`, after which the main thread sends `GET OnDSAPlayFinish` (P1).

Done, with these differences (ARCH "Worker protocol" describes the protocol as built):
- P6 travels as `init.volatile` (`{talkCount, sinceLastTalk, at}`), and there is no `talk` message: every `res` carries the current countdown as `vol`, which the main thread stores in the state's `engine`.
- P7 travels as `init.bootEpochMs`, the ghost's last cold boot from its state, not the tab's `sessionEpochMs` (§2.1). The worker passes it to `engine.init`, which sets `Module.bootEpochMs` before the load.
- The worker reads and writes the save files in IndexedDB itself (`init.storeNamespace`, `init.storeKey`), so `init` takes no persisted files.
- The page side of dsaudio (`src/core/page-saori.js`) plays the audio and sends `OnDSAPlayFinish` when it ends; the worker sends no `finish`.

Queueing rules:
- Requests to the engine stay FIFO.
- The main side coalesces ticks: skip a tick if the previous one is unanswered.
- At most one `OnMouseMove` is in flight.

Watchdog (WASM §10.3): warn at 2 s; at 30 s, terminate the worker, restart it, and resume from the persisted files.

### 2.8 Engine file set per page load (P0)

70 text files (3.75 MB, measured with `find`) go into MEMFS:

| Folder | Files |
|---|---|
| `ghost/master/*.txt` | 26, including `satori_conf.txt`, `replace*.txt`, `descript.txt` |
| `bath/` | 13 |
| `date/` | 14 |
| `meal/` | 13 |
| `mop/` | 1 |
| `saori/` | 3 (`yaya.txt`, `*.aym`) |

- Write them in NTFS order (WASM §7.1).
- They come from one packed file per ghost, `sumika/index/ghost.<id>.<hash>.pack.gz`, written by `tools/index_site.py` and read by `GhostFiles.bytes` before the server (`TextPack`, `src/core/loader.js`). After the first visit the pack comes from the HTTP cache. Done: this was planned as a P1 optimisation.
- No images and no DLLs go into MEMFS.

### 2.9 Contract updates required in `docs/CONTRACTS.md` / `ARCHITECTURE.md`

- **ScriptPlayer:**
  - choice timeout 30 s (C1);
  - `\t` rules (C7);
  - `PlayerHost.raise` must not wait for `OnDirectSaoriCall` (C25).
- **CharacterView `'mouse'`:**
  - add `dragstart` and `dragend`;
  - add `device` (R6: `mouse|touch|pen|eraser`);
  - keep raw wheel notches, accumulated into R2 ±120 (C23);
  - release order per C10 and C11;
  - position by base point (C28);
  - hit testing per C12.
- **Menu:**
  - right-click opens the menu only through the EventLoop rule (C26);
  - no Talk item (C27).
- **BalloonView:** needs a serialisable display list for replay and snapshots (SS §7, BA §8), and the visibility rule (C14).
- **Worker protocol:** the additions in §2.7.

Done: CON v2 carries these, except that it leaves the timeout values and the `\t` rules to the specs (and lists `device` without `eraser`). ARCH's worker protocol, storage keys and menu were brought in line with the code.

---

## 3. Consolidated P0 feature list (Tsubasa in a tab)

One line per item, with the section that specifies it.

**This list is not a progress tracker.** Its checkboxes were never ticked, and an unticked box does not mean the item is missing: Tsubasa runs in a tab and most of these items are implemented. For what is still open, see "Known gaps" in the project's `CLAUDE.md`.

### 3.1 Engine (Satori WASM + SAORI stand-ins)

- [ ] Build script follows WASM §9:
  - 26 translation units, `-DPOSIX -DSATORI_DLL -std=c++11`;
  - sources converted with Python's `cp932` codec;
  - `-iquote`, and no `_/Memory.h` (WASM §2–3).
- [ ] Link flags (WASM §4.2–4.3):
  - `-fwasm-exceptions` at compile and link time;
  - `MODULARIZE`, `STACK_SIZE=1MB`, `CASE_INSENSITIVE_FS=1`.
- [ ] Patch P1, the CP932 table (WASM §8 P1, §5.3). It is required for `－ ～ ＼` and for bind names to match the shell.
- [ ] Patch P2, the SAORI→JS bridge, **with** the `shiori_plugin.cpp` hunk (WASM §8 P2, C20).
- [ ] Patch P3, `satori_load_resume` and `satori_save` (WASM §8 P3, §7.4).
- [ ] Patch P4, silence stderr (WASM §8 P4).
- [ ] Patch P6, the talk-state exports (§2.1 here).
- [ ] ABI wrapper (WASM §6.1, §5.1):
  - buffers come from malloc;
  - re-read `HEAPU8` after every call;
  - always send `Charset: UTF-8`;
  - log ErrorLevel and ErrorDescription.
- [ ] Engine in a Web Worker, with a watchdog and a FIFO queue (WASM §10.3, §2.7 here).
- [ ] MEMFS layout in NTFS order, with all four dictionary folders (WASM §7.1, §2.8 here).
- [ ] Save pipeline: compare the save file after every request, including reload-inside-request and `手動セーブ` (WASM §7.2–7.3, C19).
- [ ] Dictionary-folder reload is tolerated (TS §8):
  - the request may take seconds;
  - SAORIs are unloaded and reloaded;
  - the save data is re-persisted afterwards.
- [ ] Stand-ins registered for `saori/dsaudio.dll`, `gomi.dll`, `fill_desktop.dll`, `httpc.dll` and `yaya.dll`. Each Version reply carries `Charset: UTF-8` (TS §3.1–3.2). Other ghosts' DLLs, from the ghost sweep (SW): `empty.dll`, `aya5.dll`, `mciaudior.dll` (its tracks' ends and loops raise OnMAAPlayFinish / OnMAAPlayLoop), `mciaudio.dll`, `time_check.dll`, `saori_cpuid.dll`, `sysio.dll`, `maho.dll` (`docs/research/ghost-sweep.md`). Not the numbered MCI players (`mciaudior2.dll` …): each is its own player, and the one music box would cut the first player's track.
- [ ] dsaudio stub (TS §3.4): accept every command and answer 200 without Value headers. `volume` with an empty argument returns the current value.
- [ ] Other stand-ins (TS §3.5–3.8):

  | Stand-in | Behaviour |
  |---|---|
  | gomi | `-n` → `Result: 0`, `Value0: 0` (also registered as `empty.dll`, the same Recycle Bin SAORI that ハヤト ships) |
  | httpc | empty Result |
  | fill_desktop | 200, no-op |
  | aya | `GETSTRBYTES` → Shift_JIS byte length |

- [ ] Node regression net against the corpus (WASM §10.2–10.3):
  - load=1 for all 4 folders;
  - status parity ≥ 98 %;
  - no new error strings;
  - no new unresolved `（…）`;
  - the same choice targets.

### 3.2 SHIORI host + event loop

- [ ] Request builder (EV §1.1–1.2, §1.6): `Charset: UTF-8`, `Sender: SSP`, `SenderType`, `SecurityLevel: local`, `Status` (omitted when idle), ID and References. Plus the response parser.
- [ ] cantalk formula (C6) and Status flags `talking/choosing/minimizing/timecritical/balloon(…)` (EV §1.6).
- [ ] Cold boot sequence (EV §2.1, §2.9): the NOTIFY batch, `OnNotifyDressupInfo`, `OnSurfaceChange`, and the OnFirstBoot→OnBoot chain.
- [ ] Resume sequence without OnBoot (EV §2.2 and §2.5 here).
- [ ] Ticker (EV §3.1–3.3, C17):
  - OnSecondChange on every wall-clock second;
  - OnMinuteChange when the minute changes;
  - GET or NOTIFY by cantalk;
  - R0–R4.
- [ ] OnTranslate for every GET script: R0 = script, R2 = source ID, R3 = source refs joined with `\x01` (EV §4.12).
- [ ] 204 fallback chains (EV §1.9):

  | First request | If it returns 204, send |
  |---|---|
  | OnFirstBoot | OnBoot |
  | OnCloseAll | OnClose |
  | OnChoiceSelectEx | OnChoiceSelect |
  | OnMouseUp | OnMouseClick |
  | OnUserInputCancel (timeout) | OnUserInput |

- [ ] Arbitration (SS §6.5, EV §1.5, C7):
  - replies to user events, raises and timers replace the current run;
  - ticks never do;
  - one FIFO queue, with generation stamps.
- [ ] Mouse (EV §4.1–4.5): Down/Up/Click/DoubleClick (R5 0/1/2), Move once per frame, Wheel ±120, DragStart/End. Sequences per C10 and C11.
- [ ] Middle click: Ex events plus the plain events with R5=2; Alt+left as a middle-click substitute (EV §4.2; TS §6.4 kiss reactions).
- [ ] OnKeyPress (EV §4.6, C8–C9):
  - SSP key names;
  - R1 = VK code;
  - **R2 starting at 1**;
  - R3 = scope;
  - R4 = modifiers;
  - the active-ghost rule;
  - `preventDefault`.
- [ ] Choice and anchor routing (EV §4.7, SS §5.6.2): `script:`, URLs, raising `On…` IDs, Ex then plain. Raw IDs keep their `\x01`.
- [ ] Input box events, including the timeout fallback, and communicate box events (EV §4.8).
- [ ] Dress-up events (EV §4.11, TS §7):
  - OnDressupChanged: off before on, the last one GET, skipped at 100 or more changes (settled [disasm]);
  - OnNotifyDressupInfo: scope-major, then categories in menu order, `default,mustselect,multiple` options, empty
    thumbnail field unless the file exists ([disasm]; was: ascending group id).
- [ ] NOTIFY OnSurfaceChange on every surface change: R0, R1, and R2 = `scope,id,w,h` (EV §4.11).
- [ ] Post-script timers and OnSurfaceRestore (EV §3.4, §2.4 here).
- [ ] timerraise timers with the C3 semantics, persisted (SS §6.6, C4).
- [ ] Close sequence (EV §2.3, C22):
  1. OnCloseAll, then OnClose (Close of one of several ghosts: OnClose only, EV §2.7);
  2. play the reply;
  3. at `\-` (Quit and the last Close: at the reply's end, `\-` or not): NOTIFY OnDestroy;
  4. unload the engine and persist;
  5. show the launcher (once the last ghost has finished its own unload, so every ghost is stored closed).
- [ ] Minimize and restore (EV §2.4, TS §6.6): OnWindowStateMinimize (play the reply, then hide), the launcher, OnWindowStateRestore.
- [ ] Resource GETs for the menu, batched and re-queried on every open (EV §5.1–5.4, UI §2.1).

### 3.3 SakuraScript player

- [ ] Tokenizer (SS §3, test vectors in §3.9):
  - escapes;
  - quoting on every argument;
  - `\]`;
  - Windows paths inside brackets;
  - digit forms;
  - unknown tags;
  - stray `\__q`.
- [ ] Scopes `\0 \1 \h \u \p[n]`, up to at least 101 (SS §5.1).
- [ ] Start, end, abort and break (SS §4.3), including `\C` with the lenient rule (§2.2 here) and the balloon-kind reset (C15).
- [ ] Virtual clock (SS §6.1):
  - 50 ms per character;
  - `\w`, `\w[N]` = N ms, `\_w`;
  - waits still apply inside `\_q`;
  - one paint per frame, with an 8 ms budget.
- [ ] `\x`, `\t`, `\*`, `\e`, `\-` (SS §5.5, §5.7).
- [ ] Shell and balloon tags (SS §5.2–5.4):
  - `\s` and `\s[-1]` go to the shell;
  - `\b` and `\b[-1]`;
  - text, `\n`, `\n[half]`, `\_n`, `\c`, `\c[char,n]`, `\_l`, `\_b`, `\![*]` and `\f[…]` go to the balloon.
- [ ] Choices `\q[t,id]`, `\q[t,OnX,r…]` and `\__q[id]…\__q` (SS §5.6).
- [ ] Event tags (SS §5.7, §5.2):
  - `\![raise]`: synchronous, except OnDirectSaoriCall (C25);
  - `\![timerraise]`;
  - `\![bind]`, applied immediately (§2.3 here).
- [ ] `\![move]` in the legacy positional form: blocking, parsed leniently. `\![set,alignmentondesktop|alignmenttodesktop]` (SS §5.2.1, C18).
- [ ] `\![open|close,inputbox]`, `\![open,communicatebox]`, `\![set,windowstate,minimize]` (SS §5.9).
- [ ] Every other tag in the corpus parses and silently does nothing (SS §8 item 10, TS §4).
- [ ] Fast-forward replay for resume (SS §7, C5).

### 3.4 Shell renderer

- [ ] Parse the 4 surfaces files, each with its own charset and syntax version, old-syntax waits ×10 ms, case-insensitive keys (SH §1.3–1.4, §2.1–2.6).
- [ ] Merge blocks; ID lists and ranges; resolve each surface lazily from shared blocks (SH §2.4–2.5).
- [ ] Pattern parsing (SH §2.9–2.10): `insert,0,0,ID`, sparse indices, and `-1` continues the sequence.
- [ ] Intervals (SH §2.11–2.12):
  - bind, runonce, always, sometimes, random, never;
  - `talk` with N=1 and no restart;
  - bind+runonce and bind+always;
  - the `exclusive` option.
- [ ] Images (SH §3.1–3.3): PNA masks (RGB or palette), colour key, black paint, `colorSpaceConversion:'none'`, an LRU cache.
- [ ] Base construction, including "element0 replaces the PNG" and surfaces with no image (SH §3.4).
- [ ] Composition (SH §3.5–3.6, §6.3):
  - methods overlay, add, reduce, interpolate, base, move, insert and alternativestart;
  - the canvas grows in every direction;
  - the origin stays fixed on screen.
- [ ] Dress-up state: category exclusivity, defaults, recomposition batched per frame (SH §4.3, §2.3 here).
- [ ] Animation scheduler (SH §6.4): the wait comes before each frame, the last frame persists, and AUTO triggers do not restart a running animation.
- [ ] Hit test (SH §6.5, §2.16, C12):
  - clip-path;
  - collisions, including animation collisions (`Mdatex`, `P1…P900`);
  - `sakura.cursor`.
- [ ] Character views per scope (UI §3.1–3.4, C28):
  - base-point anchoring;
  - the alignment chain (default bottom; `char99` free);
  - first-boot layout;
  - positions saved as ratios;
  - dragging;
  - reset position.
- [ ] Prefetch parts when a surface is shown; recompose at most once per rAF (SH §6.6).

### 3.5 Balloon

- [ ] LightBlue mapping through `install.txt` (already in the index), and the merge of per-image `*s.txt` files (BA §1.4–1.6).
- [ ] Image choice by scope, side and `\b`, with the p→k→s fallback; an odd id maps to its pair (BA §1.2).
- [ ] Colour-key transparency for balloon parts and every `\_b` image, RGBA ones included; `opaque` turns it off (BA §1.3, SS §5.3.2).
- [ ] Layout engine (BA §3.1–3.6):
  - the two coordinate spaces;
  - MS Gothic advance-width emulation;
  - LH = h+2;
  - segments and eager wrap;
  - all `\_l` forms;
  - inline and positioned `\_b`, `--clipping`, foreground/background.
- [ ] `\f`: color, bold, strike, shadow, height, default, cursorpencolor (BA §3.7).
- [ ] Choices: regions, hover per BA §3.8 (with a ROP blendmethod only the pen outline is drawn [observed]), pen outline (BA §3.8, C13). Superseded: "ROP2 hover through an SVG filter".
- [ ] Scrolling and scroll arrows (BA §3.9).
- [ ] Golden layout tests A–G pass (BA §3.10).
- [ ] Balloon lifecycle (BA §3.11):
  - the visibility rule (C14);
  - `\b[-1]`;
  - `\C` keeps the balloon open;
  - click-wait marker fallback;
  - timeouts, paused while hovering.
- [ ] Placement (BA §4, UI §4.1, §4.4):
  - offsets 2/14;
  - automatic side choice, flip and clamp;
  - extra scopes placed against their own window;
  - right-click toggles the side.
- [ ] Missing `\_b` files are never fetched; lookup is index-based and case-insensitive (SS §5.3.2).
- [ ] Performance (TS §9): one canvas per balloon for image-heavy frames; a 530 KB script lays out in ≤ 80 ms.

### 3.6 UI (menu, dialogs, launcher)

- [ ] Right-click menu, following C26 (UI §2.1–2.6, EV §5):
  - Recommend ▸ and Portal ▸ (lists separated by `\x01`/`\x02`, `-` = separator);
  - Utilities ▸ Reset position;
  - Iconify;
  - Close;
  - skin and colours from the shell descript;
  - `&X` accelerators.
- [ ] OnRecommendsiteChoice with R0–R5, plus `window.open` inside the click handler (UI §2.4).
- [ ] Input box (balloonc3) and communicate box (balloonc1) (BA §5, UI §6.1–6.4):
  - a real `<input>`;
  - Enter must not submit during IME composition;
  - timeout;
  - positioning;
  - several boxes may be open at once.
- [ ] Launcher for the minimized and closed states; restore and re-boot (UI §2.6).
- [ ] Shadow-DOM isolation, the layer stack, and `@font-face` declared at document level (UI §9.1–9.2, §9.8).

### 3.7 Persistence / resume

- [ ] State schema and write policy (§2.5 here).
- [ ] Engine files through the worker (C19), P6 talk state, resume load (C21).
- [ ] Resume order (§2.5 here), with run replay (C5) and timers (C4).
- [ ] Web Locks: one engine per ghost (UI §9.5).
- [ ] `closed` and `minimized` flags. First boot = no stored state and no engine files (EV §2.9).

### 3.8 Loader

- [ ] `ghosts.json` and `ghost.<id>.json` (both already produced by `tools/index_site.py`); case-insensitive `GhostFiles.resolve`; `\` becomes `/` (ARCH, SH §1.2).
- [ ] Text decoding: BOM, then a `charset,` line, then CP932 via `TextDecoder('shift_jis')` (SH §1.3, BA §1.5).
- [ ] Engine file list (§2.8 here) fetched in parallel (one text pack, §2.8); images fetched lazily (ARCH).
- [ ] Load the shell and the engine in parallel; never pre-compose all surfaces (UI §8.3).

---

## 4. Risks (ranked by likelihood × impact; 3 = high)

| Rank | Risk | L | I | Score | Mitigation |
|---|---|---|---|---|---|
| R1 | **The in-tree build lags the verified patch set.** `engines/satori/build.py` has no CP932 table, no `shiori_plugin.cpp` hunk (SAORI text leaks into the balloon), no resume (boot count drifts), an 8 MB stack, and no `-iquote`. | 3 | 3 | 9 | First implementation task: port WASM §8–9, plus P6, into `build.py`. Gate CI on the WASM §10.2 unit tests. **Done**: `build.py` and `patches.py` carry P1–P7 (1 MB stack, `-iquote`, no `Memory.h`), and `tests/satori_vs_dll.mjs` compares the build with the real DLL. P7 (session clock, §2.1) counts `（単純起動秒）` and `（起動時…）` from the ghost's last cold boot, across page loads. |
| R2 | **Satori latency in WASM breaks game loops.** Measured out of context: 169 requests took > 0.5 s, and puyo, Othello and bomb talks took 1.5–5.4 s (WASM §10.3, `scratch/wasmbuild/stack64.log`). Puyo re-arms an 80 ms timer. | 3 | 3 | 9 | Re-measure **in context**, with a realistic save file (12–21 KB, not the 4.8 MB corpus save) and with `-O2`/`-O3`. Use the watchdog, coalesce ticks, and never block the page. If it is still slow, profile Satori's string building and patch it. Accept a slower puyo if needed. |
| R3 | **Text layout differs from SSP.** Latin word-wrap is unknown, and 85 % of the displayed characters are ASCII. The line gap at h≠12 and the vertical alignment are also unknown. Menus and labels would be misaligned. | 3 | 2 | 6 | Golden tests (BA §3.10). One calibration session in SSP with `\![execute,dumpballoon]` (BA §11). Emulate MS Gothic advance widths whatever font is used. `ssp.map` has `IsNoWrapChar` and `ResetWrapState`, so SSP has *some* wrap logic: do not assume per-character wrapping until it is measured. **Settled [observed]:** SSP word-wraps Latin text (BA §3.5) and draws only the pen for ROP choice hover (BA §3.8). From its code: leading `\n` count, and a relative `\_l` before the first string starts from the origin (BA §3.3). The line gap at h≠12 and the vertical alignment are still unknown (BA §11). |
| R4 | **Continuity gaps on navigation:** lost runs and timers, the countdown reset, up to 1 s of save lag, throttling of hidden tabs. | 3 | 2 | 6 | §2.1, §2.5, C4, C5. Save immediately after choice events. Send NOTIFY ticks while hidden. |
| R5 | **Unverified SSP event semantics:** R2 base, drag/Up order, dress-up timing (the order is settled [disasm], EV §4.11), cantalk while choosing or while a box is open (settled [disasm], C6), timer delivery during `\t`. | 2 | 3 | 6 | One session on SSP 2.9.08f with a request-logging SHIORI settles about 15 of these (§5). Until then, use the §1 resolutions. |
| R6 | **Wrong outfit or composition.** The shell has 3,885 bind groups, nested inserts, 192k definitions and PNA black paint. Ikagaka had a "Tsubasa in underwear" bug. | 2 | 3 | 6 | Use the SH reference compositor's renders as golden images. Make `\![execute,dumpsurface]` goldens in SSP. Test the boot outfit produced by her OnBoot binds. |
| R7 | **Bind names fail to match.** If Satori's output and the shell's `descript.txt` are decoded differently (U+FF5E vs U+301C style), binds silently do nothing. | 2 | 3 | 6 | The P1 table and the WHATWG decoder agree on all 11,340 double-byte codes (WASM §5.3). Add a test: every `\![bind,cat,part]` in the corpus resolves to a group, except `指輪２` and harness junk (TS §4). |
| R8 | **Two tabs run two engines** and overwrite each other's save data. | 2 | 3 | 6 | Web Locks, with a BroadcastChannel fallback (UI §9.5). |
| R9 | **Memory on mobile.** 923 PNG + 756 PNA decode to about 240 MB; the WASM heap is 16–70 MB. | 2 | 2 | 4 | Lazy decoding, an LRU cache of 64–128 MB, and prefetching only the current surface's parts (SH §3.1, §6.6). |
| R10 | **Large scripts and payloads:** a 530 KB script with 25,839 tags; OnNotifyDressupInfo at about 120–200 KB per picross click. | 2 | 2 | 4 | A linear tokenizer, one paint per frame, a canvas balloon for image frames, and caching the encoded dress-up string (SS §2, TS §7, §9). |
| R11 | **Engine version mismatch.** Mc203-6 vs her Mc159-6: wait lengths and wait placement differ. | 3 | 1 | 3 | Accept it. Use the corpus as a regression net only. Optionally build a same-version corpus with the official Mc203-6 DLL. |
| R12 | **Host-page interference:** transformed ancestors break `position:fixed`; page click handlers; `@font-face` inside a shadow root; popup blockers; autoplay. | 2 | 1 | 2 | UI §9.1–9.2: host element as the last child of `<html>`, `:host{all:initial}`, document-level fonts, open URLs inside the click handler, retry audio on a user gesture. |
| R13 | Storage unavailable (private mode, quota). | 1 | 2 | 2 | The Store falls back to memory and shows a visible warning (ARCH `core/storage.js`). |

---

## 5. Verification backlog (needs SSP 2.9.08f)

One session with a request-logging SHIORI (or SSP's script log), plus `dumpsurface`/`dumpballoon`, settles the following.

| Area | Items (doc refs) |
|---|---|
| Event semantics | OnKeyPress R2 base (C8); release order after a drag (C10); right-click menu suppression (UI Q1); timing of script dress-up events (SSP's lazy blocks; the off/on order, the ≥ 100 skip and OnNotifyDressupInfo's order are settled from ssp.exe's disassembly, EV §4.11 [disasm]; still worth one look with a request logger, EV Q8); cantalk while choosing, while a box is open, while minimized (C6: settled from ssp.exe 2.9.10 [disasm]: a `\x` or choice wait and minimized make the tick NOTIFY, a box does not); timerraise during `\t` (C7); OnChoiceEnter as GET or NOTIFY; whether `\![close,inputbox]` is silent |
| Script semantics | `\w[N]` (SS Q2); `\b[1]` and whether `\b[-1]` re-shows (SS Q3, BA Q5–6); `\C` after a timeout and after a prefix (§2.2); which balloons `\x` clears; blank-only balloons (C14) |
| Balloon pixels | Line gap at h≠12, valign, shadow, scroll step, input-box position (BA §11). Settled [observed]: Latin wrap (SSP word-wraps, BA §3.5) and the ROP pen (only the pen is drawn, BA §3.8). |
| Shell pixels | PNA black paint on surface 9486; insert edge cases; mirror pivot; collision edges (SH §8) |
| Settings defaults | The default of "Disable timeout when cursor is in balloon" (UI Q5) |
| Mouse gestures (C31, EV §4.5.1; from the disassembly only) | bonsyou: right-drag left then right across the bell and release: it rings once (then 連続では鳴らせません until its OnSoundStop, which Sumika sends, EV §4.17); emily4: right-drag left or right across her skirt lifts it; a right wiggle of 4 px or more opens no menu; a middle drag sends OnMouseMove as before. Touch [decision]: on a phone, a long press on a body spot then a swipe is a gesture (it used to move the character; a plain drag still does), so a named collision such as emily4's skirt cannot be gestured by touch; or any long press then a move, with a two-finger drag to move her as SSP does |
| Several ghosts (EV §2.7, EV §7 Q9, UI §2.12, §3.5, §9.7) | Cheapest first: (1) Call ghost ▸ with two ghosts running: own ghost ✓ and greyed, the other running ghost greyed without ✓; in passive mode still clickable, and does the call happen? [disasm, tentative] (2) Change ghost ▸: the running ghost ✓ and clickable, and does picking it reload the ghost? [disasm] (3) a ghost called for the first time: its first-boot talk, not its "called" talk? [disasm] Where it stands is **required and open**: in ssp.exe it did not stand on top of the caller, with no clear pattern [observed], while Sumika puts a ghost never met on the caller at its own default place, as the disassembly reads ssp.exe; that SSP restored each ghost's stored places is [infer] until the Reset-shell-position check of UI §3.5 #2 (Reset on Tsubasa, call emily4, Reset on emily4) (4) does the caller's OnGhostCalling talk overlap the callee's boot talk; does a script go on after its `\![call,ghost,X]`; two calls in one script: both come? [disasm; guess] (5) two ghosts' random talks overlap freely; which balloon is on top; does a clicked ghost come above the other's balloon; can ghost B cover ghost A's communicate box? [infer] (6) Close on one of two: only it goes, the other comments; its OnClose without `\-` keeps it; Quit: both say goodbye at once and both come back; an OnCloseAll / OnClose without `\-` on Quit still closes; a click during Quit's goodbye: its reply plays, then the ghost closes? [disasm; guess] (7) Quit while one ghost is iconified: answered by the disassembly (EV §2.3): no goodbye shows, but its OnCloseAll / OnClose are sent (the reply dropped) [disasm]; check: minimize machimaki, Quit, start again: no "ended abnormally" talk in ssp.exe nor Sumika (8) Ghost(2) settings: the defaults of "喋る時に手前に出て来る" / "喋り終わると裏へ沈む" [?] (9) Iconify one of two: only it, with its own tray icon? [disasm] (10) click one ghost, press a key: only it answers; after a call, do keys go to the new ghost without a click? [infer; disasm ActivateAllWindow] (11) a minimized or passive ghost: does it get OnOtherGhostBooted / OnOtherGhostClosed / OnGhostCallComplete? [guess] (12) `\![call,ghost,X]` for a ghost already on screen: nothing? [disasm] (13) OnOtherGhostTalk (ruusa, hgr or kanade_2nd): does the listener's reply cut its talk; is a talk a click replaced reported with `break`? [infer; guess] (14) Tsubasa + Hayato: does her `→` greeting reach him as a conversation (OnCommunicate; not implemented yet)? |

## 6. Choices between alternatives

- `basewareversion`: Sumika claims `SSP` (Satori needs `Sender: SSP` anyway), not `sumika` (EV Q3).
- "Close" on a website: once the ghosts have closed, a launcher re-boots them with OnBoot (UI Q10).
- Hidden tabs: NOTIFY ticks with R3=0, not paused ticks (UI §9.5).
- `\![updatebymyself]` does nothing; emulating OnUpdateBegin → OnUpdateComplete("none") (TS §10.3, P1) is the
  alternative.
- `\![set,wallpaper]` is a no-op, not the page backdrop (P2).
- Mc203-6, not the master branch compiled to match her bundled Mc159-6 (WASM §11). An exact-version corpus would need
  the official Mc203-6 DLL (WASM §11).
- Music playback (P1, TS §3.4) and open input boxes (P1, §2.5) are persisted and resumed after navigation.

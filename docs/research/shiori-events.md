# SHIORI/3.0 protocol and the SSP event sequence: spec for the Sumika event loop

Status: research spec v1. Readers: implementers of `src/core/shiori.js`, `src/core/events.js`,
`src/sakura/player.js`, `src/ui/menu.js`, `src/worker/saori/*`.

## Legend

* Priority: **P0** = Tsubasa needs it. **P1** = common in other ghosts, or polish for Tsubasa.
  **P2** = rare or later. **n/a** = the browser has no equivalent, so the runtime never sends it. It is listed only so that
  nobody wonders.
* **ASSUMPTION** = not documented anywhere found. Behaviour Sumika picked; verify against real SSP when possible.
  **DECISION** = deliberate browser-specific deviation from SSP.
* Evidence tags:
  * **[U-spec]** UKADOC `manual/spec_shiori3.html`. **[U-ev]** `manual/list_shiori_event.html#<ID>`.
    **[U-res]** `manual/list_shiori_resource.html#<ID>`. **[U-ss]** `manual/list_sakura_script.html`.
    **[U-help]** `ukadoc/ssphelp/config-talk.html` and `config-ghost.html` (SSP settings help).
  * **[S file:func]** Satori source, `vendor/satoriya-shiori/satoriya/satori/` (Shift_JIS; UTF-8 copies are in
    `docs/research/scratch/src_*.u8`).
  * **[SD path]** satori-docs, `github.com/ukatech/satori-docs` (for example `shiori/events.md`).
  * **[L n]** A real SSP **2.02.15** request log from 2010, found in the AYA log
    `github.com/ikutoo/ssp32_ghost_juhua/blob/master/ayame.log`. `n` = line in the UTF-8 copy
    `docs/research/scratch/ayame_u8.log`. The log is old and covers a SHIORI reload, not a cold boot. It is still the
    only full request trace found, and the best evidence for ordering.
  * **[B]** UTF-16 string literals in the SSP 2.9.08f binary (`ssp_2_9_08f/ssp.exe`, read
    only). The full dump is in `docs/research/scratch/ssp_strings.txt`. MSVC places a function's literals in reverse order
    of use, which was used to infer some orderings. Those orderings are marked as inferred.
  * **[C]** Corpus: real `satori.dll` responses for the translated ghost (`final_{master,bath,date,meal}.res.txt`,
    7,334 `VALUE` lines in total). Counts were made with `docs/research/scratch/{cmds,choices,onrefs,misc}.py`.
  * **[T file:line]** Tsubasa dictionaries in `site/ghost/tsubasa/ghost/master/` (CP932). The inventory scripts are
    `scratch/inv.py` and `scratch/evdefs.py`, and the output is `scratch/entries.txt` and `scratch/evdefs_master.txt`.
  * **[I]** Ikagaka prior art: `Ikagaka/NanikaDefaultEventDefinition` and `Ikagaka/ghost-kernel-default-plugins.js`.
  * Not in the repository: the copies, dumps and scripts in `docs/research/scratch/` (`scratch/` below), the corpus
    (`tests/corpus/`) and Tsubasa's dictionaries (`site/ghost/tsubasa/`: CLAUDE.md "The ghosts Sumika was tested with").
    These are development material, cited as the sources (CLAUDE.md "Project rules").
  * The sections on shells, balloons and the dress-up menu (§2.6, §4.11, §4.13, §5) use these tags:
    **[disasm]** read from ssp.exe 2.9.08f's disassembly with its shipped symbol map (`ssp.map`): control flow
    reliable, field meanings inferred; **[doc]** UKADOC (= [U-ev] / [U-ss]); **[corpus]** counted in a corpus of 320
    ghost archives; **[infer]** inferred from code or docs, not observed; **[guess]** the most plausible pick where
    nothing settles it (not compared with ssp.exe); **[decision]** a deliberate browser deviation or product choice.
    Nothing tagged so has been compared with ssp.exe yet. **[observed]** = seen in a running ssp.exe (or, where said,
    in Sumika). Tooltips and choice hover (§4.3, §4.7, §5.2, UI §4.8) use the same tags, plus **[win32]**: documented
    behaviour of the Windows tooltip control (initial delay, hiding on a press), not re-read in the binary.
  * Ghosts interacting (§2.7.7–§2.7.9 and the rows that point there) use the same tags. Their [disasm]
    addresses are those of ssp.exe **2.9.9.3000**, the reference build for those sections [decision]. Older sections
    cite 2.9.08f's addresses; every function compared between the two builds was instruction-identical
    (SendCommunicate, SPCommunicateData::Send, CommunicateSSTP, SPGhost::Loop, MakeShiori30Request, SendEvent,
    ExecuteRaiseReal) [disasm]. **[src]** = Satori's source as above.

---

## 0. The findings that matter most

1. **Send `Sender: SSP` and an accurate `Status` header.** Satori reads `Status` only when `Sender` is exactly `SSP`
   [S satori_AnalyzeRequest.cpp:request, `mIsStatusHeaderExist`]. It uses the `talking`, `induction`, `passive` and
   `timecritical` flags to suppress "petting" (なでられ) reactions during a talk, and `talking` for the mouse-hold logic
   [S satori_EventOperation.cpp]. In a POSIX/WASM build there is no fallback.
2. **Send `SecurityLevel: local`.** Satori runs `OnDirectSaoriCall` only for local requests
   [S satori_CreateResponce.cpp]. Tsubasa emits `\![raise,OnDirectSaoriCall,set,…]` 801 times [C] through Satori's
   `（sync,…）`. Without `local`, her variables silently stop updating.
3. **The engine never sees the browser.** Everything Satori knows comes from References. Tsubasa reads `（サーフェス0）`
   207 times [T], and that value is filled only by `NOTIFY OnSurfaceChange` [S EventOperation]. Her dress-up flags, which
   drive the 猫耳 and うさ耳 speech modes in `OnTranslate`, are filled only by `OnDressupChanged` and
   `OnNotifyDressupInfo` [T dic16_Dressup.txt:834, 4062]. Both events are **P0**.
4. **The random-talk clock is `OnSecondChange.Reference3`.** Satori counts down `＄喋り間隔` (Tsubasa: 120 s ± 10%,
   user-selectable 30–300 s [T satori_conf.txt, dic01_Boot.txt:1707]). It also fires `＄…タイマ` timers, but only on
   ticks with `Reference3 != 0` that produced no other script [S EventOperation]. SSP sends the tick as `NOTIFY` with
   `Reference3=0` while it cannot talk [U-ev OnSecondChange; L 990, 4137].
5. **Every script returned by a `GET` event goes through `GET OnTranslate`** before it plays [U-ev OnTranslate; L 4083,
   4691, 5399]. Tsubasa defines `＊OnTranslate` (blush, nyan and pyon modes) [T dic11_etc.txt:1140], and the corpus
   harness confirms that it rewrites scripts [C res_tr_*.txt]. **P0.**
6. **The 204 fallback chains are baseware logic, not Satori logic.** `OnFirstBoot`→`OnBoot`, `OnGhostChanged`→`OnBoot`,
   `OnGhostCalled`→`OnBoot`, `OnCloseAll`→`OnClose`, `OnChoiceSelectEx`→`OnChoiceSelect`, `OnAnchorSelectEx`→`OnAnchorSelect`,
   `OnMouseUp`→`OnMouseClick`, and `OnUserInputCancel(timeout)`→`OnUserInput(R1="timeout")`. Tsubasa's typing game
   depends on the last one [T `＊タイプ答えを教えてもらった`].
7. **Choice IDs are opaque byte strings.** Satori rewrites `\q[label,id]` into `\q[label,id\x01label\x01n]` and splits
   the ID again when it comes back [S satoriTranslate.cpp, satori_AnalyzeRequest.cpp]. 418 corpus lines contain `\x01`
   [C]. IDs that start with `On` are raised as events with the extra arguments as References: 1,094 such choices [C],
   for example `\q[…,On再生リスト移動,１]`.
8. **`\![raise]`, `\![timerraise]` and choice IDs may name events that do not start with `On`.** Examples:
   `\![raise,天気予報情報取得開始２]` and 45 distinct `\![timerraise,…]` targets [C]. Satori answers such IDs by expanding
   the talk of that name [S CreateResponse: `Call(mRequestID)`]. The runtime must send them as ordinary `GET` events.
   A raised event that returns 204 lets the current script continue. One that returns 200 replaces the current script.
9. **Mouse numbers matter.** Tsubasa's wheel reaction needs `|Reference2| > 115`, so send ±120 per notch [T
   dic13_Game.txt:7341]. Her right and middle-click features read `OnMouseClick.Reference5` = 0, 1 or 2 [T
   dic14_Mouse.txt:2961]. Petting needs about 60 `OnMouseMove` events within 2 s on the same collision. Satori's defaults
   are `＄なでられ反応回数`=60 and `＄なでられ持続秒数`=2 [S satori_load_dict.h]. Hold-to-close uses `OnMouseDown`/`OnMouseUp`
   on the menu character `\p[99]` [T dic14_Mouse.txt:2947–2958].
10. **Page navigation resets in-memory Satori state.** This includes the random-talk countdown (`talk_interval_count`),
    petting counters and `（単純起動秒）`. If a user navigates more often than every `喋り間隔`, Tsubasa never talks on her
    own. A small engine patch (open question Q1) or an accepted limitation is needed. Saved variables and `＄…タイマ`
    timers survive, because they are in the save file [S satori_load_unload.cpp].

---

## 1. Wire protocol

### 1.1 Request (P0)

```
<METHOD> SHIORI/3.0<CRLF>
Charset: UTF-8<CRLF>
Sender: SSP<CRLF>
SenderType: internal<CRLF>                 (P1, see 1.7)
SecurityLevel: local<CRLF>
Status: talking,balloon(0=0)<CRLF>         (omit the line when there are no flags, see 1.6)
ID: <event or resource id><CRLF>
BaseID: <base event><CRLF>                 (only for events listed in 1.9)
Reference0: <value><CRLF>
Reference1: <value><CRLF>
...
<CRLF>
```

| Item | Rule | Source |
|---|---|---|
| Method | `GET` when a value is expected, `NOTIFY` when the value is ignored. The same ID can arrive with either method, for example `OnSecondChange` and `OnDressupChanged`. | [U-spec request] |
| Line ends | Always CRLF. The request ends with an empty line (CRLF CRLF). | [U-spec] |
| Encoding | UTF-8 bytes plus `Charset: UTF-8`. Satori decodes the request with the declared charset and answers in the same charset [S SakuraDLLHost.cpp:request_bytes]. | [U-spec], [S] |
| Header syntax | `Name: value`, with exactly one colon and one space. Satori splits on the first `": "` [S SakuraDLLHost::request, `cut_token(value, L": ")`]. | [S] |
| Header order | Satori ignores it. Keep `Charset` first, as [U-spec] recommends, and keep `SecurityLevel` before `ID`. ssp.exe's builder writes Charset, SecurityLevel, SecurityOrigin, Sender, SenderType, Status, ID, BaseID, References, then any extra lines (OnCommunicate's Age, Marker, Surface) [disasm MakeShiori30Request 0x7081A0, 0x7082EA; the same in 2.9.08f]. (The order read earlier from [B] literals put Sender second.) | [U-spec], [disasm] |
| Values | Any Unicode except CR and LF. Replace CR/LF in a value with a space. `src/core/shiori.js:clean()` already does this. Bytes `\x01` and `\x02` are legal and common, as separators inside a Reference, and must pass through unchanged. | [U-ev] |
| References | `Reference<n>`, decimal n starting at 0, with no upper limit. Gaps are allowed, for example `OnBoot` sends R0, R6 and R7. Satori treats every missing index up to the highest one as `""` [S AnalyzeRequest: `mReferences.resize`] and pads the counts it reads for some events [S EventOperation:required_reference_count]. | [U-ev], [S] |
| Unknown headers | Satori stores every header in `mRequestMap`, and dictionaries cannot read most of them. Sending extras is harmless. | [S] |

`SecurityOrigin`: ssp.exe sends `SecurityOrigin: null` on every SHIORI/3 request of its own, local events included
[disasm MakeShiori30Request 0x7082EA], not only on SSTP ones. Satori ignores it [S]. **Sumika's SHIORI/3 requests do not
carry it**; it belongs in `shiori.js`'s base headers, in SSP's order, and needs the YAYA comparison and both sweeps
again, since YAYA ghosts can read any header.

Legacy probe (P2): SSP first sends `GET Version SHIORI/2.6` + `Charset` + `Sender`, then `GET SHIORI/3.0 ID: version`
[L 33, 43] (also seen by `zenn.dev/kinzal/scraps/58b90331191d38`). Satori answers both with 200 [S AnalyzeRequest].
**DECISION:** the page skips the 2.6 probe: Satori, YAYA and Kawari 8 are known to speak 3.0, and for Kawari 7 the
worker's SHIORI/2 bridge sends ssp.exe's `GET Version SHIORI/2.6` handshake itself (kawari7-wasm.md §6.2).

### 1.2 Response

```
SHIORI/3.0 200 OK<CRLF>
Charset: UTF-8<CRLF>
Sender: <engine name><CRLF>
Value: <script or text><CRLF>
<other headers><CRLF>
<CRLF>
```

Parsing (P0): match the status line against `^SHIORI/(\d+\.\d+)\s+(\d{3})\b(.*)$`. Header lines follow until the first
empty line. Split each at the first `:` and drop **one** optional following space. Header names are case-insensitive.
If a header appears twice, keep the first. The current `parseResponse()` splits on `": "`. That works for Satori, but
it should also accept `Name:value` from other engines (P1).

| Status | Meaning [U-spec] | Runtime handling |
|---|---|---|
| 200 OK | Success. `Value` present. | Use `Value`. **If `Value` is missing or empty, treat as 204.** |
| 204 No Content | Success, nothing to return. | No script or text. Apply fallback chains (1.9) and defaults (5.2). |
| 311 Not Enough, 312 Advice | Only for `OnTeach` (TEACH box): 311 = ask the user for one more word and send OnTeach again with it added to the references; 312 = drop the newest reference first [doc spec_shiori3]. | Implemented (UI §6.3): the teach box opens again; a Value with either plays [guess]. Ignore otherwise. |
| 400 Bad Request | Request could not be parsed. Satori returns it for an unknown protocol [S AnalyzeRequest]. | Log `warn` with the request ID. Treat as 204. |
| 500 Internal Server Error | Error inside the SHIORI. Satori also maps its internal 403 to the text "500 Internal Server Error" [S SakuraDLLHost.cpp switch]. | Log `error`. Treat as 204. **Never** retry automatically. |
| other | | 2xx: treat like 200. Others: like 500. |

Response headers:

| Header | P | Handling |
|---|---|---|
| `Value` | P0 | Event: SakuraScript, see 1.5. Resource: plain text. NOTIFY: ignore the value. |
| `Charset` | P0 | The worker already decoded the bytes. Ignore. |
| `Sender` | P2 | Engine name. Log only. |
| `ErrorLevel`, `ErrorDescription` | P1 | `\x01`-separated parallel lists. Levels are `info`, `notice`, `warning`, `error` and `critical`. Log each pair to the console and the dev overlay. Satori sends them only after `capability` has listed `response.errorlevel` [S CreateResponse capability; SD shiori/protocol.md]. |
| `BalloonOffset` | P2 | Balloon offset for this script. Satori writes `<off0>\x01<off1>` (one `x,y` per scope, ASSUMPTION about the inner format) [S EventOperation end]. Tsubasa does not use it [T]. |
| `Marker` | P2 | Text for the balloon marker area. |
| `SecurityLevel` | P2 | `external`: play this script with external restrictions. |
| `ValueNotify` | P2 | Not advertised in `capability`, so engines must not send it. Ignore. |
| `To`, `Reference0…`, `Age`, `MarkerSend`, `HWnd` / `TargetHWnd`, `Sentence` | P1 | COMMUNICATE: the script goes on to the ghost they name when it has played (§2.7.7; implemented). Read on every response but the NOTIFY batch, `otherghostname` and resource strings. Satori sets `To` and `Reference0` for a talk whose first line starts with `→`, `Reference0` alone for `＄Value0` [S]. |
| `X-SSTP-PassThru-*` | n/a | SSTP only. |

### 1.3 What Satori actually reads from a request

| Request part | Satori behaviour | Source |
|---|---|---|
| `ID` | Starts with `On`: event, or a word group if one with that name exists. `version`/`craftman`/`craftmanw`/`name`: built-in. `*.recommendsites`/`sakura.portalsites`: site list. Anything else: `（ID）` expansion of a talk, word or variable. Unknown: 204. | [S CreateResponse], [SD shiori/protocol.md] |
| method | Only `NOTIFY hwnd` and `NOTIFY capability` are special-cased. **Every other NOTIFY is executed exactly like a GET**, so dictionary side effects (variables) happen. The baseware discards the value. | [S CreateResponse] |
| `Sender` | `SSP` enables reading `Status`. `embryo` enables Materia quirks. | [S AnalyzeRequest] |
| `Status` | Substrings `talking`, `induction`, `passive` and `timecritical`. | [S EventOperation] |
| `SecurityLevel` | `local` (case-insensitive) gives full rights: `OnDirectSaoriCall`, SAORI `set`, debug IDs. `external` gives local rights only for prefixes listed in `＄外部から実行可能なイベントの接頭辞`. | [S AnalyzeRequest, CreateResponse] |
| `Charset` | Decides how the bytes are decoded and which charset the reply uses. | [S SakuraDLLHost] |
| References | `（Ｒn）`, plus hard-coded indexes for OnSecondChange/OnMinuteChange (R1–R3), OnSurfaceChange (R0,R1), OnMouseMove/Wheel (R3,R4), OnMouseDown (R3–R5), OnChoice* (R0/R1 `\x01` split), OnRecommendsiteChoice (R1,R3,R4), OnCommunicate (R0,R1), OnUpdateReady (R0). | [S EventOperation], [S AnalyzeRequest] |
| `BaseID`, `SenderType`, `SecurityOrigin` | Ignored. | [S] |

### 1.4 The three kinds of request

| Kind | Method | Value is | OnTranslate? | Played? |
|---|---|---|---|---|
| **Script event**: any `On…` ID that may talk, plus any custom ID raised by a script (`\![raise]`, `\![timerraise]`, a choice) | GET | SakuraScript | yes | yes |
| **Notify event**: the `[NOTIFY]` IDs in [U-ev], plus script events sent while the ghost cannot talk | NOTIFY | ignored | no | no |
| **Resource**: menu captions and visibility, site lists, `username`, `tooltip`, … ([U-res]) | GET | plain short text, sometimes `\x01`/`\x02` lists | no | no |

A fourth, smaller kind: **words** for the `%ms`-style variables of a script being expanded (`%ms %mz %ml %mc %mh %mt
%me %mp %m? %dms`): `GET` with ID = the type, backslash included (`\ms`), no References, the defaults of a fresh
SPShioriEvent (`SenderType: internal`, `SecurityLevel: local`); a SHIORI/2.x ghost gets `GET Word SHIORI/2.0` /
`Type: \ms`. The word is the reply's Value, else Word, for 200, 311 and 312; never a COMMUNICATE, never played or
translated on its own; `\m?` unanswered is asked again as `\m`, then SSP's word list fills in [disasm
`SPGhost::GetWord` 0x63FA00, `SPShiori::GetWord` 0x70CBB0]. Sumika: `EventLoop.word` (kind `word`), properties.md
§2.4.

### 1.5 Response pipeline for script events (P0)

```js
// events.js: one path for every GET script event.
async function fireScriptEvent(id, refs, {senderType = 'internal', baseId, origin = 'system', interrupt = true} = {}) {
  const sentAtGeneration = player.generation;          // increases every time a script starts
  const res = await shiori.request({method: 'GET', id, refs, headers: hdrs({senderType, baseId})});
  logErrors(res);
  let script = (res.status === 200 && res.value) ? res.value : null;
  if (!script) return {status: res.status, played: false};             // the caller applies fallbacks
  // Clock and timer responses must not stomp on a script that started while they were in flight.
  if (origin === 'clock' && player.generation !== sentAtGeneration) return {status: 200, played: false};
  script = expandEnvVars(script);                          // %username, %month ... (properties.md §2)
  script = await translate(script, id, refs, {senderType}); // 4.12; expanded again when OnTranslate changed it
  applyResponseHeaders(res);                                // BalloonOffset, Marker (P2)
  player.play(script, {event: id, refs, replace: interrupt});
  return {status: 200, played: true};
}
```

Rules:

* **Script replacement** (P0, matches SSP's observable behaviour): a new script from a GET event replaces the one
  playing. The old script stops at once. Its pending `\![bind]` changes still send their dress-up events (4.11).
  A clock tick never interrupts, because ticks are NOTIFY while talking (3.2). A user-initiated GET (mouse, key, choice,
  input box, menu) and a raised or timer-raised event that returns a script do interrupt.
* While a `\t` time-critical section plays, **do not send mouse events or key events** at all [U-ss `\t`]. Timer and
  raise events are still delivered (ASSUMPTION).
* Serialize all requests FIFO through one queue, as `ShioriClient` already does. **Coalesce clock ticks**: if the
  previous `OnSecondChange` has not been answered yet, skip this tick (no catch-up).
* Replies play in the order they arrived, which is the order their events were sent. The stage after a reply
  (expand, OnTranslate, play) runs through one chain per ghost (`EventLoop._inOrder`): a reply whose
  `%username` asks `GET username` puts that request behind events sent meanwhile, and without the chain a newer
  reply would play first and the older one replace it. ssp.exe's Loop takes its queued scripts oldest first, so the
  newest is left playing [infer].
* After every request that returned 200, and at least every 10 s otherwise, debounce a `persist` so that variables
  survive navigation. This is not per request, because `OnMouseMove` arrives at about 60 Hz.

### 1.6 `Status` header and "can talk" (P0)

Flags, comma-joined in this order (order taken from SSP 2.9.08's own description string "talking, choosing, minimizing,
changing, induction, passive, timecritical, nouserbreak, online, opening(...), balloon(...)" [B 0x7bc674], which matches
[U-spec Status] plus `changing`; verified in the code, every flag and its condition [disasm 2.9.10
AddStatusText 0x639a90–0x639eab]: each piece is added as `flag,`, and the last comma is dropped only when something was
added; induction, passive and timecritical are one slot, below):

| Flag | Set while | P |
|---|---|---|
| `talking` | A script is playing: from its first token until `\e` or its end, **including** `\x` click waits and `\w` waits. Not set while a finished balloon merely remains on screen ([L 4741]: GET without Status right after a talk). | P0 |
| `choosing` | Some balloon holds a `\q` or `\__q` item and some balloon is visible: `(GetSelectModeAll() & 0x10000) && IsBalloonVisible()` [disasm 2.9.10 AddStatusText 0x639aa8, 0x639ad8–0x639b09]. GetSelectModeAll 0x649540 ORs the content flags (+0x99c) of every character's balloon, hidden or not; IsBalloonVisible 0x63e240 is true when any is visible. Bit 0x10000 comes from `\q` (AddSelectableString 0x5cdc08–0x5cdc1c) and `\__q` (AddAnchorOrSelectable 0x5ce044, called with the anchor flag 0 from the `\__q` branch 0x62bc18–0x62bca9); a `\_a` anchor sets 0x20000 instead (0x5ce032), so anchors alone never count; ClearString 0x5cc988 drops the flags, UpdateFlags 0x5cc710 recomputes them [disasm]. Neither the run state nor the choice wait (+0x14bc) is read: it shows while the script still plays (`talking,choosing`), after its end while the menu is up, and in the pick's own OnChoiceEnter / OnChoiceSelectEx / OnChoiceSelect, since ChoiceSelect closes the balloon only after the event was handed on and nothing played (CMessageWnd::ChoiceSelect 0x470dc3–0x470e41, BalloonClose 0x470e26–0x470e3c) [infer: the request is built on the event thread]. Sumika: `Balloons#choosing` (a view's `hasChoices`: a link of kind `choice`; `\c[char|line,…]` keeps the links); before, the finished run's live choices (`choicesLive`, set at the run's end and cleared at a pick before its requests). Not yet as ssp.exe: OnChoiceTimeout and OnBalloonTimeout, which ssp.exe sends before it closes the balloon (DoWaiting 0x5d1d8c–0x5d1e5d), go out after Sumika hid it (SUMMARY C30), so without `choosing` and `balloon(…)`. | P0 |
| `minimizing` | The ghost is hidden through minimize (2.4). | P1 |
| `changing` | A **shell** change (2.6): SSP's SPGhost+0x41a4, the only field AddStatusText reads for it [disasm 2.9.10 0x639b32]. Set right after OnShellChanging is sent (OnChangeMessage 0x4978c5, a 204 too), so its reply's talk carries it, and that reply's OnTranslate too [infer: SSP's Loop thread translates the queued script after the main thread set the flag]; and at a swap's start, after the lazy binds' report (ChangeOrReloadShellInternal: ProcessLazyCommandExec 0x623120, then 0x623125), which is how a script's `\![change,shell]` and ReloadShell (0x620a51) get it. Cleared right after OnShellChanged's request (0x623466 → 0x623490), before PopSurfaceStatus (a 204's restored surfaces, 0x62349d) and before the reply's OnTranslate; and when the shell is missing (0x6230e5, 0x623113). So the swap's NOTIFYs (OnNotifySelfInfo through SendMessage 0x623322, the bind info through 0x62333c), the shell load's menu-skin resource GETs (GetStringShiori builds Status too) and OnShellChanged itself carry it [disasm]. A cancelled OnShellChanging talk (a balloon break, a newer script) never posts the change (Loop 0x63baa7–0x63bab8) and nothing else clears the flag, so ssp.exe keeps `changing` (and NOTIFY ticks, below) until its next shell change; Sumika clears it at the cancel [decision]. Never a ghost change: OnChangeMessage's ghost case (0x4971d5–0x4974c3) and OnSSPSysMsgGhostChange (0x46be40) write no field AddStatusText reads; nor a balloon change (ChangeOrReloadBalloonInternal 0x622da0) [disasm]. Sumika: the loop's `_shellFlag` (earlier Sumika sent `changing` during a ghost change and never during a shell change). | P1 |
| `induction`, `passive` | One value, SPGhost+0x41a8: `\![enter,inductionmode]` sets 1, `\![enter,passivemode]` 2, and `\![leave,inductionmode]` / `\![leave,passivemode]` both set 0 (ExecuteExclamationTag 0x62f43a, 0x62f484; 0x630513, 0x63055d), as does Utilities ▸ Reset passive mode (OnMenuLeavepassive 0x49dd12, which also resets `\t`: ResetNoInterruptFlag 0x49dd1f). So entering one mode leaves the other, leaving either leaves both, and Status shows `induction` (value 1) or `passive` (any other non-zero value), never both (0x639b5b–0x639ba2); IsLocked 0x6447c0 reads the field the same way [disasm 2.9.10]. Sumika: `ghostLife.passive` / `.induction`, never both true (`_setLifeMode`; before, two independent flags, so `induction,passive` could go out); its Reset passive mode leaves `\t` alone. | P2 (Tsubasa: none [C]) |
| `timecritical` | Inside a `\t` section of the playing script (IsNoInterrupt 0x6446c0), and only when neither induction nor passive mode is on: it is tested only when +0x41a8 is 0 (0x639ba4–0x639bc2) [disasm 2.9.10]. 569 Tsubasa scripts use `\t` [C]. Sumika as ssp.exe (before, `passive,timecritical` was possible). | P0 |
| `nouserbreak` | SPGhost+0x41ac: 1 at `\![enter,nouserbreakmode]`, 0 at its leave (ExecuteExclamationTag 0x62f44e, 0x630527) and when Loop takes the next script from the queue (0x63b540, right after `talking` is set at 0x63b3c4); nothing clears it at a script's end, so it stays after `\e` until the next script [disasm 2.9.10]. Sumika: `ScriptPlayer#noUserBreak` (the last run's `\![enter,nouserbreakmode]`, ended or not); never sent before. | P2 |
| `online` | Character 0's balloon IsReallyOnline 0x5d16a0 (0x639bf7–0x639c29): its online count is above 0; `\![enter,onlinemode]` adds 1 and its leave removes 1 (0x62f45d–0x62f475, 0x630536–0x63054e), and so does SSP's own network work (HTTP requests that show the marker, ping, nslookup, headlines, POP, SNTP, updates) [disasm 2.9.10]. Sumika has no online state and never sends it. | n/a |
| `opening(communicate/input/teach/textarea/dialog)` | Those boxes are open. `/`-joined kinds, for example `opening(input)`. ssp.exe lists them in this fixed order, whatever opened first [disasm 2.9.10 AddStatusText 0x639c5b–0x639d25: bits 0x2, 0x8, 0x4, 0x20, 0x8000 of SPGhost+0x4198]. `dialog` is a script's own common dialog, `\![open,dialog,…]` (open, save, folder, color) [disasm ExecuteCommonDialogThread 0x639eb0 → SPGhostDlgHWndManager::Add 0x64ba76]. Header only: no box makes a tick NOTIFY (below). Sumika sends `communicate`, `input` and `teach`, in the order they opened. | P1 |
| `balloon(0=0/1=0)` | Balloons visible, as `scope=balloonId` `/`-joined (`\b[n]` kind). | P1 |

When no flag applies, **omit the header**. In [L], idle requests carry no `Status` line, and the SSP description says
"Empty means idle" [B].

```js
cantalk = !(talking || choosing || minimized || passive || induction || timecritical || document.hidden || !booted)
```

* Talking or choosing: [L 4137, 4613]. During a displayed choice menu SSP 2.02 sent `NOTIFY OnSecondChange` with
  `Status: talking` and `Reference3: 0`.
* Minimized, passive, induction: ASSUMPTION. SSP has a "don't talk while minimized" option [U-help config-ghost]. A
  hidden ghost never gets random talk.
* `document.hidden`: **DECISION**. Satori then holds due timers and random talk until the tab is visible again. Do not
  add `minimizing` to Status for this.
* An open input, communicate, teach or textarea box does **not** clear cantalk [disasm ssp.exe 2.9.10]:
  CreateInputBox 0x49b020 ends with UpdateInputMode(0x8000, the OR of the open boxes' kind bits & 0x802e) at
  0x49b26c–0x49b27a, and CInputWndBackground::PostNcDestroy recomputes the bits when one closes (0x4616bc–0x4616ca);
  UpdateInputMode 0x63e620 only sets SPGhost+0x4198, and the whole disassembly reads that field only in AddStatusText
  (0x639c2e–0x639d25), the Status builder (its callers build request headers only). So a box shows as `opening(…)`
  and changes nothing else. Sumika does as ssp.exe [decision: follow SSP] (an earlier SUMMARY C6 DECISION made it
  cantalk 0). Teach boxes the same.
* What makes a tick NOTIFY in ssp.exe 2.9.10 [disasm]: SPGhost::OnTimeChange 0x641de0 sets notify when one of these
  SPGhost fields is set (0x641e03–0x641e50), or when its caller says so (0x641e52): minimized +0x419c
  (ToggleMinimize), a shell change +0x41a4 (set right after OnShellChanging is sent, 0x4978c5;
  ChangeOrReloadShellInternal, ReloadShell; cleared right after OnShellChanged's request, 0x623490; the same field is
  Status `changing`, 1.6), passive or induction +0x41a8 (ExecuteExclamationTag, OnMenuLeavepassive),
  a `\x` or choice wait +0x14bc (SetWaitingChoice, SetWaitingXTag), `\t` (IsNoInterrupt 0x6446c0: +0x14c4 & 0xffff),
  a script playing +0x41b8 (SPGhost::Loop, BreakScript), an SSTP quiet count +0x41bc > 0 (SSTP ProcExecute; one less
  per tick, 0x49850e), SSF playing +0x41c0 (CPlaySSFData). OnSecondChange goes out with it (0x641e76), then
  OnMinuteChange when the minute changed (0x641e94); R3 = !notify (NotifyTimeChangeEvent 0x641d31), so R3 and the method always agree.
  CSakuraWnd::TimerExec 0x497dc0 tests the same fields (0x497e37–0x497e8a, then OnTimeChange(…, 1) at 0x4984fc;
  0x497fc6–0x49801d, then OnTimeChange(…, 0) at 0x49803f / 0x498158). No box, dialog or balloon state is among them.
  A ghost that is loading or being deleted (+0x4860 / +0x4864) gets no tick at all (0x641de7–0x641dfd). Sumika has
  no SSTP or SSF; `document.hidden` and closing are its own terms (above, below).
* SSP's own dialogs (Other percentage… CScalingDlg, About CAboutDlg, those built on CDlgCustom) are modal through
  CWnd::RunModalLoop (called at 0x42f7e9), which peeks with no window filter (PeekMessageW at 0xaf5a2e). The main
  timer (SetTimer id 1, 1000 ms, StartMainTimer 0x4666a7; CMainFrame::OnTimer 0x467176 → OnTimerMain → TimerExec per
  ghost at 0x467e03) has no dialog check, and those dialogs set none of the fields above and no `opening` bit. So
  Sumika's Preferences box, About / readme / Terms windows and the Other percentage… box leave cantalk alone [disasm;
  that MFC's message pump dispatches WM_TIMER: infer from its documented behaviour].
* A ghost change (the loop's `changing`, no Status flag; §2.5) and a shell swap (`swapping`, §2.6) count as closing:
  cantalk 0 [infer for the swap: SSP swaps synchronously, so nothing talks before OnShellChanged].

### 1.7 `SenderType` (P1, ignored by Satori)

Comma-joined [U-spec]. Use `internal` for everything the runtime generates (clock, mouse, keys, menu, boot). Use
`internal,raise` for `\![raise]`, `\![timerraise]`, `\![notify]` and On-ID choices and anchors (ASSUMPTION for the
latter two). Use `internal,embed` for `\![embed]`, `internal,property` for `\![get,property]`'s event [disasm 0x62E223]
(properties.md §3; implemented). `OnTranslate` copies the SenderType and SecurityLevel of the event
that produced the script [U-spec]. Never send `external`, `sstp`, `plugin`, `sakuraapi` or `communicate`, with these
exceptions, as ssp.exe: OnCommunicate from another ghost carries `external,sstp,communicate`
[disasm CommunicateSSTP 0x709FE0] (§2.7.7); an event another ghost raises (`\![raiseother]`, `\![notifyother]`)
carries `internal` with `Sender: <the raiser's sakura name>`, not `internal,raise` [disasm 0x633810–0x633864]; the
raiser's OnRaiseOtherFailure / OnNotifyOtherFailure carries `internal,raise` (§2.7.9). Still never `plugin` or
`sakuraapi`.

### 1.8 `capability` (P1)

Send `NOTIFY capability` once per load, before the first GET event. One feature per Reference, header names lower-case
[U-ev capability]. Advertise only what Sumika implements:

```
Reference0: request.status
Reference1: request.securitylevel
Reference2: request.baseid
Reference3: request.sendertype
Reference4: response.errorlevel
Reference5: response.errordescription
Reference6: response.marker            (only once Marker is rendered)
Reference7: response.balloonoffset     (only once implemented)
```

SSP 2.9.08 advertises, in usage order inferred from [B]: request.status, request.securitylevel, request.baseid,
request.sendertype, request.x-sstp-passthru, response.marker, response.markersend, response.errorlevel,
response.errordescription, response.balloonoffset, response.age, response.x-sstp-passthru, response.valuenotify,
response.securitylevel, response.requestcharset. SSP 2.02 sent a subset in the same relative order [L 106–119].
Satori looks only for `response.errorlevel`.

### 1.9 Fallback chains and `BaseID` (P0 for the chains, P2 for the header)

| First request | If it returns 204, send | BaseID on the first request | Source |
|---|---|---|---|
| `OnFirstBoot` | `OnBoot` | `OnBoot` | [U-ev], [U-spec sample] |
| `OnGhostChanged` | `OnBoot` | `OnBoot` (ASSUMPTION) | [U-ev] |
| `OnGhostCalled` | `OnBoot` (OnGhostChanged is not tried) | `OnGhostChanged,OnBoot` [disasm] | [U-ev]; 2.7.1 |
| `OnGhostCalling` | nothing | `OnGhostChanging` [disasm] | [U-ev]; 2.7.1 |
| `OnVanished` | `OnBoot` (not when it came from OnOtherGhostVanished) | `OnBoot` (ASSUMPTION) | [U-ev] |
| `OnBasewareUpdated` | `OnBoot` | n/a | [U-ev] |
| `OnCloseAll` | `OnClose` | `OnClose` (ASSUMPTION) | [U-ev] |
| `OnGhostChanging` | `OnClose` [R0 `user` alone] (2.5) [disasm 2.9.10 0x497343] | none, SenderType `internal` [disasm 2.9.10 0x4972c1; Sumika matches it] | [U-ev] |
| `OnChoiceSelectEx` | `OnChoiceSelect` | | [U-ss `\q`] |
| `OnAnchorSelectEx` | `OnAnchorSelect` | | [U-ev] |
| `OnMouseUp` | `OnMouseClick` (same refs) | | [U-ev OnMouseClick] |
| `OnMouseUpEx` | `OnMouseClickEx` | | [U-ev] |
| `OnMouseMultipleClick` | normal click/double-click handling | | [U-ev] |
| `OnUserInputCancel` with R1=`timeout` | `OnUserInput` [R0 id, R1 `"timeout"`] | | [U-ev], [U-ss inputbox] |
| `OnMusicPlayEx` | `OnMusicPlay` | | [U-ev] |
| `OnFileDrop2` | `OnMediaPlayerOpen`, … | | [U-ev] (P2) |

The fallback request carries the same References unless noted. Satori also aliases some event names internally
(OnBoot→起動, OnFirstBoot→初回→OnBoot→起動, …) [S satori_sentence.cpp:FindEventTalk]. That is independent of the
baseware chain.

---

## 2. Lifecycle sequences

### 2.1 Cold boot (P0)

Used when this browser has no stored profile for the ghost, or the ghost was closed by the user, or this tab never booted
it (`sessionStorage['sumika.session']` absent; see ARCHITECTURE "Page navigation").

Order: the relative order of items 4–20 follows [L 58–953] (SSP 2.02, reload) and Ikagaka's port of it [I
notify_information.js]. Items marked † are newer than the log and their position is ASSUMPTION. **Satori does not depend
on this order.** Only items 3, 6, 15, 17, 18, 22 and 23 have engine-visible effects for Tsubasa.

| # | Request | Refs (browser values) | P |
|---|---|---|---|
| 1 | worker `init` → `load("/ghost/master/")` (not a protocol request) | | P0 |
| 2 | ~~`GET Version SHIORI/2.6`~~ | DECISION: skip | P2 |
| 3 | `GET version` | none. Log the value (Satori version). | P1 |
| 4 | `NOTIFY OnInitialize` | R0 `""`; `reload` at `\![reload,shiori]` (NotifyInitialEvents(false, true) [disasm 2.9.10 0x621b00]; §2.10). [L 58] also showed R1 `1`, meaning undocumented: omit. | P1 |
| 5 | `NOTIFY ownerghostname` | R0 the scope-0 name in effect (`SPSeriko::GetCharName(0)`: `sakura.name`, a shell's override; Tsubasa: `Tsubasa`), not the descript `name` [disasm 2.9.10 0x70df20–0x70df32]. A SHIORI/2.x engine gets `NOTIFY OwnerGhostName SHIORI/2.3` with `Ghost:` (kawari7-wasm.md §6) | P1 |
| 6 | `NOTIFY basewareversion` | R0 version, R1 baseware name, R2 detailed version. See Q3. Recommended: `2.09.08`, `SSP`, `2.9.8.0` ([L 95–97] format for 2.2.15 was `2.02.15`/`SSP`/`2.2.15.3000`). | P1 |
| 7 | `NOTIFY capability` | see 1.8 | P1 |
| 8 | `NOTIFY OnNotifyOSInfo` | R0 `system,version,display name`, R1 `cpu,MHz,extra`, R2 `physKB,virtKB`, R3 minutes since "system boot". Browser: `Browser,<UA major>,<UA brand>` / `unknown,0,` / from `navigator.deviceMemory` / session minutes. | P2 |
| 9 | `NOTIFY OnNotifyFontInfo` | R* font names. Browser cannot enumerate: send none, or a fixed list of CSS generic families. | P2 |
| 10† | `NOTIFY OnNotifyInternationalInfo` | R0 `new Date().getTimezoneOffset()` (JST gives `-540`, the same sign convention [U-ev]), R1 DST `1`/`0`, R2 country (region of `navigator.language`), R3 language | P2 |
| 10a† | `NOTIFY OnLanguageChange` (**implemented**) | the UI language in effect (UI §2.10): R0 language name (`Japanese` / `English`), R1 language id (`1041` / `1033`), R2 `""`, R3 `""` (see §4.13). "起動直後に通知される場合は必ずNOTIFY" [U-ev]; sent on every boot and resume and after an engine restart, right after `capability` [ASSUMPTION: its place in SSP's order is unknown] | P1 |
| 11 | `NOTIFY OnNotifySelfInfo` | R0 ghost name, R1 / R2 the sakura / kero names **in effect** (the ghost's `sakura.name` / `kero.name`, replaced by the current shell descript's `sakura.name` / `sakuraname`, `kero.name` / `keroname` [disasm `SetCurrentShellIndex` 0x641DE0, `SPSeriko::GetCharName` 0x6F11B0]). Any value counts, `none` too: nothing compares it, so roommate's shells (`sakura.name,none`, `kero.name,none`) make her `none` in ssp.exe as well [disasm `SPShellProp::ParseSingleEntry` 0x619060, `SPSeriko::LoadDescript` 0x6E57F0]. The ghost descript's `name.allowoverride` does not stop it in 2.9.9: `SPSeriko::LoadDescript` reads the key (`stricmp`, so the whole key in any case: roommate's and Hayato's `name.allowoverrid` is no key; default 1 [disasm ctor 0x6E29B3, Release 0x6E50C7]) and gates only the shell's `sakura.name2` and `sakura.friend.name` with it [disasm 0x6E59A7–0x6E59B9, 0x6E5B35, 0x6E5BF9]; UKADOC's "0 = the shell's names are not used" is not what this build does), R3 the shell's descript **name** (never its folder: Hayato's `master` is named `kinzon_mey` [disasm]), R4 shell path, R5 balloon name, R6 balloon path. Paths: see "Paths" below. Sent again after a shell or balloon change (§2.6). | P1 |
| 12† | `NOTIFY OnNotifyBalloonInfo` | R0 balloon name, R1 path, R2 `0:0,1,2 1:0,1` (scope `:` comma-list of balloon surface ids, space between scopes). Not sent, at boot or after a change [decision, P2] | P2 |
| 13† | `NOTIFY OnNotifyShellInfo` | R0 shell name, R1 path, R2 comma-list of all surface ids. Sent after a shell change (§2.6), not at boot [disasm: SSP sends it with OnNotifySelfInfo after a switch] | P2 |
| 14 | `GET name`, `GET craftman`, `GET craftmanw` (and `GET useorigin1`) [L 395–457] | none. Log only. | P2 |
| 15 | `NOTIFY OnNotifyUserInfo` (**implemented**) | R0 nickname, R1 full name, R2 birthday `yyyy,mm,dd` **zero-padded** (`2003,05,05`; `""` without one) [disasm 0x70F440], R3 `male`/`female`/`undef`. From the visitor's Preferences box (UI §2.13). ssp.exe sends it at every SHIORI load right before `otherghostname` [disasm 0x621B66]; Sumika too, but **only once the visitor has saved the box** [decision]: §4.16 | P1 |
| 16 | `NOTIFY otherghostname` (**implemented**) | one Ref per other ghost on screen that counts as up: `<sakura name in effect>\x01<scope 0 surface>\x01<scope 1 surface>` (−1 for a scope that shows none [infer]). Alone: **no References**. Sent again whenever a ghost comes, goes, changes or changes its shell (§2.7.5) [doc; disasm `NotifyOtherGhost`]. Satori derives `（起動しているゴースト数）` (Tsubasa ×2) and `（隣で起動しているゴースト）` (the alphabetically first other sakura name) from it [S satori_builtin.cpp:var_ghost_count]. | P1 |
| 17 | `NOTIFY ghostpathlist`, `balloonpathlist`, `headlinepathlist`, `pluginpathlist`, `calendarskinpathlist`, `calendarpluginpathlist` | one path each | P2 |
| 18 | `NOTIFY installedsakuraname`†, `installedkeroname`†, `installedghostname`, `installedballoonname`, `installedshellname`, `installedheadlinename`, `installedplugin` | R* lists. sakura/kero/ghost lists are index-aligned and come before `installedghostname` [U-ev]. From `ghosts.json`, in the site index's order: Change ghost ▸'s (by descript name, ties by folder; UI §2.1 #12 [observed]), and `installedballoonname` the ghosts' bundled balloons in that order, then the site's [infer: that ssp.exe sends its menu's order is not traced]. Shells: this ghost's shell descript names in the index's (Shell ▸ menu) order, hidden ones included [disasm `NotifyInstalledShell`]; Satori's `（導入済みシェル「名前」の存在）` reads names. Headline and plugin lists are empty. | P1 |
| 19 | `NOTIFY OnNotifyDressupInfo` | all bind groups, 4.11 | **P0** |
| 20 | `NOTIFY uniqueid` | R0 random id persisted per ghost, for example `sumika_<16 hex>` | P2 |
| 21 | `NOTIFY hwnd` | R0 `\x01`-joined fake window handles per scope (decimal, e.g. `1000\x011001\x011099`), R1 balloon handles likewise. **Tsubasa's `＊hwnd` passes R0 to `（dsaudio,hwnd,…）`** [T dic11_etc.txt:16473], so the dsaudio stand-in must accept it. | P1 |
| 22† | `NOTIFY OnDisplayChange` | R0 `screen.colorDepth`, R1 viewport width, R2 viewport height (CSS px) [U-ev: NOTIFY at boot] | P2 |
| 23 | `NOTIFY rateofusegraph` | P2. Omit. | P2 |
| 24 | show characters with their default surfaces, then `NOTIFY OnSurfaceChange` once per visible scope (0, then 1, then others) [L 936, 953]. **Browser:** the shell is ready long before the engine, so the characters are placed on their default surfaces at once but stay veiled (`Stage.setVeiled`; not drawn, still `visible` and saved as shown) until the boot script starts, or the boot ends without one. The veil goes on as the stage is created, before its first frame: a stage with nothing stored (a first visit, a ghost never run in this browser) composes its default surfaces at once, often before the balloon has loaded. Shown during the engine's load, a boot script that opens with `\s[-1]` (Tsubasa's mask bind on OnGhostChanged) made her appear, vanish and come back [observed in Sumika] | 4.11 | **P0** |
| 25 | `GET OnFirstBoot` (no profile: R0 = vanish count, `0`; R7 the shell name, so 8 References with R1–R6 omitted [disasm `TalkBootMessageReal`: SSP builds 8 References, not in UKADOC; R1–R6 omitted is Sumika's reading, infer]; `BaseID: OnBoot`) **or** `GET OnBoot` (R0 the booting shell's descript **name** [doc "起動時のシェル名"], e.g. `master`, R6 `""`, R7 `""`) | then the 1.9 chain | **P0** |
| 26 | start the 1-second ticker (3.1) | | P0 |

Notes:

* `OnBoot` R6 is `halt` and R7 the ghost name if the previous session crashed [U-ev]. **DECISION:** always `""`, because a
  closed tab is not a crash. Ikagaka did the same [I operation.js].
* No `GET username` at boot: ssp.exe asks it at each `%username`
  expansion only [disasm `LoadGhost` 0x620619 runs before the SHIORI loads, `GetUserNameW` 0x643A10] (properties.md
  §2.3).
* Tsubasa's `OnFirstBoot` and `OnBoot` set variables and play the greeting [T dic02_Event.txt:938, 945].
* After the boot script plays, its `\![bind]`s trigger `OnDressupChanged` and `OnNotifyDressupInfo` (4.11).
* **Paths (DECISION):** SSP sends absolute Windows paths. Sumika sends site-absolute URL paths ending in `/`, for
  example shell path `/ghost/tsubasa/shell/master/` and balloon path `/ghost/tsubasa/LightBlue/`. They are opaque to
  Satori and Tsubasa.

### 2.2 Resume after a page navigation (P0, Sumika-specific)

`sessionStorage['sumika.session']` is present, so this tab already booted the ghost. The rule from ARCHITECTURE: no
OnClose and no OnBoot. Exception: a marker with `pending: true` is a ghost change the last page did not finish; that
ghost cold-boots with OnGhostChanged instead (2.5).

```
1  load()                                                     (Satori runs ＊初期化, OnSatoriLoad, OnSatoriBoot)
3  GET version
4..23  the same NOTIFY batch as the cold boot (OnInitialize R0 "")
       restore the visual state silently: surfaces, positions, binds, minimized/hidden flag, balloon kind
24 NOTIFY OnSurfaceChange per visible scope
19' NOTIFY OnNotifyDressupInfo (full list, after binds are restored)
   no OnBoot / OnFirstBoot / OnGhostChanged / OnWindowStateRestore
26 start the ticker
```

* Several ghosts (§2.7): every ghost of the tab resumes at once, in parallel; each batch's `otherghostname` already
  lists all the others (a loop not up yet by its stored names in effect and surfaces, §2.7.5) and nobody is
  re-NOTIFYed [decision]. A call or change the last page left unfinished is carried per ghost (the marker's `carry`):
  that ghost cold-boots with OnGhostCalled / OnGhostChanged, or resumes and still owes OnGhostCallComplete /
  OnOtherGhostChanged at its replayed script's end.
  A ghost a change or call was carried to boots even if its stored state says closed. A resumed ghost that fails to
  start leaves the set, and every ghost still up gets NOTIFY otherghostname again without it (no event, as for a
  failed callee) [decision]. A marker with `quit` (the last page went during Quit's goodbyes) goes on with the Quit
  (§2.7.3). A new tab boots the stored set one ghost at a time with OnBoot each, no call events [disasm: SSP's
  start-up loop].
* Do not send `OnDressupChanged` for restored binds. Satori variables such as `猫耳着用` are restored from save data.
* A script, choice menu, input box or `\![timerraise]` timer that was active when the page unloaded is lost
  (DECISION). P2 option: persist the last displayed choice script and show it again with quick playback (no waits) and
  without re-sending any SHIORI event.
* `OnSatoriBoot`'s one-shot script (`on_loaded_script`) is discarded on resume. Tsubasa defines no `OnSatoriBoot` [T].

### 2.3 Close (P0)

Triggered by the user's "Close" or "Quit" menu item (both menus), or by `\-` reached in any script. With several
ghosts on screen (§2.7) Close and Quit differ; alone, Close is Quit [disasm `OnMenuClose` 0x495140, `CloseGhostProc`
0x4951F0 (2.9.08f; in 2.9.10 0x496680 and 0x496730)] (amends SUM C22). A minimized or locked ghost's
close drops its reply and closes at once (below).

```
Quit (every ghost on screen, in parallel), or Close of the only ghost (menu of scope s):
   r = GET OnCloseAll  [R0 "user", R1 s, R2 s]   BaseID OnClose     // the same s for every ghost [disasm]
   if 204: r = GET OnClose [R0 "user", R1 s, R2 s]
   if r has a script: play it. The ghost closes when that script ends, \- or not [disasm PlayScriptWithMsg(…, 0x3A)];
                      a run that replaced it (a click's reply): when that newest run ends [guess]; a balloon break
                      ends it too. A choice picked on it: when its reply ends, at once if it has none [guess].
   if 204: close immediately.
   (a minimized or locked ghost: below)
Close of one ghost while another stays (that ghost's menu of scope s):
   r = GET OnClose [R0 "user", R1 s, R2 s]                          // no OnCloseAll, no BaseID [disasm]
   if r has a script: play it. The ghost closes when the player executes \- (not before).
                      If the script ends without \- (or is broken), the ghost stays (C22) [disasm: plain PlayScript].
   if 204: close immediately.
   a Quit asked meanwhile turns it into a Quit's close (it goes at the script's end), without a new event [decision]
A minimized ghost (also one minimizing: SSP sets +0x419c to 1 as soon as OnWindowStateMinimize's script is queued,
§2.3.1 #6) or a locked one (IsLocked: inside \t, induction or passive mode), on Quit and on Close of one alike
[disasm CloseGhostProc 0x49676a–0x49677f -> 0x4969ef; bAll does not choose the branch]:
   the same events: Quit GET OnCloseAll [R0 "user", R1 s, R2 s] BaseID OnClose, then GET OnClose on a null or empty
      script; Close of one GET OnClose alone [disasm OnGhostClose call 0x496a0f]
   the reply is dropped: no OnTranslate, nothing plays, no #terminate script [disasm: TranslateScript 0x496938 and
      PlayScript / PlayScriptWithMsg 0x49697d–0x4969b6 are on the other branch only]
   the ghost closes at once, \- or not (a Close of one leaves nothing standing: no C22) [disasm
      OnSSPSysMsgGhostClose(ghost, false) 0x496a1f]: NOTIFY OnDestroy, then the SHIORI's unload (Kawari's OnUnload)
      [disasm DeleteGhost 0x46bda2 -> ModuleUnloadDirectly 0x73440f -> UnloadShiori 0x620c5a -> OnDestroy 0x622219,
      SPShiori::Unload 0x622235]
   Close of one: the others get OnOtherGhostClosed with R1 = its last script (SPGhost+0x1884, the script the Loop
      last started, not the dropped reply) [disasm 0x46bcc2–0x46bd7b, Loop 0x63b82d]; during Quit nobody does
   SSP may keep a Close of one's SHIORI in its ghost cache (UpdateCache 0x7343e8) instead of unloading it, as on the
      normal path [infer]: not modelled, Sumika unloads at once on every path
   Sumika: close() sends the requests, then closes (_quit {lastRun}); restore() does nothing while a
      close is under way (SSP's close is synchronous). SSP's Close menu asks `info.threadbusy` first in passive mode
      (not done, as for the normal path)
Close and Quit do nothing while a call or a ghost change is under way (SSP beeps "while any ghost is loading")
   [disasm OnMenuClose, OnMenuExit], nor during this ghost's own change (§2.5). Quit (several ghosts) also does
   nothing while a ghost still boots (the set's start, a takeover, one slot's start): that ghost would never close
   [decision].
on \- (from any script):
   finish the current frame, hide characters and balloons
   NOTIFY OnDestroy [R0 ""]                                         [U-ev], [L 5836]
   worker 'unload'  (Satori: OnSatoriUnload, then saves)           [S satori_load_unload.cpp]
   persist the returned files and the ghost state, set runtime.closed = true
   show the launcher. The next "open" is a cold boot (2.1).
   (several ghosts: the others get OnOtherGhostClosed unless it was a Quit, §2.7; the launcher shows only once the
   last ghost has finished its own unload, so every ghost of a Quit is stored closed)
```

* R1 is the scope whose menu was used. R2 is the scope of the window that was clicked [U-ev OnClose]. They differ only
  when the clicked character's `popupmenu.type` showed another character's menu (`\1` with `kero.popupmenu.type` 0:
  R1 0, R2 1) [disasm 2.9.10 `CCWC_OnCommand` 0x41d4ca / 0x41d503: `[esi+0x10]`, `[esi+0x78]`; `ssp-ui.md` §2.1
  Notes].
* The loop: `close(scope, {all, window})` (`all` defaults to "no other ghost on screen", `peers.count() <= 1`; `window`,
  R2, defaults to `scope`); `closing` is `'one'` or `'all'`; the site's Quit calls `close(s, {all: true, window})` on
  every ghost (`quitAll(s, window)` → 'quitall' `{scope, window}`). The ghost
  that closes emits 'closed' `{script}`: the script it closed with (OnOtherGhostClosed R1), `''` when it closed without
  one (a 204: SSP plays its own terminate script there, which is not the ghost's) [decision]; a minimized or locked
  ghost: the last script it played (SPGhost+0x1884) [disasm].
* Satori appends `\-` to every OnClose reply (below), so none of the site's ghosts shows the Quit rule; a ghost whose
  OnCloseAll reply has no `\-` does (open point, §7 Q9).
* Satori appends `\-` to every `OnClose` reply, and replies `\-` alone when nothing is defined
  [S EventOperation: `mRequestID==L"OnClose"`]. Tsubasa therefore always closes. Her `OnCloseAll` is undefined, so it
  returns 204 and falls back to `OnClose` [T].
* Hold-to-close on the menu character runs `ユーザ「　またね…`, Tsubasa's goodbye talk [T dic14_Mouse.txt:2956].
* Closing the browser tab or navigating is **not** a close. Never send OnClose for `pagehide` (DECISION). `R0="system"`
  is for OS shutdown; the page never sends it, Kawari's D6 does in the worker, at the next cold boot but on a clock
  from the time the tab was closed (§2.3.1, kawari-wasm.md §8).

#### 2.3.1 The session ended from outside (Windows' end of session) [disasm ssp.exe 2.9.10]

What ssp.exe 2.9.10 sends when Windows ends the session (shutdown, logoff), read in its disassembly for Kawari's D6
(kawari-wasm.md §8): the most faithful model of a tab closed without Close, a session that ends from outside.

1. `WM_QUERYENDSESSION` sends no SHIORI request: `CMainFrame::OnQueryEndSession` (0x46dd20) calls
   `ShutdownBlockReasonCreate(hwnd, L"Script Executing...")` when the API exists and returns TRUE, so it never vetoes
   (message map entry at file offset 0x743570) [disasm].
2. `WM_ENDSESSION` with bEnding TRUE: `CWnd::Default`, then `ForceQuitApplication(L"system", 0, 0)` (push at 0x46dd66),
   then `WaitForApplicationQuit` (0x46dd74; it is `SPEventObject::WaitPump(-1)`, 0x46dda0–0x46dda8: messages are pumped
   with no timeout until the app has quit, so the goodbyes play), then `ShutdownBlockReasonDestroy` (`OnEndSession`
   0x46dd50–0x46dd94; re-read in an installed 2.9.10.3000). The whole close runs inside the handler,
   while Windows ends the session. bEnding FALSE: nothing. A logoff arrives the same
   way: MFC passes only bEnding, and the SENS handlers `SPSensLogon::Logoff` / `SPSensLogon2::Logoff` are `return 0`
   stubs (0x450ef0, 0x576bf0) [disasm].
3. `ForceQuitApplication(reason, a, b)` (0x466940–0x4669b7) runs once: while a Quit is under way (flag `this+0x60`) it
   returns at once. It sets the force flag (`playerApp+0x33bc`), deletes SSP's own abnormal-end marker (the setting
   "executing", 0x466967–0x466972), purges caches, saves the settings and `SaveBootingGhostData`, then calls
   `GhostExitProc(reason, a, b)`. Its only other caller is SSP's self-update (`L"ssp_update"`, `OnSSPSysMsg` 0x46b64e).
   The user's Quit goes through `QuitApplication` (0x4669c0) with `L"user", 0, 0` and without the force flag (the menu
   `OnMenuExitReal` 0x496671, `CMainFrame::OnClose` 0x466930 for WM_CLOSE of the main window, `CGhostContainerWnd::
   OnClose`) [disasm].
4. `GhostExitProc` (0x466a00): with worker threads busy and a reason without "system" (`wcsstri` 0x466a4d) SSP asks the
   user (`info.threadbusy`); with "system" it ends the threads without asking (`TerminateAllThread` 0x466a9c). Then
   `CSakuraWnd::CloseGhostProc(reason, true, a, b)` for every booted ghost at once (bAll true, as for Quit; loop
   0x466b2f–0x466b5c) [disasm].
5. `SPShiori::OnGhostClose(reason, bAll, a, b)` (0x7106e0): R0 = the reason (`L"user"` when null, 0x71074b), R1 = a and
   R2 = b as `%d` (0x710764, 0x71077c). At the end of session that is `system`, `0`, `0`. With bAll it sends
   OnBasewareUpdating first, only during a baseware update (`playerApp+0x17ae`). Then GET OnCloseAll with BaseID
   OnClose (0x71097b / 0x710982); when that reply's script is null or empty (a 204 or an empty Value), GET OnClose with
   the same three References and no BaseID (0x710a0f). SenderType internal, SecurityLevel local (the event's defaults,
   `SPShioriEvent::Clear` 0x419b52). Kawari receives exactly ID OnCloseAll, Reference0–2 `system` / `0` / `0`, BaseID
   OnClose, SenderType internal [disasm; probe on the kawaritest fixture].
6. `CloseGhostProc` (0x496730): a ghost a messenger keeps (`+0x4860`) closes without any event. A minimized ghost
   (`+0x419c` nonzero) or a locked one (`IsLocked`) is sent OnGhostClose, its reply is dropped and it closes at once
   (0x49676a / 0x496778 → 0x4969ef, `OnSSPSysMsgGhostClose`); this holds for a Quit too (§2.3, Sumika
   too). `+0x419c` is set by `CSakuraWnd::ToggleMinimize`: -2 while OnWindowStateMinimize is sent, 1 as soon as
   its script is queued (before the windows minimize at that script's end), -1 during RestoreAll and 0 before
   OnWindowStateRestore is sent (0x499146, 0x499174, 0x499187; 0x4990cc, 0x4990f8) [disasm]; so a ghost still talking
   its minimize goodbye counts as minimized. Otherwise, when the reply has no script, SSP builds its own:
   `#terminate night|early morning|morning|etc` by the local hour, plus `#terminate plus`, else `\-`, status 200
   (0x4967eb–0x49687a) [disasm].
7. With the force flag the goodbye goes through `TranslateScript` before the SHIORI is unloaded (0x4968e2–0x49693d):
   MAKOTO, then `SPShiori::Translate` (0x7135f0), which sends GET OnTranslate when the SHIORI is loaded and speaks 2.6
   or higher. For SHIORI/3.0: Reference0 = the raw reply (no %-expansion yet: `TranslateParam` runs later in the
   loop), Reference1 always written, empty here (0x71395e), Reference2 = the event that answered (OnCloseAll or
   OnClose), Reference3 = the reason `system`; SenderType the event's (internal). A 2.x SHIORI gets `TRANSLATE Sentence
   SHIORI/2.6` with only `Sentence` [disasm].
8. Then `ModuleUnload(0)` (0x49694a) unloads the SHIORI (Kawari: `System.Callback.OnUnload`, Phase 7
   `system.OnUnload`) **before** the goodbye plays; then `PlayScriptWithMsg(result, 0x42, 0x3a)` (0x496967): 0x40 as
   for Quit plus 0x02 = notranslate (no second OnTranslate: `SPGhost::Loop` 0x63b6fa, 0x63b76a–0x63b77a); message 0x3a
   closes the ghost at the script's end. So ssp.exe plays the goodbye after the unload while WM_ENDSESSION waits. On a
   user Quit the call is `PlayScriptWithMsg(0x40, 0x3a)` and the unload comes after the goodbye [disasm].

So a session that ends from outside gets the close with R0 `system`, its reply translated, the SHIORI unloaded, and
SSP drops its own "you did not quit properly" marker; a killed SSP sends nothing [infer]. Sumika uses this for Kawari's
D6 (a cold boot that finds the snapshot of a session that never unloaded): the three requests above in the worker,
every reply dropped (no page exists to play it), then OnUnload [decision]. Sumika's request carries no
`Status` and no `SecurityOrigin` and its header order differs; Kawari reads none of them. Measured on the corpus
(kawari-wasm.md §8): every Kawari ghost answers OnCloseAll 204, then OnClose 200 with a goodbye that holds `\-`.

**When.** Items 3–8 run synchronously inside the `WM_ENDSESSION` handler (item 2), and no SHIORI request carries a time,
so the ghost reads the OS clock itself while Windows ends the session: Kawari's `date` is `time(NULL)` + `localtime` in
8.2.8 and 7.5.0 [disasm; src kawari-8.2.8 kis_date.cpp:41-43, kawari-7.5.0 kis_date.cpp:27-28]. bthver.5's OnClose
stamps (`CoEndday`, `CoEndtime`, `Work_Day` [corpus core/core.txt:868-875]) and KEEPS' OnUnload `endtime` / `endday`
are the session's end, and the next boot counts the time away from it [infer]. Nothing of the old session runs at the
next start. So Sumika runs D6's close and unload on a clock from the time the session ended: the ghost
state's `savedAt` (written at pagehide), which the page reads at the cold boot before its own state write and passes
as `sessionEndMs`; the worker's `Date.now` goes on from there for that window only (Kawari's only clock import), the
cold load and every request after it see the real time. No end time known, or one not before now: the real clock
[code; kawari-wasm.md §8 "At the session's end", with the measurements: machimaki back after 40 days gets its
"long time no see" boot talk, not its "back within 3 minutes" one].

### 2.4 Minimize and restore (P0)

| Trigger | Request | Then |
|---|---|---|
| `\![set,windowstate,minimize]` in a script (Tsubasa: 5 [C]) | `GET OnWindowStateMinimize [R0 "script"]` | play the reply (Tsubasa sets `最小化中`=1 and ends running games [T dic02_Event.txt:7]), then hide every scope, set `minimizing`, show the launcher |
| menu "hide" (`hidebutton`) | same with R0 `user` | same |
| launcher click | show all scopes, clear `minimizing`, `GET OnWindowStateRestore [R0 <reason it was minimized: user/script>]` | play the reply. Satori's default when undefined is surface restore [S EventOperation]. Tsubasa defines it [T dic02_Event.txt:30]. |

SSP plays the minimize script before hiding: the "don't talk when minimizing" option exists because ghosts talk right
before iconizing [U-help config-ghost]. Order of hide versus reply is ASSUMPTION: send the event, play its script to the
end, then hide. `OnFullScreenAppMinimize`/`Restore` are n/a.

### 2.5 Ghost switching and calling (P1/P2; switching implemented)

```
switch A -> B (menu "Change ghost ▸", or a script; Tsubasa: \![change,ghost,…] 10, \+ 3 [C]):
  B's engine missing (index 'engine' not in SUPPORTED_ENGINES): refused, A keeps running   (DECISION)
  A, menu or --option=raise-event only:
     r = GET OnGhostChanging [R0 B sakura.name, R1 "manual" (menu) | "automatic" (script), R2 B name, R3 B path]
                                                                  no BaseID, SenderType internal   [disasm 2.9.10]
     if 204: r = GET OnClose [R0 "user"]                            (R0 alone [disasm 2.9.10 0x497343])
     play r until A is quiet (cap 30 s); a balloon break (double-click) cancels the change    [U-ss]
     a \- in it (Satori ends every OnClose with \-) ends the farewell, not the ghost
  A, script without raise-event (\+, \_+, \![change,ghost,X]): no event; the script plays to its end (cap 30 s)
  page left from the farewell until B has sent OnGhostChanged: the change stands; the next page does the B half
     (stored choice B; tab marker {pending, change}; A's state saved without the farewell run)  (DECISION)
  A: NOTIFY OnDestroy; unload (the engine saves); state saved without run/timers/boxes
  B: cold boot on its own save data and state (2.1 #3..24), then
     first meeting (no save data): GET OnFirstBoot, 204 -> OnBoot                              (ASSUMPTION)
     otherwise: r = GET OnGhostChanged [R0 A sakura.name, R1 A's script at the change, R2 A name, R3 A path,
                                       R7 B shell name]  BaseID OnBoot;  if 204: GET OnBoot [R0 B shell name, R6 "", R7 ""]
     (shell names are descript names, never folders: §2.1 #25, §2.6)
```

UKADOC evidence [U-ev, U-ss]:
* OnGhostChanging 「他のゴーストへの切り替え指示があった際に発生」. R0 「切り替わるゴーストの本体側の名前」, R1 「手動で切り替えた場合、
  manual / システムにより切り替えられた場合、automatic」, R2 name and R3 path [SSPのみ]. 「スクリプトが返されなかった（204）場合、
  続けてOnCloseが発生する」. There is no OnGhostChangeFailure event.
* OnGhostChanged 「他のゴーストから自ゴーストに切り替えられた際に発生」. R0 「直前のゴーストの本体側の名前」, R1 「直前のゴーストの切り替え時の
  スクリプト」, R2 its name, R3 its path, R7 「切り替わったゴーストのシェル名」. 204 → OnBoot (OnBoot's own entry lists
  OnGhostChanged, OnGhostCalled, OnFirstBoot and OnVanished as the events that fall back to it).
* `\+` 「ランダムに他のゴーストに切り替わる」 and `\_+` 「次の順番のゴーストに切り替わる…リストの一番下だった場合、リストの一番上」: both
  「SHIORIイベントOnGhostChangingは通知されない」.
* `\![change,ghost,ゴースト名(,--option=raise-event)]`: `random` = `\+`, `sequential` = `\_+`, `lastinstalled` = the ghost
  installed last (gone after SSP restarts; nothing is installed in a browser, so ignored); 「該当ゴーストがいなかった場合は
  無視される」. With `--option=raise-event` (SSP 2.4.74+) 「メニューから切り替え操作をした場合と同じくOnGhostChangingが通知され
  る…バルーンブレーク（通常ダブルクリック）による中止操作も可能」; without it, no notification. Example name:
  `Emily/Phase4.5` (a descript `name`).

Decisions and assumptions:
* Target matching: descript `name`, then `sakura.name`, then the folder id, then case-insensitive name/id [infer]. A
  named target that is the running ghost, and its own row in Change ghost ▸, **reload it** (as ssp.exe
  2.9.10 [disasm `GetGhostIDFromTag` 0x62c6bd / 0x62c738: its own descript name or sakura name gives its own id, which
  the booted test lets through; `OnChangeMessage` 0x49720e skips the test for the own id; `InitGhostMenu` 0x49b9b7
  enables the own row]): A → A is the whole change above, the
  goodbye to itself (OnGhostChanging R0–R3 its own names and path; Tsubasa's `つばさへ変更` branch), the unload, a
  cold boot of the same ghost and OnGhostChanged with R0–R3 its own and R1 its goodbye script. ssp.exe's only
  difference, skipping its ghost cache for that unload (`DeleteGhost` flag → `UpdateCache` [disasm 0x46bf69,
  0x7343dd]), has nothing to match here. The runtime keeps the ghost's tab lock through it (`Runtime._change`).
  `random` and `sequential` skip the running ghost and ghosts whose engine is missing; with no candidate nothing
  happens (SSP ignores it too). `sequential`'s "list" is Change ghost ▸'s order (by descript name, ties by folder:
  UI §2.1 #12 [observed]) [infer: the list UKADOC means is the menu's].
* R1 of OnGhostChanging: `manual` for the menu and the page API, `automatic` for a script's
  `\![change,ghost,…,--option=raise-event]` [disasm 2.9.10: `ExecuteChangeFromTag` 0x62cd63 posts the change with bit
  24, which `OnChangeMessage` 0x497195 / 0x4972a2 reads as not manual; Sumika matches it, and earlier sent `manual`
  for scripts too]. SSP's timed auto-change (also `automatic`) does not exist here.
* OnFirstBoot before OnGhostChanged for a ghost met for the first time in this browser (ASSUMPTION: SSP's install-then-
  switch flow shows the new ghost's first-boot talk; UKADOC does not say).
* R3 paths are site-absolute URL paths of the ghost folder (`/ghost/<id>/`, DECISION as in 2.1 "Paths").
* The menu's change replaces whatever A is saying; a script's change waits for that script's end. B starts as soon as A's
  script ends (no linger: SSP ghosts end their farewells with `\w8`s for this) [infer].
* During the farewell A still gets mouse and key events (Status shows only what plays, e.g. `talking`: no flag marks a
  ghost change, 1.6 [disasm]) and its replies play; the change then waits until A is quiet, whichever run plays, within
  the same 30 s cap. A choice menu shown then does not hold the change. OnGhostChanged's R1 stays the farewell script. The right-click menu does not open, and
  Close / Iconify do nothing, until the change is over; a menu already open closes [infer].
* A page left during the change (a link followed during A's farewell or unload, or while B's engine loads) does not lose
  it: `pagehide` stores B as the choice and marks the tab's `sumika.session` marker `{pending: true, change}`. The next
  page cold-boots B with OnGhostChanged (R1: A's farewell so far), tells the other tabs, and clears `pending` once
  OnGhostChanged is sent. A's saved state has no run, so A never replays its goodbye (or a fallback OnClose's `\-`)
  (DECISION).
* B's cross-tab lock is taken before A's is let go, and the other tabs of the site follow the change over a
  BroadcastChannel (`sumika/runtime`): a tab running another ghost saves and unloads it like a takeover, then shows
  B frozen. If B fails to boot, A comes back with a cold boot (OnBoot) and stays the stored choice (DECISION). A takeover
  another tab asks for during the change is answered after it, for the ghost then running (ssp-ui.md §9.5).
* A script's change asked while a shell or balloon change holds the runtime's change slot (`\![change,ghost]`, `\+`,
  `\_+` in OnBalloonChange's reply), or a shell or balloon change asked while a ghost change holds it (B's boot or
  OnGhostChanged script running `\![change,shell]` after Change ghost ▸), waits for that change and then runs as one
  more request, only while the same ghost still runs (§2.6 "Changes in a row") (DECISION). The menu's and the page
  API's are refused, and until A's farewell is over a script's change is refused too (the loop's `changing`; the
  runtime from the change's start: `\![change,ghost,X]\![change,shell,Y]` in one script changes the ghost at the
  script's end and refuses the shell tag at once, queued behind another change or not, §2.6).
* No Status flag marks a ghost change (1.6) [disasm]; cantalk is 0 from the change request until A is unloaded (the
  loop's `changing`), and Sumika sends no Status `changing` for this span.

What Tsubasa answers [T, real engine in `tests/runtime/switch_satori.test.mjs`]:
* OnGhostChanging → Satori's alias `他のゴーストへ変更` [S satori_sentence.cpp FindEventTalk; T dic04_Change.txt:8–76]:
  one of her goodbye lines, some of which name the next ghost by its sakura name (R0: `Testy` for the fixture ghost).
  Satori runs `OnSatoriClose` first and ends the script with `\e` [S EventOperation:195, 561]. R0 `つばさ` or
  `Tsubasa` takes her "switch to self" branch (`つばさへ変更`) [T dic02_Event.txt:1254].
* OnGhostChanged → `他のゴーストから変更準備` → `他のゴーストから変更` [T dic02_Event.txt:1143, dic04_Change.txt:79]: a 200 with
  a greeting ("Oh, good evening, Neighbor."); within the minute she left, `終了直後起動` (a line about the user being
  back so soon). Her own random change talks end in `\![change,ghost,random]`
  [T dic03_Menu.txt:722] and `\+` [T dic07_Time.txt:1097].
* Calling (`\![call,ghost]`, Call ghost ▸) and a change with other ghosts on screen (only that ghost's slot changes,
  the others are excluded as targets and get OnOtherGhostChanged after B's boot script): §2.7.

### 2.6 Shell and balloon change (P1; implemented)

The menus are `ssp-ui.md` §2.11; which shell and balloon boot, and what is stored, are `balloon-format.md` §1.6 and
CONTRACTS.md (state `shell`, `shellChosen`, `shells`, `balloon`). This section is the event side: what SSP sends, in
which order, and how the event loop (`src/core/events.js`) and the player do it. Nothing here was compared with
ssp.exe on screen.

**Who asks.** Shell ▸ and Balloon ▸ (scope 0 only), `\![change,shell|balloon,…]`, and the page API
(`window.sumika.changeShell` / `changeBalloon`). The loop hands each request to the runtime (`loop.viewSwitcher`),
which resolves the target, holds the one change slot that ghost, shell and balloon changes share, and drives the loop's
halves below.

* **Refused** (nothing happens; SSP beeps): not booted, closed, frozen, during a ghost change's farewell; a menu pick
  also while minimized, in passive or induction mode, or inside `\t` [disasm `OnChangeMessage`: lParam bit 24 = from a
  script skips the test]; a menu pick or page request also while another ghost, shell or balloon change holds the
  runtime's slot. A script's change asked then waits for the slot instead ("Changes in a row" below).
* **Tag arguments** [disasm `ExecuteChangeFromTag`]: every token starting with `--option=` (any case) is an option,
  `raise-event` anywhere in one sets raise-event; **the last other token is the target** (trimmed; an empty one = no
  target [infer]); no target → ignored. Balloons parse raise-event and ignore it.
* **Targets** (runtime, `src/core/shells.js`): `random` = a shell other than the current one, **ignored unless at least
  2 such shells exist** [disasm; with exactly two shells it does nothing: not compared with ssp.exe]; `sequential` = the next in menu
  order, wrapping, **with the same guard**: a two-shell ghost (Katari, roommate) ignores it too [disasm 0x627702;
  guess for the order: SSP's code computes a raw index that looks like a bug; no ghost uses it]; `lastinstall…`
  (prefix) = nothing (a browser installs nothing); otherwise the descript `name`, case-insensitive, first match in menu
  order: **folder ids never match** [disasm `FindFromName`; corpus: every literal argument is a name]; hidden shells can
  be named; unknown → ignored (logged once). The current shell's name → a reload with every event. Balloons: the same,
  `random` = any other balloon.

**Shell, menu pick or `--option=raise-event`** [disasm `OnChangeMessage(0x2F)`; doc UKADOC:ss]:

```
r = GET OnShellChanging [R0 next shell name, R1 current shell name (= R0 on a re-pick), R2 next shell path]
    GET, not NOTIFY; no fallback on 204; origin user (its reply replaces whatever plays)          [disasm]
the switch waits until r's run ENDS (at once on 204):
    a balloon break (double-click) during it cancels                                               [doc]
    a run that replaces it (she answers a click meanwhile) cancels too: the switch rides on
        that one script (PlayScriptWithMsg)                     [infer; not compared with ssp.exe]
    a close cancels (so would the loop's destroy / suspend / leave); a takeover or another tab's ghost change
        waits until the change is over, and a ghost change asked meanwhile is refused (a script's too: queuing it
        would hold this talk); Sumika's also gives up after 30 s                    [decision: SSP has no cap]
    a page left during the talk drops the change; the talk is not replayed (the run is saved as null)  [decision]
the swap (below), then the events below with OnShellChanged's reply played at once
```

A script's raise-event change is not held at the tag: OnShellChanging's reply replaces it like any event reply
[infer]. Re-picking the current shell (it keeps its ✓ and stays enabled) goes the same way: R0 = R1, then a reload
[disasm: the shell path has no "already current" test, unlike Change ghost ▸].

**Shell, `\![change,shell,X]` without raise-event**: no OnShellChanging; the switch happens **at the tag**: the player
waits there until the swap is done (`PlayerHost.change` returns a promise, `_block(run, idx, 'change')`), then the rest
of the script runs on the new shell [disasm: synchronous `ChangeOrReloadShellInternal`]. OnShellChanged is sent right
after the swap; **its reply plays when the calling script ends**, not cutting it [guess; SSP's ordering of that reply
was not traced]: it waits in the loop's reply queue and plays at the end of the newest run (before that
run's dress-up GET), at once when nothing plays, and is dropped when the ghost closes (kirito's
`\![change,shell,桐兎]\-` stores the shell and closes), changes or is taken over. A change inside an OnShellChanged or
OnBalloonChange reply (333-4.05 changes back inside its OnShellChanged reply) is one more request, never a loop: played
inside the change that sent it (the menu's reply plays at once), it waits for that change's slot and runs right after
(next paragraph). A fast-forwarded replay never repeats it (`isSideEffect`).

**Changes in a row** (runtime `_chainChange`) [decision: SSP runs a change a script asks for after the one in
progress]. A script's change (`\![change,shell|balloon|ghost]`, `\+`, `\_+`) asked while another ghost, shell or
balloon change holds the runtime's slot waits for that change to end, then runs as one more request:
- only while the same ghost and loop still run here; after a takeover, a ghost change, a teardown or a failed ghost
  change that brought the old ghost back it resolves false;
- before a takeover asked meanwhile is answered (that one waits for the queued changes too);
- a shell change without raise-event and any balloon change hold the script at the tag until their queued change has
  run (as in the paragraph above);
- refused at once while the slot's shell change waits for OnShellChanging's talk (queuing it would hold the very talk
  the change waits for, until the 30 s cap), and while the slot's ghost change has not finished its farewell (the
  loop's `changing`; in the runtime from the change's start, so also while it waits for a page load's boot to end, and
  for a ghost change that was itself queued). So `\![change,ghost,X]…\![change,shell|balloon,Y]` in one script goes
  the same way queued or not: the tags run in script order, the ghost change (asked first) waits for the script's end,
  and the later shell or balloon tag is refused at once, so the script goes on and the ghost changes when it ends
  [decision: a ghost change ends the leaving ghost's changes; SSP's handling of a change tag after
  `\![change,ghost]` was not traced];
- at most `MAX_CHAINED_CHANGES` = 4 queued in a row [decision]; the 5th is refused with the warning "the ghost asked
  for 5 changes in a row; no more". The count resets when the slot frees with nothing queued. A change asked while the
  slot is free (a deferred OnShellChanged reply that plays after the calling script ended) is a new, uncounted request:
  one per script, as SSP;
- the menu's and the page API's requests are still refused while the slot is held.

So 333-4.05's revert inside OnShellChanged's reply works on the menu path too, a boot or OnGhostChanged script's
`\![change,shell]` works after Change ghost ▸, and a `\![change,ghost]` in OnBalloonChange's reply waits for the balloon
change. A site message about another tab's ghost change is handled after the view change and the changes queued behind
it.

**The swap** [disasm `ChangeOrReloadShellInternal`, `LoadShell`]; the engine keeps running (SSP never unloads SHIORI for
a shell change):

1. Remember each shown scope's surface id (PushSurfaceStatus) — `loop.detachStage()` returns them.
2. Close every balloon (HideBalloons): the OnShellChanging balloon disappears here; choices and post-script timers go
   with it. Input / communicate / teach boxes stay open [infer: separate windows]; one the visitor did not drag is
   placed again once its character has a size: at once when the new character already has one, else it stays put
   until the new stage's first `move` with a size for that scope (every new character starts without a surface, #5),
   i.e. when OnShellChanged or the restored surface has placed it (`Dialogs.setStage`, `balloon-format.md` §12.3).
3. A script's dress-up changes still pending are reported first, as NOTIFY [disasm: lazy commands run before the
   switch], and a menu pick's still pending report. The loop stops listening to the old stage and is `swapping` until
   the swap ends (below).
4. The old shell's dress-up goes into the per-shell memory; the choice (`shell`, `shellChosen`) is stored at once, so
   a page left mid-swap boots the new shell (without OnShellChanged) [decision]. So is `shellSwap` = {surfaces: the
   ids remembered at #1}: until OnShellChanged's reply starts (or its 204 restores the surfaces), a page left resumes
   (also a takeover), and a frozen tab draws, the ghost with those surfaces back (`settleSwapSurfaces`); `\0` / `\1`
   whose id the new shell lacks get their default surface, scopes hidden before the swap stay hidden [decision: never
   come back invisible]. The marker goes when a menu, page or raise-event swap's OnShellChanged returns, when a 204
   restored the surfaces, or when a deferred reply starts (a later `\s[-1]` of that reply stays); still no
   OnShellChanged on the next page [decision]. A reply that played at once but showed nothing and queued a shell
   change behind the slot (333-4.05's `\1\![change,shell,master]` on the menu path) keeps it: the queued swap carries
   those surfaces on in its own marker, so a page left or a takeover during it resumes the ghost visible; one that no
   queued swap took over (an unknown name, a failed load) goes when the slot frees [decision].
5. The new stage: the characters keep their positions [infer: windows are not recreated]; alpha kept [guess];
   `\![set,alignmenttodesktop]` overrides dropped [disasm `SetAlignAll`]; `\![set,scaling]` factors dropped [guess];
   the new shell's own dress-up (per-shell memory, else its `bindgroup*.default`) [disasm `LoadBindInfo`]; every
   remembered scope **without a surface**.
6. Balloons, boxes, player (`setStage`) and menu move to the new stage (`loop.attachStage`); the menu takes the new
   shell's `menu.*` look; the old stage is destroyed. Moves and `\i[ID,wait]` waits on old characters end.
7. Balloon offsets and alignment come from the new shell's descript, the ghost's as fallback.
8. The new shell gets the balloon it would boot with (`balloon-format.md` §1.6 rules 1–5, `chooseBalloon`): its
   remembered balloon, else the ghost's stored choice, the descript keys, install.txt, the site default. When that
   differs from the balloon on screen it is switched **silently** (no OnBalloonChange, nothing stored; OnNotifySelfInfo
   below names it), so a live swap and a reload agree; none (the built-in balloon): the current one stays [disasm
   `LoadShell` → `GetBalloonIDFromSetting`, shell value first].
9. Shell scaling stays per ghost [decision; SSP keeps it per shell].

**While the swap runs** (`loop.swapping`: from `detachStage()` until `shellChanged()` has played, deferred or skipped
OnShellChanged's reply; a failed swap ends it when the old stage is attached again, the only `attachStage` that does;
destroy, leave, close and suspend end it and drop what it held) [infer: SSP swaps synchronously, so nothing talks on
the stage being replaced; the held/dropped split is Sumika's, decision]:
- cantalk is 0 (counted like closing, §1.6; SUMMARY C6): OnSecondChange and OnMinuteChange go out as NOTIFY with R3 0;
  a pending OnSurfaceRestore waits until the swap is over (§3.4) [disasm TimerExec 0x497e82];
- requests still go out at once, but no reply plays. Dropped: replies of a tick, a surface restore, a balloon or choice
  timeout, a dress-up GET or an async raise. Held: every other (keys, mouse, boxes: OnUserInput*, OnCommunicate*,
  OnTeach*; timerraise events, `\![raise]`, OnLanguageChange, choice selections, `send()`). A held reply counts as
  played, so no fallback follows it (OnUserInputCancel → OnUserInput, OnMouseUp → OnMouseClick → the menu,
  OnChoiceSelectEx → OnChoiceSelect). A held `\![raise]` reply keeps `raise()`'s rule: it is dropped once a run
  started after the raising one (OnShellChanged's reply, or any later run before it could play), as it is outside a
  swap [decision];
- a script still playing when the swap starts (a menu pick, or a script's raise-event `\![change,shell]`, whose
  OnShellChanging answered 204) is held where it is (`player.hold()`) from `detachStage()` until the swap ends, so
  none of its tags land on the stage being replaced; then it goes on, on the new stage, after a 204's restored
  surfaces, its waits shifted by the time held, unless OnShellChanged's reply replaced it [infer: SSP swaps
  synchronously, so an old script's tags run only after the swap];
- when the swap ends the held replies join the reply queue behind OnShellChanged's, oldest first: from the menu
  OnShellChanged's reply plays at once and the held ones when its script ends; with defer (a script's
  `\![change,shell]`) after the calling script and the deferred OnShellChanged reply; after a 204, `event: false` or a
  failed swap at once if nothing talks. The reply queue plays nothing during a swap;
- Clothes/Dressup ▸ picks are refused (`toggleDressup` false).

**Events after the swap** [disasm; doc UKADOC:ev] (`loop.shellChanged`):

```
NOTIFY OnNotifySelfInfo    [ghost name, sakura name, kero name (the new shell's overrides applied), shell name,
                            shell path, balloon name, balloon path]
NOTIFY OnNotifyShellInfo   [shell name, shell path, comma list of the shell's surface ids]      (never at boot)
NOTIFY OnNotifyDressupInfo [the new shell's dress-up]                                 (no OnDressupChanged)
NOTIFY installedshellname  [every shell name in menu order, hidden ones included]   (its place: a thread race [infer])
every menu pick, every \![change,shell], every re-pick (not \![reload,shell] / \![reloadsurface]: §2.10):
   GET OnShellChanged [R0 new shell name, R1 the ghost's descript name, R2 new shell path]
     reply: plays now (menu, raise-event) / when the calling script ends (script, above)
     no reply (204): every remembered scope gets its old surface id back, now drawn from the new shell
                     (an id the new shell lacks shows nothing [infer])
```

* Paths are site-absolute URL paths ending in `/`, e.g. `/ghost/katari/shell/loligatari/` (§2.1 "Paths"; SSP also
  turns `\` into `/` here [disasm `ReplacePathChar`]).
* There is no `OnShellChange` event (no such string in ssp.exe) [disasm]. Status `changing` is SSP's shell-change flag
  +0x41a4 (1.6) [disasm 2.9.10]: from OnShellChanging's response (0x4978c5; OnShellChanging itself goes without it) or,
  for a script's `\![change,shell]`, from the swap's start after the binds' report (0x623125), until right after
  OnShellChanged's request (0x623490), so the NOTIFYs above, the shell load's menu resources and OnShellChanged carry
  it, OnShellChanged's reply's OnTranslate and a 204's restored surfaces do not. A cancel clears it here (ssp.exe keeps
  it until its next shell change) [decision]. A balloon change sets no flag [disasm]. cantalk is 0
  while the swap runs (above).
* Other tabs: a frozen tab of the same ghost draws its stage again with the new shell (`{t:'view'}`, ssp-ui.md §9.5),
  also when that message comes after it read the state but before its frozen stage was built: it draws again once the
  stage exists [decision].
* Satori never answers 204 here: an undefined `＊OnShellChanged` returns its surface-restore script
  [S satori_EventOperation.cpp:343]. So scopes the reply does not name **stay hidden**: Tsubasa's own reply sets only
  `（２１）` / `（５）`, so her `\p[99]` panel dot stays hidden after a re-pick until a script shows it [infer from code].
  Not compared with ssp.exe: the dot could not be made out on ssp.exe's screen [observed].
* Shell names everywhere (§2.1 #11, #18, #25, §2.5): the descript `name`, never the folder; the shell descript's
  character names replace the ghost's in OnNotifySelfInfo R1/R2 and `%selfname` / `%keroname` (§2.1 #11), whatever
  `name.allowoverride` says, and so in `otherghostname`, the FMO and a talk's sender (§2.7.5–§2.7.7). After the swap
  every ghost, this one too, gets NOTIFY `otherghostname` again (§2.7.5).

**Balloon change** [disasm `ChangeOrReloadBalloonInternal`; doc UKADOC:ss] (Balloon ▸, `\![change,balloon,…]`):

* **No OnBalloonChanging**, no farewell; the ghost cannot veto [disasm].
* The new skin loads first (a failure changes nothing), then **re-skins in place**: balloons on screen stay open with
  their text and choices, laid out again for the new skin; each goes back to its scope's default kind [infer; not
  compared with ssp.exe]; open boxes stay open with their typed text (`balloon-format.md`, "Balloon change: re-skin in place"). A
  script's `\![change,balloon]` waits at the tag until the skin is loaded, then continues with the new look.
* Then the choice is stored (and the current shell's remembered balloon), the loop learns the new name and path
  (`loop.setBalloonInfo`), and (`loop.balloonChanged`):

```
NOTIFY OnNotifySelfInfo [… R5 new balloon name, R6 its path]
GET    OnBalloonChange  [R0 new balloon name, R1 its path]     a re-pick of the current balloon sends it too
   reply: plays now (menu) / when the calling script ends (script) [guess]
```

* OnNotifyBalloonInfo is not sent [decision, P2]. Balloon scaling stays per ghost [decision; SSP keeps it per balloon].

**Loop seams** (CONTRACTS.md): `loop.viewSwitcher = req => Promise<boolean>` (`req = {kind, target, byId, raiseEvent,
fromScript, scope}`), `changeShell(target, {byId, raiseEvent, scope, fromScript})`, `changeBalloon(target, {byId,
scope, fromScript})` (both `Promise<boolean>|false`), `shellChanging(next) -> {ok}`, `detachStage() -> Map<scope,
surface>`, `attachStage(stage, {id, name, path})`, `shellChanged({surfaces, event, defer})`, `swapping`,
`setBalloonInfo({name, path})`, `balloonChanged({event, defer})`; the constructor's `shell: {id, name}`. `change(kind,
args)` returns the
promise only for a shell change without raise-event and for every balloon change, so the player waits only then; a
ghost change never makes it wait (that change waits for the script's end).

What Tsubasa answers [T dic02_Event.txt:140–149; she ships only `shell/master`]: OnShellChanging "Um... okay, I'll go
get changed, then." / "Alright, I'm going to go change."; OnShellChanged "...Does it suit me?" / "How do I look?",
on surface `（２１）` or `（５）`. She defines no OnBalloonChange (Satori: 204). Katari changes shell from her own menu
(`\![change,shell,少女語り]`) and changes balloon with key `b` (`\![change,balloon,random]` + OnBalloonChange). The
ghost sweep (`ghost-sweep.md`) switches Katari, souzou_syoka and tok_2 through their own `\![change,shell]`.

### 2.7 Several ghosts (P1; implemented)

Several ghosts on one page, as SSP runs several on one desktop: Call ghost ▸, `\![call,ghost]`, the OnOther* events,
Close vs Quit; also ghosts talking to each other, Satori's FMO view and raised events (§2.7.7–§2.7.9).
Tags as in the Legend's line for shells, balloons and the dress-up menu. Only where a called ghost stands has been
compared with ssp.exe (§2.7.1, [observed]); the rest is open (§7 Q9). The page
(`src/core/site.js`, a `Site` with one `Runtime` per ghost) owns the set, the order of the events and the tabs
(`ssp-ui.md` §9.5); each ghost keeps its own EventLoop, player, balloons, `Status`, cantalk and timers.

**What a ghost does on its own.** Two ghosts' talks overlap freely; nothing queues one behind the other, and no
`Status` flag or cantalk refers to the other ghost [disasm `AddStatusText`, `SPGhost::Loop`; infer for what a visitor
sees]. The only orderings: OnGhostCallComplete / OnOtherGhostBooted / OnOtherGhostChanged wait for the new ghost's boot
script; OnOtherGhostClosed waits for the closer to be gone; OnOtherGhostTalk "after" waits for the talker's script.
The OnOther* replies are user-type replies: they cut whatever that ghost was saying [infer: SSP plays them like any
GET reply, `SPGhost::OnNotifyEvent`]; Sumika's: origin `user`.

**Who hears them** ("live", the loop's `peerLive`): booted and not closing, closed, changing or frozen, and not
minimized, passive, induction or inside `\t`. For OnOtherGhostTalk this is SSP's own filter: `SPGhost::SPCNotify`
skips a listener that `IsLocked` (`\t`, passive, induction), a temporary or deleting one, and for "after" the talker
itself [disasm 0x647420–0x647494]; for the other events and for minimized it is [guess]. A ghost never hears its own
events [infer]. Another ghost's talk (COMMUNICATE) and raised events reach more ghosts: §2.7.7, §2.7.9.

#### 2.7.1 Calling

Call ghost ▸ (main menu only, right after Change ghost ▸; captions and marks in `ssp-ui.md` §2.1 #13) lists every
ghost of the site; a pick asks `callGhost(id, {byId, raiseEvent: true, reason: 'manual', scope})`. Refused only while
the ghost is not booted, closing, changing, frozen, or inside `\t` [guess: SSP's call path showed no other lock test].

`\![call,ghost,<target>(,--option=raise-event)]` [doc UKADOC:ss; disasm `ExecuteChangeFromTag(…, isCall=1)` 0x6273F0]:
arguments starting `--option=` (any case) are options, `raise-event` a case-insensitive substring; **the first other
argument is the target** (unlike `\![change,shell]`, where it is the last); none: ignored. Without the option the
caller gets no event and **its script keeps playing** while the callee loads (no BreakScript, unlike a change
[disasm]); OnGhostCalled's R1 is the caller's script holding the tag [disasm; infer for the field]. With it, GET
OnGhostCalling like a menu pick but with R1 `automatic` [disasm lParam bit 24]; its reply replaces the caller's script
like any event reply, and the callee loads at once. No balloon break cancels a call [disasm: plain `PlayScript`]. Two
calls in one script queue one after the other [guess]. A replay after a page change never repeats the tag (SS §7).
No corpus ghost uses the option [corpus]; `\![call,ghost]` is in 42 archives; on the site Tsubasa, Katari and
etherism use it.

Targets (`resolveCallTarget`, `src/core/ghostset.js`) [disasm `GetGhostIDFromTag` 0x626E70]:

| Target | Result |
|---|---|
| `random` | a random site ghost that is not on screen and whose engine the runtime has; none: ignored [disasm: resolved at load time; Sumika: when the call's turn comes, the same moment in practice] |
| `sequential` | the first such ghost after the caller in the site's list, wrapping [disasm] |
| `lastinstall…` | ignored: nothing is installed in a browser [decision, as for changes] |
| a name | descript `name`, then `sakura.name`, then folder id, then name / id in any case (the change's order, §2.5); the corpus calls by sakura name (`\![call,ghost,なと]`) [corpus; disasm for name and sakura name] |
| on screen (the caller too), unknown, engine missing, a site cap reached (`maxGhosts`; none by default, as SSP has none [decision]) | ignored, one log line [disasm: `IsGhostIDBooted` twice] |

Order of a call from X's menu (scope s) [disasm 0x495FBE, `AddGhost` 0x4657F0, `TalkBootMessageReal` 0x63D010, msg
0x3D]; `u` = Reference not sent; GET unless NOTIFY:

```
1  X: GET OnGhostCalling [Y sakura, manual, Y name, Y path]  BaseID OnGhostChanging, SenderType internal
      (a script without the option: skipped). 204: nothing else. X plays its reply; Y starts as soon as it has started
2  Y: cold boot (2.1), its NOTIFY batch with otherghostname listing X (and every other ghost on screen)
3  Y: GET OnGhostCalled [X sakura, X's script, X name, X path, u, u, u, Y shell]   BaseID OnGhostChanged,OnBoot
      204 -> GET OnBoot [Y shell, u, u, u, u, u, '', '']             (OnGhostChanged is not tried) [disasm]
      Y never booted in this browser: GET OnFirstBoot [vanish count, u ×6, Y shell] BaseID OnBoot instead, 204 ->
      OnBoot (a ghost called for the very first time says its first-boot talk, never its "called" talk) [disasm]
4  every ghost up, Y too: NOTIFY otherghostname (X's now with Y; Y's a second one)    (after Y's boot GET, §2.7.5)
5  ... Y's boot script ends (finished, broken or replaced; at once when nothing played), and every ghost of the page
   has started (a caller still resuming on a new page is up before it is told) [decision] ...
6  X: GET OnGhostCallComplete [Y sakura, Y's boot script, Y name, u, u, u, u, Y shell]   SenderType internal (X live)
   every other live ghost Z: GET OnOtherGhostBooted [same]
```

* X's script at step 3 R1: OnGhostCalling's reply as played (after OnTranslate), `''` on 204 [disasm: the reply is
  passed to `CallGhost`; infer: translated]; for a script's call, the script holding the tag.
* Steps 5–6 follow whichever boot event made the script (OnFirstBoot and OnBoot too) [disasm `PlayScriptWithMsg(…,
  0x3D)`]. Ghosts brought back at a page's start (a new tab, the closed launcher, a tap on the tucked button of a
  phone page: `ssp-ui.md` §9.11) have no caller: no OnGhostCalled, no OnGhostCallComplete, no OnOtherGhostBooted
  [disasm: SSP's restored list].
* Y fails to start (engine, stage): it is removed again; X is told nothing [guess]. (A resumed ghost that fails at a
  page's start leaves the set too; the others had been told it was up, so they get otherghostname again, §2.2.)
* The page API (`window.sumika.callGhost(id, {from})`) is Call ghost ▸ of `from` (default: the preferred ghost); a
  `from` that names no ghost on screen here resolves false, as `changeGhost` does. Calls happen only in the tab that
  runs the set (`ssp-ui.md` §9.5): in a tab that shows it frozen, or waits for or hands over the lead, a call
  resolves false and nothing is stored or posted [decision; SSP is one process]. With the site closed here (after
  Quit or the last Close: only the closed launcher), the tab takes the lead (false if another tab has taken it
  meanwhile) and the callee comes back **alone and cold** in the launcher's place: OnBoot (OnFirstBoot for a ghost
  never met), no OnGhostCalled, no caller, the stored set becomes `[callee]`; this works for the launcher's own ghost
  too. If it does not boot, the closed launcher comes back with the old set stored again [decision].
* A page left mid-call: after step 1 and before Y's OnGhostCalled, the next page boots Y with OnGhostCalled; during Y's
  boot script, Y resumes and step 6 follows its replayed script, R1 = that whole script [decision].
* The callee takes the keyboard only if the caller had it (SSP always activates the new ghost, `ActivateAllWindow`
  [disasm]) [decision, `ssp-ui.md` §9.7].
* Where Y stands: at its own stored places, else at its own default place; nothing of X's is read (`ssp-ui.md` §3.2,
  §3.3, §3.5) [disasm `CallGhost` / `AddGhost` pass no position; `ResetAllPositions`]. A Y never met therefore stands
  on an X at its own default. **Open:** in ssp.exe a ghost called for the first time did not stand on the caller,
  with no clear pattern [observed]. That agrees with the above only if the ghosts had run
  there before and came back where they last stood [infer, unconfirmed]; `ssp-ui.md` §3.5 open point 2 (Reset shell
  position on both ghosts) settles it.

#### 2.7.2 Changing with others on screen [disasm `OnSSPSysMsgGhostChange` 0x46AAA0]

Only the ghost whose menu or script it was changes; the new ghost B takes the old one's place (set order, layer). On
screen B's characters stand at B's own stored or default places, not where A's stood (A's go into A's own profile;
`ssp-ui.md` §3.5) [disasm `OnSSPSysMsgGhostChange` 0x46ADD0]. Ghosts on screen in another place are greyed in Change
ghost ▸ and ignored by scripts; `random`, `sequential`, `\+`
and `\_+` skip every ghost on screen [disasm `GetGhostIDFromTag`]. The farewell, the unload and B's boot are §2.5's;
B's batch lists the others, and they get `otherghostname` with B instead of A after B's boot GET (§2.7.5; `AddGhost`
from `OnSSPSysMsgGhostChange` 0x46B6AD). After B's boot script
ends, every live other ghost gets GET **OnOtherGhostChanged** [doc; disasm msg 0x3E]:

`[A sakura, B sakura, A's farewell script, B's boot script, A name, B name, u ×8 (R6–R13), A shell, B shell]`

Not when B fails (A comes back cold, §2.5). Not for a change to the ghost itself either (A = B: Change ghost ▸ on its own
row, a script naming it, `\![reload,ghost]`, §2.10): ssp.exe's 0x3E handler does nothing when the new ghost's previous
id (+0x485c, set at 0x46c62b) is its own (+0x1420) [disasm 2.9.10 0x49a7a9–0x49a7ba]. Sumika sends none for
`\![reload,ghost]` (no change is owed); after Change ghost ▸ to itself it still does (`Site._onBooted`), a known
difference.

* **Only in the tab that runs the set** [decision; SSP is one process]: in a tab that shows the set frozen, waits for
  it, hands it over or restarts, a change (the page API's `window.sumika.changeGhost`, also
  `window.sumika.runtime.changeGhost`) resolves false before any farewell: no ghost lock, no stored set, no message;
  the tab that runs the set goes on. Refused during Quit too.
* With the site closed here (after Quit or the last Close), `window.sumika.changeGhost(id)` takes the lead and boots
  `id` cold with OnBoot in the launcher's slot (nobody says goodbye); the stored set becomes `[id]` and it resolves
  true. A change that fails releases the lead again.
* A bfcache restore (or a next page) while A unloads: the change ends in its own slot and B boots there with
  OnGhostChanged from the carried change, never a second ghost beside it. A ghost a change was carried to boots even
  if its stored state says closed.

#### 2.7.3 Closing

Close vs Quit (§2.3): Close of one of several sends OnClose only and the ghost goes at `\-`; then every live ghost
left gets GET **OnOtherGhostClosed** `[its sakura, its last script, its name, u, u, u, u, its shell]` [doc; disasm
`OnSSPSysMsgGhostClose` 0x46A830], then NOTIFY otherghostname without it (after the event, so the handler still
counts it). The same after `\-` in any script while others stay [infer]. Quit closes every ghost in parallel, each at
its own script's end; nobody gets OnOtherGhostClosed [disasm], and the closed launcher calls the whole set back
[decision]. While closing, a ghost still counts as up for the others' `otherghostname`: Hayato's OnClose sees
`（起動しているゴースト数）` = 2 when he is sent home ("姉さん？！ 僕よりそんな奴が良いって言うの！？") [corpus], also on
Quit (nobody leaves before the scripts end) [infer].

* **Quit's end.** Each ghost finishes its own close (OnDestroy, unload, save). The site closes only once the last one
  has: the closed launcher of the set's first ghost, the tab marker cleared, the lead released, the stored set kept
  whole. So every ghost of a Quit is stored closed, and the next page shows the closed launcher. A ghost loses its dock
  button as it closes: a ghost minimized at Quit is sent OnCloseAll / OnClose, its reply dropped, and closes at once
  [disasm, §2.3], and its "Show X" button goes with it; a click on that button while its close is under way restores
  nothing, and one still on its way after it boots nothing.
* **During Quit** nothing joins or changes: calls, ghost changes, the closed launcher's relaunch, a second Quit and
  `window.sumika.start()` are refused. Another tab that asks for the set waits for the end: the site closes, the lead
  goes, and that tab finds the closed launcher.
* **Two ghosts ending together outside Quit** (each reaching `\-`): the first to finish is a Close of one (it leaves
  the set; the other, closing itself, is not live and hears nothing), and the last closes the site with the set
  `[last]`.
* **A page left during Quit's goodbyes** (a link, or a bfcache round trip) goes on with the Quit on the tab's next page
  (the marker's `quit`) [decision]. The stored set stays whole; ghosts already closed get their slot but do not boot;
  each ghost still saying goodbye resumes, replays its goodbye and closes at its end, `\-` or not (at once when nothing
  is replayed; `EventLoop.resumeClose`). Nobody gets OnOtherGhostClosed, and after the last close the closed launcher
  calls the whole set back. A new tab (no marker) still drops the closed members of an open set.
* Known gaps (not fixed): if the quitting page goes (closed, or left) and another tab takes the set over before this
  tab's next page starts, that tab resumes the ghosts still saying goodbye as they stood; they do not close (the Quit
  is split). On a Quit carried to the next page, a ghost whose engine fails there is never stored closed: the site
  still closes, but the page after that boots that ghost alone.

#### 2.7.4 OnOtherGhostTalk [doc UKADOC:ev/ss; disasm `SPGhost::Loop` 0x635D06, tag handler 0x62C574]

Opt-in per listening ghost with `\![set,otherghosttalk,true|false|before|after]` (SS §5.7): `true` = `after`;
`before` and `after` add up (one argument may hold both, `"before,after"`); `false` clears both; kept until the ghost
closes [doc "ゴースト終了まで有効"] (in `ghostLife`, so a page change keeps it; a cold boot drops it). For every run a
ghost plays, the live ghosts that asked get GET OnOtherGhostTalk:

`[talker's descript name, its sakura name, flags, the event that made the script, the script, its References joined by \x01]`

* `before`: when the run starts, R2 `''`, or `communicate` when the run carries a talk to pass on (§2.7.7); `after`:
  when it ends, R2 `communicate` likewise, plus `break` when it did not reach its end (a balloon break, a choice
  clicked while it typed; a run another one replaced [guess]) or asked `\![change,ghost]` (SSP breaks it [disasm
  0x62AF92]): `''`, `communicate`, `communicate,break` or `break` [disasm Loop 0x63949C]. `\-` counts as its end.
* SSP's only guard: "before" is not sent for a reply to OnOtherGhostTalk itself [disasm Loop 0x6397A2]; "after" goes
  for every run, that reply included [disasm 0x63992F]. So two ghosts that both listen "after" and both answer every
  OnOtherGhostTalk chat on without end, as in ssp.exe; each turn waits for the other's script to end (hgr guards
  itself with `（R3）!=OnOtherGhostTalk` [corpus]; no site ghost listens). Neither broadcast for a replay after a page
  change [decision]. R2's other flags (`sstp-send`, `owned`, `remote`, `ssf`, `notranslate`, `plugin-*`) never apply.
  The listener plays its reply [infer: the listener side was not traced]. SenderType `internal`.
* The loop emits 'talk' `{phase: 'before' | 'after', run, flags}`; the site forwards it (`otherTalkRefs`). 7 archives
  use it [corpus] (ruusa's TalkHook).

#### 2.7.5 `otherghostname` and the others

NOTIFY `otherghostname` (§2.1 #16): one Reference per other ghost that counts as up, `<sakura name in effect>\x01<scope
0 surface>\x01<scope 1 surface>` (−1 when a scope shows none [infer]); none when alone [doc; disasm `NotifyOtherGhost`
0x7071A0]. A ghost counts as up from its NOTIFY batch ('notified'; a resumed ghost from the page's start) until it is
removed. Until its loop is up, a resumed ghost is what its state stored: the sakura and kero names in effect its loop
had (`names`, a shell's override applied; the index's names for an older state stored without them) and its surfaces
(`Site._peerOf`), so the others' `→` aims where it aimed on the last page [decision: SSP has no page change]. Sent in
each batch, and again to every ghost up, **the new ghost included**, once a cold-booting (called, changed-to) ghost's
boot GET has been asked (`Site._onBooted`): SSP's AddGhost posts it (UpdateSakuraFileMapping with flag 8 and no ghost
to leave out [disasm 0x465C40–0x465C4F, 0x733024–0x733051; PostMessageW 0x733045]), then asks the boot event
(TalkBootMessage 0x465CA3 → SendEvent 0x640C1C, synchronous) before SSP reads its messages, so the second one comes
after the boot GET [disasm; infer: the `\0` window that gets it is served by SSP's UI thread]; to every ghost still up
after a close of one (after OnOtherGhostClosed); and to every ghost, the changed one too, after a shell change
(ChangeOrReloadShellInternal posts flag 8 at its end [disasm 0x62177D–0x62178D]; `Site._onShellChanged`, so a shell's
`sakura.name` becomes the name the others' `→` aims at) [disasm `UpdateSakuraFileMapping`]. Not on a resumed page
(each batch already lists the whole set). Not on surface changes: the re-send needs the number of ghosts or another
process's entries to change, or flag 8, and a surface change passes 0 [disasm `UpdateSakuraFileMapping`
0x732FB6–0x733061, `…Impl` 0x733494, 0x73355A, 0x7335C0]. Satori reads it into `（起動しているゴースト数）` (others + 1),
`（隣で起動しているゴースト）` (the **alphabetically first** other sakura name, not the caller), `（起動中ゴースト「X」の存在）`
and the `→` target [S]; its FMO built-ins (`（FMOn…）`, `（Xの存在）`, `（Xのサーフェス）`) read §2.7.8's stand-in.

Not sent: **OnOtherGhostVanished** — nothing is uninstalled in a browser (there is no Uninstall, `\![vanishbymyself]`
only logs) [decision]. For the day a vanish ritual exists: every remaining ghost would get it [R0 the vanished sakura
name, R1 its OnVanishSelected script, R2 its name, R3 its path, R7 the **receiver's** shell], 204 → OnVanished with
the same References and no OnBoot fallback [doc; disasm]. OnOtherSurfaceChange (0 archives), OnOtherOverlap /
OnOtherOffscreen are not done. `%property[activeghostlist.*]` / `ghostlist.*` see the other ghosts through the Site
(`Site.propsFor`, properties.md §5.2). Ghost-to-ghost talk, the FMO and raiseother: §2.7.7–§2.7.9.

#### 2.7.6 The loop's part (`src/core/events.js`)

The loop never sees the site: it gets a `peers` handle (`others()`, `count()`, `busy()`, `match(to)`) and its layer
element, and emits 'call' (`callGhost`, `call` = PlayerHost `\![call,ghost]`), 'quitall' (the menu's Quit; without a
listener it is the ghost's own `close(s, {all: true})`), 'activate' (every press, balloon click, link or drop: the
site takes the keys from the others), 'notified' (right after the NOTIFY batch, cold and resume), 'talk',
'communicate' (§2.7.7), 'raiseother' (§2.7.9) and 'closed' `{script}`; for those two the site answers through
`communicated()`, `raisedByOther()`, `notifyEvent()` and `lockReason`. The site calls `ghostCalling(callee,
{reason})` (resolves once the reply has started), `boot({called})` (returns `{run}`: the boot run, null on a resume or
when nothing played), `notifyOthers()`, `otherEvent(id, refs)` (GET, SenderType internal, origin user; nothing unless
live), `peerInfo()`, `lastScript`, `deactivate()` and `resumeClose()` (a Quit carried to this page, §2.7.3: `closing`
'all' on the resumed loop; it closes when the replayed run, or the newest one that replaced it, ends; at once with
nothing playing; nothing before boot, once closing or closed, while changing or frozen). A press on another ghost's
layer (`.smk-ghost`) takes the keys away; a press on a root-level menu does not (§4.6).

#### 2.7.7 Ghost-to-ghost talk (COMMUNICATE) [disasm SendCommunicate 0x70F620, SPCommunicateData::Send 0x5EA920]

Implemented. A ghost's response can name other ghosts; once the script it came with has played, they get
GET OnCommunicate with it, and a reply that names the first ghost again starts the next turn. That is the whole
conversation mechanism: no loop guard, no cap, no failure event. Also read: SPShiori::Request 0x710140, SPGhost::Loop
0x638FF0, CommunicateSSTP 0x63BD60 / 0x709FE0 [disasm]. The rules of §2.7.7–§2.7.9 are labelled A1–A13, B1–B7 and
C1–C9, as code comments cite them (with the section); these C labels are not SUMMARY's.

What ssp.exe does:

1. **Which responses** (A1): every response with a status that is not 204 and below 400 that goes through
   `SPShiori::Request`: GET and NOTIFY events, OnTranslate, OnCommunicate replies, the communicate box. Not the boot
   NOTIFY batch, `otherghostname`, resource strings or `version` [disasm 0x7101E1–0x7101FF; xref 0x69CE20].
2. **Which headers** (A2): `HWnd` or `TargetHWnd` decide alone (a window handle). Else `To`; `Reference0` (SHIORI
   3.0 and later) counts only when `To` is missing or equal to it (exact compare), and then the References are
   "shifted" [disasm 0x70F66F–0x70F771]. A SHIORI/2.x reply (Kawari 7: the bridge keeps its `SHIORI/2.6` status line,
   `res.protocol`) names its target in `To` only, every Reference passed on unshifted [disasm 2.9.10 SendCommunicate
   0x711878–0x7118c3; kawari7-wasm.md §6.4].
3. **Who** (A3): `__SYSTEM_ALL_GHOST__` as the whole value (any case) = every other running ghost. Else each
   `\x01` token picks the **first** other running ghost (list order) whose **sakura name in effect** matches; never
   the descript or kero name. The compare folds case with SSP's table and skips every character up to U+0020 and
   U+3000 on both sides (`琥珀 あかね` = `琥珀あかね`); no width or kana folding. Unmatched tokens vanish, a name given
   twice gives that ghost twice, the sender is never a target [disasm 0x70F77B, FindOtherGhostHWnd 0x7340D0 → IsMatch
   0x73417D, wcsicmp_printchar 0x5ADF90; Send 0x5EA920].
4. **Nothing** (A4) without a target or without a `Value` / `Sentence` header (an empty one is fine): the pending slot
   is left as it was [disasm 0x70F8CD, 0x70F8DC].
5. **The record** (A5) is made when the response arrives: Sender = own sakura name in effect; Sentence = the raw
   `Value`, before OnTranslate; `Age` = the response's `Age`, else `0` (SSP never adds 1; UKADOC's "+1 per exchange"
   is the SHIORI's job); `Surface` = `<s0>\x01<s1>` now, −1 for a hidden scope (UKADOC: a comma, at send time);
   `Marker` = the response's `MarkerSend`; References = the response's Reference0…, from Reference1 when shifted;
   `X-SSTP-PassThru-*` copied [disasm 0x70F985–0x70F996, 0x70FB42–0x70FBBE, 0x70FC6D–0x70FDAA, 0x70FDFB]. The
   References are SPParamManager::GetValueReference's: every header whose name starts with `Reference` (any case), at
   the index C's `strtoul` reads after it (over 100000: skipped), the list grown with empty entries up to the highest
   index, and each index is sent, a gap as an empty `ReferenceN:`. So a gap keeps the later numbers: Satori drops an
   empty `＄Value2`, and Northern's `＄Value0/1/3/4` still reach the receiver as R4 and R5 [disasm 0x6AEC60,
   0x70FC6D–0x70FDB2; the receiver reads them the same way, GetValueReferenceW 0x73A5B0; corpus].
6. **One pending slot** per SHIORI (A6), overwritten by the next response that has a target, cleared only when taken
   or at unload [disasm: the writers of +0x19AC].
7. **Taken** (A7) by the next script SSP queues for that ghost (`PlayScriptInternal`): a non-empty script on a ghost
   that is not minimized. Normally that is the same response's script; a NOTIFY's or OnTranslate's response with a
   target, or a reply SSP did not play, rides on a later script [disasm 0x63A6B0, 0x63AB02, 0x63A720].
8. **Sent** (A8) when that script ends, after the OnOtherGhostTalk "after" broadcast (§2.7.4), only when the script
   was not broken and the ghost still runs. Broken: a balloon break, a newer script that replaced it, a choice clicked
   while it typed, `\![change,ghost]` in it that finds a ghost. Not running: `\-` anywhere in it. Still sent: a
   script that ends with choices on screen (at once, before the pick), and Quit's goodbye without `\-` (sent, then the
   ghost closes) [disasm Loop 0x63992F < 0x63993B (running) < 0x63995D (Send) < 0x6399A9 (close)]. The change tag
   breaks the script only after GetGhostIDFromTag found a ghost [disasm ExecuteChangeFromTag 0x62AEE3–0x62AEED, then
   BreakScript 0x62AF92]: the ghost itself (its descript or sakura name), an installed ghost not running, `random` /
   `sequential` while a ghost not running is left [disasm GetGhostIDFromTagStatic 0x62A9F0]. An unknown name and a
   ghost running elsewhere are −1 [disasm 0x62A99E, 0x62A9C0]: the script plays on and its talk goes.
9. **Delivery** (A9): target by target in list order, synchronous; results ignored; no failure event, no queue, no
   loop limit [disasm Send 0x5EA920].
10. **The receiver** (A10): a descript `sstp.allowcommunicate` whose ParseBool is not 1 (`0`, `false`, empty,
    garbage) refuses with 420 and its SHIORI is not asked; absent = allowed. Else GET **OnCommunicate** `[R0 the
    sender's sakura name, R1 the sentence, R2… the References]`, `SenderType: external,sstp,communicate`, `Sender:
    SSP`, `SecurityLevel: local`, extra headers `Age`, `Marker` (when given) and `Surface` [disasm LoadDescript
    0x622875–0x6228AF, CommunicateSSTP 0x63BD7E, 0x709FE0; MakeShiori30Request 0x7081A0].
11. **The reply** (A11) is an ordinary script of the receiver: it replaces whatever plays there (a `\t` script, a
    choice menu, a goodbye: no lock test on this path), goes through OnTranslate, and its own target starts the next
    turn. A minimized receiver's SHIORI sees the event; its reply is dropped [disasm 0x63BEC5, PlayScriptInternal
    0x63A720].
12. OnOtherGhostTalk R2 `communicate` / `communicate,break` (A12): §2.7.4. The communicate box needs nothing new (A13):
    its reply's `Reference0` counts like any other response's (§4.8).

Sumika (`src/core/events.js`, `site.js`, `ghostset.js`):

* `EventLoop._request` (the counterpart of `SPShiori::Request`) looks at every response (`communicateOf`) except
  `resource()` / `resources()` (resource strings, `username`), the NOTIFY batch (with `otherghostname`),
  `notifyOthers()`, `notifyUserInfo()` and the `property.get` / `property.set` requests of `….ext.*` properties.
  The targets are resolved at once through the Site (`peers.match` → `communicateTargets`) into ghost ids, and the
  record goes into the loop's one slot. Alone (no peers) nothing is ever filled.
* What takes the slot: `_fire` right after the response, once its reply will play (before OnTranslate, as SSP queues
  first: an OnTranslate response with a target of its own waits for the next script); a `\![raise]` reply, a reply
  that waits for its script (`_deferReply`) and one a shell swap holds, when they are queued; `playScript` and a
  choice's `script:`. A reply that does not play (a tick reply while talking) leaves the slot for the next script, as
  in SSP. A replay uses the record saved with its run.
* Sent at the run's end (`_onRunEnd`), right after the 'talk' after event: when the run ended `end` (choices on screen
  too), did not fail and did not ask `\![change,ghost]` for a ghost it found, and the loop is neither closed nor
  frozen, the loop emits 'communicate'. Whether the change tag found a ghost is the runtime's `_changeFinds`
  (`loop.ghostFinder`, `resolveGhostTarget` as the change itself: this ghost, or one not on screen; `random` /
  `sequential` while one is left), asked at the tag. The record is taken off the run either way, so it goes at most
  once (a finished run kept for its choices cannot send it again). A Quit's goodbye passes its talk on, then the ghost
  closes.
* The Site (`_onCommunicate`) waits for the starts of the ghosts up (`_upSettled()`: a resuming page's ghosts, a ghost
  past its NOTIFY batch; a listener's OnOtherGhostTalk reaches its SHIORI before a talk aimed at it [decision; SSP's
  thread order is unknown]), then delivers to each id in order, one at a time. A ghost still loading its engine is
  not waited for (it is no target yet), and a ghost up for at most `Site.upWaitMs` (30 s) from when it counted as up
  [decision]: a resumed ghost whose load stalls with no error is then no target until it is up, so no start that never
  ends holds a talk for good. An id no longer on screen, or not `_liveSlot`, is skipped. The receiver's `communicated()` is A10–A11 (`notifyEvent`, origin `other`).
* Who can receive (`_liveSlot`): on screen in this tab, booted, not closed; a closing ghost counts.

| Case | ssp.exe | Sumika |
|---|---|---|
| the sender's script ends with `\-` | not sent | not sent (reason `quit`) |
| the sender's Close-of-one goodbye without `\-` (it stays, C22) | sent | sent |
| the sender's Quit goodbye without `\-` | sent, then it closes | the same |
| the sender's script asks `\![change,ghost]` for a ghost found (itself, one not running) | broken, not sent [disasm 0x62AF92] | not sent; after-flag `break` |
| … for an unknown ghost or one running elsewhere | not broken: sent [disasm 0x62AEED] | the same |
| the receiver says its goodbye (Close) | delivered; the reply replaces the goodbye, so a Close then leaves it standing [infer for the effect] | the same [decision: as ssp.exe] |
| the receiver is in `\t`, passive or induction mode | delivered, the reply cuts in | the same [decision] |
| the receiver is minimized | asked, the reply dropped | the same |
| the receiver closed before delivery | not in the list: skipped | skipped |
| the receiver is in a ghost change | in the list until DeleteGhost [not traced] | not a target [decision: Sumika's change is a state machine (§2.5) and a reply there is untested] |
| the receiver's slot changed to another ghost in between | [not traced] | the id no longer matches: dropped |
| a frozen slot (another tab holds that ghost) | — | not a target [decision] |

Browser decisions:

* No windows: a response with `HWnd` or `TargetHWnd` (and a Value) empties the slot and sends nothing [decision;
  disasm for the precedence]. No corpus ghost sets them [corpus].
* `X-SSTP-PassThru-*` are not forwarded [decision]: they only echo SSTP requests (emily4's framework echoes request
  PassThru headers back), and a browser has no SSTP.
* `MarkerSend` goes on as the request header `Marker`; it is not drawn in the receiver's balloon (how SSP draws it was
  not traced; Sumika draws no SSTP marker) [decision]. Only K3R and syoko set it [corpus].
* A page change: the record rides with its run (`d.run.communicate`, plain JSON); the next page replays the run and
  passes the talk on at its end, once the set has settled [decision: a link followed while Katari greets Tsubasa
  should not lose the answer]. Lost on a page change [decision; each lasts milliseconds]: the slot before a script took
  it, a talk whose run ended but whose delivery waits for the set, an OnCommunicate the receiver's engine is answering
  (its reply dies with the page, like any reply). A takeover by another tab is a resume.
* No Age arithmetic, no loop guard, no cap [disasm, 9 above; decision: no limits that SSP lacks]. A balloon break, a
  Close or a reply without a target ends a conversation.
* Not copied: a reply that starts with `\C` is queued by SSP without a break [disasm 0x63A753]; Sumika's replaces the
  run, so the talk of the run it replaced is lost (older than this; not fixed). OnTranslate's R1 flags
  (`communicate` …) are still never sent (§4.12).

Satori's side [src]: `→` at the start of a talk's first line sets `Reference0` and `To` to the first `otherghostname`
name that prefixes the rest of the line, else the first name (code-unit order); with no other ghost the arrow is
dropped [satori_sentence.cpp:254–279, satori_EventOperation.cpp:564–573]. `＄Value0` sets `Reference0` only
[satori_builtin.cpp:2616–2627]; `＄返信ヘッダ「X」` sets any response header. Its built-in OnCommunicate answer searches
`＊<R0>「` heads, falls back to `＊COMMUNICATE該当なし`, and stops a loop (no `→`, a line already exchanged); a ghost's
own `＊OnCommunicate` replaces all of it, guard included, and a reply's `＄Value0` gets past the guard [:403–432].
Satori never writes `Age`. Anything but `SecurityLevel: local` blocks `set`, `call` … [satori_builtin.cpp:138–154]:
Sumika always sends `local`.

Ghosts made to talk [corpus]: Tsubasa greets her neighbour with `→`; Katari sends `＄Value0 （ランダムコミュ相手）` (a
random FMO partner, §2.7.8) or `__SYSTEM_ALL_GHOST__`, and Nato answers her lines word for word; roommate greets
`（隣で起動しているゴースト）` and answers with `＄Value0 （Ｒ０）`; emily4 and NodePsimoon (YAYA) have protocols of their own.
In the archives 98 Satori ghosts send with `→`, and 54 ghosts with `＄Value0` or YAYA's `res_reference0`. Pairs to try:
`ghost-pairs.md`. Tests: `tests/runtime/interact_loop.test.mjs` (the loop), `interact.test.mjs` (end to end),
`site.test.mjs`, `ghostset.test.mjs`.

#### 2.7.8 Satori's FMO view (a stand-in) [disasm GetFMOString 0x623420; src satoriFMO.cpp, SakuraFMO.cpp]

Implemented. Satori's `（FMOn<key>）`, `（Xの存在）` and `（Xのサーフェス）` read SSP's shared FMO, the list of
running ghosts. A browser has none, so the page hands Satori the same text (patch P8, `satori-wasm.md` §8).

What ssp.exe and Satori do:

1. (B1) Two shared blocks with the same text, `Sakura` (ANSI) and `SakuraUnicode` (UTF-8); Sumika's Satori (Mc203-6)
   reads `SakuraUnicode` first [disasm CreateFMO 0x727990; src SakuraFMO.cpp:53–58].
2. (B2) Every running ghost of that SSP is in it, **the reader included**; temporary ghosts are left out; minimized,
   passive and closing ghosts stay. A booting ghost comes in at `AddGhost` (after its NOTIFY batch, before its boot
   talk) and goes at `DeleteGhost` [disasm 0x623420–0x62345A, AddGhost 0x465C37, DeleteGhost 0x732060].
3. (B3) Lines `<id>.<key>\x01<value>\r\n`; id `ssp_fmo_header_<pid %08lx>_<sakura hwnd %08lx>` (the plain text, not a
   digest); keys in this order: `path`, `hwnd`, `name` (sakura name in effect), `keroname`, `sakura.surface`,
   `kero.surface`, `kerohwnd`, `hwndlist`, `ghostpath` (the ghost's root, trailing separator), `fullname` (descript
   name), `modulestate` (`shiori:running`). A surface is −1 when that scope shows nothing [disasm 0x63C528, 0x62342D,
   0x623934, 0x6E98A0].
4. (B4) Rewritten at once at every boot, close, ghost change, shell change and every `\0` / `\1` surface change; a
   surface change does not re-send `otherghostname` (§2.7.5) [disasm OnSurfaceChange 0x6407BB → CMainFrame msg 0x29
   → UpdateSakuraFileMapping(0) 0x46A581]. (The 250 ms debounce belongs to another window, CHelperMainWnd [disasm
   0x453A15].)
5. (B5) Satori reads it again at each of those built-ins. It maps the lines by id (id text order), drops ids with
   `ssp_fmo_header_dummyentry`, `SSTPVIEWER-` or `SSSB`, puts the entry whose `ghostpath` + `ghost\master\` is its own
   folder at index 0 and the rest after it in id order. A line whose value is empty, or holds another `\x01`, is
   dropped. When no FMO can be read, the old list stays [src satoriFMO.cpp:15–55, SakuraFMO.cpp:48–81,
   stltool.h:291–330].
6. (B6) `（Xの存在）` = 1 when `Xの存在` starts with any entry's `name` or `keroname` (the reader's too: a prefix, so
   `（なと太郎の存在）` is 1 while なと runs); `（Xのサーフェス）` = that entry's `sakura.surface` / `kero.surface`, else
   −1; `（FMOn<key>）` = entry n's value or `""` (n = 0 is the reader). `（起動しているゴースト数）`,
   `（隣で起動しているゴースト）` and the `→` target use `otherghostname`, not the FMO [src satori_builtin.cpp:1605–1680].
7. (B7) The archives' Satori (Mc159-6) took the count, the neighbour and the `→` target from the FMO [disasm
   kanade_2nd's satori.dll 0x1001F880, 0x1001F96E]. So the FMO's other entries must be the ghosts of the last
   `otherghostname`, or `（FMO（乱数１～count－１）name）` (Katari, Nato, BAKU) reads empty names.

**The stand-in's text** (`src/core/fmo.js` `fmoText`): the reader first, then `peers.others()` in slot order, the list
`otherghostname` is made from (so B7 holds). Per ghost the id `ssp_fmo_header_00000000_<8 hex>`, 0 for the reader and
1, 2 … for the others (Satori's id order is then slot order), and the keys in SSP's order: `path` `/ssp/`, `name`,
`keroname`, `sakura.surface` and `kero.surface` (−1 when none), `ghostpath` `/` for the reader (Satori's base folder is
`/ghost/master/`, so it finds itself) and `/ssp/ghost/<id>/` for the others (the layout YAYA ghosts see), `fullname`,
`modulestate` `shiori:running`. CR, LF and `\x01` in a value become a space; a line with an empty value is left out
(Satori drops it anyway).

* Left out [decision]: `hwnd`, `kerohwnd`, `hwndlist` (only SatoPaku and KokonToUzai read them, for SAORIs that cannot
  work in a browser; Sumika's `NOTIFY hwnd` gives every ghost the same pseudo handles, so any value would be made up);
  other processes' ghosts and dummy entries (one "process" per page); frozen slots (their ghost runs in another tab).
* When: made for every request of a Satori ghost as the request leaves the client's queue (always current, surfaces
  included, as SSP's rewrite), and posted to the worker only when it differs from the last text that engine got, so
  OnMouseMove floods do not carry it (`shiori.js`, `worker.js`, `SatoriEngine.setFmo`; CONTRACTS "Worker
  protocol"). Not with `init` [decision]: during load SSP's FMO holds the others but not yet the reader; Sumika's holds
  nothing until the first request (`GET version`), so a talk inside load (`＊OnSatoriLoad`) sees an empty FMO. After an
  engine restart the next request sends the text again. None once the ghost closed or its loop was torn down (a page
  restart, a slot removed): a request still queued then reads no text, and `peerInfo()` never makes a character view
  (a scope its stage lacks is −1), so nothing is drawn on a stage that is gone.
* Only Satori ghosts read it [decision: YAYA's `READFMO` fails cleanly, `yaya-wasm.md`; no corpus need]; a YAYA ghost
  is still listed in a Satori ghost's FMO, as in SSP.
* Order with three or more ghosts: slot order [decision]. SSP's is its window handles', usually
  boot order but not always (B3, B5). One order for both views keeps B7 true and is stable; it differs from SSP's only
  after a ghost change in a slot that is not the last. `（隣で起動しているゴースト）` keeps Mc203-6's code-unit order
  [decision: neither order matches SSP's exactly].

Corpus: 51 Satori archives use the FMO built-ins: `（FMO0name）` (own sakura name) for the property reply of 20 ghosts
(§2.7.9), Katari's, Nato's and BAKU's random partner, `（Xの存在）` in 19 (Katari's 呼び出す asks whether a ghost is
already here), `（Xのサーフェス）` in 2 [corpus]. Tests: `tests/runtime/fmo.test.mjs`, `tests/satori_fmo.test.mjs` (the
real wasm), `interact_loop.test.mjs`, `interact.test.mjs`.

#### 2.7.9 `\![raiseother]`, `\![notifyother]` and the timers [disasm ExecuteRaise 0x632E80, ExecuteRaiseReal 0x633430]

Implemented. `\![raiseother,ghost,event,r0,…]` raises an event in other ghosts, `\![notifyother,…]`
notifies them; `\![timerraiseother,ms,repeat,ghost,event,…]` and `\![timernotifyother,…]` do it later.

What ssp.exe does:

1. The tag goes to `ExecuteRaise`; without `timer` it is posted to the main thread and run there by
   `ExecuteRaiseReal`. **The raiser's script does not wait.** Several tags run in tag order (C1) [disasm
   0x6333F5–0x633401; infer for the FIFO].
2. Arguments (C2): `\![raiseother]` alone fails with R0 `invalid` only. An empty event with a ghost given fails with two
   References: R0 `invalid` when that argument finds a ghost (`random` and `lastinstall…` too), else `notfound`; R1 the
   argument. The References after the event end at the first empty one, one space = empty (SS §3.4) [disasm 0x6334AB,
   0x633517, 0x634153–0x6342C7, 0x633548].
3. Targets (C3): `random` (the whole value, any case) = one running ghost at random, the raiser possible;
   `lastinstall…` = the last installed ghost if it runs; `__SYSTEM_ALL_GHOST__` (whole, any case) = every running
   non-temporary ghost, **the raiser included**; else each `\x01` token: a **descript name** match first, then a sakura
   name match (the first in list order; an exact case-folded sakura match beats one with spaces skipped); never the kero
   name; the compare of §2.7.7 [disasm 0x6338EA–0x633AE5, FindActiveGhostArrayFromName 0x731090, 0x7311E5–0x731221,
   0x7314F8–0x731533].
4. Per target in order (C4): the raiser is skipped **silently**; inside `\t` → `timecritical`; induction mode →
   `inductionmode`; passive mode → `passivemode`; minimized → `minimized`; else the event: GET for raiseother (its
   reply plays on the target and cuts what it says) or NOTIFY for notifyother (the reply is ignored and never fails). A
   GET whose reply has no script fails with that response's status (`204`, `200` for an empty Value …). Nothing else
   refuses: not talking, choosing or closing [disasm 0x633BB3–0x633F42, IsLocked 0x642660, OnNotifyEvent
   0x640070–0x6402CD].
5. The target's request (C5): `Sender: <the raiser's sakura name>`, `SenderType: internal`, `SecurityLevel: local`, the
   References as given [disasm 0x633810–0x633864, after SPShioriEvent::Clear 0x63380B]. Satori's `（Sender）` gives
   that name.
6. No target at all (C6): one failure, R0 `notfound`, R1 the ghost argument exactly as given [disasm
   0x633B1B–0x633BAE].
7. After the loop, if anything failed (C7): one GET **OnRaiseOtherFailure** / **OnNotifyOtherFailure** to the raiser
   `[R0 the reasons, R1 the failed ghosts' sakura names (both \x01-joined), R2 the event, R3… its References]`,
   `SenderType: internal,raise`, `Sender: SSP`; its reply plays on the raiser. Targets that worked are not listed
   [disasm 0x633F48–0x634080, 0x633FF1].
8. Timers (C8; `\![timerraise]`, `timernotify`, `timerraiseother`, `timernotifyother`): one list per ghost keyed by
   the **event name, any case, shared by all four tags** (the same event replaces whichever timer had it); `ms` 0
   cancels; 1–49 ms become 50; `repeat` is SSP's ParseBool: 1 (`1`, `2`, `true`, `on` …) = once, anything else (`0`,
   `false`, empty, garbage) = every `ms`. The other forms need ms, repeat, a ghost and an event, else they are ignored.
   The target is looked up again at each fire (a target gone: `notfound` each time). Timers die with the raiser; a
   shell change keeps them [disasm 0x632E80–0x632FAE, 0x632FBC, ParseBool 0x789660, ~SPGhost 0x61B3A5; infer for the
   shell]. This amends SUM C3 (its numbers stand) and SS §6.6. A timer is a multimedia timer (`timeSetEvent`,
   periodic unless once [disasm SetTimer 0x632AF0]); its callback skips a periodic tick while the raiser's thread is
   not ready and retries a once-timer in 500 ms [disasm SPGhostTimerFunc 0x632B40]. A periodic timer under 1000 ms
   raises **inside the callback** (ExecuteRaiseReal), once-timers and longer periods are posted to the main thread
   [disasm ExecuteRaiseTimer 0x632B8D–0x632BC2]; a cancel kills the timer at once (timeKillEvent [disasm
   0x632A8E]). So a short repeating tick cannot start while the last raise runs (the timer thread is in it), no queue
   of raises builds up, and nothing fires after a cancel.
9. Corpus (C9): raiseother in 27 archives (94 tags); none uses notifyother, the timer forms or the failure events.
   kanade_2nd's tea party raises to `__SYSTEM_ALL_GHOST__` and Tsubasa and Katari answer; 20 Satori and 4 YAYA ghosts
   answer the property protocol with `（FMO0name）` (§2.7.8) [corpus].

Sumika:

* The player hands the four tags to the loop (`raiseOther`, `timerRaise` with `to`) and goes on; a replay skips them.
  The loop emits 'raiseother' `{ghost, id, refs, notify}`, also when a timer with a target fires. The Site
  (`_onRaiseOther`) runs the raises one at a time in the order asked, for the whole page (1), each once the ghosts up
  have started (`_upSettled()`: a resumed page's ghosts are up first, so a timer that came due during the page change
  and fires at the resume's boot reaches them; a takeover's ghost still waiting for its lock too). A ghost still
  loading its engine (a call's callee before its NOTIFY batch) is no target yet and is not waited for, as SSP raises
  at once; a ghost up is waited for at most `Site.upWaitMs` (30 s, as a SHIORI request that takes longer counts as
  hung) from when it counted as up [decision: SSP has no page change to wait for]. So a resumed ghost whose load
  stalls with no error is no target until it is up, and no start that never ends holds the raises for good.
* A repeating timer with a target fires again only once the Site is done with its last fire (`live` / `done` on the
  event): no backlog when the target answers slower than the period, and a fire still waiting when the timer is
  cancelled or replaced, or the raiser closed, is dropped (8). A one-shot goes through the queue as asked (SSP posts
  those). [decision for periods of 1 s and more: SSP posts each of those ticks and could queue them; Sumika keeps one]
* Candidates: the raiser and every other `_liveSlot` (§2.7.7), in set order. The implicit one-ghost Site has the raiser
  alone: a lone ghost raising an unknown name gets OnRaiseOtherFailure `[notfound, …]`, its own name or ALL nothing.
* Per target 4–5 through its loop's `lockReason` and `raisedByOther()` (`notifyEvent`, origin `other`: the reply cuts
  what that ghost says, even a goodbye or a choice menu [decision: as ssp.exe]). A ghost inside `\t`, in
  passive or induction mode or minimized is not raised at all: `lockReason` refuses it first (4: `timecritical` …), as
  SSP. Only OnCommunicate reaches a `\t` script (§2.7.7). The failure event 7 goes through the raiser's
  `notifyEvent()`.
* Timers: `EventLoop.timerRaise` does 8 for all four tags. A stored timer keeps its `to`, so it survives a page change
  (SUM C4) and fires on the next page.

Browser decisions:

* `lastinstall…` finds nothing (`notfound`) [decision: nothing is installed in a browser, as for calls, §2.7.1]; with
  an empty event it is `invalid`, as in SSP.
* A target that closed or changed while an earlier target answered is skipped silently [decision: SSP keeps its ghost
  list locked through the loop]. A ghost in a ghost change and a frozen slot are no candidates (§2.7.7).
* The failure event goes to the loop that asked, as it was at the tag: a raiser that closed (`\![raiseother,…]\-`) or
  changed ghosts meanwhile gets nothing, and its successor never does; the targets still get the event (SSP checks no
  state of the raiser) [decision for the failure event]. A slot showing the raiser's ghost again (after an engine
  restart or a takeover) counts as the raiser and is never raised.
* `\![timerraiseother|timernotifyother,ms,repeat,ghost,]` (an empty event) is ignored like a missing one; SSP would
  store a timer that fails `invalid` at each fire [decision; no corpus ghost uses the timer forms].
* Lost on a page change [decision; each lasts milliseconds]: a raise waiting in the Site's queue, a raised event the
  target's engine is answering. The timers are kept.
* The ghost sweep runs a bare EventLoop without a Site: a raise there goes nowhere and no failure event appears
  (`ghost-sweep.md`). The plugin forms (`\![raiseplugin]` …) are still not sent (§4.10).

Tests: `tests/sakura/player_other.test.mjs`, `tests/runtime/interact_loop.test.mjs`, `site.test.mjs`,
`ghostset.test.mjs`, `interact.test.mjs` (the tea-party pattern, failures, notifyother, the queue, a timer across a page
change).

### 2.8 Vanish (P2)

Menu "vanish" (shown if `vanishbutton.visible` is not `0`) → `GET OnVanishSelecting` → play. Confirm dialog: Yes →
`GET OnVanishSelected` → play (double-click during it → `GET OnVanishButtonHold [R0 script, R1 scope, R2 char offset]` and
abort). No → `GET OnVanishCancel`. On completion: delete the stored profile and engine files. The next ghost gets
`OnVanished [R0 sakura name, R1 the OnVanishSelected script, R2 ghost name, R7 shell]`. Tsubasa defines the master-only
set [T dic02_Event.txt:653–792]. Satori aliases them to 消滅指示/消滅撤回/消滅決定/消滅中断 [S FindEventTalk]. With other
ghosts on screen they get OnOtherGhostVanished (§2.7.5). Never sent: there is no Uninstall [decision].

### 2.9 First-boot detection (P0)

`OnFirstBoot` if the store has no `ghost:<id>:state` and no persisted engine files. Otherwise `OnBoot`. R0 = number of
times this ghost was vanished in this browser (store it at vanish time; `0` by default). Satori's save file is separate,
and the site ships without it (ARCHITECTURE).

### 2.10 Reloads: `\![reload,…]` (P2; implemented) [disasm ssp.exe 2.9.10]

Read in 2.9.10's disassembly:

**The tag.** `\![reloadsurface]` (command id 0x18) is one whole word in any case; `rel` (0x19) is a 3-letter prefix in any
case whose sub-table holds shiori 0x5e, makoto 0x3d, shell 0x5c, balloon 0x08, ghost 0x2f, descript 0x21 and aigraph
0x02, each a whole word in any case [disasm SPGhost_LookupExclCmd 0x62d770, table 0xbbd448, sub-table 0xbbd2e0;
SPGhost_FindExclName 0x62d830: flag bit 0 wcsicmp, else wcsnicmp over the entry's length]. Both ids reach one handler
(jump table 0x632d1c → 0x631399), which first needs IsSafeScript (0x62c500: bit 0x4 of +0x428c clear, so an SSTP script
or an untrusted one that OnTranslate rewrote cannot reload); `reloadsurface` is `reload,shell`
(ChangeOrReloadShellInternal(-1, false) at 0x6313a8); the dispatch on the sub id is 0x6313be–0x631446, and the common exit
runs ResetWait (0x632cf0; an unsafe script skips it, 0x632cf7) for every sub-command, an unknown one too: a `\__w`
after the tag counts from the tag's end. Sumika (`ScriptPlayer._bang`, `EventLoop.reload`): shiori, shell and balloon
hold the script at the tag until done, then ResetWait; ghost never holds it; the others reset at once.
[decision]s: only the word `reload` (as `change`; no corpus ghost spells it otherwise); no IsSafeScript gate (as
properties.md decision 6: taken literally it would refuse every ghost whose OnTranslate answers); `\![reload,makoto]`,
`\![reload,descript]`, `\![reload,aigraph]` stay no-ops (unknown tags).

**`\![reload,shiori]`**, synchronous at the tag [disasm ReloadShioriFromTag 0x61e140 → LoadUnloadCommandFromMainThread(0xb),
then (9); SendMessageMainThreadAPC 0x61e113 off the main thread; LoadUnloadCommand 0x61dfc0: 10/11 → UnloadShiori(cmd ==
11), 8/9 → LoadShiori(cmd == 9), jump table 0x61e0a0]:
1. UnloadShiori(true) 0x622190: NOTIFY OnDestroy [R0 `reload`] (0x6221c9, 0x622219), then the DLL's unload(). A ghost's
   own unload sends R0 `''` (ModuleUnloadDirectly 0x620c56 calls UnloadShiori(0)).
2. LoadShiori(true) 0x621e30 loads it again (falling back to other paths), then NotifyInitialEvents(false, true) 0x621a20
   (0x621fe3): NOTIFY OnLanguageChange (0x621a45), NOTIFY OnInitialize [R0 `reload`] (0x621af9, 0x621b00),
   NotifyEnvironment (ownerghostname, basewareversion, …), useorigin1, the SHIORI's version / name / craftman,
   OnNotifyUserInfo, otherghostname, display, wallpaper, the folder lists; because of the reload (0x621ff3–0x62213a) the
   installedghost / balloon / shell / headline names, the installed plugins, OnNotifyDressupInfo (NotifyBindInfo),
   uniqueid, hwnd and OnSurfaceChange for every character.
3. No boot event and no event of its own: ssp.exe has no `On*Reload*`, `OnReloaded` or `OnShioriReload` string; only
   OnInitialize and OnDestroy carry `reload`. The script goes on.
`\![unload,shiori]` / `\![load,shiori]` from a tag carry `reload` too (LoadUnloadShioriFromTag 0x61e160 issues 0xb / 9),
and post UpdateSakuraFileMapping(4), which does not re-send otherghostname (§2.7.5) [disasm 0x61dfd9, 0x46b5fd]: still
no-ops in Sumika.

Sumika: `EventLoop.reloadShiori` queues NOTIFY OnDestroy [`reload`], calls the runtime's `shioriReloader`
(`Runtime._reloadShiori` → `ShioriClient.reload`: inside the client's request queue the worker unloads, storing the files
first, the worker goes and a new one loads from the store), then queues GET version, the boot batch of §2.1 with
OnInitialize [R0 `reload`] and OnSurfaceChange per character shown, all at once: the client sends them to the new engine,
and anything asked meanwhile (ticks, clicks) waits behind them. The batch keeps Sumika's boot order (version first,
OnLanguageChange after capability, §2.1 #10a), not 2.9.10's (OnLanguageChange first, version after the environment)
[decision: one batch]. A cold load [decision]: no volatile state; Kawari's snapshot is the unload's
empty marker (D7); `bootEpochMs` stays the ghost's, so Satori's since-load starts at the reload as at ssp.exe's load, and
a later page change resumes it from the ghost's cold boot again, as after a crash restart. The pending COMMUNICATE goes
with the old engine (§2.7.7). LoadShiori asks no menu look (LoadGhostCore does, §5.1), so none is asked [disasm]. A load
that fails: the queued batch answers 500 and the engine restarts from the store as after a crash (`_onCrash`, inside its
3-in-10-minutes limit) [decision]; a teardown meanwhile starts nothing.

**`\![reload,shell]`, `\![reloadsurface]`**: ChangeOrReloadShellInternal(-1, event false) 0x623040, -1 = the shell in use
and the reload path of LoadShell (0x6230d1–0x6230d7) [disasm]: the lazy binds go out (ProcessLazyCommandExec 0x623120),
Status `changing` (+0x41a4 = 1, 0x623125), the shown surfaces remembered (PushSurfaceStatus 0x623131), the settings saved,
the balloons hidden (HideBalloons 0x62315e), the same shell loaded with its saved dress-up and its own balloon (LoadShell
0x6231e3); SendMessage 0x1c8(2) sends OnNotifySelfInfo and OnNotifyShellInfo (0x623322; NotifySelfInfo's flags 0x70f29e),
0x1c9(1) installedshellname (InitShellMenu → NotifyInstalledShell, 0x62333c). No OnShellChanging (the change message is
never sent) and no OnShellChanged (only `if (event)`, 0x62335c). PopSurfaceStatus (0x62349d) brings the remembered
surfaces back and `changing` ends; otherghostname to every ghost (post 0x27 / 8, 0x6234ed); ResetWait (0x62352b); the script
goes on on the reloaded shell. Sumika: the swap of §2.6 with the shell in use and `event: false` (`Runtime._changeShell`
`reload`): a new stage of the same shell, the places and the per-shell dress-up kept, the NOTIFYs of every swap
(OnNotifySelfInfo, OnNotifyShellInfo, OnNotifyDressupInfo, installedshellname), the surfaces restored, `{t:'view'}` to the
other tabs, otherghostname to every ghost (several ghosts). In the change slot like a script's change (§2.6 "Changes in a
row"). It is no pick: `shellChosen` stays as it was [decision; ssp.exe's SaveShellSetting stores the shell anyway, which
only SSP's own next start reads].

**`\![reload,balloon]`**: ChangeOrReloadBalloonInternal(-1, event false) 0x622da0 [disasm]: -1 = the balloon in use
(0x622dca), false when the index is out of range (0x622ddb: none); LoadBalloon(idx, true) re-skins (0x622e47); `balloon`
stored in the ghost's settings and the shell's (AddValueW 0x622ec9, 0x622eee); NotifySelfInfo(1) sends OnNotifySelfInfo
(SendMessage 0x1c8 / 1, 0x622f07); no OnBalloonChange (only `if (event)`, 0x622f0d–0x622fd1); ResetWait (0x62301d).
Sumika (`Runtime._changeBalloon` `reload`): the balloon in use re-skinned in place (`_swapBalloon`, event false), stored as
the choice for the ghost and the shell (the site default too: ssp.exe stores what it loaded), NOTIFY OnNotifySelfInfo; the
built-in balloon (no folder): nothing, false.

**`\![reload,ghost]`** [disasm ReloadGhost 0x6209e0]: the lazy binds go out (0x6209e3), then the ghost posts a ghost change
to its own id with mode 6 (PostMessage 0x8010 / 0x2a, `(id & 0xffffff) | 0x6000000`). The tag returns and the script runs
on until the main thread deletes the ghost: CSakuraWnd::OnSSPSysMsg case 0x2a (0x49a42d) → CMainFrame::OnSSPSysMsgGhostChange
0x46be40: the same id (0x46bf60, 0x46bf69), the window positions saved (SaveWndPos 0x46c0ec), DeleteGhost (0x46c150; the
cache skipped for its own id) → ModuleUnloadDirectly → NOTIFY OnDestroy [R0 `''`] and the unload; WaitAndExitGhostThread
0x639310 orders the ghost's thread to exit (TerminateThread after 200 ms), so the rest of the script is cut. OnChangeMessage
is bypassed: no OnGhostChanging, no OnClose. LoadGhost(id) (0x46c569) loads it cold (OnInitialize [R0 `''`]); mode bit 0x2
makes AddGhost use flag 2 (0x46c6e9–0x46c704), which skips TalkBootMessage (0x466d08: no OnBoot, OnFirstBoot,
OnGhostChanged or OnGhostCalled), and PlayScriptWithMsg(`\e`, 7) plays; AddGhost still runs UpdateFileMapping(flags | 8)
(0x466cbf: otherghostname to every ghost) and activates the windows (0x466dc7); mode bit 0x4 skips a second activation
(0x46c74e). No OnOther* event: the 0x3E handler (OnOtherGhostChanged) does nothing when the new ghost's previous id
(+0x485c, set at 0x46c62b) is its own (+0x1420) (0x49a7a9–0x49a7ba); OnOtherGhostClosed comes only from
OnSSPSysMsgGhostClose (0x46bd6d).

Sumika: `EventLoop.reloadGhost` sends the pending dress-up report, then emits `change` {kind `ghost`, its own id, byId,
`reload: true`}; `Runtime._change` with `reload` is a change to the ghost itself (§2.5) without the farewell: the lock
kept, `leave()` (OnDestroy [R0 `''`], the unload; it interrupts the script, so a few ms more of it may show, as within
ssp.exe's 200 ms [infer]), then a cold boot with `silent` (`EventLoop.boot({silent})`: the NOTIFY batch, the surfaces, no
boot event; the default surfaces shown). Its clock starts again (`bootEpochMs`: a cold load). With others on screen:
otherghostname to every ghost (the re-NOTIFY of any cold boot, `Site._onBooted`), no OnOtherGhostChanged, and it comes on
top. A page left meanwhile carries nothing: the next page resumes the ghost and owes no OnGhostChanged [decision]. Not
done [decision]: the `\e` ssp.exe plays after the load (so no OnSurfaceRestore is pending until a script ends).

Corpus [measured: the text entries of the test ghost archive]: `\![reload,shiori]` in
bee (then 「リロードしました。」), cyau_cyaka, flele, maya, mobilemaster, raychel_kisekae and ria (YAYA), Aria and firefox
(Kawari OpenKEEPS menus); `\![reload,ghost]` in kuruka (Satori, 15 places: it switches its characters by changing
`＄辞書フォルダ`, then reloading, e.g. `1/dic0.txt:8–10`), PikuandNanika (Satori, text after the tag), maya and ria;
`\![reload,shell]` in maya and ria; `\![reloadsurface]` in cyau_cyaka. bee passes `\\![reload\\,shell\\]` as an
OnCommunicate Reference. Tests: `tests/sakura/player.test.mjs`, `events.test.mjs`, `shiori_client.test.mjs`,
`view_switch.test.mjs`, `switch.test.mjs`, `multi.test.mjs` (`reload`).

---

## 3. Clock events

### 3.1 Ticker (P0)

* One tick per wall-clock second. Schedule `setTimeout` to the next `1000 - Date.now() % 1000` ms; do not use a drifting
  `setInterval`.
* Do not catch up missed ticks (throttled background tabs). One callback = one tick.
* Start after the boot or resume sequence has been **sent** (the boot greeting makes the first ticks NOTIFY). Stop on
  close.
* Per tick: build the shared refs, send `OnSecondChange`. If the local wall-clock minute changed since the previous tick,
  send `OnMinuteChange` right after it, in the same tick. Order Second → Minute is ASSUMPTION; [L 4849–4885] shows
  OnMinuteChange between two OnSecondChange requests.

### 3.2 `OnSecondChange` (P0)

| Ref | SSP meaning [U-ev] | Browser value |
|---|---|---|
| R0 | OS uptime, whole hours | `floor((Date.now() - sessionStartMs) / 3.6e6)`. `sessionStartMs` is stored in `sessionStorage` on the first page of the tab. Nobody reads it: Satori and Tsubasa ignore it. |
| R1 | `1` if the ghost is off-screen ("見切れ"), else `0` | ssp.exe's collision rect of scope 0 (§3.2.1), not its image, not fully inside the desk (edges inclusive) → `1`, as last sampled on an odd second [disasm Check 0x420ec5, scope 0 only 0x421019]. Other scopes never count (Tsubasa deliberately moves them off-screen [C `\![move,-500…]`]). Satori skips random talk while `1` unless `＄見切れてても喋る`. Tsubasa reacts to changes through her own `OnSecondChange` [T dic03_Menu.txt:1545]. |
| R2 | `1` if the ghost's characters overlap each other ("重なり") [U-help config-ghost] | the collision rects (§3.2.1) of scope 0 and scope 1 intersect (strictly) → `1`, as last sampled; other scopes and other ghosts never count [disasm Check 0x420c44–0x420d3e]. Satori stores it, nothing reads it. |
| R3 | `1` if a talk can play now, else `0` | `cantalk` from 1.6 (an open box is no part of it: §1.6) |
| R4 | seconds of OS-level inactivity (SSP only) | whole seconds since the last `pointerdown/pointermove/keydown/wheel/touchstart` on the page. Keep the timestamp in `sessionStorage` so it survives navigation. |

Method: `GET` if R3=`1`, else `NOTIFY` (the reply is ignored) [U-ev; L 990 vs 1260; I time_event.js]. All refs are
decimal ASCII.

#### 3.2.1 The collision rect (見切れ・重なり) [disasm ssp.exe 2.9.10]

ssp.exe does not test R1 and R2 on the image. `CCharWndCodeManager::Check` 0x420a10 tests each character's
**collision rect**, a box of its drawn pixels shrunk to 80 % (SH §6.9). The whole base rectangle would report
見切れ about 30–70 px early at the sides and whenever the viewport is shorter than the image (Tsubasa's 380 px;
ssp.exe holds out until about 333), and 重なり when transparent margins touch.

* **When.** `CMainFrame::OnTimerMain` (timer 1, 1000 ms) calls `CCharWndCodeManager::TimerExec`, which jumps to
  `Check`, only when the local `wSecond` is odd, and before the ghosts' `CSakuraWnd::TimerExec` sends this tick's
  `OnSecondChange` [disasm 0x467d1d–0x467d42, 0x467e03]. So R1 / R2 are re-sampled every 2 s and keep their last
  values in between; a ghost starts with 0. Sumika: `EventLoop._sampleCollisions` in the ticker's timer, before
  `_tick`, whatever the tick does (also when a slow reply skips it). Every page's loop starts again at 0, for up to
  2 s [infer: ssp.exe has no page loads]. ssp.exe also zeroes the reported R1 200 ms after a display change (timer 6,
  `ResetMikireState` 0x420900); a browser has no counterpart, so that is not done.
* **Which windows.** Every character window of every ghost, its rect from `SPSeriko::GetCollisionRectCharVirtual`
  (scope). An entry counts only when its window is visible (not `\s[-1]`, not hidden) and its rect is not empty
  (left < right and top < bottom) [disasm Check 0x420a84–0x420ab3, `JRect::IsEmpty` 0x578960]; one that does not
  takes part in neither test. A blank surface (Tsubasa's 4×4 surface 10, hayato's `\1`) never counts.
* **R1.** An entry of scope 0 whose rect is not inside any monitor's work rect: inside means W.l ≤ R.l, W.t ≤ R.t,
  R.r ≤ W.r and R.b ≤ W.b, so touching the edge is still inside [disasm 0x420ec5, `IsNot_AllInWorkRect` 0x6a2c00,
  `IsContainedInAny` 0x578240, `IsInRect` 0x578440; scope 0 only 0x421019]. In the browser the one monitor is the
  desk, `Stage.desk()`: the layout viewport, without scrollbars (UI §3). A stage without `desk()` falls back to the
  window's viewport, and with neither (headless without a window) R1 stays 0.
* **R2.** Two entries of the same ghost whose scopes add up to 1 (so scope 0 and scope 1) whose rects intersect
  strictly: l < o.r, r > o.l, t < o.b, b > o.t [disasm 0x420c44 `IsIntersect` 0x5780b0, same ghost 0x420c57, scope
  sum 0x420d29–0x420d3e]. A `\p[2]` over `\0`, or another ghost, never counts.
* **The rect.** `SPSerikoAnimation::GetCollisionRectVirtual` 0x6faa90 takes the collision box of the base the
  character shows (the one its animation thread last processed, else its surface's), adds the surface origin's place
  in the window canvas (+0x338 / +0x33c, SH §6.9), scales each side by |scale x| / |scale y| with truncation and never
  mirrors (`ScaleRectNoMirror` 0x6dcdd0), and adds the window's screen position (`SAGetWindowPos` 0x6dcf10). With no
  base or window every side is -32767, an empty rect. Sumika: `CharacterView.collisionRect` (CONTRACTS "Shell"); the
  base rect stands in for SSP's window, mirrored or not, and the box is the `\s` surface's, not that of an animation's
  `base` frame [infer].
* **The box** is made once per surface at shell load and never changes with surface changes, animations or dress-up
  (SH §6.9). So only the choice of surface, the window's place and the scaling move the rect.
* **Not done.** The Ghost page's options "ignore 見切れ" / "ignore 重なり" (playerApp +0x14d9 / +0x14da, both off by
  default) send R1 / R2 as 0 [disasm NotifyTimeChangeEvent 0x641cc4, 0x641cfc]; Sumika has no such options. When a
  flag changes, `Check` also plays the legacy entries `#kasanari`, `#mikire` and `#mikirezu` through
  `SPGhost::PlayEntry` (SPScript / SPPiro dictionaries, not SHIORI) [disasm 0x421248–0x421298], and the same pass sends
  `OnOverlap`, `OnOffscreen`, `OnOtherOverlap` and `OnOtherOffscreen` (P2, §4.14), which would use these rects too.

Results of the rule on real shells (regression values from the rule, not yet compared on screen with ssp.exe):

| Shell, surface | Image | Collision box (surface px) |
|---|---|---|
| Tsubasa 0 | 220×380 | (69,47)–(181,341), 112×294 |
| Tsubasa 11 (music box) | 90×150 | (8,14)–(74,126): under 50 px high, the fallback |
| Tsubasa 12 (playing, no image) | — | (12,18)–(74,126) |
| Tsubasa 10 (blank `\1`) | 4×4 | empty: never counts |
| mayura 0 | 471×460 | (131,63)–(411,415), 280×352 |
| mayura 10 | 148×128 | (17,25)–(125,115) |
| bthver.5 0 | 348×645 | (98,92)–(210,554) |
| emily4 0 | 253×385 | (38,66)–(204,348) |

### 3.3 `OnMinuteChange` (P0)

Same five refs and the same GET/NOTIFY rule [U-ev]. Tsubasa uses it for time signals (`＞（現在時）時（現在分）分`) and
an hourly affection bump [T dic02_Event.txt:1347]. Because a NOTIFY reply is discarded, a time-signal talk is lost if a
script is playing at :00. SSP has the same limitation; `OnHourTimeSignal` (P2, waits until it can talk) exists to avoid
it, and Tsubasa does not use it.

### 3.4 Balloon timeout, choice timeout, `OnSurfaceRestore` (P0)

SSP defaults: talk timeout ("喋りタイムアウト") **15 s**, choice timeout ("選択肢タイムアウト") **30 s**, click-wait timeout
**none** [U-help config-talk]. The 2.02 log measured about 15–16 s from talk end to `OnBalloonTimeout`, and again from
there to `OnSurfaceRestore` [L 4691→5080→5382]: about 30 s from the talk's end in all, as the rule below gives.

```
on script end (player 'done'):
   if the balloon shows choices and the script had no \* and the choice timeout is not 0/-1:
        arm choiceTimer(script.choiceTimeout ?? 30000)
   else arm balloonTimer(script.balloonTimeout ?? 15000)   // \![set,balloontimeout,ms]; 0/-1 = never
   // SSP also counts scripts with no visible text ([L 5715]: OnBalloonTimeout for "\0\s[0]\1\s[10]\e").
   // Sumika pauses the countdown while the pointer is over a balloon or the tab is hidden [decision]; never for a box (below).
choiceTimer fires:  close balloons; fireScriptEvent('OnChoiceTimeout', [scriptText])            // P0, Tsubasa defines it
balloonTimer fires: close balloons; fireScriptEvent('OnBalloonTimeout', [scriptText, '0'])       // P1, R1 "remaining time": always 0
any new script start, or a balloon closed by the user: cancel both timers (re-armed by the next script end)
```

**What stops these two timeouts in ssp.exe 2.9.10** [disasm]:

- **One timer, armed only at a script's end.** `GetCharBalloon(0)->StartWaiting(ms, isChoice)` takes the script's
  choice timeout (SPGhost+0x3bc) or balloon timeout (+0x3b8, skipped while IsNoInterrupt) [disasm DecodeProcReal
  0x62c231–0x62c249, 0x62c250–0x62c27e]. ms < 0 arms nothing; 0 means the default, Timeout.Select 30 s or
  Timeout.Balloon 15 s [disasm 0x72819f / 0x7281a9]; ms > 0 is the script's own and sets balloon+0xa91. Then one
  `SetTimer(id 0x3e9)` on \0's balloon [disasm StartWaiting 0x5d1a90–0x5d1b3b, SetTimer 0x5d1b35]. StartWaiting has
  no other caller.
- **Passive mode arms none, induction mode does**: StartWaiting skips the timer when SPGhost+0x41a8 >= 2 (1 is
  induction, 2 passive) [disasm 0x5d1b04–0x5d1b13; AddStatusText 0x639b5b–0x639b8a].
- **Nothing pauses or re-arms it.** The timer id (balloon+0xa8c) is touched only by the constructor, StartWaiting,
  DoWaiting, DisableTimeoutTimer and CMessageWnd::OnTimer's id test [disasm every +0xa8c access].
- **Hover, checked only at expiry.** OnTimer calls DoWaiting(pointer inside = balloon+0xa78) [disasm 0x4720d9–0x4720f3].
  DoWaiting kills the timer first (EndWaiting 0x5d1b8d); if the pointer is inside, the timeout is the default
  (+0xa91 == 0) and Balloon.NoTimeoutMouseOver is on (playerApp+0x33cd, default 1 [disasm 0x72822b, 0x7283fb;
  key read 0x72aa72]), it returns: no event, the balloon stays, the timeout is gone for good [disasm 0x5d1b92–0x5d1baa].
  WM_MOUSELEAVE only clears +0xa78 [disasm WindowProc 0x47261f–0x472648]. A script's own timeout fires regardless,
  and only \0's balloon (the timer's) counts.
- **At expiry**: a choice timeout NOTIFYs OnChoiceEnter when an item is selected, then GETs OnChoiceTimeout; with no
  script, `PlayEntry('#timeout alternate')`, else BalloonClose. A balloon timeout GETs OnBalloonTimeout, then
  BalloonClose [disasm DoWaiting 0x5d1c65–0x5d1cf3, 0x5d1d8c, 0x5d1dac, 0x5d1e34, 0x5d1e5d].
- **Dragging or scrolling the balloon cancels it** for good: DisableTimeoutTimer [disasm EX_OnMouseMove 0x4714e0–
  0x4714fd, ScrollBalloonMsg 0x472a82].
- **Minimize, a choice pick, a break, a closed balloon or a new script end it** (EndWaiting's callers: ChoiceSelect,
  BreakScript, BalloonClose, ClearBalloons, SPGhost::Loop, DoWaiting, HideBalloons <- MinimizeAll) [disasm].
- **An open input, communicate or teach box changes nothing.** DoWaiting and OnTimer read no box; SPGhost+0x4198 (the
  box bits, UpdateInputMode 0x63e620) is read only by AddStatusText [disasm 0x639c2e–0x639cfb]; CreateInputBox makes a
  modeless CInputWnd (CreateMe, ShowAndSetFocus -> ShowWindow) with no modal loop and calls none of EndWaiting,
  DisableTimeoutTimer or HideBalloons [disasm 0x49b1ab–0x49b221, 0x49b27a]. The box is its own window, so pointing at
  it is not balloon hover [infer].
- **Menus and modal dialogs keep WM_TIMER running**, so the timeout fires under them [infer: RunModalLoop's unfiltered
  PeekMessageW 0xaf5a2e (§1.6); TrackPopupMenu's loop is documented Win32 behaviour, not traced].

Sumika pauses on hover (over any balloon, for any timeout) instead of dropping at expiry, does not cancel on a drag or
a scroll, and pauses while the tab is hidden [decision]; it does not pause for a box
(`_postPaused`). Not traced: DecodeProcReal arms no timer when no balloon is visible (IsBalloonVisible 0x62c20f) and
reads a local flag at [ebp+0xb], which may contradict the [L 5715] note above.

A script's `\![set,balloontimeout]` and `\![set,choicetimeout]` last until the next script starts, except one whose
first two characters are `\C`: it keeps them, so a `\C` reply to a balloon held by `\![set,balloontimeout,0]` stays
held [disasm PlayScriptInternal 0x63c883–0x63c8a2 sets play flag 0x30; DecodeProcReal 0x628f3b resets SPGhost+0x3b8 /
+0x3bc only without 0x20, at 0x628fdf / 0x628fe5]. SSP tests only those two characters: a `\C` behind other tags
(the lenient append of SUM §2.2) resets them in Sumika too [decision].

**`OnSurfaceRestore`** has no timer of its own. Read in ssp.exe 2.9.9.3000's disassembly [disasm] and
done that way in `src/core/events.js` (`_stampRestore`, `_surfaceRestore`, `_restoreHeld`). The rule
"15 s after OnBalloonTimeout, only if cantalk, cancelled by a new script or a closed balloon" is not ssp.exe's: with it,
Nato's first boot, broken at its `\x`, left her hidden for minutes [observed in Sumika].

- **The stamp.** When a script stops, SSP notes the time and marks the restore pending [disasm SPGhost::DecodeProc
  0x628d92–0x628dc6]. This happens for:
  - every script that plays to its end, even an empty one: the end-of-script YenE sets the "showed something" flag
    [disasm 0x62bf9f];
  - a script that is broken or replaced (a balloon break, a click's reply, a choice picked mid-script, a cut `\x`), only
    if it had shown something first: text, a marker, a choice or anchor, an image, a surface change or an animation
    [disasm writers of SPGhost+0x1d78: AddString 0x5ccd90, AddMarkerIcon 0x5cd9cc, AddSelectableString 0x5cdbf3,
    AddAnchorOrSelectable 0x5cdf59, AddImage 0x5d2062, SERIKO PlayBase / PlayCommand / PlayPatternArrayInternal].
    PlayCommand sets the flag on entry [disasm 0x6f9092], so these count too, on a character whose window exists:
    `\![bind]` (queued and played at the next wait, text, bind or the end: ProcessLazyCommandExec 0x63e8b0; Sumika
    counts it at the tag [infer]), `\4` / `\5`, `\![move]`, `\![moveasync]` (and its cancel),
    `\![set,alignmenttodesktop|alpha|scaling|balloonoffset|balloonalign]`, `\![lock|unlock,repaint|balloonmove]`,
    `\![enter|leave,selectmode]` and every `\![anim]` (ControlAnimeChar → PlayPatternArray) [disasm callers of
    PlayCommand 0x6f9060]. Sumika: `PlayResult.shown` (`ScriptPlayer._seriko`). `\n`, `\_l`, `\b`, waits and the
    balloon options (`\![set,balloontimeout|balloonwait|autoscroll]`) do not count;
  - never the script OnSurfaceRestore returned (play flag 0x8000) [disasm 0x628da2–0x628dae].

  A new script does not cancel a pending restore. It holds it back while it plays and stamps again at its end; one
  broken before it showed anything leaves the old stamp.
- **The check.** On the 1-second tick, after OnSecondChange / OnMinuteChange. If one of their replies started a script,
  the tick ends there [disasm CSakuraWnd::TimerExec 0x49803f, 0x498158]. OnSurfaceRestore is sent when
  [disasm 0x498244–0x498310]:
  - more than (Timeout.Balloon + 15) s have passed since the stamp. Timeout.Balloon is SSP's global talk timeout
    (default 15 s), so 30 s. A script's own `\![set,balloontimeout,N]` does not change it [disasm 0x49826f–0x4982b4];
  - the tick's local clock second is 10–50, both included [disasm 0x4982ba–0x4982cb];
  - nothing holds it (next item).

  So by default it comes **30–51 s after the script stopped**, whatever the balloon does. When the pointer keeps the
  balloon up, it can come before OnBalloonTimeout [infer: the tick never looks at balloons].
- **Held, never dropped.** It waits, and SSP looks again every second, while: a script plays (a `\x` wait too), `\t`, a
  choice menu is up, a shell change, the ghost is closing or changing, minimized, passive or induction mode, and the
  last script's `\![set,balloontimeout,0]` (any value ≤ 0: never; a script that starts with `\C` keeps it, above)
  [disasm 0x497e37–0x497e8a, 0x498165, 0x4982d9–0x498300; OnSurfaceRestore 0x6426e2]. SSP also waits for an SSTP
  quiet count and SSF playback (Sumika has neither).
  An open box or a hidden tab does not hold it, and cantalk plays no part [disasm for the box: TimerExec and its
  restore path read no box state, SPGhost+0x4198 is read only by AddStatusText (§1.6); infer for the hidden tab]. A
  browser may run a hidden tab's tick only about once a minute; the restore then comes at the first tick that lands in
  the window [infer].
- **What clears it:** only OnSurfaceRestore itself, before the request, so a 204 is not retried [disasm 0x642715]; the
  ghost's exit (`\-`, Close, a ghost change) [disasm ExitInstance 0x63f64f]; a ghost brought back from SSP's cache.
  OnBalloonTimeout, OnBalloonClose, OnBalloonBreak and choices never touch it [disasm].
- **The request.** GET, SenderType `internal`, R0 = `\0`'s surface id, R1 = `\1`'s; -1 for a scope whose window is not
  shown or does not exist [disasm GetCurrentSurfaceIndexIntChar 0x6eb770]. Its reply plays (origin `restore`: dropped
  when another script started meanwhile) and never stamps again. On 204 SSP does nothing: no surface reset of its own,
  no retry. Its `#return<N>to0` fallback works only for materia "compatible mode" ghosts [disasm 0x6427ff–0x642824].
- **Boot.** A cold boot has nothing pending until its boot script ends [disasm SPGhost ctor 0x61cb1a]. Sumika clears
  the stored stamp in the cold boot's first save, before the engine loads, so a page left meanwhile resumes nothing.
- **Page change** (Sumika only): the stamp is saved in the ghost state (`surfaceRestoreAt`) and resumed, as SSP's ghost
  would keep running [decision]. A run replayed after it had already ended does not stamp again. A finished run that
  `\![set,balloontimeout,0]` keeps up is replayed, so its hold goes on [decision].

| Case (default settings) | OnSurfaceRestore |
|---|---|
| a script ends; its balloon times out | 30–51 s after its end, about 15–36 s after OnBalloonTimeout |
| OnBalloonBreak (balloon double-click) | 30–51 s after the break, if the script had shown something |
| OnBalloonClose (an idle balloon closed) | no effect: on time from the end of that script |
| a script ends with `\-` | never |
| choices, OnChoiceTimeout | held while the menu is up, then at the next tick in the window (usually at once) |
| `\x` | held while it waits; a cut (a click's reply, a break) stamps at that moment |
| its own reply | never stamps again |

Nato's first boot [observed in Sumika]: `\1\s[10]\0\s[-1]\n\1（冷蔵庫を開けた。）\x…` keeps `\0` hidden until after the
click-wait. A double-click ends the `\x` and breaks the rest before `\0\s[0]` (OnBalloonBreak). The break stamps, and
30–51 s later Satori answers OnSurfaceRestore (R0 -1, R1 10) with `\0\s[0]\1\s[10]`: she appears
(`tests/runtime/surface_restore.test.mjs`, on the real Satori build with her dictionaries).

Side findings, not checked further [disasm]: OnBalloonTimeout carries one Reference in 2.9.9.3000 (DoWaiting
0x5d1e34–0x5d1e42; Sumika sends R1 `0`, §4.9); a double-click while waiting at `\x` or on choices is a click there
(CMessageWnd::BreakScript 0x47217b–0x4721a4; Sumika breaks a run waiting at a second `\x`); a single click closes an
idle balloon with OnBalloonClose (EX_OnLButtonUp 0x471b9f–0x471bd6; Sumika does it on the double-click); after `\x`
without `noclear`, when the rest shows nothing, SSP sends OnBalloonClose (DecodeProcReal 0x62a4c2–0x62a517).

Tsubasa does not define `OnSurfaceRestore`, so Satori's default replies with `\0\s[<デフォルトサーフェス0>]\1\s[…]` and
`\p[99]\s[…]` for extra scopes [S satori_tool.cpp:surface_restore_string]. That returns her face to neutral after a
talk. **P0.**

### 3.5 What Satori does with a tick (for engine tests and expectations)

From [S satori_EventOperation.cpp], in order:

1. R1, R2 and R3 are stored as `mikire_flag`, `kasanari_flag` and `can_talk_flag`. `OnSecondChange` also increments
   `（最終トークからの経過秒）`.
2. Mouse hold: if a left `OnMouseDown` (R5=0) was seen more than 1000 ms ago and is not finished, run
   `＊<R3><R4>ホールド`. After `OnMouseUp`/`OnMouseDragEnd`, run `＊<R3><R4>ホールド終了`, delayed until not `talking`.
   Tsubasa defines no ホールド talks [T].
3. Unless step 2 produced a script: if the dictionary defines `＊OnSecondChange`, run it. **Tsubasa does**: it counts her
   presence seconds `計測秒` and reacts to R1 changes [T dic03_Menu.txt:1545]. This happens on every tick, GET or NOTIFY.
4. Every `＄名前タイマ` counts down by 1, and the auto-save interval counts down.
5. Only if the script is still empty **and R3 != "0"**:
   1. the first timer at ≤0 fires (`＊名前`, else `＊OnSatoriTimer`) and is removed;
   2. else, if not off-screen (R1) or `＄見切れてても喋る`: decrement petting/wheel session timers, then `--talk_interval_count`.
      Below 0, run `OnTalk` (Tsubasa master: `＊OnTalk` [T dic12_Base.txt:7]; other folders use unnamed `＊`);
   3. else `＊OnSatoriSecondChange`.
6. Any 200 reply that "speaks", or a random talk, resets `talk_interval_count` to `喋り間隔 ± 誤差%`. So any talk, including
   user-triggered ones, postpones the next random talk.

### 3.6 Consequence for page navigation (P0 design issue)

The values in step 5 are C++ members that are not saved: `talk_interval_count`, `nade_count`, `koro_count`,
`mousedown_*` and `second_from_last_talk`. They restart on every `load()`. `（単純起動秒）`, which Tsubasa uses for
hold-to-close, is time since `load()`. Timers (`＄…タイマ`) **are** saved unless `＄タイマ変数はセーブしない`
[SD shiori/random-talk.md], so they survive. See Q1.

---

## 4. Input and UI events

### 4.1 Common mouse References (P0)

For OnMouseClick/DoubleClick/MultipleClick/Up/Down/Move/Wheel/EnterAll/LeaveAll/Enter/Leave/DragStart/DragEnd/Hover and
their `Ex` variants [U-ev]:

| Ref | Value |
|---|---|
| R0, R1 | pointer x, y in the character's **local surface pixels**: `floor((clientX - rect.left) / scale)` (integers; origin at the surface's top-left) |
| R2 | wheel: rotation (4.4). Move/Drag: `0`. Others: always `0`. |
| R3 | scope id: `0` sakura, `1` kero, `n` for `\p[n]`. Tsubasa uses 22, 99, 100, 101, … [T dic14_Mouse.txt]. |
| R4 | collision id under the pointer from surfaces.txt `collision*`, or `""` when none |
| R5 | Click/Up/Down: `0` left, `1` right, `2` middle (compat). Ex events: `middle`, `xbutton1`, `xbutton2`. DoubleClick, Drag: `0`/`1`. Move/Wheel/Enter/Leave/Hover: `0`. |
| R6 | `mouse` / `touch` / `pen` / `eraser` from `PointerEvent.pointerType` (`pen` with `buttons & 32` → `eraser`) |
| R7 | MultipleClick only: click count (≥3) |

Mouse events go only to opaque pixels of a character: pixel hit-test, as SSP windows are alpha-shaped. Never send them
during `\t` (1.6). They are sent while talking, with `Status: talking` [L 4097].

`OnMouseGesture` has References of its own (§4.5.1): R1 and R3 are window-local `x\x01y` pairs, not scaled to surface
pixels [disasm SendGestureEvent 0x418850].

### 4.2 Button sequences (P0)

From [L 3948–4117] and [U-ev]:

```
left press  #1 : GET OnMouseDown (R5 0)
left release#1 : r = GET OnMouseUp (R5 0);   if 204: GET OnMouseClick (R5 0)
left press  #2 within dblclick time and 4 px : GET OnMouseDoubleClick (R5 0)    // replaces OnMouseDown for this press
left release#2 : r = GET OnMouseUp;          if 204: GET OnMouseClick
right press/release: same with R5 1; after OnMouseClick(R5 1) returned 204, open the runtime menu (5.1)
middle:  GET OnMouseDownEx (R5 "middle") then GET OnMouseDown (R5 2)
         r = GET OnMouseUpEx; if 204: r = GET OnMouseClickEx; if 204: r = GET OnMouseUp (R5 2); if 204: GET OnMouseClick (R5 2)
xbutton1/2: Ex events only (R5 "xbutton1"/"xbutton2")
middle double-click: GET OnMouseDoubleClickEx (R5 "middle")
3rd+ quick click: GET OnMouseMultipleClick (R7 n); if 204 continue as a plain click (P2)
```

* Double-click time: 500 ms; distance: 4 px (Win32 defaults; ASSUMPTION for the exact values).
* Right-click menu suppression is ASSUMPTION: SSP's exact rule is undocumented. Tsubasa answers right clicks when her
  `右クリック使用` option is on [T dic14_Mouse.txt:2961], so "menu only if OnMouseClick(R5 1) returned nothing" keeps both
  working. Always `preventDefault()` the browser context menu over characters.
* Middle-click order and duplication is ASSUMPTION. [U-ev] documents both the compat `R5=2` on the plain events and the
  `middle` Ex events. Tsubasa's ホイクリ reactions need `OnMouseClick` R5=2 [T dic14_Mouse.txt:2961ff].
* SSP has a "middle-click substitute key" option (modifier + left click = middle) [U-help config-ghost]. Recommended:
  **Alt+left click** = middle (P1). This matters for touchpads.
* Touch: a long press of 500 ms counts as a right click (DECISION, P1).
* A right press that is moved 4 px or more is a gesture (§4.5.1): while the right button is held no OnMouseMove is sent,
  and its release sends OnMouseUp (R5 1) and OnMouseGesture `end`, no OnMouseClick and no menu [disasm OnEXRButtonUp
  0x41ac6a–0x41ad3c]. A right press with no such step keeps the sequence above.
* Tsubasa needs all of this: the menu character `\p[99]` (one-touch menu on click of `R3==99`; close on hold of `Mclose`),
  her games (`R3` 22/100/101), right and middle click on `Head`/`Ponytail`/… [T dic14_Mouse.txt:2947–2986], and
  `OnMouseDoubleClick` → `（Ｒ３）（Ｒ４）つつかれ` (main menu) [T dic03_Menu.txt:1115].

### 4.3 Move, enter, leave, hover

| Event | When | P |
|---|---|---|
| `OnMouseMove` (GET) | pointer moved over an opaque pixel of a scope. **At most one per animation frame**, coalesced, and only when the local position changed. Keep sending while talking: Satori filters with Status. | P0 |
| `OnMouseEnterAll` / `OnMouseLeaveAll` (GET) | pointer enters or leaves a scope's opaque area. Refs as at that point. | P1 |
| `OnMouseEnter` / `OnMouseLeave` (GET) | collision id under the pointer changes. `""` (no collision) counts as an id. | P1 |
| `OnMouseHover` (GET), then the `tooltip` resource (GET) | the pointer has rested (the tooltip's initial delay, 500 ms [win32]) on a **named** collision that differs (any case) from the one asked last (reset by a rest off any collision and on leaving the window) [disasm CCharWndCode::ToolTipDispInfo 0x41fa90]. OnMouseHover: the mouse References, its reply plays; not inside `\t` (IsNoInterrupt); SSP sends it nowhere else. The text: the shell's own `<scope>.tooltips` line first (SH §2.16; the ghost is then not asked), else GET `tooltip` [R0 x, R1 y, R2 0, R3 scope, R4 collision, R5 0], shown as the tooltip (UI §4.8). Tsubasa: `tooltip` → `（call,（Ｒ３）（Ｒ４）ツールチップ）` [T dic*:16454] (her `\p[99]` panel: "Show menu" …). | implemented |
| `OnMouseGesture` (GET) | a right-button drag (the middle button never makes one), §4.5.1 [disasm] | implemented |

Order observed in [L 1405–1443, 3536–3555, 4173–4193]:

```
entering:  OnMouseEnterAll(R4 c) → OnMouseEnter(R4 c) → OnMouseMove…
crossing:  OnMouseLeave(R4 old) → OnMouseEnter(R4 new)
leaving:   …OnMouseMove → OnMouseLeave(R4 c) → OnMouseLeaveAll(R4 c)
```

Satori's petting (なでられ) default [S EventOperation OnMouseMove; SD shiori/default-behaviors.md] applies only when the
dictionary has no `＊OnMouseMove`, which is Tsubasa's case:

```
nade_valid_time = ＄なでられ持続秒数 (default 2)
++nade_count[R4]; if (nade_count[R4] >= ＄なでられ反応回数 (default 60)):
    if Status contains talking|induction|passive|timecritical and not ＄トーク中のなでられ反応: no talk
    else talk ＊<R3><R4>なでられ  (or ＊なでられ時の反応 if ＄なでられ時実行イベント says so)
    nade_count = {}
nade_valid_time is decremented only by idle OnSecondChange ticks (3.5 step 5.2); at 0 → nade_count = {}
```

Tsubasa defines dozens of `＊0<Collision>なでられ` talks (`0Headなでられ`, `0Cheekなでられ`, …) [T entries.txt]. **P0.** At a
60 Hz frame rate this takes about 1 s of continuous stroking, which is comparable to Windows `WM_MOUSEMOVE` rates
(ASSUMPTION).

### 4.4 Wheel (P0)

`GET OnMouseWheel` per wheel event over a scope. **R2 = rotation in Win32 units: +120 per notch away from the user
(scroll up), −120 per notch toward the user.**

```js
// WheelEvent -> notches; deltaMode 0 = pixels, 1 = lines, 2 = pages
const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
acc += -px;                                    // up = positive
while (Math.abs(acc) >= 100) { send(Math.sign(acc) * 120); acc -= Math.sign(acc) * 100; }  // ~100 px per notch (Chrome/Windows)
```

Tsubasa: `＞（Ｒ３）（Ｒ４）ころころ	（Ｒ２）>115||（Ｒ２）<-115` [T dic13_Game.txt:7341], so the value must be a full notch.
Satori's own wheel default (when no `＊OnMouseWheel`) needs 2 events on the same collision within 3 idle seconds
[S EventOperation].

### 4.5 Drag (P1)

Left-drag beyond 4 px on a scope: `GET OnMouseDragStart` (R5 0/1). The character follows the pointer. On release:
`GET OnMouseDragEnd`. **No OnMouseUp/OnMouseClick after a drag** (ASSUMPTION). Not sent in passive mode [U-ev]. Tsubasa
(date dictionary) re-positions cherry trees on `OnMouseDragEnd` with R3 9 or 10 [T date/dic14_Mouse.txt:2641].
Persist the new position.

A right drag never moves the character and sends no OnMouseMove while the button is held: it is a gesture (§4.5.1)
[disasm OnEXMouseMove 0x417e55–0x418077].

### 4.5.1 Gestures: `OnMouseGesture` (P2; implemented) [disasm ssp.exe 2.9.10]

Read in ssp.exe 2.9.10's disassembly: `CCharWndCode::OnEXMouseMove` 0x417a20, `SendGestureEvent` 0x418850,
`OnEXRButtonDown` 0x41a820 / `OnEXRButtonUp` 0x41ac60, `JPoint::Degree` 0x5779d0, `JPoint::DegreeToDirection8`
0x577a70. bonsyou (its main interaction: right-drag left and right across the bell), emily4 (her skirt), 07_words,
sancyome, kanade_2nd, mobilemaster and raychel_kisekae use it [corpus].

1. **Only the right button.** OnEXMouseMove picks its branch by the window's last button message (+0x13c), which
   `CCWC_WindowProc` sets for every down, up and double-click message: 0x201 (left) is select mode or drag-to-move,
   0x204 (right) the gesture. Middle (0x207), X (0x20b) and the double-click messages (0x206 …) fall through to the
   OnMouseMove path, so moves with the middle button held, or during a right double-click's second press, send
   OnMouseMove and no gesture [disasm 0x418cd5–0x418cf0, CCWC_IsMouseDownEvent 0x418230, 0x417b6a–0x417b8a, 0x417be9,
   0x417e55]. (An earlier §4.3 said "right or middle": wrong.) A pen's barrel button arrives as the right
   button: the WM_POINTER handlers only record the device (+0x138: pen 2, eraser 3) and leave the rest to Windows,
   which promotes barrel contact to WM_RBUTTONDOWN [infer: OnCWPointerDown/Up/Update 0x419f40–0x41a0eb].
2. **Right press** (OnEXRButtonDown): last message 0x204; the step state reset (run count 0, the 8 sector counters 0,
   last sector −1, the touch wheel flag 0); InitDragValue: the reference point = the cursor (screen, +0x160), the
   press point = the cursor in the window (+0x180, R3), the press collision = the collision there or "" (+0x188, R4);
   unless `\t`, GET OnMouseDown (R5 `1`); SetCapture, so the steps go on off the shape [disasm 0x41a82b–0x41a913,
   0x41aab5–0x41ab4e].
3. **Step.** Each WM_MOUSEMOVE while the right button is held: d = the Euclidean distance from the reference point
   (screen px); only d ≥ GetSystemMetrics(SM_CXDRAG) (4 by default, inclusive) is a step. A shorter move is ignored
   and the reference stays; on a step the reference moves to the cursor, whatever the sector. No timer: no time limit,
   no minimum speed [disasm 0x417e61–0x417e8d (JPoint::Distance = hypot), 0x417eba–0x417ec2].
4. **Direction.** deg = atan2(ref.y − cur.y, cur.x − ref.x) in degrees, in [0, 360) (screen y flipped: 0 right,
   90 up); a step along an axis is exactly 0, 90, 180 or 270; otherwise fpatan / π, + 2 when negative, × 180. Sectors,
   lower bound inclusive: [22.5, 67.5) `right_up`, [67.5, 112.5) `up`, [112.5, 157.5) `left_up`, [157.5, 202.5)
   `left`, [202.5, 247.5) `left_down`, [247.5, 292.5) `down`, [292.5, 337.5) `right_down`, otherwise `right` (the
   name table at 0xD39940). Every step has a sector [disasm 0x5779d0, 0x577a70, bounds 0xB8B4F0–0xB8B528].
5. **Runs.** A step in the sector of the step before adds 1 to the run count and to that sector's counter (an `up`
   step also records its x, a `down` step its x). The name is sent when the count reaches exactly 3, the 4th step in a
   row (16 px or more), once per run. A step in another sector starts a new run: count 0, the touch wheel flag 0, no
   event [disasm 0x417ec5–0x417f18, 0x41804b–0x41805b].
6. **Circle.** At a repeated step, when all 8 sector counters are non-zero (since the press or the last circle), they
   are cleared and the name becomes `circle.cw` when the x of the last `down` step is greater than the x of the last
   `up` step, otherwise `circle.ccw`, in place of a direction due at that step. The two x values are not reset by a
   press [disasm 0x417f1f–0x417f57].
7. **The request:** GET OnMouseGesture (SecurityLevel local, SenderType internal) with the References below; nothing
   under `\t` (IsNoInterrupt). The reply plays (OnNotifyEvent → PlayScriptWithMsg); SendGestureEvent answers whether
   the reply's Value was non-empty, played or not [disasm 0x418850–0x4189d8, OnNotifyEvent 0x6421d0, 0x642451–0x64245a].
8. **While the right button is held** no OnMouseMove is sent (so none of the OnMouseEnter / Leave / EnterAll / LeaveAll
   that live in that path), and the character never moves (no OnMouseDragStart / End) [disasm 0x417e55–0x418077].
9. **Release** (OnEXRButtonUp): last message 0x205; unless `\t`, GET OnMouseUp (R5 `1`, the collision at the release
   point); then, when any step happened since the press (last sector ≠ −1), GET OnMouseGesture `end` (R1 / R2 at the
   release point, R6 0) and the click flag (+0x260) is set, so WM_CONTEXTMENU sends no OnMouseClick and no menu opens.
   `end` comes even when no direction was named. Under `\t` neither event [disasm 0x41ac6a–0x41ad3c; OnCWContextMenu
   0x41ae3e / 0x41ae61; OnCWContextMenuSSP 0x41af02–0x41af1b → 0x41b0aa].
10. **Touch** (WM_TOUCH): one finger is the left button (OnEXTouchDown → OnEXLButtonDown), two fingers drag the
    window; touch moves reach OnEXMouseMove with its touch flag, and make gestures only in the right state (0x204).
    There an `up` (or `down`) gesture whose reply had no Value sends 3 × OnMouseWheel (+120 / −120) at the press
    point and sets the wheel mode (+0x57c); every further step of that run then sends one OnMouseWheel, until the
    sector changes. Mouse and pen never do this. OnEXMouseWheel accumulates its delta (here a whole notch each time,
    so R2 is 120), looks the collision up at the press point and arms a 250 ms timer; its device argument is −1, which
    OnMouseEvent resolves from GetMessageExtraInfo [disasm OnCWTouch 0x41bdd0–0x41bfdb, OnEXTouchMove 0x41c1e0–0x41c21b,
    0x417f5c–0x41802c, OnEXMouseWheel 0x419590, OnMouseEvent 0x640bc5]. UKADOC says the same of the wheel [doc UKADOC:ev].
11. **Neither the balloon nor collisions matter.** The code lives in the character window only; any press that reaches
    it (an opaque pixel) can start a gesture, R4 may be "", and the capture keeps the steps coming outside the shape.
    The collision lookups (GetCollisionNameChar → SPSerikoAnimation::GetCollisionName) test shapes only, no alpha
    [disasm 0x6e9f00, 0x6fffc0–0x700053].

| Ref | Value |
|---|---|
| R0 | scope (`%d`, made at window init) |
| R1 | the cursor now in the window, `x\x01y` (integers): window-local, **not** scaled to surface pixels as the other mouse events' R0 / R1 are (OnMouseEvent's ScaleMousePtChar 0x640d15) |
| R2 | the collision there, or `""` |
| R3 | the press point in the window, `x\x01y` |
| R4 | the press's collision, or `""` |
| R5 | `right_up` `up` `left_up` `left` `left_down` `down` `right_down` `right` `circle.cw` `circle.ccw` `end` |
| R6 | the step's angle, truncated (`__ftol`); `0` for `end` |

```
right press    : GET OnMouseDown (R5 1)
moves          : GET OnMouseGesture(left) … GET OnMouseGesture(right) …   no OnMouseMove, no drag
right release  : GET OnMouseUp (R5 1), GET OnMouseGesture(end)             no OnMouseClick, no menu
  (no step)    : GET OnMouseUp (R5 1), GET OnMouseClick (R5 1), the menu   (§4.2, SUM C26)
```

The ghosts read it so: bonsyou's own comment says `r0 0/1  r1 Mouse  r2 MouseHit  r3 Start  r4 StartHit  r5
direction`; it collects R5 and rings at `end` when its first two names hold `left` and `right` (either order), then
not again until its OnSoundStop (§4.17) clears `GongLock`. emily4 calls `OnMouseGestureCall<R0><R4>_<names so far>` (her
`Skirt`: `left`, `right`, `left_up`, `right_up`, `up` lift it) and erases her arrays at `end`; the aya_lilith framework
(mobilemaster, raychel_kisekae) splits R1 at byte 1; the Satori ghosts 07_words, sancyome and kanade_2nd use
`（Ｒ０）（Ｒ４）…（Ｒ５）` [corpus].

**Sumika** (`src/shell/mouse.js` `_gStep`, `gestureDegree`, `direction8`; `src/core/events.js`
`gestureRefs`; SUM C31):
- The tracker copies rules 1–9: a right press (DOM button 2: a mouse, or a pen's barrel, so a pen gestures as in SSP),
  not a double-click's second press, starts the state; a step is 4 CSS px or more, Euclidean, inclusive (SM_CXDRAG in
  the unit of the left drag's 4 px [decision]). It emits 'gesture' MouseInfo; the EventLoop sends GET OnMouseGesture in
  the button chain (after OnMouseDown, before OnMouseUp; origin user, so its reply plays, as any click's).
- R1 / R3: the client point minus the base rect's left / top, in CSS px: the base rect stands in for SSP's window as
  for the collision rect (§3.2.1) [infer], CSS px is the desk's unit (properties.md) [decision]. At other scalings they
  differ from surface pixels, as in SSP. GGetLocalCursorPos adds an offset of its own ([[this+0x80]+0x84], 0x4178d0),
  unidentified, taken as 0 [guess]. R2 / R4: the collision by shape only (`CharacterView.collisionAtSurface`).
- During a gesture the view feeds every coalesced pointermove sample (`getCoalescedEvents`), as SSP steps on each
  WM_MOUSEMOVE [decision]; a browser without it (older Safari) gives one sample per frame, and a short quick flick may
  then make fewer than 4 steps.
- A pointercancel or lost capture during a gesture: OnMouseUp without a click, then `end` at the last point seen
  [decision: SSP has no rule for it; without `end` bonsyou's and emily4's arrays would run into the next gesture].
- **Touch [decision].** A long press (500 ms, under 10 px) on a spot with no named
  collision is Sumika's right button (§4.2, UI §9.6). A move of 10 px or more after it makes it a right drag:
  OnMouseUp (R5 0), OnMouseDown (R5 1) at the press point, then gestures stepped from the press point, OnMouseUp
  (R5 1), `end`; no menu. Rule 10's wheel stand-in applies (`gesturestep` MouseInfo: an unanswered `up` / `down` gives
  3 × OnMouseWheel at the press point, then one per further step of that run); R6 the press's device (`touch`)
  [decision]. Unchanged: a long press on a named collision is a hold and moving after it drags; a plain touch drag
  strokes a named collision and moves the character elsewhere; a long press without a move opens the menu. Earlier
  a long press then a move on a body spot moved the character; a plain drag there still does. So emily4's
  `Skirt` (a named collision) cannot be gestured by touch. An alternative not taken: any long press then a move
  = a gesture, plus SSP's own two-finger drag to move the character (needs two-pointer tracking). In SSP itself touch
  gestures are hard to reach (rule 10: only in the right state), so this is an extension on SSP's own stand-in [infer].
- Not done here [disasm]: SSP sends no OnMouseMove while the left button is held either, and starts
  the left drag at > SM_CXDRAG on either axis (Sumika: ≥ 4, petting moves meanwhile) (0x417c1f–0x417ca5); a right
  OnMouseDown (R5 1) reply with a valid script also sets the click flag, so no OnMouseClick and no menu (0x41a8ac–
  0x41a8c3; C26 does not do this); OnMouseUp's R4 is the collision at the release point (0x41ac88–0x41acaf); a real
  OnMouseWheel's R2 is the accumulated delta. The early-out flag +0x14c of OnEXMouseMove is unidentified, and how
  Windows scales SM_CXDRAG with the DPI is not checked.

### 4.6 Keyboard (P0)

`GET OnKeyPress` on `keydown` while the ghost is "active". Active means the last `pointerdown` was on a character or
balloon, the document has focus, and `document.activeElement` is not an editable element (input, textarea,
contenteditable). Do not send it while the input or communicate box has focus, nor while a character is carried
("Move character window", `stage.carrying`, ssp-ui.md §2.11): then no key reaches the ghost and none is prevented,
Escape cancels the carry, and the ghost stays active, so her shortcut keys work again after it [guess: what SSP sends
during its drag was not traced].

With several ghosts (§2.7) one of them at most is active [doc OnKeyPress 「本体がアクティブな状態で」; infer for several]: a
press on a character or balloon, a link or choice, or a drop activates that ghost (the loop emits 'activate' and the
site deactivates the others, also when no pointer was involved, as for a drop); a `pointerdown` inside another ghost's
layer (`.smk-ghost`) deactivates this one at once, a press on a root-level menu or on the info window does not. A
called ghost takes the keys only from an active caller [decision; SSP always activates it, `ssp-ui.md` §9.7].

| Ref | Value |
|---|---|
| R0 | key name, lower-case (table below) |
| R1 | Win32 virtual-key code as decimal. `KeyboardEvent.keyCode` matches it for practically all keys on Chromium/Firefox. |
| R2 | key-repeat count: `0` on the initial press, +1 for each auto-repeat `keydown` of the same key (ASSUMPTION about the base; Tsubasa tests `（Ｒ２）<2` [T dic02_Event.txt:809], which accepts either base) |
| R3 | scope of the active character window |
| R4 | modifiers `shift,ctrl,alt` order (joined, empty if none; order inferred from [B 0x724758–0x724770], consistent with the [U-ev] example `ctrl,alt`) |

Key names (SSP literals from [B 0x7c6800–0x7c6c20], plus Tsubasa's usage [T entries `*が押された`]):

| `KeyboardEvent.code`/`key` | R0 | VK |
|---|---|---|
| `KeyA`…`KeyZ` | `a`…`z` (unshifted keytop) | 65–90 |
| `Digit0`…`Digit9` | `0`…`9` | 48–57 |
| `ArrowUp`/`Down`/`Left`/`Right` | `up` / `down` / `left` / `right` (Tsubasa uses these; not found in [B], inferred) | 38 / 40 / 37 / 39 |
| `Space` | `space` | 32 |
| `Enter` | `return` | 13 |
| `Escape` | `escape` | 27 |
| `Tab` | `tab` | 9 |
| `Backspace` | `back` | 8 |
| `Delete` / `Insert` | `delete` / `insert` (inferred) | 46 / 45 |
| `Home` / `End` | `home` / `end` (`end` inferred) | 36 / 35 |
| `PageUp` / `PageDown` | `pageup` / `pagedown` | 33 / 34 |
| `F1`…`F24` | `f1`…`f24` | 112–135 |
| `ShiftLeft`/`Right`, `ControlLeft`/`Right`, `AltLeft`/`Right` | `shift-left`… / `control-left`… / `alt-left`… | 16 / 17 / 18 |
| `CapsLock`, `NumLock`, `ScrollLock`, `PrintScreen` | `capslock`, `numlock`, `scrolllock`, `printscreen` | 20, 144, 145, 44 |
| punctuation (`Comma`, `Period`, `Minus`, …) | the unshifted character: `,` `.` `-` … (Tsubasa uses `,`) | VK_OEM_* (`,`=188, `.`=190, `-`=189, `/`=191, `;`=186) |

Tsubasa uses keys for shortcuts, typing and puyo games, beach volleyball and swimming
(`ぷよ中leftが押された`, `upが押されたビーチバレー中`, …: 39 handlers [T]). **P0.** The runtime cannot tell when a game is
running, so call `preventDefault()` on every key it sends to an active ghost. This stops arrows and space from scrolling
the page.

### 4.7 Choices and anchors (P0)

Choice tags `\q[title,ID,args…]` and `\__q[ID,args…]…\__q`, and anchors `\_a[ID,args…]…\_a` [U-ss]. On selection:

```js
async function onChoiceSelected(c) {          // c = {label, id, args, kind:'q'|'__q'|'a'}
  if (c.kind !== 'a') player.endChoiceWait(); // choices: close the balloon, clear `choosing`, cancel the choice timer
                                              // anchors (\_a) are clickable mid-talk and close nothing by themselves
  if (c.id.startsWith('script:')) return player.play(c.id.slice(7), {event: 'script:'});     // no SHIORI event
  if (c.id.startsWith('On'))     return fireScriptEvent(c.id, c.args, {senderType: 'internal,raise'});
  if (/^https?:\/\//.test(c.id)) return openUrl(c.id);   // satori-docs says SSP handles these itself (ASSUMPTION about the exact SSP action)
  if (c.kind === 'a') {
    const r = await fireScriptEvent('OnAnchorSelectEx', [c.label, c.id, ...c.args]);
    if (!r.played) await fireScriptEvent('OnAnchorSelect', [c.id]);
  } else {
    const r = await fireScriptEvent('OnChoiceSelectEx', [c.label, c.id, ...c.args]);
    if (!r.played) await fireScriptEvent('OnChoiceSelect', [c.id]);   // CROW-only extra IDs: not sent
  }
}
```

* `c.id` is the **raw** text after the tag parser's quote/escape handling, including any `\x01` bytes. Satori's
  `\q[label,id]` rewrite (`id\x01label\x01n`) must round-trip unchanged [S satoriTranslate.cpp; C: 418 lines]. Satori
  splits it back and sets `（選択ＩＤ）`, `（選択ラベル）` and `（選択番号）` [S AnalyzeRequest; SD grammar/09-choices.md].
* Label for `\__q`: the visible text between the tags, with tags stripped and runs of whitespace collapsed (ASSUMPTION).
* Tsubasa: 11,142 `\__q[ID]` + 3,412 `\q[label,ID]` plain choices, 395 `\__q[On…,arg]` + 699 `\q[…,On…,arg]` event
  choices [C]. She defines `＊OnChoiceSelect` (`＞（Ｒ０）`) [T dic02_Event.txt:621]. Because of that, Satori's own
  OnChoiceSelectEx argument handling is disabled [S EventOperation], and OnChoiceSelectEx returns 204.
* An empty ID is possible: Satori produced `\q[Keep Reading,\x01Keep Reading\x011]` [C]. Send it as is.
* Hover (implemented; UI §4.8) [disasm CMessageWnd, ssp.exe 2.9.08f]: when the item under a mouse or pen pointer changes
  (UpdateSelection 0x470350), entering an item is **GET OnChoiceEnter** (OnAnchorEnter for an `\_a` anchor) [R0 the
  item's text as shown, untrimmed, '' for an image-only `\__q`; R1 the ID as parsed; R2… the tag's further arguments];
  leaving it is **OnChoiceEnter with no References** (never OnAnchorEnter): NOTIFY, sent first, when the pointer goes
  straight to another item, GET when it goes to empty balloon space; nothing when it leaves the balloon window (the
  item stays selected). Above validrect.top or below validrect.bottom the hit test finds nothing without storing it
  (SelectLineInternal 0x5cf7a4 / 0x5cf7c6), so there the GET goes out at every new pointer position while the item
  stays selected (UI §4.8). Every click on an item sends NOTIFY OnChoiceEnter (no refs) before OnChoiceSelectEx /
  OnAnchorSelectEx (EX_OnLButtonUp 0x470905), a choice timeout with an item selected before OnChoiceTimeout
  (DoWaiting 0x5cff45). When the pointer has rested on an item not asked about since it last rested elsewhere (the
  tooltip's cache, UI §4.8): **GET OnChoiceHover** / OnAnchorHover, then **GET `balloon_tooltip`**, same References
  (ToolTipDispInfo 0x472060). The GET replies play like a click's (PlayScriptWithMsg): one without `\C` replaces the
  menu; Sumika follows that [decision]. Tsubasa and emily4 answer all four with 204 (research probe;
  `tests/runtime/tooltip_engines.test.mjs` checks it through the real engines, a choice and an anchor for each).
  [L 4632]'s NOTIFY with References is SSP 2.02's; 2.9.08f enters with GET [disasm]. Touch has no hover: no enter or
  hover events [decision] (a tap still sends the click's NOTIFY).
* Timeout: see 3.4. `\*` disables it, and `\![set,choicetimeout,ms]` overrides it (0/-1 = none) [U-ss]. 1,289 Tsubasa
  choice scripts have no `\*` [C], and she defines `＊OnChoiceTimeout` [T dic02_Event.txt:626]. **P0.**
* The old `\q0[ID][title]` form (P2): treat the ID as an event name.

### 4.8 Input boxes (P0)

`\![open,inputbox,ID,timeoutMs,defaultText,--options…]` (Tsubasa: 28 opens, IDs `ユーザ名`, `ユーザ`, `数当て答え`,
`タイプ答え`, `数字記憶答え`, `短冊２…５` [C]); `\![close,inputbox,ID]` closes it without an event.

```
submit (OK / Enter):
   if ID starts with "On": GET <ID> [R0 text, R1 "" , R2.. --reference values]
   else:                   GET OnUserInput [R0 ID, R1 text, R2 "" (slider: "min,max"), R3.. --reference values]
close button:  GET OnUserInputCancel [R0 ID, R1 "close"]
timeout:       r = GET OnUserInputCancel [R0 ID, R1 "timeout"]
               if 204: GET OnUserInput [R0 ID, R1 "timeout"]          // compatibility fallback [U-ev], [U-ss]
```

* Timeout: an empty argument, `0` or a negative value means no timeout (`\![open,inputbox,数当て答え,,（…）]`) [U-ss].
* Tsubasa's `＊OnUserInput` stores `＄（Ｒ０）＝（Ｒ１）` and jumps to `（Ｒ０）を教えてもらった` [T dic01_Boot.txt:29]. Her
  typing game treats `R1=="timeout"` as time-up [T `＊タイプ答えを教えてもらった`]. She defines no `OnUserInputCancel`, so
  the fallback is **P0**.
* Communicate box `\![open,communicatebox(,text)]` (Tsubasa 6 [C], menu "Talk"): submit →
  `GET OnCommunicate [R0 "user", R1 text]`; close → `GET OnCommunicateInputCancel [R0 "", R1 "cancel"]`. Satori maps
  `user`→`ユーザ` and searches `＊ユーザ「…」` talks, else `＊COMMUNICATE該当なし` [S EventOperation]. **P0.**
* Other box types (passwordinput, dateinput, timeinput, sliderinput, ipinput) behave the same with different R1 formats:
  P2. Teach box (`OnTeachStart`, `OnTeach` with 311/312, `OnTeachInputCancel`): P2, implemented (UI §6.3):
  open → `GET OnTeachStart []`; OK → `GET OnTeach [R0… the words of the round, newest last]`; × →
  `GET OnTeachInputCancel [R0 "", R1 "cancel"]`; `\![close,teachbox]` is silent. `\__c` opens the communicate box.
* `GET inputbox.autocomplete [R0 kind, R1 ID]` when a box opens. A `\x01` list in the reply enables autocomplete: P2.
* An open box changes no tick: GET with R3 1 when the ghost is otherwise idle, Status `opening(input|communicate|teach)`
  (§1.6), so random talk and time signals can play during a prompt, the box staying open [disasm; decision: as ssp.exe].

### 4.9 Balloon events (P1)

| Event | When | Refs |
|---|---|---|
| `OnBalloonTimeout` | 3.4 | R0 script, R1 `0` (2.9.9.3000 sends R0 only [disasm 0x5d1e3b, not checked further]) |
| `OnBalloonClose` | the user closed the balloon (close button) | R0 script |
| `OnBalloonBreak` | the user broke a playing script. SSP default: **double-click on the balloon = script break** [U-help config-talk]. | R0 script, R1 scope, R2 character offset in the script, counting tags |
| `OnSSTPBreak` | same, for SSTP scripts | n/a (Tsubasa defines it [T dic02_Event.txt:586]) |

### 4.10 Script-generated events (P0)

[U-ss]:

| Tag | Request | Behaviour |
|---|---|---|
| `\![raise,ID,r0,…]` | `GET ID` with refs, SenderType `internal,raise`, sent **when playback reaches the tag**. Playback waits for the reply. | 200 with a script: stop the current script, then translate and play the new one. 204: continue. Tsubasa: 801× `OnDirectSaoriCall` (always 204 from Satori), 169× custom IDs [C]. |
| `\![embed,ID,r0,…]` | `GET ID`, SenderType `internal,embed` | The Value replaces the tag in place, and playback continues inside it. Its %-variables are expanded first [disasm `EmbedSendEventFunc` → `TranslateParam` 0x633349], then it goes through `GET OnTranslate` [disasm → `TranslateScript` 0x633389]: R0 the expanded Value, R1 `""`, R2 ID, R3 the refs joined by `\x01`, the embed's SenderType; a reply that changed it is spliced as returned, not expanded again (properties.md §2.1; an earlier "No OnTranslate" ASSUMPTION was wrong). P1. |
| `\![get,property,ID,name…]` | `GET ID`, References = the properties' values read at the tag (a failed one `""`), SenderType `internal,property` | as `\![raise]`: playback waits; 200 with a script replaces the run. Fewer than one name: nothing sent. properties.md §3 (implemented). |
| `\![notify,ID,r0,…]` | `NOTIFY ID` | continue. P1. |
| `\![timerraise,ms,repeat,ID,r0,…]` | after `ms`: `GET ID` (`internal,raise`) | `repeat` 0 = every `ms` until cancelled, ≥1 = once; as amended (SUM C3, §2.7.9): SSP's ParseBool decides (empty or garbage = every `ms`), 1–49 ms become 50, and one key per event name, any case, for all four timer tags [disasm 0x632E80, 0x789660]. `r0,…` become References as for `\![raise]`: an empty last one ends them (SS §3.4, §6.6) [disasm]. `ms` 0 cancels the timer of that ID. Another timer tag for the same ID overwrites it. The timer lives until ghost close and is kept across page navigation (SUM C4 overrules the old DECISION here). Delivery ignores Status (ASSUMPTION). Its script replaces the current script. Tsubasa: 530 uses, 45 targets (dress-up submenus re-opened after 1 ms, games) [C]. |
| `\![timernotify,…]` | like timerraise but NOTIFY | P2 |
| `\![execute,http-*,…]`, `\![cancel,http,URL]` | a web request, then `OnExecuteHTTPComplete` / `…Failure` (or the `On…` ID) | §4.15. Without `--async` playback waits at the tag until the event's reply has started. |
| `\![raiseother]`, `\![notifyother]`, `\![timerraiseother]`, `\![timernotifyother]` | `GET` / `NOTIFY` ID in other ghosts (`internal`, `Sender: <raiser's sakura name>`); OnRaiseOtherFailure / OnNotifyOtherFailure back | §2.7.9 (implemented). The script never waits. |
| `\![raiseplugin]`, `\![notifyplugin]`, `\![timerraiseplugin]`, … | not sent | Log once. Tsubasa's `\![raiseplugin,スタンプ帳,…]` (64 [C]) is a no-op. |

IDs need not start with `On` (`天気予報情報取得開始２`, `服着せ替えメニュー`). Satori answers them by expanding the talk
[S CreateResponse], without its event post-processing: no `\e`, no surface-restore prefix.

### 4.11 Surface and dress-up notifications (P0)

**`OnSurfaceChange` (NOTIFY)** [U-ev; L 936, 1029, 4156]. Send it immediately every time any scope's displayed surface
changes, whether by `\s`, by a restore script, or at boot and resume. Send one request per changed scope:

| Ref | Value |
|---|---|
| R0 | current surface id of scope 0 (`-1` if hidden) |
| R1 | current surface id of scope 1 (`-1` if hidden) |
| R2 | `scope,surfaceId,width,height` of the scope that changed (surface pixel size) |

Satori stores R0/R1 → `（サーフェス0）`/`（サーフェス1）` [S EventOperation, satori_builtin.cpp:var_surface]. Tsubasa reads
`（サーフェス0）` 207 times [T]. Consecutive changes of one scope that happen before the request is dispatched may be
coalesced.

**`OnDressupChanged`**: after a script that changed binds **ends** (or is interrupted), and at once after each
Clothes/Dressup ▸ pick [U-ev; U-ss `\![bind]`: "after the script runs, OnDressupChanged and then OnNotifyDressupInfo
are notified"; disasm 0x418ee9–0x419127]:

```
changes = the parts whose on/off differs from before the applied block, implicit unbinds of exclusive categories and
          mustselect's re-enabled defaults included; ALL "off" changes first, then all "on" changes, each group stable
          [disasm SPBindProp_CheckPreservedEnableStateSortFunc: settles the old off-before-on ASSUMPTION]
if 1 <= changes.length < 100:                                            [disasm "jae 0x64"; U-ev "今のところ100要素"]
   for each change except the last: NOTIFY OnDressupChanged [scope, part, on?1:0, category, origin]
   last change:                     GET    OnDressupChanged [ … ]
(100 or more: no OnDressupChanged at all)
then: GET OnNotifyDressupInfo (full list), even when OnDressupChanged was skipped      [U-ev OnNotifyDressupInfo]
      (it stays NOTIFY when OnDressupChanged's GET already started a reply; NOTIFY at boot/resume)
origin (R4) = "script" for \![bind], "user" for the menu                         [U-ev, SSP 2.5.90+; disasm]
\![bind-noevent,…]: no events                                                    [U-ss]
```

* **Menu picks** (`loop.toggleDressup(scope, id)` → `stage.setBind(scope, id, undefined, {origin: 'user'})`): applied
  at once, **also while a script plays**, and reported at once (their own pending list, flushed in a microtask), R4
  `user`; their replies play like any user event's (replacing the talk). Refused (no change, no event) while
  minimized, in passive or induction mode, or inside `\t` [disasm `IsLocked`], and during a shell swap (§2.6).
  * A pick made while a script plays first reports that script's binds so far: NOTIFY OnDressupChanged per change
    (R4 `script`), then NOTIFY OnNotifyDressupInfo with the state before the pick; then the pick's own events (the
    last OnDressupChanged as GET, then GET OnNotifyDressupInfo, R4 `user`). The script's later binds are reported at its
    end [disasm: SSP applies and reports a script's lazy block at its next text, so it always comes before a
    later pick].
  * A pick that is applied but changes no flag (unticking a worn mustselect default, which comes straight back) sends
    no OnDressupChanged but still GET OnNotifyDressupInfo with the full list, and its reply plays like any user event's
    ("after every applied block, even when OnDressupChanged was skipped", below). An id that names no bind group sends
    nothing.
* **Script binds** are collected until the run ends (or is replaced, as NOTIFY). SSP applies them in "lazy blocks"
  that end at the next text, wait, shell change or script end [disasm], each block with its own events; Sumika reports
  one block per run, its **net** changes: a part switched on and off again in the same run is not reported [decision:
  SSP reports the diff of each block; reporting both switches sorted off-first would leave the ghost's flag wrong].
  Within each group the order is the order the parts first changed (SSP: their menu position, unlisted last [disasm]).
* **Timers wait for the report.** A `\![timerraise]` / `\![timernotify]` that comes due first sends the binds still
  pending (NOTIFY, as when a run is replaced) and waits for a report already on its way. In SSP the report of a lazy
  block goes out at its next text or wait, and SSP's SHIORI calls return before its message loop fires a timer, so a
  timer set after a `\![bind]` always follows that bind's OnNotifyDressupInfo [disasm]. Tsubasa's dress-up menu
  depends on it: a pick binds, then `\![timerraise,1,1,…]` redraws the menu, framing the part OnNotifyDressupInfo
  told her she wears (before the fix the frame lagged one pick behind) [observed: ssp.exe].
* Categories are exclusive unless the shell sets `bindoption … multiple` [U descript_shell `bindoption`]. Tsubasa's shell
  sets none [T shell descript.txt], so `\![bind,服,夏服,1]` (35× [C]) implies "old part off, new part on".
  Tsubasa's handlers need off before on: `＊ワンピ切り替え` sets `＄ワンピ着用＝（Ｒ２）`, so a reversed order would
  leave the flag at 0 [T dic16_Dressup.txt:943ff].
* A shell change reports a script's pending binds as NOTIFY before the switch, then only OnNotifyDressupInfo (NOTIFY)
  for the new shell's dress-up: no OnDressupChanged (§2.6) [disasm].

**`OnNotifyDressupInfo`**: one Reference per bind group of every scope [disasm `NotifyBindInfo`, `GetNotifyEntry`]:

```
Reference<i>: <scope>\x01<category>\x01<part>\x01<options>\x01<1|0>\x01<thumbnail>
```

* Order: scope (0, 1, then ascending `charN`), then **category** (ordered by the menu position of their first part some
  `menuitem` lists, unlisted categories after them in definition order), then parts in definition order [disasm
  `CheckEntry`]. The stage builds the list (`Stage.dressupInfo`, `shell-format.md`); earlier it was ascending
  bindgroup id. Tsubasa's handler works with either order: it reads scope 0's references while they hold one of her
  18 categories, and in SSP's order all 18 come before 風呂 / テーブル / 料理 [T dic16_Dressup.txt:4081; disasm order];
  etherism reads by position [corpus], so the order matters there.
* `options` = the ones that apply of **`default`** (that part's `bindgroupN.default` is true), `mustselect`,
  `multiple`, comma-joined in that order (may be empty) [disasm]. `thumbnail` is the thumbnail when that file exists in
  the shell, else `""` [disasm; U-ev; I notify_info.coffee].
* **The thumbnail must be an empty string when there is none.** Tsubasa erases `\x01` and checks that the string ends in
  `0` to detect "off" [T dic16_Dressup.txt:4103]. Her handler walks R0, R1, … until it meets a category it does not know,
  so scope 0 must come first [T dic16_Dressup.txt:4081].
* Size: Tsubasa's shell has 3,885 bind groups (233 sakura, 3,600 `char100`) [T shell descript.txt], so this request is
  about 200 KB. That is acceptable.

### 4.12 `OnTranslate` (P0)

[U-ev OnTranslate]; observed in [L 4083, 4691, 5399]. Sent for **every script returned by a GET script event**: clock,
mouse, choice, raise, timer, boot, and so on. It is not sent for resources, NOTIFY, OnTranslate's own reply or `script:`
choices. An `\![embed]` result is sent too, with R1 `""` and no second expansion (§4.10) [disasm 0x633389].

```js
async function translate(script, srcId, srcRefs, {senderType}) {
  const refs = [script];
  const flags = [];                                  // communicate | sstp-send | owned | remote | notranslate | plugin-script | plugin-event
  refs[1] = flags.length ? flags.join(',') : undefined;   // omitted Reference1 when no flag ("欠番")
  refs[2] = srcId;                                   // SSP-only: the source event ID
  refs[3] = srcRefs.join('\x01');                    // SSP-only: its references
  const r = await shiori.request({method:'GET', id:'OnTranslate', refs, headers: hdrs({senderType})});
  return (r.status === 200 && r.value) ? r.value : script;
}
```

* Satori runs Tsubasa's `＊OnTranslate`. With no mode active it returns 204 and the original script plays. In nyan, pyon
  or blush mode it returns the rewritten script, prefixed with `\1\s[10]` by Satori's surface restore [C res_tr_*.txt].
* Environment-variable expansion (`%username`, `%property[…]`, …) happens **before** OnTranslate [U-ev], so R0 is the
  expanded script; a reply that changed it is expanded once more [disasm `SPGhost::Loop` 0x63B747, 0x63B7AF–0x63B822]
  (properties.md §2.1; implemented: `EventLoop._translate`, `expand`). A `script:` choice and `playScript`
  are expanded without OnTranslate; a replay after a page change plays the stored, already expanded script. Tsubasa
  uses none [C].

### 4.13 Menu-driven events (P1)

| Event | When | Refs | Notes |
|---|---|---|---|
| `OnRecommendsiteChoice` | user picks a site in the recommend/portal submenu | R0 title, R1 URL, R2 banner, R3 `recommend`/`portal`, R4 `0`/`1` (scope), R5 index in the menu (0-based) [U-ev] | **Open the URL in a new tab synchronously in the click handler** (popup blockers), then send the event and play any reply. Satori: when the event is undefined it plays lines 4+ of the matching `＊sakura.recommendsites` entry (matched by URL) [S satori_tool.cpp:GetRecommendsiteSentence]. Tsubasa's entries have no lines 4+ → 204. Whether SSP suppresses the URL when a script is returned is unknown (Q5). |
| `OnShellScaling`, `OnBalloonScaling` (**implemented**) | the user picks a percentage, Default (match display) or Other percentage… in Shell scaling ▸ / Balloon scaling ▸ (UI §2.1 #8, #9) and the size in effect changes | R0 new horizontal %, R1 old horizontal %, R2 new vertical %, R3 old vertical % [U-ev: "シェル倍率が変更された際に発生" / "バルーン倍率が…"]. Percentages in SSP's terms, device pixels: no choice = the display's, `round(devicePixelRatio × 100)`; the menu sets both axes alike | GET, origin `user`; a reply plays like any menu pick [ASSUMPTION: UKADOC marks neither NOTIFY]. Not sent when the stored choice changes but the size in effect does not (125 % picked while following a 125 % display), nor at boot or when devicePixelRatio changes [ASSUMPTION]. Tsubasa defines neither (204). |
| `OnLanguageChange` (**implemented**) | the UI language in effect changes: a Language ▸ pick (UI §2.10), another tab's pick, or the browser's languages while the choice is Use System Lang.; and NOTIFY at boot (§2.1 #10a) | R0 language name (descript `name`: `Japanese` / `English`), R1 language id (descript `id`: `1041` / `1033`), R2 full path of the language pack's folder, R3 its help URL [U-ev: "言語設定が変更された際と、起動直後に通知される。起動直後に通知される場合は必ずNOTIFYとなり、イベントに応答してしゃべることはできない。"]. R2 and R3 are `""` (DECISION: a browser has no language folder, and SSP's help URL, `helpurl` in `data/language/*/descript.txt`, describes SSP, not this runtime) | GET, origin `user`; a reply plays like any menu pick. Not sent when only the stored choice changes (Use System Lang. picked while the browser's language is the one in effect) [ASSUMPTION], before boot, after close, while frozen. SSPHELP howto-rclick #19 says SSP applies a new language "after a restart" (設定は再起動後に反映されます); the runtime applies it at once [DECISION, not compared with ssp.exe]. No property tells a ghost the UI language: UKADOC's `system.os.locale`, `.locale.language`, `.locale.country` are the OS's UI locale (`manual/list_propertysystem.html`); Sumika answers them with the browser's language, not the Language ▸ choice (properties.md §5.5) [decision]. Tsubasa defines no handler (204). |
| `OnClose`/`OnCloseAll`, `OnWindowStateMinimize`, `OnVanishSelecting` | 2.3 / 2.4 / 2.8 | | Quit (both menus): OnCloseAll → OnClose to every ghost on screen, each closes at its script's end; Close: OnCloseAll → OnClose when it is the only ghost (= Quit), else OnClose only, at `\-` (2.3) [disasm]; there is no Uninstall, so OnVanishSelecting is never sent [decision] |
| `OnGhostCalling` (**implemented**) | a Call ghost ▸ pick; `\![call,ghost,X,--option=raise-event]` | R0 callee sakura name, R1 `manual` (menu) / `automatic` (script), R2 callee name, R3 callee path [doc; disasm] | GET, BaseID `OnGhostChanging`, SenderType `internal`; 204: nothing else; the reply plays (origin `user`) while the callee loads (2.7.1). Not sent for a plain `\![call,ghost]` |
| `OnGhostCalled`, `OnGhostCallComplete`, `OnOtherGhostBooted` (**implemented**) | a call: to the callee at its boot; after its boot script, to the caller / to every other live ghost | 2.7.1 | OnGhostCalled: BaseID `OnGhostChanged,OnBoot`, 204 → OnBoot; OnFirstBoot instead for a ghost never met. The other two: GET, SenderType `internal`, reply plays (origin `user`) |
| `OnOtherGhostChanged`, `OnOtherGhostClosed` (**implemented**) | another ghost changed in its place (after the new one's boot script) / closed while this one stays (after it is gone) | 2.7.2, 2.7.3 | GET, SenderType `internal`, to live ghosts only; never on Quit |
| `OnOtherGhostTalk` (**implemented**) | another ghost's run starts / ends, for a ghost that asked with `\![set,otherghosttalk]` | 2.7.4 | GET, SenderType `internal`; 'before' is not sent for a reply to OnOtherGhostTalk itself (SSP's guard [disasm 0x6397A2]), 'after' is [disasm 0x63992F]; nothing for replays |
| `OnShellChanging` (**implemented**) | a Shell ▸ pick (the current shell too), `\![change,shell,X,--option=raise-event]` | R0 next shell name, R1 current shell name, R2 next shell path [doc; disasm] | GET, origin `user`; the switch waits for its reply's end; a balloon break or a replacing run cancels (§2.6). Not sent for a plain `\![change,shell]` |
| `OnShellChanged` (**implemented**) | after every shell swap (menu, any `\![change,shell]`, re-picks) | R0 new shell name, R1 the ghost's descript name, R2 new shell path [doc; disasm] | GET after the NOTIFYs of §2.6; 204 → the old surface ids come back; a script's change: the reply plays when that script ends [guess] |
| `OnBalloonChange` (**implemented**) | a Balloon ▸ pick (the current balloon too), `\![change,balloon,X]` | R0 new balloon name, R1 its path [doc; disasm] | GET after NOTIFY OnNotifySelfInfo; no OnBalloonChanging; the balloon a shell change switches to (the one the new shell boots with) sends none (§2.6) |
| dress-up items (**implemented**) | a Clothes/Dressup ▸ part toggles its bind group | see 4.11 (origin `user`, reported at once even while a script plays; refused while minimized, passive, induction or `\t`) | |
| Move character window, Reset passive mode | `ssp-ui.md` §2.11 | | no event to the ghost [guess]; Reset passive mode leaves passive and induction mode like `\![leave,…]` |
| `OnUpdateBegin`, … `OnUpdate*`, `OnUpdateReady` | network update | n/a | Satori special-cases `OnUpdateReady` R0+1 [S]. Never sent. |

### 4.14 Every other SSP event: browser feasibility

| Event(s) | Browser source | P |
|---|---|---|
| `OnSysResume [R0 "normal"]` | heuristic: a tick gap > 5 min while `document.visibilityState === 'visible'` (DECISION). `OnSysSuspend` (NOTIFY): never. | P2 (Tsubasa master defines OnSysResume [T dic02_Event.txt:73]) |
| `OnDisplayChange [bpp, w, h]` | debounced `resize` (GET; NOTIFY at boot) | P2 |
| `OnNetworkStatusChange [online/offline, IPs "", type ""]` | `online`/`offline` events (NOTIFY at boot) | P2 |
| `OnBatteryNotify`, `OnBatteryLow`, `OnBatteryCritical`, `OnBatteryChargingStart`/`Stop` | Battery Status API where available (Chromium). R0 = percent. Tsubasa defines Low/Critical [T dic09_ExEvent.txt:264]. | P2 |
| `OnFileDrop2 [paths\x01…, scope, mime\x01…]` | **Implemented** (GET, a user event; `\t` does not drop it). HTML drag-and-drop of files onto an opaque pixel of a character. R0 = pseudo-paths `C:\sumika\drop\<8 hex>\<name>` joined by `\x01`, R1 = scope, R2 = MIME types joined by `\x01` (the browser's type, else by extension, else empty) [U-ev]. Folders are left out. A drop made while the engine loads, or on a frozen tab (which then takes the ghost over), is held and sent once she has booted. Playable audio stays in IndexedDB (TS §3.4 "Storage"). Not sent: `OnFileDropping` (the browser hides file names during the drag), the legacy `OnFileDrop`/`OnFileDropEx`/`OnFileDropped`, and the viewer fallbacks (`OnMediaPlayerOpen`, …). Tsubasa uses it for wallpaper and music [T dic11_etc.txt:7]. | P2 |
| `OnURLDragDropping`, `OnURLDropping`, `OnURLDropped`, `OnURLDropFailure` | dropped URL (no NAR install) | P2 |
| `OnKeyPress` | 4.6 | P0 |
| `OnOverlap [pairs \x01, previous]` | own scopes' rect intersections changed (the same collision rects as R2, §3.2.1). Tsubasa's date dictionary uses it [T date/dic03_Menu.txt:2660]. | P2 |
| `OnOffscreen [ids \x01, previous]` | per-scope off-screen set changed (the same collision rects as R1, §3.2.1) | P2 |
| `OnOtherSurfaceChange`, `OnOtherOverlap`, `OnOtherOffscreen`, `OnOtherGhostVanished` | several ghosts (2.7.5; OnOtherGhostTalk is implemented, 4.13) | P2 |
| `OnCommunicate` from another ghost, `OnRaiseOtherFailure` / `OnNotifyOtherFailure`, an event another ghost raises | **Implemented**: 2.7.7, 2.7.9 | P1 |
| `OnAITalk` | `\a` tag | P2 |
| `OnSoundStop`/`OnSoundLoop`/`OnSoundError` | **Implemented**: `\_v` / `\8` / `\![sound,play\|loop]` playback, §4.17 | P2 |
| `OnMusicPlay`/`Ex`, `OnVideoPlayEx` | Media Session of other tabs: impossible | n/a |
| `OnInstall*`, `OnUpdate*`, `OnSNTP*`, `OnBIFF*`, `OnHeadlinesense*`, `OnRSS*`, `OnSchedule*`, `OnExecute*` (but the HTTP events, §4.15), `OnNarCreat*`, `OnUpdatedataCreat*`, `OnSSTPBreak`, `OnSSTPBlacklisting`, `OnScreenSaverStart/End`, `OnSession*`, `OnCPULoad*`, `OnMemoryLoad*`, `OnDevice*`, `OnTabletMode`, `OnDarkTheme`, `OnWindowModeChange`, `OnOSUpdateInfo`, `OnRecycleBinEmpty*`, `OnVirtualDesktopChanged`, `OnCache*`, `OnBaseware*`, `OnSelectMode*`, `OnSpeechSynthesisStatus`, `OnVoiceRecognition*`, `OnGamepad*` (possible later via the Gamepad API), `OnTrayBalloon*`, `OnSystemDialog*`, `OnConfigurationDialogHelp`, `OnGhostTerms*`, `OnEmbryoExist`, `OnNekodorifExist`, `OnResetWindowPos`, `OnTextDrop`, `OnXUkagakaLinkOpen`, `OnURLQuery`, `OnRaisePluginFailure`, `OnNotifyPluginFailure` (the other-ghost ones: above) | none | n/a |
| Kinoko, Nekodorif, Kanade and other third-party app events (`OnKinoko*`, `OnNekodorif*`, `OnKanadeTeaParty*`, `OnApplicationOperationFinish`, `OnWebsiteUpdateNotify`, `OnSysResource*`) | external apps | n/a |
| `OnDSAPlayFinish` | **the dsaudio SAORI stand-in** posts it when a track ends: worker → main `{t:'saori'}` → main sends `GET OnDSAPlayFinish` (P1). Tsubasa's music player continues the playlist with it [T dic11_etc.txt:735]. | P1 |
| `OnRecycleBinEmptied` | gomi SAORI. The stand-in may raise it after `-asfq` (P2). | P2 |

### 4.15 `\![execute,http-*]`: web requests and their events (P2; implemented)

The tag is sent [decision]: many requests fail (security policies, dead sites), which does no harm. Tags as in the
Legend's line for shells, balloons and the dress-up menu.
Evidence: ssp.exe 2.9.08f's `SPHttpRequest` / `SPHttp` / `SPHttpManager` (SSP's own HTTP client over OpenSSL, not
WinInet), read in its disassembly; the notes with every address are `scratch/http/ssp-disasm.md`. What the ghosts use
is `scratch/http/corpus.md`: 54 of the 323 archives, only `http-get` and `http-post`, every URL `http://`; most post
web claps (`clap.webclap.com`, the ぱっちん CGIs, mostly dead free hosts [guess]; the first sweep saw 13 Satori ghosts
send one), bonsyou fetches a counter. Code: `src/core/http.js` (`HttpRequests`, one per EventLoop), `ShioriClient.writeFile` and the worker's
`write` message, the player's `_httpWait`.

**The tag** [disasm]. `\![execute,X,…]` matches X by its first 3 letters: `htt`, `rss`, `ica`, `web`. The kind is a
substring test (`rss`, `websock`, `ical`, else HTTP), the method the first of `post get head put delete patch options`
found anywhere in X (none: GET). Fewer than 3 arguments: nothing. rss, ical and websocket stay unsupported (logged once)
[decision: no corpus ghost uses them]. `\![cancel,X,URL]` (any of the four X) aborts the first threaded
request in flight with that URL, any case; it fails with R4 `artificial`.

**Options** (`parseHttpOptions`) [disasm `ParseOptions` 0x664b50]: the first argument is the URL unless it starts with
`--` (then only `--url=` gives one). Each other token is matched case-insensitively by prefix in SSP's order; the
first match wins; an empty value (`--file=`, `--async=`) is ignored, except for `--nofile=`, `--streaming=` and
`--expand=`, which switch their mode on before the check (0x664ef8, 0x6651ff, 0x664e1b): `--nofile=` keeps the body in
R3 in the charset given earlier (default UTF-8), `--streaming=` streams with no decoder named. A repeat overrides,
except `--param=` and `--header=`, which add up. Any other token is one more parameter, the whole token: the legacy
`\![execute,http-get,URL,p=SSP 伺か]`, and also a bare `--async` (so that request is synchronous) or a `--body=`. SSP's
list is ParseParameters' NUL-separated multi-string, which ends at its first empty string (0x66526c): an empty last
argument. An empty argument before others is stored as the placeholder `" "` (0x6242e2, SS §3.4), so it is one more
token, a parameter `" "`, and the walk goes on [disasm].

The tag's arguments are split as SS §3.4 says [disasm]: a `"` opens a quote anywhere in an argument and is dropped,
`,` and `]` are data inside it. The corpus' web claps put the user's text in quotes after the parameter name (73 of
the 75 tags with a mid-argument quote, 33 ghost folders; `scratch/tagquotes/ssp.md` §10); roommate's
(`dic_Menu.txt:853`) and yomi_to_syu's
`--param=message_body="[（拍手送信元）]（拍手送信内容）"` even hold a literal `]`. Each is one tag of five arguments, so
roommate posts what ssp.exe posts: `message_body=%5B%E7%90%A5%E7%8F%80+%E3%81%82%E3%81%8B%E3%81%AD%5D…` (`[琥珀 あかね]`
and the text, no `%22`; 110 bytes for `こんにちは`), threaded, and hears `OnExecuteHTTPComplete` / `Failure` with R1
`webclap`, which its own handlers answer (`tests/runtime/http.test.mjs` plays it on the real Satori engine). A `,` or
`]` in the user's text stays in the value. A single `"` in it reopens the quote up to the end of the script: SSP logs
"Unclosed '['", sends nothing and drops the rest of the script, `\e` included; so does Sumika.

| Option | SSP [disasm] | Sumika |
|---|---|---|
| `--async=ID`, `--event=ID` | a worker thread; the script goes on | the script goes on |
| `--sync=ID`, or neither | inline on the ghost's script thread: the script waits at the tag | the player holds the run at the tag (`_httpWait`) until the event's reply has started; then its `\__w` base moves to now (SSP's `ResetWait`) |
| `--file=NAME` | `ghost/master/var/` + the name cleaned (below) | the same, in the engine's file system |
| `--timeout=N` | seconds per wait for data (connect, answer, each chunk), default 10, at most 300, 0 = default | the same: a stall timer, reset by the answer and by each chunk |
| `--nofile[=charset]` | no file; R3 = the body (≤ 128 KB) decoded, line breaks as byte 1; `--nofile=` with no charset is on too, and what follows a bare `--nofile` is a charset (0x664f2d) | the same (`TextDecoder`) |
| `--param=V`, unknown tokens | parameters, in `--param-charset` (default UTF-8) | the same; Shift_JIS as CP932 the way Windows writes it (JIS X 0208 / NEC row 13, then IBM, then NEC-selected, plus Windows' best fit), EUC-JP; other names UTF-8 [guess] |
| `--content-type=T` | the body's type (below) | the same |
| `--param-input-file=P` | the body from a file (relative to `ghost/master/`, inside SSP's folders) | from the engine's `ghost/master/` only, never a personal file (`*_variable.*`, `satori_save*`, `*.log`, `profile/`) [decision], judged on the path as the engine resolves it (`yaya_variable.cfg/.`, `x/../aya5_variable.cfg//` are the save: `masterRel` / `personalFile` in `engine-files.js`), by `HttpRequests` and again by the worker's `read`; the worker's `read` also refuses any file the visitor's own run wrote (a stored key with bytes: a save of any name, a rewritten shipped file, a download; any case), for every engine, because Kawari saves have no fixed names (`visitorFile`, `readForUpload` [decision]; no corpus ghost uses this option); otherwise dropped, as SSP drops a bad path |
| `--header=Name: value` | added or replaced, never Host, Accept-Encoding, TE, Connection, Proxy-Connection; a line without `:` that starts with a blank continues the last | the same; the browser's forbidden names and invalid ones left out |
| `--authorization=`, `--accept=`, `--accept-language=L` | ASCII only; `Accept-Language: L, <L before '-'>;q=0.9, en;q=0.2, *;q=0.1`, default `*` | the same (they make a CORS preflight, except Accept and Accept-Language) |
| `--cookie=C` | `Cookie: C` | **not sent**: a browser forbids it, and requests carry no cookies [decision] |
| `--no-cache` | `Pragma` / `Cache-Control: no-cache` | what every request does here: fetch `cache: 'no-store'` (Privacy, below), for which the browser adds the same two |
| `--nodescript` | no online marker, no progress, no OnNetworkHeavy | no OnNetworkHeavy, no Progress (the balloons draw no online marker yet) |
| `--progress-notify` | `…Progress` events (once a second while waiting, at most every 333 ms while the body arrives) | the same |
| `--streaming`, `--streaming=` | its own events (not traced) | Failure `paramerror` at once [decision] |
| `--log=`, `--insecure`, `--from=` … `--limit=`, `--websocket-protocol=` | the traffic log; no TLS check; rss / ical / websocket | ignored [decision: a browser has neither] |

**What is sent** [disasm `SPHttp::RealRead`, `SPHttp_MakeParam`, `SPUtils::EncodePercent`] (`buildHttpRequest`):
- GET, HEAD, DELETE, OPTIONS: the parameters as a query, `?` appended even after an existing query. POST, PUT, PATCH: a
  body. No parameters: an empty body without Content-Type.
- Parameters split at byte 1. When the `=` count equals the item count, each is `name=value`: joined by `&`, name and
  value percent-encoded unless they already look encoded (`IsPercentEncoded`: only bytes that need no encoding, `%`,
  `;`, `+`, and `& / +` in a name, `& / = +` in a value). Otherwise (a user's own `&` or `=`, b-d's
  `message_name="…"&message_body="…"` in one `--param`, which arrives without its quotes) the items are joined by
  CRLF and the whole is encoded keeping `& / =`. Body (form mode) encoding keeps `A–Z a–z 0–9 * - . _` and sends a space as `+`; query (URL mode) encoding
  escapes only control bytes, bytes ≥ 0x7E, space (`%20`), `" # < > ` { } ?`.
- Content type: the default and any type containing `form-urlencoded` send exactly
  `application/x-www-form-urlencoded`; exactly `multipart/form-data` sends parts with the boundary
  `----SSPFormBoundary` + 16 random characters (no fallback: items without `=` make an empty body); any other type
  sends the parameters as stored (CRLF-joined for `text/*`, byte 1 between them otherwise).
- SSP's own headers (User-Agent `SSP/2.9.08f …`, Referer `<scheme>://<host>/index.html`, Accept-Charset, Connection,
  TE, Upgrade-Insecure-Requests, `If-Modified-Since` from an existing file) are the browser's to send or forbidden; the
  browser sends its own User-Agent and, with `no-referrer`, no Referer. Redirects: followed by the browser (its limit,
  not SSP's 32).

**The browser's rules** [decision]:
- **Privacy.** `credentials: 'omit'` (no cookies, no HTTP auth of the visitor), `referrerPolicy: 'no-referrer'` (the
  visitor's page URL never reaches a ghost author's site), `cache: 'no-store'` (always asked again, as SSP asks, and
  nothing kept: with `no-cache` the browser would store the answer and send its `ETag` / date back as `If-None-Match`
  / `If-Modified-Since`, an identifier a server can hand each visitor in place of a cookie; for `no-store` the
  browser also adds `Pragma` / `Cache-Control: no-cache`, SSP's `--no-cache` headers [doc: the Fetch standard's
  HTTP-network-or-cache fetch]). The browser still sends
  `Origin` on a POST and on a CORS request, so each host learns the site's origin (not the page), and the visitor's IP
  address, as SSP's requests show the user's.
- **no-cors.** A simple POST (CORS-safelisted method, headers and content type) that saves nothing (no `--file`, no
  `--nofile`, no `--progress-notify`) is sent in `mode: 'no-cors'`: the server gets it exactly as SSP sends it, and the
  opaque answer counts as SSP's success: Complete with R4 `200`, R5 and R6 empty, no file [decision]. That is most web
  claps of the corpus (those without `--file`). A host that cannot be reached still fails (`error`). SSP would also
  save the answer as `var/clap.php` (the URL's last segment); no corpus ghost reads that file. Everything else uses
  `mode: 'cors'`.
- **What fails.** A CORS refusal (the host sends no `Access-Control-Allow-Origin`), mixed content (every corpus URL is
  `http://`, which an `https://` page may not fetch; on `http://localhost` they go out), a dead host, a `file:` URL (a
  browser has no local files): fetch's TypeError, R4 `error`, as SSP reports a connect failure. A stall:
  `timeout`. A blocked host's CORS GET or a no-cors POST still reaches the server (a simple request needs no
  preflight): bonsyou's `.cgi` counts the gong even when the browser hides the answer [infer].
- **Where it runs.** On the page (the EventLoop's fetch), so the event and the file can follow at once; a request of
  a simple shape with a body of at most 8 KB (32 KB in flight) is `keepalive`, so a page left meanwhile still delivers
  it. Its event and file are **dropped**: the next page never hears of it (the replayed script never sends the tag
  again: a side effect, SS §7), as SSP drops the events of a ghost that went (§8 of the notes) [decision].
- **No cap** on requests at once: SSP starts a thread per threaded request [disasm]; the browser queues per host.

**The file** [disasm `MakeVarPath`, `CleanupFilenameW`]: `ghost/master/var/` (made when missing) + `--file`'s name, or
the URL cut at its first `?` / `#` and taken after its last `/` (`index.html` when empty and for `data:`); each of
`\ ₩ ･ / U+200B U+202A U+202E U+FEFF ｦ : , ; * ? " < > |` becomes `_` (no subfolders, no way out of `var`), a DOS device
stem (`con.txt`) gets `_` first. What is written [disasm `RealRead`, `httpStatus`]: the body of a success that reads
one (200, 202, 203; R4 table); and the error page of a failing status (`404`, `500`, a `204` to GET …) when the
request is threaded (`--async`: Execute sets SPHttp flag 0x10, 0x666814; RealRead reads it 0x65f1f0–0x65f205) and the
answer has a Content-Length above 0 (0x65f8ab–0x65f8d2: the normal read path 0x65f276, a stream on the target file
0x6602b7), so bonsyou's `var/bonsyou_now.txt` becomes a 404 page before OnCountCompleteMenuFailure; a synchronous
request drains that page and drops it (`RealReadContent` with no target, 0x65f3fa–0x65f45e). With `--nofile` the same
page goes to R3 instead. Nothing is written for a 204 to HEAD / OPTIONS, a 201 to PUT or a 304 (the old file stays).
A read that fails (a stall, `\![cancel]`, a body shorter than its Content-Length) empties what came and SSP deletes
the file it had begun (0x6607e0–0x6608f3: the previous download is gone too); Sumika writes nothing then and the
previous download stays [decision: the worker deletes no file]. A file goes into the engine's file system before the
event is sent (`ShioriClient.writeFile` in the request queue; the worker writes it before its first `await`), so the
reply's `FOPEN('var/…')` reads it (bonsyou). It persists per visitor like any file the ghost writes (IndexedDB
`ghost:<id>:files`; YAYA `ghost/master/var/<name>`, Satori `var/<name>`; YAYA never keeps `*.log`), and the next
download replaces it. A write that fails: Failure `fileio`. The SSP install's copies are personal (`PERSONAL_PATHS`:
bonsyou's `ghost/master/var/bonsyou*.txt`).

**Events** [disasm `SPHttpRequest::NotifyEvent` 0x667c30]: GET, `SenderType: internal`, `SecurityLevel: local`; the
reply plays like a user event's (origin `user`: it cuts what the ghost was saying) [infer: SSP plays it like any GET
reply].

| | no ID, or an ID not starting with `On` | ID starting with `On` (case-sensitive) |
|---|---|---|
| success | `OnExecuteHTTPComplete` | `ID` |
| failure | `OnExecuteHTTPFailure` | `ID` + `Failure` |
| progress (`--progress-notify`) | `OnExecuteHTTPProgress` | `ID` + `Progress` |

References, always 7: R0 the method in lower case; R1 the ID as written (empty without one); R2 the URL as given
(`ws://` / `wss://` made `http://` / `https://`, no added query); R3 the file's full path in the engine's file system
(`/ssp/ghost/<id>/ghost/master/var/<name>`, Satori `/ghost/master/var/<name>`; on a failure the path it would have
written); with `--nofile` the body read (a threaded request's error page too; empty when nothing was read: a
synchronous failure, a read that failed; in Progress what came so far) [disasm: NotifyEvent reads the request's
memory buffer, 0x667cda–0x667dc9]; R4 `200` on every success and in Progress, else the reason; R5 the cookies the
answer set (always empty: a browser hides `Set-Cookie`); R6 the answer's headers, each `name: value` + byte 1 (only
what CORS exposes, names in lower case; empty for no-cors), from the moment they came: in Complete, in a Failure
after them (a failing status, a stall or `\![cancel]` while the body comes) and in the Progress events after them
[disasm: RealRead dumps them before it looks at the status, 0x65f243–0x65f254, with the flag Execute sets at
0x666847; NotifyEvent reads the live SPHttp, 0x667e78–0x667ea9].

| R4 | SSP | Sumika |
|---|---|---|
| `200` | 200, 202, 203 (the body read: 0x65f3d6–0x65f3ee → 0x65f276); 204 to HEAD or OPTIONS (0x65f781–0x65f798), 201 to PUT (0x65fa69, before the body is read), 304 with a target file (0x65f666, the old file stays): code 0 at 0x6601b8 | the same (`httpStatus`); a no-cors answer [decision] |
| `404` | 201 to any other method, 300–303, 307, 308: `SPHttp::Redirect` (0x65fac8), which follows the `Location` and fails as 404 without one (0x6626ff → 0x662932) | the same for an answer the browser hands over without a `Location`; it follows 301–308 that have one itself; a 201 or 300 with a visible `Location`: R4 the status [guess: SSP would follow it] |
| the status (`404`, `500`, `204` to GET, `205`, `206` …) | any other final status (returned at 0x65fa54, Failure for any code but 0: 0x667f6c / 0x668089); a 401 goes through `SPHttp::ExecAuth` first [unread] | the same |
| `error` | a connect failure, an URL that does not parse (with `--file`), … | a fetch TypeError (CORS, mixed content, dead host), `file:`, no fetch at all |
| `timeout` | a wait for data longer than the timeout | the same (the stall timer) |
| `artificial` | `\![cancel]` | the same |
| `downloading` | the same URL is in flight (a threaded request, any case): the later request fails at once | the same, page-wide |
| `fileio` | the file cannot be written | the same |
| `paramerror` | `--streaming` without `--async` | every `--streaming` [decision] |

- **When.** A synchronous request's event (and the `downloading` / `paramerror` failures, raised inside the tag) is sent
  before the script goes on; a non-empty reply replaces the run, as a `\![raise]` reply does [disasm: the event is
  raised from inside the tag; how SSP's `PlayScriptInternal` treats the waiting script was not traced]. A threaded
  request's event comes when it ends. Without `--nodescript` a threaded request also sends GET `OnNetworkHeavy` [R0 the
  timeout in seconds, R1 the seconds waited] at half of the timeout without data [disasm; GET infer].
- **Who hears them.** Only the ghost that ran the tag. Nothing is sent before boot, after Close, while frozen (another
  tab took the set over) or after the ghost left (a ghost change); a closing ghost's goodbye still sends (bee, clare
  post from OnClose). A request still running when its ghost goes keeps running but delivers no file and no event
  (`HttpRequests.invalidate`) [disasm `InvalidateCallbacksForGhost`]. While the ghost is locked (minimized, passive,
  induction, `\t`) the file lands and the event is dropped [disasm `SPGhost::OnNotifyEvent`; IsLocked as §2.7's
  guess]. The duplicate check and `\![cancel]` see every threaded request of the page, as SSP's one `SPHttpManager`
  sees every ghost's [disasm]; the event still goes to the ghost that asked.
- Not sent [decision]: `OnExecuteHTTPSSLInfo` (a browser shows no certificate), the `…Streaming` events, SSP's own
  `#update slow` / `#update heavy` talk.

Known gaps: a read that fails leaves the previous download in place, where SSP deletes it (The file, above); a
synchronous request's error page is dropped at once, where SSP first drains it (only its wait differs). bonsyou's gong counter
(OnCountComplete) follows its OnSoundStop (§4.17). Nothing has been tried in a real
browser against a real host (the tests use a fake fetch; the sweep counts requests and sends none).

### 4.16 User information: `OnNotifyUserInfo` and `%username` (P1; implemented)

What ssp.exe does [disasm `SPShiori::NotifyUserInfo` 0x70F440, `CSetupDefDlg` 0x4A4930–0x4A5417, `OnSSPSysMsg`
0x46B478, `SPGhost::GetUserNameW` 0x643A10]; the Preferences box itself is UI §2.13:

- **NOTIFY OnNotifyUserInfo** [R0 nickname, R1 name, R2 birthday `%04d,%02d,%02d` (`2003,05,05`; `""` when never
  set), R3 `male` / `female` / `undef`], SenderType internal, never a COMMUNICATE. Sent at every SHIORI load, after
  `GET version` / `name` / `craftman` / `craftmanw`, **right before `otherghostname`** [disasm 0x621B66]; and to
  **every running ghost** when the settings dialog's General page closes (a page switch or the dialog's close) after
  any of the four user fields was touched, even changed back. OK and Cancel only close; nothing else is sent. SSP's
  defaults (Windows' registered owner, the nickname a copy of it) make R0 practically never empty.
- **`%username`**: `GET username` to the ghost at each expansion, no cache; 204 or empty → SSP's nickname setting.
  Nothing is asked at boot. The property `….username` asks only the ghost and fails without an answer (properties.md
  §5.4).

Sumika (`src/core/events.js`, `site.js`, `user.js`):

- **The profile**: one site-wide `UserProfile` (`Site.user`, the page's `sharedUser()`), runtime prefs key `user`
  (UI §2.13 "Storage"). R0 the nickname, else the name, else `""`; R1 the name; R2 as ssp.exe; R3 the sex or `undef`
  (`UserProfile.refs()`). Never logged, never in a URL; it reaches only the ghosts' own engines.
- **Boot batch**: `NOTIFY OnNotifyUserInfo` right after `OnNotifySelfInfo` and before `otherghostname`, on every engine
  load (cold boot, resume, `afterEngineRestart`), **only once the visitor has saved the box** (any field stored:
  `UserProfile.isSet()`) [decision]: a browser has no Windows name, and an empty R0 is a state no
  ghost meets in SSP (it would replace etherism's own default `ユーザ` [corpus dic01_Base.txt:13]).
- **The box closes after an edit** (`SettingsWindow` onClose `{touched: true}`): `Site.notifyUserInfo()` → the NOTIFY to
  every slot whose loop is booted and neither closed nor frozen (`EventLoop.notifyUserInfo()`); passive, minimized and
  `\t` do not stop it (ssp.exe calls it directly). Closed untouched, or left open when the page goes: nothing (the next
  page's boot batch tells every ghost). A change another tab made is not sent here (that tab's box sent it to the
  ghosts it ran).
- **`%username`** (`EventLoop._username`): `GET username` at each expansion; else `UserProfile.nickname()` (the
  nickname, else the name); else the word `user` [decision]. The expander doubles its backslashes.
- emily4 (her framework marks itself `Run` on the boot `GET version`, so only an OnNotifyUserInfo with a non-empty R0
  names the visitor [probe]): her first boot ends with `\![open,configurationdialog,setup]`, which opens the
  box; a nickname typed and the box closed names her visitor at once. Closed empty, she stays nameless (yaya-wasm.md
  §16).
- Not sent: `GET OnConfigurationDialogHelp` (the box has no `?` help) [decision].

### 4.17 Sound events: `OnSoundStop`, `OnSoundLoop`, `OnSoundError` (P2; implemented)

What ssp.exe 2.9.10.3000 does [disasm; `SPSoundManager`, `SPSoundDesc`]:

- **Who reports.** Each ghost has its own `SPSoundManager`, bound to it (`CMediaHelperGhostWnd::OnCreate` 0x46eacd), and
  its send flag [mgr+0x140] is 1 from the constructor on (0x724c7a, the only writer): every sound a script starts
  reports. Only ssp.exe's own sounds (the Talk.Sound setting posts wParam 0x90000, 0x62907d) carry desc flag 8, which
  silences both StopEvent (0x71997c) and MediaNotifyError (0x725027).
- **Which tags.** `\_v[f]` plays with flags 0 (`\_V` waits for it; 0x62afdb, post at 0x62b094); `\8[f]` with flags 1
  (not waited for; 0x62aa71; an encrypted `.daw/.ddw/.dfw/.dgw` is decoded first and played with flags 5, 0x62a9b7);
  `\![sound,play,f,…]` with flags 0 inside a script; `\![sound,loop,f]` with flags 3 (loop, not waited for; 0x62deab).
  All of them report. SAORI players never send these events (dsaudio's OnDSAPlayFinish, mciaudior's OnMAA*: §4.14,
  TS §3.4).
- **OnSoundStop** [R0 the file argument exactly as the tag gave it: case kept, not the resolved path, no options
  (`MediaFindInactiveOrNewRefAdd` copies it to desc+0x528, 0x7253f4–0x725407; `MediaLoadFile` keeps the resolved path
  apart, +0x5b4, 0x724f86); R1 the reason] (`StopEvent` 0x719860: refs [+0x528, reason], 2, 0x7199cf–0x7199e9). The
  reasons: `end` when the sound finishes on its own (`OnComplete` → StopEvent(…, L"end"), 0x725c71); `close` when the
  player window opened with `--window` is closed (`OnPlayerWindowClosed`, 0x725cb5). No reason, no event (0x719982):
  `\![sound,stop,f]` calls StopEvent(ghost, 0, …) (0x72578a–0x72579c); `\![sound,stop]` without a file is StopAll
  (0x7257ac → MediaDoAllPlaying(3), 0x725cd0), no StopEvent; a ghost that closes or changes stops everything the same
  way (`CMediaHelperGhostWnd::Shutdown` → StopAll, 0x46eae0). A new script or a script break leaves sounds playing,
  except the `\_V` case below.
- **OnSoundLoop** [R0 the file]: when a loop sound completes normally (OnComplete: code bit 1 and desc flag 2,
  0x725c28–0x725c34), ssp.exe seeks it back to the start itself (SendCommand(8, 1), 0x725c3c) and sends it
  (`LoopNextEvent`: one Reference, 0x719b4b–0x719b69). A loop that ends without the normal-completion bit sends
  OnSoundStop `end` (0x725c64).
- **OnSoundError** [R0 `play`, fixed, a loop's too (0x725181); R1 the error code's low 16 bits as `%u`
  (0x725107–0x72511a); R2 the file as given (+0x528, 0x725143); R3 the player's error text (`GetErrorMsg`, 0x725052),
  else FormatMessageW's text for the code (0x7250de)]: `MediaNotifyError` 0x725000, 4 References, when play or loop
  cannot load or start the file (from Execute's play, 0x725669, and `MediaPlayFile`, 0x724dc4). A failed
  `\![sound,load]` only releases its desc (0x7254c0): no event. An error during playback ends as OnSoundStop `end`
  [infer].
- **The same file again.** A play of a file that is still there (`MediaFindPlayingRefAdd`: `wcsicmp_custom` on
  +0x528, so any case, 0x725225) starts that sound over with the new tag's flags (SendCommand(8), the flags replaced:
  0x725527–0x72556f), except that a paused one is only rewound and stays paused until its resume (SendCommand(8,
  [desc+0xb]==0): the paused flag set by pause 0x719703, cleared by resume 0x719718; Sumika the same); the cut play
  sends nothing, and a completion of it that arrives late is ignored
  (`IsCurrentNotify`, 0x725c1f). Stop, pause and resume with a file match the same way. Each new file gets its own
  desc (0x7253c4): different files play side by side.
- **How they are sent.** All three go through `SPGhost::OnNotifyEventThread`(id, refs, n, 0, 0, 0, false) (0x7199f0,
  0x719b69, 0x72518b): an SPShioriEvent with SenderType `internal` (0x641f53) whose notify byte is that last `false`
  (0x641f85), so a GET; `SPGhost::OnNotifyEvent` sends it (SendEvent 0x642234; notify 0 does not return early,
  0x642239) and plays the reply with PlayScriptWithMsg(result, 0, 0, 0) (0x64242d), as a `\![raiseother]` reply
  (§2.7.9).
- **`\_V` / `\![sound,wait]`** wait on one event per ghost. Every waitable start resets it (`\_v` 0x62b00d,
  `\![sound,play]` in a script 0x62deee, a play that started 0x725601; not `\8`, not a loop); a waitable sound's end,
  stop or failure and StopAll set it (StopEvent when desc flag 1 is clear, 0x719964–0x719970; the error path
  0x725677–0x72568d; StopAll 0x725ce4). So the wait (`WaitSound`, Wait(-1), 0x640124) returns at the first waitable
  end; with nothing playing it does not wait [doc]. A break while a script waits there (a balloon double-click, a
  choice, a tag's `\![change,ghost]`) stops every sound of the ghost, no event (WaitSound sets [ghost+0x30c]=1,
  0x64010d; BreakScript posts StopAll when it is set, 0x63d992–0x63d9b1).
- **The mciaudior emulation** (`SPSaoriMCIAUDIOR`) plays through the same sound manager with
  `--mciaudior-compatible=1` (0x6d6231). For those sounds StopEvent and LoopNextEvent send OnMAAPlayFinish /
  OnMAAPlayLoop instead (desc+0x650, 0x719989, 0x719b05) [R0 the name, which the emulation made absolute
  (MakeAbsolutePath, 0x6d60e5); R1 `%d` of the player's impl+0x98 / 10^7, whole seconds (0x719920, 0x719993)]. Whether
  it replaces a ghost's own `mciaudior.dll` was not traced; Sumika's stand-in keeps R0 as loaded and R1 `0` (TS §3.4)
  [guess].
- **Corpus** [corpus: a corpus of 320 ghost archives]. Only bonsyou and cyau_cyaka define OnSoundStop; no
  ghost defines OnSoundLoop or OnSoundError. bonsyou's DoGong sets `GongLock = 1` and plays
  `\![sound,play,bonsyou.wav]`; its OnSoundStop (`'bonsyou' _in_ reference[0]`) clears the lock and sends
  `\![execute,http-get,http://ms.shillest.net/resource/bonsyou_count.cgi,--async=OnCountComplete,--file=bonsyou.txt]`,
  whose OnCountComplete reads `var/bonsyou.txt` (`yaya_all.txt:71-98`). cyau_cyaka's music player compares
  `reference0` with its own argument (`dic_jp/cya_musicplayer.dic:391`). `\_v[` appears in 29 archives (tok_2: 1,034
  lines), `\8[` in 1 (PICKLES_34th: 446 lines), `\![sound,play` in 4, `\![sound,loop` only in cyau_cyaka.

Sumika (`src/core/page-saori.js` `PageSaori.sound`, one per ghost, its host the ghost's EventLoop: `runtime.js`):

- **The player.** One HTMLAudioElement per file name, any case (`_findSound`). A play or loop of a name that is still
  there starts that element over (`currentTime = 0`, the new tag's loop flag), silently; an `ended` that arrives after
  such a restart (`ended === false`) is ignored. Different files play side by side. Stop, pause and resume by name
  (any case) or all. `\_v` and `\8` both reach it as `play` (the player, SS §5.8).
- **MIDI** (`docs/research/midi.md` §6): a file whose name as the tag gave it ends in
  `.mid`, `.midi`, `.smf` or `.rmi` gets a MIDI player of the page's engine (`src/core/midi.js`) in place of the
  element, element-like, so every rule here holds for it unchanged: OnSoundStop [file, `end`] at the end of its last
  track (DirectShow reports the file's length [infer; midi.md §5.5, V2]), a loop started over by hand from tick 0
  with OnSoundLoop, OnSoundError 14020 when it cannot start (the file, the bank, the player). A stopped or dropped
  MIDI sound is released (its node and song go). Where the player cannot run (no secure context or AudioWorklet) a
  MIDI file goes to the element.
- **The events** go through `host.notifyEvent`, the EventLoop's SPGhost::OnNotifyEvent (GET, origin `other`,
  SenderType `internal`; the reply plays as a raiseother reply's; nothing before boot, once closed, during a ghost
  change or while frozen; minimized: sent, its reply not played, so bonsyou's lock still clears). OnSoundStop
  [the file as the tag gave it, `end`] at the element's natural `ended`; OnSoundLoop [file] each time a loop starts
  over (the element's own `loop` stays off, so each end is seen and restarted by hand, as for mciaudior); OnSoundError
  below. A stop, a page change and the ghost's close or change (`destroy`) clear the element's handlers first, so it
  never reports. `close` never occurs (no `--window` player).
- **OnSoundError** [R1 and R3 guess: Windows' en-US texts]: a file the site lacks (not in the
  ghost's folder; a dropped file no longer stored, or not open within the timeout) → [`play`, `2`, file, `The system
  cannot find the file specified.`] (ERROR_FILE_NOT_FOUND); an element that fails before it ever played (its `error`,
  or a `play()` rejection other than autoplay's NotAllowedError or a pause's AbortError) → [`play`, `14020`, file,
  `The byte stream type of the given URL is unsupported.`] (MF_E_UNSUPPORTED_BYTESTREAM_TYPE 0xC00D36C4), once. An
  element that fails after it played ends as OnSoundStop `end` [infer]. `\![sound,play]` without a file sends nothing
  (ssp.exe plays nothing without the argument, 0x62deb2). Autoplay blocked: the sound waits for the visitor's next
  gesture, and its end with it.
- **Without an Audio constructor** (Node; the sweep has its own audio stub) nothing plays and nothing is sent
  [decision], so the sweep sees none of these events.
- bonsyou end to end on the real YAYA engine (`tests/runtime/http.test.mjs`): 鳴らしてみる rings, a second press
  answers 「連続では鳴らせません。」, the gong's end sends OnSoundStop [`bonsyou.wav`, `end`], its reply's http-get
  fetches the count (a fake fetch), OnCountComplete reads it, and the gong rings again.

Known gaps:
- `\_V` / `\![sound,wait]` still do not wait (`EventLoop.sound` gives the player's `_soundWait` nothing to wait on),
  and the break stop above is not copied.
- The `\![sound]` sub-commands are whole words (any case) here; ssp.exe matches prefixes (SS §5.8).
- Every sound that ends costs a GET (29 corpus ghosts use `\_v`); a ghost whose catch-all answers any event would
  cut its own talk with the reply, as in ssp.exe (the same OnNotifyEvent path). The sweep cannot show it.
- A sound cut by a page change never reports (the page's sounds end with it); one that ends during a ghost change's
  goodbye is not sent (notifyEvent's rule), where ssp.exe's goodbye ghost would still hear it.
- What the browser cannot play (WMA; MIDI where the MIDI player cannot run: plain `http://`, no AudioWorklet) gives
  OnSoundError, where ssp.exe plays it and sends OnSoundStop.
- A loop restarted by hand leaves a short gap at each start, as ssp.exe's own restart on completion does [infer].

---

## 5. Resource GETs (menus and UI)

### 5.1 When the runtime asks (P1)

On a right-click on the character of scope `c` (prefix `c.` = `sakura.`, `kero.` or `char<c>.`), two rounds
(`askMenu`, `src/ui/menu.js`; `ssp-ui.md` §2.1 Notes "Which menu a right-click opens", §2.11 has the items): first the
gate, the clicked character's `popupmenu.*` [disasm 2.9.10 `CCharWndCode::OnCWContextMenuSSP` 0x41af93..0x41b014]; then
one batch for the shown menu's owner `s` (prefix `p`; `s` = `c` unless `c.popupmenu.type` names another character
whose window exists) (`menuResourceIds(s)`). This follows ssp.exe 2.9.08f's lookup [disasm
`ModifyMenuWithTable`, `ModifyPopupMenu`, `CCharWndCode::ModifyPopupMenu`], not the order of [L 1633–3523] (SSP 2.02)
and ninix:

```
the gate (the clicked character c), every open, both always:
c.popupmenu.visible             -> ParseBool 0 ("0", "false", "off", "none" …): no menu at all (default: shown)
c.popupmenu.type                -> the character whose menu is shown (no answer: c's own; "sakura" 0, "kero" 1,
                                   "char<n>" n, else wtoul: any other word 0)
then, in a menu redirected to another character (s != c), first: c.popupmenu.applybindtoself (ParseBool, default 1)
main menu (s = 0):
recommendrootbutton.visible, sakura.recommendbuttoncaption, recommendrootbutton.caption, sakura.recommendsites
portalrootbutton.visible,    sakura.portalbuttoncaption,    portalrootbutton.caption,    sakura.portalsites
readmebutton.visible, readmebuttoncaption, readmebutton.caption
then for every other item X of the menu: X.visible, X.caption (table below)
abbreviated menu (s >= 1):
<p>recommendrootbutton.visible, <p>recommendbuttoncaption, <p>recommendrootbutton.caption,
<p>recommendsites, then dressuprootbutton, dressupexplorerbutton, charmovebutton, closebutton, quitbutton (.visible,
.caption) without a prefix
```

Earlier the batch began with `<p>popupmenu.visible` (`'0'` only) and `popupmenu.type` was never asked, so a
menu always followed the clicked character (BloodTeaHOUSE ver.5's `\1` answers `kero.popupmenu.type` `0` in its first-boot
welcome and Xmas modes: the main menu in ssp.exe; `ssp-ui.md` §2.1 Notes) [disasm; measured].

* **Legacy names are asked first**, the new name second, wherever SSP has one [disasm] (the reverse of 2.02's log and
  of ninix). The menu shows the first non-empty caption in that order [guess: which caption wins when a ghost answers
  both was not compared with ssp.exe, `ssp-ui.md` §2.11].
* The dress-up, Dressup explorer, Move character window, Close and Quit ids carry **no scope prefix** in either menu;
  the abbreviated menu's recommend ids **do** (`kero.recommendrootbutton.visible`, `char2.recommendsites`) [disasm].
* **`X.visible` = `0` greys the item; it does not remove it** [disasm: a `0` reply becomes `MF_GRAYED`; UKADOC words it
  "0なら非表示（クリック出来なくなる）"]. Only the clicked character's `<p>.popupmenu.visible` `0` (ParseBool) still means
  no menu.
* The `update*` and `vanish*` ids, which ssp.exe asks right after the portal ids, are not asked: there is no Network
  update or Uninstall [decision].
* `leavepassivebutton.*` is asked only when Reset passive mode is shown (`?sumika-debug`, SSP: "Enable functions for
  developers") [disasm; decision].

Re-request every time the menu opens: Satori picks a random caption among a word group's alternatives each time, and
Tsubasa has 2–3 per caption [T dic06_String.txt:12190ff]. With the SSP option "ghost-defined menu off" no resources are
requested [U-help config-ghost]. Cache nothing.

### 5.2 Table

`visible` resources: reply `0` greys the item (it is not left out), `1` shows it, and 204 means **shown** [U-res; disasm]. Captions: 204 means the
runtime default text. Every value in this table has SSP's `\&[name]` entities decoded before it is used (§5.5). Tsubasa
column: ✓ = she answers [T].

| ID | Reply format | Default when 204 | Tsubasa | P |
|---|---|---|---|---|
| `<p>.popupmenu.visible`, `<p>.popupmenu.type` of the clicked character (`sakura.`, `kero.`, `char<n>.`; §5.1's gate) | ParseBool; a character (`sakura`, `kero`, `char<n>`, a number) | a menu; the clicked character's own | – (bthver.5: `kero.popupmenu.type` `0` in Mode `Tea0` / `Xmas*`, else `1`) | implemented (`ssp-ui.md` §2.1 Notes) |
| `<p>.popupmenu.applybindtoself` of the clicked character, asked only in a menu `type` redirected | ParseBool | 1: Clothes/Dressup ▸ lists the clicked character's parts (0: the menu owner's) | – | implemented (`ssp-ui.md` §2.11) |
| `sakura.recommendsites`, `kero.recommendsites`, `char<n>.recommendsites` | site list (5.3) | submenu shown, greyed (not left out) | ✓ (54 entries incl. separators) | P1 |
| `sakura.portalsites` | site list | submenu shown, greyed | ✓ | P1 |
| `recommendrootbutton.caption` (legacy `sakura.recommendbuttoncaption`, asked first); abbreviated menu: `<p>recommendrootbutton.caption` (legacy `<p>recommendbuttoncaption`) | text with `&` accelerator | "Recommended Sites" | ✓ | P1 |
| `portalrootbutton.caption` (legacy `sakura.portalbuttoncaption`, asked first) | text | "Portal Sites" | ✓ | P1 |
| `dressuprootbutton.visible` / `.caption` (no prefix in either menu) | `1`/`0`; text | shown; "&Clothes/Dressup" | ✓ ✓ ("Dress-up(&C)") | P1 |
| `dressupexplorerbutton`, `charmovebutton`, `quitbutton` `.visible` / `.caption` (no prefix in either menu) | | shown; "Dressup &explorer" (always greyed here), "Move character window", "Quit (&X)" | – | P1 |
| `hidebutton.visible` / `.caption` | | shown; "Hide" | – ✓ | P1 |
| `closebutton.visible` / `.caption` | | shown; "Close" | – | P1 |
| `vanishbutton.visible` (legacy `vanishbuttonvisible`) / `vanishbutton.caption` (legacy `vanishbuttoncaption`; legacy asked first) | | not asked: there is no Uninstall [decision] | ✓ ✓ | P2 |
| `readmebutton.visible` / `.caption` (legacy `readmebuttoncaption`, asked first) | | shown; "About this &ghost..." | – ✓ | P1 |
| `updatebutton.visible` / `.caption` (legacy `updatebuttoncaption`, then `sakura.updatebuttoncaption`, asked first) | | not asked: there is no Network update [decision] | ✓ ✓ | P1 |
| `ghostrootbutton`, `shellrootbutton`, `balloonrootbutton` `.visible`/`.caption` | | shown | – | P1 |
| `inforootbutton`, `firststaffbutton`, `termsbutton`, `helpbutton`, `aistatebutton`, `rateofusebutton`, `systeminfobutton`, `utilityrootbutton`, `resettodefaultbutton`, `leavepassivebutton` `.visible`/`.caption` | | shown (Information ▸, Utilities ▸; `ssp-ui.md` §2.11) | – | P1 |
| `callghostrootbutton` `.visible`/`.caption` | | (item not offered until two ghosts can stand) | – | P2 |
| `shellscalerootbutton.visible` / `.caption`, `shellscaleotherbutton.visible` / `.caption`; `balloonscalerootbutton.visible` / `.caption`, `balloonscaleotherbutton.visible` / `.caption` (the balloon ones are not in [U-res]; ssp.exe has the names [B]) | | shown; "Sh&ell scaling", "&Other percentage...", "Balloon scaling (&D)" | – | P1 (asked for each main menu, UI §2.1 #8, #9) |
| other `*button.caption` / `*.visible` from [U-res] (~100 IDs) | | runtime default | – | P2 |
| `homeurl` | URL | none | ✓ (empty → 204) | n/a |
| `username` | text | the visitor's nickname, else name, from the Preferences box, else `user` (§4.16) | ✓ `（ユーザ名）` | implemented: asked at each `%username` expansion, never at boot; `….username` properties ask it of that ghost |
| `useorigin1` | `0`/`1` | | – | n/a |
| `sakura.defaultx`/`y`, `kero.*`, `char<n>.default{x,y}` | integer | shell descript | – | P2 |
| `sakura.defaultleft`/`top`, `kero.*`, `char<n>.*` | integer | shell descript | – | P2 (position resources for the renderer) |
| `<box>.defaultleft`/`top` | integer | centred | – | P2 |
| `menu.sidebar.bitmap.filename`, `menu.background.bitmap.filename`, `menu.foreground.bitmap.filename` | path relative to the SHIORI folder | shell/default | – (Tsubasa's shell descript sets menu colours itself [T shell descript.txt:25]) | P2 |
| `menu.{background,foreground,disable}.font.color.{r,g,b}`, `menu.separator.color.*`, `menu.frame.color.*` | 0–255 | shell descript | – | P2 |
| `tooltip` [R0 x, R1 y, R2 0, R3 scope, R4 collision, R5 0] | text (`\&[…]` decoded (§5.5), `\n` = a line break) | none (204: no tip) | ✓ | implemented (§4.3, UI §4.8) |
| `balloon_tooltip` [R0 label, R1 id, R2… args] | text (`\&[…]` decoded (§5.5), `\n` = a line break) | none (204: no tip) | ✓ | implemented (§4.7, UI §4.8) |
| `getaistate`, `getaistateex [R0 n]` | `values\x01labels\x01adds\x01max` (comma lists) | | Satori built-in | P2 |
| `version`, `name`, `craftman`, `craftmanw` | text | | Satori built-in | P1 (logging) |
| `log_path`, `other_homeurl_override`, `legacyinterface` | | | – | n/a / P2 |

### 5.3 Site list format (P1)

[U-res sakura.recommendsites]: entries joined by `\x02`; fields within an entry joined by `\x01`:

```
title \x01 url \x01 bannerPath \x01 talkScript \x02 title \x01 url ...
```

* Satori emits only 3 fields per entry and a trailing `\x02` (`title\x01url\x01banner\x02…`). The talk is fetched later
  through `OnRecommendsiteChoice` [S satori_tool.cpp:GetURLList]. Parse tolerantly: split on `\x02`, drop empty
  entries, split each on `\x01`, and treat missing fields as `""`.
* A `title` of `-` is a **separator** (convention; Tsubasa uses it 9× [T dic06_String.txt:68ff]; not stated in [U-res]).
* A `url` starting with `script:` runs that SakuraScript instead of opening a page [U-res] (P2).
* `bannerPath`: an image relative to the ghost folder, shown on hover. P2.

### 5.4 Caption syntax (P1)

`&X` marks the shortcut key X (case-insensitive, ASCII only) [U-res shortcut keys]. Render it as SSP does: drop the `&`,
underline X, and make X activate the item while the menu is open. Use `&&` for a literal `&` (Win32 convention;
ASSUMPTION). Example from Tsubasa: `Hide for a Bit(&R)`.

### 5.5 Entity decoding of resource values (P1, implemented)

Read in ssp.exe 2.9.10.3000's disassembly with `ssp.map` [disasm]; only `ssp.exe` and `ssp.map` were
opened. The table of names was dumped from the binary.

**Where.** `SPShiori::GetStringShiori` 0x712ba0 ends, for its SHIORI/3.0 branch (MakeShiori30Request, then jmp
0x712f55) and its 2.x branch alike, in one tail: for status 200, 311 or 312 it takes `Value`, else `String`, else
`Sentence`; any other status, or none of the three, gives no value [0x712fb2–0x713022]. The value is copied into the
SHIORI's string and **`SPGhost::DecodeEntity` 0x625b10** runs on it [0x713024–0x713033]; nothing else is done to it
there.

**Who gets it.** DecodeEntity has exactly one call site, 0x713033 (every E8/E9 rel32 in `.text` and every dword in the
image checked for its address). So exactly the values GetStringShiori returns are decoded:
- through `SPGhost::GetString` / `GetStringBool`: the menus' captions and `*.visible` (`GetODMFromShiori`,
  `ModifyPopupMenu`, `ModifyMenuWithTable`, `CheckApplyBindToSelf`), the site lists (`CheckRecommendationsNew`), the
  default positions (`GetDefaultWndPosImpl`), `username` (`GetUserNameW` 0x643a1a), the shell's `tooltip`
  (`CCharWndCode::ToolTipDispInfo` 0x41fcf3), `….ext.` property reads (`VarGet` 0x6485c0; also its `username` read
  0x6479f0), the input box's resources, the update URLs;
- directly: `balloon_tooltip` (`CMessageWnd::ToolTipDispInfo` 0x47342d), `property.set` (`VarSet` 0x648d01, its value
  unused), and `GetShioriInfo`'s `version`, `name`, `craftman`, `craftmanw` (0x70dd9e–0x70de36).

Never decoded: events (`SendEvent`; their scripts go to the player, where `\&[…]` is a tag), `\![embed]`
(`EmbedSendEventFunc` → `SendEvent` 0x633328), OnTranslate (`Translate`), TEACH and the communicate replies.

**What it decodes** (DecodeEntity, over a JWString's UTF-16 code units; the string's length is re-read after each
replacement):
1. The scan runs from i = 0 while 3 more characters follow (i + 3 < length).
2. `\` `\` is skipped as a pair (i + 2): `\\&[amp]` stays as written.
3. At `\` `&` `[` the name is collected from i + 3 up to the first `]`, or up to the end of the string when there is
   none. Nothing else stops it: `\`, `[` and spaces are name characters, and no length cap applies while collecting.
4. A name of 1 to 19 code units (< 0x14) is looked up (`SPGetCharcodeReference`); the text from the `\` through the
   `]` (through the end of the string when unclosed) is replaced by that one character, and the scan goes on right
   after it (i + 1), so the character is never read again.
5. An empty name (`\&[]`) or one of 20 units or more is left as written and the scan moves one character on, so a
   `\&[` inside it is still found.
6. Any other character: i + 1.

**The names** (`SPGetCharcodeReference` 0x5e8dd0, `sp_char.obj`): a binary search with `wcscmp` over 252 sorted names
(pointers at 0xbb0d1c, indexes 0–251; one UTF-16 code unit each at 0xbb110c). Found: that character; not found:
**U+0020, a space**. The 252 are HTML 4.01's named character references, `AElig` to `zwnj` (the Latin-1 set, the
symbols and Greek letters, and the special ones: `quot amp lt gt OElig oelig Scaron scaron Yuml circ tilde ensp emsp
thinsp zwnj zwj lrm rlm ndash mdash lsquo rsquo sbquo ldquo rdquo bdquo dagger Dagger permil lsaquo rsaquo euro`); no
`apos` (not in HTML 4). So:
- case-sensitive: `\&[AMP]` → a space; `\&[Aring]` Å, `\&[aring]` å;
- no numeric form: `\&[#38]`, `\&[#x26]` → a space;
- no trimming: `\&[ amp]` → a space;
- always exactly one character: an entity is never removed, never kept as written once its name has 1–19 units.

| Value | Decoded |
|---|---|
| `Tom \&[amp] Jerry` | `Tom & Jerry` |
| `\&[star]`, `\&[AMP]`, `\&[#38]` | ` ` (a space each) |
| `\\&[amp]` | `\\&[amp]` (unchanged) |
| `\\\&[amp]` | `\\&` |
| `\&[]` | `\&[]` |
| `x\&[amp` | `x&` (unclosed: the rest of the string is the name) |
| `\&[a\&[amp]z` | ` z` (the name is `a\&[amp`) |
| `\&[` + 20 letters + `\&[amp]` | `\&[` + 20 letters + `&` |
| `\&[amp]]` | `&]` |

**Order with the rest.** The menu reads a caption after the decoding, so a decoded `&` is caption syntax like a
written one (§5.4): `\&[amp]\&[amp]` → `&&`, a literal `&`; a lone `\&[amp]X` marks X [disasm order; the caption rule
is §5.4's]. A site list is decoded as a whole, then split on `\x02` / `\x01` (no name gives either). A tooltip's `\n` →
line break comes after (UI §4.8). A shell's own `<scope>.tooltips` text never passes GetStringShiori and is not decoded.

**The script player** is the other user of `SPGetCharcodeReference`: `\&[name]` in a script goes through `ParseBracket`
and the same lookup (`SPGhost::DecodeProcReal` 0x6292c5; a 0 result would add the strict-script error "unknown
character reference", which the lookup never returns). ParseBracket's string goes to the lookup as it is: no
trimming, no `#` form, and no 1–19 rule (an empty or long name is a space too). Sumika's player uses
`charcodeReference` (`sakurascript.md` §5.3); its earlier table (`entityChar`: 47 names plus `star`,
`starf`, `apos`, `#N` / `#xN`, a case-insensitive retry, `?` for an unknown name) is gone.

**The request** (read in the same build; only `ssp.exe` and `ssp.map` opened) [disasm]. Every caller hands GetStringShiori an `SPShioriEvent` at its defaults: `SenderType`
`internal` (what `SPShioriEvent::Clear` 0x419b50 writes, and the inline clears in `SPGhost::GetString(wchar_t*)`
0x64259a, `VarGet` 0x648574, `VarSet` 0x648cb1 and `CCharWndCode::ToolTipDispInfo` 0x41fcb8; `SPModuleEvent::Clear`
0x419180 leaves it), SecurityLevel local, no Sender (the baseware's id goes), no BaseID. The ID and References are the
caller's:
- `balloon_tooltip`: the hover event `SPBalloonWnd::SelectEvent` built (`OnChoiceHover` / `OnAnchorHover`) with its ID
  swapped [0x4733a5–0x47342d], so the hover event's References;
- `tooltip` [R0 x, R1 y, R2 0, R3 scope, R4 collision, R5 0] [0x41fcce–0x41fcf3];
- `property.get` [R0 the key after `ext.`] (`VarGet` [0x648547–0x6485c0]); `property.set` [R0 key, R1 value]
  (`VarSet` [0x648c7e–0x648d01]).

A SHIORI of 3.0 or more (the module's version ≥ 30 [0x712c11]) gets `MakeShiori30Request` 0x70a2f0's form, as every
event: `GET SHIORI/3.0`, Charset, SecurityLevel, SecurityOrigin (`null`), Sender, SenderType, Status (when any), ID,
BaseID (when set), the References (an absent one skipped, its index kept). Below 3.0 GetStringShiori writes its own
[0x712c2e–0x712f1f]: `GET String SHIORI/2.5`, `Charset`, `SecurityLevel`, `SecurityOrigin: null`, `Sender` (the
baseware's id), `ID`, `Status` (when any), then `Reference0…n-1` for every index (an absent one empty); no SenderType,
no BaseID. Both go out through `SPModule::CallRequestAndLog` and come back through `ParseGenericHeaders(0, 0)` and the
tail above. GetStringShiori never calls `SPShiori::Request`, the only caller of `SendCommunicate` 0x711770 [call at
0x71234f], so no GetStringShiori read ever sets a COMMUNICATE target, whatever `To` / `Reference0` its reply carries.
A header with an empty value is no header (`SPParamManager::ParseValue` drops it [0x6b0539–0x6b054a]), so an empty
`Value` falls through to `String`. `property.set` judges by `VarSet`'s own test, the status in 200–299 whatever the
string [0x648d06–0x648d19].

**Sumika.** `src/sakura/entity.js`: `decodeEntity(s)`, `charcodeReference(name)` and `CHARCODE_REFERENCES` (the
table as dumped). `src/core/events.js`: `_getString(id, refs)` sends every GetStringShiori read of the loop (`comm:
false`, so no COMMUNICATE; `kind: 'resource'`, which the SHIORI/2 bridge turns into `GET String SHIORI/2.5`,
kawari7-wasm.md §6.3; `SenderType: internal`), and `resourceOf(res)` reads it as the tail does: 200, 311 or 312;
`Value`, else `String`, else `Sentence` (an empty one is none); then `decodeEntity`. Its users: `resource()` (so
`resources()`, the menu's batch, and `%username`), `_balloonTip`, `_shellTip` (not the shell's own text), `_ext`
(`….ext.` reads) and `_setExt` (`property.set`: any 2xx is success, as `VarSet`). Events, OnTranslate, `\![embed]` and
TEACH keep `valueOf` (any 2xx, `Value` only). It runs in the page, so for every engine alike: a 2.x reply's `String` /
`Sentence` reaches it as `Value` with its status through `fromShiori2` (`src/worker/engines/shiori2.js`). `tipText`
(`src/ui/tooltip.js`) does not decode again. Tests:
`tests/runtime/entity.test.mjs` (the status set and fallbacks, `property.set`), `tests/runtime/tooltip.test.mjs`,
`tests/runtime/interact_loop.test.mjs` (no COMMUNICATE from the tips), `tests/shiori2.test.mjs` (the 2.x requests and
the page's reading through the bridge, 311 / 312 included), `tests/runtime/kawari7_integration.test.mjs` (the Kawari
7.5.0 build answering the fixture's `resource.balloon.tooltip`, `resource.tooltip`, `resource.property.get` / `.set`).
No site ghost writes `\&[` in its dictionaries, so the decoding changes nothing for the site's ghosts.

Two details of these reads:
- `valueOf` takes the Value for 200, 311 and 312 only, as GetStringShiori does, and `String` / `Sentence` when there
  is no `Value`, so a 2.x ghost's 311 / 312 string, which `fromShiori2` passes on, reaches the page.
- `balloon_tooltip`, `tooltip` and the `….ext.` reads go with `kind: 'resource'`, so a SHIORI/2.x ghost gets them as
  `GET String SHIORI/2.5` with `ID:`, not as `GET Sentence SHIORI/2.2` events; and the tooltip GETs never note a
  COMMUNICATE (`comm` is false for them).

---

## 6. Tsubasa inventory

Sources: `scratch/entries.txt` (every `＊name` in `ghost/master/{,bath,date,meal}/*.txt`, 7,688 names; 105 start with
`On`) and `scratch/evdefs_master.txt` (bodies). Folder column: M = master, B = bath, D = date, m = meal. A `-` means the
folder does not define it. Satori loads one folder at a time; `＄辞書フォルダ` switches folders [T].

### 6.1 SSP events she defines

| Event | Folders | Reads | Browser source | P |
|---|---|---|---|---|
| OnFirstBoot | MBDm | – | boot 2.1 | **P0** |
| OnBoot | MBDm | – | boot 2.1 | **P0** |
| OnClose | MBDm | – | close 2.3 | **P0** |
| OnSecondChange | MBDm | R1 | ticker 3.2 | **P0** |
| OnMinuteChange | MBDm | – (time builtins) | ticker 3.3 | **P0** |
| OnTranslate | MBDm | R0 | 4.12 | **P0** |
| OnChoiceSelect | MBDm | R0 | 4.7 | **P0** |
| OnChoiceTimeout | MBDm | – | 3.4 | **P0** |
| OnUserInput | MBDm | R0, R1 (`timeout`) | 4.8 | **P0** |
| OnMouseDoubleClick | MBDm | R3, R4 | 4.2 | **P0** |
| OnMouseClick | MBD- | R3, R4, R5 | 4.2 | **P0** |
| OnMouseDown, OnMouseUp | M--- | R3, R4, R5 | 4.2 | **P0** |
| OnMouseWheel | MBDm | R2, R3, R4 | 4.4 | **P0** |
| OnKeyPress | MBDm | R0, R2 | 4.6 | **P0** |
| OnDressupChanged | MBDm | R1, R2 | 4.11 | **P0** |
| OnNotifyDressupInfo | MBDm | R0… | 4.11, boot | **P0** |
| OnWindowStateMinimize / Restore | MBDm | – | 2.4 | **P0** |
| OnAnchorSelect (→ `OnAnchorSelect.URL` → `\j[url]`) | MBDm | R0 | 4.7 | P1 |
| OnMouseDragEnd | --D- | R3 | 4.5 | P1 |
| OnGhostChanging, OnGhostChanged | MBDm | R0 | 2.5 (implemented) | P1 |
| OnDSAPlayFinish | MBDm | – | dsaudio stand-in | P1 |
| OnMAAPlayFinish, OnMAAPlayLoop | MBDm | R0 | mciaudior stand-in (ghost-sweep.md): a track's end / each pass of a looped one, as GET [R0 the file as the ghost passed it to load, R1 `0` [guess]]; mciaudio.dll has no events | P2 |
| OnShellChanging, OnShellChanged | MBDm | – | 2.6 | P2 |
| OnGhostCalled, OnGhostCallComplete, OnOtherGhostBooted, OnOtherGhostClosed | M--- | R0 | 2.7 (implemented) | P1 |
| OnVanishSelecting, OnVanishSelected, OnVanishCancel, OnVanishButtonHold, OnVanished | M--- | R0 | 2.8 | P2 |
| OnSysResume | M--- | – | 4.14 heuristic | P2 |
| OnFileDrop2 | MBDm | R0 | 4.14 (implemented) | P2 |
| OnURLDropping, OnURLDropped | MBDm | R0 | 4.14 | P2 |
| OnOverlap | --D- | R0, R1 | 4.14 | P2 |
| OnBatteryLow, OnBatteryCritical | MBDm | R0 | 4.14 | P2 |
| OnRecycleBinEmptied | M--- | R0 | gomi stand-in | P2 |
| OnInstallBegin/Complete/Failure/Refuse, OnUpdateBegin/Ready/Complete/Failure, OnUpdate.OnDownloadBegin/OnMD5Compare*, OnUpdatedataCreating/Created, OnNarCreating/Created, OnSNTPBegin/Compare/Correct/Failure, OnBIFFBegin/Complete/BIFF2Complete/Failure, OnHeadlinesenseBegin/OnFind/Complete/Failure, OnNetworkHeavy, OnSSTPBreak, OnMusicPlay | MBDm | | none | n/a |
| OnKinokoObject*, OnNekodorifObject*, OnSysResourceLow/Critical, OnApplicationOperationFinish, OnWebsiteUpdateNotify, OnKanadeTeaParty, OnKanadeTeaPartyInfomationRequest (M only), OnBeerShower, OnDive, OnHitThunder | various | | third-party apps or other ghosts | n/a |
| OnStampInfo | MBDm | R4 | スタンプ帳 plugin reply | n/a |

### 6.2 Events she raises herself, routed by the runtime (P0)

* On-ID choices (`\q[…,OnX,arg]` / `\__q[OnX,arg]`) → `GET OnX [arg]`: `On再生リスト移動` (403), `On再生リスト削除` (84),
  `On再生リスト上移動`/`下移動` (73 each), `On再生リスト個別` (66) (MBDm); `On天気予報表示` (133),
  `On天気予報地域の設定２` (133), `On生誕の日` (62), `On生誕の月` (60), `On下着を渡す２` (7) (M only). Counts are corpus
  occurrences [C].
* `\![raise,X]` with non-On X: `天気予報情報取得開始２` (134), `お絵描きロジック開始前２` (31) / `３` (3),
  `週間天気予報情報取得開始２` (1) [C].
* `\![timerraise,ms,1,X]` targets: 45 distinct, all non-On, for example `服着せ替えメニュー` (41), `服着せ替えメニュー２`
  (41), `ランダムハンドカード決定` (29), `頭着せ替えメニュー` (27), `ぷよ自動落下` (22), `ぷよ消し落下計算` (22), and
  `\![timerraise,0,1,X]` cancellations [C]. Full list: `docs/research/scratch/onrefs.py` output.
* Input boxes: `\![open,inputbox,<ID>…]` with the IDs listed in 4.8 → `OnUserInput`.

### 6.3 Satori-internal names (never sent by the runtime)

`OnTalk` (random talk), `OnSatoriClose` (run inside OnClose and OnGhostChanging; Tsubasa clears `スタンプ帳動作`),
`OnAnchorSelect.URL` (her own jump target), `OnDirectSaoriCall` (arrives through `\![raise]`, handled by Satori itself,
always 204), `初期化`, `OnSatoriLoad`, `OnSatoriBoot`, `OnSatoriUnload`, `OnSatoriSecondChange`, `OnSatoriTimer`,
`COMMUNICATE該当なし` [S; SD shiori/satori-events.md].

### 6.4 Resources she answers

`username`, `homeurl` (empty), `sakura.recommendsites`, `sakura.portalsites`, `portalrootbutton.caption`,
`recommendrootbutton.caption`, `updatebutton.caption`, `vanishbutton.caption`, `readmebutton.caption`,
`dressuprootbutton.caption`, `hidebutton.caption`, `vanishbutton.visible` (`（消滅指示表示）`), `updatebutton.visible`,
`dressuprootbutton.visible`, `tooltip`, `balloon_tooltip` [T dic06_String.txt:12190–12229; dic*:16454–16474]. In
addition, the NOTIFY `hwnd` runs her `＊hwnd` talk, which initialises dsaudio [T dic*:16473].

### 6.5 Satori default behaviours she relies on (no `＊` of her own)

| Mechanism | Needs from the runtime | P |
|---|---|---|
| `OnSurfaceRestore` → surface reset | 3.4 stamp and tick check | P0 |
| `OnMouseMove` → `＊<R3><R4>なでられ` (60 moves, 2 s) | 4.3 move stream + Status | P0 |
| `OnCommunicate` → `＊ユーザ「…」` search | 4.8 communicate box | P0 |
| random talk / `＄…タイマ` timers | 3.2 R3 | P0 |
| `OnRecommendsiteChoice` → site talk | 4.13 | P1 |
| OnChoice* `\x01` ID split → `（選択ＩＤ）` | raw IDs (4.7) | P0 |
| `（サーフェス0）` | 4.11 OnSurfaceChange | P0 |
| `（起動しているゴースト数）` | 2.1 #16 otherghostname | P1 |

### 6.6 Minimum P0 event set for Tsubasa

```
protocol: headers Charset/Sender SSP/SecurityLevel local/Status (+ID, References)
boot:     OnNotifyDressupInfo (NOTIFY), OnSurfaceChange (NOTIFY), OnFirstBoot|OnBoot (+204 chain)
resume:   the same NOTIFYs, no OnBoot
clock:    OnSecondChange, OnMinuteChange (GET/NOTIFY by cantalk), OnChoiceTimeout, OnSurfaceRestore
pipeline: OnTranslate after every GET script, script replacement, \![raise]/\![timerraise] (any ID), On-ID choices
input:    OnMouseDown/Up/Click/DoubleClick (R5 0/1/2), OnMouseMove (per frame), OnMouseWheel (±120), OnKeyPress
choices:  OnChoiceSelectEx → OnChoiceSelect (raw IDs with \x01)
boxes:    OnUserInput (+ timeout fallback), OnCommunicate (+cancel)
state:    OnDressupChanged (+ OnNotifyDressupInfo GET) after bind scripts
window:   OnWindowStateMinimize/Restore, OnClose (+OnCloseAll first) → \- → OnDestroy → unload
change:   A: OnGhostChanging (→ OnClose) → OnDestroy → unload; B: boot NOTIFYs → OnGhostChanged (→ OnBoot) (2.5)
```

---

## 7. Open questions / to verify against real SSP

* **Q1 (design, P0).** Navigation resets Satori's random-talk countdown and petting counters (3.6). Options: (a) patch the
  Satori build to export and import `talk_interval_count` (and `second_from_last_talk`) through the existing
  `{t:'persist'}` path, or put them in the save file as a hidden variable; (b) accept that random talk happens only after
  `喋り間隔` seconds on one page. Recommendation: (a).
* **Q2.** Exact SSP rules that this spec marks ASSUMPTION: whether a right click that the ghost answers suppresses the
  menu; the middle-button event order; whether OnMouseUp and OnMouseClick are sent after a drag; whether OnDressupChanged
  is sent at script end or at the tag (the off/on order is settled [disasm], §4.11; SSP reports per lazy block);
  whether cantalk is 0 while minimized; R2 base of OnKeyPress;
  OnMinuteChange alignment and order relative to OnSecondChange; whether timerraise is delivered during `\t`.
  (Settled since [disasm]: OnChoiceEnter is GET on entering an item in 2.9.08f, NOTIFY or GET without References on
  leaving it, §4.7; [L]'s NOTIFY is 2.02's.) A request logger SHIORI in SSP
  2.9.08f would settle all of these in one session. That needs running `ssp.exe`, which this research did not do.
* **Q3 (decided).** `basewareversion` claims `SSP` (consistent with `Sender: SSP`, which Satori requires), not
  `sumika` [decision]. Claiming SSP makes YAYA ghosts use SSP-only tags, which the "unknown tags never throw" rule
  absorbs.
* **Q4.** The `Reference1: 1` that SSP 2.02 sent with `OnInitialize` and `OnDestroy` [L 64, 5842] is undocumented. It
  is omitted here.
* **Q5.** For `OnRecommendsiteChoice`, does SSP still open the URL when the ghost returns a script? This spec says always
  open it (popup-blocker constraint).
* **Q6.** Timer-raised and raised events that return a script while another script is playing are specified to replace
  it (4.10). Tsubasa's rhythm game fires `\![timerraise,930,1,…評価消し]` inside `\t` scripts [C]. Verify that this
  replacement matches what SSP does, or the game will look different.
* **Q7.** `OnBalloonTimeout` R1 ("remaining time") semantics are unclear [U-ev]. It is sent as `0`.
* **Q8 (to compare in ssp.exe).** Shells and balloons (§2.6): whether Tsubasa's `\p[99]` panel dot still
  shows after a re-pick of her shell cannot be compared: the dot could not be made out on ssp.exe's screen
  [observed]. Does a click she answers during OnShellChanging's line also drop the switch (a
  double-click should)? With `\![change,shell,X]` in the middle of a script (Script Input box), does the rest of the
  script run before OnShellChanged's reply, or does the reply cut it? `\![change,shell,random]` and
  `\![change,shell,sequential]` with exactly two shells (Katari, roommate): nothing? A balloon picked on one shell, then
  a switch to another shell and back: does the balloon follow the
  shell? Dress-up (§4.11): a menu toggle with a request logger shows OnDressupChanged R4 `user`, offs before ons, NOTIFY
  then GET, then GET OnNotifyDressupInfo with `default` in the options of default parts? Status `changing` after a
  cancel (1.6): pick another shell from Shell ▸ and double-click her balloon during OnShellChanging's line; does random
  talk stop (ticks NOTIFY) until the next shell change, as the disassembly says? Sumika clears the flag at the cancel
  [decision]; the answer decides whether to copy SSP's stuck flag.
* **Q9 (to compare in ssp.exe).** Several ghosts (§2.7), cheapest first: (a) call a ghost that never ran
  in this SSP: its first-boot talk, not its "called" talk? [disasm] Where it stands is an open check of its own
  (`ssp-ui.md` §3.5 #2: Sumika puts it on the caller, ssp.exe was seen doing otherwise [observed]). (b) Does the caller's OnGhostCalling talk overlap
  the callee's boot talk? With `\![call,ghost,X]` in the middle of a script (Script Input box), does the rest of the
  script keep playing? Two calls in one script: do both ghosts come? [disasm; guess] (c) Close on one of two: only it
  goes, the other comments? Its OnClose without `\-` (Script Input box): does it stay? Quit: both say goodbye at once
  and both come back at the next start? A Quit whose OnCloseAll / OnClose reply has no `\-`: does the ghost still go?
  A click during Quit's goodbye: does its reply play, and does the ghost still close after it? [disasm; guess]
  (d) answered by the disassembly (§2.3): a ghost iconified at Quit shows no goodbye, but its OnCloseAll / OnClose
  are sent (its reply dropped). To check: minimize machimaki, Quit, start again: no "ended abnormally" talk in
  ssp.exe nor Sumika (`closemode` is set in OnClose) [disasm; infer]. (e) A minimized or passive ghost: does it get
  OnOtherGhostBooted / OnOtherGhostClosed / OnGhostCallComplete? [guess] (f) `\![call,ghost,X]` for a ghost already on
  screen: nothing? [disasm] (g) OnOtherGhostTalk (ruusa, hgr or kanade_2nd): does the listener's reply cut what it was
  saying? Is a talk that a click replaced reported with `break`? [infer; guess] (h) moved to Q10. The menu-side checks
  (marks of Call ghost ▸, keys after a call, z-order, Iconify) are in `ssp-ui.md`.
* **Q10 (ghosts interacting, to compare in ssp.exe; §2.7.7–§2.7.9).** Cheapest first: (1) Katari + Nato
  (or Tsubasa + Hayato): (a) a greeting reaches the partner, who answers in its own balloon; (b) a double-click break
  on the greeting stops it; (c) a greeting that ends with choices is passed on before the pick; (d) the reply cuts the
  partner's running talk; (e) a minimized partner stays silent. (2) kanade_2nd + Tsubasa + Katari: the tea party
  reaches both; kanade alone: no failure talk at all. (3) Katari + another ghost: Katari's 呼び出す with the other
  ghost's name answers "その物語は、すでにここにある。" (the FMO, §2.7.8). (4) NodePsimoon + emily4: does NodePsimoon's
  greeting show stray characters or numbers after "Emily"? (5) Only if easy: does a ghost's reply cut another ghost's
  goodbye (Close) and leave it standing? (Sumika does, as the disassembly says [decision: as ssp.exe].)

---

## Appendix A: examples

Boot reload sequence observed in SSP 2.02.15 [L], IDs only:

```
GET Version SHIORI/2.6 · GET version · N OnInitialize(reload) · N ownerghostname · N basewareversion · N capability ·
N OnNotifyOSInfo · N OnNotifyFontInfo · N OnNotifySelfInfo · G useorigin1 · G version · G name · G craftman ·
G craftmanw · N OnNotifyUserInfo · N otherghostname · N ghostpathlist · N balloonpathlist · N headlinepathlist ·
N pluginpathlist · N calendarskinpathlist · N calendarpluginpathlist · N installedghostname · N installedballoonname ·
N installedshellname · N installedheadlinename · N installedplugin · N OnNotifyDressupInfo · N uniqueid · N hwnd ·
N OnDisplayChange · N rateofusegraph · N OnSurfaceChange ×2 · (G OnMouseMove …) · N OnSecondChange(R3 0) …
```

2.9.10's reload (§2.10) [disasm]: N OnDestroy(reload) and the unload first; then N OnLanguageChange comes before
N OnInitialize(reload), and the SHIORI's version / name / craftman come after the environment NOTIFYs. Sumika's reload
sends its own boot batch (§2.1) instead.

Double-click to the menu [L 3948–4117]:

```
GET OnMouseDown  R0 133 R1 186 R2 0 R3 0 R4 "" R5 0      -> 204
GET OnMouseUp    (same)                                   -> 204
GET OnMouseClick (same)                                   -> 204
GET OnMouseDoubleClick (same)                             -> 200 Value: \0\s[26]…\q[◇聊天,ForcedTalk]…\e
GET OnTranslate  R0 <that script>                         -> 204   (play original)
GET OnMouseUp    Status: talking                          -> 204
GET OnMouseClick Status: talking                          -> 204
N   OnSecondChange Status: talking  R3 0
N   OnSurfaceChange R0 26 R1 10 R2 0,26,278,336
N   OnChoiceEnter R0 ◇取消 R1 MenuCancel  /  N OnChoiceEnter (no refs)
GET OnChoiceSelectEx R0 ◇取消 R1 MenuCancel             -> 204
GET OnChoiceSelect  R0 MenuCancel                         -> 200 …
GET OnTranslate …
```

A Tsubasa request as the runtime should send it (petting, while idle):

```
GET SHIORI/3.0
Charset: UTF-8
Sender: SSP
SenderType: internal
SecurityLevel: local
ID: OnMouseMove
Reference0: 112
Reference1: 64
Reference2: 0
Reference3: 0
Reference4: Head
Reference5: 0
Reference6: mouse

```

The same request during a talk adds `Status: talking,balloon(0=0)` after `SecurityLevel`. Satori then counts the move
but suppresses the なでられ talk.

OnTranslate with nyan mode [C res_tr_nyan.txt]:

```
-> GET OnTranslate  Reference0: \0\s[0]Hello there.\w8 How are you?\w8\nI'm fine, thanks!\w8\nWell...\w8\nSo, see you.\e
<- 200  Value: \1\s[10]\0\s[0]Hello there, nya.\w8 How are you, nya?\w8\nI'm fine, thanks, nya!\w8\nWell...\w8\nSo, see you, nya.\e
```

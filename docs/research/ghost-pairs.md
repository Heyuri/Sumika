# Ghost pairs: ghosts written to meet each other

This file notes ghosts that are designed to interact with each other, found in a corpus of downloaded archives
(317 ghosts), an SSP install and the Sumika site. It says who calls or talks to whom, how, and what Sumika needs
before each pair works.

It comes from a census of every dictionary of the archive, the SSP install and the site. Tags: **[corpus]** read in
the ghosts' files (`file:line` is below the ghost's `ghost/master/`); **[disasm]** ssp.exe; **[src]** Satori's source;
**[infer]** / **[guess]** not confirmed. Nothing here has been watched in ssp.exe yet; §6 says what to watch. The
ghosts-interacting work is in `shiori-events.md` §2.7.7–§2.7.9.

Not in the repository: the archives, the SSP install and the site's ghosts (the development site's: CLAUDE.md "The
ghosts Sumika was tested with"). These are development material, cited as the sources (CLAUDE.md "Project rules").

## 1. How ghosts meet

| Way | What happens | Sumika |
|---|---|---|
| **Call by name** | `\![call,ghost,なと]` or a typed name brings the partner on screen. The corpus calls by **sakura name** (なと is Nato's sakura name; its descript name is なっとう) | **now** (EV §2.7.1), if the partner is on the site |
| **Named call / close talk** | The partner's sakura name picks special lines in OnGhostCalled, OnGhostCallComplete, OnOtherGhostClosed, OnOtherGhostChanged: Tsubasa's `＊あざみを呼び出した` | **now** |
| **Change talk** | `＊Xへ変更` / `＊Xから変更`: special lines when the user swaps one ghost for the other. Not two ghosts on screen, but it shows who knew whom | **now** |
| **Ghost-to-ghost talk** (COMMUNICATE) | A ghost's script ends; SSP hands it to the ghost whose **sakura name** the reply named (Satori `→` or `＄Value0`, YAYA `res_reference0`) [disasm]. That ghost answers through OnCommunicate, Satori through heads `＊X「　keyword` | **now** (EV §2.7.7) |
| **FMO view** | Satori's `（FMO1name）`, `（Xの存在）`: "who else is running?". Katari picks her talk partner this way | **now** (a stand-in, EV §2.7.8) |
| **raiseother protocols** | One ghost raises an event in another: Kanade's tea party, the property protocol, Don's games | **now** (EV §2.7.9) |
| **Save reads** | A ghost reads another ghost's save file (`Read.SaveData` of aya5.dll) to see what happened there | **not built** (CLAUDE.md "Known gaps") |

## 2. Pairs and families in the archive (both ghosts present)

SSP = which of the ghosts are installed in the SSP install the checks use; Site = which are on the Sumika site;
– = none. Every Satori and YAYA ghost below boots in the ghost sweep (`ghost-sweep.md`; the Satori run, the YAYA
run). "Now" includes the ghosts-interacting work (communicate, the FMO stand-in, raiseother); "add X" = that ghost
still has to be put on the site.

| Pair or family (archive files) | Author | Who → whom, how | SSP | Site | Sumika needs |
|---|---|---|---|---|---|
| **Katari ⇄ Nato** (`Katari.nar`, `Nato.nar`) | amo | Katari's menu 特定の人を呼び出す, typing なと or なっとう → `\![call,ghost,なと]` (`dic03_Menu.txt:956`); she first checks `（（名）の存在）` ("already here?"). Flip Katari's skirt (mouse wheel up on it) with Nato present → Katari's flustered line goes to a random other ghost (`dic03_Menu.txt:1893–1906`) and Nato has an answer for each (`＊カタリ「　見ていると言うのに` … `dic06_Communicate.txt:399–423`) | Katari, Nato | Katari, Nato | now |
| **Katari ⇄ BAKU** (`BAKU.nar`) | amo | BAKU answers the same skirt lines (`dic08_Communicate3.txt:288–312`); Katari answers BAKU (キリー) (`＊キリー「　眠れないのかな` `dic05_Communicate.txt:488–503`). BAKU also calls なと (`dic05_Menu.txt:806`) and greets everyone at once (`＄Value0	__SYSTEM_ALL_GHOST__` `dic08_Communicate3.txt:61`) | Katari | Katari | now (add BAKU) |
| **Nato ⇄ BAKU** | amo | Nato `＊キリーに話しかける` / `＄Value0	キリー` (`dic06_Communicate.txt:378–379`); BAKU `＊なと「…` heads | Nato | Nato | now (add BAKU) |
| **b-d ⇄ BAKU, Nato** (`b-d.zip`) | 深上 | communicate heads both ways (ダウン ⇄ キリー, なと); b-d also starts talks to them with `＄Value0` | Nato | Nato | now (add b-d) |
| **xxx_xxx → souzou_syoka** (`xxx_xxx.nar`, `souzou_syoka.nar`) | jumei | xxx_xxx summons シカルニ (`\![call,ghost,シカルニ]` `s_saigi/dic01_ss_kidou.txt:66`) only if souzou_syoka's save says 書架モード 通常 (`:20`, `:51`), then opens a JPRadish talk (§3). souzou_syoka closes itself when the desk is crowded (`dic001.txt:53–55`) | – | – | talk: now; the summon: later (save read) |
| **07_words ⇄ bukimi** (`07_words.nar`, `bukimi.nar`) | jumei | JPRadish topics (`＄Value0	不気味` + `＄Value1	JPRadish` `nanashi3/dic10_ghost_com.txt:45–47`), `（不気味の存在）` checks, each reads the other's save | – | – | now; later for save reads |
| **kenki ⇄ souzou_syoka** (`kenki.nar`) | 深谷 / jumei | heads, `＄Value0`, `（見鬼の存在）` / `（シカルニの存在）`; kenki reads souzou's save (`dic07_Communicate.txt:87`) | – | – | now; save reads later |
| **souzou_syoka ⇄ vanishing** (`vanishing.nar`) | jumei / 畝傍 | heads and `＄Value0` both ways; souzou checks `（クロツの存在）` and reads vanishing's save | – | – | now; save reads later |
| **an_inu ⇄ moshimo ⇄ mok_para** (+ kirito, sinri, unyu_kei, sake_kami) | かざまはる | named call / close talk, heads, `＄Value0`; a shiritori game over communicate; Quit-all talk names the others through FMO ("それでは、（FMO1name）さん、一緒に帰りましょうねー。" an_inu `nakki/dic02_Event.txt:596`); moshimo and mok_para read an_inu's save | – | – | call talk, talk and Quit names: now; save: later |
| **clear_sky_girl ⇄ sky_rbb** (`clear_sky_girl.nar`, `sky_rbb.nar`) | 神夜みゅん | clear_sky_girl `＊アオウサを呼び出す` (OnGhostCalling, `dic07_Communicate.txt:251`), `＊アオウサが終了` (`:223`); sky_rbb `＊遼子から呼び出し` (OnGhostCalled, `dic_base.txt:299`), `＊遼子の呼び出し完了` (`:236`, counts calls in clear_sky_girl's save `:237`); heads both ways | – | – | call talk and heads: now; the count: later |
| **pray_p → clear_sky_girl, sky_rbb, uu_du** (`pray_p.nar`) | 神夜みゅん | menu calls by sakura name: 遼子, アオウサ, 亜里奈 (`dic03_Menu.txt:207` …) and 17 names not in the archive | – | – | now |
| **Kanade's tea party: kanade_2nd → tsubasa, Katari, bee** (`kanade_2nd.nar`, `bee.nar`) | ななっち (host) | kanade raises events in every ghost (`\![raiseother,__SYSTEM_ALL_GHOST__,…]` `dic_TeaParty.txt:123`, `:165`). Tsubasa says she can come (`\![raiseother,（Ｒ１）,（Ｒ２）,（お茶会バージョン）,つばさ,対応]`; `（Ｒ１）` = `かなで`) and eats (`＊OnKanadeTeaParty`); Katari watches (`＊OnKanadeTeaTime` `dic05_Communicate.txt:338`); bee (YAYA) too. Tsubasa is on kanade's list of guests (`dic_TeaParty.txt:499`) | kanade, Tsubasa, Katari | Tsubasa, Katari | now (add kanade_2nd). Its `kanade_core.dll` (list functions for the guest roll call), `houchi.dll`, `bln.dll` have no stand-ins; the party itself should still run [infer] |
| **tsubasa ⇄ foxeye** (`foxeye.nar`) | マカロニ / 畝傍 | Tsubasa: `＊あざみを呼び出した` (call complete), `＊ユーザーの家であざみが終了` (other ghost closed), `＊あざみ「` heads; foxeye: `＊つばさ「…` heads (`dic04_Change.txt:1449–1459`), `＊つばさへ変更` | Tsubasa | Tsubasa | Tsubasa's side: now (add foxeye). foxeye's side needs the Japanese Tsubasa (§5) |
| **tsubasa ⇄ gouki_saki** (`gouki_saki.nar`) | マカロニ / 霧島剛毅 | change talk both ways; heads `＊沙希「　抹茶飴` (Tsubasa `dic04_Change.txt:460`) / `＊つばさ「　煮干し` (gouki_saki `dic04_Change.txt:697`) | Tsubasa | Tsubasa | change talk and heads: now (add gouki_saki; its `＊つばさ「` heads need the Japanese Tsubasa, §5) |
| **type01-Mono ⇄ type01-MonoF** | red fish社 | communicate heads both ways (モノ ⇄ モノF) | – | – | now |
| **1st-innerport ⇄ Ltoto2 ⇄ ku-ver06.1** | ドモン / 沢渡慎二 / 観城はるか | heads and named talk starts (涼璃, ととたん, 空) | – | – | now |
| **Flugor ⇄ Northern** | mkbt | named call talk and heads (クラエス ⇄ エリシア) | – | – | now |
| **SatoPaku ⇄ KokonToUzai** | Don | games: raiseother to `（FMO1name）` (OnJanken, OnKokontouzai, OnGetValue: `SatoPaku simple/dic_Menu.txt:228`, `KokonToUzai simple/dic_Dat.txt:45`), shiritori / 古今東西 over communicate. SatoPaku also sends SSTP to the other ghost's window handle | – | – | now; the window-handle part never works in a browser (the FMO stand-in has no handles, EV §2.7.8) |
| **akuyaku ⇄ AnzuMew** (YAYA) | 瞬祭藍果 / – | akuyaku has lines for 杏喵 in OnGhostCalled and OnGhostCallComplete (`akuyaku_change.dic:1357`, `:1211`); AnzuMew has change talk for 惡子 (`Anzu_change.dic:42`) | – | – | now |
| **emily4 ⇄ Ltoto2** (`Ltoto2.nar`) | Emily team / 沢渡慎二 | Ltoto2 greets the ghost next to her (`→：（５）（対ゴースト用挨拶）、（隣で起動しているゴースト）さんっ♪` `dic05_Communicate.txt:14`). emily4 has `OnCommunicate_ととたん` (`aya_communicate_normal.dic:36`, waiting for "…作ったんだよ", a line this Ltoto2 never says) and otherwise answers any greeting that names "Emily" | emily4 | emily4 | now (add Ltoto2) |
| **BTH family** (Kawari: BTH4th_last, BTHver.5, BRH1.251, toxic060816; Satori: 333-4.05, chisato2_022) | 竜子 + friends | Kawari `Comm_<name>` lines for 裏子, ウラキ, 毒子, 美耳, 千郷; the Satori ghosts answer with heads | BTHver.5 | bthver.5 | talk: now (Kawari 8.2.8); their reads of each other's saves: no (kawari-wasm.md D14) |

Also mutual in the archive, with heads both ways but no stronger link: bukimi ⇄ hitomaro, denpa, moshimo, SHP;
kenki ⇄ yomibito; vanishing ⇄ 2elf-2.46, cafe, kenki, LorinaandDinah, mil, twincat_ss; foxeye ⇄ uu_du, sancyome,
sekka, mishaki, ll, LorinaandDinah, MarmotUndergroundAndNico; metal_wing ⇄ twincat_ss; phantom_funeral ⇄ shamrock;
yomitani ⇄ zeroko. In all, 96 pairs name each other with something more than change talk (232 with change talk)
[corpus].

## 3. Protocols shared by many ghosts

| Protocol | How it works | Who |
|---|---|---|
| Satori template greeting | `＊隣のゴーストにでんぱを送る` → `＊（neighbour）に話しかける` or `＊誰かに話しかける` with `→` (talk to the neighbour); the template reaches it from a dic03 menu item. Its sample partner is なる (奈留, `naru_m015a.nar`, an engine Sumika does not run) | about 100 Satori ghosts. Tsubasa, roommate and SERION kept the talk but dropped the menu item, so they never start it [corpus] |
| JPRadish (大根コミュニケート) | communicate with extra data: Reference1 `JPRadish`, Reference2 a topic; the receiver jumps to `＊大根で<topic>` | 11 senders (07_words, bukimi, xxx_xxx, souzou_syoka, an_inu, …), 21 receivers incl. the YAYA templates of emily4, bee, K3R, syoko [corpus] |
| ECHO/1.0 (script communicate) | the sender writes the script the receiver plays | emily4 (with 所長たん, not in the archive), K3R, maya, mobilemaster, syoko … |
| Property protocol | a tool raises OnRequestProperty; the ghost answers OnGetProperty with its own name from `（FMO0name）` | 20 Satori (incl. Katari, pit) and 4 YAYA (incl. emily4). Nobody in the archive asks: the asker is a tool such as ごーすとじてん |
| Kanade's tea party | §2 | kanade_2nd, tsubasa, Katari, bee |
| かざまはる Quit-all | OnCloseAll names the other running ghosts through FMO | an_inu, moshimo, takanaduke |

## 4. Written for partners that are not in the archive

Names addressed by at least 4 archive ghosts that match no archive ghost [corpus]. Most are ghosts of the same
circle of authors; they could not be identified from the archive.

| Partner | Ghosts that address it | How |
|---|---:|---|
| 栄子 | 19 | heads |
| リーライナ | 18 | heads, call talk |
| Hand | 18 (incl. Katari; also emily4) | Katari `＊Handに話しかける` "やぁ、セクハラオバケ。" (`dic05_Communicate.txt:50–52`); emily4 `OnCommunicate_Hand`. A groping-hand joke ghost [guess from those lines] |
| スルガ, ヒトラ氏, バルバトス | 14–15 each | heads, `＄Value0` |
| ルディス, 玉響, 恵理, マロン, ヴィイ | 11 each | heads, calls (pray_p calls 恵理, ルディス); vanishing raises OnCommunicate in マロン |
| エミット, 羅裸, てでぃめりー, 朔夜, ハラ, ゆかり, にこら, ヴィア | 9–10 each | heads |
| 所長たん | emily4, kanade_2nd | emily4's ECHO/1.0 scenario after calling 所長たん (`aya_ghostchange.dic:230`) |
| うしろのやまひこさん | kanade_2nd, Lyydia | the やまひこ raiseother protocol (OnYAMAHIKO3*) |
| ごーすとじてん | kenki, BAKU, kztk, souzou_syoka | the property protocol's asker |
| 54, 澪央, 電子野かけら, 雫, ローズマリー(仮称) | kanade_2nd (tea-party guest list), Tsubasa (`＊54「`) | |
| Emily | Tsubasa, kanade_2nd (change talk), yagi_the_twins (heads) | emily4: on the site and in SSP, not in the archive folder |
| さくら / うにゅう | the Satori template's change talk | `sakura.nar` is in the archive (Satori) but answers nothing |

## 5. The English Tsubasa

The site's Tsubasa is the English translation: her sakura name is `Tsubasa` and her lines are English, but her
heads and keywords stay Japanese [corpus].
- **Works:** Japanese ghosts that greet her (こんにちは, おはよう, こんばんは) or are named あざみ, 沙希, かなで, 情, 蛇子 or
  54 get her answers. Kanade's tea party works: it does not depend on her name.
- **Breaks** (content, not a runtime bug): partners keyed on `つばさ`, such as foxeye's and gouki_saki's `＊つばさ「…`
  and kanade_2nd's `＊つばさへ変更`. An English greeting ("Hello") gets "Ummm...". Katari's morning greeting is
  `お早う`, which is not among Tsubasa's keywords (`おはよう`), so from 04:00 to 10:59 Tsubasa does not recognise it
  [corpus Katari `dic08_word.txt:7–8`].
- **Side effect:** Satori sorts the other ghosts by character code, so a Latin name comes first. With Tsubasa on
  screen, every Satori ghost's "ghost next to me" (`（隣で起動しているゴースト）`) and every untargeted `→` talk goes to
  her [src; infer]. DSLGS (`Charlotte Peace`) and emily4 (`Emily`) sort before her.
- `tsubasa.zip` in the archive is the Japanese original, if a both-ways demo with foxeye or gouki_saki is wanted.

## 6. Best pairs to try, in Sumika and in ssp.exe side by side

The reference ssp.exe reports FileVersion 2.9.9.3000 (SSP updated itself from 2.9.08f) [observed]. Its communicate
code is unchanged from 2.9.08f [disasm: compared instruction by instruction with the 2.9.08f dumps]. In Sumika all of
these work (`shiori-events.md` §2.7.7–§2.7.9); items 1–4 run on the site as it is, 5 and 6 need a ghost added first.
The checks for ssp.exe are `shiori-events.md` §7 Q10.

| # | Pair | Where | Do this | Should happen |
|---|---|---|---|---|
| 1 | **Katari → Tsubasa, then Katari → roommate** | all on the site and in SSP | Call ghost ▸ Tsubasa from Katari's menu; then Katari's menu 他の方にご挨拶を (or key `c`), several times. Then the same with roommate, between 11:00 and 16:59 | Katari greets the only other ghost (picked through FMO). Tsubasa answers "Mm, hello, カタリ-san." when the line holds こんにちは or こんばんは (4 of Katari's 10 lines), "Ummm..." otherwise. roommate answers "こんにちはー♪" and **sends it back**; Katari ends with "ああ、こんにちは。" (three turns). With 3 or more ghosts Katari sometimes greets everyone at once (`__SYSTEM_ALL_GHOST__`): each gets it in turn, in the order they were called. To the others roommate is `none`: her shells say `sakura.name,none`, and ssp.exe uses that name too (`shiori-events.md` §2.1 #11) [disasm] |
| 2 | **Katari + Nato** (or BAKU) | both on the site and in SSP | Katari's menu 特定の人を呼び出す → type なと; when Nato stands, roll the mouse wheel up over Katari's skirt a few times | Nato is called by her sakura name. Katari's flustered line ("まったく君ときたら、なと君も見ていると言うのに。") goes to Nato, who answers with the matching line. A setting in Katari's own menu can forbid this ("may I talk to your friends?", `dic03_Menu.txt:835–846`) |
| 3 | **Katari's "already here?"** (the FMO) | Katari + any other ghost, on the site and in SSP | Katari's menu 呼び出す (特定の人を呼び出す) → type the other ghost's sakura name; then her own kero's name, `謎の装置` | "その物語は、すでにここにある。" both times: `（Xの存在）` sees the others and Katari herself |
| 4 | **NodePsimoon + emily4** (both YAYA) | both on the site and in SSP | let both stand and wait: 1 in 10 of NodePsimoon's random talks starts a talk | NodePsimoon: "こんにちは、Emily。"; Emily answers with her greeting because her name is in it. Slow. Also check in ssp.exe whether NodePsimoon's line shows stray characters or numbers after "Emily": its old template keeps the whole otherghostname entry (name and two surface numbers) [infer] |
| 5 | **HappyDice → Tsubasa** | both installed in SSP; HappyDice not on the site | call HappyDice next to Tsubasa; HappyDice's menu 話す → the button with Tsubasa's name | HappyDice sends "こんにちは" (`dic_Menu.txt:113–120`); Tsubasa answers "Mm, hello, ポカリ-san." The simplest check: started by the user, the same every time |
| 6 | **Kanade's tea party: kanade_2nd + Tsubasa + Katari** | all three installed in SSP; kanade_2nd not on the site | start the three; kanade's menu お茶会についていろいろ → お茶会を開く → やっちゃいます | kanade asks every ghost (raiseother to `__SYSTEM_ALL_GHOST__`), waits about 5 s, serves a drink and a sweet. Tsubasa and Katari react at about the same time (Tsubasa: an English line about that sweet; Katari: she likes watching girls eat sweets). kanade closes the party. kanade alone: no failure talk at all |

## 7. What is not here

- The full counts and the per-ghost lists of what each site ghost sends and answers; the SSP and Satori rules are in
  `shiori-events.md` §2.7.7–§2.7.9.
- Pairs whose partner engine Sumika cannot run (AYA4, MISAKA, makoto) are listed only when the other side runs.

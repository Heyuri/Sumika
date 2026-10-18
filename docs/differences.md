# Sumika and SSP

What Sumika keeps of SSP and what it does differently in a browser: the right-click menu, the engines, MIDI.

## The right-click menu

The menu is SSP's, in SSP's order, with the ghost's own captions and look where it gives them:

- **Shell** lists the ghost's shells by name. A pick goes like in SSP: the ghost may say something first
  (OnShellChanging), the characters change their art where they stand, and the ghost reacts (OnShellChanged). Each
  shell keeps its own clothes and balloon. A ghost whose visitor never picked a shell starts with its default one.
- **Clothes/Dressup** (the ghost's "Dress-up" caption, for example) lists the parts the shell offers; a pick puts the
  part on or takes it off at once, and the ghost hears about it.
- **Balloon** lists every balloon of the site, the ghost's own first when it names one. The balloons on screen change
  their look in place, text, scroll position and open input boxes included.
- **Information** shows the ghost's readme (and the shell's and the balloon's, when they have one), its terms of use
  when it has them, and About Sumika.
- **Move character window** picks the character up: it follows the pointer until the next click, Esc puts it back.
  Meanwhile the ghost hears neither the mouse nor the keyboard.
- **Options ▸ Preferences…** opens SSP's settings box cut down to its "User information": name, nickname, birthday
  and sex. Ghost scripts open the same box (`\![open,configurationdialog]`; Emily asks for your name with it at her
  first boot). Each field is kept as it is typed; when the box closes after an edit, every ghost on the page hears of
  it (OnNotifyUserInfo), and after that every ghost at every boot, as in SSP. The values hold for the whole site and
  stay in the visitor's browser: the runtime sends them nowhere but to the ghosts on the page (a ghost may keep them
  in its own memory, which stays in the browser too).
- **Quit** is Close while one ghost runs; with several, Close is for that ghost and Quit for all. Network update and
  Uninstall are left out, and Options holds only Preferences…. Utilities has Reset passive mode when the page address
  has `?sumika-debug`.

Ghost scripts switch too (`\![change,shell,<name>]`, `\![change,balloon,<name>]`), and pages can with
`window.sumika.shells()`, `balloons()`, `changeShell('<folder>')` and `changeBalloon('<folder>')`.

## Differences from SSP

Things a web page cannot do are left out or imitated: no recycle bin (always empty), screen-wide effects cover the
browser window only, no network update, no SSTP from other programs. The engines are Satori Mc203-6, YAYA Tc606-2
(current releases), Kawari 8.2.8 and Kawari 7.5.0 (the last Phase 8 and Phase 7 releases), so pause lengths and a few talk choices can differ slightly from the version a
ghost ships with; a YAYA ghost whose dictionaries the newer YAYA finds broken does not start (two of the 26 swept). A
YAYA ghost runs no programs (`EXECUTE` fails), sees no environment variables and a fixed memory size, and finds the
site's other ghosts where an SSP install keeps them. What it writes into its own folder (its save, notes, a rewritten
dictionary) is kept in that visitor's browser.

Kawari ghosts run on Kawari 8.2.8, the last release, whatever 8.x version they ship: some older dictionary forms no
longer load, so those ghosts lose a few lines. Ghosts made for Kawari 7 (Phase 7, `kawari.ini`) run on Kawari 7.5.0,
the last Phase 7 release, which Sumika speaks to in SHIORI/2.x as SSP does (whatever 7.x version they ship). Like YAYA
ghosts, they find the
site's other ghosts where an SSP install keeps them, and what they write is kept in the visitor's browser. A Kawari
ghost often saves only when it is closed, so between pages Sumika keeps what its dictionary learned in the visitor's
browser and restores it on the next page, together with what the ghost set for itself when it started (such as the
time it started). When the visitor closed the tab instead of the ghost, the next visit first closes the last session
as SSP closes ghosts when Windows shuts down (the ghost's goodbye events, then its unload), at the time the tab was
closed, so the ghost keeps it, whether it saves when it says goodbye (as BloodTeaHOUSE ver.5 does) or when it unloads,
and counts the time the visitor was away from then; what it would have said is not shown. Following a link to another
page is no close: the ghost goes on from where it was.

A ghost's web requests (`\![execute,http-get|http-post]`: web claps a visitor sends to the ghost's author, bonsyou's
counter) go out as SSP sends them, from the visitor's browser to the ghost author's site, without cookies, without
anything kept from an earlier answer and without the page's address (the site's origin still shows, as browsers send
it). Many fail for reasons SSP never meets: a site served over `https://` may not fetch the `http://` addresses old
ghosts use, and a server must allow cross-site reads; the ghost hears such a failure as SSP's network error. A web clap
the browser lets out reaches its server even though the answer cannot be read.

SSP tells ghosts the Windows user name until the user sets another in its settings; a browser has none. Here ghosts
learn no name until the visitor fills in Options ▸ Preferences… (until then `%username` reads "user", unless the ghost
names the visitor itself).

Ghosts can ask SSP's property system about their surroundings (`%property[…]`): the time, the other ghosts on the
page, their own shells and balloon. Questions about the computer get a browser's answers: the OS is `Web`, the
browser's language stands for the system's, the browser window is the one monitor, and the processor, memory, disks
and network addresses are not told.

Shell scaling and Balloon scaling in the right-click menu work like SSP's: the percentages are screen pixels (100 % is
one image pixel per screen pixel), and the default follows the display and the browser's zoom. SSP's "Additional
settings (Same as ghost preferences)" opens a dialog a browser does not have; here it is "Default (match display)". Each
ghost keeps its own choice. Input and communicate boxes do not scale. SSP has no phones: on a phone the default is
"Default (fit to screen)" instead (see [Phones](guide.md#phones)).

Files a visitor drops on a ghost get a made-up Windows path (`C:\sumika\drop\…`). Audio and MIDI files the browser
can play are copied into the site's storage in that visitor's browser (at most 64 MB each and 256 MB in total), so a
ghost's playlist still plays on later visits. Nothing is uploaded; clearing the site's data in the browser removes
them.

### MIDI

SSP plays a ghost's MIDI files (`.mid`, `.midi`, `.smf`, `.rmi`) through Windows' own synthesizer, whose instruments
cannot be shipped with a web site. Sumika plays them with a synthesizer of its own (SpessaSynth's engine) and the
GeneralUser GS sound bank, a free General MIDI and Roland GS set, so they sound different from SSP on your PC.

MIDI plays wherever a ghost plays sound: its sound effects and jingles, the music players some ghosts drive (such as
Katari's music box), and MIDI files a visitor drops on a ghost, which are kept like dropped audio. Several can play at
once, from one ghost or several. Ghosts hear the same events as in SSP when the music ends or loops. A file plays from
its very start to the end of its last track, and a loop repeats the whole file (loop markers inside it are not used).

Nothing is downloaded for MIDI until a ghost first plays a MIDI file. Then the player (about 410 KB, 140 KB
compressed) and the sound bank (4.8 MB) are downloaded once; the browser keeps both, under names that change only
when they do. On a slow connection the first song starts once the bank has arrived; the download goes on as long as
data keeps coming. Each song is prepared in the background from the part of the bank it uses. A song that starts
while another one plays is set up in small steps, so the one already playing does not skip; that start takes a little
longer (on a desktop PC up to 0.3 s instead of 0.13 s, for the largest song tested).

MIDI needs a secure page (`https://`, see [Browsers](guide.md#browsers)); on a plain `http://` site, or in a browser
without the audio worklet, MIDI files stay silent. On an iPhone, MIDI music ignores the ring/silent switch from iOS 16.4
on, like the other sounds; on iOS 15.2 to 16.3 the switch mutes it.

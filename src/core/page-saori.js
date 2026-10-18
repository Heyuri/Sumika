// Page side of the SAORI stand-ins (TS §3.4, §3.6): the worker answers the engine synchronously and posts
// {t:'saori', name, cmd, args} here for effects that need the page: dsaudio / MCI playback, the fill_desktop flash.
// Also plays \_v / \8 / \![sound] files for the event loop (SS §5.8) and tells the ghost how each ends (OnSoundStop,
// OnSoundLoop, OnSoundError: EV §4.17). Nothing here throws on ghost data.
// Paths are ghost-folder files (synchronous) or dropped files (core/drops.js pseudo-paths, resolved asynchronously
// to object URLs; the commands after such a load wait for it, in order). Logs never show a dropped file's name.
// A MIDI file (core/midi.js isMidiPath, by the name the ghost gave) plays on the page's MIDI engine when there is one
// (Site.midi): its player stands in for the <audio> element (_media), so the music box and the sound events work
// unchanged (CLAUDE.md "MIDI").
import { log } from './log.js';
import { isDropPath, dropLabel } from './drops.js';
import { isMidiPath } from './midi.js';
import { getRoot, addStyle, Z_BASE } from '../ui/root.js';

const FLASH_MAX_MS = 2500;
const MCI_PLAYERS = new Set(['mciaudior', 'mciaudio']);   // worker/saori/standins.js McAudio
// mciaudior.dll tells the ghost when a track ends or starts over (SSTP NOTIFY OnMAAPlayFinish / OnMAAPlayLoop, SW);
// mciaudio.dll has no events (its strings: load, play, stop)
const MAA_EVENTS = new Set(['mciaudior']);
const MAA_R1 = '0';                 // the DLL's "Reference1: %d"; what the number means is unknown [guess]
const OPEN_TIMEOUT_MS = 10000;      // a dropped file not open by then counts as gone (IndexedDB opens can hang)
// OnSoundError's R1 / R3 (EV §4.17): ssp.exe sends the HRESULT's low 16 bits as `%u` and its player's error text,
// else FormatMessageW's [disasm MediaNotifyError 0x725000]; which codes its player returns is unknown [guess: a file
// the site lacks = ERROR_FILE_NOT_FOUND, any other failure to start = MF_E_UNSUPPORTED_BYTESTREAM_TYPE 0xC00D36C4;
// Windows' en-US texts]
const SOUND_NOT_FOUND = { code: '2', text: 'The system cannot find the file specified.' };
const SOUND_UNSUPPORTED = { code: '14020', text: 'The byte stream type of the given URL is unsupported.' };

/** A path as warnings show it: dropped files by id and extension only (host pages may collect console output). */
const shown = p => dropLabel(p) || p;

/** ssp.exe matches sound names in any case [disasm MediaFindPlayingRefAdd 0x725225: wcsicmp_custom]. */
const sameSound = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The window events afterGesture listens to (the HTML spec's activation-triggering input events). */
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'];

/**
 * Whether an event grants user activation (HTML "activation triggering input event"): a pointerdown only for a mouse,
 * a pointerup only for anything else (touch, pen), touchend and keydown always. No event (a direct call) or a
 * pointerdown without a pointerType (an older or synthetic event) counts.
 */
export function activates(e) {
  if (!e || !e.type) return true;
  if (e.type === 'pointerdown') return e.pointerType === undefined || e.pointerType === 'mouse';
  if (e.type === 'pointerup') return e.pointerType !== undefined && e.pointerType !== 'mouse';
  return true;
}

/**
 * Map a path a ghost gave us to a file of its folder: ghost-relative ('music\a.mp3'), relative to the ghost root,
 * or an absolute Windows path that runs through '<ghost>\ghost\master\'. null = not available in the browser.
 * @param {{resolve(p:string):string|null}} files GhostFiles of the ghost root
 */
export function resolveGhostPath(files, path, base = 'ghost/master/') {
  if (!files || path == null) return null;
  let p = String(path).trim().replace(/^"(.*)"$/, '$1');
  if (!p) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null;          // URLs are not ghost files
  p = p.replace(/\\/g, '/');
  const absolute = /^[a-z]:\//i.test(p) || p.startsWith('/');
  if (!absolute) return files.resolve(base + p) || files.resolve(p);
  const lower = p.toLowerCase();
  const i = lower.lastIndexOf('/ghost/master/');
  if (i >= 0) return files.resolve(base + p.slice(i + '/ghost/master/'.length));
  return null;
}

function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n / 10000));
}

/** dsaudio (and the MCI players mciaudior / mciaudio, SW): one track at a time, like the DLLs. */
class MusicBox {
  constructor(page) {
    this.page = page;
    this.owner = 'dsaudio';   // the DLL that loaded the track: it decides the event at its end (PageSaori.finished)
    this.audio = null;
    this.path = null;
    this.given = null;        // the file as the ghost gave it to load (MCI players: OnMAAPlay* Reference0), or null
    this.loop = false;
    this.volume = 1;
    this.at = 0;              // start position of the current load (resume after navigation)
    this.wantPlay = false;    // played and not paused/stopped/finished since (also while autoplay waits for a gesture)
    this.pending = null;      // token of a load waiting for a dropped file
    this.queue = [];          // commands that arrived while it waits: [cmd, args, opts]
    this.releaseUrl = null;   // revokes the current object URL
  }

  /** @param {{at?: number}} [o] internal: start position for 'load' */
  command(cmd, args, o = {}) {
    if (cmd === 'unload') { this.cancel(); this.stop(); this.release(); return; }
    // load -> stop -> loop -> volume -> play arrive at once (TS §3.4): keep their order behind a pending load
    if (this.pending) { this.queue.push([cmd, args, o]); return; }
    switch (cmd) {
      case 'load': this.owner = o.owner || 'dsaudio'; this.load(args[0], o.at, args[1]); break;
      case 'play': this.play(); break;
      case 'pause': this.wantPlay = false; if (this.audio) this.audio.pause(); break;
      case 'stop': this.stop(); break;
      case 'loop':
        this.loop = String(args[0] || '').toLowerCase() === 'enable';
        if (this.audio) this.audio.loop = this.nativeLoop();
        break;
      case 'volume': {
        const v = clampVolume(args[0] === '' || args[0] == null ? NaN : args[0]);
        if (v !== null) { this.volume = v; if (this.audio) this.audio.volume = v; }
        break;
      }
      case 'hwnd': break;
      default: log.once(`dsaudio:${cmd}`, `dsaudio: "${cmd}" is not supported`);
    }
  }

  stop() {
    this.wantPlay = false;
    this.at = 0;
    if (this.audio) { this.audio.pause(); try { this.audio.currentTime = 0; } catch (e) { /* not seekable */ } }
  }

  /**
   * The element's own loop: off for a player that reports every start-over (mciaudior's OnMAAPlayLoop), which the
   * end of the track then restarts by hand (attach).
   */
  nativeLoop() { return this.loop && !MAA_EVENTS.has(this.owner); }

  /** Forget a pending load and the commands queued behind it. */
  cancel() {
    this.pending = null;
    this.queue = [];
  }

  /**
   * Drop the current element. Removing src neither pauses a playing element nor frees its resource (HTML media), so
   * pause it and run load() with no source; otherwise the old track plays on, out of reach of stop and unload.
   */
  release() {
    const a = this.audio;
    this.audio = null;
    if (a) {
      a.onended = a.onerror = null;
      try { a.pause(); } catch (e) { /* ignore */ }
      try {
        if (typeof a.removeAttribute === 'function') a.removeAttribute('src');
        if (typeof a.load === 'function') a.load();
      } catch (e) { /* ignore */ }
    }
    if (this.releaseUrl) { try { this.releaseUrl(); } catch (e) { /* ignore */ } }
    this.releaseUrl = null;
    this.path = null;
    this.given = null;
  }

  load(path, at = 0, given = null) {
    this.release();
    this.wantPlay = false;
    this.path = path == null ? '' : String(path);
    this.given = given == null ? null : String(given);
    this.at = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : 0;
    const url = this.page.urlFor(this.path);
    if (url) { this.attach(url, null); return; }
    const opening = this.page.openDropped(this.path);
    if (!opening) {
      log.once(`dsaudio-missing:${this.path}`, `dsaudio: ${shown(this.path)} is not available in the browser`);
      return;
    }
    const token = {};
    this.pending = token;
    opening.then(h => {
      if (this.pending !== token) { if (h) h.release(); return; }
      if (h) this.attach(h.url, h.release, h.blob);
      else log.once(`dsaudio-missing:${this.path}`, `dsaudio: ${shown(this.path)} is not stored in this browser`);
    }).catch(e => log.once('dsaudio-open', 'dsaudio: opening a dropped file failed', e)).then(() => {
      if (this.pending !== token) return;
      this.pending = null;
      const q = this.queue;
      this.queue = [];
      for (const [c, a, o] of q) this.command(c, a, o);     // a queued load waits again; the rest queue behind it
    });
  }

  /** @param {Blob|null} [blob] a dropped file's (a MIDI player reads it as it is) */
  attach(url, release, blob = null) {
    const A = this.page.Audio;
    if (!A) { if (release) release(); return; }
    const a = this.page._media(this.path, url, blob);
    a.preload = 'auto';
    a.loop = this.nativeLoop();
    a.volume = this.volume;
    a.onended = () => {
      if (a.loop || this.audio !== a) return;
      const given = this.given ?? this.path;
      if (this.loop) {                     // mciaudior looping: start over by hand and say so (OnMAAPlayLoop)
        try { a.currentTime = 0; } catch (e) { /* not seekable */ }
        this.play();
        this.page.looped(this.owner, given);
        return;
      }
      this.wantPlay = false;
      this.page.finished(this.owner, given);
    };
    if (a.__midi) a.onerror = () => this.failed(a);
    this.audio = a;
    this.releaseUrl = release;
    if (this.at > 0) this.seek(a, this.at);
  }

  /** Start a new element at t; before its metadata is known the position may not stick, so apply it once more. */
  seek(a, t) {
    try { a.currentTime = t; } catch (e) { /* not seekable yet */ }
    if (typeof a.addEventListener !== 'function') return;
    a.addEventListener('loadedmetadata', () => {
      if (this.audio !== a || this.at !== t) return;          // replaced or stopped meanwhile
      try { if (Math.abs((Number(a.currentTime) || 0) - t) > 0.5) a.currentTime = t; } catch (e) { /* ignore */ }
    }, { once: true });
  }

  play() {
    const a = this.audio, path = this.path;
    if (!a) return;
    this.wantPlay = true;
    let p;
    try { p = a.play(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).catch(e => {
      if (e && e.name === 'NotAllowedError') this.page.afterGesture(() => { if (this.audio === a && this.wantPlay) this.play(); });
      else if (!a.__midi) log.once(`dsaudio-play:${path}`, `dsaudio: cannot play ${shown(path)}`, e);
      else if (!(e && e.name === 'AbortError')) this.failed(a, e);  // a pause or a new load cutting it short is no failure
    });
  }

  /**
   * A MIDI track that cannot play (its player's error, a play() rejection other than autoplay's or a pause's): it
   * stops quietly and is not wanted any more, so state() saves `playing: false` and the next page does not try it
   * again. No OnDSAPlayFinish / OnMAAPlayFinish: the DLLs send theirs at a track's end, and a track their player could
   * not open never ends [infer]; sending it would loop mikaru (it loads its OnMAAPlayFinish R0 again) at full speed on
   * a bank that cannot load. Only MIDI players: an <audio> track is retried on the next page [decision].
   */
  failed(a, err = null) {
    if (this.audio !== a) return;
    this.wantPlay = false;
    log.once(`dsaudio-play:${this.path}`, `dsaudio: cannot play ${shown(this.path)}`, err || (a.error && a.error.message) || '');
  }

  /**
   * {path, currentTime, loop, volume (0..1), playing, owner?, given?} of the loaded track, null when none (TS §3.4
   * navigation). owner: the MCI player that loaded it (absent = dsaudio); given: its load argument as the ghost gave it.
   */
  state() {
    if (!this.path || (!this.audio && !this.pending)) return null;
    let t = this.at;
    if (this.audio) { try { t = Number(this.audio.currentTime) || 0; } catch (e) { t = 0; } }
    const ended = !!(this.audio && this.audio.ended && !this.loop);
    const s = { path: this.path, currentTime: Math.max(0, t), loop: this.loop, volume: this.volume, playing: this.wantPlay && !ended };
    if (this.owner !== 'dsaudio') s.owner = this.owner;     // an MCI player's track (no OnDSAPlayFinish)
    if (this.given != null) s.given = this.given;
    // a dropped file is still opening: the commands queued behind it say what the ghost asked for (a resume's play)
    for (const [c, a, o] of this.pending ? this.queue : []) {
      if (c === 'load') {
        Object.assign(s, { path: String(a[0] ?? ''), currentTime: Number(o.at) > 0 ? Number(o.at) : 0, playing: false });
        if (o.owner && o.owner !== 'dsaudio') s.owner = o.owner; else delete s.owner;
        if (a[1] != null) s.given = String(a[1]); else delete s.given;
      }
      else if (c === 'play') s.playing = true;
      else if (c === 'pause') s.playing = false;
      else if (c === 'stop') Object.assign(s, { currentTime: 0, playing: false });
      else if (c === 'loop') s.loop = String(a[0] || '').toLowerCase() === 'enable';
      else if (c === 'volume') { const v = clampVolume(a[0] === '' || a[0] == null ? NaN : a[0]); if (v !== null) s.volume = v; }
    }
    return s.path ? s : null;
  }

  /** Load a saved state again: same track, position, loop and volume; playing again when it was. */
  restore(s) {
    if (!s || typeof s !== 'object' || typeof s.path !== 'string' || !s.path) return;
    this.command('loop', [s.loop ? 'enable' : 'disable']);
    const v = Number(s.volume);
    if (Number.isFinite(v)) this.command('volume', [String(Math.round(Math.max(0, Math.min(1, v)) * 10000))]);
    const args = typeof s.given === 'string' ? [s.path, s.given] : [s.path];
    this.command('load', args, { at: Number(s.currentTime) || 0, owner: typeof s.owner === 'string' ? s.owner : 'dsaudio' });
    if (s.playing) this.command('play', []);
  }
}

export class PageSaori {
  /**
   * @param {object} o
   * @param {object} o.files     GhostFiles of the ghost root
   * @param {object} [o.host]    EventLoop (send() for OnDSAPlayFinish, OnMAAPlayFinish / OnMAAPlayLoop; notifyEvent()
   *                             for OnSoundStop / OnSoundLoop / OnSoundError); may be set later
   * @param {Function} [o.Audio] HTMLAudioElement constructor (tests inject one)
   * @param {object} [o.win]
   * @param {object} [o.drops]   DropStore (core/drops.js): pseudo-paths of dropped files -> object URLs
   * @param {object} [o.midi]    the page's MIDI engine (core/midi.js MidiEngine, Site.midi): MIDI files play on its
   *                             players; null: they go to Audio like any other file
   * @param {number} [o.openTimeoutMs] how long a dropped file may take to open
   */
  constructor({ files, host = null, Audio = globalThis.Audio, win = globalThis.window, drops = null, midi = null, openTimeoutMs = OPEN_TIMEOUT_MS } = {}) {
    this.files = files;
    this.host = host;
    this.Audio = typeof Audio === 'function' ? Audio : null;
    this.win = win || null;
    this.drops = drops;
    this.midi = midi && typeof midi.player === 'function' ? midi : null;
    this.openTimeoutMs = openTimeoutMs;
    this.music = new MusicBox(this);
    this.sounds = new Set();
    this._soundsPending = new Set();
    this.overlay = null;
    this.flashTimer = null;
    this._gesture = [];
    this._gestureOff = null;
  }

  /** URL of a ghost-folder file, null otherwise (dropped files: openDropped). */
  urlFor(path) {
    const real = resolveGhostPath(this.files, path);
    return real ? this.files.url(real) : null;
  }

  /**
   * The player for a file (the music box's and the sounds' one factory): a MIDI player of the page's engine for a MIDI
   * file by the name the ghost gave (path; a drop's pseudo-path keeps its extension, its blob: URL has none), marked
   * `__midi`, and given the drop's Blob when there is one; else an element of the Audio constructor.
   * @param {string} path  @param {string} url  @param {Blob|null} [blob]
   */
  _media(path, url, blob = null) {
    if (this.midi && isMidiPath(path)) {
      const a = this.midi.player({ url, blob });
      a.__midi = true;
      return a;
    }
    return new this.Audio(url);
  }

  /**
   * A dropped file's pseudo-path -> Promise<{url, release, blob}|null>; null at once for any other path. Gives up
   * (null) after openTimeoutMs, so a hung store cannot hold the dsaudio commands queued behind a load for good.
   */
  openDropped(path) {
    const d = this.drops;
    if (!d || typeof d.open !== 'function' || !isDropPath(path)) return null;
    return new Promise(resolve => {
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        log.once(`drop-open-slow:${path}`, `${shown(path)} did not open in time`);
        resolve(null);
      }, this.openTimeoutMs);
      Promise.resolve().then(() => d.open(path)).catch(() => null).then(h => {
        if (done) { if (h) h.release(); return; }        // too late: nobody uses it
        done = true;
        clearTimeout(timer);
        resolve(h || null);
      });
    });
  }

  /** dsaudio state worth keeping across page navigation (TS §3.4), or null. */
  musicState() { return this.music.state(); }

  /** Session resume: the track that was loaded comes back at its position, playing if it was. */
  resumeMusic(s) { this.music.restore(s); }

  /** ShioriClient onSaori hook. */
  handle(m) {
    if (!m || typeof m !== 'object') return;
    const name = String(m.name || '').toLowerCase().replace(/\.dll$/, '');
    const cmd = String(m.cmd || '').toLowerCase();
    const args = Array.isArray(m.args) ? m.args.map(a => (a == null ? '' : String(a))) : [];
    try {
      if (name === 'dsaudio' || MCI_PLAYERS.has(name)) this.music.command(cmd, args, { owner: name });
      else if (name === 'fill_desktop') cmd === 'clear' || !args.length ? this.clearFlash() : this.flash(args);
      else log.once(`saori-page:${name}`, `SAORI ${name}: no page effect for "${cmd}"`);
    } catch (e) {
      log.once(`saori-page-err:${name}`, `SAORI ${name} page effect failed`, e);
    }
  }

  /**
   * A track ended. dsaudio: OnDSAPlayFinish (TS §3.4). mciaudior.dll: OnMAAPlayFinish [R0 the file as the ghost gave
   * it to load, R1 a number] (SW: the DLL's strings). The DLL sends it as SSTP NOTIFY, which SSP hands to SHIORI as a
   * GET whose reply plays (UKADOC SSTP: only Option `notify` makes it a NOTIFY), so it goes out like OnDSAPlayFinish.
   * R0 is the load argument, not the ghost-root path: mikaru loads its R0 again, souzou_syoka splits it at "\" for the
   * title [guess: the DLL may report the path it resolved]. mciaudio.dll has no events.
   */
  finished(owner = 'dsaudio', given = '') {
    if (owner === 'dsaudio') this._send('OnDSAPlayFinish', []);
    else if (MAA_EVENTS.has(owner)) this._send('OnMAAPlayFinish', [given, MAA_R1]);
  }

  /** A looping mciaudior track starts over: OnMAAPlayLoop, sent like OnMAAPlayFinish (cmn, mikaru, hitujitopanda). */
  looped(owner, given = '') {
    if (MAA_EVENTS.has(owner)) this._send('OnMAAPlayLoop', [given, MAA_R1]);
  }

  _send(id, refs) {
    if (this.host && typeof this.host.send === 'function') this.host.send(id, refs);
  }

  /**
   * A sound's own event (EV §4.17): ssp.exe sends it through SPGhost::OnNotifyEventThread, a GET with SenderType
   * internal whose reply plays as a \![raiseother] reply's [disasm StopEvent 0x7199f0, LoopNextEvent 0x719b69,
   * MediaNotifyError 0x72518b]: host.notifyEvent, which sends nothing before boot, once closed, while changing ghosts
   * or frozen. A host without it (a test's) gets host.send.
   */
  _soundEvent(id, refs) {
    const h = this.host;
    if (!h || typeof h.notifyEvent !== 'function') { this._send(id, refs); return; }
    let p;
    try { p = h.notifyEvent(id, refs); } catch (e) { p = null; }
    Promise.resolve(p).catch(() => {});
  }

  /**
   * Run fn once after the next user gesture (autoplay policy). The gesture is one of the HTML spec's activation events
   * (TS §3.4; CLAUDE.md "Browsers"): a mouse's pointerdown (or one without a pointerType: a direct call), a touch's or
   * pen's pointerup, touchend, keydown. A touch's pointerdown grants no activation (the spec, Chrome; WebKit [verify]),
   * so a retry run there would fail again on phones; it waits for the finger's lift instead. A mouse: its pointerdown.
   */
  afterGesture(fn) {
    this._gesture.push(fn);
    if (this._gestureOff || !this.win || !this.win.addEventListener) return;
    const go = e => {
      if (!activates(e)) return;
      off();
      const list = this._gesture;
      this._gesture = [];
      for (const f of list) { try { f(); } catch (e2) { /* ignore */ } }
    };
    const opts = { capture: true, passive: true };
    const off = () => {
      for (const t of GESTURE_EVENTS) this.win.removeEventListener(t, go, opts);
      this._gestureOff = null;
    };
    for (const t of GESTURE_EVENTS) this.win.addEventListener(t, go, opts);
    this._gestureOff = off;
  }

  /**
   * \_v[file], \8[file], \![sound,play|loop|stop|pause|resume,file] (SS §5.8; Tsubasa uses none). As ssp.exe's
   * SPSoundManager (EV §4.17): one element per file name, in any case; playing a file that is still there starts it
   * over with the new tag's loop flag, and the cut play says nothing; each sound tells the ghost how it ends:
   * OnSoundStop [the file as the tag gave it, `end`] at its natural end, OnSoundLoop [file] each time a loop starts
   * over, OnSoundError [play, code, file, text] when it cannot start. A stop (named or all), a new page or the ghost's
   * close ends it silently. Nothing is sent without an Audio constructor (Node, the sweep).
   */
  sound(cmd, args = []) {
    const c = String(cmd || '').toLowerCase();
    const file = args[0] == null ? '' : String(args[0]);
    if (c === 'stop' || c === 'pause' || c === 'resume') {
      // a named stop is StopEvent without a reason, no file is StopAll: no event either way [disasm 0x72578a–0x7257ac]
      for (const a of this._findSound(file)) {
        if (c === 'resume') { a.__paused = false; a.play().catch(() => {}); }
        else { a.pause(); if (c === 'stop') this._dropSound(a); else a.__paused = true; }
      }
      // a dropped file still being opened: stop and pause cancel it
      if (c !== 'resume') for (const p of this._soundsPending) if (!file || sameSound(p.file, file)) this._soundsPending.delete(p);
      return;
    }
    if (c !== 'play' && c !== 'loop') { log.once(`sound:${c}`, `sound command "${c}" is not supported`); return; }
    const loop = c === 'loop';
    const logMissing = () => log.once(`sound-missing:${file}`, `sound ${shown(file)} is not available`);
    if (!this.Audio) { logMissing(); return; }
    // a file the site lacks cannot load: OnSoundError (no argument: ssp.exe plays nothing [disasm 0x62deb2])
    const missing = () => {
      logMissing();
      if (file) this._soundEvent('OnSoundError', ['play', SOUND_NOT_FOUND.code, file, SOUND_NOT_FOUND.text]);
    };
    const same = file ? this._findSound(file)[0] : null;
    if (same) { this._restartSound(same, loop); return; }
    const url = this.urlFor(file);
    if (url) { this._startSound(file, url, null, loop); return; }
    const opening = this.openDropped(file);
    if (!opening) { missing(); return; }
    const p = { file };
    this._soundsPending.add(p);
    opening.then(h => {
      const live = this._soundsPending.delete(p);
      if (!h) { if (live) missing(); return; }
      if (!live) { h.release(); return; }
      const now = this._findSound(file)[0];             // the same file started meanwhile: start that one over
      if (now) { h.release(); this._restartSound(now, loop); return; }
      this._startSound(file, h.url, h.release, loop, h.blob);
    });
  }

  /** The sounds named `file`, any case; every sound when no file is named. */
  _findSound(file) {
    const all = [...this.sounds];
    return file ? all.filter(a => sameSound(a.__file, file)) : all;
  }

  _startSound(file, url, release, loop, blob = null) {
    const a = this._media(file, url, blob);
    a.__file = file;                // as the tag gave it: the events' R0 [disasm MediaFindInactiveOrNewRefAdd 0x7253f4]
    a.__release = release;
    a.__loop = loop;
    a.__started = false;            // play() resolved once: a failure after that ends it as OnSoundStop
    a.loop = false;                 // a loop is started over by hand, so that the ghost hears it (OnSoundLoop)
    a.onended = () => this._soundEnded(a);
    a.onerror = () => this._soundFailed(a, a.error);
    this.sounds.add(a);
    this._playSound(a);
  }

  /**
   * The same file again: from the start, with the new tag's loop flag; the cut play sends nothing [disasm Execute
   * 0x72551c–0x72556f: MediaFindPlayingRefAdd, SendCommand(8), the flags replaced].
   */
  _restartSound(a, loop) {
    a.__loop = loop;
    try { a.currentTime = 0; } catch (e) { /* not seekable */ }
    // a paused sound is rewound and stays paused until its resume: SendCommand(8, !paused) [disasm 2.9.10
    // 0x725527–0x725536; the paused flag desc+0xb: pause 0x719703, resume 0x719718]
    if (!a.__paused) this._playSound(a);
  }

  /** play() a sound: autoplay waits for a gesture; a pause or a new load cutting it short is no failure. */
  _playSound(a) {
    let p;
    try { p = a.play(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(() => { if (this.sounds.has(a)) a.__started = true; }, e => {
      if (!this.sounds.has(a)) return;                                    // stopped meanwhile
      if (e && e.name === 'NotAllowedError') this.afterGesture(() => { if (this.sounds.has(a)) this._playSound(a); });
      else if (!(e && e.name === 'AbortError')) this._soundFailed(a, e);
    });
  }

  /**
   * The element's `ended` (SPSoundManager::OnComplete [disasm 0x725c00]): a stale end (it was started over since,
   * IsCurrentNotify 0x725c1f) is ignored; a loop starts over and sends OnSoundLoop [file] (SendCommand(8, 1), then
   * LoopNextEvent 0x719b4b–0x719b69); any other sound is done: OnSoundStop [file, `end`] (StopEvent 0x725c71).
   */
  _soundEnded(a) {
    if (!this.sounds.has(a) || a.ended === false) return;
    if (a.__loop) {
      try { a.currentTime = 0; } catch (e) { /* not seekable */ }
      this._playSound(a);
      this._soundEvent('OnSoundLoop', [a.__file]);
      return;
    }
    this._dropSound(a);
    this._soundEvent('OnSoundStop', [a.__file, 'end']);
  }

  /**
   * A sound that cannot play (the element's error, a play() rejection other than autoplay's or a pause's), once:
   * before it ever played, OnSoundError [play, code, file, text] (MediaNotifyError from Execute 0x725669 and
   * MediaPlayFile 0x724dc4); after, it ends as a finished sound does, OnSoundStop [file, `end`] [infer].
   */
  _soundFailed(a, err) {
    if (!this.sounds.has(a)) return;
    log.once(`sound-play:${a.__file}`, `sound: cannot play ${shown(a.__file)}`, err);
    try { a.pause(); } catch (e) { /* ignore */ }
    this._dropSound(a);
    if (a.__started) this._soundEvent('OnSoundStop', [a.__file, 'end']);
    else this._soundEvent('OnSoundError', ['play', SOUND_UNSUPPORTED.code, a.__file, SOUND_UNSUPPORTED.text]);
  }

  /**
   * Forget a sound; its handlers go first, so a stopped or dropped sound can never report. A MIDI player is released
   * as the music box releases its track (its node and its song go); an <audio> element is left as it is [decision].
   */
  _dropSound(a) {
    a.onended = a.onerror = null;
    this.sounds.delete(a);
    if (a.__midi) {
      try { a.pause(); } catch (e) { /* ignore */ }
      try { a.removeAttribute('src'); a.load(); } catch (e) { /* ignore */ }
    }
    if (a.__release) { try { a.__release(); } catch (e) { /* ignore */ } a.__release = null; }
  }

  /** fill_desktop: a brief full-viewport colour flash below the characters (TS §3.6). */
  flash(rgb) {
    if (typeof document === 'undefined') return;
    const [r, g, b] = rgb.map(v => Math.max(0, Math.min(255, Number(v) || 0)));
    addStyle('page-saori', `
      .smk-flash { position: fixed; inset: 0; pointer-events: none; z-index: ${Z_BASE - 1}; opacity: 0;
                  transition: opacity 120ms ease-out; }
      .smk-flash.on { opacity: 0.85; }
      @media (prefers-reduced-motion: reduce) { .smk-flash { transition: none; } .smk-flash.on { opacity: 0.3; } }
    `);
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.className = 'smk-flash';
      this.overlay.setAttribute('aria-hidden', 'true');
      getRoot().appendChild(this.overlay);
    }
    this.overlay.style.background = `rgb(${r},${g},${b})`;
    void this.overlay.offsetWidth;
    this.overlay.classList.add('on');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.clearFlash(), FLASH_MAX_MS);
  }

  clearFlash() {
    clearTimeout(this.flashTimer);
    this.flashTimer = null;
    if (this.overlay) this.overlay.classList.remove('on');
  }

  destroy() {
    this.music.command('unload', []);
    // the ghost goes: every sound stops without an event [disasm CMediaHelperGhostWnd::Shutdown → StopAll 0x46eae0]
    for (const a of [...this.sounds]) { try { a.pause(); } catch (e) { /* ignore */ } this._dropSound(a); }
    this.sounds.clear();
    this._soundsPending.clear();
    this.clearFlash();
    if (this.overlay) this.overlay.remove();
    this.overlay = null;
    if (this._gestureOff) this._gestureOff();
    this._gesture = [];
  }
}

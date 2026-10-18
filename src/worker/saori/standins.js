// JavaScript stand-ins for Windows SAORI DLLs, keyed by lower-case DLL file name (TS §3, SUMMARY §3.1).
// Each class: constructor(ctx{name,path,dir,notifyPage(cmd,args),log}); execute(args:string[], headers:Map) ->
// {result?, values?} (null = 204); optional unload().
// Stand-ins answer synchronously (the engine waits for them); page effects go through ctx.notifyPage.
// A reply with only `result` sends no Value headers, so Satori keeps its （Ｓ０）… from earlier calls (TS §3.1).
import { isDropPath } from '../../core/drops.js';

const lower = v => String(v == null ? '' : v).trim().toLowerCase();

/**
 * gomi.dll: the Recycle Bin. A browser has none, so it is always empty and emptying it does nothing (TS §3.5).
 * empty.dll is the same kind of SAORI with the same options (`-n`, `-sf`, `-ef`, `-asfw`; ハヤト and others ship it).
 */
class Gomi {
  execute(args) {
    const query = args.some(a => /^-[a-z]*n/i.test(String(a)) || lower(a) === '--number');
    if (query) return { result: '0', values: ['0'] };   // 0 items, 0 bytes
    return { result: '' };
  }
}

/**
 * dsaudio.dll: the music box (TS §3.4). Every command is accepted and answered 200 without Value headers; the page
 * plays the file. `volume` with no value is a query and returns the current volume. Everything else has an empty
 * Result: Tsubasa calls `（dsaudio,volume,n）` and `（dsaudio,hwnd,…）` outside `nop`, so any text would end up
 * in her balloon. `load` keeps its 1 (TS §3.4); she only calls it inside `nop`.
 */
class DsAudio {
  constructor(ctx) {
    this.ctx = ctx;
    this.volume = 10000;
    this.loop = false;
    this.loaded = '';
  }

  execute(args) {
    const cmd = lower(args[0]);
    const rest = args.slice(1).map(a => (a == null ? '' : String(a)));
    switch (cmd) {
      case 'volume': {
        if (rest[0] === undefined || rest[0].trim() === '') return { result: String(this.volume) };
        const v = Math.round(Number(rest[0]));
        if (Number.isFinite(v)) this.volume = Math.max(0, Math.min(10000, v));
        this.ctx.notifyPage('volume', [String(this.volume)]);
        return { result: '' };
      }
      case 'loop':
        this.loop = lower(rest[0]) === 'enable';
        this.ctx.notifyPage('loop', [this.loop ? 'enable' : 'disable']);
        return { result: '' };
      case 'load':
        // load takes one path [DS]; Satori splits （dsaudio,load,（path）） at commas in the file name: join them again
        this.loaded = rest.join(',');
        this.ctx.notifyPage('load', [this.loaded]);
        return { result: '1' };
      case 'hwnd':
      case '':
        return { result: '' };                  // window handles mean nothing here
      default:
        this.ctx.notifyPage(cmd, rest);         // play, stop, pause and anything newer
        return { result: '' };
    }
  }

  /** Satori unloads every SAORI on a dictionary reload: the music stops, as with the DLL (TS §3.1). */
  unload() {
    this.ctx.notifyPage('unload', []);
  }
}

/** fill_desktop.dll: fills the screen with a colour; in a browser, a brief overlay on the page (TS §3.6). */
class FillDesktop {
  constructor(ctx) { this.ctx = ctx; }
  execute(args) {
    const rgb = args.slice(0, 3).map(a => String(a).trim());
    if (rgb.length && rgb.some(v => v !== '')) this.ctx.notifyPage('fill', rgb.map(v => v || '0'));
    else this.ctx.notifyPage('clear', []);
    return { result: '' };
  }
}

/** httpc.dll: HTTP scraper (weather). Not possible synchronously in a browser: empty result, she reports failure. */
class Httpc {
  execute(args) {
    if (!args.length || args.every(a => String(a) === '')) return { result: '0' };   // connectivity check
    return { result: '' };
  }
}

/** Shift_JIS byte length: ASCII and half-width katakana take 1 byte, everything else 2 (TS §3.8). */
export function sjisByteLength(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += c < 0x80 || (c >= 0xff61 && c <= 0xff9f) ? 1 : 2;
  }
  return n;
}

/**
 * yaya.dll / aya5.dll used as a SAORI: the DLL runs the ghost's own AYA script, which the browser cannot.
 * - GETSTRBYTES: Tsubasa (TS §3.8).
 * - Read.*: the shared read.aym (16 ghosts, SW; 07_words, bukimi, an_inu ...) reads another ghost's save file from
 *   the SSP install, e.g. Read.SaveData,<ghost folder>,<variable>[,<not-found text>]. A browser has no other installed
 *   ghosts: "not found" as the script answers it for a missing folder (Result = Argument3 or "notfound", Value0 = -1).
 *   An empty answer would read as "found" (07_words compares with "notfound").
 */
class Aya {
  constructor(ctx) { this.ctx = ctx; this.warned = new Set(); }
  execute(args) {
    const fn = lower(args[0]);
    if (fn === 'getstrbytes') return { result: String(sjisByteLength(args[1] == null ? '' : args[1])) };
    if (fn.startsWith('read.')) {
      const nf = args[3] != null && String(args[3]) !== '' ? String(args[3]) : 'notfound';
      return { result: nf, values: ['-1'] };
    }
    if (!this.warned.has(fn)) {
      this.warned.add(fn);
      this.ctx.log('warn', `SAORI aya: function "${args[0]}" is not available in the browser`);
    }
    return null;
  }
}

/** Full-width digits and signs as ASCII (Satori variables often hold "２０２６"). */
const ascii = s => String(s == null ? '' : s).replace(/[０-９－＋]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();

/**
 * A path a ghost gave a SAORI, relative to the DLL's folder (SW: ku-ver06.1 and ohanabatakeB6 keep their music next to
 * saori/mciaudio.dll, mikaru loads "../sound/hymn109.mid"), as a ghost-root path the page resolves (resolveGhostPath).
 * Absolute and UNC paths, URLs and dropped-file pseudo-paths (C:\sumika\drop\...) pass through.
 */
export function pathFromDll(dir, p) {
  const s = String(p == null ? '' : p).trim().replace(/^"(.*)"$/, '$1');
  if (!s || /^[a-z]:[\\/]|^[\\/]{2}|^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  const out = [];
  for (const seg of (String(dir || '').replace(/\\/g, '/') + '/' + s.replace(/\\/g, '/')).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

/**
 * mciaudior.dll / mciaudio.dll: MCI music players (16 ghosts, SW): load,<file> / play / loop (play repeating) / stop /
 * pause, played by the page's dsaudio music box. Every call answers an empty Result: ghosts call them in the middle of
 * balloon text ("：（mciaudior,load,amazing.mid）（mciaudior,play）（２００６）Amazing ...").
 * load sends [ghost-root path, the file as the ghost gave it]: mciaudior.dll's OnMAAPlayFinish / OnMAAPlayLoop carry
 * the latter as Reference0 (page-saori.js; mikaru loads its R0 again, so it must not be resolved twice).
 * Not the numbered copies (mciaudior2.dll …: um.nar keeps footsteps on them over the BGM, SW): one shared music box
 * would cut the BGM, so they have no stand-in.
 */
class McAudio {
  constructor(ctx) { this.ctx = ctx; }
  execute(args) {
    const cmd = lower(args[0]);
    const rest = args.slice(1).map(a => (a == null ? '' : String(a)));
    const page = this.ctx.notifyPage;
    switch (cmd) {
      case 'load': { const given = rest.join(','); page('load', [pathFromDll(this.ctx.dir, given), given]); break; }
      case 'play': page('loop', ['disable']); page('play', []); break;
      case 'loop': page('loop', ['enable']); page('play', []); break;
      case 'stop': case 'pause': page(cmd, []); break;
      case '': break;
      default: page(cmd, rest);           // the music box logs what it does not know
    }
    return { result: '' };
  }

  /** The music stops with the DLL (dictionary reload, ghost close), as with dsaudio (TS §3.1). */
  unload() { this.ctx.notifyPage('unload', []); }
}

/**
 * time_check.dll (8 ghosts, SW): how_many_days,Y,M,D -> whole days from today to that date, negative for a past one.
 * BAKU, Katari ... write "（time_check、how_many_days、（終了年）、（終了月）、（終了日））*-1" for days since the last
 * session, then test >=365 [infer from that use; the DLL has no documentation]. A date that is not one (the variables are
 * still empty on a first meeting, sagiri_tama) is 0 days, so the ghost's arithmetic stays valid [guess].
 */
class TimeCheck {
  constructor(ctx) { this.now = (ctx && ctx.now) || (() => Date.now()); }
  execute(args) {
    if (lower(args[0]) !== 'how_many_days') return { result: '' };
    const [y, m, d] = args.slice(1, 4).map(a => parseInt(ascii(a), 10));
    if (![y, m, d].every(Number.isFinite) || m < 1 || m > 12 || d < 1 || d > 31) return { result: '0' };
    const t = new Date(this.now());
    const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
    return { result: String(Math.round((Date.UTC(y, m - 1, d) - today) / 86400000)) };
  }
}

/**
 * saori_cpuid.dll (HimawariCompany SAORI/CPUID 1.0.4; 7 ghosts, SW): machine facts for talk. Keys from the DLL:
 * platform, os.name/version/build, cpu.name/num/vender/clock/clockex/family/model/stepping/ptype/mmx/mmx+/sse/sse2/
 * tdn/tdn+, mem.os/phyt/phya/virt/vira/pagt/paga (MB: 1st-innerport shows mem.phyt×1024 as kb). A browser knows the
 * OS from the user agent, the logical processors and roughly the memory (navigator.deviceMemory, GB); numbers it cannot
 * know are 0 [guess]. As the DLL answers (SW, its copy in 1st-innerport): platform = the host program's file name
 * (1st-innerport shows it: "ssp.exe" under SSP), CPU flags "Ready" / "Not Ready", other keys "Param Error".
 */
const CPUID_KEYS = new Set(['platform', 'os.name', 'os.version', 'os.build', 'cpu.name', 'cpu.num', 'cpu.vender',
  'cpu.clock', 'cpu.clockex', 'cpu.family', 'cpu.model', 'cpu.stepping', 'cpu.ptype', 'cpu.mmx', 'cpu.mmx+', 'cpu.sse',
  'cpu.sse2', 'cpu.tdn', 'cpu.tdn+', 'mem.os', 'mem.phyt', 'mem.phya', 'mem.virt', 'mem.vira', 'mem.pagt', 'mem.paga']);
class CpuId {
  constructor(ctx) { this.nav = (ctx && ctx.navigator) || (typeof navigator !== 'undefined' ? navigator : {}); }
  execute(args) {
    const k = lower(args[0]);
    const ua = String(this.nav.userAgent || '');
    const os = /Windows NT (\d+)\.(\d+)/.exec(ua) ? 'Windows'
      : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'Mac OS X'
        : /CrOS/.test(ua) ? 'Chrome OS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
    const ver = (/Windows NT (\d+\.\d+)/.exec(ua) || /Android (\d+(?:\.\d+)?)/.exec(ua) || /OS X (\d+)[._](\d+)/.exec(ua)
      || /OS (\d+)[._](\d+)/.exec(ua) || []).slice(1).join('.') || '0.0';
    const mem = Number(this.nav.deviceMemory) > 0 ? Math.round(Number(this.nav.deviceMemory) * 1024) : 0;
    const cores = Number(this.nav.hardwareConcurrency) > 0 ? Number(this.nav.hardwareConcurrency) : 1;
    switch (k) {
      case 'platform': return { result: 'ssp.exe' };
      case 'os.name': return { result: os };
      case 'os.version': return { result: ver.includes('.') ? ver : ver + '.0' };
      case 'cpu.name': return { result: 'Unknown CPU' };
      case 'cpu.vender': return { result: 'Unknown' };
      case 'cpu.num': return { result: String(cores) };
      case 'cpu.mmx': case 'cpu.sse': case 'cpu.sse2': return { result: 'Ready' };
      case 'cpu.mmx+': case 'cpu.tdn': case 'cpu.tdn+': return { result: 'Not Ready' };   // AMD-only flags [guess]
      case 'mem.phyt': return { result: String(mem) };
      case '': return { result: '' };
      // os.build, clocks, family/model/stepping, other memory figures
      default: return { result: CPUID_KEYS.has(k) ? '0' : 'Param Error' };
    }
  }
}

/**
 * sysio.dll (4 ghosts, SW): file system queries. Used: isexist,<path> ("<=0" = absent; souzou_syoka's bins of dropped
 * songs), isfile,<path> ("!=1" = missing; cmn's playlist), isdir,<path>, readdir,<path> ("!=-1" = a folder: Flugor,
 * cmn; with their own separators, b4 and △). The real DLL: an existing file is isexist 1, isfile 1, isdir 0,
 * readdir -1 (SW, the xxx_xxx copy). A browser reaches only dropped files (core/drops.js pseudo-paths), never a folder:
 * drops are files that exist, everything else is absent.
 */
class SysIo {
  execute(args) {
    const fn = lower(args[0]);
    const file = isDropPath(args[1]);
    switch (fn) {
      case 'isexist': case 'isfile': return { result: file ? '1' : '0' };
      case 'isdir': return { result: '0' };
      case 'readdir': return { result: '-1' };
      default: return { result: '' };
    }
  }
}

/**
 * maho.dll (3 ghosts, SW): the type of a file (dropped music or wallpaper) from its magic bytes: midi, ogg_vorbis,
 * ogg_flac, wave, jpeg, unknown ... (strings of the DLL). The worker cannot read a dropped file, so the extension
 * decides; the names follow what ghosts compare with (souzou_syoka: mp3, wav, midi, ogg_vorbis, png, bmp, jpg, jpeg).
 * An .smf is a Standard MIDI File (`MThd`, what the DLL reads) whatever its extension says; what it answers for an
 * .rmi (`RIFF`…`RMID`) is not known, so that stays unknown [decision].
 */
const MAHO_TYPES = { mp3: 'mp3', wav: 'wav', mid: 'midi', midi: 'midi', smf: 'midi', ogg: 'ogg_vorbis', flac: 'flac', png: 'png', bmp: 'bmp', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif' };
class Maho {
  execute(args) {
    const m = /\.([a-z0-9]+)\s*$/i.exec(String(args[0] == null ? '' : args[0]));
    return { result: (m && MAHO_TYPES[m[1].toLowerCase()]) || 'unknown' };
  }
}

export const standIns = {
  'gomi.dll': Gomi,
  'empty.dll': Gomi,
  'dsaudio.dll': DsAudio,
  'fill_desktop.dll': FillDesktop,
  'httpc.dll': Httpc,
  'yaya.dll': Aya,
  'aya5.dll': Aya,
  'mciaudior.dll': McAudio,
  'mciaudio.dll': McAudio,
  'time_check.dll': TimeCheck,
  'saori_cpuid.dll': CpuId,
  'sysio.dll': SysIo,
  'maho.dll': Maho,
};

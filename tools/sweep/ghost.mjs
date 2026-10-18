// One ghost of the sweep (tools/sweep.mjs): boots it headlessly on the real runtime parts (Satori, YAYA or Kawari WASM,
// EventLoop, ScriptPlayer, Stage, Balloons) under a fake clock (--clock, tools/sweep/clock.mjs: by default one fixed
// date and time for the page side and the engine alike), plays with it like a visitor would, and prints one JSON
// report line on stdout. Everything the runtime logs, every SHIORI request and every script is recorded; its
// \![execute,http-*] requests are counted and never sent (sweepFetch), nor is anything else (the fetch shim). The ghost's
// index entry and its own \![change,shell|balloon] follow the site and the runtime (tools/sweep/views.mjs, EV §2.6);
// the engine and YAYA's module are sweepEngine's, as in tools/sweep.mjs. A YAYA ghost also gets a resume check (D1,
// yaya-wasm.md resume): the next page's engine, resumed from the files this one stored, must save the same variables,
// and after a dictionary change it must load as after an update. A Kawari ghost gets its own (kawari-wasm.md §8, §15:
// kawariResumeCheck): the dictionary a resumed engine holds, the reload after an update, and D6. The property names a
// ghost reads or sets (properties.md) are counted with whether they failed (report.properties), and the Preferences box
// pages it asks for (\![open,con…], UI §2.13) are recorded (report.settings); the visitor never saved the box (a fake
// UserProfile, unset).
//
// usage: node tools/sweep/ghost.mjs <archive.nar|.zip | ghost folder> [--seconds 600] [--picks 40]
//          [--clock fixed|real|YYYY-MM-DDTHH:MM[:SS]]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openZip } from './zip.mjs';
import { GhostFiles, normPath, decodeText } from '../../src/core/loader.js';
import { WORD_FILE, parseWordList } from '../../src/core/words.js';
import { engineFileList, chooseBalloon, showDefaultCharacters } from '../../src/core/runtime.js';
import { yayaFilePlan, yayaSite, personalFile, KAWARI7_TEXT } from '../../src/core/engine-files.js';
import { shellName } from '../../src/core/shells.js';
import { ghostEntry, viewSwitcher, balloonPath, sweepEngine } from './views.mjs';
import { kawariFilePlan, kawariLogText, parseKawariDump, snapshotNames, parseK7Dump, k7SnapshotNames, classifyResume, d6Outcome } from './kawari.mjs';
import { parseClock, fixProcessClock, localText } from './clock.mjs';
import { Stage } from '../../src/shell/stage.js';
import { BalloonSkin, Balloons } from '../../src/balloon/index.js';
import { ScriptPlayer } from '../../src/sakura/player.js';
import { tokenize } from '../../src/sakura/tokenizer.js';
import { refList, jumpString } from '../../src/sakura/commands.js';
import { EventLoop, settingsPage } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { UiLanguage } from '../../src/core/language.js';
import { SatoriEngine } from '../../src/worker/engines/satori.js';
import { YayaEngine } from '../../src/worker/engines/yaya.js';
import { KawariEngine } from '../../src/worker/engines/kawari.js';
import { Kawari7Engine } from '../../src/worker/engines/kawari7.js';
import { STAMP_CHANGED } from '../../src/worker/engines/ssproot.js';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { standIns } from '../../src/worker/saori/standins.js';
import { buildRequest, parseResponse, BASE_HEADERS } from '../../src/core/shiori.js';
import { setLogLevel } from '../../src/core/log.js';
import { resolveGhostPath } from '../../src/core/page-saori.js';
import { askMenu, buildMenuModel } from '../../src/ui/menu.js';
import { loadEngineFactory } from '../../tests/load_engine.mjs';
import { decodePng } from '../../tests/shell/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineJs = name => path.join(ROOT, 'site', 'sumika', 'engines', `${name}.js`);
const SITE_BALLOON = path.join(ROOT, 'site', 'balloon', 'sumika');
// SSP's word list as the page reads it (Site.compatibleWords, properties.md §2.4): the site's copy; none without it
const WORD_LIST = (() => {
  const p = path.join(ROOT, 'site', ...WORD_FILE.split('/'));
  return fs.existsSync(p) ? parseWordList(decodeText(fs.readFileSync(p))) : null;
})();
const ENGINE_LOG_MAX = 300;      // report.engineLog lines (YAYA's fatal / error / warning / note; Kawari's, once each)
const LOAD_STATUS = { '-1': 'no engine', 0: 'normal', 1: 'emergency', 2: 'suppressed', 3: 'shell mode' };    // yaya_load_status()
const KAWARI_DIC = /^ghost\/master\/(.+\.(kis|kaw)|(.+\/)?dict[^/]*\.txt)$/i;     // report.dicFiles: what `load` reads
const KAWARI_CRYPT = /(^|\n)!KAWA000[01]/;      // an encrypted line (kawari_crypt.cpp)
const KAWARI_DUMP = '/sumika/all.kis';           // the resume check's full dump, beside the engine's snapshot
// Kawari 7's dictionaries (report.dicFiles): what kawari.ini's `dict` lines name in the corpus, .txt, .kdf and .dat at
// any depth (maria_re's dictionary\*.kdf, mayura's *.dat), descript and readme files left out
const KAWARI7_DIC = /^ghost\/master\/(?!descript\.txt$|readme[^/]*\.txt$).+\.(txt|kaw|kis|kdf|dat)$/i;

const args = process.argv.slice(2);
const strOpt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const opt = (name, dflt) => { const v = strOpt(name); return v === undefined ? dflt : Number(v); };
// the source: neither a flag nor a flag's value
const SRC = args.find((a, i) => !a.startsWith('--') && !/^\d+$/.test(a) && !(i > 0 && args[i - 1].startsWith('--')));
const IDLE_SECONDS = opt('seconds', 600);
const MAX_PICKS = opt('picks', 60);
const CLOCK = parseClock(strOpt('clock'));     // {fixed, start, label} (tools/sweep/clock.mjs)
const TRACE = !!process.env.SWEEP_TRACE;    // every request (but ticks and moves) on stderr
const FRAME_MS = 250;            // shell animation frames in fake time (the browser draws at 60 fps; this is enough to run them)

// ---------------------------------------------------------------- capture

let phase = 'load';
const logs = [];
const fmt = a => a.map(x => (x instanceof Error ? (x.stack || x.message) : typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })())).join(' ');
for (const k of ['debug', 'info', 'warn', 'error', 'log']) console[k] = (...a) => logs.push({ level: k, phase, msg: fmt(a).slice(0, 800) });
setLogLevel('debug');
process.on('unhandledRejection', e => logs.push({ level: 'error', phase, msg: 'unhandled rejection: ' + fmt([e]).slice(0, 800) }));
process.on('uncaughtException', e => logs.push({ level: 'error', phase, msg: 'uncaught: ' + fmt([e]).slice(0, 800) }));

const report = {
  source: SRC ? path.basename(SRC) : '', ok: false, stage: 'load', id: '', name: '', sakura: '', kero: '', craftman: '',
  shiori: '', charset: '', engine: '', module: undefined, engineBy: '', indexEngine: '', indexModule: undefined,
  loadStatus: undefined, engineDll: '', satoriDll: '', shells: 0, ownBalloon: false, balloon: '', dicFiles: 0, dicBytes: 0,
  encrypted: 0, saori: [], requests: {}, errors: [], unknownTags: [], tags: {}, boxes: [], picks: [], changes: [], http: [],
  scripts: 0, chars: 0, closed: false, crashed: null, wallMs: {}, slow: [], logs: [], engineLog: [], media: [], menu: {},
  properties: {}, settings: [],
  // --clock (fixed / real) and the page side's clock at the start and at the end of the walk, local time
  clock: { mode: CLOCK.label, start: localText(CLOCK.start), end: null },
};

/**
 * A property name as the summary counts it: a list's argument (`ghostlist(<name>)`, `shelllist(<name>)`) as `(NAME)`
 * unless it is a number, so one ghost's names count once across ghosts.
 */
const propKey = name => String(name).replace(/(ghostlist|balloonlist|shelllist)\(([^)]*)\)/gi,
  (m, list, arg) => (/^\s*\d+\s*$/.test(arg) ? m : `${list}(NAME)`)).slice(0, 100);

/** The visitor's user information as the sweep has it: never saved (OnNotifyUserInfo not sent; %username -> `user`). */
const sweepUser = { isSet: () => false, refs: () => ['', '', '', 'undef'], nickname: () => null };
// the sweep's own timings: the real clock, bound before the engines' clock follows the fake one (fixProcessClock;
// followClock with --clock real)
const realNow = Date.now.bind(Date);
const realPerf = performance.now.bind(performance);
const t0 = realNow();
const mark = name => { report.wallMs[name] = realNow() - t0; };
let pageClock = null;            // main's SweepClock, for report.clock.end

// ---------------------------------------------------------------- files

/** Folders held in memory, by URL root: the image loaders fetch() file URLs, served by the shim below. */
const ROOTS = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  for (const [root, files] of ROOTS) {
    if (!u.startsWith(root)) continue;
    const rel = u.slice(root.length).split('/').map(decodeURIComponent).join('/');
    try { return new Response(await files.bytes(rel)); } catch (e) { return new Response(null, { status: 404 }); }
  }
  // the sweep never goes on the network (a ghost's \_b[http://…], anything else that asks)
  if (/^(https?|wss?):/i.test(u)) throw new TypeError(`the sweep sends no network requests: ${u.slice(0, 120)}`);
  return realFetch(url, init);
};

/**
 * \![execute,http-*] (EV §4.15): counted, never sent. Each answers as a host that cannot be reached (a browser's
 * TypeError: Failure `error`), so the ghosts' failure paths run.
 */
const sweepFetch = async (url, init = {}) => {
  if (report.http.length < 100) {
    report.http.push({ phase, method: init.method || 'GET', url: String(url).slice(0, 160), mode: init.mode || '' });
  }
  throw new TypeError('the sweep sends no network requests');
};

/** A ghost folder held in memory (from an archive or a directory), with the GhostFiles interface. */
class MemFiles extends GhostFiles {
  constructor(get, list, root = 'mem:/ghost/') {
    super(root, list, null, '');
    this._get = get;
    if (!ROOTS.has(root) && /^mem:\/[a-z]+\/$/.test(root)) ROOTS.set(root, this);
  }
  sub(prefix) {
    const pre = normPath(prefix) + '/';
    const lower = pre.toLowerCase();
    const real = this.files.find(f => f.path.toLowerCase().startsWith(lower));
    const realPre = real ? real.path.slice(0, pre.length) : pre;
    const list = this.files.filter(f => f.path.toLowerCase().startsWith(lower)).map(f => [f.path.slice(pre.length), f.size, f.w, f.h]);
    return new MemFiles(p => this._get(realPre + p), list, this.root + realPre);
  }
  async bytes(p) {
    const r = this.resolve(p);
    if (r === null) throw new Error(`sumika: no such file ${p}`);
    const b = this._get(r);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}

function pngSize(b) {
  return b.length > 24 && b.readUInt32BE(12) === 0x49484452 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : [undefined, undefined];
}

/** {files: MemFiles, raw: Map(path -> () => Buffer)} for an archive or a folder; the ghost root is where ghost/master/descript.txt is. */
function loadGhost(src) {
  const all = new Map();       // path inside the source -> reader
  if (fs.statSync(src).isDirectory()) {
    (function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, rel + e.name + '/');
        else all.set(rel + e.name, { size: fs.statSync(p).size, read: () => fs.readFileSync(p) });
      }
    })(src, '');
  } else {
    for (const e of openZip(src).entries) all.set(e.name, e);
  }
  const desc = [...all.keys()].filter(n => /(^|\/)ghost\/master\/descript\.txt$/i.test(n)).sort((a, b) => a.length - b.length)[0];
  if (!desc) throw new Error('no ghost/master/descript.txt');
  const prefix = desc.slice(0, desc.length - 'ghost/master/descript.txt'.length);
  const cache = new Map();
  const get = p => {
    let b = cache.get(p);
    if (!b) { b = all.get(prefix + p).read(); cache.set(p, b); }
    return b;
  };
  const list = [];
  for (const [n, e] of all) {
    if (!n.startsWith(prefix)) continue;
    const rel = n.slice(prefix.length);
    if (/\.png$/i.test(rel)) {
      let w, h;
      try { [w, h] = pngSize(get(rel)); } catch (err) { /* unreadable: no size */ }
      list.push([rel, e.size, w, h]);
    } else list.push([rel, e.size]);
  }
  return new MemFiles(get, list);
}

function diskFiles(dir) {
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + '/');
      else if (/\.png$/i.test(e.name)) { const [w, h] = pngSize(fs.readFileSync(p)); list.push([rel + e.name, fs.statSync(p).size, w, h]); }
      else list.push([rel + e.name, fs.statSync(p).size]);
    }
  })(dir, '');
  return new MemFiles(p => fs.readFileSync(path.join(dir, p)), list, 'mem:/site/');
}

// ---------------------------------------------------------------- clock

/** Fake time for the event loop (setTimeout), the player (setTimer) and the stage (requestFrame). */
class SweepClock {
  constructor(t) { this.t = t; this.q = []; this.seq = 0; this.hold = null; }
  now() { return this.t; }
  /**
   * One ms on without running timers: a root engine's files are stamped at the time of its mount; while the clock stands
   * on that ms, SspRootShiori counts every mounted file as just written (`_hot`: stamp >= now) and hashes the whole root
   * at each request. In a browser time moves on by itself; a fixed clock moves past the mount here (after the first
   * report's scan, which still compares the load's writes against the digests taken before it).
   */
  stepPastMount() { if (CLOCK.fixed) this.t += 1; }
  setTimeout(fn, ms) { const id = ++this.seq; this.q.push({ id, at: this.t + Math.max(0, Number(ms) || 0), fn }); return id; }
  clearTimeout(id) { const i = this.q.findIndex(x => x.id === id); if (i >= 0) this.q.splice(i, 1); }
  setTimer(fn, ms) { return this.setTimeout(fn, ms); }
  clearTimer(id) { this.clearTimeout(id); }
  requestFrame(fn) { return this.setTimeout(() => fn(this.t), FRAME_MS); }
  async advance(ms) {
    // a SHIORI reload under way (InProcessShiori.gate): the walk's time waits for the new engine, as a page's would not
    // move on while the engine answers nothing
    for (let g = this.hold && this.hold(); g; g = this.hold && this.hold()) await g.catch(() => {});
    const end = this.t + ms;
    for (;;) {
      await settle();
      let best = -1;
      for (let i = 0; i < this.q.length; i++) {
        const x = this.q[i];
        if (best < 0 || x.at < this.q[best].at || (x.at === this.q[best].at && x.id < this.q[best].id)) best = i;
      }
      if (best < 0 || this.q[best].at > end) break;
      const n = this.q.splice(best, 1)[0];
      this.t = Math.max(this.t, n.at);
      try { n.fn(); } catch (e) { logs.push({ level: 'error', phase, msg: 'timer: ' + fmt([e]).slice(0, 800) }); }
    }
    this.t = end;
    await settle();
  }
}
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

/**
 * YAYA reads the time itself (the templates' random talk waits for `GETSECCOUNT() - SHIORI3FW.LastAITalkTime`; MEMFS
 * mtimes), so from here a YAYA ghost's clocks (Date.now, performance.now) run with the sweep's fake clock, on from the
 * real time now; a Kawari ghost's too (`date`, `time()`: KEEPS times talk with them [infer], kawari-wasm.md §15). The
 * sweep's own timings keep the real clock (realNow). Satori counts OnSecondChange itself: untouched. --clock real
 * only (the earlier sweep's clocks); a fixed clock (the default) is fixProcessClock's from the engine's boot on, for
 * every engine, Satori too, from the fixed date (`new Date()` included, which this leaves real).
 */
function followClock(clock) {
  const base = realNow();
  const perf = performance.now();
  const t0 = clock.now();
  Date.now = () => base + (clock.now() - t0);
  performance.now = () => perf + (clock.now() - t0);
}

/**
 * A root engine's own timings (engine.timing: report.engineTiming, the Kawari table's load ms) read performance.now,
 * which stands still under a fixed clock: there they are taken again on the real clock, around its boot (module) and
 * around the load the adapter times (Kawari, Kawari 7: _load; YAYA: callLoad; the first of each init), as the adapter
 * takes them. The engine as it was with --clock real, or without a timing (Satori).
 */
function realTimings(engine) {
  if (!CLOCK.fixed || !engine.timing) return engine;
  const loadName = typeof engine._load === 'function' ? '_load' : 'callLoad';
  const { boot, init } = engine;
  const load = engine[loadName];
  let first = null;
  engine[loadName] = function (...a) {
    const t = realPerf();
    try { return load.apply(this, a); } finally { if (first === null) first = realPerf() - t; }
  };
  engine.boot = async function (...a) {
    const t = realPerf();
    const r = await boot.apply(this, a);
    this.timing.module = realPerf() - t;
    return r;
  };
  engine.init = function (...a) {
    first = null;
    const r = init.apply(this, a);
    if (first !== null) this.timing.load = first;
    return r;
  };
  return engine;
}

// ---------------------------------------------------------------- engine

class NodeSatori extends SatoriEngine {
  async factory() { return loadEngineFactory('satori'); }
}

class NodeYaya extends YayaEngine {
  async factory() { return loadEngineFactory('yaya'); }
}

class NodeKawari extends KawariEngine {
  async factory() { return loadEngineFactory('kawari'); }
}

class NodeKawari7 extends Kawari7Engine {
  async factory() { return loadEngineFactory('kawari7'); }
}

/**
 * The version of the Kawari DLL descript's `shiori` names: its VERSIONINFO, else its `KAWARI.k…/x.y.z` string; the
 * corpus' DLLs are UPX-packed and show neither (kawari-wasm.md §1), so then `UPX-packed`. '' without the DLL.
 */
async function kawariDllVersion(files, shiori) {
  const name = String(shiori || '').replace(/\\/g, '/').split('/').pop() || 'shiori.dll';
  const p = files.resolve(`ghost/master/${name}`);
  if (!p) return '';
  const b = Buffer.from(await files.bytes(p));
  const m = /KAWARI\.k[\w.]*\/\d+(\.\d+)+/.exec(b.toString('latin1'));
  return fileVersion(b) || (m ? m[0] : b.includes('UPX!') ? 'UPX-packed' : '?');
}

/** The stored files after an engine's report, as worker.js mergeFiles: false forgets the key, null / bytes set it. */
function mergeFiles(prev, files) {
  const out = { ...prev };
  for (const [p, v] of Object.entries(files || {})) {
    if (v === false) delete out[p];
    else out[p] = v;
  }
  return out;
}

/** VS_VERSIONINFO's FileVersion: the UTF-16LE string after the key "FileVersion\0" and its padding ('' if none). */
function fileVersion(buf) {
  const key = Buffer.from('FileVersion\0', 'utf16le');
  for (let i = buf.indexOf(key); i >= 0; i = buf.indexOf(key, i + 2)) {
    let p = i + key.length;
    while (p + 1 < buf.length && buf[p] === 0 && buf[p + 1] === 0) p += 2;
    let s = '';
    for (; p + 1 < buf.length && s.length < 48; p += 2) {
      const c = buf.readUInt16LE(p);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    if (/^\d/.test(s)) return s.trim();
  }
  return '';
}

/** YAYA's save as variable name -> its line (`name,value,"delimiter",`); null when it cannot be read as text. */
function saveVars(bytes) {
  if (!bytes) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const vars = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('//')) continue;
    const c = line.indexOf(',');
    if (c > 0) vars.set(line.slice(0, c), line);
  }
  return vars;
}

class InProcessShiori {
  /** track: keep a worker-like store (worker.js storeChanged) of every report, after init and each request (YAYA) */
  constructor(engine, { track = false } = {}) {
    this.engine = engine;
    this.base = { ...BASE_HEADERS };
    this.dead = false;
    this.track = track;
    this.stored = track ? mergeFiles({}, engine.changedFiles()) : {};
    this.ghostDir = engine.ghostDir;
    this.gate = null;         // a SHIORI reload under way: requests wait for it
  }
  /** the worker's 'write' / 'read' (\![execute,http-*], EV §4.15) */
  async writeFile(rel, data) {
    const full = this.engine.writeMasterFile(rel, data);
    if (this.track) this.keep(this.engine.changedFiles());
    return full;
  }
  async readFile(rel) {
    const b = personalFile(rel) ? null : this.engine.readMasterFile(rel);
    return b ? new Uint8Array(b) : null;
  }
  async request(r) {
    // a SHIORI reload under way (\![reload,shiori], EV §2.10): what was asked after it waits for the new engine, as in
    // ShioriClient's queue
    if (this.gate) await this.gate.catch(() => {});
    const key = `${r.method || 'GET'} ${r.id}`;
    if (this.dead) return { status: 500, headers: new Map(), value: null };
    const w = realNow();
    let res;
    try {
      // the page's FMO text (Satori P8), as ShioriClient and the worker apply it: the sweep sees what a browser does
      const fmo = typeof r.fmo === 'function' && this.engine.setFmo ? r.fmo() : null;
      if (typeof fmo === 'string') this.engine.setFmo(fmo);
      // the call's kind and self, as worker.js passes them (Kawari 7's SHIORI/2.x bridge)
      res = parseResponse(this.engine.request(buildRequest(r, this.base), { kind: r.kind || '', self: r.self || '' }));
    } catch (e) {
      report.crashed = report.crashed || { phase, error: fmt([e]).slice(0, 1500) };
      res = { status: 500, headers: new Map(), value: null };
    }
    if (report.crashed) { this.dead = true; report.crashed.request = report.crashed.request || key; }
    const run = report.runaway && report.runaway[report.runaway.length - 1];
    if (run && !run.request) Object.assign(run, { request: key, ref0: String((r.refs || [])[0] ?? '').slice(0, 40) });
    // the worker's scan for changed files after each request, timed with it as worker.js times it (a root engine
    // scans only after a request that wrote)
    if (this.track && !this.dead) this.keep(this.engine.changedFiles());
    const ms = realNow() - w;
    if (TRACE && !/OnSecondChange|OnSurfaceChange|OnMouseMove/.test(r.id)) process.stderr.write(`${phase} ${key} ${(r.refs || []).slice(0, 5).map(x => String(x).slice(0, 30)).join('|')} -> ${res.status} ${String(res.value || '').slice(0, 100)}
`);
    const k = `${key} ${res.status}`;
    report.requests[k] = (report.requests[k] || 0) + 1;
    if (!report.slowest || ms > report.slowest.ms) report.slowest = { request: key, ms, phase };
    if (ms > 300) report.slow.push({ request: key, ms, phase });
    const err = res.headers.get('errordescription');
    if (err || res.status >= 400) report.errors.push({ phase, request: key, refs: (r.refs || []).slice(0, 3).map(x => String(x).slice(0, 60)), status: res.status, error: (err || '').replace(/\x01/g, ' | ').slice(0, 500) });
    return res;
  }
  keep(files) {
    if (this.track) this.stored = mergeFiles(this.stored, files);
    return files;
  }
  async unload() { return this.keep(this.engine.unload()); }
  async persist() { this.engine.save(); return this.keep(this.engine.changedFiles()); }
  terminate() {}
}

// ---------------------------------------------------------------- dialogs (answered by the "visitor")

const ANSWERS = { text: 'テスト', password: 'pass', date: '2000,1,1', time: '12,0,0', slider: '50', ip: '127.0.0.1' };
class AutoDialogs {
  constructor(clock) { this.clock = clock; this.anyOpen = false; }
  inputBox(o) {
    report.boxes.push({ phase, kind: o.kind || 'text', id: String(o.id || '').slice(0, 60) });
    return new Promise(r => this.clock.setTimeout(() => r({ text: ANSWERS[o.kind] ?? 'テスト', timedOut: false }), 1500));
  }
  communicateBox(o) {
    report.boxes.push({ phase, kind: 'communicate' });
    return new Promise(r => this.clock.setTimeout(() => r({ text: 'こんにちは', timedOut: false }), 1500));
  }
  teachBox(o) {
    report.boxes.push({ phase, kind: 'teach' });
    return new Promise(r => this.clock.setTimeout(() => r({ text: 'テスト', timedOut: false }), 1500));
  }
  close() {}
  closeCommunicate() {}
}

// ---------------------------------------------------------------- script analysis

function tagKey(t) {
  if (t.type === 'text') return null;
  if (t.name === '!' || t.name === '![') {
    const a = t.args || [];
    const c = String(a[0] ?? '').trim().toLowerCase();
    const withSub = new Set(['set', 'open', 'close', 'change', 'get', 'anim', 'enter', 'leave', 'execute', 'sound', 'call', 'effect', 'filter', 'reload']);
    return '\\![' + c + (withSub.has(c) && a[1] != null ? ',' + String(a[1]).trim().toLowerCase() : '') + ']';
  }
  return '\\' + (t.name || t.type);
}

/** Choices and anchors of a script: [{kind, id, refs, label, script?}], References and jump IDs as the player has them */
function linksOf(script) {
  const out = [];
  let open = null;
  const withJump = l => {
    const j = jumpString(l.id, l.refs);
    if (j !== null && /^script:/i.test(j)) l.script = j.slice(7);
    return l;
  };
  for (const t of tokenize(script)) {
    if (t.type === 'text') { if (open) open.label += t.text || ''; continue; }
    if (t.unterminated) break;                    // SSP drops it and the rest of the script (SS §3.4)
    const a = t.args;
    if (t.name === 'q' && a) {
      if (t.form === 'bracket2') out.push({ kind: 'choice', id: a[0] ?? '', label: a[1] ?? '', refs: [] });
      else out.push(withJump({ kind: 'choice', id: a[1] ?? '', label: a[0] ?? '', refs: refList(a, 2) }));
    } else if ((t.name === '__q' || t.name === '_a') && a) {
      open = withJump({ kind: t.name === '_a' ? 'anchor' : 'choice', id: a[0] ?? '', refs: refList(a, 1), label: '' });
      out.push(open);
    } else if (t.name === '__q' || t.name === '_a') open = null;
  }
  return out.filter(l => String(l.id).trim() !== '');
}

// ---------------------------------------------------------------- resume check (YAYA)

/**
 * D1 on a real ghost (yaya-wasm.md, resume): save now (the worker's saveNow) and resume a fresh engine from the files
 * stored so far with this engine's volatile state, as the next page does; then compare the two saves line by line.
 * `changed` lists the saved variables whose line differs: a load-time effect the second restore does not undo
 * (expected: none); `added` the variables only load made, which keep load's value (by design, yaya-wasm.md resume).
 * Then the same resume after a site update (a comment line appended to one shipped dictionary) must load as after an
 * update and answer `version` as this engine does (`stampReload`). Neither extra engine is unloaded.
 */
async function resumeCheck({ engine, shiori, efiles, module, newYaya, bootEpochMs }) {
  await shiori.persist();
  const vol = engine.getVolatileState();
  const lower = `ghost/master/${module}_variable.cfg`.toLowerCase();
  const read = (e, p) => {
    try { const u8 = e.M.FS.readFile(e.ghostRoot + p); return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); } catch (err) { return null; }
  };
  const key = [...engine.scan().keys()].find(k => k.toLowerCase() === lower || k.toLowerCase() === lower + '.ays') || null;
  // every stored file (and the save) as the engine holds it now: the store should already be so (the reports check the
  // bytes of a file written in the frozen fake millisecond); this keeps a miss there from hiding as a resume difference
  const stored = Object.fromEntries(Object.entries(shiori.stored).map(([p, v]) => [p, v ? read(engine, p) || v : v]));
  if (key) stored[key] = read(engine, key);
  const out = { status: null, save: key, changed: null, added: null, diff: [], stampReload: null };
  const resume = Object.values(stored).some(v => v);       // worker.js: a resume needs a save (hasSave)
  const next = newYaya(() => {});
  await next.boot();
  const ok = next.init(efiles, stored, { resume, bootEpochMs, volatile: vol });
  out.status = next.status;
  if (ok && key && !/\.ays$/i.test(key)) {
    next.save();
    const a = saveVars(read(engine, key));
    const b = saveVars(read(next, key));
    if (a && b) {
      // changed: a saved value the resume did not bring back; added: a variable only load made (it keeps load's value)
      out.changed = [...a.keys()].filter(n => a.get(n) !== b.get(n));
      out.added = [...b.keys()].filter(n => !a.has(n));
      out.diff = [...out.changed, ...out.added].slice(0, 8)
        .map(n => ({ name: n, before: (a.get(n) || '').slice(0, 160), after: (b.get(n) || '').slice(0, 160) }));
    }
  }
  // a site update between the save and the next page
  const target = efiles.find(f => /^ghost\/master\/.+\.dic$/i.test(f.path)) || efiles.find(f => f.path.toLowerCase() === `ghost/master/${module.toLowerCase()}.txt`);
  if (target) {
    const add = new TextEncoder().encode('\r\n// sumika sweep: a site update\r\n');
    const data = new Uint8Array(target.data.byteLength + add.length);
    data.set(new Uint8Array(target.data), 0);
    data.set(add, target.data.byteLength);
    const lines = [];
    const updated = newYaya((level, msg) => lines.push([level, String(msg)]));
    await updated.boot();
    const ok2 = updated.init(efiles.map(f => (f === target ? { path: f.path, data: data.buffer } : f)), stored, { resume: true, bootEpochMs, volatile: vol });
    const logged = lines.some(([level, msg]) => level === 'info' && msg === STAMP_CHANGED);
    const ask = async e => (e === engine ? shiori.request({ method: 'GET', id: 'version' })
      : parseResponse(e.request(buildRequest({ method: 'GET', id: 'version' }, shiori.base))));
    const v = ok2 ? await ask(updated) : null;
    const before = await ask(engine);       // some old templates have no `version` (204): the same answer will do
    out.stampReload = {
      ok: logged && ok2 && !!v && v.status === before.status && v.status < 300, logged, status: updated.status, dic: target.path,
      version: v ? `${v.status} ${v.value || ''}`.slice(0, 80) : null,
    };
  }
  return out;
}

// ---------------------------------------------------------------- resume check (Kawari)

const sjis = new TextDecoder('shift_jis');
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));

/**
 * Every entry of a running Kawari engine (_kawari_snapshot(path, 1), K12; System.Request*, System.Response* and
 * write-protected entries left out) as name -> its words (parseKawariDump: adjacent literals joined, `# move` names
 * under their own). null when the engine cannot write it.
 */
function kawariDump(e) {
  const k7 = e instanceof Kawari7Engine;       // Kawari 7: _kawari7_dump, its snapshot's format (parseK7Dump)
  let n = -1;
  try { n = e._withPath(KAWARI_DUMP, p => (k7 ? e.M._kawari7_dump(p) : e.M._kawari_snapshot(p, 1))); } catch (err) { return null; }
  if (n < 0) return null;
  const text = n > 0 ? sjis.decode(e.M.FS.readFile(KAWARI_DUMP)) : '';
  return k7 ? parseK7Dump(text) : parseKawariDump(text);
}

/**
 * The resume check for Kawari (kawari-wasm.md §8, §15). Kawari's state is its dictionary: after the run, save (the
 * worker's saveNow: a snapshot of the entries this session changed and those its load made, under RESUME_KEY) and dump
 * every entry (A); resume a fresh engine from the stored files as the next page does and dump it (B). Each entry where
 * B differs from A is one of: `changed`, an entry of the snapshot (expected: none); `missed`, an entry the session
 * changed (A differs from `base`, the dump right after this engine's load) that the snapshot did not carry (expected:
 * none; an entry the session write-protected is left out of the snapshot and of every dump); `loadSet`, an entry the
 * session left as load made it, which the next load makes otherwise (since the snapshot carries what load's scripts
 * wrote, only a definition load read from a file the session rewrote, or a dictionary a load script picked otherwise).
 * Then a resume after a site update (a comment line appended to kawarirc.kis) must load cold, drop the snapshot and
 * answer `version` as this engine does (`stampReload`). Then D6 [decision: kawari-wasm.md §16]: the session ends here
 * without an unload, so a cold boot from the same store a day later closes it first, on a clock from the session's end
 * (`sessionEndMs`; `d6At`); the files its close from outside and its OnUnload write must equal what B's own close from
 * outside (`closeFromOutside`, ssp.exe's end of session) and unload write (the session's values, time stamps
 * included), and that boot's OnBoot is asked (`d6`, its `outcome` by d6Outcome: `no effect` when the session's own
 * close and unload write nothing, as a ghost that saves nothing when it closes). The run's own store is not touched.
 * @param {{engine: KawariEngine, shiori: InProcessShiori, efiles: {path: string, data: ArrayBuffer}[],
 *   newKawari: Function, save: Function, base: Map<string, string>|null, shell: string}} o save: the worker's save
 *   (timed, its report kept)
 */
async function kawariResumeCheck({ engine, shiori, efiles, newKawari, save, base, shell }) {
  const RESUME_KEY = engine.resumeKey;         // Phase 8's or Kawari 7's
  save();
  const vol = engine.getVolatileState();
  const read = (e, p) => {
    try { const u8 = e.M.FS.readFile(e.ghostRoot + p); return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); } catch (err) { return null; }
  };
  // every stored file as the engine holds it now (as resumeCheck), and the snapshot key as stored
  const stored = Object.fromEntries(Object.entries(shiori.stored)
    .map(([p, v]) => [p, v && p !== RESUME_KEY ? read(engine, p) || v : v]));
  const snap = stored[RESUME_KEY];
  const names = engine instanceof Kawari7Engine ? k7SnapshotNames(snap) : snapshotNames(snap);
  const out = {
    snapshot: { bytes: snap ? snap.byteLength : null, entries: names.size }, restored: null, resumeMs: null, entries: null,
    changed: null, missed: null, loadSet: null, diff: [], stampReload: null, d6: null,
  };
  const A = kawariDump(engine);
  out.entries = A ? A.size : null;
  const next = newKawari(() => {});
  await next.boot();
  let t = realNow();
  const ok = next.init(efiles, stored, { resume: Object.values(stored).some(v => v), volatile: vol });    // worker.js hasSave
  out.resumeMs = Math.round(realNow() - t);
  out.restored = ok ? next.resumed || 'nothing to restore' : 'boot failed';
  const B = ok ? kawariDump(next) : null;
  if (A && B && base) {
    Object.assign(out, classifyResume({ base, before: A, after: B, names }));
    out.diff = [...out.changed, ...out.missed, ...out.loadSet].slice(0, 8).map(n => ({
      name: n.slice(0, 80), load: String(base.get(n) ?? '(none)').slice(0, 160), before: String(A.get(n) ?? '(none)').slice(0, 160),
      after: String(B.get(n) ?? '(none)').slice(0, 160),
    }));
  }
  const ask = async e => (e === engine ? shiori.request({ method: 'GET', id: 'version', kind: 'resource' })
    : parseResponse(e.request(buildRequest({ method: 'GET', id: 'version' }, shiori.base), { kind: 'resource' })));
  // a site update between the save and the next page (a comment line in kawarirc.kis; Kawari 7's kawari.ini)
  const target = efiles.find(f => f.path.toLowerCase() === `ghost/master/${engine.rcFile}`);
  if (target) {
    const add = new TextEncoder().encode('\r\n# sumika sweep: a site update\r\n');
    const data = new Uint8Array(target.data.byteLength + add.length);
    data.set(new Uint8Array(target.data), 0);
    data.set(add, target.data.byteLength);
    const lines = [];
    const updated = newKawari((level, msg) => lines.push([level, String(msg)]));
    await updated.boot();
    const ok2 = updated.init(efiles.map(f => (f === target ? { path: f.path, data: data.buffer } : f)), stored, { resume: true, volatile: vol });
    const logged = lines.some(([level, msg]) => level === 'info' && msg === STAMP_CHANGED);
    const v = ok2 ? await ask(updated) : null;
    const before = await ask(engine);
    const dropped = updated.resumed === (snap && snap.byteLength ? 'dropped' : '');
    out.stampReload = {
      ok: logged && ok2 && dropped && !!v && v.status === before.status && v.status < 300, logged, resumed: updated.resumed,
      dic: target.path, version: v ? `${v.status} ${v.value || ''}`.slice(0, 80) : null,
    };
  }
  // D6: the files the session's own end writes (B, restored: its load's writes reported first; then the close ssp.exe
  // sends when Windows ends the session, and its unload), against the files a cold boot from the same store writes
  // while it closes and finishes the session. Without a snapshot (nothing changed since load) D6 does not run, and
  // there is nothing to finish.
  if (ok) {
    next.changedFiles();
    const tc = realNow();
    const tEnd = Date.now();                       // the session ends here (the page's savedAt: kawari-wasm.md §8)
    const close = next.closeFromOutside();
    const closeMs = Math.round(realNow() - tc);    // the engine's own clock() follows the fake clock here
    const own = Object.entries(next.unload()).filter(([p, v]) => p !== RESUME_KEY && v instanceof ArrayBuffer);
    const later = newKawari(() => {});
    await later.boot();
    // the visitor comes back a day later: D6 closes the session on a clock from its end (sessionEndMs), so a ghost
    // that stamps its close or unload with the time (the BTH family, KEEPS) writes what B's own close wrote; the cold
    // load and OnBoot run a day on. The day starts at D6's restore, after init's first load: that load seeds Kawari's
    // random numbers from the clock (SRandom(time(NULL)), kawari_shiori.cpp:91), and only B's seed makes the two closes
    // draw alike (brynhild_conf1.13's goodbye saves a reward with a random part, `number3`, in dict-cr.txt; a day
    // jump before init made it differ). The sweep's clock comes back after
    const f = Date.now;
    const restore = later._restore;
    later._restore = function (...a) { Date.now = () => f() + 864e5; return restore.apply(this, a); };
    let ok3, ms, first, boot;
    try {
      t = realNow();
      ok3 = later.init(efiles, stored, { resume: false, sessionEndMs: tEnd });
      ms = Math.round(realNow() - t);
      first = ok3 ? later.changedFiles() : {};
      boot = ok3 ? parseResponse(later.request(buildRequest({ method: 'GET', id: 'OnBoot', refs: [shell] }, shiori.base))) : null;
    } finally {
      Date.now = f;
      delete later._restore;
    }
    const finish = !!(snap && snap.byteLength);
    const differ = !finish ? []
      : own.filter(([p, v]) => !(first[p] instanceof ArrayBuffer && sameBytes(v, first[p]))).map(([p]) => p);
    const saves = own.map(([p]) => p);
    const outcome = d6Outcome({ booted: ok3, finish, resumed: later.resumed, saves, differ });
    out.d6 = {
      ok: outcome === 'ok' || outcome === 'nothing to finish', outcome, resumed: later.resumed, ms, d6At: later.d6At,
      saves, differ, wrote: Object.keys(first).filter(p => p !== RESUME_KEY), onBoot: boot ? boot.status : null,
      // what D6's close got (none when it sent none); what B's own close got and its wall time
      close: later.d6Close ? later.d6Close.steps.map(s => `${s.id} ${s.status}`).join(', ') : '',
      ownClose: close.steps.map(s => `${s.id} ${s.status}`).join(', '), closeMs,
    };
  }
  return out;
}

// ---------------------------------------------------------------- run

async function main() {
  if (!SRC) throw new Error('usage: node tools/sweep/ghost.mjs <archive or ghost folder>');
  const files = loadGhost(SRC);
  const id = path.basename(SRC).replace(/\.(nar|zip)$/i, '').replace(/[^\w.-]+/g, '_') || 'ghost';
  const { entry: ghost, descript } = await ghostEntry(files, id);
  Object.assign(report, { id, name: ghost.name, sakura: ghost.sakuraName, kero: ghost.keroName, craftman: ghost.craftman, shiori: ghost.shiori,
    charset: descript.get('charset') || '', shells: ghost.shells.length, ownBalloon: ghost.bundledBalloons.length > 0 });
  // the engine as tools/sweep.mjs decided it (sweepEngine); the index entry keeps the site's rule
  const dlls = files.list('ghost/master').filter(p => /\.dll$/i.test(p)).map(p => path.posix.basename(p).toLowerCase());
  const chosen = await sweepEngine(files, descript, dlls);
  Object.assign(report, { engine: chosen.engine, module: chosen.module, engineBy: chosen.by, indexEngine: ghost.engine, indexModule: ghost.module });
  const yaya = chosen.engine === 'yaya';
  const k7 = chosen.engine === 'kawari7';
  const kawari = chosen.engine === 'kawari' || k7;
  const root = yaya || kawari;      // the whole ghost root in an SSP-like MEMFS (ssproot.js), a worker-like store
  if (!root && chosen.engine !== 'satori') throw new Error(`no engine for SHIORI "${chosen.engine}" in the sweep`);
  const dll = files.list('ghost/master').find(p => /\/satori\.dll$/i.test(p));
  if (dll) {
    const m = /Mc\d+-\d+|phase [!-~]{2,24}/.exec(Buffer.from(await files.bytes(dll)).toString('latin1'));
    report.satoriDll = m ? m[0] : '?';
  }
  if (yaya) {
    const own = files.resolve(`ghost/master/${chosen.module}.dll`);
    report.engineDll = own ? fileVersion(Buffer.from(await files.bytes(own))) || '?' : '';
  } else if (kawari) report.engineDll = await kawariDllVersion(files, ghost.shiori);
  else report.engineDll = report.satoriDll;
  // Satori: engineFileList (ghost/master-relative); YAYA and Kawari: the whole ghost root, text with bytes
  const rplan = yaya ? yayaFilePlan(files) : kawari ? kawariFilePlan(files, k7 ? KAWARI7_TEXT : undefined) : null;
  const engineList = root ? rplan.bytes : engineFileList(files);
  const dicRule = yaya ? /\.(dic|aym|ayc)$/i : k7 ? KAWARI7_DIC : kawari ? KAWARI_DIC : /(^|\/)dic[^/]*\.txt$|\.sat$/i;
  report.dicFiles = engineList.filter(p => dicRule.test(p)).length;
  report.encrypted = kawari ? 0 : engineList.filter(p => (yaya ? /\.ayc$/i : /\.sat$/i).test(p)).length;

  // the engine, as the worker runs it
  report.stage = 'engine';
  phase = 'engine';
  // the sweep's clock (the page side's from the shell stage on); under a fixed clock (the default) the whole process
  // follows it from here, so the engine loads at the fixed time too (tools/sweep/clock.mjs)
  const clock = pageClock = new SweepClock(CLOCK.start);
  if (CLOCK.fixed) fixProcessClock(clock);
  const saoriLoads = [];
  const origLoad = saoriBridge.load.bind(saoriBridge);
  saoriBridge.load = (p, dir) => {
    const h = origLoad(p, dir);
    const name = String(p).replace(/\\/g, '/').split('/').pop().toLowerCase();
    // once per name: Kawari tries a SAORI without a stand-in again at each call (saori.cpp)
    if (!saoriLoads.some(s => s.name === name)) saoriLoads.push({ name, standIn: !!standIns[name], handle: h });
    return h;
  };
  // what the page would play: SAORI music (dsaudio, the MCI players) and \_v / \![sound] files, found in the archive or not
  const media = (kind, path) => {
    const p = String(path == null ? '' : path);
    if (!p || report.media.length >= 60) return;
    report.media.push({ phase, kind, path: p.slice(0, 120), found: !!resolveGhostPath(files, p), drop: /^c:\\sumika\\drop\\/i.test(p) });
  };
  saoriBridge.notifyPage = (name, cmd, args) => { if (cmd === 'load') media(String(name).replace(/\.dll$/i, ''), args[0]); };
  saoriBridge.log = (lvl, msg) => logs.push({ level: lvl, phase, msg: 'saori: ' + String(msg).slice(0, 500) });
  const engineLog = (lvl, msg) => {
    msg = String(msg);
    logs.push({ level: lvl, phase, msg: 'engine: ' + msg.slice(0, 800) });
    if (!/^(request|load): /.test(msg) || lvl !== 'error' || report.crashed) return;
    // Kawari: a runaway recursion's RangeError answers 500 and the engine lives (the stack guard puts the stack pointer
    // back: kawari-wasm.md D8); recorded, the request added by InProcessShiori
    if (kawari && /^request: RangeError/.test(msg)) {
      report.runaway = report.runaway || [];
      if (report.runaway.length < 20) report.runaway.push({ phase, error: msg.slice(0, 300) });
      return;
    }
    // the adapter answers 500 when the WASM call throws (an abort): the module is dead from here on
    report.crashed = { phase, error: msg.slice(0, 1500) };
  };
  // Kawari: its counts (report.kawari: entries, load, the log lines by phase and kind, the worker's saves, heap)
  if (kawari) report.kawari = { entries: null, log: {}, saves: { n: 0, maxMs: 0, totalMs: 0, maxBytes: 0 }, heapMB: null };
  const kawariLines = new Map();       // Kawari's log lines without file and line -> their report.engineLog entry
  let kawariBase = null;               // Kawari: every entry right after the engine's load (kawariDump), for the resume check
  // YAYA: its own fatal / error / warning / note lines (info lines only count); Kawari: its error / warning / log lines,
  // each once with a count (a ghost's parse errors repeat), every one counted by phase and kind
  const onEngineLog = l => {
    if (l.mode === 'info') { report.engineInfoLines = (report.engineInfoLines || 0) + 1; return; }
    if (kawari) {
      const k = `${phase} ${l.mode}`;
      report.kawari.log[k] = (report.kawari.log[k] || 0) + 1;
      const text = kawariLogText(l.text);
      const seen = kawariLines.get(`${l.mode} ${text}`);
      if (seen) seen.n++;
      else if (report.engineLog.length < ENGINE_LOG_MAX) {
        const e = { phase, mode: l.mode, text: text.slice(0, 400), n: 1 };
        kawariLines.set(`${l.mode} ${text}`, e);
        report.engineLog.push(e);
      }
      return;
    }
    if (report.engineLog.length < ENGINE_LOG_MAX) report.engineLog.push({ phase, mode: l.mode, text: String(l.text).slice(0, 400) });
  };
  // what the page's worker gets as engineOpts
  const rootOpts = root ? {
    ...(yaya ? { module: chosen.module } : {}), ghostId: id, placeholders: rplan.placeholders,
    site: yayaSite({ ghosts: [ghost], balloons: [{ id: 'sumika' }] }), ...(yaya ? { lang: 'ja-JP' } : {}),
  } : null;
  const newYaya = log => realTimings(new NodeYaya({ engineUrl: engineJs('yaya'), log, saori: saoriBridge, opts: rootOpts, onEngineLog }));
  const newKawari = log => realTimings(k7 ? new NodeKawari7({ engineUrl: engineJs('kawari7'), log, saori: saoriBridge, opts: rootOpts, onEngineLog })
    : new NodeKawari({ engineUrl: engineJs('kawari'), log, saori: saoriBridge, opts: rootOpts, onEngineLog }));
  // `let`: a root engine unloaded by a close mid-run is replaced at the reboot (restartEngine)
  let engine = yaya ? newYaya(engineLog) : kawari ? newKawari(engineLog)
    : new NodeSatori({ engineUrl: engineJs('satori'), ghostDir: '/ghost/master/', log: engineLog, saori: saoriBridge });
  await engine.boot();
  const efiles = await Promise.all(engineList.map(async p => ({ path: p, data: (await files.bytes(root ? p : 'ghost/master/' + p)).slice(0) })));
  report.dicBytes = efiles.reduce((n, f) => n + f.data.byteLength, 0);
  if (kawari) report.encrypted = efiles.filter(f => KAWARI_CRYPT.test(Buffer.from(f.data).toString('latin1'))).length;
  const bootEpochMs = Date.now();         // GETTICKCOUNT: the ghost's age (its clock: fixProcessClock / followClock)
  const initRes = yaya ? engine.init(efiles, {}, { resume: false, bootEpochMs }) : engine.init(efiles, {}, { resume: false });
  report.engineInit = initRes;
  if (root) clock.stepPastMount();
  if (root) {
    if (yaya) report.loadStatus = engine.status;
    report.engineTiming = { module: Math.round(engine.timing.module || 0), load: Math.round(engine.timing.load || 0) };
    if (kawari) {
      report.kawari.entries = engine.entries;
      kawariBase = kawariDump(engine);
    }
    // the page fails the boot (yaya-wasm.md, boot failure; Kawari without kawarirc.kis, kawari-wasm.md §9): a finding
    // about the ghost's files, not a runner failure; nothing more to play with (engineLog and logs say why)
    if (!initRes) {
      report.loadFailed = yaya ? `status ${engine.status} (${LOAD_STATUS[engine.status] || '?'})`
        : (logs.filter(l => /^(warn|error)$/.test(l.level) && l.msg.startsWith('engine: ')).pop() || { msg: 'init failed' }).msg;
      mark('engine');
      return;
    }
  }
  mark('engine');

  // the stage and the balloon
  report.stage = 'shell';
  phase = 'shell';
  if (root && !CLOCK.fixed) followClock(clock);     // --clock real: the root engines from the real time now on
  const decode = async b => decodePng(new Uint8Array(b));
  // the shell a visitor who never picked one boots (defaultShellId, EV §2.6); `let`: a shell change replaces it
  let stage = await Stage.create({ files, shellId: ghost.defaultShell || 'master', ghostDescript: descript, dom: false, decode, clock });
  report.shell = stage.shellId;
  const site = { ghosts: [ghost], balloons: [{ id: 'sumika', name: 'Sumika' }], defaultBalloon: 'sumika', ghost: g => (g === ghost.id ? ghost : null), balloon: b => (b === 'sumika' ? { id: b, name: 'Sumika' } : null) };
  let siteBalloon = null;
  /** a BalloonSkin for an installedBalloons() entry: the ghost's own bundled one, else the site's `sumika` */
  const loadSkin = async e => (e && e.ghost === ghost.id ? BalloonSkin.load(files.sub(e.id)) : BalloonSkin.load(siteBalloon || (siteBalloon = diskFiles(SITE_BALLOON))));
  phase = 'balloon';
  const pick = chooseBalloon(site, ghost, { ghostDescript: descript });    // the runtime's boot rule (BA §1.6)
  const balloonEntry = pick ? pick.entry : { id: 'sumika', name: 'Sumika' };
  let skin = await loadSkin(balloonEntry);
  const balloonName = balloonEntry.name || balloonEntry.id;
  report.balloon = balloonName;
  showDefaultCharacters(stage);
  stage.tick(clock.now());
  mark('shell');

  const balloons = await Balloons.create({ skin, stage, ghostFiles: files, ghostDescript: descript, root: null });
  const dialogs = new AutoDialogs(clock);
  const storage = memoryStorage();
  const state = new StateStore(id, { storage, clock });
  const language = new UiLanguage({ storage, navigator: { language: 'ja-JP', languages: ['ja-JP'] } });
  const shiori = new InProcessShiori(engine, { track: root });
  clock.hold = () => shiori.gate;
  /** Kawari: the worker's save (its snapshot, kawari-wasm.md §8), timed, and its report kept as worker.js does */
  const kawariSave = () => {
    const t = realNow();
    engine.save();
    const ms = realNow() - t;
    shiori.keep(engine.changedFiles());
    const s = report.kawari.saves;
    const snap = shiori.stored[engine.resumeKey];
    s.n++;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    s.maxBytes = Math.max(s.maxBytes, snap ? snap.byteLength : 0);
  };
  const audio = {
    sound(cmd, args) { if (String(cmd).toLowerCase() === 'play' || cmd === 'loop') media('sound', args && args[0]); },
    musicState() { return null; },
    resumeMusic() {},
  };
  // \![open,con…] (UI §2.13): the page rule of the Site's box (settingsPage), recorded; nothing is shown or typed
  const props = {
    openSettings: page => {
      const opens = settingsPage(page);
      if (report.settings.length < 40) report.settings.push({ phase, page: String(page).slice(0, 40), opens });
      return opens;
    },
  };
  const loop = new EventLoop({
    shiori, stage, balloons, dialogs, ghost, state, files, ghostDescript: descript, site, clock, language, audio,
    env: { win: null, doc: null }, balloonName, shell: { id: stage.shellId, name: shellName(ghost, stage.shellId) },
    paths: {
      site: '/', ghost: `/ghost/${id}/`, shell: `/ghost/${id}/shell/${stage.shellId}/`, balloon: balloonPath(balloonEntry),
    },
    fetch: sweepFetch, user: sweepUser, props, wordList: async () => WORD_LIST,
  });
  loop.unknownTag = raw => { if (report.unknownTags.length < 200) report.unknownTags.push({ phase, tag: String(raw).slice(0, 120) }); };
  // every property read (%property: '%', \![get,property]: 'get') and set, by name and whether it failed
  const countProp = (how, name, ok) => {
    const k = `${how} ${propKey(name)} ${ok ? 'ok' : 'fails'}`;
    if (k in report.properties || Object.keys(report.properties).length < 200) {
      report.properties[k] = (report.properties[k] || 0) + 1;
    }
  };
  const readProp = loop._property.bind(loop);
  loop._property = (name, how) => {
    const v = readProp(name, how);
    const note = x => { countProp(how, name, x != null); return x; };
    return v && typeof v.then === 'function' ? v.then(note) : note(v);
  };
  const writeProp = loop.setProperty.bind(loop);
  loop.setProperty = (name, value) => {
    const r = writeProp(name, value);
    const note = x => { countProp('set', name, x === true); return x; };
    return r && typeof r.then === 'function' ? r.then(note) : note(r);
  };
  const player = new ScriptPlayer({ stage, balloons, dialogs, host: loop, clock, viewport: () => ({ width: 1280, height: 720 }) });
  loop.setPlayer(player);
  // \![change,shell|balloon] (EV §2.6, BA §12): swapped like the runtime does, so the sweep exercises the real path
  loop.viewSwitcher = viewSwitcher({
    loop, ghost, ghostDescript: descript, site, stage, balloons, dialogs, balloon: balloonEntry, loadSkin,
    createStage: (shellId, st, old) => Stage.create({ files, shellId, ghostDescript: descript, dom: false, decode, clock, state: st, scale: old.scale }),
    onStage: s => { stage = s; },
    onSkin: s => { skin = s; },
    note: c => { if (report.changes.length < 60) report.changes.push({ phase, ...c }); },
  }).request;
  const scripts = [];
  const origPlay = player.play.bind(player);
  player.play = (script, meta = {}) => {
    const s = script == null ? '' : String(script);
    report.scripts++;
    scripts.push({ phase, event: meta.event || '', script: s });
    try {
      for (const t of tokenize(s)) {
        if (t.type === 'text') { report.chars += (t.text || '').length; continue; }
        const k = tagKey(t);
        if (k) report.tags[k] = (report.tags[k] || 0) + 1;
      }
    } catch (e) { logs.push({ level: 'error', phase, msg: 'tokenize: ' + fmt([e]) }); }
    return origPlay(script, meta);
  };

  const lastScript = () => (scripts.length ? scripts[scripts.length - 1] : null);
  /** let the current script play out: click waits are clicked, everything else just waits */
  const playOut = async (maxMs = 60000) => {
    for (let t = 0; t < maxMs; t += 500) {
      if (shiori.dead) return;
      const run = player.run;
      if (run && run.state === 'clickwait') balloons.emit('click', { scope: run.clickScope | 0, button: 0 });
      if (!player.busy) { await clock.advance(300); if (!player.busy) return; }
      await clock.advance(500);
    }
  };
  const choose = async (link, root) => {
    if (report.picks.length >= MAX_PICKS * 2) return;
    report.picks.push({ phase, root, id: String(link.id).slice(0, 80), label: String(link.label || '').slice(0, 40) });
    balloons.emit('link', { kind: link.kind, id: link.id, label: link.label, refs: link.refs, scope: 0,
      ...(link.script !== undefined ? { script: link.script } : {}) });
    await settle();
    await playOut();
  };
  const mouse = (type, scope, x, y, collision, extra = {}) => stage.emit('mouse', { type, scope, x, y, collision, button: 0, device: 'mouse', ...extra });
  const dbl = async (scope, x = 50, y = 50, collision = '') => {
    mouse('down', scope, x, y, collision); mouse('up', scope, x, y, collision, { click: true }); mouse('click', scope, x, y, collision);
    await clock.advance(120);
    mouse('down', scope, x, y, collision); mouse('dblclick', scope, x, y, collision); mouse('up', scope, x, y, collision, { click: false });
    await clock.advance(100);          // the loop handles mouse events one after another
    await playOut();
  };
  /**
   * A root engine (YAYA, Kawari) was unloaded by the close (the loop's shiori.unload at `\-`): the next cold boot gets a
   * new one from the stored files, as the runtime's next visit does (Kawari answers nothing after its unload; Satori's
   * engine answers on and is kept). reload: \![reload,shiori]'s load (counted in report.reloads, not restarts).
   */
  const restartEngine = async ({ reload = false } = {}) => {
    const next = yaya ? newYaya(engineLog) : newKawari(engineLog);
    await next.boot();
    const ok = yaya ? next.init(efiles, shiori.stored, { resume: false, bootEpochMs }) : next.init(efiles, shiori.stored, { resume: false });
    engine = next;
    shiori.engine = next;
    shiori.keep(next.changedFiles());
    clock.stepPastMount();
    if (kawari) kawariBase = ok ? kawariDump(next) : null;
    if (reload) report.reloads = (report.reloads || 0) + 1;
    else report.restarts = (report.restarts || 0) + 1;
    if (!ok && !report.crashed) {
      report.crashed = { phase, error: reload ? 'the engine did not load again at \\![reload,shiori]' : 'the engine of the next cold boot did not load' };
      shiori.dead = true;
    }
  };
  // \![reload,shiori] (EV §2.10): a root engine unloads (its files kept) and a new one loads from them, as
  // ShioriClient.reload does; the loop's requests asked meanwhile wait (InProcessShiori.gate). Satori: none (no corpus
  // Satori ghost reloads its SHIORI), so the tag stays a no-op there
  if (root) {
    loop.shioriReloader = () => {
      if (shiori.dead) return Promise.resolve(false);
      const gate = (async () => { await shiori.unload(); await restartEngine({ reload: true }); })();
      shiori.gate = gate;
      gate.then(() => { if (shiori.gate === gate) shiori.gate = null; }, () => { if (shiori.gate === gate) shiori.gate = null; });
      return gate.then(() => !shiori.dead, e => { logs.push({ level: 'error', phase, msg: 'reload: ' + fmt([e]).slice(0, 500) }); return false; });
    };
  }
  const reboot = async why => {
    report.closed = report.closed || why;
    if (root && !shiori.dead) await restartEngine();
    loop.closed = false;
    loop.closing = false;
    await loop.boot({ resume: false });
    await playOut();
  };

  // ---- boot (a first meeting)
  report.stage = 'boot';
  phase = 'boot';
  await loop.boot({ resume: false, firstBoot: true });
  await playOut();
  // first-boot questions: follow the first choice of each, a few levels deep
  for (let depth = 0; depth < 6 && !shiori.dead; depth++) {
    const ls = lastScript() ? linksOf(lastScript().script).filter(l => l.kind === 'choice') : [];
    if (!ls.length) break;
    await choose(ls[0], 'boot');
  }
  mark('boot');

  // ---- the right-click menus, as the page builds them (captions, colours, site lists are ghost resources)
  phase = 'menuui';
  for (const scope of [0, 1]) {
    try {
      // the clicked character's popupmenu.visible / .type, then the shown menu's owner's ids (UI §2.1 notes)
      const r = await askMenu(ids => loop.resources(ids), scope, { has: s => s === 0 || stage.has(s) });
      const model = r ? buildMenuModel(r.target, r.res, { lang: 'ja', dressupScope: r.bindScope }) : [];
      const answered = r ? [...r.gate.values(), ...r.res.values()].filter(v => v != null && v !== '').length : 0;
      report.menu[scope] = { items: model.length, resources: answered, ...(r && r.target !== scope ? { target: r.target } : {}) };
    } catch (e) {
      logs.push({ level: 'error', phase, msg: `menu ${scope}: ` + fmt([e]).slice(0, 600) });
    }
  }

  // ---- menus: double-click each character, explore the choices breadth-first
  for (const scope of [0, 1]) {
    if (shiori.dead) break;
    phase = `menu${scope}`;
    const seen = new Set();
    const queue = [[]];
    let picks = 0;
    while (queue.length && picks < MAX_PICKS / 2 && !shiori.dead) {
      const pathTo = queue.shift();
      if (loop.closed) await reboot(phase);
      player.interrupt();
      await playOut(5000);
      const before = scripts.length;
      await dbl(scope);
      if (scripts.length === before) continue;          // no menu on this character
      let ok = true;
      for (const step of pathTo) {
        const ls = lastScript() ? linksOf(lastScript().script) : [];
        const l = ls.find(x => x.id === step.id && x.label === step.label);
        if (!l) { ok = false; break; }
        const n = scripts.length;
        await choose(l, phase);
        picks++;
        if (loop.closed || scripts.length === n) { ok = false; break; }
      }
      if (!ok) continue;
      if (pathTo.length >= 3) continue;
      const ls = lastScript() ? linksOf(lastScript().script) : [];
      for (const l of ls) {
        const key = pathTo.map(s => s.id + '|' + s.label).join('>') + '>' + l.id + '|' + l.label;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push([...pathTo, { id: l.id, label: l.label }]);
      }
    }
  }
  mark('menus');

  // ---- touch: click and stroke every collision area of the current surfaces
  phase = 'touch';
  if (loop.closed) await reboot(phase);
  for (const scope of stage.scopes.filter(s => s <= 1)) {
    const v = stage.char(scope);
    const surf = v && v._surf;
    const colls = surf && surf.collisions ? surf.collisions.slice(0, 12) : [];
    for (const c of colls) {
      if (shiori.dead) break;
      const x = c.kind === 'circle' ? c.cx : c.kind === 'polygon' ? c.pts[0] + 1 : Math.floor(((c.x1 ?? 0) + (c.x2 ?? 1)) / 2);
      const y = c.kind === 'circle' ? c.cy : c.kind === 'polygon' ? c.pts[1] + 1 : Math.floor(((c.y1 ?? 0) + (c.y2 ?? 1)) / 2);
      player.interrupt();
      mouse('down', scope, x, y, c.id); mouse('up', scope, x, y, c.id, { click: true }); mouse('click', scope, x, y, c.id);
      await settle();
      await playOut(20000);
      for (let i = 0; i < 60 && !player.busy; i++) {
        mouse('move', scope, x + (i % 6) - 3, y + (i % 4) - 2, c.id);
        await clock.advance(60);
      }
      await playOut(20000);
      mouse('wheel', scope, x, y, c.id, { wheel: 120 });
      await settle();
      await playOut(10000);
      if (loop.closed) await reboot(phase);
    }
  }
  mark('touch');

  // ---- keys and the communicate box
  phase = 'keys';
  for (const k of ['t', 'm', 'c', 'r', 'h', 's', 'f1', 'space']) {
    if (shiori.dead) break;
    player.interrupt();
    await loop.send('OnKeyPress', [k, String(k.length === 1 ? k.toUpperCase().charCodeAt(0) : k === 'f1' ? 112 : 32), '0', '']);
    await playOut(20000);
    for (const l of (lastScript() ? linksOf(lastScript().script).slice(0, 1) : [])) await choose(l, 'key ' + k);
    if (loop.closed) await reboot(phase);
  }
  phase = 'communicate';
  player.interrupt();
  loop.openBox('communicatebox', []);
  await clock.advance(2000);
  await playOut(20000);
  mark('keys');

  // ---- leave her alone: random talk, minute changes, choices in talks answered with their first item
  phase = 'idle';
  if (loop.closed) await reboot(phase);
  loop.start && loop.start();
  let talkPicks = 0;
  for (let s = 0; s < IDLE_SECONDS && !shiori.dead; s += 5) {
    const before = scripts.length;
    await clock.advance(5000);
    const run = player.run;
    if (run && run.state === 'clickwait') balloons.emit('click', { scope: run.clickScope | 0, button: 0 });
    if (scripts.length > before && talkPicks < 10) {
      await playOut(30000);
      const ls = lastScript() ? linksOf(lastScript().script).filter(l => l.kind === 'choice') : [];
      if (ls.length) { talkPicks++; await choose(ls[0], 'talk'); }
    }
    if (loop.closed) await reboot(phase);
    if (kawari && !shiori.dead) kawariSave();      // the worker saves after requests (debounced): here every 5 s
  }
  mark('idle');

  // ---- resume (YAYA, D1; Kawari, its snapshot and D6): the next page's engine from the files stored so far, and once
  // after a dictionary update
  if (yaya && !shiori.dead) {
    phase = 'resume';
    report.stage = 'resume';
    report.resume = await resumeCheck({ engine, shiori, efiles, module: chosen.module, newYaya, bootEpochMs });
    mark('resume');
  } else if (kawari && !shiori.dead) {
    phase = 'resume';
    report.stage = 'resume';
    report.resume = await kawariResumeCheck({ engine, shiori, efiles, newKawari, save: kawariSave, base: kawariBase,
      shell: shellName(ghost, stage.shellId) });
    mark('resume');
  }

  // ---- close, and save
  phase = 'close';
  player.interrupt();
  try { await loop.close(0); } catch (e) { logs.push({ level: 'error', phase, msg: 'close: ' + fmt([e]) }); }
  await playOut(30000);
  if (kawari) report.kawari.heapMB = engine.M.HEAPU8.length / 1048576;
  try {
    const saved = root ? await shiori.unload() : engine.unload ? engine.unload() : null;
    report.saved = Array.isArray(saved) ? saved.map(f => f.path || f.name || String(f)).slice(0, 10) : saved && typeof saved === 'object' ? Object.keys(saved).slice(0, 10) : saved;
  } catch (e) { logs.push({ level: 'error', phase, msg: 'unload: ' + fmt([e]) }); }
  // YAYA, Kawari: what the worker's store would hold now (null: a shipped file the ghost deleted; Kawari's RESUME_KEY:
  // after the unload the empty marker, D7)
  if (root) report.stored = Object.entries(shiori.stored).map(([p, v]) => (v ? p : `${p} (deleted)`)).slice(0, 40);
  if (kawari) report.kawari.marker = shiori.stored[engine.resumeKey] ? shiori.stored[engine.resumeKey].byteLength : null;
  mark('close');
  report.saori = saoriLoads.map(s => ({ name: s.name, standIn: s.standIn }));
  report.ok = !report.crashed;
  report.stage = 'done';
  report.sample = scripts.filter(s => s.script).slice(0, 3).map(s => ({ event: s.event, script: s.script.slice(0, 300) }));
  try { loop.destroy(); } catch (e) { /* ignore */ }
}

main().catch(e => {
  report.fatal = fmt([e]).slice(0, 2000);
}).finally(() => {
  if (pageClock) report.clock.end = localText(pageClock.now());
  report.wallMs.total = realNow() - t0;
  report.logs = logs.filter(l => l.level !== 'debug' || /ignored|unsupported|not supported|not handled|only log/i.test(l.msg)).slice(0, 400);
  report.logCount = logs.length;
  process.stdout.write('\n@@REPORT@@' + JSON.stringify(report) + '\n', () => process.exit(0));
});

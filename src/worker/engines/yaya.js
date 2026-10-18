// YAYA (AYA5's successor), compiled from vendor/yaya-shiori by engines/yaya/build.py (yaya-wasm.md).
// The ghost runs in an SSP-like MEMFS (yaya-wasm.md, MEMFS): /ssp/ghost/<id>/ is its root and the persistence root,
// /ssp/ghost/ lists the site's ghosts and /ssp/balloon/ its balloons, so ../../updates2.dau, ../../notelog/ and
// FENUM('..\..\..') behave as in an SSP install. What the visitor's run changes under the root is kept (persistence):
// bytes for new and rewritten files (a rewritten shipped file shadows the site's copy), null for a shipped file the
// ghost deleted, false for a file of its own it deleted. That root, shared with Kawari, is ./ssproot.js; its helpers
// are re-exported here.
import { SspRootShiori, rootBridge, LogLines, dicStamp, clock, ms, toU8 } from './ssproot.js';

export { rootBridge, sspDescript, LogLines, diffScan, dicStamp } from './ssproot.js';

const enc = new TextEncoder();
// yaya_load_status()
const STATUS = new Map([[-1, 'no engine'], [0, 'normal'], [1, 'emergency'], [2, 'suppressed'], [3, 'shell mode']]);
// YAYA's log modes (messages.h): 6 = end and 16/17/32 = charset markers carry no text and are dropped
const MODES = ['info', 'fatal', 'error', 'warning', 'note', 'info'];

function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
}

export class YayaEngine extends SspRootShiori {
  /**
   * @param {{engineUrl: string, ghostDir?: string, log?: Function, saori?: object, opts?: object|null,
   *   onEngineLog?: Function|null}} o opts: the worker's engineOpts, plain JSON from the page ({module, ghostId,
   *   placeholders, site: {ghosts, balloons}, lang?}); onEngineLog({mode, text}): YAYA's own log lines for in-process
   *   users (the sweep, tests). ghostDir is not used: the ghost lives at /ssp/ghost/<id>/ghost/master/
   */
  constructor(o) {
    super(o);
    this.module = this.opts.module || 'yaya';
    this.status = null;       // yaya_load_status() after the last load
    this._lines = new LogLines();
  }

  async factory() {
    if (typeof self.createYaya !== 'function') importScripts(this.engineUrl);
    return self.createYaya;
  }

  async boot() {
    const t0 = clock();
    const lang = this.opts.lang;
    await super.boot({
      saoriBridge: rootBridge(this.saori, this.ghostRoot),
      yayaLog: (text, mode) => this._onYayaLog(text, mode),
      // coreinfo.timezone / GETTIMEZONE name the visitor's zone; LANG picks YAYA's message language (without it
      // Emscripten's default comes from navigator.languages)
      preRun: [M => {
        const tz = timeZone();
        if (tz) M.ENV.TZ = tz;
        if (lang) M.ENV.LANG = `${String(lang).replace('-', '_')}.UTF-8`;
      }],
    });
    this.timing.module = clock() - t0;
  }

  /**
   * @param {{path: string, data: ArrayBuffer}[]} files the site's files with bytes, ghost-root-relative
   * @param {Record<string, ArrayBuffer|null>} persisted the visitor's files, ghost-root-relative (null: deleted)
   * @param {{resume?: boolean, bootEpochMs?: number, volatile?: object|null}} o volatile: the page's stored engine
   *   state on a resume ({dicStamp} of the last boot)
   */
  init(files, persisted = {}, { resume = false, bootEpochMs = 0, volatile = null } = {}) {
    const M = this.M;
    if (bootEpochMs > 0) M.bootEpochMs = bootEpochMs;      // GETTICKCOUNT counts from the last cold boot (P7)
    const t0 = clock();
    this.dicStamp = dicStamp(files);
    const stampMs = clock() - t0;
    // a resume restores the save twice, and with it what load cached from the dictionaries it ran (emily4's
    // array_eventtranslate): after a site update that would be stale, so it loads as SSP does after a network update
    if (this._stampChanged(resume, volatile)) resume = false;
    // the site's files (a shipped file beats a placeholder), then the visitor's: a tombstone removes, a copy shadows
    const placeholders = this._mount(files, persisted);
    const pre = this.scan();
    const preHot = this._hot(pre);
    const t1 = clock();
    const ok = this.callLoad(this.ghostDir, resume);
    this.timing.load = clock() - t1;
    this._flushLog();
    // the first report is what load wrote or deleted, which the worker stores at once (yaya-wasm.md, persistence): a
    // load that moves an old save to its own (emily4's template: RESTOREVAR, FDEL, SAVEVAR) must not leave the store
    // with the old one deleted and the new one missing. On a resume N3 restored the saved variables after load, in
    // memory: a save load wrote holds load's values, so the save is written again first.
    if (resume && ok && this._diff(pre, preHot, this.scan()).changed.length) this.save();
    this.baseline = pre;
    this.hot = preHot;
    const bytes = (files || []).reduce((n, f) => n + toU8(f.data).length, 0);
    this.log('debug', `yaya ${this.module}: ${STATUS.get(this.status) || this.status}, module ${ms(this.timing.module)} ms, ` +
      `load ${ms(this.timing.load)} ms, stamp ${ms(stampMs)} ms, heap ${(M.HEAPU8.length / 1048576).toFixed(0)} MB, ` +
      `${(files || []).length} files ${(bytes / 1024).toFixed(0)} KB, ${placeholders} placeholders`);
    return ok;
  }

  /** load, or on a resume yaya_load_resume: load, then the save restored again, so no boot counts (yaya-wasm.md). */
  callLoad(dir, resume) {
    const M = this.M;
    const name = enc.encode(this.module);
    const p = this._toHeap(name);
    try { M._yaya_set_module_name(p, name.length); } finally { M._free(p); }
    const b = enc.encode(dir);
    try {
      const r = this._stackGuard(() => (resume ? M._yaya_load_resume : M._load)(this._toHeap(b), b.length));
      if (resume && r === 0) this.log('warn', 'the resume load failed inside the engine');
    } catch (e) {
      this.log('error', `load: ${e}`);
      return false;
    }
    const st = M._yaya_load_status();
    this.status = st;
    // an emergency dictionary boots, as in SSP; the reasons are ours, at warn, so they show without ?sumika-debug
    switch (st) {
      case 0: return true;
      case 1: this.log('warn', `emergency mode: ${this.module}_emerg.txt answers`); return true;
      case 2: this.log('warn', 'nothing usable loaded (dictionary errors; details with ?sumika-debug)'); return false;
      case 3:
        this.log('warn', `no ${this.module}.txt or no dictionary: the index's module is wrong or the ghost has no config`);
        return false;
      default: this.log('warn', 'load() left no engine'); return false;
    }
  }

  request(text) {
    const r = super.request(text);
    this._flushLog();
    return r;
  }

  /** yaya_save: <module>_variable.cfg now, as unload would write it (only when save.auto is on). */
  save() {
    try {
      return this.M._yaya_save() === 1;
    } catch (e) {
      this.log('error', `yaya_save: ${e}`);
      return false;
    }
  }

  unload() {
    const files = super.unload();
    this._flushLog();
    return files;
  }

  _onYayaLog(text, mode) {
    for (const l of this._lines.push(text, mode)) this._logLine(l);
  }

  _flushLog() {
    for (const l of this._lines.flush()) this._logLine(l);
  }

  /** fatal/error/warning/note: the page console at debug (?sumika-debug) and onEngineLog; info, other: onEngineLog. */
  _logLine({ mode, text }) {
    const name = MODES[mode];
    if (!name) return;
    if (mode >= 1 && mode <= 4) this.log('debug', `yaya ${name}: ${text}`);
    this._engineLog({ mode: name, text });
  }
}

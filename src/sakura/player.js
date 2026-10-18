// SakuraScript player (docs/research/sakurascript.md §4–§7, SUMMARY C3/C5/C7/C14/C15/C18/C24/C25, §2.2–§2.4).
//
// Timing uses a virtual clock: run.due is the time the next token may execute; characters, \w and \_w add to it,
// so waits never drift. Each step executes everything that is due and then writes the collected text in one call
// per balloon, so a \_q game frame (\c + 64 images + \_w) lands in a single paint.
//
// The player drives the Stage / Balloons / PlayerHost only through docs/CONTRACTS.md. Optional extras it uses when
// present (duck-typed): BalloonView.setNoWrap(on) for \_n, BalloonView.marker() for \![*] and %*,
// CharacterView.onTalk(n) (legacy name talk(n)) for `talk` SERIKO triggers, CharacterView.anim(id, cmd, ...args)
// (else pause/resume/offsetAnimation) for \![anim,...], CharacterView.geometryPending / geometryReady() for
// \![move] right after a \s, Stage.resetPositions() for \![execute,resetwindowpos]. A shell swap holds the current run
// (hold / release) and hands it the new stage (setStage); a thenable from PlayerHost.change holds the script at
// \![change,shell|balloon] (EV §2.6). PlayerHost.call (\![call,ghost], EV §2.7) and PlayerHost.raiseOther
// (\![raiseother|notifyother], EV §2.7.9) never hold it. A thenable from PlayerHost.httpExecute holds it at a
// synchronous \![execute,http-*] (EV §4.15), and one from PlayerHost.reload at \![reload,shiori|shell|balloon] /
// \![reloadsurface] (EV §2.10). \![get,property] waits at the tag for PlayerHost.raiseProperty's reply as
// \![raise] does; a thenable from PlayerHost.setProperty holds \![set,property] until it settles (ssp.exe's Set is
// synchronous); \![open,con…] goes to PlayerHost.openWindow (docs/research/properties.md §3, §4, SS §5.9).
//
// The player expands no %-variable: the event loop expands the whole script before it plays (src/sakura/expand.js,
// ssp.exe's TranslateParam); only `%*` reaches it, as the marker.
//
// A `\C` run appends to what the previous run left on screen. It inherits that run's live choices (and `\*`), and
// its RunState carries the previous run's state as `base` (a chain) so that replay() can rebuild the content
// underneath; a base is dropped once the appended run has cleared every balloon the base wrote to.
import { Emitter } from '../core/emitter.js';
import { log } from '../core/log.js';
import { tokenize } from './tokenizer.js';
import { realClock } from './clock.js';
import {
  num, intPrefix, waitMs, parseBalloonWait, newlineRatio, bindValue, alignmentMode, codeChar,
  parseMoveArgs, moveTarget, approachTarget, findAppendC, isSideEffect, refList, scopeNumber, jumpString, parseBool,
} from './commands.js';
import { charcodeReference } from './entity.js';

const ACTIVE = new Set(['running', 'blocked', 'clickwait']);
const SAORI_RAISE = 'OnDirectSaoriCall';
const CTRL = /[\x00-\x1f\x7f]/;
const CTRL_G = /[\x00-\x1f\x7f]/g;
const BLANK = /[\s　]/;
const POLL_MS = 50;
const MOVE_FRAME_MS = 16;
const GEOMETRY_WAIT_MS = 10000;           // a surface size that never arrives: move with the old one
const MAX_ANIM_WAIT_MS = 30000;
const MAX_EMBEDS = 1000;                  // an embed whose reply embeds again must not loop forever
const BOX_KINDS = new Set(['inputbox', 'passwordinput', 'dateinput', 'sliderinput', 'timeinput', 'ipinput',
  'communicatebox', 'teachbox']);
const ANIM_CMDS = new Set(['start', 'stop', 'clear', 'pause', 'resume', 'offset']);
// \![reload,X] that PlayerHost.reload does (EV §2.10); makoto, descript and aigraph stay no-ops
const RELOADS = new Set(['shiori', 'shell', 'balloon', 'ghost']);
// \![set,…] that reach SPSerikoAnimation::PlayCommand (SetAlignChar, SetCharAlpha, SetScalingChar,
// SetBalloonOffsetChar, SetBalloonAlignChar) [disasm ExecuteExclamationTag 0x631842–0x631ba4, 0x6321be]
const SERIKO_SET = new Set(['alignmenttodesktop', 'alignmentondesktop', 'alpha', 'scaling', 'balloonoffset',
  'balloonalign']);
const MAX_BASE_DEPTH = 8;                 // \C chain kept for replay: levels ...
const MAX_BASE_CHARS = 1 << 19;           // ... and script characters (SUM §2.5 drops runs > 1 MB anyway)
const MAX_LABELS = 4096;

const lc = s => String(s ?? '').trim().toLowerCase();
const linkKey = i => `${i.kind === 'anchor' ? 'a' : 'c'}\0${i.id ?? ''}\0${(i.refs || []).join('\0')}`;

/** Copy of a RunState chain cut to MAX_BASE_DEPTH levels / MAX_BASE_CHARS characters (the oldest levels go first). */
function trimChain(rs, depth = MAX_BASE_DEPTH, chars = MAX_BASE_CHARS) {
  if (!rs || depth <= 0 || rs.src.length > chars) return undefined;
  const base = rs.base ? trimChain(rs.base, depth - 1, chars - rs.src.length) : undefined;
  if (base === rs.base) return rs;
  const out = { ...rs };
  if (base) out.base = base; else delete out.base;
  return out;
}

const isRunState = rs => !!rs && typeof rs === 'object' && typeof rs.src === 'string';

function defaultViewport() {
  const d = typeof document !== 'undefined' ? document.documentElement : null;
  return {
    width: (d && d.clientWidth) || (typeof innerWidth === 'number' ? innerWidth : 0),
    height: (d && d.clientHeight) || (typeof innerHeight === 'number' ? innerHeight : 0),
  };
}

/**
 * `shown`: the run put something on screen (text, a marker, a choice or anchor, an image, a surface or an animation)
 * or ran a shell tag that ssp.exe plays like one (a bind, a move, alignment, alpha ...: _seriko), as ssp.exe's "this
 * script showed something" flag, which decides whether a broken script arms OnSurfaceRestore (EV §3.4) [disasm
 * SPGhost+0x1d78, DecodeProc 0x628d92].
 * @typedef {{reason:'end'|'interrupted'|'quit'|'replaced', hasChoices:boolean, noChoiceTimeout:boolean, event:string,
 *            shown:boolean}} PlayResult
 * @typedef {{src:string, ip:number, sub:number, state:'running'|'clickwait'|'blocked'|'finished',
 *            hasChoices:boolean, noChoiceTimeout:boolean, origin:string, refs:string[], embeds:string[],
 *            base?:RunState}} RunState  base = what a `\C` run appended to (replayed first, up to its saved point)
 */

export class ScriptPlayer extends Emitter {
  /**
   * @param {{stage:any, balloons:any, dialogs?:any, host:any, speedMs?:number,
   *          clock?:import('./clock.js').Clock, viewport?:() => {width:number, height:number}, budgetMs?:number}} o
   */
  constructor({ stage, balloons, dialogs, host, speedMs = 50, clock = realClock, viewport, budgetMs = 8 } = {}) {
    super();
    this.stage = stage;
    this.balloons = balloons;
    this.dialogs = dialogs;
    this.host = host || {};
    this.speedMs = speedMs;                 // per-character wait (user preference)
    this.clock = clock;
    this.budgetMs = budgetMs;               // CPU per step before yielding
    this.viewport = viewport || defaultViewport;
    this.run = null;
    this._fresh = null;                     // the run started in the current task (see _onLink)
    this._gen = 0;
    this._timer = null;
    this._stepping = false;
    this._scopes = new Set();               // scopes whose balloons this player has used
    this._noWrap = new Map();               // \_n state per scope
    this._reported = new Set();
    this._labels = new Map();               // \__q / \_a link text by kind+id+refs (for clicks reported without it)
    this._asyncMoves = new Set();
    this._held = null;                      // {run, at}: the run a shell swap pauses (hold / release)
    this._destroyed = false;
    this._offs = [];
    if (balloons && typeof balloons.on === 'function') {
      this._offs.push(balloons.on('link', info => this._onLink(info)));
      this._offs.push(balloons.on('click', e => this._onClick(e)));
    }
  }

  // ------------------------------------------------------------------------------------------------ public API

  /**
   * Play a script, replacing whatever is playing.
   * @param {string} script
   * @param {{event?:string, refs?:string[]}} meta
   * @returns {Promise<PlayResult>}
   */
  play(script, meta = {}) {
    return this._begin(this._newRun(script == null ? '' : String(script), meta), false);
  }

  /**
   * Fast-forward a saved run (SS §7): tokens before the saved point execute with zero waits and without side
   * effects, then playback continues normally (a saved click wait waits again, a finished run just finishes).
   * @param {RunState} rs
   * @returns {Promise<PlayResult>}
   */
  replay(rs) {
    if (!isRunState(rs)) {
      return Promise.resolve({ reason: 'end', hasChoices: false, noChoiceTimeout: false, event: '', shown: false });
    }
    const prev = this.run;
    if (prev && ACTIVE.has(prev.state)) this._stop(prev, 'replaced');
    const base = isRunState(rs.base) ? rs.base : null;
    if (base) this._fastForward(base, MAX_BASE_DEPTH * 2);
    const run = this._restored(rs);
    if (base) run.base = base;
    return this._begin(run, true);
  }

  /** Stop the current run (a choice, a break or a newer script). A finished balloon stays as it is. */
  interrupt() {
    const run = this.run;
    if (!run) return;
    if (ACTIVE.has(run.state)) this._stop(run, 'interrupted');
    run.choiceDone = true;
  }

  /** Resume a click wait (\x) as if the balloon had been clicked (e.g. from a key press). */
  proceed() { this._onClick({ button: 0 }); }

  /**
   * A shell swap replaced the stage (EV §2.6): later \s, \i, \![bind], \![move] … go to the new one. Moves and
   * animation waits on the old stage's characters end here (those windows are gone); a script waiting for one goes on.
   */
  setStage(stage) {
    if (stage === this.stage) return;
    this.stage = stage;
    for (const m of [...this._asyncMoves]) this._endMove(m, false);
    const run = this.run;
    if (!run || run.state !== 'blocked') return;
    if (run.move) this._endMove(run.move, false);
    else if (run.blockKind === 'animation' || run.blockKind === 'wait-animation') {
      if (run.pollTimer) { this.clock.clearTimer(run.pollTimer); run.pollTimer = null; }
      this._unblock(run);
    }
  }

  /**
   * A shell swap is on (EV §2.6): the current run pauses until release(), so none of its tags land on the stage being
   * replaced (SSP swaps synchronously: an old script goes on only after the swap). It stays busy; a reply or click it
   * was waiting for unblocks it, but nothing executes. A newer run (OnShellChanged's reply) is not held and replaces it
   * as usual. No active run: nothing to hold.
   */
  hold() {
    const run = this.run;
    if (this._held && this._held.run === run) return;
    this._held = run && ACTIVE.has(run.state) ? { run, at: this.clock.now() } : null;
    if (this._held) this._cancelTimer();
  }

  /** The swap is over: the held run goes on, its waits (\w, \_w, character pacing, \__w) shifted by the time held. */
  release() {
    const h = this._held;
    this._held = null;
    if (!h) return;
    const run = h.run;
    const dt = Math.max(0, this.clock.now() - h.at);
    run.due += dt;
    run.t0 += dt;
    if (this.run !== run || run.state !== 'running') return;
    if (this._stepping) this._wake(0);
    else this._step();
  }

  /** Running or blocked; a finished balloon that only shows choices does not count. */
  get busy() { return !!this.run && ACTIVE.has(this.run.state); }

  /** The run has finished and its choices are still on screen. */
  get choosing() {
    const r = this.run;
    return !!r && r.state === 'finished' && r.hasChoices && !r.choiceDone && this._linksVisible();
  }

  /** Inside \t (ends with the script or a break). */
  get timeCritical() { const r = this.run; return !!r && ACTIVE.has(r.state) && r.timeCritical; }

  /**
   * \![enter,nouserbreakmode] of the last run, until its leave or the next run, ended or not: ssp.exe's SPGhost+0x41ac,
   * cleared when Loop takes the next script [disasm 0x62f44e, 0x630527, Loop 0x63b540]. Status `nouserbreak` (EV §1.6).
   */
  get noUserBreak() { const r = this.run; return !!r && !!r.userBreakDisabled; }

  /** Increases every time a run starts (stamp requests with it to drop stale replies). */
  get generation() { return this._gen; }

  /** The current script (post-OnTranslate) and the source offset of the current token (OnBalloonBreak R2). */
  get script() { return this.run ? this.run.src : ''; }
  get position() {
    const r = this.run;
    if (!r) return 0;
    const st = r.state === 'done' ? r.stoppedIn : r.state;      // still valid right after interrupt()
    const i = st === 'blocked' || st === 'clickwait' ? r.blockIp : r.ip;
    const t = r.tokens[i];
    if (!t) return r.src.length;
    return t.pos + (t.type === 'text' && i === r.ip ? r.sub : 0);
  }

  /** @returns {RunState|null} what to persist for page navigation (SUM §2.5 "run"; the event loop adds timers). */
  runState() {
    const run = this.run;
    if (!run || !(ACTIVE.has(run.state) || run.state === 'finished')) return null;
    if (run.state === 'finished' && !this._anyVisible()) return null;
    return this._snap(run);
  }

  destroy() {
    this._destroyed = true;
    this._held = null;
    for (const off of this._offs) off();
    this._offs = [];
    if (this.run && ACTIVE.has(this.run.state)) this._stop(this.run, 'interrupted');
    this._cancelTimer();
    for (const m of this._asyncMoves) this._endMove(m, false);
    this.run = null;
  }

  // ------------------------------------------------------------------------------------------------ run lifecycle

  _newRun(src, meta) {
    const tokens = tokenize(src);
    const now = this.clock.now();
    return {
      gen: 0, src, tokens, ip: 0, sub: 0, scope: 0,
      event: meta && meta.event != null ? String(meta.event) : '',
      refs: meta && Array.isArray(meta.refs) ? meta.refs.map(String) : [],
      state: 'running', blockIp: -1, blockKind: null, pollTimer: null, move: null,
      due: now, t0: now,
      quick: false, sync: null, timeCritical: false, noChoiceTimeout: false, hasChoices: false, charWait: null,
      shown: false,               // something reached the screen (PlayResult.shown)
      userBreakDisabled: false, link: null, clickScope: 0, clickNoClear: false,
      cIndex: findAppendC(tokens), choiceDone: false, picked: false, star: false,
      buf: '', bufKey: '', bufTargets: null,
      ff: null, embeds: [], embedQueue: null, silent: false, stoppedIn: null,
      // \C chain: the state appended to, the scopes its content is in, and what this run wrote / fully cleared
      base: undefined, baseScopes: null, touched: new Set(), cleared: new Set(), clearedAll: false,
      resolve: null, result: null,
    };
  }

  /** A run that fast-forwards to a saved point (SS §7). */
  _restored(rs) {
    const run = this._newRun(rs.src, { event: rs.origin, refs: rs.refs });
    run.ff = { ip: Math.max(0, rs.ip | 0), sub: Math.max(0, rs.sub | 0) };
    run.embedQueue = Array.isArray(rs.embeds) ? rs.embeds.map(String) : [];
    return run;
  }

  /** Rebuild one base level of a \C chain at once: no waits, no side effects, no events, no result. */
  _fastForward(rs, depth) {
    const base = depth > 1 && isRunState(rs.base) ? rs.base : null;
    if (base) this._fastForward(base, depth - 1);
    const run = this._restored(rs);
    run.silent = true;
    run.base = base || null;                // the oldest level starts like a fresh script
    run.gen = this._gen;
    this._cancelTimer();
    this._startBalloons(run, this.run);
    this.run = run;
    try {
      while (this.run === run && run.state === 'running' && run.ff &&
        (run.ip < run.ff.ip || (run.ip === run.ff.ip && run.sub < run.ff.sub))) this._exec(run);
      this._flushText(run);
      if (run.link) this._endLink(run);
    } catch (e) {
      log.once('sakura:ffbase', 'replaying a \\C base failed', e);
    }
    run.ff = null;
    if (run.state === 'running') { run.stoppedIn = 'running'; run.state = 'done'; }
  }

  _begin(run, replaying) {
    const prev = this.run;
    if (prev && ACTIVE.has(prev.state)) this._stop(prev, 'replaced');
    run.gen = ++this._gen;
    const done = new Promise(r => { run.resolve = r; });
    this._cancelTimer();
    this._startBalloons(run, prev);
    this.run = run;
    this._fresh = run;
    Promise.resolve().then(() => { if (this._fresh === run) this._fresh = null; });
    this.emit('start', { event: run.event, refs: run.refs, replay: replaying });
    if (this._stepping) this._wake(0);
    else this._step();
    return done;
  }

  /**
   * SS §4.3 step 3 with the lenient \C rule (SUM §2.2) and the balloon-kind reset (C15). In a replayed chain
   * run.base is already decided: a level on top of a rebuilt base appends, the oldest level (null) does not.
   */
  _startBalloons(run, prev) {
    let append = false;
    if (run.cIndex >= 0) {
      append = run.base === undefined ? this._anyVisible() : !!run.base;
      if (append && run.cIndex > 0) log.debug('\\C after', run.cIndex, 'leading tags: appending (lenient rule)');
    }
    if (append) {
      if (prev) this._inherit(run, prev);
      // \f and \_n end with the script even when the next one appends: \C keeps only the content (SS §4, SUM §2.2)
      for (const s of this._scopes) this._resetStyle(s, this._view(s));
      return;
    }
    this._labels.clear();
    try { this.balloons?.hideAll(); } catch (e) { log.once('sakura:hideAll', 'balloons.hideAll failed', e); }
    for (const s of this._scopes) {
      const v = this._view(s);
      if (!v) continue;
      this._call(v, 'clear');
      this._call(v, 'resetKind');
      this._resetStyle(s, v);
    }
  }

  /** Script-lifetime text state of a balloon back to the defaults: \f font, \_n no-wrap. */
  _resetStyle(scope, v) {
    if (!v) return;
    this._call(v, 'setFont', 'default', '');
    if (this._noWrap.get(scope)) { this._noWrap.set(scope, false); this._call(v, 'setNoWrap', false); }
  }

  /**
   * An appending run starts where `prev` left off: its choices stay live (so does its \*), and its state becomes this
   * run's replay base.
   */
  _inherit(run, prev) {
    if (run.base === undefined) run.base = trimChain(this._snap(prev));
    run.baseScopes = new Set(prev.touched);
    if (this._liveBase(prev)) for (const s of prev.baseScopes) run.baseScopes.add(s);
    if (prev.hasChoices && this._linksVisible()) {
      run.hasChoices = true;
      run.noChoiceTimeout = prev.noChoiceTimeout;
    }
  }

  /** The base a run still shows: none once every balloon the base wrote to was fully cleared (\c, \x). */
  _liveBase(run) {
    if (!run.base || run.clearedAll || !run.baseScopes) return undefined;
    for (const s of run.baseScopes) if (!run.cleared.has(s)) return run.base;
    return undefined;
  }

  /** @returns {RunState} */
  _snap(run) {
    const st = run.state === 'done' ? run.stoppedIn || 'finished' : run.state;
    const rs = {
      src: run.src,
      ip: st === 'clickwait' ? run.blockIp : run.ip,
      sub: st === 'running' ? run.sub : 0,
      state: st,
      hasChoices: run.hasChoices,
      noChoiceTimeout: run.noChoiceTimeout,
      origin: run.event,
      refs: run.refs.slice(),
      embeds: run.embeds.slice(),
    };
    const base = this._liveBase(run);
    if (base) rs.base = base;
    return rs;
  }

  _settle(run, reason) {
    const result = { reason, hasChoices: run.hasChoices, noChoiceTimeout: run.noChoiceTimeout, event: run.event, shown: run.shown };
    run.result = result;
    if (run.silent) return;
    if (run.resolve) run.resolve(result);
    this.emit('end', result);
  }

  /** \e or the end of the tokens: balloons stay open; the event loop arms the timeouts (SUM §2.4). */
  _finish(run) {
    this._flushText(run);
    if (run.link) this._endLink(run);
    if (run.ff) run.ff = null;
    // choices that were cleared (\c) or inherited from a base that is gone no longer count
    if (run.hasChoices && !this._linksVisible()) {
      run.hasChoices = false;
      run.noChoiceTimeout = run.star;
    }
    run.state = 'finished';
    if (run === this.run) this._cancelTimer();
    this._settle(run, 'end');
  }

  /** Abort: stop at once, cancel waits; no SHIORI event, balloons are not hidden here. */
  _stop(run, reason) {
    if (!ACTIVE.has(run.state)) return;
    this._flushText(run);
    if (run.link) this._endLink(run);
    if (run.state === 'clickwait') this._call(this._view(run.clickScope), 'showClickWait', false);
    run.stoppedIn = run.state;
    run.state = 'done';
    if (run.pollTimer) { this.clock.clearTimer(run.pollTimer); run.pollTimer = null; }
    if (run.move) this._endMove(run.move, true);
    if (run === this.run) this._cancelTimer();
    this._settle(run, reason);
  }

  _block(run, idx, kind) {
    run.state = kind === 'clickwait' ? 'clickwait' : 'blocked';
    run.blockIp = idx;
    run.blockKind = kind;
  }

  _unblock(run) {
    if (this.run !== run || (run.state !== 'blocked' && run.state !== 'clickwait')) return;
    run.state = 'running';
    run.blockKind = null;
    run.due = Math.max(run.due, this.clock.now());
    if (this._stepping) this._wake(0);
    else this._step();
  }

  // ------------------------------------------------------------------------------------------------ stepping

  _cancelTimer() {
    if (this._timer != null) { this.clock.clearTimer(this._timer); this._timer = null; }
  }

  _wake(ms) {
    this._cancelTimer();
    this._timer = this.clock.setTimer(() => { this._timer = null; this._step(); }, ms);
  }

  _step() {
    const run = this.run;
    if (!run || run.state !== 'running' || this._isHeld(run)) return;
    this._stepping = true;
    const now = this.clock.now();
    let n = 0, yielded = false;
    try {
      while (this.run === run && run.state === 'running' && !this._isHeld(run)) {
        if (run.ff && (run.ip > run.ff.ip || (run.ip === run.ff.ip && run.sub >= run.ff.sub))) {
          // fast-forward done: paint the restored state, continue normally from the next step
          this._flushText(run);
          run.ff = null;
          run.due = Math.max(run.due, now);
          run.t0 = Math.max(run.t0, now);
          yielded = true;
          break;
        }
        if (!run.ff && run.due > now) break;
        if ((++n & 63) === 0 && !run.ff && this.clock.now() - now > (run.quick ? this.budgetMs * 6 : this.budgetMs)) {
          yielded = true;
          break;
        }
        this._exec(run);
      }
      this._flushText(run);
    } finally {
      this._stepping = false;
    }
    if (this.run !== run || run.state !== 'running' || this._isHeld(run)) return;
    this._wake(yielded ? 0 : Math.max(0, run.due - this.clock.now()));
  }

  /** A shell swap holds this run (hold / release): nothing of it executes. */
  _isHeld(run) { return !!this._held && this._held.run === run; }

  _exec(run) {
    const tokens = run.tokens;
    if (run.ip >= tokens.length) { this._finish(run); return; }
    const tok = tokens[run.ip];
    if (tok.type === 'text') { this._text(run, tok); return; }
    this._flushText(run);
    const idx = run.ip++;
    try {
      if (tok.type === 'env') this._env(run, tok);
      else if (tok.unterminated) {
        // ssp.exe's "Unclosed '['": the tag is not run and the rest of the script, which the token holds, plays
        // nothing (SS §3.4) [disasm ParseParameters 0x6243d5]
        log.once('sakura:unclosed:' + tok.name, `[GHOST/Script] Unclosed '[' at position ${tok.pos}: the tag and the rest of the script are dropped`, tok.raw.slice(0, 120));
      } else if (tok.type === 'unknown') this._ignore('?' + tok.name, tok.raw);
      else if (run.ff && isSideEffect(tok)) { /* already happened before the page changed */ }
      else this._tag(run, tok, idx);
    } catch (e) {
      log.once('sakura:tag:' + tok.name, 'script tag failed:', tok.raw, e);
    }
  }

  _charWait(run) {
    if (run.quick || run.ff) return 0;
    const cw = run.charWait;
    if (cw) return cw.ms != null ? cw.ms : Math.round(this.speedMs * cw.mul);
    return this.speedMs;
  }

  _wait(run, ms) {
    if (!run.ff && ms > 0) run.due += ms;
  }

  _text(run, tok) {
    const s = tok.text;
    const wait = this._charWait(run);
    if (wait <= 0) {
      let end = s.length;
      if (run.ff && run.ip === run.ff.ip) end = Math.min(end, run.ff.sub);
      this._emit(run, run.sub === 0 && end === s.length ? s : s.slice(run.sub, end));
      if (end >= s.length) { run.ip++; run.sub = 0; } else run.sub = end;
      return;
    }
    const cp = s.codePointAt(run.sub);
    const len = cp > 0xffff ? 2 : 1;
    const ch = s.substr(run.sub, len);
    run.sub += len;
    if (run.sub >= s.length) { run.ip++; run.sub = 0; }
    this._emit(run, ch);
    if (cp >= 32 && cp !== 0x7f) run.due += wait;
  }

  /** Buffer display text for the current scope (or the \_s scopes); written at the next tag or step end. */
  _emit(run, s) {
    if (!s) return;
    if (CTRL.test(s)) { s = s.replace(CTRL_G, ''); if (!s) return; }
    const targets = run.sync || null;
    const key = targets ? targets.join(',') : String(run.scope);
    if (run.buf && run.bufKey !== key) this._flushText(run);
    run.buf += s;
    run.bufKey = key;
    run.bufTargets = targets || [run.scope];
    if (run.link && run.link.scope === run.scope) run.link.label += s;
  }

  _flushText(run) {
    if (!run.buf) return;
    const s = run.buf;
    run.buf = '';
    run.shown = true;             // SPBalloonWnd::AddString [disasm 0x5ccd90]
    for (const scope of run.bufTargets) {
      run.touched.add(scope);
      this._call(this._view(scope), 'write', s);
      if (!run.ff) this._talk(scope, s);
    }
  }

  /** `talk` SERIKO trigger: count visible characters written to a scope's balloon (CharacterView.onTalk). */
  _talk(scope, s) {
    let n = 0;
    for (const ch of s) if (!BLANK.test(ch)) n++;
    if (!n) return;
    const c = this._peekChar(scope);
    if (c) {
      if (typeof c.onTalk === 'function') this._call(c, 'onTalk', n);
      else if (typeof c.talk === 'function') this._call(c, 'talk', n);
    }
    this.emit('talk', { scope, count: n });
  }

  /** Text produced by a tag (\_u, \&, %variables): written like script text, one character wait each. */
  _emitChars(run, s) {
    if (!s) return;
    this._emit(run, s);
    let n = 0;
    for (const ch of s) if (ch.codePointAt(0) >= 32) n++;
    this._wait(run, n * this._charWait(run));
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /** The balloon of the current scope, for a tag that puts content into it. */
  _out(run) {
    run.touched.add(run.scope);
    return this._view(run.scope);
  }

  _view(scope) {
    if (!this.balloons) return null;
    this._scopes.add(scope);
    try { return this.balloons.get(scope); } catch (e) { log.once('sakura:balloon:' + scope, 'no balloon for scope', scope, e); return null; }
  }

  _char(scope) {
    if (!this.stage) return null;
    try { return this.stage.char(scope); } catch (e) { log.once('sakura:char:' + scope, 'no character for scope', scope, e); return null; }
  }

  /**
   * A tag that reaches ssp.exe's SPSerikoAnimation::PlayCommand (or PlayPatternArrayInternal) sets its "showed
   * something" flag on entry, whatever it changes on screen [disasm 0x6f9092, 0x6f947b] (PlayResult.shown, EV §3.4):
   * \![bind], \4 / \5, \![move] / \![moveasync] (cancel too), the SERIKO_SET options,
   * \![lock|unlock,repaint|balloonmove], \![enter|leave,selectmode] and every \![anim]. Only when the scopes' windows
   * exist (SSP checks that first).
   */
  _seriko(run, ...scopes) {
    if ((scopes.length ? scopes : [run.scope]).every(s => this._peekChar(s))) run.shown = true;
  }

  /** The character of a scope only if it was already created (talk triggers must not create windows). */
  _peekChar(scope) {
    const st = this.stage;
    if (!st) return null;
    try {
      const list = st.scopes;
      if (Array.isArray(list) && !list.includes(scope)) return null;
      return st.char(scope);
    } catch (e) { return null; }
  }

  /** Call an optional method of a view; missing methods are logged once, exceptions never escape. */
  _call(obj, method, ...args) {
    if (!obj) return undefined;
    const f = obj[method];
    if (typeof f !== 'function') { log.once('sakura:api:' + method, `view has no ${method}()`); return undefined; }
    try { return f.apply(obj, args); } catch (e) { log.once('sakura:err:' + method, `${method}() failed`, e); return undefined; }
  }

  _hostCall(method, ...args) {
    const f = this.host[method];
    if (typeof f !== 'function') return undefined;
    try { return f.apply(this.host, args); } catch (e) { log.once('sakura:host:' + method, `host.${method}() failed`, e); return undefined; }
  }

  /** Ignore a tag, reporting it to the host once per kind. */
  _ignore(key, raw) {
    if (this._reported.has(key)) return;
    this._reported.add(key);
    log.debug('ignored script tag', raw);
    this._hostCall('unknownTag', raw);
  }

  _anyVisible() {
    if (!this.balloons) return false;
    for (const s of this._scopes) {
      try { if (this.balloons.get(s).visible) return true; } catch (e) { /* ignore */ }
    }
    return false;
  }

  _linksVisible() {
    if (!this.balloons) return false;
    for (const s of this._scopes) {
      try {
        const v = this.balloons.get(s);
        if (v.visible && v.hasLinks !== false) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  _setScope(run, n) {
    if (run.buf) this._flushText(run);
    run.scope = n;
  }

  // ------------------------------------------------------------------------------------------------ links

  /**
   * A choice stops the script; the balloons stay as they are until the reply (UI §4.5): a reply that starts with \C
   * appends to them (SUM §2.2), any other reply clears them, and the event loop closes them when nothing is played.
   * Further choice clicks are ignored until the next run starts. The event loop routes the ID.
   * A run started in the same task as the click is its reply (another listener of the balloons, e.g. the event loop
   * playing a `script:` choice, got the click first): it is left alone.
   */
  _onLink(info) {
    if (!info || typeof info !== 'object') return;
    if (info.kind !== 'anchor') {
      const run = this.run;
      if (run && run !== this._fresh) {
        if (run.picked) return;
        run.picked = true;
        run.choiceDone = true;
        if (ACTIVE.has(run.state)) this._stop(run, 'interrupted');
      }
    }
    if (!info.label) {
      const label = this._labels.get(linkKey(info));
      if (label) info.label = label;
    }
    this.emit('link', info);
  }

  _onClick(e) {
    const run = this.run;
    if (!run || run.state !== 'clickwait' || (e && e.button)) return;
    this._call(this._view(run.clickScope), 'showClickWait', false);
    if (!run.clickNoClear) this._afterClick(run);
    run.t0 = this.clock.now();
    this._unblock(run);
  }

  /** After \x: clear every balloon (they stay open), scope 0, fonts reset (SS §5.5). */
  _afterClick(run) {
    for (const s of this._scopes) {
      const v = this._view(s);
      this._call(v, 'clear');
      this._call(v, 'setFont', 'default', '');
    }
    run.clearedAll = true;
    run.scope = 0;
  }

  /**
   * LinkInfo; without a label the balloon reports the link's own text (SS §5.6.2: title = textContent). A `script:`
   * ID runs re-joined with its references, as SSP's GetJumpString does (`jumpString`).
   */
  _linkInfo(kind, id, refs, label) {
    const info = { kind, id: id == null ? '' : String(id), refs };
    if (label !== undefined) info.label = label;
    const jump = jumpString(info.id, refs);
    if (jump !== null && /^script:/i.test(jump)) info.script = jump.slice(7);
    return info;
  }

  _beginLink(run, kind, args) {
    if (run.link) this._endLink(run);
    const info = this._linkInfo(kind, args[0], refList(args, 1));
    this._call(this._out(run), 'beginLink', info);
    run.shown = true;             // AddAnchorOrSelectable [disasm 0x5cdf59]
    run.link = { info, scope: run.scope, label: '' };
    if (kind === 'choice') run.hasChoices = true;
  }

  _endLink(run) {
    this._flushText(run);
    const l = run.link;
    run.link = null;
    const label = l.label.replace(/\s+/g, ' ').trim();
    if (label) {
      if (this._labels.size >= MAX_LABELS) this._labels.clear();
      this._labels.set(linkKey(l.info), label);
    }
    this._call(this._view(l.scope), 'endLink');
  }

  // ------------------------------------------------------------------------------------------------ tags

  _tag(run, tok, idx) {
    const a = tok.args;
    switch (tok.name) {
      // scope (SS §5.1)
      case '0': case 'h': this._setScope(run, 0); return;
      case '1': case 'u': this._setScope(run, 1); return;
      case 'p': {
        const n = a ? scopeNumber(a[0]) : null;
        if (n !== null) this._setScope(run, n);
        else log.once('sakura:p:' + (a ? a[0] : ''), 'bad scope', tok.raw);
        return;
      }
      // shell (SS §5.2); \s[a,b] is one string, a list of aliases the shell resolves (SH alias, SS §3.4)
      case 's': {
        if (!a) return;
        const s = String(a[0]).trim();
        if (!s) return;
        run.shown = true;         // SetSurfaceCharInternal -> SPSerikoAnimation::PlayCommand [disasm 0x6f9092]
        this._call(this._char(run.scope), 'setSurface', /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : s);
        return;
      }
      case 'i': {
        if (!a) return;
        const s = String(a[0]).trim();
        const id = /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : s;
        const c = this._char(run.scope);
        run.shown = true;         // PlayPatternArrayInternal [disasm 0x6f947b]
        this._call(c, 'startAnimation', id);
        if (lc(a[1]) === 'wait') this._waitAnimation(run, idx, c, id);
        return;
      }
      // balloon and text (SS §5.3)
      case 'b': {
        if (!a) return;
        const n = intPrefix(a[0], NaN);
        if (Number.isNaN(n)) { log.once('sakura:b:' + a[0], 'bad balloon id', tok.raw); return; }
        this._call(this._view(run.scope), 'setKind', n);
        return;
      }
      case 'n': this._call(this._out(run), 'newline', newlineRatio(a)); return;
      case '_n': {
        const on = !this._noWrap.get(run.scope);
        this._noWrap.set(run.scope, on);
        this._call(this._view(run.scope), 'setNoWrap', on);
        return;
      }
      case 'c': {
        const v = this._view(run.scope);
        const kind = a ? lc(a[0]) : '';
        if (kind === 'char' || kind === 'line') {
          const n = Math.max(0, num(a[1], 1));
          const start = a[2] != null && String(a[2]).trim() !== '' ? num(a[2], 0) : undefined;
          this._call(v, kind === 'char' ? 'clearChars' : 'clearLines', n, start);
        } else {
          this._call(v, 'clear');
          run.cleared.add(run.scope);
        }
        return;
      }
      case 'C':
        if (idx === run.cIndex) this._setScope(run, 0);
        else log.debug('\\C ignored: not at the start of the script');
        return;
      case '_l': if (a) this._call(this._out(run), 'locate', a[0] ?? '', a[1] ?? ''); return;
      case '_b': {
        if (!a || !a.length) return;
        const v = this._out(run);
        run.shown = true;         // AddImage [disasm 0x5d2062]
        if (lc(a[1]) === 'inline') {
          this._call(v, 'image', a[0], 'inline', '', a.slice(2));
          this._wait(run, this._charWait(run));
        } else this._call(v, 'image', a[0], a[1] ?? '', a[2] ?? '', a.slice(3));
        return;
      }
      case 'f': {
        if (!a || !a.length) return;
        this._call(this._view(run.scope), 'setFont', lc(a[0]), a.slice(1).join(','));
        return;
      }
      // \B, \U = \f[bold,toggle], \f[underline,toggle] [disasm 0x62ac6a; SS §5.4]
      case 'B': case 'U': this._call(this._view(run.scope), 'setFont', tok.name === 'B' ? 'bold' : 'underline', 'toggle'); return;
      // \_e hides the balloon (SPBalloonWnd::Hide), each \_s scope's while \_s is on [disasm 0x62aef3]
      case '_e':
        for (const s of run.sync || [run.scope]) this._call(this._view(s), 'hide');
        return;
      case 'l': case '_i': return;               // known to ssp.exe, do nothing there either [disasm 0x62be92]
      case '_c': if (a) this._ignore('_c', tok.raw); return;   // SSP plays SPShiori::GetSentence(a[0]) here; not done
      case '_u': if (a) this._emitChars(run, codeChar(a[0])); return;
      case '_m': if (a) this._emitChars(run, codeChar(a[0], true)); return;
      // ParseBracket's string as it is, SSP's 252 names (unknown, `#38`, `AMP` -> a space) [disasm 0x6292c5; SS §5.3]
      case '&': if (a) this._emitChars(run, charcodeReference(a[0])); return;
      case '_s':
        this._flushText(run);
        run.sync = run.sync ? null
          : a ? a.map(x => intPrefix(x, -1)).filter(x => x >= 0) : [0, 1];
        if (run.sync && !run.sync.length) run.sync = null;
        return;
      case '_?': case '_!': return;              // verbatim sections are handled by the tokenizer
      case '__v': this._ignore('__v', tok.raw); return;
      // waits and sections (SS §5.5, §6)
      case 'w': this._wait(run, waitMs(tok, 50)); return;
      case '_w': this._wait(run, a ? Math.max(0, num(a[0], 0)) : 0); return;
      case '__w': {
        if (!a) return;
        const k = lc(a[0]);
        if (k === 'clear') { run.t0 = Math.max(run.due, run.t0); return; }
        if (k === 'animation') { const c = this._char(run.scope); const s = String(a[1] ?? '').trim(); this._waitAnimation(run, idx, c, /^\d+$/.test(s) ? +s : s, true); return; }
        if (!run.ff) run.due = Math.max(run.due, run.t0 + Math.max(0, num(a[0], 0)));
        return;
      }
      case 'x': {
        const noclear = !!a && lc(a[0]) === 'noclear';
        if (run.ff) { if (!noclear) this._afterClick(run); return; }
        run.clickScope = run.scope;
        run.clickNoClear = noclear;
        this._call(this._view(run.scope), 'showClickWait', true);
        this._block(run, idx, 'clickwait');
        return;
      }
      case 't': run.timeCritical = true; return;
      case '_q': run.quick = !run.quick; return;
      case '*': run.noChoiceTimeout = true; run.star = true; return;
      case 'e': case 'y': case 'z': this._finish(run); return;   // one handler in ssp.exe [disasm 0x62bea9]
      // choices and anchors (SS §5.6)
      case 'q': {
        if (!a) return;
        let title, id, refs;
        if (tok.form === 'bracket2') { id = a[0]; title = a[1] ?? ''; refs = []; }
        else { title = a[0] ?? ''; id = a[1] ?? ''; refs = refList(a, 2); }
        // the title as written: ssp.exe expands nothing inside a tag's bracket (properties.md §2) [disasm 0x63657B]
        const v = this._out(run);
        this._call(v, 'addChoice', title, this._linkInfo('choice', id, refs, title));
        run.hasChoices = true;
        run.shown = true;         // AddSelectableString [disasm 0x5cdbf3]
        if (tok.form === 'bracket2') this._call(v, 'newline', 1);
        this._wait(run, this._charWait(run));
        return;
      }
      case '__q':
        if (a) this._beginLink(run, 'choice', a);
        else if (run.link && run.link.info.kind === 'choice') this._endLink(run);
        return;                                  // a stray close is a no-op (220 in Tsubasa's corpus)
      case '_a':
        if (a) this._beginLink(run, 'anchor', a);
        else if (run.link && run.link.info.kind === 'anchor') this._endLink(run);
        return;
      // control (SS §5.7)
      case '-':
        this._flushText(run);
        this._hostCall('quit');
        this._stop(run, 'quit');
        return;
      case '+': this._hostCall('change', 'ghost', ['random']); return;
      case '_+': this._hostCall('change', 'ghost', ['sequential']); return;
      case 'j': {
        const url = a ? String(a[0]).trim() : '';
        if (/^(https?:|mailto:|file:)/i.test(url)) this._hostCall('openUrl', url);
        else this._ignore('j', tok.raw);
        return;
      }
      // sound (SS §5.8)
      case '_v': case '8': if (a && String(a[0]).trim()) this._hostCall('sound', 'play', [a[0]]); return;
      case '_V': this._soundWait(run, idx); return;
      // legacy boxes (SS §5.9): the same as \![open,communicatebox] / \![open,teachbox]
      case '__c': this._hostCall('openBox', 'communicatebox', []); return;
      case '__t': this._hostCall('openBox', 'teachbox', []); return;
      // move away from / next to the other character (UI §3.8)
      case '4': case '5': this._approach(run, idx, tok.name === '5'); return;
      case '!': this._bang(run, tok, idx); return;
      default:
        // \v \6 \7 \a \m: parsed, no effect here
        this._ignore(tok.name, tok.raw);
    }
  }

  _waitAnimation(run, idx, c, id, isW = false) {
    if (!c || typeof c.isAnimating !== 'function' || run.ff) return;
    const start = this.clock.now();
    const done = () => {
      if (this.clock.now() - start > MAX_ANIM_WAIT_MS) { log.once('sakura:animwait', 'animation wait gave up', id); return true; }
      try { return !c.isAnimating(id); } catch (e) { return true; }
    };
    if (done()) return;
    this._block(run, idx, isW ? 'wait-animation' : 'animation');
    const tick = () => {
      run.pollTimer = null;
      if (this.run !== run || run.state !== 'blocked') return;
      if (done()) this._unblock(run);
      else run.pollTimer = this.clock.setTimer(tick, POLL_MS);
    };
    run.pollTimer = this.clock.setTimer(tick, POLL_MS);
  }

  _soundWait(run, idx) {
    const r = this._hostCall('sound', 'wait', []);
    if (!r || typeof r.then !== 'function' || run.ff) return;
    this._block(run, idx, 'sound');
    r.then(() => this._unblock(run), () => this._unblock(run));
  }

  /**
   * \![change,shell|balloon,…] happens at the tag (EV §2.6) [disasm]: when the host returns a thenable, the script waits
   * there until the swap is done and goes on with the new shell or balloon. A fast-forwarded replay never waits (the
   * tag is a side effect and is skipped anyway).
   */
  _changeWait(run, idx, r) { this._settleWait(run, idx, r, 'change'); }

  /** A host's thenable holds the run at the tag until it settles (never during a fast-forward replay). */
  _settleWait(run, idx, r, kind) {
    if (!r || typeof r.then !== 'function' || run.ff) return;
    this._block(run, idx, kind);
    r.then(() => this._unblock(run), () => this._unblock(run));
  }

  /**
   * \![execute,http-*] without --async (EV §4.15) [disasm]: the script stops at the tag until the request is over and
   * its event's reply has started (a non-empty reply replaced the run meanwhile, as SSP raises the event inside the
   * tag); then it goes on with its \__w base at the tag's end (SSP's ResetWait after the tag). A replay never sends it
   * (a side effect, SS §7).
   */
  _httpWait(run, idx, r) { this._resetWait(run, idx, r, 'http'); }

  /**
   * _settleWait, then the \__w base at the tag's end, as ssp.exe's ResetWait after the tag (\![execute,http-*],
   * \![reload,…]: ExecuteExclamationTag's common exit [disasm 0x632cf0]).
   */
  _resetWait(run, idx, r, kind) {
    if (!r || typeof r.then !== 'function' || run.ff) return;
    this._block(run, idx, kind);
    const done = () => {
      if (this.run === run && run.state === 'blocked' && run.blockKind === kind) run.t0 = this.clock.now();
      this._unblock(run);
    };
    r.then(done, done);
  }

  // ------------------------------------------------------------------------------------------------ \![...]

  _bang(run, tok, idx) {
    const a = tok.args;
    if (!a || !a.length) return;
    const cmd = lc(a[0]);
    const sub = lc(a[1]);
    switch (cmd) {
      case '*': this._marker(run); return;
      case 'raise': this._raise(run, idx, a[1], refList(a, 2), {}); return;
      case 'embed': this._raise(run, idx, a[1], refList(a, 2), { embed: true }); return;
      case 'notify': this._raise(run, idx, a[1], refList(a, 2), { notify: true }); return;
      case 'timerraise': case 'timernotify': {
        const id = a[3] == null ? '' : String(a[3]);
        if (!id.trim()) { log.once('sakura:timer:noid', 'timer without event', tok.raw); return; }
        const ms = Math.max(0, num(a[1], 0));
        // SUM C3 as amended: SSP's ParseBool, 1 = once, anything else (0, false, empty, garbage) = repeat [disasm
        // 0x632E80, 0x789660]
        const repeat = parseBool(a[2]) !== 1;
        // refs as ParametersToArray: SSP copies them up to the first empty one and fires through ExecuteRaiseReal
        // (SS §6.6) [disasm]
        this._hostCall('timerRaise', ms, repeat, id, refList(a, 4), cmd === 'timernotify' ? { notify: true } : undefined);
        return;
      }
      case 'raiseother': case 'notifyother':
        // another ghost's event (EV §2.7.9): the host routes it later, the script never waits [disasm 0x6333F5];
        // `\![raiseother]` alone passes no ghost (SSP's `invalid`), an empty event is the host's to refuse (C2)
        if (typeof this.host.raiseOther !== 'function') this._ignore('!' + cmd, tok.raw);
        else this._hostCall('raiseOther', a[1], a[2] ?? '', refList(a, 3), { notify: cmd === 'notifyother' });
        return;
      case 'timerraiseother': case 'timernotifyother': {
        // ms, repeat, ghost, event, r…: without an event SSP ignores the tag [disasm 0x632EBC, 0x632F33]; the timer
        // is the raiser's, keyed by the event like the others (SS §6.6)
        const id = a[4] == null ? '' : String(a[4]);
        if (a.length < 5 || !id.trim()) { log.once('sakura:timer:noid', 'timer without event', tok.raw); return; }
        this._hostCall('timerRaise', Math.max(0, num(a[1], 0)), parseBool(a[2]) !== 1, id, refList(a, 5),
          { notify: cmd === 'timernotifyother', to: String(a[3] ?? '') });
        return;
      }
      case 'bind': case 'bind-noevent': {
        const v = bindValue(a[3]);
        if (v === null) { log.once('sakura:bindvalue:' + a[3], 'bind value is not 0/1/empty:', tok.raw); return; }
        // SSP queues the bind and plays it (QueueBindBlock) at the next wait, text, bind or the script's end [disasm
        // ProcessLazyCommandExec 0x63e8b0]; counted at the tag [infer]
        this._seriko(run);
        const c = this._char(run.scope);
        if (cmd === 'bind') this._call(c, 'bind', a[1] ?? '', a[2] ?? '', v);
        else this._call(c, 'bind', a[1] ?? '', a[2] ?? '', v, { noEvent: true });
        return;
      }
      case 'move': case 'moveasync': this._move(run, idx, a.slice(1), cmd === 'move'); return;
      case 'set': this._set(run, tok, idx, sub, a.slice(2)); return;
      case 'quicksection': {
        const v = sub;
        run.quick = v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : !run.quick;
        return;
      }
      case 'open': {
        if (BOX_KINDS.has(sub)) this._hostCall('openBox', sub, a.slice(2));
        else if (sub === 'browser' && String(a[2] ?? '').trim()) this._hostCall('openUrl', String(a[2]).trim());
        else if (sub === 'mailer' && String(a[2] ?? '').trim()) this._hostCall('openUrl', 'mailto:' + String(a[2]).trim());
        else if (sub.startsWith('con') && typeof this.host.openWindow === 'function') {
          // SSP's settings dialog: `con` and any longer prefix of configurationdialog… in any case, PAGE as given
          // (SS §5.9) [disasm table 0xBBD448, 0x62D830]; the script goes on (a modeless dialog [disasm 0x46CAE0]). A
          // page without a box is the host's to log
          this._hostCall('openWindow', 'configurationdialog', a.slice(2));
        } else this._ignore('!open,' + sub, tok.raw);
        return;
      }
      case 'close':
        if (BOX_KINDS.has(sub) || sub === 'dialog') this._hostCall('closeBox', sub, a.slice(2));
        else this._ignore('!close,' + sub, tok.raw);
        return;
      case 'change':
        if (sub === 'ghost' || sub === 'shell' || sub === 'balloon') this._changeWait(run, idx, this._hostCall('change', sub, a.slice(2)));
        else this._ignore('!change,' + sub, tok.raw);
        return;
      case 'call':
        // \![call,ghost,…] (EV §2.7): the script never waits for the callee (no BreakScript, unlike a change [disasm])
        if (sub === 'ghost') this._hostCall('call', sub, a.slice(2));
        else this._ignore('!call,' + sub, tok.raw);
        return;
      case 'vanishbymyself': this._hostCall('vanish'); return;
      case 'sound':
        if (sub === 'wait') this._soundWait(run, idx);
        else this._hostCall('sound', sub, a.slice(2));
        return;
      case 'get':
        if (sub === 'property' && typeof this.host.raiseProperty === 'function') this._getProperty(run, idx, a);
        else this._ignore('!get,' + sub, tok.raw);
        return;
      case 'anim': {
        if (ANIM_CMDS.has(sub)) this._seriko(run);   // each one: ControlAnimeChar -> PlayPatternArray [disasm 0x6e9d50]
        const c = this._char(run.scope);
        const s = String(a[2] ?? '').trim();
        const id = /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : s;
        if (c && typeof c.anim === 'function' && ANIM_CMDS.has(sub)) {
          this._call(c, 'anim', id, sub, ...(sub === 'offset' ? [num(a[3], 0), num(a[4], 0)] : a.slice(3)));
        } else if (sub === 'start') this._call(c, 'startAnimation', id);
        else if (sub === 'clear' || sub === 'stop') this._call(c, 'stopAnimation', id);
        else if (sub === 'pause' && c && typeof c.pauseAnimation === 'function') this._call(c, 'pauseAnimation', id);
        else if (sub === 'resume' && c && typeof c.resumeAnimation === 'function') this._call(c, 'resumeAnimation', id);
        else if (sub === 'offset' && c && typeof c.offsetAnimation === 'function') this._call(c, 'offsetAnimation', id, num(a[3], 0), num(a[4], 0));
        else this._ignore('!anim,' + sub, tok.raw);
        return;
      }
      case 'enter': case 'leave':
        if (sub === 'selectmode') this._seriko(run);   // EnterSelectMode [disasm 0x62f4bf, 0x630583]
        // passivemode, inductionmode, selectmode ... belong to the runtime: setOption('enter'|'leave', [mode, ...])
        if (sub === 'nouserbreakmode') run.userBreakDisabled = cmd === 'enter';
        else if (sub) this._hostCall('setOption', cmd, [sub, ...a.slice(2)]);
        return;
      case 'execute':
        if (sub === 'resetwindowpos' && this.stage && typeof this.stage.resetPositions === 'function') this._call(this.stage, 'resetPositions');
        else if (sub.startsWith('htt') && typeof this.host.httpExecute === 'function') {
          const r = this._hostCall('httpExecute', a[1] ?? '', a.slice(2));
          if (r === false) this._ignore('!execute,' + sub, tok.raw);
          else this._httpWait(run, idx, r);
        } else this._ignore('!execute,' + sub, tok.raw);
        return;
      case 'cancel':
        // \![cancel,http|rss|ical|websocket,URL] (EV §4.15): the host aborts a threaded request of that URL
        if (/^(htt|rss|ica|web)/.test(sub) && typeof this.host.httpCancel === 'function') this._hostCall('httpCancel', a[1] ?? '', a.slice(2));
        else this._ignore('!cancel,' + sub, tok.raw);
        return;
      case 'lock': case 'unlock':
        // repaint locks: painting is batched per frame anyway; the balloon move lock is not done. Both count as shown
        // (LockRedrawChar, SetBalloonUserLockChar) [disasm 0x6304ba, 0x630404, 0x6327b6, 0x6327ec]
        if (sub === 'repaint' || sub === 'balloonmove') this._seriko(run);
        return;
      case 'reloadsurface': case 'reload': {
        // \![reload,shiori|shell|balloon|ghost], \![reloadsurface] = reload,shell (EV §2.10) [disasm
        // ExecuteExclamationTag 0x6313a8–0x631419]: shiori, shell and balloon at the tag (a thenable holds the run), ghost
        // posts a change to itself and never holds it. Every sub-command, a no-op one too, ends in the handler's
        // ResetWait (0x632cf0): the \__w base is the tag's end. ssp.exe takes any `rel…` prefix; only `reload` here, as
        // `change` [decision: no corpus ghost spells it otherwise]
        const what = cmd === 'reloadsurface' ? 'shell' : sub;
        let r;
        if (!RELOADS.has(what) || typeof this.host.reload !== 'function') this._ignore('!reload,' + what, tok.raw);
        else r = this._hostCall('reload', what);
        if (r && typeof r.then === 'function') this._resetWait(run, idx, r, 'reload');
        else if (!run.ff) run.t0 = this.clock.now();
        return;
      }
      default:
        // raiseplugin/..., updatebymyself, reset, effect, filter, wait,syncobject ...: no-ops
        this._ignore('!' + cmd, tok.raw);
    }
  }

  _set(run, tok, idx, sub, rest) {
    if (SERIKO_SET.has(sub)) this._seriko(run);
    switch (sub) {
      case 'property':
        // \![set,property,NAME,VALUE] (properties.md §4) [disasm 0x62E300–0x62E369]: nothing without VALUE (it may be
        // empty), later arguments dropped, the result never seen; a thenable holds the run (Set is synchronous)
        if (typeof this.host.setProperty !== 'function') this._ignore('!set,property', tok.raw);
        else if (rest.length >= 2) {
          this._settleWait(run, idx, this._hostCall('setProperty', String(rest[0]), String(rest[1])), 'property');
        }
        return;
      case 'alignmenttodesktop': case 'alignmentondesktop': {
        const mode = alignmentMode(rest[0]);
        if (mode) this._call(this._char(run.scope), 'setAlignment', mode);
        else log.once('sakura:align:' + rest[0], 'unknown alignment', tok.raw);
        return;
      }
      case 'scaling': {
        // \![set,scaling,S] or SX,SY[,time][,--wait]; percent, negative = mirror (SUM C18: P1)
        const sx = num(rest[0], NaN);
        if (Number.isNaN(sx)) return;
        const sy = num(rest[1], sx);
        this._call(this._char(run.scope), 'setScaling', sx, sy);
        return;
      }
      case 'balloonwait': run.charWait = parseBalloonWait(rest[0]); return;
      case 'windowstate': {
        const s = lc(rest[0]);
        if (s === 'minimize' || s === 'restore') this._hostCall('windowState', s);
        else this._ignore('!set,windowstate,' + s, tok.raw);
        return;
      }
      default:
        // choicetimeout, balloontimeout, autoscroll, balloonoffset, wallpaper, alpha, zorder ...: runtime-owned
        this._hostCall('setOption', sub, rest);
    }
  }

  _marker(run) {
    const v = this._out(run);
    run.shown = true;             // AddMarkerIcon [disasm 0x5cd9cc]
    if (v && typeof v.marker === 'function') this._call(v, 'marker');
    else this._ignore('marker', '\\![*]');
    this._wait(run, this._charWait(run));
  }

  /** `%*`, the only %-variable the tokenizer leaves as a token: the marker, as \![*] (SS §3.5). */
  _env(run, tok) {
    if (tok.name === '*') this._marker(run);
  }

  /**
   * \![get,property,EV,NAME…] (properties.md §3) [disasm 0x62DFA4–0x62E2FD]: nothing below one NAME; the host reads
   * every NAME now and sends GET EV with the values (SenderType internal,property); the run waits for the reply as for
   * \![raise], and a non-empty reply replaces it. An empty EV is no event [decision] (ssp.exe would send it).
   */
  _getProperty(run, idx, a) {
    if (a.length < 4) return;
    const id = a[2] == null ? '' : String(a[2]);
    if (!id.trim()) { log.once('sakura:raise:noid', 'raise without event'); return; }
    let p;
    try {
      p = Promise.resolve(this.host.raiseProperty(id, a.slice(3).map(String)));
    } catch (e) {
      p = Promise.reject(e);
    }
    this._block(run, idx, 'raise');
    p.then(v => this._raiseDone(run, v, false), e => {
      log.warn('get,property failed', id, e);
      this._raiseDone(run, null, false);
    });
  }

  /**
   * \![raise] waits for the reply (a non-empty one replaces the run; the host plays it), except OnDirectSaoriCall,
   * which Satori always answers with 204 and which must not stall the script (SUM C25). \![embed] splices its reply
   * in place; \![notify] never waits.
   */
  _raise(run, idx, id, refs, { embed = false, notify = false }) {
    id = id == null ? '' : String(id);
    if (!id.trim()) { log.once('sakura:raise:noid', 'raise without event'); return; }
    if (embed && run.ff) {
      this._splice(run, run.embedQueue && run.embedQueue.length ? run.embedQueue.shift() : '');
      return;
    }
    const wait = !notify && id.trim() !== SAORI_RAISE;
    if (typeof this.host.raise !== 'function') return;
    let p;
    try {
      p = Promise.resolve(this.host.raise(id, refs, { notify, embed, waitReply: wait }));
    } catch (e) {
      p = Promise.reject(e);
    }
    if (!wait) {
      p.catch(e => log.warn('raise failed', id, e));
      return;
    }
    this._block(run, idx, embed ? 'embed' : 'raise');
    p.then(v => this._raiseDone(run, v, embed), e => {
      log.warn('raise failed', id, e);
      this._raiseDone(run, null, embed);
    });
  }

  _raiseDone(run, value, embed) {
    if (this.run !== run || run.state !== 'blocked') return;
    const s = value == null ? '' : String(value);
    if (embed) {
      this._splice(run, s);
      this._unblock(run);
    } else if (s !== '') {
      this._stop(run, 'replaced');
    } else {
      this._unblock(run);
    }
  }

  _splice(run, s) {
    if (run.embeds.length >= MAX_EMBEDS) { log.once('sakura:embeds', 'too many \\![embed] in one script'); return; }
    run.embeds.push(s);
    if (!s) return;
    const toks = tokenize(s);
    if (toks.length) run.tokens.splice(run.ip, 0, ...toks);
  }

  // ------------------------------------------------------------------------------------------------ \![move]

  _viewport() {
    let vp = null;
    try { vp = this.viewport(); } catch (e) { /* ignore */ }
    return { width: (vp && vp.width) || 0, height: (vp && vp.height) || 0 };
  }

  _moveBase(base, me) {
    const b = lc(base);
    if (b === 'me') return me;
    if (/^\d+$/.test(b)) {
      const c = this._char(parseInt(b, 10));
      if (c && c.rect) return { rect: c.rect, basePoint: c.basePoint };
    } else if (b && b !== 'screen' && b !== 'primaryscreen' && b !== 'global') {
      log.once('sakura:move:base:' + b, 'move base not supported, using the viewport:', base);
    }
    const vp = this._viewport();
    return { rect: { x: 0, y: 0, width: vp.width, height: vp.height } };
  }

  /**
   * \4 / \5 (UI §3.8): the current scope's character moves sideways away from the other character (scope 1 for scope
   * 0, scope 0 for every other scope [guess]) or until it touches it (approachTarget), as a blocking, instant \![move]:
   * it waits for a surface size still loading, and docking and the saved position work as for any script move.
   * Nothing happens while the other character is not shown. A mover hidden by \s[-1] (its rect is 0×0 at the base
   * point) moves with the size it was last shown with (view.lastRect), so it reappears touching, and inside the
   * viewport; one never shown does not move.
   */
  _approach(run, idx, near) {
    const other = run.scope === 0 ? 1 : 0;
    this._seriko(run, run.scope, other);    // MoveCharAwayClose needs both windows, shown or not [disasm 0x626bdd]
    const ov = this._peekChar(other);
    let shown = false;
    try { shown = !!ov && ov.visible !== false; } catch (e) { shown = false; }
    if (!shown) { log.debug(`\\${near ? 5 : 4}: scope ${other} is not shown, nothing to move against`); return; }
    const m = { ...parseMoveArgs([]), base: String(other) };     // base: also wait for the other's size
    this._move(run, idx, m, true, (me, view) => {
      let rect = null;
      try { rect = ov.rect; } catch (e) { rect = null; }
      if (!rect) return null;
      if (!(me.rect.width > 0 || me.rect.height > 0)) {
        let last = null, visible = false;
        try { last = view.lastRect; visible = view.visible !== false; } catch (e) { /* ignore */ }
        if (last) me = { rect: last, basePoint: me.basePoint };
        else if (!visible) { log.debug(`\\${near ? 5 : 4}: scope ${run.scope} was never shown, no size to move with`); return null; }
      }
      return approachTarget(near, me, rect, this._viewport());
    });
  }

  /**
   * \![move] blocks until it arrives; \![moveasync] does not; \![moveasync,cancel] stops async moves.
   * Right after a \s whose images are still loading, the view's rect / basePoint describe the previous surface
   * (CharacterView.geometryPending): the target is computed once geometryReady() resolves (a \![move] blocks the
   * script meanwhile). Known geometry, the usual case, keeps the move synchronous on the virtual clock.
   */
  _move(run, idx, args, blocking, calc = null) {
    const m = Array.isArray(args) ? parseMoveArgs(args) : args;
    this._seriko(run);                      // ExecuteMoveTag, ExecuteMoveTagCancel [disasm 0x70086c, 0x70089c]
    if (m.cancel) {
      for (const mv of this._asyncMoves) this._endMove(mv, false);
      return;
    }
    const view = this._char(run.scope);
    if (!view) return;
    const mv = { view, m, calc, from: null, to: null, start: 0, dur: m.time, timer: null, wait: null, jump: false,
      done: false, run: blocking ? run : null };
    const pending = this._pendingGeometry(view, m);
    if (!pending.length) {
      if (!this._moveTarget(mv)) return;
      if (!(m.time > 0)) { this._call(view, 'moveTo', mv.to.x, mv.to.y); return; }
    }
    if (blocking) { run.move = mv; this._block(run, idx, 'move'); } else this._asyncMoves.add(mv);
    if (pending.length) this._awaitGeometry(mv, pending);
    else this._animateMove(mv);
  }

  /** The views of a move (the moved one, a scope used as base) whose surface size is still loading. */
  _pendingGeometry(view, m) {
    const out = [];
    const add = v => {
      let pending = false;
      try { pending = !!v && v.geometryPending === true && typeof v.geometryReady === 'function'; } catch (e) { /* ignore */ }
      if (pending && !out.includes(v)) out.push(v);
    };
    add(view);
    const b = lc(m.base);
    if (/^\d+$/.test(b)) add(this._char(parseInt(b, 10)));
    return out;
  }

  /** Start `mv` once every view in `views` knows its geometry (or after GEOMETRY_WAIT_MS with what they have). */
  _awaitGeometry(mv, views) {
    const w = { timer: null };
    mv.wait = w;
    const go = timedOut => {
      if (mv.wait !== w || this._destroyed) return;
      mv.wait = null;
      if (w.timer) { this.clock.clearTimer(w.timer); w.timer = null; }
      if (timedOut) log.once('sakura:move:geometry', 'surface size still unknown: moving with the previous one');
      if (!mv.done) { this._startMove(mv); return; }
      // the run was aborted while waiting: put the window at its target, as for a move in progress
      if (mv.jump && this._moveTarget(mv)) this._call(mv.view, 'moveTo', mv.to.x, mv.to.y);
    };
    w.timer = this.clock.setTimer(() => { w.timer = null; go(true); }, GEOMETRY_WAIT_MS);
    const ready = views.map(v => {
      try { return Promise.resolve(v.geometryReady()); } catch (e) { return Promise.resolve(); }
    });
    Promise.all(ready).then(() => go(false), () => go(false));
  }

  /**
   * Compute mv.from / mv.to from the view's current rect and base point; false when it has none, or when
   * mv.calc(me, view) (the target of a \4 / \5) says there is nothing to do.
   */
  _moveTarget(mv) {
    const view = mv.view;
    let me;
    try { me = { rect: view.rect, basePoint: view.basePoint }; } catch (e) { me = null; }
    if (!me || !me.rect || !me.basePoint) { log.once('sakura:move:norect', 'cannot move: no character rect'); return false; }
    const to = mv.calc ? mv.calc(me, view) : moveTarget(mv.m, me, this._moveBase(mv.m.base, me));
    if (!to) return false;
    mv.from = { x: me.basePoint.x, y: me.basePoint.y };
    mv.to = { x: Math.round(to.x), y: Math.round(to.y) };
    return true;
  }

  /** A move whose geometry just became known: at once (time 0) or animated. */
  _startMove(mv) {
    if (!this._moveTarget(mv)) { this._endMove(mv, false); return; }
    if (!(mv.dur > 0)) {
      this._call(mv.view, 'moveTo', mv.to.x, mv.to.y);
      this._endMove(mv, false);
      return;
    }
    this._animateMove(mv);
  }

  _animateMove(mv) {
    const { view, from, to } = mv;
    mv.start = this.clock.now();
    const tick = () => {
      mv.timer = null;
      if (mv.done) return;
      const p = Math.min(1, (this.clock.now() - mv.start) / mv.dur);
      this._call(view, 'moveTo', Math.round(from.x + (to.x - from.x) * p), Math.round(from.y + (to.y - from.y) * p));
      if (p >= 1) this._endMove(mv, false);
      else mv.timer = this.clock.setTimer(tick, MOVE_FRAME_MS);
    };
    mv.timer = this.clock.setTimer(tick, MOVE_FRAME_MS);
  }

  /**
   * Finish a move; `jump` puts the window at its target (used when the run is aborted mid-move; a move still
   * waiting for its geometry jumps once that arrives). Without `jump` a pending geometry wait is dropped.
   */
  _endMove(mv, jump) {
    if (mv.done) return;
    mv.done = true;
    if (mv.timer) { this.clock.clearTimer(mv.timer); mv.timer = null; }
    if (jump && mv.wait) mv.jump = true;
    else if (jump) this._call(mv.view, 'moveTo', mv.to.x, mv.to.y);
    else if (mv.wait) {
      if (mv.wait.timer) this.clock.clearTimer(mv.wait.timer);
      mv.wait = null;
    }
    this._asyncMoves.delete(mv);
    const run = mv.run;
    if (run && run.move === mv) {
      run.move = null;
      if (!jump) this._unblock(run);
    }
  }
}

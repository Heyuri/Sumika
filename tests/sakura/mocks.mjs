// Recording mocks of Stage / Balloons / PlayerHost (docs/CONTRACTS.md) for the player tests.
import { Emitter } from '../../src/core/emitter.js';
import { ScriptPlayer } from '../../src/sakura/player.js';
import { ManualClock } from '../../src/sakura/clock.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NONBLANK = /[^ \u3000\t]/;

class MockView extends Emitter {
  constructor(scope, rec) {
    super();
    this.scope = scope; this.rec = rec;
    this.visible = false; this.kind = 0; this.links = 0; this.choices = 0; this.text = '';
  }
  _r(...a) { this.rec.log.push(['b', this.scope, ...a]); }
  setKind(n) { this._r('setKind', n); if (n < 0) this.visible = false; else this.kind = n; }
  resetKind() { this._r('resetKind'); this.kind = 0; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  clear() { this._r('clear'); this.text = ''; this.links = 0; this.choices = 0; }
  clearChars(n, s) { this._r('clearChars', n, s); }
  clearLines(n, s) { this._r('clearLines', n, s); }
  write(t) { this._r('write', t); this.text += t; if (NONBLANK.test(t)) this.visible = true; }
  newline(r = 1) { this._r('newline', r); this.text += '\n'; }
  locate(x, y) { this._r('locate', x, y); }
  image(p, x, y, o) { this._r('image', p, x, y, o); this.visible = true; }
  setFont(k, v) { this._r('setFont', k, v); }
  setNoWrap(on) { this._r('setNoWrap', on); }
  marker() { this._r('marker'); this.visible = true; }
  beginLink(info) { this._r('beginLink', info.kind, info.id, info.refs); this.links++; if (info.kind !== 'anchor') this.choices++; this.openInfo = info; }
  endLink() { this._r('endLink'); }
  addChoice(label, info) { this._r('addChoice', label, info.id, info.refs); this.links++; this.choices++; this.visible = true; this.lastChoice = info; }
  get hasLinks() { return this.links > 0; }
  get hasChoices() { return this.choices > 0; }
  showClickWait(on) { this._r('showClickWait', on); }
}

class MockBalloons extends Emitter {
  constructor(rec) { super(); this.rec = rec; this.views = new Map(); }
  get(scope) {
    let v = this.views.get(scope);
    if (!v) { v = new MockView(scope, this.rec); this.views.set(scope, v); }
    return v;
  }
  hideAll() { this.rec.log.push(['hideAll']); for (const v of this.views.values()) v.visible = false; }
  get hovered() { return false; }
  /** Balloons#choosing: a choice item in any balloon, shown or not, while one is up (Status choosing, EV §1.6). */
  get choosing() {
    let c = false, vis = false;
    for (const v of this.views.values()) { c = c || v.hasChoices; vis = vis || v.visible; }
    return c && vis;
  }
}

class MockChar extends Emitter {
  constructor(scope, rec) {
    super();
    this.scope = scope; this.rec = rec; this.surfaceId = -1; this.anims = new Set();
    this.base = { x: 100 + scope, y: 300 };
    this.size = { width: 50, height: 60 };
  }
  _r(...a) { this.rec.log.push(['c', this.scope, ...a]); }
  setSurface(id) { this._r('setSurface', id); this.surfaceId = id; return true; }
  startAnimation(id) { this._r('startAnimation', id); this.anims.add(id); }
  stopAnimation(id) { this._r('stopAnimation', id); this.anims.delete(id); }
  isAnimating(id) { return this.anims.has(id); }
  stopAllAnimations() { this.anims.clear(); }
  bind(cat, part, value, opts) { this._r('bind', cat, part, value, ...(opts ? [opts] : [])); }
  getBinds() { return []; }
  get rect() { return { x: this.base.x - this.size.width / 2, y: this.base.y - this.size.height, ...this.size }; }
  get basePoint() { return { ...this.base }; }
  get balloonOffset() { return { x: 0, y: 0 }; }
  moveTo(x, y) { this._r('moveTo', x, y); this.base = { x, y }; }
  setAlignment(m) { this._r('setAlignment', m); }
  setScaling(sx, sy) { this._r('setScaling', sx, sy); }
  onTalk(n) { this.rec.talk += n; }                 // the shell's hook name (src/shell/character.js)
  show() {} hide() {}
  get visible() { return this.surfaceId !== -1; }
}

class MockStage extends Emitter {
  constructor(rec) { super(); this.rec = rec; this.chars = new Map(); }
  char(scope) {
    let c = this.chars.get(scope);
    if (!c) { c = new MockChar(scope, this.rec); this.chars.set(scope, c); }
    return c;
  }
  get scopes() { return [...this.chars.keys()]; }
}

/**
 * @param {{raise?: (id, refs, opts) => any, raiseProperty?: (id, names) => any, setProperty?: (name, value) => any,
 *          openWindow?: (kind, args) => any, sound?: Function, speedMs?: number, viewport?: {width, height}}} o
 */
export function setup(o = {}) {
  const rec = { log: [], host: [], talk: 0 };
  const clock = new ManualClock(0);
  const stage = new MockStage(rec);
  const balloons = new MockBalloons(rec);
  const h = (name, ret) => (...args) => { rec.host.push([name, ...args]); rec.log.push(['h', name, ...args]); return typeof ret === 'function' ? ret(...args) : ret; };
  const host = {
    raise: h('raise', (id, refs, opts) => (o.raise ? o.raise(id, refs, opts) : Promise.resolve(null))),
    timerRaise: h('timerRaise'),
    openUrl: h('openUrl'),
    sound: h('sound', o.sound),
    setOption: h('setOption'),
    openBox: h('openBox'),
    closeBox: h('closeBox'),
    windowState: h('windowState'),
    change: h('change'),
    quit: h('quit'),
    vanish: h('vanish'),
    raiseProperty: h('raiseProperty', (id, names) => (o.raiseProperty ? o.raiseProperty(id, names)
      : Promise.resolve(null))),
    setProperty: h('setProperty', o.setProperty),
    openWindow: h('openWindow', o.openWindow || (() => true)),
    unknownTag: h('unknownTag'),
  };
  const viewport = () => o.viewport || { width: 1000, height: 800 };
  const player = new ScriptPlayer({ stage, balloons, host, clock, speedMs: o.speedMs ?? 50, viewport });
  return { rec, clock, stage, balloons, host, player };
}

// shell calls that replay skips because their result is persisted separately (SS §7)
const SIDE_EFFECTS = new Set(['bind', 'moveTo', 'setAlignment', 'setScaling', 'startAnimation', 'stopAnimation']);

/** Display calls only (balloons, surfaces), with consecutive writes to one view merged (batching differs by speed). */
export function displayLog(log) {
  const out = [];
  for (const e of log) {
    if (e[0] === 'h' || (e[0] === 'c' && SIDE_EFFECTS.has(e[2]))) continue;
    if (e[0] === 'b' && e[2] === 'showClickWait') continue;        // transient marker of past click waits
    const last = out[out.length - 1];
    if (e[0] === 'b' && e[2] === 'write' && last && last[0] === 'b' && last[2] === 'write' && last[1] === e[1]) {
      out[out.length - 1] = ['b', e[1], 'write', last[3] + e[3]];
    } else out.push(e.slice());
  }
  return out;
}

export const CORPUS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../corpus');
export const CORPUS_FILES = ['final_master.res.txt', 'final_bath.res.txt', 'final_date.res.txt', 'final_meal.res.txt'];

/** Every "VALUE <script>" line of the four corpus files: [{file, request, script}]. */
export function loadCorpus() {
  const out = [];
  for (const f of CORPUS_FILES) {
    const p = path.join(CORPUS_DIR, f);
    let request = '';
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const l = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (l.startsWith('=== ')) request = l.slice(4);
      else if (l.startsWith('VALUE ')) out.push({ file: f, request, script: l.slice(6) });
    }
  }
  return out;
}

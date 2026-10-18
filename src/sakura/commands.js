// Pure helpers for the script player: lenient argument parsing, \![move] geometry, \C detection, replay classes.

/**
 * Lenient number (SS §3.7): trims, accepts [+-]?digits[.digits], anything else -> dflt.
 * Full-width digits and '＠' are not numbers.
 */
export function num(s, dflt = 0) {
  if (s == null) return dflt;
  const t = String(s).trim();
  return /^[+-]?\d+(\.\d+)?$/.test(t) ? Number(t) : dflt;
}

const BOOL_TRUE = new Set(['true', 'enable', 'enabled', 'yes', 'on', 'ok']);
const BOOL_FALSE = new Set(['false', 'disable', 'disabled', 'no', 'off', 'ng', 'none']);

/**
 * SSP's SPUtils::ParseBool [disasm 0x789660]: spaces, tabs, CR and LF trimmed; `true enable enabled yes on ok` -> 1,
 * `false disable disabled no off ng none` -> 0 (any case); an optional sign and digits -> 1 when any digit is not 0,
 * else 0; anything else, or nothing -> -1. Timer tags' `repeat` (once only for 1), `sstp.allowcommunicate`.
 * @returns {1|0|-1}
 */
export function parseBool(s) {
  const t = String(s ?? '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').toLowerCase();
  if (BOOL_TRUE.has(t)) return 1;
  if (BOOL_FALSE.has(t)) return 0;
  const m = /^[+-]?([0-9]+)$/.exec(t);
  if (m) return /[1-9]/.test(m[1]) ? 1 : 0;
  return -1;
}

/** Leading-integer parse in the C wcstol style ('12px' -> 12, 'abc' -> dflt). */
export function intPrefix(s, dflt = 0) {
  const m = /^\s*([+-]?\d+)/.exec(String(s ?? ''));
  return m ? parseInt(m[1], 10) : dflt;
}

/** Wait of \w (digit form = N*50 ms; bracket form = N ms, SS §5.5) */
export function waitMs(tok, unit = 50) {
  if (!tok.args) return 0;
  const v = num(tok.args[0], 0);
  return tok.form === 'digit' ? v * unit : Math.max(0, v);
}

/**
 * \![set,balloonwait,V] (SS §5.3): '' / '1' = default; 'Nms' = absolute ms per character; 'N%' = percent;
 * a number = multiplier; 0 = instant.
 * @returns {{mul?: number, ms?: number}|null} null = back to the default
 */
export function parseBalloonWait(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^([+-]?\d+(?:\.\d+)?)\s*ms$/i.exec(s);
  if (m) return { ms: Math.max(0, Number(m[1])) };
  m = /^([+-]?\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (m) return { mul: Math.max(0, Number(m[1]) / 100) };
  const n = num(s, NaN);
  if (Number.isNaN(n)) return null;
  return n === 1 ? null : { mul: Math.max(0, n) };
}

/** \n argument -> line-height ratio */
export function newlineRatio(args) {
  if (!args || !args.length) return 1;
  const a = String(args[0]).trim().toLowerCase();
  if (a === 'half') return 0.5;
  if (a === '') return 1;
  const p = num(a.replace(/%$/, ''), NaN);
  return Number.isNaN(p) ? 1 : p / 100;
}

/**
 * A tag's arguments from `from` on as SPGhost::ParametersToArray 0x6244a0 hands them on (raise / notify / embed
 * References, \q / \_a / \__q references; SS §3.4) [disasm]: SSP's list ends at its first empty string, which can only
 * be an empty last argument (a middle one is the placeholder " "), and " " becomes ''.
 */
export function refList(args, from) {
  if (!args) return [];
  const r = args.slice(from).map(x => (x === ' ' ? '' : x));
  if (r.length && args[args.length - 1] === '') r.pop();
  return r;
}

const JUMP_PREFIX = /^(https?:\/\/|ftp:\/\/|mailto:|file:\/\/\/|script:)/i;

/**
 * A choice's or anchor's jump string (SS §5.6.2) [disasm]: an ID that SPGhost::IsExecuteJumpString 0x639bb0 accepts
 * (`http://`, `https://`, `ftp://`, `mailto:`, `file:///`, `script:`, any case) is run re-joined with every non-empty
 * reference (SPBalloonString::GetJumpString 0x5d52f0), so an unquoted `\q[t,script:\![raise,OnX,a\]]` still runs
 * `\![raise,OnX,a]`. Any other ID: null.
 */
export function jumpString(id, refs) {
  const s = String(id ?? '');
  if (!JUMP_PREFIX.test(s)) return null;
  return [s, ...(refs || []).map(String).filter(r => r !== '' && r !== ' ')].join(',');
}

/**
 * \p[…]'s scope (DecodeProcReal 0x627ac0) [disasm]: digits only, below 10000; an empty bracket is scope 0 (SSP logs
 * "invalid scope number" and goes on with 0). Anything else: null (SSP folds any character into a number and logs
 * it; such a number names no character [infer]).
 */
export function scopeNumber(arg) {
  const s = String(arg ?? '');
  if (s === '') return 0;
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n < 10000 ? n : null;
}

/** \![bind] value (SUM C24): '' / missing = toggle (''), '0'/'1' as is, anything else = null (no-op). */
export function bindValue(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (s === '' || s === '0' || s === '1') return s;
  return null;
}

const ALIGN_MODES = new Set(['top', 'bottom', 'left', 'right', 'free', 'default']);

/**
 * \![set,alignmenttodesktop,D] -> CharacterView.setAlignment mode, or null if unknown. 'default' (or empty) goes back
 * to the descript / alignment-chain default; the shell resolves it (SS §5.2).
 */
export function alignmentMode(d) {
  const s = String(d ?? '').trim().toLowerCase();
  if (s === '') return 'default';
  return ALIGN_MODES.has(s) ? s : null;
}

/** \_u[0xHHHH] / \_u[DDDD], \_m[0xHH] -> character ('' if invalid) */
export function codeChar(arg, asciiOnly = false) {
  const s = String(arg ?? '').trim();
  let cp = NaN;
  if (/^0x[0-9a-f]+$/i.test(s)) cp = parseInt(s.slice(2), 16);
  else if (/^\d+$/.test(s)) cp = parseInt(s, 10);
  if (!(cp >= 0) || cp > (asciiOnly ? 0x7f : 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  return String.fromCodePoint(cp);
}

// ---------------------------------------------------------------------------------------------------------------
// \![move] (SS §5.2.1)

const OFF_X = new Set(['left', 'right', 'center', 'base']);
const OFF_Y = new Set(['top', 'bottom', 'center', 'base']);

/** 'right.top' -> {x:'right', y:'top'}; each half falls back on its own ('ritht.top' -> left.top, 'left' -> left.top). */
export function parseOffset(s) {
  const [a = '', b = ''] = String(s ?? '').trim().toLowerCase().split('.');
  return { x: OFF_X.has(a) ? a : 'left', y: OFF_Y.has(b) ? b : 'top' };
}

/**
 * Parse \![move,...] / \![moveasync,...] arguments (both the legacy positional and the --key= form).
 * @param {string[]} a the arguments after the command name
 * @returns {{x:number|null, y:number|null, time:number, base:string, baseOffset:{x,y}, moveOffset:{x,y},
 *            ignoreSticky:boolean, cancel:boolean}}  x/y null = 'fix' (keep that axis)
 */
export function parseMoveArgs(a) {
  const r = { x: null, y: null, time: 0, base: 'screen', baseOffset: parseOffset(''), moveOffset: parseOffset(''),
    ignoreSticky: false, cancel: false };
  if (a.length && String(a[0]).trim().toLowerCase() === 'cancel') { r.cancel = true; return r; }
  const coord = v => { const s = String(v ?? '').trim(); return s.toLowerCase() === 'fix' ? null : num(s, null); };
  if (a.some(v => /^\s*--/.test(v))) {
    for (const v of a) {
      const m = /^\s*--([\w-]+)\s*=(.*)$/.exec(v);
      if (!m) continue;
      const k = m[1].toLowerCase(), val = m[2].trim();
      if (k === 'x') r.x = coord(val);
      else if (k === 'y') r.y = coord(val);
      else if (k === 'time') r.time = Math.max(0, num(val, 0));
      else if (k === 'base') r.base = val || 'screen';
      else if (k === 'base-offset') r.baseOffset = parseOffset(val);
      else if (k === 'move-offset') r.moveOffset = parseOffset(val);
      else if (k === 'option') r.ignoreSticky = /ignore-sticky-window/i.test(val);
    }
    return r;
  }
  r.x = coord(a[0]);
  r.y = coord(a[1]);
  r.time = Math.max(0, num(a[2], 0));
  r.base = String(a[3] ?? '').trim() || 'screen';
  r.baseOffset = parseOffset(a[4]);
  r.moveOffset = parseOffset(a[5]);
  return r;
}

/** A point of a rectangle by offset; `base` uses the base point when known. */
export function rectPoint(rect, off, basePoint) {
  const x = off.x === 'right' ? rect.x + rect.width
    : off.x === 'center' ? rect.x + rect.width / 2
      : off.x === 'base' && basePoint ? basePoint.x : rect.x;
  const y = off.y === 'bottom' ? rect.y + rect.height
    : off.y === 'center' ? rect.y + rect.height / 2
      : off.y === 'base' && basePoint ? basePoint.y : rect.y;
  return { x, y };
}

/**
 * Where the moving window's base point must go.
 * @param {ReturnType<typeof parseMoveArgs>} m
 * @param {{rect:{x,y,width,height}, basePoint:{x,y}}} me the moving window
 * @param {{rect:{x,y,width,height}, basePoint?:{x,y}}} base the reference rectangle (viewport, a scope, or me)
 * @returns {{x:number, y:number}} target base point (viewport px)
 */
export function moveTarget(m, me, base) {
  const anchor = rectPoint(base.rect, m.baseOffset, base.basePoint);
  const cur = rectPoint(me.rect, m.moveOffset, me.basePoint);
  const dx = m.x == null ? 0 : anchor.x + m.x - cur.x;
  const dy = m.y == null ? 0 : anchor.y + m.y - cur.y;
  return { x: me.basePoint.x + dx, y: me.basePoint.y + dy };
}

/** \4's distance as a share of the viewport width (UI §3.8 [guess]: ninix moves 1/20 of the work area). */
export const AWAY_SHARE = 1 / 20;

/**
 * \4 / \5 (UI §3.8): where the moving window's base point goes, sideways only. `me` stays on its side of `other`
 * (centres compared; equal centres: away from the viewport half `other` is in). \4 moves it AWAY_SHARE of the viewport
 * width further away; \5 (near) until the rects touch, and not at all when they already touch or overlap. Neither
 * pushes the window out of the viewport (or further out than it is).
 * @param {boolean} near \5
 * @param {{rect:{x,y,width,height}, basePoint:{x,y}}} me the moving window
 * @param {{x,y,width,height}} other the other character's rect
 * @param {{width:number}} viewport
 * @returns {{x:number, y:number}|null} null = nothing to do
 */
export function approachTarget(near, me, other, viewport) {
  const a = me.rect, b = other;
  const vw = Math.max(0, +viewport.width || 0);
  const ca = a.x + a.width / 2, cb = b.x + b.width / 2;
  const left = ca < cb || (ca === cb && cb >= vw / 2);
  let x;
  if (near) {
    if (a.x <= b.x + b.width && b.x <= a.x + a.width) return null;
    x = left ? b.x - a.width : b.x + b.width;
  } else {
    const d = Math.round(vw * AWAY_SHARE);
    x = left ? a.x - d : a.x + d;
  }
  if (x < a.x) x = Math.max(x, Math.min(a.x, 0));
  else if (x > a.x) x = Math.min(x, Math.max(a.x, vw - a.width));
  if (x === a.x) return null;
  return { x: me.basePoint.x + (x - a.x), y: me.basePoint.y };
}

// ---------------------------------------------------------------------------------------------------------------
// \C (SUM §2.2) and replay classes (SS §7)

const BANG_PASSIVE = new Set(['bind', 'bind-noevent', 'set', 'reset', 'lock', 'unlock', 'quicksection']);
const PASSIVE_TAGS = new Set(['0', '1', 'h', 'u', 'p', 's', 'b', 'w', '_w', '__w', 't', '_q', '*', '_n', 'f', 'i']);

/** True when the !-command is OnDirectSaoriCall's raise (never content, never waits). */
function isSaoriRaise(t) {
  return t.args && String(t.args[0]).trim().toLowerCase() === 'raise' && String(t.args[1]).trim() === 'OnDirectSaoriCall';
}

/**
 * Index of a \C token that counts as "append" (SUM §2.2): every token before it is a non-content tag
 * (scope switches, \s, \b, \![bind], \![set,…], waits ...). -1 when there is none.
 */
export function findAppendC(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'tag' && t.name === 'C') return i;
    if (t.type !== 'tag') return -1;
    if (PASSIVE_TAGS.has(t.name)) continue;
    if (t.name === '!' && t.args && (BANG_PASSIVE.has(String(t.args[0]).trim().toLowerCase()) || isSaoriRaise(t))) continue;
    return -1;
  }
  return -1;
}

// \![...] commands that are replayed (state/display); every other \![...] is a side effect and skipped (SS §7)
const REPLAY_BANG = new Set(['*', 'quicksection', 'lock', 'unlock']);
const REPLAY_SET = new Set(['balloonwait', 'balloontimeout', 'choicetimeout', 'autoscroll', 'serikotalk', 'balloonoffset',
  'balloonalign', 'balloonmarker', 'balloonnum']);
const SKIP_TAGS = new Set(['-', '+', '_+', 'j', 'i', '6', '7', 'a', '8', '_v', '_V', '4', '5', 'v', '__t', '__c']);

/** Is this token a side effect that fast-forward replay must not repeat? (SS §7 table) */
export function isSideEffect(t) {
  if (t.type !== 'tag') return false;
  if (SKIP_TAGS.has(t.name)) return true;
  if (t.name === '__w') return !!(t.args && String(t.args[0]).trim().toLowerCase() === 'animation');
  if (t.name !== '!') return false;
  const cmd = String(t.args?.[0] ?? '').trim().toLowerCase();
  if (REPLAY_BANG.has(cmd)) return false;
  if (cmd === 'embed') return false;          // re-spliced from the replies saved with the run, not re-sent
  if (cmd === 'set') return !REPLAY_SET.has(String(t.args[1] ?? '').trim().toLowerCase());
  return true;
}

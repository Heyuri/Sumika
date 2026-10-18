// ssp.exe's property system (docs/research/properties.md): the names %property[…], \![get,property,…] and
// \![set,property,…] read and write, resolved as SPVarSystemDispatcher does [disasm Get 0x78CDF0, Set 0x78CFE0,
// FindFromName 0x78C5A0]. Pure: no DOM, no event loop; every value comes from the `world` the event loop builds, and a
// world member that is missing makes its names fail.
//
// Get answers a string, or null when it fails (%property removes the variable, \![get,property] sends ''); a ghost
// cannot tell a failure from an empty value. Only `username` and `….ext.KEY` ask an engine, so only they can make the
// answer a Promise. Set answers whether it applied (ssp.exe never shows the result to the script).
import { log } from './log.js';

/**
 * @typedef {{id:string, name:string, path:string, craftman?:string, craftmanurl?:string, homeurl?:string, icon?:string,
 *            thumbnails?:string[], times?:{lastboot?:number, update?:number, install?:number, firstboot?:number}}} ItemRec
 *   path: site-absolute, '/'-ended (`/ghost/<id>/`, EV §2.1 "Paths"); thumbnails: site-absolute, SSP's candidates (one
 *   is picked at random each time, as SPProp::GetThumbnailReal does); times: epoch ms
 * @typedef {{name:string, surface:number|string, defaultSurface:number, balloonDefault:number, x:number, y:number,
 *            rect:number[], scaling:number[]}} ScopeInfo  rect [l, t, r, b] and x, y: desk CSS px; scaling: percent
 * @typedef {{validWidth:number, validWidthInitial:number, validHeight:number, validHeightInitial:number, lines:number,
 *            linesInitial:number, basePos:{x:number, y:number}, charWidth:number, vertical:number}} BalloonMetrics
 *   balloon-image px (BalloonModel#metrics)
 * @typedef {object} LiveGhost  a ghost that is up in this tab
 * @property {() => Promise<string|null>} username       GET username to that ghost's engine; null: no answer
 * @property {(key:string) => Promise<string|null>} ext  GET property.get [key] to that ghost's engine
 * @property {(key:string, value:string) => Promise<boolean>|boolean} setExt  GET property.set [key, value]: 2xx
 * @property {() => string} status                         SSP's Status header text
 * @property {() => string} selfname2
 * @property {() => number} scopeCount
 * @property {(n:number) => ScopeInfo|null} scope
 * @property {() => (ItemRec & {sakuraName?:string, keroName?:string, hidden?:boolean})[]} shells  index order
 * @property {() => string} currentShell                    the shell in use: its id
 * @property {() => ItemRec} balloon                        the balloon in use
 * @property {(n:number) => (BalloonMetrics & {num:number, rect:number[]})|null} balloonScope  rect: desk CSS px
 * @property {(n:number, v:string) => boolean} setSurface   as \s[v] on scope n
 * @property {(n:number, id:number) => boolean} setBalloon  as \b[id] on scope n (id < 0 hides)
 * @typedef {ItemRec & {sakuraName:string, keroName:string, live:LiveGhost|null}} GhostRec
 * @typedef {object} PropertyWorld  every member optional
 * @property {() => number} now                  epoch ms (the loop's clock)
 * @property {() => string} locale               a BCP 47 tag (the browser's language stands for the OS locale)
 * @property {() => number} idleSec              seconds since the visitor's last input
 * @property {() => number} sessionSec           seconds since the tab's session started (stands for OS uptime)
 * @property {() => {x:number, y:number}|null} cursor   the last pointer position seen, desk CSS px; null: none yet
 * @property {() => {w:number, h:number, dpr:number, depth:number}} viewport
 * @property {() => boolean} dark                prefers-color-scheme: dark
 * @property {() => boolean|null} online         navigator.onLine; null: unknown
 * @property {{name:string, version:string, platform:string}} baseware
 * @property {() => GhostRec} self               the calling ghost (currentghost., ghostlist.current., …)
 * @property {() => GhostRec[]} ghosts           ghostlist: the site index's ghosts, index order (`live` when up here)
 * @property {() => GhostRec[]} active           activeghostlist: up in this tab, set order, the caller included
 * @property {() => ItemRec[]} balloons          balloonlist: the site's balloons, index order
 */

const fold = s => String(s).replace(/[A-Z]+/g, c => c.toLowerCase());     // ASCII only, as wcsicmp_opt
const eqI = (a, b) => fold(a) === fold(b);
const headI = (s, low) => s.length >= low.length && fold(s.slice(0, low.length)) === low;
const isThenable = v => !!v && typeof v.then === 'function';
/** f(v), or a promise of it when v is a thenable (a rejection is a failure). */
const map = (v, f) => (isThenable(v) ? Promise.resolve(v).then(f, () => null) : f(v));
const str = v => (v == null ? null : String(v));
const int = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : String(Math.round(Number(v))));
const rectText = r => (Array.isArray(r) && r.length === 4 && r.every(x => Number.isFinite(Number(x)))
  ? r.map(x => Math.round(Number(x))).join(',') : null);
/** A world (or live ghost) method's result; undefined when it has no such method or it threw. */
function call(o, name, ...args) {
  if (!o || typeof o[name] !== 'function') return undefined;
  try { return o[name](...args); } catch (e) { log.debug('property: world.' + name + ' failed', e); return undefined; }
}
const list = (o, name) => { const v = call(o, name); return Array.isArray(v) ? v : null; };
/** A setter's outcome: false when there is no such method, it threw or answered false. */
function apply(o, name, ...args) {
  if (!o || typeof o[name] !== 'function') return false;
  let r;
  try { r = o[name](...args); } catch (e) { log.debug('property: ' + name + ' failed', e); return false; }
  return map(r, x => x !== false);
}

const seen = new Set();
function debugOnce(key, ...a) {
  if (seen.has(key)) return;
  if (seen.size > 1000) seen.clear();
  seen.add(key);
  log.debug(...a);
}

// ---------------------------------------------------------------------------------------------------- name parsing

/** swscanf(s, lit + "%d") [disasm ParseIndex 0x78D890]: the literal exactly (case-sensitive), then C's %d. */
function scanAfter(s, lit) {
  if (!s.startsWith(lit)) return null;
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(s.slice(lit.length));
  return m ? parseInt(m[1], 10) : null;
}

/** SPVarSystemNode::ParseIndex: `index(N)` or `indexN`. */
function parseIndex(s) { return scanAfter(s, 'index(') ?? scanAfter(s, 'index'); }

/**
 * SPVarSystemNode::ParseCharIndex [disasm 0x78D920]: `index(N)`, `indexN`, `scope(N)`, `scopeN`, `char(N)`, `charN`
 * (swscanf: those words in lower case only), else a name starting `sakura` (0) or `kero` (1) in any case; the
 * property is what follows the first `.` (SPGhost::VarGet 0x647B1F). null: no scope, or no `.` after it.
 * @returns {{scope:number, rest:string}|null}
 */
export function parseCharIndex(s) {
  s = String(s ?? '');
  let n = parseIndex(s) ?? scanAfter(s, 'scope(') ?? scanAfter(s, 'scope') ?? scanAfter(s, 'char(') ??
    scanAfter(s, 'char');
  if (n == null) {
    if (headI(s, 'sakura')) n = 0;
    else if (headI(s, 'kero')) n = 1;
    else return null;
  }
  const dot = s.indexOf('.');
  return dot < 0 ? null : { scope: n, rest: s.slice(dot + 1) };
}

/** FindPeriodIgnoreKakko [disasm 0x78DC10]: the first `.` outside parentheses (one flag, no nesting). */
function periodOutside(s) {
  let inside = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') inside = true;
    else if (c === ')') inside = false;
    else if (c === '.' && !inside) return i;
  }
  return -1;
}

/** SPProp::FindFromPath [disasm 0x6C2B60]: `\` as `/`, a final `/` added, any case; site-absolute or root-relative. */
function normPath(p) {
  let s = fold(String(p).replace(/\\/g, '/'));
  if (!s.endsWith('/')) s += '/';
  return s;
}

function findIndex(items, key) {
  let i = items.findIndex(x => x && x.id != null && eqI(x.id, key));
  if (i >= 0) return i;
  const want = normPath(key);
  i = items.findIndex(x => {
    if (!x || !x.path) return false;
    const p = normPath(x.path);
    return want === p || want === p.replace(/^\/+/, '');
  });
  if (i >= 0) return i;
  return items.findIndex(x => x && x.name != null && eqI(x.name, key));
}

/**
 * A list element as SPPropListNode::GetIndex picks it [disasm 0x78D590]. `s` is the text after the list's name:
 * `.index(N).rest` (also `.indexN.rest`, which needs a `(` somewhere after it), or `(NAME).rest` with NAME up to the
 * last `)` before the first `.` outside parentheses (`plain`: the first `.` anywhere, as SPPropListNode::VarGet for
 * `currentghost.shelllist`, so a NAME with a `.` cannot be addressed there). NAME is tried as ID, then path, then
 * name (any case); `sakuraFallback` then tries the sakura name (ghostlist's FindGhostIDFromName, activeghostlist's
 * FindActiveGhostFromName [disasm 0x78C8E7, 0x78CB0B]). null: no such element, or nothing after it.
 * @returns {{item:any, index:number, rest:string}|null}
 */
export function pickFromList(items, s, { sakuraFallback = false, plain = false } = {}) {
  const arr = Array.isArray(items) ? items : [];
  s = String(s ?? '');
  const period = plain ? s.indexOf('.') : periodOutside(s);
  const kakko = s.indexOf('(');
  if (period < 0 || kakko < 0) return null;
  if (period < kakko) {
    const n = parseIndex(s.slice(period + 1));
    if (n == null) return null;
    const dot = s.indexOf('.', period + 7);          // the first '.' after ".index(" [disasm 0x78D6DA]
    if (dot < 0 || n < 0 || n >= arr.length) return null;
    return { item: arr[n], index: n, rest: s.slice(dot + 1) };
  }
  let close = -1;
  for (let j = period; j > kakko; j--) if (s[j] === ')') { close = j; break; }    // FindKakkoFromEnd 0x78DBF0
  if (close < 0) return null;
  const key = s.slice(kakko + 1, close);
  const r = close + 1 + (s[close + 1] === '.' ? 1 : 0);
  let index = findIndex(arr, key);
  if (index < 0 && sakuraFallback && key !== '') {
    index = arr.findIndex(x => x && x.sakuraName != null && eqI(x.sakuraName, key));
  }
  if (index < 0 || r >= s.length) return null;
  return { item: arr[index], index, rest: s.slice(r) };
}

// ---------------------------------------------------------------------------------------------------- formats

/** `Y,M,D,h,m,s` local, no padding; zeros when unknown (SPProp::VarGet 0x6C1D56, SystemTimeToCommaSeparatedTime). */
function timeText(ms) {
  if (!(ms > 0)) return '0,0,0,0,0,0';
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].join(',');
}

/** A scale in percent: `%.2f` with trailing zeros and the `.` cut (`100`, `133.33`) [disasm ftowcs 0x647EB6]. */
function scaleText(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2).replace(/\.?0+$/, '') : null;
}

function weekday(d, locale) {
  for (const loc of [locale || undefined, 'en']) {
    try { return new Intl.DateTimeFormat(loc, { weekday: 'long' }).format(d); } catch (e) { /* a bad tag */ }
  }
  return null;
}

function localeParts(tag) {
  try {
    const l = new Intl.Locale(String(tag));
    return { language: l.language || '', region: l.region || '' };
  } catch (e) {
    const p = String(tag).split(/[-_]/);
    return { language: p[0] || '', region: p.find((x, i) => i > 0 && /^([A-Za-z]{2}|\d{3})$/.test(x)) || '' };
  }
}

// ---------------------------------------------------------------------------------------------------- system.*

/** SPMonitorInfo::VarGet [disasm 0x6A1650]: the one monitor is the viewport [decision]. */
function monitorProp(w, key) {
  const vp = call(w, 'viewport');
  if (!vp) return null;
  switch (fold(key)) {
    case 'work': case 'rect': return rectText([0, 0, vp.w, vp.h]);
    case 'bpp': return int(vp.depth ?? 24);
    case 'dpi': return int(96 * (Number(vp.dpr) > 0 ? Number(vp.dpr) : 1));
    case 'primary': return '1';
  }
  return null;
}

/** GetOSProp [disasm 0x7684F0] with a browser's values (properties.md §5.5). */
function osProp(w, key) {
  const k = fold(key);
  switch (k) {
    case 'type': case 'name': return 'Web';
    case 'arch': return 'unknown';
    case 'version': case 'build': case 'parenttype': case 'parentname': return '';
    case 'locale': case 'locale.language': case 'locale.country': {
      const tag = call(w, 'locale');
      if (tag == null) return null;
      if (k === 'locale') return String(tag);
      const p = localeParts(tag);
      return k === 'locale.language' ? p.language : p.region;
    }
    case 'timezone.offset': case 'dst': {
      const now = call(w, 'now');
      if (now == null) return null;
      const d = new Date(now), y = d.getFullYear();
      // Windows' Bias: the standard offset (UTC = local + bias, −540 in Japan); dst: daylight time now
      const std = Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset());
      return k === 'dst' ? (d.getTimezoneOffset() < std ? '1' : '0') : String(std);
    }
    case 'uptime': return int(Math.floor(Number(call(w, 'sessionSec'))));
    case 'unixtime': { const now = call(w, 'now'); return now == null ? null : int(Math.floor(now / 1000)); }
    case 'idletime': return int(Math.floor(Number(call(w, 'idleSec'))));
  }
  return null;
}

/** GetPowerProp [disasm 0x768D20]: UKADOC's "cannot get" values [doc]. */
function powerProp(key) {
  switch (fold(key)) {
    case 'source': return 'unknown';
    case 'battery.percent': case 'percent': case 'battery.lifetime': case 'lifetime': return '-1';
    case 'battery.flag': case 'flag': return '';
  }
  return null;
}

function systemGet(w, name) {
  if (headI(name, 'baseware.')) {
    const b = w.baseware || null;
    switch (fold(name.slice(9))) {
      case 'name': return b ? str(b.name) : null;
      case 'version': return b ? str(b.version) : null;
      case 'windowmode': return 'normal';
    }
    return null;
  }
  const key = name.slice(7), k = fold(key);
  if (k.startsWith('os.')) return osProp(w, key.slice(3));
  if (k.startsWith('power.')) return powerProp(key.slice(6));
  if (k.startsWith('monitor.')) {
    // SPMonitorInfoManager::VarGet [disasm 0x6A2D70]: count, index(N).KEY
    const rest = key.slice(8);
    if (fold(rest) === 'count') return call(w, 'viewport') ? '1' : null;
    const dot = rest.indexOf('.');
    return parseIndex(rest) === 0 && dot >= 0 ? monitorProp(w, rest.slice(dot + 1)) : null;
  }
  if (k.startsWith('disk.')) return fold(key.slice(5)) === 'count' ? '0' : null;
  if (k.startsWith('network.')) {
    switch (fold(key.slice(8))) {
      case 'status': { const on = call(w, 'online'); return on == null ? null : on ? 'online' : 'offline'; }
      case 'type': return 'unknown';
    }
    return null;            // ipaddress, cost, downlink: never [decision]
  }
  // cpu.*, memory.*, mem.*: a browser cannot read them [decision]
  switch (k) {
    case 'theme.app.mode': case 'theme.os.mode': {
      const d = call(w, 'dark');
      return d == null ? null : d ? 'dark' : 'light';
    }
    case 'dnd.mode': return 'normal';
    case 'platform': return w.baseware ? str(w.baseware.platform) : null;
    case 'cursor.pos': {
      if (typeof w.cursor !== 'function') return null;
      const p = call(w, 'cursor');
      return p ? `${int(p.x) ?? 0},${int(p.y) ?? 0}` : '0,0';
    }
  }
  const now = call(w, 'now');
  if (now == null) return null;
  const d = new Date(now);
  switch (k) {
    case 'year': return String(d.getFullYear());
    case 'month': return String(d.getMonth() + 1);
    case 'day': return String(d.getDate());
    case 'hour': return String(d.getHours());
    case 'minute': return String(d.getMinutes());
    case 'second': return String(d.getSeconds());
    case 'millisecond': return String(d.getMilliseconds());
    case 'dayofweek': return weekday(d, call(w, 'locale'));
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------- items

function indexIn(items, rec) {
  if (!Array.isArray(items)) return -1;
  const i = items.indexOf(rec);
  return i >= 0 ? i : items.findIndex(x => x && rec && x.id != null && x.id === rec.id);
}

/**
 * SPProp::VarGet [disasm 0x6C1BD0], the names every listed item has. `items`: its own list (for `index`).
 * @returns {string|null|undefined} undefined: not one of these names
 */
function itemGet(rec, p, items) {
  const times = rec.times || {};
  switch (fold(p)) {
    case 'name': return str(rec.name ?? '');
    case 'craftman': case 'craftmanw': return str(rec.craftman ?? '');
    case 'path': return str(rec.path ?? '');
    case 'craftmanurl': return str(rec.craftmanurl ?? '');
    case 'updateurl': case 'homeurl': return str(rec.homeurl ?? '');
    case 'index': { const i = indexIn(items, rec); return i < 0 ? null : String(i); }
    case 'thumbnail': {         // one of the candidates at random (genrand) [disasm SPProp::GetThumbnailReal 0x6c3257]
      const th = Array.isArray(rec.thumbnails) ? rec.thumbnails : [];
      return th.length ? String(th[Math.min(th.length - 1, Math.floor(Math.random() * th.length))]) : null;
    }
    case 'update_result': return '';
    case 'update_time': return timeText(times.update);
    case 'install_time': return timeText(times.install);
    case 'lastboot_time': return timeText(times.lastboot);
    case 'firstboot_time': return timeText(times.firstboot);
  }
  return undefined;
}

/** SPGhostProp → SPProp → the running ghost (SPGhost) [disasm 0x6C3FD0, 0x6C1BD0, 0x6476D0]. */
function ghostGet(w, rec, p) {
  switch (fold(p)) {
    case 'sakuraname': case 'selfname': return str(rec.sakuraName ?? '');
    case 'keroname': return str(rec.keroName ?? '');
    case 'icon': return rec.icon ? String(rec.icon) : null;
    case 'updateurl': case 'homeurl': return str(rec.homeurl ?? '');
  }
  const v = itemGet(rec, p, list(w, 'ghosts'));
  if (v !== undefined) return v;
  return rec.live ? liveGet(w, rec.live, p) : null;     // recommended.balloon*: later
}

/** SPGhost::VarGet [disasm 0x6476D0]: a ghost that is up. */
function liveGet(w, live, p) {
  const k = fold(p);
  switch (k) {
    case 'username': return map(call(live, 'username'), v => str(v));
    case 'selfname2': return str(call(live, 'selfname2'));
    case 'status': return str(call(live, 'status'));
    case 'scope.count': return int(call(live, 'scopeCount'));
    case 'kinokoname': return null;
  }
  const sc = parseCharIndex(p);
  if (sc) return scopeGet(w, live, sc.scope, sc.rest);
  if (k.startsWith('balloon.')) return balloonGet(w, live, p.slice(8));
  if (k.startsWith('shelllist')) return shellListGet(live, p.slice(9));
  if (k.startsWith('ext.')) return map(call(live, 'ext', p.slice(4)), v => (v == null || v === '' ? null : String(v)));
  return null;              // mousecursor*, seriko.*, sound*: later
}

/** currentghost.scope(N).* [disasm 0x647B07–0x647FC7]. */
function scopeGet(w, live, n, sp) {
  const s = call(live, 'scope', n);
  if (!s) return null;
  const k = fold(sp);
  switch (k) {
    case 'name': return str(s.name ?? '');
    case 'surface.num': return str(s.surface);
    case 'seriko.defaultsurface': return int(s.defaultSurface);
    case 'balloon.defaultsurface': return int(s.balloonDefault);
    case 'bind.menu': return 'auto';                    // no per-scope dress-up menu switch in Sumika [decision]
    case 'x': return int(s.x);
    case 'y': return int(s.y);
    case 'rect': return rectText(s.rect);
    case 'scaling': {
      const a = Array.isArray(s.scaling) ? s.scaling.map(scaleText) : [];
      return a.length === 2 && a[0] != null && a[1] != null ? a.join(',') : null;
    }
  }
  if (k.startsWith('currentmonitor.')) return monitorProp(w, sp.slice(15));
  return null;              // animation.num, surface(M).rect: later
}

/** The balloon numbers of a scope (SPBalloonWnd::VarGet) [disasm 0x5CA080]. */
function balloonWndGet(b, sub) {
  const k = fold(sub);
  switch (k) {
    case 'num': return int(b.num);
    case 'validwidth': return int(b.validWidth);
    case 'validwidth.initial': return int(b.validWidthInitial);
    case 'validheight': return int(b.validHeight);
    case 'validheight.initial': return int(b.validHeightInitial);
    case 'basepos': return b.basePos ? `${int(b.basePos.x)},${int(b.basePos.y)}` : null;
    case 'basepos.x': return b.basePos ? int(b.basePos.x) : null;
    case 'basepos.y': return b.basePos ? int(b.basePos.y) : null;
    case 'lines': return int(b.lines);
    case 'lines.initial': return int(b.linesInitial);
    case 'char_width': return int(b.charWidth);
    case 'vertical': return int(b.vertical ?? 0);
  }
  if (k.startsWith('background.color')) return null;     // later
  const r = Array.isArray(b.rect) && b.rect.length === 4 ? b.rect : null;
  if (r && k.startsWith('x')) return int(r[0]);
  if (r && k.startsWith('y')) return int(r[1]);
  if (r && k.startsWith('rect')) return rectText(r);
  return null;
}

/** A scope this ghost has (the balloon numbers of a scope ≥ the ghost's scope count fail) [decision]. */
function hasScope(live, n) {
  if (!(n >= 0)) return false;
  const count = call(live, 'scopeCount');
  return count == null || n < count;
}

/** currentghost.balloon.* (SPBalloon::VarGet) [disasm 0x5C85A0]. */
function balloonGet(w, live, bp) {
  const sc = parseCharIndex(bp);
  if (sc) {
    const b = hasScope(live, sc.scope) ? call(live, 'balloonScope', sc.scope) : null;
    const v = b ? balloonWndGet(b, sc.rest) : null;
    if (v != null) return v;
    if (fold(sc.rest) === 'defaultsurface') {
      const s = call(live, 'scope', sc.scope);
      return s ? int(s.balloonDefault) : null;
    }
    return null;            // scaling, count, index(I).*: later
  }
  const bal = call(live, 'balloon');
  if (!bal) return null;    // mousecursor*, recommended.ghost*: later
  const v = itemGet(bal, bp, list(w, 'balloons'));
  return v === undefined ? null : v;
}

/** currentghost.shelllist… [disasm 0x6483EC–0x648544]; a shell: SPShellProp::VarGet [disasm 0x61ABE0]. */
function shellListGet(live, sp) {
  const shells = list(live, 'shells');
  if (!shells) return null;
  let rec, rest;
  if (headI(sp, '.current.')) {
    const cur = call(live, 'currentShell');
    rec = shells.find(s => s && s.id === cur) || shells.find(s => s && cur != null && eqI(s.id, cur));
    rest = sp.slice(9);
  } else {
    const dot = sp.indexOf('.');
    if (dot >= 0 && fold(sp.slice(dot + 1)) === 'count') return String(shells.length);
    const pick = pickFromList(shells, sp, { plain: true });
    if (pick) { rec = pick.item; rest = pick.rest; }
  }
  if (!rec) return null;
  switch (fold(rest)) {
    case 'sakuraname': return str(rec.sakuraName ?? '');
    case 'keroname': return str(rec.keroName ?? '');
    case 'notinstalled': return 'false';
    case 'menu': return rec.hidden ? 'hidden' : '';
  }
  const v = itemGet(rec, rest, shells);
  return v === undefined ? null : v;
}

// ---------------------------------------------------------------------------------------------------- dispatcher

/** `root` at the start of `s` (any case) followed by `.` or `(` (IsNodeNameBoundary 0x78CDD0): the text after it. */
function after(s, root) {
  if (!headI(s, root)) return null;
  const r = s.slice(root.length);
  return r[0] === '.' || r[0] === '(' ? r : null;
}

/**
 * SPVarSystemDispatcher::FindFromName [disasm 0x78C5A0]: the node a name starts with, and the rest for it.
 * @returns {{kind:'system'}|{kind:'ghost'|'balloon', rec:any, rest:string}|{kind:'empty'|'history', rest:string}|null}
 */
function findNode(w, s) {
  if (headI(s, 'system.') || headI(s, 'baseware.')) return { kind: 'system' };
  let r;
  if ((r = after(s, 'balloonlist')) != null) {
    const p = pickFromList(list(w, 'balloons'), r);
    return p ? { kind: 'balloon', rec: p.item, rest: p.rest } : null;
  }
  if (after(s, 'headlinelist') != null || after(s, 'pluginlist') != null) return null;   // none in a browser
  for (const [root, of] of [['ghostlist', 'ghosts'], ['activeghostlist', 'active']]) {
    if ((r = after(s, root)) == null) continue;
    const p = pickFromList(list(w, of), r, { sakuraFallback: true });
    return p ? { kind: 'ghost', rec: p.item, rest: p.rest } : null;
  }
  if ((r = after(s, 'rateofuselist')) != null) return { kind: 'empty', rest: r };
  if ((r = after(s, 'history')) != null) return { kind: 'history', rest: r };
  if (headI(s, 'developer') && headI(s.slice(9), '.log')) {
    const t = s.slice(13);
    for (const kind of ['.script', '.network', '.error', '.update']) {
      if (!headI(t, kind)) continue;
      const rest = t.slice(kind.length);
      return rest[0] === '.' || rest[0] === '(' ? { kind: 'empty', rest } : null;
    }
  }
  return null;
}

function count(w, of) {
  const a = list(w, of);
  return a ? String(a.length) : null;
}

function getRaw(w, s) {
  for (const pre of ['currentghost.', 'ghostlist.current.', 'activeghostlist.current.']) {
    if (!headI(s, pre)) continue;
    const me = call(w, 'self');
    return me ? ghostGet(w, me, s.slice(pre.length)) : null;
  }
  switch (fold(s)) {
    case 'balloonlist.count': return count(w, 'balloons');
    case 'headlinelist.count': case 'pluginlist.count': return '0';
    case 'ghostlist.count': return count(w, 'ghosts');
    case 'activeghostlist.count': return count(w, 'active');
  }
  const f = findNode(w, s);
  if (!f) return null;
  switch (f.kind) {
    case 'system': return systemGet(w, s);
    case 'ghost': return ghostGet(w, f.rec, f.rest);
    case 'balloon': {
      const v = itemGet(f.rec, f.rest, list(w, 'balloons'));
      return v === undefined ? null : v;                 // recommended.ghost*: later
    }
    case 'empty': return fold(f.rest) === '.count' ? '0' : null;
    case 'history': return /^\.(ghost|balloon|headline|plugin)\.count$/.test(fold(f.rest)) ? '0' : null;
  }
  return null;
}

function failed(name, v) {
  if (v != null) return String(v);
  debugOnce('property:get:' + name, 'property has no value:', name);
  return null;
}

/**
 * Get a property for the calling ghost (world.self) [disasm SPVarSystemDispatcher::Get 0x78CDF0].
 * @param {PropertyWorld} world
 * @param {string} name  as the script wrote it: case-insensitive, never trimmed
 * @returns {string|null|Promise<string|null>} null: Get failed
 */
export function getProperty(world, name) {
  const s = name == null ? '' : String(name);
  let v;
  try {
    v = getRaw(world || {}, s);
  } catch (e) {
    log.once('property:get:error', 'property read failed', s, e);
    v = null;
  }
  return isThenable(v) ? Promise.resolve(v).then(x => failed(s, x), () => failed(s, null)) : failed(s, v);
}

// ---------------------------------------------------------------------------------------------------- Set

/** A name ssp.exe can set that Sumika does not set yet: logged once (properties.md §6) [decision]. */
function notYet(p) {
  log.once('property:set:' + fold(p).replace(/\d+/g, 'N'), `\\![set,property] ${p}: not supported yet`);
  return false;
}

const SCOPE_SETTABLE = new Set(['animation.num', 'seriko.defaultsurface', 'balloon.defaultsurface', 'bind.menu']);

/** C's wtol: leading spaces, a sign, digits; else 0 (SPBalloonWnd::VarSet `num` [disasm 0x5CA68C]). */
function wtol(v) {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}

/** SPGhost::VarSet [disasm 0x6486D0] on `me`, the ghost whose script set it. */
function ghostSet(me, p, v) {
  const live = me && me.live;
  if (!live) return false;
  const k = fold(p);
  const sc = parseCharIndex(p);
  if (sc) {
    const sk = fold(sc.rest);
    if (sk === 'surface.num') return apply(live, 'setSurface', sc.scope, v);
    return SCOPE_SETTABLE.has(sk) ? notYet(p) : false;
  }
  if (k.startsWith('balloon.')) {
    const bc = parseCharIndex(p.slice(8));
    if (bc) {
      const sk = fold(bc.rest);
      if (sk === 'num') return hasScope(live, bc.scope) && apply(live, 'setBalloon', bc.scope, wtol(v));
      return sk === 'defaultsurface' ? notYet(p) : false;
    }
    return fold(p.slice(8)).startsWith('mousecursor') ? notYet(p) : false;
  }
  if (k.startsWith('ext.')) return apply(live, 'setExt', p.slice(4), v);
  if (k.startsWith('mousecursor')) return notYet(p);
  if (k.startsWith('seriko.') && /(defaultsurface|\.path|\.text|sticky-window|zorder)$/.test(k)) return notYet(p);
  if (k.startsWith('sound') && /\.(position|playing|pause)$/.test(k)) return notYet(p);
  if (k.startsWith('shelllist') && k.endsWith('.menu')) return notYet(p);
  return false;
}

function setRaw(w, s, v) {
  for (const pre of ['currentghost.', 'ghostlist.current.']) {         // not activeghostlist.current. [disasm 0x78D001]
    if (headI(s, pre)) return ghostSet(call(w, 'self'), s.slice(pre.length), v);
  }
  const f = findNode(w, s);
  // a write through ghostlist(X) / activeghostlist(X) acts on the calling ghost [disasm SPGhostProp::VarSet 0x6C45E7];
  // system.*, baseware.* and the generic item names are never settable [disasm 0x65CA80, SPProp::VarSet]
  return f && f.kind === 'ghost' ? ghostSet(call(w, 'self'), f.rest, v) : false;
}

/**
 * Set a property for the calling ghost [disasm SPVarSystemDispatcher::Set 0x78CFE0]. Settable now:
 * `currentghost.scope(N).surface.num` (as \s), `currentghost.balloon.scope(N).num` (as \b) and `….ext.KEY`
 * (GET property.set to the calling ghost); the other names ssp.exe can set are logged once.
 * @param {PropertyWorld} world
 * @param {string} name
 * @param {string} value
 * @returns {boolean|Promise<boolean>} whether it was applied
 */
export function setProperty(world, name, value) {
  const s = name == null ? '' : String(name), v = value == null ? '' : String(value);
  let r;
  try {
    r = setRaw(world || {}, s, v);
  } catch (e) {
    log.once('property:set:error', 'property write failed', s, e);
    r = false;
  }
  return isThenable(r) ? Promise.resolve(r).then(x => x === true, () => false) : r === true;
}

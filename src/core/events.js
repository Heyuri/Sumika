// The event loop: owns the clock and turns runtime state into SHIORI events (shiori-events.md §1–§5, SUMMARY §1/§2).
// It is the PlayerHost of the script player and the only module that sends SHIORI requests.
//
// Arbitration (SS §6.5, C7): every request goes through one FIFO (ShioriClient). A GET reply with a script starts a
// new run, which replaces the current one, except replies to clock ticks, timeouts and surface restore: those play only
// if nothing else started since they were sent (generation stamps). `\t` drops mouse and key events. The reply to a
// script's own \![change,shell|balloon] waits for that script's end instead (_deferReply, EV §2.6).
//
// Several ghosts (EV §2.7): one loop per ghost; the loop never sees the site, only a `peers` handle (the other ghosts
// on screen, for otherghostname, Close vs Quit and a response's COMMUNICATE target) and its ghost's layer element (the
// keyboard's pointer test). It emits what the site acts on: 'call', 'quitall', 'activate', 'notified', 'talk',
// 'communicate' (a talk passed on at its run's end, EV §2.7.7), 'raiseother' (EV §2.7.9), 'closed' {script}; the site
// answers through communicated(), raisedByOther(), notifyEvent() and lockReason. A Satori ghost's requests carry the
// FMO text (fmo.js, EV §2.7.8).
//
// Hover (UI §4.8, EV §4.3, §4.7): the balloons' 'select' becomes OnChoiceEnter / OnAnchorEnter; the views ask tooltip
// texts through the hooks this loop sets, balloons.tipSource (OnChoiceHover / OnAnchorHover, then balloon_tooltip)
// and stage.tipSource (OnMouseHover, then the shell's own text or the `tooltip` resource).
//
// %-variables and properties (properties.md): every script expands once before it plays (expand(): before
// OnTranslate, again after an OnTranslate that changed it, an \![embed] reply before its own OnTranslate and splice,
// playScript, a choice's script:), never on a replay; replies still play in arrival order (_inOrder); %property,
// \![get|set,property] resolve over _world() (core/properties.js),
// which the Site's `props` widens to the other ghosts. User information (EV §4.16): `user` (core/user.js) feeds
// OnNotifyUserInfo and %username's fallback.
import { Emitter } from './emitter.js';
import { log } from './log.js';
import { dropPath, mimeOf } from './drops.js';
import { languageRefs } from './i18n.js';
import { otherGhostRef } from './ghostset.js';
import { HttpRequests } from './http.js';
import { fmoText } from './fmo.js';
import { installedBalloons } from './shells.js';
import { getProperty, setProperty as setProp } from './properties.js';
import { parseBool } from '../sakura/commands.js';
import { expandScript, WORD_NAMES } from '../sakura/expand.js';
import { pickWord } from './words.js';
import { decodeEntity } from '../sakura/entity.js';
import { tipText } from '../ui/tooltip.js';
import { findIcon, isTrayIconTag } from './trayicon.js';

export const DEFAULTS = {
  balloonTimeoutMs: 15000,    // SUMMARY §0.2; SSP's global Timeout.Balloon, also part of the restore delay
  choiceTimeoutMs: 30000,
  surfaceRestoreMs: 15000,    // OnSurfaceRestore: more than balloonTimeoutMs + this after the last stamp (EV §3.4)
  menuResourceMs: 300,        // UI §2.1: cap for the menu's resource batch
  minimizeWaitMs: 10000,      // longest wait for the OnWindowStateMinimize script before hiding
  changeWaitMs: 30000,        // longest wait for the leaving ghost's script before a ghost change goes on (EV §2.5)
};

/** NOTIFY basewareversion: claim SSP (Satori needs Sender: SSP anyway; SUMMARY §6 recommendation). */
export const BASEWARE = ['2.09.08', 'SSP', '2.9.8.0'];
/** Sumika's own version: window.sumika.version, About Sumika (UI §2.11), baseware.version (runtime.js re-exports it) */
export const VERSION = '1.0.0';

/**
 * %property[baseware.version] (properties.md §5.5): ssp.exe's `SSP/%s (%s; %s)` [disasm CreateVersionString 0x76832D]
 * from BASEWARE, so it never disagrees with basewareversion, with Sumika's build and `Web`: `SSP/2.9.08
 * (sumika-1.0.0; Web)` [decision, properties.md §8].
 */
export function basewareVersion(version = VERSION) {
  const [a, b, c] = BASEWARE[2].split('.');
  return `${BASEWARE[1]}/${a}.${b}.${String(c).padStart(2, '0')} (sumika-${version}; Web)`;
}

/**
 * \![open,con…,PAGE] (SS §5.9, UI §2.13): SSP's settings page types [disasm CSSPProperty ctor 0x4a5be0]. Sumika has a
 * box for `setup` (General) only.
 */
export const CONFIG_PAGES = Object.freeze(['setup', 'ghost', 'ghost2', 'folder', 'display', 'talk', 'saveshare',
  'dictation', 'network', 'network2', 'biff', 'application', 'messenger', 'ipmessenger', 'international',
  'streamingtool', 'developer']);

/**
 * Whether \![open,con…,PAGE] opens the Preferences box: no page, `setup` or a word that is no page type (ssp.exe shows
 * the page shown last, and Sumika's is always General; the page is compared exactly, any case, never trimmed [disasm
 * GetPageFromType 0x4a6fa0]); SSP's other page types open nothing [decision, properties.md §8].
 * @param {string|null|undefined} page
 */
export function settingsPage(page) {
  const p = page == null ? '' : String(page);
  if (p === '') return true;
  const k = p.replace(/[A-Z]+/g, c => c.toLowerCase());
  return !CONFIG_PAGES.includes(k) || k === 'setup';
}

/** ghosts.json `thumbnails` (site paths) as a property record's site-absolute `thumbnails`, when there are any. */
function thumbList(g, base) {
  const th = Array.isArray(g.thumbnails) ? g.thumbnails.filter(Boolean) : [];
  return th.length ? { thumbnails: th.map(p => base + encodeURI(String(p))) } : {};
}

/**
 * ghosts.json `icon` (a site path) as a property record's site-absolute `icon`, when the index found one: the file
 * SPGhostProp::GetIconName answers (descript icon, else icon.ico; the ghost root, then ghost/master/; it must exist)
 * [disasm 0x6c4dd0; properties.md §5.4]. None: the property fails.
 */
function iconProp(g, base) {
  return typeof g.icon === 'string' && g.icon ? { icon: base + encodeURI(g.icon) } : {};
}

/**
 * A ghost of the site index as a property record (properties.md §5.4, core/properties.js GhostRec), one that is not up
 * here: `live` null. `base`: the site's path ('/'-ended); paths, the icon and the thumbnail are site-absolute (EV §2.1
 * "Paths").
 */
export function indexGhostRecord(g, base = '/') {
  const id = String(g.id);
  return {
    id, name: String(g.name || id), path: `${base}ghost/${encodeURIComponent(id)}/`, craftman: String(g.craftman || ''),
    ...(iconProp(g, base)),
    ...(thumbList(g, base)),
    sakuraName: String(g.sakuraName || ''), keroName: String(g.keroName || ''), live: null,
  };
}

/** An installedBalloons() entry (shells.js) as a property record: its site path, a bundled one in its ghost's folder. */
export function balloonRecord(b, base = '/') {
  const id = String(b.id);
  const enc = encodeURIComponent;
  const rel = b.ghost ? `ghost/${enc(b.ghost)}/${enc(id)}/` : `balloon/${enc(id)}/`;
  return { id, name: String(b.name || id), path: base + rel };
}
export const CAPABILITIES = [
  'request.status', 'request.securitylevel', 'request.baseid', 'request.sendertype',
  'response.errorlevel', 'response.errordescription',
];

const realClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: h => clearTimeout(h),
};

const isOk = res => !!res && res.status >= 200 && res.status < 300;
const valueOf = res => (isOk(res) && typeof res.value === 'string' && res.value !== '' ? res.value : null);
/** statuses a word reply counts for [disasm SPShiori::GetWord 0x70CF98–0x70CFB1] */
const WORD_OK = new Set([200, 311, 312]);
/** A word reply's word (SPShiori::GetWord [disasm 0x70CFDA–0x70D051]): Value, else Word; an empty one is none. */
function wordOf(res) {
  if (!res || !WORD_OK.has(res.status)) return null;
  const h = res.headers instanceof Map ? res.headers : new Map();
  const v = typeof res.value === 'string' ? res.value : h.has('value') ? h.get('value') : h.get('word');
  return typeof v === 'string' && v !== '' ? v : null;
}
/** %et's units, by r mod 5 [disasm table 0xBBC5D8] */
const ET_UNITS = ['msec', 'yard', 'kg', 't', 'dozen'];
/** ssp.exe's genrand(n) (MT19937 mod n [disasm 0x578060]) over a random() in [0, 1): 0 … n − 1 */
const randInt = (random, n) => Math.min(n - 1, Math.floor(random() * n));
/** statuses a GetStringShiori reply has a string for [disasm SPShiori::GetStringShiori 0x712FB2–0x712FD4] */
const STRING_OK = new Set([200, 311, 312]);
/**
 * A GetStringShiori read (EV §5.5), for 3.0 and 2.x engines alike: for 200, 311 or 312 only, Value, else String, else
 * Sentence [disasm 0x712FE4–0x713022] (a header without a value is none: SPParamManager::ParseValue keeps no such
 * header [disasm 0x6B0548]), with SSP's `\&[name]` entities decoded [disasm 0x713033, SPGhost::DecodeEntity
 * 0x625B10]; null otherwise. Every resource string, tooltip text and `.ext.` property goes through it (_getString);
 * events, OnTranslate, \![embed] and TEACH replies never do (valueOf: any 2xx, Value only).
 */
function resourceOf(res) {
  if (!res || !STRING_OK.has(res.status)) return null;
  const h = res.headers instanceof Map ? res.headers : new Map();
  for (const v of [res.value, h.get('string'), h.get('sentence')]) {
    if (typeof v === 'string' && v !== '') return decodeEntity(v);
  }
  return null;
}
const isThenable = v => !!v && typeof v.then === 'function';
/** f(v), or a promise of it when v is a thenable (an expansion that had to ask an engine). */
const andThen = (v, f) => (isThenable(v) ? Promise.resolve(v).then(f) : f(v));
const delay = (clock, ms) => new Promise(r => clock.setTimeout(r, ms));
const pad2 = n => String(n).padStart(2, '0');

/** Local wall-clock minute, e.g. "2026-10-06T21:13" (state.clock.lastMinute). */
export function minuteKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Status header value, as ssp.exe's AddStatusText builds it [disasm 0x639a90–0x639eab] (EV §1.6); '' = idle, and the
 * header is then omitted. One mode slot (SPGhost+0x41a8): `induction` or `passive`, never both, and `timecritical`
 * only when neither [disasm 0x639b5b–0x639bce].
 */
export function statusFlags(s) {
  const f = [];
  if (s.talking) f.push('talking');
  if (s.choosing) f.push('choosing');
  if (s.minimizing) f.push('minimizing');
  if (s.changing) f.push('changing');
  if (s.induction) f.push('induction');
  else if (s.passive) f.push('passive');
  else if (s.timecritical) f.push('timecritical');
  if (s.nouserbreak) f.push('nouserbreak');
  if (s.opening && s.opening.length) f.push(`opening(${s.opening.join('/')})`);
  if (s.balloons && s.balloons.length) f.push(`balloon(${s.balloons.map(([sc, k]) => `${sc}=${k}`).join('/')})`);
  return f.join(',');
}

/**
 * A response's COMMUNICATE target (EV §2.7.7) [disasm SPShiori::Request 0x7101E1, SendCommunicate 0x70F620]: only for
 * a status that is not 204 and below 400; `HWnd` or `TargetHWnd` decide alone ({hwnd: true}: Sumika has no windows);
 * else `To`, and `Reference0` when `To` is missing or equal to it (`shifted`: the References go on from Reference1).
 * Needs a `Value` (or `Sentence`) header, empty or not. The References are SSP's GetValueReference [disasm 0x6AEC60]:
 * every header whose name starts with `Reference` (any case) at the index C's strtoul reads after it (above 100000:
 * skipped), up to the highest index, a gap kept as '' (SendCommunicate writes it as an empty `ReferenceN:` [disasm
 * 0x70FC6D–0x70FDB2]); from index 1 when shifted. `age` the response's `Age` (SSP never adds 1), else '0'; `marker`
 * its `MarkerSend`. A SHIORI/2.x engine's reply (`protocol` below 3: kawari7-wasm.md §6) names its target by `To`
 * alone and passes every Reference on [disasm 0x711878–0x7118c3].
 * @param {ShioriResponse} res headers lower-cased (parseResponse)
 * @returns {null | {hwnd: true} |
 *   {to:string, shifted:boolean, sentence:string, refs:string[], age:string, marker:string}}
 */
export function communicateOf(res) {
  if (!res || !(res.headers instanceof Map)) return null;
  const st = Number(res.status);
  if (!(st < 400) || st === 204) return null;
  const h = res.headers;
  const get = k => (h.has(k) ? String(h.get(k)) : null);
  const sentence = get('value') ?? get('sentence');
  if (get('hwnd') !== null || get('targethwnd') !== null) return sentence === null ? null : { hwnd: true };
  let to = get('to');
  let shifted = false;
  const r0 = get('reference0');
  const v2 = Number(res.protocol) < 3;
  if (!v2 && r0 !== null && (to === null || r0 === to)) { to = r0; shifted = true; }
  if (to === null || sentence === null) return null;
  const all = [];
  for (const [k, v] of h) {
    if (!k.startsWith('reference')) continue;
    const i = refIndex(k.slice(9));
    if (i === null) continue;
    while (all.length <= i) all.push('');
    all[i] = String(v);
  }
  const refs = shifted ? all.slice(1) : all;
  return { to, shifted, sentence, refs, age: get('age') ?? '0', marker: get('markersend') ?? '' };
}

/**
 * A `Reference…` header's index as SSP reads it: C's strtoul(s, NULL, 10) (white space, a sign, digits; no digit: 0),
 * null when above 100000 (`cmp ebx, 0x186a0`), so a negative one too (unsigned: huge) [disasm 0x6AECF4–0x6AED04].
 */
function refIndex(s) {
  const m = /^[\t\n\v\f\r ]*([+-]?)(\d*)/.exec(s);
  const n = m[2] ? Number(m[2]) : 0;
  if (m[1] === '-' && n !== 0) return null;
  return n > 100000 ? null : n;
}

/** A Communicate record from saved state (a run's, EV §2.7.7): a clean copy, or null when it is not well formed. */
function commRecord(c) {
  if (!c || typeof c !== 'object') return null;
  const strs = a => Array.isArray(a) && a.every(x => typeof x === 'string');
  if (!strs(c.ids) || !strs(c.refs)) return null;
  for (const k of ['sender', 'sentence', 'age', 'surface', 'marker']) if (typeof c[k] !== 'string') return null;
  return {
    ids: c.ids.slice(), sender: c.sender, sentence: c.sentence, refs: c.refs.slice(), age: c.age, surface: c.surface,
    marker: c.marker,
  };
}

/** SSP's case folding (the table of fold() in shells.js) [disasm]: A–Z, and the simple lower case above U+00FF. */
function foldKey(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let f = c;
    if (c < 0x100) f = c >= 0x41 && c <= 0x5a ? c + 32 : c;
    else if (c < 0xd800 || c > 0xdfff) { const l = String.fromCharCode(c).toLowerCase(); if (l.length === 1) f = l.charCodeAt(0); }
    out += String.fromCharCode(f);
  }
  return out;
}

/** A timer's key: its event name, any case, one list for every timer tag of the ghost (C8) [disasm 0x632F4D]. */
const timerKey = ev => foldKey(String(ev));
const TIMER_MIN_MS = 50;         // `cmp eax, 0x32`: 1–49 ms become 50 [disasm 0x632FBC]

/**
 * SUMMARY C6. ssp.exe 2.9.10 makes a tick NOTIFY only while a script plays, a \x or choice waits, \t, a shell change,
 * minimized, passive / induction (and SSTP quiet, SSF) [disasm OnTimeChange 0x641e03–0x641e50, TimerExec
 * 0x497fc6–0x49801d]. No box or dialog is part of it: an open box is only Status opening(…) (statusHeader) [disasm
 * AddStatusText 0x639c2e; decision: follow SSP].
 */
export function computeCantalk(s) {
  return !!(s.booted && !s.closing && !s.talking && !s.choosing && !s.minimized && !s.passive && !s.induction &&
    !s.hidden && !s.frozen);
}

/**
 * A balloon item's References (SelectEvent [disasm 0x5cf260], EV §4.7): R0 its text as shown, R1 the ID as parsed,
 * R2… the tag's further arguments. The same for OnChoiceEnter / OnAnchorEnter, OnChoiceHover / OnAnchorHover and
 * balloon_tooltip.
 * @param {{label?:string, id?:string, refs?:string[]}} item
 */
export function hoverRefs(item) {
  const s = v => (v == null ? '' : String(v));
  return [s(item.label), s(item.id), ...(Array.isArray(item.refs) ? item.refs.map(s) : [])];
}

/** Mouse References (EV §4.1): x, y, wheel, scope, collision, button, device. */
export function mouseRefs(info, r5) {
  return [
    Math.floor(Number(info.x) || 0),
    Math.floor(Number(info.y) || 0),
    info.type === 'wheel' ? Math.round(Number(info.wheel) || 0) : 0,
    info.scope | 0,
    info.collision == null ? '' : String(info.collision),
    r5,
    info.device || 'mouse',
  ];
}

/**
 * OnMouseGesture's References (EV §4.5.1) [disasm CCharWndCode::SendGestureEvent 0x418850]: R0 scope, R1 the point
 * now in the window as "x\x01y" (not scaled to the surface as the other mouse events are), R2 the collision there,
 * R3 the press point as "x\x01y", R4 the press's collision, R5 the name (GESTURE_DIRS, circle.cw / circle.ccw, end),
 * R6 the step's angle truncated (0 for end).
 */
export function gestureRefs(info) {
  const f = v => Math.floor(Number(v) || 0);
  const s = v => (v == null ? '' : String(v));
  return [
    info.scope | 0,
    `${f(info.wx)}\x01${f(info.wy)}`,
    s(info.collision),
    `${f(info.wx0)}\x01${f(info.wy0)}`,
    s(info.collision0),
    s(info.name),
    info.name === 'end' ? 0 : Math.trunc(Number(info.deg) || 0),
  ];
}

// ---- keyboard (EV §4.6, SUMMARY C8/C9) ----

const KEY_NAMES = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Space: 'space', Enter: 'return', NumpadEnter: 'return', Escape: 'escape', Tab: 'tab', Backspace: 'back',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  ShiftLeft: 'shift-left', ShiftRight: 'shift-right', ControlLeft: 'control-left', ControlRight: 'control-right',
  AltLeft: 'alt-left', AltRight: 'alt-right', CapsLock: 'capslock', NumLock: 'numlock', ScrollLock: 'scrolllock',
  PrintScreen: 'printscreen', Pause: 'pause', Clear: 'clear',
  NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.',
};
// unshifted key-tops of a US layout, used when the layout map is unavailable and Shift hides the real one
const US_KEYTOPS = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', IntlRo: '\\', IntlYen: '\\',
};
const VK_BY_NAME = {
  up: 38, down: 40, left: 37, right: 39, space: 32, return: 13, escape: 27, tab: 9, back: 8, delete: 46, insert: 45,
  home: 36, end: 35, pageup: 33, pagedown: 34, 'shift-left': 16, 'shift-right': 16, 'control-left': 17,
  'control-right': 17, 'alt-left': 18, 'alt-right': 18, capslock: 20, numlock: 144, scrolllock: 145,
  printscreen: 44, pause: 19, clear: 12, ',': 188, '.': 190, '-': 189, '/': 191, ';': 186, '=': 187, '`': 192,
  '[': 219, ']': 221, '\\': 220, "'": 222,
};

/**
 * SSP key name (R0) for a KeyboardEvent: lower-case, the unshifted key-top for characters.
 * @param {{code?:string, key?:string, shiftKey?:boolean}} e
 * @param {Map<string,string>|null} layout navigator.keyboard layout map (code -> unshifted character), if known
 */
export function keyName(e, layout = null) {
  const code = e.code || '';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  let m;
  if ((m = /^F(\d{1,2})$/.exec(code))) return 'f' + m[1];
  if ((m = /^(?:Digit|Numpad)(\d)$/.exec(code))) return m[1];
  const key = typeof e.key === 'string' ? e.key : '';
  if ((m = /^Key([A-Z])$/.exec(code))) return /^[a-z]$/i.test(key) ? key.toLowerCase() : m[1].toLowerCase();
  if (layout && typeof layout.get === 'function') {
    const k = layout.get(code);
    if (k) return k.toLowerCase();
  }
  if (!e.shiftKey && [...key].length === 1) return key.toLowerCase();
  if (US_KEYTOPS[code]) return US_KEYTOPS[code];
  if ([...key].length === 1) return key.toLowerCase();
  return key ? key.toLowerCase() : code.toLowerCase();
}

/** Win32 virtual-key code (R1). */
export function keyVk(e, name) {
  if (e.keyCode > 0) return e.keyCode;
  if (VK_BY_NAME[name] !== undefined) return VK_BY_NAME[name];
  if (/^[a-z0-9]$/.test(name)) return name.toUpperCase().charCodeAt(0);
  const f = /^f(\d+)$/.exec(name);
  return f ? 111 + Number(f[1]) : 0;
}

/** R4: held modifiers in SSP's order. */
export function keyModifiers(e) {
  return [e.shiftKey && 'shift', e.ctrlKey && 'ctrl', e.altKey && 'alt'].filter(Boolean).join(',');
}

function isEditable(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const t = String(el.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'range', 'color', 'file'].includes(t);
  }
  if (el.isContentEditable) return true;
  const ce = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
  return ce != null && String(ce).toLowerCase() !== 'false';
}

/**
 * The element a key event was really typed into. Shadow DOM retargets `target` to the shadow host (our own
 * <sumika-root> for the input and communicate boxes, or a page's web component), so use composedPath()[0].
 */
function keyTarget(ev) {
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  return (path && path[0]) || ev.target || null;
}

/** True when the event happened inside the runtime's own Shadow DOM host. */
function insideRuntime(ev) {
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  return path.some(n => n && n.tagName === 'SUMIKA-ROOT');
}

/** A ghost's layer (`<div class="smk-ghost">`, ui/layers.js): its characters, balloons and boxes. */
function isGhostLayer(n) {
  try {
    if (!n || n.nodeType !== 1) return false;
    if (n.classList && typeof n.classList.contains === 'function') return n.classList.contains('smk-ghost');
    return typeof n.className === 'string' && /(^|\s)smk-ghost(\s|$)/.test(n.className);
  } catch (e) {
    return false;
  }
}

/** The ghost layer an event happened in (the innermost), null outside every layer (menus, the page). */
function layerOf(ev) {
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  return path.find(isGhostLayer) || null;
}

/** A focusin on an element of the host page itself (not the document as a whole, not our own UI). */
function isPageFocus(ev) {
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  const el = path[0] || ev.target;
  if (!el || el.nodeType !== 1 || insideRuntime(ev)) return false;
  const tag = String(el.tagName || '').toUpperCase();
  return tag !== 'BODY' && tag !== 'HTML';
}

// ---- boxes (EV §4.8, SS §5.9) ----

const INPUT_KINDS = {
  inputbox: 'text', passwordinput: 'password', dateinput: 'date', timeinput: 'time', sliderinput: 'slider',
  ipinput: 'ip',
};

/** OnTeach's 311 Not Enough / 312 Advice (EV §1.2, UI §6.3): the teach box asks again. */
const TEACH_AGAIN = new Set([311, 312]);
const teachValue = res => valueOf(res) ??
  (res && TEACH_AGAIN.has(res.status) && typeof res.value === 'string' && res.value !== '' ? res.value : null);

/**
 * Parse \![open,inputbox|communicatebox|teachbox,...] arguments (positional and --key=value forms). The teach box takes
 * the communicate box's forms (UKADOC documents none for it) [guess].
 */
export function parseBoxArgs(kind, args = []) {
  const o = { id: '', timeoutMs: 0, text: '', options: [], refs: [], limit: 0, balloon: null, title: '' };
  const pos = [];
  for (const a of args.map(x => (x == null ? '' : String(x)))) {
    const m = /^--([a-z-]+)=([\s\S]*)$/i.exec(a);
    if (!m) { pos.push(a); continue; }
    const v = m[2];
    switch (m[1].toLowerCase()) {
      case 'timeout': o.timeoutMs = Number(v); break;
      case 'text': o.text = v; break;
      case 'option': o.options.push(v.toLowerCase()); break;
      case 'reference': o.refs.push(v); break;
      case 'limit': o.limit = Number(v) || 0; break;
      case 'balloon': o.balloon = v; break;
      case 'title': o.title = v; break;
      default: log.once(`box-opt:${m[1]}`, `\\![open,${kind}]: option --${m[1]} is not supported`);
    }
  }
  if (kind === 'communicatebox' || kind === 'teachbox') {
    if (pos.length && pos[0] !== '') o.text = pos[0];
  } else {
    o.id = pos[0] || '';
    if (pos[1] !== undefined && pos[1] !== '') o.timeoutMs = Number(pos[1]);
    if (pos[2] !== undefined) o.text = pos[2];
  }
  if (!(o.timeoutMs > 0)) o.timeoutMs = 0;
  return o;
}

/** \![set,choicetimeout|balloontimeout,ms]: '' = default (undefined); 0 / negative = never (0). */
function parseTimeoutOpt(v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n > 0 ? n : 0;
}

function browserEnv() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return { win: null, doc: null };
  return { win: window, doc: document };
}

/** {id, name} of a shell (name '' = look it up in ghost.shells); null without an id. */
function shellRef(s) {
  if (!s || typeof s !== 'object' || s.id == null || String(s.id) === '') return null;
  return { id: String(s.id), name: s.name == null ? '' : String(s.name) };
}

const DRESSUP_SKIP = 100;         // >= 100 changes: no OnDressupChanged at all ("jae 0x64" [disasm], EV §4.11)
/** reply origins a shell swap drops (they play only if nothing else started anyway); it holds the others (_swapHold) */
const SWAP_DROPS = new Set(['tick', 'restore', 'timeout', 'dressup', 'async']);

/**
 * The changes one dress-up flush reports (EV §4.11): one per part, its net change over the flush (a part switched on
 * and off again reports nothing; SSP diffs each applied block [disasm], we diff the flush [decision]), then every
 * "off" before every "on", each group in the order the parts first changed [disasm: stable sort on the new state].
 * @param {{scope:number, id?:number|null, category:string, part:string, on:boolean, origin:string}[]} list
 */
export function dressupChanges(list) {
  const byKey = new Map();
  for (const c of list) {
    const key = `${c.scope}\x00${c.id != null && Number.isFinite(c.id) ? c.id : `${c.category}\x01${c.part}`}`;
    const seen = byKey.get(key);
    if (seen) seen.last = c;
    else byKey.set(key, { before: !c.on, last: c });
  }
  const net = [...byKey.values()].filter(e => e.last.on !== e.before).map(e => e.last);
  return [...net.filter(c => !c.on), ...net.filter(c => c.on)];
}

/**
 * @typedef {{status:number, headers:Map<string,string>, value:string|null}} ShioriResponse
 * @typedef {{gen:number, script:string, event:string, refs:string[], origin:string, fromSurfaceRestore:boolean,
 *            finished: Promise<object>, communicate: Communicate|null, ghostChange: boolean, talk: boolean}} Run
 * @typedef {{ids:string[], sender:string, sentence:string, refs:string[], age:string, surface:string,
 *            marker:string}} Communicate  a talk to pass on (EV §2.7.7): target ids and sender's sakura name fixed
 *            when the response came, the raw Value, References (from Reference1 when shifted), Age, `s0\x01s1`,
 *            MarkerSend; plain JSON, saved with its run
 */
export class EventLoop extends Emitter {
  /**
   * @param {object} o
   * @param {import('./shiori.js').ShioriClient} o.shiori
   * @param {object} [o.player]   ScriptPlayer (or set later with setPlayer, it needs this object as its host)
   * @param {object} o.stage
   * @param {object} [o.balloons]
   * @param {object} [o.dialogs]
   * @param {object} [o.ghost]    ghosts.json entry
   * @param {import('./state.js').StateStore} [o.state]
   * @param {object} [o.menu]     ui/menu.js Menu (open({scope, x, y, device}); loadShioriLook() when it has one: boot
   *   awaits it after the NOTIFY batch, UI §2.3)
   * @param {object} [o.files]    GhostFiles of the ghost root (URLs for \j[file:], sounds)
   * @param {Map<string,string>} [o.ghostDescript]
   * @param {object} [o.site]     SiteIndex (installed* lists)
   * @param {object} [o.input]    InputClock (idle seconds)
   * @param {object} [o.audio]    page-side sound player ({sound(cmd, args)}; optional musicState(), resumeMusic(s))
   * @param {object} [o.drops]    DropStore (core/drops.js): dropped files -> pseudo-paths ({add(files)})
   * @param {{shell?:string, balloon?:string}} [o.paths]  site-absolute folder paths for OnNotifySelfInfo
   * @param {{id:string, name?:string}} [o.shell]  the shell in use: its descript name goes out wherever SSP sends a
   *   "shell name" (EV §2.1, §2.6); none: the state's shell, else ghost.defaultShell, named from ghost.shells
   * @param {string} [o.balloonName]  the balloon in use (the site default is not in the state), for OnNotifySelfInfo
   * @param {number} [o.sessionEpochMs]
   * @param {object} [o.language] core/language.js UiLanguage: NOTIFY OnLanguageChange at boot, GET OnLanguageChange
   *   when the language in effect changes (UI §2.10); none: English at boot, no changes
   * @param {object} [o.env]      {win, doc}; null members disable DOM listeners (tests)
   * @param {object} [o.clock]
   * @param {object} [o.options]  overrides for DEFAULTS
   * @param {{others: () => object[], count: () => number, busy: () => boolean, match?: (to: string) => string[]}|null}
   *   [o.peers] the site's handle (EV §2.7): others() = the other ghosts that count as up, as peerInfo() objects
   *   (otherghostname, the FMO); count() = the ghosts on screen in this tab, this one included (Close vs Quit); busy()
   *   = a call or ghost change is under way (Close and Quit do nothing); match(to) = the ids of the other ghosts a
   *   response's `To` / `Reference0` names (EV §2.7.7). None: alone (a single ghost)
   * @param {object|null} [o.layer] this ghost's layer element (ui/layers.js): a press in another ghost's layer takes
   *   the keys away from this one (EV §4.6)
   * @param {Function|null} [o.fetch] what \![execute,http-*] sends with (EV §4.15); default the env window's fetch, so
   *   a loop without a window (tests, the sweep) sends nothing unless given one
   * @param {object|null} [o.user] core/user.js UserProfile (isSet(), refs(), nickname()): NOTIFY OnNotifyUserInfo in
   *   the boot batch once the visitor saved the Preferences box, and %username's fallback (EV §4.16); none: neither
   * @param {{ghosts?: () => object[], active?: () => object[], balloons?: () => object[],
   *   openSettings?: (page: string) => boolean}|null} [o.props] the Site's handle for the property system
   *   (Site.propsFor, properties.md §1): ghostlist, activeghostlist and balloonlist as records (core/properties.js
   *   GhostRec / ItemRec), and \![open,con…]'s Preferences box. A missing member: this ghost and its site index only
   *   (tests, the sweep); no openSettings: the tag opens nothing
   * @param {(() => Promise<{name: string, words: string[]}[]|null>)|null} [o.wordList] SSP's word list (core/words.js,
   *   Site.compatibleWords) for the word variables no SHIORI answers (properties.md §2.4); none: no list, such a
   *   variable stays as written
   * @param {() => number} [o.random] the random picks of the word variables, %et and %wronghour (ssp.exe's genrand;
   *   default Math.random)
   */
  constructor(o) {
    super();
    this.shiori = o.shiori;
    this.player = null;
    this.stage = o.stage;
    this.balloons = o.balloons || null;
    this.dialogs = o.dialogs || null;
    this.ghost = o.ghost || {};
    this.state = o.state || null;
    this.menu = o.menu || null;
    this.files = o.files || null;
    this.descript = o.ghostDescript || new Map();
    this.site = o.site || null;
    this.input = o.input || null;
    this.audio = o.audio || null;
    this.drops = o.drops || null;
    this.paths = o.paths || {};
    this.shell = shellRef(o.shell);
    this.balloonName = o.balloonName || '';
    this.language = o.language || null;
    this.env = o.env || browserEnv();
    this.clock = o.clock || realClock;
    this.opts = { ...DEFAULTS, ...(o.options || {}) };
    this.sessionEpochMs = o.sessionEpochMs || this.clock.now();
    this.peers = o.peers || null;
    this.layer = o.layer || null;
    this.user = o.user || null;
    this.props = o.props || null;
    this.wordList = typeof o.wordList === 'function' ? o.wordList : null;
    this.random = typeof o.random === 'function' ? o.random : Math.random;

    this.booted = false;
    this.closing = false;         // false | 'one' (Close while others stay) | 'all' (Quit, the last Close) (EV §2.3)
    this._closeDropping = false;  // a minimized or locked ghost's close events are on their way (restore refused)
    this._closeFrom = 0;          // gen of the close script's run: its end (or a newer run's) decides the close
    this._closeAsking = false;    // OnCloseAll / OnClose on its way
    this.closed = false;
    // a ghost change: from OnGhostChanging (or the script that asked) until unloaded; no Status flag (EV §1.6)
    this.changing = false;
    this._farewell = null;       // {broken}: the leaving ghost's script, which a balloon break may cancel (EV §2.5)
    this.frozen = false;
    this.minimized = null;
    this.minimizing = false;
    // a script's \![set,trayicon] icon (ghost-root-relative), SSP's CSakuraWnd+0x6b8: shown at the next minimize, then
    // gone [disasm LoadTrayIcon 0x49e4c3–0x49e55c] (UI §2.6)
    this.trayIcon = null;
    this.ghostLife = { passive: false, induction: false };
    this.lastMinute = null;

    this.gen = 0;
    this.current = null;
    this.choicesLive = false;
    this.scriptOpts = {};
    this.post = null;             // the balloon or choice timeout of the finished run ({kind: 'balloon'|'choice', …})
    this._restoreAt = 0;          // OnSurfaceRestore pending since this stamp (epoch ms), 0 = none (EV §3.4)
    this._resumeRemaining = undefined;
    this.timers = new Map();
    this.pendingDressup = [];
    this._dressupScheduled = false;
    this._dressupFlushing = null;  // the dress-up report on its way (_flushDressup), which timers wait for
    this.pendingUserDressup = [];  // Clothes/Dressup ▸ picks: reported at once, also while a script plays (EV §4.11)
    this._userBlock = false;       // a pick was applied since the last 'user' flush (its changes may be none)
    this._userDressupScheduled = false;
    /** Runtime hook for Shell ▸ / Balloon ▸ / \![change,shell|balloon] (EV §2.6): (req) => Promise<boolean> */
    this.viewSwitcher = null;
    /** Runtime hook for a script's \![change,ghost] (EV §2.7.7): (target, {byId}) => whether it finds a ghost */
    this.ghostFinder = null;
    /** Runtime hook for \![reload,shiori] (EV §2.10): () => Promise<boolean>, the engine unloaded and loaded again */
    this.shioriReloader = null;
    this._viewWait = null;        // {broken}: OnShellChanging's talk, which a balloon break cancels (EV §2.6)
    this._replyQueue = [];        // replies that play when the running script ends (OnShellChanged after a script's tag)
    this._swap = null;            // a shell swap under way (detachStage until shellChanged): {held: replies for after it}
    // Status `changing` (EV §1.6): SSP's shell-change flag SPGhost+0x41a4 [disasm AddStatusText 0x639b32], from
    // OnShellChanging's response (or a swap's start) until OnShellChanged's response; a ghost change has none
    this._shellFlag = false;
    this._order = null;           // the last reply's expand / OnTranslate / play stage, while one runs (_inOrder)
    this.pendingSurface = new Map();
    this.surfaceLive = false;
    this.tickHandle = null;
    this.tickBusy = false;
    this._mikire = 0;             // OnSecondChange R1 / R2 as last sampled (_sampleCollisions, EV §3.2.1)
    this._kasanari = 0;
    this.moveInFlight = false;
    this.moveQueued = null;
    this.press = null;
    this._mouseQueue = null;
    this.lastPointer = null;
    this.boxes = new Map();
    this.active = false;
    this.activeScope = 0;
    this.keyRepeat = new Map();
    this.keyLayout = null;
    this.resourceCache = new Map();
    this._linkSeen = new WeakSet();
    this._lastLink = null;
    this._choiceWait = null;      // {gen}: a choice was clicked and its reply has not started yet
    this._live = null;            // propRecord()'s `live` (made once)
    this._comm = null;            // the pending COMMUNICATE (one slot, EV §2.7.7): the next script queued takes it
    // a Satori request's `fmo` (EV §2.7.8); none once this ghost closed or its loop was torn down (frozen)
    this._fmoSource = () => (this.closed || this.frozen ? null : fmoText(this.peerInfo(), this._others()));
    this._restored = false;       // boot() has applied (cold boot: dropped) the stored state; until then saves keep it
    this._offs = [];
    this._stageOffs = [];         // the stage's subscriptions: a shell swap moves them to the new stage
    this._balloonTipSource = item => this._balloonTip(item);    // the hooks the views ask tooltip texts through
    this._shellTipSource = req => this._shellTip(req);
    // \![execute,http-*] (EV §4.15): this ghost's requests, its file writes and its events
    const win = this.env.win;
    this.http = new HttpRequests({
      host: this._httpHost(), clock: this.clock,
      fetch: o.fetch !== undefined ? o.fetch : win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null,
      pageProtocol: (win && win.location && win.location.protocol) || '',
    });

    if (o.player) this.setPlayer(o.player);
    this._wire();
  }

  setPlayer(player) {
    this.player = player;
    if (player && typeof player.on === 'function') {
      this._offs.push(player.on('link', info => this._onLink(info)));
    }
  }

  setShiori(shiori) { this.shiori = shiori; }

  // ---------------------------------------------------------------- wiring

  /** The stage's events, on their own off-list: a shell swap moves them to the new stage (detachStage/attachStage). */
  _wireStage() {
    const st = this.stage;
    if (!st || typeof st.on !== 'function') return;
    const on = (type, fn) => { this._stageOffs.push(st.on(type, fn)); };
    on('mouse', info => this._onMouse(info));
    on('surface', ev => this._onSurface(ev));
    on('bind', ev => this._onBind(ev));
    on('move', () => this.state && this.state.change());
    on('drop', info => this._onDrop(info));
    st.tipSource = this._shellTipSource;
  }

  _unwireStage() {
    for (const off of this._stageOffs) { try { if (typeof off === 'function') off(); } catch (e) { /* ignore */ } }
    this._stageOffs = [];
    const st = this.stage;
    if (st && typeof st === 'object' && st.tipSource === this._shellTipSource) st.tipSource = null;
  }

  _wire() {
    const on = (obj, type, fn) => {
      if (obj && typeof obj.on === 'function') this._offs.push(obj.on(type, fn));
    };
    this._wireStage();
    on(this.balloons, 'link', info => this._onLink(info));
    on(this.balloons, 'select', ev => this._onSelect(ev));
    if (this.balloons && typeof this.balloons === 'object') this.balloons.tipSource = this._balloonTipSource;
    on(this.balloons, 'click', ev => this._activate(ev && ev.scope));
    on(this.balloons, 'dblclick', ev => this._onBalloonDblClick(ev || {}));
    on(this.balloons, 'state', () => this.state && this.state.change());
    on(this.language, 'change', e => this._onLanguage(e || {}));
    if (this.state) this._offs.push(this.state.addCollector(d => this._collect(d)));

    const { win } = this.env;
    if (win && win.addEventListener) {
      const listen = (target, type, fn, opts) => {
        target.addEventListener(type, fn, opts);
        this._offs.push(() => target.removeEventListener(type, fn, opts));
      };
      listen(win, 'keydown', e => this._onKeyDown(e), true);
      listen(win, 'keyup', e => this._onKeyUp(e), true);
      listen(win, 'blur', () => this.keyRepeat.clear());
      listen(win, 'pointerdown', e => {
        this.lastPointer = { x: e.clientX, y: e.clientY, at: this.clock.now() };
        // a press outside the runtime, or on another ghost (its layer), takes the keys away (EV §4.6, §2.7) [infer]
        if (!insideRuntime(e)) this.active = false;
        else { const l = layerOf(e); if (l && l !== this.layer) this.active = false; }
      }, { capture: true, passive: true });
      listen(win, 'pointerup', e => { this.lastPointer = { x: e.clientX, y: e.clientY, at: this.clock.now() }; }, { capture: true, passive: true });
      // focus moving to a page control (Tab to a link or button) hands the keyboard back to the page (EV §4.6)
      listen(win, 'focusin', e => { if (this.active && isPageFocus(e)) this.active = false; }, true);
      try {
        const kb = win.navigator && win.navigator.keyboard;
        if (kb && typeof kb.getLayoutMap === 'function') kb.getLayoutMap().then(m => { this.keyLayout = m; }, () => {});
      } catch (e) { /* not available */ }
    }
  }

  destroy() {
    this.stop();
    this._cancelPost();
    this.http.invalidate();
    for (const t of this.timers.values()) this._disarm(t);
    for (const off of this._offs) { try { off(); } catch (e) { /* ignore */ } }
    this._offs = [];
    this.frozen = true;
    this._acceptDrops(false);
    this._unwireStage();
    if (this.balloons && this.balloons.tipSource === this._balloonTipSource) this.balloons.tipSource = null;
    this._replyQueue = [];
    this._swap = null;
    this._shellFlag = false;
    if (this._farewell && this._farewell.wake) this._farewell.wake();     // a farewell waiting here ends (not ok)
    this._wakeViewWait();
  }

  /** OnShellChanging's wait ends (not ok): the ghost closed, was suspended or torn down. */
  _wakeViewWait() {
    const w = this._viewWait;
    if (w && w.wake) w.wake();
  }

  // ---------------------------------------------------------------- state

  _talking() { return !!(this.player && this.player.busy); }
  _choosing() { return this.choicesLive; }
  /** A choice was selected and no run has started since: its reply is on the way (the old balloon is still up). */
  _choicePending() { return !!this._choiceWait && this._choiceWait.gen === this.gen; }
  /**
   * Status `choosing` (EV §1.6) [disasm AddStatusText 0x639aa8, 0x639ad8–0x639b09]: a balloon holds a \q or \__q item
   * and a balloon is up (Balloons#choosing), while a script plays too and in a pick's own OnChoiceSelect. Not the
   * choice wait that cantalk and the ticks read (_choosing, _choicePending).
   */
  _statusChoosing() { try { return !!(this.balloons && this.balloons.choosing); } catch (e) { return false; } }
  _timeCritical() { return !!(this.player && this.player.timeCritical); }
  _hidden() { const d = this.env.doc; return !!(d && d.hidden); }

  /**
   * A shell swap is under way: from detachStage() until shellChanged() has played or queued OnShellChanged's reply,
   * or until a failed swap attaches the old stage again (EV §2.6). Meanwhile cantalk is 0, no reply plays and the run
   * playing when it started is held (player.hold()).
   */
  get swapping() { return !!this._swap; }

  get cantalk() {
    return computeCantalk({
      // a shell swap counts as closing: SSP swaps synchronously, so no talk starts before OnShellChanged
      booted: this.booted, closing: this.closing || this.closed || this.changing || !!this._swap, talking: this._talking(),
      choosing: this._choosing() || this._choicePending(), minimized: !!this.minimized, passive: this.ghostLife.passive, induction: this.ghostLife.induction,
      hidden: this._hidden(), frozen: this.frozen,
    });
  }

  statusHeader() {
    const opening = [];
    for (const b of this.boxes.values()) {
      const k = b.kind === 'communicatebox' ? 'communicate' : b.kind === 'teachbox' ? 'teach' : 'input';
      if (!opening.includes(k)) opening.push(k);
    }
    return statusFlags({
      talking: this._talking(), choosing: this._statusChoosing(), minimizing: !!this.minimized, changing: this._shellFlag,
      induction: this.ghostLife.induction, passive: this.ghostLife.passive, timecritical: this._timeCritical(),
      nouserbreak: !!(this.player && this.player.noUserBreak),
      opening, balloons: this._balloonKinds(),
    });
  }

  _balloonKinds() {
    try {
      const b = this.balloons;
      return b && typeof b.visibleKinds === 'function' ? b.visibleKinds() : [];
    } catch (e) {
      return [];
    }
  }

  _collect(d) {
    const grab = (name, fn) => { try { return fn(); } catch (e) { log.once(`collect-${name}`, `saving ${name} state failed`, e); return undefined; } };
    // the stage and balloons were made from the stored state (runtime.js), so they are live from the start
    if (this.stage && typeof this.stage.saveState === 'function') {
      const s = grab('stage', () => this.stage.saveState());
      if (s !== undefined) d.stage = s;
    }
    if (this.balloons && typeof this.balloons.saveState === 'function') {
      const b = grab('balloons', () => this.balloons.saveState());
      if (b !== undefined) d.balloons = b;
    }
    // the names in effect: what the others see of this ghost on the next page until its loop is up (EV §2.7.5)
    const names = grab('names', () => ({ sakura: this._charName(0), kero: this._charName(1) }));
    if (names !== undefined) d.names = names;
    // the rest is restored by boot() after the engine has answered (SUMMARY §2.5). A save before that (pagehide, a
    // hidden tab, a takeover) leaves it as stored: d is the very object boot() restores from.
    if (!this._restored) return;
    d.closed = this.closed;
    d.minimized = this.minimized ? { ...this.minimized } : null;
    d.trayIcon = this.trayIcon || null;
    d.ghostLife = { ...this.ghostLife };
    d.timers = [...this.timers.values()].map(t => ({
      ev: t.ev, refs: t.refs, repeat: t.repeat, intervalMs: t.intervalMs, dueAt: t.dueAt, kind: t.kind,
      ...(typeof t.to === 'string' ? { to: t.to } : {}),
    }));
    // a teach box keeps the words of its 311/312 round so far (UI §6.3)
    d.boxes = [...this.boxes.values()].filter(b => !b.silent).map(b => ({
      kind: b.kind, id: b.id, args: b.args, dueAt: b.dueAt, ...(b.words ? { words: b.words.slice() } : {}),
    }));
    d.clock = { lastMinute: this.lastMinute };
    // a pending OnSurfaceRestore keeps its stamp over a page change: SSP's ghost would keep running (EV §3.4)
    d.surfaceRestoreAt = this._restoreAt || 0;
    // the music box keeps playing on the next page (TS §3.4 "Page navigation"); closing stops it (dsaudio unload)
    if (this.audio && typeof this.audio.musicState === 'function') {
      d.music = this.closed ? null : grab('music', () => this.audio.musicState()) || null;
    }
    // a farewell is never replayed: a page left during a change carries the change on instead (runtime.js, EV §2.5);
    // OnShellChanging's talk neither: a page left during it drops the shell change (EV §2.6) [decision]
    if (this.closed || this.changing || this._viewWait) { d.run = null; return; }
    let run = null;
    if (this.player && typeof this.player.runState === 'function') run = grab('run', () => this.player.runState()) || null;
    // a finished run is worth replaying only while its balloon is still up (timeout pending, choices live, or a
    // \![set,balloontimeout,0] that keeps it up: replayed, it holds OnSurfaceRestore back again, EV §3.4)
    const lingering = this.choicesLive || !!this.post || this.scriptOpts.balloonTimeoutMs === 0;
    if (run && !['running', 'blocked', 'clickwait'].includes(run.state) && !(run.state === 'finished' && lingering)) run = null;
    if (run && this.current) {
      run = { ...run, origin: run.origin || this.current.event, refs: this.current.refs };
      if (this.post) run.timeoutRemainingMs = Math.max(0, Math.round(this.post.remaining));
      if (this.current.fromSurfaceRestore) run.fromSurfaceRestore = true;
      // a talk to pass on rides with its run: the next page sends it at the replay's end (EV §2.7.7) [decision]
      const c = commRecord(this.current.communicate);
      if (c) run.communicate = c;
    }
    d.run = run;
  }

  // ---------------------------------------------------------------- requests

  /**
   * One request through the FIFO. Never throws: failures come back as a 500 response. Like SPShiori::Request, every
   * response is looked at for a COMMUNICATE target (_noteComm), except with `comm: false`: SSP's other path for the
   * boot NOTIFY batch, otherghostname and resource strings [disasm xref 0x69CE20] (EV §2.7.7).
   */
  async _request(id, refs = [], { method = 'GET', headers = {}, comm = true, kind = '', self = '' } = {}) {
    this._flushSurfaces();
    const h = { ...headers };
    const status = this.statusHeader();
    if (status) h.Status = status;
    if (!this.shiori) return { status: 503, headers: new Map(), value: null, failed: true };
    try {
      // kind (and self): which of ssp.exe's calls this is, for a SHIORI/2.x engine's bridge (worker shiori2.js,
      // kawari7-wasm.md §6); never in the request text
      const req = { method, id, refs, headers: h, ...(kind ? { kind } : {}), ...(self ? { self } : {}) };
      const res = await this.shiori.request(this._withFmo(req));
      if (res && res.status >= 300 && !(id === 'OnTeach' && TEACH_AGAIN.has(res.status))) {
        log.once(`status:${id}:${res.status}`, `${method} ${id} -> ${res.status}`);
      }
      if (res && comm) this._noteComm(res);
      return res || { status: 500, headers: new Map(), value: null };
    } catch (e) {
      log.once(`req-fail:${id}`, `${method} ${id} failed: ${e && e.message ? e.message : e}`);
      return { status: 500, headers: new Map(), value: null, failed: true };
    }
  }

  /**
   * A Satori ghost's request carries the FMO text as a function (EV §2.7.8): the client reads it when the request
   * leaves its queue and posts it only when it changed (shiori.js). YAYA and the others get none [decision].
   */
  _withFmo(req) {
    if ((this.ghost.engine || 'satori') === 'satori') req.fmo = this._fmoSource;
    return req;
  }

  /**
   * SPShiori::SendCommunicate (EV §2.7.7) [disasm 0x70F620]: a response that names other ghosts fills the pending slot,
   * fixed now (the target ids through peers.match, the sakura name in effect, the surfaces); one that names nobody
   * leaves it as it was (A4). `HWnd` / `TargetHWnd` would aim at a window: Sumika has none, so the slot is emptied and
   * nothing goes [decision]. Alone (no peers.match) nothing is ever filled.
   */
  _noteComm(res) {
    const c = communicateOf(res);
    if (!c) return;
    if (c.hwnd) { this._comm = null; return; }
    const peers = this.peers;
    if (!peers || typeof peers.match !== 'function') return;
    let ids = [];
    try {
      ids = peers.match(c.to) || [];
    } catch (e) {
      log.once('peers-match', 'the other ghosts could not be matched', e);
      return;
    }
    if (!Array.isArray(ids) || !ids.length) return;
    const surface = s => { const n = this._surfaceOf(s); return Number.isInteger(n) && n >= 0 ? n : -1; };
    this._comm = {
      ids: ids.map(String), sender: this._charName(0), sentence: c.sentence, refs: c.refs, age: c.age,
      surface: `${surface(0)}\x01${surface(1)}`, marker: c.marker,
    };
  }

  /**
   * The pending COMMUNICATE goes with the script this ghost queues next (PlayScriptInternal [disasm 0x63AB02]),
   * whatever produced it; a minimized ghost queues nothing, so it stays (EV §2.7.7, A7).
   * @returns {object|null}
   */
  _takeComm() {
    if (this.minimized) return null;
    const c = this._comm;
    this._comm = null;
    return c;
  }

  /**
   * A script about to play: its %-variables expanded, then GET OnTranslate (EV §4.12) [R0 the expanded script, R1
   * omitted, R2 source ID, R3 source refs joined by \x01]; a reply that changed it is expanded once more [disasm
   * SPGhost::Loop 0x63B747, 0x63B7AF–0x63B822] (properties.md §2.1).
   */
  async _translate(script, srcId, srcRefs = [], senderType) {
    const s = await this.expand(script);
    const refs = [s, undefined, srcId, srcRefs.map(r => (r == null ? '' : String(r))).join('\x01')];
    const res = await this._request('OnTranslate', refs, { headers: senderType ? { SenderType: senderType } : {}, kind: 'translate' });
    const v = valueOf(res);
    return v && v !== s ? this.expand(v) : s;
  }

  /**
   * The %-variables of a script (properties.md §2, sakura/expand.js), as ssp.exe's TranslateParam: `%property[…]`
   * through the property system, `%username` from the ghost (_username), the word variables through word(), the others
   * from envVar. A string, or a Promise when a value had to be asked of an engine (%username, a word, an `.ext.`
   * property).
   * @param {string} script
   * @returns {string|Promise<string>}
   */
  expand(script) {
    return expandScript(script, (name, arg) => {
      if (name === 'property') return this._property(arg, '%');
      if (name === 'username') return this._username();
      if (WORD_NAMES.has(name)) return this.word('\\' + name);
      return this.envVar(name);
    });
  }

  /**
   * A word variable's value (properties.md §2.4), as ssp.exe's SPGhost::GetWord [disasm 0x63FA00]: the ghost's word for
   * the type (`\ms`, `\m?`, `\dms` …: _askWord), `\m?` asked once more as `\m` when it had none [disasm 0x63FA3C], else
   * one of SSP's list (core/words.js: the site's copy, `\m?` from any section) [disasm 0x63FA62–0x63FB76]. No cache:
   * every variable asks again, as in ssp.exe. null: no word anywhere, and the variable stays as written.
   * @param {string} type
   * @returns {Promise<string|null>}
   */
  async word(type) {
    const t = String(type);
    let w = await this._askWord(t);
    if (w === null && t.toLowerCase() === '\\m?') w = await this._askWord('\\m');
    if (w !== null) return w;
    let list = null;
    try {
      list = this.wordList ? await this.wordList() : null;
    } catch (e) {
      log.once('words', 'the word list could not be loaded', e);
    }
    return pickWord(list, t, this.random);
  }

  /**
   * SPShiori::GetWord [disasm 0x70CBB0]: GET with ID = the type, built as for an event of SPShioriEvent::Clear's
   * defaults (SenderType internal, SecurityLevel local, no References) [disasm 0x70CD76–0x70CDBE, 0x419B50]; a SHIORI/2.x
   * engine gets `GET Word` through the worker's bridge (kind 'word', shiori2.js). Never a COMMUNICATE: its reply only
   * goes through ParseGenericHeaders [disasm 0x70CF93].
   * @returns {Promise<string|null>}
   */
  async _askWord(type) {
    return wordOf(await this._request(type, [], { comm: false, kind: 'word' }));
  }

  /**
   * %username [disasm SPGhost::GetUserNameW 0x643A10]: GET username to the ghost at each expansion, no cache; 204 or
   * empty: the visitor's nickname from the Preferences box (else the name), else the word `user` [decision,
   * properties.md §8]. The expander doubles its backslashes.
   */
  async _username() {
    return (await this.resource('username')) || this._userFallback();
  }

  /** %username's value when the ghost has none: the stored nickname, else the name (UserProfile.nickname()), else `user`. */
  _userFallback() {
    let n = null;
    try { n = this.user && typeof this.user.nickname === 'function' ? this.user.nickname() : null; } catch (e) { n = null; }
    return typeof n === 'string' && n !== '' ? n : 'user';
  }

  _mayPlay(origin, sentGen) {
    if (this.closed || this.frozen || !this.player) return false;
    switch (origin) {
      case 'tick':
      case 'restore':
        return sentGen === this.gen && !this._talking() && !this._choosing() && !this._choicePending() &&
          !this.minimized && !this.closing;
      case 'timeout':
      case 'dressup':
      case 'async':
        return sentGen === this.gen;
      case 'other':
        // another ghost's event (notifyEvent): cuts whatever plays, but a minimized ghost queues no script
        // [disasm PlayScriptInternal 0x63A720]
        return !this.minimized;
      default:
        return true;
    }
  }

  /**
   * During a shell swap no reply plays (EV §2.6; SSP swaps synchronously, so nothing can talk in between): one to a
   * tick, timeout, surface restore, dress-up GET or async raise is dropped, as when anything else starts; any other
   * (keys, boxes, timers, a choice ...) is held and joins the reply queue behind OnShellChanged's when the swap ends (a
   * \![raise] reply only while no run started after the raising one: _staleRaise).
   * @returns {boolean} true when the swap took the reply
   */
  _swapHold(origin, item) {
    const s = this._swap;
    if (!s) return false;
    if (!SWAP_DROPS.has(origin)) s.held.push(item);
    return true;
  }

  /**
   * Send an event; play a returned script (after OnTranslate) when arbitration allows it. `pick` takes the script out
   * of the response (default: a 2xx Value); `onResponse(res)` runs before anything plays; `onPlay(run)` right after
   * its run started (before anything else can end it). `swap`: the shell swap's own event (OnShellChanged), which
   * plays while the swap holds the others (_swapHold). A held reply counts as played (no fallback event follows it).
   * `headers`: more request headers (OnCommunicate's Age, Surface, Marker; a raised event's Sender). A reply that will
   * play takes the pending COMMUNICATE before OnTranslate, as SSP queues it first (EV §2.7.7); one that will not leaves
   * it for the next script.
   * @returns {Promise<{res:ShioriResponse, value:string|null, played:boolean, run?:Run|null}>} run: the run it started
   */
  async _fire(id, refs = [], {
    method = 'GET', origin = 'user', senderType, baseId, headers = {}, translate = true, play = true, meta = {},
    pick = valueOf, onResponse = null, swap = false, onPlay = null, kind = '', self = '',
  } = {}) {
    const h = { ...headers };
    if (senderType) h.SenderType = senderType;
    if (baseId) h.BaseID = baseId;
    const sentGen = this.gen;
    const res = await this._request(id, refs, { method, headers: h, kind, self });
    if (onResponse) onResponse(res);
    const value = method === 'NOTIFY' ? null : pick(res);
    if (!value || !play || !this._mayPlay(origin, sentGen)) return { res, value, played: false };
    const communicate = this._takeComm();
    const held = s => !swap && this._swapHold(origin, {
      id, refs, value, origin, senderType, script: s, communicate, ...(translate ? {} : { translate: false }),
    });
    if (held(null)) return { res, value, played: !SWAP_DROPS.has(origin) };
    return this._inOrder(async () => {
      const script = translate ? await this._translate(value, id, refs, senderType) : await this.expand(value);
      if (!this._mayPlay(origin, sentGen)) return { res, value, played: false };
      if (held(script)) return { res, value, played: !SWAP_DROPS.has(origin) };
      const run = this._play(script, { event: id, refs, origin, communicate, ...meta });
      if (run && onPlay) onPlay(run);
      return { res, value, played: true, run };
    });
  }

  /**
   * The stage after a reply (expand, OnTranslate, play: _fire, _raiseWait) runs in the order the replies arrived, which
   * is the order their events were sent (one engine request at a time). ssp.exe's Loop takes its queued scripts oldest
   * first [infer: SPGhost::Loop]; here a reply whose expansion asks the engine (%username, an `.ext.` property) puts
   * that request behind events sent meanwhile, and without this a newer reply would play first and the older one
   * replace it. `fn` runs at once when no stage is under way. Nothing in a stage waits for a run or a later reply, so
   * the chain cannot block itself.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  _inOrder(fn) {
    const p = this._order ? this._order.then(fn) : fn();
    const tail = p.then(() => {}, () => {});
    this._order = tail;
    tail.then(() => { if (this._order === tail) this._order = null; });
    return p;
  }

  /** Public: send an event (user-initiated unless told otherwise) and play its reply. Contract: CON events.js. */
  async send(id, refs = [], { method = 'GET', play = true, origin = 'user' } = {}) {
    if (method === 'NOTIFY' || !play) return this._request(id, refs, { method });
    return (await this._fire(id, refs, { origin })).res;
  }

  /**
   * A GetStringShiori request (SPShiori::GetStringShiori 0x712ba0, EV §5.5): GET `id` [refs] with an SPShioriEvent's
   * defaults, SenderType internal and SecurityLevel local [disasm SPShioriEvent::Clear 0x419B50, MakeShiori30Request
   * 0x70A2F0]; a SHIORI/2.x engine gets `GET String SHIORI/2.5` with ID and every Reference (kind 'resource',
   * shiori2.js) [disasm 0x712C4B–0x712F1F]. Never a COMMUNICATE: it calls the module itself (CallRequestAndLog), and
   * SPShiori::Request, which it skips, is SendCommunicate's only caller [disasm 0x71234F]. resourceOf reads the reply.
   */
  _getString(id, refs = []) {
    return this._request(id, refs, { comm: false, kind: 'resource', headers: { SenderType: 'internal' } });
  }

  /**
   * A resource string (menu captions, username ...): GET id as GetStringShiori (_getString, resourceOf), entities
   * decoded, null for none.
   */
  async resource(id) {
    return resourceOf(await this._getString(id));
  }

  /** Several resources at once, waiting at most timeoutMs; late ones fall back to the last value seen. */
  async resources(ids, { timeoutMs = this.opts.menuResourceMs } = {}) {
    const out = new Map();
    const all = Promise.all(ids.map(async id => {
      const v = await this.resource(id);
      this.resourceCache.set(id, v);
      out.set(id, v);
    }));
    await Promise.race([all, delay(this.clock, timeoutMs)]);
    for (const id of ids) if (!out.has(id)) out.set(id, this.resourceCache.has(id) ? this.resourceCache.get(id) : null);
    return out;
  }

  // ---------------------------------------------------------------- runs

  /**
   * Start a script (replacing the current run), its %-variables expanded first (properties.md §2.1); it takes the
   * pending COMMUNICATE (EV §2.7.7). The Run, or a Promise of it when the expansion had to ask an engine (%username).
   */
  playScript(script, { event = '', refs = [], origin = 'user' } = {}) {
    return andThen(this.expand(String(script)), s => this._play(s, { event, refs, origin }));
  }

  /**
   * `communicate`: the COMMUNICATE record the run passes on at its end (EV §2.7.7); undefined = take the pending one
   * now (a script queued without a response of its own: playScript, a choice's script:), null = none.
   */
  _play(script, { event = '', refs = [], origin = '', fromSurfaceRestore = false, replay = null, communicate } = {}) {
    if (!this.player || this.closed) return null;
    // binds of the run being replaced still produce their dress-up events, as notifications
    if (this.pendingDressup.length) this._flushDressup(false);
    const gen = ++this.gen;
    if (!replay) this._resumeRemaining = undefined;
    this._cancelPost();
    this.choicesLive = false;
    // the per-script balloon and choice timeouts, except for a script whose first two characters are \C: it keeps the
    // last one's (SSP's play flag 0x20; not the lenient append of SUM §2.2) [disasm PlayScriptInternal 0x63c883,
    // DecodeProcReal 0x628f3b / 0x628fdc] (EV §3.4)
    if (!(typeof script === 'string' && script.startsWith('\\C'))) this.scriptOpts = {};
    const run = {
      gen, script, event, refs: refs.map(r => (r == null ? '' : String(r))), origin, fromSurfaceRestore, finished: null,
      endShown: !!(replay && replay.state === 'finished'),   // its \e was reached before the page navigated
      communicate: communicate === undefined ? this._takeComm() : communicate || null,
      ghostChange: false,         // it asked \![change,ghost]: SSP breaks it [disasm 0x62AF92]
      // OnOtherGhostTalk (EV §2.7.4): every run is told to the listening ghosts, before it plays and after it ends, but
      // a replay after a page change [decision]; a reply to OnOtherGhostTalk itself is not told before it plays (SSP's
      // loop guard covers only that broadcast [disasm 0x6397A2, 0x63992F])
      talk: !replay && origin !== 'replay',
    };
    this.current = run;
    // R2 `communicate`: this run carries a talk to pass on (both broadcasts) [disasm Loop 0x63949C]
    if (run.talk && event !== 'OnOtherGhostTalk') {
      this.emit('talk', { phase: 'before', run, flags: run.communicate ? 'communicate' : '' });
    }
    let p;
    try {
      p = replay ? this.player.replay(replay) : this.player.play(script, { event, refs: run.refs });
    } catch (e) {
      log.error('script player failed', e);
      p = { reason: 'end', hasChoices: false, failed: true };
    }
    run.finished = Promise.resolve(p).then(r => r || { reason: 'end' }, e => {
      log.error('script player failed', e);
      return { reason: 'end', hasChoices: false, failed: true };
    });
    run.finished.then(r => this._onRunEnd(run, r));
    if (this.state) this.state.change();
    this.emit('play', run);
    return run;
  }

  async _onRunEnd(run, res) {
    // OnOtherGhostTalk "after" (EV §2.7.4): `break` when the run did not reach its end (\- did) [doc; guess for a run
    // another one replaced] or asked \![change,ghost] [disasm 0x62AF92]; `communicate` when it carries a talk to pass
    // on; not for runs a teardown stopped
    const broken = !(res.reason === 'end' || res.reason === 'quit') || run.ghostChange;
    if (run.talk && !this.frozen) {
      const flags = [run.communicate && 'communicate', broken && 'break'].filter(Boolean).join(',');
      this.emit('talk', { phase: 'after', run, flags });
    }
    // COMMUNICATE (EV §2.7.7): passed on after that broadcast, only when the run reached its end (choices on screen
    // too) and the ghost still runs: not after a break, a newer script, \-, \![change,ghost] [disasm Loop 0x63993B,
    // 0x63995D]; before a Quit's goodbye closes the ghost (below). Taken off the run, so it goes at most once.
    const c = run.communicate;
    run.communicate = null;
    if (c && res.reason === 'end' && !res.failed && !run.ghostChange && !this.closed && !this.frozen) {
      this.emit('communicate', { communicate: c, run });
    }
    if (res.reason === 'quit') {
      // \- while changing ghosts (Satori ends a fallback OnClose with it) ends the farewell, not the ghost (EV §2.5)
      if (!this.changing) await this._quit({ fromPlayer: true });
      return;
    }
    this._stampRestore(run, res);
    // \e reached: 'yen-e' animations, exactly once per finished run and at once (a dress-up reply or a newer run
    // does not cancel it). The player never calls stage.scriptEnd() itself; interrupted runs never reached \e.
    if (res.reason === 'end' && !res.failed && !run.endShown && !this.closed) this._scriptEnd();
    if (run.gen !== this.gen) return;            // replaced: the newer run owns balloons and timers
    if (this.frozen) return;                     // destroyed, suspended or unloaded meanwhile: no timers any more
    // the close script (or a run that replaced it) is over, finished or broken; a choice picked on it waits for its
    // reply (_onLink)
    if (this._closeDue() && !this._choicePending()) {
      if (this.closing === 'all') { await this._quit({ fromPlayer: true }); return; }
      this.closing = false;
    }
    if (res.reason !== 'end') {                  // interrupted without a successor (choice, break)
      // a queued reply plays now, unless a choice was picked (its reply comes first; the queue waits for its end)
      if (this._replyQueue.length && !this.closed && !this._choicePending() && (await this._playQueued())) return;
      if (run.gen !== this.gen) return;
      if (this.pendingDressup.length) this._flushDressup(false);
      return;
    }
    this.choicesLive = !!res.hasChoices;
    if (this.state) this.state.change();
    // a reply queued while this script played (OnShellChanged after its \![change,shell]) comes before the dress-up GET
    if (this._replyQueue.length && !this.closed && (await this._playQueued())) return;
    if (run.gen !== this.gen || this.closed) return;
    const played = await this._flushDressup(true);
    if (played || run.gen !== this.gen || this.closed) return;
    if (this.minimized) { this._hideBalloons(); return; }
    this._armPost(run, res);
  }

  /**
   * A GET reply that must not cut the running script (OnShellChanged / OnBalloonChange after a script's
   * \![change,shell|balloon] [guess], EV §2.6): it plays when the newest run ends, at once when nothing plays; a close,
   * a ghost change, a takeover or a page change drops it. Several play one after another, oldest first.
   */
  _deferReply(q) {
    if (this.closed || this.frozen) return;
    // queued now: it takes the pending COMMUNICATE (its own response's) now (EV §2.7.7)
    const communicate = this._takeComm();
    this._replyQueue.push({ id: q.id, refs: q.refs, value: q.value, origin: q.origin || 'user', script: null, communicate });
    if (!this._talking() && !this._choicePending()) this._playQueued();
  }

  /**
   * Translate and play the oldest queued reply; false (and kept queued) when another run took over meanwhile, or
   * during a shell swap (the swap's end plays it). A \![raise] reply a swap held is dropped once a run started after
   * the raising one (_staleRaise), as raise() drops it outside a swap.
   */
  async _playQueued() {
    if (this._swap) return false;
    let q;
    do q = this._replyQueue.shift(); while (q && this._staleRaise(q));
    if (!q) return false;
    if (q.script == null) {
      q.script = q.translate === false ? await this.expand(q.value)
        : await this._translate(q.value, q.id, q.refs, q.senderType);
    }
    if (this.closed || this.frozen || !this.player) return false;
    if (this._staleRaise(q)) return this._playQueued();
    if (this._talking() || this._choicePending() || this._swap) { this._replyQueue.unshift(q); return false; }
    this._play(q.script, { event: q.id, refs: q.refs, origin: q.origin, communicate: q.communicate || null });
    return true;
  }

  /** A held \![raise] reply whose raising run is no longer the newest (raise(): "replaced meanwhile: drop"). */
  _staleRaise(q) { return q.origin === 'raise' && Number.isInteger(q.gen) && q.gen !== this.gen; }

  _scriptEnd() {
    try {
      if (this.stage && typeof this.stage.scriptEnd === 'function') this.stage.scriptEnd();
    } catch (e) {
      log.once('script-end', 'stage.scriptEnd() failed', e);
    }
  }

  // ---------------------------------------------------------------- post-script timers (EV §3.4, SUMMARY §2.4)

  /** The balloon or choice timeout of a run that reached its end (OnSurfaceRestore has its own stamp: _stampRestore). */
  _armPost(run, res) {
    const remaining = this._resumeRemaining;
    this._resumeRemaining = undefined;
    if (this.ghostLife.passive) return;
    if (res.hasChoices) {
      // a menu waits for its answer: only the choice timeout applies, never the balloon one (SS §6.4, UI §4.3),
      // and `\*` or a choice timeout of 0 keeps it up until the user acts
      const ms = res.noChoiceTimeout ? 0 : remaining ?? this.scriptOpts.choiceTimeoutMs ?? this.opts.choiceTimeoutMs;
      if (ms > 0) this._startPost('choice', ms, run);
      return;
    }
    const ms = remaining ?? this.scriptOpts.balloonTimeoutMs ?? this.opts.balloonTimeoutMs;
    if (ms > 0) this._startPost('balloon', ms, run);
  }

  /**
   * What stops the balloon / choice timeout's countdown. ssp.exe never pauses it: one SetTimer on \0's balloon
   * [disasm StartWaiting 0x5d1b35], dropped when the pointer is over that balloon at expiry and the timeout is the
   * default (Balloon.NoTimeoutMouseOver, on) [disasm DoWaiting 0x5d1b92-0x5d1baa]; Sumika pauses while the pointer
   * is over a balloon, and while the tab is hidden [decision]. An open box does not: no timeout code reads one
   * [disasm OnTimer 0x4720d9, DoWaiting; CreateInputBox makes a modeless window] (EV §3.4).
   */
  _postPaused() {
    if (this._hidden()) return true;
    try { return !!(this.balloons && this.balloons.hovered); } catch (e) { return false; }
  }

  _startPost(kind, ms, run) {
    this._cancelPost();
    const post = { kind, run, remaining: ms, last: this.clock.now(), handle: null };
    const step = () => {
      if (this.post !== post) return;
      const now = this.clock.now();
      if (!this._postPaused()) post.remaining -= now - post.last;
      post.last = now;
      if (post.remaining <= 0) {
        this.post = null;
        this._postFired(post);
        return;
      }
      post.handle = this.clock.setTimeout(step, Math.min(250, post.remaining));
    };
    this.post = post;
    post.handle = this.clock.setTimeout(step, Math.min(250, ms));
  }

  _cancelPost() {
    if (this.post) this.clock.clearTimeout(this.post.handle);
    this.post = null;
  }

  async _postFired(post) {
    const run = post.run;
    if (run.gen !== this.gen || this.closed) return;
    if (post.kind === 'choice') {
      // a selected item is let go first: NOTIFY OnChoiceEnter (SPBalloonWnd::DoWaiting [disasm 0x5cff45], EV §4.7)
      try { if (this.balloons && typeof this.balloons.endSelections === 'function') this.balloons.endSelections('timeout'); } catch (e) { /* ignore */ }
      this.choicesLive = false;
      this._hideBalloons();
      if (this.state) this.state.change();
      await this._fire('OnChoiceTimeout', [run.script], { origin: 'timeout' });
    } else if (post.kind === 'balloon') {
      // OnSurfaceRestore does not follow from here: it counts from the run's end on its own (_stampRestore)
      this._hideBalloons();
      await this._fire('OnBalloonTimeout', [run.script, '0'], { origin: 'timeout' });
    }
  }

  // ---------------------------------------------------------------- OnSurfaceRestore (EV §3.4)

  /**
   * A run stopped: stamp the time, so OnSurfaceRestore is pending from now [disasm SPGhost::DecodeProc 0x628d92–
   * 0x628dc6]. Every run that reaches its end counts (SSP's end-of-script YenE sets the "showed something" flag), a
   * broken or replaced one only when it had shown something (PlayResult.shown); OnSurfaceRestore's own reply never
   * (play flag 0x8000). A replayed run that had already ended before the page changed keeps the stamp saved with it.
   */
  _stampRestore(run, res) {
    if (this.closed || this.frozen || run.fromSurfaceRestore || run.endShown) return;
    if (!((res.reason === 'end' && !res.failed) || res.shown)) return;
    this._restoreAt = this.clock.now();
    if (this.state) this.state.change();
  }

  /**
   * What holds a pending OnSurfaceRestore back. It waits and is never dropped: SSP looks again every second [disasm
   * CSakuraWnd::TimerExec 0x497e37–0x497e8a, 0x498165, 0x49825b, 0x4982d9–0x498300; SPGhost::OnSurfaceRestore
   * 0x6426e2]: a running script (a `\x` wait too), `\t`, a choice menu (or a picked choice whose reply is on its way),
   * a shell swap, a ghost change or close, minimized (or minimizing), passive or induction mode, and the last script's
   * \![set,balloontimeout,0] (never; a script that starts with \C keeps it: _play). An open box or a hidden tab does not
   * hold it [infer: SSP checks neither].
   */
  _restoreHeld() {
    return !this.booted || this.closed || this.frozen || !this.player || this._talking() || this._timeCritical() ||
      this._choosing() || this._choicePending() || !!this._swap || this.changing || !!this.closing ||
      !!this.minimized || this.minimizing || this.ghostLife.passive || this.ghostLife.induction ||
      this.scriptOpts.balloonTimeoutMs === 0;
  }

  /**
   * The 1-second tick's check, after its time events [disasm TimerExec 0x498244–0x498310]: GET OnSurfaceRestore [R0 the
   * `\0` surface, R1 the `\1` surface; -1 when not shown] once more than balloonTimeoutMs + surfaceRestoreMs (SSP's
   * Timeout.Balloon + 15 s: 30 s) have passed since the stamp, at a tick whose local second is 10–50, while nothing
   * holds it. The stamp is consumed before the request [disasm 0x642715], so a 204 changes nothing and is not retried;
   * the reply plays as fromSurfaceRestore (it never stamps again).
   * @param {number} tickNow the tick's time (its local second decides)
   */
  async _surfaceRestore(tickNow) {
    const at = this._restoreAt;
    if (!at || this._restoreHeld()) return;
    if (!(this.clock.now() - at > this.opts.balloonTimeoutMs + this.opts.surfaceRestoreMs)) return;
    const sec = new Date(tickNow).getSeconds();
    if (sec < 10 || sec > 50) return;
    this._restoreAt = 0;
    if (this.state) this.state.change();
    await this._fire('OnSurfaceRestore', [this._shownSurfaceOf(0), this._shownSurfaceOf(1)],
      { origin: 'restore', meta: { fromSurfaceRestore: true } });
  }

  /**
   * A scope's surface id as OnSurfaceRestore sends it: -1 when the scope has no window, or its window is not shown
   * (`\s[-1]`, hidden) [disasm SPGhost::GetCurrentSurfaceIndexIntChar 0x6eb770]. Makes no character view.
   */
  _shownSurfaceOf(scope) {
    try {
      const st = this.stage;
      if (!st || (typeof st.has === 'function' && !st.has(scope))) return -1;
      const c = st.char(scope);
      if (!c || !Number.isFinite(c.surfaceId) || c.surfaceId < 0 || c.visible === false) return -1;
      return c.surfaceId;
    } catch (e) {
      return -1;
    }
  }

  // ---------------------------------------------------------------- boot / resume (EV §2.1, §2.2, SUMMARY §2.5)

  /**
   * Emits 'notified' right after the NOTIFY batch (cold and resume), before any boot GET: the ghost counts as up for
   * the others from then (EV §2.7.5).
   * @param {{resume?: boolean, firstBoot?: boolean, changed?: object|null, called?: object|null}} o resume: this tab
   *   already booted the ghost (no OnBoot); firstBoot: no save data for this ghost in this browser (OnFirstBoot instead
   *   of OnBoot; it wins over changed and called [disasm]); changed: a ghost change brought it ({sakuraName, name, path,
   *   script} of the previous ghost: OnGhostChanged, EV §2.5); called: another ghost called it ({sakuraName, name, path,
   *   script} of the caller: OnGhostCalled, EV §2.7); silent: a cold boot without a boot event (\![reload,ghost]:
   *   AddGhost's flag 2 skips TalkBootMessage, no OnBoot, OnFirstBoot or OnGhostChanged [disasm 0x466d08], EV §2.10)
   * @returns {Promise<{run: Run|null}>} the run the boot event started (OnBoot's too); null when nothing played and on a
   *   resume (the after-boot events wait for its end, EV §2.7)
   */
  async boot({ resume = false, firstBoot = false, changed = null, called = null, silent = false } = {}) {
    const st = this.state ? this.state.data : null;
    this.closed = false;
    this.frozen = false;
    if (resume && st) {
      this.minimized = st.minimized ? { ...st.minimized } : null;
      // a page change is no restart: the script's tray icon stays for the next minimize [decision: SSP has no pages]
      this.trayIcon = typeof st.trayIcon === 'string' && st.trayIcon ? st.trayIcon : null;
      this.ghostLife = { ...this.ghostLife, ...(st.ghostLife || {}) };
      // a state an older runtime saved can hold both: one slot in ssp.exe (_setLifeMode), induction as Status shows it
      if (this.ghostLife.passive && this.ghostLife.induction) this.ghostLife.passive = false;
      this.lastMinute = (st.clock && st.clock.lastMinute) || minuteKey(this.clock.now());
      this._restoreAt = Number.isFinite(st.surfaceRestoreAt) && st.surfaceRestoreAt > 0 ? st.surfaceRestoreAt : 0;
    } else {
      this.minimized = null;
      this.trayIcon = null;
      this.lastMinute = minuteKey(this.clock.now());
      this.timers.clear();
      // nothing pending until the boot script ends, as SSP's new ghost [disasm SPGhost ctor 0x61cb1a] (EV §3.4)
      this._restoreAt = 0;
      // a cold boot is SSP starting again: the music of the last session stopped with it
      if (st) {
        st.run = null; st.timers = []; st.boxes = []; st.minimized = null; st.closed = false; st.music = null;
        st.surfaceRestoreAt = 0; st.trayIcon = null;
      }
      this._restored = true;      // nothing to restore: the live state is the state from here on
    }
    if (this.minimized) this._hideAll();

    const version = await this.resource('version');
    if (version) log.info(`SHIORI: ${version}`);
    await this._notifyBatch();
    if (!this.frozen) this.emit('notified', { resume });
    // the menu's look from the SHIORI (UI §2.3): SPGhost::LoadGhostCore asks it after LoadShiori's NOTIFYs, before
    // OnBoot [disasm 2.9.10 0x6215c4, 0x62161e]; a resumed page's menu is new, so it asks as at a load [decision]
    if (!this.frozen && this.menu && typeof this.menu.loadShioriLook === 'function') {
      try { await this.menu.loadShioriLook(); } catch (e) { log.once('menu-odm', 'the menu look request failed', e); }
    }
    // torn down while the NOTIFY batch or the menu's requests ran (a page left during the boot): no boot event, no
    // surfaces, no drops
    if (this.frozen) return { run: null };
    // no GET username here: ssp.exe asks for none at boot, %username asks at each expansion [disasm LoadGhost 0x620619]
    this._sendAllSurfaces();
    this.surfaceLive = true;
    this.booted = true;
    this._acceptDrops(true);

    let bootRun = null;
    if (!resume && !silent) {
      // the shell's descript name, never its folder (EV §2.1 #25) [doc; disasm]
      const shell = this._shellInfo().name;
      const bootRefs = [shell, undefined, undefined, undefined, undefined, undefined, '', ''];
      const u = undefined;
      let r = { played: false };
      if (firstBoot) {
        // a ghost met for the first time introduces itself, a ghost change or a call included (EV §2.5 ASSUMPTION;
        // for calls [disasm TalkBootMessageReal]). SSP sends 8 references: R0 the vanish count, R7 the shell name
        // [disasm]; R1–R6 omitted [infer]
        r = await this._fire('OnFirstBoot', [String((st && st.vanished) || 0), u, u, u, u, u, u, shell],
          { origin: 'system', baseId: 'OnBoot' });
      } else if (called) {
        // R0 caller's sakura name, R1 its script at the call, R2 its name, R3 its path, R7 our shell; 204 -> OnBoot,
        // OnGhostChanged is not tried (EV §2.7) [doc; disasm]
        const c = called;
        r = await this._fire('OnGhostCalled', [c.sakuraName || '', c.script || '', c.name || '', c.path || '', u, u, u, shell],
          { origin: 'system', baseId: 'OnGhostChanged,OnBoot' });
      } else if (changed) {
        // R0 previous sakura name, R1 its script at the change, R2 its name, R3 its path, R7 our shell [U-ev]
        const c = changed;
        r = await this._fire('OnGhostChanged', [c.sakuraName || '', c.script || '', c.name || '', c.path || '', u, u, u, shell],
          { origin: 'system', baseId: 'OnBoot' });
      }
      if (!r.played) r = await this._fire('OnBoot', bootRefs, { origin: 'system' });
      bootRun = (r.played && r.run) || null;
    } else if (resume && st) {
      if (st.run && typeof st.run.src === 'string') this._replay(st.run);
      for (const b of st.boxes || []) this._reopenBox(b);
      this._restoreTimers(st.timers || []);
      this._resumeMusic(st.music);
    }
    this._restored = true;
    this.start();
    if (this.state) this.state.change();
    this.emit('booted', { resume });
    return { run: bootRun };
  }

  /**
   * The UI language changed (Language ▸, another tab, the browser's settings; UI §2.10): GET OnLanguageChange [R0 name,
   * R1 language id, R2 '', R3 ''], whose reply may talk ("言語設定が変更された際" [UKADOC:ev]). Nothing when only the
   * choice changed (Use System Lang. picked while the system's language is the one in effect) [guess], before boot,
   * after close and while frozen.
   */
  _onLanguage({ lang, prev }) {
    if (!lang || lang === prev || !this.booted || this.closed || this.frozen) return;
    this._fire('OnLanguageChange', languageRefs(lang), { origin: 'user' })
      .catch(e => log.once('language-event', 'OnLanguageChange failed', e));
  }

  /** After an engine crash: the engine was reloaded from its save data; tell it about the world again. */
  async afterEngineRestart() {
    this._comm = null;            // a new engine: the old one's pending COMMUNICATE went with it (EV §2.7.7)
    await this.resource('version');
    await this._notifyBatch();
    this._sendAllSurfaces();
  }

  /**
   * \![reload,shiori] (EV §2.10), at the tag [disasm ReloadShioriFromTag 0x61e140]: NOTIFY OnDestroy [R0 `reload`]
   * (UnloadShiori(true) 0x6221c9–0x622219), the engine unloads and loads again from its stored files (shioriReloader,
   * the runtime's: ShioriClient.reload), then the load's batch: GET version, the NOTIFY batch with OnInitialize [R0
   * `reload`] (LoadShiori(reload) → NotifyInitialEvents(false, true) 0x621b00) and OnSurfaceChange per character shown
   * (0x621ff3–0x62213a). No boot event and no event of its own (ssp.exe has none); the script goes on after it. All of
   * it is queued now, in this order, in the client's FIFO, so a request asked meanwhile (a tick, a click) waits for the
   * new engine: _request must reach this.shiori.request before its first await.
   * @returns {Promise<boolean>|false} false when refused: not booted, closed, a ghost change, frozen, no reloader
   */
  reloadShiori() {
    if (!this.booted || this.closed || this.changing || this.frozen || !this.shiori) return false;
    if (typeof this.shioriReloader !== 'function') { log.once('reload-shiori', 'SHIORI reloads are not available'); return false; }
    this._comm = null;            // the engine unloads: SSP's Unload clears the slot (EV §2.7.7)
    const destroyed = this._request('OnDestroy', ['reload'], { method: 'NOTIFY', comm: false });
    let loaded;
    try {
      loaded = Promise.resolve(this.shioriReloader());
    } catch (e) {
      loaded = Promise.reject(e);
    }
    const version = this.resource('version');
    const batch = this._notifyBatch({ initialize: 'reload' });
    this._sendAllSurfaces();
    return Promise.all([destroyed, loaded, version, batch])
      .then(([, ok]) => !!ok, e => { log.error('the SHIORI reload failed', e); return false; });
  }

  /**
   * \![reload,ghost] (EV §2.10) [disasm ReloadGhost 0x6209e0]: the lazy binds go out, then the ghost posts a change to
   * itself (mode 6): no OnGhostChanging or OnClose (OnChangeMessage is bypassed), OnDestroy [''] and the unload, a cold
   * load without its boot talk (boot({silent})). Emits 'change' {kind:'ghost', target: its own id, byId, reload: true,
   * …}; the script goes on until the ghost unloads (leave() interrupts it). False when this loop cannot now.
   */
  reloadGhost() {
    if (!this.booted || this.closed || this.changing || this.frozen) return false;
    if (this.pendingDressup.length) this._flushDressup(false);    // ProcessLazyCommandExec [disasm 0x6209e3]
    this.emit('change', {
      kind: 'ghost', target: String(this.ghost.id || ''), byId: true, reload: true, reason: 'automatic', raiseEvent: false,
      scope: 0, fromScript: true,
    });
    return true;
  }

  /** Resume only (TS §3.4): load the track that was playing, seek and play (autoplay: afterGesture retry). */
  _resumeMusic(m) {
    if (!m || !this.audio || typeof this.audio.resumeMusic !== 'function') return;
    try { this.audio.resumeMusic(m); } catch (e) { log.once('music-resume', 'could not resume the music', e); }
  }

  _replay(run) {
    if (!this.player || typeof this.player.replay !== 'function') return;
    this._resumeRemaining = Number.isFinite(run.timeoutRemainingMs) ? run.timeoutRemainingMs : undefined;
    // its COMMUNICATE, saved with it (_collect), goes at the replay's end; never the pending slot's (EV §2.7.7)
    this._play(run.src, {
      event: run.origin || '', refs: Array.isArray(run.refs) ? run.refs : [], origin: 'replay',
      fromSurfaceRestore: !!run.fromSurfaceRestore, replay: run, communicate: commRecord(run.communicate),
    });
  }

  /** The ghost's descript name (ownerghostname, OnNotifySelfInfo R0, OnShellChanged R1). */
  _ghostName() {
    const g = this.ghost;
    return this.descript.get('name') || g.name || g.id || '';
  }

  /** {id, name} of the shell in use: the constructor's / attachStage's, else the state's, named from ghost.shells. */
  _shellInfo() {
    const g = this.ghost;
    const s = this.shell;
    const id = (s && s.id) || (this.state && this.state.data && this.state.data.shell) || g.defaultShell || 'master';
    let name = s && s.id === id ? s.name : '';
    if (!name) {
      const e = Array.isArray(g.shells) ? g.shells.find(x => x && x.id === id) : null;
      name = (e && e.name) || id;
    }
    return { id: String(id), name: String(name) };
  }

  /** installedshellname: every shell of the ghost in the index's (menu) order, hidden ones included (EV §2.6). */
  _shellNames() {
    const list = Array.isArray(this.ghost.shells) && this.ghost.shells.length ? this.ghost.shells : [{ name: this._shellInfo().name }];
    return list.map(s => (s && (s.name || s.id)) || '');
  }

  _shellDescript() {
    try {
      const sh = this.stage && this.stage.shell;
      const d = sh && sh.descript;
      return d && typeof d.get === 'function' ? d : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The name in effect of scope 0 (sakura) or 1 (kero): the shell descript's `sakura.name` / `sakuraname` (`kero.name` /
   * `keroname`), any value (`none` too), replaces the ghost's while that shell is current (EV §2.6) [disasm
   * SetCurrentShellIndex 0x641DE0, SPSeriko::GetCharName 0x6F11B0]. The ghost descript's `name.allowoverride` does not
   * stop it: in ssp.exe 2.9.9 that key gates only the shell's `sakura.name2` and `sakura.friend.name` [disasm
   * SPSeriko::LoadDescript 0x6E5A79–0x6E5C35]. Feeds otherghostname, the FMO, a COMMUNICATE's sender,
   * OnNotifySelfInfo R1/R2 and %selfname / %keroname.
   */
  _charName(scope) {
    const g = this.ghost;
    const d = this.descript;
    const which = scope === 0 ? 'sakura' : 'kero';
    const own = scope === 0 ? d.get('sakura.name') || g.sakuraName || '' : d.get('kero.name') || g.keroName || '';
    const sd = this._shellDescript();
    const v = sd && (sd.get(`${which}.name`) || sd.get(`${which}name`));
    return v ? String(v) : own;
  }

  /** OnNotifySelfInfo [ghost name, sakura name, kero name, shell name, shell path, balloon name, balloon path]. */
  _selfInfoRefs() {
    const g = this.ghost;
    // the balloon actually loaded (R5 and R6 describe the same one); '' = the built-in one
    const balloon = this.balloonName || (this.state && this.state.data.balloon) || g.balloon || '';
    return [this._ghostName(), this._charName(0), this._charName(1), this._shellInfo().name, this.paths.shell || '',
      balloon, this.paths.balloon || ''];
  }

  /** @param {{initialize?: string}} [o] initialize: OnInitialize's R0, `reload` at \![reload,shiori] [disasm 0x621b00] */
  async _notifyBatch({ initialize = '' } = {}) {
    // SSP's SendNotifyImpl: never a COMMUNICATE (EV §2.7.7)
    const N = (id, refs = []) => this._request(id, refs, { method: 'NOTIFY', comm: false });
    const g = this.ghost;
    const name = this._ghostName();
    const ghosts = (this.site && this.site.ghosts) || [g];
    const balloonNames = new Set();
    for (const gh of ghosts) for (const b of gh.bundledBalloons || []) balloonNames.add(b.name || b.dir);
    for (const b of (this.site && this.site.balloons) || []) balloonNames.add(b.name || b.id);
    const jobs = [
      N('OnInitialize', [initialize]),
      // the scope-0 name in effect (SPSeriko::GetCharName(0)), not the descript name [disasm 2.9.10 0x70df20]
      N('ownerghostname', [this._charName(0)]),
      N('basewareversion', BASEWARE),
      N('capability', CAPABILITIES),
      // "起動直後に通知される場合は必ずNOTIFY" [UKADOC:ev]; its place in the batch is an ASSUMPTION (EV §2.1 #10a)
      N('OnLanguageChange', languageRefs(this.language ? this.language.lang : 'en')),
      N('OnNotifySelfInfo', this._selfInfoRefs()),
      // right before otherghostname, as at every SHIORI load of ssp.exe [disasm 0x621B66]; only once the visitor has
      // saved the Preferences box (EV §4.16) [decision]
      ...(this._userSet() ? [N('OnNotifyUserInfo', this._userRefs())] : []),
      N('otherghostname', this._otherRefs()),
      N('installedsakuraname', ghosts.map(x => x.sakuraName || '')),
      N('installedkeroname', ghosts.map(x => x.keroName || '')),
      N('installedghostname', ghosts.map(x => x.name || x.id || '')),
      N('installedballoonname', [...balloonNames].filter(Boolean)),
      N('installedshellname', this._shellNames()),
      N('OnNotifyDressupInfo', this._dressupRefs()),
      N('hwnd', [this._scopesSorted().map(s => 1000 + s).join('\x01'), this._scopesSorted().map(s => 2000 + s).join('\x01')]),
    ];
    await Promise.all(jobs);
  }

  // ---------------------------------------------------------------- other ghosts (EV §2.7)

  /**
   * NOTIFY otherghostname's References (EV §2.1 #16): one per other ghost that counts as up,
   * `<sakura name in effect>\x01<scope 0 surface>\x01<scope 1 surface>`; none when alone [doc; disasm NotifyOtherGhost].
   */
  _otherRefs() {
    return this._others().map(otherGhostRef);
  }

  /** peers.others(): the other ghosts that count as up, as peerInfo() objects; none when alone. */
  _others() {
    if (!this.peers || typeof this.peers.others !== 'function') return [];
    try {
      const list = this.peers.others();
      return Array.isArray(list) ? list : [];
    } catch (e) {
      log.once('peers-others', 'the other ghosts could not be listed', e);
      return [];
    }
  }

  /** NOTIFY otherghostname again: another ghost came, went or changed (EV §2.7) [disasm UpdateSakuraFileMapping]. */
  notifyOthers() {
    if (this.closed || this.frozen || !this.shiori) return Promise.resolve(null);
    return this._request('otherghostname', this._otherRefs(), { method: 'NOTIFY', comm: false });
  }

  /**
   * This ghost as the others see it (EV §2.7): its descript name, the sakura and kero names in effect (a shell's
   * override applied, EV §2.6), the surfaces of scopes 0 and 1 (−1 when none [infer]) and its shell's descript name.
   * It never makes a character view (a torn-down stage has none: −1).
   * @returns {{id:string, name:string, sakuraName:string, keroName:string, surfaces:number[], shell:string}}
   */
  peerInfo() {
    const st = this.stage;
    const surface = s => (st && typeof st.has === 'function' && !st.has(s) ? -1 : this._surfaceOf(s));
    return {
      id: String(this.ghost.id || ''), name: this._ghostName(), sakuraName: this._charName(0), keroName: this._charName(1),
      surfaces: [surface(0), surface(1)], shell: this._shellInfo().name,
    };
  }

  // ---------------------------------------------------------------- user information (EV §4.16)

  /** The visitor has saved the Preferences box once (UserProfile.isSet()). */
  _userSet() {
    try { return !!(this.user && typeof this.user.isSet === 'function' && this.user.isSet()); } catch (e) { return false; }
  }

  /** OnNotifyUserInfo [R0 nickname, R1 name, R2 birthday YYYY,MM,DD, R3 sex] (UserProfile.refs()). Never logged. */
  _userRefs() {
    let r = null;
    try { r = this.user && typeof this.user.refs === 'function' ? this.user.refs() : null; } catch (e) { r = null; }
    if (!Array.isArray(r) || r.length < 4) return ['', '', '', 'undef'];
    return r.slice(0, 4).map(x => (x == null ? '' : String(x)));
  }

  /**
   * NOTIFY OnNotifyUserInfo with the visitor's information (EV §4.16): the Site sends it to every ghost up when the
   * Preferences box closes after an edit, as ssp.exe calls NotifyUserInfo for every running ghost [disasm
   * CSetupDefDlg::OnDestroy 0x4a4d30, OnSSPSysMsg 0x46b478] (passive, minimized and \t do not stop it). Never a
   * COMMUNICATE. Nothing before boot, once closed or frozen.
   */
  notifyUserInfo() {
    if (!this.booted || this.closed || this.frozen || !this.shiori) return Promise.resolve(null);
    return this._request('OnNotifyUserInfo', this._userRefs(), { method: 'NOTIFY', comm: false });
  }

  // ---------------------------------------------------------------- the property system (properties.md)

  /**
   * Get one property for this ghost (properties.md §5): a string, null (failed: %property removes the variable,
   * \![get,property] sends ''), or a Promise of either. `how`: '%' (%property) or 'get' (\![get,property]); the sweep
   * counts the names through it.
   */
  _property(name, how = '%') {
    return getProperty(this._world(), name);
  }

  /**
   * PlayerHost: \![get,property,id,names…] (properties.md §3) [disasm 0x62DFA4–0x62E2FD]: every name read now, in order
   * (a failed one is ''), then GET id with the values as References, SenderType `internal,property`; the reply plays as
   * \![raise]'s (a non-empty one replaces the run). Resolves with the reply, null for none.
   * @param {string} id
   * @param {string[]} names
   * @returns {Promise<string|null>}
   */
  async raiseProperty(id, names = []) {
    id = id == null ? '' : String(id);
    if (!id) return null;
    const gen = this.gen;
    const refs = [];
    for (const n of names || []) {
      const v = await this._property(n == null ? '' : String(n), 'get');
      refs.push(v == null ? '' : String(v));
    }
    return this._raiseWait(id, refs, 'internal,property', gen);
  }

  /**
   * PlayerHost: \![set,property,name,value] (properties.md §4, §6): core/properties.js setProperty for this ghost. True
   * when it applied, or a Promise of it (an `.ext.` write asks the SHIORI: the player holds the run at the tag).
   */
  setProperty(name, value) {
    return setProp(this._world(), name, value);
  }

  /**
   * PlayerHost: \![open,con…,PAGE…] (SS §5.9, UI §2.13): the Site's Preferences box (props.openSettings, which applies
   * the page rule, settingsPage, and logs a page without a box). `args` as the tag gave them (untrimmed). Returns
   * whether a box opened; the script goes on either way (a modeless dialog [disasm 0x46CAE0]).
   * @param {string} kind 'configurationdialog'
   * @param {string[]} args
   */
  openWindow(kind, args = []) {
    if (kind !== 'configurationdialog') {
      log.once(`open-window:${kind}`, `\\![open,${kind}] is not supported`);
      return false;
    }
    const page = args && args.length && args[0] != null ? String(args[0]) : '';
    const p = this.props;
    if (!p || typeof p.openSettings !== 'function') {
      log.once('open-config', '\\![open,configurationdialog]: no Preferences box here');
      return false;
    }
    try {
      return !!p.openSettings(page);
    } catch (e) {
      log.once('open-config-failed', 'the Preferences box failed to open', e);
      return false;
    }
  }

  /** The site's path, '/'-ended (paths.site; '/' without one). */
  _siteBase() {
    const b = this.paths && typeof this.paths.site === 'string' && this.paths.site ? this.paths.site : '/';
    return b.endsWith('/') ? b : `${b}/`;
  }

  /** This ghost's folder, site-absolute and '/'-ended (paths.ghost, else built from the site's path). */
  _ghostPath() {
    const p = this.paths && this.paths.ghost;
    return p ? String(p) : `${this._siteBase()}ghost/${encodeURIComponent(String(this.ghost.id || ''))}/`;
  }

  /**
   * This ghost as a property record (core/properties.js GhostRec, properties.md §5.4): the descript level (its
   * `sakura.name` / `kero.name`, not a shell's override), the item names (path, craftman, craftmanurl, homeurl, icon,
   * thumbnail, the last cold boot) and `live`: what only a ghost up here answers. The Site's ghostlist and
   * activeghostlist hold it for a ghost up in this tab.
   */
  propRecord() {
    const g = this.ghost || {};
    const d = this.descript;
    const path = this._ghostPath();
    const boot = this.state && this.state.data ? Number(this.state.data.bootEpochMs) : 0;
    return {
      id: String(g.id || ''), name: this._ghostName(), path,
      craftman: String(g.craftman || d.get('craftmanw') || d.get('craftman') || ''),
      craftmanurl: String(d.get('craftmanurl') || ''), homeurl: String(d.get('homeurl') || ''),
      ...(iconProp(g, this._siteBase())),
      ...(thumbList(g, this._siteBase())),
      times: { lastboot: boot > 0 ? boot : 0 },
      sakuraName: String(d.get('sakura.name') || g.sakuraName || ''),
      keroName: String(d.get('kero.name') || g.keroName || ''),
      live: this._liveRecord(),
    };
  }

  /** core/properties.js LiveGhost: what this ghost answers while it is up here (SPGhost::VarGet 0x6476D0). */
  _liveRecord() {
    if (this._live) return this._live;
    const down = () => this.closed || this.frozen || !this.shiori;
    this._live = {
      // GET username to this ghost; no answer fails (no SSP fallback here [disasm 0x6479D0])
      username: () => (down() ? Promise.resolve(null) : this.resource('username')),
      ext: key => this._ext(key),
      setExt: (key, value) => this._setExt(key, value),
      status: () => this.statusHeader(),
      selfname2: () => this.descript.get('sakura.name2') || '',
      scopeCount: () => this._scopeCount(),
      scope: n => this._scopeInfo(n),
      shells: () => this._shellRecords(),
      currentShell: () => this._shellInfo().id,
      balloon: () => this._balloonRecord(),
      balloonScope: n => this._balloonScope(n),
      setSurface: (n, v) => this._setSurface(n, v),
      setBalloon: (n, id) => this._setBalloon(n, id),
    };
    return this._live;
  }

  /**
   * `….ext.KEY` (properties.md §5.4): GET property.get [R0 KEY] to this ghost as GetStringShiori (SPGhost::VarGet →
   * GetString → GetStringShiori [disasm 0x648547–0x6485D2]; _getString): its string, entities decoded (resourceOf).
   */
  async _ext(key) {
    if (this.closed || this.frozen || !this.shiori) return null;
    return resourceOf(await this._getString('property.get', [String(key)]));
  }

  /**
   * `….ext.KEY` set: GET property.set [R0 KEY, R1 value] to this ghost as GetStringShiori (SPGhost::VarSet [disasm
   * 0x648C7E–0x648D01]; _getString); success is its status in 200–299, whatever its string [disasm 0x648D06–0x648D19].
   */
  async _setExt(key, value) {
    if (this.closed || this.frozen || !this.shiori) return false;
    return isOk(await this._getString('property.set', [String(key), String(value)]));
  }

  /**
   * scope.count: the characters this ghost has, at least 2: the highest `charN.` key of the ghost's or the shell's
   * descript, or the highest scope with a window, plus one [infer: SSP counts its character windows].
   */
  _scopeCount() {
    let n = 2;
    const scan = d => {
      if (!d || typeof d.keys !== 'function') return;
      for (const k of d.keys()) { const m = /^char(\d+)\./i.exec(k); if (m) n = Math.max(n, Number(m[1]) + 1); }
    };
    scan(this.descript);
    scan(this._shellDescript());
    for (const s of this._scopesSorted()) n = Math.max(n, s + 1);
    return n;
  }

  /** The name of scope n: _charName for \0 / \1, else the shell's or the ghost's `charN.name` (properties.md §5.6). */
  _scopeName(n) {
    if (n === 0 || n === 1) return this._charName(n);
    const sd = this._shellDescript();
    return String((sd && sd.get(`char${n}.name`)) || this.descript.get(`char${n}.name`) || '');
  }

  /**
   * currentghost.scope(N).* (properties.md §5.6): name, surface (-1 without a window), the shell's default surface, the
   * default balloon kind, the base point and window rect (desk CSS px; a scope without a window has none) and the
   * scaling in percent (the tag's × Shell scaling ▸ in device px [infer]). null: a scope the ghost does not have.
   * Makes no character view.
   */
  _scopeInfo(n) {
    if (!Number.isInteger(n) || n < 0 || n >= this._scopeCount()) return null;
    const st = this.stage;
    let c = null;
    try { c = st && (typeof st.has !== 'function' || st.has(n)) ? st.char(n) : null; } catch (e) { c = null; }
    const b = this.balloons;
    let defaultSurface = n === 0 ? 0 : 10;
    let balloonDefault = 0;
    try { if (st && typeof st.defaultSurface === 'function') defaultSurface = st.defaultSurface(n); } catch (e) { /* 10 */ }
    try { if (b && typeof b.defaultKind === 'function') balloonDefault = b.defaultKind(n); } catch (e) { /* 0 */ }
    const out = { name: this._scopeName(n), surface: -1, defaultSurface, balloonDefault };
    if (!c) return out;
    out.surface = Number.isFinite(c.surfaceId) ? c.surfaceId : -1;
    try {
      const bp = c.basePoint;
      if (bp) { out.x = bp.x; out.y = bp.y; }
      const r = c.rect;
      if (r) out.rect = [r.x, r.y, r.x + r.width, r.y + r.height];
      const win = this.env.win;
      const k = (Number(st.scale) > 0 ? Number(st.scale) : 1) * ((win && Number(win.devicePixelRatio)) || 1);
      const s = Array.isArray(c.scaling) ? c.scaling : [100, 100];
      out.scaling = [Number(s[0]) * k, Number(s[1]) * k];
    } catch (e) { /* what was read */ }
    return out;
  }

  /**
   * currentghost.shelllist… (properties.md §5.6): every shell of the ghost in the index's order, hidden ones too, with
   * its folder path; `sakuraname` / `keroname` are the current shell's overrides (other shells' descripts are not
   * loaded: '' [decision]).
   */
  _shellRecords() {
    const g = this.ghost || {};
    const cur = this._shellInfo();
    const list = Array.isArray(g.shells) && g.shells.length ? g.shells : [{ id: cur.id, name: cur.name }];
    const sd = this._shellDescript();
    const own = k => String((sd && (sd.get(`${k}.name`) || sd.get(`${k}name`))) || '');
    return list.filter(s => s && s.id != null).map(s => {
      const id = String(s.id);
      const isCur = id === cur.id;
      return {
        id, name: String(s.name || id),
        path: isCur && this.paths.shell ? this.paths.shell : `${this._ghostPath()}shell/${encodeURIComponent(id)}/`,
        sakuraName: isCur ? own('sakura') : '', keroName: isCur ? own('kero') : '', hidden: !!s.hidden,
      };
    });
  }

  /** balloonlist without the Site: the site index's installed balloons for this ghost (shells.js installedBalloons). */
  _balloonRecords() {
    const base = this._siteBase();
    return installedBalloons(this.site, this.ghost).map(b => balloonRecord(b, base));
  }

  /** The balloon in use as a record: found in balloonlist by its path, else by its name; '' id when none matches. */
  _balloonRecord() {
    const path = this.paths.balloon || '';
    const name = this.balloonName || '';
    let list = [];
    try { list = this._world().balloons() || []; } catch (e) { list = []; }
    return list.find(b => path && b.path === path) || list.find(b => name && b.name === name) || { id: '', name, path };
  }

  /**
   * currentghost.balloon.scope(N).* (properties.md §5.7): the scope's text-area numbers (Balloons#metrics, balloon-image
   * px; its balloon made on first use), `num` its \b kind and `rect` the balloon window's desk rect (CSS px).
   */
  _balloonScope(n) {
    const b = this.balloons;
    if (!b || typeof b.metrics !== 'function') return null;
    try {
      const m = b.metrics(n);
      if (!m) return null;
      const v = typeof b.get === 'function' ? b.get(n) : null;
      const r = v && v.rect;
      const num = v && Number.isFinite(v.kind) ? v.kind : 0;
      return { ...m, num, rect: r ? [r.x, r.y, r.x + r.width, r.y + r.height] : null };
    } catch (e) {
      log.once('property-balloon', 'the balloon numbers could not be read', e);
      return null;
    }
  }

  /** Set currentghost.scope(N).surface.num: like \s[v] on scope n [disasm 0x6486FB]. */
  _setSurface(n, v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || !this.stage || this.closed || this.frozen) return false;
    try {
      this.stage.char(n).setSurface(/^[+-]?\d+$/.test(s) ? parseInt(s, 10) : s);
      return true;
    } catch (e) {
      log.once(`property-surface:${n}`, `could not set scope ${n}'s surface`, e);
      return false;
    }
  }

  /** Set currentghost.balloon.scope(N).num: like \b[id] on scope n, < 0 hides [disasm 0x5CA68C–0x5CA6C1]. */
  _setBalloon(n, id) {
    const b = this.balloons;
    if (!b || typeof b.get !== 'function' || this.closed || this.frozen) return false;
    try {
      b.get(n).setKind(id);
      return true;
    } catch (e) {
      log.once(`property-balloon:${n}`, `could not set scope ${n}'s balloon`, e);
      return false;
    }
  }

  /** The browser's navigator (the env window's, else the global one), or null. */
  _navigator() {
    const w = this.env.win;
    if (w && w.navigator) return w.navigator;
    return typeof navigator !== 'undefined' ? navigator : null;
  }

  /**
   * The world core/properties.js resolves names over (PropertyWorld): the loop's clock, the browser's stand-ins for the
   * OS (properties.md §5.5), BASEWARE, this ghost (self), and the Site's lists through `props` (this ghost and its site
   * index without them).
   */
  _world() {
    const p = this.props;
    const own = (name, dflt) => () => {
      if (p && typeof p[name] === 'function') {
        try {
          const v = p[name]();
          if (Array.isArray(v)) return v;
        } catch (e) {
          log.once(`props-${name}`, `props.${name}() failed`, e);
        }
      }
      return dflt();
    };
    const base = this._siteBase();
    const win = this.env.win;
    return {
      now: () => this.clock.now(),
      locale: () => { const n = this._navigator(); return (n && typeof n.language === 'string' && n.language) || 'en'; },
      idleSec: () => (this.input && typeof this.input.idleSeconds === 'function' ? this.input.idleSeconds(this.clock.now()) : 0),
      sessionSec: () => Math.max(0, (this.clock.now() - this.sessionEpochMs) / 1000),
      cursor: () => (this.lastPointer ? { x: this.lastPointer.x, y: this.lastPointer.y } : null),
      viewport: () => {
        const v = this._viewport();
        const dpr = (win && Number(win.devicePixelRatio)) || 1;
        return { w: v.w, h: v.h, dpr, depth: (win && win.screen && Number(win.screen.colorDepth)) || 24 };
      },
      dark: () => {
        try {
          return !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-color-scheme: dark)').matches);
        } catch (e) {
          return false;
        }
      },
      online: () => { const n = this._navigator(); return n && typeof n.onLine === 'boolean' ? n.onLine : null; },
      baseware: { name: BASEWARE[1], version: basewareVersion(), platform: 'ssp.exe' },
      self: () => this.propRecord(),
      ghosts: own('ghosts', () => (((this.site && this.site.ghosts) || []).length ? this.site.ghosts : [this.ghost])
        .map(g => (g && g.id === this.ghost.id ? this.propRecord() : indexGhostRecord(g, base)))),
      active: own('active', () => [this.propRecord()]),
      balloons: own('balloons', () => this._balloonRecords()),
    };
  }

  /**
   * This ghost hears the others' events now (OnGhostCallComplete, OnOtherGhost*, OnOtherGhostTalk; EV §2.7): booted,
   * not closing, closed, changing or frozen, and not locked — minimized, passive, induction, inside \t [disasm: for
   * OnOtherGhostTalk SPCNotify 0x647420 tests IsLocked (\t, passive, induction); guess for minimized and the others].
   */
  get peerLive() {
    return !!(this.booted && !this.closed && !this.closing && !this.changing && !this.frozen && !this.minimized &&
      !this.ghostLife.passive && !this.ghostLife.induction && !this._timeCritical());
  }

  /**
   * An event about another ghost (OnGhostCallComplete, OnOtherGhostBooted / Changed / Closed / Talk; EV §2.7): GET,
   * SenderType internal; the reply plays like a user event's, cutting what this ghost was saying [infer: SSP's
   * OnNotifyEvent plays it like any GET]. Nothing unless peerLive.
   * @returns {Promise<{played:boolean}>}
   */
  async otherEvent(id, refs = []) {
    if (!this.peerLive || !id) return { played: false };
    const r = await this._fire(String(id), refs, { origin: 'user', senderType: 'internal' });
    return { played: !!r.played };
  }

  /**
   * SSP's SPGhost::OnNotifyEvent [disasm 0x640070] for what another ghost sends here (EV §2.7.7, §2.7.9), for the
   * failure events of a raiseother, and for the sound events (OnSoundStop / OnSoundLoop / OnSoundError from the
   * PageSaori, EV §4.17: ssp.exe sends them through OnNotifyEventThread [disasm 0x7199f0]): a GET reply plays (origin 'other': it cuts whatever plays, a \t script, a menu or
   * a goodbye too [decision: as ssp.exe], and nothing while minimized); a NOTIFY's never does. Nothing before boot, once
   * closed, while changing ghosts or frozen ({status: 0, played: false}).
   * @returns {Promise<{status:number, played:boolean}>}
   */
  async notifyEvent(id, refs = [], o = {}) {
    const r = await this._notifyEvent(id, refs, o);
    return { status: r.status, played: r.played };
  }

  async _notifyEvent(id, refs = [], { method = 'GET', senderType = 'internal', headers = {}, kind = '', self = '' } = {}) {
    id = id == null ? '' : String(id);
    if (!id || !this.booted || this.closed || this.changing || this.frozen) return { status: 0, played: false, sent: false };
    const r = await this._fire(id, refs, { method: method === 'NOTIFY' ? 'NOTIFY' : 'GET', origin: 'other', senderType, headers, kind, self });
    return { status: r.res ? Number(r.res.status) || 0 : 0, played: !!r.played, value: r.value, sent: true };
  }

  /**
   * Another ghost's talk reaches this one (SPGhost::CommunicateSSTP [disasm 0x63BD60], EV §2.7.7): GET OnCommunicate
   * [R0 the sender's sakura name, R1 its raw Value, R2… the record's References], SenderType
   * `external,sstp,communicate`, request headers Age, Surface and Marker (when given); the reply plays as
   * notifyEvent's. The descript's `sstp.allowcommunicate` when its ParseBool is not 1 refuses it: 420, the SHIORI is
   * not asked [disasm LoadDescript 0x622875].
   * @param {{sender:string, sentence:string, refs:string[], age:string, surface:string, marker:string}} c
   * @returns {Promise<{status:number, played:boolean}>}
   */
  async communicated(c) {
    const allow = this.descript.get('sstp.allowcommunicate');
    if (allow != null && parseBool(allow) !== 1) return { status: 420, played: false };
    if (!c || typeof c !== 'object') return { status: 0, played: false };
    const s = v => (v == null ? '' : String(v));
    const headers = { Age: s(c.age) || '0', Surface: s(c.surface) };
    if (s(c.marker)) headers.Marker = s(c.marker);
    const refs = [s(c.sender), s(c.sentence), ...(Array.isArray(c.refs) ? c.refs.map(s) : [])];
    // a SHIORI/2.x engine gets CommunicateSSTP's own request, `To` = this ghost's scope-0 name (kawari7-wasm.md §6)
    return this.notifyEvent('OnCommunicate', refs, { senderType: 'external,sstp,communicate', headers, kind: 'communicate', self: this._charName(0) });
  }

  /**
   * Another ghost's \![raiseother] / \![notifyother] (ExecuteRaiseReal [disasm 0x633810–0x633864], EV §2.7.9): GET
   * (its reply plays as notifyEvent's) or NOTIFY `id` with `Sender: <the raiser's sakura name>`, SenderType internal.
   * `ok`: a NOTIFY that was sent, or a GET whose reply has a script; else `status` is the failure's reason (204, 200
   * for an empty Value …). The site checks lockReason first.
   * @returns {Promise<{ok:boolean, status:number}>}
   */
  async raisedByOther(id, refs = [], { notify = false, sender = '' } = {}) {
    const name = sender == null ? '' : String(sender);
    const r = await this._notifyEvent(id, refs, {
      method: notify ? 'NOTIFY' : 'GET', senderType: 'internal', headers: name ? { Sender: name } : {},
    });
    return { ok: !!r.sent && (!!notify || !!r.value), status: r.status };
  }

  /**
   * Why another ghost's raise does not reach this one (SPGhost::IsLocked [disasm 0x642660], then the minimized test
   * [disasm 0x633D53]; EV §2.7.9): `timecritical` (inside \t), `inductionmode`, `passivemode`, `minimized`; '' = none.
   */
  get lockReason() {
    if (this._timeCritical()) return 'timecritical';
    if (this.ghostLife.induction) return 'inductionmode';
    if (this.ghostLife.passive) return 'passivemode';
    if (this.minimized) return 'minimized';
    return '';
  }

  /** The current (last) run's script, '' when none: OnOtherGhostClosed R1, OnGhostCalled R1 (EV §2.7). */
  get lastScript() { return this.current ? this.current.script : ''; }

  /**
   * \![set,otherghosttalk,…] (SS §5.7, EV §2.7) [doc UKADOC:ss; disasm tag handler]: `true` / `after` (and `1`
   * [guess]) asks for OnOtherGhostTalk after each script of another ghost, `before` before it; the two add up, also
   * within one argument (`before,after`); `false` (`0`) clears both. Kept in ghostLife until the ghost closes, so a page
   * change keeps it [doc "ゴースト終了まで有効"].
   */
  _setOtherGhostTalk(args) {
    let { before, after } = this.otherGhostTalk;
    let seen = false;
    for (const tok of (args || []).flatMap(a => String(a ?? '').toLowerCase().split(/[\s,]+/)).filter(Boolean)) {
      if (tok === 'false' || tok === '0') { before = false; after = false; }
      else if (tok === 'true' || tok === '1' || tok === 'after') after = true;
      else if (tok === 'before') before = true;
      else { log.once(`otherghosttalk:${tok}`, `\\![set,otherghosttalk,${tok}] is not understood`); continue; }
      seen = true;
    }
    if (!seen) return;
    this.ghostLife.otherGhostTalk = [before && 'before', after && 'after'].filter(Boolean).join(',');
    if (this.state) this.state.change();
  }

  /** What \![set,otherghosttalk] asked for (EV §2.7). */
  get otherGhostTalk() {
    const v = String(this.ghostLife.otherGhostTalk || '');
    return { before: /before/.test(v), after: /after/.test(v) };
  }

  /**
   * Call ghost ▸ pick, \![call,ghost,…] or the page API (EV §2.7): asks the site to bring `target` up next to this ghost
   * (a folder id when byId; else a name, 'random' or 'sequential': the site resolves it). Emits 'call' {target, byId,
   * raiseEvent, reason, scope, fromScript, script}; script = the playing script for a script's call (OnGhostCalled R1
   * [disasm; infer for the field]), '' otherwise (the site sends OnGhostCalling first: ghostCalling()).
   * @returns {boolean} false when refused: not booted, closed, closing, a ghost change, frozen; a pick (fromScript false)
   *   also inside \t [guess: SSP's call path showed no other lock test]
   */
  callGhost(target, { byId = false, raiseEvent = true, reason = 'manual', scope = 0, fromScript = false } = {}) {
    if (!this.booted || this.closed || this.closing || this.changing || this.frozen) return false;
    if (!fromScript && this._timeCritical()) return false;
    const t = target == null ? '' : String(target).trim();
    if (!t) return false;
    this.emit('call', {
      target: t, byId: !!byId, raiseEvent: !!raiseEvent, reason: reason === 'automatic' ? 'automatic' : 'manual',
      scope: scope | 0, fromScript: !!fromScript, script: fromScript ? this.lastScript : '',
    });
    return true;
  }

  /**
   * PlayerHost: \![call,ghost,<target>(,--option=raise-event)] (SS §5.7, EV §2.7) [doc; disasm ExecuteChangeFromTag
   * isCall=1]. `--option=` tokens are options (`raise-event` anywhere in one, any case); the first other token is the
   * target (unlike \![change,shell], where it is the last); none: ignored. Without raise-event this ghost gets no event;
   * with it, OnGhostCalling with R1 `automatic`. Returns nothing: a call never holds the script (no BreakScript, unlike
   * a change [disasm]). Other kinds are logged.
   */
  call(kind, args = []) {
    const k = String(kind || '').trim().toLowerCase();
    if (k !== 'ghost') { log.once(`call:${k}`, `\\![call,${k}] is not available`); return undefined; }
    let target = null;
    let raiseEvent = false;
    for (const x of args || []) {
      const s = x == null ? '' : String(x).trim();
      if (/^--option=/i.test(s)) { if (/raise-event/i.test(s)) raiseEvent = true; } else if (target === null) target = s;
    }
    if (target) this.callGhost(target, { reason: 'automatic', raiseEvent, fromScript: true });
    return undefined;
  }

  /**
   * PlayerHost: \![raiseother|notifyother,ghost,event,r…] and a fired \![timer*other] (EV §2.7.9) [disasm ExecuteRaise
   * 0x632E80]: emits 'raiseother' {ghost, id, refs, notify} for the site, which finds the targets, raises in them and
   * sends the failure event back here (notifyEvent); `ghost` undefined: the tag had no argument (SSP's `invalid`).
   * Returns nothing: the script never waits (SSP posts it to its main thread). Alone with no site: nothing.
   * A repeating timer's fire adds `live` (false: it was cancelled or replaced meanwhile, the site drops the raise) and
   * `done` (the site calls it once that raise is over or dropped).
   */
  raiseOther(ghost, id, refs = [], { notify = false, live = null, done = null } = {}) {
    const h = this._handlers.get('raiseother');
    if (!h || !h.size) {
      log.debug('raiseother: no other ghosts to raise in');
      if (done) done();
      return undefined;
    }
    this.emit('raiseother', {
      ghost: ghost == null ? undefined : String(ghost), id: id == null ? '' : String(id),
      refs: (refs || []).map(r => (r == null ? '' : String(r))), notify: !!notify,
      ...(live ? { live } : {}), ...(done ? { done } : {}),
    });
    return undefined;
  }

  /**
   * The caller's side of a call with an event (Call ghost ▸, raise-event; EV §2.7): GET OnGhostCalling [R0 callee
   * sakura name, R1 `manual` | `automatic`, R2 its name, R3 its path] with BaseID OnGhostChanging and SenderType
   * internal [doc; disasm]; 204: nothing else. The reply plays (origin user) and the callee loads at once: this
   * resolves as soon as the reply has started, not at its end, and no balloon break cancels a call [disasm: plain
   * PlayScript].
   * @param {{sakuraName?:string, name?:string, path?:string}} callee
   * @returns {Promise<{script:string}>} the reply as played (after OnTranslate; OnGhostCalled R1), '' on 204
   */
  async ghostCalling(callee = {}, { reason = 'manual' } = {}) {
    if (!this.booted || this.closed || this.frozen) return { script: '' };
    let run = null;
    const refs = [callee.sakuraName || '', reason === 'automatic' ? 'automatic' : 'manual', callee.name || '', callee.path || ''];
    await this._fire('OnGhostCalling', refs, {
      origin: 'user', senderType: 'internal', baseId: 'OnGhostChanging', onPlay: r => { run = r; },
    });
    return { script: run ? run.script : '' };
  }

  /**
   * The menu's Quit (EV §2.3, §2.7): every ghost of the page closes. Emits 'quitall' {scope, window} for the site; with
   * nobody listening (no site) it is this ghost's close(scope, {all: true, window}). `scope` is the menu's character,
   * `window` the clicked one (they differ in a menu `popupmenu.type` redirected: R1 / R2, UI §2.1 notes) [disasm 2.9.10
   * CCWC_OnCommand 0x41d4ca]. Nothing while leaving, while a call or ghost change is under way (SSP beeps while any
   * ghost loads [disasm OnMenuExit]) or not booted.
   */
  quitAll(scope = 0, window = scope) {
    if (!this.booted || this.closed || this.changing || this.frozen) return undefined;
    if (this.peers && typeof this.peers.busy === 'function' && this.peers.busy()) return undefined;
    const h = this._handlers.get('quitall');
    if (!h || !h.size) return this.close(scope, { all: true, window });
    this.emit('quitall', { scope: scope | 0, window: window | 0 });
    return undefined;
  }

  /** Another ghost took the keys (EV §4.6, §2.7): the site keeps one active ghost. */
  deactivate() { this.active = false; }

  // ---------------------------------------------------------------- clock (EV §3)

  /** Start the 1-second ticker (aligned to the wall clock; missed ticks are not caught up). */
  start() {
    if (this.tickHandle || this.closed || this.frozen) return;
    const now = this.clock.now();
    this.tickHandle = this.clock.setTimeout(() => {
      this.tickHandle = null;
      this._sampleCollisions(this.clock.now());
      this._tick();
      this.start();
    }, 1000 - (now % 1000) + 5);
  }

  stop() {
    if (this.tickHandle) this.clock.clearTimeout(this.tickHandle);
    this.tickHandle = null;
  }

  _tickRefs(now, can) {
    const hours = Math.max(0, Math.floor((now - this.sessionEpochMs) / 3.6e6));
    const idle = this.input ? this.input.idleSeconds(now) : 0;
    return [hours, this._mikire, this._kasanari, can ? 1 : 0, idle];
  }

  /**
   * R1 / R2 are sampled on odd local seconds only, in the timer just before the tick, whatever the ghost does (EV
   * §3.2.1) [disasm OnTimerMain 0x467d1d: wSecond odd → CCharWndCodeManager::Check, before CSakuraWnd::TimerExec
   * 0x467e03]; between samples the last values stay, 0 before the first. A rect still loading (undefined) keeps the
   * value too.
   */
  _sampleCollisions(now) {
    if (new Date(now).getSeconds() % 2 !== 1) return;
    const off = this._offscreen();
    if (off !== undefined) this._mikire = off ? 1 : 0;
    const ovl = this._overlap();
    if (ovl !== undefined) this._kasanari = ovl ? 1 : 0;
  }

  async _tick() {
    if (!this.booted || this.closed || this.frozen || this.tickBusy) return;
    this.tickBusy = true;
    try {
      const now = this.clock.now();
      const can = this.cantalk;
      const refs = this._tickRefs(now, can);
      const method = can ? 'GET' : 'NOTIFY';
      const minute = minuteKey(now);
      const minuteChanged = minute !== this.lastMinute;
      this.lastMinute = minute;
      const sec = this._fire('OnSecondChange', refs, { method, origin: 'tick' });
      const min = minuteChanged ? this._fire('OnMinuteChange', refs, { method, origin: 'tick' }) : null;
      const s = await sec;
      const m = min ? await min : null;
      if (min && this.state) this.state.change();
      // a time event whose reply started a script ends the tick there; that script stamps anew at its end (EV §3.4)
      // [disasm TimerExec 0x49803f, 0x498158]
      if (!s.played && !(m && m.played)) await this._surfaceRestore(now);
    } finally {
      this.tickBusy = false;
    }
  }

  _viewport() {
    const { win, doc } = this.env;
    const de = doc && doc.documentElement;
    return {
      w: (de && de.clientWidth) || (win && win.innerWidth) || 0,
      h: (de && de.clientHeight) || (win && win.innerHeight) || 0,
    };
  }

  _rectOf(scope) {
    try {
      const c = this.stage.char(scope);
      if (!c || !c.visible || c.surfaceId < 0) return null;
      const r = c.rect;
      return r && r.width > 0 && r.height > 0 ? r : null;
    } catch (e) {
      return null;
    }
  }

  /** the work area R1 tests against: the stage's desk (the layout viewport), else the window's (EV §3.2.1) */
  _desk() {
    const st = this.stage;
    return st && typeof st.desk === 'function' ? st.desk() : this._viewport();
  }

  /**
   * A scope's collision rect (CharacterView.collisionRect, EV §3.2.1). null: an entry ssp.exe's Check leaves out
   * (hidden, no surface, an empty box) [disasm Check 0x420a8e–0x420aa6]; undefined: still loading, or a stage
   * without collision rects.
   */
  _collOf(scope) {
    try {
      const c = this.stage.char(scope);
      if (!c || !c.visible || c.surfaceId < 0) return null;
      const r = c.collisionRect;
      if (r === undefined) return undefined;
      return r && r.width > 0 && r.height > 0 ? r : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * C17 as amended (EV §3.2.1): scope 0's collision rect is not inside the desk, edges inclusive [disasm Check
   * 0x420ec5 IsNot_AllInWorkRect, scope 0 only 0x421019]. undefined: unknown yet.
   */
  _offscreen() {
    const r = this._collOf(0);
    if (r === undefined) return undefined;
    const v = this._desk();
    if (!r || !v.w || !v.h) return false;
    return r.x < 0 || r.y < 0 || r.x + r.width > v.w || r.y + r.height > v.h;
  }

  /**
   * EV §3.2.1: the collision rects of scope 0 and scope 1 intersect, strictly; other scopes never count [disasm Check
   * 0x420c44 IsIntersect, scopes adding up to 1 0x420d29]. undefined: unknown yet.
   */
  _overlap() {
    const a = this._collOf(0);
    const b = this._collOf(1);
    if (a === null || b === null) return false;
    if (a === undefined || b === undefined) return undefined;
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  }

  // ---------------------------------------------------------------- timers (\![timerraise], C3, C4)

  /**
   * PlayerHost: \![timerraise|timernotify,ms,repeat,id,refs...] and, with `to` (the ghost argument),
   * \![timerraiseother|timernotifyother,…] (C3 as amended, C8) [disasm ExecuteRaise 0x632E80]: one list per ghost keyed
   * by the event name, any case, for all four tags (the same event replaces whichever timer had it); ms 0 cancels,
   * 1–49 ms become 50.
   * `repeat`: true = every ms; a string is SSP's ParseBool, 1 = once and anything else (0, false, empty, garbage) =
   * repeat. A timer with `to` raises in other ghosts when it fires ('raiseother'; the target is looked up then).
   */
  timerRaise(ms, repeat, id, refs = [], { notify = false, to = null } = {}) {
    id = id == null ? '' : String(id);
    if (!id) return;
    const n = Number(ms);
    const rep = typeof repeat === 'boolean' ? repeat : parseBool(repeat) !== 1;
    const key = timerKey(id);
    const old = this.timers.get(key);
    if (old) { this._disarm(old); this.timers.delete(key); }
    if (n > 0) {
      const every = Math.max(TIMER_MIN_MS, n);
      const t = {
        ev: id, refs: (refs || []).map(r => (r == null ? '' : String(r))), repeat: rep, intervalMs: every,
        dueAt: this.clock.now() + every, kind: notify ? 'notify' : 'raise', handle: null, inFlight: false,
      };
      if (to != null) t.to = String(to);
      this.timers.set(key, t);
      this._arm(t);
    }
    if (this.state) this.state.change();
  }

  _arm(t) {
    this._disarm(t);
    if (this.closed || this.frozen) return;
    t.handle = this.clock.setTimeout(() => { t.handle = null; this._fireTimer(t); }, Math.max(0, t.dueAt - this.clock.now()));
  }

  _disarm(t) {
    if (t.handle) this.clock.clearTimeout(t.handle);
    t.handle = null;
  }

  async _fireTimer(t) {
    const key = timerKey(t.ev);
    if (this.timers.get(key) !== t || this.closed || this.frozen) return;
    if (t.repeat) {
      t.dueAt = Math.max(t.dueAt + t.intervalMs, this.clock.now() + 1);
      this._arm(t);
    } else {
      this.timers.delete(key);
    }
    if (this.state) this.state.change();
    if (typeof t.to === 'string') {  // \![timer*other]: the site looks the ghost up now, as SSP at each fire (C8)
      if (!t.repeat) { this.raiseOther(t.to, t.ev, t.refs, { notify: t.kind === 'notify' }); return; }
      // a repeating one: no fire while the last one waits in the site's queue or is delivered, and one still waiting
      // when the timer is cancelled or replaced is dropped. SSP raises a periodic timer under 1 s inside its timer
      // callback (ExecuteRaiseTimer → ExecuteRaiseReal [disasm 0x632B8D–0x632BC2]) and kills it at once
      // (timeKillEvent [disasm 0x632A8E]), so no queue of its raises builds up [decision for 1 s and more: SSP posts
      // those]
      if (t.inFlight) return;
      t.inFlight = true;
      this.raiseOther(t.to, t.ev, t.refs, {
        notify: t.kind === 'notify',
        live: () => this.timers.get(key) === t && !this.closed && !this.frozen,
        done: () => { t.inFlight = false; },
      });
      return;
    }
    if (t.inFlight) return;          // a slow engine: do not pile up requests for the same timer
    t.inFlight = true;
    try {
      await this._dressupReported();
      if (this.closed || this.frozen) return;
      if (t.kind === 'notify') await this._request(t.ev, t.refs, { method: 'NOTIFY', headers: { SenderType: 'internal,raise' } });
      else await this._fire(t.ev, t.refs, { origin: 'timer', senderType: 'internal,raise' });
    } finally {
      t.inFlight = false;
    }
  }

  /** C4: re-arm persisted timers; overdue one-shots fire now in dueAt order, overdue repeats move to now+interval. */
  _restoreTimers(list) {
    const now = this.clock.now();
    const overdue = [];
    for (const raw of list) {
      if (!raw || !raw.ev || !(raw.intervalMs > 0)) continue;
      const intervalMs = Math.max(TIMER_MIN_MS, raw.intervalMs);       // a state saved before the floor (C8)
      const t = { ...raw, refs: raw.refs || [], intervalMs, handle: null, inFlight: false };
      this.timers.set(timerKey(t.ev), t);
      if (t.dueAt > now) this._arm(t);
      else if (t.repeat) { t.dueAt = now + t.intervalMs; this._arm(t); }
      else overdue.push(t);
    }
    overdue.sort((a, b) => a.dueAt - b.dueAt);
    for (const t of overdue) this._fireTimer(t);
  }

  _clearTimers() {
    for (const t of this.timers.values()) this._disarm(t);
    this.timers.clear();
  }

  // ---------------------------------------------------------------- PlayerHost

  /**
   * \![raise] / \![notify] / \![embed]. OnDirectSaoriCall is queued without waiting (C25); other raises wait and a
   * non-empty reply replaces the current run (played here) unless that run is already gone.
   */
  async raise(id, refs = [], { notify = false, embed = false, waitReply = true } = {}) {
    id = id == null ? '' : String(id);
    if (!id) return null;
    refs = (refs || []).map(r => (r == null ? '' : String(r)));
    if (notify) {
      this._request(id, refs, { method: 'NOTIFY', headers: { SenderType: 'internal,raise' } });
      return null;
    }
    if (embed) {
      // ssp.exe's EmbedSendEventFunc: the reply's %-variables expanded [disasm TranslateParam 0x633349], then GET
      // OnTranslate on it [disasm TranslateScript 0x633389: R0 the expanded reply, R1 "", R2 the event, R3 its refs
      // joined by \x01 (MakeLastReference), the embed's SenderType]; a reply that changed it is spliced as returned,
      // not expanded again (EV §4.10)
      const v = valueOf(await this._request(id, refs, { headers: { SenderType: 'internal,embed' } }));
      if (v === null) return null;
      const s = await this.expand(v);
      const headers = { SenderType: 'internal,embed' };
      return valueOf(await this._request('OnTranslate', [s, '', id, refs.join('\x01')], { headers, kind: 'translate' })) || s;
    }
    if (id.trim() === 'OnDirectSaoriCall') {
      this._request(id, refs, { headers: { SenderType: 'internal,raise' } });
      return null;
    }
    if (!waitReply) {
      this._fire(id, refs, { origin: 'async', senderType: 'internal,raise' });
      return null;
    }
    return this._raiseWait(id, refs, 'internal,raise', this.gen);
  }

  /**
   * A waited raise (\![raise], \![get,property]): GET id with SenderType `senderType`; a non-empty reply replaces the
   * run that raised it (`gen`), unless that run is already gone. Resolves with the reply.
   */
  async _raiseWait(id, refs, senderType, gen) {
    const value = valueOf(await this._request(id, refs, { headers: { SenderType: senderType } }));
    if (!value) return null;
    if (gen !== this.gen || this.closed) return value;     // the raising run was replaced meanwhile: drop
    // a shell swap: after it, by the same rule (dropped once another run started: _staleRaise) (EV §2.6); queued now,
    // so it takes the pending COMMUNICATE before OnTranslate (EV §2.7.7)
    const communicate = this._takeComm();
    const item = { id, refs, value, origin: 'raise', senderType, script: null, gen, communicate };
    if (this._swapHold('raise', item)) return value;
    return this._inOrder(async () => {
      const script = await this._translate(value, id, refs, senderType);
      if (gen !== this.gen || this.closed) return value;
      if (!this._swapHold('raise', { ...item, script })) {
        this._play(script, { event: id, refs, origin: 'raise', communicate });
      }
      return value;
    });
  }

  /**
   * PlayerHost: \![execute,http-*,…] (EV §4.15). False: not HTTP (rss, ical, websocket stay unsupported; the player
   * reports the tag); a promise: a request without --async, which holds the script at the tag until its event's reply
   * has started (a non-empty one replaces the run, as SSP raises it inside the tag) [disasm].
   */
  httpExecute(sub, args = []) { return this.http.execute(sub, (args || []).map(x => (x == null ? '' : String(x)))); }

  /** PlayerHost: \![cancel,http|rss|ical|websocket,URL] (EV §4.15). */
  httpCancel(sub, args = []) { return this.http.cancel(sub, args || []); }

  /**
   * HttpRequests' host (EV §4.15): requests go out while booted and not closed or frozen (a closing or leaving ghost's
   * goodbye may still send one); the file and the event need the engine still up; the event is dropped while locked
   * (minimized, passive, induction, \t) [disasm SPGhost::OnNotifyEvent; IsLocked as peerLive's guess]. The event is a
   * GET (SenderType internal) whose reply plays like a user event's [infer: SSP plays it like any GET reply].
   */
  _httpHost() {
    const up = () => this.booted && !this.closed && !this.frozen && !!this.shiori;
    return {
      canSend: up,
      live: up,
      locked: () => !!this.minimized || !!this.ghostLife.passive || !!this.ghostLife.induction || this._timeCritical(),
      ghostDir: () => (this.shiori && typeof this.shiori.ghostDir === 'string' ? this.shiori.ghostDir : ''),
      writeFile: (rel, bytes) => (this.shiori && typeof this.shiori.writeFile === 'function'
        ? this.shiori.writeFile(rel, bytes) : Promise.reject(new Error('the engine takes no files'))),
      readFile: rel => (this.shiori && typeof this.shiori.readFile === 'function' ? this.shiori.readFile(rel) : Promise.resolve(null)),
      event: (id, refs) => this._fire(id, refs, { origin: 'user', senderType: 'internal' }),
    };
  }

  openUrl(url) {
    const u = String(url || '').trim();
    let target = null;
    if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) target = u;
    else if (/^file:\/\/\//i.test(u) && this.files) {
      let rel = u.slice(8);
      try { rel = decodeURIComponent(rel); } catch (e) { /* keep */ }
      target = this.files.url(`ghost/master/${rel}`);
    }
    if (!target) { log.once(`url:${u}`, `not opening ${u}`); return false; }
    try {
      const w = this.env.win;
      if (w && typeof w.open === 'function') w.open(target, '_blank', 'noopener');
      return true;
    } catch (e) {
      return false;
    }
  }

  sound(cmd, args = []) {
    if (this.audio && typeof this.audio.sound === 'function') {
      try { this.audio.sound(cmd, args); } catch (e) { log.once('sound', 'sound failed', e); }
    } else {
      log.once('sound-none', 'sounds are not available');
    }
  }

  setOption(name, args = []) {
    const n = String(name || '').toLowerCase();
    const v = args[0];
    switch (n) {
      case 'choicetimeout': this.scriptOpts.choiceTimeoutMs = parseTimeoutOpt(v); break;
      case 'balloontimeout': this.scriptOpts.balloonTimeoutMs = parseTimeoutOpt(v); break;
      case 'windowstate': this.windowState(String(v || '').toLowerCase()); break;
      case 'enter':
      case 'leave': {
        const mode = String(v || '').toLowerCase().replace(/mode$/, '');
        // one slot in ssp.exe (SPGhost+0x41a8): entering one mode leaves the other, leaving either leaves both
        if (mode === 'passive' || mode === 'induction') this._setLifeMode(n === 'enter' ? mode : '');
        else log.once(`mode:${mode}`, `\\![${n},${v}] is not supported`);
        break;
      }
      case 'passivemode':
      case 'inductionmode': {
        const mode = n.replace(/mode$/, '');
        if (v === undefined || v === '' || v === '1' || v === true) this._setLifeMode(mode);
        else if (this.ghostLife[mode]) this._setLifeMode('');
        break;
      }
      case 'otherghosttalk': this._setOtherGhostTalk(args); break;
      default:
        if (isTrayIconTag(n)) { this.setTrayIcon(args); break; }      // trayicon, tasktrayicon: prefixes (UI §2.6)
        log.once(`opt:${n}`, `\\![set,${n}] is not handled by the runtime`);
    }
  }

  /**
   * Passive or induction mode (EV §1.6): ONE value in ssp.exe, SPGhost+0x41a8 = 1 induction, 2 passive, 0 neither
   * [disasm ExecuteExclamationTag 0x62f43a / 0x62f484 (enter), 0x630513 / 0x63055d (leave); IsLocked 0x6447d3;
   * OnMenuLeavepassive 0x49dd12]. ghostLife keeps its two booleans (saved state); they are never both true.
   * @param {''|'passive'|'induction'} mode
   */
  _setLifeMode(mode) {
    this.ghostLife.passive = mode === 'passive';
    this.ghostLife.induction = mode === 'induction';
    if (this.state) this.state.change();
  }

  /**
   * \![set,trayicon,path,tooltip,--duration=,--runcount=] (UI §2.6): the icon the launcher shows while she is
   * minimized. ssp.exe's SetTrayIconName [disasm 0x61f160]: no or an empty path reloads the icon without script info
   * (the script's icon forgotten: the descript's again; while minimized, or minimizing, the icon shown stays); else the
   * file is looked for in the ghost root, then ghost\master\ (trayicon.js findIcon), and a missing one changes nothing.
   * Found: the icon shown while minimized (`minimized.icon`, 'trayicon' emitted), else the one the next minimize shows
   * (`trayIcon`) [disasm LoadTrayIcon 0x49e4c3–0x49e561]. The tooltip, --duration and --runcount are not used
   * [decision: the label stays Sumika's, no animation]. Under ssp.exe's untrusted-script flag the tag is refused; that
   * gate is not copied (properties.md §8).
   * @param {string[]} args the tag's arguments after `trayicon`
   */
  setTrayIcon(args = []) {
    const p = args[0] == null ? '' : String(args[0]);
    if (!p) {
      if (this.minimized || this.minimizing || !this.trayIcon) return;
      this.trayIcon = null;
      if (this.state) this.state.change();
      return;
    }
    const real = findIcon(this.files, p);
    if (!real) { log.once(`trayicon:${p}`, `\\![set,trayicon]: no icon file "${p}" in the ghost`); return; }
    if (this.minimized) {
      this.minimized = { ...this.minimized, icon: real };
      if (this.state) this.state.change();
      this.emit('trayicon', { icon: real });
      return;
    }
    this.trayIcon = real;
    if (this.state) this.state.change();
  }

  /**
   * \![open,inputbox|…|communicatebox|teachbox,…] (\__c and \__t come here as communicatebox / teachbox; SS §5.9).
   * A teach box opened by a script sends OnTeachStart (UI §6.3).
   */
  openBox(kind, args = []) {
    const k = String(kind || '').toLowerCase();
    if (k === 'communicatebox' || k === 'teachbox' || INPUT_KINDS[k]) { this._runBox(k, parseBoxArgs(k, args), args); return; }
    log.once(`open:${k}`, `\\![open,${k}] is not supported`);
  }

  /** \![close,…]: silently (no cancel event); the teach box's 311/312 round ends with it. */
  closeBox(kind, args = []) {
    const k = String(kind || '').toLowerCase();
    const id = args[0] == null ? '' : String(args[0]);
    for (const b of [...this.boxes.values()]) {
      const match = k === 'communicatebox' || k === 'teachbox' ? b.kind === k
        : INPUT_KINDS[k] ? !!INPUT_KINDS[b.kind] && (id === '__SYSTEM_ALL_INPUT__' || b.id === id) : false;
      if (!match) continue;
      b.silent = true;
      this.boxes.delete(b.key);
      this._closeDialog(b);
    }
    if (this.state) this.state.change();
  }

  _closeDialog(b) {
    const d = this.dialogs;
    if (!d) return;
    try {
      if (b.kind === 'teachbox') d.close('teachbox');
      else if (b.kind !== 'communicatebox') d.close(b.id);
      else if (typeof d.closeCommunicate === 'function') d.closeCommunicate();
      else d.close('communicatebox');
    } catch (e) { /* ignore */ }
  }

  windowState(state) {
    if (state === 'minimize') this.minimize('script');
    else if (state === 'restore') this.restore();
    else log.once(`windowstate:${state}`, `\\![set,windowstate,${state}] is not supported`);
  }

  /**
   * PlayerHost: \![change,ghost|shell|balloon,…], \+ (ghost random) and \_+ (ghost sequential) [U-ss].
   * Ghost: the first argument is the target; without raise-event the leaving ghost gets no OnGhostChanging, and the
   * script plays to its end first (nothing is returned: the player must not wait for it).
   * Shell and balloon (EV §2.6): `--option=…` tokens are options (`raise-event` anywhere in one), the last other token is
   * the target [disasm]; none: ignored. A shell change without raise-event, and every balloon change, happen at the tag:
   * the returned promise holds the player there until the swap is done. A shell change with raise-event goes like a
   * menu pick (OnShellChanging first) and does not hold the script. Balloons parse raise-event and ignore it [disasm].
   * @returns {Promise<boolean>|undefined}
   */
  change(kind, args = []) {
    const k = String(kind || '').toLowerCase();
    const a = (args || []).map(x => (x == null ? '' : String(x)));
    if (k === 'shell' || k === 'balloon') {
      let target = null;
      let raiseEvent = false;
      for (const x of a) {
        const s = x.trim();
        if (/^--option=/i.test(s)) { if (/raise-event/i.test(s)) raiseEvent = true; } else target = s;
      }
      if (!target) return undefined;
      if (k === 'balloon') return this.changeBalloon(target, { fromScript: true }) || undefined;
      const p = this.changeShell(target, { raiseEvent, fromScript: true });
      return raiseEvent ? undefined : p || undefined;
    }
    if (k !== 'ghost') { log.once(`change:${k}`, `\\![change,${k},${a[0] || ''}] is not available`); return undefined; }
    const target = (a[0] || '').trim();
    if (!target) return undefined;
    const raiseEvent = a.slice(1).some(x => /^--option=raise-event$/i.test(x.trim()));
    // a script's announced change tells the ghost `automatic` (the tag posts its change with bit 24, which
    // OnChangeMessage reads as not manual) [disasm 2.9.10 ExecuteChangeFromTag 0x62cd63, OnChangeMessage 0x4972a2]
    this.changeGhost(target, { raiseEvent, fromScript: true, reason: 'automatic' });
    return undefined;
  }

  /**
   * PlayerHost: \![reload,shiori|shell|balloon|ghost] and \![reloadsurface] (= shell) (EV §2.10) [disasm
   * ExecuteExclamationTag 0x6313a8–0x631419]. Shiori (reloadShiori), shell and balloon happen at the tag: the returned
   * promise holds the player there until the reload is done. Shell and balloon go through the runtime's change path
   * with the ones in use (viewSwitcher, req.reload): ChangeOrReloadShellInternal / ChangeOrReloadBalloonInternal(-1,
   * event false), so no OnShellChanging, OnShellChanged or OnBalloonChange [disasm 0x6313b4, 0x631403]. Ghost
   * (reloadGhost) returns nothing: the script goes on until the ghost unloads.
   * @returns {Promise<boolean>|undefined}
   */
  reload(kind) {
    const k = String(kind || '').toLowerCase();
    if (k === 'shiori') return this.reloadShiori() || undefined;
    if (k === 'shell' || k === 'balloon') {
      return this._requestView({ kind: k, target: '', reload: true, byId: false, raiseEvent: false, scope: 0, fromScript: true }) || undefined;
    }
    if (k === 'ghost') { this.reloadGhost(); return undefined; }
    log.once(`reload:${k}`, `\\![reload,${k}] is not available`);
    return undefined;
  }

  /**
   * Shell ▸ pick, \![change,shell,…] or the page API (EV §2.6): asks the runtime (viewSwitcher) to switch to `target`
   * (a folder id when byId; else a descript name, 'random', 'sequential'; the runtime resolves it). The runtime then
   * calls shellChanging() (raiseEvent), detachStage(), attachStage() and shellChanged() here.
   * @returns {Promise<boolean>|false} false when refused: not booted, closed, a ghost change, frozen; a menu or page
   *   request (fromScript false) also while minimized, in passive or induction mode, or inside \t [disasm]
   */
  changeShell(target, { byId = false, raiseEvent = true, scope = 0, fromScript = false } = {}) {
    return this._requestView({ kind: 'shell', target, byId, raiseEvent, scope, fromScript });
  }

  /** Balloon ▸ pick, \![change,balloon,…] or the page API (EV §2.6): like changeShell; there is no OnBalloonChanging. */
  changeBalloon(target, { byId = false, scope = 0, fromScript = false } = {}) {
    return this._requestView({ kind: 'balloon', target, byId, raiseEvent: false, scope, fromScript });
  }

  /** reload: the shell or balloon in use again (\![reload,…], EV §2.10): no target, `reload: true` in the request */
  _requestView({ kind, target, byId, raiseEvent, scope, fromScript, reload = false }) {
    if (!this.booted || this.closed || this.changing || this.frozen) return false;
    // SSP beeps at a user's pick while locked; a script's change skips this test [disasm]
    if (!fromScript && (this.minimized || this.ghostLife.passive || this.ghostLife.induction || this._timeCritical())) return false;
    const t = target == null ? '' : String(target).trim();
    if (!t && !reload) return false;
    if (typeof this.viewSwitcher !== 'function') { log.once(`change-${kind}`, `${kind} changes are not available`); return false; }
    const req = { kind, target: t, byId: !!byId, raiseEvent: !!raiseEvent, fromScript: !!fromScript, scope: scope | 0, ...(reload ? { reload: true } : {}) };
    let p;
    try {
      p = this.viewSwitcher(req);
    } catch (e) {
      log.error(`${kind} change failed`, e);
      return false;
    }
    return Promise.resolve(p).then(v => !!v, e => { log.error(`${kind} change failed`, e); return false; });
  }

  /**
   * Clothes/Dressup ▸ pick (EV §4.11): toggles one bind group at once, also while a script plays; its events go out at
   * once with R4 `user`, after the playing script's binds so far (NOTIFY: SSP reports a script's block at its next
   * text, before a pick can come [disasm]). A pick that changes no flag (a mustselect default unticked comes back)
   * still sends GET OnNotifyDressupInfo. Refused (no change, no event) while minimized, in passive or induction mode,
   * or inside \t [disasm IsLocked], and during a shell swap.
   */
  toggleDressup(scope, id) {
    if (!this.booted || this.closed || this.changing || this.frozen || this._swap) return false;
    if (this.minimized || this.ghostLife.passive || this.ghostLife.induction || this._timeCritical()) return false;
    const st = this.stage;
    if (!st || typeof st.setBind !== 'function') return false;
    scope |= 0;
    id = Number(id);
    if (this.pendingDressup.length) this._flushDressup(false);
    let changes;
    try {
      changes = st.setBind(scope, id, undefined, { origin: 'user' });
    } catch (e) {
      log.once('dressup-toggle', 'dress-up toggle failed', e);
      return false;
    }
    // no net change: the block was still applied, so OnNotifyDressupInfo follows (EV §4.11 "even when skipped")
    if (Array.isArray(changes) && !changes.length && this._hasBindGroup(st, scope, id)) this._queueUserDressup(null);
    return true;
  }

  _hasBindGroup(st, scope, id) {
    try {
      const b = typeof st.bindState === 'function' ? st.bindState(scope) : null;
      return !!(b && b.byId && b.byId.has(id));
    } catch (e) {
      return false;
    }
  }

  /**
   * The menu's enable level (UI §2.11) [disasm GetEnableState]: 3 in passive mode, 2 in induction mode or while
   * minimized, else 0.
   */
  get enableLevel() {
    if (this.ghostLife.passive) return 3;
    if (this.ghostLife.induction || this.minimized) return 2;
    return 0;
  }

  /**
   * Shell change, before the swap (menu pick, raise-event; EV §2.6): GET OnShellChanging [R0 next shell name, R1 the
   * current one's (= R0 on a re-pick), R2 next shell path] [doc; disasm: GET, no fallback]. Its reply plays (origin
   * user) and the switch waits for its END. Not ok after a balloon break, a run that replaces it (the ghost answers a
   * click) [infer], a close, destroy() / suspend() / leave(), or the 30 s cap (changeWaitMs) [decision: SSP has no
   * cap]. The runtime suspends during a change only for a ghost that cannot draw (Runtime._canvasLost:
   * the change is cancelled): a takeover waits for the change's end, and a ghost change asked meanwhile is refused (a
   * script's too: queuing it would hold this talk). A page left meanwhile saves no run: the change is dropped and the
   * talk not replayed [decision].
   * @param {{name?:string, path?:string}} next
   * @returns {Promise<{ok:boolean}>}
   */
  async shellChanging(next = {}, { scope = 0 } = {}) {     // scope: the menu's character (not a Reference)
    if (!this.booted || this.closed || this.changing || this.frozen || this._viewWait) return { ok: false };
    const w = { broken: false, breakable: true, wake: null };
    this._viewWait = w;
    const bad = () => w.broken || this.closed || this.frozen || this.changing;
    let ok = false;
    try {
      const refs = [next.name || '', this._shellInfo().name, next.path || ''];
      // Status `changing` from its response on (its reply's OnTranslate and talk too), 204 or not [disasm
      // OnChangeMessage 0x4978c5: set after OnShellChanging's SendEvent]
      const r = await this._fire('OnShellChanging', refs, { origin: 'user', onResponse: () => { this._shellFlag = true; } });
      if (bad()) return { ok: false };
      const run = r.played ? this.current : null;
      if (!run || !run.finished) { ok = true; return { ok }; }
      let h = null;
      let capped = false;
      const cap = new Promise(res => {
        w.wake = res;
        h = this.clock.setTimeout(() => { capped = true; res(null); }, this.opts.changeWaitMs);
      });
      const end = await Promise.race([run.finished, cap]).finally(() => { w.wake = null; this.clock.clearTimeout(h); });
      ok = !capped && !bad() && !!end && end.reason === 'end';
      return { ok };
    } finally {
      if (this._viewWait === w) this._viewWait = null;
      // cancelled: SSP leaves +0x41a4 set until its next shell change (the broken talk never posts the change: Loop
      // 0x63baa7–0x63bab8), which also keeps its ticks NOTIFY; Sumika clears it [decision] (EV §1.6)
      if (!ok) this._shellFlag = false;
    }
  }

  /**
   * Shell swap, first half (EV §2.6 "The swap" #1–#3): remembers each shown scope's surface id, closes every balloon
   * (choices and post-script timers go with them; boxes stay), reports a script's pending binds (NOTIFY) and stops
   * listening to the stage. The runtime then builds the new stage and calls attachStage(). From here until
   * shellChanged() (or a failed swap's attachStage of the old stage) the loop is `swapping`: cantalk 0, so ticks go
   * as NOTIFY, and no reply plays (_swapHold), so nothing talks on the stage being replaced; a script still playing
   * (a menu pick whose OnShellChanging answered 204) is held there too (player.hold(), released by _endSwap) [infer:
   * SSP swaps synchronously, so its tags run only after the swap].
   * @returns {Map<number, number>} scope -> surface id, for shellChanged()
   */
  detachStage() {
    if (!this._swap) this._swap = { held: [] };
    this._holdPlayer(true);
    const shown = new Map();
    for (const s of this._scopesSorted()) {
      try {
        const c = this.stage.char(s);
        if (c && Number.isFinite(c.surfaceId) && c.surfaceId >= 0 && (c.visible !== false || this.minimized)) shown.set(s, c.surfaceId);
      } catch (e) { /* ignore */ }
    }
    this._flushSurfaces();
    this._cancelPost();
    this._hideBalloons();
    if (this.pendingDressup.length) this._flushDressup(false);
    if (this.pendingUserDressup.length || this._userBlock) this._flushDressup(false, 'user');
    // Status `changing` (a script's \![change,shell] has no OnShellChanging): set after the lazy binds' report, as
    // ChangeOrReloadShellInternal sets +0x41a4 after ProcessLazyCommandExec [disasm 0x623120–0x623125] (EV §1.6)
    this._shellFlag = true;
    this._acceptDrops(false);
    this._unwireStage();
    this.press = null;
    this.moveQueued = null;
    return shown;
  }

  /**
   * Shell swap, second half (EV §2.6 #6): listen to the new stage, hand it to the player, take drops on it; `shell`
   * and the shell path (OnNotifySelfInfo R3/R4 and the rest) now describe it. The swap goes on until shellChanged();
   * attaching the stage that was detached (a failed swap puts the old one back) ends it here.
   * @param {object} stage
   * @param {{id?:string, name?:string, path?:string}} [info]
   */
  attachStage(stage, { id, name, path } = {}) {
    if (this._stageOffs.length) this._unwireStage();
    const back = stage === this.stage;
    this.stage = stage;
    this.pendingSurface.clear();
    this._wireStage();
    if (this.player && typeof this.player.setStage === 'function') {
      try { this.player.setStage(stage); } catch (e) { log.once('player-stage', 'player.setStage failed', e); }
    }
    const ref = shellRef({ id, name });
    if (ref) this.shell = ref;
    if (path !== undefined) this.paths = { ...this.paths, shell: path || '' };
    this._acceptDrops(this.booted && !this.closed && !this.frozen);
    if (this.state) this.state.change();
    if (back) this._endSwap();
  }

  /**
   * The swap is over: the replies it held join the reply queue (behind OnShellChanged's; a \![raise] reply whose
   * raising run OnShellChanged's reply replaced is dropped, _staleRaise) and play when nothing does; the script the
   * swap held goes on, now on the new stage (after a 204's restored surfaces), unless OnShellChanged's reply replaced it.
   */
  _endSwap() {
    const s = this._swap;
    this._swap = null;
    this._shellFlag = false;          // a failed swap too [disasm 0x6230e5, 0x623113] (EV §1.6)
    if (this.frozen) return;          // destroyed, suspended or left: the held run never goes on (the player goes too)
    if (s && !this.closed) this._replyQueue.push(...s.held.filter(q => !this._staleRaise(q)));
    this._holdPlayer(false);
    if (!s || this.closed) return;
    if (this._replyQueue.length && !this._talking() && !this._choicePending()) this._playQueued();
  }

  /** player.hold() / release() (optional in the player): its current run pauses while a shell swap is on (EV §2.6). */
  _holdPlayer(on) {
    const p = this.player;
    const f = p && (on ? p.hold : p.release);
    if (typeof f !== 'function') return;
    try { f.call(p); } catch (e) { log.once('player-hold', `player.${on ? 'hold' : 'release'} failed`, e); }
  }

  /**
   * Shell swap, events (EV §2.6) [disasm]: NOTIFY OnNotifySelfInfo, OnNotifyShellInfo [name, path, surface ids],
   * OnNotifyDressupInfo and installedshellname; then, with `event`, GET OnShellChanged [R0 shell name, R1 the ghost's
   * descript name, R2 shell path]. Its reply plays now, or with `defer` when the running script ends (a script's
   * \![change,shell] [guess]). No reply (204), or no event: the remembered scopes get their surface ids back. The
   * swap ends here (`swapping` false): the replies it held follow OnShellChanged's, and the script it held goes on.
   * @param {{surfaces?: Map<number,number>|Iterable<[number,number]>|Object<string,number>, event?:boolean, defer?:boolean}} o
   * @returns {Promise<{restored: boolean}>} restored: the remembered surfaces were put back (no event, or a 204), so the
   *   swap's surfaces are decided here (the runtime's shellSwap marker goes, EV §2.6 #4)
   */
  async shellChanged({ surfaces = null, event = true, defer = false } = {}) {
    const res = { restored: false };
    // Status `changing` ends with OnShellChanged's response, before its reply's OnTranslate and a 204's restored
    // surfaces [disasm ChangeOrReloadShellInternal 0x623466 → 0x623490 → PopSurfaceStatus 0x62349d] (EV §1.6)
    const done = () => { this._shellFlag = false; };
    const restore = () => { done(); this._restoreSurfaces(surfaces); res.restored = true; };
    try {
      if (this.closed || this.frozen) return res;
      const N = (id, refs) => this._request(id, refs, { method: 'NOTIFY' });
      const sh = this._shellInfo();
      let ids = [];
      try { const s = this.stage && this.stage.shell; ids = s && typeof s.surfaceIds === 'function' ? s.surfaceIds() : []; } catch (e) { ids = []; }
      N('OnNotifySelfInfo', this._selfInfoRefs());
      N('OnNotifyShellInfo', [sh.name, this.paths.shell || '', ids.join(',')]);
      N('OnNotifyDressupInfo', this._dressupRefs());
      N('installedshellname', this._shellNames());
      if (!event) { restore(); return res; }
      const refs = [sh.name, this._ghostName(), this.paths.shell || ''];
      if (defer) {
        const value = valueOf(await this._request('OnShellChanged', refs));
        done();
        if (!value) restore();
        else this._deferReply({ id: 'OnShellChanged', refs, value, origin: 'user' });
        return res;
      }
      const r = await this._fire('OnShellChanged', refs, { origin: 'user', swap: true, onResponse: done });
      if (!r.value) restore();
      return res;
    } finally {
      this._endSwap();
    }
  }

  /** PopSurfaceStatus [disasm]: each remembered scope shows its old surface id again, now from the new shell. */
  _restoreSurfaces(surfaces) {
    if (!surfaces || this.closed || this.frozen) return;
    const list = surfaces instanceof Map ? [...surfaces] : Symbol.iterator in Object(surfaces) ? [...surfaces] : Object.entries(surfaces);
    for (const [s, id] of list.map(([s, id]) => [Number(s), Number(id)]).sort((a, b) => a[0] - b[0])) {
      if (!Number.isInteger(s) || !Number.isFinite(id) || id < 0) continue;
      try {
        const c = this.stage.char(s);
        if (c && typeof c.setSurface === 'function') c.setSurface(id);
      } catch (e) { log.once(`restore-surface:${s}`, `could not restore scope ${s}'s surface`, e); }
    }
  }

  /** The balloon now in use (EV §2.6): OnNotifySelfInfo R5/R6 from here on. */
  setBalloonInfo({ name, path } = {}) {
    if (name !== undefined) this.balloonName = name == null ? '' : String(name);
    if (path !== undefined) this.paths = { ...this.paths, balloon: path || '' };
  }

  /**
   * Balloon change, events (EV §2.6) [disasm]: NOTIFY OnNotifySelfInfo (new R5/R6), then with `event` GET
   * OnBalloonChange [R0 balloon name, R1 its path]; its reply plays now, or with `defer` when the running script ends
   * [guess]. There is no OnBalloonChanging.
   */
  async balloonChanged({ event = true, defer = false } = {}) {
    if (this.closed || this.frozen) return;
    this._request('OnNotifySelfInfo', this._selfInfoRefs(), { method: 'NOTIFY' });
    if (!event) return;
    const refs = [this.balloonName || '', this.paths.balloon || ''];
    if (defer) {
      const value = valueOf(await this._request('OnBalloonChange', refs));
      if (value) this._deferReply({ id: 'OnBalloonChange', refs, value, origin: 'user' });
      return;
    }
    await this._fire('OnBalloonChange', refs, { origin: 'user' });
  }

  /**
   * Ask for a ghost change (menu, script, page API). Emits 'change' {kind:'ghost', target, reason, raiseEvent, scope,
   * fromScript, byId}; the runtime resolves the target (a ghost id when byId, else a name, 'random' or 'sequential'),
   * refuses ghosts it cannot run, then calls farewell() and leave() here (EV §2.5). False when this loop cannot now.
   */
  changeGhost(target, { reason = 'manual', raiseEvent = true, scope = 0, fromScript = false, byId = false } = {}) {
    if (!this.booted || this.closed || this.changing || this.frozen) return false;
    // a script that asks counts as broken, as SSP's BreakScript [disasm 0x62AF92], when the target names a ghost
    // (this one, or one not on screen); an unknown ghost or one on screen elsewhere leaves it unbroken, as
    // GetGhostIDFromTag's -1 [disasm 0x62A890, 0x62AEEA–0x62AEED]. Broken: its COMMUNICATE does not go and
    // OnOtherGhostTalk gets `break` (EV §2.7.4, §2.7.7)
    if (fromScript && this.current && this._changeFinds(target, byId)) this.current.ghostChange = true;
    this.emit('change', {
      kind: 'ghost', target: String(target), reason, raiseEvent: !!raiseEvent, scope: scope | 0, fromScript: !!fromScript, byId: !!byId,
    });
    return true;
  }

  /** ghostFinder (the runtime's, EV §2.7.7): whether a change to `target` finds a ghost; without one: it does. */
  _changeFinds(target, byId) {
    if (typeof this.ghostFinder !== 'function') return true;
    try {
      return !!this.ghostFinder(String(target), { byId: !!byId });
    } catch (e) {
      log.once('ghost-finder', 'the ghost change target could not be looked up', e);
      return false;
    }
  }

  /**
   * Ghost change, leaving side (EV §2.5). A script that asked (fromScript) plays to its end first. With raiseEvent
   * (the menu, --option=raise-event): GET OnGhostChanging [R0 next sakura name, R1 'manual' (menu, page API) |
   * 'automatic' (a script), R2 next name, R3 next path] (no BaseID; 204 -> OnClose [R0 'user']) replaces whatever
   * plays, and its script plays to its end; a balloon
   * break during it cancels the change [U-ss \![change,ghost]]. Each wait lasts until the ghost is quiet (a reply to a
   * click meanwhile plays to its end too), capped at changeWaitMs; a \- in it does not close the ghost. The menu closes
   * and stays shut, and Close / Iconify do nothing, until the change is over.
   * @param {{sakuraName?:string, name?:string, path?:string}} next
   * @returns {Promise<{ok:boolean, script:string}>} script: this ghost's script at the change (OnGhostChanged R1)
   */
  async farewell(next = {}, { reason = 'manual', raiseEvent = true, scope = 0, fromScript = false } = {}) {
    if (!this.booted || this.closed || this.changing || this.frozen) return { ok: false, script: '' };
    this.changing = true;
    if (this.menu && typeof this.menu.close === 'function') { try { this.menu.close({ restoreFocus: false }); } catch (e) { /* ignore */ } }
    const bye = { broken: false, breakable: false, run: fromScript ? this.current : null };
    this._farewell = bye;
    try {
      if (bye.run) await this._waitQuiet(bye);
      if (raiseEvent && !this.closed) {
        bye.breakable = true;
        const refs = [next.sakuraName || '', reason === 'automatic' ? 'automatic' : 'manual', next.name || '', next.path || ''];
        // ssp.exe 2.9.10 [disasm OnChangeMessage 0x4972c1–0x497366]: no BaseID (SenderType internal), and the 204
        // fallback OnClose carries R0 `user` alone
        let r = await this._fire('OnGhostChanging', refs, { origin: 'user' });
        if (!r.played && !this.closed && !bye.broken) r = await this._fire('OnClose', ['user'], { origin: 'user' });
        bye.run = r.played ? this.current : null;
        if (bye.run && !bye.broken) await this._waitQuiet(bye);
      }
    } finally {
      if (this._farewell === bye) this._farewell = null;
    }
    if (bye.broken || this.closed || this.frozen) {
      this.changing = false;
      return { ok: false, script: '' };
    }
    return { ok: true, script: bye.run ? bye.run.script : '' };
  }

  /** During farewell(): the script OnGhostChanged's R1 gets so far ('' before there is one); the page may go first. */
  changeScript() {
    const b = this._farewell;
    return b && b.run ? b.run.script : '';
  }

  /** Until this ghost stops talking (whichever run plays), a balloon break, destroy() or changeWaitMs (EV §2.5). */
  async _waitQuiet(bye) {
    const end = this.clock.now() + this.opts.changeWaitMs;
    let run = null;
    while (this._talking() && !this.closed && !this.frozen && !bye.broken && this.current && this.current !== run && this.current.finished) {
      run = this.current;
      const left = end - this.clock.now();
      if (left <= 0) return;
      let h = null;
      const cap = new Promise(r => { bye.wake = r; h = this.clock.setTimeout(r, left); });
      await Promise.race([run.finished, cap]).finally(() => { bye.wake = null; this.clock.clearTimeout(h); });
    }
  }

  /**
   * Ghost change: this ghost goes (EV §2.5). Everything stops, NOTIFY OnDestroy, the engine unloads (it saves) and the
   * state is saved without a run, timers or boxes: the next boot of this ghost is a cold one.
   */
  async leave() {
    this.changing = true;
    this.frozen = true;
    this._acceptDrops(false);
    this.stop();
    this._cancelPost();
    this._restoreAt = 0;          // the ghost exits: nothing pending [disasm ExitInstance 0x63f64f] (EV §3.4)
    this._clearTimers();
    this.http.invalidate();       // requests still running go on, unheard (EV §4.15)
    this._replyQueue = [];
    this._comm = null;            // the engine unloads: SSP's Unload clears the slot (EV §2.7.7)
    this._swap = null;
    this._shellFlag = false;
    this._wakeViewWait();
    for (const b of this.boxes.values()) { b.silent = true; this._closeDialog(b); }
    this.boxes.clear();
    this.choicesLive = false;
    this.minimized = null;
    try { if (this.player && this.player.busy) this.player.interrupt(); } catch (e) { /* ignore */ }
    if (this.shiori) {
      try { await this.shiori.request({ method: 'NOTIFY', id: 'OnDestroy', refs: [''], headers: {} }); } catch (e) { /* ignore */ }
      try { await this.shiori.unload(); } catch (e) { log.once('unload', 'engine unload failed', e); }
    }
    if (this.state) this.state.saveNow();
  }

  quit() { if (!this.changing) this._quit({ fromPlayer: true }); }

  vanish() { log.once('vanish', '\\![vanishbymyself] is ignored in the browser'); }

  /**
   * The value of a %-variable other than %property (properties.md §2.3; the expander asks %username of _username and
   * the word variables of word(), and doubles the backslashes of the names itself): null leaves it as written.
   * `username` here is the fallback only.
   */
  envVar(name) {
    const n = String(name || '').toLowerCase();
    const now = new Date(this.clock.now());
    const v = this._viewport();
    switch (n) {
      case 'username': return this._userFallback();
      case 'selfname': return this._charName(0);          // with the shell's override (EV §2.6)
      case 'selfname2': return this.descript.get('sakura.name2') || '';
      case 'keroname': return this._charName(1);
      case 'month': return String(now.getMonth() + 1);
      case 'day': return String(now.getDate());
      case 'hour': return String(now.getHours());
      case 'minute': return String(now.getMinutes());
      case 'second': return String(now.getSeconds());
      case 'screenwidth': return String(v.w);
      case 'screenheight': return String(v.h);
      case 'exh': return String(Math.floor((this.clock.now() - this.sessionEpochMs) / 3.6e6));
      case 'et': {
        // r = genrand(59787): r mod 1000, then the unit r mod 5 picks, so the number decides it [disasm 0x6367D0–0x63681A]
        const r = randInt(this.random, 59787);
        return `${r % 1000}${ET_UNITS[r % 5]}`;
      }
      case 'wronghour': {
        // the hour 1 or 2 off (genrand(23) & 1, + 1), earlier when a second genrand(23) is even [disasm 0x63728A–0x6372D8]
        const off = (randInt(this.random, 23) & 1) + 1;
        const h = now.getHours() + 24 + (randInt(this.random, 23) & 1 ? off : -off);
        return String(h % 24);
      }
      case 'lastghostname': case 'lastobjectname': return '';
      default: return null;
    }
  }

  unknownTag(raw) { log.once(`tag:${raw}`, `unsupported tag ${raw}`); }

  // ---------------------------------------------------------------- boxes

  /**
   * Show a box and send its events once it is answered (EV §4.8, UI §6). `words` (teach box only): the words of its
   * 311/312 round so far (UI §6.3); null = opened by a script, which sends OnTeachStart.
   */
  async _runBox(kind, o, args, dueAt = 0, words = null) {
    if (!this.dialogs) { log.once('no-dialogs', 'input boxes are not available'); return; }
    const teach = kind === 'teachbox';
    if (teach && typeof this.dialogs.teachBox !== 'function') { log.once('no-teachbox', 'the teach box is not available'); return; }
    const key = kind === 'communicatebox' ? 'communicate' : teach ? 'teach' : `input:${o.id}`;
    const old = this.boxes.get(key);
    if (old) {
      old.silent = true;
      this._closeDialog(old);
    }
    const now = this.clock.now();
    const due = dueAt || (o.timeoutMs > 0 ? now + o.timeoutMs : 0);
    const rec = { key, kind, id: o.id, args: [...args].map(String), dueAt: due, silent: false };
    if (teach) rec.words = Array.isArray(words) ? words.map(String) : [];
    this.boxes.set(key, rec);
    if (this.state) this.state.change();
    // sent with the box already open (Status: opening(teach)); its reply plays [guess: GET, as ninix does]
    if (teach && words === null && !this.closed && !this.frozen) this._fire('OnTeachStart', [], { origin: 'user' });
    // the communicate box stays open after each message (SSP): every one is an OnCommunicate while it is open
    const onSend = text => {
      if (!rec.silent && !this.closed && !this.frozen && this.boxes.get(key) === rec) this._fire('OnCommunicate', ['user', String(text)], { kind: 'communicate-user' });
    };
    const balloon = o.balloon == null || o.balloon === '' ? undefined : Number(o.balloon);
    let r = null;
    try {
      r = kind === 'communicatebox'
        ? await this.dialogs.communicateBox({ scope: 0, defaultText: o.text, detailed: true, onSend })
        : teach ? await this.dialogs.teachBox({ scope: 0, title: o.title, defaultText: o.text, balloon })
          : await this.dialogs.inputBox({
            id: o.id, scope: 0, title: o.title, defaultText: o.text, timeoutMs: due ? Math.max(1, due - now) : 0,
            kind: INPUT_KINDS[kind], options: o.options, limit: o.limit, balloon,
          });
    } catch (e) {
      log.once('box-failed', 'input box failed', e);
    }
    // InputResult {text, timedOut, reason}; a plain string or null from simpler dialogs
    const obj = r && typeof r === 'object';
    const text = obj ? (r.text == null ? null : String(r.text)) : r == null ? null : String(r);
    const timedOut = obj && (!!r.timedOut || r.reason === 'timeout');
    if (obj && r.reason === 'closed') rec.silent = true;     // closed by a script or replaced: no event
    if (this.boxes.get(key) === rec) this.boxes.delete(key);
    if (this.state) this.state.change();
    if (rec.silent || this.closed || this.frozen) return;
    await this._boxResult(kind, o, text, timedOut, rec);
  }

  async _boxResult(kind, o, text, timedOut, rec = null) {
    if (kind === 'communicatebox') {
      if (text == null) await this._fire('OnCommunicateInputCancel', ['', 'cancel']);
      else await this._fire('OnCommunicate', ['user', text], { kind: 'communicate-user' });
      return;
    }
    if (kind === 'teachbox') { await this._teachResult(o, text, rec); return; }
    if (text != null) {
      if (o.id.startsWith('On')) await this._fire(o.id, [text, '', ...o.refs]);
      else await this._fire('OnUserInput', [o.id, text, '', ...o.refs]);
    } else if (timedOut) {
      const r = await this._fire('OnUserInputCancel', [o.id, 'timeout']);
      if (!r.played) await this._fire('OnUserInput', [o.id, 'timeout']);   // compatibility rule (EV §1.9)
    } else {
      await this._fire('OnUserInputCancel', [o.id, 'close']);
    }
  }

  /**
   * The teach box was answered (UI §6.3): × / Esc -> GET OnTeachInputCancel [R0 '', R1 'cancel']; a word -> GET OnTeach
   * [R0… the round's words, the newest last]. 311 Not Enough opens the box again for one more word, 312 Advice drops
   * the newest word first (EV §1.2); a Value with either plays as well [guess]. Any other answer ends the round.
   * The box reopens before the reply plays, so a \![close|open,teachbox] in the reply has the last word.
   */
  async _teachResult(o, text, rec) {
    if (text == null) { await this._fire('OnTeachInputCancel', ['', 'cancel']); return; }
    const words = [...((rec && rec.words) || []), text];
    const again = res => {
      if (!res || !TEACH_AGAIN.has(res.status) || this.closed || this.frozen || this.boxes.has('teach')) return;
      this._runBox('teachbox', o, rec ? rec.args : [], 0, res.status === 312 ? words.slice(0, -1) : words.slice());
    };
    await this._fire('OnTeach', words, { pick: teachValue, onResponse: again, kind: 'teach' });
  }

  _reopenBox(b) {
    if (!b || !b.kind) return;
    const kind = b.kind;
    const args = Array.isArray(b.args) ? b.args : [];
    const o = parseBoxArgs(kind, args);
    // a teach box comes back with its round's words and without a second OnTeachStart
    const words = kind === 'teachbox' ? (Array.isArray(b.words) ? b.words : []) : null;
    if (b.dueAt && b.dueAt <= this.clock.now()) {
      this._boxResult(kind, o, null, true, { words });   // it expired while the page was away
      return;
    }
    this._runBox(kind, o, args, b.dueAt || 0, words);
  }

  // ---------------------------------------------------------------- choices and anchors (EV §4.7, SS §5.6.2)

  /**
   * A choice or anchor was clicked (UI §4.5). A choice stops the script and cancels the choice timeout, but the
   * balloons stay up until the selection is answered: most of Tsubasa's replies start with `\C` and append to them
   * (game boards, the one-touch panel). They are closed here only when the selection plays nothing. Until the reply
   * starts, the old balloon is dead: further clicks on it are ignored. Anchors never stop the script.
   */
  async _onLink(info) {
    if (!info || typeof info !== 'object' || this.closed || this.frozen) return;
    if (this._linkSeen.has(info)) return;   // the player and the balloons may both report the same click
    this._linkSeen.add(info);
    if (this._choicePending()) return;
    const now = this.clock.now();
    const sig = `${info.kind}\x00${info.id}\x00${info.scope}`;
    if (this._lastLink && this._lastLink.sig === sig && now - this._lastLink.at < 50) return;
    this._lastLink = { sig, at: now };
    // every click on an item first lets it go: NOTIFY OnChoiceEnter without References, for anchors too
    // (CMessageWnd::EX_OnLButtonUp [disasm 0x470905], EV §4.7)
    this._request('OnChoiceEnter', [], { method: 'NOTIFY' });

    const kind = info.kind === 'anchor' ? 'anchor' : 'choice';
    const id = info.id == null ? '' : String(info.id);
    const refs = (info.refs || []).map(r => (r == null ? '' : String(r)));
    const label = info.label == null ? '' : String(info.label);
    this._activate(info.scope);
    let wait = null;
    if (kind === 'choice') {
      this._cancelPost();
      this.choicesLive = false;
      try { if (this.player && this.player.busy) this.player.interrupt(); } catch (e) { /* ignore */ }
      wait = { gen: this.gen };
      this._choiceWait = wait;
      if (this.state) this.state.change();
    }
    let played = false;
    try {
      played = await this._select(kind, id, refs, label, info);
    } finally {
      if (this._choiceWait === wait) this._choiceWait = null;
    }
    // no reply, and no other run took the balloons meanwhile: close them (a URL choice too)
    if (wait && !played && wait.gen === this.gen && !this.closed) this._hideBalloons();
    // a choice picked on the close script that plays nothing: the close is decided now (_onRunEnd waited for it)
    if (wait && !played && wait.gen === this.gen && this._closeDue() && !this._talking()) {
      if (this.closing === 'all') { await this._quit({ fromPlayer: true }); return; }
      this.closing = false;
    }
    // a reply queued behind the interrupted script (_onRunEnd waited for this selection's reply)
    if (wait && !played && this._replyQueue.length && !this.closed && !this._talking()) this._playQueued();
  }

  /** Route a selection (SS §5.6.2, EV §4.7). @returns {Promise<boolean>} true when a script started */
  async _select(kind, id, refs, label, info) {
    const script = typeof info.script === 'string' ? info.script : id.startsWith('script:') ? id.slice(7) : null;
    // expanded, never translated (EV §4.12, properties.md §2.1)
    if (script !== null) {
      return !!(await andThen(this.expand(script), s => this._play(s, { event: 'script:', origin: 'user' })));
    }
    if (/^https?:\/\//i.test(id)) { this.openUrl(id); return false; }
    if (id.startsWith('On')) return (await this._fire(id, refs, { senderType: 'internal,raise' })).played;
    const ex = kind === 'anchor' ? 'OnAnchorSelectEx' : 'OnChoiceSelectEx';
    const plain = kind === 'anchor' ? 'OnAnchorSelect' : 'OnChoiceSelect';
    if ((await this._fire(ex, [label, id, ...refs])).played) return true;
    return (await this._fire(plain, [id])).played;
  }

  async _onBalloonDblClick(ev) {
    if (!this.booted || this.closed || this.ghostLife.passive || this._timeCritical()) return;
    // the second click of a double-click on a choice already selected it; its reply decides what the balloon shows
    if (this._choicePending() || (this._lastLink && this.clock.now() - this._lastLink.at < 600)) return;
    const scope = ev.scope | 0;
    const run = this.current;
    if (this._talking()) {
      // script break (SSP default double-click action); R2 = the player's source offset of the current token (tags
      // included, EV §4.9). Read before interrupt(); ScriptPlayer.position stays valid after it as well.
      let pos = 0;
      try { const p = Number(this.player.position); if (Number.isFinite(p) && p > 0) pos = Math.floor(p); } catch (e) { /* ignore */ }
      // cancels a ghost change (OnGhostChanging's talk, EV §2.5) or a shell change (OnShellChanging's, EV §2.6)
      for (const w of [this._farewell, this._viewWait]) if (w && w.breakable) w.broken = true;
      // the broken run stamps OnSurfaceRestore at its end when it had shown something (_stampRestore, EV §3.4)
      try { this.player.interrupt(); } catch (e) { /* ignore */ }
      this._cancelPost();
      this._hideBalloons();
      await this._fire('OnBalloonBreak', [run ? run.script : '', scope, pos]);
    } else if (!this._choosing()) {
      // a pending OnSurfaceRestore stays pending (EV §3.4) [disasm: BalloonClose touches neither field]
      this._cancelPost();
      this._hideBalloons();
      await this._fire('OnBalloonClose', [run ? run.script : '']);
    }
  }

  // ---------------------------------------------------------------- hover and tooltips (UI §4.8, EV §4.3, §4.7)

  /**
   * Hover events and tooltip texts go out only from a live loop: booted, not closed, frozen (another tab leads,
   * suspended, destroyed), swapping shells or minimized, and not while a picked choice's reply is on its way (in SSP
   * the click holds the UI until the ghost has answered, so nothing hovers in between).
   */
  _hoverLive() {
    return this.booted && !this.closed && !this.frozen && !this._swap && !this.minimized && !this._choicePending();
  }

  /**
   * The balloons' selected item changed ('select', UpdateSelection [disasm 0x470350]): entering an item is GET
   * OnChoiceEnter / OnAnchorEnter [R0 text, R1 ID, R2… args], whose reply plays like a click's (it replaces the
   * running script, a menu too, as SSP's PlayScriptWithMsg does [disasm]); leaving one is OnChoiceEnter without
   * References (never OnAnchorEnter): NOTIFY, sent first, when the pointer went straight to another item, GET (its
   * reply plays) when it went to empty balloon space, NOTIFY at a choice timeout (cause 'timeout'). Leaving the balloon
   * window sends nothing; the item stays selected. Touch never selects (no hover) [decision].
   * @param {{scope:number, index:number, prev:number, cause:'move'|'timeout', info:object|null}} ev
   */
  _onSelect(ev) {
    if (!ev || !this._hoverLive()) return;
    if (ev.cause === 'timeout') { this._request('OnChoiceEnter', [], { method: 'NOTIFY' }); return; }
    const item = ev.index >= 0 ? ev.info : null;
    if (item) {
      if (ev.prev >= 0) this._request('OnChoiceEnter', [], { method: 'NOTIFY' });
      this._fire(item.kind === 'anchor' ? 'OnAnchorEnter' : 'OnChoiceEnter', hoverRefs(item));
    } else if (ev.prev >= 0) this._fire('OnChoiceEnter', []);
  }

  /**
   * A balloon item's tooltip (CMessageWnd::ToolTipDispInfo [disasm 0x472060]), asked by the view once per entry when
   * the pointer rests on the item: GET OnChoiceHover / OnAnchorHover (its reply plays, as OnChoiceEnter's), then GET
   * balloon_tooltip with the same References (GetStringShiori [disasm 0x47342D]; _getString, resourceOf). -> the text
   * to show (tipText), null for none, undefined when not asked (the loop is not live).
   * @param {{kind:string, id:string, refs:string[], label:string}} item
   */
  async _balloonTip(item) {
    if (!item || !this._hoverLive()) return undefined;
    const refs = hoverRefs(item);
    await this._fire(item.kind === 'anchor' ? 'OnAnchorHover' : 'OnChoiceHover', refs);
    if (!this._hoverLive()) return undefined;
    const v = resourceOf(await this._getString('balloon_tooltip', refs));
    return v === null ? null : tipText(v);
  }

  /**
   * A character's collision tooltip (CCharWndCode::ToolTipDispInfo [disasm 0x41fa90]), asked by the view when the
   * pointer rests on a named collision: a `fresh` rest (another collision than the last one asked) first sends GET
   * OnMouseHover with the mouse References (its reply plays; not inside \t, SSP's IsNoInterrupt), its only sender in
   * SSP. The text: the shell's own `<scope>.tooltips` line (SH §2.16: it wins over the ghost, which is then not asked),
   * else GET tooltip [R0 x, R1 y (surface px), R2 0, R3 scope, R4 collision, R5 0] (SPGhost::GetString →
   * GetStringShiori [disasm 0x41FCF3]; _getString, resourceOf; the shell's own text is not decoded). -> text | null |
   * undefined.
   * (SSP's property override currentghost.seriko.tooltip.* comes first there; Sumika does not set it yet:
   * properties.md §6.)
   * @param {{scope:number, collision:string, x:number, y:number, fresh:boolean, device?:string}} req
   */
  async _shellTip(req) {
    if (!req || !req.collision || !this._hoverLive()) return undefined;
    const scope = req.scope | 0, collision = String(req.collision);
    if (req.fresh && !this._timeCritical()) {
      await this._mouse('OnMouseHover', { ...req, type: 'hover', scope, collision }, 0);
      if (!this._hoverLive()) return undefined;
    }
    let own = null;
    try {
      const sh = this.stage && this.stage.shell;
      own = sh && typeof sh.tooltip === 'function' ? sh.tooltip(scope, collision) : null;
    } catch (e) { own = null; }
    if (own) return tipText(own);
    const v = resourceOf(await this._getString('tooltip', [Math.floor(+req.x || 0), Math.floor(+req.y || 0), 0, scope, collision, 0]));
    return v === null ? null : tipText(v);
  }

  // ---------------------------------------------------------------- mouse (EV §4.1–4.5.1, C10, C11, C26, C31)

  _btn(info) {
    const b = info.button;
    if (b === 'middle' || b === 2) return 2;
    if (b === 1 || b === 'right') return 1;
    if (b === 3 || b === 'xbutton1') return 'xbutton1';
    if (b === 4 || b === 'xbutton2') return 'xbutton2';
    return info.altKey ? 2 : 0;     // Alt + left click = middle click (EV §4.2; the shell's views do this already)
  }

  _mouse(id, info, r5) { return this._fire(id, mouseRefs(info, r5)); }

  _onMouse(info) {
    if (!info || !this.booted || this.closed || this.frozen) return;
    if (this._timeCritical()) return;                    // C7: \t drops mouse events
    switch (info.type) {
      case 'move': this._mouseMove(info); return;
      case 'wheel': this._mouse('OnMouseWheel', info, 0); return;
      case 'enterall': this._mouse('OnMouseEnterAll', info, 0); return;
      case 'leaveall': this._mouse('OnMouseLeaveAll', info, 0); return;
      case 'enter': this._mouse('OnMouseEnter', info, 0); return;     // collision changes (EV §4.3)
      case 'leave': this._mouse('OnMouseLeave', info, 0); return;
      // OnMouseHover goes with the tooltip's text (_shellTip): the views emit no 'hover' as MouseInfo
      case 'down': case 'dblclick': case 'up': case 'click': case 'dragstart': case 'dragend': break;
      case 'gesture': case 'gesturestep': break;                       // a right drag's, between its Down and Up
      default: return;
    }
    // Button events are handled one after another: OnMouseClick is only sent when OnMouseUp returned nothing,
    // and must still reach the engine before a following OnMouseDoubleClick (EV §4.2, [L 3948]).
    if (info.type === 'down' || info.type === 'dblclick') {
      this._activate(info.scope);
      this.press = { scope: info.scope, button: this._btn(info), upResult: null, clickSeen: false, dragged: false,
        wheelRun: null };
    }
    const press = this.press;
    if (press && info.type === 'click') press.clickSeen = true;
    if (press && info.type === 'dragstart') press.dragged = true;
    this._mouseQueue = (this._mouseQueue || Promise.resolve())
      .then(() => this._mouseButton(info, press))
      .catch(e => log.once('mouse-chain', 'mouse event failed', e));
  }

  async _mouseButton(info, press) {
    if (this.closed || this.frozen) return;
    const b = press && info.type !== 'dragstart' && info.type !== 'dragend' ? press.button : this._btn(info);
    switch (info.type) {
      case 'down':
        if (b === 2) { if (!(await this._mouse('OnMouseDownEx', info, 'middle')).played) await this._mouse('OnMouseDown', info, 2); }
        else if (typeof b === 'string') await this._mouse('OnMouseDownEx', info, b);
        else await this._mouse('OnMouseDown', info, b);
        return;
      case 'dblclick':
        if (b === 2 || typeof b === 'string') await this._mouse('OnMouseDoubleClickEx', info, b === 2 ? 'middle' : b);
        else await this._mouse('OnMouseDoubleClick', info, b);
        return;
      case 'up': {
        const p = press || { clickSeen: false, dragged: false };
        // views flag 'up' with click:true when a 'click' follows (src/shell/mouse.js); unknown -> look after a task
        const clickFollows = async () => {
          if (info.click === true || info.click === false) return info.click;
          await delay(this.clock, 0);
          return p.clickSeen;
        };
        if (b === 2) {
          // EV §4.2: UpEx -> ClickEx -> Up(2) -> Click(2); the click half runs on 'click'
          const r = await this._mouse('OnMouseUpEx', info, 'middle');
          p.upResult = r.played || (await clickFollows()) ? r : await this._mouse('OnMouseUp', info, 2);
        } else if (typeof b === 'string') {
          p.upResult = await this._mouse('OnMouseUpEx', info, b);
        } else {
          p.upResult = await this._mouse('OnMouseUp', info, b);
          // the menu needs the click half even if a view does not report clicks for the right button
          if (b === 1 && info.click !== false && !p.upResult.played && !p.dragged && !(await clickFollows())) {
            await this._mouseClick({ ...info, type: 'click' }, p, b);
          }
        }
        return;
      }
      case 'click':
        await this._mouseClick(info, press || { upResult: null }, b);
        return;
      case 'dragstart':
      case 'dragend':
        if (!this.ghostLife.passive) await this._mouse(info.type === 'dragstart' ? 'OnMouseDragStart' : 'OnMouseDragEnd', info, b === 1 ? 1 : 0);
        if (info.type === 'dragend' && this.state) this.state.change();
        return;
      case 'gesture': {
        // GET OnMouseGesture, its reply plays (EV §4.5.1) [disasm SendGestureEvent 0x418850, OnNotifyEvent]. Touch: an
        // up or down gesture whose reply had no Value turns the run into the wheel, 3 notches at the press point now
        // and one per further step of that run [disasm OnEXMouseMove 0x417fac–0x41802c]
        const r = await this._fire('OnMouseGesture', gestureRefs(info));
        if (info.device === 'touch' && press && (info.dir === 1 || info.dir === 5) && !r.value) {
          for (let i = 0; i < 3; i++) await this._gestureWheel(info);
          press.wheelRun = info.run;
        }
        return;
      }
      case 'gesturestep':
        if (press && press.wheelRun === info.run) await this._gestureWheel(info);
        return;
      default:
    }
  }

  /**
   * The touch gestures' wheel stand-in (EV §4.5.1): GET OnMouseWheel at the press point and its collision, ±120 by the
   * step's direction (OnEXMouseWheel with the press point, SSP's R2 then 120 each: a whole notch leaves nothing to
   * accumulate) [disasm 0x419590]; R6 is the press's device [decision: SSP's is resolved from the message's extra info].
   */
  _gestureWheel(info) {
    if (this.closed || this.frozen || this._timeCritical()) return null;
    return this._mouse('OnMouseWheel', {
      type: 'wheel', scope: info.scope, x: info.sx0, y: info.sy0, wheel: info.dir === 1 ? 120 : -120,
      collision: info.collision0, device: info.device,
    }, 0);
  }

  async _mouseClick(info, press, b) {
    if (press.upResult && press.upResult.played) return;
    if (b === 2) {
      if ((await this._mouse('OnMouseClickEx', info, 'middle')).played) return;
      if ((await this._mouse('OnMouseUp', info, 2)).played) return;
      await this._mouse('OnMouseClick', info, 2);
    } else if (typeof b === 'string') {
      await this._mouse('OnMouseClickEx', info, b);
    } else {
      const r = await this._mouse('OnMouseClick', info, b);
      if (b === 1 && !r.played && !this.closed && !this.changing) this._openMenu(info);   // C26; no menu while leaving (EV §2.5)
    }
  }

  _mouseMove(info) {
    if (this.moveInFlight) { this.moveQueued = info; return; }   // at most one OnMouseMove in flight
    this.moveInFlight = true;
    this._mouse('OnMouseMove', info, 0).finally(() => {
      this.moveInFlight = false;
      const q = this.moveQueued;
      this.moveQueued = null;
      if (q && !this.closed && !this._timeCritical()) this._mouseMove(q);
    });
  }

  _openMenu(info) {
    let x = info.clientX;
    let y = info.clientY;
    const lp = this.lastPointer;
    if ((!Number.isFinite(x) || !Number.isFinite(y)) && lp && this.clock.now() - lp.at < 2000) { x = lp.x; y = lp.y; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const r = this._rectOf(info.scope | 0);
      x = (r ? r.x : 0) + (Number(info.x) || 0);
      y = (r ? r.y : 0) + (Number(info.y) || 0);
    }
    const req = { scope: info.scope | 0, x, y };
    if (info.device === 'touch') req.device = 'touch';             // a long press: the menu's touch rows (UI §9.6)
    this.emit('menu', req);
    if (this.menu && typeof this.menu.open === 'function') {
      Promise.resolve(this.menu.open(req)).catch(e => log.error('menu failed', e));
    }
  }

  // ---------------------------------------------------------------- files dropped (EV §4.14, TS §3.4)

  /**
   * GET OnFileDrop2 [R0 paths joined by \x01, R1 scope, R2 MIME types joined by \x01] (UKADOC; SSP sends no legacy
   * OnFileDrop/OnFileDropEx/OnFileDropped). A user event: `\t` does not drop it (C7 drops only mouse and key events).
   * @param {{scope:number, files: File[]}} info stage 'drop'
   */
  _onDrop(info) {
    if (!info || !this.booted || this.closed || this.frozen) return;      // the runtime holds drops until boot
    const files = Array.isArray(info.files) ? info.files : [];
    let list = [];
    try {
      list = this.drops && typeof this.drops.add === 'function'
        ? this.drops.add(files)
        : files.filter(f => f && typeof f.name === 'string').map(f => ({ path: dropPath(f), type: mimeOf(f) }));
    } catch (e) {
      log.once('drop-add', 'dropped files could not be registered', e);
      return;
    }
    if (!list.length) return;
    this._activate(info.scope | 0);
    this._fire('OnFileDrop2', [list.map(f => f.path).join('\x01'), info.scope | 0, list.map(f => f.type || '').join('\x01')]);
  }

  /** Characters take file drags only while this loop receives them: booted, not closed or suspended. */
  _acceptDrops(on) {
    if (this.stage && typeof this.stage === 'object') this.stage.acceptsDrops = !!on;
  }

  // ---------------------------------------------------------------- keyboard (EV §4.6, UI §9.7)

  /** A press, a link, a drop: this ghost takes the keys ('activate': the site deactivates the others, EV §2.7). */
  _activate(scope) {
    this.active = true;
    if (Number.isInteger(scope)) this.activeScope = scope;
    this.emit('activate', { scope: this.activeScope });
  }

  _onKeyDown(e) {
    const code = e.code || e.key || '';
    const count = e.repeat && this.keyRepeat.has(code) ? this.keyRepeat.get(code) + 1 : 1;
    this.keyRepeat.set(code, count);
    if (!this.active || !this.booted || this.closed || this.frozen || this.minimized) return;
    // a carried character (Move character window) owns the keys: Escape cancels the carry, nothing reaches the ghost
    // and the ghost stays active (UI §2.11). Both are window capture listeners and this one runs first.
    if (this.stage && this.stage.carrying) return;
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey) return;
    // typing in a field (the page's, or our input / communicate box), or keys for our own menu: never the ghost's
    if (isEditable(keyTarget(e)) || insideRuntime(e)) return;
    if (this._timeCritical()) return;                    // C7: \t drops key events too
    const name = keyName(e, this.keyLayout);
    if (!name) return;
    const refs = [name, keyVk(e, name), count, this.activeScope, keyModifiers(e)];
    if (!/^(tab|escape|f\d+|shift-|control-|alt-)/.test(name)) {
      try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* ignore */ }
    }
    this._fire('OnKeyPress', refs);
    if (name === 'escape') this.active = false;
  }

  _onKeyUp(e) { this.keyRepeat.delete(e.code || e.key || ''); }

  // ---------------------------------------------------------------- surfaces and dress-up (EV §4.11)

  _surfaceOf(scope) {
    try {
      const c = this.stage.char(scope);
      return c && Number.isFinite(c.surfaceId) ? c.surfaceId : -1;
    } catch (e) {
      return -1;
    }
  }

  _scopesSorted() {
    let s = [];
    try { s = [...(this.stage.scopes || [])]; } catch (e) { s = []; }
    if (!s.includes(0)) s.push(0);
    if (!s.includes(1)) s.push(1);
    return s.map(Number).sort((a, b) => a - b);
  }

  _surfaceEvent(scope) {
    let w = 0;
    let h = 0;
    try { const r = this.stage.char(scope).rect; if (r) { w = r.width | 0; h = r.height | 0; } } catch (e) { /* ignore */ }
    return { scope, id: this._surfaceOf(scope), width: w, height: h };
  }

  _sendAllSurfaces() {
    this.pendingSurface.clear();
    for (const s of this._scopesSorted()) {
      let visible = false;
      try { const c = this.stage.char(s); visible = !!c && c.surfaceId >= 0 && (c.visible !== false || !!this.minimized); } catch (e) { /* ignore */ }
      if (!visible) continue;
      const ev = this._surfaceEvent(s);
      this._request('OnSurfaceChange', [this._surfaceOf(0), this._surfaceOf(1), `${s},${ev.id},${ev.width},${ev.height}`], { method: 'NOTIFY' });
    }
  }

  _onSurface(ev) {
    if (!ev) return;
    const scope = ev.scope | 0;
    if (this.minimized && ev.id >= 0) { try { this.stage.char(scope).hide(); } catch (e) { /* ignore */ } }
    if (this.state) this.state.change();
    if (!this.surfaceLive || this.closed || this.frozen) return;
    this.pendingSurface.set(scope, ev);
    queueMicrotask(() => this._flushSurfaces());
  }

  /** NOTIFY OnSurfaceChange for coalesced changes; runs before any other request so Satori sees them in order. */
  _flushSurfaces() {
    if (!this.pendingSurface.size) return;
    const list = [...this.pendingSurface.values()];
    this.pendingSurface.clear();
    const r0 = this._surfaceOf(0);
    const r1 = this._surfaceOf(1);
    for (const ev of list) {
      const cur = this._surfaceEvent(ev.scope | 0);
      const w = ev.width ?? cur.width;
      const h = ev.height ?? cur.height;
      const id = Number.isFinite(ev.id) ? ev.id : cur.id;
      this.shiori && this.shiori.request(this._withFmo({
        method: 'NOTIFY', id: 'OnSurfaceChange', refs: [r0, r1, `${ev.scope | 0},${id},${w | 0},${h | 0}`],
        headers: this._statusHeaders(),
      })).catch(() => {});
    }
  }

  _statusHeaders() {
    const s = this.statusHeader();
    return s ? { Status: s } : {};
  }

  _dressupRefs() {
    let info;
    try { info = typeof this.stage.dressupInfo === 'function' ? this.stage.dressupInfo() : []; } catch (e) { info = []; }
    if (Array.isArray(info)) return info;
    if (typeof info === 'string') return info ? info.split(/\r?\n/).filter(Boolean) : [];
    return [];
  }

  _onBind(ev) {
    if (!ev || ev.noEvent || ev.noevent || ev.silent || !this.surfaceLive) return;   // \![bind-noevent]
    const script = this._talking();
    const id = ev.id == null || ev.id === '' ? null : Number(ev.id);
    const c = {
      scope: ev.scope | 0, id: Number.isFinite(id) ? id : null, category: String(ev.category ?? ''), part: String(ev.part ?? ''),
      on: !!(ev.on === true || ev.on === 1 || ev.on === '1'), origin: ev.origin || (script ? 'script' : 'user'),
    };
    if (this.state) this.state.change();
    if (ev.origin === 'user') {
      // a Clothes/Dressup ▸ pick is applied and reported at once, even while a script plays [disasm] (EV §4.11)
      this._queueUserDressup(c);
      return;
    }
    this.pendingDressup.push(c);
    if (!script && !this._dressupScheduled) {
      // a dress-up change outside a script: report it right away
      this._dressupScheduled = true;
      queueMicrotask(() => { this._dressupScheduled = false; if (!this._talking()) this._flushDressup(true); });
    }
  }

  /**
   * One Clothes/Dressup ▸ block (`c` null: a block that changed no flag), reported in a microtask (_flushDressup
   * 'user'). The playing script's binds so far go out first, as NOTIFY: SSP applies and reports a script's lazy block
   * at its next text, so it never comes after a later pick [disasm] (EV §4.11).
   */
  _queueUserDressup(c) {
    if (this.pendingDressup.length) this._flushDressup(false);
    if (c) this.pendingUserDressup.push(c);
    this._userBlock = true;
    if (!this._userDressupScheduled) {
      this._userDressupScheduled = true;
      queueMicrotask(() => { this._userDressupScheduled = false; this._flushDressup(true, 'user'); });
    }
  }

  /**
   * One applied block's events (EV §4.11) [disasm]: the net changes, every "off" before every "on" (dressupChanges);
   * 1 to 99 of them: OnDressupChanged per change (NOTIFY, the last one GET when asGet), 100 or more: none; then
   * OnNotifyDressupInfo (GET when asGet and nothing played yet), also after a menu block that changed nothing (SSP
   * sends it after every applied block). `which`: the script's pending binds, or the menu's ('user': its replies play
   * like any user event's). Returns true when a reply started a new run. While its requests are on their way,
   * `_dressupFlushing` holds the block's end (_dressupReported).
   */
  _flushDressup(asGet, which = 'script') {
    const p = this._flushDressupNow(asGet, which);
    const done = p.then(() => {}, () => {});
    this._dressupFlushing = done;
    done.then(() => { if (this._dressupFlushing === done) this._dressupFlushing = null; });
    return p;
  }

  /**
   * Before a timer's event (\![timerraise] / \![timernotify]): the binds still pending go out first (NOTIFY), and a
   * dress-up report already on its way is waited for. SSP reports a script's lazy block at its next text or wait, and
   * its SHIORI calls return before its message loop fires a timer, so a timer set after a \![bind] always reaches the
   * ghost after that bind's OnNotifyDressupInfo [disasm]: Tsubasa's dress-up menu redraws itself 1 ms after a pick
   * (`\![timerraise,1,1,…]`) and frames the part that event told her she wears [observed: ssp.exe].
   */
  async _dressupReported() {
    if (this.pendingDressup.length) this._flushDressup(false);
    while (this._dressupFlushing) await this._dressupFlushing;
  }

  async _flushDressupNow(asGet, which) {
    const user = which === 'user';
    const raw = user ? this.pendingUserDressup : this.pendingDressup;
    const block = user && this._userBlock;
    if (user) { this.pendingUserDressup = []; this._userBlock = false; } else this.pendingDressup = [];
    if (!raw.length && !block) return false;
    const changes = dressupChanges(raw);
    const origin = user ? 'user' : 'dressup';
    const refsOf = c => [c.scope, c.part, c.on ? 1 : 0, c.category, c.origin];
    let played = false;
    if (changes.length > 0 && changes.length < DRESSUP_SKIP) {
      changes.forEach((c, i) => {
        if (asGet && i === changes.length - 1) return;
        this._request('OnDressupChanged', refsOf(c), { method: 'NOTIFY' });
      });
      if (asGet) played = (await this._fire('OnDressupChanged', refsOf(changes[changes.length - 1]), { origin })).played;
    }
    const refs = this._dressupRefs();
    if (asGet && !played) played = (await this._fire('OnNotifyDressupInfo', refs, { origin })).played;
    else this._request('OnNotifyDressupInfo', refs, { method: 'NOTIFY' });
    return played;
  }

  // ---------------------------------------------------------------- window state (EV §2.3, §2.4)

  /** Close every balloon. Choices that were on them are gone too, so they no longer block talk (cantalk). */
  _hideBalloons() {
    try { if (this.balloons) this.balloons.hideAll(); } catch (e) { /* ignore */ }
    if (this.choicesLive) {
      this.choicesLive = false;
      if (this.state) this.state.change();
    }
  }

  _visibleScopes() {
    return this._scopesSorted().filter(s => {
      try { const c = this.stage.char(s); return !!c && c.visible !== false && c.surfaceId >= 0; } catch (e) { return false; }
    });
  }

  _hideAll() {
    for (const s of this._scopesSorted()) { try { this.stage.char(s).hide(); } catch (e) { /* ignore */ } }
    this._hideBalloons();
  }

  /** Iconify: the ghost may talk first (OnWindowStateMinimize), then every window hides behind the launcher. */
  async minimize(reason = 'user') {
    if (this.minimized || this.minimizing || this.closed || this.changing || this.frozen || !this.booted) return;
    this.minimizing = true;
    try {
      const r = await this._fire('OnWindowStateMinimize', [reason], { origin: 'user' });
      if (r.played && this.current && this.current.finished) {
        await Promise.race([this.current.finished, delay(this.clock, this.opts.minimizeWaitMs)]);
      }
    } finally {
      this.minimizing = false;
    }
    if (this.closed || this.minimized) return;
    // the tray icon: a script's \![set,trayicon] one is what she shows while minimized (`icon`; the launcher takes
    // descript icon.minimize first), and the script's slot is cleared (ToggleMinimize's ReloadTrayIcon(NULL)), so a
    // restore shows the descript's icon again [disasm 0x499162, LoadTrayIcon 0x49e540–0x49e5c3] (UI §2.6)
    this.minimized = {
      reason: reason === 'script' ? 'script' : 'user', scopes: this._visibleScopes(),
      ...(this.trayIcon ? { icon: this.trayIcon } : {}),
    };
    this.trayIcon = null;
    this._cancelPost();
    this._hideAll();
    if (this.state) this.state.saveNow();
    this.emit('minimized', this.minimized);
  }

  /**
   * Launcher click: show the windows again and tell the ghost. Nothing while a close is under way (SSP's close is
   * synchronous, nothing comes between its events: EV §2.3).
   */
  async restore() {
    // not while a minimized close's events are on their way (that close ends in _quit); any other close may still
    // leave her standing (C22: a Close of one whose goodbye has no \-), so "Show" works then
    if (!this.minimized || this.closed || this._closeDropping || this.changing || this.frozen) return;
    const m = this.minimized;
    this.minimized = null;
    const scopes = m.scopes && m.scopes.length ? m.scopes : [0, 1];
    for (const s of scopes) { try { this.stage.char(s).show(); } catch (e) { /* ignore */ } }
    if (this.state) this.state.saveNow();
    this.emit('restored');
    await this._fire('OnWindowStateRestore', [m.reason || 'user'], { origin: 'user' });
  }

  /**
   * Menu Close, Quit (EV §2.3, §2.7). `all` (default: no other ghost on screen): Quit, or Close of the last ghost —
   * GET OnCloseAll [R0 `user`, R1 the menu's scope, R2 `window`: the clicked character's (default: the same; another
   * in a menu `popupmenu.type` redirected, UI §2.1 notes) [disasm 2.9.10 CCWC_OnCommand 0x41d503, SPShiori::OnGhostClose
   * 0x710754..0x7107a4]] BaseID OnClose, 204 -> GET OnClose (same refs), 204 -> the
   * ghost closes at once; a reply plays and the ghost closes when it ends, \- or not, or when the newest run that
   * replaced it ends (a click's reply) [disasm PlayScriptWithMsg(…, 0x3A); guess for replaced runs]; a minimized
   * ghost (or one minimizing: OnWindowStateMinimize's talk) and a locked one (\t, passive, induction: lockReason) get
   * the same events (OnClose alone for a Close of one), their reply dropped (no OnTranslate, nothing plays), and close
   * at once, \- or not [disasm CloseGhostProc 0x49676a–0x49677f -> 0x4969ef–0x496a1f]. Otherwise (Close while other
   * ghosts stay): GET OnClose only, no BaseID; 204 -> at once; a reply without \- leaves the ghost standing (C22)
   * [disasm: plain PlayScript].
   * close(s, {all: true}) during a Close turns it into a Quit's, without a new event [decision]. Nothing while
   * leaving (a ghost change), while a call or ghost change is under way (peers.busy(): SSP beeps while any ghost
   * loads [disasm OnMenuClose]), or before boot.
   */
  async close(scope = 0, { all, window = scope } = {}) {
    if (this.closed || this.changing || this.frozen || !this.booted) return;
    if (this.peers && typeof this.peers.busy === 'function' && this.peers.busy()) return;
    const onScreen = this.peers && typeof this.peers.count === 'function' ? this.peers.count() : 1;
    const quit = all === undefined ? !(onScreen > 1) : !!all;
    if (this.closing) {
      if (quit && this.closing === 'one') {
        this.closing = 'all';
        // its script already ended (broken) with nothing after it: no end is left to wait for
        if (!this._closeAsking && this._closeDue() && !this._talking() && !this._choicePending()) await this._quit();
      }
      return;
    }
    this.closing = quit ? 'all' : 'one';
    this._closeFrom = 0;
    this._closeAsking = true;
    const refs = ['user', scope, window];
    // minimized (SSP sets it as soon as OnWindowStateMinimize's talk is queued) or locked (IsLocked: \t, induction,
    // passive): the same events, the reply dropped, closed at once (EV §2.3) [disasm CloseGhostProc 0x49676a–0x49677f
    // -> OnGhostClose 0x496a0f, OnSSPSysMsgGhostClose 0x496a1f: no TranslateScript, no PlayScript]
    if (this.minimized || this.minimizing || this.lockReason) {
      this._closeDropping = true;
      try {
        const v = quit ? valueOf(await this._request('OnCloseAll', refs, { headers: { BaseID: 'OnClose' } })) : null;
        if (!v && !this.closed) await this._request('OnClose', refs);
      } finally {
        this._closeAsking = false;
        this._closeDropping = false;
      }
      await this._quit({ lastRun: true });
      return;
    }
    const onPlay = run => { this._closeFrom = run.gen; };
    let r = { played: false };
    try {
      if (quit) r = await this._fire('OnCloseAll', refs, { origin: 'user', baseId: 'OnClose', onPlay });
      if (!r.played && !this.closed) r = await this._fire('OnClose', refs, { origin: 'user', onPlay });
    } finally {
      this._closeAsking = false;
    }
    if (!r.played) { await this._quit(); return; }
    if (!this._closeFrom) this._closeFrom = this.gen + 1;     // held by a shell swap: the run that plays it
  }

  /** The close script's run, or a newer one, is the newest: its end decides the close (EV §2.3). */
  _closeDue() { return !!this.closing && !this.closed && this._closeFrom > 0 && this.gen >= this._closeFrom; }

  /**
   * A Quit was saying goodbye when the last page went (the Site's tab marker, EV §2.7.3): the resumed ghost goes on
   * closing as Quit's goodbye would, at the end of the replayed run (or of the newest one that replaced it), `\-` or not
   * (EV §2.3); with nothing playing, at once. Nothing before boot, once closing or closed, while leaving or frozen.
   */
  resumeClose() {
    if (!this.booted || this.closed || this.closing || this.changing || this.frozen) return undefined;
    this.closing = 'all';
    if (this.current && this._talking()) { this._closeFrom = this.current.gen; return undefined; }
    return this._quit();
  }

  /**
   * \- reached, a Quit's close script over, or nothing to say on close: OnDestroy, unload the engine, persist, hand
   * over to the launcher. Emits 'closed' {script}: the script the ghost closed with (OnOtherGhostClosed R1, EV §2.7);
   * '' when it closed without one (a 204: SSP's own terminate script is not the ghost's [decision]); a minimized or
   * locked close (`lastRun`): the last script it played (OnOtherGhostClosed R1 is SPGhost+0x1884, the Loop's last
   * script [disasm 0x46bcf7, 0x63b82d]).
   */
  async _quit({ fromPlayer = false, lastRun = false } = {}) {
    if (this.closed) return;
    const script = fromPlayer || lastRun ? this.lastScript : '';
    this.closed = true;
    this.closing = false;
    this._closeFrom = 0;
    this._acceptDrops(false);
    this.stop();
    this._cancelPost();
    this._restoreAt = 0;          // the ghost exits: nothing pending [disasm ExitInstance 0x63f64f] (EV §3.4)
    this._clearTimers();
    this.http.invalidate();       // requests still running go on, unheard (EV §4.15)
    this._replyQueue = [];
    this._comm = null;            // the engine unloads: SSP's Unload clears the slot (EV §2.7.7)
    this._swap = null;
    this._shellFlag = false;
    this._wakeViewWait();
    for (const b of this.boxes.values()) { b.silent = true; this._closeDialog(b); }
    this.boxes.clear();
    // the player stops by itself at \-; anything else still running is cut off here
    if (!fromPlayer) { try { if (this.player && this.player.busy) this.player.interrupt(); } catch (e) { /* ignore */ } }
    this._hideAll();
    if (this.shiori) {
      try { await this.shiori.request({ method: 'NOTIFY', id: 'OnDestroy', refs: [''], headers: {} }); } catch (e) { /* ignore */ }
      try { await this.shiori.unload(); } catch (e) { log.once('unload', 'engine unload failed', e); }
    }
    if (this.state) this.state.saveNow();
    this.emit('closed', { script });
  }

  /** Another tab takes the ghost over: save everything and go quiet (the runtime tears the rest down). */
  async suspend() {
    if (this.state) this.state.saveNow();
    this.stop();
    this._cancelPost();
    for (const t of this.timers.values()) this._disarm(t);
    this.frozen = true;
    this.http.invalidate();
    this._acceptDrops(false);
    this._replyQueue = [];
    this._swap = null;
    this._shellFlag = false;
    this._wakeViewWait();
    try { if (this.player && this.player.busy) this.player.interrupt(); } catch (e) { /* ignore */ }
    if (this.shiori && typeof this.shiori.persist === 'function') {
      try { await this.shiori.persist(); } catch (e) { /* best effort */ }
    }
  }
}

// Several ghosts on one page (EV §2.5 calling, UI §9.5 tabs): pure helpers for the Site (core/site.js) — the
// stored set and when the site counts as closed, \![call,ghost] targets, the targets of a ghost's talk to another
// (COMMUNICATE) and of \![raiseother], the References of the cross-ghost events, set diffs for frozen tabs, and the tab
// marker v2. No DOM; the one import is shells.js's name compare (pure, no imports of its own): site.js and runtime.js
// import this file, and chooseSet takes runtime.js chooseGhost as `fallback`, so there is no import cycle.
import { sameName } from './shells.js';

/** Ghosts on screen at once in one page by default: no cap, as in SSP [observed]; a site may set one (data-max-ghosts). */
export const MAX_GHOSTS = Infinity;

/** The lead lock (the tab that runs the set): GhostLock names an id starting with '/' `sumika/<rest>` (state.js). */
export const LEAD_ID = '/lead';

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const str = v => (v == null ? '' : String(v));
const U = undefined;     // a Reference that is not sent (shiori.js buildRequest skips undefined)

/** The non-empty strings of a list, first occurrence kept; anything but an array is empty. */
function uniqueIds(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const id of list) if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  return out;
}

function entryOf(index, id) {
  if (!index) return null;
  if (typeof index.ghost === 'function') return index.ghost(id) || null;
  return (Array.isArray(index.ghosts) ? index.ghosts : []).find(g => g && g.id === id) || null;
}

/**
 * The ghosts to put on screen, in set order: the runtime prefs' `ghosts` (SSP's settings key `Ghost` [disasm
 * SaveBootingGhostData]) minus ids the site no longer has or cannot run, without duplicates, at most `max`. Nothing
 * left, or no stored set (prefs from before sets existed): `[fallback()]` (runtime.js chooseGhost: the stored `ghost`,
 * the page's default, the first one), `[]` when it gives null.
 * A stored `ghost` other than `ghosts[0]` comes from code that knows one ghost only (a tab still on the older runtime
 * across a deploy, which ran the set's first ghost and changed it): it takes slot 0 [decision]. The Site always writes
 * `ghost` = `ghosts[0]` with the set.
 * @param {{ghosts: object[], ghost?: (id: string) => object|null}} index the site index (loader.js SiteIndex)
 * @param {{stored?: {ghost?: string, ghosts?: string[]}, supported?: (g: object) => boolean, max?: number,
 *          fallback?: () => object|null}} o stored: runtimePrefs.get()
 * @returns {object[]} index entries, set order
 */
export function chooseSet(index, { stored = {}, supported = () => true, max = MAX_GHOSTS, fallback = () => null } = {}) {
  const cap = Number(max) >= 1 ? Math.floor(Number(max)) : MAX_GHOSTS;
  const prefs = isObj(stored) ? stored : {};
  const out = [];
  if (Array.isArray(prefs.ghosts)) {
    let ids = prefs.ghosts;
    if (typeof prefs.ghost === 'string' && prefs.ghost && ids.length && ids[0] !== prefs.ghost) ids = [prefs.ghost, ...ids.slice(1)];
    for (const id of uniqueIds(ids)) {
      if (out.length >= cap) break;
      const g = entryOf(index, id);
      if (g && supported(g)) out.push(g);
    }
  }
  if (out.length) return out;
  const g = fallback();
  return g ? [g] : [];
}

/**
 * The site counts as closed (the next page shows the closed launcher) when every ghost of the stored set is closed
 * (`closed` in its state, written at \-) [decision]. A ghost closed while others stay leaves the set at once, so a
 * closed member of a set that is not closed only means the page went in between: the Site drops it at the next start.
 * One ghost alone: the same rule.
 * @param {string[]} ids the stored set
 * @param {(id: string) => boolean} closedOf state.js storedClosed
 */
export function siteClosed(ids, closedOf) {
  const list = Array.isArray(ids) ? ids : [];
  return list.length > 0 && list.every(id => !!closedOf(id));
}

/**
 * The ghost a call brings (Call ghost ▸, \![call,ghost,…], the page API) [disasm GetGhostIDFromTag isCall=1,
 * SPGhostLoaderInfo::ProcessCallTarget]: byId = a folder id; 'random' = any site ghost not on screen that the runtime
 * can run; 'sequential' = the first such ghost after the caller in the site's list, wrapping; a target starting
 * 'lastinstall' = nothing (nothing is installed in a browser) [decision]; otherwise the caller's own descript name, any
 * ghost's descript name, the caller's own sakura name, any ghost's sakura name (SSP's order [disasm]), then the
 * folder id, then the descript name or id in any case [infer: runtime.js resolveGhostTarget]. A ghost on screen (the
 * caller too: IsGhostIDBooted), unknown, or whose engine is missing: null, the call is ignored. The cap is the Site's.
 * @param {object[]} ghosts the site's ghosts (index entries, site order)
 * @param {string|null} callerId
 * @param {string} target
 * @param {{byId?: boolean, onScreen?: Set<string>|string[], supported?: (g: object) => boolean,
 *          random?: () => number}} o onScreen: the ids of every ghost on screen
 * @returns {object|null}
 */
export function resolveCallTarget(ghosts, callerId, target, { byId = false, onScreen = new Set(), supported = () => true, random = Math.random } = {}) {
  const list = (Array.isArray(ghosts) ? ghosts : []).filter(g => g && typeof g.id === 'string');
  const shown = onScreen instanceof Set ? onScreen : new Set(Array.isArray(onScreen) ? onScreen : []);
  const free = g => g.id !== callerId && !shown.has(g.id) && supported(g);
  const pick = g => (g && free(g) ? g : null);
  const t = String(target ?? '').trim();
  if (byId) return pick(list.find(g => g.id === t));
  const key = t.toLowerCase();
  if (key === 'random') {
    const c = list.filter(free);
    return c.length ? c[Math.min(c.length - 1, Math.floor(random() * c.length))] : null;
  }
  if (key === 'sequential') {
    const i = list.findIndex(g => g.id === callerId);      // -1: from the top
    for (let n = 1; n <= list.length; n++) {
      const g = list[(i + n + list.length) % list.length];
      if (free(g)) return g;
    }
    return null;
  }
  if (!t || key.startsWith('lastinstall')) return null;
  const self = list.find(g => g.id === callerId) || null;
  return pick((self && self.name === t ? self : null)
    || list.find(g => g.name === t)
    || (self && self.sakuraName === t ? self : null)
    || list.find(g => g.sakuraName === t)
    || list.find(g => g.id === t)
    || list.find(g => str(g.name).toLowerCase() === key || g.id.toLowerCase() === key));
}

// ---- ghost-to-ghost talk and raised events (EV §2.7.7, §2.7.9) --------------------------------------------------

/** The whole target value that names every ghost (any case, nothing skipped) [disasm 0x70F77B, 0x731090]. */
export const ALL_GHOSTS = '__SYSTEM_ALL_GHOST__';

/** Without the characters SSP's `wcsicmp_printchar` skips: every one up to U+0020, and U+3000 [disasm 0x5ADF90]. */
const printed = s => str(s).replace(/[\x00-\x20　]/g, '');

/**
 * SSP's name match for ghosts on screen (`wcsicmp_printchar`, SPGhost::IsMatch) [disasm 0x5ADF90]: characters up to
 * U+0020 and U+3000 skipped anywhere in both strings, the rest compared case-folded with SSP's table (shells.js
 * sameName). No width or kana folding: `ａ` ≠ `a`, `あ` ≠ `ア`. So `琥珀 あかね` = `琥珀あかね`.
 */
export function sspNameEqual(a, b) {
  return sameName(printed(a), printed(b));
}

const withId = list => (Array.isArray(list) ? list : []).filter(p => p && typeof p.id === 'string' && p.id);

/**
 * The ghosts a response's `To` / `Reference0` names (COMMUNICATE, EV §2.7.7) [disasm SendCommunicate 0x70F77B,
 * FindOtherGhostHWnd 0x7340D0]: `__SYSTEM_ALL_GHOST__` as the whole value (any case) = every peer, in order; else each
 * `\x01` token (empty ones dropped) → the first peer whose sakura name in effect matches (sspNameEqual; never the
 * descript or kero name). Unmatched tokens vanish; a name given twice gives that ghost twice.
 * @param {{id: string, sakuraName?: string}[]} peers the other ghosts on screen (peerInfo()), the sender left out
 * @param {string} to
 * @returns {string[]} ghost ids
 */
export function communicateTargets(peers, to) {
  const list = withId(peers);
  const t = str(to);
  if (!t) return [];
  if (sameName(t, ALL_GHOSTS)) return list.map(p => p.id);
  const out = [];
  for (const name of t.split('\x01')) {
    if (!name) continue;
    const p = list.find(q => sspNameEqual(q.sakuraName, name));
    if (p) out.push(p.id);
  }
  return out;
}

/** A target naming the last installed ghost (`lastinstall…`, any case) [disasm 0x633A4D]; a browser installs none. */
export function isLastInstall(t) {
  return /^lastinstall/i.test(str(t));
}

/**
 * The ghosts a \![raiseother] / \![notifyother] (or a timer form) names (EV §2.7.9) [disasm ExecuteRaiseReal
 * 0x6338EA–0x633AE5, FindActiveGhostArrayFromName 0x731090, FindActiveGhostFromName 0x731310]: `random` (the whole
 * value, any case) = one candidate at random, the raiser possible; `lastinstall…` = none [decision: nothing is
 * installed in a browser]; `__SYSTEM_ALL_GHOST__` (whole, any case) = every candidate, the raiser included; else each
 * `\x01` token (empty ones dropped) → a descript name match over every candidate first (the first one), else a sakura
 * name match (an exact one, case folded, before one with spaces skipped: IsMatch's 103 over 101; the first one among
 * equals). Never the kero name; no de-duplication. The caller skips the raiser.
 * @param {{id: string, name?: string, sakuraName?: string}[]} cands the raiser and the ghosts it can reach, in order
 * @param {string} arg the ghost argument
 * @param {{random?: () => number}} o
 * @returns {string[]} ghost ids
 */
export function raiseTargets(cands, arg, { random = Math.random } = {}) {
  const list = withId(cands);
  const t = str(arg);
  if (sameName(t, 'random')) {
    return list.length ? [list[Math.min(list.length - 1, Math.floor(random() * list.length))].id] : [];
  }
  if (isLastInstall(t)) return [];
  if (sameName(t, ALL_GHOSTS)) return list.map(c => c.id);
  const out = [];
  for (const name of t.split('\x01')) {
    if (!name) continue;
    const c = list.find(x => sspNameEqual(x.name, name))
      || list.find(x => sameName(str(x.sakuraName), name))
      || list.find(x => sspNameEqual(x.sakuraName, name));
    if (c) out.push(c.id);
  }
  return out;
}

/** A surface id for `otherghostname`: a whole id >= 0, else -1 (no surface) [infer]. */
function surfaceRef(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/**
 * One Reference of NOTIFY otherghostname (EV §2.1 #16) [doc; disasm NotifyOtherGhost]: another ghost on screen as
 * `<sakura name in effect>\x01<scope 0 surface>\x01<scope 1 surface>`.
 * @param {{sakuraName?: string, surfaces?: number[]}} peer EventLoop peerInfo()
 */
export function otherGhostRef({ sakuraName, surfaces } = {}) {
  const s = Array.isArray(surfaces) ? surfaces : [];
  return `${str(sakuraName)}\x01${surfaceRef(s[0])}\x01${surfaceRef(s[1])}`;
}

/**
 * OnGhostCallComplete (to the caller) and OnOtherGhostBooted (to the others), after the new ghost's boot script
 * [doc; disasm msg 0x3D]: R0 its sakura name, R1 that script, R2 its descript name, R3–R6 not sent, R7 its shell name.
 * @param {{sakuraName?: string, script?: string, name?: string, shell?: string}} info
 */
export function afterBootRefs({ sakuraName, script, name, shell } = {}) {
  return [str(sakuraName), str(script), str(name), U, U, U, U, str(shell)];
}

/**
 * OnOtherGhostClosed, once a ghost closed while others stay [doc; disasm]: the afterBootRefs shape with the closed
 * ghost's last script.
 * @param {{sakuraName?: string, script?: string, name?: string, shell?: string}} info
 */
export function otherClosedRefs(info) {
  return afterBootRefs(info);
}

/**
 * OnOtherGhostChanged, to the others after the new ghost's boot script [doc; disasm msg 0x3E]: R0/R1 the old and new
 * sakura names, R2 the old ghost's farewell, R3 the new one's boot script, R4/R5 their descript names, R6–R13 not
 * sent, R14/R15 their shell names.
 * @param {{sakuraName?: string, script?: string, name?: string, shell?: string}} a the ghost that left
 * @param {{sakuraName?: string, script?: string, name?: string, shell?: string}} b the ghost that came
 */
export function otherChangedRefs(a = {}, b = {}) {
  return [str(a.sakuraName), str(b.sakuraName), str(a.script), str(b.script), str(a.name), str(b.name),
    U, U, U, U, U, U, U, U, str(a.shell), str(b.shell)];
}

/**
 * OnOtherGhostTalk, to a ghost that asked with \![set,otherghosttalk] [doc UKADOC:ev; disasm SPGhost::Loop]: R0 the
 * talker's descript name, R1 its sakura name, R2 the flags (a comma list: `break` after a run that did not reach its
 * end), R3 the event that made the script, R4 the script, R5 that event's References joined by \x01.
 * @param {{name?: string, sakuraName?: string}} talker
 * @param {{event?: string, script?: string, refs?: any[]}} run
 * @param {string|string[]} flags
 */
export function otherTalkRefs(talker = {}, run = {}, flags = '') {
  const f = Array.isArray(flags) ? flags.filter(Boolean).map(String).join(',') : str(flags);
  const refs = Array.isArray(run.refs) ? run.refs.map(str).join('\x01') : '';
  return [str(talker.name), str(talker.sakuraName), f, str(run.event), str(run.script), refs];
}

/**
 * What another tab's set message changed (a frozen tab reconciles its slots, UI §9.5): `replaced` = the same place
 * holds another ghost (a ghost change in that slot: neither id is in the other list); `gone` / `added` = the rest.
 * @param {string[]} prev
 * @param {string[]} next
 * @returns {{gone: string[], added: string[], replaced: Array<[string, string]>}}
 */
export function diffSets(prev, next) {
  const a = uniqueIds(prev);
  const b = uniqueIds(next);
  const replaced = [];
  const paired = new Set();
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i] || b.includes(a[i]) || a.includes(b[i])) continue;
    replaced.push([a[i], b[i]]);
    paired.add(a[i]).add(b[i]);
  }
  return {
    gone: a.filter(id => !b.includes(id) && !paired.has(id)),
    added: b.filter(id => !a.includes(id) && !paired.has(id)),
    replaced,
  };
}

/**
 * The ghosts a tab runs, from its marker (sessionStorage `sumika.session`, state.js sessionMarker): v2 `ghosts`, else
 * the v1 `ghost` (a marker written before sets existed).
 * @param {object|null} m sessionMarker.read()
 * @returns {string[]}
 */
export function markerGhosts(m) {
  if (!isObj(m)) return [];
  return uniqueIds(Array.isArray(m.ghosts) ? m.ghosts : [m.ghost]);
}

/**
 * A carry entry the next page must finish (EV §2.5): `change` (B has not sent OnGhostChanged), `call` (the callee has
 * not sent OnGhostCalled), `after` of 'call' / 'change' (OnGhostCallComplete / OnOtherGhostChanged still owed).
 */
function validCarry(e) {
  if (!isObj(e)) return false;
  if (e.kind === 'change') return true;
  if (e.kind === 'call') return isObj(e.call);
  return e.kind === 'after' && (e.of === 'call' || e.of === 'change');
}

/**
 * What the last page left unfinished, by ghost id: v2 `carry` (entries passed through as written, malformed ones
 * dropped), else the v1 `pending` change of `ghost` (a tab open across the deploy finishes its change).
 * @param {object|null} m sessionMarker.read()
 * @returns {Object<string, object>}
 */
export function markerCarry(m) {
  if (!isObj(m)) return {};
  if (isObj(m.carry)) {
    const out = {};
    for (const [id, e] of Object.entries(m.carry)) if (id && validCarry(e)) out[id] = e;
    return out;
  }
  if (m.pending === true && typeof m.ghost === 'string' && m.ghost) {
    return { [m.ghost]: { kind: 'change', change: isObj(m.change) ? m.change : null } };
  }
  return {};
}

/**
 * The tab marker to write (sessionMarker.write): v2 `ghosts` and `carry` plus the v1 mirror older code and
 * sessionMarker.read rely on — `ghost` = ghosts[0], and `pending` / `change` only when ghosts[0] carries a change. For
 * one ghost without a carry the v1 fields are exactly the single-ghost runtime's. Carries of ids outside the set are
 * dropped; `carry` is left out when empty. An empty set makes a marker sessionMarker.read rejects (clear it instead).
 * `quit`: a Quit is saying goodbye (EV §2.7.3; the next page goes on with it, markerQuit); left out when false.
 * @param {{ghosts?: string[], sessionEpochMs?: number, carry?: Object<string, object>, quit?: boolean}} o
 */
export function markerRecord({ ghosts = [], sessionEpochMs, carry = {}, quit = false } = {}) {
  const ids = uniqueIds(ghosts);
  const kept = {};
  if (isObj(carry)) for (const [id, e] of Object.entries(carry)) if (ids.includes(id) && validCarry(e)) kept[id] = e;
  const m = { booted: true, ghost: ids[0], sessionEpochMs };
  const first = kept[ids[0]];
  if (first && first.kind === 'change') { m.pending = true; m.change = isObj(first.change) ? first.change : null; }
  m.ghosts = ids;
  if (Object.keys(kept).length) m.carry = kept;
  if (quit) m.quit = true;
  return m;
}

/** The marker says a Quit was saying goodbye when the page went (markerRecord `quit`): only `quit: true`. */
export function markerQuit(m) {
  return isObj(m) && m.quit === true;
}

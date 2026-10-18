// The version of each kind of record a visitor's browser keeps (safe updates: CLAUDE.md "Version marks"). One mark per
// record kind, and one hook on each kind's single read path: a reader passes the record through upgrade() before it
// reads a field. Bump a kind only for a change an older reader would misread or an older writer would damage; an
// additive field needs none, since every writer keeps the fields it does not know. A key's encoding never changes (JSON
// in localStorage, structured clone in IndexedDB): a new encoding, or a shape old code would damage, takes a new key.
// A bump is one-way: tools/build.mjs records SCHEMA in sumika/build.json and refuses to build a lower one (CLAUDE.md
// "The rollback rule").
//   state   localStorage sumika:ghost:<id>:state, `v` (state.js STATE_VERSION)
//   prefs   localStorage sumika:runtime, `v` in storage only (runtimePrefs.get hides it)
//   marker  sessionStorage sumika.session, `v` (unmarked: 2 with a `ghosts` array, else 1); read() hides it
//   files   IndexedDB kv ghost:<id>:files: the key is the version (a future shape takes ghost:<id>:files.v2; a mark in
//           the record would be mounted as a file by older workers)
//   drops   IndexedDB kv drop:index `v` (drops.js)
//   choice  localStorage sumika:choice, `v` (choice.js: the visitor's On / Off, written by the control page alone,
//           src/control/; a key of its own: no page's write of the prefs races it, and "Site default" is no record)
// Not versioned: sumika.lastInputMs (a bare number), the cross-tab messages (additive fields; an incompatible one takes
// a new `t`), IndexedDB's DB_VERSION (frozen at 1: an upgrade is blocked by open old tabs, storage.js).
import { markerGhosts, markerCarry } from './ghostset.js';

export const SCHEMA = Object.freeze({ state: 1, prefs: 1, marker: 2, files: 1, drops: 1, choice: 1 });

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * The tab marker v1 (one ghost: `ghost`, `pending`, `change`) as v2: `ghosts` and `carry` built by the readers that
 * already understood v1 (ghostset.js markerGhosts, markerCarry); the v1 fields stay for older code.
 */
export function markerV1toV2(m) {
  if (!isObj(m)) return m;
  const out = { ...m, ghosts: markerGhosts(m) };
  const carry = markerCarry(m);
  if (Object.keys(carry).length) out.carry = carry;
  return out;
}

/** Each kind's steps: STEPS[kind][n] takes a record from version n to n + 1. No migration is needed yet but the marker's. */
export const STEPS = Object.freeze({ state: {}, prefs: {}, marker: { 1: markerV1toV2 }, files: {}, drops: {}, choice: {} });

/** A record's version mark: a whole number from 1 up; anything else (none, 0, text) counts as 1. */
export function versionOf(v) {
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

/**
 * A stored record brought to this runtime's version of its kind, before any field is read. An older one runs the
 * steps in order (in memory: the next write stores the current shape), and an object record that moved up gets `v` =
 * the version reached, so a second pass (StateStore.reload, then normalizeState) runs no step again; a newer one is
 * left as it is, `newer`: read what fits, and per kind never write or clear it, and staleCheck (site.js)
 * may find a newer Sumika.
 * @param {string} kind a SCHEMA key
 * @param {*} rec the stored record
 * @param {*} v its mark (versionOf)
 * @param {Object<number, Function>} [steps]
 * @param {number} [to] the version to reach (tests)
 * @returns {{rec: *, v: number, newer: boolean}}
 */
export function upgrade(kind, rec, v, steps = STEPS[kind] || {}, to = SCHEMA[kind] || 1) {
  let n = versionOf(v);
  if (n > to) return { rec, v: n, newer: true };
  let out = rec;
  const from = n;
  for (; n < to; n++) if (typeof steps[n] === 'function') out = steps[n](out);
  if (n > from && isObj(out)) out = { ...out, v: n };
  return { rec: out, v: n, newer: false };
}

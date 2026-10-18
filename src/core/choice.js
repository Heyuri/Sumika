// Whether Sumika runs on a page [decision: On, Off and Site default only; docs/guide.md "Turning Sumika on or off"]:
// the site's default (the script tag's data-default-state) and the visitor's own choice for their browser, set on the
// control page (sumika/index.html, src/control/). One module for the key, its values and its reading and writing,
// shared by the runtime (main.js) and the control page, so the two always agree. Pure: no DOM, no global storage (the
// caller passes the Storage: main.js the runtime's own, with data-hub the storage hub's mirror; the control page its
// origin's localStorage, which is the hub's data on the Sumika host).
//   The record: localStorage `sumika:choice` = JSON {choice: 'on' | 'off', v} (schema.js SCHEMA.choice); none = "Site
//   default". A `sumika:` key, so the hub carries it like the runtime's other keys; read only by main.js before
//   anything of Sumika is made, written only by the control page.
//   The order main.js decides in: data-phone="off" on a phone -> a browser that cannot run Sumika -> the visitor's
//   choice -> data-default-state (startState).
import { log } from './log.js';
import { SCHEMA, upgrade } from './schema.js';

/** localStorage: the visitor's choice for this browser (control page). */
export const CHOICE_KEY = 'sumika:choice';
/** What a stored record can hold; no record is "Site default". */
export const CHOICES = Object.freeze(['on', 'off']);
/** data-default-state's values, the first one the default: what a visitor who made no choice gets. */
export const DEFAULT_STATES = Object.freeze(['enabled', 'tucked', 'off']);

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * data-default-state of the script tag: 'enabled' (absent, empty or an unknown value: the ghost as usual), 'tucked'
 * (the set starts as her button, on every device: Site `tucked`, UI §9.11) or 'off' (nothing unless the visitor turned
 * Sumika on). Values in any case, trimmed; an unknown one warns once (main.js reads it once per page), as data-phone
 * does.
 * @param {{defaultState?: string}} dataset the script tag's
 * @param {(msg: string) => void} [warn]
 * @returns {'enabled'|'tucked'|'off'}
 */
export function defaultState(dataset, warn = m => log.warn(m)) {
  const d = dataset || {};
  if (d.defaultState === undefined || d.defaultState === null) return 'enabled';
  const v = String(d.defaultState).trim().toLowerCase();
  if (DEFAULT_STATES.includes(v)) return v;
  if (v !== '') warn(`data-default-state="${d.defaultState}" is not enabled, tucked or off; Sumika runs as with "enabled"`);
  return 'enabled';
}

/**
 * A stored record read (schema.js upgrade before any field): {choice: 'on' | 'off' | null, newer, rec}. null: no record,
 * no JSON, or no choice in it ("Site default"). A record a newer page wrote is read for what fits (`newer`: the
 * control page never writes over it).
 * @param {string|null} text the stored value
 */
export function parseChoice(text) {
  let raw = null;
  try {
    raw = text == null ? null : JSON.parse(text);
  } catch (e) {
    raw = null;
  }
  if (!isObj(raw)) return { choice: null, newer: false, rec: null };
  const up = upgrade('choice', raw, raw.v);
  const rec = isObj(up.rec) ? up.rec : {};
  return { choice: CHOICES.includes(rec.choice) ? rec.choice : null, newer: up.newer, rec };
}

/**
 * The choice stored in `storage`: parseChoice's answer plus `blocked` (no storage, or reading it throws: a browser that
 * blocks this site's storage; the choice is then null, the site's default). Reads one key, writes nothing.
 * @param {Storage|null} storage
 * @returns {{choice: 'on'|'off'|null, newer: boolean, blocked: boolean}}
 */
export function readChoice(storage) {
  let text;
  try {
    if (!storage) return { choice: null, newer: false, blocked: true };
    text = storage.getItem(CHOICE_KEY);
  } catch (e) {
    return { choice: null, newer: false, blocked: true };
  }
  const r = parseChoice(text);
  return { choice: r.choice, newer: r.newer, blocked: false };
}

/**
 * The control page's save: 'on' or 'off' stored (the fields a later writer of this version added kept), null removes
 * the record ("Site default"). 'saved'; 'newer' (a newer page's record: never written or cleared, schema.js);
 * 'failed' (the storage refused: blocked, full). Never throws for a valid choice.
 * @param {Storage|null} storage
 * @param {'on'|'off'|null} choice
 * @returns {'saved'|'newer'|'failed'}
 */
export function saveChoice(storage, choice) {
  if (choice !== null && !CHOICES.includes(choice)) throw new TypeError(`no such choice: ${choice}`);
  try {
    const cur = parseChoice(storage.getItem(CHOICE_KEY));
    if (cur.newer) return 'newer';
    if (choice === null) storage.removeItem(CHOICE_KEY);
    else storage.setItem(CHOICE_KEY, JSON.stringify({ ...(cur.rec || {}), choice, v: SCHEMA.choice }));
    return 'saved';
  } catch (e) {
    return 'failed';
  }
}

/**
 * What the page starts as, after data-phone="off" and the browser check (main.js): the visitor's choice, else the
 * site's default. {state, reason}: state 'off' (the visitor's Off; or the site's "off" with no choice), 'tucked' (the
 * set starts as her button: the site's "tucked" with no choice, or data-phone="tucked" on a phone, the site's layout
 * for phones, kept under On) or 'enabled'; reason 'visitor' (a choice is stored) or 'site'. On runs as "enabled"
 * whatever the site's default.
 * @param {'on'|'off'|null} choice readChoice's
 * @param {'enabled'|'tucked'|'off'} siteDefault defaultState's
 * @param {null|'on'|'tucked'} [phoneMode] main.js's mode (null: no phone)
 * @returns {{state: 'enabled'|'tucked'|'off', reason: 'visitor'|'site'}}
 */
export function startState(choice, siteDefault, phoneMode = null) {
  const reason = choice === 'on' || choice === 'off' ? 'visitor' : 'site';
  if (choice === 'off') return { state: 'off', reason };
  const base = choice === 'on' ? 'enabled' : DEFAULT_STATES.includes(siteDefault) ? siteDefault : 'enabled';
  if (base === 'off') return { state: 'off', reason };
  return { state: base === 'tucked' || phoneMode === 'tucked' ? 'tucked' : 'enabled', reason };
}

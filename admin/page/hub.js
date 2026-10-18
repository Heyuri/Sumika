// The Sharing screen's logic: each address row of sumika/hub.json judged as the admin
// types, by the program's own classifier of the publish gate (admin/server/hubentry.mjs entryProblem, pure: the same
// codes Save answers with), plus two of the page's own: 'scheme' (the Sumika host's address is typed and the row does
// not start like it: the hub keeps only entries of its own scheme) and 'duplicate'. And the script line for pages
// elsewhere, with what a visitor who has not chosen gets, and the control page's address. Pure.
import { entryProblem as gateProblem, ENTRY_CODES as GATE_CODES } from '../server/hubentry.mjs';

/** Row codes: the gate's, then the page's own. */
export const ENTRY_CODES = Object.freeze([...GATE_CODES, 'scheme', 'duplicate']);

/**
 * Why one address cannot be listed, or null when it can (an empty row: null, it is not saved).
 * @param {string} text  the row as typed (trimmed, as Save trims it)
 * @param {{scheme?: string|null}} [o]  the Sumika host's scheme ('https:'), when its address is known
 */
export function entryProblem(text, { scheme = null } = {}) {
  const entry = String(text ?? '').trim();
  if (!entry) return null;
  const p = gateProblem(entry);
  if (p) return p;
  return scheme && new URL(entry).protocol !== scheme ? 'scheme' : null;
}

/** The origin an address stands for (what the hub compares), or null. */
export function entryOrigin(text) {
  try {
    return new URL(String(text ?? '').trim()).origin;
  } catch (e) {
    return null;
  }
}

/** Each row's problem (entryProblem, then 'duplicate' for a second row of one origin). */
export function rowProblems(rows, o = {}) {
  const seen = new Set();
  return rows.map(r => {
    const p = entryProblem(r, o);
    if (p || !String(r ?? '').trim()) return p;
    const origin = entryOrigin(r);
    if (seen.has(origin)) return 'duplicate';
    seen.add(origin);
    return null;
  });
}

/**
 * A row's problem code (rowProblems) as the finding the page shows: 'scheme' carries the Sumika host's scheme for its
 * text's {scheme}; the other codes need no parameter of the row (null: no problem).
 * @param {string|null} code
 * @param {{scheme?: string|null}} [o]
 */
export function rowFinding(code, { scheme = null } = {}) {
  if (!code) return null;
  return code === 'scheme' ? { code, params: { scheme: scheme || '' } } : { code };
}

/** The rows to save: trimmed, empty ones left out. */
export const rowsToSave = rows => rows.map(r => String(r ?? '').trim()).filter(Boolean);

/** The example Sumika host's addresses, shown while none is typed. */
export const EXAMPLE = Object.freeze({
  url: 'https://sumika.example.com/sumika/sumika.js',
  control: 'https://sumika.example.com/sumika/',
});

/**
 * The addresses for the Sumika host the admin typed: sumika.js, and the control page, where visitors turn Sumika on
 * or off for their browser (`sumika/`, served as sumika/index.html; the site links it from its own pages, Sumika
 * never does [decision]). A bare host gets https://; a path is the site's folder on that host (a site under a
 * subpath).
 * @returns {{url: string|null, control: string|null, scheme: string|null, problem: string|null}} problem: 'bad' for
 *   an unusable address
 */
export function scriptUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return { url: null, control: null, scheme: null, problem: null };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;          // 'host:8443' is a host, not a scheme
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return { url: null, control: null, scheme: null, problem: 'bad' };
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash || !u.hostname) {
    return { url: null, control: null, scheme: null, problem: 'bad' };
  }
  const base = u.pathname.endsWith('/') ? u.href : `${u.href}/`;
  return { url: new URL('sumika/sumika.js', base).href, control: new URL('sumika/', base).href, scheme: u.protocol, problem: null };
}

/**
 * What a visitor who has not chosen on the control page gets: the script tag's data-default-state, '' for the
 * runtime's default ("enabled": shown; the attribute left out) [decision].
 */
export const DEFAULT_STATES = Object.freeze(['', 'tucked', 'off']);

const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The script line for a page elsewhere (no data-default-ghost: no extras), with data-default-state when the admin
 * picked other than the default (a value DEFAULT_STATES lacks is left out, as the default).
 * @param {string|null} url  sumika.js's address (null: the example's)
 * @param {{defaultState?: string}} [o]
 */
export function snippet(url, { defaultState = '' } = {}) {
  const state = defaultState && DEFAULT_STATES.includes(defaultState) ? ` data-default-state="${defaultState}"` : '';
  return `<script src="${attr(url || EXAMPLE.url)}" data-hub${state} defer></script>`;
}

// One sumika/hub.json entry as the publish gate judges it (admin/core/check.mjs hubFindings over
// src/hub/allowlist.js parseAllowlist, with an https: and an http: hub URL), as a code the admin page translates
// (CONTRACTS "Admin API"). An entry has a code exactly when the gate reports it: a loopback origin (a test entry a
// published hub ignores), or one a hub ignores whatever its scheme. Pure, no `node:` import: the page imports it to
// mark a row as the admin types; the program applies it before it saves.
import { isLoopback } from '../../src/hub/allowlist.js';

/** The codes entryProblem returns. */
export const ENTRY_CODES = Object.freeze(['not-string', 'wildcard', 'not-absolute', 'not-http', 'userinfo',
  'query-or-fragment', 'has-path', 'loopback']);

/**
 * Why the publish gate reports an entry, or null when a hub keeps it (on at least one scheme).
 * @param {unknown} entry one item of hub.json's `origins`
 * @returns {string|null} one of ENTRY_CODES
 */
export function entryProblem(entry) {
  if (typeof entry !== 'string') return 'not-string';
  let u = null;
  try {
    u = new URL(entry);
  } catch (e) {
    u = null;
  }
  // the gate names a loopback origin first, whatever else is wrong with it
  if (u && isLoopback(u.hostname)) return 'loopback';
  if (entry === 'null') return 'not-absolute';
  if (entry.includes('*')) return 'wildcard';
  if (!u) return 'not-absolute';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'not-http';
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(entry)) return 'userinfo';
  if (u.search || u.hash || /[?#]/.test(entry)) return 'query-or-fragment';
  if (u.pathname !== '/') return 'has-path';
  return null;
}

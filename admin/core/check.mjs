// Checks of a site folder, nothing written: the index is what an index run would write now, no file holds a user's
// personal state (index_site.py's guard), no link or junction sits in ghost/ or balloon/ (the index and the copy never
// follow one, Python's os.walk enters a junction), and the publisher's sumika/hub.json is a usable allowlist (the
// publish gate tests/build_output.test.mjs applies to the real site: hubJsonProblems lives here, the test imports it).
import fs from 'node:fs';
import path from 'node:path';
import { parseAllowlist, isLoopback } from '../../src/hub/allowlist.js';
import { indexState } from './index.mjs';
import { finding, message } from './codes.mjs';
import { isLink } from './tree.mjs';
import { WORK_DIR, workLeftovers } from './staging.mjs';

/**
 * The publish gate for the storage hub's allowlist (CLAUDE.md "Pages on other origins") as findings: sumika/hub.json is
 * the publisher's file, never built; when it exists it must be a usable allowlist with no loopback origin (a test
 * entry: a published hub ignores it, and `tools/serve.py --hub-allow` is the way to test locally) and no entry a hub
 * ignores on both schemes. None when there is no hub.json (the hub then answers no page, a choice).
 * @returns {{code: string, params: object, message: string}[]}
 */
export function hubFindings(site) {
  const file = path.join(site, 'sumika', 'hub.json');
  if (!fs.existsSync(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [finding('hub.unreadable', { error: e.message })];
  }
  const https = parseAllowlist(text, 'https://hub.invalid/sumika/hub.html');
  if (!https.ok) return [finding('hub.unusable', { error: https.error })];
  const http = parseAllowlist(text, 'http://hub.invalid/sumika/hub.html');
  const out = [];
  const loop = new Set();
  for (const entry of JSON.parse(text).origins) {
    let host = null;
    try { host = new URL(entry).hostname; } catch (e) { /* reported below */ }
    if (!host || !isLoopback(host)) continue;
    loop.add(entry);
    out.push(finding('hub.loopback', { entry }));
  }
  for (const i of https.ignored) {
    if (loop.has(i.entry)) continue;
    if (http.ignored.some(j => j.entry === i.entry)) out.push(finding('hub.ignored', { entry: i.entry, why: i.why }));
  }
  return out;
}

/** hubFindings' English lines: the publish gate's problems, [] when there is none. */
export const hubJsonProblems = site => hubFindings(site).map(f => f.message);

/** Links and junctions under SITE/ghost and SITE/balloon (never entered): [{path, code: 'site.link', why}]. */
export function siteLinks(site) {
  const out = [];
  const walk = (abs, rel) => {
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of ents) {
      const p = path.join(abs, e.name), r = `${rel}/${e.name}`;
      if (e.isSymbolicLink() || (e.isDirectory() && isLink(p))) out.push({ path: r, code: 'site.link', why: message('site.link') });
      else if (e.isDirectory()) walk(p, r);
    }
  };
  for (const top of ['ghost', 'balloon']) walk(path.join(site, top), top);
  return out;
}

/**
 * A site folder's state, nothing written.
 * @param {string} site
 * @param {{onProgress?: (p: {phase, done, total, item}) => void}} [o]
 * @returns {Promise<{site: string, ok: boolean, record: null | {code: 'kawari.record', params: {problem}, message},
 *   personal: {path, code, params?}[], index: null | {upToDate: boolean, stale: {path, code:
 *   'index.missing'|'index.differs', why}[]}, hub: {present: boolean, problems: {code, params, message}[]}, links:
 *   {path, code, why}[], work: {path, code: 'work.leftover', why}[]}>} record: the site's Kawari record exists and does
 *   not read (shipped.mjs: no add, removal or index passes until it is repaired or deleted); personal: what the index
 *   refuses (with either, `index` is null: no index run would pass); stale: what an index run would write; work: what
 *   a cut-off add or removal left in SITE/.sumika-admin-work/ (staging.mjs recoverWork settles it)
 */
export async function checkSite(site, { onProgress = null } = {}) {
  const abs = path.resolve(site);
  const state = await indexState(abs, { onProgress });
  const problems = hubFindings(abs);
  const links = siteLinks(abs);
  const work = workLeftovers(abs).map(e => ({ path: `${WORK_DIR}/${e.name}`, code: 'work.leftover', why: message('work.leftover') }));
  const index = state.personal.length || state.record ? null : { upToDate: state.upToDate, stale: state.stale };
  return {
    site: abs,
    ok: !!index && index.upToDate && !problems.length && !links.length && !work.length,
    record: state.record,
    personal: state.personal,
    index,
    hub: { present: fs.existsSync(path.join(abs, 'sumika', 'hub.json')), problems },
    links,
    work,
  };
}

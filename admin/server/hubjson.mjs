// sumika/hub.json for the Sharing screen (CLAUDE.md "Pages on other origins"): the publisher's
// allowlist of page origins, never built, versioned or pruned. Read with the publish gate's findings (the core's
// hubFindings, each entry's own code added as params.reason); saved only when no entry has a problem, as
// {"format": 1, "origins": [...]} with a 1-space indent, written atomically; an empty list deletes the file (missing =
// the hub answers no page).
import fs from 'node:fs';
import path from 'node:path';
import { hubFindings } from '../core/api.mjs';
import { entryProblem } from './hubentry.mjs';
import { finding, ApiError } from './codes.mjs';
import { writeAtomic } from './settings.mjs';

export const hubFile = site => path.join(site, 'sumika', 'hub.json');

/** Whether the site's runtime build has the storage hub (build.json `hub`). */
export function runtimeHasHub(site) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(site, 'sumika', 'build.json'), 'utf8'));
    return !!b && typeof b.hub === 'string' && b.hub !== '';
  } catch (e) {
    return false;
  }
}

/** The publish gate's findings on the site's hub.json, an entry's with `params.reason` (its entryProblem code). */
export function hubProblems(site) {
  return hubFindings(site).map(f => (f.params && Object.prototype.hasOwnProperty.call(f.params, 'entry')
    ? { ...f, params: { ...f.params, reason: entryProblem(f.params.entry) } } : f));
}

/** POST /api/hub: {exists, origins (the file's entries as they are), problems, runtimeHasHub}. */
export function readHub(site) {
  const file = hubFile(site);
  const exists = fs.existsSync(file);
  let origins = [];
  if (exists) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && Array.isArray(j.origins)) origins = j.origins;
    } catch (e) { /* the findings say why */ }
  }
  return { exists, origins, problems: hubProblems(site), runtimeHasHub: runtimeHasHub(site) };
}

/** POST /api/hub/save: {ok, problems}; entries are trimmed; nothing is written while any has a problem. */
export function saveHub(site, origins) {
  if (!Array.isArray(origins)) throw new ApiError(400, 'bad-request', { detail: 'origins must be a list' });
  const list = origins.map(o => (typeof o === 'string' ? o.trim() : o));
  const problems = [];
  list.forEach((entry, index) => {
    const code = entryProblem(entry);
    if (code) problems.push(finding(code, { index, entry }));
  });
  if (problems.length) return { ok: false, problems };
  const file = hubFile(site);
  if (!list.length) {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return { ok: true, problems: [] };
  }
  writeAtomic(file, JSON.stringify({ format: 1, origins: list }, null, 1) + '\n');
  return { ok: true, problems: [] };
}

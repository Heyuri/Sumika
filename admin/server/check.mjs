// Check (CONTRACTS "Admin API" check): what stands between a site folder and an upload, as
// findings in this order: the core's checkSite (a Kawari record that does not read, personal files, an index that is
// not what an index run would write),
// the runtime set as tools/prune.mjs reads it (every file build.json and ghosts.json name, sumika.js the bundle
// build.json describes, hub.html naming its hub, sumika/index.html (the control page) naming its script), 404.html at
// the top, the hub.json publish gate, every link or junction anywhere in the site (dev/ aside: never uploaded), and
// what a cut-off add or removal left in the work folder (the core's checkSite `work`: core/staging.mjs). Not tests/build_output.test.mjs's publish-set check: it
// needs project files (engines/midi/pins.json) and the plain engine files a publisher may leave out. Runs in the job
// worker; reads only.
import fs from 'node:fs';
import path from 'node:path';
import { currentFiles } from '../../tools/prune.mjs';
import { isLink } from '../core/tree.mjs';
import { WORK_DIR } from '../core/staging.mjs';
import { finding } from './codes.mjs';
import { hubProblems } from './hubjson.mjs';

/** A finding of the core, with its English text from the core's table. */
const coreFinding = (core, code, params = {}, files = undefined) => {
  const out = { code, params, message: core.message(code, params, files || []) };
  if (files) out.files = files;
  return out;
};

const RUNTIME = [
  [/^sumika\/sumika\.js is missing$/, () => ['runtime-missing', { file: 'sumika/sumika.js' }]],
  [/^sumika\/hub\.html is missing\b/, () => ['runtime-missing', { file: 'sumika/hub.html' }]],
  [/^sumika\/hub\.html does not name\b/, () => ['hub-html', {}]],
  // the control page likewise (prune's line ends "run npm run build", which no admin can do: Wording)
  [/^sumika\/index\.html does not name\b/, () => ['control-html', {}]],
  [/^sumika\/sumika\.js holds build\.json's build\b/, () => ['bundle-stale', {}]],
  [/^sumika\/sumika\.js does not name (.+)$/, m => ['bundle-stale', { file: m[1] }]],
  [/^(.+?) \(.+\) is missing$/, m => ['runtime-missing', { file: m[1] }]],
  [/^(.+) is no JSON$/, m => ['bad-json', { file: m[1] }]],
  // prune's refusals before it can list anything
  [/^sumika\/build\.json is missing\b/, () => ['runtime-missing', { file: 'sumika/build.json' }]],
  [/^sumika\/build\.json is no JSON\b/, () => ['bad-json', { file: 'sumika/build.json' }]],
  [/^sumika\/index\/ghosts\.json is missing\b/, () => ['no-index', undefined]],
  [/^sumika\/index\/ghosts\.json is no JSON\b/, () => ['bad-json', { file: 'sumika/index/ghosts.json' }]],
];

/** One of prune's English problem lines as a finding (runtime-problem with its text when no rule knows it). */
export function runtimeFinding(line) {
  for (const [re, f] of RUNTIME) {
    const m = re.exec(line);
    if (m) {
      const [code, params] = f(m);
      return finding(code, params);
    }
  }
  return finding('runtime-problem', { detail: line });
}

/** The runtime set's findings, as tools/prune.mjs would stop on them (nothing deleted or written here). */
export function runtimeFindings(site) {
  try {
    return currentFiles(site).problems.map(runtimeFinding);
  } catch (e) {
    // a refusal with prune's own code: its line tells a developer to run the Python indexer, the page offers Update
    // the index [decision: no inner term in what the admin reads]
    if (e && e.code === 'no-manifests') return [finding('index-old')];
    return [runtimeFinding(e.message)];
  }
}

/**
 * Every link or junction in the site (site-relative, '/'), none followed; the top-level dev/ and the work folder
 * (WORK_DIR: never uploaded, its leftovers reported as such) are skipped.
 */
export function linksIn(site) {
  const out = [];
  const walk = (abs, rel) => {
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of ents) {
      if (!rel && (e.name.toLowerCase() === 'dev' || e.name.toLowerCase() === WORK_DIR)) continue;
      const p = path.join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || (e.isDirectory() && isLink(p))) out.push(r);
      else if (e.isDirectory()) walk(p, r);
    }
  };
  walk(site, '');
  return out;
}

/**
 * Check a site folder.
 * @param {string} site
 * @param {{core: object, onProgress?: (p: {phase, done, total, item}) => void}} o core: admin/core/api.mjs
 * @returns {Promise<{ok: boolean, problems: object[]}>}
 */
export async function checkProblems(site, { core, onProgress = () => {} }) {
  const r = await core.checkSite(site, { onProgress });
  onProgress({ phase: 'check', done: 0, total: null, item: null });
  const problems = [];
  // the site's Kawari record does not read: one problem in its own words, never the Kawari ghosts' starting files it
  // would leave unlisted as personal files to delete (the core's checkSite says neither then: no index run passes)
  if (r.record) problems.push(coreFinding(core, r.record.code, r.record.params));
  if (r.personal && r.personal.length) problems.push(coreFinding(core, 'site.personal', {}, r.personal));
  const stale = !!(r.index && !r.index.upToDate);
  if (stale) {
    problems.push({ ...finding('index-stale', { count: r.index.stale.length }), files: r.index.stale });
  }
  for (const f of runtimeFindings(site)) {
    if ((f.code === 'no-index' || f.code === 'index-old') && stale) continue;   // the stale index says it already
    problems.push(f);
  }
  if (!fs.existsSync(path.join(site, '404.html'))) problems.push(finding('no-404'));
  problems.push(...hubProblems(site));
  for (const p of linksIn(site)) problems.push(coreFinding(core, 'site.link', { path: p }));
  for (const w of r.work || []) problems.push(coreFinding(core, 'work.leftover', { path: w.path }));
  return { ok: problems.length === 0, problems };
}

// The admin program's request handler (CONTRACTS "Admin API"): the guards, the route table and the
// state one start keeps (the settings, the chosen site, inspected ghosts' tokens, drops, the job, the preview, the open
// file dialog). A
// web-standard `(Request, {host}) => Response`, the same under Node and in the compiled program; the tests call it
// directly with Request objects.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SCHEMA } from '../../src/core/schema.js';
import { compareEntries } from '../../src/core/shells.js';
import { engineNeeds } from '../../src/worker/engines/supported.js';
import { ledgerPath } from '../../tools/prune.mjs';
import { FORMAT, idProblem } from '../core/api.mjs';
import { readDescript } from '../core/text.mjs';
import { sortedPy } from '../core/py.mjs';
import { isLink } from '../core/tree.mjs';
import { ApiError, finding } from './codes.mjs';
import { checkPeer, checkKey, readJson, json, errorResponse, pageResponse } from './guard.mjs';
import { isFile, sameOrInside, inside, drives, places } from './paths.mjs';
import { saveSettings, settingsView, addRecent } from './settings.mjs';
import { readHub, saveHub } from './hubjson.mjs';
import { startPreview } from './preview.mjs';
import { PURPOSES, pickRequest } from './picker.mjs';
import { settles } from './outcome.mjs';
import { errorText } from './log.mjs';

export const APP_NAME = 'sumika-admin';

/** How long /api/pick and /api/pick/wait hold their answer for an open dialog before {open: true} (a browser gives up on
 * an answer after some minutes: Firefox's network.http.response.timeout is 300 s [infer]). */
export const PICK_WAIT_MS = 25000;

const ROUTES = new Map([
  ['/', { GET: 'page' }],
  ['/api/hello', { GET: 'hello' }],
  ['/api/status', { GET: 'status' }],
  ['/api/quit', { POST: 'quit' }],
  ['/api/settings', { POST: 'settings' }],
  ['/api/site', { POST: 'site' }],
  ['/api/fs/roots', { POST: 'roots' }],
  ['/api/fs/list', { POST: 'list' }],
  ['/api/inspect', { POST: 'inspect' }],
  ['/api/drop', { POST: 'drop' }],
  ['/api/ghosts', { POST: 'ghosts' }],
  ['/api/add', { POST: 'add' }],
  ['/api/remove', { POST: 'remove' }],
  ['/api/index', { POST: 'index' }],
  ['/api/check', { POST: 'check' }],
  ['/api/prepare', { POST: 'prepare' }],
  ['/api/hub', { POST: 'hub' }],
  ['/api/hub/save', { POST: 'hubSave' }],
  ['/api/preview/start', { POST: 'previewStart' }],
  ['/api/preview/stop', { POST: 'previewStop' }],
  ['/api/pick', { POST: 'pick' }],
  ['/api/pick/wait', { POST: 'pickWait' }],
  ['/api/pick/cancel', { POST: 'pickCancel' }],
]);

/** The route of a path: {methods, params} or null. */
function route(pathname) {
  const fixed = ROUTES.get(pathname);
  if (fixed) return { methods: fixed, params: {} };
  const m = /^\/api\/drop\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  if (m[2] === 'done') return { methods: { POST: 'dropDone' }, params: { drop: m[1] } };
  if (m[2] === 'cancel') return { methods: { POST: 'dropCancel' }, params: { drop: m[1] } };
  if (/^[0-9]+$/.test(m[2])) return { methods: { PUT: 'dropPut' }, params: { drop: m[1], n: m[2] } };
  return null;
}

const realpath = p => (fs.realpathSync.native || fs.realpathSync)(p);

/** A JSON file: {value} or {missing: true} or {error}. */
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? { missing: true } : { error: e.code || e.message };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: 'no JSON' };
  }
}

/** An absolute folder path the admin gave, as its real path; ApiError path-* otherwise. */
export function realFolder(p) {
  if (typeof p !== 'string' || !p) throw new ApiError(400, 'bad-request', { detail: 'path must be a text' });
  if (!path.isAbsolute(p)) throw new ApiError(400, 'path-not-absolute', { path: p });
  let real;
  try {
    real = realpath(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new ApiError(400, 'path-missing', { path: p });
    throw new ApiError(400, 'path-no-access', { path: p, error: e.code || e.message });
  }
  let st;
  try {
    st = fs.statSync(real);
  } catch (e) {
    throw new ApiError(400, 'path-no-access', { path: p, error: e.code || e.message });
  }
  if (!st.isDirectory()) throw new ApiError(400, 'path-not-folder', { path: p });
  return real;
}

/** A ghost folder's name (descript.txt `name`), else the fallback. */
function ghostName(descript, fallback) {
  try {
    const d = readDescript(descript);
    return d.has('name') ? d.get('name') : fallback;
  } catch (e) {
    return fallback;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true });
const strings = (v, what) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new ApiError(400, 'bad-request', { detail: `${what} must be a list of texts` });
  return v;
};

/**
 * @param {object} o
 * @param {number} o.port the port the server listens on (the Host and Origin checks)
 * @param {string} o.key the start's key
 * @param {{html: string, csp: string}} o.page
 * @param {object} o.st the settings (settings.mjs loadSettings)
 * @param {import('./jobs.mjs').Jobs} o.jobs
 * @param {import('./drops.mjs').Drops} o.drops
 * @param {string} o.xDir the run folder's x/ (archive extractions)
 * @param {Function} o.serve serve.mjs's, for the preview servers
 * @param {string[]} [o.forbidden] folders a site may not be (dev runs and tests: the project's site/)
 * @param {string|null} [o.programDir] the compiled program's folder (a file browser place)
 * @param {object|null} [o.interrupted] the journal of an earlier start's unfinished job
 * @param {boolean} [o.starting] the start is still settling what an earlier one left (main.mjs): hello's and status's
 *   `starting` until started(interrupted)
 * @param {() => void} [o.onQuit] called after Quit's answer
 * @param {object|null} [o.picker] the file dialogs (picker.mjs): null for none (the page's file browser then)
 * @param {number} [o.pickWaitMs] how long a pick answer waits for the dialog (PICK_WAIT_MS; tests: less)
 * @param {{write: (what: string, detail?: string) => void}|null} [o.log] the error log (log.mjs): a route that fails
 *   unexpectedly (500 internal) is written there with its stack, which its answer never carries
 */
export function createApp(o) {
  const {
    port, key, page, st, jobs, drops, xDir, serve, forbidden = [], programDir = null, version = '0.0.0-dev',
    platform = process.platform, env = {}, onQuit = () => {}, now = () => Date.now(), picker = null,
    pickWaitMs = PICK_WAIT_MS, log = null,
  } = o;
  let interrupted = o.interrupted || null;
  let starting = o.starting === true;
  let preview = null;
  let lastActivity = now();
  const tokens = new Map();

  // ---- the site ----

  /** SiteInfo of a folder (CONTRACTS "Admin API"); ApiError when it is no usable site. */
  function siteInfo(p) {
    const real = realFolder(p);
    if (forbidden.some(f => sameOrInside(f, real))) throw new ApiError(400, 'project-site', { path: real });
    const sumika = path.join(real, 'sumika');
    if (!isFile(path.join(sumika, 'sumika.js')) || !isFile(path.join(sumika, 'build.json'))) {
      throw new ApiError(400, 'not-a-site', { path: real });
    }
    const build = readJsonFile(path.join(sumika, 'build.json')).value;
    const index = readJsonFile(path.join(sumika, 'index', 'ghosts.json')).value;
    let readOnly = null, readOnlyInfo = null;
    if (index && typeof index === 'object' && index.format !== FORMAT) {
      readOnly = 'index-format';
      readOnlyInfo = finding('index-format', { format: index.format ?? null, expected: FORMAT });
    } else {
      // tools/build.mjs checkSchema's rule: a kind recorded higher than this tree's SCHEMA (0 for a kind it lacks)
      const was = build && build.schema && typeof build.schema === 'object' ? build.schema : {};
      const k = Object.keys(was).find(n => Number(was[n]) > Number(SCHEMA[n] || 0));
      if (k) {
        readOnly = 'schema';
        readOnlyInfo = finding('schema', { kind: k, schema: was[k], expected: SCHEMA[k] || 0 });
      }
    }
    return {
      path: real,
      // control: the control page, where visitors turn Sumika on or off (sumika/index.html; runtimes that have one)
      runtime: build && typeof build === 'object'
        ? {
          build: typeof build.build === 'string' ? build.build : null,
          hub: typeof build.hub === 'string' && build.hub !== '',
          control: isFile(path.join(sumika, 'index.html')),
        } : null,
      // a page at the site's top, which the Preview's "Open the site" opens (the project's own site/ has none:
      // its test pages are in dev/)
      front: isFile(path.join(real, 'index.html')),
      ghosts: index && Array.isArray(index.ghosts) ? index.ghosts.length : 0,
      readOnly, readOnlyInfo,
    };
  }

  /** The chosen site's real path; 409 no-site without one, 409 read-only for a write to a read-only one. */
  function needSite(write) {
    if (!st.data.site) throw new ApiError(409, 'no-site');
    let info;
    try {
      info = siteInfo(st.data.site);
    } catch (e) {
      throw new ApiError(409, 'no-site');
    }
    if (write && info.readOnly) throw new ApiError(409, 'read-only', { reason: info.readOnly, ...info.readOnlyInfo.params });
    return info.path;
  }

  function siteView() {
    if (!st.data.site) return { site: null, siteError: null };
    try {
      return { site: siteInfo(st.data.site), siteError: null };
    } catch (e) {
      return { site: null, siteError: e instanceof ApiError ? e.toJSON() : finding('internal', { error: String(e.message || e) }) };
    }
  }

  const previewView = () => (preview ? { site: preview.site, pages: preview.pages } : null);

  // ---- jobs ----

  /** Starts a job; `interrupted` goes when the job settles it (outcome.mjs settles: any job for 'unchanged', else a
   * finished one that does what its outcome names). */
  function startJob(kind, args, opts) {
    const after = opts.after || null;
    const job = jobs.start(kind, args, {
      ...opts,
      after: async r => {
        const out = after ? await after(r) : r;
        if (settles(interrupted, { kind, state: 'done', result: out })) interrupted = null;
        return out;
      },
    });
    if (settles(interrupted, { kind, state: 'running' })) interrupted = null;
    return json(200, job);
  }

  /** inspect's tokens: each item that has an id gets one, standing for it in /api/add. */
  function tokenize(result, drop = null) {
    for (const item of result.items || []) {
      if (item && item.id && item.source && typeof item.source.path === 'string') {
        const token = crypto.randomBytes(8).toString('hex');
        tokens.set(token, {
          source: { kind: item.source.kind, path: item.source.path }, id: item.id, name: item.name ?? null,
          archive: item.archive ?? null, drop,
        });
        item.token = token;
      } else if (item) item.token = null;
    }
    return result;
  }

  /** A drop's end: its folder and its tokens. */
  function endDrop(id) {
    drops.fail(id);
    for (const [t, v] of tokens) if (v.drop === id) tokens.delete(t);
  }

  function parseSources(list) {
    if (!Array.isArray(list) || !list.length) throw new ApiError(400, 'bad-request', { detail: 'sources must be a non-empty list' });
    return list.map(s => {
      if (!s || typeof s.path !== 'string' || !path.isAbsolute(s.path)) {
        throw new ApiError(400, 'path-not-absolute', { path: String(s && s.path) });
      }
      if (s.archive !== undefined && s.archive !== null && (typeof s.archive !== 'string' || !path.isAbsolute(s.archive))) {
        throw new ApiError(400, 'path-not-absolute', { path: String(s.archive) });
      }
      return { path: s.path, archive: s.archive || null };
    });
  }

  /** The chosen site when it is usable (inspect's conflicts), else null. */
  function siteOrNull() {
    try {
      return st.data.site ? siteInfo(st.data.site).path : null;
    } catch (e) {
      return null;
    }
  }

  // ---- the ghost list ----

  function ghostList(site) {
    const problems = [];
    const idx = readJsonFile(path.join(site, 'sumika', 'index', 'ghosts.json'));
    let entries = [];
    if (idx.missing) problems.push(finding('no-index'));
    else if (idx.error) problems.push(finding('bad-index', { error: idx.error }));
    else if (!idx.value || !Array.isArray(idx.value.ghosts)) problems.push(finding('bad-index', { error: 'no ghosts list' }));
    else entries = idx.value.ghosts.filter(g => g && typeof g.id === 'string');
    const gdir = path.join(site, 'ghost');
    let names = [];
    try { names = fs.readdirSync(gdir); } catch (e) { names = []; }
    const onDisk = new Set(names.filter(n => isFile(path.join(gdir, n, 'ghost', 'master', 'descript.txt'))));
    const rows = entries.map(g => ({
      id: g.id, name: typeof g.name === 'string' ? g.name : g.id, engine: typeof g.engine === 'string' ? g.engine : null,
      needs: engineNeeds(g), balloons: (Array.isArray(g.bundledBalloons) ? g.bundledBalloons : [])
        .filter(b => b && typeof b === 'object').map(b => ({ id: b.dir ?? b.id ?? null, name: b.name ?? b.dir ?? null })),
      indexed: true, folder: onDisk.has(g.id),
    }));
    const indexed = new Set(entries.map(g => g.id));
    for (const id of sortedPy([...onDisk].filter(n => !indexed.has(n)))) {      // the same on every OS's listing
      rows.push({
        id, name: ghostName(path.join(gdir, id, 'ghost', 'master', 'descript.txt'), id), engine: null, needs: null,
        balloons: [], indexed: false, folder: true,
      });
    }
    // Change ghost ▸'s order, indexed or not: by descript name, ties by folder (src/core/shells.js compareEntries, as
    // the runtime sorts the index it loads) [observed]; an index in an older tool's folder order too
    return { ghosts: rows.sort(compareEntries), problems };
  }

  // ---- the file browser ----

  function listFolder(p) {
    const real = realFolder(p);
    let ents;
    try {
      ents = fs.readdirSync(real, { withFileTypes: true });
    } catch (e) {
      throw new ApiError(400, 'path-no-access', { path: p, error: e.code || e.message });
    }
    const entries = ents.map(e => {
      const full = path.join(real, e.name);
      let lst;
      try {
        lst = fs.lstatSync(full);
      } catch (err) {
        return { name: e.name, kind: 'file' };
      }
      if (lst.isSymbolicLink() || (lst.isDirectory() && isLink(full))) {
        let target = null;
        try {
          const t = fs.statSync(full);
          target = t.isDirectory() ? 'dir' : t.isFile() ? 'file' : null;
        } catch (err) { target = null; }
        return { name: e.name, kind: 'link', target };
      }
      if (lst.isDirectory()) {
        const out = { name: e.name, kind: 'dir' };
        const d = path.join(full, 'ghost', 'master', 'descript.txt');
        if (isFile(d)) out.ghost = { name: ghostName(d, e.name) };
        return out;
      }
      const out = { name: e.name, kind: 'file', size: lst.size };
      if (/\.(nar|zip)$/i.test(e.name)) out.archive = true;
      if (/^(updates2\.dau|updates\.txt)$/i.test(e.name)) out.list = true;
      return out;
    });
    const folderish = x => x.kind === 'dir' || (x.kind === 'link' && x.target === 'dir');
    entries.sort((a, b) => (folderish(a) === folderish(b) ? collator.compare(a.name, b.name) : folderish(a) ? -1 : 1));
    const parent = path.dirname(real);
    return { path: real, parent: parent !== real ? parent : null, entries };
  }

  // ---- the file dialogs (picker.mjs) ----

  let picking = null;          // the open dialog: {id, purpose, settled: Promise<answer>}
  let picked = null;           // the last dialog's answer, until the next pick: {id, answer}

  /** hello's and status's `pick`: the open dialog, whichever tab opened it (a reloaded page waits on it at once). */
  const pickView = () => (picking ? { id: picking.id, purpose: picking.purpose } : null);

  /** no-picker's params: a dialog program's code in plain words ({exit}; the log has the technical line), else why. */
  const noPicker = e => (e && Number.isInteger(e.exit) ? { exit: e.exit } : { error: String((e && e.message) || e) });

  /**
   * The dialog's answer as the API keeps it: {paths} (the folder it picked in remembered for its purpose), {canceled},
   * or {error} (no-picker; the failure in the log).
   */
  async function dialogAnswer(purpose, req) {
    let r;
    try {
      r = await picker.open(req);
    } catch (e) {
      if (log) log.write(`the ${purpose} file window could not be shown`, errorText(e));
      return { error: new ApiError(501, 'no-picker', noPicker(e)) };
    }
    const paths = Array.isArray(r && r.paths) ? r.paths.filter(x => typeof x === 'string' && path.isAbsolute(x)) : [];
    if (!paths.length) return { canceled: true };
    try {
      // the folder it was picked in, for the next dialog of this purpose (a help: the paths are the answer)
      saveSettings(st, { lastFolders: { ...(st.data.lastFolders || {}), [purpose]: path.dirname(paths[0]) } });
    } catch (e) {
      if (log) log.write(`the folder the ${purpose} file window picked in could not be remembered`, errorText(e));
    }
    return { paths };
  }

  /** Where a dialog opens: the site dialog beside the current site, else the folder this purpose last picked in,
   * else `near` (the page's guess: a compared ghost folder's parent), else the dialog's own memory (null). */
  function pickStart(purpose, near) {
    if (purpose === 'site' && st.data.site) return path.dirname(st.data.site);
    const last = st.data.lastFolders && st.data.lastFolders[purpose];
    if (typeof last === 'string' && path.isAbsolute(last)) return last;
    return near;
  }

  /** A dialog's answer as the API gives it, within pickWaitMs; {open: true, id} while it is still open. */
  async function pickAnswer(p) {
    let timer = null;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), pickWaitMs); });
    const answer = await Promise.race([p.settled, late]);
    clearTimeout(timer);
    if (!answer) return json(200, { open: true, id: p.id });
    if (answer.error) throw answer.error;
    return json(200, answer);
  }

  // ---- the routes ----

  const handlers = {
    page: () => pageResponse(page),

    hello: () => {
      const s = siteView();
      return json(200, {
        app: APP_NAME, version, os: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux',
        settings: settingsView(st), site: s.site, siteError: s.siteError, interrupted, starting, job: jobs.snapshot(),
        preview: previewView(), picker: !!(picker && picker.available), pick: pickView(),
      });
    },

    status: () => json(200, { job: jobs.snapshot(), preview: previewView(), pick: pickView(), starting }),

    quit: () => {
      if (jobs.running) throw new ApiError(409, 'busy', { kind: jobs.current.kind });
      setTimeout(() => onQuit(), 50);
      return json(200, { ok: true });
    },

    settings: body => {
      const l = body.language;
      if (l !== undefined && l !== null && l !== 'ja' && l !== 'en') throw new ApiError(400, 'bad-request', { detail: 'language' });
      saveSettings(st, { language: l ?? null });
      return json(200, settingsView(st));
    },

    site: body => {
      if (jobs.running) throw new ApiError(409, 'busy', { kind: jobs.current.kind });
      const info = siteInfo(body.path);
      saveSettings(st, { site: info.path, recent: addRecent(st.data.recent, info.path, platform) });
      return json(200, info);
    },

    roots: async () => {
      const d = await drives({ platform });
      return json(200, { ...d, places: places({ platform, env, programDir, recent: st.data.recent }) });
    },

    list: body => json(200, listFolder(body.path)),

    inspect: body => {
      const sources = parseSources(body.sources);
      let recent = st.data.recent;
      for (const s of sources) {
        const dir = path.dirname(s.path);
        if (dir !== s.path && !inside(path.dirname(xDir), s.path)) recent = addRecent(recent, dir, platform);
      }
      if (recent !== st.data.recent) saveSettings(st, { recent });
      return startJob('inspect', { sources, site: siteOrNull(), tempDir: xDir }, {
        label: sources.map(s => path.basename(s.path)).join(', '), after: r => tokenize(r),
      });
    },

    drop: () => json(200, { drop: drops.create() }),

    dropPut: async (body, req, { drop, n }) => {
      await drops.put(drop, n, req.headers.get('x-sumika-path'), req.body);
      return json(200, { ok: true });
    },

    dropDone: (body, req, { drop }) => {
      if (jobs.running) throw new ApiError(409, 'busy', { kind: jobs.current.kind });
      const sources = drops.done(drop, body.roots);
      return startJob('inspect', { sources, site: siteOrNull(), tempDir: xDir }, {
        label: sources.map(s => s.dropped.name).join(', '), after: r => tokenize(r, drop),
      });
    },

    dropCancel: (body, req, { drop }) => {
      drops.get(drop);
      endDrop(drop);
      return json(200, { ok: true });
    },

    ghosts: () => json(200, ghostList(needSite(false))),

    add: body => {
      const site = needSite(true);
      if (!Array.isArray(body.plan) || !body.plan.length) throw new ApiError(400, 'bad-request', { detail: 'plan must be a non-empty list' });
      const items = body.plan.map(p => {
        const t = p && typeof p.token === 'string' ? tokens.get(p.token) : null;
        if (!t) throw new ApiError(400, 'token-unknown', { token: String(p && p.token) });
        return {
          token: p.token, source: t.source, id: t.id, name: t.name, archive: t.archive, replace: p.replace === true,
          keep: strings(p.keep, 'keep'), leaveOut: strings(p.leaveOut, 'leaveOut'),
        };
      });
      const used = new Set(items.map(it => tokens.get(it.token).drop).filter(Boolean));
      return startJob('add', { site, tempDir: xDir, items }, {
        label: items.map(it => it.name || it.id).join(', '),
        journal: { site, ghosts: items.map(it => ({ id: it.id, name: it.name || it.id })) },
        after: r => {
          for (const d of used) endDrop(d);
          return r;
        },
      });
    },

    remove: body => {
      const site = needSite(true);
      if (typeof body.id !== 'string' || !body.id) throw new ApiError(400, 'bad-request', { detail: 'id' });
      // the label names the ghost (its descript name), as the journal does for the next start's notice
      const name = idProblem(body.id) ? body.id : ghostName(path.join(site, 'ghost', body.id, 'ghost', 'master', 'descript.txt'), body.id);
      return startJob('remove', { site, id: body.id }, { label: name, journal: { site, ghosts: [{ id: body.id, name }] } });
    },

    index: () => {
      const site = needSite(true);
      return startJob('index', { site }, { label: '', journal: { site } });
    },

    check: () => startJob('check', { site: needSite(false) }, { label: '' }),

    prepare: body => {
      const site = needSite(true);
      const first = body.first === true, retireAll = body.retireAll === true, newRecord = body.newRecord === true;
      if ([first, retireAll, newRecord].filter(Boolean).length > 1) {
        throw new ApiError(400, 'bad-request', { detail: 'first, retireAll and newRecord exclude each other' });
      }
      const ledger = ledgerPath(site);
      const has = fs.existsSync(ledger);
      // newRecord (Start a new record, offered for a ledger that does not read: ledger-unreadable) is the job's to
      // judge once Check has passed: it renames such a ledger aside, and is retireAll without one
      if (!has && !first && !retireAll && !newRecord) throw new ApiError(409, 'needs-first');
      if (has && (first || retireAll)) throw new ApiError(409, 'ledger-exists', { ledger });
      return startJob('prepare', { site, first, retireAll, newRecord }, { label: '', journal: { site } });
    },

    hub: () => json(200, readHub(needSite(false))),

    hubSave: body => json(200, saveHub(needSite(true), body.origins)),

    previewStart: async body => {
      const site = needSite(false);
      const lang = body.lang === 'ja' ? 'ja' : 'en';
      if (preview) {
        const old = preview;
        preview = null;
        await old.stop();
      }
      try {
        preview = await startPreview({ site, lang, serve });
      } catch (e) {
        throw new ApiError(500, 'preview-failed', { error: String((e && e.message) || e) });
      }
      return json(200, previewView());
    },

    previewStop: async () => {
      if (preview) {
        const old = preview;
        preview = null;
        await old.stop();
      }
      return json(200, { ok: true });
    },

    pick: body => {
      const purpose = typeof body.purpose === 'string' && Object.hasOwn(PURPOSES, body.purpose) ? body.purpose : null;
      if (!purpose) throw new ApiError(400, 'bad-request', { detail: 'purpose' });
      // its id: the page that did not open it waits on it too, to know when it is closed (picker.js watch)
      if (picking) throw new ApiError(409, 'picker-open', { purpose: picking.purpose, id: picking.id });
      if (!picker || !picker.available) throw new ApiError(501, 'no-picker');
      const near = typeof body.near === 'string' && path.isAbsolute(body.near) ? body.near : null;
      const req = pickRequest(purpose, body.lang === 'ja' ? 'ja' : 'en', pickStart(purpose, near));
      const p = { id: crypto.randomBytes(6).toString('hex'), purpose };
      picking = p;
      picked = null;
      // the open mark always goes with the dialog, whatever failed after it (else every later pick of this run would
      // answer 409 picker-open)
      p.settled = (async () => {
        let answer;
        try {
          answer = await dialogAnswer(purpose, req);
        } catch (e) {
          if (log) log.write('POST /api/pick failed after its dialog', errorText(e));
          answer = { error: new ApiError(500, 'internal', { error: String((e && e.message) || e) }) };
        } finally {
          if (picking === p) picking = null;
        }
        picked = { id: p.id, answer };
        return answer;
      })();
      return pickAnswer(p);
    },

    pickWait: body => {
      const id = typeof body.id === 'string' ? body.id : '';
      if (picking && picking.id === id) return pickAnswer(picking);
      // kept until the next pick, for every wait on it: the tab that opened it gets it even when the tab that only
      // watched it (a 409 picker-open) asked first
      if (picked && picked.id === id) {
        if (picked.answer.error) throw picked.answer.error;
        return json(200, picked.answer);
      }
      return json(200, { canceled: true });                   // a dialog this start no longer knows
    },

    pickCancel: () => {
      const open = !!picking;
      if (open) picker.cancel();
      return json(200, { ok: true, open });
    },
  };

  /** The handler: (Request, {host}) => Response. */
  async function handle(req, info) {
    let where = req.method;
    try {
      checkPeer(req, info, port);
      const url = new URL(req.url);
      where = `${req.method} ${url.pathname}`;
      const r = route(url.pathname);
      if (!r) throw new ApiError(404, 'not-found');
      const name = r.methods[req.method];
      if (!name) throw new ApiError(405, 'method');
      if (url.pathname.startsWith('/api/')) {
        checkKey(req, key);
        lastActivity = now();
      }
      const body = req.method === 'POST' ? await readJson(req) : null;
      return await handlers[name](body, req, r.params);
    } catch (e) {
      // a refusal is an answer; anything else is a fault the page shows only as 'internal': its stack goes to the log
      if (log && !(e instanceof ApiError)) log.write(`${where} answered 500 internal`, errorText(e));
      return errorResponse(e);
    }
  }

  return {
    handle,
    /** The time of the last /api/ request (the idle exit). */
    get lastActivity() { return lastActivity; },
    /**
     * The start has settled what an earlier one left: hello's `interrupted` (null: none), `starting` false. A job asked
     * for meanwhile, still waiting to begin, settles an 'unchanged' notice as it would have at its start.
     */
    started(it) {
      interrupted = it || null;
      starting = false;
      const job = jobs.snapshot();
      if (job && settles(interrupted, job)) interrupted = null;
    },
    /** Closes an open file dialog without waiting for it (the program is closing). */
    closePicker() {
      if (picker) picker.close();
    },
    /** Stops the preview servers (the program is closing). */
    async stopPreview() {
      if (preview) {
        const old = preview;
        preview = null;
        await old.stop();
      }
    },
  };
}

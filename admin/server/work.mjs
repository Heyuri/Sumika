// The jobs' bodies (CONTRACTS "Admin API" results): what one job does with the core
// (admin/core/api.mjs), given plain JSON arguments, answering a plain JSON result. Run in the job worker (job.mjs);
// the tests also run them in-process. The main thread adds what it owns (inspect's tokens, a drop's end).
import path from 'node:path';
import { checkProblems } from './check.mjs';
import { prepareUpload } from './upload.mjs';
import { cleanRuns } from './instance.mjs';
import { message } from './codes.mjs';

/** An error as a job's Finding: a core refusal or a program JobError as it is, anything else job-failed. */
export function errorFinding(e) {
  if (e && typeof e.toJSON === 'function' && typeof e.code === 'string') return e.toJSON();
  const error = String((e && e.message) || e);
  return { code: 'job-failed', params: { error }, message: message('job-failed', { error }) };
}

/** An inspect item for a source the core gave no ghost for, or refused. */
function refusedItem(source, refusal, dropped) {
  const item = {
    source: { kind: /\.(nar|zip)$/i.test(source.path) ? 'archive' : 'folder', path: source.path }, id: null, name: null,
    engine: null, runs: null, sizeBytes: 0, fileCount: 0, excluded: [], refusal, notes: [], terms: null, balloons: [],
    conflict: null, archive: source.archive || null, updateList: null,
  };
  if (dropped) item.dropped = dropped;
  return item;
}

async function inspect({ sources, site, tempDir }, { core, onProgress }) {
  const items = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    onProgress({ phase: 'inspect', done: i, total: sources.length, item: s.dropped ? s.dropped.name : path.basename(s.path) });
    let found;
    try {
      found = await core.inspectSource(s.path, { site, archive: s.archive || null, tempDir, onProgress });
    } catch (e) {
      items.push(refusedItem(s, errorFinding(e), s.dropped));
      continue;
    }
    if (!found.length) {
      const params = { label: s.path };
      items.push(refusedItem(s, { code: 'source.notGhost', params, message: core.message('source.notGhost', params), files: [] }, s.dropped));
      continue;
    }
    for (const item of found) items.push(s.dropped ? { ...item, dropped: s.dropped } : item);
  }
  onProgress({ phase: 'inspect', done: sources.length, total: sources.length, item: null });
  return { items };
}

async function add({ site, tempDir, items }, { core, onProgress, onStep }) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    onProgress({ phase: 'add', done: i, total: items.length, item: it.name || it.id });
    const head = { token: it.token, id: it.id, name: it.name };
    try {
      const r = await core.addGhost({ source: it.source, id: it.id }, site, {
        id: it.id, archive: it.source.kind === 'archive' ? null : it.archive, keep: it.keep || [],
        leaveOut: it.leaveOut || [], replace: !!it.replace, index: false, tempDir, onProgress, onStep,
      });
      out.push({ ...head, ok: true, copied: r.copied, balloon: r.balloon, notes: r.notes, excluded: r.excluded });
    } catch (e) {
      out.push({ ...head, ok: false, refusal: errorFinding(e) });
    }
  }
  onProgress({ phase: 'add', done: items.length, total: items.length, item: null });
  let index = null, indexRefusal = null;
  if (out.some(r => r.ok)) {
    onStep('index', null);
    try {
      index = await core.indexSite(site, { onProgress });
    } catch (e) {
      indexRefusal = errorFinding(e);
    }
  }
  return { items: out, index, indexRefusal };
}

async function remove({ site, id }, { core, onProgress, onStep }) {
  const r = await core.removeGhost(site, id, { onProgress, onStep });
  return { id: r.id, path: r.path, link: !!r.link, deleteOnHost: `ghost/${id}/`, index: r.index };
}

/** What a cut-off add or removal left in the site's work folder, settled before a job writes (core recoverWork). */
const settle = async (core, site) => {
  if (site && typeof core.recoverWork === 'function') await core.recoverWork(site);
};

/**
 * Runs one job. A write job (add, remove, index, prepare) first settles the site's work folder (core recoverWork:
 * staging.mjs). 'settle' and 'clean' are no jobs of the API but the start's tidying up, in the job worker (main.mjs):
 * a site's work folder (recoverWork's answer) and the run folders of earlier starts (instance.mjs cleanRuns: their
 * count).
 * @param {'inspect'|'add'|'remove'|'index'|'check'|'prepare'|'settle'|'clean'} kind
 * @param {object} args the job's arguments (JSON)
 * @param {{core: object, onProgress?: (p: {phase, done, total, item}) => void, onStep?: (step: string, id?: string|null)
 *   => void}} o onStep: the journal's steps (instance.mjs journalSteps; the core's addGhost / removeGhost onStep)
 * @returns {Promise<object>} the job's result (JSON)
 */
export async function work(kind, args, { core, onProgress = () => {}, onStep = () => {} }) {
  const o = { core, onProgress, onStep };
  if (kind === 'add' || kind === 'remove' || kind === 'index' || kind === 'prepare') await settle(core, args.site);
  switch (kind) {
    case 'inspect': return inspect(args, o);
    case 'add': return add(args, o);
    case 'remove': return remove(args, o);
    case 'index':
      onStep('index', null);
      return core.indexSite(args.site, { onProgress });
    case 'check': return checkProblems(args.site, o);
    case 'prepare': return prepareUpload(args.site, { first: args.first, retireAll: args.retireAll, newRecord: args.newRecord, core, onProgress });
    case 'settle': return core.recoverWork(args.site);
    case 'clean': return cleanRuns(args.root, { keep: args.keep || null });
    default: throw new Error(`no such job: ${kind}`);
  }
}

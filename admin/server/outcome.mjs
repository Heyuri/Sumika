// What the next start says of a job a closed window or a crash cut off (CONTRACTS "Admin API": hello's
// `interrupted`): the journal (instance.mjs takeJournal: the job, its ghosts, its last step and the ghosts whose folder
// was final) read together with what settling the site's work folder found (core recoverWork, staging.mjs), as one
// outcome the page words: 'unchanged' (a read-only job, or a write job cut off before anything visible changed: its
// staging copy deleted), 'index' (ghost folders are final but the index was not rewritten: Update the index finishes
// it), 'prepare' (Prepare upload cut off: run it again) or 'unknown' (Check the site). Pure, no node: import: the page
// imports `settles` too.

export const OUTCOMES = Object.freeze(['unchanged', 'index', 'prepare', 'unknown']);

/**
 * hello's `interrupted` of a journal.
 * @param {{kind: string|null, label: string, startedAt: number|null, site?: string, step?: string|null,
 *   ghost?: string|null, placed: string[], ghosts: {id, name}[]}} j the journal (takeJournal)
 * @param {{entries: {kind, id, action}[]}|null} recovery recoverWork's answer for j.site (null: not run there)
 * @param {(id: string) => boolean} inGhost whether j.site's ghost/<id> is there now
 * @returns {{kind, label, startedAt, step: string|null, outcome: string, ghosts: {id, name, placed: boolean}[]}}
 */
export function interruptedOf(j, recovery, inGhost = () => false) {
  const out = { kind: j.kind, label: j.label || '', startedAt: j.startedAt ?? null, step: j.step ?? null, outcome: 'unknown', ghosts: [] };
  if (j.kind === 'inspect' || j.kind === 'check') out.outcome = 'unchanged';
  else if (j.kind === 'prepare') out.outcome = 'prepare';
  else if (j.kind === 'index') out.outcome = 'index';
  if (j.kind !== 'add' && j.kind !== 'remove') return out;
  // an older start's journal has no step, and a site that cannot be settled now tells nothing
  if (j.step === undefined || !j.site || !recovery) return out;
  const entries = recovery.entries || [];
  const has = (kind, id, action = null) => entries.some(e => e.kind === kind && e.id === id && (!action || e.action === action));
  const placed = new Set(j.placed || []);
  const cur = j.ghost || (j.ghosts[0] && j.ghosts[0].id) || null;
  if (cur && j.step === 'swap' && !placed.has(cur)) {
    // cut off between the renames: a staging copy still there, or an old folder put back, means not swapped in
    if (j.kind === 'add' && !has('new', cur) && !has('old', cur, 'restored') && inGhost(cur)) placed.add(cur);
    if (j.kind === 'remove' && !inGhost(cur)) placed.add(cur);
  }
  // an old folder that could not be put back: ghost/<id> is missing, and nothing here can say more
  if (entries.some(e => e.kind === 'old' && e.action === 'kept' && !inGhost(e.id))) return out;
  const ghosts = j.ghosts.length ? j.ghosts : [...placed].map(id => ({ id, name: id }));
  out.ghosts = ghosts.map(g => ({ id: g.id, name: g.name, placed: placed.has(g.id) }));
  out.outcome = placed.size ? 'index' : 'unchanged';
  return out;
}

/**
 * Whether a job settles what `interrupted` asks for, so the notice goes: any job for 'unchanged' (there was nothing
 * to do), and else a finished job that does the one thing the outcome names: an index run ('index': the index job,
 * or an add or removal that indexed), Prepare upload ('prepare'), Check or Prepare upload ('unknown').
 * @param {{outcome: string}|null} interrupted
 * @param {{kind: string, state: string, result?: object}|null} job
 */
export function settles(interrupted, job) {
  if (!interrupted || !job) return false;
  if (interrupted.outcome === 'unchanged') return true;
  if (job.state !== 'done') return false;
  if (interrupted.outcome === 'index') {
    return job.kind === 'index' || ((job.kind === 'add' || job.kind === 'remove') && !!(job.result && job.result.index));
  }
  if (interrupted.outcome === 'prepare') return job.kind === 'prepare';
  return job.kind === 'check' || job.kind === 'prepare';
}

// The notice of a job an earlier start did not finish (hello's `interrupted`: CONTRACTS "Admin API";
// admin/server/outcome.mjs): what happened, whether the site changed, and the one thing to do, the ghosts by name.
// 'unchanged': nothing to do (Dismiss); 'index': ghost folders are final, the ghost list was not rewritten (the index
// job: Finish adding, Finish removing, Update the index); 'prepare': Prepare the upload again; 'unknown': Check the
// site. Pure: main.js draws it and runs the action. A dismissed notice stays dismissed in this tab (sessionStorage): the
// program keeps `interrupted` until a job starts, so a reload would show it again.
import { t, joinList } from './strings.js';
import { jobName } from './jobs.js';

/** sessionStorage key of the cut-off job whose notice this tab dismissed. */
export const DISMISSED_STORAGE = 'sumika-admin-dismissed';

/** The program's job kinds (CONTRACTS "Admin API" Job), the ones a journal can name. */
const JOB_KINDS = Object.freeze(['inspect', 'add', 'remove', 'index', 'check', 'prepare']);

/** One cut-off job (a start writes one journal per job: its kind, label and start time tell it). */
const tagOf = it => JSON.stringify([it.kind ?? null, it.label ?? '', it.startedAt ?? null]);

const storeOf = win => {
  try {
    return (win && win.sessionStorage) || null;
  } catch (e) {
    return null;
  }
};

/** Whether this tab dismissed this cut-off job's notice already. */
export function wasDismissed(win, it) {
  try {
    const s = storeOf(win);
    return !!s && s.getItem(DISMISSED_STORAGE) === tagOf(it);
  } catch (e) {
    return false;
  }
}

/** Remembers in this tab that its notice was dismissed (storage off: this page only). */
export function rememberDismissed(win, it) {
  try {
    const s = storeOf(win);
    if (s) s.setItem(DISMISSED_STORAGE, tagOf(it));
  } catch (e) { /* storage off */ }
}

/**
 * @param {{kind: string|null, label?: string, outcome?: string, ghosts?: {id, name, placed}[]}} it
 * @param {'ja'|'en'} L
 * @returns {{text: string, action: {key: string, run: 'dismiss'|'index'|'prepare'|'check'}}}
 */
export function interruptedNotice(it, L) {
  const ghosts = Array.isArray(it.ghosts) ? it.ghosts : [];
  const names = list => joinList(list.map(g => g.name || g.id), L);
  const label = String(it.label || '');
  const all = ghosts.length ? names(ghosts) : label;
  const kind = it.kind;
  if (it.outcome === 'unchanged') {
    const text = kind === 'inspect' ? t('job.interrupted.inspect', L, { names: label })
      : kind === 'check' ? t('job.interrupted.check', L)
        : kind === 'add' ? t('job.interrupted.addUnchanged', L, { names: all })
          : kind === 'remove' ? t('job.interrupted.removeUnchanged', L, { names: all }) : null;
    if (text) return { text, action: { key: 'job.interrupted.dismiss', run: 'dismiss' } };
  }
  if (it.outcome === 'index') {
    if (kind === 'add') {
      const placed = ghosts.filter(g => g.placed), missing = ghosts.filter(g => !g.placed);
      let text = t('job.interrupted.addIndex', L, { names: all, placed: placed.length ? names(placed) : all });
      if (placed.length && missing.length) text += `${L === 'ja' ? '' : ' '}${t('job.interrupted.notAdded', L, { names: names(missing) })}`;
      return { text, action: { key: 'job.interrupted.finishAdd', run: 'index' } };
    }
    if (kind === 'remove') return { text: t('job.interrupted.removeIndex', L, { names: all }), action: { key: 'job.interrupted.finishRemove', run: 'index' } };
    return { text: t('job.interrupted.index', L), action: { key: 'job.interrupted.runIndex', run: 'index' } };
  }
  if (it.outcome === 'prepare') return { text: t('job.interrupted.prepare', L), action: { key: 'job.interrupted.prepareAgain', run: 'prepare' } };
  const action = { key: 'job.interrupted.checkSite', run: 'check' };
  // a journal that names no job this page knows (a label or not): no "Working" for a name, no "Working (label)"
  if (!JOB_KINDS.includes(kind)) return { text: t('job.interrupted.unknownWhat', L), action };
  const job = label ? t('job.labelled', L, { job: jobName(kind, L), label }) : jobName(kind, L);
  return { text: t('job.interrupted.unknown', L, { job }), action };
}

// The Add screen's logic: what each inspected ghost (an inspectSource item with the
// program's `token`) needs before it can be added, and the plan POST /api/add takes: [{token, replace, keep, leaveOut}].
// A file the archive comparison flags is left out unless the admin ticks it (keep); a ghost whose folder exists on
// the site is added only when "replace" is ticked; any other refusal blocks the ghost. Pure.

/** The refusal codes of the archive comparison: the admin decides file by file ('archive': the core's older code). */
export const COMPARE_CODES = Object.freeze(['compare.unlisted', 'archive']);

export const codeOf = f => (f ? (f.code ?? f.why ?? null) : null);

/**
 * What an inspected ghost needs.
 * @returns {{flagged: object[], blocked: boolean, conflict: object|null, lost: object[]}} flagged: the files the
 *   comparison flags (each kept only when ticked); blocked: it cannot be added (a refusal, no token, or a re-copy that
 *   would lose bundled balloons); conflict: the site already has a folder of this id; lost: those balloons
 */
export function verdict(item) {
  const code = codeOf(item && item.refusal);
  const compare = COMPARE_CODES.includes(code);
  const flagged = compare && Array.isArray(item.refusal.files) ? item.refusal.files : [];
  const conflict = (item && item.conflict) || null;
  const lost = conflict && Array.isArray(conflict.lostBalloons) ? conflict.lostBalloons : [];
  const blocked = !item || !item.token || (!!code && !compare) || lost.length > 0;
  return { flagged, blocked, conflict, lost };
}

/** Whether an entry of the list goes into the next add: not blocked, and ticked (replace, for an existing folder). */
export function addable(entry) {
  const v = verdict(entry.item);
  if (v.blocked) return false;
  return v.conflict ? !!entry.replace : !!entry.include;
}

/** A new entry of the Add screen's list (include: ticked when its engine runs on Sumika). */
export function entryOf(item, { key, dropped = null } = {}) {
  return { key, item, dropped, include: !(item && item.runs && item.runs.ok === false), replace: false, keep: new Set() };
}

/** POST /api/add's plan for the entries to add. */
export function planOf(entries) {
  return entries.filter(addable).map(e => {
    const { flagged, conflict } = verdict(e.item);
    const paths = flagged.map(f => f.path);
    return {
      token: e.item.token,
      replace: !!conflict && !!e.replace,
      keep: paths.filter(p => e.keep.has(p)),
      leaveOut: paths.filter(p => !e.keep.has(p)),
    };
  });
}

const sourceKey = item => (item && item.source ? `${item.source.kind}|${item.source.path}|${item.source.root ?? ''}` : null);

/**
 * The list after an inspection: an item of the same source (or token) replaces its entry in place (a comparison
 * asked again), the others are appended. makeEntry(item) builds a new entry.
 */
export function mergeItems(entries, items, makeEntry) {
  const out = [...entries];
  const added = [];
  for (const item of items || []) {
    const i = out.findIndex(e => (item.token && e.item.token === item.token) || (sourceKey(item) && sourceKey(e.item) === sourceKey(item)));
    const fresh = makeEntry(item, i >= 0 ? out[i] : null);
    if (i >= 0) out[i] = fresh;
    else out.push(fresh);
    added.push(fresh);
  }
  return { entries: out, added };
}

/**
 * The add job's result, entry by entry: [{entry, ok, id, name, error}] (an entry is null when the program names a
 * ghost the list lacks). The result is {results: [...]} (also accepted: a bare list, {items}, or {added, failed}); each
 * row names its plan row by `token` (else `id`) and fails with `error` or `refusal`.
 */
export function addResults(result, entries) {
  let rows;
  if (Array.isArray(result)) rows = result;
  else if (result && Array.isArray(result.results)) rows = result.results;
  else if (result && Array.isArray(result.items)) rows = result.items;
  else if (result && (Array.isArray(result.added) || Array.isArray(result.failed))) {
    rows = [...(result.added || []).map(r => ({ ...r, ok: true })), ...(result.failed || []).map(r => ({ ...r, ok: false }))];
  } else rows = [];
  return rows.map(r => {
    const entry = entries.find(e => r.token && e.item.token === r.token)
      || entries.find(e => r.id && e.item.id === r.id) || null;
    const error = r.error || r.refusal || null;
    const ok = r.ok !== undefined ? !!r.ok : !error;
    return {
      entry, ok, error,
      id: r.id ?? (entry && entry.item.id) ?? null,
      name: r.name ?? (entry && entry.item.name) ?? r.id ?? null,
    };
  });
}

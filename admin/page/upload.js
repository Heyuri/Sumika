// Prepare upload's answer as the Check and upload screen shows it (CLAUDE.md "Publishing flow" step 7): the files to
// upload in the order a host that takes files one by one needs (everything else, then sumika/index.html, the control
// page, then sumika/hub.html, then sumika/sumika.js, last sumika/index/ghosts.json: the program's own LAST,
// admin/server/upload.mjs, which the page cannot import), the optional ones marked (the .map files and the engine files
// without a hash in their name: docs/guide.md "You may leave out"), what prune deleted (to delete on the host too),
// retired and kept; and what a refused Prepare upload asks (prepareAsks). Pure.

/** The fixed-name files, in upload order, after everything else (each page after the hashed script it names). */
export const LAST = Object.freeze(['sumika/index.html', 'sumika/hub.html', 'sumika/sumika.js', 'sumika/index/ghosts.json']);

/** docs/guide.md "You may leave out": the source maps and the plain engine files (satori.js, yaya.wasm, …). */
export const optionalPath = p => /\.map$/i.test(p) || /^sumika\/engines\/[a-z0-9_]+\.(js|wasm)$/i.test(p);

const entry = x => (typeof x === 'string' ? { path: x, optional: optionalPath(x) }
  : { path: String(x.path), optional: x.optional !== undefined ? !!x.optional : optionalPath(String(x.path)) });

const paths = v => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : String(x && x.path))) : []);

/**
 * @param {object} result  the prepare job's result: the upload list as `upload` (a list, or {rest, last}), `files` or
 *   `list`; prune's `deleted`, `retired`, `kept`; `ledger` (its path)
 * @returns {{rest: {path: string, optional: boolean}[], last: {path: string, optional: boolean}[], deleted: string[],
 *   retired: string[], kept: string[], ledger: string|null, setAside: string|null}} setAside: where Start a new record
 *   put the ledger that did not read
 */
export function uploadGroups(result) {
  const r = result || {};
  let list = [];
  if (Array.isArray(r.upload)) list = r.upload;
  else if (r.upload && typeof r.upload === 'object') list = [...(r.upload.rest || []), ...(r.upload.last || [])];
  else if (Array.isArray(r.files)) list = r.files;
  else if (Array.isArray(r.list)) list = r.list;
  const all = list.map(entry).filter(e => e.path && !/^dev\//.test(e.path));
  const rest = all.filter(e => !LAST.includes(e.path));
  const last = LAST.map(p => all.find(e => e.path === p)).filter(Boolean);
  const pr = r.prune && typeof r.prune === 'object' ? r.prune : r;
  return {
    rest, last,
    deleted: paths(pr.deleted), retired: paths(pr.retired), kept: paths(pr.kept),
    ledger: typeof r.ledger === 'string' ? r.ledger : null,
    setAside: typeof r.setAside === 'string' ? r.setAside : null,
  };
}

/**
 * What a Prepare upload that did not go through asks of the admin (the Check and upload screen): 'first' (needs-first:
 * whether the site was ever uploaded, the question), 'newRecord' (ledger-unreadable: the one button Start a new
 * record), else null (its finding is said as it is).
 * @param {string|{state?: string, error?: {code?: string}}|null} job  the finished job, or the code its start was
 *   refused with
 */
export function prepareAsks(job) {
  const code = typeof job === 'string' ? job : job && job.state === 'failed' && job.error ? job.error.code : null;
  return code === 'needs-first' ? 'first' : code === 'ledger-unreadable' ? 'newRecord' : null;
}

/** The whole list as text, one path a line, in upload order. */
export const uploadText = g => [...g.rest, ...g.last].map(e => e.path).join('\n');

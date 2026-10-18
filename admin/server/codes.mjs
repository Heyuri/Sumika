// The admin program's own codes (CONTRACTS "Admin API"): the API's errors, the settings file, the version guard, the
// drops, the jobs, what Check finds beyond the core's findings, and hub.json entries; code -> English text. The core's
// codes (admin/core/codes.mjs) pass through unchanged. The page translates both lists (`code.<code>` in
// admin/page/strings.js, whose strings test reads CODE_LIST: keep it exported); `message` is the English fallback (the
// API's `message`, logs), worded as the page's English (CLAUDE.md "Wording": no inner term of the program).

/** What the program is busy with, as busy's English names it (the page's `job.<kind>`). */
const BUSY_WITH = Object.freeze({
  inspect: 'looking at the ghosts to add', add: 'adding ghosts', remove: 'removing a ghost', index: 'updating the index',
  check: 'checking the site', prepare: 'preparing the upload',
});

/** An optional detail in parentheses: {error}, or the code a program part ended with ({exit}). */
const detail = p => (p.error ? ` (${p.error})` : p.exit !== undefined && p.exit !== null ? ` (code ${p.exit})` : '');

/** code -> (params) => English text */
export const CODES = Object.freeze({
  // ---- the guards and the API ----
  'bad-host': () => 'the page was opened under another address than sumika-admin gave',
  'bad-origin': () => 'the request came from another page than sumika-admin\'s',
  'no-key': () => 'this page was not opened from the address sumika-admin shows in its window',
  'bad-key': () => 'this tab belongs to an earlier start of sumika-admin: open the address its window shows now',
  'method': () => 'this action is not allowed here',
  'not-found': () => 'sumika-admin has no such address',
  'too-large': () => 'the request is too large (over 1 MiB)',
  'not-json': () => 'the request was not in the form sumika-admin reads (JSON)',
  'bad-request': p => `a malformed request${p.detail ? `: ${p.detail}` : ''}`,
  'internal': p => `sumika-admin ran into an unexpected error (${p.error}): try again; if it happens again, close `
    + 'sumika-admin and start it again',
  'busy': p => `sumika-admin is busy (${BUSY_WITH[p.kind] || 'working'}): wait until that has finished, then try again`,

  // ---- the site ----
  'no-site': () => 'choose the site folder first, on the Site screen',
  'not-a-site': p => `${p.path} is not a Sumika site folder: it has no sumika/sumika.js and sumika/build.json; choose `
    + 'the folder that holds the sumika folder',
  'project-site': p => `${p.path} is the project's own site/ folder or inside it: a development run never changes it`,
  'read-only': p => 'this sumika-admin cannot change this site, so nothing was changed: '
    + `${CODES[p.reason] ? CODES[p.reason](p) : p.reason}`,
  'index-format': p => `it was made with another version of Sumika: its index is format ${p.format}, and this `
    + `sumika-admin writes format ${p.expected}`,
  'schema': p => `it was made with a newer Sumika than this sumika-admin: its runtime keeps ${p.kind} data in version `
    + `${p.schema}, and this sumika-admin knows up to ${p.expected}`,

  // ---- paths and the file browser ----
  'path-not-absolute': p => `not a full path: ${p.path}`,
  'path-missing': p => `no such file or folder: ${p.path}`,
  'path-not-folder': p => `not a folder: ${p.path}`,
  'path-no-access': p => `${p.path} cannot be read (${p.error})`,

  // ---- the file dialogs (picker.mjs) ----
  'no-picker': p => `sumika-admin could not open a file window on this computer${detail(p)}: pick in this page instead`,
  'picker-open': () => 'a file window is open already: finish it or cancel it first',

  // ---- the settings file ----
  'settings-unreadable': p => `the settings file ${p.file} cannot be read (${p.error}), so the default settings are used; `
    + 'the file is left as it is',
  'settings-bad': p => `the settings file ${p.file} is not one sumika-admin reads (${p.error}), so the default settings `
    + 'are used; the file is left as it is',
  'settings-write': p => `the settings could not be saved to ${p.file} (${p.error})`,

  // ---- drag-and-drop ----
  'drop-missing': () => 'the dropped files are no longer there (sending was stopped or failed, or they were added '
    + 'already): drop them again',
  'drop-closed': () => 'these dropped files were all sent already: drop them again',
  'drop-bad-path': p => `a file name sumika-admin cannot save: ${p.path}`,
  'drop-exists': p => `sent twice: ${p.path}`,
  'drop-write': p => `the dropped files could not be saved (${p.error}); what had been sent was deleted`,
  'drop-bad-root': p => `the dropped ${p.name} did not arrive`,

  // ---- jobs ----
  'token-unknown': () => 'sumika-admin no longer has this ghost ready to add (dropped files can be added only once): '
    + 'pick or drop it again; nothing was added',
  // {exit}: the code the job's worker ended with, without an answer (the log says it was the worker)
  'job-crashed': p => `it stopped because of an unexpected error${detail(p)}, so it may be only partly done: check the `
    + 'site to see what is left to fix',
  'job-failed': p => `it failed because of an unexpected error (${p.error}), so it may be only partly done: check the `
    + 'site to see what is left to fix',
  'needs-first': () => 'there is no record of earlier uploads yet: say whether this is the site\'s first upload',
  'ledger-exists': p => `this site has a record of its uploads (${p.ledger}): "first upload" and "record lost" are `
    + 'for a site without one',
  // tools/prune.mjs's refusal `bad-ledger` (its CLI line names its flags): the page offers Start a new record
  'ledger-unreadable': p => `${p.ledger} cannot be read. It is the record of what was uploaded before, kept beside the `
    + 'site folder so that it is never uploaded. Nothing was changed. To go on, press Start a new record: the unreadable '
    + `file is kept under another name, nothing is deleted now, and old files are kept ${p.days} more days`,
  // Start a new record met a record that reads (repaired meanwhile, or another tab started one first): left as it is
  'ledger-reads': p => `${p.ledger} can be read now, so it was left as it is and no new record was started: press `
    + 'Prepare upload again',
  'check-failed': p => `Check found problems (${p.count}): fix them first`,
  'prune-refused': p => `the old files were not cleaned up: ${p.message}`,
  'preview-failed': p => `the preview could not start (${p.error})`,

  // ---- Check, beyond the core's findings ----
  'index-stale': p => `the index is not up to date (${p.count} file(s) to write): update the index`,
  'no-index': () => 'the site has no index yet (sumika/index/ghosts.json): update the index',
  'bad-index': p => `sumika/index/ghosts.json cannot be read (${p.error}): update the index to write it anew`,
  // tools/prune.mjs's refusal `no-manifests` (its CLI line names the Python tool): ghosts.json names no manifests
  'index-old': () => 'the index (sumika/index/ghosts.json) is out of date: update the index',
  'runtime-missing': p => `${p.file} is missing (a file of the runtime build or of the index)`,
  'bundle-stale': p => (p.file ? `sumika/sumika.js does not name ${p.file}: the runtime build did not finish`
    : 'sumika/sumika.js is not the build sumika/build.json describes: the runtime build did not finish'),
  'hub-html': () => 'sumika/hub.html does not name the hub script sumika/build.json names',
  'control-html': () => 'sumika/index.html (the page where visitors turn Sumika on or off) does not name the script '
    + 'sumika/build.json names for it',
  'bad-json': p => `${p.file} is not JSON`,
  'runtime-problem': p => `the runtime files: ${p.detail}`,
  'no-404': () => 'there is no 404.html at the top of the site (some hosts need it to answer "not found")',

  // ---- hub.json entries (hubentry.mjs) ----
  'not-string': () => 'not a text',
  'wildcard': () => 'no wildcards: list each address',
  'not-absolute': () => 'not a full address (https://…)',
  'not-http': () => 'not an http or https address',
  'userinfo': () => 'has a user name or password',
  'query-or-fragment': () => 'has a ? or # part',
  'has-path': () => 'has a path: list the address only (scheme, host and port)',
  'loopback': () => 'a loopback address (localhost, 127.x.x.x): a published hub ignores it',
});

/** Every code, for the admin page's strings test. */
export const CODE_LIST = Object.freeze(Object.keys(CODES));

/** The English text of a code (the code itself for one this table lacks). */
export function message(code, params = {}) {
  const f = CODES[code];
  return f ? f(params || {}) : String(code);
}

/** A Finding of the program: {code, params?, message}. */
export function finding(code, params = undefined) {
  return params === undefined ? { code, message: message(code) } : { code, params, message: message(code, params) };
}

/** An API refusal: the status and the Finding the answer carries. */
export class ApiError extends Error {
  constructor(status, code, params = undefined) {
    super(message(code, params));
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.params = params;
  }

  toJSON() {
    return this.params === undefined ? { code: this.code, message: this.message }
      : { code: this.code, params: this.params, message: this.message };
  }
}

/** A job's failure with a code (prepare's check-failed carries its problems). */
export class JobError extends Error {
  constructor(code, params = undefined, extra = {}) {
    super(message(code, params));
    this.name = 'JobError';
    this.code = code;
    this.params = params;
    Object.assign(this, extra);
  }

  toJSON() {
    const out = this.params === undefined ? { code: this.code, message: this.message }
      : { code: this.code, params: this.params, message: this.message };
    if (this.problems) out.problems = this.problems;
    return out;
  }
}

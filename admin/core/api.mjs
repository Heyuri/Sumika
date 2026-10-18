// The admin core's API (CLAUDE.md "The admin tool"; docs/CONTRACTS.md "Admin core"): what the admin program (a local
// server, admin/server/) and admin/cli.mjs call. Every function works on folders given to it, never on the project's
// site unless named; results are plain JSON-able objects; every finding is a code (codes.mjs CODE_LIST) with params and
// its English text; a refusal is an AdminRefusal (toJSON: {code, params, message, files}). The core prints nothing.
export { inspectSource, addGhost, removeGhost, idProblem, proposeId } from './add.mjs';
export { indexSite, indexState, personalFiles } from './index.mjs';
export { checkSite, hubFindings, hubJsonProblems, siteLinks } from './check.mjs';
export { WORK_DIR, recoverWork, workLeftovers } from './staging.mjs';
export { AdminRefusal, refusalOf } from './refusal.mjs';
export { CODES, CODE_LIST, message } from './codes.mjs';
export { FORMAT } from './rules.mjs';

// The job worker's entry (the core is synchronous, so a long job runs in a node:worker_threads
// worker and never freezes the server; one fresh worker per job). workerData {kind, args, journal}; it posts {type:
// 'progress', phase, done, total, item} (at most every 100 ms, a phase's first and last step always), then one {type:
// 'done', result} or {type: 'error', error: Finding} (job-failed with its `stack`, for the log). It writes the job's
// steps into the journal file itself (instance.mjs journalSteps), before each step begins: a message to the main
// thread could arrive after a closed window ended both. Bundled on its own (admin/build/job.mjs) and embedded in the
// compiled program with `--include`.
import { parentPort, workerData } from 'node:worker_threads';
import * as core from '../core/api.mjs';
import { work, errorFinding } from './work.mjs';
import { journalSteps } from './instance.mjs';

const PROGRESS_MS = 100;

let last = 0, lastPhase = null;
const onProgress = p => {
  const now = Date.now();
  const edge = p.phase !== lastPhase || p.done === 0 || (p.total !== null && p.total !== undefined && p.done >= p.total);
  if (!edge && now - last < PROGRESS_MS) return;
  last = now;
  lastPhase = p.phase;
  parentPort.postMessage({ type: 'progress', phase: p.phase ?? null, done: p.done ?? 0, total: p.total ?? null, item: p.item ?? null });
};

if (parentPort && workerData) {
  const onStep = typeof workerData.journal === 'string' ? journalSteps(workerData.journal) : () => {};
  try {
    const result = await work(workerData.kind, workerData.args, { core, onProgress, onStep });
    parentPort.postMessage({ type: 'done', result });
  } catch (e) {
    const error = errorFinding(e);
    if (error.code === 'job-failed' && e && typeof e.stack === 'string') error.stack = e.stack;
    parentPort.postMessage({ type: 'error', error });
  }
}

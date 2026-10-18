// One job at a time (CONTRACTS "Admin API"): inspect, add, remove, index, check, prepare. A job runs in a fresh
// node:worker_threads worker (workerRunner: job.mjs; Deno implements node:worker_threads, and the compiled program
// embeds the worker bundle with --include), so the server answers status polls, quick reads and Quit meanwhile. The
// last job, running or finished, is kept until the next starts; the journal (job.json) is written at a start, stepped
// by the job (instance.mjs journalSteps) and deleted at the end, so a job a closed window cut off is known at the next
// start, with how far it got. A job that crashed or failed goes to the log (log.mjs) with its stack. While the start
// settles what an earlier one left (hold: main.mjs), a job asked for waits in phase 'settle', then begins.
import { Worker } from 'node:worker_threads';
import crypto from 'node:crypto';
import { ApiError, message } from './codes.mjs';

/**
 * job-crashed: its params in plain words for the page ({error} or the worker's {exit} code), `detail` and `stack` for
 * the log only (Jobs keeps both out of the API's answers) [decision: no inner term in what the admin reads].
 */
const crashed = (params, { detail = null, stack = null } = {}) => {
  const f = { code: 'job-crashed', params, message: message('job-crashed', params) };
  if (detail) f.detail = detail;
  if (stack) f.stack = stack;
  return f;
};
const crashedBy = e => crashed({ error: String((e && e.message) || e) }, { stack: e && typeof e.stack === 'string' ? e.stack : null });

/**
 * A runner that starts one worker per job: (kind, args, onProgress, {journal}) → Promise<result>, rejected with a
 * Finding. The worker gets an empty environment (`env: {}`): Node's default copies process.env into it, which Deno's
 * node:worker_threads does by listing every variable (Deno.env.toObject), a permission the compiled program has not
 * got (--allow-env names eight), so Deno asked "Allow? [y/n/A]" in the console window and the whole program waited
 * there for an answer [measured, Deno 2.9.7: two "has stopped" pages]. The job reads no
 * variable: the server passes the folders it needs (tempDir).
 * @param {URL|string} [url] the worker's module (next to this one, as admin/build/ keeps the bundles side by side)
 */
export function workerRunner(url = new URL('./job.mjs', import.meta.url)) {
  const runner = (kind, args, onProgress, { journal = null } = {}) => new Promise((resolve, reject) => {
    let settled = false;
    let w;
    const end = (fn, v) => {
      if (settled) return;
      settled = true;
      runner.current = null;
      Promise.resolve().then(() => w && w.terminate()).catch(() => {});
      fn(v);
    };
    try {
      w = new Worker(url, { workerData: { kind, args, journal }, env: {} });
    } catch (e) {
      reject(crashedBy(e));
      return;
    }
    runner.current = w;
    w.on('message', m => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'progress') onProgress(m);
      else if (m.type === 'done') end(resolve, m.result);
      else if (m.type === 'error') end(reject, m.error);
    });
    w.on('error', e => end(reject, crashedBy(e)));
    w.on('exit', code => end(reject, crashed({ exit: code }, { detail: `the job's worker exited (${code}) without an answer` })));
  });
  runner.current = null;
  /** Stops the running worker at once (the program is closing). */
  runner.stop = () => {
    const w = runner.current;
    runner.current = null;
    if (w) w.terminate().catch(() => {});
  };
  return runner;
}

export class Jobs {
  /**
   * @param {{runner: Function, journal?: {file?: string, write: Function, clear: Function}|null, now?: () => number,
   *   log?: {write: (what: string, detail?: string) => void}|null}} o runner: (kind, args, onProgress, {journal}) →
   *   Promise<result> (workerRunner, or an in-process one in tests; journal: the journal's file, for the job's steps)
   */
  constructor({ runner, journal = null, now = () => Date.now(), log = null }) {
    this.runner = runner;
    this.journal = journal;
    this.now = now;
    this.log = log;
    this.current = null;
    this.done = Promise.resolve();
    this.closed = false;
    this.holding = false;
    this.ready = Promise.resolve();
  }

  get running() {
    return !!this.current && this.current.state === 'running';
  }

  /**
   * Jobs begin only once `ready` has settled (the start's settling of the work folder: main.mjs). One started
   * meanwhile is running in phase 'settle' and writes its journal when it begins, so the earlier start's journal
   * stays the only one until it is settled.
   * @param {Promise<*>} ready
   */
  hold(ready) {
    this.holding = true;
    const p = Promise.resolve(ready).catch(() => {}).then(() => {
      if (this.ready === p) this.holding = false;
    });
    this.ready = p;
  }

  /** The last job as the API shows it (a copy), or null. */
  snapshot() {
    return this.current ? { ...this.current } : null;
  }

  /**
   * Starts a job; 409 busy while one runs.
   * @param {string} kind
   * @param {object} args
   * @param {{label?: string, after?: (result: object) => object|Promise<object>, failed?: Function,
   *   journal?: object}} [o] after: the main thread's part on the result (it may change it); failed: called with the
   *   error Finding; journal: more for the journal (a write job's `site` and `ghosts: [{id, name}]`)
   * @returns {object} the job, as it starts
   */
  start(kind, args, { label = '', after = null, failed = null, journal = null } = {}) {
    if (this.closed) throw new ApiError(409, 'busy', { kind: 'quit' });
    if (this.running) throw new ApiError(409, 'busy', { kind: this.current.kind });
    const job = {
      id: crypto.randomBytes(6).toString('hex'), kind, state: 'running', phase: null, done: 0, total: null, item: null,
      label, startedAt: this.now(), endedAt: null,
    };
    this.current = job;
    const begin = () => {
      if (!this.journal) return;
      try {
        this.journal.write({ id: job.id, kind, label, startedAt: job.startedAt, ...(journal || {}), step: null, placed: [] });
      } catch (e) { /* the journal is a help only */ }
    };
    const held = this.holding;
    if (held) job.phase = 'settle';
    else begin();
    const onProgress = p => {
      if (job.state !== 'running') return;
      if (p.phase !== undefined) job.phase = p.phase;
      job.done = Number.isFinite(p.done) ? p.done : 0;
      job.total = Number.isFinite(p.total) ? p.total : null;
      job.item = typeof p.item === 'string' ? p.item : null;
    };
    const fail = error => {
      const f = error && typeof error === 'object' && typeof error.code === 'string' ? error : crashedBy(error);
      const { stack, detail, ...shown } = f;
      job.error = shown;
      job.state = 'failed';
      // a worker stopped because the program is closing is no crash: the next start logs the cut-off job
      if (this.log && !this.closed && (f.code === 'job-crashed' || f.code === 'job-failed')) {
        this.log.write(`job ${kind}${label ? ` (${label})` : ''} ended ${f.code}: ${f.message}${detail ? ` [${detail}]` : ''}`, stack || '');
      }
    };
    this.done = (held ? this.ready.then(() => {
      // a program closing while the job waited: it never began (no journal, nothing to cut off)
      if (this.closed) throw crashed({}, { detail: 'the program closed before the job began' });
      if (job.phase === 'settle') job.phase = null;
      begin();
    }) : Promise.resolve())
      .then(() => this.runner(kind, args, onProgress, { journal: this.journal && this.journal.file ? this.journal.file : null }))
      .then(async result => {
        job.result = after ? await after(result) : result;
        job.state = 'done';
      }, async error => {
        fail(error);
        if (failed) await failed(job.error);
      })
      .catch(e => fail(e))
      .finally(async () => {
        job.endedAt = this.now();
        if (this.journal && !this.closed) {
          try { await this.journal.clear(job.id); } catch (e) { /* the journal is a help only */ }
        }
      });
    return { ...job };
  }

  /** The program is closing: no new job, a running worker stopped, the journal left for the next start. */
  close() {
    this.closed = true;
    if (this.running && this.runner.stop) this.runner.stop();
  }
}

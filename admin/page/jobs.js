// Jobs and the status line. The page polls GET /api/status every 10 s, every second
// while a job runs or the page waits for one, and follows a job it started by its id until it is done or failed (one
// job at a time on the program, across tabs: the last job's result stays until the next starts). A poll that gets no
// answer waits in the API client until the program answers again (api.js), so a followed job is still followed after
// it; a 403 (this tab belongs to an earlier start) or the page's end stops polling. The status line
// (role="status") is written at most every 5 s and at once when the job, its state or its phase changes. Timers are
// passed in, so tests run it without waiting.
import { t, has, findingText } from './strings.js';

export const FAST_MS = 1000;
export const SLOW_MS = 10000;
export const SAY_MS = 5000;

/** A job kind as the status line names it. */
export const jobName = (kind, lang) => t(has(`job.${kind}`) ? `job.${kind}` : 'job.other', lang);

/** The status line's text for the program's current or last job (null: nothing has run). */
export function statusText(job, lang = 'en') {
  if (!job) return t('status.ready', lang);
  const name = jobName(job.kind, lang);
  if (job.state === 'done') return t('status.done', lang, { job: name });
  if (job.state === 'failed') return t('status.failed', lang, { job: name, why: findingText(job.error, lang) });
  // a phase named like its job (the add job's 'add', inspect's 'inspect') says nothing more
  let s = job.phase && job.phase !== job.kind && has(`phase.${job.phase}`)
    ? t('status.phase', lang, { job: name, phase: t(`phase.${job.phase}`, lang) }) : t('status.running', lang, { job: name });
  if (typeof job.total === 'number' && job.total > 0) {
    s += `${lang === 'ja' ? '' : ' '}${t('status.count', lang, { done: job.done || 0, total: job.total })}`;
  }
  return s;
}

/** Writes `text` at most every `ms`, at once when `key` changes; the last text always arrives. */
export class Throttled {
  constructor(write, { ms = SAY_MS, timers = globalThis, now = () => Date.now() } = {}) {
    this.write = write;
    this.ms = ms;
    this.timers = timers;
    this.now = now;
    this.last = -Infinity;
    this.key = undefined;
    this.timer = null;
    this.pending = null;
  }

  set(text, key = null) {
    const now = this.now();
    if (key !== this.key || now - this.last >= this.ms) {
      this.key = key;
      this._flush(text, now);
      return;
    }
    this.pending = text;
    if (this.timer === null) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        if (this.pending !== null) this._flush(this.pending, this.now());
      }, this.last + this.ms - now);
    }
  }

  _flush(text, now) {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.last = now;
    this.write(text);
  }

  dispose() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * The program's job and preview, polled, and what status says beside them: an open file dialog (`pick`) and whether
 * the start is still settling what an earlier one left (`starting`: polled every second while it is).
 * onChange({job, preview, pick, starting}) after every answer (pick undefined: the answer did not say); onEnd('auth' |
 * 'offline': the page ended) when polling stops for good.
 */
export class Jobs {
  constructor({ api, onChange = () => {}, onEnd = () => {}, timers = globalThis }) {
    this.api = api;
    this.onChange = onChange;
    this.onEnd = onEnd;
    this.timers = timers;
    this.job = null;
    this.preview = null;
    this.starting = false;
    this.waiters = new Map();            // job id -> {since, resolve}[]
    this.seq = 0;                        // polls started
    this.timer = null;
    this.running = false;
    this.ended = false;
  }

  /** a job is running on the program */
  get busy() {
    return !!(this.job && this.job.state === 'running');
  }

  start() {
    this.running = true;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Polls now (after starting a job), then on the usual schedule. */
  kick() {
    if (!this.running) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this._poll();
  }

  _schedule() {
    if (!this.running || this.timer !== null) return;
    const ms = this.busy || this.waiters.size || this.starting ? FAST_MS : SLOW_MS;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this._poll();
    }, ms);
  }

  async _poll() {
    const seq = ++this.seq;
    try {
      const s = await this.api.status();
      this.update(s || {}, seq);
    } catch (e) {
      if (e && (e.offline || e.auth)) {
        this.stop();
        this.end(e.auth ? 'auth' : 'offline');
        return;
      }
    }
    this._schedule();
  }

  /** Polling has ended for good (Quit, the tab's key is old): every waiter gets a failed job. */
  end(why) {
    if (this.ended) return;
    this.ended = true;
    this.stop();
    for (const [id, list] of this.waiters) {
      for (const w of list) w.resolve({ id, state: 'failed', error: { code: why === 'auth' ? 'bad-key' : 'offline' } });
    }
    this.waiters.clear();
    this.onEnd(why);
  }

  /**
   * An answer that carries the job (hello, status, a job's start). seq: the poll it answers (a poll sent before a
   * waiter started cannot tell that waiter its job was replaced).
   */
  update({ job = undefined, preview = undefined, pick = undefined, starting = undefined } = {}, seq = null) {
    if (job !== undefined) this.job = job;
    if (preview !== undefined) this.preview = preview;
    if (starting !== undefined) this.starting = starting === true;
    const cur = this.job;
    for (const [id, list] of [...this.waiters]) {
      if (cur && cur.id === id && cur.state !== 'running') {
        this.waiters.delete(id);
        for (const w of list) w.resolve(cur);
      } else if (cur && cur.id !== id && seq !== null) {
        const keep = list.filter(w => seq <= w.since);
        for (const w of list.filter(x => seq > x.since)) w.resolve({ id, state: 'failed', error: { code: 'job-replaced' } });
        if (keep.length) this.waiters.set(id, keep);
        else this.waiters.delete(id);
      }
    }
    this.onChange({ job: this.job, preview: this.preview, pick, starting: this.starting });
  }

  /**
   * Follows a job the page started (the answer of POST /api/inspect, /api/add, …) until it is done or failed.
   * @returns {Promise<object>} the finished job ({state: 'done', result} or {state: 'failed', error})
   */
  follow(job) {
    if (!job || !job.id) return Promise.resolve({ state: 'failed', error: { code: 'error', message: 'no job' } });
    if (this.ended) return Promise.resolve({ id: job.id, state: 'failed', error: { code: 'offline' } });
    const p = new Promise(resolve => {
      const list = this.waiters.get(job.id) || [];
      list.push({ since: this.seq, resolve });
      this.waiters.set(job.id, list);
    });
    this.update({ job });
    this.kick();
    return p;
  }
}

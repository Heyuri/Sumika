// The page's side of the admin API (CONTRACTS "Admin API", the contract with the program): JSON in and out, every
// /api/ call with the key the program gave in its address (kept in the tab's sessionStorage) as X-Sumika-Admin-Key,
// paths only in bodies or a header, never in the URL. An error answer is {error: {code, params?, message}}; it becomes
// an ApiError. A 403 (no-key, bad-key, bad-host, bad-origin) means this tab belongs to an earlier start of the program.
// A request that gets no answer (the fetch fails; a status call unanswered for STATUS_MS) is no stopped program yet
// [decision: a program that only waits is no stopped one]: the client asks GET /api/status until the program answers
// (BACKOFF_MS apart; after WAIT_MS the page says it may be closed or stuck, and the client asks every RETRY_MS, for as
// long as the page is open), then carries on: a read is sent again, a job start whose answer was lost is found in the
// status (sent again only when no job started since it was sent), so nothing runs twice. Pure: fetch and the timers are
// passed in (tests use fakes).

export const KEY_HEADER = 'X-Sumika-Admin-Key';
export const PATH_HEADER = 'X-Sumika-Path';
/** the 403 codes (CONTRACTS "Admin API" guards): the page then tells "this tab belongs to an earlier start" */
export const AUTH_CODES = Object.freeze(['no-key', 'bad-key', 'bad-host', 'bad-origin']);
/** sessionStorage key of the program's key (CONTRACTS "Admin API" opening) */
export const KEY_STORAGE = 'sumika-admin-key';

/** A status call (or hello) unanswered this long counts as no answer: a stuck program (it answers in milliseconds). */
export const STATUS_MS = 10000;
/** One status call while waiting for the program, unanswered this long, counts as no answer. */
export const PROBE_MS = 5000;
/** Between the status calls while waiting: then the last one again. */
export const BACKOFF_MS = Object.freeze([500, 1000, 2000]);
/** Waiting this long without an answer: the stopped state ('stopped'), the page says the program may be closed or stuck. */
export const WAIT_MS = 20000;
/** Between the status calls in the stopped state, until the program answers or the page is closed. */
export const RETRY_MS = 3000;
/** A job that started up to this long before a lost start was sent counts as started by it (clocks of one computer,
 * which a browser may round: Firefox's resistFingerprinting to 100 ms). Errs toward "it started": never twice. */
export const START_SLACK_MS = 1000;
/** A request is sent at most this often while the program answers in between (then the code not-sent). */
export const MAX_SENDS = 3;

/** The job kind a lost start's answer is looked for in the status, by its route (the drop's done starts an inspect). */
function jobKindOf(method, path) {
  if (method !== 'POST') return null;
  const m = /^\/api\/(inspect|add|remove|index|check|prepare)$/.exec(path);
  if (m) return m[1];
  return /^\/api\/drop\/[^/]+\/done$/.test(path) ? 'inspect' : null;
}

/** The refusal codes that, answering a request sent again after its answer was lost, say the first one arrived. */
function arrivedCodes(method, path) {
  if (method === 'PUT') return ['drop-exists'];                          // the file was written whole
  if (method === 'POST' && /^\/api\/drop\/[^/]+\/cancel$/.test(path)) return ['drop-missing'];
  return [];
}

const abortError = () => {
  const e = new Error('stopped');
  e.name = 'AbortError';
  return e;
};

export class ApiError extends Error {
  /** @param {{status?: number, code?: string, params?: object|null, message?: string, files?: object[]|null}} o */
  constructor({ status = 0, code = 'error', params = null, message = '', files = null } = {}) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.params = params;
    this.files = files;
  }

  /** this tab's key is not (or no longer) the program's */
  get auth() { return this.status === 403; }

  /** no answer, and the page has ended (api.end()): the client waits for the program otherwise */
  get offline() { return this.status === 0 && this.code === 'offline'; }

  /** {code, params, message}: a finding as strings.js findingText reads it */
  toJSON() {
    return { code: this.code, params: this.params, message: this.message, ...(this.files ? { files: this.files } : {}) };
  }
}

/** A path inside a drop, percent-encoded segment by segment for the X-Sumika-Path header (header values are bytes). */
export function encodeRel(rel) {
  return String(rel).split('/').map(encodeURIComponent).join('/');
}

/**
 * The key the program put in the page's address (`?key=`), moved to the tab's sessionStorage, the address cleaned to
 * `/` (a launcher may lose a fragment, none drops a query); else the one this tab kept. null: none.
 * @param {{location: {search: string}, history?: {replaceState: Function}, sessionStorage?: Storage}} win
 */
export function takeKey(win) {
  let key = null;
  try {
    key = new URLSearchParams(win.location.search).get('key');
  } catch (e) {
    key = null;
  }
  const store = (() => { try { return win.sessionStorage || null; } catch (e) { return null; } })();
  if (key) {
    try { if (store) store.setItem(KEY_STORAGE, key); } catch (e) { /* storage off: the key lives in memory only */ }
    try { if (win.history) win.history.replaceState(null, '', '/'); } catch (e) { /* keep the address */ }
    return key;
  }
  try { return (store && store.getItem(KEY_STORAGE)) || null; } catch (e) { return null; }
}

async function readBody(res) {
  const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  if (/json/i.test(type)) {
    try { return await res.json(); } catch (e) { return null; }
  }
  try { return await res.text(); } catch (e) { return null; }
}

/** An error answer as an ApiError. */
function answerError(res, data) {
  const e = (data && typeof data === 'object' && data.error) || {};
  return new ApiError({
    status: res.status, code: typeof e.code === 'string' ? e.code : `http-${res.status}`, params: e.params || null,
    message: e.message || (typeof data === 'string' ? data : '') || res.statusText || '', files: e.files || null,
  });
}

/**
 * The API client.
 * @param {{key: string, fetch?: Function, base?: string, onAuthLost?: (e: ApiError) => void,
 *   onState?: (state: 'waiting'|'stopped'|'ok') => void, timers?: {setTimeout: Function, clearTimeout: Function},
 *   now?: () => number}} o onState: the program gave no answer and the client waits for it ('waiting'), has waited
 *   WAIT_MS ('stopped': closed or stuck), or answers again ('ok'); never twice the same in a row
 */
export function createApi({ key, fetch: doFetch = (...a) => globalThis.fetch(...a), base = '', onAuthLost = () => {},
  onState = () => {}, timers = globalThis, now = () => Date.now() }) {
  let ended = false;           // the page is done with the program (Quit, an old tab): no more waiting
  let waiting = null;          // the wait for an answer in progress: Promise<the status answer>
  let state = 'ok';
  let wake = null;             // ends the wait's pause at once (end())

  /** No more waiting: a wait in progress ends at once (its calls fail with what they lost). */
  const stop = () => {
    ended = true;
    if (wake) wake();
  };

  const setState = s => {
    if (s === state) return;
    state = s;
    onState(s);
  };

  /** One fetch; a timeout (ms > 0) makes an unanswered one a TimeoutError, the caller's signal an AbortError. */
  async function send(path, init, signal, ms) {
    const opts = { ...init, cache: 'no-store', credentials: 'omit', redirect: 'error' };
    if (!ms) return doFetch(base + path, { ...opts, signal });
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    const timer = timers.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
    try {
      return await doFetch(base + path, { ...opts, signal: ctrl.signal });
    } catch (e) {
      if (timedOut) throw Object.assign(new Error(`no answer within ${ms} ms`), { name: 'TimeoutError' });
      throw e;
    } finally {
      timers.clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** One GET /api/status while waiting: {status} when the program answers, {auth} for a 403, else null. */
  async function probe() {
    let res;
    try {
      res = await send('/api/status', { method: 'GET', headers: { [KEY_HEADER]: key } }, null, PROBE_MS);
    } catch (e) {
      return null;
    }
    const data = await readBody(res);
    if (res.status === 403) return { auth: answerError(res, data) };
    return res.ok ? { status: data && typeof data === 'object' ? data : {} } : null;
  }

  /** Asks the status until the program answers (BACKOFF_MS, then RETRY_MS after WAIT_MS): its answer. */
  async function waitForProgram(cause) {
    const since = now();
    for (let i = 0; ; i++) {
      if (ended) throw cause;
      const r = await probe();
      if (ended) throw cause;
      if (r && r.auth) {
        stop();
        onAuthLost(r.auth);
        throw r.auth;
      }
      if (r) {
        setState('ok');
        return r.status;
      }
      const stopped = now() - since >= WAIT_MS;
      setState(stopped ? 'stopped' : 'waiting');
      await new Promise(resolve => {
        const timer = timers.setTimeout(resolve, stopped ? RETRY_MS : BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
        wake = () => {
          timers.clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  }

  /** The program's status once it answers again (one wait for every call that lost its answer); `signal` stops it. */
  function answered(cause, signal) {
    if (ended) return Promise.reject(cause);
    if (!waiting) waiting = waitForProgram(cause).finally(() => { waiting = null; });
    if (!signal) return waiting;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /**
   * @param {string} method
   * @param {string} path  /api/…
   * @param {*} [body]  JSON, or a Blob for raw: true
   * @param {{headers?: object, signal?: AbortSignal, raw?: boolean, timeoutMs?: number}} [o] timeoutMs: an answer
   *   later than this counts as none (status and hello only: other calls may take long, a file dialog's 25 s)
   */
  async function call(method, path, body = undefined, { headers = {}, signal = undefined, raw = false, timeoutMs = 0 } = {}) {
    const h = { [KEY_HEADER]: key, ...headers };
    let payload;
    if (body !== undefined) {
      if (raw) {
        payload = body;
        if (!h['Content-Type']) h['Content-Type'] = 'application/octet-stream';
      } else {
        payload = JSON.stringify(body);
        h['Content-Type'] = 'application/json';
      }
    }
    const kind = jobKindOf(method, path);
    let again = false;             // sent again after its answer was lost
    for (let sends = 1; ; sends++) {
      const sentAt = now();
      let res;
      try {
        res = await send(path, { method, headers: h, body: payload }, signal, timeoutMs);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        const error = String((e && e.message) || e);
        const status = await answered(new ApiError({ status: 0, code: 'offline', message: error }), signal);
        // the answer of a start is the job: one that started since it was sent is its, or another tab's (then this
        // one cannot have started: one job at a time); none since: it never arrived, and is sent again
        const job = status && status.job;
        if (kind && job && typeof job.startedAt === 'number' && job.startedAt >= sentAt - START_SLACK_MS) {
          if (job.kind === kind) return job;
          throw new ApiError({ status: 409, code: 'job-replaced', message: 'another job started meanwhile' });
        }
        // a preview start's answer is the preview the status shows
        if (method === 'POST' && path === '/api/preview/start' && status && status.preview) return status.preview;
        // the program answers, yet this one fails each time (a dropped file that changed on disk cannot be read):
        // said, not sent for ever
        if (sends >= MAX_SENDS) throw new ApiError({ status: 0, code: 'not-sent', params: { error }, message: error });
        again = true;
        continue;
      }
      const data = await readBody(res);
      if (res.ok) return data;
      const err = answerError(res, data);
      if (err.auth) {
        stop();
        onAuthLost(err);
        throw err;
      }
      if (again) {
        if (arrivedCodes(method, path).includes(err.code)) return { ok: true };
        // a file dialog whose answer was lost is the one open now: waited out with /api/pick/wait (picker.js)
        if (method === 'POST' && path === '/api/pick' && err.code === 'picker-open' && err.params && err.params.id) {
          return { open: true, id: err.params.id };
        }
      }
      throw err;
    }
  }

  const post = (path, body = {}, o) => call('POST', path, body, o);
  return {
    call,
    /** The page is done with the program (Quit, an old tab): a lost answer then fails at once, a wait ends. */
    end: stop,
    hello: () => call('GET', '/api/hello', undefined, { timeoutMs: STATUS_MS }),
    status: () => call('GET', '/api/status', undefined, { timeoutMs: STATUS_MS }),
    quit: () => post('/api/quit'),
    settings: s => post('/api/settings', s),
    site: path => post('/api/site', { path }),
    roots: () => post('/api/fs/roots'),
    list: path => post('/api/fs/list', { path }),
    inspect: sources => post('/api/inspect', { sources }),
    dropStart: ({ signal } = {}) => post('/api/drop', {}, { signal }),
    dropPut: (drop, n, rel, blob, { signal } = {}) => call('PUT', `/api/drop/${encodeURIComponent(drop)}/${n}`, blob,
      { raw: true, headers: { [PATH_HEADER]: encodeRel(rel) }, signal }),
    dropDone: (drop, roots, { signal } = {}) =>
      post(`/api/drop/${encodeURIComponent(drop)}/done`, { roots }, { signal }),
    dropCancel: drop => post(`/api/drop/${encodeURIComponent(drop)}/cancel`),
    ghosts: () => post('/api/ghosts'),
    add: plan => post('/api/add', { plan }),
    remove: id => post('/api/remove', { id }),
    index: () => post('/api/index'),
    check: () => post('/api/check'),
    prepare: (o = {}) => post('/api/prepare', o),
    hub: () => post('/api/hub'),
    hubSave: origins => post('/api/hub/save', { origins }),
    previewStart: lang => post('/api/preview/start', { lang }),
    previewStop: () => post('/api/preview/stop'),
    pick: o => post('/api/pick', o),
    pickWait: id => post('/api/pick/wait', { id }),
    pickCancel: () => post('/api/pick/cancel'),
  };
}

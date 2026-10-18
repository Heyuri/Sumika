// SHIORI/3.0 client: talks to the engine worker, one request at a time (FIFO).

const CRLF = '\r\n';
const WARN_MS = 2000;
const KILL_MS = 30000;

/** Header values cannot contain line breaks. */
function clean(v) {
  return String(v ?? '').replace(/\r\n|\r|\n/g, ' ');
}

/**
 * The headers the page sends with every request (ShioriClient), also Kawari's D6 close in the worker
 * (engines/kawari.js closeFromOutside).
 */
export const BASE_HEADERS = Object.freeze({ Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' });

/**
 * Build request text.
 * @param {{method?:'GET'|'NOTIFY', id:string, refs?:any[], headers?:Record<string,string>}} r
 * @param {Record<string,string>} base headers sent with every request (Charset, Sender, SecurityLevel ...)
 */
export function buildRequest(r, base) {
  let s = `${r.method || 'GET'} SHIORI/3.0${CRLF}`;
  const h = { ...base, ...(r.headers || {}) };
  for (const [k, v] of Object.entries(h)) if (v !== undefined && v !== null && v !== '') s += `${k}: ${clean(v)}${CRLF}`;
  s += `ID: ${clean(r.id)}${CRLF}`;
  (r.refs || []).forEach((v, i) => {
    if (v !== undefined && v !== null) s += `Reference${i}: ${clean(v)}${CRLF}`;
  });
  return s + CRLF;
}

/**
 * @returns {{status:number, statusText:string, headers:Map<string,string>, value:string|null, protocol:number}}
 *   protocol: the status line's version (3 for SHIORI/3.0; 2.6 for a SHIORI/2.x engine's bridged reply, whose
 *   COMMUNICATE target is read otherwise: events.js communicateOf)
 */
export function parseResponse(text) {
  const lines = String(text || '').split(/\r\n|\n/);
  const m = /^SHIORI\/(\d\.\d)\s+(\d+)\s*(.*)$/.exec(lines[0] || '');
  const res = { status: m ? +m[2] : 500, statusText: m ? m[3] : 'Bad Response', headers: new Map(), value: null,
    protocol: m ? parseFloat(m[1]) : 3 };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break;
    const c = line.indexOf(': ');
    if (c < 0) continue;
    const k = line.slice(0, c).toLowerCase();
    if (!res.headers.has(k)) res.headers.set(k, line.slice(c + 2));
  }
  res.value = res.headers.get('value') ?? null;
  return res;
}

export class ShioriClient {
  /**
   * @param {string} workerUrl absolute URL of the worker script (engines/worker.<h>.js; unbundled engines/worker.js)
   * @param {{onSaori?, onLog?, onSaved?, onVolatile?, onCrash?}} hooks
   */
  constructor(workerUrl, hooks = {}) {
    this.workerUrl = workerUrl;
    this.hooks = hooks;
    this.baseHeaders = { ...BASE_HEADERS };
    this.seq = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.worker = null;
    this._blobUrl = null;     // the worker bootstrap's blob: URL, revoked once the engine answered (or stopped)
    this.busySince = 0;
    this.ghostDir = '';       // the engine's ghost/master folder in its file system ('/'-ended), from init
    this._fmoSent = null;     // the FMO text this worker's engine has (Satori P8), null = none sent yet
    this._fmoFailed = false;  // a throwing r.fmo was logged
    this._stops = 0;          // terminate() calls: a reload stopped from outside (a teardown) starts nothing
  }

  _hook(name, ...a) {
    const f = this.hooks[name];
    if (f) {
      try { f(...a); } catch (e) { console.error('[sumika]', e); }
    }
  }

  _post(msg, transfer) {
    if (!this.worker) return Promise.reject(new Error('engine not running'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  _onMessage(ev) {
    const m = ev.data || {};
    if (m.t === 'saori') return this._hook('onSaori', m);
    if (m.t === 'log') return this._hook('onLog', m.level, m.text);
    if (m.t === 'saved') return this._hook('onSaved', m.files);
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.t === 'error') p.reject(new Error(m.error));
    else p.resolve(m);
  }

  /**
   * Start the worker and load the engine.
   * @param {{engine:string, engineUrl:string, wasmUrl?:string|null, ghostDir?:string, files:{path,data:ArrayBuffer}[],
   *          resume?:boolean, volatile?:object, bootEpochMs?:number, sessionEndMs?:number, storeNamespace:string,
   *          storeKey:string, engineOpts?:object, storePort?:MessagePort}} o
   *          wasmUrl: the engine's hashed .wasm (safe updates; null: the one next to engineUrl);
   *          storePort: the storage hub's store for the save files (core/hub.js storePort; transferred), absent
   *          without the hub;
   *          bootEpochMs: the ghost's last cold boot, where its uptime clock starts (P7, SUMMARY §2.1); sessionEndMs:
   *          on a cold boot, when the ghost's last session ended (its state's savedAt; 0 = unknown), the time Kawari's
   *          D6 closes that session at (kawari-wasm.md §8); engineOpts: engine-specific options, plain JSON (YAYA:
   *          module, ghost id, placeholders, the site's ghosts and balloons)
   */
  async start(o) {
    // a worker script must be same-origin with the page; load it through a blob so the runtime may live elsewhere
    const src = `importScripts(${JSON.stringify(this.workerUrl)});`;
    this._blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    this.worker = new Worker(this._blobUrl);
    this._fmoSent = null;     // a new engine has no FMO text (none goes with init: satori-wasm.md P8)
    this.worker.onmessage = ev => this._onMessage(ev);
    let failInit = null;
    // an error before `init` is answered (the worker script did not load, the engine threw while loading) fails the
    // start: it would otherwise never end, and a page's raises wait for the starts of the ghosts up (Site._upSettled)
    this.worker.onerror = ev => {
      const text = `worker: ${(ev && ev.message) || 'error'}`;
      this._hook('onLog', 'error', text);
      if (failInit) failInit(new Error(text));
    };
    const transfer = o.files.map(f => f.data).filter(d => d instanceof ArrayBuffer);
    // the storage hub's store (data-hub, CONTRACTS core/hub.js): a MessagePort the worker's PortStore speaks over,
    // transferred; without it the worker opens IndexedDB itself
    const port = o.storePort || null;
    if (port) transfer.push(port);
    let r;
    try {
      const init = this._post({
        t: 'init', engine: o.engine, engineUrl: o.engineUrl, wasmUrl: o.wasmUrl || null, ghostDir: o.ghostDir || '/ghost/master/', files: o.files,
        resume: !!o.resume, volatile: o.volatile || null, bootEpochMs: o.bootEpochMs || 0, sessionEndMs: o.sessionEndMs || 0,
        storeNamespace: o.storeNamespace, storeKey: o.storeKey, engineOpts: o.engineOpts || null,
        ...(port ? { storePort: port } : {}),
      }, transfer);
      const id = this.seq;      // _post numbered it
      failInit = e => {
        const p = this.pending.get(id);
        if (p) { this.pending.delete(id); p.reject(e); }
      };
      r = await init;
    } finally {
      failInit = null;
      this._revokeBlob();      // the bootstrap ran (the worker answered) or is gone: every engine start made one
    }
    if (!r.ok) throw new Error(`engine failed to load${r.error ? ': ' + r.error : ''}`);
    if (typeof r.ghostDir === 'string') this.ghostDir = r.ghostDir;
    return r;
  }

  _revokeBlob() {
    if (this._blobUrl) { try { URL.revokeObjectURL(this._blobUrl); } catch (e) { /* ignore */ } }
    this._blobUrl = null;
  }

  _enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  /**
   * The FMO text for a request leaving the queue (r.fmo, Satori P8: what （FMOn…） and （Xの存在） read), or null to
   * send none: no r.fmo, the text the engine already has, or a throwing r.fmo (logged once).
   */
  _fmoFor(r) {
    if (typeof r.fmo !== 'function') return null;
    let t;
    try {
      t = r.fmo();
    } catch (e) {
      if (!this._fmoFailed) this._hook('onLog', 'error', `FMO text for ${r.id}: ${e && e.message ? e.message : e}`);
      this._fmoFailed = true;
      return null;
    }
    return typeof t === 'string' && t !== this._fmoSent ? t : null;
  }

  /**
   * Queue one request; resolves with the parsed response (plus .ms, the engine time).
   * @param {{method?, id, refs?, headers?, fmo?: () => string|null, kind?: string, self?: string}} r fmo: the FMO
   *   text, read when the request leaves the queue (live, as SSP rewrites its FMO at once) and posted only when it
   *   differs from the last one sent; kind / self: the call for a SHIORI/2.x engine (worker shiori2.js toShiori2)
   */
  request(r) {
    const text = buildRequest(r, this.baseHeaders);
    return this._enqueue(async () => {
      this.busySince = Date.now();
      const warn = setTimeout(() => this._hook('onLog', 'warn', `${r.id} is taking more than ${WARN_MS / 1000} s`), WARN_MS);
      const kill = setTimeout(() => {
        this._hook('onLog', 'error', `${r.id} took more than ${KILL_MS / 1000} s; restarting the engine`);
        this.terminate();
        this._hook('onCrash', r.id);
      }, KILL_MS);
      try {
        const msg = { t: 'req', text };
        // which of ssp.exe's calls this is, for a SHIORI/2.x engine's bridge (worker shiori2.js); not in the text
        if (r.kind) msg.kind = r.kind;
        if (r.self) msg.self = r.self;
        // not for a request left in the queue of a stopped engine: its ghost may be torn down (no FMO to read)
        const fmo = this.worker ? this._fmoFor(r) : null;
        if (fmo !== null) {
          msg.fmo = fmo;
          this._fmoSent = fmo;
        }
        const m = await this._post(msg);
        if (m.vol) this._hook('onVolatile', m.vol);
        const res = parseResponse(m.text);
        res.ms = m.ms;
        const err = res.headers.get('errordescription');
        if (err) this._hook('onLog', 'warn', `${r.id}: ${err.replace(/\x01/g, ' | ')}`);
        return res;
      } finally {
        clearTimeout(warn);
        clearTimeout(kill);
        this.busySince = 0;
      }
    });
  }

  /**
   * Write a file into the ghost's master folder in the engine's file system (\![execute,http-*]'s download, EV §4.15),
   * in the request queue: a request sent after it sees the file. The worker stores it like any file the ghost writes.
   * @param {string} path relative to ghost/master/ ('var/x.txt')  @param {ArrayBuffer|Uint8Array} data
   * @returns {Promise<string>} its full path in the engine's file system
   */
  writeFile(path, data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    return this._enqueue(async () => (await this._post({ t: 'write', path: String(path), data: buf }, [buf])).path || '');
  }

  /**
   * A file of the ghost's master folder as the engine has it now (--param-input-file, EV §4.15): null when it is not
   * there or lies outside the folder.
   * @returns {Promise<Uint8Array|null>}
   */
  readFile(path) {
    return this._enqueue(async () => {
      const m = await this._post({ t: 'read', path: String(path) });
      return m.data ? new Uint8Array(m.data) : null;
    });
  }

  /** Ask the engine to write its save data now. */
  persist() {
    return this._enqueue(async () => (await this._post({ t: 'persist' })).files || []);
  }

  async unload() {
    const files = await this._enqueue(async () => (await this._post({ t: 'unload' })).files || []);
    this.terminate();
    return files;
  }

  /**
   * \![reload,shiori] (shiori-events.md §2.10): in the queue, after every request asked before it and before every one
   * asked after it, the engine unloads (the worker stores its files before it answers), the worker goes and a new one
   * loads from the store with `opts()` (start()'s options, built once the unload is done). An unload that fails is
   * logged and the load goes on. Rejects with `stopped: true`, starting nothing, when no engine runs at its turn or
   * terminate() stopped it meanwhile (a teardown, a request's kill timer); a load that fails leaves the client stopped
   * (later requests reject).
   * @param {() => object|Promise<object>} opts
   * @returns {Promise<object>} start()'s result
   */
  reload(opts) {
    const stopped = e => Object.assign(e instanceof Error ? e : new Error(String(e)), { stopped: true });
    return this._enqueue(async () => {
      if (!this.worker) throw stopped(new Error('engine not running'));
      const stops = this._stops;
      try {
        await this._post({ t: 'unload' });
      } catch (e) {
        if (this._stops !== stops) throw stopped(e);
        this._hook('onLog', 'warn', `unload before the reload failed: ${e && e.message ? e.message : e}`);
      }
      this.terminate();
      const mine = this._stops;
      const o = await opts();
      if (this._stops !== mine) throw stopped(new Error('engine stopped'));
      try {
        return await this.start(o);
      } catch (e) {
        const outside = this._stops !== mine;
        this.terminate();
        throw outside ? stopped(e) : e;
      }
    });
  }

  /** Delete the ghost's stored save data (the engine must be restarted afterwards). */
  forget() {
    return this._enqueue(async () => this._post({ t: 'forget' }));
  }

  get running() { return !!this.worker; }

  terminate() {
    this._stops++;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this._fmoSent = null;
    this._revokeBlob();
    for (const p of this.pending.values()) p.reject(new Error('engine stopped'));
    this.pending.clear();
  }
}

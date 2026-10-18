(() => {
  // src/core/engine-files.js
  var YAYA_TEXT = /\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u)$/i;
  var YAYA_SKIP = /(^|\/)profile\/|(^|\/)[^/]*_variable\.[^/]*$|\.log$|\.(dll|exe)$/i;
  var YAYA_MAX_BYTES = 4 * 1024 * 1024;
  var KAWARI_TEXT = /\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u|kis|kaw)$/i;
  var KAWARI7_TEXT = /\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u|kis|kaw|kdf|dat)$/i;
  var KAWARI_SKIP = /(^|\/)profile\/|(^|\/)[^/]*_variable\.[^/]*$|(^|\/)satori_save[^/]*$|\.log$|\.(dll|exe)$/i;
  var PERSONAL = /(^|\/)(profile\/|[^/]*_variable\.[^/]*$|satori_save[^/]*$|[^/]*\.log$)/i;
  var ROOT_ENGINES = Object.freeze({
    yaya: Object.freeze({ text: YAYA_TEXT, skip: YAYA_SKIP }),
    kawari: Object.freeze({ text: KAWARI_TEXT, skip: KAWARI_SKIP }),
    kawari7: Object.freeze({ text: KAWARI7_TEXT, skip: KAWARI_SKIP })
  });
  function masterRel(rel) {
    const parts = [];
    for (const seg of String(rel ?? "").replace(/\\/g, "/").split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (!parts.length) return null;
        parts.pop();
        continue;
      }
      parts.push(seg);
    }
    return parts.length ? parts.join("/") : null;
  }
  function personalFile(rel) {
    const p = masterRel(rel);
    return p == null || PERSONAL.test(p);
  }
  function visitorFile(stored, rel, prefix = "") {
    const p = masterRel(rel);
    if (p == null) return true;
    const want = (prefix + p).toLowerCase();
    return Object.entries(stored || {}).some(([k, v]) => !!v && k.toLowerCase() === want);
  }

  // src/worker/engines/emscripten.js
  var enc = new TextEncoder();
  var dec = new TextDecoder("utf-8");
  function ntfsOrder(files) {
    const key = (p) => p.split("/").map((s) => s.toUpperCase());
    return [...files].sort((a, b) => {
      const ka = key(a.path), kb = key(b.path);
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      }
      return ka.length - kb.length;
    });
  }
  var EmscriptenShiori = class {
    /**
     * @param {{engineUrl: string, wasmUrl?: string|null, ghostDir?: string, log?: Function, saori?: object}} o wasmUrl:
     *   the page's hashed .wasm (safe updates: a hashed `<e>.<h>.js` still asks locateFile for `<e>.wasm`); none:
     *   the .wasm next to engineUrl
     */
    constructor({ engineUrl, wasmUrl = null, ghostDir = "/ghost/master/", log: log3, saori }) {
      this.engineUrl = engineUrl;
      this.wasmUrl = wasmUrl || null;
      this.ghostDir = ghostDir.endsWith("/") ? ghostDir : ghostDir + "/";
      this.log = log3 || (() => {
      });
      this.saori = saori;
      this.M = null;
      this.baseline = /* @__PURE__ */ new Map();
    }
    /** Subclasses: return the Emscripten factory (e.g. self.createSatori after importScripts). */
    async factory() {
      throw new Error("not implemented");
    }
    async boot(extra = {}) {
      const create = await this.factory();
      const cut = Math.max(this.engineUrl.lastIndexOf("/"), this.engineUrl.lastIndexOf("\\"));
      const base = this.engineUrl.slice(0, cut + 1);
      this.M = await create({
        // in a worker Emscripten would resolve files against the worker's URL; point it at the engine's folder, and the
        // .wasm at the page's hashed one when it gave one
        locateFile: (f) => this.wasmUrl && /\.wasm$/i.test(f) ? this.wasmUrl : base + f,
        print: (t) => this.log("debug", t),
        printErr: (t) => this.log("debug", t),
        saoriBridge: this.saori,
        ...extra
      });
    }
    mkdirs(path) {
      try {
        this.M.FS.mkdirTree(path);
      } catch (e) {
      }
    }
    writeFile(rel, data) {
      const full = this.ghostDir + rel.replace(/^\/+/, "");
      this.mkdirs(full.slice(0, full.lastIndexOf("/")));
      this.M.FS.writeFile(full, data instanceof Uint8Array ? data : new Uint8Array(data));
    }
    /** `rel` inside ghost/master as a full path (`\` as `/`, `.` and `..` resolved); null when it leaves the folder. */
    masterPath(rel) {
      const p = masterRel(rel);
      return p == null ? null : this.ghostDir + p;
    }
    /**
     * \![execute,http-*]'s download (EV §4.15): `rel` under ghost/master/ (its folders made), as the engine's own writes
     * are, so changedFiles() reports it. Throws when `rel` leaves the folder.
     * @returns {string} its full path
     */
    writeMasterFile(rel, data) {
      const full = this.masterPath(rel);
      if (!full) throw new Error(`not a file of the ghost: ${rel}`);
      this.mkdirs(full.slice(0, full.lastIndexOf("/")));
      this.M.FS.writeFile(full, data instanceof Uint8Array ? data : new Uint8Array(data || 0));
      return full;
    }
    /** A file under ghost/master/ (--param-input-file, EV §4.15) as an ArrayBuffer; null when missing or outside it. */
    readMasterFile(rel) {
      const full = this.masterPath(rel);
      if (!full) return null;
      try {
        const u8 = this.M.FS.readFile(full);
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      } catch (e) {
        return null;
      }
    }
    /** All regular files under ghostDir: Map(relative path -> mtime ms) */
    scan() {
      const FS = this.M.FS;
      const out = /* @__PURE__ */ new Map();
      const walk = (dir) => {
        for (const name of FS.readdir(dir)) {
          if (name === "." || name === "..") continue;
          const p = dir + name;
          const st = FS.stat(p);
          if (FS.isDir(st.mode)) walk(p + "/");
          else out.set(p.slice(this.ghostDir.length), +st.mtime);
        }
      };
      walk(this.ghostDir);
      return out;
    }
    /**
     * @param {{path:string, data:ArrayBuffer}[]} files ghost text files
     * @param {Record<string, ArrayBuffer>} persisted files the engine wrote in earlier sessions (save data)
     * @param {{resume?: boolean, bootEpochMs?: number}} opts resume: a page navigation, not a ghost start; bootEpochMs:
     *   the ghost's last cold boot (engine-specific use: Satori's P7 clock)
     */
    init(files, persisted2, { resume = false } = {}) {
      this.mkdirs(this.ghostDir);
      const lower2 = new Set(Object.keys(persisted2).map((p) => p.toLowerCase()));
      for (const f of ntfsOrder(files)) if (!lower2.has(f.path.toLowerCase())) this.writeFile(f.path, f.data);
      for (const [p, data] of Object.entries(persisted2)) this.writeFile(p, data);
      this.inputs = new Set(files.map((f) => f.path));
      this.baseline = this.scan();
      const ok = this.callLoad(this.ghostDir, resume);
      if (!ok) this.log("warn", "load() returned false");
      this.baseline = this.scan();
      return ok;
    }
    _toHeap(bytes) {
      const M = this.M;
      const p = M._malloc(bytes.length + 1);
      M.HEAPU8.set(bytes, p);
      M.HEAPU8[p + bytes.length] = 0;
      return p;
    }
    /**
     * fn() into the engine. A throw out of the wasm (a runaway recursion's RangeError) skips the epilogues that move the
     * stack pointer back up: it is put back before anything else runs, when the module exports stackSave/stackRestore
     * (Kawari; not Satori and YAYA). Without it the next calls run on a lower stack, and an -O2 engine whose stack
     * sits above its static data is corrupted after about 12 such throws (kawari-wasm.md D8, §4).
     */
    _stackGuard(fn) {
      const M = this.M;
      const sp = typeof M.stackSave === "function" && typeof M.stackRestore === "function" ? M.stackSave() : null;
      try {
        return fn();
      } catch (e) {
        if (sp !== null) M.stackRestore(sp);
        throw e;
      }
    }
    callLoad(dir, resume) {
      const b = enc.encode(dir);
      const fn = resume && this.M._satori_load_resume ? this.M._satori_load_resume : this.M._load;
      try {
        return this._stackGuard(() => fn(this._toHeap(b), b.length)) !== 0;
      } catch (e) {
        this.log("error", `load: ${e}`);
        return false;
      }
    }
    /** One SHIORI request. The engine frees the request buffer; we free the response. */
    request(text) {
      const M = this.M;
      const b = enc.encode(text);
      const p = this._toHeap(b);
      const lenp = M._malloc(4);
      M.HEAP32[lenp >> 2] = b.length;
      let r = 0;
      try {
        r = this._stackGuard(() => M._request(p, lenp));
      } catch (e) {
        M._free(lenp);
        this.log("error", `request: ${e}`);
        return "SHIORI/3.0 500 Internal Server Error\r\n\r\n";
      }
      const n = M.HEAP32[lenp >> 2];
      M._free(lenp);
      if (!r) return "";
      const out = dec.decode(M.HEAPU8.subarray(r, r + n));
      M._free(r);
      return out;
    }
    /** Files written since the last report (save data etc.), as {path: ArrayBuffer}. */
    changedFiles() {
      const now = this.scan();
      const out = {};
      for (const [p, mt] of now) {
        if (this.baseline.get(p) === mt) continue;
        if (this.inputs && this.inputs.has(p) && !/save|\.sat$/i.test(p)) continue;
        const u8 = this.M.FS.readFile(this.ghostDir + p);
        out[p] = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      }
      this.baseline = now;
      return out;
    }
    /** Engine-specific "write your save data now"; returns true if it did. */
    save() {
      return false;
    }
    unload() {
      try {
        this._stackGuard(() => this.M._unload());
      } catch (e) {
        this.log("error", `unload: ${e}`);
      }
      return this.changedFiles();
    }
    /** Engine-specific in-memory state worth carrying across page loads (null = none). */
    getVolatileState() {
      return null;
    }
    setVolatileState() {
    }
  };

  // src/worker/engines/satori.js
  var SatoriEngine = class extends EmscriptenShiori {
    async factory() {
      if (typeof self.createSatori !== "function") importScripts(this.engineUrl);
      return self.createSatori;
    }
    /**
     * Patch P7 (SUMMARY §2.1): with opts.bootEpochMs (epoch ms of the ghost's last cold boot), Satori's uptime clock
     * counts from it, so （単純起動秒）/（起動時…） survive page loads; satori_load_resume moves the load to that zero.
     */
    init(files, persisted2, opts = {}) {
      if (this.M && opts.bootEpochMs > 0) this.M.bootEpochMs = opts.bootEpochMs;
      return super.init(files, persisted2, opts);
    }
    /**
     * Patch P8: the page's FMO text (SSP's "SakuraUnicode" lines, src/core/fmo.js), read by （FMOn…）, （Xの存在） and
     * （Xのサーフェス） at each use. Anything but a string withdraws it: Satori then keeps the list it read last.
     */
    setFmo(text) {
      if (!this.M) return;
      if (typeof text === "string") this.M.fmoText = text;
      else delete this.M.fmoText;
    }
    /** satori_save (patch P3): write satori_savedata.txt without unloading. */
    save() {
      if (typeof this.M._satori_save !== "function") return false;
      try {
        return this.M._satori_save() === 1;
      } catch (e) {
        this.log("error", `satori_save: ${e}`);
        return false;
      }
    }
    /** Random-talk countdown and seconds since the last talk (patch P6). */
    getVolatileState() {
      const M = this.M;
      if (typeof M._satori_get_talk_count !== "function") return null;
      return { talkCount: M._satori_get_talk_count(), sinceLastTalk: M._satori_get_since_last_talk(), at: Date.now() };
    }
    /** Restore it after a page navigation; time spent away counts as idle time. */
    setVolatileState(s) {
      if (!s || typeof this.M._satori_set_talk_state !== "function") return;
      const away = Math.max(0, Math.floor((Date.now() - (s.at || Date.now())) / 1e3));
      this.M._satori_set_talk_state(Math.max(0, (s.talkCount | 0) - away), (s.sinceLastTalk | 0) + away);
    }
  };

  // src/worker/engines/ssproot.js
  var enc2 = new TextEncoder();
  var EMPTY = new Uint8Array(0);
  var LOG_FILE = /\.log$/i;
  var GHOST_MASTER = "ghost/master/";
  var SSP_GHOSTS = "/ssp/ghost/";
  var WRITE_OPS = [
    "write",
    "truncate",
    "ftruncate",
    "allocate",
    "msync",
    "unlink",
    "rmdir",
    "rename",
    "mknod",
    "mkdir",
    "symlink",
    "utime"
  ];
  var O_WRITE = 1 | 2 | 64 | 512 | 1024;
  var READ_ONLY = /* @__PURE__ */ new Set(["r", "rs"]);
  function watchWrites(FS, owner) {
    if (!FS || FS.__sumikaWatch) {
      if (FS) FS.__sumikaWatch.owner = owner;
      return;
    }
    const w = { owner };
    Object.defineProperty(FS, "__sumikaWatch", { value: w });
    const mark = () => {
      if (w.owner) w.owner.dirty = true;
    };
    for (const name of WRITE_OPS) {
      const fn = FS[name];
      if (typeof fn !== "function") continue;
      FS[name] = function(...args) {
        mark();
        return fn.apply(this, args);
      };
    }
    const open = FS.open;
    if (typeof open === "function") {
      FS.open = function(path, flags, ...rest) {
        if (typeof flags === "string" ? !READ_ONLY.has(flags) : (flags | 0) & O_WRITE) mark();
        return open.call(this, path, flags, ...rest);
      };
    }
  }
  var STAMP_CHANGED = "dictionaries changed since the last boot: loading as after an update";
  var clock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
  var ms = (t) => (t || 0).toFixed(0);
  var toU8 = (d) => d instanceof Uint8Array ? d : d ? new Uint8Array(d) : EMPTY;
  var fnv1a = (u8, h = 2166136261) => {
    for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619);
    return h;
  };
  var safe = (id) => {
    const s = String(id == null ? "" : id).replace(/[\\/]/g, "_");
    return s && s !== "." && s !== ".." ? s : "_";
  };
  function rootBridge(bridge, root) {
    if (!bridge) return bridge;
    const pre = String(root);
    const lower2 = pre.toLowerCase();
    const strip = (p) => {
      const s = String(p == null ? "" : p);
      if (s.length >= pre.length && s.slice(0, pre.length).toLowerCase() === lower2) return "/" + s.slice(pre.length);
      return (s + "/").toLowerCase() === lower2 ? "/" : s;
    };
    return {
      load: (path, dir) => bridge.load(strip(path), strip(dir)),
      request: (handle, bytes) => bridge.request(handle, bytes),
      unload: (handle) => bridge.unload(handle)
    };
  }
  function sspDescript(g, charset = "UTF-8") {
    const v = (x) => String(x == null ? "" : x).replace(/[\r\n]/g, "");
    const o = g || {};
    return [
      `charset,${charset}`,
      "type,ghost",
      `name,${v(o.name)}`,
      `sakura.name,${v(o.sakuraName)}`,
      `kero.name,${v(o.keroName)}`,
      `craftman,${v(o.craftman)}`,
      `shiori,${v(o.shiori)}`,
      ""
    ].join("\r\n");
  }
  var LogLines = class {
    constructor() {
      this.buf = "";
      this.mode = 0;
      this.open = false;
    }
    /** @returns {{mode: number, text: string}[]} the lines this fragment completed (blank ones dropped) */
    push(text, mode) {
      const out = [];
      let s = String(text == null ? "" : text);
      while (s) {
        if (!this.open) {
          this.open = true;
          this.mode = mode;
        }
        const i = s.indexOf("\n");
        if (i < 0) {
          this.buf += s;
          break;
        }
        this.buf += s.slice(0, i);
        s = s.slice(i + 1);
        this._end(out);
      }
      return out;
    }
    /** The line still open (none: []). */
    flush() {
      const out = [];
      if (this.open) this._end(out);
      return out;
    }
    _end(out) {
      const text = this.buf.replace(/\r/g, "").trimEnd();
      if (text.trim()) out.push({ mode: this.mode, text });
      this.buf = "";
      this.open = false;
    }
  };
  var goneValue = (p, inputs) => inputs && inputs.has(p.toLowerCase()) ? null : false;
  function diffScan(baseline, now, inputs) {
    const changed = [];
    const gone = {};
    for (const [p, mt] of now) if (!LOG_FILE.test(p) && baseline.get(p) !== mt) changed.push(p);
    for (const p of baseline.keys()) if (!now.has(p) && !LOG_FILE.test(p)) gone[p] = goneValue(p, inputs);
    return { changed, gone };
  }
  function dicStamp(files) {
    let h = 2166136261;
    for (const f of ntfsOrder(files || [])) {
      if (!String(f.path).toLowerCase().startsWith(GHOST_MASTER)) continue;
      const data = toU8(f.data);
      h = fnv1a(data, fnv1a(enc2.encode(`${f.path}\0${data.length}\0`), h));
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  var SspRootShiori = class extends EmscriptenShiori {
    /**
     * @param {{engineUrl: string, wasmUrl?: string|null, ghostDir?: string, log?: Function, saori?: object,
     *   opts?: object|null, onEngineLog?: Function|null}} o wasmUrl: the page's hashed .wasm (EmscriptenShiori); opts:
     *   the worker's engineOpts, plain JSON from the page ({ghostId, placeholders, site: {ghosts, balloons}} and the
     *   engine's own, such as YAYA's module); onEngineLog({mode, text}): the engine's own log lines for in-process users
     *   (the sweep, tests). ghostDir is not used: the ghost lives at /ssp/ghost/<id>/ghost/master/
     */
    constructor({ engineUrl, wasmUrl = null, ghostDir, log: log3, saori, opts = null, onEngineLog = null }) {
      super({ engineUrl, wasmUrl, ghostDir, log: log3, saori });
      this.opts = opts || {};
      this.onEngineLog = onEngineLog;
      this.ghostRoot = SSP_GHOSTS + safe(this.opts.ghostId || "ghost") + "/";
      this.ghostDir = this.ghostRoot + GHOST_MASTER;
      this.timing = {};
      this.dicStamp = null;
      this.inputs = /* @__PURE__ */ new Set();
      this.hot = /* @__PURE__ */ new Map();
      this.dirty = true;
      this.scans = 0;
    }
    async boot(extra) {
      await super.boot(extra);
      watchWrites(this.M.FS, this);
    }
    /**
     * A resume whose stored dictionary stamp differs from this boot's (this.dicStamp, set first): the site was updated,
     * so it loads as after an update; logged at info. @returns {boolean} true when the resume must load cold
     */
    _stampChanged(resume, volatile) {
      if (!(resume && volatile && volatile.dicStamp && volatile.dicStamp !== this.dicStamp)) return false;
      this.log("info", STAMP_CHANGED);
      return true;
    }
    /**
     * The ghost's MEMFS before its load: the SSP view, then the site's files (a shipped file beats a placeholder) and the
     * visitor's (a tombstone removes, a copy shadows), written in NTFS order (FENUM and readdir list a folder in that
     * order, as on Windows). Sets `inputs`, the lower-cased paths that came from the site.
     * @param {{path: string, data: ArrayBuffer}[]} files  @param {Record<string, ArrayBuffer|null>} persisted
     * @returns {number} the placeholders written
     */
    _mount(files, persisted2) {
      this._sspView();
      const entries = /* @__PURE__ */ new Map();
      const put = (path, data) => entries.set(String(path).toLowerCase(), { path, data });
      for (const p of this.opts.placeholders || []) put(p, EMPTY);
      for (const f of files || []) put(f.path, f.data);
      this.inputs = new Set(entries.keys());
      const own = Object.entries(persisted2 || {});
      for (const [p, data] of own) if (!data) entries.delete(p.toLowerCase());
      for (const [p, data] of own) if (data) put(p, data);
      let placeholders = 0;
      for (const f of ntfsOrder([...entries.values()])) {
        if (f.data === EMPTY) placeholders++;
        this.writeFile(f.path, f.data);
      }
      return placeholders;
    }
    /** /ssp/: the site as an SSP install shows it (FENUM('..\..\..'), other ghosts' descript.txt, balloon folders). */
    _sspView() {
      const site = this.opts.site || {};
      this.mkdirs("/ssp/balloon");
      const balloons = ntfsOrder((site.balloons || []).map((id) => ({ path: safe(id) })));
      for (const b of balloons) this.mkdirs(`/ssp/balloon/${b.path}`);
      const own = this.ghostRoot.slice(SSP_GHOSTS.length, -1);
      const ghosts = /* @__PURE__ */ new Map([[own.toLowerCase(), { path: own, g: null }]]);
      for (const g of site.ghosts || []) {
        const path = g && g.id ? safe(g.id) : null;
        if (path && !ghosts.has(path.toLowerCase())) ghosts.set(path.toLowerCase(), { path, g });
      }
      for (const { path, g } of ntfsOrder([...ghosts.values()])) {
        const dir = `${SSP_GHOSTS}${path}/`;
        this.mkdirs(dir);
        if (!g) continue;
        this.mkdirs(dir + "ghost/master");
        this.M.FS.writeFile(`${dir}${GHOST_MASTER}descript.txt`, this._descript(g));
      }
    }
    /** Another site ghost's descript.txt as the engine reads it (YAYA: UTF-8). */
    _descript(g) {
      return enc2.encode(sspDescript(g));
    }
    writeFile(rel, data) {
      const full = this.ghostRoot + String(rel).replace(/^\/+/, "");
      this.mkdirs(full.slice(0, full.lastIndexOf("/")));
      this.M.FS.writeFile(full, toU8(data));
    }
    /**
     * All regular files under the ghost root: Map(ghost-root-relative path -> stamp `mtime:size:inode`), so a file
     * renamed over another, or deleted and written again, counts even where the mtime stayed (_hot covers a rewrite in
     * place). A name its folder lists for a node MEMFS no longer has (an unlink in another case before build.py's J1)
     * is dropped from the folder: the file is gone. It walks MEMFS's nodes (a folder's `contents` is the name list
     * readdir gives, in the same order) instead of resolving each path: bthver.5's 1,507 files cost about 16 ms by path
     * and about 1 ms this way [measured].
     */
    scan() {
      const FS = this.M.FS;
      const out = /* @__PURE__ */ new Map();
      this.scans++;
      const listed = this._listedCheck(FS);
      const walk = (parent, rel) => {
        const contents = parent.contents;
        for (const name of Object.keys(contents)) {
          const node = contents[name];
          if (!listed(parent, name, node)) {
            delete contents[name];
            continue;
          }
          if (FS.isDir(node.mode)) walk(node, rel + name + "/");
          else if (FS.isFile(node.mode)) out.set(rel + name, `${+node.mtime}:${node.usedBytes}:${node.id}`);
          else {
            const st = FS.stat(this.ghostRoot + rel + name);
            if (FS.isDir(st.mode)) walk(FS.lookupPath(this.ghostRoot + rel + name).node, rel + name + "/");
            else out.set(rel + name, `${+st.mtime}:${st.size}:${st.ino}`);
          }
        }
      };
      walk(FS.lookupPath(this.ghostRoot).node, "");
      return out;
    }
    /**
     * (parent, name, node) -> whether MEMFS's name table still holds `node` under that name (a stale name: false). The
     * table's own hash chain when the build exposes it, else FS.lookupNode as FS.readdir's callers see it.
     */
    _listedCheck(FS) {
      if (Array.isArray(FS.nameTable) && typeof FS.hashName === "function") {
        return (parent, name, node) => {
          for (let n = FS.nameTable[FS.hashName(parent.id, name)]; n; n = n.name_next) if (n === node) return true;
          return false;
        };
      }
      return (parent, name, node) => {
        try {
          return FS.lookupNode(parent, name) === node;
        } catch (e) {
          return false;
        }
      };
    }
    /**
     * FNV-1a of every file a scan stamped in the millisecond it ran: MEMFS stamps mtimes with Date.now(), so a rewrite
     * later in that millisecond (or while a coarse or frozen clock stays on it: Firefox's resistFingerprinting, the
     * sweep's followClock) keeps the stamp, and only the bytes tell.
     * @param {Map<string, string>} now a scan, just taken
     */
    _hot(now) {
      const at = Date.now();
      const hot = /* @__PURE__ */ new Map();
      for (const [p, stamp] of now) if (parseInt(stamp, 10) >= at) hot.set(p, this._digest(p));
      return hot;
    }
    _digest(p) {
      return fnv1a(this.M.FS.readFile(this.ghostRoot + p));
    }
    /** diffScan, plus the files of `hot` whose stamp stayed while their bytes changed. */
    _diff(base, hot, now) {
      const d = diffScan(base, now, this.inputs);
      for (const [p, h] of hot) {
        if (now.get(p) === base.get(p) && !LOG_FILE.test(p) && this._digest(p) !== h) d.changed.push(p);
      }
      return d;
    }
    /**
     * Files changed since the last report, the first time since the scan before load: {path: ArrayBuffer | null |
     * false} (diffScan and _hot). No scan when nothing could have changed: no FS write since the last report
     * (watchWrites) and no file stamped in its millisecond (`hot`).
     */
    changedFiles() {
      if (!this.dirty && !this.hot.size) return {};
      const now = this.scan();
      this.dirty = false;
      const { changed, gone } = this._diff(this.baseline, this.hot, now);
      const out = {};
      for (const p of changed) {
        const u8 = this.M.FS.readFile(this.ghostRoot + p);
        out[p] = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      }
      Object.assign(out, gone);
      this.baseline = now;
      this.hot = this._hot(now);
      return out;
    }
    /** One of the engine's own log lines to onEngineLog (the host's failure there is its own). */
    _engineLog(line2) {
      if (!this.onEngineLog) return;
      try {
        this.onEngineLog(line2);
      } catch (e) {
      }
    }
    /**
     * Only the dictionary stamp: YAYA's talk timer is in the ghost's own variables (absolute GETSECCOUNT), Kawari's
     * state in its dictionary (the snapshot key), so time away counts as idle, as with Satori's P6. Read back in init;
     * setVolatileState stays a no-op.
     */
    getVolatileState() {
      return this.dicStamp ? { dicStamp: this.dicStamp } : null;
    }
  };

  // src/worker/engines/yaya.js
  var enc3 = new TextEncoder();
  var STATUS = /* @__PURE__ */ new Map([[-1, "no engine"], [0, "normal"], [1, "emergency"], [2, "suppressed"], [3, "shell mode"]]);
  var MODES = ["info", "fatal", "error", "warning", "note", "info"];
  function timeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {
      return "";
    }
  }
  var YayaEngine = class extends SspRootShiori {
    /**
     * @param {{engineUrl: string, ghostDir?: string, log?: Function, saori?: object, opts?: object|null,
     *   onEngineLog?: Function|null}} o opts: the worker's engineOpts, plain JSON from the page ({module, ghostId,
     *   placeholders, site: {ghosts, balloons}, lang?}); onEngineLog({mode, text}): YAYA's own log lines for in-process
     *   users (the sweep, tests). ghostDir is not used: the ghost lives at /ssp/ghost/<id>/ghost/master/
     */
    constructor(o) {
      super(o);
      this.module = this.opts.module || "yaya";
      this.status = null;
      this._lines = new LogLines();
    }
    async factory() {
      if (typeof self.createYaya !== "function") importScripts(this.engineUrl);
      return self.createYaya;
    }
    async boot() {
      const t0 = clock();
      const lang = this.opts.lang;
      await super.boot({
        saoriBridge: rootBridge(this.saori, this.ghostRoot),
        yayaLog: (text, mode) => this._onYayaLog(text, mode),
        // coreinfo.timezone / GETTIMEZONE name the visitor's zone; LANG picks YAYA's message language (without it
        // Emscripten's default comes from navigator.languages)
        preRun: [(M) => {
          const tz = timeZone();
          if (tz) M.ENV.TZ = tz;
          if (lang) M.ENV.LANG = `${String(lang).replace("-", "_")}.UTF-8`;
        }]
      });
      this.timing.module = clock() - t0;
    }
    /**
     * @param {{path: string, data: ArrayBuffer}[]} files the site's files with bytes, ghost-root-relative
     * @param {Record<string, ArrayBuffer|null>} persisted the visitor's files, ghost-root-relative (null: deleted)
     * @param {{resume?: boolean, bootEpochMs?: number, volatile?: object|null}} o volatile: the page's stored engine
     *   state on a resume ({dicStamp} of the last boot)
     */
    init(files, persisted2 = {}, { resume = false, bootEpochMs = 0, volatile = null } = {}) {
      const M = this.M;
      if (bootEpochMs > 0) M.bootEpochMs = bootEpochMs;
      const t0 = clock();
      this.dicStamp = dicStamp(files);
      const stampMs = clock() - t0;
      if (this._stampChanged(resume, volatile)) resume = false;
      const placeholders = this._mount(files, persisted2);
      const pre = this.scan();
      const preHot = this._hot(pre);
      const t1 = clock();
      const ok = this.callLoad(this.ghostDir, resume);
      this.timing.load = clock() - t1;
      this._flushLog();
      if (resume && ok && this._diff(pre, preHot, this.scan()).changed.length) this.save();
      this.baseline = pre;
      this.hot = preHot;
      const bytes = (files || []).reduce((n, f) => n + toU8(f.data).length, 0);
      this.log("debug", `yaya ${this.module}: ${STATUS.get(this.status) || this.status}, module ${ms(this.timing.module)} ms, load ${ms(this.timing.load)} ms, stamp ${ms(stampMs)} ms, heap ${(M.HEAPU8.length / 1048576).toFixed(0)} MB, ${(files || []).length} files ${(bytes / 1024).toFixed(0)} KB, ${placeholders} placeholders`);
      return ok;
    }
    /** load, or on a resume yaya_load_resume: load, then the save restored again, so no boot counts (yaya-wasm.md). */
    callLoad(dir, resume) {
      const M = this.M;
      const name = enc3.encode(this.module);
      const p = this._toHeap(name);
      try {
        M._yaya_set_module_name(p, name.length);
      } finally {
        M._free(p);
      }
      const b = enc3.encode(dir);
      try {
        const r = this._stackGuard(() => (resume ? M._yaya_load_resume : M._load)(this._toHeap(b), b.length));
        if (resume && r === 0) this.log("warn", "the resume load failed inside the engine");
      } catch (e) {
        this.log("error", `load: ${e}`);
        return false;
      }
      const st = M._yaya_load_status();
      this.status = st;
      switch (st) {
        case 0:
          return true;
        case 1:
          this.log("warn", `emergency mode: ${this.module}_emerg.txt answers`);
          return true;
        case 2:
          this.log("warn", "nothing usable loaded (dictionary errors; details with ?sumika-debug)");
          return false;
        case 3:
          this.log("warn", `no ${this.module}.txt or no dictionary: the index's module is wrong or the ghost has no config`);
          return false;
        default:
          this.log("warn", "load() left no engine");
          return false;
      }
    }
    request(text) {
      const r = super.request(text);
      this._flushLog();
      return r;
    }
    /** yaya_save: <module>_variable.cfg now, as unload would write it (only when save.auto is on). */
    save() {
      try {
        return this.M._yaya_save() === 1;
      } catch (e) {
        this.log("error", `yaya_save: ${e}`);
        return false;
      }
    }
    unload() {
      const files = super.unload();
      this._flushLog();
      return files;
    }
    _onYayaLog(text, mode) {
      for (const l of this._lines.push(text, mode)) this._logLine(l);
    }
    _flushLog() {
      for (const l of this._lines.flush()) this._logLine(l);
    }
    /** fatal/error/warning/note: the page console at debug (?sumika-debug) and onEngineLog; info, other: onEngineLog. */
    _logLine({ mode, text }) {
      const name = MODES[mode];
      if (!name) return;
      if (mode >= 1 && mode <= 4) this.log("debug", `yaya ${name}: ${text}`);
      this._engineLog({ mode: name, text });
    }
  };

  // src/core/shiori.js
  var CRLF = "\r\n";
  function clean(v) {
    return String(v ?? "").replace(/\r\n|\r|\n/g, " ");
  }
  var BASE_HEADERS = Object.freeze({ Charset: "UTF-8", Sender: "SSP", SenderType: "internal", SecurityLevel: "local" });
  function buildRequest(r, base) {
    let s = `${r.method || "GET"} SHIORI/3.0${CRLF}`;
    const h = { ...base, ...r.headers || {} };
    for (const [k, v] of Object.entries(h)) if (v !== void 0 && v !== null && v !== "") s += `${k}: ${clean(v)}${CRLF}`;
    s += `ID: ${clean(r.id)}${CRLF}`;
    (r.refs || []).forEach((v, i) => {
      if (v !== void 0 && v !== null) s += `Reference${i}: ${clean(v)}${CRLF}`;
    });
    return s + CRLF;
  }
  function parseResponse(text) {
    const lines = String(text || "").split(/\r\n|\n/);
    const m = /^SHIORI\/(\d\.\d)\s+(\d+)\s*(.*)$/.exec(lines[0] || "");
    const res = {
      status: m ? +m[2] : 500,
      statusText: m ? m[3] : "Bad Response",
      headers: /* @__PURE__ */ new Map(),
      value: null,
      protocol: m ? parseFloat(m[1]) : 3
    };
    for (let i = 1; i < lines.length; i++) {
      const line2 = lines[i];
      if (line2 === "") break;
      const c = line2.indexOf(": ");
      if (c < 0) continue;
      const k = line2.slice(0, c).toLowerCase();
      if (!res.headers.has(k)) res.headers.set(k, line2.slice(c + 2));
    }
    res.value = res.headers.get("value") ?? null;
    return res;
  }

  // src/worker/engines/kawari.js
  var enc4 = new TextEncoder();
  var latin1 = new TextDecoder("latin1");
  var RESUME_KEY = "?kawari/resume.kis";
  var SNAPSHOT_DIR = "/sumika";
  var SNAPSHOT = `${SNAPSHOT_DIR}/resume.kis`;
  var STAMP_LINE = /^# dicStamp ([0-9a-f]{8})\r?\n/;
  var NO_KAWARIRC = "no kawarirc.kis: nothing to load";
  var SSP_GHOSTS_LEN = "/ssp/ghost/".length;
  var D6_FINISHED = 'the last session ended without Close: it was closed from its snapshot (OnClose "system", OnUnload) before this boot';
  var END_SESSION_REFS = Object.freeze(["system", "0", "0"]);
  function endSessionRequest(id, refs = END_SESSION_REFS, headers = {}) {
    return buildRequest({ id, refs, headers }, BASE_HEADERS);
  }
  var scriptOf = (text) => {
    const r = parseResponse(text);
    return r.status >= 200 && r.status < 300 && r.value ? r.value : null;
  };
  function cp932Writable(text, encode) {
    const bytes = encode(text);
    if (!bytes) return true;
    return new TextDecoder("shift_jis").decode(bytes) === text;
  }
  function runAt(startMs, fn) {
    const now = Date.now;
    const t0 = now();
    if (!(Number.isFinite(startMs) && startMs > 0 && startMs < t0)) {
      fn();
      return 0;
    }
    Date.now = () => startMs + (now() - t0);
    try {
      fn();
    } finally {
      Date.now = now;
    }
    return startMs;
  }
  function stampSnapshot(stamp, body) {
    const head = enc4.encode(`# dicStamp ${stamp}
`);
    const out = new Uint8Array(head.length + body.length);
    out.set(head);
    out.set(body, head.length);
    return out;
  }
  function snapshotStamp(bytes) {
    const u8 = toU8(bytes);
    const m = STAMP_LINE.exec(latin1.decode(u8.subarray(0, 40)));
    return m ? m[1] : null;
  }
  function kawariLogMode(text) {
    const s = String(text);
    if (/: error: /.test(s)) return "error";
    if (/: warning: /.test(s)) return "warning";
    return "log";
  }
  var sameBytes = (a, b) => {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  var copyBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  var KawariEngine = class extends SspRootShiori {
    /**
     * @param {{engineUrl: string, ghostDir?: string, log?: Function, saori?: object, opts?: object|null,
     *   onEngineLog?: Function|null}} o opts: the worker's engineOpts ({ghostId, placeholders, site: {ghosts,
     *   balloons}}); onEngineLog({mode, text}): Kawari's own log lines (kawariLogMode) for in-process users (the sweep,
     *   tests). ghostDir is not used: the ghost lives at /ssp/ghost/<id>/ghost/master/
     */
    constructor(o) {
      super(o);
      this.entries = 0;
      this.resumed = "";
      this.d6Close = null;
      this.d6At = 0;
      this._snapKnown = null;
      this._snapOut = null;
    }
    async factory() {
      if (typeof self.createKawari !== "function") importScripts(this.engineUrl);
      return self.createKawari;
    }
    async boot() {
      const t0 = clock();
      await super.boot({
        saoriBridge: rootBridge(this.saori, this.ghostRoot),
        kawariLog: (text) => this._kawariLog(text)
        // patches K8/K9: one call per line, UTF-8, error|warning
      });
      this.timing.module = clock() - t0;
    }
    /**
     * @param {{path: string, data: ArrayBuffer}[]} files the site's files with bytes, ghost-root-relative
     * @param {Record<string, ArrayBuffer|null>} persisted the visitor's files, ghost-root-relative (null: deleted), and
     *   the snapshot key
     * @param {{resume?: boolean, volatile?: object|null, sessionEndMs?: number}} o volatile: the page's stored engine
     *   state on a resume ({dicStamp} of the last boot); the worker's bootEpochMs is not used (Kawari's clock is the
     *   date); sessionEndMs: on a cold boot, the page's last write of the ghost state (its savedAt, flushed at pagehide):
     *   D6 runs the last session's close and unload on a clock from there (runAt), then the real clock again; 0 = unknown
     * A stored snapshot is dropped (a site update), restored (a resume) or, on a cold boot, finished (D6): restore, the
     * close from outside (closeFromOutside), OnUnload, then the cold load.
     */
    init(files, persisted2 = {}, { resume = false, volatile = null, sessionEndMs = 0 } = {}) {
      const M = this.M;
      const t0 = clock();
      this.dicStamp = dicStamp(files);
      const stampMs = clock() - t0;
      const stale = this._stampChanged(resume, volatile);
      if (stale) resume = false;
      const own = { ...persisted2 || {} };
      const key = this.resumeKey;
      const stored = Object.prototype.hasOwnProperty.call(own, key) ? own[key] : void 0;
      delete own[key];
      this._snapKnown = stored ? toU8(stored).slice() : stored === void 0 ? null : new Uint8Array(0);
      this._snapOut = null;
      this.resumed = "";
      this.d6Close = null;
      this.d6At = 0;
      const placeholders = this._mount(files, own);
      this.mkdirs(SNAPSHOT_DIR);
      const pre = this.scan();
      const preHot = this._hot(pre);
      const report = (ok2) => {
        this.baseline = pre;
        this.hot = preHot;
        return ok2;
      };
      const folder = this.ghostRoot.slice(SSP_GHOSTS_LEN, -1);
      if (!cp932Writable(folder, (t) => this._cp932(t))) {
        this.log("warn", `site id "${folder}" is not writable in code page 932: Kawari would not find its files`);
        return report(false);
      }
      if (!M.FS.analyzePath(this.ghostDir + this.rcFile).exists) {
        this.log("warn", this.rcFile === "kawarirc.kis" ? NO_KAWARIRC : `no ${this.rcFile}: nothing to load`);
        return report(false);
      }
      const t1 = clock();
      let ok = this._load();
      this.timing.load = clock() - t1;
      const snap = this._snapKnown && this._snapKnown.length ? this._snapKnown : null;
      if (ok && snap) {
        if (stale || snapshotStamp(snap) !== this.dicStamp) {
          if (!stale) this.log("info", "the snapshot of the last session is of other dictionaries: dropped");
          this._forget();
          this.resumed = "dropped";
        } else if (resume) {
          if (this._restore(snap)) this.resumed = "restored";
        } else {
          this.log("info", D6_FINISHED);
          const restored = this._restore(snap);
          this.d6At = runAt(sessionEndMs, () => {
            if (restored) this.d6Close = this.closeFromOutside();
            try {
              this._stackGuard(() => M._unload());
            } catch (e) {
              this.log("error", `unload: ${e}`);
            }
          });
          if (this.d6At) {
            this.log("debug", `${this.name}: closed at the session's end, ${Math.round((Date.now() - this.d6At) / 6e4)} min before this boot`);
          }
          ok = this._load();
          this._forget();
          this.resumed = "finished";
        }
      }
      const bytes = (files || []).reduce((n, f) => n + toU8(f.data).length, 0);
      this.log("debug", `${this.name}: module ${ms(this.timing.module)} ms, load ${ms(this.timing.load)} ms, stamp ${ms(stampMs)} ms, heap ${(M.HEAPU8.length / 1048576).toFixed(0)} MB, ${(files || []).length} files ${(bytes / 1024).toFixed(0)} KB, ${placeholders} placeholders, ${this.entries} entries${this.resumed ? `, snapshot ${this.resumed}` : ""}`);
      return report(ok);
    }
    /** the snapshot's key in the stored files (RESUME_KEY; another one per engine) */
    get resumeKey() {
      return RESUME_KEY;
    }
    /** the file whose absence means nothing to load */
    get rcFile() {
      return "kawarirc.kis";
    }
    /** the engine's name in the debug log */
    get name() {
      return "kawari";
    }
    /** _load, then the baseline the snapshots are taken against (patch K12). */
    _load() {
      const ok = this.callLoad(this.ghostDir, false);
      this.entries = ok && typeof this.M._kawari_baseline === "function" ? this._stackGuard(() => this.M._kawari_baseline()) : 0;
      return ok;
    }
    /** A stored snapshot into the running engine (after its load and baseline); false (logged) when it did not load. */
    _restore(snap) {
      const M = this.M;
      let r = 0;
      try {
        M.FS.writeFile(SNAPSHOT, snap);
        r = this._withPath(SNAPSHOT, (p) => this._restoreCall(p));
      } catch (e) {
        this.log("error", `kawari_restore: ${e}`);
      }
      if (r !== 1) this.log("warn", "the resume snapshot did not load: this page goes on from the ghost's own save");
      return r === 1;
    }
    /** the engine's restore export on a MEMFS path (a pointer): 1 when it loaded */
    _restoreCall(p) {
      return this.M._kawari_restore(p);
    }
    /** the engine's snapshot export: its size, 0 = nothing, -1 = failed */
    _snapshotCall(p) {
      return this.M._kawari_snapshot(p, 0);
    }
    /** whether the build has the snapshot exports */
    _canSnapshot() {
      return typeof this.M._kawari_snapshot === "function";
    }
    /** The stored snapshot is done with: the key becomes the empty marker (met, nothing to restore) at the next report. */
    _forget() {
      const empty = new Uint8Array(0);
      if (!sameBytes(this._snapKnown, empty)) this._snapOut = empty;
      this._snapKnown = empty;
    }
    /** fn(pointer to `path` as a NUL-terminated UTF-8 string), freed after; under the stack guard. */
    _withPath(path, fn) {
      const b = enc4.encode(path);
      const p = this._toHeap(b);
      try {
        return this._stackGuard(() => fn(p));
      } finally {
        this.M._free(p);
      }
    }
    /**
     * The worker's save (debounced, urgent after choices, at page hide): a snapshot of the entries that differ from this
     * load's baseline and of those the load made (K12: left by load with other words than its definitions, changed or
     * not; kawari-wasm.md §8), reported under RESUME_KEY by the next changedFiles() when its bytes changed. Nothing to
     * carry = the empty marker. Entries restored from the last page differ from this one's baseline too, so they stay in
     * it.
     * @returns {boolean} a snapshot was taken
     */
    save() {
      const M = this.M;
      if (!M || !this._canSnapshot()) return false;
      let n = -1;
      const dirty = this.dirty;
      try {
        this.mkdirs(SNAPSHOT_DIR);
        n = this._withPath(SNAPSHOT, (p) => this._snapshotCall(p));
      } catch (e) {
        this.log("error", `kawari_snapshot: ${e}`);
        return false;
      } finally {
        this.dirty = dirty;
      }
      if (n < 0) return false;
      const bytes = n > 0 ? stampSnapshot(this.dicStamp, M.FS.readFile(SNAPSHOT)) : new Uint8Array(0);
      if (!sameBytes(bytes, this._snapKnown)) {
        this._snapOut = bytes;
        this._snapKnown = bytes;
      }
      return true;
    }
    /** The ghost's files changed since the last report (SspRootShiori), and the snapshot key when it changed. */
    changedFiles() {
      const out = super.changedFiles();
      if (this._snapOut) {
        out[this.resumeKey] = copyBuffer(this._snapOut);
        this._snapOut = null;
      }
      return out;
    }
    /**
     * The close ssp.exe 2.9.10 sends each ghost when the session ends from outside (Windows' WM_ENDSESSION; the model of a
     * tab closed without Close, shiori-events.md §2.3.1): GET OnCloseAll [system, 0, 0] BaseID OnClose; when its reply
     * has no script, GET OnClose with the same References; the ghost's script through GET OnTranslate [R0 as returned,
     * R1 '', R2 the event that answered, R3 system] (with the force flag TranslateScript runs before ModuleUnload) [disasm
     * CloseGhostProc 0x4967a2-0x49694a, OnGhostClose 0x7106e0, Translate 0x7135f0]. Every reply is dropped: no page plays
     * it (ssp.exe plays it after the unload while Windows waits). A request that throws answers 500 (the stack restored)
     * and the close goes on. Kawari 7's request() bridges each one to SHIORI/2.x. D6 runs it before the unload; the sweep
     * on a resumed engine.
     * @returns {{steps: {id: string, status: number}[], ms: number}}
     */
    closeFromOutside() {
      const t0 = clock();
      const steps = [];
      const ask = (id2, refs, headers = {}, kind = "") => {
        let reply2 = "";
        try {
          reply2 = this.request(endSessionRequest(id2, refs, headers), kind ? { kind } : {});
        } catch (e) {
          this.log("error", `${id2}: ${e}`);
        }
        steps.push({ id: id2, status: parseResponse(reply2).status });
        return scriptOf(reply2);
      };
      let id = "OnCloseAll";
      let script = ask(id, END_SESSION_REFS, { BaseID: "OnClose" });
      if (!script) {
        id = "OnClose";
        script = ask(id, END_SESSION_REFS);
      }
      if (script) ask("OnTranslate", [script, "", id, END_SESSION_REFS[0]], {}, "translate");
      const t = clock() - t0;
      const list = steps.map((s) => `${s.id} ${s.status}`).join(", ");
      this.log("debug", `${this.name}: closed from outside: ${list} (${ms(t)} ms)`);
      return { steps, ms: t };
    }
    /**
     * Close, a ghost change, Quit: _unload runs System.Callback.OnUnload (the ghost saves itself), then the snapshot key
     * becomes the empty marker (D7: met, nothing to restore). After an unload that threw, the last snapshot stays.
     */
    unload() {
      let ok = true;
      try {
        this._stackGuard(() => this.M._unload());
      } catch (e) {
        ok = false;
        this.log("error", `unload: ${e}`);
      }
      if (ok) this._forget();
      return this.changedFiles();
    }
    /** Another site ghost's descript.txt in code page 932 saying charset,Shift_JIS (kawari-wasm.md §6; UTF-8 without the export). */
    _descript(g) {
      const cp932 = this._cp932(sspDescript(g, "Shift_JIS"));
      return cp932 || enc4.encode(sspDescript(g));
    }
    /** UTF-8 text -> code page 932 bytes with the build's encoder (ssp.exe's best fit; '?' for what 932 lacks). */
    _cp932(text) {
      const M = this.M;
      const conv = M[this.cp932Export];
      if (typeof conv !== "function") return null;
      const b = enc4.encode(text);
      const p = this._toHeap(b);
      const lenp = M._malloc(4);
      try {
        const r = conv(p, b.length, lenp);
        if (!r) return null;
        const out = M.HEAPU8.slice(r, r + M.HEAP32[lenp >> 2]);
        M._free(r);
        return out;
      } finally {
        M._free(lenp);
        M._free(p);
      }
    }
    /** the build's UTF-8 -> code page 932 export */
    get cp932Export() {
      return "_kawari_utf8_to_cp932";
    }
    /** Kawari's log: the page console at debug (?sumika-debug), and onEngineLog. */
    _kawariLog(text) {
      const line2 = String(text == null ? "" : text);
      if (!line2.trim()) return;
      this.log("debug", `${this.name}: ${line2}`);
      this._engineLog({ mode: kawariLogMode(line2), text: line2 });
    }
  };

  // src/worker/engines/shiori2.js
  var CRLF2 = "\r\n";
  var VERSION_REQUEST = `GET Version SHIORI/2.6${CRLF2}Charset: UTF-8${CRLF2}Sender: SSP${CRLF2}${CRLF2}`;
  var VERSION_PROBE_30 = `GET SHIORI/3.0${CRLF2}Charset: UTF-8${CRLF2}ID: version${CRLF2}SecurityLevel: local${CRLF2}Sender: SSP${CRLF2}${CRLF2}`;
  var SKIPPED = /* @__PURE__ */ new Set(["basewareversion", "capability", "enable_log", "enable_debug"]);
  var CUT_TO_8 = /* @__PURE__ */ new Set(["installedsakuraname", "installedkeroname", "installedghostname"]);
  var Shiori2Session = class {
    constructor() {
      this.version = 0;
      this.charset = "Shift_JIS";
      this.name = "";
      this.craftman = "";
    }
  };
  function parseMessage(text) {
    const lines = String(text || "").split(/\r\n|\n/);
    const start = lines[0] || "";
    const list = [];
    const map = /* @__PURE__ */ new Map();
    for (let i = 1; i < lines.length; i++) {
      const line2 = lines[i];
      if (line2 === "") break;
      const c = line2.indexOf(":");
      if (c < 0) continue;
      const name = line2.slice(0, c);
      const value = line2.slice(c + 1).replace(/^ +/, "");
      list.push([name, value]);
      const k = name.toLowerCase();
      if (!map.has(k)) map.set(k, value);
    }
    const refs = [];
    for (const [name, value] of list) {
      const m = /^reference(\d+)$/i.exec(name);
      if (m) refs[+m[1]] = value;
    }
    return { start, list, map, refs, get: (k) => map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null };
  }
  function readVersionReply(reply2, session2) {
    const msg = parseMessage(reply2);
    const m = /^[^/]*\/\s*([0-9.]+)\s+(\d+)/.exec(msg.start);
    const version = m ? Math.floor(parseFloat(m[1]) * 10 + 0.5) : 0;
    const status = m ? +m[2] : 400;
    session2.version = version;
    if (status >= 200 && status < 300) {
      if (msg.get("ID") !== null) session2.name = msg.get("ID");
      if (msg.get("Craftman") !== null) session2.craftman = msg.get("Craftman");
    }
    const cs = msg.get("Charset");
    if (cs) session2.charset = cs;
    return { version, status, probe30: status >= 400 && status < 500 || version >= 30 };
  }
  var line = (name, value) => `${name}: ${value == null ? "" : value}${CRLF2}`;
  function allRefs(refs, from = 0, limit = Infinity) {
    let s = "";
    const n = Math.min(refs.length, from + limit);
    for (let i = from; i < n; i++) s += line(`Reference${i - from}`, refs[i] == null ? "" : refs[i]);
    return s;
  }
  function toShiori2(text, session2, { kind = "", self: self2 = "" } = {}) {
    const q = parseMessage(text);
    const method = /^NOTIFY/i.test(q.start) ? "NOTIFY" : "GET";
    const id = q.get("ID") || "";
    const cs = session2.charset || "Shift_JIS";
    const sender = q.get("Sender") || "SSP";
    const level2 = q.get("SecurityLevel") || "local";
    const status = q.get("Status");
    const refs = q.refs;
    if (kind === "resource") {
      return [{ kind: "string", text: `GET String SHIORI/2.5${CRLF2}${line("Charset", cs)}${line("SecurityLevel", level2)}${line("SecurityOrigin", q.get("SecurityOrigin") || "null")}${line("Sender", sender)}${line("ID", id)}${status ? line("Status", status) : ""}${allRefs(refs)}${CRLF2}` }];
    }
    if (kind === "translate") {
      if (session2.version < 26) return [];
      const remote = /remote/i.test(refs[1] || "");
      return [{ kind: "translate", text: `TRANSLATE Sentence SHIORI/2.6${CRLF2}${line("Charset", cs)}${line("SecurityLevel", remote ? "external" : "local")}${line("SecurityOrigin", "null")}${line("Sender", sender)}${status ? line("Status", status) : ""}${line("Sentence", refs[0] || "")}${CRLF2}` }];
    }
    if (kind === "word") {
      return [{ kind: "word", text: `GET Word SHIORI/2.0${CRLF2}${line("Charset", cs)}${line("Sender", sender)}${line("Type", id)}${CRLF2}` }];
    }
    if (kind === "teach") {
      return [{ kind: "teach", text: `TEACH SHIORI/2.4${CRLF2}${line("Charset", cs)}${line("SecurityLevel", "local")}${line("Sender", sender)}${line("Word", refs[0] || "")}${allRefs(refs, 1)}${CRLF2}` }];
    }
    if (kind === "communicate-user") {
      return [{ kind: "sentence", text: `GET Sentence SHIORI/2.0${CRLF2}${line("Charset", cs)}${line("SecurityLevel", "local")}${line("Sender", "User")}${line("Sentence", refs[1] || "")}${allRefs(refs, 2)}${CRLF2}` }];
    }
    if (kind === "communicate") {
      let extra = "";
      for (let i = 2; i < refs.length; i++) if (refs[i] != null) extra += line(`Reference${i - 2}`, refs[i]);
      const marker = q.get("Marker");
      const surface = q.get("Surface");
      return [{ kind: "sentence", text: `GET Sentence SHIORI/2.3${CRLF2}${line("Charset", cs)}${line("SecurityLevel", level2)}${line("Sender", refs[0] || "")}${line("Sentence", refs[1] || "")}${line("To", self2)}${line("Age", q.get("Age") || "0")}${marker !== null ? line("Marker", marker) : ""}${surface !== null ? line("Surface", surface) : ""}${extra}${CRLF2}` }];
    }
    if (method === "NOTIFY" && SKIPPED.has(id)) return [];
    if (method === "NOTIFY" && id === "ownerghostname") {
      return [{ kind: "notify", text: `NOTIFY OwnerGhostName SHIORI/2.3${CRLF2}${line("Charset", cs)}${line("Sender", sender)}${line("Ghost", refs[0] || "")}${CRLF2}` }];
    }
    if (method === "NOTIFY" && id === "otherghostname") {
      let ghosts = "";
      for (const r of refs) {
        if (r == null) continue;
        ghosts += line("GhostEx", r) + line("Ghost", String(r).split("")[0]);
      }
      return [{ kind: "notify", text: `NOTIFY OtherGhostName SHIORI/2.3${CRLF2}${line("Charset", cs)}${line("Sender", sender)}${ghosts}${CRLF2}` }];
    }
    const base = q.get("BaseID");
    const list = CUT_TO_8.has(id) ? refs.slice(0, 8) : refs;
    return [{ kind: method === "NOTIFY" ? "notify" : "event", text: `GET Sentence SHIORI/2.2${CRLF2}${line("Charset", cs)}${line("SecurityLevel", level2)}${line("Sender", sender)}${line("Event", id)}${base ? line("BaseEvent", base) : ""}${status ? line("Status", status) : ""}${allRefs(list)}${CRLF2}` }];
  }
  var SCRIPT_HEADERS = { string: ["Value", "String", "Sentence"], word: ["Value", "Word"] };
  var DEFAULT_SCRIPT = ["Value", "Sentence"];
  function fromShiori2(reply2, kind) {
    if (reply2 == null || reply2 === "") return `SHIORI/2.6 500 Internal Server Error${CRLF2}Charset: UTF-8${CRLF2}${CRLF2}`;
    const msg = parseMessage(reply2);
    const m = /^SHIORI\/(\d+\.\d+)\s+(\d+)\s*(.*)$/.exec(msg.start);
    const proto = m ? m[1] : "2.6";
    const code = m ? +m[2] : 400;
    let out = `SHIORI/${proto} ${code} ${m ? m[3] : "Bad Request"}${CRLF2}Charset: UTF-8${CRLF2}`;
    for (const [name, value] of msg.list) {
      if (/^(charset|value)$/i.test(name)) continue;
      out += line(name, value);
    }
    if (code === 200 || code === 311 || code === 312) {
      for (const h of SCRIPT_HEADERS[kind] || DEFAULT_SCRIPT) {
        const v = msg.get(h);
        if (v) {
          out += line("Value", v);
          break;
        }
      }
    }
    return out + CRLF2;
  }
  var NOTHING = `SHIORI/2.6 204 No Content${CRLF2}Charset: UTF-8${CRLF2}${CRLF2}`;

  // src/worker/engines/kawari7.js
  var enc5 = new TextEncoder();
  var dec2 = new TextDecoder("utf-8");
  var RESUME_KEY7 = "?kawari7/resume.k7";
  var isUtf8 = (cs) => /^utf-?8$/i.test(String(cs || "").trim());
  var Kawari7Engine = class extends KawariEngine {
    constructor(o) {
      super(o);
      this.session = new Shiori2Session();
    }
    async factory() {
      if (typeof self.createKawari7 !== "function") importScripts(this.engineUrl);
      return self.createKawari7;
    }
    get resumeKey() {
      return RESUME_KEY7;
    }
    get rcFile() {
      return "kawari.ini";
    }
    get name() {
      return "kawari7";
    }
    get cp932Export() {
      return "_kawari7_utf8_to_cp932";
    }
    /**
     * load(), then ssp.exe's handshake [disasm GetVersionRequestImpl 0x7130a0]: `GET Version SHIORI/2.6` (ASCII); its
     * status line gives the protocol and its Charset the charset of every later request; only a 4xx or a 3.0 answer
     * would bring the 3.0 probe. The snapshot's baseline is taken inside the build (before system.OnLoad, patch C7).
     */
    _load() {
      this.session = new Shiori2Session();
      const ok = this.callLoad(this.ghostDir, false);
      this.entries = ok && typeof this.M._kawari7_entries === "function" ? this.M._kawari7_entries() : 0;
      if (ok) {
        const first = readVersionReply(this._exchange(VERSION_REQUEST, "ascii") || "", this.session);
        if (first.probe30) readVersionReply(this._exchange(VERSION_PROBE_30, "ascii") || "", this.session);
        this.log("debug", `kawari7: ${this.session.name || "?"} SHIORI/${(this.session.version / 10).toFixed(1)}, ${this.session.charset}`);
      }
      return ok;
    }
    _restoreCall(p) {
      return this.M._kawari7_restore(p);
    }
    _snapshotCall(p) {
      return this.M._kawari7_snapshot(p);
    }
    _canSnapshot() {
      return typeof this.M._kawari7_snapshot === "function";
    }
    /** code page 932 bytes -> text with the build's decoder (MultiByteToWideChar(932, 0)) */
    _fromCp932(bytes) {
      const M = this.M;
      const p = this._toHeap(bytes);
      const lenp = M._malloc(4);
      try {
        const r = M._kawari7_cp932_to_utf8(p, bytes.length, lenp);
        if (!r) return "";
        const out = dec2.decode(M.HEAPU8.subarray(r, r + M.HEAP32[lenp >> 2]));
        M._free(r);
        return out;
      } finally {
        M._free(lenp);
        M._free(p);
      }
    }
    /**
     * One raw exchange: `text` encoded as `charset` (default: the session's) into the engine, its reply decoded the same
     * way; null when the engine threw (a runaway recursion: the stack guard puts the stack pointer back).
     */
    _exchange(text, charset = this.session.charset) {
      const M = this.M;
      const utf82 = charset === "ascii" || isUtf8(charset);
      const b = utf82 ? enc5.encode(text) : this._cp932(text) || enc5.encode(text);
      const p = this._toHeap(b);
      const lenp = M._malloc(4);
      M.HEAP32[lenp >> 2] = b.length;
      let r = 0;
      try {
        r = this._stackGuard(() => M._request(p, lenp));
      } catch (e) {
        M._free(lenp);
        this.log("error", `request: ${e}`);
        return null;
      }
      const n = M.HEAP32[lenp >> 2];
      M._free(lenp);
      if (!r) return null;
      const bytes = M.HEAPU8.slice(r, r + n);
      M._free(r);
      return isUtf8(this.session.charset) && charset !== "ascii" ? dec2.decode(bytes) : this._fromCp932(bytes);
    }
    /**
     * The page's SHIORI/3.0 request -> the SHIORI/2.x request ssp.exe would send for it (shiori2.js toShiori2; none for
     * what it never sends a 2.x SHIORI: 204) -> the page's reply (fromShiori2).
     * @param {string} text  @param {{kind?: string, self?: string}} [meta] the page's call (shiori2.js)
     */
    request(text, meta = {}) {
      const plan = toShiori2(text, this.session, meta || {});
      if (!plan.length) return NOTHING;
      const step = plan[0];
      return fromShiori2(this._exchange(step.text), step.kind);
    }
  };

  // src/worker/engines/index.js
  var ENGINES = {
    satori: SatoriEngine,
    yaya: YayaEngine,
    kawari: KawariEngine,
    kawari7: Kawari7Engine
  };
  async function createEngine(name, opts) {
    const E = ENGINES[String(name).toLowerCase()];
    if (!E) throw new Error(`no engine for SHIORI "${name}" yet`);
    const e = new E(opts);
    await e.boot();
    return e;
  }

  // src/core/log.js
  var LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  var level = LEVELS.warn;
  try {
    if (typeof location !== "undefined" && /[?&]sumika-debug\b/.test(location.search)) level = LEVELS.debug;
  } catch (e) {
  }

  // src/core/storage.js
  var DB_VERSION = 1;
  var STORE = "kv";
  function idbOpen(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    });
  }
  function idbCall(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : void 0);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  function toB64(buf) {
    const u8 = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8.buffer;
  }
  function encodeLS(v) {
    return JSON.stringify(v, (k, x) => x instanceof ArrayBuffer ? { __ab: toB64(x) } : ArrayBuffer.isView(x) ? { __ab: toB64(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength)) } : x);
  }
  function decodeLS(s) {
    return JSON.parse(s, (k, x) => x && typeof x === "object" && typeof x.__ab === "string" ? fromB64(x.__ab) : x);
  }
  var Store = class _Store {
    /** @param {string} namespace e.g. 'sumika' */
    static async open(namespace) {
      const s = new _Store(namespace);
      try {
        if (typeof indexedDB !== "undefined") s.db = await idbOpen(namespace);
      } catch (e) {
        s.db = null;
      }
      if (!s.db) {
        try {
          const k = `${namespace}:__probe`;
          localStorage.setItem(k, "1");
          localStorage.removeItem(k);
          s.ls = true;
        } catch (e) {
          s.ls = false;
        }
      }
      return s;
    }
    constructor(namespace) {
      this.ns = namespace;
      this.db = null;
      this.ls = false;
      this.mem = /* @__PURE__ */ new Map();
    }
    get kind() {
      return this.db ? "indexeddb" : this.ls ? "localstorage" : "memory";
    }
    async get(key) {
      try {
        return await this.read(key);
      } catch (e) {
      }
      return this.mem.get(key);
    }
    /**
     * get() for a reader that must not take a failed read for "nothing stored" (the worker's save files: schema.js
     * `files`): rejects when IndexedDB or localStorage cannot be read or the value cannot be decoded, where get() answers
     * from this page's memory. undefined when nothing is stored.
     */
    async read(key) {
      if (this.db) return idbCall(this.db, "readonly", (st) => st.get(key));
      if (this.ls) {
        const s = localStorage.getItem(`${this.ns}:${key}`);
        return s == null ? void 0 : decodeLS(s);
      }
      return this.mem.get(key);
    }
    /** @returns {Promise<boolean>} true when the value reached IndexedDB or localStorage (not just memory) */
    async set(key, value) {
      this.mem.set(key, value);
      try {
        if (this.db) {
          await idbCall(this.db, "readwrite", (st) => st.put(value, key));
          return true;
        }
        if (this.ls) {
          localStorage.setItem(`${this.ns}:${key}`, encodeLS(value));
          return true;
        }
      } catch (e) {
      }
      return false;
    }
    /** @returns {Promise<boolean>} false when the browser refused the delete */
    async delete(key) {
      this.mem.delete(key);
      try {
        if (this.db) await idbCall(this.db, "readwrite", (st) => st.delete(key));
        else if (this.ls) localStorage.removeItem(`${this.ns}:${key}`);
        return true;
      } catch (e) {
        return false;
      }
    }
    /** String keys that start with prefix. Rejects when the storage cannot be listed (callers must not guess). */
    async keys(prefix = "") {
      const p = String(prefix);
      if (this.db) {
        const ks = await idbCall(this.db, "readonly", (st) => st.getAllKeys(IDBKeyRange.bound(p, p + "\uFFFF")));
        return ks.filter((k) => typeof k === "string");
      }
      if (this.ls) {
        const out = [], ns = `${this.ns}:`;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(ns + p)) out.push(k.slice(ns.length));
        }
        return out;
      }
      return [...this.mem.keys()].filter((k) => typeof k === "string" && k.startsWith(p));
    }
  };

  // src/core/ghostset.js
  var isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  function uniqueIds(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const id of list) if (typeof id === "string" && id && !out.includes(id)) out.push(id);
    return out;
  }
  function markerGhosts(m) {
    if (!isObj(m)) return [];
    return uniqueIds(Array.isArray(m.ghosts) ? m.ghosts : [m.ghost]);
  }
  function validCarry(e) {
    if (!isObj(e)) return false;
    if (e.kind === "change") return true;
    if (e.kind === "call") return isObj(e.call);
    return e.kind === "after" && (e.of === "call" || e.of === "change");
  }
  function markerCarry(m) {
    if (!isObj(m)) return {};
    if (isObj(m.carry)) {
      const out = {};
      for (const [id, e] of Object.entries(m.carry)) if (id && validCarry(e)) out[id] = e;
      return out;
    }
    if (m.pending === true && typeof m.ghost === "string" && m.ghost) {
      return { [m.ghost]: { kind: "change", change: isObj(m.change) ? m.change : null } };
    }
    return {};
  }

  // src/core/schema.js
  var SCHEMA = Object.freeze({ state: 1, prefs: 1, marker: 2, files: 1, drops: 1, choice: 1 });
  var isObj2 = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  function markerV1toV2(m) {
    if (!isObj2(m)) return m;
    const out = { ...m, ghosts: markerGhosts(m) };
    const carry = markerCarry(m);
    if (Object.keys(carry).length) out.carry = carry;
    return out;
  }
  var STEPS = Object.freeze({ state: {}, prefs: {}, marker: { 1: markerV1toV2 }, files: {}, drops: {}, choice: {} });

  // src/core/drops.js
  var DROP_ROOT = "C:\\sumika\\drop\\";
  var MAX_FILE_BYTES = 64 * 1024 * 1024;
  var MAX_TOTAL_BYTES = 256 * 1024 * 1024;
  var QUOTA_MARGIN_BYTES = 32 * 1024 * 1024;
  var ROOT_LOWER = DROP_ROOT.toLowerCase();
  function dropLower(path) {
    if (path == null) return null;
    const p = String(path).trim().replace(/^"(.*)"$/, "$1").replace(/\//g, "\\").toLowerCase();
    return p.startsWith(ROOT_LOWER) && p.length > ROOT_LOWER.length ? p : null;
  }
  var isDropPath = (path) => dropLower(path) !== null;

  // src/worker/saori/standins.js
  var lower = (v) => String(v == null ? "" : v).trim().toLowerCase();
  var Gomi = class {
    execute(args) {
      const query = args.some((a) => /^-[a-z]*n/i.test(String(a)) || lower(a) === "--number");
      if (query) return { result: "0", values: ["0"] };
      return { result: "" };
    }
  };
  var DsAudio = class {
    constructor(ctx) {
      this.ctx = ctx;
      this.volume = 1e4;
      this.loop = false;
      this.loaded = "";
    }
    execute(args) {
      const cmd = lower(args[0]);
      const rest = args.slice(1).map((a) => a == null ? "" : String(a));
      switch (cmd) {
        case "volume": {
          if (rest[0] === void 0 || rest[0].trim() === "") return { result: String(this.volume) };
          const v = Math.round(Number(rest[0]));
          if (Number.isFinite(v)) this.volume = Math.max(0, Math.min(1e4, v));
          this.ctx.notifyPage("volume", [String(this.volume)]);
          return { result: "" };
        }
        case "loop":
          this.loop = lower(rest[0]) === "enable";
          this.ctx.notifyPage("loop", [this.loop ? "enable" : "disable"]);
          return { result: "" };
        case "load":
          this.loaded = rest.join(",");
          this.ctx.notifyPage("load", [this.loaded]);
          return { result: "1" };
        case "hwnd":
        case "":
          return { result: "" };
        // window handles mean nothing here
        default:
          this.ctx.notifyPage(cmd, rest);
          return { result: "" };
      }
    }
    /** Satori unloads every SAORI on a dictionary reload: the music stops, as with the DLL (TS §3.1). */
    unload() {
      this.ctx.notifyPage("unload", []);
    }
  };
  var FillDesktop = class {
    constructor(ctx) {
      this.ctx = ctx;
    }
    execute(args) {
      const rgb = args.slice(0, 3).map((a) => String(a).trim());
      if (rgb.length && rgb.some((v) => v !== "")) this.ctx.notifyPage("fill", rgb.map((v) => v || "0"));
      else this.ctx.notifyPage("clear", []);
      return { result: "" };
    }
  };
  var Httpc = class {
    execute(args) {
      if (!args.length || args.every((a) => String(a) === "")) return { result: "0" };
      return { result: "" };
    }
  };
  function sjisByteLength(s) {
    let n = 0;
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      n += c < 128 || c >= 65377 && c <= 65439 ? 1 : 2;
    }
    return n;
  }
  var Aya = class {
    constructor(ctx) {
      this.ctx = ctx;
      this.warned = /* @__PURE__ */ new Set();
    }
    execute(args) {
      const fn = lower(args[0]);
      if (fn === "getstrbytes") return { result: String(sjisByteLength(args[1] == null ? "" : args[1])) };
      if (fn.startsWith("read.")) {
        const nf = args[3] != null && String(args[3]) !== "" ? String(args[3]) : "notfound";
        return { result: nf, values: ["-1"] };
      }
      if (!this.warned.has(fn)) {
        this.warned.add(fn);
        this.ctx.log("warn", `SAORI aya: function "${args[0]}" is not available in the browser`);
      }
      return null;
    }
  };
  var ascii = (s) => String(s == null ? "" : s).replace(/[０-９－＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)).trim();
  function pathFromDll(dir, p) {
    const s = String(p == null ? "" : p).trim().replace(/^"(.*)"$/, "$1");
    if (!s || /^[a-z]:[\\/]|^[\\/]{2}|^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    const out = [];
    for (const seg of (String(dir || "").replace(/\\/g, "/") + "/" + s.replace(/\\/g, "/")).split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return out.join("/");
  }
  var McAudio = class {
    constructor(ctx) {
      this.ctx = ctx;
    }
    execute(args) {
      const cmd = lower(args[0]);
      const rest = args.slice(1).map((a) => a == null ? "" : String(a));
      const page = this.ctx.notifyPage;
      switch (cmd) {
        case "load": {
          const given = rest.join(",");
          page("load", [pathFromDll(this.ctx.dir, given), given]);
          break;
        }
        case "play":
          page("loop", ["disable"]);
          page("play", []);
          break;
        case "loop":
          page("loop", ["enable"]);
          page("play", []);
          break;
        case "stop":
        case "pause":
          page(cmd, []);
          break;
        case "":
          break;
        default:
          page(cmd, rest);
      }
      return { result: "" };
    }
    /** The music stops with the DLL (dictionary reload, ghost close), as with dsaudio (TS §3.1). */
    unload() {
      this.ctx.notifyPage("unload", []);
    }
  };
  var TimeCheck = class {
    constructor(ctx) {
      this.now = ctx && ctx.now || (() => Date.now());
    }
    execute(args) {
      if (lower(args[0]) !== "how_many_days") return { result: "" };
      const [y, m, d] = args.slice(1, 4).map((a) => parseInt(ascii(a), 10));
      if (![y, m, d].every(Number.isFinite) || m < 1 || m > 12 || d < 1 || d > 31) return { result: "0" };
      const t = new Date(this.now());
      const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
      return { result: String(Math.round((Date.UTC(y, m - 1, d) - today) / 864e5)) };
    }
  };
  var CPUID_KEYS = /* @__PURE__ */ new Set([
    "platform",
    "os.name",
    "os.version",
    "os.build",
    "cpu.name",
    "cpu.num",
    "cpu.vender",
    "cpu.clock",
    "cpu.clockex",
    "cpu.family",
    "cpu.model",
    "cpu.stepping",
    "cpu.ptype",
    "cpu.mmx",
    "cpu.mmx+",
    "cpu.sse",
    "cpu.sse2",
    "cpu.tdn",
    "cpu.tdn+",
    "mem.os",
    "mem.phyt",
    "mem.phya",
    "mem.virt",
    "mem.vira",
    "mem.pagt",
    "mem.paga"
  ]);
  var CpuId = class {
    constructor(ctx) {
      this.nav = ctx && ctx.navigator || (typeof navigator !== "undefined" ? navigator : {});
    }
    execute(args) {
      const k = lower(args[0]);
      const ua = String(this.nav.userAgent || "");
      const os = /Windows NT (\d+)\.(\d+)/.exec(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "Mac OS X" : /CrOS/.test(ua) ? "Chrome OS" : /Linux/.test(ua) ? "Linux" : "Unknown";
      const ver = (/Windows NT (\d+\.\d+)/.exec(ua) || /Android (\d+(?:\.\d+)?)/.exec(ua) || /OS X (\d+)[._](\d+)/.exec(ua) || /OS (\d+)[._](\d+)/.exec(ua) || []).slice(1).join(".") || "0.0";
      const mem = Number(this.nav.deviceMemory) > 0 ? Math.round(Number(this.nav.deviceMemory) * 1024) : 0;
      const cores = Number(this.nav.hardwareConcurrency) > 0 ? Number(this.nav.hardwareConcurrency) : 1;
      switch (k) {
        case "platform":
          return { result: "ssp.exe" };
        case "os.name":
          return { result: os };
        case "os.version":
          return { result: ver.includes(".") ? ver : ver + ".0" };
        case "cpu.name":
          return { result: "Unknown CPU" };
        case "cpu.vender":
          return { result: "Unknown" };
        case "cpu.num":
          return { result: String(cores) };
        case "cpu.mmx":
        case "cpu.sse":
        case "cpu.sse2":
          return { result: "Ready" };
        case "cpu.mmx+":
        case "cpu.tdn":
        case "cpu.tdn+":
          return { result: "Not Ready" };
        // AMD-only flags [guess]
        case "mem.phyt":
          return { result: String(mem) };
        case "":
          return { result: "" };
        // os.build, clocks, family/model/stepping, other memory figures
        default:
          return { result: CPUID_KEYS.has(k) ? "0" : "Param Error" };
      }
    }
  };
  var SysIo = class {
    execute(args) {
      const fn = lower(args[0]);
      const file = isDropPath(args[1]);
      switch (fn) {
        case "isexist":
        case "isfile":
          return { result: file ? "1" : "0" };
        case "isdir":
          return { result: "0" };
        case "readdir":
          return { result: "-1" };
        default:
          return { result: "" };
      }
    }
  };
  var MAHO_TYPES = { mp3: "mp3", wav: "wav", mid: "midi", midi: "midi", smf: "midi", ogg: "ogg_vorbis", flac: "flac", png: "png", bmp: "bmp", jpg: "jpeg", jpeg: "jpeg", gif: "gif" };
  var Maho = class {
    execute(args) {
      const m = /\.([a-z0-9]+)\s*$/i.exec(String(args[0] == null ? "" : args[0]));
      return { result: m && MAHO_TYPES[m[1].toLowerCase()] || "unknown" };
    }
  };
  var standIns = {
    "gomi.dll": Gomi,
    "empty.dll": Gomi,
    "dsaudio.dll": DsAudio,
    "fill_desktop.dll": FillDesktop,
    "httpc.dll": Httpc,
    "yaya.dll": Aya,
    "aya5.dll": Aya,
    "mciaudior.dll": McAudio,
    "mciaudio.dll": McAudio,
    "time_check.dll": TimeCheck,
    "saori_cpuid.dll": CpuId,
    "sysio.dll": SysIo,
    "maho.dll": Maho
  };

  // src/worker/saori/index.js
  var CRLF3 = "\r\n";
  var utf8 = new TextDecoder("utf-8");
  var sjis = null;
  function parseSaoriRequest(text) {
    const lines = String(text).split(/\r\n|\n/);
    const command = (lines[0] || "").split(" ")[0];
    const headers = /* @__PURE__ */ new Map();
    const args = [];
    for (let i = 1; i < lines.length && lines[i] !== ""; i++) {
      const c = lines[i].indexOf(": ");
      if (c < 0) continue;
      const k = lines[i].slice(0, c);
      const v = lines[i].slice(c + 2);
      headers.set(k.toLowerCase(), v);
      const m = /^Argument(\d+)$/i.exec(k);
      if (m) args[+m[1]] = v;
    }
    for (let i = 0; i < args.length; i++) if (args[i] === void 0) args[i] = "";
    return { command, firstLine: lines[0] || "", headers, args };
  }
  function buildSaoriResponse(r) {
    if (!r || r.result === void 0 && !(r.values && r.values.length)) {
      return `SAORI/1.0 204 No Content${CRLF3}Charset: UTF-8${CRLF3}${CRLF3}`;
    }
    let s = `SAORI/1.0 ${r.status || "200 OK"}${CRLF3}Charset: UTF-8${CRLF3}`;
    if (r.result !== void 0) s += `Result: ${String(r.result).replace(/\r\n|\r|\n/g, " ")}${CRLF3}`;
    (r.values || []).forEach((v, i) => {
      s += `Value${i}: ${String(v).replace(/\r\n|\r|\n/g, " ")}${CRLF3}`;
    });
    return s + CRLF3;
  }
  function decodeRequest(bytes) {
    const text = utf8.decode(bytes);
    if (!text.includes("\uFFFD")) return text;
    try {
      sjis = sjis || new TextDecoder("shift_jis");
      return sjis.decode(bytes);
    } catch (e) {
      return text;
    }
  }
  function dllName(path) {
    return String(path).replace(/\\/g, "/").split("/").pop().toLowerCase();
  }
  var saoriBridge = {
    notifyPage: () => {
    },
    // set by worker.js: (name, cmd, args) -> main thread
    log: () => {
    },
    handles: /* @__PURE__ */ new Map(),
    // handle -> {name, path, inst}
    next: 1,
    warned: /* @__PURE__ */ new Set(),
    load(path, dir) {
      const name = dllName(path);
      const Impl = standIns[name];
      if (!Impl) {
        if (!this.warned.has(name)) this.log("warn", `SAORI ${name}: no browser stand-in; its calls return nothing`);
        this.warned.add(name);
        return 0;
      }
      const h = this.next++;
      const ctx = { name, path, dir, notifyPage: (cmd, args) => this.notifyPage(name, cmd, args), log: this.log };
      this.handles.set(h, { name, path, inst: new Impl(ctx) });
      return h;
    },
    request(handle, bytes) {
      const entry = this.handles.get(handle);
      const text = typeof bytes === "string" ? bytes : decodeRequest(bytes);
      const req = parseSaoriRequest(text);
      if (/^GET\s+Version\b/i.test(req.firstLine)) return `SAORI/1.0 200 OK${CRLF3}Charset: UTF-8${CRLF3}${CRLF3}`;
      if (!entry) return buildSaoriResponse(null);
      try {
        return buildSaoriResponse(entry.inst.execute(req.args, req.headers));
      } catch (e) {
        this.log("error", `SAORI ${entry.name}: ${e && e.stack ? e.stack : e}`);
        return `SAORI/1.0 500 Internal Server Error${CRLF3}Charset: UTF-8${CRLF3}${CRLF3}`;
      }
    },
    unload(handle) {
      const entry = this.handles.get(handle);
      if (entry && entry.inst.unload) {
        try {
          entry.inst.unload();
        } catch (e) {
          this.log("error", `SAORI ${entry.name} unload: ${e}`);
        }
      }
      this.handles.delete(handle);
    }
  };

  // src/core/hubproto.js
  var REASONS = Object.freeze(["origin", "allowlist", "version", "site", "storage", "busy"]);
  var RETIRED = "retired";

  // src/core/portstore.js
  var STORE_OP_MS = 15e3;
  var KINDS = /* @__PURE__ */ new Set(["indexeddb", "memory"]);
  var realClock = { setTimeout: (f, ms2) => setTimeout(f, ms2), clearTimeout: (h) => clearTimeout(h) };
  var PortStore = class _PortStore {
    /**
     * The store on `port` once the hub's first message {t:'store', kind} arrived. Kind 'memory' from the hub (no
     * IndexedDB there) is the hub document's memory, its ops answered as Store's memory kind answers them. With `local`
     * (a HubClient whose hub is not live: the message comes from the page itself), or no port, it is this page's memory
     * only, nothing sent. When nothing comes within timeoutMs the store is lost: kind 'memory', and every op answers as a
     * store that failed (read and keys reject: the worker then runs memory-only and writes nothing over the record the
     * hub may still hold).
     * @param {MessagePort|null} port  @param {{timeoutMs?: number, clock?: object}} [o]
     * @returns {Promise<PortStore>}
     */
    static open(port, { timeoutMs = STORE_OP_MS, clock: clock2 = realClock } = {}) {
      const s = new _PortStore(port, { timeoutMs, clock: clock2 });
      if (!port) return Promise.resolve(s);
      return new Promise((resolve) => {
        const t = clock2.setTimeout(() => {
          if (s._opened) return;
          s._opened = true;
          s.close();
          resolve(s);
        }, timeoutMs);
        s._onOpen = () => {
          clock2.clearTimeout(t);
          resolve(s);
        };
      });
    }
    constructor(port, { timeoutMs = STORE_OP_MS, clock: clock2 = realClock } = {}) {
      this.port = port || null;
      this.timeoutMs = timeoutMs;
      this.clock = clock2;
      this.mem = /* @__PURE__ */ new Map();
      this.closed = !port;
      this._local = !port;
      this._kind = "memory";
      this._opened = !port;
      this._onOpen = null;
      this._rid = 0;
      this._pending = /* @__PURE__ */ new Map();
      this.held = false;
      if (port) {
        port.onmessage = (ev) => this._onMessage(ev && ev.data);
        if (typeof port.start === "function") {
          try {
            port.start();
          } catch (e) {
          }
        }
      }
    }
    /** 'indexeddb' (the hub's), or 'memory' (the hub's memory, this page's, or lost) */
    get kind() {
      return this._kind;
    }
    _onMessage(m) {
      if (!m || typeof m !== "object") return;
      if (!this._opened) {
        if (m.t !== "store") return;
        this._opened = true;
        this._kind = KINDS.has(m.kind) ? m.kind : "memory";
        if (m.local === true) {
          this._kind = "memory";
          this._local = true;
          this.close();
        }
        if (this._onOpen) this._onOpen();
        return;
      }
      const p = typeof m.rid === "number" ? this._pending.get(m.rid) : null;
      if (!p) return;
      this._pending.delete(m.rid);
      this.clock.clearTimeout(p.timer);
      if (m.ok === true) {
        p.resolve(m.value);
        return;
      }
      if (m.error === RETIRED) {
        this._kind = "memory";
        this.close();
      }
      p.fail(String(m.error || "failed"));
    }
    /**
     * Writes held (HubClient, from a pagehide with persisted to its pageshow: nothing this page posts then may reach the
     * hub after Back): set and delete change the memory map only and answer false; reads still go.
     */
    hold(on) {
      this.held = !!on;
    }
    /** One op on the port; resolves with the reply's value; `fail(error)` decides a failure's answer (reject or a value). */
    _call(msg, fail) {
      return new Promise((resolve, reject) => {
        const answer = (why) => {
          try {
            resolve(fail(why));
          } catch (e) {
            reject(e);
          }
        };
        if (this.closed) {
          answer("store closed");
          return;
        }
        const rid = ++this._rid;
        const timer = this.clock.setTimeout(() => {
          if (!this._pending.delete(rid)) return;
          answer("the storage hub did not answer");
        }, this.timeoutMs);
        this._pending.set(rid, { resolve, reject, timer, fail: answer });
        try {
          this.port.postMessage({ ...msg, rid });
        } catch (e) {
          this._pending.delete(rid);
          this.clock.clearTimeout(timer);
          answer(e && e.message ? e.message : "not sent");
        }
      });
    }
    /** The stored value or undefined; rejects when it cannot be read (Store.read). */
    async read(key) {
      if (this._local) return this.mem.get(key);
      return this._call({ op: "read", key: String(key) }, (why) => {
        throw new Error(why);
      });
    }
    /** read(), or this page's memory when that fails (Store.get). */
    async get(key) {
      try {
        return await this.read(key);
      } catch (e) {
      }
      return this.mem.get(key);
    }
    /** @returns {Promise<boolean>} true when the value reached the hub's IndexedDB (not just memory) */
    async set(key, value) {
      this.mem.set(key, value);
      if (this._local || this.held) return false;
      return await this._call({ op: "set", key: String(key), value }, () => false) === true;
    }
    /** @returns {Promise<boolean>} false when the delete was refused (or held) */
    async delete(key) {
      this.mem.delete(key);
      if (this._local) return true;
      if (this.held) return false;
      return await this._call({ op: "delete", key: String(key) }, () => false) !== false;
    }
    /** String keys that start with prefix; rejects when the store cannot be listed (Store.keys). */
    async keys(prefix = "") {
      const p = String(prefix);
      if (this._local) return [...this.mem.keys()].filter((k) => typeof k === "string" && k.startsWith(p));
      const ks = await this._call({ op: "keys", prefix: p }, (why) => {
        throw new Error(why);
      });
      if (!Array.isArray(ks)) throw new Error("not a key list");
      return ks.filter((k) => typeof k === "string" && k.startsWith(p));
    }
    /**
     * Let the port go (HubClient when the hub went away; an open that timed out). The hub never closes a store port at
     * its pagehide (a cached hub keeps it for the restore; a hub that goes takes it along). Ops waiting answer as failed
     * at once, and every later op too; the memory map stays.
     */
    close() {
      this.closed = true;
      for (const [rid, p] of this._pending) {
        this.clock.clearTimeout(p.timer);
        p.fail("store closed");
        this._pending.delete(rid);
      }
      if (this.port) {
        try {
          this.port.onmessage = null;
          this.port.close();
        } catch (e) {
        }
        this.port = null;
      }
    }
  };

  // src/worker/worker.js
  var engine = null;
  var store = null;
  var storeKey = null;
  var persisted = {};
  var saveTimer = null;
  var lastSaveCost = 0;
  var lastSaveAt = 0;
  var IMPORTANT = /^On(ChoiceSelect|ChoiceSelectEx|AnchorSelect|AnchorSelectEx|UserInput|Communicate|Mouse(Down|Up|Click|DoubleClick|DragEnd)(Ex)?|KeyPress|FileDrop2|Close\w*)$/;
  var SAVE_DEBOUNCE_MS = 1e3;
  var SLOW_SAVE_MS = 50;
  var SLOW_SAVE_INTERVAL_MS = 3e4;
  function reply(msg, transfer) {
    self.postMessage(msg, transfer || []);
  }
  function log2(level2, text) {
    reply({ t: "log", level: level2, text: String(text) });
  }
  function errorText(e, stack = false) {
    if (e && stack && e.stack) return String(e.stack);
    if (e && e.message) return String(e.message);
    if (e && e.errno !== void 0) return `${e.name || "ErrnoError"} (errno ${e.errno})`;
    return String(e);
  }
  saoriBridge.notifyPage = (name, cmd, args) => reply({ t: "saori", name, cmd, args });
  saoriBridge.log = log2;
  async function writeSave(st, key, value, warn) {
    const ok = await st.set(key, value);
    if (!ok && st.kind !== "memory" && !writeSave.warned) {
      writeSave.warned = true;
      warn("the browser did not store the save data (storage full or blocked): it is kept until this page closes");
    }
    return ok;
  }
  writeSave.warned = false;
  function mergeFiles(prev, files) {
    const out = { ...prev };
    for (const [p, v] of Object.entries(files || {})) {
      if (v === false) delete out[p];
      else out[p] = v;
    }
    return out;
  }
  var hasSave = (files) => Object.values(files || {}).some((v) => v);
  async function readFiles(st, key) {
    let v;
    try {
      v = await st.read(key);
    } catch (e) {
      return { files: {}, ok: false };
    }
    if (v === void 0 || v === null) return { files: {}, ok: true };
    const map = !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
    if (!map || !Object.values(v).every((x) => x === null || x instanceof ArrayBuffer)) return { files: {}, ok: false };
    return { files: v, ok: true };
  }
  function keyPrefix(eng) {
    const root = eng && typeof eng.ghostRoot === "string" ? eng.ghostRoot : "";
    const dir = eng && typeof eng.ghostDir === "string" ? eng.ghostDir : "";
    return root && dir.startsWith(root) ? dir.slice(root.length) : "";
  }
  function readForUpload(eng, stored, rel) {
    if (!eng || typeof eng.readMasterFile !== "function") return null;
    if (personalFile(rel) || visitorFile(stored, rel, keyPrefix(eng))) return null;
    return eng.readMasterFile(rel);
  }
  async function storeChanged(files) {
    const names = Object.keys(files);
    if (!names.length) return names;
    persisted = mergeFiles(persisted, files);
    if (store) await writeSave(store, storeKey, persisted, (text) => log2("warn", text));
    reply({ t: "saved", files: names });
    return names;
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!engine) return Promise.resolve([]);
    const t0 = performance.now();
    engine.save();
    lastSaveCost = performance.now() - t0;
    lastSaveAt = Date.now();
    if (lastSaveCost > SLOW_SAVE_MS) log2("info", `save took ${lastSaveCost.toFixed(0)} ms; saving less often`);
    return storeChanged(engine.changedFiles());
  }
  function scheduleSave(urgent) {
    if (!engine) return;
    if (!urgent && saveTimer !== null) return;
    let delay = urgent ? 0 : SAVE_DEBOUNCE_MS;
    if (lastSaveCost > SLOW_SAVE_MS) delay = Math.max(delay, lastSaveAt + SLOW_SAVE_INTERVAL_MS - Date.now());
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveNow().catch((e) => log2("error", `save: ${errorText(e)}`));
    }, Math.max(0, delay));
  }
  function engineRequest(eng, m) {
    if (typeof m.fmo === "string" && typeof eng.setFmo === "function") eng.setFmo(m.fmo);
    return eng.request(m.text, { kind: m.kind || "", self: m.self || "" });
  }
  async function init(m) {
    const t0 = Date.now();
    if (m.storeNamespace && m.storeKey) {
      store = m.storePort ? await PortStore.open(m.storePort) : await Store.open(m.storeNamespace);
      storeKey = m.storeKey;
      const got = await readFiles(store, storeKey);
      persisted = got.files;
      if (!got.ok) {
        store = null;
        log2("warn", "the stored save data could not be read: the ghost starts without it, and this page stores none");
      }
    }
    const opts = m.engineOpts || null;
    engine = await createEngine(m.engine, { engineUrl: m.engineUrl, wasmUrl: m.wasmUrl || null, ghostDir: m.ghostDir, log: log2, saori: saoriBridge, opts });
    const hadSave = hasSave(persisted);
    const volatile = m.resume ? m.volatile || null : null;
    const ok = engine.init(m.files, persisted, {
      resume: !!m.resume && hadSave,
      bootEpochMs: m.bootEpochMs,
      volatile,
      sessionEndMs: m.sessionEndMs || 0
    });
    if (m.resume && m.volatile) engine.setVolatileState(m.volatile);
    await storeChanged(engine.changedFiles());
    return { ok, hadSave, ms: Date.now() - t0, ghostDir: engine.ghostDir || "" };
  }
  self.onmessage = async (ev) => {
    const m = ev.data || {};
    try {
      switch (m.t) {
        case "init": {
          const r = await init(m);
          reply({ t: "loaded", id: m.id, ...r });
          break;
        }
        case "req": {
          if (!engine) {
            reply({ t: "res", id: m.id, text: "" });
            break;
          }
          const t0 = performance.now();
          const text = engineRequest(engine, m);
          let files = {};
          let failed = null;
          try {
            files = engine.changedFiles();
          } catch (e) {
            failed = e;
          }
          const ms2 = performance.now() - t0;
          const idm = /\r\nID: ([^\r\n]*)/.exec(m.text);
          const eventId = idm ? idm[1] : "";
          reply({ t: "res", id: m.id, text, ms: ms2, vol: engine.getVolatileState() });
          if (failed) throw failed;
          await storeChanged(files);
          if (!/^NOTIFY/.test(m.text) || IMPORTANT.test(eventId)) {
            scheduleSave(IMPORTANT.test(eventId) || /\\q\[|\\__q\[/.test(text));
          }
          break;
        }
        case "persist": {
          const files = await saveNow();
          reply({ t: "persisted", id: m.id, files });
          break;
        }
        case "write": {
          if (!engine || typeof engine.writeMasterFile !== "function") throw new Error("no engine to take the file");
          const path = engine.writeMasterFile(m.path, m.data);
          reply({ t: "written", id: m.id, path });
          await storeChanged(engine.changedFiles());
          break;
        }
        case "read": {
          const data = readForUpload(engine, persisted, m.path);
          reply({ t: "read", id: m.id, data }, data ? [data] : []);
          break;
        }
        case "unload": {
          clearTimeout(saveTimer);
          const files = engine ? engine.unload() : {};
          await storeChanged(files);
          engine = null;
          reply({ t: "unloaded", id: m.id, files: Object.keys(files) });
          break;
        }
        case "forget": {
          persisted = {};
          if (store) await store.delete(storeKey);
          reply({ t: "forgotten", id: m.id });
          break;
        }
        default:
          reply({ t: "error", id: m.id, error: `unknown message ${m.t}` });
      }
    } catch (e) {
      log2("error", errorText(e, true));
      if (m.t === "init") reply({ t: "loaded", id: m.id, ok: false, error: errorText(e) });
      else reply({ t: "error", id: m.id, error: errorText(e) });
    }
  };
})();
//# sourceMappingURL=worker.cc490d1031.js.map

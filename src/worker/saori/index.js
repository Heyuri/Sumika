// SAORI bridge: the engine (WASM, patch P2) calls Module.saoriBridge instead of dlopen()ing a DLL.
//   load(path, dir) -> handle > 0, or 0 when there is no stand-in (Satori then expands the call to "")
//   request(handle, Uint8Array) -> string (raw SAORI/1.0 response)
//   unload(handle)
// path is the engine's full virtual path, e.g. "/ghost/master/saori/dsaudio.dll".
import { standIns } from './standins.js';

const CRLF = '\r\n';
const utf8 = new TextDecoder('utf-8');
let sjis = null;

/** Parse SAORI/1.0 request text -> {command, headers: Map(lower-case), args: string[]} */
export function parseSaoriRequest(text) {
  const lines = String(text).split(/\r\n|\n/);
  const command = (lines[0] || '').split(' ')[0];
  const headers = new Map();
  const args = [];
  for (let i = 1; i < lines.length && lines[i] !== ''; i++) {
    const c = lines[i].indexOf(': ');
    if (c < 0) continue;
    const k = lines[i].slice(0, c);
    const v = lines[i].slice(c + 2);
    headers.set(k.toLowerCase(), v);
    const m = /^Argument(\d+)$/i.exec(k);
    if (m) args[+m[1]] = v;
  }
  for (let i = 0; i < args.length; i++) if (args[i] === undefined) args[i] = '';
  return { command, firstLine: lines[0] || '', headers, args };
}

/** Build SAORI/1.0 response text from {result, values, status} (null -> 204) */
export function buildSaoriResponse(r) {
  if (!r || (r.result === undefined && !(r.values && r.values.length))) {
    return `SAORI/1.0 204 No Content${CRLF}Charset: UTF-8${CRLF}${CRLF}`;
  }
  let s = `SAORI/1.0 ${r.status || '200 OK'}${CRLF}Charset: UTF-8${CRLF}`;
  if (r.result !== undefined) s += `Result: ${String(r.result).replace(/\r\n|\r|\n/g, ' ')}${CRLF}`;
  (r.values || []).forEach((v, i) => { s += `Value${i}: ${String(v).replace(/\r\n|\r|\n/g, ' ')}${CRLF}`; });
  return s + CRLF;
}

/** Request bytes are UTF-8 once our Version reply announced it; fall back to Shift_JIS for anything else. */
function decodeRequest(bytes) {
  const text = utf8.decode(bytes);
  if (!text.includes('�')) return text;
  try {
    sjis = sjis || new TextDecoder('shift_jis');
    return sjis.decode(bytes);
  } catch (e) {
    return text;
  }
}

function dllName(path) {
  return String(path).replace(/\\/g, '/').split('/').pop().toLowerCase();
}

export const saoriBridge = {
  notifyPage: () => {}, // set by worker.js: (name, cmd, args) -> main thread
  log: () => {},
  handles: new Map(),   // handle -> {name, path, inst}
  next: 1,
  warned: new Set(),

  load(path, dir) {
    const name = dllName(path);
    const Impl = standIns[name];
    if (!Impl) {
      if (!this.warned.has(name)) this.log('warn', `SAORI ${name}: no browser stand-in; its calls return nothing`);
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
    const text = typeof bytes === 'string' ? bytes : decodeRequest(bytes);
    const req = parseSaoriRequest(text);
    if (/^GET\s+Version\b/i.test(req.firstLine)) return `SAORI/1.0 200 OK${CRLF}Charset: UTF-8${CRLF}${CRLF}`;
    if (!entry) return buildSaoriResponse(null);
    try {
      return buildSaoriResponse(entry.inst.execute(req.args, req.headers));
    } catch (e) {
      this.log('error', `SAORI ${entry.name}: ${e && e.stack ? e.stack : e}`);
      return `SAORI/1.0 500 Internal Server Error${CRLF}Charset: UTF-8${CRLF}${CRLF}`;
    }
  },

  unload(handle) {
    const entry = this.handles.get(handle);
    if (entry && entry.inst.unload) {
      try { entry.inst.unload(); } catch (e) { this.log('error', `SAORI ${entry.name} unload: ${e}`); }
    }
    this.handles.delete(handle);
  },
};

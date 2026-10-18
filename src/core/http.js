// \![execute,http-*] and \![cancel,http,…] over fetch() (shiori-events.md §4.15, sakurascript.md §5.11): ssp.exe
// 2.9.08f's SPHttpRequest / SPHttp [disasm], as far as a browser allows. The pure helpers parse the options, build the
// request (parameters, charsets, headers), name the saved file, judge the status, name the events; HttpRequests runs
// one ghost's requests for its EventLoop. What a browser cannot do is a failure the ghost hears about as SSP reports a
// network error.
import { log } from './log.js';
import { masterRel, personalFile } from './engine-files.js';

export const DEFAULT_TIMEOUT_S = 10;          // per wait for data, not for the download [disasm JSocket]
export const MAX_TIMEOUT_S = 300;
export const NOFILE_MAX = 0x20000;            // --nofile keeps at most 128 KB of the body [disasm]
const FORM_CT = 'application/x-www-form-urlencoded';
const MULTIPART_CT = 'multipart/form-data';
const METHODS = ['post', 'get', 'head', 'put', 'delete', 'patch', 'options'];     // TextToMethod's order [disasm]
const PREFIXES = new Set(['htt', 'rss', 'ica', 'web']);                          // the \![execute|cancel,…] table
const BODY_METHODS = new Set(['post', 'put', 'patch']);                         // SPHttp_IsRequestBodyExist
// SPHttpKeyValuePair::SetArray never replaces these [disasm]; the browser's forbidden request headers it drops anyway
const LOCKED = new Set(['host', 'accept-encoding', 'te', 'connection', 'proxy-connection']);
const FORBIDDEN = new Set(['accept-charset', 'access-control-request-headers', 'access-control-request-method',
  'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'keep-alive', 'origin', 'referer', 'set-cookie',
  'trailer', 'transfer-encoding', 'upgrade', 'via']);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const KEEPALIVE_BODY = 8192;                  // keepalive only for small bodies, and at most this much in flight
const KEEPALIVE_BUDGET = 32768;               // (the browser allows 64 KiB per page, beacons included) [decision]
const DOS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// SPUtils::CleanupFilenameW's list (0xbdc448) [disasm]: \ ₩ ･ / U+200B U+202A U+202E U+FEFF ｦ : , ; * ? " < > |
const UNSAFE_NAME = /[\\\u20a9\uff65/\u200b\u202a\u202e\ufeff\uff66:,;*?"<>|]/g;

const enc = new TextEncoder();
const lc = s => String(s ?? '').trim().toLowerCase();

// ---------------------------------------------------------------- the tag

/**
 * The HTTP family of `\![execute,X,…]` / `\![cancel,X,…]` (EV §4.15) [disasm]: X matches by its first 3 letters (htt,
 * rss, ica, web); the kind is a substring test (rss, websock, ical, else http), the method the first of post, get,
 * head, put, delete, patch, options found anywhere in X (none: get).
 * @returns {{kind: 'http'|'rss'|'websocket'|'ical', method: string}|null} null: not this family
 */
export function httpCommand(sub) {
  const s = lc(sub);
  if (!PREFIXES.has(s.slice(0, 3))) return null;
  const kind = s.includes('rss') ? 'rss' : s.includes('websock') ? 'websocket' : s.includes('ical') ? 'ical' : 'http';
  return { kind, method: METHODS.find(m => s.includes(m)) || 'get' };
}

/** wtoul: the leading decimal digits (0 when none) [guess for signs and blanks]. */
const wtoul = v => { const m = /^\s*\+?(\d+)/.exec(String(v)); return m ? Number(m[1]) : 0; };

/**
 * SPHttpRequest::ParseOptions (EV §4.15) [disasm]. `rest`: the tag's arguments after X. The first one is the URL unless
 * it starts with `--` (then only --url= gives one). Each other token is matched case-insensitively by prefix in SSP's
 * order, the first match wins; an option with an empty value is ignored, except --nofile=, --streaming= and --expand=,
 * which switch their mode on first (0x664ef8, 0x6651ff, 0x664e1b); a repeat overrides, except --param= and --header=,
 * which add up; any other token (a bare `--async` too) is one more parameter, the whole token. The list is
 * ParseParameters' NUL-separated multi-string, which ends at its first empty string: an empty last argument. An
 * empty argument before others is the placeholder " " there (SS §3.4), so it is one more token: a parameter " "
 * [disasm 0x6242e2, 0x66526c].
 */
export function parseHttpOptions(rest = []) {
  const o = {
    url: '', file: '', id: '', async: false, timeoutS: 0, nofile: null, paramCharset: 'UTF-8', contentType: FORM_CT,
    params: [], paramInputFile: '', cookie: '', authorization: '', headers: [], log: '', accept: '', acceptLanguage: '',
    nodescript: false, progress: false, insecure: false, noCache: false, streaming: null,
  };
  const list = (rest || []).map((x, k, all) => (x == null || x === '' ? (k < all.length - 1 ? ' ' : '') : String(x)));
  let i = 0;
  if (list.length && !/^--/.test(list[0])) { o.url = list[0]; i = 1; }
  const val = (t, p) => t.slice(p.length);
  for (; i < list.length; i++) {
    const t = list[i];
    if (t === '') break;
    const l = t.toLowerCase();
    const opt = OPTIONS.find(([p]) => l.startsWith(p));
    if (!opt) { o.params.push(t); continue; }
    const [p, apply, always] = opt;
    const v = val(t, p);
    if (!p.endsWith('=') || v !== '' || always) apply(o, v);
  }
  if (!(o.timeoutS > 0)) o.timeoutS = DEFAULT_TIMEOUT_S;
  o.timeoutS = Math.min(MAX_TIMEOUT_S, o.timeoutS);
  return o;
}

// [prefix, apply(o, the rest of the token), applied even when an `=` option's value is empty]
// --nofile[=CS]: the mode on, the charset only when given (default UTF-8; a bare --nofile's rest is one too) [disasm]
const setNofile = (o, v) => { o.nofile = v || (o.nofile ?? 'UTF-8'); };
const OPTIONS = [
  ['--url=', (o, v) => { o.url = v; }],
  ['--file=', (o, v) => { o.file = v; }],
  ['--event=', (o, v) => { o.id = v; o.async = true; }],       // an undocumented alias of --async= [disasm]
  ['--async=', (o, v) => { o.id = v; o.async = true; }],
  ['--sync=', (o, v) => { o.id = v; o.async = false; }],
  ['--from=', () => {}], ['--to=', () => {}], ['--expand=', () => {}, true], ['--expand', () => {}],
  ['--limit=', () => {}],
  ['--timeout=', (o, v) => { o.timeoutS = wtoul(v); }],
  ['--nofile=', setNofile, true],
  ['--nofile', setNofile],
  ['--param-charset=', (o, v) => { o.paramCharset = v; }],
  ['--content-type=', (o, v) => { o.contentType = v; }],
  ['--param=', (o, v) => { o.params.push(v); }],
  ['--param-input-file=', (o, v) => { o.paramInputFile = v; }],
  ['--cookie=', (o, v) => { o.cookie = v; }],
  ['--authorization=', (o, v) => { o.authorization = v; }],
  ['--header=', (o, v) => { o.headers.push(v); }],
  ['--log=', (o, v) => { o.log = v; }],
  ['--accept=', (o, v) => { o.accept = v; }],
  ['--accept-language=', (o, v) => { o.acceptLanguage = v; }],
  ['--websocket-protocol=', () => {}],
  ['--nodescript', o => { o.nodescript = true; }],
  ['--progress-notify', o => { o.progress = true; }],
  ['--insecure', o => { o.insecure = true; }],
  ['--no-cache', o => { o.noCache = true; }],                  // what every request does here (cache 'no-store')
  ['--streaming=', (o, v) => { o.streaming = v || (o.streaming ?? ''); }, true],   // the decoder name only when given
  ['--streaming', o => { o.streaming = o.streaming ?? ''; }],
];

/** HTTP's URL: `wss://` / `ws://` become `https://` / `http://` (that string is R2) [disasm]. */
export function httpUrl(url) {
  const s = String(url ?? '');
  if (/^wss:\/\//i.test(s)) return 'https://' + s.slice(6);
  if (/^ws:\/\//i.test(s)) return 'http://' + s.slice(5);
  return s;
}

/** The URL as fetch() may take it: absolute http(s), data or file; anything else (relative, other schemes) is null. */
export function parseHttpUrl(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch (e) { return null; }
  return /^(https?|data|file):$/.test(u.protocol) ? u : null;
}

/** SPUtils::CleanupFilenameW [disasm]: path and reserved characters become `_`; a DOS device stem gets `_` first. */
export function cleanupFilename(name) {
  let s = String(name ?? '').replace(UNSAFE_NAME, '_');
  const dot = s.lastIndexOf('.');
  if (DOS_NAMES.test(dot >= 0 ? s.slice(0, dot) : s)) s = '_' + s.slice(1);
  return s;
}

/**
 * The file a request without --file saves to (EV §4.15) [disasm]: the URL cut at its first `?` or `#`, what follows
 * the last `/`; `index.html` when that is empty and for a data: URL. Not percent-decoded [infer].
 */
export function urlFileName(url) {
  const s = String(url ?? '');
  if (/^\s*data:/i.test(s)) return 'index.html';
  let cut = s.length;
  for (const c of '?#') { const i = s.indexOf(c); if (i >= 0 && i < cut) cut = i; }
  const head = s.slice(0, cut);
  return cleanupFilename(head.slice(head.lastIndexOf('/') + 1) || 'index.html');
}

/** Event names (EV §4.15) [disasm]: an ID starting with `On` (case-sensitive) is the event itself. */
export function httpEventNames(id) {
  const s = String(id ?? '');
  if (s.startsWith('On')) return { complete: s, failure: s + 'Failure', progress: s + 'Progress' };
  return { complete: 'OnExecuteHTTPComplete', failure: 'OnExecuteHTTPFailure', progress: 'OnExecuteHTTPProgress' };
}

// ---------------------------------------------------------------- charsets

const SJIS_NAMES = new Set(['shift_jis', 'shift-jis', 'sjis', 'x-sjis', 'cp932', 'ms932', 'windows-31j', 'ms_kanji',
  'csshiftjis', 'shiftjis']);
const EUC_NAMES = new Set(['euc-jp', 'eucjp', 'x-euc-jp', 'cseucpkdfmtjapanese']);

/** JWString::GetCodePage's names we know: 'utf-8' | 'shift_jis' (CP932) | 'euc-jp'; any other name UTF-8 [guess]. */
export function paramCharset(name) {
  const n = lc(name);
  if (SJIS_NAMES.has(n)) return 'shift_jis';
  if (EUC_NAMES.has(n)) return 'euc-jp';
  return 'utf-8';
}

// WideCharToMultiByte(932, 0)'s best-fit additions (engines/common/gen_cp932.py BEST_FIT, measured on Windows)
const CP932_BEST_FIT = [
  [0xA1, 0x21], [0xA5, 0x5C], [0xA6, 0x7C], [0xA9, 0x63], [0xAA, 0x61], [0xAB, 0x81E1], [0xAD, 0x2D], [0xAE, 0x52],
  [0xAF, 0x8150], [0xB2, 0x32], [0xB3, 0x33], [0xB5, 0x83CA], [0xB7, 0x8145], [0xB8, 0x8143], [0xB9, 0x31], [0xBA, 0x6F],
  [0xBB, 0x81E2], [0xC0, 0x41], [0xC1, 0x41], [0xC2, 0x41], [0xC3, 0x41], [0xC4, 0x41], [0xC5, 0x41], [0xC6, 0x41],
  [0xC7, 0x43], [0xC8, 0x45], [0xC9, 0x45], [0xCA, 0x45], [0xCB, 0x45], [0xCC, 0x49], [0xCD, 0x49], [0xCE, 0x49],
  [0xCF, 0x49], [0xD0, 0x44], [0xD1, 0x4E], [0xD2, 0x4F], [0xD3, 0x4F], [0xD4, 0x4F], [0xD5, 0x4F], [0xD6, 0x4F],
  [0xD8, 0x4F], [0xD9, 0x55], [0xDA, 0x55], [0xDB, 0x55], [0xDC, 0x55], [0xDD, 0x59], [0xDE, 0x54], [0xDF, 0x73],
  [0xE0, 0x61], [0xE1, 0x61], [0xE2, 0x61], [0xE3, 0x61], [0xE4, 0x61], [0xE5, 0x61], [0xE6, 0x61], [0xE7, 0x63],
  [0xE8, 0x65], [0xE9, 0x65], [0xEA, 0x65], [0xEB, 0x65], [0xEC, 0x69], [0xED, 0x69], [0xEE, 0x69], [0xEF, 0x69],
  [0xF0, 0x64], [0xF1, 0x6E], [0xF2, 0x6F], [0xF3, 0x6F], [0xF4, 0x6F], [0xF5, 0x6F], [0xF6, 0x6F], [0xF8, 0x6F],
  [0xF9, 0x75], [0xFA, 0x75], [0xFB, 0x75], [0xFC, 0x75], [0xFD, 0x79], [0xFE, 0x74], [0xFF, 0x79],
  [0x3094, 0x8394], [0x3099, 0x814A], [0x309A, 0x814B], [0xA2, 0x8191], [0xA3, 0x8192], [0xAC, 0x81CA],
];
const tables = new Map();

/**
 * code point -> bytes (as one number) for Shift_JIS (CP932) or EUC-JP, built once from the browser's decoder: a code
 * point with several sequences takes JIS X 0208 / NEC row 13 first, then the IBM extension (0xFA–0xFC), then the
 * NEC-selected copy (0xED/0xEE), as Windows does (gen_cp932.py `rank`); CP932 adds Windows' best fit [infer: SSP's
 * JString::ToMbs is WideCharToMultiByte with flags 0].
 */
function encodeTable(cs) {
  if (tables.has(cs)) return tables.get(cs);
  const dec = new TextDecoder(cs);
  const best = new Map();
  const put = (u, mb, rank) => {
    const e = best.get(u);
    if (!e || rank < e.rank || (rank === e.rank && mb < e.mb)) best.set(u, { mb, rank });
  };
  const pair = (a, b) => dec.decode(new Uint8Array([a, b]));
  if (cs === 'shift_jis') {
    for (let b = 0xa1; b <= 0xdf; b++) put(0xff61 + b - 0xa1, b, 0);
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead >= 0xa0 && lead <= 0xdf) continue;
      const rank = lead === 0xed || lead === 0xee ? 3 : lead >= 0xfa ? 2 : 1;
      for (let t = 0x40; t <= 0xfc; t++) {
        if (t === 0x7f) continue;
        const s = pair(lead, t);
        if (s.length === 1 && s !== '\ufffd') put(s.charCodeAt(0), lead << 8 | t, rank);
      }
    }
  } else {
    for (let b = 0xa1; b <= 0xdf; b++) put(0xff61 + b - 0xa1, 0x8e00 | b, 1);
    for (let lead = 0xa1; lead <= 0xfe; lead++) {
      for (let t = 0xa1; t <= 0xfe; t++) {
        const s = pair(lead, t);
        if (s.length === 1 && s !== '\ufffd') put(s.charCodeAt(0), lead << 8 | t, 1);
      }
    }
  }
  const table = new Map([...best].map(([u, e]) => [u, e.mb]));
  if (cs === 'shift_jis') for (const [u, mb] of CP932_BEST_FIT) if (!table.has(u)) table.set(u, mb);
  tables.set(cs, table);
  return table;
}

/**
 * Text in the --param-charset's bytes (EV §4.15): UTF-8, or CP932 / EUC-JP per UTF-16 unit (ASCII as is, else the
 * table, else `?`; a surrogate pair is `??`, as Windows writes it).
 * @returns {Uint8Array}
 */
export function encodeText(text, charset = 'UTF-8') {
  const s = String(text ?? '');
  const cs = paramCharset(charset);
  if (cs === 'utf-8') return enc.encode(s);
  const table = encodeTable(cs);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    const mb = u < 0x80 ? u : table.get(u) ?? 0x3f;
    if (mb > 0xff) out.push(mb >> 8, mb & 0xff); else out.push(mb);
  }
  return Uint8Array.from(out);
}

/** Bytes 0x09–0x7E only (JString::ToMbs with code 0xfffe: --cookie, --authorization, --accept, …) [disasm]. */
const asciiOnly = s => String(s ?? '').replace(/[^\x09\x20-\x7e]/g, '');
const latin1 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };

// ---------------------------------------------------------------- parameters (SPHttp_MakeParam)

// SPUtils_IsPercentEncodeCharsForm / ...URL [disasm]: true = the byte must be encoded
const needsForm = b => !((b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a) || (b >= 0x30 && b <= 0x39) ||
  b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f);
const needsUrl = b => b <= 0x1f || b >= 0x7e || b === 0x20 || b === 0x22 || b === 0x23 || b === 0x3c || b === 0x3e ||
  b === 0x60 || b === 0x7b || b === 0x7d || b === 0x3f;

/**
 * SPUtils::EncodePercent [disasm]: form mode (a body) keeps A–Z a–z 0–9 * - . _ and sends a space as `+`; URL mode (a
 * query) escapes control bytes, bytes ≥ 0x7E, space (`%20`), `" # < > ` { } ?`. `keep` bytes stay as they are; other
 * bytes become `%XX` (upper case). A NUL byte ends the string.
 */
export function percentEncode(bytes, { form = true, keep = '' } = {}) {
  let out = '';
  for (const b of bytes) {
    if (b === 0) break;
    const c = String.fromCharCode(b);
    if (!(form ? needsForm(b) : needsUrl(b))) out += c;
    else if (b === 0x20) out += form ? '+' : '%20';
    else if (keep && keep.includes(c)) out += c;
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** SPUtils::IsPercentEncoded [disasm]: every byte needs no encoding, or is `%`, `;`, `+` (form) or one of `allowed`. */
export function isPercentEncoded(bytes, allowed = '', form = true) {
  for (const b of bytes) {
    if (b === 0) break;
    if (b === 0x25 || b === 0x3b || (b === 0x2b && form)) continue;
    if (!(form ? needsForm(b) : needsUrl(b))) continue;
    if (allowed && allowed.includes(String.fromCharCode(b))) continue;
    return false;
  }
  return true;
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const ascii = s => enc.encode(s);
const CRLF = ascii('\r\n');

function split(bytes, sep) {
  const out = [];
  let from = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === sep) { out.push(bytes.subarray(from, i)); from = i + 1; }
  }
  return out;
}

/**
 * SPHttp_MakeParam (EV §4.15) [disasm 0x661330]: `items` are the stored parameters split at byte 1. When the `=` count
 * equals the item count, each is `name=value`: multipart parts (values raw, `"` in a name as `\"`), or `name=value`
 * joined by `&`, each part percent-encoded unless it already looks encoded. Otherwise the items are joined by CRLF and
 * the whole is encoded keeping `& / =` (multipart: nothing).
 * @param {Uint8Array[]} items
 * @returns {Uint8Array}
 */
export function makeParam(items, { form = true, multipart = false, boundary = '' } = {}) {
  let eq = 0;
  for (const it of items) for (const b of it) if (b === 0x3d) eq++;
  const parts = [];
  if (eq === items.length) {
    for (const it of items) {
      const k = it.indexOf(0x3d);
      const name = k < 0 ? it : it.subarray(0, k);
      const value = k < 0 ? new Uint8Array(0) : it.subarray(k + 1);
      if (multipart) {
        parts.push(ascii(`--${boundary}\r\nContent-Disposition: form-data; name="`),
          ascii(latin1(name).replace(/"/g, '\\"')), ascii('"\r\n\r\n'), value, CRLF);
      } else {
        parts.push(ascii(isPercentEncoded(name, '&/+', form) ? latin1(name) : percentEncode(name, { form })), ascii('='),
          ascii(isPercentEncoded(value, '&/=+', form) ? latin1(value) : percentEncode(value, { form })), ascii('&'));
      }
    }
    if (multipart) parts.push(ascii(`--${boundary}--\r\n`));
    else if (parts.length) parts.pop();             // the last '&'
    return concat(parts);
  }
  if (multipart) return new Uint8Array(0);
  const joined = [];
  for (const it of items) joined.push(it, CRLF);
  let whole = concat(joined);
  if (whole.length > 2) whole = whole.subarray(0, whole.length - 2);
  return ascii(isPercentEncoded(whole, '&/=+', form) ? latin1(whole) : percentEncode(whole, { form, keep: '&/=' }));
}

const BOUNDARY_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** `Accept-Language` from --accept-language=L: `L, <L before '-'>;q=0.9, en;q=0.2, *;q=0.1` [disasm]. */
const acceptLanguage = l => `${l}, ${l.split('-')[0]};q=0.9, en;q=0.2, *;q=0.1`;

/**
 * The request SSP would send, as fetch() can send it (EV §4.15): the method in upper case; for GET, HEAD, DELETE and
 * OPTIONS the parameters as a query (`?` appended even after an existing query [disasm]); for POST, PUT and PATCH a
 * body by --content-type (`application/x-www-form-urlencoded` by default and for any type containing
 * `form-urlencoded`, exactly `multipart/form-data` with `----SSPFormBoundary` + 16 random characters, any other type
 * the parameters as stored: CRLF-joined for text/*, byte 1 between them otherwise), or --param-input-file's bytes.
 * Headers: Accept-Language (`*` or --accept-language), --accept, --authorization (ASCII only), Content-Type, then
 * --header lines in the --param-charset, replacing a name already there, never Host, Accept-Encoding, TE, Connection
 * or Proxy-Connection; the browser's forbidden names and invalid ones are left out [decision]. --cookie is never sent
 * (a browser forbids it).
 * @param {object} o parseHttpOptions()
 * @param {string} method lower case
 * @param {{random?: () => number, inputFile?: Uint8Array|null}} [x]
 * @returns {{method: string, url: string, headers: [string, string][], body: Uint8Array|null, simple: boolean}}
 *   simple: a request the browser sends without a CORS preflight (method and every header CORS-safelisted)
 */
export function buildHttpRequest(o, method, { random = Math.random, inputFile = null } = {}) {
  const cs = o.paramCharset;
  const ct = String(o.contentType || FORM_CT);
  const textCT = /^text\//i.test(ct.trim());
  const values = o.params.map(v => encodeText(textCT ? v : String(v).replace(/\x01/g, ' '), cs));
  const sep = textCT ? CRLF : Uint8Array.of(1);
  const stored = values.length ? concat(values.flatMap((v, i) => (i ? [sep, v] : [v]))) : null;
  const items = stored ? split(stored, 1) : [];
  let url = httpUrl(o.url).trim();
  let body = null;
  let contentType = null;
  const multipart = /^multipart\/form-data$/i.test(ct.trim());
  if (!BODY_METHODS.has(method)) {
    if (items.length) url += '?' + latin1(makeParam(items, { form: false }));
  } else if (inputFile) {
    body = inputFile;
    if (multipart) {
      const nl = body.indexOf(0x0a);
      const first = latin1(nl < 0 ? body : body.subarray(0, nl)).replace(/\r$/, '').replace(/^--/, '');
      contentType = `${MULTIPART_CT}; boundary=${first}`;           // [guess] the first line, without its `--`
    } else contentType = /form-urlencoded/i.test(ct) ? FORM_CT : ct;
  } else if (items.length) {
    if (/form-urlencoded/i.test(ct)) {
      body = makeParam(items, { form: true });
      contentType = FORM_CT;
    } else if (multipart) {
      let b = '----SSPFormBoundary';
      const n = BOUNDARY_CHARS.length;
      for (let i = 0; i < 16; i++) b += BOUNDARY_CHARS[Math.floor(random() * n) % n];
      body = makeParam(items, { multipart: true, boundary: b });
      contentType = `${MULTIPART_CT}; boundary=${b}`;
    } else {
      body = stored;
      contentType = ct;
    }
  } else body = new Uint8Array(0);                                    // Content-Length: 0, no Content-Type
  const headers = [];
  const set = (name, value) => {
    const i = headers.findIndex(([n]) => n.toLowerCase() === name.toLowerCase());
    if (i >= 0) headers[i] = [headers[i][0], value]; else headers.push([name, value]);
  };
  set('Accept-Language', o.acceptLanguage ? acceptLanguage(asciiOnly(o.acceptLanguage)) : '*');
  if (o.accept) set('Accept', asciiOnly(o.accept));
  if (o.authorization) set('Authorization', asciiOnly(o.authorization));
  if (contentType) set('Content-Type', asciiOnly(contentType));
  let last = null;
  for (const raw of o.headers) {
    const line = latin1(encodeText(String(raw).replace(/[\r\n\x01]/g, ' '), cs));
    const c = line.indexOf(':');
    if (c < 0) {
      // a line that starts with a blank continues the previous one; any other line without `:` is left out
      if (last && /^[ \t]/.test(line)) { last[1] = `${last[1]} ${line.trim()}`; set(last[0], last[1]); }
      continue;
    }
    const name = line.slice(0, c).trim();
    const value = line.slice(c + 1).trim();
    const n = name.toLowerCase();
    last = null;
    if (!TOKEN.test(name) || LOCKED.has(n) || FORBIDDEN.has(n) || /^(proxy|sec)-/.test(n)) continue;
    last = [name, value];
    set(name, value);
  }
  const M = method.toUpperCase();
  const simple = (M === 'GET' || M === 'HEAD' || M === 'POST') && headers.every(([n, v]) => safelisted(n, v));
  return { method: M, url, headers, body: BODY_METHODS.has(method) ? body : null, simple };
}

/** Fetch's CORS-safelisted request headers (no preflight, allowed in no-cors mode). */
export function safelisted(name, value) {
  const n = String(name).toLowerCase();
  const v = String(value);
  if (v.length > 128) return false;
  if (n === 'accept') return !/[\x00-\x08\x0a-\x1f"():<>?@[\\\]{}\x7f]/.test(v);
  if (n === 'accept-language' || n === 'content-language') return /^[0-9A-Za-z *,\-.;=]*$/.test(v);
  if (n === 'content-type') {
    if (/[\x00-\x08\x0a-\x1f"():<>?@[\\\]{}\x7f]/.test(v)) return false;
    const essence = v.split(';')[0].trim().toLowerCase();
    return essence === FORM_CT || essence === MULTIPART_CT || essence === 'text/plain';
  }
  return false;
}

/** --nofile's R3 (EV §4.15) [disasm]: the body decoded in its charset, every CRLF, CR and LF as byte 1. */
export function nofileText(bytes, charset = 'UTF-8') {
  if (!bytes || !bytes.length) return '';
  let text;
  try { text = new TextDecoder(String(charset || 'UTF-8').trim() || 'utf-8').decode(bytes); }
  catch (e) { text = new TextDecoder('utf-8').decode(bytes); }
  return text.replace(/\r\n|\r|\n/g, '\x01');
}

/** R6 [disasm SPKV_DumpB1]: every response header `Name: value` followed by byte 1 (what the browser lets us see). */
export function headerText(headers) {
  let s = '';
  try {
    for (const [k, v] of headers) s += `${k}: ${String(v).replace(/[\r\n]/g, ' ')}\x01`;
  } catch (e) { /* no headers */ }
  return s;
}

const REDIRECTS = new Set([300, 301, 302, 303, 307, 308]);

/**
 * What SPHttp::RealRead makes of a final status (EV §4.15) [disasm 0x65f259–0x65f8d2]: 200, 202 and 203 read the body
 * and succeed (0x65f3d6); 204 to HEAD or OPTIONS (0x65f781), 201 to PUT (0x65fa69) and 304 with a target file
 * (0x65f666) succeed before any body is read. 201 to other methods and 300–303, 307, 308 go to SPHttp::Redirect,
 * which fails as `404` without a Location (0x6626ff) and follows one; the browser has already followed 301–308 that
 * have one, but follows neither a 201's nor a 300's: R4 the status [guess]. Any other status is the failure it
 * reports (0x65fa54); only a threaded request reads its page, when the Content-Length is above 0 (0x65f8ab); a 401
 * first goes through SPHttp::ExecAuth [unread] (the same rule here [guess]).
 * @param {number} status
 * @param {string} method lower case
 * @param {{file?: boolean, location?: string|null}} [x] file: a target file (no --nofile); location: the answer's
 * @returns {{ok: boolean, read: boolean, reason: string}} read: the body is read (into the file or --nofile's R3);
 *   for a failure, when a threaded request would read it
 */
export function httpStatus(status, method, { file = true, location = null } = {}) {
  const done = { ok: true, read: false, reason: '200' };
  if (status === 200 || status === 202 || status === 203) return { ok: true, read: true, reason: '200' };
  if (status === 204 && (method === 'head' || method === 'options')) return done;
  if (status === 304 && file) return done;
  if (status === 201 && method === 'put') return done;
  if (status === 201 || REDIRECTS.has(status)) {
    return { ok: false, read: false, reason: location ? String(status) : '404' };
  }
  return { ok: false, read: true, reason: String(status) };
}

// ---------------------------------------------------------------- one ghost's requests

/** The page's threaded requests in flight (one SPHttpManager per process [disasm]): the duplicate check, cancel. */
const PAGE_REQUESTS = new Set();
let keepaliveBytes = 0;

/**
 * One ghost's `\![execute,http-*]` (EV §4.15). The host is its EventLoop:
 *   canSend() booted and not closed or frozen; live() the engine can still take a file and an event;
 *   locked() events are dropped (SPGhost::OnNotifyEvent's IsLocked test [disasm]; minimized, passive, induction, \t);
 *   ghostDir() the engine's ghost/master folder ('/'-ended); writeFile(rel, bytes) -> Promise<full path>;
 *   readFile(rel) -> Promise<Uint8Array|null>; event(id, refs) -> Promise (GET, the reply plays like any event's).
 * Requests run on the page with fetch(): credentials 'omit', referrerPolicy 'no-referrer' (the visitor's page URL
 * never reaches a ghost author's site) [decision]; no cookies; cache 'no-store' (always asked again, as SSP, and
 * nothing kept: no ETag or Last-Modified goes back to recognise a visitor) [decision], so the browser sends
 * --no-cache's two headers every time. A simple POST that saves nothing (no --file, no --nofile, no --progress-notify)
 * goes in 'no-cors' mode: the server gets it as SSP sends it, the answer is opaque and counts as SSP's success (R4
 * `200`) [decision]. A simple request with a small body is `keepalive`: a page left meanwhile still delivers it (its
 * event and file are dropped, as SSP drops them for a ghost that went) [decision]. No cap on requests at once (SSP has
 * none).
 */
export class HttpRequests {
  /**
   * @param {{host: object, fetch?: Function|null, clock: {now: Function, setTimeout: Function, clearTimeout: Function},
   *   requests?: Set<object>, random?: () => number, pageProtocol?: string}} o requests: the page's in-flight set
   *   (tests give their own); pageProtocol: the page's (`https:` blocks http:// URLs: a note in the debug log)
   */
  constructor({ host, fetch = null, clock, requests = PAGE_REQUESTS, random = Math.random, pageProtocol = '' }) {
    this.host = host;
    this.fetch = typeof fetch === 'function' ? fetch : null;
    this.clock = clock;
    this.requests = requests;
    this.random = random;
    this.pageProtocol = pageProtocol;
    this.epoch = 0;                 // +1 when the ghost goes: what was sent before is no longer heard
  }

  /** The ghost went (closed, left, taken over, torn down): the requests still running deliver no file and no event. */
  invalidate() { this.epoch++; }

  /**
   * \![execute,X,…] (EV §4.15). Returns false for a tag that is not HTTP (rss, ical, websocket: the player reports
   * it), undefined when nothing waits (fewer than 3 arguments, frozen or closed, an URL that does not parse without
   * --file: dropped silently [disasm], or --async), else a promise: the script waits at the tag until the request is
   * over and its event's reply has started (or the event was dropped).
   */
  execute(sub, args = []) {
    const cmd = httpCommand(sub);
    if (!cmd || cmd.kind !== 'http') return false;
    if (!args || !args.length) return undefined;
    if (!this.host.canSend()) return undefined;
    const o = parseHttpOptions(args);
    const url = httpUrl(o.url);
    let name = null;
    if (o.nofile == null && o.streaming == null) {
      if (o.file) name = cleanupFilename(o.file);
      else if (parseHttpUrl(url)) name = urlFileName(url);
      else { log.debug(`http: ${url || '(no URL)'}: not a URL, nothing sent`); return undefined; }
    }
    const req = {
      method: cmd.method, id: o.id, url, o, name, path: name == null ? '' : `${this._ghostDir()}var/${name}`,
      epoch: this.epoch, reason: null, abort: null,
    };
    // --streaming has events of its own (not traced): without --async SSP fails it, here always [decision]
    if (o.streaming != null) return this._finish(req, { ok: false, reason: 'paramerror' });
    // the same URL in flight (threaded requests, any ghost of the page): this one fails at once [disasm]
    const key = url.toLowerCase();
    for (const r of this.requests) {
      if (r.key === key) return this._finish(req, { ok: false, reason: 'downloading' });
    }
    if (!o.async) return this._run(req);
    req.key = key;
    this.requests.add(req);
    this._run(req).catch(e => log.debug('http: request failed', e)).finally(() => this.requests.delete(req));
    return undefined;
  }

  /**
   * \![cancel,X,URL] (EV §4.15) [disasm]: the first threaded request in flight with that URL (any case, any ghost of
   * the page, any of the four kinds) is aborted: its Failure says `artificial`. A synchronous one cannot be reached.
   */
  cancel(sub, args = []) {
    if (!httpCommand(sub)) return false;
    const key = httpUrl(args && args[0] != null ? String(args[0]) : '').toLowerCase();
    if (!key) return true;
    for (const r of this.requests) {
      if (r.key === key && r.abort) { r.abort('artificial'); break; }
    }
    return true;
  }

  _ghostDir() {
    let d = '';
    try { d = String(this.host.ghostDir() || ''); } catch (e) { d = ''; }
    if (!d) d = '/ghost/master/';
    return d.endsWith('/') ? d : d + '/';
  }

  async _run(req) {
    let r;
    try {
      r = await this._transfer(req);
    } catch (e) {
      r = { ok: false, reason: req.reason || 'error' };
    }
    await this._finish(req, r);
  }

  /** The ghost may still hear about this request. */
  _current(req) { return req.epoch === this.epoch && this.host.live(); }

  /**
   * After the transfer: the body it read (a success's, or a threaded request's error page: httpStatus) goes into the
   * engine's ghost/master/var/ before the event, so the reply's script can read it, or into --nofile's R3; then
   * Complete or Failure, unless the ghost went or is locked [disasm].
   */
  async _finish(req, r) {
    if (!this._current(req)) return;
    let r3 = req.path;
    if (req.name != null && r.body) {
      if (req.name === '.' || req.name === '..' || !req.name) r = { ...r, ok: false, reason: 'fileio' };
      else {
        try {
          const p = await this.host.writeFile(`var/${req.name}`, r.body);
          if (typeof p === 'string' && p) r3 = p;
        } catch (e) {
          log.debug(`http: var/${req.name} could not be written`, e);
          r = { ...r, ok: false, reason: 'fileio' };
        }
      }
    }
    if (req.o.nofile != null) r3 = nofileText(r.body, req.o.nofile);
    if (!this._current(req) || this.host.locked()) return;
    const names = httpEventNames(req.id);
    const refs = [req.method, req.id, req.url, r3, r.ok ? '200' : String(r.reason || 'error'), '', r.headers || ''];
    try {
      await this.host.event(r.ok ? names.complete : names.failure, refs);
    } catch (e) {
      log.debug('http: event failed', e);
    }
  }

  /**
   * --param-input-file's bytes: relative to ghost/master, never a personal file, judged on the path as the engine
   * resolves it (`yaya_variable.cfg/.` is the save) [decision]; null drops it [disasm].
   */
  async _inputFile(req) {
    const p = masterRel(req.o.paramInputFile);
    if (p == null || personalFile(p) || typeof this.host.readFile !== 'function') return null;
    try {
      const b = await this.host.readFile(p);
      return b ? new Uint8Array(b) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * One fetch with SSP's stall timer (EV §4.15): --timeout (default 10 s) for each wait for data, reset when the answer
   * and each chunk come; it expires as `timeout`. Without --nodescript a threaded request sends OnNetworkHeavy at half
   * of it [disasm], and --progress-notify the Progress events (once a second while waiting, at most every 333 ms while
   * the body arrives) [disasm].
   * @returns {Promise<{ok: boolean, reason?: string, body?: Uint8Array|null, headers?: string}>}
   */
  async _transfer(req) {
    const o = req.o;
    const target = parseHttpUrl(req.url);
    if (!target || target.protocol === 'file:') return { ok: false, reason: 'error' };   // a browser has no local files
    if (!this.fetch) { log.debug(`http: ${req.url}: no network here`); return { ok: false, reason: 'error' }; }
    const inputFile = BODY_METHODS.has(req.method) && o.paramInputFile ? await this._inputFile(req) : null;
    const b = buildHttpRequest(o, req.method, { random: this.random, inputFile });
    const noCors = b.simple && b.method === 'POST' && !o.file && o.nofile == null && !o.progress;
    const size = b.body ? b.body.length : 0;
    const keepalive = b.simple && size <= KEEPALIVE_BODY && keepaliveBytes + size <= KEEPALIVE_BUDGET;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    req.abort = reason => { if (!req.reason) req.reason = reason; if (ctrl) ctrl.abort(); };
    const clock = this.clock;
    const limitMs = o.timeoutS * 1000;
    const notes = !o.nodescript;
    const names = httpEventNames(req.id);
    let stall = null, heavy = null, tick = null;
    let waitedFrom = clock.now();
    let lastProgress = 0;
    let soFar = [];
    // R6 from the moment the answer's headers came, in Progress, Complete and Failure alike: RealRead dumps them before
    // it looks at the status (0x65f243; Execute sets the flag, 0x666847), NotifyEvent reads the live SPHttp (0x667e97)
    let headers = '';
    const progress = () => {
      if (!notes || !o.progress || !this._current(req) || this.host.locked()) return;
      lastProgress = clock.now();
      const r3 = o.nofile != null ? nofileText(concat(soFar), o.nofile) : req.path;
      this.host.event(names.progress, [req.method, req.id, req.url, r3, '200', '', headers]).catch(() => {});
    };
    const clear = () => {
      for (const h of [stall, heavy, tick]) if (h != null) clock.clearTimeout(h);
      stall = heavy = tick = null;
    };
    const arm = () => {
      clear();
      waitedFrom = clock.now();
      stall = clock.setTimeout(() => req.abort('timeout'), limitMs);
      if (notes && o.async) {
        heavy = clock.setTimeout(() => {
          heavy = null;
          if (!this._current(req) || this.host.locked()) return;
          const s = String(Math.round((clock.now() - waitedFrom) / 1000));
          this.host.event('OnNetworkHeavy', [String(o.timeoutS), s]).catch(() => {});
        }, limitMs / 2);
      }
      if (notes && o.progress) {
        const every = () => { tick = clock.setTimeout(() => { progress(); every(); }, 1000); };
        every();
      }
    };
    const init = {
      method: b.method, headers: b.headers, mode: noCors ? 'no-cors' : 'cors', credentials: 'omit',
      referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'follow', keepalive,
    };
    if (b.body) init.body = b.body;
    if (ctrl) init.signal = ctrl.signal;
    if (keepalive) keepaliveBytes += size;
    arm();
    log.debug(`http: ${b.method} ${b.url} (${init.mode}${keepalive ? ', keepalive' : ''})`);
    try {
      const res = await this.fetch(b.url, init);
      arm();
      if (!res || res.type === 'opaque' || (noCors && !res.status)) {
        return { ok: true, body: null, headers: '' };                  // a no-cors answer: SSP's success [decision]
      }
      const rh = res.headers || new Map();
      headers = headerText(rh);
      const v = httpStatus(res.status, req.method, { file: req.name != null, location: headerValue(rh, 'location') });
      // a failure's page: read by a threaded request when its Content-Length is above 0 (written or kept for R3 as a
      // success's), drained and dropped by a synchronous one (RealReadContent with no target, 0x65f3fa–0x65f45e)
      const read = v.read && (v.ok || (o.async && wtoul(headerValue(rh, 'content-length') || '') > 0));
      let body = null;
      if (read && (req.name != null || o.nofile != null)) {
        body = await readBody(res, chunk => {
          if (o.nofile != null) {
            soFar.push(chunk);
            if (soFar.reduce((n, c) => n + c.length, 0) > NOFILE_MAX) soFar = [concat(soFar).subarray(0, NOFILE_MAX)];
          }
          arm();
          if (notes && o.progress && clock.now() - lastProgress >= 333) progress();
        });
        if (o.nofile != null && body.length > NOFILE_MAX) body = body.subarray(0, NOFILE_MAX);
      } else dropBody(res);
      return v.ok ? { ok: true, body, headers } : { ok: false, reason: v.reason, body, headers };
    } catch (e) {
      const reason = req.reason || 'error';
      if (reason === 'error') {
        const mixed = this.pageProtocol === 'https:' && target.protocol === 'http:';
        log.debug(`http: ${b.method} ${b.url} failed${mixed ? ' (an http:// URL on an https page is blocked)' : ''}:`,
          e && e.message ? e.message : e);
      }
      // a read that fails empties what came (--nofile's R3 '') and deletes the file it had begun (0x6607e0–0x6608f3);
      // here the previous download stays [decision: the worker deletes no file]
      return { ok: false, reason, body: null, headers };
    } finally {
      clear();
      if (keepalive) keepaliveBytes -= size;
    }
  }
}

/** A response header's value (Headers or a Map-like of lower-case names); null when absent or hidden by CORS. */
function headerValue(headers, name) {
  try {
    if (typeof headers.get === 'function') return headers.get(name) ?? null;
  } catch (e) { /* no headers */ }
  return null;
}

/** A body nobody reads: let the connection go. */
function dropBody(res) {
  try {
    const p = res.body && typeof res.body.cancel === 'function' ? res.body.cancel() : null;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* already read or locked */ }
}

/** The whole body, chunk by chunk when the response streams (each chunk resets the stall timer). */
async function readBody(res, onChunk) {
  const stream = res.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
      parts.push(u8);
      onChunk(u8);
    }
    return concat(parts);
  }
  if (typeof res.arrayBuffer !== 'function') return new Uint8Array(0);
  const u8 = new Uint8Array(await res.arrayBuffer());
  if (u8.length) onChunk(u8);
  return u8;
}

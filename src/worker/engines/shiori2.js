// The SHIORI/2.x bridge (docs/research/kawari7-wasm.md §6): what ssp.exe 2.9.10 sends a SHIORI that answered the
// handshake below 3.0, and how it reads the reply [disasm SPShiori::GetVersionRequestImpl 0x7130a0, SendEvent 0x710aa0
// (version < 30 branch 0x710cde), GetSentence 0x70d090, CommunicateSSTP 0x70c130, Teach 0x711290, Translate 0x7135f0,
// GetStringShiori 0x712ba0, NotifyEnvironment 0x70ded0, NotifyOtherGhost 0x710140, Request 0x712290, GetWord 0x70cbb0].
// The page speaks SHIORI/3.0 to every engine; the worker hands a SHIORI/2.x engine's request here with the kind of call
// ssp.exe would have made (the page's `kind`: 'resource' GetStringShiori, 'translate', 'teach', 'word' a %ms-style word,
// 'communicate-user' the communicate box, 'communicate' another ghost's COMMUNICATE; none: an event), gets back the 2.x
// requests to send, and turns the
// 2.x reply into a SHIORI/3.0-shaped one for the page (its status line keeps the 2.x protocol, which the page's
// communicate reading tells apart: EV §2.7.7). Pure: no engine, no I/O.

const CRLF = '\r\n';

/** ssp.exe's handshake after load, ASCII, before the charset is known [disasm 0x71314a–0x7131ef]. */
export const VERSION_REQUEST = `GET Version SHIORI/2.6${CRLF}Charset: UTF-8${CRLF}Sender: SSP${CRLF}${CRLF}`;
/** sent only when the handshake answered 4xx or a version of 3.0 or more [disasm 0x7132db]. */
export const VERSION_PROBE_30 = `GET SHIORI/3.0${CRLF}Charset: UTF-8${CRLF}ID: version${CRLF}SecurityLevel: local${CRLF}Sender: SSP${CRLF}${CRLF}`;

/** 3.0 notifications ssp.exe never sends a 2.x SHIORI [disasm NotifyEnvironment 0x70e144, 0x70e24f; 0x713464, 0x713524]. */
const SKIPPED = new Set(['basewareversion', 'capability', 'enable_log', 'enable_debug']);
/** lists ssp.exe cuts to 8 names for a 2.x SHIORI [disasm NotifyInstalledGhost 0x70f5d1]. */
const CUT_TO_8 = new Set(['installedsakuraname', 'installedkeroname', 'installedghostname']);

/** What ssp.exe knows of a 2.x SHIORI after the handshake. */
export class Shiori2Session {
  constructor() {
    this.version = 0;          // the handshake's protocol number ×10 (26 for SHIORI/2.6), 0 before it
    this.charset = 'Shift_JIS';
    this.name = '';            // the handshake reply's ID
    this.craftman = '';
  }
}

/**
 * A SHIORI message's start line, headers (name -> value, the first one of a name, any case kept in `list`) and
 * References by index.
 * @param {string} text
 */
export function parseMessage(text) {
  const lines = String(text || '').split(/\r\n|\n/);
  const start = lines[0] || '';
  const list = [];
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break;
    const c = line.indexOf(':');
    if (c < 0) continue;
    const name = line.slice(0, c);
    const value = line.slice(c + 1).replace(/^ +/, '');
    list.push([name, value]);
    const k = name.toLowerCase();
    if (!map.has(k)) map.set(k, value);
  }
  const refs = [];
  for (const [name, value] of list) {
    const m = /^reference(\d+)$/i.exec(name);
    if (m) refs[+m[1]] = value;
  }
  return { start, list, map, refs, get: k => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) };
}

/**
 * ssp.exe's handshake reply [disasm 0x713222–0x7133ce]: the version is the number after `/` in the status line ×10
 * (rounded); a 2xx gives the SHIORI's ID and Craftman; the reply's Charset becomes the module's.
 * @returns {{version:number, status:number, probe30:boolean}} probe30: ssp.exe would send VERSION_PROBE_30 next
 */
export function readVersionReply(reply, session) {
  const msg = parseMessage(reply);
  const m = /^[^/]*\/\s*([0-9.]+)\s+(\d+)/.exec(msg.start);
  const version = m ? Math.floor(parseFloat(m[1]) * 10 + 0.5) : 0;
  const status = m ? +m[2] : 400;
  session.version = version;
  if (status >= 200 && status < 300) {
    if (msg.get('ID') !== null) session.name = msg.get('ID');
    if (msg.get('Craftman') !== null) session.craftman = msg.get('Craftman');
  }
  const cs = msg.get('Charset');
  if (cs) session.charset = cs;
  return { version, status, probe30: (status >= 400 && status < 500) || version >= 30 };
}

const line = (name, value) => `${name}: ${value == null ? '' : value}${CRLF}`;

/** References 0..n-1, an absent one as an empty value (ssp.exe's 2.x builders write every index) [disasm 0x710f78]. */
function allRefs(refs, from = 0, limit = Infinity) {
  let s = '';
  const n = Math.min(refs.length, from + limit);
  for (let i = from; i < n; i++) s += line(`Reference${i - from}`, refs[i] == null ? '' : refs[i]);
  return s;
}

/**
 * The 2.x requests for the page's SHIORI/3.0 request `text` (none: ssp.exe sends nothing, the page gets 204).
 * @param {string} text the page's request
 * @param {Shiori2Session} session
 * @param {{kind?: string, self?: string}} [meta] kind as above; self: this ghost's scope-0 name in effect (a
 *   COMMUNICATE's `To`)
 * @returns {{text: string, kind: string}[]} kind of the 2.x exchange: 'event', 'notify', 'string', 'translate',
 *   'teach', 'word', 'sentence' (both communicates)
 */
export function toShiori2(text, session, { kind = '', self = '' } = {}) {
  const q = parseMessage(text);
  const method = /^NOTIFY/i.test(q.start) ? 'NOTIFY' : 'GET';
  const id = q.get('ID') || '';
  const cs = session.charset || 'Shift_JIS';
  const sender = q.get('Sender') || 'SSP';
  const level = q.get('SecurityLevel') || 'local';
  const status = q.get('Status');
  const refs = q.refs;
  if (kind === 'resource') {
    // GetStringShiori's 2.x branch [disasm 0x712c4b–0x712f1f]
    return [{ kind: 'string', text: `GET String SHIORI/2.5${CRLF}${line('Charset', cs)}${line('SecurityLevel', level)}`
      + `${line('SecurityOrigin', q.get('SecurityOrigin') || 'null')}${line('Sender', sender)}${line('ID', id)}`
      + `${status ? line('Status', status) : ''}${allRefs(refs)}${CRLF}` }];
  }
  if (kind === 'translate') {
    // none below SHIORI/2.6 [disasm 0x713611]; external when R1 says remote [disasm Translate 0x7136b6]
    if (session.version < 26) return [];
    const remote = /remote/i.test(refs[1] || '');
    return [{ kind: 'translate', text: `TRANSLATE Sentence SHIORI/2.6${CRLF}${line('Charset', cs)}`
      + `${line('SecurityLevel', remote ? 'external' : 'local')}${line('SecurityOrigin', 'null')}${line('Sender', sender)}`
      + `${status ? line('Status', status) : ''}${line('Sentence', refs[0] || '')}${CRLF}` }];
  }
  if (kind === 'word') {
    // SPShiori::GetWord's 2.x branch [disasm 0x70cdcc–0x70cefe]: the type (`\ms` …) as Type; no SecurityLevel, no Status
    return [{ kind: 'word', text: `GET Word SHIORI/2.0${CRLF}${line('Charset', cs)}${line('Sender', sender)}`
      + `${line('Type', id)}${CRLF}` }];
  }
  if (kind === 'teach') {
    // Teach's 2.x branch: the first item as Word, the rest as References [disasm 0x711425–0x7115df]
    return [{ kind: 'teach', text: `TEACH SHIORI/2.4${CRLF}${line('Charset', cs)}${line('SecurityLevel', 'local')}`
      + `${line('Sender', sender)}${line('Word', refs[0] || '')}${allRefs(refs, 1)}${CRLF}` }];
  }
  if (kind === 'communicate-user') {
    // GetSentence's 2.x branch [disasm 0x70d314–0x70d4c2]: R0 `user`, R1 the text, R2… extra References
    return [{ kind: 'sentence', text: `GET Sentence SHIORI/2.0${CRLF}${line('Charset', cs)}${line('SecurityLevel', 'local')}`
      + `${line('Sender', 'User')}${line('Sentence', refs[1] || '')}${allRefs(refs, 2)}${CRLF}` }];
  }
  if (kind === 'communicate') {
    // CommunicateSSTP's 2.x branch [disasm 0x70c757–0x70cadd]: R0 the sender, R1 the sentence, R2… the References
    // (absent ones skipped, the index kept); Age always, Marker and Surface when given
    let extra = '';
    for (let i = 2; i < refs.length; i++) if (refs[i] != null) extra += line(`Reference${i - 2}`, refs[i]);
    const marker = q.get('Marker');
    const surface = q.get('Surface');
    return [{ kind: 'sentence', text: `GET Sentence SHIORI/2.3${CRLF}${line('Charset', cs)}${line('SecurityLevel', level)}`
      + `${line('Sender', refs[0] || '')}${line('Sentence', refs[1] || '')}${line('To', self)}`
      + `${line('Age', q.get('Age') || '0')}${marker !== null ? line('Marker', marker) : ''}`
      + `${surface !== null ? line('Surface', surface) : ''}${extra}${CRLF}` }];
  }
  if (method === 'NOTIFY' && SKIPPED.has(id)) return [];
  if (method === 'NOTIFY' && id === 'ownerghostname') {
    // NotifyEnvironment's 2.x branch [disasm 0x70df8f]
    return [{ kind: 'notify', text: `NOTIFY OwnerGhostName SHIORI/2.3${CRLF}${line('Charset', cs)}${line('Sender', sender)}`
      + `${line('Ghost', refs[0] || '')}${CRLF}` }];
  }
  if (method === 'NOTIFY' && id === 'otherghostname') {
    // NotifyOtherGhost's 2.x branch [disasm 0x71046e–0x71061d]: per ghost GhostEx (name\x01s0\x01s1), then Ghost
    let ghosts = '';
    for (const r of refs) {
      if (r == null) continue;
      ghosts += line('GhostEx', r) + line('Ghost', String(r).split('\x01')[0]);
    }
    return [{ kind: 'notify', text: `NOTIFY OtherGhostName SHIORI/2.3${CRLF}${line('Charset', cs)}${line('Sender', sender)}`
      + `${ghosts}${CRLF}` }];
  }
  // every other event, NOTIFY ones too: SendEvent's 2.x branch [disasm 0x710cde–0x710fdc]
  const base = q.get('BaseID');
  const list = CUT_TO_8.has(id) ? refs.slice(0, 8) : refs;
  return [{ kind: method === 'NOTIFY' ? 'notify' : 'event', text: `GET Sentence SHIORI/2.2${CRLF}${line('Charset', cs)}`
    + `${line('SecurityLevel', level)}${line('Sender', sender)}${line('Event', id)}${base ? line('BaseEvent', base) : ''}`
    + `${status ? line('Status', status) : ''}${allRefs(list)}${CRLF}` }];
}

/**
 * the reply headers that carry the script, per exchange [disasm Request 0x712373; GetStringShiori 0x712fe4; GetWord
 * 0x70cfda–0x70cff5]
 */
const SCRIPT_HEADERS = { string: ['Value', 'String', 'Sentence'], word: ['Value', 'Word'] };
const DEFAULT_SCRIPT = ['Value', 'Sentence'];

/**
 * The page's reply for one 2.x exchange: the 2.x status line kept (the page reads its protocol), the reply's own
 * headers (To, Age, Reference*, Marker, BalloonOffset, ErrorLevel …) except Charset (the worker decoded it: UTF-8),
 * and `Value` = the script, read as ssp.exe reads it for that exchange, only for 200, 311 and 312. No reply: 500.
 * @param {string|null} reply the 2.x reply, decoded
 * @param {string} kind the exchange's kind (toShiori2)
 */
export function fromShiori2(reply, kind) {
  if (reply == null || reply === '') return `SHIORI/2.6 500 Internal Server Error${CRLF}Charset: UTF-8${CRLF}${CRLF}`;
  const msg = parseMessage(reply);
  const m = /^SHIORI\/(\d+\.\d+)\s+(\d+)\s*(.*)$/.exec(msg.start);
  const proto = m ? m[1] : '2.6';
  const code = m ? +m[2] : 400;
  let out = `SHIORI/${proto} ${code} ${m ? m[3] : 'Bad Request'}${CRLF}Charset: UTF-8${CRLF}`;
  for (const [name, value] of msg.list) {
    if (/^(charset|value)$/i.test(name)) continue;
    out += line(name, value);
  }
  if (code === 200 || code === 311 || code === 312) {
    for (const h of SCRIPT_HEADERS[kind] || DEFAULT_SCRIPT) {
      const v = msg.get(h);
      if (v) { out += line('Value', v); break; }
    }
  }
  return out + CRLF;
}

/** The page's reply when ssp.exe sends nothing (a skipped notification, OnTranslate below 2.6). */
export const NOTHING = `SHIORI/2.6 204 No Content${CRLF}Charset: UTF-8${CRLF}${CRLF}`;

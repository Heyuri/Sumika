// SakuraScript tokenizer (docs/research/sakurascript.md §3). Pure, single linear pass, no regex backtracking.
//
// Token shapes (every token covers src.slice(pos, end); the tokens tile the whole script):
//   {type:'text', text, pos, end}                        literal characters, escapes already resolved
//   {type:'tag', name, args, form, raw, pos, end}        args: string[] | null; form: 'none'|'digit'|'bracket'|'bracket2'
//   {type:'unknown', name, args, form, raw, pos, end}    `\__X` that ssp.exe does not know: swallowed (the player
//                                                        skips it); every other unknown `\X` is text (SS §3.2)
//   {type:'env', name:'*', raw, pos, end}                %* (the marker, as \![*]); every other %-variable was
//                                                        expanded before the script got here (expand.js) and is text
// A tag whose '[' is never closed carries `unterminated: true` and runs to the end of the script; the player drops it
// and everything after it, as ssp.exe does ("Unclosed '['", SS §3.4).
//
// Brackets are read as ssp.exe 2.9.08f reads them (SS §3.4) [disasm]: multi-argument tags through SPGhost::
// ParseParameters (parseBracket), one-string tags through SPGhost::ParseBracket (parseString), \p[ and \w[ through
// DecodeProcReal's own digit loops, \q with SSP's legacy and too-few-arguments rules.

const NONE = 0, DIGIT_OR_BRACKET = 1, OPTIONAL_BRACKET = 2, REQUIRED_BRACKET = 3;

/**
 * Argument policy per tag name (SS §3.3): every name ssp.exe 2.9.10's DecodeProcReal knows [disasm: the dispatch
 * 0x62c344 / 0x62c2d0, the `\_` branch 0x62ad77, the `\__` branch 0x62bbe0], no other.
 */
export const TAG_POLICY = new Map();
for (const n of ['0', '1', 'h', 'u', 'e', 'y', 'z', '-', '+', '_+', '*', 't', 'v', '4', '5', '6', '7', 'a', 'C', 'l',
  'B', 'U', '_q', '_n', '_V', '_?', '_!', '_i', '_e', '__t', '__c']) TAG_POLICY.set(n, NONE);
for (const n of ['s', 'b', 'p', 'i', 'w']) TAG_POLICY.set(n, DIGIT_OR_BRACKET);
for (const n of ['n', 'c', 'x', '_a', '__q', '_s', '__v']) TAG_POLICY.set(n, OPTIONAL_BRACKET);
for (const n of ['_w', '__w', 'q', '_b', '_l', 'f', 'j', '!', '8', '_v', '_u', '_m', '_c', '&', 'm']) TAG_POLICY.set(n, REQUIRED_BRACKET);

/** Tags whose bracket is one string, commas and `\,` kept (SPGhost::ParseBracket callers in DecodeProcReal). */
const ONE_STRING = new Set(['s', 'n', 'j', '8', '&', '_u', '_m', '_w', '_v', '_c']);

/**
 * Tags that, with no '[' (nor a digit where one may stand) and more script after the name, make ssp.exe 2.9.10 log
 * "missing '['" and step back to the character after the `\`, so the name shows as text (SS §3.3) [disasm]. The other
 * bracket tags (\p \w \q \f \8 \m) consume their name; the optional ones (\n \c \x \_a \_s \__q \__v) go on without.
 */
const STEP_BACK = new Set(['s', 'b', 'i', 'j', '!', '&', '_u', '_m', '_w', '_b', '_l', '_v', '_c', '__w']);

// the characters ssp.exe knows after `\`, after `\_` and after `\__` (TAG_POLICY's names)
const ONE_CHAR = new Set([...TAG_POLICY.keys()].filter(k => k.length === 1));
const UNDER = new Set([...TAG_POLICY.keys()].filter(k => /^_[^_]$/.test(k)).map(k => k[1]));

const BS = 92, PCT = 37, LBR = 91, RBR = 93, QUOT = 34, COMMA = 44, STAR = 42, USC = 95;
const isDigit = c => c >= 48 && c <= 57;

/**
 * SSP's bracket loop (SS §3.4) [disasm ParseParameters 0x6240d0, ParseBracket 0x624660], src[i] === '['.
 * - A `"` outside quotes opens a quote anywhere in an argument and is dropped; inside quotes `,` `]` `\` are data and
 *   `""` is one `"`; the next lone `"` closes it and the argument goes on (`a"b,c]d"e` is `ab,c]de`).
 * - Outside quotes `\X` is always a pair: `\]` gives `]`, `\,` gives `,` when splitting, any other pair stays whole
 *   (`\\` stays `\\`, `\"` opens no quote). So a backslash never ends the bracket.
 * - The first `]` outside quotes ends it. Without one the bracket is unterminated, except when the script ends inside
 *   an open quote on a `]` (SSP's last-character check, 0x6243cf): then it counts as closed there.
 * An empty argument is '' (SSP stores a middle one as the placeholder " ", which ParametersToArray and bind turn back
 * into empty; `parseHttpOptions` re-creates it).
 */
function readBracket(src, i, split) {
  const n = src.length;
  const args = [];
  let cur = '', seg = i + 1, j = i + 1, inQuote = false;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (inQuote) {
      if (c === QUOT) {
        cur += src.slice(seg, j);
        if (src.charCodeAt(j + 1) === QUOT) { cur += '"'; j += 2; seg = j; continue; }
        inQuote = false; j++; seg = j; continue;
      }
      j++; continue;
    }
    if (c === BS) {
      const d = src.charCodeAt(j + 1);
      if (d === RBR || (split && d === COMMA)) { cur += src.slice(seg, j); seg = j + 1; }
      j += 2; continue;
    }
    if (c === QUOT) { cur += src.slice(seg, j); inQuote = true; j++; seg = j; continue; }
    if (c === COMMA && split) { args.push(cur + src.slice(seg, j)); cur = ''; j++; seg = j; continue; }
    if (c === RBR) { args.push(cur + src.slice(seg, j)); return { args, end: j + 1 }; }
    j++;
  }
  args.push(cur + src.slice(seg, n));
  if (inQuote && src.charCodeAt(n - 1) === RBR) return { args, end: n };
  return { args, end: n, unterminated: true };
}

/**
 * A multi-argument bracket at src[i] === '[' (SSP's ParseParameters): split at commas outside quotes.
 * @returns {{args: string[], end: number, unterminated?: boolean}}
 */
export function parseBracket(src, i) { return readBracket(src, i, true); }

/**
 * A one-string bracket at src[i] === '[' (SSP's ParseBracket): the same loop, commas are data and `\,` stays `\,`.
 * @returns {{args: [string], end: number, unterminated?: boolean}}
 */
export function parseString(src, i) { return readBracket(src, i, false); }

/** \p[…] (DecodeProcReal 0x627ac0) [disasm]: everything up to the first `]` (or the end), no quotes, no escapes. */
function readScopeBracket(src, i) {
  const k = src.indexOf(']', i + 1);
  return k < 0 ? { args: [src.slice(i + 1)], end: src.length } : { args: [src.slice(i + 1, k)], end: k + 1 };
}

/**
 * \w[…] (DecodeProcReal 0x628457) [disasm]: digits up to `]`, commas skipped. Any other character, or the end of the
 * script, puts SSP back at the `[`, which then shows as text: null.
 */
function readWaitBracket(src, i) {
  let digits = '';
  for (let j = i + 1; j < src.length; j++) {
    const c = src.charCodeAt(j);
    if (c === RBR) return { args: [digits], end: j + 1 };
    if (isDigit(c)) digits += src[j];
    else if (c !== COMMA) return null;
  }
  return null;
}

/** No `"` in src[from, to). */
function quoteFree(src, from, to) {
  for (let k = from; k < to; k++) if (src.charCodeAt(k) === QUOT) return false;
  return true;
}

/**
 * `%*` at src[i] === '%' (SS §3.5). The other %-variables are expanded over the whole script before it plays, as
 * ssp.exe's TranslateParam does (expand.js, properties.md §2); what is left of them here is text.
 */
function matchEnv(src, i) {
  return src.charCodeAt(i + 1) === STAR ? { type: 'env', name: '*', raw: '%*', pos: i, end: i + 2 } : null;
}

/**
 * Tokenize a script.
 * @param {string} src
 * @returns {object[]} tokens (see the header comment)
 */
export function tokenize(src) {
  src = src == null ? '' : String(src);
  const n = src.length;
  const out = [];
  // the current text run: starts at runStart; its text is acc + src.slice(seg, i)
  let runStart = -1, acc = '', seg = 0;
  let i = 0;
  let rawMode = null;            // '_?' or '_!' while inside a verbatim section
  let qFew = null;               // the last quote-free \q bracket with too few arguments: {from: '[', end} (see \q)

  const begin = at => { if (runStart < 0) { runStart = at; acc = ''; seg = at; } };
  const flush = at => {
    if (runStart < 0) return;
    const text = acc + src.slice(seg, at);
    if (text || at > runStart) out.push({ type: 'text', text, pos: runStart, end: at });
    runStart = -1; acc = '';
  };

  while (i < n) {
    if (rawMode) {
      // verbatim until the closing \_? (or \_!)
      const close = src.indexOf('\\' + rawMode, i);
      const stop = close < 0 ? n : close;
      if (stop > i) { begin(i); i = stop; }
      if (close < 0) break;
      flush(i);
      out.push({ type: 'tag', name: rawMode, args: null, form: 'none', raw: '\\' + rawMode, pos: i, end: i + 3 });
      i += 3; rawMode = null;
      continue;
    }
    const c = src.charCodeAt(i);
    if (c !== BS && c !== PCT) {
      begin(i);
      i++;
      while (i < n) { const d = src.charCodeAt(i); if (d === BS || d === PCT) break; i++; }
      continue;
    }
    if (c === PCT) {
      const m = matchEnv(src, i);
      if (m) { flush(i); out.push(m); i = m.end; continue; }
      begin(i); i++;
      continue;
    }
    // backslash
    if (i + 1 >= n) { begin(i); i++; continue; }          // lone trailing backslash is text
    const d = src.charCodeAt(i + 1);
    if (d === BS || d === PCT) {                           // escapes \\ and \%
      begin(i);
      acc += src.slice(seg, i) + src[i + 1];
      i += 2; seg = i;
      continue;
    }
    // names as ssp.exe 2.9.10 reads them (SS §3.2) [disasm DecodeProcReal 0x628de0]
    let name, j;
    if (d === USC) {
      if (src.charCodeAt(i + 2) === USC) {
        // `\__` + any one character; one SSP does not know is swallowed with it ("unknown tag", 0x62bd71)
        name = '__' + (src[i + 3] ?? ''); j = Math.min(i + 4, n);
      } else if (UNDER.has(src[i + 2])) {
        name = '_' + src[i + 2]; j = i + 3;
      } else {
        // an unknown `\_X`: SSP writes the `\` and reads on from the `_`, so it shows as written (0x62bd8c)
        begin(i); i += 2;
        continue;
      }
    } else if (ONE_CHAR.has(src[i + 1])) {
      name = src[i + 1]; j = i + 2;
    } else {
      // any other character ("unknown tag", 0x62be00): SSP reads on from it, so only the backslash is gone (`\k[1]` ->
      // `k[1]`, `\わ` -> `わ`, `\URL[…]` is \U and the text `RL[…]`)
      begin(i); acc += src.slice(seg, i); i++; seg = i;
      continue;
    }
    const pol = TAG_POLICY.get(name);
    let args = null, form = 'none', unterminated = false;
    if (name === 'w') {
      // \w skips one '_' when two more characters follow (\w_5, \w_[100]; 0x62a191); \w[ by its own rules (SS §3.4)
      const k = src.charCodeAt(j) === USC && j + 2 < n ? j + 1 : j;
      if (isDigit(src.charCodeAt(k))) { args = [src[k]]; form = 'digit'; j = k + 1; }
      else if (src.charCodeAt(k) === LBR) {
        const b = readWaitBracket(src, k);
        if (b) { args = b.args; j = b.end; form = 'bracket'; }
      }
    } else if (pol === DIGIT_OR_BRACKET && isDigit(src.charCodeAt(j))) {
      args = [src[j]]; form = 'digit'; j++;
    } else if (name === 'q') {
      // SSP's \q (DecodeProcReal 0x6287b1) [disasm]: one character that is not '[' is skipped (\q0[ID][title]); a
      // '[' right after the bracket makes it the legacy \q[ID][title] (both re-read as one string each); otherwise
      // it needs two arguments, and with one ("too few parameters") SSP goes on at the '[', which shows as text.
      // A '[' inside a quote-free too-few bracket [from, end) is read from the same state (a '[' never starts a \X
      // pair), so its bracket ends at the same ']' with no comma: too few again, known without the rescan SSP does
      // (\q[\q[\q[…] stays linear; a bracket with a '"' is rescanned)
      if (j < n && src.charCodeAt(j) !== LBR) j++;
      if (src.charCodeAt(j) === LBR && !(qFew && j > qFew.from && j < qFew.end)) {
        const b = parseBracket(src, j);
        if (b.unterminated) { args = b.args; form = 'bracket'; unterminated = true; j = b.end; }
        else if (src.charCodeAt(b.end) === LBR) {
          const b1 = parseString(src, j), b2 = parseString(src, b1.end);
          args = [b1.args[0], b2.args[0]]; form = 'bracket2'; unterminated = !!b2.unterminated; j = b2.end;
        } else if (b.args.length >= 2) { args = b.args; form = 'bracket'; j = b.end; }
        else qFew = quoteFree(src, j + 1, b.end) ? { from: j, end: b.end } : null;
      }
    } else if (name === 'p' && src.charCodeAt(j) === LBR) {
      const b = readScopeBracket(src, j);
      args = b.args; j = b.end; form = 'bracket';
    } else if (pol > NONE && src.charCodeAt(j) === LBR) {
      const b = ONE_STRING.has(name) ? parseString(src, j) : parseBracket(src, j);
      args = b.args; j = b.end; form = 'bracket'; unterminated = !!b.unterminated;
    }
    if (args === null && j < n && STEP_BACK.has(name)) {
      // only the backslash is dropped: `\sx` -> `sx`, `\_ux` -> `_ux`, `\__wx` -> `__wx` (at the end: nothing)
      begin(i); acc += src.slice(seg, i); i++; seg = i;
      continue;
    }
    flush(i);
    const tok = { type: pol === undefined ? 'unknown' : 'tag', name, args, form, raw: src.slice(i, j), pos: i, end: j };
    if (unterminated) tok.unterminated = true;
    out.push(tok);
    i = j;
    if (name === '_?' || name === '_!') rawMode = name;
  }
  flush(n);
  return out;
}

/** Display text of a token list (text tokens only), for labels and tests. */
export function plainText(tokens) {
  let s = '';
  for (const t of tokens) if (t.type === 'text') s += t.text;
  return s;
}

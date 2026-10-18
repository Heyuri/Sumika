// %-variables of a script, expanded once before it plays: ssp.exe's SPGhost::TranslateParam / TranslateParamReal
// [disasm 0x636440, 0x636510] (docs/research/properties.md §2). Pure: the caller's resolver gives the values.
//
// The event loop runs it over the whole script before OnTranslate, again when OnTranslate changed the script, and on a
// \![embed] reply before it is spliced in [disasm 0x63B747, 0x63B7AF–0x63B822, 0x633349]; nothing else expands, so a
// value is read when the script starts. The tokenizer then sees plain text, except `%*` (the marker, as \![*]).
//
// One pass (TranslateParamReal), as ssp.exe scans:
// - `\` skips itself, up to two `_` and the tag letter; a `[` right after the letter skips to the first `]` that has
//   no `\` before it (quotes are not honoured). So nothing inside a tag's bracket is expanded, and `\%` never is.
// - `%` + a known name (case-sensitive, longest first) is replaced by the resolver's value: `%property[NAME]` (NAME up
//   to the first `]`; none, or an empty NAME: left as written) inserts the value raw, a failed one (null) is removed;
//   the names of people and ghosts double their backslashes (DOUBLED); another name the resolver has no value for
//   (null) stays as written. The word variables (WORD_NAMES) are asked like any other name.
// - After a replacement the scan goes on from the 2nd character of what now stands there: inside an inserted value,
//   or one character late after a removal [disasm 0x6372F4–0x637307, 0x637024].
// The passes repeat while the text changes, at most `maxPasses` (5) [disasm TranslateParam 0x636440].
import { log } from '../core/log.js';

/** The %-variables expanded here (the tokenizer's former list minus `*`), longest first (SS §3.5). */
export const EXPAND_NAMES = ['property', 'lastobjectname', 'lastghostname', 'screenheight', 'screenwidth', 'selfname2',
  'selfname', 'wronghour', 'keroname', 'username', 'minute', 'second', 'month', 'hour', 'day', 'exh', 'dms', 'et', 'ms',
  'mz', 'ml', 'mc', 'mh', 'mt', 'me', 'mp', 'm?'];

/**
 * The word variables: `%dms` and `%m` + one of `cehlpstz?` ask SPGhost::GetWord for the type `\dms` / `\mX`
 * [disasm TranslateParamReal 0x636750–0x636779, 0x636C82–0x636CDB] (properties.md §2.4); `m` is a `%m` that ends the
 * text (matchVar).
 */
export const WORD_NAMES = new Set(['dms', 'ms', 'mz', 'ml', 'mc', 'mh', 'mt', 'me', 'mp', 'm?', 'm']);

// values whose backslashes are doubled before they go in: JWString::Replace("\", "\\") after the value [disasm
// %username 0x637252, %selfname 0x6370B1, %selfname2 0x63705E, %keroname 0x636B1D, %lastobjectname 0x636B70,
// %lastghostname 0x636BC9]; %property and the numbers go in as they are
const DOUBLED = new Set(['username', 'selfname', 'selfname2', 'keroname', 'lastobjectname', 'lastghostname']);

// ssp.exe has no bound: a value that holds its own variable after its first character grows the script for ever.
// Sumika stops expanding there [decision] (a run over 1 MB is dropped anyway, SUM §2.5)
const MAX_SUBSTITUTIONS = 10000;
const MAX_GROWTH = 1 << 20;

const BS = 92, PCT = 37, LBR = 91, RBR = 93, US = 95, LOWER_M = 109;

const isThenable = v => !!v && typeof v.then === 'function';

/** A known %-variable at s[i] === '%': {name, arg?, end} (end: the index after it), or null. */
function matchVar(s, i) {
  for (const name of EXPAND_NAMES) {
    if (!s.startsWith(name, i + 1)) continue;
    const after = i + 1 + name.length;
    if (name !== 'property') return { name, end: after };
    if (s.charCodeAt(after) !== LBR) return null;
    const close = s.indexOf(']', after + 1);
    if (close < 0 || close === after + 1) return null;          // unclosed, or %property[]: left as written
    return { name, arg: s.slice(after + 1, close), end: close + 1 };
  }
  // a `%m` that ends the text asks the type `\m`: ssp.exe's wcschr(L"cehlpstz?", c) also finds the terminating NUL
  // [disasm 0x636C8F], and the replaced length is cut at the end [disasm JWString::Replace 0x5AC1BE]
  if (s.charCodeAt(i + 1) === LOWER_M && i + 2 === s.length) return { name: 'm', end: i + 2 };
  return null;
}

/**
 * One TranslateParamReal pass as a generator: yields each variable it meets ({name, arg?}), takes its value back.
 * @returns {Generator<{name:string, arg?:string}, string, string|null>}
 */
function* scanPass(s, budget) {
  let i = 0;
  while (i < s.length - 1) {
    const c = s.charCodeAt(i);
    if (c === BS) {
      i++;
      if (s.charCodeAt(i) === US) { i++; if (s.charCodeAt(i) === US) i++; }
      if (i < s.length && s.charCodeAt(i + 1) === LBR) {
        i++;                                    // at the '['
        if (i < s.length - 1) {
          for (i++; ; i++) {
            if (s.charCodeAt(i) === RBR && s.charCodeAt(i - 1) !== BS) break;
            if (i >= s.length - 1) break;
          }
        }
      }
    } else if (c === PCT) {
      const m = matchVar(s, i);
      if (m) {
        if (budget.subs <= 0 || s.length > budget.maxLength) {
          if (!budget.stopped) log.once('expand:stop', 'a %-variable keeps expanding into itself: expansion stopped');
          budget.stopped = true;
          return s;
        }
        budget.subs--;
        const v = yield m.name === 'property' ? { name: m.name, arg: m.arg } : { name: m.name };
        if (m.name === 'property' || v != null) {
          let t = v == null ? '' : String(v);
          if (DOUBLED.has(m.name)) t = t.replace(/\\/g, '\\\\');
          s = s.slice(0, i) + t + s.slice(m.end);
        }
      }
    }
    i++;
  }
  return s;
}

function* expandAll(script, maxPasses, budget) {
  let s = script;
  for (let pass = 0; pass < maxPasses && !budget.stopped; pass++) {
    const before = s;
    s = yield* scanPass(s, budget);
    if (s === before) break;
  }
  return s;
}

function ask(resolve, req) {
  try {
    return resolve(req.name, req.arg);
  } catch (e) {
    log.once('expand:resolve:' + req.name, `%${req.name}: no value`, e);
    return null;
  }
}

async function settle(p, req) {
  try {
    return await p;
  } catch (e) {
    log.once('expand:resolve:' + req.name, `%${req.name}: no value`, e);
    return null;
  }
}

async function finishAsync(gen, resolve, req, first) {
  let step = gen.next(await settle(first, req));
  while (!step.done) {
    const r = ask(resolve, step.value);
    step = gen.next(isThenable(r) ? await settle(r, step.value) : r);
  }
  return step.value;
}

/**
 * Expand the %-variables of a script as ssp.exe does before it plays it (see the header).
 * @param {string} script
 * @param {(name: string, arg?: string) => string|null|PromiseLike<string|null>} resolve  name is 'property' (arg =
 *   the bracket text up to the first ']'), another of EXPAND_NAMES, or 'm' (a `%m` that ends the script); null:
 *   property failed (removed), others left
 * @param {{maxPasses?: number}} [o]
 * @returns {string|Promise<string>} a string when no resolve call returned a thenable, else a Promise of the same text
 */
export function expandScript(script, resolve, { maxPasses = 5 } = {}) {
  const s = script == null ? '' : String(script);
  if (s.indexOf('%') < 0) return s;
  const gen = expandAll(s, maxPasses, { subs: MAX_SUBSTITUTIONS, maxLength: s.length + MAX_GROWTH, stopped: false });
  let step = gen.next();
  while (!step.done) {
    const r = ask(resolve, step.value);
    if (isThenable(r)) return finishAsync(gen, resolve, step.value, r);
    step = gen.next(r);
  }
  return step.value;
}

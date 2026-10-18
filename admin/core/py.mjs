// What the admin core needs of Python's own semantics to give tools/index_site.py's and tools/add_ghost.py's outputs
// byte for byte (CLAUDE.md "The admin tool"): str.strip() and str.splitlines() (Python's whitespace and line boundaries,
// wider than JS trim() and /\r\n|\r|\n/), sorted() on str (code points, not UTF-16 units), fnmatch.fnmatchcase, repr()
// of a str (the KAWARI_SHIPPED_SAVES line add_ghost.py prints) and json.dumps (ensure_ascii=False, compact or indent 1).
// Pure: no I/O.

// str.isspace() (Python 3.13): \t \n \v \f \r, \x1c-\x1f, space, \x85, \xa0, U+1680, U+2000-U+200A, U+2028, U+2029,
// U+202F, U+205F, U+3000. JS trim() adds U+FEFF and lacks \x1c-\x1f and \x85.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
// str.splitlines() boundaries: \r\n, \n, \v, \f, \r, \x1c, \x1d, \x1e, \x85, U+2028, U+2029
const LINES = new RegExp('\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]');

/** str.strip() with no argument. */
export function pyStrip(s) {
  return String(s).replace(STRIP, '');
}

/** str.splitlines(): no trailing empty line after a final line break. */
export function pySplitlines(s) {
  const out = String(s).split(LINES);
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** Python's str order: by code point (a lone surrogate is its own code point). */
export function cmpPy(a, b) {
  const x = String(a), y = String(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x.codePointAt(i), q = y.codePointAt(i);
    if (p !== q) return p < q ? -1 : 1;
    if (p > 0xffff) i++;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/** sorted() of strings: a sorted copy, by code point. */
export function sortedPy(list) {
  return [...list].sort(cmpPy);
}

// a literal outside a set ('u' mode allows only syntax characters and '/' to be escaped: never '-')
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const STAR = '[\\s\\S]*';

/**
 * fnmatch.translate (Python 3.13) as a JS regular expression: `*` any run (newlines too), `?` one character, `[…]`
 * a set (`[!…]` negated, a leading `]` literal, an unclosed `[` literal, reversed ranges dropped as Python drops
 * them), everything else literal. Case-sensitive: fnmatchcase.
 */
export function fnmatchRegex(pat) {
  let out = '';
  let star = false;                    // the last token was `*` (consecutive ones are one, as Python compresses them)
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat[i++];
    const wasStar = star;
    star = c === '*';
    if (c === '*') {
      if (!wasStar) out += STAR;
    } else if (c === '?') {
      out += '[\\s\\S]';
    } else if (c === '[') {
      let j = i;
      if (j < n && pat[j] === '!') j++;
      if (j < n && pat[j] === ']') j++;
      while (j < n && pat[j] !== ']') j++;
      if (j >= n) {
        out += '\\[';
        continue;
      }
      let stuff;
      if (!pat.slice(i, j).includes('-')) {
        stuff = [pat.slice(i, j)];
      } else {
        const chunks = [];
        let k = pat[i] === '!' ? i + 2 : i + 1;
        let start = i;
        for (;;) {
          k = pat.indexOf('-', k);
          if (k < 0 || k >= j) break;
          chunks.push(pat.slice(start, k));
          start = k + 1;
          k += 3;
        }
        const chunk = pat.slice(start, j);
        if (chunk) chunks.push(chunk);
        else chunks[chunks.length - 1] += '-';
        for (let m = chunks.length - 1; m > 0; m--) {        // remove empty ranges, as Python does
          if (chunks[m - 1][chunks[m - 1].length - 1] > chunks[m][0]) {
            chunks[m - 1] = chunks[m - 1].slice(0, -1) + chunks[m].slice(1);
            chunks.splice(m, 1);
          }
        }
        stuff = chunks;
      }
      i = j + 1;
      // one string per range end: escape everything but the range hyphens between chunks
      const negate = stuff[0].startsWith('!');
      if (negate) stuff[0] = stuff[0].slice(1);
      const body = stuff.map(s => s.replace(/[\\\]\[^-]/g, '\\$&')).join('-');
      if (!body && !negate) out += '(?!)';
      else if (!body) out += '[\\s\\S]';
      else out += negate ? `[^${body}]` : `[${body}]`;
    } else {
      out += reEscape(c);
    }
  }
  return new RegExp(`^(?:${out})$`, 'u');
}

const fnCache = new Map();

/** fnmatch.fnmatchcase(name, pat). (fnmatch.fnmatch lower-cases both on Windows: callers pass lower-cased names.) */
export function fnmatchcase(name, pat) {
  let re = fnCache.get(pat);
  if (!re) {
    re = fnmatchRegex(pat);
    fnCache.set(pat, re);
  }
  return re.test(name);
}

const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** repr() of a str, as Python prints it (the quote it picks, its escapes, printable characters kept). */
export function pyRepr(s) {
  const str = String(s);
  const q = str.includes('\'') && !str.includes('"') ? '"' : '\'';
  let out = q;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (ch === q || ch === '\\') out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else if (c < 0x7f) out += ch;
    else if (c !== 0x20 && NOT_PRINTABLE.test(ch)) {
      out += c <= 0xff ? '\\x' + c.toString(16).padStart(2, '0')
        : c <= 0xffff ? '\\u' + c.toString(16).padStart(4, '0') : '\\U' + c.toString(16).padStart(8, '0');
    } else out += ch;
  }
  return out + q;
}

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function str(s) {
  // json.dumps(ensure_ascii=False) writes a lone surrogate as it is, and the UTF-8 encode after it fails
  if (LONE.test(s)) throw new Error(`a lone surrogate cannot be written as UTF-8: ${JSON.stringify(s)}`);
  return JSON.stringify(s);       // the same escapes as Python's: \" \\ \b \f \n \r \t, other controls \u00xx
}

/**
 * json.dumps(value, ensure_ascii=False) with separators=(',', ':') (indent null) or indent=1 (', ' items, ': '
 * keys, as Python's default separators with an indent). Keys keep insertion order: a Map for keys taken from data
 * (ghost ids and paths: a plain object would move an integer-like key first). Integers only, as the index holds.
 * @param {unknown} value  @param {{indent?: number|null}} [o]
 * @returns {string}
 */
export function dumps(value, { indent = null } = {}) {
  const enc = (v, level) => {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new Error(`not an integer the index holds: ${v}`);
      return String(v);
    }
    if (typeof v === 'string') return str(v);
    const pairs = v instanceof Map ? [...v] : Array.isArray(v) ? null : Object.entries(v);
    const items = pairs ? pairs.map(([k, x]) => [str(String(k)), x]) : v.map(x => [null, x]);
    const [open, close] = pairs ? ['{', '}'] : ['[', ']'];
    if (!items.length) return open + close;
    if (indent === null) {
      return open + items.map(([k, x]) => (k === null ? '' : k + ':') + enc(x, level + 1)).join(',') + close;
    }
    const pad = '\n' + ' '.repeat(indent * (level + 1));
    return open + pad + items.map(([k, x]) => (k === null ? '' : k + ': ') + enc(x, level + 1)).join(',' + pad)
      + '\n' + ' '.repeat(indent * level) + close;
  };
  return enc(value, 0);
}

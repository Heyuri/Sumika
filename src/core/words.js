// SSP's built-in word list for the %-variables %ms %mz %ml %mc %mh %mt %me %mp %m? and %dms (properties.md §2.4): the
// last resort of ssp.exe's SPGhost::GetWord [disasm 0x63FA00] once the ghost's SHIORI had no word. ssp.exe reads it
// from its own data file `data/word_compatible.txt` (FindSystemFileFromPartialDir) at the first word nobody answered and
// keeps it [disasm 0x63FA62–0x63FB66]; Sumika reads the site's copy (WORD_FILE) once per page (Site.compatibleWords).
// Without that file no word comes from it and the variable stays as written, as in an SSP without its data file.
import { decodeText } from './loader.js';
import { log } from './log.js';

/** The site's copy of ssp.exe's `data/word_compatible.txt` (SSP 2.9.10: 2,341 bytes, UTF-8, dated 2015-01-07). */
export const WORD_FILE = 'sumika/word_compatible.txt';

/** wcsicmp_custom's folding [disasm FindEntry 0x5ECC49]: the section names are ASCII. */
const fold = s => String(s).replace(/[A-Z]/g, c => c.toLowerCase());

function findSection(sections, name) {
  const k = fold(name);
  return sections.find(s => fold(s.name) === k) || null;
}

/**
 * SPCompatibleWord::Load [disasm 0x5EC880]: the file through JTokenStream (j_stoken.obj) a whole line at a time
 * (ReadToken(0) never splits at its ',' separator), spaces and tabs trimmed at both ends, empty lines and lines that
 * start with `//` skipped [disasm ReadEOL 0x583790, NextToken 0x583C51, ProcessReturnPointer 0x583CF0]. A `charset,…`
 * line (any case) only sets the code page; `*NAME` starts the section NAME, or goes on with the one of that name (any
 * case); any other line is a word of the current section, none before the first `*`.
 * @param {string} text the decoded file (loader.js decodeText reads its `charset,UTF-8` line or BOM)
 * @returns {{name: string, words: string[]}[]} the sections in file order
 */
export function parseWordList(text) {
  const sections = [];
  let cur = null;
  for (const raw of String(text == null ? '' : text).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (line === '' || line.startsWith('//') || /^charset,/i.test(line)) continue;
    if (line[0] === '*') {
      const name = line.slice(1);
      cur = findSection(sections, name);
      if (!cur) {
        cur = { name, words: [] };
        sections.push(cur);
      }
    } else if (cur) {
      cur.words.push(line);
    }
  }
  return sections;
}

const pick = (random, n) => Math.min(n - 1, Math.floor(random() * n));

/**
 * SPCompatibleWord::Get [disasm 0x5ECBA0]: the type without its leading `\`; `m?` (any case) takes a section at random,
 * `\dms` among them, else the section of that name (any case); then one of its words at random (ssp.exe: MT19937 mod
 * n). null: no list, no such section, or a section without words (ssp.exe would divide by zero there).
 * @param {{name: string, words: string[]}[]|null} sections parseWordList's
 * @param {string} type `\ms`, `\m?`, `\dms` …
 * @param {() => number} [random]
 * @returns {string|null}
 */
export function pickWord(sections, type, random = Math.random) {
  if (!Array.isArray(sections) || !sections.length) return null;
  let t = String(type == null ? '' : type);
  if (t[0] === '\\') t = t.slice(1);
  const sec = fold(t) === 'm?' ? sections[pick(random, sections.length)] : findSection(sections, t);
  if (!sec || !sec.words.length) return null;
  return sec.words[pick(random, sec.words.length)];
}

/**
 * The site's word list (WORD_FILE under `base`), parsed. null without a fetch or a base, and when the file is missing
 * (logged) or unreadable (logged once).
 * @param {string} base the site's URL, '/'-ended
 * @param {Function|null} fetchFn
 * @returns {Promise<{name: string, words: string[]}[]|null>}
 */
export async function loadWordList(base, fetchFn) {
  if (typeof fetchFn !== 'function' || !base) return null;
  let url;
  try {
    url = new URL(WORD_FILE, base).href;
  } catch (e) {
    return null;
  }
  try {
    const r = await fetchFn(url, { credentials: 'same-origin' });
    if (!r || !r.ok) {
      log.info(`no word list at ${url} (${r ? r.status : 'no response'}): a %ms-style word no ghost answers stays as written`);
      return null;
    }
    return parseWordList(decodeText(await r.arrayBuffer()));
  } catch (e) {
    log.once('words:load', `the word list ${url} could not be read`, e);
    return null;
  }
}

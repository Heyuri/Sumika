// The ghost sweep's Kawari parts that need no engine (tools/sweep/ghost.mjs; kawari-wasm.md §6, §15): the worker's
// file plan for a Kawari ghost, Kawari's log lines without file and line, and how the resume check reads full
// dictionary dumps (_kawari_snapshot(path, 1), patch K12) and a stored snapshot, and sorts the entries that differ
// after a resume. tests/runtime/sweep_kawari.test.mjs checks them.
import * as engineFiles from '../../src/core/engine-files.js';

// Kawari's file plan (kawari-wasm.md §6): the page's patterns (engine-files.js KAWARI_TEXT / KAWARI_SKIP) once it has
// them, else this rule [decision]: text = index_site.py KAWARI_PACK_EXT; skipped: the personal set
// (profile/, *_variable.*, satori_save*, *.log) and DLLs/EXEs
export const KAWARI_TEXT = engineFiles.KAWARI_TEXT || /\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u|kis|kaw)$/i;
export const KAWARI_SKIP = engineFiles.KAWARI_SKIP
  || /(^|\/)profile\/|(^|\/)[^/]*_variable\.[^/]*$|(^|\/)satori_save[^/]*$|\.log$|\.(dll|exe)$/i;

/**
 * The worker's files for a Kawari ghost: yayaFilePlan's rule (text up to the pack's cap with bytes, everything else an
 * empty placeholder) with Kawari's text and skip patterns; Kawari 7's text pattern (engine-files.js KAWARI7_TEXT) with
 * `text`.
 * @param {{files: {path: string, size?: number}[]}} files the ghost root's GhostFiles
 * @param {RegExp} [text]
 * @returns {{bytes: string[], placeholders: string[]}} ghost-root-relative paths, in manifest order
 */
export function kawariFilePlan(files, text = KAWARI_TEXT) {
  const bytes = [];
  const placeholders = [];
  for (const f of (files && files.files) || []) {
    const p = f && f.path;
    if (!p || KAWARI_SKIP.test(p)) continue;
    if (text.test(p) && !(f.size > engineFiles.YAYA_MAX_BYTES)) bytes.push(p);
    else placeholders.push(p);
  }
  return { bytes, placeholders };
}

/**
 * One of Kawari's log lines as the sweep keeps it: without the lexer's '<file> <line>: error: ' / ': warning: '
 * (kawari_lexer.h; the kind is kept beside it), and with the ghost's MEMFS folder as `<id>`, so the same line in two
 * files, or two ghosts, is one key.
 */
export function kawariLogText(text) {
  return String(text).replace(/^.*? \d+: (error|warning): /, '').replace(/\/ssp\/ghost\/[^/]+\//g, '/ssp/ghost/<id>/');
}

/**
 * Adjacent string literals joined: `"a""b"` (a word whose code is a list of strings) compiles back into `"ab"`, the
 * same text when run. A `""` after an even number of backslashes is a boundary (`\\""`: an escaped backslash, then
 * the boundary); after an odd number it is an escaped quote and a closing one.
 */
export const joinLiterals = s => s.replace(/((?:^|[^\\])(?:\\\\)*)""/g, '$1');

/**
 * A full dump (`_kawari_snapshot(path, 1)`, decoded) as entry name -> its words in `save`'s format, adjacent literals
 * joined; an entry under a `# move N NAME` line (a name the dictionary syntax cannot read back) under NAME. The dump
 * leaves out System.Request*, System.Response* and write-protected entries (em_kawari.cpp).
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseKawariDump(text) {
  const lines = String(text).split('\n').map(l => l.replace(/\r$/, ''));
  const moved = new Map();
  for (const l of lines) {
    const m = /^# move (\d+) (.*)$/.exec(l);
    if (m) moved.set(`System.Sumika.Snapshot.${m[1]}`, m[2]);
  }
  const out = new Map();
  for (const l of lines) {
    const i = l.indexOf(' : ');
    if (!l || l.startsWith('#') || i < 0) continue;
    const name = l.slice(0, i);
    out.set(moved.get(name) || name, joinLiterals(l.slice(i + 3)));
  }
  return out;
}

const sjis = new TextDecoder('shift_jis');

/**
 * The entries a stored snapshot covers: its `# clear NAME` lines (every entry it writes, and those the session
 * emptied). The bytes are code page 932, as Kawari writes them.
 * @param {ArrayBuffer|Uint8Array|null} bytes
 * @returns {Set<string>}
 */
export function snapshotNames(bytes) {
  const out = new Set();
  if (!bytes || !bytes.byteLength) return out;
  for (const l of sjis.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).split('\n')) {
    if (l.startsWith('# clear ')) out.add(l.slice(8).replace(/\r$/, ''));
  }
  return out;
}

/** a Kawari 7 snapshot line's text (em_kawari7.cpp em_escape: `\\`, `\n`, `\r`) */
const k7Unescape = s => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));

/**
 * A Kawari 7 full dump (_kawari7_dump) or snapshot (_kawari7_snapshot): `K7SNAP 1`, then `E name` with its `W word`
 * lines and `C name` for an emptied entry, code page 932; any other line (the adapter's `# dicStamp`) skipped. As
 * name -> its words (adjacent literals joined, as parseKawariDump) joined by a newline ('' for C).
 * @param {string} text the decoded file
 * @returns {Map<string, string>}
 */
export function parseK7Dump(text) {
  const out = new Map();
  let entry = null;
  for (const l of String(text).split('\n')) {
    if (l.startsWith('E ')) { entry = k7Unescape(l.slice(2)); out.set(entry, null); }
    else if (l.startsWith('C ')) { entry = null; out.set(k7Unescape(l.slice(2)), ''); }
    else if (l.startsWith('W ') && entry !== null) {
      const w = joinLiterals(k7Unescape(l.slice(2)));      // as Phase 8's: adjacent literals joined
      out.set(entry, out.get(entry) === null ? w : `${out.get(entry)}\n${w}`);
    }
  }
  for (const [k, v] of out) if (v === null) out.set(k, '');
  return out;
}

/** The entries a stored Kawari 7 snapshot covers (its E and C lines), as snapshotNames for Phase 8. */
export function k7SnapshotNames(bytes) {
  if (!bytes || !bytes.byteLength) return new Set();
  return new Set(parseK7Dump(sjis.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))).keys());
}

/**
 * The entries whose words differ between the page that saved (`before`) and the engine the next page resumed from its
 * store (`after`), sorted: `changed`, in the snapshot (`names`): it did not come back as saved; `missed`, the session
 * changed it (`before` differs from `base`, the dump right after that page's load) but the snapshot does not carry it;
 * `loadSet`, the session left it as load made it, and the next load makes it otherwise (clock, random, the session's
 * own save files). An entry absent from a dump compares as undefined.
 * @param {{base: Map<string,string>, before: Map<string,string>, after: Map<string,string>, names: Set<string>}} o
 * @returns {{changed: string[], missed: string[], loadSet: string[]}}
 */
export function classifyResume({ base, before, after, names }) {
  const differ = [...new Set([...before.keys(), ...after.keys()])].filter(n => before.get(n) !== after.get(n));
  return {
    changed: differ.filter(n => names.has(n)),
    missed: differ.filter(n => !names.has(n) && before.get(n) !== base.get(n)),
    loadSet: differ.filter(n => !names.has(n) && before.get(n) === base.get(n)),
  };
}

/**
 * D6's outcome in the resume check (kawari-wasm.md §16 [decision]): a cold boot from the store of a
 * session that ended without an unload. `nothing to finish`: no snapshot, so D6 did not run (it must not); `failed`:
 * the boot failed, D6 did not run when it had to (or ran when it had not), or its close and unload wrote other files
 * than the session's own end writes; `no effect`: it ran, but the session's own end (ssp.exe's close from outside,
 * then its unload) writes no file (a ghost that saves nothing when it closes, as in SSP: somberlain, maria_re), so the
 * session is lost and the snapshot is dropped; `ok`: it ran and the ghost's own save holds the session.
 * @param {{booted: boolean, finish: boolean, resumed: string, saves: string[], differ: string[]}} o finish: the store
 *   held a snapshot; saves: the files the session's own close from outside and unload write; differ: those D6 wrote
 *   otherwise
 * @returns {'ok'|'no effect'|'nothing to finish'|'failed'}
 */
export function d6Outcome({ booted, finish, resumed, saves, differ }) {
  if (!booted || resumed !== (finish ? 'finished' : '')) return 'failed';
  if (!finish) return 'nothing to finish';
  if (differ.length) return 'failed';
  return saves.length ? 'ok' : 'no effect';
}

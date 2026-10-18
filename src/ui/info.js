// Information ▸'s window (ssp-ui.md §2.11): SSP's "About this character" (DIALOG 109: author, URL, the readme text,
// switchable to the shell's and the balloon's readme), the ghost's terms of use, and About Sumika in the same window.
// Readmes are not in the text pack (index_site.py PACK_SKIP): they are fetched when the window shows them. The chrome
// follows the UI language (core/i18n.js); the readme text and the author's name are the ghost's and stay as written.
import { log } from '../core/log.js';
import { decodeText } from '../core/loader.js';
import { getRoot, addStyle, Z_BASE } from './root.js';
import { t } from '../core/i18n.js';

/**
 * SSP's readme names, in its lookup order after the descript's `readme` key [disasm SPProp::GetReadmePath]; the
 * `ghost/master/…` ones only for a ghost. Shells and balloons use the same list in their own folder [guess].
 */
export const README_NAMES = Object.freeze([
  ['readme.md'], ['read me.md'], ['readme.markdown'], ['ghost/master/readme.md', true], ['readme.rtf'], ['read me.rtf'],
  ['readme.txt'], ['readme.1st'], ['read me.txt'], ['readme'], ['お読みください.txt'], ['はじめにお読みください.txt'],
  ['ghost/master/readme.txt', true],
]);
/** the terms files SSP looks for in the ghost's root [disasm SPProp::GetTermsPath] */
export const TERMS_NAMES = Object.freeze(['terms.md', 'terms.markdown', 'terms.rtf', 'terms.txt']);

const toMap = d => (d instanceof Map ? d : new Map(Object.entries(d || {}).map(([k, v]) => [k.toLowerCase(), v])));
const nonEmpty = v => (v == null || String(v).trim() === '' ? null : String(v).trim());

/**
 * The readme of a folder (UI §2.11): the descript's `readme` key when that file exists, else the first of
 * README_NAMES there. Returns the file's real path in `files`, or null.
 * @param {object} files GhostFiles of the folder (has(), resolve())
 * @param {Map|object|null} descript the folder's descript (a ghost's: ghost/master/descript.txt; paths are from the root)
 * @param {{ghost?: boolean}} [o] a ghost's root: also ghost/master/readme.{md,txt}
 */
export function findReadme(files, descript, { ghost = false } = {}) {
  if (!files || typeof files.has !== 'function') return null;
  const names = [];
  const key = nonEmpty(toMap(descript).get('readme'));
  if (key) names.push(key);
  for (const [name, ghostOnly] of README_NAMES) if (ghost || !ghostOnly) names.push(name);
  for (const n of names) {
    if (!files.has(n)) continue;
    return typeof files.resolve === 'function' ? files.resolve(n) : n;
  }
  return null;
}

/** The ghost's terms of use (terms.md, terms.markdown, terms.rtf, terms.txt in its root), or null. */
export function findTerms(files) {
  if (!files || typeof files.has !== 'function') return null;
  for (const n of TERMS_NAMES) if (files.has(n)) return typeof files.resolve === 'function' ? files.resolve(n) : n;
  return null;
}

const SJIS_LEAD = b => (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
// destinations whose text is not shown (font and colour tables, document info, pictures, fields' instructions …)
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl',
  'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
  'xmlnstbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'pgdsctbl', 'fldinst', 'filetbl',
  'revtbl', 'mmathPr', 'operator', 'author', 'title', 'subject', 'keywords', 'comment', 'doccomm']);
const RTF_TEXT = { par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', cell: '\t', tab: '\t', emdash: '—',
  endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ' };

/**
 * RTF as plain text (UI §2.11 [decision]: a readme.rtf is shown as text): groups of the RTF_SKIP destinations and `\*`
 * ones are dropped, control words removed, `\par` / `\line` become newlines, `\'hh` bytes are decoded as CP932 (a
 * lead byte may be followed by a literal trail character), `\uN` as UTF-16 with its `\ucN` fallback skipped. Not RTF:
 * returned as is.
 * @param {string} s
 */
export function rtfToText(s) {
  const src = String(s ?? '');
  if (!/^\s*\{\\rtf/.test(src)) return src;
  let out = '';
  const bytes = [];
  let needTrail = false;
  const flush = () => {
    if (!bytes.length) return;
    out += new TextDecoder('shift_jis').decode(new Uint8Array(bytes));
    bytes.length = 0;
    needTrail = false;
  };
  const stack = [];
  let skip = false;
  let uc = 1;
  let fallback = 0;               // characters still to skip after a \uN
  const emit = str => { if (fallback > 0) { fallback--; return; } flush(); if (!skip) out += str; };
  const byte = b => {
    if (fallback > 0) { fallback--; return; }
    if (skip) return;
    if (needTrail) { bytes.push(b); needTrail = false; return; }
    bytes.push(b);
    needTrail = SJIS_LEAD(b);
    if (!needTrail) flush();
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') { flush(); stack.push({ skip, uc }); i++; continue; }
    if (c === '}') { flush(); const st = stack.pop(); if (st) { skip = st.skip; uc = st.uc; } fallback = 0; i++; continue; }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (c !== '\\') {
      if (needTrail && !skip && fallback === 0) { byte(c.charCodeAt(0) & 0xff); i++; continue; }   // "\'83A"
      emit(c);
      i++;
      continue;
    }
    const n = src[i + 1];
    if (n === undefined) { i++; continue; }
    if (n === '\\' || n === '{' || n === '}') {
      if (needTrail && !skip && fallback === 0) byte(n.charCodeAt(0));
      else emit(n);
      i += 2;
      continue;
    }
    if (n === "'") {
      const h = parseInt(src.slice(i + 2, i + 4), 16);
      if (Number.isFinite(h)) byte(h);
      i += 4;
      continue;
    }
    if (n === '*') { skip = true; i += 2; continue; }
    if (n === '~') { emit(' '); i += 2; continue; }
    if (n === '_') { emit('-'); i += 2; continue; }
    if (n === '-') { i += 2; continue; }
    if (n === '\r' || n === '\n') { emit('\n'); i += 2; continue; }
    const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 64));
    if (!m) { i += 2; continue; }
    i += 1 + m[0].length;
    const word = m[1];
    const num = m[2] === undefined ? null : Number(m[2]);
    if (RTF_SKIP.has(word)) { flush(); skip = true; continue; }
    if (word === 'uc') { uc = num ?? 1; continue; }
    if (word === 'u' && num !== null) {
      flush();
      if (!skip) out += String.fromCharCode(num < 0 ? num + 65536 : num);
      fallback = uc;
      continue;
    }
    if (RTF_TEXT[word] !== undefined) emit(RTF_TEXT[word]);
  }
  flush();
  return out.replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '');
}

/**
 * The text of a readme (or terms) file: the descript's `readme.charset` (UTF-8 / Shift_JIS) when it names one, else
 * decodeText (BOM, a `charset,` line, else CP932); RTF shown as text, Markdown as is [decision]; '\n' line ends.
 * @param {object} files GhostFiles (bytes())
 * @param {string} path
 * @param {Map|object|null} [descript]
 */
export async function readmeText(files, path, descript = null) {
  const buf = await files.bytes(path);
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const cs = String(toMap(descript).get('readme.charset') || '').trim().toLowerCase().replace(/[-_\s]/g, '');
  let text;
  if (cs === 'utf8') text = new TextDecoder('utf-8').decode(u8);
  else if (['shiftjis', 'sjis', 'cp932', 'windows31j', 'ms932', 'xsjis'].includes(cs)) text = new TextDecoder('shift_jis').decode(u8);
  else text = decodeText(u8);
  if (/\.rtf$/i.test(path) || /^\s*\{\\rtf/.test(text)) text = rtfToText(text);
  return text.replace(/\r\n?/g, '\n');
}

const authorOf = d => nonEmpty(d.get('craftmanw')) ?? nonEmpty(d.get('craftman'));

/**
 * The readme window's sources (UI §2.11): each of the ghost, the current shell and the current balloon that has a
 * readme, in that order, with its descript's author (`craftmanw`, else `craftman`) and `craftmanurl`.
 * @param {{kind:'ghost'|'shell'|'balloon', name?, files, descript}[]} sources
 */
export function readmeSources(sources) {
  const out = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || !s.files) continue;
    const path = findReadme(s.files, s.descript, { ghost: s.kind === 'ghost' });
    if (!path) continue;
    const d = toMap(s.descript);
    out.push({ kind: s.kind, name: s.name ?? null, path, author: authorOf(d), url: nonEmpty(d.get('craftmanurl')),
      load: () => readmeText(s.files, path, s.descript) });
  }
  return out;
}

/** What Information ▸ can show: {readme: any source has a readme, terms: the ghost has terms}. */
export function infoFlags(data) {
  const sources = data && Array.isArray(data.sources) ? data.sources : [];
  const ghost = sources.find(s => s && s.kind === 'ghost');
  return { readme: readmeSources(sources).length > 0, terms: !!(ghost && findTerms(ghost.files)) };
}

/** About this ghost: SSP's DIALOG 109 title, one source per readme (null: none). */
export function readmeContent(sources) {
  const list = readmeSources(sources);
  return list.length ? { title: lang => t('info.readme', lang), sources: list } : null;
}

/** Terms of this ghost: DIALOG 175's title with the file name [guess], the file's text (null: no terms). */
export function termsContent(sources) {
  const ghost = (Array.isArray(sources) ? sources : []).find(s => s && s.kind === 'ghost');
  const path = ghost && findTerms(ghost.files);
  if (!path) return null;
  const file = path.split('/').pop();
  return { title: lang => t('info.terms', lang, { file }), load: () => readmeText(ghost.files, path, null) };
}

/** an engine as the About text names it: 'Satori (BSD-2-Clause, ukatech/satoriya-shiori; MT19937 (BSD-3-Clause),
 *  DEELX)', the code compiled into it (`parts`) after the semicolon */
export function engineLabel(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  const extra = [[e.license, e.source].filter(Boolean).join(', '),
    (Array.isArray(e.parts) ? e.parts : []).filter(Boolean).join(', ')].filter(Boolean).join('; ');
  return extra ? `${e.name} (${extra})` : String(e.name || '');
}

// what each wasm compiles in, in the order of the notices: docs/licenses.md, sumika/engines/satori.LICENSES.txt,
// yaya.LICENSES.txt (yaya-wasm.md §2), kawari.LICENSES.txt (kawari-wasm.md §2: Kawari's license.txt, a modified
// BSD; shiori.h says public domain) and kawari7.LICENSES.txt (kawari7-wasm.md §1); the MD5 code asks to be named as
// RSA's
const DEFAULT_ENGINES = [
  { name: 'Satori', license: 'BSD-2-Clause', source: 'ukatech/satoriya-shiori', parts: ['MT19937 (BSD-3-Clause)', 'DEELX'] },
  { name: 'YAYA', license: 'BSD-3-Clause', source: 'YAYA-shiori/yaya-shiori',
    parts: ['MT19937 (BSD-3-Clause)', 'the RSA Data Security, Inc. MD5 Message-Digest Algorithm', 'CRC-32 (zlib)',
      'parson (MIT)', 'TinyXML-2 (zlib)', 'Gumbo (Apache-2.0) with Bjoern Hoehrmann\'s UTF-8 decoder (MIT)', 'DEELX',
      'SQLite (public domain)'] },
  { name: 'Kawari', license: 'modified BSD', source: 'sourceforge.net/projects/kawari', parts: ['MT19937 (BSD-3-Clause)'] },
  { name: 'Kawari 7', license: 'modified BSD', source: 'sourceforge.net/projects/kawari', parts: ['MT19937 (BSD-3-Clause)'] },
];

// the MIDI player: what the MIDI bundle compiles in and the sound bank, in the order of
// sumika/engines/midi.LICENSES.txt, at the versions engines/midi/pins.json pins (tests/runtime/info.test.mjs compares)
const DEFAULT_MIDI = {
  synth: { name: 'SpessaSynth core 4.3.22', license: 'Apache-2.0', source: 'spessasus/spessasynth_core',
    parts: ['fflate (MIT)', 'stb_vorbis (MIT or public domain)', 'Dattorro reverb (public domain)'] },
  bank: { name: 'GeneralUser GS 2.0.3', license: 'GeneralUser GS License v2.0', source: 'S. Christian Collins' },
};

/** Who develops Sumika (a name: the same in both languages). */
export const DEVELOPER = 'Heyuri Applicable Research & Development';

/**
 * About Sumika (ours, in SSP's About SSP slot): name, version, its developer, one line on what it is, the SHIORI
 * engines, then the MIDI player and its sound bank (midi: {synth, bank} labels as engineLabel takes them; null leaves
 * both lines out).
 */
export function aboutContent({ version = null, engines = null, midi = DEFAULT_MIDI } = {}) {
  const list = Array.isArray(engines) && engines.length ? engines : DEFAULT_ENGINES;
  return {
    title: lang => t('info.about', lang),
    uiText: true,
    text: lang => [
      version ? `Sumika  ${t('info.version', lang, { v: version })}` : 'Sumika',
      t('info.developer', lang, { name: DEVELOPER }),
      '',
      t('info.aboutText', lang),
      '',
      ...list.map(e => t('info.engine', lang, { name: engineLabel(e) })),
      ...(midi && midi.synth ? [t('info.midi', lang, { name: engineLabel(midi.synth) })] : []),
      ...(midi && midi.bank ? [t('info.bank', lang, { name: engineLabel(midi.bank) })] : []),
    ].join('\n'),
  };
}

const httpUrl = u => (u && /^https?:\/\/[^\s/?#]+/i.test(u) ? u : null);

/**
 * The window's words for one state, without a DOM (UI §2.11).
 * content: {title, author?, url?, text?, load?, uiText?, sources?}; title and text may be functions of the language;
 * author/url present (even null) → the Author / URL rows, '(N/A)' when missing; sources (readmeSources) → the
 * selected one supplies author, url and text, and a switcher shows when there are two or more.
 * @param {object} content
 * @param {string} [lang] UI language
 * @param {number} [selected] index into sources
 * @param {string|null} [loaded] the selected source's text once loaded (load())
 */
export function infoView(content, lang = 'en', selected = 0, loaded = null) {
  const c = content || {};
  const sources = Array.isArray(c.sources) ? c.sources.filter(Boolean) : [];
  const i = sources.length ? Math.max(0, Math.min(sources.length - 1, selected | 0)) : 0;
  const src = sources.length ? sources[i] : c;
  const val = v => (typeof v === 'function' ? v(lang) : v);
  const fields = [];
  if ('author' in src || 'url' in src) {
    const author = nonEmpty(src.author);
    const url = nonEmpty(src.url);
    fields.push({ key: 'author', label: t('info.author', lang), value: author ?? t('info.none', lang), na: author === null });
    fields.push({ key: 'url', label: t('info.url', lang), value: url ?? t('info.none', lang), na: url === null, href: httpUrl(url) });
  }
  const text = src.text !== undefined ? val(src.text) : loaded;
  return {
    title: String(val(c.title) ?? ''),
    fields,
    switcher: sources.length > 1 ? sources.map((s, n) => ({ kind: s.kind, label: t(`info.source.${s.kind}`, lang), selected: n === i })) : [],
    selected: i,
    text: text == null ? null : String(text),
    textLang: src.uiText || c.uiText ? lang : '',
    ok: t('info.ok', lang),
    close: t('info.close', lang),
  };
}

// max-height in 100dvh after 100vh (F3, ssp-ui.md §9.11): a phone's visible height with or without its browser bars;
// on desktop dvh = vh, and a browser without dvh keeps the vh line
const CSS = `
.smk-info { position: fixed; z-index: ${Z_BASE + 200}; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(560px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 32px));
  max-height: min(640px, calc(100dvh - 32px)); display: flex; flex-direction: column;
  box-sizing: border-box; margin: 0; padding: 0; color: #1f2328; background: #ffffff; border: 1px solid rgba(0,0,0,.18);
  border-radius: 6px; box-shadow: 0 10px 32px rgba(0,0,0,.28); pointer-events: auto; outline: none;
  font: 13px/1.5 "Segoe UI", "Yu Gothic UI", "Meiryo UI", system-ui, sans-serif; }
.smk-info:lang(ja) { font-family: "Yu Gothic UI", "Meiryo UI", "Segoe UI", "Hiragino Sans", system-ui, sans-serif; }
.smk-info .smk-info-head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 4px 16px; }
.smk-info .smk-info-title { flex: 1; margin: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.smk-info button { font: inherit; color: inherit; cursor: pointer; }
.smk-info .smk-info-x { flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; background: transparent;
  font-size: 18px; line-height: 1; color: #57606a; }
.smk-info .smk-info-x:hover { background: rgba(0,0,0,.06); color: #1f2328; }
.smk-info .smk-info-fields { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 8px; margin: 0; padding: 0 16px 8px; }
.smk-info .smk-info-fields dt { color: #57606a; }
.smk-info .smk-info-fields dd { margin: 0; overflow-wrap: anywhere; }
.smk-info .smk-info-fields a { color: #0b57d0; }
.smk-info .smk-info-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 16px 8px; }
.smk-info .smk-info-tabs button { padding: 2px 10px; border: 1px solid rgba(0,0,0,.18); border-radius: 12px; background: #f6f8fa; }
.smk-info .smk-info-tabs button[aria-pressed="true"] { background: #2f6fd0; border-color: #2f6fd0; color: #ffffff; }
.smk-info .smk-info-text { flex: 1 1 auto; min-height: 96px; overflow: auto; margin: 0 16px; padding: 8px 10px;
  white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid rgba(0,0,0,.15); border-radius: 4px; background: #fafbfc;
  font: inherit; line-height: 1.6; }
.smk-info .smk-info-foot { display: flex; justify-content: flex-end; padding: 10px 16px 12px; }
.smk-info .smk-info-ok { min-width: 80px; padding: 4px 16px; border: 1px solid rgba(0,0,0,.25); border-radius: 4px; background: #f6f8fa; }
.smk-info .smk-info-ok:hover { background: #eef1f4; }
.smk-info :focus-visible { outline: 2px solid #2f6fd0; outline-offset: 1px; }
`;

/**
 * The window (UI §2.11). One at a time: opening another replaces what it shows. Esc, OK and × close it and the focus
 * goes back where it was; Tab stays inside. Labels follow a language change while it is open.
 */
export class InfoWindow {
  /** @param {{language?: object}} [o] core/language.js UiLanguage; none: English */
  constructor({ language = null } = {}) {
    this.language = language && typeof language.on === 'function' ? language : null;
    this.el = null;
    this.content = null;
    this.selected = 0;
    this.prevFocus = null;
    this._texts = new Map();      // source index -> loaded text ('' on failure)
    this._token = 0;
    this._offLang = this.language ? this.language.on('change', () => { if (this.el) this._draw(); }) : null;
  }

  get lang() { return this.language ? this.language.lang : 'en'; }

  get isOpen() { return !!this.el; }

  /** the state the window shows (infoView) */
  view() { return infoView(this.content, this.lang, this.selected, this._texts.get(this.selected) ?? null); }

  /** @param {object} content see infoView */
  open(content) {
    if (!content) return;
    const back = this.el ? this.prevFocus : (typeof document !== 'undefined' ? document.activeElement : null);
    this._remove();
    this.content = content;
    this.selected = 0;
    this._texts = new Map();
    this._token++;
    this.prevFocus = back;
    if (typeof document === 'undefined') { this._load(); return; }
    addStyle('info', CSS);
    const el = document.createElement('div');
    el.className = 'smk-info';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'false');
    el.tabIndex = -1;
    el.addEventListener('keydown', ev => this._onKey(ev));   // keys inside the runtime's root never reach the ghost
    getRoot().appendChild(el);
    this.el = el;
    this._draw();
    this._load();
    const ok = el.querySelector('.smk-info-ok');
    try { (ok || el).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  /** Fetch the selected source's text once (readmes are not in the pack). */
  _load() {
    const v = this.content;
    const sources = v && Array.isArray(v.sources) ? v.sources : null;
    const i = this.selected;
    const src = sources ? sources[i] : v;
    if (!src || src.text !== undefined || typeof src.load !== 'function' || this._texts.has(i)) return;
    const token = this._token;
    this._texts.set(i, null);
    Promise.resolve().then(() => src.load()).then(text => String(text ?? ''), e => { log.warn('info: readme failed', e); return ''; })
      .then(text => {
        if (token !== this._token) return;
        this._texts.set(i, text);
        if (this.el && this.selected === i) this._drawText();
      });
  }

  select(i) {
    this.selected = i | 0;
    if (this.el) this._draw();
    this._load();
  }

  _draw() {
    const el = this.el;
    if (!el) return;
    const v = this.view();
    const lang = this.lang;
    const focused = el.contains(getRoot().activeElement) ? getRoot().activeElement.dataset.focusKey || null : null;
    el.textContent = '';
    el.setAttribute('lang', lang);
    const head = document.createElement('div');
    head.className = 'smk-info-head';
    const title = document.createElement('h2');
    title.className = 'smk-info-title';
    title.id = 'smk-info-title';
    title.textContent = v.title;
    el.setAttribute('aria-labelledby', title.id);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'smk-info-x';
    x.textContent = '×';
    x.dataset.focusKey = 'x';
    x.setAttribute('aria-label', v.close);
    x.title = v.close;
    x.addEventListener('click', () => this.close());
    head.append(title, x);
    el.appendChild(head);
    if (v.fields.length) {
      const dl = document.createElement('dl');
      dl.className = 'smk-info-fields';
      for (const f of v.fields) {
        const dt = document.createElement('dt');
        dt.textContent = f.label;
        const dd = document.createElement('dd');
        dd.setAttribute('lang', f.na ? lang : '');       // the author's name and URL are the ghost's
        if (f.href) {
          const a = document.createElement('a');
          a.href = f.href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = f.value;
          a.dataset.focusKey = 'url';
          dd.appendChild(a);
        } else {
          dd.textContent = f.value;
        }
        dl.append(dt, dd);
      }
      el.appendChild(dl);
    }
    if (v.switcher.length) {
      const tabs = document.createElement('div');
      tabs.className = 'smk-info-tabs';
      tabs.setAttribute('role', 'group');
      v.switcher.forEach((s, n) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = s.label;
        b.dataset.focusKey = `tab${n}`;
        b.setAttribute('aria-pressed', s.selected ? 'true' : 'false');
        b.addEventListener('click', () => { if (this.selected !== n) this.select(n); });
        tabs.appendChild(b);
      });
      el.appendChild(tabs);
    }
    const text = document.createElement('div');
    text.className = 'smk-info-text';
    text.tabIndex = 0;
    text.dataset.focusKey = 'text';
    text.setAttribute('role', 'document');
    el.appendChild(text);
    const foot = document.createElement('div');
    foot.className = 'smk-info-foot';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'smk-info-ok';
    ok.textContent = v.ok;
    ok.dataset.focusKey = 'ok';
    ok.addEventListener('click', () => this.close());
    foot.appendChild(ok);
    el.appendChild(foot);
    this._drawText(v);
    if (focused) {
      const again = el.querySelector(`[data-focus-key="${focused}"]`);
      if (again) try { again.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  _drawText(v = this.view()) {
    const box = this.el && this.el.querySelector('.smk-info-text');
    if (!box) return;
    box.setAttribute('lang', v.textLang);                // a readme's language is unknown: lang=""
    box.setAttribute('aria-busy', v.text === null ? 'true' : 'false');
    box.textContent = v.text ?? '';
    box.scrollTop = 0;
  }

  _onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.close(); return; }
    if (ev.key === 'Tab') {
      const list = [...this.el.querySelectorAll('button, a[href], [tabindex="0"]')];
      if (!list.length) return;
      const active = getRoot().activeElement;
      const i = list.indexOf(active);
      const next = ev.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i < 0 || i === list.length - 1 ? 0 : i + 1);
      ev.preventDefault();
      list[next].focus({ preventScroll: true });
    }
  }

  _remove() {
    if (this.el) this.el.remove();
    this.el = null;
  }

  close({ restoreFocus = true } = {}) {
    const had = !!this.el;
    this._remove();
    this._token++;
    this.content = null;
    this._texts = new Map();
    if (had && restoreFocus && this.prevFocus && typeof this.prevFocus.focus === 'function') {
      try { this.prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    this.prevFocus = null;
  }

  destroy() {
    this.close({ restoreFocus: false });
    if (this._offLang) this._offLang();
    this._offLang = null;
  }
}

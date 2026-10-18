// Text metrics shared by the balloon layout engine and painter (pure, no DOM).
// SSP draws balloon text with GDI and "ＭＳ ゴシック"; ghosts tune their layouts to its advance widths (BA §3.2),
// so we emulate them whatever font the browser actually renders with.

/** Gap below the text inside a line: LH(h) = h + LINE_GAP (BA §3.2; measured at h = 12, a guess elsewhere). */
export const LINE_GAP = 2;

/** Line height of text at font height h. */
export function lineHeight(h) {
  return h + LINE_GAP;
}

/**
 * Advance width class of a code point under CP932/MS Gothic rules.
 * @returns {1|2|0} 1 = single-byte (half width), 2 = double-byte (full width), 0 = not in CP932 (measure it)
 */
export function widthClass(cp) {
  if (cp < 0x80) return 1;
  if (cp >= 0xff61 && cp <= 0xff9f) return 1; // half-width katakana
  if (cp === 0xa5 || cp === 0x203e) return 1; // yen / overline: single bytes 0x5C / 0x7E in Shift_JIS
  if (cp >= 0x2000 && cp <= 0xffff) return 2; // punctuation, arrows, symbols, kana, CJK, full-width forms
  if (cp === 0xa7 || cp === 0xa8 || cp === 0xb0 || cp === 0xb1 || cp === 0xb4 || cp === 0xb6 || cp === 0xd7 || cp === 0xf7) return 2;
  if ((cp >= 0x391 && cp <= 0x3c9) || cp === 0x401 || cp === 0x451 || (cp >= 0x410 && cp <= 0x44f)) return 2; // Greek, Cyrillic
  return 0;
}

/**
 * Emulated advance of one code point at font height h (BA §3.2).
 * @param {number} cp
 * @param {number} h
 * @param {((ch:string)=>number)|null} [measure] width of a character outside CP932 in the real font
 */
export function advance(cp, h, measure) {
  const c = widthClass(cp);
  if (c === 2) return h;
  if (c === 1) return Math.floor(h / 2 + 0.5);
  if (measure) {
    const w = measure(String.fromCodePoint(cp));
    if (w > 0 && Number.isFinite(w)) return Math.round(w);
  }
  return cp > 0xffff ? h : Math.floor(h / 2 + 0.5);
}

/** Blank glyphs move the pen but do not open a balloon (SUM C14). */
export function isBlank(cp) {
  return cp === 0x20 || cp === 0x3000 || cp === 0x09;
}

/**
 * Characters that make up words for word wrapping (BA §3.5): every non-blank character that is not CJK, so letters,
 * digits and the punctuation attached to them (apostrophes, commas, full stops, hyphens, quotes, brackets).
 * CJK = what CP932 draws double-byte (kana, kanji, full-width forms, CJK punctuation, symbols such as … ― ♪ ※)
 * plus half-width katakana: such text keeps the per-character rule with kinsoku. Greek and Cyrillic letters and
 * the curly quotes ‘ ’ “ ” are double-byte in CP932 but belong to words.
 */
export function isWordChar(cp) {
  if (cp <= 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) return false; // blanks and control characters
  if (cp >= 0xff61 && cp <= 0xff9f) return false; // half-width katakana
  if (cp >= 0x20000 && cp <= 0x3ffff) return false; // CJK extension ideographs (outside CP932)
  if (widthClass(cp) !== 2) return true;
  return (cp >= 0x391 && cp <= 0x3c9) || cp === 0x401 || cp === 0x451 || (cp >= 0x410 && cp <= 0x44f) ||
    (cp >= 0x2018 && cp <= 0x201f);
}

// Kinsoku tables from the ssp.exe 2.9.08f string table (BA §3.5).
const toSet = s => new Set(Array.from(s, c => c.codePointAt(0)));
/** Characters that cannot start a line: they hang past the wrap point instead. */
export const KINSOKU_START = toSet('。、．，！？♪.,!?・」』）】｝］≫)}]〟’”\'"ヽヾ～ーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ々');
/** Characters that cannot end a line: pulled to the next line when they would overflow. */
export const KINSOKU_END = toSet('「『（【｛［≪({[');

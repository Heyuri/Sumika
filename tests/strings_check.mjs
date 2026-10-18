// The bilingual table check (ssp-ui.md §2.10), shared by the runtime's tests/runtime/i18n.test.mjs (src/core/i18n.js
// STRINGS) and the admin page's tests/admin/strings.test.mjs (admin/page/strings.js STRINGS): the
// same keys in English and Japanese, the same {parameters}, no empty text, every Japanese text translated unless the
// table says it is the same in both, and no English left in it (two or more Latin letters after its parameters,
// access keys and proper nouns are taken out), with some Japanese in it. Not a test file itself.
import assert from 'node:assert/strict';

/** A string's {parameters}, sorted. */
export const paramsOf = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

/**
 * @param {{en: object, ja: object}} strings
 * @param {{sameInJa?: readonly string[], properNouns?: readonly string[], mnemonic?: RegExp|null}} [o]
 *   sameInJa: keys whose text is the same in both languages; properNouns: names that stay in Latin letters in Japanese
 *   text; mnemonic: the Japanese access-key pattern to take out first ('(&X)'; null for a table without access keys)
 */
export function checkStringTables(strings, { sameInJa = [], properNouns = [], mnemonic = null } = {}) {
  const en = Object.keys(strings.en).sort();
  assert.deepEqual(Object.keys(strings.ja).sort(), en, 'the same keys');
  for (const k of en) {
    assert.deepEqual(paramsOf(strings.ja[k]), paramsOf(strings.en[k]), `${k}: parameters`);
    assert.ok(strings.en[k].trim() && strings.ja[k].trim(), `${k}: not empty`);
    if (sameInJa.includes(k)) continue;
    assert.notEqual(strings.ja[k], strings.en[k], `${k}: translated`);
    // what is left of the Japanese string without parameters, access keys and names that stay in Latin letters
    // ("Sumikaについて", "AIグラフ", "URL：") must not be English words
    let rest = strings.ja[k].replace(/\{\w+\}/g, '');
    if (mnemonic) rest = rest.replace(mnemonic, '');
    for (const n of properNouns) rest = rest.split(n).join('');
    assert.doesNotMatch(rest, /[A-Za-z]{2,}/, `${k}: "${strings.ja[k]}" has English in it`);
    assert.match(rest, /[^\x00-\x7f]/, `${k}: Japanese text`);
  }
  for (const k of sameInJa) assert.ok(k in strings.en, k);
}

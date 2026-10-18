// src/ui/info.js (ssp-ui.md §2.11): Information ▸'s window: readme and terms lookup, text decoding, RTF as text, and
// the window's words in both UI languages (the DOM part is checked in the browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  findReadme, findTerms, rtfToText, readmeText, readmeSources, readmeContent, termsContent, aboutContent, infoFlags, infoView,
  engineLabel, InfoWindow,
} from '../../src/ui/info.js';
import { UiLanguage } from '../../src/core/language.js';
import { memoryStorage, runtimePrefs } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('silent');

/** The MIDI player's pinned versions (engines/midi/pins.json): About must name these, so a bump that misses it fails. */
const MIDI_PINS = JSON.parse(fs.readFileSync(new URL('../../engines/midi/pins.json', import.meta.url), 'utf8')).vendor;
const SYNTH_VERSION = MIDI_PINS.spessasynth_core.version;
const BANK_VERSION = MIDI_PINS['generaluser-gs-sf3'].version;
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** a GhostFiles stand-in: paths in any case, bytes from a table */
function folder(entries) {
  const map = new Map(Object.entries(entries).map(([p, v]) => [p.toLowerCase(), [p, v]]));
  const norm = p => String(p).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return {
    has: p => map.has(norm(p)),
    resolve: p => (map.has(norm(p)) ? map.get(norm(p))[0] : null),
    bytes: async p => {
      const e = map.get(norm(p));
      if (!e) throw new Error(`no such file ${p}`);
      return typeof e[1] === 'string' ? new TextEncoder().encode(e[1]) : e[1];
    },
  };
}
const sjis = { 'あ': [0x82, 0xa0], 'い': [0x82, 0xa2] };

test('readme lookup: the descript key first, then SSP\'s list; ghost/master/readme.* only for a ghost, readme.txt before them', () => {
  assert.equal(findReadme(folder({ 'readme.txt': '', 'docs/About.txt': '' }), new Map([['readme', 'docs\\about.txt']])), 'docs/About.txt');
  assert.equal(findReadme(folder({ 'readme.txt': '' }), new Map([['readme', 'missing.txt']])), 'readme.txt', 'a key naming no file falls through');
  assert.equal(findReadme(folder({ 'README.TXT': '', 'readme.md': '' }), null), 'readme.md', 'Markdown first');
  assert.equal(findReadme(folder({ 'readme.txt': '', 'read me.rtf': '' }), null), 'read me.rtf');
  assert.equal(findReadme(folder({ 'ghost/master/readme.txt': '', 'お読みください.txt': '' }), null, { ghost: true }), 'お読みください.txt',
    'ghost/master/readme.txt comes last');
  assert.equal(findReadme(folder({ 'ghost/master/readme.txt': '' }), null, { ghost: true }), 'ghost/master/readme.txt');
  assert.equal(findReadme(folder({ 'ghost/master/readme.txt': '' }), null), null, 'not for a shell or balloon');
  assert.equal(findReadme(folder({ 'ghost/master/readme.md': '', 'readme.rtf': '' }), null, { ghost: true }), 'ghost/master/readme.md',
    'ghost/master/readme.md comes before readme.rtf');
  assert.equal(findReadme(folder({ 'readme': '', 'readme.1st': '' }), {}), 'readme.1st');
  assert.equal(findReadme(folder({ 'readme': '' }), {}), 'readme');
  assert.equal(findReadme(folder({}), {}), null);
  assert.equal(findReadme(null, {}), null);
});

test('terms lookup: terms.md, terms.markdown, terms.rtf, terms.txt in the ghost\'s root', () => {
  assert.equal(findTerms(folder({ 'terms.txt': '', 'Terms.MD': '' })), 'Terms.MD');
  assert.equal(findTerms(folder({ 'terms.txt': '', 'terms.rtf': '' })), 'terms.rtf');
  assert.equal(findTerms(folder({ 'ghost/master/terms.txt': '' })), null);
  assert.equal(findTerms(folder({})), null);
});

test('RTF as text: groups like the font table dropped, \\par newlines, \\\'hh as CP932, \\uN with its fallback', () => {
  const rtf = '{\\rtf1\\ansi\\ansicpg932\\deff0{\\fonttbl{\\f0\\fnil\\fcharset128 \\\'82\\\'6c\\\'82\\\'72 Gothic;}}' +
    '{\\colortbl ;\\red0\\green0\\blue0;}{\\*\\generator Msftedit 5.41;}\\viewkind4\\uc1\\pard\\lang1041\\f0\\fs20 Hello\\par\r\n' +
    '\\\'82\\\'a0\\\'82\\\'a2\\par\r\nLine\\tab two\\par\r\n\\u12358?\\\'83A \\{braces\\} back\\\\slash\\par\r\n}';
  assert.equal(rtfToText(rtf), 'Hello\nあい\nLine\ttwo\nうア {braces} back\\slash');
  assert.equal(rtfToText('plain text'), 'plain text', 'not RTF: as is');
  // a trail byte written as an escaped character ("表" is 0x95 0x5C)
  assert.equal(rtfToText('{\\rtf1 \\\'95\\\\\\par}'), '表');
});

test('readme text: descript readme.charset (UTF-8), else BOM / CP932; RTF shown as text; \\n line ends', async () => {
  const files = folder({
    'readme.txt': new Uint8Array([...sjis['あ'], 0x0d, 0x0a, ...sjis['い']]),
    'utf8.txt': 'ゴースト\r\nです',
    'bom.txt': new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('BOM付き')]),
    'readme.rtf': '{\\rtf1 \\\'82\\\'a0\\par x}',
  });
  assert.equal(await readmeText(files, 'readme.txt', new Map()), 'あ\nい');
  assert.equal(await readmeText(files, 'utf8.txt', new Map([['readme.charset', 'UTF-8']])), 'ゴースト\nです');
  assert.equal(await readmeText(files, 'utf8.txt', { 'readme.charset': 'utf8' }), 'ゴースト\nです', 'a plain object descript too');
  assert.notEqual(await readmeText(files, 'utf8.txt', new Map()), 'ゴースト\nです', 'no readme.charset: CP932 (as SSP)');
  assert.equal(await readmeText(files, 'bom.txt', null), 'BOM付き');
  assert.equal(await readmeText(files, 'readme.txt', new Map([['readme.charset', 'Shift_JIS']])), 'あ\nい');
  assert.equal(await readmeText(files, 'readme.rtf', null), 'あ\nx');
});

test('sources: the ghost, the shell and the balloon that have a readme, with their author and URL', async () => {
  const ghost = { kind: 'ghost', name: 'Hayama-san Next Door', files: folder({ 'readme.txt': 'ghost readme' }),
    descript: new Map([['craftman', 'macaroni'], ['craftmanw', 'Macaroni'], ['craftmanurl', 'http://macapeng.web.fc2.com/']]) };
  const shell = { kind: 'shell', name: 'master', files: folder({ 'descript.txt': '' }), descript: new Map() };
  const balloon = { kind: 'balloon', name: 'LightBlue', files: folder({ 'readme.txt': 'balloon readme' }),
    descript: new Map([['craftman', 'macaroni'], ['craftmanurl', 'http:']]) };
  const list = readmeSources([ghost, shell, balloon]);
  assert.deepEqual(list.map(s => [s.kind, s.path, s.author, s.url]), [
    ['ghost', 'readme.txt', 'Macaroni', 'http://macapeng.web.fc2.com/'], ['balloon', 'readme.txt', 'macaroni', 'http:']]);
  assert.equal(await list[1].load(), 'balloon readme');
  assert.deepEqual(infoFlags({ sources: [ghost, shell, balloon] }), { readme: true, terms: false });
  assert.deepEqual(infoFlags({ sources: [shell] }), { readme: false, terms: false });
  assert.deepEqual(infoFlags({ sources: [{ ...ghost, files: folder({ 'terms.txt': 't' }) }] }), { readme: false, terms: true });
  assert.deepEqual(infoFlags(null), { readme: false, terms: false });
  assert.equal(readmeContent([shell]), null);
  assert.equal(termsContent([ghost]), null);
});

test('the window\'s words in English and Japanese (SSP\'s DIALOG 109); the readme text keeps lang=""', () => {
  const ghost = { kind: 'ghost', files: folder({ 'readme.txt': 'x' }), descript: new Map([['craftmanw', 'Macaroni'], ['craftmanurl', 'http://macapeng.web.fc2.com/']]) };
  const balloon = { kind: 'balloon', files: folder({ 'readme.txt': 'y' }), descript: new Map([['craftmanurl', 'javascript:alert(1)']]) };
  const content = readmeContent([ghost, balloon]);
  const en = infoView(content, 'en', 0, 'the text');
  assert.deepEqual([en.title, en.fields.map(f => [f.label, f.value, f.href ?? null]), en.ok, en.close, en.text, en.textLang], [
    'About this character', [['Author:', 'Macaroni', null], ['URL:', 'http://macapeng.web.fc2.com/', 'http://macapeng.web.fc2.com/']],
    'OK', 'Close', 'the text', '']);
  assert.deepEqual(en.switcher.map(s => [s.label, s.selected]), [['Ghost', true], ['Balloon', false]]);
  const ja = infoView(content, 'ja', 1);
  assert.deepEqual([ja.title, ja.fields.map(f => [f.label, f.value, f.na, f.href ?? null]), ja.ok, ja.close, ja.text], [
    'キャラクタについて', [['作者名：', '(N/A)', true, null], ['URL：', 'javascript:alert(1)', false, null]], 'OK', '閉じる', null]);
  assert.deepEqual(ja.switcher.map(s => [s.label, s.selected]), [['ゴースト', false], ['バルーン', true]]);
  assert.deepEqual(infoView(readmeContent([ghost]), 'en').switcher, [], 'one source: no switcher');
  // terms: DIALOG 175's title with the file name, no author row
  const terms = termsContent([{ ...ghost, files: folder({ 'Terms.txt': 't' }) }]);
  assert.deepEqual([infoView(terms, 'en').title, infoView(terms, 'ja').title, infoView(terms, 'en').fields], ['Terms of use: Terms.txt', '利用条件 : Terms.txt', []]);
});

test('About Sumika: name, version, its developer, what it is, the four SHIORI engines and what they compile in, the MIDI player and its sound bank; in the UI language', () => {
  const about = aboutContent({ version: '1.0.0' });
  const en = infoView(about, 'en');
  assert.equal(en.title, 'About Sumika');
  assert.equal(en.text, 'Sumika  Version 1.0.0\nDeveloped by Heyuri Applicable Research & Development\n\n' +
    'Sumika runs ukagaka ghosts in a browser tab, from their original files.\n\n' +
    'SHIORI: Satori (BSD-2-Clause, ukatech/satoriya-shiori; MT19937 (BSD-3-Clause), DEELX)\n' +
    'SHIORI: YAYA (BSD-3-Clause, YAYA-shiori/yaya-shiori; MT19937 (BSD-3-Clause), the RSA Data Security, Inc. MD5 ' +
    'Message-Digest Algorithm, CRC-32 (zlib), parson (MIT), TinyXML-2 (zlib), Gumbo (Apache-2.0) with Bjoern ' +
    'Hoehrmann\'s UTF-8 decoder (MIT), DEELX, SQLite (public domain))\n' +
    // kawari.LICENSES.txt: Kawari's license.txt (modified BSD) and MT19937's notice (kawari-wasm.md §2)
    'SHIORI: Kawari (modified BSD, sourceforge.net/projects/kawari; MT19937 (BSD-3-Clause))\n' +
    // kawari7.LICENSES.txt: the same notices from the 7.5.0 source (kawari7-wasm.md §1)
    'SHIORI: Kawari 7 (modified BSD, sourceforge.net/projects/kawari; MT19937 (BSD-3-Clause))\n' +
    // midi.LICENSES.txt: the MIDI bundle and the bank, at the versions engines/midi/pins.json pins
    `MIDI: SpessaSynth core ${SYNTH_VERSION} (Apache-2.0, spessasus/spessasynth_core; fflate (MIT), stb_vorbis (MIT or public ` +
    'domain), Dattorro reverb (public domain))\n' +
    `Sound bank: GeneralUser GS ${BANK_VERSION} (GeneralUser GS License v2.0, S. Christian Collins)`);
  assert.equal(en.textLang, 'en');
  const ja = infoView(about, 'ja');
  assert.equal(ja.title, 'Sumikaについて');
  assert.match(ja.text, /^Sumika {2}バージョン 1\.0\.0\n開発：Heyuri Applicable Research & Development\n\nSumikaは、伺かのゴーストを/);
  assert.match(ja.text, /\n\nSHIORI：Satori \(BSD-2-Clause, ukatech\/satoriya-shiori; MT19937 \(BSD-3-Clause\), DEELX\)\nSHIORI：YAYA \(BSD-3/);
  assert.match(ja.text, /UTF-8 decoder \(MIT\), DEELX, SQLite \(public domain\)\)\nSHIORI：Kawari \(modified BSD, sourceforge\.net\/projects\/kawari; MT19937 \(BSD-3-Clause\)\)\nSHIORI：Kawari 7 \(modified BSD, sourceforge\.net\/projects\/kawari; MT19937 \(BSD-3-Clause\)\)\n/);
  assert.match(ja.text, new RegExp(`\\nMIDI：SpessaSynth core ${reEscape(SYNTH_VERSION)} \\(Apache-2\\.0, [^\\n]*\\)\\n` +
    `音色データ：GeneralUser GS ${reEscape(BANK_VERSION)} \\(GeneralUser GS License v2\\.0, S\\. Christian Collins\\)$`));
  assert.equal(ja.textLang, 'ja');
  assert.deepEqual(en.fields, []);
  assert.equal(engineLabel('YAYA'), 'YAYA');
  assert.equal(engineLabel({ name: 'Kawari' }), 'Kawari');
  assert.equal(engineLabel({ name: 'X', parts: ['a (MIT)', '', 'b'] }), 'X (a (MIT), b)', 'parts alone, no empty ones');
  assert.equal(engineLabel({ name: 'X', license: 'MIT', parts: [] }), 'X (MIT)');
  assert.match(infoView(aboutContent({ engines: ['Satori', 'YAYA'] }), 'en').text, /^Sumika\n[\s\S]*SHIORI: Satori\nSHIORI: YAYA\nMIDI: SpessaSynth[^\n]*\nSound bank: GeneralUser GS[^\n]*$/);
  assert.match(infoView(aboutContent({ engines: ['Satori'], midi: null }), 'en').text, /SHIORI: Satori$/, 'midi: null leaves both lines out');
  assert.match(infoView(aboutContent({ engines: ['Satori'], midi: { synth: 'X', bank: { name: 'B', license: 'L' } } }), 'en').text,
    /SHIORI: Satori\nMIDI: X\nSound bank: B \(L\)$/);
});

test('InfoWindow without a DOM: opening loads the selected readme once; switching loads the next; a language change re-labels', async () => {
  const storage = memoryStorage();
  runtimePrefs.set({ lang: 'en' }, storage);
  const language = new UiLanguage({ storage, navigator: { languages: ['en'] } });
  let loads = 0;
  const content = { title: l => (l === 'ja' ? 'キャラクタについて' : 'About this character'), sources: [
    { kind: 'ghost', author: 'A', url: null, load: async () => { loads++; return 'ghost text'; } },
    { kind: 'shell', author: null, url: null, load: async () => { loads++; throw new Error('404'); } },
  ] };
  const w = new InfoWindow({ language });
  w.open(content);
  assert.equal(w.view().text, null, 'loading');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(w.view().text, 'ghost text');
  w.select(1);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual([w.view().text, w.view().switcher.map(s => s.selected)], ['', [false, true]], 'a failed fetch shows nothing');
  w.select(0);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(loads, 2, 'each readme fetched once');
  language.set('ja');
  assert.deepEqual([w.view().title, w.view().switcher.map(s => s.label), w.view().ok], ['キャラクタについて', ['ゴースト', 'シェル'], 'OK']);
  w.open(aboutContent({ version: '1' }));               // one window: the next content replaces it
  assert.equal(w.view().title, 'Sumikaについて');
  w.close();
  assert.equal(w.content, null);
  w.destroy();
  language.set('en');
});

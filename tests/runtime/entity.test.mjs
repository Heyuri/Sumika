// SSP's entity decoding of GetStringShiori values (EV §5.5): SPGhost::DecodeEntity [disasm 0x625b10] over
// SPGetCharcodeReference's 252 names [disasm 0x5e8dd0] (src/sakura/entity.js), and the event loop's reads that go
// through it (resource(), resources(), %username, `.ext.` properties; the tooltips are in tooltip.test.mjs) against a
// fake engine, next to the replies that never do (events, OnTranslate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntity, charcodeReference, CHARCODE_REFERENCES } from '../../src/sakura/entity.js';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';

// ---------------------------------------------------------------- the table

test('SPGetCharcodeReference: HTML 4\'s 252 names, sorted for wcscmp, case-sensitive; unknown or numeric -> a space', () => {
  assert.equal(CHARCODE_REFERENCES.size, 252);
  const names = [...CHARCODE_REFERENCES.keys()];
  for (let i = 1; i < names.length; i++) assert.ok(names[i - 1] < names[i], `code-unit order at ${names[i]}`);
  assert.equal(names[0], 'AElig');
  assert.equal(names[251], 'zwnj');
  for (const [name, ch] of [['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['nbsp', '\u00a0'], ['yen', '¥'],
    ['euro', '€'], ['hearts', '♥'], ['Aring', 'Å'], ['aring', 'å'], ['OElig', 'Œ'], ['zwj', '\u200d'], ['thetasym', 'ϑ'],
    ['lang', '\u2329'], ['rang', '\u232a'], ['Prime', '″'], ['prime', '′']]) {
    assert.equal(charcodeReference(name), ch, name);
  }
  for (const name of ['apos', 'AMP', 'Amp', 'star', '#38', '#x26', '38', '', 'amp ', 'constructor', '__proto__', 'toString']) {
    assert.equal(charcodeReference(name), ' ', JSON.stringify(name));
  }
});

// ---------------------------------------------------------------- DecodeEntity

test('DecodeEntity: \\&[name] -> its character, anywhere, as often as it comes; unknown -> a space', () => {
  assert.equal(decodeEntity('Tom \\&[amp] Jerry'), 'Tom & Jerry');
  assert.equal(decodeEntity('\\&[lt]b\\&[gt]x\\&[lt]/b\\&[gt]'), '<b>x</b>');
  assert.equal(decodeEntity('\\&[amp]\\&[amp]'), '&&', 'side by side');
  assert.equal(decodeEntity('a\\&[star]b'), 'a b', 'a name ssp.exe does not know');
  assert.equal(decodeEntity('a\\&[#38]b\\&[#x26]c'), 'a b c', 'no numeric form');
  assert.equal(decodeEntity('\\&[AMP]'), ' ', 'case-sensitive');
  assert.equal(decodeEntity('\\&[constructor]'), ' ');
  assert.equal(decodeEntity('plain & text, \\n and \\_q stay'), 'plain & text, \\n and \\_q stay');
  assert.equal(decodeEntity(''), '');
  assert.equal(decodeEntity(null), '');
});

test('DecodeEntity: `\\\\` is skipped as a pair, so an escaped backslash keeps its entity text', () => {
  assert.equal(decodeEntity('\\\\&[amp]'), '\\\\&[amp]');
  assert.equal(decodeEntity('\\\\\\&[amp]'), '\\\\&', 'a pair, then a real entity');
  assert.equal(decodeEntity('\\\\\\\\&[amp]'), '\\\\\\\\&[amp]', 'two pairs');
  assert.equal(decodeEntity('a\\&[amp]\\\\&[lt]'), 'a&\\\\&[lt]');
});

test('DecodeEntity: the name runs to the first ] or the end; 1-19 units; the scan needs 3 more characters', () => {
  assert.equal(decodeEntity('\\&[]x'), '\\&[]x', 'an empty name stays');
  const n19 = 'x'.repeat(19), n20 = 'x'.repeat(20);
  assert.equal(decodeEntity(`a\\&[${n19}]b`), 'a b', '19 units: decoded (unknown)');
  assert.equal(decodeEntity(`a\\&[${n20}]b`), `a\\&[${n20}]b`, '20 units: left as it is');
  assert.equal(decodeEntity(`\\&[${n20}\\&[amp]`), `\\&[${n20}&`, 'an entity inside a long one is still found');
  assert.equal(decodeEntity('\\&[a\\&[amp]z'), ' z', 'nothing but ] ends a name');
  assert.equal(decodeEntity('x\\&[amp'), 'x&', 'an unclosed one at the end takes the rest');
  assert.equal(decodeEntity('x\\&[a'), 'x ', 'one character after the [ is enough');
  assert.equal(decodeEntity('x\\&['), 'x\\&[', 'nothing after the [: no name');
  assert.equal(decodeEntity('\\&[amp\x01b'), ' ', 'an unclosed name keeps going (`amp\\x01b`: unknown)');
  assert.equal(decodeEntity('\\&[amp]]'), '&]', 'decoded once; the scan goes on after the character');
  assert.equal(decodeEntity('\\&[ amp]'), ' ', 'no trimming');
});

// ---------------------------------------------------------------- the event loop

const GHOST = { id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };
const answers = map => r => (typeof map[r.id] === 'function' ? map[r.id](r) : map[r.id] ?? null);

async function booted(handler) {
  const clock = new FakeClock();
  const shiori = new FakeShiori(handler);
  const player = new FakePlayer();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost: GHOST,
    clock, env: { win: null, doc: null }, state: new StateStore('test', { storage: memoryStorage(), clock }),
    ghostDescript: new Map([['name', GHOST.name]]), site: { ghosts: [GHOST], balloons: [] },
  });
  await loop.boot({ resume: false });
  shiori.log.length = 0;
  return { clock, shiori, player, loop };
}

test('resources are decoded for every caller: one resource, the menu\'s batch, site lists with their separators', async () => {
  const t = await booted(answers({
    version: 'Satori \\&[amp] co.',
    'sakura.recommendsites': 'Tom \\&[amp] Jerry\x01http://example.invalid/?a=1\\&[amp]b=2\x01\x02-\x01\x01\x02',
    'shellrootbutton.caption': '\\&[laquo]Shells\\&[raquo](&S)',
    'readmebutton.caption': 'Read \\&[amp]\\&[amp] me',
    'dressuprootbutton.visible': '\\&[nbsp]',
    plain: '\\\\&[amp]',
  }));
  assert.equal(await t.loop.resource('version'), 'Satori & co.');
  assert.equal(await t.loop.resource('plain'), '\\\\&[amp]');
  assert.equal(await t.loop.resource('none'), null, '204 stays null');
  const r = await t.loop.resources(['sakura.recommendsites', 'shellrootbutton.caption', 'readmebutton.caption',
    'dressuprootbutton.visible', 'none']);
  assert.equal(r.get('sakura.recommendsites'), 'Tom & Jerry\x01http://example.invalid/?a=1&b=2\x01\x02-\x01\x01\x02');
  assert.equal(r.get('shellrootbutton.caption'), '«Shells»(&S)');
  assert.equal(r.get('readmebutton.caption'), 'Read && me', 'a decoded & is caption syntax like a written one');
  assert.equal(r.get('dressuprootbutton.visible'), '\u00a0');
  assert.equal(r.get('none'), null);
});

test('%username and `.ext.` properties are GetStringShiori reads too; events and OnTranslate replies are not decoded', async () => {
  const t = await booted(answers({
    username: 'Hana \\&[hearts]',
    'property.get': r => (r.refs[0] === 'k' ? 'v\\&[gt]w' : null),
    OnTest: '\\0\\&[amp]\\e',
  }));
  assert.equal(await t.loop.expand('%username!'), 'Hana ♥!');
  assert.equal(await t.loop.expand('%property[currentghost.ext.k]'), 'v>w');
  assert.equal(t.shiori.log.find(r => r.id === 'property.get').headers.SenderType, 'internal');
  await t.loop.send('OnTest');
  await settle();
  assert.equal(t.player.last.script, '\\0\\&[amp]\\e', 'an event\'s script reaches the player as written');
  t.shiori.handler = answers({ OnTranslate: '\\0\\&[lt]\\e', OnTest: '\\0x\\e' });
  await t.loop.send('OnTest');
  await settle();
  assert.equal(t.player.last.script, '\\0\\&[lt]\\e', 'OnTranslate\'s reply too (Translate never decodes)');
});

test('GetStringShiori\'s reading (EV §5.5): 200, 311, 312 only; Value, else String, else Sentence; property.set: any 2xx', async () => {
  let reply = null;
  const t = await booted(() => reply);
  for (const [r, want, what] of [
    [{ status: 200, value: 'a\\&[amp]b' }, 'a&b', '200'],
    [{ status: 311, value: 'x' }, 'x', '311'],
    [{ status: 312, value: 'y' }, 'y', '312'],
    [{ status: 203, value: 'x' }, null, 'another 2xx: no string [disasm 0x712FB2–0x712FD4]'],
    [{ status: 204, value: 'x' }, null, '204'],
    [{ status: 400, value: 'x' }, null, '400'],
    [{ status: 200, headers: { String: 's\\&[gt]' } }, 's>', 'String when there is no Value, decoded too'],
    [{ status: 311, headers: { Sentence: 'z' } }, 'z', 'then Sentence'],
    [{ status: 200, value: 'v', headers: { String: 's', Sentence: 'z' } }, 'v', 'Value first'],
    [{ status: 200, headers: { Value: '', String: 's' } }, 's', 'a header without a value is none (ParseValue)'],
  ]) {
    reply = r;
    assert.equal(await t.loop.resource('x'), want, `resource: ${what}`);
    assert.equal(await t.loop._property('currentghost.ext.k'), want, `.ext.: ${what}`);
  }
  // property.set (SPGhost::VarSet): success is the status in 200–299, whatever its string [disasm 0x648D06–0x648D19]
  for (const [status, ok] of [[200, true], [204, true], [299, true], [311, false], [400, false]]) {
    reply = { status, value: 'x' };
    assert.equal(await t.loop.setProperty('currentghost.ext.k', 'v'), ok, String(status));
  }
  // every one went out as GetStringShiori: SPShioriEvent's SenderType internal, kind resource (GET String for 2.x)
  assert.deepEqual([...new Set(t.shiori.log.map(r => `${r.method} ${r.id} ${r.kind} ${r.headers.SenderType}`))], [
    'GET x resource internal', 'GET property.get resource internal', 'GET property.set resource internal',
  ]);
  assert.deepEqual(t.shiori.find('property.set')[0].refs, ['k', 'v']);
});

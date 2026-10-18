// src/core/shells.js: SSP's name order, the default shell, \![change,shell|balloon] targets, the installed balloons,
// Balloon ▸ and the boot balloon order (BA §1.6, §12; EV §2.6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  compareNames, compareFolders, compareEntries, sameName, sortShells, visibleShells, shellName, defaultShellId,
  resolveShellTarget, installedBalloons, findBalloon, ghostBalloonKeys, resolveBalloonKey, balloonMenu,
  resolveBalloonTarget, bootBalloonKeys, bootBalloon,
} from '../../src/core/shells.js';

const sorted = names => [...names].sort(compareNames);
/** ssp.exe's Change ghost ▸ on an SSP install with 23 ghosts (from a screenshot): {id, name}, the menu's order */
const SSP_GHOSTS = JSON.parse(fs.readFileSync(new URL('../fixtures/ssp-ghost-order.json', import.meta.url), 'utf8')).ghosts;

test('compareEntries: ssp.exe\'s Change ghost ▸ of 23 ghosts (from a screenshot), from any order', () => {
  const shot = SSP_GHOSTS.map(g => g.id);
  assert.equal(shot.length, 23);
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const starts = {
    'folder (code point) order, as the index tools wrote it': [...SSP_GHOSTS].sort(byId),
    'folders any case': [...SSP_GHOSTS].sort((a, b) => compareFolders(a.id, b.id)),
    reversed: [...SSP_GHOSTS].reverse(),
    shuffled: SSP_GHOSTS.map((g, i) => [(i * 7919) % 23, g]).sort((a, b) => a[0] - b[0]).map(x => x[1]),
  };
  for (const [what, list] of Object.entries(starts)) {
    assert.deepEqual([...list].sort(compareEntries).map(g => g.id), shot, what);
  }
  assert.notDeepEqual(starts['folder (code point) order, as the index tools wrote it'].map(g => g.id), shot);
  // what the screenshot pins: names, not folders (tsubasa's "Hayama-san…" before NodePsimoon), katakana = hiragana
  // (なっとう between クローラ and ハッピー; めもりーな after まゆら and before ルームメイト), and one name twice: its
  // folders in order (kuro, like_a_cat)
  const at = id => shot.indexOf(id);
  assert.ok(at('tsubasa') < at('NodePsimoon') && at('crawler_uploader') < at('Nato') && at('Nato') < at('HappyDice'));
  assert.ok(at('mayura') < at('MEMORY_') && at('MEMORY_') < at('roommate') && at('kuro') + 1 === at('like_a_cat'));
  assert.equal(compareEntries({ id: 'kuro', name: '猫になった日' }, { id: 'like_a_cat', name: '猫になった日' }), -1);
  assert.equal(compareEntries({ id: 'b' }, { id: 'a', name: 'b' }), 1, 'no name: its folder id is its name');
});

test('compareNames: SSP wcsicmpex — digit runs as numbers, any case, full-width = ASCII, katakana = hiragana', () => {
  assert.deepEqual(sorted(['master', '1800', '640']), ['640', '1800', 'master'], "um.nar's shells");
  assert.deepEqual(sorted(['shell10', 'Shell9', 'shell1']), ['shell1', 'Shell9', 'shell10']);
  assert.deepEqual(sorted(['シェル１０', 'シェル２']), ['シェル２', 'シェル１０'], 'full-width digit runs');
  assert.equal(compareNames('Master', 'master'), 0);
  assert.equal(compareNames('ＭＡＳＴＥＲ', 'master'), 0, 'full-width letters');
  assert.equal(compareNames('ハヤト', 'はやと'), 0, 'katakana = hiragana');
  assert.ok(compareNames('b', 'A') > 0 && compareNames('A', 'b') < 0);
  assert.ok(compareNames('_x', 'ax') < 0, "lower case: '_' (0x5F) sorts before letters");
  assert.ok(compareNames('master', '少女語り') < 0, 'ASCII before kanji');
  assert.ok(compareNames('a', 'ab') < 0 && compareNames('ab', 'a') > 0);
  assert.equal(compareNames('v01', 'v1'), 0, 'equal numbers are equal runs');
  assert.ok(compareNames('9', '１') < 0, "SSP's quirk: a full-width first digit counts 0xFEE0 more");
  assert.ok(compareNames('2', 'a') < 0, 'a digit against a letter compares as characters');
  assert.equal(compareFolders('Master', 'MASTER'), 0);
  assert.ok(compareFolders('10', '9') < 0, 'folders: no numeric runs');
  assert.ok(sameName('天使の梯子', '天使の梯子') && sameName('LightBlue', 'lightblue') && !sameName('ア', 'あ') && !sameName(null, ''));
});

test('sortShells: by name, ties by folder; visibleShells drops menu,hidden; shellName', () => {
  const katari = { shells: [{ id: 'loligatari', name: '少女語り' }, { id: 'master', name: 'master' }] };
  assert.deepEqual(sortShells(katari.shells).map(s => s.id), ['master', 'loligatari']);
  assert.deepEqual(sortShells([{ id: 'b', name: 'Same' }, { id: 'a', name: 'same' }, { id: 'c', name: 'Other' }]).map(s => s.id), ['c', 'a', 'b']);
  const g = { shells: [{ id: 'z', name: 'Zed' }, { id: 'h', name: 'Hidden', hidden: true }, { id: 'a', name: 'Alpha' }] };
  assert.deepEqual(visibleShells(g).map(s => s.id), ['a', 'z']);
  assert.deepEqual(g.shells.map(s => s.id), ['z', 'h', 'a'], 'the ghost entry is not reordered');
  const hayato = { shells: [{ id: 'master', name: 'kinzon_mey' }] };
  assert.equal(shellName(hayato, 'master'), 'kinzon_mey');
  assert.equal(shellName(hayato, 'MASTER'), 'kinzon_mey');
  assert.equal(shellName(hayato, 'gone'), 'gone');
  assert.equal(shellName(null, 'master'), 'master');
});

test('defaultShellId: seriko.defaultsurfacedirectoryname (any case) → master → surface → first by name', () => {
  const both = { shells: [{ id: 'master', name: 'M' }, { id: 'surface', name: 'S' }, { id: 'alt', name: 'A' }] };
  assert.equal(defaultShellId(both, new Map([['seriko.defaultsurfacedirectoryname', 'Surface']])), 'surface');
  assert.equal(defaultShellId(both, { 'seriko.defaultsurfacedirectoryname': 'shell\\ALT\\' }), 'alt', 'a path value, plain object descript');
  assert.equal(defaultShellId(both, new Map([['seriko.defaultsurfacedirectoryname', 'gone']])), 'master');
  assert.equal(defaultShellId(both, new Map()), 'master');
  assert.equal(defaultShellId({ shells: [{ id: 'x', name: 'X' }, { id: 'Surface', name: 'S' }] }), 'Surface');
  assert.equal(defaultShellId({ shells: [{ id: 'z', name: 'Alpha' }, { id: 'a', name: 'Beta' }] }), 'z', 'first in name order, not folder order');
  assert.equal(defaultShellId({ shells: [], defaultShell: 'old' }), 'old');
  assert.equal(defaultShellId(null), 'master');
});

test('resolveShellTarget: names only, random needs 2 others, sequential wraps, lastinstalled, the current name reloads', () => {
  const katari = sortShells([{ id: 'loligatari', name: '少女語り' }, { id: 'master', name: 'master' }]);
  assert.equal(resolveShellTarget(katari, 'master', 'loligatari'), null, 'a folder id is not a name');
  assert.equal(resolveShellTarget(katari, 'master', '少女語り').id, 'loligatari');
  assert.equal(resolveShellTarget(katari, 'master', ' MASTER ').id, 'master', 'the current shell: a reload');
  assert.equal(resolveShellTarget(katari, 'master', 'Nobody'), null);
  assert.equal(resolveShellTarget(katari, 'master', ''), null);
  assert.equal(resolveShellTarget(katari, 'master', 'loligatari', { byId: true }).id, 'loligatari', 'menu picks name the folder');
  assert.equal(resolveShellTarget(katari, 'master', 'random', { random: () => 0.5 }), null, 'two shells: random does nothing');
  assert.equal(resolveShellTarget(katari, 'master', 'sequential'), null, 'the same guard for sequential');
  assert.equal(resolveShellTarget(katari, 'master', 'lastinstalled'), null);
  const three = sortShells([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
  for (const r of [0, 0.3, 0.5, 0.7, 0.999]) {
    const s = resolveShellTarget(three, 'b', 'Random', { random: () => r });
    assert.ok(s && s.id !== 'b', 'never the current shell');
  }
  assert.equal(resolveShellTarget(three, 'b', 'random', { random: () => 0 }).id, 'a');
  assert.equal(resolveShellTarget(three, 'b', 'random', { random: () => 0.99 }).id, 'c');
  assert.equal(resolveShellTarget(three, 'a', 'sequential').id, 'b');
  assert.equal(resolveShellTarget(three, 'c', 'sequential').id, 'a', 'wraps');
  const hidden = [...three, { id: 'h', name: 'H', hidden: true }];
  assert.equal(resolveShellTarget(hidden, 'a', 'h').id, 'h', 'a hidden shell can be named');
});

const INDEX = {
  balloons: [
    { id: 'sumika', name: 'Sumika' },
    { id: 'LightBlue', name: 'LightBlue', ghost: 'tsubasa' },
    { id: 'angel_ladder', name: '天使の梯子', ghost: 'etherism' },
    { id: 'shared', name: 'Theirs', ghost: 'other' },
  ],
};
const TSUBASA = { id: 'tsubasa', balloon: 'LightBlue', bundledBalloons: [{ dir: 'LightBlue', name: 'LightBlue' }] };
const ETHERISM = new Map([['balloon', '天使の梯子'], ['default.balloon.path', 'angel_ladder']]);

test('installedBalloons: index ∪ own bundled, one per folder (own wins), name order', () => {
  assert.deepEqual(installedBalloons(INDEX, TSUBASA), [
    { id: 'LightBlue', name: 'LightBlue', ghost: 'tsubasa' }, { id: 'sumika', name: 'Sumika' },
    { id: 'shared', name: 'Theirs', ghost: 'other' }, { id: 'angel_ladder', name: '天使の梯子', ghost: 'etherism' },
  ]);
  // an index from before hoisting: the ghost's own balloon still shows
  assert.deepEqual(installedBalloons({ balloons: [{ id: 'sumika', name: 'Sumika' }] }, TSUBASA).map(b => b.id), ['LightBlue', 'sumika']);
  const mine = installedBalloons(INDEX, { id: 'me', bundledBalloons: [{ dir: 'Shared', name: 'Mine' }] });
  assert.deepEqual(mine.filter(b => sameName(b.id, 'shared')), [{ id: 'Shared', name: 'Mine', ghost: 'me' }]);
  assert.deepEqual(installedBalloons({ balloons: [{ id: 'b', name: 'X' }, { id: 'a', name: 'x' }, { id: 'B', name: 'dup' }] }).map(b => b.id), ['a', 'b']);
  assert.deepEqual(installedBalloons(null, null), []);
});

test('findBalloon / resolveBalloonKey: folder (any case), then name', () => {
  const list = installedBalloons(INDEX, TSUBASA);
  assert.equal(findBalloon(list, 'lightblue').id, 'LightBlue');
  assert.equal(findBalloon(list, 'Sumika').id, 'sumika', "an old state's descript name");
  assert.equal(findBalloon(list, '天使の梯子').id, 'angel_ladder');
  assert.equal(findBalloon(list, 'nothing'), null);
  assert.equal(resolveBalloonKey(list, { path: 'Angel_Ladder\\' }).id, 'angel_ladder');
  assert.equal(resolveBalloonKey(list, { path: 'balloon/angel_ladder' }).id, 'angel_ladder', 'by its last folder');
  assert.equal(resolveBalloonKey(list, { name: 'angel_ladder' }), null, 'a name key never matches a folder');
  assert.equal(resolveBalloonKey(list, { key: 'LIGHTBLUE' }).id, 'LightBlue');
});

test('ghostBalloonKeys / balloonMenu: top group from the descript (etherism), none for Tsubasa; ✓ on the first row', () => {
  const d = new Map([['balloon', 'B'], ['default.balloon.path', 'dp'], ['recommended.balloon', 'R'], ['recommended.balloon.path', 'rp']]);
  assert.deepEqual(ghostBalloonKeys(d), [{ path: 'rp' }, { name: 'R' }, { path: 'dp' }, { name: 'B' }]);
  assert.deepEqual(ghostBalloonKeys(new Map()), []);
  const list = installedBalloons(INDEX, { id: 'etherism', bundledBalloons: [{ dir: 'angel_ladder', name: '天使の梯子' }] });
  const m = balloonMenu(list, ghostBalloonKeys(ETHERISM), 'angel_ladder');
  assert.deepEqual(m.top, [{ id: 'angel_ladder', name: '天使の梯子', current: true }], 'both keys name it: listed once');
  assert.deepEqual(m.all.map(b => [b.id, b.current]), [['LightBlue', false], ['sumika', false], ['shared', false], ['angel_ladder', false]],
    'its second row has no ✓');
  const t = balloonMenu(installedBalloons(INDEX, TSUBASA), ghostBalloonKeys(new Map()), 'LightBlue');
  assert.deepEqual(t.top, []);
  assert.deepEqual(t.all.filter(b => b.current).map(b => b.id), ['LightBlue']);
  const none = balloonMenu(list, [{ name: 'Not installed' }, { path: 'gone' }], null);
  assert.deepEqual(none.top, []);
  assert.ok(none.all.every(b => !b.current));
});

test('resolveBalloonTarget: names only, random among the others, sequential wraps, lastinstalled', () => {
  const list = installedBalloons(INDEX, TSUBASA);
  assert.equal(resolveBalloonTarget(list, 'LightBlue', '天使の梯子').id, 'angel_ladder');
  assert.equal(resolveBalloonTarget(list, 'LightBlue', 'SUMIKA').id, 'sumika');
  assert.equal(resolveBalloonTarget(list, 'LightBlue', 'angel_ladder'), null, 'a folder id is not a name');
  assert.equal(resolveBalloonTarget(list, 'LightBlue', 'angel_ladder', { byId: true }).id, 'angel_ladder');
  assert.equal(resolveBalloonTarget(list, 'LightBlue', 'lightblue').id, 'LightBlue', 'the current one: a reload');
  assert.equal(resolveBalloonTarget(list, 'LightBlue', 'lastinstalled'), null);
  assert.equal(resolveBalloonTarget(list, 'LightBlue', ''), null);
  for (const r of [0, 0.4, 0.99]) assert.notEqual(resolveBalloonTarget(list, 'LightBlue', 'random', { random: () => r }).id, 'LightBlue');
  assert.equal(resolveBalloonTarget([list[0]], 'LightBlue', 'random'), null, 'no other balloon');
  assert.equal(resolveBalloonTarget(list, 'LightBlue', 'sequential').id, 'sumika');
  assert.equal(resolveBalloonTarget(list, 'angel_ladder', 'sequential').id, 'LightBlue', 'wraps');
});

test('bootBalloonKeys: shell memory, choice, descript keys, install.txt; bootBalloon takes the first installed one', () => {
  const keys = bootBalloonKeys({ shellBalloon: 'gone', choice: 'Sumika', ghostDescript: ETHERISM, ghost: TSUBASA });
  assert.deepEqual(keys, [
    { key: 'gone', from: 'shell' }, { key: 'Sumika', from: 'choice' }, { path: 'angel_ladder', from: 'descript' },
    { name: '天使の梯子', from: 'descript' }, { key: 'LightBlue', from: 'install' },
  ]);
  const list = installedBalloons(INDEX, TSUBASA);
  assert.deepEqual(bootBalloon(list, keys), { entry: { id: 'sumika', name: 'Sumika' }, from: 'choice' }, 'a stored name still resolves');
  assert.equal(bootBalloon(list, bootBalloonKeys({ shellBalloon: 'angel_ladder', choice: 'sumika', ghost: TSUBASA })).entry.id, 'angel_ladder');
  assert.equal(bootBalloon(list, bootBalloonKeys({ ghost: TSUBASA })).from, 'install');
  assert.equal(bootBalloon(list, bootBalloonKeys({ ghostDescript: ETHERISM, ghost: TSUBASA })).entry.id, 'angel_ladder', 'descript before install.txt');
  assert.equal(bootBalloon(list, bootBalloonKeys({})), null);
});

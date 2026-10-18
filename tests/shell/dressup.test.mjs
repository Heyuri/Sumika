// Dress-up state (SH §4.3, SUM C24, EV §4.11) on Tsubasa's groups and synthetic bind options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { BindState } from '../../src/shell/dressup.js';
import { parseShell } from '../../src/shell/surfaces.js';
import { tsubasaShell, CORPUS } from './helpers.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');
const ch = list => list.map(c => `${c.on ? '+' : '-'}${c.id}`);

test('Tsubasa: defaults, category exclusivity (off before on), toggles, category off', real, () => {
  const { shell } = tsubasaShell();
  const b = new BindState(shell.bindGroups(0), shell.bindOptions(0));
  assert.deepEqual(b.onIds(), [0, 30, 51]);
  const sport = shell.bindGroups(0).find(g => g.part === '体操着ジャージ');
  assert.deepEqual(ch(b.apply('服', '体操着ジャージ', '1')), ['-51', '+' + sport.id]);
  assert.deepEqual(b.apply('服', '体操着ジャージ', '1'), []);              // already on: no event
  assert.deepEqual(ch(b.apply('髪', 'ツインテール')), ['-0', '+1']);      // empty value toggles
  assert.deepEqual(ch(b.apply('髪', 'ツインテール', '')), ['-1']);
  assert.deepEqual(b.apply('首', '', '0'), []);
  assert.deepEqual(ch(b.apply('足', '', '0')), ['-30']);                 // empty part + 0: whole category off
  assert.deepEqual(b.apply('足', '', '1'), []);                          // empty part + 1: no-op
  assert.deepEqual(b.apply('服', '体操着ジャージ', '(うにゅうｹﾞｯﾄ)'), []); // non-numeric value: no-op (logged)
  assert.deepEqual(b.apply('指輪２', '', '0'), []);                       // unknown category
  assert.deepEqual(b.apply('服', 'nosuch', '1'), []);
  const v = b.version;
  b.reset();
  assert.ok(b.version > v);
  assert.deepEqual(b.onIds(), [0, 30, 51]);
  b.restore([1, 9999, '2']);
  assert.deepEqual(b.onIds(), [1, 2]);
});

test('Tsubasa: OnNotifyDressupInfo references (category order, `default` option)', real, () => {
  const { shell } = tsubasaShell();
  const b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0));
  const refs = b.info(0, { order: shell.bindCategoryOrder(0), hasFile: () => false });
  assert.equal(refs.length, 230);
  assert.equal(refs[0], '0\x01髪\x01ポニーテール\x01default\x011\x01');
  assert.equal(refs[1], '0\x01髪\x01ツインテール\x01\x010\x01');
  // categories by the menu position of their first listed part, then the unlisted ones in creation order
  // (SSP's order for her shell, SH §4.3.2); parts in definition order
  const cats = [...new Set(refs.map(r => r.split('\x01')[1]))];
  assert.deepEqual(cats, ['髪', 'アクセサリ１', 'アクセサリ２', 'アクセサリ３', '服', 'エプロン', '足', '指輪', '上着', '上着腕', '首', '頬',
    'マフラー', 'お面', '尻尾', 'ペンダント', '口', '下着', '風呂', 'テーブル', '料理']);
  assert.equal(refs.filter(r => r.split('\x01')[3] === 'default').length, 3);
  const p = new BindState(shell.bindGroupsInFileOrder(100), shell.bindOptions(100));
  assert.equal(p.info(100).length, 3600);
  assert.deepEqual(ch(p.apply('P1', 'm1', '1')), ['+11001']);
  assert.deepEqual(ch(p.apply('P1', 'm2', '1')), ['-11001', '+12001']);
});

test('bindoption mustselect / multiple; addid draws the added parts but switches no flag', () => {
  const shell = parseShell({
    descript: [
      'sakura.bindgroup1.name,Hat,A,', 'sakura.bindgroup1.default,1', 'sakura.bindgroup2.name,Hat,B,',
      'sakura.bindgroup3.name,Pin,X,', 'sakura.bindgroup4.name,Pin,Y,',
      'sakura.bindgroup5.name,Set,Witch,', 'sakura.bindgroup5.addid,7,8', 'sakura.bindgroup6.name,Set,Maid,', 'sakura.bindgroup6.addid,7',
      'sakura.bindgroup7.name,Extra,Cape,', 'sakura.bindgroup8.name,Extra2,Broom,',
      'sakura.bindoption0.group,Hat,mustselect', 'sakura.bindoption1.group,Pin,multiple', 'sakura.bindoption2.group,Set,multiple',
    ].join('\n'),
    surfaces: [],
  });
  const b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0));
  // A off empties the mustselect category, so its default (A) comes back: no net change, no event
  assert.deepEqual(b.apply('Hat', 'A', '0'), []);
  assert.deepEqual(ch(b.apply('Hat', 'B', '1')), ['-1', '+2']);
  assert.deepEqual(ch(b.apply('Pin', 'X', '1')), ['+3']);
  assert.deepEqual(ch(b.apply('Pin', 'Y', '1')), ['+4']);                // multiple: both stay on
  // addid: a drawing-side expansion (SSP [infer]); 7 and 8 are drawn, not worn, and report no change
  assert.deepEqual(ch(b.apply('Set', 'Witch', '1')), ['+5']);
  assert.deepEqual(ch(b.drawChanges), ['+5', '+7', '+8']);
  assert.ok(b.isOn(7) && b.isOn(8) && !b.isWorn(7) && !b.isWorn(8));
  assert.deepEqual(b.onIds(), [2, 3, 4, 5]);
  assert.deepEqual(ch(b.apply('Set', 'Maid', '1')), ['+6']);
  assert.deepEqual(ch(b.drawChanges), ['+6']);                          // 7 already drawn (now added by 5 and 6)
  assert.deepEqual(ch(b.apply('Set', 'Witch', '0')), ['-5']);
  assert.deepEqual(ch(b.drawChanges), ['-5', '-8']);                    // 7 still added by 6
  assert.deepEqual(ch(b.apply('Set', 'Maid', '0')), ['-6']);
  assert.deepEqual(ch(b.drawChanges), ['-6', '-7']);
  assert.ok(!b.isOn(7));
  b.restore([5]);                                                        // a restored part draws its addid again
  assert.ok(b.isOn(7) && b.isOn(8));
  b.restore([2, 3, 4]);
  assert.equal(b.info(0)[2], '0\x01Pin\x01X\x01multiple\x011\x01');
  assert.equal(b.info(0)[0], '0\x01Hat\x01A\x01default,mustselect\x010\x01');
  // the menu path: B off empties Hat, its default A comes back
  assert.deepEqual(ch(b.set(2, false)), ['-2', '+1']);
  assert.deepEqual(ch(b.set(1)), []);                                    // toggling the default off: back at once
  assert.ok(b.isWorn(1));
});

test('mustselect: turning off the last part brings the default parts back (off first, then on), else it stays empty', () => {
  const shell = parseShell({
    descript: [
      'sakura.bindgroup4.name,Scarf,Blue,', 'sakura.bindgroup1.name,Scarf,Red,', 'sakura.bindgroup1.default,1',
      'sakura.bindgroup2.name,Hat,Straw,', 'sakura.bindgroup3.name,Hat,Cap,',
      'sakura.bindoption.group,Scarf,mustselect', 'sakura.bindoption.group,Hat,mustselect',
    ].join('\n'),
    surfaces: [],
  });
  const b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0));
  assert.deepEqual(b.onIds(), [1]);
  assert.deepEqual(ch(b.set(4, true)), ['-1', '+4']);
  // Blue (4) off: the category is empty, Red (1, default) comes back; the off is reported first although 1 < 4
  assert.deepEqual(ch(b.set(4, false)), ['-4', '+1']);
  assert.deepEqual(ch(b.apply('Scarf', 'Red', '0')), []);
  assert.deepEqual(ch(b.apply('Scarf', '', '0')), []);                  // whole category off: the default again
  assert.deepEqual(b.onIds(), [1]);
  // no default part: a mustselect category may end up empty
  assert.deepEqual(ch(b.set(3, true)), ['+3']);
  assert.deepEqual(ch(b.apply('Hat', 'Straw', '1')), ['-3', '+2']);
  assert.deepEqual(ch(b.set(2, false)), ['-2']);
  assert.deepEqual(b.onIds(), [1]);
});

test('a bind that turns A off and B on reports A first; a category without multiple keeps its first part', () => {
  const shell = parseShell({
    descript: ['sakura.bindgroup9.name,Coat,Long,', 'sakura.bindgroup9.default,1', 'sakura.bindgroup3.name,Coat,Short,',
      'sakura.bindgroup5.name,Coat,Cape,'].join('\n'),
    surfaces: [],
  });
  const b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0));
  assert.deepEqual(ch(b.apply('Coat', 'Short', '1')), ['-9', '+3']);
  // a saved state with two parts of one category (an older shell's): the next block keeps the first in definition order
  b.restore([5, 3]);
  assert.deepEqual(ch(b.apply('Coat', 'Long', '0')), ['-5']);
  assert.deepEqual(b.onIds(), [3]);
});

test('\\![bind] by name reaches ONE part when groups share category and part: lowest menu position, else definition order', () => {
  // DSLGS: bindgroup205 and 207 are both マフラー,黄色; 205 is menuitem40 and the only one drawn (SH §4.3.1)
  const descript = menu => parseShell({
    descript: [
      'sakura.bindgroup205.name,Scarf,Yellow,', 'sakura.bindgroup206.name,ScarfBack,Yellow,',
      'sakura.bindgroup207.name,Scarf,Yellow,', 'sakura.bindgroup208.name,Scarf,Red,', ...menu,
    ].join('\n'),
    surfaces: [],
  });
  let shell = descript(['sakura.menuitem0,208', 'sakura.menuitem1,-', 'sakura.menuitem2,205']);
  let b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0), shell.dressupMenu(0));
  assert.deepEqual(ch(b.apply('Scarf', 'Yellow', '1')), ['+205'], 'one part, not 205 then 207 (which would keep 207)');
  assert.deepEqual(b.onIds(), [205]);
  assert.deepEqual(ch(b.apply('Scarf', 'Yellow', '')), ['-205'], 'a toggle reaches the same one');
  assert.deepEqual(ch(b.apply('Scarf', 'Yellow', '1')), ['+205']);
  assert.deepEqual(ch(b.apply('Scarf', 'Yellow', '0')), ['-205']);
  assert.deepEqual(ch(b.set(207, true)), ['+207'], 'the menu path still switches the other one by id');
  assert.deepEqual(ch(b.apply('Scarf', 'Yellow', '0')), [], '\\![bind,…,0] reaches 205 (already off), not 207');
  // the listed one wins although it is defined later; a listed earlier position wins over a later one
  shell = descript(['sakura.menuitem0,207']);
  b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0), shell.dressupMenu(0));
  assert.deepEqual(ch(b.apply('Scarf', 'Yellow', '1')), ['+207']);
  shell = descript(['sakura.menuitem0,207', 'sakura.menuitem1,205']);
  b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0), shell.dressupMenu(0));
  assert.deepEqual(ch(b.apply('Scarf', 'Yellow', '1')), ['+207']);
  // neither listed (or no menu given): definition order
  shell = descript([]);
  b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0));
  assert.deepEqual(ch(b.apply('Scarf', 'Yellow', '1')), ['+205']);
  // inside a menuitemex submenu: its place in the walk counts
  shell = descript(['sakura.menuitemex0,Scarves,207', 'sakura.menuitem1,205']);
  b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0), shell.dressupMenu(0));
  assert.deepEqual(ch(b.apply('Scarf', 'Yellow', '1')), ['+207']);
});

test('info(): options default,mustselect,multiple; categories by first listed part; thumbnail only when the file exists', () => {
  const shell = parseShell({
    descript: [
      'sakura.bindgroup10.name,Coat,Long,coat.png', 'sakura.bindgroup11.name,Coat,Short,',
      'sakura.bindgroup6.name,Hat,Cap,', 'sakura.bindgroup6.default,1', 'sakura.bindgroup5.name,Hat,Straw,hat.png',
      'sakura.bindgroup1.name,Shoes,Boots,', 'sakura.bindgroup2.name,Ring,Gold,',
      'sakura.bindoption0.group,Hat,mustselect', 'sakura.bindoption0.group,Coat,multiple',
      'sakura.menuitem0,11', 'sakura.menuitem1,5', 'sakura.menuitem2,6', 'sakura.menuitem3,10',
    ].join('\n'),
    surfaces: [],
  });
  // Coat's first part (Long) sits at position 3, Hat's first part (Cap) at 2: Hat first, although Coat - Short
  // heads the menu; Shoes and Ring are not listed: after them, in creation order
  const order = shell.bindCategoryOrder(0);
  assert.deepEqual(order, ['Hat', 'Coat', 'Shoes', 'Ring']);
  const b = new BindState(shell.bindGroupsInFileOrder(0), shell.bindOptions(0));
  assert.deepEqual(b.info(0, { order, hasFile: n => n === 'hat.png' }), [
    '0\x01Hat\x01Cap\x01default,mustselect\x011\x01',
    '0\x01Hat\x01Straw\x01mustselect\x010\x01hat.png',
    '0\x01Coat\x01Long\x01multiple\x010\x01',
    '0\x01Coat\x01Short\x01multiple\x010\x01',
    '0\x01Shoes\x01Boots\x01\x010\x01',
    '0\x01Ring\x01Gold\x01\x010\x01',
  ]);
  // without an order: creation order
  assert.deepEqual(b.info(0).map(r => r.split('\x01')[1]), ['Coat', 'Coat', 'Hat', 'Hat', 'Shoes', 'Ring']);
});

test('corpus: every \\![bind] resolves to a bind group except known junk (R7)', needs('site/ghost/tsubasa', 'tests/corpus'), () => {
  const { shell } = tsubasaShell();
  const all = new Set(), cats = new Set();
  for (const s of shell.bindScopes()) for (const g of shell.bindGroups(s)) { all.add(g.category + '\x01' + g.part); cats.add(g.category); }
  const bad = new Set();
  let n = 0;
  for (const f of readdirSync(CORPUS).filter(x => /^final_.*\.res\.txt$/.test(x))) {
    const t = readFileSync(CORPUS + '/' + f, 'utf8');
    for (const m of t.matchAll(/\\!\[bind,([^\],]*),([^\],]*)(?:,([^\]]*))?\]/g)) {
      n++;
      const [, c, p] = m;
      if (!(p === '' ? cats.has(c) : all.has(c + '\x01' + p))) bad.add(c + ',' + p);
    }
  }
  assert.equal(n, 3292);
  const known = new Set([
    '服,（海服）', '指輪２,', '下着,１', '下着,On下着を渡す２', 'アクセサリ１,（好きな髪飾り）', 'アクセサリ２,（好きなカチューシャ）',
    'アクセサリ３,７', '服,１', '服,冬服ミニ+タイツ', '服,冬服白黒ミニ+タイツ', '服,夏服2', 'ペンダント,胸開セーター',
    'アクセサリ１,胸開セーター', '下着,胸開セーター', 'マフラー,胸開セーター', '服,夏服+上着赤', '髪,（デート髪型）', '料理,（夜食メニュー）',
  ]);
  assert.deepEqual([...bad].filter(x => !known.has(x)), []);
});

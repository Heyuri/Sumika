// Parser tests: Tsubasa's real shell (counts cross-checked with docs/research/scratch/shell_inventory.out.txt and
// individual facts read from the files) plus synthetic edge cases from SH §2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell, parseIdList, parsePattern, parseInterval, sortSurfaceFiles, cssCursor, surfaceBalloonOffset, scopeOf, scopeName } from '../../src/shell/surfaces.js';
import { tsubasaShell } from './helpers.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

test('Tsubasa: parse time and block/surface counts', real, () => {
  const { shell, parseMs, decodeMs } = tsubasaShell();
  console.log(`  parse ${parseMs.toFixed(1)} ms (decode ${decodeMs.toFixed(1)} ms) for 4 surfaces files + descript`);
  assert.ok(parseMs < 1000, 'parse should be fast');
  assert.equal(shell.stats.files.length, 4);
  assert.deepEqual(shell.stats.files.map(f => f.version), [1, 0, 1, 0]);
  assert.equal(shell.stats.blocks, 585 + 2 + 1);           // surface blocks + 2 descript + sakura.cursor
  assert.equal(shell.surfaceIds().length, 1423);
  assert.equal(shell.surfaceIds().filter(id => shell._table.get(id)?.textDefined).length, 556);
  assert.equal(shell._png.size, 920);
  assert.ok(shell.hasSurface(0) && shell.hasSurface(10) && shell.hasSurface(12) && shell.hasSurface(3) && !shell.hasSurface(99999));
  assert.equal(shell.pngOf(404), 'surface0404.png');      // zero padded names
  assert.equal(shell.pngOf(10100), 'surface10100.png');
});

test('Tsubasa: expanded totals match the inventory', real, () => {
  const { shell } = tsubasaShell();
  const intervals = {}, methods = {}, neg = {};
  let defs = 0, colls = 0, notZero = 0, gaps = 0, withElements = 0;
  for (const id of shell.surfaceIds()) {
    const s = shell.surface(id);
    colls += s.collisions.length;
    if (s.elements.length) withElements++;
    for (const d of s.anims.values()) {
      defs++;
      colls += d.collisions.length;
      const k = [...d.atoms].join('+');
      intervals[k] = (intervals[k] || 0) + 1;
      for (const p of d.patterns) {
        methods[p.method] = (methods[p.method] || 0) + 1;
        if (p.surface < 0) neg[p.surface] = (neg[p.surface] || 0) + 1;
      }
      const ps = d.patterns;
      if (ps.length && ps[0].index !== 0) notZero++;
      if (ps.length && ps[ps.length - 1].index - ps[0].index + 1 !== ps.length) gaps++;
    }
  }
  assert.equal(defs, 191987);
  assert.equal(colls, 27271 + 6570);
  assert.equal(withElements, 508);
  assert.deepEqual(intervals, { sometimes: 84, talk: 233, bind: 190788, 'bind+always': 295, always: 145, runonce: 260, 'bind+runonce': 57, never: 115, random: 10 });
  assert.deepEqual(methods, { overlay: 2740 + 8074, add: 49784 + 150663, insert: 201464, reduce: 9093 + 69, interpolate: 3020, base: 4 + 120, alternativestart: 80 + 10, move: 2312 });
  assert.deepEqual(neg, { '-1': 521 });
  assert.equal(notZero, 2395);
  assert.equal(gaps, 7848);
});

test('Tsubasa: surface 0 merged from several blocks', real, () => {
  const { shell } = tsubasaShell();
  const s = shell.surface(0);
  assert.equal(s.png, 'surface0000.png');
  assert.equal(s.elements.length, 0);
  assert.deepEqual(s.collisions.slice(0, 4).map(c => [c.id, c.x1, c.y1, c.x2, c.y2]),
    [['Head', 75, 8, 158, 56], ['Face', 85, 68, 151, 97], ['Bust', 61, 151, 134, 196], ['Mouth', 109, 99, 127, 111]]);
  assert.equal(s.collisions.length, 27);
  // blink: sometimes, 4 frames of 50 ms, ends with -1
  const blink = s.anims.get(0);
  assert.ok(blink.atoms.has('sometimes') && !blink.isBind);
  assert.deepEqual(blink.patterns.map(p => [p.method, p.surface, p.wmin, p.x, p.y]),
    [['overlay', 1000, 50, 85, 65], ['overlay', 1006, 50, 85, 65], ['overlay', 1000, 50, 85, 65], ['overlay', -1, 50, 85, 65]]);
  // mouth: 'talk' without N
  const mouth = s.anims.get(200);
  assert.ok(mouth.atoms.has('talk'));
  assert.equal(mouth.param, 0);
  assert.deepEqual(mouth.patterns.map(p => [p.surface, p.wmin]), [[1100, 70], [-1, 70]]);
  // pure bind with sparse indices and inserts written as insert,0,0,ID
  const veil = s.anims.get(17);
  assert.ok(veil.isPureBind);
  assert.equal(veil.patterns[0].index, 10);
  assert.deepEqual(veil.patterns[0].ids, [319]);
  assert.deepEqual(veil.collisions.map(c => c.id), ['Sisterveil', 'Sisterveil']);
  assert.deepEqual(s.anims.get(30).patterns.slice(0, 2).map(p => [p.method, p.ids[0]]), [['insert', 42], ['insert', 43]]);
  assert.deepEqual(s.anims.get(102).patterns.map(p => [p.method, p.surface, p.x, p.y]), [['add', 8050, 80, 65]]);
  assert.equal(s.keys.get('point.kinoko.centerx'), '118');
  // default animation-sort descend: ids drawn ascending
  assert.deepEqual(s.drawOrder.slice(0, 3), [0, 1, 2]);
  assert.equal(s.drawOrder.length, s.anims.size);
});

test('Tsubasa: elements, old syntax, empty text surfaces', real, () => {
  const { shell } = tsubasaShell();
  const s1 = shell.surface(1);
  assert.deepEqual(s1.elements.map(e => [e.index, e.method, e.file, e.x, e.y]),
    [[0, 'overlay', 'surface0000.png', 0, 0], [1, 'overlay', 'surface1001.png', 80, 55]]);
  assert.deepEqual(shell.surface(600).elements[0].x, -10);
  // surfaces4.txt (old syntax, waits x10)
  const s930 = shell.surface(930);
  assert.equal(s930.png, null);
  assert.equal(s930.elements.length, 0);
  const a0 = s930.anims.get(0);
  assert.ok(a0.atoms.has('sometimes'));
  assert.deepEqual(a0.patterns[0].method, 'alternativestart');
  assert.deepEqual(a0.patterns[0].ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const a1 = s930.anims.get(1);
  assert.ok(a1.atoms.has('never'));
  assert.equal(a1.exclusive, true);
  assert.deepEqual([a1.patterns[0].method, a1.patterns[0].surface], ['base', 9300]);
  assert.deepEqual([a1.patterns[1].method, a1.patterns[1].x, a1.patterns[1].y, a1.patterns[1].wmin], ['move', 100, 0, 0]);
  assert.deepEqual([a1.patterns[2].wmin, a1.patterns[2].y], [80, -50]);
  assert.deepEqual([a1.patterns[17].method, a1.patterns[17].surface, a1.patterns[17].wmin], ['base', 10, 100]);
  for (const id of [12, 930, 942, 945, 952, 961, 962]) {
    const s = shell.surface(id);
    assert.ok(s && s.textDefined && !s.png && !s.elements.length, 'empty text-only surface ' + id);
  }
  // 'always' with base frames and animation collisions (Christmas tree)
  const tree = shell.surface(960).anims.get(0);
  assert.ok(tree.atoms.has('always'));
  assert.deepEqual(tree.patterns.map(p => [p.method, p.surface, p.wmin]), [['base', 9360, 0], ['base', 9361, 2000], ['base', 9362, 2000], ['base', -1, 2000]]);
  assert.equal(tree.collisions[0].id, 'Treestar');
  // surfaces3.txt: game buttons are bind animations with their own collisions
  const fairy = shell.surface(9570).anims.get(9010);
  assert.ok(fairy.isPureBind);
  assert.deepEqual(fairy.collisions.map(c => [c.id, c.x1, c.y1, c.x2, c.y2]), [['Nfairy', 26, 4, 78, 78]]);
  // one-touch menu panel: 14 collisions, Mdatex only through bind animation 1150
  const panel = shell.surface(9700);
  assert.equal(panel.collisions.length, 14);
  assert.equal(panel.collisions[12].id, 'Mclose');
  assert.deepEqual(panel.anims.get(1150).collisions.map(c => c.id), ['Mdatex']);
  // picross board: 225 cell collisions, 900 bind groups
  assert.equal(shell.surface(10011).collisions.length, 225);
  assert.equal([...shell.surface(11011).anims.values()].filter(d => d.isPureBind).length, 900);
});

test('Tsubasa: descript bind groups, menus, offsets, cursors', real, () => {
  const { shell } = tsubasaShell();
  assert.deepEqual(shell.bindScopes(), [0, 27, 95, 96, 98, 99, 100]);
  const g0 = shell.bindGroups(0);
  assert.equal(g0.length, 230);
  assert.equal(new Set(g0.map(g => g.category)).size, 21);
  assert.deepEqual(g0[0], { id: 0, category: '髪', part: 'ポニーテール', thumbnail: '', default: true, addid: [] });
  assert.deepEqual(g0.filter(g => g.default).map(g => g.id), [0, 30, 51]);
  assert.equal(g0.find(g => g.id === 51).part, '夏服＋上着ピンク');
  assert.equal(shell.bindGroups(100).length, 3600);
  assert.equal(new Set(shell.bindGroups(100).map(g => g.category)).size, 900);
  assert.deepEqual(shell.bindGroups(99).map(g => [g.id, g.category, g.part]), [[1150, 'メニュー', 'メニュー×']]);
  assert.equal(shell.bindOptions(0).size, 0);
  assert.equal(shell.dressupMenu(0).length, 80);
  assert.deepEqual(shell.dressupMenu(0).slice(0, 4), [0, 1, 16, 2]);
  assert.equal(shell.dressupMenu(0).filter(x => x === '-').length, 6);
  assert.deepEqual(shell.dressupMenu(99), ['-']);
  assert.ok(shell.hasMenuItems(0) && shell.hasMenuItems(99) && !shell.hasMenuItems(1));
  assert.equal(shell.dressupMode(0), 'manual');
  // definition order differs from id order in 13 places; bindGroups stays ascending
  assert.deepEqual(shell.bindGroupsInFileOrder(0).slice(19, 21).map(g => g.id), [210, 211]);
  assert.deepEqual(shell.bindGroups(0).slice(19, 21).map(g => g.id), [26, 27]);
  assert.deepEqual(shell.balloonOffset(0), { x: 2, y: 14 });
  assert.deepEqual(shell.balloonOffset(1), { x: 0, y: 0 });
  assert.deepEqual(surfaceBalloonOffset(shell, shell.surface(0), 0), { x: 2, y: 14 });
  assert.equal(shell.scopeValue(99, 'seriko.alignmenttodesktop'), 'free');
  assert.equal(shell.scopeValue(5, 'defaultleft'), '300');
  const mi = shell.menuInfo;
  assert.equal(mi.background.file, 'menu_background.png');
  assert.deepEqual(mi.colors.separator, [244, 73, 71]);
  assert.deepEqual(mi.colors.foregroundFont, [235, 255, 255]);
  // sakura.cursor: every rule uses index 0; keyed by (event, collision)
  assert.equal(shell.cursors(0).length, 8);
  assert.equal(shell.cursorFor(0, 'mouseup', 'SeeWaist'), 'grab');
  assert.equal(shell.cursorFor(0, 'mousedown', 'SeeShoulder'), 'grabbing');
  assert.equal(shell.cursorFor(0, 'mouseup', 'Head'), 'pointer');
  assert.equal(shell.cursorFor(0, 'mouseup', 'Bust'), 'grab');
  assert.equal(shell.cursorFor(0, 'mouseup', ''), 'default');
});

test('dress-up descript: menuitems in file order, repeats overwrite in place, menuitemex submenus, every bindoption line, modes', () => {
  const shell = parseShell({
    descript: [
      'charset,UTF-8',
      'menu,hidden',
      'sakura.bindgroup0.name,Hat,Straw,', 'sakura.bindgroup1.name,Hat,Cap,', 'sakura.bindgroup2.name,Coat,Long,',
      'sakura.bindgroup3.name,Coat,Short,', 'sakura.bindgroup4.name,Ribbon,Red,', 'sakura.bindgroup5.name,Ribbon,Blue,',
      'sakura.menuitem2,2',
      'sakura.menuitem0,0',
      'sakura.menuitem1,1',
      'sakura.menuitem3,-1',
      'sakura.menuitem0,3',
      'sakura.menuitem7,99',
      'sakura.menuitemex0,Ribbons,4',
      'sakura.menuitem8,-',
      'sakura.menuitemex1,Ribbons,-',
      'sakura.menuitemex2,Ribbons,5',
      'sakura.menuitemex3,Empty,98',
      'sakura.menuitemex4,Lonely',
      'sakura.bindoption0.group,Hat,mustselect',
      'sakura.bindoption0.group,Coat,multiple',
      'sakura.bindoption.group,Ribbon,mustselect+multiple',
      'kero.bindgroup0.name,Tail,Long,', 'kero.menu,auto',
      'char2.bindgroup0.name,Tail,Short,', 'char2.menu,Hidden', 'char2.menuitem0,0',
      'char3.bindgroup0.name,Ear,Cat,',
    ].join('\n'),
    surfaces: [],
  });
  // written 2, 0, 1: that order; menuitem0 written again keeps its place with the later value; -1 is a separator;
  // 99 names no group; the Ribbons submenu sits where its first menuitemex was; Empty (only a missing group) and
  // Lonely (no id field) vanish
  assert.deepEqual(shell.dressupMenu(0), [2, 3, 1, '-', { menu: 'Ribbons', items: [4, '-', 5] }, '-']);
  assert.equal(shell.descript.get('sakura.menuitem0'), '0', 'the descript Map keeps the first value');
  assert.equal(shell.descriptLines.filter(([k]) => k === 'sakura.bindoption0.group').length, 2);
  // every bindoption line applies: repeated keys and the unnumbered form
  const o = shell.bindOptions(0);
  assert.deepEqual([...o.keys()], ['Hat', 'Coat', 'Ribbon']);
  assert.deepEqual([o.get('Hat').mustSelect, o.get('Hat').multiple], [true, false]);
  assert.deepEqual([o.get('Coat').mustSelect, o.get('Coat').multiple], [false, true]);
  assert.deepEqual([o.get('Ribbon').mustSelect, o.get('Ribbon').multiple], [true, true]);
  // <scope>.menu: auto / hid… / anything else manual; the unprefixed menu,hidden is the Shell ▸ flag
  assert.deepEqual([0, 1, 2, 3].map(s => shell.dressupMode(s)), ['manual', 'auto', 'hidden', 'manual']);
  assert.equal(shell.menuInfo.hidden, true);
  assert.deepEqual([0, 1, 2, 3].map(s => shell.hasMenuItems(s)), [true, false, true, false]);
  // category order: Coat's first part (2) heads the menu; Hat's first listed part is Cap (Straw's line was overwritten)
  assert.deepEqual(shell.bindCategoryOrder(0), ['Coat', 'Hat', 'Ribbon']);
  assert.deepEqual(shell.bindCategoryOrder(3), ['Ear']);
});

test('id lists: ranges, exclusions anywhere, MATERIA form, swapped ranges', () => {
  assert.deepEqual(parseIdList('0-4,6,8'), [0, 1, 2, 3, 4, 6, 8]);
  assert.deepEqual(parseIdList('1-10,!2-4,3'), [1, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(parseIdList('surface1,surface3'), [1, 3]);
  assert.deepEqual(parseIdList('5-3'), [3, 4, 5]);
  assert.deepEqual(parseIdList(' 7 , 9 '), [7, 9]);
});

test('pattern fields: new/old order, inserts, bracket lists, waits, aliases', () => {
  assert.deepEqual(parsePattern('overlay,1000,50,85,65', false, 0),
    { index: 0, method: 'overlay', surface: 1000, wmin: 50, wmax: 50, x: 85, y: 65, ids: null, alpha: undefined });
  const old = parsePattern('9300,8,move,100,-50', true, 2);
  assert.deepEqual([old.method, old.wmin, old.x, old.y], ['move', 80, 100, -50]);
  const oldOver = parsePattern('1000,5,overlay,85,65', true, 0);
  assert.deepEqual([oldOver.method, oldOver.surface, oldOver.wmin], ['overlay', 1000, 50]);
  assert.deepEqual(parsePattern('insert,0,0,185', false, 0).ids, [185]);
  assert.deepEqual(parsePattern('insert,7', false, 0).ids, [7]);
  assert.deepEqual(parsePattern('0,0,insert,12', true, 0).ids, [12]);
  assert.deepEqual(parsePattern('start,5', false, 0).ids, [5]);
  assert.deepEqual(parsePattern('alternativestart,[3]', false, 0).ids, [3]);
  assert.deepEqual(parsePattern('alternativestart,(1,2,3)', false, 0).ids, [1, 2, 3]);
  assert.deepEqual(parsePattern('0,0,alternativestart,[1.2.3]', true, 0).ids, [1, 2, 3]);
  const range = parsePattern('overlay,5,50-100,0,0', false, 0);
  assert.deepEqual([range.wmin, range.wmax], [50, 100]);
  assert.equal(parsePattern('overlay-fast,5,0,0,0', false, 0).method, 'overlayfast');
  assert.equal(parsePattern('5,10,,0,0', true, 0).method, 'base');   // empty old-syntax method = base
  assert.equal(parsePattern('overlay,0404,0,0,0', false, 0).surface, 404);
  assert.equal(parsePattern('overlay,5,0,0,0,--alpha,128', false, 0).alpha, 128);
  assert.deepEqual(parseInterval('bind+runonce'), { atoms: new Set(['bind', 'runonce']), param: 0 });
  assert.deepEqual(parseInterval('random,6'), { atoms: new Set(['random']), param: 6 });
  assert.deepEqual(parseInterval('Bind + Random,5'), { atoms: new Set(['bind', 'random']), param: 5 });
});

test('synthetic shell: merge, append, aliases, collisionex, lenient braces, comments', () => {
  const t1 = [
    'charset,UTF-8',
    'descript',
    '{',
    'version,1',
    'collision-sort,ascend',
    '}',
    '// a comment',
    'surface0,2',
    '{',
    'collision1,0,0,10,10,B',
    'collision0,20,20,10,10,A',
    'animation5.interval,always',
    'animation5.pattern0,overlay,100,10,0,0',
    'Animation7.Interval,bind',
    'animation7.pattern3,add,101,0,1,2',
    'point.basepos.x,40',
    '}',
    'surface0',
    '{',
    'animation5.pattern1,overlay,102,10,0,0',
    'animation5.interval,runonce',
    'collision1,0,0,5,5,B2',
    'sakura.balloon.offsetx,7',
    '}',
    'surface.append1-3',
    '{',
    'collision9,1,1,2,2,Appended',
    '}',
    'surface4 {',
    'collisionex0,Ell,ellipse,0,0,10,20',
    'collisionex1,Tri,polygon,0,0,10,0,0,10',
    'collisionex2,Cir,circle,5,5,3',
    '}',
    'sakura.surface.alias',
    '{',
    'smile,[0,2]',
    '9,[4]',
    '}',
    'kero.cursor',
    '{',
    'mouseup0,A,system:finger',
    '}',
    'unknownblock',
    '{',
    'x,y',
    '}',
  ].join('\r\n');
  const t2 = 'surface2\n{\n0interval,talk,3\n0pattern0,103,2,overlay,1,1\n1interval,sometimes\n1option,exclusive\n1pattern0,104,1,overlay,0,0\n}\n';
  const shell = parseShell({
    descript: 'charset,UTF-8\nkero.balloon.offsetx,5\nsakura.bindgroup3.name,Hat,Red,thumb.png\nsakura.bindgroup3.default,1\nsakura.bindgroup4.name,Hat,Blue,\nsakura.bindgroup4.addid,3\nsakura.bindoption0.group,Hat,mustselect+multiple\n',
    surfaces: [{ name: 'surfaces.txt', text: t1 }, { name: 'surfaces2.txt', text: t2 }],
    files: ['surface1.png', 'surface0003.png', 'Surface3.PNG', 'sub/x.png'],
  });
  assert.equal(shell.stats.files[0].version, 1);
  assert.equal(shell.stats.files[1].version, 0);
  const s0 = shell.surface(0);
  // later blocks replace keys but keep the first position; collision-sort ascend (index order)
  assert.deepEqual(s0.collisions.map(c => c.id), ['A', 'B2']);
  assert.deepEqual([s0.collisions[0].x1, s0.collisions[0].x2], [10, 20]);   // swapped ends normalised
  const a5 = s0.anims.get(5);
  assert.ok(a5.atoms.has('runonce') && !a5.atoms.has('always'));            // interval replaced by the later block
  assert.deepEqual(a5.patterns.map(p => p.surface), [100, 102]);
  assert.ok(s0.anims.get(7).isPureBind);                                     // case-insensitive keys
  assert.deepEqual(s0.basepos, { x: 40, y: NaN });
  assert.deepEqual(surfaceBalloonOffset(shell, s0, 0), { x: 7, y: 0 });
  // surface 2 gets both files; old syntax in surfaces2.txt
  const s2 = shell.surface(2);
  assert.equal(s2.anims.get(0).param, 3);
  assert.deepEqual([s2.anims.get(0).patterns[0].wmin, s2.anims.get(0).patterns[0].surface], [20, 103]);
  assert.equal(s2.anims.get(1).exclusive, true);
  assert.equal(s2.anims.get(5).patterns.length, 1);                          // only the first block (no second "surface2" block)
  // append: only to surfaces that exist (1 by png, 2 by text, 3 by png); 2 is not re-created
  assert.ok(shell.surface(1).collisions.some(c => c.id === 'Appended'));
  assert.ok(shell.surface(2).collisions.some(c => c.id === 'Appended'));
  assert.ok(shell.surface(3).collisions.some(c => c.id === 'Appended'));
  assert.equal(shell.pngOf(3), 'Surface3.PNG');                             // duplicate ids: the shorter name wins
  // inline brace + collisionex
  const s4 = shell.surface(4);
  assert.deepEqual(s4.collisions.map(c => c.kind), ['ellipse', 'polygon', 'circle']);
  // aliases (random pick is injectable)
  assert.equal(shell.alias(0, 'smile', () => 0.99), 2);
  assert.equal(shell.alias(0, 'smile', () => 0), 0);
  assert.equal(shell.alias(0, 9), 4);
  assert.equal(shell.alias(0, 5), 5);
  assert.equal(shell.alias(1, 9), 9);
  assert.ok(Number.isNaN(shell.alias(0, 'nosuch')));
  // \s[a,b] is one string (SS §3.4): each part as an alias in turn, else the leading number of the whole string
  // (GetSurfaceIndexChar 0x6e9220, SPSeriko_wcstonum) [disasm]
  assert.equal(shell.alias(0, 'nosuch,smile', () => 0), 0, 'the first part that is an alias');
  assert.equal(shell.alias(0, '9,smile'), 4, 'aliases in order: 9 first');
  assert.equal(shell.alias(0, '0,wait'), 0, "5sai's \\s[0,wait]");
  assert.equal(shell.alias(0, '20,200'), 20, "nibihada's \\s[20,200]: the number is the whole string's, not a part's");
  assert.equal(shell.alias(0, 'abc,1'), 0, 'no digit at the start: 0');
  assert.equal(shell.alias(0, '-1,x'), -1);
  assert.equal(shell.alias(0, '0x1f,x'), 31);
  assert.equal(shell.alias(0, ' 007,x'), 7);
  assert.equal(shell.cursorFor(1, 'mouseup', 'A'), 'pointer');
  // descript groups: thumbnail, addid, bindoption
  assert.deepEqual(shell.bindGroups(0).map(g => [g.id, g.category, g.part, g.thumbnail, g.default, g.addid]),
    [[3, 'Hat', 'Red', 'thumb.png', true, []], [4, 'Hat', 'Blue', '', false, [3]]]);
  assert.deepEqual(shell.bindOptions(0).get('Hat').mustSelect, true);
  assert.deepEqual(shell.balloonOffset(2), { x: 5, y: 0 });                 // char<n> falls back to kero
});

test('helpers', () => {
  assert.deepEqual(sortSurfaceFiles(['surfaces2.txt', 'Surfaces.txt', 'surfaces10.txt', 'surfaces3.txt']), ['Surfaces.txt', 'surfaces10.txt', 'surfaces2.txt', 'surfaces3.txt']);
  assert.equal(cssCursor('system:hand'), 'grab');
  assert.equal(cssCursor('system:finger'), 'pointer');
  assert.equal(cssCursor('cur\\a.cur'), 'url("cur/a.cur"), auto');
  // cursor files are relative to the shell folder, not to the page (SH §2.16)
  const toUrl = f => (f === 'cur/a.cur' ? 'http://h/ghost/x/shell/master/cur/a.cur' : null);
  assert.equal(cssCursor('cur\\a.cur', toUrl), 'url("http://h/ghost/x/shell/master/cur/a.cur"), auto');
  assert.equal(cssCursor('cur\\missing.cur', toUrl), 'default');
  assert.equal(cssCursor('a.cur', () => 'http://h/a"b.cur'), 'url("http://h/a\\"b.cur"), auto');
  assert.equal(scopeOf('char99'), 99);
  assert.equal(scopeOf('Kero'), 1);
  assert.equal(scopeName(100), 'char100');
});

test('a forgotten "}": a "{" (or "surfaceN {") inside a block closes it, and the line above heads the next block', () => {
  const text = [
    'surface10', '{', 'collision0,0,0,5,5,Head', 'point.kinoko.centerx,90',
    'surface11', '{', 'collision0,1,1,6,6,Face', '// a comment', '',
    'surface12 {', 'collision0,2,2,7,7,Hand',
    '}',
    'surface13', '{', 'collision0,3,3,8,8,Foot', '}',
  ].join('\r\n');
  const shell = parseShell({ descript: '', surfaces: [{ name: 'surfaces.txt', text }], files: [] });
  assert.deepEqual([10, 11, 12, 13].map(id => shell.surface(id).collisions.map(c => c.id)), [['Head'], ['Face'], ['Hand'], ['Foot']]);
  assert.equal(shell.surface(10).keys.get('point.kinoko.centerx'), '90', 'the open block keeps its own lines');
  assert.ok(!shell.hasSurface(14));
});

test('element files written without their extension: SSP\'s any-extension lookup (shop_robin)', () => {
  const text = 'surface4\n{\nelement0,overlay,surface0,0,0\nelement1,overlay,Parts/Eye.bmp,145,50\nelement2,overlay,nothing,0,0\n}\n';
  const shell = parseShell({ descript: '', surfaces: [{ name: 'surfaces.txt', text }],
    files: ['surface0.png', 'surface0.pna', 'surfaces.txt', 'parts/eye.png', 'nothing.txt'] });
  assert.deepEqual(shell.surface(4).elements.map(e => shell.resolveFile(e.file)), ['surface0.png', 'parts/eye.png', null]);
  assert.equal(shell.resolveFile('SURFACE0.PNG'), 'surface0.png', 'an exact name first');
});

test('elementsRead: every element line in read order across blocks, files and append blocks; elements stays one per number', () => {
  const shell = parseShell({
    descript: '',
    files: ['surface2.png'],
    surfaces: [
      { name: 'surfaces.txt', text: [
        'surface1', '{', 'element2,overlay,c.png,0,0', 'element0,overlayfast,a.png,0,0', 'element1,overlay,b.png,0,0', 'element0,overlay,a2.png,0,0', '}',
        'surface1,3', '{', 'element1,overlay,shared.png,0,0', '}',
        'surface.append1-2', '{', 'element3,overlay,app.png,0,0', '}',
        'surface.append4', '{', 'element0,overlay,nobody.png,0,0', '}',
      ].join('\n') },
      { name: 'surfaces2.txt', text: ['surface1', '{', 'element0,overlay,file2.png,0,0', '}'].join('\n') },
    ],
  });
  const pairs = list => list.map(e => [e.index, e.file]);
  assert.deepEqual(pairs(shell.surface(1).elementsRead),
    [[2, 'c.png'], [0, 'a.png'], [1, 'b.png'], [0, 'a2.png'], [1, 'shared.png'], [3, 'app.png'], [0, 'file2.png']]);
  assert.deepEqual(pairs(shell.surface(1).elements), [[0, 'file2.png'], [1, 'shared.png'], [2, 'c.png'], [3, 'app.png']]);
  assert.equal(shell.surface(1).elementsRead[1].method, 'overlayfast');
  assert.deepEqual(pairs(shell.surface(3).elementsRead), [[1, 'shared.png']]);
  assert.equal(shell.surface(3).elementsRead[0], shell.surface(1).elementsRead[4], 'a list header shares its records');
  assert.deepEqual(pairs(shell.surface(2).elementsRead), [[3, 'app.png']], 'append reaches a surface that has a png');
  assert.ok(!shell.hasSurface(4), 'append alone makes no surface');
});

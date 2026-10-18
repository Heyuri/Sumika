// The ghost's tray icon (ssp-ui.md §2.6), the launcher's image: src/core/trayicon.js (the descript's icon names, the
// file lookup of SPGhost::GetIconName / GetIconMinimizeName, \![set,trayicon]'s names, the icon a minimized or closed
// ghost's button shows), index_site.py's copy of the rule (ghosts.json `icon` / `iconMinimize`; runs Python), and the
// property records that answer `icon` from the index.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  iconRel, findIcon, descriptIcons, ghostIcons, isTrayIconTag, launcherIconPath,
} from '../../src/core/trayicon.js';
import { GhostFiles } from '../../src/core/loader.js';
import { indexGhostRecord } from '../../src/core/events.js';
import { manifestOf } from '../index_files.mjs';
import { needs } from '../needs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.env.PYTHON || 'python';

/** a ghost root as GhostFiles (resolve) and as a bare list (the sweep's fallback) */
const filesOf = paths => new GhostFiles('http://s/ghost/g/', paths.map(p => [p, 1]));
const listOf = paths => ({ list: () => paths.slice() });

test('descriptIcons: icon / iconfilename and icon.minimize in any case, the last line wins; none or empty: icon.ico [disasm LoadDescript 0x6246ad]', () => {
  assert.deepEqual(descriptIcons('charset,UTF-8\r\nname,G\r\n'), { icon: 'icon.ico', iconMinimize: '' });
  assert.deepEqual(descriptIcons('icon,a.ico\nICON , b.ico \n'), { icon: 'b.ico', iconMinimize: '' }, 'every line assigns');
  assert.deepEqual(descriptIcons('icon,a.ico\niconfilename,c.ico\n'), { icon: 'c.ico', iconMinimize: '' }, 'one field');
  assert.deepEqual(descriptIcons('icon,a.ico\nicon,\n'), { icon: 'icon.ico', iconMinimize: '' }, 'an empty value: the default');
  assert.deepEqual(descriptIcons('Icon.Minimize,m.ico\r//icon,x.ico\nicon\n'), { icon: 'icon.ico', iconMinimize: 'm.ico' },
    'comments and lines without a comma set nothing');
  assert.deepEqual(descriptIcons(null), { icon: 'icon.ico', iconMinimize: '' });
});

test('iconRel: \\ as /, . and empty segments dropped, .. goes up; leaving the ghost folder or a drive is null', () => {
  assert.equal(iconRel('img\\x.ico'), 'img/x.ico');
  assert.equal(iconRel('./a//b/../c.ico'), 'a/c.ico');
  assert.equal(iconRel('..\\x.ico', 'ghost/master/'), 'ghost/x.ico');
  assert.equal(iconRel('..\\x.ico'), null, 'above the ghost root');
  assert.equal(iconRel('C:\\Windows\\x.ico'), null);
  assert.equal(iconRel('a.ico:stream'), null);
  assert.equal(iconRel(''), null);
  assert.equal(iconRel(undefined), null);
  assert.equal(iconRel('.'), null, 'a folder, no file');
});

test('findIcon: the ghost root first, then ghost/master/; any case, the real spelling back; a missing file is null [disasm GetIconName 0x6373c0]', () => {
  const paths = ['Icon.ico', 'ghost/master/icon.ico', 'ghost/master/IMG/Batt_1.ICO', 'ghost/master/only.ico', 'shell/master/s.ico'];
  for (const files of [filesOf(paths), listOf(paths)]) {
    assert.equal(findIcon(files, 'icon.ico'), 'Icon.ico', 'the root wins');
    assert.equal(findIcon(files, 'only.ico'), 'ghost/master/only.ico');
    assert.equal(findIcon(files, 'img\\batt_1.ico'), 'ghost/master/IMG/Batt_1.ICO');
    assert.equal(findIcon(files, 'shell\\master\\s.ico'), 'shell/master/s.ico', 'any path under the root');
    assert.equal(findIcon(files, '..\\..\\Icon.ico'), 'Icon.ico', 'from ghost/master/ up to the root');
    assert.equal(findIcon(files, 'none.ico'), null);
    assert.equal(findIcon(files, 'icon1.ico'), null, 'numbered frames are not followed');
    assert.equal(findIcon(files, 'C:\\x\\icon.ico'), null);
    assert.equal(findIcon(files, ''), null);
  }
  assert.equal(findIcon(null, 'icon.ico'), null);
});

test('ghostIcons: the entry\'s site paths, each only when found; icon.minimize only when the descript names one', () => {
  const files = filesOf(['ghost/master/descript.txt', 'ghost/master/icon.ico', 'ghost/master/icon_minimize.ico']);
  assert.deepEqual(ghostIcons(files, 'icon,icon.ico\nicon.minimize,icon_minimize.ico\n', 'emily4'),
    { icon: 'ghost/emily4/ghost/master/icon.ico', iconMinimize: 'ghost/emily4/ghost/master/icon_minimize.ico' });
  assert.deepEqual(ghostIcons(files, 'name,x\n', 'g'), { icon: 'ghost/g/ghost/master/icon.ico' }, 'no key: icon.ico');
  assert.deepEqual(ghostIcons(files, 'icon,TrilliumC.ico\nicon.minimize,gone.ico\n', 'g'), {}, 'missing files: neither');
});

test('isTrayIconTag: \\![set] names starting trayi / tasktrayi in any case (the table\'s prefixes), not the tray balloon', () => {
  for (const n of ['trayicon', 'TrayIcon', 'tasktrayicon', 'trayiconX', 'trayi']) assert.ok(isTrayIconTag(n), n);
  for (const n of ['trayballoon', 'tasktrayballoon', 'tray', 'xtrayicon', '', null]) assert.ok(!isTrayIconTag(n), String(n));
});

test('launcherIconPath: minimized takes icon.minimize, else the icon shown before (a script\'s), else her icon; closed her icon; none: null [disasm LoadTrayIcon 0x49e56e]', () => {
  const g = { id: 'emily4', icon: 'ghost/emily4/ghost/master/icon.ico', iconMinimize: 'ghost/emily4/ghost/master/icon_minimize.ico' };
  const scripted = { reason: 'user', scopes: [0], icon: 'ghost/master/img/batt_1.ico' };
  assert.equal(launcherIconPath(g, 'minimized', scripted), g.iconMinimize, 'icon.minimize first, even over a script\'s');
  const plain = { id: 'emily4', icon: g.icon };
  assert.equal(launcherIconPath(plain, 'minimized', scripted), 'ghost/emily4/ghost/master/img/batt_1.ico');
  assert.equal(launcherIconPath(plain, 'minimized', { reason: 'user', scopes: [0] }), g.icon);
  assert.equal(launcherIconPath(plain, 'minimized', null), g.icon);
  assert.equal(launcherIconPath(g, 'closed', scripted), g.icon, 'SSP has no closed state: her normal icon');
  assert.equal(launcherIconPath({ id: 'x' }, 'minimized', null), null, 'none: SSP\'s own icon (the initial letter)');
  assert.equal(launcherIconPath({ id: 'x' }, 'minimized', { icon: 'a.ico' }), 'ghost/x/a.ico');
  assert.equal(launcherIconPath({ id: 'x' }, 'closed', { icon: 'a.ico' }), null);
  assert.equal(launcherIconPath(null, 'minimized'), null);
});

test('indexGhostRecord: `icon` from ghosts.json as a site-absolute path, none without one (properties.md §5.4)', () => {
  const rec = indexGhostRecord({ id: 'a b', icon: 'ghost/a b/ghost/master/ico n.ico' }, '/site/');
  assert.equal(rec.icon, '/site/ghost/a%20b/ghost/master/ico%20n.ico');
  assert.equal('icon' in indexGhostRecord({ id: 'x' }, '/'), false);
});

test('index_site.py: ghosts.json `icon` / `iconMinimize` as trayicon.js finds them (root first, any case, the last line, icon.ico)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-icon-'));
  try {
    const site = path.join(tmp, 'site');
    const ghost = (id, descript, files) => {
      fs.mkdirSync(path.join(site, 'ghost', id, 'ghost', 'master'), { recursive: true });
      fs.writeFileSync(path.join(site, 'ghost', id, 'ghost', 'master', 'descript.txt'),
        `charset,UTF-8\r\nname,${id}\r\nshiori,satori.dll\r\n${descript}`);
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(site, 'ghost', id, f)), { recursive: true });
        fs.writeFileSync(path.join(site, 'ghost', id, f), 'x');
      }
    };
    ghost('both', 'icon,a.ico\r\nICON,Pic.ICO\r\n', ['pic.ico', 'ghost/master/pic.ico']);
    ghost('master', 'iconfilename,img\\x.ico\r\nicon.minimize,min.ico\r\n', ['ghost/master/IMG/X.ico', 'ghost/master/min.ico']);
    ghost('plain', '', ['Icon.ico']);
    ghost('missing', 'icon,gone.ico\r\nicon.minimize,gone_too.ico\r\n', ['ghost/master/icon.ico']);
    ghost('emptymin', 'icon.minimize,\r\n', ['ghost/master/icon.ico', 'ghost/master/icon_minimize.ico']);
    ghost('outside', 'icon,..\\..\\..\\x.ico\r\n', []);
    fs.writeFileSync(path.join(site, 'ghost', 'x.ico'), 'x');
    const r = spawnSync(PY, ['-I', '-B', path.join(root, 'tools', 'index_site.py'), site], { encoding: 'utf8' });
    if (r.error) throw new Error(`this test runs Python (${PY}; set PYTHON to another): ${r.error.message}`);
    assert.equal(r.status, 0, r.stderr);
    const idx = JSON.parse(fs.readFileSync(path.join(site, 'sumika', 'index', 'ghosts.json'), 'utf8'));
    const g = id => idx.ghosts.find(x => x.id === id);
    const icons = id => [g(id).icon ?? null, g(id).iconMinimize ?? null];
    assert.deepEqual(icons('both'), ['ghost/both/pic.ico', null], 'the last icon line; the root before ghost/master/');
    assert.deepEqual(icons('master'), ['ghost/master/ghost/master/IMG/X.ico', 'ghost/master/ghost/master/min.ico']);
    assert.deepEqual(icons('plain'), ['ghost/plain/Icon.ico', null], 'no icon line: icon.ico, real spelling');
    assert.deepEqual(icons('missing'), [null, null], 'a missing file: no field');
    assert.deepEqual(icons('emptymin'), ['ghost/emptymin/ghost/master/icon.ico', null], 'an empty icon.minimize is none');
    assert.deepEqual(icons('outside'), [null, null], 'nothing outside the ghost folder');
    assert.equal('icon' in g('missing'), false);
    // the JS rule over the same folders gives the same fields
    for (const e of idx.ghosts) {
      const m = manifestOf(site, 'ghost', e.id, idx);         // ghosts.json `manifests` names it
      const files = new GhostFiles('http://s/', m.files, null, '', m.versions);
      const text = fs.readFileSync(path.join(site, 'ghost', e.id, 'ghost', 'master', 'descript.txt'), 'utf8');
      const js = ghostIcons(files, text, e.id);
      assert.deepEqual([js.icon ?? null, js.iconMinimize ?? null], icons(e.id), e.id);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the site index: every ghost\'s icon is the file ssp.exe would show (nodepsimoon and like_a_cat have none; only emily4 has icon.minimize)', needs('site/ghost/tsubasa', 'site/ghost/mayura', 'site/ghost/emily4'), () => {
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'site', 'sumika', 'index', 'ghosts.json'), 'utf8'));
  const by = Object.fromEntries(idx.ghosts.map(g => [g.id, g]));
  assert.equal(by.tsubasa.icon, 'ghost/tsubasa/ghost/master/tsubasa.ico');
  assert.equal(by.mayura.icon, 'ghost/mayura/ghost/master/hexagram.ico');
  assert.equal(by.emily4.iconMinimize, 'ghost/emily4/ghost/master/icon_minimize.ico');
  for (const id of ['nodepsimoon', 'like_a_cat']) if (by[id]) assert.equal('icon' in by[id], false, id);
  assert.deepEqual(idx.ghosts.filter(g => g.iconMinimize).map(g => g.id), by.emily4 ? ['emily4'] : []);
  for (const g of idx.ghosts) {
    if (!g.icon) continue;
    assert.ok(fs.existsSync(path.join(root, 'site', ...g.icon.split('/'))), `${g.id}: ${g.icon}`);
  }
});

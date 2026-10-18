// Several ghosts on one page (ssp-ui.md §3.5, §9.1, §2.6): src/ui/layers.js GhostLayers (one stacking layer per ghost,
// ranked by activation) headless and on a fake DOM, and the launcher dock's slots (src/ui/launcher.js) and its image,
// the ghost's tray icon (UI §2.6: Launcher.setIcon, its size, Runtime._showLauncher's pick).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GhostLayers, LAYER_CLASS } from '../../src/ui/layers.js';
import { Launcher, launcherLabel, launcherBottom, trayIconDevicePx, launcherIconBox } from '../../src/ui/launcher.js';
import { getRoot, Z_BASE } from '../../src/ui/root.js';
import { Runtime } from '../../src/core/runtime.js';
import { installFakeDom, FakeEl } from '../balloon/fake_dom.mjs';

// ---------------------------------------------------------------- headless: keys and order only

test('layers headless: create puts a key on top, raise reorders, remove closes ranks; z = Z_BASE + rank', () => {
  const L = new GhostLayers({ root: null });
  assert.equal(L.create(1, { ghost: 'tsubasa' }), null, 'no element without a root');
  L.create(2, { ghost: 'hayato' });
  L.create(3, { ghost: 'like_a_cat' });
  assert.deepEqual(L.order(), [1, 2, 3]);
  assert.equal(L.top, 3);
  assert.deepEqual([L.zOf(1), L.zOf(2), L.zOf(3)], [Z_BASE, Z_BASE + 1, Z_BASE + 2]);
  assert.equal(L.raise(1), true);
  assert.deepEqual(L.order(), [2, 3, 1]);
  assert.deepEqual([L.zOf(2), L.zOf(3), L.zOf(1)], [Z_BASE, Z_BASE + 1, Z_BASE + 2]);
  assert.equal(L.remove(3), true);
  assert.deepEqual(L.order(), [2, 1]);
  assert.deepEqual([L.zOf(2), L.zOf(1), L.zOf(3)], [Z_BASE, Z_BASE + 1, null]);
  assert.equal(L.remove(3), false, 'gone already');
  assert.equal(L.raise(99), false, 'unknown key');
  // an existing key comes back on top, keeping its place in nothing else
  L.create(2, { ghost: 'hayato' });
  assert.deepEqual(L.order(), [1, 2]);
  assert.ok(L.has(1) && !L.has(3));
  L.destroy();
  assert.deepEqual(L.order(), []);
});

test('layers headless: onRaise on every raise (also of the top layer), never from inside itself; setGhost relabels only', () => {
  const L = new GhostLayers({ root: null });
  L.create('a', { ghost: 'x' });
  L.create('b', { ghost: 'y' });
  const seen = [];
  L.onRaise = key => { seen.push(key); L.raise(key); L.raise('a'); };   // a handler that raises again: no loop
  L.raise('a');
  assert.deepEqual(seen, ['a']);
  assert.deepEqual(L.order(), ['b', 'a']);
  L.raise('a');                                           // already on top: still reported (a press on it)
  assert.deepEqual(seen, ['a', 'a']);
  L.onRaise = key => seen.push(key);
  L.create('c', { ghost: 'z' });
  assert.deepEqual(seen, ['a', 'a'], 'a new layer is not a raise');
  assert.equal(L.setGhost('a', 'w'), true);
  assert.deepEqual([L.ghostOf('a'), L.order(), seen.length], ['w', ['b', 'a', 'c'], 2], 'a ghost change keeps the slot\'s place');
  assert.equal(L.setGhost('nope', 'w'), false);
});

// ---------------------------------------------------------------- the DOM: one element per ghost

test('layers DOM: a fixed 0×0 .smk-ghost per ghost in the root, its z-index by rank; a press raises it', () => {
  installFakeDom();
  const root = new FakeEl('#layers');
  const L = new GhostLayers({ root });
  const a = L.create(1, { ghost: 'tsubasa' });
  const b = L.create(2, { ghost: 'hayato' });
  assert.deepEqual(root.children, [a, b]);
  assert.equal(a.className, LAYER_CLASS);
  assert.equal(LAYER_CLASS, 'smk-ghost');
  assert.deepEqual([a.dataset.ghost, b.dataset.ghost], ['tsubasa', 'hayato']);
  const { position, left, top, width, height, overflow } = a.style;
  assert.deepEqual({ position, left, top, width, height, overflow },
    { position: 'fixed', left: '0', top: '0', width: '0', height: '0', overflow: 'visible' });
  assert.equal(a.style.pointerEvents, undefined, 'none set: the characters and balloons set their own');
  assert.deepEqual([a.style.zIndex, b.style.zIndex], [String(Z_BASE), String(Z_BASE + 1)]);
  assert.equal(L.element(1), a);
  // a pointerdown anywhere in Tsubasa's layer brings her group above Hayato's
  const raised = [];
  L.onRaise = key => raised.push(key);
  a.fire('pointerdown', { button: 0 });
  assert.deepEqual([L.order(), raised], [[2, 1], [1]]);
  assert.deepEqual([a.style.zIndex, b.style.zIndex], [String(Z_BASE + 1), String(Z_BASE)]);
  assert.deepEqual(root.children, [a, b], 'the z-index stacks; the DOM order stays');
  // a ghost change in Hayato's slot: same element, same rank, new label
  L.setGhost(2, 'katari');
  assert.deepEqual([b.dataset.ghost, b.style.zIndex, L.element(2)], ['katari', String(Z_BASE), b]);
  L.remove(1);
  assert.deepEqual(root.children, [b]);
  assert.equal(b.style.zIndex, String(Z_BASE));
  // below the launcher dock and the menus at any rank the site allows
  const many = new GhostLayers({ root: null });
  for (let i = 0; i < 8; i++) many.create(i);
  assert.ok(many.zOf(7) < Z_BASE + 190);
});

test('layers DOM: the default root is the runtime\'s shadow root', () => {
  installFakeDom();
  const L = new GhostLayers();
  const el = L.create('s1', { ghost: 'tsubasa' });
  assert.ok(getRoot().children.includes(el));
  L.remove('s1');
  assert.ok(!getRoot().children.includes(el));
});

// ---------------------------------------------------------------- the launcher dock

test('launcher dock: bottom 16 + 56 × slot px; slot 0 is the one-ghost place; setSlot moves a shown button', () => {
  assert.deepEqual([0, 1, 2, 3].map(launcherBottom), [16, 72, 128, 184]);
  assert.deepEqual([launcherBottom(-1), launcherBottom('x'), launcherBottom(1.7)], [16, 16, 72]);
  installFakeDom();
  const two = new Launcher({ name: 'Hayato', slot: 2 });
  assert.equal(two.slot, 2);
  two.show('minimized');
  assert.equal(two.el.style.bottom, '128px');
  assert.equal(two.el.getAttribute('aria-label'), 'Show Hayato');
  two.setSlot(0);
  assert.deepEqual([two.slot, two.el.style.bottom], [0, '16px']);
  // a slot set before the button exists is used when it is built
  const later = new Launcher({ name: 'Tsubasa' });
  assert.equal(later.slot, 0);
  later.setSlot(1);
  later.show('closed');
  assert.equal(later.el.style.bottom, '72px');
  assert.equal(launcherLabel('closed', 'Tsubasa', 'en'), 'Call Tsubasa', 'labels unchanged');
  two.destroy();
  later.destroy();
});

// ---------------------------------------------------------------- the launcher's image: the tray icon (UI §2.6)

test('launcher image: setIcon swaps the <img> and the initial letter (SSP\'s own icon); a failed load shows the initial', () => {
  installFakeDom();
  const imgs = b => b.el.children.filter(c => c.tagName === 'IMG');
  const l = new Launcher({ name: 'tsubasa' });
  l.setIcon('http://s/ghost/tsubasa/ghost/master/tsubasa.ico');           // before the button exists: kept
  l.show('minimized');
  assert.equal(imgs(l).length, 1);
  assert.equal(imgs(l)[0].src, 'http://s/ghost/tsubasa/ghost/master/tsubasa.ico');
  assert.equal(imgs(l)[0].alt, '');
  const first = imgs(l)[0];
  l.setIcon('http://s/ghost/tsubasa/ghost/master/tsubasa.ico');           // the same: nothing repainted
  assert.equal(imgs(l)[0], first);
  l.setIcon(null);
  assert.deepEqual([imgs(l).length, l.el.textContent], [0, 'T'], 'none: the initial');
  l.setIcon('http://s/x.ico');
  const img = imgs(l)[0];
  img.naturalWidth = 16; img.naturalHeight = 16;
  img.onload();
  assert.deepEqual([img.style.width, img.style.height, img.classList.contains('smk-px')], ['32px', '32px', true], 'a 16-px icon at 32 device px');
  img.onerror();
  assert.deepEqual([imgs(l).length, l.el.textContent], [0, 'T'], 'it did not load: the initial');
  l.destroy();
  const built = new Launcher({ name: 'Mayura', iconUrl: 'http://s/h.ico' });
  built.show('closed');
  assert.equal(imgs(built)[0].src, 'http://s/h.ico');
  built.destroy();
});

test('launcher image: drawn at 16 × ⌊2 × dpr⌋ device px, the natural size fitted in, pixelated at whole scales of 2 or more [decision]', () => {
  assert.deepEqual([1, 1.25, 1.5, 1.75, 2, 3, 0.5, 0].map(d => trayIconDevicePx(d)), [32, 32, 48, 48, 64, 96, 16, 32]);
  assert.deepEqual(launcherIconBox(16, 16, 1), { width: 32, height: 32, pixelated: true });
  assert.deepEqual(launcherIconBox(32, 32, 1), { width: 32, height: 32, pixelated: false });
  assert.deepEqual(launcherIconBox(16, 16, 1.25), { width: 25.6, height: 25.6, pixelated: true });
  assert.deepEqual(launcherIconBox(32, 32, 1.5), { width: 32, height: 32, pixelated: false });
  assert.deepEqual(launcherIconBox(48, 48, 1), { width: 32, height: 32, pixelated: false });
  assert.deepEqual(launcherIconBox(16, 16, 2), { width: 32, height: 32, pixelated: true });
  assert.deepEqual(launcherIconBox(32, 16, 1), { width: 32, height: 16, pixelated: false }, 'aspect kept');
  assert.equal(launcherIconBox(0, 16, 1), null);
  assert.equal(launcherIconBox(undefined, undefined), null);
});

test('Runtime._showLauncher: the tray icon as ssp.exe picks it (icon.minimize, the script\'s minimized.icon, icon), never the thumbnail; a frozen slot reads the stored state', () => {
  installFakeDom();
  const site = { _dockSlot: () => 0, _layoutDock() {} };
  const rt = g => Object.assign(Object.create(Runtime.prototype), {
    ghost: g, base: 'http://s/', site, language: null, launcher: null, parts: null, state: null, _launcherMode: null,
  });
  const src = r => { const img = r.launcher.el.children.find(c => c.tagName === 'IMG'); return img ? img.src : r.launcher.el.textContent; };
  const emily = { id: 'emily4', sakuraName: 'Emily', thumbnails: ['ghost/emily4/thumbnail.png'],
    icon: 'ghost/emily4/ghost/master/icon.ico', iconMinimize: 'ghost/emily4/ghost/master/icon_minimize.ico' };
  const a = rt(emily);
  a.parts = { loop: { minimized: { reason: 'user', scopes: [0], icon: 'ghost/master/img/batt_1.ico' } } };
  a._showLauncher('minimized');
  assert.equal(src(a), 'http://s/ghost/emily4/ghost/master/icon_minimize.ico');
  a._showLauncher('closed');
  assert.equal(src(a), 'http://s/ghost/emily4/ghost/master/icon.ico', 'closed: her icon');
  const t = rt({ id: 'tsubasa', sakuraName: 'Tsubasa', thumbnails: ['ghost/tsubasa/thumbnail.png'], icon: 'ghost/tsubasa/ghost/master/tsubasa.ico' });
  t.parts = { loop: { minimized: { reason: 'script', scopes: [0], icon: 'ghost/master/my icon.ico' } } };
  t._showLauncher('minimized');
  assert.equal(src(t), 'http://s/ghost/tsubasa/ghost/master/my%20icon.ico', 'the script\'s icon');
  t.parts = null;
  t.state = { data: { minimized: { reason: 'user', scopes: [0] } } };
  t._showLauncher('minimized');
  assert.equal(src(t), 'http://s/ghost/tsubasa/ghost/master/tsubasa.ico', 'frozen: the stored state, no script icon: hers');
  const cat = rt({ id: 'like_a_cat', sakuraName: 'ルドルフ', thumbnails: ['ghost/like_a_cat/thumbnail.png'] });
  cat._showLauncher('minimized');
  assert.equal(src(cat), 'ル', 'no icon: the initial (SSP\'s own icon), not the thumbnail');
  for (const r of [a, t, cat]) r.launcher.destroy();
});

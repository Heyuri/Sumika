// Phones (ssp-ui §9.11 "Touch fixes" F2, F4, F5) on the fake DOM: the menu is at most the dynamic viewport tall
// (Close / Quit above the browser bar in landscape), a touch that turns into a scroll on a "▸" row opens no submenu,
// and a menu opened by a touch keeps its scroll to itself. A mouse-opened menu and the mouse's 150-ms submenu are
// exactly the desktop's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from '../balloon/fake_dom.mjs';

installFakeDom();
const { Menu } = await import('../../src/ui/menu.js');
const { getRoot } = await import('../../src/ui/root.js');
const { setLogLevel } = await import('../../src/core/log.js');

setLogLevel('silent');

const rowsOf = el => el.children.find(c => c.className === 'smk-rows').children.filter(c => c.className === 'smk-row');
/** a SHIORI host that answers no resource (every id 204): SSP's own captions */
const host = { enableLevel: 0, async resources(ids) { return new Map(ids.map(id => [id, null])); } };

test('F2: the menu is at most the dynamic viewport tall, after the 100vh line older browsers keep', () => {
  const m = new Menu({ thumbnail: null });
  const el = m._render([{ kind: 'item', label: 'x' }], null, false, 'en');
  const css = getRoot().getElementById('style-menu').textContent;
  const rule = /\.smk-menu \{[^}]*\}/.exec(css)[0];
  const vh = rule.indexOf('max-height: calc(100vh - 16px);'), dvh = rule.indexOf('max-height: calc(100dvh - 16px);');
  assert.ok(vh >= 0, 'the 100vh fallback stays');
  assert.ok(dvh > vh, '100dvh right after it');
  el.remove();
  m.destroy();
});

test('F5: a menu opened by a touch (and its submenus) keeps its overscroll; one opened by the mouse is the desktop\'s', async () => {
  const css = () => getRoot().getElementById('style-menu').textContent;
  const m = new Menu({ host, thumbnail: null });
  await m.open({ scope: 0, x: 10, y: 20, device: 'touch' });
  assert.ok(m.el, 'open');
  assert.ok(m.el.classList.contains('smk-touch'));
  assert.match(css(), /\.smk-menu\.smk-touch \{ overscroll-behavior: contain; \}/);
  const subRow = rowsOf(m.el).find(r => r.getAttribute('aria-haspopup') === 'menu' && r.getAttribute('aria-disabled') !== 'true');
  assert.ok(subRow, 'a submenu row');
  m._openSub(subRow, m._lastImages, false);
  assert.equal(m.subs.length, 1);
  assert.ok(m.subs[0].classList.contains('smk-touch'), 'a long submenu scrolls the same way');
  m.close({ restoreFocus: false });
  await m.open({ scope: 0, x: 10, y: 20 });
  assert.ok(m.el);
  assert.ok(!m.el.classList.contains('smk-touch'), 'mouse: no class');
  m._openSub(rowsOf(m.el).find(r => r.getAttribute('aria-haspopup') === 'menu' && r.getAttribute('aria-disabled') !== 'true'), m._lastImages, false);
  assert.ok(!m.subs[0].classList.contains('smk-touch'));
  m.close({ restoreFocus: false });
  m.destroy();
});

test('F4: a touch that becomes a scroll on a "▸" row (pointercancel) opens no submenu; the mouse still opens it at 150 ms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = new Menu({ thumbnail: null });
  const el = m._render([{ kind: 'sub', label: 'Change &ghost', items: [{ kind: 'item', label: 'A' }] }, { kind: 'item', label: 'x' }], null, false, 'en');
  m.el = el;
  const opened = [];
  m._openSub = row => opened.push(row);
  const [sub] = rowsOf(el);
  sub.fire('pointerenter', { pointerType: 'touch' });
  sub.fire('pointercancel', { pointerType: 'touch' });
  t.mock.timers.tick(200);
  assert.deepEqual(opened, [], 'the scroll opened nothing');
  sub.fire('pointerenter', { pointerType: 'pen' });
  sub.fire('pointercancel', { pointerType: 'pen' });
  t.mock.timers.tick(200);
  assert.deepEqual(opened, [], 'nor a pen\'s');
  // the mouse: the desktop's 150 ms, also past a pointercancel of its own (the browser took a drag over)
  sub.fire('pointerenter', { pointerType: 'mouse' });
  t.mock.timers.tick(149);
  assert.deepEqual(opened, []);
  t.mock.timers.tick(1);
  assert.deepEqual(opened, [sub]);
  sub.fire('pointerenter', { pointerType: 'mouse' });
  sub.fire('pointercancel', { pointerType: 'mouse' });
  t.mock.timers.tick(150);
  assert.deepEqual(opened, [sub, sub]);
  // a touch that stays a tap (no pointercancel): the submenu still opens, as on a desktop
  sub.fire('pointerenter', { pointerType: 'touch' });
  t.mock.timers.tick(150);
  assert.equal(opened.length, 3);
  m.el = null;
  el.remove();
  m.destroy();
});

// The visitor's user information on a page (EV §4.16, UI §2.13): the Site's UserProfile and Preferences box
// (SettingsWindow, headless here) on the synthetic site of multi_world.mjs (Satori x, y, z) with the real EventLoop.
// OnNotifyUserInfo in every boot batch once the box was saved, to every ghost up when the box closes after an edit;
// \![open,con…] and Options ▸ Preferences… open the one box; %username falls back to the stored nickname. Made-up
// values only (Taro, Taro Yamada, 2003-05-05).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimePrefs } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { UserProfile } from '../../src/core/user.js';
import { settingsPage, CONFIG_PAGES } from '../../src/core/events.js';
import { settle } from './fakes.mjs';
import { defaultAnswer, world, TestSite, eng, ids, idle, until, quitRun, invariants } from './multi_world.mjs';

setLogLevel('silent');

/** A tab with these ghosts on screen (met before), the Site's user profile `user`, every boot talk played to its end. */
async function set(w, user, list = ['x', 'y', 'z']) {
  for (const id of list) w.saves.set(id, {});
  runtimePrefs.set({ ghost: list[0], ghosts: list, rev: 1 });
  const site = new TestSite(w);
  site.user = user;
  assert.equal(await site.start(), 'booted');
  for (let i = 0; i < 5; i++) {
    await idle(site);
    for (const rt of site.slots) if (rt.player && rt.player.busy) rt.player.finish();
    await settle();
  }
  assert.deepEqual(ids(site), list);
  invariants(site, w);
  return site;
}

const notified = (w, id) => eng(w, id).find('OnNotifyUserInfo').map(r => [r.method, ...r.refs]);

/** console.warn while f runs (log.once at the 'warn' level). */
function warnings(f) {
  const seen = [];
  const orig = console.warn;
  setLogLevel('warn');
  console.warn = (...a) => seen.push(a.join(' '));
  try { return { value: f(), seen }; } finally { console.warn = orig; setLogLevel('silent'); }
}

test('settingsPage: no page, setup (any case) and words that are no page type open the box; SSP\'s other page types do not', () => {
  for (const p of [undefined, null, '', 'setup', 'SETUP', 'Setup', ' setup', 'mail', 'config']) assert.equal(settingsPage(p), true, String(p));
  for (const p of ['biff', 'BIFF', 'ghost', 'ghost2', 'talk', 'display', 'application', 'ipmessenger', 'developer']) {
    assert.equal(settingsPage(p), false, p);
  }
  assert.equal(CONFIG_PAGES.length, 17);
  assert.deepEqual(CONFIG_PAGES.filter(settingsPage), ['setup']);
});

test('the boot batch: no OnNotifyUserInfo until the box is saved; then every ghost\'s, right before otherghostname', async () => {
  let w = world();
  let site = await set(w, new UserProfile({ storage: null }), ['x', 'y']);
  for (const id of ['x', 'y']) assert.deepEqual(notified(w, id), [], `${id}: never saved`);
  site.done();

  w = world();
  const user = new UserProfile({ storage: null });
  user.set({ name: 'Taro Yamada', nickname: 'Taro', birthday: '2003-05-05', sex: 'male' });
  site = await set(w, user, ['x', 'y']);
  for (const id of ['x', 'y']) {
    assert.deepEqual(notified(w, id), [['NOTIFY', 'Taro', 'Taro Yamada', '2003,05,05', 'male']]);
    const order = eng(w, id).ids().filter(s => s.startsWith('NOTIFY '));
    assert.equal(order[order.indexOf('NOTIFY OnNotifyUserInfo') + 1], 'NOTIFY otherghostname');
  }
  site.done();
});

test('the box closed after an edit: one NOTIFY to every ghost up (not a closed one); closed untouched: none', async () => {
  const w = world();
  const user = new UserProfile({ storage: null });
  const site = await set(w, user);
  const z = site.slots[2];
  assert.equal(await site.closeGhost('z'), true);
  quitRun(z);
  assert.ok(await until(() => site.slots.length === 2));
  await settle();

  assert.equal(site.openSettings(), true);
  const box = site._settings;
  assert.equal(box.isOpen, true);
  box.close();
  await settle();
  for (const id of ['x', 'y', 'z']) assert.deepEqual(notified(w, id), [], 'untouched: nothing');

  assert.equal(site.openSettings('setup'), true);
  assert.equal(site._settings, box, 'one box per page');
  box.edit('nickname', 'Tar');
  box.edit('nickname', 'Taro');
  assert.equal(user.data.nickname, 'Taro', 'stored at every edit');
  for (const id of ['x', 'y']) assert.deepEqual(notified(w, id), [], 'nothing while it is open');
  box.close();
  await settle();
  for (const id of ['x', 'y']) assert.deepEqual(notified(w, id), [['NOTIFY', 'Taro', '', '', 'undef']], id);
  assert.deepEqual(notified(w, 'z'), [], 'z closed before');
  invariants(site, w);
  site.done();
});

test('\\![open,con…,page] (the loop\'s openWindow): no page, setup or an unknown word opens the box; biff opens nothing and is logged once', async () => {
  const w = world();
  const site = await set(w, new UserProfile({ storage: null }), ['x']);
  const [x] = site.slots;
  assert.equal(x.loop.openWindow('configurationdialog', ['setup']), true);
  assert.equal(site._settings.isOpen, true);
  site._settings.close();
  assert.equal(x.loop.openWindow('configurationdialog', []), true);
  site._settings.close();
  assert.equal(x.loop.openWindow('configurationdialog', ['nosuchpage']), true);
  site._settings.close();
  const r = warnings(() => [x.loop.openWindow('configurationdialog', ['biff']), x.loop.openWindow('configurationdialog', ['BIFF'])]);
  assert.deepEqual(r.value, [false, false]);
  assert.equal(site._settings.isOpen, false);
  assert.equal(r.seen.filter(s => /biff/i.test(s)).length, 1, 'logged once');
  // Options ▸ Preferences… in the main menu opens the same box
  x.parts.menu._run({ type: 'preferences' }, 0);
  assert.equal(site._settings.isOpen, true);
  // the page goes: the box goes too, sending nothing
  site.win.fire('pagehide', {});
  assert.equal(site._settings, null);
  assert.deepEqual(notified(w, 'x'), []);
  site.done();
});

test('%username on a page: the ghost\'s own answer, else the nickname the visitor stored, else `user`', async () => {
  let name = null;
  const w = world({ answer: (id, r, mem) => (r.id === 'username' ? name : defaultAnswer(id, r, mem)) });
  const user = new UserProfile({ storage: null });
  const site = await set(w, user, ['x']);
  const [x] = site.slots;
  assert.equal(await x.loop.expand('%username'), 'user');
  user.set({ name: 'Taro Yamada' });
  assert.equal(await x.loop.expand('%username'), 'Taro Yamada', 'the name when no nickname');
  user.set({ nickname: 'Taro' });
  assert.equal(await x.loop.expand('%username'), 'Taro');
  name = 'Hanako';
  assert.equal(await x.loop.expand('%username'), 'Hanako', 'the ghost\'s own answer first');
  assert.equal(eng(w, 'x').find('username').length, 4);
  site.done();
});

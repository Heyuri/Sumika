// src/core/user.js (ssp-ui.md §2.13; EV §4.16): the visitor's user information, SSP's Name, Nickname, Birthday and Sex,
// site-wide in the runtime prefs; OnNotifyUserInfo's References, %username's fallback, other tabs. Made-up values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UserProfile, sharedUser, normUser, birthdayRef, SEXES, USER_KEY } from '../../src/core/user.js';
import { RUNTIME_KEY, memoryStorage, runtimePrefs } from '../../src/core/state.js';

/** a window stand-in that only dispatches */
function fakeWindow() {
  const l = new Map();
  return {
    addEventListener: (t, f) => { if (!l.has(t)) l.set(t, new Set()); l.get(t).add(f); },
    removeEventListener: (t, f) => { const s = l.get(t); if (s) s.delete(f); },
    dispatch: (t, ev) => { for (const f of l.get(t) || []) f(ev); },
    count: t => (l.get(t) ? l.get(t).size : 0),
  };
}

test('nothing stored: not set, R0–R3 "", "", "", undef, no nickname for %username', () => {
  const u = new UserProfile({ storage: memoryStorage() });
  assert.equal(u.isSet(), false);
  assert.deepEqual(u.refs(), ['', '', '', 'undef']);
  assert.equal(u.nickname(), null);
  assert.deepEqual(u.data, {});
});

test('all four fields: R0 nickname, R1 name, R2 the birthday zero-padded as ssp.exe ("%04d,%02d,%02d"), R3 the sex', () => {
  const storage = memoryStorage();
  runtimePrefs.set({ ghosts: ['tsubasa'], rev: 3, lang: 'ja' }, storage);
  const u = new UserProfile({ storage });
  assert.equal(u.set({ name: 'Taro Yamada', nickname: 'Taro', birthday: '2003-05-05', sex: 'male' }), true);
  assert.equal(u.isSet(), true);
  assert.deepEqual(u.refs(), ['Taro', 'Taro Yamada', '2003,05,05', 'male']);
  assert.equal(u.nickname(), 'Taro');
  // stored next to the other runtime prefs, which stay as they were
  assert.deepEqual(JSON.parse(storage.getItem(RUNTIME_KEY)), { ghosts: ['tsubasa'], rev: 3, lang: 'ja',
    [USER_KEY]: { name: 'Taro Yamada', nickname: 'Taro', birthday: '2003-05-05', sex: 'male' }, v: 1 });
  // the next page reads them back
  assert.deepEqual(new UserProfile({ storage }).refs(), ['Taro', 'Taro Yamada', '2003,05,05', 'male']);
  // data is a copy
  const d = u.data;
  d.name = 'x';
  assert.equal(u.data.name, 'Taro Yamada');
});

test('name only: R0 = R1 = the name, and %username\'s fallback is the name; an empty nickname counts as not given', () => {
  const u = new UserProfile({ storage: memoryStorage() });
  u.set({ name: 'Taro' });
  assert.deepEqual(u.refs(), ['Taro', 'Taro', '', 'undef']);
  assert.equal(u.nickname(), 'Taro');
  u.set({ nickname: '' });
  assert.deepEqual(u.refs(), ['Taro', 'Taro', '', 'undef']);
  assert.equal(u.nickname(), 'Taro');
  u.set({ name: '' });
  assert.equal(u.isSet(), true, 'saved once, even if emptied again');
  assert.deepEqual(u.refs(), ['', '', '', 'undef']);
  assert.equal(u.nickname(), null);
  const n = new UserProfile({ storage: memoryStorage() });
  n.set({ nickname: 'たろう' });
  assert.deepEqual(n.refs(), ['たろう', '', '', 'undef'], 'nickname only: R1 stays empty');
});

test('birthday: YYYY-MM-DD becomes "YYYY,MM,DD"; "" or anything else is no birthday; names are never trimmed', () => {
  assert.equal(birthdayRef('2003-05-05'), '2003,05,05');
  assert.equal(birthdayRef('0987-12-31'), '0987,12,31');
  assert.equal(birthdayRef('12345-01-09'), '12345,01,09', 'a year past 9999 as %04d prints it');
  for (const s of ['', '2003-5-5', '2003-13-01', '2003-00-10', '2003-05-32', '2003/05/05', null, undefined]) {
    assert.equal(birthdayRef(s), '', String(s));
  }
  const u = new UserProfile({ storage: memoryStorage() });
  u.set({ birthday: '2003-05-05' });
  assert.equal(u.refs()[2], '2003,05,05');
  u.set({ birthday: '' });
  assert.deepEqual([u.refs()[2], u.data.birthday], ['', ''], 'taken back: stored empty');
  u.set({ birthday: 'soon' });
  assert.equal(u.data.birthday, '', 'not a date: no birthday');
  u.set({ name: ' Taro ' });
  assert.equal(u.refs()[1], ' Taro ');
});

test('sex: male, female or undef; another value changes nothing', () => {
  assert.deepEqual(SEXES, ['male', 'female', 'undef']);
  const u = new UserProfile({ storage: memoryStorage() });
  assert.equal(u.set({ sex: 'female' }), true);
  assert.equal(u.refs()[3], 'female');
  assert.equal(u.set({ sex: 'Male' }), false);
  assert.equal(u.set({ sex: 'other' }), false);
  assert.equal(u.refs()[3], 'female');
  assert.equal(u.set({ sex: 'undef' }), true);
  assert.equal(u.refs()[3], 'undef');
});

test('set: one change per real change with the data before and after; the same values again emit nothing', () => {
  const u = new UserProfile({ storage: memoryStorage() });
  const seen = [];
  u.on('change', e => seen.push(e));
  assert.equal(u.set({ nickname: 'Taro' }), true);
  assert.equal(u.set({ nickname: 'Taro' }), false);
  assert.equal(u.set({ name: undefined, nickname: null }), false, 'undefined / null keys are left as they are');
  assert.equal(u.set(null), false);
  assert.equal(u.set({ nickname: 'Taro', sex: 'male' }), true);
  assert.deepEqual(seen, [
    { data: { nickname: 'Taro' }, prev: {} },
    { data: { nickname: 'Taro', sex: 'male' }, prev: { nickname: 'Taro' } },
  ]);
});

test('another tab saves its box: the storage event refreshes the profile, one change; other runtime prefs do not', () => {
  const storage = memoryStorage();
  const u = new UserProfile({ storage });
  const win = fakeWindow();
  u.bindWindow(win);
  u.bindWindow(win);
  assert.equal(win.count('storage'), 1, 'bound once');
  const seen = [];
  u.on('change', e => seen.push(e.data));
  runtimePrefs.set({ lang: 'en', rev: 7 }, storage);                    // the language, the set of ghosts
  win.dispatch('storage', { key: RUNTIME_KEY });
  assert.equal(seen.length, 0);
  new UserProfile({ storage }).set({ nickname: 'Taro', birthday: '2003-05-05' });   // the other tab
  win.dispatch('storage', { key: 'sumika:ghost:tsubasa:state' });
  assert.equal(seen.length, 0, 'not the runtime prefs');
  win.dispatch('storage', { key: RUNTIME_KEY });
  win.dispatch('storage', { key: RUNTIME_KEY });
  assert.deepEqual(seen, [{ nickname: 'Taro', birthday: '2003-05-05' }]);
  assert.deepEqual(u.refs(), ['Taro', '', '2003,05,05', 'undef']);
  runtimePrefs.set({ [USER_KEY]: { nickname: 'Hanako' } }, storage);
  win.dispatch('storage', { key: null });                               // localStorage.clear() or a bulk change
  assert.equal(u.nickname(), 'Hanako');
  assert.equal(u.refresh(), false, 'nothing new');
  u.dispose();
  runtimePrefs.set({ [USER_KEY]: { nickname: 'Jiro' } }, storage);
  win.dispatch('storage', { key: RUNTIME_KEY });
  assert.equal(u.nickname(), 'Hanako', 'disposed: no longer listening');
  assert.equal(win.count('storage'), 0);
});

test('no storage: the profile works in memory for the page; a storage that refuses writes keeps the edits too', () => {
  const u = new UserProfile({ storage: null });
  assert.equal(u.set({ nickname: 'Taro' }), true);
  assert.equal(u.nickname(), 'Taro');
  assert.equal(u.refresh(), false);
  assert.equal(u.nickname(), 'Taro');
  // a full quota: getItem works, setItem throws
  const full = memoryStorage();
  runtimePrefs.set({ [USER_KEY]: { name: 'Old' } }, full);
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  const q = new UserProfile({ storage: full });
  assert.equal(q.set({ name: 'New' }), true);
  assert.equal(q.refresh(), false, 'the stored value did not move: ours stays');
  assert.deepEqual(q.refs(), ['New', 'New', '', 'undef']);
});

test('stored data is cleaned: unknown keys, wrong types, a bad sex and a bad birthday never reach a ghost', () => {
  assert.deepEqual(normUser({ name: 'Taro', nickname: 5, birthday: '2003-05-05', sex: 'x', extra: 'y' }),
    { name: 'Taro', birthday: '2003-05-05' });
  assert.deepEqual(normUser({ birthday: '2003-5-5' }), { birthday: '' });
  assert.deepEqual(normUser({ birthday: 20030505 }), {});
  for (const v of [null, undefined, 'Taro', ['Taro'], 3]) assert.deepEqual(normUser(v), {});
  const storage = memoryStorage();
  runtimePrefs.set({ [USER_KEY]: 'Taro' }, storage);
  assert.equal(new UserProfile({ storage }).isSet(), false);
  runtimePrefs.set({ [USER_KEY]: { sex: 'female', nickname: ['x'] } }, storage);
  assert.deepEqual(new UserProfile({ storage }).refs(), ['', '', '', 'female']);
});

test('sharedUser: one profile per page', () => {
  assert.equal(sharedUser(), sharedUser());
  assert.ok(sharedUser() instanceof UserProfile);
});

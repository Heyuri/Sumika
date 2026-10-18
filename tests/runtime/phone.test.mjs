// src/core/phone.js (ssp-ui.md §9.11, Sumika's own: SSP has no phone): the one predicate main.js reads once per page
// (phoneInfo: a coarse primary pointer and a screen whose short side is under 600 CSS px, or ?sumika-phone), the
// script tag's phone option (phoneMode: data-phone) and the off stub window.sumika becomes
// (offApi). Pure: fake windows, no runtime. Then the launcher's phone parts on the fake DOM (tests/balloon/fake_dom.mjs):
// the busy button a tap leaves while she loads (setBusy), the safe-area insets on phones only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PHONE_SHORT_MAX, phoneOverride, phoneInfo, phoneMode, offApi } from '../../src/core/phone.js';
import { Launcher } from '../../src/ui/launcher.js';
import { getRoot } from '../../src/ui/root.js';
import { installFakeDom } from '../balloon/fake_dom.mjs';

/**
 * A window: `coarse` the primary pointer's answer to (pointer: coarse) (null: no matchMedia), `screen` its sides,
 * `doc` documentElement's client size, `inner` innerWidth / innerHeight, `search` the URL's query. `reads` counts every
 * read of screen and document (a desktop window reads neither: the pointer test fails first).
 */
function fakeWin({ coarse = false, screen = [1920, 1080], doc = null, inner = null, search = '', dpr = 1, matchMedia } = {}) {
  const reads = { screen: 0, document: 0 };
  const [dw, dh] = doc || inner || screen;
  const [iw, ih] = inner || doc || screen;
  const win = {
    devicePixelRatio: dpr, innerWidth: iw, innerHeight: ih, location: { search },
    matchMedia: matchMedia !== undefined ? matchMedia
      : coarse === null ? undefined
        : q => ({ media: q, matches: /\(pointer:\s*coarse\)/.test(q) ? coarse : false }),
  };
  Object.defineProperty(win, 'screen', { get() { reads.screen++; return screen ? { width: screen[0], height: screen[1] } : undefined; } });
  Object.defineProperty(win, 'document', { get() { reads.document++; return { documentElement: { clientWidth: dw, clientHeight: dh } }; } });
  return { win, reads };
}

// ---------------------------------------------------------------- phoneInfo (UI §9.11 Detection)

test('phoneInfo, desktop unchanged: a mouse at any screen and devicePixelRatio is no phone, and nothing but the pointer is read', () => {
  for (const screen of [[1280, 720], [1366, 768], [1920, 1080], [1024, 768], [960, 540]]) {
    for (const dpr of [1, 1.25, 2, 3]) {
      const { win, reads } = fakeWin({ screen, dpr });
      assert.equal(phoneInfo(win), null, `${screen.join('×')} at ${dpr}`);
      assert.deepEqual(reads, { screen: 0, document: 0 }, 'the pointer test fails first');
    }
  }
  // a narrowed desktop window is still a desktop window: no window size enters the test
  assert.equal(phoneInfo(fakeWin({ screen: [1920, 1080], inner: [375, 660] }).win), null);
  // a big touch screen (a kiosk, a tablet): the size test is the second guard
  for (const screen of [[1920, 1080], [1280, 720], [768, 1024]]) assert.equal(phoneInfo(fakeWin({ coarse: true, screen }).win), null, screen.join('×'));
  assert.equal(PHONE_SHORT_MAX, 600);
  assert.equal(phoneInfo(fakeWin({ coarse: true, screen: [600, 960], doc: [600, 900] }).win), null, '600 is a tablet (sw600dp)');
});

test('phoneInfo, phones: the screen\'s sides whatever the orientation; a mobile view when the layout is the screen\'s width', () => {
  const want = { short: 375, long: 812, mobileView: true };
  // iOS reports the screen in portrait always, Android swaps it; the layout is the width it was loaded at
  assert.deepEqual(phoneInfo(fakeWin({ coarse: true, screen: [375, 812], doc: [375, 660] }).win), want, 'portrait');
  assert.deepEqual(phoneInfo(fakeWin({ coarse: true, screen: [375, 812], doc: [812, 300] }).win), want, 'landscape, iOS');
  assert.deepEqual(phoneInfo(fakeWin({ coarse: true, screen: [812, 375], doc: [812, 300] }).win), want, 'landscape, Android');
  assert.deepEqual(phoneInfo(fakeWin({ coarse: true, screen: [812, 375], doc: [375, 660] }).win), want, 'portrait, swapped screen');
  // an iPhone in landscape with its notch letterboxes the layout: still a mobile view
  assert.deepEqual(phoneInfo(fakeWin({ coarse: true, screen: [375, 812], doc: [724, 340] }).win), want);
  // a vertical scrollbar's width is no matter (+ 2)
  assert.equal(phoneInfo(fakeWin({ coarse: true, screen: [360, 800], doc: [362, 640] }).win).mobileView, true);
  // a page without a viewport meta lays out at about 980 px in both orientations: no mobile view (no fit)
  for (const [screen, doc] of [[[375, 812], [980, 2122]], [[375, 812], [980, 452]], [[430, 932], [980, 2124]], [[430, 932], [980, 452]]]) {
    assert.deepEqual(phoneInfo(fakeWin({ coarse: true, screen, doc }).win),
      { short: Math.min(...screen), long: Math.max(...screen), mobileView: false }, `${screen.join('×')}, layout ${doc.join('×')}`);
  }
  assert.deepEqual(phoneInfo(fakeWin({ coarse: true, screen: [320, 568], doc: [320, 460] }).win), { short: 320, long: 568, mobileView: true });
});

test('phoneInfo: no matchMedia, one without matches, one that throws, no screen or a zero one: not a phone', () => {
  assert.equal(phoneInfo(fakeWin({ coarse: null, screen: [375, 812] }).win), null, 'no matchMedia');
  assert.equal(phoneInfo(fakeWin({ screen: [375, 812], matchMedia: () => ({}) }).win), null, 'no matches');
  assert.equal(phoneInfo(fakeWin({ screen: [375, 812], matchMedia: () => ({ matches: 'yes' }) }).win), null, 'matches !== true');
  assert.equal(phoneInfo(fakeWin({ screen: [375, 812], matchMedia: () => null }).win), null);
  assert.equal(phoneInfo(fakeWin({ screen: [375, 812], matchMedia: () => { throw new Error('no'); } }).win), null, 'throws');
  assert.equal(phoneInfo(fakeWin({ coarse: true, screen: null, doc: [375, 660] }).win), null, 'no screen');
  assert.equal(phoneInfo(fakeWin({ coarse: true, screen: [0, 0], doc: [375, 660] }).win), null, 'a zero screen');
  assert.equal(phoneInfo(null), null);
  assert.equal(phoneInfo({}), null);
});

test('phoneInfo forced (dev aid): ?sumika-phone takes the window\'s sides and a mobile view; ?sumika-phone=0 turns a phone off', () => {
  const desk = fakeWin({ screen: [1920, 1080], inner: [1280, 720], doc: [1263, 720], search: '?sumika-phone' });
  assert.deepEqual(phoneInfo(desk.win), { short: 720, long: 1280, mobileView: true }, 'a desktop window');
  assert.equal(desk.reads.screen, 0, 'the monitor\'s screen is not read');
  assert.deepEqual(phoneInfo(fakeWin({ screen: [1920, 1080], inner: [375, 812], doc: [375, 812], search: '?sumika-debug&sumika-phone=1' }).win),
    { short: 375, long: 812, mobileView: true }, 'a window made phone-sized');
  assert.equal(phoneInfo(fakeWin({ coarse: true, screen: [375, 812], doc: [375, 660], search: '?sumika-phone=0' }).win), null, 'a phone shows the desktop path');
  assert.deepEqual([phoneOverride(''), phoneOverride('?sumika-phone'), phoneOverride('?sumika-phone='), phoneOverride('?a=1&sumika-phone=0'),
    phoneOverride('?sumika-phone=false'), phoneOverride('?sumika-phones'), phoneOverride(undefined)], [null, true, true, false, false, null, null]);
});

// ---------------------------------------------------------------- phoneMode

test('phoneMode: data-phone on / tucked / off; other values warn once; data-phone-always-off is no option', () => {
  const run = d => { const warns = []; return [phoneMode(d, m => warns.push(m)), warns.length]; };
  assert.deepEqual(run({}), ['on', 0], 'absent');
  assert.deepEqual(run(undefined), ['on', 0]);
  assert.deepEqual(run({ phone: '' }), ['on', 0], 'bare data-phone');
  assert.deepEqual(run({ phone: 'on' }), ['on', 0]);
  assert.deepEqual(run({ phone: 'tucked' }), ['tucked', 0]);
  assert.deepEqual(run({ phone: 'TUCKED ' }), ['tucked', 0], 'any case, trimmed');
  assert.deepEqual(run({ phone: 'off' }), ['off', 0], 'the give-up switch');
  assert.deepEqual(run({ phone: ' Off' }), ['off', 0]);
  assert.deepEqual(run({ phone: 'hidden' }), ['on', 1], 'an unknown data-phone: as absent, one warn');
  // data-phone-always-off is no option (it was dropped): data-phone="off" is the one switch
  assert.deepEqual(run({ phoneAlwaysOff: 'true' }), ['on', 0], 'no option: ignored, no warn');
  assert.deepEqual(run({ phoneAlwaysOff: 'true', phone: 'tucked' }), ['tucked', 0]);
});

// ---------------------------------------------------------------- offApi (UI §9.11 Off)

test('offApi: a frozen stub, phone "off", state "off" for reason "phone", no site or runtime; every promise resolves (start "none", the rest false), lists empty', async () => {
  const api = offApi('1.0.0');
  assert.ok(Object.isFrozen(api));
  assert.deepEqual([api.version, api.phone, api.state, api.reason, api.site, api.runtime], ['1.0.0', 'off', 'off', 'phone', null, null]);
  assert.equal(await api.start(), 'none');
  for (const k of ['callGhost', 'closeGhost', 'quit', 'changeGhost', 'changeShell', 'changeBalloon']) assert.equal(await api[k]('x'), false, k);
  assert.deepEqual([api.ghosts(), api.running(), api.shells(), api.balloons()], [[], [], [], { top: [], all: [] }]);
  // the members of the real window.sumika (main.js), so page code never throws, and why it is off
  assert.deepEqual(Object.keys(api).sort(), ['balloons', 'callGhost', 'changeBalloon', 'changeGhost', 'changeShell', 'closeGhost',
    'ghosts', 'phone', 'quit', 'reason', 'running', 'runtime', 'shells', 'site', 'start', 'state', 'version']);
  // the visitor's Off and the site's (core/choice.js): the same stub with main.js's phone mode and the reason
  const visitor = offApi('1.0.0', { phone: null, reason: 'visitor' });
  assert.deepEqual([visitor.phone, visitor.state, visitor.reason, visitor.site], [null, 'off', 'visitor', null]);
  assert.deepEqual(Object.keys(visitor).sort(), Object.keys(api).sort());
  assert.deepEqual([offApi('x', { phone: 'tucked', reason: 'site' }).phone, offApi('x', { phone: 'tucked', reason: 'site' }).reason], ['tucked', 'site']);
});

// ---------------------------------------------------------------- the launcher (UI §9.11 The button); fake DOM

test('Launcher, desktop unchanged: no phone option, bottom exactly 16 px (72 px in slot 1) and no inline right', () => {
  installFakeDom();
  const l = new Launcher({ name: 'Tsubasa' });
  l.show('closed');
  assert.equal(l.el.style.bottom, '16px');
  assert.equal(l.el.style.right, undefined, 'the CSS right: 16px');
  l.setSlot(1);
  assert.equal(l.el.style.bottom, '72px');
  assert.equal(l.el.getAttribute('aria-busy'), null);
  assert.ok(!l.el.classList.contains('smk-busy'));
  l.destroy();
});

test('Launcher, phone: the safe-area insets on bottom and right (iPhone home indicator, viewport-fit=cover)', () => {
  installFakeDom();
  const l = new Launcher({ name: 'Tsubasa', phone: true });
  l.show('tucked');
  assert.equal(l.el.style.bottom, 'calc(16px + env(safe-area-inset-bottom, 0px))');
  assert.equal(l.el.style.right, 'calc(16px + env(safe-area-inset-right, 0px))');
  l.setSlot(1);
  assert.equal(l.el.style.bottom, 'calc(72px + env(safe-area-inset-bottom, 0px))');
  const later = new Launcher({ name: 'Emily', phone: true, slot: 2 });
  later.show('minimized');
  assert.equal(later.el.style.bottom, 'calc(128px + env(safe-area-inset-bottom, 0px))', 'a slot set before the button exists');
  l.destroy();
  later.destroy();
});

test('Launcher tucked and busy: "Show X" in colour; setBusy dims it and a click does nothing; show() and hide() clear it', () => {
  installFakeDom();
  const got = [];
  const l = new Launcher({ name: 'Tsubasa', onActivate: m => got.push(m) });
  l.show('tucked');
  assert.equal(l.el.getAttribute('aria-label'), 'Show Tsubasa');
  assert.ok(!l.el.classList.contains('smk-closed'), 'in colour: smk-closed is the closed launcher\'s only');
  assert.match(getRoot().getElementById('style-launcher').textContent, /\.smk-launcher\.smk-busy\s*\{[^}]*opacity:\s*\.55;[^}]*cursor:\s*progress/);
  l.setBusy(true);
  assert.ok(l.el.classList.contains('smk-busy'));
  assert.equal(l.el.getAttribute('aria-busy'), 'true');
  const ev = l.el.fire('click');
  assert.ok(ev.propagationStopped);
  assert.deepEqual(got, [], 'a click while busy does nothing');
  assert.equal(l.visible, true);
  l.show('tucked');
  assert.ok(!l.el.classList.contains('smk-busy') && l.el.getAttribute('aria-busy') === null, 'show() clears it');
  l.setBusy(true);
  l.hide();
  assert.ok(!l.busy && !l.el.classList.contains('smk-busy') && l.el.getAttribute('aria-busy') === null, 'hide() clears it');
  l.show('tucked');
  l.el.fire('click');
  assert.deepEqual(got, ['tucked'], 'not busy: the click goes through');
  assert.equal(l.visible, false, 'the button hid itself');
  l.destroy();
});

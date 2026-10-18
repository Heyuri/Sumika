// src/ui/settings.js on phones (UI §9.11, §2.13): the Preferences box follows the visual viewport (an inline top at
// its middle and a max-height, never a left: the keyboard takes height only; nothing while the page is zoomed), the
// focused field is scrolled into view inside the box, and its fields are 16 px (iOS zooms into smaller ones). Without
// `phone` (every desktop) none of it: no inline left/top/max-height, no listener, the CSS's 13-px fields. On the fake
// DOM (tests/balloon/fake_dom.mjs), with a fake visualViewport set on globalThis.window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsWindow } from '../../src/ui/settings.js';
import { UserProfile } from '../../src/core/user.js';
import { memoryStorage } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { getRoot } from '../../src/ui/root.js';
import { installFakeDom, tick } from '../balloon/fake_dom.mjs';

setLogLevel('silent');
installFakeDom();

const PHONE = { short: 375, long: 812, mobileView: true };

/** an event target that counts its listeners (the window, its visualViewport) */
function target(props) {
  const l = {};
  return Object.assign({
    addEventListener(t, fn) { (l[t] ||= []).push(fn); },
    removeEventListener(t, fn) { l[t] = (l[t] || []).filter(f => f !== fn); },
    fire(t) { for (const fn of [...(l[t] || [])]) fn({ type: t }); },
    listeners: () => Object.values(l).reduce((n, a) => n + a.length, 0),
  }, props);
}

/** the fake DOM as a page of w×h CSS px whose window has a visualViewport; restore() puts the fake DOM's back */
function world(w, h) {
  const doc = globalThis.document, de = doc.documentElement;
  const saved = [globalThis.window, de.clientWidth, de.clientHeight];
  const vv = target({ width: w, height: h, offsetLeft: 0, offsetTop: 0, scale: 1 });
  const win = target({ innerWidth: w, innerHeight: h, visualViewport: vv, document: doc });
  globalThis.window = win;
  de.clientWidth = w;
  de.clientHeight = h;
  doc.activeElement = doc.body;
  return { win, vv, restore() { [globalThis.window, de.clientWidth, de.clientHeight] = saved; } };
}

async function view(vv, o, ev = 'resize') {
  Object.assign(vv, o);
  vv.fire(ev);
  await tick();
}

const boxes = () => globalThis.document.body.children.flatMap(h => (h.shadowRoot ? h.shadowRoot.querySelectorAll('.smk-settings') : []));

test('phone: the box\'s middle and max-height follow the visual viewport (the keyboard, a pan), never its left; 16-px fields', async () => {
  const w = world(375, 812);
  const sw = new SettingsWindow({ user: new UserProfile({ storage: memoryStorage() }), phone: PHONE });
  try {
    sw.open();
    const el = sw.el;
    assert.deepEqual(boxes(), [el]);
    const s = el.style;
    assert.deepEqual([s.top, s.maxHeight, 'left' in s], ['406px', '796px', false], 'the middle of 812, 812 − 16; the CSS\'s 50 % left');
    const inputs = el.querySelectorAll('input');
    assert.deepEqual(inputs.map(i => i.style.fontSize), ['16px', '16px', '16px', undefined, undefined, undefined],
      'Name, Nickname and Birthday: 16 px (iOS zooms into smaller fields); not the radios');
    assert.equal(globalThis.document.activeElement, inputs[0], 'the focus stays in Name');
    assert.deepEqual([w.vv.listeners(), w.win.listeners()], [2, 1]);
    // the keyboard: 400 px visible, the view panned 120 px down
    await view(w.vv, { height: 400 });
    await view(w.vv, { offsetTop: 120 }, 'scroll');
    assert.deepEqual([s.top, s.maxHeight, 'left' in s], ['320px', '384px', false], '120 + 400 / 2; 400 − 16');
    // very little left: at least 120 px
    await view(w.vv, { height: 100 });
    assert.deepEqual([s.top, s.maxHeight], ['170px', '120px']);
    // pinch zoom (and its pans): nothing moves
    for (const o of [{ scale: 2, width: 187.5, height: 200, offsetLeft: 150, offsetTop: 300 }, { offsetLeft: 0, offsetTop: 0 }]) {
      await view(w.vv, o, 'scroll');
      el.fire('focusin');
      assert.deepEqual([s.top, s.maxHeight, 'left' in s], ['170px', '120px', false]);
    }
    await view(w.vv, { scale: 1, width: 375, height: 400, offsetLeft: 0, offsetTop: 120 });
    assert.deepEqual([s.top, s.maxHeight], ['320px', '384px'], 'back at scale 1');
    // a field taking the focus fits the box again at once, and is scrolled into view inside its body (never the page)
    Object.assign(w.vv, { height: 300, offsetTop: 0 });
    const body = el.querySelectorAll('.smk-settings-body')[0];
    inputs[1].style.top = '500px';                                  // the fake DOM's layout: Nickname below the body
    inputs[1].focus();
    el.fire('focusin');
    assert.deepEqual([s.top, s.maxHeight], ['150px', '284px']);
    const br = body.getBoundingClientRect(), ir = inputs[1].getBoundingClientRect();
    assert.equal(body.scrollTop, ir.top + ir.height - (br.top + br.height));
    // closed: no listener; open again: watched again; destroy: none
    sw.close();
    assert.deepEqual([w.vv.listeners(), w.win.listeners()], [0, 0]);
    sw.open();
    assert.deepEqual([w.vv.listeners(), w.win.listeners()], [2, 1]);
    assert.equal(sw.el.style.top, '150px');
    sw.destroy();
    assert.deepEqual([w.vv.listeners(), w.win.listeners()], [0, 0]);
    await view(w.vv, { height: 812 });
  } finally {
    sw.destroy();
    w.restore();
  }
});

test('desktop unchanged: without phone at 1280×720 and 1920×1080, no inline left/top/max-height, no listener, the CSS\'s 13-px fields', async () => {
  for (const [vw, vh] of [[1280, 720], [1920, 1080]]) {
    for (const opt of [{}, { phone: null }]) {
      const w = world(vw, vh);
      const sw = new SettingsWindow({ user: new UserProfile({ storage: memoryStorage() }), ...opt });
      try {
        sw.open();
        const el = sw.el;
        assert.deepEqual(boxes(), [el]);
        const s = el.style;
        assert.deepEqual(['left' in s, 'top' in s, 'maxHeight' in s], [false, false, false]);
        assert.ok(el.querySelectorAll('input').every(i => !('fontSize' in i.style)), 'no inline font size');
        assert.deepEqual([w.vv.listeners(), w.win.listeners()], [0, 0], 'no listener on the visual viewport or the window');
        assert.deepEqual(Object.keys(el.listeners), ['keydown'], 'no focusin');
        await view(w.vv, { height: 300 });
        w.win.fire('resize');
        assert.deepEqual(['left' in s, 'top' in s, 'maxHeight' in s], [false, false, false]);
        const css = getRoot().getElementById('style-settings').textContent;
        assert.match(css, /\.smk-settings \{ position: fixed;[^}]*left: 50%; top: 50%; transform: translate\(-50%, -50%\);/);
        assert.match(css, /max-height: calc\(100vh - 32px\);[^}]*font: 13px\/1\.5 /, 'the box is 13 px');
        assert.match(css, /\.smk-settings input\[type="text"\], \.smk-settings input\[type="date"\] \{[^}]*font: inherit;/, 'so are its fields');
        sw.close();
        assert.equal(boxes().length, 0);
      } finally {
        sw.destroy();
        w.restore();
      }
    }
  }
});

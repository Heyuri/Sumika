// F3 (ssp-ui.md §9.11): the readme window's height follows the visible viewport on phones (100dvh: the browser's bars
// shown or hidden), declared after the desktop's 100vh line, which stays for browsers without dvh (dvh = vh on
// desktop). The style is read from the shadow root of the fake DOM (tests/balloon/fake_dom.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, FakeEl } from '../balloon/fake_dom.mjs';
import { setLogLevel } from '../../src/core/log.js';

installFakeDom();
setLogLevel('silent');
// InfoWindow looks its buttons up with querySelector, which the fake DOM leaves out
if (!FakeEl.prototype.querySelector) FakeEl.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
const { InfoWindow } = await import('../../src/ui/info.js');
const { getRoot } = await import('../../src/ui/root.js');

test('the readme window: max-height in 100dvh right after the 100vh line, in the window\'s own rule', () => {
  const w = new InfoWindow();
  w.open({ title: 'Readme', text: 'hello' });
  assert.ok(w.isOpen);
  const style = getRoot().getElementById('style-info');
  assert.ok(style, 'the stylesheet is in the shadow root');
  const css = style.textContent;
  const rule = css.slice(css.indexOf('.smk-info {'), css.indexOf('}', css.indexOf('.smk-info {')));
  const vh = 'max-height: min(640px, calc(100vh - 32px));';
  const dvh = 'max-height: min(640px, calc(100dvh - 32px));';
  assert.ok(rule.includes(vh), 'the desktop\'s line stays (browsers without dvh)');
  assert.ok(rule.includes(dvh), 'the dvh line');
  assert.ok(rule.indexOf(vh) < rule.indexOf(dvh), 'dvh after vh, so a browser that knows dvh uses it');
  assert.equal(rule.slice(rule.indexOf(vh) + vh.length).trimStart().indexOf(dvh), 0, 'right after it');
  assert.ok(rule.includes('width: min(560px, calc(100vw - 32px));'), 'the width is the desktop\'s');
  w.destroy();
});

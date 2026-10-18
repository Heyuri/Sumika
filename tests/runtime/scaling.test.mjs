// Shell scaling ▸ and Balloon scaling ▸ (UI §2.1 #8/#9, src/core/scaling.js): the percentage math (SSP's percentages
// are device pixels), the menu model (items, bullet, the display's marker), the picks (state, stage, balloons,
// OnShellScaling / OnBalloonScaling, Other percentage…), and persistence per ghost across page navigation and ghost
// changes through the runtime with fake parts.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCALE_STEPS, displayPercent, cssScale, effectivePercent, normPercent, normScaling, cssScales, UserScaling, OTHER_BOX_ID,
} from '../../src/core/scaling.js';
import { buildMenuModel, scaleItems, menuResourceIds, parseCaption, Menu } from '../../src/ui/menu.js';
import { Runtime } from '../../src/core/runtime.js';
import { StateStore, GhostLock, memoryStorage, stateKey } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';

setLogLevel('silent');

// ---------------------------------------------------------------- math

test('percentages are device pixels: p % = CSS scale (p/100)/dpr; no choice follows the display (CSS 1)', () => {
  assert.equal(displayPercent(1), 100);
  assert.equal(displayPercent(1.25), 125);
  assert.equal(displayPercent(1.5), 150);
  assert.equal(displayPercent(2.625), 263);
  assert.equal(cssScale(null, 1.25), 1, 'default: as the page is drawn');
  assert.equal(cssScale(100, 1.25), 0.8, '100 % on a 125 % display: one image pixel per device pixel');
  assert.equal(cssScale(200, 1.25), 1.6);
  assert.equal(cssScale(125, 1.25), 1);
  assert.equal(cssScale(150, 1), 1.5);
  assert.equal(cssScale(50, 2), 0.25);
  assert.equal(effectivePercent(null, 1.25), 125);
  assert.equal(effectivePercent(80, 1.25), 80);
  assert.deepEqual(cssScales({ shell: 100, balloon: null }, 1.25), { shell: 0.8, balloon: 1 });
});

test('what Other percentage… and the stored state accept: whole percentages from 10 to 500', () => {
  for (const [v, want] of [['150', 150], ['150%', 150], [' 75 % ', 75], ['１５０', 150], ['１２５％', 125], ['133.4', 133], [140, 140],
    ['10', 10], ['500', 500], ['9', null], ['501', null], ['abc', null], ['12abc', null], ['', null], [null, null], [true, null], [-50, null]]) {
    assert.equal(normPercent(v), want, String(v));
  }
  assert.deepEqual(normScaling({ shell: '200', balloon: 3 }), { shell: 200, balloon: null });
  assert.deepEqual(normScaling(undefined), { shell: null, balloon: null });
});

// ---------------------------------------------------------------- menu model

const labels = items => items.map(i => (i.kind === 'sep' ? '-' : parseCaption(i.label).text));
const bullet = items => items.filter(i => i.checked).map(i => i.label);
const marked = items => items.filter(i => i.note === 'display').map(i => i.label);

test('menu: Default (match display), Other percentage…, separator, then SSP\'s percentages; bullet and display marker', () => {
  const at125 = scaleItems('shell', null, 1.25);
  assert.deepEqual(labels(at125), ['Default (match display)', 'Other percentage...', '-',
    '300%', '275%', '250%', '225%', '200%', '175%', '166%', '150%', '133%', '125%', '100%', '80%', '75%', '66%', '50%', '33%', '25%', '20%']);
  assert.deepEqual(bullet(at125), ['125%'], 'no choice: the display\'s percentage is the one in effect');
  assert.deepEqual(marked(at125), ['125%']);
  assert.equal(at125[0].disabled, true, 'already following the display');
  assert.deepEqual(at125[0].action, { type: 'scale', target: 'shell', percent: null });
  assert.deepEqual(at125[1].action, { type: 'scale-other', target: 'shell' });
  assert.deepEqual(at125.find(i => i.label === '200%').action, { type: 'scale', target: 'shell', percent: 200 });
  assert.ok(at125.slice(3).every(i => i.radio && i.checked !== undefined), 'radio items: SSP\'s bullet');
  assert.match(at125.find(i => i.note).title, /display/);

  for (const [dpr, p] of [[1, '100%'], [1.5, '150%'], [2, '200%'], [3, '300%']]) {
    const m = scaleItems('balloon', null, dpr);
    assert.deepEqual([bullet(m), marked(m)], [[p], [p]], `dpr ${dpr}`);
    assert.equal(m.length, 3 + SCALE_STEPS.length, 'nothing added');
  }
  // a display percentage SSP does not list (110 %) and an Other percentage (140 %) join the list in order
  const odd = scaleItems('shell', 140, 1.1);
  assert.deepEqual(labels(odd).slice(10, 15), ['150%', '140%', '133%', '125%', '110%']);
  assert.deepEqual(bullet(odd), ['140%']);
  assert.deepEqual(marked(odd), ['110%']);
  assert.equal(odd[0].disabled, false);
  // an explicit choice equal to the display's: the same row, but Default is offered (it would follow zoom again)
  const same = scaleItems('shell', 125, 1.25);
  assert.deepEqual([bullet(same), marked(same), same[0].disabled], [['125%'], ['125%'], false]);
});

test('menu: Shell scaling ▸ and Balloon scaling ▸ come right before Utilities, main menu only; captions and visibility from the ghost', () => {
  const scaling = { shell: null, balloon: 80, dpr: 1.25 };
  const m = buildMenuModel(0, new Map(), { scaling });
  assert.deepEqual(m.map(i => (i.kind === 'sep' ? '-' : i.label)), ['&Recommendations', 'Por&tal site', '-',
    'Sh&ell scaling', 'Balloon scaling (&D)', 'Utilities (&F)', '-', '&Iconify', '-', 'Close (&W)', 'Quit (&X)']);
  const shellSub = items => items.find(i => i.kind === 'sub' && i.items.some(x => x.action && x.action.target === 'shell'));
  const balloonSub = items => items.find(i => i.kind === 'sub' && i.items.some(x => x.action && x.action.target === 'balloon'));
  assert.deepEqual(bullet(shellSub(m).items), ['125%']);
  assert.deepEqual(bullet(balloonSub(m).items), ['80%']);
  const site = new Map([['sakura.portalsites', 'Home\x01http://h.example/\x01\x02']]);
  assert.deepEqual(buildMenuModel(0, site, { scaling }).map(i => (i.kind === 'sep' ? '-' : parseCaption(i.label).text)).slice(1, 6),
    ['Portal site', '-', 'Shell scaling', 'Balloon scaling (D)', 'Utilities (F)']);
  const renamed = buildMenuModel(0, new Map([
    ['shellscalerootbutton.caption', 'Her size(&S)'], ['shellscaleotherbutton.caption', 'Some other size(&O)'],
    ['balloonscalerootbutton.visible', '0'],
  ]), { scaling });
  assert.equal(shellSub(renamed).label, 'Her size(&S)');
  assert.equal(shellSub(renamed).items[1].label, 'Some other size(&O)');
  assert.equal(balloonSub(renamed).disabled, true, 'visible 0 greys it in place (UI §2.11)');
  assert.ok(!shellSub(renamed).disabled);
  // every *.caption has a *.visible (U-res caption_visible): a ghost may grey Other percentage…
  const noOther = buildMenuModel(0, new Map([['shellscaleotherbutton.visible', '0']]), { scaling });
  assert.deepEqual(labels(shellSub(noOther).items).slice(0, 3), ['Default (match display)', 'Other percentage...', '-']);
  assert.equal(shellSub(noOther).items[1].disabled, true);
  assert.equal(balloonSub(noOther).items[1].disabled, undefined, 'the balloon one has its own resource');
  const noBalloonOther = buildMenuModel(0, new Map([['balloonscaleotherbutton.visible', '0']]), { scaling });
  assert.ok(balloonSub(noBalloonOther).items.find(i => i.action && i.action.type === 'scale-other').disabled);
  assert.ok(!shellSub(noBalloonOther).items.find(i => i.action && i.action.type === 'scale-other').disabled);
  // minimized, induction or passive mode (enable level ≥ 2) greys both [disasm]
  assert.ok([shellSub, balloonSub].every(f => f(buildMenuModel(0, new Map(), { scaling, enableLevel: 2 })).disabled));
  assert.ok(!buildMenuModel(0, new Map()).some(i => /scaling/.test(i.label)), 'no scaling info: no submenus (older callers)');
  assert.ok(!buildMenuModel(1, new Map(), { scaling }).some(i => /scaling/.test(i.label || '')), 'not in the abbreviated menu');
  for (const id of ['shellscalerootbutton.visible', 'shellscalerootbutton.caption', 'shellscaleotherbutton.visible', 'shellscaleotherbutton.caption',
    'balloonscalerootbutton.visible', 'balloonscalerootbutton.caption', 'balloonscaleotherbutton.visible', 'balloonscaleotherbutton.caption']) {
    assert.ok(menuResourceIds(0).includes(id), id);
    assert.ok(!menuResourceIds(1).includes(id), id);
  }
});

test('menu picks go to the scaling: a percentage, Default, Other percentage… with the menu\'s scope', () => {
  const calls = [];
  const scaling = { info: () => ({}), set: (...a) => calls.push(['set', ...a]), askOther: (...a) => { calls.push(['other', ...a]); return Promise.resolve(); } };
  const menu = new Menu({ host: {}, scaling });
  menu._run({ type: 'scale', target: 'shell', percent: 200 }, 0);
  menu._run({ type: 'scale', target: 'balloon', percent: null }, 0);
  menu._run({ type: 'scale-other', target: 'balloon' }, 0);
  assert.deepEqual(calls, [['set', 'shell', 200], ['set', 'balloon', null], ['other', 'balloon', 0]]);
});

// ---------------------------------------------------------------- UserScaling

class ScaleTarget {
  constructor(scale = 1) { this.scale = scale; this.calls = []; this.refreshed = 0; }
  setScale(s) { this.calls.push(s); this.scale = s; }
  refreshResolution() { this.refreshed++; }
}

function scalingWith({ dpr = 1.25, data = {} } = {}) {
  const state = new StateStore('g', { storage: memoryStorage() });
  Object.assign(state.data, data);
  let changes = 0;
  const change = state.change.bind(state);
  state.change = () => { changes++; change(); };
  const stage = new ScaleTarget(), balloons = new ScaleTarget(), dialogs = new FakeDialogs();
  const sent = [];
  const host = { send: async (id, refs) => { sent.push([id, ...refs]); return null; } };
  const box = { dpr };
  const s = new UserScaling({ state, stage, balloons, dialogs, host, dpr: () => box.dpr });
  return { s, state, stage, balloons, dialogs, sent, box, changes: () => changes };
}

test('a pick is stored in the ghost state, applied to the stage or the balloons, and sent as OnShellScaling / OnBalloonScaling [new, old, new, old]', async () => {
  const t = scalingWith();
  assert.deepEqual(t.s.info(), { shell: null, balloon: null, dpr: 1.25 });
  assert.equal(t.s.set('shell', 200), true);
  await settle();
  assert.deepEqual(t.state.data.scaling, { shell: 200, balloon: null });
  assert.deepEqual(t.stage.calls, [1.6]);
  assert.deepEqual(t.balloons.calls, [1]);
  assert.deepEqual(t.sent, [['OnShellScaling', 200, 125, 200, 125]]);
  assert.equal(t.changes(), 1);
  t.s.set('balloon', 100);
  await settle();
  assert.equal(t.balloons.scale, 0.8);
  assert.deepEqual(t.sent.at(-1), ['OnBalloonScaling', 100, 125, 100, 125]);
  t.s.set('shell', null);                                // Default (match display)
  await settle();
  assert.equal(t.stage.scale, 1);
  assert.deepEqual(t.sent.at(-1), ['OnShellScaling', 125, 200, 125, 200]);
  const n = t.sent.length;
  t.s.set('shell', 125);                                 // same size as the display's: stored, but nothing changed on screen
  await settle();
  assert.equal(t.state.data.scaling.shell, 125);
  assert.equal(t.sent.length, n, 'no event when the size in effect stays');
  assert.equal(t.s.set('shell', 9000), false);
  assert.equal(t.s.set('dress', 100), false);
  assert.equal(t.state.data.scaling.shell, 125);
  // page zoom / another monitor: an explicit percentage keeps its device-pixel size, the default zooms with the page
  t.box.dpr = 2.5;
  t.s.apply();
  assert.equal(t.stage.scale, 0.5);
  assert.equal(t.balloons.scale, 0.4);
});

test('the window\'s devicePixelRatio changing re-applies the scales (resize)', () => {
  const t = scalingWith({ data: { scaling: { shell: 100, balloon: null } } });
  const l = {};
  const win = { addEventListener: (k, f) => { l[k] = f; }, removeEventListener: k => { delete l[k]; } };
  t.s.bindWindow(win);
  l.resize();
  assert.deepEqual(t.stage.calls, [], 'same ratio: nothing to do');
  assert.deepEqual([t.stage.refreshed, t.balloons.refreshed], [0, 0]);
  t.box.dpr = 1.5;
  l.resize();
  assert.equal(t.stage.scale, 100 / 100 / 1.5);
  assert.equal(t.balloons.scale, 1, 'the default balloon scale stays CSS 1 ...');
  assert.deepEqual([t.stage.refreshed, t.balloons.refreshed], [1, 1], '... so both are told to redraw at the new resolution');
  t.s.destroy();
  assert.equal(l.resize, undefined);
});

test('Other percentage… asks with the input box; a number is kept within 10 to 500 and applied, other text asks again', async () => {
  const t = scalingWith();
  let p = t.s.askOther('shell', 0);
  const box = t.dialogs.boxes.at(-1);
  assert.equal(box.o.id, OTHER_BOX_ID);
  assert.equal(box.o.defaultText, '125', 'starts from the percentage in effect');
  assert.equal(box.o.scope, 0);
  assert.equal(box.o.placeholder, '10–500 %', 'the range shows in an emptied field');
  assert.equal(box.o.pulse, false);
  box.resolve({ text: '１５０％', timedOut: false, reason: 'ok' });
  assert.equal(await p, true);
  assert.equal(t.state.data.scaling.shell, 150);
  assert.equal(t.stage.scale, 1.2);
  p = t.s.askOther('shell', 0);
  assert.equal(t.dialogs.boxes.at(-1).o.defaultText, '150');
  t.dialogs.boxes.at(-1).resolve({ text: '1000', reason: 'ok' });
  assert.equal(await p, true, 'out of range: the nearest end, not a silent no-op');
  assert.equal(t.state.data.scaling.shell, 500);
  p = t.s.askOther('shell', 0);
  t.dialogs.boxes.at(-1).resolve({ text: '3', reason: 'ok' });
  assert.equal(await p, true);
  assert.equal(t.state.data.scaling.shell, 10);
  // no number: the box comes back with the text, pulsing; a number then applies
  const n = t.dialogs.boxes.length;
  p = t.s.askOther('shell', 0);
  t.dialogs.boxes.at(-1).resolve({ text: 'big', reason: 'ok' });
  await settle();
  assert.equal(t.dialogs.boxes.length, n + 2, 'asked again');
  const again = t.dialogs.boxes.at(-1).o;
  assert.deepEqual([again.id, again.defaultText, again.pulse], [OTHER_BOX_ID, 'big', true]);
  assert.equal(t.state.data.scaling.shell, 10, 'nothing applied yet');
  t.dialogs.boxes.at(-1).resolve({ text: '', reason: 'ok' });
  await settle();
  assert.equal(t.dialogs.boxes.length, n + 3, 'an empty field is no number either');
  t.dialogs.boxes.at(-1).resolve({ text: '175', reason: 'ok' });
  assert.equal(await p, true);
  assert.equal(t.state.data.scaling.shell, 175);
  p = t.s.askOther('shell', 0);
  t.dialogs.boxes.at(-1).resolve({ text: 'x', reason: 'ok' });
  await settle();
  t.dialogs.boxes.at(-1).resolve({ text: null, reason: 'cancel' });
  assert.equal(await p, false, 'cancelled on the second ask');
  assert.equal(t.state.data.scaling.shell, 175);
  t.s.set('shell', 150);
  p = t.s.askOther('balloon', 0);
  t.dialogs.boxes.at(-1).resolve({ text: null, reason: 'cancel' });
  assert.equal(await p, false);
  assert.deepEqual(t.state.data.scaling, { shell: 150, balloon: null });
  // the ghost went away while the box was open: nothing is applied
  p = t.s.askOther('balloon', 0);
  t.s.destroy();
  t.dialogs.boxes.at(-1).resolve({ text: '50', reason: 'ok' });
  assert.equal(await p, false);
  assert.equal(t.state.data.scaling.balloon, null);
});

// ---------------------------------------------------------------- the runtime: per ghost, resume, ghost changes

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/ghosts.json'), 'utf8'));

class ScaledStage extends FakeStage {
  constructor(scale) { super(); this.scale = scale; }
  defaultSurface(s) { return s === 0 ? 0 : 10; }
  setScale(s) { this.scale = s; }
  destroy() {}
}
class ScaledBalloons extends FakeBalloons {
  constructor(scale) { super(); this.scale = scale; }
  setScale(s) { this.scale = s; }
  destroy() {}
}

const LIVE = new Set();
afterEach(() => { for (const rt of LIVE) rt.done(); });

class TestRuntime extends Runtime {
  constructor(w) {
    super({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js', defaultGhost: 'tsubasa', Channel: null });
    this.w = w;
    this.index = w.index;
    this.made = [];
    LIVE.add(this);
  }
  _newLock(id) { return new GhostLock(id, { locks: null, Channel: null }); }
  async _ghostCommon() {
    const g = this.ghost;
    return { files: { url: p => `http://s/ghost/${g.id}/${p}`, has: () => false, list: () => [] }, ghostDescript: new Map([['name', g.name]]), shellId: 'master' };
  }
  async _startEngine() {
    const sh = new FakeShiori(() => null);
    sh.ghost = this.ghost.id;
    sh.terminate = () => {};
    this.w.engines.push(sh);
    return { client: sh, r: { hadSave: true } };
  }
  async _createStage(o) { const s = new ScaledStage(o.scale); this.made.push({ ghost: this.ghost.id, kind: 'stage', scale: o.scale }); return s; }
  async _loadSkin() { return { skin: { balloon: () => null }, name: '', path: '' }; }
  async _createBalloons(o) { this.made.push({ ghost: this.ghost.id, kind: 'balloons', scale: o.scale }); return new ScaledBalloons(o.scale); }
  _createDialogs() { return new FakeDialogs(); }
  _createPlayer() { return new FakePlayer(); }
  scalesMade() { return this.made.slice(-2).map(m => [m.ghost, m.kind, m.scale]); }
  done() { LIVE.delete(this); this._teardown(); if (this.lock) this.lock.dispose(); }
}

test('runtime: the choice is per ghost; it survives page navigation (resume) and switching away and back', async () => {
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  globalThis.devicePixelRatio = 1.25;
  try {
    const index = { base: 'http://s/', ghosts: SITE.ghosts, balloons: [], ghost: id => SITE.ghosts.find(g => g.id === id) || null, balloon: () => null };
    const w = { index, engines: [] };
    const rt = new TestRuntime(w);
    assert.equal(await rt.start(), 'booted');
    assert.deepEqual(rt.scalesMade(), [['tsubasa', 'stage', 1], ['tsubasa', 'balloons', 1]], 'nothing chosen: as the page is drawn');
    rt.parts.scaling.set('shell', 200);
    rt.parts.scaling.set('balloon', 100);
    await settle();
    assert.equal(rt.parts.stage.scale, 1.6);
    assert.equal(rt.parts.balloons.scale, 0.8);
    const sh = w.engines.at(-1);
    assert.deepEqual(sh.find('OnShellScaling')[0].refs, [200, 125, 200, 125]);
    assert.deepEqual(sh.find('OnBalloonScaling')[0].refs, [100, 125, 100, 125]);

    // a link is followed: the next page resumes with the same sizes
    rt._onPageHide();
    rt.done();
    assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(stateKey('tsubasa'))).scaling, { shell: 200, balloon: 100 });
    const rt2 = new TestRuntime(w);
    assert.equal(await rt2.start(), 'booted');
    assert.deepEqual(rt2.scalesMade(), [['tsubasa', 'stage', 1.6], ['tsubasa', 'balloons', 0.8]]);
    assert.equal(w.engines.at(-1).find('OnBoot').length, 0, 'it was a resume');

    // another ghost has its own (none yet); switching back brings Tsubasa's again
    assert.equal(await rt2.changeGhost('testghost'), true);
    assert.deepEqual(rt2.scalesMade(), [['testghost', 'stage', 1], ['testghost', 'balloons', 1]]);
    rt2.parts.scaling.set('shell', 50);
    assert.equal(await rt2.changeGhost('tsubasa'), true);
    assert.deepEqual(rt2.scalesMade(), [['tsubasa', 'stage', 1.6], ['tsubasa', 'balloons', 0.8]]);
    assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(stateKey('testghost'))).scaling, { shell: 50, balloon: null });
    // the menu of the running ghost shows its own choice
    assert.deepEqual(rt2.parts.menu.scaling.info(), { shell: 200, balloon: 100, dpr: 1.25 });
  } finally {
    delete globalThis.devicePixelRatio;
  }
});

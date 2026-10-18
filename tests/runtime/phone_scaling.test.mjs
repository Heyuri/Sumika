// Phones (ssp-ui §9.11 Item 1, "UserScaling"): UserScaling with `phone` takes the Stage's and the Balloons' fit
// (fitScale) as the no-pick default: scales(), info().fit, the percentages OnShellScaling / OnBalloonScaling carry,
// Other percentage…'s start and refit(); Shell / Balloon scaling ▸ show it as "Default (fit to screen)". Without
// `phone` (every desktop window) both are exactly the desktop's: the events of scaling.test.mjs and a copy of the
// desktop scaleItems as the reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UserScaling, cssScales, SCALE_STEPS, displayPercent, effectivePercent, normPercent,
} from '../../src/core/scaling.js';
import { scaleItems, buildMenuModel, parseCaption } from '../../src/ui/menu.js';
import { t } from '../../src/core/i18n.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { FakeDialogs, settle } from './fakes.mjs';

setLogLevel('silent');

const PHONE = Object.freeze({ short: 375, long: 812, mobileView: true });

/** a Stage or Balloons as UserScaling sees them: the fit they computed, setScale recorded */
class Target {
  constructor(fitScale) { this.fitScale = fitScale; this.scale = 1; this.calls = []; this.refreshed = 0; }
  setScale(s) { this.calls.push(s); this.scale = s; }
  refreshResolution() { this.refreshed++; }
}

function make({ phone = PHONE, dpr = 2, data = {}, fit = { shell: 0.69, balloon: 1 } } = {}) {
  const state = new StateStore('g', { storage: memoryStorage() });
  Object.assign(state.data, data);
  const stage = new Target(fit.shell), balloons = new Target(fit.balloon), dialogs = new FakeDialogs();
  const sent = [];
  const host = { send: async (id, refs) => { sent.push([id, ...refs]); return null; } };
  const box = { dpr };
  // the runtime passes `phone` only on phones: no key at all on desktop
  const s = new UserScaling({ state, stage, balloons, dialogs, host, dpr: () => box.dpr, ...(phone ? { phone } : {}) });
  return { s, state, stage, balloons, dialogs, sent, box };
}

// ---------------------------------------------------------------- UserScaling on a phone

test('phone: no pick is the fit (Tsubasa 138 % at dpr 2, the balloon 200 %); a pick sends [new, old, new, old] from the fit', async () => {
  const p = make();
  assert.deepEqual(p.s.scales(), { shell: 0.69, balloon: 1 });
  assert.deepEqual(p.s.info(), { shell: null, balloon: null, dpr: 2, fit: { shell: 138, balloon: 200 } });
  p.s.apply();
  assert.deepEqual([p.stage.calls, p.balloons.calls], [[0.69], [1]]);
  assert.equal(p.s.set('shell', 200), true);
  await settle();
  assert.deepEqual(p.state.data.scaling, { shell: 200, balloon: null });
  assert.equal(p.stage.scale, 1);
  assert.deepEqual(p.sent, [['OnShellScaling', 200, 138, 200, 138]]);
  p.s.set('shell', null);                                // Default (fit to screen)
  await settle();
  assert.equal(p.stage.scale, 0.69);
  assert.deepEqual(p.sent.at(-1), ['OnShellScaling', 138, 200, 138, 200]);
  assert.equal(p.state.data.scaling.shell, null, 'the fit is never stored');
  const n = p.sent.length;
  p.s.set('shell', 138);                                 // the fit's own size picked: stored, nothing changed on screen
  await settle();
  assert.equal(p.state.data.scaling.shell, 138);
  assert.equal(p.sent.length, n, 'no event when the size in effect stays');
  p.s.set('balloon', 100);
  await settle();
  assert.equal(p.balloons.scale, 0.5);
  assert.deepEqual(p.sent.at(-1), ['OnBalloonScaling', 100, 200, 100, 200]);
});

test('phone: Other percentage… starts from the fit; a stored pick ignores it (boot, resume)', async () => {
  const p = make();
  let r = p.s.askOther('shell', 0);
  assert.equal(p.dialogs.boxes.at(-1).o.defaultText, '138');
  p.dialogs.boxes.at(-1).resolve({ text: null, reason: 'cancel' });
  assert.equal(await r, false);
  r = p.s.askOther('balloon', 0);
  assert.equal(p.dialogs.boxes.at(-1).o.defaultText, '200');
  p.dialogs.boxes.at(-1).resolve({ text: null, reason: 'cancel' });
  await r;
  const q = make({ data: { scaling: { shell: 150, balloon: 50 } } });
  assert.deepEqual(q.s.scales(), { shell: 0.75, balloon: 0.25 });
  assert.deepEqual(q.s.info(), { shell: 150, balloon: 50, dpr: 2, fit: { shell: 138, balloon: 200 } }, 'the menu still knows the fit');
  r = q.s.askOther('shell', 0);
  assert.equal(q.dialogs.boxes.at(-1).o.defaultText, '150');
  q.dialogs.boxes.at(-1).resolve({ text: null, reason: 'cancel' });
  await r;
});

test('phone: refit() applies a new fit (a balloon change) without an event; a pick still wins; a dpr change keeps the CSS factor', async () => {
  const p = make();
  p.balloons.fitScale = 0.9;                             // setSkin computed another balloon's fit
  p.s.refit();
  await settle();
  assert.deepEqual([p.stage.calls, p.balloons.calls], [[0.69], [0.9]], 'setScale once each');
  assert.deepEqual(p.sent, [], 'no OnShellScaling / OnBalloonScaling for a fit');
  assert.equal(p.s.info().fit.balloon, 180);
  const q = make({ data: { scaling: { shell: 100, balloon: null } } });
  q.s.refit();
  assert.deepEqual(q.stage.calls, [0.5], 'the pick, not the fit');
  // page zoom / another monitor: the fit is a CSS factor and stays; its percentage follows the display
  p.box.dpr = 3;
  p.s.apply();
  assert.equal(p.stage.scale, 0.69);
  assert.equal(p.s.info().fit.shell, 207);
  // a phone whose stage and balloons have no fit (not a mobile page): the display's, as on desktop
  const none = make({ fit: { shell: null, balloon: null } });
  assert.deepEqual(none.s.scales(), { shell: 1, balloon: 1 });
  assert.deepEqual(none.s.info(), { shell: null, balloon: null, dpr: 2, fit: { shell: null, balloon: null } });
  none.s.set('shell', 200);
  await settle();
  assert.deepEqual(none.sent, [], '200 % is already the display\'s');
});

// ---------------------------------------------------------------- desktop unchanged

test('desktop unchanged: without `phone` UserScaling ignores any fitScale; info, scales, events and refit are the desktop\'s', async () => {
  for (const fit of [{ shell: null, balloon: null }, { shell: 0.69, balloon: 0.9 }]) {
    const d = make({ phone: null, dpr: 1.25, fit });
    assert.equal('phone' in d.s ? !!d.s.phone : false, false);
    assert.deepEqual(d.s.info(), { shell: null, balloon: null, dpr: 1.25 });
    assert.deepEqual(d.s.scales(), cssScales({ shell: null, balloon: null }, 1.25));
    d.s.refit();
    assert.deepEqual([d.stage.calls, d.balloons.calls], [[], []], 'refit makes no call');
    // scaling.test.mjs 154–185
    assert.equal(d.s.set('shell', 200), true);
    await settle();
    assert.deepEqual(d.stage.calls, [1.6]);
    assert.deepEqual(d.balloons.calls, [1]);
    assert.deepEqual(d.sent, [['OnShellScaling', 200, 125, 200, 125]]);
    d.s.set('balloon', 100);
    await settle();
    assert.equal(d.balloons.scale, 0.8);
    assert.deepEqual(d.sent.at(-1), ['OnBalloonScaling', 100, 125, 100, 125]);
    d.s.set('shell', null);
    await settle();
    assert.equal(d.stage.scale, 1);
    assert.deepEqual(d.sent.at(-1), ['OnShellScaling', 125, 200, 125, 200]);
    const n = d.sent.length;
    d.s.set('shell', 125);
    await settle();
    assert.equal(d.sent.length, n);
    d.box.dpr = 2.5;
    d.s.apply();
    assert.deepEqual([d.stage.scale, d.balloons.scale], [0.5, 0.4]);
    assert.deepEqual(d.s.scales(), cssScales(d.state.data.scaling, 2.5));
    const r = d.s.askOther('balloon', 0);
    assert.equal(d.dialogs.boxes.at(-1).o.defaultText, '100');
    d.dialogs.boxes.at(-1).resolve({ text: null, reason: 'cancel' });
    await r;
  }
  const e = make({ phone: null, dpr: 1.25 });
  const r = e.s.askOther('shell', 0);
  assert.equal(e.dialogs.boxes.at(-1).o.defaultText, '125', 'the display\'s percentage, as on a desktop');
  e.dialogs.boxes.at(-1).resolve({ text: null, reason: 'cancel' });
  await r;
});

// ---------------------------------------------------------------- the menu

/** scaleItems without the phone fit (a copy of menu.js's desktop path): the desktop reference */
function todayScaleItems(target, percent, dpr, { other = null, otherLang, otherVisible = true, lang = 'en' } = {}) {
  const chosen = normPercent(percent);
  const disp = displayPercent(dpr);
  const now = effectivePercent(chosen, dpr);
  const list = [...new Set([...SCALE_STEPS, disp, now])].sort((a, b) => b - a);
  const otherItem = { kind: 'item', label: other ?? t('menu.scale.other', lang), action: { type: 'scale-other', target } };
  if (other != null && otherLang !== undefined) otherItem.lang = otherLang;
  if (!otherVisible) otherItem.disabled = true;
  return [
    { kind: 'item', label: t('menu.scale.default', lang), disabled: chosen === null, action: { type: 'scale', target, percent: null } },
    otherItem,
    { kind: 'sep' },
    ...list.map(p => ({
      kind: 'item', label: `${p}%`, checked: p === now, radio: true, note: p === disp ? t('menu.scale.display', lang) : null,
      title: p === disp ? t('menu.scale.displayTitle', lang, { p }) : null,
      action: { type: 'scale', target, percent: p },
    })),
  ];
}

const bullet = items => items.filter(i => i.checked).map(i => i.label);
const marked = items => items.filter(i => i.note === 'display' || i.note === '画面').map(i => i.label);

test('menu: the fit carries the bullet, Default reads "fit to screen" and stays greyed while nothing is picked', () => {
  const m = scaleItems('shell', null, 2, { fit: 138 });
  assert.deepEqual(bullet(m), ['138%']);
  assert.deepEqual(marked(m), ['200%'], 'the display note stays on the display\'s percentage');
  assert.equal(m[0].label, '&Default (fit to screen)');
  assert.equal(m[0].disabled, true);
  assert.deepEqual(m[0].action, { type: 'scale', target: 'shell', percent: null });
  assert.equal(m.length, 3 + SCALE_STEPS.length + 1, 'the fit\'s row joins the list');
  const ja = scaleItems('shell', null, 2, { fit: 138, lang: 'ja' });
  assert.equal(ja[0].label, '標準(画面に合わせる) (&D)');
  assert.equal(parseCaption(ja[0].label).key, parseCaption(m[0].label).key);
  assert.deepEqual(marked(ja), ['200%']);
  const picked = scaleItems('shell', 150, 2, { fit: 138 });
  assert.deepEqual([bullet(picked), picked[0].disabled, picked[0].label], [['150%'], false, '&Default (fit to screen)']);
  // the balloon's fit of 1 is the display's own percentage: one row, bullet and note
  const b = scaleItems('balloon', null, 2, { fit: 200 });
  assert.deepEqual([bullet(b), marked(b), b.length], [['200%'], ['200%'], 3 + SCALE_STEPS.length]);
});

test('desktop unchanged: without `fit`, scaleItems is the desktop\'s at dpr 1, 1.25 and 2', () => {
  const captions = [{}, { lang: 'ja' }, { other: 'Her size(&S)', otherLang: '' }, { otherVisible: false }, { fit: null }, { fit: undefined }];
  for (const dpr of [1, 1.25, 2]) {
    for (const target of ['shell', 'balloon']) {
      for (const percent of [null, 140, 125, 200, 9000]) {
        for (const c of captions) {
          const { fit, ...rest } = c;
          assert.deepEqual(scaleItems(target, percent, dpr, c), todayScaleItems(target, percent, dpr, rest), `${target} ${percent} at ${dpr} ${JSON.stringify(c)}`);
        }
      }
      assert.deepEqual(scaleItems(target, null, dpr), todayScaleItems(target, null, dpr));
    }
  }
});

test('menu: Shell scaling ▸ / Balloon scaling ▸ read info().fit; a desktop info() (no fit) gives the desktop submenus', () => {
  const sub = (items, target) => items.find(i => i.kind === 'sub' && i.items.some(x => x.action && x.action.target === target)).items;
  const phoneInfo = make().s.info();
  const m = buildMenuModel(0, new Map(), { scaling: phoneInfo });
  assert.deepEqual([bullet(sub(m, 'shell')), sub(m, 'shell')[0].label], [['138%'], '&Default (fit to screen)']);
  assert.deepEqual([bullet(sub(m, 'balloon')), sub(m, 'balloon')[0].label], [['200%'], '&Default (fit to screen)']);
  const deskInfo = make({ phone: null, dpr: 1.25 }).s.info();
  const d = buildMenuModel(0, new Map(), { scaling: deskInfo });
  for (const target of ['shell', 'balloon']) assert.deepEqual(sub(d, target), todayScaleItems(target, null, 1.25));
});

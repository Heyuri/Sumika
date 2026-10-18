// The phone wiring (UI §9.11 Items 1–3, "Safe area"): what the runtime passes to the stage, the balloons, the
// boxes, Shell / Balloon scaling, the Preferences box and the launcher. On the synthetic site of multi_world.mjs (x has
// two shells: Tsubasa's sizes and bthver.5 master's; the site has two balloons, one wider than a 375-px phone), real
// headless Stages, recording stand-ins for the balloons and boxes. Desktop (site.phone null) at desks 1280×720 and
// 1920×1080: exactly the desktop options (no `phone` key anywhere, `scale` from cssScales, no refit). A phone: `phone`
// everywhere, and a `scale` only for a stored pick: with none the stage and the balloons stand at their own fit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore, runtimePrefs } from '../../src/core/state.js';
import { UserScaling, cssScale } from '../../src/core/scaling.js';
import { balloonFit } from '../../src/balloon/placement.js';
import { setLogLevel } from '../../src/core/log.js';
import { installFakeDom } from '../balloon/fake_dom.mjs';
import { sizedStage } from '../shell/helpers.mjs';
import { FakeBalloons, FakeDialogs, settle } from './fakes.mjs';
import { world, ghost, TestSite, TestRuntime, eng, up } from './multi_world.mjs';

setLogLevel('silent');

const PHONE = Object.freeze({ short: 375, long: 812, mobileView: true });
/** \0 and \1 of x's shells (image px): master = Tsubasa's (138 % at 375×812 dpr 2), tall = bthver.5 master's (81 %) */
const SHELLS = { master: { 0: [220, 380], 10: [4, 4] }, tall: { 0: [348, 645], 10: [4, 4] } };
const GHOSTS = [
  ghost('x', { shells: [{ id: 'master', name: 'x-shell' }, { id: 'tall', name: 'x-tall' }], icon: 'ghost/x/x.ico', iconMinimize: 'ghost/x/min.png' }),
  ghost('y', { icon: 'ghost/y/y.ico' }),
];
/** a balloon skin as balloonFit reads it: its widest balloonsN and its font */
const skin = (id, w) => ({
  name: id, descript: new Map([['name', id]]), isFallback: false, balloon: () => null,
  images: new Map([['balloons0', { w, h: 170 }]]), font: { height: 12 },
});
const SKINS = { narrow: skin('narrow', 340), wide: skin('wide', 400) };     // fit at 375: 1 and 11/12 (the 11-px floor)

/** Balloons' scale rules (manager.js: fitScale on phones, a pick wins, setSkin computes it again) and setScale calls. */
class FitBalloons extends FakeBalloons {
  constructor(o) {
    super();
    this.phone = o.phone || null;
    this.skin = o.skin;
    this.fitScale = this.phone ? balloonFit(o.skin, this.phone) : null;
    this.scale = o.scale > 0 ? o.scale : (this.fitScale ?? 1);
    this.scales = [];
  }
  setSkin(s) { super.setSkin(s); if (this.phone) this.fitScale = balloonFit(s, this.phone); }
  setScale(s) { this.scales.push(s); this.scale = s; }
}

/** TestRuntime that records the options of every stage, balloons and dialogs it makes (w.made). */
class WiringRuntime extends TestRuntime {
  async _createStage(opts) {
    this.w.made.push({ ghost: this.ghost.id, kind: 'stage', opts });
    const { files, ...rest } = opts;
    const s = await sizedStage({ sizes: SHELLS[opts.shellId] || SHELLS.master, desk: this.w.desk, ...rest });
    this.w.stages.push({ rt: this, s });
    return s;
  }
  async _loadSkin() { return { skin: SKINS.narrow, id: 'narrow', name: 'narrow', path: '' }; }
  async _balloonSkin(files) { return SKINS[files.id]; }
  async _createBalloons(opts) {
    this.w.made.push({ ghost: this.ghost.id, kind: 'balloons', opts });
    return new FitBalloons(opts);
  }
  _createDialogs(opts) {
    this.w.made.push({ ghost: this.ghost.id, kind: 'dialogs', opts });
    return new FakeDialogs();
  }
}

/** The site of x and y with the balloons narrow (the site default) and wide; desk: the stages' desk. */
function wiringWorld(desk = { w: 375, h: 660 }) {
  const w = world({ ghosts: GHOSTS });
  const balloons = [{ id: 'narrow', name: 'narrow' }, { id: 'wide', name: 'wide' }];
  w.index = {
    ...w.index, balloons, defaultBalloon: 'narrow', balloon: id => balloons.find(b => b.id === id) || null,
    balloonFiles: async id => ({ id, root: `http://s/balloon/${id}/`, has: () => false, list: () => [] }),
  };
  w.desk = desk;
  w.made = [];
  runtimePrefs.set({ ghost: 'x', ghosts: ['x'], rev: 1 });
  return w;
}

const made = (w, kind) => w.made.filter(m => m.kind === kind).at(-1).opts;
const keys = o => Object.keys(o).sort();
/**
 * the desktop option keys (runtime.js without `phone`; headless: no layer, so no `root`), plus the stage's and the
 * balloons' onCanvasLost (core/canvas.js: every browser and screen, no phone key)
 */
const TODAY = {
  stage: ['files', 'ghostDescript', 'onCanvasLost', 'scale', 'shellId', 'state'],
  balloons: ['ghostDescript', 'ghostFiles', 'onCanvasLost', 'scale', 'skin', 'stage', 'state'],
  dialogs: ['balloons', 'language', 'skin', 'stage'],
};

/** A stored Shell / Balloon scaling ▸ choice for ghost id (what its menu stored on an earlier page). */
function pick(id, scaling) {
  const st = StateStore.open(id);
  st.data.scaling = scaling;
  st.saveNow();
  st.dispose();
}

/** UserScaling.prototype.refit, counted. */
function countRefits() {
  const orig = UserScaling.prototype.refit;
  const calls = [];
  UserScaling.prototype.refit = function (...a) { calls.push(this); return orig.apply(this, a); };
  return { calls, restore: () => { UserScaling.prototype.refit = orig; } };
}

async function withDpr(dpr, f) {
  globalThis.devicePixelRatio = dpr;
  try { return await f(); } finally { delete globalThis.devicePixelRatio; }
}

// ---------------------------------------------------------------- desktop unchanged

test('desktop unchanged at 1280×720 and 1920×1080: the desktop options (no phone key, scale 1), no fit, no refit after a balloon change', async () => {
  for (const desk of [{ w: 1280, h: 720 }, { w: 1920, h: 1080 }]) {
    for (const dpr of [1, 1.25, 2]) {
      await withDpr(dpr, async () => {
        const w = wiringWorld(desk);
        const refits = countRefits();
        try {
          const site = await up(w, { Runtime: WiringRuntime });
          assert.equal(site.phone, null);
          const p = site.slots[0].parts;
          for (const kind of ['stage', 'balloons', 'dialogs']) {
            assert.deepEqual(keys(made(w, kind)), TODAY[kind], `${kind} at ${desk.w}×${desk.h} dpr ${dpr}: the desktop keys`);
          }
          assert.equal(made(w, 'stage').scale, 1);
          assert.equal(made(w, 'balloons').scale, 1);
          assert.equal(p.stage.scale, 1);
          assert.equal(p.stage.fitScale, null);
          assert.equal(p.balloons.scale, 1);
          assert.equal(p.scaling.phone, null, 'UserScaling without phone');
          assert.deepEqual(p.scaling.info(), { shell: null, balloon: null, dpr }, 'the desktop shape: no fit');
          // a balloon change: no refit, no setScale
          assert.equal(await site.changeBalloon('wide', { ghost: 'x' }), true);
          await settle();
          assert.equal(refits.calls.length, 0, 'no refit on desktop');
          assert.deepEqual(p.balloons.scales, []);
          assert.equal(p.balloons.scale, 1);
          // a shell swap: the desktop keys, the old stage's scale
          assert.equal(await site.changeShell('tall', { ghost: 'x' }), true);
          await settle();
          assert.deepEqual(keys(made(w, 'stage')), TODAY.stage);
          assert.equal(made(w, 'stage').shellId, 'tall');
          assert.equal(made(w, 'stage').scale, 1);
          assert.equal(site.slots[0].parts.stage.scale, 1);
          assert.equal(site.slots[0].parts.stage.fitScale, null);
          // the Preferences box
          assert.equal(site.openSettings(), true);
          assert.equal(site._settings.phone, null, 'SettingsWindow without phone');
          site._settings.close();
          // another tab shows the set frozen: the desktop keys
          const b = new TestSite(w, { hidden: true, Runtime: WiringRuntime });
          assert.equal(await b.start(), 'frozen');
          assert.deepEqual(keys(made(w, 'stage')), TODAY.stage);
          assert.equal(made(w, 'stage').scale, 1);
        } finally {
          refits.restore();
        }
      });
    }
  }
});

test('desktop unchanged with picks 200 / 150: scale from cssScales for the stage, the balloons and the frozen stage', async () => {
  await withDpr(1.25, async () => {
    const w = wiringWorld({ w: 1280, h: 720 });
    pick('x', { shell: 200, balloon: 150 });
    const site = await up(w, { Runtime: WiringRuntime });
    assert.deepEqual(keys(made(w, 'stage')), TODAY.stage);
    assert.equal(made(w, 'stage').scale, cssScale(200, 1.25));
    assert.equal(made(w, 'balloons').scale, cssScale(150, 1.25));
    assert.equal(site.slots[0].parts.stage.scale, 1.6);
    const b = new TestSite(w, { hidden: true, Runtime: WiringRuntime });
    assert.equal(await b.start(), 'frozen');
    assert.deepEqual(keys(made(w, 'stage')), TODAY.stage);
    assert.equal(made(w, 'stage').scale, 1.6);
  });
});

// ---------------------------------------------------------------- phones

test('phone, no pick: `phone` and no `scale` for the stage and the balloons (they stand at their fit); boxes, scaling and Preferences get phone', async () => {
  await withDpr(2, async () => {
    const w = wiringWorld();
    const site = await up(w, { phone: PHONE, Runtime: WiringRuntime });
    const p = site.slots[0].parts;
    assert.deepEqual(keys(made(w, 'stage')), ['files', 'ghostDescript', 'onCanvasLost', 'phone', 'shellId', 'state']);
    assert.equal(made(w, 'stage').phone, PHONE);
    assert.deepEqual(keys(made(w, 'balloons')), ['ghostDescript', 'ghostFiles', 'onCanvasLost', 'phone', 'skin', 'stage', 'state']);
    assert.equal(made(w, 'balloons').phone, PHONE);
    assert.deepEqual(keys(made(w, 'dialogs')), [...TODAY.dialogs, 'phone'].sort());
    assert.equal(made(w, 'dialogs').phone, PHONE);
    // the real stage fits itself: Tsubasa's sizes at 375×812, dpr 2: 138 % (the UI §9.11 Item 1 table)
    assert.equal(p.stage.fitScale, 0.69);
    assert.equal(p.stage.scale, 0.69);
    assert.equal(p.balloons.scale, 1);
    assert.equal(p.scaling.phone, PHONE);
    assert.deepEqual(p.scaling.info(), { shell: null, balloon: null, dpr: 2, fit: { shell: 138, balloon: 200 } });
    assert.equal(site.openSettings(), true);
    assert.equal(site._settings.phone, PHONE, 'the Preferences box gets phone');
    site._settings.close();
  });
});

test('phone, picks 200 / 150: `scale` as cssScale, and `phone`', async () => {
  await withDpr(2, async () => {
    const w = wiringWorld();
    pick('x', { shell: 200, balloon: 150 });
    const site = await up(w, { phone: PHONE, Runtime: WiringRuntime });
    const p = site.slots[0].parts;
    assert.deepEqual(keys(made(w, 'stage')), [...TODAY.stage, 'phone'].sort());
    assert.equal(made(w, 'stage').scale, cssScale(200, 2));
    assert.equal(made(w, 'stage').phone, PHONE);
    assert.deepEqual(keys(made(w, 'balloons')), [...TODAY.balloons, 'phone'].sort());
    assert.equal(made(w, 'balloons').scale, cssScale(150, 2));
    assert.equal(p.stage.scale, 1, 'the pick wins');
    assert.equal(p.stage.fitScale, 0.69, 'the fit is still known (not applied)');
    assert.equal(p.balloons.scale, 0.75);
  });
});

test('phone: a frozen stage (another tab runs the set) gets phone, and scale only for a pick', async () => {
  await withDpr(2, async () => {
    const w = wiringWorld();
    await up(w, { phone: PHONE, Runtime: WiringRuntime });
    const b = new TestSite(w, { hidden: true, phone: PHONE, Runtime: WiringRuntime });
    assert.equal(await b.start(), 'frozen');
    assert.deepEqual(keys(made(w, 'stage')), ['files', 'ghostDescript', 'onCanvasLost', 'phone', 'shellId', 'state']);
    assert.equal(made(w, 'stage').phone, PHONE);
    assert.equal(b.slots[0].frozen.scale, 0.69);

    const w2 = wiringWorld();
    pick('x', { shell: 200, balloon: null });
    await up(w2, { phone: PHONE, Runtime: WiringRuntime });
    const b2 = new TestSite(w2, { hidden: true, phone: PHONE, Runtime: WiringRuntime });
    assert.equal(await b2.start(), 'frozen');
    assert.deepEqual(keys(made(w2, 'stage')), [...TODAY.stage, 'phone'].sort());
    assert.equal(made(w2, 'stage').scale, 1);
    assert.equal(b2.slots[0].frozen.scale, 1);
  });
});

test('phone: a shell swap with no pick passes no scale (the new shell fits itself, 81 %); with a pick the old stage\'s scale', async () => {
  await withDpr(2, async () => {
    const w = wiringWorld();
    const site = await up(w, { phone: PHONE, Runtime: WiringRuntime });
    const rt = site.slots[0];
    assert.equal(await site.changeShell('tall', { ghost: 'x' }), true);
    await settle();
    assert.equal(made(w, 'stage').shellId, 'tall');
    assert.deepEqual(keys(made(w, 'stage')), ['files', 'ghostDescript', 'onCanvasLost', 'phone', 'shellId', 'state']);
    assert.equal(rt.parts.stage.scale, 0.405, 'not the old shell\'s 0.69');
    assert.equal(rt.parts.scaling.info().fit.shell, 81, 'the menu follows the new shell\'s fit');
    assert.equal(eng(w, 'x').find('OnShellScaling').length, 0, 'no event for the fit');

    const w2 = wiringWorld();
    pick('x', { shell: 150, balloon: null });
    const site2 = await up(w2, { phone: PHONE, Runtime: WiringRuntime });
    assert.equal(await site2.changeShell('tall', { ghost: 'x' }), true);
    await settle();
    assert.deepEqual(keys(made(w2, 'stage')), [...TODAY.stage, 'phone'].sort());
    assert.equal(made(w2, 'stage').scale, 0.75);
    assert.equal(site2.slots[0].parts.stage.scale, 0.75);
  });
});

test('phone: a balloon change refits (the new skin\'s fit applies, no OnBalloonScaling); a pick still wins', async () => {
  await withDpr(2, async () => {
    const w = wiringWorld();
    const refits = countRefits();
    try {
      const site = await up(w, { phone: PHONE, Runtime: WiringRuntime });
      const p = site.slots[0].parts;
      assert.equal(p.balloons.scale, 1);
      assert.equal(await site.changeBalloon('wide', { ghost: 'x' }), true);
      await settle();
      assert.equal(refits.calls.length, 1);
      assert.equal(refits.calls[0], p.scaling);
      assert.equal(p.balloons.scale, 11 / 12, 'the wide balloon\'s fit (11-px text)');
      assert.equal(p.scaling.info().fit.balloon, 183);
      assert.equal(eng(w, 'x').find('OnBalloonScaling').length, 0, 'no event for the fit');

      const w2 = wiringWorld();
      pick('x', { shell: null, balloon: 150 });
      const site2 = await up(w2, { phone: PHONE, Runtime: WiringRuntime });
      const p2 = site2.slots[0].parts;
      assert.equal(await site2.changeBalloon('wide', { ghost: 'x' }), true);
      await settle();
      assert.equal(p2.balloons.scale, 0.75, 'the pick wins');
    } finally {
      refits.restore();
    }
  });
});

// ---------------------------------------------------------------- the launcher (fake DOM from here on)

test('launcher: desktop without phone, bottom exactly 16 px (72 px in slot 1); a phone\'s safe-area insets; the tucked icon is Iconify\'s', async () => {
  const keep = ['document', 'window', 'devicePixelRatio', 'requestAnimationFrame', 'cancelAnimationFrame'].map(k => [k, globalThis[k]]);
  installFakeDom();
  try {
    const w = wiringWorld();
    const desk = new TestSite(w, { Runtime: WiringRuntime });
    desk._alignSlots(['x', 'y']);
    for (const rt of desk.slots) rt._showLauncher('closed');
    const [dx, dy] = desk.slots.map(rt => rt.launcher);
    assert.equal(dx.phone, false, 'no phone option');
    assert.equal(dx.el.style.bottom, '16px');
    assert.equal(dy.el.style.bottom, '72px');
    assert.equal(dx.el.style.right, undefined, 'the CSS right: 16px');
    assert.equal(dx.iconUrl, 'http://s/ghost/x/x.ico', 'closed: her icon');

    const phone = new TestSite(w, { phone: PHONE, tucked: true, Runtime: WiringRuntime });
    assert.equal(await phone.start(), 'launcher');
    const tx = phone.slots[0];
    assert.equal(tx._launcherMode, 'tucked');
    assert.equal(tx.launcher.phone, true);
    assert.equal(tx.launcher.iconUrl, 'http://s/ghost/x/min.png', 'tucked: icon.minimize');
    assert.equal(tx.launcher.el.style.bottom, 'calc(16px + env(safe-area-inset-bottom, 0px))');
    assert.equal(tx.launcher.el.style.right, 'calc(16px + env(safe-area-inset-right, 0px))');
    phone._alignSlots(['x', 'y']);
    const ty = phone.slots[1];
    ty.state = StateStore.open('y');
    ty.state.data.minimized = { icon: 'script.ico' };      // a script's \![set,trayicon] (an earlier run)
    ty._showLauncher('tucked');
    assert.equal(ty.launcher.iconUrl, 'http://s/ghost/y/y.ico', 'no icon.minimize: her icon, never a script\'s');
    assert.equal(ty.launcher.el.style.bottom, 'calc(72px + env(safe-area-inset-bottom, 0px))');
    ty._showLauncher('minimized');
    assert.equal(ty.launcher.iconUrl, 'http://s/ghost/y/script.ico', 'minimized: the script\'s, as Iconify');

    // a desktop page with data-default-state="tucked" (core/choice.js; main.js passes tucked alone): the same button,
    // the desktop's layout (no phone option, the desktop's corner)
    const deskTucked = new TestSite(wiringWorld(), { tucked: true, Runtime: WiringRuntime });
    assert.equal(await deskTucked.start(), 'launcher');
    const dt = deskTucked.slots[0];
    assert.deepEqual([dt._launcherMode, dt.launcher.mode, dt.launcher.phone], ['tucked', 'tucked', false]);
    assert.equal(dt.launcher.iconUrl, 'http://s/ghost/x/min.png', 'tucked: icon.minimize, as on a phone');
    assert.equal(dt.launcher.el.style.bottom, '16px');
    assert.equal(dt.launcher.el.style.right, undefined, 'the CSS right: 16px');
    assert.equal(dt.parts, null, 'nothing of her runs');
  } finally {
    for (const [k, v] of keep) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});

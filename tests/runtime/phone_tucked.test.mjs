// data-phone="tucked" on a phone (UI §9.11 Tucked): a start that would cold-boot the stored set in this tab shows
// one "Show X" button for its first ghost instead and runs nothing (no engine, lock, channel or write); a tap starts
// the set as a first visit would. On the synthetic site of multi_world.mjs (Satori x, y, z, w), real GhostLocks over
// fake Web Locks, invariants() after the steps. Node has no document, so Runtime._showLauncher stops before the button:
// PhoneRuntime adds the browser's part (a button with Launcher's busy rules, ui/launcher.js; phone.test.mjs tests the
// class itself) and tap() clicks it as Launcher's click handler does.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage, runtimePrefs, sessionMarker } from '../../src/core/state.js';
import { markerGhosts } from '../../src/core/ghostset.js';
import { setLogLevel } from '../../src/core/log.js';
import { settle } from './fakes.mjs';
import { world, TestSite, TestRuntime, loopOf, eng, live, ids, events, idle, until, up, menuCall, invariants } from './multi_world.mjs';

setLogLevel('silent');

const PHONE = Object.freeze({ short: 375, long: 812, mobileView: true });
const BOOT = /On(Boot|FirstBoot|GhostCalled|GhostChanged)$/;

/** The launcher a browser builds and shows: Launcher's mode and busy rules (show() and hide() clear busy). */
const button = () => ({
  mode: null, busy: false, slot: 0, destroyed: false,
  setSlot(i) { this.slot = i; },
  setIcon() {},
  show(m) { this.mode = m; this.busy = false; },
  hide() { this.mode = null; this.busy = false; },
  setBusy(on) { this.busy = !!on; },
  destroy() { this.mode = null; this.destroyed = true; },
});

class PhoneRuntime extends TestRuntime {
  _showLauncher(mode) {
    super._showLauncher(mode);
    if (!this.launcher) this.launcher = button();
    this.launcher.show(mode);       // what the browser path does after Node's stop (Launcher.show)
  }
}

/** A phone tab of the site with data-phone="tucked" (main.js: {phone, tucked: true}). */
const tabs = new Set();
const tab = (w, o = {}) => { const s = new TestSite(w, { phone: PHONE, tucked: true, Runtime: PhoneRuntime, ...o }); tabs.add(s); return s; };

// a test that failed mid-boot (right after a tap) leaves that boot running after multi_world's done(): its starts end
// first (every talk played), then the tab is done again, so the file reports the failure and exits instead of hanging
afterEach(async () => {
  for (const s of tabs) {
    for (let i = 0; i < 60 && (s._starting || s._tail || s.slots.some(rt => rt._starting)); i++) {
      for (const rt of s.slots) if (rt.player && rt.player.busy) rt.player.finish();
      await settle();
    }
    s.done();
  }
  tabs.clear();
});

/** A click on rt's button, as Launcher's handler: nothing while busy; else it hides and activates its mode. */
function tap(rt) {
  const b = rt.launcher;
  if (!b || !b.mode || b.busy) return;
  const m = b.mode;
  b.hide();
  rt._launch(m);
}

/** Run f with tab storage `s` as sessionStorage (the harness shares one sessionStorage global between its tabs). */
function inTab(s, f) {
  const keep = globalThis.sessionStorage;
  globalThis.sessionStorage = s;
  try { return f(); } finally { globalThis.sessionStorage = keep; }
}

/** A Storage that records the keys written (setItem, removeItem). */
function counting(store, writes) {
  return {
    getItem: k => store.getItem(k),
    setItem: (k, v) => { writes.push(k); store.setItem(k, v); },
    removeItem: k => { writes.push(k); store.removeItem(k); },
    clear: () => store.clear(),
    key: i => store.key(i),
    get length() { return store.length; },
  };
}

/** Every boot talk played to its end. */
async function quiet(site) {
  await idle(site);
  for (const rt of site.slots) if (rt.player && rt.player.busy) rt.player.finish();
  await settle();
}

/** Quit from the first ghost's menu, every goodbye played to its end: the closed launcher. */
async function quitAll(site) {
  site.slots[0].parts.menu._run({ type: 'quit' }, 0);
  await settle();
  for (const rt of site.slots) if (rt.player && rt.player.busy) rt.player.finish();
  await until(() => site.slots.length === 1 && site.slots[0]._launcherMode === 'closed');
}

test('tucked: the first start shows "Show X" for the set\'s first ghost and runs nothing (no engine, lock, channel; no write but the storage probe); started again: the button again', async () => {
  const w = world();
  const local = [];
  const sess = [];
  globalThis.localStorage = counting(globalThis.localStorage, local);
  globalThis.sessionStorage = counting(globalThis.sessionStorage, sess);
  const site = tab(w);
  assert.equal(await site.start(), 'launcher');
  assert.deepEqual(ids(site), ['x'], 'the stored set\'s first ghost (here the page default)');
  const t = site.slots[0];
  assert.equal(t._launcherMode, 'tucked');
  assert.deepEqual([t.launcher.mode, t.launcher.busy], ['tucked', false]);
  assert.deepEqual(w.engines, []);
  assert.equal(site.lead, null, 'no lead lock made');
  assert.equal(w.locks.held.size, 0);
  assert.equal(site._channel, undefined, 'no site channel made');
  assert.deepEqual(w.posts, []);
  assert.ok(!t.frozen && !t.parts);
  assert.deepEqual([...new Set(local)], ['sumika:__probe'], 'localStorage: the probe only');
  assert.deepEqual(sess, [], 'sessionStorage: nothing');
  // nothing of her is on screen: the page API answers as for "Call X"
  assert.deepEqual(site.running(), []);
  assert.ok(site.siteGhosts().every(g => !g.running));
  assert.deepEqual([...site.onScreen()], []);
  assert.equal(site._count(), 0);
  assert.equal(await site.closeGhost(), false);
  assert.equal(await site.quit(0), false);
  assert.equal(await site.changeShell('master'), false);
  assert.equal(await site.changeBalloon('sumika'), false);
  invariants(site, w);
  // window.sumika.start() again, a bfcache pageshow (restart): the button again, still nothing run
  assert.equal(await site.start(), 'launcher');
  assert.equal(await site.restart(), 'launcher');
  assert.ok(site.slots.length === 1 && site.slots[0] === t);
  assert.deepEqual([t._launcherMode, t.launcher.mode], ['tucked', 'tucked']);
  assert.deepEqual(w.engines, []);
  assert.deepEqual(sess, []);
  assert.equal(sessionMarker.read(), null);
  assert.deepEqual([...new Set(local)], ['sumika:__probe']);
  invariants(site, w);
});

test('tucked: a tap leaves the button busy until the set boots, cold, one at a time (OnFirstBoot for a ghost never met); the next page resumes it; a new tab is tucked again', async () => {
  const w = world();
  w.saves.set('x', {});                                   // met before; Y never
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = tab(w);
  assert.equal(await site.start(), 'launcher');
  const t = site.slots[0];
  tap(t);
  assert.deepEqual([t._launcherMode, t.launcher.mode, t.launcher.busy], ['tucked', 'tucked', true], 'the button stays, dimmed, while she loads');
  await until(() => site.slots.length === 2 && site.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await quiet(site);
  assert.deepEqual(ids(site), ['x', 'y']);
  assert.deepEqual(w.engines.map(e => [e.ghost, e.resume]), [['x', false], ['y', false]], 'cold, one engine each');
  assert.deepEqual([events(eng(w, 'x'), BOOT), events(eng(w, 'y'), BOOT)], [['GET OnBoot'], ['GET OnFirstBoot']]);
  assert.ok(w.order.indexOf('x GET OnBoot') < w.order.indexOf('y NOTIFY OnInitialize'), 'one at a time');
  assert.deepEqual(markerGhosts(sessionMarker.read()), ['x', 'y'], 'the marker names them: the next page resumes');
  assert.deepEqual([t._launcherMode, t.launcher.mode, t.launcher.busy], [null, null, false], 'the button went at her boot');
  assert.ok(site.lead.held);
  invariants(site, w);

  // the next page of this tab: they resume, no button
  site._onPageHide();
  site.done();
  await settle();
  const n = w.engines.length;
  const next = tab(w);
  assert.equal(await next.start(), 'booted');
  assert.deepEqual(w.engines.slice(n).map(e => [e.ghost, e.resume]).sort(), [['x', true], ['y', true]]);
  for (const e of w.engines.slice(n)) assert.deepEqual(events(e, BOOT), [], `${e.ghost}: no boot event`);
  assert.ok(next.slots.every(rt => rt._launcherMode === null));
  invariants(next, w);

  // a new tab: tucked again, nothing run
  next._onPageHide();
  next.done();
  await settle();
  globalThis.sessionStorage = memoryStorage();
  const m = w.engines.length;
  const fresh = tab(w);
  assert.equal(await fresh.start(), 'launcher');
  assert.deepEqual([ids(fresh), fresh.slots[0]._launcherMode, w.engines.length], [['x'], 'tucked', m]);
  invariants(fresh, w);
});

test('tucked while another tab runs the set: the button, not the frozen set; a tap hides it and shows the set frozen (on screen, counted), taken over resumed once the other tab is hidden', async () => {
  const w = world();
  for (const id of ['x', 'y']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const s1 = globalThis.sessionStorage;
  const a = await up(w);                                  // the first tab runs X and Y
  const s2 = memoryStorage();
  globalThis.sessionStorage = s2;                         // a new tab
  const b = tab(w);
  assert.equal(await b.start(), 'launcher');
  const t = b.slots[0];
  assert.deepEqual([ids(b), t._launcherMode, !!t.frozen, b.lead], [['x'], 'tucked', false, null], 'never the other tab\'s ghosts frozen before the tap');
  const n = w.engines.length;
  let open;
  b.hold.y = new Promise(r => { open = r; });            // Y's files load slowly here: X shows frozen first
  tap(t);
  await until(() => t.frozen && !t._starting);
  // X frozen under its busy button while Y loads: on screen and counted, not a tucked slot left out (_shut)
  assert.deepEqual([t._launcherMode, t.launcher.busy, b._shut(t)], ['tucked', true, false]);
  assert.deepEqual([[...b.onScreen()].sort(), b._count()], [['x', 'y'], 2]);
  open();
  await until(() => b.slots.length === 2 && b.slots.every(rt => rt.frozen));
  await settle(10);
  // A is visible: it keeps the set until it is hidden (UI §9.5)
  assert.deepEqual([t._launcherMode, t.launcher.mode, t.launcher.busy], [null, null, false], 'no busy button left over the frozen set');
  assert.deepEqual([...b.onScreen()].sort(), ['x', 'y'], 'shown frozen: on screen');
  assert.equal(b._count(), 2);
  assert.deepEqual(b.running().map(r => r.id), ['x', 'y']);
  assert.equal(w.engines.length, n, 'no engine here yet');
  assert.ok(a.lead.held && !b.lead.held);
  inTab(s1, () => invariants(a, w));
  invariants(b, w);
  // A hidden: it lets the set go, and B resumes it (no boot event)
  a.show(false);
  await until(() => b.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await settle(10);
  assert.ok(b.lead.held && !a.lead.held);
  assert.deepEqual(w.engines.slice(n).map(e => [e.ghost, e.resume]).sort(), [['x', true], ['y', true]]);
  for (const e of w.engines.slice(n)) assert.deepEqual(events(e, BOOT), [], `${e.ghost}: resumed`);
  assert.deepEqual(live(w), ['x', 'y']);
  assert.ok(b.slots.every(rt => rt._launcherMode === null));
  inTab(s1, () => invariants(a, w));
  invariants(b, w);
});

test('tucked after Quit: the next page and a new tab show "Call X", never tucked; a Quit in another tab while this one shows the tucked button: one tap boots the set cold (OnBoot), never "Call X"', async () => {
  let w = world();
  for (const id of ['x', 'y']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const site = tab(w);
  assert.equal(await site.start(), 'launcher');
  tap(site.slots[0]);
  await until(() => site.slots.length === 2 && site.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await quiet(site);
  await quitAll(site);
  assert.equal(site.slots[0]._launcherMode, 'closed');
  site._onPageHide();
  site.done();
  await settle();
  const next = tab(w);
  assert.equal(await next.start(), 'launcher');
  assert.deepEqual([ids(next), next.slots[0]._launcherMode], [['x'], 'closed'], 'the next page: "Call X"');
  next.done();
  globalThis.sessionStorage = memoryStorage();
  const other = tab(w);
  assert.equal(await other.start(), 'launcher');
  assert.deepEqual([ids(other), other.slots[0]._launcherMode], [['x'], 'closed'], 'a new tab: "Call X"');
  invariants(other, w);
  other.done();

  // B shows the tucked button; A (another tab) quits meanwhile: B hears nothing, and its tap calls the set back cold
  w = world();
  for (const id of ['x', 'y']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 });
  const s1 = globalThis.sessionStorage;
  const a = await up(w);
  const s2 = memoryStorage();
  globalThis.sessionStorage = s2;                         // B, a new tab
  const b = tab(w);
  assert.equal(await b.start(), 'launcher');
  globalThis.sessionStorage = s1;                         // A's Quit, in A's tab
  await quitAll(a);
  assert.equal(a.slots[0]._launcherMode, 'closed');
  globalThis.sessionStorage = s2;
  const t = b.slots[0];
  assert.deepEqual([t._launcherMode, b._channel], ['tucked', undefined], 'still "Show X": a tucked tab hears no set message');
  const n = w.engines.length;
  w.order.length = 0;
  tap(t);
  await until(() => b.slots.length === 2 && b.slots.every(rt => loopOf(rt) && loopOf(rt).booted));
  await quiet(b);
  assert.deepEqual(ids(b), ['x', 'y']);
  assert.deepEqual(w.engines.slice(n).map(e => [e.ghost, e.resume]), [['x', false], ['y', false]]);
  for (const id of ['x', 'y']) assert.deepEqual(events(eng(w, id), BOOT), ['GET OnBoot'], id);
  assert.ok(b.slots.every(rt => rt._launcherMode === null), 'never "Call X"');
  assert.ok(b.lead.held);
  invariants(b, w);
});

test('tucked page API: callGhost(y) brings Y alone, cold (OnBoot), in the button\'s place; the stored set is [y]', async () => {
  const w = world();
  for (const id of ['x', 'y', 'z']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'z'], rev: 1 });
  const site = tab(w);
  assert.equal(await site.start(), 'launcher');
  assert.equal(await site.callGhost('y'), true);
  assert.deepEqual(ids(site), ['y']);
  assert.deepEqual(w.engines.map(e => [e.ghost, e.resume]), [['y', false]]);
  assert.deepEqual(events(eng(w, 'y'), BOOT), ['GET OnBoot']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['y']);
  assert.equal(site.slots[0]._launcherMode, null);
  assert.ok(site.lead.held);
  invariants(site, w);
});

test('tucked page API: a call that does not boot puts the tucked button back (not "Call X") with the old set stored and the lead let go; another tab then runs the set', async () => {
  const w = world({ failEngine: id => id === 'y' });
  for (const id of ['x', 'z']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'z'], rev: 1 });
  const site = tab(w);
  assert.equal(await site.start(), 'launcher');
  assert.equal(await site.callGhost('y'), false);
  const t = site.slots[0];
  assert.deepEqual([ids(site), t._launcherMode, t.launcher.mode, t.launcher.busy], [['x'], 'tucked', 'tucked', false]);
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'z'], 'the old set, both ghosts');
  assert.equal(sessionMarker.read(), null);
  assert.ok(site.lead && !site.lead.held && !w.locks.held.has('sumika/lead'), 'the lead the call took is let go');
  assert.deepEqual(live(w), []);
  invariants(site, w);
  // another tab finds no lead held: the set runs there at once, nothing shown frozen
  globalThis.sessionStorage = memoryStorage();
  const other = await up(w);
  assert.deepEqual(ids(other), ['x', 'z']);
  assert.ok(other.slots.every(rt => !rt.frozen && loopOf(rt) && loopOf(rt).booted));
  for (const id of ['x', 'z']) assert.deepEqual(events(eng(w, id), BOOT), ['GET OnBoot'], id);
  invariants(other, w);
});

test('tucked page API: changeGhost(y) boots Y alone in the button\'s slot (OnBoot); one that fails puts the tucked button back: the tucked ghost not booted, the old set stored, the marker cleared, the lead let go', async () => {
  let w = world();
  for (const id of ['x', 'y', 'z']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'z'], rev: 1 });
  let site = tab(w);
  assert.equal(await site.start(), 'launcher');
  const t = site.slots[0];
  assert.equal(await site.changeGhost('y'), true);
  assert.ok(site.slots[0] === t, 'in the button\'s slot');
  assert.deepEqual(ids(site), ['y']);
  assert.deepEqual(w.engines.map(e => [e.ghost, e.resume]), [['y', false]]);
  assert.deepEqual(events(eng(w, 'y'), BOOT), ['GET OnBoot']);
  assert.deepEqual(runtimePrefs.get().ghosts, ['y']);
  assert.equal(t._launcherMode, null);
  invariants(site, w);
  site.done();

  w = world({ failEngine: id => id === 'y' });
  for (const id of ['x', 'z']) w.saves.set(id, {});
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'z'], rev: 1 });
  site = tab(w);
  assert.equal(await site.start(), 'launcher');
  assert.equal(await site.changeGhost('y'), false);
  await settle();
  const u = site.slots[0];
  assert.deepEqual([ids(site), u._launcherMode, u.launcher.mode, u.launcher.busy], [['x'], 'tucked', 'tucked', false], 'the tucked button back');
  assert.equal(eng(w, 'x'), undefined, 'no boot of the tucked ghost (a closed launcher\'s change would boot it)');
  assert.deepEqual(runtimePrefs.get().ghosts, ['x', 'z'], 'the old set stored again');
  assert.equal(sessionMarker.read(), null, 'the marker cleared (Y\'s failed boot had named it)');
  assert.ok(!site.lead.held && w.locks.held.size === 0, 'the lead and every lock let go');
  invariants(site, w);
  // the next page of the tab: tucked again
  site._onPageHide();
  site.done();
  await settle();
  const next = tab(w);
  assert.equal(await next.start(), 'launcher');
  assert.equal(next.slots[0]._launcherMode, 'tucked');
});

test('tucked: a tap whose boot fails puts the button back, not busy, the lead let go; the next page of the tab is tucked again', async () => {
  const w = world({ failEngine: id => id === 'x' });
  runtimePrefs.set({ ghost: 'x', ghosts: ['x'], rev: 1 });
  const site = tab(w);
  assert.equal(await site.start(), 'launcher');
  const t = site.slots[0];
  tap(t);
  assert.equal(t.launcher.busy, true);
  await until(() => !site._starting && t.launcher.mode === 'tucked' && !t.launcher.busy);
  await settle();
  assert.deepEqual([ids(site), t._launcherMode, t.launcher.mode, t.launcher.busy], [['x'], 'tucked', 'tucked', false]);
  assert.ok(!site.lead.held && w.locks.held.size === 0, 'the lead and her lock let go');
  assert.equal(sessionMarker.read(), null, 'the failed boot does not count as brought out');
  invariants(site, w);
  site._onPageHide();
  site.done();
  await settle();
  const next = tab(w);
  assert.equal(await next.start(), 'launcher');
  assert.equal(next.slots[0]._launcherMode, 'tucked');
});

test('tucked: a call, a change or a tap that fails puts the button back with no site channel: another tab\'s call and ghost change show nothing here (none of its ghosts frozen, the button kept); the next tap shows that tab\'s set frozen', async () => {
  for (const how of ['call', 'change', 'tap']) {
    const failing = new Set(how === 'tap' ? ['x', 'z'] : ['y']);
    const w = world({ failEngine: id => failing.has(id) });
    for (const id of ['x', 'y', 'z', 'w']) w.saves.set(id, {});
    runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'z'], rev: 1 });
    const sA = globalThis.sessionStorage;
    const a = tab(w);
    assert.equal(await a.start(), 'launcher');
    if (how === 'call') assert.equal(await a.callGhost('y'), false);
    else if (how === 'change') assert.equal(await a.changeGhost('y'), false);
    else { const u = a.slots[0]; tap(u); await until(() => !a._starting && u.launcher.mode === 'tucked' && !u.launcher.busy); }
    await settle();
    const t = a.slots[0];                                 // (after a failed call, a new slot's button)
    assert.deepEqual([ids(a), t._launcherMode, t.launcher.busy, a._channel], [['x'], 'tucked', false, undefined], `${how}: the button back, no channel`);
    failing.clear();
    // B, a new tab, runs the set, calls W from X's menu, then changes X to Y (A's button is X's)
    globalThis.sessionStorage = memoryStorage();
    const b = await up(w);
    await menuCall(b, b.slots[0], 'w');
    const x = b.slots[0];
    const leaving = x.loop;
    const p = x.changeGhost('y');
    await until(() => leaving.current && leaving.current.event === 'OnGhostChanging');
    if (x.player.busy) x.player.finish();
    assert.equal(await p, true);
    await quiet(b);
    assert.deepEqual(ids(b), ['y', 'z', 'w']);
    globalThis.sessionStorage = sA;
    await settle(20);
    assert.deepEqual([ids(a), a.slots[0] === t, t._launcherMode, t.launcher && t.launcher.mode, !!t.frozen], [['x'], true, 'tucked', 'tucked', false], `${how}: still X's tucked button alone`);
    assert.deepEqual([[...a.onScreen()], a.running(), a._count()], [[], [], 0], `${how}: nothing of B's set on screen here`);
    invariants(a, w);
    // the tap reads the stored set fresh: B's, frozen here
    tap(t);
    await until(() => a.slots.length === 3 && a.slots.every(rt => rt.frozen));
    assert.deepEqual(ids(a), ['y', 'z', 'w'], how);
    a.done();
    b.done();
  }
});

test('tucked is main.js\'s decision: on a phone without it the set starts as usual (OnBoot at once); the Site takes it on a desktop too (data-default-state="tucked", core/choice.js): the button, a tap boots the set', async () => {
  const w = world();
  w.saves.set('x', {});
  const site = new TestSite(w, { phone: PHONE, tucked: false });
  assert.equal(site.tucked, false);
  assert.equal(await site.start(), 'booted');
  assert.deepEqual(events(eng(w, 'x'), BOOT), ['GET OnBoot']);
  assert.equal(site.slots[0]._launcherMode, null);
  invariants(site, w);
  site.done();

  // a desktop page with data-default-state="tucked" (main.js passes {tucked: true}, no phone): the phone's tucked path
  const d = world();
  d.saves.set('x', {});
  globalThis.sessionStorage = memoryStorage();              // a new tab
  const desk = tab(d, { phone: null });
  assert.deepEqual([desk.tucked, desk.phone], [true, null]);
  assert.equal(await desk.start(), 'launcher');
  const t = desk.slots[0];
  assert.deepEqual([t._launcherMode, t.launcher.mode, d.engines.length, desk.lead], ['tucked', 'tucked', 0, null]);
  tap(t);
  await until(() => loopOf(t) && loopOf(t).booted);
  await quiet(desk);
  assert.deepEqual(events(eng(d, 'x'), BOOT), ['GET OnBoot']);
  assert.equal(t._launcherMode, null);
  invariants(desk, d);
});

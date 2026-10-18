// data-default-state and the visitor's choice on the page bundle itself (src/main.js in a vm with tripwires,
// tests/runtime/bundle_page.mjs; core/choice.js): the order phone off -> unsupported -> visitor's
// choice -> data-default-state; off (the visitor's or the site's) is a frozen stub that says why and fetches, stores,
// shows and listens to nothing (only the choice is read); no attribute and no choice is exactly the usual page; tucked on a
// desktop is the Site's tucked; with data-hub the choice is the hub's, read at the first start once the hub decided (its
// frame removed again when the answer is off, the page origin's storage never read), and a hub that is not usable falls
// back to the page origin's storage, whose choice then decides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHOICE_KEY } from '../../src/core/choice.js';
import { offApi } from '../../src/core/phone.js';
import { page, settled } from './bundle_page.mjs';
import { FakeHubSite, HUB_ORIGIN } from './hub_fakes.mjs';

const ON = JSON.stringify({ choice: 'on', v: 1 });
const OFF = JSON.stringify({ choice: 'off', v: 1 });
const stored = c => (c === 'on' ? { [CHOICE_KEY]: ON } : c === 'off' ? { [CHOICE_KEY]: OFF } : {});
const STUB = Object.keys(offApi('x')).sort();
/** hits that are a write, a fetch, an element, a listener, a worker, a channel or a lock */
const touched = hits => hits.filter(h => !/^localStorage\.getItem$/.test(h));

test('no data-default-state and no choice: the usual page (state enabled, the Site made, not tucked); the one new read is the choice', async () => {
  const r = await page({ dataset: { autostart: '0' }, local: {} });
  assert.equal(r.api.state, 'enabled');
  assert.ok(r.api.site);
  assert.equal(r.api.site.tucked, false);
  assert.deepEqual([r.warns, r.errors], [[], []]);
  assert.ok(r.hits.includes('localStorage.getItem'));
  assert.equal(r.local.length, 0, 'nothing stored (the Site\'s storage probe, set and removed at once)');
  assert.ok(!r.hits.includes('fetch'), 'not started: nothing fetched');
});

test('the order on a desktop: the visitor\'s choice over data-default-state, every pair (autostart off: state, reason, the Site, tucked)', async () => {
  for (const def of [undefined, 'enabled', 'tucked', 'off', 'hidden']) {
    for (const choice of [null, 'on', 'off']) {
      const dataset = { autostart: '0', ...(def === undefined ? {} : { defaultState: def }) };
      const r = await page({ dataset, local: stored(choice) });
      const what = JSON.stringify({ def, choice });
      const site = def === 'tucked' ? 'tucked' : def === 'off' ? 'off' : 'enabled';
      const want = choice === 'off' ? 'off' : choice === 'on' ? 'enabled' : site;
      assert.equal(r.api.state, want, what);
      if (want === 'off') {
        assert.deepEqual(Object.keys(r.api).sort(), STUB, what);
        assert.ok(Object.isFrozen(r.api), what);
        assert.deepEqual([r.api.site, r.api.runtime, r.api.phone, r.api.reason], [null, null, null, choice === 'off' ? 'visitor' : 'site'], what);
        assert.equal(await r.api.start(), 'none');
        assert.equal(await r.api.callGhost('x'), false);
        assert.deepEqual(touched(r.hits), [], `${what}: only the choice read`);
      } else {
        assert.ok(r.api.site, what);
        assert.equal(r.api.site.tucked, want === 'tucked', what);
        assert.equal('reason' in r.api, false, 'the live api says its state only');
      }
      assert.equal(r.warns.length, def === 'hidden' ? 1 : 0, `${what}: an unknown value warns once`);
      if (def === 'hidden') assert.match(r.warns[0], /data-default-state="hidden" is not enabled, tucked or off/);
    }
  }
});

test('off with autostart: nothing at all after the start would have run (no fetch, write, element, listener, worker, channel or lock); enabled starts', async () => {
  for (const [o, why] of [[{ local: stored('off') }, 'visitor'], [{ dataset: { defaultState: 'off' }, local: {} }, 'site']]) {
    const r = await page(o);
    await settled();
    assert.deepEqual([r.api.state, r.api.reason], ['off', why]);
    assert.deepEqual(touched(r.hits), [], why);
    assert.deepEqual(r.listeners, []);
    assert.deepEqual([r.warns, r.errors], [[], []]);
    assert.equal(r.local.length, Object.keys(o.local).length, 'the stored records as they were');
  }
  const on = await page({ dataset: { defaultState: 'off' }, local: stored('on') });
  await settled();
  assert.deepEqual([on.api.state, !!on.api.site], ['enabled', true]);
  assert.ok(on.hits.includes('fetch'), 'the visitor\'s On: the set starts (its index fetched)');
});

test('phones: data-phone="off" wins over everything (nothing read, not even the choice); data-phone="tucked" kept under On; the site\'s tucked on a phone', async () => {
  const off = await page({ search: '?sumika-phone', dataset: { phone: 'off', defaultState: 'hidden', autostart: '0' }, local: stored('on') });
  assert.deepEqual(Object.keys(off.api).sort(), STUB);
  assert.deepEqual([off.api.phone, off.api.state, off.api.reason], ['off', 'off', 'phone']);
  assert.deepEqual([off.hits, off.warns, off.errors], [[], [], []], 'nothing read, data-default-state never parsed');
  const tucked = await page({ search: '?sumika-phone', dataset: { phone: 'tucked', autostart: '0' }, local: stored('on') });
  assert.deepEqual([tucked.api.phone, tucked.api.state, tucked.api.site.tucked], ['tucked', 'tucked', true], 'On: the site\'s phone layout stays');
  const visitorOff = await page({ search: '?sumika-phone', dataset: { phone: 'tucked', autostart: '0' }, local: stored('off') });
  assert.deepEqual([visitorOff.api.phone, visitorOff.api.state, visitorOff.api.reason, visitorOff.api.site], ['tucked', 'off', 'visitor', null]);
  const siteTucked = await page({ search: '?sumika-phone', dataset: { defaultState: 'tucked', autostart: '0' }, local: {} });
  assert.deepEqual([siteTucked.api.phone, siteTucked.api.state, siteTucked.api.site.tucked], ['on', 'tucked', true]);
  const phoneOn = await page({ search: '?sumika-phone', dataset: { autostart: '0' }, local: {} });
  assert.deepEqual([phoneOn.api.phone, phoneOn.api.state, phoneOn.api.site.tucked], ['on', 'enabled', false], 'the usual phone page');
});

test('a browser that cannot run Sumika: its stub before any choice (nothing read, data-default-state never parsed)', async () => {
  const r = await page({ wasm: false, dataset: { defaultState: 'hidden' }, local: stored('on') });
  assert.deepEqual([r.api.supported, r.api.state, r.api.reason, r.api.site], [false, 'off', 'unsupported', null]);
  assert.deepEqual(r.hits, []);
  assert.equal(r.warns.length, 1, 'only the unsupported warn');
  assert.match(r.warns[0], /cannot run Sumika/);
});

test('tucked on a desktop: state tucked, the Site tucked (the phone\'s tucked path), no phone option', async () => {
  const r = await page({ dataset: { defaultState: 'tucked', autostart: '0' }, local: {} });
  assert.deepEqual([r.api.phone, r.api.state, r.api.site.tucked, r.api.site.phone], [null, 'tucked', true, null]);
  const on = await page({ dataset: { defaultState: 'tucked', autostart: '0' }, local: stored('on') });
  assert.deepEqual([on.api.state, on.api.site.tucked], ['enabled', false], 'On: she starts out');
});

// ---------------------------------------------------------------- data-hub: the choice is the hub's

const CDN = `${HUB_ORIGIN}/sumika/sumika.js`;          // the runtime and its hub on another origin than the page
const hubSite = (choice, o = {}) => {
  const hs = new FakeHubSite();
  if (choice) hs.local.setItem(CHOICE_KEY, choice === 'on' ? ON : OFF);
  return Object.assign(hs, o);
};
const writesTo = hs => hs.log.filter(m => /^(ls|ss)\./.test(m.op) || m.op === 'will');

test('data-hub: the hub\'s Off, read at the first start once it decided: the off stub, the frame removed, the page origin\'s storage never read, nothing written at the hub', async () => {
  for (const def of [undefined, 'off']) {
    const hs = hubSite('off');
    const r = await page({ src: CDN, dataset: { hub: '', ...(def ? { defaultState: def } : {}) }, local: stored('on'), hub: hs });
    await settled(40);
    assert.deepEqual(Object.keys(r.api).sort(), STUB, String(def));
    assert.deepEqual([r.api.state, r.api.reason, r.api.site], ['off', 'visitor', null]);
    assert.deepEqual([r.hubPage.frames.length, r.hubPage.removed.length], [1, 1], 'planted, then removed');
    assert.ok(!r.hits.some(h => /^(localStorage|sessionStorage|indexedDB|caches|navigator\.locks)\./.test(h)), 'the page origin\'s storage untouched');
    assert.ok(!r.hits.some(h => h === 'Worker' || h === 'BroadcastChannel' || h === 'document.createElement'), 'no worker, channel or element but the frame');
    // the index loads while the hub decides (one small file) unless the site's default is off
    assert.equal(r.hits.filter(h => h === 'fetch').length, def === 'off' ? 0 : 1, String(def));
    assert.deepEqual(r.listeners.map(([t]) => t), ['pagehide', 'pageshow'], 'the hub client\'s only: no Site hook');
    assert.deepEqual(writesTo(hs), [], 'nothing written at the hub');
    assert.deepEqual([r.warns, r.errors], [[], []]);
  }
});

test('data-hub: the hub\'s On beats the site\'s off and the page origin\'s Off; no choice at the hub: the site\'s default (tucked)', async () => {
  const hs = hubSite('on');
  const r = await page({ src: CDN, dataset: { hub: '', defaultState: 'off' }, local: stored('off'), hub: hs });
  await settled(40);
  assert.deepEqual([r.api.state, !!r.api.site], ['enabled', true]);
  assert.equal(r.hubPage.removed.length, 0, 'the hub stays: it keeps the page\'s data');
  assert.ok(r.hits.includes('fetch'), 'the set starts (its index fetched after the decision)');
  assert.ok(!r.hits.some(h => /^localStorage\./.test(h)), 'the page origin\'s own record is not this page\'s');
  const t = await page({ src: CDN, dataset: { hub: '', defaultState: 'tucked', autostart: '0' }, local: {}, hub: hubSite(null) });
  assert.equal(t.api.state, null, 'undecided before the first start');
  assert.equal(t.hubPage.frames.length, 0, 'nothing planted before it');
  const pending = t.api;
  const out = pending.start();
  await settled(40);
  assert.deepEqual([t.api.state, t.api.site.tucked], ['tucked', true]);
  assert.equal(t.api, pending, 'the same window.sumika');
  await out;
});

test('data-hub with data-autostart="0": start() decides; an Off makes start() answer "none", window.sumika the stub, and the object the page kept inert', async () => {
  const r = await page({ src: CDN, dataset: { hub: '', autostart: '0' }, local: {}, hub: hubSite('off') });
  const kept = r.api;
  assert.deepEqual([kept.state, !!kept.site], [null, true]);
  assert.equal(await kept.start(), 'none');
  assert.notEqual(r.api, kept, 'window.sumika replaced');
  assert.deepEqual([r.api.state, r.api.reason], ['off', 'visitor']);
  assert.deepEqual([kept.state, kept.site, kept.runtime], ['off', null, null], 'the kept object says so too');
  assert.equal(await kept.callGhost('x'), false);
  assert.equal(await kept.changeGhost('x'), false);
  // (the vm's own arrays: compared as JSON)
  assert.equal(JSON.stringify([kept.ghosts(), kept.running(), kept.shells(), kept.balloons()]), '[[],[],[],{"top":[],"all":[]}]');
  assert.equal(r.hubPage.removed.length, 1);
});

test('data-hub not usable (refused, as an origin the hub does not list): the page origin\'s storage, whose choice then decides', async () => {
  const off = await page({ src: CDN, dataset: { hub: '' }, local: stored('off'), hub: hubSite('on', { refuse: 'allowlist' }) });
  await settled(40);
  assert.deepEqual([off.api.state, off.api.reason], ['off', 'visitor'], 'the page origin\'s Off (the hub\'s On never read)');
  assert.ok(off.hits.includes('localStorage.getItem'));
  assert.equal(off.warns.length, 1, 'the fallback\'s one line');
  assert.match(off.warns[0], /sumika\/hub\.json is missing or unreadable/);
  const on = await page({ src: CDN, dataset: { hub: '', autostart: '0' }, local: {}, hub: hubSite('off', { refuse: 'allowlist' }) });
  await on.api.start();
  assert.deepEqual([on.api.state, !!on.api.site], ['enabled', true], 'no choice here: the site\'s default');
});

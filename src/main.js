// Entry point of sumika.js: <script src="/sumika/sumika.js" data-default-ghost="tsubasa" defer></script>
//
// Script tag options (all optional):
//   data-default-ghost   ghost folder name a first-time visitor meets; default: the first ghost in Change ghost ▸'s order
//                        (SSP's: by descript name) that can run here
//   data-default-balloon balloon folder name (site/balloon/<id>) for ghosts that bring no balloon; default: the index's
//                        (Sumika's own balloon when the site has it)
//   data-max-ghosts      most ghosts on screen at once (Call ghost ▸, \![call,ghost]); default: no limit, as SSP;
//                        1 = one ghost at a time (no Call ghost ▸)
//   data-base            site root URL if the runtime is not at <root>/sumika/sumika.js
//   data-autostart="0"   don't start automatically; call window.sumika.start() yourself
//   data-default-state   what a visitor who made no choice on the control page gets (core/choice.js,
//                        [decision]): "enabled" (absent, empty or an unknown value, which warns once: the ghost as
//                        usual), "tucked" (the set starts as her button in the corner on every device, as
//                        data-phone="tucked" does on a phone: a tap brings her out) or "off" (nothing at all unless the
//                        visitor turned Sumika on). Read only when Sumika may run here (not with data-phone="off" on a
//                        phone, not in a browser that cannot run it)
//   data-phone           phones only (core/phone.js, ssp-ui.md §9.11): "tucked" starts the set as her corner icon (a
//                        tap brings her out); "off": Sumika does nothing on phones (for sites that do not want it there); "on",
//                        empty or absent: items 1–3. A desktop or tablet never reads it
//   data-hub             the storage hub (core/hub.js): the visitor's data kept at the runtime host's origin, so pages
//                        on several origins of one site share it (a link between them resumes the ghosts, their tabs
//                        coordinate). Bare: sumika/hub.html next to sumika.js; a value: the absolute http(s) URL of a
//                        hub page. Absent: no hub (the page's own origin). Read only when Sumika may run
//                        here (as data-default-state); the hub is planted at the first start(), and a hub that is not
//                        usable leaves the page on its own origin
// The visitor's choice (core/choice.js: localStorage `sumika:choice`, 'on' | 'off', none = the site's default), set on
// the control page sumika/index.html (src/control/; nothing of Sumika links to it [decision]), lives where the runtime keeps
// its data: this origin's storage, read here before anything is made; with data-hub the hub's, read at the first
// start() once the hub decided (nothing visible or heavy happens before: the hub frame, and the site index while it
// decides unless the site's default is off). The order: data-phone="off" on a phone -> a browser that cannot run
// Sumika -> the visitor's choice -> data-default-state. On runs as "enabled" whatever the site's default (a phone with
// data-phone="tucked" still starts tucked: the site's layout for phones).
// window.sumika.phone: null (no phone), 'on', 'tucked' or 'off'. window.sumika.state: the state the page started in,
// 'enabled' or 'tucked' (with data-hub null until the first start read the choice), or 'off' in the stubs: a frozen
// stub whose site and runtime are null (the one exception to "runtime is never null") and whose calls do nothing, with
// `reason` 'phone' (data-phone="off": phone 'off'), 'unsupported', 'visitor' (the visitor's Off) or 'site'
// (data-default-state="off", no choice). Off fetches, stores, shows and listens to nothing (with data-hub: nothing but
// the hub frame, removed again, and the index as above). A browser that cannot run Sumika (core/support.js, CLAUDE.md
// "Browsers": too old, WebAssembly off) gets its stub with `supported: false` and the `missing` ids, one console warn,
// and nothing else: the page stays as it was. Page code tests `window.sumika && window.sumika.site` (null in the stubs;
// below the parse floor window.sumika is undefined)
import { log } from './core/log.js';
import { Runtime, VERSION } from './core/runtime.js';
import { Site } from './core/site.js';
import { MAX_GHOSTS } from './core/ghostset.js';
import { phoneInfo, phoneMode, offApi } from './core/phone.js';
import { missingFeatures, describeMissing, unsupportedApi } from './core/support.js';
import { platform, localStore } from './core/platform.js';
import { HubClient, hubAddress } from './core/hub.js';
import { defaultState, readChoice, startState } from './core/choice.js';

function currentScript() {
  if (document.currentScript) return document.currentScript;
  const all = document.querySelectorAll('script[src]');
  for (const s of all) if (/sumika(\.min)?\.js(\?|$)/.test(s.src)) return s;
  return null;
}

const script = currentScript();
const opts = {
  base: script && script.dataset.base
    ? new URL(script.dataset.base, location.href).href
    : script ? new URL('../', script.src).href : new URL('/', location.href).href,
  defaultGhost: (script && script.dataset.defaultGhost) || null,
  defaultBalloon: (script && script.dataset.defaultBalloon) || null,
};
opts.runtimeUrl = script ? script.src : new URL('sumika/sumika.js', opts.base).href;
const askedMax = script && script.dataset.maxGhosts ? parseInt(script.dataset.maxGhosts, 10) : NaN;
const maxGhosts = Number.isFinite(askedMax) ? askedMax : MAX_GHOSTS;     // the Site makes it at least 1

// a phone or not, decided once for the page (core/phone.js); data-phone is read only on a phone, so a desktop page
// never parses (nor warns about) it
const phone = phoneInfo(window);
const mode = phone ? phoneMode(script ? script.dataset : {}) : null;
// what this browser lacks (core/support.js); not asked when Sumika is off on this phone: both paths fetch nothing
const missing = mode === 'off' ? [] : missingFeatures(window);

/** The storage the runtime keeps the visitor's choice in: the storage hub's mirror, else this origin's (no probe write). */
function choiceStorage() {
  const hub = localStore();
  if (hub) return hub;
  try { return window.localStorage || null; } catch (e) { return null; }
}

/** Sumika does nothing on this page (core/choice.js startState 'off'): the off stub, one info line. */
function turnedOff(reason) {
  window.sumika = offApi(VERSION, { phone: mode, reason });
  log.info(reason === 'visitor' ? 'Sumika is off in this browser (the visitor\'s choice on the control page)'
    : 'Sumika is off on this page until the visitor turns it on (data-default-state="off")');
}

if (mode === 'off') {
  // nothing of the Site is made: no fetch, storage, channel, lock, worker or listener (only this file was loaded)
  window.sumika = offApi(VERSION);
  log.info('phone: Sumika is off on phones (data-phone="off")');
} else if (missing.length) {
  // a browser that cannot run a ghost: nothing of the Site is made either (no element, fetch, storage, lock, worker
  // or listener), so the page stays exactly as it was; a warn shows without ?sumika-debug
  window.sumika = unsupportedApi(VERSION, mode, missing);
  log.warn(`this browser cannot run Sumika: it lacks ${describeMissing(missing)}; nothing is shown`);
} else {
  const siteDefault = defaultState(script ? script.dataset : {});
  // data-hub (core/hub.js): installed before the Site exists, so nothing reads or writes this origin's storage until
  // the hub decided at the first start (the Site's start waits for it); without the attribute nothing changes. The
  // client hears the window's pagehide first of Sumika's listeners (made here, before the Site): into the
  // back/forward cache, the page posts no write to the hub until its pageshow
  const hubUrl = script ? hubAddress(script.dataset, opts.runtimeUrl, location) : null;
  const hub = hubUrl ? new HubClient(hubUrl, { window, debug: /[?&]sumika-debug\b/.test(location.search) }) : null;
  if (hub) platform.install(hub);
  // without the hub the visitor's choice is this origin's: read now, and an Off makes nothing at all
  const first = hub ? null : startState(readChoice(choiceStorage()).choice, siteDefault, mode);
  if (first && first.state === 'off') turnedOff(first.reason);
  else run(first, hub, siteDefault);
}

/**
 * The live page: the Site and window.sumika. `first`: startState's answer, or null while the storage hub `hub` has
 * not decided: the first page API call that can start anything (start(), autostart's too, calls and changes) waits for
 * the hub, reads the visitor's choice through it, and on Off lets the hub go and becomes the off stub (this object's
 * members then do nothing either: site and runtime null, state 'off').
 */
function run(first, hub, siteDefault) {
  let verdict = first;
  let deciding = null;
  const tucked = !!first && first.state === 'tucked';
  // the page's Site (core/site.js): the set of ghosts on screen, the lead lock 'sumika/lead' of the tab that runs it
  // (UI §9.5), one Runtime per ghost (CONTRACTS "Site"); a phone's options only on a phone (desktop: none), tucked
  // on a desktop with data-default-state="tucked" (the phone's tucked path, the desktop's layout)
  const site = new Site({ ...opts, lead: true, maxGhosts, createRuntime: o => new Runtime(o),
    ...(phone ? { phone, tucked } : tucked ? { tucked } : {}) });
  const off = () => !!verdict && verdict.state === 'off';
  // with the storage hub: its decision (Site.storageReady plants it; the index meanwhile unless the site's default is
  // off), then the visitor's choice through it
  const decide = () => deciding || (deciding = site.storageReady({ index: siteDefault !== 'off' }).then(() => {
    verdict = startState(readChoice(choiceStorage()).choice, siteDefault, mode);
    if (verdict.state === 'off') {
      hub.close();
      turnedOff(verdict.reason);
    } else site.tucked = verdict.state === 'tucked';
  }));
  /** f() while the page runs (at once once decided); `none` when Sumika turned out to be off here */
  const live = (f, none) => {
    if (verdict) return off() ? Promise.resolve(none) : f();
    return decide().then(() => (off() ? none : f()));
  };
  // one literal: a spread would read the getters once and freeze them
  const api = {
    version: VERSION,
    phone: mode,                                          // null: no phone; 'on' | 'tucked' (UI §9.11)
    get state() { return verdict ? verdict.state : null; },   // 'enabled' | 'tucked'; null while the hub decides
    get site() { return off() ? null : site; },
    get runtime() { return off() ? null : site.slots[0] || null; },   // the first ghost's Runtime (runtime.parts.loop: its event loop)
    start: () => live(() => site.start(), 'none'),
    // every site ghost: [{id, name, current, running, active, note, needs}] (current: the preferred ghost's; note: why
    // it cannot run here)
    ghosts: () => (off() ? [] : site.siteGhosts()),
    running: () => (off() ? [] : site.running()),         // the ghosts on screen, set order: [{id, name, active}]
    // like Call ghost ▸ of `from` (a ghost id; default: the one with the keys, else the first); true when it booted
    callGhost: (id, o) => live(() => site.callGhost(id, o), false),
    closeGhost: id => live(() => site.closeGhost(id), false),   // like that ghost's Close (default: the preferred one)
    quit: () => live(() => site.quit(0), false),          // like Quit: every ghost says goodbye
    changeGhost: (id, o) => live(() => site.changeGhost(id, o), false),   // like Change ghost ▸ of `from`; true when changed
    shells: o => (off() ? [] : site.shells(o)),           // Shell ▸ of {ghost}: [{id, name, current}] in SSP's name order
    balloons: o => (off() ? { top: [], all: [] } : site.balloons(o)),   // Balloon ▸ of {ghost}: {top, all}, rows {id, name, current}
    // like Shell ▸ / Balloon ▸ of {ghost} (a folder id; {byId: false} takes a descript name, 'random', 'sequential');
    // resolve true when changed (EV §2.6)
    changeShell: (target, o) => live(() => site.changeShell(target, o), false),
    changeBalloon: (target, o) => live(() => site.changeBalloon(target, o), false),
  };
  window.sumika = api;

  const boot = () => {
    api.start().catch(e => log.error('failed to start', e));
  };

  if (!script || script.dataset.autostart !== '0') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
}

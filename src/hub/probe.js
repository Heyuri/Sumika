// The hub's checks before it serves a page (CONTRACTS "Hub protocol"): whether its storage is the
// first-party storage of its site (the same-site rule), and whether its localStorage takes a write. Injectable, so
// tests/runtime/hub_server.test.mjs runs them on fakes.
import { PROBE_COOKIE } from '../core/hubproto.js';

/**
 * The same-site rule: a SameSite=Lax cookie set by script reads back only when the frame is same-site with its whole
 * ancestor chain, which is when browsers give it first-party (unpartitioned) storage [measured, Chromium]; a frame
 * under a cross-site page fails it, and failing means the page keeps its data on its own origin.
 * The cookie's name carries a nonce, so two tabs probing at once cannot read or delete each other's; its Path is the
 * hub page's own, so it is sent with no other request; it is deleted at once. `document.hasStorageAccess()`, where it
 * exists, can only veto (Chromium answers true while partitioned [measured P2]).
 * Not detected: WebKit keys storage by the top page's origin, not its site [infer], so in Safari a same-site hub passes
 * and still has one partition per host page origin; each listed site then keeps its own copy, as without the hub.
 * @param {{document: Document, navigator?: object, location: Location, random?: () => number}} env
 * @returns {Promise<boolean>}
 */
export async function sameSite({ document, navigator, location, random = Math.random }) {
  try {
    if (navigator && navigator.cookieEnabled === false) return false;
    const nonce = Math.floor(random() * 0x100000000).toString(36) + Date.now().toString(36);
    const name = `${PROBE_COOKIE}-${nonce}`;
    const path = /^\/[^;,\s]*$/.test(location.pathname) ? location.pathname : '/';
    const attrs = `; Path=${path}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    document.cookie = `${name}=1; Max-Age=10${attrs}`;
    const back = String(document.cookie).split(/;\s*/).includes(`${name}=1`);
    document.cookie = `${name}=; Max-Age=0${attrs}`;
    if (!back) return false;
  } catch (e) {
    return false;
  }
  if (document && typeof document.hasStorageAccess === 'function') {
    try {
      if ((await document.hasStorageAccess()) === false) return false;
    } catch (e) { /* no answer: no veto */ }
  }
  return true;
}

/** The hub's own scratch key: outside `sumika:`, so no page reads or writes it. */
export const PROBE_KEY = 'sumika-hub:probe';

/** Whether a localStorage takes a write (and a remove). */
export function storageWorks(ls) {
  try {
    ls.setItem(PROBE_KEY, '1');
    ls.removeItem(PROBE_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

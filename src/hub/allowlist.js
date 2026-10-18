// The storage hub's allowlist (CONTRACTS "Hub protocol"): `sumika/hub.json` next to hub.html, set by the
// publisher on the hub's own host, never built, versioned or pruned: {"format": 1, "origins": ["https://a.example.com",
// …]}. A page is answered only when its origin (the browser's serialisation, event.origin) equals a kept entry exactly:
// scheme, host and port, no wildcards. Pure: no fetch, no globals (tests/runtime/hub_allowlist.test.mjs).

/** The hub.json format this hub reads; a higher one is a newer file than this hub, which then answers no page. */
export const ALLOW_FORMAT = 1;

/** Whether a URL hostname (lower-case, as `new URL` gives it) is a loopback host: localhost and its subdomains,
 * 127.0.0.0/8, [::1] and [::ffff:127.x.x.x]. */
export function isLoopback(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  if (h === '[::1]' || h === '[0:0:0:0:0:0:0:1]') return true;
  return /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h); // an IPv4-mapped 127.x as WHATWG URL writes it
}

/**
 * Why an entry is not kept, or null when it is (then `origin` is its normalised origin).
 * @param {*} entry one item of `origins`
 * @param {URL} hub the hub page's URL
 * @returns {{origin: string|null, why: string|null}}
 */
function judge(entry, hub) {
  if (entry === null || entry === 'null') return { origin: null, why: 'null is no origin a page can be listed by' };
  if (typeof entry !== 'string') return { origin: null, why: 'not a string' };
  if (entry.includes('*')) return { origin: null, why: 'no wildcards: list each address' };
  let u;
  try {
    u = new URL(entry);
  } catch (e) {
    return { origin: null, why: 'not an absolute URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { origin: null, why: `not http(s) (${u.protocol})` };
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(entry)) return { origin: null, why: 'has a user name or password' };
  // new URL drops an empty `?` or `#`, so the text is checked too
  if (u.search || u.hash || /[?#]/.test(entry)) return { origin: null, why: 'has a query or fragment' };
  if (u.pathname !== '/') return { origin: null, why: `has a path (${u.pathname}): list the origin only` };
  if (u.protocol !== hub.protocol) {
    return { origin: null, why: `its scheme ${u.protocol} differs from the hub's ${hub.protocol} (such a page is another site)` };
  }
  if (isLoopback(u.hostname) && !isLoopback(hub.hostname)) {
    return { origin: null, why: 'a loopback address, and this hub is not on one (a test entry left in a published hub.json)' };
  }
  return { origin: u.origin, why: null };
}

/**
 * Parse hub.json's text.
 * @param {string|null|undefined} text the file's text; null: missing, an HTTP error or a failed fetch
 * @param {string|URL} hubUrl the hub page's URL (its scheme and whether it is on loopback)
 * @returns {{ok: boolean, origins: Set<string>, ignored: {entry: *, why: string}[], error: string|null}}
 *   ok false (with `error`): the hub answers no page
 */
export function parseAllowlist(text, hubUrl) {
  const out = { ok: false, origins: new Set(), ignored: [], error: null };
  if (text == null) { out.error = 'missing or unreadable'; return out; }
  let j;
  try {
    j = JSON.parse(String(text));
  } catch (e) {
    out.error = 'no JSON';
    return out;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) { out.error = 'no JSON object'; return out; }
  if (typeof j.format === 'number' && j.format > ALLOW_FORMAT) {
    out.error = `format ${j.format} is newer than this hub reads (${ALLOW_FORMAT}): publish the current runtime`;
    return out;
  }
  if (j.format !== ALLOW_FORMAT) { out.error = `format ${JSON.stringify(j.format)} is not ${ALLOW_FORMAT}`; return out; }
  if (!Array.isArray(j.origins)) { out.error = 'no "origins" array'; return out; }
  let hub;
  try {
    hub = new URL(String(hubUrl));
  } catch (e) {
    out.error = 'the hub has no URL';
    return out;
  }
  for (const entry of j.origins) {
    const { origin, why } = judge(entry, hub);
    if (origin) out.origins.add(origin);
    else out.ignored.push({ entry, why });
  }
  out.ok = true;
  return out;
}

/** Whether a page origin (event.origin) is answered: an exact match of a kept entry. */
export function allowed(list, origin) {
  return !!(list && list.ok && typeof origin === 'string' && list.origins.has(origin));
}

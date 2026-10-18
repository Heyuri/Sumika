// The storage hub's allowlist (src/hub/allowlist.js): sumika/hub.json on the hub's own host decides which
// page origins the hub answers. A missing, non-JSON or wrong-shape file, or a newer format, answers nobody; entries match
// a page's origin exactly (scheme, host, port; host lower-cased, IDN as punycode, the default port dropped); an entry
// that is no plain origin (a path, query, fragment, user info, a wildcard, null, another scheme, the hub's other scheme,
// a loopback address under a published hub) is ignored with a reason. Also loadAllowlist (src/hub/hub.js): hub.json
// fetched without cache and credentials, a tab's usable list reused for ALLOW_TTL_MS, an unusable one never.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowlist, allowed, isLoopback, ALLOW_FORMAT } from '../../src/hub/allowlist.js';
import { loadAllowlist, ALLOW_CACHE_KEY, ALLOW_TTL_MS } from '../../src/hub/hub.js';

const HUB = 'https://sumika.example.com/sumika/hub.html?sumika-hub=1';
const LOCAL_HUB = 'http://localhost:8643/sumika/hub.html?sumika-hub=1';
const file = origins => JSON.stringify({ format: 1, origins });
const why = (list, entry) => (list.ignored.find(i => i.entry === entry) || {}).why || null;

test('a missing, non-JSON or wrong-shape hub.json, or a newer format, answers no page', () => {
  assert.equal(ALLOW_FORMAT, 1);
  const cases = {
    'missing (null)': [null, /missing/],
    'missing (undefined)': [undefined, /missing/],
    'empty': ['', /no JSON/],
    'HTML (a host\'s fallback page)': ['<!doctype html><title>x</title>', /no JSON/],
    'an array': ['["https://a.example.com"]', /no JSON object/],
    'null': ['null', /no JSON object/],
    'no format': [JSON.stringify({ origins: ['https://a.example.com'] }), /format undefined is not 1/],
    'format "1"': [JSON.stringify({ format: '1', origins: ['https://a.example.com'] }), /format "1" is not 1/],
    'format 0': [JSON.stringify({ format: 0, origins: ['https://a.example.com'] }), /format 0 is not 1/],
    'format 2 (newer than this hub)': [JSON.stringify({ format: 2, origins: ['https://a.example.com'] }), /format 2 is newer/],
    'no origins': [JSON.stringify({ format: 1 }), /no "origins" array/],
    'origins a string': [JSON.stringify({ format: 1, origins: 'https://a.example.com' }), /no "origins" array/],
  };
  for (const [what, [text, words]] of Object.entries(cases)) {
    const list = parseAllowlist(text, HUB);
    assert.equal(list.ok, false, what);
    assert.match(list.error, words, what);
    assert.equal(allowed(list, 'https://a.example.com'), false, what);
  }
  assert.equal(allowed(null, 'https://a.example.com'), false);
});

test('exact origins: the port counts, the host is lower-cased, IDN becomes punycode, the default port and a trailing / go', () => {
  const list = parseAllowlist(file([
    'https://a.example.com', 'https://B.Example.COM/', 'https://c.example.com:443', 'https://d.example.com:8443',
    'https://bücher.example.com', 'https://e.example.com.',
  ]), HUB);
  assert.equal(list.ok, true);
  assert.deepEqual(list.ignored, []);
  assert.deepEqual([...list.origins], ['https://a.example.com', 'https://b.example.com', 'https://c.example.com',
    'https://d.example.com:8443', 'https://xn--bcher-kva.example.com', 'https://e.example.com.']);
  for (const o of ['https://a.example.com', 'https://b.example.com', 'https://c.example.com', 'https://d.example.com:8443',
    'https://xn--bcher-kva.example.com']) assert.equal(allowed(list, o), true, o);
  for (const o of ['https://a.example.com.evil.test', 'https://evil.test', 'https://example.com', 'https://x.a.example.com',
    'http://a.example.com', 'https://a.example.com:8443', 'https://d.example.com', 'https://a.example.co', 'null', '',
    'https://A.example.com', 'https://a.example.com/']) {
    assert.equal(allowed(list, o), false, o);
  }
  assert.equal(allowed(list, undefined), false);
});

test('an entry that is no plain origin is ignored, with its reason; the others are kept', () => {
  const bad = ['https://a.example.com/sumika/', 'https://a.example.com/?', 'https://a.example.com/?x=1', 'https://a.example.com#',
    'https://a.example.com/#top', 'https://user@a.example.com', 'https://u:p@a.example.com', 'https://@a.example.com',
    'https://*.example.com', '*', 'null', null, 42, { origin: 'https://a.example.com' }, 'ftp://a.example.com',
    'javascript:alert(1)', 'data:text/html,x', 'a.example.com', '//a.example.com', '', 'http://a.example.com'];
  const list = parseAllowlist(file(['https://ok.example.com', ...bad]), HUB);
  assert.equal(list.ok, true);
  assert.deepEqual([...list.origins], ['https://ok.example.com']);
  assert.equal(list.ignored.length, bad.length);
  const reasons = {
    'https://a.example.com/sumika/': /has a path/,
    'https://a.example.com/?': /query or fragment/,
    'https://a.example.com/?x=1': /query or fragment/,
    'https://a.example.com#': /query or fragment/,
    'https://a.example.com/#top': /query or fragment/,
    'https://user@a.example.com': /user name or password/,
    'https://u:p@a.example.com': /user name or password/,
    'https://@a.example.com': /user name or password/,
    'https://*.example.com': /wildcards/,
    '*': /wildcards/,
    'null': /null/,
    'ftp://a.example.com': /not http\(s\)/,
    'javascript:alert(1)': /not http\(s\)/,
    'data:text/html,x': /not http\(s\)/,
    'a.example.com': /not an absolute URL/,
    '//a.example.com': /not an absolute URL/,
    '': /not an absolute URL/,
    'http://a.example.com': /scheme http: differs from the hub's https:/,
  };
  for (const [entry, words] of Object.entries(reasons)) assert.match(why(list, entry) || '', words, entry);
  assert.match(why(list, null), /null/);
  assert.match(why(list, 42), /not a string/);
  assert.equal(allowed(list, 'https://a.example.com'), false);
});

test('loopback entries: ignored by a hub on a public host, honoured by a hub on loopback (ports and nested names count)', () => {
  const loop = ['http://localhost:8644', 'http://a.test.localhost:8644', 'http://127.0.0.1:8644', 'http://127.0.0.2:8644',
    'http://[::1]:8644', 'http://LOCALHOST:8645'];
  const pub = parseAllowlist(file(loop.map(o => o.replace(/^http:/, 'https:'))), HUB);
  assert.equal(pub.ok, true);
  assert.equal(pub.origins.size, 0);
  for (const i of pub.ignored) assert.match(i.why, /loopback/, String(i.entry));
  const local = parseAllowlist(file(loop), LOCAL_HUB);
  assert.deepEqual(local.ignored, []);
  assert.deepEqual([...local.origins], ['http://localhost:8644', 'http://a.test.localhost:8644', 'http://127.0.0.1:8644',
    'http://127.0.0.2:8644', 'http://[::1]:8644', 'http://localhost:8645']);
  assert.equal(allowed(local, 'http://localhost:8644'), true);
  assert.equal(allowed(local, 'http://localhost:8646'), false, 'another port is another origin');
  assert.equal(allowed(local, 'http://b.test.localhost:8644'), false);
  // a hub on a nested loopback name, or on 127.0.0.1, is on loopback too
  assert.equal(parseAllowlist(file(['http://localhost:8644']), 'http://sumika.test.localhost:8643/sumika/hub.html').origins.size, 1);
  assert.equal(parseAllowlist(file(['http://localhost:8644']), 'http://127.0.0.1:8643/sumika/hub.html').origins.size, 1);
});

test('isLoopback: localhost and its subdomains, 127/8, [::1] and IPv4-mapped 127; nothing else', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', 'a.test.localhost', '127.0.0.1', '127.255.0.9',
    '[::1]', '[::ffff:7f00:1]']) assert.equal(isLoopback(h), true, h);
  for (const h of ['example.com', 'localhost.example.com', 'mylocalhost', '128.0.0.1', '10.0.0.1', '0.0.0.0', '[::2]',
    '[::ffff:a00:1]', '', null, undefined]) assert.equal(isLoopback(h), false, String(h));
});

test('duplicates are harmless; the hub\'s own origin is kept only when listed (a page on it never plants the hub)', () => {
  const list = parseAllowlist(file(['https://a.example.com', 'https://a.example.com/', 'https://A.example.com:443']), HUB);
  assert.deepEqual([...list.origins], ['https://a.example.com']);
  assert.equal(allowed(list, 'https://sumika.example.com'), false);
  assert.equal(allowed(parseAllowlist(file(['https://sumika.example.com']), HUB), 'https://sumika.example.com'), true);
  assert.deepEqual([...parseAllowlist(file([]), HUB).origins], [], 'an empty list is usable and answers nobody');
  assert.equal(parseAllowlist(file([]), HUB).ok, true);
  const extra = parseAllowlist(JSON.stringify({ format: 1, origins: ['https://a.example.com'], later: { x: 1 } }), HUB);
  assert.equal(extra.ok, true, 'other top-level keys are room for later settings');
});

function memSession() {
  const m = new Map();
  return {
    m,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
}

test('loadAllowlist: hub.json next to hub.html, no-cache and no credentials; a usable list is reused in this tab for ALLOW_TTL_MS, an unusable one never', async () => {
  const warns = [];
  const log = { warn: (...a) => warns.push(a.join(' ')), info() {}, debug() {} };
  const calls = [];
  let body = file(['https://a.example.com', 'https://a.example.com/x']);
  let status = 200;
  const fetch = async (url, init) => {
    calls.push([url, init.cache, init.credentials]);
    return { ok: status === 200, status, text: async () => body };
  };
  const ss = memSession();
  let t = 1_000_000;
  const now = () => t;
  let list = await loadAllowlist({ url: HUB, fetch, sessionStorage: ss, now, log });
  assert.deepEqual(calls, [['https://sumika.example.com/sumika/hub.json', 'no-cache', 'omit']]);
  assert.equal(allowed(list, 'https://a.example.com'), true);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /"https:\/\/a\.example\.com\/x" is ignored: has a path/);
  assert.ok(ss.m.has(ALLOW_CACHE_KEY));
  assert.ok(!ALLOW_CACHE_KEY.startsWith('sumika.'), 'outside the keys pages may read or write');

  body = file([]);
  t += ALLOW_TTL_MS - 1;
  list = await loadAllowlist({ url: HUB, fetch, sessionStorage: ss, now, log });
  assert.equal(calls.length, 1, 'the next page of the tab answers from the cached list');
  assert.equal(allowed(list, 'https://a.example.com'), true);
  t += 1;
  list = await loadAllowlist({ url: HUB, fetch, sessionStorage: ss, now, log });
  assert.equal(calls.length, 2, 'after ALLOW_TTL_MS it is fetched again');
  assert.equal(allowed(list, 'https://a.example.com'), false, 'the origin removed from hub.json is refused');

  status = 404;
  t += ALLOW_TTL_MS;
  list = await loadAllowlist({ url: HUB, fetch, sessionStorage: ss, now, log });
  assert.equal(list.ok, false);
  assert.match(warns.at(-1), /^sumika\/hub\.json: missing or unreadable; this hub answers no page$/);
  assert.ok(!ss.m.has(ALLOW_CACHE_KEY), 'an unusable list is not cached');
  status = 200;
  body = file(['https://a.example.com']);
  list = await loadAllowlist({ url: HUB, fetch, sessionStorage: ss, now, log });
  assert.equal(calls.length, 4, 'so a fixed hub.json is read at the next page');
  assert.equal(allowed(list, 'https://a.example.com'), true);

  // a cache from another hub page of the origin, from the future, or broken: fetched again
  for (const bad of [JSON.stringify({ at: t, from: 'https://sumika.example.com/other/hub.json', text: body }),
    JSON.stringify({ at: t + 10, from: 'https://sumika.example.com/sumika/hub.json', text: body }), '{', 'null']) {
    ss.setItem(ALLOW_CACHE_KEY, bad);
    const n = calls.length;
    await loadAllowlist({ url: HUB, fetch, sessionStorage: ss, now, log });
    assert.equal(calls.length, n + 1, bad);
  }
  // no session storage, a network failure
  const failing = async () => { throw new TypeError('Failed to fetch'); };
  list = await loadAllowlist({ url: HUB, fetch: failing, sessionStorage: null, now, log });
  assert.equal(list.ok, false);
});

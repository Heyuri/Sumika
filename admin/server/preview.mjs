// The preview (CONTRACTS "Admin API" preview): three servers on 127.0.0.1, new ports at each start (a fresh visitor
// each preview). S serves the site as tools/serve.py does with --cors and --hub-allow: GET and HEAD only,
// Cache-Control: no-cache, Access-Control-Allow-Origin: *, any …/sumika/hub.json answered from memory with the two page
// origins and Cache-Control: no-store whatever file is there (no test allowlist is ever a file), serve.py's types, /x/
// -> x/index.html, /x (a folder) -> 301 /x/, no listing, no Range, safeRelPath on the path and a link anywhere on it ->
// 404. A and B are two page origins serving one generated page in the admin's language that loads S's sumika.js with
// data-hub and links to the other: ports of one host are one site, so the hub frame is first-party under both.
// Read-only: nothing is written. Every server checks Host.
import fs from 'node:fs';
import path from 'node:path';
import { isLink } from '../core/tree.mjs';
import { safeRelPath } from './paths.mjs';
import { say } from './say.mjs';

/** Content types: serve.py's own, then fixed ones for the rest (a .gz is a file, never Content-Encoding). */
export const TYPES = Object.freeze({
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.txt': 'text/plain', '.css': 'text/css', '.wasm': 'application/wasm',
  '.png': 'image/png', '.pna': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.ico': 'image/vnd.microsoft.icon', '.cur': 'image/vnd.microsoft.icon', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mid': 'audio/midi',
  '.midi': 'audio/midi', '.gz': 'application/gzip', '.pack': 'application/octet-stream', '.map': 'application/json',
  '.xml': 'text/xml', '.csv': 'text/csv',
});

export const typeOf = name => TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';

const text = (status, body, headers = {}) => new Response(body, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', ...headers },
});

/** The site server's handler (S). allow(): the page origins hub.json lists. */
export function siteHandler({ root, port, allow }) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  return async (req, info) => {
    if (!info || info.host !== `127.0.0.1:${port()}`) return text(403, 'Forbidden', cors);
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method not allowed', { ...cors, Allow: 'GET, HEAD' });
    const url = new URL(req.url);
    let p;
    try {
      p = decodeURIComponent(url.pathname);
    } catch (e) {
      return text(400, 'Bad request', cors);
    }
    const head = req.method === 'HEAD';
    if (p.endsWith('/sumika/hub.json')) {
      const body = new TextEncoder().encode(JSON.stringify({ format: 1, origins: allow() }, null, 1) + '\n');
      return new Response(head ? null : body, {
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), 'Cache-Control': 'no-store', ...cors },
      });
    }
    let rel = p.slice(1);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const segs = safeRelPath(rel);
    if (!segs) return text(404, 'Not found', cors);
    let cur = root, st = null;
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i]);
      try {
        st = fs.lstatSync(cur);
      } catch (e) {
        return text(404, 'Not found', cors);
      }
      if (st.isSymbolicLink() || isLink(cur)) return text(404, 'Not found', cors);
      if (i < segs.length - 1 && !st.isDirectory()) return text(404, 'Not found', cors);
    }
    if (st.isDirectory()) return text(301, 'Moved', { ...cors, Location: `${url.pathname}/${url.search}` });
    if (!st.isFile()) return text(404, 'Not found', cors);
    let bytes;
    try {
      bytes = fs.readFileSync(cur);
    } catch (e) {
      return text(404, 'Not found', cors);
    }
    return new Response(head ? null : bytes, {
      headers: { 'Content-Type': typeOf(cur), 'Content-Length': String(bytes.length), 'Cache-Control': 'no-cache', ...cors },
    });
  };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);

/** The test page of a page origin: S's sumika.js with data-hub, which origin it is, a link to the other. */
export function previewPage({ lang, here, other, site }) {
  const l = lang === 'ja' ? 'ja' : 'en';
  const title = say('preview.page.title', l, { origin: here });
  return `<!doctype html>
<html lang="${l}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,"Yu Gothic UI","Hiragino Sans",Meiryo,sans-serif;margin:2rem;max-width:42rem}</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p>${esc(say('preview.page.intro', l, { origin: here, site }))}</p>
<p><a href="${esc(other)}/">${esc(say('preview.page.link', l, { other }))}</a></p>
<script src="${esc(site)}/sumika/sumika.js" data-hub defer></script>
</body>
</html>
`;
}

/** A page origin's handler (A or B): its page at / (and /index.html), 404 for anything else. */
export function pageHandler({ port, html }) {
  return async (req, info) => {
    if (!info || info.host !== `127.0.0.1:${port()}`) return text(403, 'Forbidden');
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const p = new URL(req.url).pathname;
    if (p !== '/' && p !== '/index.html') return text(404, 'Not found');
    const body = new TextEncoder().encode(html());
    return new Response(req.method === 'HEAD' ? null : body, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-cache' },
    });
  };
}

/**
 * Starts the three servers.
 * @param {{site: string, lang: 'ja'|'en', serve: Function}} o serve: serve.mjs's
 * @returns {Promise<{site: string, pages: string[], stop: () => Promise<void>}>}
 */
export async function startPreview({ site, lang, serve }) {
  const ports = { s: 0, a: 0, b: 0 };
  const origin = k => `http://127.0.0.1:${ports[k]}`;
  const started = [];
  try {
    const s = await serve(siteHandler({ root: site, port: () => ports.s, allow: () => [origin('a'), origin('b')] }));
    started.push(s);
    ports.s = s.port;
    const page = (me, other) => pageHandler({
      port: () => ports[me], html: () => previewPage({ lang, here: origin(me), other: origin(other), site: origin('s') }),
    });
    const a = await serve(page('a', 'b'));
    started.push(a);
    ports.a = a.port;
    const b = await serve(page('b', 'a'));
    started.push(b);
    ports.b = b.port;
  } catch (e) {
    await Promise.all(started.map(x => x.close().catch(() => {})));
    throw e;
  }
  let stopped = false;
  return {
    site: `${origin('s')}/`,
    pages: [`${origin('a')}/`, `${origin('b')}/`],
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await Promise.all(started.map(x => x.close().catch(() => {})));
    },
  };
}

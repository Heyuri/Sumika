// One HTTP server shape for both runtimes: a web-standard handler `(Request, {host}) =>
// Response` behind Deno.serve in the compiled program and node:http under Node (tests, dev runs). `host` is the raw
// Host header as the client sent it (the guards check it; a Request's URL is never built from it here). Responses are
// whole bodies (JSON, the page, a preview file), sent with their length.
import http from 'node:http';
import { Readable } from 'node:stream';
import { Buffer } from 'node:buffer';

const SKIP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'expect']);

/**
 * Listen on hostname:port (0: a free port) until close().
 * @param {(req: Request, info: {host: string}) => Promise<Response>|Response} handler
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function serve(handler, { hostname = '127.0.0.1', port = 0 } = {}) {
  const D = globalThis.Deno;
  if (D && typeof D.serve === 'function') {
    const ac = new AbortController();
    let listening;
    const ready = new Promise(resolve => { listening = resolve; });
    const server = D.serve({ hostname, port, signal: ac.signal, onListen: addr => listening(addr) },
      req => handler(req, { host: req.headers.get('host') ?? '' }));
    const addr = await ready;
    return {
      port: addr.port,
      close: async () => {
        ac.abort();
        await server.finished.catch(() => {});
      },
    };
  }
  const server = http.createServer(async (req, res) => {
    let response;
    try {
      const headers = new Headers();
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        if (SKIP.has(req.rawHeaders[i].toLowerCase())) continue;
        try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]); } catch (e) { /* a header fetch refuses */ }
      }
      const init = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = Readable.toWeb(req);
        init.duplex = 'half';
      }
      const target = req.url && req.url.startsWith('/') ? req.url : '/';
      response = await handler(new Request(`http://127.0.0.1:${server.address().port}${target}`, init), { host: req.headers.host ?? '' });
    } catch (e) {
      response = new Response('internal error', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    try {
      const body = req.method === 'HEAD' || !response.body ? null : Buffer.from(await response.arrayBuffer());
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      if (body) res.setHeader('Content-Length', body.length);
      res.end(body ?? undefined);
    } catch (e) {
      res.destroy();
    }
  });
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }),
  };
}

// The request guards and the response headers of the admin program (CONTRACTS "Admin API" guards):
// Host exactly 127.0.0.1:<port> (DNS rebinding), Origin absent or the page's own, the start's key on every /api/ call
// in a header (never a cookie, so no other site's request carries it; a custom header also makes any cross-origin call
// a preflight, which is answered 405), JSON bodies of at most 1 MiB, no CORS header ever.
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ApiError } from './codes.mjs';

export const KEY_HEADER = 'x-sumika-admin-key';
export const MAX_BODY = 1 << 20;

const BASE = Object.freeze({
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
});

/** A JSON answer with the base headers. */
export function json(status, value) {
  return new Response(JSON.stringify(value), {
    status, headers: { ...BASE, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** An ApiError (or any error: 500 internal) as the API's error answer. */
export function errorResponse(e) {
  if (e instanceof ApiError) return json(e.status, { error: e.toJSON() });
  const error = String((e && e.message) || e);
  return json(500, { error: new ApiError(500, 'internal', { error }).toJSON() });
}

/** The page, with its CSP (hashes of its one inline script and style) and no framing. */
export function pageResponse(page) {
  return new Response(page.html, {
    headers: {
      ...BASE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': page.csp, 'X-Frame-Options': 'DENY',
    },
  });
}

/** Whether two keys are equal, in constant time for keys of one length. */
export function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Host and Origin: throws 403 bad-host / bad-origin. */
export function checkPeer(req, info, port) {
  if (!info || info.host !== `127.0.0.1:${port}`) throw new ApiError(403, 'bad-host');
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== `http://127.0.0.1:${port}`) throw new ApiError(403, 'bad-origin');
}

/** The key header: throws 403 no-key / bad-key. */
export function checkKey(req, key) {
  const got = req.headers.get(KEY_HEADER);
  if (got === null || got === '') throw new ApiError(403, 'no-key');
  if (!sameKey(got, key)) throw new ApiError(403, 'bad-key');
}

/**
 * A POST's JSON object body: 415 not-json for another type, 413 too-large past MAX_BODY (read no further), 400
 * bad-request when it is no JSON object.
 */
export async function readJson(req, limit = MAX_BODY) {
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError(415, 'not-json');
  const length = Number(req.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) throw new ApiError(413, 'too-large');
  const chunks = [];
  let size = 0;
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.byteLength;
      if (size > limit) throw new ApiError(413, 'too-large');
      chunks.push(chunk);
    }
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8'));
  } catch (e) {
    throw new ApiError(400, 'bad-request', { detail: 'no JSON' });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'bad-request', { detail: 'no JSON object' });
  return value;
}

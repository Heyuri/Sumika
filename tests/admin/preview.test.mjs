// The preview (CONTRACTS "Admin API" preview): three servers on 127.0.0.1 (real sockets, free ports), the site served
// as tools/serve.py serves it with --cors and --hub-allow, two page origins with the test page, the Host check, paths
// that leave the site or cross a link refused, and stop closing every port. On a scratch site under os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import * as core from '../../admin/core/api.mjs';
import { serve } from '../../admin/server/serve.mjs';
import { startPreview, typeOf } from '../../admin/server/preview.mjs';
import { createApp } from '../../admin/server/app.mjs';
import { Jobs } from '../../admin/server/jobs.mjs';
import { Drops } from '../../admin/server/drops.mjs';
import { loadSettings } from '../../admin/server/settings.mjs';
import { makeSite, scratchOnly } from '../../admin/server/drive.mjs';
import { loadStrings } from '../../admin/server/say.mjs';

function scratch(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-preview-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return scratchOnly(d);
}

/** A raw request: the path as written (no normalisation) and a Host of one's own. */
function raw(port, p, { method = 'GET', host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: host } }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const portOf = url => Number(new URL(url).port);

function refused(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
  });
}

async function site(t) {
  const d = scratch(t);
  const s = makeSite(path.join(d, 'site'));
  const g = path.join(s, 'ghost', 'g');
  fs.mkdirSync(path.join(g, 'ghost', 'master'), { recursive: true });
  fs.writeFileSync(path.join(g, 'ghost', 'master', 'descript.txt'), 'charset,UTF-8\r\nname,G\r\n');
  fs.writeFileSync(path.join(g, 'ghost', 'master', 'surface0.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await core.indexSite(s);
  fs.writeFileSync(path.join(s, 'sumika', 'hub.json'), JSON.stringify({ format: 1, origins: ['https://published.example.com'] }));
  fs.writeFileSync(path.join(d, 'secret.txt'), 'outside the site');
  fs.mkdirSync(path.join(d, 'outside'));
  fs.writeFileSync(path.join(d, 'outside', 'x.txt'), 'outside');
  fs.symlinkSync(path.join(d, 'outside'), path.join(s, 'ghost', 'linked'), 'junction');
  return { dir: d, site: s };
}

test('the site server: serve.py\'s types and headers, the test hub.json from memory, Host checked, no path out of the site', async t => {
  await loadStrings();
  const { site: s } = await site(t);
  const pv = await startPreview({ site: s, lang: 'en', serve });
  t.after(() => pv.stop());
  const S = portOf(pv.site);
  const [A, B] = pv.pages.map(portOf);
  assert.ok(new Set([S, A, B]).size === 3, 'three ports');
  const index = await raw(S, '/');
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html');
  assert.equal(index.headers['cache-control'], 'no-cache');
  assert.equal(index.headers['access-control-allow-origin'], '*');
  assert.equal(index.headers['content-length'], String(index.body.length));
  for (const [p, type] of [['/sumika/sumika.js', 'text/javascript'], ['/sumika/build.json', 'application/json'],
    ['/sumika/engines/satori.2222222222.wasm', 'application/wasm'], ['/ghost/g/ghost/master/surface0.png', 'image/png'],
    ['/ghost/g/ghost/master/descript.txt', 'text/plain'], ['/404.html', 'text/html']]) {
    const r = await raw(S, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.equal(r.headers['content-encoding'], undefined, p);
  }
  const pack = fs.readdirSync(path.join(s, 'sumika', 'index')).find(n => n.endsWith('.pack.gz'));
  const pr = await raw(S, `/sumika/index/${pack}`);
  assert.deepEqual([pr.status, pr.headers['content-type'], pr.headers['content-encoding']], [200, 'application/gzip', undefined]);
  assert.equal(typeOf('a.unknownext'), 'application/octet-stream');
  // hub.json: the two page origins, from memory, whatever file is there
  for (const p of ['/sumika/hub.json', '/sub/sumika/hub.json']) {
    const h = await raw(S, p);
    assert.equal(h.status, 200, p);
    assert.equal(h.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(h.body.toString('utf8')), { format: 1, origins: [`http://127.0.0.1:${A}`, `http://127.0.0.1:${B}`] });
  }
  const head = await raw(S, '/sumika/hub.json', { method: 'HEAD' });
  assert.deepEqual([head.status, head.body.length], [200, 0]);
  assert.match(fs.readFileSync(path.join(s, 'sumika', 'hub.json'), 'utf8'), /published\.example\.com/, 'the file is neither used nor changed');
  // folders, no listing, methods
  const folder = await raw(S, '/ghost/g');
  assert.deepEqual([folder.status, folder.headers.location], [301, '/ghost/g/']);
  assert.equal((await raw(S, '/ghost/g/')).status, 404, 'no listing');
  assert.equal((await raw(S, '/', { method: 'POST' })).status, 405);
  // the Host check, on every server
  for (const port of [S, A, B]) {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port + 1}`, 'evil.example']) {
      assert.equal((await raw(port, '/', { host })).status, 403, `${port} ${host}`);
    }
  }
  // nothing outside the site, nothing through a link
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/ghost/%2e%2e/%2e%2e/secret.txt', '/ghost%5c..%5c..%5csecret.txt',
    '/C%3a/secret.txt', '/ghost/linked/x.txt', '/ghost/linked/', '/ghost/linked', '/%00', '/CON', '/sumika/build.json.']) {
    const r = await raw(S, p);
    assert.ok(r.status === 404 || r.status === 400, `${p}: ${r.status}`);
    assert.ok(!/outside/.test(r.body.toString('utf8')), p);
  }
});

test('the page servers: the test page in the admin\'s language, S\'s sumika.js with data-hub, a link to the other origin', async t => {
  await loadStrings();
  const { site: s } = await site(t);
  for (const lang of ['ja', 'en']) {
    const pv = await startPreview({ site: s, lang, serve });
    const [a, b] = pv.pages;
    const page = await raw(portOf(a), '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    const html = page.body.toString('utf8');
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    assert.ok(html.includes(`<script src="${pv.site}sumika/sumika.js" data-hub defer></script>`), html);
    assert.ok(html.includes(`<a href="${b}">`), html);
    assert.ok(html.includes(a.replace(/\/$/, '')), 'it says which origin it is');
    if (lang === 'ja') assert.match(html, /プレビュー/);
    const other = await raw(portOf(b), '/index.html');
    assert.ok(other.body.toString('utf8').includes(`<a href="${a}">`));
    assert.equal((await raw(portOf(a), '/sumika/sumika.js')).status, 404, 'a page origin serves its page only');
    await pv.stop();
    for (const u of [pv.site, a, b]) assert.ok(await refused(portOf(u)), `${u} closed`);
  }
});

test('the API starts and stops the preview: new ports each start, the old ones closed', async t => {
  const d = scratch(t);
  const s = makeSite(path.join(d, 'site'));
  await core.indexSite(s);
  const run = path.join(d, 'run');
  fs.mkdirSync(path.join(run, 'x'), { recursive: true });
  const st = loadSettings({ file: path.join(d, 'settings.json'), where: 'given' });
  const app = createApp({
    port: 1, key: 'k', page: { html: '', csp: '' }, st, jobs: new Jobs({ runner: async () => ({}) }), drops: new Drops(run),
    xDir: path.join(run, 'x'), serve, env: {},
  });
  t.after(() => app.stopPreview());
  const call = async (p, body) => {
    const res = await app.handle(new Request(`http://127.0.0.1:1${p}`, {
      method: 'POST', headers: { 'X-Sumika-Admin-Key': 'k', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), { host: '127.0.0.1:1' });
    return { status: res.status, json: await res.json() };
  };
  assert.equal((await call('/api/site', { path: s })).status, 200);
  const one = await call('/api/preview/start', { lang: 'en' });
  assert.equal(one.status, 200);
  assert.equal(one.json.pages.length, 2);
  assert.equal((await raw(portOf(one.json.site), '/')).status, 200);
  const two = await call('/api/preview/start', { lang: 'ja' });
  assert.notEqual(two.json.site, one.json.site);
  for (const u of [one.json.site, ...one.json.pages]) assert.ok(await refused(portOf(u)), `the first preview's ${u} closed`);
  const status = await app.handle(new Request('http://127.0.0.1:1/api/status', { headers: { 'X-Sumika-Admin-Key': 'k' } }), { host: '127.0.0.1:1' });
  assert.deepEqual((await status.json()).preview, two.json);
  assert.deepEqual((await call('/api/preview/stop', {})).json, { ok: true });
  for (const u of [two.json.site, ...two.json.pages]) assert.ok(await refused(portOf(u)), `${u} closed`);
});

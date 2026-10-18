// tools/serve.py's headers (docs/guide.md "Pages on other sites", CLAUDE.md Commands): its Handler run in-process by
// Python on a stand-in connection that carries several requests, as a browser's keep-alive connection does (one Handler
// serves them all), so no socket is opened. `--cache` decides Cache-Control on every response but hub.json's
// (`--hub-allow`: no-store), and a hub.json response must not change the next response's header on the same connection;
// `--cors` adds Access-Control-Allow-Origin to every response. Runs Python (PYTHON names another interpreter).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.PYTHON || 'python';

// argv: serve.py, the site folder, the Handler's options (JSON), the request paths (JSON); prints one JSON line
const DRIVER = String.raw`
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location('sumika_serve', sys.argv[1])
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)
site, opts, paths = sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4])

class Conn:
    def __init__(self, data):
        self.data = data
        self.out = bytearray()
    def makefile(self, mode, *a, **k):
        return io.BytesIO(self.data)
    def sendall(self, b):
        self.out += bytes(b)
    def settimeout(self, t):
        pass
    def setsockopt(self, *a):
        pass

reqs = b''.join(('GET %s HTTP/1.1\r\nHost: localhost\r\n\r\n' % p).encode('ascii') for p in paths)
conn = Conn(reqs)
serve.Handler(conn, ('127.0.0.1', 50000), None, directory=site, **opts)
out, res = bytes(conn.out), []
while out:
    head, _, rest = out.partition(b'\r\n\r\n')
    lines = head.decode('latin-1').split('\r\n')
    headers = {}
    for line in lines[1:]:
        k, _, v = line.partition(':')
        headers.setdefault(k.strip().lower(), []).append(v.strip())
    n = int(headers.get('content-length', ['0'])[0])
    res.append({'status': int(lines[0].split()[1]), 'headers': headers, 'body': rest[:n].decode('utf-8', 'replace')})
    out = rest[n:]
print(json.dumps(res))
`;

/** The responses to `paths`, all on one connection, from serve.py's Handler with these options. */
function serve(site, opts, paths) {
  const r = spawnSync(PY, ['-I', '-B', '-c', DRIVER, path.join(root, 'tools', 'serve.py'), site, JSON.stringify(opts), JSON.stringify(paths)], { encoding: 'utf8' });
  if (r.error) throw new Error(`this test runs Python (${PY}; set PYTHON to another): ${r.error.message}`);
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.length, paths.length, 'one response per request, on one connection');
  return res;
}

function scratchSite() {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-serve-'));
  fs.mkdirSync(path.join(site, 'sumika'));
  fs.writeFileSync(path.join(site, 'a.txt'), 'a');
  fs.writeFileSync(path.join(site, 'sumika', 'build.json'), '{}');
  fs.writeFileSync(path.join(site, 'sumika', 'hub.json'), '{"format": 1, "origins": ["https://from.the.file"]}');
  return site;
}

const header = (res, name) => (res.headers[name] || []).join(', ') || null;

test('serve.py on a keep-alive connection: Cache-Control on every response, no-store for hub.json only (a response after it gets --cache again); CORS on all; hub.json from --hub-allow, not the file', () => {
  const site = scratchSite();
  try {
    const allow = ['http://localhost:8644', 'http://localhost:8645'];
    // an error response closes the connection (Python's send_error), so the 404 goes last
    const paths = ['/a.txt', '/sumika/hub.json', '/a.txt', '/sumika/build.json', '/sumika/hub.json?x=1', '/a.txt', '/missing.txt'];
    const res = serve(site, { cache_control: 'no-cache', cors: true, hub_allow: allow }, paths);
    assert.deepEqual(res.map(r => [r.status, header(r, 'cache-control')]), [
      [200, 'no-cache'], [200, 'no-store'], [200, 'no-cache'], [200, 'no-cache'], [200, 'no-store'], [200, 'no-cache'], [404, 'no-cache'],
    ]);
    for (const r of res) assert.equal(header(r, 'access-control-allow-origin'), '*');
    assert.deepEqual(JSON.parse(res[1].body), { format: 1, origins: allow });
    assert.equal(res[2].body, 'a');

    // --cache none (a plain nginx): no Cache-Control at all, but hub.json's no-store, and none after it
    const none = serve(site, { cache_control: null, cors: false, hub_allow: allow }, ['/sumika/hub.json', '/a.txt', '/sumika/build.json']);
    assert.deepEqual(none.map(r => header(r, 'cache-control')), ['no-store', null, null]);
    assert.ok(none.every(r => header(r, 'access-control-allow-origin') === null), 'no CORS without --cors');

    // without --hub-allow, hub.json is a file like any other
    const plain = serve(site, { cache_control: 'max-age=600' }, ['/sumika/hub.json', '/a.txt']);
    assert.deepEqual(plain.map(r => header(r, 'cache-control')), ['max-age=600', 'max-age=600']);
    assert.deepEqual(JSON.parse(plain[0].body).origins, ['https://from.the.file']);
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});

"""Local test server for the site folder (browsers refuse to fetch files from file:// pages).

usage: python tools/serve.py [--port 8642] [--site SITE_DIR] [--cache no-cache|none|SECONDS] [--cors]
                             [--hub-allow ORIGIN ...]
then open the test page, http://localhost:8642/dev/ (site/dev/index.html; the site has no top page, so / lists it)

Serves .wasm with the right MIME type and sends no-cache headers so edits show up immediately. Listens on IPv4 and
IPv6 with keep-alive: on Windows, 'localhost' tries ::1 first, and an IPv4-only server costs ~2 s per connection.

--cache, for checking the update path locally (safe updates): `no-cache` (the default) as above;
`none` sends no Cache-Control, as a plain nginx or Apache does, so the browser uses heuristic freshness; a number of
seconds sends `max-age=N` (600 as GitHub Pages does).

For pages on other origins that load this server's sumika.js (docs/guide.md "Pages on other sites"):
--cors adds `Access-Control-Allow-Origin: *` to every response, as a publisher's runtime host must send it (no OPTIONS
handler: the runtime sends only plain GETs). --hub-allow ORIGIN (repeatable) answers any `.../sumika/hub.json` with
{"format": 1, "origins": [the flags' origins]} and `Cache-Control: no-store`, whatever file is there: a test allowlist
for the storage hub that never exists as a file, so none is published by accident.
"""
import argparse, functools, http.server, json, os, socket, socketserver, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.json': 'application/json', '.txt': 'text/plain', '.pna': 'image/png',
                      '.pack': 'application/octet-stream'}

    def __init__(self, *args, cache_control='no-cache', cors=False, hub_allow=None, **kwargs):
        # set first: the base class handles the request inside __init__
        self.cache_control = cache_control
        self.cors = cors
        self.hub_allow = hub_allow          # None: hub.json is served as a file like any other
        self._own_cache = False
        super().__init__(*args, **kwargs)

    def end_headers(self):
        if self.cache_control and not self._own_cache:
            self.send_header('Cache-Control', self.cache_control)
        if self.cors:
            self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def _is_hub_json(self):
        if self.hub_allow is None:
            return False
        return urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).endswith('/sumika/hub.json')

    def _send_hub_json(self, head):
        body = (json.dumps({'format': 1, 'origins': self.hub_allow}, indent=1) + '\n').encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self._own_cache = True
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def do_GET(self):
        if self._is_hub_json():
            return self._send_hub_json(False)
        return super().do_GET()

    def do_HEAD(self):
        if self._is_hub_json():
            return self._send_hub_json(True)
        return super().do_HEAD()

    def log_message(self, fmt, *args):
        if getattr(self, '_status', 200) >= 400:
            super().log_message(fmt, *args)

    def send_response(self, code, message=None):
        # every response starts here: one Handler serves every request of a keep-alive connection, so a header choice
        # of an earlier response (hub.json's no-store) must not carry over
        self._status = code
        self._own_cache = False
        super().send_response(code, message)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)  # accept IPv4 too
        except (AttributeError, OSError):
            pass
        super().server_bind()


def cache_control(value):
    """The Cache-Control header for a --cache value (None: send none)."""
    if value == 'no-cache':
        return 'no-cache'
    if value == 'none':
        return None
    if value.isdigit():
        return f'max-age={int(value)}'
    raise argparse.ArgumentTypeError(f'no-cache, none or a number of seconds, not {value!r}')


def origin(value):
    """A --hub-allow value: an http(s) origin (scheme, host, port), lower-cased, without a trailing '/'."""
    u = urllib.parse.urlsplit(value)
    if (u.scheme not in ('http', 'https') or not u.netloc or u.path not in ('', '/') or u.query or u.fragment
            or '@' in u.netloc or '*' in value or '?' in value or '#' in value):
        raise argparse.ArgumentTypeError(f'an origin such as http://localhost:8644, not {value!r}')
    return f'{u.scheme}://{u.netloc.lower()}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8642)
    ap.add_argument('--site', default=os.path.join(HERE, '..', 'site'))
    ap.add_argument('--cache', type=cache_control, default='no-cache',
                    help='no-cache (default), none (no Cache-Control, as plain nginx) or SECONDS (max-age)')
    ap.add_argument('--cors', action='store_true',
                    help='send Access-Control-Allow-Origin: * (pages on other origins load this runtime)')
    ap.add_argument('--hub-allow', type=origin, action='append', metavar='ORIGIN',
                    help='answer sumika/hub.json with these origins (repeatable; no file is written)')
    a = ap.parse_args()
    site = os.path.abspath(a.site)
    handler = functools.partial(Handler, directory=site, cache_control=a.cache, cors=a.cors, hub_allow=a.hub_allow)
    with Server(('::', a.port), handler) as httpd:
        cache = ', no Cache-Control' if a.cache is None else ('' if a.cache == 'no-cache' else f', Cache-Control: {a.cache}')
        cors = ', CORS (Access-Control-Allow-Origin: *)' if a.cors else ''
        hub = f', sumika/hub.json allows {" ".join(a.hub_allow)}' if a.hub_allow else ''
        print(f'serving {site} at http://localhost:{a.port}/{cache}{cors}{hub}', flush=True)
        httpd.serve_forever()


if __name__ == '__main__':
    main()

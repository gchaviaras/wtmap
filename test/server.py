#!/usr/bin/env python3
"""Offline stand-in for the War Thunder map server.

The userscript patches the map page's JavaScript, so testing it needs a page
that behaves like the real one. This serves, on a port of its choosing:

  * test/asset/map_index.html  - the map page, captured from a running game by
                                 test/capture.py. Any copy found there wins, so
                                 the real page code is used when available.
  * test/static/shims/*.js     - stand-ins for the map's third party scripts
                                 (jQuery UI, Hammer, Sylvester, cookies, utils),
                                 used only when no real copy was captured.
  * /map_info.json, /map_obj.json, /mission.json, /state, /indicators,
    /gamechat, /hudmsg, /map.img
                               - payloads from test/asset/ when captured,
                                 otherwise the synthetic set in demo_data.py.

Contacts drift over time so the map is never static, which is what makes the
"follows the player" and off-screen contact behaviour observable.

Extra routes used by the test suite:
  /__hits               request counts per path
  /__reset_hits         clear them
  /__mode?name=planes   serve a fixed set of aircraft for pixel level checks
  /__version            fixture version, used as a readiness probe

Usage: python3 test/server.py [port]      (default 8112)
"""
import json
import math
import os
import struct
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
ASSET = os.path.join(HERE, 'asset')
STATIC = os.path.join(HERE, 'static')
SHIMS = os.path.join(STATIC, 'shims')

sys.path.insert(0, HERE)
import demo_data  # noqa: E402

START = time.time()
HITS = {}
PLANES_MODE = False

# Only the test browser's requests are counted. The fixture listens on a fixed
# port and a real browser tab left open on the same page polls it too, which
# silently inflates every hit count and makes the polling test measure whatever
# else is running on the machine.
COUNT_UA = 'HeadlessChrome'

# Scripts the map page loads; served from asset/ if captured, else from shims/.
VENDOR = [
    'jquery-1.10.1.min.js',
    'sylvester.src.js',
    'hammer.min.js',
    'jquery-ui-1.10.3.interact.min.js',
    'cookies.js',
    'utils.js',
]

MIME = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.ttf': 'application/octet-stream',
    '.png': 'image/png',
    '.img': 'image/png',
}

# Fixed contacts for pixel level icon checks: three aircraft with known
# headings, one off the top edge, the player and a ground unit.
PLANES = [
    demo_data._contact('aircraft', 'Fighter', 0.30, 0.30, demo_data.BLUE, [23, 77, 255], dx=0.0, dy=-1.0),
    demo_data._contact('aircraft', 'Bomber', 0.50, 0.30, demo_data.BLUE, [23, 77, 255], dx=1.0, dy=0.0),
    demo_data._contact('aircraft', 'Assault', 0.70, 0.30, demo_data.RED, [250, 12, 0], dx=0.7071, dy=0.7071),
    demo_data._contact('aircraft', 'Fighter', 0.30, -0.60, demo_data.RED, [250, 12, 0], dx=0.0, dy=1.0),
    demo_data._contact('ground_model', 'Player', 0.50, 0.50, demo_data.GOLD, [250, 200, 30], dx=0.0, dy=-1.0),
    demo_data._contact('ground_model', 'MediumTank', 0.55, 0.55, demo_data.BLUE, [23, 77, 255]),
]


def payload(name, fallback):
    """Captured JSON when present, otherwise the synthetic set."""
    path = os.path.join(ASSET, name + '.json')
    if os.path.isfile(path):
        try:
            with open(path, encoding='utf-8') as f:
                return json.load(f)
        except ValueError:
            pass
    return fallback


MAP_INFO = payload('map_info', demo_data.MAP_INFO)
MISSION = payload('mission', demo_data.MISSION)
INDICATORS = payload('indicators', demo_data.INDICATORS)
STATE = payload('state', demo_data.STATE)
CHAT = payload('gamechat', demo_data.CHAT)
HITS_ME = payload('hudmsg', {'events': demo_data.EVENTS, 'damage': demo_data.DAMAGE})
BASE_OBJECTS = payload('map_obj', demo_data.MAP_OBJ)


def contacts():
    """Objects to serve, with aircraft and the player drifting over time."""
    t = time.time() - START
    source = PLANES if PLANES_MODE else BASE_OBJECTS
    out = []
    for o in source:
        o = dict(o)
        if o.get('type') == 'aircraft' or o.get('icon') == 'Player':
            heading = math.atan2(o['dy'], o['dx'])
            speed = 0.0 if PLANES_MODE else 0.012
            x = o['x'] + speed * t * math.cos(heading + math.pi / 2)
            y = o['y'] + speed * t * math.sin(heading + math.pi / 2)
            o['x'] = min(max(x, -0.6), 1.6)
            o['y'] = min(max(y, -0.6), 1.6)
            if not PLANES_MODE:
                turned = heading + t * 0.25
                o['dx'] = math.cos(turned)
                o['dy'] = math.sin(turned)
        out.append(o)
    return out


def make_png(path, size=1024):
    """A plausible looking terrain image, written without any image library."""
    def noise(x, y, freq):
        n = (x * freq) ^ (y * freq * 7) ^ (freq * 131)
        n = (n * 1103515245 + 12345) & 0x7fffffff
        return (n >> 8) % 255 / 255.0

    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            u, v = px / size, py / size
            n = (noise(px, py, 1) * 0.5 + noise(px, py, 2) * 0.3 +
                 noise(px, py, 4) * 0.2)
            if math.sin(u * 5.0) * math.cos(v * 4.0) > 0.72:
                row += bytes((30, 60, 110))          # water
            elif n > 0.62:
                row += bytes((86, 96, 70))           # woods
            elif n > 0.42:
                row += bytes((120, 124, 96))         # fields
            else:
                row += bytes((146, 136, 112))        # open ground
        rows.append(bytes(row))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(b''.join(rows), 6))
    png += chunk(b'IEND', b'')

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)


MAP_IMG = os.path.join(ASSET, 'map.img')
if not os.path.isfile(MAP_IMG):
    make_png(MAP_IMG)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _send(self, body, ctype='application/json', code=200):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj):
        self._send(json.dumps(obj))

    def _file(self, path, ctype=None):
        ext = os.path.splitext(path)[1]
        with open(path, 'rb') as f:
            self._send(f.read(), ctype or MIME.get(ext, 'application/octet-stream'))

    def do_GET(self):
        global PLANES_MODE
        url = urlparse(self.path)
        path = url.path
        query = parse_qs(url.query)

        if COUNT_UA in self.headers.get('User-Agent', ''):
            HITS[path] = HITS.get(path, 0) + 1

        # --- fixture control -------------------------------------------
        if path == '/__version':
            return self._send('wtmap-fixture 1\n', 'text/plain')
        if path == '/__hits':
            return self._json(HITS)
        if path == '/__reset_hits':
            HITS.clear()
            return self._json({})
        if path == '/__mode':
            PLANES_MODE = query.get('name', ['full'])[0] == 'planes'
            return self._json({'mode': 'planes' if PLANES_MODE else 'full'})

        # --- map endpoints ---------------------------------------------
        if path == '/map_obj.json':
            return self._json(contacts())
        if path == '/map_info.json':
            return self._json(MAP_INFO)
        if path == '/mission.json':
            return self._json(MISSION)
        if path == '/indicators':
            return self._json(INDICATORS)
        if path == '/state':
            return self._json(STATE)
        if path == '/gamechat':
            last = int(query.get('lastId', ['0'])[0])
            return self._json([m for m in CHAT if m.get('id', 0) > last])
        if path == '/hudmsg':
            last_e = int(query.get('lastEvt', ['0'])[0])
            last_d = int(query.get('lastDmg', ['0'])[0])
            return self._json({
                'events': [m for m in HITS_ME.get('events', []) if m.get('id', 0) > last_e],
                'damage': [m for m in HITS_ME.get('damage', []) if m.get('id', 0) > last_d],
            })
        if path == '/map.img':
            return self._file(MAP_IMG)

        # --- page ------------------------------------------------------
        if path in ('/', '/index.html'):
            index = os.path.join(ASSET, 'map_index.html')
            if not os.path.isfile(index):
                return self._send(
                    'test/asset/map_index.html is missing.\n'
                    'Run "npm run capture" with the game running, or copy the map\n'
                    'page (http://localhost:8111/) to that path.\n',
                    'text/plain', 500)
            return self._file(index)

        # Static text files of my own: localisation and an empty stylesheet the
        # map page links to.
        for root in (STATIC,):
            target = os.path.join(root, path.lstrip('/'))
            if os.path.isfile(target):
                return self._file(target)

        # Everything else: captured page assets, else a shim.
        name = path.lstrip('/')
        for candidate in (os.path.join(ASSET, name), os.path.join(SHIMS, name)):
            if os.path.isfile(candidate):
                return self._file(candidate)

        self._send('not found: ' + path + '\n', 'text/plain', 404)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8112
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    print('wtmap fixture map server on http://127.0.0.1:%d/' % port, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
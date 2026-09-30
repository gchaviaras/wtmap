#!/usr/bin/env python3
"""Capture the map page and its data off a running War Thunder game.

Everything captured lands in test/asset/ and is git ignored: the map page, the
map's icons font, its third party scripts and a snapshot of each JSON endpoint.
test/server.py prefers those files, so the fixture then runs the genuine page
code instead of the stand-ins in test/static/shims/.

Needs the game running (its map server listens on :8111). With no arguments it
uses http://localhost:8111/.

Usage: python3 test/capture.py [--url http://localhost:8111/]
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ASSET = os.path.join(HERE, 'asset')

PAGE_FILES = [
    ('/', 'map_index.html'),
    ('/icons.ttf', 'icons.ttf'),
    ('/jquery-1.10.1.min.js', 'jquery-1.10.1.min.js'),
    ('/sylvester.src.js', 'sylvester.src.js'),
    ('/hammer.min.js', 'hammer.min.js'),
    ('/jquery-ui-1.10.3.interact.min.js', 'jquery-ui-1.10.3.interact.min.js'),
    ('/cookies.js', 'cookies.js'),
    ('/utils.js', 'utils.js'),
]

ENDPOINTS = [
    ('/map_info.json', 'map_info.json'),
    ('/map_obj.json', 'map_obj.json'),
    ('/mission.json', 'mission.json'),
    ('/indicators', 'indicators.json'),
    ('/state', 'state.json'),
    ('/gamechat?lastId=0', 'gamechat.json'),
    ('/hudmsg?lastEvt=0&lastDmg=0', 'hudmsg.json'),
]


def fetch(base, path):
    with urllib.request.urlopen(base.rstrip('/') + path, timeout=5) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://localhost:8111/',
                        help='map server to capture from (default %(default)s)')
    args = parser.parse_args()

    os.makedirs(ASSET, exist_ok=True)

    try:
        fetch(args.url, '/__version')
    except urllib.error.URLError:
        pass
    try:
        fetch(args.url, '/')
    except (urllib.error.URLError, OSError) as error:
        sys.exit('cannot reach %s (%s). Is War Thunder running?' % (args.url, error))

    for path, name in PAGE_FILES:
        try:
            data = fetch(args.url, path)
        except (urllib.error.URLError, OSError) as error:
            print('  skip %-32s %s' % (path, error))
            continue
        with open(os.path.join(ASSET, name), 'wb') as f:
            f.write(data)
        print('  %-34s -> %s (%d bytes)' % (path, name, len(data)))

    for path, name in ENDPOINTS:
        try:
            data = fetch(args.url, path)
            json.loads(data.decode('utf-8'))
        except (urllib.error.URLError, OSError, ValueError) as error:
            print('  skip %-34s %s' % (path, error))
            continue
        with open(os.path.join(ASSET, name), 'wb') as f:
            f.write(data)
        print('  %-34s -> %s (%d bytes)' % (path, name, len(data)))

    print('\ncaptured into %s' % ASSET)


if __name__ == '__main__':
    main()
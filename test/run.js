#!/usr/bin/env node
'use strict';

/*
 * End to end tests for wtmap.user.js.
 *
 * Starts the fixture map server (test/server.py), injects the userscript into
 * the map page the same way a userscript manager does at @run-at document-start
 * (Page.addScriptToEvaluateOnNewDocument), then drives the page and checks the
 * canvas pixels and the DOM.
 *
 *   node test/run.js                 headless, fixture only
 *   node test/run.js --keep          leave the server running afterwards
 *   node test/run.js --url URL       test a real game instead of the fixture
 *   node test/run.js --headed        watch it
 *
 * Screenshots land in test/output/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {spawn, spawnSync} = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'output');
const SCRIPT = path.join(ROOT, 'wtmap.user.js');

const argv = process.argv.slice(2);
const hasFlag = name => argv.includes(name);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const HEADED = hasFlag('--headed');
const KEEP = hasFlag('--keep');
const EXTERNAL_URL = argValue('--url', null);
const PORT = parseInt(argValue('--port', process.env.WTMAP_TEST_PORT || '8112'), 10);
const FIXTURE_URL = 'http://127.0.0.1:' + PORT + '/';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* browser discovery                                                    */
/* ------------------------------------------------------------------ */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROME,
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const which = spawnSync('sh', ['-c',
    'command -v chromium chromium-browser google-chrome google-chrome-stable 2>/dev/null | head -1'],
    {encoding: 'utf-8'}).stdout.trim();
  if (which) {
    return which;
  }
  fail('No Chrome or Chromium found. Set CHROME_PATH to the browser binary.');
}

function fail(message) {
  console.error('\n' + message + '\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* fixture server                                                       */
/* ------------------------------------------------------------------ */

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      http.get(url + '__version', res => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('fixture server did not come up: ' + url));
        } else {
          setTimeout(attempt, 150);
        }
      });
    })();
  });
}

let server = null;
let serverOurs = false;

async function serverIsUp(url, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 1000);
  while (Date.now() < deadline) {
    const up = await new Promise(resolve => {
      http.get(url + '__version', res => {
        res.resume();
        resolve(true);
      }).on('error', () => resolve(false));
    });
    if (up) {
      return true;
    }
    await sleep(150);
  }
  return false;
}

async function startServer() {
  if (await serverIsUp(FIXTURE_URL, 500)) {
    console.log('reusing the fixture already listening on port ' + PORT);
    return;
  }
  server = spawn('python3', [path.join(__dirname, 'server.py'), String(PORT)],
    {stdio: ['ignore', 'pipe', 'inherit']});
  serverOurs = true;
  server.stdout.on('data', d => process.stdout.write('  [fixture] ' + d));
  try {
    await waitForServer(FIXTURE_URL, 20000);
  } catch (error) {
    fail(error.message + '\nPort ' + PORT + ' may be taken; pass --port to use another.');
  }
}

function stopServer() {
  if (server && serverOurs && !KEEP) {
    server.kill();
  }
  server = null;
}

/* ------------------------------------------------------------------ */
/* tiny assertion helpers                                               */
/* ------------------------------------------------------------------ */

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({name, ok: true});
    console.log('  \x1b[32mPASS\x1b[0m  ' + name);
  } catch (error) {
    results.push({name, ok: false, msg: error.message});
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name + '\n        ' + error.message);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ': got ' + JSON.stringify(actual) +
      ', want ' + JSON.stringify(expected));
  }
}

function near(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(message + ': got ' + actual + ', want ' + expected +
      ' +-' + tolerance);
  }
}

async function setMode(mode) {
  if (EXTERNAL_URL) {
    return;   // a real game has no fixture control endpoints
  }
  const response = await fetch(FIXTURE_URL + '__mode?name=' + mode);
  await response.json();
}

/* ------------------------------------------------------------------ */
/* expectations derived from whatever the server actually serves       */
/*                                                                     */
/* So the suite checks the same thing whether it runs against the       */
/* synthetic payloads or ones captured from a live game.                */
/* ------------------------------------------------------------------ */

async function getJson(base, path) {
  return (await fetch(base + path)).json();
}

// Aircraft are drawn as vector artwork, everything else as a glyph from the
// map's own icon font.
const PLANES = ['Fighter', 'Bomber', 'Assault'];
const MAP_GLYPHS = {
  Airdefence: '4', Structure: '5', waypoint: '6', capture_zone: '7',
  bombing_point: '8', defending_point: '9',
};

function glyphOf(icon) {
  return MAP_GLYPHS[icon] || icon.charAt(0);
}

function isCounted(o) {
  return o.icon && o.icon !== 'none' && o.icon !== 'Player' &&
    !o.icon.startsWith('respawn_base');
}

function isRed(o) {
  const c = o['color[]'];
  return c[0] > c[2] + 32;   // mirrors the userscript's red/green/blue rule
}

function expectedSummary(objects) {
  const out = {};
  for (const o of objects) {
    if (!isCounted(o)) {
      continue;
    }
    out[o.icon] = out[o.icon] || {blue: 0, red: 0};
    out[o.icon][isRed(o) ? 'red' : 'blue']++;
  }
  return out;
}

function expectedCaption(info) {
  // Maps are not always at the origin: this one spans 1024..3072, so the width
  // is the difference, not map_max[0].
  const units = (info.map_max[0] - info.map_min[0]) * 10;   // 10 m per map unit
  const grid = info.grid_steps[0] * 10;
  return Math.round(units / 1000) + '×' + Math.round(units / 1000) + ' km' +
    (grid / 1000).toFixed(2) + ' km1.00';
}

async function readSummary(page) {
  return page.evaluate(() => {
    function row(id) {
      const out = {};
      const cells = document.querySelectorAll('#' + id + ' > *');
      for (let i = 0; i < cells.length; i += 2) {
        const svg = cells[i].querySelector('svg path');
        out[cells[i].title] = {
          glyph: cells[i].textContent,
          path: svg ? svg.getAttribute('d') : null,
          count: cells[i + 1].textContent,
          font: getComputedStyle(cells[i]).fontFamily.split(',')[0].replace(/["']/g, ''),
        };
      }
      return out;
    }
    return {blue: row('wtm-bluerow'), red: row('wtm-redrow')};
  });
}

function compareSummary(want, got, team) {
  const icons = Object.keys(want);
  eq(Object.keys(got).sort().join(','), icons.sort().join(','),
    team + ' row icons');
  for (const icon of icons) {
    const cell = got[icon];
    const count = want[icon][team];
    // A team with none of this kind gets a blank cell, as in the original.
    eq(cell.count, count ? String(count) : '', team + ' ' + icon + ' count');
    if (PLANES.includes(icon)) {
      assert(count ? cell.path : !cell.path,
        team + ' ' + icon + ' artwork should be ' + (count ? 'present' : 'absent'));
      continue;
    }
    eq(cell.glyph, count ? glyphOf(icon) : '', team + ' ' + icon + ' glyph');
    eq(cell.font, 'Icons', team + ' ' + icon + ' glyph font');
  }
}

/* ------------------------------------------------------------------ */
/* the suite                                                            */
/* ------------------------------------------------------------------ */

(async () => {
  if (!fs.existsSync(SCRIPT)) {
    fail('missing ' + SCRIPT);
  }

  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    fail('puppeteer-core is not installed. Run: npm install');
  }

  fs.mkdirSync(OUT, {recursive: true});

  const url = EXTERNAL_URL || FIXTURE_URL;
  if (!EXTERNAL_URL) {
    console.log('starting fixture map server');
    await startServer();

    // The fixture serves the game's own map page, which we do not ship. Without
    // it there is nothing for the userscript to patch, so say so up front
    // instead of reporting twenty confusing failures.
    const page = await (await fetch(url)).text();
    if (!page.includes('id="map-canvas"')) {
      stopServer();
      fail('The fixture has no map page.\n' +
        'Run "npm run capture" while War Thunder is up, or point the tests at a\n' +
        'running game with: node test/run.js --url http://localhost:8111/');
    }
  }
  console.log('testing ' + url + '\n');

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: !HEADED,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    defaultViewport: {width: 1500, height: 950},
  });

  const pageErrors = [];

  // Each phase gets its own browser context: fresh localStorage, so settings and
  // the stored zoom level cannot leak between phases, and exactly one copy of
  // the userscript per document.
  async function open(context) {
    const ctx = context || (await browser.createBrowserContext());
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));
    // What a userscript manager does for @run-at document-start.
    await page.evaluateOnNewDocument(fs.readFileSync(SCRIPT, 'utf8'));
    await page.goto(url, {waitUntil: 'load'});
    await sleep(2200);
    page.testContext = ctx;
    return page;
  }

  const shot = (page, name) =>
    page.screenshot({path: path.join(OUT, name + '.png')});

  try {
    await setMode('full');
    let page = await open();

    /* --- layout --------------------------------------------------- */

    await test('canvas is moved into the map panel', async () => {
      eq(await page.evaluate(() => document.getElementById('map-canvas').parentElement.id),
        'wtm-map', 'canvas parent');
    });

    await test('the map\'s own panels are hidden', async () => {
      const hidden = await page.evaluate(() =>
        ['map-root', 'indicators-root', 'state-root'].map(id =>
          getComputedStyle(document.getElementById(id)).display));
      assert(hidden.every(d => d === 'none'), 'still visible: ' + hidden.join(', '));
    });

    await test('side panels are laid out', async () => {
      const panels = await page.evaluate(() =>
        [...document.querySelectorAll('#wtm-sidepanels > *')].map(e => e.id));
      eq(panels.join(','),
        'wtm-state-root,wtm-indicators-root,mission-objectives,' +
        'game-chat-root,hud-evt-msg-root,hud-dmg-msg-root',
        'side panels');
    });

    await test('map and game fonts are available to canvas', async () => {
      const fonts = await page.evaluate(() => ({
        plane: document.fonts.check('20px plane_icons'),
        icons: document.fonts.check('20px Icons'),
      }));
      assert(fonts.plane && fonts.icons, JSON.stringify(fonts));
    });

    await test('the map takes the available space', async () => {
      const size = await page.evaluate(() => {
        const c = document.getElementById('map-canvas');
        const summary = document.getElementById('wtm-mapsummary');
        return {
          w: c.width, h: c.height,
          vw: document.documentElement.clientWidth,
          vh: document.documentElement.clientHeight,
          summary: Math.round(summary.getBoundingClientRect().height),
        };
      });
      eq(size.w, size.h, 'canvas is not square');
      // 34 is the caption plus the body margin, and the summary is measured
      // because its height depends on how many contact kinds are on the map.
      eq(size.w, Math.max(Math.min(size.vh - 34 - size.summary,
        size.vw - 310 - 30), 350), 'canvas size');
    });

    await test('the summary is on screen, not below the window', async () => {
      const boxes = await page.evaluate(() => {
        function box(sel) {
          const r = document.querySelector(sel).getBoundingClientRect();
          return {top: Math.round(r.top), bottom: Math.round(r.bottom),
            left: Math.round(r.left), right: Math.round(r.right),
            height: Math.round(r.height), width: Math.round(r.width)};
        }
        return {summary: box('#wtm-mapsummary'),
          viewport: document.documentElement.clientHeight,
          width: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollHeight};
      });
      eq(boxes.scroll, boxes.viewport, 'the page should not need scrolling');
      assert(boxes.summary.bottom <= boxes.viewport,
        'the summary runs off the bottom: ' + boxes.summary.bottom +
        ' in a ' + boxes.viewport + 'px window');
      assert(boxes.summary.right <= boxes.width,
        'the summary runs off the right: ' + boxes.summary.right);
    });

    /* --- full window and fullscreen modes --------------------------- */

    // Headless Chrome cannot really go fullscreen, so report a fullscreen
    // element ourselves and let the script react to the event as it would in
    // a real browser.
    const set_fullscreen = async (on, panels) => page.evaluate((on, panels) => {
      if (panels !== null) {
        window.wtmap.settings.fullscreen_panels = panels;
      }
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => on ? document.documentElement : null,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
    }, on, panels === undefined ? null : panels);

    const set_full_window = on => page.evaluate(on => {
      window.wtmap.settings.full_window = on ? 1 : 0;
      localStorage.setItem('wtmap_full_window', on ? 1 : 0);
      window.wtmap.layout();
    }, on);

    const layout = () => page.evaluate(() => {
      const c = document.getElementById('map-canvas');
      const side = document.getElementById('wtm-sidepanels');
      return {
        mode: window.wtmap.mode(),
        bodyClass: document.body.className,
        w: c.width,
        h: c.height,
        vw: document.documentElement.clientWidth,
        vh: document.documentElement.clientHeight,
        canvasLeft: Math.round(c.getBoundingClientRect().left),
        canvasTop: Math.round(c.getBoundingClientRect().top),
        sideDisplay: getComputedStyle(side).display,
        sidePosition: getComputedStyle(side).position,
        captionBottom: Math.round(document
          .querySelector('#wtm-map-root .wtm-caption').getBoundingClientRect().bottom),
        captionHeight: Math.round(document
          .querySelector('#wtm-map-root .wtm-caption').getBoundingClientRect().height),
        captionVisible: document.querySelector('#wtm-map-root .wtm-caption')
          .getBoundingClientRect().width > 0,
      };
    });

    // The map image is square and the game stretches it into the canvas, so the
    // canvas has to stay square in every mode or the map is distorted. That
    // leaves two ways to fill a window that is not square: a square as big as
    // the short side, with the spare width left as page background, or a square
    // as big as the long side with the window cropping the overflow.
    const set_fill = fill => page.evaluate(fill => {
      window.wtmap.settings.full_window_fill = fill;
      localStorage.setItem('wtmap_full_window_fill', fill);
      window.wtmap.layout();
    }, fill);

    // Pans the map to each end of its travel on both axes and samples the four
    // corners of the band the window actually shows, which in cover mode is a
    // crop of a larger canvas. A transparent corner means the map has been
    // panned off its own edge, which is the one way this can go wrong: the
    // spare width is only safe to spend as far as the crop leaves room.
    const pan_to_the_corners = () => page.evaluate(() => {
      const c = document.getElementById('map-canvas');
      const ctx = c.getContext('2d', {willReadFrequently: true});
      const view_w = document.documentElement.clientWidth;
      const view_h = document.documentElement.clientHeight;
      const caption = document.querySelector('#wtm-map-root .wtm-caption')
        .getBoundingClientRect().height;
      const x0 = Math.round((c.width - view_w) / 2) + 2;
      const x1 = Math.round((c.width + view_w) / 2) - 3;
      const y1 = Math.round(view_h - caption) - 3;

      const corners = () => {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const alpha = (x, y) => d[(y * c.width + x) * 4 + 3];
        return [alpha(x0, 2), alpha(x1, 2), alpha(x0, y1), alpha(x1, y1)];
      };

      const report = {slack: [c.width - view_w, c.height - (view_h - caption)],
                      stops: []};
      for (let axis = 0; axis < 2; axis++) {
        for (const wanted of [-100000, 100000]) {
          window.map_pan[axis] = wanted;
          window.clampMapPan();
          window.redraw_map(0.0);
          report.stops.push({axis, pan: Math.round(window.map_pan[axis]),
                             corners: corners()});
        }
        window.map_pan[axis] = 0;
        window.clampMapPan();
      }
      window.redraw_map(0.0);
      return report;
    });

    await test('full window mode fills the window without distorting the map', async () => {
      await set_fill('cover');
      await page.evaluate(() => window.wtmap.full_window());
      await sleep(300);
      const on = await layout();
      eq(on.mode, 'window', 'layout mode');
      eq(on.w, on.h, 'the canvas must stay square, the map image is');
      // Big enough to cover the window, which is what removes the bars.
      assert(on.w >= on.vw, 'the canvas should span the window width: ' +
        on.w + ' in ' + on.vw);
      assert(on.w >= on.vh - on.captionHeight,
        'the canvas should span the window height below the caption: ' + on.w +
        ' for ' + (on.vh - on.captionHeight));
      assert(on.canvasLeft <= 1 && on.canvasLeft + on.w >= on.vw - 1,
        'the map should reach both edges, no bars: left ' + on.canvasLeft);
      assert(on.canvasTop >= on.captionBottom - 1,
        'the canvas should start under the caption, not over it');
      eq(on.sideDisplay, 'none', 'panels should be hidden');
      assert(on.bodyClass.includes('wtm-mode-window'), 'body class: ' + on.bodyClass);
      assert(on.captionVisible, 'the caption must stay reachable to leave the mode');

      // The spare width and height are what the map has to be able to travel,
      // and it can do that at zoom 1 only because the pan clamp was widened.
      // Dragging to either end must never expose an empty edge.
      const travel = await pan_to_the_corners();
      assert(travel.slack[0] + travel.slack[1] > 20,
        'a window this shape should leave something to pan: ' + travel.slack);
      for (const stop of travel.stops) {
        stop.corners.forEach((a, i) =>
          assert(a === 255, 'the map runs off its own edge at corner ' + i +
            ' (axis ' + stop.axis + ', pan ' + stop.pan + '): alpha ' + a));
      }

      // Panning only sticks if it survives a redraw, and with "centre map on
      // player" on it would not: the follow re-centres every frame. So the first
      // drag turns the follow off, which the option has to show.
      const drag = await page.evaluate(() => {
        const out = {};
        out.followBefore = window.wtmap.settings.map_center;
        window.isDraggingMap = true;                 // what the game sets on dragstart
        window.map_pan[1] = -400;
        window.redraw_map(0.0);
        window.isDraggingMap = false;
        window.redraw_map(0.0);                      // the frame after the drag
        out.followAfter = window.wtmap.settings.map_center;
        out.stored = localStorage.getItem('wtmap_map_center');
        out.panHeld = Math.round(window.map_pan[1]);
        return out;
      });
      eq(drag.followBefore, 1, 'the map should start out following the player');
      eq(drag.followAfter, 0, 'a drag should turn the follow off in cover mode');
      eq(drag.stored, '0', 'and it should be remembered');
      near(drag.panHeld, -400, 2, 'the pan should survive the frame after a drag');
      assert(drag.panHeld < -10,
        'the map should be pannable at zoom 1, the crop slack is unusable');

      // It has to follow the window when it is resized or maximised, in either
      // orientation, staying square and still covering both edges.
      for (const [w, h] of [[1280, 720], [720, 1280], [1500, 950]]) {
        await page.setViewport({width: w, height: h});
        await sleep(300);
        const r = await layout();
        eq(r.w, r.h, `the canvas must stay square at ${w}x${h}`);
        assert(r.canvasLeft <= 1 && r.canvasLeft + r.w >= w - 1,
          `the map should reach both edges at ${w}x${h}`);
        const seen = await pan_to_the_corners();
        seen.stops.forEach(stop => stop.corners.forEach((a, i) =>
          assert(a === 255, `empty corner ${i} at ${w}x${h}, axis ${stop.axis}`)));
      }
      assert(on.captionVisible, 'the caption must stay reachable after resizing');
    });

    await test('full window mode can leave the window free instead', async () => {
      await set_fill('bars');
      await sleep(300);
      const on = await layout();
      eq(on.mode, 'window', 'layout mode');
      eq(on.w, on.h, 'the canvas must stay square');
      near(on.w, Math.min(on.vw, on.vh), 2, 'the map should fill the short side');
      const gap_left = on.canvasLeft;
      const gap_right = on.vw - on.canvasLeft - on.w;
      near(gap_left, gap_right, 2, 'the map should be centred horizontally');
      await set_fill('cover');
    });

    await test('the follow option shows when a drag has turned it off', async () => {
      await page.evaluate(() => {
        window.wtmap.settings.map_center = 1;
        window.wtmap.settings.full_window_fill = 'cover';
        window.wtmap.settings.full_window = 1;
        window.wtmap.layout();
      });
      await page.click('.wtm-gear');
      await sleep(200);
      const before = await page.evaluate(() =>
        document.getElementById('opt_map_center').checked);
      assert(before, 'the option should start checked');

      const after = await page.evaluate(() => {
        window.isDraggingMap = true;
        window.redraw_map(0.0);
        window.isDraggingMap = false;
        window.redraw_map(0.0);
        return {checked: document.getElementById('opt_map_center').checked,
                follow: window.wtmap.settings.map_center};
      });
      eq(after.follow, 0, 'the drag should have released the follow');
      eq(after.checked, false, 'the option should no longer claim to follow');

      // Put the follow back for the tests that come after.
      await page.evaluate(() => {
        window.wtmap.settings.map_center = 1;
        localStorage.setItem('wtmap_map_center', 1);
        document.getElementById('opt_map_center').checked = true;
        document.getElementById('wtm-close').click();
      });
      await sleep(150);
    });

    // The same square-canvas rule has to hold in the fullscreen panel modes.
    await test('every layout mode keeps the map square', async () => {
      await set_full_window(false);
      for (const panels of ['column', 'overlay', 'hidden']) {
        await page.evaluate(panels => {
          window.wtmap.settings.fullscreen_panels = panels;
          window.wtmap.layout();
        }, panels);
        await sleep(150);
        const r = await layout();
        eq(r.w, r.h, panels + ': the canvas must stay square');
      }
      // And in a window shaped nothing like a square.
      await page.setViewport({width: 1400, height: 620});
      await sleep(300);
      for (const panels of ['column', 'overlay', 'hidden', 'window']) {
        if (panels === 'window') {
          await set_full_window(true);
        }
        const r = await layout();
        eq(r.w, r.h, panels + ': the canvas must stay square at 1400x620');
      }
      await page.setViewport({width: 1500, height: 950});
      await sleep(200);
    });

    await test('full window mode is left with M or Escape', async () => {
      // The previous test left it on, so start from a known state.
      await set_full_window(false);
      await set_full_window(true);
      eq((await layout()).mode, 'window', 'entered');

      await page.keyboard.press('KeyM');
      await sleep(200);
      eq((await layout()).mode, 'column', 'M should leave full window mode');

      await set_full_window(true);
      await page.keyboard.press('Escape');
      await sleep(200);
      eq((await layout()).mode, 'column', 'Escape should leave full window mode');
      eq(await page.evaluate(() => localStorage.getItem('wtmap_full_window')),
        '0', 'full window should be remembered as off');
    });

    await test('fullscreen keeps the panels in a column when asked', async () => {
      await set_fullscreen(true, 'column');
      await sleep(300);
      const on = await layout();
      eq(on.mode, 'column', 'layout mode');
      eq(on.sideDisplay !== 'none', true, 'panels should be visible');
      eq(on.bodyClass.includes('wtm-mode-column'), true, 'body class: ' + on.bodyClass);
      assert(on.w < on.vw, 'the map should leave room for the column');
    });

    await test('fullscreen can float the panels over the map', async () => {
      await set_fullscreen(true, 'overlay');
      await sleep(300);
      const on = await layout();
      eq(on.mode, 'overlay', 'layout mode');
      eq(on.sidePosition, 'fixed', 'panels should be fixed on top');
      eq(on.sideDisplay !== 'none', true, 'panels should be visible');
      // The map grows to the largest square the window allows and is centred.
      eq(on.w, on.h, 'the map should stay square');
      eq(on.w, Math.max(Math.min(on.vh - 34, on.vw - 30), 350), 'map size');
      assert(on.w > 600, 'the map should be bigger than in the column layout: ' + on.w);
      near(on.canvasLeft, (on.vw - on.w) / 2, 2, 'map should be centred');
    });

    await test('fullscreen can hide the panels entirely', async () => {
      await set_fullscreen(true, 'hidden');
      await sleep(300);
      const on = await layout();
      eq(on.mode, 'hidden', 'layout mode');
      eq(on.sideDisplay, 'none', 'panels should be hidden');
      eq(on.w, on.h, 'the map should stay square');
      eq(on.w, Math.max(Math.min(on.vh - 34, on.vw - 30), 350), 'map size');
      near(on.canvasLeft, (on.vw - on.w) / 2, 2, 'map should be centred: ' + on.canvasLeft);
    });

    await test('leaving fullscreen restores the column layout', async () => {
      await set_fullscreen(false);
      await sleep(300);
      const off = await layout();
      eq(off.mode, 'column', 'layout mode');
      assert(off.w < off.vw, 'the map should go back beside the column');
      eq(off.bodyClass.includes('wtm-mode-column'), true, 'body class: ' + off.bodyClass);
    });

    await test('caption reports map size, grid and scale', async () => {
      const info = await getJson(url, 'map_info.json');
      const caption = await page.evaluate(() =>
        document.getElementById('wtm-mapinfo').textContent.replace(/\s+/g, ' ').trim());
      eq(caption, expectedCaption(info), 'caption');
    });

    /* --- polling takeover ------------------------------------------ */

    if (!EXTERNAL_URL) {
      await test('the map\'s own polling is replaced by ours', async () => {
        await fetch(FIXTURE_URL + '__reset_hits');
        await sleep(3000);
        const hits = await (await fetch(FIXTURE_URL + '__hits')).json();
        const objects = hits['/map_obj.json'] || 0;
        // 50 ms object polling, 500 ms objectives, 5 s map info, and nothing at
        // all for the panels that are off by default.
        assert(objects >= 40 && objects <= 70,
          objects + ' /map_obj.json requests in 3 s, expected ~60');
        assert((hits['/mission.json'] || 0) >= 5, 'objectives not polled');
        assert((hits['/map_info.json'] || 0) <= 2, 'map info polled too often');
        ['/state', '/indicators', '/gamechat', '/hudmsg'].forEach(ep => {
          assert(!hits[ep], ep + ' polled while its panel is off');
        });
      });
    }

    /* --- summary and title ----------------------------------------- */

    await test('summary counts every contact on the right team row', async () => {
      const want = expectedSummary(await getJson(url, 'map_obj.json'));
      const got = await readSummary(page);
      compareSummary(want, got.blue, 'blue');
      compareSummary(want, got.red, 'red');
    });

    await test('the three aircraft silhouettes are distinct', async () => {
      const paths = await page.evaluate(() => {
        const out = {};
        ['Fighter', 'Bomber', 'Assault'].forEach(icon => {
          const cell = [...document.querySelectorAll('#wtm-mapsummary th')]
            .find(th => th.title === icon);
          const path = cell && cell.querySelector('svg path');
          out[icon] = path ? path.getAttribute('d') : null;
        });
        return out;
      });
      for (const [icon, path] of Object.entries(paths)) {
        assert(path, 'no artwork for ' + icon);
      }
      eq(new Set(Object.values(paths)).size, 3, 'the silhouettes are not all different');
    });

    // The canvas mirrors the shapes with a scale, the SVG with a transform.
    // Two faults have shown up in this artwork: only one half was emitted, so
    // the summary drew a fuselage with a single wing, and an attribute was left
    // unclosed, which made the parser swallow the paths that followed it and
    // left one half of the plane solid black. Both are checked against the
    // parsed DOM rather than the markup string, because only the DOM shows what
    // the browser actually drew. A count of matches in the string cannot: three
    // mangled paths still satisfy "one body plus its mirror plus one detail".
    await test('aircraft artwork is drawn on both sides', async () => {
      const shapes = await page.evaluate(() => {
        const mirrored = el => /scale\(-1,1\)/.test(el.getAttribute('transform') || '');
        const shadowed = el => /fill:#000/.test(el.getAttribute('style') || '');
        const out = {bodies: {}, malformed: []};

        // every svg on the page: the summary cells and the dialog preview alike
        document.querySelectorAll('svg').forEach(svg => {
          [...svg.querySelectorAll('*')].forEach(el => {
            [...el.attributes].forEach(attr => {
              if (/[<>]/.test(attr.value)) {
                out.malformed.push(el.tagName + '@' + attr.name + ' = ' +
                  attr.value.slice(0, 50));
              }
            });
          });
        });

        ['Fighter', 'Bomber', 'Assault'].forEach(icon => {
          const cell = [...document.querySelectorAll('#wtm-mapsummary th')]
            .find(th => th.title === icon);
          if (!cell) {
            return;
          }
          const paths = [...cell.querySelectorAll('svg path')];
          const bodies = {};
          let shadows = 0;
          paths.forEach(p => {
            if (shadowed(p)) {
              shadows += 1;
              return;
            }
            if (p.classList.contains('wtm-detail')) {
              return;
            }
            const d = p.getAttribute('d');
            const rec = bodies[d] || (bodies[d] = {plain: 0, mirrored: 0});
            rec[mirrored(p) ? 'mirrored' : 'plain'] += 1;
          });
          out.bodies[icon] = {
            bodies: Object.keys(bodies).length,
            // a body with a mate on only one side is a plane with one wing
            unmatched: Object.values(bodies).filter(r =>
              r.plain !== 1 || r.mirrored !== 1).length,
            shadows,
            details: paths.filter(p => p.classList.contains('wtm-detail')).length,
            widths: paths.map(p => Number(p.getAttribute('stroke-width'))),
          };
        });
        return out;
      });

      assert(shapes.malformed.length === 0,
        'an attribute value swallowed markup: ' + shapes.malformed.join(' | '));

      const edge = await page.evaluate(() => window.wtmap.settings.icon_edge);
      for (const [icon, shape] of Object.entries(shapes.bodies)) {
        eq(shape.unmatched, 0,
          icon + ': every body path needs one copy and one mirrored copy');
        assert(shape.details <= 1, icon + ': unexpected detail lines');
        shape.widths.forEach(w =>
          assert(w >= 0 && w < 1, icon + ': implausible stroke width ' + w));
        // With no outline chosen the paths must carry no stroke, and the
        // shadow, when chosen, is a dark copy behind the fill.
        if (edge === 'shadow' || edge === 'both') {
          assert(shape.widths.every(w => w > 0) === (edge === 'both'),
            edge + ': body strokes should be ' + (edge === 'both' ? 'on' : 'off'));
          assert(shape.shadows > 0,
            edge + ': expected dark copies behind the fill');
        } else {
          eq(shape.shadows, 0, edge + ': expected no shadow copy');
        }
      }

      eq(shapes.bodies.Fighter.bodies, 1, 'the fighter is a single outline');
      // The bomber adds a nacelle and twin fins on top of its outline.
      assert(shapes.bodies.Bomber.bodies >= 3,
        'the bomber should draw its nacelle and twin fins as well, got ' +
        shapes.bodies.Bomber.bodies);

      // The artwork has to pick up the row colour, on both halves. It did not
      // for a while: the panel rule gives every descendant an explicit grey, so
      // currentColor resolved to grey rather than to the row. And when an
      // attribute swallowed markup, one half fell back to the SVG default,
      // which is black.
      const colours = await page.evaluate(() => {
        const out = {};
        ['wtm-bluerow', 'wtm-redrow'].forEach(rowId => {
          const paths = [...document.querySelectorAll('#' + rowId +
            ' th.wtm-aircraft svg path')]
            .filter(p => !/fill:#000/.test(p.getAttribute('style') || ''));
          const wanted = getComputedStyle(
            document.querySelector('#' + rowId + ' th')).color;
          out[rowId] = {
            wanted,
            halves: paths.length,
            wrong: paths.filter(p => getComputedStyle(p).fill !== wanted).length,
          };
        });
        return out;
      });
      for (const [row, colour] of Object.entries(colours)) {
        assert(colour.halves >= 2, row + ': too few halves drawn, ' + colour.halves);
        eq(colour.wrong, 0,
          row + ': artwork colour, ' + colour.wrong + ' of ' + colour.halves +
          ' halves are not ' + colour.wanted);
      }
    });

    await test('respawn bases are not counted as contacts', async () => {
      const objects = await getJson(url, 'map_obj.json');
      const bases = objects.filter(o => o.icon && o.icon.startsWith('respawn_base'));
      const got = await readSummary(page);
      const listed = [...Object.keys(got.blue), ...Object.keys(got.red)];
      bases.forEach(b => assert(!listed.includes(b.icon),
        'respawn base listed in the summary: ' + b.icon));
      assert(got.blue.MediumTank !== undefined || got.red.MediumTank !== undefined ||
        listed.length > 0, 'the summary is empty, the check above is vacuous');
    });

    await test('title bar reports enemies, distance and allies', async () => {
      const objects = await getJson(url, 'map_obj.json');
      const units = objects.filter(o =>
        (o.type === 'aircraft' || o.type === 'ground_model') && o.icon !== 'Player');
      const hasPlayer = objects.some(o => o.icon === 'Player');
      const hasEnemy = units.some(isRed);

      // Zero counts are left out, and so is the distance when there is no
      // enemy or no player to measure from.
      const parts = [];
      if (hasEnemy) parts.push('E:\\d+');
      if (hasEnemy && hasPlayer) parts.push('> [\\d.]+ [a-z]+');
      if (units.length) parts.push('F:\\d+');

      const title = await page.evaluate(() => document.title);
      if (!parts.length) {
        eq(title, 'War Thunder Map', 'title with nothing to report');
        return;
      }
      const pattern = new RegExp('^\\((' + parts.join(' ') + ')\\) War Thunder Map$');
      assert(pattern.test(title), 'title ' + JSON.stringify(title) +
        ' does not match ' + pattern);
    });

    /* --- following the player -------------------------------------- */

    await test('the map follows the player', async () => {
      const pan = await page.evaluate(() => {
        const c = document.getElementById('map-canvas');
        window.map_scale = 4;
        window.update_object_positions([{
          type: 'ground_model', icon: 'Player', icon_bg: 'none', x: 0.5, y: 0.5,
          dx: 0, dy: -1, color: '#faC81E', 'color[]': [250, 200, 30], blink: 0,
        }]);
        return {
          pan: window.map_pan.slice(),
          wantX: -(0.5 * c.width * 4) + c.width / 2,
          wantY: -(0.5 * c.height * 4) + c.height / 2,
        };
      });
      near(pan.pan[0], pan.wantX, 1, 'pan x');
      near(pan.pan[1], pan.wantY, 1, 'pan y');
    });

    /* --- zoom ------------------------------------------------------- */

    await test('the wheel zoom level is stored and survives a map change', async () => {
      const box = await (await page.$('#map-canvas')).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel({deltaY: -120});
        await sleep(40);
      }
      await sleep(250);
      const zoomed = await page.evaluate(() => {
        const info = window.map_info || {};
        return {
          scale: window.map_scale,
          stored: parseFloat(localStorage.getItem('wtmap_scale')),
          width: info.map_max && info.map_min ? info.map_max[0] - info.map_min[0] : null,
        };
      });
      assert(zoomed.scale > 1.05, 'wheel did not zoom in: ' + zoomed.scale);
      near(zoomed.stored * zoomed.width, zoomed.scale, 0.01,
        'stored ratio does not reproduce the scale');

      // update_map_info resets the scale whenever the map generation changes.
      const after = await page.evaluate(() => {
        window.update_map_info(JSON.parse(JSON.stringify(window.map_info)));
        return window.map_scale;
      });
      near(after, zoomed.scale, 0.01, 'map info refresh reset the zoom');
    });

    /* --- state and indicator panels -------------------------------- */

    await test('state and indicator panels fill their tables', async () => {
      await page.evaluate(() => {
        document.querySelector('#update_state-toggle').click();
        document.querySelector('#update_indicators-toggle').click();
      });
      await sleep(1400);

      const rows = await page.evaluate(() => ({
        state: [...document.querySelectorAll('#wtm-state tr')].map(r =>
          [...r.children].map(c => c.textContent)),
        indicators: [...document.querySelectorAll('#wtm-indicators tr')].map(r =>
          [...r.children].map(c => c.textContent)),
      }));

      // The map sends valid:false outside a vehicle, in which case the tables
      // are meant to stay empty.
      for (const [name, data, got] of [
        ['state', await getJson(url, 'state'), rows.state],
        ['indicators', await getJson(url, 'indicators'), rows.indicators],
      ]) {
        if (!data || !data.valid) {
          eq(got.length, 0, name + ' rows while the endpoint reports invalid');
          continue;
        }
        const keys = Object.keys(data).filter(k => k !== 'valid');
        eq(got.length, keys.length, name + ' rows');
        keys.forEach((key, i) => {
          const label = key.split(',')[0].replace(/_/g, ' ');
          eq(got[i][0], label, name + ' row ' + i + ' label');
          const value = data[key];
          const shown = typeof value === 'number'
            ? String(Math.round(value * 100) / 100)
            : String(value);
          const unit = key.includes(',') ? key.split(',')[1].trim() : '';
          if (unit) {
            assert(got[i][1].endsWith(unit), name + ' row ' + i + ' unit: ' + got[i][1]);
          }
          if (EXTERNAL_URL) {
            // A live vehicle's instruments move between this fetch and the
            // page's next poll, so only check the shape of the value here.
            // Some are strings to begin with, e.g. army, type.
            if (typeof value === 'number') {
              assert(/^-?\d/.test(got[i][1].replace(unit, '').trim()),
                name + ' row ' + i + ' value is not a number: ' + got[i][1]);
            }
          } else {
            assert(got[i][1].startsWith(shown), name + ' row ' + i + ' value: ' +
              got[i][1] + ' should start with ' + shown);
          }
        });
      }
    });

    await test('a panel toggle collapses the panel and remembers itself', async () => {
      const state = await page.evaluate(async () => {
        const toggle = document.querySelector('#update_state-toggle');
        toggle.click();
        const off = {
          cls: document.querySelector('#wtm-state-root').className,
          display: getComputedStyle(document.getElementById('wtm-state')).display,
        };
        toggle.click();
        return {off, on: document.querySelector('#wtm-state-root').className,
          checked: toggle.checked};
      });
      assert(/ off/.test(state.off.cls), 'panel not marked off: ' + state.off.cls);
      eq(state.off.display, 'none', 'panel contents still shown');
      assert(!/ off/.test(state.on), 'panel not re-enabled');
      eq(state.checked, true, 'toggle unchecked after being re-enabled');
    });

    await test('clicking a row highlights it and remembers the choice', async () => {
      const hl = await page.evaluate(() => {
        const row = document.querySelector('#wtm-state tr, #wtm-indicators tr');
        if (!row) {
          return {noRows: true};
        }
        row.click();
        return {cls: row.className,
          stored: Object.keys(localStorage).filter(k => /_hl_(state|indicators)$/.test(k))};
      });
      if (hl.noRows) {
        // Both endpoints report invalid (map view, no vehicle): nothing to
        // highlight, which is the correct behaviour.
        console.log('        (skipped, both panel endpoints report invalid)');
        return;
      }
      eq(hl.cls, 'hl', 'row not highlighted');
      eq(hl.stored.length, 1, 'highlight not stored: ' + JSON.stringify(hl.stored));
    });

    /* --- options dialog -------------------------------------------- */

    await test('the options dialog saves and applies immediately', async () => {
      await page.click('.wtm-gear');
      await sleep(200);
      eq(await page.evaluate(() =>
        getComputedStyle(document.getElementById('wtm-options')).display),
        'block', 'dialog did not open');

      const applied = await page.evaluate(() => {
        document.getElementById('opt_icon_size').value = '44';
        document.querySelector('input[name=opt_units][value=mi]').checked = true;
        document.getElementById('opt_hide_chat').checked = false;
        document.getElementById('wtm-save').click();
        return {
          iconSize: localStorage.getItem('wtmap_plane_icon_size'),
          units: localStorage.getItem('wtmap_units'),
          hideChat: localStorage.getItem('wtmap_hide_chat'),
          status: document.getElementById('wtm-status').textContent,
        };
      });
      eq(applied.iconSize, '44', 'icon size');
      eq(applied.units, 'mi', 'units');
      eq(applied.hideChat, '0', 'hide chat');
      eq(applied.status, 'Options saved', 'no confirmation shown');

      await sleep(1800);
      const live = await page.evaluate(() => ({
        chat: getComputedStyle(document.getElementById('game-chat-root')).display,
        chatLines: document.querySelectorAll('#game-chat-root .chat-line').length,
        caption: document.getElementById('wtm-mapinfo').textContent.replace(/\s+/g, ' ').trim(),
      }));
      assert(live.chat !== 'none', 'chat panel still hidden');
      assert(live.chatLines > 0, 'no chat lines after enabling the panel');
      assert(/ mi/.test(live.caption), 'units not applied to the caption: ' + live.caption);
    });

    /* --- reload ----------------------------------------------------- */

    await test('settings and layout survive a reload', async () => {
      // Same browser context, so localStorage carries over, new document.
      page = await open(page.testContext);
      const after = await page.evaluate(() => ({
        units: localStorage.getItem('wtmap_units'),
        iconSize: localStorage.getItem('wtmap_plane_icon_size'),
        parent: document.getElementById('map-canvas').parentElement.id,
        mapRoot: getComputedStyle(document.getElementById('map-root')).display,
        chat: getComputedStyle(document.getElementById('game-chat-root')).display,
        stateToggle: document.querySelector('#update_state-toggle').checked,
        indicatorsToggle: document.querySelector('#update_indicators-toggle').checked,
      }));
      eq(after.units, 'mi', 'units after reload');
      eq(after.iconSize, '44', 'icon size after reload');
      eq(after.parent, 'wtm-map', 'canvas after reload');
      eq(after.mapRoot, 'none', 'panels after reload');
      assert(after.chat !== 'none', 'chat panel hidden after reload');
      eq(after.stateToggle, true, 'state toggle lost');
      eq(after.indicatorsToggle, true, 'indicators toggle lost');
    });

    await test('the page reports no errors', async () => {
      eq(pageErrors.join(' | '), '', 'page errors');
    });
    await shot(page, 'panels');

    /* --- plane icons, pixel level ----------------------------------- */

    // These need the fixture's fixed set of aircraft with known headings, so
    // they only run against the fixture.
    let planesPage = null;
    if (!EXTERNAL_URL) {
      // A fresh context means no stored zoom, so the whole map is visible and
      // the aircraft sit at predictable screen positions.
      await setMode('planes');
      planesPage = await open();
    } else {
      console.log('\n  (skipping the pixel level icon checks: they need the fixture)');
    }

    await test('aircraft are drawn at the right place and follow the heading', async () => {
      // The shapes are about as wide as they are long, so the principal axis of
      // the ink says nothing about the heading. Instead: draw one aircraft
      // pointing north and one pointing east, and check that the second is the
      // first turned a quarter turn. That only holds if the drawing is rotated.
      const shots = await planesPage.evaluate(() => {
        const c = document.getElementById('map-canvas');
        const ctx = c.getContext('2d', {willReadFrequently: true});

        function ink(dx, dy) {
          window.map_objects.length = 0;
          window.update_object_positions([{
            type: 'aircraft', icon: 'Fighter', icon_bg: 'none',
            x: 0.5, y: 0.5, dx, dy,
            color: '#174DFF', 'color[]': [23, 77, 255], blink: 0,
          }].slice());
          window.redraw_map(0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          const pts = [];
          for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
              const i = (y * c.width + x) * 4;
              // the fill only: an edge or a shadow is dark, not blue
              if (d[i + 3] > 150 && d[i + 2] > 180 && d[i] < 110) {
                pts.push(x, y);
              }
            }
          }
          return pts;
        }
        return {north: ink(0, -1), east: ink(1, 0)};
      });

      function shape(points) {
        const n = points.length / 2;
        assert(n > 20, 'only ' + n + ' pixels of fill');
        let cx = 0, cy = 0;
        for (let i = 0; i < points.length; i += 2) {
          cx += points[i];
          cy += points[i + 1];
        }
        cx /= n;
        cy /= n;
        const set = new Set();
        for (let i = 0; i < points.length; i += 2) {
          set.add(Math.round(points[i] - cx) + ',' + Math.round(points[i + 1] - cy));
        }
        return {set, cx, cy};
      }

      const a = shape(shots.north);
      const b = shape(shots.east);
      near(a.cx, b.cx, 2, 'both should be drawn at the same point');
      near(a.cy, b.cy, 2, 'both should be drawn at the same point');

      // A quarter turn towards the east maps (dx, dy) to (-dy, dx)
      function overlap(map) {
        let matched = 0;
        a.set.forEach(key => {
          const [dx, dy] = key.split(',').map(Number);
          if (b.set.has(map(dx, dy).join(','))) {
            matched += 1;
          }
        });
        return matched / a.set.size;
      }
      const quarter = overlap((dx, dy) => [-dy, dx]);
      const as_drawn = overlap((dx, dy) => [dx, dy]);

      assert(quarter > 0.8,
        'the east facing ink is not the north facing ink turned a quarter ' +
        'way: only ' + Math.round(quarter * 100) + '% of the pixels line up');
      assert(quarter > as_drawn * 1.15,
        'turning the icon explains the drawing no better than leaving it ' +
        'alone (' + Math.round(quarter * 100) + '% against ' +
        Math.round(as_drawn * 100) + '%)');
    });

    // The map draws its own glyphs with a hardcoded 1px black stroke. The edge
    // setting has to reach those too, 'none' included: that means stopping the
    // stroke the map would draw, which only works by intercepting it.
    await test('the edge setting applies to the map\'s own glyphs', async () => {
      async function darkPixels(edge) {
        return page.evaluate(edge => {
          window.wtmap.settings.icon_edge = edge;
          window.map_objects.length = 0;
          window.update_object_positions([{
            type: 'ground_model', icon: 'MediumTank', icon_bg: 'none',
            x: 0.5, y: 0.5, color: '#174DFF', 'color[]': [23, 77, 255], blink: 0,
          }].slice());
          window.redraw_map(0);
          const c = document.getElementById('map-canvas');
          const d = c.getContext('2d', {willReadFrequently: true})
            .getImageData(0, 0, c.width, c.height).data;
          let dark = 0, blue = 0;
          for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
              const i = (y * c.width + x) * 4;
              if (Math.abs(x - c.width / 2) > 30 || Math.abs(y - c.height / 2) > 30) continue;
              if (d[i + 3] < 40) continue;
              if (d[i] < 70 && d[i + 1] < 70 && d[i + 2] < 70) dark += 1;
              if (d[i + 2] > 180 && d[i] < 110) blue += 1;
            }
          }
          return {dark, blue};
        }, edge);
      }

      const bare = await darkPixels('none');
      const edged = await darkPixels('outline');
      await page.evaluate(() => { window.wtmap.settings.icon_edge = 'shadow'; });

      assert(bare.dark <= 2,
        'with no edge a tank should be all fill, found ' + bare.dark + ' dark pixels');
      assert(bare.blue > 10, 'the tank is not being drawn: ' + bare.blue + ' blue pixels');
      assert(edged.dark > bare.dark * 3,
        'the map\'s own edge is ' + edged.dark + ' dark pixels against ' +
        bare.dark + ' without one');
    });

    await test('ground units do not cover aircraft', async () => {
      if (!planesPage) return;
      const order = await planesPage.evaluate(() => {
        window.map_objects.slice().sort;
        return window.map_objects.map(o => o.type);
      });
      // The patched update_object_positions sorts aircraft last so they are
      // painted on top of ground units.
      const lastGround = order.lastIndexOf('ground_model');
      const firstAir = order.indexOf('aircraft');
      assert(firstAir === -1 || firstAir > lastGround,
        'aircraft are painted before ground units: ' + order.join(','));
    });

    await test('off-map aircraft are shown on the canvas edge', async () => {
      if (!planesPage) return;
      const edge = await planesPage.evaluate(() => {
        const c = document.getElementById('map-canvas');
        const ctx = c.getContext('2d', {willReadFrequently: true});
        window.map_scale = 3;

        // A 35% alpha icon over unknown terrain is hard to pick out by colour,
        // so diff a frame without the contact against one with it.
        function frame(objects) {
          window.update_object_positions(objects);
          return ctx.getImageData(0, 0, c.width, c.height).data;
        }

        const offMap = {
          type: 'aircraft', icon: 'Fighter', icon_bg: 'none',
          x: 0.30, y: -0.60, dx: 0, dy: 1,
          color: '#fa0C00', 'color[]': [250, 12, 0], blink: 0,
        };

        const before = frame([]);
        const after = frame([offMap]);

        let painted = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            if (Math.abs(after[i] - before[i]) > 12 ||
                Math.abs(after[i + 1] - before[i + 1]) > 12 ||
                Math.abs(after[i + 2] - before[i + 2]) > 12) {
              painted++;
              minX = Math.min(minX, x); minY = Math.min(minY, y);
              maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            }
          }
        }
        return {painted, box: [minX, minY, maxX, maxY],
          width: c.width, height: c.height, scale: window.map_scale};
      });

      assert(edge.painted > 10, 'nothing was painted: ' + edge.painted + ' px');
      assert(edge.box[1] < 24, 'not on the top edge, ink starts at y=' + edge.box[1]);
      assert(edge.box[3] < 44, 'ink is not hugging the edge: y=' + edge.box[3]);
      // An icon, not a smear across the map.
      assert(edge.box[2] - edge.box[0] < 60 && edge.box[3] - edge.box[1] < 60,
        'unexpected mark size: ' + edge.box.join(','));
    });
    if (planesPage) {
      await shot(planesPage, 'planes');
    }

    await setMode('full');
  } finally {
    await browser.close();
    stopServer();
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) {
    console.log('failing: ' + failed.map(f => f.name).join(', '));
    console.log('screenshots in ' + OUT);
    process.exit(1);
  }
})().catch(error => {
  stopServer();
  fail(error && error.stack ? error.stack : String(error));
});
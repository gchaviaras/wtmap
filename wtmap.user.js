// ==UserScript==
// @name         WT map
// @namespace    https://github.com/slikts/wtmap
// @version      1.0.0
// @description  Enhances the War Thunder browser map: different plane icons (F-39/IL-2/Ju 88) with heading, off-screen contacts on the map edge, map follows the player, near real-time updates, per-team object summary in the map panel, distance readouts in the title bar, persistent zoom, optional state/indicator/chat panels. Port of the "WT map" Chrome extension (MIT, slikts) to a userscript that patches the map page in place.
// @author       slikts (original extension)
// @license      MIT
// @match        http://localhost:8111/*
// @match        http://127.0.0.1:8111/*
// @include      http://*:8111/*
// @grant        none
// @run-at       document-start
// @inject-into  page
// @noframes
// ==/UserScript==

/*
 * Why this works as a userscript but not as a content script:
 * the extension had to download the map page, re-eval its scripts in an
 * extension page and hide the originals, because content scripts cannot touch
 * the page's JavaScript environment. A userscript injected into the page itself
 * can, so this one monkey-patches the map code where it already lives and takes
 * over its timers.
 *
 * Everything the page defines with `var`/`function` lives on `window`, so all
 * patches go through `W.*`. Nothing is declared globally by this script.
 */

(function () {
    'use strict';

    var W = window;
    var doc = W.document;

    /* ---------------------------------------------------------------- *
     * settings (localStorage on the map origin, namespaced with wtmap_) *
     * ---------------------------------------------------------------- */

    var DEFAULTS = {
        plane_icon_size: 25,      // px
        map_center: 1,            // follow the player
        units: 'km',              // km | mi | nmi | m | ft
        // Map coordinates are a unit grid: 0..2048 on the 20 km air maps and
        // 0..4096 on the 40 km ground maps, with 225 unit grid cells. War
        // Thunder uses 10 m per unit, which makes this the real scale of the
        // distance and size readouts.
        unit_size: 10,
        object_update_rate: 50,   // ms between /map_obj.json polls (also the frame rate)
        panels_update_rate: 500,  // ms between state/indicators/chat polls
        map_info_update_rate: 5000,
        update_indicators: 0,
        update_state: 0,
        hide_chat: 1,             // hide chat and HUD message panels
        hide_objectives: 0,       // show the mission objectives panel
        fullscreen_panels: 'column', // column | hidden | overlay, while fullscreen
        full_window: 0            // F11 style mode: the map fills the browser window
    };

    var UNITS = {
        m: 1,
        km: 0.001,
        nmi: 0.000539957,
        mi: 0.000621371,
        ft: 3.28084
    };

    // What happens to the side panels while the map is fullscreen.
    var PANEL_MODES = {
        column: 1,     // a column beside the map
        overlay: 1,    // floating on top of the map
        hidden: 1      // not shown
    };

    var store = (function () {
        var ok = true;
        try {
            W.localStorage.setItem('wtmap_probe', '1');
            W.localStorage.removeItem('wtmap_probe');
        } catch (e) {
            ok = false;
        }
        var mem = {};

        return {
            get: function (key) {
                try {
                    return ok ? W.localStorage.getItem('wtmap_' + key) : mem[key];
                } catch (e) {
                    return null;
                }
            },
            set: function (key, val) {
                try {
                    if (ok) {
                        W.localStorage.setItem('wtmap_' + key, String(val));
                    } else {
                        mem[key] = String(val);
                    }
                } catch (e) {}
            },
            del: function (key) {
                try {
                    if (ok) {
                        W.localStorage.removeItem('wtmap_' + key);
                    } else {
                        delete mem[key];
                    }
                } catch (e) {}
            }
        };
    })();

    var settings = {};

    (function load_settings() {
        Object.keys(DEFAULTS).forEach(function (key) {
            var def = DEFAULTS[key];
            var raw = store.get(key);
            var val;
            if (raw === null || raw === undefined || raw === '') {
                val = def;
            } else if (typeof def === 'number') {
                val = parseFloat(raw);
                if (!isFinite(val)) {
                    val = def;
                }
            } else {
                val = String(raw).trim();
            }
            settings[key] = val;
        });
        if (!(settings.units in UNITS)) {
            settings.units = DEFAULTS.units;
        }
        if (!(settings.fullscreen_panels in PANEL_MODES)) {
            settings.fullscreen_panels = DEFAULTS.fullscreen_panels;
        }
        settings.full_window = settings.full_window ? 1 : 0;
    })();

    /* ---------------------------------------------------------------- *
     * icons                                                              *
     * ---------------------------------------------------------------- */

    // Glyphs of the bundled plane_icons font (F-39, Ju 88, IL-2) and their
    // metrics, same mapping the extension used.
    var PLANE_GLYPHS = {
        Fighter: 'a',
        Bomber: 'b',
        Assault: 'c'
    };
    var PLANE_SCALE = {
        a: 0.92,
        b: 1.08,
        c: 0.96
    };

    // The map's own Icons font mapping, so the summary table shows the same
    // glyphs that are drawn on the map.
    var ICON_GLYPHS = {
        Airdefence: '4',
        Structure: '5',
        waypoint: '6',
        capture_zone: '7',
        bombing_point: '8',
        defending_point: '9',
        respawn_base_tank: '0',
        respawn_base_fighter: '.',
        respawn_base_bomber: ':'
    };

    // Order of the summary columns; anything else is appended.
    var SUMMARY_ORDER = [
        'Fighter', 'Bomber', 'Assault',
        'LightTank', 'MediumTank', 'HeavyTank', 'TankDestroyer', 'SPAA',
        'Ship', 'Transport', 'Artillery', 'Airdefence', 'Structure',
        'capture_zone'
    ];

    // Static spawn points are not contacts, keep them out of the summary.
    function is_contact(item) {
        var icon = item.icon;
        return icon && icon !== 'none' && icon !== 'Player' &&
                icon.indexOf('respawn_base') !== 0;
    }

    function icon_glyph(icon) {
        if (icon in PLANE_GLYPHS) {
            return PLANE_GLYPHS[icon];
        }
        if (icon in ICON_GLYPHS) {
            return ICON_GLYPHS[icon];
        }
        return icon.charAt(0);
    }

    // Aircraft and ground models only; airfields and zones are scenery.
    function is_unit(item) {
        return item.type === 'aircraft' || item.type === 'ground_model';
    }

    /* ---------------------------------------------------------------- *
     * timer interception                                                 *
     *                                                                    *
     * The map starts two intervals in init(): updateSlow (500ms, polls      *
     * every endpoint) and updateFast (25ms, redraws). We take both over.   *
     * Only possible from the page context, hence @grant none.                *
     * ---------------------------------------------------------------- */

    var captured = [];
    var native_set_interval = W.setInterval;

    W.setInterval = function () {
        var id = native_set_interval.apply(W, arguments);
        captured.push({id: id, fn: arguments[0]});
        return id;
    };

    var base_title = doc.title || 'War Thunder Map';

    /* ---------------------------------------------------------------- *
     * patching the map code                                              *
     * ---------------------------------------------------------------- */

    var patched = false;
    var booted = false;
    var pollers = {};

    var _canvas = null;
    var _map_width = 0;
    var _map_height = 0;
    var _player = null;

    function to_units(value_in_map_units) {
        var meters = value_in_map_units * (settings.unit_size || 10);
        return meters * (UNITS[settings.units] || 1);
    }

    function get_distance(x1, y1, x2, y2) {
        var dx = Math.abs(x1 - x2) * _map_width;
        var dy = Math.abs(y1 - y2) * _map_height;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function hex_to_rgba(hex, alpha) {
        if (!hex || hex.charAt(0) !== '#' || hex.length < 7) {
            return hex;
        }
        return 'rgba(' + [
            parseInt(hex.substr(1, 2), 16),
            parseInt(hex.substr(3, 2), 16),
            parseInt(hex.substr(5, 2), 16)
        ].join(',') + ',' + alpha + ')';
    }

    // Red is enemy, blue and green are the two friendly teams.
    function team_of(item) {
        var c = item['color[]'];
        if (!c || c.length < 3) {
            return 'blue';
        }
        return c[0] > c[2] + 32 ? 'red' : 'blue';
    }

    function draw_text_icon(ctx, text, sx, sy, dir, fill, alpha, font_size, stroke) {
        ctx.save();
        ctx.translate(sx, sy);
        if (dir) {
            ctx.rotate(dir);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = alpha ? hex_to_rgba(fill, alpha) : fill;
        ctx.lineWidth = 1;
        ctx.font = font_size + 'px plane_icons';
        ctx.fillText(text, 0, 0);
        if (stroke) {
            ctx.strokeStyle = alpha ? hex_to_rgba(stroke, alpha) : stroke;
            ctx.strokeText(text, 0, 0);
        }
        ctx.restore();
    }

    // Move an off-map aircraft onto the canvas border, along the line from the
    // canvas centre through its real position.
    function clamp_to_edge(sx, sy, width, height, offset) {
        var slope = (height / 2 - sy) / (width / 2 - sx);
        var y_intercept = sy - slope * sx;

        if (sx > width) {
            sx = width - offset;
            sy = slope * sx + y_intercept;
        } else if (sx < 0) {
            sx = offset;
            sy = slope * sx + y_intercept;
        }

        if (sy > height) {
            sy = height - offset;
            sx = (sy - y_intercept) / slope;
        } else if (sy < 0) {
            sy = offset;
            sx = (sy - y_intercept) / slope;
        }

        if (!isFinite(sx) || !isFinite(sy)) {
            // Degenerate direction (aircraft exactly on a centre axis).
            sx = Math.min(Math.max(sx, offset), width - offset);
            sy = Math.min(Math.max(sy, offset), height - offset);
        }

        return {x: sx, y: sy};
    }

    function center_view(x, y, c_width, c_height) {
        W.map_pan[0] = -(x * c_width * W.map_scale) + c_width / 2;
        W.map_pan[1] = -(y * c_width * W.map_scale) + c_height / 2;
        W.clampMapPan();
    }

    function patch_map_code() {
        if (patched) {
            return;
        }

        // --- map follows the player ---
        var _draw_player = W.draw_player;
        W.draw_player = function (canvas, ctx, item, dt) {
            if (!W.isDraggingMap && settings.map_center) {
                center_view(item.x, item.y, canvas.width, canvas.height);
            }
            return _draw_player.apply(this, arguments);
        };

        // --- plane icons with heading, off-screen contacts on the edge ---
        var _draw_map_object = W.draw_map_object;
        W.draw_map_object = function (canvas, ctx, item, rotate) {
            if (item.type !== 'aircraft' || !(_canvas && _canvas.width)) {
                return _draw_map_object.apply(this, arguments);
            }

            var sx = item.x * _canvas.width * W.map_scale + W.map_pan[0];
            var sy = item.y * _canvas.height * W.map_scale + W.map_pan[1];

            var glyph = PLANE_GLYPHS[item.icon];
            if (!glyph) {
                return _draw_map_object.apply(this, arguments);
            }

            var dx = +item.dx;
            var dy = +item.dy;
            var dir = isFinite(dx) && isFinite(dy) ? Math.atan2(dx, -dy) : 0;

            var color = W.calcMapObjectColor(item);
            var font_size = settings.plane_icon_size * (PLANE_SCALE[glyph] || 1);
            var offscreen = sx > _canvas.width || sx < 0 ||
                            sy > _canvas.height || sy < 0;

            if (offscreen) {
                var pos = clamp_to_edge(sx, sy, _canvas.width, _canvas.height, 12);
                sx = pos.x;
                sy = pos.y;
            }

            draw_text_icon(ctx, glyph, sx, sy, dir, color,
                    offscreen ? '0.35' : null, font_size, '#000000');
        };

        // --- sorting, summary and title bar ---
        var _update_object_positions = W.update_object_positions;

        W.update_object_positions = function (objects) {
            try {
                if (objects && objects.length) {
                    // Aircraft are drawn last so ground units never obscure them.
                    var priority = {aircraft: 3, ground_model: 2, airfield: 1};
                    _player = null;
                    objects.sort(function (a, b) {
                        if (a.icon === 'Player') {
                            _player = a;
                        }
                        // Must be numeric: a boolean result is ignored by sort().
                        return (priority[a.type] || 0) - (priority[b.type] || 0);
                    });
                    update_summary(objects);
                } else {
                    _player = null;
                    update_summary([]);
                }
            } catch (e) {
                log(e);
            }

            _update_object_positions.apply(this, arguments);
        };

        // --- persistent zoom, map size / grid readouts ---
        var _update_map_info = W.update_map_info;

        W.update_map_info = function (info) {
            _update_map_info.apply(this, arguments);

            if (!info || !info.valid || !info.map_min || !info.map_max) {
                return;
            }

            _map_width = info.map_max[0] - info.map_min[0];
            _map_height = info.map_max[1] - info.map_min[1];

            $map_dimension_info.html(
                    Math.round(to_units(_map_width)) + '&times;' +
                    Math.round(to_units(_map_height)) +
                    ' ' + settings.units);
            $map_grid_info.text(
                    to_units(info.grid_steps[0]).toFixed(2) + ' ' + settings.units);

            // update_map_info resets the scale on every new map; put ours back.
            W.map_scale = clamp_scale(stored_ratio() * _map_width);
            if (settings.map_center && _player && _canvas) {
                center_view(_player.x, _player.y, _canvas.width, _canvas.height);
            }
            update_scale();
            W.redraw_map(0.0);
        };

        // --- remember the zoom level the user picked ---
        var _add_wheel_handler = W.addWheelHandler;
        if (_add_wheel_handler) {
            W.addWheelHandler = function (elem, handler) {
                return _add_wheel_handler.call(this, elem, function () {
                    handler.apply(this, arguments);
                    save_scale();
                });
            };
        }

        // --- our own polling replaces the map's updateSlow ---
        W.updateSlow = function () {};

        patched = true;
    }

    function clamp_scale(scale) {
        if (!isFinite(scale)) {
            return 1.0;
        }
        return Math.min(Math.max(scale, 1.0), 15.0);
    }

    function stored_ratio() {
        var raw = store.get('scale');
        var n = parseFloat(raw);
        if (raw !== null && raw !== '' && isFinite(n) && n > 0) {
            return n;
        }
        // Default: show the whole map.
        return 1.0 / (_map_width || 2048);
    }

    function save_scale() {
        if (!_map_width || !isFinite(W.map_scale)) {
            return;
        }
        store.set('scale', W.map_scale / _map_width);
    }

    function update_scale() {
        $map_scaleinfo.text(W.map_scale.toFixed(2));
    }

    function update_summary(objects) {
        var summary = {};
        var friendlies = 0;
        var enemies = 0;
        var min_distance = null;

        if (objects && objects.length) {
            for (var i = 0; i < objects.length; i++) {
                var item = objects[i];

                if (is_contact(item)) {
                    var counts = summary[item.icon] || (summary[item.icon] = [0, 0]);
                    counts[team_of(item) === 'blue' ? 0 : 1] += 1;
                }

                if (!is_unit(item) || item.icon === 'Player') {
                    continue;
                }

                var enemy = team_of(item) === 'red';
                if (enemy) {
                    enemies += 1;
                } else {
                    friendlies += 1;
                }

                if (enemy && _player) {
                    var distance = get_distance(item.x, item.y, _player.x, _player.y);
                    if (min_distance === null || distance < min_distance) {
                        min_distance = distance;
                    }
                }
            }
        }

        render_summary(summary);
        render_title(friendlies, enemies, min_distance);
    }

    var summary_rows = null;
    var $summary = null;
    var _summary_height = 0;
    var _summary_cells = -1;

    function render_summary(summary) {
        if (!summary_rows) {
            return;
        }
        var blue = summary_rows[0];
        var red = summary_rows[1];
        blue.innerHTML = '';
        red.innerHTML = '';

        var order = SUMMARY_ORDER.slice(0).concat(Object.keys(summary).filter(function (icon) {
            return SUMMARY_ORDER.indexOf(icon) < 0;
        }));

        order.forEach(function (icon) {
            var counts = summary[icon];
            if (!counts) {
                return;
            }
            var glyph = icon_glyph(icon);
            [blue, red].forEach(function (row, team) {
                var th = doc.createElement('th');
                th.textContent = counts[team] ? glyph : '';
                th.title = icon;
                if (icon in PLANE_GLYPHS) {
                    th.className = 'wtm-aircraft';
                    th.style.fontSize = (23 * (PLANE_SCALE[glyph] || 1)) + 'px';
                }
                var td = doc.createElement('td');
                td.textContent = counts[team] ? counts[team] : '';
                td.title = icon;
                row.appendChild(th);
                row.appendChild(td);
            });
        });

        measure_summary();
    }

    // The summary sits under the canvas, so the map has to leave room for it or
    // it ends up below the bottom of the window. Its height changes with the
    // number of contact kinds, so it is measured rather than guessed.
    function measure_summary() {
        if (!$summary) {
            return;
        }
        // Two rows always exist, so count the cells inside them: an empty row
        // collapses and the table gets shorter as contacts come and go.
        var cells = 0;
        for (var i = 0; i < $summary[0].children.length; i++) {
            cells += $summary[0].children[i].children.length;
        }
        if (cells === _summary_cells) {
            return;
        }
        _summary_cells = cells;
        var height = $summary[0].offsetHeight;
        if (height !== _summary_height) {
            _summary_height = height;
            position_panels();
        }
    }

    function render_title(friendlies, enemies, min_distance) {
        var title_info = [];
        if (enemies) {
            title_info.push('E:' + enemies);
        }
        if (min_distance !== null) {
            title_info.push('> ' + to_units(min_distance).toFixed(2) + ' ' + settings.units);
        }
        if (friendlies) {
            title_info.push('F:' + friendlies);
        }

        doc.title = title_info.length ? '(' + title_info.join(' ') + ') ' + base_title : base_title;
    }

    /* ---------------------------------------------------------------- *
     * polling                                                            *
     * ---------------------------------------------------------------- */

    function make_poller(url, handler, rate, on) {
        var xhr = new W.XMLHttpRequest();
        var timer = null;

        var p = {
            on: !!on,
            rate: Math.max(20, rate || 500),
            stop: function () {
                p.on = false;
                if (timer) {
                    W.clearTimeout(timer);
                    timer = null;
                }
            },
            start: function (new_rate) {
                p.stop();
                if (new_rate) {
                    p.rate = Math.max(20, new_rate);
                }
                p.on = true;
                send();
            }
        };

        function target() {
            return typeof p.url === 'function' ? p.url() : p.url;
        }
        p.url = url;

        function send() {
            if (!p.on) {
                return;
            }
            try {
                xhr.open('GET', target(), true);
                xhr.send();
            } catch (e) {
                log(e);
                timer = W.setTimeout(send, p.rate);
            }
        }

        function again() {
            timer = W.setTimeout(send, p.rate);
        }

        xhr.onload = function () {
            var data = null;
            try {
                data = this.responseText ? JSON.parse(this.responseText) : null;
            } catch (e) {
                data = null;
            }
            try {
                if (p.on) {
                    handler(data);
                }
            } catch (e) {
                log(e);
            }
            again();
        };

        xhr.onerror = again;
        xhr.onabort = function () {};

        send();
        return p;
    }

    function set_poller(name, url, handler, rate, on) {
        if (pollers[name]) {
            pollers[name].stop();
        }
        pollers[name] = make_poller(url, handler, rate, on);
        return pollers[name];
    }

    function start_pollers() {
        set_poller('objects', 'map_obj.json', W.update_object_positions,
                settings.object_update_rate, true);
        set_poller('map_info', 'map_info.json', W.update_map_info,
                settings.map_info_update_rate, true);
        set_poller('mission', 'mission.json', W.format_mission_data,
                settings.panels_update_rate, !settings.hide_objectives);

        // The map's own update_state()/update_indicators() fill the panels this
        // script hides, so the table versions are polled instead.
        set_poller('state', 'state', update_state,
                settings.panels_update_rate, settings.update_state);
        set_poller('indicators', 'indicators', update_indicators,
                settings.panels_update_rate, settings.update_indicators);

        if (!settings.hide_chat) {
            set_poller('gamechat', function () {
                return 'gamechat?lastId=' + W.lastChatRecId;
            }, W.update_game_chat, settings.panels_update_rate, true);
            set_poller('hudmsg', function () {
                return 'hudmsg?lastEvt=' + W.lastEvtMsgId + '&lastDmg=' + W.lastDmgMsgId;
            }, W.update_hud_msg, settings.panels_update_rate, true);
        } else if (pollers.gamechat) {
            pollers.gamechat.stop();
            pollers.hudmsg.stop();
        }
    }

    /* ---------------------------------------------------------------- *
     * panel data tables (state / indicators)                             *
     * ---------------------------------------------------------------- */

    var $state_table, $indicators_table;
    var state_data = {}, indicators_data = {};

    function update_table(data, data_store, $table, data_key) {
        if (!data || !data.valid) {
            Object.keys(data_store).forEach(function (key) {
                data_store[key].remove();
                delete data_store[key];
            });
            return;
        }

        var $ = W.jQuery;

        Object.keys(data_store).forEach(function (key) {
            if (!(key in data)) {
                data_store[key].remove();
                delete data_store[key];
            }
        });

        Object.keys(data).forEach(function (key) {
            if (key === 'valid') {
                return;
            }
            var $val = data_store[key];
            var parts = key.split(',');
            var unit = parts[1] ? parts[1].trim() : '';
            // "412 km/h" but "100%", the way the map itself writes them.
            var sep = unit && unit.charAt(0) !== '%' ? ' ' : '';
            var text = format_value(data[key]) + sep + unit;

            if (!$val) {
                var ls_key = parts[0] + '_hl_' + data_key;
                var $row = $('<tr>');
                $row.click(function () {
                    store.set(ls_key, 1 - (store.get(ls_key) * 1));
                    $row.toggleClass('hl');
                }).append($('<th>').text(parts[0].replace(/_/g, ' ')));
                if (store.get(ls_key) * 1) {
                    $row.addClass('hl');
                }
                data_store[key] = $('<td>').appendTo($row).text(text);
                $table.append($row);
            } else {
                $val.text(text);
            }
        });
    }

    // The map sends every number as a float, e.g. 2475.000000.
    function format_value(value) {
        if (typeof value !== 'number' || !isFinite(value)) {
            return value === undefined || value === null ? '' : String(value);
        }
        return value === Math.round(value) ? String(Math.round(value)) : String(+value.toFixed(2));
    }

    function update_state(data) {
        update_table(data, state_data, $state_table, 'state');
    }

    function update_indicators(data) {
        update_table(data, indicators_data, $indicators_table, 'indicators');
    }

    /* ---------------------------------------------------------------- *
     * user interface                                                     *
     * ---------------------------------------------------------------- */

    var $ = null;
    var $sidepanels, $map_info, $map_dimension_info, $map_grid_info,
        $map_scaleinfo, $options, $map_panel, $fs_button, $fw_button,
        state_panel, indicators_panel;

    // Panels are attached to the document as they are built: jQuery id
    // selectors only see elements that are in the document.
    function make_panel(id, caption, $parent) {
        var $caption_el = $('<div class="wtm-caption"></div>');
        if (caption) {
            $('<span class="wtm-caption-title"></span>').text(caption).appendTo($caption_el);
        }
        var $contents = $('<div id="wtm-' + id + '" class="wtm-panel-contents"></div>');
        var $root = $('<div id="wtm-' + id + '-root" class="wtm-panel"></div>')
                .append($caption_el)
                .append($contents);
        if ($parent) {
            $root.appendTo($parent);
        }
        return {$root: $root, $caption: $caption_el, $contents: $contents};
    }

    function adopt(id, title) {
        var $panel = $('#' + id);
        if (!$panel.length || !$sidepanels) {
            return;
        }
        $panel.addClass('wtm-adopted');
        var $caption = $panel.children('.caption').first();
        if (!$caption.length) {
            $caption = $('<div class="caption"><div id="draghandle"></div></div>')
                    .prependTo($panel);
        }
        $('<span class="wtm-caption-title"></span>').text(title).appendTo($caption);
        $panel.appendTo($sidepanels);
        return $panel;
    }

    function add_toggle(panel, setting, poller_name) {
        var $toggle = $('<div class="wtm-toggle"></div>').appendTo(panel.$caption);
        $('<label></label>')
                .attr('for', setting + '-toggle')
                .text('Update')
                .appendTo($toggle);
        var $input = $('<input type="checkbox">')
                .attr('id', setting + '-toggle')
                .prop('checked', !!settings[setting])
                .appendTo($toggle);

        $input.change(function () {
            var checked = !!this.checked;
            store.set(setting, checked ? 1 : 0);
            settings[setting] = checked ? 1 : 0;
            panel.$root[(checked ? 'remove' : 'add') + 'Class']('off');
            if (!pollers[poller_name]) {
                return;
            }
            if (checked) {
                pollers[poller_name].start();
            } else {
                pollers[poller_name].stop();
            }
        });

        if (!settings[setting]) {
            panel.$root.addClass('off');
        }
        return $input;
    }

    function build_ui() {
        var map = make_panel('map', '');

        // Floats are placed in source order, so the buttons go in first to end
        // up at the right edge of the caption.
        var $gear = $('<span class="wtm-toggle wtm-buttons"></span>').appendTo(map.$caption);

        $fw_button = $('<button class="wtm-icon wtm-fullwindow" title="Full window mode, like F11">⤢</button>')
                .appendTo($gear)
                .click(function (e) {
                    e.stopPropagation();
                    toggle_full_window();
                });

        $fs_button = $('<button class="wtm-icon wtm-fullscreen" title="Fullscreen (F)">⛶</button>')
                .appendTo($gear)
                .click(function (e) {
                    e.stopPropagation();
                    toggle_fullscreen();
                });

        $('<button class="wtm-icon wtm-gear" title="WT map options">⚙</button>')
                .appendTo($gear)
                .click(function () {
                    if ($options.is(':visible')) {
                        $options.hide();
                    } else {
                        fill_options();
                        $options.show();
                    }
                });

        $map_info = $('<span id="wtm-mapinfo"></span>').appendTo(map.$caption);
        $map_dimension_info = $('<span id="wtm-mapdimensions"></span>').appendTo($map_info);
        $map_grid_info = $('<span id="wtm-mapgrid"></span>').appendTo($map_info);
        $map_scaleinfo = $('<span id="wtm-mapscale"></span>').appendTo($map_info);

        map.$root.appendTo(doc.body);
        $map_panel = map.$root;

        // The map canvas and its caption move into our panel; the original
        // wrapper is left empty and hidden by the stylesheet.
        _canvas = doc.getElementById('map-canvas');
        $(_canvas).appendTo(map.$contents);

        $summary = $('<table id="wtm-mapsummary"></table>').appendTo(map.$contents);
        summary_rows = [doc.createElement('tr'), doc.createElement('tr')];
        summary_rows[0].id = 'wtm-bluerow';
        summary_rows[1].id = 'wtm-redrow';
        $summary.append(summary_rows[0]).append(summary_rows[1]);

        $sidepanels = $('<div id="wtm-sidepanels"></div>').appendTo(doc.body);

        var state = make_panel('state', 'State', $sidepanels);
        var indicators = make_panel('indicators', 'Indicators', $sidepanels);
        $state_table = $('<table class="wtm-data"></table>').appendTo(state.$contents);
        $indicators_table = $('<table class="wtm-data"></table>').appendTo(indicators.$contents);

        adopt('mission-objectives', 'Objectives');
        adopt('game-chat-root', 'Chat');
        adopt('hud-evt-msg-root', 'Events');
        adopt('hud-dmg-msg-root', 'Damage');

        build_options();
        apply_panels();

        state_panel = state;
        indicators_panel = indicators;
    }

    function apply_panels() {
        $('#mission-objectives').toggle(!settings.hide_objectives);
        $('#game-chat-root, #hud-evt-msg-root, #hud-dmg-msg-root')
                .toggle(!settings.hide_chat);
    }

    function build_options() {
        $options = $('<div id="wtm-options"><div id="wtm-options-inner">' +
                '<h2>WT map options</h2>' +
                '<table>' +
                '<tr><td><label for="opt_icon_size">Plane icon size</label></td>' +
                '<td><input type="number" min="8" max="80" id="opt_icon_size" ' +
                'class="input_number"> px <span id="wtm-plane_icon_preview"></span></td></tr>' +
                '<tr><td><label for="opt_map_center">Centre map on player</label></td>' +
                '<td><input type="checkbox" id="opt_map_center"></td></tr>' +
                '<tr><td>Units</td><td>' +
                '<label><input type="radio" name="opt_units" value="km"> km</label> ' +
                '<label><input type="radio" name="opt_units" value="mi"> mi</label> ' +
                '<label><input type="radio" name="opt_units" value="nmi"> nmi</label> ' +
                '<label><input type="radio" name="opt_units" value="m"> m</label> ' +
                '<label><input type="radio" name="opt_units" value="ft"> ft</label>' +
                '</td></tr>' +
                '<tr><td><label for="opt_unit_size">Map scale</label></td>' +
                '<td><input type="number" min="0.01" step="0.01" id="opt_unit_size" ' +
                'class="input_number"> m per map unit' +
                '<span class="wtm-note">10 m = 20 km map (2048), 40 km map (4096)</span>' +
                '</td></tr>' +
                '<tr><td><label for="opt_object_rate">Object poll rate</label></td>' +
                '<td><input type="number" min="20" id="opt_object_rate" ' +
                'class="input_number"> ms</td></tr>' +
                '<tr><td><label for="opt_panels_rate">Panel poll rate</label></td>' +
                '<td><input type="number" min="20" id="opt_panels_rate" ' +
                'class="input_number"> ms</td></tr>' +
                '<tr><td><label for="opt_hide_chat">Hide chat and HUD messages</label></td>' +
                '<td><input type="checkbox" id="opt_hide_chat"></td></tr>' +
                '<tr><td><label for="opt_hide_objectives">Hide objectives</label></td>' +
                '<td><input type="checkbox" id="opt_hide_objectives"></td></tr>' +
                '<tr><td><label for="opt_full_window">Full window mode</label></td>' +
                '<td><input type="checkbox" id="opt_full_window"></td></tr>' +
                '<tr><td><label for="opt_fullscreen_panels">Fullscreen panels</label></td>' +
                '<td><select id="opt_fullscreen_panels">' +
                '<option value="column">Beside the map</option>' +
                '<option value="overlay">Over the map</option>' +
                '<option value="hidden">Hidden</option>' +
                '</select></td></tr>' +
                '<tr><td>Shortcuts</td><td>' +
                '<span class="wtm-note">F fullscreen, M full window, Escape leaves full window' +
                '</span></td></tr>' +
                '</table>' +
                '<p id="wtm-options-buttons">' +
                '<button id="wtm-save">Save</button> ' +
                '<button id="wtm-restore">Restore defaults</button> ' +
                '<button id="wtm-close">Close</button>' +
                '<span id="wtm-status"></span></p>' +
                '</div></div>').appendTo(doc.body);

        var preview = [];
        Object.keys(PLANE_SCALE).forEach(function (key) {
            preview.push($('<span></span>').text(key).appendTo('#wtm-plane_icon_preview'));
        });

        $('#opt_icon_size').on('input', function () {
            var size = parseFloat($(this).val()) || DEFAULTS.plane_icon_size;
            preview.forEach(function ($icon, i) {
                $icon.css('fontSize', (size * PLANE_SCALE[['a', 'b', 'c'][i]]) + 'px');
            });
        });

        $('#wtm-save').click(function () {
            store.set('plane_icon_size', num_range('#opt_icon_size', DEFAULTS.plane_icon_size, 8, 80));
            store.set('map_center', $('#opt_map_center').prop('checked') ? 1 : 0);
            store.set('units', $('input[name=opt_units]:checked').val() || DEFAULTS.units);
            store.set('unit_size', num_range('#opt_unit_size', DEFAULTS.unit_size, 0.1, 100));
            store.set('object_update_rate', num_range('#opt_object_rate',
                    DEFAULTS.object_update_rate, 20, 10000));
            store.set('panels_update_rate', num_range('#opt_panels_rate',
                    DEFAULTS.panels_update_rate, 20, 60000));
            store.set('hide_chat', $('#opt_hide_chat').prop('checked') ? 1 : 0);
            store.set('hide_objectives', $('#opt_hide_objectives').prop('checked') ? 1 : 0);
            store.set('full_window', $('#opt_full_window').prop('checked') ? 1 : 0);
            store.set('fullscreen_panels',
                    $('#opt_fullscreen_panels').val() || DEFAULTS.fullscreen_panels);
            reload_settings();
            save_scale();
            apply_panels();
            position_panels();
            start_pollers();
            status('Options saved');
        });

        $('#wtm-restore').click(function () {
            if (!W.confirm('Restore the default options?')) {
                return;
            }
            Object.keys(DEFAULTS).forEach(function (key) {
                store.del(key);
            });
            store.del('scale');
            reload_settings();
            apply_panels();
            position_panels();
            start_pollers();
            fill_options();
            status('Defaults restored');
        });

        $('#wtm-close').click(function () {
            $options.hide();
        });

        $options.click(function (e) {
            if (e.target === $options[0]) {
                $options.hide();
            }
        });
    }

    function num_range(sel, fallback, min, max) {
        var val = parseFloat($(sel).val());
        if (!isFinite(val)) {
            return fallback;
        }
        return Math.min(Math.max(val, min), max);
    }

    var status_timer;

    function status(text) {
        $('#wtm-status').text(text);
        W.clearTimeout(status_timer);
        status_timer = W.setTimeout(function () {
            $('#wtm-status').text('');
        }, 3000);
    }

    function fill_options() {
        $('#opt_icon_size').val(settings.plane_icon_size);
        $('#opt_map_center').prop('checked', !!settings.map_center);
        $('input[name=opt_units]').filter('[value=' + settings.units + ']').prop('checked', true);
        $('#opt_unit_size').val(settings.unit_size);
        $('#opt_object_rate').val(settings.object_update_rate);
        $('#opt_panels_rate').val(settings.panels_update_rate);
        $('#opt_hide_chat').prop('checked', !!settings.hide_chat);
        $('#opt_hide_objectives').prop('checked', !!settings.hide_objectives);
        $('#opt_full_window').prop('checked', !!settings.full_window);
        $('#opt_fullscreen_panels').val(settings.fullscreen_panels);
        $('#opt_icon_size').trigger('input');
    }

    function reload_settings() {
        Object.keys(DEFAULTS).forEach(function (key) {
            var def = DEFAULTS[key];
            var raw = store.get(key);
            var val;
            if (raw === null || raw === undefined || raw === '') {
                val = def;
            } else if (typeof def === 'number') {
                val = parseFloat(raw);
                if (!isFinite(val)) {
                    val = def;
                }
            } else {
                val = String(raw).trim();
            }
            settings[key] = val;
        });
        if (!(settings.units in UNITS)) {
            settings.units = DEFAULTS.units;
        }
        if (!(settings.fullscreen_panels in PANEL_MODES)) {
            settings.fullscreen_panels = DEFAULTS.fullscreen_panels;
        }
        settings.full_window = settings.full_window ? 1 : 0;
    }

    /* ---------------------------------------------------------------- *
     * layout                                                             *
     * ---------------------------------------------------------------- */

    var SIDE_PANEL_WIDTH = 310;
    var CAPTION_HEIGHT = 24;

    /* ---------------------------------------------------------------- *
     * layout modes                                                      *
     *                                                                    *
     * column   - map beside the side panels (the default)                *
     * overlay  - map fills the window, panels float on top of it         *
     * hidden   - map fills the window, no panels                         *
     * window   - F11 style: the map fills the whole browser window       *
     * ---------------------------------------------------------------- */

    function is_fullscreen() {
        return !!(doc.fullscreenElement || doc.webkitFullscreenElement ||
                  doc.mozFullScreenElement || doc.msFullscreenElement);
    }

    function layout_mode() {
        if (settings.full_window) {
            return 'window';
        }
        if (is_fullscreen()) {
            return settings.fullscreen_panels === 'overlay' ? 'overlay' :
                   settings.fullscreen_panels === 'hidden' ? 'hidden' : 'column';
        }
        return 'column';
    }

    function apply_layout_class(mode) {
        var body = doc.body;
        ['column', 'overlay', 'hidden', 'window'].forEach(function (m) {
            body.classList[mode === m ? 'add' : 'remove']('wtm-mode-' + m);
        });
        body.classList[mode === 'window' ? 'add' : 'remove']('wtm-fullscreen-mode');
        if ($fs_button) {
            $fs_button.text(is_fullscreen() ? '\u25f1' : '\u26f6')
                .attr('title', is_fullscreen() ? 'Leave fullscreen (F)' : 'Fullscreen (F)');
        }
        if ($fw_button) {
            $fw_button.toggleClass('on', !!settings.full_window)
                .attr('title', settings.full_window ?
                    'Leave full window mode' : 'Full window mode, like F11');
        }
    }

    function position_panels() {
        if (!_canvas) {
            return;
        }
        var mode = layout_mode();
        apply_layout_class(mode);

        var view_w = doc.documentElement.clientWidth;
        var view_h = doc.documentElement.clientHeight;

        var width, height, size;
        if (mode === 'window') {
            // Follow the browser window exactly, whatever its aspect ratio.
            width = view_w;
            height = view_h;
            size = Math.max(width, height);
        } else if (mode === 'column') {
            // Room for the caption and for the summary table under the canvas.
            size = Math.max(Math.min(view_h - CAPTION_HEIGHT - 10 - _summary_height,
                    view_w - SIDE_PANEL_WIDTH - 30), 350);
            size = Math.min(size, 1600);
            width = size;
            height = size;
        } else {
            // overlay and hidden: as large as the window allows, capped so it
            // does not become unwieldy on very large displays.
            size = Math.max(Math.min(view_h - CAPTION_HEIGHT - 10, view_w - 30), 350);
            size = Math.min(size, 1600);
            width = size;
            height = size;
        }

        if (_canvas.width !== width || _canvas.height !== height) {
            // map_pan is in device pixels, so it has to follow the size change.
            var factor_x = _canvas.width ? width / _canvas.width : 1;
            var factor_y = _canvas.height ? height / _canvas.height : 1;
            _canvas.width = width;
            _canvas.height = height;
            if (W.map_pan && isFinite(W.map_pan[0])) {
                W.map_pan[0] *= factor_x;
                W.map_pan[1] *= factor_y;
            }
            if (W.clampMapPan) {
                W.clampMapPan();
            }
            if (W.redraw_map) {
                W.redraw_map(0.0);
            }
        }

        if (mode === 'column') {
            $sidepanels.css('left', size + 12);
            $map_panel.css('marginLeft', 0);
        } else if (mode === 'overlay' || mode === 'hidden') {
            // Centre the map; the panels sit on top of it. Measured rather than
            // assumed, because the body margin and the panel border both count.
            var style = W.getComputedStyle(doc.body);
            var body_margin = (parseFloat(style.marginLeft) || 0) +
                               (parseFloat(style.marginRight) || 0);
            var panel_width = $map_panel[0].offsetWidth || size;
            $sidepanels.css('left', '');
            $map_panel.css('marginLeft',
                    Math.max(Math.round((view_w - body_margin - panel_width) / 2), 0));
        } else {
            $sidepanels.css('left', '');
            $map_panel.css('marginLeft', 0);
        }

        update_scale();
    }

    /* ---------------------------------------------------------------- *
     * fullscreen and full window toggles                                 *
     * ---------------------------------------------------------------- */

    function request_fullscreen() {
        var el = doc.documentElement;
        var fn = el.requestFullscreen || el.webkitRequestFullscreen ||
                 el.mozRequestFullScreen || el.msRequestFullscreen;
        if (!fn) {
            log('this browser has no fullscreen API');
            return;
        }
        try {
            var result = fn.call(el);
            if (result && typeof result.catch === 'function') {
                result.catch(log);
            }
        } catch (e) {
            log(e);
        }
    }

    function exit_fullscreen() {
        var fn = doc.exitFullscreen || doc.webkitExitFullscreen ||
                 doc.mozCancelFullScreen || doc.msExitFullscreen;
        if (!fn) {
            return;
        }
        try {
            var result = fn.call(doc);
            if (result && typeof result.catch === 'function') {
                result.catch(log);
            }
        } catch (e) {
            log(e);
        }
    }

    function toggle_fullscreen() {
        if (is_fullscreen()) {
            exit_fullscreen();
        } else {
            request_fullscreen();
        }
    }

    function toggle_full_window() {
        settings.full_window = settings.full_window ? 0 : 1;
        store.set('full_window', settings.full_window);
        position_panels();
    }

    function load_fonts() {
        return new Promise(function (resolve) {
            var done = false;
            function finish() {
                if (!done) {
                    done = true;
                    resolve();
                }
            }
            try {
                if (doc.fonts && doc.fonts.load) {
                    var loaded = doc.fonts.load('20px plane_icons');
                    if (loaded && loaded.then) {
                        loaded.then(finish, finish);
                    } else {
                        finish();
                    }
                } else {
                    finish();
                }
            } catch (e) {
                finish();
            }
            W.setTimeout(finish, 2000);
        });
    }

    /* ---------------------------------------------------------------- *
     * boot                                                               *
     * ---------------------------------------------------------------- */

    function kill_map_timers() {
        W.setInterval = native_set_interval;

        var cleared = 0;
        captured.forEach(function (t) {
            var name = t.fn && t.fn.name;
            if (name === 'updateSlow' || name === 'updateFast') {
                W.clearInterval(t.id);
                cleared += 1;
            }
        });

        if (!cleared && captured.length) {
            // Names did not match (minified or renamed), take all of them.
            captured.forEach(function (t) {
                W.clearInterval(t.id);
            });
        } else if (!captured.length) {
            console.warn('[wtmap] could not find the map\'s own intervals; ' +
                    'check that the script runs at document-start in the page context');
        }
    }

    function boot() {
        if (booted) {
            return;
        }
        booted = true;

        $ = W.jQuery;
        if (!$ || !doc.getElementById('map-canvas')) {
            return;
        }

        kill_map_timers();

        // The map wires up drag/resize with jQuery UI; automatic sizing and
        // the fixed panel layout make that fight the layout, so drop it.
        ['resizable', 'draggable', 'sortable'].forEach(function (name) {
            $.fn[name] = function () {
                return this;
            };
        });

        build_ui();
        add_toggle(state_panel, 'update_state', 'state');
        add_toggle(indicators_panel, 'update_indicators', 'indicators');

        position_panels();
        W.addEventListener('resize', position_panels);
        // Some browsers report the new size only after a frame.
        W.addEventListener('orientationchange', position_panels);

        // Fullscreen can be entered or left from the keyboard, the browser's own
        // menu or Escape, so re-lay out whenever the state changes.
        ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange',
            'MSFullscreenChange'].forEach(function (type) {
            doc.addEventListener(type, position_panels);
        });

        doc.addEventListener('keydown', function (e) {
            if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) {
                return;
            }
            var tag = (e.target && e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select' ||
                (e.target && e.target.isContentEditable)) {
                return;
            }
            if (e.key === 'f' || e.key === 'F') {
                e.preventDefault();
                toggle_fullscreen();
            } else if (e.key === 'm' || e.key === 'M') {
                e.preventDefault();
                toggle_full_window();
            } else if (e.key === 'Escape' && settings.full_window) {
                e.preventDefault();
                settings.full_window = 0;
                store.set('full_window', 0);
                position_panels();
            }
        });

        // Handle for tweaking things from the browser console.
        W.wtmap = {
            settings: settings,
            pollers: pollers,
            save_scale: save_scale,
            reload: reload_settings,
            restart: start_pollers,
            layout: position_panels,
            mode: layout_mode,
            fullscreen: toggle_fullscreen,
            full_window: toggle_full_window
        };

        load_fonts().then(function () {
            start_pollers();
        });
    }

    function log(e) {
        if (W.console && W.console.error) {
            W.console.error('[wtmap]', e);
        }
    }

    /* ---------------------------------------------------------------- *
     * stylesheet (adapted from the extension's main.css)                *
     * ---------------------------------------------------------------- */

    function install_style() {
        if (doc.getElementById('wtm-style')) {
            return;
        }
        var style = doc.createElement('style');
        style.id = 'wtm-style';
        style.textContent = [
            "@font-face { font-family: 'plane_icons';",
            "src: url('data:font/ttf;charset=utf-8;base64,AAEAAAANAIAAAwBQRkZUTWneYmoAAAkUAAAAHEdERUYAMwAGAAAI9AAAACBPUy8yYr1vSQAAAVgAAABWY21hcATbA2AAAAHEAAABSmdhc3D//wADAAAI7AAAAAhnbHlm/NKJ5gAAAyAAAAPsaGVhZASNDJIAAADcAAAANmhoZWEQhwgAAAABFAAAACRobXR4GAD//QAAAbAAAAAUbG9jYQKIAUoAAAMQAAAADm1heHAASQCOAAABOAAAACBuYW1lrXjyGQAABwwAAAGYcG9zdIwxfkYAAAikAAAARgABAAAAAQAAQJGTVl8PPPUACwgAAAAAAM7QX80AAAAAztBfzf/9//sH0AgAAAAACAACAAAAAAAAAAEAAAgA//sAuAgA//0AAAfQAAEAAAAAAAAAAAAAAAAAAAAEAAEAAAAGAIsAAQAAAAAAAgAAAAEAAQAAAEAAAAAAAAAAAQgAAZAABQAIBTMFmQAAAR4FMwWZAAAD1wBmAhIAAAIABQkAAAAAAAAAAAABAAAAAAAAAAAAAAAAUGZFZABAAGEAYwZm/mYAuAgAAAUAAAABAAAAAAAACAAAAAAAAAAIAAAACAAAAAAA//0AAAADAAAAAwAAABwAAQAAAAAARAADAAEAAAAcAAQAKAAAAAYABAABAAIAAABj//8AAAAAAGH//wAA/6IAAQAAAAAAAAAAAQYAAAEAAAAAAAAAAQIAAAACAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADBAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwADAAMAIYBMgH2AAAAAQAAAAAH0AgAAAMAADEhESEH0PgwCAAAAQAA//4H0AceAFIAAAElJjYuAicjNTM1IzUjFSMVMxUjDgEdAQQHDgEeAR8CBRcWFx4BHwEHDgQfAjM3FxY/ARczNzY3NiYvAjY3PgE/AiU3PgQuAQdR/PsBAwgMIRgQBQUSBQUQJiX9w8hCPwQWEA9pAqo3BxMDEgcH1gMJGAsKCRAj1xoKAgIKGtcjBgoKGBER1hwHCA0CAzcCqmoDCxgPAhU7BKs/BU+KiHwZCiYJCSYKKP1ray8QETk7NhERNoE0Fx82tT8/TQIGExIbCy0SOaAICKA5EgsiEioMC03veg4bBgc0gTYDDCQjLicmAAAAAAEAAP/7B9AFlAB0AAABJi8BJi8CNiMnNC4BIgYPAQYjIgYVDwEnJicuAS8BDgQPAic2Iyc0LgEiBg8BBiMiBh0BDwIGBwUOAhQWHwENARIXBQYVFAYeAxcFFDMyNjc1JDc+Ayc1NCYvASYnPgE/AS0BPgI0JicHn81cgYwbDQgBFggCEBwQAQECBgoKAQeGDwoEGQoKBA4bCA0EBIYHARYJAg8cEAEBAwYKCggNpyVc/tYFEBsYDAsBkgHeEBL+1RYBAQIFCwcBPxAHCAEBIB8JCwQCAQsFBtRXCBEEBQHeAZIFEBoYDAP7LRUdDwMBtxUBBRAaFwwMAQsFBaoGrywUHAUEAQcdKG0tLQaqFQEFEBoXDAwBCwUFtwESCBVCAQUbKCYJCU4r/ms5SgcVAhIJEAkIARt4PB4eFgUBCRIIDg0JDgIDMhgZ52dnK04EDScoGgQAAAAAAf/9AAoHzwZAAIoAAAEWFR4BBzIWFxYMARcWFxYVHAEOBgcGBw4BBw4BBw4CBw4BFRwCFQYHBhceAhceAhUUDgIHDgEHDgEdATwBJicuAScuAzU0PgE3PgI3NicmJzU0JicuAicuAScuAScmJy4JNTQ3Njc2LAE3PgEzJjY/ATY3FgQNBRMOAwPbAwIBHwEsDiYbIgMBBgIJAw0CK1Ig1EQ6qg8GMUUXJB0ECQQVBU5eDhkYGA4aFREasRoQDw8QGrEaERUaDhgYGQ5eTgUVBAkEHSQXRTEGD6o6RNQgUisDCgQIAwUBAwEBIhsmDgEsAR8CA9sDAw4TBQMkJAYEFwgYoC0IAQFOUgQJFRojBQkJBQkDCgMOAi0YChQBAQoCAQwQBQcnDwIeIhCeSB4NAy44CA8SKBsUHhIJBQglAwIPBwYDCRACAyUIBQkSHhQbKBIPCDguAw0eSJ5SDycHBRAMAQIKAQEUChgtAwsECAQHBQcHCAUjGhUJBFJOAQEILaAYHyAcHwAAAAwAlgABAAAAAAABAAkAFAABAAAAAAACAAcALgABAAAAAAADACUAggABAAAAAAAEAAgAugABAAAAAAAFAAsA2wABAAAAAAAGAAgA+QADAAEECQABABIAAAADAAEECQACAA4AHgADAAEECQADAEoANgADAAEECQAEABAAqAADAAEECQAFABYAwwADAAEECQAGABAA5wBTAFYARwBGAG8AbgB0ACAAMAAAU1ZHRm9udCAwAABSAGUAZwB1AGwAYQByAABSZWd1bGFyAABGAG8AbgB0AEYAbwByAGcAZQAgADIALgAwACAAOgAgAGYAbwBuAHQAMwA3ADgAMQAgADoAIAAxADMALQAxADIALQAyADAAMQAzAABGb250Rm9yZ2UgMi4wIDogZm9udDM3ODEgOiAxMy0xMi0yMDEzAABmAG8AbgB0ADMANwA4ADEAAGZvbnQzNzgxAABWAGUAcgBzAGkAbwBuACAAMQAuADAAAFZlcnNpb24gMS4wAABmAG8AbgB0ADMANwA4ADEAAGZvbnQzNzgxAAACAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAYAAAABAAIBAgEDAQQHRmlnaHRlcgZCb21iZXIIQXR0YWNrZXIAAAAAAAH//wACAAEAAAAOAAAAGAAAAAAAAgABAAMABQABAAQAAAACAAAAAAABAAAAAMw9os8AAAAAztBfzQAAAADO0F/N') format('truetype'); }",

            "body { margin: 5px; }",

            ".wtm-panel, .wtm-panel * { font-family: Consolas, 'Lucida Console', monospace;",
            "font-size: 11px; color: #aaa; line-height: 21px; white-space: nowrap; }",
            ".wtm-panel { float: left; border-radius: 1px; background: rgba(40, 40, 40, .7);",
            "border: 1px solid #555; border-top-style: none; }",
            ".wtm-panel .wtm-caption { text-indent: .35em; line-height: 21px; height: 21px;",
            "width: 100%; color: #ddd; border-radius: 1px 1px 0 0; overflow: hidden;",
            "background: linear-gradient(#606060, #555); }",
            ".wtm-panel .wtm-caption-title { font-weight: bold; }",
            ".wtm-caption-title:empty { display: none; }",

            "#wtm-map-root { position: relative; border: 1px solid #555;",
            "border-top-style: none; border-radius: 0 0 1px 1px; }",
            "#wtm-map { line-height: 0; }",
            "#map-canvas { display: block; cursor: -webkit-grab; }",
            "#map-canvas:active { cursor: -webkit-grabbing; }",

            "#wtm-mapinfo { float: right; color: #aaa; }",
            "#wtm-mapscale:before { content: 'Scale: '; }",
            "#wtm-mapscale:after { content: '\\00d7'; }",
            "#wtm-mapdimensions:before { content: 'Map: '; }",
            "#wtm-mapgrid:before { content: 'Grid: '; }",
            "#wtm-mapdimensions, #wtm-mapgrid, #wtm-mapscale { margin: 0 .7em; }",

            "#wtm-map-root:after { content: 'Use the mouse wheel to zoom, drag to pan';",
            "position: absolute; top: 100%; right: 0; display: none; color: #888; }",
            "#wtm-map-root:hover:after { display: block; }",

            "#wtm-mapsummary { position: absolute; max-width: 100%; margin-top: 4px;",
            "top: 100%; border-collapse: collapse; line-height: 1em; }",
            "#wtm-mapsummary th { font-family: Icons; font-size: 26px; padding: 0 4px 0 1px;",
            "-webkit-text-stroke-width: 1px; -webkit-text-stroke-color: #000; }",
            "#wtm-mapsummary th.wtm-aircraft { font-family: plane_icons; }",
            "#wtm-mapsummary td { font-size: 11px; }",
            "#wtm-redrow th { color: #e70000; }",
            "#wtm-bluerow th { color: #145cff; }",

            "#wtm-sidepanels { position: absolute; top: 5px; }",
            "#wtm-sidepanels .wtm-panel { margin: 0 5px 5px 0; }",
            ".wtm-panel.off .wtm-panel-contents { display: none; }",
            ".wtm-toggle { float: right; white-space: nowrap; padding-left: 1em; }",
            ".wtm-toggle input { margin: 0 5px 0 3px; position: relative; top: 2px; }",
            ".wtm-toggle label { position: relative; top: 2px; }",
            ".wtm-icon { cursor: pointer; font-size: 13px; line-height: 15px;",
            "padding: 0 5px; margin: 2px 0 0 3px; color: #ccc; background: #4a4a4a;",
            "border: 1px solid #666; border-radius: 2px; vertical-align: middle; }",
            ".wtm-icon:hover { background: #5a5a5a; color: #fff; }",
            ".wtm-icon.on { background: #2b6cb0; border-color: #4a90d9; color: #fff; }",
            ".wtm-buttons { display: flex; gap: 3px; }",

            "table.wtm-data { width: 300px; border-collapse: collapse;",
            "table-layout: fixed; position: relative; }",
            "table.wtm-data th, table.wtm-data td { border-color: rgba(255, 255, 255, .035);",
            "border-style: none; border-width: 1px; text-align: left; padding: 0 .35em;",
            "line-height: 1.5em; overflow: hidden; text-overflow: ellipsis; }",
            "table.wtm-data th { border-bottom-style: solid; }",
            "table.wtm-data td { border-left-style: solid; border-bottom-style: solid; }",
            "table.wtm-data tr:first-child th, table.wtm-data tr:first-child td {",
            "border-top-style: none; }",
            "table.wtm-data tr:last-child th, table.wtm-data tr:last-child td {",
            "border-bottom-style: none; }",
            "table.wtm-data tr { cursor: pointer; }",
            "table.wtm-data tr:hover, table.wtm-data tr.hl { background: rgba(255, 255, 255, .05); }",
            "table.wtm-data tr.hl th, table.wtm-data tr.hl td { color: #ddd; }",
            "table.wtm-data tr.hl td { font-size: 2em; }",
            "table.wtm-data:after { display: none; content: 'Click rows to highlight';",
            "position: absolute; top: 100%; left: 0; color: #888; }",
            "table.wtm-data:hover:after { display: block; }",

            "#wtm-options { display: none; position: fixed; top: 0; right: 0; bottom: 0;",
            "left: 0; z-index: 1000; background: rgba(0, 0, 0, .6); }",
            "#wtm-options-inner { position: absolute; top: 50%; left: 50%;",
            "transform: translate(-50%, -50%); width: 460px; padding: 15px 20px;",
            "background: #3a3a3a; color: #ddd; border: 1px solid #666; border-radius: 3px;",
            "box-shadow: 0 5px 30px rgba(0, 0, 0, .5); }",
            "#wtm-options-inner h2 { margin: 0 0 12px; font-size: 15px; font-weight: normal;",
            "border-bottom: 1px solid #555; padding-bottom: 6px; }",
            "#wtm-options-inner table { border-collapse: collapse; }",
            "#wtm-options-inner td { padding: 3px 8px 3px 0; white-space: nowrap;",
            "font-size: 12px; }",
            "#wtm-options-inner .input_number { width: 4em; }",
            "#wtm-options-inner label { position: relative; top: -1px; }",
            "#wtm-options-inner .wtm-note { color: #888; font-size: 11px; padding-left: 8px; }",
            "#wtm-plane_icon_preview { font-family: plane_icons; color: #e33;",
            "position: absolute; white-space: nowrap; letter-spacing: .1em; }",
            "#wtm-options-buttons { margin: 15px 0 0; }",
            "#wtm-options-buttons button { cursor: pointer; position: relative; top: -1px; }",
            "#wtm-status { color: #8f8; padding-left: 10px; }",

            /* --- layout modes ---------------------------------------------------- */
            "body.wtm-fullscreen-mode { overflow: hidden; }",
            "body.wtm-mode-hidden #wtm-sidepanels,",
            "body.wtm-mode-window #wtm-sidepanels { display: none; }",
            "body.wtm-mode-overlay #wtm-sidepanels { position: fixed; top: 30px;",
            "right: 8px; left: auto; z-index: 30; width: 305px;",
            "max-height: calc(100% - 40px); overflow: auto; opacity: .92; }",
            "body.wtm-mode-overlay #wtm-sidepanels:hover { opacity: 1; }",
            "body.wtm-mode-overlay .wtm-panel,",
            "body.wtm-mode-overlay .wtm-adopted { background: rgba(20, 20, 20, .8); }",
            "body.wtm-mode-window #wtm-map-root { border: none; }",
            "body.wtm-mode-window { margin: 0; }",
            "body.wtm-mode-window #wtm-map-root:after,",
            "body.wtm-mode-overlay #wtm-map-root:after,",
            "body.wtm-mode-hidden #wtm-map-root:after { display: none !important; }",
            "body.wtm-mode-window #wtm-map,",
            "body.wtm-mode-overlay #wtm-map,",
            "body.wtm-mode-hidden #wtm-map { line-height: 0; }",
            /* no room is reserved for the summary in these modes, so it floats
               over the bottom of the map instead */
            "body.wtm-mode-window #wtm-mapsummary,",
            "body.wtm-mode-overlay #wtm-mapsummary,",
            "body.wtm-mode-hidden #wtm-mapsummary { position: fixed; top: auto;",
            "left: 8px; bottom: 8px; margin: 0; padding: 2px 5px;",
            "background: rgba(40, 40, 40, .75); border-radius: 2px; z-index: 25; }",
            /* the caption stays reachable so the modes can be left again */
            "body.wtm-mode-window #wtm-map-root,",
            "body.wtm-mode-overlay #wtm-map-root { z-index: 10; }",

            "#map-root, #indicators-root, #state-root { display: none !important; }",
            "#draghandle { cursor: default !important; }",

            ".wtm-adopted { position: static !important; float: left; width: 300px !important;",
            "height: auto !important; max-height: 152px; margin: 0 5px 5px 0;",
            "background: rgba(40, 40, 40, .7); overflow: hidden;",
            "border: 1px solid #555; border-top-style: none; }",
            ".wtm-adopted .caption { display: block; height: 21px; line-height: 21px;",
            "overflow: hidden; color: #ddd; background: linear-gradient(#606060, #555);",
            "text-indent: .35em; }",
            "#wtm-sidepanels .wtm-adopted #draghandle { display: none; }",
            ".wtm-adopted #textlines { overflow: auto; width: 100%; height: 128px;",
            "font-size: 11px; line-height: 1.4em; }",
            ".wtm-adopted .chat-line { white-space: normal; }",
            ".wtm-adopted #objectives-primary, .wtm-adopted #objectives-secondary {",
            "overflow: auto; max-height: 128px; padding: 0 4px; }",
            ".wtm-adopted h3 { font-size: 11px; font-weight: bold; color: #999;",
            "margin: 3px 0 3px 6px; }",
            ".wtm-adopted div.objective { font-size: 11px; color: #ddd; line-height: 1.4em;",
            "white-space: normal; padding: 0 2px; }"
        ].join('\n');

        (doc.head || doc.documentElement).appendChild(style);
    }

    function ready() {
        // The map has no <head> to attach a stylesheet to before parsing starts,
        // and this may run before documentElement even exists.
        if (doc.documentElement) {
            install_style();
        }

        // Patch before the map's init() runs on window load: init() calls
        // addWheelHandler() and the jQuery UI plugins, and registers the two
        // intervals that are cleared in boot().
        patch_map_code();
        if (W.jQuery && W.jQuery.fn) {
            ['resizable', 'draggable', 'sortable'].forEach(function (name) {
                W.jQuery.fn[name] = function () {
                    return this;
                };
            });
        }

        if (doc.readyState === 'complete') {
            boot();
        } else {
            W.addEventListener('load', boot);
        }
    }

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', ready);
    } else {
        ready();
    }
})();
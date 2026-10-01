// ==UserScript==
// @name         WT map
// @namespace    https://github.com/gchaviaras/wtmap
// @version      1.0.0
// @description  Enhances the War Thunder browser map: aircraft get a silhouette and a heading, off-map contacts are pinned to the edge, the map follows the player, updates are near real-time, and there is a per-team contact summary, distance readouts in the title bar, optional state/indicator tables, and fullscreen or full window layouts.
// @author       gchaviaras
// @match        http://localhost:8111/*
// @match        http://127.0.0.1:8111/*
// @include      http://*:8111/*
// @grant        none
// @run-at       document-start
// @inject-into  page
// @noframes
// ==/UserScript==

/*
 * How this works: the script runs in the page's own JavaScript environment at
 * document-start, so it can reach the functions the map defines, patch them
 * where they already live, and take over the two timers the map starts.
 *
 * Everything the page defines with `var`/`function` lives on `window`, so all
 * patches go through `W.*`. Nothing is declared globally by this script.
 *
 * No third party code or artwork is bundled: the aircraft shapes are polygons
 * further down, and the only font used is the map's own icon font, which the
 * page already loads by itself.
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
        icon_edge: 'shadow',      // how contact icons are edged, see EDGE_MODES
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

    // How contact icons are edged on the map. A thick edge swallows the fill
    // on shapes as thin as an aircraft wing, so a one pixel shadow is the
    // default; the outline weights are in canvas pixels.
    var EDGE_MODES = {
        none: 1,      // flat colour
        thin: 1,      // hairline edge
        both: 1,      // hairline edge and shadow
        shadow: 1,    // shadow only, the default
        outline: 1    // the heavier edge, as it was
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
        if (!(settings.icon_edge in EDGE_MODES)) {
            settings.icon_edge = DEFAULTS.icon_edge;
        }
        settings.full_window = settings.full_window ? 1 : 0;
    })();

    /* ---------------------------------------------------------------- *
     * icons                                                              *
     * ---------------------------------------------------------------- */

    /* ---------------------------------------------------------------- *
     * aircraft silhouettes                                             *
     *                                                                    *
     * Three top-down outlines, authored here as SVG path data in a -1..1  *
     * space with the nose towards -y (north). They are drawn to be told   *
     * apart at a glance, which is all a map icon has to do.                *
     *                                                                    *
     * Each entry is one side of the aircraft. The other side is the same   *
     * path mirrored about x = 0, and `d` is the same string for the canvas *
     * (through Path2D) and for the summary table's inline SVG. The three   *
     * types differ by wing position, span, tail and the details that make  *
     * them identifiable: a propeller disc on the single-engine types, an   *
     * engine nacelle and twin fins on the bomber.                          *
     * ---------------------------------------------------------------- */

    var AIRCRAFT = {
        // slim fuselage, mid wing, propeller disc, small tail
        Fighter: {
            d: 'M0,-1 Q0.03,-0.94 0.05,-0.86 L0.06,-0.40 L0.84,0.00 ' +
               'Q0.92,0.04 0.92,0.10 L0.90,0.18 L0.06,0.08 L0.055,0.50 ' +
               'L0.28,0.68 Q0.32,0.72 0.31,0.78 L0.28,0.84 L0.03,0.79 ' +
               'Q0,0.78 0,0.76 Z',
            lines: ['M-0.24,-0.74 L0.24,-0.74']
        },
        // long fuselage, wide wing set aft, nacelle and twin fins
        Bomber: {
            d: 'M0,-1 Q0.04,-0.93 0.07,-0.84 L0.10,-0.34 L0.96,0.06 ' +
               'Q1.00,0.10 1.00,0.16 L0.98,0.26 L0.10,0.16 L0.085,0.58 ' +
               'L0.42,0.74 Q0.46,0.78 0.45,0.85 L0.42,0.90 L0.03,0.85 ' +
               'Q0,0.84 0,0.82 Z',
            extra: [
                'M0.26,0.08 L0.40,0.08 Q0.42,0.14 0.40,0.20 L0.26,0.20 ' +
                    'Q0.24,0.14 0.26,0.08 Z',
                'M0.30,0.58 L0.40,0.58 L0.42,1.00 L0.32,1.00 Z'
            ]
        },
        // stubby, thick wing set forward, propeller disc, tiny tail
        Assault: {
            d: 'M0,-1 Q0.06,-0.92 0.11,-0.82 L0.13,-0.24 L0.74,-0.08 ' +
               'Q0.80,-0.05 0.80,0.01 L0.78,0.10 L0.13,0.06 L0.11,0.44 ' +
               'L0.24,0.58 Q0.27,0.62 0.26,0.67 L0.23,0.72 L0.04,0.68 ' +
               'Q0,0.67 0,0.65 Z',
            lines: ['M-0.30,-0.68 L0.30,-0.68']
        }
    };

    var PLANE_ORDER = ['Fighter', 'Bomber', 'Assault'];

    // How big each type is drawn relative to the configured icon size.
    var PLANE_SCALE = {
        Fighter: 1.00,
        Bomber: 1.10,
        Assault: 1.02
    };

    // The outline is centred on the origin and spans two units nose to tail,
    // so these turn a pixel size into the transforms and the viewBox.
    var PLANE_BOX = 1.15;          // viewBox half size, a little air around it

    function is_plane(icon) {
        return icon in AIRCRAFT;
    }

    var EDGE_SHADOW = 1;          // shadow offset in canvas pixels

    function edge_style() {
        switch (settings.icon_edge) {
        case 'none':
            return {edge: 0, shadow: 0};
        case 'thin':
            return {edge: 0.5, shadow: 0};
        case 'both':
            return {edge: 0.5, shadow: EDGE_SHADOW};
        case 'outline':
            return {edge: 1.5, shadow: 0};
        default:
            return {edge: 0, shadow: EDGE_SHADOW};
        }
    }

    function shadow_colour(alpha) {
        return 'rgba(0,0,0,' + (0.85 * (alpha || 1)) + ')';
    }

    // One side of the aircraft: the body outline plus any added shapes.
    function plane_bodies(kind) {
        var spec = AIRCRAFT[kind];
        return [spec.d].concat(spec.extra || []);
    }

    // The same paths as an inline SVG, with the same edge the canvas uses.
    // Both halves are always emitted: the canvas mirrors by scaling, the SVG by
    // a transform, so neither renderer can forget a wing.
    function plane_svg(kind, size) {
        var scale = PLANE_SCALE[kind] || 1;
        var style = edge_style();
        var px = Math.max(4, Math.round(size * scale * PLANE_BOX));
        // The viewBox spans 2 * PLANE_BOX units and is `px` pixels wide.
        var per_pixel = (2 * PLANE_BOX) / px;
        var edge = (style.edge * per_pixel).toFixed(3);
        var offset = (style.shadow * per_pixel).toFixed(3);

        var svg = '<svg viewBox="' + (-PLANE_BOX) + ' ' + (-PLANE_BOX) + ' ' +
                  (2 * PLANE_BOX) + ' ' + (2 * PLANE_BOX) + '" width="' + px +
                  '" height="' + px + '">';

        // All the shadows first, so none of them lands on top of a fill.
        if (style.shadow) {
            // note the closing quote: without it the attribute never closes and
            // the parser swallows every path that follows
            var shadow_attrs = ' style="fill:#000;stroke:none" transform="translate(' +
                offset + ' ' + offset + ')"';
            plane_bodies(kind).forEach(function (d) {
                svg += path_element(d, shadow_attrs);
                svg += path_element(d, shadow_attrs + ' scale(-1,1)');
            });
        }

        var body_attrs = ' stroke-width="' + edge + '"';
        plane_bodies(kind).forEach(function (d) {
            svg += path_element(d, body_attrs);
            svg += path_element(d, body_attrs + ' transform="scale(-1,1)"');
        });

        // The propeller disc is a detail rather than an edge, so it stays dark
        // whichever edge is chosen.
        var detail = (Math.max(0.6, style.edge || 0.5) * per_pixel).toFixed(3);
        (AIRCRAFT[kind].lines || []).forEach(function (d) {
            svg += '<path class="wtm-detail" d="' + d + '" stroke-width="' +
                   detail + '"/>';
        });

        return svg + '</svg>';
    }

    function path_element(d, attrs) {
        return '<path d="' + d + '"' + attrs + '/>';
    }

    var _plane_path_cache = {};

    function plane_path(kind) {
        if (!_plane_path_cache[kind]) {
            _plane_path_cache[kind] = new W.Path2D(
                plane_bodies(kind).join(' '));
        }
        return _plane_path_cache[kind];
    }

    function draw_plane(ctx, kind, sx, sy, dir, fill, alpha, size) {
        var style = edge_style();
        var scale = size / 2 * (PLANE_SCALE[kind] || 1);

        ctx.save();
        ctx.translate(sx, sy);
        if (dir) {
            ctx.rotate(dir);
        }
        ctx.scale(scale, scale);
        // Line widths and offsets from here on are in the -1..1 space.
        var edge = style.edge / scale;
        var path = plane_path(kind);

        // Both halves, painted from a shadow behind to the fill on top.
        [1, -1].forEach(function (side) {
            ctx.save();
            ctx.scale(side, 1);
            if (style.shadow) {
                ctx.shadowColor = shadow_colour(alpha);
                ctx.shadowOffsetX = style.shadow / scale;
                ctx.shadowOffsetY = style.shadow / scale;
                ctx.shadowBlur = 0;
                ctx.fillStyle = alpha ? hex_to_rgba(fill, alpha) : fill;
                ctx.fill(path);
                ctx.shadowColor = 'transparent';
            }
            if (edge > 0) {
                ctx.lineJoin = 'round';
                ctx.lineWidth = edge;
                ctx.strokeStyle = 'rgba(0,0,0,' + (alpha || 1) + ')';
                ctx.stroke(path);
            }
            ctx.fillStyle = alpha ? hex_to_rgba(fill, alpha) : fill;
            ctx.fill(path);
            ctx.restore();
        });

        // The propeller disc reads as a detail rather than an edge, so it stays
        // dark whichever edge is chosen.
        (AIRCRAFT[kind].lines || []).forEach(function (d) {
            ctx.save();
            ctx.lineWidth = Math.max(0.6, style.edge || 0.5) / scale;
            ctx.strokeStyle = 'rgba(0,0,0,' + (alpha || 1) + ')';
            ctx.stroke(new W.Path2D(d));
            ctx.restore();
        });

        ctx.restore();
    }

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

    // Aircraft are drawn as artwork, everything else uses a glyph from the
    // map's own icon font so the summary matches what is on the map.
    function icon_glyph(icon) {
        if (is_plane(icon)) {
            return '';
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

    var _orig_draw_map_object = null;   // the map's own glyph drawing
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

    // The map draws its own glyphs (tanks, structures, capture zones) with a
    // hardcoded 1px black stroke. Rather than copy its glyph, font and rotation
    // code, intercept the two text calls it makes and edge them the same way as
    // the aircraft. With the heavier edge the map's own setting is left alone.
    function draw_map_glyph(canvas, ctx, item, rotate) {
        // 'outline' is the map's own look, so leave it alone. Every other
        // option needs the interception, 'none' included: suppressing the
        // stroke is only possible by not letting the map draw it.
        var style = edge_style();
        if (settings.icon_edge === 'outline') {
            return _orig_draw_map_object.apply(this, arguments);
        }

        var fill_text = ctx.fillText;
        var stroke_text = ctx.strokeText;

        ctx.fillText = function (text, x, y) {
            if (style.shadow) {
                ctx.shadowColor = shadow_colour();
                ctx.shadowOffsetX = style.shadow;
                ctx.shadowOffsetY = style.shadow;
                ctx.shadowBlur = 0;
            }
            fill_text.call(ctx, text, x, y);
            ctx.shadowColor = 'transparent';
        };
        ctx.strokeText = function (text, x, y) {
            if (style.edge > 0) {
                ctx.lineWidth = style.edge * 2;
                ctx.strokeStyle = '#000';
                stroke_text.call(ctx, text, x, y);
            }
        };

        try {
            return _orig_draw_map_object.apply(this, arguments);
        } finally {
            ctx.fillText = fill_text;
            ctx.strokeText = stroke_text;
        }
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

        // --- aircraft artwork, and the map's own glyphs with the same edge ---
        _orig_draw_map_object = W.draw_map_object;
        W.draw_map_object = function (canvas, ctx, item, rotate) {
            if (item.type !== 'aircraft' || !(_canvas && _canvas.width)) {
                return draw_map_glyph.call(this, canvas, ctx, item, rotate);
            }

            var sx = item.x * _canvas.width * W.map_scale + W.map_pan[0];
            var sy = item.y * _canvas.height * W.map_scale + W.map_pan[1];

            if (!is_plane(item.icon)) {
                // An aircraft type we have no artwork for: the map draws it, but
                // still with the chosen edge.
                return draw_map_glyph.call(this, canvas, ctx, item, rotate);
            }

            var dx = +item.dx;
            var dy = +item.dy;
            var dir = isFinite(dx) && isFinite(dy) ? Math.atan2(dx, -dy) : 0;

            var color = W.calcMapObjectColor(item);
            var offscreen = sx > _canvas.width || sx < 0 ||
                            sy > _canvas.height || sy < 0;

            if (offscreen) {
                var pos = clamp_to_edge(sx, sy, _canvas.width, _canvas.height, 12);
                sx = pos.x;
                sy = pos.y;
            }

            draw_plane(ctx, item.icon, sx, sy, dir, color,
                    offscreen ? '0.35' : null, settings.plane_icon_size);
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
    var SUMMARY_ICON_SIZE = 21;   // aircraft artwork in the summary table
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
                th.title = icon;
                if (counts[team]) {
                    if (is_plane(icon)) {
                        th.className = 'wtm-aircraft';
                        th.innerHTML = plane_svg(icon, SUMMARY_ICON_SIZE);
                    } else {
                        th.textContent = glyph;
                    }
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
                '<tr><td><label for="opt_icon_edge">Icon edge</label></td>' +
                '<td><select id="opt_icon_edge">' +
                '<option value="shadow">Shadow only</option>' +
                '<option value="thin">Thin outline</option>' +
                '<option value="both">Thin outline and shadow</option>' +
                '<option value="none">None</option>' +
                '<option value="outline">Heavy outline</option>' +
                '</select></td></tr>' +
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

        var preview = PLANE_ORDER.map(function (kind) {
            var $slot = $('<span class="wtm-preview" data-plane="' + kind + '"></span>')
                .attr('title', kind)
                .appendTo('#wtm-plane_icon_preview');
            $slot.html(plane_svg(kind, DEFAULTS.plane_icon_size));
            return $slot;
        });

        $('#opt_icon_size').on('input', function () {
            var size = parseFloat($(this).val()) || DEFAULTS.plane_icon_size;
            preview.forEach(function ($slot) {
                $slot.html(plane_svg($slot.attr('data-plane'), size));
            });
        });

        $('#opt_icon_edge').change(function () {
            settings.icon_edge = $(this).val();
            preview.forEach(function ($slot) {
                $slot.html(plane_svg($slot.attr('data-plane'),
                    parseFloat($('#opt_icon_size').val()) || DEFAULTS.plane_icon_size));
            });
        });

        $('#wtm-save').click(function () {
            store.set('plane_icon_size', num_range('#opt_icon_size', DEFAULTS.plane_icon_size, 8, 80));
            store.set('icon_edge', $('#opt_icon_edge').val() || DEFAULTS.icon_edge);
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
        $('#opt_icon_edge').val(settings.icon_edge);
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
        if (!(settings.icon_edge in EDGE_MODES)) {
            settings.icon_edge = DEFAULTS.icon_edge;
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

        start_pollers();
    }

    function log(e) {
        if (W.console && W.console.error) {
            W.console.error('[wtmap]', e);
        }
    }

    /* ---------------------------------------------------------------- *
     * stylesheet                                                         *
     *                                                                    *
     * Written for this script: a dark caption bar over the map, a column  *
     * of panels beside it, and a couple of layout modes for fullscreen.   *
     * The map's own page stylesheet is left alone; these rules are scoped  *
     * to the panel ids and classes this script creates.                   *
     * ---------------------------------------------------------------- */

    function install_style() {
        if (doc.getElementById('wtm-style')) {
            return;
        }
        var style = doc.createElement('style');
        style.id = 'wtm-style';
        style.textContent = [
            "body { margin: 5px; }",

            /* --- panels ------------------------------------------------ */
            ".wtm-panel, .wtm-panel * {",
            "  font: 11px/21px Consolas, 'Lucida Console', monospace;",
            "  color: #aaa; white-space: nowrap;",
            "}",
            ".wtm-panel {",
            "  float: left; box-sizing: border-box;",
            "  background: rgba(40, 40, 40, .75);",
            "  border: 1px solid #555; border-top: none;",
            "}",
            ".wtm-panel .wtm-caption {",
            "  height: 21px; overflow: hidden; text-indent: .35em;",
            "  color: #ddd; font-weight: bold;",
            "  background: linear-gradient(#606060, #555);",
            "}",
            ".wtm-panel.off .wtm-panel-contents { display: none; }",

            /* --- map panel --------------------------------------------- */
            "#wtm-map-root { position: relative; }",
            "#wtm-map-root:after {",
            "  content: 'Use the mouse wheel to zoom, drag to pan';",
            "  position: absolute; top: 100%; right: 0;",
            "  display: none; color: #888;",
            "}",
            "#wtm-map-root:hover:after { display: block; }",
            "#wtm-map { line-height: 0; }",
            "#map-canvas { display: block; cursor: -webkit-grab; }",
            "#map-canvas:active { cursor: -webkit-grabbing; }",
            "#wtm-mapinfo { float: right; font-weight: normal; }",
            "#wtm-mapscale:before { content: 'Scale: '; }",
            "#wtm-mapscale:after { content: '\\00d7'; }",
            "#wtm-mapdimensions:before { content: 'Map: '; }",
            "#wtm-mapgrid:before { content: 'Grid: '; }",
            "#wtm-mapdimensions, #wtm-mapgrid, #wtm-mapscale { margin: 0 .7em; }",

            /* --- buttons ----------------------------------------------- */
            ".wtm-buttons { display: flex; gap: 3px; float: right; }",
            ".wtm-toggle { float: right; padding-left: 1em; }",
            ".wtm-toggle input { margin: 0 5px 0 3px; position: relative; top: 2px; }",
            ".wtm-toggle label { position: relative; top: 2px; }",
            ".wtm-icon {",
            "  cursor: pointer; vertical-align: middle;",
            "  margin: 3px 0 0 3px; padding: 0 5px;",
            "  font: 13px/15px sans-serif; color: #ccc;",
            "  background: #4a4a4a; border: 1px solid #666; border-radius: 2px;",
            "}",
            ".wtm-icon:hover { background: #5a5a5a; color: #fff; }",
            ".wtm-icon.on { background: #2b6cb0; border-color: #4a90d9; color: #fff; }",

            /* --- contact summary under the map ------------------------- */
            "#wtm-mapsummary {",
            "  position: absolute; top: 100%; left: 0; margin-top: 4px;",
            "  border-collapse: collapse; line-height: 1em;",
            "}",
            "#wtm-mapsummary th {",
            "  font-family: Icons; font-size: 26px; font-weight: normal;",
            "  padding: 0 4px 0 1px;",
            "  -webkit-text-stroke-width: 1px; -webkit-text-stroke-color: #000;",
            "}",
            "#wtm-mapsummary td { font-size: 11px; padding: 0; }",
            "#wtm-mapsummary svg { display: block; }",
            /* The panel rule above gives every descendant an explicit colour, so
               currentColor would resolve to grey. Name the row colours here. */
            "#wtm-bluerow th.wtm-aircraft svg,",
            "#wtm-bluerow th.wtm-aircraft svg path { fill: #145cff; }",
            "#wtm-redrow th.wtm-aircraft svg,",
            "#wtm-redrow th.wtm-aircraft svg path { fill: #e70000; }",
            "#wtm-mapsummary svg path { stroke: #000; stroke-linejoin: round; }",
            "#wtm-bluerow th { color: #145cff; }",
            "#wtm-redrow th { color: #e70000; }",

            /* --- side panels ------------------------------------------- */
            "#wtm-sidepanels { position: absolute; top: 5px; }",
            "#wtm-sidepanels > * { margin: 0 5px 5px 0; }",
            "table.wtm-data {",
            "  width: 300px; border-collapse: collapse; table-layout: fixed;",
            "  position: relative;",
            "}",
            "table.wtm-data th, table.wtm-data td {",
            "  border: 1px solid rgba(255, 255, 255, .035); border-top: none;",
            "  padding: 0 .35em; line-height: 1.5em;",
            "  text-align: left; overflow: hidden; text-overflow: ellipsis;",
            "}",
            "table.wtm-data tr:first-child th, table.wtm-data tr:first-child td {",
            "  border-top: none;",
            "}",
            "table.wtm-data tr { cursor: pointer; }",
            "table.wtm-data tr:hover, table.wtm-data tr.hl {",
            "  background: rgba(255, 255, 255, .05);",
            "}",
            "table.wtm-data tr.hl th, table.wtm-data tr.hl td { color: #ddd; }",
            "table.wtm-data tr.hl td { font-size: 2em; }",
            "table.wtm-data:after {",
            "  content: 'Click rows to highlight'; display: none;",
            "  position: absolute; top: 100%; left: 0; color: #888;",
            "}",
            "table.wtm-data:hover:after { display: block; }",

            /* --- the map's own panels, restyled to match ---------------- */
            "#map-root, #indicators-root, #state-root { display: none !important; }",
            "#draghandle { cursor: default !important; }",
            ".wtm-adopted {",
            "  position: static !important; float: left;",
            "  width: 300px !important; height: auto !important; max-height: 152px;",
            "  margin: 0 5px 5px 0; overflow: hidden;",
            "  background: rgba(40, 40, 40, .75);",
            "  border: 1px solid #555; border-top: none;",
            "}",
            ".wtm-adopted .caption {",
            "  display: block; height: 21px; line-height: 21px; overflow: hidden;",
            "  text-indent: .35em; color: #ddd; font-weight: bold;",
            "  background: linear-gradient(#606060, #555);",
            "}",
            ".wtm-adopted .wtm-caption-title { font-weight: bold; }",
            "#wtm-sidepanels .wtm-adopted #draghandle { display: none; }",
            ".wtm-adopted #textlines {",
            "  overflow: auto; width: 100%; height: 128px;",
            "  font-size: 11px; line-height: 1.4em;",
            "}",
            ".wtm-adopted .chat-line { white-space: normal; }",
            ".wtm-adopted #objectives-primary, .wtm-adopted #objectives-secondary {",
            "  overflow: auto; max-height: 128px; padding: 0 4px;",
            "}",
            ".wtm-adopted h3 {",
            "  margin: 3px 0 3px 6px; color: #999;",
            "  font-size: 11px; font-weight: bold;",
            "}",
            ".wtm-adopted div.objective {",
            "  padding: 0 2px; color: #ddd;",
            "  font-size: 11px; line-height: 1.4em; white-space: normal;",
            "}",

            /* --- options dialog ---------------------------------------- */
            "#wtm-options {",
            "  display: none; position: fixed; top: 0; right: 0; bottom: 0; left: 0;",
            "  z-index: 1000; background: rgba(0, 0, 0, .6);",
            "}",
            "#wtm-options-inner {",
            "  position: absolute; top: 50%; left: 50%;",
            "  transform: translate(-50%, -50%);",
            "  width: 470px; padding: 15px 20px;",
            "  background: #3a3a3a; color: #ddd;",
            "  border: 1px solid #666; border-radius: 3px;",
            "  box-shadow: 0 5px 30px rgba(0, 0, 0, .5);",
            "}",
            "#wtm-options-inner h2 {",
            "  margin: 0 0 12px; padding-bottom: 6px;",
            "  font-size: 15px; font-weight: normal;",
            "  border-bottom: 1px solid #555;",
            "}",
            "#wtm-options-inner table { border-collapse: collapse; }",
            "#wtm-options-inner td {",
            "  padding: 3px 8px 3px 0; white-space: nowrap; font-size: 12px;",
            "}",
            "#wtm-options-inner .input_number { width: 4em; }",
            "#wtm-options-inner label { position: relative; top: -1px; }",
            "#wtm-options-inner .wtm-note { padding-left: 8px; color: #888; font-size: 11px; }",
            "#wtm-plane_icon_preview { display: inline-block; padding-left: 10px; }",
            "#wtm-plane_icon_preview .wtm-preview { display: inline-block; }",
            "#wtm-plane_icon_preview svg { fill: #e33; display: block; }",
            "#wtm-plane_icon_preview svg path { stroke: #000; stroke-linejoin: round; }",
            "#wtm-options-buttons { margin: 15px 0 0; }",
            "#wtm-options-buttons button { position: relative; top: -1px; cursor: pointer; }",
            "#wtm-status { padding-left: 10px; color: #8f8; }",

            /* --- layout modes ------------------------------------------ */
            "body.wtm-fullscreen-mode { overflow: hidden; }",
            "body.wtm-mode-hidden #wtm-sidepanels,",
            "body.wtm-mode-window #wtm-sidepanels { display: none; }",
            "body.wtm-mode-overlay #wtm-sidepanels {",
            "  position: fixed; top: 30px; right: 8px; left: auto; z-index: 30;",
            "  width: 305px; max-height: calc(100% - 40px); overflow: auto; opacity: .92;",
            "}",
            "body.wtm-mode-overlay #wtm-sidepanels:hover { opacity: 1; }",
            "body.wtm-mode-overlay .wtm-panel,",
            "body.wtm-mode-overlay .wtm-adopted { background: rgba(20, 20, 20, .85); }",
            "body.wtm-mode-window { margin: 0; }",
            "body.wtm-mode-window #wtm-map-root,",
            "body.wtm-mode-overlay #wtm-map-root { z-index: 10; }",
            "body.wtm-mode-window #wtm-map-root,",
            "body.wtm-mode-overlay #wtm-map-root,",
            "body.wtm-mode-hidden #wtm-map-root { border: none; }",
            "body.wtm-mode-window #wtm-map-root:after,",
            "body.wtm-mode-overlay #wtm-map-root:after,",
            "body.wtm-mode-hidden #wtm-map-root:after { display: none !important; }",
            /* no room is reserved for the summary in these modes, so it floats */
            "body.wtm-mode-window #wtm-mapsummary,",
            "body.wtm-mode-overlay #wtm-mapsummary,",
            "body.wtm-mode-hidden #wtm-mapsummary {",
            "  position: fixed; top: auto; left: 8px; bottom: 8px; z-index: 25;",
            "  margin: 0; padding: 2px 5px;",
            "  background: rgba(40, 40, 40, .75); border-radius: 2px;",
            "}"
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
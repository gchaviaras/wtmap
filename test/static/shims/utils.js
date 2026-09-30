/* Stand-in for the map page's utils.js: the handful of maths helpers it calls. */
(function (global) {
    function clamp(value, min, max) {
        return value < min ? min : (value > max ? max : value);
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    // Exponential smoothing towards a target, used for the player arrow and the
    // gun bearing. Matches the map's usage: approach(previous, current, dt, tau).
    function approach(target, value, dt, tau) {
        return target + (value - target) * Math.exp(-dt / (tau || 0.5));
    }

    function rgb_to_hex(r, g, b) {
        function hex(v) {
            var s = clamp(Math.round(v), 0, 255).toString(16);
            return s.length < 2 ? '0' + s : s;
        }
        return '#' + hex(r) + hex(g) + hex(b);
    }

    global.clamp = clamp;
    global.lerp = lerp;
    global.approach = approach;
    global.rgb_to_hex = rgb_to_hex;
})(window);
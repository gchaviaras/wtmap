/* Stand-in for the map page's sylvester.src.js.
 *
 * The map only uses a two element vector: $V([x, y]) with at(), rotate(),
 * .elements and signedAngle2DFrom(). Real Sylvester accepts a Vector or a bare
 * [x, y] wherever an origin is expected, so both are accepted here too.
 *
 * Dropped in only when test/asset/ has no real copy, i.e. when the fixture runs
 * without a game to capture from. See test/capture.py.
 */
(function (global) {
    function Sylvester() {}

    Sylvester.zero = function () {
        return new Sylvester.Vector(0, 0);
    };

    Sylvester.Vector = function (x, y) {
        if (arguments.length === 0) {
            return Sylvester.zero();
        }
        if (arguments.length === 1) {
            // Either another Vector (has .elements) or a bare [x, y].
            var src = x.elements || x;
            return new Sylvester.Vector(src[0], src[1]);
        }
        this.elements = [x, y];
    };

    Sylvester.Vector.prototype.at = function (i) {
        return this.elements[i];
    };

    Sylvester.Vector.prototype.rotate = function (theta, o) {
        o = (o && o.elements) || o || Sylvester.zero();
        var x = this.elements[0] - o[0];
        var y = this.elements[1] - o[1];
        this.elements[0] = x * Math.cos(theta) - y * Math.sin(theta) + o[0];
        this.elements[1] = x * Math.sin(theta) + y * Math.cos(theta) + o[1];
        return this;
    };

    Sylvester.Vector.prototype.signedAngle2DFrom = function (v) {
        var a = Math.atan2(this.elements[1], this.elements[0]);
        var b = Math.atan2(v.elements[1], v.elements[0]);
        var d = a - b;
        while (d > Math.PI) { d -= 2 * Math.PI; }
        while (d < -Math.PI) { d += 2 * Math.PI; }
        return d;
    };

    global.Sylvester = Sylvester;

    global.$V = function (a) {
        if (a instanceof Sylvester.Vector) {
            return a;
        }
        if (arguments.length === 1) {
            return new Sylvester.Vector(a);
        }
        return new Sylvester.Vector(a, arguments[1]);
    };
})(window);
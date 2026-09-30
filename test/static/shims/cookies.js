/* Stand-in for the map page's cookies.js.
 *
 * The map persists panel positions in cookies; the userscript replaces the
 * drag/resize UI, so this only has to behave well enough not to throw.
 */
(function (global) {
    global.Cookies = {
        get: function (name) {
            var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
            return m ? decodeURIComponent(m[2]) : undefined;
        },
        set: function (name, value, opts) {
            opts = opts || {};
            var s = name + '=' + encodeURIComponent(value);
            if (opts.expires) {
                var when = opts.expires === true ? Date.now() : opts.expires;
                s += '; expires=' + new Date(when).toUTCString();
            }
            s += '; path=/';
            document.cookie = s;
        },
        remove: function (name) {
            document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
        },
    };
})(window);
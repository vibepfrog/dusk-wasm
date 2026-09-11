(function (root) {
    'use strict';
    function create(host) {
        function wait(synchronize) {
            if (!synchronize || typeof host.requestAnimationFrame !== 'function') {
                return new Promise(function (resolve) { host.setTimeout(resolve, 0); });
            }
            return new Promise(function (resolve) {
                var settled = false;
                var frame = null;
                var timer = null;
                function finish() {
                    if (settled) return;
                    settled = true;
                    if (timer !== null) host.clearTimeout(timer);
                    if (frame !== null) host.cancelAnimationFrame(frame);
                    resolve();
                }
                // rAF is suspended in hidden tabs. Keep the worker able to
                // process focus/pause events; never await a hidden rAF forever.
                timer = host.setTimeout(finish, 100);
                try { frame = host.requestAnimationFrame(finish); }
                catch (_) {
                    host.clearTimeout(timer);
                    timer = host.setTimeout(finish, 0);
                }
            });
        }
        return { wait: wait };
    }
    root.DuskFramePacing = create(root);
    if (typeof module === 'object' && module.exports) module.exports = { create: create };
})(globalThis);

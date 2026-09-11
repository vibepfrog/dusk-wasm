// Browser pointer lock must be requested directly from a user gesture on the
// page, not from SDL's rendering pthread after the gesture has been proxied.
(function (root) {
    'use strict';
    function create(options) {
        var canvas = options.canvas;
        var doc = options.document;
        var win = options.window;
        var status = options.status;
        var enabled = false;
        var pending = false;
        var generation = 0;
        var requestGeneration = 0;
        var x = 0, y = 0;
        var failure = '';
        function locked() { return doc.pointerLockElement === canvas; }
        function reset() { x = y = 0; }
        function available() { return enabled && !doc.hidden && doc.hasFocus(); }
        function show() {
            if (!status) return;
            status.hidden = !enabled && !locked();
            status.textContent = locked() ? 'Mouse captured · Esc to release · F1 settings' :
                (failure || 'Click the game to capture the mouse · F1 settings');
        }
        function release() {
            ++generation;
            reset();
            if (locked()) doc.exitPointerLock();
            show();
        }
        function setEnabled(value) {
            enabled = !!value;
            if (!enabled) release();
            show();
        }
        function failed() {
            pending = false;
            failure = 'Mouse capture was declined. Click the game to try again.';
            show();
        }
        canvas.addEventListener('click', function (event) {
            if (event.button !== 0 || !available() || locked() || pending) return;
            failure = '';
            reset();
            requestGeneration = generation;
            pending = true;
            try {
                canvas.focus();
                // Keep this synchronous with the click. Requesting raw input is
                // optional and less portable; normal relative input is enough.
                var result = canvas.requestPointerLock();
                if (result && typeof result.then === 'function') {
                    result.then(function () {
                        pending = false;
                        if (requestGeneration !== generation || !available()) release();
                    }, failed);
                }
            } catch (_) { failed(); }
        });
        doc.addEventListener('pointerlockchange', function () {
            pending = false;
            reset(); // Never replay movement from before capture or tab restore.
            if (locked() && (requestGeneration !== generation || !available())) release();
            show();
        });
        doc.addEventListener('pointerlockerror', failed);
        doc.addEventListener('mousemove', function (event) {
            if (!available() || !locked()) return;
            if (Number.isFinite(event.movementX)) x += event.movementX;
            if (Number.isFinite(event.movementY)) y += event.movementY;
        });
        doc.addEventListener('keydown', function (event) {
            // Release before the worker opens its menus. The engine reenables
            // capture eligibility after the menu closes; only a click relocks.
            if (event.key === 'F1') setEnabled(false);
            if (event.key === 'Escape') release();
        }, true);
        doc.addEventListener('visibilitychange', function () { if (doc.hidden) release(); });
        win.addEventListener('blur', release);
        function consume() {
            var result = available() && locked() ? [x, y] : [0, 0];
            reset();
            return result;
        }
        show();
        return { setEnabled: setEnabled, consume: consume, release: release };
    }
    root.DuskMouseInput = { create: create };
    if (typeof module === 'object' && module.exports) module.exports = root.DuskMouseInput;
})(globalThis);

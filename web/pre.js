/* web/pre.js — browser-disc worker handoff + IDBFS save rehydrate.
 *
 * Loaded via emcc --pre-js, so this runs during runtime initialization, before
 * main(). We mount an IndexedDB-backed virtual filesystem at /save (memory
 * cards) so save data persists across page reloads after FS.syncfs(false).
 *
 * On boot we issue FS.syncfs(true) to copy IndexedDB → MEMFS for /save;
 * addRunDependency defers main() until rehydrate completes so the game doesn't
 * start before its save state is visible.
 */

/* A browser File is structured-cloneable but cannot be placed in Wasm memory.
 * Give each page its own BroadcastChannel; the shell sends the File to every
 * preloaded pthread worker, where FileReaderSync can service nod's synchronous
 * random-access callbacks without buffering the whole image.
 */
(function installBrowserDiscHandoff() {
    function channelFromLocation() {
        try {
            return new URLSearchParams(globalThis.location.search).get('duskDiscChannel');
        } catch (_) {
            return null;
        }
    }

    var channelName = Module.duskDiscChannel || channelFromLocation();
    if (!channelName || typeof BroadcastChannel !== 'function') {
        return;
    }

    var channel = new BroadcastChannel(channelName);
    var isPthread = typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && ENVIRONMENT_IS_PTHREAD;

    if (isPthread) {
        var workerId = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : Math.random().toString(36).slice(2);
        channel.onmessage = function (event) {
            var message = event.data || {};
            if (message.type !== 'disc-file' || !message.file) return;
            globalThis.__duskDiscFile = message.file;
            globalThis.__duskDiscReader = null;
            channel.postMessage({
                type: 'disc-ready',
                token: message.token,
                workerId: workerId,
            });
        };
        channel.postMessage({ type: 'disc-request', workerId: workerId });
        return;
    }

    var currentFile = null;
    var currentToken = null;
    var pending = null;

    function collectionSize(collection) {
        if (!collection) return 0;
        if (typeof collection.size === 'number') return collection.size;
        if (typeof collection.length === 'number') return collection.length;
        return 0;
    }

    function workerCount() {
        if (typeof PThread === 'undefined') return 0;
        return collectionSize(PThread.unusedWorkers) + collectionSize(PThread.runningWorkers);
    }

    function broadcastCurrentFile() {
        if (currentFile && currentToken) {
            channel.postMessage({ type: 'disc-file', token: currentToken, file: currentFile });
        }
    }

    channel.onmessage = function (event) {
        var message = event.data || {};
        if (message.type === 'disc-request') {
            broadcastCurrentFile();
            return;
        }
        if (!pending || message.type !== 'disc-ready' || message.token !== pending.token) return;
        pending.ready.add(message.workerId);
        if (pending.ready.size >= pending.expected) {
            clearTimeout(pending.timer);
            var resolve = pending.resolve;
            var count = pending.ready.size;
            pending = null;
            resolve(count);
        }
    };

    Module.duskSetDiscFile = function (file) {
        currentFile = file;
        currentToken = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : Date.now().toString(36) + Math.random().toString(36).slice(2);
        var expected = workerCount();
        if (expected < 1) {
            return Promise.reject(new Error('No Emscripten pthread workers are available.'));
        }
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('The browser disc selection was replaced.'));
        }
        return new Promise(function (resolve, reject) {
            pending = {
                token: currentToken,
                expected: expected,
                ready: new Set(),
                resolve: resolve,
                reject: reject,
                timer: setTimeout(function () {
                    var ready = pending ? pending.ready.size : 0;
                    pending = null;
                    reject(new Error(
                        'Timed out handing the disc to workers (' + ready + '/' + expected + ' ready).'
                    ));
                }, 15000),
            };
            broadcastCurrentFile();
        });
    };
})();

Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
    function mkdirIgnoreExists(path) {
        try { FS.mkdir(path); } catch (e) { /* most likely EEXIST — fine */ }
    }

    mkdirIgnoreExists('/save');
    FS.mount(IDBFS, {}, '/save');

    // SDL_GetPrefPath returns /libsdl/<OrgName>/<AppName>/ on emscripten and is
    // documented to create the tree, but the implementation in SDL3.4.4's
    // emscripten backend does NOT mkdir intermediate dirs — sqlite3_open and
    // friends then throw system_error: No such file or directory when they try
    // to write dawn_cache.db / pipeline_cache.db there. Pre-create defensively.
    mkdirIgnoreExists('/libsdl');
    mkdirIgnoreExists('/libsdl/TwilitRealm');
    mkdirIgnoreExists('/libsdl/TwilitRealm/Dusk');

    addRunDependency('idbfs-rehydrate');
    FS.syncfs(true, function (err) {
        if (err) {
            console.warn('[pre.js] IDBFS rehydrate failed:', err);
        }
        // The card writer expects /save/GC/ to exist; create it after rehydrate so
        // first-time users have a writable target. Region subdirs (e.g. "EUR/Card A/")
        // are created on demand by Aurora's DolphinCardPath path-format result.
        mkdirIgnoreExists('/save/GC');
        removeRunDependency('idbfs-rehydrate');
    });
});

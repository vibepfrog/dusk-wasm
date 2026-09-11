/* Browser-disc handoff and the persistent campaign startup gate.
 * save_store.js is linked before this file. Its serialized snapshot queue is
 * the only writer of /save; native card operations use /dusk/cards instead.
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
            globalThis.__duskTexturePack = message.pack ? {
                file: message.pack.file,
                entries: new Map(message.pack.entries.map(function (entry) { return [entry.name, entry]; })),
            } : null;
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
    var currentPack = null;
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
            channel.postMessage({ type: 'disc-file', token: currentToken, file: currentFile, pack: currentPack });
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
        currentPack = Module.duskSelectedPack || null;
        FS.mkdirTree('/dusk');
        FS.writeFile('/dusk/texture-pack-index.txt', currentPack
            ? currentPack.entries.map(function (entry) { return entry.name; }).join('\n') : '');
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
    if (typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && ENVIRONMENT_IS_PTHREAD) return;

    // SDL_GetPrefPath returns /libsdl/<OrgName>/<AppName>/ on emscripten and is
    // documented to create the tree, but the implementation in SDL3.4.4's
    // emscripten backend does NOT mkdir intermediate dirs — sqlite3_open and
    // friends then throw system_error: No such file or directory when they try
    // to write dawn_cache.db / pipeline_cache.db there. Pre-create defensively.
    FS.mkdirTree('/libsdl/TwilitRealm/Dusk');

    Module['duskPipelines'] = globalThis.DuskPipelineStore.create({ FS: FS, indexedDB: indexedDB });
    addRunDependency('shader-cache-rehydrate');
    Module['duskPipelines'].initialize().finally(function () {
        removeRunDependency('shader-cache-rehydrate');
    });
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) Module['duskPipelines'].flush();
    });

    Module['duskSaves'] = globalThis.DuskSaveStore.create({
        FS: FS, IDBFS: IDBFS,
        logError: function (err) { console.error('[dusk] save storage:', err); },
        acquireLock: function () {
            return new Promise(function (resolve, reject) {
                // IDBFS instances in two tabs otherwise overwrite each other's
                // snapshots. Hold an origin-scoped lock until this tab closes.
                if (!navigator.locks) {
                    reject(new Error('This browser does not support exclusive save access.'));
                    return;
                }
                navigator.locks.request('dusk-campaign-saves', { ifAvailable: true }, function (lock) {
                    if (!lock) {
                        reject(new Error('Another Dusk tab is using saves. Close that tab and reload this one.'));
                        return;
                    }
                    resolve();
                    return new Promise(function () {});
                }).catch(reject);
            });
        },
    });

    addRunDependency('idbfs-rehydrate');
    Module['duskSaves'].initialize().catch(function (err) {
        Module['duskSaveError'] = Module['duskSaves'].state().error;
    }).finally(function () {
        removeRunDependency('idbfs-rehydrate');
    });

    window.addEventListener('beforeunload', function (event) {
        Module['duskPipelines'].flush();
        var state = Module['duskSaves'].state();
        if (state.writing || state.pending || state.dirty) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
});

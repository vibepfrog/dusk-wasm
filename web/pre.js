/* web/pre.js — IDBFS mount + first-boot rehydrate.
 *
 * Loaded via emcc --pre-js, so this runs during runtime initialization, before
 * main(). We mount IndexedDB-backed virtual filesystems at /save (memory cards)
 * and /iso (the user's converted CISO) so writes persist across page reloads
 * after FS.syncfs(false) is called.
 *
 * On boot we issue FS.syncfs(true) to copy IndexedDB → MEMFS; addRunDependency
 * defers main() until rehydrate completes so the game doesn't start before its
 * save state is visible.
 */
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
    function mkdirIgnoreExists(path) {
        try { FS.mkdir(path); } catch (e) { /* most likely EEXIST — fine */ }
    }

    mkdirIgnoreExists('/save');
    mkdirIgnoreExists('/iso');
    FS.mount(IDBFS, {}, '/save');
    FS.mount(IDBFS, {}, '/iso');

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

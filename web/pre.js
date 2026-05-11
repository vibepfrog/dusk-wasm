/* web/pre.js — IDBFS mount + first-boot rehydrate.
 *
 * Loaded via emcc --pre-js, so this runs during runtime initialization, before
 * main(). We mount an IndexedDB-backed virtual filesystem at /save (memory
 * cards) so save data persists across page reloads after FS.syncfs(false).
 *
 * /iso is intentionally NOT IDBFS-mounted: the converted CISO is ~1054 MB and
 * Chrome's per-blob IndexedDB cap is ~1 GB, so syncfs would either fail or
 * truncate the file. A truncated CISO is the worst outcome — analyzePath says
 * the file exists so the runtime auto-launches main(), but iso::inspect rejects
 * the contents, leaving the prelaunch UI stuck on "No disc image found" with no
 * obvious way for the user to recover (clearing HTTP cache leaves IndexedDB
 * intact). Treating the upload as session-local avoids that whole class of
 * bug; the user re-uploads each session, which takes ~30-90 seconds.
 *
 * On boot we issue FS.syncfs(true) to copy IndexedDB → MEMFS for /save;
 * addRunDependency defers main() until rehydrate completes so the game doesn't
 * start before its save state is visible.
 */
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
    function mkdirIgnoreExists(path) {
        try { FS.mkdir(path); } catch (e) { /* most likely EEXIST — fine */ }
    }

    mkdirIgnoreExists('/save');
    mkdirIgnoreExists('/iso');
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

/* web/unwind_shim.js — JS-library shim for unresolved Rust panic_unwind imports.
 *
 * Added via emcc --js-library. Rust's panic_unwind crate emits a reference to
 * `_Unwind_RaiseException` even when the workspace-level CARGO_PROFILE_RELEASE_PANIC
 * env var is set to "abort" (transitive deps in nod build with default panic=unwind
 * if their own profile doesn't override). The wasm import shows up at link time;
 * without a JS shim, WebAssembly.instantiate() fails with LinkError.
 *
 * Strategy: stub the function. If it's actually called, that means a Rust panic
 * propagated through the wasm boundary — log loudly and abort. In practice this
 * shouldn't happen because dusk doesn't intentionally panic; but if it does, an
 * abort is much friendlier than a cryptic LinkError that prevents the page from
 * loading at all.
 */
addToLibrary({
    _Unwind_RaiseException: function (exception) {
        err('[dusk] _Unwind_RaiseException invoked from Rust (panic) — aborting');
        abort('Rust panic propagated through wasm boundary');
    },
    _Unwind_DeleteException: function (exception) {
        // Cleanup partner; called when unwinding completes. No-op since we abort above.
    },
    _Unwind_Resume: function (exception) {
        err('[dusk] _Unwind_Resume invoked — aborting');
        abort('Rust panic resume');
    },
});

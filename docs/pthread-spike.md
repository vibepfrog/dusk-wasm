# Threaded browser spike

## Status

The Emscripten build now compiles and links Dusk with shared WebAssembly memory,
preloaded pthread workers, WebGPU, a transferred OffscreenCanvas, and a bounded
browser disc stream. The user reports that their USA CISO boots and is quite
playable, with startup texture corruption that clears after F11 twice and a
minor flicker in the title scene's sun glow. Their URL contained
`?build=a32f770`, but that query parameter does not pin the JavaScript/Wasm
release, so the exact binaries used for that report are not established.

Build `d1a066a` passed CI and a ROM-free Chrome test reached the enabled file
chooser without the prior global-constructor exception. That verifies launcher
readiness, not gameplay. The texture-cache fix below still needs comparison
with the user's real disc and GPU.

Aurora's WebGPU startup uses synchronous `WaitAny()` calls for the browser's
asynchronous adapter and device requests, so emdawnwebgpu needs a promise-aware
stack suspension mechanism. The first threaded build used Binaryen Asyncify,
but SDL's DOM pointer handlers then entered an Asyncify-instrumented `SDL_malloc`
export on the browser thread while the application pthread was suspended. That
trapped repeatedly as `RuntimeError: null function` from
`SDL3.makePointerEventCStruct`.

The build now uses JSPI (`-sJSPI=1`). JSPI leaves the Wasm code and indirect
function table intact and stack-switches only across the asynchronous WebGPU
boundary, avoiding that cross-thread Asyncify re-entry. The shell explicitly
checks for `WebAssembly.Suspending` and `WebAssembly.promising`. Pthreads remain
responsible for parallel game work and synchronous `FileReaderSync` disc access;
JSPI is the separate JavaScript-promise bridge.

The file chooser starts disabled and is enabled only from Emscripten's
`onRuntimeInitialized` callback. This prevents a fast file selection from
calling `Module.callMain()` while asynchronous `preRun` dependencies (including
filesystem setup) remain. A JSPI promise returned by `callMain()` is also
observed so startup failures are reported by the launcher instead of becoming
unhandled promise rejections.

The build verifier executes the generated, minified launcher's inline script
with DOM and Emscripten stubs. It checks early selection/drop events, the
independent runtime promise gate, delayed disc handoff, duplicate starts,
capability failures, and synchronous/promise-based main failures. These are
launcher regression checks, not an end-to-end browser/game test. Exact-string
checks for the source formatting were removed because HTML/JS minification
caused false failures after a successful Wasm compile.

## Native exceptions with JSPI

The browser failed in `Z2AudioMgr::Z2AudioMgr()` from `__wasm_call_ctors` with
`SuspendError: trying to suspend without WebAssembly.promising`. The previous
`-fexceptions`/`-sDISABLE_EXCEPTION_CATCHING=0` configuration used JavaScript
`invoke_*` exception trampolines, which are incompatible with JSPI suspension
([Emscripten issue 24302](https://github.com/emscripten-core/emscripten/issues/24302)).

All CMake C++ targets now compile and link with `-fwasm-exceptions`. C and C++
compilation also use `-sSUPPORT_LONGJMP=wasm` so C library setjmp/longjmp matches
the exception model. Cargo-built C/C++ compression dependencies receive the
same options through cc-rs environment variables; Rust remains panic=abort.
The build verifier rejects any remaining `invoke_*` Wasm imports and requires
the native C++ exception tag. Constructors still run synchronously; this change
does not make all exports asynchronous or skip global initialization.

## Texture cache handle lifetime

Aurora hashes the C resource handles in a bind-group descriptor and retains the
resulting bind group in a cache. In the pinned
[Emdawn v20251002.162335 package](https://github.com/google/dawn/releases/tag/v20251002.162335),
`wgpuDeviceCreateBindGroup` resolves descriptor handles to JavaScript resources;
it does not retain the C texture-view, sampler, buffer, or layout handles.
Those handles are separately reference-counted C++ objects. Their addresses can
therefore be recycled while a cached bind group still holds the old JS texture.
An identical descriptor hash then returns the old texture binding.

`CachedBindGroup` now owns C++ references to the layout and all descriptor
resources until expiration or cache clearing. This prevents handle reuse during
the entry's lifetime. The existing 32-frame retention and 16-frame sweep remain
in effect; references are released with the entry, including after container
moves. This adds small CPU-side reference storage, not copies of texture pixels.

`bind_group_cache_test.cpp` uses the actual WebGPU C++ wrappers and a fake C
handle allocator that deliberately reuses released addresses. It verifies
retention after the original owner releases a resource, move safety, duplicate
bindings, empty groups, and balanced release over 1,000 eviction cycles. CI
compiles this test to Wasm and runs it in Node without a GPU or disc.

This is a concrete lifetime defect and matches the F11 cache-clearing symptom;
whether it explains all of the user's corrupted textures requires gameplay
validation. No automatic resize or periodic cache flush is used to hide it.

The sun-glow cause is still unconfirmed. `dKyr_sun_move` samples five depth
points, while `depth_peek.cpp` provides asynchronous snapshots at up to 30 Hz.
The next investigation should compare the affected scene before and after
resize, then check snapshot timing and depth contents if flicker persists.
Do not change glow visibility or depth thresholds without that evidence.

## Render-worker canvas ownership

`PROXY_TO_PTHREAD` runs SDL and Aurora on a pthread worker. Workers cannot query
the page DOM, so a surface descriptor that names `#canvas` fails at
`wgpuInstanceCreateSurface()` with `getContext` on an undefined object unless
the canvas is transferred first.

The link now enables `OFFSCREENCANVAS_SUPPORT`. Emscripten 5.0.6's proxied-main
stub transfers `Module.canvas` (its default selector is `#canvas`) to the
application pthread. Aurora then follows Dawn's Emscripten adapter convention:
it maps the synthetic `!canvas` target to the worker's `Module.canvas` and asks
emdawnwebgpu to create the WebGPU surface from that OffscreenCanvas. Build
verification checks for the transfer and selector markers in `index.js`.

The repeated `emscripten_proxy_async failed` key/focus errors observed after the
original surface failure were fallout from browser event handlers trying to
call an application worker that had already aborted, not disc-image failures.
Likewise, the later `SDL_malloc` pointer-event flood occurs before disc parsing
and says nothing about the selected CISO's validity.

## Pinned toolchain

- Emscripten `5.0.6`
- CMake `4.2.0-rc3`
- Ninja `1.13.2`
- Rust `nightly-2026-09-01` with `rust-src`
- Rust target `wasm32-unknown-emscripten`

The nightly toolchain is required because nod is rebuilt with Rust's standard
library using atomics, bulk memory, and mutable globals. All C/C++ translation
units also compile with `-pthread`; a shared-memory Wasm link cannot combine
objects that omit the required target features.

## Reproduce

```sh
emcmake cmake --preset web-emscripten-fast
cmake --build --preset web-emscripten-fast --parallel
node web/check_build.mjs build/web-emscripten-fast/web
node --test web/iso_bridge.test.mjs
node --test web/shell_runtime.test.mjs
```

The hosting origin must return these response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

## Disc streaming design

The browser accepts GameCube ISO/GCM and CISO containers. The selected `File`
is structured-cloned to the Emscripten pthread workers through a per-tab
`BroadcastChannel`; it is never copied into MEMFS or the Wasm heap.
`FileReaderSync` services nod's synchronous random-access callbacks in chunks
no larger than 4 MiB.

Raw images receive a quick browser-side disc ID check. Supported logical IDs
are USA `GZ2E01` and EUR `GZ2P01`. A CISO's logical header is not stored at byte
zero, so CISO identity and integrity checks are deferred to nod and Dusk's
native incremental XXH3 validation. This supports a roughly 1 GB CISO without
expanding it into a 1.4 GB in-memory ISO.

No disc image, extracted game asset, hash-derived content, or save file belongs
in the repository or deployment artifact.

## Build size and hosting

The CI-verified `d1a066a` bundle is 29.39 MB total; `index.wasm` is 21.01 MB and
`index.data` is 7.99 MB. Each asset fits under Cloudflare Pages'
[25 MiB per-file limit](https://developers.cloudflare.com/pages/platform/limits/#file-size).
The earlier 34.66 MB Wasm measurement came from the larger Asyncify build and
is obsolete. A separate R2 origin is therefore not required by the current
asset sizes; recheck sizes on future builds. The GitHub Pages preview uses
`coi-serviceworker.js` to attach the
required isolation headers on a static host that does not support custom
response headers; it reloads once after the service worker takes control.

## Next test

After deployment, hard-refresh the preview and use the same USA CISO that the
user has already booted successfully. First observe the title scene without
pressing F11. Check whether startup textures are correct and whether the glow
still flickers. If corruption remains, capture it before and after F11 twice,
plus the first WebGPU validation error (if any) and the browser/GPU versions.
There is no reason to replace the working CISO for this graphics test.

# Threaded browser spike

## Status

The Emscripten build now compiles and links Dusk with shared WebAssembly memory,
preloaded pthread workers, WebGPU, a transferred OffscreenCanvas, and a bounded
browser disc stream. Static and Node regression tests pass. A real Chrome run
has reached Aurora's WebGPU surface creation; the next validation step is to
rerun after enabling the canvas transfer described below.

The pthread runtime also retains Asyncify with a 4 MiB unwind stack. Aurora's
WebGPU startup uses synchronous `WaitAny()` calls for the browser's asynchronous
adapter and device requests; without Asyncify, emdawnwebgpu rejects the requested
`TimedWaitAny` instance feature before it can create the adapter. Pthreads are
used for parallel game work and synchronous `FileReaderSync` disc access, but do
not replace that JavaScript-promise suspension bridge.

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

The last locally verified release bundle was 43.11 MB total. `index.wasm` was
34,661,319 bytes (34.66 MB raw, about 9.73 MB gzip). That exceeds Cloudflare
Pages' 25 MiB per-file limit, so production should use Pages for the shell and
an R2/custom-domain origin for the Wasm binary with compatible CORS/CORP
headers. The GitHub Pages preview uses `coi-serviceworker.js` to attach the
required isolation headers on a static host that does not support custom
response headers; it reloads once after the service worker takes control.

## Next test

Use a clean, user-owned USA or EUR image. The immediate target is a USA CISO
whose logical GameCube identity is `GZ2E01` (retail serial `DOL-GZ2E-USA`). A
native validation failure indicates a modified, lossy, corrupt, or unsupported
dump; do not weaken the hash gate to make such an image boot. The corrected run
should advance past `Attempting to initialize WebGPU` without the
`getContext`/undefined error before disc integrity becomes the next checkpoint.

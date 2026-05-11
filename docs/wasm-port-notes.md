# Dusk WebAssembly Port — Working Notes

These notes track decisions, pinned versions, and known constraints for the WASM/browser
port. The strategic plan and phase boundaries live in `../../PLAN.md` (workspace root).

## Pinned versions

| Component                            | Version              | Source                                                     |
|--------------------------------------|----------------------|------------------------------------------------------------|
| emsdk                                | `5.0.6`              | `tools/emsdk-version`; same as slider's `web-release`      |
| Dawn (target ABI for emdawnwebgpu)   | `v20260423.175430`   | `extern/aurora/CMakeLists.txt:17`                          |
| SDL3                                 | `3.4.4`              | `extern/aurora/CMakeLists.txt:18`                          |
| nod (Rust)                           | `v2.0.0-alpha.8`     | `extern/aurora/CMakeLists.txt:19`                          |
| Rust target for nod                  | `wasm32-unknown-emscripten` | set via `Rust_CARGO_TARGET` cache var in the preset |

## Renderer choice — WebGPU via emdawnwebgpu (not WebGL2)

Aurora's GX→GPU translator (`extern/aurora/lib/gx/`) emits `webgpu_cpp.h` calls. emdawnwebgpu
ships the same C++ header with a JS-bridged implementation, so Aurora's existing WebGPU
backend is reusable. The `BACKEND_WEBGPU` slot was already wired in `aurora.cpp:40-65`
behind `ENABLE_BACKEND_WEBGPU`, so the new `emscripten` provider in
`extern/aurora/cmake/AuroraDawnProvider.cmake` only needs to:

1. Link `--use-port=emdawnwebgpu`
2. Alias the resulting target to `dawn::webgpu_dawn` so `aurora_gx.cmake:42` picks it up
   unchanged
3. Define `ENABLE_BACKEND_WEBGPU=ON` and leave every other `DAWN_ENABLE_*` off

A WebGL2 shim would mean writing a GX→GLES translator from scratch (slider had `pc_gx.c`,
inherited from Animal Crossing's PC port — Dusk has no equivalent). Estimated ~3 months
of work versus reusing the existing WebGPU path. Reserved as Phase-2 fallback only.

## Asyncify, not JSPI

Slider documents the rationale in `pc/CMakeLists.txt:478-481`: WebKit bug #304810 leaks
"Page" memory under any Asyncify-instrumented wasm — Safari/iOS climb to 7+ GB and OOM.
JSPI would fix the leak but isn't viable yet: Safari/iOS don't expose
`WebAssembly.Suspending`, and Firefox gates JSPI behind an `about:config` flag. Stay on
Asyncify until JSPI is universally shipped.

The Aurora WebGPU async paths in `extern/aurora/lib/webgpu/gpu.cpp:442-573` use
`wgpu::CallbackMode::WaitAnyOnly` + synchronous `WaitAny(...)` — Asyncify-safe as written.
emdawnwebgpu's wrapper handles the JS-thread marshaling transparently.

## ISO ingestion — CISO conversion in JavaScript

GameCube discs are ~95% filler. Slider's `pc/web/shell-rom.js` walks the GC FST in JS at
import time, marks every 2 MB block any FST-listed file overlaps, drops the rest. The
resulting CISO is typically 5-15% the original size. TP is heavier than Animal Crossing
(more model, audio, and movie data) — expect 300-500 MB CISOs.

`web/iso_bridge.js` is a near-verbatim port of slider's `shell-rom.js` (the GC disc format
is identical between AC and TP), with a SHA-1 verify added against the EUR ISO hash
`2601822a488eeb86fb89db16ca8f29c2c953e1ca` to refuse mismatched dumps.

CISO is written to IDBFS at `/iso/dusk.ciso` and persisted via `FS.syncfs(false, ...)`.
Aurora's nod library natively reads CISO — no patches to `extern/nod` needed.

## Phase boundary at end of session 1

- **Done in session 1**: every source/config patch for Phases 1 (skeleton), 5 (ISO bridge),
  6 (save persistence), 7 (HTML shell + linker block), 8 (CI), and the static parts of
  Phase 2 (Aurora emdawnwebgpu provider + canvas surface descriptor). Toolchain installed
  (emsdk 5.0.6, Rust + `wasm32-unknown-emscripten`, CMake). DoD attempted:
  `emcmake cmake --preset web-emscripten` should configure cleanly.
- **Deferred**: actually building (requires fixing whatever the configure exposes), Phase 0
  native baseline (no MSVC installed), Phases 3 (audio/input wiring), 4 (single-thread vs
  pthread decision), 9 (perf tuning). Each is a separate session.

## Test infrastructure (session 2)

- **`web/iso_bridge.test.mjs`** — Node-based unit tests for the JS converter. Loads
  `iso_bridge.js` into a `vm` context with browser-global shims (`window`, `crypto.subtle`,
  `Blob`) and exercises `verifyHeader` / `verifySha1` / `isoToCiso` against the real EUR
  ISO at `../../The Legend of Zelda - Twilight Princess (E).iso`. Run with:
  `node dusk/web/iso_bridge.test.mjs` (Node 18+). 5 tests, ~3s total.
- **`web/check_build.mjs`** — post-build smoke check. Verifies `index.{html,js,wasm,data}`
  + `iso_bridge.js` exist with non-zero size, wasm magic bytes are correct, the HTML shell
  had `{{{ SCRIPT }}}` substituted, the canvas id="canvas" is present, and iso_bridge.js
  carries the pinned EUR SHA-1. Run with: `node dusk/web/check_build.mjs [build-dir]`.

## Build issue catalog (session 2 — three build attempts, each surfaced new failures)

These are real Phase 2 issues uncovered by `cmake --build --preset web-emscripten`. Each
fix unblocked the build to a new failure — typical for a port. Documenting the catalog
because the next session will need to work through these systematically.

| # | File / target | Class | Patched? |
|---|---|---|---|
| 1 | `extern/aurora/extern/CMakeLists.txt:123` — `IMGUI_IMPL_WEBGPU_BACKEND_DAWN` | imgui's wgpu backend forbids the define under `__EMSCRIPTEN__` | ✅ gated `if(NOT EMSCRIPTEN)` |
| 2 | `_deps/imgui-src/backends/imgui_impl_wgpu.cpp` | imgui v1.91.9b uses old Dawn API names (`WGPUProgrammableStageDescriptor`, `WGPUShaderModuleWGSLDescriptor`, `WGPUImageCopyTexture`, `WGPUTextureDataLayout` removed/renamed) | ✅ stubbed via `lib/imgui_impl_wgpu_stub.cpp` (no-op debug overlay on web) |
| 3 | `_deps/fmt-src/include/fmt/format.h:747` — `malloc` undeclared | fmt 11.1.4's allocator uses `malloc/free` without `<cstdlib>`; emscripten doesn't pull it in transitively | ✅ `target_compile_options(fmt PUBLIC -include cstdlib)` |
| 4 | `extern/aurora/lib/window.cpp:33` — `#include "rmlui.hpp"` ungated | rmlui.hpp:8 includes `<dawn/webgpu_cpp.h>` which doesn't exist in emdawnwebgpu (it provides `<webgpu/webgpu_cpp.h>`); the include must be gated like aurora.cpp:11 does | ✅ gated `#ifdef AURORA_ENABLE_RMLUI` |
| 5 | `extern/aurora/lib/gfx/dds_io.cpp:206` — narrowing uint64_t → size_t | Aurora assumes size_t is 64-bit; wasm32 makes it 32-bit. | ✅ explicit `static_cast<size_t>(expectedSize)` |
| 6 | `_deps/aurora_nod-build/_cargo-build_nod` — exit 101 | nod-ffi (Rust) cross-compile to wasm32 fails because the Rust **host** toolchain (`stable-x86_64-pc-windows-msvc`) needs `link.exe` from MSVC Build Tools to compile proc-macros and build scripts — and we deliberately skipped MSVC. | ✅ switched host to `stable-x86_64-pc-windows-gnullvm` (LLVM-MinGW based, no MSVC required). Required installing **LLVM-MinGW-UCRT** (winget) so dlltool + as.exe are available. |
| 7 | nod-ffi: `liblzma-sys` build script: `command line is too long` | cc-rs spawns `emar.bat` directly with full argv (~12K chars for ~50 .o files); `.bat` files go through cmd.exe whose %* parsing limit is ~8190 chars. | ✅ wrote `tools/emar_pyshim.exe` (Rust-compiled .exe) that takes argv via Win32 API (32K limit) and forwards to `python emar.py`. Threaded into Corrosion via `CMAKE_AR` override forced in *both* `dusk/CMakeLists.txt` and `extern/aurora/CMakeLists.txt` (the toolchain re-runs `set(CMAKE_AR emar.bat)` on every `project()` call, masking the cache). |
| 8 | `aurora_core.cmake:40`/`aurora_gx.cmake:43` — define `WEBGPU_DAWN` everywhere | `WEBGPU_DAWN` gates Dawn-native code in `gpu.cpp` (`dawn::native::DawnInstanceDescriptor`); emdawnwebgpu doesn't have those symbols. | ✅ gated define on `if(NOT EMSCRIPTEN)` in both files. |
| 9 | `BackendBinding.cpp:33` — `wgpu::SurfaceSourceCanvasHTMLSelector` doesn't exist | emdawnwebgpu prefixes it with `Emscripten` to distinguish from native Dawn variants. | ✅ renamed to `wgpu::EmscriptenSurfaceSourceCanvasHTMLSelector`. |
| 10 | `gpu.cpp:384` — `utils::SetupWindowAndGetSurfaceDescriptor` undeclared | The `BackendBinding.hpp` include was nested under `#ifdef WEBGPU_DAWN`; emscripten still needs the surface-descriptor helper even though it doesn't need dawn::native. | ✅ moved BackendBinding.hpp include outside the `WEBGPU_DAWN` gate. |
| 11 | `gpu.cpp:587` — `g_device.SetLoggingCallback` / `wgpu::LoggingType` not found | Dawn extension; emdawnwebgpu doesn't expose it. Browser routes WebGPU validation to JS console. | ✅ wrapped the SetLoggingCallback block in `#ifdef WEBGPU_DAWN`. |
| 12 | `dusk/include/dusk/endian.h:37` — `BSWAP64` undeclared | Platform detection list at line 10 misses wasm32; falls into the big-endian branch which only defines BSWAP16/BSWAP32. | ✅ added `defined(__wasm__) || defined(__EMSCRIPTEN__)` to the little-endian list. |
| 13 | `extras.c.o` — `'cstdlib' file not found` | The fmt fix added `target_compile_options(fmt PUBLIC -include cstdlib)` which propagates to *all* fmt consumers including C files. cstdlib is C++-only. | ✅ wrapped flag in `$<$<COMPILE_LANGUAGE:CXX>:...>` generator expression. |
| 14 | `m_Do_main.cpp` → `dusk/ui/event.hpp:3` — `'RmlUi/Core.h' file not found` | Dusk's own UI system (`src/dusk/ui/`, ~47 files in `files.cmake`) is built on RmlUi. With AURORA_ENABLE_RMLUI=OFF, RmlUi headers aren't on the include path. | ❌ **pending — design choice needed**, see below |

### Toolchain components installed in session 3

- **LLVM-MinGW UCRT** (winget `MartinStorsjo.LLVM-MinGW.UCRT`) at `C:\Users\shift\AppData\Local\Microsoft\WinGet\Packages\MartinStorsjo.LLVM-MinGW.UCRT_*\llvm-mingw-20260505-ucrt-x86_64\bin\` — provides full binutils (dlltool, as, gcc, ld, ar) needed by Rust GNU host build. ~200 MB.
- **Rust toolchain `stable-x86_64-pc-windows-gnullvm`** (rustup) — LLVM-based MinGW Rust target that uses `compiler-rt` instead of libgcc. Now the default. Needed because the regular GNU toolchain expects `-lgcc_eh`/`-lgcc` which LLVM-MinGW doesn't provide.
- **`tools/emar_pyshim.exe`** (built locally with rustc) — 1.5 MB shim binary that bypasses `emar.bat → cmd.exe` and invokes `python emar.py` directly so cargo's long-argv ar invocations don't truncate.

### Build progress this session: configure → step 41/1156

After fixes #1-#13, the build now reaches step 41/1156 of 1156 (~3.5%) before hitting the
RmlUi blocker. Major milestones cleared in this run:

- ✅ Configure exits 0 with all fetches succeeding (~55s, faster on warm cache)
- ✅ All deps compile: SDL3, abseil, fmt, freetype, imgui, sqlite3, zstd, tracy, json, cxxopts, xxhash
- ✅ **Aurora itself compiles fully**: `aurora_core`, `aurora_gx`, `aurora_gd`, `aurora_dvd`, `aurora_pad`, `aurora_card`, `aurora_main`, `aurora_mtx`, `aurora_ms`, `aurora_si`, `aurora_vi`, `aurora_os` all link as `.a` archives
- ✅ **`nod-ffi` cargo cross-compile to wasm32-unknown-emscripten succeeds** (~16s on warm cache, ~3 min cold)
- ✅ **All JSystem libs** (JParticle, J3DU, JKernel, JFramework, JMath, JSupport, JStage, JUtility, JHostIO, JAHostIO) compile and link
- ✅ Dusk's own PCH builds; many of dusk's `src/m_Do/` and `src/f_ap/` files compile
- ❌ Stops at first `dusk/ui/`-using TU because RmlUi headers aren't on the path

### Issue #14 — RESOLVED in session 4 (2026-05-10)

The dusk WASM port now **builds end-to-end** on Windows. Final fixes that closed it out:

| # | File | Fix |
|---|---|---|
| 14a | `CMakePresets.json` | Set `AURORA_ENABLE_RMLUI=true` — RmlUi v6+ has emscripten support, no need to gate dusk's UI off |
| 14b | `extern/aurora/lib/rmlui.hpp:8` and `extern/aurora/lib/rmlui/WebGPURenderInterface.hpp:5` | Use `<webgpu/webgpu_cpp.h>` instead of `<dawn/webgpu_cpp.h>` to match the rest of aurora and emdawnwebgpu's path |
| 14c | `dusk/CMakeLists.txt` and `extern/aurora/CMakeLists.txt` | Replace custom `tools/emar_pyshim.exe` shim with emsdk's bundled native `llvm-ar.exe` (no shim needed — emar.bat's only added value over llvm-ar is LTO bookkeeping we don't use) |
| 14d | Build env: `CARGO_PROFILE_RELEASE_PANIC=abort` | Eliminates `__cpp_exception` undefined symbols from `libnod.a`. cargo's default `panic=unwind` emits exception-unwinding metadata that requires the wasm-EH ABI runtime which doesn't link cleanly via Corrosion → llvm-ar → wasm-ld for staticlib output. Setting `panic=abort` produces smaller binaries with no exception metadata at all. |
| 14e | `extern/aurora/cmake/AuroraNodProvider.cmake` | Document the panic=abort requirement in the cmake file so it's in-tree |
| 14f | `dusk/CMakeLists.txt` link options | Added `-fexceptions -sDISABLE_EXCEPTION_CATCHING=0`. With `panic=abort` these are belt-and-suspenders — they only matter if any other dependency throws. Per the session-4 research subagent, the **proper** flag for Rust + emcc 5.0.6 + wasm-EH is `-fwasm-exceptions` (not `-fexceptions`); pre-empt for the day a crate without `panic=abort` enters the dep tree. |

### Final build artifacts (build/web-emscripten/web/)

| File | Size |
|---|---|
| `index.html` | 11.55 KB |
| `index.js` | 521.45 KB |
| `index.wasm` | 197.91 MB (with `-g` debug; release strip would be ~30-50 MB) |
| `index.data` | 7.99 MB (preloaded `res/`) |
| `iso_bridge.js` | 11.38 KB |
| **Total** | **206.44 MB** |

All 13 `check_build.mjs` validations pass (artifacts, wasm magic bytes, shell substitution, canvas id, iso_bridge.js wiring, EUR SHA-1).

### Toolchain bootstrapped (Windows-specific, can be skipped on Linux CI)

| Tool | Version | Source | Purpose |
|---|---|---|---|
| emsdk | 5.0.6 | `C:\Users\shift\emsdk` | Emscripten SDK |
| Rust | 1.95 | rustup; default toolchain `stable-x86_64-pc-windows-gnullvm` | Cross-compile nod-ffi to wasm32-unknown-emscripten |
| LLVM-MinGW UCRT | 22.1.5-20260505 | winget `MartinStorsjo.LLVM-MinGW.UCRT` | Provides `dlltool`, `as`, `ld`, etc. needed by Rust GNU host build (was needed before MSVC install; now redundant if you switch back to MSVC Rust) |
| MSVC Build Tools 2022 | 17.14.31 | winget `Microsoft.VisualStudio.2022.BuildTools` + `Microsoft.VisualStudio.Workload.VCTools` | Standard Windows C++ toolchain. Installed in session 4 to enable switching Rust default back to canonical `stable-x86_64-pc-windows-msvc` (not yet activated — the gnullvm chain works) |
| Python | 3.12 | winget `Python.Python.3.12` | emsdk needs real Python (not the WindowsApps stub) |
| CMake | 4.3.2 | winget `Kitware.CMake` | Build orchestrator |

### Session 5 — Browser smoke test (2026-05-10)

Spun up a headless Chrome via `tools/browser-smoke/smoke-import.mjs` (puppeteer-core, uses installed Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`, `--use-vulkan=swiftshader` for software WebGPU). Drove the full upload → CISO convert → callMain flow.

**What works end-to-end (verified by automated smoke test):**

| Step | Result |
|---|---|
| Page load + wasm runtime init | ✅ |
| `Module.preRun` mounts IDBFS at `/save` and `/iso` | ✅ |
| Drop-zone overlay visible while no CISO present | ✅ |
| File upload via Puppeteer (`fileInput.uploadFile(ISO)`) | ✅ |
| `verifyHeader` (game ID `GZ2P`) | ✅ |
| `verifySha1` matches pinned EUR hash | ✅ |
| `isoToCiso` (1460 MB → 1054.9 MB, 503 present blocks) in **~5.5s** in browser | ✅ |
| `FS.writeFile('/iso/dusk.ciso', cisoBytes)` (MEMFS write) | ✅ |
| `Module.callMain()` (deferred via `noInitialRun: true`) | ✅ |
| `dusk::config::LoadFromFileName` (caught missing-config gracefully) | ✅ |
| `EnsureInitialPipelineCache` (graceful "no bundled cache") | ✅ |
| `aurora::initialize` (Aurora boot) | ✅ |
| `webgpu::initialize` — `wgpu::CreateInstance` | ✅ |
| `RequestAdapter` (got SwiftShader CPU adapter under headless) | ✅ |
| `RequestDevice` + features/limits negotiation | ✅ |
| Canvas resized 300×150 → **1216×896** (Aurora's default 304×224 × 4) | ✅ |
| Surface configured: `BGRA8Unorm`, present mode `Fifo` | ✅ |
| **Next step (texture creation? pipeline compile?)** | ❌ `abort()` — abort with no specific message |

**Bugs found and fixed during smoke testing:**

| # | Bug | Root cause | Fix |
|---|---|---|---|
| S1 | `SyntaxError: Invalid or unexpected token` at parse time | My shell.html had a JS comment containing the text `</script>` — HTML parser ends script tag at any literal close-tag token, even inside JS comments. Inline `<script>` was truncated, all my Module hooks never ran. | Rewrote the comment to never spell out the close-tag literally. |
| S2 | `[std::__2::system_error] No such file or directory` then `CppException` killed main() unconditionally on first load | `main()` ran via emcc auto-call after preRun, before the user could even import an ISO; Aurora tried to open the absent disc and threw. | `Module.noInitialRun = true`; shell calls `Module.callMain()` itself only after import succeeds. Also exported `callMain`, `FS`, `IDBFS`, `addRunDependency`, `removeRunDependency`, `getExceptionMessage` via `EXPORTED_RUNTIME_METHODS`. |
| S3 | Same exception at the next layer — config load threw past the `try { LoadFromPath } catch (system_error)` | **emcc compiles C++ with exceptions DISABLED by default** — every `try/catch` is elided, throws unwind straight past every C++ frame to JS. We had `-fexceptions` at link-time but not at compile-time. | `add_compile_options($<$<COMPILE_LANGUAGE:CXX>:-fexceptions>)` in dusk's top-level CMakeLists.txt BEFORE `add_subdirectory(extern/aurora)`. Required a full rebuild — every .o invalidates. |
| S4 | IDBFS `FS.syncfs(false)` for 1054 MB CISO fails with `DataError: Failed to write blobs (InvalidBlob)` | Chrome's IndexedDB has a per-blob size cap around 1 GB; the TP CISO sits right at that boundary. | Treat persistence as best-effort: keep CISO in MEMFS for the session, surface a friendly warning. Removed the post-import reload entirely (not needed once `noInitialRun=true` lets us callMain on demand). Long-term: chunk to multiple sub-GB files or migrate to OPFS. |
| S5 | SDL prefpath `/libsdl/TwilitRealm/Dusk/` may not be auto-created by SDL3.4.4's emscripten backend → `sqlite3_open` for dawn_cache.db fails with system_error | SDL's emscripten backend's `SDL_GetPrefPath` doesn't `mkdir` the intermediate directories on its first call. | `pre.js` defensively creates `/libsdl`, `/libsdl/TwilitRealm`, `/libsdl/TwilitRealm/Dusk` before main runs. |
| S6 | `getExceptionMessage` undefined when trying to extract C++ what() string | Modern emcc strips runtime exports; need to ask for them. | Added to `EXPORTED_RUNTIME_METHODS` (S2). Also enabled `-sASSERTIONS=1` and `-sEXCEPTION_STACK_TRACES=1` so future throws come with a wasm stack trace pointing at the offending source line. |
| S7 | Cosmetic favicon 404 | No favicon at site root | Inline SVG `data:` URL in `<link rel="icon">` — no extra file, no 404. |

**Remaining blocker (likely environment-specific):**

After WebGPU device is acquired, surface configured, and canvas resized, the runtime calls `abort()` with no further message. The most likely culprits, in order:

1. **SwiftShader CPU WebGPU is missing a feature Aurora needs** (texture format support, max texture size, etc.). Likely doesn't reproduce on a real GPU. **Test this on real Chrome before debugging further.**
2. Aurora's WGSL shader compilation triggers a Tint/Naga validation error.
3. Asyncify stack overflow on Aurora's deeper init chain (try bumping `-sASYNCIFY_STACK_SIZE` from 4 MB).

### How to test on your real Chrome (manual, no Puppeteer)

```powershell
# In one shell — keep server running:
cd C:\Users\shift\Desktop\dusk-wasm\dusk\build\web-emscripten\web
C:\Users\shift\emsdk\python\3.13.3_64bit\python.exe -m http.server 8080
```

Then open `http://localhost:8080/` in regular Chrome with DevTools (F12) → Console open. Drop the verified EUR ISO onto the page; the import should take ~5-10 s (much faster than the documented 30-90 s estimate — emcc's optimization paid off). Watch console for whether the abort still fires on a real GPU. If not, you'll see the canvas paint and Aurora continue past surface configuration.

### Headless smoke test infrastructure (in-tree)

- `tools/browser-smoke/package.json` — declares `puppeteer-core ^24.0.0`
- `tools/browser-smoke/smoke.mjs` — first-load test (runtime ready, no ISO yet)
- `tools/browser-smoke/smoke-import.mjs` — full upload + boot test
- Both use the user's installed Chrome (puppeteer-core, no Chromium bundle download)
- Run: `cd dusk/tools/browser-smoke && node smoke.mjs http://127.0.0.1:8081/`

### Original "Next steps" (now mostly addressed; kept for history)
2. **Apply session-4 research recommendations** (none are blockers, all are robustness improvements):
   - Replace `-fexceptions -sDISABLE_EXCEPTION_CATCHING=0` with `-fwasm-exceptions` (correct ABI for the Rust cargo wasm-EH world; only matters if a future crate doesn't ship with `panic=abort`)
   - Add `-sSUPPORT_LONGJMP=wasm` (RmlUi/freetype use setjmp; pre-empt the well-known wasm-EH+sjlj collision)
   - Add `-sASSERTIONS=1` (clearer runtime errors at the small cost of bundle size)
   - Add `-sENVIRONMENT=web,worker` (drops Node-only paths from the runtime JS)
   - Drop `threading` from nod's Cargo features for the wasm target (avoids `pthread_*` undefineds without forcing COOP/COEP)
3. **Phase 2 runtime triage** — when the browser test fires, expect: WebGPU device acquisition issues (Dawn validation messages), ISO file size handling under IDBFS quotas (TP CISO is ~1 GB), Asyncify stack overflow on Aurora's deeper command-processor chains.
4. **Switch Rust to MSVC** (cleanup) — MSVC Build Tools is now installed; `rustup default stable-x86_64-pc-windows-msvc` would let us uninstall LLVM-MinGW + remove the gnullvm Rust toolchain. Build is currently green on gnullvm so this is purely a normalization task.
5. **CI** — push the branch and let `.github/workflows/web.yml` build it on a Linux runner where most of the Windows-specific tooling complexity (cmd.exe argv limit, dlltool, gnullvm) is irrelevant. The workflow as written should work without any of the session-3/4 Windows workarounds.

### Issue #14 — original three-options writeup (kept for history)

Dusk's `src/dusk/ui/` (47 files) implements an in-game UI system on top of RmlUi. Aurora
provides RmlUi via the `AURORA_ENABLE_RMLUI` cache var, which we've held OFF because
Aurora's `lib/rmlui.hpp` directly `#include <dawn/webgpu_cpp.h>` (the native Dawn header,
not in emdawnwebgpu). Dusk's own UI headers `#include <RmlUi/Core.h>`; with RmlUi off
those includes fail.

Three viable next steps:

1. **Build RmlUi for emscripten** — RmlUi v6+ documents some emscripten support. Would
   require also patching aurora's `lib/rmlui.hpp` and `lib/rmlui/WebGPURenderInterface.cpp`
   to use `<webgpu/webgpu_cpp.h>` (emdawnwebgpu's path) instead of `<dawn/webgpu_cpp.h>`.
   Smallest scope but unknown runtime risk (RmlUi's WebGPU backend may have its own
   Dawn-API drift like imgui did).

2. **Stub out dusk's UI namespace** — replace the 47 `src/dusk/ui/` files with a single
   `dusk_ui_stub.cpp` that defines `dusk::ui::initialize()`, `shutdown()`, `update()`,
   `handle_event()`, `push_document()`, plus Document/Overlay/MenuBar constructors as
   no-ops. Caller sites (`m_Do_main.cpp`, `d_s_play.cpp`, etc.) continue to compile but
   the in-game UI never renders. Largest scope but most predictable runtime.

3. **Disable dusk's UI conditionally** — gate every `dusk::ui::` call site under
   `#ifndef __EMSCRIPTEN__`. ~10 caller files to patch, plus dropping the 47 UI sources
   from the build under emscripten. Medium scope.

The link step (`emcc` linking the wasm + JS shell + index.data) hasn't been attempted —
likely more issues there (Asyncify imports for FS, WebGPU async bindings, missing
exports).

## Runtime triage (post-build, session 5+)

By the end of session 4 the wasm bundle was building cleanly and Aurora was reaching
`gfx::initialize` in a real Chrome browser. Subsequent sessions have iterated against
the headful Puppeteer smoke test (`tools/browser-smoke/smoke-import.mjs --headful`) to
push the boot further. Key findings worth carrying forward:

- **`OSResumeThread()` is the threading chokepoint.** `src/dusk/OSThread.cpp:354` is
  where every game thread (DVD, MemCard, audio decode, etc.) actually constructs
  `std::thread`. Without `-pthread` this throws `std::system_error: thread constructor
  failed: Not supported`. Fix: gate the spawn with `#ifdef __EMSCRIPTEN__` and log
  instead. Game continues but worker-threaded subsystems silently lose their workers —
  expect black-canvas symptoms (DVD read never completes, audio never decodes). A real
  fix needs cooperative scheduling (Asyncify yields out of the entry function body,
  pumped from the emscripten main loop) or per-subsystem inline replacements.
- **CRASH("...not implemented") audit (sub-agent, session 5):** the only "TODO over
  working impl" instances were `OSDetachThread` and `OSCancelThread` (now removed). The
  remaining 7 stubs are all in `src/dusk/audio/DspStub.cpp` and are genuine empty
  bodies (DSP not emulated; software DuskDsp covers the actual audio path). The other
  `CRASH(...)` sites are conditional guards (unknown audio formats, malformed JPEG,
  null `FILE*`) — not blockers.
- **RmlUi cannot be cleanly disabled.** `AURORA_ENABLE_RMLUI=OFF` breaks the dusk build
  because `src/dusk/ui/event.hpp:3` (and its 47-file `dusk::ui::*` family)
  unconditionally includes `<RmlUi/Core.h>`. Until the conditional-disable refactor
  (option 3 in the Build Issue Catalog above) is done, RmlUi must stay on, and the
  depth/stencil validation errors it emits each frame must be tolerated. They were
  downgraded from FATAL to ERROR in `extern/aurora/lib/webgpu/gpu.cpp` so they don't
  abort the runtime.
- **IDBFS per-blob cap (~1 GB in Chrome).** TP CISO is 1054 MB and `FS.syncfs(false)`
  rejects with `InvalidBlob`. `iso_bridge.js` was made best-effort — the CISO stays in
  MEMFS for the session and the user re-uploads after a reload. Persistence is a
  Phase-6 problem; chunking into multiple IDB rows would solve it but isn't required
  for a playable v1.
- **MapAsync callback mode.** Aurora used `wgpu::CallbackMode::AllowSpontaneous` in
  `lib/gfx/common.cpp` and `lib/gfx/depth_peek.cpp` — that's a Dawn-only extension that
  emdawnwebgpu rejects. Switched to `AllowProcessEvents` (spec-compliant, also valid
  on native Dawn).
- **Unconditional `std::thread` spawns gated under `__EMSCRIPTEN__`:**
  `extern/aurora/lib/gfx/pipeline_cache.cpp:start_pipeline_cache_writer` (return early),
  `src/dusk/ui/prelaunch.cpp` `DiscVerificationTask`/`UpdateCheckTask` (run inline), and
  `extern/aurora/cmake/AuroraNodProvider.cmake` (set `NOD_THREADING=OFF`). The
  `pipeline_cache.cpp:initialize_pipeline_cache` worker is *already* gated by backend
  type (skipped when `g_backendType == WebGPU`), so no extra `__EMSCRIPTEN__` guard
  needed there.
- **Boot reaches `main01`.** With the above fixes Aurora finishes init, the game disc
  is identified as `GZ2P01` (TP EUR), JKRHeap initializes, ARAM is allocated, two PC
  OSThreads are created (priorities 6 and 8 — DVD and MemCard, presumably). The
  `OSResumeThread` skip means those threads' bodies never run; canvas stays black.
  Next: cooperative thread scheduling, or an inline replacement for the DVD reader.

## Build iteration speed

- Default `web-emscripten` preset inherits `relwithdebinfo` → embedded DWARF in the wasm
  → emcc warns "running limited binaryen optimizations because DWARF info requested".
  This is the dominant cost: each link is ~30–60 s, wasm is ~197 MB, and binaryen runs
  a near-no-op pass over a 200 MB binary on every link.
- **`web-emscripten-fast` preset** (added session 5): inherits `web-emscripten` but
  overrides `CMAKE_BUILD_TYPE=Release`. Drops embedded DWARF, lets binaryen run normal
  passes. Function-name stack traces survive via `--profiling-funcs`. Use for the
  inner-loop iterate-debug cycle; fall back to the default preset when source-level
  stepping is needed.
- A first-time configure of any new preset triggers FetchContent for Dawn/SDL3/freetype
  etc. The `freetype` upstream URL flakes intermittently with HTTP 502 — workaround is
  to point a new build at an existing freetype source via
  `-DFETCHCONTENT_SOURCE_DIR_FREETYPE=<path-to-existing>/freetype-src`.

## Explicit deferrals (not blockers, just out of scope for v1)

- **RmlUi** — no documented Emscripten target; gated off via `AURORA_ENABLE_RMLUI=OFF`.
  Any in-game RmlUi usages will need ImGui equivalents before they're reachable.
- **PWA + service worker** — slider has it (`sw.js`, `manifest.webmanifest`,
  cache-versioning via git SHA). Adds complexity; not needed for first playable demo.
- **Touch overlay** — slider uses nipplejs. Defer until v1 plays on desktop.
- **Postfx** — CRT/ASCII/halftone/LCD shaders. Deferred.
- **USA / JPN ISO support** — only EUR SHA-1 is verified.
- **Mobile / iOS App Store** — Dusk has a native iOS build; the WASM port targets desktop
  browsers first.
- **Discord, sentry-native, update checker, libjpeg-turbo (movie)** — all gated off via
  `DUSK_ENABLE_*=OFF` cache vars in the `web-emscripten` preset; none are ported to
  Emscripten.
- **Cheats / mod loader** — not in upstream.

## Threading

Build single-threaded first (no `-pthread`, no COOP/COEP). emdawnwebgpu offloads thread
marshaling to the browser's JS event loop. If Aurora deadlocks on `std::thread` joins,
fall back to `-pthread -sPTHREAD_POOL_SIZE=8` and serve with
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`.
Decision deferred to Phase 4.

## File map (this branch's WASM-port additions)

| Path                                                          | Type | Purpose                                               |
|---------------------------------------------------------------|------|-------------------------------------------------------|
| `cmake/Toolchain-emscripten.cmake`                            | new  | resolves $EMSDK / $EMSCRIPTEN to Emscripten.cmake     |
| `tools/emsdk-version`                                         | new  | pinned emsdk version (`5.0.6`)                        |
| `web/shell.html`                                              | new  | drop-zone shell for `--shell-file`                    |
| `web/iso_bridge.js`                                           | new  | ISO → CISO converter + SHA-1 verify                   |
| `web/pre.js`                                                  | new  | IDBFS mounts (`/save`, `/iso`) loaded via `--pre-js`  |
| `.github/workflows/web.yml`                                   | new  | GH Pages CI/CD                                        |
| `docs/wasm-port-notes.md`                                     | new  | this file                                             |
| `CMakePresets.json`                                           | edit | adds `web-emscripten` configure + build preset        |
| `CMakeLists.txt`                                              | edit | gates Win32/res-copy/RmlUi; appends `if(EMSCRIPTEN)` block |
| `src/dusk/main.cpp`                                           | edit | adds `__EMSCRIPTEN__` no-op arm to `RestartProcess`   |
| `extern/aurora/cmake/AuroraDawnProvider.cmake`                | edit | adds 5th `emscripten` provider mode                   |
| `extern/aurora/lib/dawn/BackendBinding.cpp`                   | edit | adds `SDL_PLATFORM_EMSCRIPTEN` canvas-selector arm    |
| `extern/aurora/lib/card/DolphinCardPath.cpp`                  | edit | returns `/save/...` paths under `__EMSCRIPTEN__`      |

# Dusk → WebAssembly port

Multi-week port of the TwilitRealm Twilight Princess decompilation to a static GitHub
Pages site that boots in any modern WebGPU-capable browser after a one-time EUR ISO
upload. Strategic plan: `../PLAN.md`. Detailed build-issue catalog + deferrals:
`docs/wasm-port-notes.md`. **Read both before substantive changes.**

## Where we are (2026-05-11)

**Deployed and live at https://sh1ftmaker.github.io/dusk-wasm/.** Fork is at
https://github.com/sh1ftmaker/dusk-wasm (branch `wasm-port`, default branch). README
banners it as unofficial; not affiliated with TwilitRealm.

Headful Puppeteer smoke against the live URL (and the local fast build) consistently
boots to the prelaunch "WELCOME TO DUSK" preset selection screen, accepts clicks, and
advances to "NO CONTROLLER ASSIGNED". 12k+ events, 0 PAGEERRORs, ~70 main01 loop
iterations per session. The wasm runtime stays healthy; the test harness times out
watching the canvas, not the game.

**What's working end-to-end:** ISO upload → in-browser CISO conversion + SHA-1 verify
→ wasm boot → Aurora WebGPU surface → JKRHeap + ARAM → 5 OSThreads created (their
bodies silently no-op'd — see deferral below) → `fapGm_Create` → `cDyl_InitAsync` →
`main01` loop → `fpcM_Management` cycles → RmlUi prelaunch UI renders → click input
dispatches into the SDL event loop → UI advances.

**Hard requirement on the user side:** Chrome with hardware-accelerated WebGPU. If
`chrome://gpu/` shows software-fallback (SwiftShader), the WebGPU Instance gets
reclaimed mid-session and every MapAsync returns Aborted. Toggle "Use graphics
acceleration when available" in `chrome://settings/system` on. This is a Chrome
config requirement, not a fork bug.

## Build, smoke, iterate

```powershell
# One-time first build (slow — full cargo + emcc, ~25 min):
emcmake cmake --preset web-emscripten-fast
cmake --build --preset web-emscripten-fast

# Inner-loop iteration (~6 min when one .cpp changes):
cmake --build --preset web-emscripten-fast

# Smoke against a local build:
Get-Process python | Stop-Process -Force        # always kill stale http servers first
cd build/web-emscripten-fast/web
python -m http.server 8081 --bind 127.0.0.1     # in one shell
cd tools/browser-smoke
node smoke-import.mjs --headful http://127.0.0.1:8081/

# Smoke against the live GH Pages deployment:
node smoke-import.mjs --headful https://sh1ftmaker.github.io/dusk-wasm/
```

Smoke output: `tools/browser-smoke/smoke-import-screenshot.png` (welcome dialog),
`smoke-import-after-click.png` (controller prompt), plus full stdout console capture.
Useful filters: `OSResumeThread`, `Skipping native`, `Created thread`, `PAGEERROR`,
`FATAL`, `main01`, `Loaded game disc`, `fpcM_Management step=`.

## Two build presets

| Preset | Build type | DWARF | Wasm size | Use for |
|---|---|---|---|---|
| `web-emscripten` | RelWithDebInfo | embedded | ~197 MB | source-stepping in DevTools |
| `web-emscripten-fast` | Release | none | ~32 MB | iteration; `--profiling-funcs` keeps function names in stack traces |

CI (`.github/workflows/web.yml`) uses `web-emscripten` (full DWARF for upstream debugging).

## Five hard-won gotchas

1. **Stale `python -m http.server` keeps port 8081 silently.** No error, just exits.
   Subsequent runs talk to the OLD wasm. Always
   `Get-Process python | Stop-Process -Force` before starting a new server.
2. **Chrome caches wasm hard.** The smoke test sets `page.setCacheEnabled(false)` —
   leave it.
3. **Freetype upstream (savannah.gnu.org) 502s/timeouts intermittently.** CI works
   around it via mirror fallback + `FETCHCONTENT_SOURCE_DIR_FREETYPE`; locally, point
   a fresh build at an existing extracted source the same way.
4. **`AURORA_ENABLE_RMLUI=OFF` breaks the build** — dusk's UI headers
   (`src/dusk/ui/event.hpp:3` + 47-file `dusk::ui::*` family) unconditionally
   `#include <RmlUi/Core.h>`. Until that's refactored, RmlUi stays on; the per-frame
   depth/stencil validation noise is non-fatal (downgraded from FATAL to ERROR in
   `extern/aurora/lib/webgpu/gpu.cpp`).
5. **Wasm needs explicit yields to JS or it monopolises the tab.** Two yields in
   place: top of `m_Do_main.cpp`'s `main01` loop, and inside `begin_frame`'s
   MapAsync wait spin in `extern/aurora/lib/gfx/common.cpp`. Any other
   busy-spin-with-async-callback pattern in Aurora will need the same —
   `g_instance.ProcessEvents()` alone doesn't pump JS callbacks under wasm.

## Open work, by priority

1. **Cooperative thread scheduler.** The five game-side worker threads (DVD,
   MemCard, audio decode, ...) are silently no-op'd by the `OSResumeThread` skip
   under emscripten. Anything past the prelaunch UI that needs disc I/O won't
   advance until they run. Three viable paths:
   - **Asyncify-yielding inline scheduler** *(recommended start)*. Run thread
     bodies inline on the main thread; blocking primitives (`OSWaitCond`,
     `OSReceiveMessage`, etc.) call `emscripten_sleep(0)`. Asyncify is already
     wired (`-sASYNCIFY=1`). Every blocking primitive in `src/dusk/OSThread.cpp`
     needs an Asyncify-aware variant.
   - Per-subsystem inline replacement (DVD reader synchronous, etc.). Smaller
     blast radius but loses concurrency.
   - Real `-pthread` build with COOP/COEP headers via a service worker (GH Pages
     can't set custom response headers natively). Biggest infra change.
   See `~/.claude/projects/.../memory/project_dusk_wasm_threading.md` for the
   detailed analysis.
2. **Trim debug instrumentation** before this stops being a moving target. Files
   with temporary `>>>`-prefixed `OSReport`/`Log.info` lines:
   - `src/dusk/OSThread.cpp` (OSResumeThread, OSCreateThread)
   - `src/m_Do/m_Do_main.cpp` (main01 iter)
   - `src/f_pc/f_pc_manager.cpp` (fpcM_Management step=)
   - `extern/aurora/lib/aurora.cpp`, `lib/gfx/common.cpp`,
     `lib/gfx/depth_peek.cpp`, `lib/webgpu/gpu.cpp`
   Useful while iterating; cut when the port stabilises.
3. **Intermittent "Destroyed texture used in submit" warnings** (~14–24 per
   session, non-fatal). The swapchain texture occasionally gets reclaimed
   between `begin_frame` and `end_frame`. Probably a race in `refresh_surface`.
   Lower priority — doesn't block rendering, but worth chasing for a clean log.
4. **RmlUi proper depth/stencil fix.** Current fix pins
   `depthWriteEnabled=False` for the Stencil8-format pipelines, which is
   correct, but each frame still emits a validation warning. Investigate
   whether the `DepthStencilState` should be `nullptr` instead of a populated
   struct when the format is stencil-only.

## CI (`.github/workflows/web.yml`)

Pushes to `wasm-port` trigger a single workflow that builds the
`web-emscripten` preset on Ubuntu and deploys the result to GitHub Pages.
Caches in place:

- `~/.cargo/{registry,git}` keyed on `extern/aurora/cmake/AuroraNodProvider.cmake`
- `build/web-emscripten/_deps` keyed on `extern/aurora/extern/CMakeLists.txt`
  + Aurora Provider cmake files
- sccache via `mozilla-actions/sccache-action` (Rust); ccache via
  `hendrikmuhs/ccache-action` (C++). Both wrapped in `continue-on-error` +
  probe-and-fallback so a GHA cache-service outage doesn't kill the run.
- emsdk via `setup-emsdk`'s built-in `actions-cache-folder`.

Freetype is pre-fetched with `curl --retry` against savannah.gnu.org first then
the GitLab/savannah mirrors, dropped into `_deps/freetype-src`; configure passes
`FETCHCONTENT_SOURCE_DIR_FREETYPE` so the FetchContent step skips network entirely.

Pages environment has `wasm-port` added to its deployment-branch-policy
(originally created targeting `main`, was 2-second instant-fail until I added the
branch). Worth knowing if you ever rename the branch.

## Cross-session memory layout

`~/.claude/projects/C--Users-shift-Desktop-dusk-wasm/memory/`:
- `MEMORY.md` — index
- `project_dusk_wasm_port.md` — points at this CLAUDE.md + the notes
- `project_dusk_wasm_threading.md` — current threading state + cooperative-scheduler options
- `reference_emsdk_install.md` — emsdk activation under PowerShell exec policy
- `feedback_parallel_agents.md` — user prefers parallel general-purpose agents for independent authoring

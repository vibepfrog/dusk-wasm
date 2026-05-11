# Dusk → WebAssembly port

Multi-week port of the TwilitRealm Twilight Princess decompilation to a static GitHub
Pages site that boots in any modern browser after a one-time EUR ISO upload. The
strategic plan lives at `../PLAN.md`. Detailed running notes (build issue catalog,
explicit deferrals, file map of WASM-port additions) live at `docs/wasm-port-notes.md`.
**Read both before making changes.**

## Where we are (2026-05-10, updated)

**🎉 The Dusk "WELCOME TO DUSK" preset UI renders in real Chrome.** Boot
reaches the prelaunch UI with the Classic/Dusk preset selection buttons,
fully styled — RmlUi-on-WebGPU-via-emdawnwebgpu working end-to-end.
Smoke test runs ~50 main01 iterations per session before the test harness
times out (game keeps running fine; harness just stops watching).

**Chain of fixes that unlocked the UI**, in dependency order:

1. `OSResumeThread` chokepoint (`src/dusk/OSThread.cpp:354`) — single
   `#ifdef __EMSCRIPTEN__` skip stops `std::thread` spawn aborts for all
   game threads (DVD, MemCard, audio, etc).
2. `emscripten_sleep(0)` at top of `m_Do_main.cpp`'s `main01` loop —
   yields to JS each iteration so the browser can paint.
3. `emscripten_sleep(0)` inside `aurora/lib/gfx/common.cpp` `begin_frame`
   MapAsync wait spin — emdawnwebgpu callbacks fire from JS event loop.
4. ~80 function-pointer signature widenings across `f_pc/`, `f_op/`,
   `d/actor/*`, plus `cAPIGph_IntMthd` typedef split — wasm CFI is strict
   where native compilers tolerated `(WideFunc)narrowFn` casts.
5. `wgpuSurfacePresent` skipped under `__EMSCRIPTEN__` in
   `aurora/lib/aurora.cpp` — emdawnwebgpu intentionally unsupports it
   (browser auto-presents).
6. Rust `panic_unwind` shim at `web/unwind_shim.js` wired via
   `--js-library` — nod's transitive deps emit `_Unwind_RaiseException`
   imports even with workspace `panic=abort`.
7. RmlUi `DepthStencilState` pinned to `depthWriteEnabled=False` +
   `depthCompare=Undefined` (3 sites in `WebGPURenderInterface.cpp`) —
   emdawnwebgpu's default differs from native Dawn for Stencil8 format.
8. `WebGPURenderInterface::BeginLayerPass` `RenderPassDepthStencilAttachment`
   explicitly initialized depth fields — uninit float read as NaN by JS bridge.
9. `aurora.cpp begin_frame` reordered: `gfx::begin_frame()` (with its
   yielding MapAsync wait) called BEFORE `g_surface.GetCurrentTexture()`
   so browser doesn't reclaim the swapchain texture during the yield.

**Current state:** UI shows. The game loop runs cleanly with no abort.
Some residual "Destroyed texture used in submit" WebGPU validation warnings
(~24 per smoke session) — non-fatal, intermittent surface reacquisition
loss. Worth chasing next but not blocking.

**What's still skipped:** the 5 game-side worker threads (DVD reader,
MemCard, audio decode) are silently no-op'd by the OSResumeThread skip.
Disc-streamed game content (movies, dialog audio, level data) won't
appear until those have a cooperative scheduler. The prelaunch UI is
rendering because it doesn't need disc I/O.

## How to build, smoke-test, and iterate

```powershell
# One-time first build (slow — full cargo + emcc, ~25 min):
emcmake cmake --preset web-emscripten-fast
cmake --build --preset web-emscripten-fast

# Inner-loop iteration (~6 min when one .cpp changes):
cmake --build --preset web-emscripten-fast

# Smoke-test against real Chrome via Puppeteer:
#   1. Kill any stale python http servers (see gotchas below)
#   2. Start http server in the build's web/ dir:
cd build/web-emscripten-fast/web
python -m http.server 8081 --bind 127.0.0.1
#   3. Run the headful smoke (in another shell):
cd tools/browser-smoke
node smoke-import.mjs --headful http://127.0.0.1:8081/
```

The smoke output goes to `tools/browser-smoke/smoke-import-screenshot.png` plus
stdout. Filter `OSResumeThread`, `Skipping native`, `Created thread`, `PAGEERROR`,
`FATAL`, `aurora::ar`, `main01` for the interesting lines.

## The two presets

- **`web-emscripten`** — RelWithDebInfo, embedded DWARF, ~197 MB wasm, 30–60 s
  per relink. Use for source-stepping debug.
- **`web-emscripten-fast`** — Release, no DWARF, ~32 MB wasm, ~6 min for an
  incremental link of one .cpp change (binaryen runs full opt passes which now
  matters; first link is slower but subsequent are faster). Use for iteration.
  Function-name stack traces still work via `--profiling-funcs`.

## Critical gotchas (these will burn you again if you forget)

1. **Stale python http servers silently keep port 8081.** `python -m http.server`
   doesn't error when the port is taken — it just exits silently. Your "new" server
   is dead and Puppeteer talks to the OLD wasm. **Always run
   `Get-Process python | Stop-Process -Force` before starting a new server.**
2. **Chrome caches wasm aggressively.** The smoke test now sets
   `page.setCacheEnabled(false)` (`tools/browser-smoke/smoke-import.mjs`); leave
   that in.
3. **Freetype upstream 502s intermittently** during first-time configure. Workaround
   is to point a new build at an existing freetype source via
   `-DFETCHCONTENT_SOURCE_DIR_FREETYPE=<path-to-existing>/freetype-src`.
4. **Disabling RmlUi (`AURORA_ENABLE_RMLUI=OFF`) breaks the build** because dusk's
   UI headers (`src/dusk/ui/event.hpp:3` and the 47-file `dusk::ui::*` family)
   unconditionally include `<RmlUi/Core.h>`. Until that's refactored, RmlUi must
   stay on. The depth/stencil validation errors it emits each frame are non-fatal
   (downgraded from FATAL to ERROR in `extern/aurora/lib/webgpu/gpu.cpp`).
5. **Emscripten compiles C++ with `-fno-exceptions` by default.** Aurora needs
   `-fexceptions` at compile (already wired in `CMakeLists.txt`); changing this
   silently elides every `try/catch` in the codebase.
6. **Wasm needs explicit yields to JS or it monopolizes the browser.** Two
   places already have `emscripten_sleep(0)`: top of `m_Do_main.cpp`'s `main01`
   loop, and inside the `begin_frame` MapAsync wait spin in
   `aurora/lib/gfx/common.cpp`. Any other busy-spin-with-async-callback patterns
   in Aurora will need the same treatment — `g_instance.ProcessEvents()` alone
   doesn't pump JS callbacks under wasm.

## What's next

The UI renders; the immediate blocker class (CFI mismatches, missing yields,
emdawnwebgpu defaults) is resolved. The interesting work now:

1. **Click through the prelaunch UI to start the actual game.** The smoke test
   currently just observes; doesn't interact. Add a Puppeteer click on the
   "Dusk" preset button + whatever comes next, then re-screenshot. Likely
   reveals the next round of issues at the boundary into actual gameplay
   (which will exercise the disabled DVD/MemCard/audio threads).
2. **Cooperative thread scheduler.** Per `project_dusk_wasm_threading.md`,
   three approaches in order of risk: Asyncify-yielding inline scheduler,
   per-subsystem inline replacement (DVD reader synchronous), or real
   `-pthread` build. Start with the Asyncify approach. This unblocks
   anything past the prelaunch UI that needs disc I/O.
3. **Fix intermittent "Destroyed texture used in submit" warnings.** ~24 per
   session, non-fatal. The surface texture is occasionally being reclaimed
   between begin_frame and end_frame. May be a race in the swapchain refresh
   path. Lower priority since it doesn't block rendering.
4. **Trim debug instrumentation.** `src/dusk/OSThread.cpp` (the
   `>>> OSResumeThread` logs), `src/m_Do/m_Do_main.cpp` (`>>> main01 iter` logs),
   `src/f_pc/f_pc_manager.cpp` (`>>> fpcM_Management step` logs), plus the
   diagnostic `>>>` lines in aurora's gfx/, webgpu/, and aurora.cpp from
   earlier sessions. Useful while iterating; trim when the port is stable.

## Open instrumentation worth keeping or removing

`src/dusk/OSThread.cpp` currently has temporary `OSReport(">>> OSResumeThread ...")`
diagnostic logs and a per-thread `func=%p` annotation in `OSCreateThread`. Useful
for tracing thread lifecycle during the cooperative-scheduler work; should be
trimmed back to one-line per spawn before this is ready for v1 demo.

`extern/aurora/lib/gfx/common.cpp`, `lib/gfx/depth_peek.cpp`, `lib/webgpu/gpu.cpp`,
and `lib/aurora.cpp` also have `Log.info(">>> ...")` instrumentation from earlier
sessions. Same story.

## Memory and notes layout

Cross-session memory is at `~/.claude/projects/C--Users-shift-Desktop-dusk-wasm/memory/`.
Three project memories currently live there:
- `project_dusk_wasm_port.md` — points at this CLAUDE.md and the notes
- `project_dusk_wasm_threading.md` — current threading state + the three options
- `reference_emsdk_install.md` — emsdk activation under PowerShell exec policy
- `feedback_parallel_agents.md` — user wants parallel general-purpose agents for
  independent authoring work

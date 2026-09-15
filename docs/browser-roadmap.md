# Browser roadmap and validation

## Browser defaults and remembered settings

The browser build uses these existing controls by default:

| Control | Default binding |
| --- | --- |
| Settings | Number-row **0** |
| Turbo (hold) | Number-row **9** |
| D-pad Up / Down / Left / Right | **[** / **'** / **;** / **#** |
| L / R trigger | Left / right mouse button |

The **#** binding uses the UK #/~ key beside Enter (DOM `Backslash`), following
the existing physical-key binding system. Both mouse triggers supply the existing
digital click and full analog squeeze. These are default mapping changes;
controller configuration continues to use the existing binding editor.
Advanced settings, when enabled, open with **Shift+0**. Desktop builds retain
their existing shortcuts and defaults.

Free Camera, Mouse Camera and Turbo Key default to **On**. Gyro Input Method
defaults to **Mouse**, with **0%** deadband and smoothing. This does not itself
enable Gyro Aim. Resolution defaults to **Auto**; initial window creation reads
the canvas CSS dimensions and lets SDL apply pixel density, without the desktop
minimum-size call that previously reset browser geometry until a resize.

Dusk's `config.json` preferences are remembered in this browser profile and
origin using `localStorage` (`dusk-settings-v1`). They are restored before native
startup and saved on each completed settings change. Explicit saved values take
precedence over defaults. Disc paths/verification are session-specific and are
excluded; campaign saves and shader recipes retain their separate stores.
Controller/keyboard binding files are not part of this preference store.
Clearing site data removes these preferences. If storage is unavailable, settings
remain usable for the current session.

## Mouse Camera

Backport source: [TwilitRealm/dusklight at ddc79d1](https://github.com/TwilitRealm/dusklight/tree/ddc79d151edf8291ee444a8d8ea0ed156fc6f0aa), specifically the mouse camera pixel-to-angle conversion, settings names, and `dCamera_c::freeCamera` integration. This is a targeted backport, not a rebase of all newer upstream features.

Open **0 → Input → Mouse → Mouse Camera**. Sensitivity ranges from 25% to 400%; **Invert Mouse Y** reverses vertical rotation. Close settings and click the canvas to capture the mouse. Escape releases capture; opening 0 settings or leaving the tab also releases it. On returning, click to capture again. **Free Camera** need not be enabled. Camera restrictions such as targeting and scripted camera styles remain in place.

The browser requests pointer lock synchronously inside the page click handler, because a proxied SDL call on the render worker loses the originating user gesture. It accumulates relative pixel movement and consumes it once per simulation tick, sharing that sample with this branch's existing **Gyro Input Method → Mouse** aiming mode. Camera sensitivity and the existing gyro aiming sensitivity remain independent. Interpolated render frames do not replay or scale mouse input.

The newer upstream separate Mouse Aim UI and menu-pointer module are not part of this backport. Existing mouse-as-gyro aiming remains available.

## Frame pacing and shader stutter

- With **Unlock Framerate** and **Enable VSync** on, the render pthread now awaits the browser's animation-frame callback before beginning a frame. This follows the display refresh cadence rather than submitting as fast as a zero-delay timer permits. A 100 ms watchdog keeps focus and pause processing alive if background-tab animation callbacks stop. Original-speed rendering and Turbo retain their existing timer/limiter path.
- **Prepare saved shaders before play** already loads validated, previously observed pipeline recipes from IndexedDB and compiles them through `CreateRenderPipelineAsync` before gameplay. It stores descriptions, not portable driver binaries. Previously unseen rendering states can still incur first-use work. The live path still makes every required pipeline available before draw replay; skipping unready draws would reintroduce missing graphics.
- `[FrameProfile]` now reports completed render-loop frames (`render_fps`), actual simulation iterations (`sim_hz`), interpolated-frame counts and loop-time min/average/p95/max every five seconds. These are CPU-side rates, not proof that the display physically presented every submitted frame. p95 uses at most the latest 2048 loop samples. Paused periods affect the reported rates.
- `[PipelineDiag]` reports native pipeline creation-call time. Synchronous WebGPU creation can defer driver work, so a small number there does not rule out shader stalls later at submission. Texture decompression/uploads, disc reads and GPU saturation are other possible contributors.

Compare a repeatable route on a cold launch and then after relaunching with shader preparation enabled. For a useful high-refresh sample, leave the tab visible for at least five seconds after loading finishes; expect `sim_hz` near 30 with `render_fps` near the supported display rate when the machine keeps up. Compare VSync on/off and original/HD textures to distinguish pacing from texture load pressure. Neither measured stutter reduction on the user's GPU nor complete interpolation coverage is established by a successful build alone.

Cloudflare's asynchronous server APIs cannot compile WebGPU pipelines for the client's GPU. Hosting can improve bundle delivery and isolation headers. Further shader work should use measured first-use stalls to guide broader recipe coverage, bounded preparation batches and earlier compilation of known upcoming states.

## Existing high-refresh implementation

| Mode | Simulation | Rendering |
| --- | --- | --- |
| Unlock Framerate off | One simulation step per original-speed frame, normally about 29.97 FPS through JFWDisplay's original limiter | Original-speed frames |
| Unlock Framerate on, VSync on | Fixed `1/30` second simulation period; at most two catch-up ticks per render iteration | Interpolated frames paced by browser animation callbacks |
| Unlock Framerate on, VSync off | Same fixed simulation period | Uncapped timer-driven rendering; browser presentation is still controlled by the compositor |
| Turbo held, if enabled | Normal interpolation is bypassed; game timing can accelerate | Existing Turbo limiter path |

The **Dusk** preset enables Unlock Framerate. Its raw configuration default is false. There is no separate Maximum Framerate selector in this branch.

Code evidence: `src/dusk/game_clock.cpp`, `src/m_Do/m_Do_main.cpp`, `libs/JSystem/src/JFramework/JFWDisplay.cpp`, `src/dusk/frame_interpolation.cpp`. The interpolation path records simulation transforms, interpolates matching previous/current matrices, interpolates the presentation camera, and runs specially marked draw callbacks between simulation ticks. Not every animation/effect is guaranteed to have suitable history. Input and audio updates remain in the simulation loop. Long gaps over 250 ms reset the timeline instead of trying to replay an unlimited backlog.

## Cloudflare Pages preparation

The validated `build/web-emscripten-fast/web` directory is the deployment unit. Keep compilation in the existing pinned GitHub Actions toolchain; deploy its output to Pages rather than duplicating the full compiler setup in a Pages build command.

`web/_headers` already supplies COOP `same-origin`, COEP `require-corp` and CORP `same-origin` for all static paths. The isolation service worker remains useful for GitHub Pages and should be unnecessary on a correctly configured Cloudflare origin. Confirm the response headers and `crossOriginIsolated` on the final site.

Pages currently limits an individual file to **25 MiB**. The previous successful build's Wasm was about 21 MB and data bundle about 8 MB, so both fit. CI now checks that required artifacts stay below the limit. Confirm the entire upload directory before deployment, including any future optional assets. ROMs, texture packs and campaign files are user-selected local files and are not part of the deployment.

Moving from `vibepfrog.github.io` to a Pages/custom domain creates a new storage origin. Export campaign saves first and import them at the new address; IndexedDB saves and learned shader recipes do not automatically migrate. Plan a stable production domain before switching users. Keep GitHub Pages available during validation and rollback. Test the final origin's worker loading, WebGPU, local CISO, pack streaming, save import/export and tab restoration before retiring the old URL.

Cloudflare account/project connection and the production hostname are the remaining deployment inputs. Migration follows gameplay and frame-pacing validation.

References: [worker animation frames](https://developer.mozilla.org/en-US/docs/Web/API/DedicatedWorkerGlobalScope/requestAnimationFrame), [Pointer Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API), [async WebGPU pipeline creation](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createRenderPipelineAsync), [Pages headers](https://developers.cloudflare.com/pages/configuration/headers/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).

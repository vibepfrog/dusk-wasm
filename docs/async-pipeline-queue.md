# Asynchronous pipelines: queue and output protection

Milestone 1 passed the full WASM build and all 64 tests in
[CI run 35201713703](https://github.com/vibepfrog/dusk-wasm/actions/runs/35201713703).
Milestone 2 adds output protection; its 66 local tests pass and integration CI is pending.
Development branch: `async-pipeline-queue`, draft PR #2.
Both stages preserve complete rendering. This does not enable draw skipping or add
the public asynchronous-compilation setting.

## Why this stage exists

The browser previously created the first few new GX/clear pipelines synchronously
inside the cache lock, then synchronously drained remaining misses before replay.
Saved recipe warmup used the asynchronous API followed by an immediate blocking
wait for each pipeline. Those paths cannot support gameplay that continues during
compilation safely.

The new queue separates requests, GPU submission, completion and cache publication.
Successful compilation is published under the original pipeline key even when no
subsequent draw asks for that key. A callback does **not** regenerate pixels from
an earlier frame. For this milestone every draw, EFB copy, depth readback and
one-time producer still waits for its required pipelines before encoding. Later
work must classify/protect output dependencies before allowing any skipped draws.

## Ownership and service contract

- `gfx/async_pipeline_queue.hpp` is a single-owner queue on the renderer pthread.
  Jobs move through Queued, Compiling, Ready, Failed or Cancelled. Queueing performs
  no GPU calls. Immutable configurations are captured by value in factories.
- Duplicate keys share one job, including failures. Priority requests promote
  queued background work; after eight priority submissions an older background
  job gets a turn. First-use frame metadata remains the minimum seen.
- At most **two** jobs compile concurrently. Ordinary update service starts at
  most **one** job per call. Protected warmup/frame waits may fill both slots.
  These are conservative initial constants, not measured optimal values. They
  bound submissions and concurrency, not total queue size or one call's CPU time.
  WGSL generation and shader-module creation can still take synchronous CPU time.
- A completion owns a stable job and a weak renderer state. Reset/cancellation
  invalidates that state/epoch. Late or duplicate callbacks release their result
  without populating a replacement cache. Failed jobs retain their error and do
  not retry every frame. Shutdown releases queued factories and cached results.
- `gfx/pipeline_async.hpp` submits `CreateRenderPipelineAsync` with
  `AllowProcessEvents`, retains input C handles and copies callback error text.
  Completed pipelines are installed by service, outside callback execution.
- `gfx/pipeline_cache.cpp::service_pipeline_compilation` calls `ProcessEvents`
  without holding the cache mutex. It always pumps, even with zero submission
  budget or no new requests. No GPU call or event pump holds `g_pipelineMutex`.
- `aurora.cpp::update` services completion independently of renderability. The
  browser readiness barrier in `aurora.cpp::end_frame`, after FIFO drain and before
  command encoding/surface acquisition, yields with `emscripten_sleep(0)` until
  pipelines are ready. `ProcessEvents` alone cannot run pending JS promises.
- Current-device loss cancels jobs and records an error; an old device cannot
  cancel a replacement's jobs. A protected wait reports compilation/device errors
  explicitly rather than hanging or marking an empty pipeline ready. Automatic
  device reconstruction remains outside this milestone.
- Native creation/worker behavior is retained: its factories receive an empty
  completion and create pipelines synchronously. Native end-frame ordering stays
  unchanged. IndexedDB recipe schema and campaign/settings storage are unchanged.

Diagnostics distinguish successful completions, submissions, failures, pending and
in-flight jobs, CPU submission time and protected wait time. Completion counts are
not submission counts, so the showcase cannot count pending work as prepared.

## Pinned API evidence

[Emscripten 5.0.6's port definition](https://github.com/emscripten-core/emscripten/blob/5.0.6/tools/ports/emdawnwebgpu.py)
pins `emdawnwebgpu v20251002.162335`, Dawn commit
`01940842b667a7812d0e4ca0ef4367fbec294241`. The release package SHA512 was verified
against that definition.

In that package, `webgpu/src/library_webgpu.js` converts the full render-pipeline
descriptor synchronously in `emwgpuDeviceCreateRenderPipelineAsync`, before calling
the browser Promise API. Stack descriptor/array/string storage may therefore
expire after submission. `webgpu/src/webgpu.cpp` tracks the future and delivers
AllowProcessEvents callbacks after removing ready events and unlocking its event
manager. The generated C++ wrapper adopts the returned pipeline handle and deletes
the captured callback after delivery. Do not assume these details for an SDK
upgrade; rerun the bridge fixture.

## Verification and limits

- `web/async_pipeline_queue.test.mjs` compiles the actual queue test with native
  ASan/UBSan. Cases include a request seen once then ignored for 200 service calls,
  duplicates, bounded work, fairness, failed/empty/throwing factories, cancellation,
  epoch replacement, inline reset, and callbacks after queue destruction.
- `extern/aurora/tests/pipeline_async_webgpu_test.cpp` exercises the actual pinned
  WebGPU C++/WASM/JS/Promise bridge with JSPI and PROXY_TO_PTHREAD. Only
  `navigator.gpu` is mocked, allowing delayed
  success and failure. It checks descriptor lifetime, explicit pumping, one-time
  requests, failure text ownership, late results after reset and device-loss
  cancellation. Both local single-thread and renderer-pthread executions passed.
  Node 24 requires `--experimental-wasm-jspi`. This is not a
  GPU-driver performance or shader-validation test.
- `.github/workflows/web.yml` runs both fixtures and builds the complete production
  WASM target on pull requests. PR events skip the deploy job. Do not manually
  dispatch this workflow on the feature branch: non-PR events currently deploy.
- Local suite: **64/64 passed**. Local LeakSanitizer requires
  `ASAN_OPTIONS=detect_leaks=0` because the sandbox cannot inspect `/proc`; ASan and
  UBSan remain enabled. CI uses its normal sanitizer defaults.
- Real cold/warm-cache gameplay, repeated showcase entry, pause/hidden-tab behavior
  under actual GPU compilation, GPU-driver errors, and native full-game runtime
  are not yet verified. No valid game disc/save is available in this workspace.
  Existing browser suspension, storage, controls and showcase regression tests
  pass. No FPS/startup improvement is claimed for this complete-rendering stage.

## Resume checklist

1. Finish milestone 2 integration CI and record the result in the PR/recovery notes.
2. Keep the feature isolated until reviewed/tested with an actual game session.
3. Next milestone: selectively allow disposable draws to skip and add the default-ON
   persisted setting. A completed shader cannot repair a skipped old capture.
4. Preserve the deployed Faron fix (`14fd31c47667e08f239e72c6320a60fcdcd28d06`), input
   defaults, save isolation and existing tab-resume handling. No Cloudflare work.

## Milestone 2: persistent output protection

`pipeline_dependencies.hpp` analyzes the recorded passes in replay order. It tracks
the most recent writer of each retained color/depth attachment identity. Load
operations depend on those writers; full attachment clears break the dependency.
A reverse walk protects the complete transitive producer chain for any copy,
offscreen output, depth snapshot or unclassified destination. Missing attachment
identity, a load with no known current-frame writer, or unknown command types force
complete-frame readiness. Clear draws are individually mandatory. Shader keys
shared by protected and eligible draws are required once, without duplicate jobs.

`common.cpp::prepare_pipeline_dependencies` runs after FIFO drain and before the
existing readiness barrier, encoder creation and surface acquisition. It uses the
same pass-selection rule as replay. All `GXCopyTex` outputs remain protected,
including format conversion, scaling, color and depth copies. All executed
offscreen/nonfinal passes are protected. Consequently sampled copied textures,
including ones reused through `copyTextureCache` or palette conversions, cannot
originate from an intentionally skipped producer. Conversion/copy/presentation and
UI infrastructure pipelines continue their existing synchronous/ready path.

Only the final uncopied EFB presentation pass is a candidate for disposable work,
and it becomes protected when a depth snapshot is already requested. EFB contents
are cleared at the start of each recorded frame. This proof does not extend to a
future renderer that deliberately loads previous-frame attachments: such a change
must track cross-frame completeness rather than assume the fallback can repair old
pixels. Existing full-frame readiness remains active throughout this milestone.

`protect_pipeline_outputs` promotes existing required jobs ahead of ordinary and
background work, preserving the two-in-flight limit, and cooperatively waits for
their actual cache publication. It never waits under a GPU pass, surface lock or
cache mutex. Original jobs still complete without another draw request.

Replay records whether any pipeline was unavailable. A required miss is an explicit
error, and an incomplete EFB copy cannot be published. A depth request arriving
after preflight may use a complete final pass; otherwise `encode_frame_snapshot`
leaves the request pending so the next frame protects its producers. Native callers
keep the old default behavior. No capture command or buffer is retained for replay
on a later frame, avoiding stale scene/resource writes.

`[PipelineProtection]` reports protected/eligible draw counts, unique misses in each
category, conservative fallback frames and dependency-wait time. Eligibility is
potential eligibility, not evidence that any draw was skipped or an FPS gain.
Twilight Princess makes frequent EFB copies: real-game measurements may show that
most expensive misses remain protected. GX HUD/text/fade quality still needs a
targeted audit before enabling the later skip policy; native ImGui settings and
copy/clear infrastructure are outside that policy.

Tests in `pipeline_dependencies_test.cpp` exercise the actual classifier and queue:
retroactive consumer discovery, color/depth load ancestry, clear boundaries,
offscreen/unknown outputs, shared keys, empty/new frames, promotion, limits and
one-time completion after 200 service calls. `web/pipeline_dependencies.test.mjs`
also compiles the actual request-consumption prefix of `encode_frame_snapshot`
with a controlled clock to verify late requests survive an incomplete producer
and throttling. This checks the production gate, not a physical GPU capture.

#include <aurora/aurora.h>

#ifdef AURORA_ENABLE_GX
#include "gfx/common.hpp"
#include "gx/fifo.hpp"
#include "imgui.hpp"
#include "webgpu/gpu.hpp"
#include <webgpu/webgpu_cpp.h>
#endif

#ifdef AURORA_ENABLE_RMLUI
#include "rmlui.hpp"
#endif

#include "input.hpp"
#include "internal.hpp"
#include "window.hpp"

#include <SDL3/SDL_filesystem.h>
#include <magic_enum.hpp>

#include "tracy/Tracy.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

namespace aurora {
AuroraConfig g_config;
uint32_t g_sdlCustomEventsStart;
char g_gameName[4];

#ifdef __EMSCRIPTEN__
// Frame-pipeline diagnostic state. Captures two layers of signal:
//
//  (1) Acquire→submit window for the recurring "Destroyed texture
//      used in submit" WebGPU error. Texture is acquired (late, in
//      end_frame) and timestamped; on Submit we measure elapsed and
//      log a warning if anything went wrong.
//
//  (2) Per-iter (main-loop) profiler. on_iter_begin/on_iter_end
//      bracket a complete main01 iteration. We accumulate min/avg/max
//      iter time + heap usage; every kPeriodFrames frames we dump a
//      summary so the user can spot frame-time spikes, slow
//      steady-state, or growing heap (potential leak).
//
// All log lines are tagged "[FrameDiag]" / "[FrameProfile]" so they
// are easy to filter in browser DevTools.
namespace frame_diag {
// Own logger so we don't need to reach into the anonymous namespace's
// Log instance (which would be invisible from extern "C" functions
// defined at aurora:: scope).
Module Log("aurora::frame_diag");

// -- (1) acquire→submit window --
double surface_acquired_at_ms = 0.0;
double last_submit_elapsed_ms = 0.0;
uint32_t yields_since_acquire = 0;
uint32_t total_warnings_logged = 0;
bool acquired = false;
constexpr double log_threshold_ms = 5.0;
constexpr uint32_t log_throttle_after = 8; // after N warnings, log every 60th

// -- (2) per-iter profiler --
constexpr uint32_t kPeriodFrames = 60;
double iter_start_at_ms = 0.0;
double iter_sum_ms = 0.0;
double iter_min_ms = 1e9;
double iter_max_ms = 0.0;
uint32_t iter_count = 0;
uint64_t total_iter_count = 0;
double last_summary_at_ms = 0.0;
uint64_t last_heap_size = 0;
uint64_t initial_heap_size = 0;

// __builtin_wasm_memory_size(0) returns the wasm linear-memory page count
// (each page = 64 KiB). This is the closest portable analogue to a
// "process memory size" reading we can get without pulling in the
// emscripten heap.h helpers, which moved across emsdk versions.
inline uint64_t heap_size_bytes() noexcept {
  return static_cast<uint64_t>(__builtin_wasm_memory_size(0)) * 65536ull;
}

} // namespace frame_diag

extern "C" void aurora_frame_diag_note_yield() noexcept {
  if (frame_diag::acquired) {
    ++frame_diag::yields_since_acquire;
  }
}

// Called once per main-loop iteration, at the SAME position each time.
// Measures the wall-clock delta from the previous call → this call as the
// duration of the previous iter. Doing it this way (instead of a paired
// begin/end) means `continue` statements in the main loop don't leak the
// iter measurement into the next one — every call delimits an iter.
extern "C" void aurora_frame_diag_iter_tick() noexcept {
  const double now = emscripten_get_now();
  if (frame_diag::iter_start_at_ms == 0.0) {
    // First call — nothing to measure yet.
    frame_diag::iter_start_at_ms = now;
    frame_diag::last_summary_at_ms = now;
    return;
  }
  const double iter_ms = now - frame_diag::iter_start_at_ms;
  frame_diag::iter_start_at_ms = now;

  frame_diag::iter_sum_ms += iter_ms;
  frame_diag::iter_min_ms = std::min(frame_diag::iter_min_ms, iter_ms);
  frame_diag::iter_max_ms = std::max(frame_diag::iter_max_ms, iter_ms);
  ++frame_diag::iter_count;
  ++frame_diag::total_iter_count;

  if (frame_diag::iter_count >= frame_diag::kPeriodFrames) {
    const double window_ms = now - frame_diag::last_summary_at_ms;
    const double avg_ms = frame_diag::iter_sum_ms / frame_diag::iter_count;
    // FPS over the wall-clock window (uses real elapsed time, not just
    // iter sum, so we capture any non-iter overhead between summaries).
    const double fps = (window_ms > 0.0)
        ? (1000.0 * static_cast<double>(frame_diag::iter_count) / window_ms)
        : 0.0;

    const uint64_t heap_now = frame_diag::heap_size_bytes();
    if (frame_diag::initial_heap_size == 0) {
      frame_diag::initial_heap_size = heap_now;
    }
    const int64_t heap_delta_period =
        static_cast<int64_t>(heap_now) - static_cast<int64_t>(frame_diag::last_heap_size);
    const int64_t heap_delta_total =
        static_cast<int64_t>(heap_now) - static_cast<int64_t>(frame_diag::initial_heap_size);

    frame_diag::Log.info(
        "[FrameProfile] iter#{} fps={:.1f} ms(min/avg/max)={:.1f}/{:.1f}/{:.1f}"
        " acq->submit_last={:.2f}ms warns={} heap={}MB (Δ{:+d}MB/period, Δ{:+d}MB total)",
        static_cast<unsigned long long>(frame_diag::total_iter_count),
        fps,
        frame_diag::iter_min_ms, avg_ms, frame_diag::iter_max_ms,
        frame_diag::last_submit_elapsed_ms,
        frame_diag::total_warnings_logged,
        heap_now / (1024 * 1024),
        static_cast<int>(heap_delta_period / (1024 * 1024)),
        static_cast<int>(heap_delta_total / (1024 * 1024)));

    frame_diag::iter_sum_ms = 0.0;
    frame_diag::iter_min_ms = 1e9;
    frame_diag::iter_max_ms = 0.0;
    frame_diag::iter_count = 0;
    frame_diag::last_summary_at_ms = now;
    frame_diag::last_heap_size = heap_now;
  }
}
#endif

namespace {
Module Log("aurora");

#ifdef AURORA_ENABLE_GX
// GPU
using webgpu::g_device;
using webgpu::g_queue;
using webgpu::g_surface;
#endif

#ifdef AURORA_ENABLE_GX
constexpr std::array PreferredBackendOrder{
#ifdef ENABLE_BACKEND_WEBGPU
    BACKEND_WEBGPU,
#endif
#ifdef DAWN_ENABLE_BACKEND_D3D12
    BACKEND_D3D12,
#endif
#ifdef DAWN_ENABLE_BACKEND_METAL
    BACKEND_METAL,
#endif
#ifdef DAWN_ENABLE_BACKEND_VULKAN
    BACKEND_VULKAN,
#endif
#ifdef DAWN_ENABLE_BACKEND_D3D11
    BACKEND_D3D11,
#endif
// #ifdef DAWN_ENABLE_BACKEND_DESKTOP_GL
//     BACKEND_OPENGL,
// #endif
// #ifdef DAWN_ENABLE_BACKEND_OPENGLES
//     BACKEND_OPENGLES,
// #endif
#ifdef DAWN_ENABLE_BACKEND_NULL
    BACKEND_NULL,
#endif
};
#else
constexpr std::array<AuroraBackend, 0> PreferredBackendOrder{};
#endif

bool g_initialFrame = false;

AuroraInfo initialize(int argc, char* argv[], const AuroraConfig& config) noexcept {
  g_config = config;
  Log.info("Aurora initializing");
  if (g_config.appName == nullptr) {
    g_config.appName = "Aurora";
  } else {
    g_config.appName = strdup(g_config.appName);
  }
  if (g_config.configPath == nullptr) {
    g_config.configPath = SDL_GetPrefPath(nullptr, g_config.appName);
  } else {
    g_config.configPath = strdup(g_config.configPath);
  }
  if (g_config.msaa == 0) {
    g_config.msaa = 1;
  }
  if (g_config.maxTextureAnisotropy == 0) {
    g_config.maxTextureAnisotropy = 16;
  }
  ASSERT(window::initialize(), "Error initializing window");

  g_sdlCustomEventsStart = SDL_RegisterEvents(2);
  ASSERT(g_sdlCustomEventsStart, "Failed to allocate user events: {}", SDL_GetError());
  ASSERT(window::initialize_event_watch(), "Error initializing SDL event watch");

#ifdef AURORA_ENABLE_GX
  /* Attempt to create a window using the calling application's desired backend */
  AuroraBackend selectedBackend = config.desiredBackend;
  bool windowCreated = false;
  if (selectedBackend != BACKEND_AUTO && window::create_window(selectedBackend)) {
    if (webgpu::initialize(selectedBackend)) {
      windowCreated = true;
    } else {
      window::destroy_window();
    }
  }

  if (!windowCreated) {
    for (const auto backendType : PreferredBackendOrder) {
      selectedBackend = backendType;
      if (!window::create_window(selectedBackend)) {
        continue;
      }
      if (webgpu::initialize(selectedBackend)) {
        windowCreated = true;
        break;
      } else {
        window::destroy_window();
      }
    }
  }

  ASSERT(windowCreated, "Error creating window: {}", SDL_GetError());

  // Initialize SDL_Renderer for ImGui when we can't use a Dawn backend
  if (webgpu::g_backendType == wgpu::BackendType::Null) {
    ASSERT(window::create_renderer(), "Failed to initialize SDL renderer: {}", SDL_GetError());
  }
#else
  AuroraBackend selectedBackend = BACKEND_NULL;
  ASSERT(window::create_window(BACKEND_NULL), "Error creating window: {}", SDL_GetError());
  ASSERT(window::create_renderer(), "Failed to initialize SDL renderer: {}", SDL_GetError());
#endif

#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: about to show_window");
#endif
  window::show_window();
#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: window shown");
#endif

#ifdef AURORA_ENABLE_GX
#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: about to gfx::initialize");
#endif
  gfx::initialize();
#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: gfx::initialize done");
#endif

#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: about to imgui::create_context");
#endif
  imgui::create_context();
#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: imgui::create_context done");
#endif
#endif
  const auto size = window::get_window_size();
  Log.info("Using framebuffer size {}x{} scale {}", size.fb_width, size.fb_height, size.scale);
#ifdef AURORA_ENABLE_GX
  if (g_config.imGuiInitCallback != nullptr) {
#if DUSK_TRACE_ENABLE
    Log.info(">>> aurora::initialize: about to imGuiInitCallback");
#endif
    g_config.imGuiInitCallback(&size);
  }
#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: about to imgui::initialize");
#endif
  imgui::initialize();
#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: imgui::initialize done");
#endif
#endif

#ifdef AURORA_ENABLE_RMLUI
#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: about to rmlui::initialize");
#endif
  rmlui::initialize(size);
#if DUSK_TRACE_ENABLE
  Log.info(">>> aurora::initialize: rmlui::initialize done");
#endif
#endif

  g_initialFrame = true;
  g_config.desiredBackend = selectedBackend;
  return {
      .backend = selectedBackend,
      .configPath = g_config.configPath,
      .window = window::get_sdl_window(),
      .windowSize = size,
  };
}

#ifdef AURORA_ENABLE_GX
wgpu::TextureView g_currentView;
#endif

void shutdown() noexcept {
#ifdef AURORA_ENABLE_RMLUI
  rmlui::shutdown();
#endif
#ifdef AURORA_ENABLE_GX
  g_currentView = {};
  imgui::shutdown();
  gfx::shutdown();
  webgpu::shutdown();
#endif
  input::shutdown();
  window::shutdown();
}

const AuroraEvent* update() noexcept {
  ZoneScoped;
  if (g_initialFrame) {
    g_initialFrame = false;
    input::initialize();
  }
  return window::poll_events();
}

bool begin_frame() noexcept {
  ZoneScoped;
#ifdef AURORA_ENABLE_GX
  // gfx::begin_frame() yields the wasm thread (emscripten_sleep) while waiting
  // for the staging-buffer MapAsync callback. Under emscripten the browser
  // reclaims the swapchain texture during that yield — if we acquire the
  // surface texture HERE, by the time we submit it has been destroyed
  // ("Destroyed texture used in a submit"). Previously we tried fixing this
  // by reordering only the MapAsync wait to run before GetCurrentTexture,
  // but the destroyed-texture errors still fire — Chrome appears to recycle
  // the swapchain texture based on wall-clock time, not just on explicit
  // yields, so a long synchronous frame between acquire and submit is also
  // unsafe. We now defer GetCurrentTexture entirely to end_frame's present
  // block, immediately before the two render passes that use it; the
  // acquire-to-submit window shrinks to a few microseconds of command
  // recording. The staging-buffer MapAsync wait remains here because it
  // is independent of the surface and needs the yield to complete.
  imgui::new_frame(window::get_window_size());
  if (!gfx::begin_frame()) {
    g_currentView = {};
    return false;
  }

  {
    window::SurfaceLock surfaceLock;
    if (!window::is_presentable()) {
      webgpu::release_surface();
      return false;
    }
    if (window::is_paused()) {
      return false;
    }
  }
  // g_currentView intentionally left empty here — populated by end_frame.
  g_currentView = {};
#endif
  return true;
}

void end_frame() noexcept {
  ZoneScoped;
#ifdef AURORA_ENABLE_GX
  gx::fifo::drain();
  const auto encoderDescriptor = wgpu::CommandEncoderDescriptor{
      .label = "Redraw encoder",
  };
  auto encoder = g_device.CreateCommandEncoder(&encoderDescriptor);
  gfx::end_frame(encoder);
  gfx::render(encoder);
  {
    window::SurfaceLock surfaceLock;
    // Late-acquire the swapchain texture: do it right before recording the
    // EFB-copy + ImGui passes (the only passes that reference g_currentView)
    // so the time window between GetCurrentTexture and Queue.Submit is the
    // shortest possible — just two render-pass recordings and encoder.Finish.
    // This is the smallest-window-possible workaround for Chrome recycling
    // the texture too eagerly; see the begin_frame comment for context.
    bool present_ready = false;
    if (window::is_presentable() && !window::is_paused()) {
      if (!g_surface) {
        webgpu::refresh_surface(true);
      }
      if (g_surface) {
        wgpu::SurfaceTexture surfaceTexture;
        g_surface.GetCurrentTexture(&surfaceTexture);
        switch (surfaceTexture.status) {
        case wgpu::SurfaceGetCurrentTextureStatus::SuccessOptimal:
          g_currentView = surfaceTexture.texture.CreateView();
#ifdef __EMSCRIPTEN__
          frame_diag::surface_acquired_at_ms = emscripten_get_now();
          frame_diag::yields_since_acquire = 0;
          frame_diag::acquired = true;
#endif
          present_ready = true;
          break;
        case wgpu::SurfaceGetCurrentTextureStatus::Timeout:
          Log.warn("Surface texture acquisition timed out (late-acquire path)");
          break;
        case wgpu::SurfaceGetCurrentTextureStatus::SuccessSuboptimal:
        case wgpu::SurfaceGetCurrentTextureStatus::Outdated:
          Log.info("Surface texture is {}, reconfiguring swapchain",
                   magic_enum::enum_name(surfaceTexture.status));
          webgpu::refresh_surface(false);
          break;
        case wgpu::SurfaceGetCurrentTextureStatus::Lost:
          Log.warn("Surface texture is {}, releasing surface",
                   magic_enum::enum_name(surfaceTexture.status));
          webgpu::release_surface();
          [[fallthrough]];
        case wgpu::SurfaceGetCurrentTextureStatus::Error:
          Log.warn("Surface texture is {}, dropping surface",
                   magic_enum::enum_name(surfaceTexture.status));
          g_surface = {};
          break;
        default:
          Log.error("Failed to get surface texture: {}", magic_enum::enum_name(surfaceTexture.status));
          break;
        }
      }
    }
    if (present_ready && g_surface && g_currentView) {
      const auto& presentSource = webgpu::present_source();
      auto viewport = webgpu::calculate_present_viewport(webgpu::g_graphicsConfig.surfaceConfiguration.width,
                                                         webgpu::g_graphicsConfig.surfaceConfiguration.height,
                                                         presentSource.size.width, presentSource.size.height);
      wgpu::BindGroup presentBindGroup = webgpu::g_CopyBindGroup;
    #if AURORA_ENABLE_RMLUI
      if (rmlui::is_initialized()) {
        const auto rmlOutput = rmlui::render(encoder, viewport);
        if (rmlOutput.texture != nullptr) {
          presentBindGroup = rmlOutput.copyBindGroup;
        }
      }
    #endif
      {
        const std::array attachments{
            wgpu::RenderPassColorAttachment{
                .view = g_currentView,
                .loadOp = wgpu::LoadOp::Clear,
                .storeOp = wgpu::StoreOp::Store,
            },
        };
        const wgpu::RenderPassDescriptor renderPassDescriptor{
            .label = "EFB copy render pass",
            .colorAttachmentCount = attachments.size(),
            .colorAttachments = attachments.data(),
        };
        const auto pass = encoder.BeginRenderPass(&renderPassDescriptor);
        // Copy EFB -> XFB (swapchain)
        pass.SetPipeline(webgpu::g_CopyPipeline);
        pass.SetBindGroup(0, presentBindGroup, 0, nullptr);
        pass.SetViewport(viewport.left, viewport.top, viewport.width, viewport.height, viewport.znear, viewport.zfar);

        pass.Draw(3);
        pass.End();
      }
      {
        const std::array attachments{
            wgpu::RenderPassColorAttachment{
                .view = g_currentView,
                .loadOp = wgpu::LoadOp::Load,
                .storeOp = wgpu::StoreOp::Store,
            },
        };
        const wgpu::RenderPassDescriptor renderPassDescriptor{
            .label = "ImGui render pass",
            .colorAttachmentCount = attachments.size(),
            .colorAttachments = attachments.data(),
        };
        const auto pass = encoder.BeginRenderPass(&renderPassDescriptor);
        pass.SetViewport(0.f, 0.f, static_cast<float>(webgpu::g_graphicsConfig.surfaceConfiguration.width),
                         static_cast<float>(webgpu::g_graphicsConfig.surfaceConfiguration.height), 0.f, 1.f);
        imgui::render(pass);
        pass.End();
      }
    } else {
      Log.info("Skipping present; window not presentable");
      webgpu::release_surface();
    }
    const wgpu::CommandBufferDescriptor cmdBufDescriptor{.label = "Redraw command buffer"};
    const auto buffer = encoder.Finish(&cmdBufDescriptor);
#ifdef __EMSCRIPTEN__
    // Capture timing immediately before Submit so the elapsed-ms reading
    // includes ALL of: gx::fifo::drain, gfx::end_frame buffer copies,
    // gfx::render render-pass recording, rmlui::render, the EFB-copy +
    // ImGui passes, and encoder.Finish. Any non-zero yield count or
    // multi-tens-of-ms elapsed pinpoints which class of cause we are
    // looking at: explicit yield (yields > 0), implicit yield from
    // emdawnwebgpu/SDL (yields == 0 but elapsed jumps), or just slow
    // synchronous work (yields == 0, elapsed grows monotonically).
    if (frame_diag::acquired) {
      const double elapsed = emscripten_get_now() - frame_diag::surface_acquired_at_ms;
      frame_diag::last_submit_elapsed_ms = elapsed;
      const bool over_threshold = elapsed > frame_diag::log_threshold_ms;
      const bool had_yield = frame_diag::yields_since_acquire > 0;
      if (over_threshold || had_yield) {
        const uint32_t n = ++frame_diag::total_warnings_logged;
        // First few are spammed to console; after that, throttle to every 60th.
        if (n <= frame_diag::log_throttle_after || (n % 60) == 0) {
          Log.warn("[FrameDiag] acq->submit={:.2f}ms yields_in_window={} (warn #{})",
                   elapsed, frame_diag::yields_since_acquire, n);
        }
      }
      frame_diag::acquired = false;
    }
#endif
    g_queue.Submit(1, &buffer);
    gfx::after_submit();
    if (window::is_presentable() && g_surface) {
#ifdef __EMSCRIPTEN__
      // emdawnwebgpu intentionally does not implement wgpuSurfacePresent —
      // the browser auto-presents the canvas when the JS event loop yields
      // (i.e. when emscripten_sleep returns control). Calling Present() here
      // aborts with "wgpuSurfacePresent is unsupported (use
      // requestAnimationFrame via html5.h instead)". Skip it; the loop's
      // emscripten_sleep(0) at the top of m_Do_main.cpp's main01 yields and
      // the next paint will happen automatically.
#else
      auto presentStatus = g_surface.Present();
      if (presentStatus != wgpu::Status::Success) {
        Log.warn("Surface present failed: {}", static_cast<int>(presentStatus));
        webgpu::release_surface();
      }
#endif
    } else if (g_surface) {
      webgpu::release_surface();
    }
    g_currentView = {};
  }

  TracyPlotConfig("aurora: lastVertSize", tracy::PlotFormatType::Memory, false, true, 0);
  TracyPlotConfig("aurora: lastUniformSize", tracy::PlotFormatType::Memory, false, true, 0);
  TracyPlotConfig("aurora: lastIndexSize", tracy::PlotFormatType::Memory, false, true, 0);
  TracyPlotConfig("aurora: lastStorageSize", tracy::PlotFormatType::Memory, false, true, 0);
  TracyPlotConfig("aurora: lastTextureUploadSize", tracy::PlotFormatType::Memory, false, true, 0);

  TracyPlot("aurora: queuedPipelines", static_cast<int64_t>(gfx::g_stats.queuedPipelines));
  TracyPlot("aurora: createdPipelines", static_cast<int64_t>(gfx::g_stats.createdPipelines));
  TracyPlot("aurora: drawCallCount", static_cast<int64_t>(gfx::g_stats.drawCallCount));
  TracyPlot("aurora: mergedDrawCallCount", static_cast<int64_t>(gfx::g_stats.mergedDrawCallCount));
  TracyPlot("aurora: lastVertSize", static_cast<int64_t>(gfx::g_stats.lastVertSize));
  TracyPlot("aurora: lastUniformSize", static_cast<int64_t>(gfx::g_stats.lastUniformSize));
  TracyPlot("aurora: lastIndexSize", static_cast<int64_t>(gfx::g_stats.lastIndexSize));
  TracyPlot("aurora: lastStorageSize", static_cast<int64_t>(gfx::g_stats.lastStorageSize));
  TracyPlot("aurora: lastTextureUploadSize", static_cast<int64_t>(gfx::g_stats.lastTextureUploadSize));

#endif
}
} // namespace
} // namespace aurora

// C API bindings
AuroraInfo aurora_initialize(int argc, char* argv[], const AuroraConfig* config) {
  return aurora::initialize(argc, argv, *config);
}
void aurora_shutdown() { aurora::shutdown(); }
const AuroraEvent* aurora_update() { return aurora::update(); }
bool aurora_begin_frame() { return aurora::begin_frame(); }
void aurora_end_frame() { aurora::end_frame(); }
AuroraBackend aurora_get_backend() { return aurora::g_config.desiredBackend; }
const AuroraBackend* aurora_get_available_backends(size_t* count) {
  if (count != nullptr) {
    *count = aurora::PreferredBackendOrder.size();
  }
  return aurora::PreferredBackendOrder.data();
}
void aurora_set_log_level(AuroraLogLevel level) { aurora::g_config.logLevel = level; }
void aurora_set_pause_on_focus_lost(bool value) { aurora::g_config.pauseOnFocusLost = value; }
void aurora_set_background_input(bool value) {
  aurora::g_config.allowJoystickBackgroundEvents = value;
  aurora::window::set_background_input(value);
}

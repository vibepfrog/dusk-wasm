// Mouse Camera math and camera integration backported from TwilitRealm/dusklight
// ddc79d151edf8291ee444a8d8ea0ed156fc6f0aa. Capture is adapted for browsers;
// retain this branch's existing mouse-as-gyro aiming settings.
#include "dusk/mouse.h"
#include "dusk/gyro.h"
#include "dusk/settings.h"
#include "dusk/ui/ui.hpp"
#include "dusk/imgui/ImGuiConsole.hpp"

#include <aurora/lib/window.hpp>
#include <SDL3/SDL_mouse.h>
#include <SDL3/SDL_video.h>
#include <imgui.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace dusk::mouse {
namespace {
constexpr float kMousePixelToRad = 0.0025f;
bool s_capture_wanted = false;
float s_x = 0.0f, s_y = 0.0f;
}

void update_capture() {
    const auto& game = getSettings().game;
    const bool mouse_aim = game.gyroMode.getValue() == GyroMode::Mouse &&
                          (gyro::queryGyroAimContext() || gyro::get_sensor_keep_alive());
    auto* window = aurora::window::get_sdl_window();
    const bool focused = window && (SDL_GetWindowFlags(window) & SDL_WINDOW_INPUT_FOCUS);
    // An FPS overlay is not a menu. MetricsRenderWindows would disable camera
    // capture whenever any informational overlay is displayed.
    const bool menu = ui::any_document_visible() || g_imguiConsole.IsMenuVisible() ||
                      (ImGui::GetCurrentContext() &&
                       (ImGui::GetIO().WantCaptureMouse || ImGui::GetIO().WantTextInput));
    const bool wanted = focused && !menu && (game.enableMouseCamera.getValue() || mouse_aim);
#ifdef __EMSCRIPTEN__
    if (wanted != s_capture_wanted) {
        // Pointer lock itself hides the browser cursor. Undo the legacy idle
        // cursor hider so Escape/menu release leaves a visible pointer.
        if (ImGui::GetCurrentContext())
            ImGui::GetIO().ConfigFlags &= ~ImGuiConfigFlags_NoMouseCursorChange;
        SDL_ShowCursor();
        MAIN_THREAD_EM_ASM({
            if (!globalThis.duskMouseInput) {
                globalThis.duskMouseInput = globalThis.DuskMouseInput.create({
                    canvas: Module['canvas'], document: document, window: window,
                    status: document.getElementById('mouse-status')
                });
            }
            globalThis.duskMouseInput.setEnabled(!!$0);
        }, wanted);
    }
#else
    if (window && wanted != SDL_GetWindowRelativeMouseMode(window)) {
        SDL_SetWindowRelativeMouseMode(window, wanted);
        float discard_x, discard_y;
        SDL_GetRelativeMouseState(&discard_x, &discard_y);
    }
#endif
    s_capture_wanted = wanted;
    if (!wanted) s_x = s_y = 0.0f;
}

void read() {
    update_capture();
    s_x = s_y = 0.0f;
    if (!s_capture_wanted) return;
#ifdef __EMSCRIPTEN__
    // A single sample per simulation tick, shared with gyro::read. Pixels must
    // not be multiplied by dt or replayed on extra interpolated render frames.
    MAIN_THREAD_EM_ASM({
        var motion = globalThis.duskMouseInput.consume();
        HEAPF32[$0 >> 2] = motion[0];
        HEAPF32[$1 >> 2] = motion[1];
    }, &s_x, &s_y);
#else
    SDL_GetRelativeMouseState(&s_x, &s_y);
#endif
}

void get_relative_motion(float& x, float& y) { x = s_x; y = s_y; }

void get_camera_deltas(float& yaw, float& pitch) {
    const auto& game = getSettings().game;
    yaw = pitch = 0.0f;
    if (!game.enableMouseCamera.getValue()) return;
    const float sensitivity = game.mouseCameraSensitivity.getValue();
    yaw = -s_x * kMousePixelToRad * sensitivity;
    pitch = -s_y * kMousePixelToRad * sensitivity;
    if (game.enableMirrorMode.getValue()) yaw = -yaw;
    if (game.invertMouseY.getValue()) pitch = -pitch;
}
}

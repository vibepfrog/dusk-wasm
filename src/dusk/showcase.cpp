#include "dusk/showcase.h"

#ifdef __EMSCRIPTEN__
#include <algorithm>
#include <atomic>
#include <array>
#include <cmath>
#include <cstring>
#include <vector>
#include <emscripten.h>
#include <aurora/gfx.h>
#include <aurora/lib/window.hpp>
#include "d/actor/d_a_player.h"
#include "d/d_bg_s_lin_chk.h"
#include "d/d_camera.h"
#include "d/d_com_inf_game.h"
#include "d/d_kankyo.h"
#include "d/d_meter2_info.h"
#include "dusk/autosave.h"
#include "dusk/settings.h"
#include "dusk/ui/ui.hpp"
#include "dusk/imgui/ImGuiConsole.hpp"
#include "f_op/f_op_scene_mng.h"
#include "f_pc/f_pc_name.h"
#include "m_Do/m_Do_graphic.h"
#include "JSystem/JUtility/JUTGamePad.h"

namespace dusk::showcase {
namespace {
struct Scene { const char* stage; const char* name; s8 room; s16 spawn; s8 layer; };
// Existing stage entrances, also listed in map_loader_definitions.h. Each visit
// starts a new temporary progression state; no campaign file is loaded or edited.
constexpr Scene scenes[] = {
    {"F_SP103", "Ordon Village", 0, 0, 2},
    {"F_SP104", "Ordon Spring", 1, 0, 2},
    {"F_SP127", "Fishing Pond", 0, 0, 0},
};
constexpr int sceneCount = sizeof(scenes) / sizeof(scenes[0]);
constexpr double passDuration = 20'000.0;
std::atomic<bool> isolated{false};
// The DOM only writes these shared mailboxes. All scene and camera operations
// stay on the application pthread. The card thread only reads isolated.
std::atomic<int> command{0}, hidden{0};
bool bootPending = false, preparePending = false, waiting = false, exiting = false;
fpc_ProcID bootLogoID = fpcM_ERROR_PROCESS_ID_e;
bool benchmarking = false, touring = false, running = false;
int sceneIndex = 0, pass = 0;
double lastFrame = 0, elapsed = 0, readySince = 0, lastStatus = 0;
uint32_t initialPipelines = 0, passPipelines = 0;
AuroraStats initialShaderStats{}, passShaderStats{};
cXyz anchor;
std::vector<double> samples;
using PresentationKey = std::array<int, 10>;
PresentationKey measuredPresentation{};

PresentationKey presentation_key() {
    const auto size = aurora::window::get_window_size();
    const auto& settings = getSettings();
    return {static_cast<int>(size.native_fb_width), static_cast<int>(size.native_fb_height),
            settings.game.internalResolutionScale.getValue(),
            settings.game.shadowResolutionMultiplier.getValue(),
            static_cast<int>(settings.game.bloomMode.getValue()),
            settings.game.enableFrameInterpolation.getValue(), settings.video.enableVsync.getValue(),
            settings.game.enableMirrorMode.getValue(), getTransientSettings().skipFrameRateLimit,
            settings.game.enableAsyncShaderCompilation.getValue()};
}

void status(const char* text) {
    MAIN_THREAD_EM_ASM({
        if (window.duskShowcaseUI) window.duskShowcaseUI.status(UTF8ToString($0), $1, !!$2);
    }, text, sceneIndex, bootPending || benchmarking || waiting || exiting);
}

void set_stage() {
    const auto& scene = scenes[sceneIndex];
    preparePending = true;
    waiting = true;
    running = false;
    readySince = lastFrame = 0;
    initialShaderStats = *aurora_get_stats();
    initialPipelines = initialShaderStats.createdPipelines;
    dComIfGp_offEnableNextStage();
    dComIfGp_setNextStage(scene.stage, scene.spawn, scene.room, scene.layer);
    status("Loading showcase location…");
}

void result() {
    const auto stats = *aurora_get_stats();
    const uint32_t compiled = stats.createdPipelines - passPipelines;
    MAIN_THREAD_EM_ASM({
        if (window.duskShowcaseUI) window.duskShowcaseUI.result({
            scene: $0, pass: $1,
            frames: Array.from(HEAPF64.subarray($2 >> 3, ($2 >> 3) + $3)),
            compiled: $4, entryCompiled: $5,
            resolutionScale: $6, interpolation: !!$7, vsync: !!$8,
            bloom: $9, shadowScale: $10, renderWidth: $11, renderHeight: $12,
            mirror: !!$13,
            asyncShaders: { enabled: !!$14, submitted: $15, failed: $16,
                pendingStart: $17, pendingEnd: $18, inFlightEnd: $19,
                skippedDraws: $20, skippedFrames: $21, protectedWaitMs: $22,
                entrySkippedDraws: $23, entryProtectedWaitMs: $24 }
        });
    }, sceneIndex, pass, samples.data(), samples.size(), compiled,
       passPipelines - initialPipelines,
       getSettings().game.internalResolutionScale.getValue(),
       getSettings().game.enableFrameInterpolation.getValue(),
       getSettings().video.enableVsync.getValue(),
       static_cast<int>(getSettings().game.bloomMode.getValue()),
       getSettings().game.shadowResolutionMultiplier.getValue(), measuredPresentation[0],
       measuredPresentation[1], getSettings().game.enableMirrorMode.getValue(),
       stats.asyncShaderCompilation, stats.submittedPipelines - passShaderStats.submittedPipelines,
       stats.failedPipelines - passShaderStats.failedPipelines,
       passShaderStats.queuedPipelines, stats.queuedPipelines, stats.inFlightPipelines,
       static_cast<double>(stats.skippedPipelineDraws - passShaderStats.skippedPipelineDraws),
       static_cast<double>(stats.skippedPipelineFrames - passShaderStats.skippedPipelineFrames),
       stats.pipelineWaitMs - passShaderStats.pipelineWaitMs,
       static_cast<double>(passShaderStats.skippedPipelineDraws - initialShaderStats.skippedPipelineDraws),
       passShaderStats.pipelineWaitMs - initialShaderStats.pipelineWaitMs);
}

bool scene_ready() {
    const auto& scene = scenes[sceneIndex];
    auto* play = reinterpret_cast<scene_class*>(fpcM_SearchByName(fpcNm_PLAY_SCENE_e));
    return !preparePending && play && !fpcM_IsCreating(fopScnM_GetID(play)) &&
           dComIfGp_getLinkPlayer() && dComIfGp_getCamera(0) &&
           !dComIfGp_isEnableNextStage() &&
           std::strcmp(dComIfGp_getStartStageName(), scene.stage) == 0 &&
           dComIfGp_getStartStageRoomNo() == scene.room;
}
}

bool active() noexcept { return isolated.load(std::memory_order_relaxed); }
bool controls_locked() noexcept { return active() && benchmarking; }

void initialize(bool enabled) {
    if (!enabled) return;
    isolated.store(true, std::memory_order_relaxed);
    bootPending = true;
    bootLogoID = fpcM_ERROR_PROCESS_ID_e;
    samples.reserve(8192);
    MAIN_THREAD_EM_ASM({
        Module['duskSaves'].setIsolated(true);
        var slot = $0 >> 2;
        var visibility = $1 >> 2;
        var updateVisibility = function () { Atomics.store(HEAP32, visibility, document.hidden ? 1 : 0); };
        document.addEventListener('visibilitychange', updateVisibility);
        updateVisibility();
        if (window.duskShowcaseUI) window.duskShowcaseUI.connect(function (value) {
            if (![1, 2, 3, 10, 11, 12, 13].includes(value)) return false;
            return Atomics.compareExchange(HEAP32, slot, 0, value) === 0;
        });
    }, &command, &hidden);
    status("Preparing a temporary showcase session…");
}

bool boot(scene_class* logo) {
    if (!active()) return false;
    if (bootPending) {
        set_stage();
        if (fopScnM_ChangeReq(logo, fpcNm_PLAY_SCENE_e, 0, 5)) {
            bootPending = false;
            bootLogoID = fopScnM_GetID(logo);
        }
        return true;
    }
    // The logo calls this on every draw until the scene change completes.
    // Keep claiming that instance after acceptance: the normal opening path
    // would replace both our stage and our queued scene. A new logo instance
    // after Reset must be allowed through to the campaign title screen.
    return fopScnM_GetID(logo) == bootLogoID;
}

void prepare_scene() {
    if (!active() || !preparePending ||
        std::strcmp(dComIfGp_getNextStageName(), scenes[sceneIndex].stage) != 0) return;
    // Called after the outgoing scene is destroyed, before the new scene reads
    // progression or creates actors. Do not reset globals under live actors.
    dComIfGs_init();
    dComIfGp_itemDataInit();
    dComIfGs_setDataNum(0);
    dComIfGs_setNewFile(0);
    dComIfGs_setPlayerName("Link");
    dComIfGs_setHorseName("Epona");
    dComIfGs_setMaxLife(50);
    dComIfGs_setLife(40);
    dComIfGs_setRupee(100);
    dComIfGs_setTime(180.0f);
    dComIfGs_setDate(1);
    for (int area = 0; area < 3; ++area) dComIfGs_onDarkClearLV(area);
    // Skip prologue restrictions and introductory conversations, without
    // fabricating a completed campaign or enabling late-game bosses.
    for (u16 flag : {dSv_event_flag_c::M_009, dSv_event_flag_c::M_011,
                     dSv_event_flag_c::M_019, dSv_event_flag_c::M_028,
                     dSv_event_flag_c::F_0008, dSv_event_flag_c::F_0010,
                     dSv_event_flag_c::F_0023}) dComIfGs_onEventBit(flag);
    dMeter2Info_setCloth(dItemNo_WEAR_KOKIRI_e, false);
    dMeter2Info_setSword(dItemNo_SWORD_e, false);
    dMeter2Info_setShield(dItemNo_HYLIA_SHIELD_e, false);
    dComIfGs_setItem(SLOT_0, dItemNo_KANTERA_e);
    dComIfGs_setItem(SLOT_4, dItemNo_BOW_e);
    dComIfGs_onItemFirstBit(dItemNo_KANTERA_e);
    dComIfGs_onItemFirstBit(dItemNo_BOW_e);
    dComIfGs_setMaxOil(21600);
    dComIfGs_setOil(21600);
    dComIfGs_setArrowMax(30);
    dComIfGs_setArrowNum(30);
    dComIfGs_setSelectItemIndex(0, SLOT_0);
    dComIfGs_setSelectItemIndex(1, SLOT_4);
    dComIfGp_setSelectItem(0);
    dComIfGp_setSelectItem(1);
    dComIfGs_resetDan();
    dComIfGs_setRestartRoomParam(0);
    g_env_light.fishing_hole_season = 1;
    resetAutoSave();
    preparePending = false;
}

void campaign_ready() {
    if (!isolated.exchange(false, std::memory_order_relaxed)) return;
    bootPending = preparePending = waiting = benchmarking = touring = running = exiting = false;
    bootLogoID = fpcM_ERROR_PROCESS_ID_e;
    command.store(0, std::memory_order_relaxed);
    samples.clear();
    resetAutoSave();
    MAIN_THREAD_EM_ASM({
        Module['duskSaves'].setIsolated(false);
        if (window.duskShowcaseUI) window.duskShowcaseUI.finished();
    });
}

void pause() { lastFrame = readySince = 0; }

void update() {
    if (!active()) return;
    // Like the native Reset menu, wait until the logo scene has finished.
    // Leave an early page request in the mailbox for the first playable scene.
    if (bootPending || fpcM_SearchByName(fpcNm_LOGO_SCENE_e)) return;
    const int action = command.exchange(0, std::memory_order_relaxed);
    if (action == 12 && !exiting) {
        benchmarking = running = waiting = preparePending = false;
        exiting = true;
        JUTGamePad::C3ButtonReset::sResetSwitchPushing = true;
        status("Returning to the title screen. Press Start to open your campaign.");
    }
    if (exiting) return;
    if (action == 11) {
        benchmarking = touring = running = false;
        samples.clear();
        status(waiting ? "Loading showcase location…" : "Explore freely. Shaders are remembered as you play.");
    } else if (action >= 1 && action <= sceneCount && !waiting) {
        benchmarking = touring = false;
        sceneIndex = action - 1;
        set_stage();
    } else if ((action == 10 || action == 13) && !waiting) {
        benchmarking = true;
        touring = action == 13;
        pass = 0;
        measuredPresentation = presentation_key();
        if (touring) sceneIndex = 0;
        MAIN_THREAD_EM_ASM({ if (window.duskShowcaseUI) window.duskShowcaseUI.begin(); });
        set_stage();
    }

    if (benchmarking && (ui::any_document_visible() || g_imguiConsole.IsMenuVisible() ||
                         presentation_key() != measuredPresentation)) {
        benchmarking = touring = running = false;
        samples.clear();
        status("Benchmark stopped because settings, window size or a game menu changed. Run it again for comparable results.");
        return;
    }
    if (hidden.load(std::memory_order_relaxed)) { pause(); return; }
    if (ui::any_document_visible() || g_imguiConsole.IsMenuVisible()) { pause(); return; }
    if (waiting && scene_ready()) {
        if (dComIfGp_event_runCheck()) {
            if (benchmarking) {
                benchmarking = touring = false;
                samples.clear();
                status("Benchmark stopped for a scene event. Controls are available to finish or skip it.");
            }
            readySince = 0;
            return;
        }
        const double now = emscripten_get_now();
        if (!readySince) readySince = now;
        if (now - readySince < 250) return;
        waiting = false;
        if (!benchmarking) { status("Explore freely. Shaders are remembered as you play."); return; }
        anchor = dComIfGp_getLinkPlayer()->current.pos;
        anchor.y += 90.0f;
        elapsed = 0;
        lastFrame = 0;
        samples.clear();
        passShaderStats = *aurora_get_stats();
        passPipelines = passShaderStats.createdPipelines;
        running = true;
        status(pass == 0 ? "First pass: 20-second camera sweep…" : "Repeat: the same camera sweep; shader readiness is recorded…");
    }
}

bool camera(dCamera_c* body) {
    if (!active() || !running || !scene_ready()) return false;
    const double angle = (elapsed / passDuration) * 6.283185307179586;
    cXyz eye(anchor.x + static_cast<float>(std::sin(angle) * 320.0),
             anchor.y + 100.0f + static_cast<float>(std::sin(angle * 2.0) * 30.0),
             anchor.z + static_cast<float>(std::cos(angle) * 320.0));
    dBgS_LinChk line;
    line.Set(&anchor, &eye, nullptr);
    if (dComIfG_Bgsp().LineCross(&line)) {
        eye = line.GetCross();
        eye += (anchor - eye) * 0.08f;
    }
    body->Reset(anchor, eye, 55.0f, 0);
    return true;
}

void rendered_frame() {
    if (!active() || !running) return;
    if (hidden.load(std::memory_order_relaxed) || ui::any_document_visible() ||
        g_imguiConsole.IsMenuVisible()) { pause(); return; }
    if (!scene_ready() || dComIfGp_event_runCheck()) {
        benchmarking = running = false;
        samples.clear();
        status("Benchmark interrupted by a scene change or event. Run it again from the showcase entrance.");
        return;
    }
    const double now = emscripten_get_now();
    if (!lastFrame) { lastFrame = now; return; }
    const double dt = now - lastFrame;
    lastFrame = now;
    if (dt <= 0) return;
    samples.push_back(dt);
    elapsed += dt;
    if (now - lastStatus >= 500) {
        lastStatus = now;
        MAIN_THREAD_EM_ASM({
            if (window.duskShowcaseUI) window.duskShowcaseUI.progress($0, $1, $2, $3);
        }, sceneIndex, pass, std::min(elapsed / passDuration, 1.0),
           aurora_get_stats()->createdPipelines - passPipelines);
    }
    if (elapsed < passDuration) return;
    result();
    if (pass == 0) { pass = 1; set_stage(); }
    else if (touring && sceneIndex + 1 < sceneCount) { ++sceneIndex; pass = 0; set_stage(); }
    else {
        benchmarking = touring = running = false;
        status("Benchmark complete. Explore freely, visit another location, or start your campaign.");
        MAIN_THREAD_EM_ASM({ if (window.duskShowcaseUI) window.duskShowcaseUI.complete(); });
    }
}
}
#else
namespace dusk::showcase {
void initialize(bool) {}
bool active() noexcept { return false; }
bool controls_locked() noexcept { return false; }
bool boot(scene_class*) { return false; }
void prepare_scene() {}
void campaign_ready() {}
void update() {}
void rendered_frame() {}
void pause() {}
bool camera(dCamera_c*) { return false; }
}
#endif

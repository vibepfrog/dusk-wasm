// imgui_impl_wgpu_stub.cpp — emscripten/emdawnwebgpu stand-in for imgui's WebGPU
// backend.
//
// imgui v1.91.9b's imgui_impl_wgpu.cpp targets an older Dawn API that's been
// renamed in current emdawnwebgpu (WGPUProgrammableStageDescriptor,
// WGPUShaderModuleWGSLDescriptor, WGPUImageCopyTexture, WGPUTextureDataLayout,
// etc. are gone). Aurora calls into this surface from lib/imgui.cpp, so we
// can't drop the symbols entirely. This stub provides the API shape so Aurora
// links; the imgui debug overlay is unrendered under web in v1.
//
// Re-cross when (a) imgui is bumped to a release with current Dawn naming, or
// (b) we start needing imgui in the browser (e.g. for in-game settings UI).
// Tracked in dusk/docs/wasm-port-notes.md.

#include "imgui.h"
#include "backends/imgui_impl_wgpu.h"

IMGUI_IMPL_API bool ImGui_ImplWGPU_Init(ImGui_ImplWGPU_InitInfo* /*init_info*/) {
    return true;
}

IMGUI_IMPL_API void ImGui_ImplWGPU_Shutdown() {}

IMGUI_IMPL_API void ImGui_ImplWGPU_NewFrame() {}

IMGUI_IMPL_API void ImGui_ImplWGPU_RenderDrawData(ImDrawData* /*draw_data*/,
                                                   WGPURenderPassEncoder /*pass_encoder*/) {}

IMGUI_IMPL_API bool ImGui_ImplWGPU_CreateDeviceObjects() { return true; }

IMGUI_IMPL_API void ImGui_ImplWGPU_InvalidateDeviceObjects() {}

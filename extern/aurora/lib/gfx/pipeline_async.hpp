#pragma once

#include <functional>
#include <string>
#include <string_view>
#include <utility>
#include <webgpu/webgpu_cpp.h>

namespace aurora::gfx {

using PipelineCompletion = std::function<void(wgpu::RenderPipeline, std::string)>;

#ifdef __EMSCRIPTEN__
// Emscripten 5.0.6 pins emdawnwebgpu v20251002.162335. Its JS bridge converts
// the entire descriptor synchronously before calling createRenderPipelineAsync.
// Thus stack-local descriptors/arrays/labels may expire on return. Retain the
// input C handles until completion too; queued factories own their config.
inline wgpu::Future submit_pipeline_async(const wgpu::Device& device,
                                         const wgpu::RenderPipelineDescriptor* descriptor,
                                         PipelineCompletion complete) {
  auto layout = descriptor->layout;
  auto vertex = descriptor->vertex.module;
  auto fragment = descriptor->fragment ? descriptor->fragment->module : wgpu::ShaderModule{};
  return device.CreateRenderPipelineAsync(
      descriptor, wgpu::CallbackMode::AllowProcessEvents,
      [complete = std::move(complete), layout = std::move(layout), vertex = std::move(vertex),
       fragment = std::move(fragment)](wgpu::CreatePipelineAsyncStatus status,
                                      wgpu::RenderPipeline pipeline, wgpu::StringView message) {
        if (status == wgpu::CreatePipelineAsyncStatus::Success && pipeline) {
          complete(std::move(pipeline), {});
        } else {
          // StringView belongs to the callback; never retain its pointer.
          complete({}, "WebGPU pipeline status " + std::to_string(static_cast<unsigned>(status)) +
                           ": " + std::string(std::string_view(message)));
        }
      });
}
#endif

} // namespace aurora::gfx

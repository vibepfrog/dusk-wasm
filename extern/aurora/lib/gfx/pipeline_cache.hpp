#pragma once

#include "common.hpp"

#include <functional>
#ifdef __EMSCRIPTEN__
#include "pipeline_dependencies.hpp"
#endif

namespace aurora::gfx::clear {
struct PipelineConfig;
} // namespace aurora::gfx::clear

namespace aurora::gx {
struct PipelineConfig;
} // namespace aurora::gx

namespace aurora::gfx {

// Empty completion requests synchronous creation (native renderer). Browser
// jobs supply a completion and return before compilation finishes.
using NewPipelineCallback = std::function<wgpu::RenderPipeline(PipelineCompletion)>;

void initialize_pipeline_cache();
void shutdown_pipeline_cache();
void begin_pipeline_frame();
void end_pipeline_frame();
wgpu::RenderPipeline create_render_pipeline(const wgpu::RenderPipelineDescriptor* descriptor,
                                           PipelineCompletion complete = {});
#ifdef __EMSCRIPTEN__
void service_pipeline_compilation(size_t maxSubmissions = 1);
void cancel_pipeline_compilation(std::string reason);
void protect_pipeline_outputs(const PipelineDependencies<PipelineRef>::Plan& plan);
#endif

template <typename Config>
PipelineRef find_pipeline(ShaderType type, const Config& config, NewPipelineCallback&& cb);

bool get_pipeline(PipelineRef ref, wgpu::RenderPipeline& pipeline);

} // namespace aurora::gfx

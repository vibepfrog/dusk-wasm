#ifndef AURORA_GFX_H
#define AURORA_GFX_H

#ifdef __cplusplus
#include <cstdint>

extern "C" {
#else
#include "stdint.h"
#endif

#ifndef NDEBUG
#define AURORA_GFX_DEBUG_GROUPS
#endif

void push_debug_group(const char* label);
void pop_debug_group();

typedef struct {
  uint32_t queuedPipelines;
  uint32_t createdPipelines;
  uint32_t drawCallCount;
  uint32_t mergedDrawCallCount;
  uint32_t lastVertSize;
  uint32_t lastUniformSize;
  uint32_t lastIndexSize;
  uint32_t lastStorageSize;
  uint32_t lastTextureUploadSize;
  // Browser pipeline counters accumulate for the renderer lifetime. queued and
  // inFlight are gauges; created counts successful completions, never requests.
  uint32_t submittedPipelines;
  uint32_t failedPipelines;
  uint32_t inFlightPipelines;
  uint64_t skippedPipelineDraws;
  uint64_t skippedPipelineFrames;
  double pipelineWaitMs;
  bool asyncShaderCompilation;
  bool aggressiveAsyncShaderCompilation;
  bool unprotectedPipelineSkips; // Sticky: earlier aggressive skips may live in captures.
} AuroraStats;

const AuroraStats* aurora_get_stats();

void aurora_enable_vsync(bool enabled);
// Owning application thread only. Browser mode is latched at the next frame;
// switching off retains existing compilation jobs and waits for their results.
void aurora_set_async_shader_compilation(bool enabled);
// Experimental browser override: all pending game draws may be skipped, even
// persistent outputs. Defaults off; disabling does not repair earlier captures.
void aurora_set_aggressive_async_shader_compilation(bool enabled);

#ifdef __cplusplus
}
#endif

#endif
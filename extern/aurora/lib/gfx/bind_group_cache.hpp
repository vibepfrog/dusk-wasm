#pragma once

#include <cstdint>
#include <utility>
#include <vector>

#include <webgpu/webgpu_cpp.h>

namespace aurora::gfx {

// Bind-group cache keys contain the C handles from their descriptors. Emdawn
// retains the JS resources inside GPUBindGroup, but its C handles have separate
// reference counts: releasing a texture-view handle can let its address be
// reused while the cached group still samples the previous texture. Keep the
// handles alive for exactly as long as the cache entry, including across moves.
struct CachedBindGroup {
  struct ResourceHandles {
    wgpu::Buffer buffer;
    wgpu::Sampler sampler;
    wgpu::TextureView textureView;
  };

  wgpu::BindGroupLayout layout;
  std::vector<ResourceHandles> resources;
  wgpu::BindGroup bindGroup;
  uint32_t lastUsedFrame;

  CachedBindGroup(const WGPUBindGroupDescriptor& descriptor, wgpu::BindGroup group, uint32_t frame)
  : layout(descriptor.layout), bindGroup(std::move(group)), lastUsedFrame(frame) {
    resources.reserve(descriptor.entryCount);
    for (size_t i = 0; i < descriptor.entryCount; ++i) {
      const auto& entry = descriptor.entries[i];
      // Constructing a C++ wrapper from a C handle adds a reference. Acquire()
      // would take ownership of the caller's existing reference instead.
      resources.push_back({entry.buffer, entry.sampler, entry.textureView});
    }
  }
};

} // namespace aurora::gfx

// A ROM- and GPU-free regression test using the real webgpu_cpp.h wrappers.
// Model Emdawn's separate C-handle reference counts: a bind group does not
// retain these handles, even though the browser keeps the JS resources alive.
#include "../lib/gfx/bind_group_cache.hpp"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <utility>

namespace {
void require(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
  }
}
} // namespace

#define FAKE_HANDLE(Name)                                                   \
  struct WGPU##Name##Impl { unsigned refs = 0; };                            \
  void wgpu##Name##AddRef(WGPU##Name handle) {                               \
    require(handle && handle->refs > 0, "AddRef requires a live " #Name);    \
    ++handle->refs;                                                         \
  }                                                                        \
  void wgpu##Name##Release(WGPU##Name handle) {                              \
    require(handle && handle->refs > 0, "Release requires a live " #Name);   \
    --handle->refs;                                                         \
  }

FAKE_HANDLE(BindGroup)
FAKE_HANDLE(BindGroupLayout)
FAKE_HANDLE(Buffer)
FAKE_HANDLE(Sampler)
FAKE_HANDLE(TextureView)
#undef FAKE_HANDLE

namespace {
std::array<WGPUTextureViewImpl, 2> viewPool;

WGPUTextureView allocate_view() {
  for (auto& view : viewPool) {
    if (view.refs == 0) {
      view.refs = 1;
      return &view;
    }
  }
  require(false, "texture view pool exhausted");
  return nullptr;
}

void check_handle_reuse_fixture() {
  auto first = allocate_view();
  wgpuTextureViewRelease(first);
  auto replacement = allocate_view();
  require(replacement == first, "fixture must reuse an unretained C handle");
  wgpuTextureViewRelease(replacement);
}

void check_cached_resources() {
  WGPUBindGroupLayoutImpl layout{1};
  WGPUBufferImpl buffer{1};
  WGPUSamplerImpl sampler{1};
  WGPUBindGroupImpl group{1};
  auto view = allocate_view();
  const std::array entries{
      WGPUBindGroupEntry{.binding = 0, .textureView = view},
      WGPUBindGroupEntry{.binding = 1, .sampler = &sampler},
      WGPUBindGroupEntry{.binding = 2, .buffer = &buffer, .size = 16},
      WGPUBindGroupEntry{.binding = 3, .textureView = view},
  };
  const WGPUBindGroupDescriptor descriptor{
      .layout = &layout,
      .entryCount = entries.size(),
      .entries = entries.data(),
  };

  std::optional<aurora::gfx::CachedBindGroup> cached;
  {
    aurora::gfx::CachedBindGroup entry{descriptor, wgpu::BindGroup::Acquire(&group), 17};
    require(layout.refs == 2 && buffer.refs == 2 && sampler.refs == 2 && view->refs == 3,
            "cache must retain the layout and every descriptor resource");
    require(group.refs == 1, "cache must take ownership of the supplied group");
    cached.emplace(std::move(entry));
  }
  require(cached->lastUsedFrame == 17, "moving a cache entry must preserve its age");

  // The engine releases the original texture object and other wrappers.
  wgpuBindGroupLayoutRelease(&layout);
  wgpuBufferRelease(&buffer);
  wgpuSamplerRelease(&sampler);
  wgpuTextureViewRelease(view);
  require(layout.refs == 1 && buffer.refs == 1 && sampler.refs == 1 && view->refs == 2,
          "cache resources must survive release of the original owners");

  auto replacement = allocate_view();
  require(replacement != view, "a cached texture identity must not be reused");
  wgpuTextureViewRelease(replacement);

  cached.reset(); // Same destruction path as cache expiration or resize.
  require(layout.refs == 0 && buffer.refs == 0 && sampler.refs == 0 && view->refs == 0 && group.refs == 0,
          "eviction must release all cache-owned handles without leaking");
  auto afterEviction = allocate_view();
  require(afterEviction == view, "a handle may be reused once its cache entry is gone");
  wgpuTextureViewRelease(afterEviction);
}

void check_empty_group() {
  WGPUBindGroupLayoutImpl layout{1};
  WGPUBindGroupImpl group{1};
  {
    const WGPUBindGroupDescriptor descriptor{.layout = &layout};
    aurora::gfx::CachedBindGroup cached{descriptor, wgpu::BindGroup::Acquire(&group), 0};
    require(cached.resources.empty() && layout.refs == 2, "empty groups still retain their layout");
  }
  require(layout.refs == 1 && group.refs == 0, "empty group must release only its own references");
  wgpuBindGroupLayoutRelease(&layout);
}
} // namespace

int main() {
  check_handle_reuse_fixture();
  // Repeated insertion/eviction also checks that resource counts stay bounded.
  for (unsigned i = 0; i < 1000; ++i) check_cached_resources();
  check_empty_group();
  std::puts("PASS: cached WebGPU handles resist reuse, survive moves, and release on eviction");
}

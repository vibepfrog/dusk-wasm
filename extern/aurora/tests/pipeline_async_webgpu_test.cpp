// Exercise the real pinned Emdawn C++ -> JS -> Promise -> ProcessEvents bridge.
// Only navigator.gpu is a controllable mock; no ROM or physical GPU is needed.
#include "../lib/gfx/async_pipeline_queue.hpp"
#include "../lib/gfx/pipeline_async.hpp"

#include <cstdio>
#include <cstdlib>
#include <emscripten.h>

using Queue = aurora::gfx::AsyncPipelineQueue<unsigned, wgpu::RenderPipeline>;

static void require(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
  }
}

EM_JS(void, install_gpu, (), {
  globalThis.GPUValidationError = class extends Error {};
  globalThis.GPUOutOfMemoryError = class extends Error {};
  globalThis.GPUInternalError = class extends Error {};
  globalThis.pipelineRequests = [];
  let loseDevice;
  const device = {
    queue: {},
    lost: new Promise(resolve => { loseDevice = resolve; }),
    destroy: () => loseDevice({reason: 'destroyed', message: 'fixture teardown'}),
    createShaderModule: desc => ({code: desc.code}),
    createPipelineLayout: desc => ({label: desc.label}),
    createRenderPipelineAsync: desc => new Promise((resolve, reject) => {
      pipelineRequests.push({desc, resolve, reject});
    }),
  };
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {
    gpu: {requestAdapter: async () => ({requestDevice: async () => device})},
  }});
});

EM_JS(int, request_count, (), { return pipelineRequests.length; });
EM_JS(void, finish_request, (int index, int fail), {
  const request = pipelineRequests[index];
  // These strings, arrays and handles originated in expired C++ stack frames.
  const d = request.desc;
  if (d.label !== 'owned descriptor' || d.vertex.entryPoint !== 'main' ||
      d.vertex.buffers[0].attributes[0].shaderLocation !== 3 ||
      d.vertex.module.code !== 'test source' || d.layout.label !== 'owned layout' ||
      d.fragment.targets[0].format !== 'rgba8unorm') {
    throw new Error('descriptor was not copied before its C++ owners expired');
  }
  if (fail) request.reject({reason: 'validation', message: 'delayed validation failure'});
  else request.resolve({label: d.label});
});

static void submit(const wgpu::Device& device, Queue::Completion done) {
  wgpu::ShaderSourceWGSL source{};
  source.code = "test source";
  wgpu::ShaderModuleDescriptor moduleDesc{};
  moduleDesc.nextInChain = &source;
  auto module = device.CreateShaderModule(&moduleDesc);
  wgpu::PipelineLayoutDescriptor layoutDesc{};
  layoutDesc.label = "owned layout";
  auto layout = device.CreatePipelineLayout(&layoutDesc);
  wgpu::VertexAttribute attribute{};
  attribute.format = wgpu::VertexFormat::Float32;
  attribute.shaderLocation = 3;
  wgpu::VertexBufferLayout buffer{};
  buffer.arrayStride = 4;
  buffer.attributeCount = 1;
  buffer.attributes = &attribute;
  wgpu::ColorTargetState target{};
  target.format = wgpu::TextureFormat::RGBA8Unorm;
  wgpu::FragmentState fragment{};
  fragment.module = module;
  fragment.entryPoint = "main";
  fragment.targetCount = 1;
  fragment.targets = &target;
  std::string label = "owned descriptor";
  wgpu::RenderPipelineDescriptor descriptor{};
  descriptor.label = label.c_str();
  descriptor.layout = layout;
  descriptor.vertex.module = module;
  descriptor.vertex.entryPoint = "main";
  descriptor.vertex.bufferCount = 1;
  descriptor.vertex.buffers = &buffer;
  descriptor.fragment = &fragment;
  aurora::gfx::submit_pipeline_async(device, &descriptor, std::move(done));
  // Mutate the descriptor after submission, then destroy all original owners.
  label.assign(label.size(), 'x');
  attribute.shaderLocation = 99;
  target.format = wgpu::TextureFormat::BGRA8Unorm;
}

template <class Predicate>
static void pump_until(const wgpu::Instance& instance, Predicate ready) {
  const double deadline = emscripten_get_now() + 5000;
  while (!ready()) {
    require(emscripten_get_now() < deadline, "callback failed to make progress");
    emscripten_sleep(0); // ProcessEvents alone cannot run JavaScript promises.
    instance.ProcessEvents();
  }
}

int main() {
  install_gpu();
  Queue queue{2};
  bool deviceLost = false;
  auto instance = wgpu::CreateInstance();
  wgpu::Adapter adapter{};
  instance.RequestAdapter(nullptr, wgpu::CallbackMode::AllowProcessEvents,
      [&](wgpu::RequestAdapterStatus status, wgpu::Adapter result, wgpu::StringView) {
        require(status == wgpu::RequestAdapterStatus::Success, "request adapter");
        adapter = std::move(result);
      });
  pump_until(instance, [&] { return bool(adapter); });
  wgpu::Device device{};
  wgpu::DeviceDescriptor deviceDesc{};
  deviceDesc.SetDeviceLostCallback(wgpu::CallbackMode::AllowProcessEvents,
      [&](const wgpu::Device&, wgpu::DeviceLostReason, wgpu::StringView) {
        deviceLost = true;
        queue.cancel();
      });
  deviceDesc.SetUncapturedErrorCallback(
      [](const wgpu::Device&, wgpu::ErrorType, wgpu::StringView) {});
  adapter.RequestDevice(&deviceDesc, wgpu::CallbackMode::AllowProcessEvents,
      [&](wgpu::RequestDeviceStatus status, wgpu::Device result, wgpu::StringView) {
        require(status == wgpu::RequestDeviceStatus::Success, "request device");
        device = std::move(result);
      });
  pump_until(instance, [&] { return bool(device); });

  auto factory = [device](Queue::Completion done) { submit(device, std::move(done)); };
  auto first = queue.request(42, 0, true, factory).job;
  for (int i = 0; i < 100; ++i) queue.request(42, 0, true, factory);
  require(request_count() == 0, "request must not call the GPU");
  queue.service();
  require(request_count() == 1, "duplicate misses compile once");
  // No more requests for 42. The callback must still publish its result.
  for (int frame = 0; frame < 200; ++frame) {
    emscripten_sleep(0);
    instance.ProcessEvents();
    queue.service();
    require(first->status == Queue::Status::Compiling, "pending must not appear ready");
  }
  finish_request(0, false);
  // Let JS resolve, but do NOT pump: AllowProcessEvents must defer C++ completion.
  emscripten_sleep(0);
  require(first->status == Queue::Status::Compiling, "callback must run on explicit event pump");
  pump_until(instance, [&] { return first->status == Queue::Status::Ready; });
  auto completed = queue.take_completed();
  require(completed.size() == 1 && completed[0]->key == 42 && completed[0]->pipeline,
          "single-use pipeline must complete under its original key");
  completed.clear();

  auto failed = queue.request(99, 1, true, factory).job;
  queue.service();
  finish_request(1, true);
  pump_until(instance, [&] { return failed->status == Queue::Status::Failed; });
  require(failed->error.find("delayed validation failure") != std::string::npos,
          "copy callback error text before the JS stack expires");
  queue.take_completed();
  queue.request(99, 1, true, factory);
  queue.service();
  require(request_count() == 2, "failed pipeline must not retry on every request");

  auto stale = queue.request(123, 2, true, factory).job;
  queue.service();
  queue.reset();
  auto replacement = queue.request(123, 3, true, factory).job;
  queue.service();
  finish_request(2, false);
  // Flush the retired generation's real callback before finishing replacement.
  for (int i = 0; i < 10; ++i) { emscripten_sleep(0); instance.ProcessEvents(); }
  require(stale->status == Queue::Status::Cancelled && !stale->pipeline &&
              replacement->status == Queue::Status::Compiling && queue.take_completed().empty(),
          "retired callback must not populate the replacement cache");
  finish_request(3, false);
  pump_until(instance, [&] { return replacement->status == Queue::Status::Ready; });
  require(queue.take_completed().size() == 1, "replacement must finish normally");

  auto lost = queue.request(555, 4, true, factory).job;
  queue.service();
  device.Destroy();
  pump_until(instance, [&] { return deviceLost; });
  require(lost->status == Queue::Status::Cancelled && queue.pending() == 0,
          "device loss must retire in-flight jobs");
  finish_request(4, false);
  for (int i = 0; i < 10; ++i) { emscripten_sleep(0); instance.ProcessEvents(); }
  require(queue.take_completed().empty() && !lost->pipeline, "lost device cannot publish a late result");
  std::puts("PASS: real Emdawn bridge owns descriptors, pumps delayed promises, and ignores retired results");
}

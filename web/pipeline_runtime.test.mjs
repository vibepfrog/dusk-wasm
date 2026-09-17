import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = readFileSync(root + 'extern/aurora/lib/gfx/pipeline_cache.cpp', 'utf8');
const common = readFileSync(root + 'extern/aurora/lib/gfx/common.cpp', 'utf8');
function fn(source, signature) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, signature);
    const end = source.indexOf('\n}\n', start);
    assert.ok(end > start, signature);
    return source.slice(start, end + 3);
}

test('production frame policy skips only pending draws, publishes without rerequests, and drains existing jobs on OFF', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dusk-pipeline-runtime-'));
    try {
        // Actual cache service, protected barrier, frame policy and bind functions.
        // GPU objects/event delivery and clocks are controlled; this is not a GPU test.
        const source = `
#define __EMSCRIPTEN__
#include "extern/aurora/lib/gfx/async_pipeline_queue.hpp"
#include "extern/aurora/lib/gfx/pipeline_dependencies.hpp"
#include "extern/aurora/include/aurora/gfx.h"
#include <algorithm>
#include <cassert>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <functional>
#include <vector>
using PipelineRef = unsigned;
namespace wgpu {
using RenderPipeline = std::shared_ptr<int>;
struct RenderPassEncoder { mutable RenderPipeline bound; void SetPipeline(RenderPipeline p) const { bound = p; } };
}
using WebPipelineQueue = aurora::gfx::AsyncPipelineQueue<PipelineRef, wgpu::RenderPipeline>;
using aurora::gfx::PipelineDependencies;
WebPipelineQueue g_webPipelineQueue(2);
bool g_webPipelineCacheActive = true, g_pipelineFrameActive = false, g_hasPipelineThread = false;
bool g_asyncShaderCompilationRequested = true, g_currentDrawRequired = false;
bool g_currentPassComplete = true, g_frameSkippedDraw = false;
PipelineRef g_currentPipeline = 0;
size_t g_pipelinesPerFrame = 0;
std::string g_webPipelineFailure;
AuroraStats g_stats{};
auto& queuedPipelines = g_stats.queuedPipelines;
auto& createdPipelines = g_stats.createdPipelines;
struct CachedPipeline { wgpu::RenderPipeline pipeline; uint32_t firstFrameUsed; };
std::unordered_map<PipelineRef, CachedPipeline> g_pipelines;
std::mutex g_pipelineMutex;
struct Logger {
 template<class... T> void error(T...) {}
 template<class... T> void info(T...) {}
 template<class... T> void fatal(T...) { throw std::runtime_error("pipeline failure"); }
} Log;
namespace fmt { template<class... T> std::string format(T...) { return "pipeline failure"; } }
#define ASSERT(x, ...) do { if (!(x)) throw std::runtime_error("assertion"); } while (0)
${cache.slice(cache.indexOf('namespace diag {'), cache.indexOf('\n}', cache.indexOf('namespace diag {')) + 2)}
std::vector<std::function<void()>> events;
namespace webgpu {
struct Instance { operator bool() const { return true; }
 void ProcessEvents() { auto pending = std::move(events); events.clear(); for (auto& f : pending) f(); }
} g_instance;
}
namespace window { bool paused = false; bool is_paused() { return paused; } }
double now = 0; double emscripten_get_now() { return now; }
std::function<void()> onSleep;
void emscripten_sleep(int) { now += 1; assert(onSleep); onSleep(); }
static void require_pipeline_success();
${fn(cache, 'void set_async_shader_compilation(bool enabled) {')}
${fn(cache, 'void service_pipeline_compilation(size_t maxSubmissions) {')}
${fn(cache, 'void cancel_pipeline_compilation(std::string reason) {')}
${fn(cache, 'static void require_pipeline_success() {')}
${fn(cache, 'static void finish_pipeline_compilation() {')}
${fn(cache, 'void protect_pipeline_outputs(')}
${fn(cache, 'void begin_pipeline_frame() {')}
${fn(cache, 'void end_pipeline_frame() {')}
${fn(cache, 'bool get_pipeline(')}
${fn(common, 'bool bind_pipeline(')}
int main() {
 std::vector<PipelineRef> submitted;
 std::unordered_map<PipelineRef, WebPipelineQueue::Completion> callbacks;
 auto request = [&](PipelineRef key) {
   if (g_webPipelineQueue.request(key, 0, true, [&, key](auto done) {
     submitted.push_back(key); callbacks.emplace(key, std::move(done));
   }).inserted) ++queuedPipelines;
 };
 auto complete = [&](PipelineRef key) {
   auto cb = callbacks.at(key); callbacks.erase(key);
   events.push_back([cb, key] { cb(std::make_shared<int>(key), {}); });
 };
 wgpu::RenderPassEncoder pass;
 begin_pipeline_frame();
 assert(g_stats.asyncShaderCompilation); // Default ON.
 request(1); request(2); end_pipeline_frame();
 assert(submitted.size() == 1 && g_stats.inFlightPipelines == 1 && queuedPipelines == 2);
 assert(!bind_pipeline(1, pass) && !bind_pipeline(1, pass));
 assert(!pass.bound && g_stats.skippedPipelineDraws == 2 && g_stats.skippedPipelineFrames == 1);
 for (int i=0; i<200; ++i) service_pipeline_compilation(0);
 assert(submitted.size() == 1 && createdPipelines == 0);
 complete(1); service_pipeline_compilation(0);
 assert(createdPipelines == 1 && bind_pipeline(1, pass) && *pass.bound == 1);
 assert(submitted.size() == 1); // No re-request required for publication/binding.

 begin_pipeline_frame(); set_async_shader_compilation(false); end_pipeline_frame();
 assert(g_stats.asyncShaderCompilation && submitted.size() == 2); // Change is latched next frame.
 request(3); // Queue another one-time job, not necessarily drawn again.
 begin_pipeline_frame(); assert(!g_stats.asyncShaderCompilation);
 onSleep = [&] { while (!callbacks.empty()) complete(callbacks.begin()->first); };
 end_pipeline_frame();
 assert(queuedPipelines == 0 && createdPipelines == 3 && submitted.size() == 3);
 assert(g_stats.pipelineWaitMs > 0 && g_stats.inFlightPipelines == 0);
 g_currentDrawRequired = true;
 assert(bind_pipeline(2, pass) && *pass.bound == 2);

 set_async_shader_compilation(true); begin_pipeline_frame();
 request(4); request(5);
 using Dependencies = PipelineDependencies<PipelineRef>;
 Dependencies::Pass display{.color=1,.depth=2,.presentationOnly=true,.draws={{4},{5,true}}};
 protect_pipeline_outputs(Dependencies::analyze({display}));
 assert(submitted[3] == 5 && g_pipelines.contains(5)); // Required UI runs first.
 assert(bind_pipeline(5, pass));
 // Hidden frame finishes retirement but doesn't start another ordinary job.
 request(6); window::paused = true;
 const auto count = submitted.size(); end_pipeline_frame();
 assert(submitted.size() == count);
 while (!callbacks.empty()) complete(callbacks.begin()->first);
 service_pipeline_compilation(0); // Publish while hidden, without submitting 6.
 assert(submitted.size() == count && !g_pipelines.contains(6));
 window::paused = false; begin_pipeline_frame(); end_pipeline_frame();
 assert(callbacks.contains(6));
 auto failed = callbacks.at(6); callbacks.erase(6);
 failed({}, "driver rejected shader");
 bool reported = false;
 try { service_pipeline_compilation(0); } catch (const std::runtime_error&) { reported = true; }
 assert(reported && g_stats.failedPipelines == 1 && !g_pipelines.contains(6));
 // Failure cannot become an invisible, retried job on the next frame.
 assert(!g_webPipelineQueue.request(6, 0, true, [](auto) { assert(false); }).inserted);
}
`;
        const path = join(directory, 'runtime.cpp'), executable = join(directory, 'runtime');
        writeFileSync(path, source);
        const compile = spawnSync(process.env.CXX || 'c++', [
            '-std=c++20', '-O1', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
            '-I', root, path, '-o', executable,
        ], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
        const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 15_000 });
        assert.equal(run.status, 0, run.error?.message || run.stderr);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production FIFO marker preserves order and separates world draws from perspective UI and fades', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dusk-world-marker-'));
    try {
        const encoder = readFileSync(root + 'extern/aurora/lib/dolphin/gx/GXAurora.cpp', 'utf8');
        const decoder = readFileSync(root + 'extern/aurora/lib/gx/command_processor.cpp', 'utf8');
        const start = decoder.indexOf('    CHECK(pos + 1 <= size, "GX_LOAD_AURORA_ASYNC_WORLD');
        const end = decoder.indexOf('  } else if', start);
        const eligibility = decoder.match(/\.asyncEligible = ([\s\S]*?),\n  \}\);/)[1];
        assert.ok(start > 0 && end > start);
        const source = `
#include "extern/aurora/include/dolphin/gx/GXAurora.h"
#include <cassert>
#include <stdexcept>
#include <vector>
struct { bool asyncWorldDraws = false, stateDirty = false; GXProjectionType projType = GX_PERSPECTIVE; } g_gxState;
struct { bool depthCompare = true; GXCompare depthFunc = GX_LEQUAL; bool colorUpdate = true; } config;
std::vector<u8> bytes;
#define GX_WRITE_AURORA(x) do { bytes.push_back(0x50); bytes.push_back((x)>>8); bytes.push_back((x)&255); } while (0)
#define GX_WRITE_U8(x) bytes.push_back(x)
#define CHECK(x, ...) do { if (!(x)) throw std::runtime_error("truncated"); } while (0)
${fn(encoder, 'void GXSetAsyncWorldDraws(')}
void decode(const u8* data, u32 size) { u32 pos=0; ${decoder.slice(start, end)} assert(pos==1); }
bool eligible() { return ${eligibility}; }
int main() {
 assert(!eligible()); // Perspective UI is protected without explicit world scope.
 GXSetAsyncWorldDraws(GX_TRUE);
 assert(!g_gxState.asyncWorldDraws); // Merely writing FIFO must not alter earlier draws.
 assert(bytes.size()==4 && bytes[0]==0x50 && bytes[2]==GX_LOAD_AURORA_ASYNC_WORLD);
 decode(bytes.data()+3, 1);
 assert(eligible() && g_gxState.stateDirty); // Cannot merge across eligibility boundary.
 g_gxState.projType = GX_ORTHOGRAPHIC; assert(!eligible());
 g_gxState.projType = GX_PERSPECTIVE; config.depthCompare=false; assert(!eligible());
 config.depthCompare=true; config.depthFunc=GX_ALWAYS; assert(!eligible());
 config.depthFunc=GX_LEQUAL; config.colorUpdate=false; assert(!eligible());
 config.colorUpdate=true; assert(eligible());
 bytes.clear(); g_gxState.stateDirty=false; GXSetAsyncWorldDraws(GX_FALSE);
 assert(eligible()); decode(bytes.data()+3, 1);
 assert(!eligible() && g_gxState.stateDirty);
 bool failed=false; try { decode(bytes.data()+3, 0); } catch (...) { failed=true; }
 assert(failed); // Bounds checked before reading payload.
}
`;
        const path = join(directory, 'marker.cpp'), executable = join(directory, 'marker');
        writeFileSync(path, source);
        const compile = spawnSync(process.env.CXX || 'c++', [
            '-std=c++20', '-O1', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
            '-I', root, '-I', root + 'extern/aurora/include', path, '-o', executable,
        ], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
        const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 15_000 });
        assert.equal(run.status, 0, run.error?.message || run.stderr);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

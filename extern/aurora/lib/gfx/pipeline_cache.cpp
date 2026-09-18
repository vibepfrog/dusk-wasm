#include "pipeline_cache.hpp"
#ifdef __EMSCRIPTEN__
#include "async_pipeline_queue.hpp"
#endif

#include "clear.hpp"
#include "../gx/pipeline.hpp"
#include "../sqlite_utils.hpp"
#include "../webgpu/gpu.hpp"
#include "../window.hpp"

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <thread>

#include <absl/container/flat_hash_map.h>
#include <absl/container/flat_hash_set.h>
#include <fmt/format.h>
#include <tracy/Tracy.hpp>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace aurora::gfx {
static Module Log("aurora::gfx::pipeline_cache");

constexpr int PipelineCacheSchema = 1;

struct CachedPipeline {
  wgpu::RenderPipeline pipeline;
  uint32_t firstFrameUsed = UINT32_MAX;
};

struct PendingPipeline {
  PipelineRef hash;
  uint32_t firstFrameUsed = UINT32_MAX;
  NewPipelineCallback create;
};

struct PipelineCacheWrite {
  ShaderType type;
  PipelineRef hash;
  uint32_t configVersion;
  ByteBuffer config;
  uint32_t firstFrameUsed = UINT32_MAX;
};

static std::mutex g_pipelineMutex;
static bool g_hasPipelineThread = false;
static bool g_pipelineFrameActive = false;
static size_t g_pipelinesPerFrame = 0;
// For synchronous pipeline fallback (OpenGL)
#ifdef NDEBUG
constexpr size_t BuildPipelinesPerFrame = 5;
#else
constexpr size_t BuildPipelinesPerFrame = 1;
#endif

#ifdef __EMSCRIPTEN__
namespace diag {
uint64_t total_bind_failures = 0;
uint64_t total_pipelines_created = 0;
uint64_t bind_failures_this_frame = 0;
uint64_t pipelines_created_this_frame = 0;
uint32_t frames_since_summary = 0;
double compile_ms = 0.0;
double longest_compile_ms = 0.0;
uint64_t submitted_pipelines = 0;
uint64_t failed_pipelines = 0;
double protected_wait_ms = 0.0;
uint64_t protected_draws = 0, eligible_draws = 0;
uint64_t protected_misses = 0, eligible_misses = 0, conservative_frames = 0;
double dependency_wait_ms = 0.0;
}
#endif

template <typename Factory>
static auto create_measured_pipeline(Factory&& create) {
#ifdef __EMSCRIPTEN__
  const double start = emscripten_get_now();
#endif
  auto result = create(PipelineCompletion{});
#ifdef __EMSCRIPTEN__
  const double elapsed = emscripten_get_now() - start;
  diag::compile_ms += elapsed;
  diag::longest_compile_ms = std::max(diag::longest_compile_ms, elapsed);
#endif
  return result;
}
static std::thread g_pipelineThread;
static std::atomic_bool g_pipelineThreadEnd = false;
static std::condition_variable g_pipelineCv;
static absl::flat_hash_map<PipelineRef, CachedPipeline> g_pipelines;
static std::deque<PendingPipeline> g_priorityPipelines;
static std::deque<PendingPipeline> g_backgroundPipelines;
static absl::flat_hash_set<PipelineRef> g_pendingPipelines;
#ifdef __EMSCRIPTEN__
using WebPipelineQueue = AsyncPipelineQueue<PipelineRef, wgpu::RenderPipeline>;
static WebPipelineQueue g_webPipelineQueue{2};
static bool g_webPipelineCacheActive = false;
static std::string g_webPipelineFailure;
static bool g_asyncShaderCompilationRequested = true;
static bool g_aggressiveAsyncShaderCompilationRequested = false;
#endif

static sqlite3* g_pipelineCacheDb = nullptr;
static sqlite3_stmt* g_pipelineCacheLoadStmt = nullptr;
static sqlite3_stmt* g_pipelineCacheUpsertStmt = nullptr;
static bool g_pipelineCacheBroken = false;
static std::thread g_pipelineCacheWriterThread;
static std::condition_variable g_pipelineCacheWriterCv;
static std::mutex g_pipelineCacheWriterMutex;
static std::deque<PipelineCacheWrite> g_pipelineCacheWriteQueue;
static bool g_pipelineCacheWriterStop = false;

#if defined(__cpp_lib_atomic_ref)
static std::atomic_ref queuedPipelines{g_stats.queuedPipelines};
static std::atomic_ref createdPipelines{g_stats.createdPipelines};
#else
struct AtomicStatRef {
  uint32_t& ref;
  void operator++() { __atomic_fetch_add(&ref, 1, __ATOMIC_RELAXED); }
  void operator--() { __atomic_fetch_sub(&ref, 1, __ATOMIC_RELAXED); }
  void operator++(int) { __atomic_fetch_add(&ref, 1, __ATOMIC_RELAXED); }
  void operator--(int) { __atomic_fetch_sub(&ref, 1, __ATOMIC_RELAXED); }
  void operator=(uint32_t val) { __atomic_store_n(&ref, val, __ATOMIC_RELAXED); }
};
static AtomicStatRef queuedPipelines{g_stats.queuedPipelines};
static AtomicStatRef createdPipelines{g_stats.createdPipelines};
#endif

template <typename PipelineConfig>
static PipelineCacheWrite make_pipeline_cache_write(ShaderType type, PipelineRef hash, const PipelineConfig& config,
                                                    uint32_t firstFrameUsed) {
  static_assert(std::has_unique_object_representations_v<PipelineConfig>);

  PipelineCacheWrite write{
      .type = type,
      .hash = hash,
      .configVersion = config.version,
      .config = ByteBuffer(sizeof(config)),
      .firstFrameUsed = firstFrameUsed,
  };
  std::memcpy(write.config.data(), &config, sizeof(config));
  return write;
}

static void enqueue_pipeline_cache_write(PipelineCacheWrite write) {
#ifdef __EMSCRIPTEN__
  // Copy before returning: the temporary C++ buffer cannot outlive this call.
  // IndexedDB commits are asynchronous and batched on the browser main thread.
  MAIN_THREAD_EM_ASM({
    if (Module['duskPipelines']) Module['duskPipelines'].record(
      $0, $1 >>> 0, $2 >>> 0, $3 >>> 0, $4 >>> 0, HEAPU8.subarray($5, $5 + $6));
  }, underlying(write.type), uint32_t(write.hash), uint32_t(uint64_t(write.hash) >> 32),
     write.configVersion, write.firstFrameUsed, write.config.data(), write.config.size());
  return;
#endif
  if (g_pipelineCacheBroken || g_pipelineCacheDb == nullptr) {
    return;
  }

  {
    std::lock_guard lock{g_pipelineCacheWriterMutex};
    g_pipelineCacheWriteQueue.emplace_back(std::move(write));
  }
  g_pipelineCacheWriterCv.notify_one();
}

template <typename Queue>
static auto find_pending_pipeline(Queue& queue, PipelineRef hash) {
  return std::find_if(queue.begin(), queue.end(), [=](const PendingPipeline& pending) { return pending.hash == hash; });
}

static PendingPipeline* touch_pending_pipeline(PipelineRef hash, bool prioritize) {
  auto priorityIt = find_pending_pipeline(g_priorityPipelines, hash);
  if (priorityIt != g_priorityPipelines.end()) {
    return &*priorityIt;
  }

  auto backgroundIt = find_pending_pipeline(g_backgroundPipelines, hash);
  if (backgroundIt == g_backgroundPipelines.end()) {
    return nullptr;
  }

  if (!prioritize) {
    return &*backgroundIt;
  }

  g_priorityPipelines.emplace_back(std::move(*backgroundIt));
  g_backgroundPipelines.erase(backgroundIt);
  return &g_priorityPipelines.back();
}

template <typename PipelineConfig>
static PipelineRef find_pipeline_impl(ShaderType type, const PipelineConfig& config, NewPipelineCallback&& cb,
                                      bool persist, std::optional<uint32_t> firstFrameUsedOverride) {
  ZoneScoped;

  const PipelineRef hash = xxh3_hash(config, static_cast<HashType>(type));
  const uint32_t firstFrameUsed = firstFrameUsedOverride.value_or(current_frame());
  bool notifyWorker = false;
  std::optional<PipelineCacheWrite> cacheWrite;
  {
    std::scoped_lock guard{g_pipelineMutex};
    auto pipelineIt = g_pipelines.find(hash);
    if (pipelineIt != g_pipelines.end()) {
      if (persist && firstFrameUsed < pipelineIt->second.firstFrameUsed) {
        pipelineIt->second.firstFrameUsed = firstFrameUsed;
        cacheWrite = make_pipeline_cache_write(type, hash, config, firstFrameUsed);
      }
    }
#ifdef __EMSCRIPTEN__
    else {
      ASSERT(g_webPipelineCacheActive && g_webPipelineQueue.active(),
             "Pipeline request after renderer/device shutdown: {}", g_webPipelineFailure);
      auto request = g_webPipelineQueue.request(
          hash, firstFrameUsed, g_pipelineFrameActive,
          [create = std::move(cb)](PipelineCompletion done) { create(std::move(done)); });
      if (persist && (request.inserted || request.earlierUse)) {
        cacheWrite = make_pipeline_cache_write(type, hash, config, firstFrameUsed);
      }
      notifyWorker = request.inserted;
    }
#else
    else if (g_pendingPipelines.contains(hash)) {
      auto* pending = touch_pending_pipeline(hash, g_pipelineFrameActive);
      if (pending != nullptr && firstFrameUsed < pending->firstFrameUsed) {
        pending->firstFrameUsed = firstFrameUsed;
        if (persist) {
          cacheWrite = make_pipeline_cache_write(type, hash, config, firstFrameUsed);
        }
      }
    } else {
      if (!g_hasPipelineThread && g_pipelinesPerFrame < BuildPipelinesPerFrame) {
        g_pipelines.try_emplace(hash, CachedPipeline{
                                          .pipeline = create_measured_pipeline(cb),
                                          .firstFrameUsed = firstFrameUsed,
                                      });
        if (persist) {
          cacheWrite = make_pipeline_cache_write(type, hash, config, firstFrameUsed);
        }
        ++g_pipelinesPerFrame;
        ++createdPipelines;
      } else {
        auto& targetQueue = g_pipelineFrameActive ? g_priorityPipelines : g_backgroundPipelines;
        targetQueue.emplace_back(PendingPipeline{
            .hash = hash,
            .firstFrameUsed = firstFrameUsed,
            .create = std::move(cb),
        });
        g_pendingPipelines.insert(hash);
        if (persist) {
          cacheWrite = make_pipeline_cache_write(type, hash, config, firstFrameUsed);
        }
        notifyWorker = true;
      }
    }
#endif
  }

  if (cacheWrite) {
    enqueue_pipeline_cache_write(std::move(*cacheWrite));
  }

  if (notifyWorker) {
#ifndef __EMSCRIPTEN__
    g_pipelineCv.notify_one();
#endif
    ++queuedPipelines;
  }

  return hash;
}

static void pipeline_cache_abort() {
  g_pipelineCacheBroken = true;
  if (g_pipelineCacheLoadStmt != nullptr) {
    sqlite3_finalize(g_pipelineCacheLoadStmt);
    g_pipelineCacheLoadStmt = nullptr;
  }
  if (g_pipelineCacheUpsertStmt != nullptr) {
    sqlite3_finalize(g_pipelineCacheUpsertStmt);
    g_pipelineCacheUpsertStmt = nullptr;
  }
  if (g_pipelineCacheDb != nullptr) {
    sqlite3_close(g_pipelineCacheDb);
    g_pipelineCacheDb = nullptr;
  }
}

static bool prepare_pipeline_cache_db() {
  if (g_pipelineCacheBroken) {
    return false;
  }
  if (g_pipelineCacheDb != nullptr) {
    return true;
  }

  const auto path = (std::filesystem::path{g_config.configPath} / "pipeline_cache.db").string();
  auto ret = sqlite3_open(path.c_str(), &g_pipelineCacheDb);
  if (ret != SQLITE_OK) {
    Log.error("Failed to open pipeline cache database: {}", sqlite3_errmsg(g_pipelineCacheDb));
    pipeline_cache_abort();
    return false;
  }

  ret = sqlite::exec(g_pipelineCacheDb, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  if (ret != SQLITE_OK) {
    Log.error("Failed to set pipeline cache pragmas: {}", sqlite3_errmsg(g_pipelineCacheDb));
    pipeline_cache_abort();
    return false;
  }

  bool schemaFailed = false;
  {
    sqlite::Transaction tx(g_pipelineCacheDb, Log, true);
    if (!tx) {
      Log.error("Failed to begin pipeline cache schema transaction");
      schemaFailed = true;
    } else {
      ret = sqlite::exec(g_pipelineCacheDb, "CREATE TABLE IF NOT EXISTS aurora_schema(value INTEGER);");
      if (ret != SQLITE_OK) {
        Log.error("Failed to create pipeline cache schema table: {}", sqlite3_errmsg(g_pipelineCacheDb));
        schemaFailed = true;
      }
    }

    bool schemaMatch = false;
    if (!schemaFailed) {
      const auto schemaQuery = fmt::format("SELECT 1 FROM aurora_schema WHERE value = {}", PipelineCacheSchema);
      ret = sqlite::exec(g_pipelineCacheDb, schemaQuery.c_str(),
                         [&schemaMatch](int, char**, char**) { schemaMatch = true; });
      if (ret != SQLITE_OK) {
        Log.error("Failed to read pipeline cache schema version: {}", sqlite3_errmsg(g_pipelineCacheDb));
        schemaFailed = true;
      }
    }

    if (!schemaFailed && !schemaMatch) {
      const auto schemaSql = fmt::format(
          R"(DROP TABLE IF EXISTS pipeline_cache;
CREATE TABLE pipeline_cache (
  type INTEGER NOT NULL,
  hash INTEGER NOT NULL,
  config_version INTEGER NOT NULL,
  config_size INTEGER NOT NULL,
  config BLOB NOT NULL,
  first_frame_used INTEGER NOT NULL,
  PRIMARY KEY (type, hash)
);
CREATE INDEX pipeline_cache_load_order_idx
  ON pipeline_cache(type, config_version, first_frame_used);
DELETE FROM aurora_schema;
INSERT INTO aurora_schema VALUES ({});)",
          PipelineCacheSchema);
      ret = sqlite::exec(g_pipelineCacheDb, schemaSql.c_str());
      if (ret != SQLITE_OK) {
        Log.error("Failed to initialize pipeline cache schema: {}", sqlite3_errmsg(g_pipelineCacheDb));
        schemaFailed = true;
      }
    }

    if (!schemaFailed) {
      tx.commit();
    }
  }

  if (schemaFailed) {
    pipeline_cache_abort();
    return false;
  }

  ret = sqlite3_prepare_v3(g_pipelineCacheDb,
                           "SELECT config, first_frame_used FROM pipeline_cache "
                           "WHERE type = ? AND config_version = ? "
                           "ORDER BY first_frame_used ASC, rowid ASC",
                           -1, SQLITE_PREPARE_PERSISTENT, &g_pipelineCacheLoadStmt, nullptr);
  if (ret != SQLITE_OK) {
    Log.error("Failed to prepare pipeline cache load statement: {}", sqlite3_errmsg(g_pipelineCacheDb));
    pipeline_cache_abort();
    return false;
  }

  ret = sqlite3_prepare_v3(
      g_pipelineCacheDb,
      "INSERT INTO pipeline_cache (type, hash, config_version, config_size, config, first_frame_used) "
      "VALUES (?, ?, ?, ?, ?, ?) "
      "ON CONFLICT(type, hash) DO UPDATE SET "
      "config_version = excluded.config_version, "
      "config_size = excluded.config_size, "
      "config = excluded.config, "
      "first_frame_used = MIN(pipeline_cache.first_frame_used, excluded.first_frame_used)",
      -1, SQLITE_PREPARE_PERSISTENT, &g_pipelineCacheUpsertStmt, nullptr);
  if (ret != SQLITE_OK) {
    Log.error("Failed to prepare pipeline cache upsert statement: {}", sqlite3_errmsg(g_pipelineCacheDb));
    pipeline_cache_abort();
    return false;
  }

  return true;
}

static void prune_old_pipeline_cache_versions() {
  if (!prepare_pipeline_cache_db()) {
    return;
  }

  const auto clearDelete = fmt::format("DELETE FROM pipeline_cache WHERE type = {} AND config_version < {}",
                                       underlying(ShaderType::Clear), clear::ClearPipelineConfigVersion);
  auto ret = sqlite::exec(g_pipelineCacheDb, clearDelete.c_str());
  if (ret != SQLITE_OK) {
    Log.error("Failed to prune clear pipeline cache rows: {}", sqlite3_errmsg(g_pipelineCacheDb));
    pipeline_cache_abort();
    return;
  }

  const auto gxDelete = fmt::format("DELETE FROM pipeline_cache WHERE type = {} AND config_version < {}",
                                    underlying(ShaderType::GX), gx::GXPipelineConfigVersion);
  ret = sqlite::exec(g_pipelineCacheDb, gxDelete.c_str());
  if (ret != SQLITE_OK) {
    Log.error("Failed to prune GX pipeline cache rows: {}", sqlite3_errmsg(g_pipelineCacheDb));
    pipeline_cache_abort();
  }
}

static bool write_pipeline_cache_record(const PipelineCacheWrite& write) {
  const auto fail = [&]() {
    sqlite3_reset(g_pipelineCacheUpsertStmt);
    sqlite3_clear_bindings(g_pipelineCacheUpsertStmt);
    return false;
  };

  auto ret = sqlite3_bind_int(g_pipelineCacheUpsertStmt, 1, underlying(write.type));
  if (ret != SQLITE_OK) {
    Log.error("Failed to bind pipeline cache type: {}", sqlite3_errmsg(g_pipelineCacheDb));
    return fail();
  }
  ret = sqlite3_bind_int64(g_pipelineCacheUpsertStmt, 2, static_cast<sqlite3_int64>(write.hash));
  if (ret != SQLITE_OK) {
    Log.error("Failed to bind pipeline cache hash: {}", sqlite3_errmsg(g_pipelineCacheDb));
    return fail();
  }
  ret = sqlite3_bind_int(g_pipelineCacheUpsertStmt, 3, static_cast<int>(write.configVersion));
  if (ret != SQLITE_OK) {
    Log.error("Failed to bind pipeline cache config version: {}", sqlite3_errmsg(g_pipelineCacheDb));
    return fail();
  }
  ret = sqlite3_bind_int(g_pipelineCacheUpsertStmt, 4, static_cast<int>(write.config.size()));
  if (ret != SQLITE_OK) {
    Log.error("Failed to bind pipeline cache config size: {}", sqlite3_errmsg(g_pipelineCacheDb));
    return fail();
  }
  ret = sqlite3_bind_blob64(g_pipelineCacheUpsertStmt, 5, write.config.data(), write.config.size(), SQLITE_TRANSIENT);
  if (ret != SQLITE_OK) {
    Log.error("Failed to bind pipeline cache config blob: {}", sqlite3_errmsg(g_pipelineCacheDb));
    return fail();
  }
  ret = sqlite3_bind_int64(g_pipelineCacheUpsertStmt, 6, static_cast<sqlite3_int64>(write.firstFrameUsed));
  if (ret != SQLITE_OK) {
    Log.error("Failed to bind pipeline cache first-frame-used: {}", sqlite3_errmsg(g_pipelineCacheDb));
    return fail();
  }

  ret = sqlite3_step(g_pipelineCacheUpsertStmt);
  if (ret != SQLITE_DONE) {
    Log.error("Failed to upsert pipeline cache row: {}", sqlite3_errmsg(g_pipelineCacheDb));
    return fail();
  }

  sqlite3_reset(g_pipelineCacheUpsertStmt);
  sqlite3_clear_bindings(g_pipelineCacheUpsertStmt);
  return true;
}

static void pipeline_cache_writer() {
#ifdef TRACY_ENABLE
  tracy::SetThreadName("Pipeline cache writer thread");
#endif

  while (true) {
    std::deque<PipelineCacheWrite> batch;
    {
      std::unique_lock lock{g_pipelineCacheWriterMutex};
      g_pipelineCacheWriterCv.wait(lock,
                                   [] { return g_pipelineCacheWriterStop || !g_pipelineCacheWriteQueue.empty(); });
      if (g_pipelineCacheWriterStop && g_pipelineCacheWriteQueue.empty()) {
        return;
      }
      batch.swap(g_pipelineCacheWriteQueue);
    }

    bool writeFailed = false;
    {
      sqlite::Transaction tx(g_pipelineCacheDb, Log, true);
      if (!tx) {
        Log.error("Failed to begin pipeline cache write transaction");
        writeFailed = true;
      } else {
        for (const auto& write : batch) {
          if (!write_pipeline_cache_record(write)) {
            writeFailed = true;
            break;
          }
        }

        if (!writeFailed) {
          tx.commit();
        }
      }
    }

    if (writeFailed) {
      pipeline_cache_abort();
      return;
    }
  }
}

static void pipeline_worker() {
#ifdef TRACY_ENABLE
  tracy::SetThreadName("Pipeline compilation thread");
#endif

  bool hasMore = false;
  while (g_hasPipelineThread || g_pipelinesPerFrame < BuildPipelinesPerFrame) {
    PendingPipeline pending;
    {
      std::unique_lock lock{g_pipelineMutex};
      if (g_hasPipelineThread) {
        if (!hasMore) {
          g_pipelineCv.wait(lock, [] {
            return !g_priorityPipelines.empty() || !g_backgroundPipelines.empty() || g_pipelineThreadEnd;
          });
        }
      } else if (g_priorityPipelines.empty() && g_backgroundPipelines.empty()) {
        return;
      }
      if (g_pipelineThreadEnd) {
        break;
      }
      auto& source = !g_priorityPipelines.empty() ? g_priorityPipelines : g_backgroundPipelines;
      pending = std::move(source.front());
      source.pop_front();
    }
    auto result = create_measured_pipeline(pending.create);
    {
      std::lock_guard lock{g_pipelineMutex};
      g_pipelines.try_emplace(pending.hash, CachedPipeline{
                                                .pipeline = std::move(result),
                                                .firstFrameUsed = pending.firstFrameUsed,
                                            });
      g_pendingPipelines.erase(pending.hash);
      hasMore = !g_priorityPipelines.empty() || !g_backgroundPipelines.empty();
    }
    if (!g_hasPipelineThread) {
      ++g_pipelinesPerFrame;
    }
    ++createdPipelines;
    --queuedPipelines;
  }
}

template <typename PipelineConfig, typename CreateFn>
static void load_pipeline_cache_entries(ShaderType type, uint32_t configVersion, CreateFn&& create) {
#ifdef __EMSCRIPTEN__
  std::ifstream input("/dusk/pipeline-recipes.bin", std::ios::binary | std::ios::ate);
  if (!input || input.tellg() < 8 || input.tellg() > 16 * 1024 * 1024) return;
  input.seekg(0);
  char magic[8];
  if (!input.read(magic, 8) || std::memcmp(magic, "DUSKPC01", 8) != 0) return;
  uint32_t row[6];
  size_t count = 0;
  while (count++ < 10000 && input.read(reinterpret_cast<char*>(row), sizeof(row))) {
    if (row[2] > 8192) break;
    if (row[0] != underlying(type) || row[1] != configVersion || row[2] != sizeof(PipelineConfig)) {
      input.seekg(row[2], std::ios::cur);
      continue;
    }
    PipelineConfig config;
    if (!input.read(reinterpret_cast<char*>(&config), sizeof(config))) break;
    const uint64_t hash = uint64_t(row[4]) | uint64_t(row[5]) << 32;
    if (config.version != configVersion || xxh3_hash(config, static_cast<HashType>(type)) != hash) continue;
    find_pipeline_impl(type, config,
                       [=](PipelineCompletion done) { return create(config, std::move(done)); }, false, row[3]);
  }
  return;
#endif
  if (!prepare_pipeline_cache_db()) {
    return;
  }

  auto ret = sqlite3_bind_int(g_pipelineCacheLoadStmt, 1, underlying(type));
  if (ret != SQLITE_OK) {
    Log.error("Failed to bind pipeline cache load type: {}", sqlite3_errmsg(g_pipelineCacheDb));
    pipeline_cache_abort();
    return;
  }
  ret = sqlite3_bind_int(g_pipelineCacheLoadStmt, 2, static_cast<int>(configVersion));
  if (ret != SQLITE_OK) {
    Log.error("Failed to bind pipeline cache load config version: {}", sqlite3_errmsg(g_pipelineCacheDb));
    pipeline_cache_abort();
    return;
  }

  while ((ret = sqlite3_step(g_pipelineCacheLoadStmt)) == SQLITE_ROW) {
    const auto* configBlob = static_cast<const uint8_t*>(sqlite3_column_blob(g_pipelineCacheLoadStmt, 0));
    const auto configSize = sqlite3_column_bytes(g_pipelineCacheLoadStmt, 0);
    const auto firstFrameUsed = static_cast<uint32_t>(sqlite3_column_int64(g_pipelineCacheLoadStmt, 1));
    if (configSize != static_cast<int>(sizeof(PipelineConfig)) || (configSize != 0 && configBlob == nullptr)) {
      continue;
    }

    PipelineConfig config;
    std::memcpy(&config, configBlob, sizeof(config));
    if (config.version != configVersion) {
      continue;
    }

    find_pipeline_impl(type, config,
                       [=](PipelineCompletion done) { return create(config, std::move(done)); }, false, firstFrameUsed);
  }

  if (ret != SQLITE_DONE) {
    Log.error("Failed to read pipeline cache rows: {}", sqlite3_errmsg(g_pipelineCacheDb));
    pipeline_cache_abort();
  }

  sqlite3_reset(g_pipelineCacheLoadStmt);
  sqlite3_clear_bindings(g_pipelineCacheLoadStmt);
}

static void load_pipeline_cache() {
#ifndef __EMSCRIPTEN__
  if (!prepare_pipeline_cache_db()) {
    return;
  }
  prune_old_pipeline_cache_versions();
  if (g_pipelineCacheBroken) {
    return;
  }
#endif

  load_pipeline_cache_entries<clear::PipelineConfig>(ShaderType::Clear, clear::ClearPipelineConfigVersion,
                                                     clear::create_pipeline);
  if (g_pipelineCacheBroken) {
    return;
  }
  load_pipeline_cache_entries<gx::PipelineConfig>(ShaderType::GX, gx::GXPipelineConfigVersion, gx::create_pipeline);
}

static void start_pipeline_cache_writer() {
#ifdef __EMSCRIPTEN__
  return; // Browser recipes use IndexedDB; never enqueue unused SQLite writes.
#else
  if (!prepare_pipeline_cache_db()) {
    return;
  }

  g_pipelineCacheWriterStop = false;
  g_pipelineCacheWriterThread = std::thread(pipeline_cache_writer);
#endif
}

static void stop_pipeline_cache_writer() {
  if (g_pipelineCacheWriterThread.joinable()) {
    {
      std::lock_guard lock{g_pipelineCacheWriterMutex};
      g_pipelineCacheWriterStop = true;
    }
    g_pipelineCacheWriterCv.notify_one();
    g_pipelineCacheWriterThread.join();
  } else {
    g_pipelineCacheWriterStop = false;
  }

  g_pipelineCacheWriteQueue.clear();
}

template <>
PipelineRef find_pipeline(ShaderType type, const clear::PipelineConfig& config, NewPipelineCallback&& cb) {
  return find_pipeline_impl(type, config, std::move(cb), true, std::nullopt);
}

template <>
PipelineRef find_pipeline(ShaderType type, const gx::PipelineConfig& config, NewPipelineCallback&& cb) {
  return find_pipeline_impl(type, config, std::move(cb), true, std::nullopt);
}

#ifdef __EMSCRIPTEN__
static void require_pipeline_success();

void set_async_shader_compilation(bool enabled) {
  g_asyncShaderCompilationRequested = enabled;
}

void set_aggressive_async_shader_compilation(bool enabled) {
  g_aggressiveAsyncShaderCompilationRequested = enabled;
}

void service_pipeline_compilation(size_t maxSubmissions) {
  if (!g_webPipelineCacheActive) return;
  // Always pump, even with zero submission budget or no new cache lookups.
  // Never hold g_pipelineMutex while invoking the browser or user callbacks.
  if (webgpu::g_instance) webgpu::g_instance.ProcessEvents();
  require_pipeline_success();
  if (!g_webPipelineQueue.active()) return;
  if (g_webPipelineFailure.empty()) {
    const double start = emscripten_get_now();
    const auto submitted = g_webPipelineQueue.service(maxSubmissions);
    if (submitted) {
      const double elapsed = emscripten_get_now() - start;
      diag::compile_ms += elapsed; // CPU preparation/submission, not GPU latency.
      diag::longest_compile_ms = std::max(diag::longest_compile_ms, elapsed);
      diag::submitted_pipelines += submitted;
      g_stats.submittedPipelines += submitted;
    }
  }
  for (auto& job : g_webPipelineQueue.take_completed()) {
    --queuedPipelines;
    if (job->status == WebPipelineQueue::Status::Ready) {
      {
        std::lock_guard lock{g_pipelineMutex};
        g_pipelines.try_emplace(job->key, CachedPipeline{
            .pipeline = std::move(job->pipeline), .firstFrameUsed = job->firstFrameUsed});
      }
      ++createdPipelines;
      ++diag::pipelines_created_this_frame;
      ++diag::total_pipelines_created;
    } else {
      ++diag::failed_pipelines;
      ++g_stats.failedPipelines;
      if (g_webPipelineFailure.empty()) {
        g_webPipelineFailure = fmt::format("Pipeline {} failed: {}", job->key, job->error);
        Log.error("{}", g_webPipelineFailure);
      }
    }
  }
  g_stats.inFlightPipelines = g_webPipelineQueue.in_flight();
  require_pipeline_success(); // Fail visibly even during hidden/paused updates.
}

void cancel_pipeline_compilation(std::string reason) {
  if (!g_webPipelineCacheActive) return;
  g_webPipelineFailure = std::move(reason);
  g_webPipelineQueue.cancel();
  queuedPipelines = 0;
  g_stats.inFlightPipelines = 0;
}

static void require_pipeline_success() {
  if (!g_webPipelineFailure.empty()) Log.fatal("{}", g_webPipelineFailure);
}

// Complete-frame fallback and OFF mode. Existing jobs are drained, never reset
// or duplicated. All waits precede encoding and surface acquisition.
static void finish_pipeline_compilation() {
  const double start = emscripten_get_now();
  const bool waited = g_webPipelineQueue.pending() != 0;
  do {
    service_pipeline_compilation(2);
    require_pipeline_success();
    if (!g_webPipelineQueue.pending()) break;
    emscripten_sleep(0);
  } while (true);
  if (waited) {
    const double elapsed = emscripten_get_now() - start;
    diag::protected_wait_ms += elapsed;
    g_stats.pipelineWaitMs += elapsed;
  }
}

void protect_pipeline_outputs(const PipelineDependencies<PipelineRef>::Plan& plan) {
  require_pipeline_success();
  // Deliberate opt-in: no protected, readback or unknown-output wait, even when
  // a one-time copy can permanently capture missing drawing. Jobs still retire.
  if (g_stats.aggressiveAsyncShaderCompilation) return;
  auto ready = [](PipelineRef ref) {
    std::lock_guard lock{g_pipelineMutex};
    const auto it = g_pipelines.find(ref);
    return it != g_pipelines.end() && bool(it->second.pipeline);
  };
  diag::protected_draws += plan.protectedDraws;
  diag::eligible_draws += plan.eligibleDraws;
  diag::conservative_frames += plan.forceCompleteFrame;
  for (auto ref : plan.eligible) diag::eligible_misses += !ready(ref);
  size_t missing = 0;
  for (auto ref : plan.required) {
    if (ready(ref)) continue;
    ++missing;
    ASSERT(g_webPipelineQueue.require(ref), "Protected pipeline {} has no queued job", ref);
  }
  diag::protected_misses += missing;
  const double start = emscripten_get_now();
  if (plan.forceCompleteFrame) {
    finish_pipeline_compilation();
  } else if (missing) {
    // Retain current-frame commands/buffers, yield only the owning worker, and
    // wait before encoding any copy/readback. Never hold a surface or mutex.
    do {
      service_pipeline_compilation(2);
      require_pipeline_success();
      if (std::all_of(plan.required.begin(), plan.required.end(), ready)) break;
      ASSERT(g_webPipelineQueue.pending(), "Protected pipeline disappeared before completion");
      emscripten_sleep(0);
    } while (true);
  }
  if (missing || plan.forceCompleteFrame) {
    const double elapsed = emscripten_get_now() - start;
    diag::dependency_wait_ms += elapsed;
    // Complete-frame fallback already accounts for its wait above.
    if (!plan.forceCompleteFrame) g_stats.pipelineWaitMs += elapsed;
  }
}
#endif

void initialize_pipeline_cache() {
  g_pipelineCacheBroken = false;
  g_pipelineCacheWriterStop = false;
  g_pipelineFrameActive = false;
  g_pipelineThreadEnd = false;

  if (webgpu::g_backendType == wgpu::BackendType::OpenGL || webgpu::g_backendType == wgpu::BackendType::OpenGLES ||
      webgpu::g_backendType == wgpu::BackendType::WebGPU) {
    g_hasPipelineThread = false;
  } else {
    g_hasPipelineThread = true;
    g_pipelineThread = std::thread(pipeline_worker);
  }

#ifdef __EMSCRIPTEN__
  g_webPipelineQueue.reset();
  g_webPipelineFailure.clear();
  g_webPipelineCacheActive = true;
  g_pipelines.clear();
  queuedPipelines = 0;
  createdPipelines = 0;
  g_stats.submittedPipelines = g_stats.failedPipelines = g_stats.inFlightPipelines = 0;
  g_stats.skippedPipelineDraws = g_stats.skippedPipelineFrames = 0;
  g_stats.pipelineWaitMs = 0;
  g_stats.unprotectedPipelineSkips = false;
  g_stats.aggressiveAsyncShaderCompilation = g_aggressiveAsyncShaderCompilationRequested;
  g_stats.asyncShaderCompilation = g_asyncShaderCompilationRequested || g_stats.aggressiveAsyncShaderCompilation;
  diag::total_bind_failures = diag::total_pipelines_created = 0;
  diag::bind_failures_this_frame = diag::pipelines_created_this_frame = 0;
  diag::submitted_pipelines = diag::failed_pipelines = 0;
  diag::frames_since_summary = 0;
  diag::compile_ms = diag::longest_compile_ms = diag::protected_wait_ms = 0;
  diag::protected_draws = diag::eligible_draws = 0;
  diag::protected_misses = diag::eligible_misses = diag::conservative_frames = 0;
  diag::dependency_wait_ms = 0;
#endif
  load_pipeline_cache();
#ifdef __EMSCRIPTEN__
  const size_t total = g_pipelines.size() + g_webPipelineQueue.pending();
  if (total) Log.info("Preparing {} saved shader pipelines before play", total);
  while (g_webPipelineQueue.pending()) {
    MAIN_THREAD_EM_ASM({
      if (Module['duskPipelines']) Module['duskPipelines'].status('Preparing shaders: ' + $0 + ' / ' + $1);
      if (Module.setStatus) Module.setStatus('Preparing shaders: ' + $0 + ' / ' + $1);
    }, g_pipelines.size(), total);
    service_pipeline_compilation(2);
    require_pipeline_success();
    if (g_webPipelineQueue.pending()) emscripten_sleep(0);
  }
  g_pipelinesPerFrame = 0;
  MAIN_THREAD_EM_ASM({
    if (Module['duskPipelines']) Module['duskPipelines'].status($0
      ? $0 + ' shaders prepared. New shaders will be remembered as you play.'
      : 'Shaders will be remembered as you play.');
    if (Module.setStatus) Module.setStatus('');
  }, total);
#endif
  if (!g_pipelineCacheBroken) {
    start_pipeline_cache_writer();
  }
}

wgpu::RenderPipeline create_render_pipeline(const wgpu::RenderPipelineDescriptor* descriptor,
                                           PipelineCompletion complete) {
#ifdef __EMSCRIPTEN__
  if (complete) {
    submit_pipeline_async(webgpu::g_device, descriptor, std::move(complete));
    return {}; // Pending is owned by the queue, never installed as a ready pipeline.
  }
#endif
  return webgpu::g_device.CreateRenderPipeline(descriptor);
}

void shutdown_pipeline_cache() {
#ifdef __EMSCRIPTEN__
  g_webPipelineCacheActive = false;
  g_webPipelineQueue.cancel();
  g_webPipelineFailure.clear();
#endif
  if (g_hasPipelineThread) {
    g_pipelineThreadEnd = true;
    g_pipelineCv.notify_all();
    g_pipelineThread.join();
  }
  g_hasPipelineThread = false;

  stop_pipeline_cache_writer();
  pipeline_cache_abort();
  g_pipelineCacheBroken = false;
  g_pipelineFrameActive = false;
  g_pipelinesPerFrame = 0;
  g_pipelines.clear();
  g_priorityPipelines.clear();
  g_backgroundPipelines.clear();
  g_pendingPipelines.clear();

  queuedPipelines = 0;
  createdPipelines = 0;
}

void begin_pipeline_frame() {
#ifdef __EMSCRIPTEN__
  g_stats.aggressiveAsyncShaderCompilation = g_aggressiveAsyncShaderCompilationRequested;
  g_stats.asyncShaderCompilation = g_asyncShaderCompilationRequested || g_stats.aggressiveAsyncShaderCompilation;
#endif
  g_pipelineFrameActive = true;
  if (!g_hasPipelineThread) {
    g_pipelinesPerFrame = 0;
  }
}

void end_pipeline_frame() {
  g_pipelineFrameActive = false;
#ifdef __EMSCRIPTEN__
  if (g_stats.asyncShaderCompilation) {
    // At most one ordinary submission per rendered frame, with two in flight.
    // Protected waits may fill both slots. Hidden updates only publish results.
    service_pipeline_compilation(window::is_paused() ? 0 : 1);
  } else {
    finish_pipeline_compilation();
  }
#else
  if (!g_hasPipelineThread) pipeline_worker();
#endif
#ifdef __EMSCRIPTEN__
  // Completion counts exclude queued/failed work. CPU submission time and
  // complete-rendering waits are different measurements; neither is GPU time.
  if (++diag::frames_since_summary >= 60) {
    diag::frames_since_summary = 0;
    size_t pending_after = 0;
    {
      std::lock_guard lock{g_pipelineMutex};
      pending_after = g_webPipelineQueue.pending();
    }
    if (diag::bind_failures_this_frame > 0 || diag::pipelines_created_this_frame > 0 ||
        diag::submitted_pipelines > 0 || diag::failed_pipelines > 0) {
      Log.info("[PipelineDiag] completed={} submitted={} failed={} bind_fails={}"
               " | totals: built={} bind_fails={} | pending={} in_flight={}"
               " | submit_cpu_ms={:.1f} longest_submit_ms={:.1f} protected_wait_ms={:.1f}",
               diag::pipelines_created_this_frame, diag::submitted_pipelines, diag::failed_pipelines,
               diag::bind_failures_this_frame, diag::total_pipelines_created,
               diag::total_bind_failures, pending_after, g_webPipelineQueue.in_flight(),
               diag::compile_ms, diag::longest_compile_ms, diag::protected_wait_ms);
      Log.info("[PipelineProtection] draws: protected={} eligible={} | misses: protected={} eligible={}"
               " | conservative_frames={} dependency_wait_ms={:.1f}",
               diag::protected_draws, diag::eligible_draws, diag::protected_misses,
               diag::eligible_misses, diag::conservative_frames, diag::dependency_wait_ms);
    }
    diag::pipelines_created_this_frame = 0;
    diag::bind_failures_this_frame = 0;
    diag::compile_ms = 0.0;
    diag::longest_compile_ms = 0.0;
    diag::submitted_pipelines = diag::failed_pipelines = 0;
    diag::protected_wait_ms = 0.0;
    diag::protected_draws = diag::eligible_draws = 0;
    diag::protected_misses = diag::eligible_misses = diag::conservative_frames = 0;
    diag::dependency_wait_ms = 0;
  }
#endif
}

bool get_pipeline(PipelineRef ref, wgpu::RenderPipeline& pipeline) {
  std::lock_guard guard{g_pipelineMutex};
  const auto it = g_pipelines.find(ref);
  if (it == g_pipelines.end()) {
#ifdef __EMSCRIPTEN__
    ++diag::bind_failures_this_frame;
    ++diag::total_bind_failures;
#endif
    return false;
  }
  pipeline = it->second.pipeline;
  return true;
}

} // namespace aurora::gfx

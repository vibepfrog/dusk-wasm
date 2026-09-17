#include "../lib/gfx/async_pipeline_queue.hpp"

#include <cstdio>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <unordered_map>
#include <vector>

using Pipeline = std::shared_ptr<int>;
using Queue = aurora::gfx::AsyncPipelineQueue<unsigned, Pipeline>;
using Status = Queue::Status;

static void require(bool value, const char* message) {
  if (!value) { std::fprintf(stderr, "FAIL: %s\n", message); std::exit(1); }
}

static void single_request_and_duplicates() {
  Queue queue;
  std::vector<Queue::Completion> callbacks;
  unsigned submissions = 0;
  auto factory = [&](Queue::Completion done) { ++submissions; callbacks.push_back(std::move(done)); };
  auto first = queue.request(17, 200, false, factory);
  require(first.inserted && first.job->status == Status::Queued, "request only queues work");
  require(submissions == 0, "request must not perform GPU work");
  for (unsigned i = 100; i > 0; --i) {
    auto duplicate = queue.request(17, i, true, factory);
    require(!duplicate.inserted && duplicate.job == first.job, "queued requests deduplicate");
  }
  require(first.job->firstFrameUsed == 1 && first.job->priority, "promotion keeps earliest use");
  require(queue.service() == 1 && queue.in_flight() == 1, "one async submission");
  require(!queue.request(17, 0, true, factory).inserted, "in-flight request deduplicates");
  for (unsigned frame = 0; frame < 200; ++frame) {
    queue.service(); // No further request for this shader, including paused frames.
    require(queue.take_completed().empty(), "pending must not masquerade as ready");
  }
  require(submissions == 1 && first.job->firstFrameUsed == 0, "in-flight first-use updates survive");
  auto pipeline = std::make_shared<int>(42);
  callbacks[0](pipeline, {});
  require(queue.pending() == 0, "callback progresses without another lookup");
  auto completed = queue.take_completed();
  require(completed.size() == 1 && completed[0]->status == Status::Ready, "one ready result");
  std::unordered_map<unsigned, Pipeline> cache;
  cache.emplace(completed[0]->key, std::move(completed[0]->pipeline));
  require(cache.at(17) == pipeline && *cache.at(17) == 42, "original stable ID binds proper pipeline");
  callbacks[0](std::make_shared<int>(99), {});
  require(queue.take_completed().empty() && *cache.at(17) == 42, "duplicate callback cannot replace result");
}

static void budgets_and_fairness() {
  Queue queue(2);
  std::vector<Queue::Completion> callbacks;
  for (unsigned i = 0; i < 20; ++i)
    queue.request(i, 0, true, [&](auto done) { callbacks.push_back(std::move(done)); });
  require(queue.service(1) == 1, "submission budget enforced");
  require(queue.service(20) == 1 && queue.in_flight() == 2, "in-flight limit enforced");
  require(queue.service(20) == 0, "no overload while driver is busy");
  callbacks[0](std::make_shared<int>(1), {});
  queue.take_completed();
  require(queue.service(20) == 1 && queue.in_flight() == 2, "completion releases one slot");

  Queue fair;
  unsigned backgroundAt = 0, dispatched = 0;
  fair.request(999, 0, false, [&](auto done) {
    backgroundAt = ++dispatched;
    done(std::make_shared<int>(1), {});
  });
  for (unsigned i = 0; i < 30; ++i) {
    fair.request(i, i, true, [&](auto done) { ++dispatched; done(std::make_shared<int>(2), {}); });
    fair.service(1);
    fair.take_completed();
  }
  require(backgroundAt && backgroundAt <= 9, "older background job cannot starve");
}

static void failures_are_terminal() {
  Queue queue;
  unsigned attempts = 0;
  auto empty = [&](auto done) { ++attempts; done({}, {}); };
  auto bad = queue.request(1, 0, true, empty).job;
  queue.service();
  auto completed = queue.take_completed();
  require(bad->status == Status::Failed && !bad->error.empty() && !bad->pipeline,
          "empty pipeline is a diagnostic failure");
  require(queue.pending() == 0 && completed.size() == 1, "failure does not remain pending");
  for (unsigned frame = 0; frame < 100; ++frame) {
    require(!queue.request(1, frame, true, empty).inserted, "failure deduplicates without a retry storm");
    queue.service();
  }
  require(attempts == 1, "failed shader is not recompiled every frame");
  auto thrown = queue.request(2, 0, true, [](auto) { throw std::runtime_error("test compiler error"); }).job;
  queue.service();
  require(thrown->status == Status::Failed && thrown->error == "test compiler error", "factory exception terminates job");
  queue.take_completed();
  auto error = queue.request(3, 0, true, [](auto done) { done(std::make_shared<int>(7), "validation failed"); }).job;
  queue.service();
  require(error->status == Status::Failed && !error->pipeline, "error never publishes a non-null invalid result");
}

static void epochs_and_owned_lifetimes() {
  Queue queue;
  Queue::Completion oldCallback, newCallback;
  auto config = std::make_shared<int>(5);
  std::weak_ptr<int> configLifetime = config;
  auto cancelled = queue.request(8, 0, true, [config](auto) {}).job;
  config.reset();
  require(!configLifetime.expired(), "queued job owns its immutable input");
  queue.cancel();
  require(configLifetime.expired() && cancelled->status == Status::Cancelled, "cancel releases queued inputs");
  queue.reset();
  auto old = queue.request(8, 0, true, [&](auto done) { oldCallback = std::move(done); }).job;
  queue.service();
  const auto epoch = queue.epoch();
  queue.reset();
  require(queue.epoch() != epoch && old->status == Status::Cancelled, "reset retires prior renderer epoch");
  auto fresh = queue.request(8, 10, true, [&](auto done) { newCallback = std::move(done); }).job;
  queue.service();
  auto stale = std::make_shared<int>(1);
  std::weak_ptr<int> staleLifetime = stale;
  oldCallback(std::move(stale), {});
  require(staleLifetime.expired() && fresh->status == Status::Compiling && queue.take_completed().empty(),
          "late success releases handle without poisoning replacement cache");
  oldCallback({}, "late failure");
  require(fresh->status == Status::Compiling, "late failure cannot fail a replacement job");
  newCallback(std::make_shared<int>(2), {});
  auto ready = queue.take_completed();
  require(ready.size() == 1 && *ready[0]->pipeline == 2, "replacement epoch publishes its own result");
  queue.request(9, 0, true, [&](auto done) { queue.reset(); done(std::make_shared<int>(3), {}); });
  queue.service();
  require(queue.pending() == 0 && queue.take_completed().empty(), "inline reset does not invalidate service stack");

  Queue::Completion afterDestruction;
  { Queue shortLived; shortLived.request(1, 0, true, [&](auto done) { afterDestruction = std::move(done); });
    shortLived.service(); }
  afterDestruction(std::make_shared<int>(4), {}); // ASan checks callback-owned lifetime.
}

int main() {
  single_request_and_duplicates();
  budgets_and_fairness();
  failures_are_terminal();
  epochs_and_owned_lifetimes();
  std::puts("PASS: async pipeline queue completion, deduplication, budgets, failures and epochs");
}

#include "../lib/gfx/pipeline_dependencies.hpp"
#include "../lib/gfx/async_pipeline_queue.hpp"

#include <cstdio>
#include <cstdlib>
#include <memory>

using Dependencies = aurora::gfx::PipelineDependencies<unsigned>;
using Pass = Dependencies::Pass;

static void require(bool condition, const char* message) {
  if (!condition) { std::fprintf(stderr, "FAIL: %s\n", message); std::exit(1); }
}

static Pass presentation(unsigned shader, bool clearColor = true, bool clearDepth = true) {
  return {.color = 1, .depth = 2, .clearColor = clearColor, .clearDepth = clearDepth,
          .presentationOnly = true, .draws = {{shader}}};
}

static void persistent_and_transient_outputs() {
  auto capture = presentation(10);
  capture.persistentCopy = true;
  auto display = presentation(20, false, false);
  display.draws.push_back({30, true}); // Partial clear must never disappear.
  display.draws.push_back({10}); // A shader shared with the producer is required.
  const auto plan = Dependencies::analyze({capture, display});
  require(plan.protectedPasses[0] && !plan.protectedPasses[1], "capture complete, final display eligible");
  require(plan.required.contains(10) && plan.required.contains(30), "producer and clear required");
  require(plan.eligible.size() == 1 && plan.eligible.contains(20), "shared key cannot remain an eligible miss");
  require(plan.protectedDraws == 2 && plan.eligibleDraws == 2, "count draw categories separately from unique keys");

  auto offscreen = presentation(40);
  offscreen.color = 3;
  offscreen.depth = 4;
  offscreen.offscreen = true;
  auto unknown = presentation(50);
  unknown.presentationOnly = false;
  const auto other = Dependencies::analyze({offscreen, unknown});
  require(other.required.size() == 2 && other.eligible.empty(), "offscreen and unclassified outputs are protected");
}

static void transitive_attachment_loads() {
  auto first = presentation(1);
  auto second = presentation(2, false, true);
  auto third = presentation(3, false, false);
  third.persistentCopy = true; // Consumer discovered after both earlier producers.
  auto plan = Dependencies::analyze({first, second, third});
  require(plan.required.size() == 3, "color load ancestry is protected transitively");
  second.clearColor = true;
  plan = Dependencies::analyze({first, second, third});
  require(plan.eligible.contains(1) && plan.required.size() == 2, "full attachment clear breaks old dependency");

  second.clearDepth = false;
  plan = Dependencies::analyze({first, second, third});
  require(plan.required.size() == 3, "depth load preserves dependency even if color clears");
  third.persistentCopy = false;
  third.readback = true;
  plan = Dependencies::analyze({first, second, third});
  require(plan.required.size() == 3, "depth snapshot protects the complete producing chain");
}

static void unknown_inputs_fail_closed() {
  auto first = presentation(1);
  auto missing = presentation(2, false, false);
  missing.color = 99; // No writer this frame; cross-frame completeness unproven.
  auto plan = Dependencies::analyze({first, missing});
  require(plan.forceCompleteFrame && plan.required.size() == 2, "unproven loaded input forces complete frame");
  first.color = 0;
  plan = Dependencies::analyze({first});
  require(plan.forceCompleteFrame && plan.required.contains(1), "unknown attachment identity fails closed");
  first = presentation(1);
  first.unknown = true;
  plan = Dependencies::analyze({first, presentation(2)});
  require(plan.forceCompleteFrame && plan.required.size() == 2, "unknown command forces complete frame");
  plan = Dependencies::analyze({presentation(1)});
  require(!plan.forceCompleteFrame && plan.required.empty() && plan.eligible.contains(1),
          "new frame cannot inherit stale protection metadata");
  require(Dependencies::analyze({}).required.empty(), "empty frame is safe");
}

static void required_jobs_promote_without_recompiling() {
  using Queue = aurora::gfx::AsyncPipelineQueue<unsigned, std::shared_ptr<int>>;
  Queue queue(2);
  std::vector<unsigned> order;
  std::vector<Queue::Completion> callbacks;
  auto enqueue = [&](unsigned key, bool priority) {
    return queue.request(key, 0, priority, [&, key](auto done) {
      order.push_back(key);
      callbacks.push_back(std::move(done));
    }).job;
  };
  enqueue(100, true);
  auto once = enqueue(7, false);
  enqueue(8, true);
  auto capture = presentation(7);
  capture.persistentCopy = true;
  const auto plan = Dependencies::analyze({capture, presentation(8, false, false)});
  for (auto key : plan.required) require(queue.require(key), "promote existing producer job");
  require(queue.require(7), "repeated promotion does not duplicate the job");
  require(!queue.require(999), "unknown required shader is detectable, not silently requeued");
  queue.service(1);
  require(order == std::vector<unsigned>{7}, "protected producer runs ahead of earlier display work");
  queue.service(20);
  require(queue.in_flight() == 2 && order.size() == 2, "promotion respects in-flight limit");
  for (int i = 0; i < 200; ++i) {
    queue.service();
    require(once->status == Queue::Status::Compiling, "one-time capture remains pending, never falsely ready");
  }
  callbacks[0](std::make_shared<int>(77), {});
  auto results = queue.take_completed();
  require(results.size() == 1 && results[0]->key == 7 && *results[0]->pipeline == 77,
          "producer completes under original key without another capture request");
  queue.service(20);
  require(order == std::vector<unsigned>({7, 100, 8}), "stale promoted queue entry does not compile twice");
  queue.reset();
  require(!queue.require(7), "renderer reset clears protected priority state");
}

int main() {
  persistent_and_transient_outputs();
  transitive_attachment_loads();
  unknown_inputs_fail_closed();
  required_jobs_promote_without_recompiling();
  std::puts("PASS: persistent producers, attachment ancestry, late priority and conservative fallback");
}

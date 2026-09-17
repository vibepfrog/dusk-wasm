#pragma once

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <deque>
#include <exception>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace aurora::gfx {

// Single-owner queue: requests, service and completion callbacks run on the
// renderer thread. The GPU API may finish independently, but its callbacks
// must be delivered there (WebGPU AllowProcessEvents). No GPU work is done by
// request(), and no cache lookup is needed to finish a submitted job.
template <class Key, class Pipeline>
class AsyncPipelineQueue {
public:
  enum class Status { Queued, Compiling, Ready, Failed, Cancelled };
  using Completion = std::function<void(Pipeline, std::string)>;
  using Factory = std::function<void(Completion)>;

  struct Job {
    Key key;
    uint32_t firstFrameUsed;
    uint64_t epoch;
    Status status = Status::Queued;
    bool priority;
    Factory create;
    Pipeline pipeline{};
    std::string error;
    bool required = false;
  };
  using JobPtr = std::shared_ptr<Job>;
  struct Request {
    JobPtr job;
    bool inserted;
    bool earlierUse;
  };

private:
  struct State {
    bool active = true;
    uint64_t epoch;
    size_t queued = 0;
    size_t compiling = 0;
    unsigned priorityStreak = 0;
    std::unordered_map<Key, JobPtr> jobs;
    std::deque<JobPtr> required, priority, background, completed;
    explicit State(uint64_t value) : epoch(value) {}
  };
  std::shared_ptr<State> m_state = std::make_shared<State>(1);
  size_t m_maxInFlight;

  static void discard_stale(std::deque<JobPtr>& queue, bool priority, bool required = false) {
    while (!queue.empty() &&
           (queue.front()->status != Status::Queued || queue.front()->required != required ||
            (!required && queue.front()->priority != priority))) {
      queue.pop_front();
    }
  }

public:
  // Preflight may discover a persistent consumer after its producer was queued.
  // Promote the existing job; never create a second compilation for its key.
  bool require(const Key& key) {
    auto& state = *m_state;
    const auto it = state.jobs.find(key);
    if (it == state.jobs.end()) return false;
    auto& job = it->second;
    if (!job->required && job->status == Status::Queued) {
      job->required = true;
      state.required.push_back(job);
    }
    return true;
  }

  explicit AsyncPipelineQueue(size_t maxInFlight = 2) : m_maxInFlight(maxInFlight) {
    assert(maxInFlight > 0);
  }
  ~AsyncPipelineQueue() { cancel(); }
  AsyncPipelineQueue(const AsyncPipelineQueue&) = delete;
  AsyncPipelineQueue& operator=(const AsyncPipelineQueue&) = delete;

  Request request(Key key, uint32_t firstFrameUsed, bool priority, Factory create) {
    auto& state = *m_state;
    assert(state.active);
    if (const auto it = state.jobs.find(key); it != state.jobs.end()) {
      auto job = it->second;
      const bool earlier = firstFrameUsed < job->firstFrameUsed;
      job->firstFrameUsed = std::min(firstFrameUsed, job->firstFrameUsed);
      if (priority && !job->priority && job->status == Status::Queued) {
        job->priority = true;
        state.priority.push_back(job);
        // The original background entry is discarded when encountered.
      }
      return {std::move(job), false, earlier};
    }
    auto job = std::make_shared<Job>(Job{key, firstFrameUsed, state.epoch, Status::Queued,
                                        priority, std::move(create)});
    state.jobs.emplace(key, job);
    (priority ? state.priority : state.background).push_back(job);
    ++state.queued;
    return {std::move(job), true, false};
  }

  // A bounded number of submissions, never a wait. Factories and callbacks
  // may complete inline or cancel the queue without invalidating this stack.
  size_t service(size_t maxSubmissions = 1) {
    const auto state = m_state;
    size_t submitted = 0;
    while (state->active && state->compiling < m_maxInFlight && submitted < maxSubmissions) {
      discard_stale(state->required, false, true);
      discard_stale(state->priority, true);
      discard_stale(state->background, false);
      if (state->required.empty() && state->priority.empty() && state->background.empty()) break;
      // Bounded priority preference prevents a continuous stream of visible
      // misses from starving an older background request.
      const bool priority = !state->priority.empty() &&
                            (state->background.empty() || state->priorityStreak < 8);
      const bool required = !state->required.empty();
      auto& queue = required ? state->required : priority ? state->priority : state->background;
      auto job = std::move(queue.front());
      queue.pop_front();
      if (!required) state->priorityStreak = priority ? state->priorityStreak + 1 : 0;
      job->status = Status::Compiling;
      --state->queued;
      ++state->compiling;
      ++submitted;

      Completion complete = [weak = std::weak_ptr<State>(state), job](Pipeline pipeline, std::string error) {
        auto owner = weak.lock();
        if (!owner || !owner->active || owner->epoch != job->epoch || job->status != Status::Compiling) {
          return; // Late/duplicate result is released; never populates a new cache.
        }
        --owner->compiling;
        if (pipeline && error.empty()) {
          job->pipeline = std::move(pipeline);
          job->status = Status::Ready;
        } else {
          job->error = error.empty() ? "Pipeline creation returned an empty result" : std::move(error);
          job->status = Status::Failed;
        }
        owner->completed.push_back(job);
      };
      // Move the callable out before invoking: an inline callback can cancel
      // or reset the queue, destroying its stored factories.
      auto create = std::move(job->create);
      try {
        create(complete);
      } catch (const std::exception& error) {
        complete({}, error.what());
      } catch (...) {
        complete({}, "Pipeline factory threw an unknown exception");
      }
    }
    return submitted;
  }

  // The owner installs successful results under their original stable key.
  // Failed entries remain deduplicated, preventing a retry on every draw.
  std::vector<JobPtr> take_completed() {
    std::vector<JobPtr> result;
    auto& state = *m_state;
    while (!state.completed.empty()) {
      auto job = std::move(state.completed.front());
      state.completed.pop_front();
      if (job->status == Status::Ready) state.jobs.erase(job->key);
      result.push_back(std::move(job));
    }
    return result;
  }

  void cancel() {
    auto& state = *m_state;
    state.active = false;
    for (auto& [key, job] : state.jobs) {
      job->status = Status::Cancelled;
      job->create = {};
      job->pipeline = {};
    }
    state.jobs.clear();
    state.required.clear();
    state.priority.clear();
    state.background.clear();
    state.completed.clear();
    state.queued = state.compiling = 0;
  }

  void reset() {
    const uint64_t next = m_state->epoch + 1;
    cancel();
    m_state = std::make_shared<State>(next);
  }
  bool active() const { return m_state->active; }
  uint64_t epoch() const { return m_state->epoch; }
  size_t pending() const { return m_state->queued + m_state->compiling; }
  size_t in_flight() const { return m_state->compiling; }
};

} // namespace aurora::gfx

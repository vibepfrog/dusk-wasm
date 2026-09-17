#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace aurora::gfx {

// Analyze the actual replay order after command recording. Attachment identities
// are retained by the frame; a loaded attachment depends on its previous writer.
// Only explicitly identified presentation work can be disposable. Copies and
// unknown/offscreen outputs are complete before they can enter persistent caches.
template <class Key>
struct PipelineDependencies {
  struct Draw { Key pipeline; bool alwaysRequired = false; };
  struct Pass {
    uintptr_t color = 0, depth = 0;
    bool clearColor = true, clearDepth = true;
    bool presentationOnly = false;
    bool persistentCopy = false, offscreen = false, readback = false;
    bool unknown = false;
    std::vector<Draw> draws;
  };
  struct Plan {
    std::vector<bool> protectedPasses;
    std::unordered_set<Key> required, eligible;
    size_t protectedDraws = 0, eligibleDraws = 0;
    bool forceCompleteFrame = false;
  };

  static Plan analyze(const std::vector<Pass>& passes) {
    constexpr size_t none = std::numeric_limits<size_t>::max();
    struct Parents { size_t color = none, depth = none; };
    Plan plan;
    plan.protectedPasses.resize(passes.size());
    std::vector<Parents> parents(passes.size());
    std::unordered_map<uintptr_t, size_t> colors, depths;
    for (size_t i = 0; i < passes.size(); ++i) {
      const auto& pass = passes[i];
      auto prior = [&](auto& writers, uintptr_t target, bool clear) {
        size_t parent = none;
        if (!target) plan.forceCompleteFrame = true;
        if (!clear) {
          if (const auto it = writers.find(target); it != writers.end()) parent = it->second;
          else plan.forceCompleteFrame = true; // Unproven cross-frame input.
        }
        writers[target] = i;
        return parent;
      };
      parents[i] = {prior(colors, pass.color, pass.clearColor), prior(depths, pass.depth, pass.clearDepth)};
      plan.forceCompleteFrame |= pass.unknown;
      plan.protectedPasses[i] = !pass.presentationOnly || pass.persistentCopy || pass.offscreen || pass.readback;
    }
    // Reverse replay order computes the transitive closure without recursion.
    for (size_t i = passes.size(); i-- > 0;) {
      if (plan.forceCompleteFrame) plan.protectedPasses[i] = true;
      if (!plan.protectedPasses[i]) continue;
      if (parents[i].color != none) plan.protectedPasses[parents[i].color] = true;
      if (parents[i].depth != none) plan.protectedPasses[parents[i].depth] = true;
    }
    for (size_t i = 0; i < passes.size(); ++i) {
      for (const auto& draw : passes[i].draws) {
        if (plan.protectedPasses[i] || draw.alwaysRequired) {
          plan.required.insert(draw.pipeline);
          ++plan.protectedDraws;
        } else {
          plan.eligible.insert(draw.pipeline);
          ++plan.eligibleDraws;
        }
      }
    }
    // A shared shader required anywhere is never an eligible miss elsewhere.
    for (const auto& key : plan.required) plan.eligible.erase(key);
    return plan;
  }
};

} // namespace aurora::gfx

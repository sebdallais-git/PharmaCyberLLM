import { describe, expect, it } from "@jest/globals";
import { applyGapVerdict } from "../src/services/gap-outcome.js";
import type { GapOutcomeDeps } from "../src/services/gap-outcome.js";

function spyDeps(): GapOutcomeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveGap: (id, response) => calls.push(`resolve:${id}:${response}`),
    markUnresolved: (id) => calls.push(`unresolved:${id}`),
    markForReview: (id) => calls.push(`review:${id}`),
  };
}

describe("applyGapVerdict", () => {
  it("resolves the gap and stores the new answer", () => {
    const deps = spyDeps();

    applyGapVerdict("resolved", 7, "the answer", deps);

    expect(deps.calls).toEqual(["resolve:7:the answer"]);
  });

  it("marks the gap unresolved so the loop spends a retry", () => {
    const deps = spyDeps();

    applyGapVerdict("unresolved", 7, "the answer", deps);

    expect(deps.calls).toEqual(["unresolved:7"]);
  });

  // The whole reason the review band exists: a gap nobody is confident about
  // should wait for a human, not consume a retry and re-run the ingest.
  it("parks a review gap without spending a retry", () => {
    const deps = spyDeps();

    applyGapVerdict("review", 7, "the answer", deps);

    expect(deps.calls).toEqual(["review:7"]);
  });
});

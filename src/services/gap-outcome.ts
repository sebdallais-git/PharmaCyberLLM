// What a verdict does to a gap row.
//
// Extracted from the route handler so the branch logic is testable without an
// HTTP server or a database: the three store functions arrive as dependencies.

import type { Verdict } from "./decide-config.js";

export interface GapOutcomeDeps {
  resolveGap(id: number, response: string): void;
  markUnresolved(id: number): void;
  markForReview(id: number): void;
}

export function applyGapVerdict(
  verdict: Verdict,
  gapId: number,
  newResponse: string,
  deps: GapOutcomeDeps,
): void {
  switch (verdict) {
    case "resolved":
      deps.resolveGap(gapId, newResponse);
      return;
    case "unresolved":
      // markUnresolved increments retry_count; the loop tries again.
      deps.markUnresolved(gapId);
      return;
    case "review":
      // Deliberately no retry: the middle of the scorer's distribution is the
      // part least worth acting on, so the gap waits for a human instead of
      // burning an ingest cycle.
      deps.markForReview(gapId);
      return;
    default: {
      const never: never = verdict;
      throw new Error(`unknown verdict ${String(never)}`);
    }
  }
}

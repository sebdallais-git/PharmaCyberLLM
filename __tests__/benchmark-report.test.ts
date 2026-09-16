import { describe, expect, it } from "@jest/globals";
import type { ChatTimings } from "../src/services/bench-mode.js";
import type { BenchmarkFile, RunResult } from "../scripts/lib/benchmark-types.js";
import {
  buildMarkdownReport,
  buildReview,
  buildReviewHtml,
  errorCount,
  meanRetrievalOverlap,
  metricValues,
  orderByStack,
  summarizeMetrics,
} from "../scripts/lib/benchmark-report.js";

function timings(ttftMs: number, decodeTokPerSec: number): ChatTimings {
  return { embedMs: 10, retrievalMs: 20, ttftMs, decodeTokPerSec, promptTokens: 2000, completionTokens: 200, totalMs: ttftMs + 5000 };
}

function run(n: number, t: ChatTimings | null, chunkIds: string[], answer: string, error?: string): RunResult {
  return { run: n, answer, timings: t, chunkIds, ...(error ? { error } : {}) };
}

function file(stack: string, runs: RunResult[][]): BenchmarkFile {
  return {
    stack,
    startedAt: "2026-09-16T10:00:00.000Z",
    finishedAt: "2026-09-16T11:00:00.000Z",
    runsPerQuestion: 3,
    environment: { macos: "26.4", chip: "Apple M4 Pro", thermal: "No thermal warning level has been recorded", stackVersion: "x", chatModel: "chat", embeddingModel: "embed" },
    memoryPeak: { processMb: 18000, systemUsedMb: 30000 },
    questions: runs.map((r, i) => ({ id: `q${i}`, category: "vendor", question: `Question ${i}?`, runs: r })),
  };
}

const ollama = file("ollama", [
  [run(1, timings(4000, 16), ["a", "b"], "Ollama answer 0"), run(2, timings(6000, 18), ["a", "b"], "x")],
  [run(1, timings(5000, 17), ["c"], "Ollama answer 1"), run(2, null, [], "", "HTTP 500")],
]);
const mlx = file("mlx", [
  [run(1, timings(2000, 20), ["a", "c"], "MLX answer 0"), run(2, timings(3000, 22), ["a", "c"], "y")],
  [run(1, timings(2500, 21), ["c"], "MLX answer 1")],
]);

describe("metrics", () => {
  it("ignores failed runs", () => {
    expect(metricValues(ollama, "ttftMs")).toEqual([4000, 6000, 5000]);
    expect(errorCount(ollama)).toBe(1);
    expect(errorCount(mlx)).toBe(0);
  });

  it("summarizes medians, p90 and the change from A to B", () => {
    const ttft = summarizeMetrics(ollama, mlx).find((m) => m.key === "ttftMs");
    expect(ttft).toMatchObject({ medianA: 5000, p90A: 6000, medianB: 2500, p90B: 3000, changePct: -50 });
  });

  it("averages retrieval overlap of each question's first run", () => {
    // q0: {a,b} vs {a,c} = 1/3; q1: {c} vs {c} = 1
    expect(meanRetrievalOverlap(ollama, mlx)).toBeCloseTo((1 / 3 + 1) / 2);
  });
});

describe("orderByStack", () => {
  it("puts ollama first so changes read as MLX relative to Ollama", () => {
    expect(orderByStack(mlx, ollama).map((f) => f.stack)).toEqual(["ollama", "mlx"]);
  });
});

describe("buildMarkdownReport", () => {
  it("includes the performance table, memory, errors and overlap", () => {
    const report = buildMarkdownReport(ollama, mlx);
    expect(report).toContain("| TTFT (ms) | 5000 | 6000 | 2500 | 3000 | -50.0% |");
    expect(report).toContain("Peak stack process memory");
    expect(report).toContain("Failed runs: ollama 1, mlx 0");
    expect(report).toContain("Retrieval overlap");
  });
});

describe("buildReview", () => {
  it("randomizes answer order per question and records the key", () => {
    const flips = [0.9, 0.1]; // first question keeps order, second swaps
    const { items, key } = buildReview(ollama, mlx, () => flips.shift() ?? 0);
    expect(items[0].answers).toEqual(["Ollama answer 0", "MLX answer 0"]);
    expect(key[0]).toEqual({ id: "q0", first: "ollama", second: "mlx" });
    expect(items[1].answers).toEqual(["MLX answer 1", "Ollama answer 1"]);
    expect(key[1]).toEqual({ id: "q1", first: "mlx", second: "ollama" });
  });

  it("hides stack names from the page until reveal", () => {
    const { items, key } = buildReview(ollama, mlx, () => 0.9);
    const html = buildReviewHtml(items, key, "review-test");
    expect(html).not.toContain("ollama");
    expect(html).not.toContain("mlx");
    expect(html).toContain("Question 0?");
  });
});

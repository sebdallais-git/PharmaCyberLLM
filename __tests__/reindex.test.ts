import { describe, expect, it } from "@jest/globals";
import { batchRangeLabel, indexesReady } from "../src/services/reindex.js";
import type { IndexState } from "../src/services/reindex.js";

const ok = { ok: true, reason: "" };

function state(overrides: Partial<{ memoryOk: boolean; memoryCount: number; chromaOk: boolean; chromaCount: number }>): IndexState {
  const s = { memoryOk: true, memoryCount: 10, chromaOk: true, chromaCount: 10, ...overrides };
  return {
    memory: { check: s.memoryOk ? ok : { ok: false, reason: "memory" }, chunkCount: s.memoryCount },
    chroma: { check: s.chromaOk ? ok : { ok: false, reason: "chroma" }, count: s.chromaCount },
  };
}

describe("indexesReady", () => {
  it("is ready when both indexes match the stack and have content", () => {
    expect(indexesReady(state({}))).toBe(true);
  });

  it("needs a rebuild when either index is incompatible", () => {
    expect(indexesReady(state({ memoryOk: false }))).toBe(false);
    expect(indexesReady(state({ chromaOk: false }))).toBe(false);
  });

  it("needs a rebuild when either index is empty", () => {
    expect(indexesReady(state({ memoryCount: 0 }))).toBe(false);
    expect(indexesReady(state({ chromaCount: 0 }))).toBe(false);
  });
});

describe("batchRangeLabel", () => {
  it("labels a middle batch with its 1-based inclusive range", () => {
    expect(batchRangeLabel(1, 64, 200)).toBe("65-128");
  });

  it("labels the last batch, clamped to the total", () => {
    expect(batchRangeLabel(3, 64, 200)).toBe("193-200");
  });

  it("labels the first batch starting at 1", () => {
    expect(batchRangeLabel(0, 64, 200)).toBe("1-64");
  });
});

import { describe, expect, it } from "@jest/globals";
import { compactGap, compactSearchResults, sampleList, truncate } from "../src/tools/compact.js";

describe("compactSearchResults", () => {
  it("keeps the text and drops the embedding vector", () => {
    const payload = {
      results: [
        { id: "doc-1", source: "news-2026", content: "Dell PowerProtect vaults backups.", embedding: { 0: 0.1, 1: 0.2 } },
        { id: "doc-2", source: "vendor-notes", content: "CyberSense scans for corruption.", embedding: [0.3, 0.4] },
      ],
    };

    const compact = compactSearchResults(payload);

    expect(compact).toEqual({
      results: [
        { id: "doc-1", source: "news-2026", content: "Dell PowerProtect vaults backups." },
        { id: "doc-2", source: "vendor-notes", content: "CyberSense scans for corruption." },
      ],
    });
    expect(JSON.stringify(compact)).not.toContain("embedding");
  });

  it("passes through a payload without results untouched", () => {
    expect(compactSearchResults({ error: "no index" })).toEqual({ error: "no index" });
  });
});

describe("sampleList", () => {
  it("replaces a long list with its count and the first entries", () => {
    const names = Array.from({ length: 1080 }, (_, index) => `source-${index}`);

    expect(sampleList(names, 3)).toEqual({ count: 1080, sample: ["source-0", "source-1", "source-2"], truncated: true });
  });

  it("keeps a short list whole", () => {
    expect(sampleList(["a", "b"], 3)).toEqual({ count: 2, sample: ["a", "b"], truncated: false });
  });
});

describe("truncate", () => {
  it("cuts long text and marks it", () => {
    expect(truncate("x".repeat(20), 8)).toBe(`${"x".repeat(8)}… (20 chars)`);
  });

  it("leaves short text alone", () => {
    expect(truncate("short", 8)).toBe("short");
  });

  it("returns undefined for a missing value", () => {
    expect(truncate(undefined, 8)).toBeUndefined();
  });
});

describe("compactGap", () => {
  it("keeps the fields an agent acts on and shortens stored answers", () => {
    const gap = {
      id: 7,
      timestamp: "2026-09-17T10:00:00.000Z",
      original_query: "Novartis cyber attack cost 2022",
      search_topic: "Novartis breach cost",
      reason: "low confidence",
      status: "triggered",
      retry_count: 1,
      was_triggered: 1,
      gemma_response: "y".repeat(5000),
      resolved_response: "z".repeat(5000),
      resolved_at: null,
    };

    const compact = compactGap(gap);

    expect(compact).toEqual({
      id: 7,
      timestamp: "2026-09-17T10:00:00.000Z",
      original_query: "Novartis cyber attack cost 2022",
      search_topic: "Novartis breach cost",
      reason: "low confidence",
      status: "triggered",
      retry_count: 1,
      resolved_at: null,
      resolved_response: `${"z".repeat(300)}… (5000 chars)`,
    });
    expect(JSON.stringify(compact)).not.toContain("gemma_response");
  });
});

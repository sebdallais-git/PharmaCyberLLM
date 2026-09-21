import { describe, expect, it } from "@jest/globals";
import { batchRangeLabel, indexesReady, reindexActiveStack } from "../src/services/reindex.js";
import type { IndexState, ReindexDeps, ReindexProgress } from "../src/services/reindex.js";
import { StackUnavailableError } from "../src/services/llm-client.js";
import { getIndexStatus, setIndexStatus } from "../src/services/index-guard.js";
import { getActiveStack } from "../src/config/llm-stacks.js";
import type { RawDocument } from "../src/services/raw-documents.js";

const ok = { ok: true, reason: "" };

interface StateOverrides {
  memoryOk: boolean;
  memoryCount: number;
  memoryComplete: boolean;
  chromaOk: boolean;
  chromaCount: number;
  chromaComplete: boolean;
}

function state(overrides: Partial<StateOverrides>): IndexState {
  const s: StateOverrides = {
    memoryOk: true,
    memoryCount: 10,
    memoryComplete: true,
    chromaOk: true,
    chromaCount: 10,
    chromaComplete: true,
    ...overrides,
  };
  return {
    memory: { check: s.memoryOk ? ok : { ok: false, reason: "memory" }, chunkCount: s.memoryCount, complete: s.memoryComplete },
    chroma: { check: s.chromaOk ? ok : { ok: false, reason: "chroma" }, count: s.chromaCount, complete: s.chromaComplete },
  };
}

describe("indexesReady", () => {
  it("is ready when both indexes match the stack, have content and finished building", () => {
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

  it("needs a rebuild when either index lacks the completeness marker", () => {
    expect(indexesReady(state({ memoryComplete: false }))).toBe(false);
    expect(indexesReady(state({ chromaComplete: false }))).toBe(false);
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

function rawDocs(count: number): RawDocument[] {
  return Array.from({ length: count }, (_, i) => ({
    source: `doc-${i}`,
    content: `content ${i}`,
    metadata: {},
    saved_at: "2026-09-16T00:00:00.000Z",
  }));
}

// In-memory fakes for everything reindexActiveStack touches, recording what was called
function fakeDeps(overrides: Partial<ReindexDeps> = {}): { deps: ReindexDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ReindexDeps = {
    isChromaDBAvailable: async () => true,
    resetIndex: () => {
      calls.push("resetIndex");
    },
    recreateChromaCollection: async () => {
      calls.push("recreateChromaCollection");
    },
    listKnowledgeFiles: async () => [
      { name: "a.md", path: "/k/a.md" },
      { name: "b.md", path: "/k/b.md" },
    ],
    parseFile: async (path) => `text of ${path}`,
    ingestTexts: async (items) => items.length,
    addToChromaDB: async (texts) => texts.length,
    listRawDocuments: async () => rawDocs(130),
    listWatchlistItems: async () => [],
    markIndexComplete: () => {
      calls.push("markIndexComplete");
    },
    saveIndex: async () => {
      calls.push("saveIndex");
    },
    markChromaCollectionComplete: async () => {
      calls.push("markChromaCollectionComplete");
    },
    ...overrides,
  };
  return { deps, calls };
}

const quiet = (): void => {};

describe("reindexActiveStack", () => {
  it("skips an isolated failing batch or file and counts only what was ingested", async () => {
    const { deps, calls } = fakeDeps({
      parseFile: async (path) => {
        if (path.endsWith("b.md")) throw new Error("unreadable");
        return "text";
      },
      // The second batch of 64 (documents 65-128) fails
      ingestTexts: async (items) => {
        if (items.some((item) => item.source === "doc-70")) throw new Error("embedding rejected the batch");
        return items.length;
      },
    });

    const result = await reindexActiveStack(quiet, deps);

    expect(result.knowledgeFiles).toBe(1);
    expect(result.rawDocuments).toBe(66);
    expect(result.skippedRawDocuments).toBe(64);
    expect(result.memoryChunks).toBe(67);
    expect(result.chromaChunks).toBe(67);
    expect(calls).toEqual([
      "resetIndex",
      "recreateChromaCollection",
      "markIndexComplete",
      "saveIndex",
      "markChromaCollectionComplete",
    ]);
    expect(getIndexStatus()).toEqual({ ok: true, reason: "" });
  });

  it("aborts, rethrows and marks the index unusable when the stack goes down during a batch", async () => {
    setIndexStatus({ ok: true, reason: "" });
    const stackDown = new StackUnavailableError(getActiveStack(), "http://localhost:1/v1/embeddings", new Error("ECONNREFUSED"));
    const { deps, calls } = fakeDeps({
      ingestTexts: async (items) => {
        if (items.some((item) => item.source === "doc-0")) throw stackDown;
        return items.length;
      },
    });

    await expect(reindexActiveStack(quiet, deps)).rejects.toBe(stackDown);

    const status = getIndexStatus();
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("run scripts/reindex-stack.ts");
    expect(calls).not.toContain("saveIndex");
    expect(calls).not.toContain("markChromaCollectionComplete");
  });

  it("aborts when the stack goes down while ingesting a knowledge file", async () => {
    setIndexStatus({ ok: true, reason: "" });
    const stackDown = new StackUnavailableError(getActiveStack(), "http://localhost:1/v1/embeddings", new Error("ECONNREFUSED"));
    const { deps } = fakeDeps({
      addToChromaDB: async () => {
        throw stackDown;
      },
    });

    await expect(reindexActiveStack(quiet, deps)).rejects.toBe(stackDown);
    expect(getIndexStatus().ok).toBe(false);
  });

  it("blocks index use for the duration of the rebuild, then marks it ok again on success", async () => {
    setIndexStatus({ ok: true, reason: "" });
    let statusDuringRebuild: { ok: boolean; reason: string } | null = null;
    const { deps } = fakeDeps({
      listKnowledgeFiles: async () => {
        statusDuringRebuild = getIndexStatus();
        return [];
      },
    });

    await reindexActiveStack(quiet, deps);

    expect(statusDuringRebuild).toEqual({ ok: false, reason: "reindex in progress" });
    expect(getIndexStatus()).toEqual({ ok: true, reason: "" });
  });

  it("reports raw-document progress after each batch", async () => {
    const { deps } = fakeDeps();
    const progress: ReindexProgress[] = [];

    await reindexActiveStack(quiet, deps, (p) => progress.push(p));

    expect(progress).toEqual([
      { rawDocumentsDone: 0, rawDocumentsTotal: 130 },
      { rawDocumentsDone: 64, rawDocumentsTotal: 130 },
      { rawDocumentsDone: 128, rawDocumentsTotal: 130 },
      { rawDocumentsDone: 130, rawDocumentsTotal: 130 },
    ]);
  });

  it("refuses to fall back to live services when deps are omitted in a test run", async () => {
    await expect(reindexActiveStack(quiet)).rejects.toThrow(
      "reindexActiveStack called without injected deps in a test"
    );
  });
});

describe("watchlist items in a rebuild", () => {
  // reindex.ts recreates the collection -- a DELETE -- and used to rebuild it
  // from knowledge/ and raw_documents/ only, so every watchlist chunk was lost
  // and could not be restored without re-fetching feeds that mostly no longer
  // return anything.
  it("re-embeds stored watchlist items so a rebuild does not lose vendor intel", async () => {
    const embedded: Record<string, unknown>[] = [];
    const { deps } = fakeDeps({
      listKnowledgeFiles: async () => [],
      listRawDocuments: async () => [],
      listWatchlistItems: async () => [
        {
          text: "Dell refreshes PowerStore\n\nDell said today...",
          metadata: { source: "https://dell.com/a", entity: "dell", domain: "storage", watchlist_item_id: 7 },
        },
      ],
      addToChromaDB: async (texts, metadatas) => {
        embedded.push(...metadatas);
        return texts.length;
      },
    });

    const result = await reindexActiveStack(quiet, deps);

    expect(result.watchlistItems).toBe(1);
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toMatchObject({ watchlist_item_id: 7, entity: "dell", source_tier: "feed" });
  });

  it("reports zero when there are no stored watchlist items", async () => {
    const { deps } = fakeDeps({
      listKnowledgeFiles: async () => [],
      listRawDocuments: async () => [],
      listWatchlistItems: async () => [],
    });

    expect((await reindexActiveStack(quiet, deps)).watchlistItems).toBe(0);
  });
});

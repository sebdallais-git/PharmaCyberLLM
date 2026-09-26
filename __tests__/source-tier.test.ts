import { describe, expect, it } from "@jest/globals";
import { backfillSourceTier, classifySourceTier, type BackfillDeps } from "../src/services/source-tier.js";

// The index is 88% undifferentiated news, which vendor queries cannot exclude
// because those chunks carry no filterable tag. source_tier is that tag.
describe("classifySourceTier", () => {
  it("tags a watchlist item as feed", () => {
    expect(classifySourceTier({ source: "https://dell.com/a", watchlist_item_id: 42 })).toBe("feed");
  });

  it("tags a news-archive chunk as archive", () => {
    expect(classifySourceTier({ source: "news-2026-06-14", type: "news" })).toBe("archive");
  });

  it("tags a news-dated source as archive even without the type field", () => {
    expect(classifySourceTier({ source: "news-2009-11-02" })).toBe("archive");
  });

  it("tags a vendor brief as curated", () => {
    expect(classifySourceTier({ source: "vendors/dell-storage.md" })).toBe("curated");
  });

  it("tags a legacy knowledge document as reference", () => {
    expect(classifySourceTier({ source: "cyber-pharma-attacks-by-year.md" })).toBe("reference");
  });

  it("prefers feed over archive when a watchlist item came from a news adapter", () => {
    // Both signals present: the watchlist id is the more specific fact, and the
    // item is live vendor intel rather than back-catalogue.
    expect(classifySourceTier({ source: "news-2026-09-20", type: "news", watchlist_item_id: 7 })).toBe("feed");
  });

  it("leaves an already-tagged chunk alone so the backfill is idempotent", () => {
    expect(classifySourceTier({ source: "anything", source_tier: "curated" })).toBe("curated");
  });
});

function fakeDeps(chunks: Array<{ id: string; metadata: Record<string, unknown> }>): BackfillDeps & {
  written: Array<{ ids: string[]; metadatas: Record<string, unknown>[] }>;
} {
  const written: Array<{ ids: string[]; metadatas: Record<string, unknown>[] }> = [];
  return {
    written,
    async listChunks() {
      return chunks;
    },
    async updateMetadata(ids, metadatas) {
      written.push({ ids, metadatas });
      ids.forEach((id, i) => {
        const chunk = chunks.find((c) => c.id === id);
        if (chunk) chunk.metadata = { ...chunk.metadata, ...metadatas[i] };
      });
    },
  };
}

describe("backfillSourceTier", () => {
  it("tags every untagged chunk and reports the counts per tier", async () => {
    const deps = fakeDeps([
      { id: "a", metadata: { source: "news-2026-06-14", type: "news" } },
      { id: "b", metadata: { source: "https://dell.com/x", watchlist_item_id: 1 } },
      { id: "c", metadata: { source: "cyber-pharma-attacks-by-year.md" } },
    ]);

    const result = await backfillSourceTier(deps);

    expect(result.updated).toBe(3);
    expect(result.byTier).toEqual({ archive: 1, feed: 1, reference: 1 });
  });

  it("writes nothing on a second run", async () => {
    const deps = fakeDeps([{ id: "a", metadata: { source: "news-2026-06-14", type: "news" } }]);

    await backfillSourceTier(deps);
    const second = await backfillSourceTier(deps);

    expect(second.updated).toBe(0);
    expect(deps.written).toHaveLength(1);
  });

  it("writes nothing at all when dryRun is set", async () => {
    const deps = fakeDeps([{ id: "a", metadata: { source: "news-2026-06-14", type: "news" } }]);

    const result = await backfillSourceTier(deps, { dryRun: true });

    expect(result.updated).toBe(1);
    expect(deps.written).toHaveLength(0);
  });
});

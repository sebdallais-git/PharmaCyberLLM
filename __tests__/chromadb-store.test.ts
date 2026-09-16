import { describe, expect, it } from "@jest/globals";
import { completeCollectionMetadata, dedupeEntries } from "../src/services/chromadb-store.js";

describe("dedupeEntries", () => {
  it("keeps the first entry for each ID, because Chroma rejects duplicate IDs in one upsert", () => {
    const entries = [
      { id: "a", document: "first", metadata: { source: "news-1" } },
      { id: "b", document: "other", metadata: { source: "news-1" } },
      { id: "a", document: "second", metadata: { source: "news-2" } },
    ];
    expect(dedupeEntries(entries).map((e) => e.document)).toEqual(["first", "other"]);
  });
});

describe("completeCollectionMetadata", () => {
  it("keeps the index metadata, adds the completeness marker and leaves out the immutable hnsw keys", () => {
    const metadata = { "hnsw:space": "cosine", stack: "mlx", embedding_model: "m", dim: 1024 };
    expect(completeCollectionMetadata(metadata)).toEqual({
      stack: "mlx",
      embedding_model: "m",
      dim: 1024,
      index_complete: true,
    });
  });

  it("handles a collection without metadata", () => {
    expect(completeCollectionMetadata(null)).toEqual({ index_complete: true });
  });
});

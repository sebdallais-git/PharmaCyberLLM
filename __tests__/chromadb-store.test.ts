import { describe, expect, it } from "@jest/globals";
import { dedupeEntries } from "../src/services/chromadb-store.js";

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

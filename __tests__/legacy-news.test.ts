import { describe, expect, it } from "@jest/globals";
import { collectLegacyDocuments, extractNewsLink } from "../scripts/lib/legacy-news.js";

const article = (date: string, title: string, url: string): string =>
  `[${date}] ${title}\nSource: Reuters\nURL: ${url}`;

describe("extractNewsLink", () => {
  it("reads the URL line of a news item", () => {
    expect(extractNewsLink(article("2026-03-02", "Pfizer deal", "https://news.example/a"))).toBe("https://news.example/a");
  });

  it("returns null when there is no URL line", () => {
    expect(extractNewsLink("[2026-03-02] Headline only")).toBeNull();
  });
});

describe("collectLegacyDocuments", () => {
  it("keeps one document per article across the index and ChromaDB", () => {
    const a = article("2026-03-02", "Pfizer deal", "https://news.example/a");
    const b = article("2026-03-02", "Roche plant", "https://news.example/b");
    const docs = collectLegacyDocuments(
      [{ source: "news-2026-03-02", content: a }],
      [{ source: "news-2026-03-02", content: a }, { source: "news-2026-03-02", content: b }],
      new Set(),
      new Set()
    );
    expect(docs.map((d) => d.key).sort()).toEqual(["https://news.example/a", "https://news.example/b"]);
    expect(docs[0].metadata).toMatchObject({ type: "news", migrated: true });
  });

  it("rebuilds API-added text from its index chunks, without repeats", () => {
    const docs = collectLegacyDocuments(
      [
        { source: "pfizer-overview", content: "Part one" },
        { source: "pfizer-overview", content: "Part two" },
        { source: "pfizer-overview", content: "Part one" },
      ],
      [],
      new Set(),
      new Set()
    );
    expect(docs).toEqual([
      { key: "pfizer-overview", source: "pfizer-overview", content: "Part one\n\nPart two", metadata: { type: "text", migrated: true } },
    ]);
  });

  it("skips knowledge files and sources that already have a raw document", () => {
    const docs = collectLegacyDocuments(
      [
        { source: "vendor-dell-cyber-recovery.md", content: "file chunk" },
        { source: "glp1-market", content: "already saved" },
      ],
      [],
      new Set(["vendor-dell-cyber-recovery.md"]),
      new Set(["glp1-market"])
    );
    expect(docs).toEqual([]);
  });
});

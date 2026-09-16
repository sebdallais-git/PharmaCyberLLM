import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRawDocuments, rawDocumentFilename, saveRawDocument } from "../src/services/raw-documents.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "raw-docs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("saveRawDocument", () => {
  it("names files after the source when no key is given, matching existing raw documents", async () => {
    await saveRawDocument("glp1-market", "GLP-1 text", { type: "text" }, { dir });
    expect(await readdir(dir)).toEqual([rawDocumentFilename("glp1-market")]);
  });

  it("keeps separate files for news articles that share a source name", async () => {
    await saveRawDocument("news-2026-09-16", "Article A", { type: "news" }, { dir, key: "https://a.example" });
    await saveRawDocument("news-2026-09-16", "Article B", { type: "news" }, { dir, key: "https://b.example" });
    expect((await readdir(dir)).length).toBe(2);
  });

  it("overwrites a document saved again with the same key", async () => {
    await saveRawDocument("news-2026-09-16", "old", {}, { dir, key: "https://a.example" });
    await saveRawDocument("news-2026-09-16", "new", {}, { dir, key: "https://a.example" });
    const docs = await listRawDocuments(dir);
    expect(docs.map((d) => d.content)).toEqual(["new"]);
  });
});

describe("listRawDocuments", () => {
  it("returns saved documents and skips unreadable files", async () => {
    await saveRawDocument("pfizer-overview", "Pfizer text", { type: "text" }, { dir });
    await writeFile(join(dir, "broken.json"), "{not json", "utf-8");
    await writeFile(join(dir, "notes.txt"), "ignored", "utf-8");

    const docs = await listRawDocuments(dir);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: "pfizer-overview", content: "Pfizer text", metadata: { type: "text" } });
    expect(typeof docs[0].saved_at).toBe("string");
  });

  it("returns an empty list when the directory does not exist", async () => {
    await expect(listRawDocuments(join(dir, "missing"))).resolves.toEqual([]);
  });
});

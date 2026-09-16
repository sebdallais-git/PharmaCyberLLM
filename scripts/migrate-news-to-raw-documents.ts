// One-time migration: save legacy news articles and API-added text as raw documents,
// so every stack's index can be rebuilt from disk. Reads legacy data, never changes it.
// Usage: NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/migrate-news-to-raw-documents.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listRawDocuments, saveRawDocument } from "../src/services/raw-documents.js";
import { listKnowledgeFiles } from "../src/services/knowledge-store.js";
import { collectLegacyDocuments } from "./lib/legacy-news.js";
import type { LegacyChunk } from "./lib/legacy-news.js";

const LEGACY_INDEX = join(process.cwd(), "knowledge", ".index.json");
const CHROMADB_URL = process.env.CHROMADB_URL ?? "http://localhost:8100";
const COLLECTIONS_URL = `${CHROMADB_URL}/api/v2/tenants/default_tenant/databases/default_database/collections`;
const LEGACY_COLLECTION = "knowledge_base";

async function readLegacyIndex(): Promise<LegacyChunk[]> {
  try {
    const raw = JSON.parse(await readFile(LEGACY_INDEX, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c): c is LegacyChunk =>
        typeof c === "object" && c !== null
        && typeof (c as LegacyChunk).source === "string"
        && typeof (c as LegacyChunk).content === "string")
      .map((c) => ({ source: c.source, content: c.content }));
  } catch (err) {
    console.warn(`Legacy index not read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function readLegacyChromaNews(): Promise<LegacyChunk[]> {
  try {
    const collections = (await (await fetch(COLLECTIONS_URL)).json()) as Array<{ id: string; name: string }>;
    const legacy = collections.find((c) => c.name === LEGACY_COLLECTION);
    if (!legacy) return [];

    const resp = await fetch(`${COLLECTIONS_URL}/${legacy.id}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include: ["documents", "metadatas"] }),
    });
    const data = (await resp.json()) as { documents: string[]; metadatas: Array<Record<string, unknown> | null> };

    return data.documents
      .map((content, i) => ({ source: String(data.metadatas[i]?.source ?? ""), content }))
      .filter((chunk) => chunk.source.startsWith("news-"));
  } catch (err) {
    console.warn(`Legacy ChromaDB collection not read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function main(): Promise<void> {
  const indexChunks = await readLegacyIndex();
  const chromaNews = await readLegacyChromaNews();
  const fileSources = new Set((await listKnowledgeFiles()).map((f) => f.name));
  const existingBefore = await listRawDocuments();
  const existingSources = new Set(existingBefore.map((d) => d.source));

  console.log(`Legacy index: ${indexChunks.length} chunks; legacy ChromaDB news: ${chromaNews.length} chunks`);

  const docs = collectLegacyDocuments(indexChunks, chromaNews, fileSources, existingSources);
  for (const doc of docs) {
    await saveRawDocument(doc.source, doc.content, doc.metadata, { key: doc.key });
  }

  const news = docs.filter((d) => d.metadata.type === "news").length;
  const after = await listRawDocuments();
  console.log(`Saved ${news} news articles and ${docs.length - news} text documents`);
  console.log(`Raw documents: ${existingBefore.length} before, ${after.length} after`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});

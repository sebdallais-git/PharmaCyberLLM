// One-time script: ingest all knowledge/*.md files into ChromaDB
// Usage: npx tsx scripts/ingest-to-chromadb.ts

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { addToChromaDB, isChromaDBAvailable, getChromaStatus } from "../src/services/chromadb-store.js";

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");

async function main(): Promise<void> {
  const available = await isChromaDBAvailable();
  if (!available) {
    console.error("ChromaDB is not reachable. Start it first.");
    process.exit(1);
  }

  const before = await getChromaStatus();
  console.log(`ChromaDB before: ${before.totalChunks} chunks, ${before.sources.length} sources\n`);

  const files = (await readdir(KNOWLEDGE_DIR))
    .filter((f) => f.endsWith(".md"))
    .sort();

  console.log(`Found ${files.length} markdown files to ingest.\n`);

  let totalChunks = 0;
  for (const file of files) {
    const text = await readFile(join(KNOWLEDGE_DIR, file), "utf-8");
    if (text.length < 100) {
      console.log(`  SKIP ${file} (too short)`);
      continue;
    }

    try {
      const added = await addToChromaDB([text], [{ source: file }]);
      totalChunks += added;
      console.log(`  OK ${file} → ${added} chunks`);
    } catch (err) {
      console.error(`  FAIL ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const after = await getChromaStatus();
  console.log(`\nDone. ChromaDB now: ${after.totalChunks} chunks, ${after.sources.length} sources`);
  console.log(`Added ${totalChunks} chunks from ${files.length} files.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

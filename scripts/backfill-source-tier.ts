// Give every chunk in the live collection a scalar, filterable `source_tier`.
// Metadata-only: embeddings are never recomputed, so this is seconds, not hours.
//
// Usage:
//   npx tsx scripts/backfill-source-tier.ts            dry run, prints the plan
//   npx tsx scripts/backfill-source-tier.ts --apply    writes the tags
// getActiveStack() now resolves the running stack from data/run/active-stack
// and throws rather than guessing, so no stack wiring is needed here.
const { backfillSourceTier } = await import("../src/services/source-tier.js");
const { getCollectionId, CHROMA_BASE, getActiveStackCollectionName } = await import(
  "../src/services/chromadb-store.js"
);
type BackfillDeps = Parameters<typeof backfillSourceTier>[0];

const liveDeps: BackfillDeps = {
  async listChunks() {
    const id = await getCollectionId();
    const resp = await fetch(`${CHROMA_BASE}/${id}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include: ["metadatas"] }),
    });
    if (!resp.ok) throw new Error(`chroma get failed: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as { ids: string[]; metadatas: (Record<string, unknown> | null)[] };
    return data.ids.map((chunkId, i) => ({ id: chunkId, metadata: data.metadatas[i] ?? {} }));
  },

  async updateMetadata(ids, metadatas) {
    const id = await getCollectionId();
    const resp = await fetch(`${CHROMA_BASE}/${id}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, metadatas }),
    });
    if (!resp.ok) throw new Error(`chroma update failed: ${resp.status} ${await resp.text()}`);
  },
};

const apply = process.argv.includes("--apply");

const result = await backfillSourceTier(liveDeps, { dryRun: !apply });

console.log(apply ? "APPLIED" : "DRY RUN (pass --apply to write)");
console.log(`collection ${getActiveStackCollectionName()}`);
console.log(`scanned ${result.scanned} chunks, ${result.updated} need tagging`);
for (const [tier, count] of Object.entries(result.byTier).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tier.padEnd(10)} ${count}`);
}

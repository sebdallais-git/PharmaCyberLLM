// Which layer of the corpus a chunk belongs to. The index is dominated by an
// undifferentiated news back-catalogue that vendor queries must be able to
// exclude, and curated vendor briefs they should prefer -- neither is possible
// without a scalar, filterable tag on every chunk.
export const SOURCE_TIERS = ["curated", "reference", "feed", "archive"] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];

const NEWS_SOURCE = /^news-\d{4}-\d{2}-\d{2}$/;

export function isSourceTier(value: unknown): value is SourceTier {
  return typeof value === "string" && (SOURCE_TIERS as readonly string[]).includes(value);
}

/**
 * Classify one chunk from its existing metadata. Pure and idempotent: a chunk
 * that already carries a valid tier keeps it, so the backfill can be re-run.
 */
export function classifySourceTier(metadata: Record<string, unknown>): SourceTier {
  if (isSourceTier(metadata.source_tier)) return metadata.source_tier;

  // A watchlist id is the most specific fact available: the item is live vendor
  // intel even when it reached us through the news adapter.
  if (metadata.watchlist_item_id !== undefined && metadata.watchlist_item_id !== null) return "feed";

  const source = typeof metadata.source === "string" ? metadata.source : "";
  if (metadata.type === "news" || NEWS_SOURCE.test(source)) return "archive";
  if (source.startsWith("vendors/")) return "curated";

  return "reference";
}

export interface BackfillDeps {
  listChunks(): Promise<Array<{ id: string; metadata: Record<string, unknown> }>>;
  updateMetadata(ids: string[], metadatas: Record<string, unknown>[]): Promise<void>;
}

export interface BackfillResult {
  scanned: number;
  updated: number;
  byTier: Partial<Record<SourceTier, number>>;
}

// Chroma rejects oversized request bodies, and a failed half-write is harder to
// reason about than a resumable one: an interrupted backfill just leaves the
// remaining chunks untagged, and re-running finishes the job.
const UPDATE_BATCH_SIZE = 500;

/**
 * Give every chunk a scalar, filterable source_tier. Metadata-only: embeddings
 * are never recomputed. Idempotent -- already-tagged chunks are skipped, so the
 * backfill can be re-run after new content arrives.
 */
export async function backfillSourceTier(
  deps: BackfillDeps,
  options: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const chunks = await deps.listChunks();
  const byTier: Partial<Record<SourceTier, number>> = {};
  const ids: string[] = [];
  const metadatas: Record<string, unknown>[] = [];

  for (const chunk of chunks) {
    if (isSourceTier(chunk.metadata.source_tier)) continue;
    const tier = classifySourceTier(chunk.metadata);
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    ids.push(chunk.id);
    metadatas.push({ source_tier: tier });
  }

  if (!options.dryRun) {
    for (let i = 0; i < ids.length; i += UPDATE_BATCH_SIZE) {
      await deps.updateMetadata(ids.slice(i, i + UPDATE_BATCH_SIZE), metadatas.slice(i, i + UPDATE_BATCH_SIZE));
    }
  }

  return { scanned: chunks.length, updated: ids.length, byTier };
}

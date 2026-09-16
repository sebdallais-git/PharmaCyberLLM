// Turns chunks from the legacy index and ChromaDB collection back into whole raw documents

export interface LegacyChunk {
  source: string;
  content: string;
}

export interface MigrationDoc {
  key: string;
  source: string;
  content: string;
  metadata: Record<string, unknown>;
}

export function extractNewsLink(content: string): string | null {
  const match = content.match(/^URL: (\S+)$/m);
  return match ? match[1] : null;
}

export function collectLegacyDocuments(
  indexChunks: LegacyChunk[],
  chromaNewsChunks: LegacyChunk[],
  fileSources: Set<string>,
  existingSources: Set<string>
): MigrationDoc[] {
  const docs = new Map<string, MigrationDoc>();
  const textParts = new Map<string, Set<string>>();

  for (const chunk of [...indexChunks, ...chromaNewsChunks]) {
    if (chunk.source.startsWith("news-")) {
      // A news item is a single short chunk; the URL identifies the article
      const link = extractNewsLink(chunk.content);
      const key = link ?? chunk.content;
      if (!docs.has(key)) {
        docs.set(key, {
          key,
          source: chunk.source,
          content: chunk.content,
          metadata: { type: "news", ...(link ? { link } : {}), migrated: true },
        });
      }
    } else if (!fileSources.has(chunk.source) && !existingSources.has(chunk.source)) {
      // Text added through the API before raw documents existed
      const parts = textParts.get(chunk.source) ?? new Set<string>();
      parts.add(chunk.content);
      textParts.set(chunk.source, parts);
    }
  }

  // Only index chunks reach this point for text; ChromaDB input is news-only, so chunks never mix sizes
  for (const [source, parts] of textParts) {
    docs.set(source, {
      key: source,
      source,
      content: [...parts].join("\n\n"),
      metadata: { type: "text", migrated: true },
    });
  }

  return [...docs.values()];
}

// ChromaDB vector store client for RAG
// Connects to a running ChromaDB server via its REST API

import { getEmbedding } from "./ollama.js";

const CHROMADB_URL = process.env.CHROMADB_URL ?? "http://localhost:8100";
const TENANT = "default_tenant";
const DATABASE = "default_database";
const COLLECTION_NAME = "knowledge_base";

const BASE = `${CHROMADB_URL}/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections`;

interface ChromaCollection {
  id: string;
  name: string;
}

interface ChromaQueryResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  distance: number;
}

// Resolve the collection ID from its name (cached after first call)
let collectionId: string | null = null;

async function getCollectionId(): Promise<string> {
  if (collectionId) return collectionId;

  const resp = await fetch(BASE);
  if (!resp.ok) {
    throw new Error(`ChromaDB: failed to list collections (${resp.status})`);
  }

  const collections = (await resp.json()) as ChromaCollection[];
  const match = collections.find((c) => c.name === COLLECTION_NAME);

  if (!match) {
    // Create the collection if it doesn't exist
    const createResp = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: COLLECTION_NAME,
        metadata: { "hnsw:space": "cosine" },
      }),
    });
    if (!createResp.ok) {
      throw new Error(`ChromaDB: failed to create collection (${createResp.status})`);
    }
    const created = (await createResp.json()) as ChromaCollection;
    collectionId = created.id;
  } else {
    collectionId = match.id;
  }

  return collectionId;
}

// Split text into chunks of roughly ~500 tokens (≈ 2000 chars)
function chunkText(text: string, charLimit: number = 2000): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 > charLimit && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }

    // Split oversized paragraphs on sentence boundaries
    if (trimmed.length > charLimit) {
      const sentences = trimmed.split(/(?<=\.)\s+/);
      for (const sentence of sentences) {
        if (current.length + sentence.length + 1 > charLimit && current.length > 0) {
          chunks.push(current.trim());
          current = "";
        }
        current += (current ? " " : "") + sentence;
      }
    } else {
      current += (current ? "\n\n" : "") + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

// Generate a short deterministic ID from text
function makeId(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(8, "0");
}

/**
 * Query ChromaDB for the most relevant chunks.
 */
export async function searchChromaDB(
  query: string,
  topK: number = 5
): Promise<ChromaQueryResult[]> {
  const id = await getCollectionId();
  const queryEmbedding = await getEmbedding(query);

  const resp = await fetch(`${BASE}/${id}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query_embeddings: [queryEmbedding],
      n_results: topK,
      include: ["documents", "metadatas", "distances"],
    }),
  });

  if (!resp.ok) {
    throw new Error(`ChromaDB query failed (${resp.status})`);
  }

  const data = (await resp.json()) as {
    ids: string[][];
    documents: string[][];
    metadatas: Record<string, unknown>[][];
    distances: number[][];
  };

  if (!data.ids[0] || data.ids[0].length === 0) return [];

  const results: ChromaQueryResult[] = [];
  for (let i = 0; i < data.ids[0].length; i++) {
    results.push({
      id: data.ids[0][i],
      document: data.documents[0][i],
      metadata: data.metadatas[0][i],
      distance: data.distances[0][i],
    });
  }

  return results;
}

/**
 * Chunk texts, embed via Ollama, and upsert into ChromaDB.
 */
export async function addToChromaDB(
  texts: string[],
  metadatas: Record<string, unknown>[]
): Promise<number> {
  const id = await getCollectionId();

  const allIds: string[] = [];
  const allDocs: string[] = [];
  const allEmbeddings: number[][] = [];
  const allMetadatas: Record<string, unknown>[] = [];

  for (let t = 0; t < texts.length; t++) {
    const chunks = chunkText(texts[t]);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkId = makeId(chunk);
      const embedding = await getEmbedding(chunk);
      allIds.push(chunkId);
      allDocs.push(chunk);
      allEmbeddings.push(embedding);
      allMetadatas.push({
        ...metadatas[t],
        chunk_index: i,
        total_chunks: chunks.length,
        added_at: new Date().toISOString(),
      });
    }
  }

  if (allIds.length === 0) return 0;

  const resp = await fetch(`${BASE}/${id}/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ids: allIds,
      documents: allDocs,
      embeddings: allEmbeddings,
      metadatas: allMetadatas,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ChromaDB upsert failed (${resp.status}): ${body}`);
  }

  return allIds.length;
}

/**
 * Check if a source URL already has chunks in ChromaDB.
 */
export async function chromaDocumentExists(source: string): Promise<boolean> {
  const id = await getCollectionId();

  const resp = await fetch(`${BASE}/${id}/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      where: { source },
      limit: 1,
      include: [],
    }),
  });

  if (!resp.ok) return false;

  const data = (await resp.json()) as { ids: string[] };
  return data.ids.length > 0;
}

/**
 * Return stats about the ChromaDB knowledge base.
 */
export async function getChromaStatus(): Promise<{
  totalChunks: number;
  sources: string[];
  lastAdded: string | null;
}> {
  const id = await getCollectionId();

  // Get count
  const countResp = await fetch(`${BASE}/${id}/count`, { method: "GET" });
  const totalChunks = countResp.ok ? ((await countResp.json()) as number) : 0;

  // Get all metadatas to extract sources and timestamps
  let sources: string[] = [];
  let lastAdded: string | null = null;

  if (totalChunks > 0) {
    const getResp = await fetch(`${BASE}/${id}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include: ["metadatas"] }),
    });

    if (getResp.ok) {
      const data = (await getResp.json()) as { metadatas: Record<string, unknown>[] };
      const sourceSet = new Set<string>();

      for (const meta of data.metadatas) {
        if (typeof meta.source === "string") sourceSet.add(meta.source);
        if (typeof meta.added_at === "string") {
          if (!lastAdded || meta.added_at > lastAdded) {
            lastAdded = meta.added_at;
          }
        }
      }
      sources = [...sourceSet].sort();
    }
  }

  return { totalChunks, sources, lastAdded };
}

/**
 * Check if the ChromaDB server is reachable.
 */
export async function isChromaDBAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${CHROMADB_URL}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Delete the collection and reset the cached ID.
 */
export async function deleteChromaCollection(): Promise<void> {
  const id = await getCollectionId().catch(() => null);
  if (!id) return;

  const resp = await fetch(`${BASE}/${id}`, { method: "DELETE" });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`ChromaDB: failed to delete collection (${resp.status})`);
  }
  collectionId = null;
}

/**
 * Delete and recreate the collection (empty).
 */
export async function recreateChromaCollection(): Promise<void> {
  await deleteChromaCollection();
  // Force re-creation
  collectionId = null;
  await getCollectionId();
}

export type { ChromaQueryResult };

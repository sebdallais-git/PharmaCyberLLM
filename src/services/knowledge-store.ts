// Knowledge store with vector embeddings for semantic search (RAG)

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getEmbedding } from "./ollama.js";
import { parseFile, isSupportedFile } from "./file-parser.js";

interface KnowledgeChunk {
  id: string;
  source: string;
  content: string;
  embedding: number[];
}

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");
const INDEX_PATH = join(KNOWLEDGE_DIR, ".index.json");

let chunks: KnowledgeChunk[] = [];

// Split text into reasonably sized chunks
function chunkText(text: string, maxChunkSize: number = 800): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const result: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length > maxChunkSize && current.length > 0) {
      result.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + trimmed;
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

// Cosine similarity between two vectors
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// Keyword match score: fraction of query words found in content
function keywordScore(query: string, content: string): number {
  const contentLower = content.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;
  const matches = words.filter((w) => contentLower.includes(w)).length;
  return matches / words.length;
}

// Hybrid search: vector similarity + keyword boost
export async function searchKnowledge(query: string, topK: number = 5): Promise<KnowledgeChunk[]> {
  if (chunks.length === 0) return [];

  const queryEmbedding = await getEmbedding(query);

  const scored = chunks
    .map((chunk) => {
      const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      const kwScore = keywordScore(query, chunk.content);
      // Hybrid: 70% vector + 30% keyword
      const combined = vectorScore * 0.7 + kwScore * 0.3;
      return { chunk, score: combined };
    })
    .filter((item) => item.score > 0.2)
    .sort((a, b) => b.score - a.score);

  // Deduplicate by content prefix
  const seen = new Set<string>();
  const results: KnowledgeChunk[] = [];
  for (const item of scored) {
    const key = item.chunk.content.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item.chunk);
    if (results.length >= topK) break;
  }

  return results;
}

// Ingest a file (any supported format) into the knowledge base
export async function ingestFile(filePath: string, sourceName: string): Promise<number> {
  const content = await parseFile(filePath);
  return ingestText(content, sourceName);
}

// Ingest raw text into the knowledge base
export async function ingestText(text: string, sourceName: string): Promise<number> {
  const textChunks = chunkText(text);
  let added = 0;

  for (const content of textChunks) {
    const id = `${sourceName}-${chunks.length}`;
    const embedding = await getEmbedding(content);
    chunks.push({
      id,
      source: sourceName,
      content,
      embedding,
    });
    added++;
  }

  return added;
}

// Save the index to disk
export async function saveIndex(): Promise<void> {
  await mkdir(KNOWLEDGE_DIR, { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify(chunks, null, 2), "utf-8");
}

// Load the index from disk
export async function loadIndex(): Promise<void> {
  try {
    const data = await readFile(INDEX_PATH, "utf-8");
    chunks = JSON.parse(data) as KnowledgeChunk[];
    console.log(`Index loaded: ${chunks.length} chunks`);
  } catch {
    chunks = [];
    console.log("No existing index, starting empty");
  }
}

// Ingest all .txt and .md files from the knowledge/ directory
export async function ingestKnowledgeDir(): Promise<number> {
  await mkdir(KNOWLEDGE_DIR, { recursive: true });
  let total = 0;

  const indexedSources = new Set(chunks.map((c) => c.source));

  try {
    const files = await readdir(KNOWLEDGE_DIR);
    for (const file of files) {
      if (file.startsWith(".")) continue;
      if (!isSupportedFile(file)) continue;
      if (indexedSources.has(file)) {
        console.log(`  Skipped: ${file} (already indexed)`);
        continue;
      }

      const filePath = join(KNOWLEDGE_DIR, file);
      const added = await ingestFile(filePath, file);
      total += added;
      console.log(`  Ingested: ${file} (${added} chunks)`);
    }
  } catch {
    console.log("knowledge/ directory empty or inaccessible");
  }

  return total;
}

// Return knowledge base stats
export function getStats(): { totalChunks: number; sources: string[] } {
  const sources = [...new Set(chunks.map((c) => c.source))];
  return { totalChunks: chunks.length, sources };
}

export type { KnowledgeChunk };

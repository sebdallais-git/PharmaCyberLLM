// In-memory cache for response metadata with 1-hour TTL

import { randomUUID } from "node:crypto";

interface ResponseMeta {
  responseId: string;
  query: string;
  response: string;
  chunkIds: string[];
  hadRagContext: boolean;
  model: string;
  createdAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map<string, ResponseMeta>();

// Cleanup expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.createdAt > TTL_MS) {
      cache.delete(key);
    }
  }
}, 10 * 60 * 1000);

export function createResponseEntry(
  query: string,
  response: string,
  chunkIds: string[],
  hadRagContext: boolean,
  model: string
): string {
  const responseId = randomUUID();
  cache.set(responseId, {
    responseId,
    query,
    response,
    chunkIds,
    hadRagContext,
    model,
    createdAt: Date.now(),
  });
  return responseId;
}

export function getResponseEntry(responseId: string): ResponseMeta | undefined {
  const entry = cache.get(responseId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > TTL_MS) {
    cache.delete(responseId);
    return undefined;
  }
  return entry;
}

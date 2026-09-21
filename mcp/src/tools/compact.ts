// Shrinks PharmaITChat payloads before they reach an agent's context: embeddings, full source lists and
// stored model answers cost thousands of tokens per call and tell the agent nothing it can act on.

const SOURCE_SAMPLE = 20;
const TOPIC_SAMPLE = 20;
const ANSWER_CHARS = 300;

export interface ListSample {
  count: number;
  sample: unknown[];
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncate(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}… (${value.length} chars)`;
}

export function sampleList(value: unknown, limit: number): ListSample | undefined {
  if (!Array.isArray(value)) return undefined;
  return { count: value.length, sample: value.slice(0, limit), truncated: value.length > limit };
}

// Each chunk carries a ~30 KB embedding the agent cannot use; the text is the point
export function compactSearchResults(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return payload;
  const results = payload.results.map((entry) => {
    if (!isRecord(entry)) return entry;
    const { embedding: _embedding, ...rest } = entry;
    return rest;
  });
  return { ...payload, results };
}

export function compactGap(gap: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    id: gap.id,
    timestamp: gap.timestamp,
    original_query: gap.original_query,
    search_topic: gap.search_topic,
    reason: gap.reason,
    status: gap.status,
    retry_count: gap.retry_count,
    resolved_at: gap.resolved_at,
  };
  const resolved = truncate(gap.resolved_response, ANSWER_CHARS);
  if (resolved !== undefined) compact.resolved_response = resolved;
  return compact;
}

// `sources` lists every source name (1000+ on this knowledge base): keep the count and a sample
export function compactKnowledgeStats(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const sources = sampleList(payload.sources, SOURCE_SAMPLE);
  if (!sources) return payload;
  return { ...payload, sources };
}

// `topics` lists all ~190 scrape topics on every status call
export function compactAgentStatus(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const topics = sampleList(payload.topics, TOPIC_SAMPLE);
  if (!topics) return payload;
  return { ...payload, topics };
}

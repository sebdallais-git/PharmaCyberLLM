// Guards against searching an index that was built by another stack or embedding model

import type { StackConfig } from "../config/llm-stacks.js";

export interface IndexMeta {
  stack: string;
  embeddingModel: string;
  dim: number;
}

export interface IndexCheck {
  ok: boolean;
  reason: string;
}

const REINDEX_HINT = "run scripts/reindex-stack.ts";

export function expectedIndexMeta(stack: StackConfig): IndexMeta {
  return { stack: stack.name, embeddingModel: stack.embeddingModel, dim: stack.embeddingDim };
}

export function checkIndexMeta(
  expected: IndexMeta,
  actual: IndexMeta | null,
  probeDim: number | null,
  label: string
): IndexCheck {
  if (probeDim !== null && probeDim !== expected.dim) {
    return { ok: false, reason: `${label}: embedding server returned ${probeDim} dimensions, expected ${expected.dim}` };
  }
  if (actual === null) {
    return { ok: false, reason: `${label}: index has no stack metadata — ${REINDEX_HINT}` };
  }

  const mismatches: string[] = [];
  if (actual.stack !== expected.stack) mismatches.push(`stack ${actual.stack} ≠ ${expected.stack}`);
  if (actual.embeddingModel !== expected.embeddingModel) {
    mismatches.push(`embedding model ${actual.embeddingModel} ≠ ${expected.embeddingModel}`);
  }
  if (actual.dim !== expected.dim) mismatches.push(`dim ${actual.dim} ≠ ${expected.dim}`);

  if (mismatches.length > 0) {
    return { ok: false, reason: `${label}: ${mismatches.join(", ")} — ${REINDEX_HINT}` };
  }
  return { ok: true, reason: "" };
}

export function indexMetaFromChroma(metadata: Record<string, unknown> | null | undefined): IndexMeta | null {
  if (!metadata) return null;
  const { stack, embedding_model: embeddingModel, dim } = metadata;
  if (typeof stack !== "string" || typeof embeddingModel !== "string" || typeof dim !== "number") return null;
  return { stack, embeddingModel, dim };
}

export function indexMetaToChroma(meta: IndexMeta): Record<string, string | number> {
  return { stack: meta.stack, embedding_model: meta.embeddingModel, dim: meta.dim };
}

// Runtime status, set at startup and after a reindex. Searches are refused until it is ok.
let status: IndexCheck = { ok: false, reason: "search index not verified yet" };

export function setIndexStatus(check: IndexCheck): void {
  status = check;
}

export function getIndexStatus(): IndexCheck {
  return status;
}

export function assertIndexUsable(): void {
  if (!status.ok) throw new Error(`Search refused: ${status.reason}`);
}

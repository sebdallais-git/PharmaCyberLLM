// Rebuilds the active stack's in-memory index and ChromaDB collection from knowledge/ and data/raw_documents/

import { getActiveStack } from "../config/llm-stacks.js";
import { checkIndexMeta, expectedIndexMeta, setIndexStatus } from "./index-guard.js";
import type { IndexCheck } from "./index-guard.js";
import { StackUnavailableError } from "./llm-client.js";
import {
  ingestTexts,
  listKnowledgeFiles,
  markIndexComplete,
  readIndexSummary,
  resetIndex,
  saveIndex,
} from "./knowledge-store.js";
import type { KnowledgeFile, TextItem } from "./knowledge-store.js";
import {
  addToChromaDB,
  getChromaCollectionInfo,
  isChromaDBAvailable,
  markChromaCollectionComplete,
  recreateChromaCollection,
} from "./chromadb-store.js";
import { listRawDocuments } from "./raw-documents.js";
import type { RawDocument } from "./raw-documents.js";
import { parseFile } from "./file-parser.js";
import { toBatches } from "../utils/batches.js";

const RAW_DOCUMENT_BATCH_SIZE = 64;

export interface ReindexResult {
  stack: string;
  // Items actually ingested: failed files and skipped raw-document batches are not counted
  knowledgeFiles: number;
  rawDocuments: number;
  memoryChunks: number;
  chromaChunks: number;
  skippedRawDocuments: number;
  seconds: number;
}

// 1-based inclusive range label for a raw-document batch, e.g. "65-128"
export function batchRangeLabel(batchIndex: number, batchSize: number, total: number): string {
  const start = batchIndex * batchSize + 1;
  const end = Math.min((batchIndex + 1) * batchSize, total);
  return `${start}-${end}`;
}

export interface IndexState {
  memory: { check: IndexCheck; chunkCount: number; complete: boolean };
  chroma: { check: IndexCheck; count: number; complete: boolean };
}

// Everything a rebuild reads or writes, injectable so failure handling can be tested without services
export interface ReindexDeps {
  isChromaDBAvailable: () => Promise<boolean>;
  resetIndex: () => void;
  recreateChromaCollection: () => Promise<void>;
  listKnowledgeFiles: () => Promise<KnowledgeFile[]>;
  parseFile: (path: string) => Promise<string>;
  ingestTexts: (items: TextItem[]) => Promise<number>;
  addToChromaDB: (texts: string[], metadatas: Record<string, unknown>[]) => Promise<number>;
  listRawDocuments: () => Promise<RawDocument[]>;
  markIndexComplete: () => void;
  saveIndex: () => Promise<void>;
  markChromaCollectionComplete: () => Promise<void>;
}

const defaultDeps: ReindexDeps = {
  isChromaDBAvailable,
  resetIndex,
  recreateChromaCollection,
  listKnowledgeFiles,
  parseFile,
  ingestTexts,
  addToChromaDB,
  listRawDocuments: () => listRawDocuments(),
  markIndexComplete,
  saveIndex,
  markChromaCollectionComplete,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function inspectIndexes(): Promise<IndexState> {
  const expected = expectedIndexMeta(getActiveStack());

  const summary = await readIndexSummary();
  const memory = summary === null
    ? { check: { ok: false, reason: "in-memory index file missing" }, chunkCount: 0, complete: false }
    : {
        check: checkIndexMeta(expected, summary.meta, null, "in-memory index"),
        chunkCount: summary.chunkCount,
        complete: summary.complete,
      };

  const info = await getChromaCollectionInfo();
  const chroma = info === null
    ? { check: { ok: false, reason: "ChromaDB collection missing" }, count: 0, complete: false }
    : { check: checkIndexMeta(expected, info.meta, null, "ChromaDB collection"), count: info.count, complete: info.complete };

  return { memory, chroma };
}

// Ready only if both indexes match the stack, have content, and carry the marker of a rebuild that ran to the end
export function indexesReady(state: IndexState): boolean {
  return state.memory.check.ok
    && state.memory.chunkCount > 0
    && state.memory.complete
    && state.chroma.check.ok
    && state.chroma.count > 0
    && state.chroma.complete;
}

export async function reindexActiveStack(
  log: (message: string) => void = console.log,
  deps: ReindexDeps = defaultDeps
): Promise<ReindexResult> {
  const startedAt = Date.now();
  const stack = getActiveStack();

  if (!(await deps.isChromaDBAvailable())) {
    throw new Error("ChromaDB is not reachable — start it before reindexing");
  }

  let memoryChunks = 0;
  let chromaChunks = 0;
  let knowledgeFiles = 0;
  let rawDocuments = 0;
  let skippedRawDocuments = 0;

  try {
    log(`[Reindex] ${stack.name}: rebuilding ${stack.indexFile} and ${stack.chromaCollection}`);
    deps.resetIndex();
    await deps.recreateChromaCollection();

    for (const file of await deps.listKnowledgeFiles()) {
      try {
        const text = await deps.parseFile(file.path);
        memoryChunks += await deps.ingestTexts([{ text, source: file.name }]);
        chromaChunks += await deps.addToChromaDB([text], [{ source: file.name }]);
        knowledgeFiles++;
        log(`[Reindex] file ${file.name}`);
      } catch (err) {
        // A stack outage would fail every remaining item, so abort instead of skipping
        if (err instanceof StackUnavailableError) throw err;
        log(`[Reindex] skipped ${file.name}: ${errorMessage(err)}`);
      }
    }

    const docs = await deps.listRawDocuments();
    let processed = 0;
    const batches = toBatches(docs, RAW_DOCUMENT_BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        // If the in-memory ingest succeeds but ChromaDB fails, the batch stays in the in-memory
        // index and is only missing from ChromaDB; it is still reported as skipped, not rolled back.
        memoryChunks += await deps.ingestTexts(batch.map((doc) => ({ text: doc.content, source: doc.source })));
        chromaChunks += await deps.addToChromaDB(
          batch.map((doc) => doc.content),
          batch.map((doc) => ({ source: doc.source, ...doc.metadata }))
        );
        processed += batch.length;
        rawDocuments += batch.length;
        log(`[Reindex] raw documents ${processed}/${docs.length}`);
      } catch (err) {
        if (err instanceof StackUnavailableError) throw err;
        skippedRawDocuments += batch.length;
        const range = batchRangeLabel(i, RAW_DOCUMENT_BATCH_SIZE, docs.length);
        log(`[Reindex] skipped raw documents ${range}: ${errorMessage(err)}`);
      }
    }

    // The rebuild ran to the end (isolated skips are reported, not fatal): stamp both completeness markers
    deps.markIndexComplete();
    await deps.saveIndex();
    await deps.markChromaCollectionComplete();
    setIndexStatus({ ok: true, reason: "" });
  } catch (err) {
    setIndexStatus({ ok: false, reason: `reindex failed: ${errorMessage(err)} — run scripts/reindex-stack.ts` });
    throw err;
  }

  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  log(
    `[Reindex] done: ${memoryChunks} in-memory chunks, ${chromaChunks} ChromaDB chunks in ${seconds}s, ` +
    `${skippedRawDocuments} raw documents skipped`
  );

  return {
    stack: stack.name,
    knowledgeFiles,
    rawDocuments,
    memoryChunks,
    chromaChunks,
    skippedRawDocuments,
    seconds,
  };
}

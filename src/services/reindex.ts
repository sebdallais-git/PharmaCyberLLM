// Rebuilds the active stack's in-memory index and ChromaDB collection from knowledge/ and data/raw_documents/

import { getActiveStack } from "../config/llm-stacks.js";
import { checkIndexMeta, expectedIndexMeta, setIndexStatus } from "./index-guard.js";
import type { IndexCheck } from "./index-guard.js";
import { ingestTexts, listKnowledgeFiles, readIndexSummary, resetIndex, saveIndex } from "./knowledge-store.js";
import {
  addToChromaDB,
  getChromaCollectionInfo,
  isChromaDBAvailable,
  recreateChromaCollection,
} from "./chromadb-store.js";
import { listRawDocuments } from "./raw-documents.js";
import { parseFile } from "./file-parser.js";
import { toBatches } from "../utils/batches.js";

const RAW_DOCUMENT_BATCH_SIZE = 64;

export interface ReindexResult {
  stack: string;
  knowledgeFiles: number;
  rawDocuments: number;
  memoryChunks: number;
  chromaChunks: number;
  seconds: number;
}

export interface IndexState {
  memory: { check: IndexCheck; chunkCount: number };
  chroma: { check: IndexCheck; count: number };
}

export async function inspectIndexes(): Promise<IndexState> {
  const expected = expectedIndexMeta(getActiveStack());

  const summary = await readIndexSummary();
  const memory = summary === null
    ? { check: { ok: false, reason: "in-memory index file missing" }, chunkCount: 0 }
    : { check: checkIndexMeta(expected, summary.meta, null, "in-memory index"), chunkCount: summary.chunkCount };

  const info = await getChromaCollectionInfo();
  const chroma = info === null
    ? { check: { ok: false, reason: "ChromaDB collection missing" }, count: 0 }
    : { check: checkIndexMeta(expected, info.meta, null, "ChromaDB collection"), count: info.count };

  return { memory, chroma };
}

export function indexesReady(state: IndexState): boolean {
  return state.memory.check.ok
    && state.memory.chunkCount > 0
    && state.chroma.check.ok
    && state.chroma.count > 0;
}

export async function reindexActiveStack(log: (message: string) => void = console.log): Promise<ReindexResult> {
  const startedAt = Date.now();
  const stack = getActiveStack();

  if (!(await isChromaDBAvailable())) {
    throw new Error("ChromaDB is not reachable — start it before reindexing");
  }

  log(`[Reindex] ${stack.name}: rebuilding ${stack.indexFile} and ${stack.chromaCollection}`);
  resetIndex();
  await recreateChromaCollection();

  let memoryChunks = 0;
  let chromaChunks = 0;

  const files = await listKnowledgeFiles();
  for (const file of files) {
    try {
      const text = await parseFile(file.path);
      memoryChunks += await ingestTexts([{ text, source: file.name }]);
      chromaChunks += await addToChromaDB([text], [{ source: file.name }]);
      log(`[Reindex] file ${file.name}`);
    } catch (err) {
      log(`[Reindex] skipped ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const docs = await listRawDocuments();
  let processed = 0;
  for (const batch of toBatches(docs, RAW_DOCUMENT_BATCH_SIZE)) {
    memoryChunks += await ingestTexts(batch.map((doc) => ({ text: doc.content, source: doc.source })));
    chromaChunks += await addToChromaDB(
      batch.map((doc) => doc.content),
      batch.map((doc) => ({ source: doc.source, ...doc.metadata }))
    );
    processed += batch.length;
    log(`[Reindex] raw documents ${processed}/${docs.length}`);
  }

  await saveIndex();
  setIndexStatus({ ok: true, reason: "" });

  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  log(`[Reindex] done: ${memoryChunks} in-memory chunks, ${chromaChunks} ChromaDB chunks in ${seconds}s`);

  return {
    stack: stack.name,
    knowledgeFiles: files.length,
    rawDocuments: docs.length,
    memoryChunks,
    chromaChunks,
    seconds,
  };
}
